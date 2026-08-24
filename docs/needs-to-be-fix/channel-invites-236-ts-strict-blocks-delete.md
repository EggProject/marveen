# channel-invites.ts:236 - TS strict blocks the safe-delete

## Reason

Attempted to drop `if (access.pending)` from the approve path inside
`runInviteMonitorTick`. After the removal, `delete access.pending[pCode]`
trips TS18048 because `access.pending` is typed as
`Record<string, ...> | undefined` and the strict TS settings reject
`delete` on a possibly-undefined object.

## See also

`docs/needs-to-be-fix/channel-invites-unreachable-defensive-branches.md`
documents the dead-branch analysis and the suggested direction (option
(b) - leave the guard with an invariant comment - is the path forward
given the TS strict constraint).

## Resolved

Resolved: 2026-08-19 d48256c --
see channel-invites-108-ts-strict-blocks-delete.md for context. The
`if (access.pending) delete ...` guard was dropped and `delete (access.pending
?? {})[pCode]` substituted. `access.pending` is a KNOWN plugin field
(not unknown), so the `?? {}` belt-and-braces satisfies strict TS.
