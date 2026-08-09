# agent-process.ts: `restartAgentProcess` `||` default error string is unreachable

## Location

`src/web/agent-process.ts`, line 1384:

```ts
if (!stopResult.ok) return { ok: false, error: stopResult.error || 'Failed to stop running agent before restart' }
```

The right arm of the `||` operator (`'Failed to stop running agent before restart'`)
is dead.

## Excerpt

```ts
// src/web/agent-process.ts:1381-1387
export function restartAgentProcess(name: string, opts: { fresh?: boolean } = {}): { ok: boolean; pid?: number; error?: string } {
  if (isAgentRunning(name)) {
    const stopResult = stopAgentProcess(name)
    if (!stopResult.ok) return { ok: false, error: stopResult.error || 'Failed to stop running agent before restart' }
  }
  return startAgentProcess(name, opts)
}
```

`stopAgentProcess` returns one of:

```ts
// src/web/agent-process.ts:1342-1370
export function stopAgentProcess(name: string): { ok: boolean; error?: string } {
  const session = agentSessionName(name)
  if (!isAgentRunning(name)) return { ok: false, error: 'Agent is not running' }

  const host = readAgentRemoteHost(name)

  try {
    runTmux(host, ['kill-session', '-t', session], { timeout: 5000 })
    ...
    return { ok: true }
  } catch (err) {
    ...
    return { ok: false, error: 'Failed to stop tmux session' }
  }
}
```

Both `ok: false` paths in `stopAgentProcess` carry a TRUTHY error string
(`'Agent is not running'` / `'Failed to stop tmux session'`). The `||`
right arm in `restartAgentProcess` therefore has no reachable input.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

The `restartAgentProcess` suite in `src/__tests__/agent-process.test.ts`
already drives both reachable outcomes:

- `aborts when the stop fails` (line 1393-1401): `stopAgentProcess` throws
  via `execFileSync` throw on line 1395-1399, returns
  `{ ok: false, error: 'Failed to stop tmux session' }` — `||` left arm
  hit, function returns the truthy error verbatim. v8 coverage confirms:
  the `if` branch (line 1384 k=165) has counts `[1, 1]`, the `||`
  binary-expr (line 1384 k=166) has counts `[1, 0]` — left arm hit,
  right arm 0 hits.

- `starts directly when the agent is not running` (line 1403-1406):
  `isAgentRunning` returns false, so `stopResult` is never computed and
  the `if (!stopResult.ok)` is skipped entirely — `||` never evaluated.

There is no third call site for `restartAgentProcess` in the current SUT
that could route a stopAgentProcess ok=false with empty error.

## Pinning test

`src/__tests__/agent-process.test.ts:1393-1401` — the existing
`'aborts when the stop fails'` test pins the reachable branch. The
right arm of the `||` is dead and is documented here without a
test-side assertion (no test can construct the unreachable input).

## Suggested direction

Drop the default, since the type contract of `stopAgentProcess` already
guarantees `error` is set whenever `ok` is false:

```ts
if (!stopResult.ok) return { ok: false, error: stopResult.error! }
```

The `!` non-null assertion is sound because the `ok: false` arm of
`stopAgentProcess` always sets `error` to a truthy string. If the type
contract is loosened in the future, the `||` can be reinstated.

Alternatively, leave the `||` as a defensive belt-and-braces and accept
the dead branch; the cost is one uncovered v8 branch and a slightly
misleading code path. The SUT author chose this defensive style at line
1384; removing it is a judgment call, not a bug fix.

Per task rule "NEVER modify src/web/agent-process.ts" the source edits
are blocked until the user overrides; the test suite documents the
gap and pins the reachable branch.
