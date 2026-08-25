# model-suggest.ts: `buildReason` `signals` and field-specific `?? 0` fallbacks are unreachable

## Location

`src/web/model-suggest.ts`, three independent defensive branches:

```ts
// line 108 -- buildReason opening
const s = signals ?? {}

// line 172 -- scheduledFreqPerDay else-branch fallback
`ritka/közepes (${Math.round(s.scheduledFreqPerDay ?? 0)}x/nap)`

// line 182 -- mcpServerCount else-branch fallback
`${s.mcpServerCount ?? 0} MCP szerver -- minimális integráció`
```

## Excerpt

```ts
// src/web/model-suggest.ts:96-108
function buildReason(
  currentModel: string,
  suggestedModel: string,
  contextTokens: number,
  opusKeyHits: number,
  haikuKeyHits: number,
  opusSignalHits: number,
  haikuSignalHits: number,
  signals: AgentSignals | undefined,
  changeAdvised: boolean,
  contextOverride: boolean,
): string {
  const s = signals ?? {}
  ...
}
```

```ts
// src/web/model-suggest.ts:167-172
const schedIcon = s.scheduledFreqPerDay === undefined ? '⚠️'
  : s.scheduledFreqPerDay >= 10 ? '✅'
  : '⚠️'
const schedDesc = s.scheduledFreqPerDay === undefined ? 'nincs adat'
  : s.scheduledFreqPerDay >= 10 ? `sűrű heartbeat (${Math.round(s.scheduledFreqPerDay)}x/nap) -- Haiku elegendő`
  : `ritka/közepes (${Math.round(s.scheduledFreqPerDay ?? 0)}x/nap)`
```

```ts
// src/web/model-suggest.ts:175-182
const mcpIcon = s.mcpServerCount === undefined ? '⚠️'
  : s.mcpServerCount >= 4 ? '❌'
  : s.mcpServerCount >= 2 ? '⚠️'
  : '✅'
const mcpDesc = s.mcpServerCount === undefined ? 'nincs adat'
  : s.mcpServerCount >= 4 ? `${s.mcpServerCount} MCP szerver -- gazdag tool-chain`
  : s.mcpServerCount >= 2 ? `${s.mcpServerCount} MCP szerver`
  : `${s.mcpServerCount ?? 0} MCP szerver -- minimális integráció`
```

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

`buildReason` is module-private (not exported). Its only call sites are
inside `suggestForAgent`, which pre-applies the `?? {}` default:

```ts
// src/web/model-suggest.ts:279-286
export function suggestForAgent(
  agentName: string,
  currentModel: ModelId,
  personaText: string,
  contextTokens = 0,
  signals?: AgentSignals,
): AgentSuggestionResult {
  const s = signals ?? {}
  ...
  return {
    ...
    reason: buildReason(... s ...),
  }
}
```

The `s` passed into `buildReason` is therefore guaranteed to be an
object (never `undefined`). Inside `buildReason`, the local `s` is
reassigned via `const s = signals ?? {}` (line 108), which short-
circuits on the truthy left operand and never evaluates the right
arm `{}`.

The same pattern applies to the two `?? 0` fallbacks for
`scheduledFreqPerDay` and `mcpServerCount` (lines 172, 182). Both
appear inside the else branch of an outer `s.<field> === undefined`
ternary; the else branch can only execute when the field is NOT
undefined, so the `?? 0` inside the else is dead.

v8 coverage on these three branches:
- line 108 binary-expr: `counts=[18, 0]` — left arm hit 18 times, right 0
- line 172 binary-expr: `counts=[3, 0]` — left arm hit 3 times, right 0
- line 182 binary-expr: `counts=[1, 0]` — left arm hit 1 time, right 0

## Pinning test

`src/__tests__/model-suggest.test.ts` covers every reachable branch of
`suggestForAgent` and the resulting reason text. The unreachable
sibling arms at lines 108, 172, 182 have no reachable input and are
documented here without test-side assertions.

## Suggested direction

Three equivalent fixes; any is acceptable:

1. **Drop the `?? {}` / `?? 0` arms** in `buildReason`:

   ```ts
   function buildReason(... signals: AgentSignals ...) {
     const s: AgentSignals = signals
     ...
   }
   ```

   And remove the inner `?? 0` operands at lines 172 and 182.

2. **Type signals as non-undefined** at the `buildReason` boundary
   (the only public caller already passes a non-undefined value):

   ```ts
   function buildReason(... signals: AgentSignals, ...) { ... }
   ```

   Force the caller to default via `signals ?? {}` before invoking.

3. **Leave as defensive belts** and accept the dead branches; the cost
   is three uncovered v8 branches and a slightly misleading code path.

Per task rule "NEVER modify src/web/model-suggest.ts" the source edits
are blocked until the user overrides; the test suite documents the
gap and pins every reachable sibling branch.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
