# Terv: legkisebb módosítás a test/baseline branch-en

## Kontextus

A `docs/needs-to-be-fix/INDEX.md` jelenleg 178 MD entry-t követ. A korábbi ciklusok (2026-08-09 → 2026-08-21) lezárták a magas és közepes kockázatú bugok nagy részét, de maradt néhány alacsony kockázatú, jól dokumentált "lefedettségi hézag" / "doc-only" entry, amelyek biztonságosan lezárhatók anélkül, hogy bármilyen futásidejű kódot megváltoztatnánk.

A felhasználói kérés: "Mi a következő legkisebb módosítással és lehetséges bukással járó needs fix elemek?" — vagyis a legkisebb scope + legalacsonyabb meghibásodási kockázat. A terv 2 commitból áll (1 db implementation + 1 db docs), és a `test/baseline` branch-en marad. Remote push nem történik (CLAUDE.md tiltja).

A tervet 3 Explore agent és 1 Plan agent külön-külön validálta. Dupla ellenőrzés megtörtént.

## Választott MD-k

### Commit 1 (implementation) — 1 db src/index.ts módosítás

**`index-283-test-pins-error-wiring`** — felhasználó az Option 2-t választotta: 3 soros kód-comment hozzáadása a `src/index.ts:282` fölé.

A módosítás oka: a `PidfileLockContext` interface (`src/process-lock.ts:253`) megköveteli a `error: LogFn` property-t (nem opcionális). A `buildPidfileLockContext` (src/index.ts:209) forwarder-e a `error: (obj, msg) => logger.error(obj, msg)` a sor 282-n. A `acquirePidfileLock` egyetlen termelési consumer **sosem** hívja a `ctx.log.error`-t (csak `info` és `warn`, lásd process-lock.ts:301/328/336/346/350/352). A `ctx.log.error` hívás a `src/process-lock.ts:158`-ban (`SIGKILL failed`) egy **másik** ctx-re (`ProcessLockContext`, forwarder az `src/index.ts:173`-n) vonatkozik, nem a `PidfileLockContext`-ra.

A 3 soros comment dokumentálja ezt az aszimmetriát anélkül, hogy a type contract-ot gyengítené vagy a tesztet törölné. A teszt az `src/__tests__/index.test.ts:1382-1394`-ben továbbra is pin-eli a forwarder contract-ot, a típus a `src/process-lock.ts:253`-ban továbbra is megköveteli az `error` property-t — a comment csak a jövőbeli olvasók számára tisztázza, hogy a forwarder "no production caller" állapotú.

**Megjegyzés a NEVER-modify rule-ról**: a `docs/needs-to-be-fix/index-unreachable-coverage.md` (és más MD-k) a `src/index.ts`-t "NEVER modify" task rule alá sorolják. A felhasználó az Option 2 választásával implicit felülírta ezt a rule-t erre a konkrét módosításra (3 sor comment, kódlogika nélkül).

### Commit 2 (docs) — 5 db INDEX.md sor frissítés

A `docs/needs-to-be-fix/INDEX.md` 5 sorát frissítjük:

| MD | Új Resolved érték | Miért |
|---|---|---|
| `heartbeat-brief-rundiceaysweep-not-applicable` | `Documented only — source unchanged` | A task brief egy nem-létező integrációt kért; a `src/heartbeat.ts` és `src/index.ts` decay pathjai siblingek, soha nem hívják egymást. A `heartbeat-cov.test.ts` zöld marad `runDecaySweep` import nélkül is — ez bizonyítja hogy a brief clause no-op. |
| `index-283-test-pins-error-wiring` | `Resolved: <SHA> — contract documented via code comment in src/index.ts:282` | Commit 1-ből jön a SHA. |
| `keychain-store-insecure-acl` | `Documented only — source unchanged` | A MD maga is megjegyzi, hogy a `-A` flag "low because the key is readable without `-A` too" — ismert kompromisszum, nincs tervezett fix. |
| `ci-eslint-typecheck-baseline` | `Documented only — source unchanged` | A MD explicit "n/a (tooling debt, no runtime defect)" — nincs futásidejű hiba, nincs teendő. |
| `test-suite-llm-api-audit-clean` | `Documented only — audit complete` | A MD "audit doc (not a bug)" státuszú — a vizsgálat maga az audit record. |

A 3 utóbbi (keychain, ci-eslint, test-suite-llm) a Plan agent által javasolt bónusz tételek — ugyanaz a "Documented only" minta, nulla kockázat, magasabb throughput.

## Kritikus fájlok

- `/Users/eggp/marveen-develop/test-baseline/src/index.ts` (comment hozzáadása a 282. sor fölé)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (5 sor frissítés)

Nem kell sem új fájl, sem más forrás módosítás.

## Végrehajtás (workflow)

A user kérésére workflow-t használunk. A workflow a `test/baseline` worktree-ből indul és oda tér vissza.

1. **Worktree előkészítés**: `git worktree add --detach /tmp/claw-test-nextfix test/baseline` + symlink a `node_modules` (a store pollution elkerülésére a CLAUDE.md-ben leírtak szerint).
2. **Comment commit**:
   - Szerkesztés: `src/index.ts:280-283` közé 3 soros comment block beillesztése (a `error:` arrow fölé).
   - Pontos szöveg:
     ```
     // PidfileLockContext.log.error is forwarder-only: required by the interface
     // (process-lock.ts:253) but never invoked by acquirePidfileLock (info/warn
     // only at process-lock.ts:301/328/336/346/350/352). Pinned by index.test.ts:1382.
     ```
   - Ellenőrzés: `bun --bun run typecheck` (elvárt: 0 új hiba, marad a 1703 pre-existing baseline), `bun --bun vitest run src/__tests__/index.test.ts` (elvárt: 123/123 pass, nincs új fail).
   - Commit: `git commit -F <(cat <<'EOF'
     fix(index): document PidfileLockContext.log.error forwarder-only contract

     Per docs/needs-to-be-fix/index-283-test-pins-error-wiring.md option 2:
     add a code comment in buildPidfileLockContext explaining that the
     error arrow at index.ts:282 is required by the PidfileLockContext
     interface but never invoked by acquirePidfileLock in production.
     The synthetic test at index.test.ts:1382 pins the forwarder contract;
     the type at process-lock.ts:253 makes error: LogFn non-optional.

     Co-Authored-By: ... <noreply@anthropic.com>
     EOF
     )` (a heredoc backslash-corruption elkerülésére a `safe-commit-message` skill-t kell használni, ha a body regex karaktert tartalmaz — ez a comment nem tartalmaz, de a konvenciót betartjuk).
3. **Docs commit**:
   - Szerkesztés: `docs/needs-to-be-fix/INDEX.md` 5 sor Resolved oszlopának frissítése (lásd fenti táblázat).
   - A `safe-commit-message` skill-en keresztül commit, mert a Resolved oszlop SHA formátuma idézőjelek/speciális karakterek nélküli, de a konvenciót tartjuk.
   - Commit message:
     ```
     docs(needs-to-be-fix): mark heartbeat/index-283/keychain/ci-eslint/test-suite-llm Resolved

     - heartbeat-brief-rundiceaysweep-not-applicable: documented only (task
       brief referenced non-existent integration; heartbeat-cov.test.ts
       passes without runDecaySweep import).
     - index-283-test-pins-error-wiring: resolved by <12-char-SHA>;
       contract documented via comment in src/index.ts:282.
     - keychain-store-insecure-acl: documented only (known compromise, no
       planned fix per the MD's own severity classification).
     - ci-eslint-typecheck-baseline: documented only (tooling debt, no
       runtime defect per the MD).
     - test-suite-llm-api-audit-clean: documented only (audit record).
     ```
4. **Merge vissza a test/baseline**:
   - `cd /Users/eggp/marveen-develop/test-baseline && git merge --ff-only /tmp/claw-test-nextfix` (fast-forward, mert a worktree-ből jöttünk és a test/baseline nem változott közben).
   - Vagy alternatíva: `git fetch . /tmp/claw-test-nextfix:test/baseline-nextfix` + `git checkout test/baseline && git merge --ff-only test/baseline-nextfix`.
   - A worktree takarítása: `git worktree remove /tmp/claw-test-nextfix`.
5. **Nincs push** (CLAUDE.md tiltja, a useré a push).
6. **Code review**: a user sajátkezűleg futtatja a `/code-review max --fix` skillt a terminálban. CLAUDE.md: a skill `disable-model-invocation` flag-gel rendelkezik, a Skill tool elutasítaná — CSAK a user hívhatja.

## Verifikáció (end-to-end)

A workflow minden fázisa után:

| Lépés | Ellenőrzés |
|---|---|
| Worktree előkészítés | `ls /tmp/claw-test-nextfix/src/index.ts` létezik; `ls -la /tmp/claw-test-nextfix/node_modules` a symlinkre mutat. |
| Comment commit | `bun --bun run typecheck` → 0 új TS hiba; `bun --bun vitest run src/__tests__/index.test.ts` → 123/123 pass. |
| Docs commit | `grep -n 'Documented only' docs/needs-to-be-fix/INDEX.md` → az új sorok megjelennek; a táblázat sorszáma azonos marad (178 → 178). |
| Merge vissza | `git log --oneline test/baseline -3` → 2 új commit megjelenik a `137ef7e fix skill` fölött. |
| Code review | user terminálban futtatja `/code-review max --fix`. |

## Dupla ellenőrzés eredménye

- **Explore agent #1** (`federation type-narrow`): javasolta a `?? null` drop-ot típus-szűkítés nélkül — **kockázatos**, kizárva.
- **Explore agent #2** (`index-283 + probe cache`): megerősítette, hogy a `src/process-lock.ts:158` `ctx.log.error` hívás `ProcessLockContext`-re vonatkozik, nem `PidfileLockContext`-ra — a MD premisszája helyes. Option 2 a legkisebb, legalacsonyabb kockázatú.
- **Explore agent #3** (`message-router + heartbeat + agent-worker`): a `heartbeat-brief-rundiceaysweep-not-applicable` pure docs-only fix, nulla kockázat.
- **Plan agent**: jóváhagyta a 2-commit struktúrát, jelezte a CLAUDE.md "follow-up docs commit" protokoll betartását, és ajánlotta a 3 bónusz docs-only entry-t.

A Plan agent egyetlen korrekciója: a `process-lock.ts:158` `ctx.log.error` nem cáfolja a MD-t (mint korábban gondoltam), hanem egy másik ctx-re vonatkozik — ezért a "Resolved — MD premise incorrect" típusú megoldás nem alkalmazható. A user által választott Option 2 (comment) az egyetlen helyes út.

## Kockázat kiértékelése

- **Comment módosítás (commit 1)**: kockázat = nagyon alacsony. A comment nem változtat futásidejű viselkedést, nem érint type contract-ot, nem töröl tesztet. A typecheck és a teszt suite várhatóan zöld marad.
- **INDEX.md módosítás (commit 2)**: kockázat = nulla. Táblázatsorok szöveges frissítése, nincs kódváltozás. A sorok száma változatlan (178).
- **Összevonás**: a user kérésére több MD-t összevontunk (2 fix MD + 3 bónusz docs-only MD), mindegyik független és nulla egymásra hatás.

## Korlátok / nem változtatandó

- Nem módosítunk `src/process-lock.ts:253` (type contract marad).
- Nem töröljük az `src/__tests__/index.test.ts:1382-1394` tesztet.
- Nem érintjük a federation MD-ket (`federation-inbox-fedPeer-null-fallback`, `federation-routes-fedpeer-required-type-narrow-deferred`) — a user kérésére ezek a következő körben maradnak, a típus-szűkítés eldöntéséig.
- Nem pusholunk remote-ra.
- A `/code-review max --fix` skillt a user hívja manuálisan, mi nem (CLAUDE.md tiltja).
