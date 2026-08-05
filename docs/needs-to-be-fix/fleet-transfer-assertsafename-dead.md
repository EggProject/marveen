# fleet-transfer.ts: assertSafeName is dead code

## Location

`src/web/fleet-transfer.ts`, line 48:

```ts
const SAFE_NAME_RE = /^[a-z0-9][a-z0-9_-]*$/

function assertSafeName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) {
    throw new Error(`Érvénytelen ${field} érték: "${String(value).slice(0, 60)}" -- csak [a-z0-9_-] megengedett.`)
  }
  return value
}
```

## Issue

`assertSafeName` is defined but never called from anywhere in the codebase.
`validateNames()` (line 746) uses `SAFE_NAME_RE.test(...)` inline rather than
going through the central helper.

## Why this is a defect

- The function is unreachable, so the path-traversal defense (B1, line 44 in
  the comment) has TWO divergent implementations with slightly different error
  messages. If the regex is ever loosened or hardened, the inline checks and
  `assertSafeName` will drift.
- The function has zero test coverage because it is dead -- which violates
  the "100% coverage gate" that catches this kind of dead branch.

## Suggested fix (do NOT apply here)

Either delete `assertSafeName` (preferable -- every existing call site uses
the inline `SAFE_NAME_RE.test` form, so removing the helper does not change
behavior), or refactor `validateNames` to call it.

## Coverage gap this caused

`src/__tests__/fleet-transfer-routes.test.ts` covers `validateNames` end-to-end
but cannot exercise line 49 (the function body) because nothing calls the
function. Coverage currently reports lines 49-52 as uncovered -- they are
unreachable rather than missing tests.
