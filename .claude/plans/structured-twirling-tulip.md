# AutoRestartSchedule class extraction

## Context

A `docs/refactor-to-classbase/00-summary.md` "Top 3 lowest-risk wins" listája 3 átalakítást
sorol fel. Az első kettő (`src/channel-provider.ts` → 5 provider class, `src/process-lock.ts`
→ `PortLockAcquirer` + `PidfileLockAcquirer`) már kész a `refactor/classbase` branch-en
(commits `10d06cb` és `57c78d0`). A **harmadik, `src/auto-restart.ts` → `class
AutoRestartSchedule`**, még nem történt meg — ez a legalacsonyabb kockázatú maradék
átalakítás.

A `src/auto-restart.ts` (122 sor, dependency-free, pure logic) 1 production fogyasztóval
(`src/web/auto-restart-runner.ts`) és 4 dedikált teszt fájllal rendelkezik. A cél:
ugyanaz a statikus-only utility, de osztályba szervezve — `AutoRestartSchedule.DEFAULT`
mező + 5 static method. Az eredeti free-function surface (5 függvény + 1 const + 3
type) thin wrapperként megmarad, hogy a fogyasztók és tesztek azonnali migráció
nélkül is működjenek. A "Top 3 lowest-risk wins" summary kisebb pontatlansága:
`dailyPhaseAtMs` → valójában `dailyDueAtMs`, és a summary csak 3 decision functiont
említ, valójában 5 van (`parseHHMM`, `normalizeAutoRestartConfig`,
`mainRestartMechanism`, `restartDue`, `dailyDueAtMs`).

A 4 dedikált teszt fájlból 3 unit teszt (`auto-restart.test.ts`, 114 sor;
`auto-restart-main-mechanism.test.ts`, 35 sor; `auto-restart-store.test.ts` csak a
`DEFAULT_AUTO_RESTART` const-ot importálja) közvetlenül a free functionöket hívja;
az `auto-restart-runner.test.ts` (911 sor) a runner-en keresztül, közvetett módon
éri el őket. A free function wrapper-ök megtartásan ezen tesztek azonnal zöldek
maradnak; a class API-t új tesztek fedik le, amelyek bizonyítják hogy a class
metódusai és a wrapper-ök azonos eredményt adnak.

## Files to touch

| File | Change |
|---|---|
| `src/auto-restart.ts` | ADD `class AutoRestartSchedule` with `static readonly DEFAULT` field + 5 static methods. KEEP all 9 current exports (2 type aliases, 1 interface, 1 const, 5 functions) as thin wrappers that delegate to the class. |
| `src/__tests__/auto-restart-class.test.ts` (NEW) | New file: class API unit tests. For each static method, a positive test that calls `AutoRestartSchedule.<method>` directly (NOT the wrapper). Plus property tests: `AutoRestartSchedule.X(x,y,z) === X(x,y,z)` for all 5 methods and `AutoRestartSchedule.DEFAULT === DEFAULT_AUTO_RESTART`. This is the regression test for the wrapper-class equivalence. |

NO CHANGE in:
- `src/web/auto-restart-runner.ts` (consumer keeps using free functions; wrapper survives)
- `src/web/auto-restart-store.ts` (only `DEFAULT_AUTO_RESTART`-t használja)
- `src/__tests__/auto-restart.test.ts`, `auto-restart-main-mechanism.test.ts`, `auto-restart-store.test.ts`, `auto-restart-runner.test.ts` (existing tests stay green via wrappers)

## Concrete class shape

```ts
// src/auto-restart.ts (additions only — existing exports become wrappers below)

export class AutoRestartSchedule {
  static readonly DEFAULT: AutoRestartConfig = {
    enabled: false,
    mode: 'continue',
    dailyTime: null,
    intervalHours: null,
    handoff: false,
  }

  static mainRestartMechanism(launchctlPresent: boolean): MainRestartMechanism { ... }
  static parseHHMM(s: unknown): number | null { ... }
  static normalizeAutoRestartConfig(raw: unknown): AutoRestartConfig { ... }
  static restartDue(lastRestartAtMs: number | null, nowMs: number, dueAtMs: number): boolean { ... }
  static dailyDueAtMs(localMidnightMs: number, minutesSinceMidnight: number): number { ... }
}

export const DEFAULT_AUTO_RESTART: AutoRestartConfig = AutoRestartSchedule.DEFAULT

/** @deprecated Use AutoRestartSchedule.mainRestartMechanism. */
export function mainRestartMechanism(launchctlPresent: boolean): MainRestartMechanism {
  return AutoRestartSchedule.mainRestartMechanism(launchctlPresent)
}

// ... same one-line delegates for parseHHMM, normalizeAutoRestartConfig,
//     restartDue, dailyDueAtMs
```

Type exports (`AutoRestartMode`, `MainRestartMechanism`, `AutoRestartConfig`) module
szinten maradnak — TypeScript-ben a class-on belüli type export nem segít, és a
fogyasztók `import { type AutoRestartConfig } from '../auto-restart.js'` formát
használnak.

### Test plan: anti-vacuous assertions (CLAUDE.md §8)

A `auto-restart-class.test.ts` minden assertionjének meg kell buknia, ha az
implementációt konstans visszatérésre vagy no-opra kibeleznénk. A checklist:

- `expect(AutoRestartSchedule.parseHHMM('03:00')).toBe(180)` — bukik ha a függvény `0`-t ad vissza
- `expect(AutoRestartSchedule.parseHHMM('99:99')).toBeNull()` — bukik ha minden inputra számot ad
- `expect(AutoRestartSchedule.normalizeAutoRestartConfig({ enabled: true, mode: 'fresh', dailyTime: '03:00' })).toEqual({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: false })` — bukik ha az implementáció DEFAULT-et ad vissza
- `expect(AutoRestartSchedule.restartDue(null, 1_000_000, 1_000_000)).toBe(true)` + `expect(AutoRestartSchedule.restartDue(1_000_000, 1_005_000, 1_000_000)).toBe(false)` — bukik ha mindig true/false
- `expect(AutoRestartSchedule.dailyDueAtMs(0, 180)).toBe(180 * 60_000)` — bukik ha konstans
- `expect(AutoRestartSchedule.mainRestartMechanism(false)).toBe('tmux-respawn')` — bukik ha 'launchd'-et ad
- **Equivalence property**: `expect(AutoRestartSchedule.X(args)).toBe(X(args))` minden metódusra, egy konkrét inputpal. Ez bizonyítja hogy a wrapper nem hazudik — ha a wrapper `as` cast-ot csinál vagy más referenciát ad vissza, az assertion elromlik.
- `expect(AutoRestartSchedule.DEFAULT).toBe(DEFAULT_AUTO_RESTART)` — referenciális egyenlős. Ha a wrapper másolatot készít (pl. `{ ...AutoRestartSchedule.DEFAULT }`), ez bukik.

Plusz: az `AutoRestartSchedule` `new AutoRestartSchedule()` is hívható kell legyen
(TypeScript default constructor) — ha valaki véletlenül instance methodot akar
használni, az üres `this` warning-ot kap. Ez a design decision (static-only) része.

## Risk assessment

| Risk | Severity | Mitigation |
|---|---|---|
| Wrapper és class metódus eltérő eredményt ad | Low | Equivalence property tests a `auto-restart-class.test.ts`-ban |
| `DEFAULT_AUTO_RESTART` const identity megváltozik (másolat spread) | Low | `expect(AutoRestartSchedule.DEFAULT).toBe(DEFAULT_AUTO_RESTART)` |
| Type check vagy lint regression | Low | Implementer a munkája végén futtatja `bun tsc --noEmit` + `bun run lint` |
| Pre-existing regression a baseline-on | Medium | Ha a célzott tesztek >5 fail-t mutatnak, ellenőrizzük a `a330462` baseline-on is (CLAUDE.md §8) |

A module teljesen pure logic, nincs `this`, nincs DI, nincs I/O. A 4 corner case, amit
a falsification verifier vizsgál:

1. **Static field mutáció**: ha egy teszt `AutoRestartSchedule.DEFAULT.mode = 'fresh'`
   módosít, az a `DEFAULT_AUTO_RESTART` re-exportra is hat? A terv: a class mező
   `static readonly`, de a property belseje NEM readonly (`{ ... }` literal, NEM
   `as const`). A wrapper egy azonos referenciát export. Ez **szándékosan** megegyező
   referencia — a `readonly` csak a mező újraértékelését tiltja, nem a property mutációt.
   Ez egyezik a jelenlegi viselkedéssel (a `DEFAULT_AUTO_RESTART` ma is módosítható).
2. **`new AutoRestartSchedule()`**: a default constructor üres instance-ot ad.
   TypeScript-ben a `static` method-ok hívhatók instance-on is (`this` undefined),
   tehát `new AutoRestartSchedule().parseHHMM('03:00')` is működik. Ez NEM baj — nem
   tiltjuk, de nem is dokumentáljuk. Ha bármelyik teszt felfedezi ezt a path-ot, az
   evidence hogy a class jól van modellezve.
3. **Wrapper recursion**: `export function parseHHMM(s) { return
   AutoRestartSchedule.parseHHMM(s) }` — ha a class metódus nevének átnevezése közben
   a wrapperbent maradna a régi név, infinite loop. A plan ezt explicit kitiltja:
   wrapper body `AutoRestartSchedule.<method>` — ugyanaz a név mint a wrapper, NEM
   `parseHHMM(s)` önmagát (ami rekurzió lenne).
4. **`AutoRestartConfig` import site**: a `import { type AutoRestartConfig } from
   '../auto-restart.js'` továbbra is működik, mert a type export nem változik.

## Execution: Workflow tool script

A workflow script a `.claude/plans/` mellé nem kerül mentésre — inline adjuk át a
`Workflow({script})` hívásban. A script `pipeline()`-szal épül, ahol minden fázis
eredménye a következő inputja.

### Phase 0 — Preflight (a terv gate-eihez, CLAUDE.md §8)

Az implementer NEM indul el, amíg ez a fázis nem mér:

1. `bun tsc --noEmit` exit code + error count — REF: tervíráskor mért szám
2. `bun run lint` error count
3. `bun --bun vitest run src/__tests__/auto-restart.test.ts src/__tests__/auto-restart-main-mechanism.test.ts src/__tests__/auto-restart-store.test.ts src/__tests__/auto-restart-runner.test.ts` — REF: pontos átment/összesen szám
4. `git -C <repo> status` clean kell legyen

A mért számok a terv gate-jei:
- typecheck: "tartsd N-en" (konkrét szám, NEM "legyen tiszta")
- lint: "tartsd N-en"
- 4 auto-restart teszt fájl: "N/4 átmenjen"

### Phase 1 — Implementation (worktree-isolated)

Egy implementer agent (`isolation: "worktree"`) a `refactor/classbase` branch
detached HEAD-jén dolgozik. A `CLAUDE.md §8` worktree-tisztítási szabálya miatt
a worktree path `$HOME/claw-test-auto-restart` (NEM `/tmp/`).

Feladatok:
1. Read `src/auto-restart.ts` (122 sor, ma)
2. Add `class AutoRestartSchedule` a terv szerinti shape-pel — `static readonly
   DEFAULT` + 5 static method, ugyanazokkal a body-kkal mint a jelenlegi free
   function-ök
4. A jelenlegi 5 function + 1 const wrapper-ré konvertálása (`@deprecated` JSDoc
   comment-tel, ami a class API-ra mutat)
5. Új `src/__tests__/auto-restart-class.test.ts` a terv szerinti anti-vacuous
   assertion-ökkel
6. Saját maga futtatja: `bun tsc --noEmit` + `bun run lint` + a 4 auto-restart
   teszt fájl + az új class teszt fájl. Ha bármelyik gate eltérést mutat a
   Phase 0 baseline-tól, JAVÍTJA mielőtt commitol.
7. Commit: `refactor(auto-restart): extract AutoRestartSchedule class with legacy
   wrappers (CLAUDE.md §8)`. A commit message-be NEM kerül inline SHA (a history
   rewrite safety kaps).

### Phase 3 — Double verification (2 párhuzamos verifier)

`parallel()` hívás, két eltérő szögű verifier:

**Verifier A — checklist:**
- Output schema: `{ checks: [{ id, claim, evidence, pass }] }`
- 12 strukturált PASS/FAIL ellenőrzés, mindegyiknél a konkrét kódrészlet vagy
  output mint evidence:
  1. `AutoRestartSchedule` class export létezik (`grep -n '^export class AutoRestartSchedule' src/auto-restart.ts`)
  2. `static readonly DEFAULT` mező deklarálva van
  3. Mind az 5 static method deklarálva van (`grep -nE 'static (parseHHMM|normalizeAutoRestartConfig|mainRestartMechanism|restartDue|dailyDueAtMs)\('`)
  4. A régi 9 export (2 type, 1 interface, 1 const, 5 fn) mind megmaradt (`grep -nE '^export (const|function|type|interface)' src/auto-restart.ts` ≥ 9 sor)
  5. Nincs `as` cast a forrásban (CLAUDE.md §7) — `grep -nE '\bas\b' src/auto-restart.ts | grep -v -E 'as const|as unknown|@deprecated'`
  6. A wrapper-ök delegate-nek a class-hoz, NEM önmagukhoz (`grep -nE 'export function parseHHMM' src/auto-restart.ts` body NEM tartalmaz `parseHHMM(` rekurziót)
  7. A 4 meglévő teszt fájl átmegy (output a vitest run-ból)
  8. Az új class teszt fájl átmegy
  9. A `bun tsc --noEmit` exit code 0
  10. A `bun run lint` NEM nőtt a Phase 0 baseline-hoz képest
  11. `src/web/auto-restart-runner.ts` NEM változott (`git diff HEAD~1 -- src/web/auto-restart-runner.ts` üres)
  12. `src/__tests__/auto-restart.test.ts`, `auto-restart-main-mechanism.test.ts`, `auto-restart-store.test.ts`, `auto-restart-runner.test.ts` NEM változtak

**Verifier B — falsification:**
- Output schema: `{ attempts: [{ id, hypothesis, method, result }] }`
- Adversariális kísérletek, sajátkezűleg, a tervben felsorolt 4 corner case-en túl:
  1. **Equivalence random**: 100 random inputra mind az 5 metódusra `class.X(args) === wrapper.X(args)`. Egyetlen eltérés → FAIL.
  2. **Vacuous test check**: az új class teszt fájl összes `expect(...).toBe(...)` assertionje megbukna-e, ha az implementáció `() => 0` vagy `() => null` body-val lenne kitöltve? Ha minden átmegy, a teszt vacuous.
  3. **Identity mutation**: `AutoRestartSchedule.DEFAULT.enabled = true` — hat-e a `DEFAULT_AUTO_RESTART` re-exportra? Ha igen, a wrapper egyező referenciát ad (szándékos), ez NEM failure, csak dokumentálva.
  4. **Instance access**: `new AutoRestartSchedule().parseHHMM('03:00')` — átmegy-e és 180-at ad-e? Ha a terv nem tiltja, akkor ez a shape helyes.
  5. **Type check**: TypeScript `strict` módban a class típusú exportok típusellenőrzésének lefutása (`bun tsc --noEmit --strict` a teljes projectre).
  6. **Import shadowing**: `import { AutoRestartSchedule as Renamed } from '../auto-restart.js'; Renamed.DEFAULT.mode` — elérhető-e a mező?
  7. **Lint regression hunt**: `bun run lint` outputjában minden új warning-t vagy error-t azonosít, és megnézi, hogy a baseline-on is jelen volt-e.

### Phase 4 — Merge back

A worktree-isolated implementer commit a detached HEAD-en van (`git worktree add
--detach`). A visszavezetés a `CLAUDE.md §8` worktree merge szabálya szerint:

```
git worktree remove $HOME/claw-test-auto-restart --force
git -C <repo> merge --ff-only <commit-sha>
```

A `git merge-base refactor/classbase <sha>` KELL egyezzen a branch HEAD-del
(közvetlen gyerek). Ha a merge elutasít (working tree nem clean, vagy nem
fast-forward), a Phase 3 verifierek bizonyítékával a usernek kell jelezni —
nem szabad `git reset --hard`-ot használni (security warning triggerel).

### Phase 5 — User-triggered code review

A terv nem hívja a `/code-review max --fix` skillt (a `disable-model-invocation`
flag miatt, CLAUDE.md §8). A user a Phase 4 merge után manuálisan indítja a
terminálban. A terv futamideje alatt a skill hívása TILTOTT — ez explicit
user invokációra van fenntartva.

A handoff dokumentum (`docs/auto-restart-class-handoff.md` vagy hasonló) a
verifierek outputját + a commit SHÁ-t (POST-MERGE, nem előre) + a fájl:line
hivatkozásokat tartalmazza, hogy a `/code-review` skillnek meglegyen minden
inputja.

## Verification (end-to-end)

A teljes workflow végén az alábbi parancsok mind zöldek kell legyenek a
`refactor/classbase` branch-en:

1. **Type check**: `bun tsc --noEmit` exit 0, error count = Phase 0 baseline
2. **Lint**: `bun run lint` error/warning count = Phase 0 baseline
3. **Targeted tests**:
   - `bun --bun vitest run src/__tests__/auto-restart.test.ts` — 4/4 átmegy
   - `bun --bun vitest run src/__tests__/auto-restart-main-mechanism.test.ts` — 3/3 átmegy
   - `bun --bun vitest run src/__tests__/auto-restart-store.test.ts` — átmegy
   - `bun --bun vitest run src/__tests__/auto-restart-runner.test.ts` — átmegy
   - `bun --bun vitest run src/__tests__/auto-restart-class.test.ts` (NEW) — átmegy
4. **Full test suite**: `bun --bun vitest run` (a `CLAUDE.md §8` worktree-szabály
   szerint `$HOME/claw-test-auto-restart` worktree-ben, NEM `/tmp/`-ban) — NEM
   szabad új fail-t hoznia a Phase 0 baseline-hoz képest
5. **Coverage** (opcionális, de a `CLAUDE.md §8` .gitignore-szabálya miatt
   ellenőrzés előtt): ha `grep -nE '^coverage(-temp)?/?$' .gitignore` találatot
   ad, NE futtassuk a coverage gate-et, csak a célzott teszteket
6. **Authorship check** (CLAUDE.md §8): `git log -1 --format='%an <%ae>'` a
   készülő commit author-a megegyezik a branch többi commitjáéval. Ha eltérés,
   ÁLLJ MEG és kérdezzük a user-t (ne javítsd önhatalmúlag).

Ha bármelyik gate eltérést mutat, a workflow visszafordulása nem automatikus —
a Phase 3 verifierek FAIL outputjával a usernek kell döntenie a javításról
vagy a revert commitról.

## Out of scope

- A `src/web/auto-restart-runner.ts` NEM kap instance formát — a fogyasztó
  változatlan marad (a free function wrapper-ökön keresztül hívja a class-t).
  Egy jövőbeli ciklusban a runner is kaphat instance formát (a Phase 5 web/
  runners részeként), de az most kívül esik.
- A `docs/refactor-to-classbase/` MD frissítése a landolt commit SHA-ra Phase 8
  (Documentation reconciliation) része, nem most.
- A `__test_handleWatchEvent`/`reloadOverridesForTest` típusú escape hatch-ek
  (`06-risks-and-mitigations.md R4`) itt nem relevánsak — nincs singleton
  state, nincs amit reset-elni kellene.
- A `process-lock.ts:19,49,275` `LogFn` → `LoggerLike` migráció (Phase 1 / H.1)
  külön fázis, nem most.
- A `Config.fromEnv(logger?)` factory (b-config B.1) külön fázis, nem most.