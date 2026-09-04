# Cycle 30 — research.ts basename + keychain ACL batch

## Context

A `test/baseline` branch 79 nyitott needs-fix itemet tart. A user a következő ciklust két XS-S módosításra szűkítette, amelyek közül az egyik egy ismert, bizonyított mintát követ (research.ts basename, a cycle 25-ös `e4ec60b` tükörképe), a másik egy 1-karakteres biztonsági javítás (keychain `-A` ACL).

Cél: 2 needs-fix item lezárása, minimális surface area, typecheck delta ≤+5, tesztek 100% zöld, push a useré.

## Branch

- **Indulás:** `test/baseline` @ `1733edc` (working tree clean)
- **Visszatérés:** `test/baseline` (commit stack hozzáfűzve, push nélkül)
- **Nincs worktree-elkülönítés** — közvetlen commit a branchre, a prior ciklusok konvenciója szerint

---

## Sub-batch 1: `routes-research-basename-redundant`

### Állapot
- Nincs MD fájl (a routes-docs testvér MD-je a `routes-docs-basename-redundant.md`, `e4ec60b`-bal resolved).
- Forrás: `src/web/routes/research.ts`
  - **Line 2:** `import { join, basename } from 'node:path'` — `basename` CSAK itt van használva (line 63-on).
  - **Line 12:** `const NAME_RE = /^[A-Za-z0-9._-]+\.md$/` — ugyanaz a karakterosztály-allowlist, mint a `routes/docs.ts`-ben.
  - **Line 63:** `if (!NAME_RE.test(name) || basename(name) !== name)` — a második diszjunkton sosem futhat le, mert `NAME_RE` kizárja a `/` és `\` karaktereket, így `basename(name) === name` mindig.
- A `tryHandleResearch` függvény a `routes/docs.ts` pontos tükörképe a research útvonalon.

### Lépések

1. **MD fájl létrehozása** — `docs/needs-to-be-fix/routes-research-basename-redundant.md`
   - Másolat a `routes-docs-basename-redundant.md`-ről, lokális átnevezéssel
   - Hivatkozás a testvér MD-re: "Same pattern as routes-docs-basename-redundant (resolved 2026-08-18 e4ec60b)"
   - Failure scenario: coverage-only defect, no runtime misbehaviour
   - Suggested direction (a): drop the disjunct + drop basename import

2. **Tesztek feltérképezése** — `src/__tests__/routes-research*.test.ts` (vagy hasonló)
   - Keresés pinning tesztre: `basename`, `vi.mock('node:path')`, "Invalid file name" szövegre
   - Ha van pinning teszt a basename override-hoz, a törlés után törölni kell (a cycle 25-ös mintát követve: `5fc28eb test(routes-docs): drop unused vi.mock('node:path') scaffolding`)

3. **Forrás fix** — `src/web/routes/research.ts`
   - Line 63: `if (!NAME_RE.test(name) || basename(name) !== name)` → `if (!NAME_RE.test(name))`
   - Line 2: `import { join, basename } from 'node:path'` → `import { join } from 'node:path'`
   - Net diff: -2 sor

4. **Ha pinning teszt volt** — drop + commit külön

5. **Verifikáció**
   - `bun run typecheck` → 1701 hiba maradjon (delta 0)
   - `bun test src/__tests__/routes-research*.test.ts` → zöld
   - `bun run coverage` ha a routes-research.ts coverage gate alatt volt, nézzük meg, hogy javult-e

6. **Commit stack (3 commit, ha volt pinning teszt; 2 ha nem)**
   - `fix(routes-research): drop redundant basename check at research.ts:63`
   - `test(routes-research): drop obsolete basename pinning test` (ha volt)
   - `docs(needs-to-be-fix): mark routes-research-basename-redundant resolved`

7. **INDEX.md frissítés**
   - Új sor beszúrása a "Baseline unreachable addenda" vagy "Orphan addenda" szekcióba
   - Status: `Resolved: 2026-08-18 <SHA>`

### Failure mode
- **Ha TS6133-at ad a basename import dropja előtt** (nem kell, mert a drop és az import egy commitban van).
- **Ha pinning teszt törik** — a tesztet is törölni kell, de a delete + flip mintát már a cycle 25 (`9655666 test(routes-docs): drop obsolete basename pinning test` + `5fc28eb test(routes-docs): drop unused vi.mock('node:path') scaffolding`) sikeresen alkalmazta.
- **Ha coverage romlik** — nem fog, mert a cycle 25 óta a coverage gate a `routes/docs.ts` removal-t elfogadta.

### Critical files
- `src/web/routes/research.ts` (fix)
- `docs/needs-to-be-fix/routes-research-basename-redundant.md` (új)
- `docs/needs-to-be-fix/INDEX.md` (frissítés)
- `src/__tests__/routes-research*.test.ts` (felderítés + esetleges törlés)

---

## Sub-batch 2: `keychain-store-insecure-acl`

### Állapot
- MD fájl LÉTEZIK (`keychain-store-insecure-acl`, status `—`).
- Forrás: `src/web/keychain.ts:25-34`
  ```ts
  export function keychainStore(value: string): void {
    execFileSync(SECURITY, [
      'add-generic-password',
      '-U',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w', value,
      '-A',
    ], { stdio: ['ignore', 'ignore', 'ignore'] })
  }
  ```
- A `'-A'` flag a `security add-generic-password` parancsban **az app-accessible ACL-t üresre állítja** (bármely alkalmazás olvashatja a master key-t). Az alapértelmezett ACL (a flag nélkül) **csak a jelenlegi felhasználót** engedi.

### Lépések

1. **MD ellenőrzés** — `docs/needs-to-be-fix/keychain-store-insecure-acl.md` meglétének és tartalmának verifikálása
   - Ha hiányzik: pótolni a fenti leírással
   - Ha megvan: a leírt fix irányával összhangban haladni

2. **Tesztek feltérképezése** — `src/__tests__/keychain*.test.ts` és bármely más, ami `keychainStore`-t hívja
   - Keresés pinning tesztre: `'-A'`, `acl`, `app-accessible`, "any app", `execFileSync mock`
   - Ha mockolva van az `execFileSync`, a mockolt args array-t kell frissíteni
   - Ha integrációs teszt (valódi `security` hívás), macOS-only, CI-n nem fut — ellenőrizni, hogy a teszt hogyan viselkedik

3. **Forrás fix** — `src/web/keychain.ts:25-34`
   - Törölni a `'-A',` sort az args array-ből (line ~32)
   - Net diff: -1 sor

4. **Ha pinning teszt volt** — flip + commit külön
   - Mockolt teszt args: az új expected args-ból kikerül a `'-A'`
   - Ha komment hivatkozik az ACL-re, frissíteni

5. **Verifikáció**
   - `bun run typecheck` → 1701 maradjon (delta 0; a `-A` törlése nem érint típust)
   - `bun test src/__tests__/keychain*.test.ts` → zöld
   - Ha van coverage gate a `keychain.ts`-n, ellenőrizni

6. **Commit stack (2-3 commit)**
   - `fix(keychain): drop -A flag to apply restrictive ACL on master key`
   - `test(keychain): flip ACL assertion to expect restrictive default` (ha volt pinning teszt)
   - `docs(needs-to-be-fix): mark keychain-store-insecure-acl resolved`

7. **INDEX.md frissítés**
   - A `keychain-store-insecure-acl` sor státusza: `Resolved: 2026-08-18 <SHA>`

### Failure mode
- **Ha pinning teszt a `'-A'` flag jelenlétét ellenőrzi** — a tesztet frissíteni kell (az új elvárás: `'-A'` NEM szerepel az args-ban). Ez a várható bukás — a teszt most a rossz (insecure) viselkedést pinned-ja.
- **Ha integrációs teszt** — macOS-only, a CI Linuxon nem futtatja, így nem töri el a buildet. De lokálisan futtatva a `-A` nélküli `security add-generic-password` más eredményt adhat, ha a keychain prompt-ot dob (interactive prompt). A `stdio: ['ignore', 'ignore', 'ignore']` miatt ez várhatóan nem gond.
- **Ha bármely kód a `keychainRetrieve` után `keychainStore`-t hív** → a `keychainRetrieve` a `-A` nélküli ACL-lel létrehozott key-t a default user-only ACL-lel olvassa (saját maga), így nincs regresszió.
- **Ha vault.ts vagy más consumer eltérő key-t olvas** — kockázat: ha egy másik, korábban `-A`-val létrehozott keychain-bejegyzés van a rendszeren, az új `keychainStore` hívás felülírja, de az új ACL user-only. Ez a kívánt biztonsági javítás.

### Critical files
- `src/web/keychain.ts` (fix)
- `docs/needs-to-be-fix/keychain-store-insecure-acl.md` (verifikálás / pótlás)
- `docs/needs-to-be-fix/INDEX.md` (frissítés)
- `src/__tests__/keychain*.test.ts` (felderítés + esetleges flip)

---

## Workflow struktúra

A user kérésére workflow-val hajtjuk végre. A workflow az aktuális branchről indul és ide tér vissza:

```js
export const meta = {
  name: 'cycle-30-research-keychain-batch',
  description: 'Cycle 30: research.ts basename + keychain ACL batch on test/baseline',
  phases: [
    { title: 'research.ts scan' },     // tesztek + lefedettség feltérképezése
    { title: 'research.ts fix' },      // forrás + teszt + MD + INDEX
    { title: 'keychain scan' },        // tesztek + lefedettség feltérképezése
    { title: 'keychain fix' },         // forrás + teszt + MD + INDEX
    { title: 'code-review xhigh' },    // /code-review xhigh --fix skill
    { title: 'final verification' },  // typecheck + test + diff review
  ],
}
```

A workflow-nak tartalmaznia kell:
- **Subagent típus:** `general-purpose` (olvasás + edit + commit a sub-batch-en belül)
- **Maximális párhuzamosság:** 2 (a user konvenciója)
- **Code-review skill:** a végén, a user kérésére kötelező (`/code-review xhigh --fix`)

A workflow részletei:
1. **research.ts scan phase** — 1 subagent: `src/__tests__/routes-research*.test.ts` + coverage gate olvasás, kimenet: lista a törölendő/flip-elendő tesztekről
2. **research.ts fix phase** — 1 subagent: MD create + forrás fix + teszt törlés/flip + 3 commit + INDEX update. Commit üzenetek előre meghatározottak.
3. **keychain scan phase** — 1 subagent: `src/__tests__/keychain*.test.ts` + execFileSync mock-ok felderítése, kimenet: pinning tesztek listája
4. **keychain fix phase** — 1 subagent: forrás fix + teszt flip + 2-3 commit + INDEX update
5. **code-review phase** — Skill tool hívás `/code-review xhigh --fix` (a user konvenciója)
6. **final verification phase** — typecheck count + test pass + diff summary, push nélkül

---

## Push policy

A user kizárólagos joga a push. A workflow commitol, de nem pushol. A végén a user kap egy összefoglalót a commit stackről, és ő dönt a push-ról. A CI parity verifikáció a user kérése alapján külön ciklus.

## Verification (end-to-end)

```bash
# typecheck (baseline 1701, delta ≤+5)
bun run typecheck 2>&1 | grep -c "error TS"   # expect: 1701

# test suite (no failures, no skips in changed files)
bun test src/__tests__/routes-research*.test.ts
bun test src/__tests__/keychain*.test.ts

# git state
git log --oneline -10   # expect: 5-6 új commit, working tree clean
git status              # expect: clean

# diff review
git diff 1733edc..HEAD --stat
# expect: src/web/routes/research.ts (~-2 sor)
#         src/__tests__/routes-research*.test.ts (0 vagy -néhány sor, ha volt pinning)
#         src/web/keychain.ts (-1 sor)
#         docs/needs-to-be-fix/routes-research-basename-redundant.md (+50-80 sor, új)
#         docs/needs-to-be-fix/INDEX.md (1-2 sor frissítés)
```

## Success criteria

- [ ] research.ts: `basename(name) !== name` törölve + `basename` import törölve
- [ ] keychain.ts: `'-A'` flag törölve az args array-ből
- [ ] Új MD `routes-research-basename-redundant.md` létezik és Resolved-re jelölt
- [ ] `keychain-store-insecure-acl.md` Resolved-re jelölve
- [ ] INDEX.md konzisztens (row count stimmel,Resolved sorok a helyükön)
- [ ] Typecheck 1701 maradt (delta 0)
- [ ] Minden érintett teszt fájl 100% zöld
- [ ] Working tree clean
- [ ] `/code-review xhigh --fix` skill lefutott
- [ ] Commit stack 5-6 commit, push nélkül