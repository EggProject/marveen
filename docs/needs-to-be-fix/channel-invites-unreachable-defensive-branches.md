# channel-invites.ts: two defensive branches are unreachable through public API

## Location

`src/web/channel-invites.ts`, lines 108 (inside `activeInviteCount`) and 236
(inside the approve path of `runInviteMonitorTick`).

```ts
// line 108, inside activeInviteCount
function activeInviteCount(store: InvitesFile, now: number): number {
  if (!store.invites) return 0
  let n = 0
  for (const inv of Object.values(store.invites)) {
    ...
```

```ts
// line 236, inside runInviteMonitorTick
if (!access.allowFrom) access.allowFrom = []
if (!access.allowFrom.includes(pEntry.senderId)) access.allowFrom.push(pEntry.senderId)
if (access.pending) delete access.pending[pCode]
```

## Excerpt

Both `if` guards are defensive checks against a state the SUT's own control
flow prevents from ever happening through the public API.

### 1. `activeInviteCount` (line 108)

`activeInviteCount` is called from two places:

1. `revokeInvite` (line 181), gated by `if (!store.invites?.[token]) return false`.
   The `store.invites?.[token]` short-circuit forces `store.invites` to be
   defined AND have the requested token; both are required before reaching
   the activeInviteCount call.
2. `runInviteMonitorTick` (lines 220 and 242), gated by
   `if (!store.invites) continue` (line 210). Both call sites come AFTER
   the gate, so `store.invites` is always defined when `activeInviteCount`
   runs.

So the `if (!store.invites) return 0` truthy branch in `activeInviteCount`
is dead code: every reachable caller has already verified the same
property.

### 2. `if (access.pending) delete access.pending[pCode]` (line 236)

The line sits inside the approve path of `runInviteMonitorTick`. It is
preceded by:

```ts
const pendingEntries = Object.entries(access.pending || {})
  .sort((a, b) => a[1].createdAt - b[1].createdAt)
if (pendingEntries.length === 0) continue

const [pCode, pEntry] = pendingEntries[0]
```

The `Object.entries(access.pending || {})` substitution substitutes `{}`
when `access.pending` is falsy. `Object.entries({})` returns `[]`, so
`pendingEntries.length === 0` and the path `continue`s. The only way to
reach line 236 with `pendingEntries.length > 0` is if
`Object.entries(access.pending)` returns a non-empty array -- which means
`access.pending` MUST be a truthy object. The `if (access.pending)` falsy
branch is therefore unreachable.

## Failure scenario

The defect is a coverage-only defect. No runtime misbehaviour is reachable
through public input.

1. `revokeInvite` is called with a token that exists in `invites.json`.
   `store.invites[token]` is truthy, the delete runs, and
   `activeInviteCount(store, ...)` is invoked. By construction,
   `store.invites` is still a defined object (either `{}` or
   `{ ...other }`), so the `!store.invites` truthy branch cannot fire.
2. `runInviteMonitorTick` runs through a target whose `invites.json`
   defines an `invites` map. The continue gate has already passed.
   When `live.length === 0`, the `if (!store.invites) return 0` truthy
   branch in `activeInviteCount` cannot fire for the same reason.
3. The approve path's `Object.entries(access.pending || {})` coerces
   falsy pending to `{}`; the only way past `pendingEntries.length === 0`
   is with `access.pending` truthy. `if (access.pending)` falsy branch
   cannot fire.

So both guards add code paths that can never run, and v8 branch coverage
reports them as uncovered even though every reachable behaviour IS tested.

To reach 100% branch coverage without modifying the source, the test suite
has to install a JSON.parse interceptor that returns a Proxy wrapping the
parsed object: `invites` and `pending` keys return their real value for
the first N reads, then `undefined` for the (N+1)th. The (N+1)th read is
the one inside the defensive guard, so the truthy branch fires. See the
"unreachable defensive branches" describe block in
`src/__tests__/channel-invites.test.ts` for both cases.

## Pinning test

`src/__tests__/channel-invites.test.ts`:

- `unreachable defensive branches > drives the defensive !store.invites
  truthy branch inside activeInviteCount` -- covers line 108.
- `unreachable defensive branches > drives the defensive if
  (access.pending) falsy branch inside the approve path` -- covers line 236.

Both tests arm the JSON.parse interceptor briefly during the SUT call,
disarm it on the way out, and assert observable downstream effects (the
dmPolicy flip from `pairing` to `allowlist`).

All other tests in the file exercise the reachable branches.

## Suggested direction

Either of two equally good fixes; the second is preferred because it
removes the dead code and lets the v8 coverage chart drop to 100% by
itself.

(a) Delete the guards. `activeInviteCount`'s truthy branch is unreachable
    -- the callers all gate on the same property -- so the `if
    (!store.invites) return 0` line can be removed entirely; a future
    caller that does NOT pre-check the property would have the function
    throw on `Object.values(undefined)` instead, which is a louder
    failure mode and easier to debug than a silent return. Same for
    `if (access.pending) delete ...` -- the line can be `delete
    access.pending[pCode]` directly; if `access.pending` were ever
    falsy at this point, deleting from `undefined` would throw a clear
    `Cannot delete property 'pCode' of undefined`, which is exactly the
    diagnostic shape you want if the upstream invariants ever drift.

(b) Leave the guards and add a comment at each call site documenting
    the invariant ("`store.invites` is always defined here because of
    the gate at line 210"; "`access.pending` is always defined here
    because `Object.entries(access.pending || {})` already produced a
    non-empty pendingEntries list"). This documents the invariant for
    future readers and matches the existing defensive-code style in
    this file but does NOT remove the coverage gap.

Per task rule "NEVER modify src/web/channel-invites.ts" the source edit
is blocked until the user overrides; the test suite documents the gap
and the tests that force the defensive branches to fire stay in place
alongside the fix.
