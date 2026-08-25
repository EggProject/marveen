# recall.ts:153 -- weekIdx `?? 0` fallback is unreachable

## Location

`src/web/routes/recall.ts`, lines 134-156 (`parseDateExpression` week
parsing):

```ts
for (const [name, num] of Object.entries(HU_MONTHS)) {
  const weekMatch = s.match(new RegExp(`${name}\\s+(elso|masodik|harmadik|negyedik|utolso)\\s+het`))
  if (weekMatch) {
    const year = today.slice(0, 4)
    const monthStart = `${year}-${num}-01`
    const monthEnd = endOfMonth(monthStart)
    const weekMap: Record<string, number> = { elso: 0, masodik: 1, harmadik: 2, negyedik: 3 }
    if (weekMatch[1] === 'utolso') {
      const to = monthEnd
      const from = addDays(to, -6)
      return { from, to }
    }
    const weekIdx = weekMap[weekMatch[1]] ?? 0
    ...
  }
  ...
}
```

## Excerpt

The `weekMap[weekMatch[1]] ?? 0` at line 153 is **structurally
unreachable**. `weekMatch[1]` is the captured group from the regex
`${name}\\s+(elso|masodik|harmadik|negyedik|utolso)\\s+het`, so it is
one of exactly those five strings:

- `elso` -> map[0] = 0
- `masodik` -> map[1] = 1
- `harmadik` -> map[2] = 2
- `negyedik` -> map[3] = 3
- `utolso` -> handled by the early-return at line 145-149, never
  reaches line 153

Of the four strings that CAN reach line 153, all four have entries in
`weekMap`. The `?? 0` fallback cannot fire.

The `?? 0` is defensive insurance against a typo in `weekMap` if a
new week-word is added to the regex but forgotten in the map -- but
since `weekMap` is right next to the regex, the only way for them to
diverge is a human edit that introduces one without the other.

## Failure scenario

v8 reports `branch 26 line=153 type=binary-expr counts=[9, 0]` --
truthy arm (weekMap hit, real number returned) hit 9 times across the
existing 22 `recall.test.ts` tests for Hungarian month-week phrases,
falsy arm (fallback) hit 0 times.

The 100% branch coverage gate fails on this file because of this dead
branch.

Options:

1. Drop the `?? 0` fallback. The contract is "the regex captures one
   of the four `weekMap` keys", and the map covers them.
2. Convert the `weekMap` to a `Record` with all five strings as
   keys (including `utolso` -> -1 or similar) and let TypeScript's
   `noUncheckedIndexedAccess` flag the missing-key case at compile time.

Option (1) is the cleanest fix.

## Pinning test

None. The Hungarian week phrases are matched by the regex literally.
A test that bypasses the regex and calls the inner code with an
arbitrary `weekMatch[1]` would require restructuring the source (a
helper function or a public export), which is a source change.

The existing `recall.test.ts` test "parses 'május első hete'",
"parses 'január első hete'", "parses 'március második hete'",
"parses 'december utolsó hete'" cover elso, masodik, and utolso -- the
remaining key (harmadik, negyedik) is implicitly covered by the
generic weekMap coverage through the truthy-arm path.

## Suggested direction

Drop the fallback:

```ts
const weekIdx = weekMap[weekMatch[1]]
```

The `weekMap` lookup is exhaustive given the regex. If a future regex
edit introduces a new capture group, the new string will produce
`undefined`, the math below will compute a wrong `from`/`to`, and the
existing tests (covering each of the five words) will fail loudly at
the `it('parses ...')` level.

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

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
