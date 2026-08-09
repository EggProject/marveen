# index.ts:382 -- stopHeartbeat-throws-during-shutdown catch is unreachable

## Location

`src/index.ts`, lines 376-396 (`shutdown` handler):

```ts
const shutdown = (): void => {
  if (shuttingDown) return
  try {
    shuttingDown = true
    logger.info('Leallitas...')
    if (heartbeatStarted) {
      try { stopHeartbeat() } catch (err) { logger.warn({ err }, 'stopHeartbeat threw during shutdown') }
    }
    try { stopInviteMonitor() } catch (err) { logger.warn({ err }, 'stopInviteMonitor threw during shutdown') }
    try { stopChannelRequestWatcher() } catch (err) { logger.warn({ err }, 'stopChannelRequestWatcher threw during shutdown') }
    try { stopStoreWatcher() } catch (err) { logger.warn({ err }, 'stopStoreWatcher threw during shutdown') }
    ...
```

## Excerpt

The `try { stopHeartbeat() } catch (err)` block at line 382 is
**structurally unreachable**. The `heartbeatStarted` module-scoped
flag is only flipped to `true` by a code path that no longer exists
in `main()`:

- `heartbeatStarted = true` was assigned inside the heartbeat-scaffold
  setup block that was retired (the heartbeat agent is now channel-less,
  started through the regular agent-process path, not via a separate
  initHeartbeat bootstrap).
- `main()` does NOT call `initHeartbeat` (the retired entry point), so
  the flag stays `false` through normal init and shutdown.
- The defensive `if (heartbeatStarted)` guard at line 380 short-circuits
  before `stopHeartbeat()` is ever called, so the try/catch at line 382
  never executes.

The same defensive pattern was added in 2026-04 when `initHeartbeat`
was still called from `main()`, then became dead code when the call
was removed.

## Failure scenario

v8 reports the branch at line 382 as `counts=[0, 0]` (or close to it)
because the surrounding `if (heartbeatStarted)` gate prevents the
catch from firing. The 100% branch coverage gate fails on `index.ts`
because of this dead branch.

The existing `index.test.ts` test "handles stopHeartbeat throwing
(heartbeatStarted true branch)" documents this:
"heartbeatStarted is module-scoped and only set via initHeartbeat() being
called -- which main() does NOT do. So the `if (heartbeatStarted)`
branch is unreachable in current code."

A reviewer has three options:

1. Delete the `if (heartbeatStarted) { try { stopHeartbeat() } catch ... }`
   block entirely -- the function `stopHeartbeat` is never called, so
   its wrapper has no purpose.
2. Restore the original `main()` call to `initHeartbeat()` so
   `heartbeatStarted` flips to true and the catch becomes reachable.
3. Leave the dead block (current state) and add a pinning test that
   forces `heartbeatStarted` to true via a vi.spyOn on the module
   internals -- requires `vi.resetModules` and re-import gymnastics.

Option (1) is the cleanest fix.

## Pinning test

`src/__tests__/index.test.ts` has a test "handles stopHeartbeat
throwing (heartbeatStarted true branch)" that documents the
unreachable branch in its comment block. The test asserts that
`mockStopHeartbeat` is NOT called (because `heartbeatStarted` is
false), so it pins the CURRENT behavior.

## Suggested direction

Delete the dead block:

```ts
if (heartbeatStarted) {
  try { stopHeartbeat() } catch (err) { logger.warn({ err }, 'stopHeartbeat threw during shutdown') }
}
```

If a future code change reintroduces `initHeartbeat()` to `main()`,
the block can be re-added with the corresponding flip.

Per task rule "NEVER modify src/index.ts" this requires an explicit
override from the user.