---
paths:
  - "**/*"
---

# Worktree cleanup — remove before stop

## Miért van ez a dokumentum

A Claude Code session-ök gyakran hoznak létre worktree-ket és
branch-eket a session során (`git worktree add -b <branch> <path>`).
A cleanup rendszeresen elfelejtődik, mert (a) a CLAUDE.md §8-as
takarits-magad-utan szabály recall-based, és hosszú session-ökben
a 8K-token attention cliff mögé kerül, nem olvasódik újra; (b) a
Honcho memory entry-k opt-in retrieval-ök (az agentnek chat()-et
kell hívnia); (c) a Stop hook csak Todo-list + uncommitted memory-t
enforce-elte, nem a worktree cleanup-ot.

A 2026-09-09-i A.2d ApprovalStore session (session-id `389d5af2`)
harmadszorra szólaltatta meg a `megint` markert. Korábbi incidensek:
2026-08-28 (`miert nincsen torolve a regi worktree-k es branchek!`),
2026-09-04 TWICE (`mi a kurva anyad bajod van, hogy jossz te ahhoz
hogy en takaritsam a te szemedet`). A user 2026-09-10-én deep
retrospective workflow-t kért (wf_4afcc1d7-0c6), ami azonosította
a structural root cause-t: a recall-based szabályok rendre elbuknak;
a mechanical gates (mint a session-lifecycle.md + Stop hook) működnek.

## A fő szabály (egy mondat)

**Ha a session worktree-t vagy branch-et hozott létre (vagy a session
előtt volt ilyen a working tree-ben), a session utolsó lépése ELŐTT
a `git worktree remove` + `git worktree prune` + `git branch -d`
szekvenciát le kell futtatni ÉS ellenőrizni kell, hogy egyik sem
maradt a `git worktree list` / `git branch --list` kimenetében.**

## Hol él ez a szabály

Always-loaded rule file: a Claude Code a `.claude/rules/*.md`
fájlokat minden session indításakor betölti, és a session
teljes hossza alatt elérhetővé teszi (ellentétben a CLAUDE.md §8
prose szabállyal, ami az attention cliff mögé kerül).

A `paths` frontmatter `**/*` — a rule minden fájlra érvényes, mert
a worktree-k és branch-ek NEM fájl-specifikus erőforrások.

## Permanent set (soha ne töröld)

- `marveen` checkout: a `feature-develop` branch + a saját worktree
  path-ja (`/Users/eggp/marveen-develop/marveen`)
- `test-baseline` checkout: a `refactor/classbase` branch + a saját
  worktree path-ja (`/Users/eggp/marveen-develop/test-baseline`)
- `a330462` detached HEAD worktree: `test/baseline` (§8-as vitest
  baseline, a Vitest suite futtatásához kell, NEM session-created)
- Bármilyen más branch, ami NEM mergelt a `refactor/classbase`-ba
  (production branchek, mint `main`, `develop`, stb.)

A SessionStart és Stop hook a `refactor/classbase`-ot kihagyja a
branch-listából (mint permanent anchor), a többi permanent branch
szintén a fehérlistán van.

## Hogyan működik a Stop hook

A `.claude/hooks/stop-guard/core.ts` `decideStopAction` függvénye
egy új szabállyal egészült ki (a meglévő uncommitted memory +
Todo-list szabály MELLETT, nem helyett):

1. A hook entrypoint a session cwd-jében futtatja:
   - `git worktree list --porcelain` → path-okat nézi
   - `git branch --merged refactor/classbase` → töröletlen branchek
2. A path-okat szűri három névtérre (mind a §8 session-created scope):
   - `$HOME/claw-*` (a leggyakoribb, saját convention)
   - `/tmp/claw-*` (a §8-as vitest baseline-tól eltérő prefix)
   - `.claude/worktrees/wf_*` (a Workflow tool isolation worktree-k,
     a CLAUDE.md §8 'Workflow tool isolation worktree' bullet írja le)
3. A branch listát szűri: minden mergelt branch kivéve
   `refactor/classbase` (a session-created branchek általában ide
   kerülnek a FF merge után).
4. Ha bármelyik lista nem üres, a Stop hook blokkol: exit 2,
   stderr-re a lista + a 3-step escalation recipe.
5. A flag `worktreeCleanupNudged` = current-audit-state (NEM
   once-per-session lifecycle flag). A cleanup UTÁN új leak jöhet
   létre (új worktree/branch), és a hook újra blokkol. A
   `state.worktreeCleanupNudged` értéke mindig a jelenlegi leak
   state: `true` ha van leak, `false` ha minden tiszta.

A flag tehát NEM once-per-session (mint az `uncommittedMemoryNudged`,
amely egyszer blokkol sessionenként). A worktree-leftover guard
MINDEN Stop híváskor újra ellenőrzi, mert a leak state változhat
a session során (cleanup → új worktree létrehozás → új leak).

## 3-step escalation recipe

A Stop hook blokk message-jében:

1. `git worktree remove <path> --force` (minden session-created path-ra)
2. Ha a classifier denied: `git worktree prune` (a §8 szerinti
   fallback #1) + `rm -rf <path>` (külön parancs, NEM láncolt)
3. Ha még mindig denied: `AskUserQuestion` a usernek (a
   `settings.local.json` allowlist a `$HOME/claw-*` namespace-t
   közvetlenül engedélyezi, így a cleanup működik)

Branch-ekre:

1. `git branch -d <branch>` (minden mergelt, de nem törölt branchre)
2. Ha a classifier denied: a felhasználó explicit jóváhagyása
   kell (`git branch -d` NEM `[Irreversible Local Destruction]`
   kategória, ritkán kell override)

## Session-end mandatory cleanup protocol

A session utolsó lépése ELŐTT (a Stop hook blokkolás ELKERÜLÉSE):

```
bash scripts/cleanup-session.sh <worktree1> <worktree2> ... <branch1> <branch2> ...
```

Vagy manuálisan, ha nincs script:

```
git worktree remove <path1> --force
git worktree remove <path2> --force
git worktree prune
git branch -d <branch1>
git branch -d <branch2>
git worktree list  # ellenőrzés: NEM szabad session-created path-ot mutatnia
git branch --list  # ellenőrzés: NEM szabad session-created branch-et mutatnia
```

Ha a cleanup-protokol ELŐTT a user-facing summary-t küldöd (pl.
"A munkafolyamat kész"), a Stop hook blokkolni fog (exit 2 +
stderr lista). A helyes sorrend:

1. `git merge --ff-only <SHA>` (a munkafolyamat utolsó commitja)
2. **Cleanup-transaction** (a fenti parancs-sorozat)
3. **Cleanup-verification** (`git worktree list` + `git branch --list`
   üresnek kell lennie a session-created scope-ban)
4. **User-facing summary** (csak KÜLÖN assistant turn-ban, a
   verifikáció UTÁN)

A 2-3 lépést KÜLÖN turn-ban kell futtatni a 4-től, hogy a
self-review ablak legalább 1 assistant turn legyen.

## Kapcsolódó precedensek

- A 2026-09-09-i deep retrospective workflow (`wf_4afcc1d7-0c6`)
  azonosította a structural root cause-t (recall-based rules fail,
  mechanical gates succeed) és az 5 javítási javaslatot.
- A 2026-09-09-i session-lifecycle.md + Stop hook (ugyanebben a
  branch-en, commit `9e751ad` + `91f307f`) a proven template:
  always-loaded rule + mechanical Stop hook + per-session state flag.
- A 2026-08-28, 2026-09-04 TWICE, 2026-09-09 `megint` markerek (4
  corpus hit 11 nap alatt, mind a worktree cleanup-ra).

## Anti-pattern lista (explicit, NE)

- ❌ **Worktree cleanup a session végén NE legyen recall.** A
  Stop hook enforce-eli (mechanical gate), nem a fő ciklus emlékezik.
  A 4 corpus hit bizonyítja, hogy az emlékezet NEM elég.

- ❌ **Branch törlése NE maradjon el a `git worktree remove`
  után.** Mindkettő egyszerre kell, mert a branch a worktree
  nélkül is létezhet, mint dangling ref. A 2026-09-09-i `refactor/
  approval-store-extract` branch a merge után maradt, mert a
  cleanup-sorozat nem terjedt ki rá.

- ❌ **`Settings.local.json` módosítása user explicit kérés
  nélkül.** A SECURITY WARNING erre figyelmeztet (a synthesis
  agent ezt javasolta, de a user explicit jóváhagyása kell).

- ❌ **Silent cleanup a SessionStart-ban.** A session-start
  INJECTION (notification, not enforcement), nem silent `git
  worktree prune`. A silent cleanup veszélyes (felhasználói fájlok
  törlése indoklás nélkül).

- ❌ **A flag `true`-ra állítása egyszer, örökre.** A flag
  current-audit-state, nem lifetime-hásbeen-blocked. Ha cleanup
  történik ÉS új leak jön létre, újra blokkol. A once-per-session
  flag a 2026-09-09 incident FALSIFIED javítási javaslata volt.

- ❌ **Path filter szűkítése csak `$HOME/claw-*`-ra.** A
  Workflow tool isolation worktree-k a `.claude/worktrees/wf_*`
  névtérben vannak, ezek is session-created scope-ba tartoznak. A
  CLAUDE.md §8 'Workflow tool isolation worktree' bullet leírja ezt.

- ❌ **Branch regex szűkítése `refactor/*` / `feature/*`-ra.** A
  session-created branchek bármilyen névtérben lehetnek:
  `agent-fix-*`, `bugfix-*`, `experiment-*`, stb. A mergelt
  branchek listája + `refactor/classbase` kivétel a helyes
  megközelítés.

- ❌ **Cleanup a session UTÁN, nem ELŐTT.** Ha a "munkafolyamat
  kész" user-message ELŐTT nincs cleanup, a user látja a "kész"
  üzenetet + a Stop hook blokkol → két ellentmondó jelzés a
  usernek. A cleanup-transaction MINDIG a user-message ELŐTT
  legyen kész, KÜLÖN assistant turn-ban.