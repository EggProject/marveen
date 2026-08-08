# channel-monitor.ts: agentDownSince.get(t.session) ?? Date.now() at line 1647 is structurally dead

## Location

`src/web/channel-monitor.ts`, line 1647 (inside the per-target cascade
loop at line 1557).

```ts
const msDown = Date.now() - (agentDownSince.get(t.session) ?? Date.now())
```

## Excerpt

`agentDownSince` is a `Map<string, number>` declared at line 80 and
written to exactly twice in the SUT:

1. Line 1619 (`if (!agentDownSince.has(t.session)) { agentDownSince.set(t.session, Date.now()) ... }`)
2. Line 1602 (`agentDownSince.delete(t.session)` inside the
   `liveness === 'alive'` branch -- which `continue`s on line 1613,
   so the delete prevents the read at line 1647 from being reached
   in the same iteration).

The read at line 1647 lives in the SAME iteration as the write at line
1619. The `has()` check on line 1618 guarantees that, if `has()`
returns false, the `set` runs before the read on the very next line.
If `has()` returns true, the `set` is skipped, and `get()` is
guaranteed to return the previously-set number -- never `undefined`.
There is no code path where `get(t.session)` returns `undefined` and
control still reaches line 1647.

The `?? Date.now()` defensive fallback is therefore unreachable.

This mirrors the agent-scaffold and auto-restart-runner families of
`?? Map.get(...)` defensive fallbacks: TypeScript narrows
`Map<K, V>.get(key)` to `V | undefined`, but the surrounding control
flow eliminates the `undefined` case before the read.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. The cascade runs with `agentDownSince` initially empty.
2. First down-observation on a session: `has()` returns false ->
   `set()` writes the timestamp -> `get()` returns the timestamp ->
   the LHS of `??` is non-null.
3. Subsequent down-observations on the same session: `has()` returns
   true -> `set()` is skipped -> `get()` returns the previously-set
   timestamp -> the LHS of `??` is non-null.
4. Between observations the cascade either `delete()`s the entry
   (alive-spell) and `continue`s past the read, or holds the entry
   intact across iterations.
5. v8 records the `?? Date.now()` arm as untaken.
6. Branch coverage caps at 95.48% (338/354); the gap includes this
   one defensive fallback alongside the others documented in
   `channel-monitor-unreachable-defensive-branches.md`.

## Pinning test

`src/__tests__/channel-monitor-baseline.test.ts`. The companion
`msDown` consumption path is fully covered by the existing primary suite:

- `describe('coverage: agent skip-action: msDown < AGENT_DOWN_CONFIRM_MS
  (line 1681)')` drives the "awaiting confirmation on the next sweep"
  branch, which reads `msDown` with `agentDownSince.get` returning a
  real number.
- `describe('coverage: agent alert-busy action: already-alerted branch
  (line 1670)')` drives the alert-busy path that uses `msDown` for
  the alert message.

Both tests cover the IF side of the `??` ternary; neither reaches the
`?? Date.now()` fallback.

## Suggested direction

One independent edit; removes the dead fallback without changing
behaviour.

(a) Line 1647 -- drop the `?? Date.now()` and tighten the type of
    `agentDownSince` so `get` returns `number` (not `number | undefined`):

    ```ts
    const msDown = Date.now() - agentDownSince.get(t.session)!
    ```

    The non-null assertion is justified by the surrounding control
    flow; the cleaner refactor is to inline the read into the `set`
    branch and propagate the timestamp via a local:

    ```ts
    if (!agentDownSince.has(t.session)) {
      const nowDown = Date.now()
      agentDownSince.set(t.session, nowDown)
      // ... use nowDown directly for msDown on the first observation ...
    }
    ```

    The exact shape of the cleanup depends on whether the SUT wants to
    preserve `get` semantics at the call site; the simple non-null
    assertion is the smallest edit.

Per task rule "NEVER modify src/web/channel-monitor.ts" the source edit
is blocked until the user overrides; the test suite documents the gap
and covers every reachable sibling branch.
