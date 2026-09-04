# Cycle 24 — `agent-conversation-malformed-name-uri` fix

## Context

A `docs/needs-to-be-fix/agent-conversation-malformed-name-uri.md` egy ismert bugot dokumentál: a `GET /api/agents/%E0%A4%A/conversation` (vagy bármilyen hibás percent-encoding) a `decodeURIComponent` hívásban a route-match után azonnal `URIError`-t dob — a route handler még nem lépett be a transcript-`try/catch` blokkba, így az outer web-server hibakezelő egy rossz kliens inputból generic 500-at formál 400 helyett.

A 4 auditált legkisebb needs-to-be-fix jelölt közül (`agent-conversation-malformed-name-uri`, `voice-directive-json-quote-escape`, `recall-dayofweek-noon-utc-far-east-skew`, `routes-fleet-q-404-leaks-roster`) ez az egyetlen, amely:
- Valódi forrás-diffet kínál (a másik kettő `NEVER modify` szabály alatt áll),
- Legkisebb kockázatú (csak 500→400 boundary-váltás, nincs API-output regresszió),
- A `recall-...` opcióhoz képest 3× kisebb (~5 sor vs. ~10-15) és nincs időzóna-matek edge case.

A user az A opciót választotta. Az outcome: a rossz percent-encoding 400-as státuszt kap explicit magyar hibaüzenettel, és a pinning teszt ezt a contractet védi a jövőben.

## Végrehajtási terv

### Branch és kiindulási pont

- Branch: `test/baseline` (clean, up-to-date)
- Drift ellenőrzés a workflow indulásakor: `git rev-list --left-right --count origin/test/baseline...test/baseline` → `0	0`
- Ha drift ≠ 0, a workflow SIGTERM-et kap és hibát jelez (NEVER push, NEVER pull — csak lokál commitok)

### Kritikus fájlok

| Fájl | Szerep |
|---|---|
| `src/web/routes/agent-conversation.ts` | A fix helye (sor 143, `decodeURIComponent(match[1])`) |
| `src/__tests__/routes-agent-conversation.test.ts` | A pinning teszt inverzió helye (sor 139-142, `pins the malformed encoded agent-name failure`) |
| `docs/needs-to-be-fix/INDEX.md` | A `Resolved: 2026-08-17 <fix SHA>` sor frissítése |
| `docs/needs-to-be-fix/agent-conversation-malformed-name-uri.md` | A MD lezárása (`Status: Resolved`-re váltás) |

### Meglévő eszközök újrahasznosítása

- `json(res, body, status)` helper — meglévő export a `src/web/...`-ban (a testvér route-ok, pl. `schedules.ts` és `agent-taskstate.ts` is használják)
- A `return true` konvenció: a route handler-ek "handled" jelet adnak vissza, így az outer dispatcher nem próbálkozik tovább — ezt a `routes-agent-taskstate.test.ts` és `routes-schedules.test.ts` minták is követik
- A magyar nyelvű hibaüzenet string konvenció: `recall.ts` (`'Érvénytelen dátum'`) és `skills.ts` hasonló formátumban — a `'Érvénytelen agent-név (percent-encoding hiba)'` illeszkedik a házon belüli stílusba

### Lépések (commit sorrend)

1. **`fix(routes-agent-conversation): catch URIError at agent-name decode, return 400`**
   - Fájl: `src/web/routes/agent-conversation.ts`
   - Sor: 143 (`const name = decodeURIComponent(match[1])`)
   - Változtatás: a `decodeURIComponent` hívást egy `try { ... } catch { json(res, { error: 'Érvénytelen agent-név (percent-encoding hiba)' }, 400); return true }` blokkba csomagoljuk
   - A belső transcript-`try/catch` (sor 155-172) érintetlen marad — a transcript I/O failure-ok továbbra is 500-at adnak
   - A `let name: string` deklaráció a try elé kerül, hogy a catch ág is lássa a `name` shadowing-ot

2. **`test(routes-agent-conversation): invert malformed-name pinning assertion to expect 400`**
   - Fájl: `src/__tests__/routes-agent-conversation.test.ts`
   - Sor: 139-142 (`it('pins the malformed encoded agent-name failure', ...)`)
   - Változtatás: a `rejects.toThrow(URIError)` + `H.json.not.toHaveBeenCalled()` assertion-öket lecseréljük:
     ```ts
     const result = await call('GET', '/api/agents/%E0%A4%A/conversation')
     expect(result.handled).toBe(true)
     expect(result.status).toBe(400)
     expect(result.body).toEqual({ error: 'Érvénytelen agent-név (percent-encoding hiba)' })
     ```
   - A `call` helper formátumát a többi `it()` blokkból kell átvenni (a suite-ban már van `call` helper)

3. **`docs(needs-to-be-fix): mark agent-conversation-malformed-name-uri resolved`**
   - Az `INDEX.md` táblázatában a `Resolved: —` → `Resolved: 2026-08-17 <fix SHA>` (a 2. commit fix SHA-ja)
   - A `agent-conversation-malformed-name-uri.md` fájl státusz-sorában `Status: Open` → `Status: Resolved`

4. **`/code-review xhigh --fix` skill** (a user kérésére kötelező)
   - A skill a 3 commit UTÁN fut le
   - A várható scope: a `try/catch` elhelyezés, a `let name: string` shadowing, a magyar hibaüzenet szövege, a teszt-assertion lefedettség
   - A skill `ReportFindings`-szal tér vissza; ha van alkalmazható finding, a skill maga alkalmazza és commitolja
   - Ha a skill üres tömböt ad vissza (CONFIRMED), nincs teendő
   - Ha a skill PLAUSIBLE findingot jelez, a parent agent megbeszéli a userrel a fix alkalmazása előtt (NEVER auto-apply from review — CLAUDE.md szabály)

### Becsült méret

- Forrás: **+8/-1** sor a `agent-conversation.ts`-ben (egy try/catch wrapper + `let name: string` deklaráció)
- Teszt: **+3/-3** sor a `routes-agent-conversation.test.ts`-ben (egy `it()` blokk assertion cseréje)
- Docs: **2** sor az `INDEX.md`-ben + 1 sor státusz-sor a MD-ben

### Lehetséges bukás / kockázat

| Kockázat | Valószínűség | Hatás | Mitráció |
|---|---|---|---|
| Más route-ok is `decodeURIComponent`-ot használnak, hasonló buggal | alacsony | hatókörön kívül | A scope fix, NEM módosítunk más fájlt. Külön MD nyitható, ha találunk |
| A belső transcript-`try/catch` elnyeli a `name`-hez tartozó decode hibát | alacsony | fix nem lép érvénybe | A wrapper a `decodeURIComponent` köré kerül, a belső try/catch ELŐTT — így mindig előbb fut |
| A teszt helper `call` formátuma nem `result.handled`-et ad vissza | alacsony | teszt nem fut le | A workflow verifikációs fázisában futtatjuk a tesztet; ha `call` más API-t ad, a teszt 1-2 sorban adaptálható |
| A `json` import hiányzik az aktuális fájlban | alacsony | build törés | Az MD-szintű review + `bun --bun vitest run` verifikáció ezt azonnal kimutatja |
| A code-review skill egy scope-on túli refaktort javasol (pl. readBody maxBytes) | közepes | extra commit | A parent agent megbeszéli a userrel, mielőtt alkalmazza — NEM auto-apply |

### Verzáció (commit sorrend)

```
<fix SHA>    fix(routes-agent-conversation): catch URIError at agent-name decode, return 400
<test SHA>   test(routes-agent-conversation): invert malformed-name pinning assertion to expect 400
<docs SHA>   docs(needs-to-be-fix): mark agent-conversation-malformed-name-uri resolved
<review SHA> (opcionális) code-review xhigh follow-up fix
```

## Végrehajtás (workflow script)

A user kérése: workflow-val, lokálisan, push nélkül, végén `/code-review xhigh --fix` skill.

A workflow-t a Phase 5 (ExitPlanMode) UTÁN, külön `Workflow` tool hívással indítjuk (a plan mode tiltja a workflow-t a tervkészítés alatt).

A workflow script vázlata (a tényleges scriptet a `Workflow` tool hívásakor küldjük, fájlba nem írjuk):

```
phase('Setup')
- git status + drift check
- Branch megerősítése (test/baseline)

phase('Fix')
- edit src/web/routes/agent-conversation.ts (try/catch wrapper, ~8/-1)
- commit: fix(routes-agent-conversation): catch URIError at agent-name decode, return 400
- edit src/__tests__/routes-agent-conversation.test.ts (assertion invert, ~3/-3)
- commit: test(routes-agent-conversation): invert malformed-name pinning assertion to expect 400
- docs(needs-to-be-fix) frissítés
- commit: docs(needs-to-be-fix): mark agent-conversation-malformed-name-uri resolved

phase('Verify')
- bun --bun vitest run src/__tests__/routes-agent-conversation.test.ts → 79/79 (vagy magasabb) PASS
- bun --bun vitest run → 11114/11114 PASS (baseline, 0 új failure)
- bunx tsc --noEmit | wc -l → 2255 (baseline, 0 új)
- syntax-check → OK
- drift check: 3 ahead, 0 behind

phase('Code review')
- Skill: code-review xhigh --fix
- Ha van alkalmazható finding: parent agent megbeszéli a userrel
- Ha nincs: workflow zárás
```

## Verifikáció (end-to-end)

A workflow verify fázisában futtatandó:

| Metrika | Célérték |
|---|---|
| `bun --bun vitest run src/__tests__/routes-agent-conversation.test.ts` | minden teszt PASS, a módosított `it()` 400-at vár |
| `bun --bun vitest run` (teljes suite) | 11114/11114 PASS (vagy +N új teszttel) |
| `bunx tsc --noEmit \| wc -l` | 2255 (baseline) |
| `node --check` syntax check | OK |
| `git status` | clean |
| `git log --oneline test/baseline` | 3 új commit (vagy 4 review-follow-up-pal) |
| Drift `git rev-list --left-right --count origin/test/baseline...test/baseline` | `3	0` (vagy `4	0`) |

End-to-end manual check (opcionális): `curl -s -o /dev/null -w "%{http_code}" http://localhost:<port>/api/agents/%E0%A4%A/conversation` → 400-at kell adnia (csak ha a run skill elérhető és a szerver fut; egyébként a unit teszt a garancia).

## Nem végzünk (scope-on kívül)

- Más route-ok hasonló `decodeURIComponent` bugjainak keresése/javítása (külön MD nyitandó)
- A `readBody` `maxBytes` védelem a route-ban (pre-existing, scope-on kívül)
- A `let name: string` shadowing refaktor (a TS típusrendszer megköveteli a try/catch + return true pattern miatt)
- Push (a useré a push gomb; CLAUDE.md szigorú tiltás)
- A többi `NEVER modify` alatt álló needs-to-be-fix elem (`voice-directive-json-quote-escape`, `routes-fleet-q-404-leaks-roster`)
