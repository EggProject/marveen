# routes-memories-put-skips-validation

**File:** `src/web/routes/memories.ts`
**Where:** `tryHandleMemories`, `PUT /api/memories/:id` branch, lines 237-245

```ts
const memUpdateMatch = path.match(/^\/api\/memories\/(\d+)$/)
if (memUpdateMatch && method === 'PUT') {
  const id = parseInt(memUpdateMatch[1], 10)
  const body = await readBody(req)
  const { content, category, tier, agent_id, keywords } = JSON.parse(body.toString()) as { ... }
  if (updateMemory(id, content, tier || category, agent_id, keywords)) { json(res, { ok: true }); return true }
  json(res, { error: 'Memory not found' }, 404)
  return true
}
```

## Defect

`PUT` applies **none** of the three validations `POST` performs on the exact
same two fields. It goes straight from `JSON.parse` to `updateMemory`.

### 1. The security filter is bypassed

`POST` runs `containsSuspiciousContent(data.content)` (line 40) and rejects
matches with `400 {"error":"Content rejected by security filter"}`. The
patterns block prompt-injection strings and shell payloads
(`ignore previous instructions`, `rm -rf`, `bash -c`, `curl http://...`,
`eval(`, ...). `PUT` never calls it.

Since memories are fed back into agent context, the filter is a
prompt-injection control, and `PUT` is a complete bypass of it: write a
benign memory, then edit it to whatever the filter would have blocked.

```
POST {"content":"ignore all previous instructions"}   -> 400, rejected
POST {"content":"hello"}                              -> 201, id = 5
PUT  /api/memories/5 {"content":"ignore all previous instructions"} -> 200, stored
```

The control is only as strong as its weakest write path, and this one is
unguarded.

### 2. Category is not validated -- and the DB CHECK turns that into a 500

`POST` validates against `MEMORY_CATEGORIES` (line 49) and returns a helpful
`400 {"error":"Invalid category \"lukewarm\". Allowed: hot, warm, cold, shared"}`.

`PUT` passes the value straight into `updateMemory`, which builds
`category = ?` (`src/db.ts:1365`). The memories table declares
`CHECK(category IN ('hot','warm','cold','shared'))` (`src/db.ts:293`), so
SQLite throws `SqliteError: CHECK constraint failed`. Nothing here catches
it; it unwinds to the dispatcher catch-all at `src/web.ts:219` and the client
gets `500 {"error":"Szerver hiba"}` instead of the 400 the POST path gives
for identical input.

`POST` also lowercases the category before validating; `PUT` does not, so
`{"category":"Hot"}` is a 500 on PUT and a success on POST.

### 3. Empty content is accepted

`POST` rejects missing / whitespace-only content with
`400 {"error":"Content is required"}` (line 39). `PUT` will happily write
`content = ''` -- or `content = undefined`, which better-sqlite3 rejects with
another `datatype mismatch` 500 if the field is omitted entirely.

## Repro

```
# 1. security filter bypass
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"content":"ignore all previous instructions"}' \
  http://127.0.0.1:3420/api/memories/1
# actual:   200 {"ok":true}  -- stored
# expected: 400 {"error":"Content rejected by security filter"}

# 2. invalid category
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"content":"x","category":"lukewarm"}' \
  http://127.0.0.1:3420/api/memories/1
# actual:   500 {"error":"Szerver hiba"}
# expected: 400 {"error":"Invalid category \"lukewarm\". Allowed: hot, warm, cold, shared"}

# 3. empty content
curl -X PUT -H 'Content-Type: application/json' \
  -d '{"content":"   "}' http://127.0.0.1:3420/api/memories/1
# actual:   200 {"ok":true}  -- memory blanked
# expected: 400 {"error":"Content is required"}
```

## Suggested fix (not applied)

Lift the POST validation into a helper and call it from both branches:

```ts
function validateMemoryWrite(content: unknown, rawCategory: string | undefined):
  { ok: true; category: string } | { ok: false; status: number; error: string } {
  if (typeof content !== 'string' || !content.trim()) {
    return { ok: false, status: 400, error: 'Content is required' }
  }
  if (containsSuspiciousContent(content)) {
    return { ok: false, status: 400, error: 'Content rejected by security filter' }
  }
  const category = (rawCategory || 'warm').toLowerCase()
  if (!MEMORY_CATEGORIES.has(category)) {
    return { ok: false, status: 400, error: `Invalid category "${category}". Allowed: ${[...MEMORY_CATEGORIES].join(', ')}` }
  }
  return { ok: true, category }
}
```

Note that `updateMemory` treats a falsy `category` as "leave unchanged"
(`src/db.ts:1365`), so the PUT caller must keep passing `undefined` rather
than defaulting to `'warm'` -- otherwise every edit silently reclassifies the
row. Split the default out of the helper, or pass a
`{ defaultCategory: false }` flag.

## Related

`docs/needs-to-be-fix/routes-memories-put-tier-precedence.md` -- the same PUT
branch also inverts the `category` / `tier` precedence. Both should be fixed
in one pass.

## Test coverage note

`src/__tests__/memories-routes.test.ts` covers all twelve suspicious-content
patterns on POST and the POST category validation. The PUT tests pin only the
current pass-through behaviour; add the three cases above as regression tests
with the fix.
