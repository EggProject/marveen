# needs-to-be-fix: federation MD — test migration + type narrowing

## Context

A `docs/needs-to-be-fix/INDEX.md` 177 bug MD-t tartalmaz. A user kérése: a
következő legkisebb, lehető legkisebb kockázatú módosítás(ok) megtervezése
és végrehajtása workflow-val, a jelenlegi branchről indulva és ide
visszatérve.

A Phase 1 Explore + Phase 2 Plan (két független agent) feltárta, hogy a
kezdeti jelölt scope ("két MD összevonva") nem kivitelezhető legkisebb
módon:

- A **`federation-inbox-fedPeer-null-fallback`** MD valóban fix-elhető, de
  a `RouteContext.fedPeer` típus-szűkítés 27+ teszt fájlt és ~30+ helyet
  érint, és a korábbi kampányban (`federation-routes-fedpeer-required-type-narrow-deferred.md`)
  már +71 typecheck hibát produkált. Nem "legkisebb" egy commitban.
- Az **`index-unreachable-coverage`** MD elavult: a `src/index.ts:174`
  (valójában `173`) `error:` ág MÁR le van fedve
  (`src/__tests__/index.test.ts:2739-2796`, "SIGTERM succeeds + SIGKILL
  fails EPERM"). A line 381-383 heartbeat blokk és a line 283
  `buildPidfileLockContext.log.error` már korábban megoldva. Nincs source
  teendő.

A user döntése: csak a federation MD-t, KÉT commitban (test migration
commit először, type narrowing commit utána). Az index MD NEM kerül
végrehajtásra (NO-OP, már covered).

A user kérésének kulcspontjai (érintetlen):
- Először megbeszélni, nem végrehajtani (kész)
- Dupla subagent ellenőrzés a tervezésnél (kész, Plan agent 1 + 2)
- Workflow-val végrehajtás, jelenlegi branchről indul és oda tér vissza
- A végén a user hívja a `/code-review max --fix` skillt (a Skill tool-ból
  `disable-model-invocation` miatt nem hívható)
- A "Documented only" MD-k INDEX.md státuszának frissítése (user jóváhagyta)

## Végrehajtási terv: 2 commit + 1 INDEX frissítés

### Commit 1: test(routes): add fedPeer:null to fixtures, drop undefined test

**Cél:** A teszt fixture-ök felkészítése a típus-szűkítésre anélkül, hogy
bármilyen forráskód módosulna. Ez a commit önmagában nem változtat
viselkedést - csak a tesztekben adja hozzá a `fedPeer: null` értéket,
ahol korábban a mező teljesen hiányzott.

**Módosítandó fájlok (27+ teszt fájl):**

`RouteContext` literált építő tesztek, ahol a `fedPeer` mező hiányzik:
- `src/__tests__/auth-device-keys.test.ts:77`
- `src/__tests__/auth-routes.test.ts:66`
- `src/__tests__/auth.test.ts:262`
- `src/__tests__/agent-terminal-routes.test.ts:195, 343, 509, 616`
- `src/__tests__/approvals-notify.test.ts:28, 46`
- `src/__tests__/background-tasks-routes.test.ts:233`
- `src/__tests__/bridge-enroll.test.ts:194`
- `src/__tests__/connectors-hu-routes.test.ts:142, 803`
- `src/__tests__/costops-api.test.ts:84`
- `src/__tests__/costs-routes.test.ts:91, 113`
- `src/__tests__/main-agent-detail-guards.test.ts:24`
- `src/__tests__/memories-get-agent-id-alias.test.ts:40`
- `src/__tests__/memories-routes.test.ts:179, 729`
- `src/__tests__/messages-routes.test.ts:179`
- `src/__tests__/overview-routes.test.ts:176, 275, 291, 306, 320, 383, 844, 886, 973`
- `src/__tests__/profiles-routes.test.ts:62`
- `src/__tests__/research-routes.test.ts:84`
- `src/__tests__/routes-agent-conversation.test.ts:82`
- `src/__tests__/routes-recall.test.ts:95`
- `src/__tests__/routes-schedules.test.ts:137`
- `src/__tests__/routes-token-usage-full.test.ts:100`
- `src/__tests__/routes-updates.test.ts:294`
- `src/__tests__/routes-vault-ssh.test.ts:216`
- `src/__tests__/security.test.ts:184`
- `src/__tests__/settings-routes.test.ts:163, 553`
- `src/__tests__/skills-local-api.test.ts:49, 60`
- `src/__tests__/status-routes.test.ts:33`

**Törlendő teszt:**
- `src/__tests__/types.test.ts:43-50` — `'accepts fedPeer as undefined (dashboard caller)'` teszt törlése, mert a típus-szűkítés után ez a contract érvénytelen lesz.

**Módosítás:** Minden fenti helyen a `RouteContext` literálhoz adjuk
hozzá a `fedPeer: null` mezőt. A tesztek futása és lefedettsége nem
változhat - csak a típus-szűkítés által megkövetelt mező-kiadás történik.

### Commit 2: refactor(routes): tighten RouteContext.fedPeer to string|null, drop ?? null

**Cél:** A `RouteContext.fedPeer` típusának szűkítése kötelezővé
(`string | null`), és a redundáns `?? null` fallback-ok törlése a
federation route-okból.

**Módosítandó fájlok (2 forrás):**

1. **`src/web/routes/types.ts:17`**
   ```diff
   - fedPeer?: string | null
   + fedPeer: string | null
   ```
   A kommentet is frissíteni kell: "Absent/undefined and null both mean
   ..." → "null means ...". A dispatcher (`src/web.ts:153,171`)
   garantálja a mező kitöltését (`fedPeerForCtx: string | null = ...;
   fedPeer: fedPeerForCtx`).

2. **`src/web/routes/federation.ts` két helyen** (`?? null` törlés):
   - Line 298: `json(res, buildManifest(cfg, ctx.fedPeer ?? null))` → `json(res, buildManifest(cfg, ctx.fedPeer))`
   - Line 329: `const callerPeerId = ctx.fedPeer ?? null` → `const callerPeerId = ctx.fedPeer`

**Nincs runtime viselkedés-változás:**
- A dispatcher mindig kitölti `fedPeer: string | null`-lal
- A `?? null` csak a `null` → `null` leképezést végezte (redundáns)
- A coverage `[1017, 1]` azt mutatja, hogy a falsy ág csak akkor futott,
  amikor `ctx.fedPeer` értéke `null` volt - a típus-szűkítés után ez
  továbbra is `null` marad, csak a `??` eltűnik

### Commit 3: docs(needs-to-be-fix): update INDEX.md

**Cél:** Az INDEX.md és a kapcsolódó MD-k státuszának frissítése.

**Módosítások:**
- `docs/needs-to-be-fix/federation-inbox-fedPeer-null-fallback.md`: "Resolved: <date> <sha>"
- `docs/needs-to-be-fix/federation-routes-fedpeer-required-type-narrow-deferred.md`: "Resolved: <date> <sha>" (a companion MD, ami dokumentálta a +71 typecheck hibát - most a fix sikeresen landolt)
- `docs/needs-to-be-fix/index-unreachable-coverage.md`: "Resolved: <date> <sha> — NO-OP, line 174 already covered by index.test.ts:2739-2796"
- A user által jóváhagyott "Deferred" státusz frissítések a többi unresolved MD-ra (lásd lent)

**"Deferred" státuszra frissítendő MD-k (user jóváhagyta):**
- `keychain-store-insecure-acl` — bár technikailag végrehajtható lenne, nem ebben a menetben
- `message-router-cache-fallback-unreachable` — refaktor kockázatos
- `agent-worker-settings-symlink-preserve` — meglévő teszt a buggy viselkedést pin-eli
- `web-inbound-probe-respawn-grace` — 4 teszt FAIL a mock rendszer miatt
- `channel-coordinator-internals-untestable` — 10+ függvény export
- `web-agent-scaffold-defensive-coverage` — 18 branch törlés
- `routes-agents-br-baseline-partial-coverage` — 67 branch
- `routes-update-checker-dead-catch-handlers` — már RESOLVED (38a3189)
- `web-agent-worker-runviaworker-coverage` — 6+ helper export

A "Documented only" státuszú MD-k (nem kell módosítani, de az INDEX
frissítésben jelezni kell, hogy tudatosan nem fix-áljuk):
- `ci-eslint-typecheck-baseline`
- `heartbeat-brief-rundiceaysweep-not-applicable`
- `test-suite-llm-api-audit-clean`
- `schedule-mcp-precheck-subtree-cycle-defensive`
- `remote-enroll-core-merge-trailing-newline-skip`
- `remote-enroll-fs-rename-failure-cleanup-untestable`

## Kritikus fájlok listája

**Forrás módosítások (3 fájl, ~5 sor):**
- `src/web/routes/types.ts` (line 17)
- `src/web/routes/federation.ts` (lines 298, 329)

**Teszt fixture módosítások (27+ fájl, ~30+ hely):**
- Fenti lista

**Teszt törlés (1 fájl, ~7 sor):**
- `src/__tests__/types.test.ts:43-50`

**Dokumentáció (2-3 MD + INDEX.md):**
- `docs/needs-to-be-fix/INDEX.md`
- `docs/needs-to-be-fix/federation-inbox-fedPeer-null-fallback.md`
- `docs/needs-to-be-fix/federation-routes-fedpeer-required-type-narrow-deferred.md`
- `docs/needs-to-be-fix/index-unreachable-coverage.md`

## Végrehajtási workflow (workflow script a végrehajtáshoz)

A workflow a `Workflow` tool-lal fog futni, a jelenlegi branchről indul
(`test/baseline`) és ide tér vissza. A workflow fázisai:

1. **Setup**: Worktree izoláció a tesztekhez
   - `git worktree add --detach /tmp/claw-test test/baseline`
   - `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-test/node_modules`
   - Minden teszt parancs a `/tmp/claw-test` worktree-ben fut

2. **Commit 1 (test migration)**:
   - 27+ teszt fájl szerkesztése: `fedPeer: null` hozzáadása a RouteContext literálokhoz
   - `src/__tests__/types.test.ts:43-50`: `fedPeer: undefined` teszt törlése
   - `bun --bun vitest run src/__tests__/types.test.ts src/__tests__/web-server.test.ts src/__tests__/routes-federation-full.test.ts` — a módosított teszteknek futniuk kell (még típus-szűkítés nélkül, a meglévő `RouteContext?:` típussal)
   - Ha a tesztek PASS-elnak, commit
   - Commit message: `test(routes): add fedPeer:null to fixtures, drop undefined test`

3. **Commit 2 (type narrowing)**:
   - `src/web/routes/types.ts:17`: típus szűkítés
   - `src/web/routes/federation.ts:298,329`: `?? null` törlés
   - `bun --bun vitest run --coverage src/web/routes/federation.ts` — coverage gate 100% kell
   - `bun --bun vitest run` — teljes suite, regresszió ellenőrzés
   - `bun run typecheck` — typecheck hiba nem nőhet (max +5 tolerancia a baseline-hoz képest)
   - Ha minden PASS, commit
   - Commit message: `refactor(routes): tighten RouteContext.fedPeer to required string|null, drop redundant ?? null`

4. **Commit 3 (docs)**:
   - `docs/needs-to-be-fix/INDEX.md` + 3 MD fájl frissítése a "Resolved" státusszal
   - A "Deferred" státuszú MD-k INDEX.md bejegyzéseinek frissítése
   - Commit message: `docs(needs-to-be-fix): mark federation MDs resolved, defer remaining`

5. **Végső verifikáció**:
   - Teljes suite futtatás a /tmp/claw-test worktree-ben
   - Coverage gate 100% ellenőrzés
   - `git log --oneline test/baseline ^a330462` — a 3 commit látható
   - Ha minden zöld, a workflow kész

## Verifikáció (hogyan teszteljük a változásokat)

**Commit 1 verifikáció (teszt migráció):**
- A teszteknek ugyanúgy kell futniuk, mint a módosítás előtt
- Nincs típus-szűkítés, nincs forrás-módosítás
- `fedPeer: null` hozzáadása nem változtatja meg a teszt-eredményeket
- A `types.test.ts:43-50` teszt törlése csökkenti a tesztek számát eggyel

**Commit 2 verifikáció (típus-szűkítés + ?? null törlés):**
- `bun --bun vitest run src/__tests__/routes-federation-full.test.ts` — manifest + inbox path
- `bun --bun vitest run src/__tests__/web-server.test.ts:1069` — dispatcher fedPeer
- `bun --bun vitest run src/__tests__/types.test.ts` — a leszűkített típust a maradék tesztek fedik
- `bun --bun vitest run --coverage src/web/routes/federation.ts` — coverage 100% kell, különösen a line 298 és 329 branch-eken
- `bun run typecheck` — typecheck hiba ≤ 1708 (baseline 1703 + 5 tolerancia)
- Teljes suite: `bun --bun vitest run` — nincs regresszió

**Commit 3 verifikáció (dokumentáció):**
- Vizuális ellenőrzés: az INDEX.md konzisztens a többi "Resolved" sorral
- A "Deferred" státuszú MD-k státusz-szövege konzisztens
- A `safe-commit-message` skill használata a commit message formázáshoz

**Végső workflow verifikáció:**
- A 3 commit látható a `test/baseline` branch-en
- A 3 commit előtti állapot és utáni állapot között a tesztek száma és a coverage gate nem változott
- A `git status` clean
- A `git stash list` üres (nem használtunk stash-t)

## Kockázat-elemzés és mitigáció

**Közepes kockázat (#1, típus-szűkítés):**
- A korábbi kampányban +71 typecheck hibát produkált
- **Mitigáció:** A Commit 1 (teszt migráció) előkészíti a fixture-öket, így a Commit 2 típus-szűkítés nem produkálhat új typecheck hibát. Ha mégis, a Commit 2 visszagörgethető anélkül, hogy a Commit 1 érintené.

**Alacsony kockázat (#2, ?? null törlés):**
- A `?? null` csak a `null` → `null` leképezést végezte
- **Mitigáció:** A coverage `[1017, 1]` azt mutatja, hogy a falsy ág csak `null` inputon futott - a típus-szűkítés után ez továbbra is `null` marad.

**Nincs kockázat (#3, dokumentáció):**
- Csak szöveges módosítás, nincs kód-impact

**Visszagörgetési terv:**
- Ha a Commit 2 typecheck hibát produkál: `git revert <commit 2 sha>` - a Commit 1 marad, a típus-szűkítés visszaáll, de a teszt fixture-ök `fedPeer: null` értékei megmaradnak (ártalmatlanok)
- Ha a Commit 1 teszt FAIL-t produkál: `git revert <commit 1 sha>` - minden visszaáll az eredeti állapotba

## Következő lépések (végrehajtás)

A workflow script a jelenlegi ülés után fog futni (a user jóváhagyása
után, az ExitPlanMode után). A workflow a `Workflow` tool-lal fog futni,
a fenti fázisokkal.

A `/code-review max --fix` skillt a user hívja manuálisan a terminálban
a workflow befejezése után. Ez a Skill tool-ból nem hívható
(`disable-model-invocation` flag).

A `git push` TILTVA - a commitok lokálisan maradnak, a user dönt a
push-ról és a CI-ről.
