export const meta = {
  name: 'cycle35-clusterA-redo',
  description: 'Cycle 35 redo — context-guard-runner combined fix+test + docs',
  phases: [
    { title: 'Phase 5 cluster A combined' },
    { title: 'Phase 6 cluster A docs' },
    { title: 'Phase 7 final verify' },
  ],
};

// ============================================================
// Phase 5 — Cluster A: combined fix + test deletion in ONE commit
// ============================================================
phase('Phase 5 cluster A combined')

const phase5 = await agent(`Cycle 35 REDO Phase 5 — context-guard-runner combined fix+test commit. Branch: test/baseline. DO NOT PUSH.

The previous attempt (Phase 2) failed because the pinning tests test RUNTIME behavior (not just syntax). This phase combines the source fix and test deletion in ONE atomic commit to avoid intermediate failing-test states.

=== Current state (verify first) ===
- Branch: test/baseline, 3 commits ahead of origin (Phase 3 commits: ba6faf8, 9d01097, 0cf1fdb)
- Working tree: clean (Phase 2 reverted its edit)
- src/web/context-guard-runner.ts: UNCHANGED (lines 263, 274, 275, 290 still have dead code)
- src/__tests__/context-guard-runner.test.ts: UNCHANGED (describe block at lines 1297-1374 still present)

Confirm:
- \`git status\` → clean
- \`bun --bun vitest run src/__tests__/context-guard-runner.test.ts 2>&1 | tail -5\` → 51/51 PASS

=== Commit 1 (combined fix+test) ===

This is ONE atomic commit that does both source and test changes together. The commit message reflects both:

File 1: src/web/context-guard-runner.ts
- Line 263: \`handoffPrompt(pctRound ?? 0, handoffPathFor(name))\` → \`handoffPrompt(pctRound!, handoffPathFor(name))\`
- Add tripwire comment above line 263: \`// pctRound is non-null here: decideGuard returns 'request-handoff' only when inputs.pct !== null (see context-guard.ts:322-333).\`
- Line 272: \`let snapshotPath: string | null = null\` — keep as-is
- Line 274: \`const finalPane = pane ?? capturePane(session)\` → \`const finalPane: string = pane!\` (type narrowing)
- Lines 275-278: drop the \`if (finalPane) { ... }\` guard, execute body unconditionally. The body becomes:
  \`\`\`
  const finalPane: string = pane!  // (already added above)
  snapshotPath = join(PROJECT_ROOT, 'store', \`context-guard-last-pane-\${name}.txt\`)
  writeFileSync(snapshotPath, finalPane)
  \`\`\`
- Add tripwire comment above line 274: \`// pane is non-null here: decideGuard returns 'restart' only when state.phase ∈ {idle, await-handoff} which forces pane non-null (see context-guard.ts:301,320,352,358,367,373).\`
- Line 290: the template literal \`(snapshotPath ? ' Pane-snapshot a restart elotti allapotrol: \${snapshotPath}' : '')\` — KEEP the ternary because snapshotPath can still be null if writeFileSync threw (catch block sets it back to null — actually the catch block does NOT reset snapshotPath, so if writeFileSync succeeded, snapshotPath is non-null; if it threw, snapshotPath stays null). The ternary stays correct.
- Also change \`let snapshotPath: string | null = null\` → can stay as \`string | null\` because the ternary handles null. OR narrow to \`string\` and handle the catch differently. CHOICE: keep as \`string | null\`, since the catch block can leave it null.

File 2: src/__tests__/context-guard-runner.test.ts
- Delete the entire \`describe('dead-code branches via mock-controlled decideGuard', ...)\` block at lines 1297-1374 (2 \`it\` blocks + the describe wrapper).
- Delete the section divider comment block above it (lines 1284-1296) IF it exclusively references the deleted describe block. Inspect first — if the divider is a generic section header that mentions multiple topics, only delete the part that exclusively references the deleted describe.

Verify BEFORE commit:
- \`bunx tsc --noEmit 2>&1 | wc -l\` → should be 2253 (baseline measured by Phase 1)
- \`bun --bun vitest run src/__tests__/context-guard-runner.test.ts 2>&1 | tail -5\` → expected 49/49 PASS (2 pinning tests deleted)

Commit message:
\`\`\`
fix+test(context-guard-runner): drop 4 dead defensive guards + remove pinning tests

Combined atomic commit: source change and pinning test deletion cannot be
separated because the 2 pinning tests assert runtime output of the removed
defensive branches (the ~0% fallback string and the snapshotPath=null else
arm), not just syntax.

Source: src/web/context-guard-runner.ts lines 263, 274, 275, 290
- pctRound ?? 0 → pctRound!
- pane ?? capturePane(session) → pane!
- if (finalPane) { ... } → unconditional (snapshot always written)
- snapshotPath ? '...' : '' ternary kept (writeFileSync catch can leave it null)

Tests: src/__tests__/context-guard-runner.test.ts lines 1297-1374
- Removed describe('dead-code branches via mock-controlled decideGuard', ...)
- 2 pinning tests used mockDecideGuard.mockImplementationOnce to force the
  runner into the unreachable branches; no longer meaningful after the
  source change.

Verifies: decideGuard contract guarantees non-null on every code path that
reaches the runner's request-handoff or restart case. See
docs/needs-to-be-fix/context-guard-runner-dead-code-branches.md for the
unreachability argument.
\`\`\`

=== Final check for Phase 5 ===

After the commit:
- \`git log --oneline -2\` — confirm 1 new commit at HEAD (fix+test combined)
- \`git status\` — clean
- Report the commit SHA.

Constraints:
- DO NOT \`git push\`.
- DO NOT modify files outside the explicit list.
- DO NOT run /code-review.
- If any verify step fails, STOP and report with full output.`, { label: 'Phase 5 redo cluster A' })

if (!phase5) {
  log('Phase 5 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

// ============================================================
// Phase 6 — Cluster A docs commit
// ============================================================
phase('Phase 6 cluster A docs')

const phase6 = await agent(`Cycle 35 REDO Phase 6 — context-guard-runner docs commit. Branch: test/baseline. DO NOT PUSH.

=== Current state (verify first) ===
- HEAD should be 4 commits ahead of origin (Phase 3: ba6faf8, 9d01097, 0cf1fdb + Phase 5 combined fix+test commit)
- Working tree: clean

=== Commit 2 (docs) ===

File 1: docs/needs-to-be-fix/context-guard-runner-dead-code-branches.md
- Add a final line at the end of the file (after the last existing content):
  \`Resolved: 2026-08-19 <sha-of-phase-5-commit>\`
- Where <sha-of-phase-5-commit> is the SHA from the previous commit.

File 2: docs/needs-to-be-fix/INDEX.md
- Find the row with \`context-guard-runner-dead-code-branches\`
- Update the Resolved column from \`—\` to \`Resolved: 2026-08-19 <sha-of-phase-5-commit>\`
- Be careful to NOT change other rows or column widths.

Verify BEFORE commit:
- \`git grep "context-guard-runner-dead-code-branches" docs/needs-to-be-fix/INDEX.md\` — confirm row is updated
- \`git diff docs/needs-to-be-fix/INDEX.md\` — confirm only the context-guard-runner row changed

Commit message:
\`\`\`
docs(needs-to-be-fix): mark context-guard-runner-dead-code-branches resolved

The 4 dead defensive guards in src/web/context-guard-runner.ts
(lines 263, 274, 275, 290) were dropped via a combined fix+test commit.
decideGuard contract guarantees non-null on every reachable path.
\`\`\`

=== Final check for Phase 6 ===

After the commit:
- \`git log --oneline -5\` — confirm 2 new commits at HEAD (Phase 5 combined + this docs)
- \`git status\` — clean
- Report the commit SHA.

Constraints:
- DO NOT push.
- DO NOT modify other files.
- DO NOT run /code-review.`, { label: 'Phase 6 redo docs' })

if (!phase6) {
  log('Phase 6 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

// ============================================================
// Phase 7 — Final verification
// ============================================================
phase('Phase 7 final verify')

const phase7 = await agent(`Cycle 35 REDO Phase 7 — Final verification (READ-ONLY, no commits, no edits, no push).

=== Tasks ===

1. \`git status\` → clean
2. \`git log --oneline -10\` → confirm exactly 5 new commits on top of Phase 1 baseline (2ca6901):
   - ba6faf8 fix(message-router)
   - 9d01097 test(message-router)
   - 0cf1fdb docs(message-router)
   - <phase-5-sha> fix+test(context-guard-runner)
   - <phase-6-sha> docs(context-guard-runner)
3. \`git diff origin/test/baseline --stat\` → expect 8 files changed:
   - src/web/context-guard-runner.ts
   - src/__tests__/context-guard-runner.test.ts
   - src/web/message-router.ts
   - src/__tests__/message-router-full.test.ts
   - docs/needs-to-be-fix/context-guard-runner-dead-code-branches.md
   - docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md
   - docs/needs-to-be-fix/message-router-dead-defensive-branches.md
   - docs/needs-to-be-fix/INDEX.md
4. \`bunx tsc --noEmit 2>&1 | wc -l\` → should be 2253 (unchanged from baseline)
5. \`bun --bun vitest run src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts 2>&1 | tail -5\` → expect 121/121 PASS (49 context-guard + 72 message-router)
6. \`bun --bun vitest run 2>&1 | tail -5\` → expect 382 test files passed, ~11127 tests (baseline -3 since we deleted 3 pinning tests: 2 context-guard + 1 message-router)
7. \`git grep -E "context-guard-runner-dead-code-branches|message-router-unreachable-defensive-branches|message-router-dead-defensive-branches" docs/needs-to-be-fix/INDEX.md\` → confirm all 3 INDEX rows updated
8. \`bun --bun vitest run --coverage src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts 2>&1 | grep -E "context-guard-runner|message-router|All files" | head -10\` → report branch coverage:
   - context-guard-runner.ts: expect 100% branch (was 100%, dead branches removed)
   - message-router.ts: expect ~97.82% branch (was 96.47%, lines 81+317 removed; lines 476-478 cache fallback still uncovered and TS-strict-blocked)

Output format: a structured final report with EXACT numbers for all 8 tasks. Include the 5 commit SHAs. Flag any unexpected value with ⚠️.

Constraints:
- READ-ONLY. No edits, no commits, no push.
- Do NOT run /code-review. The user will do that after push.`, { label: 'Phase 7 final verify' })

if (!phase7) {
  log('Phase 7 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

log('Cycle 35 redo complete. 5 commits ready on test/baseline locally. Awaiting user push and /code-review xhigh --fix.')
return { phase5, phase6, phase7 }
