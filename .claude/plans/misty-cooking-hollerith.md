# Restore `parseChannelProvider` protection on `test/baseline`

## Context

A `routes-agents-br-baseline-partial-coverage.md` MD-t a cycle 49-es commitok (`81ef7f6` + `1e5cdfd` + `98e05e4`) "Resolved"-ra állították: a `parseChannelProvider` throw arm + `VALID_PROVIDERS` const törölve lett, a function 1-soros cast-tá redukálódott. Branch coverage 99.76% -> 100%-ot ért el, throw arm soha nem futott le a 73 hívásból (`[0, 73]`).

A user most kérte a védelem visszaállítását: "azt szeretném hogy védve legyen". Honcho memóriában explicit szabály: "When an MD claims a branch / guard / fallback is 'structurally unreachable' or 'guard-removable', the Plan agent MUST challenge that claim via code trace AND live test reproduction". A user döntése: **Revert + testelhető throw** — a védelem visszajön, és `__test_*` exporton keresztül tesztelhető is.

A védelem 3 másik rétege (`ChannelProviderType` TS union type, regex literal `matchChannelRoute`-ban, downstream consumer-ek invalid-input viselkedése) továbbra is megmarad. A throw arm **tripwire-ként** funkcionál: ha valaki új call site-ot ír, ami raw user inputot adna a függvénynek, a throw azonnal szól.

## Recommended approach

### Source edit (1 file, 2 helyen, +5/-1 lines net)

**File**: `src/web/routes/agents.ts`

**Edit #1**: Restore `VALID_PROVIDERS` const + rename + export `parseChannelProvider` -> `__test_parseChannelProvider` + restore throw arm.

```ts
// BEFORE (lines 228-230):
function parseChannelProvider(raw: string): ChannelProviderType {
  return raw as ChannelProviderType
}

// AFTER (lines 228-235):
const VALID_PROVIDERS = new Set<ChannelProviderType>(['telegram', 'slack', 'discord', 'googlechat', 'teams'])

export function __test_parseChannelProvider(raw: string): ChannelProviderType {
  if (!VALID_PROVIDERS.has(raw as ChannelProviderType)) {
    throw new Error(`unknown channel provider: ${raw}`)
  }
  return raw as ChannelProviderType
}
```

**Edit #2**: A single production caller frissítése a megváltozott function-névre.

```ts
// BEFORE (line 239):
const provider = parseChannelProvider(newMatch[2])

// AFTER (line 244 post-edit):
const provider = __test_parseChannelProvider(newMatch[2])
```

A downstream sorok +5-tel eltolódnak (mivel +5 lines-t adtunk a forráshoz). A kód többi része (`matchChannelRoute` regex a 240. sorban, callers a 1038, 1054, 1396, 1423, 1477, 1498 sorokban) automatikusan működik.

**Miért biztonságos ez a forma**:
- A `__test_` prefix a projekt konvenció (cycle 47-48-as pattern, `channel-coordinator-internals-untestable.md` MD ezt javasolja)
- A függvény szignatúrája változatlan (`(string) => ChannelProviderType`), csak az export kulcsszó és a név prefix változik
- A 6 caller (`agents.ts:1033, 1049, 1391, 1418, 1472, 1493`) a return-értéket használja (`[name, provider]` tuple), nem a függvény referenciáját — így a rename nem érinti őket, csak a belső `parseChannelProvider(newMatch[2])` hívást a 239. sorban (új: 244. sor)

### Test edit (1 file, 1 új `it()` block)

**File**: `src/__tests__/agents-routes.test.ts`

**Edit**: Adjunk hozzá egy új `it()` block-ot a meglévő `describe('baseline: parseChannelProvider / matchChannelRoute branches', ...)` blokkhoz (lines 3932-3948). A meglévő teszt a legacy URL-t teszteli (`/api/agents/a/telegram/test`), az új a throw arm-ot exercise-eli közvetlen `__test_parseChannelProvider('invalid')` hívással.

Import pattern (ESM `.js` extension, a teszt fájl meglévő konvenciója szerint — line 13: `../web/agent-message-wrap.js`):

```ts
import { __test_parseChannelProvider } from '../web/routes/agents.js'
```

Ez az import a teszt fájl tetejére kerül, a többi import közé.

Az új teszt block (a meglévő describe-en belülre):

```ts
it('throws on invalid channel provider string', () => {
  // A throw arm tripwire: ha egy jövőbeli API-bővítés raw user inputot adna
  // __test_parseChannelProvider-nak (a matchChannelRoute regex-gate megkerülésével),
  // a throw azonnal jelzi a típus-szintű garancia sérülését.
  expect(() => __test_parseChannelProvider('invalid')).toThrow(
    'unknown channel provider: invalid',
  )
  expect(() => __test_parseChannelProvider('foo')).toThrow(
    'unknown channel provider: foo',
  )
})
```

**Miért fontos ez a teszt**: A throw arm mostantól **tesztelhető** és **lefedett** (bid=3 counts [3,2] vagy hasonló — a throw ág is kap coverage-ot). A 100% branch coverage megmarad.

**Anti-pattern check** (CLAUDE.md §8): A `describe('baseline: parseChannelProvider / matchChannelRoute branches')` meglévő pin tesztje a legacy URL-t teszteli, nem hív `__test_parseChannelProvider`-t közvetlenül. Az új `it()` block bővítés, nem `it()` törlés.

### Documentation updates (commit 2, fixup)

**File 1**: `docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md`

Update az új állapothoz:
- Cseréljük ki a `Resolved: 2026-08-26 81ef7f6` headert `Resolved: 2026-08-26 <new-SHA>`-ra
- A "Location" szekció 1. kategóriája: "parseChannelProvider `throw new Error` at line 232 (the `return null` arm was deleted by `3e1dd3f`...)" legyen: "A `parseChannelProvider` `throw new Error` arm at line 232 (the `return null` arm was deleted by `3e1dd3f`) was **restored** with the `__test_` export pattern. The function is now `export function __test_parseChannelProvider` (post-fix line 230). The throw arm IS tested (covered by agents-routes.test.ts:<line> direct call)."
- A "Pinning test" szekció: vegyük fel az új tesztet a listába. A többi pin (extractBotId 4208, PUT security 404 4316, kanban row 1100) marad.
- A "Suggested direction" (a) pontja: legyen "DONE in 81ef7f6 (deletion) + REVERTED+RESTORED in <new-SHA> via `__test_*` test-only export pattern, making the throw arm both runtime-protected and testable"
- A "Failure scenario" 3. pontja: post-fix branch coverage 100% (ugyanaz marad, mint az előző MD-ben)
- A `VALID_PROVIDERS` const sor: vegyük vissza a kódba, a post-fix line reference: 228

**File 2**: `docs/needs-to-be-fix/INDEX.md`

Row 149 update:
- Az eddigi szöveg: "Resolved: 2026-08-26 81ef7f6 (throw arm + VALID_PROVIDERS const deleted; kanban priority else-arm covered by agents-routes.test.ts:1099 row addition; file-level branch coverage 99.76% -> 100%)"
- Az új szöveg: "Resolved: 2026-08-26 <new-SHA> (protection restored: VALID_PROVIDERS const + parseChannelProvider throw arm re-added; function renamed to `__test_parseChannelProvider` (exported with `__test_` test-only prefix per cycle 47-48 pattern); new test at agents-routes.test.ts:<line> exercises the throw arm via direct call; file-level branch coverage maintained at 100%)"

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/src/web/routes/agents.ts` (2120 lines, lines 228-230 edited; downstream lines shift by +5)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/agents-routes.test.ts` (4449 lines, +1 import, +1 `it()` block at line ~3945)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md` (MD body update + new SHA in header)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (row 149 update + new SHA in Resolved cell)

## Reused infrastructure (no new code)

- Existing `__test_*` export pattern from cycle 47-48 (Honcho memory: "channel-coordinator-internals-untestable.md javasol direction #1: __test_* exports")
- Existing test describe block at `agents-routes.test.ts:3932` for `parseChannelProvider / matchChannelRoute branches` — az új `it()` block itt kap helyet
- ESM `.js` extension import convention (test file line 13: `../web/agent-message-wrap.js`)
- `coverage/` directory gitignored at .gitignore:99 (no commit artifact)

## Commit plan

| # | Commit | Description |
|---|--------|-------------|
| 1 | `fix(routes-agents): restore parseChannelProvider throw arm via __test_* export pattern` | 2 files: src edit (+5/-1 net) + test edit (+1 import + ~5 lines new it()). 1 commit. |
| 2 | `docs(index+md): update routes-agents-br-baseline-partial-coverage for protection-restored approach` | 2 files: MD body update + INDEX row update. 1 commit. |

**No push** (CLAUDE.md §6, user owns push).

**SHA handling** (CLAUDE.md §8): Az implementer commit (1) message-ében a MD-re való hivatkozásnál használjunk `(this commit)` placeholdert, majd commit 2 (Phase C) kitölti a valódi SHA-t. Ez véd az amend-ciklus ellen.

## Workflow (3-phase, cycles 47-48 pattern)

### Phase A: Implementation (1 subagent, worktree-isolated)

```bash
git worktree add --detach /tmp/claw-routes-protect test/baseline
ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-routes-protect/node_modules
```

Subagent prompt (Agent tool, `isolation: worktree`):
- Read lines 227-246 of src/web/routes/agents.ts + lines 3930-3950 of agents-routes.test.ts + lines 20-30 of agents-routes.test.ts (imports) to verify ground truth (CLAUDE.md §8: MD file:line references must be Read-verified)
- Apply the 3 edits: restore `VALID_PROVIDERS` const, rename `parseChannelProvider` to `__test_parseChannelProvider` with `export`, restore throw arm, update internal call site at line 239 (post-edit: 244), add new import + new `it()` block
- Run `bun --bun vitest run src/__tests__/agents-routes.test.ts` until pass
- Run `bun --bun vitest run --coverage src/__tests__/agents-routes.test.ts` — must show branches: 100% (was 856/856 after 81ef7f6; should remain 100% with throw arm now exercised by new test)
- Run full suite: `bun --bun vitest run` — must be 0 failed, 0 skipped (the 23 pre-existing failures from baseline `a5e2318` should remain matching)
- Anti-pattern grep: 0 hits for `mock*.not.toHaveBeenCalled|vi.fn().not.toHaveBeenCalled`
- `.gitignore` check: `coverage/` is gitignored
- Commit with the message above (use `(this commit)` placeholder for MD reference). Report SHA.
- Do NOT push. Do NOT modify MD or INDEX.md.

### Phase B: 2 parallel verification subagents (ALPHA + BETA)

Two Agent tool calls in **single message**, both with `isolation: worktree`. Each independently:
- `git checkout <implementer-SHA>` in a fresh worktree
- Run `bun --bun vitest run` (full suite)
- Run `bun --bun vitest run --coverage src/__tests__/agents-routes.test.ts`
- Read `src/web/routes/agents.ts` lines 228-244 to verify post-edit state:
  - `VALID_PROVIDERS` const exists at line 228
  - `__test_parseChannelProvider` is `export function`
  - throw arm exists with `throw new Error` 
  - Line 244 (post-edit) uses `__test_parseChannelProvider(newMatch[2])`
- Read `src/__tests__/agents-routes.test.ts` lines 20-30 (imports) + 3945-3955 (new `it()` block) to verify the new test exists and imports correctly
- Each reports ground-truth pass/fail + coverage numbers + behavioral-diff assessment
- Each checks `.gitignore` line 99 for `coverage/` is gitignored

### Phase C: SHA fixup + docs sync

Per CLAUDE.md §8 (worktree-isolated commit back-merge):
```bash
git worktree remove /tmp/claw-routes-protect --force
git merge --ff-only <implementer-SHA>
```

Then update MD + INDEX.md with the actual SHA (already known at this point, no `(this commit)` placeholder needed). Single doc commit. Use single quotes around the commit message to avoid backtick parse errors (CLAUDE.md §8 cycle 47-48 lesson).

### Final step: `/code-review max --fix`

User must invoke `/code-review max --fix <SHA-range>` manually in the terminal. CLAUDE.md §8: "`/code-review` skill `disable-model-invocation` flag-gel rendelkezik... CSAK a user hívhatja manuálisan."

The SHA range will be from `98e05e4` (current test/baseline HEAD) to the new HEAD, encompassing the 2 new commits.

## Verification

End-to-end checks before declaring done:

1. `cd /tmp/claw-routes-protect && bun --bun vitest run` — 0 failed, 0 skipped
2. `bun --bun vitest run --coverage src/__tests__/agents-routes.test.ts` — branches 100%, lines 100% (throw arm now exercised counts)
3. `grep -n "VALID_PROVIDERS" src/web/routes/agents.ts` — must show 2 hits (const + use)
4. `grep -n "throw new Error.*unknown channel provider" src/web/routes/agents.ts` — must show 1 hit (throw arm restored)
5. `grep -n "__test_parseChannelProvider" src/web/routes/agents.ts` — must show 2 hits (decl + call)
6. `grep -n "__test_parseChannelProvider" src/__tests__/agents-routes.test.ts` — must show 2 hits (import + test call)
7. `grep -n "parseChannelProvider\b" src/web/routes/agents.ts src/__tests__/agents-routes.test.ts` — must show only the `__test_parseChannelProvider` references (no bare `parseChannelProvider` left)
8. `cat docs/needs-to-be-fix/INDEX.md | grep -A1 "routes-agents-br-baseline-partial-coverage"` — shows `Resolved: 2026-08-26 <new-SHA>` with updated description
9. `/code-review max --fix <SHA-range>` — user-invoked; findings applied per CLAUDE.md post-fix commit rule

## Risk assessment

| Edit | Blast radius | Mitigation |
|------|--------------|------------|
| Restore `VALID_PROVIDERS` const | Zero — only adds const, no other consumers added | Phase B runs full suite |
| Restore throw arm | Zero production behavior change (throw arm unreachable through public API). Adds tripwire for future API extensions. | Phase B reads call site + runs full suite |
| Rename + export function | Narrow — only affects the function declaration and 1 internal call site. 6 downstream callers of `matchChannelRoute` are unaffected (they use the return tuple, not the function). | Phase B reads call site + grep verifies no stray `parseChannelProvider` references |
| Add new test for `__test_parseChannelProvider` | Zero — pure add (no existing test removed or modified) | Phase B verifies test count delta = +1 `it()` block |
| Add new import in test file | Negligible — standard ESM `.js` extension import | Phase B reads imports section |

Net risk: **very low**. Well-precedented by `3e1dd3f` (return-null deletion pattern), `232fac7` (cycle 47 message-router reduction), cycle 47-48 `__test_*` export pattern from `channel-coordinator-internals-untestable.md`.

## Anti-pattern checks (per CLAUDE.md §8)

- `.not.toHaveBeenCalled()` on pre-pass/setup helpers: `grep -nE 'mock\w*\.not\.toHaveBeenCalled|vi\.fn\(\)\.not\.toHaveBeenCalled' src/__tests__/agents-routes.test.ts` must return **0 hits** before AND after.
- Production-caller grep for new integration: `__test_parseChannelProvider` has 1 production caller (line 244 post-edit), confirmed via `grep -rn '\b__test_parseChannelProvider\b' src/ --include='*.ts' | grep -v __tests__`. NOT dead code.
- `.gitignore` `coverage/` check: confirmed at .gitignore:99 — coverage dir not committed.
- Typecheck: `bunx tsc --noEmit | wc -l` HEAD measurement before Phase A (baseline ~2253 per cycle 35 drift; measure fresh). Post-edit: same count or +0 (no new types added).
- Istanbul optional chaining: not applicable (no `?.` operators introduced).
- Em-dash check on commit message: 0 em-dashes (CLAUDE.md §6 "Nincs gondolatjel (em dash). Soha."). Use `--` or `:` instead.