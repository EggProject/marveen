# web.ts: the not-listening watchdog survives server.close() and exits(1) afterwards

## Location

`src/web.ts`, lines 310-319 (watchdog arm) vs. lines 539-562 (`server.close` override).

## Excerpt

Armed at boot, held in no variable, never cancelled:

```ts
const STARTUP_GRACE_MS = 7 * 60 * 1000
const RELISTEN_POLL_MS = 60 * 1000
setTimeout(() => {
  setInterval(() => {
    if (!server.listening) {
      logger.error({ port }, 'Web server not listening -- exiting(1) for a clean launchd restart')
      process.exit(1)
    }
  }, RELISTEN_POLL_MS).unref()
}, STARTUP_GRACE_MS).unref()
```

The teardown override clears every OTHER interval by name, but has no handle
for the two timers above:

```ts
server.close = (cb?: (err?: Error) => void) => {
  clearInterval(routerInterval)
  clearInterval(scheduleInterval)
  ...
  clearInterval(tokenCollectInterval)
  return origClose(cb)
}
```

## Failure scenario

1. A caller closes the HTTP listener deliberately while keeping the process
   alive -- e.g. a shutdown path that drains before exiting, an in-process
   restart/rebind, or any embedding of `startWebServer` that stops serving but
   keeps doing work.
2. `server.listening` flips to `false`, which is the correct and expected
   result of the close.
3. The watchdog is still armed (both timers are `unref()`-ed, which stops them
   keeping the loop alive but does NOT stop them firing while the process is
   otherwise busy). On the next 60 s tick after the 7-minute grace it reads
   `server.listening === false`, logs "Web server not listening", and calls
   `process.exit(1)`.

The process is killed for having done exactly what it was told to do. The log
line blames a silent listener failure, so the post-mortem points at the wrong
cause.

Today `src/index.ts` is the only caller and it exits shortly after closing, so
the window is small in production -- but it is real (the exit code changes from
the intended one to 1 if the drain takes longer than the grace), and any second
caller inherits the trap.

## Pinning test

`src/__tests__/web-server.test.ts`:
"worker warm-up > leaves the listener watchdog armed after close(), which then
exits(1)" -- boots, calls `close()`, flips `listening` to false, advances 8
minutes and asserts `process.exit` was called with 1.

If the watchdog is made cancellable, that test should be inverted to assert
`exitCalls` stays empty.

## Suggested direction

Hold both handles and clear them in the close override, next to the others:

```ts
const relistenGrace = setTimeout(() => { relistenPoll = setInterval(...) }, STARTUP_GRACE_MS)
relistenGrace.unref()
...
server.close = (cb) => {
  clearTimeout(relistenGrace)
  if (relistenPoll) clearInterval(relistenPoll)
  ...
}
```

Per the task rule "NEVER modify src/web.ts" this needs an explicit override
from the user.
