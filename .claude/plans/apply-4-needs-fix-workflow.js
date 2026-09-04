export const meta = {
  name: 'apply-4-smallest-needs-fix',
  description: 'Apply 4 smallest needs-fix dead-code deletes on test/baseline (plan: merry-strolling-turing.md)',
  phases: [
    { title: 'Apply fix 1' },
    { title: 'Apply fix 2' },
    { title: 'Apply fix 3' },
    { title: 'Apply fix 4' },
  ],
}

const APPLY_RESULT_SCHEMA = {
  type: 'object',
  properties: {
    bug_id: { type: 'string' },
    commit_sha: { type: 'string' },
    diff_lines: { type: 'number' },
    diff_first_5_lines: { type: 'string' },
    before_tsc_errors: { type: 'number' },
    after_tsc_errors: { type: 'number' },
    pinning_test_passed: { type: 'boolean' },
    pinning_test_summary: { type: 'string' },
    full_suite_passed: { type: 'boolean' },
    full_suite_summary: { type: 'string' },
    restrictive_checks_passed: { type: 'boolean' },
    any_errors: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'bug_id', 'commit_sha', 'diff_lines', 'diff_first_5_lines',
    'before_tsc_errors', 'after_tsc_errors',
    'pinning_test_passed', 'pinning_test_summary',
    'full_suite_passed', 'full_suite_summary',
    'restrictive_checks_passed', 'any_errors',
  ],
}

const FIX_1 = {
  bugId: 'agent-restart-policy-consecutivefailures-nullish-coalesce',
  file: 'src/web/agent-restart-policy.ts',
  pinningTest: 'src/__tests__/agent-restart-policy.test.ts',
  instruction: [
    "Apply fix #1: drop the dead ?? 0 left arm of consecutiveFailures on line 132.",
    "",
    "WORKING DIRECTORY: /Users/eggp/marveen-develop/test-baseline",
    "BRANCH: test/baseline (do NOT switch, do NOT push)",
    "",
    "CURRENT CODE (lines 132-134):",
    "  const failures = Number.isFinite(input.consecutiveFailures) && (input.consecutiveFailures ?? 0) > 0",
    "    ? Math.floor(input.consecutiveFailures as number)",
    "    : 0",
    "",
    "REWRITE TO (exact pattern already established at lines 72-73 in the same file):",
    "  const failures = Number.isFinite(input.consecutiveFailures) && input.consecutiveFailures > 0",
    "    ? Math.floor(input.consecutiveFailures)",
    "    : 0",
    "",
    "WHY: Number.isFinite(null) returns false, Number.isFinite(undefined) returns false. The && short-circuits before ?? 0. Drop the ?? 0 AND the 'as number' (the 'as' is banned by project rules; the type is narrowed to number by Number.isFinite typeguard, so Math.floor works without it).",
    "",
    "STEPS:",
    "1. Read src/web/agent-restart-policy.ts around lines 128-140 to confirm the input type AgentRestartDecisionInput.consecutiveFailures is number | null (line 35 of the same file).",
    "2. Use the Edit tool to replace the 3 lines (132-134) with the 3 lines above.",
    "3. Run 'bun run typecheck 2>&1 | grep -cE \"^[a-zA-Z./][^(]*\\([0-9]+,[0-9]+\\): error TS\"' - quote the count (must be 1700).",
    "4. Run 'bun test src/__tests__/agent-restart-policy.test.ts 2>&1 | tail -15' - quote the result (must pass all 20 cases).",
    "5. Run full suite 'bun test 2>&1 | tail -10' - quote the final summary line (must show 381 passed / 11077 passed).",
    "6. 'git diff --stat' - confirm only that file changed.",
    "7. 'git add src/web/agent-restart-policy.ts && git commit -m \"fix(agent-restart-policy): drop dead ?? 0 left arm of consecutiveFailures (Number.isFinite narrows)\"'",
    "8. 'git log -1 --format=%H' - capture the commit SHA.",
    "",
    "RESTRICTIVE CHECKS (must all pass before commit):",
    "- The diff is exactly 2 lines changed (1 removed '?? 0', 1 removed 'as number') OR 3 lines replaced (the multiline ternary as a block).",
    "- No new 'as' or 'any' introduced.",
    "- No string concatenation (template strings only).",
    "- The file is the ONLY one modified ('git status --short' shows only that file before commit).",
    "- Typecheck error count is EXACTLY 1700 (no new errors).",
    "- No push. Branch unchanged.",
  ].join('\n'),
}

const FIX_2 = {
  bugId: 'channel-coordinator-setOffset-null-maxUpdateId',
  file: 'src/channel-coordinator.ts',
  pinningTest: 'src/__tests__/channel-coordinator-process-batch.test.ts',
  instruction: [
    "Apply fix #2: drop the dead if (maxUpdateId != null) guard around setOffset.",
    "",
    "WORKING DIRECTORY: /Users/eggp/marveen-develop/test-baseline",
    "BRANCH: test/baseline (do NOT switch, do NOT push)",
    "",
    "CURRENT CODE (lines 399-401):",
    "  const maxUpdateId = processBatch(updates)",
    "  // Persist offset ONLY after the batch is durable + handed off.",
    "  if (maxUpdateId != null) setOffset(SOURCE, maxUpdateId)",
    "",
    "REWRITE TO:",
    "  const maxUpdateId = processBatch(updates)",
    "  // Persist offset ONLY after the batch is durable + handed off.",
    "  setOffset(SOURCE, maxUpdateId)",
    "",
    "WHY: The runLoop filters empty batches on line 387 (if (updates.length === 0) continue). processBatch is only called with non-empty arrays, so it never returns null here. The if guard is structurally unreachable.",
    "",
    "STEPS:",
    "1. Read src/channel-coordinator.ts around lines 395-405 to confirm the context.",
    "2. Use the Edit tool to delete the 'if (' part and the ') ' part, leaving just 'setOffset(SOURCE, maxUpdateId)'.",
    "3. Run 'bun run typecheck 2>&1 | grep -cE \"^[a-zA-Z./][^(]*\\([0-9]+,[0-9]+\\): error TS\"' - quote the count (must be 1700).",
    "4. Run 'bun test src/__tests__/channel-coordinator-process-batch.test.ts 2>&1 | tail -15' - quote the result.",
    "5. Run full suite 'bun test 2>&1 | tail -10' - quote the final summary.",
    "6. 'git diff --stat' - confirm only that file changed.",
    "7. 'git add src/channel-coordinator.ts && git commit -m \"fix(channel-coordinator): inline setOffset (null guard is unreachable - processBatch never returns null here)\"'",
    "8. 'git log -1 --format=%H' - capture the commit SHA.",
    "",
    "RESTRICTIVE CHECKS:",
    "- Diff is exactly 1 line modified (drop the if/).",
    "- No other files touched.",
    "- Typecheck error count is EXACTLY 1700.",
    "- No push.",
  ].join('\n'),
}

const FIX_3 = {
  bugId: 'agent-process-777-ts-strict-blocks-delete',
  file: 'src/web/agent-process.ts',
  pinningTest: 'src/__tests__/agent-process.test.ts',
  instruction: [
    "Apply fix #3: TWO atomic edits in src/web/agent-process.ts.",
    "",
    "WORKING DIRECTORY: /Users/eggp/marveen-develop/test-baseline",
    "BRANCH: test/baseline (do NOT switch, do NOT push)",
    "",
    "EDIT A (line 978 - the orphan call site that blocks the safe-delete):",
    "  CURRENT: runTmux(null, ['kill-session', '-t', session])",
    "  REWRITE: runTmux(null, ['kill-session', '-t', session], { timeout: 5000 })",
    "",
    "EDIT B (line 777 - the dead truthy arm of the timeout ternary):",
    "  CURRENT: timeout: opts.timeout ?? (host ? 8000 : 3000)",
    "  REWRITE: timeout: opts.timeout ?? 3000",
    "",
    "WHY: The truthy arm of '(host ? 8000 : 3000)' is dead because ~20 other call sites (lines 899, 1298, 1349, 1402, 1424, 1426, 1451, 1453 etc.) all pass an explicit opts.timeout. Only the orphan at line 978 omits opts. Adding the explicit timeout to line 978 unblocks the safe-delete.",
    "",
    "runTmux signature is at line 766: function runTmux(host: string | null, tmuxArgs: string[], opts: { timeout?: number } = {}): void. Confirmed the third arg is opts.",
    "",
    "STEPS:",
    "1. Read src/web/agent-process.ts around lines 770-780 and 975-985 to confirm context.",
    "2. Edit A: change line 978 to add the third arg.",
    "3. Edit B: change line 777 to drop the truthy arm.",
    "4. Run 'bun run typecheck 2>&1 | grep -cE \"^[a-zA-Z./][^(]*\\([0-9]+,[0-9]+\\): error TS\"' - quote the count (must be 1700).",
    "5. Run 'bun test src/__tests__/agent-process.test.ts 2>&1 | tail -15' - quote the result.",
    "6. Run full suite 'bun test 2>&1 | tail -10' - quote the final summary.",
    "7. 'git diff --stat' - confirm only that file changed.",
    "8. 'git add src/web/agent-process.ts && git commit -m \"fix(agent-process): drop dead truthy arm of runTmux timeout; add explicit opts.timeout at line 978\"'",
    "9. 'git log -1 --format=%H' - capture the commit SHA.",
    "",
    "RESTRICTIVE CHECKS:",
    "- Diff is exactly 2 lines modified (line 777 ternary collapse + line 978 add opts).",
    "- No other files touched.",
    "- Typecheck error count is EXACTLY 1700.",
    "- No push.",
  ].join('\n'),
}

const FIX_4 = {
  bugId: 'routes-docs-basename-redundant',
  file: 'src/web/routes/docs.ts',
  pinningTest: 'src/__tests__/routes-docs.test.ts',
  instruction: [
    "Apply fix #4: drop the redundant basename disjunct + unused basename import.",
    "",
    "WORKING DIRECTORY: /Users/eggp/marveen-develop/test-baseline",
    "BRANCH: test/baseline (do NOT switch, do NOT push)",
    "",
    "EDIT A (line 62 - the redundant disjunct):",
    "  CURRENT: if (!NAME_RE.test(name) || basename(name) !== name) {",
    "  REWRITE: if (!NAME_RE.test(name)) {",
    "",
    "EDIT B (line 2 - the now-unused basename import):",
    "  CURRENT: import { join, basename } from 'node:path'",
    "  REWRITE: import { join } from 'node:path'",
    "",
    "WHY: NAME_RE is /^[A-Za-z0-9._-]+\\.md$/ (line 14). The character class excludes / and \\, so basename(name) === name by construction. The disjunct is unreachable. basename is used only in this one spot (verified by grep).",
    "",
    "STEPS:",
    "1. Read src/web/routes/docs.ts around lines 1-5 and 60-66 to confirm context.",
    "2. Edit A: change line 62 to drop the disjunct.",
    "3. Edit B: change line 2 to drop basename from the import.",
    "4. Run 'bun run typecheck 2>&1 | grep -cE \"^[a-zA-Z./][^(]*\\([0-9]+,[0-9]+\\): error TS\"' - quote the count (must be 1700; removing the unused import MAY reduce 1 error if a noUnusedLocals rule is on, but our count says 1700 at HEAD; if it drops to 1699 that's fine - just quote the new count).",
    "5. Run 'bun test src/__tests__/routes-docs.test.ts 2>&1 | tail -15' - quote the result.",
    "6. Run full suite 'bun test 2>&1 | tail -10' - quote the final summary.",
    "7. 'git diff --stat' - confirm only that file changed.",
    "8. 'git add src/web/routes/docs.ts && git commit -m \"fix(routes/docs): drop redundant basename disjunct (NAME_RE excludes / and \\\\); remove unused basename import\"'",
    "9. 'git log -1 --format=%H' - capture the commit SHA.",
    "",
    "RESTRICTIVE CHECKS:",
    "- Diff is exactly 2 lines modified (line 62 disjunct + line 2 import).",
    "- No other files touched.",
    "- Typecheck error count is 1700 or 1699 (both acceptable; quote the actual count).",
    "- No push.",
  ].join('\n'),
}

const FIXES = [FIX_1, FIX_2, FIX_3, FIX_4]

const results = await pipeline(
  FIXES,
  fix => agent(
    "You are applying a needs-fix dead-code delete.\n\n" +
    fix.instruction + "\n\n" +
    "OUTPUT FORMAT: Call the StructuredOutput tool with this exact schema:\n\n" +
    "{\n" +
    "  bug_id: string,\n" +
    "  commit_sha: string (40-char hex),\n" +
    "  diff_lines: number (lines changed per git diff --stat),\n" +
    "  diff_first_5_lines: string (first 5 lines of git diff output),\n" +
    "  before_tsc_errors: number (1700 at HEAD),\n" +
    "  after_tsc_errors: number (must equal before, or 1699 if a noUnusedLocals drop occurs),\n" +
    "  pinning_test_passed: boolean (true if all pinning tests pass),\n" +
    "  pinning_test_summary: string (last 5 lines of pinning test output),\n" +
    "  full_suite_passed: boolean (true if all 381/11077 tests pass),\n" +
    "  full_suite_summary: string (last 5 lines of bun test output),\n" +
    "  restrictive_checks_passed: boolean (all 6 restrictive checks above pass),\n" +
    "  any_errors: string[] (any error encountered, empty array if none)\n" +
    "}\n\n" +
    "FAIL THE TASK (set restrictive_checks_passed=false, return any_errors) IF:\n" +
    "- Typecheck error count changed by more than 1.\n" +
    "- Pinning test fails.\n" +
    "- Full suite fails.\n" +
    "- Diff modifies more than the 2 cited lines.\n" +
    "- Any other file was touched.\n" +
    "- 'as' or 'any' was introduced.\n" +
    "- String concatenation was introduced.\n" +
    "- Push was attempted.\n\n" +
    "Do NOT skip the verification. Do NOT trust your own work without running the tests and quoting the output.",
    {
      schema: APPLY_RESULT_SCHEMA,
      phase: 'Apply fix ' + (FIXES.indexOf(fix) + 1),
    }
  )
)

return { results }
