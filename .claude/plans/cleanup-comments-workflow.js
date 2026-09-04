export const meta = {
  name: 'cycle35-cleanup-temp-comments',
  description: 'Strip cycle numbers, MD refs, commit SHAs from all comments in src/',
  phases: [
    { title: 'Phase 1 discovery' },
    { title: 'Phase 2 src/web cleanup' },
    { title: 'Phase 3 src/__tests__ cleanup' },
    { title: 'Phase 4 verify' },
  ],
};

phase('Phase 1 discovery')

const phase1 = await agent('Cleanup Phase 1 — discovery. NO EDITS.\n' +
'Base dir: /Users/eggp/marveen-develop/test-baseline/src\n\n' +
'Goal: produce a TABLE of every comment containing temporal/process artifacts.\n\n' +
'Patterns to grep (use grep -rn with --include=*.ts):\n' +
'  1. "cycle [0-9]" — e.g. cycle 35, cycle 32\n' +
'  2. "docs/needs-to-be-fix/" or any ".md" in a comment\n' +
'  3. 7+ char hex (commit SHA in comment)\n' +
'  4. "Regression --", "Bug MD:", "PINNING (docs", "Pins docs", "TRIPWIRE (cycle", "added in commit", "removed in commit", "fixed in commit", "see ... -dead-", "see ... -unreachable-"\n\n' +
'For every match, output a row in this format (use printf, not JS template literals):\n' +
'  ROW: file=<path> | line=<n> | category=<cycle-ref|md-ref|commit-sha|temporal-marker> | text=<one-line trimmed comment> | recommended=<REMOVE|SIMPLIFY>\n\n' +
'SIMPLIFY examples:\n' +
'  "TRIPWIRE (cycle 32 regression, 2026-08-19): giveUpAlerted gates the warn" -> keep "TRIPWIRE: giveUpAlerted gates the warn"\n' +
'  "PINNING (docs/needs-to-be-fix/channel-poller-reap-botpid-killed-without-identity-check.md):" -> keep "PINNING reap-botpid-killed-without-identity-check:"\n\n' +
'REMOVE examples:\n' +
'  "Dead guard removed (cycle 35): ..." -> REMOVE entirely (no timeless invariant value)\n' +
'  "See message-router-unreachable-defensive-branches.md." -> REMOVE entirely\n' +
'  "Regression -- docs/needs-to-be-fix/voice-directive-json-quote-escape.md" -> REMOVE entirely\n\n' +
'Run grep separately for each pattern. Group results by file. List EVERY match — do not skip.\n\n' +
'Also list files that have NO temporal comments (so Phase 2/3 know which to skip).\n\n' +
'Do NOT modify any file. Output the report only.', { label: 'Phase 1 discovery' })

if (!phase1) { log('Phase 1 stopped. Aborting.'); process.exit(1) }

phase('Phase 2 src/web cleanup')

const phase2 = await agent('Cleanup Phase 2 — strip temporal comments from src/web/ files. EDIT + COMMIT.\n\n' +
'Phase 1 discovery produced a list of comments to fix in src/web/.\n\n' +
'For each file in src/web/ that has temporal comments:\n' +
'- Read the current file\n' +
'- Apply the recommended change from Phase 1 (REMOVE the line, or SIMPLIFY to drop cycle/MD/SHA references)\n' +
'- DO NOT change any non-comment code\n' +
'- DO NOT touch src/__tests__/ (Phase 3 handles that)\n\n' +
'Files expected (from Phase 1 scan, may include others):\n' +
'- src/web/message-router.ts (lines 79, 82 area)\n' +
'- src/web/stuck-input-watcher.ts (lines 126, 174, 216)\n' +
'- src/web/schedule-runner.ts (line 473)\n' +
'- + any other src/web/*.ts files flagged by Phase 1\n\n' +
'Minimal-change rule: drop only the cycle number / MD path / SHA / temporal marker. KEEP any invariant explanation.\n\n' +
'Verify BEFORE commit:\n' +
'- bunx tsc --noEmit 2>&1 | wc -l → should be 2253 (no delta)\n' +
'- bun --bun vitest run src/__tests__/message-router-full.test.ts src/__tests__/stuck-input-watcher.test.ts 2>&1 | tail -5 → PASS\n\n' +
'Commit message:\n' +
'  chore(web): strip cycle/MD/SHA references from comments in src/web/\n' +
'  Timeless-comment rule cleanup. Cycle numbers, MD paths, SHAs, "added in commit X" markers are not part of the invariant.\n' +
'  Files touched: (list each file with line delta)\n\n' +
'Constraints:\n' +
'- DO NOT change non-comment code\n' +
'- DO NOT push\n' +
'- DO NOT touch src/__tests__/', { label: 'Phase 2 src/web' })

if (!phase2) { log('Phase 2 stopped. Aborting.'); process.exit(1) }

phase('Phase 3 src/__tests__ cleanup')

const phase3 = await agent('Cleanup Phase 3 — strip temporal comments from src/__tests__/ files. EDIT + COMMIT.\n\n' +
'Phase 1 discovery produced a list of comments to fix in src/__tests__/.\n\n' +
'For each test file with temporal comments:\n' +
'- Read the current file\n' +
'- Apply the recommended change (REMOVE the line, or SIMPLIFY to drop cycle/MD/SHA)\n' +
'- DO NOT change any test code, test names, assertions, imports\n' +
'- DO NOT touch src/web/ (Phase 2 already handled that)\n\n' +
'SIMPLIFY example for test pinning comments:\n' +
'  "// PINNING (docs/needs-to-be-fix/channel-poller-reap-botpid-killed-without-identity-check.md):" -> "// PINNING reap-botpid-killed-without-identity-check:"\n\n' +
'REPLACE "Pinned defects (documented in docs/needs-to-be-fix/, NOT fixed here):" with "Pinned defects (NOT fixed here):"\n\n' +
'For each file: read first, plan, apply, verify, then next file.\n\n' +
'Verify BEFORE commit:\n' +
'- bun --bun vitest run src/__tests__/ 2>&1 | tail -10 → no test regressions\n' +
'(if full suite too slow, run only affected test files based on Phase 1 list)\n\n' +
'Commit message:\n' +
'  chore(tests): strip cycle/MD/SHA references from comments in src/__tests__/\n' +
'  Timeless-comment rule cleanup. Pinning comments reference the DEFECT NAME, not the MD path.\n' +
'  Files touched: (list with line delta)\n\n' +
'Constraints:\n' +
'- DO NOT change test code, assertions, imports\n' +
'- DO NOT push', { label: 'Phase 3 tests' })

if (!phase3) { log('Phase 3 stopped. Aborting.'); process.exit(1) }

phase('Phase 4 final verify')

const phase4 = await agent('Cleanup Phase 4 — final verification. READ-ONLY.\n\n' +
'Tasks:\n' +
'1. git status → clean\n' +
'2. git log --oneline 2ca6901..HEAD → expect 9 commits (cycle 35: 6 + /code-review: 1 + Phase 2 + Phase 3)\n' +
'3. git diff origin/test/baseline --stat → list all changed files\n' +
'4. bunx tsc --noEmit 2>&1 | wc -l → expect 2253 (no delta)\n' +
'5. bun --bun vitest run --coverage src/__tests__/context-guard-runner.test.ts src/__tests__/message-router-full.test.ts 2>&1 | tail -10 → coverage unchanged\n' +
'6. grep -rn "cycle [0-9]" /Users/eggp/marveen-develop/test-baseline/src --include=*.ts → expect ZERO matches\n' +
'7. grep -rn "docs/needs-to-be-fix" /Users/eggp/marveen-develop/test-baseline/src --include=*.ts → expect ZERO matches in src/web/, ZERO or minimal in src/__tests__/ (only intentional preserved ones)\n' +
'8. bun --bun vitest run 2>&1 | tail -5 → all green, no regressions\n\n' +
'Output structured report with EXACT numbers for all 8 tasks. Flag unexpected with WARN.\n\n' +
'Constraints:\n' +
'- READ-ONLY. No edits, no commits, no push.\n' +
'- Do NOT run /code-review.', { label: 'Phase 4 verify' })

if (!phase4) { log('Phase 4 stopped. Aborting.'); process.exit(1) }

log('Cleanup workflow complete. Awaiting user push and /code-review xhigh --fix.')
return { phase1, phase2, phase3, phase4 }
