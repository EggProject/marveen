// Workflow: apply-keychain-and-index-split
//
// Implements the plan at /Users/eggp/marveen-develop/test-baseline/.claude/plans/melodic-wobbling-whistle.md
// Each phase implementer reads the plan file for full details and executes one commit.
// Worktree-isolated per CLAUDE.md temp-worktree rule; merged --ff-only back to test/baseline.
// NO push. Commits stay local.

export const meta = {
  name: 'apply-keychain-and-index-split',
  description: 'Apply keychain Option A + INDEX split + drift reconciliation',
  phases: [
    { title: 'Phase 1: Drift + INDEX split' },
    { title: 'Phase 2: Keychain fix + tests' },
    { title: 'Phase 3: MD updates' },
    { title: 'Phase 4: Double verification' },
    { title: 'Phase 5: /code-review handoff' },
  ],
}

const PLAN_PATH = '/Users/eggp/marveen-develop/test-baseline/.claude/plans/melodic-wobbling-whistle.md'
const REPO = '/Users/eggp/marveen-develop/test-baseline'

// ===== Phase 1: Drift + INDEX split (docs-only) =====

const phase1 = await agent(
`Read the full plan at ${PLAN_PATH}, then execute Phase 1 ONLY (do not touch source files).

Phase 1 scope:
1. Create worktree at /tmp/claw-test-phase1 from test/baseline: \`git worktree add --detach /tmp/claw-test-phase1 test/baseline\`
2. \`ln -sf ${REPO}/node_modules /tmp/claw-test-phase1/node_modules\` (per CLAUDE.md rule)
3. Apply the docs split per the plan:
   - DELETE ${REPO}/docs/needs-to-be-fix/INDEX.md
   - CREATE ${REPO}/docs/needs-to-be-fix/README.md (preamble + corrected counts 55/123/178 + filter recipe + section links)
   - CREATE high.md (11 rows from INDEX.md:21-31), medium.md (19 rows from INDEX.md:37-55), low.md (25 rows from INDEX.md:61-85), baseline-unreachable.md (99 rows from INDEX.md:96-194), orphan.md (24 rows from INDEX.md:206-229)
   - FIX ${REPO}/docs/needs-to-be-fix/syntax-check-executes-web-bundle.md line 5: change "Status: open, fix proposed but not applied" to "Status: resolved (commit 45bb024, 2026-08-17)"
   - REWRITE all INDEX.md cross-references in 10+ MD files per the plan's TARGET-5 list, using low.md where the bug ID's severity is low, otherwise README.md
4. Verify: row counts (11+19+25+99+24=178), filter recipe works, zero INDEX.md references remain outside the new README
5. Single conventional commit: \`docs(needs-to-be-fix): split INDEX.md into 5 severity files + README, fix syntax-check-executes-web-bundle drift, rewrite 10+ cross-references\`
6. Report the commit SHA back

Then merge back: \`git merge --ff-only <phase-1-sha>\` from /tmp/claw-test-phase1, \`git worktree remove /tmp/claw-test-phase1 --force\`.

If any row count fails, STOP and report the exact mismatch. Do not guess. If any cross-reference rewrite is ambiguous (e.g. INDEX.md reference could be README.md OR a specific severity file), default to README.md.

NEVER push. Commits stay local.`,
{ label: 'phase-1', phase: 'Phase 1: Drift + INDEX split' }
)

// ===== Phase 2: Keychain fix + tests (code change) =====

const phase2 = await agent(
`Read the full plan at ${PLAN_PATH}, then execute Phase 2 ONLY.

Phase 2 scope:
1. Create worktree at /tmp/claw-test-phase2 from test/baseline (which now contains Phase 1's commit): \`git worktree add --detach /tmp/claw-test-phase2 test/baseline\`
2. \`ln -sf ${REPO}/node_modules /tmp/claw-test-phase2/node_modules\`
3. Apply the source/test changes atomically (same commit):
   - ${REPO}/src/web/keychain.ts:25-34 — wrap execFileSync in try/catch, throw KeychainUnavailableError preserving err.status. Suggested message format: \`keychain add-generic-password failed (status ${err.status ?? 'unknown'}): ${err.stderr?.toString().trim() ?? 'see launchd logs'} — please unlock the login keychain and retry\`
   - ${REPO}/src/web/vault.ts:73-81 (mint branch only) — propagate KeychainUnavailableError; no atomicWriteFileSync fallback. Migration branch (lines 30-42) UNCHANGED.
   - ${REPO}/src/__tests__/keychain.test.ts:171-174 — update .toThrow('boom') to .toThrow(KeychainUnavailableError)
   - ${REPO}/src/__tests__/keychain.test.ts:176-182 — update .toThrow(/ENOENT/) to .toThrow(KeychainUnavailableError) with message regex including ENOENT
   - ${REPO}/src/__tests__/keychain.test.ts:302-324 — update pinning test comment block to reflect cascade-prevention (the -A pin stays; only the rationale changes)
   - ${REPO}/src/__tests__/vault.test.ts:131-134 — update mock to throw KeychainUnavailableError instead of plain Error
   - ${REPO}/src/__tests__/vault.test.ts:306-320 (test 5) — INVERT: rename and assert .toThrow(KeychainUnavailableError) and existsSync(VAULT_KEY_PATH) is FALSE
   - ADD a new test after line 320 in vault.test.ts: "keychainStore throws KeychainUnavailableError on first mint (vault empty + retrieve null + store throws) → error propagates, no file written" — even though test 5 covers this, an explicit test makes the invariant clear
4. Run targeted tests in worktree: \`bun --bun vitest run src/__tests__/keychain.test.ts src/__tests__/vault.test.ts\`
5. If green, single commit: \`fix(keychain+vault): surface keychainStore prompt as user-facing KeychainUnavailableError instead of silent file-fallback cascade (Option A)\`
6. Report the commit SHA back

Then merge back: \`git merge --ff-only <phase-2-sha>\` from /tmp/claw-test-phase2, \`git worktree remove /tmp/claw-test-phase2 --force\`.

If any test fails, STOP and report the exact failure. Do not guess. Do not skip tests. Do not relax assertions.

NEVER push. Commits stay local.`,
{ label: 'phase-2', phase: 'Phase 2: Keychain fix + tests' }
)

// ===== Phase 3: MD updates =====

const phase3 = await agent(
`Read the full plan at ${PLAN_PATH}, then execute Phase 3 ONLY.

Phase 3 scope:
1. Create worktree at /tmp/claw-test-phase3 from test/baseline (which now contains Phases 1+2): \`git worktree add --detach /tmp/claw-test-phase3 test/baseline\`
2. \`ln -sf ${REPO}/node_modules /tmp/claw-test-phase3/node_modules\`
3. Apply MD updates:
   - In ${REPO}/docs/needs-to-be-fix/keychain-store-insecure-acl.md, ADD a new section "Resolution (Option A cascade prevention, this commit)" between current "Path to a real fix" and "Pinning test" sections. The section content describes that the file-fallback cascade is now prevented; "-A removal" remains deferred pending operator-side validation.
   - Update the keychain-store-insecure-acl row in ${REPO}/docs/needs-to-be-fix/low.md: change the Resolved cell to "Partial — Option A cascade prevention (this commit); -A removal still deferred" — NOT a flat "Resolved: <date> <sha>"
   - In the same MD, fix the cross-references at lines 106, 149: replace "INDEX row was re-marked as Deferred" with "low.md row was re-marked as Deferred" (since INDEX.md no longer exists post-split)
4. Per CLAUDE.md SHA-placeholder rule, all SHA references in commit messages and MD updates use \`(this commit)\` placeholder, NOT inline SHAs. A follow-up commit will replace the placeholder with the actual SHA.
6. Single conventional commit: \`docs(needs-to-be-fix): add Resolution section to keychain-store-insecure-acl.md + update low.md row\`
7. Report the commit SHA back

Then merge back: \`git merge --ff-only <phase-3-sha>\` from /tmp/claw-test-phase3, \`git worktree remove /tmp/claw-test-phase3 --force\`.

NEVER push. Commits stay local.`,
{ label: 'phase-3', phase: 'Phase 3: MD updates' }
)

// ===== Phase 4: Double verification =====

const [verifyA, verifyB] = await parallel([
  () => agent(
`Read the plan at ${PLAN_PATH} and verify the implementation against the plan.

You are Verifier A: CHECKLIST verifier. Your job is to confirm each of the 19 specific changes in the plan landed correctly. Use a clean worktree at /tmp/claw-verify-a from test/baseline: \`git worktree add --detach /tmp/claw-verify-a test/baseline\`. Read every cited file:line and confirm it matches the plan's claim.

For each of the 19 changes listed in the plan (sections "Source" and "Docs"):
1. Read the actual file at the cited line range
2. Confirm the change matches the plan exactly
3. Output one row per check: \`[PASS|FAIL] <change-id>: <one-line verdict>. file:line: <evidence>. <risk if FAIL>\`

If FAIL, explain what is wrong and cite the exact file:line that violates the plan. Do not speculate.

After all checks, list "RISKS / UNCERTAINTIES" — anything you couldn't verify.

Run \`git status\` on the worktree first to confirm clean state. Do NOT commit anything. Just report back.`,
{ label: 'verify-checklist', phase: 'Phase 4: Double verification' }
  ),
  () => agent(
`Read the plan at ${PLAN_PATH} and try to BREAK the implementation. You are Verifier B: ADVERSARIAL falsifier. Your job is to find failure modes, missed tests, and hidden couplings.

You will use a clean worktree at /tmp/claw-verify-b from test/baseline: \`git worktree add --detach /tmp/claw-verify-b test/baseline\`. \`ln -sf ${REPO}/node_modules /tmp/claw-verify-b/node_modules\`.

Specifically try to falsify these claims:

A1. "keychainStore throws KeychainUnavailableError on prompt failure AND on ENOENT AND on generic execFileSync failure." Run the keychain test suite in worktree. Does the new error class cover all paths? Read keychain.ts:25-34 and keychain.test.ts.

A2. "vault.getMasterKey mint branch (lines 73-81) does NOT write VAULT_KEY_PATH when keychainStore throws." Read vault.ts and run vault.test.ts. Does the catch arm now propagate instead of file-writing?

A3. "vault.getMasterKey migration branch (lines 30-42) still works end-to-end when keychainStore throws (file is source of truth, warn log surfaces the prompt)." Read the branch and run the migration test at vault.test.ts:257-271.

A4. "The new test in vault.test.ts covers the 'keychainStore throws on first mint' invariant." Find and read the new test.

A5. "All INDEX.md cross-references in 10+ MD files are rewritten to README.md or low.md." Run \`grep -rn 'INDEX.md' ${REPO}/docs/\` and confirm zero hits outside the README.

A6. "README.md filter recipe is correct." Read README.md. Verify the \`find ... ! -name 'INDEX.md' ! -name 'README.md' | wc -l\` returns 178.

A7. "low.md row wording for keychain-store-insecure-acl is self-consistent with the keychain.test.ts:323 assertion." Verify the row does NOT say flat "Resolved" — it should say "Partial — cascade prevention (this commit)".

A8. "keychain-store-insecure-acl.md Resolution section uses (this commit) placeholder, not inline SHA."

A9. "syntax-check-executes-web-bundle.md line 5 now says resolved."

A10. "Coverage gate still 100%." Run \`bun --bun vitest run src/__tests__/keychain.test.ts src/__tests__/vault.test.ts --coverage\` (per CLAUDE.md .gitignore check first; if coverage/ is gitignored, skip this and just run the test).

A11. "Per-row counts match 11+19+25+99+24=178." Run \`grep -cE '^\| \`' ${REPO}/docs/needs-to-be-fix/{high,medium,low,baseline-unreachable,orphan}.md\`.

A12. "Migration branch (vault.ts:30-42) does NOT propagate KeychainUnavailableError." Read lines 30-42. Should still silently swallow + warn + return file key.

For each target:
- If you CAN falsify: output \`FALSIFIED <target-id>: <verdict>. file:line: <evidence>. <consequence>\`
- If you CANNOT falsify: output \`SURVIVED <target-id>: <verdict>. file:line: <evidence>.\`

After all 12 checks, output "ADDITIONAL RISKS" — anything else you found.

Do NOT commit anything. Just report back.`,
{ label: 'verify-adversarial', phase: 'Phase 4: Double verification' }
  ),
])

// ===== Phase 5: /code-review handoff =====

log('All implementation phases complete on test/baseline. NO push performed.')
log('Phase 5: User must invoke /code-review max --fix manually in the terminal.')
log('Reason: per CLAUDE.md, /code-review skill has disable-model-invocation flag and cannot be called via Skill tool.')
log('The user types `/code-review max --fix` in the Claude Code terminal to trigger the final review pass.')

return { phase1, phase2, phase3, verifyA, verifyB }