// 100% coverage suite for src/web/routes/spans.ts.
//
// tryHandleSpans owns three HTTP endpoints backed by the otel_spans table
// in src/db.ts:
//
//   POST /api/spans              <- open or close a span (single endpoint)
//   GET  /api/traces             <- list recent trace summaries
//   GET  /api/traces/:id         <- full span tree for a trace
//
// The route imports `upsertOtelSpan`, `closeOtelSpan`, `getOtelTrace`, and
// `listOtelTraces` from `../../db.js`. All four are mocked here so the
// dispatcher runs against a deterministic fake and never touches the live
// SQLite store. `readBody` and `json` from `../http-helpers.js` stay real;
// the helper module is a tiny pure-function bag already covered by the
// http-helpers test suite.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const tmp = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'spans-routes-'))
  return {
    tmp,

    // db -- the four collaborators the route imports. Return types are
    // typed as the function signatures each mock plays the role of so the
    // surrounding assertions get the right element shapes.
    upsertOtelSpan: vi.fn<(...args: unknown[]) => void>(),
    closeOtelSpan: vi.fn<(...args: unknown[]) => boolean>(() => true),
    getOtelTrace: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
    listOtelTraces: vi.fn<(...args: unknown[]) => unknown[]>(() => []),
  }
})

// --- vi.mock factories ------------------------------------------------------

vi.mock('../db.js', () => ({
  upsertOtelSpan: H.upsertOtelSpan,
  closeOtelSpan: H.closeOtelSpan,
  getOtelTrace: H.getOtelTrace,
  listOtelTraces: H.listOtelTraces,
}))

// --- imports ----------------------------------------------------------------

const { tryHandleSpans } = await import('../web/routes/spans.js')

// --- helpers ----------------------------------------------------------------

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

function mkReq(opts: { body?: unknown; raw?: Buffer | string }): http.IncomingMessage {
  let payload: Buffer[]
  if (opts.raw !== undefined) {
    payload = [typeof opts.raw === 'string' ? Buffer.from(opts.raw) : opts.raw]
  } else if (opts.body !== undefined) {
    payload = [Buffer.from(JSON.stringify(opts.body))]
  } else {
    payload = []
  }
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  fullPath: string,
  opts: { body?: unknown; raw?: Buffer | string; query?: string } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> | unknown[] | null }> {
  const urlStr = `http://127.0.0.1:3420${fullPath}${opts.query ? `?${opts.query}` : ''}`
  const url = new URL(urlStr)
  const req = mkReq({ body: opts.body, raw: opts.raw })
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = await tryHandleSpans(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

beforeEach(() => {
  H.upsertOtelSpan.mockReset()
  H.closeOtelSpan.mockReset().mockReturnValue(true)
  H.getOtelTrace.mockReset().mockReturnValue([])
  H.listOtelTraces.mockReset().mockReturnValue([])
})

// --- dispatcher surface -----------------------------------------------------

describe('tryHandleSpans -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for a wrong-method POST on /api/traces', async () => {
    const { handled } = await call('POST', '/api/traces')
    expect(handled).toBe(false)
  })

  it('returns false for a wrong-method GET on /api/spans', async () => {
    const { handled } = await call('GET', '/api/spans')
    expect(handled).toBe(false)
  })
})

// --- POST /api/spans --------------------------------------------------------

describe('POST /api/spans', () => {
  it('opens a span when end_ms is absent and required fields are present', async () => {
    const { res, json } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        agent_id: 'agent-x',
        operation: 'op-a',
        start_ms: 1700000000000,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.upsertOtelSpan).toHaveBeenCalledWith({
      trace_id: 't1',
      span_id: 's1',
      parent_span_id: null,
      agent_id: 'agent-x',
      operation: 'op-a',
      start_ms: 1700000000000,
      end_ms: null,
      status: 'running',
      attributes: null,
    })
  })

  it('passes through parent_span_id + attributes on open', async () => {
    const { res } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        parent_span_id: 'parent-1',
        agent_id: 'agent-x',
        operation: 'op-a',
        start_ms: 1700000000000,
        attributes: '{"k":"v"}',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(H.upsertOtelSpan).toHaveBeenCalledWith(expect.objectContaining({
      parent_span_id: 'parent-1',
      attributes: '{"k":"v"}',
    }))
  })

  it('400s when trace_id is missing', async () => {
    const { res, json } = await call('POST', '/api/spans', {
      body: { span_id: 's1', agent_id: 'a', operation: 'o', start_ms: 1 },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'trace_id and span_id required' })
    expect(H.upsertOtelSpan).not.toHaveBeenCalled()
    expect(H.closeOtelSpan).not.toHaveBeenCalled()
  })

  it('400s when span_id is missing', async () => {
    const { res, json } = await call('POST', '/api/spans', {
      body: { trace_id: 't1', agent_id: 'a', operation: 'o', start_ms: 1 },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'trace_id and span_id required' })
  })

  it('400s when opening without agent_id', async () => {
    const { res, json } = await call('POST', '/api/spans', {
      body: { trace_id: 't1', span_id: 's1', operation: 'o', start_ms: 1 },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent_id, operation, and start_ms required to open a span' })
    expect(H.upsertOtelSpan).not.toHaveBeenCalled()
  })

  it('400s when opening without operation', async () => {
    const { res, json } = await call('POST', '/api/spans', {
      body: { trace_id: 't1', span_id: 's1', agent_id: 'a', start_ms: 1 },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent_id, operation, and start_ms required to open a span' })
  })

  it('400s when opening without start_ms', async () => {
    const { res, json } = await call('POST', '/api/spans', {
      body: { trace_id: 't1', span_id: 's1', agent_id: 'a', operation: 'o' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agent_id, operation, and start_ms required to open a span' })
  })

  it('closes an existing span when end_ms is set and closeOtelSpan returns true', async () => {
    H.closeOtelSpan.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        end_ms: 1700000001000,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.closeOtelSpan).toHaveBeenCalledWith('t1', 's1', 1700000001000, 'ok')
    expect(H.upsertOtelSpan).not.toHaveBeenCalled()
  })

  it('passes through explicit status when closing an existing span', async () => {
    H.closeOtelSpan.mockReturnValue(true)
    const { res } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        end_ms: 1700000001000,
        status: 'error',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(H.closeOtelSpan).toHaveBeenCalledWith('t1', 's1', 1700000001000, 'error')
  })

  it('upserts as a single-event create+close when closeOtelSpan returns false but agent_id/operation/start_ms are provided', async () => {
    H.closeOtelSpan.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        end_ms: 1700000001000,
        agent_id: 'agent-y',
        operation: 'op-b',
        start_ms: 1700000000000,
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.closeOtelSpan).toHaveBeenCalledWith('t1', 's1', 1700000001000, 'ok')
    expect(H.upsertOtelSpan).toHaveBeenCalledWith({
      trace_id: 't1',
      span_id: 's1',
      parent_span_id: null,
      agent_id: 'agent-y',
      operation: 'op-b',
      start_ms: 1700000000000,
      end_ms: 1700000001000,
      status: 'ok',
      attributes: null,
    })
  })

  it('forwards status/parent_span_id/attributes on the create+close fallback path', async () => {
    H.closeOtelSpan.mockReturnValue(false)
    const { res } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        end_ms: 1700000001000,
        agent_id: 'agent-y',
        operation: 'op-b',
        start_ms: 1700000000000,
        parent_span_id: 'parent-x',
        status: 'timeout',
        attributes: '{"k":2}',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(H.upsertOtelSpan).toHaveBeenCalledWith(expect.objectContaining({
      parent_span_id: 'parent-x',
      end_ms: 1700000001000,
      status: 'timeout',
      attributes: '{"k":2}',
    }))
  })

  it('404s when close fails and the upsert fallback fields are missing agent_id', async () => {
    H.closeOtelSpan.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        end_ms: 1700000001000,
        operation: 'op-b',
        start_ms: 1700000000000,
      },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({
      error: 'span not found; provide agent_id, operation, start_ms to create and close in one call',
    })
    expect(H.upsertOtelSpan).not.toHaveBeenCalled()
  })

  it('404s when close fails and operation is missing', async () => {
    H.closeOtelSpan.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        end_ms: 1700000001000,
        agent_id: 'a',
        start_ms: 1,
      },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({
      error: 'span not found; provide agent_id, operation, start_ms to create and close in one call',
    })
  })

  it('404s when close fails and start_ms is missing', async () => {
    H.closeOtelSpan.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/spans', {
      body: {
        trace_id: 't1',
        span_id: 's1',
        end_ms: 1700000001000,
        agent_id: 'a',
        operation: 'o',
      },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({
      error: 'span not found; provide agent_id, operation, start_ms to create and close in one call',
    })
  })

  it('throws when the body is not valid JSON', async () => {
    // The dispatcher does NOT wrap JSON.parse in try/catch -- a malformed
    // body surfaces as a synchronous throw, which the wrapping web.ts
    // dispatcher turns into a 500. The route itself rejects.
    const url = new URL('http://127.0.0.1:3420/api/spans')
    const req = mkReq({ raw: 'not-json{' })
    const res = mkRes()
    const ctx = {
      req,
      res: res as unknown as http.ServerResponse,
      path: url.pathname,
      method: 'POST',
      url,
    }
    await expect(tryHandleSpans(ctx)).rejects.toBeInstanceOf(Error)
  })
})

// --- GET /api/traces --------------------------------------------------------

describe('GET /api/traces', () => {
  it('returns listOtelTraces with the default limit of 50', async () => {
    H.listOtelTraces.mockReturnValue([{ trace_id: 't1', span_count: 3 }])
    const { res, json } = await call('GET', '/api/traces')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([{ trace_id: 't1', span_count: 3 }])
    expect(H.listOtelTraces).toHaveBeenCalledWith(50)
  })

  it('parses the limit query parameter and forwards it', async () => {
    H.listOtelTraces.mockReturnValue([])
    const { res } = await call('GET', '/api/traces', { query: 'limit=10' })
    expect(res.statusCode).toBe(200)
    expect(H.listOtelTraces).toHaveBeenCalledWith(10)
  })

  it('caps the limit at 200', async () => {
    H.listOtelTraces.mockReturnValue([])
    const { res } = await call('GET', '/api/traces', { query: 'limit=9999' })
    expect(res.statusCode).toBe(200)
    expect(H.listOtelTraces).toHaveBeenCalledWith(200)
  })

  it('passes NaN to listOtelTraces when the limit query param is not a number (defect -- see docs/needs-to-be-fix/routes-spans-nan-limit.md)', async () => {
    H.listOtelTraces.mockReturnValue([])
    const { res } = await call('GET', '/api/traces', { query: 'limit=notanumber' })
    expect(res.statusCode).toBe(200)
    // The current dispatcher computes Math.min(parseInt('notanumber'), 200)
    // which is NaN; that NaN is forwarded to listOtelTraces(NaN), which
    // better-sqlite3 rejects at the LIMIT clause. The mock here absorbs
    // the call so the dispatcher still returns 200; the underlying bug is
    // documented separately.
    expect(H.listOtelTraces).toHaveBeenCalledWith(NaN)
  })
})

// --- GET /api/traces/:id ----------------------------------------------------

describe('GET /api/traces/:id', () => {
  it('returns the trace span tree', async () => {
    H.getOtelTrace.mockReturnValue([
      { trace_id: 't1', span_id: 's1', start_ms: 1 },
      { trace_id: 't1', span_id: 's2', start_ms: 2 },
    ])
    const { res, json } = await call('GET', '/api/traces/t1')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      trace_id: 't1',
      spans: [
        { trace_id: 't1', span_id: 's1', start_ms: 1 },
        { trace_id: 't1', span_id: 's2', start_ms: 2 },
      ],
    })
    expect(H.getOtelTrace).toHaveBeenCalledWith('t1')
  })

  it('404s when the trace has no spans', async () => {
    H.getOtelTrace.mockReturnValue([])
    const { res, json } = await call('GET', '/api/traces/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'trace not found' })
    expect(H.getOtelTrace).toHaveBeenCalledWith('missing')
  })

  it('returns false for a non-GET method on the trace path', async () => {
    H.getOtelTrace.mockReturnValue([])
    const { handled } = await call('POST', '/api/traces/t1')
    expect(handled).toBe(false)
  })

  it('returns false for a sub-path under /api/traces that has more segments', async () => {
    // /api/traces/t1/spans is not matched by the dispatcher -- it neither
    // matches the bare /api/traces prefix nor the regex for a single
    // segment. The dispatcher returns false.
    const { handled } = await call('GET', '/api/traces/t1/spans')
    expect(handled).toBe(false)
  })
})
