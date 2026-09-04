# Következő legkisebb needs-to-be-fix elem — átbeszélés

## Context

A `test/baseline` branch jelenlegi állapota (e831e8f): working tree clean, legutóbbi commit a `schedule-runner-mcpmissingreason-cache-miss-unreachable` MD újramegnyitása (a korábbi `0c4c780` safe-delete revertálódott `fe81ac0`-cal, mert a `?? []` guard mégiscsak kell).

**Tanulság (Pattern 96)**: a workflow agent-ek az "unreachable defensive branch" safe-delete utasítást kiterjesztésként értelmezték, és a `?? []` / `?? null` / `?? 0` default-okat „biztonságosabbra" cserélték. A `fe81ac0` visszaállítás igazolta, hogy ezek a defensive guard-ok egy része valójában kell, csak a teszt harness-ből nem érhető el. **A következő ciklusnak ezért tudatosan kell kerülnie a „?? [] törlése" típusú safe-delete-eket**, hacsak a pinning-teszt nem támasztja alá egyértelműen.

A felhasználó kérése: a **legkisebb módosítás** és **legkisebb bukási kockázat** rangsorolása, megbeszélés first, majd workflow + `/code-review xhigh --fix`.

## Rövidített jelöltlista (5 db)

Az MD-k átolvasása és a `git log` review alapján a következő 5 jelölt a legkisebb scope-ú, legalacsonyabb kockázatú, és pinning teszttel / javaslattal rendelkezik. Mindegyik egyszerű, jól körülhatárolt, és a `routes-ideas-body-parse-500` aug. 17-i minta analógiájára kész fix-kommit formátumba illeszkedik.

| # | Bug ID | Fájl | Természet | Scope | Rizikó |
|---|---|---|---|---|---|
| **A** | `routes-fleet-q-body-parse-uncaught` | `src/web/routes/fleet-q.ts:29-31` | `readBody` + `JSON.parse` nincs try/catch-ben → 500/uncaught rejection | ~5 sor try/catch + 3 teszt-invert | Nagyon alacsony — tükör-pattern a `tryHandleFleet`-ből (`fleet.ts`) |
| **B** | `routes-fleet-q-404-leaks-roster` | `src/web/routes/fleet-q.ts:28` | 404 hibaüzenet felfedi, hogy az agent nem létezik (vs. 401/403) | 1 sor + teszt-invert | Alacsony — user-facing string change, magyar→angol vagy generic `'Not found'` |
| **C** | `agent-worker-array-claude-json` | `src/web/agent-worker.ts:406-423` | Ha a host `.claude.json` `[]`, a worker trust flag-eket silently droppolja | ~3 sor type-guard a `parsed` előtt | Alacsony — typeguard hozzáadása, nem kód-csere |
| **D** | `voice-directive-json-quote-escape` | `src/web/voice-directive.ts:54` | `escapedStateDir` csak `'` escapi, `"`/`\` átmegy → invalid JSON a jq filterben | ~3 sor `JSON.stringify`-ra refaktor | Közepes — a `$t` placeholder swap-et érinteni kell |
| **E** | `web-inbound-probe-cache-sticky` | `src/web/inbound-probe.ts:211-217` | `ALLOWED_CHAT_ID` cache sosem invalidálódik → a „reset" branch halott | 1 sor törlés + 1 sor komment + docs | Alacsony — csak halott branch + szándék-dokumentálás |

## Legkisebb / legbiztonságosabb sorrend (javaslat)

1. **A — `routes-fleet-q-body-parse-uncaught`** — legkisebb, legjobban dokumentált, tükör-pattern áll rendelkezésre. Ez a Cycle 24 `routes-ideas-body-parse-500` mintát követi.
2. **B — `routes-fleet-q-404-leaks-roster`** — ugyanannak a fájlnak egy másik bugja; ha A-t választjuk, B-t akár egy menetben lehetne kezelni (azonos review-ablak).
3. **C — `agent-worker-array-claude-json`** — typeguard, nincs kód-csere.
4. **E — `web-inbound-probe-cache-sticky`** — csak dokumentáció + halott branch törlés (Option 3 a MD-ből).
5. **D — `voice-directive-json-quote-escape`** — tartalmazza a `$t` placeholder swap-et, ez a legkockázatosabb a refaktor miatt.

## Kizárás indoklással (NE most)

- **`schedule-runner-mcpmissingreason-cache-miss-unreachable`** — most nyitottuk újra, a `fe81ac0` visszaállítás mutatja, hogy a `?? []` kell. Érinthetetlen, amíg a `?? []` törlési logika nem tisztázott (Pattern 96).
- **Minden "?? [] / ?? null / ?? 0 unreachable defensive branch" MD** — ugyanaz a minta, mint a Cycle 25 workflow safe-delete-je. Nem biztonságos a jelenlegi állapotban.
- **`recall-dayofweek-noon-utc-far-east-skew`** — kicsi, de a timezone-matematika több zónát érint, a regressziós kockázat magasabb. Jó jelölt egy későbbi ciklusra, mikor a recall route-ot külön review-zzuk.
- **High-severity item-ek** (`profiles-traversal-id`, `routes-memories-put-skips-validation`, `multipart-boundary-greedy`, `db-missing-telegram-history-table`) — nem kicsi, külön ciklus érdemel.

## Workflow-terv (jóváhagyás után)

Minden jelölt esetén azonos:

1. **Workflow indítása** a `Workflow` toollal, `scriptPath` opcióval (mint a Cycle 25 workflow `wf_58397ff8-664`).
2. A workflow `phase('Fix')` → safe-edit agent → `phase('Verify')` → típusellenőrzés + targeted vitest.
3. Commit stack: `fix(...)` → `test(...)` invert → `docs(...)` MD mark resolved.
4. **`/code-review xhigh --fix`** skill hívás a végén — Pattern 95 (MD fidelity) és Pattern 96 (safe-delete fidelity) enforcement.
5. **Push tilos** — user pushol, Pattern 89-cel verifikáljuk.

## User döntés (lezárva)

**A + B együtt (fleet-q)** — mindkét `src/web/routes/fleet-q.ts` MD-t egy menetben, egy review-ablakban zárjuk.

### Végrehajtási terv

**Branch:** minden a `test/baseline` (e831e8f) branchen belül marad, nincs új branch vagy worktree.

**Commit stack (várható 5 commit, sorrendben):**

1. `fix(routes-fleet-q): wrap readBody + JSON.parse in try/catch, return 400 on failure (closes routes-fleet-q-body-parse-uncaught)`
   - `src/web/routes/fleet-q.ts` 29-31. sorok átalakítása:
     - `let body: Buffer` + try/catch a `readBody` köré → 400 „Kérés olvasási hiba"
     - `let parsed: { capabilities?: unknown }` + try/catch a `JSON.parse` köré → 400 „Érvénytelen JSON törzs"
     - `null`/array/nem-objektum guard a `parsed.capabilities` előtt → 400 „object body required"
   - Tükör-minta a `tryHandleFleet`-ből (`src/web/routes/fleet.ts`)
2. `test(routes-fleet-q): invert 3 body-failure pinning assertions to expect 400 + structured error`
   - `src/__tests__/fleet-q-routes.test.ts` 3 db „propagates as unhandled rejection" teszt átírása
3. `docs(needs-to-be-fix): mark routes-fleet-q-body-parse-uncaught resolved`
4. `fix(routes-fleet-q): replace 'Agent nem található' with generic 'Not found' to close roster-enumeration leak (closes routes-fleet-q-404-leaks-roster)`
   - 1 sor string-csere a 28. sorban
5. `test(routes-fleet-q): invert 404 message pinning assertion`
   - 1 teszt-assertion frissítés

A két MD-t a felhasználó kérésére egymás után, ugyanabban a workflow-run-ban zárjuk.

### Workflow script vázlat

- `phase('Verify-baseline')` — kiinduló állapot: `tsc --noEmit` count, `routes-fleet-q-routes.test.ts` PASS, working tree clean. Threshold: a `+5` TS-delta toleranciasáv betartása.
- `phase('Fix')` — safe-edit agent, 1 db fájl `src/web/routes/fleet-q.ts`, max ~7 sor diff. Explicit SAFE-EDIT invariáns: `insertions ≤ 15`, `deletions ≥ 5`, NEM nyúl máshoz, NEM refaktorál.
- `phase('Test-invert')` — agent a `src/__tests__/fleet-q-routes.test.ts` 3+1 pinning assertion invertálására.
- `phase('Docs')` — agent a két MD `Resolved:` sor frissítésére (commit hash a `fix` commitokból).
- `phase('Verify-final')` — `routes-fleet-q-routes.test.ts` PASS, teljes `bun --bun vitest run` PASS, `tsc --noEmit` Δ ≤ +5 a baseline-hoz, `git diff --shortstat` a scope ellenőrzésére, `working tree clean` a commitok után.

### Végén kötelező

- **`/code-review xhigh --fix`** skill hívás — Pattern 95 (MD fidelity) és Pattern 96 (safe-edit fidelity) enforcement.
- **Push tilos** — a user nyomja meg, Pattern 89-cel verifikáljuk a CI-t.

### Kockázatok és mitigáció

| Kockázat | Valószínűség | Mitigáció |
|---|---|---|
| A try/catch a `parsed.capabilities` elérési sorrendje máshol is kell | Alacsony | Csak a PUT handler 3 sorát módosítjuk, egyéb handler-ek érintetlenek |
| A `'Not found'` string breaking change a fleet-q kliensnek | Közepes | A pinning teszt explicit lockolja a jelenlegi stringet — a fix commit előtt szándékos invert |
| TS strict delta túllépi a +5-öt | Alacsony | A `let body: Buffer` + `let parsed: {…}` típusok már a meglévő típusok, nincs új TS-hiba |
| Workflow agent túl sokat módosít (Pattern 96) | Közepes | `git diff --shortstat` invariáns a fix agent-en, STOP direktíva ha túllépi |
