# Plan: Multipart parser hardening — 7 remaining findings

## Context

A `test/baseline` branchon a multipart parser (`src/web/multipart.ts`) az
előző ciklusokban két MD-t zárt le:

- `multipart-boundary-greedy` (commit `6b82c2f6`): a boundary regex lezárja
  a boundary-t az első `;` vagy idézőjel után.
- `multipart-latin1-fields` (commit `6b82c2f6`): szöveges mezők és fájlnevek
  UTF-8 dekódolása.

A kötelező `/code-review max --fix` az implementáció után 7 nyitott
finding-ot tárt fel, amelyek egyike kritikus. A mostani scope ezt a 7
finding-ot zárja le egy fókuszált, kombinált ciklusban — ugyanazt a
fájlt/modult érintik, nincs köztük kölcsönhatás (két független Explore
subagent 2026-08-21-en igazolta: minden finding PRESENT, SAFE_TO_COMBINE,
nincs mutual exclusion).

A 7 finding (`src/web/multipart.ts`, `src/__tests__/multipart.test.ts`):

| # | Severity | Finding | Fix helye |
|---|---|---|---|
| 1 | **CRITICAL** | boundary regex unanchored → `myboundary=WRONG; boundary=REAL` a `WRONG`-ot fogja meg | src/web/multipart.ts:13 |
| 2 | Medium | `name=` / `filename=` regexekből hiányzik a `/i` flag | src/web/multipart.ts:29, 33 |
| 3 | Low | `Buffer.toString('binary')` és `Buffer.from(s, 'binary')` deprecated alias | src/web/multipart.ts:16, 18, 38 |
| 4 | Low | boundary hossz nincs 70 karakterre korlátozva (RFC 2045 §5.1) | src/web/multipart.ts:13 után |
| 5 | Low | `boundary =REAL` (whitespace az `=` körül) csendben elutasítva | src/web/multipart.ts:13 |
| 6 | Low | `describe('pinning')` blokkban 6 teszt keveredik (4 javított pinning + 2 edge-case) | src/__tests__/multipart.test.ts:278-336 |
| 7 | Low | `forditott sorrendu filename/name` teszt kommentje (`line 327`) félrevezető: a regex NEM anchor-olt, a `name="a.png"` substringet fogja meg | src/__tests__/multipart.test.ts:327 |

A kombín nem keletkeztet új bugot, mert:
- #1 + #5 ugyanazt a regexet érintik, egyetlen atomi regex cserével megoldható:
  `/(?<=^|[;,])\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i`
- #2 és #7 a `nameMatch` anchorolását jelenti: `/(?:^|;\s)name="([^"]+)"/i` — a
  forditott sorrendű teszt (`Content-Disposition: form-data; filename="a.png"; name="avatar"`)
  továbbra is átmegy, mert a `;\s` prefix a pontosvessző-szóköz előtti pozícióra illeszkedik.
- #3 pure rename, `'binary'` és `'latin1'` byte-identikus alias-ok (Node.js
  Buffer API dokumentáció).
- #4 tiszta early-return guard, egyetlen teszt sem használ 70 karakternél
  hosszabb boundary-t (`BOUNDARY = '----WebKitFormBoundaryABC123'`, 26 karakter).
- #6 teszt-átszervezés, kódot nem érint.

## Implementation

A kombinált fix egy 4-commit ciklusként fut le a jelenlegi
`test/baseline` branch-ről indulva és oda visszatérve. Minden commit
lokálisan marad (push tilos).

### Commit 1 — `fix(multipart): unanchor boundary regex, case-insensitive parameters, latin1, length cap, anchor nameMatch`

`src/web/multipart.ts`:

```ts
// Elotte (sor 13):
const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
// Utana:
const boundaryMatch = contentType.match(
  /(?<=^|[;,])\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
)
// + 70-char guard:
if (boundary.length > 70) return { fields: {} }
```

További sor-módosítások ugyanebben a commitban:

```ts
// 16: buf.toString('binary')        -> buf.toString('latin1')
// 18: Buffer.from(s, 'binary')      -> Buffer.from(s, 'latin1')
// 38: Buffer.from(body, 'binary')   -> Buffer.from(body, 'latin1')
// 29: headers.match(/name="([^"]+)"/)        -> headers.match(/(?:^|;\s)name="([^"]+)"/i)
// 33: headers.match(/filename="([^"]+)"/)    -> headers.match(/(?:^|;\s)filename="([^"]+)"/i)
```

A 13-as soron lúvő comment frissítése:
- Törölni a "NOTE: unanchored" sort (már anch-or-olt).
- Hozzáadni a `(?<=^|[;,])` lookbehind magyarázatát (RFC 2045 §5.1 + RFC 2046 §5.1.1).

### Commit 2 — `test(multipart): reorganize pinning block, fix misleading comment, add boundary-whitespace and Name="X" cases`

`src/__tests__/multipart.test.ts`:

1. A `describe('parseMultipart - ismert eltresek (pinning)')` blokkot
   (sor 278-336) szétbontjuk ketté:
   - `parseMultipart - pinning (ismert elteresek)` — a 4 javított MD-hez
     tartozó aktív korrekciós tesztek (sor 279-317): quoted boundary, trailing
     param, UTF-8 szöveg, UTF-8 fájlnév.
   - `parseMultipart - boundary es parameter edge-casek` — a 2 edge-case teszt
     (sor 319-335): case-insensitive Content-Disposition, fordított sorrend.

2. Sor 327 komment javítása:
   ```
   // Elotte:
   // A regex a name=" prefixet koveteli, igy a filename="..."-re nem illeszkedik;
   // a fajl-ág eldobja a fieldName-et, ezert a file.name helyes marad.
   //
   // Utana:
   // A nameMatch regex anchor-olt (^ vagy ;\s prefix), igy kizarolag a parameteres
   // nevet fogja meg, a filename belsejébol ne. A fajl-ág eldobja a fieldName-et,
   // ezert a file.name helyes marad.
   ```

3. **Opcionális, de ajánlott** két pozitív teszt hozzáadása az új
   viselkedéshez:
   - `boundary =REAL` (whitespace az `=` körül) — Finding #5 lock-in.
   - `Name="X"` (case-insensitive parameter) — Finding #2 lock-in.

### Commit 3 — `docs(needs-to-be-fix): new MD multipart-boundary-unanchored + Resolved banner on multipart-case-sensitive-disposition`

User-döntés (2026-08-21): a 7 finding legkritikusabb darabjához önálló
MD nyílik, a többi 6 finding a meglévő MD kiegészítésével dokumentálódik.

**Új fájl**: `docs/needs-to-be-fix/multipart-boundary-unanchored.md`
(az alábbi tartalommal):

```markdown
# multipart.ts: a boundary regex unanchored, captures the WRONG boundary when a hijack parameter precedes the real one

## Location

`src/web/multipart.ts`, line 13 (a `parseMultipart` body elején):

\```ts
// Elotte (a 2026-08-21 fix elott):
const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
\```

## Excerpt

A regex literal `boundary=` illeszkedik a substringre `myboundary=` belsejében
is, mert nincs anchor. Egy kliens, amely `multipart/form-data;
myboundary=WRONG; boundary=REAL` content-type-ot kuld, a parser a
`WRONG`-ot fogja meg boundary-nek, a valodi `REAL` soha nem kerul kiertekelesre.

A forditott eset (a valodi boundary jon eloszor) mukodik, mert
`.match()` az elso illeszkedest adja vissza — de a WRONG boundaryvel
feldolgozott buffer soha nem tartalmazza a `--REAL` delimitert, igy a
parser `{ fields: {} }`-t ad vissza csendben, mint egy ures multipart body.

## Failure scenario

1. Egy kliens (curl script, reverse proxy, HTTP/2 intermediary, vagy
   hibasan konfiguralt framework) kuld egy content-type-ot:
   `multipart/form-data; myboundary=WRONG; boundary=REAL`
2. `parseMultipart` a `boundaryMatch[2]`-be `WRONG`-ot rak.
3. `buf.toString('latin1').split('--WRONG')` egyetlen elemet ad (a
   valodi delimiter a `--REAL`, ami soha nem fordul elo).
4. Az egesz buffer egy darabkent kerul feldolgozasra, nem talal
   `Content-Disposition` headert, minden part `continue`-dik.
5. A parser `{ fields: {} }`-t ad vissza, mint egy ures form.

Akovetkezmeny: `POST /api/agents/import` (`src/web/routes/agents.ts:1913`)
a `No bundle uploaded` (400) uzenetet adja, pedig a bundle a body-ban
volt. Ugyanez erinti `src/web/routes/marveen.ts:193`, `skills.ts:387`,
`agents-skills.ts:79`-et.

## Pinning test

`src/__tests__/multipart.test.ts` ujonnan hozzaadott teszt a fix
mellet (megtalalhato a `parseMultipart - boundary felismerés`
describe blokkban, Commit 2 reszere kerul at):

\`\`\`ts
it('a boundary-t csak akkor fogadja el, ha parameter-eleje boundary (nem myboundary)', () => {
  const body = buildBody([fieldPart('greeting', 'hello')])
  const hijackCT = `multipart/form-data; myboundary=WRONG; boundary=${BOUNDARY}`
  expect(parseMultipart(body, hijackCT).fields).toEqual({ greeting: 'hello' })
})
\`\`\`

A pinning a REGEX valtozasat rogziti: a `(?<=^|[;,])` lookbehind kizarja
a parameter-kozepepu illeszkedest.

## Suggested direction (mar alkalmazva)

A fix a Commit 1 reszeben mar megtortent:

\`\`\`ts
const boundaryMatch = contentType.match(
  /(?<=^|[;,])\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
)
\`\`\`

A lookbehind `(?<=^|[;,])` kotelezi, hogy a `boundary=` egy uj parameter
elejen vagy a string elejen alljon. A `\s*=\s*` megengedi a whitespace-t
az `=` korul (RFC 2045 §5.1 `linear-white-space`).

A chaining egyetlen atomic regex modositassal oldja meg az unanchored
match (Finding #1) + a linear whitespace (Finding #5) problemait egyutt.

**Status:** RESOLVED 2026-08-21 <sha> -- boundary regex anchored,
whitespace around `=` accepted per RFC 2045 §5.1.
```

**Létező fájl** módosítása: `docs/needs-to-be-fix/multipart-case-sensitive-disposition.md`

A felső `## Location` rész kiegészítése a 2 új fixszel (a header-name fix
már megvolt a `b5baca3`-ban, de a MD ezt nem jelölte). A MD alján
hozzáadni:

```
**Status:** RESOLVED 2026-08-21 <sha> -- parameter-name /i flag and
nameMatch anchoring applied. Header-name fix already landed in
2026-08-16 b5baca3.
```

A `<sha>` placeholder NEM kerül a fájlba — ez a `safe-commit-message`
skill-en keresztül, fájlból olvasott üzenettel megy (`git commit -F`).
A tényleges SHA a commit után a `dff00d2 docs(needs-to-be-fix): fill
Resolved SHAs after fix commits` mintára egy követő commitban kerül
befejezésre (mindig ígyvolt a korábbi ciklusokban).

A 6 maradék finding (`/i` flag, `binary`→`latin1`, 70-char cap, linear
whitespace, describe-block, comment) egyike sem kapott saját MD-t —
ezek a cycle 38-as `/code-review max --fix` kimenetebol szarmaznak. Az
új `multipart-boundary-unanchored.md` kizarolag a CRITICAL unanchored
finding-ot dokumentalja; a többi 6 ebben a MD Resolved banner-ben van
osszefoglalva.

### Commit 4 — `docs(needs-to-be-fix): INDEX.md -- mark Resolved`

`docs/needs-to-be-fix/INDEX.md`:

Két modositas:

1. A `multipart-case-sensitive-disposition` sorban a `Resolved` oszlop
   frissítése: `Resolved: 2026-08-16 b5baca3` → `Resolved: 2026-08-21 <sha>`.

2. Új sor beszúrása a Medium severity szekcióba:
   ```
   | `multipart-boundary-unanchored` | `src/web/multipart.ts:13` | unanchored boundary regex captures WRONG when a hijack parameter (e.g. `myboundary=`) precedes the real one | `src/__tests__/multipart.test.ts` | Resolved: 2026-08-21 <sha> |
   ```

A `<sha>` placeholder-ek a Commit 3-hoz hasonlóan a `dff00d2`-s
mintat kovetve egy koveto commitban kerulnek kiegeszitesre.

## Critical files

| Fájl | Változás |
|---|---|
| `src/web/multipart.ts` | 7 sor módosul + 70-char guard hozzáadódik |
| `src/__tests__/multipart.test.ts` | 1 komment javítás, describe blokk szétbontás, opcionálisan 2 új teszt |
| `docs/needs-to-be-fix/multipart-case-sensitive-disposition.md` | Resolved banner |
| `docs/needs-to-be-fix/INDEX.md` | Resolved oszlop frissítés |

## Verification

A workflow végrehajtás után, de még a `/code-review` előtt:

1. **Izolált worktree** a teszteléshez (a `store/` pollution elleni
   védelem per CLAUDE.md):
   ```sh
   git worktree add --detach /tmp/claw-multipart-test test/baseline
   ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-multipart-test/node_modules
   ```

2. **Vitest run** a fókuszált subset-en:
   ```sh
   cd /tmp/claw-multipart-test
   bun --bun vitest run src/__tests__/multipart.test.ts
   ```
   Elvárt: minden meglévő teszt zöld + az opcionális 2 új teszt is zöld.

3. **TypeScript check** csak a módosított fájlra (a pre-existing ~2253
   `db.ts` hibák kiszűrése):
   ```sh
   bun x tsc --noEmit src/web/multipart.ts
   ```
   Elvárt: nincs új hiba a multipart.ts-ban.

4. **Coverage check** a teljes src-re (a `vitest.config.ts` 100%-os
   threshold-je a korábbi ciklusban is átment):
   ```sh
   bun --bun vitest run --coverage
   ```

5. **Worktree takarítás**:
   ```sh
   git worktree remove --force /tmp/claw-multipart-test
   ```

A workflow végén kötelező felhasználói invokáció:

```sh
/code-review max --fix <commit1-sha>..HEAD
```

> A `/code-review` skill `disable-model-invocation` flag-gel rendelkezik
> (CLAUDE.md), ezért kizárólag a user hívhatja manuálisan a terminálban.
> A workflow végén értesítjük a user-t, hogy indítsa el.

## Workflow structure

A workflow 2 fázisban fut (`pipeline` mintával, mert a fázisok
állapotfüggetlenek):

### Fázis 1 — Implementáció és tesztek

Egyetlen ügynök végzi a 4 commitot:
- `fix(multipart)` commit
- `test(multipart)` commit
- `docs(needs-to-be-fix)` MD Resolved banner commit
- `docs(needs-to-be-fix)` INDEX frissítés commit

A `safe-commit-message` skill-t használja minden commitnál.

### Fázis 2 — Verifikáció

Egyetlen ügynök végzi:
- izolált worktree létrehozás
- `bun --bun vitest run src/__tests__/multipart.test.ts` futtatás
- ha bármelyik teszt fail, akkor VISSZA a Fázis 1-be (barrier)
- typecheck a módosított fájlra
- worktree cleanup
- eredmény jelentése a fő sessionnek

Ha a Fázis 2 bármely hibát talál, a workflow megáll és a fő session
dönt a korrekcióról. Ha minden átmegy, a workflow késznek jelenti a
cikust, és a user meghívja a `/code-review max --fix` skillt.

## Miért NEM kombináljuk más needs-fix elemekkel

A következő elemek explicit kimaradnak:

- **`test-suite-store-pollution-store-dir-frozen`** (HIGH): teljes architektúra
  refaktor (config.ts getter-ek, több tucat teszt sandboxolás, `db.ts` +
  minden STORE_DIR-re épülő fájl). A közelmúltban (2026-08-06) user
  panaszt váltott ki egy hasonló store-pollution eset — kockázatos
  egy ciklusban a multipart hardeninggel.
- **`index-unreachable-coverage`** (Medium): "NEVER modify src/index.ts"
  szabály alatt áll (MD szerint). A `928` / `947` / `1158` vonalak
  közül kettő már amúgy is resolved, a harmadikat (line 382) egy
  korábbi ciklus (`221d5c8`) törölte. Külön user-engedély szükséges.
- **`message-router-cache-fallback-unreachable`**: "NEVER modify
  src/web/message-router.ts" szabály alatt. A refaktor opció (a)
  kockázatos (lookupAgentSession helper), opció (b) a threshold
  csökkentés — egyik sem triviális.
- **`channel-coordinator-internals-untestable`**: "NEVER modify
  src/channel-coordinator.ts" szabály alatt.
- **`channel-request-watcher-unreachable-provider-check`**: TRIPWIRE
  komment ("DO NOT RAW-DELETE (TOKEN LEAK)") — eggp írja a
  tripwire-eket (CLAUDE.md). Külön user-engedély + saját tervezés.
- **`web-inbound-probe-respawn-grace`**: vitest dynamic-import mock
  bug, mock-rendszer refaktor — nem kapcsolódik a multipart-hoz.
- **`federation-inbox-fedPeer-null-fallback`**: "NEVER modify
  src/web/routes/federation.ts" szabály alatt.
- **`keychain-store-insecure-acl`**: "NEVER modify src/web/keychain.ts"
  szabály alatt, ráadásul documented-only.
- **`agent-worker-settings-symlink-preserve`**: az előző ciklusban
  (`e40c7f0`, `b70a1f7`, `24bea87`) már megoldódott, csak az INDEX
  frissítése maradt — külön micro-cycle.

Ezek mindegyike külön tervezést és user-engedélyt igényel.

## Kockázatok és mitigáció

| Kockázat | Valószínűség | Mitigáció |
|---|---|---|
| A boundary anchor regex túl szigorú, és egy létező kliens `boundary =REAL` formátumot küld | Alacsony | A RFC 2045 §5.1 megengedi a whitespace-t, a teszt subset-ben minden boundary=`;` után áll közvetlenül — anchoring + `\s*=` kombináció biztonságos |
| A `nameMatch` anchorolás (`(?:^|;\s)`) eltöri a forditott sorrendű tesztet | Alacsony | Mindkét subagent explicit ellenőrizte: a `;\s` prefix a pontosvessző-szóköz pozícióra illeszkedik, a teszt átmegy |
| A `latin1` rename valahol máshol is használatos és a Buffer API eltérően kezeli | Nagyon alacsony | A Node.js Buffer dokumentáció szerint `'binary'` és `'latin1'` byte-identikus alias; a 0x00-0xFF round-trip teszt (line 197-207) explicit ellenőrzi |
| A 70-char cap egy edge-case kliensnél hosszabb boundary-t küld | Nagyon alacsony | RFC 2045 §5.1 kötelező érvényű: "the boundary value MUST be at most 70 characters" |
| A describe blokk szétbontás egybeesik egy másik review-val | Alacsony | A `vitest.config.ts` `setupFiles` csak a `__tests__/setup/`-ből olvas, a describe blokkok szabadon rendezhetők |
| A `store/` pollution false-positive-ba futtatja a vitest suite-ot | Közepes | A workflow izolált `/tmp/claw-multipart-test` worktree-ben futtat, ahol biztosan tiszta a `store/` |
| A vitest subset átmegy, de más subset-en regresszió | Alacsony | A multipart parser izolált, nincs más fájlra hatással — a teljes src/ lefedettség ellenőrizve |

A két független Explore subagent 2026-08-21-en explicit megerősítette:
"Nincs kölcsönhatás. Egyetlen atomic source commit + egyetlen test
commit + docs + INDEX biztonságosan végrehajtható."