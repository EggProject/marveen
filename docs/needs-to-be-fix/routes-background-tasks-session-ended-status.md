# routes/background-tasks.ts: a dead session is `done` in the poller but `failed` in the sweeper

## Symptom

The exact same observable condition -- "the tmux session for a running
task no longer exists and no `___BG_DONE___` marker was seen" -- is
recorded with two different terminal statuses depending on which code
path notices it, and in the poller's case the task's real output is
thrown away.

## Where

Poller (`src/web/routes/background-tasks.ts:95-101`):

```ts
if (!isBgSessionAlive(session)) {
  const output = '(session ended)'
  finishBackgroundTask(id, 'done', output)
  logger.info({ id }, 'Background task session ended')
  clearInterval(interval)
  return
}
```

Sweeper (`src/web/routes/background-tasks.ts:129-132`):

```ts
if (!task.tmux_session || !isBgSessionAlive(task.tmux_session)) {
  const output = task.tmux_session ? captureSession(task.tmux_session) : null
  finishBackgroundTask(task.id, 'failed', output?.trim() || '(orphaned on restart)')
  orphaned++
}
```

Two differences:

1. **Status.** The poller writes `'done'`, the sweeper writes `'failed'`.
2. **Output.** The sweeper still tries `captureSession` before giving up;
   the poller hardcodes the string `'(session ended)'` and never looks at
   the pane, so anything the agent printed is lost.

## Failure scenario

A background `claude -p` run is killed by the OOM killer (or the user
kills the tmux window) 20 seconds into a long task:

- If the dashboard process stayed up, the 10s poller sees the dead
  session and marks the task `done` with output `(session ended)`. The
  UI shows a green, successful task that produced nothing.
- If the dashboard restarted in the meantime, the startup sweeper sees
  the same dead session and marks the task `failed`, with whatever the
  pane still held.

Consumers cannot distinguish "finished normally" from "died" by looking
at `status`, and `'(session ended)'` is indistinguishable from a task
whose real output happened to be empty.

## Pinning tests

`src/__tests__/background-tasks-routes.test.ts`:

- `'finishes the task as done when the tmux session vanished'` --
  `finishBackgroundTask(TASK_ID, 'done', '(session ended)')`, no
  `capture-pane` fallback.
- `'keeps whatever the dead session left in the pane'` (sweeper) --
  `finishBackgroundTask(TASK_ID, 'failed', 'leftover output')`.

Both assert the current behaviour, not the desired one.

## Suggested fix (NOT applied)

Make the poller mirror the sweeper: capture the pane first, and pick the
status from whether the marker was ever seen. A session that disappears
without printing `___BG_DONE___` did not complete, so `'failed'` is the
honest status in both places.
