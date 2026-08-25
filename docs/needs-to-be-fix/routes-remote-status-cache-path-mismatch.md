# routes/remote-status-cache: task path does not exist on disk

## Location

Task instructions referenced `src/web/routes/remote-status-cache.ts`. That
file does NOT exist. The actual class lives at
`src/web/remote-status-cache.ts` (one level above `routes/`).

## Excerpt

```
$ ls src/web/routes/ | grep -i remote
(no output)

$ ls src/web/remote-status-cache.ts
src/web/remote-status-cache.ts
```

## Failure scenario

Anyone following the task instructions verbatim would:

1. Look for `src/web/routes/remote-status-cache.ts` and find nothing.
2. Either skip the task or write tests against the wrong import path.

Coverage tooling would not flag this on its own because the test file
in this baseline (`src/__tests__/remote-status-cache-routes.test.ts`)
imports from the actual on-disk location (`../web/remote-status-cache.js`)
and the coverage report verifies 100% on that real file.

## Impact

- The original task description and rule list (`Mock: '../db.js',
  '../config.js', '../logger.js', '../web/auth-gate.js',
  '../web/auth-sessions.js', plus whatever remote-status-cache.ts
  imports`) was authored against a generic Express-route file. The
  actual SUT has NO imports at all -- it is a self-contained generic
  class. No mocks were necessary and none were applied.
- Existing test `src/__tests__/remote-status-cache.test.ts` covers the
  happy path, the TTL refresh, key independence and the throw-with-
  fallback scenario. It never tested `invalidate()` -- the new
  `remote-status-cache-routes.test.ts` covers `invalidate` plus the
  remaining branches (TTL boundary, throw without a fallback, throw
  on a cold cache refilled by a later successful refresh, key overwrite
  via stale re-fetch).

## Suggested direction

The path is wrong in the task description, not on disk. No code change
is required. If `src/web/routes/remote-status-cache.ts` was intended to
exist as a future Express wrapper exposing the cache via HTTP, it does
not exist today and no consumer (`grep -r RemoteStatusCache src/`)
imports such a wrapper -- all callers in `src/web/routes/agents.ts`
use the bare class directly.

Per task rule "NEVER modify src/web/routes/remote-status-cache.ts" the
absence is being left alone; this document records the discrepancy so
the next baseline pass does not waste time hunting for it.

## Resolution

MD retired as a stale path-mismatch record. The actual cache lives at
`src/web/remote-status-cache.ts` and is already imported directly by
`src/__tests__/remote-status-cache-routes.test.ts`; the test file's
coverage include path matches the real on-disk module and the
supplemental suite pushes the module to 100% including the previously
uncovered `invalidate()` path. No follow-up is outstanding.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
