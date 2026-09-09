# A.2d ApprovalStore — code-review Skipped findings (2026-09-09)

A `/code-review max --fix` két findinget a "Skipped" szekcióba tett a `87c31c7` commit alkalmazása után. Ezek a `refactor/classbase` branch-en maradtak, NEM lettek follow-up commitokként javítva. A §7 szabály szerint memóriába írandók, hogy release checklist nélkül ne vesszenek el.

## Skipped finding #3 — Constructor signature divergence

**File:** `src/db.ts` ApprovalStore class (a `87c31c7` fix után a `log` field eltávolítása miatt a class 1 sorral rövidebb lett; az eredeti hely `:2286` volt, most `:2282`)

**Summary:** `ApprovalStore` constructor `constructor(deps?: { getDb?: () => Database; log?: LoggerLike })` (optional deps object, F.4 SettingsStore evolution). Az `IdeaStore` constructor `constructor(getDb: () => Database, log: LoggerLike)` (required positional args, IdeaStore original). Két azonos pattern-t használó class (module-singleton + thin shim) különböző DI shape-et használ ugyanabban a fájlban.

**Code-review justification for Skipped:** "out-of-scope per Surgical Changes rule". A diff szándékosan adoptálja az optional-deps shape-et, hogy `new ApprovalStore()` zero-arg maradjon a module-singleton használathoz. Az IdeaStore átalakítása külön ciklus lenne, és nem tartozik az A.2d scope-jához.

**Mitigáció / future action:** Ha a jövőben újabb per-entity store-okat extract-álunk (A.3, A.4, A.5, A.6, A.7, A.9 — a roadmap szerint), DÖNTSÜNK a canonical shape-ről. Jelenleg két út van:
- (a) Minden store átalakítása optional-deps-re (F.4 evolution: `new StoreName()` zero-arg a module-singleton-hoz, `{ getDb?, log? }` a DI override-hoz)
- (b) Minden store átalakítása required-positional-ra (IdeaStore current: `new IdeaStore(getDb, log)` explicit)

A döntés a Phase 7 App-wiring függvénye — ott kell eldönteni, hogy a DI container hogyan kezeli a store-okat (constructor injection vs factory pattern).

## Skipped finding #4 — T12/T14 module-singleton mutation footgun

**File:** `src/__tests__/approval-store-classes.test.ts` T12 (~line 378) és T14 (~line 466)

**Summary:** T12 és T14 a teszt végén `dbModule.getDb().close()`-t hív, de a module-level `let db` singleton-t (`src/db.ts:12`) NEM nullázza. A singleton csak `initDatabase()`-szel reassignolódik. T13 (DbClient.open independent, db.ts:387-421) és T15 (local closure) insulated. T14 saját re-initDatabase-je tolerálja a closed handle-t a try/catch-csel (db.ts:31-33). Tehát MOST nincs FAIL, de bármely jövőbeli teszt, ami `createApproval`-t hív `initDatabase(':memory:')` nélkül, "database is closed" hibát kap (a closed handle-en futó SQL throw-ol).

**Code-review justification for Skipped:** "latent footgun, not load-bearing for current diff; no test currently fails". A `src/__tests__/approvals.test.ts:11-13` `beforeEach`-ben reset-eli a singleton-t `initDatabase(':memory:')`-tel — ez a minta követhető, ha a footgun valóban tüzet fog.

**Mitigáció / future action:** Ha a jövőben újabb tesztet adunk az `approval-store-classes.test.ts`-hez, KÖTELESSÉGJÜNK az `approvals.test.ts:11-13` mintát: `beforeEach(() => { initDatabase(':memory:') })` a module-singleton reset-jéhez, hogy minden teszt tiszta :memory: handle-ről induljon. VAGY: a T12/T14 végén `dbModule.db = null` (vagy hasonló), hogy a next test FAIL-jon explicit "module db not initialized" hibával, nem pedig opaque "database is closed" üzenettel.

## Session state at exit

- **Branch:** `refactor/classbase` HEAD = `87c31c7`
- **A.2d commits on branch** (3 total, in merge order):
  - `863b325` — `refactor(db): extract ApprovalStore class with thin re-export shim (A.2d)`
  - `d40b5c2` — `fix(db): remove Phase 7 cycle references from ApprovalStore comments (H.4)`
  - `87c31c7` — `fix(db,test): apply code-review findings (drop unused log field, ban \`as\` cast)`
- **Gates at exit:** `bun tsc --noEmit` 0 errors; vitest 74/74 (22 approvals + 37 routes-approvals-full + 15 approval-store-classes); `export function` count 155; `export class` count 4; `ApprovalStore` class at `src/db.ts:2282`.
- **Diff scope vs `2045633`:** 2 files (`src/db.ts` + `src/__tests__/approval-store-classes.test.ts`), 605 insertions, 66 deletions. `src/web/routes/approvals.ts` byte-identical (shim preserves the 5 function names + `type Approval`).
- **Worktree cleanup:** `$HOME/claw-verify-merge` (Phase 4 verify at `d40b5c2`) és `$HOME/claw-verify-fixes` (Phase 5 verify at `87c31c7`) session-created, takarítandó a §8 "takaríts magad után" szabály szerint.
- **Author of all 3 commits:** `EggProjectTeams <eggprojectteams@gmail.com>`.