# C.1 AuthGate code-review Skipped #2 — factory revert

The `/code-review max --fix` run on 2026-09-08 flagged that `createAuthGate(deps)` factory now meets 0/5 criteria per `.claude/rules/class-vs-functional-decision.md` (after the `log` field was removed in the Applied fix #2).

## Current 0/5 scoring

1. Per-instance mutable state: NEM (no cache, counter, accumulator, last-read timestamp)
2. `implements X` polymorphism: NEM (single implementation)
3. Lifecycle (init → run → dispose): NEM (stateless after construction)
4. Constructor-injected DI: MARGINAL (only `dashboardToken: string`, which is a value not a real dependency)
5. Test isolation via per-instance: NEM (no per-instance state to isolate)

Score: 0.5/5 IGEN → ceremony per the rule.

## Why skipped

Reverting to module-level helpers would be the most invasive change AND would contradict the user's explicit approval of the factory form via AskUserQuestion. The factory still serves a real purpose: it packages the 4 methods into a single object that `web.ts` and future C phases can import as a unit. The `defaultGate` singleton is the production entry point; the factory form is the test seam.

## Decision

Factory stays. The `0/5` score is acknowledged but accepted as a documented trade-off.

## To revisit when

- A future `class-vs-functional-decision` audit (the rule may be updated)
- A C.2 (`DashboardServer`) cycle that needs a different seam and exposes whether the AuthGate factory is actually load-bearing
- A wider refactor that re-evaluates all "factory for DI ergonomics" patterns in the codebase

## Dual-write status

- Honcho conclusion `c1-authgate-code-review-skipped-factory-revert`: saved successfully
- This shared-memory file: created as backup per CLAUDE.md §7