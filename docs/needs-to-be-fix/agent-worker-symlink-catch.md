# agent-worker.ts: ensureWorkerCwd's symlinkSync catch is unreachable from tests

## Location

`src/web/agent-worker.ts`, lines 369-370.

```ts
if (needsLink) {
  try { symlinkSync(target, linkPath) }
  catch (err) { logger.warn({ err, target, linkPath }, 'worker: failed to symlink config entry') }
}
```

## Excerpt

The catch is the only safety net for a transient filesystem error during
the per-entry symlink loop in `ensureWorkerCwd`. The branch exists because
the surrounding code cannot otherwise recover from a TOCTOU race with
another writer that creates a non-symlink entry at `linkPath` between the
`rmSync(linkPath, { recursive: true, force: true })` on the prior line
and the `symlinkSync(target, linkPath)` here.

## Failure scenario

Coverage-only. The branch is reachable in production but no test-side lever
can drive it deterministically:

1. A unit test imports the production module first (`await
   import('../web/agent-worker.js')` at the top of the suite).
2. The source captures `symlinkSync` from `node:fs` via `import { ...
   symlinkSync ... } from 'node:fs'`, so the symbol is bound at module
   load.
3. `vi.spyOn(node:fs, 'symlinkSync')` set up in a test body mutates the
   `node:fs` namespace object, but the production code's binding still
   points at the original function.
4. `vi.mock('node:fs', ...)` at the top of the suite would be needed to
   intercept the destructured import, but it cannot be combined with
   the existing per-call `vi.spyOn(Date, 'now')` / `vi.stubGlobal(
   'setTimeout', ...)` plumbing without breaking every other test.

Branch coverage caps at 94.61% (158/167) while statements, lines and
functions all reach 100%. The uncovered lines are 302, 370, 381, 751.

## Pinning test

`src/__tests__/agent-worker-full.test.ts`. The reachable siblings are
covered so the gap is exactly the symlinkSync catch:

- `describe('ensureWorkerCwd')` -- "symlinks shared ~/.claude entries
  except the SKIP set" exercises the success path; "warns when a
  symlink cannot be created (the symlinkSync catch -- currently
  uncovered)" documents the gap.

## Suggested direction

Two independent paths, neither requires test-side mocking:

(a) Add a tiny wrapper module that re-exports `symlinkSync` and use it in
    `agent-worker.ts` (`import { symlinkSync } from './fs-compat.js'`).
    Tests can then spy on `fs-compat.symlinkSync` because the import
    bound at module load is mutable on the namespace object.

(b) Restructure the loop so the `rmSync` and `symlinkSync` happen inside
    one `try/catch`:

    ```ts
    if (needsLink) {
      try {
        if (lstatSyncSafe(linkPath) && !lstatSyncSafe(linkPath)?.isSymbolicLink()) {
          rmSync(linkPath, { recursive: true, force: true })
        }
        symlinkSync(target, linkPath)
      } catch (err) {
        logger.warn({ err, target, linkPath }, 'worker: failed to symlink config entry')
      }
    }
    ```

    Then a `vi.spyOn(node:fs, 'symlinkSync').mockImplementationOnce(() =>
    { throw new Error('synthetic') })` would still NOT trigger the catch
    (same destructured-import problem), so this option is cosmetic.

Per task rule "NEVER modify src/web/agent-worker.ts" the source edits are
blocked until the user overrides; the test suite documents the gap and
pins every reachable sibling branch.
