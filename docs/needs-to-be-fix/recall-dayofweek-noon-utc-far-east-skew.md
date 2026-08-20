# routes/recall.ts:21-31 -- dayOfWeekBudapest is off by one day for install zones at UTC+12 and beyond

**Status:** RESOLVED (zonedNoon anchor, see commit on `test/baseline`). The narrative below is kept as a historical record of the bug, not as an open task.

Filed 2026-08-16 while adding the pinning tests for
`recall-unreachable-defensive-fallbacks`. Not a regression: this behaviour
predates that change, it was simply never asserted on.

## Location

`src/web/routes/recall.ts`, lines 21-31.

```ts
const TZ = APP_TZ  // install zone (config.APP_TZ)

function budapestDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d)
}

function addDays(dateStr: string, days: number): string {
  const ms = new Date(`${dateStr}T12:00:00Z`).getTime() + days * 86_400_000
  return budapestDate(new Date(ms))
}

function dayOfWeekBudapest(dateStr: string): number {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[weekday]
}

function startOfWeek(dateStr: string): string {
  const dow = dayOfWeekBudapest(dateStr)
  const diff = dow === 0 ? -6 : 1 - dow
  return addDays(dateStr, diff)
}
```

## Failure scenario

`dayOfWeekBudapest` anchors the calendar date at 12:00 **UTC** and then asks
for the weekday **in the install zone**. Noon UTC stays on the same calendar
day for any zone in roughly UTC-11..UTC+11, so the two agree there. At UTC+12
and beyond, noon UTC is already the next local day, so the function returns the
weekday of `dateStr + 1`. `addDays` has the mirrored problem: it formats the
shifted instant back through `budapestDate`, which also renders in the install
zone.

The two skews do not cancel, and they are not even constant across the year,
because a zone like `Pacific/Auckland` is UTC+12 in winter and UTC+13 in
summer. So the week start computed for January and the week start computed for
July can land on two different weekdays in the same install.

Reproduced on 2026-08-16 by running the recall suite with the process zone
forced:

```
SCHEDULER_TZ=<tz> TZ=<tz> bun --bun vitest run src/__tests__/recall.test.ts
```

| Zone | UTC offset | "first week of all 12 months starts on the same weekday" |
| --- | --- | --- |
| `UTC` | +0 | holds |
| `Europe/Budapest` | +1 / +2 | holds |
| `Asia/Kolkata` | +5:30 | holds |
| `America/Anchorage` | -9 / -8 | fails |
| `Pacific/Midway` | -11 | fails |
| `Pacific/Auckland` | +12 / +13 | fails (2 distinct weekdays across the year) |
| `Pacific/Chatham` | +12:45 / +13:45 | fails |
| `Pacific/Kiritimati` | +14 | fails |

User-visible effect: on such an install, "múlt héten", "ezen a héten" and
"<hónap> első hete" select a range that starts on the wrong day, so the recall
result silently includes one day too many at one end and misses one at the
other.

`APP_TZ` is operator-configurable (`SCHEDULER_TZ` in `.env`, falling back to
the process zone), so this is reachable in a real deployment, not only in a
forced test environment.

## Suggested direction

Anchor the weekday lookup at local noon in the install zone rather than at noon
UTC, so the instant cannot cross a day boundary in either direction. The
existing `budapestDate` / `sv-SE` formatting pattern already gives an ISO date
in the install zone, so one option is to derive the weekday from the same
formatter output instead of from a separately constructed UTC instant:

```ts
function dayOfWeekBudapest(dateStr: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })
    .formatToParts(zonedNoon(dateStr))
  ...
}
```

where `zonedNoon` builds the instant that is 12:00 **in TZ** for `dateStr`.
Whatever shape is chosen, `addDays` must use the same anchor, otherwise the two
functions disagree again.

## Pinning test

`src/__tests__/recall.test.ts`, "starts the first week of all 12 months on the
same weekday (covers all 7 weekday-map keys)". It holds today for the CI zone
(UTC) and for the documented install zone, and it is the assertion that fails
under the zones listed above. Deliberately NOT weakened to pass everywhere:
passing under `Pacific/Auckland` today would mean asserting the wrong result.

Once this bug is fixed, that test should hold for every zone, and the TZ sweep
above is worth adding to the suite as a loop.
