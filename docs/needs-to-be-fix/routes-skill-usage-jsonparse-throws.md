# skill-usage.ts: POST /api/skill-usage lets malformed JSON throw

## Location

`src/web/routes/skill-usage.ts`, lines 10-11, inside the `POST /api/skill-usage`
branch of `tryHandleSkillUsage`.

```ts
const body = await readBody(req)
const data = JSON.parse(body.toString()) as {
  agent_id: string
  skill_name: string
  trigger_type: 'tool_call' | 'skill_read'
  session_id?: string | null
}
```

## Symptom

A POST whose body is not parseable JSON propagates the `SyntaxError` out of
`tryHandleSkillUsage`. The dispatcher in `src/web.ts:170` has a try/catch
around every handler, so the user sees a 500 with body
`{"error":"Szerver hiba"}` and the error is logged with
`logger.error({ err }, 'Web szerver hiba')`. Malformed input is a client
error and should be a 400.

## Why this is wrong

The sibling POST endpoints handle the same situation cleanly:

- `src/web/routes/agent-taskstate.ts:47-49`
  ```ts
  const body = await readBody(req)
  let fields: Record<string, unknown>
  try { fields = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }
  ```
  returns a 400 with `{ error: 'Invalid JSON' }`.

The skill-usage route is the only POST endpoint that omits the try/catch.
The PostToolUse hook that fires this endpoint is unlikely to send malformed
JSON, but a misconfigured agent or a bug in a future caller would surface
as a 500 in the server log instead of a 400 in the dashboard.

## Fix

Mirror the agent-taskstate pattern:

```ts
const body = await readBody(req)
let data: { agent_id: string; skill_name: string; trigger_type: 'tool_call' | 'skill_read'; session_id?: string | null }
try {
  data = JSON.parse(body.toString())
} catch {
  json(res, { error: 'Invalid JSON' }, 400)
  return true
}
```

## Until the fix lands

The suite in `src/__tests__/skill-usage-routes.test.ts` only covers the
three "happy + validation" branches that exist today. Driving a malformed
body would propagate a thrown `SyntaxError` past the route, so it is
intentionally not exercised; coverage stays at 100% for the current code
shape and the defect is documented here.
