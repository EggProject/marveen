You are verifying the multipart parser hardening cycle that was just completed on branch test/baseline in /Users/eggp/marveen-develop/test-baseline.

The implementation agent reports 4 commits on test/baseline. Your job:

1. Confirm the commit chain exists:
   \`git -C /Users/eggp/marveen-develop/test-baseline log --oneline -5\`
   Save the SHA of the FIRST new commit (the fix(multipart) one) — this is COMMIT1_SHA. It should be 4 commits behind HEAD.

2. Confirm working tree is clean: \`git -C /Users/eggp/marveen-develop/test-baseline status\`. Must show "nothing to commit".

3. Confirm the 4 new commits cover exactly: one fix(multipart), one test(multipart), two docs(needs-to-be-fix). Print the full commit messages (not just subject) via \`git log --format=%B HEAD~3..HEAD\` to verify they match the plan.

4. Create an ISOLATED detached worktree at /tmp/claw-multipart-test from test/baseline:
   \`\`\`
   git -C /Users/eggp/marveen-develop/test-baseline worktree add --detach /tmp/claw-multipart-test test/baseline
   ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-multipart-test/node_modules
   \`\`\`

5. Run the focused vitest subset in the worktree:
   \`\`\`
   cd /tmp/claw-multipart-test
   bun --bun vitest run src/__tests__/multipart.test.ts 2>&1 | tee /tmp/multipart-vitest.log
   \`\`\`

6. Parse the vitest output:
   - Count Test Files: must be 1 passed.
   - Count Tests: must match the pre-existing test count + 1 (the new hijack test). The original file had ~36 tests; the new total should be ~37.
   - 0 failed, 0 skipped.

7. If vitest passed: run TypeScript check on the modified file:
   \`\`\`
   cd /tmp/claw-multipart-test
   bun x tsc --noEmit src/web/multipart.ts 2>&1 | tee /tmp/multipart-tsc.log
   \`\`\`
   - Expected: 0 errors. The pre-existing ~2253 errors are concentrated in src/db.ts and would only surface with \`bun x tsc --noEmit\` on the whole project, not on a single file.

8. Clean up the worktree:
   \`\`\`
   git -C /Users/eggp/marveen-develop/test-baseline worktree remove --force /tmp/claw-multipart-test
   \`\`\`

9. If vitest or tsc shows failures: STOP. Do not try to fix forward. Report the exact failing test name(s) and the error output verbatim. The main session will decide what to do.

Return your final report with these sections:

- commit_chain: list of the 4 new commit SHAs (newest first)
- COMMIT1_SHA: first new commit's SHA
- vitest_result: PASS or FAIL with counts (test files, tests passed, tests failed, tests skipped)
- tsc_result: PASS or FAIL with error count
- worktree_cleanup: OK or ERROR
- if any FAIL: full error output (last 50 lines of /tmp/multipart-vitest.log or /tmp/multipart-tsc.log)

CRITICAL CONSTRAINTS:
- DO NOT push anything.
- DO NOT modify any files in /Users/eggp/marveen-develop/test-baseline (the implementation is already committed; you're just verifying).
- DO NOT modify any files in /tmp/claw-multipart-test either — it's read-only verification surface.
- If worktree creation fails because /tmp/claw-multipart-test already exists, run \`git worktree remove --force /tmp/claw-multipart-test\` first (it should already be cleaned from prior runs), then retry.
- Use \`bun --bun vitest run\` exactly (per project rule). NEVER \`npx vitest\`, NEVER \`bunx vitest\`.
- vitest command must be run from inside /tmp/claw-multipart-test (cwd matters for vitest.config.ts).