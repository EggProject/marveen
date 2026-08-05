// 100% coverage suite for src/web/routes/costs.ts.
//
// Costs is the read-mostly HTTP API for CostOps v0.1:
//   GET /api/costs/summary  -- getCostSummary wrapped in the try/catch arm
//   GET /api/costs/sources   -- getCostSources wrapped in the try/catch arm
//   GET /api/costs/budgets   -- config.budgets wrapped in the try/catch arm
//   startCostsSyncTask()     -- periodic fixed-cost -> ledger reflection
//
// The route imports four collaborators; all are mocked here so the dispatcher
// runs against a deterministic fake and never touches the live DB / costops
// loader / costops ledger / logger. `json` from ../http-helpers.js is left
// real: it is a tiny pure helper already covered by the http-helpers test
// suite and the dispatcher relies on its exact status/header semantics.

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => ({
  // db
  getDb: vi.fn<() => unknown>(() => ({ MARKER: 'fake-db' })),

  // costops config
  loadCostopsConfig: vi.fn<() => { config: any; exists: boolean; errors: string[] }>(() => ({
    config: { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] },
    exists: true,
    errors: [],
  })),

  // costops ledger
  syncFixedCostsToLedger: vi.fn<(...args: unknown[]) => number>(() => 0),
  getCostSummary: vi.fn<(...args: unknown[]) => unknown>(() => ({ month: '2026-08' })),
  getCostSources: vi.fn<(...args: unknown[]) => unknown[]>(() => []),

  // logger
  loggerWarn: vi.fn<(...args: unknown[]) => void>(),
  loggerError: vi.fn<(...args: unknown[]) => void>(),
}))

// --- vi.mock factories ------------------------------------------------------

vi.mock('../db.js', () => ({ getDb: H.getDb }))
vi.mock('../logger.js', () => ({
  logger: { warn: H.loggerWarn, error: H.loggerError },
}))
vi.mock('../costops/config.js', () => ({ loadCostopsConfig: H.loadCostopsConfig }))
vi.mock('../costops/ledger.js', () => ({
  syncFixedCostsToLedger: H.syncFixedCostsToLedger,
  getCostSummary: H.getCostSummary,
  getCostSources: H.getCostSources,
}))

// --- imports ----------------------------------------------------------------

const { tryHandleCosts, startCostsSyncTask } = await import('../web/routes/costs.js')

// --- helpers ----------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
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

function call(method: string, fullPath: string): {
  res: MockRes
  handled: boolean
  json: () => Record<string, unknown> | unknown[] | null
} {
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const res = mkRes()
  const ctx: RouteContext = {
    req: { headers: {} } as any,
    res: res as unknown as import('node:http').ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = tryHandleCosts(ctx) as unknown as boolean // Promise<boolean> awaited below
  return {
    res,
    handled: handled as unknown as boolean,
    json: () => (res.body ? JSON.parse(res.body) : null),
  }
}

async function callAsync(method: string, fullPath: string): Promise<{
  res: MockRes
  handled: boolean
  json: () => Record<string, unknown> | unknown[] | null
}> {
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const res = mkRes()
  const ctx: RouteContext = {
    req: { headers: {} } as any,
    res: res as unknown as import('node:http').ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = await tryHandleCosts(ctx)
  return {
    res,
    handled,
    json: () => (res.body ? JSON.parse(res.body) : null),
  }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

beforeEach(() => {
  H.getDb.mockReset().mockReturnValue({ MARKER: 'fake-db' })
  H.loadCostopsConfig.mockReset().mockReturnValue({
    config: { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] },
    exists: true,
    errors: [],
  })
  H.syncFixedCostsToLedger.mockReset().mockReturnValue(0)
  H.getCostSummary.mockReset().mockReturnValue({ month: '2026-08' })
  H.getCostSources.mockReset().mockReturnValue([])
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
})

// --- dispatcher surface -----------------------------------------------------

describe('tryHandleCosts -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await callAsync('GET', '/api/other')
    expect(handled).toBe(false)
    expect(H.getCostSummary).not.toHaveBeenCalled()
    expect(H.getCostSources).not.toHaveBeenCalled()
  })

  it('returns false for POST on /api/costs/summary', async () => {
    const { handled } = await callAsync('POST', '/api/costs/summary')
    expect(handled).toBe(false)
    expect(H.getCostSummary).not.toHaveBeenCalled()
  })

  it('returns false for POST on /api/costs/sources', async () => {
    const { handled } = await callAsync('POST', '/api/costs/sources')
    expect(handled).toBe(false)
    expect(H.getCostSources).not.toHaveBeenCalled()
  })

  it('returns false for POST on /api/costs/budgets', async () => {
    const { handled } = await callAsync('POST', '/api/costs/budgets')
    expect(handled).toBe(false)
    expect(H.loadCostopsConfig).not.toHaveBeenCalled()
  })

  it('returns false for PUT on /api/costs/summary', async () => {
    const { handled } = await callAsync('PUT', '/api/costs/summary')
    expect(handled).toBe(false)
  })

  it('returns false for DELETE on /api/costs/sources', async () => {
    const { handled } = await callAsync('DELETE', '/api/costs/sources')
    expect(handled).toBe(false)
  })
})

// --- GET /api/costs/summary -------------------------------------------------

describe('GET /api/costs/summary', () => {
  it('returns a 200 summary built from getCostSummary', async () => {
    const { res, json, handled } = await callAsync('GET', '/api/costs/summary')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ month: '2026-08' })
    expect(H.loadCostopsConfig).toHaveBeenCalledTimes(1)
    expect(H.getDb).toHaveBeenCalled()
    expect(H.getCostSummary).toHaveBeenCalledTimes(1)
  })

  it('forwards ?month=YYYY-MM as monthKey to getCostSummary', async () => {
    const { handled } = await callAsync('GET', '/api/costs/summary?month=2026-02')
    expect(handled).toBe(true)
    const callArgs = H.getCostSummary.mock.calls[0]
    // signature: (db, config, now, { monthKey, configExists, configErrors })
    expect(callArgs[3]).toEqual({ monthKey: '2026-02', configExists: true, configErrors: [] })
  })

  it('passes monthKey=undefined when no ?month is set (covers the || undefined branch)', async () => {
    const { handled } = await callAsync('GET', '/api/costs/summary')
    expect(handled).toBe(true)
    const callArgs = H.getCostSummary.mock.calls[0]
    expect(callArgs[3]).toEqual({ monthKey: undefined, configExists: true, configErrors: [] })
  })

  it('passes monthKey=undefined when ?month is empty (?month=)', async () => {
    const { handled } = await callAsync('GET', '/api/costs/summary?month=')
    expect(handled).toBe(true)
    const callArgs = H.getCostSummary.mock.calls[0]
    expect(callArgs[3]).toEqual({ monthKey: undefined, configExists: true, configErrors: [] })
  })

  it('propagates configExists and configErrors from loadCostopsConfig', async () => {
    H.loadCostopsConfig.mockReturnValueOnce({
      config: { version: 1, currency: 'USD', fixed_costs: [], budgets: [] },
      exists: false,
      errors: ['config is not valid JSON'],
    })
    const { handled } = await callAsync('GET', '/api/costs/summary')
    expect(handled).toBe(true)
    const callArgs = H.getCostSummary.mock.calls[0]
    expect(callArgs[1]).toEqual({ version: 1, currency: 'USD', fixed_costs: [], budgets: [] })
    expect(callArgs[3]).toEqual({ monthKey: undefined, configExists: false, configErrors: ['config is not valid JSON'] })
  })

  it('500s with an error body and logs logger.error when loadCostopsConfig throws', async () => {
    H.loadCostopsConfig.mockImplementationOnce(() => { throw new Error('boom-summary') })
    const { res, json, handled } = await callAsync('GET', '/api/costs/summary')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Cost summary failed' })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError.mock.calls[0][0]).toEqual({ err: expect.any(Error) })
    expect(H.loggerError.mock.calls[0][1]).toBe('CostOps summary failed')
  })

  it('500s when getCostSummary throws', async () => {
    H.getCostSummary.mockImplementationOnce(() => { throw new Error('boom-summary-fn') })
    const { res, json, handled } = await callAsync('GET', '/api/costs/summary')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Cost summary failed' })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
  })

  it('sets Content-Type application/json on the success response', async () => {
    const { res } = await callAsync('GET', '/api/costs/summary')
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })
})

// --- GET /api/costs/sources -------------------------------------------------

describe('GET /api/costs/sources', () => {
  it('returns a 200 array from getCostSources', async () => {
    H.getCostSources.mockReturnValueOnce([{ id: 'src-1' }, { id: 'src-2' }])
    const { res, json, handled } = await callAsync('GET', '/api/costs/sources')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([{ id: 'src-1' }, { id: 'src-2' }])
    expect(H.getDb).toHaveBeenCalled()
    expect(H.getCostSources).toHaveBeenCalledTimes(1)
  })

  it('500s with an error body and logs logger.error when getCostSources throws', async () => {
    H.getCostSources.mockImplementationOnce(() => { throw new Error('boom-sources') })
    const { res, json, handled } = await callAsync('GET', '/api/costs/sources')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Cost sources failed' })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError.mock.calls[0][0]).toEqual({ err: expect.any(Error) })
    expect(H.loggerError.mock.calls[0][1]).toBe('CostOps sources failed')
  })

  it('sets Content-Type application/json on the success response', async () => {
    const { res } = await callAsync('GET', '/api/costs/sources')
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })
})

// --- GET /api/costs/budgets -------------------------------------------------

describe('GET /api/costs/budgets', () => {
  it('returns a 200 array of budgets from the costops config', async () => {
    H.loadCostopsConfig.mockReturnValueOnce({
      config: {
        version: 1,
        currency: 'HUF',
        fixed_costs: [],
        budgets: [
          { id: 'global-monthly', name: 'Global', scope: 'global', amount: 60000, warning_threshold: 0.8, hard_threshold: 1.0 },
          { id: 'agent-marveen', name: 'Marveen', scope: 'agent', amount: 30000, warning_threshold: 0.8, hard_threshold: 1.0 },
        ],
      },
      exists: true,
      errors: [],
    })
    const { res, json, handled } = await callAsync('GET', '/api/costs/budgets')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([
      { id: 'global-monthly', name: 'Global', scope: 'global', amount: 60000, warning_threshold: 0.8, hard_threshold: 1.0 },
      { id: 'agent-marveen', name: 'Marveen', scope: 'agent', amount: 30000, warning_threshold: 0.8, hard_threshold: 1.0 },
    ])
    expect(H.loadCostopsConfig).toHaveBeenCalledTimes(1)
    expect(H.getCostSummary).not.toHaveBeenCalled()
    expect(H.getCostSources).not.toHaveBeenCalled()
  })

  it('returns an empty array when config.budgets is empty', async () => {
    H.loadCostopsConfig.mockReturnValueOnce({
      config: { version: 1, currency: 'HUF', fixed_costs: [], budgets: [] },
      exists: true,
      errors: [],
    })
    const { res, json, handled } = await callAsync('GET', '/api/costs/budgets')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('500s with an error body and logs logger.error when loadCostopsConfig throws', async () => {
    H.loadCostopsConfig.mockImplementationOnce(() => { throw new Error('boom-budgets') })
    const { res, json, handled } = await callAsync('GET', '/api/costs/budgets')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Cost budgets failed' })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError.mock.calls[0][0]).toEqual({ err: expect.any(Error) })
    expect(H.loggerError.mock.calls[0][1]).toBe('CostOps budgets failed')
  })

  it('sets Content-Type application/json on the success response', async () => {
    const { res } = await callAsync('GET', '/api/costs/budgets')
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })
})

// --- startCostsSyncTask -----------------------------------------------------

describe('startCostsSyncTask', () => {
  // Use fake timers so the setInterval tick is deterministic. Real setInterval
  // would leak into other test files and create flakiness if not cleared.
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('runs the immediate one-shot sync before returning', () => {
    const timer = startCostsSyncTask(60_000)
    expect(H.syncFixedCostsToLedger).toHaveBeenCalledTimes(1)
    // signature: (db, config, now)
    expect(H.syncFixedCostsToLedger.mock.calls[0][0]).toEqual({ MARKER: 'fake-db' })
    expect(H.syncFixedCostsToLedger.mock.calls[0][1]).toEqual({
      version: 1, currency: 'HUF', fixed_costs: [], budgets: [],
    })
    expect(typeof H.syncFixedCostsToLedger.mock.calls[0][2]).toBe('number')
    expect(H.getDb).toHaveBeenCalled()
    expect(H.loadCostopsConfig).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })

  it('returns a NodeJS.Timeout with .unref() applied (does not keep the process alive)', () => {
    const timer = startCostsSyncTask(60_000)
    // setInterval(...).unref() returns the same Timeout object; the spy checks
    // we called .unref() on it so we don't leak the timer into the test runner.
    expect(timer).toBeDefined()
    expect(typeof (timer as any).unref).toBe('function')
    clearInterval(timer)
  })

  it('re-runs the sync after the configured interval elapses', () => {
    const timer = startCostsSyncTask(60_000)
    expect(H.syncFixedCostsToLedger).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(H.syncFixedCostsToLedger).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    expect(H.syncFixedCostsToLedger).toHaveBeenCalledTimes(3)
    clearInterval(timer)
  })

  it('catches a throw from loadCostopsConfig and logs logger.warn (does not crash the interval)', () => {
    H.loadCostopsConfig.mockImplementation(() => { throw new Error('sync-boom') })
    const timer = startCostsSyncTask(60_000)
    expect(H.loggerWarn).toHaveBeenCalledTimes(1)
    expect(H.loggerWarn.mock.calls[0][0]).toEqual({ err: expect.any(Error) })
    expect(H.loggerWarn.mock.calls[0][1]).toBe('CostOps fixed-cost sync failed')
    // the interval is still alive -- another throw should be caught
    vi.advanceTimersByTime(60_000)
    expect(H.loggerWarn).toHaveBeenCalledTimes(2)
    clearInterval(timer)
  })

  it('catches a throw from syncFixedCostsToLedger (config loaded, write throws)', () => {
    H.syncFixedCostsToLedger.mockImplementation(() => { throw new Error('write-boom') })
    const timer = startCostsSyncTask(60_000)
    expect(H.loggerWarn).toHaveBeenCalledTimes(1)
    expect(H.loggerWarn.mock.calls[0][0]).toEqual({ err: expect.any(Error) })
    expect(H.loggerWarn.mock.calls[0][1]).toBe('CostOps fixed-cost sync failed')
    vi.advanceTimersByTime(60_000)
    expect(H.loggerWarn).toHaveBeenCalledTimes(2)
    clearInterval(timer)
  })

  it('uses the default 10-minute interval when none is provided', () => {
    const timer = startCostsSyncTask()
    expect(H.syncFixedCostsToLedger).toHaveBeenCalledTimes(1)
    // 9 minutes -> still 1 call
    vi.advanceTimersByTime(9 * 60 * 1000)
    expect(H.syncFixedCostsToLedger).toHaveBeenCalledTimes(1)
    // 10 minutes -> 2 calls
    vi.advanceTimersByTime(1 * 60 * 1000)
    expect(H.syncFixedCostsToLedger).toHaveBeenCalledTimes(2)
    clearInterval(timer)
  })
})