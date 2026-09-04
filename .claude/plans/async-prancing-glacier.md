# Plan: Next smallest needs-fix item

## Context

A `test/baseline` branch 176 MD-tételt halmozott fel a `docs/needs-to-be-fix/` alatt. Az előző ciklusok (23-24) magas súlyosságú funkcionális hibákat zártak (`env-update-mode-downgrade`, `routes-fleet-q-404-leaks-roster`, `routes-fleet-q-body-parse-uncaught`). A kérdés: melyik a **legkisebb és legkisebb bukási potenciállal** járó elem a soron következő ciklushoz.

A "legkisebb bukás" itt azt jelenti: a módosítás ne érintsen production-kritikus utat, a viselkedés ne változzon, és a coverage gate-től függetlenül a tesztek zöldek maradjanak. Ez kizárásos alapon a **defensive code drop** kategóriát jelenti: holt ágak törlése, amelyek public API-n keresztül soha nem érhetők el.

## Szűkített jelöltlista (defensive drop, ≤ 3 sor, 1 fájl)

Az INDEX átnézése és a kód helyszíni ellenőrzése után három, technikailag azonos kockázatú jelölt maradt:

| # | Bug ID | Fájl:Line | Törlendő holt kód | Miért nulla kockázat |
|---|---|---|---|---|
| A | `vault-bindings-unreachable-coverage` | `src/web/vault-bindings.ts:163` | `if (val.length <= 6) return '***'` | `maskValue` egyetlen hívója a `scanMcpConfigs` (line 206), ahol `looksLikeSensitiveValue` (line 168) már kiszűri a <8 karakterű értékeket; a `val.length <= 6` ág soha nem fut le. |
| A | `vault-bindings-unreachable-coverage` | `src/web/vault-bindings.ts:236` | `if (!env) return false` | `serverHasVaultRefs` két hívója (line 124 és line 338) előtt `if (!serverCfg.env) continue` guard van; `Object.values(undefined)` amúgy is `[]`-t ad, így `.some()` `false`-szal tér vissza. |
| B | `channel-invites-unreachable-defensive-branches` | `src/web/channel-invites.ts:108` | `if (!store.invites) return 0` | Mindkét hívó (`revokeInvite` line 181, `runInviteMonitorTick` line 220/242) előtt guard van; a függvény belsejében a check redundáns. |
| B | `channel-invites-unreachable-defensive-branches` | `src/web/channel-invites.ts:236` | `if (access.pending)` | `Object.entries(access.pending || {})` korábban `{}`-re cserél, így `pendingEntries.length === 0` miatti `continue` után `access.pending` mindig truthy. |
| C | `recall-dayofweek-noon-utc-far-east-skew` | `src/web/routes/recall.ts:21-31` | **funkcionális javítás**, nem csak drop | Időzóna-horgony átállítása noon UTC → noon install-zone; működés-változás! |

A és B technikailag azonos kockázatú (defensive drop, nulla viselkedés-változás). A választás köztük ízlés kérdése.

## Ajánlott elem: `vault-bindings-unreachable-coverage`

**Indoklás:**
- A legkisebb: 2 sor törlése, 1 fájl (`src/web/vault-bindings.ts`).
- A `vault-bindings` modul kritikus (vault scan), de a törlendő kód public API-n nem érhető el — a kockázat nem a vault integritása, hanem a coverage gate false-positive hibája, amit a holt ágak okoznak.
- A `maskValue` (line 163) és `serverHasVaultRefs` (line 236) függvények nem exportáltak, így a törlés nem érint más modult.
- A MD két megoldást javasol: (a) dead code törlése vagy (b) exportálás unit-teszthez. Az (a) a kisebb.

## Terv (4 commit, sem push)

1. **Fix commit** — `src/web/vault-bindings.ts`:
   - `maskValue` (line 162-165): töröld a `if (val.length <= 6) return '***'` sort; a függvény teste `return val.slice(0, 3) + '...' + val.slice(-3)` legyen.
   - `serverHasVaultRefs` (line 235-238): töröld a `if (!env) return false` guardot; `Object.values(undefined)` amúgy is `[]`-t ad, tehát a `.some(...)` `false`-szal tér vissza.
   - Conventional commit: `fix(vault-bindings): drop dead <=6 maskValue branch and undefined-env serverHasVaultRefs branch`

2. **Teszt commit** — `src/__tests__/vault-bindings.test.ts`:
   - A teszt már ma is dokumentálja a holt ágakat (`'masks short values (<=6 chars) as ***'` line 591 és `'maskValue (via scanMcpConfigs)'` line 1114 describe). Ezeket a kommentárokat frissíteni kell, hogy a fix után is összhangban legyenek.
   - A file-on belüli branch-inventory komment (line 36-37, 63) `maskValue` és `serverHasVaultRefs` sorait frissíteni kell, hogy a törölt ágak ne legyenek inventory-ban.
   - Nincs szükség vi.mock-os eltávolításra — a teszt soha nem érte el a holt ágat, csak dokumentálta.

3. **Docs commit** — `docs/needs-to-be-fix/INDEX.md`:
   - A `vault-bindings-unreachable-coverage` sor `Resolved` oszlopa: `Resolved: 2026-08-18 <short-sha>`.

4. **Verify** — `bun test src/__tests__/vault-bindings.test.ts` + `bun run typecheck` zöld, `git status` clean.

## Végrehajtás

Workflow-val, a `test/baseline` branchról indul és oda megy vissza. A script a `.claude/plans/apply-1-needs-fix.js` néven kerül mentésre. Lépések:

- 1 agent kapja a fenti tervet, sorrendben: fix commit, teszt commit, docs commit, verify.
- A verify lefuttatja a pinning testet + typecheck-et, majd visszaadja a SHÁ-kat.
- A workflow végén a `/code-review xhigh --fix` skill meghívása kötelező.
- A push tilos; minden commit lokálisan marad.

## Workflow

A user kérésére az végrehajtás workflow-val történik:
- 1 agent, `apply-1-needs-fix.js` script a `.claude/plans/` alá.
- Az agent megkapja a fenti tervet, fixenként 1 commit + 1 docs commit, végül verify.
- A `/code-review xhigh --fix` skill a végén kötelező.
- Branch: `test/baseline` → oda megy vissza minden.

## Kérdés a usernek

A/B közül választani kell (azonos kockázat, ízlés kérdése), vagy a C funkcionális javítást választjuk (nagyobb, de valódi bug). A workflow csak a user válasza után indul.
