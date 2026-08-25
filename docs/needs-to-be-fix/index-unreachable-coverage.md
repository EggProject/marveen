# src/index.ts: three functions are unreachable from the test harness

## Location

`src/index.ts`:

1. **Line 174** — `error: (obj, msg) => logger.error(obj, msg)` inside `buildProcessLockContext().log`
2. **Line 283** — `error: (obj, msg) => logger.error(obj, msg)` inside `buildPidfileLockContext().log`
3. **Line 382** — `try { stopHeartbeat() } catch (err) { logger.warn(...) }` inside `shutdown()`

## Excerpt

```ts
// buildProcessLockContext (line 168-175)
sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
},
log: {
  info: (obj, msg) => logger.info(obj, msg),
  warn: (obj, msg) => logger.warn(obj, msg),
  error: (obj, msg) => logger.error(obj, msg),     // <-- line 174
},
```

```ts
// buildPidfileLockContext (line 277-285)
sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
},
log: {
  info: (obj, msg) => logger.info(obj, msg),
  warn: (obj, msg) => logger.warn(obj, msg),
  error: (obj, msg) => logger.error(obj, msg),     // <-- line 283
},
```

```ts
// shutdown() (line 376-416)
if (heartbeatStarted) {
  try { stopHeartbeat() } catch (err) { logger.warn({ err }, 'stopHeartbeat threw during shutdown') }   // <-- line 382
}
```

## Failure scenario

Coverage: 97.4% statements, 95.23% branches, 96.07% functions, 98.66% lines.
The CI gate (`vitest.config.ts` thresholds lines/functions/branches/statements at 100% for every `src/*.ts`) reports this file as under-covered even though every reachable behaviour is tested.

1. **buildProcessLockContext.log.error (line 174)** — `ctx.log.error` is only called from `process-lock.ts` `acquirePortLock`'s `terminateProcesses` path when `ctx.signal(pid, 'SIGKILL')` throws a non-ESRCH error. The test harness mocks `process.kill` per-test but the SIGKILL-fail path is gated behind `ctx.sleep(graceMs)` (default 1500ms) which the captured-timeouts stub never resolves; advancing fake timers synchronously cannot recover the SIGKILL escalation because the rest of the suite relies on the captured-timeouts mechanism to keep tests fast.

2. **buildPidfileLockContext.log.error (line 283)** — `process-lock.ts` `acquirePidfileLock` only calls `ctx.log.warn` and `ctx.log.info` (see lines 301/328/336/346/350/352). It never calls `ctx.log.error`. The `buildPidfileLockContext.log.error` function is unreachable from any caller.

3. **stopHeartbeat throw at line 382** — `heartbeatStarted` is a module-scoped variable in `index.ts` that is set ONLY by an `initHeartbeat()` call inside `main()`. `main()` no longer calls `initHeartbeat()` (it was retired in commit history; the heartbeat sub-agent now handles the heartbeat via its own scheduled-task runner). The `if (heartbeatStarted)` branch is permanently false; `stopHeartbeat()` is never invoked from `shutdown()`; the catch wrapper at line 382 is unreachable.

## Pinning test

`src/__tests__/index.test.ts` already exercises every reachable branch:
- `buildProcessLockContext.log.info` and `.warn` are covered via the SIGTERM/sigterm paths of `acquirePidfileLock`
- `buildPidfileLockContext.log.info` and `.warn` are covered via the "Pidfile lock acquired" / "Pidfile references dead PID" / "alive but not a dashboard" / "Pidfile held by legitimate peer, deferring" / "sending SIGTERM" branches
- `shutdown()` catch wrappers for `stopInviteMonitor`, `stopChannelRequestWatcher`, `stopStoreWatcher` are covered; only `stopHeartbeat`'s wrapper is unreachable because `heartbeatStarted` is never true.

```ts
// Pinning assertion (the catch wrapper at line 382 is never reached):
it('catches stopInviteMonitor / stopChannelRequestWatcher / stopStoreWatcher throws individually', async () => {
  // ... passes for the three reachable catches ...
  // No equivalent test exists for stopHeartbeat because the `if` is unreachable.
  expect(mockStopHeartbeat).not.toHaveBeenCalled() // heartbeatStarted is false
})
```

## Suggested direction

Either:
1. **Remove the dead code** — `buildPidfileLockContext.log.error` (line 283) and `shutdown()`'s `if (heartbeatStarted)` block (lines 381-383) are unreachable. Removing them brings `src/index.ts` to 100% without any test changes.

2. **Export the helpers** — `buildProcessLockContext` / `buildPidfileLockContext` are not exported. Exporting them would let a unit test construct the ctx directly and call each `ctx.log.*` / `ctx.sleep` method, reaching 100% without depending on `acquirePortLock` / `acquirePidfileLock`'s side-effect paths.

3. **Wire `heartbeatStarted = true`** — if `initHeartbeat()` were still called in `main()`, the `shutdown()` catch wrapper at line 382 would be exercisable. Restoring that wiring (and accompanying test mocks for `initHeartbeat` / `stopHeartbeat`) would close the gap.

Per task rule "NEVER modify src/index.ts" all three are blocked until the user overrides; the test suite documents the gap and the pinning case above should be added alongside the fix.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
