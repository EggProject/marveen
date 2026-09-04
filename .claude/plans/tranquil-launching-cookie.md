# Plan: Next smallest, lowest-risk needs-to-be-fix items

## Context

A `docs/needs-to-be-fix/` mappában 177 MD van; az INDEX.md alapján 30+ item még nyitott.
A legutóbbi commit-sor (`0fcb833`-ig) kimerítette a "drop dead guards" minta nyilvánvaló
eseteit, és a `2ec1c99` revert dokumentálta, hogy a `message-router.ts:478-480` cache-fallback
nem egyesíthető más, biztonságosabb halmazokkal. Felhasználói kérés: a következő, lehető legkisebb
módosításokkal járó, legalacsonyabb kockázatú elemek kiválasztása, megbeszélése, majd workflow-ból
futtatása a jelenlegi `test/baseline` branchen.

## Felderített jelöltek (3 Explore agent, 19 MD)

A három agent 19 MD-t térképezett fel. A kockázat szerinti rangsor:

| Kockázat | MD-k | Megjegyzés |
|---|---|---|
| **LOW** (drop dead branch) | `channel-invites-unreachable-defensive-branches` (2) | Tiszta törlés, pinning teszt a `JSON.parse` interceptor eltávolításával |
| **LOW** (annotation only) | `pane-state-defensive-branches` (7) | `/* v8 ignore next */`, 0 logikai változás |
| **LOW** (annotation only) | `agent-team-trustfrom-nullish-coalesce` (2) | `team.trustFrom` típus-szűkítés másik MD-ben van elhalasztva |
| **LOW** (drop dead guards) | `web-agent-scaffold-defensive-coverage` (18) | 18 sorban csak `?? []` / `?? 0` / unreachable `else` arm-ok |
| **LOW** (drop dead guards) | `channel-monitor-unreachable-defensive-branches` (7) | 7 sorban csak típus-szűkítés / reach-deads |
| **LOW** (drop guards, A+B+C) | `message-router` (lines 81, 180-183, 317) — NEM a 478-480! | A `2ec1c99` revert miatt a Block D külön marad |
| **N/A** (resolved) | `routes-update-checker-dead-catch-handlers` (32018-08-18 landolt) | Kihagyjuk |
| **LOW** (annotation) | `channel-request-watcher-unreachable-provider-check` | De a token-leak warning miatt csak annotáció, nem törlés |
| **LOW-MED** | `context-guard-runner-dead-code-branches` (4) | Comment-only az MD ajánlása |
| **MED** (valódi bug) | `recall-dayofweek-noon-utc-far-east-skew` | Timezone logikai bug, anchor-illesztés kell |
| **MED** (behavior change) | `web-port-reclaim-failure-leaves-unbound`, `web-watchdog-survives-close`, `keychain-store-insecure-acl` | Supervisor-facing változás |
| **MED** (refactor) | `web-inbound-probe-cache-sticky`, `web-inbound-probe-respawn-grace`, `web-agent-worker-runviaworker-coverage`, `channel-monitor-test-holes` | Public API bővítés vagy DI |

## Felhasználói döntések (inputra várva megerősítve)

- **Batch scope**: 3 item, mind LOW (channel-invites + pane-state + agent-team)
- **agent-team megközelítés**: Type narrowing + drop `?? []` (a `agent-team-trustfrom-required-type-narrow-deferred.md` MD-t is megoldja)

## Ajánlott batch (3 item, mind LOW, összevonható)

### 1. `fix(channel-invites): drop 2 dead defensive guards`
- **MD**: `docs/needs-to-be-fix/channel-invites-unreachable-defensive-branches.md`
- **Fájl**: `src/web/channel-invites.ts`
  - **Line 108**: `if (!store.invites) return 0` (egyetlen soros guard) → törlendő
  - **Line 236**: `if (access.pending) delete access.pending[pCode]` → `delete access.pending[pCode]` (wrapper törlendő)
- **Teszt**: `src/__tests__/channel-invites.test.ts` (a `describe('unreachable defensive branches (covered via JSON.parse interceptor)')` 1000:1037 — 2 db `it` eltávolítása, mert a guard-ok már nem élnek)
- **Kockázat**: LOW — csak struktúrálatlan dead branch-eket törlünk; a `JSON.parse` interceptor teszt így is dokumentálja, hogy a védőág INVARIÁNS, nem szükséges a futáshoz
- **Precedens**: `1e58ebd`, `fa933c4`, `410ca16`, `a71cc75`, `cd1bc00`, `af4c087`, `d79b787`, `8046287`

### 2. `fix(pane-state): add /* v8 ignore next */ above 7 unreachable defensive branches`
- **MD**: `docs/needs-to-be-fix/pane-state-defensive-branches.md`
- **Fájl**: `src/pane-state.ts` — 7 sorhoz fűzünk annotációt:
  - L1064: `if (box == null) return null` (stuckInputSignature)
  - L1066: `return sig.length > 0 ? sig : null` (stuckInputSignature)
  - L1104: `return sig.length > 0 ? sig : null` (parkedPasteSignature)
  - L1136: `if (box == null) return null` (parkedChannelInput)
  - L1161: `if (box == null) return null` (parkedInputText)
  - L1165: `return flat.length > 0 ? flat : null` (parkedInputText)
  - L1489: `if (!Number.isFinite(seconds) || seconds < 0) return null` (stuckToolCallSignature)
- **Teszt**: `src/__tests__/pane-state.test.ts` — nincs módosítás, a pinning tesztek maradnak
- **Kockázat**: LOW — kizárólag annotáció, 0 viselkedés-változás; az MD kifejezetten ellenzi a load-bearing guard-ok eltávolítását
- **Precedens**: Hasonló `/* v8 ignore next */` megoldás más coverage-gap MD-kben is dokumentálva van

### 3. `fix(agent-team): narrow TeamConfig.trustFrom to required and drop ?? [] fallbacks`
- **MD-k együtt**: `docs/needs-to-be-fix/agent-team-trustfrom-nullish-coalesce.md` + `docs/needs-to-be-fix/agent-team-trustfrom-required-type-narrow-deferred.md`
- **Fájl**: `src/web/agent-team.ts` — 4 konkrét sor
  - **L23 (TeamConfig interface)**: `trustFrom?: string[]` → `trustFrom: string[]` (opcionális → kötelező)
  - **L139 (sanitizeTeamConfig)**: `cleanList(team.trustFrom ?? [], 'trustFrom')` → `cleanList(team.trustFrom, 'trustFrom')`
  - **L191 (cleanupTeamReferences)**: `(team.trustFrom ?? []).filter(...)` → `team.trustFrom.filter(...)`
  - **L192 (cleanupTeamReferences)**: `(team.trustFrom ?? []).length` → `team.trustFrom.length`
- **Type narrowing SAFE-igazolás** (a terv része, nem a workflow-ra bízva):
  - `readAgentTeam` L44-ben: `Array.isArray(raw.trustFrom) ? ...filter(...) : []` → mindig legalább `[]`
  - `readAgentTeam` L48-ban: `{ ...DEFAULT_TEAM, trustFrom: [] }` → explicit fallback
  - `DEFAULT_TEAM` L31-ben: `trustFrom: []` → default érték
  - `writeAgentTeam` L83-89: csak tárol, nem transformál — a bejövő `team` típusától függ
  - **Következtetés**: A `readAgentTeam` MINDIG `trustFrom: string[]` értékkel tér vissza, tehát a `cleanupTeamReferences` L180-ban (`const team = readAgentTeam(other)`) mindig kap nem-undefined `trustFrom`-ot. A típus-szűkítés TS-strict-tel átmegy.
- **Másik MD**: `agent-team-trustfrom-required-type-narrow-deferred.md` is megoldódik ezzel a változtatással
- **Teszt**: `src/__tests__/agent-team.test.ts` — a `cleanupTeamReferences` describe blokk (~L562+) `missing trustFrom` esetre vonatkozó tesztje lehet, hogy `team.trustFrom` hiányát teszteli; ezt át kell írni, hogy `readAgentTeam` default `trustFrom: []` viselkedését tesztelje (vagy törölni kell, ha a `readAgentTeam` már nem tud `undefined` `trustFrom`-ot visszaadni). A `sanitizeTeamConfig` `missing trustFrom` ágát szintén frissíteni kell.
- **Kockázat**: LOW — a `readAgentTeam` és `DEFAULT_TEAM` mindig biztosítanak `trustFrom: []`-t. A TS-strict typecheck (Phase 2 verifikáció) garantálja, hogy nincs `$TS18048: possibly undefined` hiba.

## Workflow struktúra (3 fájl, párhuzamos ágakon)

A workflow 3 fájlon dolgozik, de a commit-ok SZEKVENCIÁLISAN kerülnek a `test/baseline` branchre
(a `git log` linearitása megőrzendő, illeszkedve a repo történetéhez).

```
Phase 1: Per-batch végrehajtás (3 db, egymás után)
  ├─ Batch 1: channel-invites (1 fix + 1 test + 1 docs commit)
  ├─ Batch 2: pane-state (1 fix + 1 docs commit)
  └─ Batch 3: agent-team (1 fix + 1 docs commit)
Phase 2: Végső verifikáció
  ├─ bun --bun vitest run  (teljes suite)
  ├─ bunx tsc --noEmit     (baseline parity)
  └─ working tree clean
Phase 3: /code-review xhigh --fix skill
```

Összesen 7 commit (3 fix + 2 test + 3 docs, ha agent-team + pane-state nem kapnak új tesztet).
A korábbi `1e58ebd` + `b23bccb` + `f1877ea` mintára: `fix` commit → `test` commit (ha kell) → `docs(needs-to-be-fix)` commit.

## Miért biztonságos ez a batch?

1. **Nincs logikai változás**: csak dead branch-eket törlünk (`channel-invites`) vagy annotációt adunk (`pane-state`, `agent-team`)
2. **Nincs típus-szűkítés**: a `pane-state` és `agent-team` MD-k kifejezetten elhalasztják a típus-szűkítést
3. **Nincs public API változás**: nem exportálunk új függvényeket
4. **Nincs supervisor-facing változás**: nem hívunk `process.exit(1)`-et, nem nyúlunk a keychain ACL-hez
5. **Létező pinning tesztek**: minden drop-hoz vagy annotációhoz tartozik pinning teszt, ami dokumentálja az invariánst
6. **Nincs revert-kockázat**: a `message-router:478-480` cache-fallback NEM kerül a batchbe (a `2ec1c99` revert figyelmeztet)
7. **A 3 fájl teljesen független**: `channel-invites.ts`, `pane-state.ts`, `agent-team.ts` — nincs közös állapot, nincs átfedés

## Nem kerül a batchbe (miért)

- **`message-router` Block D (478-480)**: a `2ec1c99` revert egy az egyben dokumentálja, hogy a `??` arm-ok egyszerű cseréje csendes üzenetvesztést okoz. A Block A+B+C (sor 81, 180-183, 317) safe, de **külön tervet** érdemel, mert a `8209fb3`/`f67efca` revert-pár is rávilágított, hogy a teszt-pinning is sérülékeny.
- **`web-agent-scaffold` (18 sor)**: alacsony kockázat, de a batch méretét 18 soros diffszel növelné. Következő körben tárgyalható.
- **`channel-monitor` (7+4 sor)**: alacsony kockázat, de a `channel-monitor-test-holes` MD 4 magánsegédes függvényt akar exportálni, ami public API bővítés. Következő körben tárgyalható.
- **`recall-dayofweek-noon-utc-far-east-skew`**: valódi bug, anchor-illesztés kell, medium kockázat — külön tervet érdemel.
- **`web-port-reclaim-failure-leaves-unbound`, `web-watchdog-survives-close`, `keychain-store-insecure-acl`**: supervisor-facing behavior change, medium kockázat — külön tervet érdemel.

## Végén kötelező: `/code-review xhigh --fix`

A workflow utolsó lépéseként meghívjuk a `code-review` skillt `xhigh` effort-tal és `--fix` móddal.
Ez átvizsgálja a 3 fix commitot, és ha talál javítandót, alkalmazza. A skill a `test/baseline` branch-en
végzi a munkát, nem pushol, és a végén visszajelzést ad.

## Verifikáció (minden commit után)

- `bun --bun vitest run <changed-test-file>.test.ts` — lokális, gyors
- `git diff --stat` — csak a várt fájlok változnak
- Index frissítés: `docs/needs-to-be-fix/INDEX.md` "Resolved" oszlop kitöltése a `docs(needs-to-be-fix)` commitban
- A Phase 2 végén: `bun --bun vitest run` (teljes), `bunx tsc --noEmit`

## Pontos commit-sorrend

```
1. fix(channel-invites): drop 2 dead defensive guards (lines 108, 236)
2. test(channel-invites): remove now-unreachable JSON.parse interceptor tests
3. docs(needs-to-be-fix): mark channel-invites-unreachable-defensive-branches resolved
4. fix(pane-state): add /* v8 ignore next */ above 7 unreachable defensive branches
5. docs(needs-to-be-fix): mark pane-state-defensive-branches resolved
6. fix(agent-team): narrow TeamConfig.trustFrom to required and drop ?? [] fallbacks
7. test(agent-team): update cleanupTeamReferences test for non-optional trustFrom
8. docs(needs-to-be-fix): mark agent-team-trustfrom-nullish-coalesce + agent-team-trustfrom-required-type-narrow-deferred resolved
```

A 8 commit lineárisan a `test/baseline` branch-en landol. A `git push` TILTOTT — a push a useré.

A 6. commit (agent-team type narrowing) előfeltétele, hogy a workflow agent a `readAgentTeam` minden
write-ágánál megbizonyosodjon a `trustFrom: []` alapértékről. Ezt TS-strict typecheck-kel (Phase 2)
ellenőrizzük.

## Nyitott kérdés a userhez

Nincs — minden döntés a tervben rögzített.

A 3-as (`agent-team-trustfrom-nullish-coalesce`) típus-szűkítéses megoldását a fenti "Type narrowing
SAFE-igazolás" blokk támasztja alá konkrét sor-szintű bizonyítékkal. A `readAgentTeam` L44, L48 és a
`DEFAULT_TEAM` L31 mind garantálják, hogy a `trustFrom: string[]` típus-szűkítés TS-strict-tel nem
tör el. A workflow-nak CSAK a tervben leírt 4 sort kell módosítania, plusz ahol a tesztnek frissülnie
kell a `team.trustFrom` opcionális → kötelező változás miatt.
