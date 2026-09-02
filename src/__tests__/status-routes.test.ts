// Tests for the read-only /api/status route (src/web/routes/status.ts).
// The handler is "pure" relative to project state: it only touches the network
// (status.claude.com) and writes a JSON body. We isolate those two surfaces by
// stubbing global fetch per-test, and assert on the captured response body.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

function mkRes() {
  const res: { statusCode: number; headers: Record<string, string | string[]>; body: string; writeHead: any; end: any } = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status: number, headers?: Record<string, string | string[]>) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(data?: string) {
      if (data !== undefined) this.body += data
    },
  }
  return res as unknown as http.ServerResponse & {
    statusCode: number
    headers: Record<string, string | string[]>
    body: string
  }
}

function mkCtx(path: string, method: string): RouteContext {
  const res = mkRes()
  const req = { headers: {} } as unknown as http.IncomingMessage
  return {
    req,
    res,
    path,
    method,
    url: new URL(`http://localhost:3420${path}`),
    fedPeer: null,
  }
}

function mkTextResponse(body: string, ok = true): Response {
  return new Response(body, {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/rss+xml' },
  })
}

function mkJsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { 'Content-Type': 'application/json' },
  })
}

async function call(handler: (ctx: RouteContext) => Promise<boolean>, path: string, method: string): Promise<{
  handled: boolean
  res: ReturnType<typeof mkRes>
  body: any
}> {
  const ctx = mkCtx(path, method)
  const handled = await handler(ctx)
  return { handled, res: ctx.res as unknown as ReturnType<typeof mkRes>, body: ((ctx.res as unknown as { body?: string }).body ? JSON.parse((ctx.res as unknown as { body?: string }).body as string) : null) }
}

const { tryHandleStatus } = await import('../web/routes/status.js')

function rssWrap(items: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?><rss><channel>${items}</channel></rss>`
}

function rssItem(opts: {
  title?: string
  description?: string
  pubDate?: string
  link?: string
}): string {
  return (
    '<item>' +
    `<title>${opts.title ?? ''}</title>` +
    `<description>${opts.description ?? ''}</description>` +
    `<pubDate>${opts.pubDate ?? ''}</pubDate>` +
    `<link>${opts.link ?? ''}</link>` +
    '</item>'
  )
}

describe('tryHandleStatus -- non-matching inputs', () => {
  it('returns false for an unrelated path', async () => {
    const r = await call(tryHandleStatus, '/api/other', 'GET')
    expect(r.handled).toBe(false)
    expect(r.res.statusCode).toBe(0)
  })

  it('returns false for /api/status with a non-GET method (POST)', async () => {
    const r = await call(tryHandleStatus, '/api/status', 'POST')
    expect(r.handled).toBe(false)
  })

  it('returns false for /api/status with PUT', async () => {
    const r = await call(tryHandleStatus, '/api/status', 'PUT')
    expect(r.handled).toBe(false)
  })
})

describe('tryHandleStatus -- GET /api/status with RSS', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns operational overall when RSS has a resolved incident only', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return mkTextResponse(rssWrap(rssItem({
          title: 'Resolved outage',
          description: 'Issue has been resolved. All systems normal.',
          pubDate: 'Mon, 04 Aug 2026 12:00:00 +0000',
          link: 'https://status.claude.com/incidents/abc',
        })))
      }
      // Component fetch
      return mkJsonResponse({ components: [{ name: 'API', status: 'operational' }] })
    })
    vi.stubGlobal('fetch', fetchMock)

    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(200)
    expect(r.body.overall).toBe('operational')
    expect(r.body.incidents).toHaveLength(1)
    expect(r.body.incidents[0].status).toBe('resolved')
    expect(r.body.incidents[0].title).toBe('Resolved outage')
    expect(r.body.incidents[0].link).toBe('https://status.claude.com/incidents/abc')
    expect(r.body.components).toEqual([{ name: 'API', status: 'operational' }])
    expect(typeof r.body.fetchedAt).toBe('number')
  })

  it('marks status investigating by default when no keyword matches', async () => {
    const fetchMock = vi.fn(async () => {
      if (true) {
        return mkTextResponse(rssWrap(rssItem({
          description: 'We are looking into it.',
          title: 'T',
          link: 'L',
          pubDate: 'P',
        })))
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.overall).toBe('degraded')
    expect(r.body.incidents[0].status).toBe('investigating')
  })

  it('marks status "monitoring" when description contains "monitoring" (case-insensitive)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return mkTextResponse(rssWrap(rssItem({
          title: 'T',
          description: 'We are Monitoring the situation.',
          link: 'L',
          pubDate: 'P',
        })))
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.incidents[0].status).toBe('monitoring')
  })

  it('marks status "identified" when description contains "identified"', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return mkTextResponse(rssWrap(rssItem({
          title: 'T',
          description: 'Root cause has been Identified.',
          link: 'L',
          pubDate: 'P',
        })))
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.incidents[0].status).toBe('identified')
  })

  it('decodes HTML entities &lt; &gt; &amp; &apos; and then strips any resulting tags from description', async () => {
    // The handler first decodes &lt;/&gt;/&amp;/&apos; into literal chars, then
    // strips ALL <...> tags. After both passes the inner <b> becomes a tag and
    // gets stripped, leaving "a & c's" -- i.e. the entity decoding happens BEFORE
    // the tag-stripping pass on purpose.
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return mkTextResponse(rssWrap(rssItem({
          title: 'T',
          description: 'a &lt;b&gt; &amp; c&apos;s',
          link: 'L',
          pubDate: 'P',
        })))
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.incidents[0].description).toBe('a & c\'s')
  })

  it('strips inner HTML tags and collapses whitespace in the description', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return mkTextResponse(rssWrap(rssItem({
          title: 'T',
          description: '<p>Hello   <em>world</em></p>  done',
          link: 'L',
          pubDate: 'P',
        })))
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.incidents[0].description).toBe('Hello world done')
  })

  it('sets overall to degraded when any item is not resolved', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return mkTextResponse(rssWrap(
          rssItem({ title: 'old', description: 'Issue resolved.', link: 'l', pubDate: 'p' }) +
          rssItem({ title: 'live', description: 'We are investigating.', link: 'l2', pubDate: 'p2' }),
        ))
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.overall).toBe('degraded')
    expect(r.body.incidents).toHaveLength(2)
  })

  it('caps incidents at 15 (slice(0, 15))', async () => {
    // Build a body with 20 distinct items via a Blob, mirrored to what the
    // runtime Response constructor accepts cleanly.
    const itemTexts: string[] = []
    for (let i = 0; i < 20; i++) {
      itemTexts.push(rssItem({ title: `t${i}`, description: `desc ${i}`, link: `l${i}`, pubDate: `p${i}` }))
    }
    const rssBody = rssWrap(itemTexts.join(''))
    const expectedMatchCount = (rssBody.match(/<item>/g) || []).length
    expect(expectedMatchCount).toBe(20)

    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return new Response(rssBody, {
          status: 200,
          headers: { 'Content-Type': 'application/rss+xml' },
        })
      }
      return new Response(JSON.stringify({ components: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.incidents.length).toBe(15)
    expect(r.body.incidents[0].title).toBe('t0')
    expect(r.body.incidents[14].title).toBe('t14')
  })

  it('handles RSS items missing all fields (empty strings)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return mkTextResponse(rssWrap('<item></item>'))
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.incidents).toHaveLength(1)
    expect(r.body.incidents[0]).toMatchObject({
      title: '',
      description: '',
      pubDate: '',
      link: '',
      status: 'investigating',
    })
  })

  it('handles RSS with no items: overall operational, incidents []', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) return mkTextResponse(rssWrap(''))
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.overall).toBe('operational')
    expect(r.body.incidents).toEqual([])
  })
})

describe('tryHandleStatus -- components fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('uses an empty components array when the components response is not ok', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) return mkTextResponse(rssWrap(''))
      return mkJsonResponse({}, false)
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.components).toEqual([])
  })

  it('filters out component groups and keeps only leaf services', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) return mkTextResponse(rssWrap(''))
      return mkJsonResponse({
        components: [
          { name: 'API Group', status: 'operational', group: true },
          { name: 'API', status: 'operational' },
          { name: 'Console', status: 'degraded' },
        ],
      })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.components).toEqual([
      { name: 'API', status: 'operational' },
      { name: 'Console', status: 'degraded' },
    ])
  })

  it('falls back to empty components when the components field is missing', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) return mkTextResponse(rssWrap(''))
      return mkJsonResponse({})
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.components).toEqual([])
  })

  it('falls back to empty components when the components fetch throws (catch arm)', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) return mkTextResponse(rssWrap(''))
      throw new Error('network down')
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.components).toEqual([])
    expect(r.body.overall).toBe('operational')
  })
})

describe('tryHandleStatus -- RSS fetch error arm', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('returns overall unknown with an error message when the RSS fetch throws', async () => {
    const fetchMock = vi.fn(async () => {
      throw new Error('upstream timeout')
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(200)
    expect(r.body).toEqual({
      overall: 'unknown',
      components: [],
      incidents: [],
      fetchedAt: expect.any(Number),
      error: 'Failed to fetch status',
    })
  })

  it('returns overall unknown when rssResponse.text() throws', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) {
        return {
          ok: true,
          status: 200,
          text: async () => { throw new Error('boom') },
        } as unknown as Response
      }
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.body.overall).toBe('unknown')
    expect(r.body.error).toBe('Failed to fetch status')
  })
})

describe('tryHandleStatus -- response headers', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('sets Content-Type application/json on the success response', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) return mkTextResponse(rssWrap(''))
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })

  it('uses jsonMaybeGzip -- payload under 1KB and no Accept-Encoding: no gzip', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/history.rss')) return mkTextResponse(rssWrap(''))
      return mkJsonResponse({ components: [] })
    })
    vi.stubGlobal('fetch', fetchMock)
    const r = await call(tryHandleStatus, '/api/status', 'GET')
    expect(r.res.headers['Content-Encoding']).toBeUndefined()
  })
})
