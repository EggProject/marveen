# agent-worker.ts: runViaWorker's after-loop `return` is dead code

## Location

`src/web/agent-worker.ts`, line 751.

```ts
return withWorkerLockFor(ctx, async () => {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await runWorkerAttempt(ctx, message, timeoutMs)
    if (r.kind === 'ok') return { text: r.text, error: r.error }
    if (r.kind === 'fail') {
      if (r.error === 'worker session not ready' && attempt === 0) {
        ...
        continue
      }
      return { text: null, error: r.error }
    }
    // r.kind === 'auth'
    if (attempt === 0) {
      ...
      continue
    }
    logger.error(...)
    return { text: null, error: 'worker auth failed (401/login) after recovery', authFailed: true }
  }
  return { text: null, error: 'worker auth failed', authFailed: true }
})
```

## Excerpt

The fall-out-of-loop `return` on line 751 is unreachable: every iteration
of the `for` loop that survives a `runWorkerAttempt` returns from inside
the loop.

- `'ok'` returns immediately with the text.
- `'fail'` returns immediately, except for `r.error === 'worker session
  not ready'` on `attempt === 0`, which `continue`s. On `attempt === 1`,
  the inner `return { text: null, error: r.error }` fires.
- `'auth'` continues on `attempt === 0` (recovery + retry) and returns
  `{ text: null, error: '... after recovery', authFailed: true }` on
  `attempt === 1`.

The only way to exit the loop without returning is for both iterations to
`continue`. Both `'fail'` and `'auth'` only `continue` on `attempt ===
0`, so the second iteration always returns inside the loop. The
fall-out-of-loop line is structurally dead.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A test drives `runViaWorker` through both the 'fail' retry and the
   'auth' recovery paths.
2. `runViaWorker` always returns from inside the loop.
3. v8 records line 751 as untaken.

Branch coverage caps at 94.61% (158/167) while statements, lines and
functions all reach 100%. The uncovered lines are 302, 370, 381, 751.

## Pinning test

`src/__tests__/agent-worker-full.test.ts`. The reachable siblings are
covered so the gap is exactly the after-loop return:

- `describe('runViaWorker -- readiness')` -- "gives up after the second
  not-ready attempt" asserts the structured `'worker session not ready'`
  failure return inside the loop.
- `describe('restartWorkerSession (via auth-recovery retry)')` --
  "reports authFailed=true after two consecutive auth failures" asserts
  the `'... after recovery'` return inside the loop on attempt 1.

## Suggested direction

One-line edit; removes the dead arm without changing behaviour:

```ts
// Reaching here is structurally impossible -- every iteration of the
// loop above returns from inside it. The `continue` only fires on
// attempt === 0; on attempt === 1 both 'fail' and 'auth' return.
return { text: null, error: 'unreachable', authFailed: true }
```

A stricter tightening is to drop the outer `return` entirely (TypeScript
will flag the function as returning `T | undefined` because the for loop
is empty). The defensive placeholder is fine for now; the unit test
suite pins the gap.

Per task rule "NEVER modify src/web/agent-worker.ts" the source edit is
blocked until the user overrides; the test suite documents the gap.
