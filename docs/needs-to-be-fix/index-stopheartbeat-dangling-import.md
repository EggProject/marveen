# index.ts -- stopHeartbeat() imported but never called from shutdown()

## Location

`src/index.ts:16` (the dangling import) and `src/index.ts:380-415` (the
`shutdown()` handler that does NOT call `stopHeartbeat()`):

```ts
// Line 16
import { initHeartbeat, stopHeartbeat } from './heartbeat.js'

// Lines 380-415
const shutdown = (): void => {
  if (shuttingDown) return
  try {
    shuttingDown = true
    logger.info('Leallitas...')
    try { stopInviteMonitor() } catch (err) { logger.warn({ err }, 'stopInviteMonitor threw during shutdown') }
    try { stopChannelRequestWatcher() } catch (err) { logger.warn({ err }, 'stopChannelRequestWatcher threw during shutdown') }
    try { stopStoreWatcher() } catch (err) { logger.warn({ err }, 'stopStoreWatcher threw during shutdown') }
    // <-- stopHeartbeat() MISSING here, despite initHeartbeat() being called in main()
```

## Excerpt

The orphan was created by commit `2e33344` (2026-08-25, "fix(index): wire
up initHeartbeat for runDecaySweep production path"). That commit correctly
recognised `initHeartbeat()` was dead code in production and wired it into
`main()` at line 488. The matching teardown -- `stopHeartbeat()` -- was
added to the import at line 16 but NOT wired into `shutdown()` at 380-415.

## Failure scenario

When Marveen shuts down (SIGTERM/SIGINT/uncaughtException), the native
heartbeat scheduler is still ticking. `src/heartbeat.ts:564-580` holds a
`setTimeout` reference in `heartbeatTimeout`; without `stopHeartbeat()`
the only path that drops it is process exit.

1. A delayed heartbeat tick can fire DURING `shutdown()`'s
   `webServer.close()` drain and execute `runAgent()` after the process
   has begun teardown. The `runAgent` call does `execFileSync` against
   `claude-agent-sdk` and can hit a hung child that delays exit past
   `SHUTDOWN_HARD_KILL_MS` (5s).
2. The opportunistic `runDecaySweep()` integration (cycle 47, commit
   `749893c`) is itself cancelled by process exit, but any in-flight
   `await notifyTelegram(text)` or `await runAgent(...)` chain inside
   `executeHeartbeat()` escapes the `try/catch` at heartbeat.ts:523-558
   and becomes an unhandled rejection during shutdown.

`stopHeartbeat()` (heartbeat.ts:593-597) is idempotent: sets
`stopped = true`, clears `heartbeatTimeout`, logs. Safe to call on every
shutdown regardless of whether `initHeartbeat()` ran.

## Pinning test

Positive pin (added): `src/__tests__/index.test.ts:1142-1148` -- "calls
stopHeartbeat on shutdown when initHeartbeat was called". Asserts
`mockStopHeartbeat` and `mockInitHeartbeat` are both called after a
SIGTERM.

Negative pin (rewritten): `src/__tests__/index.test.ts:2592-2609` --
"catches the throw and logs a warn (covers line 383)". Asserts
`mockStopHeartbeat` IS called and the warn message
"stopHeartbeat threw during shutdown" IS logged when the mock throws.

Throw-coverage pin (extended): `src/__tests__/index.test.ts:1116-1135` --
"catches stopInviteMonitor / stopChannelRequestWatcher / stopStoreWatcher
/ stopHeartbeat throws individually". All four sibling try/catch
wrappers exercised.

## Suggested direction

Insert the matching try/catch in src/index.ts:383 (between
`logger.info('Leallitas...')` and the first sibling at line 383):

```ts
try { stopHeartbeat() } catch (err) { logger.warn({ err }, 'stopHeartbeat threw during shutdown') }
```

Verbatim shape of the existing three siblings.

## Resolution

Wired 2026-08-26, <placeholder>. `src/index.ts:383` now calls `stopHeartbeat()`
inside the same try/catch wrapper pattern as `stopInviteMonitor` /
`stopChannelRequestWatcher` / `stopStoreWatcher`. Negative regression
pins at `src/__tests__/index.test.ts:1142-1148` and `:2592-2609` are
rewritten as positive pins; the throws-on-shutdown test at
`:1116-1135` is extended to cover `stopHeartbeat`. Coverage delta on
`src/index.ts`: lines / statements / branches remain at 100% (the new
catch arm is in the same try-block coverage that already gates the
siblings).

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to
the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general
project rule. The user corrected this on 2026-08-24: "never modify nem
igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is
not true as a general rule, only valid during the needs-to-be-fix
survey). Outside the baseline cycle, the referenced source file may be
modified when the fix is justified; a per-fix user override is still
required before any source edit is committed.
