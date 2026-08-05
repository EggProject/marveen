# routes-connectors-hu-config-nostring-token

**File:** `src/web/routes/connectors-hu.ts`
**Where:** `tryHandleConnectorsHu`, `/api/connectors-hu/configure` branch, line ~82

```ts
const { token } = JSON.parse(body.toString()) as { token: string }
if (!token?.trim()) {
  json(res, { ok: false, configured: false, syncOutput: 'Token is required' }, 400)
  return true
}
```

## Defect

The `as { token: string }` cast is a compile-time fiction: `JSON.parse` can
return any value for `token`. The optional chain `token?.trim()` only
short-circuits on `null` / `undefined`. For other non-string values
(numbers, booleans, arrays, objects) it tries to call `.trim()` and
throws `TypeError: token.trim is not a function`, which is caught by the
outer `catch` and returned as a 500 with `String(err)`.

That gives the dashboard two wrong answers for a client mistake:

* HTTP 500 (server error) for what is really HTTP 400 (bad request).
* The response body includes the raw `TypeError` message, which is the
  opposite of "Token is required" and not user-actionable.

## Repro

```
curl -X POST -H 'Content-Type: application/json' \
  -d '{"token": 0}' \
  http://127.0.0.1:3420/api/connectors-hu/configure
```

Actual: 500, `{"ok":false,"configured":false,"syncOutput":"TypeError: token.trim is not a function"}`
Expected: 400, `{"ok":false,"configured":false,"syncOutput":"Token is required"}`

Same failure mode for `{"token":[]}`, `{"token":{}}`, `{"token":true}`,
`{"token":false}` -- all values where the optional chain does NOT
short-circuit but the value is not a string.

## Suggested fix (not applied)

Replace the validation with a typeof guard that runs BEFORE `.trim()`:

```ts
if (typeof token !== 'string' || !token.trim()) { ... }
```

The 400 message stays the same; the 500 path is no longer reachable for
this input.

## Test coverage note

The current test suite at `src/__tests__/connectors-hu-routes.test.ts`
includes a 400 test for `null` (which short-circuits) but does not cover
the non-string-non-null case -- a regression test for the fix should
exercise `{"token":0}` and assert the 400 response.
