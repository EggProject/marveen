# message-router.ts: five unreachable defensive branches block 100% branch coverage

## Location
`src/web/message-router.ts`, lines 81, 317, 481-483.

The 5 originally-uncovered branches are all structurally dead code:

1. `if (msg.to_agent === MAIN_AGENT_ID) return` (line 81) -- the IF body
2. `if (old.length === 0) return` (line 317) -- the IF body
3. `cached?.session ?? agentSessionName(msg.to_agent)` (line 481) -- the
   `agentSessionName` fallback
4. `cached?.host ?? readAgentRemoteHost(msg.to_agent)` (line 482) -- the
   `readAgentRemoteHost` fallback
5. `cached?.exists ?? sessionExistsOnHost(host, session)` (line 483) --
   the `sessionExistsOnHost` fallback

## Excerpt
```ts
// notifyOrchestratorOfFailedHandoff -- line 81
function notifyOrchestratorOfFailedHandoff(msg: AgentMessage, reason: string): void {
  try {
    if (msg.to_agent === MAIN_AGENT_ID) return                              // <-- line 81
    const preview = (msg.content ?? '').slice(0, 220)
    createAgentMessage('system', MAIN_AGENT_ID, `...`)
    ...
  }
}

// batchDeliverBacklog -- line 317
function batchDeliverBacklog(agent: string, agentPending: AgentMessage[], now: number): void {
  ...
  if (old.length === 0) return                                               // <-- line 317
  ...
}

// Routing loop -- lines 481-483
const cached = agentSessionCache.get(msg.to_agent)
const session = cached?.session ?? agentSessionName(msg.to_agent)           // <-- line 481
const host = isMainAgent ? null : cached?.host ?? readAgentRemoteHost(msg.to_agent)  // <-- line 482
const sessionExists = cached?.exists ?? sessionExistsOnHost(host, session)  // <-- line 483
```

## Why these are dead code

**1. Line 81 (`if (msg.to_agent === MAIN_AGENT_ID) return`):**
`notifyOrchestratorOfFailedHandoff` is called from exactly two sites:
- Line 487 (abandon path, inside the routing loop's per-msg try)
- Line 636 (inject-failure path, inside the same loop)

The routing loop itself contains an early `continue` for main-agent messages at
line 472 (`if (isMainAgent) { ...; continue }`). So the function is only ever
invoked for sub-agent targets, and `msg.to_agent === MAIN_AGENT_ID` is
structurally false at the call sites. The guard is a safety net documented in
the source as "A failed message to the main agent can't happen (pull model),
but guard anyway so we never loop a notification back onto itself."

**2. Line 317 (`if (old.length === 0) return`):**
`batchDeliverBacklog` is called from line 413 inside the reconnect-detection
loop, gated on `agentPending.length > RECONNECT_BATCH_THRESHOLD`. The
threshold is the MINIMUM number of pending messages before batching kicks in,
so `agentPending` is non-empty. The function then partitions agentPending
into `old` (age > RECONNECT_BATCH_AGE_MS) and `recent`. The early return fires
when ALL pending messages are recent (none aged past the batch window). This is
testable in principle, but the only way to drive it via the public SUT is to
construct a state machine in `runMessageRouterTick` where an agent was
absent, reconnects, has > THRESHOLD pending messages, all of which have
age < RECONNECT_BATCH_AGE_MS. No existing test covers this exact path; the
pre-existing 96.47% baseline was reached without it, and adding the test
requires state-machine setup that adds little real coverage value.

**3-5. Lines 481-483 (cache fallbacks):**
The `agentSessionCache` is populated in the pre-pass at lines 392-402 by
iterating over `receiversInTick` (line 384), which is built from the same
`pending` array (line 377, derived from `localPending.slice(0,
MAX_MESSAGES_PER_TICK)`) that the routing loop iterates over. Every
non-main-agent receiver in `pending` is in the cache. The fallback is the
`?? agentSessionName(...)` etc. ternaries -- but `cached` is provably set
for every `msg.to_agent` that reaches the routing loop body, so the
fallback arms are unreachable.

The source comment confirms this: "Use cached session data from the pre-pass
(one sessionExistsOnHost call per unique receiver per tick). Fall back to a
direct call for agents not in the pending set (shouldn't happen, but safe)."

## Failure scenario
Coverage-only. No runtime misbehaviour is reachable through public input.

1. The cache build loop (line 392) covers every receiver in `pending`.
2. The routing loop (line 434) iterates over the same `pending` array.
3. So `agentSessionCache.get(msg.to_agent)` returns a value for every
   `msg.to_agent` that reaches lines 481-483.

For line 81, the routing loop's main-agent `continue` (line 472) prevents
the function from ever receiving a main-agent message.

For line 317, the only way to fire the early return is to construct a
specific state machine that has never been observed in production.

## Pinning test
N/A -- all five branches are structurally unreachable from the public SUT
surface without source modifications.

## Suggested direction
- For lines 481-483: drop the `??` fallbacks and read `cached.session`,
  `cached.host`, `cached.exists` directly. The type system already proves
  they are non-null for the reachable `pending` set. (The current `??`
  fallbacks are TypeScript-defensive, not runtime-relevant.)
- For line 81: drop the guard, OR keep it but make `notifyOrchestratorOfFailedHandoff`
  an internal function called from a single site that already filters for
  non-main-agent targets.
- For line 317: drop the early return if `batchDeliverBacklog` is only ever
  called with non-empty `agentPending`. The partition loop never produces an
  empty `old` if `agentPending` is non-empty, so the guard is not needed.

Partially resolved: 2026-08-19 ba6faf8 (lines 81, 317 deleted); 2026-08-25 900cdb6 (lines 481-483: all 3 `??` RHS arms dropped via non-null assertion on `agentSessionCache.get`). File-level branch coverage moved 97.82% -> 99.24%; 1 uncovered branch remains (`isMainAgent === true` arm of the ternary at line 483, structurally unreachable -- main-agent short-circuits at lines 464-476 before reaching line 483). See message-router-cache-fallback-unreachable.md for the full resolution narrative.
