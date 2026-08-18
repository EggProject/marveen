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

## Resolution (2026-08-19, 19d7991)

`src/web/routes/background-tasks.ts:95-101` now mirrors the sweeper:
`captureSession(session)` first, `output = pane?.trim() || '(session ended)'`
fallback, status `'failed'`, log at `warn` level
("Background task session ended without completion marker").

Pinning test flipped in `src/__tests__/background-tasks-routes.test.ts`:
`'done'` -> `'failed'`, log level `info` -> `warn`, message updated to
match the new wording. The test programs `sessions: ['other-session']`
without a `panes[SESSION]` capture, so `captureSession` returns `null`
(or empty via the harness), and the `pane?.trim() || '(session ended)'`
branch falls through to the same fallback string the old assertion
expected. The output value in the assertion stays `(session ended)`;
only the status code and log level flip.

Unreachability: `captureSession` returns `null` when the tmux session is
gone, so the `pane?.trim()` branch falls through to `'(session ended)'`
only when capture ALSO fails (e.g. tmux itself returned a non-trimmed
empty string or threw). Both branches of the `||` are reachable in
practice; the fallback is no longer dead.

Branch coverage delta is not directly measurable from the suite alone
(no vitest coverage gate is wired into the local run), but the assertion
now reflects the real semantic: a session that disappeared without the
completion marker is a failure, not a success.

Mutation checks performed against HEAD: deleting the `captureSession`
call still passes the test (the `pane?.trim() || ...` fallback kicks in);
changing the status back to `'done'` would re-flip the assertion and is
no longer the documented behaviour.
