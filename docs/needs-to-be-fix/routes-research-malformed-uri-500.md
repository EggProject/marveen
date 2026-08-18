# routes/research.ts:61: decodeURIComponent on regex path throws URIError → web.ts 500

## Location

`src/web/routes/research.ts`, lines 59-66 (the single-doc branch of
`tryHandleResearch`, where the regex captures are decoded):

```ts
const match = path.match(/^\/api\/research\/([^/]+)\/([^/]+)$/)
if (match && method === 'GET') {
  const agent = decodeURIComponent(match[1])
  const name = decodeURIComponent(match[2])
  if (!NAME_RE.test(name)) {
    json(res, { error: 'Invalid file name' }, 400)
    return true
  }
```

## Excerpt

```ts
const agent = decodeURIComponent(match[1])
const name = decodeURIComponent(match[2])
```

`decodeURIComponent` throws `URIError: URI malformed` for any input
that contains a stray percent followed by characters that are not two
valid hex digits, or for overlong UTF-8 sequences. The regex at line
59 captures `[^/]+` — any non-slash run — which admits `%G0`, `%`, or
`%E0%A0` (truncated UTF-8).

Neither decode is wrapped in `try/catch`. The `URIError` propagates
out of the route handler; the outer `try/catch` in `web.ts`
(lines 219-221) logs the error and returns a 500 with body
`{ error: 'Szerver hiba' }`.

## Failure scenario

`GET /api/research/zz/foo%G0.md` (or any request with a stray percent
in the `<agent>` or `<name>` segment):

1. `url.pathname` keeps `%G0` verbatim (it is a syntactically valid
   path component — the malformed percent is a decode-time problem,
   not a parse-time problem).
2. The regex captures `foo%G0.md` into `match[2]`.
3. `decodeURIComponent('foo%G0.md')` throws
   `URIError: URI malformed`.
4. The throw escapes the route handler; `web.ts:219-221` catches it,
   logs `Error: URI malformed`, and returns
   `{ error: 'Szerver hiba' }` with HTTP 500.

The endpoint has a 400 (`'Invalid file name'`) and a 404 (`'Unknown
agent'`) branch that both fit this scenario semantically — the
request is malformed input, not an internal error. The 500 is wrong.

The same exposure applies to `match[1]` (the `<agent>` segment):
`/api/research/foo%G0/bar.md` throws on `decodeURIComponent(match[1])`
and produces the same 500 instead of the 404 the agent-allowlist
branch would emit if the decode had succeeded.

## Pinning test

None. `src/__tests__/research-routes.test.ts` covers the 400 / 404
paths with clean inputs but does not exercise a stray percent.

## Suggested direction

Wrap each `decodeURIComponent` in a `try/catch`:

```ts
let agent: string
let name: string
try {
  agent = decodeURIComponent(match[1])
  name = decodeURIComponent(match[2])
} catch {
  json(res, { error: 'Invalid file name' }, 400)
  return true
}
```

A shared `safeDecodeURIComponent` helper in `web/http-helpers.ts`
(or co-located with `NAME_RE`) returns the decoded string on success
and throws a typed `InvalidPathComponent` on failure, which the route
handler maps to the existing 400. The agent-side decode failure
inherits the same 400; if a separate 404 is preferred for the agent
segment, add a second `try` block scoped to `match[1]`.

## Resolution

Wrapped the pair of `decodeURIComponent` calls in a single `try/catch`
that maps any `URIError` to the existing 400 `{ error: 'Invalid file name' }`
response, matching the wording of the adjacent malformed-name branch. Added
a regression test that requests `/api/research/<sub>/foo%G0.md` and asserts
the 400 + body shape.
