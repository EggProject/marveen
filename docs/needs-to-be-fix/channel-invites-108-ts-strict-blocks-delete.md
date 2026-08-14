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
