**Status:** RESOLVED 2026-08-14 08d7508

# channel-monitor.ts:1455, 1494 -- `t.agentName ?? t.session` fallback is unreachable

## Location

`src/web/channel-monitor.ts`, lines 1455 and 1494 (the
`isMarveen ? BOT_NAME : (t.agentName ?? t.session)` label ternary in
the pane-error alert path and the pane-menu alert path respectively):

```ts
if (decision.alert) {
  const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
  logger.error({ session: t.session, agent: label }, 'Agent wedged on thinking-block API error -- manual reset needed')
  sendAlert(`🚨 A(z) ${label} agens elakadt ...`)
}
```

```ts
if (decision.alert) {
  const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
  if (firstRunGate === 'login') { ... }
  ...
}
```

## Excerpt

The `t.agentName ?? t.session` fallback at lines 1455 and 1494 is
**structurally unreachable**. The `targets` array is built at the
start of the `check()` function:

```ts
const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true, provider: mainProvider }]
for (const a of listAgentNames()) {
  if (isAgentRunning(a) && agentHasChannel(a)) {
    targets.push({
      session: agentSessionName(a),
      isMarveen: false,
      agentName: a,
      provider: resolveAgentProvider(a),
    })
  }
}
```

The MAIN target has `isMarveen: true` and no `agentName`. The ternary
short-circuits to `BOT_NAME` for that target.

For SUB-AGENT targets, `agentName: a` is **always** set explicitly
(unconditional assignment, no conditional). The ternary reaches the
`?? t.session` only when `t.isMarveen === false`, which is exactly the
case where `agentName` is always defined. The fallback cannot fire.

The defensive `?? t.session` is insurance against a future code path
that constructs a `Target` without `agentName` for a non-Marveen
session -- but the only Target construction site always sets it.

## Failure scenario

v8 reports both binary-expr branches at lines 1455 and 1494 as
`counts=[2, 0]` -- truthy arm (agentName defined, returns agentName)
hit 2 times across the existing 25-test `channel-monitor-baseline.test.ts`
suite (one per sub-agent alert log), falsy arm (`?? t.session`)
never hit.

The 100% branch coverage gate fails on `src/web/channel-monitor.ts`
because of these dead branches.

The cond-expr `t.isMarveen ? BOT_NAME` at the same lines IS reachable
(both sides hit) thanks to the new test added in
`channel-monitor-baseline.test.ts` ("baseline: pane-error alert label"
and "baseline: pane-menu alert label").

Options:

1. Drop the `?? t.session` fallback. The `agentName` field is
   guaranteed defined for every sub-agent target. Tighten the
   `Target` type to make `agentName` required for `isMarveen: false`:

   ```ts
   type Target = { session: string; isMarveen: true; provider: ChannelProviderType }
                | { session: string; isMarveen: false; agentName: string; provider: ChannelProviderType }
   ```

2. Leave the fallback (current state) as belt-and-braces.

Option (1) is the cleanest fix -- TypeScript can then enforce the
invariant at compile time.

## Pinning test

None. The fallback can only fire if a `Target` is constructed with
`isMarveen: false` and `agentName: undefined` -- which is impossible
without restructuring the `targets.push()` call.

The two new tests ("baseline: pane-error alert label" and
"baseline: pane-menu alert label") drive `decision.alert = true` so
the label ternary IS reached; both arms of the `t.isMarveen` cond-expr
fire. The `?? t.session` falsy arm remains at 0.

## Suggested direction

Per option (1): tighten the Target type and drop the fallback. The
current TypeScript `agentName?: string` allows a non-Marveen target
without agentName in theory, but the construction site never does
this.

Per task rule "NEVER modify src/web/channel-monitor.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
