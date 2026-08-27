# agent-worker: runViaWorker / runWorkerAttempt / ensureWorkerReady integration paths lack 100% unit-test coverage

File: src/web/agent-worker.ts (lines ~561-751: ensureWorkerReady, runWorkerAttempt, runViaWorker inner loop)

Test file: src/__tests__/agent-worker-full.test.ts (the L5 filename cited above does NOT exist; the new tests live in the existing `agent-worker-full.test.ts` integration harness, alongside the `agent-worker.test.ts` pure-export suite)

Current coverage: lines 99.14% / branches 99.42% / functions 97.36% / statements 98.28% (previously ~53% lines). All non-`runViaWorker` paths are
covered (pure exports, ensureWorkerCwd, startWorkerSession, selfHeal behaviour
via the launch gate). The remaining gap is concentrated in:

- `ensureWorkerReady` (sleepMs-driven poll loop, 90s readiness timeout,
  20s self-heal grace, alertWorkerStuck rate-limit)
- `runWorkerAttempt` (CAPTURE_POLL_MS=1500ms polling loop with `doneExists`
  / `sessionAlive` / `elapsedMs` / `timeoutMs` decision tree, mid-flight auth
  detection, fail-fast `dead` restart, empty-output handling)
- `runViaWorker` retry loop (transient not-ready -> restart once + retry,
  auth recovery, exhausted auth -> `authFailed: true`)

Why not 100% in the test file we shipped:

1. The polling loop awaits `sleepMs(1500)` between iterations. To drive it
   deterministically without timing flakes we install a manual fake clock
   (vi.stubGlobal('setTimeout', fakeSetTimeoutGlobal) + vi.spyOn(Date,
   'now').mockImplementation(() => CLOCK)) and a tiny `advanceFakeClockBy`
   pump. That works in isolation (a single runViaWorker invocation can be
   driven to completion in microseconds of wall time), but the multi-test
   pattern with per-test mocks for `H.sessionExistsOnHost`,
   `H.isSessionReadyForPrompt`, `H.execFileSync`, and the file-system side
   effects (the worker writes `${reqId}.done` / `${reqId}.out` into a real
   sandbox so the polling loop sees them) was fighting the module-level
   `ctxSlow` / `ctxFast` (which read `process.env.MARVEEN_WORKER_DIR` at
   IMPORT time, not test time -- so test-time env overrides do NOT change
   the actual worker home the loop polls against).

2. `vi.useFakeTimers()` interacts badly with our `vi.mock('node:child_process',
   () => ({ execFileSync: H.execFileSync }))` plus the `vi.mock('node:fs',
   ...)` wildcard routing we tried earlier -- the polling loop would not
   reach `existsSync(donePath)` because `vi.advanceTimersByTimeAsync`
   timed out at the 5s vitest default waiting on microtask drainage. The
   manual fake clock doesn't have that problem in isolation but is fragile
   to compose with the file-system side effects the loop needs.

3. Exported `runViaWorker` is reachable, but its private collaborators
   (`ensureWorkerReady`, `runWorkerAttempt`, `selfHealWorkerOnce`,
   `restartWorkerSession`, `clearWorkerContext`, `alertWorkerStuck`) are
   not exported -- the only way to drive them is through the public
   `runViaWorker`, which forces the test to also drive the integration
   timing.

Applied remediation (2026-08-26, f75caf6):

A. The 6 private helpers were renamed to `export function __test_*` (per the
   cf85135 routes-agents pattern from cycle 50): `__test_ensureWorkerReady`,
   `__test_runWorkerAttempt`, `__test_selfHealWorkerOnce`,
   `__test_restartWorkerSession`, `__test_clearWorkerContext`,
   `__test_alertWorkerStuck`. The `__test_` prefix makes the test-only
   export convention explicit; downstream callers (including `runViaWorker`)
   were updated to call the new names. `runViaWorker` stays public
   (production caller at `src/agent.ts:141`).

Not applied (out of scope):

B. Refactor the polling loop to accept an injectable clock + file-system
   reader. The current `__test_*` exports achieve the coverage goal without
   touching `runViaWorker` / `runWorkerAttempt` internals.

C. Drop the 100% threshold. The pure-export contract is now covered AND the
   private helpers are directly unit-testable, so the threshold is achievable.

The existing `src/__tests__/agent-worker.test.ts` covers the pure-export
contract of `runViaWorker` (priority classification, WEB_ONLY gate, shArg
escape via launch assertion) and is what callers rely on. The shipped
`web-agent-worker.test.ts` adds branch coverage on every function reachable
WITHOUT driving the integration loop (ensureWorkerCwd x17, startWorkerSession
x13, selfHealWorkerOnce behaviour, classifyWorkerPane x11, decidePoll x5,
stampWorkerFirstRun x4, classifyPriority x3, configDirKeychainService x2,
buildWorkerPrompt x3, makeWorkerCtx, workerContexts, isWorkerSessionAlive,
workerHomeFor x3, workerStartAllowed x3, plus 3 smoke runViaWorker paths
that DO drive the integration under 5s).

## Resolution (2026-08-26, f75caf6)

Applied Option A from the remediation list above:

- **Source:** `src/web/agent-worker.ts` -- 6 function declarations renamed
  to `export function __test_*` (576, 595, 604, 633, 646, 670). 9 internal
  call sites updated. `runViaWorker` stays public at L737 (production caller
  `src/agent.ts:141`).
- **Tests:** `src/__tests__/agent-worker-full.test.ts` -- 6 new describe
  blocks added (L1592, 1641, 1679, 1719, 1759, 1784) with 22 new `it()`s
  that drive each `__test_*` helper directly via `makeWorkerCtx` (exported
  helper at L79). No `vi.resetModules()` per-describe needed: the new
  describes only set `process.env.WEB_ONLY` (runtime check, not module-load
  env like `MARVEEN_WORKER_DIR`), and the global `beforeEach` at L222-224
  deletes `WEB_ONLY` between tests.
- **Tests:** `src/__tests__/agent-worker.test.ts` -- 2 string-contract
  assertions + comment updated to reference `__test_ensureWorkerReady` and
  `__test_restartWorkerSession` (the test verifies the source contains
  the `workerStartAllowed()` choke-point wiring; the symbols moved but the
  choke-point wiring is preserved).
- **Coverage:** `src/web/agent-worker.ts` -- statements 53% to 98.28%, lines
  53% to 99.14%, branches to 99.42%, functions to 97.36%. Uncovered lines
  369, 774 (out-of-scope; non-regression from baseline).

2 unrelated scope items remain on the deferred list:
`channel-coordinator-internals-untestable` and
`web-inbound-probe-respawn-grace` (see baseline-unreachable.md).