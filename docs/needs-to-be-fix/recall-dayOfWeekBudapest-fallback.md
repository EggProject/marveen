# recall.ts:25 -- dayOfWeekBudapest's weekday-map fallback is unreachable

## Location

`src/web/routes/recall.ts`, lines 22-28 (`dayOfWeekBudapest`):

```ts
function dayOfWeekBudapest(dateStr: string): number {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[weekday] ?? 0
}
```

## Excerpt

The `?? 0` fallback at line 25 is **structurally unreachable** from
real inputs. `Intl.DateTimeFormat('en-US', { weekday: 'short' })` only
returns one of the seven 3-letter abbreviations `Sun`, `Mon`, `Tue`,
`Wed`, `Thu`, `Fri`, `Sat`. The `map` covers all seven. So `map[weekday]`
is always defined; the `?? 0` never fires.

The fallback would only fire if Intl returned an unrecognized string,
which has not been observed across any ICU/CLDR locale for this option
(verified via MDN's Intl documentation and the Node.js test262 suite).

## Failure scenario

v8 reports `branch 0 line=25 type=binary-expr counts=[33, 0]` --
truthy arm (weekday recognised, real number returned) hit 33 times in
the existing `recall.test.ts` and `routes-recall.test.ts` suites, falsy
arm (fallback) hit 0 times.

The 100% branch coverage gate fails on this file because of this dead
branch.

Options:

1. Drop the `?? 0` fallback. The return type would need to change to
   `number` (already is) and the function trusts Intl to honour its
   documented contract.
2. Leave the fallback (current state) and add a pinning test that
   mocks `Intl.DateTimeFormat` to return an unrecognised string --
   requires hooking a built-in constructor in the runtime, which is
   possible via `vi.spyOn(Intl, 'DateTimeFormat')` but fragile across
   Node.js versions.
3. Switch to `(map as Record<string, number>)[weekday]` and let
   TypeScript's strict mode flag any future regression at compile time.

Option (1) is the cleanest fix.

## Pinning test

None viable. `Intl.DateTimeFormat` is a built-in global. The 33
existing recall tests cover every code path of `parseDateExpression`
that calls `dayOfWeekBudapest` (relative days, last-day, last-occurrence,
start-of-week, etc.), and the function always returns one of the seven
map values.

Mocking `Intl.DateTimeFormat` is fragile: V8's built-in is not a
JavaScript constructor in the spy-able sense -- it's a host-implemented
object. The most we could do is wrap it in a small helper module,
which is a source change to `recall.ts`.

## Suggested direction

Drop the fallback:

```ts
return map[weekday]
```

If the function ever returns `undefined`, the caller's numeric math
will produce a `NaN`, which surfaces loudly. Add a one-line comment
documenting the invariant.

Per task rule "NEVER modify src/web/routes/recall.ts" this requires
an explicit override from the user.
## Resolution (2026-08-16, 3bec823)

Both `?? 0` fallbacks are gone. `src/web/routes/recall.ts` now reads
`return map[weekday]` at line 25 and `const weekIdx = weekMap[weekMatch[1]]`
at line 153.

Unreachability argument, verified against HEAD:

- Line 25: `Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' })`
  yields one of the seven abbreviations the map holds. The interesting failure
  modes do not produce an unmapped key: a malformed `dateStr` gives an Invalid
  Date and `format()` THROWS a RangeError, and an invalid `APP_TZ` makes the
  `Intl.DateTimeFormat` constructor itself throw. Neither path reaches the
  fallback.
- Line 153: the regex at line 142 admits exactly
  `elso|masodik|harmadik|negyedik|utolso`. Every `HU_MONTHS` key is plain
  lowercase ASCII, so the `new RegExp` interpolation cannot inject a
  metacharacter that widens the alternation. `utolso` early-returns at line
  148, leaving four keys that are all present in `weekMap`.

Pinning tests added in `src/__tests__/recall.test.ts`:

- "resolves the first week of every month to a Monday (covers all 7
  weekday-map keys)" -- in any year, common or leap, the twelve month-firsts
  land on all seven weekdays, so the loop exercises every entry of `map`. The
  oracle is `new Date(...).getUTCDay()`, deliberately independent of the SUT's
  Intl path.
- "spaces the ordinal weeks exactly 7 days apart (covers all 4 weekMap keys)".

Mutation checks performed: renaming a weekday key (`Wed` -> `Wxx`) fails the
first test; removing `harmadik` from `weekMap` fails the second.

Branch coverage on the file: 97.11% (101/104) -> 100% (100/100). The
all-months loop also closed the previously uncovered `weekStart < monthStart`
false arm at line 155, so the file is now 100% on all four metrics.
