You are implementing a 4-commit focused cycle on the current branch test/baseline in /Users/eggp/marveen-develop/test-baseline.

Read the plan in FULL at /Users/eggp/marveen-develop/test-baseline/.claude/plans/glittery-puzzling-hamster.md before starting. It contains the exact code changes, the new MD content, the INDEX row, and the safe-commit-message protocol.

Critical rules (from CLAUDE.md):
- NEVER push to remote. All commits stay local.
- Use the safe-commit-message protocol for every commit: write the message to /tmp/commit-N-msg.txt, then \`git commit -F /tmp/commit-N-msg.txt\`. Verify the message in the file does NOT contain backslash corruption (cat the file BEFORE committing).
- The 4 commits must be atomic, in order, on test/baseline.

Commit order (read each "Commit N" section in the plan for exact content):

1. fix(multipart): unanchor boundary regex, case-insensitive parameters, latin1, length cap, anchor nameMatch
   - File: src/web/multipart.ts (replace ONLY the parseMultipart function body, lines 8-47; keep the opening comment lines 1-6 and ParsedForm interface unchanged)
   - The new body uses lookbehind (?<=^|[;,]) to anchor boundary match, \s*=\s* for whitespace, 70-char cap, /i flag on name/filename with (?:^|;\s) anchor, latin1 instead of binary.

2. test(multipart): reorganize pinning block, fix misleading comment, add boundary-hijack test
   - File: src/__tests__/multipart.test.ts (3 changes):
     a. Split the describe('parseMultipart - ismert eltresek (pinning)') block (lines 278-336) into two describes: one for the 4 pinning tests, one for the 2 edge-case tests. Keep the block comment at lines 274-277 UNCHANGED.
     b. Fix the misleading comment on line 327 (inside the forditott sorrend test) — the new comment describes the now-properly-anchored behavior.
     c. Add ONE new test in the 'parseMultipart - boundary felismerés' describe block (after the existing test on line 68, before line 69 closing brace): the myboundary=WRONG; boundary=REAL hijack test.

3. docs(needs-to-be-fix): new MD multipart-boundary-unanchored + Resolved banner on multipart-case-sensitive-disposition
   - Create new file: docs/needs-to-be-fix/multipart-boundary-unanchored.md (exact content is in the plan's Commit 3 section, in the "Új fájl" block).
   - Append Resolved banner to existing file: docs/needs-to-be-fix/multipart-case-sensitive-disposition.md (exact text is in the plan's Commit 3 section, in the "Létező fájl" block).
   - Both files reference the SHA of Commit 1 via literal `<sha>` placeholder. To get the real SHA: after Commit 2 lands, Commit 1 is at HEAD~1. Run `git rev-parse HEAD~1` to capture. Replace `<sha>` with the captured SHA in both files before committing.

4. docs(needs-to-be-fix): INDEX.md -- mark Resolved
   - File: docs/needs-to-be-fix/INDEX.md (2 edits):
     a. In the Medium severity section, update the multipart-case-sensitive-disposition row's Resolved column to add the Commit 1 SHA alongside the existing 2026-08-16 b5baca3.
     b. Insert a NEW row for multipart-boundary-unanchored in the Medium severity section (near the other multipart rows, after multipart-latin1-fields), Resolved column = Commit 1 SHA.
   - After Commit 3 lands, Commit 1 is at HEAD~2. Run `git rev-parse HEAD~2` to capture Commit 1's SHA.

Final report (return as your last text):

Section 1: \`git log --oneline -5\` output (the 4 new commits should be the top 4).
Section 2: \`git status\` output (must be clean).
Section 3: COMMIT1_SHA = the literal SHA string from \`git rev-parse HEAD~3\`.
Section 4: \`git diff --stat HEAD~4..HEAD\` output (the file footprint of the 4 commits).
Section 5: brief 2-sentence summary of what each commit did.

CRITICAL CONSTRAINTS:
- DO NOT push. Local only.
- DO NOT touch any file outside the 4 listed in the plan: src/web/multipart.ts, src/__tests__/multipart.test.ts, docs/needs-to-be-fix/multipart-boundary-unanchored.md (new), docs/needs-to-be-fix/multipart-case-sensitive-disposition.md, docs/needs-to-be-fix/INDEX.md.
- DO NOT modify src/web/multipart.ts beyond the parseMultipart function body (lines 8-47). Keep the opening comment lines 1-6 and ParsedForm interface unchanged.
- DO NOT modify src/__tests__/multipart.test.ts beyond the 3 changes listed.
- DO NOT change the block comment at lines 274-277 in the test file.
- Use safe-commit-message for every commit.

If any commit fails (e.g., a test passes locally but you cannot stage the changes), STOP and report — do not try to fix forward. The verifier phase will catch regressions in the isolated worktree.