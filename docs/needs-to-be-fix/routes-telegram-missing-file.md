# Defect: src/web/routes/telegram.ts does not exist

**Filed by:** test-coverage pass on src/web/routes/

## Summary

Task requested vitest tests for `src/web/routes/telegram.ts` to reach 100%
coverage. The target file does not exist in this repository and never has
(checked `git ls-files`, `git log --all --diff-filter=AD`, and repo-wide
text search across `*.ts`, `*.json`, `*.md`). No source file, no deleted
file, no documentation references the path.

## Evidence

- `find src -name "telegram*"` returns only:
  - `src/channel-coordinator/telegram-client.ts`
  - `src/web/telegram.ts`            <- the actual telegram code
  - `src/web/telegram-inbox-wake.ts`
  - `src/__tests__/telegram-inbox-wake.test.ts`
- `git ls-files | grep -i telegram` -- same set; nothing under `src/web/routes/`.
- `grep -rn "routes/telegram" .` -- zero hits anywhere outside node_modules.
- The `src/web/routes/` directory contains 44 files (agent-conversation,
  agents, auth, kanban, marveen, security, settings, vault-ssh, voice,
  etc.) but no telegram route.

## Why this matters

The mocks specified for the test
(`'../db.js'`, `'../config.js'`, `'../web/channel-provider.js'`,
`'../web/telegram.js'`, `'../web/discord-group-bootstrap.js'`,
`'../logger.js'`, `'node:https'`) do NOT match the imports of
`src/web/telegram.ts` either, which pulls in `'../config.js'`,
`'../logger.js'`, `'./agent-config.js'`, `'../tool-timeouts.js'`,
`'../test-run-marker.js'`. The `'node:https'` mock is unused by both
candidates.

## Likely root cause

A naming-path typo in the task description. The intended target is almost
certainly `src/web/telegram.ts` (the existing Telegram helper module), but
the test scaffold the task prescribes (`../db.js`, `../web/telegram.js`,
`../web/discord-group-bootstrap.js`, `../web/channel-provider.js`,
`node:https`) does not match `src/web/telegram.ts`'s imports.

## What I did

- Verified the file is absent on disk and in every git ref.
- Did NOT create the missing file (rule: never modify the target).
- Did NOT write a test against `src/web/telegram.ts` because the rule
  set in the task (`../db.js`, `../web/telegram.js`, etc.) contradicts
  that file's real dependency graph, so blindly applying it would
  produce a test that mocks the wrong modules.
- Did NOT commit any code or test.

## Next step for the requester

Confirm which of the following is intended:

1. The path is a typo for `src/web/telegram.ts`. In that case, please
   re-issue the task with that file path AND a corrected mock list
   (its real imports are `'../config.js'`, `'../logger.js'`,
   `'./agent-config.js'`, `'../tool-timeouts.js'`,
   `'../test-run-marker.js'`).
2. The path is correct and a new file at `src/web/routes/telegram.ts`
   needs to be created first. In that case the file contents must be
   provided, since the rule explicitly forbids modification of it and
   no copy exists anywhere in the tree to read from.

Without one of those two resolutions the task is unverifiable.
