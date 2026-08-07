# Malformed encoded agent names escape conversation route handling

## Location
`src/web/routes/agent-conversation.ts`, `tryHandleAgentConversation`, at the agent-name decode immediately after the route match.

## Excerpt
```ts
const name = decodeURIComponent(match[1])
```

## Failure scenario
A request such as `GET /api/agents/%E0%A4%A/conversation` contains an incomplete percent-encoded sequence. `decodeURIComponent` throws `URIError` before the route enters its transcript-processing `try` block. The handler rejects without writing a route-specific response, so the outer web-server catch converts a malformed client path into a generic 500 response.

## Pinning test
`src/__tests__/routes-agent-conversation.test.ts`, test `pins the malformed encoded agent-name failure`, passes by asserting that the current handler rejects with `URIError` and writes no JSON response.

## Suggested direction
Catch decoding failures at the route boundary and return a client error, preferably 400 for malformed encoding or 404 for an invalid agent path. Keep transcript I/O failures in the existing 500 branch.
