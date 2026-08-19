# channel-invites.ts:108 - TS strict blocks the safe-delete

## Reason

Attempted to drop `if (!store.invites) return 0` from `activeInviteCount`.
After the removal, `Object.values(store.invites)` (where `store.invites` is
`Record<string, InviteEntry> | undefined`) trips TS2769 because
`Object.values` requires a non-undefined argument under the project's strict
TS settings.

## Resolution

Edit reverted. Source branch left intact. Synthetic test that pinned this
branch stays in place alongside the source.

## See also

`docs/needs-to-be-fix/channel-invites-unreachable-defensive-branches.md`
documents the dead-branch analysis and the suggested direction (option
(b) - leave the guard with an invariant comment - is the path forward
given the TS strict constraint).

## Resolved

Resolved: 2026-08-19 d48256c -- the safe-delete that this MD claimed
was TS-strict-blocked actually landed in d48256c ("fix(channel-invites):
drop 2 dead defensive guards (lines 108, 236)"). The `if (!store.invites)
return 0` guard was dropped and `Object.values(store.invites ?? {})`
was substituted to satisfy strict TS. The MD's "Edit reverted. Source
branch left intact." prose is now stale -- the edit landed.
