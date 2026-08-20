// 100% coverage suite for src/google-api.ts. The module imports node:https +
// reads/writes a token JSON file under the user's home dir, so the whole
// filesystem + https layer is replaced by deterministic mocks. The contract
// is the only thing exercised here -- not the live Google APIs.
//
// The mock factory is hoisted before the imports so each test can shape:
//   - what statSync reports (mtimeMs, or throw)
//   - what readFileSync returns (token JSON, client-creds JSON, or throw)
//   - what writeFileSync captures
//   - a queue of canned https responses (status, body, error, timeout)
//
// Module-level state (`cachedTokens`, `cachedClient`) is reset between tests
// via vi.resetModules() + dynamic re-import, since the cache is the unit
// under test for the loadTokens / mtime scenarios.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { EventEmitter } from 'node:events'

// ---------------------------------------------------------------------------
// Hoisted mock state shared between the factories below and the test body.
// ---------------------------------------------------------------------------

interface QueuedResponse {
  status: number
  body: string
  /** If set, the request fires this error on the request emitter. */
  error?: Error
  /** If set, the request fires its 'timeout' handler instead of a response. */
  timeout?: boolean
  /** If set, the response has statusCode === undefined (status falls back to 0). */
  omitStatusCode?: boolean
  /** If set, the response emitter fires 'error' before 'end'. */
  resError?: Error
}

const mockState = vi.hoisted(() => ({
  // os
  homedir: '/fake-home',
  // fs: statSync
  statMtimeMs: 1_000,
  statShouldThrow: false,
  // fs: readFileSync
  tokensContents: '' as string,
  credsContents: '' as string,
  readShouldThrow: false,
  readFileCalls: [] as string[],
  // fs: writeFileSync
  written: [] as Array<{ path: string; content: string }>,
  // https: queued responses (one per request)
  responses: [] as QueuedResponse[],
  requests: [] as Array<{ url: string; method: string | undefined; headers: Record<string, string> | undefined; body: string | undefined }>,
  // capture current Date.now so the 5-min skew math is deterministic
  nowMs: 2_000_000,
}))

// ---------------------------------------------------------------------------
// Mocks: node:os (homedir), node:fs (stat/read/write), node:https (request).
// ---------------------------------------------------------------------------

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: () => mockState.homedir }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((_p: unknown) => {
      if (mockState.statShouldThrow) throw new Error('ENOENT: stat failed')
      return { mtimeMs: mockState.statMtimeMs }
    }) as typeof actual.statSync,
    readFileSync: ((p: unknown, _enc: unknown) => {
      const path = String(p)
      mockState.readFileCalls.push(path)
      if (mockState.readShouldThrow) throw new Error('EACCES: read failed')
      if (path.endsWith('tokens.json')) return mockState.tokensContents
      if (path.endsWith('gcp-oauth.keys.json')) return mockState.credsContents
      throw new Error(`readFileSync: unstubbed path ${path}`)
    }) as typeof actual.readFileSync,
    writeFileSync: ((p: unknown, content: unknown) => {
      mockState.written.push({ path: String(p), content: String(content) })
    }) as typeof actual.writeFileSync,
  }
})

vi.mock('node:https', () => {
  type ReqEmitter = EventEmitter & {
    write: (b: string) => void
    end: () => void
    setTimeout: (ms: number, cb: () => void) => void
    destroy: (e: Error) => void
    timeoutMs: number
    timeoutCb: (() => void) | null
  }
  type ResEmitter = EventEmitter & { statusCode: number }
  return {
    default: {
      request: ((
        url: string,
        options: { method?: string; headers?: Record<string, string> },
        cb: (res: ResEmitter) => void,
      ) => {
        const req = new EventEmitter() as ReqEmitter
        let bodyBuf = ''
        req.write = (b: string) => { bodyBuf += b }
        req.timeoutMs = 0
        req.timeoutCb = null
        req.setTimeout = (ms: number, cb: () => void) => {
          req.timeoutMs = ms
          req.timeoutCb = cb
        }
        req.destroy = (e: Error) => { req.emit('error', e) }
        req.end = () => {
          mockState.requests.push({ url, method: options?.method, headers: options?.headers, body: bodyBuf })
          const resp = mockState.responses.shift()
          if (!resp) {
            req.emit('error', new Error('no response queued'))
            return
          }
          if (resp.timeout) {
            req.timeoutCb?.()
            return
          }
          if (resp.error) {
            req.emit('error', resp.error)
            return
          }
          const res = new EventEmitter() as ResEmitter
          res.statusCode = resp.omitStatusCode ? (undefined as unknown as number) : resp.status
          cb(res)
          if (resp.body) res.emit('data', Buffer.from(resp.body))
          if (resp.resError) res.emit('error', resp.resError)
          res.emit('end')
        }
        return req as unknown as ReturnType<typeof import('node:https').request>
      }) as unknown as typeof import('node:https').request,
    },
  }
})

// ---------------------------------------------------------------------------
// Helpers: a fresh token JSON, a fresh client-creds JSON, reset module state.
// ---------------------------------------------------------------------------

const TOKENS_PATH = '/fake-home/.config/google-calendar-mcp/tokens.json'
const CREDS_PATH = '/fake-home/.gmail-mcp/gcp-oauth.keys.json'

function tokensJson(over: Partial<{ access_token: string; refresh_token: string; expiry_date: number; token_type: string; scope: string }> = {}): string {
  return JSON.stringify({
    normal: {
      access_token: 'old-access',
      refresh_token: 'old-refresh',
      expiry_date: mockState.nowMs + 60 * 60 * 1000,
      token_type: 'Bearer',
      scope: 'https://www.googleapis.com/auth/calendar',
      ...over,
    },
  })
}

function credsJson(): string {
  return JSON.stringify({
    installed: {
      client_id: 'cid-123',
      client_secret: 'sec-456',
      token_uri: 'https://oauth2.googleapis.com/token',
    },
  })
}

function seedFs(): void {
  mockState.tokensContents = tokensJson({ access_token: 'tok-default', refresh_token: 'ref-default', expiry_date: mockState.nowMs + 60 * 60 * 1000 })
  mockState.credsContents = credsJson()
}

async function importFresh(): Promise<typeof import('../google-api.js')> {
  // Bypass module-level cache so cachedTokens / cachedClient start clean.
  vi.resetModules()
  // Re-run the hoisted mocks against the freshly loaded module.
  vi.doMock('node:os', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:os')>()
    return { ...actual, homedir: () => mockState.homedir }
  })
  vi.doMock('node:fs', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs')>()
    return {
      ...actual,
      statSync: ((_p: unknown) => {
        if (mockState.statShouldThrow) throw new Error('ENOENT: stat failed')
        return { mtimeMs: mockState.statMtimeMs }
      }) as typeof actual.statSync,
      readFileSync: ((p: unknown, _enc: unknown) => {
        const path = String(p)
        mockState.readFileCalls.push(path)
        if (mockState.readShouldThrow) throw new Error('EACCES: read failed')
        if (path.endsWith('tokens.json')) return mockState.tokensContents
        if (path.endsWith('gcp-oauth.keys.json')) return mockState.credsContents
        throw new Error(`readFileSync: unstubbed path ${path}`)
      }) as typeof actual.readFileSync,
      writeFileSync: ((p: unknown, content: unknown) => {
        mockState.written.push({ path: String(p), content: String(content) })
      }) as typeof actual.writeFileSync,
    }
  })
  vi.doMock('node:https', () => {
    type ReqEmitter = EventEmitter & {
      write: (b: string) => void
      end: () => void
      setTimeout: (ms: number, cb: () => void) => void
      destroy: (e: Error) => void
      timeoutMs: number
      timeoutCb: (() => void) | null
    }
    type ResEmitter = EventEmitter & { statusCode: number }
    return {
      default: {
        request: ((
          url: string,
          options: { method?: string; headers?: Record<string, string> },
          cb: (res: ResEmitter) => void,
        ) => {
          const req = new EventEmitter() as ReqEmitter
          let bodyBuf = ''
          req.write = (b: string) => { bodyBuf += b }
          req.timeoutMs = 0
          req.timeoutCb = null
          req.setTimeout = (ms: number, cb: () => void) => {
            req.timeoutMs = ms
            req.timeoutCb = cb
          }
          req.destroy = (e: Error) => { req.emit('error', e) }
          req.end = () => {
            mockState.requests.push({ url, method: options?.method, headers: options?.headers, body: bodyBuf })
            const resp = mockState.responses.shift()
            if (!resp) {
              req.emit('error', new Error('no response queued'))
              return
            }
            if (resp.timeout) {
              req.timeoutCb?.()
              return
            }
            if (resp.error) {
              req.emit('error', resp.error)
              return
            }
            const res = new EventEmitter() as ResEmitter
            res.statusCode = resp.omitStatusCode ? (undefined as unknown as number) : resp.status
            cb(res)
            if (resp.body) res.emit('data', Buffer.from(resp.body))
            if (resp.resError) res.emit('error', resp.resError)
            res.emit('end')
          }
          return req as unknown as ReturnType<typeof import('node:https').request>
        }) as unknown as typeof import('node:https').request,
      },
    }
  })
  return await import('../google-api.js')
}

beforeEach(() => {
  mockState.homedir = '/fake-home'
  mockState.statMtimeMs = 1_000
  mockState.statShouldThrow = false
  mockState.tokensContents = ''
  mockState.credsContents = ''
  mockState.readShouldThrow = false
  mockState.readFileCalls.length = 0
  mockState.written.length = 0
  mockState.responses.length = 0
  mockState.requests.length = 0
  mockState.nowMs = 2_000_000
  vi.useFakeTimers()
  vi.setSystemTime(mockState.nowMs)
  seedFs()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.doUnmock('node:os')
  vi.doUnmock('node:fs')
  vi.doUnmock('node:https')
})

// ---------------------------------------------------------------------------
// loadTokens() -- cache + mtime invalidation (the 2026-06-02 14:30 regression).
// We exercise it indirectly via getValidAccessToken / refreshAccessToken,
// which are the only call sites.
// ---------------------------------------------------------------------------

describe('loadTokens cache + mtime', () => {
  it('reads the token JSON on first call and caches it', async () => {
    mockState.statMtimeMs = 1234
    const { getCalendarEvents } = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })

    await getCalendarEvents('cal-1', new Date(0), new Date(1))

    expect(mockState.readFileCalls.filter((p) => p === TOKENS_PATH)).toHaveLength(1)
    // The CREDS_PATH is read only when refresh is triggered.
    expect(mockState.readFileCalls.filter((p) => p === CREDS_PATH)).toHaveLength(0)
  })

  it('re-uses the cache when the file mtime is unchanged (no second read)', async () => {
    mockState.statMtimeMs = 9999
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [{ id: 'e1' }] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [{ id: 'e2' }] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    // Two getCalendarEvents calls but the cache was populated on the first;
    // the second should reuse cachedTokens and skip readFileSync on TOKENS_PATH.
    const tokenReads = mockState.readFileCalls.filter((p) => p === TOKENS_PATH)
    expect(tokenReads).toHaveLength(1)
  })

  it('re-reads the token JSON when the on-disk mtime advances (out-of-process re-auth)', async () => {
    // First call sees mtime=1000, second call sees mtime=2000 (auth subcommand
    // just wrote a fresh tokens.json from another process). The cache must
    // detect the mtime delta and re-read instead of returning the stale one.
    mockState.statMtimeMs = 1000
    mockState.tokensContents = tokensJson({ access_token: 'old-access', refresh_token: 'old-refresh' })
    const { getCalendarEvents } = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await getCalendarEvents('cal-1', new Date(0), new Date(1))

    // Out-of-process auth subcommand overwrites the file.
    mockState.statMtimeMs = 2000
    mockState.tokensContents = tokensJson({ access_token: 'new-access', refresh_token: 'new-refresh' })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await getCalendarEvents('cal-1', new Date(0), new Date(1))

    const tokenReads = mockState.readFileCalls.filter((p) => p === TOKENS_PATH)
    expect(tokenReads).toHaveLength(2)
  })

  it('handles statSync throwing (file missing at stat time) without short-circuiting the read', async () => {
    // statSync ENOENT -> currentMtime falls back to 0; cache miss on first
    // call (cachedTokens is null), so readFileSync is allowed to throw the
    // explicit EACCES to the caller.
    mockState.statShouldThrow = true
    mockState.readShouldThrow = true
    const { getCalendarEvents } = await importFresh()
    await expect(getCalendarEvents('cal-1', new Date(0), new Date(1))).rejects.toThrow('EACCES')
  })

  it('saveTokens with a post-write stat failure records mtimeMs=0 in the cache (covers the saveTokens catch branch)', async () => {
    // First call: stat works, mtime=5000 cached; refresh triggered because
    // the token is already expired.
    mockState.statMtimeMs = 5000
    mockState.tokensContents = tokensJson({ access_token: 'tok-pre', expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'tok-new', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))

    // Now force the post-write stat in saveTokens to throw. We do this by
    // making statShouldThrow=true and triggering a second refresh.
    mockState.statShouldThrow = true
    mockState.tokensContents = tokensJson({ access_token: 'tok-pre-2', expiry_date: mockState.nowMs - 1000 })
    // Force the cache to invalidate by advancing the (now-throwing) stat's
    // effective mtime -- since stat throws, effective mtime=0. cachedTokens
    // currently has mtime=5000. So the `mtimeMs !== currentMtime` check
    // (0 !== 5000) re-reads. Good.
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'tok-new-2', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))

    // saveTokens wrote with stat failing -> cache.mtimeMs=0.
    // The next load sees stat failing -> currentMtime=0 -> cache hit, no re-read.
    const readsBefore = mockState.readFileCalls.filter((p) => p === TOKENS_PATH).length
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const readsAfter = mockState.readFileCalls.filter((p) => p === TOKENS_PATH).length
    expect(readsAfter).toBe(readsBefore)
    // saveTokens wrote twice with the catch branch firing the second time.
    const tokenWrites = mockState.written.filter((w) => w.path === TOKENS_PATH)
    expect(tokenWrites).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// saveTokens() -- writes the { normal } wrapper AND records the post-write
// mtime in the cache so the next loadTokens hits the cache instead of
// re-reading from disk.
// ---------------------------------------------------------------------------

describe('saveTokens post-write cache update', () => {
  it('writes only { normal: tokens } to disk (no mtimeMs leak)', async () => {
    mockState.statMtimeMs = 5000
    mockState.tokensContents = tokensJson({ access_token: 'tok-pre', refresh_token: 'ref-pre', expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'tok-new', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const lastWrite = mockState.written.at(-1)!
    expect(lastWrite.path).toBe(TOKENS_PATH)
    expect(lastWrite.content).not.toContain('mtimeMs')
    const parsed = JSON.parse(lastWrite.content)
    expect(parsed).toEqual({
      normal: expect.objectContaining({
        access_token: 'tok-new',
        refresh_token: 'ref-pre',
        token_type: 'Bearer',
        scope: expect.any(String),
      }),
    })
  })

  it('records the post-write mtime so the next loadTokens skips a re-read', async () => {
    mockState.statMtimeMs = 5000
    mockState.tokensContents = tokensJson({ access_token: 'a', expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    // First call: triggers refresh, writes the file, caches mtime=5000.
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'b', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const readsBefore = mockState.readFileCalls.filter((p) => p === TOKENS_PATH).length
    // Second call (token now valid for ~1h): should reuse the cache, not re-read.
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const readsAfter = mockState.readFileCalls.filter((p) => p === TOKENS_PATH).length
    expect(readsAfter).toBe(readsBefore)
  })
})

// ---------------------------------------------------------------------------
// loadClientCredentials() -- cached on first call, never re-read.
// ---------------------------------------------------------------------------

describe('loadClientCredentials cache', () => {
  it('reads the credentials JSON on first refresh only', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ access_token: 'a', expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'b', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    // Trigger a second refresh to prove the creds cache is reused.
    mockState.tokensContents = tokensJson({ access_token: 'a2', expiry_date: mockState.nowMs - 1000 })
    // Stat advances so tokens cache invalidates; creds cache stays.
    mockState.statMtimeMs = 2
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'b2', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const credsReads = mockState.readFileCalls.filter((p) => p === CREDS_PATH)
    expect(credsReads).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// refreshAccessToken() -- happy path, error path, request-error path.
// ---------------------------------------------------------------------------

describe('refreshAccessToken', () => {
  it('POSTs x-www-form-urlencoded with the right params and saves the new token', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ refresh_token: 'rt-old', expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({
      status: 200,
      body: JSON.stringify({ access_token: 'rt-new', expires_in: 3600 }),
    })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const refreshReq = mockState.requests[0]!
    expect(refreshReq.url).toBe('https://oauth2.googleapis.com/token')
    expect(refreshReq.method).toBe('POST')
    expect(refreshReq.headers!['Content-Type']).toBe('application/x-www-form-urlencoded')
    expect(refreshReq.body).toContain('client_id=cid-123')
    expect(refreshReq.body).toContain('client_secret=sec-456')
    expect(refreshReq.body).toContain('refresh_token=rt-old')
    expect(refreshReq.body).toContain('grant_type=refresh_token')
    // tokens.json was rewritten
    const lastWrite = mockState.written.at(-1)!
    const parsed = JSON.parse(lastWrite.content)
    expect(parsed.normal.access_token).toBe('rt-new')
    expect(parsed.normal.expiry_date).toBeGreaterThan(mockState.nowMs)
  })

  it('throws on non-200 from the token endpoint', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 400, body: '{"error":"invalid_grant"}' })
    await expect(mod.getCalendarEvents('cal-1', new Date(0), new Date(1))).rejects.toThrow('Token refresh failed: 400')
  })

  it('rejects when the token endpoint request itself errors', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({ error: new Error('ECONNRESET') })
    await expect(mod.getCalendarEvents('cal-1', new Date(0), new Date(1))).rejects.toThrow('ECONNRESET')
  })
})

// ---------------------------------------------------------------------------
// refreshAccessToken race: two concurrent getCalendarEvents calls when the
// cached access token is already expired both fire refresh requests. The
// current implementation does NOT deduplicate (each await chain runs its
// own refresh + save), which is a documented defect -- see the pinned bug
// file. The test pins the current behaviour: both refresh calls succeed
// and the second save overwrites the first.
// ---------------------------------------------------------------------------

describe('refreshAccessToken race (single-flight wrapper)', () => {
  it('coalesces two concurrent callers into a single refresh request + single saveTokens write', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'new-1', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'new-2', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await Promise.all([
      mod.getCalendarEvents('cal-1', new Date(0), new Date(1)),
      mod.getCalendarEvents('cal-2', new Date(0), new Date(1)),
    ])
    const refreshes = mockState.requests.filter((r) => r.url === 'https://oauth2.googleapis.com/token')
    expect(refreshes).toHaveLength(1)
    const tokenWrites = mockState.written.filter((w) => w.path === TOKENS_PATH)
    expect(tokenWrites).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// getValidAccessToken -- the 5-minute skew branch.
// ---------------------------------------------------------------------------

describe('getValidAccessToken 5-minute skew', () => {
  it('returns the cached access token when expiry is more than 5 minutes away', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ access_token: 'cached', expiry_date: mockState.nowMs + 10 * 60 * 1000 })
    const mod = await importFresh()
    // No https response queued -- if refresh ran, the mock would emit 'no response queued'.
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const refreshes = mockState.requests.filter((r) => r.url === 'https://oauth2.googleapis.com/token')
    expect(refreshes).toHaveLength(0)
    // The events request carried the cached bearer.
    const eventsReq = mockState.requests[0]!
    expect(eventsReq.headers!['Authorization']).toBe('Bearer cached')
  })

  it('refreshes when the expiry is within the 5-minute skew window', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({
      access_token: 'about-to-expire',
      expiry_date: mockState.nowMs + 2 * 60 * 1000, // 2 minutes away
    })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'newly-issued', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const refreshes = mockState.requests.filter((r) => r.url === 'https://oauth2.googleapis.com/token')
    expect(refreshes).toHaveLength(1)
  })

  it('refreshes when the token has already expired', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ access_token: 'old', expiry_date: mockState.nowMs - 60_000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'fresh', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(mockState.requests.filter((r) => r.url === 'https://oauth2.googleapis.com/token')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// getCalendarEvents -- happy path, 401 retry path, error paths.
// ---------------------------------------------------------------------------

describe('getCalendarEvents happy path', () => {
  it('returns the items array from a 200 response', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ access_token: 'tok', expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({
      status: 200,
      body: JSON.stringify({
        items: [
          { id: 'evt-1', summary: 'standup' },
          { id: 'evt-2', summary: 'lunch' },
        ],
      }),
    })
    const events = await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(events).toEqual([
      { id: 'evt-1', summary: 'standup' },
      { id: 'evt-2', summary: 'lunch' },
    ])
  })

  it('returns [] when the response has no items field', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: '{}' })
    const events = await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(events).toEqual([])
  })

  it('encodes the calendarId in the URL', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: '{"items":[]}' })
    await mod.getCalendarEvents('foo/bar baz', new Date(0), new Date(1))
    const eventsReq = mockState.requests[0]!
    expect(eventsReq.url).toContain(encodeURIComponent('foo/bar baz'))
    expect(eventsReq.url).not.toContain('foo/bar baz')
  })

  it('includes timeMin / timeMax / singleEvents / orderBy / maxResults=20', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: '{"items":[]}' })
    const tMin = new Date('2026-06-01T10:00:00.000Z')
    const tMax = new Date('2026-06-01T18:00:00.000Z')
    await mod.getCalendarEvents('cal-1', tMin, tMax)
    const eventsReq = mockState.requests[0]!
    expect(eventsReq.url).toContain('timeMin=2026-06-01T10%3A00%3A00.000Z')
    expect(eventsReq.url).toContain('timeMax=2026-06-01T18%3A00%3A00.000Z')
    expect(eventsReq.url).toContain('singleEvents=true')
    expect(eventsReq.url).toContain('orderBy=startTime')
    expect(eventsReq.url).toContain('maxResults=20')
  })
})

describe('getCalendarEvents non-200 / non-401 error path', () => {
  it('returns [] and logs when the API returns 500', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 500, body: 'internal' })
    const events = await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(events).toEqual([])
    // Only one request -- no refresh triggered.
    expect(mockState.requests).toHaveLength(1)
  })

  it('returns [] when statusCode is undefined (falls back to 0)', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: '{}', omitStatusCode: true })
    const events = await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(events).toEqual([])
  })
})

describe('getCalendarEvents 401 retry path', () => {
  it('refreshes the token, retries with the new bearer, and returns the items', async () => {
    mockState.statMtimeMs = 1
    // First call returns 401 -- the cached token has just expired mid-flight.
    mockState.tokensContents = tokensJson({
      access_token: 'stale',
      expiry_date: mockState.nowMs + 60 * 60 * 1000, // still valid by clock, but server rejects
    })
    const mod = await importFresh()
    mockState.responses.push({ status: 401, body: '{"error":"unauthorized"}' }) // events call 1
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'rotated', expires_in: 3600 }) }) // refresh
    mockState.responses.push({
      status: 200,
      body: JSON.stringify({ items: [{ id: 'evt-retry' }] }),
    }) // events call 2 (retry)
    const events = await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(events).toEqual([{ id: 'evt-retry' }])
    // Three requests total: events, refresh, events.
    expect(mockState.requests).toHaveLength(3)
    const events2 = mockState.requests[2]!
    expect(events2.headers!['Authorization']).toBe('Bearer rotated')
    expect(events2.url).toBe(mockState.requests[0]!.url) // retry hits the same URL
  })

  it('returns [] when the retry-after-refresh returns a non-200', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 401, body: '{}' }) // events call 1
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'rotated', expires_in: 3600 }) }) // refresh
    mockState.responses.push({ status: 503, body: 'still down' }) // events call 2 (retry fails)
    const events = await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(events).toEqual([])
    expect(mockState.requests).toHaveLength(3)
  })

  it('returns [] when the retry-after-refresh response has no items field', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 401, body: '{}' })
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'rotated', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: '{}' })
    const events = await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    expect(events).toEqual([])
  })

  it('propagates the error when the underlying request rejects (not 401)', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ error: new Error('socket hang up') })
    await expect(mod.getCalendarEvents('cal-1', new Date(0), new Date(1))).rejects.toThrow('socket hang up')
  })
})

// ---------------------------------------------------------------------------
// httpsRequest: timeout path, response-error path, statusCode-undefined path.
// ---------------------------------------------------------------------------

describe('httpsRequest internal branches', () => {
  it('rejects with a timeout Error when the request exceeds the configured deadline', async () => {
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ timeout: true })
    await expect(mod.getCalendarEvents('cal-1', new Date(0), new Date(1))).rejects.toThrow(/timed out after \d+ms/)
  })

  it('rejects when the response emitter fires error (covers the res.on("error") listener)', async () => {
    // The source registers `res.on('error', reject)` -- we exercise it by
    // emitting 'error' on the response. The promise rejects with that error.
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({
      status: 200,
      body: '',
      resError: new Error('socket torn'),
    })
    await expect(mod.getCalendarEvents('cal-1', new Date(0), new Date(1))).rejects.toThrow('socket torn')
  })

  it('forwards the body via req.write when one is provided (refresh uses POST body)', async () => {
    // The refresh POST writes a non-empty body. Verify the captured request
    // records the body the mock received via req.write().
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ refresh_token: 'rt', expiry_date: mockState.nowMs - 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: JSON.stringify({ access_token: 'rt-new', expires_in: 3600 }) })
    mockState.responses.push({ status: 200, body: JSON.stringify({ items: [] }) })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const refreshReq = mockState.requests[0]!
    expect(refreshReq.body).toBeDefined()
    expect(refreshReq.body!.length).toBeGreaterThan(0)
  })

  it('omits the body write when one is not provided (GET request branch)', async () => {
    // For the events GET, httpsRequest is called without a body. Verify the
    // captured body is the empty string.
    mockState.statMtimeMs = 1
    mockState.tokensContents = tokensJson({ expiry_date: mockState.nowMs + 60 * 60 * 1000 })
    const mod = await importFresh()
    mockState.responses.push({ status: 200, body: '{"items":[]}' })
    await mod.getCalendarEvents('cal-1', new Date(0), new Date(1))
    const eventsReq = mockState.requests[0]!
    expect(eventsReq.body).toBe('')
  })
})
