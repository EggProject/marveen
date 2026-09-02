// 100% coverage suite for src/web/routes/daily-log.ts.
//
// tryHandleDailyLog owns three HTTP endpoints behind a single dispatcher:
//   * POST /api/daily-log           -> body validation + appendDailyLog
//   * GET  /api/daily-log           -> getDailyLog (with date/agent query params)
//   * GET  /api/daily-log/dates     -> getDailyLogDates
//
// Collaborators are mocked:
//   * ../../db.js          -- appendDailyLog, getDailyLog, getDailyLogDates
//   * ../../config.js      -- MAIN_AGENT_ID
//   * ../http-helpers.js   -- readBody (so the test can hand it a
//                              pre-buffered fake req), json (kept real --
//                              it is a tiny response writer already covered
//                              by http-helpers.test.ts).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { PassThrough } from 'node:stream'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Hoisted harness. vi.mock factories below reference H; vi.hoisted keeps it
// in scope inside the hoisted factory closures.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  appendDailyLog: vi.fn(),
  getDailyLog: vi.fn(() => [] as Array<{ id: number; content: string; created_at: number }>),
  getDailyLogDates: vi.fn(() => [] as string[]),
}))

vi.mock('../db.js', () => ({
  appendDailyLog: H.appendDailyLog,
  getDailyLog: H.getDailyLog,
  getDailyLogDates: H.getDailyLogDates,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
}))

// SUT import (after mocks)
const { tryHandleDailyLog } = await import('../web/routes/daily-log.js')

// ---------------------------------------------------------------------------
// Mock response recorder. Mirrors the audit-log-routes harness pattern.
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

// Fake req that emits the given bytes synchronously through `data` and then
// fires `end`. `readBody` only listens for `data` + `end`, so a one-shot
// PassThrough is enough -- no need to wire up a real IncomingMessage.
function mkReqWithBody(body: string): http.IncomingMessage {
  const stream = new PassThrough()
  setImmediate(() => {
    stream.write(Buffer.from(body))
    stream.end()
  })
  return stream as unknown as http.IncomingMessage
}

function mkCtx(opts: {
  method: string
  path: string
  query?: string
  body?: string
}): RouteContext {
  const res = mkRes()
  const req = opts.body !== undefined ? mkReqWithBody(opts.body) : ({ headers: {} } as unknown as http.IncomingMessage)
  const fullPath = `${opts.path}${opts.query ? `?${opts.query}` : ''}`
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  return {
    req,
    res: res as unknown as http.ServerResponse,
    path: opts.path,
    method: opts.method,
    url,
    fedPeer: null,
  }
}

async function call(opts: {
  method: string
  path: string
  query?: string
  body?: string
}): Promise<{
  handled: boolean
  res: MockRes
  json: () => Record<string, unknown> | unknown[] | null
}> {
  const ctx = mkCtx(opts)
  const handled = await tryHandleDailyLog(ctx)
  return {
    handled,
    res: ctx.res as unknown as MockRes,
    json: () => ((ctx.res as unknown as MockRes).body ? JSON.parse((ctx.res as unknown as MockRes).body) : null),
  }
}

beforeEach(() => {
  H.appendDailyLog.mockReset()
  H.getDailyLog.mockReset().mockReturnValue([])
  H.getDailyLogDates.mockReset().mockReturnValue([])
})

// ===========================================================================
// Dispatcher surface: paths/methods the handler does NOT own must return
// false so the next module in the chain gets a turn.
// ===========================================================================

describe('tryHandleDailyLog -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call({ method: 'GET', path: '/api/other' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/daily-log on DELETE', async () => {
    const { handled } = await call({ method: 'DELETE', path: '/api/daily-log' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/daily-log/dates on POST (only GET is wired)', async () => {
    const { handled, res } = await call({ method: 'POST', path: '/api/daily-log/dates', body: '{}' })
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0) // no response was written
  })

  it('returns false for /api/daily-log/dates on PUT', async () => {
    const { handled } = await call({ method: 'PUT', path: '/api/daily-log/dates' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/daily-log with a trailing slash', async () => {
    const { handled } = await call({ method: 'GET', path: '/api/daily-log/' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/daily-log/dates with a trailing slash', async () => {
    const { handled } = await call({ method: 'GET', path: '/api/daily-log/dates/' })
    expect(handled).toBe(false)
  })
})

// ===========================================================================
// POST /api/daily-log -- validation + append
// ===========================================================================

describe('tryHandleDailyLog -- POST /api/daily-log', () => {
  it('returns 400 with "Content required" when content is missing', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({}),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Content required' })
    expect(H.appendDailyLog).not.toHaveBeenCalled()
  })

  it('returns 400 when content is the empty string', async () => {
    const { res, handled } = await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ content: '' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(H.appendDailyLog).not.toHaveBeenCalled()
  })

  it('returns 400 when content is whitespace-only', async () => {
    // The `!data.content?.trim()` branch hits both missing AND whitespace-only
    // values; cover it explicitly so the trim() arm is exercised.
    const { res, json, handled } = await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ content: '   \n\t  ' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Content required' })
    expect(H.appendDailyLog).not.toHaveBeenCalled()
  })

  it('persists via appendDailyLog and returns 200 ok when content is present', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ content: 'hello world' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.appendDailyLog).toHaveBeenCalledTimes(1)
    expect(H.appendDailyLog).toHaveBeenCalledWith('marveen', 'hello world')
  })

  it('trims surrounding whitespace before persisting', async () => {
    await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ content: '  hi there  ' }),
    })
    expect(H.appendDailyLog).toHaveBeenCalledWith('marveen', 'hi there')
  })

  it('uses the explicit agent_id when provided', async () => {
    await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ agent_id: 'agent-b', content: 'log me' }),
    })
    expect(H.appendDailyLog).toHaveBeenCalledWith('agent-b', 'log me')
  })

  it('falls back to MAIN_AGENT_ID when agent_id is missing', async () => {
    // The `data.agent_id || MAIN_AGENT_ID` branch -- default to MAIN when
    // the caller omits the field entirely.
    await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ content: 'no agent_id' }),
    })
    expect(H.appendDailyLog).toHaveBeenCalledWith('marveen', 'no agent_id')
  })

  it('falls back to MAIN_AGENT_ID when agent_id is the empty string', async () => {
    // Empty string is falsy, so the `||` falls through. Pins that the
    // falsy-but-defined branch is not just a happy-path assumption.
    await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ agent_id: '', content: 'empty agent_id' }),
    })
    expect(H.appendDailyLog).toHaveBeenCalledWith('marveen', 'empty agent_id')
  })
})

// ===========================================================================
// GET /api/daily-log -- default vs explicit query params
// ===========================================================================

describe('tryHandleDailyLog -- GET /api/daily-log', () => {
  it('uses MAIN_AGENT_ID and today\'s ISO date when no params are given', async () => {
    // The "today" branch uses new Date().toISOString().split('T')[0], so we
    // pin the expectation to the same computation rather than a hardcoded
    // string (which would break across time zones / clocks).
    const expectedDate = new Date().toISOString().split('T')[0]
    const entries = [{ id: 1, content: 'x', created_at: 100 }]
    H.getDailyLog.mockReturnValueOnce(entries)
    const { res, json, handled } = await call({ method: 'GET', path: '/api/daily-log' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(entries)
    expect(H.getDailyLog).toHaveBeenCalledWith('marveen', expectedDate)
  })

  it('forwards an explicit agent and date query parameter to getDailyLog', async () => {
    H.getDailyLog.mockReturnValueOnce([{ id: 2, content: 'y', created_at: 200 }])
    const { res, json } = await call({
      method: 'GET',
      path: '/api/daily-log',
      query: 'agent=agent-b&date=2026-08-01',
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([{ id: 2, content: 'y', created_at: 200 }])
    expect(H.getDailyLog).toHaveBeenCalledWith('agent-b', '2026-08-01')
  })

  it('uses MAIN_AGENT_ID when only date is given (agent absent)', async () => {
    // The `searchParams.get('agent') || MAIN_AGENT_ID` branch -- only date
    // supplied, agent falls through to default.
    await call({
      method: 'GET',
      path: '/api/daily-log',
      query: 'date=2026-08-02',
    })
    expect(H.getDailyLog).toHaveBeenCalledWith('marveen', '2026-08-02')
  })

  it('uses today\'s date when only agent is given (date absent)', async () => {
    // The `searchParams.get('date') || ...` branch -- only agent supplied.
    const expectedDate = new Date().toISOString().split('T')[0]
    await call({
      method: 'GET',
      path: '/api/daily-log',
      query: 'agent=agent-c',
    })
    expect(H.getDailyLog).toHaveBeenCalledWith('agent-c', expectedDate)
  })

  it('echoes an empty result envelope when no entries match', async () => {
    const { res, json } = await call({ method: 'GET', path: '/api/daily-log' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })
})

// ===========================================================================
// GET /api/daily-log/dates -- list distinct dates for an agent
// ===========================================================================

describe('tryHandleDailyLog -- GET /api/daily-log/dates', () => {
  it('uses MAIN_AGENT_ID when agent is absent', async () => {
    H.getDailyLogDates.mockReturnValueOnce(['2026-08-04', '2026-08-03'])
    const { res, json, handled } = await call({ method: 'GET', path: '/api/daily-log/dates' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(['2026-08-04', '2026-08-03'])
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen')
  })

  it('forwards an explicit agent query parameter to getDailyLogDates', async () => {
    H.getDailyLogDates.mockReturnValueOnce(['2026-08-01'])
    await call({ method: 'GET', path: '/api/daily-log/dates', query: 'agent=agent-b' })
    expect(H.getDailyLogDates).toHaveBeenCalledWith('agent-b')
  })

  it('echoes an empty list when the agent has no logged dates', async () => {
    const { res, json } = await call({ method: 'GET', path: '/api/daily-log/dates' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })
})

// ===========================================================================
// Response shape: every JSON response carries the canonical
// private/no-store cache headers via http-helpers.ts:json(). Exercised
// against multiple endpoints so the header contract is pinned across all
// three branches, not just the first.
// ===========================================================================

describe('tryHandleDailyLog -- response headers', () => {
  it('uses the canonical content-type + cache headers on GET /api/daily-log', async () => {
    const { res } = await call({ method: 'GET', path: '/api/daily-log' })
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })

  it('uses the canonical content-type + cache headers on GET /api/daily-log/dates', async () => {
    const { res } = await call({ method: 'GET', path: '/api/daily-log/dates' })
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })

  it('uses the canonical content-type + cache headers on a 400 POST validation failure', async () => {
    // 400 responses carry the same headers -- the cache directive lives in
    // json() (http-helpers.ts), not the per-status branch.
    const { res } = await call({
      method: 'POST',
      path: '/api/daily-log',
      body: JSON.stringify({ content: '' }),
    })
    expect(res.statusCode).toBe(400)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })
})
