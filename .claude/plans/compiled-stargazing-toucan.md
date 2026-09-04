# Cycle 20 — 5 legkisebb needs-fix elem

## Context

A `docs/needs-to-be-fix/` listában 176 bejegyzésből ~104 még nyitott. A user a
legkisebb módosítással és legkisebb bukási eséllyel járó elemeket kéri, a korábbi
ciklusok (17-19) mintájára: fix + pin teszt átírás + önálló commit, mind a
`test/baseline` branchen.

Az öt kiválasztott elem összesen ~20 sor produkciós kód, mindegyikhez van már
landolt precedens a repóban (`22f68f8`, `0d23278`, `08a6460`), és mindegyik
egyetlen fájlra korlátozódik.

**Kizárva ebből a ciklusból:** `memory-digest-empty-trim`,
`routes-docs-inner-catch-no-title-reset`, `routes-fleet-q-body-parse-uncaught`
(a bug MD-jük explicit "NEVER modify <fájl>" baseline-fázisú task szabályt
hivatkozik, külön override kell), és `routes-ideas-body-parse-500` (5 callsite,
3 pin teszt — nem "legkisebb").

## Az 5 fix

### 1. `routes-connectors-hu-config-nostring-token` (1 sor, 0 törő teszt)

`src/web/routes/connectors-hu.ts:82` — `if (!token?.trim())` nem string tokenre
(`{"token":0}`, `{"token":[]}`) TypeError-t dob → 500 a `web.ts:219` catch-ből.

```ts
if (typeof token !== 'string' || !token.trim()) {
```

Teszt: `src/__tests__/connectors-hu-routes.test.ts` (a 641-671 blokk mellé új
case-ek: `{"token":0}`, `{"token":[]}` → 400 `{ ok:false, configured:false, syncOutput:'Token is required' }`).

### 2. `routes-background-tasks-post-invalid-json` (2 sor, 1 pin átírás)

`src/web/routes/background-tasks.ts:147-148` — őrizetlen `JSON.parse` → 500.
Szó szerint a `0d23278` / `08a6460` mintája:

```ts
let data: { agent_id: string; prompt: string }
try { data = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
```

Pin átírás: `background-tasks-routes.test.ts:667-671`
(`rejects.toThrow(SyntaxError)` → `status 400` + `{ error: 'Invalid JSON' }` +
`createBackgroundTaskAtomic` nem hívódik).

### 3. `routes-spans-nan-limit` (3 sor, 1 pin átírás)

`src/web/routes/spans.ts:67` — `Math.min(NaN, 200)` = `NaN` → `LIMIT NaN`
SqliteError. A `22f68f8` (memories) mintája szó szerint:

```ts
const rawLimit = parseInt(url.searchParams.get('limit') ?? '50')
const limit = Number.isFinite(rawLimit) && rawLimit >= 1 ? Math.min(rawLimit, 200) : 50
```

Pin átírás: `spans-routes.test.ts:413-423` (`toHaveBeenCalledWith(NaN)` → `50`),
plusz új case `limit=-1` → `50`.

### 4. `route-token-usage-nan-params` (~9 sor, 0 törő teszt)

`src/web/routes/token-usage.ts:41` (`bucket`), `:83` (`limit`), `:84` (`offset`).
Egy modul-szintű helper a fájl tetején, majd 3 callsite csere:

```ts
function intParam(raw: string | null, fallback: number, min: number): number {
  if (raw === null) return fallback
  const n = parseInt(raw)
  return Number.isFinite(n) && n >= min ? n : fallback
}
```

- `bucketMinutes = intParam(url.searchParams.get('bucket'), 60, 1)`
- `limit = intParam(url.searchParams.get('limit'), 100, 1)` — a `Math.min(limit, 500)`
  clamp a 91. sorban **változatlan marad** (a `limit=1000 → 500` teszt így nem törik)
- `offset = intParam(url.searchParams.get('offset'), 0, 0)` — `min: 0`, mert a 0 érvényes

A `from`/`to`/`min_tokens` ternáriusok **nem változnak**: falsy-coalescelt
`raw ? parseInt(raw) : undefined`, NaN ma sem jut le az adatrétegig, és az
átírásuk a `routes-token-usage-full.test.ts` sok assertjét kockáztatná.

Teszt: új pin case-ek a `routes-token-usage-full.test.ts`-be
(`bucket=abc → 60`, `limit=abc → 100`, `offset=abc → 0`, `limit=-1 → 100`,
`offset=-1 → 0`). Meglévő teszt nem törik.

### 5. `vault-readvault-missing-entries-fatal` (~5 sor, 1 pin átírás)

`src/web/vault.ts:119-122` — a `readVault` a parse-olt JSON-t nyersen adja
vissza, így minden `entries` nélküli shape (`{}`, `[]`, `"str"`, `null`) fatal
minden publikus híváson (`listSecrets`, `getSecret`, `setSecret`, `deleteSecret`,
`getSecretsForEnv`, és a `getMasterKey` belső `readVault().entries.length` guard).

```ts
function readVault(): VaultStore {
  try {
    const raw: unknown = JSON.parse(readFileSync(VAULT_PATH, 'utf-8'))
    if (raw === null || typeof raw !== 'object' || !Array.isArray((raw as { entries?: unknown }).entries)) {
      return { entries: [] }
    }
    return raw satisfies VaultStore
  } catch { return { entries: [] } }
}
```

Megjegyzés a végrehajtónak: `as` tiltott a projektben — a shape-ellenőrzést
lokális `isVaultStore(v: unknown): v is VaultStore` typeguard-ként kell megírni
a fájlban, és a fenti vázlat helyett azt használni. A `satisfies` csak akkor
használható, ha a typeguard már szűkítette a típust.

Pin átírás: `vault.test.ts:422-428` (`expect(() => listSecrets()).toThrow()` →
üres listát ad vissza, illetve a `setSecret` felülírja a hibás fájlt ép
store-ral).

## Végrehajtás — Workflow

Minden a jelenlegi `test/baseline` HEAD-ből indul és ide vezet vissza.
**Nincs worktree izoláció és nincs párhuzamos agent**: az öt fix külön fájlt
érint, de közös git indexet, ezért a workflow **szekvenciális** `agent()`
hívásokat használ (egy `for` ciklus `await`-tel), így nincs commit-verseny.

- **Phase `Fix`** — 5 szekvenciális agent, fixenként egy. Mindegyik:
  1. elolvassa a `docs/needs-to-be-fix/<id>.md`-t és a célfájlt
  2. alkalmazza a fenti diffet (semmi mást nem módosít)
  3. átírja a pin tesztet az új kontraktusra + hozzáadja az új case-eket
  4. `bunx vitest run <érintett teszt fájl>` — zöldnek kell lennie
  5. `git commit` a `fix(<terület>): <leírás> (closes <bug-id>)` formában
  6. visszaadja a SHA-t és a teszt számokat
- **Phase `Verify`** — 1 agent: lefuttatja mind az 5 érintett teszt fájlt egyben,
  `bun tsc --noEmit`-tel ellenőrzi az 5 módosított forrásfájlt (a repo baseline
  1703 tsc hibája miatt csak az új hibák hiányát nézi), majd frissíti a
  `docs/needs-to-be-fix/INDEX.md` 5 sorát `Resolved: 2026-08-17 <sha>`-ra és
  az 5 bug MD-t, végül egy `docs(needs-to-be-fix): ...` commitot csinál.

Push nincs, a commitok lokálisak maradnak.

## Verification

```
bunx vitest run src/__tests__/connectors-hu-routes.test.ts \
  src/__tests__/background-tasks-routes.test.ts \
  src/__tests__/spans-routes.test.ts \
  src/__tests__/routes-token-usage-full.test.ts \
  src/__tests__/vault.test.ts
git log --oneline -7
git status --short   # üresnek kell lennie
```

Sikerkritérium:
1. Mind az 5 teszt fájl zöld, 0 skip.
2. Minden bug-hoz van legalább egy teszt, ami a régi (hibás) viselkedésre
   piros lenne — ezt az agent úgy igazolja, hogy a fix ideiglenes visszavonásával
   megnézi a pirosat, majd visszaállítja.
3. 6 új commit a `test/baseline`-on, tiszta working tree.
4. `INDEX.md` unresolved sorszáma 5-tel csökken.
