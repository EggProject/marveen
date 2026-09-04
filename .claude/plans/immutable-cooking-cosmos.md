# Terv: Következő needs-fix cleanup batch

## Context

A `docs/needs-to-be-fix/` mappa 178 MD fájlból áll, amiből jelenleg 11 open:
- **3 Partial** (mind message-router): ugyanaz az 1 feltételesen elérhetetlen branch a `src/web/message-router.ts:482`-n (`isMainAgent ? null : cached.host`). A 900cdb6 commit már törölt 3 másik ágat (97.82%→99.24%) — most ez az 1 utolsó maradt.
- **2 Reopen** (`heartbeat-brief-rundiceaysweep-not-applicable.md`, `schedule-mcp-precheck-subtree-cycle-defensive.md`): user döntésére várnak, nincs automata javítási út.
- **6 Deferred**: egyenkénti investigation-t igényelnek, magasabb kockázatúak.

A `coverage/coverage-final.json` 2026-08-24-es, tehát 1 napos — nem tükrözi a 900cdb6 message-router javítást. A `web-agent-scaffold-defensive-coverage.md` számai viszont fordítva: a JSON frissebb (99.63%/273-of-274), az MD maradt a régi 93.61%-os snapshotnál.

A user kérése: legkisebb, legalacsonyabb kockázatú, kombinálható elemek — bug vagy kódtörés nélkül.

## Javasolt megközelítés: Batch D (3 commit, kombinált)

### Commit 1 — tisztán docs-only, nulla source módosítás
- `docs/needs-to-be-fix/keychain-store-insecure-acl.md:112` typo javítás: `swillows` → `swallows` (amúgy is lezárt MD-re mutat, csak kozmetika).
- `docs/needs-to-be-fix/web-agent-scaffold-defensive-coverage.md` számainak frissítése: 93.61%→99.63%, 264/282→273/274. A 14 sorhivatkozás (`183-184, 244, 248, 256, 259, 277-278, 487, 574-576, 581, 602, 611-612, 735, 809, 833`) újraellenőrzése `grep -n`-nel a jelenlegi `src/web/agent-scaffold.ts` ellen, mert a branch szám 282→274 változott (8 branch tűnt el), tehát a sorszámok egy része elcsúszhatott.

### Commit 2 — coverage JSON regenerálás (artifact-only, nulla source módosítás)
- `bun run coverage` futtatása → `coverage/coverage-final.json` és `coverage-summary.json` frissül.
- **Pre-flight gate**: ellenőrizni, hogy a 900cdb6 commit rajta van-e HEAD-en (`git log --oneline -5 src/web/message-router.ts`). Ha nincs, ez a commit regressziót okoz (97.82%-ra esik vissza).
- Ha bármely sor coverage-a romlik a HEAD-hez képest, abort és investigate a Commit 3 előtt.

### Commit 3 — forrás + bizonyítékhoz kötött docs (1 sor kód + 3 MD lezárás)
- `src/web/message-router.ts:482` sor: a `const host = isMainAgent ? null : cached.host` ternary-ből az `isMainAgent ? null :` prefix törlése, így `const host = cached.host` marad.
  - Bizonyíthatóan nulla viselkedés-változás: a `isMainAgent === true` ág strukturálisan elérhetetlen (a wakeup `continue` a 475. sorban elkapja). A `isMainAgent` const a 464. sorban a wakeup ágban továbbra is használatos.
  - Az MD szövege a 483-as sort jelöli, de a jelenlegi forrásban a ternary a 482-es soron van (off-by-one) — commit message-ben ez explicit rögzítve.
- A 3 Partial MD átállítása Resolved-ra: `message-router-cache-fallback-unreachable.md`, `message-router-dead-defensive-branches.md`, `message-router-unreachable-defensive-branches.md` — mindegyikhez egy-egy "Resolution: 2026-08-25 &lt;sha&gt; (line 482 ternary deleted; file-level branch coverage 99.24%→100%)" kiegészítés a meglévő "Scope note (2026-08-25)" minta alapján.
- Az INDEX.md 3 message-router sorának átállítása "Partial" → "Resolved: 2026-08-25 &lt;sha&gt;".

## Critical files
- `src/web/message-router.ts` (sor 482, és környezete 460-490 — a `isMainAgent` const és a wakeup `continue`)
- `docs/needs-to-be-fix/keychain-store-insecure-acl.md` (sor 112)
- `docs/needs-to-be-fix/web-agent-scaffold-defensive-coverage.md` (teljes frissítés)
- `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md`
- `docs/needs-to-be-fix/message-router-dead-defensive-branches.md`
- `docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md`
- `docs/needs-to-be-fix/INDEX.md` (3 sor módosítása)
- `coverage/coverage-summary.json`, `coverage/coverage-final.json` (regenerálódik a Commit 2-ben)

## Ami a Batch D UTÁN következik (külön user-döntés)

A user a 2 Reopen itemet is be akarja venni, de az explicit döntés (törlés / integráció implementáció / nyitva hagyás) még nincs megadva. A Batch D commitjai UTÁN, még a workflow lezárása előtt újra megkérdezzük a user-t, hogy a 2 Reopen MD-vel (`heartbeat-brief-rundiceaysweep-not-applicable.md`, `schedule-mcp-precheck-subtree-cycle-defensive.md`) mit tegyen:
- **Variáns A**: mindkettő törlése (task brief elavult, integration sosem létezett)
- **Variáns B**: runDecaySweep integráció implementálása + 1 új teszt (csak a heartbeat-brief-re értelmes)
- **Variáns C**: mindkettő nyitva hagyása Deferred státusszal

## Ami NEM kerül a batch-be
- **A 6 Deferred item** (channel-coordinator, keychain-acl, routes-agents, agent-scaffold, agent-worker, inbound-probe): magasabb kockázatú egyedi investigation-ök. Külön batchek.
- **`src/db/sqlite.ts` 50% ág-coverage**: nincs a jelenlegi 11 open item között — nem része ennek a körnek.

## Verification

1. **Commit 1**: `git diff --stat docs/` — csak markdown fájlok, nulla `src/` módosítás. `grep -n swillows` az egész repo-ban → 0 találat.
2. **Commit 2**: `git diff coverage/coverage-summary.json | head -100` — message-router.ts ág-coverage 99.24%-on vagy 100%-on, agent-scaffold.ts ág-coverage 99.63%. Bármely fájl coverage-romlása → abort.
3. **Commit 3**:
   - `bun run test src/__tests__/message-router-full.test.ts src/__tests__/message-router-tick-cap.test.ts` → mind a 72+ teszt pass.
   - `bun run coverage` → message-router.ts ág-coverage 138/138 (100%).
   - A 3 MD `## Status` szekciója "Resolved"-ot mutat, a 3 INDEX.md sor "Resolved: 2026-08-25 &lt;sha&gt;"-ra frissül.
   - A `vitest.config.ts` perFile: true gate-je átmegy az összes fájlon.
4. **Végén** `/code-review max --fix` user-oldali invokáció (a skill `disable-model-invocation` flag-es, ezért CSAK a user hívhatja manuálisan a terminálban — ezt a tervben explicit jelzem).
5. **Dupla subagent ellenőrzés** a végrehajtás után (a Plan agent javaslatát és a Commit 3-as diffet két független subagent értékeli, mielőtt user-nek prezentálnánk).

## Végrehajtási terv (workflow)

1. **Workflow** indítása a jelenlegi branch-ről (`test/baseline`).
2. A workflow 3 fázisban hajtja végre a 3 commitot.
3. A workflow végén 2 subagent (Agent tool, `isolation: worktree`) külön-külön értékeli a készülő diffet.
4. A user felé prezentálás a 2 subagent jelentése alapján.
5. User jóváhagyása → `/code-review max --fix` user-oldali invokáció.

## Push szabály

A CLAUDE.md §6 tiltja a `git push`-t — commitok lokálisan maradnak, push kizárólag a useré.
