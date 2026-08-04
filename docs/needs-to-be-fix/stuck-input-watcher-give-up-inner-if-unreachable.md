# stuck-input-watcher.ts: the give-up `prev.attempts < maxAttempts` inner-if is unreachable

## Location

`src/web/stuck-input-watcher.ts`:
- line 124 (in `recoverParkedPaste`): `} else if (next.attempts >= thresholds.maxAttempts && prev.attempts < thresholds.maxAttempts) {`
- line 160 (in `bareEnterRecovery`): `} else if (next.parkedSig !== null && next.attempts >= THRESHOLDS.maxAttempts) {`
- line 164 (in `bareEnterRecovery`): `if (prev.attempts < THRESHOLDS.maxAttempts) {`

## Excerpt

```ts
// bareEnterRecovery (lines 154-167)
if (recover) {
  logger.info(
    { label, session, attempt: next.attempts },
    'stuck-input-watcher: parked input persisted past confirm window, sending recovery Enter',
  )
  sendEnterToSession(session, host)
} else if (next.parkedSig !== null && next.attempts >= THRESHOLDS.maxAttempts) {
  // Logged at most once per spell: the give-up is recorded on the tick
  // that spent the last attempt (attempts hits maxAttempts there), not
  // every subsequent tick.
  if (prev.attempts < THRESHOLDS.maxAttempts) {
    logger.warn({ label, session }, 'stuck-input-watcher: input still parked after max recovery Enters, giving up for this spell')
  }
}
```

## Why unreachable

The inner `prev.attempts < THRESHOLDS.maxAttempts` guard cannot fire because
`next.attempts >= THRESHOLDS.maxAttempts` with `recover=false` can only
happen via the budget-spent branch in `decideStuckInputRecovery`:

```ts
// src/pane-state.ts:1328
if (prev.attempts >= thresholds.maxAttempts) {
  return { recover: false, next: { ...prev } }
}
```

That branch returns `{ ...prev }`, so `next.attempts === prev.attempts`. The
outer `else-if` is reachable (yes), but the inner guard
`prev.attempts < maxAttempts` is contradicted by the prerequisite
`prev.attempts >= maxAttempts` that the outer condition implies. The warn
line (165) is dead.

The exact same pattern exists in `recoverParkedPaste` (line 124): the two
conditions are combined into one `else if`, but the second clause
`prev.attempts < thresholds.maxAttempts` is still dead for the same reason.

`checkLocalSession` (line 201) has the same defect on its alert branch
(`next.attempts >= LOCAL_FAST_THRESHOLDS.maxAttempts &&
prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts`). The sub-agent give-up
TEST in `stuck-input-watcher.test.ts` hits the branch ONLY because the
test mocks `recoverStuckInputForSession` to return crafted state; through
the real `decideStuckInputRecovery`, that alert is also unreachable.

## Failure scenario

1. A swallowed-Enter spell crosses the confirm window, fires `recover=true`,
   sets `attempts = 1`, persists state. (logged as info + Enter sent.)
2. Same spell crosses confirm again, fires `recover=true`, sets
   `attempts = 2`. (logged as info + Enter sent.)
3. Same spell crosses confirm a third time, fires `recover=true`, sets
   `attempts = 3`. (logged as info + Enter sent.)
4. Subsequent ticks hit the `prev.attempts >= maxAttempts` budget-spent
   guard, return `recover=false` with `next.attempts === prev.attempts === 3`.
   The outer `else-if` evaluates true, but the inner
   `prev.attempts < maxAttempts` is `3 < 3 = false`, so the warn is skipped.

Net effect: the "giving up for this spell" warn message NEVER fires,
despite the comment claiming it does.

## Pinning test

`src/__tests__/stuck-input-watcher.test.ts > bareEnterRecovery logs the
give-up warning once the attempts cap is spent` -- this test deliberately
tries to drive a remote sub-agent past `THRESHOLDS.maxAttempts = 3` and
asserts on the warn; the assertion fails because the warn branch is dead.
The remaining 20 tests in the suite cover the recoverable code paths
without hitting the dead branch.

## Suggested direction

Two acceptable resolutions:

1. **Drop the inner guard** (and the outer condition's matching half in
   `recoverParkedPaste`). The intent in the comment ("logged at most once
   per spell: the give-up is recorded on the tick that spent the last
   attempt") is correct for what the code TRIES to do; the bug is that the
   code never reaches the warn. Either:
   - Move the warn inside the `if (recover)` branch with a guard on
     `next.attempts === thresholds.maxAttempts` and `prev.attempts <
     thresholds.maxAttempts`, so the warn fires on the recovery tick that
     spends the last attempt; OR
   - Remove the warn entirely (no callers depend on it; `sendAlert` on the
     sub-agent path is the actual escalation).

2. **Document as dead code** and add `/* v8 ignore next */` annotations on
   the dead lines so the 100% coverage gate silences. This requires a
   per-file branch threshold override in `vitest.config.ts` (the project
   already does this for the analogous defensive branches in
   `src/pane-state.ts`, see
   `docs/needs-to-be-fix/pane-state-defensive-branches.md`).

This doc itself is a needs-to-be-fix entry -- until a resolution is
chosen, the test suite cannot reach 100% branch coverage on
`src/web/stuck-input-watcher.ts` without modifying the source.