# Plan: agent-worker `__test_*` exports + routes-agents MD drift cleanup

## Context

Two deferred items combined into one cycle on `test/baseline`:

1. **`web-agent-worker-runviaworker-coverage`** — `src/web/agent-worker.ts` has ~53% statement coverage because 6 private helpers (`ensureWorkerReady`, `runWorkerAttempt`, `selfHealWorkerOnce`, `restartWorkerSession`, `clearWorkerContext`, `alertWorkerStuck`) cannot be unit-tested directly. They are only reachable from production via the exported `runViaWorker` (`src/agent.ts:141`), which forces every test to drive the full integration polling loop (sleepMs-based, fragile under `vi.useFakeTimers`).

2. **`routes-agents-br-baseline-partial-coverage.md` drift** — the cycle-51 `52baf44` follow-up explicitly SKIPPED 5 line-citation errors and the fabricated `activity-list` term at L158-159 as "out of scope per CLAUDE.md §3 surgical changes." The 4 `+13` line refs (MD-cited vs actual `describe` openers) are real and quantify-able. Fixing them is docs-only (zero source changes).

**Why combine:** user explicitly asked to combine when no coupling. agent-worker is a real source/test edit, routes-agents is docs-only — independent concerns, different files. 2 commits, same cycle. Honcho memory #37 alignment: "separate commits if independent concerns."

**Why not include `keychain-store-insecure-acl`:** Honcho HOT memory items #43, #44 require empirical SSH smoke test (two prior reverts: `725b1a1` and `94650ef`). BLOCKING until user provides SSH context.

**Why not include `web-inbound-probe-respawn-grace`:** vitest mock-resolution bug (dynamic `import()` vs static `vi.mock` path mismatch). Not a `__test_*` pattern. CLAUDE.md §8: vitest config changes require empirical dry-run; risk is HIGH.

**Why not include `channel-coordinator-internals-untestable`:** same pattern as agent-worker but 10 fns (vs 6) and `runLoop` is 92 lines spanning 8+ state-machine branches. Too large for one cycle; split into multiple cycles later.

## Recommended approach

### Commit 1: `fix(agent-worker): expose 6 private helpers via __test_* prefix for direct unit coverage`

**Source edit — `src/web/agent-worker.ts`:** rename 6 private function declarations to `__test_*` exports. Pure rename; internal callers (`runViaWorker`, `runWorkerAttempt`, `selfHealWorkerOnce`, etc.) updated to call the new names.

| Old | New | Line range |
|---|---|---|
| `function ensureWorkerReady` | `export function __test_ensureWorkerReady` | 604-631 |
| `function runWorkerAttempt` | `export function __test_runWorkerAttempt` | 670-721 |
| `function selfHealWorkerOnce` | `export function __test_selfHealWorkerOnce` | 576-592 |
| `function restartWorkerSession` | `export function __test_restartWorkerSession` | 633-643 |
| `function clearWorkerContext` | `export function __test_clearWorkerContext` | 646-655 |
| `function alertWorkerStuck` | `export function __test_alertWorkerStuck` | 595-602 |

**Test addition — `src/__tests__/agent-worker-full.test.ts`** (preferred, has the `H` mock factory): add new `describe` blocks per `__test_*` export, following the existing pattern (50+ existing describe blocks driving via `runViaWorker`). The new describes call `__test_*` directly.

**Critical pattern — module-load env isolation:** the existing test file uses `vi.resetModules()` + `delete process.env.MARVEEN_WORKER_*` at L218-223 to re-import after env reset (because `ctxSlow`/`ctxFast` read `process.env.MARVEEN_WORKER_DIR` at IMPORT time). New direct-call tests MUST match this pattern, otherwise the helpers will see the original ctx home. Verified by the Plan agent — `agent-worker-full.test.ts` already follows this pattern, so reusing it is safe.

**MD filename drift warning (NOT a commit edit):** the MD at L5 cites `src/__tests__/web-agent-worker.test.ts` which does NOT exist. The real files are `agent-worker.test.ts` and `agent-worker-full.test.ts`. Implementer MUST use the real filename. MD correction is a follow-up concern (out of current scope per user brief).

### Commit 2: `docs(md): correct 5 line citations + replace fabricated activity-list term in routes-agents-br-baseline-partial-coverage.md`

`docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md` — 5 edits:

| Line | Current | Replace with |
|---|---|---|
| L33 | `agents-routes.test.ts:4208` | `agents-routes.test.ts:4221` |
| L41 | `agents-routes.test.ts:4316` | `agents-routes.test.ts:4329` |
| L106-107 | `agents-routes.test.ts:4208` | `agents-routes.test.ts:4221` |
| L108 | `agents-routes.test.ts:4316` | `agents-routes.test.ts:4329` |
| L158-159 | "covered by the activity-list tests at `agents-routes.test.ts:3428-3447` and `4002-4016`" | "covered by the `baseline: running=true agent summary branches` and `baseline: getAgentSummary activeModel / contextTokens branches` tests at `agents-routes.test.ts:3428-3447` and `4015-4029`" (matches 52baf44 style at L74/L120) |

**L3428-3447 left intentionally** (off-by-2 against L3426 describe opener; 52baf44 deliberately preserved this convention and the user's brief did not flag it).

**L158-159 fixed as a single edit** — they are the same sentence; fixing the fabricated term without fixing the adjacent wrong line ref would be incomplete.

## Critical files

- `src/web/agent-worker.ts` — 6 `function` → `export function __test_*` renames + ~6 internal call-site updates
- `src/__tests__/agent-worker-full.test.ts` — new `describe` blocks per `__test_*` export
- `docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md` — 5 line/term edits

**Reference files (read-only during execution):**
- `docs/needs-to-be-fix/web-agent-worker-runviaworker-coverage.md` — coverage gap rationale
- `src/__tests__/agents-routes.test.ts` — ground-truth for line refs (L4221, L4329, L3426, L4011)
- `vitest.config.ts` — coverage threshold 100% per-file
- `docs/needs-to-be-fix/INDEX.md` — update L72 and L192 rows to point at the new commit SHA

## Execution: 4-phase Agent-isolation workflow

### Phase 1 — Implementer (1 Agent, `isolation: "worktree"`)

- Create worktree: `git worktree add --detach /tmp/claw-test-impl test/baseline`
- `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-test-impl/node_modules`
- Run `cd /tmp/claw-test-impl && bunx tsc --noEmit | wc -l` first to confirm baseline (expected: 2253)
- Apply Commit 1 changes (agent-worker.ts + test file), commit, then apply Commit 2 changes (MD only), commit
- Run `bun --bun vitest run src/__tests__/agent-worker.test.ts src/__tests__/agent-worker-full.test.ts` — must be green
- Run `bun --bun vitest run src/__tests__/agents-routes.test.ts` — must be 100% green (no regression)
- Run `bun --bun vitest run --coverage src/web/agent-worker.ts` — coverage must increase
- Verify `grep -nE 'agents-routes\.test\.ts:(4208|4316)' docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md` returns nothing
- Verify `grep -nE 'activity-list' docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md` returns nothing

**Worktree transfer fallback (CLAUDE.md §8):** if implementer ends up committing to `/Users/eggp/marveen/.claude/worktrees/.../marveen/` (cycle 49-50 precedent), use `git format-patch -1 <SHA>` + `git am <patch>` to transfer to `test/baseline`. SHA may change, content identical.

**Transfer-back to `test/baseline`:** per CLAUDE.md §8, after implementer's worktree commits land, use `git merge --ff-only <SHA>` (not `git reset --hard`) to bring back into `test/baseline`. Working tree must be clean; worktree cleanup (`git worktree remove --force`) before merge.

### Phase 2 — Verify (2 Agents in parallel, `isolation: "worktree"`)

**Agent ALPHA** — adversarial probes on Commit 1 (agent-worker):
- 6 helpers truly exported (grep confirms `export function __test_*`)
- Internal callers renamed (no broken refs)
- Test count delta: +N where N = new describe blocks added
- `agent-worker.test.ts` (the pure-export test file) still passes
- Coverage on `agent-worker.ts` strictly higher than baseline (~53%)
- No regression on `routes-agents.test.ts` (must stay at cf85135 baseline of 100% branches)
- tsc error count: 2253 baseline + ~6 new type bindings (expected ~2259)
- Commit message no em-dash (CLAUDE.md §6)

**Agent BETA** — adversarial probes on Commit 2 (drift):
- 4 `+13` line citations all corrected
- L158-159 fabricated `activity-list` term replaced; new term names match real describe blocks
- `grep -nE 'agents-routes\.test\.ts:(4208|4316)'` returns 0 hits in `src/` and the MD
- `grep -nE 'activity-list'` returns 0 hits in the MD
- L3428-3447 NOT modified (preserved 52baf44 convention)
- Zero source changes (drift is docs-only)
- tsc error count unchanged (2253)
- Commit message no em-dash

### Phase 2.5 — line-ref + test-label verification (CLAUDE.md §8, cycle 52 retrospective)

Before Phase 3 (docs sync), implementer MUST run:
```bash
grep -nE "^describe\('baseline: (extractBotId regex-fail branch|PUT /api/agents/:name/security 404 branch|running=true agent summary branches|getAgentSummary activeModel / contextTokens branches)" \
  /Users/eggp/marveen-develop/test-baseline/src/__tests__/agents-routes.test.ts
# Expected: 4221, 4329, 3426, 4011

# Read these line ranges to confirm content matches MD citation:
sed -n '3420,3450p' src/__tests__/agents-routes.test.ts
sed -n '4005,4035p' src/__tests__/agents-routes.test.ts
sed -n '4218,4240p' src/__tests__/agents-routes.test.ts
sed -n '4325,4350p' src/__tests__/agents-routes.test.ts
```

Any contradiction fixed BEFORE Phase 3.

### Phase 3 — Docs sync (INDEX.md + MD line refs)

Update `docs/needs-to-be-fix/INDEX.md` L72 (`channel-coordinator-internals-untestable` stays Deferred) and L192 (`web-agent-worker-runviaworker-coverage`) to point at the new commit SHA. Update `web-agent-worker-runviaworker-coverage.md` L52-63 (Suggested direction) to reflect the actual approach taken. Single docs commit: `docs(index+md): mark web-agent-worker-runviaworker-coverage resolved + INDEX.md SHA update`.

### Phase 4 — `/code-review max --fix` (USER-INVOKED, NOT Skill tool)

Per CLAUDE.md §8: `/code-review` has `disable-model-invocation`. Document in handoff that user must invoke it in their terminal. Skill applies fixes; implementer commits follow-up with `(this commit)` SHA placeholder, then a separate `docs(index): correct SHA reference` commit swaps in the real SHA (CLAUDE.md §8 MD SHA reference rule).

## Verification (end-to-end)

```bash
# Baseline
git -C /Users/eggp/marveen-develop/test-baseline status --short
# Expected: clean (or only worktree-list residue)

# Typecheck
cd /tmp/claw-test-impl && bunx tsc --noEmit | wc -l
# Expected: 2253 + ~6 (Commit 1 adds 6 export bindings, Commit 2 is docs-only) ≈ 2259

# Agent-worker tests (Commit 1)
cd /tmp/claw-test-impl && bun --bun vitest run src/__tests__/agent-worker-full.test.ts src/__tests__/agent-worker.test.ts
# Expected: all green; new __test_* describe blocks appended

# Routes-agents regression (Commit 1 must not touch routes-agents.ts)
cd /tmp/claw-test-impl && bun --bun vitest run src/__tests__/agents-routes.test.ts
# Expected: 100% lines + branches (matches cf85135 baseline)

# Coverage (Commit 1)
cd /tmp/claw-test-impl && bun --bun vitest run --coverage src/web/agent-worker.ts
# Expected: lines + branches strictly ↑ from ~53%

# Drift verification (Commit 2)
grep -nE 'agents-routes\.test\.ts:(4208|4316)' /Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md
# Expected: 0 hits

grep -nE 'activity-list' /Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/routes-agents-br-baseline-partial-coverage.md
# Expected: 0 hits

# Full suite sanity (Commit 1+2 together)
cd /tmp/claw-test-impl && bun --bun vitest run
# Expected: 0 failed, 0 skipped (382+ test files, +N new describes)
```

## Out of scope (explicit enumeration per Honcho plan-mode rule)

1. **`keychain-store-insecure-acl`** — BLOCKING. Requires SSH smoke test. Two prior reverts. Out of cycle.
2. **`web-inbound-probe-respawn-grace`** — vitest harness bug, not `__test_*` pattern. CLAUDE.md §8 dry-run rule applies. Risk HIGH.
3. **`channel-coordinator-internals-untestable`** — same pattern, 10 fns, larger scope. Future cycle.
4. **MD filename drift at `web-agent-worker-runviaworker-coverage.md` L5** — `web-agent-worker.test.ts` does not exist. Implementer must NOT follow this. MD correction is a follow-up (out of user's explicit scope).
5. **MD L3428-3447 off-by-2** — left intentionally (matches 52baf44 convention; user did not flag).
6. **Routes-agents MD "Excerpts" L74 + "Pinning-test" L120** — already corrected in 52baf44; not touched again.
7. **Option B for agent-worker** (injectable clock + fs reader) — explicit MD guidance: "do NOT apply as part of this test commit." User-chosen scope is Option A only.
8. **Option C for agent-worker** (drop 100% threshold) — explicit MD guidance: "do NOT apply." User wants coverage.
9. **Push to origin** — CLAUDE.md §6: push is user's responsibility, never pushol.
10. **`/code-review max --fix` invocation** — `disable-model-invocation` Skill. User must invoke in terminal.

## Risks and unknowns (from Plan agent)

1. **Module-load env isolation**: new direct-call tests must follow `vi.resetModules()` + env-delete pattern. Implementer confirms by Read of `agent-worker-full.test.ts` L218-223 before writing new tests.
2. **MD filename drift at agent-worker MD L5**: implementer uses real filename, not MD's wrong one.
3. **Baseline 2253 typecheck count**: not independently re-verified at plan time. Phase 1 measures fresh first; if baseline ≠ 2253, all expected deltas in verification section need recalibration.
4. **No em-dash in commit messages** (CLAUDE.md §6): use `+` or `and`/`or`; verified by Agent ALPHA/BETA in Phase 2.
5. **Worktree transfer fallback** (cycle 49-50 precedent): `git format-patch` + `git am` if implementer ends up in `marveen/.claude/worktrees/`. SHA may change.
6. **`git merge --ff-only` for transfer back**: not `git reset --hard` (CLAUDE.md §8 triggers security warning). Worktree cleanup before merge; working tree must be clean.
7. **Cf85135 precedent**: `__test_parseChannelProvider` is the precedent. Match verbatim — no new convention.