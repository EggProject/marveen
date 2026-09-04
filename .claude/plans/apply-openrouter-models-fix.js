export const meta = {
  name: 'apply-openrouter-models-fix',
  description: 'Cycle 25.5: 1-line ?? || fix in openrouter-models.ts + test flip + INDEX',
  phases: [
    { title: 'Apply fix at openrouter-models.ts:172' },
    { title: 'Flip test assertion in openrouter-models.test.ts' },
    { title: 'Update INDEX.md' },
    { title: 'Verify' },
  ],
}

const FIX_PROMPT = [
  'Apply ONE small needs-fix item on the test/baseline branch in /Users/eggp/marveen-develop/test-baseline.',
  '',
  'Bug ID: openrouter-models-tier1-auto-empty-fallback',
  'MD: docs/needs-to-be-fix/openrouter-models-tier1-auto-empty-fallback.md',
  'File: src/web/openrouter-models.ts',
  'Line: 172, inside resolveOpenRouterModel',
  'Current code:',
  "  return cat.tiers.find(t => t.key === 'tier1')?.auto ?? 'deepseek/deepseek-chat-v3.1'",
  'Fix: replace ?? with ||. After:',
  "  return cat.tiers.find(t => t.key === 'tier1')?.auto || 'deepseek/deepseek-chat-v3.1'",
  '',
  'Why safe: the second-tier fallback is the literal "deepseek/deepseek-chat-v3.1" (truthy). The || vs ?? distinction only matters for 0, false, "", NaN, null, undefined. None of these are valid model IDs. The fix aligns the fallback with the surrounding if (tier?.auto) guard, which already treats "" as falsy.',
  '',
  'STRICT MODIFY DIRECTIVE — do NOT add type guards, defensive code, helper functions, or refactor the surrounding code. The diff MUST be exactly 1 character changed in src/web/openrouter-models.ts (?? becomes ||). No whitespace, no formatting, no other lines touched.',
  '',
  'Steps:',
  '1. Confirm HEAD is on test/baseline (git branch --show-current). If not, STOP and report.',
  "2. Verify the buggy line is present: grep -n 'deepseek/deepseek-chat-v3.1' src/web/openrouter-models.ts | grep -F '??'. If not found, STOP and report.",
  '3. Edit the file: change ?? to || on the line that returns the deepseek default. Use Edit tool with exact match. ONE character change only.',
  '4. Verify the diff: git diff --shortstat src/web/openrouter-models.ts MUST show 1 file changed, 1 insertion(+), 1 deletion(-) (the ?? replaced by ||). If anything else changed, STOP and report.',
  '5. Run pinning test: bun --bun vitest run src/__tests__/openrouter-models.test.ts 2>&1 | tail -30. ALL tests MUST pass. If any test fails, STOP and report.',
  '6. Run typecheck: bun run typecheck 2>&1 | tail -5. Error count MUST be <= 2255 (current baseline). If > 2255, STOP and report.',
  '7. Commit fix with conventional-commit style:',
  '   git add src/web/openrouter-models.ts',
  "   git commit -m 'fix(openrouter-models): use || so empty tier1.auto falls back to deepseek default (closes openrouter-models-tier1-auto-empty-fallback)'",
  '8. Report the fix commit SHA.',
  '',
  'If anything fails, do NOT commit. Report the failure with full context (test output, typecheck output, git diff output).',
].join('\n')

const TEST_FLIP_PROMPT = [
  'Apply ONE small needs-fix follow-up on the test/baseline branch in /Users/eggp/marveen-develop/test-baseline.',
  '',
  'Bug ID: openrouter-models-tier1-auto-empty-fallback (test flip)',
  'File: src/__tests__/openrouter-models.test.ts',
  'Background: a fix was just committed that changes ?? to || in resolveOpenRouterModel. The pinning test for the "ervenytelen tierKey es tier1.auto ures" case (or "jelenleg ures stringet ad (defect: a ?? nem kapja el az ures stringet)") currently asserts the BUGGY behavior (empty string). It must be flipped to assert the CORRECTED behavior.',
  '',
  'Find the test case:',
  '  grep -n "ervenytelen tierKey es tier1.auto ures" src/__tests__/openrouter-models.test.ts',
  '  grep -n "jelenleg ures stringet ad" src/__tests__/openrouter-models.test.ts',
  '',
  'Current assertion (somewhere in that test block):',
  "  expect(resolved).toBe('')  // or similar empty-string assertion",
  'Flipped assertion:',
  "  expect(resolved).toBe('deepseek/deepseek-chat-v3.1')",
  '',
  'STRICT MODIFY DIRECTIVE — change ONLY the assertion value. Do NOT rewrite the test description, the surrounding it/test() block, the comments, or any setup code. Keep the existing TODO-style comment ("jelenleg ures stringet ad (defect: a ?? nem kapja el az ures stringet)") in place — it documents the failure mode that the fix protects against.',
  '',
  'Steps:',
  '1. Confirm HEAD is on test/baseline with the fix commit on top (git log --oneline -3). If not, STOP.',
  '2. Find the test case and identify the exact line that asserts the empty string.',
  '3. Edit the assertion: change the expected value from "" to "deepseek/deepseek-chat-v3.1". Use Edit tool with exact match.',
  '4. Verify the diff: git diff --shortstat src/__tests__/openrouter-models.test.ts MUST show 1 file changed, 1 insertion(+), 1 deletion(-).',
  '5. Run the updated test: bun --bun vitest run src/__tests__/openrouter-models.test.ts 2>&1 | tail -30. ALL tests MUST pass.',
  '6. Run full suite: bun --bun vitest run 2>&1 | tail -10. The total test count should be unchanged OR +1 if you added a new case (do NOT add a new case).',
  '7. Commit test flip:',
  '   git add src/__tests__/openrouter-models.test.ts',
  "   git commit -m 'test(openrouter-models): invert empty-tier1-auto assertion to expect deepseek default'",
  '8. Report the test flip commit SHA.',
  '',
  'If anything fails, do NOT commit. Report the failure with full context.',
].join('\n')

const DOCS_PROMPT = [
  'Apply ONE small needs-fix follow-up (docs) on the test/baseline branch in /Users/eggp/marveen-develop/test-baseline.',
  '',
  'Bug ID: openrouter-models-tier1-auto-empty-fallback (docs update)',
  'File: docs/needs-to-be-fix/INDEX.md',
  'Background: two commits have landed on test/baseline — a fix and a test flip — for the openrouter-models-tier1-auto-empty-fallback bug. The INDEX entry must be marked Resolved.',
  '',
  'Steps:',
  '1. Confirm HEAD is on test/baseline with both the fix and test flip commits on top (git log --oneline -5). If not, STOP.',
  '2. Find the row in docs/needs-to-be-fix/INDEX.md tagged `openrouter-models-tier1-auto-empty-fallback`. It is in the "Baseline unreachable addenda" section.',
  '3. Verify the current row shows " | — |" in the Resolved column.',
  '4. Replace the row entry. Get the SHORT SHA (7 chars) of the fix commit (the FIRST commit, not the test flip):',
  '   git rev-parse --short HEAD~1   (because HEAD is the test flip, HEAD~1 is the fix)',
  '5. Edit the row: replace " | — |" at the end with " | Resolved: 2026-08-18 <short-sha> |" where <short-sha> is the 7-char SHA from step 4.',
  '6. Verify the diff: git diff --shortstat docs/needs-to-be-fix/INDEX.md MUST show 1 file changed, 1 insertion(+), 1 deletion(-).',
  '7. Commit docs:',
  '   git add docs/needs-to-be-fix/INDEX.md',
  "   git commit -m 'docs(needs-to-be-fix): mark openrouter-models-tier1-auto-empty-fallback resolved'",
  '8. Report the docs commit SHA and the final git log --oneline -5 output.',
  '',
  'If anything fails, do NOT commit. Report the failure with full context.',
].join('\n')

const VERIFY_PROMPT = [
  'Verify the final state on test/baseline in /Users/eggp/marveen-develop/test-baseline.',
  '',
  '1. git status (must be clean)',
  '2. git log --oneline -5 (must show exactly 3 new commits on top of 696c248: docs, test flip, fix)',
  '3. git branch --show-current (must be test/baseline)',
  '4. grep -n "openrouter-models-tier1-auto-empty-fallback" docs/needs-to-be-fix/INDEX.md (must show the row with Resolved: 2026-08-18)',
  '5. git diff 696c248..HEAD --stat (must show exactly 3 files changed: src/web/openrouter-models.ts, src/__tests__/openrouter-models.test.ts, docs/needs-to-be-fix/INDEX.md)',
  '6. git diff 696c248..HEAD -- src/web/openrouter-models.ts (must show exactly 1 line: ?? becomes ||)',
  '7. git diff 696c248..HEAD -- src/__tests__/openrouter-models.test.ts (must show exactly the assertion flip from "" to "deepseek/deepseek-chat-v3.1")',
  '8. Run pinning test: bun --bun vitest run src/__tests__/openrouter-models.test.ts 2>&1 | tail -5. Must show all tests passing.',
  '9. Run full suite: bun --bun vitest run 2>&1 | tail -5. Must show all tests passing.',
  '10. Run typecheck: bun run typecheck 2>&1 | tail -5. Error count MUST be 2255 (no change).',
  '11. Confirm no push was issued: git log --oneline origin/test/baseline..HEAD 2>/dev/null | wc -l (this counts unpushed commits — should be 3).',
  '',
  'Report PASS or FAIL with verification details for each step.',
].join('\n')

const SHAs = await pipeline(
  [FIX_PROMPT, TEST_FLIP_PROMPT, DOCS_PROMPT],
  (prompt, _item, idx) =>
    agent(prompt, {
      label: 'step-' + (idx + 1) + '-of-3',
      phase: 'Apply fix ' + (idx + 1) + '/3',
      schema: {
        type: 'object',
        properties: {
          ok: { type: 'boolean' },
          commitSha: { type: 'string' },
          error: { type: 'string' },
        },
        required: ['ok'],
      },
    }),
)

const verify = await agent(VERIFY_PROMPT, {
  label: 'final-verify',
  phase: 'Verify',
  schema: {
    type: 'object',
    properties: {
      pass: { type: 'boolean' },
      details: { type: 'string' },
    },
    required: ['pass'],
  },
})

return {
  perStep: SHAs.filter(Boolean),
  verification: verify,
}
