# auto-restart: parseHHMM's Number.isInteger guard is unreachable (dead branch)

## Where
`src/auto-restart.ts:63`

```ts
if (!Number.isInteger(h) || !Number.isInteger(min)) return null
```

## What
The guard runs immediately after the regex capture on line 59:

```ts
const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim())
if (!m) return null
const h = Number(m[1])
const min = Number(m[2])
if (!Number.isInteger(h) || !Number.isInteger(min)) return null
```

The regex character class `\d` matches `[0-9]` only, and `\d{1,2}` is bounded
to at most two digits. `Number(digits)` is therefore guaranteed to be a
non-negative finite integer (any sequence of digits is a valid integer literal
and Number() never returns NaN/Infinity for one). The guard is dead code:
its only purpose would be to reject regex captures that cannot, in fact,
occur.

## Coverage impact
The v8 tool flags 1 statement + 1 branch as uncovered without a synthetic
spy. The synthetic test in `src/__tests__/auto-restart.test.ts` covers the
branch by forcing `Number.isInteger` to lie.

## How to fix
Delete the guard. It cannot fire. If a future change loosens the regex to
accept, say, hex or a "1.5h" shorthand, REPLACE the guard with a check
that actually matches the new shape -- not a Number.isInteger generic.

Pinning test: `src/__tests__/auto-restart.test.ts` --
"synthetic: Number.isInteger returning false on captured digits short-circuits
to null (line 63 guard)"
