# channel-request-watcher.ts: lookupChannelName's `if (provider !== 'slack') return` is unreachable

## Location

`src/web/channel-request-watcher.ts`, line 67.

```ts
async function lookupChannelName(agent: string, channelId: string): Promise<void> {
  const cached = channelNameCache.get(channelId)
  if (cached) {
    const ttl = cached.name ? CHANNEL_CACHE_TTL : NEGATIVE_CACHE_TTL
    if (Date.now() - cached.ts < ttl) return
  }

  const provider = resolveAgentProvider(agent)
  if (provider !== 'slack') return  // <-- line 67, unreachable
  const stateDir = channelStateDir(provider, agentDir(agent))
  ...
}
```

## Excerpt

The branch on line 67 is an unreachable defensive guard:

Both call sites that invoke `lookupChannelName` already filter for slack
agents:

1. **`scanAuditLog` (line 46):** `lookupChannelName(agent, entry.channel).catch(() => {})`.
   `scanAuditLog` is only called from `runScanTick` inside an `if (provider !== 'slack') continue` guard, so the `agent` passed in is always a slack-resolved agent.

2. **`runScanTick` (line 105):** `lookupChannelName(name, req.channel_id).catch(() => {})`.
   This call also lives inside the same `if (provider !== 'slack') continue` guard, so `name` is also a slack-resolved agent.

By the time `lookupChannelName` runs, both arguments come from agents that
already passed the `provider !== 'slack'` filter. The internal check on
line 67 (`resolveAgentProvider(agent)`, then `if (provider !== 'slack') return`)
cannot produce `provider !== 'slack'` unless the underlying
`readAgentChannelProvider(name)` flips its return value between the two
reads (one in `runScanTick`, one in `lookupChannelName`). That is not a
realistic scenario for synchronous test code and not a documented race
in the codebase.

## Failure scenario

The defect is a coverage-only defect -- no runtime misbehaviour is
reachable through public input.

1. `startChannelRequestWatcher()` fires `runScanTick()` on every
   `intervalMs`.
2. `runScanTick()` iterates `listAgentNames()` and calls
   `resolveAgentProvider(name)` once per agent, skipping non-slack ones.
3. For every slack agent, `scanAuditLog` and the pending-list walk each
   invoke `lookupChannelName`.
4. `lookupChannelName` then calls `resolveAgentProvider(agent)` a second
   time and checks `if (provider !== 'slack') return`. Since both reads
   come from the same `readAgentChannelProvider` (and the agent's slack
   state has not changed in the synchronous block), this branch is
   never taken.

To exercise the branch in a test, the suite uses a contrived alternating
mock that returns `'slack'` on the first `readAgentChannelProvider` call
(driving `runScanTick` to process the agent) and `'telegram'` on the
second (driving `lookupChannelName` to take the early-return). See
`src/__tests__/channel-request-watcher.test.ts`,
`'the provider check in lookupChannelName bails out when readAgentChannelProvider flips to telegram mid-tick'`.

## Suggested fix (do NOT apply per the rule)

Either:

- **Tighten the type / drop the defensive guard:** since both call sites
  already filter on `provider !== 'slack'`, the internal check is dead.
  Removing it (and the `resolveAgentProvider` call inside
  `lookupChannelName`) keeps the runtime behaviour identical and lets
  the function take its slack-only argument as an invariant.

- **OR keep the defensive code as documentation:** leave it as-is and
  add a comment at the call site explaining why the fallback is
  unreachable, so future readers do not delete it as "dead code"
  without understanding the invariant.

## Test coverage

`src/__tests__/channel-request-watcher.test.ts` exercises the branch
via a `readProviderMock.mockImplementation` that flips between calls
(see the test listed above). That makes the coverage tool happy, but
the test asserts ONLY on the slack-side side-effects (no fetch, no
update) -- not on the synthetic provider flip.
