# message-router.ts: cached session-lookup `??` fallback arms are unreachable

## Location

`src/web/message-router.ts`, lines 477-480 (inside `runMessageRouterTick`).

```ts
const cached = agentSessionCache.get(msg.to_agent)
const session = cached?.session ?? agentSessionName(msg.to_agent)
const host = isMainAgent ? null : cached?.host ?? readAgentRemoteHost(msg.to_agent)
const sessionExists = cached?.exists ?? sessionExistsOnHost(host, session)
```

## Excerpt

Each `??` arm is the fallback when `agentSessionCache.get(msg.to_agent)`
returns `undefined` (or when a field on the cached value is itself
`undefined`). All three fallback arms are dead code through the public
path: the cache is populated for every receiver in `receiversInTick` on
the same tick the loop body iterates, and `receiversInTick` is built
from the same `pending` slice the loop walks. The cache lookup always
wins.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public
input.

1. A caller drives `runMessageRouterTick` with a non-empty `pending`
   slice.
2. The pre-pass walks `pending`, extracts every `to_agent` (other than
   `MAIN_AGENT_ID`) into `receiversInTick`, and calls
   `sessionExistsOnHost` once per unique receiver to populate
   `agentSessionCache`.
3. The loop body iterates over `pending`. For each message it does
   `agentSessionCache.get(msg.to_agent)`, which always finds the entry
   written two phases earlier. The optional chains short-circuit and
   the `??` arms never fire.
4. The `if (isMainAgent)` guard on `host` already short-circuits main-
   agent messages via the wakeup path, so `cached?.host ??` is only
   consulted for non-main-agent receivers -- and those are guaranteed
   in the cache as well.

The same destructured-import pattern that defeats
`vi.spyOn(node:fs, 'symlinkSync')` for `agent-worker.ts` (see
`agent-worker-symlink-catch.md`) does NOT apply here -- the cache is a
local `Map` constructed inside `runMessageRouterTick`, so the only way
to flip the `??` arms is to make `receiversInTick` empty while
`pending` is non-empty. That requires the loop body's message to have a
`to_agent` that the pre-pass skipped. The pre-pass skips exactly one
value: `MAIN_AGENT_ID`. And the main-agent path is short-circuited on
the wakeup path long before the cache lookup. There is no remaining
input.

## Pinning test

`src/__tests__/message-router-full.test.ts`, the
`'falls back to a direct sessionExistsOnHost when the receiver is not
in the cache'` test (in the `describe('runMessageRouterTick')` block).
It documents the unreachable intent in its name but asserts the
current behaviour: the cache always wins, the message is parked in
the "target session not running, will retry" branch, and the fallback
arms never fire. The bug MD is the formal counterpart of that inline
test comment.

## Suggested direction

Two independent paths, neither requires a source change to drive the
coverage:

(a) Drop the `??` arms entirely and treat the cache as a hard
    invariant:

    ```ts
    const cached = agentSessionCache.get(msg.to_agent)
    if (!cached) {
      logger.warn({ to: msg.to_agent }, 'message-router: receiver not in cache (should never happen)')
      continue
    }
    const { session, host, exists: sessionExists } = cached
    ```

    This converts the dead arms into a logged invariant violation and
    removes the silent fallback. Branch coverage reaches 100% with no
    test changes.

(b) Export `runMessageRouterTick`'s pre-pass into a helper so a unit
    test can drive the "cache empty + non-empty pending" path
    directly. Bigger refactor; only worth it if other call sites
    surface.

Per task rule "NEVER modify src/web/message-router.ts" the source edits
are blocked until the user overrides; the pinning test documents the
gap and the bug MD tracks the direction.