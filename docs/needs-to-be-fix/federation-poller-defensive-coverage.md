# federation/poller.ts: belt catch and startFederationPoller swallow require contrived test setups

## Location

`src/web/federation/poller.ts`

## Excerpt

Two defensive code paths are reachable in production only through setups
that real callers cannot construct. To drive v8 coverage to 100% the
supplemental suite (`federation-poller-cov.test.ts`) has to either
monkey-patch `Map.prototype.set` or spy on `getFederationConfig`, both of
which violate the "exercise the public API" expectation the rest of the
suite follows.

### 1. Belt catch in `pollPeerManifests` (lines 219-226)

```ts
for (const peer of cfg.peers) {
    try {
      await pollOnePeer(peer, now, fetchImpl)
    } catch (err) {
      // Belt: one broken peer must never abort the round.
      logger.warn({ err, peer: peer.id }, 'federation poller: unexpected error')
      const prev = statusCache.get(peer.id)
      statusCache.set(peer.id, {
        id: peer.id, baseUrl: peer.baseUrl, state: 'error', lastChecked: now,
        lastOkAt: prev?.lastOkAt ?? 0, manifest: prev?.manifest, error: 'internal poll error',
      })
    }
  }
```

`pollOnePeer` try/catches every observable failure mode:
- `await fetchImpl(...)` -> network / sync throw (caught, becomes "unreachable")
- `await res.body?.cancel()` for 401/403 and 5xx (caught, becomes "auth-or-disabled" / "error")
- `await readBoundedBody(...)` -> too-large / stream error (caught, becomes "error")
- `JSON.parse(body)` -> parse error (caught, becomes "error")
- `sanitizeManifest(parsed, peer.id)` -> structural error (returns string, becomes "error")

The remaining unguarded operations are `statusCache.set(...)` (a `Map.set`,
which doesn't throw) and `sanitizeManifest(...)` (which returns a string for
every malformed input and never throws). The belt catch is therefore only
reachable if `Map.prototype.set` is monkey-patched to throw, which is what
the supplemental test does.

### 2. Inline `() => {}` in `startFederationPoller` (line 265-266)

```ts
export function startFederationPoller(): NodeJS.Timeout {
  setTimeout(() => { refreshFederationStatus().catch(() => {}) }, FEDERATION_POLL_INITIAL_DELAY_MS).unref()
  return setInterval(() => { refreshFederationStatus().catch(() => {}) }, FEDERATION_POLL_INTERVAL_MS)
}
```

The trailing `.catch(() => {})` is only invoked when `refreshFederationStatus()`
rejects. That function delegates to `pollPeerManifests`, which catches every
error from `pollOnePeer` via the belt above. The only ways to make
`refreshFederationStatus` reject are:

- `getFederationConfig()` throws -- the validator's fail-closed behavior
  already catches parse errors and returns DISABLED, so this only fires
  under a custom spy.
- `logger.warn(...)` in the belt catch throws -- pino is not in the
  controllable blast radius.

The supplemental test therefore spies on `getFederationConfig` and stubs
`setTimeout`/`setInterval` to capture-and-fire the callbacks directly (v8
fake timers abort after 10000 ticks because the real setInterval keeps
rescheduling itself).

## Failure scenario

A future contributor adding a new error path inside `pollOnePeer` and
forgetting to wrap it in try/catch will:

1. Write the new path assuming v8 coverage will catch the regression.
2. See the belt-catch line covered (it always is, by the Map monkey-patch
   test).
3. Miss that the new error path is silently swallowed by the belt catch
   AND masked in coverage by the contrived setup.

A separate contributor reading the supplemental suite may also conclude
that monkey-patching `Map.prototype.set` is the project's accepted
testing style and apply it elsewhere.

## Pinning tests

`src/__tests__/federation-poller-cov.test.ts`:

- "pollPeerManifests: belt catch on pollOnePeer throw > a throw escaping
  pollOnePeer marks the peer as 'internal poll error'" -- monkey-patches
  `Map.prototype.set` to throw on the `state: 'ok'` write.
- "pollPeerManifests: belt catch on pollOnePeer throw > one broken peer
  does not abort the round (other peers still polled)" -- same
  monkey-patch, plus a per-peer fetch to keep the second peer on the
  happy path.
- "startFederationPoller > the inline lambdas run when the timers fire
  (fake timers + rejecting refresh)" -- captures and fires the
  setTimeout/setInterval callbacks directly, plus a spy on
  `getFederationConfig` to force a rejection so the trailing
  `.catch(() => {})` fires.

## Suggested direction

Three options, in order of decreasing cost:

1. **Document the defensive nature explicitly** (cheap): add a comment
   above each path explaining the test setup it requires, so a future
   contributor does not mistake "covered by a monkey-patch" for "covered
   by a real call". This keeps the production code intact and the test
   file self-documenting.

2. **Refactor for testability** (medium): extract the belt-catch body
   into a named helper (`recordPollInternalError(peerId, now, err)`)
   that can be unit-tested directly. Same for the swallow in
   `startFederationPoller`. This makes both branches reachable through
   the public helper API instead of through Map-mutation spying.

3. **Drop the unreachable paths** (risky): remove the belt catch and
   the trailing `.catch(() => {})`. The argument: every observable
   failure mode is already handled, the inner catch is dead code, and
   the belt catch's "one broken peer must never abort the round"
   justification only matters if `pollOnePeer` ever throws -- which it
   does not, today. This is a behavior change: a future regression that
   makes `pollOnePeer` throw would now propagate as a rejected
   `pollPeerManifests` instead of being recorded as `internal poll
   error`. Against the project's "one broken peer must never abort the
   round" contract.

This doc itself is a needs-to-be-fix entry -- it should be either deleted
(if option 1 is taken and the comment lands) or acted on (if option 2
or 3 is approved).