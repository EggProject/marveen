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