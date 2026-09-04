export const meta = {
  name: 'cycle35-line290-followup',
  description: 'Cycle 35 follow-up — drop unreachable snapshotPath ternary else arm (line 290)',
  phases: [
    { title: 'Phase 8 line 290 fix' },
    { title: 'Phase 9 final verify' },
  ],
};

// ============================================================
// Phase 8 — Drop line 290 ternary else arm
// ============================================================
phase('Phase 8 line 290 fix')

const phase8 = await agent(`Cycle 35 FOLLOW-UP Phase 8 — context-guard-runner line 290 ternary else arm is dead code, must be removed.

Background: the previous fix (commit 40980b4) dropped 4 dead guards but kept the line 290 ternary:
\`\`\`
(snapshotPath ? \` Pane-snapshot a restart elotti allapotrol: \${snapshotPath}\` : '')
\`\`\`
The pinning test that covered the else arm (snapshotPath=null) was deleted. Coverage now 99.01% (1 branch uncovered).

Re-analysis of line 290:
- snapshotPath is initialized to null at line 273
- Line 277 (\`snapshotPath = join(...)\`) runs INSIDE the try block, BEFORE writeFileSync at line 278
- If line 277 throws (which it essentially cannot — join() is pure string concatenation), snapshotPath stays null
- If line 278 throws, snapshotPath is ALREADY set to the path (line 277 completed first)
- The catch block does NOT reset snapshotPath
- Therefore: in practice, snapshotPath is ALWAYS non-null at line 290. The else arm is dead code, just like the other branches we removed.

=== Current state (verify first) ===
- Branch: test/baseline, 5 commits ahead of origin (Phase 3 + Phase 5/6 redo)
- Working tree: clean
- src/web/context-guard-runner.ts: lines 263, 274, 275, 290 are CURRENTLY:
  - Line 263: \`handoffPrompt(pctRound!, ...)\` ✓
  - Line 274: \`const finalPane: string = pane!\` ✓
  - Lines 275-278: unconditional writeFileSync ✓
  - Line 290: \`(snapshotPath ? ' Pane-snapshot...' : '')\` ← still ternary

Confirm:
- \`git status\` → clean
- \`git log --oneline -3\` → confirm 5 commits ahead of 2ca6901

=== Commit (follow-up fix) ===

File: src/web/context-guard-runner.ts

Single change at line 290:
- BEFORE: \`(snapshotPath ? \` Pane-snapshot a restart elotti allapotrol: \${snapshotPath}\` : '')\`
- AFTER: \`\` Pane-snapshot a restart elotti allapotrol: \${snapshotPath!}\`\`
- Add tripwire comment above line 290 (similar style as line 263/274): \`// snapshotPath is non-null here: line 277 (join) runs before any potential throw in writeFileSync, and join() is pure (cannot throw). The catch block does not reset snapshotPath. See context-guard-runner.ts:273-281.\`

Verify BEFORE commit:
- \`bunx tsc --noEmit 2>&1 | wc -l\` → should be 2253 (baseline)
- \`bun --bun vitest run src/__tests__/context-guard-runner.test.ts 2>&1 | tail -5\` → 49/49 PASS
- \`bun --bun vitest run --coverage src/__tests__/context-guard-runner.test.ts 2>&1 | grep -E "context-guard-runner|All files" | head -5\` → expect **100% branch coverage** (was 99.01%)

Commit message:
\`\`\`
fix(context-guard-runner): drop unreachable snapshotPath ternary else arm (line 290)

Follow-up to 40980b4 (which kept the line 290 ternary for type-safety reasons).
Re-analysis shows the ternary else arm is also dead code:

- snapshotPath is initialized to null at line 273
- Line 277 (snapshotPath = join(...)) runs inside the try block BEFORE any
  writeFileSync call, so if writeFileSync throws, snapshotPath is already
  the joined path (non-null)
- The catch block at line 279-281 does NOT reset snapshotPath
- join() is pure string concatenation (cannot throw)
- Therefore snapshotPath is ALWAYS non-null at line 290

Removes the ternary, uses snapshotPath! with tripwire comment.

Restores 100% branch coverage on context-guard-runner.ts.
\`\`\`

=== Final check for Phase 8 ===

After the commit:
- \`git log --oneline -2\` → 1 new commit at HEAD
- \`git status\` → clean
- Report the commit SHA.

Constraints:
- DO NOT push.
- DO NOT modify other files.
- DO NOT run /code-review.
- If any verify step fails (especially the coverage check), STOP and report with full output.`, { label: 'Phase 8 line 290' })

if (!phase8) {
  log('Phase 8 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

// ============================================================
// Phase 9 — Final verification (post line 290 fix)
// ============================================================
phase('Phase 9 final verify')

const phase9 = await agent(`Cycle 35 FOLLOW-UP Phase 9 — Final verification (READ-ONLY, no commits, no edits, no push).

=== Tasks ===

1. \`git status\` → clean
2. \`git log --oneline -10\` → confirm exactly 6 new commits on top of Phase 1 baseline (2ca6901):
   - <phase-8-sha> fix(context-guard-runner): drop unreachable snapshotPath ternary else arm (line 290) (newest)
   - 6b7340c docs(context-guard-runner)
   - 40980b4 fix+test(context-guard-runner)
   - 0cf1fdb docs(message-router)
   - 9d01097 test(message-router)
   - ba6faf8 fix(message-router)
3. \`git diff origin/test/baseline --stat\` → expect 8 files changed (same as before — line 290 is in context-guard-runner.ts which was already changed)
4. \`bunx tsc --noEmit 2>&1 | wc -l\` → should be 2253 (unchanged from baseline)
5. \`bun --bun vitest run src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts 2>&1 | tail -5\` → expect 121/121 PASS (49 + 72)
6. \`bun --bun vitest run --coverage src/__tests__/context-guard-runner.test.ts 2>&1 | grep -E "context-guard-runner|All files" | head -5\` → expect **100% branch coverage on context-guard-runner.ts** (was 99.01% before this fix)
7. \`bun --bun vitest run 2>&1 | tail -5\` → expect 382 test files, ~11126 tests (no test count change from Phase 7)
8. Coverage for message-router.ts (re-verify it didn't change):
   \`bun --bun vitest run --coverage src/__tests__/message-router-full.test.ts 2>&1 | grep -E "message-router.ts" | head -3\`
   → expect ~97.82% branch coverage (unchanged from Phase 7)

Output format: a structured final report with EXACT numbers for all 8 tasks. Include all 6 commit SHAs. Flag any unexpected value with ⚠️.

This is the FINAL state of cycle 35. After this, the user will push and run /code-review xhigh --fix.

Constraints:
- READ-ONLY. No edits, no commits, no push.
- Do NOT run /code-review.`, { label: 'Phase 9 final verify' })

if (!phase9) {
  log('Phase 9 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

log('Cycle 35 complete (with line 290 follow-up). 6 commits ready on test/baseline locally. Awaiting user push and /code-review xhigh --fix.')
return { phase8, phase9 }
