# channel-coordinator.ts: internal state-machine functions are not unit-testable

## Location

`src/channel-coordinator.ts`, lines 117-441:

* `readToken` (private, lines 117-136)
* `acquireSingleInstanceLock` (private, lines 142-157)
* `releaseLock` (private, lines 159-163)
* `sendAlert` (private, lines 170-175)
* `processBatch` (private, lines 233-258)
* `reconcilePending` (private, lines 270-298)
* `fatalExit` (private, lines 302-307)
* `runLoop` (private, lines 311-403)
* `installSignalHandlers` (private, lines 407-420)
* `main` (private, lines 422-431)
* bottom-of-file entry-point guard (lines 435-441)

## Excerpt

```ts
// channel-coordinator.ts lines 29-441 -- private, not exported.
import { ... }
const SOURCE = 'telegram'
function readToken(): string { ... }
function acquireSingleInstanceLock(): void { ... }
function releaseLock(): void { ... }
function sendAlert(message: string): void { ... }
export function neutralizeChannelTags(...) { ... }   // <-- only pure exports
export function buildHandoffContent(...) { ... }
export function transientBackoffMs(...) { ... }
export function inNative409Cooldown(...) { ... }
const sleep = (ms: number) => new Promise(...)
function processBatch(updates) { ... }
function reconcilePending(): void { ... }
async function fatalExit(err) { ... }
async function runLoop(token) { ... }                 // <-- internal state machine
function installSignalHandlers(): void { ... }
async function main(): Promise<void> { ... }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { ... })
}
```

The only exports are the four pure helpers (`inNative409Cooldown`,
`neutralizeChannelTags`, `buildHandoffContent`, `transientBackoffMs`).
Everything else -- the lock, the runLoop state machine, the alert path,
the signal handlers -- is internal state that can only run when the
entry-point guard fires `main()`.

## Failure scenario

1. Coverage gate fails on `src/channel-coordinator.ts`. The 4 exported
   pure helpers plus the `ingest.ts` sub-module cover ~46% of lines in
   the file but the runLoop / lock / signal-handler / fatalExit paths
   are unreachable without exercising `main()`.

   **Measured 2026-08-26 (flag-free run, 11 test files passed, 0
   failures):** the gate is GREEN. `src/channel-coordinator.ts`
   reports 100% lines (160/160), 100% branches (117/117), 100%
   functions (22/22), 100% statements (187/187). The unreachable
   branches feared in this MD did not remain unreachable: every
   internal listed under `## Location` is now exercised by at least
   one dedicated test file. This item is RESOLVED in the Resolution
   section below.

2. **The entry-point guard forces only-one execution model.** The
   `import.meta.url === pathToFileURL(process.argv[1]).href` gate means
   `main()` runs only when the file is the script entry point. Test
   imports (vitest + `await import('../channel-coordinator.ts')`)
   never match the gate, so the internal functions -- even when fully
   reachable from outside -- are no-ops during unit-test imports.

3. **Historical concern: tests that trigger main() via the
   entry-point trick scale poorly.** Setting `process.argv[1]` to
   the module's file URL plus `vi.doMock` of every dependency plus a
   `process.exit` spy lets a single ~10s test drive the lock +
   signal-handler + at least one tick of the runLoop. The 2026-08-07
   test commits split the suite across 9 channel-coordinator test
   files (vitest runs each file in its own worker) and seven of them
   use `vi.useFakeTimers` + `vi.advanceTimersByTimeAsync` to skip the
   `TICK_MS=5000` waits, so each branch is exercised in milliseconds
   rather than seconds. With that scaling, the originally feared ~26s
   OOM in a 12-test suite did NOT materialise: the 9 files today run
   green in a few seconds and the gate is at 100%. The concern was a
   real one when this MD was first drafted; the workaround that
   defeated it is documented in the Resolution section below.

4. **Child-process isolation would isolate heap pressure but loses
   in-process mock control.** Spawning `node src/channel-coordinator.ts`
   would let the runLoop live in its own process, but the runLoop
   reaches into `process.exit`, `execFile` (notify.sh) and
   `better-sqlite3` (ingest.ts) -- all of which need real behaviour
   for the side effects under test (pid file deletion on SIGTERM,
   WAL-mode DB creation on startup). Mocks only work in the same
   module registry as the test.

## Observed impact

* **Coverage gate.** Measured 2026-08-26 (flag-free run, 11 test files
  passed, 0 failures) on `src/channel-coordinator.ts`: 100% lines
  (160/160), 100% branches (117/117), 100% functions (22/22),
  100% statements (187/187). Required: 100% per the project default.
  The gate is GREEN as of the test commits `a33dc73` and `8ea57ba`
  (2026-08-07). The 46% / 77% / 42% / 34% figures quoted in the
  previous version of this MD were never re-measured after those
  commits landed; see Resolution section below for the timeline.
* **No runtime defect.** The lock, runLoop and signal-handler paths
  work in production (verified by the launchd smoke tests). The
  untestability concern was a code-organisation question, not a
  behavioural one.
* **`main().catch()` and the bottom-of-file entry-point guard are
  testable via the entry-point-trick tests.** Each test sets
  `process.argv[1]` to the module's file URL and dynamically imports
  the source so the guard fires. The catch handler on a `readToken`
  throw is covered by the entry-point integration tests listed in
  the Pinning test section below.

## Pinning test

The pinning surface for `src/channel-coordinator.ts` is spread across
nine dedicated test files in `src/__tests__/` (vitest runs each file
in its own worker, so no single worker accumulates the leaked timers
the historical concern in Failure scenario item 3 warned about):

* `src/__tests__/channel-coordinator.test.ts` -- the 4 pure helpers
  (every branch: operator precedence, empty input, defaults,
  quote-stripping, fallback `(empty message)`), plus the entry-point
  integration path for the lock + signal-handler + main() bootstrap
  + main() crash path on a `readToken` throw.
* `src/__tests__/channel-coordinator-ingest.test.ts` -- the
  `ingest.ts` sub-module via in-memory `better-sqlite3`: dedup,
  status transitions, offset UPSERT, reconcile, `markEventFailed`,
  singleton handle.
* `src/__tests__/channel-coordinator-process-batch.test.ts` --
  `processBatch` branches (mapUpdate null, insert throws, dedup,
  happy, handoff throws).
* `src/__tests__/channel-coordinator-reconcile.test.ts` --
  `reconcilePending` branches (query error, happy path, JSON.parse
  catch, createHandoffMessage throw).
* `src/__tests__/channel-coordinator-runloop-extra.test.ts` --
  `runLoop`'s idle->backfill seed error branches (fatal->sendAlert,
  conflict->cooldown, transient->warn) and the backfilling branches
  (yield-to-native, empty-batch loop, yield-before-handoff, inner
  break on stopping, getUpdates fatal / conflict / rate_limit /
  transient).
* `src/__tests__/channel-coordinator-lock.test.ts` --
  `acquireSingleInstanceLock` + `releaseLock` branches,
  `installSignalHandlers` behaviour, `main()` cleanup path.
* `src/__tests__/channel-coordinator-lock-live-pid.test.ts` --
  `acquireSingleInstanceLock` live-pid branch (when the PID file is
  held by a live other process, the coordinator logs and exits 1).
* `src/__tests__/channel-coordinator-bootstrap-extra.test.ts` --
  `readToken` branches (env + .env + quote-stripping + throw),
  transient seed error path, down-streak-reset path.
* `src/__tests__/channel-coordinator-full.test.ts` -- the channel-
  coordinator core coverage: live-pid, `reconcilePending`,
  idle->backfill success / hw-null, and the entry-point catch
  handler.

Two further files share the `channel-coordinator-` prefix but target
SIBLING modules, not the SUT: `channel-coordinator-liveness.test.ts`
covers `src/channel-coordinator/liveness.ts`; `channel-coordinator-
telegram-client.test.ts` covers `src/channel-coordinator/telegram-
client.ts`. They contribute nothing to `src/channel-coordinator.ts`
coverage and are listed here only so the prefix-match does not
misdirect the reader.

All reachable code under the four pure exports + ingest sub-module +
every internal listed in `## Location` is covered. The state machine
(idle -> BACKFILLING -> yield, every branch of `processBatch`, every
branch of `runLoop`'s error classification, `fatalExit` triggered
by every fatal-error origin, every branch of `reconcilePending`,
the cooldown-seeding branches, the lock / signal-handler / live-pid
/ readToken paths) IS reachable from these test files WITHOUT any
source modification to `src/channel-coordinator.ts`. The
`__test_*`-prefix suggestion below was deliberately NOT applied --
see the Resolution section for why.

## Suggested direction

Two acceptable resolutions (in order of preference):

1. **Export the internals behind test-only names.** Add `export
   function __test_runLoop(token)`, `export function
   __test_processBatch(updates)`, `export function
   __test_readToken(...)`, etc. The test file imports these directly
   and drives each path with mocked dependencies. No behavioural
   change; the names' `__test_` prefix signals "do not import in app
   code". This is the lowest-risk path to 100% coverage.

2. **Refactor `runLoop` into a pure dispatcher.** Move the state
   transitions into a pure function that takes `(state, probe,
   getUpdates, ingest, logger, sleep)` and returns the next
   `(state, actions)` tuple. `runLoop` then becomes a thin shell that
   interprets the tuple, advances `downStreak` etc. The pure decision
   function is unit-testable in milliseconds and reaches 100%
   coverage without process tricks.

The gate is GREEN as of the test commits `a33dc73` and `8ea57ba`
(2026-08-07). Measured 2026-08-26 on `src/channel-coordinator.ts`:
100% lines (160/160), 100% branches (117/117), 100% functions
(22/22), 100% statements (187/187). The `__test_*`-prefix exports
direction (suggested option 1 above) was deliberately NOT applied
because the measurement shows there is no uncovered code to reach:
applying it would be pure churn with zero coverage gain. The
runLoop refactor direction (suggested option 2 above) is similarly
moot -- there is nothing left to refactor toward. See the
Resolution section below for the timeline and the rationale.

## Resolution (2026-08-26, dbc25ab)

The gate is GREEN. Measured 2026-08-26 (flag-free run, 11 test files
passed, 0 test failures) on `src/channel-coordinator.ts`: 100%
lines (160/160), 100% branches (117/117), 100% functions (22/22),
100% statements (187/187). Coverage was reached by the test commits
`a33dc73` ("test(channel-coordinator): reach 100% line coverage,
99.15% branch") and `8ea57ba` ("fix(test): kill the last 2 live-
install leaks + accept empty store/"), both dated 2026-08-07.

The MD figures (46% lines / 77% functions / 42% statements / 34%
branches) quoted in the previous version of this file were never
re-measured after those commits landed. The file's last touch,
`e399a96` ("docs(needs-to-be-fix): scope-correct 87 NEVER-modify
claims as baseline-cycle only", 2026-08-25), only appended the
bulk scope note at the bottom across all 87 needs-to-be-fix MDs; it
did not re-run the coverage measurement. This commit is the first
re-measurement since `a33dc73` / `8ea57ba`.

The `__test_*`-prefix exports direction (suggested option 1 under
`## Suggested direction` above) was deliberately NOT applied: the
measurement shows there is no uncovered code left to reach, so
adding `__test_*` shims would be churn with zero coverage gain
and would force every test to import the source via a
deliberately-leaky API surface. The pure-dispatcher refactor
(suggested option 2) is similarly moot -- there is nothing left to
refactor toward. Both options are preserved in this MD as
historical context for why the question was raised; neither should
be implemented now.

`src/channel-coordinator.ts` was NOT modified as part of this
resolution. The 100% coverage is achieved purely by the nine test
files enumerated in `## Pinning test` above driving the existing
entry-point guard via `vi.doMock` + fake timers + per-file vitest
workers.

One test defect surfaced during the measurement and was fixed in
the same batch: `src/__tests__/channel-coordinator.test.ts` line
552 previously called `process.kill(...)` directly, which the
global forbid in `src/__tests__/setup/forbid-system-calls.ts`
blocks unless `MARVEEN_TEST_ALLOW_PROCESS_KILL=1` is set. Under the
CI command `bun run coverage` the env flag is unset, so the test
failed. It now uses `process.emit('SIGTERM')` -- the pattern the
sibling `src/__tests__/channel-coordinator-lock.test.ts` already
uses at lines 235, 256, 275, 293, 312 and 313 --
which the forbid hook does not intercept (it only intercepts
`process.kill`, not arbitrary event emission on the global process
object). The test's behaviour under the entry-point guard is
identical: `process.on('SIGTERM', ...)` listens on the same global
`process` and fires on `process.emit('SIGTERM')` exactly as it
fires on `process.kill(process.pid, 'SIGTERM')`. No other line in
`channel-coordinator.test.ts` calls `process.kill`.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
