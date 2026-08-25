# fleet-transfer.ts: `fleet.agents ?? []` nullish-coalesce right-arms are unreachable (7 sites)

## Locations

`src/web/fleet-transfer.ts`, 7 occurrences of `fleet.agents ?? []` whose
right-arm (the `[]` fallback) is structurally unreachable:

| Line | Context |
| --- | --- |
| 3387 | `validateNames` for-of iteráció |
| 3425 | `buildDiffReport` newAgents |
| 3462 | `buildDiffReport` existingAgentsToOverwrite |
| 3467 | `buildDiffReport` hasChannels (any-agent) |
| 3682 | `applyFleetImport` for-of iteráció |
| 3892 | `applyFleetImport` `logger.info` (completed) |
| 3898 | `applyFleetImport` return value |

## Excerpt

```ts
// 3387
for (const agent of fleet.agents ?? []) { ... }

// 3425
const newAgents = (fleet.agents ?? []).map(a => a.name).filter(n => !existingAgents.has(n))

// 3462
const existingAgentsToOverwrite = (fleet.agents ?? []).map(a => a.name).filter(n => existingAgents.has(n))

// 3467
const hasChannels = Object.keys(fleet.mainAgent?.channelsAccess ?? {}).length > 0 ||
  (fleet.agents ?? []).some(a => Object.keys(a.channelsAccess ?? {}).length > 0)

// 3682
for (const agent of fleet.agents ?? []) { writeAgentFiles(agent, tracker) }

// 3892
logger.info({ agents: (fleet.agents ?? []).map(a => a.name) }, 'Fleet import completed')

// 3898
agents: (fleet.agents ?? []).map(a => a.name),
```

## Failure scenario

`validateSchema` (line 720-743) is a hard gatekeeper that runs before
`validateNames`, `buildDiffReport`, and `applyFleetImport`:

```ts
// src/web/fleet-transfer.ts:741
if (!Array.isArray(f.agents)) errors.push('agents mező hiányzik vagy nem tömb.')
```

When `f.agents` is `null` or `undefined`, the schema validation pushes the
error and `importFleet` returns the error result at line 1019:

```ts
if (schemaErrors.length > 0) {
  return { ...EMPTY_DIFF, errors: schemaErrors }
}
```

This means the import is rejected BEFORE any of the 7 `?? []` sites are
reached. The right-arm of each `??` can never fire through the public
`importFleet` API.

## Observed impact

1. **No runtime impact.** When `fleet.agents` is an array (the only
   accepted case), the `??` always takes its left arm.

2. **Coverage gate failure.** v8 branch coverage reports 97.53%
   (435/446 branches) for `src/web/fleet-transfer.ts`. 7 uncovered
   branches are the right-arms of these `??` operators.

3. **Misleading defensiveness.** The `?? []` reads as if a missing
   `agents` were possible, but the schema validation explicitly forbids
   it. A future reader might weaken the schema check, expecting the `??`
   to handle the gap.

## Baseline state

- Statements 99.41% (512/515)
- Branches 97.53% (435/446) — 7 uncovered, all `fleet.agents ?? []` right-arms
- Functions 97.77% (44/45) — 1 uncovered (assertSafeName, dead code)
- Lines 99.35% (460/463) — 3 uncovered (assertSafeName function body)

The baseline test
`src/__tests__/fleet-transfer-branches.test.ts` -- "agents: null is rejected
by the schema validation (the ?? [] right-arms never fire)" -- documents
the schema-rejection behaviour and confirms the right-arms are unreachable.

## Suggested direction

Drop the `?? []` on lines 3387, 3425, 3462, 3467, 3682, 3892, and 3898.
The schema validation guarantees `fleet.agents` is always an array, so
the fallback is dead code. This matches the established pattern in
`agent-team.ts` where `delegatesTo` is treated the same way and is NOT
nullish-coalesced.

Until a resolution is chosen, the branch-coverage gate will fail on
this file; treat this MD as the authoritative pin for the 7 unreachable
right-arms.

Per task rule "NEVER modify src/web/fleet-transfer.ts" no source edit has
been applied; the test suite is the highest achievable without source
changes.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
