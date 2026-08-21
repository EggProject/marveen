# multipart.ts: the `Content-Disposition` part filter is case-sensitive, silently dropping conforming parts

## Location

`src/web/multipart.ts`, line 17 (`parseMultipart`):

```ts
if (part === '--\r\n' || part === '--' || !part.includes('Content-Disposition')) continue
```

(Two later fixes also touch this file as part of the same cycle: the parameter-name `/i` flag and the `(?:^|;\s)` anchor on `name=` / `filename=` were applied in 2026-08-21 `be69fc8cf4e36a1a6025c4282da45ae36c4937f6`. The header-name fix on this very line already landed in 2026-08-16 `b5baca3`.)

## Excerpt

`String.prototype.includes` is a literal, case-sensitive substring test.
HTTP field names are case-insensitive (RFC 9110 section 5.1: "field names are
case-insensitive"), and MIME part headers inherit the same rule via RFC 2045.
A sender that emits `content-disposition:` or `CONTENT-DISPOSITION:` is
conforming, but every one of its parts is silently `continue`d.

The failure is silent in the strongest sense: no throw, no log, no partial
result. The part simply does not exist as far as the caller is concerned.

Note the inconsistency inside the same function: the `Content-Type` lookup on
line 29 **does** use the `i` flag:

```ts
const mimeMatch = headers.match(/Content-Type:\s*(.+)\r?\n?/i)
```

So the file already treats one header name as case-insensitive and the other
as case-sensitive. That asymmetry is almost certainly unintentional.

The `name="..."` and `filename="..."` matches on lines 23 and 27 are
case-sensitive too, but those are *parameter* names, and RFC 7578 section 4.2
specifies them in lowercase, so they are lower risk. The header name is the
part that varies in the wild.

## Failure scenario

1. A non-browser client (curl script, Go `mime/multipart` with a hand-rolled
   header, an HTTP/2 intermediary that normalises header names to lowercase,
   or a proxy that re-serialises the body) emits
   `content-disposition: form-data; name="bundle"; filename="a.tar.gz"`.
2. `POST /api/agents/import` (`src/web/routes/agents.ts:1913`) calls
   `parseMultipart`; the part is skipped, so `file` is `undefined` and
   `fields` is `{}`.
3. `src/web/routes/agents.ts:1925` returns `No bundle uploaded` (400) even
   though a valid bundle was in the request body.
4. The same skip hits `src/web/routes/marveen.ts:193` (`No file uploaded`),
   `src/web/routes/skills.ts:387`, and
   `src/web/routes/agents-skills.ts:79`.

HTTP/2 is the relevant amplifier: RFC 9113 section 8.2.1 requires header
*names* to be lowercase on the wire. That rule applies to HTTP headers rather
than to MIME part headers inside a body, so a compliant client will not
normally lowercase the part headers, which is why this has not been hit yet.
It becomes reachable as soon as any intermediary rewrites the body, which is
why this is filed as medium rather than high.

## Pinning test

`src/__tests__/multipart.test.ts`, describe block
`parseMultipart - ismert eltresek (pinning)`:

- `a Content-Disposition header nevet kis-nagybetu erzekenyen szuri`

```ts
const body = buildBody(['content-disposition: form-data; name="a"\r\n\r\n1'])
expect(parseMultipart(body, CT).fields).toEqual({})
```

The suite also contains the positive counterpart for the `Content-Type`
header, which already works case-insensitively
(`a Content-Type header nevet kis-nagybetu fuggetlenul illeszti`), so the
asymmetry is locked in by tests from both sides.

The pinning test MUST fail once fixed; change the expectation to
`toEqual({ a: '1' })`.

## Suggested direction

Make the part filter match the `Content-Type` lookup that is already in the
file:

```ts
if (part === '--\r\n' || part === '--' || !/Content-Disposition/i.test(part)) continue
```

For full consistency, the `name` / `filename` parameter matches on lines 23
and 27 should take the same `i` flag:

```ts
const nameMatch = headers.match(/name="([^"]+)"/i)
const filenameMatch = headers.match(/filename="([^"]+)"/i)
```

Be aware of a pre-existing interaction when touching line 23: `/name="..."/`
also matches the tail of `filename="..."`, so a part whose header lists
`filename=` before `name=` resolves `fieldName` to the filename. That is
currently harmless (the `filenameMatch` branch ignores `fieldName`) and is
pinned by the test
`forditott sorrendu filename/name eseten a fajlnevbol lesz a mezonev`.
Anchoring the parameter match (`/(?:^|[;\s])name="([^"]+)"/`) would fix both
at once.

Per the task rule "NEVER modify src/web/multipart.ts" this was not applied.

**Status:** RESOLVED 2026-08-21 be69fc8cf4e36a1a6025c4282da45ae36c4937f6 -- parameter-name /i flag and
nameMatch anchoring applied. Header-name fix already landed in
2026-08-16 b5baca3.
