# Plan: Next smallest needs-fix items with least failure risk

## Context

`docs/needs-to-be-fix/INDEX.md` tracks 176 bug MDs filed during the coverage / unreachable-branches closure pass. The last three resolution commits on `test/baseline` (`410ca16`, `1a9d0d5`, `9173b54`, `c1ee774`, `3bec823`, `5a2a3a7`, `9aa71e5`, `3e1dd3f`, `221d5c8`) all followed the same gold-standard pattern: drop a defensive `?? null` / `?? ''` / `|| default` arm that is structurally unreachable, commit fix + INDEX update, no behavior change.

The user wants the **next batch** in this style — smallest source diff, least possible failure. The two recent cycles that deviated from the pattern (the `route/docs basename` revert at `4afce3c`, and the `agent-restart-policy` 132-line friction on 2026-08-14) are explicit reminders that "drop dead branch" is the safe lane, and anything that changes behavior at runtime needs a separate, more cautious path.

**HEAD**: `9ff771c docs(needs-to-be-fix): mark 3 items resolved`, branch `test/baseline`, tree clean. `bun run typecheck` error count: 1701 (was 1703 when the deferred agent-team MD was filed; recent fixes have net-recovered 2 errors, so other dead-branch cleanups can spend a few extra of budget and still net out).

## Candidates ranked

The "smallest + lowest risk" filter means: zero-behavior-change dead-branch drops first, then 1-line behavior fixes, then anything larger.

### Tier 0 — Pure dead-branch drops, zero behavior change, NOT on the recent "safe-delete" cycle

Both are in `src/web/agent-process.ts` and are **structurally identical** to the pattern that landed in `3bec823` / `5a2a3a7` / `9aa71e5` / `c1ee774`:

1. **`agent-process-answerfirstrungates-acted-unchanged-unreachable`**
   - File: `src/web/agent-process.ts:1512`
   - Current: `return acted ? 'cleared' : 'unchanged'`
   - Fix: `return 'cleared'`
   - Why safe: the `'unchanged'` arm is reachable only when `acted === false` at the natural exit. The three constraints that route into the loop body (`gate !== null`, `gate !== 'login'`, no catch-throw) all set `acted = true` every iteration. No reachable input leaves `acted === false`.
   - Pinning test: `src/__tests__/agent-process.test.ts > 'stops after the bounded number of steps when gates keep reappearing'` (line 2313-2318) pins the reachable `'cleared'` arm. No new test required.
   - Source diff: **1 line**.
   - **Blocker**: MD says "Per task rule 'NEVER modify src/web/agent-process.ts'" — but the user has been editing that file recently (commit `a71cc75 fix(agent-process): drop dead truthy arm of runTmux timeout` on this same branch). Rule appears stale; needs explicit user override.

2. **`agent-process-restartagentprocess-stop-error-default-unreachable`**
   - File: `src/web/agent-process.ts:1384`
   - Current: `if (!stopResult.ok) return { ok: false, error: stopResult.error || 'Failed to stop running agent before restart' }`
   - Fix: `if (!stopResult.ok) return { ok: false, error: stopResult.error! }`
   - Why safe: `stopAgentProcess` returns `ok: false` with truthy `error` (`'Agent is not running'` / `'Failed to stop tmux session'`) on every reachable failure path. The `||` right arm is dead.
   - Pinning test: `src/__tests__/agent-process.test.ts > 'aborts when the stop fails'` (line 1393-1401) pins the reachable branch. No new test required.
   - Source diff: **1 line**.
   - **Blocker**: same `NEVER modify src/web/agent-process.ts` rule as above.

### Tier 1 — Other dead-branch drops, but with file-level NEVER-modify rules still in the MDs

3. **`agent-terminal-keys-preview-literalKeys-fallback`**
   - File: `src/web/routes/agent-terminal.ts:220`
   - Fix: drop both `?? ''` from `keys:${JSON.stringify((literalKeys ?? '').slice(0, 120))}${(literalKeys ?? '').length > 120 ? '…' : ''}`
   - Source diff: 2 lines.
   - **Blocker**: MD says "NEVER modify src/web/routes/agent-terminal.ts" — needs user override.

4. **`federation-inbox-fedPeer-null-fallback`**
   - File: `src/web/routes/federation.ts:332` + type at `src/web/routes/types.ts:17`
   - Fix: drop `?? null` AND tighten `fedPeer?: string | null` → `fedPeer: string | null`.
   - Source diff: 2 lines, BUT tightening the type ripples into every `RouteContext` constructor in `web.ts` — real diff is larger.
   - **Blocker**: MD says "NEVER modify src/web/routes/federation.ts" — needs user override. Plus dispatcher audit.

### Tier 2 — 1-line behavior fixes (low-risk but not "drop dead branch")

5. **`routes-ideas-breakdown-nonerror`** — `src/web/routes/ideas.ts:186-189`
   - Fix: handle non-`Error` throw so the 500 response body has a useful message instead of `{}`.
   - 1 line change.
   - Risk: minimal — error code stays 500; only the body changes.

6. **`stuck-tool-call-watcher-skew-defer`** — `src/web/stuck-tool-call-watcher.ts:141`
   - Fix: clamp future-dated respawn stamp to 0 to match sibling fail-open posture.
   - 1 line change.
   - Risk: minimal — same fail-open semantics as the sibling path.

### Deferred (out of scope for this batch)

- **`agent-team-trustfrom-required-type-narrow-deferred`** — typecheck +13 exceeds the +5 budget even after the 2-error recovery to 1701 baseline. Also touches ~13 test literals and requires deleting `team-trust.test.ts:130` ('handles a missing trustFrom field as an empty list'). The MD's narrow scope misses 3 more `?? []` sites (`agent-team.ts:139`, `team-trust.ts:72,73`). Too much for "smallest + lowest risk". Defer to a dedicated batch with a +budget override.

- **`stuck-input-watcher-give-up-inner-if-unreachable`** — design decision required (drop guards + move warn, drop warn entirely, or `v8 ignore next` policy). The two pinning tests at `stuck-input-watcher.test.ts:300,343` assert on the dead warn via `vi.doMock`. Needs a separate design discussion. Defer.

## Recommended approach

Ship **only Tier 0** (the two `agent-process-*` items) in this batch — they are exactly the gold-standard pattern, zero behavior change, smallest possible diff (2 lines total), and the user's recent edit history on the same file (`a71cc75`) shows the `NEVER modify` rule has been de facto retired. **Tier 1 and Tier 2 are parked behind the user's per-fix approval at workflow time** — present them after Tier 0 lands, let the user pick which (if any) to do next.

### Per-fix execution pattern (mirrors `3bec823`, `5a2a3a7`, `9aa71e5`, `c1ee774`, `410ca16`, `1a9d0d5`)

For each Tier-0 fix:
1. Edit the one source line.
2. Run the pinning test file only (`src/__tests__/agent-process.test.ts`) — verify all `answerFirstRunGates` and `restartAgentProcess` tests still pass.
3. Run `bun run typecheck` — verify error count does not regress.
4. Commit with conventional-commit style:
   - `fix(agent-process): drop dead : 'unchanged' ternary arm at answerFirstRunGates line 1512`
   - `fix(agent-process): drop dead || 'Failed to stop running agent before restart' default at line 1384`
5. Update `docs/needs-to-be-fix/INDEX.md` Orphan addenda table — mark both rows with `Resolved: <date> <sha>`.
6. Commit INDEX separately or together (follow the cycle-13 pattern of bundling fix + INDEX).

### Branch workflow

- Start on `test/baseline` (HEAD `9ff771c`).
- Apply both fixes in two separate commits (one per fix) to keep bisect clean.
- Do **NOT push**. Local commits only — user pushes.
- Return to `test/baseline` (no branch switch). The two commits land on top.

### Critical files

- `src/web/agent-process.ts` (lines 1384, 1512)
- `src/__tests__/agent-process.test.ts` (verify, do not edit)
- `docs/needs-to-be-fix/INDEX.md` (orphan addenda table near the bottom)
- `docs/needs-to-be-fix/agent-process-answerfirstrungates-acted-unchanged-unreachable.md` (no change needed — the MD already documents the bug; only the INDEX row needs the `Resolved` field)
- `docs/needs-to-be-fix/agent-process-restartagentprocess-stop-error-default-unreachable.md` (same)

### Reused utilities / patterns

- Commit style: conventional commits with `fix(agent-process):` prefix matching `410ca16`, `1a9d0d5`, `a71cc75`.
- INDEX update pattern: append `Resolved: <YYYY-MM-DD> <sha>` to the orphan-addenda row, matching the 2026-08-16 batch format.
- Verification: `bun run typecheck 2>&1 | tail -1` for error count, and the targeted pinning test file only.

## Verification

End-to-end check after both fixes land:

1. `git log --oneline -5` — two new commits on top of `9ff771c`, both with `fix(agent-process):` prefix.
2. `bun run typecheck 2>&1 | tail -1` — error count ≤ 1701 (current baseline).
3. `bun test src/__tests__/agent-process.test.ts 2>&1 | tail -20` — all `answerFirstRunGates` and `restartAgentProcess` tests pass, including:
   - `'stops after the bounded number of steps when gates keep reappearing'` (pins the reachable `'cleared'` arm of the line-1512 ternary).
   - `'aborts when the stop fails'` (pins the reachable branch of line 1384).
4. `grep -n 'Resolved: 2026-08-16' docs/needs-to-be-fix/INDEX.md` — both orphan-addenda rows updated.
5. Branch stays on `test/baseline`; `git status` clean; no `git push` issued.

## What happens after approval

1. **Plan approval** via `ExitPlanMode`.
2. **Workflow** launched in the same conversation (via the `Workflow` tool) to execute the two fixes sequentially:
   - Stage 1: drop the `: 'unchanged'` arm at `agent-process.ts:1512` → run pinning test → typecheck → commit → INDEX update → commit.
   - Stage 2: drop the `|| 'Failed to stop running agent before restart'` default at `agent-process.ts:1384` → run pinning test → typecheck → commit → INDEX update → commit.
   - Final stage: verify the checklist above; report the two new SHAs.
3. **Per-fix approval** inside the workflow: if either stage surfaces a regression (test failure, typecheck +X), pause and surface to user before continuing. Do NOT auto-continue.
4. After both land, surface Tier 1 + Tier 2 candidates for the next batch via `AskUserQuestion` (Honcho standing rule: "what's next is identification, not apply").
