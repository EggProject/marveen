# Plan: Multipart parser boundary + latin1 fixek (2 commit)

## Context

A `src/web/multipart.ts` parser két csendes adat-korrupciós hibát rejt, mindkettőt a 2026-08-13-as lefedettségi passz során filet MD azonosítókkal:

1. **`multipart-boundary-greedy`** — `boundary=(.+)` regex mohó és nem kezeli a `quoted-string` formát vagy a `boundary=ABC; charset=utf-8` trailing paramétert. Eredmény: a split soha nem talál delimiter-t, a parser az egész testet egyetlen mezőértékként adja vissza a lezáró delimiterrel együtt (`fields.greeting === 'hello\r\n------WebKitFormBoundaryABC123--'`). A `POST /api/agents/import` (agents.ts:1916) ezt az értéket használja `overrideName`-ként → csendes "overwrite=false" és "No bundle uploaded" 400-as hibaüzenet.

2. **`multipart-latin1-fields`** — `buf.toString('binary')` (latin1) visszafejtés helyes a bináris file payload-hoz (`Buffer.from(body, 'binary')` fordítva latin1-re pontosan visszaadja a bájtokat), de **helytelen** a két string-outputra: a `result.fields[fieldName]` és `file.name` UTF-8 bájtként olvasott latin1-gyanús szöveget ad vissza (mojibake: `árvíztűrő` → `Ã¡rvÃ­ztÅ±rÅ‘`). Ez minden nem-ASCII mezőértéket és fájlnevet érint — adatvesztés nem visszaállítható.

Mindkét hiba magas súlyosságú (silent corruption), de a fájl kicsi és a hívók száma kicsi (5 callsite, mindegyik lokális). A kettő **összevonható biztonságosan**: ugyanaz a parser, ugyanaz a tesztfile, egymástól független kód-régiók. Commit prefix: `fix(multipart)` (követi a `b5baca3` precedenst). A korábbi "NEVER modify src/web/multipart.ts" task-szabály a `b5baca3` commit óta érvénytelen.

## Approach

### Fix 1: Boundary regex (src/web/multipart.ts:9)

```ts
const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
if (!boundaryMatch) return { fields: {} }
const boundary = boundaryMatch[1] ?? boundaryMatch[2]
```

- `(?:"([^"]+)"|([^;\s]+))`: quoted-string formátumnál group 1, bare token-nél group 2
- `[^;\s]+`: a bare token leáll a `;`-nél vagy whitespace-nél (RFC 2045 szerinti param-list lezárók)
- `i` flag: a paraméternév case-insensitive (RFC 2045)
- Az üres `boundary=` esetén egyik alternatíva sem illeszkedik (mindkettő legalább 1 karaktert kíván) → visszatérés `{}` üres mezőkkel (megegyezik a jelenlegi viselkedéssel)
- **Dokumentált limitáció** (commit body-ban): a `[^"]+` nem kezeli a RFC 2045 escaped-quote-ot (`boundary="a\"b"`) és a LWSP-fold-ot a quoted-string belsejében. Mindkettő elméleti határ — a wire-on boundary-karakterként nem jelenhet meg idézőjel a testben (különben megtöri a delimiter egyediségét), így a gyakorlatban nem fordul elő.

### Fix 2: UTF-8 re-decode csak a két string-outputra (src/web/multipart.ts:31, 36)

```ts
const decodeUtf8 = (s: string): string => Buffer.from(s, 'binary').toString('utf8')
...
result.file = {
  name: decodeUtf8(filenameMatch[1]),
  data: Buffer.from(body, 'binary'),  // változatlan: bináris round-trip
  ...
}
...
result.fields[fieldName] = decodeUtf8(body)
```

- A latin1 transport (`buf.toString('binary')` + `Buffer.from(body, 'binary')`) **érintetlen marad**: a bináris file payload 0x00-0xFF között byte-for-byte round-trip-et tart (lásd `a binaris bajtokat...` teszt, sor 179-189).
- A `decodeUtf8` kizárólag a két string-kimeneten fut. ASCII inputra noop (UTF-8 és latin1 azonos U+0080 alatt) → minden meglévő ASCII teszt változatlanul zöld marad.
- A `Buffer.from(body, 'binary')` opció nem szűnik meg — a `data` mező továbbra is pontosan a wire-bájtokat tartja.
- **Dokumentált trade-off** (commit body-ban): a `Buffer.toString('utf8')` invalid UTF-8 szekvenciára U+FFFD-t szubstitúál (WHATWG spec). Az RFC 7578 §5.1 UTF-8-at ír elő, így ez a helyes viselkedés; a latin1-wire-bytes (RFC-sértő) küldőktől érkező input romlását a fix elfogadja, mivel a cél a RFC-kompatibilis dekódolás.

### Teszt változtatások (src/__tests__/multipart.test.ts)

A "parseMultipart - ismert eltresek (pinning)" describe blokk **4 pinning tesztje** átáll **helyes elvárásra + aktív korrekciós címre** (a `b5baca3` commit mintája: cím átírása passzív defectről aktív korrekcióra, nem csak negálás). A blokk fejléc komment frissül.

| Sor | Jelenlegi cím | Új cím | Jelenlegi expect | Új expect |
|---|---|---|---|---|
| 263 | `'idezojeles boundary eseten a mezo erteke a hatarolot is elnyeli'` | `'a quoted-string boundary-rol leveszi az idezojeleket (RFC 2046)'` | `toBe(\`hello\r\n--${BOUNDARY}--\`)` | `toBe('hello')` |
| 274 | `'a boundary utani tovabbi parametert is a boundary reszekent nyeli le'` | `'a boundary-t a kovetkezo parameter elott lezarja (RFC 2045)'` | `toBe(\`hello\r\n--${BOUNDARY}--\`)` | `toBe('hello')` |
| 280 | `'a mezo erteket latin1-kent dekodolja, igy az UTF-8 ekezet elromlik'` | `'a szoveges mezoket UTF-8-kent dekodolja (RFC 7578)'` | `not.toBe(value)` + round-trip | `toBe(value)` |
| 295 | `'a fajlnevet szinten latin1-kent dekodolja'` | `'a fajlnevet UTF-8-kent dekodolja (RFC 7578)'` | `not.toBe(filename)` + round-trip | `toBe(filename)` |

A 6. teszt (sor 314-324, "forditott sorrendu filename/name") **bent marad** a blokkban, de a **factually hibás komment** javítandó:

- Jelenlegi komment (sor 316): `A `/name="([^"]+)"/` a `filename="..."` belsejere is illeszkedik.` — **tév**: a regex a `name="` literál prefixet követeli, nem illeszkedik a `filename="..."` belsejére. Azért "működik" együtt a teszt, mert a file-ág nem használja a `fieldName`-et.
- Javítsd: `A regex a name=" prefixet koveteli, igy a filename="..."-re nem illeszkedik; a fajl-ág eldobja a fieldName-et, ezert a file.name helyes marad.`

A blokk fejléc komment (sor 256-261) frissül:
- Törlendő MD-referenciák: `multipart-boundary-greedy`, `multipart-latin1-fields`, `multipart-case-sensitive-disposition` (mindhárom javítva)
- Leírás átfogalmazás: a 4 teszt ma már helyes viselkedést rögzít, nem pedig eltérést; a 2 fennmaradó (case-insensitive + fordított sorrend) edge-case dokumentáció

**Új pozitív tesztek** a Fix 1 által lefedett, de pinning tesztek által nem gyakorolt edge-case-ekre (hogy a jövőbeni regresszió azonnal látszódjon):

| Hova | Új teszt |
|---|---|
| `parseMultipart - boundary felismerés` (sor 51 után) | `'a Boundary= parameter nevet case-insensitive modon fogadja el (RFC 2045)'`: `CT.replace('boundary=', 'Boundary=')` → field helyes |
| `parseMultipart - boundary felismerés` | `'a quoted boundary utan a trailing parametert is helyesen lezarja'`: `multipart/form-data; boundary="${BOUNDARY}"; charset=utf-8` → field helyes |
| `parseMultipart - boundary felismerés` | `'a boundary utan levo whitespace-et levagja'`: `multipart/form-data; boundary=${BOUNDARY} ` (trailing space) → field helyes |

Ezek a tesztek a jelenlegi buggy kóddal elbuknának (visszaigazolják, hogy a fix ténylegesen kezeli ezeket az eseteket).

## Files to modify

**Phase 1 commit (`fix(multipart):`):**
- `src/web/multipart.ts` — 2 sor cseréje (9-es és 11-es sor), 2 sor beszúrása (decode helper a `result` deklaráció előtt), 2 sor módosítása (31 és 36). Összesen **~6 sor diff**.
- `src/__tests__/multipart.test.ts` — 4 pinning teszt expect + cím átírása, 1 factually hibás komment javítása, blokk fejléc komment frissítése, **3 új pozitív teszt** beszúrása a `boundary felismerés` blokkba. Összesen **~30 sor diff**.

**Phase 2 commit (`docs(needs-to-be-fix):`):**
- `docs/needs-to-be-fix/INDEX.md` — 2 sor `Resolved` cellájának átállítása a fix commit SHAmásával és a workflow-futás dátumával.

Nem módosítandó hívók (változatlan szerződés):
- `src/web/routes/marveen.ts:193` — `file.data` + `extname(file.name)` (ASCII input marad ASCII, mojibake input javul)
- `src/web/routes/agents.ts:948` — ua.
- `src/web/routes/agents.ts:1916` — `file.data` + `fields.name` + `fields.overwrite` (ASCII marad ASCII, UTF-8 most már helyes)
- `src/web/routes/agents-skills.ts:79` — `file.data` + implicit `file.name`
- `src/web/routes/skills.ts:387` — ua.

Nem módosítandó tesztek (változatlan szerződés, ASCII inputok maradnak):
- A `boundary felismerés`, `szoveges mezok`, `fajl reszek`, `kihagyott reszek` describe blokkok összes tesztje (a 3 új pozitív teszt kivételével, amik a `boundary felismerés` blokkba kerülnek)
- A `forditott sorrendu filename/name` teszt (sor 314-324) a komment-javítás kivételével
- A `case-insensitive Content-Disposition` teszt (sor 307-312) változatlan

## Workflow structure (végrehajtás)

A workflow a `test/baseline` branch-en dolgozik közvetlenül, **worktree isolation nélkül** (a projekt 1-commit taskokra a `test/baseline`-en commitol, ahogy a `b5baca3`, `3d7e677`, `fffb378` is tette). Két commit lesz: egy `fix(multipart):` és egy rákövetkező `docs(needs-to-be-fix):` az INDEX.md frissítésére. Mindkettő lokális marad — **nincs `git push`** a project-szabályok miatt.

### Phase 1: Fix implementálás (1 agent, no worktree, direkt a `test/baseline`-en)
Lépések sorrendben:
1. Boundary regex csere (Fix 1) a `src/web/multipart.ts:9` sorban
2. `decodeUtf8` helper bevezetése a `result` deklaráció előtti sorban, alkalmazása `name: filenameMatch[1]` (sor 31) és `result.fields[fieldName]` (sor 36) helyén
3. 4 pinning teszt expect átállítása + cím átírása aktív korrekcióra (sor 263, 274, 280, 295) a fenti táblázat szerint
4. A 6. teszt (sor 314-324) factually hibás kommentjének javítása
5. A pinning blokk fejléc komment frissítése: 3 MD-referencia törlése, leírás átfogalmazása
6. **3 új pozitív teszt** hozzáadása a `parseMultipart - boundary felismerés` blokkhoz: uppercase `Boundary=`, combined `boundary="X"; charset=utf-8`, trailing whitespace
7. `bun test src/__tests__/multipart.test.ts` → 100% zöld
8. `bun run typecheck` → nincs új TS hiba
9. `bun run lint` → nincs új lint hiba (a project `eslint --max-warnings 0`)
10. `bun test` (teljes suite) → nem tör el más tesztet (különösen agents, marveen, skills, agents-skills route tesztek)
11. **`git status` ellenőrzés**: csak a két várt fájl legyen módosítva (`src/web/multipart.ts`, `src/__tests__/multipart.test.ts`). Ha bármi más (`.swp`, coverage artifact) is megjelent, **commit ELŐTT** tisztítandó.
12. Commit (subject + body verbatim):
    ```
    fix(multipart): stop boundary at first ; or quote, decode text + filenames as UTF-8
    
    Refs docs/needs-to-be-fix/multipart-boundary-greedy.md
    Refs docs/needs-to-be-fix/multipart-latin1-fields.md
    
    Boundary regex tightened from `boundary=(.+)` to
    `/boundary=(?:"([^"]+)"|([^;\s]+))/i`: stops at the first `;` or
    whitespace (RFC 2045 parameter terminators), strips optional
    double-quotes (RFC 2046 quoted-string), and is case-insensitive
    on the parameter name.
    
    Text fields and the upload filename are now re-decoded from
    latin1-transport to UTF-8 (RFC 7578 §5.1). Binary file data is
    unchanged (`Buffer.from(body, 'binary')` still round-trips byte-
    for-byte, verified by the 0x00-0xFF test).
    
    Documented limitations:
    - The quoted-string form does not handle RFC 2045 backslash-escapes
      inside the quotes (theoretical; wire boundaries cannot contain
      literal quotes).
    - `Buffer.toString('utf8')` substitutes U+FFFD for invalid UTF-8
      sequences (RFC 7578 mandates UTF-8, so non-conforming latin1-wire
      senders get replacement chars; accepted trade-off).
    ```
    (Tartsa a `b5baca3` formátumot: subject max ~70 char, body 72-char wrap, `Refs docs/needs-to-be-fix/<bug-id>.md` sorok.)

### Phase 2: INDEX.md frissítés (1 agent, no worktree)
Lépések:
1. A Phase 1 commit SHAmása `git rev-parse HEAD`
2. INDEX.md `## High` és `## Medium` szekciókban a `multipart-boundary-greedy` és `multipart-latin1-fields` sorok `Resolved` cellájának átállítása: `Resolved: <YYYY-MM-DD> <sha>` formátumban (a `9f47ed7` minta)
3. A dátum a workflow futás napja (NEM előre kitöltendő!)
4. `git status` ismét: csak INDEX.md legyen módosítva
5. Commit:
    ```
    docs(needs-to-be-fix): mark multipart-boundary-greedy + multipart-latin1-fields Resolved
    
    Both rows flipped to Resolved: <YYYY-MM-DD> <sha> using the fix
    commit's SHA. Per the 8d7f612 / 0391bd6 precedent, do not amend
    the source commit afterwards -- the SHA reference would drift.
    ```

### Phase 3: Kód-review duplikálás (2 agent, párhuzamos, BARRIER)
A 2 agent **külön-külön, egymástól függetlenül** értékeli a `test/baseline`-en lévő két új commitot:
- **Agent A (correctness lens)**: a fix valóban megoldja-e mindkét MD-ben leírt hibát; van-e bármilyen ASCII / bináris regresszió; a `decodeUtf8` alkalmazási pontjai helyesek-e; a `data: Buffer.from(body, 'binary')` (sor 32) érintetlen maradt-e; a 3 új pozitív teszt valóban megbukna-e a régi kóddal (regressziós bizonyíték); a 6. teszt komment-javítása tényszerűen helyes-e.
- **Agent B (RFC + edge-case + workflow lens)**: az új boundary regex kezeli-e a `boundary="X"; charset=utf-8` (combined), `Boundary=` (case-insensitive), trailing whitespace, multi-param, üres `boundary=` eseteket; a 4 pinning teszt cím-átírása konzisztens-e a `b5baca3` stílussal; az INDEX.md update SHAmása helyes-e; a commit body formátuma (Refs sorok, 72-char wrap, limitation-ok dokumentálva) megfelel-e a project precedentnek; maradt-e holt MD-referencia bármely kommentben.

Ha bármelyik agent `real=true` jelzést ad, **a workflow leáll** és jelzi a usernek, hogy kézi javítás szükséges (a fix commitot NEM szabad utólag amend-elni a SHA-drift elkerülésére — ehelyett újabb fix commit javítja, és az INDEX.md frissítés egy újabb `docs(needs-to-be-fix): fix Resolved SHA reference after amend` commit, a `8d7f612` / `0391bd6` precedent alapján).

### Phase 4: `/code-review max --fix` skill
A workflow végén az user indítja a `/code-review max --fix` skillt a véglegesített két commit-ra. Ez a skill a saját review-protokollját futtatja (mélység=max), és ha talál, automatikusan javítja — ha javít, a Phase 3-ban leírt SHA-drift protokollt kell követni.

### Branch stratégia
- **Nincs külön branch** — közvetlenül a `test/baseline`-en dolgozunk (a project 1-commit fixeknél így jár el)
- 2 lokális commit: `fix(multipart):` + `docs(needs-to-be-fix):`
- **Nincs `git push`** sem origin-re, sem máshova
- Ha bármelyik commit javítást igényel a review után: új commit (NEM amend), és az INDEX.md-t külön `fix Resolved SHA reference after amend` committal frissíteni

## Verification (végrehajtás után)

Phase 1 commit landolása után:
- `bun test src/__tests__/multipart.test.ts` → minden teszt zöld, beleértve a 4 átállított pinning tesztet + a 3 új pozitív boundary tesztet
- `bun run typecheck` → nincs új TS hiba (strict mode megtartva)
- `bun run lint` → nincs új lint warning/error (a `eslint --max-warnings 0` miatt strict)
- `bun test` (teljes suite) → nincs ASCII regresszió más route-ok tesztjeiben (különösen: agents.test, marveen.test, skills.test, agents-skills.test)
- `git status --porcelain` a commit ELŐTT: csak `src/web/multipart.ts` és `src/__tests__/multipart.test.ts` legyen a `M` státuszban, minden más `??` (untracked) kategóriájú legyen. Bármi más `M`/`A`/`D` commit ELŐTTI tisztítása kötelező.
- `git show HEAD --stat` a commit után: 2 fájl, kumulatív diff < 50 sor (a projekt minimal-diff fegyelme, `b5baca3` 5/5, ez várhatóan 6+30 = 36 sor).

Phase 2 commit landolása után:
- `git status --porcelain` a commit ELŐTT: csak `docs/needs-to-be-fix/INDEX.md` legyen módosítva
- `git show HEAD --stat` a commit után: 1 fájl, 2 sor módosítva (`Resolved` cellák)
- INDEX.md render-ellenőrzés: a táblázat oszlop-szélessége nem csúszik el (a `Resolved` cella hossza: `Resolved: 2026-08-20 <40-char-sha>` = ~58 char, ami belefér a jelenlegi cella-szélességbe)

Végső ellenőrzés (mindkét commit után):
- `git log --oneline test/baseline -5` → az utolsó 2 commit a mienk, a sorrend helyes (fix előbb, docs utána)
- `git log --oneline -1 HEAD~1` SHA-ja megegyezik az INDEX.md `Resolved` cellájában lévő SHAmással (referencia-integritás)

## Kockázatelemzés (2 független Plan reviewer által elfogadott és kiegészített)

- **Bináris regresszió**: kizárt, mert `Buffer.from(body, 'binary')` (sor 32) nem változik, és a `0x00-0xFF` teszt (sor 179-189) ezt pontosan ellenőrzi.
- **ASCII regresszió**: kizárt, mert `Buffer.from(s, 'binary').toString('utf8')` ASCII inputra byte-for-byte noop (U+0000-U+007F tartomány).
- **Invalid UTF-8 input**: elfogadott trade-off — a `Buffer.toString('utf8')` invalid szekvenciára U+FFFD-t szubstitúál. Az RFC 7578 §5.1 UTF-8-at ír elő, így a helyes küldők sosem érintettek. A latin1-wire-bytes küldők (RFC-sértők) jelenlegi "decoded as latin1" viselkedése megszűnik → U+FFFD. **Dokumentálva a commit body-ban.**
- **Boundary edge-case**: a regex mind az 5 formátumot (quoted, unquoted, unquoted+param, case-insensitive, trailing whitespace) explicit kezeli. A 3 új pozitív teszt lock-in-eli ezeket. Üres `boundary=` a jelenlegi `{}` visszatérést adja.
- **RFC 2045 escaped-quote a quoted-string belsejében**: nem támogatott (`boundary="a\"b"`-t `a\` -ként olvasná). **Elméleti határ** — a wire-on boundary delimiterként nem jelenhet meg idézőjel (különben megsértené az egyediségét), így a gyakorlatban nem fordul elő. **Dokumentálva a commit body-ban.**
- **Hívói szerződés**: egyik callsite sem változtatja meg a várt típust (mindenhol `file.data: Buffer` és `file.name/fields.X: string`). A string-ek tartalma a hibás esetekben javul (mojibake → helyes), a helyes esetekben változatlan.
- **Teszt-pinning**: a 4 pinning teszt célzottan dokumentálja a hibát; átállításuk + cím-átírásuk a fix természetes velejárója (a `b5baca3` commit ugyanígy járt el).
- **Teszt 6 comment pontatlanság**: a jelenlegi komment factually téves (a regex NEM illeszkedik a `filename="..."` belsejére). A javítás a komment tényszerű átfogalmazása, a teszt kódja változatlan.
- **Push kockázat**: nincs, mert a workflow nem tartalmaz `git push` lépést (a project szabály tiltja).
- **SHA-drift kockázat**: ha a Phase 3 review a fix commit javítását javasolja, az INDEX.md-ben lévő SHA referencia elcsúszik. A `8d7f612` / `0391bd6` precedent alapján ez NEM amend-del, hanem újabb `docs(needs-to-be-fix): fix Resolved SHA reference after amend` committal orvosolható.

## Dupla terv-ellenőrzés (LEZÁRVA)

A tervet **2 független Plan subagent** értékelte párhuzamosan, egymástól független structured output-tal. Mindkettő `needs_revision` verdiktet adott, de **egyik sem talált kritikus (correctness / regression) hibát** — csak workflow-finomítást, scope-bővítést és stílus-kiegészítést javasolt.

**Agent A (correctness lens) — 6 minor issue, mind átvezetve vagy elvetve:**
- ✅ Test 6 comment correction (átvezetve a Phase 1 teszt-lépésekbe)
- ✅ 3 új pozitív teszt uppercase + combined form edge-case-ekre (átvezetve)
- ✅ `bun run lint` hozzáadva a verification gate-ekhez (átvezetve)
- ❌ UTF-8 fallback invalid byte-okra (elvetve: overengineering, ellentmond a MD-nek; commit body-ban dokumentálva mint trade-off)
- ❌ Full RFC quoted-string backslash-escape (elvetve: elméleti; commit body-ban dokumentálva mint limitation)
- ❌ Split 2 commitba (elvetve: a user explicit kérte az összevonást)

**Agent B (RFC + edge-case + workflow lens) — 4 major + 3 minor issue, mind átvezetve:**
- ✅ INDEX.md külön `docs(needs-to-be-fix):` commit (átvezetve: Phase 2 önálló fázis, `9f47ed7` / `537b374` mintával)
- ✅ Worktree isolation elhagyva (átvezetve: project 1-commit fixeknél direkt a `test/baseline`-en dolgozik)
- ✅ Commit message body verbatim (átvezetve: Phase 1 lépés 12)
- ⚠️ Phase 2 (dupla review) megtartva (a user explicit kérte a "Terv + kód review is duplán"-t)
- ✅ `git status` lépés a commit ELŐTT (átvezetve: Phase 1 lépés 11, Phase 2 lépés 4)
- ✅ Teszt title-rewrite pattern (átvezetve: táblázat bővítve a "Jelenlegi cím" és "Új cím" oszlopokkal, `b5baca3` aktív-korrekció stílus)
- ✅ Quoted-string backslash-escape limitation (átvezetve: commit body dokumentálja)

A terv a fenti javításokkal konzisztens. Újabb reviewer-pass nem szükséges — a következő ellenőrzési pont a Phase 3 (post-implementation) dupla review.

---

## Terv összefoglaló (ExitPlanMode-hoz)

**Cél**: két silent corruption bug (`multipart-boundary-greedy` + `multipart-latin1-fields`) javítása `src/web/multipart.ts`-ben minimális, lokális diff-fel.

**Változtatott fájlok** (2 commit, mindkettő lokális, nincs push):
- Phase 1: `fix(multipart):` — `src/web/multipart.ts` (~6 sor) + `src/__tests__/multipart.test.ts` (~30 sor)
- Phase 2: `docs(needs-to-be-fix):` — `docs/needs-to-be-fix/INDEX.md` (2 sor)

**Dupla review** (mindkettő a user kérésére):
- Terv: 2 független Plan agent (LEZÁRVA, `needs_revision` → minden hasznos javítás átvezetve)
- Kód: Phase 3-ban, 2 független review agent a véglegesített commitokon

**Végső lépés**: `/code-review max --fix` skill a user által, mindkét commit landolása után.

A terv kész a review-ra.
