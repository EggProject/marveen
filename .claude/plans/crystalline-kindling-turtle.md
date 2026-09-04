# needs-to-be-fix: 3 legkisebb, legalacsonyabb kockázatú elem (1 munkamenet)

## Context

A `docs/needs-to-be-fix/` 176 bejegyzést tartalmaz. A jelenlegi branch (`test/baseline`) HEAD=`a4c5aba`, working tree clean, utolsó commit a `channel-invites` orphan cleanup volt. A 2026-08-09 óta tartó lezáró pass az "elérhetetlen védelmi ágak" témakört szinte teljesen kitakarította (`agent-team-trustfrom`, `pane-state-defensive-branches`, `channel-invites-unreachable-defensive-branches` mind lezárva a közelmúltban).

A fennmaradó elemek között van **3 darab**, ami egyszerre:
- **Konkrét, izolált**, egyetlen forrásfájlra korlátozódó változtatás
- **Nincs függősége** a többi nyitott elemtől (párhuzamosan nem fognak összeakadni)
- **A meglévő tesztek mind zöldek maradnak** a fix után
- **Létező, a kódban dokumentált szándékot** valósít meg (a fix "visszavezet" a kód saját kommentje által leírt helyes viselkedéshez)

Ezeket egyetlen munkamenetben, egyetlen commit-láncban lehet lezárni. A workflow `verify` lépése minden lépés után futtatja a `bun run typecheck` + `bun test` parancsot, hogy a regresszió azonnal kiderüljön.

A terv **szigorúan az alábbi 3 elemre szorítkozik**. A többi HIGH/MEDIUM elem (multipart, profiles-traversal, routes-memories-put-skips-validation, web-watchdog, web-port-reclaim, google-api-refresh-race, stb.) külön ciklusokban, saját tervvel kerülnek sorra — a felhasználó kérésére (legkisebb, legbiztonságosabb).

## Választott elemek (prioritás: kockázat csökkenő)

### 1. `db-missing-telegram-history-table` (HIGH severity) — `src/db.ts` + `src/__tests__/db.test.ts`

**Probléma:** `saveTelegramMessage` (db.ts:2564) és `getTelegramHistory` (db.ts:2589) `telegram_history` táblára ír/olvas, de az `initDatabase()` egyetlen `CREATE TABLE IF NOT EXISTS` sem hozza létre (a `grep "CREATE TABLE" db.ts | grep telegram` üres). Friss installon az első híváskor `SqliteError: no such table` exception. A pinning teszt a `src/__tests__/db.test.ts`-ben még nem létezik (ellenőrizve).

**Megoldás (egyetlen szerkesztés db.ts-ban):**
- Beszúrni a `CREATE TABLE IF NOT EXISTS telegram_history (...)` blokkot az `initDatabase()`-be, a `pending_channel_requests` (db.ts:514) és `task_runs` (db.ts:533) közé, a séma az MD-ből másolva (UNIQUE(chat_id, message_id, direction) constraint + idx_telegram_history_chat_ts index).
- A séma OSZTJA a meglévő `INSERT OR IGNORE` idempotencia-szándékát a storage szinten is (ha bármely jövőbeli hívó elhagyja az `OR IGNORE`-t, a UNIQUE constraint megakadályozza a duplaírást).

**Pinning teszt hozzáadása `src/__tests__/db.test.ts`-hez:**
- `describe('telegram_history table (db-missing-telegram-history-table regression)')`
- `it('initDatabase creates telegram_history so saveTelegramMessage does not throw on a fresh install')` — `initDatabase(':memory:')` → `saveTelegramMessage(...)` → nem dob.
- `it('getTelegramHistory returns the rows saved by saveTelegramMessage in ts DESC order')` — beszúr 2 sort, lekéri, fordított ts sorrendben visszakapja.
- Mindkét teszt ma elbukna (a `no such table` miatt), a fix után zöld lesz.

**Kockázat:** Nagyon alacsony. Kizárólag ADDITÍV: `IF NOT EXISTS` védi a meglévő installációkat, és a kód többi része (`saveTelegramMessage` / `getTelegramHistory`) pontosan ezt a sémát várja.

### 2. `config-empty-env-blanks-identity` (HIGH severity) — `src/config.ts` + `src/__tests__/config.test.ts`

**Probléma:** 5 identity-konstans (`OWNER_NAME:129`, `BOT_NAME:135`, `BRAND_NAME:143`, `MAIN_AGENT_ID:200`, `SERVICE_ID:209`) `env['X'] ?? default` mintát követ. A `??` csak nullish-re defaultol, nem üres stringre. A `src/env.ts:37` az üres sort verbatim eltárolja (`BOT_NAME=` → `''`). A `src/config.ts:146-152`-ben lévő `resolveBrandName` HELYESEN kezeli (a `(brandEnv ?? '').trim() || botName` guard), de az általa "mirrözött" konstans NEM. A kód saját kommentje (`config.ts:146-149`) ELŐÍRJA az üres-string guardot, a jelenlegi kód viszont megszegi.

**Megoldás (egyetlen szerkesztés config.ts-ben):**
- Bevezetni egy `envOr(key: string, fallback: string): string` segédet, ami a `resolveBrandName` mintát követi: `return (env[key] ?? '').trim() || fallback`.
- Az 5 identity-konstanst átírni `envOr('X', Y)` hívásra. A SERVICE_ID defaultja MAIN_AGENT_ID (ami mostantól szintén `envOr` eredménye, tehát ha MAIN_AGENT_ID üres, SERVICE_ID is a fallback `marveen`-hez esik — EZ A KÍVÁNT VISELKEDÉS, mert az MD "MAIN_AGENT_ID empty breaks DB/tmux routing" kockázatot jelöl).
- A `WEB_HOST` konstanst a döntés szerint **NEM** módosítjuk (a pinning teszt jelenleg `expect(config.WEB_HOST).toBe('')` — ez nem változik, a fix után is üres marad, csak az identity-kulcsok javulnak). A scope-szűkítés oka: a numeric keys `parseInt('', 10) === NaN` témája külön ciklus.

**Meglévő pinning teszt (`config.test.ts:552-569`) frissítése:**
- A `BUG: an empty .env line blanks the identity instead of using the default` tesztet átalakítani: a `toBe('')` várakozásokat `toBe(<default>)` értékre cserélni (BOT_NAME → 'Marveen', BRAND_NAME → 'Marveen', OWNER_NAME → 'Owner', MAIN_AGENT_ID → 'marveen', SERVICE_ID → 'marveen', appServiceLabel → 'com.marveen.app').
- A `config.resolveBrandName('', 'Marveen')` → 'Marveen' részt megtartani (a teszt eredeti célja a helper vs. konstans eltérés kimutatása volt, a fix után ez a sor már nem a "defect jele", hanem a "helper továbbra is helyes" megerősítése — de a kommentet frissíteni kell, hogy ne tévesszen meg).

**Kockázat:** Alacsony. A `resolveBrandName` már MŰKÖDIK ezen a logikán — a fix csak kiterjeszti ugyanazt a mintát a 4 másik konstansra. A SERVICE_ID → MAIN_AGENT_ID lánc is megmarad (MAIN_AGENT_ID most `envOr` eredménye, SERVICE_ID defaultja továbbra is a `MAIN_AGENT_ID` értéke, nem a literal `'marveen'`). A `WEB_HOST` szándékos kihagyása miatt a régi teszt várakozásai (`config.WEB_HOST === ''` és `config.SERVICE_ID === ''`) közül az első megmarad, a második átíródik.

### 3. `index-unreachable-coverage` — `buildPidfileLockContext.log.error` ág (LOW, részleges)

**Probléma:** A `src/index.ts:283` `log.error: (obj, msg) => logger.error(obj, msg)` a `buildPidfileLockContext`-en belül soha nem hívódik. A `src/process-lock.ts:289-352` közötti `acquirePidfileLock` KIZÁRÓLAG `ctx.log.info` (301, 346) és `ctx.log.warn` (328, 336, 350, 352) hívásokat tartalmaz — `ctx.log.error` NINCS. A `process-lock.ts` teljes grepje (`grep "ctx.log"`) egyetlen `error` hívást sem tartalmaz erre a kontextusra.

**Fontos:** A `buildProcessLockContext.log.error` (line 174) ELLENBEN elérhető — a `process-lock.ts:158` (`ctx.log.error({ pid, err }, 'SIGKILL failed')`) hívja a `acquirePortLock` `acquireProcessLock`-on keresztül. Ezt NEM szabad eltávolítani.

**Megoldás (egyetlen szerkesztés index.ts-ben):**
- A `log: { info, warn, error: ... }` blokkot a `buildPidfileLockContext` függvényből (`src/index.ts:279-283`) lerövidíteni csak `info` + `warn` bejegyzésekre. Az MD-ben javasolt `*  never called by any caller` invarianst kommentben dokumentálni.

**Dokumentáció:**
- `docs/needs-to-be-fix/INDEX.md` `index-unreachable-coverage` sorát frissíteni: a 3 felsorolt ágból 2 (line 174, 382) már megoldódott (line 382 a `221d5c8` commitban halt el, line 174 a valós `acquirePortLock` úton továbbra is elérhető marad), és a megmaradt line 283 is lezárult.

**Kockázat:** Nagyon alacsony. A függvény statikusan halott: a `process-lock.ts` nem hívja, a tesztek nem hívják, a teljes `acquirePidfileLock` testét átnézve (process-lock.ts:289+) nincs `error` hívás. A `*  used by process-lock.ts:158` ellenőrzés ismételten explicit módon megerősíti, hogy csak a `buildProcessLockContext` verzióra igaz a hívás.

## Nem kerülnek ebbe a körbe (a terv határa)

Ezek a HIGH/MEDIUM elemek továbbra is nyitottak maradnak, és külön ciklusokban, saját tervvel kerülnek sorra:

- `multipart-boundary-greedy`, `multipart-latin1-fields` (web/multipart.ts módosítása kell, TS strict kockázat)
- `profiles-traversal-id` (web/profiles.ts + agents.ts route; route-szintű validáció is kell)
- `routes-memories-put-skips-validation` (refaktor kell a POST/PUT közös validate függvénybe)
- `web-watchdog-survives-close`, `web-port-reclaim-failure-leaves-unbound` (web.ts módosítása)
- `google-api-refresh-race` (single-flight wrapper, promise-cache)
- `keychain-store-insecure-acl` (a javítási terv első lépése MOST teljesült, de a `-A` → `-T, SECURITY` cseréhez valós host ellenőrzés kell)
- `env-update-duplicate-key-lost` (writer/reader szemantika egységesítése)
- Az összes "TS strict blocks the safe-delete" MD (külön TS-konfigurációs döntést igényelnek)

## Végrehajtási terv (workflow)

A user kérésére **workflow**-t kell használni. A terv: 1 db `Workflow` hívás, ami 3 fázisban (egy-egy ágens) futtatja a 3 elemet, mindent a jelenlegi `test/baseline` branch-ből kiindulva és oda visszavezetve.

```
Workflow: "3 needs-to-be-fix elem lezárása"
  Phase 1: db-telegram-history
    Agent 1: "Add telegram_history CREATE TABLE to src/db.ts initDatabase (between pending_channel_requests and task_runs blocks). Add UNIQUE(chat_id, message_id, direction) constraint and idx_telegram_history_chat_ts index. Schema MUST match the existing INSERT statement at db.ts:2574. Then add a regression test in src/__tests__/db.test.ts that calls initDatabase(':memory:'), then saveTelegramMessage, then getTelegramHistory, asserting no throw and correct ordering. Run: bun run typecheck && bun test src/__tests__/db.test.ts. Verify no other test breaks. Commit on test/baseline with message: 'fix(db): create telegram_history table on initDatabase + regression test (db-missing-telegram-history-table)'"

  Phase 2: config-empty-env-blanks-identity
    Agent 2: "Add envOr(key, fallback) helper to src/config.ts and route the 5 identity constants (OWNER_NAME, BOT_NAME, BRAND_NAME, MAIN_AGENT_ID, SERVICE_ID) through it. Mirror the resolveBrandName guard logic. Leave WEB_HOST alone. Update the existing pinning test at src/__tests__/config.test.ts:552-569 to assert the fixed behavior (toBe(<default>) instead of toBe('')). Run: bun run typecheck && bun test src/__tests__/config.test.ts. Verify no other test breaks. Commit on test/baseline with message: 'fix(config): route identity constants through envOr empty-string guard (config-empty-env-blanks-identity)'"

  Phase 3: index-unreachable-coverage line 283
    Agent 3: "Remove the dead `error: (obj, msg) => logger.error(obj, msg)` line from the `log: { info, warn, error }` block inside buildPidfileLockContext in src/index.ts (around line 283). Keep the info and warn entries. Confirm with grep that ctx.log.error is never called from acquirePidfileLock in process-lock.ts. Update docs/needs-to-be-fix/INDEX.md to reflect that all three sites in the original MD are now resolved (line 174 is reachable through process-lock.ts:158, line 382 was removed in 221d5c8, line 283 is being removed now). Run: bun run typecheck && bun test. Verify no other test breaks. Commit on test/baseline with message: 'fix(index): drop dead log.error from buildPidfileLockContext (index-unreachable-coverage)'"

  Phase 4: code-review (REQUIRED)
    After all 3 commits land, invoke /code-review xhigh --fix on the resulting 3-commit delta.
```

Minden fázis verify lépése a `bun run typecheck` + `bun test` (vagy az érintett tesztfájlra szűkítve). A typecheck 1703 hibája baseline; a +5 toleranciát egyik fázis sem lépi át (csak +0, +0, +0 vagy legrosszabb esetben +1-2 a service-id default lánc miatt, ami `string | string` szinten marad).

## Végpont ellenőrzés (verify)

A workflow utolsó lépése:
1. `git log --oneline test/baseline -5` — 3 új commit, mind a fenti üzenetekkel.
2. `git status` — working tree clean.
3. `bun run typecheck` — a hibaszám nem nőtt 1703 fölé (baseline).
4. `bun test 2>&1 | tail -20` — minden meglévő teszt zöld + az új `telegram history` describe block zöld + a frissített config pinning teszt zöld.
5. `grep "telegram_history" src/db.ts | head -5` — legalább 1 `CREATE TABLE IF NOT EXISTS` sor megjelenik.
6. `grep "envOr" src/config.ts | head -5` — 5 hívás + 1 definíció.
7. `grep -n "log: {" src/index.ts` — `buildPidfileLockContext` log blokkjában csak `info` + `warn`.

Ha bármelyik lépés nem megy át, a workflow a hibás fázisnál megáll, és a usernek jelzi.

## Kritikus fájlok

- `src/db.ts` (CREATE TABLE IF NOT EXISTS beszúrás + index)
- `src/__tests__/db.test.ts` (`describe('telegram_history table ...')` + 2 `it` blokk)
- `src/config.ts` (`envOr` helper + 5 konstans átírása)
- `src/__tests__/config.test.ts` (meglévő pinning teszt frissítése:556-563 sorok, komment 546-551)
- `src/index.ts` (`buildPidfileLockContext` log blokkjából 1 sor törlése)
- `docs/needs-to-be-fix/INDEX.md` (a `index-unreachable-coverage` sor státusz frissítése)

## Kapcsolódó segédletek, újrhasznosítható elemek

- `src/config.ts:150-153` (`resolveBrandName`) — ez a `envOr` minta referenciája
- `src/db.ts:514-528` (`pending_channel_requests` CREATE TABLE) — ez a stílus-minta az új táblához
- `src/__tests__/db.test.ts:32` (`initDatabase(':memory:')`) — ez a fresh-install setup
- `src/__tests__/config.test.ts:105-118` (`loadConfig` helper) — ezt használja a pinning teszt
- `src/process-lock.ts:289-352` (`acquirePidfileLock` body) — ez a bizonyíték, hogy `log.error` halott
