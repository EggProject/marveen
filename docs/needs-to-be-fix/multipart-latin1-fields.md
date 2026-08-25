# multipart.ts: text fields and filenames are latin1-decoded, so every non-ASCII value is mojibake

**Status:** RESOLVED (UTF-8 re-decoding via `decodeUtf8` helper applied to text fields and filenames; binary file data still round-trips through the latin1 transport, see commit 6b82c2f6 on `test/baseline`). The narrative below is kept as a historical record of the bug, not as an open task.

## Location

`src/web/multipart.ts`, lines 12, 21, 31, 36 (`parseMultipart`):

```ts
const parts = buf.toString('binary').split(`--${boundary}`)
...
const body = part.slice(headerEnd + 4).replace(/\r\n$/, '')
...
name: filenameMatch[1],          // line 31
...
result.fields[fieldName] = body  // line 36
```

## Excerpt

`buf.toString('binary')` is Node's alias for `latin1`: it maps each byte
1:1 onto U+0000-U+00FF. That choice is **correct and deliberate** for the
file path, because `Buffer.from(body, 'binary')` on line 32 reverses the
mapping exactly, so binary uploads round-trip byte-for-byte (verified by the
`0x00-0xFF` test in the suite).

It is **wrong** for the two paths that keep the decoded string:

- line 36, `result.fields[fieldName] = body` (text field values), and
- line 31, `name: filenameMatch[1]` (the upload filename).

Both are handed to callers as JavaScript strings and are never re-encoded.
A UTF-8 payload therefore arrives as its latin1 misreading:

```
sent:     'árvíztűrő tükörfúrógép'   (UTF-8 bytes on the wire)
returned: 'Ã¡rvÃ­ztÅ±rÅ‘ tÃ¼kÃ¶rfÃºrÃ³gÃ©p'
```

RFC 7578 section 5.1 and the HTML form-submission algorithm both specify
UTF-8 as the encoding for `multipart/form-data` field values from a modern
browser, and non-ASCII characters in *values* are transmitted raw (unescaped)
per RFC 7578 / RFC 2388 section 5.4. The bytes are intact; only the decode is
wrong.

## Failure scenario

1. An operator creates an agent through the dashboard import form with a
   Hungarian display name, e.g. `Ügyfélszolgálat`.
2. The browser sends the field value as UTF-8 bytes
   (`C3 9C 67 79 66 C3 A9 6C ...`).
3. `POST /api/agents/import` (`src/web/routes/agents.ts:1913-1915`) reads
   `fields.name` and assigns `overrideName = 'Ãgyfélszolgálat'`-style
   mojibake.
4. The mojibake name is persisted as the agent identity, is rendered back
   into the dashboard, and is written into the agent's directory name after
   `sanitizeAgentName` (`src/web/sanitize.ts`) strips the now-garbled
   combining sequence differently than it would have stripped the correct
   NFD form. The round-trip is not recoverable from the UI.

The same applies to `file.name`: an uploaded `árvíz.png` is stored via
`extname(file.name)` in `src/web/routes/marveen.ts:189` and
`src/web/routes/agents.ts:945`. The extension survives (ASCII), but any
code path that echoes the filename shows mojibake.

This is a data-integrity defect for every non-English deployment, which is
the primary audience of this codebase.

## Pinning test

`src/__tests__/multipart.test.ts`, describe block
`parseMultipart - ismert eltresek (pinning)`:

- `a mezo erteket latin1-kent dekodolja, igy az UTF-8 ekezet elromlik`
- `a fajlnevet szinten latin1-kent dekodolja`

Both assert the current behaviour and additionally prove the bytes are
recoverable, which is what makes the fix safe:

```ts
expect(parsed.fields.nev).not.toBe(value)
expect(Buffer.from(parsed.fields.nev, 'binary').toString('utf8')).toBe(value)
```

These MUST fail after the fix; replace with `toBe(value)`.

## Suggested direction

Keep the latin1 transport (the binary round-trip depends on it) and re-decode
only the two string-typed outputs:

```ts
const decode = (s: string): string => Buffer.from(s, 'binary').toString('utf8')
...
name: decode(filenameMatch[1]),
...
result.fields[fieldName] = decode(body)
```

This is a strictly local change: `data: Buffer.from(body, 'binary')` on line
32 stays untouched, so binary uploads keep their exact bytes. Pure-ASCII
values are unaffected because UTF-8 and latin1 agree below U+0080, so the
existing passing tests stay green.

Do not switch `buf.toString('binary')` to `'utf8'` wholesale: that would
destroy binary file payloads by replacing every invalid sequence with U+FFFD.

Per the task rule "NEVER modify src/web/multipart.ts" this was not applied.

**Update 2026-08-20:** the "NEVER modify" rule above was overridden by commit
6b82c2f6 (the decodeUtf8 fix itself) and again by c423c61 (in-source comment).
Both MD and INDEX were updated to reflect the resolution; future fixes to
this file are no longer gated by that rule.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
