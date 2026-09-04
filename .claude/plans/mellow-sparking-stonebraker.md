# Cycle 24 — Legkisebb needs-to-be-fix elem kiválasztása és terve

## Context (miért most)

A `test/baseline` branch-on az utolsó lezárt ciklus a Cycle 23 volt
(`schedules-expand-prompt-missing-answers`, SHA `d99f171` + docs `1278ebc` +
review `0defacb`). A user kéri a **következő legkisebb, legkisebb lehetséges
bukással járó** `needs-to-be-fix` elem azonosítását és a terv megbeszélését,
mielőtt bármilyen kódmódosítás történik.

A mai felfedezés: a `routes-voice-runproc-stdin-dead.md` (amit az Explore agent
javasolt) **már le van zárva** a `c2b4ea2` commitban (2026-08-14, "drop 21
unreachable defensive branches and 6 synthetic tests"), az INDEX.md 227. sora
az iker MD-t (`voice-timer-stdinData-fallbacks`) Resolved-ként is jelöli. Tehát
az eredeti jelölt nem aktuális — valódi Cycle 24 jelöltet kellett keresni.

A jelenlegi `docs/needs-to-be-fix/INDEX.md` (176 MD) alapján a **valóban
legkisebb, nem-vitatott, nem user-overrides** jelöltek listája (méret + kockázat
szerint rangsorolva):

## Top jelöltek

### A) `routes-update-checker-dead-catch-handlers` — legkisebb, pure cleanup
- **MD:** `docs/needs-to-be-fix/routes-update-checker-dead-catch-handlers.md`
- **Érintett forrás:** `src/web/update-checker.ts:255,256`
- **Módosítás:** a `refreshUpdateStatus().catch(() => {})` belső arrow-ok
  törlése (MD szerinti "Option B", "one-line change")
- **Méret:** 1-2 sor (2 arrow-function törlés)
- **Override:** nincs
- **Pin test:** nincs (csak a coverage gate érintett)
- **Kockázat:** **Nagyon alacsony** — zéró runtime viselkedésváltozás, csak
  kód-zaj csökkentés
- **Mellékhatás:** function coverage 88.23% → 88.23% marad (a 2 dead arrow
  fennmarad számolva, csak a hívásaik nem lesznek dead-ként jelölve — DE az
  MD opció A/B/C-jében B a "trust refreshUpdateStatus to always resolve"
  utat választja)
- **Bukás:** ha a belső catch nélkül refreshUpdateStatus bármikor rejectelne,
  az unhandled promise warning keletkezhet — de a MD garantálja, hogy
  "every error path is converted into a `status.error` string and the
  function always resolves with a `UpdateStatus`"

### B) `routes-background-tasks-session-ended-status` — valódi status-konzisztencia bug
- **MD:** `docs/needs-to-be-fix/routes-background-tasks-session-ended-status.md`
- **Érintett forrás:** `src/web/routes/background-tasks.ts:95-101` (poller) +
  `:129-132` (sweeper)
- **Módosítás:** a poller ne hardcode-olja a `'(session ended)'` stringet,
  hanem hívja meg a `captureSession(tmux_session)` függvényt, és a status
  `'done'` → `'failed'` legyen, ha a marker nem jelent meg
- **Méret:** ~5-10 sor kód + 2 pinning test átírás/átfogalmazás a
  `background-tasks-routes.test.ts`-ben
- **Override:** nincs
- **Pin test:** van (kettő is), mindkettő az aktuális (hibás) viselkedést
  rögzíti → ezeket át kell írni
- **Kockázat:** **Közepes** — ez egy viselkedésváltozás, ami hatással van a
  UI-ra (zöld done → piros failed, ha a session eltűnt). Éles felhasználóknál
  a "task completed normally" és "task died" eddig nem volt megkülönböztethető,
  most megkülönböztethető lesz — ez a JAVÍTÁS célja, de a UI régebbi
  feltételezéseket tehet
- **Bukás:** ha captureSession lassú, lassabb polling tickek; ha a capture
  üres, a `(orphaned on restart)` fallback-et kell használni (a sweeper
  mintájára)

### C) `web-inbound-probe-cache-sticky` — design döntést igénylő cache-fix
- **MD:** `docs/needs-to-be-fix/web-inbound-probe-cache-sticky.md`
- **Érintett forrás:** `src/web/inbound-probe.ts:211-217, 246`
- **Módosítás:** 3 lehetséges irány a MD alapján:
  - **(1)** `_cachedAllowedChatId` törlése minden tick előtt
    (elvetve a performance megfontolás miatt)
  - **(2)** `.env` mtime figyelés, cache invalidálás ha változik (~5-10 sor)
  - **(3)** dead "reset" branch törlése (line 246) + doc string frissítés,
    hogy "operator must restart dashboard after editing `.env`"
- **Méret:** 1-3 sor (Option 3), 5-10 sor (Option 2)
- **Override:** nincs
- **Pin test:** VAN (`src/__tests__/inbound-probe-full.test.ts:941` —
  `'uses cached ALLOWED_CHAT_ID across ticks (the W4 contract)'` — ez
  kifejezetten a jelenlegi (hibás) cache-elhetőséget dokumentálja)
- **Kockázat:** **Közepes** — a pin test átírásával együtt jár. Ha Option 2
  mellett döntünk, akkor egy újabb fs.stat-per-tick jön be (a `.env` mtime
  olvasása), ami ellenzi az eredeti "W4: read once at startup" szellemét.
  Ha Option 3 mellett döntünk, akkor az operátor UX szenved (mindig restart
  kell az `.env` szerkesztés után)

## Ajánlás

**Cycle 24 = A jelölt (`routes-update-checker-dead-catch-handlers`)** — ez a
legkisebb (1-2 sor) és a legkisebb lehetséges bukással járó (zéró runtime
változás, nincs pin test átírás, nincs design döntés).

Bár a Cycle 21/22/23 mind "valódi" funkcionális bugot fixált, a user explicit
kérte a "legkisebb módosítás, legkisebb lehetséges bukás" kritériumot.
A legkisebb, alacsony kockázatú, scope-korlátos módosítás az Option B (1-2 sor
törlés `src/web/update-checker.ts:255,256`).

Ha a user preferálja a valódi funkcionális bugot, B a soron következő
ajánlott (kisebb, mint C), és a design döntést nem igényli (a MD egyértelmű
javaslatot ad: "Make the poller mirror the sweeper").

## Végrehajtási terv (Cycle 24 implementáció, ha "A" mellett döntünk)

### Branch és indítás
- Branch: `test/baseline` (HEAD: `1140b3e`)
- Workflow: 3 fázis (Implement → Verify → Docs)
- Visszavezetés: `test/baseline`-re

### Implementáció (fázis 1)
1. **Beavatkozás:** `src/web/update-checker.ts:255,256`
   - Eltávolítani a `.catch(() => {})` belső arrow-okat:
     - Line 255: `setTimeout(() => { refreshUpdateStatus().catch(() => {}) }, 10_000)`
       → `setTimeout(() => { refreshUpdateStatus() }, 10_000)`
     - Line 256: `setInterval(() => { refreshUpdateStatus().catch(() => {}) }, 15 * 60_000)`
       → `setInterval(() => { refreshUpdateStatus() }, 15 * 60_000)`
2. **Indoklás komment:** nem kell (a kód önmagában érthető)
3. **Pin test:** NEM kell (a MD jelzi, hogy a tesztek 100%-os statement/
   branch/line coverage-t adnak, és a 88.23% function coverage elfogadható
   trade-off — a 2 dead arrow a kód eltávolítása után már nem "dead", mert
   a külső setTimeout/setInterval callback-ek továbbra is rajtuk futnak)

### Verifikáció (fázis 2)
1. `bun --bun vitest run` → várhatóan 11114/11114 PASS (baseline)
2. `bunx tsc --noEmit | wc -l` → 2255 (baseline)
3. `git diff --stat src/web/update-checker.ts` → -2/+0 sor
4. Coverage: a `src/web/update-checker.ts` function coverage 88.23%
   marad (a 2 dead arrow felszámolódik, de a korábbi "dead" function-ök
   a külső setTimeout/setInterval callback-ek belsejében vannak, és azok
   továbbra is coverelve lesznek → a function coverage javulhat vagy
   marad, attól függően, hogy v8 hogyan kezeli a nested arrow-okat
   a removal után)

### Docs (fázis 3)
1. `docs/needs-to-be-fix/routes-update-checker-dead-catch-handlers.md`
   - státusz frissítés: a fix alkalmazva, MD már csak emlékeztető
2. `docs/needs-to-be-fix/INDEX.md` line 172 — Resolved: <date> <sha>

### Végső commit stack (várható)
```
SHA  Type  Subject
---- ----  -------
XX   fix   update-checker: drop dead .catch() handlers
YY   docs  needs-to-be-fix: mark update-checker-dead-catch-handlers resolved
ZZ   fix   code-review xhigh --fix (post-review javítások, ha vannak)
```

### Code review (kötelező végén)
- `/code-review xhigh --fix` skill hívása
- Coverage/csökkenés-ellenőrzés, pin test frissítés-ellenőrzés

## User döntés (végleges)

A user az **A** jelöltet választotta: `routes-update-checker-dead-catch-handlers`.

Indoklás (user visszaigazolva): "legkisebb módosítás, legkisebb lehetséges bukás"
kritériumot az 1-2 soros, zéró runtime változású, pure cleanup opció teljesíti
a legjobban. A funkcionális bugok (B, C) a következő ciklusokra maradnak.

## Végrehajtás részletei (minden jelölt esetén)

- **Workflow típus:** 3 fázis (Implement → Verify → Docs)
- **Induló branch:** `test/baseline` (HEAD: `1140b3e`)
- **Visszavezetés:** `test/baseline`
- **Push:** TILOS (`CLAUDE.md` szabály) — user fogja pusholni
- **Kötelező utolsó lépés:** `/code-review xhigh --fix`

## Megjegyzés: kihagyott jelöltek (miért)

| MD | Kihagyás oka |
|---|---|
| `memory-digest-empty-trim` | `NEVER modify src/memory.ts` user override |
| `store-watcher-sensitive-names-unreachable` | `NEVER modify src/store-watcher.ts` user override |
| `routes-fleet-q-404-leaks-roster` | `NEVER modify src/web/routes/fleet-q.ts` user override |
| `routes-fleet-q-body-parse-uncaught` | `NEVER modify src/web/routes/fleet-q.ts` user override |
| `recall-dayofweek-noon-utc-far-east-skew` | túl nagy (~8 sor + TZ-sweep pin test), "legkisebb" kritériumot nem teljesíti |
| `web-inbound-probe-cache-sticky` (Option 2) | 5-10 sor, design döntés, nem "legkisebb" |
| `routes-background-tasks-sweep-timeout-reset` | nem olvastam be, valószínűleg B-nél nagyobb → ha a user B-t választja, ezt később meg lehet nézni |
