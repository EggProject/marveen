# routes/background-tasks.ts: restart grants every surviving task a fresh 30 minutes

## Symptom

`sweepOrphanedBackgroundTasks` re-arms the watchdog with the full
`TIMEOUT_MS` measured from the sweep, ignoring `task.started_at`. A task
that has already been running for 29 minutes gets another 30 after a
dashboard restart, and a restart loop can keep a runaway `claude -p`
process alive indefinitely.

## Where

`src/web/routes/background-tasks.ts:133-136`

```ts
} else {
  setTimeout(() => checkAndFinalize(task.id), TIMEOUT_MS)
  pollUntilDone(task.id)
}
```

`TIMEOUT_MS` is the constant `30 * 60 * 1000` (line 17). `task.started_at`
(unix seconds, `src/db.ts:1497`) is available on the row the loop is
already iterating over but is not consulted.

## Failure scenario

1. Task starts at T+0; the original 30-minute timeout is armed
   (line 78).
2. The dashboard restarts at T+29min (deploy, `launchd` respawn, crash).
   The in-process timer dies with the old process.
3. `sweepOrphanedBackgroundTasks` runs, finds the tmux session alive, and
   arms a new timeout expiring at T+59min.
4. Each further restart pushes the deadline out by another 30 minutes.
   The 30-minute cap the constant promises is never enforced.

The same applies to a task whose deadline already passed while the
process was down: instead of being finalized immediately, it is given a
full fresh window.

## Pinning test

`src/__tests__/background-tasks-routes.test.ts`, test
`'re-arms the 30 minute timeout for a surviving session'` shows the
timeout firing exactly `TIMEOUT_MS` after the sweep call (fake timers
advance from the sweep, not from `started_at`), regardless of the task's
`started_at` value.

## Suggested fix (NOT applied)

Compute the remaining budget from the row:

```ts
const elapsed = Date.now() - task.started_at * 1000
const remaining = Math.max(0, TIMEOUT_MS - elapsed)
setTimeout(() => checkAndFinalize(task.id), remaining)
```

`remaining === 0` schedules on the next tick, which finalizes an
already-expired task instead of extending it.

## Resolution (2026-08-19, 19d7991)

`src/web/routes/background-tasks.ts:133-136` now computes
`remainingMs = Math.max(0, TIMEOUT_MS - (Date.now() - task.started_at * 1000))`
and arms the watchdog with that. `task.started_at` is unix seconds per
`src/db.ts:1504`, so the `* 1000` matches the MD formula exactly.

Pinning test flipped in `src/__tests__/background-tasks-routes.test.ts`:
`vi.setSystemTime(1_700_000_000_000)` aligns the fake `Date.now()` with
`task.started_at * 1000`, so `elapsed` is ~0 and the existing
`vi.advanceTimersByTime(TIMEOUT_MS)` still fires the timeout. Without
this, the fake clock at sweep time is the real wall clock (~2026), so
`elapsed` would be ~80_000_000_000 ms (~925 days), `remainingMs` would
clamp to 0, and the timer would fire on the next tick -- the assertion
would fail. `vi.useFakeTimers()` was already in place; `setSystemTime`
is scoped to the test's `beforeEach`.

Mutation checks performed against HEAD: removing the `* 1000` makes
`elapsed` look enormous in unix seconds (e.g. ~1.78e9 s vs ~0 s),
`remainingMs` clamps to 0, the timer fires on the next tick, and the
`vi.advanceTimersByTime(TIMEOUT_MS)` no longer matches -- the assertion
fails. Removing the `Math.max` clamp lets negative `remaining` wrap
`setTimeout` into the past, which Node treats as ~0 ms; same failure
mode.
