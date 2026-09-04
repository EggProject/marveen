# Plan — Cycle 24 next batch: 3 Tier 0 dead-branch safe-deletes

## Context

A `test/baseline` branch jelenlegi HEAD: `5b150f7` (`test(update-checker): rename stale 'swallows rejections from the inner refresh' test`). Local state ahead of origin: `0\t3` (a Cycle 24 update-checker batch commitjai). A `docs/needs-to-be-fix/INDEX.md` 95 open itemet sorol: 10 High, 8 Medium, 20 Low, 49 baseline addenda, 8 orphan addenda.

A korábbi cycle-ok konvenciója szerint (`mellow-sparking-stonebraker.md:1`, `compiled-stargazing-toucan.md:1`, `quiet-sleeping-kazoo.md:1`) a "legkisebb módosítás × legkisebb lehetséges bukás" kritérium a Tier 0 — tiszta dead-branch safe-deletes, nulla viselkedésváltozás, lefedettség javul. A user a Top 3 legkisebb itemet választotta, clusters (store-watcher, message-router) és TS-strict-blokkoltak nélkül.

A cél: 3 Tier 0 safe-delete, fix+docs commitpáronként (összesen 6 új local commit), branch `test/baseline`-en marad, nincs push. Végén kötelező a `/code-review xhigh --fix` (built-in slash command) — in-scope findingeket auto-alkalmazza, PLAUSIBLE/out-of-scope usert kérdezi.

## Kiválasztott itemek (Top 3)

### A — `routes-docs-basename-redundant`
- **Fájl:** `src/web/routes/docs.ts:62` — `PUT /api/docs/<name>` handler
- **Hiba:** `basename(name) !== name` check elérhetetlen. A fenti `NAME_RE = /^[A-Za-z0-9._-]+\.md$/` már kiszűri a `/`-t, így `basename` semmit nem változtatna az inputon.
- **Fix:** törölni az `if (basename(name) !== name)` blokkot (és a 400 return-t).
- **Lefedettség:** `src/__tests__/routes-docs.test.ts` — gap, nincs synthetic test erre a sorra.

### B — `agent-team-trustfrom-nullish-coalesce`
- **Fájl:** `src/web/agent-team.ts:191,192`
- **Hiba:** `team.trustFrom ?? []` mindkét jobb-ága elérhetetlen. A `team` típus-szűkítés a fenti `if (!team)` után garantálja a `trustFrom` jelenlétét.
- **Fix:** törölni a `?? []` default-ot mindkét sorban.
- **Lefedettség:** `src/__tests__/agent-team.test.ts` — gap.

### C — `schedule-runner-mcpmissingreason-cache-miss-unreachable`
- **Fájl:** `src/web/schedule-runner.ts:469` — `mcpMissingReason`
- **Hiba:** `lastMcpMissing.get(...) ?? []` cache-miss ág elérhetetlen — minden hívó előtte pre-populálja a cache-t.
- **Fix:** törölni a `?? []` default-ot.
- **Lefedettség:** `src/__tests__/schedule-runner.test.ts` — gap.

## Végrehajtási minta (Workflow tool, sequential agent)

A Workflow tool `meta`-ban 3 fix-fázis + 1 final-verify + 1 code-review fázis. Nincs worktree izoláció, nincs párhuzamos agent — közös git index, szekvenciális végrehajtás (`compiled-stargazing-toucan.md:120`).

Minden fixhez (A, B, C) két `agent()` hívás szekvenciálisan:
1. **Fix agent** — elvégzi a forrás-módosítást, typecheck + pinning test + full suite + diff scope check, commit, visszaadja a SHA-t.
2. **Docs agent** — ugyanazzal a SHA-val frissíti `docs/needs-to-be-fix/INDEX.md`-t (`Resolved: 2026-08-18 <sha>`), commit, visszaadja a SHA-t.

A Workflow `agent()` default schema-ja structured output, így minden lépésnél megköveteljük a `restrictive_checks_passed: boolean` mezőt. Ha `false`, a workflow megáll.

### Fix agent prompt-minta (paraméterezve slug-ra)

```
Cycle 24 safe-delete, item: <SLUG>
File: <PATH>:<LINE_RANGE>
Defect: <egy-sor leírás>

Step 1: cat a fájlt, olvasd a megadott sorokat környezettel (10 sor előtte/utána).
Step 2: bun run typecheck 2>&1 | grep -cE "^[a-zA-Z./][^(]*\([0-9]+,[0-9]+\): error TS"
   → capture BASELINE_ERROR_COUNT.
Step 3: távolítsd el a dead branch-et. Restriktív szabályok:
   - nincs `as`, nincs `any`, nincs string konkatenáció.
   - `satisfies` helyett `as`, `unknown` helyett `any`.
   - typeguard-ok használata, ha kell.
Step 4: bun run typecheck → újraszámolni az error count-ot. MUST ≤ BASELINE_ERROR_COUNT.
Step 5: bun test src/__tests__/<fájl>.test.ts 2>&1 | tail -15 — a meglévő tesztnek zöldnek kell maradnia.
Step 6: bun test 2>&1 | tail -10 — full suite zöld.
Step 7: git diff --stat — CSAK az egyetlen idézett fájl módosult.
   → git status --short — csak a módosított fájl.
Step 8: git add <fájl> && git commit -m "fix(<scope>): <description>".
Step 9: git log -1 --format=%H → COMMIT_SHA.

Bármely lépés FAIL → restrictive_checks_passed: false, add meg a hibaüzenettel.
Ha minden lépés PASS → restrictive_checks_passed: true, COMMIT_SHA vissza.
```

Commit message formátum (korábbi cycle-okból átvéve):
- `fix(routes-docs): drop redundant basename check at docs.ts:62`
- `fix(agent-team): drop dead ?? [] right-arms at agent-team.ts:191,192`
- `fix(schedule-runner): drop unreachable ?? [] cache-miss branch at schedule-runner.ts:469`

### Docs agent prompt-minta

```
Mark <SLUG> as resolved in docs/needs-to-be-fix/INDEX.md.

Step 1: olvasd a docs/needs-to-be-fix/INDEX.md-t, keresd a <SLUG> sort.
Step 2: töltsd ki a `Resolved` oszlopot: `2026-08-18 <COMMIT_SHA>` (7-char short SHA is OK).
Step 3: ha a sort "Resolved: YYYY-MM-DD" szintaxissal tölti, egyezzen a többi kitöltött sorral.
Step 4: bun run typecheck (változatlan kell legyen — docs-only commit).
Step 5: git diff --stat — csak docs/needs-to-be-fix/INDEX.md módosult.
Step 6: git add docs/needs-to-be-fix/INDEX.md && git commit -m "docs(needs-to-be-fix): mark <SLUG> resolved".
Step 7: git log -1 --format=%H → DOCS_COMMIT_SHA.

A korrábbi docs commit üzenetek: `docs(needs-to-be-fix): mark <slug> resolved`.
```

Commit message-ek:
- `docs(needs-to-be-fix): mark routes-docs-basename-redundant resolved`
- `docs(needs-to-be-fix): mark agent-team-trustfrom-nullish-coalesce resolved`
- `docs(needs-to-be-fix): mark schedule-runner-mcpmissingreason-cache-miss-unreachable resolved`

### Végső verify + code-review

A 3 fix + 3 docs commit után:

1. **Final verify agent:**
   - `git status` clean
   - `git log --oneline -10` mutatja a 6 új commitot (3 fix + 3 docs)
   - `git branch --show-current` = `test/baseline`
   - `git rev-list --left-right --count origin/test/baseline...test/baseline` = `6\t0`
   - `git log --oneline origin/test/baseline..HEAD | wc -l` = 6 (nincs push)
   - `grep -n 'Resolved: 2026-08-18' docs/needs-to-be-fix/INDEX.md | head -10` mind a 3 slugot mutatja
2. **`/code-review xhigh --fix` skill hívása** — a 6 új commitra. A built-in slash command fut; in-scope findingeket auto-alkalmazza + commitolja; PLAUSIBLE/out-of-scope findingeknél a parent agent megbeszéli a userrel.

## Push-policy (hard rule, .claude/CLAUDE.md:77)

- A workflow SOHA nem pushol.
- A user dönt, hogy pushol-e a workflow befejezése után.
- Ha CI-t akar a user, manuálisan pushol, a workflow csak lokális commitokat készít.

## Branch policy

- Workflow indul: `test/baseline` @ `5b150f7`.
- Workflow végén: `test/baseline` @ `5b150f7 + 6 commit` (3 fix + 3 docs).
- Branch NEM vált, NEM pushol.

## Failure handling

- Bármely fix lépésben a typecheck/error count nő → `restrictive_checks_passed: false`, workflow megáll, report a usernek.
- Bármely teszt pirosul → ugyanígy.
- A Cycle 21 (`lexical-wobbling-stearns.md:1`) `revert+replace` mintája érhető el, ha kiderül, hogy egy fix rossz: `git revert <bad-sha> --no-edit`, majd új fix commit, végül a docs commit frissíti a SHA-t.

## Kritikus fájlok

- `src/web/routes/docs.ts` — A item (PUT handler)
- `src/web/agent-team.ts` — B item
- `src/web/schedule-runner.ts` — C item
- `docs/needs-to-be-fix/INDEX.md` — mindhárom docs commit ide ír
- `package.json:7-22` — `typecheck` és `test` script definíciók (verifikáció forrása)

## Verification end-to-end

A workflow végén a user a következőket ellenőrzi:

```
git log --oneline origin/test/baseline..HEAD    # 6 új commit
git rev-list --left-right --count origin/test/baseline...test/baseline  # 6\t0
git status                                       # clean
bun run typecheck 2>&1 | tail -5                 # error count ≤ baseline (capture-elt érték)
bun test 2>&1 | tail -5                          # full suite green
grep -c "Resolved: 2026-08-18" docs/needs-to-be-fix/INDEX.md  # ≥ 3 (a 3 új + esetleg korábbi)
```

A `/code-review xhigh --fix` skill ezt követően fut — ha bármi in-scope findinget talál, a skill alkalmazza és új commitot készít. Ha out-of-scope (pl. refaktor javaslat), a skill visszakérdez a userhez.