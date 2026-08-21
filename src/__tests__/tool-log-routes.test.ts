// 100% coverage suite for src/web/routes/tool-log.ts.
//
// tryHandleToolLog owns four tool-call-log endpoints:
//   POST  /api/tool-log          -- record a tool call (PostToolUse hook)
//   GET   /api/tool-log          -- recent calls (window: since seconds)
//   GET   /api/tool-log/analyze  -- workflow candidates summary
//   POST  /api/tool-log/prune    -- delete entries older than N seconds
//
// The SUT only depends on db.js (the four functions), http-helpers.js (readBody
// + json) and routes/types.js (RouteContext). db.js is mocked so the route logic
// stands alone; the others (config, logger, auth-gate, auth-sessions) are stubbed
// because tests in this codebase standardise on mocking them even when the SUT
// does not import them, to keep the dependency surface consistent across the
// /api/* route suites.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

const mocks = vi.hoisted(() => ({
  logToolCall: vi.fn(),
  analyzeWorkflowCandidates: vi.fn(),
  getRecentToolCalls: vi.fn(),
  pruneToolCallLog: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}))

vi.mock('../db.js', () => ({
  logToolCall: mocks.logToolCall,
  analyzeWorkflowCandidates: mocks.analyzeWorkflowCandidates,
  getRecentToolCalls: mocks.getRecentToolCalls,
  pruneToolCallLog: mocks.pruneToolCallLog,
}))

vi.mock('../config.js', () => ({}))

vi.mock('../logger.js', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
  },
}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Import AFTER every mock is registered.
const { tryHandleToolLog } = await import('../web/routes/tool-log.js')

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

function mkReq(opts: { body?: Buffer | string }): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(method: string, path: string, opts: { body?: Buffer | string } = {}): Promise<{
  res: MockRes
  handled: boolean
  json: () => unknown
}> {
  const req = mkReq(opts)
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
    fedPeer: null,
  }
  const handled = await tryHandleToolLog(ctx)
  return { res, handled, json: () => JSON.parse(res.body || 'null') }
}

beforeEach(() => {
  mocks.logToolCall.mockReset()
  mocks.analyzeWorkflowCandidates.mockReset()
  mocks.getRecentToolCalls.mockReset()
  mocks.pruneToolCallLog.mockReset()
  mocks.loggerInfo.mockReset()
  mocks.loggerWarn.mockReset()
  mocks.loggerError.mockReset()
  mocks.loggerDebug.mockReset()
})

// ---------------------------------------------------------------------------
// Dispatcher surface
// ---------------------------------------------------------------------------

describe('tryHandleToolLog -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for /api/tool-log on a non-handled method (PUT)', async () => {
    const { handled } = await call('PUT', '/api/tool-log')
    expect(handled).toBe(false)
  })

  it('returns false for /api/tool-log/analyze on a non-handled method (POST)', async () => {
    const { handled } = await call('POST', '/api/tool-log/analyze')
    expect(handled).toBe(false)
  })

  it('returns false for /api/tool-log/prune on a non-handled method (GET)', async () => {
    const { handled } = await call('GET', '/api/tool-log/prune')
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// POST /api/tool-log
// ---------------------------------------------------------------------------

describe('POST /api/tool-log', () => {
  it('logs the call with defaults for every optional field', async () => {
    const { res, json } = await call('POST', '/api/tool-log', {
      body: JSON.stringify({ session_id: 'sess-A', tool_name: 'Edit' }),
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(mocks.logToolCall).toHaveBeenCalledWith(
      'sess-A',
      'Edit',
      null,    // input_summary
      true,    // success = success !== false (defaults to true when undefined)
      null,    // agent_id
      null,    // trace_id
      null,    // duration_ms
    )
  })

  it('passes through every optional field when they are all set', async () => {
    const { res, json } = await call('POST', '/api/tool-log', {
      body: JSON.stringify({
        session_id: 'sess-B',
        tool_name: 'Read',
        input_summary: 'read README.md',
        success: true,
        agent_id: 'main-agent',
        trace_id: 'trace-123',
        duration_ms: 42,
      }),
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(mocks.logToolCall).toHaveBeenCalledWith(
      'sess-B',
      'Read',
      'read README.md',
      true,
      'main-agent',
      'trace-123',
      42,
    )
  })

  it('flips success=false when the hook reports a failure', async () => {
    // success !== false => if success is explicitly false we pass false.
    await call('POST', '/api/tool-log', {
      body: JSON.stringify({ session_id: 's', tool_name: 'Bash', success: false }),
    })
    expect(mocks.logToolCall).toHaveBeenCalledWith(
      's', 'Bash', null, false, null, null, null,
    )
  })

  it('returns 400 when session_id is missing', async () => {
    const { res, json } = await call('POST', '/api/tool-log', {
      body: JSON.stringify({ tool_name: 'Edit' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'session_id and tool_name required' })
    expect(mocks.logToolCall).not.toHaveBeenCalled()
  })

  it('returns 400 when tool_name is missing', async () => {
    const { res, json } = await call('POST', '/api/tool-log', {
      body: JSON.stringify({ session_id: 's' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'session_id and tool_name required' })
    expect(mocks.logToolCall).not.toHaveBeenCalled()
  })

  it('returns 400 with { error: "Invalid JSON" } when the body is not parseable (pinned defect)', async () => {
    const { res, json } = await call('POST', '/api/tool-log', { body: 'not-json{' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
    expect(mocks.logToolCall).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/tool-log
// ---------------------------------------------------------------------------

describe('GET /api/tool-log', () => {
  it('uses the default 3600s window when since is omitted', async () => {
    mocks.getRecentToolCalls.mockReturnValue([{ id: 1, tool_name: 'Read' }])
    const { res, json } = await call('GET', '/api/tool-log')
    expect(res.statusCode).toBe(200)
    expect(mocks.getRecentToolCalls).toHaveBeenCalledWith(3600)
    expect(json()).toEqual([{ id: 1, tool_name: 'Read' }])
  })

  it('uses a custom since window when set', async () => {
    mocks.getRecentToolCalls.mockReturnValue([])
    await call('GET', '/api/tool-log?since=120')
    expect(mocks.getRecentToolCalls).toHaveBeenCalledWith(120)
  })

  it('returns the raw row list untouched (passthrough)', async () => {
    const rows = [
      { id: 1, session_id: 'a', tool_name: 'Edit' },
      { id: 2, session_id: 'b', tool_name: 'Read' },
    ]
    mocks.getRecentToolCalls.mockReturnValue(rows)
    const { json } = await call('GET', '/api/tool-log')
    expect(json()).toEqual(rows)
  })
})

// ---------------------------------------------------------------------------
// GET /api/tool-log/analyze
// ---------------------------------------------------------------------------

describe('GET /api/tool-log/analyze', () => {
  it('passes the parsed since/min_calls/gap args to analyzeWorkflowCandidates', async () => {
    mocks.analyzeWorkflowCandidates.mockReturnValue([])
    await call('GET', '/api/tool-log/analyze?since=600&min_calls=8&gap=120')
    expect(mocks.analyzeWorkflowCandidates).toHaveBeenCalledWith(600, 8, 120)
  })

  it('applies the default since=3600, min_calls=5, gap=300 when omitted', async () => {
    mocks.analyzeWorkflowCandidates.mockReturnValue([])
    await call('GET', '/api/tool-log/analyze')
    expect(mocks.analyzeWorkflowCandidates).toHaveBeenCalledWith(3600, 5, 300)
  })

  it('returns the empty array as-is when there are no candidates', async () => {
    mocks.analyzeWorkflowCandidates.mockReturnValue([])
    const { res, json } = await call('GET', '/api/tool-log/analyze')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('projects each candidate into the summarized shape', async () => {
    // 12 tool calls in the chunk => slice(0, 10) shows 10, the rest are
    // dropped from steps_preview but still count toward tool_count.
    const calls = Array.from({ length: 12 }, (_, i) => ({
      id: i + 1,
      tool_name: i % 3 === 0 ? 'Edit' : i % 3 === 1 ? 'Read' : 'Grep',
      input_summary: i === 0 ? null : `step ${i}`,
      created_at: 1_700_000_000 + i * 60,
    }))
    mocks.analyzeWorkflowCandidates.mockReturnValue([
      {
        session_id: 'sess-X',
        tool_calls: calls,
        start_ts: calls[0].created_at,
        end_ts: calls[calls.length - 1].created_at,
        duration_minutes: 11,
      },
    ])

    const { json } = await call('GET', '/api/tool-log/analyze')
    const summary = json() as Array<Record<string, unknown>>
    expect(summary).toHaveLength(1)
    const c = summary[0]
    expect(c.session_id).toBe('sess-X')
    expect(c.tool_count).toBe(12)
    expect(c.duration_minutes).toBe(11)
    expect(c.start_ts).toBe(calls[0].created_at)
    expect(c.end_ts).toBe(calls[calls.length - 1].created_at)
    expect(c.tools).toEqual(['Edit', 'Read', 'Grep'])
    const preview = c.steps_preview as Array<{ tool: string; description: string }>
    expect(preview).toHaveLength(10)
    // First step has no input_summary, so description falls back to tool_name.
    expect(preview[0]).toEqual({ tool: 'Edit', description: 'Edit' })
    expect(preview[1]).toEqual({ tool: 'Read', description: 'step 1' })
    // The 11th + 12th steps are dropped from the preview slice.
    expect(preview[9].description).toBe('step 9')
  })

  it('handles a candidate with a single repeated tool (unique-set path)', async () => {
    mocks.analyzeWorkflowCandidates.mockReturnValue([
      {
        session_id: 'sess-Y',
        tool_calls: Array.from({ length: 5 }, (_, i) => ({
          id: i + 1,
          tool_name: 'Bash',
          input_summary: `cmd ${i}`,
          created_at: 1_700_000_000 + i * 10,
        })),
        start_ts: 1_700_000_000,
        end_ts: 1_700_000_040,
        duration_minutes: 1,
      },
    ])

    const { json } = await call('GET', '/api/tool-log/analyze')
    const summary = json() as Array<Record<string, unknown>>
    // The Set dedup collapses 5 identical tool_names into a single entry.
    expect(summary[0].tools).toEqual(['Bash'])
    expect((summary[0].steps_preview as unknown[]).length).toBe(5)
  })
})

// ---------------------------------------------------------------------------
// POST /api/tool-log/prune
// ---------------------------------------------------------------------------

describe('POST /api/tool-log/prune', () => {
  it('uses the 86400s default when older_than_secs is missing', async () => {
    const { res, json } = await call('POST', '/api/tool-log/prune', { body: '{}' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(mocks.pruneToolCallLog).toHaveBeenCalledWith(86400)
  })

  it('forwards the explicit older_than_secs value', async () => {
    await call('POST', '/api/tool-log/prune', {
      body: JSON.stringify({ older_than_secs: 3600 }),
    })
    expect(mocks.pruneToolCallLog).toHaveBeenCalledWith(3600)
  })

  it('returns ok=true even when there are no rows to delete', async () => {
    // pruneToolCallLog is silently a no-op when the cutoff is in the future.
    const { res, json } = await call('POST', '/api/tool-log/prune', {
      body: JSON.stringify({ older_than_secs: 60 }),
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })

  it('returns 400 with { error: "Invalid JSON" } when the body is not parseable (pinned defect)', async () => {
    const { res, json } = await call('POST', '/api/tool-log/prune', { body: 'not-json{' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
    expect(mocks.pruneToolCallLog).not.toHaveBeenCalled()
  })
})
