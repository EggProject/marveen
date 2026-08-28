// 100% coverage suite for src/web/routes/settings.ts.
//
// The SUT is a single dispatcher (tryHandleSettings) that owns:
//   GET  /api/settings     -> filtered registry listing
//   POST /api/settings     -> validate -> setOverride -> logConfigChange
//
// All collaborators are mocked so the route never reaches the real store,
// DB, or HTTP helpers. The validation/registry mocks are vi.fn() so each
// test can shape the registry per-case -- in particular, the GET branch's
// secret-filter needs a registry that contains at least one secret entry
// (the production registry currently has zero, so the real module would
// never exercise the `def.secret` true branch).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Merged into the existing '../config.js' mock factory below.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})


// ---------------------------------------------------------------------------
// Hoisted harness -- every mock factory closes over this object so a test can
// re-shape a collaborator (e.g. flip a registry entry's `secret` flag)
// without re-importing the SUT.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
  const settingsRegistry: Array<Record<string, unknown>> = []
  return {
    // logger
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),

    // db
    logConfigChange: vi.fn(),

    // store-watcher
    setStoreWriteActor: vi.fn(),

    // settings-store
    getEffectiveSettingValue: vi.fn((key: string) => `effective(${key})`),
    setOverride: vi.fn((_key: string, _value: unknown) => ({ ok: true as const })),

    // config-registry -- the registry + the validator
    settingsRegistry,
    validateSettingValue: vi.fn((_def: unknown, value: unknown) => ({ ok: true as const, value })),

    // http-helpers side effects are observable through the mock res, not mocks.
  }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

vi.mock('../db.js', () => ({
  logConfigChange: H.logConfigChange,
}))

vi.mock('../config.js', () => ({ ...configSandbox }))

vi.mock('../store-watcher.js', () => ({
  setStoreWriteActor: H.setStoreWriteActor,
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: H.getEffectiveSettingValue,
  setOverride: H.setOverride,
}))

vi.mock('../config-registry.js', () => ({
  SETTINGS_REGISTRY: H.settingsRegistry,
  validateSettingValue: H.validateSettingValue,
}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// ---------------------------------------------------------------------------
// Imports -- resolved AFTER the mock factories above.
// ---------------------------------------------------------------------------

const { tryHandleSettings } = await import('../web/routes/settings.js')

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

function mkReq(opts: { body?: string; raw?: Buffer }): http.IncomingMessage {
  let payload: Buffer[]
  if (opts.raw !== undefined) {
    payload = [opts.raw]
  } else if (opts.body !== undefined) {
    payload = [Buffer.from(opts.body)]
  } else {
    payload = []
  }
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  opts: { body?: string; raw?: Buffer } = {},
): Promise<{
  res: MockRes
  handled: boolean
  json: () => Record<string, unknown>
}> {
  const req = mkReq({ body: opts.body, raw: opts.raw })
  const res = mkRes()
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    fedPeer: null,
  }
  const handled = await tryHandleSettings(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : {}) }
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  H.settingsRegistry.length = 0
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()
  H.logConfigChange.mockReset()
  H.setStoreWriteActor.mockReset()
  H.getEffectiveSettingValue.mockReset()
  H.getEffectiveSettingValue.mockImplementation((key: string) => `effective(${key})`)
  H.setOverride.mockReset()
  H.setOverride.mockImplementation(() => ({ ok: true as const }))
  H.validateSettingValue.mockReset()
  H.validateSettingValue.mockImplementation((_def: unknown, value: unknown) => ({
    ok: true as const,
    value,
  }))
})

afterEach(() => {
  H.settingsRegistry.length = 0
})

// Helper to seed the registry. Each entry carries the full shape the route
// passes through so a test can poke any individual field without re-listing.
function pushDef(overrides: Record<string, unknown>): void {
  H.settingsRegistry.push({
    key: 'SAMPLE_KEY',
    type: 'int',
    default: 0,
    description: 'desc',
    module: 'kanban',
    secret: false,
    requiresRestart: false,
    ...overrides,
  })
}

// ---------------------------------------------------------------------------
// Dispatcher surface
// ---------------------------------------------------------------------------

describe('tryHandleSettings -- dispatcher surface', () => {
  it('returns false for an unrelated path on GET', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for an unrelated path on POST', async () => {
    const { handled } = await call('POST', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false when the path matches but the method is neither GET nor POST', async () => {
    const { handled } = await call('PUT', '/api/settings')
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/settings
// ---------------------------------------------------------------------------

describe('GET /api/settings', () => {
  it('returns the registry filtered to non-secret entries, mapping every projected field', async () => {
    pushDef({
      key: 'PUB_INT',
      type: 'int',
      default: 7,
      description: 'public int',
      module: 'kanban',
      secret: false,
      requiresRestart: false,
      min: 0,
      max: 10,
    })
    pushDef({
      key: 'PUB_STR',
      type: 'string',
      default: 'hello',
      description: 'public string',
      module: 'general',
      secret: false,
      requiresRestart: true,
      valueSet: ['hello', 'world'],
    })
    pushDef({
      key: 'HIDDEN_TOKEN',
      type: 'string',
      default: '',
      description: 'hidden',
      module: 'vault',
      secret: true,
      requiresRestart: false,
    })

    const { res, json } = await call('GET', '/api/settings')

    expect(res.statusCode).toBe(200)
    const out = json() as { settings: Array<Record<string, unknown>> }
    // Secret entry is filtered out entirely (not just its value).
    expect(out.settings).toHaveLength(2)
    const keys = out.settings.map((s) => s.key).sort()
    expect(keys).toEqual(['PUB_INT', 'PUB_STR'])

    const intRow = out.settings.find((s) => s.key === 'PUB_INT') as Record<string, unknown>
    expect(intRow).toMatchObject({
      key: 'PUB_INT',
      type: 'int',
      value: 'effective(PUB_INT)',
      default: 7,
      description: 'public int',
      module: 'kanban',
      requiresRestart: false,
      min: 0,
      max: 10,
    })
    expect(intRow.valueSet).toBeUndefined()

    const strRow = out.settings.find((s) => s.key === 'PUB_STR') as Record<string, unknown>
    expect(strRow).toMatchObject({
      key: 'PUB_STR',
      type: 'string',
      value: 'effective(PUB_STR)',
      default: 'hello',
      description: 'public string',
      module: 'general',
      requiresRestart: true,
      valueSet: ['hello', 'world'],
    })
    expect(strRow.min).toBeUndefined()
    expect(strRow.max).toBeUndefined()
  })

  it('returns an empty settings list when the registry is empty', async () => {
    const { res, json } = await call('GET', '/api/settings')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ settings: [] })
  })

  it('returns only the secret-filtered shape -- when every entry is secret the response is empty', async () => {
    pushDef({
      key: 'SECRET_A',
      type: 'string',
      default: '',
      description: 'a',
      module: 'vault',
      secret: true,
      requiresRestart: false,
    })
    pushDef({
      key: 'SECRET_B',
      type: 'string',
      default: '',
      description: 'b',
      module: 'vault',
      secret: true,
      requiresRestart: true,
    })

    const { res, json } = await call('GET', '/api/settings')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ settings: [] })
  })

  it('propagates the effective value from the store for every non-secret entry', async () => {
    pushDef({ key: 'A', type: 'int', default: 1, description: 'a', module: 'm', secret: false, requiresRestart: false })
    pushDef({ key: 'B', type: 'string', default: '', description: 'b', module: 'm', secret: false, requiresRestart: false })
    H.getEffectiveSettingValue.mockImplementation((key: string) => (key === 'A' ? 42 : 'two'))

    const { json } = await call('GET', '/api/settings')
    const out = json() as { settings: Array<Record<string, unknown>> }
    expect(out.settings.find((s) => s.key === 'A')?.value).toBe(42)
    expect(out.settings.find((s) => s.key === 'B')?.value).toBe('two')
  })
})

// ---------------------------------------------------------------------------
// POST /api/settings
// ---------------------------------------------------------------------------

describe('POST /api/settings', () => {
  it('updates a known, non-secret setting and writes a change log row', async () => {
    pushDef({
      key: 'KANBAN_WIP_IN_PROGRESS',
      type: 'int',
      default: 0,
      description: 'wip',
      module: 'kanban',
      secret: false,
      requiresRestart: false,
      min: 0,
      max: 100,
    })
    H.getEffectiveSettingValue.mockReturnValue(0)
    H.validateSettingValue.mockReturnValue({ ok: true, value: 5 })
    H.setOverride.mockReturnValue({ ok: true })

    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: 'KANBAN_WIP_IN_PROGRESS', value: 5, actor: 'ops' }),
    })

    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      ok: true,
      key: 'KANBAN_WIP_IN_PROGRESS',
      value: 5,
      requiresRestart: false,
    })
    expect(H.setStoreWriteActor).toHaveBeenCalledWith('ops')
    expect(H.setOverride).toHaveBeenCalledWith('KANBAN_WIP_IN_PROGRESS', 5)
    expect(H.logConfigChange).toHaveBeenCalledWith('KANBAN_WIP_IN_PROGRESS', 0, 5, 'ops')
    expect(H.loggerInfo).toHaveBeenCalled()
  })

  it('defaults the actor to "dashboard" when missing or empty', async () => {
    pushDef({
      key: 'A',
      type: 'int',
      default: 0,
      description: '',
      module: 'm',
      secret: false,
      requiresRestart: false,
    })

    await call('POST', '/api/settings', { body: JSON.stringify({ key: 'A', value: 1 }) })
    expect(H.setStoreWriteActor).toHaveBeenLastCalledWith('dashboard')

    H.setStoreWriteActor.mockClear()
    await call('POST', '/api/settings', { body: JSON.stringify({ key: 'A', value: 1, actor: '' }) })
    expect(H.setStoreWriteActor).toHaveBeenLastCalledWith('dashboard')

    H.setStoreWriteActor.mockClear()
    await call('POST', '/api/settings', { body: JSON.stringify({ key: 'A', value: 1, actor: 42 }) })
    // non-string -> falls through to 'dashboard'
    expect(H.setStoreWriteActor).toHaveBeenLastCalledWith('dashboard')
  })

  it('returns 400 with "Missing or invalid key" when key is missing', async () => {
    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ value: 1 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Missing or invalid "key"' })
    expect(H.setOverride).not.toHaveBeenCalled()
    expect(H.logConfigChange).not.toHaveBeenCalled()
    expect(H.setStoreWriteActor).not.toHaveBeenCalled()
  })

  it('returns 400 when key is an empty string (falsy string)', async () => {
    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: '', value: 1 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Missing or invalid "key"' })
  })

  it('returns 400 when key is a non-string (number)', async () => {
    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: 42, value: 1 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Missing or invalid "key"' })
  })

  it('returns 400 when key is null', async () => {
    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: null, value: 1 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Missing or invalid "key"' })
  })

  it('returns 404 when the key is not in the registry', async () => {
    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: 'UNKNOWN_KEY', value: 1 }),
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Unknown setting key: UNKNOWN_KEY' })
    expect(H.validateSettingValue).not.toHaveBeenCalled()
    expect(H.setOverride).not.toHaveBeenCalled()
    expect(H.setStoreWriteActor).not.toHaveBeenCalled()
    expect(H.logConfigChange).not.toHaveBeenCalled()
  })

  it('returns 403 when the registry entry is marked secret (defensive branch)', async () => {
    pushDef({
      key: 'HIDDEN',
      type: 'string',
      default: '',
      description: '',
      module: 'vault',
      secret: true,
      requiresRestart: false,
    })
    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: 'HIDDEN', value: 'x' }),
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Secret settings cannot be changed via this endpoint' })
    expect(H.validateSettingValue).not.toHaveBeenCalled()
    expect(H.setOverride).not.toHaveBeenCalled()
    expect(H.setStoreWriteActor).not.toHaveBeenCalled()
    expect(H.logConfigChange).not.toHaveBeenCalled()
  })

  it('returns 400 with the validator error when validation fails', async () => {
    pushDef({
      key: 'A',
      type: 'int',
      default: 0,
      description: '',
      module: 'm',
      secret: false,
      requiresRestart: false,
    })
    H.validateSettingValue.mockReturnValue({ ok: false, error: 'bad value' })

    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: 'A', value: 99 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'bad value' })
    expect(H.setOverride).not.toHaveBeenCalled()
    expect(H.setStoreWriteActor).not.toHaveBeenCalled()
    expect(H.logConfigChange).not.toHaveBeenCalled()
  })

  it('returns 400 with the setOverride error when the override write fails (validation already passed)', async () => {
    pushDef({
      key: 'A',
      type: 'int',
      default: 0,
      description: '',
      module: 'm',
      secret: false,
      requiresRestart: false,
    })
    H.validateSettingValue.mockReturnValue({ ok: true, value: 9 })
    H.setOverride.mockReturnValue({ ok: false, error: 'disk full' })

    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: 'A', value: 9 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'disk full' })
    expect(H.setStoreWriteActor).toHaveBeenCalledWith('dashboard')
    // No change-log row is written when the write itself failed.
    expect(H.logConfigChange).not.toHaveBeenCalled()
    expect(H.loggerInfo).not.toHaveBeenCalled()
  })

  it('returns 500 with "Failed to update setting" when JSON.parse throws on the body', async () => {
    const { res, json } = await call('POST', '/api/settings', {
      body: '{ this is not valid json',
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to update setting' })
    expect(H.loggerError).toHaveBeenCalled()
    expect(H.setOverride).not.toHaveBeenCalled()
    expect(H.logConfigChange).not.toHaveBeenCalled()
    expect(H.setStoreWriteActor).not.toHaveBeenCalled()
  })

  it('returns 500 when readBody rejects (e.g. transport error) -- the catch swallows it', async () => {
    // Build a req whose 'error' event fires immediately so readBody rejects.
    const chunks: Buffer[] = []
    const r = Readable.from(chunks) as unknown as http.IncomingMessage & { emit: (e: string, p?: unknown) => void; headers: Record<string, unknown> }
    r.headers = {}
    // Trigger an error before 'end' -- the readBody promise rejects and the
    // catch block runs.
    setImmediate(() => r.emit('error', new Error('socket hangup')))

    const res = mkRes()
    const ctx: RouteContext = {
      req: r as unknown as http.IncomingMessage,
      res: res as unknown as http.ServerResponse,
      path: '/api/settings',
      method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/settings'),
      fedPeer: null,
    }
    const handled = await tryHandleSettings(ctx)
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(JSON.parse(res.body)).toEqual({ error: 'Failed to update setting' })
    expect(H.loggerError).toHaveBeenCalled()
    expect(H.setOverride).not.toHaveBeenCalled()
  })

  it('echoes requiresRestart=true from the registry on the success response', async () => {
    pushDef({
      key: 'RESTARTABLE',
      type: 'int',
      default: 0,
      description: '',
      module: 'core',
      secret: false,
      requiresRestart: true,
    })
    H.validateSettingValue.mockReturnValue({ ok: true, value: 1 })
    H.setOverride.mockReturnValue({ ok: true })
    H.getEffectiveSettingValue.mockReturnValue(0)

    const { res, json } = await call('POST', '/api/settings', {
      body: JSON.stringify({ key: 'RESTARTABLE', value: 1 }),
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      ok: true,
      key: 'RESTARTABLE',
      value: 1,
      requiresRestart: true,
    })
    expect(H.logConfigChange).toHaveBeenCalledWith('RESTARTABLE', 0, 1, 'dashboard')
  })
})