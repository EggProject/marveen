# Next needs-fix batch — smallest modification × lowest failure risk

## Context

The `docs/needs-to-be-fix/` repo currently holds 176 bug MDs. 48 are still open on `test/baseline` (HEAD `8e6eb78`). The user wants the next batch of fixes, prioritized by *smallest modification* and *lowest failure risk*. The session standing rules say:

- A "what's next" needs-fix question is an **identification** request, not an apply request.
- Plan tool ranks → present 3–5 candidates with size+risk → per-fix approval via `AskUserQuestion` → only then run the workflow.
- Working branch is `test/baseline` (the only branch with the tests and the file layout). Every change lands there. No push.

The ranking below comes from a fresh read of the relevant MDs and the source files at HEAD.

## Open items grouped by category

- **A) `ts-strict-blocks-delete`** (6 files): dead guards that TS strict blocks deleting in isolation due to surrounding type errors.
- **B) `unreachable fallback`** (20+): dead `?? X` / `if`-guard arms where the upstream types or branches make the RHS unreachable.
- **C) `test-coverage gap`** (15+): synthetic v8/istanbul pinning tests for structural quirks.
- **D) Real-bug items** (excluded from this batch — higher risk, separate cycle).

## Top 5 candidates, ranked by `size × risk` ascending

| # | Bug ID | File:Line | Size | Risk | Effort | Pinning test |
|---|---|---|---|---|---|---|
| 1 | `agent-restart-policy-consecutivefailures-nullish-coalesce` | src/web/agent-restart-policy.ts:132 | **1 line** | **LOW** | trivial | exists: `src/__tests__/agent-restart-policy.test.ts:312` |
| 2 | `channel-coordinator-setOffset-null-maxUpdateId` | src/channel-coordinator.ts:401 | **2 lines** | **LOW** | trivial | exists: `src/__tests__/channel-coordinator-process-batch.test.ts:209` |
| 3 | `agent-process-777-ts-strict-blocks-delete` | src/web/agent-process.ts:777 + 978 | **2 lines** (one at 777 + one at 978) | **LOW** | trivial | exists: `src/__tests__/agent-process.test.ts` |
| 4 | `routes-docs-basename-redundant` | src/web/routes/docs.ts:62 | **2 lines** (1 source + 1 import) | **LOW** | trivial | exists: mocked-basename test in `src/__tests__/routes-docs.test.ts` |
| 5 | `agent-terminal-keys-preview-literalKeys-fallback` | src/web/routes/agent-terminal.ts:218 | **1–2 lines** + 3-line hoist | **MEDIUM** | small | none (MD notes won't construct) |

### Recommendation

**Apply #1 first** — truly smallest (1 line), already-typed, has pinning test, no tsc-error cascade. Then assess whether to continue with #2, #3, #4 in the same workflow, or stop after #1.

The rationale for grouping #1+#2+#3+#4 into a single workflow: they all share the same pattern (delete dead defensive branch + existing pinning test stays green), and a single workflow batch keeps the operational overhead proportional to the implementation work. #5 is structurally different (small refactor + MEDIUM risk) and belongs to a separate cycle.

## Why each is the smallest feasible

**#1 — `consecutiveFailures ?? 0`**
```ts
const failures = Number.isFinite(input.consecutiveFailures) && (input.consecutiveFailures ?? 0) > 0
  ? Math.floor(input.consecutiveFailures as number)
  : 0
```
`Number.isFinite(null)` → `false`, `Number.isFinite(undefined)` → `false`. The `&&` short-circuits before the `??` is reached. Commit `242714e` already widened the type to accept `null`. Drop the `?? 0` and use `input.consecutiveFailures` directly inside the `&&`. No tsc ripple.

**#2 — `setOffset` null guard** (src/channel-coordinator.ts:399-401)
```ts
// Persist offset ONLY after the batch is durable + handed off.
if (maxUpdateId != null) setOffset(SOURCE, maxUpdateId)
```
The runLoop filters empty batches on line 387 before `processBatch`, and `processBatch` returns `null` only on empty input. Inline `setOffset(SOURCE, maxUpdateId)` and drop the guard.

**#3 — `runTmux` timeout** (agent-process.ts:777 + 978)
```ts
// line 777
execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), stdio: ['ignore', 'ignore', 'pipe'] })
// line 978 (the orphan call site that blocks the safe-delete)
runTmux(null, ['kill-session', '-t', session])
```
The truthy arm at line 777 is dead because ~20 call sites pass an explicit timeout (only the orphan at line 978 omits `opts`). Two atomic edits: add `{ timeout: 5000 }` to the line-978 call (matches the surrounding `execSync('sleep 3', { timeout: 5000 })`), then collapse the line-777 ternary to `?? 3000`.

**#4 — `basename` redundant disjunct** (routes/docs.ts:62)
```ts
if (!NAME_RE.test(name) || basename(name) !== name) {
```
`NAME_RE` is `/^[A-Za-z0-9._-]+\.md$/` — character class excludes `/` and `\`. `basename(name) === name` by construction. Drop the `|| basename(...)` disjunct and the unused `basename` import on line 1.

**#5 — `literalKeys ?? ''` audit preview** (agent-terminal.ts:218)
```ts
const preview = parsed.special
  ? `special:${parsed.special}`
  : `keys:${JSON.stringify((literalKeys ?? '').slice(0, 120))}${(literalKeys ?? '').length > 120 ? '…' : ''}`
```
TS strict (TS18047) blocks the delete because the ternary branches prevent narrowing. The fix is a 3-line hoist: assign `const keyList = literalKeys` after the `if (!args)` early-return, then use `keyList` in the preview. Slightly larger than #1–#4 because of the refactor.

## Files to be modified (one commit per fix)

- `src/web/agent-restart-policy.ts` (1 line)
- `src/channel-coordinator.ts` (2 lines)
- `src/web/agent-process.ts` (2 lines across two sites)
- `src/web/routes/docs.ts` (2 lines: 1 source + 1 import)
- `src/web/routes/agent-terminal.ts` (only if #5 is included in this batch — separate cycle)

No test files need to change for #1–#4. The INDEX.md gets updated after each successful fix to mark the row resolved.

## Verification

Each fix is verified independently by the workflow:

1. **Edit source** (the surgical change above).
2. **Run `bun run typecheck`** — expect 1700 errors at HEAD (baseline unchanged; all 4 files have 0 tsc errors at HEAD so the edit does not introduce new errors).
3. **Run `bun test <pinning-test-file>`** — pinning test must pass.
4. **Run `bun test`** full suite — confirm 381/381 files, 11077/11077 tests green (no new failures).
5. **Commit locally** — `git commit -m "fix(<module>): <bug-id> – <one-line description>"`. No push.
6. **Update `docs/needs-to-be-fix/INDEX.md`** — mark the row resolved with `<YYYY-MM-DD> <sha>`.

The workflow runs plan → apply → verify → commit → index-update, per user standing pattern.

## Per-fix approval gate

Per the standing rule (plan agent ranks → AskUserQuestion per-fix → only then run workflow), after this plan is approved I will ask the user to pick which fix(es) to apply. The default candidate is #1 only. The user can opt to bundle #1–#4 in a single workflow.

## Out of scope for this batch

- `agent-team-trustfrom-required-type-narrow-deferred` (+13 tsc error cascade — separate cycle)
- `federation-inbox-fedPeer-null-fallback` (line 329, requires type narrowing of `RouteContext.fedPeer` — deferred per the companion MD)
- `channel-invites-{108,236}-ts-strict-blocks-delete` (requires removing the synthetic Proxy-mock tests that exist solely to drive the dead branches)
- `stuck-input-watcher-give-up-inner-if-unreachable` (test assertion flip required)
- Two stale MDs (`agent-process-answerfirstrungates-acted-unchanged-unreachable`, `agent-process-restartagentprocess-stop-error-default-unreachable`) — source already fixed, only INDEX row needs sync
- All High/Medium real bugs
