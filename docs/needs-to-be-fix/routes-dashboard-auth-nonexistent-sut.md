# routes/dashboard-auth.ts does not exist; task brief references the wrong path

## Summary

The "100% coverage for src/web/routes/dashboard-auth.ts" task brief
points at a file that does not exist. The actual file with the matching
name lives one directory up, at `src/web/dashboard-auth.ts`, and it is
already covered at 100% by `src/__tests__/dashboard-auth.test.ts`
(see task #67, completed).

## What was requested

> Write vitest tests for src/web/routes/dashboard-auth.ts to reach 100%
> coverage.
>
> Mock: '../db.js', '../config.js', '../logger.js',
> '../web/auth-gate.js', '../web/auth-sessions.js', plus whatever
> dashboard-auth.ts imports.
>
> Tests go in src/__tests__/dashboard-auth-routes.test.ts.

## Why this is wrong

1. No such file: `src/web/routes/dashboard-auth.ts` does not exist.
   `ls src/web/routes/` shows only:
   `agent-conversation.ts`, `agent-taskstate.ts`, `agent-terminal.ts`,
   `agents-skills.ts`, `agents.ts`, `approvals.ts`, `audit-log.ts`,
   `auth.ts`, `autonomy.ts`, `background-tasks.ts`, `connectors-hu.ts`,
   `connectors.ts`, `costs.ts`, `daily-log.ts`, `docs.ts`,
   `federation.ts`, `fleet-q.ts`, `fleet.ts`, `ideas.ts`, `kanban.ts`,
   `marveen.ts`, `memories.ts`, `messages.ts`, `migrate.ts`,
   `onboarding.ts`, `overview.ts`, `profiles.ts`, `recall.ts`,
   `research.ts`, `schedules.ts`, `security.ts`, `settings.ts`,
   `skill-usage.ts`, `skills.ts`, `spans.ts`, `static.ts`, `status.ts`,
   `token-usage.ts`, `tool-log.ts`, `types.ts`, `updates.ts`,
   `vault-ssh-keys.ts`, `vault-ssh.ts`, `voice.ts`.
   No `dashboard-auth.ts` is present.

2. The actual `dashboard-auth.ts` lives at `src/web/dashboard-auth.ts`
   (sibling of `auth-gate.ts` and `auth-sessions.ts`, NOT a child of
   `routes/`).

3. The SUT's real imports are:
   ```
   import { existsSync, mkdirSync, readFileSync } from 'node:fs'
   import { join } from 'node:path'
   import { randomBytes, timingSafeEqual } from 'node:crypto'
   import { PROJECT_ROOT } from '../config.js'
   import { atomicWriteFileSync } from './atomic-write.js'
   ```
   The brief's mock list (`../db.js`, `../logger.js`,
   `../web/auth-gate.js`, `../web/auth-sessions.js`) does not appear in
   any form. Only `../config.js` matches, and `./atomic-write.js` is
   unaccounted for.

4. The SUT is already at 100% coverage. The file
   `src/__tests__/dashboard-auth.test.ts` exists, runs green, and
   covers both `loadOrCreateDashboardToken` and `checkBearerToken`
   including all branch combos (env precedence, file cache trim,
   regenerate path, mkdirSync recursive, mode 0o600, existsSync throw,
   readFileSync EACCES, every Bearer-prefix and length-match branch).

## Evidence

- `find src -name "dashboard-auth*"` returns:
  - `src/web/dashboard-auth.ts`
  - `src/__tests__/dashboard-auth.test.ts`
  - `docs/dashboard-auth-recovery.md`
  No `src/web/routes/dashboard-auth.ts` exists.
- `grep -E "^import" src/web/dashboard-auth.ts` confirms the import
  list above; none of `db.js`, `logger.js`, `auth-gate.js`,
  `auth-sessions.js` is imported.

## Impact

Creating `src/__tests__/dashboard-auth-routes.test.ts` with the brief's
mock list would:

- target a non-existent SUT (vitest `--coverage
  --coverage.include='src/web/routes/dashboard-auth.ts'` would either
  produce an empty coverage report or fail to resolve the include
  glob);
- mock modules the SUT does not depend on (db, logger, auth-gate,
  auth-sessions), which would be dead stubs;
- leave `../config.js` and `./atomic-write.js` (the SUT's actual
  imports) unmocked, so the real implementations would run.

That is silently wrong work. Surfacing the brief error is cheaper than
fixing it.

## Suggested fix

If 100% coverage for `dashboard-auth` is still a goal, point the brief
at `src/web/dashboard-auth.ts` and use the existing
`src/__tests__/dashboard-auth.test.ts`. No new test file is needed;
the existing one is already complete (task #67).

If the intent was to cover a not-yet-existing
`src/web/routes/dashboard-auth.ts`, that file must be authored first
before tests can be written.

## Reproduction

```
$ ls src/web/routes/dashboard-auth.ts
ls: src/web/routes/dashboard-auth.ts: No such file or directory

$ find src -name "dashboard-auth*" -type f
src/__tests__/dashboard-auth.test.ts
src/web/dashboard-auth.ts
docs/dashboard-auth-recovery.md
```

## Files inspected

- `/Users/eggp/marveen-develop/test-baseline/src/web/dashboard-auth.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/dashboard-auth.test.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/web/routes/`
  (directory listing)