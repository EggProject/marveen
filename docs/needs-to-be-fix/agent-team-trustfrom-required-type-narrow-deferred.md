# agent-team.ts:191,192 - trustFrom type-narrow deferred

## Context

Two `(team.trustFrom ?? [])` calls in `src/web/agent-team.ts:191,192`. The
strategy: tighten `TeamConfig.trustFrom?: string[]` to required `string[]`,
then drop the `?? []` fallbacks.

The same field also appears on `TeamConfigForTrust.trustFrom?: string[]` in
`src/team-trust.ts:26`.

## What was tried

Changed `TeamConfig.trustFrom?: string[]` to `trustFrom: string[]` and
`TeamConfigForTrust.trustFrom?: string[]` to `trustFrom: string[]`.

## Why deferred

`bun run typecheck` error count jumped from 1703 to 1716 (+13). Tolerance
is +5; +13 exceeds the budget.

12 of the 13 new errors are caused by the type tightening. The remaining
errors are unrelated pre-existing issues that the type change incidentally
exposed.

### agent-team.ts specific errors (10x)

`src/__tests__/agent-team.test.ts:359,371,383,395,407,420,457,482,494,534`
all construct a `TeamConfig` literal without `trustFrom`:

```
error TS2345: Argument of type '{ role: "member"; reportsTo: ...; ...; }'
  is not assignable to parameter of type 'TeamConfig'.
```

These are mock helper literals (`{ role: 'member', reportsTo: ..., ... }`)
that omit `trustFrom` because the type currently allows it to be optional.

### team-trust.ts specific errors (2x)

`src/__tests__/team-trust.test.ts:126,127` build a `TeamConfigForTrust`
without `trustFrom`:

```
error TS2741: Property 'trustFrom' is missing in type
  '{ reportsTo: null; delegatesTo: never[]; }'
  but required in type 'TeamConfigForTrust'.
```

### Indirect errors (1x)

`src/__tests__/agents-routes.test.ts:1930` -- the mock discriminated union
narrows on `trustFrom: []`, so removing `trustFrom` from the union arms
breaks the type inference for the rest of the test file. Fixing the mocks
upstream ripples here.

## Forward path

The narrowing is mechanically clean but requires ~12 test literal edits.
A follow-up refactor commit can:

1. Add `trustFrom: []` to every TeamConfig literal in `agent-team.test.ts`
   (~10 call sites).
2. Add `trustFrom: []` to the two TeamConfigForTrust literals in
   `team-trust.test.ts`.
3. Update the `agents-routes.test.ts:1930` mock to keep `trustFrom: []`
   consistent across union arms.
4. Re-run typecheck; expected delta: 0.

Then this MD can be retired and the `?? []` fallbacks at
`src/web/agent-team.ts:191,192` dropped.

## Files inspected

- `src/web/agent-team.ts:14-24,139,191,192`
- `src/team-trust.ts:23-27,72,73`
- `src/__tests__/agent-team.test.ts:359-534`
- `src/__tests__/team-trust.test.ts:126-127`
- `src/__tests__/agents-routes.test.ts:1930`