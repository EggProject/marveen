# Plan: Delete `docs/needs-to-be-fix/` and clean up broken file-path references

## Context

The `docs/needs-to-be-fix/` folder contains 189 markdown files documenting known issues, dead branches, defensive guards, and pre-existing drift that was either resolved, deferred, or filed as "orphan" addenda during cycles 57–59 of the test-baseline reconciliation work. Looking at the docs (e.g. `high.md`, `medium.md`, `low.md`, `orphan.md`, `baseline-unreachable.md`), the vast majority of entries have a `Resolved: YYYY-MM-DD <sha>` column -- the bugs they describe have already been fixed by their referenced commits. The remaining unresolved entries are either:

- structural (defensive guards that will never fire because upstream invariants hold),
- deferred by task rules ("NEVER modify src/web/message-router.ts"),
- pre-existing baseline drift (CI typecheck/lint already red on `main`),
- portability artifacts (Linux-only fails from a previous cycle's CI run).

In other words: the folder is a historical back-annotation of the cycle 57–59 work, not a live backlog. The user wants it removed and the 3 surviving production-code references cleaned up so no dangling paths remain.

## Scope

**Delete** (1 directory, 189 files):
- `docs/needs-to-be-fix/` in its entirety (the README, the 4 severity/role indexes, and all 183 individual bug files)

**Edit** (3 files, 1 comment fragment each):
- `vitest.config.ts:65` -- comment pointing to `message-router-cache-fallback-unreachable.md`
- `src/web/channel-request-watcher.ts:76` -- comment pointing to `channel-request-watcher-unreachable-provider-check.md`
- `.github/workflows/ci.yml:67` -- comment pointing to `syntax-check-executes-web-bundle.md`

**Edit** (1 file, 2 occurrences):
- `.github/workflows/CLAUDE.md` -- 2 narrative references to `docs/needs-to-be-fix/<file>.md` (one in the "Why lint is red" section, one in "Why coverage is red"/"The suite must stay platform-independent" section). Reword to drop the file paths; the CI behavior described is unchanged.

**Do not touch:**
- `.claude/plans/` -- contains historical plan/workflow JS files that reference this folder. These are session artifacts, not production code, and overwriting them would erase cycle 57–59 audit history. The user's request was scoped to "the code", and these are workspace traces.
- `.claude/CLAUDE.md` -- I confirmed it has zero references to `needs-to-be-fix`. (The earlier grep flagged it via the broad `.claude/` pattern, but it's a false positive from the path traversal only.)
- Any `src/__tests__/` test file -- the docs are not imported by tests; the only code references are the 3 comments above.

## Execution steps

### Step 1 -- Delete the folder

```sh
git rm -r docs/needs-to-be-fix/
```

This removes all 189 files in one commit. Verifies `ls docs/needs-to-be-fix/` is gone.

### Step 2 -- Drop the 3 broken-link code comments

For each file, remove only the trailing file-path line; keep the surrounding prose.

**`vitest.config.ts:65`** -- inside the `thresholds:` block comment ending with "MD left open at docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md." Replace that final sentence with a non-link close. The block above already explains why the gate cannot be made green from config alone, so the link is redundant.

**`src/web/channel-request-watcher.ts:76`** -- in the `DO NOT REMOVE` block, the last line is `docs/needs-to-be-fix/channel-request-watcher-unreachable-provider-check.md.` Drop the path; the preceding 8 lines explain the cross-vendor token-leak scenario in full.

**`.github/workflows/ci.yml:67`** -- the block above already says "It is a broken gate, not a passing one."; drop the trailing `docs/needs-to-be-fix/syntax-check-executes-web-bundle.md.` reference.

### Step 3 -- Reword the 2 narrative references in `.github/workflows/CLAUDE.md`

The two spots are:

1. In the "Why lint is red" section: `See docs/needs-to-be-fix/ci-eslint-typecheck-baseline.md.` -- reword to `See the inline audit in this file.` (the surrounding text already conveys the conclusion).
2. In the "The suite must stay platform-independent" section: `See docs/needs-to-be-fix/test-suite-macos-only-portability.md.` -- reword to `See the test history comment in \`platform-no-import-time-bin-resolve.test.ts\` and \`federation-local-catalog.test.ts\`.`

## Critical files

| File | Change |
| --- | --- |
| `docs/needs-to-be-fix/` (dir) | delete entirely, 189 files via `git rm -r` |
| `vitest.config.ts` | drop line 65 MD path reference |
| `src/web/channel-request-watcher.ts` | drop line 76 MD path reference |
| `.github/workflows/ci.yml` | drop line 67 MD path reference |
| `.github/workflows/CLAUDE.md` | reword 2 narrative MD-path mentions to non-link phrasings |

## Verification

1. `grep -rln "needs-to-be-fix\|needs_to_be_fix" .` (excluding `.git/`, `node_modules/`, `.claude/plans/`) returns zero matches.
2. `ls docs/needs-to-be-fix/` exits non-zero (folder gone).
3. `bun run typecheck` -- no change in error count (the deletions are comment-only and folder-only; typecheck never read the docs).
4. `bun --bun vitest run` on a clean `$HOME/claw-test` worktree (per CLAUDE.md §8 -- NOT `/tmp/`). Expectation: same pass count and coverage numbers as HEAD before the deletion. The 3 comment removals do not touch any source-of-truth logic.
5. Confirm `git status` shows the 1 deletion commit and 4 edit hunks across 4 files (3 source edits + 1 CLAUDE.md reword), then commit.

## Commit plan

Single commit: `chore(docs): remove needs-to-be-fix/ folder and clean up MD-path references`

This keeps the change atomic and reviewable -- one diff shows the entire deletion surface plus the comment cleanup. Splitting into "delete folder" + "edit comments" would create an intermediate commit with broken references in HEAD, which the user explicitly asked to avoid.
