# G (channel-coordinator) — Risks and mitigations

Eight G-specific risks. Each row cites a specific file:line and a
detection signal that lets an executor verify the mitigation. **Planning
only — no source files modified.** All file:line claims verified
against `src/` on 2026-08-30.

---

## GR1 — `installSignalHandlers` ownership in the class form

**Where it bites.** `src/channel-coordinator.ts:407-420` defines
`installSignalHandlers()` which registers `onSignal` for `'SIGTERM'`
and `'SIGINT'`. Today the function is called ONCE from `main()` at
L426. If the G.4 `ChannelCoordinator` orchestrator takes ownership
of signal handlers in its constructor (or in `start()`), re-running
the constructor (e.g., from a test using `vi.resetModules()` or a
hot-reload under `tsx --watch`) would **double-register** the
handler. The SIGTERM latch would fire twice, releasing the lock
twice (second call is a no-op per `releaseLock`'s `try/catch` at
L162), calling `closeIngestDb()` twice (second call is a no-op per
`if (db)` at L226), and `process.exit(0)` twice (second call is a
no-op in Node but produces a misleading log entry).

**Concrete failure scenario.** A test imports `channel-coordinator.ts`
twice with `vi.resetModules()` between imports (a pattern documented
in `01 §8` as the "double-init" hazard). The first import installs
the SIGTERM handler at module init (because the L435 entry-point
guard fires only when the file is the entry point, but the handler
registration happens at `main()` time, which the guard prevents).
Wait — the entry-point guard prevents this scenario in tests because
`main()` is never called. **The realistic double-register hazard
occurs only in production**, when `main()` runs twice (HMR, a
manually-invoked `node dist/channel-coordinator.js` while the
launchd-managed one is still alive, or an OOM-kill + auto-restart
that races the prior process's exit). Each scenario is rare but
non-zero.

**Mitigation.** Per `03-class-boundaries.md §G4 / §G5` and
`05-refactor-roadmap.md §G.5`: **keep `installSignalHandlers` as a
free function** with a `process.listenerCount('SIGTERM')` guard at
the top:

```ts
function installSignalHandlers(coordinator: ChannelCoordinator): void {
  if (process.listenerCount('SIGTERM') > 0) return   // idempotent guard
  // ...L408-419 body, capturing coordinator via closure...
}
```

This is the safer alternative to a class-method form because:
(a) the guard is at module-init time, not method-call time, so it
catches both test re-entry AND production double-invocation; (b) the
free function captures the singleton via closure, identical to the
E.1 `PortLockAcquirer` precedent at
`e-process-lock/03-class-boundaries.md:42`.

**Detection signal:**

- Unit test: `installSignalHandlers` called twice in the same process
  produces exactly 1 listener (not 2) on `'SIGTERM'` and `'SIGINT'`.
  Assert `process.listenerCount('SIGTERM') === 1` and
  `process.listenerCount('SIGINT') === 1` after 2 calls.
- Integration test: SIGTERM in a test-launched coordinator triggers
  the `stopping = true` latch exactly once (verified by a single
  `logger.info` call to `'channel-coordinator: shutting down'` at
  L411).

---

## GR2 — Race between `stop()` and `runLoop()` over the 4 mutable lets

**Where it bites.** Per `01 §1.2`, the 4 mutable lets at
`channel-coordinator.ts:101-106` (`state`, `downStreak`, `stopping`,
`nativeConfirmedUpUntil`) are read AND written from `runLoop` (L311-403)
8 times within the `while (!stopping)` body. After class extraction
to `LivenessTracker` (G.3), these become 4 private fields on a single
class instance. The `installSignalHandlers.onSignal` (L407-420) sets
`stopping = true` and schedules a 3-second `setTimeout` that calls
`releaseLock() + closeIngestDb() + process.exit(0)`.

**Concrete failure scenario.** A SIGTERM arrives at L408. The handler
sets `stopping = true` (L410) and schedules the 3-second drain. Inside
the 3-second window, `runLoop` is in the middle of `await
getUpdates(token, getOffset(SOURCE) + 1, LONGPOLL_TIMEOUT_SEC,
POLL_LIMIT)` at L362 — a 30-second long-poll. The loop's `while
(!stopping)` check at L313 does NOT fire until the `await` returns.
The SIGTERM handler fires, but `process.exit(0)` is queued for 3
seconds later. If `getUpdates` returns within 3 seconds, `runLoop`
exits the await, sees `stopping = true`, exits the `while`, and the
SIGTERM timer's `process.exit(0)` fires.

**The 3-second window is by design** (per `channel-coordinator.ts:412`:
"`setTimeout(..., 3000)`" before exit). If `getUpdates` is still in
flight at the 3-second mark, `process.exit(0)` interrupts the await,
which leaves the `poll_offset` UPSERT at L401 unwritten. On the next
launch, Telegram re-delivers the in-flight batch — at-least-once, deduped
by the `(source, update_id)` unique index at `ingest.ts:58`. This is
the documented "no-message-loss" invariant per the file-level comment
at L262-269.

After class extraction, the race is **structurally identical** — the
JS event loop is single-threaded, and `this.liveness.stopping` is a
plain boolean read by both `runLoop`'s `while` check and the SIGTERM
handler. There is no multi-threaded race.

**Mitigation.**

- The class form preserves the exact 3-second drain window via
  `this.stop()` (which schedules the timer). The drain timer is a
  private field on the orchestrator, not a module-level `setTimeout`
  handle, so re-running `start()` would create a fresh timer.
- The `LivenessTracker.setStopping()` method (G.3) is idempotent:
  the SIGTERM handler does `if (liveness.setStopping()) { … }` so
  only the FIRST signal triggers the 3-second drain; subsequent
  signals are no-ops.
- Per `01 §1.2`: "the simplest design that solves the problem is the
  right one" — collapsing the 4 lets to 4 private fields of one class
  is the minimal change that preserves the race-free invariant.

**Detection signal:**

- Unit test: SIGTERM during a long-poll (mock `getUpdates` to sleep
  5 seconds) triggers `process.exit` at exactly the 3-second mark,
  not before, not after (assert with a `vi.useFakeTimers()` test).
- Integration test: `coordinator.start()` followed by `.stop()` does
  NOT raise an unhandled-rejection on the in-flight `runLoop`
  promise. The drain timer cleans up the await.

---

## GR3 — `TelegramApiError` migration: `kind` discriminator survives the ChannelProvider class migration

**Where it bites.** `TelegramApiError` at
`channel-coordinator/telegram-client.ts:45-54` is the only error class
in G (one of the 9 existing error classes per
`review-completeness.md` CE-1). Its `kind: 'fatal' | 'rate_limit' |
'conflict' | 'transient'` discriminator drives control flow at 5
sites in `channel-coordinator.ts:335, 338, 366, 372, 378`.

After G.4 (`ChannelCoordinator` class extraction), these 5 sites
become:

```ts
if (err instanceof TelegramApiError && err.kind === 'fatal') { … }
// ...
if (err instanceof TelegramApiError && err.kind === 'conflict') { … }
// etc.
```

The `instanceof` checks keep working unchanged as long as
`TelegramApiError` is the same class. The D.4 `TestRunMarkingDecorator`
at `d-channel-provider/03-class-boundaries.md §D4` is a
`ChannelProvider` decorator that wraps `sendMessage` etc. — it does
NOT throw `TelegramApiError` (the decorator's `sendMessage` forwards
to `this.inner.sendMessage` which throws whatever the underlying
provider throws, e.g. a Slack API error). So D.4 does not affect G's
TelegramApiError usage.

**Concrete failure scenario.** If H.4 (`AppError` base class) lands
before G and a careless executor migrates `TelegramApiError` to
`extends AppError`, the `instanceof TelegramApiError` checks still
work (because `AppError` is inserted ABOVE the concrete classes, not
in place of them, per `h-cross-cutting/03-class-boundaries.md:316-321`).
But if someone splits `TelegramApiError` into a subclass per `kind`
(rejected in `h-cross-cutting/03-class-boundaries.md:307-311` per
`review-completeness.md` OE-1/OE-2), the 5 sites break because:

- `err.kind === 'fatal'` is no longer a discriminator on the parent
  class — it's a property of the subclass.
- `instanceof TelegramApiError` returns `true` for ALL subclasses,
  but `instanceof TelegramFatalError` returns `true` only for the
  fatal subclass.

The runtime check `if (err instanceof TelegramApiError && err.kind === 'fatal')`
becomes `if (err instanceof TelegramFatalError)` after the split,
which is correct but requires touching all 5 sites.

**Mitigation.** Per `h-cross-cutting/03-class-boundaries.md:305-311`,
`TelegramApiError` is deferred longest: "its `kind` discriminator is
read at five sites in `channel-coordinator.ts` and it is the only
class whose payload drives control flow, so its conversion carries
the most risk for the least gain." The G migration must:

- **NOT split** `TelegramApiError` into subclasses per `kind`. Per
  `review-completeness.md` OE-1/OE-2, sealed-class discimination
  proposals are rejected when the source is already a discriminator
  on a single class.
- **NOT rename** `TelegramApiError` to `TelegramClientError` or
  similar. The 5 `instanceof` sites import the symbol by name;
  renaming breaks them.
- **NOT move** `TelegramApiError` out of `telegram-client.ts` (e.g.
  into a new `errors.ts`). The 5 sites do `import { TelegramApiError
  } from './channel-coordinator/telegram-client.js'`; moving the
  class requires updating all 5 imports.

**Verification before G.4 lands:**

- `grep -rn "instanceof TelegramApiError" src/ --include='*.ts'` returns
  exactly 5 hits (the 5 sites in `channel-coordinator.ts`).
- `grep -rn "import.*TelegramApiError" src/ --include='*.ts' | grep -v __tests__`
  returns exactly 1 hit (`channel-coordinator.ts:36`).

**Detection signal:**

- `bun --bun vitest run src/__tests__/channel-coordinator-telegram-client.test.ts`
  passes (the test file exercises `TelegramApiError` directly).
- `bun --bun vitest run src/__tests__/channel-coordinator.test.ts`
  passes (the test file exercises the 5 `instanceof` sites via
  `runLoop` mock-driven scenarios per `channel-coordinator-runloop-extra.test.ts`).

---

## GR4 — `ChannelCoordinator` lifecycle: singleton vs per-request

**Where it bites.** The G.4 `ChannelCoordinator` class has a single
production caller: `main()` at `channel-coordinator.ts:422-431`. The
dashboard's `App` (D.3) does NOT instantiate it because the
coordinator is a SEPARATE PROCESS per `01 §10`. The class is
constructed once per process, holds the 4 mutable fields (via
`LivenessTracker`), the SIGTERM handlers (via the captured closure),
and the PID lock.

**Concrete failure scenario.** If an executor mistakenly adds
`ChannelCoordinator` to the dashboard's `App` (D.3) constructor — e.g.,
to "share the liveness tracker with the dashboard's
`channel-monitor.ts`" — the class would be constructed at dashboard
boot, which runs in the dashboard process, not the coordinator
process. The `acquireSingleInstanceLock()` (L142-157) would fail at
L151 with `process.exit(1)` because the coordinator process holds
the PID lock at `STATE_DIR/coordinator.pid`. **The dashboard would
crash at boot.**

**Mitigation.** Per `00-summary.md §Dependency` and `01 §11`: G has
zero coupling with the dashboard's `App` (D.3). The coordinator
process is independent. The class form preserves this:

- `App` (D.3) does NOT take a `ChannelCoordinator` instance.
- `index.ts` (the dashboard) does NOT import
  `src/channel-coordinator.ts`.
- `ChannelCoordinator` is constructed ONLY inside the entry file's
  `main()` (which itself runs only when the L435 entry-point guard
  passes).

Per `b-config/00-summary.md` "Config" precedent and the
`e-process-lock/03-class-boundaries.md:42` `PortLockAcquirer(ctx, opts?)`
precedent: classes are constructed at app boot and passed via DI.
G follows the same pattern within its own process scope — the
constructor takes `opts` (per `03-class-boundaries.md §G4`), the
single construction site is `main()`.

**Detection signal:**

- `grep -rn "ChannelCoordinator" src/ --include='*.ts' | grep -v __tests__`
  after G.4 lands returns exactly 1 hit (the `new ChannelCoordinator(...)`
  call in `main()`).
- `grep -rn "from ['\"]\\.\\./channel-coordinator['\"]" src/web/ --include='*.ts'`
  returns 0 hits (the dashboard's web/ tree does NOT import the entry file).

---

## GR5 — `vi.mock('../channel-coordinator/...')` patterns: 5 sites across 4 files

**Where it bites.** Per `01 §11.4` (verified 2026-08-30):

| Mocked module | Sites | Files |
|---|---:|---|
| `vi.mock('../channel-coordinator.js')` (the entry file) | 0 | n/a |
| `vi.mock('../channel-coordinator/telegram-client.js')` | 0 | n/a |
| `vi.mock('../channel-coordinator/ingest.js')` | 1 | `messages-routes.test.ts:101` (substitutes `COORDINATOR_AGENT_ID`) |
| `vi.mock('../channel-coordinator/liveness.js')` | 4 | `channel-monitor.test.ts:259`, `channel-monitor-baseline.test.ts:222`, `channel-monitor-coverage.test.ts:243`, `schedule-mcp-precheck-full.test.ts:80` |

Total: **5 `vi.mock` sites across 4 files**, vs the framework M3
"17 mocks for channel-provider" cited in `01 §11.4` (channel-coordinator
has 70% fewer mocks because it is a single-process runner, not a
per-call provider).

**Concrete failure scenarios:**

- (a) The 1 `ingest.js` mock site at `messages-routes.test.ts:101`
  substitutes `COORDINATOR_AGENT_ID` only. If G.2 moves the const to
  `IngestWorker.COORDINATOR_AGENT_ID` and the free-function export
  becomes `export const COORDINATOR_AGENT_ID =
  IngestWorker.COORDINATOR_AGENT_ID`, the mock factory must update
  its shape to either return `COORDINATOR_AGENT_ID` directly (the
  existing pattern) or return `{ default: { COORDINATOR_AGENT_ID } }`
  (a class-aware variant). The first pattern survives unchanged;
  the second requires a 1-line test update.
- (b) The 4 `liveness.js` mock sites substitute `getClaudePidForSession`,
  `hasChannelPluginAlive`, `probeChannelPluginLiveness`. Per
  `01 §Per-file inventory`, these are the 3 most-imported functions
  in `liveness.ts`. The class form leaves these as FREE FUNCTIONS
  (per `03-class-boundaries.md §G3` "Free functions that REMAIN"), so
  the mock pattern works unchanged.
- (c) The 11 dedicated `channel-coordinator-*.test.ts` files do NOT
  mock the entry file — they exercise free functions directly. Per
  `01 §11.3`, this is the contract that lets the L435 entry-point
  guard prevent `main()` from running when the file is imported. After
  G.4, the tests must construct class instances via test factories;
  the entry-point guard still prevents `main()` from running (because
  `main()` is still a free function called only inside the guard).

**Mitigation.**

- G.1 (`TelegramClient` extraction) introduces ZERO new mocks — the
  class is additive, and `channel-coordinator-telegram-client.test.ts`
  exercises the free functions unchanged.
- G.2 (`IngestWorker` extraction) requires a 1-line update at
  `messages-routes.test.ts:101` IF the test mock shape changes from
  `{ COORDINATOR_AGENT_ID: ... }` to `{ default: { COORDINATOR_AGENT_ID } }`.
  The recommended pattern is to keep the const export flat (no
  `default` wrapper), so the existing mock continues to work.
- G.3 (`LivenessTracker` extraction) introduces ZERO new mocks —
  `liveness.ts` is untouched.
- G.4 (`ChannelCoordinator` extraction) requires 11 test-file rewrites
  in G.8 (the free-function removal phase), but the rewrites use the
  test-factory pattern from `review-completeness.md` CE-5, NOT
  `vi.mock` (the factories construct real class instances with mocked
  dependencies).

**Detection signal:**

- `grep -rn "vi.mock.*['\"]\\.\\./channel-coordinator" src/__tests__/ --include='*.ts'`
  returns exactly 5 sites (the same 5 documented above). Any
  increase indicates a migration regression.
- All 11 `channel-coordinator-*.test.ts` files compile and pass
  after G.8 lands.

---

## GR6 — Dependency wiring: 5+ constructor params on `ChannelCoordinator`

**Where it bites.** Per `03-class-boundaries.md §G4`, the
`ChannelCoordinator` constructor takes 9 parameters:
`session, provider, stateDir, token, pidFile, notifyScript,
telegram, ingest, liveness, registry, log`. That's 11 parameters
total — above the 5+ threshold cited in the task brief.

**Concrete failure scenario.** A test that constructs
`new ChannelCoordinator(...)` with a typo in the 6th argument (e.g.,
`pidFile` vs `notifyScript`) would silently mis-wire the class: the
PID lock dance would target the wrong file, or the alert would go to
the wrong script. TypeScript catches type-mismatches but not
argument-order mistakes (the brief argues for a deps-bundle).

**Mitigation.** Per `03-class-boundaries.md §G4` "Constructor"
section: the `opts` parameter is a SINGLE object, not 11 positional
args. The TypeScript signature is:

```ts
constructor(opts: {
  session: string
  provider: ChannelProviderType
  stateDir: string
  token: string
  pidFile: string
  notifyScript: string
  telegram: TelegramClient
  ingest: IngestWorker
  liveness: LivenessTracker
  registry: ChannelProviderRegistry
  log: LoggerLike
})
```

Argument-order mistakes are caught by the property name (TypeScript
checks the shape). The `b-config/00-summary.md` precedent (Config
class with 58 readonly fields + factory) and the
`e-process-lock/03-class-boundaries.md:42` precedent
(`PortLockAcquirer(ctx, opts?)`) both justify the deps-bundle
pattern. The cost is one extra level of nesting at the construction
site; the benefit is compile-time shape validation.

**Detection signal:**

- TypeScript compile error on a missing field (e.g., `new
  ChannelCoordinator({ session, provider, … })` without `log` fails
  to compile).
- A unit test that constructs the class with `{}` (empty opts) fails
  with a clear "missing required field" error, not a runtime
  `undefined.foo` crash.

---

## GR7 — `TelegramClient` network state: error retry, backoff, and connection lifecycle

**Where it bites.** Today `getUpdates` (L143-190) and `probeHighWater`
(L201-226) throw `TelegramApiError` on every failure mode (network,
5xx, 429, 409, 401). The retry/backoff logic lives in `runLoop`
(L362-385): 429 sleeps `retryAfterSec`, transient sleeps
`transientBackoffMs(attempt)`, conflict yields to idle + sets the
cooldown, fatal exits the process. The state is held in
`runLoop`'s local `transientAttempt` (L312) + the module-level
`nativeConfirmedUpUntil` (L106) + `state`/`downStreak`.

**Concrete failure scenario.** After G.1 + G.4, the retry logic is
distributed across:

- `TelegramClient.getUpdates(...)` — throws `TelegramApiError`.
- `TelegramClient.probeHighWater(...)` — throws `TelegramApiError`.
- `ChannelCoordinator.runLoop()` — catches and dispatches on `err.kind`.

If `TelegramClient` becomes a "smart" client that handles its own
retry internally (a tempting abstraction), the dispatch logic in
`runLoop` becomes ambiguous: when does the client stop retrying and
signal the caller? The brief recommends the OPPOSITE — keep the
client dumb (throw on first failure), keep the retry dispatch in
`runLoop`. This is the current behavior.

After class extraction, the question is: where does the
`AbortController` + `setTimeout` pair live? Today it's per-call
inside `getUpdates`/`probeHighWater` (created at L149 / L202,
cleared in `finally` at L163 / L215). The class form keeps the
per-call `AbortController` (the methods are stateless), so no
long-lived timers leak across re-init.

**Mitigation.**

- `TelegramClient` is **stateless** (per
  `d-channel-provider/00-summary.md` precedent): no instance fields,
  no constructor-stored state, no `close()` method. The `AbortController`
  is created per-call inside `getUpdates`/`probeHighWater`.
- Retry/backoff dispatch stays in `ChannelCoordinator.runLoop()`
  (G.4). The class form does NOT introduce retry helpers on
  `TelegramClient`.
- A future HMR scenario where the class is re-imported mid-flight is
  handled by the per-call `AbortController`: each call gets a fresh
  controller, so an HMR-triggered module re-evaluation does not leak
  timers (the in-flight `getUpdates` continues to its `await`, the
  controller is cleared in `finally`).

**Detection signal:**

- A load test that fires 1000 `getUpdates` calls in parallel and
  verifies the process does not have > 1000 active timers (via
  `process._getActiveHandles()` or equivalent).
- A unit test that constructs `new TelegramClient(mockEnv, mockDb,
  mockLog)` and calls `getUpdates` with a mock fetch that rejects
  after 100ms — the method throws `TelegramApiError('transient', …)`
  within 100ms (no leak).

---

## GR8 — Shutdown order in `ChannelCoordinator.stop()` vs the framework M11 verified order

**Where it bites.** Per `review-correctness.md` M11, the framework's
documented shutdown order is "fabricated" — the actual order in
`src/index.ts:378-410` is:

```
stopHeartbeat()
stopInviteMonitor()
stopChannelRequestWatcher()
stopStoreWatcher()
clearInterval(decayInterval)
clearTimeout(digestTimer)
clearInterval(digestInterval)
webServer.close(... releaseLock())
```

The coordinator is NOT in this list because it runs as a SEPARATE
PROCESS — `index.ts` does not call any channel-coordinator functions.
The coordinator's own shutdown sequence is internal to
`channel-coordinator.ts:407-431`:

1. SIGTERM/SIGINT arrives at `onSignal` (L408).
2. `stopping = true` (L410).
3. `setTimeout(..., 3000)` schedules the drain (L412-415).
4. After 3 seconds (or sooner if `runLoop` exits the await on
   `while (!stopping)`): `releaseLock()` + `closeIngestDb()` +
   `process.exit(0)`.

After G.4, this becomes `coordinator.stop()`:

```ts
async stop(): Promise<void> {
  this.liveness.setStopping()
  this.drainTimer = setTimeout(() => {
    this.ingest.close()
    this.releaseLock()      // private method, was L159-163
    process.exit(0)
  }, 3000)
  // Wait for runLoop to exit (it checks this.liveness.isStopping())
  await this.runLoopPromise
}
```

**Concrete failure scenario.** The G.4 `stop()` is async (returns a
Promise that resolves when `runLoop` exits), but the original SIGTERM
handler is sync (returns `void`). The 3-second drain timer is the
boundary. If the executor mistakenly makes `stop()` call
`process.exit(0)` synchronously (without the 3-second wait), the
`runLoop` await is interrupted mid-flight, leaving the
`poll_offset` UPSERT unwritten. This is the at-least-once recovery
path per the file-level comment at L262-269, so message delivery
is preserved, but the **next launch will re-deliver the in-flight
batch** — a small inefficiency, not a correctness bug.

**Mitigation.**

- `stop()` keeps the exact 3-second drain window as today (per
  `03-class-boundaries.md §G4` and `05-refactor-roadmap.md §G.4`).
- The class form exposes `stop()` for test cleanup (test factories
  can `await coordinator.stop()` to wait for the drain).
- In production, the SIGTERM handler does NOT await `stop()` — it
  schedules the drain timer (per the L412 pattern). The 3-second
  window is a hardcoded constant (per `channel-coordinator.ts:412`)
  that survives the class extraction unchanged.
- The `liveness.setStopping()` idempotency guard (G.3) ensures that
  a second SIGTERM during the drain is a no-op (no double drain).

**Detection signal:**

- A unit test that constructs a coordinator, starts it, sends a
  SIGTERM, and verifies the drain logic is invoked exactly once.
- An integration test that verifies the `poll_offset` UPSERT at
  `channel-coordinator.ts:401` happens BEFORE `process.exit(0)` (or,
  if interrupted, the next-launch `getUpdates` correctly resumes from
  the prior `lastUpdateId`).
- A static check: `grep -nE "process\\.exit\\(" src/channel-coordinator.ts`
  returns the same number of hits after G.4 as before (currently 4:
  L151, L306, L415, L439 per `01 §Per-file inventory`).

---

## Cross-references

- `01-module-state-analysis.md §Per-file inventory` — file-level
  state inventory for G's 4 files
- `01-module-state-analysis.md §Per-file inventory` — test mock counts
  (5 sites across 4 files)
- `h-cross-cutting/00-summary.md §Top 3 risks` — `LoggerLike`
  call-signature risk (relevant to G.7)
- `h-cross-cutting/03-class-boundaries.md §C3` — `TelegramApiError`
  deferral decision
- `b-config/00-summary.md §Top 3 risks` — config-bundle pattern
  precedent for GR6
- `e-process-lock/00-summary.md §Shutdown` — process-lock ordering
  precedent for GR8
- `e-process-lock/03-class-boundaries.md:42` — `PortLockAcquirer(ctx, opts?)`
  DI-bag precedent for GR6
- `d-channel-provider/00-summary.md` — stateless provider precedent
  for GR7
- `d-channel-provider/03-class-boundaries.md §D4` — `TestRunMarkingDecorator`
  decision (does NOT throw TelegramApiError; GR3 cross-reference)
- `a-db/00-summary.md §DECAY SWEEP` — cross-entity aggregator
  precedent (informational only; G has no decay sweep)
- `review-correctness.md` CE-1 (9 existing classes including
  TelegramApiError), CE-2 (web/federation subdir), C1 (ChannelProvider
  statelessness), M11 (shutdown sequence), m9 (4 mutable lets +
  1 const PID_FILE)
- `review-completeness.md` OE-1/OE-2 (sealed-class rejection), OE-6
  (generic rejection), CE-5 (test factory pattern)

---

**End of G risks-and-mitigations plan. No source files modified.**
