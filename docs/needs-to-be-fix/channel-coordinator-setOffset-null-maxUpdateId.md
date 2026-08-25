# channel-coordinator.ts:401 -- maxUpdateId != null setOffset FALSE branch is unreachable

## Location

`src/channel-coordinator.ts`, lines 393-401 (`runLoop` batch handoff):

```ts
if (!probeNativeChannelDown(SESSION, PROVIDER)) {
  logger.info({ batch: updates.length }, 'channel-coordinator: native recovered mid-batch, discarding + yielding (native will deliver)')
  state = 'idle'; downStreak = 0
  continue
}

const maxUpdateId = processBatch(updates)
// Persist offset ONLY after the batch is durable + handed off.
if (maxUpdateId != null) setOffset(SOURCE, maxUpdateId)
```

## Excerpt

The `if (maxUpdateId != null)` FALSE branch at line 401 is
**structurally unreachable**. `processBatch` returns `null` only when
called with an empty `updates` array. The runLoop at line 387 already
filters empty batches:

```ts
if (updates.length === 0) continue // long-poll timed out; re-loop re-checks liveness
```

before reaching `processBatch`. So `processBatch(updates)` is only
invoked with `updates.length >= 1`, which means `maxUpdateId` is the
update_id of the last iterated element -- always a number.

The defensive `if (maxUpdateId != null) setOffset(...)` is therefore
unreachable: `setOffset` is called on every non-empty batch.

## Failure scenario

v8 reports `branch 54 line=401 type=if counts=[5, 0]` -- the truthy
arm (`maxUpdateId` defined, `setOffset` called) hit 5 times across
the existing `channel-coordinator-process-batch.test.ts` and related
suites (one per non-empty batch), the falsy arm hit 0 times.

The 100% branch coverage gate fails on this file because of this dead
branch.

Options:

1. Drop the `if (maxUpdateId != null)` guard. `setOffset` is always
   called with the max update id from a non-empty batch.
2. Leave the guard (current state) as defensive insurance against a
   future refactor that might call `processBatch` from a different
   code path with a possibly-empty input.

Option (1) is the cleanest fix.

## Pinning test

`src/__tests__/channel-coordinator-process-batch.test.ts` "processBatch
branches via runLoop backfilling" drives `setOffset` with `telegram`
update ids 100, 200, 301, 400, and 555 -- five non-empty batches, all
truthy arms hit. No test exercises the falsy arm because there's no
way to call `processBatch` with an empty array through the runLoop's
public API.

## Suggested direction

Drop the guard:

```ts
const maxUpdateId = processBatch(updates)
setOffset(SOURCE, maxUpdateId)
```

The `processBatch` function should additionally be tightened to
require a non-empty input:

```ts
function processBatch(updates: { update_id: number }[]): number {
  if (updates.length === 0) throw new Error('processBatch: empty batch')
  ...
}
```

Per task rule "NEVER modify src/channel-coordinator.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
