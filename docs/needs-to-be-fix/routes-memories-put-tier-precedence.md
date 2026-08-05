# routes-memories-put-tier-precedence

**File:** `src/web/routes/memories.ts`
**Where:** `tryHandleMemories`, `PUT /api/memories/:id` branch, line 242
(compare with the `POST /api/memories` branch, line 48)

```ts
// POST -- line 48: category wins
const category = (data.category || data.tier || 'warm').toLowerCase()

// PUT -- line 242: tier wins
if (updateMemory(id, content, tier || category, agent_id, keywords)) { ... }
```

## Defect

The two write endpoints disagree on which field wins when a client sends
both `category` and `tier`, and the PUT handler picks the one the codebase
explicitly calls deprecated.

`POST` treats `tier` as legacy: it prefers `category`, and logs
`'[DEPRECATED] /api/memories: use "category" instead of "tier"'` (line 46)
when only `tier` is supplied. `PUT` inverts that precedence with
`tier || category`, so the deprecated field silently overrides the canonical
one.

A client that sends both fields -- which is exactly what a UI does during a
migration window, where it starts emitting `category` while still sending
`tier` for older backends -- gets two different results from the two verbs:

| Request body                            | POST stores | PUT stores |
| --------------------------------------- | ----------- | ---------- |
| `{"category":"hot","tier":"cold"}`      | `hot`       | `cold`     |

So creating a memory and then editing it, with an unchanged payload, moves
the row to a different category. The failure is silent: both calls return
`200 {"ok":true}`.

## Repro

```
curl -X POST -H 'Content-Type: application/json' \
  -d '{"content":"x","category":"hot","tier":"cold"}' \
  http://127.0.0.1:3420/api/memories
# -> row created with category = "hot"

curl -X PUT -H 'Content-Type: application/json' \
  -d '{"content":"x","category":"hot","tier":"cold"}' \
  http://127.0.0.1:3420/api/memories/<id>
# actual:   row now has category = "cold"
# expected: row stays "hot" (category is the canonical field)
```

## Suggested fix (not applied)

Mirror the POST precedence, and log the same deprecation warning so the two
endpoints behave identically:

```ts
if (tier && !category) {
  logger.warn({ agent: agent_id }, '[DEPRECATED] /api/memories: use "category" instead of "tier"')
}
if (updateMemory(id, content, category || tier, agent_id, keywords)) { ... }
```

## Test coverage note

`src/__tests__/memories-routes.test.ts` pins the *current* behaviour in
`'prefers the deprecated tier field over category when both are sent'`.
That test asserts the bug, not the intent -- flip its expectation to
`'cold' -> 'hot'` when applying the fix.
