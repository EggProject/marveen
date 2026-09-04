# Terv: legkisebb módosítású, legalacsonyabb kockázatú needs-fix elemek zárása

## Context

Az `INDEX.md` (`docs/needs-to-be-fix/INDEX.md`) 9 nyitott elemet sorol, amiknek egy része
a forrásban már megoldódott, csak az index-szinkron maradt el; más része dokumentációval
vagy tripwire commenttel 0 source kockázattal lezárható. A felhasználó kérésére
**kizárólag a legkisebb, legkisebb kockázatú elemeket** zárjuk egyetlen körben,
source-módosítás csak comment-szinten (0 behavior change).

A 7 "Deferred to next cycle" státuszú elemet (`channel-coordinator-internals-untestable`,
`keychain-store-insecure-acl`, `message-router-cache-fallback-unreachable`,
`routes-agents-br-baseline-partial-coverage`, `web-agent-scaffold-defensive-coverage`,
`web-agent-worker-runviaworker-coverage`, `web-inbound-probe-respawn-grace`) **nem bántjuk**:
státuszuk már helyes, valódi source-fixjük a "NEVER modify" szabályok miatt blokkolt
és külön user-felülírást igényelne.

## Lefedett elemek (2 db, 1 kör)

### 1. `test-suite-store-pollution-store-dir-frozen` (HIGH)

**Jelenlegi forrás-állapot (ellenőrizve):**
- `src/__tests__/setup/test-sandbox-setup.ts:23-29` — `mkdtempSync(tmpdir())` + `vi.mock('../config.js', ...)` hoisted-on átirányítja a `STORE_DIR`-t minden tesztfájlhoz (commit `49c24ab`, 2026-08-13)
- `src/__tests__/db-100.test.ts:26-48` — saját per-test sandbox: `vi.hoisted` + `vi.mock('../config.js', ...)` `importOriginal`-lal (commit `b745b8a`, 2026-08-06)
- `src/__tests__/db-100.test.ts:170-173` — `afterAll` cleanup: `rmSync(tmpDir)` + `rmSync(sandbox.STORE_DIR)` (commit `8ea57ba`, 2026-08-07)
- `src/__tests__/db-100.test.ts:1655-1717` — `migrateTaskRunsFromJson` tesztek most már a sandbox `STORE_DIR`-be írnak, nem a live `./store/`-ba; a `task-run-history.json.migrated` artifact a sandboxban marad és az afterAll `rmSync` takarítja

**A bug ténylegesen megoldva a forrásban**, csak az INDEX.md frissítetlen. A `assert-not-live-install.ts` guard ráadásul második védelmi vonalként is megmarad (hard-fail, ha bármi a live store-ba kerülne).

**Módosítás (1 sor, 0 source kockázat):**
- `docs/needs-to-be-fix/INDEX.md:30` — `Resolved` cella frissítése:
  ```
  | `test-suite-store-pollution-store-dir-frozen` | ... | Resolved: 2026-08-07 8ea57ba (test-sandbox-setup.ts + db-100.test.ts vi.mock + rmSync afterAll, layered with assert-not-live-install guard) |
  ```

### 2. `channel-request-watcher-unreachable-provider-check` (Low)

**Jelenlegi forrás-állapot (ellenőrizve):**
- `src/web/channel-request-watcher.ts:77` — `if (provider !== 'slack') return` (MD heading `:67`, aktuális sor `:77` — off-by-one, MD-ben dokumentálva)
- A guard mindkét hívási helyen kívül (`scanAuditLog` @ 46, `runScanTick` @ 105) már `provider !== 'slack'` szűrésen ment át, így belsőleg holt
- DE a **DO NOT RAW-DELETE** figyelmeztetés (`docs/needs-to-be-fix/channel-request-watcher-unreachable-provider-check.md:91-100`): a guard védi a `TELEGRAM_BOT_TOKEN → slack.com/api` leak ellen egy mid-tick provider flip esetén
- A `?? null` source-leak invariánst a meglévő `TOKEN LEAK invariant comment` őrzi a `src/web/channel-request-watcher.ts` elején (commit `1b105fd`)

**Módosítás (1 comment, 0 source kockázat — nincs behavior change):**
- `src/web/channel-request-watcher.ts:77` (közvetlenül az `if (provider !== 'slack') return` sor előtt) — 4-6 soros tripwire comment:
  ```ts
  // Defensive guard: HOLT A PUBLIKUS API-N (mindkét hívó a slack-only ágban
  // fut, lásd scanAuditLog:46 és runScanTick:105), de NE töröld: védi a
  // mid-tick provider flip esetén a readChannelToken(telegram, ...) →
  // slack.com/api hívást, ami a TELEGRAM_BOT_TOKEN-t Bearer tokenként
  // küldené egy idegen vendor felé. A jövőbeli javítás a `provider` paraméter
  // hoistolása, hogy a rossz-provider út strukturálisan lehetetlenné váljon.
  ```
- `docs/needs-to-be-fix/INDEX.md:121` — `Resolved` cella frissítése:
  ```
  | `channel-request-watcher-unreachable-provider-check` | ... | Resolved: <új commit SHA> — Documented only; tripwire comment at src/web/channel-request-watcher.ts:77. Guard kept as token-leak defense per MD "DO NOT RAW-DELETE" (commit 1b105fd TOKEN LEAK invariant). |
  ```

## Módosítandó fájlok listája (3 db)

| File | Módosítás | Sorok száma |
| --- | --- | --- |
| `docs/needs-to-be-fix/INDEX.md` | 2 sor frissítés (sor 30, sor 121) | +0 / -2 / +2 |
| `src/web/channel-request-watcher.ts` | 1 comment block a 77. sor előtt | +6 / -0 / +0 |
| (commit message) | Conventional commit: `docs(index): close 2 needs-fix items; tripwire comment for channel-request-watcher` | — |

Nincs `src/__tests__/**` módosítás, nincs source logic módosítás, nincs schema/API törés.

## Nem módosított (szándékosan) elemek és indoklás

- `channel-coordinator-internals-untestable` — `NEVER modify src/channel-coordinator.ts` szabály blokkolja a state-machine refaktort. INDEX státusz (`Deferred to next cycle`) már helyes.
- `keychain-store-insecure-acl` — Bár a prereq (`keychain-retrieve-swallows-locked-keychain`, `6e5bdd7`) megvan, a `NEVER modify src/web/keychain.ts` szabály blokkolja a `'-A' → '-T, SECURITY'` cserét. Headless host verifikáció is kell, ami plusz kört igényel.
- `message-router-cache-fallback-unreachable` — `NEVER modify src/web/message-router.ts` szabály blokkolja a type-narrow refaktort. Az MD részletes története (`eb9b951` → `6e08cf4` → `f67efca` → `2ec1c99`) bizonyítja, hogy a felszínes javítás ront a coverage-on.
- `routes-agents-br-baseline-partial-coverage` — `NEVER modify src/web/routes/agents.ts` szabály blokkolja a 67 dead branch törlését.
- `web-agent-scaffold-defensive-coverage` — `NEVER modify src/web/agent-scaffold.ts` szabály blokkolja a 18 dead branch törlését.
- `web-agent-worker-runviaworker-coverage` — Az MD kifejezetten tiltja: "do NOT apply as part of this test commit".
- `web-inbound-probe-respawn-grace` — A fix opciók (static-import refactor / split worker / Vite config override) egyike sem "legkisebb módosítás" — mindegyik nagyobb architektúra-váltás.

## Végrehajtási terv (Workflow tool)

A user kérésére Workflow tool-t használunk, 2 fázisban:

### Fázis 1: Implementáció (1 agent, isolation: worktree)

`Workflow` script, 1 db `agent()` hívás `subagent_type: general-purpose`, `isolation: worktree`:

```js
phase('Implement')
await agent(`Implement 2 needs-fix items on test/baseline:

ITEM 1: docs/needs-to-be-fix/INDEX.md
  - Row at line 30 (test-suite-store-pollution-store-dir-frozen): replace 'Resolved' cell with:
    'Resolved: 2026-08-07 8ea57ba (test-sandbox-setup.ts + db-100.test.ts vi.mock + rmSync afterAll, layered with assert-not-live-install guard)'
  - Row at line 121 (channel-request-watcher-unreachable-provider-check): replace 'Resolved' cell with:
    'Resolved: <NEW_COMMIT_SHA> -- Documented only; tripwire comment added at src/web/channel-request-watcher.ts:77. Guard kept as token-leak defense per MD DO NOT RAW-DELETE (commit 1b105fd TOKEN LEAK invariant).'

ITEM 2: src/web/channel-request-watcher.ts
  - Add a 4-6 line tripwire comment IMMEDIATELY BEFORE the line 'if (provider !== 'slack') return' (currently at line 77). Use the exact comment text:
    '// Defensive guard: HOLT A PUBLIKUS API-N (mindkét hívó a slack-only ágban fut, lásd scanAuditLog:46 és runScanTick:105), de NE töröld: védi a mid-tick provider flip esetén a readChannelToken(telegram, ...) -> slack.com/api hívást, ami a TELEGRAM_BOT_TOKEN-t Bearer tokenként küldené egy idegen vendor felé. A jövőbeli javítás a provider paraméter hoistolása, hogy a rossz-provider út strukturálisan lehetetlenné váljon.'

VERIFICATION (run BEFORE commit):
  1. bun --bun vitest run src/__tests__/channel-request-watcher.test.ts (must stay green -- only a comment, no behavior change)
  2. bun --bun vitest run src/__tests__/assert-not-live-install-guard.test.ts (if it exists) AND src/__tests__/db-100.test.ts (sandbox cleanup must still pass)
  3. Verify the comment didn't change runtime behavior by reading the file after edit

COMMIT:
  git add docs/needs-to-be-fix/INDEX.md src/web/channel-request-watcher.ts
  git commit -m 'docs(index): close 2 needs-fix items; tripwire comment for channel-request-watcher
  
  - test-suite-store-pollution-store-dir-frozen: source fix already in place (test-sandbox-setup.ts global vi.mock + db-100.test.ts:26-48 per-test sandbox + rmSync afterAll). Marking Resolved in INDEX.
  - channel-request-watcher-unreachable-provider-check: source guard kept; added 6-line tripwire comment explaining the mid-tick token-leak invariant per MD DO NOT RAW-DELETE. 0 source behavior change.

  Refs: docs/needs-to-be-fix/test-suite-store-pollution-store-dir-frozen.md, docs/needs-to-be-fix/channel-request-watcher-unreachable-provider-check.md'

After commit, return the commit SHA so phase 2 can verify it.

Working directory: /Users/eggp/marveen-develop/test-baseline (current branch test/baseline, isolated worktree).`)
```

### Fázis 2: Dupla ellenőrzés (2 subagent párhuzamosan, isolation: worktree)

`Workflow` script, `parallel()` barrier 2 `agent()` hívással. A user kérésére **2
független subagent** értékeli a commitot:

```js
phase('Double-verify (2 subagents)')
const [verifyA, verifyB] = await parallel([
  () => agent(`Verify the commit <SHA> on test/baseline:

  1. Read /Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md around lines 30 and 121 -- confirm the 2 Resolved cells are correct.
  2. Read /Users/eggp/marveen-develop/test-baseline/src/web/channel-request-watcher.ts around line 77 -- confirm the tripwire comment is present and accurate.
  3. Run: cd /Users/eggp/marveen-develop/test-baseline && bun --bun vitest run src/__tests__/channel-request-watcher.test.ts
     Report: pass/fail count. Comment-only change should NOT break any test.
  4. Verify the commit message format and that it does NOT touch any forbidden file (no src/__tests__/**, no src/*.ts logic).

  Return: a structured report with sections (a) INDEX.md correctness, (b) source comment correctness, (c) test result, (d) commit hygiene. Flag any deviation from the plan.`, {label: 'verify-A', phase: 'Double-verify', isolation: 'worktree'}),
  () => agent(`Independently verify the same commit <SHA> on test/baseline:

  1. git -C /Users/eggp/marveen-develop/test-baseline show <SHA> --stat
     -- the diff must be ONLY:
       - docs/needs-to-be-fix/INDEX.md (1-3 line edit)
       - src/web/channel-request-watcher.ts (1 comment block, +6 lines / -0 lines)
     No other file. No source logic change.
  2. git -C /Users/eggp/marveen-develop/test-baseline show <SHA> -- docs/needs-to-be-fix/INDEX.md
     -- confirm the 2 Resolved cells reference correct commit SHAs and dates.
  3. git -C /Users/eggp/marveen-develop/test-baseline show <SHA> -- src/web/channel-request-watcher.ts
     -- confirm the tripwire comment is placed BEFORE the if-guard, not AFTER, and that the if-guard line itself is UNCHANGED.
  4. Run: cd /Users/eggp/marveen-develop/test-baseline && bun --bun vitest run src/__tests__/channel-request-watcher.test.ts 2>&1 | tail -20
     -- report exit code and last 20 lines.

  Return: a structured report with sections (a) diff hygiene, (b) INDEX.md content, (c) source comment placement, (d) test result. Flag any deviation from the plan.`, {label: 'verify-B', phase: 'Double-verify', isolation: 'worktree'}),
])

if (verifyA.flagged || verifyB.flagged) {
  // Both subagents agreed: report for user attention
  return { verdict: 'flagged', verifyA, verifyB }
}
return { verdict: 'clean', verifyA, verifyB }
```

### Fázis 3: Felhasználói átadás

A két subagent zöld jezése után a user hívja a `/code-review max --fix` skillt
a saját termináljában (manuális invokáció kötelező — `disable-model-invocation`
flag miatt a Skill tool elutasítja). Ez a terv ezt a lépést csak dokumentálja,
nem hívja.

## Verification (végén, a user által)

1. `git log --oneline -1 test/baseline` — az új commit megjelenik
2. `git show HEAD --stat` — csak 2 fájl módosult
3. `bun --bun vitest run src/__tests__/channel-request-watcher.test.ts` — zöld
4. `cat docs/needs-to-be-fix/INDEX.md | grep -E "Resolved.*8ea57ba|Resolved.*<NEW_SHA>"` — mindkét sor látszik
5. `head -85 src/web/channel-request-watcher.ts | tail -15` — a tripwire comment a 77. sor előtt
6. `git push --dry-run` — NEM pusholunk, a commit lokálisan marad (user pushol)

## Kockázati profil

| Tényező | Értékelés |
| --- | --- |
| Source logic change | 0 (csak comment) |
| API / schema változás | 0 |
| Coverage gate | nem érintett (comment) |
| Test failure kockázat | 0 (a comment a 77. sor előtt van, a 77. sor maga változatlan) |
| Rollback egyszerűség | 1 commit revert |
| Push kockázat | 0 (a user pushol, nem mi) |
| Workflow méret | 1 implement + 2 verify (5 agent alatt) |

## Függőségek

- `bun --bun vitest` futtatható a worktree-ben
- A `test/baseline` branch up-to-date az origin-nel (most clean)
- A `node_modules` symlinkelhető a worktree-be a `CLAUDE.md` 8-as szabálya szerint, hogy ne kelljen telepíteni
- Nincs `assert-not-live-install` guard trigger (worktree `store/` üres)
