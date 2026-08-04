# web.ts: a failing port-reclaim leaves the process alive with no listener and no retry

## Location

`src/web.ts`, lines 225-280 (the `EADDRINUSE` branch of the `server.on('error')`
handler), specifically the outer `catch (e)` at lines 274-276.

## Excerpt

```ts
server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') {
    logger.warn({ port }, 'Web port foglalt, probalok felszabaditani...')
    try {
      const pidsRaw = execSync(`lsof -ti :${port} 2>/dev/null || true`, { timeout: 3000, encoding: 'utf-8' }).trim()
      ...
    } catch (e) {
      logger.error({ err: e }, 'Port-reclaim failed')
    }
  } else {
    logger.error({ err }, 'Web szerver hiba')
  }
})
```

Every other exit from the `EADDRINUSE` branch ends in a definite outcome:
victims found -> SIGTERM, then `server.listen(...)` re-bind after 1500 ms; no
victims -> `process.exit(1)` so launchd restarts cleanly. The `catch` is the
only path that ends in neither -- it logs and returns.

## Failure scenario

1. The port is occupied at boot (the routine launchd `kickstart -k` race the
   surrounding comments describe).
2. `execSync('lsof -ti :PORT 2>/dev/null || true')` throws. Note what does NOT
   throw: a missing `lsof` binary exits 127, which `|| true` rewrites to 0, so
   that case returns "" and correctly lands on the `process.exit(1)` path. The
   throwing triggers are the ones the shell cannot mask:
   - the `timeout: 3000` fires -- `lsof` walks every process's fd and socket
     table and is routinely slow on a loaded box, and this runs during a
     restart storm, which is exactly when the box is loaded;
   - the shell itself fails to spawn (EAGAIN under fork pressure, ENOMEM, or
     no `/bin/sh` in a minimal container).
3. "Port-reclaim failed" is logged. No re-listen is scheduled and
   `process.exit` is not called.
4. The process stays alive and fully "booted": every background service below
   the listener (message router, schedule runner, channel monitors, pollers)
   is started and keeps running, but nothing is bound to the port. The
   dashboard is deaf and the supervisor sees a healthy process.

The 7-minute self-heal watchdog (lines 310-319) eventually calls
`process.exit(1)` and rescues this, so it is not a permanent outage -- but the
watchdog was sized for a SLOW BIND, not for a reclaim that already failed
definitively. The known-dead case waits the full grace instead of exiting
immediately like its sibling `victims.length === 0` path does.

## Pinning test

`src/__tests__/web-server.test.ts`:
- "EADDRINUSE reclaim > logs when the reclaim itself throws" -- makes `execSync`
  throw and asserts only the "Port-reclaim failed" log; no re-listen, no exit.
- "listener self-heal > exits(1) once the grace elapsed and the server is not
  listening" -- covers the 7-minute rescue that currently backstops it.

If the catch is changed to exit, the first test should assert
`process.exit` was called with 1.

## Suggested direction

Make the failure terminal, matching the sibling branch two lines up:

```ts
} catch (e) {
  logger.error({ err: e }, 'Port-reclaim failed -- kilepes')
  process.exit(1)
}
```

This keeps a single rule for the whole `EADDRINUSE` branch: either we know how
to reclaim the port and re-listen, or we exit and let the supervisor restart us
fresh. It does not affect the slow-bind case, which never reaches this catch.

Per the task rule "NEVER modify src/web.ts" this needs an explicit override
from the user.
