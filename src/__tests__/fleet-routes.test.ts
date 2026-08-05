// 100% coverage suite for src/web/routes/fleet.ts.
//
// tryHandleFleet owns two endpoints:
//   - GET  /api/fleet/export   -> exportFleet(...)
//   - POST /api/fleet/import   -> readBody(req) -> importFleet(rawBody, ...)
// Both accept an optional `X-Vault-Password` header; both reject the request
// when the header is shorter than MIN_VAULT_PASSWORD_LEN.
//
// The route imports three modules:
//   - '../http-helpers.js'   (readBody, json)        -- kept real (pure helpers)
//   - '../fleet-transfer.js' (exportFleet, importFleet, MIN_VAULT_PASSWORD_LEN, UserFacingError, ExportedFleet)
//   - '../../logger.js'      (logger)
// We mock the second + third; the helpers are tiny pure functions already
// covered by http-helpers.test.ts.
//
// The suite convention mocks the canonical collaboration surface
// (config / logger / auth-gate / auth-sessions / db) so the dependency
// graph stays consistent across /api/* route suites, even though
// fleet.ts itself only touches logger + fleet-transfer.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'

const H = vi.hoisted(() => ({
  exportFleet: vi.fn(),
  importFleet: vi.fn(),
  // MIN_VAULT_PASSWORD_LEN is read inside the route handler at call time, so
  // it must be a stable constant. fleet-transfer.js pins it at 8 -- mirror
  // that here so the "too short" branch trips at the same threshold as
  // production. The value itself does not matter for coverage; what matters
  // is that the route reads the constant from the module export.
  MIN_VAULT_PASSWORD_LEN: 8,
  loggerError: vi.fn(),
}))

vi.mock('../web/fleet-transfer.js', () => ({
  exportFleet: H.exportFleet,
  importFleet: H.importFleet,
  MIN_VAULT_PASSWORD_LEN: H.MIN_VAULT_PASSWORD_LEN,
  UserFacingError: class UserFacingError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'UserFacingError'
    }
  },
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: H.loggerError,
    debug: vi.fn(),
  },
}))

// Standardised mocks per suite convention -- fleet.ts does not import these
// directly, but every /api/* route suite in the project stubs them so the
// dependency surface stays uniform.
vi.mock('../db.js', () => ({}))
vi.mock('../config.js', () => ({}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Import AFTER every mock is registered.
const { tryHandleFleet } = await import('../web/routes/fleet.js')

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
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
    setHeader(k, v) {
      this.headers[k] = v
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
 *  'data'/'end'/'error' listeners. The route only reads `req.headers` and
 *  the body, so we keep the rest of the IncomingMessage surface untyped. */
function mkReq(opts: {
  body?: Buffer | string
  headers?: Record<string, string>
  bodyError?: Error
}): { req: http.IncomingMessage; emitData: (chunk: Buffer) => void; emitEnd: () => void; emitError: (err: Error) => void } {
  const ee = new EventEmitter()
  const req = Object.assign(ee, {
    headers: opts.headers ?? {},
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
  query?: string
  headers?: Record<string, string>
  body?: Buffer | string
  bodyError?: Error
}

async function call(opts: CallOpts): Promise<{
  res: MockRes
  handled: boolean
  json: () => unknown
}> {
  const method = opts.method ?? 'GET'
  const path = opts.path ?? '/api/fleet/export'
  const queryStr = opts.query ? `?${opts.query}` : ''
  const url = new URL(`http://127.0.0.1:3420${path}${queryStr}`)
  const reqCtl = mkReq({
    headers: opts.headers,
    body: opts.body,
    bodyError: opts.bodyError,
  })
  const res = mkRes()
  const ctx = {
    req: reqCtl.req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url,
  }
  const promise = tryHandleFleet(ctx)
  // If the caller supplied a body or bodyError, drive the EventEmitter on
  // the next tick so the readBody promise inside the route can attach
  // listeners first. Without this scheduling the 'data'/'end' events fire
  // before readBody subscribes and the promise hangs.
  if (opts.body !== undefined || opts.bodyError !== undefined) {
    await Promise.resolve()
    if (opts.bodyError) reqCtl.emitError(opts.bodyError)
    else if (opts.body !== undefined) {
      const buf = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf-8') : opts.body
      reqCtl.emitData(buf)
      reqCtl.emitEnd()
    }
  }
  const handled = await promise
  return {
    res,
    handled,
    json: () => (res.body ? JSON.parse(res.body) : null),
  }
}

beforeEach(() => {
  H.exportFleet.mockReset()
  H.importFleet.mockReset()
  H.loggerError.mockReset()
})

// ---------------------------------------------------------------------------
// Dispatcher surface (path / method filter)
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call({ path: '/api/other' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/fleet/export on a non-GET method (POST)', async () => {
    const { handled } = await call({ method: 'POST', path: '/api/fleet/export' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/fleet/import on a non-POST method (GET)', async () => {
    const { handled } = await call({ method: 'GET', path: '/api/fleet/import' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/fleet/export on PUT', async () => {
    const { handled } = await call({ method: 'PUT', path: '/api/fleet/export' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/fleet/import on DELETE', async () => {
    const { handled } = await call({ method: 'DELETE', path: '/api/fleet/import' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/fleet/export with a trailing slash', async () => {
    const { handled } = await call({ path: '/api/fleet/export/' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/fleet/import with a trailing slash', async () => {
    const { handled } = await call({ path: '/api/fleet/import/' })
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/fleet/export -- success path
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- GET export success', () => {
  it('writes a JSON attachment with the expected headers when export succeeds', async () => {
    H.exportFleet.mockReturnValue({
      data: '{"hello":"world"}',
      exportedAt: '2026-08-05T12:34:56.789Z',
    })
    const { res, handled } = await call({ method: 'GET', path: '/api/fleet/export' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json')
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="fleet-export-2026-08-05.json"')
    expect(res.body).toBe('{"hello":"world"}')
    expect(H.exportFleet).toHaveBeenCalledWith({ vaultPassword: undefined })
  })

  it('truncates the date in the filename to the YYYY-MM-DD prefix', async () => {
    H.exportFleet.mockReturnValue({
      data: '{}',
      exportedAt: '2030-01-02T03:04:05.000Z',
    })
    const { res } = await call({ method: 'GET', path: '/api/fleet/export' })
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="fleet-export-2030-01-02.json"')
  })

  it('passes the X-Vault-Password header through to exportFleet when provided', async () => {
    H.exportFleet.mockReturnValue({ data: '{}', exportedAt: '2026-01-01T00:00:00.000Z' })
    await call({
      method: 'GET',
      path: '/api/fleet/export',
      headers: { 'x-vault-password': 'long-enough-password' },
    })
    expect(H.exportFleet).toHaveBeenCalledWith({ vaultPassword: 'long-enough-password' })
  })

  it('rejects an empty X-Vault-Password with a 400 (empty string is shorter than MIN_VAULT_PASSWORD_LEN)', async () => {
    // The route guards on `vaultPassword !== undefined && vaultPassword.length < 8`,
    // so the empty string is treated as "too short", not as "absent". The
    // `vaultPassword || undefined` collapse only fires for non-empty strings.
    const { res, handled, json } = await call({
      method: 'GET',
      path: '/api/fleet/export',
      headers: { 'x-vault-password': '' },
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'X-Vault-Password must be at least 8 characters.' })
    expect(H.exportFleet).not.toHaveBeenCalled()
  })

  it('sets Content-Length to the byte length of the exported payload', async () => {
    const data = 'x'.repeat(1234)
    H.exportFleet.mockReturnValue({ data, exportedAt: '2026-01-01T00:00:00.000Z' })
    const { res } = await call({ method: 'GET', path: '/api/fleet/export' })
    // The route forwards buf.byteLength (a number) directly. Node coerces
    // this to a string when writing the real HTTP header; the mock stores
    // the raw value, so compare to the number.
    expect(res.headers['Content-Length']).toBe(1234)
  })
})

// ---------------------------------------------------------------------------
// GET /api/fleet/export -- vault password validation
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- GET export vault password validation', () => {
  it('returns 400 with an explanatory message when the header is shorter than MIN_VAULT_PASSWORD_LEN', async () => {
    const { res, handled, json } = await call({
      method: 'GET',
      path: '/api/fleet/export',
      headers: { 'x-vault-password': 'short' }, // 5 chars < 8
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'X-Vault-Password must be at least 8 characters.',
    })
    expect(H.exportFleet).not.toHaveBeenCalled()
  })

  it('accepts a header exactly at the minimum length without rejecting', async () => {
    H.exportFleet.mockReturnValue({ data: '{}', exportedAt: '2026-01-01T00:00:00.000Z' })
    const { res, handled } = await call({
      method: 'GET',
      path: '/api/fleet/export',
      headers: { 'x-vault-password': '12345678' }, // exactly 8 chars
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.exportFleet).toHaveBeenCalledWith({ vaultPassword: '12345678' })
  })

  it('treats an absent header (undefined) as "no password requested"', async () => {
    H.exportFleet.mockReturnValue({ data: '{}', exportedAt: '2026-01-01T00:00:00.000Z' })
    const { res, handled } = await call({ method: 'GET', path: '/api/fleet/export' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.exportFleet).toHaveBeenCalledWith({ vaultPassword: undefined })
  })
})

// ---------------------------------------------------------------------------
// GET /api/fleet/export -- error paths
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- GET export errors', () => {
  it('maps a UserFacingError from exportFleet to a 400 with the error message', async () => {
    // The route uses `err instanceof UserFacingError`, so the thrown object
    // must be an instance of the class we exposed via the mock.
    const { UserFacingError } = await import('../web/fleet-transfer.js')
    H.exportFleet.mockImplementation(() => {
      throw new UserFacingError('Missing vault key on disk.')
    })
    const { res, handled, json } = await call({ method: 'GET', path: '/api/fleet/export' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Missing vault key on disk.' })
    // UserFacingError is NOT a generic failure -- no log spam.
    expect(H.loggerError).not.toHaveBeenCalled()
  })

  it('maps a generic Error from exportFleet to a 500 with a Hungarian error wrapper', async () => {
    H.exportFleet.mockImplementation(() => {
      throw new Error('disk gone')
    })
    const { res, handled, json } = await call({ method: 'GET', path: '/api/fleet/export' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Export hiba: disk gone' })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError).toHaveBeenCalledWith(
      { err: 'disk gone' },
      'Fleet export failed',
    )
  })
})

// ---------------------------------------------------------------------------
// POST /api/fleet/import -- success / DiffReport / ImportResult
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- POST import success', () => {
  it('returns 200 with the DiffReport when there are no errors', async () => {
    const diff = {
      dryRun: true as const,
      wouldCreate: { mainAgent: true, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      wouldOverwrite: { agents: [], mainAgent: false },
      warnings: [],
      errors: [],
    }
    H.importFleet.mockReturnValue(diff)
    const { res, handled, json } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(diff)
    expect(H.importFleet).toHaveBeenCalledWith('{}', { vaultPassword: undefined, apply: false })
  })

  it('parses the apply=true query parameter and forwards it to importFleet', async () => {
    H.importFleet.mockReturnValue({
      ok: true as const,
      imported: { mainAgent: true, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      warnings: [],
    })
    await call({
      method: 'POST',
      path: '/api/fleet/import',
      query: 'apply=true',
      body: '{}',
    })
    expect(H.importFleet).toHaveBeenCalledWith('{}', { vaultPassword: undefined, apply: true })
  })

  it('parses apply=false (and anything other than the literal "true")', async () => {
    H.importFleet.mockReturnValue({
      dryRun: true as const,
      wouldCreate: { mainAgent: false, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      wouldOverwrite: { agents: [], mainAgent: false },
      warnings: [],
      errors: [],
    })
    await call({
      method: 'POST',
      path: '/api/fleet/import',
      query: 'apply=false',
      body: '{}',
    })
    expect(H.importFleet).toHaveBeenCalledWith('{}', { vaultPassword: undefined, apply: false })
  })

  it('forwards the X-Vault-Password header to importFleet', async () => {
    H.importFleet.mockReturnValue({
      dryRun: true as const,
      wouldCreate: { mainAgent: false, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      wouldOverwrite: { agents: [], mainAgent: false },
      warnings: [],
      errors: [],
    })
    await call({
      method: 'POST',
      path: '/api/fleet/import',
      headers: { 'x-vault-password': 'long-enough-password' },
      body: '{}',
    })
    expect(H.importFleet).toHaveBeenCalledWith('{}', { vaultPassword: 'long-enough-password', apply: false })
  })

  it('returns 200 with an ImportResult (no dryRun field, no errors)', async () => {
    const ir = {
      ok: true as const,
      imported: { mainAgent: true, agents: ['a'], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      warnings: [],
    }
    H.importFleet.mockReturnValue(ir)
    const { res, handled, json } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(ir)
  })

  it('sets the JSON content-type and private,no-store Cache-Control on success', async () => {
    H.importFleet.mockReturnValue({
      dryRun: true as const,
      wouldCreate: { mainAgent: false, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      wouldOverwrite: { agents: [], mainAgent: false },
      warnings: [],
      errors: [],
    })
    const { res } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      body: '{}',
    })
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })
})

// ---------------------------------------------------------------------------
// POST /api/fleet/import -- vault password validation
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- POST import vault password validation', () => {
  it('returns 400 with an explanatory message when the header is shorter than MIN_VAULT_PASSWORD_LEN', async () => {
    const { res, handled, json } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      headers: { 'x-vault-password': 'short' },
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'X-Vault-Password must be at least 8 characters.',
    })
    // Body is never read when the password is rejected.
    expect(H.importFleet).not.toHaveBeenCalled()
  })

  it('accepts a header exactly at the minimum length without rejecting', async () => {
    H.importFleet.mockReturnValue({
      dryRun: true as const,
      wouldCreate: { mainAgent: false, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      wouldOverwrite: { agents: [], mainAgent: false },
      warnings: [],
      errors: [],
    })
    const { res, handled } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      headers: { 'x-vault-password': '12345678' },
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.importFleet).toHaveBeenCalledWith('{}', { vaultPassword: '12345678', apply: false })
  })
})

// ---------------------------------------------------------------------------
// POST /api/fleet/import -- read body failure
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- POST import read body failure', () => {
  it('returns 400 with a Hungarian error wrapper when readBody emits an error', async () => {
    const { res, handled, json } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      bodyError: new Error('socket reset'),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Kérés olvasási hiba: socket reset' })
    expect(H.importFleet).not.toHaveBeenCalled()
    // readBody failures are user-facing -- no logger spam.
    expect(H.loggerError).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// POST /api/fleet/import -- DiffReport with errors -> 400
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- POST import DiffReport with errors', () => {
  it('returns 400 with the DiffReport when importFleet reports errors', async () => {
    const diff = {
      dryRun: true as const,
      wouldCreate: { mainAgent: false, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, kanbanComments: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      wouldOverwrite: { agents: [], mainAgent: false },
      warnings: [],
      errors: ['Helytelen vault jelszó -- a titkosított fájl nem dekódolható.'],
    }
    H.importFleet.mockReturnValue(diff)
    const { res, handled, json } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual(diff)
  })

  it('routes ImportResult (no dryRun field) through the 200 branch even when errors are present', async () => {
    // Defensive check: only DiffReport (`'dryRun' in result`) errors become
    // 400. ImportResult with an `errors` key (none defined by the type, but
    // the runtime guard is `dryRun in result`) should still take the 200
    // branch. We construct an ImportResult without the dryRun discriminator.
    const ir = {
      ok: true as const,
      imported: { mainAgent: true, agents: [], globalSkills: 0, scheduledTasks: 0, memories: 0, kanbanCards: 0, labels: 0, dailyLogs: 0, ideaBox: 0 },
      warnings: [],
      // Cast through unknown to satisfy the type checker; the route does
      // not look at this key.
      errors: ['should be ignored'],
    }
    H.importFleet.mockReturnValue(ir as unknown as ReturnType<typeof H.importFleet>)
    const { res, handled, json } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(ir)
  })
})

// ---------------------------------------------------------------------------
// POST /api/fleet/import -- importFleet throws -> 500
// ---------------------------------------------------------------------------

describe('tryHandleFleet -- POST import unexpected error', () => {
  it('maps a thrown Error from importFleet to a 500 with a Hungarian wrapper and logs', async () => {
    H.importFleet.mockImplementation(() => {
      throw new Error('db corrupt')
    })
    const { res, handled, json } = await call({
      method: 'POST',
      path: '/api/fleet/import',
      body: '{}',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Import hiba: db corrupt' })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError).toHaveBeenCalledWith(
      { err: 'db corrupt' },
      'Fleet import failed',
    )
  })
})
