export const meta = {
  name: 'cycle35-dead-defensive-branches',
  description: 'Cycle 35 — Low severity dead-defensive-branch cluster (context-guard-runner + message-router)',
  phases: [
    { title: 'Phase 1 pre-conditions' },
    { title: 'Phase 2 cluster A fix+test+docs' },
    { title: 'Phase 3 cluster B fix+test+docs' },
    { title: 'Phase 4 final verification' },
  ],
};

// ============================================================
// Phase 1 — Pre-conditions verify
// ============================================================
phase('Phase 1 pre-conditions')

const phase1 = await agent(`Cycle 35 Phase 1 — pre-conditions verification. DO NOT COMMIT. DO NOT PUSH. Only read and verify.

Repo root: /Users/eggp/marveen-develop/test-baseline
Plan file: /Users/eggp/marveen-develop/test-baseline/.claude/plans/gleaming-wiggling-dragonfly.md

Tasks:
1. \`git status\` — confirm clean working tree. Report any uncommitted/untracked files.
2. \`git log -1 --format=%H\` — confirm HEAD is a4c5aba5983e5d051492a48e2748fe8371b62009 (or a descendant from cycle 34).
3. \`git rev-parse --abbrev-ref HEAD\` — confirm branch is test/baseline.
4. Run \`bunx tsc --noEmit 2>&1 | wc -l\` to record the baseline TypeScript error count. The expected baseline is ~1699, but report the exact number you measure.
5. Run \`bunx vitest run src/__tests__/context-guard-runner.test.ts 2>&1 | tail -20\` — report pass count (expected 51/51).
6. Run \`bunx vitest run src/__tests__/message-router-full.test.ts 2>&1 | tail -20\` — report pass count (expected 75/75).
7. Open \`src/context-guard.ts\` and find the \`decideGuard\` function. List EVERY return statement that returns \`action: 'restart'\` or \`action: 'request-handoff'\`. For each, show the surrounding context (5 lines before) and confirm whether \`inputs.pct !== null\` and \`running &amp;&amp; needPct\` are guaranteed. This verifies the 4 dead branches claim independently.
8. Run \`bunx vitest run --coverage src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts 2>&1 | tail -40\` — report the branch coverage for context-guard-runner.ts and message-router.ts. The expected values are 100% and 96.47% (with uncovered branches at 81, 317, 478-480 per the agent's prior report).

Output format: a structured report with sections for each task, including exact numbers measured. If ANY value diverges from expected, flag it loudly with ⚠️.

Do not edit any files. Do not run any destructive commands.`, { label: 'Phase 1 verify' })

if (!phase1) {
  log('Phase 1 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

// ============================================================
// Phase 2 — Cluster A (context-guard-runner): fix + test + docs in 3 commits
// ============================================================
phase('Phase 2 cluster A fix+test+docs')

const phase2 = await agent(`Cycle 35 Phase 2 — Cluster A (context-guard-runner) all 3 commits. Branch: test/baseline. DO NOT PUSH (commit only, locally).

Plan file: /Users/eggp/marveen-develop/test-baseline/.claude/plans/gleaming-wiggling-dragonfly.md

This phase makes 3 sequential commits. Work in order, verify after each commit, then proceed.

=== Commit 1: fix ===

File: src/web/context-guard-runner.ts

Edits (the 4 dead branches):
- Line 263: change \`handoffPrompt(pctRound ?? 0, handoffPathFor(name))\` to \`handoffPrompt(pctRound!, handoffPathFor(name))\`. Add tripwire comment above: \`// pctRound is non-null here: decideGuard returns 'request-handoff' only when inputs.pct !== null (see context-guard.ts:322-334).\`
- Line 272-278: replace the \`let snapshotPath: string | null = null\` + try block + \`if (finalPane) { ... }\` with code that uses non-null types. Specifically:
  - Change line 272 to \`let snapshotPath: string | null = null\` stays, but inside the try block:
  - Line 274: \`const finalPane = pane ?? capturePane(session)\` → \`const finalPane: string = pane!\` (type narrow to non-null)
  - Lines 275-278: drop the \`if (finalPane) { ... }\` guard, just execute the body unconditionally (the \`writeFileSync(snapshotPath, finalPane)\` works because both are strings)
  - Add tripwire comment: \`// pane is non-null here: decideGuard returns 'restart' only when state.phase ∈ {idle, await-handoff} which forces pane non-null (see context-guard.ts:301,320,352,358,367,373).\`
- Line 290: the template literal \`(snapshotPath ? ' Pane-snapshot a restart elotti allapotrol: \${snapshotPath}' : '')\` — keep the ternary because snapshotPath could still be null if writeFileSync threw (catch block sets it back to null). Actually wait — after the try block, snapshotPath could be null if the catch ran. So keep the ternary. But the catch block logs a warning and does NOT reset snapshotPath. So if writeFileSync succeeded, snapshotPath is non-null; if it threw, snapshotPath stays null. The ternary stays correct. No change needed at line 290.

Verify BEFORE commit:
- Run \`bunx tsc --noEmit 2>&1 | wc -l\` — should be EQUAL to baseline from Phase 1.
- Run \`bunx vitest run src/__tests__/context-guard-runner.test.ts 2>&1 | tail -10\` — expected 51/51 PASS (pinning tests still PASS because syntax is valid).

Commit message: \`fix(context-guard-runner): drop 4 dead defensive guards (lines 263, 274, 275, 290)\`
Body should mention: 4 unreachable branches per the MD; \`decideGuard\` contract guarantees the non-null values; tripwire comments added.

=== Commit 2: test deletion ===

File: src/__tests__/context-guard-runner.test.ts

Delete the entire \`describe('dead-code branches via mock-controlled decideGuard', ...)\` block at lines 1297-1374 (the 2 tests + the describe wrapper).

Also delete the section divider comment above it (lines 1284-1296) IF it exclusively describes the deleted describe block. Inspect first — if the divider is a generic section header that mentions multiple topics, only delete the part about the deleted describe.

Verify BEFORE commit:
- Run \`bunx vitest run src/__tests__/context-guard-runner.test.ts 2>&1 | tail -10\` — expected 49/49 PASS (the 2 deleted tests no longer run).
- Run \`bunx tsc --noEmit 2>&1 | wc -l\` — should be EQUAL to baseline.

Commit message: \`test(context-guard-runner): remove dead-code-branches pinning describe block (lines 1297-1374)\`
Body: pinning tests for the 4 deleted branches; they used mockDecideGuard.mockImplementationOnce to force the runner into the unreachable branches; no longer meaningful.

=== Commit 3: docs ===

Files:
1. docs/needs-to-be-fix/context-guard-runner-dead-code-branches.md — add a final line at the bottom: \`Resolved: 2026-MM-DD <sha-of-commit-1>\` where MM-DD is today's date (use 2026-08-19).
2. docs/needs-to-be-fix/INDEX.md — find the row with \`context-guard-runner-dead-code-branches\` and update the Resolved column from \`—\` to \`Resolved: 2026-08-19 <sha-of-commit-1>\`.

Verify BEFORE commit:
- Run \`git grep "context-guard-runner-dead-code-branches" docs/needs-to-be-fix/INDEX.md\` — confirm row is updated.
- No test runs needed (docs only).

Commit message: \`docs(needs-to-be-fix): mark context-guard-runner-dead-code-branches resolved\`
Body: cluster A complete; cycle 35 SHA.

=== Final check for Phase 2 ===

After all 3 commits:
- Run \`git log --oneline -3\` — confirm 3 new commits at HEAD in the correct order.
- Run \`git status\` — confirm clean working tree.
- Report the 3 commit SHAs.

Constraints (apply to all phases):
- DO NOT \`git push\` under any circumstance. Commit only locally.
- DO NOT modify files outside the explicit list for this phase.
- DO NOT run \`/code-review\` or any skill. The user will do that.
- If any verify step fails (test, tsc, coverage), STOP and report the failure with full output. Do not attempt to fix forward.`, { label: 'Phase 2 cluster A' })

if (!phase2) {
  log('Phase 2 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

// ============================================================
// Phase 3 — Cluster B (message-router): fix + test + docs in 3 commits
// ============================================================
phase('Phase 3 cluster B fix+test+docs')

const phase3 = await agent(`Cycle 35 Phase 3 — Cluster B (message-router) all 3 commits. Branch: test/baseline. DO NOT PUSH.

Plan file: /Users/eggp/marveen-develop/test-baseline/.claude/plans/gleaming-wiggling-dragonfly.md

This phase makes 3 sequential commits. Work in order, verify after each, then proceed.

=== Commit 1: fix ===

File: src/web/message-router.ts

Edits (the 2 dead branches):
- Lines 79-81: the comment + guard:
  \`\`\`
  // A failed message to the main agent can't happen (pull model), but guard
  // anyway so we never loop a notification back onto itself.
  if (msg.to_agent === MAIN_AGENT_ID) return
  \`\`\`
  Replace with NO code (just delete all 3 lines). The function \`notifyOrchestratorOfFailedHandoff\` starts immediately with \`const preview = (msg.content ?? '').slice(0, 220)\`.

  Add a brief comment block above \`const preview\` explaining WHY the guard is gone: \`// Dead guard removed (cycle 35): the main-loop short-circuits main-agent targets at line ~461 (continue) before reaching notifyOrchestratorOfFailedHandoff, and the inject-give-up path also filters main-agent targets. See message-router-unreachable-defensive-branches.md.\`

- Line 317: \`if (old.length === 0) return\` — replace with a single comment: \`// old.length >= 1 by construction (caller's oldestAge > BATCH_AGE_MS gate at line ~410).\`

Verify BEFORE commit:
- Run \`bunx tsc --noEmit 2>&1 | wc -l\` — should be EQUAL to baseline from Phase 1.
- Run \`bunx vitest run src/__tests__/message-router-full.test.ts 2>&1 | tail -10\` — expected 75/75 PASS (the test at 925-964 still PASSes because it tests behavior, not the guard).

Commit message: \`fix(message-router): drop 2 dead defensive guards (lines 81, 317)\`
Body: 2 unreachable branches per MD; line 81 unreachable because main-agent wakeup short-circuits before; line 317 unreachable because caller's oldestAge gate guarantees old.length >= 1.

=== Commit 2: test deletion ===

File: src/__tests__/message-router-full.test.ts

Delete the \`it('does not notify the orchestrator when the failed message was already to the main agent', ...)\` test at lines 925-964.

Verify BEFORE commit:
- Run \`bunx vitest run src/__tests__/message-router-full.test.ts 2>&1 | tail -10\` — expected 74/74 PASS (one fewer test).
- Run \`bunx tsc --noEmit 2>&1 | wc -l\` — should be EQUAL to baseline.

Commit message: \`test(message-router): remove notify-main-agent pinning test (lines 925-964)\`
Body: pinning test for the deleted line 81 guard; the test's own comment described the guard as 'defensive dead code'.

=== Commit 3: docs ===

Files (2 files updated):
1. docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md — add a final line: \`Partially resolved: 2026-08-19 <sha-of-commit-1> (lines 81, 317 deleted; lines 478-480 remain open due to TS strict blocking)\`.
2. docs/needs-to-be-fix/message-router-dead-defensive-branches.md — add a final line: \`Partially resolved: 2026-08-19 <sha-of-commit-1> (lines 81, 317 deleted; line 180 deferred as stylistic inversion, not dead code)\`.
3. docs/needs-to-be-fix/INDEX.md — find BOTH rows (\`message-router-unreachable-defensive-branches\` AND \`message-router-dead-defensive-branches\`) and update the Resolved column.

For INDEX.md updates, use the format: \`Partially resolved: 2026-08-19 <sha>\` (the "Partially" prefix is important — only lines 81, 317 are deleted; remaining branches stay open).

Verify BEFORE commit:
- Run \`git grep "message-router" docs/needs-to-be-fix/INDEX.md\` — confirm both rows updated.
- No test runs needed (docs only).

Commit message: \`docs(needs-to-be-fix): mark message-router-unreachable-defensive-branches + message-router-dead-defensive-branches partially resolved (lines 81, 317 deleted; 478-480 and 180 deferred)\`

=== Final check for Phase 3 ===

After all 3 commits:
- Run \`git log --oneline -6\` — confirm 6 total new commits (3 from Phase 2 + 3 from Phase 3) at HEAD in the correct order.
- Run \`git status\` — confirm clean working tree.
- Report the 3 commit SHAs from this phase.

Constraints:
- DO NOT \`git push\`. Commit only locally.
- DO NOT modify files outside the explicit list.
- DO NOT run /code-review.
- If any verify step fails, STOP and report.`, { label: 'Phase 3 cluster B' })

if (!phase3) {
  log('Phase 3 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

// ============================================================
// Phase 4 — Final verification
// ============================================================
phase('Phase 4 final verification')

const phase4 = await agent(`Cycle 35 Phase 4 — Final verification. Branch: test/baseline. READ-ONLY (no commits, no edits, no push).

Plan file: /Users/eggp/marveen-develop/test-baseline/.claude/plans/gleaming-wiggling-dragonfly.md

Tasks (run in order):

1. \`git status\` — confirm clean.
2. \`git log --oneline -10\` — confirm exactly 6 new commits on top of the Phase 1 baseline (a4c5aba or descendant). Confirm order matches the plan:
   - fix(context-guard-runner)
   - test(context-guard-runner)
   - docs(context-guard-runner)
   - fix(message-router)
   - test(message-router)
   - docs(message-router)
3. \`git diff origin/test/baseline --stat\` — list of changed files. Expect:
   - src/web/context-guard-runner.ts
   - src/__tests__/context-guard-runner.test.ts
   - src/web/message-router.ts
   - src/__tests__/message-router-full.test.ts
   - docs/needs-to-be-fix/context-guard-runner-dead-code-branches.md
   - docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md
   - docs/needs-to-be-fix/message-router-dead-defensive-branches.md
   - docs/needs-to-be-fix/INDEX.md
4. Run \`bunx tsc --noEmit 2>&1 | wc -l\` — confirm EQUAL to baseline from Phase 1 (delta 0).
5. Run \`bunx vitest run src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts 2>&1 | tail -20\` — confirm pass counts:
   - context-guard-runner.test.ts: 49/49
   - message-router-full.test.ts: 73/73 (75 - 2 deleted = 73)
6. Run \`bunx vitest run 2>&1 | tail -10\` — confirm total test count is baseline -2 (the 2 deleted pinning tests).
7. Run \`bunx vitest run --coverage src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts 2>&1 | grep -E "context-guard-runner|message-router|All files" | head -10\` — report branch coverage for both files. Expected:
   - context-guard-runner.ts: 100% branch (was 100%)
   - message-router.ts: improved from 96.47% (3 dead branches removed: 81, 317; but 478-480 still uncovered)
8. \`git grep -E "context-guard-runner-dead-code-branches|message-router-unreachable-defensive-branches|message-router-dead-defensive-branches" docs/needs-to-be-fix/INDEX.md\` — confirm INDEX.md is consistent with the docs commits.
9. Run \`bunx vitest run --coverage --coverage.include='src/web/context-guard-runner.ts' --coverage.include='src/web/message-router.ts' 2>&1 | tail -30\` — final branch coverage snapshot for both files. Report the exact numbers.

Output format: a structured final report with EXACT numbers for all 9 tasks. Include the 6 commit SHAs.

If ANY value is unexpected, flag with ⚠️. Do NOT attempt to fix.

Constraints:
- READ-ONLY. No edits, no commits, no push.
- Do NOT run /code-review. The user will do that after push.
- Report success or failure clearly.`, { label: 'Phase 4 final verify' })

if (!phase4) {
  log('Phase 4 agent stopped without output. Workflow aborting.')
  process.exit(1)
}

log('Cycle 35 workflow complete. 6 commits ready on test/baseline locally. Awaiting user push and /code-review.')
return { phase1, phase2, phase3, phase4 }
