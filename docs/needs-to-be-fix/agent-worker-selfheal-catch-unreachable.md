# agent-worker.ts: ensureWorkerReady's self-heal catch arm is unreachable

## Location

`src/web/agent-worker.ts`, line 604 (inside `ensureWorkerReady`).

```ts
async function ensureWorkerReady(ctx: WorkerCtx): Promise<boolean> {
  if (!workerStartAllowed()) { ...; return false }
  startWorkerSessionFor(ctx)
  const start = Date.now()
  const deadline = start + WORKER_BOOT_TIMEOUT_MS
  let healed = false
  while (Date.now() < deadline) {
    if (await isSessionReadyForPrompt(ctx.session)) return true
    if (!healed && Date.now() - start > WORKER_SELF_HEAL_GRACE_MS) {
      healed = true
      try { selfHealWorkerOnce(ctx) } catch (err) { logger.warn({ err }, 'agent-worker: self-heal pass failed') }
    }
    await sleepMs(2000)
  }
  ...
}
```

## Excerpt

The catch arm at line 604 catches throws from `selfHealWorkerOnce(ctx)`.
The function already wraps every internal tmux call (`execFileSync(TMUX,
['send-keys', ...])`, `execFileSync(TMUX, ['kill-session', ...])`) in
its own try/catch with explicit `catch { /* best effort */ }` blocks,
so the only way for `selfHealWorkerOnce` itself to throw is:

1. `capturePane(ctx.session)` throws (it goes through `agent-process.ts`,
   which is mocked at the test boundary -- in production it returns
   `null` on a missing session without throwing).
2. `classifyWorkerPane` throws on a malformed input (it accepts
   `string | null` and only calls `String.prototype.split` /
   `RegExp.prototype.test`, all of which are non-throwing on the
   handled inputs).
3. `shouldSelfHeal` throws (it returns a literal boolean, no
   fallible code path).
4. `logger.warn` throws (the logger sink is a no-op in production and
   a `vi.fn()` in tests).

None of these are reachable through the public API. The `try/catch`
around `selfHealWorkerOnce` is a defensive belt against a future
refactor that adds a fallible call inside the self-heal, and against
log-sink failures (replaced by `throwOnLog` in the test suite but
defaulted to a no-op).

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through the public
API.

1. A caller drives `runViaWorker` on a worker that fails to reach an
   idle prompt.
2. `ensureWorkerReady` waits `WORKER_SELF_HEAL_GRACE_MS` (20s) before
   invoking `selfHealWorkerOnce`.
3. `selfHealWorkerOnce` runs to completion without throwing because
   every internal call is guarded.
4. The catch arm is never entered; the `logger.warn` line is dead.

The only way to drive the catch arm is to inject a throw into one of
the four fallible calls above. The test suite already mocks
`capturePane`, `classifyWorkerPane`, `shouldSelfHeal`, and the logger
to bypass these throws -- the catch arm is structurally unreachable
through the public test surface.

## Pinning test

`src/__tests__/agent-worker-full.test.ts`, the
`'warns and continues when the self-heal pass itself throws (line 604
catch -- currently uncovered)'` test (inside the
`describe('selfHealWorkerOnce (via ensureWorkerReady)')` block). It
asserts nothing observable and exists solely to document the
unreachable branch. The `expect(true).toBe(true)` body is the
acceptance marker that the test acknowledges the gap.

## Suggested direction

Two independent paths, neither requires a source change to drive the
coverage:

(a) Drop the `try/catch` and rely on `selfHealWorkerOnce`'s internal
    guards. The function already swallows every tmux-pane error; the
    outer catch is redundant.

(b) Export `selfHealWorkerOnce` for direct unit testing. The function
    is currently called only via `ensureWorkerReady`, which forces the
    test to also drive the 20s grace window + the 90s readiness poll.
    An exported symbol would let a test inject a `vi.fn()` that
    throws, driving the catch arm without the rest of the loop.

Per task rule "NEVER modify src/web/agent-worker.ts" the source edit is
blocked until the user overrides; the pinning test documents the
current behaviour and the bug MD tracks the direction.
