# agent.ts: detectLinuxLibc's platform check (line 73) is unreachable in production

## Location

`src/agent.ts`, lines 72-80 (`detectLinuxLibc`):

```ts
function detectLinuxLibc(): 'glibc' | 'musl' | 'unknown' {
  if (process.platform !== 'linux') return 'unknown'
  try {
    const out = execSync('ldd --version 2>&1', { encoding: 'utf-8' })
    return /musl/i.test(out) ? 'musl' : 'glibc'
  } catch {
    return 'unknown'
  }
}
```

## Excerpt

The inner `if (process.platform !== 'linux') return 'unknown'` branch is
**structurally unreachable** in production. The function's only caller is
`resolveClaudeCodeBin`, and that caller guards on `linux && x64` BEFORE
invoking `detectLinuxLibc`:

```ts
if (process.platform !== 'linux' || process.arch !== 'x64') {
  cachedClaudeCodeBin = undefined
  return undefined
}
const libc = detectLinuxLibc()
```

So by the time `detectLinuxLibc` runs, `process.platform === 'linux'` is an
invariant -- the inner guard never fires.

## Failure scenario

A reviewer (or coverage gate) notices the dead branch and either:

1. Removes it as dead code (safe but a one-line source change).
2. Tries to add a test for it -- the test cannot exercise the branch through
   `runAgent` because the outer guard always short-circuits first.
3. Leaves it in place and adds a getter-hack coverage test (see Pinning
   test below) that simulates an impossible-to-reach scenario purely for the
   v8 branch counter.

Today option (3) is what's checked in. Option (1) is the correct fix.

## Pinning test

`src/__tests__/agent-run-paths.test.ts` includes a test titled
"covers detectLinuxLibc's internal platform check (line 73) via a
process.platform getter". It works around the dead branch by overriding
`process.platform` with a getter that returns `'linux'` on the first read
(resolveClaudeCodeBin's outer guard) and `'darwin'` on the second read
(detectLinuxLibc's inner guard). Without the override, the branch cannot be
hit through any public API of `agent.ts`.

If the inner guard is removed, this test should be deleted (or repurposed
to assert the `cachedClaudeCodeBin = undefined` outcome without the getter
hack).

## Suggested direction

Delete the inner guard. The function should be:

```ts
function detectLinuxLibc(): 'glibc' | 'musl' | 'unknown' {
  try {
    const out = execSync('ldd --version 2>&1', { encoding: 'utf-8' })
    return /musl/i.test(out) ? 'musl' : 'glibc'
  } catch {
    return 'unknown'
  }
}
```

The caller already documents the `linux && x64` precondition. If the
caller's precondition is ever relaxed (e.g. to detect libc on macOS for a
future Darwin variant), the guard can be re-added with a corresponding
caller update.

Per task rule "NEVER modify src/agent.ts" this requires an explicit override
from the user.
