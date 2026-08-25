# recall.ts: two unreachable defensive `?? 0` fallbacks block 100% branch coverage

## Location

`src/web/routes/recall.ts`, lines 25 and 153.

```ts
// line 25, inside dayOfWeekBudapest
const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(d)
const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
return map[weekday] ?? 0

// line 153, inside the HU_MONTHS loop in parseDateExpression
const weekMap: Record<string, number> = { elso: 0, masodik: 1, harmadik: 2, negyedik: 3 }
if (weekMatch[1] === 'utolso') {
  /* early return */
}
const weekIdx = weekMap[weekMatch[1]] ?? 0
```

## Excerpt

Both are defensive `?? 0` fallbacks. No public input can reach the `0` arm of
either expression: every value the lookup map can be asked for is already a
key. Each is dead for a different structural reason.

**1. `dayOfWeekBudapest`'s `?? 0` arm (line 25).**

The `Intl.DateTimeFormat('en-US', { weekday: 'short' })` form has exactly
seven outputs (`Sun`, `Mon`, `Tue`, `Wed`, `Thu`, `Fri`, `Sat`). The map
above has all seven as keys. The `?? 0` arm is reachable only if the host
locale emits a short-form weekday that is NOT one of those seven -- which
en-US never does. With this codebase pinned to en-US the fallback is dead.

**2. `parseDateExpression`'s `weekIdx ?? 0` arm (line 153).**

The regex captures one of `elso | masodik | harmadik | negyedik | utolso`.
The `utolso` branch returns early (line 148-152), so by the time control
reaches `weekMap[weekMatch[1]]`, `weekMatch[1]` is constrained to
`elso | masodik | harmadik | negyedik`. All four are keys in `weekMap`.
The `?? 0` arm is reachable only if the regex captured something outside
that set, which the alternation forbids.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives every public input shape of `dayOfWeekBudapest` and the
   HU_MONTHS week-ordinal branch (every day name, every month name, every
   week ordinal, the `utolso` early return, and the `?? 0` arm not taken).
2. The Intl en-US weekday outputs never include a value outside the seven
   keys, so v8 records `map[weekday] ?? 0` as 7-of-7 taken, 0-of-1 not taken.
3. The HU week-ordinal alternation never captures outside the four keys,
   so v8 records `weekMap[weekMatch[1]] ?? 0` as 4-of-4 taken, 0-of-1 not
   taken.
4. Branch coverage caps at 97.11% (101/104) while statements, lines and
   functions all reach 100%. The remaining 3 branches are the two `?? 0`
   fallbacks here plus the `to > today ? today : to` clamp on line 116
   (which IS reachable through `0 hete` and is covered by a pinning test).

Unlike the `auto-restart-runner` `??` fallbacks (which were reachable by
patching `Map.prototype.get`), these two have no test-side lever: they are
gated on the lookup map being complete, not on any mockable collaborator.
Reaching them requires editing the source.

## Pinning test

`src/__tests__/routes-recall.test.ts`. The reachable siblings are covered
so the gap is exactly the two `?? 0` arms above:

- `describe('HU day-of-week keys')` -- every one of the seven HU day keys
  is exercised (`hetfo`, `kedd`, `szerda`, `csutortok`, `pentek`, `szombat`,
  `vasarnap`), proving the dow lookup always gets a valid weekday key.
- `describe('HU month + week ordinal')` -- all four numbered ordinals
  (`elso`, `masodik`, `harmadik`, `negyedik`) are exercised, proving the
  weekMap lookup never sees a missing key. `utolso` is covered separately.
- `describe('unreachable defensive fallbacks (pinning tests)')` -- two
  structural assertions mirror the SUT maps and confirm every reachable
  key is present, pinning the gap as a coverage artifact (not a runtime
  defect).

## Suggested direction

Two independent one-line edits; each removes the dead arm without changing
behaviour.

(a) Line 25 -- drop the `?? 0`, since the type already guarantees the map
    covers every reachable key:

    ```ts
    return map[weekday]
    ```

    Tightening `map` to a literal type (`Record<'Sun' | 'Mon' | ... | 'Sat', number>`)
    would make this provable to the compiler rather than by inspection.

(b) Line 153 -- drop the `?? 0`, since the regex alternation restricts
    `weekMatch[1]` to keys the map covers:

    ```ts
    const weekIdx = weekMap[weekMatch[1]]
    ```

    Or, equivalently, inline the four values into a switch:

    ```ts
    const weekIdx = weekMatch[1] === 'elso' ? 0
                  : weekMatch[1] === 'masodik' ? 1
                  : weekMatch[1] === 'harmadik' ? 2
                  : 3
    ```

    -- this also reads more naturally than the lookup map.

Per task rule "NEVER modify src/web/routes/recall.ts" the source edits are
blocked until the user overrides; the test suite documents the gap and
pins every reachable sibling branch.
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
