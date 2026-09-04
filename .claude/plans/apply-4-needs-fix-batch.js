export const meta = {
  name: 'apply-4-needs-fix-batch',
  description: 'Apply 4 needs-fix items on test/baseline branch, one commit per fix + INDEX update',
  phases: [
    { title: 'Apply fix 1/4 (agent-process:1512 unchanged arm)' },
    { title: 'Apply fix 2/4 (agent-process:1384 || default)' },
    { title: 'Apply fix 3/4 (stuck-tool-call-watcher:141 skew clamp)' },
    { title: 'Apply fix 4/4 (routes-ideas:186-189 non-Error throw body)' },
    { title: 'Final verification' },
  ],
}

const FIX_PROMPTS = [
  // Fix 1: agent-process:1512 'unchanged' arm drop
  [
    'Apply ONE small needs-fix item on the test/baseline branch in /Users/eggp/marveen-develop/test-baseline.',
    '',
    'Bug ID: agent-process-answerfirstrungates-acted-unchanged-unreachable',
    'MD: docs/needs-to-be-fix/agent-process-answerfirstrungates-acted-unchanged-unreachable.md',
    'File: src/web/agent-process.ts',
    'Line: 1512 (function tail of answerFirstRunGates)',
    "Current code: return acted ? 'cleared' : 'unchanged'",
    "Fix: replace with return 'cleared' (the ':unchanged' arm is structurally unreachable)",
    '',
    'Why safe: per MD, every reachable path through the loop sets acted=true before natural exit.',
    '',
    'Steps:',
    '1. Confirm HEAD is 9ff771c5f9cf553c56536fb47153cc9f26981867 on test/baseline (git rev-parse HEAD; git branch --show-current). If not, STOP and report.',
    "2. sed -n '1510,1515p' src/web/agent-process.ts to verify the buggy line is still present.",
    "3. Edit line 1512 from 'return acted ? 'cleared' : 'unchanged'' to 'return 'cleared''. Use Edit tool, exact match.",
    '4. Run pinning test ONLY: bun test src/__tests__/agent-process.test.ts 2>&1 | tail -30. ALL answerFirstRunGates and restartAgentProcess tests MUST pass. If any test fails, STOP and report the failure.',
    '5. Run bun run typecheck 2>&1 | tail -5. Error count MUST be <= 1701 (current baseline). If > 1701, STOP and report.',
    '6. If both pass, commit with conventional-commit style (no push, no Co-Authored-By, no body text beyond the subject):',
    '   git add src/web/agent-process.ts',
    "   git commit -m \"fix(agent-process): drop dead : 'unchanged' ternary arm at answerFirstRunGates line 1512\"",
    "7. Update docs/needs-to-be-fix/INDEX.md: find the row starting with 'agent-process-answerfirstrungates-acted-unchanged-unreachable' in the 'Baseline unreachable addenda' section, replace ' | — |' at end of row with ' | Resolved: 2026-08-16 <sha> |'. Use the short SHA (7 chars) from step 6.",
    '8. git add docs/needs-to-be-fix/INDEX.md && git commit -m "docs(needs-to-be-fix): mark agent-process-answerfirstrungates-acted-unchanged-unreachable resolved"',
    '9. Report both SHAs (full and short). DO NOT push.',
    '',
    'If anything fails, do NOT commit. Report the failure with full context (test output, typecheck output, etc.).',
  ].join('\n'),

  // Fix 2: agent-process:1384 || default drop
  [
    'Apply ONE small needs-fix item on test/baseline branch in /Users/eggp/marveen-develop/test-baseline.',
    '',
    'Bug ID: agent-process-restartagentprocess-stop-error-default-unreachable',
    'MD: docs/needs-to-be-fix/agent-process-restartagentprocess-stop-error-default-unreachable.md',
    'File: src/web/agent-process.ts',
    'Line: 1384 (inside restartAgentProcess)',
    "Current code: if (!stopResult.ok) return { ok: false, error: stopResult.error || 'Failed to stop running agent before restart' }",
    "Fix: replace with if (!stopResult.ok) return { ok: false, error: stopResult.error! }",
    '',
    'Why safe: per MD, stopAgentProcess always returns truthy error string on ok:false paths. The || default is dead.',
    '',
    'Steps:',
    '1. Confirm HEAD is on test/baseline with the fix-1 commit on top. git log --oneline -3 should show: agent-process:1512 fix commit, the INDEX update commit, then 9ff771c. If not, STOP.',
    "2. sed -n '1380,1390p' src/web/agent-process.ts to verify the buggy line is still present.",
    '3. Edit line 1384: replace the || default with the ! non-null assertion. Use Edit tool, exact match.',
    "4. Run pinning test ONLY: bun test src/__tests__/agent-process.test.ts 2>&1 | tail -30. ALL tests MUST pass (including the 'aborts when the stop fails' test at line ~1393). If any test fails, STOP.",
    '5. Run bun run typecheck 2>&1 | tail -5. Error count MUST be <= 1701. If > 1701, STOP.',
    '6. Commit fix:',
    '   git add src/web/agent-process.ts',
    "   git commit -m \"fix(agent-process): drop dead || 'Failed to stop running agent before restart' default at line 1384\"",
    "7. Update docs/needs-to-be-fix/INDEX.md: find the row starting with 'agent-process-restartagentprocess-stop-error-default-unreachable' in the 'Baseline unreachable addenda' section. Replace ' | — |' at end of row with ' | Resolved: 2026-08-16 <sha> |' where <sha> is the short SHA from step 6.",
    '8. git add docs/needs-to-be-fix/INDEX.md && git commit -m "docs(needs-to-be-fix): mark agent-process-restartagentprocess-stop-error-default-unreachable resolved"',
    '9. Report both SHAs. DO NOT push.',
    '',
    'If anything fails, do NOT commit. Report the failure with full context.',
  ].join('\n'),

  // Fix 3: stuck-tool-call-watcher:141 skew clamp
  [
    'Apply ONE small needs-fix item on test/baseline branch in /Users/eggp/marveen-develop/test-baseline.',
    '',
    'Bug ID: stuck-tool-call-watcher-skew-defer',
    'MD: docs/needs-to-be-fix/stuck-tool-call-watcher-skew-defer.md',
    'File: src/web/stuck-tool-call-watcher.ts',
    'Line: 141 (inside shouldDeferForRecentRespawn)',
    'Bug: a future-dated respawn stamp makes shouldDeferForRecentRespawn suppress wedge recovery for the whole skew, not just the grace window',
    'Fix: clamp negative age to 0 (matches sibling fail-open posture)',
    '',
    'Steps:',
    '1. Confirm HEAD is on test/baseline with fixes 1 and 2 on top. git log --oneline -5 should show: docs commit, agent-process:1384 fix, docs commit, agent-process:1512 fix, docs commit, 9ff771c. If not, STOP.',
    '2. Read docs/needs-to-be-fix/stuck-tool-call-watcher-skew-defer.md to confirm the exact suggested fix. The MD describes the bug; read it before editing.',
    "3. sed -n '130,160p' src/web/stuck-tool-call-watcher.ts to verify the buggy code at line 141.",
    '4. Apply the smallest fix that matches the MD suggested direction. The MD recommends clamping negative age to 0. Typical pattern: short-circuit the defer when respawnAt is in the future (e.g. if (respawnAt > now) return false). Use the exact pattern from the MD.',
    '5. Run pinning test ONLY: bun test src/__tests__/stuck-tool-call-watcher.test.ts 2>&1 | tail -30. ALL tests MUST pass. If any test fails, STOP.',
    '6. Run bun run typecheck 2>&1 | tail -5. Error count MUST be <= 1701. If > 1701, STOP.',
    '7. Commit fix:',
    '   git add src/web/stuck-tool-call-watcher.ts',
    "   git commit -m \"fix(stuck-tool-call-watcher): clamp future-dated respawn stamp to 0 in shouldDeferForRecentRespawn\"",
    "8. Update docs/needs-to-be-fix/INDEX.md: find the row starting with 'stuck-tool-call-watcher-skew-defer' in the Medium section. Replace ' | — |' at end with ' | Resolved: 2026-08-16 <sha> |'.",
    '9. git add docs/needs-to-be-fix/INDEX.md && git commit -m "docs(needs-to-be-fix): mark stuck-tool-call-watcher-skew-defer resolved"',
    '10. Report both SHAs. DO NOT push.',
    '',
    'If anything fails, do NOT commit. Report the failure with full context.',
  ].join('\n'),

  // Fix 4: routes-ideas:186-189 non-Error throw body
  [
    'Apply ONE small needs-fix item on test/baseline branch in /Users/eggp/marveen-develop/test-baseline.',
    '',
    'Bug ID: routes-ideas-breakdown-nonerror',
    'MD: docs/needs-to-be-fix/routes-ideas-breakdown-nonerror.md',
    'File: src/web/routes/ideas.ts',
    'Line: 186-189',
    'Bug: (err as Error).message is undefined for a non-Error throw, so the 500 response body is {}',
    'Fix: handle non-Error throw — use a type guard so the 500 body has a useful message. Per CLAUDE.md, do NOT use (err as Error).message; use err instanceof Error ? err.message : String(err) pattern.',
    '',
    'Steps:',
    '1. Confirm HEAD is on test/baseline with fixes 1, 2, 3 on top. git log --oneline -7 should show the new commits above 9ff771c. If not, STOP.',
    '2. Read docs/needs-to-be-fix/routes-ideas-breakdown-nonerror.md to confirm the exact suggested fix.',
    "3. sed -n '180,200p' src/web/routes/ideas.ts to verify the buggy code at lines 186-189.",
    '4. Apply the smallest fix per the MD suggested direction. The pattern: change (err as Error).message to err instanceof Error ? err.message : String(err). Use type-guard style; no `as` casts.',
    '5. Run pinning test ONLY: bun test src/__tests__/ideas-routes.test.ts 2>&1 | tail -30. ALL tests MUST pass. If any test fails, STOP.',
    '6. Run bun run typecheck 2>&1 | tail -5. Error count MUST be <= 1701. If > 1701, STOP.',
    '7. Commit fix:',
    '   git add src/web/routes/ideas.ts',
    "   git commit -m \"fix(routes/ideas): handle non-Error throw so 500 body has a useful message\"",
    "8. Update docs/needs-to-be-fix/INDEX.md: find the row starting with 'routes-ideas-breakdown-nonerror' in the Medium section. Replace ' | — |' at end with ' | Resolved: 2026-08-16 <sha> |'.",
    '9. git add docs/needs-to-be-fix/INDEX.md && git commit -m "docs(needs-to-be-fix): mark routes-ideas-breakdown-nonerror resolved"',
    '10. Report both SHAs. DO NOT push.',
    '',
    'If anything fails, do NOT commit. Report the failure with full context.',
  ].join('\n'),
]

// Pipeline: each fix is sequential (later fixes depend on earlier commits landing)
const SHAs = await pipeline(
  FIX_PROMPTS,
  (prompt, _fix, idx) =>
    agent(prompt, {
      label: 'fix-' + (idx + 1) + '-of-4',
      phase: 'Apply fix ' + (idx + 1) + '/4',
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          fixCommitSha: { type: 'string' },
          indexCommitSha: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
    }),
)

// Final verification
const verify = await agent(
  [
    'Verify the final state on test/baseline in /Users/eggp/marveen-develop/test-baseline.',
    '',
    '1. git status (must be clean)',
    '2. git log --oneline -10 (must show 8 new commits: 4 fix + 4 docs, all on top of 9ff771c)',
    '3. git branch --show-current (must be test/baseline)',
    "4. grep -n 'Resolved: 2026-08-16' docs/needs-to-be-fix/INDEX.md | head -20 (must show all 4 IDs marked resolved)",
    '5. Confirm no push was issued: git log --oneline origin/test/baseline..HEAD 2>/dev/null | wc -l (this counts unpushed commits — should be 8)',
    '',
    'Report PASS/FAIL with the verification output.',
  ].join('\n'),
  {
    label: 'final-verify',
    phase: 'Final verification',
    schema: {
      type: 'object',
      properties: {
        pass: { type: 'boolean' },
        details: { type: 'string' },
      },
      required: ['pass'],
    },
  },
)

return {
  perFix: SHAs.filter(Boolean),
  verification: verify,
}
