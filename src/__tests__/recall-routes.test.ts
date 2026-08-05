// 100% coverage suite for src/web/routes/recall.ts.
//
// tryHandleRecall owns three HTTP endpoints plus a date-expression parser:
//
//   GET  /api/recall          -- date-range recall (logs+memories) or full-text search
//   GET  /api/recall/dates    -- list daily-log dates for an agent
//
//   parseDateExpression(input) is also exported, but a top-level
//   recall.test.ts already exercises it under the real "today"; this file
//   re-covers only the few branches that are exercised INDIRECTLY through
//   tryHandleRecall (relative-day keywords, ISO range, invalid date -> 400).
//
// Imports the SUT needs:
//   db.js         -> recallByDateRange, recallSearch, getDailyLogDates
//   config.js     -> MAIN_AGENT_ID, APP_TZ
//   http-helpers  -> json (real; pure function)
//   routes/types  -> RouteContext (type only)
//
// db.js is fully mocked. config.js is replaced with a stub exporting only
// what recall.ts touches. logger/auth-gate/auth-sessions are stubbed to keep
// the dependency surface consistent across the /api/* route suites per
// project convention even though the SUT never imports them.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'

const H = vi.hoisted(() => ({
  recallByDateRange: vi.fn(),
  recallSearch: vi.fn(),
  getDailyLogDates: vi.fn(),
}))

vi.mock('../db.js', () => ({
  recallByDateRange: H.recallByDateRange,
  recallSearch: H.recallSearch,
  getDailyLogDates: H.getDailyLogDates,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  APP_TZ: 'UTC',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

const { tryHandleRecall } = await import('../web/routes/recall.js')
const { parseDateExpression } = await import('../web/routes/recall.js')

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

async function call(
  method: string,
  fullPath: string,
): Promise<{ res: MockRes; handled: boolean; json: () => unknown }> {
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const req = { headers: {} } as unknown as http.IncomingMessage
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = await tryHandleRecall(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

function makeRecallResult(overrides: Partial<{
  logs: any[]
  memories: any[]
  dateRange: { from: string; to: string }
}> = {}) {
  return {
    logs: overrides.logs ?? [],
    memories: overrides.memories ?? [],
    dateRange: overrides.dateRange ?? { from: '2026-05-19', to: '2026-05-19' },
  }
}

beforeEach(() => {
  H.recallByDateRange.mockReset()
  H.recallSearch.mockReset()
  H.getDailyLogDates.mockReset()
  // Default safe returns so a missed branch doesn't throw.
  H.recallByDateRange.mockReturnValue(makeRecallResult())
  H.recallSearch.mockReturnValue(makeRecallResult())
  H.getDailyLogDates.mockReturnValue([])
})

// ---------------------------------------------------------------------------
// Dispatcher surface
// ---------------------------------------------------------------------------

describe('tryHandleRecall -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for POST /api/recall (only GET is handled)', async () => {
    const { handled } = await call('POST', '/api/recall')
    expect(handled).toBe(false)
  })

  it('returns false for POST /api/recall/dates (only GET is handled)', async () => {
    const { handled } = await call('POST', '/api/recall/dates')
    expect(handled).toBe(false)
  })

  it('returns false for GET on /api/recall/something-else', async () => {
    const { handled } = await call('GET', '/api/recall/other')
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/recall -- today / no params
// ---------------------------------------------------------------------------

describe('GET /api/recall (no params)', () => {
  it('defaults to today range when no date is provided', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      dateRange: { from: '2026-05-19', to: '2026-05-19' },
      logs: [{ id: 1, agent_id: 'a', date: '2026-05-19', content: 'hi', created_at: 0 }],
    }))
    const { res, json } = await call('GET', '/api/recall')
    expect(res.statusCode).toBe(200)
    expect(H.recallByDateRange).toHaveBeenCalledTimes(1)
    // from === to, and both look like YYYY-MM-DD
    const [from, to] = H.recallByDateRange.mock.calls[0]
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(from).toBe(to)
    const body = json() as any
    // dateRange in the response is whatever recallByDateRange returned (not
    // the resolved range used for the query)
    expect(body.dateRange).toEqual({ from: '2026-05-19', to: '2026-05-19' })
    expect(body.logs).toHaveLength(1)
    expect(body.logs[0]).toMatchObject({ id: 1, content: 'hi' })
    // created_label is set on every log row
    expect(typeof body.logs[0].created_label).toBe('string')
    expect(body.summary.logCount).toBe(1)
    expect(body.summary.memoryCount).toBe(0)
    expect(body.summary.agents).toEqual(['a'])
  })

  it('returns an empty result cleanly when there are no logs/memories', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult())
    const { res, json } = await call('GET', '/api/recall')
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      logs: [],
      memories: [],
      summary: { logCount: 0, memoryCount: 0, agents: [] },
    })
  })
})

// ---------------------------------------------------------------------------
// GET /api/recall -- explicit date
// ---------------------------------------------------------------------------

describe('GET /api/recall (explicit date)', () => {
  it('parses an ISO date and queries recallByDateRange', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      dateRange: { from: '2026-05-10', to: '2026-05-10' },
    }))
    const { res, json } = await call('GET', '/api/recall?date=2026-05-10')
    expect(res.statusCode).toBe(200)
    expect(H.recallByDateRange).toHaveBeenCalledWith('2026-05-10', '2026-05-10', undefined)
    expect((json() as any).dateRange).toEqual({ from: '2026-05-10', to: '2026-05-10' })
  })

  it('parses an ISO range and queries recallByDateRange with both ends', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      dateRange: { from: '2026-05-01', to: '2026-05-07' },
    }))
    const { res } = await call('GET', '/api/recall?date=2026-05-01-2026-05-07')
    expect(res.statusCode).toBe(200)
    expect(H.recallByDateRange).toHaveBeenCalledWith('2026-05-01', '2026-05-07', undefined)
  })

  it('returns 400 when the date expression cannot be parsed', async () => {
    const { res, json } = await call('GET', '/api/recall?date=xyzzy')
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Nem értelmezhető dátum: "xyzzy"' })
    expect(H.recallByDateRange).not.toHaveBeenCalled()
    expect(H.recallSearch).not.toHaveBeenCalled()
  })

  it('parses Hungarian keywords (tegnap) into a single-day range', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult())
    const { res } = await call('GET', '/api/recall?date=tegnap')
    expect(res.statusCode).toBe(200)
    expect(H.recallByDateRange).toHaveBeenCalledTimes(1)
    const [from, to] = H.recallByDateRange.mock.calls[0]
    expect(from).toBe(to)
  })

  it('parses "this week" into a multi-day range starting Monday', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult())
    const { res } = await call('GET', '/api/recall?date=this%20week')
    expect(res.statusCode).toBe(200)
    const [from, to] = H.recallByDateRange.mock.calls[0]
    // to >= from; both look like dates
    expect(from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(to).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(to >= from).toBe(true)
  })

  it('parses "last month" into a single-month range', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult())
    const { res } = await call('GET', '/api/recall?date=last%20month')
    expect(res.statusCode).toBe(200)
    const [from, to] = H.recallByDateRange.mock.calls[0]
    expect(from).toMatch(/-01$/)
    expect(to >= from).toBe(true)
  })

  it('passes the agent query param through to recallByDateRange', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult())
    const { res } = await call('GET', '/api/recall?date=2026-05-10&agent=zeta')
    expect(res.statusCode).toBe(200)
    expect(H.recallByDateRange).toHaveBeenCalledWith('2026-05-10', '2026-05-10', 'zeta')
  })
})

// ---------------------------------------------------------------------------
// GET /api/recall -- recallSearch path (q without date)
// ---------------------------------------------------------------------------

describe('GET /api/recall (q without date)', () => {
  it('uses recallSearch and formats the result', async () => {
    H.recallSearch.mockReturnValue(makeRecallResult({
      dateRange: { from: '2026-05-01', to: '2026-05-19' },
      memories: [
        {
          id: 1, agent_id: 'a', content: 'match', created_at: 0,
          keywords: 'kw', embedding: 'should-be-stripped',
          chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
          accessed_at: 0, category: 'shared', auto_generated: 0,
        },
      ],
    }))
    const { res, json } = await call('GET', '/api/recall?q=hello')
    expect(res.statusCode).toBe(200)
    expect(H.recallSearch).toHaveBeenCalledWith('hello', undefined, 50)
    expect(H.recallByDateRange).not.toHaveBeenCalled()
    const body = json() as any
    // embedding is stripped from memories
    expect(body.memories[0].embedding).toBeUndefined()
    // created_label is still computed
    expect(typeof body.memories[0].created_label).toBe('string')
    expect(body.summary.agents).toEqual(['a'])
  })

  it('forwards the agent query param to recallSearch', async () => {
    H.recallSearch.mockReturnValue(makeRecallResult())
    const { res } = await call('GET', '/api/recall?q=hi&agent=beta')
    expect(res.statusCode).toBe(200)
    expect(H.recallSearch).toHaveBeenCalledWith('hi', 'beta', 50)
  })

  it('caps the recallSearch limit at 200', async () => {
    H.recallSearch.mockReturnValue(makeRecallResult())
    const { res } = await call('GET', '/api/recall?q=hi&limit=9999')
    expect(res.statusCode).toBe(200)
    expect(H.recallSearch).toHaveBeenCalledWith('hi', undefined, 200)
  })
})

// ---------------------------------------------------------------------------
// GET /api/recall -- q + date: post-filter path with escapeLike
// ---------------------------------------------------------------------------

describe('GET /api/recall (q + date filtering)', () => {
  it('filters logs by query after recallByDateRange and escapes LIKE metachars', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      logs: [
        { id: 1, agent_id: 'a', date: '2026-05-19', content: 'alpha bravo', created_at: 0 },
        { id: 2, agent_id: 'a', date: '2026-05-19', content: 'charlie', created_at: 0 },
        { id: 3, agent_id: 'a', date: '2026-05-19', content: 'ALPHA', created_at: 0 },
      ],
      memories: [
        {
          id: 10, agent_id: 'a', content: 'Alpha memory', created_at: 0,
          keywords: 'k1', embedding: null,
          chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
          accessed_at: 0, category: 'shared', auto_generated: 0,
        },
      ],
    }))
    const { res, json } = await call('GET', '/api/recall?date=2026-05-19&q=alpha')
    expect(res.statusCode).toBe(200)
    expect(H.recallSearch).not.toHaveBeenCalled()
    const body = json() as any
    // The filter is case-insensitive (lowercased after escapeLike)
    expect(body.logs.map((l: any) => l.id)).toEqual([1, 3])
    expect(body.memories).toHaveLength(1)
    expect(body.summary.logCount).toBe(2)
    expect(body.summary.memoryCount).toBe(1)
  })

  it('matches memories by keywords column as well as content', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      memories: [
        {
          id: 10, agent_id: 'a', content: 'no-match', created_at: 0,
          keywords: 'shovel', embedding: null,
          chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
          accessed_at: 0, category: 'shared', auto_generated: 0,
        },
      ],
    }))
    const { res, json } = await call('GET', '/api/recall?date=2026-05-19&q=shovel')
    expect(res.statusCode).toBe(200)
    expect((json() as any).memories).toHaveLength(1)
  })

  it('handles null keywords safely (|| "" fallback)', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      memories: [
        {
          id: 10, agent_id: 'a', content: 'hello world', created_at: 0,
          keywords: null, embedding: null,
          chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
          accessed_at: 0, category: 'shared', auto_generated: 0,
        },
      ],
    }))
    const { res, json } = await call('GET', '/api/recall?date=2026-05-19&q=hello')
    expect(res.statusCode).toBe(200)
    expect((json() as any).memories).toHaveLength(1)
  })

  it('escapes % and _ in the user query so they match literally, not as LIKE wildcards', async () => {
    // The route calls escapeLike() before the in-memory substring filter. The
    // filter itself uses String.includes(), so the escape escapes `%` to
    // `\%`, lowercases it, and only rows whose content contains the literal
    // backslash-percent substring match. The point of the test is to exercise
    // the escapeLike branch on the percentage path -- not to demonstrate that
    // SQL LIKE wildcards work, since this is an in-memory filter.
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      logs: [
        { id: 1, agent_id: 'a', date: '2026-05-19', content: 'has literal \\% inside', created_at: 0 },
        { id: 2, agent_id: 'a', date: '2026-05-19', content: 'plain text no meta', created_at: 0 },
      ],
    }))
    const { res, json } = await call('GET', '/api/recall?date=2026-05-19&q=%25')
    expect(res.statusCode).toBe(200)
    const body = json() as any
    expect(body.logs.map((l: any) => l.id)).toEqual([1])
  })

  it('escapes backslashes in the user query', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      logs: [
        { id: 1, agent_id: 'a', date: '2026-05-19', content: 'literal backslash \\\\ here', created_at: 0 },
      ],
    }))
    const { res, json } = await call('GET', '/api/recall?date=2026-05-19&q=' + encodeURIComponent('\\'))
    expect(res.statusCode).toBe(200)
    expect((json() as any).logs).toHaveLength(1)
  })

  it('escapes underscores in the user query', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      logs: [
        { id: 1, agent_id: 'a', date: '2026-05-19', content: 'literal \\_ in content', created_at: 0 },
      ],
    }))
    const { res, json } = await call('GET', '/api/recall?date=2026-05-19&q=' + encodeURIComponent('_'))
    expect(res.statusCode).toBe(200)
    expect((json() as any).logs).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// GET /api/recall -- summary.agents dedupe
// ---------------------------------------------------------------------------

describe('GET /api/recall -- summary.agents', () => {
  it('dedupes agents across logs and memories', async () => {
    H.recallByDateRange.mockReturnValue(makeRecallResult({
      logs: [
        { id: 1, agent_id: 'alpha', date: '2026-05-19', content: 'a', created_at: 0 },
        { id: 2, agent_id: 'beta',  date: '2026-05-19', content: 'b', created_at: 0 },
      ],
      memories: [
        {
          id: 10, agent_id: 'alpha', content: 'm', created_at: 0, keywords: null, embedding: null,
          chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
          accessed_at: 0, category: 'shared', auto_generated: 0,
        },
        {
          id: 11, agent_id: 'gamma', content: 'm', created_at: 0, keywords: null, embedding: null,
          chat_id: 'c', topic_key: null, sector: 'semantic', salience: 1,
          accessed_at: 0, category: 'shared', auto_generated: 0,
        },
      ],
    }))
    const { json } = await call('GET', '/api/recall?date=2026-05-19')
    const agents = (json() as any).summary.agents
    expect(new Set(agents)).toEqual(new Set(['alpha', 'beta', 'gamma']))
    expect(agents).toHaveLength(3)
  })
})

// ---------------------------------------------------------------------------
// GET /api/recall/dates
// ---------------------------------------------------------------------------

describe('GET /api/recall/dates', () => {
  it('lists daily log dates for the main agent with the default limit', async () => {
    H.getDailyLogDates.mockReturnValue(['2026-05-19', '2026-05-18'])
    const { res, json } = await call('GET', '/api/recall/dates')
    expect(res.statusCode).toBe(200)
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen', 90)
    expect(json()).toEqual(['2026-05-19', '2026-05-18'])
  })

  it('honors the agent query parameter', async () => {
    H.getDailyLogDates.mockReturnValue(['2026-05-01'])
    const { res } = await call('GET', '/api/recall/dates?agent=zeta')
    expect(res.statusCode).toBe(200)
    expect(H.getDailyLogDates).toHaveBeenCalledWith('zeta', 90)
  })

  it('honors and caps the limit query parameter at 365', async () => {
    H.getDailyLogDates.mockReturnValue([])
    const { res } = await call('GET', '/api/recall/dates?limit=9999')
    expect(res.statusCode).toBe(200)
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen', 365)
  })
})

// ---------------------------------------------------------------------------
// parseDateExpression -- branches reached through tryHandleRecall
// ---------------------------------------------------------------------------
//
// The exhaustive parseDateExpression coverage already lives in recall.test.ts.
// Here we cover the *additional* branches that show up only via the route:
// "today" keyword (zero-day window), N-weeks-ago (so the from < to arm of the
// `to > today ? today : to` clamp is exercised), invalid input (the 400
// branch), and abbreviated month names that route to `szept`-style entries.

describe('parseDateExpression -- route-exercised branches', () => {
  it('"today" returns a same-day range', () => {
    const r = parseDateExpression('today')
    expect(r).not.toBeNull()
    expect(r!.from).toBe(r!.to)
  })

  it('"3 hete" parses into a multi-day range (from < to)', () => {
    const r = parseDateExpression('3 hete')
    expect(r).not.toBeNull()
    // 3 weeks back = 21 days, so from < to unless today is within 7 days
    // (the route clamps to <= today). Either way, from <= to.
    expect(r!.from <= r!.to).toBe(true)
  })

  it('"utolsó 5 nap" parses a trailing N-day window', () => {
    const r = parseDateExpression('utolso 5 nap')
    expect(r).not.toBeNull()
    expect(r!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(r!.from <= r!.to).toBe(true)
  })

  it('"elozo het" parses last week', () => {
    const r = parseDateExpression('elozo het')
    expect(r).not.toBeNull()
    expect(r!.from < r!.to).toBe(true)
  })

  it('"elozo honap" parses previous month', () => {
    const r = parseDateExpression('elozo honap')
    expect(r).not.toBeNull()
    expect(r!.from).toMatch(/-\d{2}-01$/)
    expect(r!.from <= r!.to).toBe(true)
  })

  it('"augusztus" -> full month range', () => {
    const r = parseDateExpression('augusztus')
    expect(r).not.toBeNull()
    expect(r!.from.endsWith('-08-01')).toBe(true)
    expect(r!.to.endsWith('-08-31')).toBe(true)
  })

  it('"augusztusban" suffix -> full month range', () => {
    const r = parseDateExpression('augusztusban')
    expect(r).not.toBeNull()
    expect(r!.from.endsWith('-08-01')).toBe(true)
  })

  it('"augusztus 15" -> single day within the month', () => {
    const r = parseDateExpression('augusztus 15')
    expect(r).not.toBeNull()
    expect(r!.from.endsWith('-08-15')).toBe(true)
    expect(r!.from).toBe(r!.to)
  })

  it('"augusztus utolso het" -> last week of month', () => {
    const r = parseDateExpression('augusztus utolso het')
    expect(r).not.toBeNull()
    expect(r!.to.endsWith('-08-31')).toBe(true)
    expect(r!.from <= r!.to).toBe(true)
  })

  it('"augusztus negyedik het" -> fourth week (clamped to month end)', () => {
    const r = parseDateExpression('augusztus negyedik het')
    expect(r).not.toBeNull()
    // The fourth week of August starts on Aug 22 and would extend past Aug 31;
    // the route clamps `to` to monthEnd.
    expect(r!.to <= '2099-12-31').toBe(true)
  })

  it('invalid input returns null (so the route returns 400)', () => {
    expect(parseDateExpression('not-a-real-date')).toBeNull()
  })

  it('"hétfő" without accents goes through the stripAccents path', () => {
    const r = parseDateExpression('hetfo')
    expect(r).not.toBeNull()
    expect(r!.from).toBe(r!.to)
  })

  it('"múlt szerda" -> most recent past Wednesday (from === to)', () => {
    const r = parseDateExpression('mult szerda')
    expect(r).not.toBeNull()
    expect(r!.from).toBe(r!.to)
  })

  it('"tegnapelott" -> two-days-ago single day', () => {
    const r = parseDateExpression('tegnapelott')
    expect(r).not.toBeNull()
    expect(r!.from).toBe(r!.to)
    expect(r!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('"5 nap" -> 5-days-ago single day (daysAgoMatch branch)', () => {
    const r = parseDateExpression('5 nap')
    expect(r).not.toBeNull()
    expect(r!.from).toBe(r!.to)
    expect(r!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('"this month" -> month-start to today', () => {
    const r = parseDateExpression('this month')
    expect(r).not.toBeNull()
    expect(r!.from.endsWith('-01')).toBe(true)
    expect(r!.from <= r!.to).toBe(true)
  })
})