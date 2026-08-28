// 100% coverage suite for src/web/routes/security.ts (AUTHPLAN1 #2 -- bridge
// enroll HTTP handler).
//
// tryHandleSecurity is a thin HTTP wrapper around bridgeEnroll: it owns the
// path/method filter, the credential-kind allowlist, body parsing, the input
// validation ladder (key_line -> name -> ssh_port), the audit row and the
// operator notification. The route delegates everything else to
// bridgeEnroll. The suite is therefore an orchestration test: we mock the
// heavy deps (so bridgeEnroll and its side-effects never touch the real
// filesystem/network) and inject the bridgeEnroll outcome deterministically
// to drive each branch.

import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

// --- mocks (must be hoisted before the imports that resolve them) ---

// The bridge enroll call inside the route has no deps injection point --
// bridgeEnroll is called with NO second arg, so its default dependencies
// (child_process execFile for ssh-keyscan, real ~/.ssh on the test host) would
// fire unless we either (a) intercept the heavy deps transitively, or
// (b) replace bridgeEnroll with a vi.fn. (b) is the only path that gives
// deterministic success/RemoteEnrollError/non-RemoteEnrollError control and
// keeps the test host's homedir / ssh-keyscan out of the loop. The OTHER
// mocks below mirror the same intent for the modules bridgeEnroll itself
// would normally pull in -- they let vi.mock resolve the import graph
// cleanly without dragging the real modules along.
const mocks = vi.hoisted(() => {
  class MockRemoteEnrollError extends Error {
    constructor(message: string) {
      super(message)
      this.name = 'RemoteEnrollError'
    }
  }
  return {
    bridgeEnroll: vi.fn(),
    sshDirOverride: vi.fn(() => null as string | null),
    remoteEnrollError: MockRemoteEnrollError,
    logConfigChange: vi.fn(),
    notifySecurityEvent: vi.fn(async () => {}),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),
    getDb: vi.fn(() => ({
      prepare: vi.fn(() => ({
        run: vi.fn(),
        get: vi.fn(),
        all: vi.fn(() => []),
      })),
    })),
  }
})

vi.mock('../web/bridge-enroll.js', () => ({
  bridgeEnroll: mocks.bridgeEnroll,
  sshDirOverride: mocks.sshDirOverride,
  RemoteEnrollError: mocks.remoteEnrollError,
}))

vi.mock('../db.js', () => ({
  logConfigChange: mocks.logConfigChange,
  getDb: mocks.getDb,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
  },
}))

vi.mock('../notify.js', () => ({
  notifySecurityEvent: mocks.notifySecurityEvent,
  notifyChannel: vi.fn(),
  notifyTelegram: vi.fn(),
}))

vi.mock('../config.js', () => ({
  WEB_PORT: 3420,
  PROJECT_ROOT: '/tmp/marveen-test-config-root',
  STORE_DIR: '/tmp/marveen-test-config-root/store',
  DB_FILENAME: 'claudeclaw.db',
  PID_FILENAME: 'claudeclaw.pid',
  ALLOWED_CHAT_ID: undefined,
  OLLAMA_URL: 'http://localhost:11434',
  APP_TZ: 'UTC',
  SCHEDULER_TZ_CONFIGURED: undefined,
  CHANNEL_PROVIDER: 'telegram',
  CHANNEL_TOKEN: '',
  CHANNEL_CHAT_ID: '',
  DISTRIBUTION_DEFAULT_AGENT_MODEL: 'haiku',
}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))
vi.mock('../web/dashboard-auth.js', () => ({}))

vi.mock('node:fs', async () => {
  // Keep the real exports available so any unrelated consumer of node:fs in
  // the import graph (none expected here) does not crash; we do not need to
  // touch any specific function.
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual }
})

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: vi.fn(() => '/tmp/marveen-test-home'),
    hostname: vi.fn(() => 'marveen-test-host'),
    userInfo: vi.fn(() => ({ username: 'tester' })),
    networkInterfaces: vi.fn(() => ({})),
  }
})

// --- imports (resolved AFTER the mocks above) ---

import { tryHandleSecurity } from '../web/routes/security.js'
import { RemoteEnrollError } from '../web/bridge-enroll.js'
import { logger } from '../logger.js'
import { mkTempDir } from './setup/temp-sandbox.js'
import type { RouteContext } from '../web/routes/types.js'

// --- helpers ---

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

function mkReq(opts: { body?: unknown; raw?: string }): http.IncomingMessage {
  let payload: Buffer[]
  if (opts.raw !== undefined) {
    payload = [Buffer.from(opts.raw)]
  } else if (opts.body !== undefined) {
    payload = [Buffer.from(JSON.stringify(opts.body))]
  } else {
    payload = []
  }
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {}
  return r as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  opts: {
    body?: unknown
    raw?: string
    auth?: RouteContext['auth']
  } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const req = mkReq({ body: opts.body, raw: opts.raw })
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
  const handled = await tryHandleSecurity(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

const TOKEN_AUTH: RouteContext['auth'] = { kind: 'token' }
const SESSION_AUTH: RouteContext['auth'] = { kind: 'session', user: 'alice' }

// --- a real-shaped ed25519 key line so body validation passes ---
const KEY_LINE = `ssh-ed25519 ${Buffer.concat([
  Buffer.from([0, 0, 0, 11]), Buffer.from('ssh-ed25519', 'utf8'),
  Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 7),
]).toString('base64')} marveen-remote:11111111-2222-4333-8444-555555555555`

function successOutcome(overrides: Record<string, unknown> = {}) {
  return {
    bundle: 'enc-bundle',
    action: 'added' as const,
    deviceKeyId: 42,
    replacedDeviceKey: false,
    installId: '11111111-2222-4333-8444-555555555555',
    host: '100.115.9.11',
    hostKeySource: 'ssh-keyscan',
    warnings: ['warning-x'],
    ...overrides,
  }
}

// --- lifecycle ---

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

beforeEach(() => {
  mocks.bridgeEnroll.mockReset()
  mocks.sshDirOverride.mockReset().mockReturnValue(null)
  mocks.logConfigChange.mockReset()
  mocks.notifySecurityEvent.mockReset().mockResolvedValue(undefined)
  // Reset the db mock so previous tests do not leak state into the next call.
  mocks.getDb.mockReturnValue({
    prepare: vi.fn(() => ({
      run: vi.fn(),
      get: vi.fn(),
      all: vi.fn(() => []),
    })),
  })
  // Reset logger mocks too (clearAllMocks only resets .mock.calls, not impls).
  mocks.loggerInfo.mockReset()
  mocks.loggerWarn.mockReset()
  mocks.loggerError.mockReset()
  mocks.loggerDebug.mockReset()
  delete process.env.MARVEEN_SSH_DIR
})

// The route reads MARVEEN_SSH_DIR via sshDirOverride (the seam) and only
// forwards the override presence to the audit row -- it does NOT resolve
// any ssh dir itself, but a leftover test seam in the process env from a
// prior suite would surface here as a stray audit suffix.
afterEach(() => {
  delete process.env.MARVEEN_SSH_DIR
})

// Suppress unused-helper warnings on tooling that doesn't see the import.
// (mkTempDir is the sandbox seam for HOME-anchored tests; the route itself
// never touches ~/.ssh, but the seam stays referenced so a future test can
// drop in without re-importing the helper.)
void mkTempDir

// --- path / method filter ---

describe('tryHandleSecurity -- dispatcher surface', () => {
  it('returns false for an unrelated path (not the bridge-enroll endpoint)', async () => {
    const { handled } = await call('POST', '/api/security/other', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'x' },
    })
    expect(handled).toBe(false)
  })

  it('returns false for GET on the bridge-enroll endpoint (POST-only)', async () => {
    const { handled } = await call('GET', '/api/security/bridge-enroll', { auth: TOKEN_AUTH })
    expect(handled).toBe(false)
  })

  it('returns false for DELETE on the bridge-enroll endpoint (POST-only)', async () => {
    const { handled } = await call('DELETE', '/api/security/bridge-enroll', { auth: TOKEN_AUTH })
    expect(handled).toBe(false)
  })

  it('returns false for PUT on the bridge-enroll endpoint (POST-only)', async () => {
    const { handled } = await call('PUT', '/api/security/bridge-enroll', { auth: TOKEN_AUTH })
    expect(handled).toBe(false)
  })
})

// --- credential-kind allowlist ---

describe('tryHandleSecurity -- credential-kind allowlist', () => {
  // The endpoint GRANTS access (SSH tunnel + fresh device key), so the
  // allowlist MUST default-deny every kind except 'token' and 'session'.
  // 'device' is the dangerous one: a device key that could mint further
  // keys would turn one leaked device into unlimited Bridges.
  const denied: Array<{ name: string; auth: RouteContext['auth'] }> = [
    { name: 'device kind', auth: { kind: 'device', device: 'evil' } },
    { name: 'federation kind', auth: { kind: 'federation', peer: 'p' } },
    { name: 'missing principal (undefined)', auth: undefined },
  ]

  for (const { name, auth } of denied) {
    it(`returns 403 Forbidden for ${name}`, async () => {
      const { res, json } = await call('POST', '/api/security/bridge-enroll', {
        auth,
        body: { key_line: KEY_LINE, name: 'whatever' },
      })
      expect(res.statusCode).toBe(403)
      expect(json()).toEqual({ error: 'Forbidden for this credential type' })
      // No side effects: bridgeEnroll must never have been called.
      expect(mocks.bridgeEnroll).not.toHaveBeenCalled()
      expect(mocks.logConfigChange).not.toHaveBeenCalled()
      expect(mocks.notifySecurityEvent).not.toHaveBeenCalled()
    })
  }

  it('admits a session principal to the allowlist (mirrors the token path)', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: SESSION_AUTH,
      body: { key_line: KEY_LINE, name: 'laptop' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledOnce()
  })

  it('admits a token principal to the allowlist', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'laptop' },
    })
    expect(res.statusCode).toBe(201)
  })
})

// --- body parsing ---

describe('tryHandleSecurity -- JSON body parsing', () => {
  it('400s on a syntactically broken JSON body (raw garbage)', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      raw: '{not json',
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
    expect(mocks.bridgeEnroll).not.toHaveBeenCalled()
  })

  it('400s on a JSON string body (parsed but not an object -> coerced to {})', async () => {
    // A JSON body that parses to a string falls through to `body = {}`, so the
    // very next guard (key_line required) is what surfaces the error -- the
    // route treats any non-object payload as "missing fields".
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      raw: '"just a string"',
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/key_line is required/)
  })

  it('400s when the body is JSON null (typeof null is object, but null is falsy)', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      raw: 'null',
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/key_line is required/)
  })

  it('treats an empty body as {} and 400s on the missing-key_line guard', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: {},
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/key_line is required/)
  })

  it('treats a whitespace-only body as {} and 400s on the missing-key_line guard', async () => {
    // readBody().toString().trim() strips to ''; the truthy guard `raw ?` short-
    // circuits to {} without ever touching JSON.parse. The next validation
    // (missing key_line) is what surfaces the error.
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      raw: '   \n  ',
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/key_line is required/)
    expect(mocks.bridgeEnroll).not.toHaveBeenCalled()
  })

  it('treats a no-payload request as {} and 400s on the missing-key_line guard', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/key_line is required/)
  })

  it('coerces a numeric key_line to "" via str() and trips the missing-key_line guard', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: 12345, name: 'ok' },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/key_line is required/)
  })
})

// --- key_line / name validation ---

describe('tryHandleSecurity -- key_line + name validation', () => {
  it('400s on an empty key_line (after trim) with the explicit Bridge hint', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: '   ', name: 'phone' },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/key_line is required/)
    expect(json().error).toContain('marveen-remote')
  })

  it('400s on an empty name', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: '' },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid device name/)
  })

  it('400s on a name that contains characters outside the allowed set', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'bad/name?with#chars' },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid device name/)
  })

  it('400s on a name longer than 64 characters', async () => {
    const longName = 'a'.repeat(65)
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: longName },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid device name/)
  })

  it('accepts unicode letters and digits in the name (NAME_RE is /u)', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'Árvíztűrő 123' },
    })
    expect(res.statusCode).toBe(201)
  })

  it('coerces a non-string name to "" via str() and trips the name guard', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 42 },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid device name/)
  })

  it('trims surrounding whitespace from key_line + name before validation', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: `  ${KEY_LINE}  `, name: '  trimmed-name  ' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(
      expect.objectContaining({ keyLine: KEY_LINE, name: 'trimmed-name' }),
    )
  })
})

// --- ssh_port validation ---

describe('tryHandleSecurity -- ssh_port validation', () => {
  it('400s when ssh_port is a non-numeric string', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: 'abc' },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid ssh_port/)
  })

  it('400s when ssh_port is below 1 (numeric 0)', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: 0 },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid ssh_port/)
  })

  it('400s when ssh_port is a negative number', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: -1 },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid ssh_port/)
  })

  it('400s when ssh_port is a fractional number (not an integer)', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: 22.5 },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid ssh_port/)
  })

  it('400s when ssh_port is above 65535', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: 65536 },
    })
    expect(res.statusCode).toBe(400)
    expect(json().error).toMatch(/Invalid ssh_port/)
  })

  it('accepts the boundary value 1', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: 1 },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ sshPort: 1 }))
  })

  it('accepts the boundary value 65535', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: 65535 },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ sshPort: 65535 }))
  })

  it('skips ssh_port validation when ssh_port is undefined (omitted)', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ sshPort: undefined }))
  })

  it('skips ssh_port validation when ssh_port is null', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: null },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ sshPort: undefined }))
  })

  it('skips ssh_port validation when ssh_port is the empty string', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: '' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ sshPort: undefined }))
  })

  it('accepts a numeric string for ssh_port (parses to its integer value)', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', ssh_port: '2222' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ sshPort: 2222 }))
  })
})

// --- host field handling ---

describe('tryHandleSecurity -- host override', () => {
  it('passes an explicit host through to bridgeEnroll verbatim', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', host: 'my.tailnet.example' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(
      expect.objectContaining({ host: 'my.tailnet.example' }),
    )
  })

  it('treats an empty host string as undefined (no override)', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', host: '' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ host: undefined }))
  })

  it('treats a whitespace-only host as undefined (after trim)', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', host: '   ' },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ host: undefined }))
  })

  it('coerces a non-string host to undefined via str()', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'ok', host: 1234 },
    })
    expect(res.statusCode).toBe(201)
    expect(mocks.bridgeEnroll).toHaveBeenCalledWith(expect.objectContaining({ host: undefined }))
  })
})

// --- happy path ---

describe('tryHandleSecurity -- happy path (action=added)', () => {
  beforeEach(() => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome())
  })

  it('returns 201 with the full outcome projection', async () => {
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(res.statusCode).toBe(201)
    const body = json()
    expect(body).toEqual({
      ok: true,
      bundle: 'enc-bundle',
      action: 'added',
      device_key_id: 42,
      replaced_device_key: false,
      install_id: '11111111-2222-4333-8444-555555555555',
      host: '100.115.9.11',
      host_key_source: 'ssh-keyscan',
      warnings: ['warning-x'],
    })
  })

  it('writes a config_change_log row keyed security.bridge_enroll with the device + install id', async () => {
    await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(mocks.logConfigChange).toHaveBeenCalledWith(
      'security.bridge_enroll',
      null,
      expect.stringMatching(/^phone \(11111111-2222-4333-8444-555555555555\) added$/),
      'token',
    )
  })

  it('emits a structured logger.info entry with name/installId/action/deviceKeyId', async () => {
    await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      {
        name: 'phone',
        installId: '11111111-2222-4333-8444-555555555555',
        action: 'added',
        deviceKeyId: 42,
      },
      'bridge device enrolled',
    )
  })

  it('fires notifySecurityEvent with the new-device wording when action=added', async () => {
    await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(mocks.notifySecurityEvent).toHaveBeenCalledWith(expect.stringContaining('phone'))
    expect(mocks.notifySecurityEvent.mock.calls[0]?.[0]).toContain('új eszköz')
    expect(mocks.notifySecurityEvent.mock.calls[0]?.[0]).toContain('Bridge-párosítás')
  })

  it('forwards the credential kind into the audit row verbatim (session)', async () => {
    await call('POST', '/api/security/bridge-enroll', {
      auth: SESSION_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(mocks.logConfigChange.mock.calls[0]?.[3]).toBe('session')
  })

  it('does NOT include the sshdir_override=1 marker when MARVEEN_SSH_DIR is unset', async () => {
    mocks.sshDirOverride.mockReturnValue(null)
    await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    const newValue = mocks.logConfigChange.mock.calls[0]?.[2] as string
    expect(newValue).not.toContain('sshdir_override=1')
  })

  it('includes the sshdir_override=1 marker in the audit row when MARVEEN_SSH_DIR is set', async () => {
    mocks.sshDirOverride.mockReturnValue('/tmp/some/ssh/dir')
    await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    const newValue = mocks.logConfigChange.mock.calls[0]?.[2] as string
    expect(newValue).toMatch(/sshdir_override=1$/)
  })

  it('treats notifySecurityEvent as fire-and-forget -- does not block on it', async () => {
    // notifySecurityEvent is `void`-prefixed in the route, so even a slow
    // (but resolved) promise must not delay the response status.
    mocks.notifySecurityEvent.mockImplementation(
      () => new Promise(() => { /* never resolves */ }),
    )
    const { res } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(res.statusCode).toBe(201)
  })
})

describe('tryHandleSecurity -- happy path (action=replaced)', () => {
  it('uses the re-pair wording in the security event when action=replaced', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome({
      action: 'replaced',
      replacedDeviceKey: true,
    }))
    await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(mocks.notifySecurityEvent.mock.calls[0]?.[0]).toContain('újrapárosítás')
  })

  it('mirrors replacedDeviceKey=true into the response payload', async () => {
    mocks.bridgeEnroll.mockResolvedValue(successOutcome({
      action: 'replaced',
      replacedDeviceKey: true,
    }))
    const { json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(json().replaced_device_key).toBe(true)
    expect(json().action).toBe('replaced')
  })
})

// --- error paths ---

describe('tryHandleSecurity -- error paths', () => {
  it('maps a RemoteEnrollError to 400 with the error message verbatim', async () => {
    mocks.bridgeEnroll.mockRejectedValue(new RemoteEnrollError('key blob is truncated'))
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'key blob is truncated' })
    // No audit / no notify on user-recoverable failure.
    expect(mocks.logConfigChange).not.toHaveBeenCalled()
    expect(mocks.notifySecurityEvent).not.toHaveBeenCalled()
  })

  it('returns 500 Enrollment failed for a non-RemoteEnrollError thrown by bridgeEnroll', async () => {
    mocks.bridgeEnroll.mockRejectedValue(new Error('disk exploded'))
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Enrollment failed' })
    // logger.error must record the original error object so the operator can
    // diagnose it from the trail; the message must NOT leak to the response.
    expect(mocks.loggerError).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'bridge enroll failed',
    )
    expect(json().error).not.toContain('disk exploded')
  })

  it('returns 500 when bridgeEnroll rejects with a non-Error value (string)', async () => {
    mocks.bridgeEnroll.mockRejectedValue('plain string failure')
    const { res, json } = await call('POST', '/api/security/bridge-enroll', {
      auth: TOKEN_AUTH,
      body: { key_line: KEY_LINE, name: 'phone' },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Enrollment failed' })
  })
})

// --- import sanity ---

describe('tryHandleSecurity -- export shape', () => {
  it('is exported as an async function returning a boolean', async () => {
    expect(typeof tryHandleSecurity).toBe('function')
    expect(tryHandleSecurity.constructor.name).toBe('AsyncFunction')
    // A non-matching path returns false (boolean).
    const { handled } = await call('GET', '/api/other', { auth: TOKEN_AUTH })
    expect(typeof handled).toBe('boolean')
    expect(handled).toBe(false)
  })
})

// Reference the logger import so an unused-symbol lint does not flag the
// otherwise-mocked dependency that the route reads through.
void logger
