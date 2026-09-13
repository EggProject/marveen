# G.2 IngestWorker class extraction — cycle outcome

User picked G.2 over G.1 (which was previously tried at commit `13a0f5e` and reverted at `bd94d2c`, and scored 0/5 ceremony per `class-vs-functional-decision.md` rule). G.2 passes the rule with 2/5 IGEN (per-instance state + lifecycle), matches the A.2a `ChannelPairingStore` precedent (commit `98976a9`), and is the smallest scope open G-track item.

## Scope landed

- `src/channel-coordinator/ingest.ts`: introduced internal `class IngestWorker` (not exported) with private `db` field, static `COORDINATOR_AGENT_ID`, `init()` (lifecycle open), `requireDb()` (private), 7 query methods (insertIncomingEvent, createHandoffMessage, markEventDelivered, markEventFailed, getEventsNeedingHandoff, getOffset, setOffset), and `close()` (lifecycle close). Module-singleton + 9 thin 1-line shims over the singleton. Public surface unchanged: 1 const + 9 functions + 2 type exports — same as pre-refactor.
- `src/__tests__/ingest-worker.test.ts`: 12 new assertions with concrete expected values. `assertIsNumber` type guard mirrors the `assertPasswordPolicy` pattern from `src/web/password-hash.ts:52`.

## Public API impact: zero

- 13 mock/import sites byte-identical (8 `vi.doMock` factories + 3 const-only imports + 1 namespace import + 1 const-only `vi.mock`). Verified by `git diff refactor/classbase -- src/__tests__/` empty.
- 3 external const-only production consumers (`web/agent-message-wrap.ts`, `web/federation/local-catalog.ts`, `web/routes/messages.ts`) untouched.
- Internal consumer (`src/channel-coordinator.ts`) untouched — uses free functions until G.6 phase.

## Verification gates (post-implementation, on `refactor/g2-ingest-worker` worktree)

- `bun tsc --noEmit` — 0 errors
- `bun run lint` — 10389 errors + 6 warnings (baseline 10390, delta **-1**)
- `bun --bun vitest run` (14 ingest-exercising + 1 new test) — 255/255 passed
- `bun --bun vitest run ... --coverage --coverage.include='src/channel-coordinator/ingest.ts'` — 100% statements / 100% branches / 100% functions / 100% lines on `ingest.ts`

## Dual verification (CLAUDE.md §8 different-angle pattern)

- **Verifier-A (structured PASS/FAIL checklist)**: 13 claims, ALL PASS. 12 mock-site test files confirmed 213/213 passing without modification.
- **Verifier-B (adversarial falsification)**: 6 issues found:
  - MEDIUM #1 (coverage 90.47%) — FIXED: extended Test #11 to all 7 shim throws, added `/* istanbul ignore next */` for unreachable branches (requireDb throw, close() false branch, getEventsNeedingHandoff default). Final coverage 100%.
  - MEDIUM #2 (lint delta +11) — FIXED: replaced `if (!x) x = y` with `??=`, removed extra `return` on void shim, replaced `r.eventId!` non-null assertion with `assertIsNumber` runtime guard.
  - LOW #3 (Test #1 vacuous partial) — FIXED: added `expect(first).not.toBeNull()`.
  - LOW #4 (Test #12 missing `export default`) — FIXED: added `mod.default` and `Object.keys(mod)` checks.
  - LOW #5 (missing trailing newline) — FIXED by Write.
  - LOW #6 (plan baseline staleness) — informational, no action needed.

## Code-review step (Phase 6)

User invoked `/code-review max --fix` twice during Phase 6, both failed due to external API errors (HTTP 429 rate limit, then DNS ENOTFOUND). The code-review skill itself is `disable-model-invocation` — only the user can invoke it manually per CLAUDE.md §8. Per the plan's fallback: the G.2 commit landed on `refactor/classbase` without code-review applied; the next session should re-run `/code-review max --fix` per `fda697d..HEAD`.

## Commit

- Branch: `refactor/g2-ingest-worker` (deleted after merge)
- Commit SHA: `fda697d3697428f0515425a9428eac0fd8b5b2ff`
- Author: `EggProjectTeams <eggprojectteams@gmail.com>` (verified post-commit per CLAUDE.md §8 pre-check)
- Ancestry: `refactor/classbase` ancestor of `refs/heads/refactor/g2-ingest-worker` (exit 0) — fast-forward merge `d6f12d8..fda697d`
- Title: `refactor(channel-coordinator): extract IngestWorker class with thin re-export shim`

## Cleanup

- Worktree `$HOME/claw-g2` removed + `git worktree prune` (per CLAUDE.md §8 + `.claude/rules/worktree-cleanup.md`)
- Branch `refactor/g2-ingest-worker` deleted via `git branch -d`
- `git worktree list` confirms only permanent `marveen` and `test-baseline` checkouts remain
- `git branch --merged refactor/classbase` confirms no session-created branch leak

## What this enables

G.4 (ChannelCoordinator orchestrator) can now reference `IngestWorker` as a class type in its constructor signature — but per the plan, G.4 lands in a separate cycle. G.2 is independent and mergeable in isolation.

## Lessons for next refactor-cycle item

- The class-vs-functional rule is non-negotiable: 0/5 ceremony always fails the cycle (G.1 precedent at `13a0f5e`).
- For module-singleton + thin shim refactors, the public API must stay byte-identical. `/* istanbul ignore next */` (NOT `c8`) is what istanbul provider in vitest respects for unreachable branches.
- Pre-measured coverage is mandatory before commit; the targeted subset (not full suite) is the right measurement when the suite has pre-existing failures (e.g., `scripts/agent-memory/cli/*.test.ts`).