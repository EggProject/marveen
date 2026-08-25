# model-suggest.ts: three unreachable `?? X` fallbacks in buildReason block 100% branch coverage

## Location

`src/web/model-suggest.ts`. The three unreachable branches are inside the
private `buildReason` helper:

1. **Line 108** — `const s = signals ?? {}`
2. **Line 172** — `Math.round(s.scheduledFreqPerDay ?? 0)`
3. **Line 182** — `${s.mcpServerCount ?? 0} MCP szerver ...`

All three are reachable in the type system but unreachable at runtime
through any sequence of public calls. `buildReason` is private (not
exported) and only has two call sites, both inside `suggestForAgent`
where the caller already pre-resolves the `signals`/signal-field
`undefined` checks.

## Excerpt

```ts
// src/web/model-suggest.ts:96-225 (buildReason, private)
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
  const s = signals ?? {}                                  // 108 -- ?? {} left arm dead
  // ...
  const schedDesc = s.scheduledFreqPerDay === undefined ? 'nincs adat'    // 170
    : s.scheduledFreqPerDay >= 10 ? `sűrű heartbeat (${Math.round(s.scheduledFreqPerDay)}x/nap) -- Haiku elegendő`  // 171
    : `ritka/közepes (${Math.round(s.scheduledFreqPerDay ?? 0)}x/nap)`   // 172 -- ?? 0 left arm dead
  // ...
  const mcpDesc = s.mcpServerCount === undefined ? 'nincs adat'           // 179
    : s.mcpServerCount >= 4 ? `${s.mcpServerCount} MCP szerver -- gazdag tool-chain`  // 180
    : s.mcpServerCount >= 2 ? `${s.mcpServerCount} MCP szerver`           // 181
    : `${s.mcpServerCount ?? 0} MCP szerver -- minimális integráció`      // 182 -- ?? 0 left arm dead
}
```

The two `suggestForAgent` callers (line 297 and 328) pre-compute `s` and
pass it as the `signals` argument:

```ts
// src/web/model-suggest.ts:286-328 (suggestForAgent, exported)
const s = signals ?? {}     // 286
// ...
return {
  // ...
  reason: buildReason(..., s, changeAdvised, ...),  // 297, 328
}
```

`s` is therefore never `null` or `undefined` when `buildReason` runs.

## Why each fallback is dead

**1. `signals ?? {}` on line 108.** `buildReason` is called only from
   `suggestForAgent`, which normalises `signals` on line 286 before
   passing it. By the time control reaches `buildReason`, `signals` is
   either `signals` (if defined) or `{}` (if undefined). The pre-resolved
   value is always a truthy object, so the `?? {}` left arm is never
   selected.

**2. `s.scheduledFreqPerDay ?? 0` on line 172.** The `else` branch of
   the preceding ternary is reached only when
   `s.scheduledFreqPerDay !== undefined` AND `s.scheduledFreqPerDay < 10`.
   The `!== undefined` guarantee already short-circuits the `?? 0` to
   its right arm. The left arm fires only when `scheduledFreqPerDay`
   is `null`/`undefined`, but by the time the inner `?? 0` is reached
   that case has already been routed to the `'nincs adat'` branch.

**3. `s.mcpServerCount ?? 0` on line 182.** Same structure as #2:
   the outer `mcpServerCount === undefined` ternary catches the
   `undefined` case and the subsequent `>= 4` / `>= 2` branches both
   access `s.mcpServerCount` directly. The left arm of the `?? 0` on
   line 182 fires only when `mcpServerCount` is `null`/`undefined`,
   which the outer conditions already rule out.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives every public input shape of `classifyPersona` and
   `suggestForAgent` — every persona keyword tier, every signal
   threshold, the context-override branch, the cost-section happy path,
   and the uncertainty-section list.
2. `buildReason` is reachable only through `suggestForAgent`, which
   pre-resolves `signals` (line 286) before passing it on. By the time
   `signals` is bound at line 96, it is always a defined object.
3. The `scheduledFreqPerDay < 10` branch (line 172) and
   `mcpServerCount < 2` branch (line 182) are reached only when the
   outer `!== undefined` check has already passed, so the `?? 0` left
   arms cannot fire.
4. v8 branch coverage caps at 98.02% (149/152) while statements, lines
   and functions all reach 100%. The remaining 3 branches are the
   three `?? X` left arms above.

## Pinning test

`src/__tests__/model-suggest.test.ts`. The reachable siblings are
covered so the gap is exactly the three `?? X` left arms above:

- `describe('suggestForAgent -- reason structure (6 sections)')` drives
  `buildReason` with `signals` defined (full signal set), proving
  `signals ?? {}` always takes the right arm.
- `describe('suggestForAgent -- AgentSignals thresholds')` includes a
  scheduledFreqPerDay=3 case (defined, < 10) and an mcpServerCount=2
  case (defined, branch boundary), proving the `?? 0` left arms are
  unreachable once the outer guards have done their job.

## Suggested direction

Three independent one-line edits; each removes the dead arm without
changing behaviour.

(a) Line 108 — drop the `?? {}`, since `suggestForAgent` always passes
    a defined object:

    ```ts
    const s = signals
    ```

    Tightening the `signals` parameter type to `AgentSignals` (omit the
    `| undefined`) would let the compiler enforce this.

(b) Line 172 — drop the `?? 0`, since the outer `=== undefined`
    ternary already rules out the `null`/`undefined` case by the time
    the inner arithmetic runs:

    ```ts
    : `ritka/közepes (${Math.round(s.scheduledFreqPerDay)}x/nap)`
    ```

(c) Line 182 — drop the `?? 0`, same reasoning:

    ```ts
    : `${s.mcpServerCount} MCP szerver -- minimális integráció`
    ```

Per task rule "NEVER modify src/web/model-suggest.ts" the source edits
are blocked until the user overrides; the test suite documents the gap
and pins every reachable sibling branch.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
