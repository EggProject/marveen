# Plan: 3 docs-only consistency fixes for already-resolved MDs

## Context

Branch `test/baseline` (HEAD `b3068b1`, working tree clean) has 0 truly "open" needs-fix items per INDEX.md. The 6 items marked "Deferred to next cycle" all require src/ edits with elevated risk; the 13 "pinned, not fixed" items are by-design. The 178 already-Resolved entries are mostly consistent, but 3 small docs-only drift items remain. Both Plan subagents independently verified these 3 fixes are safe, atomic, and zero-risk (no src/ edits, no INDEX.md changes, no test changes).

Combined into one batch commit per Agent-1 recommendation (matches prior cycle pattern: `e399a96 docs(needs-to-be-fix): scope-correct 87 NEVER-modify claims` was one batch commit for a similar docs-tidy purpose).

## Recommended approach

One batch commit, 3 files, 3 single-line edits. No src/ changes. No INDEX.md changes. No new files. Zero em-dashes.

### Fix 1: `message-router-cache-fallback-unreachable.md` line 3

Header says `PARTIALLY RESOLVED.` but body (`## Resolution (2026-08-25, commit 900cdb6)` at line 126, `Status: **Resolved**` at line 174) and INDEX.md (line 131, `Resolved: 2026-08-25 232fac7`) all agree it is resolved. The header is the only stale field.

```diff
-old: **Status:** PARTIALLY RESOLVED.
+new: **Status:** RESOLVED.
```

NOTE: line 5's `## Status: PARTIAL -- 2026-08-18` is a SEPARATE section heading describing a historical attempt; do NOT touch it.

### Fix 2: `routes-recall-153-ts-strict-blocks-delete.md` line 10

Two `## Resolution` headings exist in the same file (line 10 historical, line 27 active for `3bec823`). Rename the line-10 heading so only one `## Resolution` remains.

```diff
-old: ## Resolution (superseded by `## Resolution (2026-08-16, 3bec823)` below)
+new: ## Historical note (superseded by `## Resolution (2026-08-16, 3bec823)` below)
```

The cross-reference anchor (`## Resolution (2026-08-16, 3bec823)`) at line 27 is preserved unchanged.

### Fix 3: `routes-agents-br-baseline-partial-coverage.md` line 38

Line 38 has broken ref `src/web/routes/agents.ts:4756-4761`. agents.ts has only 2120 lines (`wc -l` verified). Actual code location for the excerpt is lines 460-465 (verified by grep + Read).

```diff
-old: // src/web/routes/agents.ts:4756-4761 -- agent detail's `running` branches
+new: // src/web/routes/agents.ts:460-465 -- agent detail's `running` branches
```

Both ranges are 6 lines wide (pure line-number transposition typo; excerpt code itself is correct).

## Files to modify

- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md`
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/routes-recall-153-ts-strict-blocks-delete.md`
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md`

Read-only references (not modified):
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md`
- `/Users/eggp/marveen-develop/test-baseline/src/web/routes/agents.ts`

## Out of scope (explicit non-goals)

- **`routes-recall-25-ts-strict-blocks-delete.md`:** has the same `## Resolution (superseded by ...)` pattern. Both Plan agents recommended NOT touching this in the same batch (keeps diff scoped to user's stated candidates). Defer to a separate cycle.
- **`vitest.config.ts:65`:** ends a comment with "MD left open at docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md." Slightly stale wording post-Fix-1, but file genuinely still sits in `needs-to-be-fix/` so factually defensible. Defer.
- **The 87 addenda MDs** that body-text still describes as open despite INDEX closing them (per Explore-Agent-3 inventory): these are NOT part of this batch. Defer to a separate cycle if the user wants.

## Execution workflow

```
Phase 1: Sequential Edit calls (3 files, 3 single-line edits)
Phase 2: 2 parallel verification subagents via Agent tool (isolation: worktree)
Phase 3: Single batch commit
Phase 4: User runs /code-review max --fix
```

**Phase 1 — Edit (sequential):**
- Read each of the 3 files first (required by Edit tool harness; Read state is tracked per-session)
- Apply the 3 old_string → new_string edits in any order

**Phase 2 — Verify (parallel, 2 subagents via Agent tool with isolation: worktree):**

Per CLAUDE.md §8: 2 parallel verification subagents for dry-run/dupla-ellenorzes use **Agent tool with isolation: worktree**, not Workflow tool.

Each subagent gets a different lens:
- Subagent 1 (correctness): for each of the 3 files, Read the file in the worktree, confirm the old_string is gone, confirm new_string is present, confirm the file is otherwise unchanged. Run `git diff test/baseline..HEAD -- docs/needs-to-be-fix/` (or equivalent) in the worktree.
- Subagent 2 (consistency): for each of the 3 files, confirm INDEX.md still agrees with the post-fix state. Confirm no em-dash (U+2014) in the new text. Confirm no broken file:line references remain. Run `grep -rn '4756' . --exclude-dir=node_modules` (should be empty).

Both subagents must return APPROVED/REJECTED verdict. REJECTED → fix and re-verify.

**Phase 3 — Commit:**
- Single batch commit
- Suggested message:
  ```
  docs(needs-to-be-fix): reconcile 3 docs-only drift items

  - message-router-cache-fallback-unreachable.md: status banner
    PARTIALLY RESOLVED -> RESOLVED to match body Resolution (line 126,
    900cdb6) and INDEX.md row (line 131, Resolved: 2026-08-25 232fac7).
    Line 5's historical ## Status: PARTIAL section is left intact.

  - routes-recall-153-ts-strict-blocks-delete.md: rename line 10
    heading "## Resolution (superseded by ...)" -> "## Historical note
    (superseded by ...)". Removes duplicate ## Resolution heading;
    line 27 remains the active ## Resolution for commit 3bec823.

  - routes-agents-br-baseline-partial-coverage.md: fix broken line ref
    on line 38. agents.ts is 2120 lines; the actual excerpt is at
    agents.ts:460-465 (verified by wc -l + grep + Read).

  No src/ changes. No INDEX.md changes. No new files. Zero em-dash.
  ```

**Phase 4 — Post-commit (out of workflow):**
- User invokes `/code-review max --fix HEAD~1..HEAD` (or equivalent range) in their terminal
- Per CLAUDE.md §8, `/code-review` skill has `disable-model-invocation` flag; only user can invoke

## Verification

End-to-end verification after Phase 3 commit:
1. `git log -1 --format=%H` → confirm commit landed
2. `git diff HEAD~1 HEAD -- docs/needs-to-be-fix/` → confirm exactly 3 lines changed across 3 files
3. `grep -n 'PARTIALLY' docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` → confirm only the line-5 historical section has it
4. `grep -n '^## Resolution' docs/needs-to-be-fix/routes-recall-153-ts-strict-blocks-delete.md` → confirm only line 27 (one ## Resolution)
5. `grep -rn '4756' . --exclude-dir=node_modules --exclude-dir=.git` → confirm zero hits
6. `grep -c $'—' docs/needs-to-be-fix/{message-router-cache-fallback-unreachable,routes-recall-153-ts-strict-blocks-delete,routes-agents-br-baseline-partial-coverage}.md` → confirm zero em-dashes in new text (any pre-existing em-dashes outside edit regions stay untouched per Surgical Changes rule)
7. `bunx tsc --noEmit | wc -l` → confirm still 1699 (no src/ changes, error count unchanged)
8. `/code-review max --fix HEAD~1..HEAD` → user-driven final pass

## Critical files

- 3 edit targets listed above
- 2 read-only references (INDEX.md, agents.ts)

## Risk profile

- **Functional risk:** zero. No src/ edits, no test edits, no behavior change.
- **INDEX drift risk:** zero. INDEX.md is unchanged and already agrees with post-fix state.
- **Test impact:** zero. No test file references any of the 3 lines being changed (verified by grep).
- **Em-dash risk:** zero. All proposed strings are em-dash-free.
- **Revert risk:** trivial. 3 single-line edits in 3 files; one `git revert` undoes the batch.
