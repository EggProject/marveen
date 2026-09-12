# A.3a BackgroundTaskPool cycle outcome — LANDED

## What landed

Two commits on `refactor/classbase`:

1. `b0c0a78` — `refactor(db): extract BackgroundTaskPool class with thin re-export shim (A.3a)`
2. `96d90c7` — `fix(test): apply A.3a verifier findings (vacuous tests + lint)`

Files touched:
- `src/db.ts` — class + module-singleton + 7 thin shim functions in the
  `// --- Background tasks ---` section. +111/-35 net.
- `src/__tests__/background-task-pool.test.ts` — new file. +361 lines,
  19 tests. Anti-vacuous (each `it()` has a positive control or a paired
  negative case that would fail under `() => null` stub).

No other production files touched (verified by `git diff f5e231c..HEAD --stat`).
Out-of-scope files (`routes/background-tasks.ts`, `web.ts`,
`db-100.test.ts`, `background-tasks-routes.test.ts`) are byte-identical
pre/post.

## Baseline measured (pre-A.3a)

| Gate | Value | Source |
|---|---|---|
| `grep -c '^export function ' src/db.ts` | 155 | pre-A.3a |
| `grep -c '^export class ' src/db.ts` | 5 | pre-A.3a |
| `grep -c '^export (interface\|type) ' src/db.ts` | 37 | pre-A.3a |
| `grep -c 'class BackgroundTaskPool' src/db.ts` | 0 | pre-A.3a |
| `bun tsc --noEmit` | 0 errors | pre-A.3a |
| `bun --bun vitest run` (3 BackgroundTask files) | 200/200 PASS | pre-A.3a |

## Post-A.3a gates

| Gate | Value | Δ vs baseline |
|---|---|---|
| `grep -c '^export function ' src/db.ts` | 155 | 0 (shims replaced originals) |
| `grep -c '^export class ' src/db.ts` | 6 | +1 (BackgroundTaskPool) |
| `grep -c '^export (interface\|type) ' src/db.ts` | 37 | 0 (BackgroundTask stays) |
| `grep -c 'class BackgroundTaskPool' src/db.ts` | 1 | +1 |
| `bun tsc --noEmit` | 0 errors | 0 |
| `bun --bun vitest run` (4 BackgroundTask files) | 219/219 PASS | +19 new |
| ESLint on test file | 0 errors | 0 (was 2 pre-fix) |
| ESLint on db.ts | 50 errors | 0 (pre-existing baseline) |

## Notable deviations from plan

1. **`as` cast removal** (Verifier-A item 3, Verifier-B probe 1 — soft).
   The implementer replaced 4 `as BackgroundTask[]` / `as { c: number }`
   casts in the original free functions with `prepare<T, P>` generics +
   `?.c ?? 0` fallbacks. This was FORCED by CLAUDE.md §7 (`as` ban) and
   Verifier-A item 10 (no `as` in new class). Both verifiers explicitly
   flagged this as a checklist contradiction (their own strict byte-
   equivalence criterion cannot coexist with the `as` ban). Probe 5
   (random equivalence on 100 inputs) confirmed functional equivalence.
   Behavioral equivalence preserved (COUNT(*) always returns a row so
   `?.c ?? 0` never diverges from `(x as { c: number }).c`).

2. **Workflow fix step was a no-op** (script bug, see
   `workflow-verifier-string-output.md`). The fix-phase gate triggered
   because `verifierA.verdict` was `undefined` (string access on a
   string), but the findings array was empty because `verifierA.findings`
   was also `undefined`. The fix agent reported "no findings to apply"
   and committed nothing. The 2 real issues (vacuous tests + lint
   violations) were then fixed session-mainloop-style as commit
   `96d90c7`.

3. **Worktree-isolated commit landed on a branch, not detached HEAD.**
   The implementer subagent created branch `refactor/classbase-bg-pool`
   instead of using a detached HEAD. FF-merge from this branch to
   `refactor/classbase` succeeded (f5e231c was ancestor of 96d90c7).
   The branch was deleted after merge per CLAUDE.md §8 worktree-cleanup.

## Verifier outcome breakdown

- **Verifier-A** (structural checklist, 12 items): 11 PASS / 1 FAIL
  (item 3 — soft, see deviation #1).
- **Verifier-B** (adversarial falsification, 10 probes): 7 PASS / 3 FAIL
  - Probe 1: FAIL — same as Verifier-A item 3 (soft).
  - Probe 4: FAIL — 2 vacuous tests. **Real, fixed in 96d90c7.**
  - Probe 7: FAIL — 2 lint violations. **Real, fixed in 96d90c7.**
- **Fix agent** (session mainloop fallback): 2/2 real issues fixed.

## Architectural note

The A.3a class form scores 1/5 on
`.claude/rules/class-vs-functional-decision.md` (only DI applies; no
instance state, polymorphism, lifecycle). This matches the A.2 series
(A.2a ChannelPairingStore, A.2c IdeaStore, A.2d ApprovalStore) — all
score 1/5. The class-vs-functional-decision rule is being applied
**non-strictly** on the A track (the rule says 2/5 minimum; the A track
lands at 1/5). The Honcho memory for the A.2a cycle documented this
explicitly:

> "the `code-review --fix` flagged that the class form here scores only
> 1/5 on `.claude/rules/class-vs-functional-decision.md`. The precedent
> in `IdeaStore` and `ApprovalStore` already establishes this pattern
> across three stores; reverting all three is a separate architectural
> decision requiring an ADR. The cycle kept the class form to match the
> existing pattern; the rule-file reconciliation is deferred."

A.3a continues this established pattern. The deferred ADR (rule-file
reconciliation: revert all A.2+ stores to functional core, or update the
decision tree to recognize the A.2 pattern) remains open.

## What's next on the A track

Per `docs/refactor-to-classbase/a-db/05-refactor-roadmap.md`:
- **A.3b**: SpanStore (4 functions, ON CONFLICT DO UPDATE) — Medium risk,
  3 importers (`routes/spans.ts`, `mcp-list.ts`, `agent.ts`).
- **A.3c**: SshVault (9 functions, transactional deleteKey) — Medium risk.
- **A.2b**: Scheduler (8 functions, cross-store hook to BackgroundTaskPool
  via `markScheduledTaskWaiting`). A.3a now provides the BackgroundTaskPool
  class that Scheduler's cross-store hook depends on, so A.2b's
  late-binding pattern can use `new Scheduler({ db, backgroundTasks })`.
- **A.4a/b**: MessageBus (17 fn, status-guarded transitions) +
  KanbanCards (26 fn) — High risk.
- **A.5**: MemoryStore (26 fn, embedding pipeline) — High risk.

Per the A.5b dependency ("Scheduler depends on BackgroundTaskPool"), A.2b
(Scheduler) was previously gated on A.3a. With A.3a LANDED, A.2b is now
unblocked.