# Risks and Mitigations

Each risk: name, where it bites, mitigation, detection signal.

All line refs are into `src/`.

---

## R1. Circular dependencies introduced by class constructors

### Where it bites

The class refactor moves module-level singletons onto `App` constructor
parameters (per D3 in `03-class-boundaries.md`). The natural seam is
constructor DI: `new App({config, db, logger, ...})`. But several
class pairs have mutual dependencies:

- `MemoryStore` ← `MemoryCache` (G2): `MemoryStore` needs the cache,
  the cache needs nothing from `MemoryStore`. Single direction. Safe.
- `SettingsStore` ← `SettingsRegistry`: same, single direction. Safe.
- `DashboardServer` ← `RouteContext` ← `DashboardServer`: `RouteContext`
  carries references back into the server (the auth kind, the
  request-scoped state). The seam is per-request, not per-instance,
  so a circular type is fine — but the per-request factory must not
  close over the server's mutable state.
- `App` ← every other class, every other class → `App`: the
  orchestrator holds them all. Single direction (App is the
  consumer). Safe.
- `MessageBus` ← `Scheduler` ← `BackgroundTaskPool` ← `MessageBus`:
  the message bus logs to the scheduler for retry-classified
  failures, the scheduler uses the background task pool for
  retry execution, the background task pool emits messages on
  completion. **This is a real cycle** and breaks naive constructor
  DI.

### Mitigation

1. Introduce a `Services` aggregate (`type Services = { memoryStore,
   kanbanCards, ..., logger }`) constructed once at boot and passed
   by reference to every class. Constructor types stay single-
   direction (`new X(services)`).
2. For the `MessageBus` ↔ `Scheduler` ↔ `BackgroundTaskPool` cycle,
   use a late-binding setter (`setRetryQueue(q: RetryQueue)`)
   injected after construction; the alternative is a single
   `TaskLifecycle` class that owns all three.
3. The `web/` runners do not need back-references to `App` — they
   receive only their store dependencies via the constructor. The
   shutdown sequence is orchestrated by `App.shutdown()`, not by
   inter-runner calls.

### Detection signal

- `bun tsc --noEmit` produces a `TS2456: Type 'X' circularly
  references itself` error during the build.
- A test that constructs two classes in isolation throws
  `TypeError: Cannot read properties of undefined (reading '...')`
  because a back-reference is missing.

---

## R2. Breaking public API for internal consumers (other packages,
CLI scripts, integration tests)

### Where it bites

- `src/index.ts` is the entry point for the CLI scripts in `bin/`
  (per `01-module-state-analysis.md` Section 1, the orchestrator is
  the boot path). Converting `main()` to `App.start()` changes the
  function signature.
- `src/config.ts` ~40 frozen `const` exports are read by ~23 modules
  (`notify.ts`, `heartbeat.ts`, `memory.ts`, `db.ts`, `web.ts`,
  `index.ts`, `store-watcher.ts`, `settings-store.ts`, `env.ts`,
  `remote-enroll-fs.ts`, `agent.ts`, `remote-enroll-core.ts`,
  `costops/config.ts`, `costops/ledger.ts`, and more per Section 3.3
  of the module analysis). Each `import {WEB_PORT} from './config.js'`
  breaks.
- `src/db.ts` ~200 free functions are read by ~30 modules. Each
  `import {listKanbanCards} from './db.js'` breaks.
- `src/logger.ts` `export const logger = pino(...)` is read by ~25
  modules (per Section 7 of the module analysis, the most-mocked
  module).

### Mitigation

1. **Legacy thin wrappers.** Every converted class keeps its
   free-function surface as a thin wrapper that delegates to a
   singleton instance:
   ```ts
   // db.ts (post-conversion)
   let _defaultClient: DbClient | null = null
   export function getDb(): Database { return _defaultClient.raw() }
   export function listKanbanCards(filter: KanbanFilter): KanbanCard[] {
     return _defaultClient.getStore('kanbanCards').list(filter)
   }
   ```
   This keeps the existing imports working until every consumer is
   migrated to constructor injection.
2. **Deprecation comments.** Each legacy wrapper carries a
   `@deprecated` JSDoc tag pointing to the class API. Removal is
   gated on a separate cleanup commit after all consumers migrate.
3. **Per-phase removal.** Legacy wrappers are removed one phase
   at a time (Phase 7's per-sub-phase commits).

### Detection signal

- `bun tsc --noEmit` reports `TS2305: Module '"X"' has no exported
  member 'Y'` — the wrapper is missing.
- An integration test that imports a deleted free function fails
  with `SyntaxError: The requested module does not provide an
  export named 'Y'`.

---

## R3. Test mocks that depend on module state (`vi.mock` pattern
conflicts)

### Where it bites

Per `01-module-state-analysis.md` Section 7, the top mock targets
are:

- `../logger.js` (78 hits) — singleton replacement via `vi.mock`
- `../config.js` (126 hits across three patterns) — module export
  replacement
- `../db.js` (35 hits) — `initDatabase(':memory:')` per-test
  isolation
- `../web/agent-config.js` (51 hits) — factory function replacement
- `../platform.js` (12 hits) — `PLATFORM` singleton replacement
- `../store-watcher.js` and `../settings-store.js` — module-level
  state replacement

When a module becomes a class, the `vi.mock('../module.js', () =>
({ foo: vi.fn() }))` pattern breaks because the class is not yet
instantiated. The test gets `vi.fn()` as `foo`, not the actual
implementation, and the constructor call fails because the mock
returns a plain object instead of a class instance.

Concrete example: `vi.mock('../db.js', () => ({ initDatabase: vi.fn()
}))` works today because `initDatabase` is a free function. After
`db.ts` becomes a class-based `DbClient`, the test must either
(a) construct a real `DbClient(':memory:')` in a `beforeEach`, or
(b) mock the class itself via `vi.mock('../db.js', () => ({ DbClient:
vi.fn() }))` — but then every consumer that does `import {DbClient}
from './db.js'` and calls `new DbClient(...)` gets the mock back.

### Mitigation

1. **Mock the module, not the class.** For class exports, the
   `vi.mock` pattern becomes:
   ```ts
   vi.mock('../db.js', () => {
     const DbClient = vi.fn().mockImplementation((opts) => ({
       raw: () => fakeDatabase,
       getStore: vi.fn(),
       close: vi.fn(),
     }))
     return { DbClient }
   })
   ```
   The mock returns a constructor that produces a fake instance.
2. **Per-test instantiation.** Tests that need isolated state
   construct a real instance with `:memory:`:
   ```ts
   beforeEach(() => {
     const db = new DbClient({ filename: ':memory:' })
     // seed db, pass to SUT
   })
   ```
3. **Surgical test updates.** The legacy free-function wrappers
   from R2 mean most existing `vi.mock('../db.js', () => ({...}))`
   tests keep working unchanged. The updates only land for tests
   that opt into the class API.

### Detection signal

- A test fails with `TypeError: ... is not a constructor` — the
  mock returned a plain object instead of a class.
- A test passes its `vi.mock` assertion but the SUT's behavior is
  wrong (e.g., `MemoryStore.search` returns `undefined` instead of
  `[]`) — the mock's `getStore` returned the wrong shape.

---

## R4. Module-level singletons that become test order dependencies

### Where it bites

Today, the module-level singletons (`db`, `logger`, `config`,
`cache`, `watcher`) are evaluated once at import time. A test that
imports `db.ts` early and another that imports it later share the
same `let db` binding (ESM cache). After the class refactor, each
test that constructs its own `DbClient(':memory:')` gets a fresh
instance — which is the goal — but tests that still rely on the
singleton wrapper (per R2) inherit a test-order dependency.

Specific hazards:

- `db.ts:cache = next` reassignment in `settings-store.ts:103` (the
  only mutation of the registry's record) was order-independent
  before; after the refactor, `SettingsStore.setOverride` mutates
  the per-instance cache, so a test that constructs two
  `SettingsStore` instances sees two caches — the test order no
  longer matters, but the test that assumed "the second `set`
  replaces the first" now needs explicit teardown.
- `store-watcher.ts:currentWriteActor` slot — used by route handlers
  in `web/routes/*` to set / clear the actor that the watcher
  callback reads. Two tests constructing two `StoreWatcher`
  instances with different `onChange` callbacks is fine; a test that
  relies on the singleton-watcher callback firing across two test
  files breaks.

### Mitigation

1. **Explicit per-test construction.** Every test that touches a
   converted module constructs its own instance in `beforeEach` and
   disposes in `afterEach`. The legacy singleton wrapper is
   forbidden in new tests (lint rule or PR review checklist).
2. **`vi.resetModules()` is no longer needed.** Tests that today use
   `vi.resetModules()` to force a fresh `db` should switch to
   `new DbClient(...)` in `beforeEach`.
3. **`__test_handleWatchEvent` and `reloadOverridesForTest`
   escape hatches** (currently exported from `settings-store.ts`)
   become methods on the `SettingsStore` instance; tests construct
   an instance and call the method directly, no module reset needed.

### Detection signal

- A test passes in isolation but fails when run after another test
  in the same file (or in a different file but the same vitest
  worker). The vitest output shows the failing test as "leaked
  state from previous test".
- A test that calls `getMemoryCacheSize` sees a non-zero count from
  a previous test's data — the cache is the singleton, not the
  per-test instance.

---

## R5. Generic variance pitfalls (covariant T in mutable position)

### Where it bites

Per `04-generic-interfaces.md`:

- `G1`: `BasePaneWatcher<TState, TThresholds>` — `TState` is in both
  input (`prev: TState`) and output (`next: TState`) positions.
  Marking `TState` covariant (`out TState`) would compile but
  produce a runtime type confusion when a subclass with a narrower
  `TState` is passed where a wider one is expected.
- `G2`: `TtlCache<K, V>` — `K` is used as a map key, `V` is in both
  input and output. Both invariant.
- `G3`: `RetryQueue<TRow>` — `TRow` is in input
  (`shouldAlert(row)`) and the `markAlerted` return is the same
  type. Invariant.
- `G6`: `BaseRunner<TFacts, TDecision>` — `TFacts` is input,
  `TDecision` is output. The default invariant annotation is safe;
  marking either covariant or contravariant requires
  `strictFunctionTypes` mode and an explicit `in` / `out`
  annotation.

### Mitigation

1. **Conservative invariance.** Default to invariant for every
   type parameter unless a position-by-position audit proves
   otherwise. The compiler's default is invariant for class type
   parameters, so this is the path of least resistance.
2. **No `as` casts at the boundary.** If a consumer needs `as` to
   cast between `TState` values, the generic is too wide — narrow
   the constraint or split the class.
3. **Subclass `NO_STATE` is a literal value, not a type.** The
   `abstract readonly NO_STATE: TState` field is read at
   initialization; a subclass with a different literal value is a
   compile-time error if `TState` is invariant.

### Detection signal

- `bun tsc --noEmit` reports a variance error under
  `strictFunctionTypes: true`.
- A test that constructs two `PaneWatcher` subclasses with
  different `TState` shapes and assigns one to the other compiles
  but fails at runtime with an unexpected shape.

---

## R6. Error stack traces crossing class boundaries (debug ergonomics)

### Where it bites

The current free-function error stack traces show the function
name and the call site directly:

```
Error: connection refused
    at PortLockAcquirer.acquire (src/process-lock.ts:182:11)  -- formerly acquirePortLock at process-lock.ts:169 (deleted in E.5a)
    at startWebServer (src/web.ts:88:5)
    at main (src/index.ts:142:3)
```

After the refactor, class methods add a layer of `this`:

```
Error: connection refused
    at PortLockAcquirer.acquire (src/process-lock.ts:175:11)
    at new PortLockAcquirer (... )
    at App.acquireLock (src/index.ts:210:5)
    at App.start (src/index.ts:185:3)
```

The stack is still readable, but the constructor frames (`new
PortLockAcquirer`) appear in every error. For deep call chains
(`App → DashboardServer → RouteContext → RouteHandler →
MemoryStore → Database`), the stack can grow by 3–5 frames per class
layer.

Specific concerns:

- `Error.cause` chains (when one class wraps another class's error)
  double the stack height.
- Pino log output that captures `err.stack` gets longer; structured
  log fields can overflow the per-line size limit.
- Test assertion stacks (when an expectation inside a class method
  fails) point to the method, not the test, making the failure less
  obvious.

### Mitigation

1. **Preserve `Error.captureStackTrace` if used.** The two existing
   classes (`DeferToPeerError`, `RemoteEnrollError`) follow the
   standard `extends Error` pattern; new error classes follow the
   same convention.
2. **Don't double-wrap.** If `MemoryStore.search` catches a
   `Database` error and re-throws, the new error should preserve
   the original via `new MemoryStoreError(cause)` not via a wrapper
   that hides the original stack.
3. **Source maps in production.** The bun runtime supports source
   maps for TypeScript; ensure `tsconfig.json` has
   `"sourceMap": true` and the build emits them. Without source
   maps, a stack trace in production points to compiled JS, not
   the TS source.
4. **Structured error fields.** New error classes carry structured
   fields (`class MemoryStoreError extends Error { constructor(
   public readonly query: string, public readonly cause: unknown)
   { super(`MemoryStore query failed: ${query}`) } }`) so logs can
   filter by query without parsing the message.

### Detection signal

- Production logs show truncated stacks (the pino `err.stack` field
  hits the per-line size limit and gets cut off).
- A test failure's stack trace points to a class method instead of
  the test, and the developer can't find the failing assertion.

---

## R7. Webhook / route handler lifecycle (request-scoped state vs.
class instance state)

### Where it bites

The current `web.ts` handler closure captures `DASHBOARD_TOKEN`
and `allowedOrigins` at startup. Per-request state (the parsed
body, the auth result, the request id) is local to each request.

After the refactor, `DashboardServer` (B6) holds the token +
origins as instance state, and the per-request state lives on
`RouteContext`. Two concerns:

1. **Async re-entrancy.** If a route handler is `async` and
   awaits a sub-request, the `RouteContext` must not be reused
   across the two requests. Today's closure handles this naturally
   because the handler is a fresh function call. The class-based
   version must explicitly pass `RouteContext` through every
   `await`.
2. **Handler hot-reload.** The current shape supports adding a
   route handler at runtime by mutating the closure. The class
   version's `registerRoute` method makes this explicit, but the
   ordering (route registration before `start()`) must be enforced.

### Mitigation

1. **`RouteContext` is created per request, not per instance.** The
   `DashboardServer.handle(req, res)` factory creates a fresh
   `RouteContext` per request and passes it to the handler.
2. **`registerRoute` is one-shot.** Routes are registered in the
   constructor or before `start()`; `registerRoute` after `start()`
   throws.
3. **No `this` capture in handlers.** Route handlers take
   `RouteContext` as their first argument; no closure over `this`.

### Detection signal

- A test that issues two requests in parallel and shares a
  `RouteContext` between them sees cross-contamination of state.
- A route handler's `await` chain silently loses the auth context,
  and the next handler in the chain fails with "no auth".

---

## R8. Test coverage gaps during the legacy wrapper period

### Where it bites

Per R2, every converted class keeps its free-function surface as a
thin wrapper. During the migration (potentially many weeks), the
test suite covers the legacy wrapper, not the class. Bugs in the
class API surface only when a new consumer adopts the class.

### Mitigation

1. **Class API tests run alongside legacy tests.** Every converted
   class has its own test file that exercises the class API
   directly, in parallel with the legacy wrapper tests.
2. **Coverage gate on the new classes.** The CI coverage threshold
   for the class files is the same as for the legacy free functions
   (the per-file coverage number from Phase 0's baseline).
3. **Removal PR is its own commit.** The legacy wrappers are
   removed in a single PR after every consumer migrates; the PR's
   diff is the only place where a bug from the wrapper-to-class
   transition can hide.

### Detection signal

- The class test file passes but the legacy wrapper test file
  fails (or vice versa). Indicates the wrapper is no longer a
  literal delegate to the class.
- Coverage drops on a converted module during the migration
  window — indicates a code path was lost in the wrapper.

---

## R9. Order-dependent shutdown sequence (`App.shutdown()`)

### Where it bites

Per `01-module-state-analysis.md` Section 8, the shutdown sequence
is order-sensitive:

1. digest timer (in `memory.ts`)
2. decay interval (in `index.ts`)
3. heartbeat scheduler
4. store watcher
5. settings store
6. runners (in `web/`)
7. web server (`DashboardServer`)
8. process lock (`PortLockAcquirer` + `PidfileLockAcquirer`)
9. db (`DbClient`)

Inverting any pair causes either a hanging handle (a timer fires
after the watcher is closed) or a use-after-close (the heartbeat
writes to the db after `DbClient.close()`).

### Mitigation

1. **`App.shutdown()` documents the order.** The `shutdown` method
   has a comment block listing the nine steps and the rationale for
   each (per the `01-module-state-analysis.md` Section 8 reasoning).
2. **Test exercises the full shutdown.** A new integration test
   starts an `App`, sends SIGTERM, and asserts each subsystem's
   `stop()` was called in the right order (via a spy on each
   class's `stop` method).
3. **`App.shutdown()` is idempotent.** Calling `shutdown()` twice
   is a no-op the second time. Guards each subsystem with a
   `private stopped: boolean` field.

### Detection signal

- An integration test that calls `shutdown()` twice logs "double
  shutdown" warnings from the second call.
- A leaked `fs.FSWatcher` or `NodeJS.Timeout` is reported by the
  test runner's "open handles" warning after the test completes.

---

## R10. Pino logger re-import hazard during HMR or test reset

### Where it bites

`src/logger.ts:3` exports `const logger = pino({...})`. ESM caches
the module; re-import returns the same instance. The class refactor
keeps this singleton (per `00-summary.md` "logger is already a
singleton; conversion is a no-op"). But:

- A test that calls `vi.resetModules()` and re-imports `logger.ts`
  gets a new pino instance — but the per-class logger injection
  (per G5) holds a reference to the *old* instance, which is now
  disconnected from any global config the test set up after the
  reset.
- A `vi.mock('../logger.js', () => ({ info: vi.fn(), ... }))`
  works today because the export is a singleton; the mock replaces
  the singleton globally. After the refactor, the mock still works,
  but the per-class `LoggerLike` injection means each class holds
  the *mock* logger as `this.log` — fine, but the test must inject
  the mock via the constructor, not via module replacement.

### Mitigation

1. **Don't `vi.resetModules()` the logger.** Tests that need
   isolated logger behavior construct a new class with a fresh
   pino instance via the constructor.
2. **The logger export stays a singleton.** No class wraps the
   logger; the singleton is the import surface for the legacy free
   functions and for any code that hasn't migrated to constructor
   injection.

### Detection signal

- A test that mocks the logger and inspects `logger.info.calls`
  sees zero calls because the per-class logger is a different
  instance from the mocked singleton.

---

## Summary table

| ID | Risk | Severity | Mitigation summary |
|---|---|---|---|
| R1 | Circular deps via constructor DI | High | `Services` aggregate + late-binding setters |
| R2 | Breaking public API | High | Legacy thin wrappers + per-phase removal |
| R3 | `vi.mock` pattern conflicts | High | Mock the module's class export + per-test construction |
| R4 | Test order dependencies | Medium | Explicit per-test instance + ban on singleton in new tests |
| R5 | Generic variance pitfalls | Medium | Default invariance + no `as` at the boundary |
| R6 | Error stack traces | Medium | Source maps + structured error fields + no double-wrap |
| R7 | Route handler lifecycle | Medium | Per-request `RouteContext` + no `this` capture |
| R8 | Test coverage gaps during migration | Medium | Parallel class-API tests + coverage gate |
| R9 | Order-dependent shutdown | High | Documented order + integration test + idempotent shutdown |
| R10 | Pino logger re-import hazard | Low | No `vi.resetModules()` for the logger; singleton stays |
