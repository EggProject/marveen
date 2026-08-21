// 100% line + branch coverage tests for src/web/routes/token-usage.ts.
//
// The route dispatcher (`tryHandleTokenUsage`) wires six HTTP endpoints to the
// pure data layer in src/web/token-usage.ts. The pure functions are already
// covered by token-usage.test.ts / token-usage-full.test.ts. Here we exercise
// the dispatcher shapes:
//
//   * /api/token-usage/collect (POST)    -> collectTokenUsage + correlateWithKanban
//                                            plus the inner try/catch (line 22-25)
//   * /api/token-usage/summary (GET)     -> getTokenSummary + jsonMaybeGzip
//   * /api/token-usage/timeline (GET)    -> getTokenTimeline (incl. bucket default)
//   * /api/token-usage/model-dist (GET)  -> getModelDistribution
//   * /api/token-usage/tool-stats (GET)  -> getToolStats
//   * /api/token-usage (GET)             -> getTokenDetails (incl. Math.min cap)
//   * returns false                       -> path does not match any branch
//
// All collaborators are mocked via vi.hoisted + vi.mock factories so the
// dispatcher is the only thing exercised. http-helpers use the REAL json() /
// jsonMaybeGzip() (tiny, well-tested elsewhere) so we observe the wire-level
// response shape.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Hoisted test harness. vi.mock factories reference H so the captures are
// visible from within the hoisted factory closures.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  collectTokenUsage: vi.fn<(...a: unknown[]) => Promise<{ inserted: number; files: number }>>(
    async () => ({ inserted: 7, files: 3 }),
  ),
  correlateWithKanban: vi.fn<(...a: unknown[]) => void>(() => undefined),
  getTokenSummary: vi.fn<(...a: unknown[]) => unknown[]>(() => [{ agent: 'a1', totalCalls: 1 }]),
  getTokenTimeline: vi.fn<(...a: unknown[]) => unknown[]>(() => [{ bucket: 60, agent: 'a1' }]),
  getTokenDetails: vi.fn<(...a: unknown[]) => unknown[]>(() => [{ id: 1, agent: 'a1' }]),
  getModelDistribution: vi.fn<(...a: unknown[]) => unknown[]>(() => [{ model: 'claude-sonnet-5', count: 2 }]),
  getToolStats: vi.fn<(...a: unknown[]) => unknown[]>(() => [{ tool_name: 'Read', count: 1 }]),
  logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
}))

// vi.mock paths are resolved relative to the TEST file (this file), not the
// SUT. The route imports the data layer via `../token-usage.js` (from
// src/web/routes/token-usage.ts -> src/web/token-usage.ts). From the test
// file at src/__tests__/, that module is `../web/token-usage.js`.
vi.mock('../web/token-usage.js', () => ({
  collectTokenUsage: H.collectTokenUsage,
  getTokenSummary: H.getTokenSummary,
  getTokenTimeline: H.getTokenTimeline,
  getTokenDetails: H.getTokenDetails,
  getModelDistribution: H.getModelDistribution,
  getToolStats: H.getToolStats,
  correlateWithKanban: H.correlateWithKanban,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'info', obj, msg }),
    warn: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'warn', obj, msg }),
    debug: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'debug', obj, msg }),
    error: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'error', obj, msg }),
  },
}))

const { tryHandleTokenUsage } = await import('../web/routes/token-usage.js')

// ---------------------------------------------------------------------------
// Mock req/res that records what the SUT wrote.
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string>
  body: string
  writeHead(status: number, headers?: Record<string, string>): MockRes
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
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkCtx(method: string, fullPath: string, extraHeaders: Record<string, string> = {}): RouteContext {
  const res = mkRes()
  const req = { headers: extraHeaders } as unknown as http.IncomingMessage
  return {
    req,
    res: res as unknown as http.ServerResponse,
    path: new URL(`http://127.0.0.1:3420${fullPath}`).pathname,
    method,
    url: new URL(`http://127.0.0.1:3420${fullPath}`),
    fedPeer: null,
  }
}

async function call(method: string, fullPath: string, extraHeaders: Record<string, string> = {}): Promise<{
  handled: boolean
  res: MockRes
  json: () => unknown
}> {
  const ctx = mkCtx(method, fullPath, extraHeaders)
  const handled = await tryHandleTokenUsage(ctx)
  return {
    res: ctx.res as unknown as MockRes,
    handled,
    json: () => (ctx.res.body ? JSON.parse(ctx.res.body) : null),
  }
}

beforeEach(() => {
  H.collectTokenUsage.mockReset().mockResolvedValue({ inserted: 7, files: 3 })
  H.correlateWithKanban.mockReset().mockImplementation(() => undefined)
  H.getTokenSummary.mockReset().mockReturnValue([{ agent: 'a1', totalCalls: 1 }])
  H.getTokenTimeline.mockReset().mockReturnValue([{ bucket: 60, agent: 'a1' }])
  H.getTokenDetails.mockReset().mockReturnValue([{ id: 1, agent: 'a1' }])
  H.getModelDistribution.mockReset().mockReturnValue([{ model: 'claude-sonnet-5', count: 2 }])
  H.getToolStats.mockReset().mockReturnValue([{ tool_name: 'Read', count: 1 }])
  H.logs.length = 0
})

// ===========================================================================
// /api/token-usage/collect (POST) -- lines 17-27
// ===========================================================================

describe('POST /api/token-usage/collect', () => {
  it('returns { ok: true, ...result } on success', async () => {
    const { handled, json, res } = await call('POST', '/api/token-usage/collect')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.collectTokenUsage).toHaveBeenCalledOnce()
    expect(H.correlateWithKanban).toHaveBeenCalledOnce()
    expect(json()).toEqual({ ok: true, inserted: 7, files: 3 })
  })

  it('logs + returns 500 when collectTokenUsage throws', async () => {
    H.collectTokenUsage.mockReset().mockRejectedValue(new Error('disk full'))
    const { handled, res, json } = await call('POST', '/api/token-usage/collect')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Collection failed' })
    // The error must be logged exactly once with the failing error attached.
    const errors = H.logs.filter((l) => l.level === 'error')
    expect(errors).toHaveLength(1)
    expect((errors[0].obj as { err: unknown }).err).toBeInstanceOf(Error)
    expect(errors[0].msg).toBe('Token usage collection failed')
  })

  it('still returns true when collectTokenUsage throws (handler matched the path)', async () => {
    H.collectTokenUsage.mockReset().mockRejectedValue(new Error('boom'))
    const { handled } = await call('POST', '/api/token-usage/collect')
    expect(handled).toBe(true)
  })

  it('does NOT handle a GET on the collect path', async () => {
    const { handled } = await call('GET', '/api/token-usage/collect')
    expect(handled).toBe(false)
  })
})

// ===========================================================================
// /api/token-usage/summary (GET) -- lines 29-38
// ===========================================================================

describe('GET /api/token-usage/summary', () => {
  it('uses jsonMaybeGzip and parses from/to into integers', async () => {
    const { handled, res, json } = await call('GET', '/api/token-usage/summary?from=100&to=200')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(H.getTokenSummary).toHaveBeenCalledWith(100, 200)
    expect(json()).toEqual([{ agent: 'a1', totalCalls: 1 }])
  })

  it('passes undefined when from/to are absent', async () => {
    await call('GET', '/api/token-usage/summary')
    expect(H.getTokenSummary).toHaveBeenCalledWith(undefined, undefined)
  })

  it('skips parseInt for unparseable query params (falsy string -> undefined)', async () => {
    // url.searchParams.get('from') returns '' for a missing key and the same
    // for an empty value; the ternary `from ? parseInt(from) : undefined`
    // short-circuits on falsy, so we never call parseInt('').
    await call('GET', '/api/token-usage/summary?from=&to=')
    expect(H.getTokenSummary).toHaveBeenCalledWith(undefined, undefined)
  })
})

// ===========================================================================
// /api/token-usage/timeline (GET) -- lines 40-53
// ===========================================================================

describe('GET /api/token-usage/timeline', () => {
  it('defaults bucketMinutes to 60 when bucket is absent', async () => {
    const { handled } = await call('GET', '/api/token-usage/timeline')
    expect(handled).toBe(true)
    expect(H.getTokenTimeline).toHaveBeenCalledWith(60, undefined, undefined, undefined)
  })

  it('parses bucket explicitly and forwards from/to/agent', async () => {
    await call('GET', '/api/token-usage/timeline?bucket=15&from=10&to=99&agent=marveen')
    expect(H.getTokenTimeline).toHaveBeenCalledWith(15, 10, 99, 'marveen')
  })

  it('maps an empty agent query string to undefined', async () => {
    await call('GET', '/api/token-usage/timeline?agent=')
    expect(H.getTokenTimeline).toHaveBeenCalledWith(60, undefined, undefined, undefined)
  })

  it('omits from/to when only one is supplied', async () => {
    await call('GET', '/api/token-usage/timeline?from=50')
    expect(H.getTokenTimeline).toHaveBeenCalledWith(60, 50, undefined, undefined)
  })

  it('falls back bucket to 60 when bucket is unparseable', async () => {
    await call('GET', '/api/token-usage/timeline?bucket=abc')
    expect(H.getTokenTimeline).toHaveBeenCalledWith(60, undefined, undefined, undefined)
  })

  it('falls back bucket to 60 when bucket is below the minimum (0)', async () => {
    await call('GET', '/api/token-usage/timeline?bucket=0')
    expect(H.getTokenTimeline).toHaveBeenCalledWith(60, undefined, undefined, undefined)
  })
})

// ===========================================================================
// /api/token-usage/model-dist (GET) -- lines 55-65
// ===========================================================================

describe('GET /api/token-usage/model-dist', () => {
  it('forwards agent/from/to and returns the data layer response', async () => {
    const { handled, res, json } = await call('GET', '/api/token-usage/model-dist?from=10&to=999&agent=marveen')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.getModelDistribution).toHaveBeenCalledWith(10, 999, 'marveen')
    expect(json()).toEqual([{ model: 'claude-sonnet-5', count: 2 }])
  })

  it('passes undefined when no filters are supplied', async () => {
    await call('GET', '/api/token-usage/model-dist')
    expect(H.getModelDistribution).toHaveBeenCalledWith(undefined, undefined, undefined)
  })

  it('hits the `agent || undefined` negative branch when agent is empty', async () => {
    await call('GET', '/api/token-usage/model-dist?agent=')
    expect(H.getModelDistribution).toHaveBeenCalledWith(undefined, undefined, undefined)
  })

  it('propagates an empty model-distribution result body', async () => {
    H.getModelDistribution.mockReset().mockReturnValue([])
    const { json } = await call('GET', '/api/token-usage/model-dist')
    expect(json()).toEqual([])
  })
})

// ===========================================================================
// /api/token-usage/tool-stats (GET) -- lines 67-77
// ===========================================================================

describe('GET /api/token-usage/tool-stats', () => {
  it('forwards agent/from/to and returns the data layer response', async () => {
    const { handled, res, json } = await call('GET', '/api/token-usage/tool-stats?from=10&to=999&agent=marveen')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.getToolStats).toHaveBeenCalledWith(10, 999, 'marveen')
    expect(json()).toEqual([{ tool_name: 'Read', count: 1 }])
  })

  it('passes undefined when no filters are supplied', async () => {
    await call('GET', '/api/token-usage/tool-stats')
    expect(H.getToolStats).toHaveBeenCalledWith(undefined, undefined, undefined)
  })

  it('maps an empty agent query string to undefined', async () => {
    await call('GET', '/api/token-usage/tool-stats?agent=')
    expect(H.getToolStats).toHaveBeenCalledWith(undefined, undefined, undefined)
  })

  it('hit the cast for from without to', async () => {
    await call('GET', '/api/token-usage/tool-stats?from=1')
    expect(H.getToolStats).toHaveBeenCalledWith(1, undefined, undefined)
  })
})

// ===========================================================================
// /api/token-usage (GET) -- lines 79-98
// ===========================================================================

describe('GET /api/token-usage', () => {
  it('applies defaults (limit=100, offset=0) and includes minTokens when absent', async () => {
    await call('GET', '/api/token-usage')
    expect(H.getTokenDetails).toHaveBeenCalledWith({
      agent: undefined,
      from: undefined,
      to: undefined,
      limit: 100,
      offset: 0,
      minTokens: undefined,
      q: undefined,
    })
  })

  it('forwards all filters and clamps limit to 500', async () => {
    // limit=1000 -> Math.min(1000, 500) = 500. Verifies the cap is enforced.
    const { handled, res } = await call('GET', '/api/token-usage?agent=marveen&from=10&to=999&limit=1000&offset=20&min_tokens=42&q=hello')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.getTokenDetails).toHaveBeenCalledWith({
      agent: 'marveen',
      from: 10,
      to: 999,
      limit: 500,
      offset: 20,
      minTokens: 42,
      q: 'hello',
    })
  })

  it('honors a limit <= 500 verbatim', async () => {
    await call('GET', '/api/token-usage?limit=250')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ limit: 250 }))
  })

  it('maps an empty q string to undefined', async () => {
    await call('GET', '/api/token-usage?q=')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ q: undefined }))
  })

  it('maps an empty agent string to undefined', async () => {
    await call('GET', '/api/token-usage?agent=')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ agent: undefined }))
  })

  it('returns whatever the data layer returns, byte-for-byte', async () => {
    H.getTokenDetails.mockReset().mockReturnValue([{ id: 99 }])
    const { json } = await call('GET', '/api/token-usage')
    expect(json()).toEqual([{ id: 99 }])
  })

  it('falls back limit to 100 when limit is unparseable', async () => {
    await call('GET', '/api/token-usage?limit=abc')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }))
  })

  it('falls back limit to 100 when limit is below the minimum (-1)', async () => {
    await call('GET', '/api/token-usage?limit=-1')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }))
  })

  it('falls back limit to 100 for an empty-string limit param', async () => {
    await call('GET', '/api/token-usage?limit=')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ limit: 100 }))
  })

  it('falls back offset to 0 when offset is unparseable', async () => {
    await call('GET', '/api/token-usage?offset=abc')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }))
  })

  it('falls back offset to 0 when offset is below the minimum (-1)', async () => {
    await call('GET', '/api/token-usage?offset=-1')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }))
  })

  it('accepts offset=0 verbatim (boundary case)', async () => {
    await call('GET', '/api/token-usage?offset=0')
    expect(H.getTokenDetails).toHaveBeenCalledWith(expect.objectContaining({ offset: 0 }))
  })
})

// ===========================================================================
// Path that does not match any branch
// ===========================================================================

describe('non-matching path', () => {
  it('returns false for a path that does not match any branch', async () => {
    const { handled } = await call('POST', '/api/something-else')
    expect(handled).toBe(false)
  })

  it('returns false for a path that matches but with the wrong method', async () => {
    const { handled } = await call('POST', '/api/token-usage/summary')
    expect(handled).toBe(false)
  })
})
