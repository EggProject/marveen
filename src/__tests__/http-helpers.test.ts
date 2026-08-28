// Full-coverage suite for src/web/http-helpers.ts.
//
// http-helpers is pure HTTP plumbing: request body buffering, JSON responses,
// gzip negotiation and static file serving with conditional GET. It reads no
// env vars, spawns no subprocesses and opens no sockets, so the only sandbox
// helper needed is mkTempDir/rmTempDir for the files serveFile() stats.
//
// Companion suite: serve-file-cache.test.ts covers the cache-header contract
// that motivated the ETag/Cache-Control work. This file targets the module as
// a unit (readBody, the gzip memo, MIME fallback) so it stands alone at 100%.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import { gunzipSync } from 'node:zlib'
import http from 'node:http'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'
import {
  MIME,
  DEFAULT_READ_BODY_MAX_BYTES,
  RequestBodyTooLargeError,
  readBody,
  json,
  jsonMaybeGzip,
  etagMatches,
  serveFile,
} from '../web/http-helpers.js'

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

/**
 * Minimal IncomingMessage: serveFile/jsonMaybeGzip only read `.headers`.
 *
 * Headers are typed wider than `IncomingHttpHeaders`, which pins
 * `accept-encoding` to `string | undefined`. The module under test defensively
 * handles the `string[]` form (duplicate header lines), so the tests must be
 * able to produce it.
 */
function fakeReq(headers: Record<string, string | string[] | undefined> = {}): http.IncomingMessage {
  return { headers } as unknown as http.IncomingMessage
}

/**
 * EventEmitter standing in for a request stream. `destroy()` is recorded so
 * the over-limit test can assert readBody aborts the socket rather than
 * draining the rest of a hostile upload.
 */
function fakeStreamReq(): {
  req: http.IncomingMessage
  emitter: EventEmitter
  destroyed: () => boolean
} {
  const emitter = new EventEmitter()
  let wasDestroyed = false
  Object.assign(emitter, { destroy: () => { wasDestroyed = true } })
  return {
    req: emitter as unknown as http.IncomingMessage,
    emitter,
    destroyed: () => wasDestroyed,
  }
}

/** Captures the status/headers/body a helper writes to the response. */
function fakeRes(): {
  res: http.ServerResponse
  status: () => number | null
  header: (name: string) => string | undefined
  headers: () => Record<string, string>
  body: () => Buffer | null
} {
  let status: number | null = null
  const headers: Record<string, string> = {}
  let body: Buffer | null = null

  const res = {
    writeHead(code: number, hdrs?: Record<string, string>) {
      status = code
      if (hdrs) Object.assign(headers, hdrs)
    },
    end(data?: Buffer | string) {
      body = data === undefined ? Buffer.alloc(0) : Buffer.from(data)
    },
  } as unknown as http.ServerResponse

  return {
    res,
    status: () => status,
    header: (name) => headers[name] ?? headers[name.toLowerCase()],
    headers: () => headers,
    body: () => body,
  }
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let tmpDir: string
let smallHtml: string
let bigJs: string
let bigPng: string
let bigUnknownExt: string

// Comfortably over GZIP_MIN_BYTES (1024) and highly compressible.
const BIG_TEXT = `// filler\n${'const x = 1;\n'.repeat(500)}`

beforeAll(() => {
  tmpDir = mkTempDir('http-helpers-')
  smallHtml = join(tmpDir, 'small.html')
  writeFileSync(smallHtml, '<html>hi</html>')
  bigJs = join(tmpDir, 'big.js')
  writeFileSync(bigJs, BIG_TEXT)
  bigPng = join(tmpDir, 'big.png')
  writeFileSync(bigPng, BIG_TEXT)
  bigUnknownExt = join(tmpDir, 'blob.bin')
  writeFileSync(bigUnknownExt, BIG_TEXT)
})

afterAll(() => {
  rmTempDir(tmpDir)
})

// ---------------------------------------------------------------------------
// MIME table / constants
// ---------------------------------------------------------------------------

describe('MIME table', () => {
  it('maps the extensions the dashboard serves', () => {
    expect(MIME['.html']).toBe('text/html; charset=utf-8')
    expect(MIME['.css']).toBe('text/css; charset=utf-8')
    expect(MIME['.js']).toBe('application/javascript; charset=utf-8')
    expect(MIME['.json']).toBe('application/json; charset=utf-8')
    expect(MIME['.png']).toBe('image/png')
    expect(MIME['.jpg']).toBe('image/jpeg')
    expect(MIME['.jpeg']).toBe('image/jpeg')
    expect(MIME['.webp']).toBe('image/webp')
    expect(MIME['.svg']).toBe('image/svg+xml')
  })
})

describe('DEFAULT_READ_BODY_MAX_BYTES', () => {
  it('is 20MB', () => {
    expect(DEFAULT_READ_BODY_MAX_BYTES).toBe(20 * 1024 * 1024)
  })
})

// ---------------------------------------------------------------------------
// RequestBodyTooLargeError
// ---------------------------------------------------------------------------

describe('RequestBodyTooLargeError', () => {
  it('carries the limit and a name callers can switch on', () => {
    const err = new RequestBodyTooLargeError(4096)
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('RequestBodyTooLargeError')
    expect(err.limit).toBe(4096)
    expect(err.message).toBe('Request body exceeded 4096 bytes')
  })
})

// ---------------------------------------------------------------------------
// readBody
// ---------------------------------------------------------------------------

describe('readBody', () => {
  it('concatenates chunks and resolves on end', async () => {
    const { req, emitter } = fakeStreamReq()
    const promise = readBody(req)
    emitter.emit('data', Buffer.from('hello '))
    emitter.emit('data', Buffer.from('world'))
    emitter.emit('end')
    await expect(promise).resolves.toEqual(Buffer.from('hello world'))
  })

  it('resolves an empty buffer when the request has no body', async () => {
    const { req, emitter } = fakeStreamReq()
    const promise = readBody(req)
    emitter.emit('end')
    const body = await promise
    expect(body.length).toBe(0)
  })

  it('rejects with RequestBodyTooLargeError and destroys the stream past maxBytes', async () => {
    const { req, emitter, destroyed } = fakeStreamReq()
    const promise = readBody(req, { maxBytes: 8 })
    emitter.emit('data', Buffer.from('123456789'))
    await expect(promise).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    await expect(promise).rejects.toMatchObject({ limit: 8 })
    expect(destroyed()).toBe(true)
  })

  it('counts bytes cumulatively across chunks, not per chunk', async () => {
    // Each chunk alone fits under the cap; only the running total trips it.
    const { req, emitter, destroyed } = fakeStreamReq()
    const promise = readBody(req, { maxBytes: 5 })
    emitter.emit('data', Buffer.from('abc'))
    emitter.emit('data', Buffer.from('def'))
    await expect(promise).rejects.toBeInstanceOf(RequestBodyTooLargeError)
    expect(destroyed()).toBe(true)
  })

  it('accepts a body exactly at the limit', async () => {
    // The guard is `total > maxBytes`, so an exact-size body must pass.
    const { req, emitter } = fakeStreamReq()
    const promise = readBody(req, { maxBytes: 5 })
    emitter.emit('data', Buffer.from('abcde'))
    emitter.emit('end')
    await expect(promise).resolves.toEqual(Buffer.from('abcde'))
  })

  it('stops buffering after the limit trips', async () => {
    // Post-rejection chunks must not be appended, and the already-settled
    // promise must not flip to resolved when a late `end` arrives.
    const { req, emitter } = fakeStreamReq()
    const promise = readBody(req, { maxBytes: 2 })
    emitter.emit('data', Buffer.from('abc'))
    emitter.emit('data', Buffer.from('def'))
    emitter.emit('end')
    await expect(promise).rejects.toBeInstanceOf(RequestBodyTooLargeError)
  })

  it('rejects when the stream errors', async () => {
    const { req, emitter } = fakeStreamReq()
    const promise = readBody(req)
    const boom = new Error('socket hang up')
    emitter.emit('error', boom)
    await expect(promise).rejects.toBe(boom)
  })

  it('falls back to DEFAULT_READ_BODY_MAX_BYTES when maxBytes is omitted', async () => {
    const { req, emitter } = fakeStreamReq()
    const promise = readBody(req, {})
    emitter.emit('data', Buffer.alloc(1024, 0x61))
    emitter.emit('end')
    const body = await promise
    expect(body.length).toBe(1024)
  })
})

// ---------------------------------------------------------------------------
// json
// ---------------------------------------------------------------------------

describe('json', () => {
  it('defaults to 200 with no-store cache headers', () => {
    const cap = fakeRes()
    json(cap.res, { ok: true })
    expect(cap.status()).toBe(200)
    expect(cap.header('Content-Type')).toBe('application/json; charset=utf-8')
    expect(cap.header('Cache-Control')).toBe('private, no-store')
    expect(cap.body()?.toString()).toBe('{"ok":true}')
  })

  it('honours an explicit status', () => {
    const cap = fakeRes()
    json(cap.res, { error: 'nope' }, 404)
    expect(cap.status()).toBe(404)
    expect(cap.body()?.toString()).toBe('{"error":"nope"}')
  })

  it('serialises undefined data as an empty body', () => {
    // JSON.stringify(undefined) is undefined, which res.end() treats as no body.
    const cap = fakeRes()
    json(cap.res, undefined)
    expect(cap.status()).toBe(200)
    expect(cap.body()?.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// jsonMaybeGzip / Accept-Encoding negotiation
// ---------------------------------------------------------------------------

describe('jsonMaybeGzip', () => {
  // Serialises well past GZIP_MIN_BYTES.
  const bigData = {
    rows: Array.from({ length: 200 }, (_, i) => ({ i, text: `row ${i} padding text` })),
  }

  it('gzips a large payload when the client accepts gzip', () => {
    const cap = fakeRes()
    jsonMaybeGzip(fakeReq({ 'accept-encoding': 'gzip, deflate, br' }), cap.res, bigData)
    expect(cap.status()).toBe(200)
    expect(cap.header('Content-Encoding')).toBe('gzip')
    expect(cap.header('Vary')).toBe('Accept-Encoding')
    expect(cap.header('Cache-Control')).toBe('private, no-store')
    expect(JSON.parse(gunzipSync(cap.body() as Buffer).toString())).toEqual(bigData)
  })

  it('sends a large payload plain when the client does not accept gzip', () => {
    const cap = fakeRes()
    jsonMaybeGzip(fakeReq(), cap.res, bigData)
    expect(cap.header('Content-Encoding')).toBeUndefined()
    // Vary is always sent so caches key on Accept-Encoding either way.
    expect(cap.header('Vary')).toBe('Accept-Encoding')
    expect(JSON.parse((cap.body() as Buffer).toString())).toEqual(bigData)
  })

  it('sends a small payload plain even when gzip is accepted', () => {
    const cap = fakeRes()
    jsonMaybeGzip(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, { ok: true })
    expect(cap.header('Content-Encoding')).toBeUndefined()
    expect((cap.body() as Buffer).toString()).toBe('{"ok":true}')
  })

  it('honours an explicit status on both the gzip and plain paths', () => {
    const gz = fakeRes()
    jsonMaybeGzip(fakeReq({ 'accept-encoding': 'gzip' }), gz.res, bigData, 201)
    expect(gz.status()).toBe(201)
    expect(gz.header('Content-Encoding')).toBe('gzip')

    const plain = fakeRes()
    jsonMaybeGzip(fakeReq(), plain.res, { error: 'nope' }, 500)
    expect(plain.status()).toBe(500)
  })

  describe('Accept-Encoding parsing', () => {
    // acceptsGzip is private; exercised through jsonMaybeGzip with a payload
    // that is always over the size threshold so only negotiation decides.
    function encodes(acceptEncoding: string | string[] | undefined): boolean {
      const cap = fakeRes()
      const headers: Record<string, string | string[] | undefined> =
        acceptEncoding === undefined ? {} : { 'accept-encoding': acceptEncoding }
      jsonMaybeGzip(fakeReq(headers), cap.res, bigData)
      return cap.header('Content-Encoding') === 'gzip'
    }

    it('accepts a bare gzip token', () => {
      expect(encodes('gzip')).toBe(true)
    })

    it('accepts gzip among other codings', () => {
      expect(encodes('deflate, gzip, br')).toBe(true)
      expect(encodes('br,gzip')).toBe(true)
    })

    it('is case-insensitive', () => {
      expect(encodes('GZIP')).toBe(true)
    })

    it('tolerates surrounding whitespace', () => {
      expect(encodes('  gzip  ')).toBe(true)
      expect(encodes('deflate,  gzip  , br')).toBe(true)
    })

    it('accepts gzip with a non-zero q value', () => {
      expect(encodes('gzip;q=1.0')).toBe(true)
      expect(encodes('gzip;q=0.5')).toBe(true)
      expect(encodes('gzip; q=0.001')).toBe(true)
    })

    it('rejects gzip explicitly disabled with q=0', () => {
      expect(encodes('gzip;q=0')).toBe(false)
      expect(encodes('gzip;q=0.0')).toBe(false)
      expect(encodes('gzip;q=0.000')).toBe(false)
      expect(encodes('gzip;q=0, deflate')).toBe(false)
    })

    it('rejects when gzip is absent', () => {
      expect(encodes('deflate')).toBe(false)
      expect(encodes('br, identity')).toBe(false)
    })

    it('does not match gzip as a substring of another coding', () => {
      expect(encodes('x-gzip-ish')).toBe(false)
    })

    it('returns false for a missing or empty header', () => {
      expect(encodes(undefined)).toBe(false)
      expect(encodes('')).toBe(false)
    })

    it('joins a string[] header before matching', () => {
      // Node surfaces duplicate header lines as string[]; RFC 7230 §3.2.2
      // says join with ", ".
      expect(encodes(['gzip'])).toBe(true)
      expect(encodes(['deflate', 'gzip'])).toBe(true)
      expect(encodes(['deflate', 'br'])).toBe(false)
      expect(encodes([])).toBe(false)
    })
  })
})

// ---------------------------------------------------------------------------
// etagMatches
// ---------------------------------------------------------------------------

describe('etagMatches', () => {
  it('returns false without an If-None-Match header', () => {
    expect(etagMatches(undefined, '"abc"')).toBe(false)
  })

  it('returns false for an empty string header', () => {
    expect(etagMatches('', '"abc"')).toBe(false)
  })

  it('matches an identical strong etag', () => {
    expect(etagMatches('"abc-123"', '"abc-123"')).toBe(true)
  })

  it('does not match a different etag', () => {
    expect(etagMatches('"abc-123"', '"def-456"')).toBe(false)
  })

  it('strips a single W/ weak-validator prefix', () => {
    expect(etagMatches('W/"abc-123"', '"abc-123"')).toBe(true)
  })

  it('leaves a doubled W/ prefix alone so the comparison misses', () => {
    expect(etagMatches('W/W/"abc"', '"abc"')).toBe(false)
  })

  it('does not match a bare unquoted value', () => {
    expect(etagMatches('abc-123', '"abc-123"')).toBe(false)
  })

  it('joins a string[] header with ", " before comparing', () => {
    expect(etagMatches(['"abc"'], '"abc"')).toBe(true)
    expect(etagMatches(['W/"abc"'], '"abc"')).toBe(true)
    expect(etagMatches(['"abc"', '"def"'], '"abc"')).toBe(false)
  })

  it('returns false for an empty array (joins to "")', () => {
    expect(etagMatches([], '"abc"')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// serveFile
// ---------------------------------------------------------------------------

describe('serveFile', () => {
  it('serves 200 with Content-Type, ETag, Last-Modified and no-cache', () => {
    const cap = fakeRes()
    serveFile(fakeReq(), cap.res, smallHtml)
    expect(cap.status()).toBe(200)
    expect(cap.header('Content-Type')).toBe('text/html; charset=utf-8')
    expect(cap.header('ETag')).toMatch(/^"[\d.]+-\d+"$/)
    expect(cap.header('Last-Modified')).toBeTruthy()
    expect(cap.header('Cache-Control')).toBe('no-cache')
    expect(cap.body()?.toString()).toBe('<html>hi</html>')
  })

  it('falls back to application/octet-stream for an unknown extension', () => {
    const cap = fakeRes()
    serveFile(fakeReq(), cap.res, bigUnknownExt)
    expect(cap.status()).toBe(200)
    expect(cap.header('Content-Type')).toBe('application/octet-stream')
  })

  it('serves 404 when the file does not exist', () => {
    const cap = fakeRes()
    serveFile(fakeReq(), cap.res, join(tmpDir, 'missing.html'))
    expect(cap.status()).toBe(404)
    expect(cap.body()?.toString()).toBe('Not found')
  })

  it('serves 404 when the path is a directory (readFileSync throws EISDIR)', () => {
    const cap = fakeRes()
    serveFile(fakeReq(), cap.res, tmpDir)
    expect(cap.status()).toBe(404)
  })

  describe('cacheSeconds', () => {
    it('sends private max-age instead of no-cache', () => {
      const cap = fakeRes()
      serveFile(fakeReq(), cap.res, smallHtml, { cacheSeconds: 3600 })
      expect(cap.header('Cache-Control')).toBe('private, max-age=3600')
    })

    it('keeps max-age on the 304 response', () => {
      const first = fakeRes()
      serveFile(fakeReq(), first.res, smallHtml, { cacheSeconds: 60 })
      const etag = first.header('ETag') as string

      const second = fakeRes()
      serveFile(fakeReq({ 'if-none-match': etag }), second.res, smallHtml, { cacheSeconds: 60 })
      expect(second.status()).toBe(304)
      expect(second.header('Cache-Control')).toBe('private, max-age=60')
    })

    it('treats cacheSeconds: 0 as no-cache (falsy)', () => {
      const cap = fakeRes()
      serveFile(fakeReq(), cap.res, smallHtml, { cacheSeconds: 0 })
      expect(cap.header('Cache-Control')).toBe('no-cache')
    })
  })

  describe('conditional GET', () => {
    it('serves 304 with an empty body on a matching ETag', () => {
      const first = fakeRes()
      serveFile(fakeReq(), first.res, smallHtml)
      const etag = first.header('ETag') as string

      const second = fakeRes()
      serveFile(fakeReq({ 'if-none-match': etag }), second.res, smallHtml)
      expect(second.status()).toBe(304)
      expect(second.body()?.length).toBe(0)
      expect(second.header('ETag')).toBe(etag)
      expect(second.header('Last-Modified')).toBeTruthy()
    })

    it('serves 304 for a weak (W/) form of the same ETag', () => {
      const first = fakeRes()
      serveFile(fakeReq(), first.res, smallHtml)
      const etag = first.header('ETag') as string

      const second = fakeRes()
      serveFile(fakeReq({ 'if-none-match': `W/${etag}` }), second.res, smallHtml)
      expect(second.status()).toBe(304)
    })

    it('serves the full body on a stale ETag', () => {
      const cap = fakeRes()
      serveFile(fakeReq({ 'if-none-match': '"stale-000"' }), cap.res, smallHtml)
      expect(cap.status()).toBe(200)
      expect(cap.body()?.toString()).toBe('<html>hi</html>')
    })

    it('omits Vary on a 304 for a non-compressible extension', () => {
      const first = fakeRes()
      serveFile(fakeReq(), first.res, bigPng)
      const etag = first.header('ETag') as string

      const second = fakeRes()
      serveFile(fakeReq({ 'if-none-match': etag }), second.res, bigPng)
      expect(second.status()).toBe(304)
      expect(second.header('Vary')).toBeUndefined()
    })

    it('sends Vary on a 304 for a compressible extension', () => {
      const first = fakeRes()
      serveFile(fakeReq(), first.res, bigJs)
      const etag = first.header('ETag') as string

      const second = fakeRes()
      serveFile(fakeReq({ 'if-none-match': etag }), second.res, bigJs)
      expect(second.status()).toBe(304)
      expect(second.header('Vary')).toBe('Accept-Encoding')
    })
  })

  describe('gzip', () => {
    it('gzips a large compressible file for a gzip-accepting client', () => {
      const cap = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, bigJs)
      expect(cap.status()).toBe(200)
      expect(cap.header('Content-Encoding')).toBe('gzip')
      expect(cap.header('Vary')).toBe('Accept-Encoding')
      expect(cap.header('ETag')).toMatch(/-gz"$/)
      expect(gunzipSync(cap.body() as Buffer).toString()).toBe(BIG_TEXT)
    })

    it('serves plain with a plain ETag when gzip is not accepted', () => {
      const cap = fakeRes()
      serveFile(fakeReq(), cap.res, bigJs)
      expect(cap.header('Content-Encoding')).toBeUndefined()
      expect(cap.header('ETag')).toMatch(/^"[\d.]+-\d+"$/)
      expect((cap.body() as Buffer).toString()).toBe(BIG_TEXT)
    })

    it('does not gzip a non-compressible extension', () => {
      const cap = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, bigPng)
      expect(cap.header('Content-Encoding')).toBeUndefined()
      expect(cap.header('Vary')).toBeUndefined()
    })

    it('does not gzip a file at or below GZIP_MIN_BYTES', () => {
      const cap = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, smallHtml)
      expect(cap.header('Content-Encoding')).toBeUndefined()
      // Vary is still sent: the extension is compressible, only size ruled it out.
      expect(cap.header('Vary')).toBe('Accept-Encoding')
    })

    it('gives the gzip variant a distinct ETag so caches cannot cross-serve it', () => {
      const gz = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), gz.res, bigJs)
      const gzEtag = gz.header('ETag') as string

      // A client that no longer accepts gzip must not be 304'd on it.
      const plain = fakeRes()
      serveFile(fakeReq({ 'if-none-match': gzEtag }), plain.res, bigJs)
      expect(plain.status()).toBe(200)
      expect(plain.header('Content-Encoding')).toBeUndefined()
    })

    it('serves 304 against the gzip-variant ETag for a gzip client', () => {
      const first = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), first.res, bigJs)
      const gzEtag = first.header('ETag') as string

      const second = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip', 'if-none-match': gzEtag }), second.res, bigJs)
      expect(second.status()).toBe(304)
      expect(second.body()?.length).toBe(0)
    })

    it('reuses the memoised gzip body for a repeat request', () => {
      // Second request must hit the gzipMemo (same path + same etag) and
      // return a byte-identical body.
      const first = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), first.res, bigJs)
      const second = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), second.res, bigJs)
      expect((second.body() as Buffer).equals(first.body() as Buffer)).toBe(true)
      expect(gunzipSync(second.body() as Buffer).toString()).toBe(BIG_TEXT)
    })

    it('evicts the oldest entry once the memo is full', () => {
      // GZIP_MEMO_MAX_ENTRIES is 20. Serving 21 distinct compressible files
      // drives one eviction; every response must still be correct afterwards.
      const paths: string[] = []
      for (let i = 0; i < 21; i++) {
        const p = join(tmpDir, `memo-${i}.css`)
        writeFileSync(p, `${BIG_TEXT}/* ${i} */`)
        paths.push(p)
      }

      for (const p of paths) {
        const cap = fakeRes()
        serveFile(fakeReq({ 'accept-encoding': 'gzip' }), cap.res, p)
        expect(cap.header('Content-Encoding')).toBe('gzip')
      }

      // The first file was evicted; re-serving it re-gzips and still matches.
      const again = fakeRes()
      serveFile(fakeReq({ 'accept-encoding': 'gzip' }), again.res, paths[0])
      expect(gunzipSync(again.body() as Buffer).toString()).toBe(`${BIG_TEXT}/* 0 */`)
    })
  })
})
