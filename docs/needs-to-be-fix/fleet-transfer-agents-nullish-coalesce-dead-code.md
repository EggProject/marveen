# fleet-transfer.ts: `fleet.agents ?? []` nullish-coalesce right arm is unreachable

## Location

`src/web/fleet-transfer.ts`, multiple line numbers (every `fleet.agents ?? []` / `fleet.agents ?? []).map(...)` / `(fleet.agents ?? []).some(...)` expression inside the `importFleet` flow).

The relevant lines:

- Line 756: `for (const agent of fleet.agents ?? []) {` (validateNames)
- Line 794: `const newAgents = (fleet.agents ?? []).map(a => a.name).filter(...)` (buildDiffReport)
- Line 831: `const existingAgentsToOverwrite = (fleet.agents ?? []).map(a => a.name).filter(...)` (buildDiffReport)
- Line 836: `(fleet.agents ?? []).some(a => Object.keys(a.channelsAccess ?? {}).length > 0)` (buildDiffReport)
- Line 1051: `for (const agent of fleet.agents ?? []) {` (apply phase)
- Line 1261: `logger.info({ agents: (fleet.agents ?? []).map(a => a.name) }, ...)` (apply logger)
- Line 1267: `agents: (fleet.agents ?? []).map(a => a.name),` (ImportResult payload)

## Excerpt

```ts
// src/web/fleet-transfer.ts:720-742 -- validateSchema
function validateSchema(fleet: unknown): string[] {
  const errors: string[] = []
  if (!fleet || typeof fleet !== 'object') {
    errors.push('Érvénytelen JSON: a gyökér nem objektum.')
    return errors
  }
  const f = fleet as Record<string, unknown>
  if (f.schemaVersion === undefined || f.schemaVersion === null) {
    errors.push('schemaVersion hiányzik -- ...')
    return errors
  }
  if (f.schemaVersion !== FLEET_SCHEMA_VERSION) {
    ...
    return errors
  }
  if (!Array.isArray(f.agents)) errors.push('agents mező hiányzik vagy nem tömb.')
  return errors
}
```

```ts
// src/web/fleet-transfer.ts:984-1027 -- importFleet early returns
export function importFleet(
  rawBody: string,
  options: { vaultPassword?: string; apply: boolean },
): DiffReport | ImportResult {
  ...
  const schemaErrors = validateSchema(fleet)
  if (schemaErrors.length > 0) {
    return { ...EMPTY_DIFF, errors: schemaErrors }
  }
  const nameErrors = validateNames(fleet)
  if (nameErrors.length > 0) {
    return { ...EMPTY_DIFF, errors: nameErrors }
  }
  ...
}
```

The `validateSchema` function enforces `Array.isArray(f.agents)`. If
`f.agents` is null, undefined, or any non-array value, `validateSchema`
pushes an error and `importFleet` returns early — every code path that
later evaluates `fleet.agents ?? []` is unreachable when `fleet.agents`
is nullish.

## Issue

`fleet.agents ?? []` is a defensive guard whose left arm is always
truthy in every reachable execution path. The right arm (`[]`) only
fires when `fleet.agents` is null/undefined — but `validateSchema` blocks
that input before any of the downstream expressions are reached.

`buildDiffReport`, `validateNames`, and the apply phase all assume
`fleet.agents` is an array (a documented precondition of the schema
contract). The `?? []` fallback is the only thing preventing a
`TypeError: Cannot read properties of undefined (reading 'map')` if the
schema contract ever drifts.

## Why this is a defect

- The defensive fallback masks a future schema-violation bug: if
  `validateSchema` is ever weakened (or new code paths bypass it), the
  `?? []` silently turns the missing field into an empty array and the
  apply phase silently produces a "no-op" result instead of bubbling
  the schema error up.
- The branches contribute 7 uncovered `branch-1` lines in the v8
  coverage report. They are dead code, not "missing tests".

## Suggested fix (do NOT apply here)

Pick one of:

(a) Drop the `?? []` fallbacks on `fleet.agents` and assert the
    invariant in a single place (the `validateSchema` boundary):

  ```ts
  // validateNames (line 756)
  for (const agent of fleet.agents) { ... }

  // buildDiffReport (line 794, 831, 836)
  const newAgents = fleet.agents.map(a => a.name).filter(...)
  const existingAgentsToOverwrite = fleet.agents.map(a => a.name).filter(...)
  const hasChannels = Object.keys(fleet.mainAgent?.channelsAccess ?? {}).length > 0 ||
    fleet.agents.some(a => Object.keys(a.channelsAccess ?? {}).length > 0)

  // apply phase (line 1051, 1261, 1267)
  for (const agent of fleet.agents) { writeAgentFiles(agent, tracker) }
  logger.info({ agents: fleet.agents.map(a => a.name) }, 'Fleet import completed')
  agents: fleet.agents.map(a => a.name),
  ```

(b) Keep the `?? []` but tighten the type system so the
    `?? []` is enforced at compile time:

  ```ts
  function importFleet(...): DiffReport | ImportResult {
    ...
    const fleet = JSON.parse(...) as FleetJson
    validateSchema(fleet)  // returns errors if fleet.agents is non-array
    // After validateSchema, fleet.agents is guaranteed to be an array.
    // The `?? []` is a redundant safety net.
  }
  ```

Either edit removes the 7 dead branches without changing observable
behaviour.

## Pinning test

The remaining sibling branches under the same pattern (`fleet.skills
?? []`, `fleet.scheduledTasks ?? []`, etc.) ARE covered by tests
because `validateSchema` does NOT enforce those fields as arrays —
they can be null/undefined and still pass the schema. The pinning test
in `src/__tests__/fleet-transfer-branches.test.ts` exercises the
sibling paths via `agents: []` plus `skills: null` (which
JSON.stringify preserves as null, unlike `undefined` which is dropped).

```ts
// src/__tests__/fleet-transfer-branches.test.ts
it('apply phase: undefined array fields walk the ?? [] fallback', async () => {
  const { importFleet } = await import('../web/fleet-transfer.js')
  const body = JSON.stringify({
    schemaVersion: 1,
    ...
    agents: [],
    skills: null,
    scheduledTasks: null,
    memories: null,
    dailyLogs: null,
    kanban: null,
    ideaBox: null,
    dashboardSettings: { ... },
  })
  const result = importFleet(body, { apply: true }) as any
  expect(result.ok).toBe(true)
  expect(result.imported).toMatchObject({
    globalSkills: 0,
    scheduledTasks: 0,
    memories: 0,
    kanbanCards: 0,
    labels: 0,
    dailyLogs: 0,
    ideaBox: 0,
  })
})
```

The `fleet.agents ?? []` branches stay uncovered because the test
cannot bypass `validateSchema`'s `Array.isArray(f.agents)` check.

Per task rule "NEVER modify src/web/fleet-transfer.ts" the source
edits are blocked until the user overrides; the test suite documents
the gap and pins every reachable sibling branch.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
