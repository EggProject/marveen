# Terv — Következő needs-fix elem választása (Cycle 25.5 discussion)

## Context

A `test/baseline` branch jelenlegi állapota:
- Working tree clean, HEAD `696c248` (vault-bindings lezárva 2026-08-18)
- A Cycle 25 workflow (`wf_58397ff8-664`) fut a háttérben, és két safe-delete
  itemet próbál lezárni: `agent-team-trustfrom-nullish-coalesce` (B) és
  `schedule-runner-mcpmissingreason-cache-miss-unreachable` (C). A workflow
  korábbi iterationje az agent-ek code-broadening viselkedése miatt failelt —
  ezért a jelenlegi prompt szigorított safe-delete direktívákkal fut.
- A user most a **futó workflow megzavarása nélkül** a **következő** legkisebb
  such-and-such itemet akarja átbeszélni, amelyik a lezárt batchek mintáját
  követi (safe-delete / 1-line fix + test + docs).

A feladat: a kimaradó safe-delete / small-fix jelöltek közül kiválasztani a
legkisebb, **explicit failure móddal** dokumentált itemet, és a Cycle 26
munkamenet tervét előkészíteni.

## A futó workflow (Cycle 25) és a mostani terv szétválasztása

A `wf_58397ff8-664` workflow a B+C itemeket saját commit stackbe rakja, és a
user pusholja. A mostani terv **nem nyúl** a futó workflow-hoz, nem indul
olyan munkán, amelyik érinthetné a `agent-team.ts` vagy `schedule-runner.ts`
fájlokat. A workflow notification automatikus — a futás utáni teendők
(merge / push verifikáció / docs sync) külön ciklus.

## Jelöltek (kockázat + méret)

A nyitott safe-delete / 1-line fix kategória elemei közül a legkisebbek:

### 1. `openrouter-models-tier1-auto-empty-fallback` (LOW) — **JAVASOLT**

- **Méret:** 1 sor (`??` → `||`) a `src/web/openrouter-models.ts` line 172-n.
- **Failure mode:** amikor a catalog `tier1`-et definiál `auto: ""`-vel (üres
  current pick, weekly task előtt), a `??` nem kapja el, és az üres string
  jut el az Anthropic SDK-ig. A launcher 4xx-et kap, az agent nem indul.
- **Pinning test:** `openrouter-models.test.ts`, "jelenleg ures stringet ad
  (defect: a ?? nem kapja el az ures stringet)" — a comment már jelöli, hogy
  a fix-landoláskor az assertion `'deepseek/deepseek-chat-v3.1'`-re flippel.
- **TS kockázat:** nulla. A `||` operátor típus-ekvivalens.
- **Coverage kockázat:** nincs holt ág, hiszen a `||` mindkét karját a
  meglévő két case (tier1.auto truthy / falsy) már lefedi.
- **Net diff:** 1 sor src + 1 sor teszt assertion flip + 1 sor comment tisztítás
  + 1 sor docs → 4 commit.

### 2. `remote-enroll-fs-lock-vanish-spin` (HIGH) — kisebb, de termelési

- **Méret:** 2 sor (catch-ben ENOENT check), `src/remote-enroll-fs.ts:116-118`.
- **Failure mode:** a `catch` feltétel nélküli, így bármely statSync hiba
  (EACCES, EIO, transient fs error) esetén a loop `await sleep` kihagyásával
  spinnel `retries * delayMs` ideig, majd "could not acquire" hibát dob. A
  lock soha nem szabadul fel, a lock holder nem crashelt.
- **Pinning test:** `remote-enroll-fs-full.test.ts`, "loops without sleeping
  when statSync throws on the contended lock" — az jelenleg a **rossz**
  viselkedést állítja. Fix után az assertion a `sleep` hívásra és a
  reject-re változik.
- **TS kockázat:** alacsony, `code === 'ENOENT'` typeguard.
- **Production kockázat:** közepes — a `acquireLock` termelési kód, a
  recovery most explicit alvást jelent, ami a false-positive stall-ok
  kockázatát csökkenti, de a valódi fs-hibákat stall nélkül kiaknázza.
- **Net diff:** 3 sor src + 1 sor teszt assertion flip + 1 sor docs → 3-4 commit.

### 3. `routes-channel-conflict-probe-selfinflicted-409` (MEDIUM) — közepes

- **Méret:** 5-10 sor src + integration test (ami most nincs).
- **Failure mode:** a `getUpdates` probe evictálja a saját production poller-t
  egy false-positive pane-scan esetén, majd a monitor reapolja és respawnolja
  a "helyreállt" panelt. A log "orphan poller" mondja, miközben nincs orphan.
- **TS kockázat:** közepes — a `getWebhookInfo` API response shape más.
- **Net diff:** 8-15 sor + új response mapping + test mock bővítés → 4-5 commit.

### 4. `agent-process-runtmux-host-truthy-cond-unreachable` (LOW) — NEM 1 sor

- A MD-ben jelzett figyelmeztetés: a safe-delete a 3000ms timeout-ot is
  elveszi a line 978 `runTmux(null, ['kill-session', ...])` (opts nélküli)
  hívásnál. Tehát a `??` jobb-oldal törlése együtt jár egy explicit timeout
  bevezetésével a line 978-on. → **2 sor src módosítás**, nem 1.
- **Production kockázat:** közepes — a line 978 nélküle egy pre-launch
  reap, és ha a tmux session elérhetetlen, határtalan ideig futhat.

### 5. `channel-request-watcher-unreachable-provider-check` (LOW) — NEM safe-delete

- A MD "DO NOT RAW-DELETE (TOKEN LEAK)" figyelmeztetése: a raw safe-delete
  → TELEGRAM_BOT_TOKEN → Slack API bearer header leak. A helyes fix a
  provider paraméterként való hoist (`function lookupChannelName(provider:
  'slack', ...)`), ami structural változás, nem 1 sor.
- **Production kockázat:** magas, ha a refaktor nem teljes.

## Döntési keret

| Jelölt | Branch sor | TS kockázat | Prod kockázat | Net commit | Pinning test kész? |
|---|---|---|---|---|---|
| **openrouter-models** | 1 | 0 | 0 | 4 | Igen (flip) |
| remote-enroll-fs-lock | 2 | 1 | 2 | 3-4 | Igen (flip) |
| channel-conflict-probe | 8-15 | 2 | 3 | 4-5 | Nincs (integration kell) |
| agent-process-runtmux | 2 | 1 | 2 | 3-4 | Nincs (coverage gap) |
| channel-request-watcher | 3-5 (refaktor) | 2 | 3 (ha raw) | 4-5 | Nincs (token leak pin) |

A "smallest" elv alapján a **JAVASOLT** az
**openrouter-models-tier1-auto-empty-fallback**:
- 1 sor src,
- a pinning teszt már készen áll a flip-re (a comment szó szerint jelöli),
- 0 termelési kockázat (csak egy fallback pontosítása),
- 0 TS kockázat (operátor típus-ekvivalens),
- a Cycle 24 mintát követi (1 fix + 1 test flip + 1 docs commit).

A `remote-enroll-fs-lock-vanish-spin` a második jelölt, ha a user a
"termelési bug" jelleget preferálja. A `routes-channel-conflict-probe` és
`channel-request-watcher` kimaradnak (nem smallest, a remote-enroll-nél is
nagyobb termelési kockázat).

## Végrehajtási terv (amennyiben a user az openrouter-models-t választja)

1. **Workflow** (1 ügynök, code-only, isolated worktree):
   - SAFE-DELETE ONLY direktíva, `git diff --shortstat` invariáns check
   - `src/web/openrouter-models.ts:172` — `??` → `||` csere
   - `src/__tests__/openrouter-models.test.ts` "ervenytelen tierKey es
     tier1.auto ures" case — assertion flip `'deepseek/deepseek-chat-v3.1'`
   - Stale comment ("jelenleg ures stringet ad (defect: a ?? nem kapja el
     az ures stringet)") eltávolítása
   - `docs/needs-to-be-fix/INDEX.md` — `Resolved: 2026-08-18 <sha>`
   - Branch: `test/baseline`-ből indul, `test/baseline`-re visszamergelve
2. **Verifikáció workflow-ban:**
   - `bun --bun vitest run src/__tests__/openrouter-models.test.ts` → PASS
   - `bun --bun vitest run` → 11126/11126 PASS (vagy +1 az új case-re)
   - `tsc --noEmit` → 2255 (vagy ±0)
   - coverage report → `openrouter-models.ts` 100% (vagy maradt 100%)
3. **Code review (`/code-review xhigh --fix`)** a végén — kötelező.
4. **Push verifikáció (Pattern 89):** a user pushol, az assistant byte-azonos
   remote verifikációt futtat + CI run lekérést.

## Push irányelv

Push továbbra is tilos az assistant számára. A user a `git push` után
kéri a Pattern 89 verifikációt. A workflow lezárulta után a user kezében
van a push gomb.

## User döntés (a megbeszélés végeredménye)

1. **Jelölt:** `openrouter-models-tier1-auto-empty-fallback` — 1 sor src,
   narrow failure, kész pinning test, 0 termelési kockázat.
2. **Scope:** 1 sor src + 1 sor teszt assertion flip + 1 sor docs (4 commit
   összesen — a stale comment a tesztben marad, a fix önmagát dokumentálja).
3. **Indítás:** párhuzamosan a futó Cycle 25 workflow-val. A workflow csak
   `web/agent-team.ts`-t és `schedule-runner.ts`-t módosítja, az
   `openrouter-models.ts` touchpointja nulla. Commit stackek függetlenek,
   push-juk külön történik.

## Végső végrehajtási terv (4 commit)

Helyesbítés a korábbi tervhez képest: a "stale comment cleanup" opciót a
user **elvetette** — a 4 commit a legsűrűbb, legszárazabb scope. A bug-MD
frissítés és a teszt comment együtt mozog, mint a Cycle 24 minta.

A 4 commit a `test/baseline` branchre:

| # | Üzenet | Fájlok |
|---|---|---|
| 1 | `fix(openrouter-models): use || so empty tier1.auto falls back to deepseek default` | `src/web/openrouter-models.ts` (1 sor) |
| 2 | `test(openrouter-models): invert empty-tier1-auto assertion to expect deepseek default` | `src/__tests__/openrouter-models.test.ts` (assertion flip) |
| 3 | `docs(needs-to-be-fix): mark openrouter-models-tier1-auto-empty-fallback resolved` | `docs/needs-to-be-fix/INDEX.md` (1 sor) |
| 4 | (workflow-stop) — nincs, mert a stale comment a Cycle 24.5 mintát követi a tesztben |

A pinning test már eleve tartalmazza a "jelenleg ures stringet ad (defect:
a ?? nem kapja el az ures stringet)" kommentet. A fix landolásakor a
komment marad, de az assertionát `'deepseek/deepseek-chat-v3.1'`-re
flippeljük, így a komment a jövőbeni olvasónak jelzi, hogy MIÉNT véd a
fix az adott failure móddal szemben.

## Workflow spec (írandó a Cycle 25.5 indításakor)

- **Agent típus:** `general-purpose`, code-only subagent, isolated worktree
- **Safe-delete invariáns:** `git diff --shortstat` insertions ≤ 2, deletions
  ≤ 1 a src fájlra; a teszt fájlban kizárólag az 1 sor assertion flip
- **STOP feltétel:** ha az agent bármi mást tervez (extract helper, type
  guard, új test case, comment rewrite), `restrictive_checks_passed: false`
- **Pre-commit ellenőrzések:**
  - `bun --bun vitest run src/__tests__/openrouter-models.test.ts` → PASS
  - `bun --bun vitest run` → teljes suite green (delta=0)
  - `tsc --noEmit` → 2255 (±0)
  - `coverage` riport → `openrouter-models.ts` 100% marad
- **Code review:** `/code-review xhigh --fix` a workflow végén, kötelező
- **Push:** a user kezében, push után Pattern 89 verifikáció

## Branch layout

```
test/baseline (HEAD: 696c248)
    │
    ├── workflow B+C (fut, agent-team + schedule-runner safe-delete)
    │
    └── workflow D (most indul, openrouter-models 1-line fix)
         ↓ commit stack:
         1. fix
         2. test flip
         3. docs
         ↓
    test/baseline (4 commit előre)
```

A két workflow commit stackje független, a user push-ja külön-külön
történik (vagy egyben, ha a user úgy dönt). A Pattern 89 verifikáció
mindkettőre lefut.
