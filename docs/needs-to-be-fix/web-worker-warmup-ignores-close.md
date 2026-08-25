# web.ts: the agent-worker warm-up import has no close() cancel flag, unlike the liveness monitor

## Location

`src/web.ts`, lines 339-364 (the two dynamic imports) and line 544
(`workerLivenessCancelled = true` in the close override).

## Excerpt

The liveness monitor is guarded against a close that lands before its dynamic
import resolves:

```ts
let workerLivenessCancelled = false
if (!webOnly && (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() !== 'sdk') {
  import('./web/worker-liveness.js')
    .then(m => {
      if (workerLivenessCancelled) return
      workerLivenessInterval = m.startWorkerLivenessMonitor()
      ...
    })
}
```

The warm-up immediately above it is not, even though it is the same shape:

```ts
if (!webOnly && (process.env.MARVEEN_AGENT_BACKEND || 'worker').toLowerCase() !== 'sdk') {
  import('./web/agent-worker.js')
    .then(m => { m.startWorkerSession(); logger.info('Interactive agent worker pre-started') })
    .catch(err => logger.warn({ err }, 'Failed to pre-start agent worker (will lazy-start on first use)'))
}
```

The comment attached to `workerLivenessCancelled` states the reason the other
call sites are safe:

> The other monitors are synchronous calls and cannot hit this.

That is true of the 15 synchronous `start*()` calls, but not of
`import('./web/agent-worker.js')` -- which is the one other asynchronous
starter in the function.

## Failure scenario

1. The process boots and `startWebServer()` fires both dynamic imports.
2. Something shuts the server down before the imports resolve -- a fast SIGTERM
   after launchd `kickstart -k`, a failed boot that closes and retries, or a
   port-reclaim restart.
3. `server.close()` runs: it sets `workerLivenessCancelled = true`, so the
   liveness interval is correctly never created.
4. The agent-worker import then resolves and calls `startWorkerSession()`
   anyway, starting an interactive agent worker for a server that is already
   closed. Nothing in the shutdown path knows about it, so it is not stopped
   by the same close.

The consequence is the class of problem the liveness guard was written to
prevent (an owner-less resource created after teardown), one call site over.

## Pinning test

`src/__tests__/web-server.test.ts`:
"worker warm-up > does not start the liveness monitor when close() ran before
the import resolved" -- asserts `startWorkerLivenessMonitor` was NOT called and
then pins the asymmetry by asserting `startWorkerSession` WAS called.

If the guard is extended to the warm-up, flip that second assertion to
`not.toHaveBeenCalled()`.

## Suggested direction

Reuse the existing flag (rename it to something neutral, e.g.
`workerStartupCancelled`) and check it in the warm-up `.then()` too:

```ts
import('./web/agent-worker.js')
  .then(m => {
    if (workerStartupCancelled) return
    m.startWorkerSession()
    logger.info('Interactive agent worker pre-started')
  })
```

Whether the already-started session should additionally be stopped by
`server.close()` is a separate question for the owner of
`web/agent-worker.ts`; this report only covers the missing cancel check.

Per the task rule "NEVER modify src/web.ts" this needs an explicit override
from the user.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
