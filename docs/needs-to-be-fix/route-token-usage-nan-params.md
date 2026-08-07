# NaN-via-parseInt: numeric query params silently default to NaN

## Location
`src/web/routes/token-usage.ts`, line 41 (`bucketMinutes`), line 83 (`limit`), line 84 (`offset`), line 93 (`min_tokens`).

## Excerpt
```ts
const bucketMinutes = parseInt(url.searchParams.get('bucket') || '60')
const limit = parseInt(url.searchParams.get('limit') || '100')
const offset = parseInt(url.searchParams.get('offset') || '0')
const minTokens = url.searchParams.get('min_tokens')
// ...
minTokens: minTokens ? parseInt(minTokens) : undefined,
```

## Failure scenario
The request handler uses `parseInt` with no fallback for malformed input. A user-supplied `?bucket=abc` makes `parseInt('abc')` return `NaN`. `NaN` is then forwarded to the data layer:

- `getTokenTimeline(NaN, ...)` will compute `Math.floor(NaN / 60000)` = `NaN`, then `Math.ceil(NaN) * 60000` = `NaN`, producing a corrupted bucket key.
- `getTokenDetails({ limit: NaN, offset: NaN, ... })` will call `db.prepare(...).all(NaN, 0)` and most likely receive an SQL error, or, depending on the driver, an empty result.
- `Math.min(NaN, 500)` is `NaN`. The cap is not enforced.

The same hazard applies to `from`, `to`, `min_tokens` (the latter is guarded by `parseInt` returning `NaN` which is falsy, so it falls through to `undefined` — but only because `NaN` is falsy, not because the input is validated).

## Pinning test
The current tests in `src/__tests__/routes-token-usage-full.test.ts` pin the PATH+METHOD dispatch + parameter SHAPE for happy-path inputs. A future safety pin would assert that `parseInt('abc')` is **not** silently forwarded; today the test suite does not restrict this.

## Suggested direction
Replace `parseInt(x)` with a validating helper that returns `undefined` for `NaN`:

```ts
function intParam(v: string | null, fallback: number): number {
  if (v === null || v === '') return fallback
  const n = parseInt(v, 10)
  return Number.isFinite(n) ? n : fallback
}
```

Then `limit = intParam(url.searchParams.get('limit'), 100)` etc. The same helper covers `bucketMinutes`, `offset`, `minTokens`, `from`, `to`. This keeps the route dispatcher tight and gives the data layer the guarantee that every numeric field is either a finite integer or `undefined`.
