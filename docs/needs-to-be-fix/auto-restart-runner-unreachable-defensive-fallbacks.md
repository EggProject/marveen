# auto-restart-runner.ts: two `??` fallbacks are unreachable defensive code

## Location

`src/web/auto-restart-runner.ts`, lines 51 and 131.

```ts
// line 51, inside computeDueAt
const base = lastRestart.get(name) ?? nowMs

// line 131, inside checkAgent
if (!restartDue(lastRestart.get(name) ?? null, nowMs, dueAt)) return
```

## Excerpt

The two `??` operators are defensive nullish-coalescing fallbacks for
`lastRestart.get(name)`. They are unreachable under the SUT's own control
flow:

1. `checkAgent` (line 124) gates the call to `computeDueAt` behind
   `lastRestart.has(name)`. If `has(name)` is false the runner takes the
   seed branch (`lastRestart.set(name, nowMs); return`) and never calls
   `computeDueAt`.
2. The only call to `lastRestart.set` is in the seed branch, and the value
   is `nowMs = Date.now()` -- a positive number. `delete` is only invoked
   in the `enabled=false` branch (line 109), which also returns before
   reaching `computeDueAt`.

So whenever `computeDueAt` and the line 131 `restartDue` call run,
`lastRestart.has(name)` is true and `lastRestart.get(name)` is the seeded
number. Neither fallback can fire through the public API.

## Failure scenario

The defect is a coverage-only defect -- no runtime misbehaviour is reachable
through public input.

1. A caller drives a sweep where the agent's config enables the runner
   and the interval has elapsed.
2. `checkAgent` sees `lastRestart.has(name) = true`, calls `computeDueAt`.
3. `lastRestart.get(name)` returns the seeded number; the `?? nowMs`
   fallback never fires.
4. The same call chain reaches line 131's `restartDue`, again with
   `lastRestart.get(name)` returning the seeded number; the `?? null`
   fallback never fires.
5. v8 reports both branches as uncovered even though every reachable
   behaviour is tested.

To reach 100% branch coverage without modifying the source, the test suite
has to patch `Map.prototype.get` to return `undefined` so the `??`
fallbacks become runnable (see the "unreachable ?? fallback coverage"
describe block at the bottom of `src/__tests__/auto-restart-runner.test.ts`).
The seed path uses `.has`, not `.get`, so the seed still lands normally
and the patched test verifies the runner does not crash on a missing
entry. With the fallback active, `dueAt = nowMs + intervalHours` -- strictly
in the future from `nowMs`'s perspective -- so `restartDue` returns false
and no restart is issued. This is observable behaviour, not a workaround:
if the unreachable branches ever DID fire in production, the runner would
silently skip the restart (and the next sweep would compute a fresh
`dueAt`, which would then be in the past, so the restart would finally
fire then).

## Pinning test

`src/__tests__/auto-restart-runner.test.ts`, the "unreachable ?? fallback
coverage" describe block, exercises both fallbacks via the
`Map.prototype.get` patch and asserts no restart fires (because the
fallback puts `dueAt` in the future). All other tests in the file
exercise the reachable branches.

## Suggested direction

Either of two equally good fixes; the second is preferred because it
preserves the type contract and removes the `??` operator altogether.

(a) Hoist the seed-or-due decision into one place. Replace lines 50-53 and
    129-131 with a single helper that takes the seeded time as a parameter:

    ```ts
    function computeDueAt(cfg: AutoRestartConfig, lastRestartMs: number, nowMs: number): number | null {
      if (cfg.dailyTime) {
        const mins = parseHHMM(cfg.dailyTime)
        if (mins === null) return null
        return dailyDueAtMs(localMidnightMs(nowMs), mins)
      }
      if (cfg.intervalHours) {
        return lastRestartMs + cfg.intervalHours * 3_600_000
      }
      return null
    }

    // ... and in checkAgent:
    const seededAt = lastRestart.get(name)
    if (seededAt == null) {
      lastRestart.set(name, nowMs)
      return
    }
    const dueAt = computeDueAt(cfg, seededAt, nowMs)
    if (dueAt === null) return
    if (!restartDue(seededAt, nowMs, dueAt)) return
    ```

    The single `get` happens in `checkAgent`, the result is named
    `seededAt`, and both `??` operators disappear.

(b) Leave the structure as-is and add a `seededAt = lastRestart.get(name)!
    ` non-null assertion at line 129. This documents the invariant that
    `has(name) === true` at that point, lets the dead branches fall off
    the coverage chart, and removes a real confusion for any future reader
    who wonders "what if the map got cleared?". The `??` in
    `computeDueAt` still needs to go (no equivalent non-null assertion is
    valid there because `computeDueAt` could conceivably be called from
    elsewhere) -- drop it to a direct `const base = lastRestart.get(name)`
    and rely on `restartDue`'s own `!Number.isFinite(dueAtMs)` guard to
    refuse the NaN result.

Per task rule "NEVER modify src/web/auto-restart-runner.ts" the source edit
is blocked until the user overrides; the test suite documents the gap and
the test that exercises the fallbacks stays in place alongside the fix.
