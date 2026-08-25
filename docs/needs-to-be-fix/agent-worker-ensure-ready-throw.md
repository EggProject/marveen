# agent-worker.ts: ensureWorkerReady does not catch startWorkerSessionFor throws

## Location

`src/web/agent-worker.ts`, line 596 (inside `ensureWorkerReady`).

```ts
async function ensureWorkerReady(ctx: WorkerCtx): Promise<boolean> {
  if (!workerStartAllowed()) { ...; return false }
  startWorkerSessionFor(ctx)   // <-- line 596, NOT wrapped in try/catch
  const start = Date.now()
  const deadline = start + WORKER_BOOT_TIMEOUT_MS
  ...
}
```

## Excerpt

`startWorkerSessionFor` can throw -- the inner `execFileSync(TMUX,
['new-session', ...])` call (line 488) has no defensive guard. When it
throws (e.g. tmux server is down, permission denied on the home dir,
the `tryResolveFromPath('claude')` helper hits a transient PATH gap and
falls through to a bare `claude` invocation that `bash -lc` cannot
resolve), the throw propagates out of `ensureWorkerReady` and out of
`runWorkerAttempt`.

The only OTHER place `startWorkerSessionFor` is called -- inside
`restartWorkerSession` (line 622) -- DOES wrap the call:

```ts
try { startWorkerSessionFor(ctx) } catch (err) { logger.warn({ err, session: ctx.session }, 'agent-worker: restart failed') }
```

So the auth-recovery path swallows the throw and degrades gracefully;
the readiness-poll path does not.

Consequence: a transient tmux failure during a boot poll kills the
caller's request with an unhandled rejection instead of returning a
structured `{ text: null, error: '...' }`. The 4 callers of
`runAgent` (heartbeat, memory digest, schedules, scaffold) reach this
single choke point -- so one defensive try/catch protects them all.

## Failure scenario

1. A request lands during a tmux outage (server restart, OOM kill).
2. `ensureWorkerReady` calls `startWorkerSessionFor(ctx)` -- it throws.
3. `ensureWorkerReady` does NOT catch; the throw propagates.
4. `runWorkerAttempt` does NOT catch; the throw propagates.
5. `runViaWorker`'s `for` loop does NOT catch; the throw escapes the
   `withWorkerLockFor` wrapper.
6. The caller's `await runAgent(...)` rejects with the raw tmux error.

Compare with the recovery path: the same throw inside
`restartWorkerSession` is caught, logged, and the function returns
normally. The boot poll deserves the same defensive guard.

## Pinning test

`src/__tests__/agent-worker-full.test.ts`. The reachable siblings are
covered so the gap is exactly the unwrapped throw:

- `describe('restartWorkerSession (via auth-recovery retry)')` -- "warns
  and continues when the restart start throws (current behaviour: error
  propagates)" documents the contrast: the restart path catches and
  logs "restart failed"; the ensureWorkerReady path does not.

## Suggested direction

One-line edit; wraps `startWorkerSessionFor` in a `try/catch` and
returns `false` so the existing readiness-poll loop drives the recovery:

```ts
try {
  startWorkerSessionFor(ctx)
} catch (err) {
  logger.warn({ err, session: ctx.session }, 'agent-worker: startWorkerSessionFor failed; treating as not-ready')
  return false
}
```

Per task rule "NEVER modify src/web/agent-worker.ts" the source edit is
blocked until the user overrides; the test suite pins the current
behaviour and documents the direction.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
