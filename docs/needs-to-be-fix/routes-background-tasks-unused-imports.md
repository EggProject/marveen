# routes/background-tasks.ts: unused imports (`execSync`, `markOrphanedTasksFailed`)

## Symptom

Two imported bindings are never referenced in the module. They are dead
weight and, in the case of `markOrphanedTasksFailed`, a misleading hint
that the db helper is what performs the orphan sweep (it is not: the
sweep is done row-by-row with `finishBackgroundTask`).

## Where

`src/web/routes/background-tasks.ts:2`

```ts
import { execSync, execFileSync } from 'node:child_process'
```

`execSync` has no call site; every tmux invocation goes through
`execFileSync`.

`src/web/routes/background-tasks.ts:3-7`

```ts
import {
  createBackgroundTaskAtomic, finishBackgroundTask, getBackgroundTasks,
  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
  type BackgroundTask,
} from '../../db.js'
```

`markOrphanedTasksFailed` has no call site either.

Verification:

```
$ grep -n "execSync\|markOrphanedTasksFailed" src/web/routes/background-tasks.ts
2:import { execSync, execFileSync } from 'node:child_process'
5:  getBackgroundTask, getRunningBackgroundTasks, markOrphanedTasksFailed,
```

Both names appear on the import lines only.

## Impact

No runtime failure. It does force the test suite to keep `execSync` in
the `node:child_process` mock factory (an ESM named import of a missing
export throws at module-evaluation time), so the dead import leaks into
test setup.

## Suggested fix (NOT applied)

Drop both names from the import lists. Per the repo rule "if you notice
unrelated dead code, mention it -- don't delete it", this is filed
rather than fixed.
