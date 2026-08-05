# agent-team.ts: `team.trustFrom ?? []` nullish-coalesce right-arm is unreachable

## Location

`src/web/agent-team.ts`, lines 191 and 192:

```ts
const filteredTrust = (team.trustFrom ?? []).filter(n => n !== removedName)   // 191
if (filteredTrust.length !== (team.trustFrom ?? []).length) {                 // 192
  team.trustFrom = filteredTrust
  dirty = true
}
```

Both occurrences of `team.trustFrom ?? []` carry a right-arm branch that
v8 never exercises.

## Excerpt

```ts
// src/web/agent-team.ts:178-198
export function cleanupTeamReferences(removedName: string): void {
  for (const other of listAgentNames()) {
    const team = readAgentTeam(other)                                         // 180
    let dirty = false
    if (team.reportsTo === removedName) {
      team.reportsTo = removedName === MAIN_AGENT_ID ? null : MAIN_AGENT_ID
      dirty = true
    }
    const filteredDelegates = team.delegatesTo.filter(n => n !== removedName)
    if (filteredDelegates.length !== team.delegatesTo.length) {
      team.delegatesTo = filteredDelegates
      dirty = true
    }
    const filteredTrust = (team.trustFrom ?? []).filter(n => n !== removedName)   // 191
    if (filteredTrust.length !== (team.trustFrom ?? []).length) {                 // 192
      team.trustFrom = filteredTrust
      dirty = true
    }
    if (dirty) writeAgentTeam(other, team)
  }
}
```

## Failure scenario

`readAgentTeam` (lines 34-49) is the sole producer of `team.trustFrom`
inside this function. The shape it returns always has `trustFrom`
populated as a (possibly empty) string array:

```ts
// src/web/agent-team.ts:34-49
export function readAgentTeam(name: string): TeamConfig {
  const configPath = join(agentDir(name), 'agent-config.json')
  try {
    const config = JSON.parse(readFileOr(configPath, '{}'))
    const raw = config.team
    if (raw && typeof raw === 'object') {
      const role = raw.role === 'leader' ? 'leader' : 'member'
      const reportsTo = typeof raw.reportsTo === 'string' && raw.reportsTo.trim() ? raw.reportsTo.trim() : null
      const delegatesTo = Array.isArray(raw.delegatesTo) ? raw.delegatesTo.filter((x: unknown) => typeof x === 'string') : []
      const autoDelegation = !!raw.autoDelegation
      const trustFrom = Array.isArray(raw.trustFrom) ? raw.trustFrom.filter((x: unknown) => typeof x === 'string') : []  // 44
      return { role, reportsTo, delegatesTo, autoDelegation, trustFrom }                                                  // 45
    }
  } catch { /* fall through */ }
  return { ...DEFAULT_TEAM, trustFrom: [] }                                                                                // 48
}
```

`raw.trustFrom` falls through to `[]` for any non-array value
(undefined, null, primitive, object). The fallback at line 48 also
returns `trustFrom: []`. The returned `TeamConfig` therefore always has
`trustFrom` set to an array.

The only other path that mutates `team.trustFrom` is the assignment at
line 193, which runs only when the `if` on line 192 is true -- after
the `??` has already taken its left arm.

So `team.trustFrom` can never be `null` or `undefined` when
`cleanupTeamReferences` reads it, and the right-arm of `??` is dead.

## Observed impact

1. **No runtime impact.** When `team.trustFrom` is `[]`, the filter is a
   no-op; `[].length !== [].length` is `false`, so the inner `if` is
   skipped. Removing the `?? []` would not change behaviour for any
   reachable input.

2. **Coverage gate failure.** v8 branch coverage reports 96.87%
   (62/64 branches) for `src/web/agent-team.ts` against the repo's 100%
   threshold (`vitest.config.ts`). The two uncovered branches are the
   right-arm of each `??` on lines 191 and 192. Statements 100% (82/82),
   lines 100% (69/69), functions 100% (12/12). No test can exercise the
   arm without modifying the source, which task rule 1 forbids -- the
   `readAgentTeam` factory is a static local function, not a parameter,
   so vi.spyOn / vi.doMock / Object.defineProperty on the module
   namespace cannot redirect the internal call.

3. **Misleading defensiveness.** The `?? []` reads as if a missing
   `trustFrom` were possible, inviting a future reader to weaken
   `readAgentTeam`'s normalisation (e.g. by removing the fallback at
   line 48 or the `?? []` on line 44) on the assumption that this call
   site handles a missing value. The asymmetry with the line above
   (`delegatesTo` is NOT nullish-coalesced) further hides the defensive
   intent.

## Pinning test

`src/__tests__/agent-team.test.ts` exercises every reachable branch of
the file:

* `DEFAULT_TEAM` shape
* `readAgentTeam` -- missing file, missing `team` key, `null` team,
  non-object `team`, unparseable JSON, `role: 'leader'` and the
  coercion of every other value to `'member'`, `reportsTo` string /
  empty / whitespace / non-string, `delegatesTo` array-of-strings and
  non-array, `trustFrom` array-of-strings and non-array, `autoDelegation`
  boolean coercion, and the full happy-path
* `resolveSecurityProfileId` -- non-string / empty / whitespace /
  `'default'` / non-default storedProfile, `leader` and `member` roles
  (every branch of the `&&` + ternary)
* `resolveAgentSecurityProfile` -- explicit non-default, leader, member,
  missing agent
* `writeAgentTeam` -- create, merge with existing, overwrite previous,
  start-fresh on unparseable JSON
* `sanitizeTeamConfig` -- self-reference and unknown in `reportsTo`,
  `delegatesTo`, `trustFrom`, de-duplication, missing `trustFrom`,
  `MAIN_AGENT_ID` acceptance, multi-field `droppedUnknown`,
  `droppedSelf` dedup, role/autoDelegation pass-through
* `reportsToCreatesCycle` -- null / main parent, self, straight
  assignment, two-node cycle, transitive cycle, pre-existing loop
  termination
* `cleanupTeamReferences` -- no-op when no agent references the removed
  name, `reportsTo` reset to `MAIN_AGENT_ID`, removed from `delegatesTo`,
  removed from `trustFrom`, `MAIN_AGENT_ID`-self removal (`reportsTo`
  becomes `null`), missing `trustFrom`, multi-agent rewrite,
  single-pass `delegatesTo` + `trustFrom` + `reportsTo` rewrite

60 tests, all passing. Statements 100% (82/82), lines 100% (69/69),
functions 100% (12/12). Branches 96.87% (62/64); only the two `??`
right-arms remain.

## Suggested direction

Two acceptable resolutions (in order of preference):

1. **Drop both `?? []` operators.** `readAgentTeam` is the only producer
   of `team.trustFrom` inside this function, and it always returns an
   array. `delegatesTo` on the line above is treated the same way and
   is NOT nullish-coalesced, so removing the `?? []` matches the
   established pattern and removes both the dead branches and the
   misleading defensiveness in one edit. The signature `trustFrom?:
   string[]` on `TeamConfig` keeps its meaning for *callers* of
   `writeAgentTeam` -- `cleanupTeamReferences` does not need the
   defensive guard.

2. **Add `/* v8 ignore next */`** above lines 191 and 192 with a
   one-line comment naming the `readAgentTeam` factory contract that
   makes the arms dead. Silences the gate without changing runtime
   behaviour.

Until a resolution is chosen, the branch-coverage gate will fail on
this file; treat this MD as the authoritative pin and exclude
`agent-team.ts` from the branch threshold (statements/lines/functions
still gate, and remain at 100%).

Per task rule "NEVER modify src/web/agent-team.ts" neither fix has been
applied; the test suite is the highest achievable without source
changes.