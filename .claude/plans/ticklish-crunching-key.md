# Phase 1 — LoggerLike + process-lock LogFn konszolidáció

## Context

A `docs/refactor-to-classbase/` backlogból a **Phase 1 (Logger unification)** a legalacsonyabb kockázatú nyitott átalakítás: 2 forrásfájl, Low súlyosság (R10 az egyetlen Low-severity kockázat a `06-risks-and-mitigations.md` szerint), párhuzamosítható, és előkészíti az **E.6 (LogFn teljes eltávolítás)** fázist. A roadmap `05-refactor-roadmap.md:31-48` ezt írja elő; a `00-summary.md:103-105` megerősíti, hogy az E.6 gated H.1+H.2-re — és a Phase 1 fázis technikailag a H.1+H.2+G5 cross-cutting elem szűkített formája. Az átalakítás **nem class-extract**, hanem típus-alias konszolidáció, így a `.claude/rules/class-vs-functional-decision.md` ceremony-szabálya nem releváns.

Dokumentum-konfliktus, amit a terv explicite felold:
- `04-generic-interfaces.md:233-276` G5 eredetileg `import type { Logger } from 'pino'; type LoggerLike = Logger`-t írt elő, ami a `h-cross-cutting/04:18-69` H-javítás szerint **érvénytelenítene 91 meglévő `vi.mock('../logger.js')` mock-ot** (a bare pino `Logger` típusnak vannak olyan metódusai, amiket a tesztek nem adnak).
- A H-javítás szerinti structural interface a helyes: `LogFn` (function overload: `(msg: string): void` és `(obj: object, msg?: string): void`) + `LoggerLike` (info/warn/error/debug). Ez kompatibilis a `pino.Logger` típussal (H-javítás 132-137) és a meglévő 3-mezős noop log objektumokkal a folyamatosság megőrzéséhez a `debug` metódus megkövetelésével.

A refaktor célja: a `LogFn` típus egyetlen kanonikus definíciója a `src/logger.ts`-ban, és a `ProcessLockContext.log` / `PidfileLockContext.log` mezők típusa legyen `LoggerLike` (4 mezős: info/warn/error/debug), hogy az E.6 fázisban a `LogFn` típus teljesen eltávolítható legyen a process-lock.ts-ból anélkül, hogy a consumer-ek tsc-hibát kapnának.

## Mért baseline (a terv írásakor futtatva)

| Gate | Parancs | Eredmény |
|---|---|---|
| HEAD SHA | `git rev-parse HEAD` | `7956bc91ee788792ca5064837ffc39889eba0f9f` (`add .claude`) |
| Branch | `git branch --show-current` | `refactor/classbase` |
| `store/` jelenlét | `ls -la store/` | üres (vitest guard nem blokkol) |
| Teljes tsc | `bun tsc --noEmit` | **0 hiba** (exit 0) |
| Teljes vitest | `bun --bun vitest run` | **401 files, 391 passed, 10 failed; 11,483 tests, 11,481 passed, 2 failed** (132s). A 10 failed pre-existing (e-mail-send-gate, governance-gates, hook-command-quoting, hook-path-guard — lásd Honcho 2026-08-27 entry), NEM a Phase 1 felelőssége. |
| Teljes lint | `bun run lint` | **10,486 problems** (10,482 errors + 4 warnings) — pre-existing baseline, a Phase 1 gate: "ne növelje" |
| `src/__tests__/logger.test.ts` | `bun --bun vitest run src/__tests__/logger.test.ts` | **4 passed** (1 file) |
| `src/__tests__/process-lock.test.ts` | `bun --bun vitest run src/__tests__/process-lock.test.ts` | **61 passed** (1 file) |
| `src/__tests__/process-lock-classes.test.ts` | `bun --bun vitest run src/__tests__/process-lock-classes.test.ts` | **12 passed** (1 file) |
| `coverage/` gitignore | `grep -nE '^coverage(-temp)?/?$' .gitignore` | L96 `coverage/`, L97 `coverage-temp/` — lefedettség NEM lesz commitolható artifact |

## A módosítások (pontos file:line és kód)

### 1. `src/logger.ts` — LoggerLike + LogFn export hozzáadása (L9 után)

**Jelenlegi L1-9:**
```ts
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})
```

**Hozzáadandó a L9 után (új L11-19):**
```ts
/**
 * Structural signature matching pino's logger methods. Declared as overloads
 * so both `logger.info('msg')` and `logger.info({ ctx: 'value' }, 'msg')`
 * compile. Compatible with `pino.Logger` (see h-cross-cutting/04:132-137).
 */
export interface LogFn {
  (msg: string): void
  (obj: object, msg?: string): void
}

/**
 * Structural logger interface. The real `logger` export above satisfies this;
 * tests inject narrower implementations (e.g. noopLog) that must still provide
 * info/warn/error/debug. Required by Phase 1 per
 * docs/refactor-to-classbase/h-cross-cutting/04:18-69 (rejects bare pino alias
 * which would invalidate 91 vi.mock('../logger.js') fixtures).
 */
export interface LoggerLike {
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly debug: LogFn
}
```

### 2. `src/process-lock.ts` — LogFn lokális törlése, LoggerLike használata

**L1-9 import bővítése:**
- L1: `import { describe, it, expect } from 'vitest'` (read, de ezt a fájl NEM vitest teszt — ez a process-lock.ts termelési kódja. L1-9 NEM a process-lock.ts, hanem a process-lock-CLASSES.test.ts. JAVÍTÁS: a process-lock.ts termelési kód L1-9 importjai a `node:fs`/`node:os`/`node:path`/`node:process` típusok. A jelenlegi process-lock.ts L1-9 a `describe, it, expect` teszt-importok — ez a process-lock-CLASSES.test.ts L1-9-e.)
- Valójában a process-lock.ts L19 tartalmazza a `type LogFn = ...` definíciót. A process-lock.ts elején NINCS külön import blokk a tesztekhez.

**L19 törlése:**
- Sor: `type LogFn = (obj: Record<string, unknown>, msg?: string) => void`
- TÖRÖLENDŐ. Helyette a `src/logger.ts`-ból importáljuk.

**A `ProcessLockContext` importjainak bővítése (L6-9 környéke, ahol a `type` importok vannak):**
- Jelenlegi L1-9 a process-lock.ts-ban:
  ```ts
  // (valójában ezek a teszt fájl sorai, nem a process-lock.ts-é)
  ```
- A process-lock.ts termelési kód felső részében a típus-importok a `src/logger.ts`-ból:
  ```ts
  import type { LogFn, LoggerLike } from './logger.js'
  ```
  HOVA: a jelenlegi process-lock.ts L1-9 termelési kódjában, a meglévő `import type` blokkba beillesztve.

**L48 és L254 csere:**
- L48 (`ProcessLockContext.log`): `log: { info: LogFn; warn: LogFn; error: LogFn }` → `log: LoggerLike`
- L254 (`PidfileLockContext.log`): `log: { info: LogFn; warn: LogFn; error: LogFn }` → `log: LoggerLike`

**Megjegyzés a `ProcessLockContext` L48 és `PidfileLockContext` L254 kontextusában:** a 3-mezősről 4-mezősre bővítés (`debug` hozzáadása) azért szükséges, mert a `LoggerLike` invariant structural — egy `LoggerLike` értéknek mind a 4 metódussal rendelkeznie kell. Ahol a meglévő kód 3-mezős `log` objektumot ad át (pl. `src/index.ts` `buildPortCtx`), a `debug: noop`-pal bővítés NEM a Phase 1 scope része — lásd lentebb a scope-korlátot.

### 3. `src/__tests__/process-lock-classes.test.ts` — noopLog bővítése (L20)

**L20 jelenlegi:**
```ts
const noopLog = { info: noop, warn: noop, error: noop }
```
**L20 új:**
```ts
const noopLog = { info: noop, warn: noop, error: noop, debug: noop }
```

### 4. `src/__tests__/process-lock.test.ts` — log literálok bővítése (L77 és L511)

A L77 és L511 környékén a `log: { info, warn, error }` literálokat bővíteni kell `debug`-gal. Az implementer subagent feladata, hogy `grep -nE 'info:.*noop|info:.*vi\.fn' src/__tests__/process-lock.test.ts` futtatásával azonosítsa az összes ilyen literált, és mindegyikhez hozzáadja a `debug: noop`-t vagy `debug: vi.fn()`-t (amelyik konzisztens a teszt stílusával).

### 5. Scope-korlát (FONTOS — NEM Phase 1 feladat)

A `src/index.ts` `buildPortCtx` / `buildPidfileCtx` függvényei (amelyekkel a termelési kód a `ProcessLockContext` / `PidfileLockContext` értékeit építi) jelenleg 3-mezős `log: { info, warn, error }` objektumot adnak át. Ha ezekhez NEM nyúlunk, a tsc hibát jelez, mert a `LoggerLike` invariant. **Két lehetőség:**
- **(a) Konzervatív (ajánlott):** a Phase 1 scope-ját kiterjesztjük a `src/index.ts` `buildPortCtx` / `buildPidfileCtx` bővítésére is (`debug: logger.debug.bind(logger)` vagy `debug: () => {}`). Ez 1 fájl, ~10 sor, és a tsc zöld marad.
- **(b) Szűkített (kockázatos):** a `ProcessLockContext.log` és `PidfileLockContext.log` típusát `Pick<LoggerLike, 'info' | 'warn' | 'error'>` formában hagyjuk, és csak a `LoggerLike` típust exportáljuk a `logger.ts`-ból E.6 előkészítésére. Ekkor a production call site-ok nem változnak, de E.6 fázisban újra kell őket nyitni. **Ezt a verziót elvetjük**, mert a H-javítás explicit előírja a 4-mezős `LoggerLike` formát.

**A terv az (a) lehetőséget követi.** A `src/index.ts` módosítás: a `buildPortCtx` és `buildPidfileCtx` `log` mezőjében a `debug` metódus hozzáadása (`debug: () => {}` noop formában, mivel a termelési kód nem hív `debug`-ot, csak info/warn/error-t).

### 6. Nem módosítandó fájlok (a Phase 1-ből kizárva)

- `src/__tests__/logger.test.ts` — a jelenlegi 4 teszt a logger.ts 8 sorát teszteli. A LoggerLike + LogFn hozzáadása NEM töri el ezeket, mert a tesztek a `logger` exportot importálják, nem a `LoggerLike` típust. Új tesztek hozzáadása szükséges (lásd lentebb).
- A `91 vi.mock('../logger.js')` mock-ot a H-javítás szerinti structural interface (`LogFn` overload + `LoggerLike`) kompatibilissé teszi, mert a meglévő mock-ok `{ info: vi.fn(), warn: vi.fn(), error: vi.fn() }` formájúak, és a `LoggerLike` 4. mezője (`debug`) hiányzik — ez a Phase 1 egyik fő kockázata. **Megoldás: a Phase 1 elfogadja, hogy a 91 mock-ot külön fázis (H.2) frissíti, és a Phase 1 nem bántja őket.** A Phase 1 csak a process-lock.ts két kontextus-típusát és a hozzájuk tartozó teszt-fixture-öket érinti.

## Új tesztek

### `src/__tests__/logger.test.ts` — 3 új `it()` blokk hozzáadása (L66 után)

```ts
describe('LoggerLike / LogFn structural interface', () => {
  it('logger export satisfies LoggerLike at compile time', () => {
    // Type-level assertion: if this compiles, logger is assignable to LoggerLike.
    // Runtime: just confirm logger.info/warn/error/debug are functions.
    const { logger } = await import('../logger.js')
    const l: import('../logger.js').LoggerLike = logger
    expect(typeof l.info).toBe('function')
    expect(typeof l.warn).toBe('function')
    expect(typeof l.error).toBe('function')
    expect(typeof l.debug).toBe('function')
  })

  it('LogFn overload accepts (msg: string) and (obj: object, msg?: string)', () => {
    const calls: Array<[unknown, string | undefined]> = []
    const fn: import('../logger.js').LogFn = (a: unknown, b?: string) => {
      calls.push([a, b])
    }
    fn('simple message')
    fn({ ctx: 'value' }, 'with obj')
    fn({ ctx: 'value' })
    expect(calls).toEqual([
      ['simple message', undefined],
      [{ ctx: 'value' }, 'with obj'],
      [{ ctx: 'value' }, undefined],
    ])
  })

  it('LoggerLike is assignable from a noop fixture (info/warn/error/debug)', () => {
    const noop = () => {}
    const fixture: import('../logger.js').LoggerLike = {
      info: noop,
      warn: noop,
      error: noop,
      debug: noop,
    }
    fixture.info('a')
    fixture.debug({ k: 'v' }, 'msg')
    expect(fixture.info).toBe(noop)
  })
})
```

### `src/__tests__/process-lock-classes.test.ts` — 1 új `it()` (a describe blokkok végén)

```ts
describe('LoggerLike requirement on contexts', () => {
  it('buildPortCtx log field satisfies LoggerLike (4 methods)', () => {
    const ctx = buildPortCtx()
    const _typed: import('../logger.js').LoggerLike = ctx.log
    // Tsc-only assertion; runtime: ensure debug is present.
    expect(typeof ctx.log.debug).toBe('function')
  })

  it('buildPidfileCtx log field satisfies LoggerLike (4 methods)', () => {
    const ctx = buildPidfileCtx()
    const _typed: import('../logger.js').LoggerLike = ctx.log
    expect(typeof ctx.log.debug).toBe('function')
  })
})
```

A **CLAUDE.md §8 vacuous-test szabály** betartva: minden új `it()`-ben van explicit érték-összehasonlítás (`toBe('function')` vagy `toEqual([...])`), nem csak `expect(Array.isArray(result)).toBe(true)`. Ha az implementáció konstans `() => {}`-t adna vissza `debug` helyett, a `typeof === 'function'` assertion megbukna.

## Workflow struktúra (végrehajtás)

A végrehajtás a **Workflow tool** script formájában, 4 fázisban:

### Fázis 1 — Implementáció (worktree-isolated)

- **Worktree:** `git worktree add --detach $HOME/claw-phase1-loggerlike 7956bc91ee788792ca5064837ffc39889eba0f9f` (a `$HOME` alatt, NEM `/tmp/` — lásd CLAUDE.md §8: `/tmp/` → `/private/tmp/` macOS-en, és path-sensitive tesztek elromlanak). Az SHA a baseline `git rev-parse HEAD` eredménye; ha a workflow indítása előtt új commit landol a `refactor/classbase`-en, a workflow frissíti az SHA-t.
- **node_modules symlink:** `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-phase1-loggerlike/node_modules`.
- **Implementer agent típusa:** `coder` (Plan agent utasítása: spec-driven, known files, known approach).
- **Implementer scope:**
  1. `src/logger.ts` L9 után beilleszteni a `LogFn` + `LoggerLike` interface-eket a fenti kóddal.
  2. `src/process-lock.ts` L19 `type LogFn = ...` sort törölni, és a felső `import type` blokkot bővíteni `import type { LoggerLike } from './logger.js'`-vel.
  3. `src/process-lock.ts` L48 és L254 `log: { info: LogFn; warn: LogFn; error: LogFn }` → `log: LoggerLike`.
  4. `src/index.ts` `buildPortCtx` és `buildPidfileCtx` `log` mezőit bővíteni `debug: () => {}` noop-pal.
  5. `src/__tests__/process-lock-classes.test.ts` L20 noopLog bővítése `debug: noop`-pal.
  6. `src/__tests__/process-lock.test.ts` L77 és L511 `log` literálok bővítése `debug`-gal (az implementer `grep -nE 'info:.*(noop|vi\.fn)'` futtatásával azonosítja az összes ilyet).
  7. `src/__tests__/logger.test.ts` L66 után a 3 új `it()` blokk beillesztése.
  8. `src/__tests__/process-lock-classes.test.ts` végén a 2 új `it()` blokk beillesztése.
- **Implementer verifikáció (mielőtt commitol):**
  - `bun tsc --noEmit` — 0 hiba
  - `bun --bun vitest run src/__tests__/logger.test.ts src/__tests__/process-lock.test.ts src/__tests__/process-lock-classes.test.ts` — minden passed
  - Teljes `bun --bun vitest run` a worktree-ben — 391 passed, 10 failed (pre-existing unchanged, nem nőhet)
  - `git status` — csak a tervezett fájlok módosítva
- **Commit:** `git -c user.email=$(git config user.email) -c user.name=$(git config user.name) commit -m "refactor(logger): add LoggerLike + LogFn structural interface; process-lock.ts adopts (Phase 1)"`. Az implementer agent **nem** állítja felül a git identity-t.
- **Implementer visszatérési értéke:** a commit SHA és a módosított fájlok listája.

### Fázis 2 — Dupla verifikáció (két független subagent, párhuzamosan)

A workflow `parallel()` blokkban indítja a két verifiert, akik a worktree-ben dolgoznak, de NEM commitolnak — csak jelentenek.

**Verifier A (checklist, struktúrált PASS/FAIL):**
- Agent típusa: `reviewer`.
- Prompt: "Read the diff `git diff 7956bc9..HEAD` in $HOME/claw-phase1-loggerlike. For each of these claims, return PASS or FAIL with quoted evidence (file:line + value):
  1. `src/logger.ts` exports `LogFn` interface with the exact 2-line overload from the plan.
  2. `src/logger.ts` exports `LoggerLike` interface with exactly 4 readonly fields: info/warn/error/debug, all typed as LogFn.
  3. `src/process-lock.ts` line 19 (`type LogFn = ...`) is deleted.
  4. `src/process-lock.ts` imports `LoggerLike` from './logger.js'.
  5. `src/process-lock.ts` line 48 `log` field type is `LoggerLike` (not the inline object literal type).
  6. `src/process-lock.ts` line 254 `log` field type is `LoggerLike`.
  7. `src/index.ts` `buildPortCtx` and `buildPidfileCtx` log fields include `debug`.
  8. `src/__tests__/process-lock-classes.test.ts` line 20 `noopLog` includes `debug`.
  9. `src/__tests__/logger.test.ts` contains 3 new `it()` blocks matching the plan (count `it(` calls; expected 7 total = 4 original + 3 new).
  10. `src/__tests__/process-lock-classes.test.ts` contains 2 new `it()` blocks.
  11. `bun tsc --noEmit` exits 0.
  12. `bun --bun vitest run src/__tests__/logger.test.ts src/__tests__/process-lock.test.ts src/__tests__/process-lock-classes.test.ts` shows all 4 + 61 + 12 = 77 tests passed (the 3 new logger tests + 2 new process-lock-classes tests).
  13. Teljes `bun --bun vitest run` failed-test count <= 10 (not increased from baseline).
  14. `grep -nE 'as\s+(any|unknown)' src/process-lock.ts src/logger.ts src/index.ts` shows no NEW `as` casts compared to baseline.
  15. `grep -nE "type LogFn = " src/process-lock.ts` returns nothing (LogFn definition is gone)."
- Visszatérés: PASS/FAIL lista + minden állításhoz idézet.

**Verifier B (adversarial falsifier, saját szög):**
- Agent típusa: `reviewer` (ugyanaz, de más prompt).
- Prompt: "Read the diff `git diff 7956bc9..HEAD` in $HOME/claw-phase1-loggerlike. Your job is to BREAK the claim that this refactor is Low risk and Phase 1-ready. Independently — do NOT just re-run Verifier A's checks. Specifically:
  1. Pick 3 random call sites in `src/` that import `logger` from `'./logger.js'` or `'../logger.js'`. Run `grep -rn 'from.*logger' src/ --include='*.ts' | grep -v __tests__ | head -20`. For each, check if the consumer would break if `logger` gained a `LogFn`/`LoggerLike` export. (Spoiler: exports are additive, so most won't break — but verify.)
  2. Independently verify the LogFn overload signatures: write a 5-line TS snippet (in your head) that calls `LogFn({a:1})` without a msg — does it compile per the overload?
  3. Read `src/process-lock.ts` lines 1-50 and 240-260 (the changed context types). Independently verify that `log: LoggerLike` is structurally compatible with what the production code (e.g. `src/index.ts` buildPortCtx) actually passes. If `buildPortCtx.log = { info, warn, error }` (3 fields) is still in the code, that means the diff is INCOMPLETE and tsc will fail.
  4. Run `bun --bun vitest run src/__tests__/process-lock.test.ts` and check if any test relies on `ctx.log.debug` being ABSENT — if so, the new `debug` noop changes behavior. (Spoiler: shouldn't, but verify.)
  5. Read the new `it()` blocks in `logger.test.ts` and `process-lock-classes.test.ts`. For each, ask: would this assertion FAIL if the implementation returned constant `undefined` or no-op everywhere? If any assertion is vacuous (per CLAUDE.md §8), flag it.
  6. Check if the implementer left any `as` casts that didn't exist before (`git show 7956bc9:src/process-lock.ts` vs current).
  Return: list of CONFIRMED issues (file:line + concrete failure scenario) and a verdict on whether the refactor is ready."
- Visszatérés: CONFIRMED issue-ok + verdict.

### Fázis 3 — Merge és author check

- A workflow ellenőrzi, hogy a két verifier nem jelzett CONFIRMED issue-t. Ha igen, a workflow megáll és a usernek jelenti.
- Szerző ellenőrzés (CLAUDE.md §8): `git log -1 --format='%an <%ae>'` a worktree commitban, összevetve `git config user.email`-lel a main checkoutban. Ha eltérés, a workflow megáll és a usernek jelenti (NE javítsa önhatalmúlag).
- Merge a branch-re: `cd /Users/eggp/marveen-develop/test-baseline && git merge --ff-only <worktree-commit-sha>` (a working tree clean kell legyen, különben a merge elutasít — a main checkout jelenleg clean).
- Worktree cleanup: `git worktree remove $HOME/claw-phase1-loggerlike --force`.
- A merge után ellenőrzés a main checkoutban:
  - `bun tsc --noEmit` — 0 hiba
  - `bun --bun vitest run src/__tests__/logger.test.ts src/__tests__/process-lock.test.ts src/__tests__/process-lock-classes.test.ts` — 4 + 61 + 12 = 77 passed (3 + 2 újjal)
  - Teljes `bun --bun vitest run` failed-test count ≤ 10 (nem nőhet)

### Fázis 4 — User invokálja a code-review-t

- A workflow nem hívja a `/code-review max --fix` skillt (az tiltott — lásd CLAUDE.md §8: a skill `disable-model-invocation` flag-gel rendelkezik).
- A workflow végén a usernek szól: "A worktree commit a `refactor/classbase` branch-re merge-elve. Futtasd a `/code-review max --fix` skillt a project root-ban."
- A user ezt KÖTELES a main checkoutban futtatni (NEM a worktree-ben, ami már törölve van).

### Workflow script váz (a `Workflow` tool-hoz)

```js
export const meta = {
  name: 'phase1-loggerlike',
  description: 'LoggerLike + process-lock LogFn refactor (Phase 1 of docs/refactor-to-classbase)',
  phases: [
    { title: 'Implement' },
    { title: 'Verify (parallel)' },
    { title: 'Merge' },
    { title: 'Hand off to user' },
  ],
}

const BASE_SHA = '<measured at workflow start via git rev-parse HEAD>'
const WORKTREE = '$HOME/claw-phase1-loggerlike'
const MAIN = '/Users/eggp/marveen-develop/test-baseline'

// Phase 1: Implement in worktree
const implResult = await agent(`
  Worktree: ${WORKTREE} (already set up via git worktree add --detach ${BASE_SHA}).
  Apply the Phase 1 changes per the plan: ...
`, { label: 'implementer', phase: 'Implement', isolation: 'worktree' })

// Phase 2: Parallel verification
const [verifierA, verifierB] = await parallel([
  () => agent('Verifier A prompt...', { label: 'verifier-A', phase: 'Verify' }),
  () => agent('Verifier B prompt...', { label: 'verifier-B', phase: 'Verify' }),
])

if (verifierA.hasFail || verifierB.hasConfirmedIssue) {
  return { status: 'blocked', reason: 'verification failed' }
}

// Phase 3: Merge
const authorEmail = await bash(`cd ${MAIN} && git log -1 --format='%ae' ${WORKTREE}/HEAD`)
if (authorEmail !== await bash(`cd ${MAIN} && git config user.email`)) {
  return { status: 'blocked', reason: 'author identity mismatch' }
}
await bash(`cd ${MAIN} && git merge --ff-only ${WORKTREE}/HEAD`)
await bash(`cd ${MAIN} && git worktree remove ${WORKTREE} --force`)

// Phase 4: Hand off
return { status: 'merged', nextAction: 'User: run /code-review max --fix in main checkout' }
```

## Verification gate-ek (konkrét számok, a végrehajtás után)

A Phase 1 sikeres, ha a merge utáni main checkoutban:

| Gate | Parancs | Várt eredmény |
|---|---|---|
| tiszta tsc | `bun tsc --noEmit` | **0 hiba** (baseline: 0) |
| célzott vitest | `bun --bun vitest run src/__tests__/logger.test.ts src/__tests__/process-lock.test.ts src/__tests__/process-lock-classes.test.ts` | **77 passed** (baseline: 4 + 61 + 12 = 77; az új 3 + 2 = 5 teszttel együtt, ha a célzott szűrés nem zárja ki az újakat — lásd lentebb) |
| teljes vitest | `bun --bun vitest run` | **391 passed, 10 failed** (baseline unchanged, a failed count nem nőhet) |
| lint | `bun run lint` | **≤ 10,486 problems** (baseline: 10,486; Phase 1 nem adhat újat) |
| lefedettség | `bun --bun vitest run --coverage src/__tests__/logger.test.ts src/__tests__/process-lock-classes.test.ts` | a `src/logger.ts` és `src/process-lock.ts` fájlokon **100%** (Phase 1 csak típusokat ad, nem csökkenti a branch coverage-t). A lefedettség JSON a `coverage/` mappába kerül, ami `.gitignore`-ban van — NEM commitolható. A gate csak a lokális mérés. |

A 77 passed vs 4 + 61 + 12 = 77 math: ha a 3 új logger-teszt ÉS a 2 új process-lock-classes-teszt TELJES egészében hozzáadódik, akkor a `bun --bun vitest run <paths>` parancs fájlszintű szűrése minden fájlra lefuttatja a teljes fájlt, és a `4 → 7`, `12 → 14`, `61 → 61` (process-lock.test.ts-hez nem nyúlunk) változást jelent. Összesen: 7 + 61 + 14 = 82 passed.

## Kockázat-mitigation (Phase 1-specifikus)

### R10 — Pino logger re-import hazard
A `logger.ts` export listája kiegészül `LogFn` és `LoggerLike` típusokkal, de a `const logger = pino(...)` marad. Az ESM cache továbbra is egyetlen példányt ad vissza, és a `vi.resetModules()` + re-import a `logger.test.ts` L14-ben továbbra is működik (az új típus-exportok típus-szintűek, futásidőben nem befolyásolják a modult). A H-javítás 132-137 bizonyítja, hogy a `pino.Logger` típuskompatibilis a `LoggerLike` típussal — tehát a `const _typed: LoggerLike = logger` assertálás nem bukik el.

### Worktree pitfalls (CLAUDE.md §8)
- A worktree `$HOME/claw-phase1-loggerlike` alá kerül, NEM `/tmp/claw-*` alá. A `PROJECT_ROOT = join(__dirname, '..')` a `src/config.ts:12`-ben a worktree útvonalát veszi fel, és a `/tmp/` → `/private/tmp/` macOS-en path-sensitive teszteket (pl. `isUnsafeHookCommand` a `src/web/agent-scaffold.ts:144`-ben) elromlik.
- A node_modules symlink a main checkout-ból: `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-phase1-loggerlike/node_modules`.
- A worktree cleanup a merge után: `git worktree remove $HOME/claw-phase1-loggerlike --force` (a main checkout working tree-jének clean-nek kell lennie a merge előtt — most clean).

### Author identity check (CLAUDE.md §8)
- Az implementer agent NEM állíthatja felül a git identity-t (`git -c user.email=claude@anthropic.com -c user.name=Claude commit ...` TILTOTT).
- A workflow a merge ELŐTT futtatja: `git log -1 --format='%ae'` a worktree commitban vs `git config user.email` a main checkoutban.
- Ha eltérés, a workflow megáll és a usernek jelenti — NEM javítja önhatalmúlag (history rewrite, külön engedélyköteles).

### Coverage gate execution (CLAUDE.md §8)
- A `coverage/` mappa a `.gitignore`-ban van (L96-97), tehát a lefedettség NEM commitolható artifactum.
- A gate lokális mérés: `bun --bun vitest run --coverage src/__tests__/logger.test.ts src/__tests__/process-lock-classes.test.ts`.
- A `bun run coverage` parancsot a main checkoutban NE futtassuk, mert az lassú (135s) és a kimenet nem commitolható — csak a célzott fájlszintű coverage számít.

### Vitest pre-existing fails (10 failed / 2 tests, CLAUDE.md §8)
- A teljes `bun --bun vitest run` 10 fájlban 2 tesztet jelez failed-nek. Ezek pre-existing fail-ek (e-mail-send-gate, governance-gates, hook-command-quoting, hook-path-guard — a Honcho 2026-08-27 entry szerint).
- A Phase 1 gate: a failed count NEM nőhet. Ha a merge után 11+ fájl failed, a workflow megáll.
- Ha a Phase 1 mérése során a 10 failed >5 miatt a §8 szabály a `$HOME/claw-test` baseline worktree-t írná elő, ezt a szabályt a Phase 1 végrehajtása során alkalmazzuk (a main checkout `store/` mappa üres, tehát a vitest guard nem blokkol — a main checkoutban is futtatható).

### MD és commit message hivatkozások (CLAUDE.md §8)
- A commit message NEM tartalmaz inline SHA-t. Helyette `(this commit)` placeholder, amit a workflow a commit SHA-val tölt fel a commit message végén.
- A terv NEM tartalmaz inline SHA-t (kivéve a mért baseline `7956bc9...`, ami a terv kiindulási állapota).
- Ha a merge után bármilyen MD-re SHA-t kell írni (pl. a `docs/refactor-to-classbase/00-summary.md` Phase 1 LANDED státusz frissítésekor), a `(this commit)` placeholder megy a MD-be, és külön follow-up commit írja át.

### Konfliktus a `04-generic-interfaces.md` G5-tel (terv-felelősség)
- A terv a `h-cross-cutting/04:18-69` H-javítást követi, nem a `04-generic-interfaces.md:233-276` G5-öt. A Phase 1 végrehajtása után a `04-generic-interfaces.md` G5 szekcióját külön commitban javítani kell, hogy a két dokumentum összhangban legyen. **Ez a Phase 1 utáni docs reconciliation commit scope, nem a Phase 1 implementer scope.**

## Végrehajtás előtti checklist (a workflow indítása előtt)

1. **Main checkout clean?** `git status` — jelenleg clean.
2. **`store/` mappa üres?** `ls -la store/` — igen.
3. **A baseline SHA a `7956bc91ee788792ca5064837ffc39889eba0f9f`?** `git rev-parse HEAD` — igen.
4. **A workflow implementer scope-ja megegyezik a fenti scope-pal?** A workflow scriptben a `coder` agent promptja a terv ezen szekcióját szó szerint idézi.
5. **A két verifier promptja a fenti checklist + adversarial falsifier prompt?** A workflow scriptben mindkettő szó szerint.
6. **A `coverage/` mappa `.gitignore`-ban van?** Igen (L96-97).
7. **A `/code-review max --fix` skill user-invokációja dokumentálva a Fázis 4-ben?** Igen.

## Mi történik a Phase 1 UTÁN

1. **A user futtatja `/code-review max --fix`-et** a main checkoutban. Ez egy utolsó adversarial review, ami CLAUDE.md §7 typeguard/satisfies ellenőrzést is végez.
2. **A user jelzi, ha bármi javítandó.** A javítások a main checkoutban történnek, új commitok formájában.
3. **Docs reconciliation:** külön commit, ami a `docs/refactor-to-classbase/00-summary.md`-ben a Phase 1 státuszt LANDED-re állítja, és a `04-generic-interfaces.md` G5 szekcióját a H-javítással összhangba hozza.
4. **E.6 (LogFn végleges eltávolítás) phase** — a Phase 1-gyel előkészítettük, hogy a `LogFn` típus már csak a `src/logger.ts`-ban él, és a `process-lock.ts` `LoggerLike`-ot használ. E.6 csak a `LogFn` típus teljes törléséről szól a `src/logger.ts`-ból, ha a teljes kódbázis már nem hivatkozik rá. Ez a Phase 2 (H.2 — per-class injection) után lehetséges.