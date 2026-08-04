# multipart.ts: `boundary=(.+)` is greedy and quote-blind, so a quoted or multi-parameter Content-Type silently corrupts every field

## Location

`src/web/multipart.ts`, lines 9-12 (`parseMultipart`):

```ts
const boundaryMatch = contentType.match(/boundary=(.+)/)
if (!boundaryMatch) return { fields: {} }
const boundary = boundaryMatch[1]
const parts = buf.toString('binary').split(`--${boundary}`)
```

## Excerpt

`(.+)` is greedy and anchored to nothing, so the captured boundary is
"everything from `boundary=` to end of line", including:

1. the surrounding double quotes of a `quoted-string` form, and
2. any parameter that follows the boundary on the same header line.

RFC 2045 section 5.1 states that "the quotation marks in a quoted-string are
not a part of the value of the parameter", and RFC 2046 / RFC 7578 both note
that "it is often necessary to enclose the `boundary` parameter values in
quotes on the Content-type line" (because the boundary character set includes
characters that are not `token` characters). A conforming sender may therefore
emit either form, and the parser must strip the quotes.

When the quotes are not stripped, `--"----WebKitFormBoundaryABC123"` never
occurs in the body, `split()` returns the entire body as a **single** part,
and the parser then happily parses that single part:

- the part does contain `Content-Disposition`, so it is not skipped,
- `indexOf('\r\n\r\n')` finds the first header terminator,
- `name="greeting"` matches,
- there is no `filename=`, so the value lands in `fields`.

The result is not an error and not an empty object. It is a **silently
corrupted value** that contains the rest of the wire payload, including the
closing delimiter:

```
fields.greeting === 'hello\r\n------WebKitFormBoundaryABC123--'
```

## Failure scenario

1. A client (or reverse proxy) sends
   `Content-Type: multipart/form-data; boundary="----WebKitFormBoundaryABC123"`.
   This is legal per RFC 2046 and is emitted in practice by .NET
   `MultipartFormDataContent`, Akka HTTP, and several proxies. Documented
   real-world breakage from the same root cause: nginx-upload-module
   issue #50, akka-http issue #4410.
2. `POST /api/agents/import` (`src/web/routes/agents.ts:1913`) calls
   `parseMultipart` and reads `fields.name`.
3. `overrideName` (`src/web/routes/agents.ts:1915`) becomes
   `"uj-agent\r\n------WebKitFormBoundaryABC123--"` instead of `"uj-agent"`,
   and `fields.overwrite === '1'` never matches, so an intended overwrite
   silently becomes a non-overwrite.
4. The `file` part is never found, so `bundle` stays `undefined` and the
   request fails with `No bundle uploaded` (400) despite a well-formed body.
   The operator sees a generic 400 with no hint that the boundary quoting is
   the cause.

The same corruption applies to the second form,
`boundary=----WebKitFormBoundaryABC123; charset=utf-8`, where the trailing
parameter is swallowed into the boundary.

Severity is raised by the fact that this is a *silent* wrong-value path
(case 3) rather than a clean rejection.

## Pinning test

`src/__tests__/multipart.test.ts`, describe block
`parseMultipart - ismert eltresek (pinning)`:

- `idezojeles boundary eseten a mezo erteke a hatarolot is elnyeli`
- `a boundary utani tovabbi parametert is a boundary reszekent nyeli le`

Both assert the **current** (defective) output:

```ts
expect(parsed.fields.greeting).toBe(`hello\r\n--${BOUNDARY}--`)
```

These tests MUST fail once the bug is fixed. Replace the expectation with
`toBe('hello')` at that point.

## Suggested direction

Tighten the capture so it stops at the first `;` and strips an optional
quoted-string wrapper:

```ts
const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
if (!boundaryMatch) return { fields: {} }
const boundary = boundaryMatch[1] ?? boundaryMatch[2]
```

The `i` flag additionally covers `Boundary=` (the parameter name is
case-insensitive per RFC 2045). The `[^;\s]+` alternative terminates the
unquoted form at the next parameter separator or trailing whitespace.

Per the task rule "NEVER modify src/web/multipart.ts" this was not applied;
the pinning tests above document the current contract.
