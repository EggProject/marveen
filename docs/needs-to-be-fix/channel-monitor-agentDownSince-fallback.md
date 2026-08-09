# channel-monitor.ts:1647 -- `agentDownSince.get() ?? Date.now()` fallback is unreachable

## Location

`src/web/channel-monitor.ts`, lines 1617-1647 (sub-agent down-detection
and restart-decision):

```ts
} else {
  if (!agentDownSince.has(t.session)) {
    agentDownSince.set(t.session, Date.now())
    // First down observation of this spell: capture WHY before anything is
    // torn down. ...
    try {
      const evidence = collectPollerEvidence(t.provider, agentDir(t.agentName!), claudePid)
      ...
    } catch (err) {
      ...
    }
  }
  ...
  const msDown = Date.now() - (agentDownSince.get(t.session) ?? Date.now())
  ...
}
```

## Excerpt

The `?? Date.now()` fallback at line 1647 is **structurally
unreachable** for sub-agent targets. The `agentDownSince` Map is
populated at lines 1618-1619 on the FIRST down observation of a
session:

```ts
if (!agentDownSince.has(t.session)) {
  agentDownSince.set(t.session, Date.now())
  ...
}
```

After this point in the same tick, the session IS in the map. The
later `agentDownSince.get(t.session)` at line 1647 returns the value
that was just set (or a previously-set value from an earlier tick).

The map entry can be deleted at three places:

- line 1602 (Marveen-only branch, doesn't reach line 1647)
- line 1698 (restart-cap-reached, `continue` skips line 1647)
- line 1745 (busy-recovery deferral, `continue` skips line 1647)

None of these deletes are followed by a code path that reaches line
1647 without first re-populating the entry. By the time the
`agentDownSince.get(t.session)` is called, the entry is always
present.

## Failure scenario

v8 reports `branch 148 line=1647 type=binary-expr counts=[37, 0]` --
truthy arm (`get()` returns the stored timestamp) hit 37 times across
the existing `channel-monitor-coverage.test.ts` and
`channel-monitor-baseline.test.ts` suites, falsy arm (`?? Date.now()`
fallback) never hit.

The 100% branch coverage gate fails on `src/web/channel-monitor.ts`
because of this dead branch.

Options:

1. Drop the `?? Date.now()` fallback. `agentDownSince.get(t.session)`
   is guaranteed to return a number when this line is reached.
2. Leave the fallback (current state) as belt-and-braces against a
   future refactor that introduces a delete-then-check ordering.

Option (1) is the cleanest fix.

## Pinning test

None. The fallback can only fire if a code path reaches line 1647
WITHOUT first setting `agentDownSince.set(t.session, ...)` for the
current session. No such code path exists.

## Suggested direction

Drop the fallback:

```ts
const msDown = Date.now() - agentDownSince.get(t.session)!
```

The `!` non-null assertion documents the invariant at the type level.
If a future refactor breaks the invariant, TypeScript's strict mode
flags it at compile time.

Per task rule "NEVER modify src/web/channel-monitor.ts" this requires
an explicit override from the user.