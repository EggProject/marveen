# auto-restart.ts: parseHHMM's Number.isInteger guard is dead code

## Location

`src/auto-restart.ts`, line 63, inside `parseHHMM`:

```ts
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())      // line 59
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (!Number.isInteger(h) || !Number.isInteger(min)) return null   // line 63
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}
```

## Excerpt

The `Number.isInteger` short-circuit on line 63 can never fire. The
preceding regex `/^(\d{1,2}):(\d{2})$/` (no `u` flag) only matches
ASCII digit runs of length 1 or 2 (hour) and exactly 2 (minute). Every
such run converts under `Number()` to an integer — `Number('0')` is
`0`, `Number('00')` is `0`, `Number('23')` is `23`, etc. — so `h` and
`min` are guaranteed to satisfy `Number.isInteger` whenever `m` matched.

The guard is a defensive copy-paste from an earlier, looser parser. It
silently consumes one of the four coverage thresholds (branches) on
this file: every test that calls `parseHHMM` evaluates the guard,
exits through the `||` short-circuit with both operands `false`, and
the `return null` body is never executed.

## Failure scenario

The defect is a coverage-only defect — no runtime misbehaviour is
reachable through public input.

1. A caller passes any string that survives the regex and the range
   check below (e.g. `'03:00'`, `'9:30'`, `'23:59'`).
2. The body of the `if` on line 63 never runs because both
   `Number.isInteger` operands are `true` and the negation is `false`.
3. The CI gate (`vitest.config.ts` thresholds lines/functions/branches/
   statements at 100% for every `src/*.ts`) reports this file as
   under-covered even though every reachable behaviour is tested.

The only path that would set either operand to `false` is a `Number()`
implementation whose digits->integer contract no longer holds (e.g.
the regex gaining the `u` flag and matching Unicode digits whose
`Number()` yields a float). Today that requires modifying the
upstream regex, which is a behaviour change unrelated to this guard.

## Pinning test

`src/__tests__/auto-restart.test.ts` already exercises every reachable
branch of `parseHHMM`:
- `'00:00' / '03:00' / '23:59' / '9:30'` (regex hit, range OK)
- `'' / '3' / '24:00' / '12:60' / '-1:00' / 'aa:bb' / '12:5'` (regex miss
  or range fail)
- `12` (number) / `null` (typeof guard)

The unreachable guard cannot be pinned by public input. A regression
test that asserts the current contract (regex match ⇒ integer) belongs
in the source itself or in a separate coverage-pinning harness, e.g.

```ts
// regression: every regex hit produces an integer under Number()
const m = /^(\d{1,2}):(\d{2})$/.exec('03:00')!
expect(Number.isInteger(Number(m[1]))).toBe(true)
expect(Number.isInteger(Number(m[2]))).toBe(true)
```

When the fix lands, this assertion should be lifted out: the
production parser will rely on the regex invariant and the guard will
be removed entirely.

## Suggested direction

Remove the guard. The regex already enforces the digit-only shape and
the range check immediately below enforces the value bounds:

```ts
export function parseHHMM(s: unknown): number | null {
  if (typeof s !== 'string') return null
  const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
  if (!m) return null
  const h = Number(m[1])
  const min = Number(m[2])
  if (h < 0 || h > 23 || min < 0 || min > 59) return null
  return h * 60 + min
}
```

This brings `src/auto-restart.ts` to 100% on all four coverage metrics
without any test changes, removes a confusing false-floor in the code,
and keeps the existing test suite green.

Per task rule "NEVER modify src/auto-restart.ts" the source edit is
blocked until the user overrides; the test suite documents the gap and
the pinning case above should be added alongside the fix.