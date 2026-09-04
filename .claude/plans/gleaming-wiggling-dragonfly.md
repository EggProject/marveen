# Cycle 35 — Low severity dead-defensive-branch cluster

## Context

A `test/baseline` branch jelenlegi HEAD-je: `a4c5aba` (cycle 34, 9 commit, pushed).
A cycle 33 és 34 sikeres minta: Low severity dead defensive branches klaszterek safe-delete + pinning teszt törlés + docs resolution (cycle 34: channel-invites, agent-team, pane-state; mind 3-asával: fix + test + docs).

A cycle 35-re két független, dupla ellenőrzött klaszter maradt, ami ugyanazt a mintát követi és triviálisan összevonható (külön fájl, külön teszt, nincs kereszt-függőség):

1. **`context-guard-runner-dead-code-branches`** — 4 dead branch a `src/web/context-guard-runner.ts`-ben
2. **`message-router-dead-defensive-branches`** (részben) + **`message-router-unreachable-defensive-branches`** (részben) — 2 dead branch a `src/web/message-router.ts`-ben

A `message-router-unreachable-defensive-branches` MD-ből a `478-480` cache fallback ágak TS strict által blokkoltak (`cached?: T` → `T | undefined` típus-szűkítés nem megoldható `??` törléssel); ezek **kimaradnak** cycle 35-ből. A `message-router-dead-defensive-branches` MD-ből a `180`-as sor inverzió stilisztikai refactor (nem dead code, csak ritkán elérhető); ez is **kimarad**.

A teljes cycle 35 itt 6 commit (2 klaszter × 3 commit) és 1 végső verifikáció. A user a `/code-review xhigh --fix` skillt a végén manuálisan hívja (mint cycle 33/34).

## Pre-conditions (mért értékek a plan indításakor)

- Working tree: clean (`git status`)
- Branch: `test/baseline` (szinkronban `origin/test/baseline`-nel, HEAD `a4c5aba`)
- Tsc baseline: 1699 hiba (cycle 34 zárás: 1701 → 1700 a cycle 34 commitok miatt; a tényleges számot a Phase 1 agent méri és rögzíti)
- Tests baseline: 11132/11132 pass (cycle 34 zárás)
- Coverage: a cycle 35-ös célfájlok aktuális branch coverage-át a Phase 1 agent méri

## Cluster A — `context-guard-runner-dead-code-branches`

### Mit csinálunk

`src/web/context-guard-runner.ts` 4 elágazását töröljük. Mind a 4 esetben a TS típus `T | null`, de a `decideGuard` (`src/context-guard.ts`) contract garantálja, hogy a releváns case-be csak nem-null értékkel lépünk be. A `decideGuard` az egyetlen hívója a runner-nek, és minden visszatérési pontja kimerítően ellenőrzött (Phase 1 agent confirm-ölje a `decideGuard` minden `restart` / `request-handoff` return-jét).

| Sor | Eredeti | Csere |
|---|---|---|
| 263 | `handoffPrompt(pctRound ?? 0, handoffPathFor(name))` | `handoffPrompt(pctRound!, handoffPathFor(name))` |
| 274 | `const finalPane = pane ?? capturePane(session)` | `const finalPane = pane!` |
| 275 | `if (finalPane) { ... }` (egész blokk) | blokk feltétel nélkül; `finalPane!` ahol kell |
| 290 | `(snapshotPath ? ' Pane-snapshot...${snapshotPath}' : '')` | `(snapshotPath ? ' Pane-snapshot...${snapshotPath}' : '')` marad, de a `let snapshotPath: string \| null = null` típus-szűkítése `string`-re a blokkban |

Tripwire comment: minden `!` után egy komment, ami dokumentálja, miért garantált a non-null (hivatkozás a `decideGuard` contract-ra).

### Teszt impact

`src/__tests__/context-guard-runner.test.ts` — 51/51 pass jelenleg. A 2 pinning teszt a `describe('dead-code branches via mock-controlled decideGuard', ...)` blokkban (sorok 1297-1374) `mockDecideGuard.mockImplementationOnce` overload-ot használ, hogy a runner-t a dead branch-ba kényszerítse. Ezek a tesztek a dead code eltávolítása után értelmetlenné válnak (a mock-olt inputok nem fordulnak elő production inputokból). **Mindkét `it` blokkot töröljük** (sorok 1297-1374). A fennmaradó 49 teszt változatlanul átmegy.

### Mit NEM csinálunk

- A `decideGuard` módosítása (külön MD-cycle lenne)
- A `handoffPrompt` szélesítése `number | null` paraméterre (TS strict workaround, nem dead code eltávolítás)

### Commit-ok

1. **`fix(context-guard-runner): drop 4 dead defensive guards (lines 263, 274, 275, 290)`**
   - A 4 branch törlése `!` non-null assertion-ökkel
   - Tripwire comment-ek a `!` után
   - Verify: `bunx tsc --noEmit` delta 0; `bunx vitest run src/__tests__/context-guard-runner.test.ts` — 51/51 PASS (a 2 pinning teszt még mindig PASS, mert a szintaxis nem tört el)

2. **`test(context-guard-runner): remove dead-code-branches pinning describe block (lines 1297-1374)`**
   - A `describe('dead-code branches via mock-controlled decideGuard', ...)` teljes blokk törlése
   - A fölötte lévő komment határ (sorok 1284-1296) is törölhető, ha kizárólag erre a describe-re utal
   - Verify: `bunx vitest run src/__tests__/context-guard-runner.test.ts` — 49/49 PASS

3. **`docs(needs-to-be-fix): mark context-guard-runner-dead-code-branches resolved`**
   - A `docs/needs-to-be-fix/context-guard-runner-dead-code-branches.md` "Resolved:" sor hozzáadása (cycle 35 SHA)
   - `docs/needs-to-be-fix/INDEX.md` frissítése (sor + Resolved oszlop)

## Cluster B — `message-router` dead defensive branches (részleges)

### Mit csinálunk

`src/web/message-router.ts` 2 dead branch-ét töröljük:

| Sor | Eredeti | Csere |
|---|---|---|
| 81 | `if (msg.to_agent === MAIN_AGENT_ID) return` (notifyOrchestratorOfFailedHandoff) | sor törlése; a fölötte lévő komment (sor 79-80) is törölhető, ha kizárólag erre a guard-ra utal |
| 317 | `if (old.length === 0) return` (batchDeliverBacklog) | sor törlése; komment csere: `// old.length >= 1 by construction (caller's oldestAge gate).` |

Mindkét guard kimerítetten ellenőrzött:

- **Sor 81**: `notifyOrchestratorOfFailedHandoff` csak a `shouldAbandon` (sor 482-491) és az inject-give-up (sor 636) ágakból hívódik. Mindkettő a main-loop `if (isMainAgent) { ... continue }` (sor 461) után jön, tehát main-agent target soha nem jut el ide. A comment is dokumentálja: "A failed message to the main agent can't happen (pull model)".
- **Sor 317**: `batchDeliverBacklog` csak a reconnect pre-pass-ból hívódik (sor 408-416), ami guard-olja: `agentPending.length > RECONNECT_BATCH_THRESHOLD` (5) AND `oldestAge > RECONNECT_BATCH_AGE_MS` (30 perc). Az első üzenet (`agentPending[0]`) garantáltan 30 percnél idősebb, tehát a loop első iterációja `old.push`-ol, `old.length >= 1` mindig.

### Mit NEM csinálunk

- **Sor 180** (`if (stamped)` inverzió): a `stampMessageTrace` (`src/db.ts:3216-3227`) `boolean` visszatérésű, lehet `false` (ha a row nem pending vagy már van trace_id). A `false` ág ritka, de **reachable**. Az MD "invert the condition" javaslata stilisztikai refactor (no behavior change), nem dead code eltávolítás. Kihagyva.
- **Sorok 478-480** (cache fallback `??`): TS strict blokkolja a safe-delete-et (`cached?: T` Map.get → `T | undefined`; downstream `session: string`, `sessionExists: boolean` paraméterekhez nem assignolható). Az előző `eb9b951` attempt (warn+continue workaround) visszaállítva lett `2ec1c99`-ben, mert új uncovered `if` branch-et hozott létre. Kihagyva.

### Teszt impact

`src/__tests__/message-router-full.test.ts` — 75/75 pass jelenleg. Két tesztet kell törölni:

- **Sorok 925-964**: `'does not notify the orchestrator when the failed message was already to the main agent'` — pinning test a sor 81 guard-hoz. A teszt ma is dokumentálja a guard-ot dead code-ként ("defensive dead code reachable only via a future code path"). A guard törlése után a teszt comment elavult, a teszt felesleges.
- A sor 1097-es teszt (`'runs reconnect-batch on first reconnect when threshold + age both met'`) NEM pin-eli a sor 317 dead branch-et (csak a batch path reachable részét járja be). Maradhat változatlanul.
- A sor 848-as teszt (`'uses an existing trace_id/span_id when the message already has one'`) a sor 565-567-es ternary alternatív ágát járja be, nem a sor 180-at. Maradhat változatlanul.

### Commit-ok

4. **`fix(message-router): drop 2 dead defensive guards (lines 81, 317)`**
   - Sor 81 törlése + fölötte a komment (sor 79-80)
   - Sor 317 törlése, cseréje kommentre
   - Verify: `bunx tsc --noEmit` delta 0; `bunx vitest run src/__tests__/message-router-full.test.ts` — 74/74 PASS (a sor 925-964 teszt még PASS, mert a szintaxis nem tört el)

5. **`test(message-router): remove notify-main-agent pinning test (lines 925-964)`**
   - A `'does not notify the orchestrator when the failed message was already to the main agent'` teszt törlése
   - Verify: `bunx vitest run src/__tests__/message-router-full.test.ts` — 73/73 PASS

6. **`docs(needs-to-be-fix): mark message-router-unreachable-defensive-branches + message-router-dead-defensive-branches partially resolved (lines 81, 317 deleted; lines 478-480 and 180 deferred)`**
   - `docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md` — Resolved sor: "Partially resolved: 2026-MM-DD <sha> (lines 81, 317 deleted; lines 478-480 remain open due to TS strict blocking)"
   - `docs/needs-to-be-fix/message-router-dead-defensive-branches.md` — Resolved sor: "Partially resolved: 2026-MM-DD <sha> (lines 81, 317 deleted; line 180 deferred as stylistic inversion, not dead code)"
   - `docs/needs-to-be-fix/INDEX.md` — két sor frissítése, "Partially resolved" jelzéssel

## Workflow struktúra

A user kérésére workflow-t használunk. A workflow indítása a `test/baseline` branch-ből (HEAD `a4c5aba`), oda is tér vissza.

```
Phase 1 — Pre-conditions verify (1 agent)
  - git status (clean?)
  - tsc baseline szám rögzítése
  - context-guard-runner.test.ts + message-router-full.test.ts aktuális pass szám
  - decideGuard minden restart/request-handoff return-jének újra-ellenőrzése (megerősítés)
  - Coverage baseline: context-guard-runner.ts + message-router.ts aktuális branch coverage

Phase 2 — Cluster A fix commit (1 agent)
  - src/web/context-guard-runner.ts: 4 branch törlése !  assertion-ökkel + tripwire comment-ek
  - Verify: tsc delta 0; context-guard-runner.test.ts 51/51 PASS
  - Commit: "fix(context-guard-runner): drop 4 dead defensive guards (lines 263, 274, 275, 290)"

Phase 3 — Cluster A test deletion commit (1 agent)
  - src/__tests__/context-guard-runner.test.ts: describe blokk (sor 1297-1374) törlése
  - Verify: context-guard-runner.test.ts 49/49 PASS
  - Commit: "test(context-guard-runner): remove dead-code-branches pinning describe block (lines 1297-1374)"

Phase 4 — Cluster A docs commit (1 agent)
  - context-guard-runner-dead-code-branches.md: Resolved sor
  - INDEX.md: sor frissítése
  - Commit: "docs(needs-to-be-fix): mark context-guard-runner-dead-code-branches resolved"

Phase 5 — Cluster B fix commit (1 agent)
  - src/web/message-router.ts: sor 81 + komment (79-80) + sor 317 törlése, komment csere
  - Verify: tsc delta 0; message-router-full.test.ts 74/74 PASS
  - Commit: "fix(message-router): drop 2 dead defensive guards (lines 81, 317)"

Phase 6 — Cluster B test deletion commit (1 agent)
  - src/__tests__/message-router-full.test.ts: sor 925-964 teszt törlése
  - Verify: message-router-full.test.ts 73/73 PASS
  - Commit: "test(message-router): remove notify-main-agent pinning test (lines 925-964)"

Phase 7 — Cluster B docs commit (1 agent)
  - message-router-unreachable-defensive-branches.md + message-router-dead-defensive-branches.md: "Partially resolved" sorok
  - INDEX.md: két sor frissítése
  - Commit: "docs(needs-to-be-fix): mark message-router-unreachable-defensive-branches + message-router-dead-defensive-branches partially resolved"

Phase 8 — Final verification (1 agent)
  - bunx tsc --noEmit: a baseline-hoz képest delta 0 (mindkét cluster)
  - bunx vitest run --coverage src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts: mindkettő 100% branch coverage (vagy javul)
  - bunx vitest run: teljes suite, baseline-hoz képest -2 teszt (49+73-49-75 = -2)
  - INDEX.md konzisztencia: az új "Resolved" / "Partially resolved" SHA-k érvényesek
  - Commit history check: 6 új commit a stack tetején, sorrendje a fentivel konzisztens

Phase 9 — User-invoked /code-review xhigh --fix
  - A user saját kezűleg hívja (cycle 33/34 minta); a workflow NEM hívja automatikusan
```

## Lehetséges bukások és megelőzésük

| Bukás | Valószínűség | Megelőzés |
|---|---|---|
| TS strict error a `pane!` / `pctRound!` / `snapshotPath!` miatt | alacsony | Phase 1 agent méri a baseline tsc-t; Phase 2 agent futtat `tsc --noEmit` a commit előtt; ha delta > 0, a workflow megáll és a usernek jelzi |
| decideGuard contract változás (jövőbeli refactor) miatt a `!` assertion elromlik | nagyon alacsony | Tripwire comment-ek minden `!` után: `(decideGuard guarantees non-null in this case — see context-guard.ts:322-334)`; a futó tesztek (49 context-guard-runner + 73 message-router) azonnal jelzik a contract drift-et |
| Pinning teszt(ek) törlése után más teszt elromlik | alacsony | Minden test deletion commit előtt a Phase 3/6 agent futtatja a teljes suite-ot; ha bármely más teszt elromlik, a workflow megáll |
| context-guard-runner.ts és message-router.ts cross-impact | nincs | A két fájl független modul, nincs közös típus/import; a Phase 8 final verify megerősíti |
| Coverage csökkenés a dead branch törlés után | nagyon alacsona | A Phase 1 agent méri a coverage baseline-t; Phase 8 megerősíti, hogy nem csökkent (csak javulhat) |
| A `message-router-unreachable-defensive-branches.md` "Partially resolved" jelölés nem illeszkedik az INDEX formátumba | közepes | A Phase 7 agent megnézi a cycle 34 partially-resolved precedent-et (env-update-duplicate-key-lost, stb.); ha nincs, új formátumot vezet be az INDEX-ben, és a user figyelmeztet |
| A user pusholás előtt elolvassa a commit-okat és változtatni akar | nincs | A 6 commit sorrendje logikus (fix→test→docs klaszterenként), könnyen review-zható |
| A `decideGuard` valamelyik return path-ját Phase 1 agent rosszul ellenőrzi | nagyon alacsona | Phase 1 agent explicit kilistázza minden return path input-követelményét és megmutatja, hogy a runner-beli változó (pane/pctRound) garantáltan nem-null |

## Kritikus fájlok

- `src/web/context-guard-runner.ts` (Phase 2)
- `src/__tests__/context-guard-runner.test.ts` (Phase 3)
- `src/web/message-router.ts` (Phase 5)
- `src/__tests__/message-router-full.test.ts` (Phase 6)
- `docs/needs-to-be-fix/context-guard-runner-dead-code-branches.md` (Phase 4)
- `docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md` (Phase 7)
- `docs/needs-to-be-fix/message-router-dead-defensive-branches.md` (Phase 7)
- `docs/needs-to-be-fix/INDEX.md` (Phase 4 és 7)
- `src/context-guard.ts` (csak olvassa Phase 1 — referenciaként)

## Végső verifikáció (Phase 8)

1. `bunx tsc --noEmit` — baseline-hoz képest delta 0 (mindkét klaszter együtt)
2. `bunx vitest run` — teljes suite, baseline-hoz képest -2 teszt (49+73 = 122, szemben 51+75 = 126)
3. `bunx vitest run --coverage src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts` — mindkét célfájl branch coverage 100% (vagy javult)
4. `git log --oneline -10` — 6 új commit a stack tetején, sorrendje a fentivel konzisztens
5. `git status` — clean
6. `git diff origin/test/baseline --stat` — 6 commit + 6 módosított fájl (src/web/context-guard-runner.ts, src/__tests__/context-guard-runner.test.ts, src/web/message-router.ts, src/__tests__/message-router-full.test.ts, 3 MD)

A Phase 8 után a user `git push` (manuálisan) és `/code-review xhigh --fix 520bd5e..HEAD` (manuálisan) hív.

## Tényleges végrehajtás (2026-08-19)

A terv és a végrehajtás között a következő eltérések adódtak:

1. **HEAD a terv írásakor vs. indításkor** — a terv `a4c5aba` (cycle 34 close) HEAD-del számolt, de indításkor a HEAD `2ca6901` volt (4 commit ahead: cycle 35 work in progress). Ez nem változtatott a cycle 35 scope-ján, csak a baseline számokon (TSC: 2253 nem 1699; message-router-full tesztek: 73 nem 75).

2. **Cluster A (context-guard-runner) redo** — az eredeti 3-commit (fix → test → docs) sorrend nem működött, mert a 2 pinning teszt a runtime viselkedést teszteli (a `?? 0` és `if (finalPane)` eredményét), nem csak a szintaxist. A Phase 2 agent helyesen leállt a hiba felismerésekor. A redo egy **combined fix+test commit** + **docs commit** lett (2 commit, nem 3). A tesztek törlése ÉS a forrás módosítás atomi commitben van.

3. **Line 290 follow-up** — a Phase 7 végső verifikáció kimutatta, hogy a context-guard-runner.ts branch coverage 99.01% (nem 100%). A uncovered branch a line 290 `(snapshotPath ? '...' : '')` ternary ELSE ága. Re-analízis kimutatta, hogy ez is dead code: a `snapshotPath` változót a line 277-ben a `try` blokkban a `join()` értékre állítjuk, és CSAK ha a `join()` dobna (pure függvény, nem dob) maradna null — a `writeFileSync` throw esetén a `snapshotPath` már be van állítva a catch előtt, a catch nem reseteli. A tervben "keep as-is" volt, de ez hiba volt. Egy további follow-up commit (`4de8285`) eltávolítja a ternary-t és `snapshotPath!` non-null assertion-t használ tripwire comment-tel. Ezzel a coverage visszaáll 100%-ra.

### Végleges commit stack (6 commit, 2ca6901 fölött)

```
4de8285  fix(context-guard-runner): drop unreachable snapshotPath ternary else arm (line 290)
6b7340c  docs(needs-to-be-fix): mark context-guard-runner-dead-code-branches resolved
40980b4  fix+test(context-guard-runner): drop 4 dead defensive guards + remove pinning tests
0cf1fdb  docs(needs-to-be-fix): mark message-router-unreachable-defensive-branches + message-router-dead-defensive-branches partially resolved
9d01097  test(message-router): remove notify-main-agent pinning test (lines 925-964)
ba6faf8  fix(message-router): drop 2 dead defensive guards (lines 81, 317)
```

### Végső metrikák

| Metrika | Érték | Megjegyzés |
|---|---|---|
| TSC delta | 0 | baseline 2253 → 2253 |
| Teljes suite | 382/382 fájl, 11126/11126 teszt PASS | baseline 11129 → 11126 (-3 törölt pinning teszt) |
| context-guard-runner.ts branch coverage | 100% | visszaállítva a line 290 follow-uppal |
| message-router.ts branch coverage | 97.82% | cache fallback (lines 476-478) TS-strict blocked, tervezetten kimaradt |
| Lokálisan push-olatlan | igen | user pushol manuálisan |

### Következő lépések a usernek

1. Commit review (`git log --oneline 2ca6901..HEAD`, `git diff 2ca6901..HEAD`)
2. `git push` (manuálisan, push tilos az agent számára)
3. `/code-review xhigh --fix 2ca6901..HEAD` (manuálisan, a skill user-invoked)
4. Push verification (local/remote byte-identical check, Pattern 89)
