// D.1 ChannelEnv class extraction — full migration workflow.
// Per /Users/eggp/marveen-develop/test-baseline/.claude/plans/buzzing-tumbling-hartmanis.md

export const meta = {
  name: 'd1-channel-env-full-migration',
  description: 'D.1 ChannelEnv class extraction with full migration of 42 call sites + 7 mock factories',
  phases: [
    { title: 'Setup' },
    { title: 'Implement' },
    { title: 'Verify (parallel)' },
    { title: 'Merge' },
    { title: 'Cleanup' },
    { title: 'Docs commit' },
    { title: 'Final gate' },
  ],
}

// ── Schemas ────────────────────────────────────────────────────────────────

const VERIFIER_SCHEMA = {
  type: 'object',
  properties: {
    items: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          claim: { type: 'string' },
          verdict: { type: 'string', enum: ['PASS', 'FAIL'] },
          evidence: { type: 'string' },
        },
        required: ['claim', 'verdict', 'evidence'],
      },
    },
    overall: { type: 'string', enum: ['PASS', 'FAIL'] },
    blockers: { type: 'array', items: { type: 'string' } },
  },
  required: ['items', 'overall', 'blockers'],
}

const SETUP_SCHEMA = {
  type: 'object',
  properties: {
    worktreePath: { type: 'string' },
    authorVerified: { type: 'boolean' },
    author: { type: 'string' },
    callSiteCount: { type: 'number' },
    filesTouchedCount: { type: 'number' },
    workingTreeClean: { type: 'boolean' },
    nodeModulesSymlinked: { type: 'boolean' },
  },
  required: [
    'worktreePath', 'authorVerified', 'author', 'callSiteCount',
    'filesTouchedCount', 'workingTreeClean', 'nodeModulesSymlinked',
  ],
}

const IMPLEMENT_SCHEMA = {
  type: 'object',
  properties: {
    diffSummary: { type: 'string' },
    filesModified: { type: 'array', items: { type: 'string' } },
    newFiles: { type: 'array', items: { type: 'string' } },
    deletedFunctions: { type: 'array', items: { type: 'string' } },
    callSitesMigrated: { type: 'number' },
    mockFactoriesUpdated: { type: 'number' },
    tscErrors: { type: 'number' },
    vitestPassCount: { type: 'number' },
    vitestFailCount: { type: 'number' },
    lintCount: { type: 'number' },
    commitSha: { type: 'string' },
    authorVerified: { type: 'boolean' },
  },
  required: [
    'diffSummary', 'filesModified', 'newFiles', 'deletedFunctions',
    'callSitesMigrated', 'mockFactoriesUpdated', 't', 'tscErrors',
    'vitestPassCount', 'vitestFailCount', 'lintCount',
    'commitSha', 'authorVerified',
  ],
}

const MERGE_SCHEMA = {
  type: 'object',
  properties: {
    mergeSuccessful: { type: 'boolean' },
    mergeType: { type: 'string' },
    newHeadSha: { type: 'string' },
    authorVerified: { type: 'boolean' },
    worktreeRemoved: { type: 'boolean' },
  },
  required: [
    'mergeSuccessful', 'mergeType', 'newHeadSha',
    'authorVerified', 'worktreeRemoved',
  ],
}

const DOCS_SCHEMA = {
  type: 'object',
  properties: {
    filesUpdated: { type: 'array', items: { type: 'string' } },
    statusFlipsConfirmed: { type: 'boolean' },
    noInlineShaUsed: { type: 'boolean' },
    commitSha: { type: 'string' },
    authorVerified: { type: 'boolean' },
  },
  required: [
    'filesUpdated', 'statusFlipsConfirmed', 'noInlineShaUsed',
    'commitSha', 'authorVerified',
  ],
}

const FINAL_GATE_SCHEMA = {
  type: 'object',
  properties: {
    tscErrors: { type: 'number' },
    vitestPassCount: { type: 'number' },
    vitestFailCount: { type: 'number' },
    vitestTotalFiles: { type: 'number' },
    lintCount: { type: 'number' },
    headSha: { type: 'string' },
    authorVerified: { type: 'boolean' },
  },
  required: [
    'tscErrors', 'vitestPassCount', 'vitestFailCount',
    'vitestTotalFiles', 'lintCount', 'headSha', 'authorVerified',
  ],
}

// ── Phase 1: Setup ─────────────────────────────────────────────────────────

phase('Setup')

const setup = await agent(
  `You are the SETUP agent for D.1 ChannelEnv class extraction in /Users/eggp/marveen-develop/test-baseline.

Execute IN ORDER. Each step → verify sub-step. STOP and report FAIL on any mismatch.

1. Create detached worktree at $HOME/claw-d1-test (NOT /tmp/ — see CLAUDE.md §8 _TMP_PREFIXES guard):
   git -C /Users/eggp/marveen-develop/test-baseline worktree add --detach $HOME/claw-d1-test refactor/classbase
   Verify: git -C /Users/eggp/marveen-develop/test-baseline worktree list shows claw-d1-test entry.

2. Symlink node_modules:
   ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-d1-test/node_modules
   Verify: ls -la $HOME/claw-d1-test/node_modules shows symlink to main repo's node_modules.

3. Author pre-flight (MANDATORY per CLAUDE.md §8):
   AUTHOR=$(git -C $HOME/claw-d1-test log -1 --format='%an <%ae>')
   EMAIL=$(git -C /Users/eggp/marveen-develop/test-baseline config user.email)
   AUTHOR_EMAIL=$(echo "$AUTHOR" | grep -oE '<[^>]+>' | tr -d '<>')
   AUTHOR_VERIFIED=$(if [ "$AUTHOR_EMAIL" = "$EMAIL" ]; then echo true; else echo false; fi)
   AUTHOR_NAME=$(echo "$AUTHOR" | sed -E 's/ <.*//')
   Expected: AUTHOR=eggprojectteams@gmail.com, EMAIL=eggprojectteams@gmail.com, AUTHOR_VERIFIED=true.
   If AUTHOR_VERIFIED=false: STOP and report.

4. Re-grep call sites (defensive — confirm terv's 42 count is still valid):
   cd $HOME/claw-d1-test && grep -rn 'channelStateDir\\|readChannelToken\\|getChannelToken\\|getChannelChatId' src/ --include='*.ts' | grep -v __tests__
   Count: grep -rn ... | grep -v __tests__ | wc -l
   Files touched: grep -rln ... | grep -v __tests__ | wc -l
   Expected: 42 sites, 12 files. If different: STOP and report.

5. Working tree clean check:
   cd $HOME/claw-d1-test && git status --short
   Expected: empty output. If any modified files: STOP and report (the branch should be clean).

Return structured output. No implementation in this phase — just verification.`,
  { label: 'D.1 setup', phase: 'Setup', schema: SETUP_SCHEMA },
)

if (!setup || !setup.authorVerified) {
  throw new Error('Setup failed — author not verified. Refusing to proceed.')
}
if (!setup.workingTreeClean) {
  throw new Error('Setup failed — working tree not clean. Refusing to proceed.')
}
if (!setup.nodeModulesSymlinked) {
  throw new Error('Setup failed — node_modules not symlinked.')
}

log(`Setup OK. Worktree ${setup.worktreePath}. ${setup.callSiteCount} call sites across ${setup.filesTouchedCount} files.`)

// ── Phase 2: Implement ─────────────────────────────────────────────────────

phase('Implement')

const implementer = await agent(
  `You are the IMPLEMENT agent for D.1 ChannelEnv class extraction in $HOME/claw-d1-test.

Read the plan FIRST: /Users/eggp/marveen-develop/test-baseline/.claude/plans/buzzing-tumbling-hartmanis.md

All work happens INSIDE $HOME/claw-d1-test. Do NOT touch /Users/eggp/marveen-develop/test-baseline directly.

Execute IN ORDER:

A. Re-verify setup (defensive):
   cd $HOME/claw-d1-test && git status --short
   Expected: empty.

B. Read the live source files to confirm exact line ranges:
   - $HOME/claw-d1-test/src/channel-provider.ts — class insertion above line 500; delete getChannelToken (500-506), getChannelChatId (508-514), channelStateDir (572-583), readChannelToken (585-603).
   - $HOME/claw-d1-test/src/config.ts — import line 8; call sites 325-326.
   - 10 other production files (use grep to find the 40 call sites).
   - 7 test mock factories (onboarding-routes.test.ts, channel-monitor-coverage.test.ts, agent-process.test.ts, channel-monitor-baseline.test.ts, agents-routes.test.ts, channel-monitor.test.ts, channel-coordinator-liveness.test.ts).

C. Insert class ChannelEnv in src/channel-provider.ts above current line 500 (4 instance methods + 1 static TABLE, all per the plan's class shape).

D. Delete the 4 free functions from src/channel-provider.ts (lines 500-506, 508-514, 572-583, 585-603). Remove unused imports if any (homedir, join, readFileSync, existsSync are STILL needed by the class — verify before removing).

E. Migrate src/config.ts:325-326 from getChannelToken/getChannelChatId to new ChannelEnv(env).getToken/.getChatId. Update import at :8.

F. Migrate the 31 channelStateDir call sites across 11 files to new ChannelEnv().stateDirFor(...). Update imports.

G. Migrate the 9 readChannelToken call sites across 5 files to new ChannelEnv().readTokenFor(...). Update imports.

H. Migrate the 7 mock factories: each vi.mock('../channel-provider.js', () => ({ ... })) now returns { ChannelEnv: vi.fn().mockImplementation(() => ({ readTokenFor: vi.fn(...), stateDirFor: vi.fn(...), getToken: vi.fn(...), getChatId: vi.fn(...) })), ... }.

I. Create src/__tests__/channel-env.test.ts with the 20 it() blocks per the plan (§Test strategy). Use vi.mock for fs if needed; os.tmpdir() for temp file tests; finally-block cleanup.

J. Run gate suite in $HOME/claw-d1-test:
   - bun tsc --noEmit  (target: 0 errors)
   - bun --bun vitest run  (target: 11248+ pass, 0 fail)
   - bun --bun vitest run src/__tests__/channel-provider-classes.test.ts src/__tests__/channel-provider.test.ts src/__tests__/channel-env.test.ts  (target: 166+ pass)
   - bun run lint  (target: 9783 problems)

K. Commit author verification (MANDATORY before commit):
   git -C $HOME/claw-d1-test config user.email
   Expected: eggprojectteams@gmail.com. If different: STOP and ask user.

L. Commit with message:
   refactor(channel-provider): extract ChannelEnv class + full migration of 42 call sites (D.1)
   - Adds class ChannelEnv with 4 instance methods (getToken, getChatId, stateDirFor, readTokenFor) + 1 static TABLE.
   - Deletes 4 legacy free functions (getChannelToken, getChannelChatId, channelStateDir, readChannelToken).
   - Migrates 42 production call sites across 12 files.
   - Updates 7 mock factories to expose ChannelEnv as vi.fn().
   - Adds src/__tests__/channel-env.test.ts (20 it() blocks + vacuous-test table).

M. Record commit SHA: git -C $HOME/claw-d1-test log -1 --format='%H'. Also record git log -1 --format='%an <%ae>'.

N. Return structured output. The merge step will use the commit SHA from this output.

Strict rules:
- NO git push.
- NO worktree at /tmp/.
- NO @deprecated wrappers (user rejected).
- NO inline SHA in any file (use the variable name in commit message only).
- NO 'as' casts, NO 'any' types, NO string concatenation (CLAUDE.md §7).
- TypeScript strict mode: use satisfies where appropriate.

If tsc, vitest, or lint fails with >5 fails (CLAUDE.md §8): also run on baseline a330462 in a separate worktree at $HOME/claw-test-baseline to distinguish pre-existing regressions. Report any pre-existing fails as such.`,
  { label: 'D.1 implement', phase: 'Implement', schema: IMPLEMENT_SCHEMA },
)

if (!implementer || !implementer.authorVerified) {
  throw new Error('Implementation failed — author not verified on commit.')
}
if (implementer.tscErrors !== 0) {
  throw new Error(`Implementation failed — tsc has ${implementer.tscErrors} errors (target: 0).`)
}
if (implementer.vitestFailCount > 5) {
  throw new Error(`Implementation failed — vitest has ${implementer.vitestFailCount} fails (target: 0). Per CLAUDE.md §8, >5 fails requires baseline a330462 comparison — re-run the verifier on baseline if not already done.`)
}

log(`Implement OK. ${implementer.callSitesMigrated} call sites migrated, ${implementer.mockFactoriesUpdated} mock factories updated. TSC: ${implementer.tscErrors}, vitest: ${implementer.vitestPassCount}/${implementer.vitestPassCount + implementer.vitestFailCount}, lint: ${implementer.lintCount}. Commit: ${implementer.commitSha.slice(0, 7)}.`)

// ── Phase 3: Verify (parallel — barrier) ────────────────────────────────────

phase('Verify (parallel)')

const verifyResults = await parallel([
  () => agent(
    `You are Verifier A — structured PASS/FAIL checklist for D.1 ChannelEnv class extraction. READ-ONLY. NO edits.

All evidence must be quoted file:line + git show output, not paraphrased.

Verify the implementation in $HOME/claw-d1-test against /Users/eggp/marveen-develop/test-baseline/.claude/plans/buzzing-tumbling-hartmanis.md.

Claims to check (one PASS/FAIL line each):

1. class ChannelEnv exists at $HOME/claw-d1-test/src/channel-provider.ts above line 500 (insertion verified).
2. ChannelEnv has 4 INSTANCE methods: getToken, getChatId, stateDirFor, readTokenFor (NOT static).
3. ChannelEnv has static readonly TABLE with 5 entries: telegram, slack, discord, googlechat, teams.
4. TABLE.telegram.chatIdKey === 'ALLOWED_CHAT_ID' (legacy quirk pin).
5. TABLE.googlechat.tokenKey === 'GOOGLECHAT_PROJECT_ID'.
6. The 4 free functions are DELETED: grep -n 'export function \\(getChannelToken\\|getChannelChatId\\|channelStateDir\\|readChannelToken\\)' $HOME/claw-d1-test/src/channel-provider.ts returns 0 matches.
7. No @deprecated JSDoc remains on channel-env helpers (user rejected legacy wrappers).
8. src/config.ts:325-326 migrated to new ChannelEnv(env).getToken/getChatId.
9. All 31 channelStateDir call sites migrated to new ChannelEnv().stateDirFor(...). Verify: grep -rn 'channelStateDir(' $HOME/claw-d1-test/src/ --include='*.ts' | grep -v __tests__ returns 0 matches.
10. All 9 readChannelToken call sites migrated to new ChannelEnv().readTokenFor(...). Verify: grep -rn 'readChannelToken(' $HOME/claw-d1-test/src/ --include='*.ts' | grep -v __tests__ returns 0 matches.
11. All 7 vi.mock factory files updated to expose ChannelEnv as vi.fn(). Files: onboarding-routes.test.ts, channel-monitor-coverage.test.ts, agent-process.test.ts, channel-monitor-baseline.test.ts, agents-routes.test.ts, channel-monitor.test.ts, channel-coordinator-liveness.test.ts.
12. src/__tests__/channel-env.test.ts exists with 20 it() blocks.
13. Each new it() has a concrete expected-value assertion (no typeof-only patterns).
14. stateDirFor uses 'if (agentDir)' truthy check (NOT !== undefined).
15. readTokenFor has all 3 null paths (file missing, throws, no match).
16. bun tsc --noEmit in $HOME/claw-d1-test returns 0 errors.
17. bun --bun vitest run in $HOME/claw-d1-test (full) passes 11248+ tests.
18. bun --bun vitest run channel-provider-classes + channel-provider + channel-env passes 166+ tests.
19. bun run lint in $HOME/claw-d1-test returns 9783 problems.
20. git log -1 --format='%an <%ae>' matches git config user.email (eggprojectteams@gmail.com).
21. Working tree clean in $HOME/claw-d1-test before merge.
22. No 'as' casts, no 'any' types, no string concatenation in new code (CLAUDE.md §7).
23. No git push occurred (CLAUDE.md §6).
24. (this commit) placeholder used in commit message, NOT inline SHA (CLAUDE.md §8).
25. The 7 mock factory files all pass their individual vitest runs: bun --bun vitest run each file.`,
    { label: 'D.1 verify A', phase: 'Verify (parallel)', schema: VERIFIER_SCHEMA },
  ),
  () => agent(
    `You are Verifier B — ADVERSARIAL falsifier for D.1 ChannelEnv class extraction. READ-ONLY. NO edits.

Your job is to BREAK the implementation, not confirm the spec. DO NOT use Verifier A's checklist. Independently attempt:

1. Construct new ChannelEnv({}) empty env, verify each method's edge-case behavior:
   - new ChannelEnv({}).getToken('telegram') === '' (not undefined, not throw)
   - new ChannelEnv({}).getChatId('telegram') === '' (not undefined)
   - new ChannelEnv({}).stateDirFor('telegram', undefined) ends with '/telegram' (full path)
   - new ChannelEnv({}).readTokenFor('telegram', '/nonexistent') === null (not undefined, not throw)

2. Run vitest on baseline a330462 in $HOME/claw-test-baseline worktree (create if needed via git worktree add --detach $HOME/claw-test-baseline a330462). Compare baseline counts to current. Delta must be EXACTLY +20 (new channel-env.test.ts tests).

3. For each new it() in $HOME/claw-d1-test/src/__tests__/channel-env.test.ts, simulate no-op implementation: return undefined (or always-throw). Confirm each test would FAIL.

4. Check production callers don't break:
   grep -rln 'getChannelToken\\|getChannelChatId\\|channelStateDir\\|readChannelToken' $HOME/claw-d1-test/src/ --include='*.ts' | grep -v __tests__
   MUST return 0 matches (full migration).

5. Falsify the dispatch TABLE exhaustiveness:
   Add a 6th ChannelProviderType to the union in src/channel-provider.ts:9 and run bun tsc --noEmit. MUST fail compile.

6. Test type-widening: read src/env.ts:13 to confirm readEnvFile() returns Record<string, string>. If narrower (e.g. Record<string, string | undefined>), the constructor signature requires a cast — FAIL.

7. Falsify mock factory correctness in the 7 updated test files:
   - Read each vi.mock factory in $HOME/claw-d1-test/src/__tests__/
   - Verify the test still passes (bun --bun vitest run <file>)
   - Verify the mocked ChannelEnv instance returns the values the test expects

8. Verify stateDirFor and readTokenFor are INSTANCE methods:
   grep -n 'static.*stateDirFor\\|static.*readTokenFor' $HOME/claw-d1-test/src/channel-provider.ts MUST return 0.

9. Verify no @deprecated JSDoc remains in $HOME/claw-d1-test/src/channel-provider.ts related to channel-env helpers:
   grep -n '@deprecated' $HOME/claw-d1-test/src/channel-provider.ts regarding getChannelToken/getChannelChatId/channelStateDir/readChannelToken MUST return 0.

10. Sanity-check the migration by reading 3 random production call sites (one from config.ts, one from a channelStateDir file, one from a readChannelToken file). Confirm the new code shape is consistent with the migration pattern 'new ChannelEnv(env).getToken(provider)' / 'new ChannelEnv().stateDirFor(provider, agentDir?)' / 'new ChannelEnv().readTokenFor(provider, envFilePath)'.

11. Run all 7 mock factory files individually: cd $HOME/claw-d1-test && bun --bun vitest run src/__tests__/onboarding-routes.test.ts && bun --bun vitest run src/__tests__/channel-monitor-coverage.test.ts && ... (all 7). Each MUST pass.

12. Confirm no consumer outside the listed 12+1 files imports the deleted helpers:
   grep -rln 'getChannelToken\\|getChannelChatId\\|channelStateDir\\|readChannelToken' $HOME/claw-d1-test/src/ --include='*.ts' MUST return 0.`,
    { label: 'D.1 verify B', phase: 'Verify (parallel)', schema: VERIFIER_SCHEMA },
  ),
])

// Barrier: both verifiers must PASS.
const validResults = verifyResults.filter(Boolean)
const allPass = validResults.length === 2 && validResults.every(r => r.overall === 'PASS')
if (!allPass) {
  const failures = validResults.filter(r => r.overall !== 'PASS')
  const blockers = failures.flatMap(r => r.blockers || [])
  throw new Error(`Verification FAILED. ${failures.length}/2 verifiers reported FAIL. Blockers: ${blockers.join('; ')}.`)
}

log(`Verify OK. Both verifiers PASS.`)

// ── Phase 4: Merge ──────────────────────────────────────────────────────────

phase('Merge')

const merger = await agent(
  `You are the MERGE agent for D.1 ChannelEnv class extraction. Work in /Users/eggp/marveen-develop/test-baseline (the MAIN repo, not the worktree).

Strict rules per CLAUDE.md §8:
- Use git merge --ff-only (NOT git reset --hard).
- Verify commit author before merging.
- No 'git push' ever.

Steps:

1. Verify the worktree still exists and the commit is reachable from the worktree's HEAD:
   cd $HOME/claw-d1-test && git log -1 --format='%H %an <%ae>'
   Expected: SHA matches what the implementer reported.

2. Switch to main repo:
   cd /Users/eggp/marveen-develop/test-baseline

3. Verify clean working tree:
   git status --short (empty)

4. Verify the merge target is the branch's HEAD:
   git merge-base --is-ancestor <SHA> refactor/classbase && echo "fast-forward possible" || echo "NOT an ancestor — STOP"
   If NOT an ancestor: STOP. The worktree's HEAD must be a descendant of refactor/classbase.

5. Fast-forward merge:
   git merge --ff-only <SHA>
   Verify: git log -1 --format='%H %s' shows the D.1 commit message.

6. Author verification post-merge:
   git log -1 --format='%an <%ae>'
   EMAIL=$(git config user.email)
   AUTHOR_EMAIL=$(git log -1 --format='%ae')
   if [ "$AUTHOR_EMAIL" != "$EMAIL" ]; then echo "AUTHOR MISMATCH — STOP"; fi
   Expected: EggProjectTeams <eggprojectteams@gmail.com>, matching config user.email.

7. Report new HEAD SHA and author verification status.`,
  { label: 'D.1 merge', phase: 'Merge', schema: MERGE_SCHEMA },
)

if (!merger || !merger.mergeSuccessful) {
  throw new Error('Merge failed.')
}
if (!merger.authorVerified) {
  throw new Error('Merge author verification failed — refusing to proceed.')
}

log(`Merge OK. New HEAD: ${merger.newHeadSha.slice(0, 7)}.`)

// ── Phase 5: Cleanup ───────────────────────────────────────────────────────

phase('Cleanup')

const cleanup = await agent(
  `Cleanup agent for D.1.

Steps:
1. Remove the worktree at $HOME/claw-d1-test:
   git -C /Users/eggp/marveen-develop/test-baseline worktree remove $HOME/claw-d1-test --force
   Verify: git -C /Users/eggp/marveen-develop/test-baseline worktree list does NOT show claw-d1-test.

2. Verify main repo clean:
   cd /Users/eggp/marveen-develop/test-baseline && git status --short
   Expected: empty.

Report: { worktreeRemoved: boolean, mainRepoClean: boolean }.`,
  { label: 'D.1 cleanup', phase: 'Cleanup', schema: MERGE_SCHEMA },
)

if (!cleanup || !cleanup.worktreeRemoved) {
  throw new Error('Cleanup failed — worktree not removed.')
}

log('Cleanup OK.')

// ── Phase 6: Docs commit ────────────────────────────────────────────────────

phase('Docs commit')

const docCommitter = await agent(
  `You are the DOCS COMMIT agent for D.1. Work in /Users/eggp/marveen-develop/test-baseline.

CLAUDE.md §8 rules:
- Use (this commit) placeholder, NOT inline SHA (history rewrite hostage).
- Per-phase line numbers must be re-measured (post-D.2 land shifted them ~52 lines).

Update these 4 files (verify each with grep -n BEFORE editing):

1. docs/refactor-to-classbase/d-channel-provider/00-summary.md
   - D.1 status: LANDED (this commit)
   - Remove "D.5 wrapper removal" reference (merged into D.1)
   - Update line citations to post-D.2 numbers

2. docs/refactor-to-classbase/d-channel-provider/05-refactor-roadmap.md
   - Phase D.1 status: LANDED (this commit)
   - Phase D.5 status: REMOVED (merged into D.1)

3. docs/refactor-to-classbase/d-channel-provider/03-class-boundaries.md
   - §D1 status: LANDED (this commit)
   - Note the 42 call sites migrated
   - Insertion line: above current channel-provider.ts line for class ChannelEnv (re-measure with grep -n 'class ChannelEnv' src/channel-provider.ts)

4. docs/refactor-to-classbase/00-summary.md
   - Top-3 lowest-risk wins list re-checked: D.2 and D.4 are already landed (remove from list); D.1 is now LANDED (add to list or remove from "lowest-risk wins" if appropriate).

Verify NO inline SHA in any document:
  grep -rE '[0-9a-f]{7,40}' docs/refactor-to-classbase/d-channel-provider/ docs/refactor-to-classbase/00-summary.md | grep -v 'review-completeness.md\|review-correctness.md\|f58fe4c'

Commit author verification (MANDATORY):
  git config user.email
  Expected: eggprojectteams@gmail.com.

Commit message:
  docs(d-channel-provider): mark D.1 ChannelEnv class LANDED (this commit)
  - Updates d-channel-provider/00-summary, 05-refactor-roadmap, 03-class-boundaries.
  - Updates 00-summary Top-3 list.
  - Uses (this commit) placeholder, not inline SHA.
  - Updates post-D.2 line citations.

Report: commit SHA, author verification status, files updated list, noInlineShaUsed boolean.`,
  { label: 'D.1 docs commit', phase: 'Docs commit', schema: DOCS_SCHEMA },
)

if (!docCommitter || !docCommitter.authorVerified) {
  throw new Error('Docs commit author verification failed.')
}
if (!docCommitter.statusFlipsConfirmed) {
  throw new Error('Docs commit status flips not confirmed.')
}
if (!docCommitter.noInlineShaUsed) {
  throw new Error('Docs commit used inline SHA — violating CLAUDE.md §8.')
}

log(`Docs commit OK. SHA: ${docCommitter.commitSha.slice(0, 7)}.`)

// ── Phase 7: Final gate ────────────────────────────────────────────────────

phase('Final gate')

const finalGate = await agent(
  `You are the FINAL GATE agent for D.1. Work in /Users/eggp/marveen-develop/test-baseline.

Run the final verification suite:

1. bun tsc --noEmit
   Target: 0 errors (was 0)

2. bun --bun vitest run
   Target: 11248+ passed, 0 fail, 384+ files (was 11228/0/384; +20 from new channel-env.test.ts)

3. bun run lint
   Target: 9783 problems (was 9783; flat)

4. git log -1 --format='%H %an <%ae>'
   EMAIL=$(git config user.email)
   AUTHOR_EMAIL=$(git log -1 --format='%ae')
   AUTHOR_VERIFIED: $AUTHOR_EMAIL = $EMAIL (eggprojectteams@gmail.com)

5. Verify the 3 docs are updated: grep -n 'D.1.*LANDED\\|LANDED.*D.1' docs/refactor-to-classbase/d-channel-provider/*.md

Report: { tscErrors, vitestPassCount, vitestFailCount, vitestTotalFiles, lintCount, headSha, authorVerified }.

If vitest has >5 fails (CLAUDE.md §8): also run on baseline a330462 in a separate worktree to distinguish pre-existing regressions. Report pre-existing fails.`,
  { label: 'D.1 final gate', phase: 'Final gate', schema: FINAL_GATE_SCHEMA },
)

if (!finalGate) {
  throw new Error('Final gate failed.')
}
if (finalGate.tscErrors !== 0) {
  throw new Error(`Final gate tsc has ${finalGate.tscErrors} errors.`)
}
if (finalGate.vitestFailCount > 5) {
  throw new Error(`Final gate vitest has ${finalGate.vitestFailCount} fails — >5 requires baseline a330462 comparison.`)
}
if (!finalGate.authorVerified) {
  throw new Error('Final gate author verification failed.')
}

log(`Final gate OK. TSC: ${finalGate.tscErrors}, vitest: ${finalGate.vitestPassCount}/${finalGate.vitestPassCount + finalGate.vitestFailCount}, lint: ${finalGate.lintCount}. HEAD: ${finalGate.headSha.slice(0, 7)}.`)
log(`D.1 CYCLE COMPLETE. /code-review max --fix is a USER-MANUAL step per CLAUDE.md §8 (skill has disable-model-invocation flag).`)
