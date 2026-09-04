# Plan: message-router triple (3 MD → 1 source edit)

## Context

Three needs-fix MDs (`message-router-cache-fallback-unreachable.md`, `message-router-dead-defensive-branches.md`, `message-router-unreachable-defensive-branches.md`) all converge on the same structural dead-code site at `src/web/message-router.ts:481-483`. The three `?? agentSessionName/readAgentRemoteHost/sessionExistsOnHost` fallback arms are provably structurally unreachable through the public SUT because the pre-pass at lines 392-402 populates `agentSessionCache` for every receiver in `receiversInTick`, which is built from the same `pending` slice the routing loop iterates over. These three arms cap `src/web/message-router.ts` branch coverage at 97.82% (3 uncovered RHS arms), blocking the 100% per-file threshold.

Closing these three MDs in one source edit closes 5 of the 15 currently non-Resolved MDs in one atomic, provably-safe change. Branch coverage moves from 97.82% to 100% with zero new uncovered statements or lines. The non-null assertion (`cached!`) introduces no new branches (TS type assertion, not istanbul-tracked).

## Files to modify

### Commit 1 (atomic source + test)

- `/Users/eggp/marveen-develop/test-baseline/src/web/message-router.ts` lines 477-483
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/message-router-full.test.ts` line 1219 (insert after existing `does NOT send when the cached sessionExists is false` test)

### Commit 2 (docs status flips)

- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` (status: UNRESOLVED → Resolved)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-dead-defensive-branches.md` (status: Partial → Resolved)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md` (status: UNRESOLVED + PARTIAL line 5 contradiction → single Resolved line; resolve the internal contradiction)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` rows 131-133

## Source diff (Commit 1)

**Before** (`src/web/message-router.ts:477-483`):

```ts
      // Use cached session data from the pre-pass (one sessionExistsOnHost call
      // per unique receiver per tick). Fall back to a direct call for agents not
      // in the pending set (shouldn't happen, but safe).
      const cached = agentSessionCache.get(msg.to_agent)
      const session = cached?.session ?? agentSessionName(msg.to_agent)
      const host = isMainAgent ? null : cached?.host ?? readAgentRemoteHost(msg.to_agent)
      const sessionExists = cached?.exists ?? sessionExistsOnHost(host, session)
```

**After:**

```ts
      // Read session data from the pre-pass cache. The pre-pass populates
      // agentSessionCache for every receiver in receiversInTick, which is built
      // from the same `pending` slice the loop iterates over, so the cache
      // lookup always wins.
      const cached = agentSessionCache.get(msg.to_agent)!
      const session = cached.session
      const host = isMainAgent ? null : cached.host
      const sessionExists = cached.exists
```

7 lines before, 7 lines after. Net change: 3 RHS function calls removed, 1 `!` added, comment block reworded.

### Test prose cleanup (same commit)

`src/__tests__/message-router-full.test.ts:1192-1200` cites the OLD `?? sessionExistsOnHost(host, session)` shape. Rewrite to describe the cache-wins invariant without referencing the removed fallback. Line 1210 comment (`// The cache wins, so the second mock call never triggers the fallback.`) reword similarly. No behavioral change to the test assertions.

## New pinning test (insert at `src/__tests__/message-router-full.test.ts:1219`)

```ts
  // ----- post-fix pin: routing loop reads ONLY from agentSessionCache, never falls back -----
  it('reads session/host/exists only from agentSessionCache (no direct call to fallback helpers in the loop body)', async () => {
    // Pinning test for the source edit at message-router.ts:481-483 (drop the ?? arms).
    // The pre-pass (lines 392-402) populates agentSessionCache for every receiver in
    // receiversInTick; the routing loop body must therefore never re-call agentSessionName,
    // readAgentRemoteHost, or sessionExistsOnHost for a cached receiver. After dropping
    // the `?? Y` arms, the only call to sessionExistsOnHost in the entire tick is the
    // one in the pre-pass. We assert call counts to pin the cache-only path.
    vi.useFakeTimers()
    vi.setSystemTime(NOW_MS)
    const freshMs = Math.floor(NOW_MS / 1000)
    H.sessionExistsOnHost.mockReturnValue(true)
    H.getPendingMessages.mockReturnValue([
      makeLocalMsg({ id: 800, to_agent: 'a', created_at: freshMs }),
      makeLocalMsg({ id: 801, to_agent: 'b', created_at: freshMs }),
    ])
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.classifyAgentMessage.mockReturnValue({ category: 'trusted-peer', safeFrom: 'orin' })
    await runMessageRouterTick()
    // Pre-pass: one sessionExistsOnHost call per UNIQUE non-main receiver (2 here).
    // Loop body: zero additional calls (cache-wins path).
    expect(H.sessionExistsOnHost).toHaveBeenCalledTimes(2)
    // The fallback helpers must never be invoked by the routing loop body.
    expect(H.agentSessionName).not.toHaveBeenCalled()
    expect(H.readAgentRemoteHost).not.toHaveBeenCalled()
    vi.useRealTimers()
  })
```

22 lines added.

## Coverage impact

`vitest.config.ts:42-47` enforces `lines: 100, functions: 100, branches: 100, statements: 100, perFile: true` (provider: istanbul). The three `??` RHS arms each contribute one uncovered branch. After dropping them, the `cached!` non-null assertion introduces zero new branches. Expected post-fix: `src/web/message-router.ts` branches = 100% (was 97.82%).

## Risk analysis

Verified (during Phase 2 plan):

- **R1 — other tests using fallback path**: `grep "agentSessionName\|readAgentRemoteHost\|sessionExistsOnHost" src/__tests__/message-router-full.test.ts` shows assertions at lines 525, 548-550, 568, etc. pin the pre-pass call count, not the loop-body fallback. No test relies on the fallback arms.
- **R2 — callers passing undefined cache**: `agentSessionCache` is a local const at line 394; no external callers. Risk: none.
- **R3 — TS type widening**: `Map.get` returns `T | undefined` under `strict: true`. The non-null assertion `cached!` is the minimum-impact type bridge — no runtime branch, no new uncovered statement.
- **R4 — silent-drop regression**: the reverted `eb9f951` attempt introduced `if (!cached) warn; continue` which converted 3 uncovered branches into uncovered STATEMENTS/LINES plus a silent-drop bug. The current proposal does NOT use the `if (!cached)` shape — just the `!` assertion. The regression risk that doomed `eb9f951` is structurally avoided.
- **R5 — stale comment block at lines 477-479**: must reword (captured in diff above).

## Execution protocol (Honcho workflow)

### Step 1: Worktree setup (CLAUDE.md rule 8 — vitest isolation)

```bash
cd /Users/eggp/marveen-develop/test-baseline
git worktree add --detach /Users/eggp/marveen-develop/test-baseline-cc-mrfix bb879a8
ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /Users/eggp/marveen-develop/test-baseline-cc-mrfix/node_modules
cd /Users/eggp/marveen-develop/test-baseline-cc-mrfix
```

### Step 2: Apply edits in worktree

1. Edit `src/web/message-router.ts:477-483` per diff above
2. Edit `src/__tests__/message-router-full.test.ts:1192-1210` prose (reword stale citations)
3. Insert new `it()` block at `src/__tests__/message-router-full.test.ts:1219`

### Step 3: 2-subagent verification (parallel, worktree-isolated)

Spawn 2 `Agent` tool calls with `isolation: worktree`, each running the verification suite independently. Per Honcho rule (Workflow tool script parser finicky), use Agent tool not Workflow tool for parallel verification.

Each verification subagent runs:

```bash
cd /Users/eggp/marveen-develop/test-baseline-cc-mrfix

# 1. Targeted test (fast feedback)
bun --bun vitest run src/__tests__/message-router-full.test.ts

# 2. TypeScript strict check on modified files
bun --bun tsc --noEmit -p tsconfig.json

# 3. Coverage gate
bun --bun vitest run --coverage

# 4. Full regression
bun --bun vitest run
```

Subagent prompts explicitly ask each to:
- Independently verify the cache-wins invariant holds (no behavior change)
- Independently verify branch coverage moves to 100%
- Independently verify the new pinning test fails on a hypothetical revert of the source edit (sanity check)
- Report any uncovered branch, line, or statement in `src/web/message-router.ts` post-edit
- Report any TS error, vitest failure, or test regression

If both subagents report green: proceed to Step 4.
If either subagent reports a failure: stop, surface the divergence, do not commit.

### Step 4: Commit in worktree (detached HEAD)

```bash
cd /Users/eggp/marveen-develop/test-baseline-cc-mrfix

# Commit 1: source + test (atomic)
git add src/web/message-router.ts src/__tests__/message-router-full.test.ts
git commit -m "message-router: drop unreachable ?? fallback arms at lines 481-483

The agentSessionCache Map is populated in the pre-pass (lines 392-402) for
every receiver in receiversInTick, which is built from the same 'pending'
slice the routing loop iterates over. The '?? agentSessionName(...)' /
'?? readAgentRemoteHost(...)' / '?? sessionExistsOnHost(...)' fallback arms
on lines 481-483 are therefore structurally unreachable through the public
SUT, and they cap branch coverage at 97.82% (3 uncovered RHS arms).

Drop the three '??' arms and add a non-null assertion on the Map.get
result (the '!' is a type assertion, not a branch). Reword the source
comment to describe the cache-wins invariant without referencing the
removed fallback. Reword the existing pinning test preamble at lines
1192-1210 to drop the stale '?? sessionExistsOnHost(host, session)'
citation.

Add a new pinning test that asserts the loop body never calls the fallback
helpers directly: pre-pass call count = N unique receivers, loop-body
call count = 0.

Closes docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md
Closes docs/needs-to-be-fix/message-router-dead-defensive-branches.md
Closes docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md"

COMMIT1=$(git rev-parse HEAD)

# Commit 2: docs status flips (3 MDs + INDEX.md)
git add docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md \
        docs/needs-to-be-fix/message-router-dead-defensive-branches.md \
        docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md \
        docs/needs-to-be-fix/INDEX.md
git commit -m "docs: flip message-router triple status to Resolved ${COMMIT1:0:7}

Update INDEX.md rows 131-133 to Resolved.
Update message-router-cache-fallback-unreachable.md UNRESOLVED line 3 + PARTIAL line 5 contradiction to single Resolved line.
Update message-router-dead-defensive-branches.md Partial status to Resolved.
Update message-router-unreachable-defensive-branches.md UNRESOLVED + PARTIAL line 5 to single Resolved line."
```

### Step 5: Sync to `test/baseline` via fast-forward (Honcho rule: NOT `git reset --hard`)

```bash
cd /Users/eggp/marveen-develop/test-baseline
git worktree remove /Users/eggp/marveen-develop/test-baseline-cc-mrfix --force
git merge --ff-only <COMMIT2-sha>
```

Verify working tree clean post-merge: `git status` shows nothing to commit.

### Step 6: `/code-review max --fix` (USER invokes — CLAUDE.md rule 8)

This skill has `disable-model-invocation` and CANNOT be invoked via Skill tool. The user must run it manually in the terminal. Document this requirement in the final user-facing report so they remember.

## Verification checklist (end-to-end)

After Step 5 sync, all checks must pass on `test/baseline`:

- [ ] `bun --bun vitest run src/__tests__/message-router-full.test.ts` — all pass (existing + 1 new)
- [ ] `bun --bun tsc --noEmit -p tsconfig.json` — clean exit 0
- [ ] `bun --bun vitest run --coverage` — `src/web/message-router.ts` branches = 100%
- [ ] `bun --bun vitest run` — full suite green, no regressions
- [ ] `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l` — still 178 (no MD deleted in this batch)
- [ ] INDEX.md row count == MD count (drift stays 0)
- [ ] No em-dashes (U+2014) in any new prose: `grep -rnP '\x{2014}' src/web/message-router.ts src/__tests__/message-router-full.test.ts docs/needs-to-be-fix/{cache-fallback,dead-branches,unreachable-branches}.md` returns no matches
- [ ] 3 MD status flipped from UNRESOLVED/PARTIAL to Resolved
- [ ] INDEX.md rows 131-133 reflect the new Resolved state

## Pre-existing items NOT in scope

- `web-inbound-probe-respawn-grace.md` (medium risk, deferred per cycle 44)
- `channel-coordinator-internals-untestable.md`, `web-agent-scaffold-defensive-coverage.md`, `routes-agents-br-baseline-partial-coverage.md`, `web-agent-worker-runviaworker-coverage.md` (medium risk, deferred)
- `keychain-store-insecure-acl.md` (1-line source fix, pre-condition met, separate batch candidate)
- `syntax-check-executes-web-bundle.md` and `ci-eslint-typecheck-baseline.md` (pure-docs reconciliation candidates, separate batch)
- 2 Reopen notes (`heartbeat-brief-rundiceaysweep-not-applicable.md`, `schedule-mcp-precheck-subtree-cycle-defensive.md`) — pending user verdict on (a)/(b)/(c) options
- 13 "pinned, not fixed" MDs — drift is intentional per Hungarian `Status:` convention, no action

## User actions required (after this plan is approved)

1. Run `/code-review max --fix` in the terminal after Step 5 sync completes (cannot be automated — Skill has `disable-model-invocation` flag)
2. After code-review applies fixes, confirm `git commit` lands (Honcho rule: review-accepted fixes commit immediately, no confirmation needed)
3. Optionally pick a candidate for the FOLLOWING cycle (pure-docs batch, keychain, or wait for user verdict on Reopen notes)

## Critical files summary

- `/Users/eggp/marveen-develop/test-baseline/src/web/message-router.ts` (1 file, lines 477-483)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/message-router-full.test.ts` (1 file, lines 1192-1210 prose + 1219 new test)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` (status flip)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-dead-defensive-branches.md` (status flip)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md` (status flip + resolve internal contradiction)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (rows 131-133)
