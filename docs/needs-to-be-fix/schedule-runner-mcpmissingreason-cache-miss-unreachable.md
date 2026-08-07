# schedule-runner: `mcpMissingReason` cache-miss branch is unreachable

## Location
`src/web/schedule-runner.ts:469`

```ts
function mcpMissingReason(taskName: string, agentName: string): string {
  const missing = lastMcpMissing.get(`${taskName}@${agentName}`) ?? []
  return missing.length ? `mcp-missing:${missing.join(',')}` : 'mcp-missing'
}
```

## Why it is unreachable
`mcpMissingReason` is only called from three sites, and all three require
`attemptFireTask` to have set `lastMcpMissing` first:

1. `runCheck` retry loop (line ~1144) — preceded by
   `await attemptFireTask(...)` returning `'mcp-missing'`, which sets the cache.
2. `runCheck` cron loop (line ~1263) — same pre-condition.
3. `runScheduledTaskNow` (line ~801) — same pre-condition.

In every call path the cache is populated with at least an empty array
(`check.missing ?? []`) BEFORE the `mcpMissingReason` call happens. The
`?? []` fallback therefore cannot fire in any production scenario.

## Evidence
Test runs at 99.68% branch coverage with 1 uncovered branch:

```
const missing = lastMcpMissing.get(`${taskName}@${agentName}`) ?? []  <-- this branch
```

## Options
- Keep the defensive code (acceptable: zero runtime cost, no harm).
- Replace `mcpMissingReason` with `lastMcpMissing.get(key)?.length ? ... : 'mcp-missing'`
  to make the function signature closer to the production invariant.

No action required; pinning as documentation that the branch is defensive.