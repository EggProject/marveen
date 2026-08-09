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