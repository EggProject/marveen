// 100% coverage suite for src/web/routes/skill-usage.ts.
//
// tryHandleSkillUsage owns three HTTP endpoints backed by src/db.ts:
//
//   POST /api/skill-usage           -- record a usage event (PostToolUse hook)
//   GET  /api/skill-usage/stats     -- aggregated counts per skill
//   GET  /api/skill-usage           -- recent rows with optional filters
//
// The route is pure: it only imports db helpers + http-helpers + types. We mock
// db.js so the underlying SQLite never fires, while keeping http-helpers real
// (readBody/json) so the request/response plumbing is exercised exactly as it
// would be against the live HTTP server. config/logger/auth-gate/auth-sessions
// are listed in the task spec as expected mock targets but the route does not
// import them -- no mocks needed beyond db.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const mkFn = () => vi.fn()
  return {
    logSkillUsage: mkFn(),
    getSkillUsageRows: vi.fn(() => [] as unknown[]),
    getSkillUsageStats: vi.fn(() => [] as unknown[]),
  }
})

// --- vi.mock factories ------------------------------------------------------

vi.mock('../db.js', () => ({
  logSkillUsage: H.logSkillUsage,
  getSkillUsageRows: H.getSkillUsageRows,
  getSkillUsageStats: H.getSkillUsageStats,
}))

// Import AFTER every mock is registered.
const { tryHandleSkillUsage } = await import('../web/routes/skill-usage.js')

// -----------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------

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

function mkReq(opts: { body?: Buffer | string }): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(method: string, fullPath: string, opts: { body?: Buffer | string } = {}): Promise<{
  res: MockRes
  handled: boolean
  json: () => Record<string, unknown> | unknown[] | null
}> {
  const req = mkReq(opts)
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = await tryHandleSkillUsage(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

beforeEach(() => {
  H.logSkillUsage.mockReset()
  H.getSkillUsageRows.mockReset().mockReturnValue([])
  H.getSkillUsageStats.mockReset().mockReturnValue([])
})

// -----------------------------------------------------------------------
// Dispatcher surface (path/method filter)
// -----------------------------------------------------------------------
describe('tryHandleSkillUsage -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for an unknown method on a known path (PUT /api/skill-usage)', async () => {
    const { handled } = await call('PUT', '/api/skill-usage')
    expect(handled).toBe(false)
  })

  it('returns false for POST on the stats sub-path (no body parsing fallback)', async () => {
    const { handled } = await call('POST', '/api/skill-usage/stats')
    expect(handled).toBe(false)
  })

  it('returns false for an unknown sub-path under /api/skill-usage', async () => {
    const { handled } = await call('GET', '/api/skill-usage/unknown')
    expect(handled).toBe(false)
  })
})

// -----------------------------------------------------------------------
// POST /api/skill-usage
// -----------------------------------------------------------------------
describe('POST /api/skill-usage', () => {
  it('returns 400 with { error: "Invalid JSON" } when the body is not parseable (pinned defect)', async () => {
    const { res, json } = await call('POST', '/api/skill-usage', { body: 'not-json{' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
    expect(H.logSkillUsage).not.toHaveBeenCalled()
  })

  it('rejects a body with a missing agent_id (400 + error)', async () => {
    const body = JSON.stringify({ skill_name: 'fleet-helper', trigger_type: 'tool_call' })
    const { res, json } = await call('POST', '/api/skill-usage', { body })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent_id, skill_name and trigger_type required' })
    expect(H.logSkillUsage).not.toHaveBeenCalled()
  })

  it('rejects a body with a missing skill_name (400 + error)', async () => {
    const body = JSON.stringify({ agent_id: 'marveen', trigger_type: 'tool_call' })
    const { res, json } = await call('POST', '/api/skill-usage', { body })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent_id, skill_name and trigger_type required' })
    expect(H.logSkillUsage).not.toHaveBeenCalled()
  })

  it('rejects a body with a missing trigger_type (400 + error)', async () => {
    const body = JSON.stringify({ agent_id: 'marveen', skill_name: 'fleet-helper' })
    const { res, json } = await call('POST', '/api/skill-usage', { body })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent_id, skill_name and trigger_type required' })
    expect(H.logSkillUsage).not.toHaveBeenCalled()
  })

  it('rejects an unknown trigger_type even when other fields are present (400 + error)', async () => {
    const body = JSON.stringify({
      agent_id: 'marveen',
      skill_name: 'fleet-helper',
      trigger_type: 'mystery',
    })
    const { res, json } = await call('POST', '/api/skill-usage', { body })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'trigger_type must be tool_call or skill_read' })
    expect(H.logSkillUsage).not.toHaveBeenCalled()
  })

  it('records a tool_call event with no session_id (session_id defaults to null)', async () => {
    const body = JSON.stringify({
      agent_id: 'marveen',
      skill_name: 'fleet-helper',
      trigger_type: 'tool_call',
    })
    const { res, json } = await call('POST', '/api/skill-usage', { body })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.logSkillUsage).toHaveBeenCalledTimes(1)
    expect(H.logSkillUsage).toHaveBeenCalledWith('marveen', 'fleet-helper', 'tool_call', undefined)
  })

  it('records a skill_read event with an explicit session_id', async () => {
    const body = JSON.stringify({
      agent_id: 'agent-b',
      skill_name: 'deep-research',
      trigger_type: 'skill_read',
      session_id: 'sess-123',
    })
    const { res, json } = await call('POST', '/api/skill-usage', { body })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.logSkillUsage).toHaveBeenCalledWith('agent-b', 'deep-research', 'skill_read', 'sess-123')
  })

  it('records a skill_read event with an explicit null session_id', async () => {
    const body = JSON.stringify({
      agent_id: 'agent-c',
      skill_name: 'fleet-helper',
      trigger_type: 'skill_read',
      session_id: null,
    })
    const { res, json } = await call('POST', '/api/skill-usage', { body })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.logSkillUsage).toHaveBeenCalledWith('agent-c', 'fleet-helper', 'skill_read', null)
  })
})

// -----------------------------------------------------------------------
// GET /api/skill-usage/stats
// -----------------------------------------------------------------------
describe('GET /api/skill-usage/stats', () => {
  it('returns aggregated stats without a `since` argument (undefined cutoff)', async () => {
    const expected = [
      { skill_name: 'fleet-helper', call_count: 3, read_count: 1, total_count: 4, agent_count: 2, last_used_at: 1_700_000_000 },
    ]
    H.getSkillUsageStats.mockReturnValueOnce(expected)
    const { res, json } = await call('GET', '/api/skill-usage/stats')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(expected)
    expect(H.getSkillUsageStats).toHaveBeenCalledWith(undefined)
  })

  it('parses `since` from the query string and forwards it as a number', async () => {
    H.getSkillUsageStats.mockReturnValueOnce([])
    await call('GET', '/api/skill-usage/stats?since=3600')
    expect(H.getSkillUsageStats).toHaveBeenCalledWith(3600)
  })

  it('ignores an empty `since` (parseInt on empty string -> NaN is falsy, so undefined)', async () => {
    // parseInt('') === NaN, which is falsy in the truthiness check the route uses
    // (`url.searchParams.get('since') ? parseInt(...) : undefined`). Empty
    // strings therefore pass `undefined` to the helper, exactly like a missing
    // param. Lock that behaviour in so future refactors can't silently change it.
    H.getSkillUsageStats.mockReturnValueOnce([])
    await call('GET', '/api/skill-usage/stats?since=')
    expect(H.getSkillUsageStats).toHaveBeenCalledWith(undefined)
  })
})

// -----------------------------------------------------------------------
// GET /api/skill-usage
// -----------------------------------------------------------------------
describe('GET /api/skill-usage', () => {
  it('returns rows with defaults when no query params are supplied', async () => {
    const rows = [
      { id: 1, agent_id: 'a', skill_name: 's', trigger_type: 'tool_call', session_id: null, created_at: 1 },
    ]
    H.getSkillUsageRows.mockReturnValueOnce(rows)
    const { res, json } = await call('GET', '/api/skill-usage')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(rows)
    expect(H.getSkillUsageRows).toHaveBeenCalledWith({
      since: undefined,
      agentId: undefined,
      skillName: undefined,
      limit: 500,
    })
  })

  it('forwards every supported query param (since/agent_id/skill_name/limit) to the helper', async () => {
    H.getSkillUsageRows.mockReturnValueOnce([])
    await call('GET', '/api/skill-usage?since=7200&agent_id=marveen&skill_name=fleet-helper&limit=42')
    expect(H.getSkillUsageRows).toHaveBeenCalledWith({
      since: 7200,
      agentId: 'marveen',
      skillName: 'fleet-helper',
      limit: 42,
    })
  })

  it('uses the default limit (500) when `limit` is omitted or empty', async () => {
    H.getSkillUsageRows.mockReturnValueOnce([])
    await call('GET', '/api/skill-usage?since=10')
    expect(H.getSkillUsageRows).toHaveBeenCalledWith({
      since: 10,
      agentId: undefined,
      skillName: undefined,
      limit: 500,
    })

    H.getSkillUsageRows.mockReturnValueOnce([])
    await call('GET', '/api/skill-usage?limit=')
    // parseInt('') === NaN -> falsy -> default 500
    expect(H.getSkillUsageRows).toHaveBeenLastCalledWith({
      since: undefined,
      agentId: undefined,
      skillName: undefined,
      limit: 500,
    })
  })

  it('returns an empty array when there are no rows', async () => {
    H.getSkillUsageRows.mockReturnValueOnce([])
    const { res, json } = await call('GET', '/api/skill-usage')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })
})
