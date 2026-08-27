# overview-routes.test.ts: "yesterday" timestamp is wall-clock-dependent and fails just past midnight LOCAL

**Status:** pinned, not fixed (a teszt a JELENLEGI viselkedést rögzíti, de a tesztnek van egy time-of-day rejtett előfeltétele)

## Location

`src/__tests__/overview-routes.test.ts:534` (regi implementacio):

```ts
const tsYesterday = now - 25 * 60 * 60 * 1000 // ~25h ago
writeFileSync(join(projectsDir, 'session.jsonl'),
  [
    JSON.stringify({ type: 'user', message: { content: 'today prompt' }, timestamp: new Date(now - 1000).toISOString() }),
    JSON.stringify({ type: 'user', message: { content: 'yesterday prompt' }, timestamp: new Date(tsYesterday).toISOString() }),
  ].join('\n') + '\n',
)
```

`src/web/routes/overview.ts:18-58` (`countUserTurns`):

```ts
function countUserTurns(fromMs: number, toMs: number = Number.POSITIVE_INFINITY): number {
  ...
  for (const fname of readdirSync(absDir)) {
    if (!fname.endsWith('.jsonl')) continue
    const fstat = statSync(absFile)
    if (fstat.mtimeMs < fromMs) continue
    ...
    const ts = e.timestamp ? Date.parse(e.timestamp) : 0
    if (!ts || ts < fromMs || ts >= toMs) continue
    ...
    total++
  }
}
```

## Excerpt

A teszt ket user-turn sort ir egy `session.jsonl`-be: egy "today prompt"-ot `now - 1000`-cel, es egy "yesterday prompt"-ot `now - 25h`-val. A SUT ezutan meghivja `countUserTurns(yesterday, startTs)`-t, ahol `yesterday = startTs - 24h`.

A SUT szuroje `ts >= fromMs && ts < toMs`. A "yesterday" timestamp az `userTurnsPrev` binbe akkor esik, ha `yesterday <= tsYesterday < startTs`.

## Failure scenario

A teszt SIKERES, ha `now - 25h >= yesterday`, azaz ha `now >= startTs + 1h` (a nap 01:00 oraja utan). A teszt ELBUKIK, ha `now < 01:00 LOCAL`, mert:

- `yesterday = startTs - 24h` (midnight yesterday LOCAL)
- `tsYesterday = now - 25h`
- Ha `now = 00:30 LOCAL` (az ejfel utan fel oraval):
  - `yesterday LOCAL = elozo nap 00:00`
  - `tsYesterday LOCAL = ket napja 23:30` (most - 25h = 2 nappal ezelotti 23:30)
  - `tsYesterday < yesterday` → kimarad a "yesterday" binbol
  - `userTurnsPrev = 0` (a sor tobbsegeben kimarad, mert az "elozo nap" binjebe esik)
  - `tasksYesterday = schedYesterday + userTurnsPrev = 2 + 0 = 2` (elvart: 3)

A teszt kizarolag a `countTaskRunsBetween` mockra epul (`schedYesterday = 2` ha `to` definialt), nem figyeli a faliorat. 2026-08-07-en 00:24-kor (UTC+2 LOCAL idozona) a suite futtatasa soran tenylegesen elbukott: a debug logger kimutatta, hogy a "yesterday" timestamp `1785965201548` (LOCAL 2026-08-06 03:35:01), a `yesterday` (LOCAL 2026-08-06 00:00:00) pedig `1785967200000` volt — a kulonbseg ~33 perc, es a teszt azt allitotta, hogy a user-turn benne van a "tegnap" binben, pedig az ejfeli boundary-n kivulre esett.

Megjegyzes: a `countTaskRunsBetween` mock `2`-t adott vissza a `schedYesterday` ertekere, de a `userTurnsPrev` 0-t (mert a szuro kihagyta a tegnapinak szant sort). Tehat a teszt `tasksYesterday = 2 + 0 = 2`-t kapott az elvart `2 + 1 = 3` helyett.

## Pinning test

A javitott teszt (commit `393b3b6` utan kovetkezo commit):

```ts
it('adds the user-turn count to the scheduled-run count for both today and yesterday', async () => {
  H.countTaskRunsBetween.mockImplementation((from: number, to?: number) => {
    if (to === undefined) return 1 // schedToday
    return 2 // schedYesterday
  })
  const projectsDir = join(sandboxHome, '.claude', 'projects', 'p1')
  mkdirSync(projectsDir, { recursive: true })
  const now = Date.now()
  const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0)
  const startTs = startOfDay.getTime()
  const tsYesterday = startTs - 1 * 60 * 60 * 1000 // 1h after midnight yesterday -- always inside [yesterday, startTs)
  writeFileSync(join(projectsDir, 'session.jsonl'),
    [
      JSON.stringify({ type: 'user', message: { content: 'today prompt' }, timestamp: new Date(now - 1000).toISOString() }),
      JSON.stringify({ type: 'user', message: { content: 'yesterday prompt' }, timestamp: new Date(tsYesterday).toISOString() }),
    ].join('\n') + '\n',
  )

  const { json } = await call()
  expect(json().tasksToday).toBe(2)
  expect(json().tasksYesterday).toBe(3)
})
```

A regi `now - 25h` csak akkor volt jo, ha most >= 01:00 LOCAL. A `startTs - 1h` mindig a tegnap 01:00 LOCAL-re esik, ami mindig benne van a `[yesterday, startTs)` binben.

## Suggested direction

A javitas megtortent: `now - 25h` → `startTs - 1h`. A hasonlo mintat minden olyan tesztben alkalmazni kell, amelyik "tegnap" timestamp-et hasznal faliorat-aramlasra epulo szurovel szemben.

Hosszabb tavon: a teszt harness hasznalhatna `vi.useFakeTimers()` + `vi.setSystemTime(...)` egy ismert LOCAL idore (pl. 2026-06-15 14:30 LOCAL), es minden `Date.now()` / `new Date()` hivas ezt az idot adna vissza. Ez kikuszobolne az osszes time-of-day flaket.

Meg egy megfontolas: a `countUserTurns` `fromMs`/`toMs` parameterei abszolut idok (ms epoch-ban), de a `--bin--` filozofiajuk tegnap/ma. Ha a parameter inteface megvaltozna `bins: { yesterday: [from, to]; today: [from, to] }`-ra, akkor a teszt parameterezheto lenne, es a wall-clock-aramlas megszunne.

## Applied

Applied: 2026-08-17 9be7a59 — test code already updated; low.md row closed.
