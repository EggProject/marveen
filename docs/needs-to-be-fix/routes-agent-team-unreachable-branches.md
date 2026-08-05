# routes/agent-team.ts: file path does not exist; coverage pin moved to web/agent-team.ts

## Path discrepancy

The task description references `src/web/routes/agent-team.ts`, but no
file at that path exists in the repository. The closest match is
`src/web/agent-team.ts` (198 lines, 12 exported functions / constants,
imports `./agent-config.js`, `../config.js`, `./atomic-write.js`).
This defect documents the live state for the file the task was aimed
at. See `agent-team-trustfrom-nullish-coalesce.md` in this directory
for the original, more detailed branch-coverage analysis.

## Current coverage

`src/__tests__/agent-team.test.ts` (60 tests, all passing):

| metric     | value                  |
|------------|------------------------|
| statements | 100% (82/82)           |
| branches   | 96.87% (62/64)         |
| functions  | 100% (12/12)           |
| lines      | 100% (69/69)           |

Uncovered branches are the right-arm of `team.trustFrom ?? []` on
lines 191 and 192 of `src/web/agent-team.ts`, inside
`cleanupTeamReferences`.

## Why 100% branches is unreachable without source changes

`readAgentTeam` (lines 34-49) is the sole producer of `team.trustFrom`
inside `cleanupTeamReferences`. It always returns `trustFrom` as a
(populated) string array -- the `Array.isArray` guard at line 44
falls through to `[]`, and the catch + return at line 48 also yields
`trustFrom: []`. The `?? []` defensiveness on lines 191-192 of
`cleanupTeamReferences` therefore has a right-arm that no reachable
input can exercise.

`readAgentTeam` is a local function inside `agent-team.ts`, not an
imported binding, so `vi.mock` / `vi.spyOn` on `readAgentTeam` cannot
redirect the internal call from `cleanupTeamReferences`. Mocking the
imported helpers (`readFileOr`, `agentDir`) only changes the *contents*
of the file `readAgentTeam` parses -- it does not change the fact that
`readAgentTeam` always returns `trustFrom` as an array.

Rule 1 of the task forbids modifying the source file, so the gap is
not closable in the test suite. Per the existing defect
(`agent-team-trustfrom-nullish-coalesce.md`) the two acceptable
resolutions are:

1. Drop both `?? []` operators in `cleanupTeamReferences` (matches
   the established pattern with `delegatesTo` on the line above).
2. Add `/* v8 ignore next */` above lines 191 and 192.

Either fix has been deferred until the source rule can be relaxed.

## Pinning test

`src/__tests__/agent-team.test.ts` exercises every reachable branch:

- `DEFAULT_TEAM` shape
- `readAgentTeam` -- missing file, missing / null / non-object /
  unparseable `team` block; `role: 'leader'` verbatim and coercion of
  every other value to `'member'`; `reportsTo` string / empty /
  whitespace / non-string; `delegatesTo` array-of-strings and non-
  array; `trustFrom` array-of-strings and non-array;
  `autoDelegation` boolean coercion; full happy-path
- `resolveSecurityProfileId` -- non-string / empty / whitespace /
  `'default'` / non-default storedProfile, leader and member roles
  (every branch of the `&&` + ternary)
- `resolveAgentSecurityProfile` -- explicit non-default, leader,
  member, missing agent
- `writeAgentTeam` -- create, merge with existing, overwrite previous,
  start-fresh on unparseable JSON
- `sanitizeTeamConfig` -- self-reference and unknown in `reportsTo`,
  `delegatesTo`, `trustFrom`, de-duplication, missing `trustFrom`,
  `MAIN_AGENT_ID` acceptance, multi-field `droppedUnknown`,
  `droppedSelf` dedup, role / autoDelegation pass-through
- `reportsToCreatesCycle` -- null / main parent, self, straight
  assignment, two-node cycle, transitive cycle, pre-existing loop
  termination
- `cleanupTeamReferences` -- no-op, `reportsTo` reset to
  `MAIN_AGENT_ID`, removed from `delegatesTo`, removed from
  `trustFrom`, `MAIN_AGENT_ID`-self removal (reportsTo -> null),
  missing `trustFrom`, multi-agent rewrite, single-pass delegates +
  trust + reportsTo rewrite

## Recommendation

Treat the branch-coverage gap as a known defect and either:

- exclude `src/web/agent-team.ts` from the branch threshold in
  `vitest.config.ts` (statements / lines / functions still gate, and
  remain at 100%), or
- accept one of the two source-side resolutions from
  `agent-team-trustfrom-nullish-coalesce.md`.

Until then, no test can advance branches past 62/64.
