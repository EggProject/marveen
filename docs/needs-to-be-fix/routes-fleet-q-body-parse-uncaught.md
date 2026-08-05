# fleet-q.ts: PUT /api/agents/:name/capabilities -- unguarded readBody + JSON.parse crash

## Location

`src/web/routes/fleet-q.ts`, lines 29-31 (the `tryHandleFleetQ` handler body
for the PUT branch).

## Excerpt

```ts
const body = await readBody(req)
const parsed = JSON.parse(body.toString()) as { capabilities?: unknown }
if (!Array.isArray(parsed.capabilities) || !parsed.capabilities.every((c: unknown) => typeof c === 'string')) {
  json(res, { error: 'capabilities: string[] required' }, 400)
  return true
}
```

Neither `readBody` nor `JSON.parse` is wrapped in `try`/`catch`. A socket
error during body buffering or any malformed JSON body throws out of the
handler as an unhandled promise rejection. The web dispatcher only learns
that the request was not handled if the handler resolves cleanly -- a
rejection propagates up the call chain instead.

## Failure scenarios

1. **Malformed JSON body.** Client sends `PUT /api/agents/foo/capabilities`
   with body `{not valid json`. `JSON.parse` throws `SyntaxError`. The
   promise rejects; no response is written; the dispatcher surfaces a 500
   with a raw stack trace (or an `unhandledRejection`).
2. **Body read failure.** Client opens the PUT but closes the socket before
   the body has streamed. `readBody` rejects. Same outcome as above.
3. **JSON body that is not an object.** Client sends `null` or `42` or a
   JSON string. `parsed.capabilities` throws `TypeError: Cannot read
   properties of ...`. Same unhandled rejection path.
4. **JSON body that is a non-object mapping root** (e.g. `"hi"`, `42`,
   `true`). `parsed.capabilities` is `undefined`, `Array.isArray(undefined)`
   is `false`, so the 400 branch fires -- only the `null`/array cases throw.

## Comparison with peer routes

The companion route `tryHandleFleet` (in `src/web/routes/fleet.ts`) wraps
both `readBody` and the body-parsing helper calls in `try`/`catch` and
maps each failure to a clean HTTP status (`400` for read failures,
`500` for unexpected throws). `tryHandleFleetQ` is the only `tryHandle*`
in this folder that lacks that defensive block.

## Pinning test

`src/__tests__/fleet-q-routes.test.ts`:

- `tryHandleFleetQ -- PUT request body failure paths > propagates readBody errors as an unhandled rejection (defect: no try/catch)`
- `tryHandleFleetQ -- PUT request body failure paths > throws JSON.parse SyntaxError when the body is malformed (defect: unguarded JSON.parse)`
- `tryHandleFleetQ -- PUT request body failure paths > throws when the body is valid JSON but not an object (defect: capabilities access on null)`

These tests assert the rejection propagates -- the suite is not hiding the
defect, it is pinning it. Each test is deterministic: the body and
bodyError are scheduled via a controlled `EventEmitter` so the test does
not depend on real socket timing.

## Suggested fix (NOT applied; rule "NEVER modify src/web/routes/fleet-q.ts")

Wrap the body parsing block:

```ts
let body: Buffer
try {
  body = await readBody(req)
} catch (err) {
  json(res, { error: `Kérés olvasási hiba: ${(err as Error).message}` }, 400)
  return true
}
let parsed: { capabilities?: unknown }
try {
  parsed = JSON.parse(body.toString()) as { capabilities?: unknown }
} catch {
  json(res, { error: 'Érvénytelen JSON törzs.' }, 400)
  return true
}
if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
  json(res, { error: 'capabilities: object body required' }, 400)
  return true
}
```

This matches the convention used in `src/web/routes/fleet.ts` for the
import route.
