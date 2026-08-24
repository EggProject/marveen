# routes/recall.ts:25 - TS strict blocks the safe-delete

## Reason

Attempted to drop `?? 0` from `return map[weekday] ?? 0` in
`dayOfWeekBudapest`. After removal, `map[weekday]` returns
`number | undefined` (Record index access), and the function's declared
return type `number` trips TS2769 ("Type 'number | undefined' is not
assignable to type 'number'").

## Resolution (superseded by `## Resolution (2026-08-16, 3bec823)` below)

> The premise in this section was wrong -- see the bottom-of-file note
> "The premise recorded in this MD was wrong" for details. The fix
> landed in commit `3bec823` and removed both `?? 0` fallbacks. The
> "Edit reverted" prose below is kept for historical record only.

Edit reverted. `?? 0` fallback restored. Even though
`Intl.DateTimeFormat('en-US', { weekday: 'short' })` is documented to
return one of the seven keys, TS strict-generics cannot prove this and
the function's public return type is `number`.

## See also

The same pattern blocks the deletion at `routes/recall.ts:153` -
`weekMap[weekMatch[1]] ?? 0` - so do not attempt that edit either
until the return type is widened or a type guard is introduced.

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

### The premise recorded in this MD was wrong

The "Reason" section above assumed `Record<string, number>` index access
yields `number | undefined`. That only holds under `noUncheckedIndexedAccess`,
which is NOT enabled in this project: `bunx tsc --showConfig` lists no such
option, and `tsconfig.eslint.json` only widens `rootDir`. Measured on the real
tree, `bun tsc --noEmit` reports 1700 errors before the delete and 1700 after,
with zero errors in `recall.ts`. The earlier revert was unnecessary.
