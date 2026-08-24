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

## Resolution (cycle 32, **DEPRECATED** -- do not apply)

> **WARNING -- DO NOT REVERT TO THIS APPROACH.**
>
> The cycle 32 commit `1e58ebd` is **superseded** by the per-spell gate
> resolution below (`## Resolution`, commit `edae3f1` + `53490cd` +
> `f47a60f`). The cycle 32 fix removed only the inner guard without
> adding a per-spell gate, which caused `sendAlert` (the sub-agent
> escalation path) to fire on **every tick** of a stuck spell, at
> roughly 15s intervals, for the full duration of the spell -- that is
> user-facing Telegram/Slack notification spam. Reverting to this
> resolution re-introduces the spam regression.
>
> **Use the `## Resolution` (per-spell gate) approach below.**

This MD was originally resolved by cycle 32 commit `1e58ebd` (test/baseline,
"fix(stuck-input-watcher): drop dead prev-attempts guards in three recovery
branches") which simply removed the inner `prev.attempts < X.maxAttempts`
clause at all three sites. The MD correctly identified the inner guard as
structurally dead, but it failed to flag a critical side effect: once the
inner guard is removed, the outer `else-if` body becomes a regression
vector. The dead-guard removal alone caused `sendAlert` (the sub-agent
escalation path) to fire on EVERY tick of a stuck spell, at roughly 15s
intervals, for the full duration of the spell. That is user-facing
Telegram/Slack notification spam. The cycle 32 fix was therefore unsafe.
It is superseded by the per-spell gate resolution below.

## Resolution

**Date:** 2026-08-19
**Fixed-by:** `edae3f1` (Phase 2+3 fix), `53490cd` (Phase 4 regression test)
**Phase 1 prep:** `f47a60f` (added `giveUpAlerted` flag to `StuckInputState`)

The fix does NOT revert to the dead inner guard. It introduces a per-spell
gate so the alert fires exactly once per stuck spell, regardless of how
many ticks the spell spans:

- `StuckInputState` gains an optional `giveUpAlerted: boolean` field,
  initialised to `false` in `NO_STATE` (Phase 1, commit `f47a60f`).
- All three recovery sites (`recoverParkedPaste`, `bareEnterRecovery`,
  `checkLocalSession`) read the flag before sending the warn/alert and
  set it to `true` after the first send. Subsequent ticks of the SAME
  spell are silent.
- The flag resets on spell-end automatically because every new spell
  starts from a fresh `NO_STATE` (which has `giveUpAlerted: false`),
  so the next spell gets exactly one alert again.
- Tripwire comments are added at all 3 sites documenting the per-spell
  intent, so a future cycle cannot silently regress this back to
  "fire on every tick".

**Regression test (Phase 4, commit `53490cd`):**
`src/__tests__/stuck-input-watcher.test.ts` line 548 (`it('keeps the
give-up alert to exactly once across 6+ ticks of the SAME spell (real
decideStuckInputRecovery)', ...)`). The test deliberately diverges from
the existing `a give-up is alerted exactly once per spell` test (which is
a tautology because it queues `NO_STATE -> stuck -> NO_STATE -> stuck`,
i.e. two SEPARATE spells). The new test routes the watcher's
`recoverStuckInputForSession` call through the REAL `decideStuckInputRecovery`
from `pane-state.ts` and parks the same pane text across all ticks so the
spell truly spans 6+ ticks. Without the per-spell gate, `sendAlert` would
fire 5+ times; with the gate it fires exactly once.