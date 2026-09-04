# Plan: message-router dokszi cleanup (smallest scope)

## Context

A user a "legkisebb" (smallest) módosítást kérte, ami lehetséges bukással járó needs-fix
elemet céloz. A current HEAD `d296e06` branch `test/baseline` állapotában 3 message-router
dokumentum koherenciahibát tartalmaz (2 subagent által verifikálva, 2026-08-24):

- `docs/needs-to-be-fix/INDEX.md` sor 132 és 133 a két "Partially resolved" sort jelöli
  meg `2026-08-19 ba6faf8` dátummal, de a file-level branch coverage valójában 97.82%
  (3 `??` arm a message-router.ts 481-483 sorokban UNRESOLVED). Az MD footerek
  (`d14754d` óta) tartalmazzák ezt a qualifier-t, de az INDEX sorok nem — ez a
  "Partially resolved" label félrevezető. Subagent 2 finding: row 132-ban a
  "line 180 deferred as stylistic inversion" qualifier-t is meg kell őrizni.

- `src/__tests__/message-router-full.test.ts:1191` labelje azt írja, hogy "falls back
  to a direct sessionExistsOnHost when the receiver is not in the cache", de a test
  body az ellenkezőjét bizonyítja: a cache lookup mindig nyer, a session absent,
  `sendPromptToSession` NEM hívódik. Egy korábbi rename (8209fb3 → f67efca) revertálva
  lett, amikor a source-side option (a) `eb9b951` is revertálódott `2ec1c99`-ben.
  A `d14754d` MD megerősíti: "The body is correct under either label".
  Subagent 1 finding: a suite "does NOT" imperatívusz-mintát követi (lásd sor 1222).

- `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` 84-96. sorában
  a "Pinning test" szekció szó szerint idézi a régi labelt ("label still reads").
  Subagent 1 finding: a test átnevezése után ez a "label still reads" állítás
  hamissá válik — ezt a MD-t is frissíteni kell.

- `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` body-jában a
  `## Status: PARTIAL -- 2026-08-18` szekció szándékos history record (line 3:
  "The narrative below is preserved as the historical record of option (a)").
  Nem nyúlunk hozzá.

Cél: a fenti 3 koherenciahibát kijavítani a lehető legkisebb módon — 0 source
módosítás, 0 új teszt, csak 2 INDEX.md sor + 1 test label string + 1 MD paragraph
update a cache-fallback "Pinning test" szekcióban. A `message-router.ts` módosítása
a project "NEVER modify src/web/message-router.ts" szabálya miatt tiltott, és a
user ezt a scope-ot most nem kérte.

## Változtatások (1 commit)

### 1. `docs/needs-to-be-fix/INDEX.md` — sor 132, 133

**Jelenlegi (sor 132):**
```
| `message-router-dead-defensive-branches` | message-router.ts: three dead defensive branches block 100% branch coverage | Partially resolved: 2026-08-19 ba6faf8 |
```

**Jelenlegi (sor 133):**
```
| `message-router-unreachable-defensive-branches` | message-router.ts: four unreachable defensive branches block 100% branch coverage | Partially resolved: 2026-08-19 ba6faf8 |
```

**Új (sor 132) — a "Partial:" label és a line-180 qualifier egyaránt megmarad:**
```
| `message-router-dead-defensive-branches` | message-router.ts: three dead defensive branches block 100% branch coverage | Partial: 2026-08-19 ba6faf8 deleted 2 dead arms (line 180 kept as stylistic inversion); file-level UNRESOLVED at 97.82% (3 `??` arms at lines 481-483) -- see message-router-cache-fallback-unreachable.md |
```

**Új (sor 133) — rövidebb, mert nincs line-180 dilemma:**
```
| `message-router-unreachable-defensive-branches` | message-router.ts: four unreachable defensive branches block 100% branch coverage | Partial: 2026-08-19 ba6faf8 deleted 2 dead arms; UNRESOLVED on lines 481-483 -- see message-router-cache-fallback-unreachable.md |
```

A "Partial:" label egyértelműsíti, hogy csak egy rész van megoldva (a user
panasza: "Partially resolved oversells the state"). A dead-defensive MD line 180-át
(stampTraceOnMessage invert) a `d14754d` óta "deferred as stylistic inversion"
minősítéssel — ezt a qualifier-t subagent 2 findingja miatt megtartjuk.

### 2. `src/__tests__/message-router-full.test.ts` — sor 1191

**Jelenlegi:**
```ts
  it('falls back to a direct sessionExistsOnHost when the receiver is not in the cache', async () => {
```

**Új (subagent 1 javaslata, a suite "does NOT" imperatívusz-mintát követi):**
```ts
  it('does NOT send when the cached sessionExists is false', async () => {
```

A label most a test body **elsődleges assertion-jét** írja le:
`expect(H.sendPromptToSession).not.toHaveBeenCalled()`. A subagent 1 megerősítette:
- Faktum-szerűen pontos (a test body bizonyítja).
- Em-dash mentes.
- Nincs külső grep-referencia a régi labelre (csak 2 helyen: a test 1191 + cache-fallback MD 85-86).
- A suite naming convention-jával konzisztens (lásd 1222. sor: `'does NOT stamp a trace on a channel-inbound message'`).

### 3. `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` — sor 83-96 (Pinning test szekció)

Subagent 1 findingja: a 85-86. sor szó szerint idézi a régi labelt, és a "label still reads"
állítás a 84. sorban hamissá válik az átnevezés után. Az MD-t frissíteni kell, hogy az új
labelt idézze.

**Jelenlegi (sor 83-96):**
```
`src/__tests__/message-router-full.test.ts:1191` is the
`describe('runMessageRouterTick')` pinning test whose label still reads
`'falls back to a direct sessionExistsOnHost when the receiver is not
in the cache'`. The label was renamed once (2026-08-18, 8209fb3) to
`'reads session existence directly from the pre-pass cache (no ?? fallback)'`
but the rename was reverted in `f67efca` after the source-side option (a)
it documented (`eb9b951`) was itself reverted in `2ec1c99`. The test BODY
(lines 1192-1219) remains the canonical pinning test for the cache-wins
path: the mock makes `sessionExistsOnHost` return absent on the first
call and present on subsequent calls, then the assertion that
`sendPromptToSession` is NOT called and `logWarn` fires with the "target
session not running, will retry" payload confirms the cache always wins.
The body is correct under either label; the gap between label intent and
actual source state is preserved here as the historical record.
```

**Új (sor 83-96):**
```
`src/__tests__/message-router-full.test.ts:1191` is the
`describe('runMessageRouterTick')` pinning test whose label was renamed
on 2026-08-24 (this batch) to
`'does NOT send when the cached sessionExists is false'`. The previous
label, `'falls back to a direct sessionExistsOnHost when the receiver is
not in the cache'`, described the intent of the unreachable `??` fallback
arms and the test BODY's first assertion is the opposite; the new label
describes the actual behavior. An earlier rename (2026-08-18, 8209fb3)
to `'reads session existence directly from the pre-pass cache (no ?? fallback)'`
was reverted in `f67efca` after the source-side option (a) it documented
(`eb9b951`) was itself reverted in `2ec1c99`. The test BODY
(lines 1192-1219) remains the canonical pinning test for the cache-wins
path: the mock makes `sessionExistsOnHost` return absent on the first
call and present on subsequent calls, then the assertion that
`sendPromptToSession` is NOT called and `logWarn` fires with the "target
session not running, will retry" payload confirms the cache always wins.
```

A Pinning test szekció most 3 állapotot dokumentál time-line-ban:
1. Eredeti label (intent of unreachable code).
2. 8209fb3 átnevezés (revertálva f67efca-ban, mert a source-side opciót revertálták).
3. 2026-08-24 átnevezés (most alkalmazandó) — az új label a tényleges viselkedést írja le.

A "label still reads" kifejezés lecserélődik "label was renamed on 2026-08-24 to"-ra, ami
az új labelt hitelesen dokumentálja.

## Nem módosítjuk

- `src/web/message-router.ts` — `NEVER modify` szabály.
- `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` body —
  a `## Status: PARTIAL -- 2026-08-18` szekció szándékos history record, és
  a top header már `Status: UNRESOLVED` (a `d14754d` óta). **DE** a "Pinning test"
  szekciót (sor 83-96) frissítjük, lásd fent 3. pont.
- A két "Partially resolved" MD fájl footerje — `d14754d` már tartalmazza a
  qualifier-t; nem kell duplikálni.
- INDEX.md count assertion (line 3: "Total count: 177") — nem változik, mert nem
  törlünk / adunk hozzá MD-t.
- Táblázat oszlopszélessége — a hosszabb cella kitölti a meglévő harmadik oszlopot,
  a markdown table rendering nem törödik azzal hogy a pipe-ok ne legyenek pontosan
  egymás alatt. (Az addenda szekcióban van 250+ karakteres cella is — kozmetikailag
  konzisztens.)

## Kockázat / lehetséges bukás

| Bukás | Valószínűség | Hatás | Mitigáció |
|-------|--------------|-------|-----------|
| INDEX.md table layout eltörik | alacsony | A markdown táblázat nehezen olvasható lesz | Subagent 2 már verifikálta: a 144 karakteres cella OK, az addenda szekcióban van 250+ karakteres is |
| Test label em-dash-t tartalmaz (U+2014) | 0 | CLAUDE.md szabály sérül | Subagent 1 verifikálta: a label pure ASCII + backtick, nincs U+2014 |
| Más test/docs hivatkozik a régi label-re | alacsony | Törött referencia | Subagent 1 verifikálta: csak 2 helyen volt (test 1191 + cache-fallback MD 85-86); a cache-fallback MD-t is frissítjük, így 0 törött referencia marad |
| A "2 dead arms" qualifier pontatlan | alacsony | Félrevezető docs | A `ba6faf8` commit törölte a line 81, 317 sorokat (2 arm). A line 180-at `e0fb73d` invertálta, de az MD "stylistic inversion" minősítést adott neki — a "kept as stylistic inversion" qualifier ezt tükrözi |
| Vitest fail a rename miatt | nagyon alacsony | A test nem fut le | Body unchanged, label nem befolyásolja a futást |
| Count assertion elromlik | 0 | "Total count: 177" nem teljesül | 0 MD hozzáadva/törölve, így a count nem változik |
| Cache-fallback MD Pinning test szekció szövege eltér a forrástól | alacsony | A MD nem felel meg a valóságnak | Az MD body-ját átmásoljuk a `d14754d` véglegesített szövegéből (már ott van a 8209fb3 / f67efca / 2ec1c99 ciklus), és hozzáfűzzük a 2026-08-24 átnevezést |

## Végrehajtás (execution plan)

**Branch:** `test/baseline` (current branch, current HEAD `d296e06`).
**Indulópont:** `test/baseline` HEAD.
**Visszavezetés:** ugyanide, lokálisan (nincs push — push kizárólag a useré).

### Fázis 1 — Dry-run / dupla ellenőrzés (MÁR megtörtént plan módban)

A 2 subagent ellenőrzés a **plan módban** már lefutott, 2026-08-24:

- **Subagent 1 (INDEX.md edit verify)**: PROCEED WITH CHANGES. Megerősítette:
  - A javasolt szöveg (`Partial: 2026-08-19 ba6faf8 deleted 2 dead arms (line 180 kept as stylistic inversion); file-level UNRESOLVED at 97.82% (3 `??` arms at lines 481-483) -- see message-router-cache-fallback-unreachable.md`) faktum-szerűen pontos.
  - Em-dash mentes (a pre-existing em-dash-ok az INDEX.md 67/143/145/180/219 soraiban vannak, ezeket nem módosítjuk).
  - Count assertion sértetlen (177 MD megmarad).
  - 144 karakteres cella OK (van 250+ karakteres is az addenda szekcióban).
  - Más "Partially resolved" sor nincs (a cluster teljes, 3 sor).
  - **Finding**: row 132-ban a "line 180 deferred as stylistic inversion" qualifier-t meg kell tartani → ez beépült a tervbe.

- **Subagent 2 (Test rename + cache-fallback MD verify)**: PROCEED WITH CHANGES. Megerősítette:
  - Az új label `'does NOT send when the cached sessionExists is false'` faktum-szerűen pontos.
  - Em-dash mentes.
  - Nincs külső grep-referencia a régi labelre (csak 2 helyen volt: test 1191 + cache-fallback MD 85-86).
  - A suite "does NOT" imperatívusz-mintát követi (lásd sor 1222).
  - **Finding**: a cache-fallback MD 85-86. sora szó szerint idézi a régi labelt, és a "label still reads" állítás hamissá válik az átnevezés után → a cache-fallback MD "Pinning test" szekcióját is frissíteni kell → ez beépült a tervbe 3. pontként.

A dry-run eredménye: **mindkét subagent PROCEED WITH CHANGES**-t javasolt, így a terv
kész a végrehajtásra. A végrehajtáskor újabb subagent indítása nem szükséges (a
verification a plan módban megtörtént); Fázis 1 itt csak a terv-koherencia
dokumentálására szolgál.

Ha a felhasználó mégis szeretne egy végrehajtás előtti re-verification-t, az
**Agent tool** `isolation: worktree`-vel történjen (NEM Workflow tool — a Honcho
szabály 3/3 parse error esetet dokumentál).

### Fázis 2 — Alkalmazás (1 commit, main checkout-ban)

1. Edit `docs/needs-to-be-fix/INDEX.md` (sor 132, 133) a javasolt új szövegre.
2. Edit `src/__tests__/message-router-full.test.ts` (sor 1191) a javasolt új label-re.
3. Edit `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md`
   (sor 83-96, "Pinning test" szekció) a javasolt új szövegre.
4. `git add` mindhárom fájlt.
5. Commit message:
   ```
   docs(message-router): clarify 2 partially-resolved INDEX rows + rename 1191 pinning test

   - docs/needs-to-be-fix/INDEX.md rows 132, 133: replace "Partially resolved"
     with "Partial: ... deleted 2 dead arms (line 180 kept as stylistic
     inversion); file-level UNRESOLVED at 97.82% (3 `??` arms at lines 481-483)
     -- see message-router-cache-fallback-unreachable.md". The footer
     clarifier was already added in d14754d to the MD files themselves;
     the INDEX rows were missed. Closes the coherence gap between INDEX
     and the MD footers.
   - src/__tests__/message-router-full.test.ts:1191: rename
     'falls back to a direct sessionExistsOnHost when the receiver is not
     in the cache' to 'does NOT send when the cached sessionExists is
     false'. The test BODY is correct under either label (d14754d MD
     confirms); the new label names the primary assertion (sendPrompt
     NOT called) and matches the suite's "does NOT" imperative pattern
     (line 1222 precedent).
   - docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md
     "Pinning test" section (line 83-96): update the "label still reads"
     quote from the old label to the new label, and document the 2026-08-24
     rename as a third entry in the time-line alongside the 8209fb3 /
     f67efca cycle. The test BODY description (lines 1192-1219) is
     preserved verbatim.
   ```
6. `git commit` (a user nem pushol, ez lokális marad).

### Fázis 3 — Verification (worktree-isolated, a CLAUDE.md szabály 8 szerint)

A vitest futtatás előtt a worktree-t ellenőrizni kell (`ls store/`). Ha nem
üres, automatikusan tiszta temp worktree:

```
git worktree add --detach /tmp/claw-msg-router-docs d296e06
ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-msg-router-docs/node_modules
cd /tmp/claw-msg-router-docs
# cherry-pick a commitot
git cherry-pick <SHA>
bun --bun vitest run src/__tests__/message-router-full.test.ts
```

Ha a vitest >5 fail-t talál, fuss a `a330462` baseline-on is (CLAUDE.md szabály 8
második fele), és hasonlítsd össze.

### Fázis 4 — Code review (USER invokes)

A `/code-review max --fix` skill `disable-model-invocation` flag-gel rendelkezik.
**A user fogja manuálisan indítani a terminálban.** A terv nem hívja a Skill tool-t.

A user parancsa lesz:
```
/code-review max --fix <SHA>..HEAD
```

A review által javasolt fixek (ha vannak) worktree-isoláltan készülnek, és
`git merge --ff-only <SHA>`-val kerülnek vissza a `test/baseline` branch-re
(NEM `git reset --hard` — Honcho memory tiltja).

## Verification (hogyan ellenőrizzük a végén)

1. `git log -1 --format='%H %s'` — a commit message a fenti.
2. `git diff HEAD~1 -- docs/needs-to-be-fix/INDEX.md` — a 2 sor módosult
   (sor 132, 133).
3. `git diff HEAD~1 -- src/__tests__/message-router-full.test.ts` — csak a
   label string változott, a body nem.
4. `git diff HEAD~1 -- docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md`
   — a "Pinning test" szekció (sor 83-96) frissült, más nem.
5. `grep -nP '[\x{2014}]' docs/needs-to-be-fix/INDEX.md src/__tests__/message-router-full.test.ts docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` — üres output (a pre-existing em-dashes az INDEX.md más soraiban vannak, 67/143/145/180/219, ezeket NEM módosítjuk a "Surgical Changes" szabály miatt).
6. `bun --bun vitest run src/__tests__/message-router-full.test.ts` — a 1191 sor
   test új label-lel is PASS.
7. A 177 count assertion sértetlen: `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l` = 177.

## Commit history impact

A `test/baseline` branch új commitlistája a végén (lokálisan, nincs push):

```
d296e06 chore(comment+index): code-review fixes on top of 51b4afe   (current HEAD)
<NEW>    docs(message-router): clarify 2 partially-resolved INDEX rows + rename 1191 pinning test
<review-fix> (opcionális, ha a code-review talál valamit)
```

A jelenlegi 21+ local commit megmarad, az új commit csak egy +1 a sorban.
