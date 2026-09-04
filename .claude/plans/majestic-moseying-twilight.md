# Cycle 46 — Smallest needs-fix closure: `message-router-unreachable-defensive-branches.md` consistency fix

## Context

`test/baseline` HEAD = `e75142d` (the session memory recorded `8088648`, but `e75142d` is now 5 commits ahead — `e75142d`, `274fc1d`, `0469551`, `6474d7a`, then `8088648`).

Goal: smallest + lowest-risk docs-only edit that closes something real. Phase 1 inventory found 178 MDs, 15 truly open. Phase 2 design (2 independent Plan agents) converged:

- 6 of my initially-proposed INDEX row "status flips" are no-ops (rows already say `Documented only` / `Resolved`).
- `REBUILD_PROMPT.md` does not exist — the file is `REBUILD_PROMPT_V3.md` and the `runDecaySweep` lines (605/612/695) are accurate code-specs of `src/index.ts:448-449`, NOT a brief clause to drop. The brief the MD `heartbeat-brief-rundiceaysweep-not-applicable` references is ephemeral (chat/Honcho memory), not in the repo.
- `message-router-dead-defensive-branches.md` body sync is ~25% of the file (title still says "three", excerpts show pre-`ba6faf8` source as if present, coverage 90.84% → 97.82%) and deviates from the established INDEX convention (resolved MDs keep the original bug-time body; footer tracks resolution).
- `message-router-unreachable-defensive-branches.md` has unambiguous internal contradictions that need a fix.

This cycle closes one thing: the internal consistency of the second MD.

## What changes (one commit, one MD file)

### File: `docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md`

| Line | Current | New |
|---|---|---|
| 1 | `# message-router.ts: four unreachable defensive branches block 100% branch coverage` | `# message-router.ts: five unreachable defensive branches block 100% branch coverage` |
| 4 | `` `src/web/message-router.ts`, lines 81, 317, 478-480. `` | `` `src/web/message-router.ts`, lines 81, 317, 481-483. `` |
| 10 | `3. `cached?.session ?? agentSessionName(msg.to_agent)` (line 478)` | `3. `cached?.session ?? agentSessionName(msg.to_agent)` (line 481)` |
| 12 | `4. `cached?.host ?? readAgentRemoteHost(msg.to_agent)` (line 479)` | `4. `cached?.host ?? readAgentRemoteHost(msg.to_agent)` (line 482)` |
| 14 | `5. `cached?.exists ?? sessionExistsOnHost(host, session)` (line 480)` | `5. `cached?.exists ?? sessionExistsOnHost(host, session)` (line 483)` |
| 36 | `// Routing loop -- lines 478-480` | `// Routing loop -- lines 481-483` |
| 38 | `... ?? agentSessionName(msg.to_agent)           // <-- line 478` | `... ?? agentSessionName(msg.to_agent)           // <-- line 481` |
| 39 | `... ?? readAgentRemoteHost(msg.to_agent)  // <-- line 479` | `... ?? readAgentRemoteHost(msg.to_agent)  // <-- line 482` |
| 40 | `... ?? sessionExistsOnHost(host, session)  // <-- line 480` | `... ?? sessionExistsOnHost(host, session)  // <-- line 483` |
| 71 | `**3-5. Lines 478-480 (cache fallbacks):**` | `**3-5. Lines 481-483 (cache fallbacks):**` |
| 91 | `reaches lines 478-480.` | `reaches lines 481-483.` |
| 100 | `N/A -- all four branches are structurally unreachable` | `N/A -- all five branches are structurally unreachable` |
| 104 | `- For lines 478-480: drop the `??` fallbacks` | `- For lines 481-483: drop the `??` fallbacks` |

**Total**: 13 line edits. No source-code change. No test change. No INDEX.md change. Em-dash audit: zero em-dashes introduced (verified via grep).

Source verification (read-only):
- `src/web/message-router.ts:480-483`:
  ```
  480:      const cached = agentSessionCache.get(msg.to_agent)
  481:      const session = cached?.session ?? agentSessionName(msg.to_agent)
  482:      const host = isMainAgent ? null : cached?.host ?? readAgentRemoteHost(msg.to_agent)
  483:      const sessionExists = cached?.exists ?? sessionExistsOnHost(host, session)
  ```
- `src/web/message-router.ts:79-81`: comment block (no `if (msg.to_agent === MAIN_AGENT_ID) return`) — confirms line 81 guard was deleted by `ba6faf8`.
- `src/web/message-router.ts:307-320`: "by construction" comment, no `if (old.length === 0) return` — confirms line 317 guard was deleted by `ba6faf8`.
- `src/web/message-router.ts:180`: `if (stamped) {` still present — kept as stylistic inversion.

The footer at line 115 (`Partially resolved: 2026-08-19 ba6faf8 (lines 81, 317 deleted); UNRESOLVED on lines 481-483`) is already correct; this commit only brings the body in sync with it.

## What is explicitly NOT in this cycle

| Rejected item | Why |
|---|---|
| 6 INDEX.md row status flips | All 6 rows already say `Documented only` / `Resolved` per independent subagent verification (lines 31/73/83/143/145/180 of INDEX.md) |
| 3 em-dash fixes at INDEX.md:143/145/180 | Out-of-scope for message-router scope; defer to dedicated cycle |
| `message-router-dead-defensive-branches.md` body sync | ~25% of file, deviates from convention (resolved MDs preserve bug-time body); footer is already accurate |
| `REBUILD_PROMPT_V3.md` edit | Premise was false — file describes accurate `runDecaySweep` source wiring; the brief the MD references lives in chat only, not the repo |
| Any `src/web/message-router.ts` source edit | Blocked by per-MD `NEVER modify` task rule (line 181); user has not overridden |
| Test-only threshold overrides for message-router coverage gate | Blocked by per-MD `NEVER modify` task rule; user has not overridden |
| Closing the `message-router-*-unreachable` MDs to Resolved | The 3 residual `??` arms at lines 481-483 remain genuinely unreachable without source refactor; the partial resolution footer is honest and should stay |

## Verification (post-edit, pre-commit)

```bash
# 1. Single-file diff sanity
git diff --stat -- docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md
# Expect: 1 file changed, ~13 insertions, ~13 deletions

# 2. Source-code untouched
git diff --stat -- src/
# Expect: empty

# 3. Test files untouched
git diff --stat -- '*.test.ts'
# Expect: empty

# 4. INDEX row count invariant preserved
find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l
# Expect: 178 (no MDs created or deleted)

# 5. Em-dash audit (CLAUDE.md §6)
grep -nP '[\x{2014}]' docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md
# Expect: empty (no em-dashes introduced)

# 6. Title + body count alignment
head -1 docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md | grep -c 'five'
# Expect: 1

# 7. Residual 478-480 string in body
grep -c '478-480\|line 478\|line 479\|line 480' docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md
# Expect: 0 (only 481-483 remains)
```

`bun --bun tsc --noEmit` and `bun --bun vitest run` are NOT required — verified no source change, no test change, no coverage gate impact (this MD has `NEVER modify` source guard; vitest not in the path).

## Execution workflow

1. **Edit** the 13 lines listed above in `message-router-unreachable-defensive-branches.md`.
2. **Verify** via the 7 commands above (read-only checks).
3. **Commit** with the following message:
   ```
   docs(message-router): align unreachable-defensive-branches.md body with footer (lines 481-483; title 4 -> 5)

   - Title: "four unreachable defensive branches" -> "five" (body lists
     5 numbered items; footer already says "5 originally-uncovered").
   - Body line numbers 478-480 -> 481-483 across 8 locations: the
     Location header, the numbered list (lines 478/479/480 -> 481/482/483),
     the Excerpt comment + 3 inline markers, the section header, the
     failure scenario, the pinning test paragraph, and the suggested
     direction.

   Source verification: src/web/message-router.ts:480-483 hosts the 3
   cache-fallback `??` arms; INDEX.md:131/133 and the footer at line 115
   already use 481-483. This commit brings the body in sync.

   No source-code change. No test change. Per-MD NEVER modify guard on
   src/web/message-router.ts (line 181) preserved.
   ```
4. **Verify post-commit**:
   - `git log --oneline -1` shows the commit on `test/baseline`
   - `git diff test/baseline~1..test/baseline --stat` shows 1 file, ~13 lines
   - `git status` is clean
5. **Hand off to user** for `/code-review max --fix` (skill is `disable-model-invocation`; user must invoke from terminal — see `.claude/CLAUDE.md` §8).
6. On review-accepted fixes: **commit immediately, no confirmation gate** (per Honcho memory "review/skill-accepted fixes commit immediately").

## Workflow tool vs Agent tool dispatch

Per `.claude/CLAUDE.md` §8: when 2 parallel verification subagents are needed (dry-run / double-check), use **Agent tool** with `isolation: worktree`, not **Workflow tool**. The Workflow tool's script parser has been flaky in past sessions (3/3 parse errors in 2026-08-24). The Agent tool with `isolation: worktree` has worked first-try both times.

So this cycle's structure:
- **Parent agent**: applies the 13-line edit + commit on `test/baseline`
- **Subagent 1** (Agent tool, `isolation: worktree`): dry-run diff verification (runs the 7 verification commands on a fresh worktree copy)
- **Subagent 2** (Agent tool, `isolation: worktree`): source-alignment verification (reads `src/web/message-router.ts:480-483` and confirms MD body now matches reality)
- **Both subagents run in parallel** in a single message via two `Agent` tool calls
- **User-invoked**: `/code-review max --fix` after parent commit
- **Parent**: applies review-accepted fixes, commits immediately, no confirmation

## Worktree-isolated commit re-application

If a subagent creates a detached-HEAD commit on its worktree, reapply via:
```bash
git worktree remove <worktree-path> --force
git merge --ff-only <detached-SHA>
```
NOT `git reset --hard <SHA>` (triggers Claude Code security warning per `.claude/CLAUDE.md` §8).

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md` (edit target)
- `/Users/eggp/marveen-develop/test-baseline/src/web/message-router.ts` (verification-only, NOT edited)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (read-only; rows 131/133 confirm 481-483)

## Why this batch is the right size

- **Smallest possible**: 1 file, 13 line edits, zero source/test/INDEX change. Smaller is not possible — any tighter would leave the contradictions.
- **Unambiguous fix**: title vs body count, body vs source line numbers — both have a single correct resolution that 2 independent subagents agreed on.
- **Convention-preserving**: footer already says `Partially resolved: ... UNRESOLVED on lines 481-483`; this commit makes the body match the footer. No semantic change to the MD's status.
- **Defers the harder questions**: `message-router-dead-defensive-branches.md` body sync (~25% rewrite) and the 3 em-dash fixes stay for separate cycles, preserving audit-trail granularity.
