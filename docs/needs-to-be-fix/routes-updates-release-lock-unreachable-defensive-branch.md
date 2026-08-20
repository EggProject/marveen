# routes/updates.ts: releaseLock's `if (!lockHeld) return` is structurally unreachable

**Status:** RESOLVED (the `if (!lockHeld) return` defensive guard was deleted in the 2026-08-14 unreachable-branches sweep, see commit `c2b4ea2` on `test/baseline`). The narrative below is kept as a historical record of the bug, not as an open task.

## Location

`src/web/routes/updates.ts`, the `releaseLock` closure inside
`tryHandleUpdates`'s `/api/updates/apply` branch (lines 197-201):

```ts
const releaseLock = () => {
  if (!lockHeld) return          // <-- line 198, never executes
  try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
  lockHeld = false
}
```

## Excerpt

Every call site that invokes `releaseLock()` (precheck-crash, store-unwritable,
outer spawn catch, async child error) runs **after** `lockHeld` has been set to
`true` by a successful `writeFileSync(UPDATE_PIDFILE, ..., { flag: 'wx' })`.
There is no path through the route that calls `releaseLock()` with
`lockHeld === false`. The only writer of `lockHeld = false` is `releaseLock`
itself, and the route never invokes `releaseLock` twice within the same
request.

The `if (!lockHeld) return` is a defensive guard for an impossible state --
the kind of guard a future maintainer might expect to be reachable, but isn't.

## Failure scenario

A coverage gate (line + branch 100%) trips on this line. Two options:

1. **Remove the guard** -- `releaseLock` is only ever called with lockHeld=true
   in production, so the early return is dead code. This is the correct fix.

2. **Leave the guard** -- accept the structurally-unreachable defensive branch
   and pin it via a test that documents why it cannot fire (current approach).

## Pinning test

`src/__tests__/routes-updates.test.ts`, the "releaseLock: pinning test
documents the structurally unreachable `if (!lockHeld) return` branch"
test. It exercises the call site that triggers `releaseLock` (a
synchronously-throwing spawn mock) and asserts that:
- the route returns 500
- the pidfile is removed (lockHeld was true at call time)
- the `if (!lockHeld) return` early-exit was NOT taken

If the guard is removed, this test still passes (the line simply
disappears). No assertion change required.

## Suggested direction

Delete the `if (!lockHeld) return` line. The closure becomes:

```ts
const releaseLock = () => {
  try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
  lockHeld = false
}
```

If a future change introduces a second releaseLock call site before
`lockHeld = true` is reached, the guard would re-protect against
double-unlink -- but at that point the real fix is to ensure lockHeld
is correctly initialized, not to layer defensive guards on top of
incorrect state.