// Egyszeru multipart/form-data parser: kep + szoveg mezok.

export interface ParsedForm {
  fields: Record<string, string>
  file?: { name: string; data: Buffer; mime: string }
}

export function parseMultipart(buf: Buffer, contentType: string): ParsedForm {
  // Group 1 = quoted-string (RFC 2045 §5.1, inherited from RFC 822).
  // Group 2 = bare token, terminated by the next ';' or whitespace (RFC 2046 §5.1.1 bcharsnospace).
  // /i covers the case-insensitive parameter name per RFC 2045.
  // Lookbehind `(?<=^|[;,])` anchors the match to a parameter boundary (start of
  // string or after `;` / `,`), so a parameter whose name happens to end in
  // "boundary" (e.g. `myboundary=WRONG`) cannot hijack the real match
  // (RFC 2045 §5.1, RFC 2046 §5.1.1).
  // `\s*=\s*` allows optional linear-white-space around `=` per RFC 2045 §5.1.
  const boundaryMatch = contentType.match(
    /(?<=^|[;,])\s*boundary\s*=\s*(?:"([^"]+)"|([^;\s]+))/i,
  )
  if (!boundaryMatch) return { fields: {} }
  const boundary = boundaryMatch[1] ?? boundaryMatch[2]
  // RFC 2045 §5.1: "the boundary value MUST be at most 70 characters".
  // A non-conforming boundary returns an empty form rather than risking an
  // unbounded split on attacker-supplied input.
  if (boundary.length > 70) return { fields: {} }
  // Encoding: 'binary' (alias of 'latin1', byte-identical 0x00-0xFF).
  // Intentional: wire bytes are not Latin-1 characters -- they are raw
  // octets that we later re-encode as UTF-8 for textual fields. Keeping
  // 'binary' here signals "raw bytes", not "ISO-8859-1 text".
  const parts = buf.toString('binary').split(`--${boundary}`)

  const decodeUtf8 = (s: string): string => Buffer.from(s, 'binary').toString('utf8')

  const result: ParsedForm = { fields: {} }

  for (const part of parts) {
    if (part === '--\r\n' || part === '--' || !part.toLowerCase().includes('content-disposition')) continue
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headers = part.slice(0, headerEnd)
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, '')

    // `(?:^|;\s)` prefix anchors the parameter match to a parameter boundary
    // (start of headers or after `;\s`), so the value cannot be captured from
    // inside `filename="..."`. The `/i` flag covers case-insensitive parameter
    // names per RFC 2045.
    const nameMatch = headers.match(/(?:^|;\s)name="([^"]+)"/i)
    if (!nameMatch) continue
    const fieldName = nameMatch[1]

    const filenameMatch = headers.match(/(?:^|;\s)filename="([^"]+)"/i)
    if (filenameMatch) {
      const mimeMatch = headers.match(/Content-Type:\s*(.+)\r?\n?/i)
      result.file = {
        name: decodeUtf8(filenameMatch[1]),
        data: Buffer.from(body, 'binary'),
        mime: mimeMatch?.[1]?.trim() || 'application/octet-stream',
      }
    } else {
      result.fields[fieldName] = decodeUtf8(body)
    }
  }

  return result
}
