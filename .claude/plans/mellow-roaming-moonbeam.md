# Cycle 18 — Smallest + Lowest-Risk needs-fix items

## Context

A `docs/needs-to-be-fix/` backlog 176 MD-t tartalmaz. A Cycle 16-17 négy MD-t zárt (memories-put-tier, multipart-case-sensitive, kanban-dispatch-owner-case, keychain-retrieve). A mostani ciklus kifejezetten a **legkisebb forrás-módosítással járó és a legkisebb regressziós kockázatú** jelölt(ek)et célozza, a user explicit kérésére. A Phase 1 (két Explore) és Phase 2 (Plan agent) 12 MD-t verifikált HEAD-en (`0e1176d`). A peer Explore üzenetek három fontos korlátozást tártak fel:

1. **`routes-docs-basename-redundant`** kimarad: az MD maga írja, hogy a guard addig nem törölhető, amíg `profiles-traversal-id` nyitva van, és defense-in-depth szerepe van. A pinning teszt 12 LOC-sát amúgy is törölni kellene.
2. **`routes-update-checker-dead-catch-handlers`** +0/-2 src / +0 test, DE elveszti a future unhandled-rejection containmentet — a `refreshUpdateStatus` outer try/catch (line 199/243) és a `return status` (line 247) az "always-resolve" contract; ezt a contract-ot feltételezve a fix biztonságos. A `routes/updates.ts:41-46,112-115` `await`-eli a függvényt, tehát a contract betartása mellett nem marad unhandled rejection.
3. A **`-1` regression** a `routes-spans-nan-limit` MD-ben is érintett: `Math.min(-1, 200) === -1` túlél, a SQLite `LIMIT -1`-et unbounded-nek kezeli. A kanonikus pattern (`Number.isFinite && limitRaw > 0`) egyszerre zárja a NaN és a negatív esetet.

## Top 3 candidates (executionsre kijelölve, rangsor)

| # | Bug ID | File:Line | src delta | test delta | Kockázat |
|---|--------|-----------|-----------|------------|----------|
| 1 | `routes-update-checker-dead-catch-handlers` | `src/web/update-checker.ts:255,256` | +0/-2 | +0 | very low (contract-függő) |
| 2 | `routes-update-checker-path-mismatch` | `docs/needs-to-be-fix/routes-update-checker-path-mismatch.md` | 0 | 0 | zero (doc-only) |
| 3 | `routes-spans-nan-limit` | `src/web/routes/spans.ts:67` | +1/-1 | +1/-1 + 1 új it (limit=-1) | low |

Kimarad (Cycle 19-be):
- `routes-memories-nan-limit` (+1 src, +2 új test) — hasznos, de más nap
- `routes-skill-usage-jsonparse-throws` (+1/-1 src, +0 test) — hasznos, más nap
- `routes-tool-log-uncaught-json-parse` (+2 src, +0 test) — hasznos, más nap

## Javasolt végrehajtási terv (4 commit, a `test/baseline` branch-en)

### Commit 1 — src: dead-catch törlés (Candidate #1)
- **File:** `src/web/update-checker.ts`
- **Patch:** töröld a `.catch(() => {})` -t a line 255-ről és line 256-ról. Két helyen: a `setTimeout` és `setInterval` callback-ben lévő `refreshUpdateStatus()` Promise-ból.
- **Test:** nincs változtatás. A `src/__tests__/update-checker-routes.test.ts:587-639` (második it: 622-638) továbbra is zöld marad, mert a külső try/catch a `refreshUpdateStatus`-ban (line 243-244) garantálja, hogy nincs reject.
- **Coverage hatás:** `update-checker.ts` 15/17 → 15/15 funcs (100%), mert a két fedetlen arrow f[14] és f[16] törlődik.
- **Commit message:**
  ```
  fix(update-checker): drop unreachable .catch(() => {}) handlers in startUpdateChecker

  refreshUpdateStatus always resolves (outer try/catch at L243-244
  swallows the throw and L247 returns status), so the two inner catch
  arrows in startUpdateChecker are dead code. Removing them unblocks
  the remaining 2/17 v8 function hits and brings update-checker.ts to
  100% funcs.

  Refs docs/needs-to-be-fix/routes-update-checker-dead-catch-handlers.md
  ```

### Commit 2 — docs: két sor `Resolved` (Candidate #1 + #2)
- **File:** `docs/needs-to-be-fix/INDEX.md`
- **Patch:** két sor módosítása:
  - L172: `routes-update-checker-dead-catch-handlers` → `Resolved: 2026-08-17 <sha1>` ahol `<sha1>` a Commit 1 SHA-ja.
  - L173: `routes-update-checker-path-mismatch` → `Resolved: 2026-08-17 <sha1>` — ugyanaz a SHA, mert Candidate #1 commit tette "real-and-now-clean"-né a `src/web/update-checker.ts:255,256` path-ot.
- **Commit message:**
  ```
  docs(needs-to-be-fix): mark update-checker items resolved (dead-catch, path-mismatch)

  - routes-update-checker-dead-catch-handlers: deleted by the previous commit.
  - routes-update-checker-path-mismatch: the real path
    (src/web/update-checker.ts:255,256) was the only outstanding item
    the MD called out; with the dead handlers gone, both rows can close.
  ```

### Commit 3 — src + test: spans NaN clamp (Candidate #3)
- **File 1:** `src/web/routes/spans.ts:67`
  ```ts
  // Before
  const limit = Math.min(parseInt(url.searchParams.get('limit') ?? '50'), 200)
  // After
  const limitRaw = Number(url.searchParams.get('limit'))
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 200) : 50
  ```
- **File 2:** `src/__tests__/spans-routes.test.ts:413-423`
  - A jelenlegi pinning tesztet (`passes NaN to listOtelTraces when the limit query param is not a number`) átírni:
    - Leírás: `falls back to the default limit when the query param is not a positive number`
    - `expect(H.listOtelTraces).toHaveBeenCalledWith(NaN)` → `expect(H.listOtelTraces).toHaveBeenCalledWith(50)`
  - Új `it()` blokk hozzáadása a `-1` esetre:
    ```ts
    it('falls back to the default limit when the query param is negative', async () => {
      H.listOtelTraces.mockReturnValue([])
      const { res } = await call('GET', '/api/traces', { query: 'limit=-1' })
      expect(res.statusCode).toBe(200)
      expect(H.listOtelTraces).toHaveBeenCalledWith(50)
    })
    ```
- **Net test delta:** +11/-12 LOC (egy átírt + egy új `it()`). A korábbi pinning kommentje (NaN→better-sqlite3→LIMIT NaN) törlődik.
- **Commit message:**
  ```
  fix(routes/spans): clamp non-positive/NaN limit on GET /api/traces to default 50

  The dispatcher forwarded Math.min(parseInt(<garbage>), 200) verbatim to
  listOtelTraces, so ?limit=foo hit better-sqlite3 with LIMIT NaN
  (RangeError -> 500) and ?limit=-1 was treated as unbounded by SQLite.

  Mirror the canonical guard at src/web/routes/agent-conversation.ts:148-149:
  parse with Number(), require Number.isFinite AND > 0, fall back to 50.

  Refs docs/needs-to-be-fix/routes-spans-nan-limit.md
  ```

### Commit 4 — docs: spans-nan-limit `Resolved` (Candidate #3)
- **File:** `docs/needs-to-be-fix/INDEX.md`
- **Patch:** L170: `routes-spans-nan-limit` → `Resolved: 2026-08-17 <sha3>` ahol `<sha3>` a Commit 3 SHA-ja.
- **Commit message:**
  ```
  docs(needs-to-be-fix): mark routes-spans-nan-limit resolved

  The pinning test in src/__tests__/spans-routes.test.ts now asserts the
  correct (defaulted) behavior; the dispatcher-level fix landed in the
  previous commit.
  ```

### Commit sorrend és párhuzamosság
- Commit 1 (dead-catch törlés) és Commit 3 (spans clamp) párhuzamosan alkalmazhatóak — különböző fájlok, nincs conflict.
- Commit 2 és Commit 4 csak INDEX.md-t érintenek — egymás után jönnek (különböző timestamp-ek, nincs conflict, mert különböző sorokat módosítanak).
- Mind a 4 commit a `test/baseline` branch-en marad, lokálisan. Nincs push.

## Verifikáció (az orchestrator futtatja minden commit után)

Minden src commit (1 és 3) után:
1. `git rev-parse HEAD` — ellenőrzi, hogy az új commit a várt message-szel jött létre.
2. `git diff HEAD~1 -- src/web/update-checker.ts` (vagy `spans.ts`/test) — csak a tervben leírt sorok változnak.
3. `bunx tsc --noEmit` — exit 0, error count == 1701 (frozen baseline a `ci-eslint-typecheck-baseline.md` alapján).
4. `bun run test` — exit 0; a pre-existing coverage-threshold (100% per-file) failures maradnak, de NINCS új failure kategória.
5. Targeted re-run: `bunx vitest run src/__tests__/update-checker-routes.test.ts` és `src/__tests__/spans-routes.test.ts` minden it zöld.
6. `coverage/coverage-final.json` — `update-checker.ts` funcs száma 17→15 (két arrow törlődik); `spans.ts` lines/statements/branches marad 100%, funcs száma nem változik.

Minden docs commit (2 és 4) után:
1. `git diff HEAD~1 -- docs/needs-to-be-fix/INDEX.md` — csak a tervben leírt sorok változnak.
2. `wc -l docs/needs-to-be-fix/INDEX.md` — unchanged.
3. `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l` — unchanged (176).
4. `git status` clean.

A Cycle 18 végén: `git status` clean, 4 új commit a `test/baseline`-en, `bunx tsc --noEmit` == 1701, `bun run test` exit 0 (pre-existing failures elfogadhatók).

## Branch politika

- **Start:** `test/baseline` @ `0e1176d` (clean working tree).
- **End:** `test/baseline` + 4 új lokális commit. Nincs push, nincs PR, nincs force.
- **A user maga pusholja** — ebben a ciklusban nem.

## Kockázat és rollback

- **Candidate #1 (dead-catch):** ha bármely jövőbeli refaktor a `refreshUpdateStatus`-ban a try/catch-en kívül throw-ol, unhandled promise rejection keletkezhet. A jelenlegi contract (`async` függvény, minden hibaág a `status.error`-ba megy, line 247 `return status`) ezt kizárja. **Rollback:** `git revert <sha1>` — 2 sor vissza, nincs test churn.
- **Candidate #2 (path-mismatch):** zero kockázat, doc-only.
- **Candidate #3 (spans clamp):** ha a felhasználó legitim `?limit=0`-t vagy `?limit=-1`-et küld, most 50-et kap. A `agent-conversation.ts:149` mintája is ezt a floor-t használja (`limitRaw > 0`). **Rollback:** `git revert <sha3>`.
- **Teszt-rewrite kockázat (Candidate #3):** a pinning `it()` átírása. A `H.listOtelTraces` mock setup neighbor tesztekkel osztozik; a `mockReturnValue([])` és `mockClear()` konzisztenciáját a pre-flight check során meg kell erősíteni.

**Hard-stop feltételek (az orchestrator megszakítja és lokálisan revertálja):**
- `bunx tsc --noEmit` új TS hibát vezet be, ami nincs a baseline-1701-ben.
- `bun run test` ÚJ fájlban új failure-t hoz be (pre-existing red elfogadható).
- `git diff` nem-tervezett fájlt mutat (pl. `package.json`, lockfile, más route, más test).

## Honcho szabályok betartása

1. **HARD RULE: Claude nem ír/szerkeszt kódot.** A 4 commit az Apply subagent(ek) által készül. Az orchestrator csak a verifikációt (`bunx tsc --noEmit`, `bun run test`) futtatja, és nem nyúl a kódhoz.
2. **'Clean baseline before expanding':** a két src commit nem csökkenti a coverage-ot (sőt, A1 emeli az `update-checker.ts` funcs coverage-ot). A pre-existing threshold-100% failures maradnak, de NEM új kategória.
3. **Bug-pinning test policy:** a spans pinning teszt a 413-423 sorokban a NaN-t várta; most a helyes (defaulted) viselkedést rögzíti. Ez a policy-nak megfelelő átírás, nem a "teszt meghamisítása".
4. **Verification rule:** az orchestrator a verifikációs szakaszban futtatja a parancsokat és idézi az outputot, NEM bízik az Apply saját jelentésében.
5. **MD-premissa verifikáció:** a Phase 1 Explore ágensek közvetlenül olvasták a HEAD kódot, és a peer Explore üzenetek plusz kivonatokkal erősítették meg. A pinning teszt pontos kódja (lásd peer üzenet) és a 243/247-es sorok ellenőrizve vannak.

## Kritikus fájlok

- `src/web/update-checker.ts` — L255,256 (Commit 1)
- `src/web/routes/spans.ts` — L67 (Commit 3)
- `src/__tests__/spans-routes.test.ts` — L413-423 (Commit 3)
- `src/web/routes/agent-conversation.ts` — L148-149 (kanonikus minta referencia Commit 3-hoz)
- `docs/needs-to-be-fix/INDEX.md` — L170, L172, L173 (Commit 2 és 4)

## Végrehajtási struktúra (workflow ajánlott)

A user kérése: "Használd a plan tool-t! és a végrehajtáshoz workflow-t!". A Phase 5 (ExitPlanMode) jóváhagyása után a workflow:

1. **Phase "Apply-1+2"**: párhuzamosan két subagent (general-purpose, isolation: nélkül):
   - Subagent A: Commit 1 (update-checker fix). Kimenet: src diff, `bunx tsc --noEmit` exit+sorok, `bun run test` exit+counts.
   - Subagent B: Commit 3 (spans fix + test). Ugyanaz a kimenet.
2. **Phase "Verify-1+2"**: orchestrator függetlenül újrafuttatja a verifikációs parancsokat mindkét commit után. Ha bármelyik eltér a subagent jelentésétől → `git revert` és stop.
3. **Phase "Docs":** két subagent (vagy egy) a Commit 2 és Commit 4 INDEX frissítésére. Commit 2 a Commit 1 SHA-ját használja; Commit 4 a Commit 3 SHA-ját.
4. **Phase "Final verify"**: orchestrator `git log`, `git status`, `git diff origin/test/baseline..HEAD --stat`, `bunx tsc --noEmit`, `bun run test` idézett outputtal.

A workflow struktúra a user Honcho szabályait követi: "Claude orchestrates, plans, reviews, and reports only. Violated on 2026-08-15 when Claude hand-edited... the fix had to be reverted and re-authored by a workflow agent."

## Per-fix approval (Honcho szabály)

A Honcho explicit kimondja: "eggp's 'what's next' / 'mi a következő' needs-fix questions are IDENTIFICATION requests, not apply requests. The correct response is: (1) Plan agent ranks candidates, (2) present the top 3-5 ranked options with size+risk, (3) AskUserQuestion which one(s) to apply, THEN only after approval run the workflow. Never trigger a safe-delete workflow from a 'what's next' question without explicit per-fix approval."

A Phase 5 (ExitPlanMode) a terv jóváhagyása. Ha a user bármelyik candidate-et ki akarja zárni, vagy más sorrendet kér, a workflow-ban módosítható.

## Mi következik a Phase 5 után

A user döntésétől függően:
- **Ha mind a 3-at jóváhagyja:** a workflow a fenti struktúra szerint halad.
- **Ha csak #1+2-t (csak update-checkerek):** a workflow kihagyja a spans lépést; Commit 3+4 nem történik.
- **Ha csak #3-at (spans):** a workflow kihagyja az update-checker lépést; Commit 1+2 nem történik.
- **Ha mást választ:** a tervet átírjuk, és a workflow-t újra tervezzük.
