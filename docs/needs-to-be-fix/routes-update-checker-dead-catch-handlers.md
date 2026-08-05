# Dead `.catch(() => {})` handlers in startUpdateChecker

## Summary
The two arrow functions registered as `.catch(() => {})` in
`startUpdateChecker` (src/web/update-checker.ts:255,256) are unreachable.
`refreshUpdateStatus()` never rejects — every error path is converted into a
`status.error` string and the function always resolves with a `UpdateStatus`.

## Affected lines
- src/web/update-checker.ts:255 — `setTimeout(() => { refreshUpdateStatus().catch(() => {}) }, 10_000)`
- src/web/update-checker.ts:256 — `setInterval(() => { refreshUpdateStatus().catch(() => {}) }, 15 * 60_000)`

The outer arrow at col 19 (setTimeout callback) and col 27 (setInterval
callback) ARE exercised by every refresh tick. The inner catch-handler arrows
at col 55 and col 63 are NEVER called because no path in `refreshUpdateStatus`
throws.

## Why this matters
Two v8-counted functions are dead. The new 100% test suite hits 100%
statements/branches/lines and 88.23% functions (15/17). The remaining 2
functions are unreachable without modifying the source.

## Options to fix (do NOT apply without discussion)

### Option A — Make refreshUpdateStatus actually reject on failure
Remove the `try/catch` wrappers around the GitHub calls (or re-throw after
recording `status.error`). This makes the `.catch()` handlers reachable and
gives `startUpdateChecker` a meaningful guarantee that a transient network
blip won't crash the polling loop. Slight behavior change: callers that
`await` `refreshUpdateStatus()` now need to handle rejections.

### Option B — Delete the `.catch()` clauses
If we trust `refreshUpdateStatus` to always resolve, the `.catch(() => {})` is
noise. Removing it is a one-line change and is the simpler answer if no one
ever wants to reject from `refreshUpdateStatus`.

### Option C — Leave as-is and accept 88.23% function coverage
Acknowledged dead code but it documents the defensive intent (in case a future
change does start rejecting). The current test suite documents the gap.

## Reproduction
```sh
npx vitest run src/__tests__/update-checker-routes.test.ts \
  --coverage --coverage.include='src/web/update-checker.ts'
```
Look at `f[14]` and `f[16]` in `coverage-final.json`: both are `0` (the catch
arrow handlers). All other functions report a hit count of `2` or higher.

## Notes for future test authoring
Any test attempting to "cover" these two arrows must somehow force
`refreshUpdateStatus()` to reject. The current implementation has no `throw`
statement outside the caught try-block, so this is not achievable from a test
alone.
