# needs-fix ciklus: 4 elem (S1, S2, S3, S4)

## Context

A `docs/needs-to-be-fix/` 176 hiba-MD-t tart nyilván, az `INDEX.md` követi a
státuszukat. Az előző ciklus (`242714e`..`3e1dd3f`, könyvelés `c9b12be`) négy
elemet zárt le. A `vitest.config.ts` 100% perFile coverage küszöböt ír elő
(`lines/functions/branches/statements = 100`), ezért minden strukturálisan
elérhetetlen defenzív ág egy-egy fedetlen branch, ami blokkolja a küszöböt.
A cél ugyanaz, mint eddig: a legkisebb és legkockázatmentesebb elemeket zárni,
mielőtt a nagyobb refaktorok jönnének.

A felderítés három dolgot hozott, ami eltér az MD-kben leírtaktól:

1. Négy INDEX sor hamis. A hivatkozott ágakat `c2b4ea2` / `014f1de` már törölte,
   de a `Resolved` oszlop még `—`. Forrásból ellenőrizve mind a négy.
2. A két `recall.ts` "TS strict blocks the safe-delete" MD téves premisszán áll.
   Azt állítják, `map[weekday]` típusa `number | undefined`. Ez csak
   `noUncheckedIndexedAccess` mellett igaz. A `bunx tsc --showConfig` kimenete
   szerint a flag nincs bekapcsolva, tehát a `?? 0` törlése simán fordul.
3. A `vault-ssh-keys` MD-k "unreachable IF branch"-ként írják le a problémát,
   nem viselkedési hibaként. A `.trim()` a 114. soron garantálja, hogy a 126.
   sori `endsWith('\n')` mindig hamis. Az egyetlen záró újsor a helyes ssh
   viselkedés, tehát a javítás a halott ternary törlése, nem a logika átírása.

Kimenet: 12 INDEX sor lezárása, 3 forrásfájl összesen 8 sornyi módosítással,
és három fájl branch coverage-e feljebb megy.

## Scope

Benne: S1, S2, S3, S4.
Kihagyva a user döntése alapján: S5 (`channel-coordinator` `processBatch`
szűkítés, néma offset-visszatekerés kockázata), S6 (`store-watcher`
`SENSITIVE_NAMES`, terméki döntést igényel).
Nem javasolt és nem kerül be: `channel-health-monitor.ts:27`,
`routes/docs.ts:62`, `channel-request-watcher.ts:67`.

## Branch politika

Minden `test/baseline`-ról indul és ide is kerül vissza. Nincs worktree
izoláció a workflowban, mert a `worktree.baseRef` alapértéke
`origin/<default-branch>`-ról ágazna le, ami rossz bázis. A négy elem négy
külön fájlt érint, párhuzamos izolációra nincs szükség. A commitok közvetlenül
`test/baseline`-ra mennek, ahogy az előző hat ciklusban is.

---

## S1 — `src/web/routes/vault-ssh-keys.ts:126`

Jelenlegi kód:

```ts
114:  const privateKey = typeof data.privateKey === 'string' ? data.privateKey.trim() : ''
...
126:  const keyContent = privateKey.endsWith('\n') ? privateKey : privateKey + '\n'
```

Módosítás:

```ts
126:  const keyContent = privateKey + '\n'
```

Miért biztonságos: a `privateKey` a 114. soron `.trim()`-elt érték. A `trim()`
whitespace-t vág, az `\n` whitespace, tehát a `privateKey.endsWith('\n')` soha
nem igaz. Az IF-ág halott, az ELSE-ág fut mindig. Bitre azonos kimenet.

Teszt: `src/__tests__/routes-vault-ssh-keys.test.ts` meglévő PIN tesztje
(`'one\n\n'` bemenet, `'one\n'` elvárás) változtatás nélkül zöld marad, és
mostantól a valódi invariánst rögzíti. A címét és a kommentjét át kell írni,
mert a "buggy trim-before-endsWith" megfogalmazás elavul. Mutációs ellenőrzés:
a `+ '\n'` eltávolításával a tesztnek buknia kell.

Lezárt MD-k: `vault-ssh-keys-endsWith-newline`,
`vault-ssh-keys-import-newline-trim-bug`.

## S2 — `src/web/routes/recall.ts:25` és `:153`

Jelenlegi kód:

```ts
 24:  const map: Record<string, number> = { Sun: 0, Mon: 1, ..., Sat: 6 }
 25:  return map[weekday] ?? 0
...
147:  const weekMap: Record<string, number> = { elso: 0, masodik: 1, harmadik: 2, negyedik: 3 }
148:  if (weekMatch[1] === 'utolso') { /* early return */ }
153:  const weekIdx = weekMap[weekMatch[1]] ?? 0
```

Módosítás: mindkét `?? 0` törlése.

Miért biztonságos:
- 25. sor: `Intl.DateTimeFormat('en-US', { weekday: 'short' })` a hét fix
  háromjegyű rövidítéseit adja vissza, mind a hét szerepel a `map`-ben.
- 153. sor: a 142. sori regex alternációja pontosan öt értéket enged át,
  ezek közül az `utolso` a 148. soron korábban visszatér. A maradék négy mind
  benne van a `weekMap`-ben.
- Típus: `noUncheckedIndexedAccess` nincs bekapcsolva, `map[weekday]` típusa
  `number`. A `tsc --noEmit` hibaszám nem nőhet. Ha mégis nő, a lépés azonnal
  visszavonandó, és az MD premisszája helyes volt.

Teszt: `src/__tests__/recall.test.ts` ma `elso`, `masodik`, `utolso` esetet fed.
Két dolgot kell hozzáadni:
- `harmadik` és `negyedik` hetes kifejezés, hogy a `weekMap` mind a négy kulcsa
  pinnelve legyen.
- egy teszt, ami hét egymást követő napra hívja a `startOfWeek`-en keresztül
  elért `dayOfWeekBudapest`-et, és ugyanazt a hétfőt várja mind a hétre. Ez a
  teljes `map`-et lefedi, tehát a törölt fallback helyét pinneli.

Lezárt MD-k: `recall-dayOfWeekBudapest-fallback`, `recall-weekIdx-fallback`,
`routes-recall-25-ts-strict-blocks-delete`,
`routes-recall-153-ts-strict-blocks-delete`,
`recall-unreachable-defensive-fallbacks`.

## S3 — INDEX könyvelés 4 hamis sorra

Nincs forráskód-módosítás. A négy ág már nincs a HEAD-en, forrásból ellenőrizve:

| Bug ID | Bizonyíték a HEAD-en | Commit |
| --- | --- | --- |
| `skills-import-seg-truthy-guard` | `skills.ts:407-410` nincs `if (seg)` | `c2b4ea2` |
| `skills-sort-comparator-falsy-arms` | `skills.ts:155-158` nincs `label \|\| name` | `c2b4ea2` |
| `reauth-healer-stampalert-if-st-dead-code` | `reauth-healer.ts:393-396` `st!`-t használ, nincs `if (st)` | `c2b4ea2` |
| `stuck-tool-call-watcher-dead-ternary` | `stuck-tool-call-watcher.ts:192` sima `Date.now() - lastRespawn` | `014f1de` |

## S4 — `src/index.ts` halott heartbeat shutdown blokk

Jelenlegi kód:

```ts
 16:  import { initHeartbeat, stopHeartbeat } from './heartbeat.js'
...
371:  let heartbeatStarted = false
...
381:  if (heartbeatStarted) {
382:    try { stopHeartbeat() } catch (err) { logger.warn({ err }, 'stopHeartbeat threw during shutdown') }
383:  }
```

Módosítás: a 381-383 blokk, a 371. sori változó és a 16. sori import törlése.

Miért biztonságos:
- `heartbeatStarted` sehol nem kap `true` értéket. Az egyetlen írás a 371. sori
  deklaráció, a 477. sor csak kommentben említi. `initHeartbeat` importálva van,
  de soha nem hívódik. A natív scheduler nyugdíjazva lett.
- Az import törlésével a `heartbeat.js` már nem töltődik be az `index.ts`-ből.
  Ez azért nem visel terhet, mert a `src/index.ts:16` az egyetlen nem-teszt
  importáló, és a `heartbeat.ts`-nek nincs egyetlen top-level végrehajtható
  utasítása sem, csak konstans- és függvénydeklarációk. Ellenőrizni kell, hogy
  a `heartbeat.ts` saját tesztjei (`heartbeat-cov.test.ts`) továbbra is zöldek
  és a coverage nem esik, mert a fájl a `src/**/*.ts` include-ban marad.

Teszt: `src/__tests__/index.test.ts`
- Marad és regressziós pinné átcímezve: `does NOT call stopHeartbeat when
  heartbeatStarted is false` (1137-1142). Ez rögzíti, hogy a shutdown nem
  hivatkozik a heartbeatre.
- Törlendő, mert üres: `calls stopHeartbeat when heartbeatStarted is true`
  (1144-1158, törzse `expect(true).toBe(true)`).
- Törlendő, mert az előző duplikátuma: `handles stopHeartbeat throwing
  (heartbeatStarted true branch)` (2160-2183).
- A `vi.mock('../heartbeat.js')` blokk (123-124) maradhat, ártalmatlan.

Lezárt MD: `index-stopHeartbeat-throw`. Az `index-unreachable-coverage` MD
három sort említ (174, 283, 382), ebből csak a 382 szűnik meg, ezért az a sor
nyitva marad, és a megjegyzésébe bekerül a részleges lezárás.

---

## Végrehajtás workflow-val

Négy ügynök, `worktree` izoláció nélkül, `test/baseline`-on.

Fázis 1, "Verify" (3 párhuzamos, csak olvasó ügynök, strukturált GO/NO-GO):
- V1: S1 ekvivalencia bizonyítása. Ellenőrzi, hogy nincs másik írási pont a
  `privateKey`-re a 114 és 126 között, és hogy a PIN teszt tényleg buknia kell
  a `+ '\n'` eltávolításakor.
- V2: S2 elérhetetlenség bizonyítása. Kilistázza a `dayOfWeekBudapest` és a
  `weekMap` minden hívóját, és megerősíti, hogy a `tsc` konfigban tényleg nincs
  `noUncheckedIndexedAccess`.
- V3: S4 halott kód bizonyítása. Megerősíti, hogy nincs `heartbeatStarted = true`
  írás sehol, hogy a `heartbeat.ts` top-level mellékhatásmentes, és kilistázza
  az `index.test.ts` minden érintett tesztjét.

Fázis 2, "Apply" (1 ügynök, csak a GO-t kapott elemekre): sorban alkalmazza a
három forrásmódosítást és a teszteket, futtatja a célzott teszteket, és
commitonként külön commitot készít.

A könyvelés (S3 és az MD Resolution szekciók) a fő ciklusban készül el, a
forrás-commitok SHA-inak ismeretében.

## Commit terv

Az eddigi konvenció: forrás és teszt egy commitban elemenként, a könyvelés
külön commitban a végén.

1. `refactor(vault-ssh-keys): drop unreachable endsWith('\n') ternary on key import`
2. `refactor(recall): drop two unreachable ?? 0 fallbacks`
3. `refactor(index): delete dead heartbeatStarted shutdown block`
4. `docs(needs-to-be-fix): mark 12 needs-fix items resolved`

A 4. commit tartalma:
- `INDEX.md`: 12 sor `—` helyett `Resolved: 2026-08-16 <sha>` formátumban.
  Ez a legújabb konvenció (`c9b12be` vezette be), a régebbi `2026-08-14 014f1de`
  formátumú sorokat nem írjuk át visszamenőleg.
- Minden érintett MD-be `## Resolution (2026-08-16, <sha>)` szekció. A két
  `recall` "TS strict blocks" MD-ben rögzíteni kell, hogy az eredeti premissza
  téves volt, mert `noUncheckedIndexedAccess` nincs bekapcsolva.
- Az `index-unreachable-coverage` sor megjegyzése frissül a részleges lezárásról.

## Verification

Alaphelyzet rögzítése a módosítások előtt, majd összehasonlítás utána.

1. Típusellenőrzés nem romolhat:
   `bun tsc --noEmit 2>&1 | grep -c "error TS"` előtte és utána. A szám nem
   nőhet. A jelenlegi baseline kb. 1703, a tűrés `+0` ezekre a változtatásokra,
   mert egyik sem érint típusdeklarációt.
2. Célzott tesztek zöldek:
   `bun --bun vitest run src/__tests__/routes-vault-ssh-keys.test.ts src/__tests__/recall.test.ts src/__tests__/routes-recall.test.ts src/__tests__/index.test.ts src/__tests__/heartbeat-cov.test.ts`
3. Teljes suite nem regresszál:
   `bun --bun vitest run` futtatása, a bukó tesztek listája meg kell egyezzen a
   módosítás előttivel.
4. Coverage a három érintett fájlra nem eshet:
   `bun --bun vitest run --coverage`, majd a `coverage/coverage-summary.json`-ból
   a `src/web/routes/vault-ssh-keys.ts`, `src/web/routes/recall.ts`, `src/index.ts`
   és `src/heartbeat.ts` branch százaléka előtte és utána. Az elvárás, hogy a
   három érintett fájlé nő, a `heartbeat.ts`-é nem változik.
5. Mutációs ellenőrzés elemenként, a CLAUDE.md teszt-szabálya miatt:
   - S1: `+ '\n'` eltávolítása után a PIN tesztnek buknia kell.
   - S2: a `weekMap`-ből a `harmadik` kulcs eltávolítása után az új tesztnek
     buknia kell.
   - S4: nincs mutációs pont, a kód törlésre kerül; a megmaradó teszt azt
     rögzíti, hogy a `stopHeartbeat` nem hívódik.
6. CI: mindkét job pirosra van tervezve (`lint` a kb. 9933 eslint és 1703 tsc
   adósság miatt, `coverage` a 44 küszöb alatti fájl miatt). A jel nem a
   zöld/piros, hanem hogy a bukó tesztek és a küszöb alatti fájlok halmaza nem
   nő. Ezt a 3. és 4. pont adja, a CI futás csak megerősítés.
