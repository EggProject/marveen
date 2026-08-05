# test suite: STORE_DIR at module load → live ./store/ pollution from db-100.test.ts migrateTaskRunsFromJson

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti)

## Location

- `src/__tests__/db-100.test.ts:1655-1717` -- a `migrateTaskRunsFromJson` describe-block
- `src/config.ts:12-13` -- `PROJECT_ROOT = join(__dirname, '..')` es `STORE_DIR = join(PROJECT_ROOT, 'store')` modul-import pillanataban fagyasztva
- `src/db.ts` -- `migrateTaskRunsFromJson()` beolvassa `task-run-history.json`-t a `STORE_DIR`-bol (melyet a config.ts import-kor felold)

## Excerpt

`src/__tests__/db-100.test.ts:1655-1669`:

```ts
describe('migrateTaskRunsFromJson', () => {
  it('reads task-run-history.json from STORE_DIR and inserts rows', () => {
    const legacy = join(STORE_DIR, 'task-run-history.json')     // <-- LIVE STORE
    const backup = legacy + '.db100-backup'
    try {
      if (existsSync(legacy)) fs.renameSync(legacy, backup)
      writeFileSync(legacy, JSON.stringify([                       // <-- LIVE WRITE
        { name: 'migrated-task', agent: 'agent-m', ts: 1234 },
```

`src/config.ts:12-13`:

```ts
export const PROJECT_ROOT = join(__dirname, '..')                 // <-- frozen at import
export const STORE_DIR = join(PROJECT_ROOT, 'store')              // <-- never re-evaluable
```

## Failure scenario

A `db-100.test.ts` a `migrateTaskRunsFromJson` migrationt teszteli, es direktben
irja/olvassa a `task-run-history.json`-t a **`STORE_DIR`-en keresztul, ami a
`config.ts` importjakor `__dirname/../store` ertekkel fagyott be**. Ez a module-
szintu konstans:

1. Nem koveti a `CLAUDECLAW_ENV_DIR` env var-t (az kizarolag a `.env`-re hat, lasd
   `src/env.ts:11`, a `STORE_DIR`-re nem).
2. Nem `vi.mock`-olhato utolag, mert a teszt mar importalta a `db.ts`-t,
   ami importalta a `config.ts`-t, ami mar kiertekelte a `__dirname`-t.
3. A `vi.mock('../config.js', ...)` trukul csak akkor mukodik, ha a `db.ts`
   import elott happenezik -- jelenleg a `db-100.test.ts` a modul-top-level
   `await import('../db.js')`-szel hozza be, es a `STORE_DIR` addigra mar
   fagyott.

A teszt legacy fajl cleanup-logikaja egy kellemetlen patterne ervoen hagyja az
artifaktot: az elso futas soran `initDatabase` atnevezi a legacy fajlt
`task-run-history.json.migrated`-re. A cleanup block:
- `try { fs.unlinkSync(legacy) }` -- nem torli a `.migrated` fajlt, mert az
  mar nem a `legacy` neven van.
- `if (existsSync(backup)) fs.renameSync(backup, legacy)` -- a `backup` nem
  letezik (a teszt nem keszitett egyet a friss checkouton, csak akkor masolja,
  ha mar volt egy eredeti fajl), igy ez a sor skipel.
- Eredmeny: **`task-run-history.json.migrated` otthagyva a `./store/` konyvtarban
  az első futas utan, orokre.**

2026-08-06 01:27-kor ez a minta hozta letre az elo `./store/` konyvtarat a
production checkoutban. Az ezt koveto napokban tobb ujabb tesztfuttatas
probalkozott a `task-run-history.json` irassal, de a `migrated` fajl mar
blockolta oket -- a suite egyre kevesebb migrate-path-ot tudott lefedni,
mig a guard eszre nem vette, hogy a `.dashboard-token` hianyzik.

A helyes architekturat mas, megfeleloen sandbox-olo tesztek kovetik:
`src/__tests__/costops-config.test.ts:14-17` `vi.mock('../config.js', ...)`-el
**a teszt fajl ELEJEN** atiranyitja a `PROJECT_ROOT`-ot egy `mkdtempSync`
kovetkezteben kapott tmpdir-re, ES csak AZTAN importalja a costops modult.
Ez a helyes minta; a `db-100.test.ts` megelozotte ezt a mintat, es ez a
fundamentalis problema.

## Pinning test

`src/__tests__/db-100.test.ts:1655-1717` `migrateTaskRunsFromJson`:

- `reads task-run-history.json from STORE_DIR and inserts rows` -- jelenleg
  ZOLD, mert a teszt direktben a `STORE_DIR`-t hasznalja. Ez pontosan a
  PINNED BUG: a teszt csak azert megy at, mert a `STORE_DIR` a production
  checkoutra mutat. Ha a `STORE_DIR` egy sandbox tmpdir lenne (ahogy a
  helyes architektura megkivánja), a teszt elbukna, mert a migration
  nem talalna legacy fajlt.
- `renames file after successful migration, skips if rows already present` --
  hasonloan ZOLD a hibas architektura miatt, es az o cleanup-logikaja
  hagyja az `.migrated` fajlt.

A **fix utan ezek a tesztek elbuknak** -- ez a szandek. Az elvart uj
viselkedes: a `STORE_DIR` sandbox tmpdir, a teszt oda ir, es a cleanup
bizonyosan eltakarit. A pinning megerositesehez egy uj, szandekosan
bukore allitott tesztet lehet hozzaadni:

```ts
it('PINNED BUG: migrateTaskRunsFromJson writes into the LIVE ./store/ ' +
   'because STORE_DIR is frozen at module load', () => {
  // Ha STORE_DIR nem a live checkoutra mutat, ez a teszt nem futtatna
  // migrationt -- direktben demonstralja, hogy a jelenlegi teszt
  // architektura kovetkezteben a production fajlrendszert modositjuk.
  expect(STORE_DIR).not.toBe(join(repoRoot, 'store'))
})
```

## Suggested direction

A **helyes javitas ketreszes**, es az architekturat erinti, nem csak a
tesztet:

1. **`src/config.ts:12-13`** -- `PROJECT_ROOT` es `STORE_DIR` ne legyen
   module-szintu `const`, hanem getter, ami kiolvassa a `CLAUDECLAW_ENV_DIR`
   env var-t (vagy egy uj, kifejezetten erre szolgalo `CLAUDECLAW_STORE_DIR`-t),
   es csak fallbackkent hasznalja a `__dirname`-t.

   ```ts
   export function getProjectRoot(): string {
     return process.env.CLAUDECLAW_PROJECT_ROOT ?? join(__dirname, '..')
   }
   export function getStoreDir(): string {
     return process.env.CLAUDECLAW_STORE_DIR ?? join(getProjectRoot(), 'store')
   }
   ```

2. **`src/db.ts`** -- mindenhol `getStoreDir()`-t hasznaljon `STORE_DIR`
   helyett (a `STORE_DIR` backward-compat exportot megtartva mint
   `getStoreDir()` alias). Ugyanez vonatkozik minden fajra, ami a
   `STORE_DIR`-re epul (`src/costops/config.ts:16-17`, `src/costops/ledger.ts`,
   `src/env.ts` masodlagos felhasznaloi, stb.).

3. **`src/__tests__/db-100.test.ts:1655-1717`** -- a `costops-config.test.ts`
   mintajara: `mkdtempSync` + `vi.mock('../config.js', ...)` + csak UTANA
   `await import('../db.js')`. A cleanup block pedig ne csak az eredeti
   fajlt probalja visszaallitani, hanem egy `afterAll`-ban `rmSync`-elje
   az egesz sandbox-ot.

A mintat tobb test koveti (lasd `src/__tests__/agent-taskstate-routes.test.ts`,
`src/__tests__/db.test.ts` -- mind a `STORE_DIR`-re epitenek). Azokat is
ugyanigy kell atirni a teljes sandbox-izaciohoz.

A javitas utan minden egyes teszt file-on vegig kell menni, es
`vi.mock('../config.js', ...)`-szel sandboxolni oket. A `assert-not-live-install.ts`
guard kesz az azonnali hard-fail-re, ha barmelyik elszall.
