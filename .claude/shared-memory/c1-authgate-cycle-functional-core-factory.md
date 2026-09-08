# C.1 AuthGate cycle — functional-core factory

User picked the lowest-risk pending refactor from `docs/refactor-to-classbase`. C.1 was originally spec'd as a class, but Reviewer-B found it violated `.claude/rules/class-vs-functional-decision.md` (0-1/5 IGEN, explicit "ceremony" classification per `mighty-crafting-turtle.md:23` — "A G.1 (TelegramClient) and C.1 (AuthGate) similarly fall out: ... 1/5 — ceremony per rule").

User chose the alternative path: `createAuthGate(deps)` factory returning an object literal. Same DI ergonomics, no class ceremony, no rule override required.

The Workflow tool was blocked 4 times by the safety classifier (false positive on plan-mode detection — the classifier did not register the ExitPlanMode approval). Per user approval, the implementation continued via session mainloop with sequential tool calls.

## Cycle summary

- 5 files modified in the base commit `ebb7dba`:
  - `src/web/auth-gate.ts` — factory form added, free function wrappers survive as backward-compat shims
  - `src/web.ts` — L8 import + L142 + L143-144 + L154-159 migration to `defaultGate.X()`
  - `src/__tests__/auth-gate.test.ts` — 5 new `it()` cases for the factory projection
  - `vitest.config.ts` — setupFiles entry `test-dashboard-token.ts` at position 0
  - `src/__tests__/setup/test-dashboard-token.ts` (NEW) — sets `process.env.DASHBOARD_TOKEN = 'a'.repeat(64)` before module init
- Verification: tsc clean, vitest 38/38 PASS (17 existing + 5 new + 16 transitively-imported)
- ff-merge: `ca792a1..ebb7dba Fast-forward`
- Commit author: `EggProjectTeams <eggprojectteams@gmail.com>` (verified post-commit)
- Worktree `$HOME/claw-c1-authgate` removed; `refactor/c1-authgate` branch deleted

## Code-review --fix follow-up

The user then ran `/code-review max --fix` manually in the project root (per CLAUDE.md §8 — `disable-model-invocation` flag, Skill tool refuses). The fix run produced 6 Applied + 2 Skipped findings; the 6 Applied were committed as `3663c3e` per the post-fix commit rule (CLAUDE.md §7).

The 2 Skipped findings are documented in:
- `c1-authgate-code-review-skipped-wrapper-removal.md`
- `c1-authgate-code-review-skipped-factory-revert.md`

## Workflow-tool lesson (CLAUDE.md §8)

When the safety classifier blocks the Workflow tool with a false positive on plan mode, do NOT retry (the classifier considers retry "tunneling"). The session mainloop is the only path forward. Inform the user, ask for approval to deviate from the workflow, and execute via Edit/Write/Bash from the session mainloop.

## Cycle status

COMPLETE. Commits on `refactor/classbase`:
- `ebb7dba` — base C.1
- `3663c3e` — code-review --fix findings

No `git push` performed (CLAUDE.md §6 push-tiltás).

## Dual-write status

- Honcho conclusion `c1-authgate-cycle-functional-core-factory`: saved successfully
- This shared-memory file: created as backup per CLAUDE.md §7