# Következő needs-to-be-fix ciklus: 1 valódi teszt-defekt + 2 elavult coverage MD lezárása

## Context

Az `docs/needs-to-be-fix/INDEX.md` 178 sorából ténylegesen **3** nyitott
("Deferred to next cycle"). A user döntése alapján ebben a ciklusban kettő
kerül sorra (`channel-coordinator-internals-untestable`,
`web-inbound-probe-respawn-grace`); a `keychain-store-insecure-acl` nyitva marad,
mert az `-A` flag eltávolítása valódi macOS-viselkedésváltozás, amit unit teszttel
nem lehet garantálni.

**A tervezés során mért tény, ami az egész feladatot átírja:** mindkét MD
coverage-számai elavultak. A tényleges, ma mért állapot:

| Fájl | Lines | Branches | Functions | Statements |
|---|---|---|---|---|
| `src/channel-coordinator.ts` | 100% (160/160) | 100% (117/117) | 100% (22/22) | 100% (187/187) |
| `src/web/inbound-probe.ts` | 100% (145/145) | 100% (74/74) | 100% (16/16) | 100% (158/158) |

Mérés: `bun --bun vitest run <9 channel-coordinator + 2 inbound-probe teszt fájl>
--coverage --coverage.include=<a két fájl>` istanbul providerrel, json-summary
reporterrel. Miért elavultak az MD-k:

- A `channel-coordinator` 11 teszt fájlja `a33dc73` / `8ea57ba` (2026-08-07)
  commitokban landolt. Az MD utolsó érintése (`e399a96`, 2026-08-25) csak egy
  bulk "Scope note" appendix volt 87 MD-n, **nem újramérés**.
- Az `inbound-probe` MD 2026-08-05-i (`1dfe3be`), az azt megoldó
  `inbound-probe-full.test.ts` viszont 2026-08-08-án (`c333a6f`). A teszt fájl
  fejlécében (`src/__tests__/inbound-probe-full.test.ts:22-23`) és a
  `vi.mock('../web/channel-monitor.js')` blokkjában (:121-127) szó szerint az
  MD 3. javítási opciója van implementálva.

**Ezért az MD által javasolt `__test_*` export refaktor NEM készül el.** A
mérés bizonyítja, hogy nincs mit fedni: 22/22 függvény, 117/117 branch már
fedett. Egy `__test_` átnevezés 10 privát függvényen nulla coverage-nyereségért
churn lenne (CLAUDE.md §2 Simplicity, §3 Surgical).

**Amit a mérés viszont felszínre hozott, és ami valódi defekt:**
`src/__tests__/channel-coordinator.test.ts:552` közvetlenül hívja a
`process.kill(process.pid, 'SIGTERM')`-et. A
`src/__tests__/setup/forbid-system-calls.ts:103-107` globális forbid ezt
kivételre cseréli, hacsak nincs `MARVEEN_TEST_ALLOW_PROCESS_KILL=1`. A CI
(`.github/workflows/ci.yml:111`) a `bun run coverage`-t futtatja, ami
`bun --bun vitest run --coverage` **flag nélkül**, tehát ez a teszt a
gate-ben pirosan bukik:

```
FAIL src/__tests__/channel-coordinator.test.ts > main() entry-point bootstrap (one-shot)
  > triggers main, acquires lock, runs one tick, releases on SIGTERM
Error: process.kill forbidden in test suite
```

Pre-existing: a sor a `f8b4a95` (2026-08-04) commitban került be és jelen van
az `a330462` baseline-on is. Ez az **egyetlen** közvetlen `process.kill(` hívás
az egész `src/__tests__/` fában (a többi találat komment vagy `vi.spyOn`).

Cél: a piros teszt zöldre, majd a két MD igazságra hozása mért számokkal.

---

## 1. Teszt-defekt javítása

**Fájl:** `src/__tests__/channel-coordinator.test.ts:552`

```diff
-      process.kill(process.pid, 'SIGTERM')
+      process.emit('SIGTERM')
```

A teszt nem valódi szignált akar, hanem a `installSignalHandlers()`
(`src/channel-coordinator.ts:407-420`) által `process.on('SIGTERM', ...)`-tel
regisztrált handlert. A `process.emit` szinkron meghívja a listenereket, és ez a
projekt bevett mintája: a testvér `src/__tests__/channel-coordinator-lock.test.ts`
hat helyen ezt használja (`:235`, `:256`, `:275`, `:293` SIGINT, `:312`, `:313`)
és zölden fut.

A `:553-556` sorok kommentje ("The handler's setTimeout(...,3000) lets main()
clean up") és az utána következő assertion változatlan marad: a handler
viselkedése azonos.

**verify:** `bun --bun vitest run src/__tests__/channel-coordinator.test.ts`
**flag nélkül** → 56/56 pass.

---

## 2. Coverage újramérés a javítás után

A javítás előtti 100%-os mérés `MARVEEN_TEST_ALLOW_PROCESS_KILL=1`-gyel készült.
A dokumentációba **csak flag nélkül mért** szám kerülhet, különben az MD megint
hamis állítást rögzít.

```
bun --bun vitest run \
  src/__tests__/channel-coordinator.test.ts \
  src/__tests__/channel-coordinator-full.test.ts \
  src/__tests__/channel-coordinator-bootstrap-extra.test.ts \
  src/__tests__/channel-coordinator-ingest.test.ts \
  src/__tests__/channel-coordinator-lock.test.ts \
  src/__tests__/channel-coordinator-lock-live-pid.test.ts \
  src/__tests__/channel-coordinator-process-batch.test.ts \
  src/__tests__/channel-coordinator-reconcile.test.ts \
  src/__tests__/channel-coordinator-runloop-extra.test.ts \
  src/__tests__/inbound-probe.test.ts \
  src/__tests__/inbound-probe-full.test.ts \
  --coverage \
  --coverage.include='src/channel-coordinator.ts' \
  --coverage.include='src/web/inbound-probe.ts' \
  --coverage.thresholds.lines=0 --coverage.thresholds.functions=0 \
  --coverage.thresholds.branches=0 --coverage.thresholds.statements=0 \
  --coverage.reporter=json-summary --coverage.reportsDirectory=/tmp/cov-final
```

**verify:** 0 failed test, és a `/tmp/cov-final/coverage-summary.json`-ban
mindkét fájl mind a négy metrikán 100%. Ha bármelyik nem 100%, a 3. és 4. lépés
NEM indul; helyette a valós számot kell dokumentálni és az MD nyitva marad.

`--coverage.reportsDirectory=/tmp/...`, mert a `coverage/` a `.gitignore:98-99`-ben
van (CLAUDE.md §8): nem termel commitolható artifactot.

---

## 3. `channel-coordinator-internals-untestable.md` lezárása

**Fájl:** `docs/needs-to-be-fix/channel-coordinator-internals-untestable.md`

Változatlanul hagyandó, mert **ellenőrizve pontos** (Read-del egyeztetve a
forrással): a `## Location` szekció (`:5-17`) minden sorszáma stimmel
(`readToken` 117, `acquireSingleInstanceLock` 142, `releaseLock` 159,
`sendAlert` 170, `processBatch` 233, `reconcilePending` 270, `fatalExit` 302,
`runLoop` 311, `installSignalHandlers` 407, `main` 422, entry-guard 435-441),
az `## Excerpt` (`:19-49`) és a `## Scope note` (`:158-160`).

Javítandó, mert **megcáfolt tényállítás**:

| Sorok | Jelenlegi állítás | Valóság |
|---|---|---|
| `:53-56` | "Coverage gate fails ... ~46% of lines" | 100% lines |
| `:65-76` | "Tests that DO trigger main() scale poorly ... OOM at ~26s into a 12-test suite" | 9 fájl / 121 teszt fut ~6.7s alatt zölden |
| `:89-94` | "46% lines, 77% functions, 42% statements, 34% branches" | 100/100/100/100 (mért) |
| `:100-116` | "`channel-coordinator.test.ts` covers every reachable testable surface" (egyetlen fájlt nevez meg) | 9 fájl fedi (a listát a `## Pinning test` szekcióban fel kell sorolni) |
| `:118-124` | "The state machine ... is unreachable without source modifications" | Elérhető: `runloop-extra`, `process-batch`, `reconcile` fájlok minden ágat hajtanak |
| `:146-156` | "Until a resolution is chosen the branch-coverage gate will fail ... neither fix has been applied" | Nincs mit alkalmazni |

Új `## Resolution (2026-08-26, this commit)` footer, amely rögzíti: a fedettséget
az `a33dc73` + `8ea57ba` (2026-08-07) teszt commitok érték el; a `## Suggested
direction` 1. opciója (`__test_*` export) **szándékosan nem került alkalmazásra**,
mert a mérés szerint nincs fedetlen kód; egyetlen forrásváltozás nem történt a
`src/channel-coordinator.ts`-ben.

---

## 4. `web-inbound-probe-respawn-grace.md` lezárása

**Fájl:** `docs/needs-to-be-fix/web-inbound-probe-respawn-grace.md` (60 sor)

| Sorok | Jelenlegi állítás | Valóság |
|---|---|---|
| `:6-14` | "a négy teszt ... mind bukik, a dinamikus import a valódi modult kapja" | Az `inbound-probe-full.test.ts:735-1059` `checkInboundProbeDeafness via setInterval tick` describe blokkja zölden hajtja mind a négyet |
| `:27-30` | "Lines 297-347 és 288, 381 uncovered; 63% of the SUT" | 100% (145/145 lines, 74/74 branches) |
| `:41-51` | "Fix: either 1/2/3" | A 3. opció alkalmazva |
| `:53-59` | "`src/__tests__/web-inbound-probe.test.ts`" + "64% coverage" | **Ilyen fájl nem létezik**; a valódiak: `src/__tests__/inbound-probe.test.ts` (pure exportok) és `src/__tests__/inbound-probe-full.test.ts` (lifecycle) |

Új `## Resolution (2026-08-26, this commit)` footer: a 3. javítási opció
(`vi.resetModules()` + friss dinamikus import per teszt) a `c333a6f` (2026-08-08)
commitban landolt, konkrétan `inbound-probe-full.test.ts:146` (`vi.resetModules()`
a `loadInboundProbeFresh()`-ben), `:121-127` (`vi.mock('../web/channel-monitor.js')`)
és `:196-200` (`vi.doMock` újraalkalmazás a friss registryn). Forrásváltozás nem
történt a `src/web/inbound-probe.ts`-ben.

**Kötelező lépés commit előtt (CLAUDE.md §8):** minden fenti file:line hivatkozást
Read-del ellenőrizni a tényleges fájlon. Az itt szereplő számok a tervezéskor
lettek ellenőrizve, de a 3. lépés MD-átírása eltolhatja a saját sorszámait.

---

## 5. INDEX.md két sor átfordítása

**Fájl:** `docs/needs-to-be-fix/INDEX.md`

- `:72` `channel-coordinator-internals-untestable` → `Deferred to next cycle`
  helyett `Resolved: 2026-08-26 (this commit) -- NO-OP, 100% coverage already
  reached by a33dc73+8ea57ba; MD numbers were stale`
- `:194` `web-inbound-probe-respawn-grace` → `Resolved: 2026-08-26 (this commit)
  -- fix option 3 applied in c333a6f; MD numbers were stale`

SHA kezelés (CLAUDE.md §8): `(this commit)` placeholder a commit ELŐTT, majd
külön `docs(index): correct SHA reference` follow-up commit írja be a valós SHA-t.

**verify:** `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l`
== `grep -c '^| `' docs/needs-to-be-fix/INDEX.md` == 178.

---

## Végrehajtás

**Workflow tool**, 4 agent (a session guideline: 5 alatt):

- Phase 1 (1 agent) -- `Fix + measure`: az 1. lépés edit, majd a 2. lépés mérése.
  Structured output: `{ testsPassed, failures, ccPct{lines,branches,functions,statements}, ipPct{...} }`.
  Ha bármelyik pct < 100 vagy failures > 0, a workflow itt megáll és visszaadja az okot.
- Phase 2 (2 agent párhuzamosan) -- `Rewrite MDs`: A = channel-coordinator MD
  (3. lépés), B = inbound-probe MD (4. lépés). Diszjunkt fájlok, nincs ütközés.
  Mindkettő megkapja a Phase 1 mért számait, és mindkettőnek Read-del kell
  ellenőriznie minden általa leírt file:line hivatkozást.
- Phase 3 (1 agent) -- `INDEX`: az 5. lépés + a 178/178 count verify.

Miért Workflow és nem Agent: a fázisok sorrendfüggők (a mért szám kell az
MD-khez), és a Phase 2 két ága valóban párhuzamos.

**Commitok** (main loopban, a workflow után):

1. `fix(test): drive channel-coordinator SIGTERM via process.emit, not forbidden process.kill`
2. `docs(needs-to-be-fix): close 2 stale coverage MDs with measured 100% figures (this commit)`
3. `docs(index): correct SHA reference` (a placeholder cseréje)

Minden a `test/baseline` branchen marad. **Push nincs** (CLAUDE.md §6).

**Dupla ellenőrzés:** a commitok után 2 független **Agent tool** subagent
`isolation: worktree`-vel (CLAUDE.md §8 explicit előírás: 2 párhuzamos verify
subagenthez Agent tool, nem Workflow). Feladatuk egymástól függetlenül:
(a) a `process.emit` csere tényleg meghívja-e a handlert és a pid-fájl törlődik-e,
(b) a coverage flag nélkül is 100%-e, (c) minden MD-beli file:line hivatkozás
igaz-e, (d) van-e em-dash (CLAUDE.md §6), (e) 178/178 count.

**Záró lépés:** `/code-review max --fix`. Ezt a skillt a Skill tool nem hívhatja
(`disable-model-invocation`), **neked kell beírnod a terminálba** a commitok után.

---

## Verification (end-to-end)

1. `ls store/` → nem létezik, a `assert-not-live-install.ts` guard nem blokkol (ellenőrizve).
2. `bun --bun vitest run src/__tests__/channel-coordinator.test.ts` flag nélkül → 56/56 pass.
3. A 2. lépés coverage parancsa → 0 fail, 2 fájl × 4 metrika = 100%.
4. `git diff --stat` → pontosan 4 fájl: 1 teszt (1 sor), 2 MD, 1 INDEX.
5. `grep -c '—' docs/needs-to-be-fix/*.md` a két érintett fájlon → 0 (em-dash tilalom).
6. 178 == 178 count check.
7. `git log --oneline -3` → 3 commit, push nincs.
