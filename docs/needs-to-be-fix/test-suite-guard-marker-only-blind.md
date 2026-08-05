# test suite: assert-not-live-install guard marker-only design misses non-marker pollution

**Status:** pinned, not fixed (az eredeti, marker-only implementacio rogbitve van a tesztek archivitasaban; a 2026-08-06-os whole-store patch csak forward-fix)

## Location

`src/__tests__/setup/assert-not-live-install.ts:26-30` (regi implementacio):

```ts
const LIVE_MARKERS = [
  join('store', '.dashboard-token'),
  join('store', 'claudeclaw.db'),
  join('store', '.claude-oauth-token'),
]
```

## Excerpt

```ts
const foundMarkers = LIVE_MARKERS.filter((m) => existsSync(join(repoRoot, m)))
if (foundMarkers.length > 0) {
  throw new Error(`REFUSING TO RUN TESTS: ... markers=${foundMarkers.join(', ')} ...`)
}
```

A guard **kizarolag ezt a 3 markert** nezi. Minden mas fajl a `./store/`
alatt lathatatlan.

## Failure scenario

A `db-100.test.ts:1695-1717` `migrateTaskRunsFromJson` teszt a production
checkout `./store/task-run-history.json`-jaba irt (lasd a
`test-suite-store-pollution-store-dir-frozen.md` bug-ot). Az `initDatabase()`
migration atnevezte a fajlt `task-run-history.json.migrated`-re. A teszt
cleanup-logikaja nem allitotta vissza, mert nem letezett backup. Eredmeny:

- `./store/task-run-history.json.migrated` -- benne maradt
- `./store/agent-taskstate/` -- a kovetkezo napokban tovabbi test run-ok
  hoztak letre (az agent-taskstate route teszt sajat sandboxja nem volt
  megfeleloen izolalt)
- `./store/costops-config.json.example` -- egy korabbi, sandboxolas elotti
  costops-config tesztvaltozat hozta letre

A guard egyiket sem latta: a 3 marker kozul egyik sem volt jelen
(`.dashboard-token`, `claudeclaw.db`, `.claude-oauth-token` hianyzott
ebben a checkout-ban). A suite vidaman elfutott, kozben a production
allapotot modositotta.

A user 2026-08-06-os panasza ("direkt szóltam hogy valós müvelet ne fusson
le test közben, megéis a tesztek futása után létrejön a ./store mappa") pontosan
ezt az allapotot irta le. A guard nem vedett meg semmit, mert a markerek nem
voltak jelen, csak a generalt artifaktumok.

## Pinning test

Nincs kozvetlen pinning test, mert a guard-ot tesztelo file-nak
szandekosan egy MARKER jelenletere kellene szamitania, hogy bebizonyitsa
a regi implementacio lyukas. A jelenlegi repo-ban viszont a **kovetkezo
kornyezeti allapot PIN-eli** a bugot:

```sh
cd /Users/eggp/marveen-develop/test-baseline
# Tegyuk le a markereket (szimulalva a "production" allapotot), DE
# tartsuk meg a marker-only guard altal LATHATATLAN artifaktumokat.
rm -rf store/
mkdir -p store/
echo '[]' > store/task-run-history.json.migrated
mkdir -p store/agent-taskstate/

# Regi guard: nem latja a fenti artifaktumokat, atengedi a suite-t.
# Uj guard: elbukik, mert a ./store/ konyvtar letezik.
```

A **PINNED BUG test** (ami most mar a forward-fix miatt atment) az
uj implementacio szempontjabol:

```ts
it('PINNED BUG: any file under ./store/ must trigger the guard', () => {
  // A regi implementacio csak a 3 markert nezte. Ha barmelyiket
  // torlod, a guard atengedte a suite-t, meg ha kozben tucatnyi
  // mas test-fajl szemetelte a ./store/-t.
  //
  // Az uj implementacio a teljes ./store/ konyvtartalmat nezi,
  // es barmely fajl jelenlete eseten hard-fail-re fut.
  //
  // Ez a teszt statikus szinten dokumentalja: a guard-nak most
  // mar NEM szabad marker-only-nak lennie. Ha valaki visszaallitja
  // a regi 3-markeres implementaciot, ez a teszt elbukik.
  const guardSource = readFileSync(
    resolve(__dirname, 'setup/assert-not-live-install.ts'),
    'utf-8',
  )
  expect(guardSource).toMatch(/existsSync\(.*['"]store['"]\)/)
  expect(guardSource).toMatch(/readdirSync/)
})
```

## Suggested direction

A javitas **mar megtortent** (2026-08-06, whole-store detection a
guard-ban: `existsSync(storeDir)` + `readdirSync(storeDir)`).

A hosszabb tavu, rendszerszintu megoldas:

1. **A guard maradjon kotelezo** minden test file elott (a `setupFiles`
   config-ban, ahogy most is). Ne lehessen kikerulni `// @vitest-environment`
   vagy hasonlo annotaciokkal.

2. **Az artifactumok automatikus takaritasa**: egy `setupFiles` masodik
   file (pl. `cleanup-store-sandbox.ts`) minden test elott ellenorzi,
   hogy a `./store/` letezik-e. Ha igen, **es** nincs benne egyik marker
   sem, akkor NEM torli (mert akkor elszall azonnal), hanem logol egy
   warningot: "test runs previously polluted ./store/ with non-marker
   artifacts; consider scrubbing manually".

3. **CI gate**: a CI pipeline-nak a test futtatas elott `rm -rf ./store/`
   kellene tennie, hogy tiszta allapotbol induljon. Ezt egy uj
   `package.json` script (`pretest: "rm -rf store/"`) garantalja.

4. **Dokumentacio** a `README.md`-ben vagy egy kulon `docs/testing.md`-ben:
   "Tests must run from a fresh checkout or worktree. If `./store/` exists
   from a previous test run, the suite will refuse to start. Use
   `git worktree add /tmp/claw-test` to get a clean run."

A javitas utan a usernek **soha tobbet nem kell** `./store/` pollutiot
latnia; ha megis megjelenik, az azonnali hard-fail a suite-ban.
