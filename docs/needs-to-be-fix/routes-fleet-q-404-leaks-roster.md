# fleet-q.ts: PUT /api/agents/:name/capabilities -- 404 message leaks internal agent identity

## Location

`src/web/routes/fleet-q.ts`, line 28.

## Excerpt

```ts
if (!isKnownAgent(name)) { json(res, { error: 'Agent nem található' }, 404); return true }
```

The handler returns a 404 with a Hungarian-language error message that
distinguishes "agent does not exist" from "agent does exist but you
cannot reach it". This is a tiny information disclosure: an unauthenticated
or low-privilege caller who can talk to the dispatcher can enumerate the
agent roster by probing names and noting which return 404 vs which return
401/403 from the upstream auth gate.

## Pinning test

Not pinned directly -- the suite asserts the literal `error` string to lock
the user-visible contract:

`src/__tests__/fleet-q-routes.test.ts > tryHandleFleetQ -- PUT unknown agent > returns 404 with a Hungarian error message when isKnownAgent is false`

If the message is ever changed (e.g. to a generic `'Not found'`), this
test will fail and force a deliberate update.

## Suggested fix (NOT applied; rule "NEVER modify src/web/routes/fleet-q.ts")

Either:

1. Drop the agent-name distinction entirely: return `404 { error: 'Not found' }`
   so an attacker cannot enumerate agents by probe response.
2. If enumeration is acceptable (LAN-exposed instance, owner-only access),
   at minimum log the probe attempt at `warn` level so the operator can
   spot automated scans.

The Bearer auth gate in `src/web.ts` blocks unauthenticated callers from
reaching this handler at all on most routes -- but the comment at the top
of `fleet-q.ts` notes the gate is shared across the module. Confirm that
the PUT branch is actually gated.

Resolved: 2026-08-18 b7cd64c
