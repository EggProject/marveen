# Coverage gate zöldre állítása — Cycle 59

## Context

A `test/baseline` branch HEAD `d30f8af` minden needs-to-be-fix MD-je le van zárva (high.md: 11, medium.md: 19, low.md: 30, baseline-unreachable.md: 99, orphan.md: 24 — összesen 183). A CI két gate-je közül a `bun run coverage` piros: `vitest.config.ts` 100% `perFile` threshold-öt pinel (lines/functions/branches/statements), és 44 forrásfájl ez alatt van. Összesítés: lines 99.94%, statements 99.84%, functions 99.72%, branches 98.99%. Mind a 11092 teszt PASSZOL — ez tisztán threshold gate, nem teszt hiba.

A `test-suite-forbid-incomplete-coverage.md` (Partial, 2026-08-28) kifejezetten kimondja: "closing this row does NOT turn the CI `bun run coverage` job green. That job is red for an unrelated reason — `vitest.config.ts` pins a 100% `perFile` coverage threshold and 44 files sit below it". Ez a terv azt a 44-fájlos gap-et zárja le.

A lint gate (1703 TS error + 9933 ESLint error, tooling debt a `ci-eslint-typecheck-baseline.md` szerint) ezen a cikluson kívül esik.

## Megelőző bizonyíték (precedens, ami alátámasztja, hogy működni fog)

- **Cycle 47-48 NO-OP re-measurement** (`dbc25ab`, 2026-08-26): 2 stale MD-t zárt le (`channel-coordinator-internals-untestable` 46%/34% állítással, valójában 100%; `web-inbound-probe-respawn-grace` 63% állítással, valójában 100%). Zéró source diff.
- **Cycle 25-26 defensive branch batch** (`c2b4ea2`): 21 site / 14 fájl / 1 commit, minden fájl 100%-ra ugrott.
- **Defensive branch egyenként** (`08d7508`, `014f1de`, `642b883`, `232fac7`, `900cdb6`, `1a9d0d5a`, `eb9b951`): mind 1-3 soros törlés, regression test comment refresh.
- **`__test_*` prefix export** (`f75caf6`, `cf85135`): cycle 47-48 minta, private helper-ek unit-testable-exportja.

A user választott: **konzervatív** — NO-OP re-measurement first (zéró kockázat), utána targeted delete (1 commit per fájl). Lint autofix és új bug vadászat ezen a cikluson kívül.

## Akcióterv

A user kérése: workflow tool az végrehajtáshoz, minden a jelenlegi branchről indul és oda megy vissza, végén `/code-review max --fix` skill (user hívja manuálisan), dupla ellenőrzés 2 különböző szögű subagent-tel (CLAUDE.md §8).

### Phase 0 — Worktree izoláció (CLAUDE.md §8)

```
ls /Users/eggp/marveen-develop/test-baseline/store/
```

Ha NEM üres: `git worktree add --detach $HOME/claw-cov-fix test/baseline` + `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-cov-fix/node_modules`. A worktree `$HOME` alatt kell legyen, **NEM `/tmp/` alatt** — `/tmp/` alatt a `_TMP_PREFIXES` guard 19 spurious failt produkál (cycle 58 tanulsága).

Ha üres: main checkout használható (a `setup/assert-not-live-install.ts` és `setup/forbid-system-calls.ts` setup file-ok amúgy is gate-elnek).

### Phase 1 — Coverage measurement (a 44 fájl azonosítása)

```
bun --bun vitest run --coverage --coverage.reporter=json-summary --coverage.reporter=json
```

A `coverage/coverage-final.json`-ból és `coverage/coverage-summary.json`-ból kinyerjük a 44 fájlt, fájlonként: aktuális % mind a négy metrikára, fedetlen branch ID-k, fedetlen line range-ek.

Kimenet: `coverage-low-files.txt` — `src/path/to/file.ts:branches:99.4` formátumban. NEM commitoljuk (gitignored).

### Phase 2 (a) — NO-OP re-measurement pass (konzervatív, zéró kockázat)

Minden Phase 1-ből jövő fájlra + minden olyan MD-re ami explicit alacsony %-ot állít de a `Resolved:` oszlopban már rajta van:

1. Fájl kiolvasása, MD cross-check (`low.md` / `baseline-unreachable.md` / `orphan.md`).
2. Targeted coverage mérés: `bun --bun vitest run --coverage --coverage.include='src/<path>' <test-file>`.
3. Ha a perFile metrika 100% → írunk egy docs commitot, ami lezárja az MD-t a mért számokkal (`dbc25ab` minta: "Re-measured on YYYY-MM-DD with istanbul, coverage.include restricted to <file>, N test files passed, 0 failures: 100% lines/branches/functions/statements.").
4. Ha a perFile metrika továbbra is <100% → Phase 3-ba megy, MD-t nem bántjuk.

A user konzervatív stratégiát választott, tehát **NO-OP commit csak akkor, ha a fájl valóban 100%**. Ha az MD már le van zárva (`Resolved:` oszlopban), és a fájl 100%, nem nyúlunk hozzá.

Jelölt MD-k (Phase 1 fogja pontosítani):
- `channel-coordinator-coverage-limits.md` — 99.15% branches (Phase 1-ből ellenőrizve, mert `1a9d0d5a` törölte a `maxUpdateId != null` guard-ot 2026-08-16-ban)

Becsült: 5-15 NO-OP commit (docs-only, 5-90 LOC).

### Phase 3 (b) — Targeted defensive branch törlés (1 commit per fájl)

A Phase 1-ből maradt fájlokra (Phase 2 nem zárta le):

1. `git blame <file>` és `git log -p -- <file>` — keresünk friss editet ami `?? null`/`?? ''`/`?? []`/`|| '...'` fallback arm-öt hagyhatott.
2. Struktúrálisan unreachable arm azonosítása (LHS típusa `T | null`/`T | undefined`, és LHS nem lehet null/undefined egyetlen elérhető úton sem).
3. Törlés. `bun run typecheck` delta = 0 (CLAUDE.md §7 strict generics, `as` helyett `!` vagy upstream narrowing ha kell).
4. Pinning teszt: `bun --bun vitest run --coverage --coverage.include='src/<path>' <test-file>` — a fájl 100%-ra ugrik.
5. Teljes suite: `bun --bun vitest run` — pass count változatlan (11092).

Per-fájl commit (cycle 58 minta, 16 per-file opt-in commit). Becsült: 5-25 commit, 50-150 LOC source + 30-80 LOC test comment refresh.

Ha TS strict blokkolja (orphan MD minta: `*-ts-strict-blocks-delete`): upstream type narrowing, lásd `8e11043` (federation-routes-fedpeer-required-type-narrow-deferred).

### Phase 4 — Docs reconciliation

Egy batch commit (vagy 1-3) ami frissíti:
- `docs/needs-to-be-fix/low.md` — `test-suite-forbid-incomplete-coverage` státusza Partial-ről Full-ra ha a gate zöldre vált.
- `docs/needs-to-be-fix/README.md` — új MD-k száma, ha fájlok maradtak.
- Új MD (opcionális): `docs/needs-to-be-fix/cycle-59-coverage-gate-green.md` — összefoglaló a Phase 0-7 munkáról, before/after mért számokkal.

Minták: `dbc25ab`, `1d1d917`, `b63d6b7`, `c9840e5` (cycle 58 batch).

Becsült: 1-3 commit, 50-200 LOC.

### Phase 5 — Verification (Phase 6 a Plan agent output-ban)

```
bun --bun vitest run --coverage         # exit 0 → coverage gate zöld
bun run typecheck                       # delta 0 (1703 → 1703)
bun --bun vitest run                    # 11092/11092 passz
git status                              # clean
git log --oneline d30f8af..HEAD         # minden (this commit) placeholder SHA-ra cserélve
```

### Phase 6 — Workflow tool + 2 különböző szögű verifier (CLAUDE.md §8 dispatch)

A workflow tool-t használjuk a multi-phase orchestrációhoz (a 2026-08-26-os `_wf-impl-prompt.md` template alapján, ami 4/4 agent sikeres volt). Pipeline:

- **A: explore** — Phase 1 coverage measurement, `coverage-low-files.txt` emit.
- **B: classify** — 44 fájl olvasása, (a)/(b)/(c) címke.
- **C: parallel implement** — `parallel()` a fájl csoportokon.
- **D: verify** — 2 subagent **Agent tool**-lal, `isolation: worktree`:
  - **ALPHA (checklist verifier):** Strukturált PASS/FAIL checklist — minden NO-OP claim mért számmal alátámasztva; minden source edit-nek van regression testje; coverage gate exit 0; nincs új TS error.
  - **BETA (adverzariális falsifier):** Szabadkézzel cáfol — 3 random fájlt a 44-ből függetlenül újramér, plusz `/tmp/`-worktree tesztet futtat (cycle 58 csapda).
- **E: follow-ups** — ALPHA/BETA találatok alkalmazása.

### Phase 7 — User `/code-review max --fix` invokáció

CLAUDE.md §8: a Skill tool elutasítja a `disable-model-invocation` flag miatt. A user hívja manuálisan a terminálban. Az agent a végén írásban emlékezteti a user-t, hogy ő indítsa.

## Becsült scope

| Phase | Commit | LOC | Wall time |
| --- | --- | --- | --- |
| 0 setup | 0 | 0 | 1 min |
| 1 measure | 0 | 0 (gitignored) | 3-5 min |
| 2 NO-OP | 5-15 | 30-90 (docs) | 30-90 min |
| 3 delete | 5-25 | 50-150 + 30-80 | 2-6 h |
| 4 docs | 1-3 | 50-200 | 30-60 min |
| 5 verify | 0 | 0 | 3-5 min |
| 6 verifiers | 0 | 0 | 30-60 min |
| 7 user review | user | user | user |

**Összesen (agent-oldali):** 11-43 commit, ~160-520 LOC, 4-9 óra wall time, **1 calendar day**.

A 44 fájl a Phase 1-ből Phase 2-vel 30-100%-ban záródhat NO-OP-pal (cycle 47-48 minta: 2/2). Ami marad, Phase 3-ban záródik targeted törléssel.

## Kritikus fájlok

- `/Users/eggp/marveen-develop/test-baseline/vitest.config.ts` — a 100% perFile threshold, amit zöldre kell tenni.
- `/Users/eggp/marveen-develop/test-baseline/.claude/CLAUDE.md` — dispatch rule-ok, worktree rule-ok, no-push rule, strict generics rule, `kötelező commitolni`, `kötelező minden bug-t teszttel lefedni a javítás után`, §8 workflow/agent/verifier dupla ellenőrzés.
- `/Users/eggp/marveen-develop/test-baseline/.github/workflows/CLAUDE.md` — CI gate definíciók, "Why coverage is red" indoklás.
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/test-suite-forbid-incomplete-coverage.md` — az MD, amit zárunk Phase 4-ben (Partial → Full).
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/baseline-unreachable.md` — Phase 2 NO-OP jelölt MD-k itt vannak.

## Constraint-ek, amiket a végrehajtás során be kell tartani

- **CLAUDE.md §6:** Nincs push, csak lokális commit. Nincs `as`, nincs em dash, nincs AI klisé, nincs TaskStop futó agenten, nincs `/tmp/` worktree.
- **CLAUDE.md §7:** Strict generics (`as` helyett `!`/`satisfies`, `any` helyett `unknown`), template string, typeguard-ok, minden bug-hoz regression test, `kötelező commitolni`.
- **CLAUDE.md §8:** Minden futás `$HOME` worktree-ben (NEM `/tmp/`), Workflow tool multi-phase orchestrációhoz, Agent tool a 2 különböző szögű verifier-hez, végén user hívja a `/code-review max --fix`-et.

## Zöld gate definíció

```
$ bun --bun vitest run --coverage
... (11092 tests pass, 382 files, 0 failures, no coverage error)
exit code: 0

$ bun run typecheck
delta: 0 vs. 1703 baseline

$ bun --bun vitest run
Test Files  382 passed (382)
     Tests  11092 passed (11092)

$ git status
nothing to commit, working tree clean
```
