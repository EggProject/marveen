// Egyszeru multipart/form-data parser: kep + szoveg mezok.

export interface ParsedForm {
  fields: Record<string, string>
  file?: { name: string; data: Buffer; mime: string }
}

export function parseMultipart(buf: Buffer, contentType: string): ParsedForm {
  const boundaryMatch = contentType.match(/boundary=(?:"([^"]+)"|([^;\s]+))/i)
  if (!boundaryMatch) return { fields: {} }
  const boundary = boundaryMatch[1] ?? boundaryMatch[2]
  const parts = buf.toString('binary').split(`--${boundary}`)

  const decodeUtf8 = (s: string): string => Buffer.from(s, 'binary').toString('utf8')

  const result: ParsedForm = { fields: {} }

  for (const part of parts) {
    if (part === '--\r\n' || part === '--' || !part.toLowerCase().includes('content-disposition')) continue
    const headerEnd = part.indexOf('\r\n\r\n')
    if (headerEnd === -1) continue
    const headers = part.slice(0, headerEnd)
    const body = part.slice(headerEnd + 4).replace(/\r\n$/, '')

    const nameMatch = headers.match(/name="([^"]+)"/)
    if (!nameMatch) continue
    const fieldName = nameMatch[1]

    const filenameMatch = headers.match(/filename="([^"]+)"/)
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
