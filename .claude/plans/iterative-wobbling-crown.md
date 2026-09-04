# Plan: routes-background-tasks session-ended-status + sweep-timeout-reset

## Context

Two related needs-to-be-fix items live in the same file (`src/web/routes/background-tasks.ts`) and share a test file (`src/__tests__/background-tasks-routes.test.ts`). Both are about correctness of the orphan-task sweep logic, have well-documented "Suggested fix" code in their MDs, and have pinning tests that simply flip. Combining them in one workflow is the lowest-risk, smallest-modification path.

The user has consistently chosen conservative options (Cycle 25 "B skip", Cycle 30 "Option A revert"). Both items here are surgical fixes with documented single-site changes; neither requires type-level refactoring or new helpers.

Items:

1. **`routes-background-tasks-session-ended-status`** (Medium)
   - Symptom: the poller (`background-tasks.ts:95-101`) writes status `'done'` with hardcoded `'(session ended)'` for a dead session that never produced the `___BG_DONE___` marker; the sweeper (`background-tasks.ts:129-132`) writes `'failed'` with the captured pane. Consumers cannot distinguish "completed normally" from "died".
   - Fix: make the poller mirror the sweeper -- capture the pane first, use `'failed'` as the status, log at `warn` level.

2. **`routes-background-tasks-sweep-timeout-reset`** (Medium)
   - Symptom: the sweeper re-arms the 30-minute watchdog with the full `TIMEOUT_MS` (`background-tasks.ts:133-136`), ignoring `task.started_at`. A task that has already been running for 29 minutes gets another 30 after a dashboard restart, and a restart loop can keep a runaway process alive indefinitely.
   - Fix: compute `remaining = Math.max(0, TIMEOUT_MS - (Date.now() - task.started_at * 1000))` and arm the timer with that.

Both fixes share:
- Single file (`src/web/routes/background-tasks.ts`)
- Single test file (`src/__tests__/background-tasks-routes.test.ts`)
- Same `BackgroundTask.started_at` field (unix seconds, per `db.ts:1504`: `Math.floor(Date.now() / 1000)`)
- Existing `captureSession` helper (already in scope, returns `string | null`)
- No type-level refactoring
- No new dependencies

## Critical files

- `src/web/routes/background-tasks.ts` -- fix both sites
- `src/__tests__/background-tasks-routes.test.ts` -- flip two pinning tests
- `docs/needs-to-be-fix/routes-background-tasks-session-ended-status.md` -- mark Resolved
- `docs/needs-to-be-fix/routes-background-tasks-sweep-timeout-reset.md` -- mark Resolved
- `docs/needs-to-be-fix/INDEX.md` -- update both rows to Resolved

## Source changes (`src/web/routes/background-tasks.ts`)

### Site A: poller (lines 95-101), item #1

Current:
```ts
if (!isBgSessionAlive(session)) {
  const output = '(session ended)'
  finishBackgroundTask(id, 'done', output)
  logger.info({ id }, 'Background task session ended')
  clearInterval(interval)
  return
}
```

Fix:
```ts
if (!isBgSessionAlive(session)) {
  const pane = captureSession(session)
  const output = pane?.trim() || '(session ended)'
  finishBackgroundTask(id, 'failed', output)
  logger.warn({ id }, 'Background task session ended without completion marker')
  clearInterval(interval)
  return
}
```

Rationale:
- `captureSession` already returns `string | null` and is already imported in scope
- Trimming matches the sweeper's `output?.trim()` pattern (line 130)
- Falling back to `'(session ended)'` when capture fails preserves the prior failure-mode observability
- Status `'failed'` matches the sweeper (line 131)
- Log level `warn` matches the sweeper (and the `checkAndFinalize` warn at line 122)
- The session ended WITHOUT the `___BG_DONE___` marker, so `done` is a lie

### Site B: sweeper re-arm (lines 133-136), item #2

Current:
```ts
} else {
  setTimeout(() => checkAndFinalize(task.id), TIMEOUT_MS)
  pollUntilDone(task.id)
}
```

Fix:
```ts
} else {
  const elapsedMs = Date.now() - task.started_at * 1000
  const remainingMs = Math.max(0, TIMEOUT_MS - elapsedMs)
  setTimeout(() => checkAndFinalize(task.id), remainingMs)
  pollUntilDone(task.id)
}
```

Rationale:
- `task.started_at` is already in scope (the loop iterates `running: BackgroundTask[]`)
- `BackgroundTask.started_at` is unix seconds per `db.ts:1504`; the `* 1000` matches the MD's formula exactly
- `Math.max(0, ...)` schedules on the next tick when the task has already expired; matches the MD
- `pollUntilDone` continues unchanged -- the interval re-arm is not the defect, only the absolute timeout was

## Test changes (`src/__tests__/background-tasks-routes.test.ts`)

Two pinning tests must flip to reflect the new behavior. No new tests are added.

### Test A flip: `'finishes the task as done when the tmux session vanished'` (around line 377)

Current assertion:
```ts
expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'done', '(session ended)')
expect.objectContaining({ level: 'info', msg: 'Background task session ended' })
```

Flipped assertion:
```ts
expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', '(session ended)')
expect.objectContaining({ level: 'warn', msg: 'Background task session ended without completion marker' })
```

Note: the test programs `sessions: ['other-session']` so the target session is missing, and does NOT program a `panes[SESSION]` capture, so `captureSession` returns `null` (or '' via the test harness) and falls through to `'(session ended)'`. The assertion's output value stays the same; only status and log level flip.

### Test B flip: `'re-arms the 30 minute timeout for a surviving session'` (around line 569)

Current behavior: `vi.advanceTimersByTime(TIMEOUT_MS)` after sweep fires the timeout exactly at `TIMEOUT_MS` after the sweep (regardless of `started_at`). The `mkTask()` helper sets `started_at: 1_700_000_000` (line 141). With the fix, the new arm is `remaining = max(0, TIMEOUT_MS - (Date.now() - 1_700_000_000 * 1000))`, which is `max(0, 1_800_000 - negative huge) = TIMEOUT_MS` (since fake clock at `Date.now()` is well below `1_700_000_000 * 1000`).

Wait, `Date.now()` in vitest fake timers returns the faked wall clock. The test uses `vi.useFakeTimers()` from the start. The `Date.now()` value at sweep time depends on what the faked clock is set to. Since the suite starts fake timers at `vi.useFakeTimers()` without `setSystemTime()`, `Date.now()` returns `new Date().getTime()` at the moment fake timers were installed -- which is the real wall clock time of test setup (in the millions of ms range), NOT `1_700_000_000 * 1000`.

If real wall clock time > `1_700_000_000 * 1000` (= 2023-11-14), then `elapsed = Date.now() - 1_700_000_000_000` is positive. With current wall clock in 2026 (~ `1_780_000_000 * 1000`), elapsed = `1_780_000_000_000 - 1_700_000_000_000 = 80_000_000_000` ms = 80_000_000 s = ~925 days. `TIMEOUT_MS - 925_days_in_ms` is massively negative, so `remainingMs = 0`, and the timer fires on the next tick.

This means the current test as-written would fail with the fix, because `vi.advanceTimersByTime(TIMEOUT_MS)` is meant to advance time by 30 minutes, but the timer was set to fire at +0ms.

**Test fix:** set `started_at` so that the remaining time is exactly `TIMEOUT_MS`. The cleanest approach is to set the fake clock at sweep time so `Date.now() === task.started_at * 1000 + small_offset`. The test can use `vi.setSystemTime(...)` to pin both `started_at` and the faked wall clock.

Concretely:
```ts
const TASK_START_MS = 1_700_000_000_000
H.getRunningBackgroundTasks.mockReturnValue([mkTask({ started_at: TASK_START_MS / 1000 })])
H.getBackgroundTask.mockReturnValue(mkTask({ started_at: TASK_START_MS / 1000 }))
programTmux({ sessions: [SESSION], panes: { [SESSION]: 'still working' } })
vi.setSystemTime(TASK_START_MS)

sweepOrphanedBackgroundTasks()
// The task never produces the marker, so only the timeout can end it.
vi.advanceTimersByTime(TIMEOUT_MS)

expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'timeout', 'still working')
expect(H.logs).toContainEqual(
  expect.objectContaining({ level: 'warn', msg: 'Background task timed out after 30 minutes' }),
)
```

This keeps the test's intent (timeout fires after `TIMEOUT_MS` from sweep when no marker) while making `started_at` aligned with `Date.now()`.

`vi.setSystemTime` must be reset in `afterEach` (or the test's `beforeEach`); the suite already has `beforeEach` -- a one-line reset is sufficient.

## Docs changes

### `docs/needs-to-be-fix/routes-background-tasks-session-ended-status.md`

Append a `## Resolution (2026-08-19, <sha>)` section mirroring the style in `recall-unreachable-defensive-fallbacks.md` (lines 117-153 of that file). State:
- `src/web/routes/background-tasks.ts:95-101` now mirrors the sweeper: capture pane first, status `'failed'`, log at `warn` level
- Pinning test flipped (one-line note)
- Mutation check: deleting the `captureSession` call still passes (the fallback `'(session ended)'` still kicks in via the `pane?.trim() || ...` branch)
- Mutation check: setting status back to `'done'` makes the sweep-or-skip semantics regression-testable

### `docs/needs-to-be-fix/routes-background-tasks-sweep-timeout-reset.md`

Same pattern. State:
- `src/web/routes/background-tasks.ts:133-136` now computes `remainingMs = max(0, TIMEOUT_MS - (Date.now() - task.started_at * 1000))`
- Pinning test flipped: `vi.setSystemTime` aligns fake clock with `task.started_at` so the existing `vi.advanceTimersByTime(TIMEOUT_MS)` still fires the timeout
- Mutation check: removing the `* 1000` makes the timer fire immediately (elapsed looks enormous)
- Mutation check: removing the `Math.max` clamp makes negative values wrap the timeout into the past

### `docs/needs-to-be-fix/INDEX.md`

Update two rows (lines 53 and 56 of INDEX):
- `routes-background-tasks-session-ended-status` row → `Resolved: 2026-08-19 <sha>`
- `routes-background-tasks-sweep-timeout-reset` row → `Resolved: 2026-08-19 <sha>`

## Workflow steps

Use a workflow (per user requirement). All on `test/baseline`, no branch switch.

1. **Verify clean starting state** -- `git status` clean, no in-progress workflow
2. **Apply Site A** (poller fix) to `background-tasks.ts` + flip test A
3. **Run targeted vitest** -- `bun --bun vitest run src/__tests__/background-tasks-routes.test.ts` → expect PASS
4. **Apply Site B** (sweeper fix) + flip test B
5. **Run targeted vitest** again → expect PASS
6. **Run full vitest** -- `bun --bun vitest run` → expect 11126/11126 PASS (or current count)
7. **Run typecheck** -- `bun run typecheck` → expect 1701 (baseline preserved, no new errors)
8. **Update MD #1** (`routes-background-tasks-session-ended-status.md`) with `## Resolution`
9. **Commit #1**: `fix(background-tasks): poller mirrors sweeper for dead session without marker`
10. **Update MD #2** (`routes-background-tasks-sweep-timeout-reset.md`) with `## Resolution`
11. **Update INDEX.md** -- both rows
12. **Commit #2**: `docs(needs-to-be-fix): mark background-tasks session-ended-status + sweep-timeout-reset resolved`
13. **End with `/code-review xhigh --fix`** skill (per user requirement)

Total commits: 2 (one fix commit with both source+test changes, one docs commit). This matches the convention from previous cycles (e.g. Cycle 28's 5-commit pattern: fix → test → docs → test cleanup → branch inventory).

Commit ordering alternative: split into 4 commits (fix A → flip A → fix B → flip B → docs A → docs B → INDEX). This matches cycle 25/26 patterns more closely. The user has not specified commit granularity; either is acceptable. Going with 2 commits for compactness unless `/code-review --fix` finds additional splits.

## Verification

End-to-end verification after workflow completes:

```bash
# 1. Working tree clean
git status

# 2. Two commits ahead of origin/test/baseline
git log --oneline origin/test/baseline..HEAD

# 3. Diff stat shows only the expected files
git diff origin/test/baseline..HEAD --stat

# 4. Targeted test passes
bun --bun vitest run src/__tests__/background-tasks-routes.test.ts

# 5. Full suite passes
bun --bun vitest run

# 6. Typecheck baseline preserved (1701)
bun run typecheck 2>&1 | tail -5
```

Push is NOT part of this plan -- user owns the push button (per CLAUDE.md §6).

## Risks and guarantees

| Risk | Mitigation |
| --- | --- |
| Source change breaks behavior in unanticipated paths | `captureSession` returns `string \| null` and already swallows errors; no new failure modes |
| Test flip misses an assertion | Existing test patterns from cycles 25-30 show that flipping `'done'`→`'failed'` + log level is the canonical change |
| `task.started_at` is in unexpected units | Verified at `db.ts:1504`: `Math.floor(Date.now() / 1000)` (unix seconds); the MD's `* 1000` formula is correct |
| `vi.setSystemTime` interferes with other tests | Existing suite uses `vi.useFakeTimers()`; `setSystemTime` is scoped to the test's `beforeEach`/`afterEach` |
| `/code-review xhigh --fix` introduces regressions | Skill runs AFTER all changes; any auto-fix is reviewed before commit |
| Sweeper change causes timer to fire immediately on stale tasks | `Math.max(0, ...)` clamps to 0, scheduling on the next tick; matches MD's "finalizes an already-expired task instead of extending it" intent |

No risk of breaking the typecheck baseline: both changes use values already in scope (`task.started_at: number`, `captureSession: (string) => string | null`).

No risk of breaking the full suite: the only observable behavior change is the status code in two narrow paths (poller-dead-session and sweeper-re-arm); no other test exercises these paths.

## Branch hygiene

- All work on `test/baseline`
- No branch switch
- No push (user owns push)
- Final state: 2 commits ahead of `origin/test/baseline`, working tree clean