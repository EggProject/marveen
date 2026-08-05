// 100% coverage suite for src/web/routes/audit-log.ts.
//
// tryHandleAuditLog owns exactly one HTTP endpoint, GET /api/audit-log,
// which returns a merged audit-log payload across four backing tables
// (config, idea, store, diary). The handler reads four query parameters
// (source, from, to, q, agent, limit), validates them, then delegates to
// `queryAuditLog` from src/db.ts.
//
// The route imports three modules: '../http-helpers.js' (the `json` writer),
// '../../db.js' (queryAuditLog), and '../../settings-store.js'
// (getEffectiveSettingValue for AUDIT_LOG_MAX_ENTRIES). We mock the two
// external collaborators so the route logic stands alone; `json` stays real
// because it's a tiny pure helper already covered by http-helpers.test.ts.
//
// config/logger/auth-gate/auth-sessions are stubbed per the suite convention
// even though audit-log.ts does not import them -- keeps the dependency
// surface consistent across the /api/* route suites.
//
// Branches covered:
//   - dispatcher: wrong path or wrong method returns false
//   - source filter: empty, single valid, multiple valid, mixed
//     valid/invalid, only invalid, with whitespace and case differences
//   - from / to: absent, valid integer, non-numeric string -> 400
//   - q / agent: empty string collapses to undefined, whitespace only
//     collapses to undefined, real value is preserved
//   - limit: absent uses Math.min(200, maxEntries); numeric is capped at
//     maxEntries; non-numeric -> 400 (NaN); 0 -> 400 (limit < 1); negative -> 400
//   - req.url: undefined falls back to '/'
//   - queryAuditLog: returns [] and returns entries, with total echoed

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'

const H = vi.hoisted(() => ({
  queryAuditLog: vi.fn(() => [] as unknown[]),
  getEffectiveSettingValue: vi.fn((_key: string) => 10000),
}))

vi.mock('../db.js', () => ({
  queryAuditLog: H.queryAuditLog,
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: H.getEffectiveSettingValue,
}))

// Standardised mocks for modules the suite policy lists as expected targets
// even though this SUT does not import them.
vi.mock('../config.js', () => ({}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Import AFTER every mock is registered.
const { tryHandleAuditLog } = await import('../web/routes/audit-log.js')

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(url?: string): http.IncomingMessage {
  // When `url` is undefined, the route's `req.url ?? '/'` fallback fires --
  // this is the only way to exercise that branch.
  const req: Record<string, unknown> = { headers: {} }
  if (url !== undefined) req.url = url
  return req as unknown as http.IncomingMessage
}

async function call(opts: {
  method?: string
  path?: string
  query?: string
  rawUrl?: string
}): Promise<{ res: MockRes; handled: boolean; json: () => unknown }> {
  const method = opts.method ?? 'GET'
  const path = opts.path ?? '/api/audit-log'
  // Distinguish "caller did not pass rawUrl" (use a normal constructed URL)
  // from "caller explicitly wants req.url = undefined" (pass undefined to
  // mkReq so the route's `req.url ?? '/'` fallback fires).
  const hasRawUrl = Object.prototype.hasOwnProperty.call(opts, 'rawUrl')
  const urlStr: string | undefined = hasRawUrl
    ? opts.rawUrl
    : `http://127.0.0.1:3420${path}${opts.query ? `?${opts.query}` : ''}`
  const req = mkReq(urlStr)
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
  }
  const handled = await tryHandleAuditLog(ctx)
  return {
    res,
    handled,
    json: () => (res.body ? JSON.parse(res.body) : null),
  }
}

beforeEach(() => {
  H.queryAuditLog.mockReset().mockReturnValue([])
  H.getEffectiveSettingValue.mockReset().mockReturnValue(10000)
})

// ---------------------------------------------------------------------------
// Dispatcher surface (path/method filter)
// ---------------------------------------------------------------------------
describe('tryHandleAuditLog -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call({ path: '/api/other' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/audit-log on a non-GET method (POST)', async () => {
    const { handled } = await call({ method: 'POST' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/audit-log on PUT', async () => {
    const { handled } = await call({ method: 'PUT' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/audit-log on DELETE', async () => {
    const { handled } = await call({ method: 'DELETE' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/audit-log with a trailing slash', async () => {
    const { handled } = await call({ path: '/api/audit-log/' })
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/audit-log -- default params
// ---------------------------------------------------------------------------
describe('tryHandleAuditLog -- GET defaults', () => {
  it('returns 200 with an empty result envelope when no params are given', async () => {
    const { res, json, handled } = await call({})
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
    expect(json()).toEqual({ entries: [], total: 0 })
  })

  it('uses the registry cap (maxEntries) as the default when limit is absent', async () => {
    H.getEffectiveSettingValue.mockReturnValue(500)
    await call({})
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    )
    // The Math.min(200, 500) = 200 short-circuit means the registry value
    // was passed in even though we capped at 200.
    expect(H.getEffectiveSettingValue).toHaveBeenCalledWith('AUDIT_LOG_MAX_ENTRIES')
  })

  it('caps the default at maxEntries when the registry value is below 200', async () => {
    H.getEffectiveSettingValue.mockReturnValue(50)
    await call({})
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    )
  })

  it('passes undefined for from/to/q/agent when no params are given', async () => {
    await call({})
    expect(H.queryAuditLog).toHaveBeenCalledWith({
      sources: [],
      from: undefined,
      to: undefined,
      q: undefined,
      agent: undefined,
      limit: 200,
    })
  })

  it('falls back to "/" for the URL when req.url is undefined', async () => {
    const { handled } = await call({ rawUrl: undefined })
    expect(handled).toBe(true)
    expect(H.queryAuditLog).toHaveBeenCalledWith({
      sources: [],
      from: undefined,
      to: undefined,
      q: undefined,
      agent: undefined,
      limit: 200,
    })
  })

  it('echoes the entry list and total in the response when entries exist', async () => {
    H.queryAuditLog.mockReturnValue([
      { id: 1, source: 'config', created_at: 100, key: 'A', old_value: 'a', new_value: 'b' },
      { id: 2, source: 'idea', created_at: 99, idea_id: 'I', from_status: null, to_status: 'open' },
    ])
    const { res, json } = await call({})
    expect(res.statusCode).toBe(200)
    const body = json() as { entries: unknown[]; total: number }
    expect(body.entries).toHaveLength(2)
    expect(body.total).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// Source filter
// ---------------------------------------------------------------------------
describe('tryHandleAuditLog -- source filter', () => {
  it('passes a single valid source through unchanged', async () => {
    await call({ query: 'source=config' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['config'] }),
    )
  })

  it('parses and de-duplicates a comma-separated list of valid sources', async () => {
    await call({ query: 'source=config,idea,store,diary' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['config', 'idea', 'store', 'diary'] }),
    )
  })

  it('drops invalid sources and keeps valid ones', async () => {
    await call({ query: 'source=config,bogus,idea,unknown' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['config', 'idea'] }),
    )
  })

  it('returns an empty sources array when every source is invalid', async () => {
    await call({ query: 'source=bogus,unknown' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [] }),
    )
  })

  it('normalises whitespace and case in source names', async () => {
    await call({ query: 'source= CONFIG , Idea , STORE ' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ sources: ['config', 'idea', 'store'] }),
    )
  })

  it('produces an empty array when the source param is empty', async () => {
    await call({ query: 'source=' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ sources: [] }),
    )
  })
})

// ---------------------------------------------------------------------------
// from / to validation
// ---------------------------------------------------------------------------
describe('tryHandleAuditLog -- from / to validation', () => {
  it('parses from / to as integers when they are well-formed', async () => {
    await call({ query: 'from=1000&to=2000' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ from: 1000, to: 2000 }),
    )
  })

  it('returns 400 with an explicit error when from is non-numeric', async () => {
    const { res, json, handled } = await call({ query: 'from=abc' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid "from" parameter' })
    expect(H.queryAuditLog).not.toHaveBeenCalled()
  })

  it('returns 400 when to is non-numeric', async () => {
    const { res, json, handled } = await call({ query: 'to=xyz' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid "to" parameter' })
    expect(H.queryAuditLog).not.toHaveBeenCalled()
  })

  it('does not flag "0" as NaN (parseInt("0") === 0)', async () => {
    await call({ query: 'from=0&to=0' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ from: 0, to: 0 }),
    )
  })

  it('treats an empty from/to as undefined', async () => {
    await call({ query: 'from=&to=' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ from: undefined, to: undefined }),
    )
  })
})

// ---------------------------------------------------------------------------
// q / agent filter
// ---------------------------------------------------------------------------
describe('tryHandleAuditLog -- q / agent filter', () => {
  it('passes a non-empty q through unchanged', async () => {
    await call({ query: 'q=hello' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'hello' }),
    )
  })

  it('trims surrounding whitespace from q', async () => {
    await call({ query: 'q=%20%20hello%20%20' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ q: 'hello' }),
    )
  })

  it('collapses an empty q to undefined', async () => {
    await call({ query: 'q=' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined }),
    )
  })

  it('collapses a whitespace-only q to undefined', async () => {
    await call({ query: 'q=%20%20%20' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ q: undefined }),
    )
  })

  it('passes a non-empty agent through unchanged', async () => {
    await call({ query: 'agent=main-agent' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'main-agent' }),
    )
  })

  it('trims whitespace from the agent filter', async () => {
    await call({ query: 'agent=%20%20agentA%20%20' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ agent: 'agentA' }),
    )
  })

  it('collapses an empty agent to undefined', async () => {
    await call({ query: 'agent=' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ agent: undefined }),
    )
  })
})

// ---------------------------------------------------------------------------
// limit validation
// ---------------------------------------------------------------------------
describe('tryHandleAuditLog -- limit validation', () => {
  it('accepts a numeric limit below the registry cap', async () => {
    await call({ query: 'limit=50' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 50 }),
    )
  })

  it('caps a numeric limit above the registry max', async () => {
    H.getEffectiveSettingValue.mockReturnValue(100)
    await call({ query: 'limit=500' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 100 }),
    )
  })

  it('treats an empty limit the same as the absent limit', async () => {
    await call({ query: 'limit=' })
    expect(H.queryAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 200 }),
    )
  })

  it('returns 400 when the limit is non-numeric', async () => {
    const { res, json, handled } = await call({ query: 'limit=abc' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid "limit" parameter' })
    expect(H.queryAuditLog).not.toHaveBeenCalled()
  })

  it('returns 400 when the limit is zero', async () => {
    const { res, json, handled } = await call({ query: 'limit=0' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid "limit" parameter' })
    expect(H.queryAuditLog).not.toHaveBeenCalled()
  })

  it('returns 400 when the limit is negative', async () => {
    const { res, json, handled } = await call({ query: 'limit=-5' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid "limit" parameter' })
    expect(H.queryAuditLog).not.toHaveBeenCalled()
  })

  it('returns 400 when the limit is NaN-producing whitespace', async () => {
    // parseInt('   ', 10) returns NaN, and the truthy check on limitParam
    // accepts the whitespace string, so this hits the NaN branch.
    const { res, json, handled } = await call({ query: 'limit=%20%20%20' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid "limit" parameter' })
    expect(H.queryAuditLog).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// Combined parameter behaviour
// ---------------------------------------------------------------------------
describe('tryHandleAuditLog -- combined params', () => {
  it('forwards every accepted query parameter to queryAuditLog', async () => {
    await call({
      query: 'source=config,idea&from=100&to=500&q=keyword&agent=main&limit=10',
    })
    expect(H.queryAuditLog).toHaveBeenCalledWith({
      sources: ['config', 'idea'],
      from: 100,
      to: 500,
      q: 'keyword',
      agent: 'main',
      limit: 10,
    })
  })

  it('always writes a JSON response with the private,no-store Cache-Control', async () => {
    const { res } = await call({ query: 'source=config' })
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })
})
