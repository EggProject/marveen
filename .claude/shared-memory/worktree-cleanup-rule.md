# worktree-cleanup-rule

## Decision

A `git worktree remove --force <path>` + `git branch -d <branch>` cleanup
at session-end is now STRUCTURAL, not recall-based. The rule fires
automatically at every lifecycle boundary; the agent cannot ship a
"workflow done" message without first passing the cleanup gate.

## Mechanism

1. **Stop hook** (`.claude/hooks/stop-guard/core.ts`) enforces:
   - `worktreeCleanupNudged: boolean` field in `SessionGuardState`
     (current-audit-state, NOT lifetime-blocked: resets to false
     on every clean stop).
   - `detectSessionWorktreePaths(cwd)` filters path scopes:
     `$HOME/claw-*`, `/tmp/claw-*`, `.claude/worktrees/wf_*`.
   - `detectMergedLeftoverBranches(cwd)` runs
     `git branch --merged refactor/classbase` minus
     `PERMANENT_PRODUCTION_BRANCHES`
     = `{develop, feature/develop, test/baseline, main}`.
   - On any leftover, the hook exits 2 with stderr listing the
     leaks + the 3-step escalation recipe.

2. **SessionStart hook** (`.claude/hooks/session-start/hook.ts`)
   injects a leftover section at session-start to notify about
   PRIOR-session leftovers (notification, not enforcement).
   Same path / branch filters as stop-guard.

3. **Always-loaded rule** (`.claude/rules/worktree-cleanup.md`) documents
   the cleanup protocol, including the
   `cleanup-transaction THEN user-message` sequence. Same paths
   frontmatter scope, all files.

4. **Bash allowlist** (`.claude/settings.local.json`) permits the
   `$HOME/claw-*` namespace cleanup patterns to break the
   [Irreversible Local Destruction] classifier cascade that
   previously denied cleanup commands verbatim:
   - `Bash(rm -rf $HOME/claw-*)`
   - `Bash(git worktree remove $HOME/claw-* --force)`
   - `Bash(git worktree prune)`
   - `Bash(git merge --ff-only *)`

## Scope

**Session-created namespace** (flagged if found):
- Paths: `$HOME/claw-*`, `/tmp/claw-*`, `.claude/worktrees/wf_*`
- Branches: any mergeable branch merged into `refactor/classbase`
  but not yet deleted, EXCEPT those in `PERMANENT_PRODUCTION_BRANCHES`.

**Permanent anchors** (NEVER flagged):
- `refactor/classbase` (the session anchor)
- `develop`, `feature/develop`, `test/baseline`, `main` (production
  branches that exist independent of any session's work)

## When this bites

The `megint` / `again` keyword in user messages IS the load-bearing
cue that this rule violated. Pattern: 4 corpus hits in 11 days
(2026-08-28, 2026-09-04 twice, 2026-09-09) before mechanical
enforcement. Now structural at every session-end and session-start,
not dependent on agent memory or Honcho retrieval.

## Implementation history

- Phase 5 (commit `9e751ad` + `91f307f`): the proven template, applied to
  the uncommitted-memory dual-write rule. Same `.claude/rules/*.md` +
  `.claude/hooks/stop-guard/` shape. Showed that recall-based rules
  fail and mechanical gates succeed.
- Phase 10 (this session, 2026-09-09/10): the template applied to
  worktree cleanup, with the FALSIFIED-flag-bypass fix:
  `worktreeCleanupNudged` is current-audit-state, not lifetime-blocked.
- Deep retrospective workflow `wf_4afcc1d7-0c6` (session
  `389d5af2-...`): identified recall-based rules as the root cause
  and proposed the 5-change structural fix.

## References

- Rule file: `.claude/rules/worktree-cleanup.md`
- Stop hook: `.claude/hooks/stop-guard/core.ts` →
  `decideStopAction(stats, state, uncommittedMemoryFiles, leaks)`
  with `SessionResourceLeaks = { worktreePaths, branchNames }`.
- SessionStart hook: `.claude/hooks/session-start/hook.ts` →
  `readLeftoverState(cwd)` and `buildSessionStartMessage(..., leftover)`.
- Settings allowlist: `.claude/settings.local.json` →
  `permissions.allow` claw-* patterns.
- Companion dual-write rule (uncommitted memory): `.claude/rules/session-lifecycle.md`.
- Deep retrospective: `.claude/retrospectives/2026-09-09-389d5af2.md`
  (proposal 1 outcome, applied 2026-09-10).
