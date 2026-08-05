# routes/background-tasks.ts: malformed POST body returns 500 instead of 400

## Symptom

`POST /api/background-tasks` parses the request body with a bare
`JSON.parse`. A body that is not valid JSON throws a `SyntaxError` out
of the handler, so the client gets `500 {"error":"Szerver hiba"}` for
what is a client-side mistake.

## Where

`src/web/routes/background-tasks.ts:146-148`

```ts
if (path === '/api/background-tasks' && method === 'POST') {
  const body = await readBody(req)
  const data = JSON.parse(body.toString()) as { agent_id: string; prompt: string }
```

The throw is caught by the dispatcher in `src/web.ts:218-221`:

```ts
} catch (err) {
  logger.error({ err }, 'Web szerver hiba')
  json(res, { error: 'Szerver hiba' }, 500)
}
```

so the process does not crash -- but every malformed body is logged at
`error` level as a server fault and answered with a 5xx.

## Failure scenario

1. Client posts `Content-Type: application/json` with a truncated body
   (mobile connection drop, or a `curl -d @file` with a stray character).
2. `JSON.parse` throws; the rejected promise unwinds
   `tryHandleBackgroundTasks`.
3. Dashboard shows a server error and the operator sees
   `Web szerver hiba` in the log, pointing at the server rather than at
   the request.

A second, quieter consequence: the `as { agent_id: string; prompt: string }`
cast means a well-formed JSON body of the wrong shape (e.g. `[]` or
`"hello"`) is not rejected by the parser either -- it is only caught
downstream by the `?.trim()` guards, which is luck rather than design.
The project style rule ("no `as`, use `satisfies`; use the project's
typeguards") is also violated by that cast.

## Pinning test

`src/__tests__/background-tasks-routes.test.ts`, test
`'propagates a malformed JSON body to the dispatcher (documented in docs/needs-to-be-fix)'`
asserts the current behaviour: the handler promise rejects with a
`SyntaxError`.

## Suggested fix (NOT applied)

```ts
let data: unknown
try { data = JSON.parse(body.toString()) }
catch { json(res, { error: 'Érvénytelen JSON' }, 400); return true }
if (!isSpawnRequest(data)) { json(res, { error: 'Érvénytelen kérés' }, 400); return true }
```

with `isSpawnRequest` written as a typeguard next to the route.
