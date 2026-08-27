# src/index.ts: three functions are unreachable from the test harness

## Resolution (2026-08-26, 642b883)

The three "unreachable" sites are all reachable as of `642b883`
(2026-08-26). Per INDEX.md the closure commit was `a330462`
(2026-08-20, "NO-OP, line 174 already covered by index.test.ts:2739-2796");
the `642b883` follow-up six days later re-wired `initHeartbeat()` into
`main()` (line 489) and removed the `if (heartbeatStarted)` gate from
`shutdown()`, which flipped the third site from "structurally
unreachable" to "reachable; pinned by index.test.ts:1116-1140, 1143-1149".
A 3-line comment at `index.ts:281-283` now explicitly documents that
`buildPidfileLockContext.log.error` is forwarder-only (interface
requirement) and "Pinned by index.test.ts:1382" (the test at L1383,
"forwards pidfile context errors to logger.error", exercises it via
mock). The headline claim of this MD is stale: **all three sites are
covered by tests in `src/__tests__/index.test.ts`**.

The Location, Excerpt, Failure scenario, and Pinning test sections below
describe the pre-642b883 state and are kept verbatim for audit
reference. Current line refs (post-642b883 + `__test_*` rename fallout):
L174 (unchanged), L286 (originally L283, +3 from `87cd76f`'s 3-line
comment), L383 (originally L382, +1 from `2e33344`'s new import).
The third site's gating `if (heartbeatStarted)` wrapper was removed
entirely; the try/catch at L383 is now unconditional inside `shutdown()`.

Refs: a330462 (initial closure, line 174 covered), 87cd76f (added
the 3-line comment at L281-283 documenting the PidfileLockContext.log.error
pin), 642b883 (re-wire `initHeartbeat()` into `main()`, drop
`heartbeatStarted` gate, add the new `try { stopHeartbeat() } catch` at
L383 in `shutdown()`).

## Location

`src/index.ts`:

1. **Line 174** -- `error: (obj, msg) => logger.error(obj, msg)` inside `buildProcessLockContext().log`
2. **Line 286** (originally L283 at MD creation; the +3 shift came from `87cd76f` adding the 3-line comment below) -- `error: (obj, msg) => logger.error(obj, msg)` inside `buildPidfileLockContext().log` (preceded by a 3-line comment at L281-283 documenting why it is forwarder-only)
3. **Line 383** (originally L382 at MD creation; the +1 shift came from `2e33344` adding the `initHeartbeat()` import, and the `if (heartbeatStarted)` wrapper was removed by `221d5c8` before `642b883` re-added the unconditional try/catch) -- `try { stopHeartbeat() } catch (err) { logger.warn(...) }` inside `shutdown()` (no longer gated by `if (heartbeatStarted)`; `initHeartbeat()` is called from `main()` at L489)

## Excerpt

```ts
// buildProcessLockContext (line 168-175, unchanged)
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
// buildPidfileLockContext (line 277-289, post-642b883)
sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
},
log: {
  // PidfileLockContext.log.error is forwarder-only: required by the interface
  // (process-lock.ts:253) but never invoked by acquirePidfileLock (info/warn
  // only at process-lock.ts:301/328/336/346/350/352). Pinned by index.test.ts:1382.
  info: (obj, msg) => logger.info(obj, msg),
  warn: (obj, msg) => logger.warn(obj, msg),
  error: (obj, msg) => logger.error(obj, msg),     // <-- line 286
},
```

```ts
// shutdown() (line 378-389, post-642b883)
const shutdown = (): void => {
  if (shuttingDown) return
  try {
    shuttingDown = true
    logger.info('Leallitas...')
    try { stopHeartbeat() } catch (err) { logger.warn({ err }, 'stopHeartbeat threw during shutdown') }   // <-- line 383, unconditional
    try { stopInviteMonitor() } catch (err) { logger.warn({ err }, 'stopInviteMonitor threw during shutdown') }
    try { stopChannelRequestWatcher() } catch (err) { logger.warn({ err }, 'stopChannelRequestWatcher threw during shutdown') }
    try { stopStoreWatcher() } catch (err) { logger.warn({ err }, 'stopStoreWatcher threw during shutdown') }
```

## Failure scenario (pre-642b883, kept verbatim for audit reference)

Coverage at the time of this MD's filing: 97.4% statements, 95.23%
branches, 96.07% functions, 98.66% lines. The CI gate (`vitest.config.ts`
thresholds lines/functions/branches/statements at 100% for every
`src/*.ts`) reported this file as under-covered.

1. **buildProcessLockContext.log.error (line 174)** -- `ctx.log.error` is
   only called from `process-lock.ts` `acquirePortLock`'s
   `terminateProcesses` path when `ctx.signal(pid, 'SIGKILL')` throws a
   non-ESRCH error. **Closed by `a330462`** (2026-08-20): covered via the
   SIGKILL-fails-EPERM path at `index.test.ts:2737-2741`.

2. **buildPidfileLockContext.log.error (line 286, was L283 at MD creation
   -- the +3 shift came from `87cd76f` adding the 3-line comment below)**
   -- `process-lock.ts` `acquirePidfileLock` only calls `ctx.log.warn` and
   `ctx.log.info` (see lines 301/328/336/346/350/352). It never calls
   `ctx.log.error` in production. **Closed by `642b883`** (2026-08-26):
   the comment at L281-283 documents the pin explicitly, and the test at
   `index.test.ts:1383-1390` ("forwards pidfile context errors to
   logger.error") exercises it via mock.

3. **stopHeartbeat throw at line 383 (originally L382 at MD creation;
   the `if (heartbeatStarted)` wrapper was removed by `221d5c8` on
   2026-08-16, then `642b883` re-added the unconditional try/catch at
   L383)** -- `heartbeatStarted` was
   a module-scoped variable in `index.ts` set ONLY by `initHeartbeat()`
   inside `main()`. `main()` no longer called `initHeartbeat()` at the
   time of the MD's filing; the `if (heartbeatStarted)` branch was
   permanently false. **Closed by `642b883`** (2026-08-26): `main()` now
   calls `initHeartbeat()` at L489, the `if (heartbeatStarted)` wrapper
   was removed, and the try/catch at L383 is now unconditional. The test
   at `index.test.ts:1116-1140` ("catches stopInviteMonitor /
   stopChannelRequestWatcher / stopStoreWatcher / stopHeartbeat throws
   individually") exercises it via mock. The "positive pin" test at
   `index.test.ts:1142-...` ("calls stopHeartbeat on shutdown when
   initHeartbeat was called") verifies the happy-path call.

## Pinning test (post-642b883, current state)

`src/__tests__/index.test.ts` exercises all three sites:

- `buildProcessLockContext.log.error` (line 174) -- covered by the
  SIGKILL-fails-EPERM path at `index.test.ts:2737-2741`
  (`describe('buildProcessLockContext.log and sleep via real
  acquirePortLock', ...)`).
- `buildPidfileLockContext.log.error` (line 286, originally L283) -- covered by
  `index.test.ts:1383-1390` (`it('forwards pidfile context errors to
  logger.error', ...)`). The comment at `index.ts:281-283` explicitly
  names this test as the pin.
- `shutdown()` stopHeartbeat catch (line 383, originally L382 at MD
  creation; the `if (heartbeatStarted)` wrapper was removed by `221d5c8`
  on 2026-08-16, then `642b883` re-added the unconditional try/catch at
  L383) -- covered by
  `index.test.ts:1116-1140` (the 4-stop throws-individually test asserts
  the catch wrapper fires for `stopHeartbeat`) AND the positive pin at
  `index.test.ts:1143-1149` (asserts `stopHeartbeat` is called on shutdown
  when `initHeartbeat` was called).

```ts
// Current pin (line 383 stopHeartbeat wrapper is reached):
it('catches stopInviteMonitor / stopChannelRequestWatcher / stopStoreWatcher / stopHeartbeat throws individually', async () => {
  mockStopHeartbeat.mockImplementation(() => { throw new Error('hb') })
  ...
  expect(mockLogger.warn).toHaveBeenCalledWith(
    expect.objectContaining({}),
    expect.stringContaining('stopHeartbeat threw'),
  )
})

// Positive pin (line 1142-...):
it('calls stopHeartbeat on shutdown when initHeartbeat was called', async () => { ... })
```

## Suggested direction (superseded by 642b883)

The three options were:

1. **Remove the dead code** -- `buildPidfileLockContext.log.error` and
   `shutdown()`'s `if (heartbeatStarted)` block. Removing them would
   bring `src/index.ts` to 100% without test changes.

2. **Export the helpers** -- `buildProcessLockContext` /
   `buildPidfileLockContext`. Exporting would let a unit test construct
   the ctx directly and call each `ctx.log.*` / `ctx.sleep` method,
   reaching 100% without depending on `acquirePortLock` /
   `acquirePidfileLock`'s side-effect paths.

3. **Wire `heartbeatStarted = true`** -- if `initHeartbeat()` were still
   called in `main()`, the `shutdown()` catch wrapper at line 383 would
   be exercisable. Restoring that wiring (and accompanying test mocks for
   `initHeartbeat` / `stopHeartbeat`) would close the gap.

**Outcome (2026-08-26, 642b883): option 3 was applied** (`initHeartbeat()`
called from `main()` at L489), option 1 was partially applied (the
`if (heartbeatStarted)` wrapper was removed; `buildPidfileLockContext.log.error`
was kept as a forwarder for the interface and documented via comment
+ pin test). No further action required.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
