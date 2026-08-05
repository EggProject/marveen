# routes-tool-log-uncaught-json-parse

`src/web/routes/tool-log.ts:11` and `src/web/routes/tool-log.ts:59` parse the
request body with `JSON.parse(body.toString())` inside the `tryHandleToolLog`
handler. A malformed JSON body therefore throws a `SyntaxError` that escapes
the route dispatcher instead of returning a 400. The PostToolUse hook
`tool-log-capture.py` always sends well-formed JSON, so the issue is not
observable end-to-end today; but every other route in this codebase
(`/api/agents/...`, `/api/auth/...`) wraps its body parse in try/catch and
returns `{ error: 'Invalid JSON' }` with a 400. Pinning tests would assert the
catch-all so a future caller (or a tampered body) cannot crash the route.

Pin via `src/__tests__/tool-log-routes.test.ts`.

## Reproduction

```
curl -X POST -H 'Content-Type: application/json' --data 'not-json{' \
  http://127.0.0.1:3420/api/tool-log
# Unhandled SyntaxError; request never returns a JSON body. The dispatcher
# logs the throw and the client receives a 502 / connection reset.
```

## Fix sketch

Wrap each `JSON.parse(...)` call in try/catch and return

```ts
json(res, { error: 'Invalid JSON' }, 400); return true
```

on failure, matching the contract used by `/api/agents/...` and
`/api/auth/...`.
