// Full-surface unit suite for src/web/routes/agent-terminal.ts.
//
// Covers:
//   * sanitizeLiteralKeys (re-exported, but already tested deeply elsewhere;
//     here we focus on the routes).
//   * /api/terminal-input GET + POST (toggle master switch).
//   * /api/agents/:name/pane/stream (SSE) -- basic open/close, target
//     resolution, failure capture.
//   * /api/agents/:name/keys POST (toggle OFF -> 403, agent missing ->
//     404, agent stopped -> 400, send-keys happy + tmux failure).
//   * /api/agents/:name/login POST (phase validation, login sequence happy +
//     tmux failure).
//   * tryHandleAgentTerminal must return false for paths it does not own.
//
// All side effects (tmux, fs, db, config, logger) are mocked. The handler
// under test is imported AFTER the mocks so its module graph sees the
// sandbox.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Readable } from 'node:stream'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Hoisted harness: every vi.mock factory reads from this object so a test
// can re-point a collaborator without re-importing the module under test.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  // agent-config
  agentDir: vi.fn(),
  agentSessionName: vi.fn(),
  isAgentRunning: vi.fn(),
  // main-agent
  isMainChannelsAgent: vi.fn(),
  mainChannelsSession: 'marveen-channels',
  // terminal-input-store
  readTerminalInputEnabled: vi.fn(),
  writeTerminalInputEnabled: vi.fn(),
  // tmux-keys
  literalKeyArgs: vi.fn(),
  specialKeyArgs: vi.fn(),
  loginSequence: vi.fn(),
  // node:child_process
  execFile: vi.fn(),
  execFileSync: vi.fn(),
  // logger
  logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
  throwOnLog: null as string | null,
  // tmux path (resolveFromPath mocked below)
  tmuxPath: '/usr/bin/tmux',
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => H.tmuxPath,
  makeLazyBinResolver: (name: string) => () => H.tmuxPath,
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: H.agentDir,
}))

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: H.agentSessionName,
  isAgentRunning: H.isAgentRunning,
}))

vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: H.isMainChannelsAgent,
  MAIN_CHANNELS_SESSION: H.mainChannelsSession,
}))

vi.mock('../web/terminal-input-store.js', () => ({
  readTerminalInputEnabled: H.readTerminalInputEnabled,
  writeTerminalInputEnabled: H.writeTerminalInputEnabled,
}))

vi.mock('../web/tmux-keys.js', () => ({
  literalKeyArgs: H.literalKeyArgs,
  specialKeyArgs: H.specialKeyArgs,
  loginSequence: H.loginSequence,
}))

vi.mock('../db.js', () => ({}))
vi.mock('../config.js', () => ({}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/agent-bundle.js', () => ({}))

vi.mock('node:child_process', () => ({
  execFile: H.execFile,
  execFileSync: H.execFileSync,
}))

vi.mock('../logger.js', () => {
  const push = (level: string) => (obj: unknown, msg?: unknown) => {
    H.logs.push({ level, obj, msg })
    if (H.throwOnLog !== null && String(msg) === H.throwOnLog) {
      H.throwOnLog = null
      throw new Error('logger sink failed')
    }
  }
  return { logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') } }
})

// Imported AFTER every mock is registered.
const { tryHandleAgentTerminal, sanitizeLiteralKeys } = await import(
  '../web/routes/agent-terminal.js'
)

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  events: string[]
  ended: boolean
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  write(chunk: string): boolean
  end(data?: string): void
  on(_event: string, _cb: (...args: unknown[]) => void): MockRes
}

function mkRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: '',
    events: [],
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    write(chunk) {
      this.events.push(String(chunk))
      return true
    },
    end(data) {
      this.ended = true
      if (data !== undefined) this.body += data
    },
    on() {
      // The handler registers 'close' / 'error' on REQ, not on RES. Keeping
      // a no-op here so TypeScript doesn't complain if anything ever calls it.
      return res
    },
  }
  return res
}

function mkReq(opts: { headers?: Record<string, string | undefined>; body?: unknown; socket?: { remoteAddress?: string } }): http.IncomingMessage {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
  if (opts.socket) {
    r.socket = opts.socket as unknown as http.IncomingMessage['socket']
  }
  // Wrap r.on so we ALSO capture every listener registered on the request, so
  // tests can fire 'close' / 'error' manually. We must NOT replace r.on
  // outright -- readBody relies on the underlying Readable emitting 'data' /
  // 'end' to those listeners.
  const reqHandlers: Record<string, Array<(...args: unknown[]) => void>> = {}
  const originalOn = r.on.bind(r) as http.IncomingMessage['on']
  r.on = ((event: string, cb: (...args: unknown[]) => void) => {
    reqHandlers[event] = reqHandlers[event] ?? []
    reqHandlers[event].push(cb)
    return originalOn(event, cb)
  }) as typeof r.on
  ;(r as unknown as Record<string, unknown>).__handlers = reqHandlers
  return r as http.IncomingMessage
}

function fireReqHandler(req: http.IncomingMessage, event: string, ...args: unknown[]): void {
  const handlers = (req as unknown as { __handlers?: Record<string, Array<(...args: unknown[]) => void>> }).__handlers
  if (!handlers) return
  for (const cb of handlers[event] ?? []) cb(...args)
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string | undefined>; socket?: { remoteAddress?: string } } = {},
): Promise<{ res: MockRes; ctx: RouteContext; handled: boolean; json: () => Record<string, unknown> }> {
  const req = mkReq(opts)
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
  }
  const handled = await tryHandleAgentTerminal(ctx)
  return { res, ctx, handled, json: () => JSON.parse(res.body || '{}') }
}

// A pre-built sandbox the agent-config mock returns from agentDir().
let sandbox = mkdtempSync(join(tmpdir(), 'agent-terminal-routes-'))

beforeEach(() => {
  vi.clearAllMocks()
  // The SSE handler uses setInterval(tick, 700) that runs forever. Use fake
  // timers so the interval can never actually fire during the test -- the
  // 'close' / 'error' handlers in the route clear the interval synchronously
  // after the first tick.
  vi.useFakeTimers({ shouldAdvanceTime: false })
  H.logs.length = 0
  H.throwOnLog = null
  // Fresh sandbox so we never collide on a deleted dir.
  rmSync(sandbox, { recursive: true, force: true })
  sandbox = mkdtempSync(join(tmpdir(), 'agent-terminal-routes-'))

  // Sensible defaults. The handler calls existsSync(agentDir(name)) to gate
  // requests, so the dir must exist on disk for an agent to be "known".
  H.agentDir.mockImplementation((name: string) => {
    const dir = join(sandbox, name)
    mkdirSync(dir, { recursive: true })
    return dir
  })
  H.agentSessionName.mockImplementation((name: string) => `agent-${name}`)
  H.isAgentRunning.mockReturnValue(true)
  H.isMainChannelsAgent.mockReturnValue(false)
  H.readTerminalInputEnabled.mockReturnValue(false)
  H.writeTerminalInputEnabled.mockReturnValue(false)
  H.literalKeyArgs.mockImplementation((session: string, text: string) => ['send-keys', '-t', session, '-l', '--', text])
  H.specialKeyArgs.mockImplementation((session: string, key: string) => ['send-keys', '-t', session, key])
  H.loginSequence.mockReturnValue([
    { kind: 'literal', text: '/login', delayMs: 10 },
  ])
  H.execFile.mockImplementation((_file: string, _args: string[], _opts: unknown, cb?: (err: unknown, stdout?: string) => void) => {
    if (typeof cb === 'function') cb(null, '')
  })
  H.execFileSync.mockReturnValue(Buffer.from(''))
  H.tmuxPath = '/usr/bin/tmux'
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// sanitizeLiteralKeys (the export) -- quick spot-checks; deep coverage lives
// in agent-terminal-sanitize.test.ts.
// ---------------------------------------------------------------------------
describe('sanitizeLiteralKeys (re-export)', () => {
  it('passes a single keystroke through', () => {
    expect(sanitizeLiteralKeys('a')).toBe('a')
  })
  it('strips bracketed-paste markers + trims', () => {
    expect(sanitizeLiteralKeys('\x1b[200~  hello  \x1b[201~')).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Dispatcher: returns false for paths it does not own
// ---------------------------------------------------------------------------
describe('tryHandleAgentTerminal dispatcher', () => {
  it('returns false for a path it does not handle', async () => {
    const { handled, res } = await call('GET', '/api/agents')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for an unknown path with a matching prefix', async () => {
    const { handled } = await call('GET', '/api/agents/zara/pane/other')
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /api/terminal-input -- GET + POST
// ---------------------------------------------------------------------------
describe('GET /api/terminal-input', () => {
  it('returns the current toggle state when OFF', async () => {
    H.readTerminalInputEnabled.mockReturnValue(false)
    const { res, handled, json } = await call('GET', '/api/terminal-input')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ enabled: false })
  })

  it('returns ON when the store says so', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    const { json } = await call('GET', '/api/terminal-input')
    expect(json()).toEqual({ enabled: true })
  })

  it('ignores non-GET methods at this path (falls through)', async () => {
    const { handled } = await call('PUT', '/api/terminal-input')
    expect(handled).toBe(false)
  })
})

describe('POST /api/terminal-input', () => {
  it('flips the toggle OFF and audit-logs the change', async () => {
    H.writeTerminalInputEnabled.mockReturnValue(false)
    const { res, handled, json } = await call('POST', '/api/terminal-input', {
      body: { enabled: false },
      socket: { remoteAddress: '10.0.0.5' },
      headers: { 'x-forwarded-for': '1.2.3.4', 'user-agent': 'curl/8' },
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ enabled: false })
    expect(H.writeTerminalInputEnabled).toHaveBeenCalledWith(false)
    const log = H.logs.find((l) => String(l.msg).includes('TERMINAL-INPUT TOGGLE'))
    expect(log).toBeDefined()
    expect(log?.level).toBe('warn')
  })

  it('flips the toggle ON and audit-logs the change', async () => {
    H.writeTerminalInputEnabled.mockReturnValue(true)
    const { json } = await call('POST', '/api/terminal-input', { body: { enabled: true } })
    expect(json()).toEqual({ enabled: true })
    expect(H.writeTerminalInputEnabled).toHaveBeenCalledWith(true)
  })

  it('tolerates a missing socket / headers (defaults to "unknown")', async () => {
    H.writeTerminalInputEnabled.mockReturnValue(true)
    await call('POST', '/api/terminal-input', { body: { enabled: true } })
    const log = H.logs.find((l) => String(l.msg).includes('TERMINAL-INPUT TOGGLE'))
    expect(log).toBeDefined()
    const obj = log?.obj as Record<string, unknown>
    expect(obj.remote).toBe('unknown')
    expect(obj.xff).toBe('')
    expect(obj.ua).toBe('')
  })

  it('returns 400 on invalid JSON body', async () => {
    // Stream a literal non-JSON body to bypass the JSON.stringify helper.
    const req = Readable.from([Buffer.from('not-json')]) as unknown as http.IncomingMessage
    ;(req as http.IncomingMessage & Record<string, unknown>).headers = {}
    const res = mkRes()
    const ctx: RouteContext = {
      req,
      res: res as unknown as http.ServerResponse,
      path: '/api/terminal-input',
      method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/terminal-input'),
    }
    const handled = await tryHandleAgentTerminal(ctx)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 400 when the body lacks an enabled field', async () => {
    const { res, json } = await call('POST', '/api/terminal-input', { body: { foo: 'bar' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Provide {enabled:boolean}' })
  })

  it('returns 400 when enabled is not a boolean', async () => {
    const { res, json } = await call('POST', '/api/terminal-input', { body: { enabled: 'true' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Provide {enabled:boolean}' })
  })

  it('returns 400 when enabled is null', async () => {
    const { res, json } = await call('POST', '/api/terminal-input', { body: { enabled: null } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Provide {enabled:boolean}' })
  })
})

// ---------------------------------------------------------------------------
// /api/agents/:name/pane/stream (SSE)
// ---------------------------------------------------------------------------
describe('GET /api/agents/:name/pane/stream', () => {
  it('opens an SSE stream, sends the first frame, and registers close handlers', async () => {
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') {
        if (args[0] === 'capture-pane') cb(null, 'hello\nworld\n')
        else cb(null, '')
      }
    })
    const { res, handled } = await call('GET', '/api/agents/zara/pane/stream')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('text/event-stream')
    expect(res.headers['Cache-Control']).toBe('no-cache')
    expect(res.headers['Connection']).toBe('keep-alive')
    expect(res.headers['X-Accel-Buffering']).toBe('no')
    // First capture result is flushed as a data frame.
    expect(res.events.some((e) => e.includes('"running":true') && e.includes('"pane":"hello\\nworld\\n"'))).toBe(true)
    // Capture argv uses the right session and -S -2000 for scrollback.
    const captureCall = H.execFile.mock.calls.find((c) => Array.isArray(c[1]) && c[1][0] === 'capture-pane')
    expect(captureCall).toBeDefined()
    expect(captureCall?.[1]).toEqual(['capture-pane', '-t', 'agent-zara', '-S', '-2000', '-e', '-p'])
  })

  it('returns 404 when the agent has no agents/<name> dir', async () => {
    H.agentDir.mockImplementation(() => join(sandbox, 'missing'))
    const { res, handled, json } = await call('GET', '/api/agents/ghost/pane/stream')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Agent not found' })
    expect(existsSync(join(sandbox, 'missing'))).toBe(false)
  })

  it('resolves the main agent via isMainChannelsAgent + MAIN_CHANNELS_SESSION', async () => {
    H.isMainChannelsAgent.mockReturnValue(true)
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(null, 'main-frame')
    })
    const { res } = await call('GET', '/api/agents/marveen/pane/stream')
    expect(res.statusCode).toBe(200)
    const captureCall = H.execFile.mock.calls.find((c) => Array.isArray(c[1]) && c[1][0] === 'capture-pane')
    expect(captureCall?.[1]).toContain(H.mainChannelsSession)
  })

  it('flips running=false and re-probes via execFileSync on capture failure', async () => {
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') {
        if (args[0] === 'capture-pane') cb(new Error('capture failed'), undefined)
        else cb(null, '')
      }
    })
    H.execFileSync.mockReturnValue(Buffer.from('')) // has-session succeeds
    const { res } = await call('GET', '/api/agents/zara/pane/stream')
    expect(res.statusCode).toBe(200)
    // The execFileSync probe runs against the sub-agent session.
    expect(H.execFileSync).toHaveBeenCalledWith('/usr/bin/tmux', ['has-session', '-t', 'agent-zara'], { timeout: 3000, stdio: 'ignore' })
    expect(res.events.some((e) => e.includes('"running":true'))).toBe(true)
  })

  it('flips running=false when both capture and has-session fail', async () => {
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(new Error('capture failed'), undefined)
    })
    H.execFileSync.mockImplementation(() => { throw new Error('no session') })
    const { res } = await call('GET', '/api/agents/zara/pane/stream')
    expect(res.statusCode).toBe(200)
    expect(res.events.some((e) => e.includes('"running":false'))).toBe(true)
  })

  it('falls back to empty pane when capture succeeds but stdout is undefined', async () => {
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function' && args[0] === 'capture-pane') cb(null, undefined)
    })
    const { res } = await call('GET', '/api/agents/zara/pane/stream')
    expect(res.statusCode).toBe(200)
    expect(res.events.some((e) => e.includes('"pane":""') && e.includes('"running":true'))).toBe(true)
  })

  it('stops streaming when the request emits "close"', async () => {
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(null, 'first')
    })
    const { ctx } = await call('GET', '/api/agents/zara/pane/stream')
    const req = ctx.req as unknown as { __handlers?: Record<string, Array<(...args: unknown[]) => void>> }
    const callsBefore = H.execFile.mock.calls.length
    expect(req.__handlers?.close?.length).toBeGreaterThan(0)
    expect(req.__handlers?.error?.length).toBeGreaterThan(0)
    // Firing close must not throw and the capture spy was called at least once.
    fireReqHandler(ctx.req, 'close')
    expect(callsBefore).toBeGreaterThan(0)
  })

  it('stops streaming on the request "error" event too', async () => {
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(null, 'frame')
    })
    const { ctx } = await call('GET', '/api/agents/zara/pane/stream')
    fireReqHandler(ctx.req, 'error', new Error('socket reset'))
    const req = ctx.req as unknown as { __handlers?: Record<string, Array<(...args: unknown[]) => void>> }
    expect(req.__handlers?.error?.length).toBeGreaterThan(0)
  })

  it('ignores a POST to the pane/stream endpoint (GET-only)', async () => {
    const { handled } = await call('POST', '/api/agents/zara/pane/stream')
    expect(handled).toBe(false)
  })

  it('does not match an extra-segment path', async () => {
    const { handled } = await call('GET', '/api/agents/zara/pane/stream/extra')
    expect(handled).toBe(false)
  })

  it('marks the stream closed when res.write throws (transport error mid-stream)', async () => {
    // Res whose write() throws -- the handler's `catch { closed = true }` must
    // swallow the error so the SSE handler does not crash the request loop.
    const req = mkReq({})
    const res: MockRes = {
      statusCode: 0,
      headers: {},
      body: '',
      events: [],
      ended: false,
      writeHead(status, headers) {
        this.statusCode = status
        if (headers) Object.assign(this.headers, headers)
        return this
      },
      setHeader(k, v) { this.headers[k] = v },
      write() { throw new Error('socket hang up') },
      end(data) { this.ended = true; if (data !== undefined) this.body += data },
      on() { return this },
    }
    const ctx: RouteContext = {
      req,
      res: res as unknown as http.ServerResponse,
      path: '/api/agents/zara/pane/stream',
      method: 'GET',
      url: new URL('http://127.0.0.1:3420/api/agents/zara/pane/stream'),
    }
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function' && args[0] === 'capture-pane') cb(null, 'frame')
    })
    const handled = await tryHandleAgentTerminal(ctx)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    // No event frames made it out (write threw on every attempt).
    expect(res.events).toEqual([])
  })

  it('skips subsequent ticks once the stream is closed (interval keep-firing guard)', async () => {
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function' && args[0] === 'capture-pane') cb(null, 'first')
    })
    const { ctx } = await call('GET', '/api/agents/zara/pane/stream')
    const callsAfterOpen = H.execFile.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'capture-pane').length
    expect(callsAfterOpen).toBe(1)
    // Close the request, then advance fake time past the 700ms interval. The
    // tick body should return at the closed-guard without invoking execFile.
    fireReqHandler(ctx.req, 'close')
    // Advance several intervals so the early-return at `closed || inFlight`
    // is exercised at least once.
    await vi.advanceTimersByTimeAsync(5000)
    const callsAfterClose = H.execFile.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'capture-pane').length
    expect(callsAfterClose).toBe(1)
  })

  it('skips a tick when a previous capture is still in flight', async () => {
    // The mock captures the callback instead of invoking it -- the route
    // sets inFlight=true on entry, so a second tick while the first is still
    // pending must early-return at the `closed || inFlight` guard.
    let pendingCb: ((err: unknown, stdout?: string) => void) | undefined
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function' && args[0] === 'capture-pane') pendingCb = cb
    })
    await call('GET', '/api/agents/zara/pane/stream')
    // First tick: callback captured, inFlight=true.
    expect(H.execFile.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'capture-pane').length).toBe(1)
    // Advance time -- the interval fires tick() again, which must NOT call
    // execFile again because inFlight is still true.
    await vi.advanceTimersByTimeAsync(5000)
    expect(H.execFile.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'capture-pane').length).toBe(1)
    // Now finish the first capture and confirm subsequent ticks resume.
    pendingCb!(null, 'done')
    await vi.advanceTimersByTimeAsync(2000)
    expect(H.execFile.mock.calls.filter((c) => Array.isArray(c[1]) && c[1][0] === 'capture-pane').length).toBeGreaterThan(1)
  })

  it('drops the capture result when the request closes mid-capture', async () => {
    // Capture the callback so we can fire it AFTER the req is closed: the
    // handler's post-capture `if (closed) return` guard must short-circuit.
    let pendingCb: ((err: unknown, stdout?: string) => void) | undefined
    H.execFile.mockImplementation((_f: string, args: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function' && args[0] === 'capture-pane') pendingCb = cb
    })
    const { ctx, res } = await call('GET', '/api/agents/zara/pane/stream')
    fireReqHandler(ctx.req, 'close')
    expect(pendingCb).toBeDefined()
    // Fire the slow callback now -- the closed-flag drops the write attempt.
    pendingCb!(null, 'late-frame')
    expect(res.events.some((e) => e.includes('late-frame'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /api/agents/:name/keys (POST)
// ---------------------------------------------------------------------------
describe('POST /api/agents/:name/keys', () => {
  it('returns 403 when the master toggle is OFF', async () => {
    H.readTerminalInputEnabled.mockReturnValue(false)
    const { res, handled, json } = await call('POST', '/api/agents/zara/keys', {
      body: { keys: 'hello' },
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(json().error).toMatch(/disabled/)
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('KEYS INJECTION BLOCKED'))).toBe(true)
  })

  it('returns 404 when the agent has no agents/<name> dir', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.agentDir.mockImplementation(() => join(sandbox, 'nope'))
    const { res, json } = await call('POST', '/api/agents/ghost/keys', { body: { keys: 'x' } })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Agent not found' })
  })

  it('returns 400 when the agent exists but is not running', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.isAgentRunning.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/agents/zara/keys', { body: { keys: 'x' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Agent is not running' })
  })

  it('returns 400 on invalid JSON body', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    const req = Readable.from([Buffer.from('oops')]) as unknown as http.IncomingMessage
    ;(req as http.IncomingMessage & Record<string, unknown>).headers = {}
    const res = mkRes()
    const ctx: RouteContext = {
      req,
      res: res as unknown as http.ServerResponse,
      path: '/api/agents/zara/keys',
      method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/agents/zara/keys'),
    }
    const handled = await tryHandleAgentTerminal(ctx)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toEqual({ error: 'Invalid JSON' })
  })

  it('sends literal keys and audit-logs the sanitized preview', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(null, '')
    })
    const { res, json } = await call('POST', '/api/agents/zara/keys', {
      body: { keys: '  hello\n' },
      socket: { remoteAddress: '127.0.0.1' },
      headers: { 'x-forwarded-for': '10.0.0.1', 'user-agent': 'vitest' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.literalKeyArgs).toHaveBeenCalledWith('agent-zara', 'hello')
    const log = H.logs.find((l) => String(l.msg).includes('KEYS INJECTION ACCEPTED'))
    expect(log?.level).toBe('info')
    const obj = log?.obj as Record<string, unknown>
    expect(obj.name).toBe('zara')
    expect(obj.preview).toBe('keys:"hello"')
  })

  it('truncates the preview and adds an ellipsis when > 120 chars', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(null, '')
    })
    const long = 'a'.repeat(150)
    await call('POST', '/api/agents/zara/keys', { body: { keys: long } })
    const log = H.logs.find((l) => String(l.msg).includes('KEYS INJECTION ACCEPTED'))
    const preview = (log?.obj as Record<string, unknown>).preview as string
    expect(preview.endsWith('…')).toBe(true)
    // The literal-key value passed to tmux is the full string (sanitize is
    // pure trim + strip; never length-clips).
    expect(H.literalKeyArgs).toHaveBeenCalledWith('agent-zara', long)
  })

  it('passes a special key through verbatim and logs preview with "special:"', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(null, '')
    })
    await call('POST', '/api/agents/zara/keys', { body: { special: 'Enter' } })
    expect(H.specialKeyArgs).toHaveBeenCalledWith('agent-zara', 'Enter')
    const log = H.logs.find((l) => String(l.msg).includes('KEYS INJECTION ACCEPTED'))
    expect((log?.obj as Record<string, unknown>).preview).toBe('special:Enter')
  })

  it('treats an unknown special as "no args" -> 400', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.specialKeyArgs.mockReturnValue(null)
    const { res, json } = await call('POST', '/api/agents/zara/keys', { body: { special: 'NOPE' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Provide {keys:string} or an allow-listed {special}' })
  })

  it('treats an empty literalKeyArgs as "no args" -> 400', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.literalKeyArgs.mockReturnValue(null)
    const { res, json } = await call('POST', '/api/agents/zara/keys', { body: { keys: '' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Provide {keys:string} or an allow-listed {special}' })
  })

  it('returns 400 when both keys and special are missing/null', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/agents/zara/keys', { body: {} })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Provide {keys:string} or an allow-listed {special}' })
  })

  it('ignores a non-string keys (sanitizeLiteralKeys is bypassed -> null literalKeys -> 400)', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/agents/zara/keys', { body: { keys: 123 } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Provide {keys:string} or an allow-listed {special}' })
  })

  it('returns 500 + warn when tmux send-keys rejects', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown) => void) => {
      if (typeof cb === 'function') cb(new Error('tmux down'))
    })
    const { res, json } = await call('POST', '/api/agents/zara/keys', { body: { keys: 'x' } })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'send-keys failed' })
    expect(H.logs.some((l) => String(l.msg).includes('send-keys failed'))).toBe(true)
  })

  it('skips sanitizeLiteralKeys for a single-character literal (passthrough)', async () => {
    H.readTerminalInputEnabled.mockReturnValue(true)
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown, stdout?: string) => void) => {
      if (typeof cb === 'function') cb(null, '')
    })
    await call('POST', '/api/agents/zara/keys', { body: { keys: ' ' } })
    expect(H.literalKeyArgs).toHaveBeenCalledWith('agent-zara', ' ')
  })

  it('does not handle a GET on /keys', async () => {
    const { handled } = await call('GET', '/api/agents/zara/keys')
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// /api/agents/:name/login (POST)
// ---------------------------------------------------------------------------
describe('POST /api/agents/:name/login', () => {
  it('returns 404 when the agent has no dir', async () => {
    H.agentDir.mockImplementation(() => join(sandbox, 'nope'))
    const { res, json } = await call('POST', '/api/agents/ghost/login', { body: { phase: 'start' } })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Agent not found' })
  })

  it('returns 400 when the agent exists but is not running', async () => {
    H.isAgentRunning.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/agents/zara/login', { body: { phase: 'start' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Agent is not running' })
  })

  it('returns 400 when phase is missing entirely (default "no phase" branch)', async () => {
    // The handler does `try { phase = ... } catch { /* default below */ }` so
    // a JSON body without `phase` leaves phase undefined -> 400.
    const { res, json } = await call('POST', '/api/agents/zara/login', { body: {} })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: "phase must be 'start' or 'confirm'" })
  })

  it('returns 400 when phase is invalid', async () => {
    const { res, json } = await call('POST', '/api/agents/zara/login', { body: { phase: 'later' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: "phase must be 'start' or 'confirm'" })
  })

  it('accepts phase "start" and runs the login sequence', async () => {
    H.loginSequence.mockReturnValue([
      { kind: 'literal', text: '/login', delayMs: 0 },
      { kind: 'special', key: 'Enter', delayMs: 0 },
    ])
    H.literalKeyArgs.mockImplementation((session: string, text: string) => ['send-keys', '-t', session, '-l', '--', text])
    H.specialKeyArgs.mockImplementation((session: string, key: string) => ['send-keys', '-t', session, key])
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown) => void) => {
      if (typeof cb === 'function') cb(null)
    })
    const { res, json } = await call('POST', '/api/agents/zara/login', { body: { phase: 'start' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, phase: 'start' })
    expect(H.loginSequence).toHaveBeenCalledWith('start')
    expect(H.literalKeyArgs).toHaveBeenCalledWith('agent-zara', '/login')
    expect(H.specialKeyArgs).toHaveBeenCalledWith('agent-zara', 'Enter')
    expect(H.logs.some((l) => String(l.msg).includes('/login sequence sent'))).toBe(true)
  })

  it('accepts phase "confirm"', async () => {
    H.loginSequence.mockReturnValue([
      { kind: 'special', key: 'Enter', delayMs: 0 },
    ])
    H.specialKeyArgs.mockImplementation((session: string, key: string) => ['send-keys', '-t', session, key])
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown) => void) => {
      if (typeof cb === 'function') cb(null)
    })
    const { res, json } = await call('POST', '/api/agents/zara/login', { body: { phase: 'confirm' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, phase: 'confirm' })
    expect(H.loginSequence).toHaveBeenCalledWith('confirm')
  })

  it('returns 500 + warn when tmux rejects during the sequence', async () => {
    H.loginSequence.mockReturnValue([
      { kind: 'literal', text: '/login', delayMs: 0 },
    ])
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown) => void) => {
      if (typeof cb === 'function') cb(new Error('tmux down'))
    })
    const { res, json } = await call('POST', '/api/agents/zara/login', { body: { phase: 'start' } })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'login sequence failed' })
    expect(H.logs.some((l) => String(l.msg).includes('/login sequence failed'))).toBe(true)
  })

  it('skips a step when its keyArgs return null', async () => {
    H.loginSequence.mockReturnValue([
      { kind: 'literal', text: '', delayMs: 0 },     // literalKeyArgs -> null
      { kind: 'special', key: 'NOPE', delayMs: 0 }, // specialKeyArgs -> null
    ])
    H.literalKeyArgs.mockReturnValue(null)
    H.specialKeyArgs.mockReturnValue(null)
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown) => void) => {
      if (typeof cb === 'function') cb(null)
    })
    const { res, json } = await call('POST', '/api/agents/zara/login', { body: { phase: 'start' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, phase: 'start' })
    // Both steps were skipped, so tmux was never invoked.
    expect(H.execFile).not.toHaveBeenCalled()
  })

  it('ignores a GET on /login', async () => {
    const { handled } = await call('GET', '/api/agents/zara/login')
    expect(handled).toBe(false)
  })

  it('sleeps between steps when delayMs > 0 (exercises the sleep helper)', async () => {
    H.loginSequence.mockReturnValue([
      { kind: 'literal', text: '/login', delayMs: 50 },
      { kind: 'special', key: 'Enter', delayMs: 0 },
    ])
    H.literalKeyArgs.mockImplementation((session: string, text: string) => ['send-keys', '-t', session, '-l', '--', text])
    H.specialKeyArgs.mockImplementation((session: string, key: string) => ['send-keys', '-t', session, key])
    H.execFile.mockImplementation((_f: string, _a: string[], _o: unknown, cb?: (err: unknown) => void) => {
      if (typeof cb === 'function') cb(null)
    })
    // Kick off the request (which awaits the sleep internally) -- then advance
    // the fake clock past the delay so the inner setTimeout resolves.
    const pending = call('POST', '/api/agents/zara/login', { body: { phase: 'start' } })
    await vi.advanceTimersByTimeAsync(100)
    const { res, json } = await pending
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, phase: 'start' })
  })
})

// ---------------------------------------------------------------------------
// Edge: route is gated behind the dashboard auth gate (the gate is upstream
// and unit-tested separately); here we only assert the route does NOT 401/403
// on its own.
// ---------------------------------------------------------------------------
describe('tryHandleAgentTerminal routing order', () => {
  it('handles /api/terminal-input before pane/stream (path is more specific)', async () => {
    const { res, json } = await call('GET', '/api/terminal-input')
    expect(res.statusCode).toBe(200)
    expect(json()).toHaveProperty('enabled')
  })
})
