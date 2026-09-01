// Route-handler coverage suite for src/web/routes/auth.ts.
//
// The companion suite auth-routes.test.ts exercises the same module end-to-end
// with real db / sessions / device-keys; this suite is the FULL line+branch
// pass. Heavy collaborators are mocked so every branch (incl. defensive ones
// such as parseCookies with a missing header, the global-throttle warning log,
// removeBridgeSshAccess throwing) has a dedicated test.
//
// Mocks (per the task contract): node:fs, node:os, ../config.js, ../db.js,
// ../web/auth-gate.js, ../web/auth-sessions.js, ../web/dashboard-auth.js,
// ../logger.js.

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

// --- Mocks for the heavy deps ----------------------------------------------

// node:fs / node:os / config.js: pulled in transitively by modules the gate
// imports. Stubbing here means the test never touches the real filesystem or
// the real /tmp layout -- the live-install guard in setup/assert-not-live-
// install.ts still gates the run, but this makes the suite idempotent across
// repeated runs in any working dir.
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    // No-op stubs for the entrypoints that touch real paths. We don't call
    // them in this suite, but auth-gate -> dashboard-auth -> config chain can
    // resolve them during module init; keep them harmless.
    readFileSync: vi.fn(() => ''),
    existsSync: vi.fn(() => false),
    mkdirSync: vi.fn(),
  }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: vi.fn(() => '/tmp/auth-test-home'),
    tmpdir: vi.fn(() => '/tmp'),
  }
})

vi.mock('../config.js', () => ({
  STORE_DIR: '/tmp/auth-test-store',
  DB_FILENAME: 'test.sqlite',
  ALLOWED_CHAT_ID: '',
  OLLAMA_URL: '',
  APP_TZ: 'UTC',
  WEB_PORT: 3420,
  PROJECT_ROOT: '/tmp/auth-test-root',
  CHANNEL_TOKEN: '',
  CHANNEL_CHAT_ID: '',
  TELEGRAM_BOT_TOKEN: '',
  CHANNEL_PROVIDER: '',
}))

vi.mock('../db.js', () => {
  // In-memory shape of the dashboard_users / config_change_log tables the
  // handler reads/writes. Each entry mirrors DashboardUser minus the
  // id-disabled column ordering.
  let nextId = 1
  const users = new Map<string, MockUser>()
  return {
    createDashboardUser: vi.fn((username: string, passwordHash: string): MockUser => {
      const row: MockUser = { id: nextId++, username, password_hash: passwordHash, disabled: 0 }
      users.set(username.toLowerCase(), row)
      return row
    }),
    getDashboardUser: vi.fn((username: string): MockUser | undefined => {
      return users.get(username.toLowerCase())
    }),
    listDashboardUsers: vi.fn(() => Array.from(users.values()).map(({ password_hash: _ph, ...rest }) => rest)),
    countDashboardUsers: vi.fn((includeDisabled = false) => {
      let n = 0
      for (const u of users.values()) if (includeDisabled || u.disabled === 0) n++
      return n
    }),
    updateDashboardUserPassword: vi.fn((userId: number, hash: string) => {
      for (const u of users.values()) if (u.id === userId) u.password_hash = hash
    }),
    deleteDashboardUser: vi.fn((username: string) => {
      const key = username.toLowerCase()
      const had = users.delete(key)
      return had
    }),
    logConfigChange: vi.fn(),
  }
})

import type { DashboardUser } from '../db.js'

interface MockUser extends Omit<DashboardUser, 'created_at' | 'updated_at'> {
  id: number
  username: string
  password_hash: string
  disabled: number
}

vi.mock('../web/auth-gate.js', async () => {
  const actual = await vi.importActual<typeof import('../web/auth-gate.js')>('../web/auth-gate.js')
  return {
    ...actual,
    parseCookies: actual.parseCookies,
    SESSION_COOKIE_NAME: actual.SESSION_COOKIE_NAME,
  }
})

vi.mock('../web/auth-sessions.js', () => ({
  createSession: vi.fn(() => 'mock-session-token-abcdef1234567890'),
  revokeSession: vi.fn(),
  revokeAllForUser: vi.fn(),
  listUserSessions: vi.fn(() => []),
  resolveSession: vi.fn(() => null),
  sweepExpiredSessions: vi.fn(() => 0),
  revokeAllSessions: vi.fn(() => 0),
}))

vi.mock('../web/auth-device-keys.js', () => ({
  createDeviceKey: vi.fn(() => ({
    id: 1,
    name: 'phone',
    createdAt: 1700000000,
    lastUsedAt: null,
    expiresAt: null,
    installId: null,
    key: 'mvdk_abcdef1234567890',
  })),
  listDeviceKeys: vi.fn(() => []),
  revokeDeviceKey: vi.fn(() => true),
  getDeviceKey: vi.fn(() => null),
  resolveDeviceKey: vi.fn(() => null),
  findDeviceKeyByInstallId: vi.fn(() => null),
  sweepExpiredDeviceKeys: vi.fn(() => 0),
  revokeAllDeviceKeys: vi.fn(() => 0),
}))

vi.mock('../web/password-hash.js', () => {
  class PasswordPolicyError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'PasswordPolicyError'
    }
  }
  return {
    hashPassword: vi.fn(async (pw: string) => `$scrypt$ln=16,r=8,p=1$c2FsdA==$${Buffer.from(pw).toString('base64')}`),
    verifyPassword: vi.fn(async () => false),
    assertPasswordPolicy: vi.fn(() => undefined),
    PasswordPolicyError,
    MIN_PASSWORD_LENGTH: 10,
    MAX_PASSWORD_LENGTH: 128,
  }
})

vi.mock('../web/login-throttle.js', () => ({
  checkThrottle: vi.fn(() => ({ locked: false, retryAfterS: 0, global: false })),
  recordFailure: vi.fn(),
  recordSuccess: vi.fn(),
  runDummyVerify: vi.fn(async () => undefined),
  isGlobalLimited: vi.fn(() => false),
}))

vi.mock('../notify.js', () => ({
  notifyChannel: vi.fn(async () => undefined),
  notifyTelegram: vi.fn(async () => undefined),
  notifySecurityEvent: vi.fn(async () => undefined),
}))

vi.mock('../web/dashboard-auth.js', () => ({
  checkBearerToken: vi.fn(() => false),
  loadOrCreateDashboardToken: vi.fn(() => 'mock-token'),
}))

vi.mock('../logger.js', () => {
  const noop = () => {}
  const logger = {
    info: vi.fn(noop),
    warn: vi.fn(noop),
    error: vi.fn(noop),
    debug: vi.fn(noop),
    trace: vi.fn(noop),
    fatal: vi.fn(noop),
    child: vi.fn(() => logger),
    level: 'silent',
  }
  return { logger }
})

// --- Subject under test (imported AFTER mocks are registered) -------------

import { tryHandleAuth } from '../web/routes/auth.js'
import type { RouteContext } from '../web/routes/types.js'

// --- Mock instances we reach into -----------------------------------------

import * as dbModule from '../db.js'
import * as sessionsModule from '../web/auth-sessions.js'
import * as authGateModule from '../web/auth-gate.js'
import * as passwordHashModule from '../web/password-hash.js'
import * as loginThrottleModule from '../web/login-throttle.js'
import { logger } from '../logger.js'

// --- HTTP shims ------------------------------------------------------------

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

function mkReq(opts: {
  body?: unknown
  headers?: Record<string, string | string[] | undefined>
} = {}): http.IncomingMessage {
  const payload = opts.body === undefined ? [] : [Buffer.from(JSON.stringify(opts.body))]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown
    headers?: Record<string, string | string[] | undefined>
    auth?: RouteContext['auth']
    rawBody?: string
  } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  let req: http.IncomingMessage
  if (opts.rawBody !== undefined) {
    const r = Readable.from([Buffer.from(opts.rawBody)]) as unknown as http.IncomingMessage & Record<string, unknown>
    r.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
    req = r as http.IncomingMessage
  } else {
    req = mkReq({ headers: opts.headers, body: opts.body })
  }
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    auth: opts.auth,
    fedPeer: null,
  }
  const handled = await tryHandleAuth(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

function cookieHeader(res: MockRes): string {
  const c = res.headers['Set-Cookie']
  return Array.isArray(c) ? c.join('\n') : (c ?? '')
}

// --- Test helpers -----------------------------------------------------------

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH = (user: string): RouteContext['auth'] => ({ kind: 'session', user })
const DEVICE_AUTH = { kind: 'device', device: 'myphone', deviceId: 1 } as unknown as RouteContext['auth']
const FEDERATION_AUTH: RouteContext['auth'] = { kind: 'federation', peer: 'test-peer' }

const GOOD_PW = 'super-secret-pw'

beforeEach(() => {
  // Reset call records only -- implementations are left in place so the
  // mock factories' defaults (checkThrottle unlocked, verifyPassword false,
  // etc.) keep applying across tests. Tests that need a different value
  // override the relevant mock explicitly below.
  vi.clearAllMocks()
  vi.mocked(dbModule.countDashboardUsers).mockImplementation((includeDisabled = false) => 0)
  vi.mocked(dbModule.listDashboardUsers).mockReturnValue([])
  vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
  vi.mocked(dbModule.createDashboardUser).mockImplementation((username: string, hash: string) => ({
    id: 1,
    username,
    password_hash: hash,
    disabled: 0,
    created_at: 0,
  updated_at: 0,
}))
  vi.mocked(loginThrottleModule.checkThrottle).mockReturnValue({ locked: false, retryAfterS: 0, global: false })
  vi.mocked(passwordHashModule.assertPasswordPolicy).mockImplementation(() => undefined)
  vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(false)
  // createSession must return a non-empty token so the cookie path can set it.
  vi.mocked(sessionsModule.createSession).mockReturnValue('mock-session-token-abcdef1234567890')
})

// ============================================================================
// /api/auth/status
// ============================================================================

describe('GET /api/auth/status', () => {
  it('returns setup_required:true with zero users and unauthenticated principal', async () => {
    const { handled, json } = await call('GET', '/api/auth/status')
    expect(handled).toBe(true)
    expect(json()).toEqual({
      authenticated: false,
      method: null,
      user: null,
      device: null,
      login_available: false,
      setup_required: true,
    })
  })

  it('reports authenticated:true, method:token for a token principal', async () => {
    vi.mocked(dbModule.countDashboardUsers).mockReturnValue(1)
    const { json } = await call('GET', '/api/auth/status', { auth: TOKEN_AUTH })
    expect(json()).toMatchObject({
      authenticated: true,
      method: 'token',
      user: null,
      device: null,
      login_available: true,
      setup_required: false,
    })
  })

  it('reports method:session and the user name for a session principal', async () => {
    vi.mocked(dbModule.countDashboardUsers).mockReturnValue(1)
    const { json } = await call('GET', '/api/auth/status', { auth: SESSION_AUTH('alice') })
    expect(json()).toMatchObject({
      authenticated: true,
      method: 'session',
      user: 'alice',
      device: null,
    })
  })

  it('reports method:device and the device name for a device principal', async () => {
    vi.mocked(dbModule.countDashboardUsers).mockReturnValue(1)
    const { json } = await call('GET', '/api/auth/status', { auth: DEVICE_AUTH })
    expect(json()).toMatchObject({
      authenticated: true,
      method: 'device',
      user: null,
      device: 'myphone',
    })
  })

  it('returns user:null when a session principal has no user field (auth?.user ?? null)', async () => {
    vi.mocked(dbModule.countDashboardUsers).mockReturnValue(1)
    const { json } = await call('GET', '/api/auth/status', { auth: { kind: 'session' } })
    expect(json()).toMatchObject({ method: 'session', user: null, device: null })
  })

  it('returns device:null when a device principal has no device field (auth?.device ?? null)', async () => {
    vi.mocked(dbModule.countDashboardUsers).mockReturnValue(1)
    const { json } = await call('GET', '/api/auth/status', {
      auth: { kind: 'device', deviceId: 1 } as unknown as RouteContext['auth'],
    })
    expect(json()).toMatchObject({ method: 'device', device: null })
  })
})

// ============================================================================
// /api/auth/login
// ============================================================================

describe('POST /api/auth/login', () => {
  it('returns 400 Invalid JSON on a malformed body', async () => {
    const { res, json } = await call('POST', '/api/auth/login', { rawBody: 'not-json' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 400 Invalid JSON on an empty body (parses {} -> no creds -> 401)', async () => {
    // empty string -> parseJsonBody returns {} early, so the JSON-parse branch
    // is bypassed and we fall into the credential check (still no user -> 401).
    const { res } = await call('POST', '/api/auth/login', { rawBody: '' })
    expect(res.statusCode).toBe(401)
  })

  it('treats a JSON literal body (e.g. null) as empty credentials (parseJsonBody returns {} for non-objects)', async () => {
    // JSON.parse('null') === null -> parseJsonBody returns {} -> no creds -> 401.
    const { res, json } = await call('POST', '/api/auth/login', { rawBody: 'null' })
    expect(res.statusCode).toBe(401)
    expect(json()).toEqual({ error: 'Invalid credentials' })
  })

  it('treats a JSON number/string body as empty credentials (parseJsonBody returns {} for non-objects)', async () => {
    // JSON.parse('"hi"') === 'hi' (not an object) -> parseJsonBody returns {} -> no creds.
    const { res } = await call('POST', '/api/auth/login', { rawBody: '"hi"' })
    expect(res.statusCode).toBe(401)
  })

  it('rejects an unknown user with 401 and the standard error body', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/auth/login', { body: { username: 'nobody', password: GOOD_PW } })
    expect(res.statusCode).toBe(401)
    expect(json()).toEqual({ error: 'Invalid credentials' })
    expect(loginThrottleModule.recordFailure).toHaveBeenCalledWith('nobody')
  })

  it('rejects a disabled user (no verify, dummy run for timing parity)', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 1,
      created_at: 0,
  updated_at: 0,
})
    const { res } = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(res.statusCode).toBe(401)
    expect(loginThrottleModule.recordFailure).toHaveBeenCalledWith('alice')
  })

  it('rejects a wrong password with 401', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res } = await call('POST', '/api/auth/login', { body: { username: 'alice', password: 'wrong-password' } })
    expect(res.statusCode).toBe(401)
  })

  it('mints a session, sets the cookie (no Secure over plain http), and records success', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 7,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(true)
    const { res, json } = await call('POST', '/api/auth/login', {
      body: { username: 'alice', password: GOOD_PW },
      headers: { 'user-agent': 'TestBrowser/1.0' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, user: 'alice' })
    expect(loginThrottleModule.recordSuccess).toHaveBeenCalledWith('alice')
    expect(sessionsModule.createSession).toHaveBeenCalledOnce()
    const args = vi.mocked(sessionsModule.createSession).mock.calls[0]!
    expect(args[0]).toEqual({ userId: 7, username: 'alice' })
    expect(args[1]).toMatchObject({ userAgent: 'TestBrowser/1.0', remoteNote: 'loopback' })
    const c = cookieHeader(res)
    expect(c).toContain('HttpOnly')
    expect(c).toContain('SameSite=Strict')
    expect(c).toContain('Path=/')
    expect(c).toContain('Max-Age=2592000')
    expect(c).not.toContain('Secure')
    expect(c).toContain('mv_session=mock-session-token-abcdef1234567890')
  })

  it('appends Secure to the cookie when x-forwarded-proto: https', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(true)
    const { res } = await call('POST', '/api/auth/login', {
      body: { username: 'alice', password: GOOD_PW },
      headers: { 'x-forwarded-proto': 'https' },
    })
    expect(cookieHeader(res)).toContain('Secure')
  })

  it('handles x-forwarded-proto as an array (first entry wins)', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(true)
    const { res } = await call('POST', '/api/auth/login', {
      body: { username: 'alice', password: GOOD_PW },
      headers: { 'x-forwarded-proto': ['https', 'http'] },
    })
    expect(cookieHeader(res)).toContain('Secure')
  })

  it('ignores x-forwarded-proto when the value is not "https"', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(true)
    const { res } = await call('POST', '/api/auth/login', {
      body: { username: 'alice', password: GOOD_PW },
      headers: { 'x-forwarded-proto': 'http' },
    })
    expect(cookieHeader(res)).not.toContain('Secure')
  })

  it('revokes a presented session cookie on successful login (fixation defence)', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(true)
    await call('POST', '/api/auth/login', {
      body: { username: 'alice', password: GOOD_PW },
      headers: { cookie: 'mv_session=old-cookie-value' },
    })
    expect(sessionsModule.revokeSession).toHaveBeenCalledWith('old-cookie-value')
  })

  it('skips revoke when no cookie is presented on login', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(true)
    await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(sessionsModule.revokeSession).not.toHaveBeenCalled()
  })

  it('returns 429 with Retry-After when the per-user throttle is locked', async () => {
    vi.mocked(loginThrottleModule.checkThrottle).mockReturnValue({
      locked: true,
      retryAfterS: 42,
      global: false,
    })
    const { res, json } = await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(res.statusCode).toBe(429)
    expect(res.headers['Retry-After']).toBe('42')
    expect(json()).toEqual({ error: 'Too many attempts', retry_after_s: 42 })
  })

  it('warns when the GLOBAL throttle cap is reached', async () => {
    vi.mocked(loginThrottleModule.checkThrottle).mockReturnValue({
      locked: true,
      retryAfterS: 60,
      global: true,
    })
    await call('POST', '/api/auth/login', { body: { username: 'alice', password: GOOD_PW } })
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith('login: global failure cap reached -- all logins throttled')
  })

  it('treats a missing username as the unknown-user branch (no verify, dummy run)', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    const { res } = await call('POST', '/api/auth/login', { body: { password: GOOD_PW } })
    expect(res.statusCode).toBe(401)
    expect(loginThrottleModule.runDummyVerify).toHaveBeenCalledWith(GOOD_PW)
  })

  it('treats a missing password as the unknown-user branch (no verify, dummy run)', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'hash',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res } = await call('POST', '/api/auth/login', { body: { username: 'alice' } })
    expect(res.statusCode).toBe(401)
    expect(loginThrottleModule.runDummyVerify).toHaveBeenCalledWith('')
  })
})

// ============================================================================
// /api/auth/logout
// ============================================================================

describe('POST /api/auth/logout', () => {
  it('revokes the presented cookie and clears it via Set-Cookie Max-Age=0', async () => {
    const { res, json } = await call('POST', '/api/auth/logout', {
      headers: { cookie: 'mv_session=present-cookie' },
    })
    expect(sessionsModule.revokeSession).toHaveBeenCalledWith('present-cookie')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(cookieHeader(res)).toContain('Max-Age=0')
    expect(cookieHeader(res)).toContain('HttpOnly')
  })

  it('does not crash when no cookie is presented', async () => {
    const { res, json } = await call('POST', '/api/auth/logout')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(sessionsModule.revokeSession).not.toHaveBeenCalled()
  })

  it('emits Secure on the clear-cookie when x-forwarded-proto: https', async () => {
    const { res } = await call('POST', '/api/auth/logout', { headers: { 'x-forwarded-proto': 'https' } })
    expect(cookieHeader(res)).toContain('Secure')
  })
})

// ============================================================================
// /api/auth/logout-all
// ============================================================================

describe('POST /api/auth/logout-all', () => {
  it('rejects when the principal is not a session', async () => {
    const { res, json } = await call('POST', '/api/auth/logout-all', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Session required' })
  })

  it('rejects when the session principal has no user field', async () => {
    const { res, json } = await call('POST', '/api/auth/logout-all', { auth: { kind: 'session' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Session required' })
  })

  it('is a safe no-op when the user is no longer in the DB', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/auth/logout-all', { auth: SESSION_AUTH('ghost') })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(sessionsModule.revokeAllForUser).not.toHaveBeenCalled()
  })

  it('revokes every session of the user and clears the cookie', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 7,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res, json } = await call('POST', '/api/auth/logout-all', { auth: SESSION_AUTH('alice') })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(sessionsModule.revokeAllForUser).toHaveBeenCalledWith(7)
    expect(cookieHeader(res)).toContain('Max-Age=0')
  })
})

// ============================================================================
// /api/auth/sessions
// ============================================================================

describe('GET /api/auth/sessions', () => {
  it('rejects when the principal is not a session', async () => {
    const { res, json } = await call('GET', '/api/auth/sessions', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Session required' })
  })

  it('rejects when the session principal has no user field', async () => {
    const { res, json } = await call('GET', '/api/auth/sessions', { auth: { kind: 'session' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Session required' })
  })

  it('returns 404 when the user is no longer in the DB', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    const { res, json } = await call('GET', '/api/auth/sessions', { auth: SESSION_AUTH('ghost') })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'User not found' })
  })

  it('returns the user session list for a valid session principal', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 11,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(sessionsModule.listUserSessions).mockReturnValue([
      { idHashPrefix: 'abc123def456', createdAt: 1, lastSeenAt: 2, userAgent: 'curl' },
    ])
    const { res, json } = await call('GET', '/api/auth/sessions', { auth: SESSION_AUTH('alice') })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      sessions: [{ idHashPrefix: 'abc123def456', createdAt: 1, lastSeenAt: 2, userAgent: 'curl' }],
    })
    expect(sessionsModule.listUserSessions).toHaveBeenCalledWith(11)
  })
})

// ============================================================================
// /api/auth/password
// ============================================================================

describe('POST /api/auth/password', () => {
  it('returns 400 Invalid JSON on malformed body', async () => {
    const { res, json } = await call('POST', '/api/auth/password', { rawBody: '{not-json' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 403 for a credential kind that is neither token nor session', async () => {
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: DEVICE_AUTH,
      body: { username: 'alice', new_password: 'newpw-newpw' },
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for an undefined principal', async () => {
    const { res, json } = await call('POST', '/api/auth/password', {
      body: { username: 'alice', new_password: 'newpw-newpw' },
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for a federation kind (allowlist default-deny)', async () => {
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: FEDERATION_AUTH,
      body: { username: 'alice', new_password: 'newpw-newpw' },
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 404 on the session path when the user is missing from the DB', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: SESSION_AUTH('ghost'),
      body: { current_password: 'whatever', new_password: 'newpw-newpw' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'User not found' })
  })

  it('returns 404 on the token path when the username is missing from the DB', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: TOKEN_AUTH,
      body: { username: 'ghost', new_password: 'newpw-newpw' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'User not found' })
  })

  it('returns 404 on the token path when the username is empty', async () => {
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: TOKEN_AUTH,
      body: { username: '', new_password: 'newpw-newpw' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'User not found' })
  })

  it('rejects a wrong current_password on the session path with 401', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 7,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(false)
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: SESSION_AUTH('alice'),
      body: { current_password: 'wrong-old-pw', new_password: 'newpw-newpw' },
    })
    expect(res.statusCode).toBe(401)
    expect(json()).toEqual({ error: 'Invalid credentials' })
    expect(dbModule.updateDashboardUserPassword).not.toHaveBeenCalled()
  })

  it('accepts a correct current_password on the session path and rotates the hash', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 7,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    vi.mocked(passwordHashModule.verifyPassword).mockResolvedValue(true)
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: SESSION_AUTH('alice'),
      body: { current_password: GOOD_PW, new_password: 'rotated-password' },
      headers: { cookie: 'mv_session=present-cookie' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(dbModule.updateDashboardUserPassword).toHaveBeenCalledOnce()
    // Revoke all OTHER sessions, keep the caller's own.
    expect(sessionsModule.revokeAllForUser).toHaveBeenCalledWith(7, 'present-cookie')
    // Session path: NO break-glass audit row, NO notify call.
    expect(dbModule.logConfigChange).not.toHaveBeenCalled()
  })

  it('accepts a break-glass token reset (no current_password, audits, notifies)', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 7,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: TOKEN_AUTH,
      body: { username: 'alice', new_password: 'token-rotated-pw' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(dbModule.updateDashboardUserPassword).toHaveBeenCalledOnce()
    // Break-glass path audits the username (never credential material) and
    // pings the operator's channel.
    expect(dbModule.logConfigChange).toHaveBeenCalledWith(
      'security.break_glass_password_reset',
      null,
      'alice',
      'token',
    )
    // No presented cookie -> revokeAllForUser is called with undefined except.
    expect(sessionsModule.revokeAllForUser).toHaveBeenCalledWith(7, undefined)
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith({ username: 'alice' }, 'break-glass password reset via bearer token')
  })

  it('returns 400 on password policy violation (non-PasswordPolicyError fallback)', async () => {
    // Throw from a non-arrow function so v8 tracks the catch branch distinctly
    // from any inline-mock quirk.
    vi.mocked(passwordHashModule.assertPasswordPolicy).mockImplementation(function () {
      throw new Error('some-other-error')
    })
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 7,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: TOKEN_AUTH,
      body: { username: 'alice', new_password: 'whatever' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid password' })
    expect(dbModule.updateDashboardUserPassword).not.toHaveBeenCalled()
  })

  it('rejects a non-PasswordPolicyError from assertPasswordPolicy when called by users POST', async () => {
    vi.mocked(passwordHashModule.assertPasswordPolicy).mockImplementation(() => {
      throw new Error('boom')
    })
    const { res, json } = await call('POST', '/api/auth/users', {
      auth: TOKEN_AUTH,
      body: { username: 'alice', password: GOOD_PW },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid password' })
    expect(dbModule.createDashboardUser).not.toHaveBeenCalled()
  })

  it('returns the policy message when a PasswordPolicyError is raised on the password handler', async () => {
    vi.mocked(passwordHashModule.assertPasswordPolicy).mockImplementation(() => {
      throw new passwordHashModule.PasswordPolicyError('Password must be at least 10 characters')
    })
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 7,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res, json } = await call('POST', '/api/auth/password', {
      auth: TOKEN_AUTH,
      body: { username: 'alice', new_password: 'short' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Password must be at least 10 characters' })
    expect(dbModule.updateDashboardUserPassword).not.toHaveBeenCalled()
  })
})

// ============================================================================
// /api/auth/users  (allowlist)
// ============================================================================

describe('GET /api/auth/users', () => {
  it('returns 403 for a credential kind not in the allowlist (device)', async () => {
    const { res, json } = await call('GET', '/api/auth/users', { auth: DEVICE_AUTH })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for a federation kind', async () => {
    const { res, json } = await call('GET', '/api/auth/users', { auth: FEDERATION_AUTH })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for an undefined principal', async () => {
    const { res, json } = await call('GET', '/api/auth/users')
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns the user list for a token principal (no password_hash leakage)', async () => {
    vi.mocked(dbModule.listDashboardUsers).mockReturnValue([
      { id: 1, username: 'alice', created_at: 1, updated_at: 1, disabled: 0 },
    ])
    const { res, json } = await call('GET', '/api/auth/users', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ users: [{ id: 1, username: 'alice', created_at: 1, updated_at: 1, disabled: 0 }] })
  })

  it('returns the user list for a session principal', async () => {
    vi.mocked(dbModule.listDashboardUsers).mockReturnValue([])
    const { res, json } = await call('GET', '/api/auth/users', { auth: SESSION_AUTH('alice') })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ users: [] })
  })
})

// ============================================================================
// /api/auth/users  (POST -- create)
// ============================================================================

describe('POST /api/auth/users', () => {
  it('returns 403 for a credential kind not in the allowlist', async () => {
    const { res, json } = await call('POST', '/api/auth/users', {
      auth: DEVICE_AUTH,
      body: { username: 'mallory', password: GOOD_PW },
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for an undefined principal', async () => {
    const { res, json } = await call('POST', '/api/auth/users', {
      body: { username: 'mallory', password: GOOD_PW },
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 400 on a malformed body', async () => {
    const { res, json } = await call('POST', '/api/auth/users', { auth: TOKEN_AUTH, rawBody: 'not-json' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 400 on an invalid username (whitespace / bad chars)', async () => {
    const { res, json } = await call('POST', '/api/auth/users', {
      auth: TOKEN_AUTH,
      body: { username: 'has space', password: GOOD_PW },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid username (1-64 chars: letters, digits, . _ -)' })
  })

  it('returns 400 on an empty username (after trim)', async () => {
    const { res } = await call('POST', '/api/auth/users', {
      auth: TOKEN_AUTH,
      body: { username: '   ', password: GOOD_PW },
    })
    expect(res.statusCode).toBe(400)
  })

  it('returns 409 when the username is already taken', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 1,
      username: 'alice',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res, json } = await call('POST', '/api/auth/users', {
      auth: TOKEN_AUTH,
      body: { username: 'alice', password: GOOD_PW },
    })
    expect(res.statusCode).toBe(409)
    expect(json()).toEqual({ error: 'User already exists' })
    expect(dbModule.createDashboardUser).not.toHaveBeenCalled()
  })

  it('returns 400 on a password policy violation (PasswordPolicyError message wins)', async () => {
    vi.mocked(passwordHashModule.assertPasswordPolicy).mockImplementation(() => {
      throw new passwordHashModule.PasswordPolicyError('Password must be at least 10 characters')
    })
    const { res, json } = await call('POST', '/api/auth/users', {
      auth: TOKEN_AUTH,
      body: { username: 'bob', password: 'short' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Password must be at least 10 characters' })
    expect(dbModule.createDashboardUser).not.toHaveBeenCalled()
  })

  it('creates a user and returns 201 with id+username on the happy path', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    vi.mocked(dbModule.createDashboardUser).mockReturnValue({
      id: 99,
      username: 'bob',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res, json } = await call('POST', '/api/auth/users', {
      auth: TOKEN_AUTH,
      body: { username: 'bob', password: GOOD_PW },
    })
    expect(res.statusCode).toBe(201)
    expect(json()).toEqual({ ok: true, user: { id: 99, username: 'bob' } })
    expect(dbModule.createDashboardUser).toHaveBeenCalledWith('bob', expect.any(String))
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith({ username: 'bob' }, 'dashboard user created')
  })
})

// ============================================================================
// /api/auth/users/<username>  (DELETE)
// ============================================================================

describe('DELETE /api/auth/users/<username>', () => {
  it('returns 403 for a credential kind not in the allowlist', async () => {
    const { res, json } = await call('DELETE', '/api/auth/users/alice', { auth: DEVICE_AUTH })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for an undefined principal', async () => {
    const { res, json } = await call('DELETE', '/api/auth/users/alice')
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 404 when the user is not in the DB', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue(undefined)
    const { res, json } = await call('DELETE', '/api/auth/users/ghost', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'User not found' })
    expect(dbModule.deleteDashboardUser).not.toHaveBeenCalled()
  })

  it('URL-decodes the username path segment and deletes the user + revokes sessions', async () => {
    vi.mocked(dbModule.getDashboardUser).mockReturnValue({
      id: 42,
      username: 'has%20name',
      password_hash: 'h',
      disabled: 0,
      created_at: 0,
  updated_at: 0,
})
    const { res, json } = await call('DELETE', '/api/auth/users/has%20name', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(dbModule.getDashboardUser).toHaveBeenCalledWith('has name')
    expect(dbModule.deleteDashboardUser).toHaveBeenCalledWith('has name')
    expect(sessionsModule.revokeAllForUser).toHaveBeenCalledWith(42)
  })
})

// ============================================================================
// /api/auth/device-keys  (GET)
// ============================================================================

describe('GET /api/auth/device-keys', () => {
  it('returns 403 for a credential kind not in the allowlist (device)', async () => {
    const { res, json } = await call('GET', '/api/auth/device-keys', { auth: DEVICE_AUTH })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for an undefined principal', async () => {
    const { res, json } = await call('GET', '/api/auth/device-keys')
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns the key list for a token principal', async () => {
    vi.mocked(authDeviceKeysModule.listDeviceKeys).mockReturnValue([
      { id: 1, name: 'phone', createdAt: 1, lastUsedAt: null, expiresAt: null, installId: null },
    ])
    const { res, json } = await call('GET', '/api/auth/device-keys', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      keys: [{ id: 1, name: 'phone', createdAt: 1, lastUsedAt: null, expiresAt: null, installId: null }],
    })
  })
})

// ============================================================================
// /api/auth/device-keys  (POST -- mint)
// ============================================================================

describe('POST /api/auth/device-keys', () => {
  it('returns 403 for a credential kind not in the allowlist', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: DEVICE_AUTH,
      body: { name: 'phone' },
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for an undefined principal', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', { body: { name: 'phone' } })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 400 on malformed JSON', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      rawBody: '{nope',
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('returns 400 on an invalid device name (forbidden chars)', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: 'bad/name' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid device name (1-64 chars: letters, digits, space, . _ -)' })
    expect(authDeviceKeysModule.createDeviceKey).not.toHaveBeenCalled()
  })

  it('returns 400 on an empty device name (after trim)', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: '   ' },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid device name/)
  })

  it('returns 400 when expires_in_days is NaN', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: 'phone', expires_in_days: 'not-a-number' },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid expires_in_days/)
  })

  it('returns 400 when expires_in_days is <= 0', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: 'phone', expires_in_days: -5 },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid expires_in_days/)
  })

  it('returns 400 when expires_in_days exceeds the max', async () => {
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: 'phone', expires_in_days: 100000 },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid expires_in_days/)
  })

  it('skips expires_in_days when null (opt-in default)', async () => {
    vi.mocked(authDeviceKeysModule.createDeviceKey).mockReturnValue({
      id: 1,
      name: 'phone',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      installId: null,
      key: 'mvdk_abc',
    })
    await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: 'phone', expires_in_days: null },
    })
    expect(authDeviceKeysModule.createDeviceKey).toHaveBeenCalledWith('phone', { expiresInDays: undefined })
  })

  it('skips expires_in_days when zero (opt-in default)', async () => {
    vi.mocked(authDeviceKeysModule.createDeviceKey).mockReturnValue({
      id: 1,
      name: 'phone',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      installId: null,
      key: 'mvdk_abc',
    })
    await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: 'phone', expires_in_days: 0 },
    })
    expect(authDeviceKeysModule.createDeviceKey).toHaveBeenCalledWith('phone', { expiresInDays: undefined })
  })

  it('mints a key with the chosen expires_in_days and returns 201 with the raw credential', async () => {
    vi.mocked(authDeviceKeysModule.createDeviceKey).mockReturnValue({
      id: 11,
      name: 'phone',
      createdAt: 1700000000,
      lastUsedAt: null,
      expiresAt: 1700000000 + 30 * 86400,
      installId: null,
      key: 'mvdk_abcdef1234567890',
    })
    const { res, json } = await call('POST', '/api/auth/device-keys', {
      auth: TOKEN_AUTH,
      body: { name: 'phone', expires_in_days: 30 },
    })
    expect(authDeviceKeysModule.createDeviceKey).toHaveBeenCalledWith('phone', { expiresInDays: 30 })
    expect(res.statusCode).toBe(201)
    expect(json()).toMatchObject({
      ok: true,
      id: 11,
      name: 'phone',
      key: 'mvdk_abcdef1234567890',
      created_at: 1700000000,
    })
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { id: 11, name: 'phone', expiresAt: 1700000000 + 30 * 86400 },
      'device key minted',
    )
  })
})

// ============================================================================
// /api/auth/device-keys/<id>  (DELETE)
// ============================================================================

describe('DELETE /api/auth/device-keys/<id>', () => {
  it('returns 403 for a credential kind not in the allowlist', async () => {
    const { res, json } = await call('DELETE', '/api/auth/device-keys/1', { auth: DEVICE_AUTH })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 403 for an undefined principal', async () => {
    const { res, json } = await call('DELETE', '/api/auth/device-keys/1')
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Forbidden for this credential type' })
  })

  it('returns 404 when the key is not found', async () => {
    vi.mocked(authDeviceKeysModule.getDeviceKey).mockReturnValue(null)
    vi.mocked(authDeviceKeysModule.revokeDeviceKey).mockReturnValue(false)
    const { res, json } = await call('DELETE', '/api/auth/device-keys/42', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Device key not found' })
  })

  it('revokes a non-bridge key (no installId) and does NOT touch bridge SSH', async () => {
    vi.mocked(authDeviceKeysModule.getDeviceKey).mockReturnValue({
      id: 5,
      name: 'laptop',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      installId: null,
    })
    vi.mocked(authDeviceKeysModule.revokeDeviceKey).mockReturnValue(true)
    vi.mocked(bridgeEnrollModule.removeBridgeSshAccess).mockResolvedValue(true)
    const { res, json } = await call('DELETE', '/api/auth/device-keys/5', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(bridgeEnrollModule.removeBridgeSshAccess).not.toHaveBeenCalled()
    expect(dbModule.logConfigChange).not.toHaveBeenCalled()
  })

  it('revokes a bridge-paired key and removes the SSH side; audits success', async () => {
    vi.mocked(authDeviceKeysModule.getDeviceKey).mockReturnValue({
      id: 7,
      name: 'bridge-device',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      installId: 'marveen-remote:abc-uuid',
    })
    vi.mocked(authDeviceKeysModule.revokeDeviceKey).mockReturnValue(true)
    vi.mocked(bridgeEnrollModule.removeBridgeSshAccess).mockResolvedValue(true)
    const { res, json } = await call('DELETE', '/api/auth/device-keys/7', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, ssh_removed: true })
    expect(bridgeEnrollModule.removeBridgeSshAccess).toHaveBeenCalledWith('marveen-remote:abc-uuid')
    expect(dbModule.logConfigChange).toHaveBeenCalledWith(
      'security.bridge_revoke',
      null,
      expect.stringContaining('bridge-device'),
      'token',
    )
  })

  it('records the SSH failure (reported, not rolled back) when removeBridgeSshAccess throws', async () => {
    vi.mocked(authDeviceKeysModule.getDeviceKey).mockReturnValue({
      id: 8,
      name: 'bridge-device',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      installId: 'marveen-remote:def-uuid',
    })
    vi.mocked(authDeviceKeysModule.revokeDeviceKey).mockReturnValue(true)
    vi.mocked(bridgeEnrollModule.removeBridgeSshAccess).mockRejectedValue(new Error('ssh boom'))
    const { res, json } = await call('DELETE', '/api/auth/device-keys/8', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, ssh_removed: false })
    expect(vi.mocked(logger.error)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), id: 8, installId: 'marveen-remote:def-uuid' }),
      'device key revoked but authorized_keys removal failed',
    )
    expect(dbModule.logConfigChange).toHaveBeenCalledWith(
      'security.bridge_revoke',
      null,
      expect.stringContaining('ssh_removed=false'),
      'token',
    )
  })

  it('records ssh_removed=false when removeBridgeSshAccess returns false', async () => {
    vi.mocked(authDeviceKeysModule.getDeviceKey).mockReturnValue({
      id: 9,
      name: 'bridge-device',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      installId: 'marveen-remote:ghi-uuid',
    })
    vi.mocked(authDeviceKeysModule.revokeDeviceKey).mockReturnValue(true)
    vi.mocked(bridgeEnrollModule.removeBridgeSshAccess).mockResolvedValue(false)
    const { res, json } = await call('DELETE', '/api/auth/device-keys/9', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, ssh_removed: false })
  })

  it('appends sshdir_override=1 to the audit note when MARVEEN_SSH_DIR is set', async () => {
    vi.mocked(authDeviceKeysModule.getDeviceKey).mockReturnValue({
      id: 10,
      name: 'bridge-device',
      createdAt: 1,
      lastUsedAt: null,
      expiresAt: null,
      installId: 'marveen-remote:override-uuid',
    })
    vi.mocked(authDeviceKeysModule.revokeDeviceKey).mockReturnValue(true)
    vi.mocked(bridgeEnrollModule.removeBridgeSshAccess).mockResolvedValue(true)
    vi.mocked(bridgeEnrollModule.sshDirOverride).mockReturnValue('/tmp/sshdir-override')
    const { res } = await call('DELETE', '/api/auth/device-keys/10', { auth: TOKEN_AUTH })
    expect(res.statusCode).toBe(200)
    expect(dbModule.logConfigChange).toHaveBeenCalledWith(
      'security.bridge_revoke',
      null,
      expect.stringContaining('sshdir_override=1'),
      'token',
    )
  })
})

// ============================================================================
// Fall-through (tryHandleAuth returns false)
// ============================================================================

describe('unhandled paths', () => {
  it('returns false for an unrelated route', async () => {
    const { handled, res } = await call('GET', '/api/agents/foo')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for a wrong-method attempt on a known auth path', async () => {
    const { handled } = await call('PATCH', '/api/auth/status')
    expect(handled).toBe(false)
  })
})

// ============================================================================
// Sanity: SESSION_COOKIE_NAME + parseCookies come from auth-gate, not literals
// ============================================================================

describe('cookie wiring', () => {
  it('uses SESSION_COOKIE_NAME from auth-gate (matches the cookie set by the gate)', () => {
    expect(authGateModule.SESSION_COOKIE_NAME).toBe('mv_session')
  })
})

// ============================================================================
// Module imports for mocked collaborators we reach into
// ============================================================================

import * as authDeviceKeysModule from '../web/auth-device-keys.js'
import * as bridgeEnrollModule from '../web/bridge-enroll.js'

// Bridge enroll is also mocked via vi.mock factory below so the subject under
// test can import the real module shape (removeBridgeSshAccess,
// sshDirOverride) without dragging in remote-enroll-core / fs.
vi.mock('../web/bridge-enroll.js', () => ({
  removeBridgeSshAccess: vi.fn(async () => true),
  sshDirOverride: vi.fn(() => null),
  RemoteEnrollError: class RemoteEnrollError extends Error {},
  bridgeEnroll: vi.fn(),
  defaultBridgeEnrollDeps: vi.fn(),
  isTailnetIPv4: vi.fn(() => false),
  selectEnrollHost: vi.fn(() => null),
}))
