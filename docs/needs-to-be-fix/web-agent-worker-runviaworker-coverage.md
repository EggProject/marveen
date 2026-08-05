# agent-worker: runViaWorker / runWorkerAttempt / ensureWorkerReady integration paths lack 100% unit-test coverage

File: src/web/agent-worker.ts (lines ~561-751: ensureWorkerReady, runWorkerAttempt, runViaWorker inner loop)

Test file: src/__tests__/web-agent-worker.test.ts

Current coverage: ~53% (151/282 statements). All non-`runViaWorker` paths are
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

Recommended remediation (do NOT apply as part of this test commit):

A. Export the private helpers from `src/web/agent-worker.ts` (or move them
   to a new `_internals.ts` module) so they can be unit-tested directly
   without the integration loop.

B. OR refactor the polling loop to accept an injectable clock + file-system
   reader, so the test can drive it with no setTimeout at all (pure
   function over (doneExists, sessionAlive, elapsedMs) inputs).

C. OR drop the 100% threshold for files whose integration is exercised by
   the heartbeat-driven live-agent path, and document that coverage gap.
   The pure-export contract (already covered) is what callers depend on;
   the integration is best tested by the live worker.

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