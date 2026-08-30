# G (channel-coordinator) — Refactor roadmap

Ordered phases for the G subsystem only. Each phase is independently
mergeable, with rollback granularity per phase. **Planning only — no
source files modified.** All file:line claims verified against `src/`
on 2026-08-30.

---

## Phase G.1 — `TelegramClient` class extraction

**Goal:** Introduce `class TelegramClient` alongside the existing free
functions in `src/channel-coordinator/telegram-client.ts`. The class
wraps the 3 HTTP-poll functions (`mapUpdate`, `getUpdates`,
`probeHighWater`); the existing free functions become thin
pass-through wrappers. The `TelegramApiError` class at L45-54 survives
verbatim.

**Files touched:**

- `src/channel-coordinator/telegram-client.ts` (227 LOC) — add
  `class TelegramClient` block at the bottom; the 3 free functions
  stay as `export function` and become 1-line wrappers
  (`export const getUpdates = (...args) => new TelegramClient(env, db, log).getUpdates(...args)`)
  OR keep their bodies and add a parallel class API. The
  recommended shape is the latter: keep the free-function bodies
  intact, add a `class TelegramClient` that has identical method
  bodies pointing at the same internal helpers (`mapUpdateImpl`,
  `getUpdatesImpl`, `probeHighWaterImpl` extracted to private
  static methods).
- No other files touched. The single internal consumer
  (`channel-coordinator.ts:36`) keeps using the free functions
  until G.4/G.6.

**Class surface:** per `03-class-boundaries.md §G1`.

**Risk level:** Low. The class is **purely additive**; zero behavior
change. The free functions stay byte-identical. The 1 dedicated test
file `src/__tests__/channel-coordinator-telegram-client.test.ts`
continues to exercise the free functions; no test rewrite needed.

**Test coverage requirement:**

- Existing tests must remain green (`channel-coordinator-telegram-client.test.ts`).
- New: at least 1 test that constructs `new TelegramClient(mockEnv, mockDb, mockLog)` and calls each of the 3 methods to verify the class form produces identical results to the free-function form. Per `review-completeness.md` CE-5, a `createTestTelegramClient(overrides?)` factory is the canonical pattern.
- Coverage gate: no decrease. The free-function tests cover `mapUpdate`/`getUpdates`/`probeHighWater` paths; the new class-form tests should cover identical paths (parameterized at the wrapper level, not at the body level).

**Rollback strategy:**

- Single-commit revert. The class is additive; removing the class
  block restores the free-function-only state.
- No downstream migration depends on the class (G.2/G.3 build other
  classes; G.4 is the orchestrator). G.1 can land in isolation.

**Parallelizable:** Yes. G.1, G.2, and G.3 are 3 independent
leaf-class extractions in 3 different files. They can land in any
order or in parallel branches. Per `01 §Per-file inventory` and
`03-class-boundaries.md`, the 3 classes have **zero inter-dependency
at this stage** — they only meet in G.4's `ChannelCoordinator`
constructor.

**Dependencies:** None blocking. G.1 does NOT depend on H.1
(`LoggerLike`) — the constructor takes `log: LoggerLike` per the
brief, but the class form can defer the logger field to G.7 (per the
phased plan). If G.1 lands before H.1, the constructor takes `log:
Logger` (the concrete pino type from `src/logger.ts:3`); the
re-typing to `LoggerLike` happens in G.7.

**Migration source:** `src/channel-coordinator/telegram-client.ts:98-226`.

---

## Phase G.2 — `IngestWorker` class extraction

**Goal:** Introduce `class IngestWorker` alongside the existing free
functions in `src/channel-coordinator/ingest.ts`. The class absorbs
the 1 module singleton `let db: Database | null = null` at L25 and
the 8 free functions enumerated in `03-class-boundaries.md §G2`. The
3 external const-only consumers of `COORDINATOR_AGENT_ID` (per
`01 §11`) keep working via the static-field re-export.

**Files touched:**

- `src/channel-coordinator/ingest.ts` (231 LOC) — add `class
  IngestWorker` block. The `let db` singleton becomes a private
  field. The free functions stay as thin pass-through wrappers. The
  `COORDINATOR_AGENT_ID` const at L23 stays as a free export that
  reads `IngestWorker.COORDINATOR_AGENT_ID` (preserves the import
  path for the 3 external consumers).
- No other files touched. The internal consumer
  (`channel-coordinator.ts:38-48`) keeps using the free functions
  until G.4/G.6.

**Class surface:** per `03-class-boundaries.md §G2`.

**Risk level:** Low-Medium. The `coordintorAgentId` re-export is the
load-bearing detail — the 3 external consumers
(`web/agent-message-wrap.ts:21`, `web/federation/local-catalog.ts:8`,
`web/routes/messages.ts:11`) import only the const. If the static
field is renamed or the const is removed before G.8, the consumers
break.

**Test coverage requirement:**

- Existing tests must remain green (5+ dedicated test files
  exercise `ingest.ts` directly via the free functions).
- New: at least 1 test that constructs `new IngestWorker()` and
  calls `init()`, exercises `insertIncomingEvent` /
  `getEventsNeedingHandoff` / `setOffset` / `getOffset` round-trip,
  calls `close()`. Per `review-completeness.md` CE-5, a
  `createTestIngestWorker(overrides?)` factory.
- Coverage gate: no decrease.

**Rollback strategy:**

- Single-commit revert. The class is additive; removing the class
  block restores the singleton-only state.

**Parallelizable:** Yes (with G.1 and G.3). Independent file.

**Dependencies:**

- A.1 (`DbClient` keystone) — NOT blocking. Per `01 §10`, the
  coordinator opens its own handle via `new Database(dbPath, { strict: true })`
  and does NOT share the dashboard's `DbClient`. The class form
  preserves this.
- H.1 (`LoggerLike`) — NOT blocking. `IngestWorker` has zero
  logger call sites today and does not gain a `log` field.

**Migration source:** `src/channel-coordinator/ingest.ts:25-230`.

---

## Phase G.3 — `LivenessTracker` class extraction

**Goal:** Introduce `class LivenessTracker` for the 4 mutable lets at
`src/channel-coordinator.ts:101-106`. The class lives in the entry
file (NOT in `liveness.ts` — the 9 free probe functions in
`liveness.ts` stay untouched per `01 §10` and the 4 `vi.mock` sites
documented in `01 §11.4`).

**Files touched:**

- `src/channel-coordinator.ts` (442 LOC) — add `class LivenessTracker`
  block at the bottom. The 4 mutable lets become private fields of
  the class. The `inNative409Cooldown` helper at L109-111 becomes a
  method on the class.
- The free `inNative409Cooldown` function stays as a 1-line
  pass-through wrapper (per `03-class-boundaries.md §G3` "Free
  functions that REMAIN") so `channel-coordinator.test.ts` keeps
  working.
- `src/channel-coordinator/liveness.ts` — NOT touched.

**Class surface:** per `03-class-boundaries.md §G3`.

**Risk level:** Medium. The 4 mutable lets are interleaved across 8
read/write sites in `runLoop` (L311-403); the class extraction is
a careful rename of every read/write. Per `01 §1.2`, "the simplest
design that solves the problem is the right one" — collapsing to
4 private fields is the safe move.

**Test coverage requirement:**

- Existing tests must remain green. `channel-coordinator.test.ts`
  exercises `inNative409Cooldown` directly via the free function
  (per `01 §11.3`).
- New: at least 1 test that constructs `new LivenessTracker()` and
  walks the state machine through a `DOWN` → `backfilling` →
  `idle` transition (driving `incrementDownStreak`, `setState`,
  `setNativeConfirmedUpUntil`, `inNative409Cooldown`).
- Coverage gate: no decrease.

**Rollback strategy:**

- Single-commit revert. The class is additive; removing the class
  block restores the 4-let module state.
- **CAUTION:** if `runLoop` is partially rewritten to use
  `this.liveness.*` accessors before the class is removed, the
  revert is non-trivial. The recommended order: (a) introduce
  `LivenessTracker` class with parallel method surface, (b)
  rewrite `runLoop` to use `this.liveness.*` in a SEPARATE
  commit, (c) revert must touch both commits. Per
  `CLAUDE.md §3`, split the rewrite across 2 commits only if
  reverting the rewired `runLoop` while keeping the class is
  feasible — and it is, because the class's methods are pure
  pass-throughs to the free-function behavior.

**Parallelizable:** Yes (with G.1 and G.2). Different file.

**Dependencies:**

- H.1 (`LoggerLike`) — NOT blocking. `LivenessTracker` is passive
  state; no logger field needed.

**Migration source:** `src/channel-coordinator.ts:100-111` (the
`type State` + 4 lets + helper).

---

## Phase G.4 — `ChannelCoordinator` class extraction

**Goal:** Introduce `class ChannelCoordinator` as the orchestrator.
The class absorbs `main()` (L422-431), `runLoop()` (L311-403),
`processBatch()` (L233-258), `reconcilePending()` (L270-298),
`fatalExit()` (L302-307), `acquireSingleInstanceLock()` (L142-157),
`releaseLock()` (L159-163), `sendAlert()` (L170-175), `readToken()`
(L117-136), and the public free functions `buildHandoffContent`
(L189-215) and `neutralizeChannelTags` (L182-184). The constructor
takes the 3 other G classes plus D.3 `ChannelProviderRegistry` and
H.1 `LoggerLike`.

**Files touched:**

- `src/channel-coordinator.ts` (442 LOC) — add `class
  ChannelCoordinator` block. The 11 free functions become either
  class methods or thin pass-through wrappers. The 4 module-level
  lets are removed (their state lives on `LivenessTracker`, which
  is constructed in the new class's constructor).
- No other files touched in G.4. The consumer migration (G.6)
  rewires `main()` to construct the class and call `.start()`.

**Class surface:** per `03-class-boundaries.md §G4`.

**Risk level:** Medium-High. This is the largest single-file
rewrite. The 4 mutable lets move to `LivenessTracker`; the `main()`
function becomes `start()`; the SIGTERM handler becomes a closure
over a module-scope singleton instance.

**Test coverage requirement:**

- Existing tests must remain green. The 11 dedicated
  `channel-coordinator-*.test.ts` files exercise the free
  functions directly (`01 §11.3`). They keep working via the
  free-function pass-throughs.
- New: at least 1 startup test (`channel-coordinator-full.test.ts`-
  style) that constructs `new ChannelCoordinator(opts).start()`
  with a mock `TelegramClient`, mock `IngestWorker`, mock
  `LivenessTracker`, mock `ChannelProviderRegistry`, and verifies
  the full bootstrap sequence (PID lock, ingest init, signal
  handlers, run loop entry).
- New: at least 1 shutdown test that constructs an instance,
  triggers `stop()`, and verifies the 3-second drain (or
  fast-forwards the timer in test mode).
- Coverage gate: no decrease.

**Rollback strategy:**

- Single-commit revert. The class is additive; the free functions
  stay as thin pass-throughs. The 4 lets are removed, so revert
  requires re-adding them — feasible but non-trivial. Recommend
  landing G.3 (LivenessTracker) in a separate commit BEFORE G.4,
  so G.4's revert is straightforward.

**Parallelizable:** NO. G.4 depends on G.1, G.2, G.3 (the 3 other
G classes must exist as types/values for the constructor signature).
G.4 must land last among the leaf classes.

**Dependencies:**

- G.1, G.2, G.3 — blocking. The constructor signature references
  the 3 other G classes.
- D.1 (`ChannelEnv`) — used inside `ChannelCoordinator`'s startup
  path to read `CHANNEL_PROVIDER`. NOT blocking (the const is
  read directly today at L57; the class form keeps the same
  read pattern via `opts.provider`).
- D.3 (`ChannelProviderRegistry`) — used in `getProvider()`. NOT
  blocking (the method is test-only; production never calls it
  per `01 §10`).
- H.1 (`LoggerLike`) — recommended but not strictly blocking.
  Per `h-cross-cutting/00-summary.md §Migration order`, G.4 can
  land with `log: Logger` (concrete pino) and re-type in G.7.

**Migration source:** `src/channel-coordinator.ts:1-442` (the whole
entry file minus the 4 lets and the `telegram-client.ts` import).

---

## Phase G.5 — `installSignalHandlers` decision

**Goal:** Decide whether `installSignalHandlers` (L407-420) becomes a
method on `ChannelCoordinator` or stays as a free function with the
class captured via a module-scope singleton. Per
`06-risks-and-mitigations.md` GR1.

**Files touched:**

- `src/channel-coordinator.ts` — either:
  - (a) `ChannelCoordinator.installSignalHandlers()` method, called
    from `start()`, with a `process.listenerCount` guard inside the
    method body. **Risk:** test re-entry can still bypass the guard
    if `start()` is called twice.
  - (b) `installSignalHandlers` stays free; `main()` captures the
    class instance via module scope. **Recommended.** Per the
    `e-process-lock/03-class-boundaries.md:42` precedent (port-lock
    context is captured at module init, not per-call).

**Class surface change:** Either adds `installSignalHandlers()` to
the `ChannelCoordinator` public surface (option a) OR no change
(option b).

**Risk level:** Low. The recommendation is option (b) — no class
shape change. The free function stays and captures the singleton.

**Test coverage requirement:**

- Existing `channel-coordinator.test.ts` covers `installSignalHandlers`
  behavior indirectly (the test file does not import the function,
  per `01 §11.3`).
- New: at least 1 test that verifies `installSignalHandlers` does NOT
  double-register when called twice in the same process. Per the
  recommendation, this is a `process.listenerCount('SIGTERM') === 2`
  assertion after a single call (the one `main()` invocation adds
  one listener; the test setup is responsible for resetting listeners
  before the test runs).

**Rollback strategy:**

- Single-commit revert. If option (b), no class-shape change — the
  revert is trivial.

**Parallelizable:** Yes with G.6 (consumer migration). The signature
is settled before G.6's `main()` rewrite.

**Dependencies:**

- G.4 (`ChannelCoordinator` class exists) — blocking for option (a),
  NOT blocking for option (b).

**Migration source:** `src/channel-coordinator.ts:407-420`.

---

## Phase G.6 — Consumer migration

**Goal:** Migrate the entry file's `main()` (L422-431) to construct
a `ChannelCoordinator` instance and call `.start()`. The L435
entry-point guard stays verbatim. The 11 dedicated
`channel-coordinator-*.test.ts` files do NOT need to change — they
exercise free functions which now route through the class.

**Files touched:**

- `src/channel-coordinator.ts` — `main()` becomes:
  ```ts
  async function main(): Promise<void> {
    const coordinator = new ChannelCoordinator({
      session: SESSION,
      provider: PROVIDER,
      stateDir: STATE_DIR,
      token: readToken(),
      pidFile: PID_FILE,
      notifyScript: join(PROJECT_ROOT, 'scripts', 'notify.sh'),
      telegram: new TelegramClient(...),
      ingest: new IngestWorker().init(),
      liveness: new LivenessTracker(),
      registry: channelProviderRegistry,   // D.3 singleton
      log: logger,                          // H.1 LoggerLike
    })
    installSignalHandlers(coordinator)      // free fn captures via closure
    await coordinator.start()
  }
  ```
- No other files touched in G.6. The 3 external `COORDINATOR_AGENT_ID`
  consumers (`web/agent-message-wrap.ts:21`,
  `web/federation/local-catalog.ts:8`, `web/routes/messages.ts:11`)
  are unaffected because `ingest.ts` keeps the const export.

**Risk level:** Low. The change is mechanical — replace the body of
`main()` with the constructor pattern. The free functions keep
working until G.8.

**Test coverage requirement:**

- All existing tests must remain green.
- New: integration test that constructs `ChannelCoordinator` with
  full DI, calls `.start()`, and verifies PID lock acquired, ingest
  initialized, signal handlers installed (per `channel-coordinator-full.test.ts`).
- Coverage gate: no decrease.

**Rollback strategy:**

- Single-commit revert. The pre-G.6 `main()` is preserved in git
  history.

**Parallelizable:** NO. G.6 depends on G.4 and G.5.

**Dependencies:**

- G.1, G.2, G.3, G.4, G.5 — all blocking.

**Migration source:** `src/channel-coordinator.ts:422-431`.

---

## Phase G.7 — `LoggerLike` adoption across G classes

**Goal:** Replace the `logger` (concrete pino singleton) imports in
G classes with `LoggerLike` (H.1 interface). Per
`h-cross-cutting/00-summary.md §Migration order`, this lands AFTER
H.1 introduces the interface.

**Files touched:**

- `src/channel-coordinator.ts` — `import { logger }` becomes
  `import { logger }` (still concrete; the `log` field on
  `ChannelCoordinator` is typed as `LoggerLike` but the value is
  the singleton). The change is **type-only**: `log: LoggerLike`
  in the constructor signature.
- `src/channel-coordinator/telegram-client.ts` — type-only change
  on the `TelegramClient.log` field.
- `src/channel-coordinator/ingest.ts` — NO change (IngestWorker
  has no logger field).
- `src/channel-coordinator/liveness.ts` — NO change.

**Class surface change:** All constructor `log` fields are retyped
from `Logger` (pino) to `LoggerLike` (H.1). No new methods, no
removed methods.

**Risk level:** Low. The change is purely the constructor
parameter type; no call site changes (the test factories either
pass the concrete `logger` or a mock — both satisfy `LoggerLike`).

**Test coverage requirement:**

- All existing tests remain green.
- Coverage gate: no decrease.

**Rollback strategy:**

- Single-commit revert.

**Parallelizable:** Yes with G.8 (free function removal). G.7 is
type-only; G.8 is the irreversible removal.

**Dependencies:**

- H.1 (`LoggerLike` interface) — blocking.

**Migration source:** `src/channel-coordinator.ts:34`
(`import { logger } from './logger.js'`).

---

## Phase G.8 — Free function removal

**Goal:** Remove the free-function pass-through wrappers that G.1,
G.2, G.3, G.4 introduced. The 11 dedicated
`channel-coordinator-*.test.ts` files MUST be updated to construct
the class instances directly.

**Files touched:**

- `src/channel-coordinator/telegram-client.ts` — remove the 3 free
  function bodies (keep the type exports `UpdateKind`,
  `NormalizedEvent`, `TelegramErrorKind`).
- `src/channel-coordinator/ingest.ts` — remove the 8 free function
  bodies and the `let db` singleton (keep the 2 type exports
  `InsertResult`, `IncomingEventRow`; the `COORDINATOR_AGENT_ID`
  const stays as `export const COORDINATOR_AGENT_ID =
  IngestWorker.COORDINATOR_AGENT_ID` because the 3 external web/
  consumers still import it).
- `src/channel-coordinator.ts` — remove the free `inNative409Cooldown`
  function (it's now a method on `LivenessTracker` + a method on
  `ChannelCoordinator`).
- `src/__tests__/channel-coordinator-*.test.ts` (11 files) — rewrite
  to construct class instances and call methods. Per
  `review-completeness.md` CE-5, use `createTestTelegramClient`,
  `createTestIngestWorker`, `createTestLivenessTracker`,
  `createTestChannelCoordinator` factories.
- `messages-routes.test.ts:101` (`vi.mock('../channel-coordinator/ingest.js')`
  factory substituting `COORDINATOR_AGENT_ID`) — keep working
  because `COORDINATOR_AGENT_ID` survives as a value export.

**Class surface change:** None.

**Risk level:** High. This is the **irreversible** phase. After
G.8, every importer of the free functions is updated; the old
import paths no longer resolve. The 11 test files must be updated
in lockstep.

**Test coverage requirement:**

- All tests must be GREEN after the rewrite. The test factories
  are the load-bearing detail.
- New: per-factory unit tests for `createTestTelegramClient`,
  `createTestIngestWorker`, `createTestLivenessTracker`,
  `createTestChannelCoordinator` (each factory must be tested
  independently before G.8 lands).
- Coverage gate: no decrease.

**Rollback strategy:**

- **Multi-commit revert.** G.8 is the only phase that spans
  multiple files in a single semantic change. The recommended
  approach: (a) land test-factory definitions in 4 separate
  commits, (b) land test-file rewrites in 11 separate commits
  (one per test file), (c) land the free-function removals in
  a single commit. Reverting (c) requires reverting (b) and (a)
  in reverse order.

**Parallelizable:** NO. G.8 is the final coordinated commit.

**Dependencies:**

- G.1, G.2, G.3, G.4, G.5, G.6, G.7 — all blocking.
- The 11 test files must be migrated to the class API in
  separate commits before G.8 lands.

**Migration source:** `src/__tests__/channel-coordinator-*.test.ts`.

---

## Summary timeline

```
G.1 ── parallel ──┐
G.2 ── parallel ──┼──> G.4 ──> G.5 ──> G.6 ──> G.7 ──> G.8
G.3 ── parallel ──┘
                                   ↑
                          test-factory work (G.8 prep)
```

- **G.1, G.2, G.3:** 3 parallel leaf-class extractions. Land in any
  order; no inter-dependencies.
- **G.4:** orchestrator, depends on G.1-G.3.
- **G.5:** signal-handler decision, depends on G.4.
- **G.6:** `main()` consumer migration, depends on G.4, G.5.
- **G.7:** `LoggerLike` type-only adoption, depends on H.1.
- **G.8:** free function removal, depends on all + test-factory work.

**Calendar estimate:** [ASSUMPTION] based on
`b-config/05-refactor-roadmap.md` and
`d-channel-provider/05-refactor-roadmap.md` patterns:

- G.1-G.3: 1 day each (parallel: 1 day total)
- G.4: 2 days (largest single-file rewrite)
- G.5: 0.5 day (decision + recommendation document)
- G.6: 0.5 day
- G.7: 0.5 day (type-only)
- G.8 prep: 1 day (4 test factories)
- G.8: 1 day (coordinated test rewrites + free function removal)
- **Total: ~7 working days**, can be parallelized across 2 agents
  (one on G.1-G.3 + G.7, one on G.4 + G.5 + G.6 + G.8).

---

**End of G refactor roadmap. No source files modified.**
