export const meta = {
  name: 'cycle35-cleanup-temp-comments-part2',
  description: 'Strip cycle/MD/SHA/date/process references from web/, scripts/, tests/',
  phases: [
    { title: 'Phase 5 discovery' },
    { title: 'Phase 6 web cleanup' },
    { title: 'Phase 7 scripts cleanup' },
    { title: 'Phase 8 tests cleanup' },
    { title: 'Phase 9 verify' },
  ],
};

phase('Phase 5 discovery')

const phase5 = await agent('Cleanup Phase 5 — broader discovery. NO EDITS.\n\n' +
'Scan these dirs for any comment containing temporal/process artifacts:\n' +
'- /Users/eggp/marveen-develop/test-baseline/web/\n' +
'- /Users/eggp/marveen-develop/test-baseline/scripts/\n' +
'- /Users/eggp/marveen-develop/test-baseline/tests/\n' +
'- /Users/eggp/marveen-develop/test-baseline/templates/\n' +
'- /Users/eggp/marveen-develop/test-baseline/seed-config/\n' +
'- /Users/eggp/marveen-develop/test-baseline/seed-scheduled-tasks/\n' +
'- /Users/eggp/marveen-develop/test-baseline/seed-skills/\n\n' +
'Patterns (use grep -rn with --include=\'*.{js,ts,mjs,sh,md,json,yml,yaml,html,css}\'):\n' +
'1. "cycle [0-9]"\n' +
'2. "docs/needs-to-be-fix/" or any "needs-to-be-fix" reference\n' +
'3. 7+ char hex (commit SHA in comment) — but ONLY in comments, not in real code/data\n' +
'4. "card [a-f0-9]{4,}" (kanban card refs like "card 06f062e4")\n' +
'5. "(2026-0[1-9])" or "(2026-1[0-2])" in parentheses (incident dates)\n' +
'6. "Regression --", "Bug MD:", "PINNING", "Pins docs", "TRIPWIRE (cycle", "added in commit", "fixed in commit", "see ... -dead-", "see ... -unreachable-"\n\n' +
'For each match, output a row:\n' +
'  ROW: file=<path> | line=<n> | category=<cycle-ref|md-ref|commit-sha|card-ref|incident-date|temporal-marker> | text=<one-line trimmed> | recommended=<REMOVE|SIMPLIFY|REWRITE>\n\n' +
'For incident-date pattern "(2026-MM-DD)" inside a comment that documents WHY (incident context, what was learned):\n' +
'  IF the date is essential to understanding the incident (e.g., "disk-full event") → REWRITE: drop the date, keep the incident description\n' +
'  IF the comment is purely historical without invariant value → REMOVE\n\n' +
'Be AGGRESSIVE about removing dates. The user said "senki nem fog emlékezni" (no one will remember). Code documents the WHAT; comments should document the WHY-in-invariant; incident dates are process artifacts.\n\n' +
'Group results by directory. List EVERY match — do not skip. Also list files in each dir that have NO temporal comments.\n\n' +
'Do NOT modify any file. Output the report only.', { label: 'Phase 5 discovery' })

if (!phase5) { log('Phase 5 stopped. Aborting.'); process.exit(1) }

phase('Phase 6 web cleanup')

const phase6 = await agent('Cleanup Phase 6 — strip temporal comments from web/ files. EDIT + COMMIT.\n\n' +
'Base dir: /Users/eggp/marveen-develop/test-baseline/web/\n\n' +
'For each web/ file that has temporal comments (from Phase 5):\n' +
'- Read the file\n' +
'- Apply the recommended change (REMOVE the comment line, REWRITE to drop date/SHA/card, or SIMPLIFY to drop cycle/MD refs)\n' +
'- DO NOT change any non-comment code\n' +
'- DO NOT touch src/ (already cleaned) or scripts/ (Phase 7) or tests/ (Phase 8)\n\n' +
'Examples for web/app.js (single file):\n' +
'- "// Rick\'s spec (kanban card 209696a9): t(key,params), window._i18n={hu,en}," → "// t(key,params), window._i18n={hu,en}" (drop card ref)\n' +
'- "// \'idle\', which is how one sat unusable for hours on 2026-07-27." → "// \'idle\': one sat unusable for hours." (drop date)\n' +
'- "title=\"Self-declared by the sender, not verified (card 06f062e4)\"" → "title=\"Self-declared by the sender, not verified\"" (drop card)\n' +
'- "// Sonnet 5 launched on introductory pricing (2 / 10) that ends 2026-08-31;" → "// Sonnet 5 launched on introductory pricing (2 / 10);" (drop date)\n\n' +
'Minimal-change rule: drop only the temporal/process content, KEEP the invariant description.\n\n' +
'Verify BEFORE commit:\n' +
'- No type check needed for web/app.js (plain JS, no TS)\n' +
'- Spot-check the resulting file for syntax correctness (look for unmatched braces/parens)\n' +
'- The web/ bundle is not exercised by vitest, so no test verification possible\n\n' +
'Commit message:\n' +
'  chore(web): strip cycle/MD/SHA/card/date references from web/app.js\n' +
'  Timeless-comment rule cleanup. Card refs, dates, and SHAs are process artifacts.\n' +
'  Files touched: web/app.js (line delta)\n\n' +
'Constraints:\n' +
'- DO NOT change non-comment code\n' +
'- DO NOT push\n' +
'- DO NOT touch other directories', { label: 'Phase 6 web' })

if (!phase6) { log('Phase 6 stopped. Aborting.'); process.exit(1) }

phase('Phase 7 scripts cleanup')

const phase7 = await agent('Cleanup Phase 7 — strip temporal comments from scripts/ files. EDIT + COMMIT.\n\n' +
'Base dir: /Users/eggp/marveen-develop/test-baseline/scripts/\n\n' +
'For each scripts/ file (.sh and .mjs) that has temporal comments (from Phase 5):\n' +
'- Read the file\n' +
'- Apply the recommended change. Be AGGRESSIVE:\n' +
'  * "ROOT-CAUSE NOTE (kali-linux WSL, claude-code 2.1.152, 2026-05-27):" → drop date+version, keep "ROOT-CAUSE NOTE:" if it documents WHY\n' +
'  * "poweroff (2026-07-09)." → "poweroff."\n' +
'  * "OBSERVE-ONLY mode (Istvan standing directive 2026-07-09, re-confirmed 2026-07-15):" → "OBSERVE-ONLY mode:" (drop date references)\n' +
'  * "found by pg: Heli denied a harmless memory" → keep "Heli" (a person reference, not process)\n' +
'  * "(measured 2026-07-26, found by Hacker)" → drop entirely if just timestamp\n' +
'  * "# Incident it fixes (2026-06-03 dawn):" → keep "Incident it fixes:" if WHY matters, drop date\n' +
'  * "# exactly how the 2026-07-27 evening 401 outage" → keep description without date\n' +
'  * "# (2026-07-15 bootcamp: terminal-pasted setup-token never reached .env)" → keep invariant: "terminal-pasted setup-token never reached .env"\n' +
'  * "# POST-INIT PLUGIN UNLOCK (2026-06-01 Szabi 15:24 incident workaround):" → keep POST-INIT PLUGIN UNLOCK invariant\n' +
'  * "# MCP startup-batch tuning for the MAIN session (2026-06-26)" → keep invariant\n' +
'  * "# triggering a false-positive respawn loop within minutes (2026-06-01 18:26)" → drop date+time, keep description\n' +
'  * "# ROOT-CAUSE NOTE (kali-linux WSL, claude-code 2.1.152, 2026-05-27):" → drop version+date\n' +
'  * "# 2026-07-26 a branch switch silently deleted pre-modify-backup.sh itself" → drop date+history\n' +
'  * "# (a manual /login is then needed), see the 2026-07-23 outage." → drop date+history\n' +
'  * "# GAP 2b, 2026-07-23 marveen-channels silent outage" → drop date+history\n' +
'- DO NOT change any non-comment code\n' +
'- DO NOT touch web/ or tests/ (other phases handle those)\n\n' +
'Heuristic: a comment is KEEP-worthy only if it explains an INVARIANT (e.g., "auto-recovery exhausts after 2h silence"). Process timestamps and people\'s names are usually REMOVE.\n\n' +
'Verify BEFORE commit:\n' +
'- bash -n <script> for syntax check on every edited .sh file\n' +
'- node --check <script> for .mjs files\n\n' +
'Commit message:\n' +
'  chore(scripts): strip cycle/MD/SHA/card/date references from scripts/\n' +
'  Timeless-comment rule cleanup. Incident dates are process artifacts; only invariant explanations survive.\n' +
'  Files touched: (list each .sh and .mjs file with line delta)\n\n' +
'Constraints:\n' +
'- DO NOT change non-comment code\n' +
'- DO NOT push\n' +
'- DO NOT touch other directories', { label: 'Phase 7 scripts' })

if (!phase7) { log('Phase 7 stopped. Aborting.'); process.exit(1) }

phase('Phase 8 tests cleanup')

const phase8 = await agent('Cleanup Phase 8 — strip temporal comments from tests/ files (Playwright e2e). EDIT + COMMIT.\n\n' +
'Base dir: /Users/eggp/marveen-develop/test-baseline/tests/\n\n' +
'For each tests/ file that has temporal comments (from Phase 5):\n' +
'- Read the file\n' +
'- Apply the recommended change (REMOVE/SIMPLIFY/REWRITE)\n' +
'- DO NOT change any test code, assertions, selectors\n' +
'- DO NOT touch web/ or scripts/ or src/ (other phases handle those)\n\n' +
'Verify BEFORE commit:\n' +
'- tests/ uses Playwright. Verify file syntax via: bun --bun playwright test --list (dry run if possible)\n' +
'- If Playwright is not installed or list mode fails, skip and just check file reads cleanly.\n\n' +
'Commit message:\n' +
'  chore(tests): strip cycle/MD/SHA/card/date references from tests/\n' +
'  Files touched: (list)\n\n' +
'Constraints:\n' +
'- DO NOT change test code\n' +
'- DO NOT push', { label: 'Phase 8 tests' })

if (!phase8) { log('Phase 8 stopped. Aborting.'); process.exit(1) }

phase('Phase 9 final verify')

const phase9 = await agent('Cleanup Phase 9 — final verification across ALL cleaned dirs. READ-ONLY.\n\n' +
'Tasks:\n' +
'1. git status → clean\n' +
'2. git log --oneline 2ca6901..HEAD → 12 commits expected (cycle 35: 6 + /code-review: 1 + Phase 2/3: 2 + Phase 6/7/8: 3)\n' +
'3. git diff origin/test/baseline --stat → list all changed files\n' +
'4. bunx tsc --noEmit 2>&1 | wc -l → expect 2253 (no delta)\n' +
'5. bun --bun vitest run 2>&1 | tail -5 → all green, no regressions\n' +
'6. grep -rn "cycle [0-9]" src/ web/ scripts/ tests/ templates/ seed-config/ seed-scheduled-tasks/ seed-skills/ → expect ZERO matches\n' +
'7. grep -rn "docs/needs-to-be-fix" src/ web/ scripts/ tests/ → expect ZERO matches in src/; minimal elsewhere (only intentional preserved)\n' +
'8. grep -rn "card [a-f0-9]\\{4,\\}" src/ web/ scripts/ tests/ → expect ZERO matches\n' +
'9. grep -rnE "\\(2026-0[1-9]\\)|\\(2026-1[0-2]\\)" web/ scripts/ tests/ → expect ZERO or only legitimate invariant-context matches\n\n' +
'Output structured report with EXACT numbers for all 9 tasks. Flag unexpected with WARN.\n\n' +
'Constraints: READ-ONLY. No edits, no commits, no push. Do NOT run /code-review.', { label: 'Phase 9 verify' })

if (!phase9) { log('Phase 9 stopped. Aborting.'); process.exit(1) }

log('Broader cleanup complete. Awaiting user push and /code-review xhigh --fix.')
return { phase5, phase6, phase7, phase8, phase9 }
