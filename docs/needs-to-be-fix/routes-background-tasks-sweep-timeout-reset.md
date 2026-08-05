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
