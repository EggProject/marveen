# channel-monitor.ts: t.agentName ?? t.session at lines 1455 and 1494 is structurally dead

## Location

`src/web/channel-monitor.ts`, lines 1455 (inside the pane-error detection
loop at line 1440) and 1494 (inside the menu recovery loop at line 1470).

```ts
const label = t.isMarveen ? BOT_NAME : (t.agentName ?? t.session)
```

## Excerpt

`Target.agentName` is `string | undefined` in the type, but the only
construction site for `Target` at lines 1424-1434 always sets
`agentName` to a real string when `isMarveen: false`:

```ts
const targets: Target[] = [{ session: MAIN_CHANNELS_SESSION, isMarveen: true, provider: mainProvider }]
for (const a of listAgentNames()) {
  if (isAgentRunning(a) && agentHasChannel(a)) {
    targets.push({
      session: agentSessionName(a),
      isMarveen: false,
      agentName: a,                                    // string, never undefined
      provider: resolveAgentProvider(a),
    })
  }
}
```

The other branch (`isMarveen: true`, the marveen target) does not have
an `agentName` field, so `t.agentName` is `undefined` only when
`t.isMarveen` is `true` -- which routes through the FIRST ternary arm
(`t.isMarveen ? BOT_NAME : ...`), so the SECOND arm's `t.agentName`
LHS is never read.

The two `?? t.session` falls are defensive: they never fire.

This mirrors the agent-scaffold family of `?? Map.get(...)` defensive
fallbacks, but here the type system is even stricter -- `listAgentNames`
returns `string[]`, so `a` is provably a string at the type level.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. The monitor loop builds `targets` exactly as documented above.
2. Every non-marveen target has `agentName: <string>` (line 1430).
3. Every marveen target has `isMarveen: true` (line 1424) -- the
   ternary routes the read to `BOT_NAME` and never evaluates
   `t.agentName ?? t.session`.
4. v8 records both `?? t.session` arms as untaken (branch-1 cbranch-no).
5. Branch coverage caps at 95.48% (338/354); the gap is exactly the two
   `?? t.session` defensive falls.

There is no test-side lever: `agentName` is set at the only
construction site from `listAgentNames()`, which the SUT mocks via the
`agent-config.js` test surface. Mocking `listAgentNames` to return
`[null as unknown as string]` would require explicit `as`-casts (the
project bans them via `CLAUDE.md` rule "tiltott az \`as\` használata"),
and the TypeScript narrowing on `for (const a of listAgentNames())`
makes even a runtime null impossible to push through the type system
without touching the SUT.

## Pinning test

`src/__tests__/channel-monitor-baseline.test.ts`. The companion
reachable branches on the same `Target.agentName` are covered by the
existing primary suite:

- `describe('coverage: pane-error alert when stage is hard/gave_up')`
  and `describe('coverage: menu recovery flows')` (in
  `channel-monitor-coverage.test.ts`) drive the marveen branch of the
  same ternary -- the test surface here proves the FIRST arm fires.

## Suggested direction

One independent edit per occurrence; each removes a dead arm without
changing behaviour.

(a) Line 1455 -- drop the `?? t.session` and tighten `Target` so
    `agentName` is `string` (not `string | undefined`):

    ```ts
    const label = t.isMarveen ? BOT_NAME : t.agentName
    ```

    The change cascades to the `Target` type definition (line 1423)
    and to the construction site (line 1430), both of which already
    satisfy the new invariant.

(b) Line 1494 -- same edit.

Per task rule "NEVER modify src/web/channel-monitor.ts" the source edits
are blocked until the user overrides; the test suite documents the gap
and covers every reachable sibling branch.
