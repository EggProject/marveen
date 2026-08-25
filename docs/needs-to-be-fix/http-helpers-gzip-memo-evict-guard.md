# http-helpers.ts: gzip memo eviction guard is dead code, blocking 100% branch coverage

## Location

`src/web/http-helpers.ts:122` -- `if (oldest !== undefined) gzipMemo.delete(oldest)`
inside `gzipFileCached` (lines 115-126).

## Excerpt

```ts
const gzipMemo = new Map<string, Buffer>()          // 112
const GZIP_MEMO_MAX_ENTRIES = 20                    // 113

function gzipFileCached(filePath: string, etag: string, data: Buffer): Buffer {
  const key = `${filePath}:${etag}`                 // 116 -- always a string
  const hit = gzipMemo.get(key)
  if (hit) return hit
  const gz = gzipSync(data)
  if (gzipMemo.size >= GZIP_MEMO_MAX_ENTRIES) {     // 120 -- size >= 20 here
    const oldest = gzipMemo.keys().next().value     // 121 -- cannot be undefined
    if (oldest !== undefined) gzipMemo.delete(oldest)  // 122 -- false half unreachable
  }
  gzipMemo.set(key, gz)
  return gz
}
```

## Failure scenario

The `oldest !== undefined` guard can never take its false branch, so v8 reports
44/45 branches (97.77%) and the 100% branch threshold in `vitest.config.ts:32`
fails for this file.

`oldest` is `undefined` only when the key iterator is already exhausted, i.e.
when `gzipMemo.size === 0`. But line 122 is reachable only from inside the
`gzipMemo.size >= GZIP_MEMO_MAX_ENTRIES` guard on line 120, where the map holds
at least 20 entries. A `Map` with 20 entries always yields `{ done: false,
value: <key> }` from `keys().next()`. The keys themselves are template literals
(`${filePath}:${etag}`), so they are always strings and never `undefined`.

The `undefined` in the type comes from TypeScript's signature for
`IterableIterator<string>.next()`, which widens `value` to `string | undefined`
because it cannot prove the iterator is non-empty. It is a type-level
possibility with no runtime counterpart.

No test can reach the false half:

- `gzipMemo` and `GZIP_MEMO_MAX_ENTRIES` are module-private with no exported
  accessor, reset hook or size override.
- `gzipFileCached` is private; it is reachable only through `serveFile`, which
  always passes a real `filePath`/`etag` pair.
- `vi.mock` cannot replace a module-internal `const`, and the `Map` global
  cannot be patched to yield `undefined` keys without breaking `gzipSync`
  memoisation semantics for every other test in the file.

## Pinning test

`src/__tests__/http-helpers.test.ts`

The reachable half is pinned by
`serveFile > gzip > evicts the oldest entry once the memo is full`, which
serves 21 distinct compressible `.css` files to drive exactly one eviction and
then re-serves the evicted file to prove the re-gzip path still produces the
correct body. The memo-hit path (line 118) is pinned by
`serveFile > gzip > reuses the memoised gzip body for a repeat request`.

The suite covers 100% statements / 100% lines / 100% functions / 97.77%
branches. That is the highest achievable without modifying
`src/web/http-helpers.ts`.

## Suggested direction

Preferred: drop the guard and use the non-null assertion, since the enclosing
`size >= GZIP_MEMO_MAX_ENTRIES` check already establishes the invariant:

```ts
if (gzipMemo.size >= GZIP_MEMO_MAX_ENTRIES) {
  gzipMemo.delete(gzipMemo.keys().next().value!)
}
```

If the project prefers not to use `!`, annotate instead:

```ts
/* v8 ignore next -- size >= 20 guarantees a key exists */
if (oldest !== undefined) gzipMemo.delete(oldest)
```

Both are one-line changes to `src/web/http-helpers.ts`. Per the task rule
"NEVER modify src/web/http-helpers.ts" neither was applied; this MD is the
authoritative pin until a resolution is chosen.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
