# Task prompt referenced a path that does not exist

## Summary
A coverage task for "src/web/routes/update-checker.ts" was assigned. That
path does not exist in the repo. The update-checker module lives at
`src/web/update-checker.ts` (a sibling of `web/auth-gate.ts`, not a child of
`web/routes/`).

## Why this matters
- The `--coverage.include` flag in the task's run command references the
  non-existent path and produces an empty report.
- The mock list in the rules (`'../db.js'`, `'../config.js'`, `'../logger.js'`,
  `'../web/auth-gate.js'`, `'../web/auth-sessions.js'`) does not match the
  real imports of the actual module (`node:child_process`, `../config.js`,
  `../tool-timeouts.js`). The four "extra" mocks would have no effect on the
  SUT, and the three "real" imports would not be replaced, letting real
  `git` invocations leak into the test suite.

## Resolution taken
Wrote the new suite at `src/__tests__/update-checker-routes.test.ts`
(target name kept from the task brief) but pointed coverage at the real
module (`src/web/update-checker.ts`) and mocked the module's actual imports
(`node:child_process`, `../config.js`, `../tool-timeouts.js`).

## Suggested follow-up
- Update any doc/runbook references to point at the real path.
- If a separate `web/routes/update-checker.ts` file is intended to exist
  (route handler that wraps `getUpdateStatus` / `refreshUpdateStatus`), it
  needs to be created first; the existing handler lives at
  `src/web/routes/updates.ts` and exposes `/api/updates`, `/api/updates/check`,
  `/api/updates/apply`, `/api/updates/status`, `/api/updates/diagnose`.
