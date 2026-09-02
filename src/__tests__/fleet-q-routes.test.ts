// 100% coverage suite for src/web/routes/fleet-q.ts.
//
// `tryHandleFleetQ` owns two endpoints:
//
//   GET  /.well-known/fleetq                 -> manifest from agent-config
//   PUT  /api/agents/:name/capabilities      -> update capability tags
//
// The route reaches into two SUT modules:
//
//   '../agent-config.js' (listAgentNames, readAgentCapabilities,
//                        writeAgentCapabilities, isKnownAgent)
//   '../http-helpers.js' (readBody, json)        -- kept real (pure helpers)
//
// Plus the standardised collaboration surface (db / config / logger /
// auth-gate / auth-sessions) that every /api/* route suite stubs even
// when the SUT does not touch them, so the dependency graph stays uniform.
//
// Determinism:
//   * No setTimeout / setInterval anywhere in the SUT or the test harness.
//   * `readBody` is the real helper; we drive its `data`/`end` events from
//     a controlled EventEmitter, so no real socket is involved.
//   * No randomness.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'

// --- hoisted harness ------------------------------------------------------

const H = vi.hoisted(() => ({
  listAgentNames: vi.fn((): string[] => []),
  readAgentCapabilities: vi.fn((): string[] => []),
  writeAgentCapabilities: vi.fn(),
  isKnownAgent: vi.fn((): boolean => false),

  // logger stubs (SUT does not touch logger, kept for uniformity)
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: H.listAgentNames,
  readAgentCapabilities: H.readAgentCapabilities,
  writeAgentCapabilities: H.writeAgentCapabilities,
  isKnownAgent: H.isKnownAgent,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

// Standardised stubs -- SUT does not import these directly, but every
// /api/* route suite in the project mocks them so the dependency graph
// stays uniform.
vi.mock('../db.js', () => ({}))
vi.mock('../config.js', () => ({}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Import AFTER every mock is registered.
const { tryHandleFleetQ } = await import('../web/routes/fleet-q.js')

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  end(data?: string | Buffer): void
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
      if (data !== undefined) {
        this.body += typeof data === 'string' ? data : data.toString()
      }
    },
  }
}

/** A fake `http.IncomingMessage` that exposes a mutable `headers` bag and
 *  behaves like an EventEmitter so the real `readBody` helper can attach
 *  'data'/'end'/'error' listeners. */
function mkReq(opts: {
  body?: Buffer | string
  bodyError?: unknown
}): {
  req: http.IncomingMessage
  emitData: (chunk: Buffer) => void
  emitEnd: () => void
  emitError: (err: unknown) => void
} {
  const ee = new EventEmitter()
  const req = Object.assign(ee, {
    headers: {},
  }) as unknown as http.IncomingMessage
  return {
    req,
    emitData: (chunk) => ee.emit('data', chunk),
    emitEnd: () => ee.emit('end'),
    emitError: (err) => ee.emit('error', err),
  }
}

interface CallOpts {
  method?: string
  path?: string
  body?: Buffer | string
  bodyError?: unknown
}

async function call(opts: CallOpts): Promise<{
  res: MockRes
  handled: boolean
  json: () => unknown
}> {
  const method = opts.method ?? 'GET'
  const path = opts.path ?? '/.well-known/fleetq'
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const reqCtl = mkReq({ body: opts.body, bodyError: opts.bodyError })
  const res = mkRes()
  const ctx = {
    req: reqCtl.req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url,
    fedPeer: null,
  }
  const promise = tryHandleFleetQ(ctx)
  // If the caller supplied a body or bodyError, drive the EventEmitter on
  // the next tick so readBody's promise can attach listeners first.
  if (opts.body !== undefined || opts.bodyError !== undefined) {
    await Promise.resolve()
    if (opts.bodyError) reqCtl.emitError(opts.bodyError)
    else if (opts.body !== undefined) {
      const buf = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf-8') : opts.body
      reqCtl.emitData(buf)
      reqCtl.emitEnd()
    }
  }
  // Let the rejection propagate -- the SUT does not wrap readBody /
  // JSON.parse, so failure paths surface as a thrown promise. Tests that
  // exercise those branches expect to await a rejection (defect pinning).
  const handled = await promise
  return {
    res,
    handled,
    json: () => (res.body ? JSON.parse(res.body) : null),
  }
}

beforeEach(() => {
  H.listAgentNames.mockReset()
  H.readAgentCapabilities.mockReset()
  H.writeAgentCapabilities.mockReset()
  H.isKnownAgent.mockReset()
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()

  H.listAgentNames.mockReturnValue([])
  H.readAgentCapabilities.mockReturnValue([])
  H.isKnownAgent.mockReturnValue(false)
})

// ---------------------------------------------------------------------------
// Dispatcher surface
// ---------------------------------------------------------------------------

describe('tryHandleFleetQ -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call({ path: '/api/something/else' })
    expect(handled).toBe(false)
  })

  it('returns false for /.well-known/fleetq on POST', async () => {
    const { handled } = await call({ method: 'POST', path: '/.well-known/fleetq' })
    expect(handled).toBe(false)
  })

  it('returns false for /.well-known/fleetq on PUT', async () => {
    const { handled } = await call({ method: 'PUT', path: '/.well-known/fleetq' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/agents/foo/capabilities on GET', async () => {
    const { handled } = await call({ method: 'GET', path: '/api/agents/foo/capabilities' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/agents/foo/capabilities on POST', async () => {
    const { handled } = await call({ method: 'POST', path: '/api/agents/foo/capabilities' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/agents/foo/capabilities on DELETE', async () => {
    const { handled } = await call({ method: 'DELETE', path: '/api/agents/foo/capabilities' })
    expect(handled).toBe(false)
  })

  it('returns false for a partial agent path (missing /capabilities suffix)', async () => {
    const { handled } = await call({ method: 'PUT', path: '/api/agents/foo' })
    expect(handled).toBe(false)
  })

  it('returns false for a path with extra segments after capabilities', async () => {
    const { handled } = await call({ method: 'PUT', path: '/api/agents/foo/capabilities/extra' })
    expect(handled).toBe(false)
  })

  it('returns false for a nested agent path (slash in name)', async () => {
    // The regex rejects names with embedded slashes -- the regex captures
    // [^/]+ so /api/agents/foo/bar/capabilities does not match.
    const { handled } = await call({ method: 'PUT', path: '/api/agents/foo/bar/capabilities' })
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /.well-known/fleetq
// ---------------------------------------------------------------------------

describe('tryHandleFleetQ -- GET /.well-known/fleetq', () => {
  it('returns an empty manifest when listAgentNames is empty', async () => {
    H.listAgentNames.mockReturnValue([])
    const { res, handled, json } = await call({ method: 'GET', path: '/.well-known/fleetq' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
    expect(json()).toEqual({})
    // readAgentCapabilities is never called when listAgentNames is empty.
    expect(H.readAgentCapabilities).not.toHaveBeenCalled()
  })

  it('builds a { name: caps } manifest from listAgentNames + readAgentCapabilities', async () => {
    H.listAgentNames.mockReturnValue(['agent-a', 'agent-b', 'main-agent'])
    H.readAgentCapabilities.mockImplementation(((name: string) => {
      if (name === 'agent-a') return ['architecture', 'infrastructure']
      if (name === 'agent-b') return ['management']
      return []
    }) as never)
    const { res, handled, json } = await call({ method: 'GET', path: '/.well-known/fleetq' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      'agent-a': ['architecture', 'infrastructure'],
      'agent-b': ['management'],
      'main-agent': [],
    })
    expect(H.readAgentCapabilities).toHaveBeenCalledTimes(3)
    expect(H.readAgentCapabilities).toHaveBeenNthCalledWith(1, 'agent-a')
    expect(H.readAgentCapabilities).toHaveBeenNthCalledWith(2, 'agent-b')
    expect(H.readAgentCapabilities).toHaveBeenNthCalledWith(3, 'main-agent')
  })

  it('writes the standard JSON response headers (private, no-store)', async () => {
    H.listAgentNames.mockReturnValue(['x'])
    const { res } = await call({ method: 'GET', path: '/.well-known/fleetq' })
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })
})

// ---------------------------------------------------------------------------
// PUT /api/agents/:name/capabilities -- unknown agent
// ---------------------------------------------------------------------------

describe('tryHandleFleetQ -- PUT unknown agent', () => {
  it('returns 404 with generic Not found when isKnownAgent is false', async () => {
    H.isKnownAgent.mockReturnValue(false)
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/ghost/capabilities',
      body: '{"capabilities":["x"]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Not found' })
    // The body is never read when the agent is unknown.
    expect(H.writeAgentCapabilities).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// PUT /api/agents/:name/capabilities -- body validation
// ---------------------------------------------------------------------------

describe('tryHandleFleetQ -- PUT body validation', () => {
  beforeEach(() => {
    H.isKnownAgent.mockReturnValue(true)
  })

  it('returns 400 when capabilities is missing entirely', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
    expect(H.writeAgentCapabilities).not.toHaveBeenCalled()
  })

  it('returns 400 when capabilities is not an array (string)', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":"not-an-array"}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
  })

  it('returns 400 when capabilities is null', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":null}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
  })

  it('returns 400 when capabilities is a number', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":42}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
  })

  it('returns 400 when capabilities is an object', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":{"foo":"bar"}}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
  })

  it('returns 400 when any capability is not a string (number)', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":["ok",42]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
    expect(H.writeAgentCapabilities).not.toHaveBeenCalled()
  })

  it('returns 400 when any capability is null', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":["ok",null]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
  })

  it('returns 400 when any capability is an object', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":["ok",{"x":1}]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
  })

  it('returns 400 when any capability is a nested array', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":["ok",["nested"]]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: string[] required' })
  })
})

// ---------------------------------------------------------------------------
// PUT /api/agents/:name/capabilities -- success
// ---------------------------------------------------------------------------

describe('tryHandleFleetQ -- PUT success', () => {
  beforeEach(() => {
    H.isKnownAgent.mockReturnValue(true)
  })

  it('writes the capabilities and returns 200 with { ok: true, capabilities }', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":["architecture","infrastructure"]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
    expect(json()).toEqual({
      ok: true,
      capabilities: ['architecture', 'infrastructure'],
    })
    expect(H.writeAgentCapabilities).toHaveBeenCalledTimes(1)
    expect(H.writeAgentCapabilities).toHaveBeenCalledWith('agent-a', [
      'architecture',
      'infrastructure',
    ])
  })

  it('accepts an empty string[] (a valid but empty tag list)', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":[]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, capabilities: [] })
    expect(H.writeAgentCapabilities).toHaveBeenCalledWith('agent-a', [])
  })

  it('ignores extra fields on the body (only `capabilities` is validated)', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{"capabilities":["x"],"note":"ignored","tags":["y"]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, capabilities: ['x'] })
  })

  it('URL-decodes the agent name from the path capture group', async () => {
    // The SUT calls decodeURIComponent on the regex capture before passing
    // the name to isKnownAgent + writeAgentCapabilities. Cover that branch
    // by using a name containing a percent-encoded space ("hello%20world").
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/hello%20world/capabilities',
      body: '{"capabilities":["x"]}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, capabilities: ['x'] })
    expect(H.isKnownAgent).toHaveBeenCalledWith('hello world')
    expect(H.writeAgentCapabilities).toHaveBeenCalledWith('hello world', ['x'])
  })
})

// ---------------------------------------------------------------------------
// PUT /api/agents/:name/capabilities -- error paths
//
// The SUT does NOT wrap readBody() or JSON.parse() in try/catch. A malformed
// body or a non-object JSON value escapes the handler as an unhandled
// promise rejection. The web dispatcher only sees `false` when the handler
// resolves cleanly -- a rejection propagates up the chain.
//
// These tests pin the FIXED behavior: the handler returns a structured 400
// instead of propagating the rejection, which proves the fix.
// ---------------------------------------------------------------------------

describe('tryHandleFleetQ -- PUT request body failure paths', () => {
  beforeEach(() => {
    H.isKnownAgent.mockReturnValue(true)
  })

  it('returns 400 with Kérés olvasási hiba when readBody rejects', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      bodyError: new Error('socket reset'),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Kérés olvasási hiba: socket reset' })
    expect(H.writeAgentCapabilities).not.toHaveBeenCalled()
  })

  // Cover fleet-q.ts:33 branch[1]: when the underlying readBody rejects with
  // something that isn't an Error instance, the cond-expr falls through to
  // String(err) -- a plain object yields '[object Object]', a string yields
  // itself.
  it('returns 400 with String(err) when readBody rejects with a non-Error value', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      bodyError: { code: 'BADGER' }, // non-Error throw -- String() yields [object Object]
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Kérés olvasási hiba: [object Object]' })
  })

  it('returns 400 with Érvénytelen JSON törzs when the body is malformed', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '{not valid json',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Érvénytelen JSON törzs.' })
    expect(H.writeAgentCapabilities).not.toHaveBeenCalled()
  })

  it('returns 400 with object body required when the body parses to null', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: 'null',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: object body required' })
    expect(H.writeAgentCapabilities).not.toHaveBeenCalled()
  })

  it('returns 400 with object body required when the body is a JSON array', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '[]',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: object body required' })
  })

  it('returns 400 with object body required when the body is a JSON string', async () => {
    const { res, handled, json } = await call({
      method: 'PUT',
      path: '/api/agents/agent-a/capabilities',
      body: '"hi"',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'capabilities: object body required' })
  })
})
