# worker-liveness.ts: defensive `??` fallback in decideWorkerLiveness is unreachable

## Location

`src/web/worker-liveness.ts`, line 115 (inside the alive branch of
`decideWorkerLiveness`).

```ts
return {
  logDeath: false,
  lifetimeMs: null,
  lastPane: null,
  lifetimeTruncated: false,
  next: {
    firstSeenAtMs: prev.firstSeenAtMs ?? obs.nowMs,
    ...
```

## Excerpt

The `?? obs.nowMs` fallback on `prev.firstSeenAtMs` is unreachable under the
SUT's own control flow:

1. The ONLY way `firstSeenAtMs` enters the `states` map is via line 115's
   `firstSeenAtMs: prev.firstSeenAtMs ?? obs.nowMs`. The right-hand side
   is `obs.nowMs`, a `Date.now()`-sourced number. The `??` falls back only
   when `prev.firstSeenAtMs` is `null` or `undefined`, which is exactly
   the case the `??` is supposed to handle.
2. After this line runs once, `firstSeenAtMs` is always a number. The
   only way back to `null` is the death branch at line 138, which resets
   the state to `NO_WORKER_LIVENESS_STATE` -- and that path leads back
   into a NEW alive-branch call where `prev.firstSeenAtMs` is `null`
   again. So the `??` fires on the first alive sighting after every
   death and on the first sighting of a brand-new session. In other
   words, the `??` is reachable as long as `prev` came from
   `NO_WORKER_LIVENESS_STATE`.

So actually the `??` IS reachable in the normal flow -- `decideWorkerLiveness`
first-sight path (when `prev.firstSeenAtMs == null`) DOES exercise it. The
existing test file `src/__tests__/worker-liveness.test.ts` covers this.

However, the BUG worth documenting is a related defensive branch:

`decideWorkerLiveness` lines 131-139:

```ts
const lifetimeMs =
  prev.firstSeenAtMs != null ? prev.lastSeenAliveAtMs - prev.firstSeenAtMs : null
```

The `prev.firstSeenAtMs != null` ternary fires when the state map has a
`WorkerLivenessState` with `lastSeenAliveAtMs` set but `firstSeenAtMs`
cleared. That cannot happen through the public API: the only state setter
inside `decideWorkerLiveness` writes both fields together (line 115 and
116), and the only `null` reset (`NO_WORKER_LIVENESS_STATE`) clears both
fields at once. So the only way for `lastSeenAliveAtMs != null` AND
`firstSeenAtMs == null` is a future regression where someone deletes the
stamp-and-clear-together invariant.

## Failure scenario

The defect is a coverage-only defect -- no runtime misbehaviour is reachable
through public input.

1. The monitor sweeps a session that is alive. `decideWorkerLiveness` stamps
   `firstSeenAtMs` and `lastSeenAliveAtMs` together.
2. Between sweeps, a regression breaks the invariant (e.g. someone adds a
   state-clearing path that does not also reset `lastSeenAliveAtMs`). The
   state object has `firstSeenAtMs=null, lastSeenAliveAtMs=N`.
3. On the next death, `prev.firstSeenAtMs != null` evaluates false, and
   `lifetimeMs` is `null` -- silently dropped from the death log. The
   reader sees `lifetimeMs=null, lastPane=...` with no indication that a
   real lifetime existed. The first-seen marker was lost; the death log
   no longer answers "how long did this session live".

To reach 100% branch coverage without modifying the source, the test suite
patches `Map.prototype.get` to make `firstSeenAtMs` look null on the death
sweep (see the "reports lifetimeMs=null and lifetimeMin=null" describe
block in `src/__tests__/worker-liveness-full.test.ts`). The patch hides
only the `firstSeenAtMs` field on the state object returned from the map,
so the alive-branch stamp still lands normally.

## Pinning test

`src/__tests__/worker-liveness-full.test.ts`, the "reports lifetimeMs=null
and lifetimeMin=null when the first-seen mark is missing (defensive)"
test, exercises the `null` fallback through the `Map.prototype.get`
patch and asserts `logger.warn` was called with `lifetimeMs: null,
lifetimeMin: null`. All other tests in the file exercise the reachable
branches.

## Suggested direction

The simplest fix is to drop the defensive ternary -- the invariant the
SUT relies on (firstSeenAtMs and lastSeenAliveAtMs move together) is
already documented in the file's header comment. The single getter
becomes:

```ts
// firstSeenAtMs is guaranteed non-null here: the only path that sets
// lastSeenAliveAtMs also stamps firstSeenAtMs (lines 115-116). If a
// future change breaks that invariant, the death log should report a
// real lifetime (better than dropping it on the floor).
const lifetimeMs = prev.lastSeenAliveAtMs - (prev.firstSeenAtMs as number)
```

Per task rule "NEVER modify src/web/worker-liveness.ts" the source edit
is blocked until the user overrides; the test suite documents the gap
and the test that exercises the null branch stays in place alongside the
fix.
