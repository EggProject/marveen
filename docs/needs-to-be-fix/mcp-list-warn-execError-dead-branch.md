# mcp-list.ts: warn() payload's `execError ?` truthy arm is unreachable

## Location

`src/web/mcp-list.ts`, line 135 (inside the defensive `previousCount > 0 &&
outcome.entries.length === 0 && !outcome.retainedStale` warn block):

```ts
logger.warn({
  previousCount,
  stderr: scrubPaths(stderrTrimmed.slice(0, 500)),
  execError: execError ? scrubPaths(execError.message) : null,   // 135
}, 'MCP list cache refresh returned 0 entries after non-empty cache')
```

## Excerpt

The full defensive warn block (lines 131-137):

```ts
if (previousCount > 0 && outcome.entries.length === 0 && !outcome.retainedStale) {
  logger.warn({
    previousCount,
    stderr: scrubPaths(stderrTrimmed.slice(0, 500)),
    execError: execError ? scrubPaths(execError.message) : null,
  }, 'MCP list cache refresh returned 0 entries after non-empty cache')
}
```

`execError` here is the destructured local from the await:

```ts
const { stdout, stderr, execError } = await new Promise<{
  stdout: string
  stderr: string
  execError: Error | null
}>(...)
```

so it is exactly the `err ?? null` passed by the execFile callback.

## Failure scenario

The branch is structurally unreachable. The warn condition is:

  `previousCount > 0 && outcome.entries.length === 0 && !outcome.retainedStale`

`outcome.retainedStale` is set inside `applyRefreshOutcome`:

```ts
// src/mcp-list-parser.ts:256-274
export function applyRefreshOutcome(input: RefreshInput): RefreshOutcome {
  const parsed = parseMcpList(input.stdout)
  if (parsed.length > 0) {
    return { entries: parsed, error: undefined, retainedStale: false }   // path 1
  }
  if (input.execError) {
    return {
      entries: input.previousEntries,
      error: input.execError.message,
      retainedStale: input.previousEntries.length > 0,                   // path 2
    }
  }
  return { entries: [], error: undefined, retainedStale: false }          // path 3
}
```

For the warn to fire we need `outcome.entries.length === 0` AND
`!outcome.retainedStale` (i.e. `retainedStale === false`) AND
`previousCount > 0` (so `previousEntries.length > 0`).

  - Path 1 returns `entries = parsed.length > 0`, so `outcome.entries.length > 0` -> warn fails on the entries check.
  - Path 2 (execError set): returns `entries = previousEntries` (length > 0 because previousCount > 0). Even if we ignore that, `retainedStale = previousEntries.length > 0 = true`, so `!retainedStale = false` -> warn fails on the retainedStale check.
  - Path 3 (no execError, empty stdout): returns `entries = []`, `retainedStale = false`. This is the ONLY reachable warn path, and it requires `execError === null`.

Therefore `execError` is always null when the warn fires. The truthy arm
of `execError ? scrubPaths(execError.message) : null` is never taken.

## Observed impact

1. **No runtime impact.** Path 3 returns `retainedStale = false` regardless of `execError`, so the warn fires only on the genuinely-clean-but-empty exit. The defensive ternary's right arm is the correct value in every reachable case.

2. **Coverage gate failure.** v8 branch coverage reports 97.29% (36/37) for `src/web/mcp-list.ts` against the repo's 100% threshold (`vitest.config.ts`). The single uncovered branch is the truthy arm of the ternary on line 135. No test can exercise the arm without modifying the source -- the warn entry condition is a precondition on `execError === null`.

3. **Misleading defensiveness.** The ternary reads as if the warn could fire with a non-null execError, inviting a future reader to add a second warn path or to weaken `applyRefreshOutcome`'s `retainedStale` mapping. Both would be wrong; the asymmetry with line 147 (`softError: execError && !outcome.error ? ...`) -- where the same shape IS reachable -- hides the deadness.

## Pinning test

`src/__tests__/mcp-list.test.ts` exercises every reachable branch of the file:

* `getMcpListCache` -- initial shape + reference stability
* `purgeFromMcpListCache` -- name found + not found
* `refreshMcpListCache`
  * parses parseable stdout and updates entries
  * first-refresh success with zero entries (previousCount=0 -> no warn)
  * populated cache collapses to zero on a clean exit -> warn fires (right arm of `execError ?` is the reachable value)
  * legitimate transient failure (retainedStale=true) -> no defensive warn
  * stdout parses when execError is non-null (CLI health-check failure case)
  * cache.error populated when applyRefreshOutcome surfaces one
  * logger.debug when stderr is non-empty after trim
  * logger.debug NOT called when stderr is whitespace-only
  * concurrent callers return the same inflight promise
  * inflightRefresh cleared after success -> follow-up starts new refresh
  * inflightRefresh cleared after failure -> follow-up starts new refresh
  * coerces a non-Error rejection into a string in the catch block
  * propagates execFile rejection (no stdout) into the catch block
  * reaches the truthy arm of `outcome.error ? scrubPaths(outcome.error) : undefined` (execError set + unparseable stdout + no catch)
* `getMcpListWorkingDir` -- existsSync true (return cached) + false (recreate) + first refresh (mcpListWorkingDir null)
* `cleanupMcpListWorkingDir` -- rmSync + null when set + noop when null + swallows rmSync failures
* `process.once('exit', ...)` registration count
* `startMcpListChecker` -- 30s setTimeout fires refreshMcpListCache
* `startMcpListChecker` -- refresh rejection drives the `.catch(() => {})` callback
* `execFile` callback -- null/undefined stdout/stderr normalised via `?? ''`
* cache.error -- path-scrubbed against /Users/...

30 tests, all passing. Statements 100% (49/49), lines 100% (44/44),
functions 100% (13/13). Branches 97.29% (36/37); only the truthy arm of
the `execError ?` ternary on line 135 remains.

## Suggested direction

Two acceptable resolutions (in order of preference):

1. **Drop the ternary.** The warn payload's `execError` field can be set to `null` unconditionally. This is the value in every reachable case, and removing the dead branch silences the coverage gate without changing behaviour:

   ```ts
   logger.warn({
     previousCount,
     stderr: scrubPaths(stderrTrimmed.slice(0, 500)),
     execError: null,
   }, 'MCP list cache refresh returned 0 entries after non-empty cache')
   ```

2. **Add `/* v8 ignore next */`** above line 135 with a one-line comment naming the `applyRefreshOutcome` `retainedStale` mapping that makes the arm dead. Silences the gate without changing runtime behaviour.

Until a resolution is chosen, the branch-coverage gate will fail on this file; treat this MD as the authoritative pin and exclude `mcp-list.ts` from the branch threshold (statements/lines/functions still gate, and remain at 100%).

Per task rule "NEVER modify src/web/mcp-list.ts" neither fix has been applied; the test suite is the highest achievable without source changes.