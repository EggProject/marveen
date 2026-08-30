# F (agent subsystem) — Risks and mitigations

Risks specific to the F subsystem. Every entry: name, where-it-bites,
mitigation, detection signal. Plan-only; no source files modified.

**Reading note.** Eight risks (FR1-FR8) cover the dominant hazards
identified in `01-module-state-analysis.md` and `02-type-interface-analysis.md`:
heartbeat timer state, fs.watch double-init, lazy-cache refresh race,
construction-order coupling, in-flight cancellation, mock-seam
preservation, LoggerLike binding, and the CE-7 adjacent prompt-builder
seam. Each risk is grounded in a specific file:line verified against
`src/` on 2026-08-30.

---

## FR1 — Heartbeat timer state: double-schedule on HMR / `vi.resetModules()`

### Where it bites

`src/heartbeat.ts:565-566` declares two module-level `let`s:

```ts
let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null
let stopped = false
```

The `scheduleNext` recursion at `:568-580` self-reschedules from inside
the callback:

```ts
function scheduleNext(delayMs: number): void {
  heartbeatTimeout = setTimeout(async () => {
    await executeHeartbeat().catch(...)
    if (!stopped) scheduleNext(nextDelayMs)
  }, delayMs)
}
```

`stopHeartbeat` at `:594-598`:

```ts
export function stopHeartbeat(): void {
  stopped = true
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout)
  logger.info('Heartbeat leallitva')
}
```

Two compounding failures:

1. **`stopHeartbeat` does NOT set `heartbeatTimeout = null`.** A racing
   `initHeartbeat()` between `stopHeartbeat()` and the in-flight
   callback finishing leaves the earlier handle armed while the newer
   one schedules a fresh timeout. Result: two parallel heartbeat
   loops until the next tick.
2. **Module re-evaluation under `vi.resetModules` / `tsx --watch`
   resets the `let` cells but NOT the OS-level `setTimeout` handle.**
   Node holds the closure alive via the event loop. The new module's
   `heartbeatTimeout` is `null`, so the `if (heartbeatTimeout)` guard
   passes — and a fresh timeout is armed alongside the still-firing
   old one.

### Mitigation

`HeartbeatScheduler.stop()`:

- Clears the in-flight handle AND sets the field to `null`.
- Awaits any in-flight `execute()` promise and cancels it via the
  `stopped` flag + a per-tick early-return check at the top of
  `execute()` (FR5 documents the cancellation logic).
- Asserts at construction time that the singleton is unique per
  process (e.g. via a `static instance` field that throws if a second
  instance is constructed).

`HeartbeatScheduler.init()`:

- Pre-flight check: if `this.timerHandle !== null`, log a warning and
  call `this.stop()` before re-arming.
- Captures the new handle in `this.timerHandle` synchronously.

### Detection signal

After F.1 lands, the `heartbeat.ts:584` log line "Heartbeat
ellenorzes indul..." (`logger.info` at `:492`) must fire **exactly once
per `init()` call**, never twice. A test that calls `init()` twice
without intervening `stop()` should observe the second call logged as
"already running, re-arming" and produce exactly one scheduled timeout
(not two). A test that constructs two `HeartbeatScheduler` instances
should throw `Error("HeartbeatScheduler singleton already exists")`.

---

## FR2 — `StoreWatcher` + `SettingsStore` double-`fs.watch` on HMR / module re-evaluation

### Where it bites

`src/store-watcher.ts:88-95`:

```ts
export function startStoreWatcher(): void {
  if (watcher) return  // idempotent on the handle
  knownFiles = new Set<string>()
  scanStore(STORE_DIR)
  try {
    watcher = watch(STORE_DIR, { recursive: true }, (eventType, filename) => {
      // ... rename-only, dedup'd, system-file-filtered ...
      logStoreFileEvent(rel, 'create', 0, fileSize, agent)
    })
  } catch (err) {
    logger.warn({ err }, 'Store file watcher failed to start')
  }
}
```

`src/settings-store.ts:46-56`:

```ts
function ensureWatching(): void {
  if (watcher) return
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    watcher = watch(STORE_DIR, { persistent: false }, __test_handleWatchEvent)
  } catch {
    // Best-effort: ... cache simply stays as of the last read/write from this
    // process -- still correct for the common single-process case.
  }
}
```

The `if (watcher) return` guard at both sites protects against
same-graph re-entry only. Under `vi.resetModules()`, `tsx --watch`, or
a forked worker that imports the file a second time, the new
module-graph has `watcher = null` but the old `fs.watch` handle is
still open. Node holds the closure alive via the event loop.

Result: two `fs.watch` callbacks firing per `rename` event,
duplicated `logStoreFileEvent` writes, and a leak that compounds
across re-imports.

### Mitigation

`StoreWatcher` and `SettingsStore` constructors:

- Assert `if (handle) throw new Error('watcher already open')` at
  start-time, where `handle` is the private readonly `FSWatcher`
  field.
- `start()` (or `ensureWatching()`) opens; `stop()` (or `close()`)
  closes and nulls the field.
- The class form keeps the idempotency the current `if (watcher)
  return` guard approximates, but **stricter**: a second `start()`
  before `stop()` is a logged warning, not a silent no-op.

For HMR / `vi.resetModules()`: the singleton instance is held by
`class App` and re-used across re-imports. The class form eliminates
the "reset cells, leak handles" failure mode because the instance is
not module-scope.

### Detection signal

After F.3 + F.4 land, a test that calls `start()` twice without
intervening `stop()` should observe a logged warning ("watcher
already open, ignoring") rather than two registered callbacks.
A test that constructs two `StoreWatcher` instances and calls
`start()` on each should observe two `FSWatcher` handles (the second
one warns but is allowed). A test that runs in `vi.resetModules()`
mode should observe exactly one watcher handle via
`fs.watch.mock.calls.length`.

---

## FR3 — `LazyCache` refresh race: `refreshInFlight` must remain singleton-aware

### Where it bites

`src/google-api.ts:108-118`:

```ts
let refreshInFlight: Promise<string> | null = null

async function refreshAccessToken(refreshToken: string, clientId: string,
  clientSecret: string, tokenUri: string): Promise<string> {
  if (refreshInFlight) return refreshInFlight  // single-flight
  refreshInFlight = doRefresh(...)
    .finally(() => { refreshInFlight = null })
  return refreshInFlight
}
```

The inline comment at `:111-114` (per `01 §Lazy-cache cluster`):

> "A slower response would overwrite a faster one — load-bearing
> single-flight."

After class extraction, the naive shape (`refreshInFlight` as a
`private` field) would tie the single-flight to the **instance**, not
the **process**. Two `GoogleApiClient` instances would issue two
parallel refreshes, defeating the dedup.

### Mitigation

`GoogleApiClient.refreshInFlight` is a **`private static` field**:

```ts
class GoogleApiClient {
  private static refreshInFlight: Promise<string> | null = null
  // ... instance fields for cachedTokens + cachedClient ...
}
```

All instances share one `static refreshInFlight`. The instance-level
fields are still per-instance, but the dedup is process-wide.

Alternative: keep `refreshInFlight` at module scope outside the class
(preserving today's shape verbatim). This is acceptable per the
"principle of least surface change" but loses the namespace symmetry
of having all related state on the class.

### Detection signal

After F.2 lands, a test that constructs two `GoogleApiClient`
instances and calls `refreshAccessToken` concurrently from both
should observe exactly **one** `doRefresh` invocation (not two). A
test that verifies the `finally` cleanup should observe
`GoogleApiClient.refreshInFlight === null` after the Promise
resolves.

---

## FR4 — `HeartbeatScheduler.execute()` depends on `Memory.runDecaySweep`; construction-order documentation needed

### Where it bites

`src/heartbeat.ts:509-512`:

```ts
try {
  runDecaySweep()
} catch (err) {
  logger.warn({ err }, 'runDecaySweep failed (continuing heartbeat)')
}
```

`runDecaySweep` lives in `src/memory.ts:16` and depends on the
`db: Database` singleton at `src/db.ts:10`. If `HeartbeatScheduler`
is constructed before `db` is initialised, `runDecaySweep()` throws.

The `try/catch` at `:509-512` only catches **synchronous** throws. The
inline comment at `:503-507` warns: "if the call ever becomes async,
the catch becomes load-bearing dead code".

### Mitigation

- `HeartbeatScheduler.execute()` retains the `try/catch` shape
  verbatim. The class form does not change the error-suppression
  semantics.
- `class App` (framework D3) constructs `MemoryStore` before
  `HeartbeatScheduler`, ensuring the dependency is ready when the
  scheduler's first tick fires.
- The first `execute()` is delayed until `db` is open: the
  `HeartbeatScheduler.start()` method is called AFTER `db.open()`
  in the boot sequence at `index.ts:541-552` (which is already
  ordered correctly today, per `01 §Startup ordering`).
- The construction-order contract is documented in the class JSDoc
  on `HeartbeatScheduler`'s constructor: "Requires `memory.runDecaySweep`
  to be available; construct after `MemoryStore.open()`."

### Detection signal

After F.1 lands, a test that constructs `HeartbeatScheduler` and
calls `execute()` before any `MemoryStore` setup should observe the
`runDecaySweep failed (continuing heartbeat)` warn log and the
heartbeat continues without the decay sweep (today's behaviour). A
test that verifies the construction order in `class App` should
observe `memoryStore.open()` before `heartbeatScheduler.start()` in
the boot sequence.

---

## FR5 — `HeartbeatScheduler.stop()` must clear the timer AND cancel any in-flight `execute()` promise

### Where it bites

`heartbeat.ts:483-552`'s `executeHeartbeat` is an async function that
does:

1. Window check + early-return if outside the active window.
2. `runDecaySweep()` (per FR4).
3. `collectData()` — db reads.
4. `shouldNotify(data)` — pure decision.
5. `cwdBuilder.ensure()` — file-system side effect.
6. `runAgent(...)` — sub-process spawn (long-running).
7. `notifyTelegram(text)` — outbound message.

If `stopHeartbeat()` is called while `executeHeartbeat()` is in the
middle of step 6 (the sub-process spawn), the spawn continues
regardless — Node holds the abort controller in the `runAgent` body,
not in the heartbeat module.

Per `01 §Double-timer hazard`:

> "The `clearTimeout` runs **synchronously** while the previous
> timer's callback may already be **executing** in the event loop.
> If `initHeartbeat()` is called again between `stopHeartbeat()` and
> the in-flight callback finishing (theoretically only across
> awaits), there is no interleaving guard beyond the `stopped` flag."

### Mitigation

`HeartbeatScheduler.stop()`:

- Sets `this.stopped = true`.
- Clears `this.timerHandle` via `clearTimeout` AND sets
  `this.timerHandle = null`.
- Awaits `this.inFlightExecute` if non-null — but does NOT wait
  indefinitely; the `execute()` body checks `this.stopped` at each
  natural await point (after `runDecaySweep`, after `collectData`,
  before `runAgent`, after `runAgent`) and early-returns if true.

`HeartbeatScheduler.execute()`:

- At the top: `if (this.stopped) return`.
- After `runDecaySweep()`: `if (this.stopped) return`.
- After `collectData()`: `if (this.stopped) return`.
- Before `runAgent(...)`: `if (this.stopped) return`.
- After `runAgent(...)`: `if (this.stopped) return`.

This matches the framework-wide "in-flight cancellation" pattern from
`d-channel-provider/03-class-boundaries.md §D2` (the channel providers
have no async lifecycle to cancel) and `e-process-lock/03-class-boundaries.md §E1`
(port lock is held by the kernel until process death, so no in-flight
cancel needed).

### Detection signal

After F.1 lands, a test that calls `stop()` while `execute()` is
mid-`runAgent` should observe:
1. `stop()` returns within `runAgent`'s own timeout
   (`AGENT_TIMEOUT_MS` at `agent.ts:10`), not within `stop()`'s wall-clock.
2. `notifyTelegram` is NOT called (the early-return at the post-`runAgent`
   check fires).
3. The next `start()` re-arms a fresh timer; the previous in-flight
   `execute()` does not re-arm (its `scheduleNext` recursion sees
   `stopped === true` and returns).

---

## FR6 — `vi.mock('../heartbeat.js')` and `vi.mock('../store-watcher.js')` pattern: count test files; verify mock-seam survives

### Where it bites

Per `01 §Per-file inventory`:

- `vi.mock('../heartbeat.js')` — 1 site at `index.test.ts:122`. Plus
  the adjacent mock at `index.test.ts:127` for `../web/heartbeat-agent-scaffold.js`
  (CE-7 — different subsystem).
- `vi.mock('../store-watcher.js')` — 4 sites: `index.test.ts:164`,
  `autonomy-routes.test.ts:63`, `settings-routes.test.ts:83`,
  `agents-routes.test.ts:483`.
- `vi.mock('../settings-store.js')` — 13 sites (most-mocked F file,
  per `01 §Per-file inventory`).
- `vi.mock('../google-api.js')` — 2 sites: `heartbeat.test.ts:90`,
  `heartbeat-cov.test.ts:60`.
- `vi.mock` for `graph-mail.js` — 0 (test uses `vi.resetModules()` +
  `await import` instead, per `01 §Per-file inventory`).
- `vi.mock` for `auto-restart.js` — 0 (the 3 `vi.mock` hits are for
  `../web/auto-restart-store.js`, a different file).

The class extraction must keep these mocks working. The dominant
pattern is "replace the entire module with an inline object", which
survives because the free-function wrappers `initHeartbeat` etc.
keep the same exported names.

### Mitigation

- The free-function wrappers (F.1, F.3, F.4, F.5, F.6, F.7's
  `resolveClaudeCodeBin`) survive through F.8. Each wrapper is a
  one-line function that calls the singleton's method.
- The `vi.mock` factory at `index.test.ts:122` and `:164` continues
  to substitute the entire module with an inline object whose
  methods are `vi.fn()`. After F.8, the inline object is replaced
  by a singleton-style mock instance (or a `new HeartbeatScheduler(...)`
  with `vi.fn()`-wired methods).
- The 13 `settings-store.js` mocks each follow the same pattern;
  the migration is mechanical (replace inline-object mock with
  `new SettingsStore()` + per-method `vi.fn()`).

### Detection signal

After F.1-F.8 land, `grep -rln "vi\.mock.*heartbeat\|vi\.mock.*store-watcher\|vi\.mock.*settings-store\|vi\.mock.*google-api\|vi\.mock.*graph-mail\|vi\.mock.*auto-restart" src/__tests__/` returns the same files as today (1 + 4 + 13 + 2 + 0 + 0 = 20 sites), but the inline-object mocks are replaced with class-instance mocks. Each test passes through `bun --bun vitest run`.

---

## FR7 — H subsystem HR1 (pino `child()` rebinding) applies to F: `HeartbeatScheduler` may use `.child({ module: 'heartbeat' })`

### Where it bites

Per `h-cross-cutting/06-risks-and-mitigations.md HR1` (referenced from
`00-summary.md §Top-3 risks specific to H #2`):

> "Requiring `child()` on `LoggerLike` invalidates 88 of 91 test mocks.
> ... Zero production files call `logger.child(` ... Present in only 3
> of 91 mocks."

If F.6 adopts a `LoggerLike` that requires `child()` (e.g. so
`HeartbeatScheduler` can call `this.log.child({ module: 'heartbeat' })`),
the 91 test mocks must all be updated. Per H's verdict, `child()` is
**omitted** from `LoggerLike` (no production caller).

The 17 logger call sites in `heartbeat.ts` (`02 §Per-file type audit`)
do not currently use `.child()`. If F.6 introduces
`this.log.child({ module: 'heartbeat' })` (per a future feature where
observability wants per-module log scopes), F.6 would have to update
`LoggerLike` to add `child`, which contradicts H.1's verdict.

### Mitigation

- F.6's `LoggerLike` adoption is **the same shape H.1 ships**: `{ info;
  warn; error; debug }`. No `child()`.
- If a future feature wants `child()`, it lands in a separate F.6.b
  phase that updates `LoggerLike` per H's verdict (the update is a
  one-line change + 91 test mock updates; the test mock churn is
  bounded and mechanical).
- `HeartbeatScheduler` does NOT call `.child()` in F.1. Its logger
  is the module-level pino singleton (`this.log = logger`).

### Detection signal

After F.6 lands, `grep -nE "log\.child|logger\.child" src/heartbeat.ts src/store-watcher.ts src/settings-store.ts src/google-api.ts src/graph-mail.ts src/agent.ts` returns zero matches. The H.1 test pin
(`const l: LoggerLike = logger` compiles with no cast) still passes.

---

## FR8 — `web/heartbeat-agent-scaffold.ts` (CE-7) is OUT of scope for F; document the seam

### Where it bites

`src/web/heartbeat-agent-scaffold.ts` (324 lines, per
`review-completeness.md CE-7`) is the **prompt-builder** for the
heartbeat agent, NOT the runner. It owns no ticker; it materialises
the heartbeat agent's directory once per boot when the dashboard
process bootstraps. It is wired into `src/web/main-agent.ts:49`.

`review-completeness.md CE-7`:

> "The plan lumps `web/heartbeat-agent-scaffold.ts` into the B5 runner
> list (alongside `message-router.ts`, `inbound-prober.ts`) but it has
> no `tick()` — it's a prompt-builder. The conversion (runner-as-class)
> doesn't fit."

If F.1's `HeartbeatScheduler.execute()` produces data that the
prompt-builder consumes, the seam must be documented. Today the
seam is a free-function call from `web/main-agent.ts:49` to
`buildHeartbeatAgentPrompt(...)`.

### Mitigation

- `web/heartbeat-agent-scaffold.ts` stays out of F scope. F does NOT
  convert it. The framework's B5 runner list explicitly excludes it
  (per `d-channel-provider/00-summary.md §Top-3 lowest-risk wins` and
  CE-7's "Separate `web/heartbeat-agent-scaffold.ts` from the runner
  list" concrete fix).
- The seam today: `HeartbeatScheduler.execute()` runs the sub-agent
  spawn (`runAgent(...)` at `heartbeat.ts:550`); the prompt-builder
  is invoked at boot time only (`web/main-agent.ts:49`), not per-tick.
- If F.1 changes the data shape that the prompt-builder consumes
  (e.g. `HeartbeatData` adds a field), the prompt-builder must be
  updated in lockstep. Today `HeartbeatData` is built inline at
  `heartbeat.ts:483-552`; F.1 keeps the same shape (no new fields).
- The seam is documented in `class HeartbeatScheduler`'s JSDoc:
  "Reads from the cwd builder and writes to the runner via
  `notifyTelegram`; does NOT call `web/heartbeat-agent-scaffold.ts`.
  The prompt-builder is a separate subsystem wired at boot."

### Detection signal

After F.1 lands, `grep -n "web/heartbeat-agent-scaffold" src/heartbeat.ts` returns zero matches (the scheduler does not call the prompt-builder). The 1 `vi.mock('../web/heartbeat-agent-scaffold.js', ...)` site at `index.test.ts:127` continues to substitute the module unchanged. The boot-time wiring at `web/main-agent.ts:49` continues to call `buildHeartbeatAgentPrompt(...)` directly.

---

## Cross-cutting risk: FR-free-fn-debate — `AutoRestartSchedule` vs free functions

### Where it bites

`02 §AutoRestart deep-dive` recommends keeping `auto-restart.ts` as
free functions because every export is deterministic and pure. The
brief overrides this and asks for `class AutoRestartSchedule`. The
override has a documented risk: the class form adds an instance for
zero behavioural change, and `DEFAULT_AUTO_RESTART`'s identity is
captured by tests (mutating it would corrupt in-flight tests).

### Mitigation

- `DEFAULT_AUTO_RESTART` remains a module-level `const` (frozen) AND
  is exposed as `instance.DEFAULT` on the class. The two references
  are the same object (`AutoRestartSchedule.DEFAULT === DEFAULT_AUTO_RESTART`).
- All five methods (`mode`, `parseHHMM`, `normalize`, `restartDue`,
  `dailyDueAtMs`) are pure and do not mutate instance state. The
  class form is a namespace wrapper, not a state-owning class.
- A test pin: `Object.freeze(DEFAULT_AUTO_RESTART)` (or
  `as const` if TS-level) is preserved. The class field
  `readonly DEFAULT: AutoRestartConfig = DEFAULT_AUTO_RESTART` does
  not mutate.

### Detection signal

After F.5 lands, `Object.isFrozen(DEFAULT_AUTO_RESTART)` returns
`true`. `instance.DEFAULT === DEFAULT_AUTO_RESTRAINT` returns
`true`. All five methods are called from the existing tests and
return the same values as the free functions today.

---

## Risk matrix

| Risk | Severity | Probability | Detection (test) | Phase that mitigates |
|---|---|---|---|---|
| FR1 | High | Medium (HMR triggers this) | Singleton assertion + double-init log | F.1 |
| FR2 | Medium | Medium (HMR + tests) | `fs.watch.mock.calls.length` count | F.3 + F.4 |
| FR3 | High | Low (production never has 2 instances; tests might) | Concurrent refresh dedup test | F.2 |
| FR4 | Medium | Low (boot order already correct) | Construction-order JSDoc + boot sequence test | F.1 + framework D.3 |
| FR5 | High | Medium (long-running spawn can race with stop) | Mid-spawn stop test | F.1 |
| FR6 | Medium | High (20+ mock sites) | All 20+ mock sites pass `bun --bun vitest run` | F.1-F.8 |
| FR7 | Low | Low (no F code calls `.child()`) | `grep` returns zero | F.6 |
| FR8 | Low | Low (CE-7 already separates) | `grep` returns zero cross-imports | F.1 (seam documented) |
| FR-free-fn-debate | Low | Low (test identity preserved) | `Object.isFrozen` + identity test | F.5 |

**Total: 1 high-severity-high-probability (FR1), 2 high-severity-medium-probability (FR3, FR5), 5 medium-severity-medium-or-low-probability.** No critical-severity risks.

---

## Test factory design (cross-references CE-5 / CE-15)

Per `review-completeness.md CE-5` + `CE-15`, the F subsystem's test
factories must be specified before F.1 lands. The convention adopted
by E and D (and proposed for F):

```ts
// Test factory (per-test)
function makeHeartbeatScheduler(opts?: Partial<HeartbeatOpts>): HeartbeatScheduler {
  return new HeartbeatScheduler(
    new HeartbeatWorkerCwdBuilder(mockLog),
    new MemoryStore(':memory:'),  // or a shim until framework A1 lands
    mockNotifier,
    new GoogleApiClient(mockLog, mockHomedir),
    mockLog,
    new SettingsStore(mockLog),
  )
}
```

The factory is defined in `src/__tests__/_factories.ts` (per the
framework's CE-5 "Add a 'Test factory design' subsection" concrete
fix). Each F test imports the factory and overrides only the
dependencies it needs.

For the 91 logger mocks that already satisfy `LoggerLike`, the
factory uses a `vi.fn()` per level:

```ts
const mockLog: LoggerLike = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
}
```

This is identical to the pattern H.1 / E / D use; F inherits.

---

## Bun-specific test patterns (cross-references CE-17)

Per `review-completeness.md CE-17`, bun's runtime differs from Node in:
- Module resolution (bun uses its own loader).
- Stack frame format.
- `instanceof` semantics.
- `Error.captureStackTrace` support.

The F test factory must not rely on `instanceof` for the F classes
(use `Symbol.hasInstance` if needed) and must use bun-native stack
traces (no `Error.captureStackTrace` overrides). The factory
specification above does neither; verified by reading the existing
test fixtures at `src/__tests__/{heartbeat,settings-store,store-watcher,
graph-mail,google-api,auto-restart}*.test.ts`.

---

## Net verdict

The 8 risks (FR1-FR8) are all **bounded by class extraction**: each
risk becomes either a singleton assertion (FR1, FR2), a static field
(FR3), a construction-order JSDoc (FR4), an early-return guard
(FR5), a mock-seam preservation (FR6), a `grep` for `.child()`
returning zero (FR7), or a documented seam (FR8). No risk is
"fundamentally intractable" — each has a one-line mitigation in the
class surface.

The **dominant** risk is FR1 (heartbeat timer state) because it
involves the OS-level event loop in a way the class form alone
cannot fully control. The mitigation is the singleton assertion
(ensures one instance per process) plus the in-flight execute
cancellation (FR5) — these two together eliminate the double-schedule
mode.

The **second-dominant** risk is FR3 (`refreshInFlight` per-process
singleton). The mitigation is a `private static` field; verified by
the dedup test that constructs two `GoogleApiClient` instances and
expects one `doRefresh` call.

The **least-dominant** risk is FR7 (`child()` rebinding). The
mitigation is "don't do it"; F.6 inherits H.1's no-`child()`
verdict verbatim.

Net assessment: **F can land its 8 class extractions with bounded
risk**, gated on H.1 + H.3 for F.6 + F.7, and gated on every consumer
migration + test update for F.8.
