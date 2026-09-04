# Cycle 24 — `agent-conversation-fractional-limit`

## Context

A `GET /api/agents/:name/conversation` route elfogadja a `?limit=N` query paramétert és ennek alapján vágja az idővonal-bejegyzéseket. Az `src/web/routes/agent-conversation.ts` jelenlegi kódja:

```ts
const limitRaw = Number(url.searchParams.get('limit'))
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : DEFAULT_LIMIT
```

Ha a kliens `limit=2.5`-öt küld, `start = end - 2.5` lesz, és `Array.prototype.slice(2.5)` floor-alg miatt `2`-re kerekít — a route `limit=2.5` ellenére 3 elemet ad vissza. A viselkedés csendes over-fetch: nem 4××-et ad vissza, hanem azt állítja (`count: 3`), hogy 3-at kért a kliens.

A `src/__tests__/routes-agent-conversation.test.ts` `pins the fractional limit returning more entries than requested` (368. sor) pinning testként őrzi a jelenlegi bugos viselkedést, ezért a fix együtt jár a teszt update-jével.

A `docs/needs-to-be-fix/agent-conversation-fractional-limit.md` MD dokumentálja a hibát és két javaslatot ad: (i) `Math.floor` + clamp, (ii) `400` non-integer limittel. Az (i) a kisebb diff és nem változtatja meg az integer bemeneteket, ezért ez a cél.

**Miért most:** a `NEVER modify src/` szabály alá esik, de a korábbi ciklusok (Cycle 22, 23) mintát mutattak, hogy a user explicit jóváhagyássalengedélyezi az src/ szerkesztést konkrét fix-ekre. A `agent-conversation` család a legkisebb MD (≤2 sor), és az inventory is kiemeli, mint a "legkisebb valódi bugfix" opciót.

## Approach

A `limit` parse-sor kiegészítése `Math.floor(limitRaw)`-lal a `Math.min` előtt. A `limit > 0` check a `Math.floor` után is érvényes marad (`0.5 → 0` → `DEFAULT_LIMIT`, `1.7 → 1`). A pinning test frissítése: a `count: 3`-as elvárás → `count: 2` (és az `entries.length` is 2). Nincs új API surface, nincs interface-változás, nincs konfiguráció, nincs docs API-változás.

## Critical files

- `src/web/routes/agent-conversation.ts` — limit parse + clamp (1 sor módosítás: `Math.floor` hozzáadása a `Math.min` argumentumában)
- `src/__tests__/routes-agent-conversation.test.ts` — pinning test frissítése a 368. sor körül (`count` és `length` elvárás: 3 → 2)
- `docs/needs-to-be-fix/INDEX.md` — resolution sor hozzáadása a `agent-conversation-fractional-limit` MD-hez
- `docs/needs-to-be-fix/agent-conversation-fractional-limit.md` — `git rm` (a fix kommitja után, a docs commit előtt vagy után)

## Implementation steps (várt sorrend, workflow-ból)

1. **Fix commit** (`src/`)
   - `src/web/routes/agent-conversation.ts` 1 sor: `Math.min(limitRaw, 2000)` → `Math.min(Math.floor(limitRaw), 2000)`
   - `src/__tests__/routes-agent-conversation.test.ts` pinning test frissítés a 368. sorban
   - Verifikálás: `bun --bun vitest run src/__tests__/routes-agent-conversation.test.ts` zöld, `bunx tsc --noEmit | wc -l = 2255` (baseline)
2. **Docs commit** (`docs/`)
   - `docs/needs-to-be-fix/INDEX.md`: resolution sor + SHA referencia
   - `git rm docs/needs-to-be-fix/agent-conversation-fractional-limit.md`
3. **Code review skill** (`/code-review xhigh --fix`)
   - A skill a fix + docs commitokra fut, bármilyen follow-up findinget commitolunk, mielőtt a user pushol
4. **Drift ellenőrzés**
   - `git rev-list --left-right --count origin/test/baseline...test/baseline` → `N\t0` (lokál ahead, 0 behind)

## Verification

- **Unit tesztek:** `bun --bun vitest run` → mind a 11114 (vagy friss count) PASS. A `routes-agent-conversation.test.ts` a legfontosabb, a pinning test most a javított viselkedést állítja.
- **Typecheck baseline:** `bunx tsc --noEmit 2>&1 | wc -l` → 2255 (a honcho summary-ban rögzített baseline). A fix nem vezet be új TS-hibát (a `Math.floor` típusa `number → number`).
- **Drift:** a fix és docs commitok a lokál `test/baseline` branchon maradnak, push nem történik (user-é).
- **Coverage:** a `src/web/routes/agent-conversation.ts` 100% coverage megmarad (a fix nem változtatja meg a fedett ágak számát).

## Workflow scope

A user válaszolta: **igen, workflow + code-review skill**. Tehát:

- **Phase 1: Implement** — fix + pinning-test update, 1 commit a lokál `test/baseline`-ra.
- **Phase 2: Verify** — `bun --bun vitest run` és `bunx tsc --noEmit`, drift-ellenőrzés.
- **Phase 3: Docs** — INDEX.md frissítés + MD `git rm`, 1 commit.
- **Phase 4: Code Review** — `/code-review xhigh --fix` skill a fix + docs commitokra; a follow-up findingek commitolva a `test/baseline`-ra.

Minden commit a jelenlegi branchról (`test/baseline`) indul és oda tér vissza. Push nem történik (a user-é a push gomb).

## Kockázat és visszafordíthatóság

- **Méret:** 1 sor logikai kód + 1 pinning test refresh (~3-5 sor).
- **Kockázat:** alacsony. `Math.floor` nem változtatja meg az integer inputokat, csak a fractional értékeket normalizálja; a `> 0` check miatt a `0 < x < 1` tartomány `DEFAULT_LIMIT`-re esik (nem tör befelé). A pinning test frissítése a viselkedés megváltozását tükrözi (3 → 2), nem "pinteli a bugot".
- **Visszafordíthatóság:** `git revert <SHA>` visszaállítja a limit-parse sort és a pinning testet; a MD `git rm` visszaállítható `git restore` + commit REVERT-jével.
- **Blast radius:** kizárólag a `limit` query paraméter; más route-ok nem érintettek.
- **Out of scope:** a `agent-conversation-malformed-name-uri` MD-t NEM zárjuk ebben a ciklusban (felhasználó csak az A opciót választotta).
