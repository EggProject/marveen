# federation.ts:330 -- ctx.fedPeer ?? null fallback is unreachable

## Location

`src/web/routes/federation.ts`, line 330 (`/api/federation/inbox`):

```ts
try { payload = JSON.parse(body.toString()) } catch { json(res, { error: 'Invalid JSON' }, 400); return true }

const callerPeerId = ctx.fedPeer ?? null
const verdict = validateInboxPayload(payload, cfg, { isKnownAgent, mainAgentId: MAIN_AGENT_ID }, callerPeerId)
```

## Excerpt

The `?? null` fallback at line 330 is **structurally unreachable** in
the test surface. The route handler is only invoked through the
dispatcher in `web.ts`, which sets `ctx.fedPeer` for every caller
(either to the authenticated peer id from the peer-token gate, or to
`null` when the call came in via the dashboard-token gate -- never
`undefined`).

The `?? null` was added as defensive insurance against a future caller
that omits the field, but every existing caller either sets it to a
string or to `null`. The route type signature
`RouteContext extends { fedPeer?: string | null }` documents that the
field is optional, but in practice the dispatcher always populates it.

## Failure scenario

v8 reports `branch 47 line=330 type=binary-expr counts=[1012, 0]` --
the truthy arm (`ctx.fedPeer` defined) hit 1012 times across the
existing `routes-federation-full.test.ts` suite (every call passes
a `fedPeer` parameter), the falsy arm (`?? null` fallback) hit 0
times.

The 100% branch coverage gate fails on this file because of this dead
branch.

Options:

1. Drop the `?? null`: `const callerPeerId = ctx.fedPeer` -- requires
   tightening the RouteContext type to make `fedPeer` required (always
   string or null, never undefined).
2. Leave the `?? null` (current state) as belt-and-braces for future
   callers that might omit the field.

Option (1) is the cleanest fix.

## Pinning test

None. Every test in `routes-federation-full.test.ts` calls
`tryHandleFederation` with a `ctx.fedPeer: 'teodor'` (peer-token
caller) or with a test framework that always populates the field. The
`undefined` case cannot be reached without modifying the dispatcher
(which is a source change in `web.ts`, not test-surface).

## Suggested direction

Tighten the RouteContext type:

```ts
interface RouteContext {
  ...
  fedPeer: string | null  // required, never undefined
  ...
}
```

and drop the `?? null` at line 330:

```ts
const callerPeerId = ctx.fedPeer
```

Per task rule "NEVER modify src/web/routes/federation.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
