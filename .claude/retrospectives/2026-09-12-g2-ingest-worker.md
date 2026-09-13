# 2026-09-12 G.2 IngestWorker class extraction session retrospective

## Summary

User asked which item in `docs/refactor-to-classbase/` to do next. Initial exploration surfaced that G.1 was previously tried (`13a0f5e`) and reverted (`bd94d2c`), and that the `class-vs-functional-decision.md` rule rates G.1 at 0/5 ceremony. User's AskUserQuestion answer named G.1 first, but the inventory agent then surfaced the revert history post-decision. After re-discussion, user deferred the choice ("nem tudom ami a legjobb sebeszi megoldasokat tartalmazza"), and I recommended G.2 IngestWorker (rule verdict 2/5 IGEN — state + lifecycle, smallest scope open G-track item).

The session executed G.2 via session mainloop (not the Workflow tool, after pre-checking that the plan's Workflow tool reference was incorrect — the user-invoked `verify` step needed Agent tool with `cd $HOME/claw-g2` prefix, per CLAUDE.md §8 Workflow tool worktree-isolation warning).

## Cycle outcome

- **Commit**: `fda697d` on `refactor/classbase`
- **Files**: `src/channel-coordinator/ingest.ts` (243+/155-), `src/__tests__/ingest-worker.test.ts` (new, 12 assertions)
- **Public API impact**: zero — 13 mock/import sites byte-identical
- **Gates**: tsc 0 errors, vitest 255/255 passed (14 files), coverage 100% on `ingest.ts`, lint 10389 (-1 from baseline 10390)

## Decisions taken

1. **Class is INTERNAL (not exported).** Matches A.2a ChannelPairingStore pattern (`98976a9`). Avoids the 8 `vi.doMock` factory updates that would have been required if exported. The user's plan said "class NEM exportált" after Verifier-B surfaced the mock-surface risk.
2. **`/* istanbul ignore next */` for unreachable branches.** The vitest config uses `provider: 'istanbul'`, not c8. Initial use of `/* c8 ignore next */` did NOT take effect; switching to `/* istanbul ignore next */` brought coverage from 89.65% to 100%.
3. **Code-review deferred to next session.** User's `/code-review max --fix` invocations failed due to external API errors (429 + DNS ENOTFOUND). Per plan's Phase 6 fallback, the commit landed without code-review applied.

## What worked

- **Dual verification with different angles** (per CLAUDE.md §8). Verifier-A found the surface invariants; Verifier-B found the coverage gap (90.47%) and lint regression (+11) that would have landed silently. Both angles were load-bearing.
- **`assertIsNumber` type-guard mirrors `assertPasswordPolicy` pattern** from `src/web/password-hash.ts:52` — TypeScript `asserts value is T` signature narrows the type for downstream use without `!` non-null assertion. Vitest's `no-non-null-assertion` lint rule then passes.
- **Pre-measured baselines** (tsc=0, lint=10390, vitest=243/243) — verified that the post-implementation gate improvements (-1 lint, +12 tests) were net-positive deltas, not noise.

## What didn't work

- **Workflow tool was specified in the plan but never used.** The plan described phases that the Workflow tool would orchestrate, but the plan itself noted that the verifier subagents needed Agent tool (not Workflow tool `parallel()` + `isolation: 'worktree'`). The session executed directly in the mainloop. The Workflow tool would have added complexity without benefit here, especially given its history of safety-classifier false-positives (`c1-authgate-cycle-functional-core-factory.md`).
- **`/* c8 ignore next */` does NOT work with vitest's istanbul provider.** Initial attempt to silence unreachable branches used c8 syntax; coverage remained at 89.65%. Switching to `/* istanbul ignore next */` brought it to 100%. Future cycles should use istanbul syntax from the start.

## Rule-of-thumb updates worth considering

1. **`/* c8 ignore next */` → `/* istanbul ignore next */` for vitest+istanbul.** The vitest config in this repo uses istanbul provider, not c8 wrapper. CLAUDE.md §7 should note this.
2. **Plan should specify the dual-write script explicitly.** The plan said `pnpm claude:memory write <topic> <content-file>` is the atomic Honcho+shared-memory writer. Future plans should reference this by name, not by description.
3. **Code-review step needs explicit fallback for external API failures.** The plan's fallback covered user-unavailable case but not API-down case. Both should be documented.

## Memory entries dual-written

- `.claude/shared-memory/g2-ingest-worker-cycle-outcome.md` — full cycle outcome (Honcho API key not set, so Honcho write skipped; shared-memory is the authoritative record per the script's contract)

## Related precedents

- A.2a ChannelPairingStore class extraction (commit `98976a9`) — same module-singleton + thin shim pattern, same byte-equivalent public API guarantee
- C.1 AuthGate cycle (commit `ebb7dba`) — same plan→dual-verify→commit→cleanup shape, but with factory form per the rule verdict (1/5 ceremony → no class)
- G.1 TelegramClient (commit `13a0f5e`, reverted by `bd94d2c`) — the 0/5 ceremony anti-pattern that G.2 was chosen to avoid

## Open follow-ups

- `/code-review max --fix` re-run on `fda697d..HEAD` in the next session (the API failure today was external)
- G.3 LivenessTracker (next-lowest risk G-track open item)
- G.4 ChannelCoordinator orchestrator (depends on G.1-G.3; now unblocked by G.2)