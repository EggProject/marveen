# routes/background-tasks.ts: DELETE clobbers an already finished task

## Symptom

`DELETE /api/background-tasks/:id` rewrites the row unconditionally, even
when the task already reached a terminal state. A task that completed
successfully seconds earlier is turned into
`status = 'failed', output = '(cancelled)'`, destroying the result the
user was about to read.

## Where

`src/web/routes/background-tasks.ts:199-209`

```ts
if (taskMatch && method === 'DELETE') {
  const task = getBackgroundTask(taskMatch[1])
  if (!task) { json(res, { error: 'Háttérfeladat nem található' }, 404); return true }
  const output = task.tmux_session ? captureSession(task.tmux_session) : null
  if (task.status === 'running' && task.tmux_session) {
    killSession(task.tmux_session)
  }
  finishBackgroundTask(task.id, 'failed', output?.trim() || '(cancelled)')
  json(res, { ok: true })
  return true
}
```

The `status === 'running'` guard protects the `killSession` call but not
the `finishBackgroundTask` call one line below it.

## Failure scenario

1. A task finishes: the poller writes `status = 'done'`,
   `output = '<the agent's answer>'` (line 106).
2. The dashboard list still shows the row; the user clicks the cancel
   button (or a stale tab auto-retries a cancel).
3. The handler runs. `task.tmux_session` is already killed so
   `captureSession` returns `null`, and the row becomes
   `status = 'failed'`, `output = '(cancelled)'`.

The completed output is not recoverable: `finishBackgroundTask` is a
plain `UPDATE` (`src/db.ts:1518`) with no status precondition.

## Pinning test

`src/__tests__/background-tasks-routes.test.ts`, test
`'does not kill a session for an already finished task'` asserts the
current (defective) behaviour: no `kill-session` is issued, yet
`finishBackgroundTask(TASK_ID, 'failed', '(cancelled)')` is called for a
task whose status is `'done'`.

## Suggested fix (NOT applied)

Short-circuit the terminal states before touching the row:

```ts
if (task.status !== 'running') { json(res, { ok: true, already: task.status }); return true }
```

or make `finishBackgroundTask` conditional in SQL
(`... WHERE id = ? AND status = 'running'`).
