# Cycle 31 — Smallest Low-Risk `needs-to-be-fix` Batch (A + B + C combined)

## Context

Cycles 25–30 closed 14+ needs-to-be-fix items via a proven three-commit pattern (delete guard → flip pinning test → resolve MD + INDEX update). Patterns 99–103 captured the gotchas: TS-strict may auto-revert a deletion, an "unreachable" branch may be load-bearing, and a security-flag removal without replacement creates a regression. The branch `test/baseline` is clean, ahead of `origin/test/baseline` by 0 commits; latest local commit `d147fff test(platform): update stale comments + add x11/mir allowlist regression tests`.

Goal: land the next batch of **smallest** modifications that still carry **non-zero risk**, in **Low-risk tier only**, **combining items that don't interact**. After verification, run `/code-review xhigh --fix` to catch any conventions findings before push.

## Scope (user-confirmed)

Combined batch from three categories, all Low risk:

- **A — Docs/INDEX hygiene** (zero functional risk)
- **B — Smallest defensive-guard removals** (1-line each, different files, Low risk)
- **C — Tier 1 functional bugs** (2–5 line fixes, different files, Low risk, pinning tests exist)

Excluded (deferred or unsafe):
- TS-strict blocked items (`agent-team-trustfrom-nullish-coalesce`, `federation-inbox-fedPeer-null-fallback`, `agent-terminal-keys-preview-literalKeys-fallback`, `channel-invites-108/236`) — require test-file ripple +71 type errors.
- `keychain-store-insecure-acl` — user chose Option A revert in cycle 30; remains open.
- `message-router-cache-fallback-unreachable` — re-opened in cycle 29; type-level data-flow refactor needed.
- `stuck-input-watcher-give-up-inner-if-unreachable` — Medium risk; 2 test cases drop required (`vi.doMock('../pane-state.js')`).
- `routes-fleet-q-*` — already resolved in `b7cd64c`; INDEX is stale (will be flagged in batch A).

## Batch A — Docs/INDEX hygiene (1 workflow, ~5 commits)

| # | Action | File(s) | Risk |
|---|---|---|---|
| A1 | Simplify line 38 (drop unsupported POSIX/Windows platform claim; keep only the `NAME_RE` character-class argument) | `docs/needs-to-be-fix/routes-research-basename-redundant.md` | 0 |
| A2 | Replace "Why this stays" section with `## Resolution` section referencing commit `e62eb87` | same MD | 0 |
| A3 | Retire stale MD `web-command-task-persist-nullish-coalesce.md` (source already rewritten at `src/web/command-task.ts:34`); INDEX line 196 → flip to `Resolved: 2026-08-14 014f1de` (use real HEAD date; verify via `git log -1 --format=%H src/web/command-task.ts`) | MD file + `docs/needs-to-be-fix/INDEX.md` | 0 |
| A4 | Retire stale MD `worker-liveness-defensive-nullish-fallback.md` (source uses `prev.firstSeenAtMs!` at `src/web/worker-liveness.ts:131`); INDEX line 191 area → flip to Resolved | MD file + INDEX.md | 0 |
| A5 | Dedup store-watcher: archive `store-watcher-sensitive-unreachable.md` (orphan addenda line 186 ID), keep `store-watcher-sensitive-names-unreachable.md` (INDEX line 65). Same bug, two IDs. INDEX orphan row deleted; INDEX line 65 row kept (will be resolved by B2) | 2 MD files + INDEX.md | 0 |
| A6 | Dedup fleet-transfer: archive `fleet-transfer-assertsafename-dead-code.md` (orphan line 129), keep `fleet-transfer-assertsafename-dead.md` (INDEX line 81, already `Resolved: 2026-08-14 08d7508`). INDEX orphan row deleted | 2 MD files + INDEX.md | 0 |
| A7 | Mark `routes-fleet-q-body-parse-uncaught` (INDEX line 164) and `routes-fleet-q-404-leaks-roster` (INDEX line 163) Resolved `2026-08-XX b7cd64c`. Source already fixed in commit `b7cd64c`. Verify commit date via `git log -1 --format=%H -- b7cd64c` then `git show -s --format='%cs' b7cd64c` | INDEX.md | 0 |

After A7, INDEX.md should have zero stale rows remaining in the user's `needs-to-be-fix` history. ~5–7 commits.

## Batch B — Smallest defensive-guard removals (1 workflow, ~6 commits)

Both are 1-line deletions in unrelated files with existing pinning tests. No inter-action.

| # | Action | File | Pinning test path | Risk |
|---|---|---|---|---|
| B1 | Delete `if (inFlightReconnects.has(agentName)) return false` at `src/web/channel-health-monitor.ts:27` (MD: `channel-health-monitor-spawndetach-inflight-redundant-guard`). `checkAgent` at line 122 already filters the same `Set`, so the guard is unreachable from production. **Retain the explanatory comment** (forward-compat tripwire noted by Explore agent). | `src/web/channel-health-monitor.ts` | `src/__tests__/channel-health-monitor.test.ts` | Low (Set.has returns boolean; no TS-narrowing risk) |
| B2 | Delete ternary arm `SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0` at `src/store-watcher.ts:142` (MD: `store-watcher-sensitive-names-unreachable`). `SENSITIVE_NAMES ⊆ SYSTEM_FILES`, and `isSystemFile(rel)` returns at line 113 before line 142. **Resolution: drop the flag** (preserves current "don't audit secrets at all" behavior — agent's safer option) | `src/store-watcher.ts` | `src/__tests__/store-watcher.test.ts` | Low |

After B1+B2: 2 source-line deletions + 2 test flips + 2 MD resolves + 2 INDEX updates = ~6 commits.

## Batch C — Tier 1 functional bugs (1 workflow, ~9 commits)

Three fixes in three unrelated files with existing pinning tests. No inter-action. Each is a small behavior change that the MD documents as currently-pinned.

| # | Bug ID | File | Fix size | Test | Risk |
|---|---|---|---|---|---|
| C1 | `memory-digest-empty-trim` | `src/memory.ts:200-206` | 2 lines: `const digest = (text ?? '').trim(); if (!digest) return null` before save | `src/__tests__/memory.test.ts` (add: returns null + `saveMemory` not called for whitespace-only text) | Low (suppresses whitespace-only daily-digest write) |
| C2 | `model-fallback-runner-writemainmodel-nonobject` | `src/web/model-fallback-runner.ts:56-61` | 4 lines: narrow `parsed && typeof parsed === 'object' && !Array.isArray(parsed)` before assigning to `cfg`. Fixes both the array-silent-drop and null-throw failure modes | `src/__tests__/model-fallback-runner.test.ts` (flip 2 pinning tests) | Low (triggers only when `.claude/settings.json` is valid JSON but not an object) |
| C3 | `profiles-replace-dollar-pattern` | `src/web/profiles.ts:51-56` | 5 lines: single-pass `replace` with replacer fn `(_m, key) => key === 'HOME' ? ctx.HOME : ctx.AGENT_DIR`. Closes `$&`/`` $` `` interpolation corruption | `src/__tests__/profiles.test.ts` (flip 2 pinning tests) | Low (latent bug; no current call site reaches the broken path) |

After C1+C2+C3: 3 source fixes + 3 test files (1 add, 4 flips) + 3 MD resolves + 3 INDEX updates = ~9 commits.

## Critical files

**Source files (5):**
- `src/web/channel-health-monitor.ts` (B1)
- `src/store-watcher.ts` (B2)
- `src/memory.ts` (C1)
- `src/web/model-fallback-runner.ts` (C2)
- `src/web/profiles.ts` (C3)

**Test files (5):**
- `src/__tests__/channel-health-monitor.test.ts` (B1 — flip 1)
- `src/__tests__/store-watcher.test.ts` (B2 — flip 1)
- `src/__tests__/memory.test.ts` (C1 — add 1)
- `src/__tests__/model-fallback-runner.test.ts` (C2 — flip 2)
- `src/__tests__/profiles.test.ts` (C3 — flip 2)

**Docs files (10):**
- `docs/needs-to-be-fix/INDEX.md` (every batch updates this)
- `docs/needs-to-be-fix/routes-research-basename-redundant.md` (A1, A2)
- `docs/needs-to-be-fix/web-command-task-persist-nullish-coalesce.md` → archive (A3)
- `docs/needs-to-be-fix/worker-liveness-defensive-nullish-fallback.md` → archive (A4)
- `docs/needs-to-be-fix/store-watcher-sensitive-unreachable.md` → archive (A5)
- `docs/needs-to-be-fix/store-watcher-sensitive-names-unreachable.md` → resolve (B2)
- `docs/needs-to-be-fix/fleet-transfer-assertsafename-dead-code.md` → archive (A6)
- `docs/needs-to-be-fix/channel-health-monitor-spawndetach-inflight-redundant-guard.md` → resolve (B1)
- `docs/needs-to-be-fix/memory-digest-empty-trim.md` → resolve (C1)
- `docs/needs-to-be-fix/model-fallback-runner-writemainmodel-nonobject.md` → resolve (C2)
- `docs/needs-to-be-fix/profiles-replace-dollar-pattern.md` → resolve (C3)

## Existing patterns to reuse

- **Defensive-guard deletion + test flip**: cycles 25–30 established the canonical sequence: (1) delete the guard, (2) flip the pinning-test assertion to expect the unguarded outcome, (3) add `## Resolution` section + INDEX update. **Reference**: commit `2c36e37` (schedule-runner `?.length` refactor) is the cleanest example.
- **MD retirement when source already fixed**: commit `02dd0f8 docs(needs-to-be-fix): retire 11 stale MDs (path-mismatch + source already fixed + MD-self-retire)` — sets the convention for archive-pattern hygiene.
- **INDEX.md `Resolved` format**: `Resolved: YYYY-MM-DD <sha>` — match the existing rows; use `git show -s --format='%cs %h' <sha>` to format.

## Execution plan

Two workflows run sequentially from current branch `test/baseline` (max 2 parallel agents per workflow per policy):

1. **Workflow 1 — `docs-hygiene-cycle-31`** (A1–A7)
   - 1 subagent: simplify line 38 + rewrite line 97 + archive 4 stale MDs + INDEX updates
   - 1 subagent (verification): grep all `docs/needs-to-be-fix/*.md` for stale references, verify no MD body references the deleted MD filenames, confirm INDEX row counts match MD file count
   - Output: branch returned to `test/baseline`, 5–7 commits ahead

2. **Workflow 2 — `code-fixes-cycle-31`** (B1, B2, C1, C2, C3)
   - 2 subagents in parallel:
     - Subagent 1: B1 (channel-health-monitor) + B2 (store-watcher) — 2 source-line deletions + 2 test flips + 2 MD resolves
     - Subagent 2: C1 (memory-digest) + C2 (model-fallback-runner) + C3 (profiles-replace-dollar-pattern) — 3 source fixes + 5 test edits + 3 MD resolves
   - 1 verification subagent: target test runs + full suite + typecheck delta
   - Output: branch returned to `test/baseline`, ~15 commits ahead

3. **End-of-cycle**: invoke `/code-review xhigh --fix` skill on the combined ~20-commit stack before push.

## Acceptance criteria (verification)

- `git status` clean before each workflow launch; clean after both
- `bun --bun vitest run src/__tests__/<each-touched-test-file>`: 100% PASS, flipped assertions observed
- `bun --bun vitest run` (full suite): passes, no new failures or skips
- `bun run typecheck`: still 1701 baseline errors (or ≤ +5 delta per fix)
- `git diff --check`: no whitespace errors
- INDEX.md row count equals `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l` minus 1 (the INDEX itself is counted by the unfiltered command; see INDEX.md:3-5)
- `/code-review xhigh --fix`: 0 P1/P2 findings expected; any finding auto-applied must be verified by own command output (2026-08-15 rule)

## Out of scope (deferred to later cycles)

- `message-router-cache-fallback-unreachable` (re-opened, type-level refactor needed)
- `agent-team-trustfrom-nullish-coalesce` (TS-strict blocked)
- `federation-inbox-fedPeer-null-fallback` (TS-strict blocked)
- `keychain-store-insecure-acl` (user Option A in cycle 30)
- `routes-research-symlink-traversal` (High risk, security, needs symlink fixtures)
- `routes-research-double-stat-inefficiency` (perf, refactor scope)
- `recall-dayofweek-noon-utc-far-east-skew` (Medium risk, date math)
- `routes-background-tasks-{sweep-timeout-reset,session-ended-status}` (Medium risk, BG-task semantics)
- `remote-enroll-*` (Medium risk, lock-acquisition logic)
- `voice-directive-json-quote-escape` (Medium risk, JSON escape)
- `stuck-input-watcher-give-up-inner-if-unreachable` (Medium risk, test drops)
- All remaining Tier 2/3 functional bugs from Explore agent 2's ranked list