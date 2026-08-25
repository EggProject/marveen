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

2. **The entry-point guard forces only-one execution model.** The
   `import.meta.url === pathToFileURL(process.argv[1]).href` gate means
   `main()` runs only when the file is the script entry point. Test
   imports (vitest + `await import('../channel-coordinator.ts')`)
   never match the gate, so the internal functions -- even when fully
   reachable from outside -- are no-ops during unit-test imports.

3. **Tests that DO trigger main() via the entry-point trick scale
   poorly.** Setting `process.argv[1]` to the module's file URL plus
   `vi.doMock` of every dependency plus a `process.exit` spy lets a
   single 10-second test drive the lock + signal-handler + at least
   one tick of the runLoop. But:
     * `TICK_MS = 5000` means each branch (DOWN_DEBOUNCE=2 -> enter
       BACKFILLING -> seed high-water) costs ~11s of wall clock,
     * `runLoop` never exits on its own (only via SIGTERM/SIGINT
       handlers) so each test leaks the previous instance's pending
       Promise + setTimeouts onto the event loop. After ~10 tests
       vitest's worker process runs out of heap (Reproduced: OOM at
       ~26s into a 12-test suite).

4. **Child-process isolation would isolate heap pressure but loses
   in-process mock control.** Spawning `node src/channel-coordinator.ts`
   would let the runLoop live in its own process, but the runLoop
   reaches into `process.exit`, `execFile` (notify.sh) and
   `better-sqlite3` (ingest.ts) -- all of which need real behaviour
   for the side effects under test (pid file deletion on SIGTERM,
   WAL-mode DB creation on startup). Mocks only work in the same
   module registry as the test.

## Observed impact

* **Coverage gate fails.** Current `npx vitest run --coverage` for
  `src/channel-coordinator.ts`: 46% lines, 77% functions, 42%
  statements, 34% branches. Required: 100% per the project default.
* **No runtime defect.** The lock, runLoop and signal-handler paths
  work in production (verified by the launchd smoke tests). The
  untestability is a code-organisation defect, not a behavioural one.
* **`main().catch()` and the bottom-of-file entry-point guard are
  also untestable as named values.** The guard is a single line that
  runs at module top-level; unit tests that import the module do not
  observe it.

## Pinning test

`src/__tests__/channel-coordinator.test.ts` covers every reachable
testable surface today:

* 4 pure helpers -- every branch (operator precedence, empty input,
  defaults, quote-stripping, fallback `(empty message)`).
* `ingest.ts` sub-module via in-memory `better-sqlite3`: dedup, status
  transitions, offset UPSERT, reconcile, `markEventFailed`, singleton
  handle. (Lines 100% on the sub-module file; see sibling
  `ingest.ts` test.)
* Two entry-point integration tests drive main() once and once and
  cover: `readToken` (env + .env paths), `acquireSingleInstanceLock`
  (pid file write + reclaim of stale pid via mock dep),
  `installSignalHandlers` (SIGTERM releases the lock cleanly),
  `reconcilePending` (called every tick), `main()` end-to-end, the
  entry-point guard catch handler on a `readToken` throw.

All reachable code under the four pure exports + ingest sub-module +
one main() bootstrap + one main() crash path is covered. The state
machine (idle -> BACKFILLING -> yield, every branch of
`processBatch`, every branch of `runLoop`'s error classification,
`fatalExit` triggered by every fatal-error origin, every branch of
`reconcilePending`, the cooldown-seeding branches) is unreachable
without source modifications.

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

Until a resolution is chosen the branch-coverage gate (and to a
lesser degree the statement/lines/functions gates) will fail on
this file. Mark this MD as the authoritative pin and either exclude
`src/channel-coordinator.ts` from the threshold or accept the
partial coverage that the four pure exports + ingest + one
bootstrap integration test achieve (currently 46% lines / 77%
functions).

Per task rule "NEVER modify src/channel-coordinator.ts" neither fix
has been applied; the test suite is the highest achievable without
source changes.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
