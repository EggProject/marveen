# channel-coordinator.ts: unreachable branches block 100% branch coverage

## Location

`src/channel-coordinator.ts`, line 401 (inside `runLoop`'s backfilling state):

```ts
const maxUpdateId = processBatch(updates)
// Persist offset ONLY after the batch is durable + handed off.
if (maxUpdateId != null) setOffset(SOURCE, maxUpdateId)
```

## Excerpt

`processBatch(updates)` (lines 233-258) always returns a non-null
`maxUpdateId` whenever it is called, because:

1. The runLoop guards `processBatch` with `if (updates.length === 0) continue`
   on line 387, so `processBatch` is only invoked with a non-empty `updates`
   array.
2. Inside `processBatch`, the first statement of the `for (const raw of updates)`
   loop unconditionally sets `maxUpdateId` to `raw.update_id` (the
   `maxUpdateId == null ? raw.update_id : Math.max(...)` line 236). It runs on
   every iteration regardless of how the rest of the body behaves
   (mapUpdate null, insert throws, dedup, handoff throws, etc.).

The combination of (1) and (2) makes the `else` branch
(`maxUpdateId != null` is false) unreachable in the current source.

## Failure scenario

The 100%-branch-coverage threshold configured in `vitest.config.ts`
(`coverage.thresholds.branches = 100`) fails on this file because the
unreachable branch remains uncounted.

```
...coordinator.ts |     100 |    99.15 |     100 |     100 | 401
```

Statements/lines/functions are all 100%. Only branches is 99.15%, with the
single missing branch at line 401.

## Observed impact

- **Coverage gate fails.** `npx vitest run --coverage` for
  `src/channel-coordinator.ts`: 100% statements, 100% lines, 100%
  functions, 99.15% branches. Required: 100% per the project default.
- **No runtime defect.** The unreachable `else` branch is dead code left
  over from defensive programming intent; it can never be taken with the
  current control flow.
- **Pin coverage tests** assert CURRENT behaviour (setOffset called for every
  non-empty batch, never skipped) and pass.

## Pinning tests

- `src/__tests__/channel-coordinator-process-batch.test.ts` covers every
  `processBatch` branch (mapUpdate null, insert throws, dedup, happy
  multi-event, handoff throws) and verifies `setOffset` is called for each
  non-empty batch.
- `src/__tests__/channel-coordinator-runloop-extra.test.ts` covers every
  `runLoop` backfilling state branch (yield-to-native, empty-batch loop,
  yield-before-handoff, inner break, getUpdates fatal/conflict/rate_limit/
  transient, sendAlert happy path + error path).
- `src/__tests__/channel-coordinator-reconcile.test.ts` covers every
  `reconcilePending` branch (query error, JSON.parse catch, null meta,
  createHandoffMessage throw).
- `src/__tests__/channel-coordinator-bootstrap-extra.test.ts` covers every
  `readToken` branch (env, .env quoted/single-quoted/unquoted, non-matching
  keys, no-eq lines) and the down-streak-reset branch.
- `src/__tests__/channel-coordinator-lock-live-pid.test.ts` covers the
  acquireSingleInstanceLock live-pid branch (lines 150-151).

Every executable statement is exercised; every branch EXCEPT the unreachable
`else` on line 401 is exercised.

## Suggested direction

Three acceptable resolutions (in order of preference):

1. **Remove the dead conditional.** Replace
   `if (maxUpdateId != null) setOffset(SOURCE, maxUpdateId)` with the
   unconditional `setOffset(SOURCE, maxUpdateId)`. The type is
   `number | null`; with the new invariant that `processBatch` always
   returns a number on the only path that reaches this code, the null
   branch is gone and 100% branch coverage is achievable. Lowest-risk
   resolution: it removes an unconditional check, so the call becomes
   strictly more straightforward.

2. **Re-type `processBatch` to return `number`.** Once the contract is
   that `processBatch` returns a number (never null), the call site can
   drop the conditional entirely. Combined with (1), this is the cleanest
   resolution.

3. **Exclude `src/channel-coordinator.ts` from the branch-coverage gate**
   (the original recommendation in
   `channel-coordinator-internals-untestable.md`). Accept that 99.15%
   branches is the achievable ceiling without source modifications.

Per task rule "NEVER modify src/channel-coordinator.ts" neither fix has been
applied; the test suite is the highest achievable without source changes
(100% statements, 100% lines, 100% functions, 99.15% branches).

## Resolution

MD retired; the source code was already simplified in an earlier
commit. `src/channel-coordinator.ts:399-401` now reads
`const maxUpdateId = processBatch(updates)` followed by an
unconditional `setOffset(SOURCE, maxUpdateId)` -- the
`if (maxUpdateId != null)` guard and the unreachable else branch
that this MD documented are gone. The dead conditional flagged at
line 401 no longer exists, so this defect is no longer reachable.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
