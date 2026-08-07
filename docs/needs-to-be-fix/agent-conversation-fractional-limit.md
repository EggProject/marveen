# Fractional conversation limits can exceed the requested page size

## Location
`src/web/routes/agent-conversation.ts`, `tryHandleAgentConversation`, in limit parsing and pagination window calculation.

## Excerpt
```ts
const limitRaw = Number(url.searchParams.get('limit'))
const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(limitRaw, 2000) : DEFAULT_LIMIT
// ...
const start = Math.max(0, end - limit)
const entries = all.slice(start, end)
```

## Failure scenario
With five timeline entries and `limit=2.5`, `start` becomes `2.5`. `Array.prototype.slice` converts that fractional index to `2`, so the response contains three entries. The route therefore returns more entries than the requested page size and reports `count: 3` for `limit=2.5`.

## Pinning test
`src/__tests__/routes-agent-conversation.test.ts`, test `pins the fractional limit returning more entries than requested`, passes by asserting the current three-entry result.

## Suggested direction
Normalize a positive limit to an integer before computing `start`, for example by flooring it and clamping the result to at least 1 and at most 2000. Alternatively, reject non-integer limits with 400.
