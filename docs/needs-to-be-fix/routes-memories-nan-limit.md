# routes-memories-nan-limit

**File:** `src/web/routes/memories.ts`
**Where:** `tryHandleMemories`, `GET /api/memories` branch, line 72

```ts
const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)
```

## Defect

The `limit` query parameter is parsed with `parseInt` and clamped only from
above. Two classes of client input escape validation:

1. **Non-numeric** (`?limit=abc`) -- `parseInt('abc', 10)` is `NaN`, and
   `Math.min(NaN, 200)` is `NaN`. `NaN` is then bound as a SQL parameter.
2. **Negative** (`?limit=-1`) -- `Math.min(-1, 200)` is `-1`, which is a
   perfectly valid `number`, so it flows through untouched.

`limit` is bound directly into a `LIMIT ?` placeholder on every one of the
five read branches:

* `hybridSearch(agentId, q, limit)` -- `src/db.ts:2475`
* `searchAgentMemories(agentId, q, limit)` -- `src/db.ts:1324` (also
  `limit * RECENCY_OVERSAMPLE`, which is `NaN` too)
* `getAgentMemories(agentId, limit, tier)` -- `src/db.ts:1309`
* `getMemoriesForChat(ALLOWED_CHAT_ID, limit)` -- `src/db.ts:1219`
* the two inline LIKE fallbacks at lines 82-83 and 89

### Consequences

**`NaN` -> HTTP 500.** better-sqlite3 refuses to bind `NaN` and throws
`SqliteError: datatype mismatch`. Nothing in `memories.ts` catches it, so it
unwinds to the dispatcher's catch-all in `src/web.ts:219` and the client gets
`500 {"error":"Szerver hiba"}` for what is a malformed-request problem.

**Negative -> unbounded result set.** SQLite treats any negative `LIMIT` as
"no limit" (documented behaviour). `?limit=-1` therefore dumps *every*
matching memory row in one response, defeating the 200-row cap the line was
written to enforce. On an instance with a large memory table this is a cheap
way for any authenticated caller to force a large scan and a large response
body.

## Repro

Verified against the project's own better-sqlite3 build:

```js
const db = new (require('better-sqlite3'))(':memory:')
db.exec('CREATE TABLE t(id INTEGER PRIMARY KEY, v TEXT)')
for (let i = 0; i < 5; i++) db.prepare('INSERT INTO t(v) VALUES (?)').run('x' + i)

db.prepare('SELECT * FROM t LIMIT ?').all(NaN)
// => throws SqliteError: datatype mismatch

db.prepare('SELECT * FROM t LIMIT ?').all(-5).length
// => 5   (all rows; the limit is ignored)
```

Over HTTP:

```
curl 'http://127.0.0.1:3420/api/memories?limit=abc'
# actual:   500 {"error":"Szerver hiba"}
# expected: 200 with the default page size, or 400 for a bad parameter

curl 'http://127.0.0.1:3420/api/memories?limit=-1'
# actual:   200 with every memory row
# expected: 200 with at most 200 rows
```

## Suggested fix (not applied)

Clamp from both ends and fall back to the default on a non-numeric value:

```ts
const rawLimit = parseInt(url.searchParams.get('limit') || '50', 10)
const limit = Number.isFinite(rawLimit)
  ? Math.min(Math.max(rawLimit, 1), 200)
  : 50
```

## Related

`docs/needs-to-be-fix/routes-spans-nan-limit.md` documents the same
`parseInt` + `Math.min` shape in `src/web/routes/spans.ts`. A shared
`parseLimit(searchParams, { def, max })` helper would fix both and prevent
the next copy.

## Test coverage note

`src/__tests__/memories-routes.test.ts` covers the valid (`?limit=7`) and
over-max (`?limit=9999`) cases. It deliberately does NOT assert the broken
`NaN` / negative behaviour, because those assertions would have to be
rewritten as soon as the bug is fixed. Add regression tests for `?limit=abc`
and `?limit=-1` alongside the fix.
