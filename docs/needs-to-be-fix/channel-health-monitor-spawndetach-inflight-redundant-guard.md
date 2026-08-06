# channel-health-monitor.ts: spawnDetachedReconnect's in-flight guard is unreachable through public API

## Location

`src/web/channel-health-monitor.ts`, line 27 inside `spawnDetachedReconnect`:

```ts
function spawnDetachedReconnect(agentName: string): boolean {
  if (inFlightReconnects.has(agentName)) return false        // line 27
  inFlightReconnects.add(agentName)
  try {
    const child = spawn(process.execPath, [RECONNECT_CLI, agentName], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.once('exit', () => inFlightReconnects.delete(agentName))
    child.once('error', (err) => {
      inFlightReconnects.delete(agentName)
      logger.warn({ agentName, err }, 'channel-health-monitor: failed to spawn reconnect worker')
    })
    child.unref()
    return true
  } catch (err) {
    inFlightReconnects.delete(agentName)
    logger.warn({ agentName, err }, 'channel-health-monitor: reconnect spawn threw')
    return false
  }
}
```

## Excerpt

The `if (inFlightReconnects.has(agentName)) return false` guard is
**structurally unreachable** through the public API. `spawnDetachedReconnect`
has exactly one caller inside the module -- `checkAgent`, line 133:

```ts
const attempt = state ? state.attempts : 0
if (inFlightReconnects.has(agentName)) {                       // line 122
  logger.debug({ agentName, attempt }, 'channel-health-monitor: reconnect already in flight, skipping')
  return
}
logger.warn({...}, 'channel-health-monitor: plugin failure detected, spawning detached reconnect')

spawnDetachedReconnect(agentName)                              // line 133
```

The line-122 check in `checkAgent` and the line-27 check in
`spawnDetachedReconnect` read the same `inFlightReconnects` Set. So by the
time `spawnDetachedReconnect` runs at line 133, the line-122 guard has
already returned when the set contained `agentName` -- and the only way to
reach line 133 is when the set did NOT contain `agentName` (or the entry
was deleted in between, which the single-threaded event loop prevents
between lines 122 and 133). The line-27 truthy arm is therefore dead.

## Failure scenario

A reviewer (or coverage gate) notices the dead branch and either:

1. Removes it as dead code (safe one-line source change).
2. Adds a white-box test that directly invokes `spawnDetachedReconnect` while
   `inFlightReconnects` already contains the agent -- but the Set and the
   function are module-private, so the test cannot reach them without
   exporting or mocking the module.
3. Leaves it in place and accepts a coverage gap of one branch.

Option (1) is the correct fix; option (2) is a structural impossibility
from the test API; option (3) is what is checked in today.

The branch is reachable only from a path that bypasses `checkAgent`'s
line-122 guard (e.g. a future second caller that does its own bookkeeping
and forgets the dedup). If a second caller is added later, the line-27
check becomes load-bearing again and removing it would be a regression --
so the dead branch is also a forward-compat tripwire.

## Pinning test

`src/__tests__/channel-health-monitor.test.ts`. The reachable sibling is
covered so the gap is exactly the line-27 truthy arm:

- `describe('checkAgent -- via startChannelHealthMonitor tick')` ->
  "skips an in-flight reconnect and logs debug instead of spawning again"
  asserts `logger.debug({...}, 'channel-health-monitor: reconnect already
  in flight, skipping')` after a second tick while the detached child has
  not emitted `exit`. That exercises `checkAgent`'s line-122 guard and
  proves the set contains `agentName` *during the dedup window* -- but the
  test never reaches the line-27 check because `checkAgent` returned
  before calling `spawnDetachedReconnect`.
- `describe('spawnDetachedReconnect (via checkAgent in-flight path)')` ->
  "removes the agent from the in-flight set when the detached child
  exits" exercises the `child.once('exit', ...)` arm that drops the agent
  from the set -- which is the only mechanism by which the line-27
  condition could ever become true on a subsequent `spawnDetachedReconnect`
  call from `checkAgent`. The test confirms the set drains on exit; it
  cannot exercise line-27 directly.

If the redundant guard is removed, the existing test assertions remain
true and the coverage gate is satisfied.

## Suggested direction

Drop the dead arm:

```ts
function spawnDetachedReconnect(agentName: string): boolean {
  inFlightReconnects.add(agentName)
  try {
    const child = spawn(process.execPath, [RECONNECT_CLI, agentName], {
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    child.once('exit', () => inFlightReconnects.delete(agentName))
    child.once('error', (err) => {
      inFlightReconnects.delete(agentName)
      logger.warn({ agentName, err }, 'channel-health-monitor: failed to spawn reconnect worker')
    })
    child.unref()
    return true
  } catch (err) {
    inFlightReconnects.delete(agentName)
    logger.warn({ agentName, err }, 'channel-health-monitor: reconnect spawn threw')
    return false
  }
}
```

If a future second caller appears (e.g. an out-of-band reconnect path
that does its own dedup), the guard can be re-added alongside that caller
with a corresponding test.

Per task rule "NEVER modify src/" the source edit is blocked until the
user overrides; the test suite documents the gap and pins every reachable
sibling branch.