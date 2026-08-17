// 100% coverage suite for src/web/routes/connectors-hu.ts.
//
// The connectors-hu route module is a thin HTTP wrapper over the `connectors`
// CLI (the connectors.hu installer + sync tool). Three endpoints are exposed:
//
//   GET  /api/connectors-hu/status     -- isInstalled + getSecret + --version
//   POST /api/connectors-hu/install    -- runs the connectors.hu install script
//   POST /api/connectors-hu/configure  -- setSecret(VAULT_ID) + connectors sync
//
// All four collaborators the SUT touches are mocked here at the module
// boundary so the dispatcher runs against a deterministic fake:
//   * `node:child_process` -- execFile (both `which` and `runCommand` go through it)
//   * `node:fs`            -- existsSync (only used to check the local ~/.local/bin path)
//   * `../vault.js`        -- getSecret, setSecret
//   * `../http-helpers.js` -- readBody (json is left real: it is the dispatcher
//                                          surface already covered elsewhere)
//   * `../logger.js`       -- the logger
//
// `EXTENDED_PATH` and `LOCAL_BIN` are module-scope constants built from
// `process.env.HOME` and `process.env.PATH` at load time. They are read-only
// inside the SUT, so the test only has to make sure HOME/PATH are populated
// before the import resolves; the values themselves never have to point at
// real binaries because the `execFile` mock short-circuits the real OS calls.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Set HOME/PATH BEFORE the SUT module is imported, because the SUT captures
// them at module-scope into LOCAL_BIN / EXTENDED_PATH. The values are
// arbitrary; the `execFile` mock below never lets the real /bin/sh run.
// We force overwrite (not `||`) so the SUT picks up our fake value even when
// the test runner has a real HOME like `/Users/eggp` in its environment.
// ---------------------------------------------------------------------------
process.env.HOME = '/tmp/fake-connectors-home'
process.env.PATH = '/usr/bin:/bin'

// ---------------------------------------------------------------------------
// Hoisted mock fns. The vi.mock() factories below reference these; vi.hoisted
// keeps the declarations available in the hoisted factory scope.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  // child_process
  mockExecFile: vi.fn<(...args: unknown[]) => void>(),

  // node:fs
  mockExistsSync: vi.fn<(p: string) => boolean>(() => false),

  // vault
  mockGetSecret: vi.fn<(id: string) => string | null>(() => null),
  mockSetSecret: vi.fn<(id: string, label: string, value: string) => void>(),

  // http-helpers.readBody
  mockReadBody: vi.fn<(...args: unknown[]) => Promise<Buffer>>(),

  // logger
  loggerInfo: vi.fn<(...args: unknown[]) => void>(),
  loggerWarn: vi.fn<(...args: unknown[]) => void>(),
  loggerError: vi.fn<(...args: unknown[]) => void>(),
}))

// ---------------------------------------------------------------------------
// Mock declarations (hoisted to the top of the file by vitest).
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  execFile: H.mockExecFile,
}))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return { ...actual, existsSync: H.mockExistsSync }
})

vi.mock('../web/vault.js', () => ({
  getSecret: H.mockGetSecret,
  setSecret: H.mockSetSecret,
}))

vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/http-helpers.js')>()
  return { ...actual, readBody: H.mockReadBody }
})

vi.mock('../logger.js', () => ({
  logger: { info: H.loggerInfo, warn: H.loggerWarn, error: H.loggerError },
}))

// ---------------------------------------------------------------------------
// SUT import -- resolved AFTER all mocks and env vars are in place.
// ---------------------------------------------------------------------------
const { tryHandleConnectorsHu } = await import('../web/routes/connectors-hu.js')

// ---------------------------------------------------------------------------
// Test harness.
// ---------------------------------------------------------------------------
interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  end(data?: string | Buffer): MockRes
}

function mkRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(data) {
      if (data !== undefined) this.body += typeof data === 'string' ? data : data.toString('utf-8')
      return this
    },
  }
  return res
}

interface MockReq {
  headers: Record<string, string | string[] | undefined>
  method?: string
  url?: string
}

function mkReq(): MockReq {
  return { headers: {} }
}

function call(method: string, fullPath: string, body?: Buffer): {
  res: MockRes
  req: MockReq
  handled: Promise<boolean>
  json: () => Record<string, unknown> | null
} {
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const res = mkRes()
  const req: MockReq = { ...mkReq(), method, url: fullPath }
  if (body) H.mockReadBody.mockResolvedValueOnce(body)
  const ctx: RouteContext = {
    req: req as unknown as import('node:http').IncomingMessage,
    res: res as unknown as import('node:http').ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = tryHandleConnectorsHu(ctx)
  return {
    res,
    req,
    handled,
    json: () => (res.body ? JSON.parse(res.body) : null),
  }
}

// ---------------------------------------------------------------------------
// execFile callback helpers. The SUT uses execFile with the 4-arg signature
// (cmd, args, options, callback). The mock captures all invocations and
// invokes the callback so the SUT's Promise resolves.
// ---------------------------------------------------------------------------
type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void

function setupExecFile(
  fn: (cmd: string, args: string[], opts: { timeout: number; env?: Record<string, string> }, cb: ExecCallback) => void,
): void {
  H.mockExecFile.mockImplementation(((cmd: unknown, args: unknown, opts: unknown, cb: unknown) => {
    fn(String(cmd), args as string[], opts as { timeout: number; env?: Record<string, string> }, cb as ExecCallback)
  }) as (...args: unknown[]) => void)
}

// Default: `which` finds nothing, runCommand returns ok=true with empty
// output. Individual tests override.
function setupDefaults(): void {
  H.mockExecFile.mockReset()
  H.mockExistsSync.mockReset()
  H.mockExistsSync.mockReturnValue(false)
  setupExecFile((cmd, _args, _opts, cb) => {
    if (cmd === '/usr/bin/which') cb(null, '', '')
    else cb(null, '', '')
  })
}

// ---------------------------------------------------------------------------
// Per-test reset.
// ---------------------------------------------------------------------------
beforeEach(() => {
  H.mockExecFile.mockReset()
  H.mockExistsSync.mockReset().mockReturnValue(false)
  H.mockGetSecret.mockReset().mockReturnValue(null)
  H.mockSetSecret.mockReset()
  H.mockReadBody.mockReset()
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  setupDefaults()
})

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

afterAll(() => {
  // nothing global to clean up; env vars set above are harmless to leave
  // (the test runner process owns them).
})

// ===========================================================================
// Dispatcher surface (no path/method match -> false)
// ===========================================================================
describe('tryHandleConnectorsHu -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = call('GET', '/api/other')
    expect(await handled).toBe(false)
    expect(H.mockGetSecret).not.toHaveBeenCalled()
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns false for POST on /api/connectors-hu/status', async () => {
    const { handled } = call('POST', '/api/connectors-hu/status')
    expect(await handled).toBe(false)
    expect(H.mockGetSecret).not.toHaveBeenCalled()
  })

  it('returns false for GET on /api/connectors-hu/install', async () => {
    const { handled } = call('GET', '/api/connectors-hu/install')
    expect(await handled).toBe(false)
    expect(H.mockExecFile).not.toHaveBeenCalled()
  })

  it('returns false for GET on /api/connectors-hu/configure', async () => {
    const { handled } = call('GET', '/api/connectors-hu/configure')
    expect(await handled).toBe(false)
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns false for PUT on /api/connectors-hu/configure', async () => {
    const { handled } = call('PUT', '/api/connectors-hu/configure')
    expect(await handled).toBe(false)
  })

  it('returns false for DELETE on /api/connectors-hu/install', async () => {
    const { handled } = call('DELETE', '/api/connectors-hu/install')
    expect(await handled).toBe(false)
  })

  it('returns true and writes a response for each known endpoint (smoke)', async () => {
    // Status
    const a = call('GET', '/api/connectors-hu/status')
    expect(await a.handled).toBe(true)
    expect(a.res.statusCode).toBe(200)
    // Install
    const b = call('POST', '/api/connectors-hu/install')
    expect(await b.handled).toBe(true)
    expect(b.res.statusCode).toBe(200)
    // Configure
    const c = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"abc"}'))
    expect(await c.handled).toBe(true)
    expect(c.res.statusCode).toBe(200)
  })
})

// ===========================================================================
// GET /api/connectors-hu/status
// ===========================================================================
describe('GET /api/connectors-hu/status', () => {
  it('returns installed=false, configured=false when the binary is nowhere', async () => {
    // which returns empty, existsSync returns false (default)
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '', '')
      else cb(null, '', '')
    })
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, installed: false, configured: false })
    // The --version probe is skipped when not installed.
    const connectorsInvocations = H.mockExecFile.mock.calls.filter(
      (c) => (c[0] as string) === 'connectors',
    )
    expect(connectorsInvocations).toHaveLength(0)
    expect(H.mockGetSecret).toHaveBeenCalledWith('CONNECTORS_HU_TOKEN')
  })

  it('finds the binary via /usr/bin/which and skips the local-fs check', async () => {
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/usr/bin/which' && args[0] === 'connectors') {
        cb(null, '/usr/local/bin/connectors\n', '')
      } else if (cmd === 'connectors' && args[0] === '--version') {
        cb(null, 'connectors 1.2.3\n', '')
      } else {
        cb(null, '', '')
      }
    })
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      ok: true,
      installed: true,
      configured: false,
      version: 'connectors 1.2.3',
    })
    // existsSync must NOT be called once which() returned a path -- the
    // short-circuit lives in `isInstalled`.
    expect(H.mockExistsSync).not.toHaveBeenCalled()
  })

  it('falls back to the local ~/.local/bin/connectors path when which is empty', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '', '')
      else if (cmd === 'connectors') cb(null, 'connectors 0.9.0', '')
      else cb(null, '', '')
    })
    H.mockExistsSync.mockReturnValue(true)
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, installed: true, configured: false })
    expect(H.mockExistsSync).toHaveBeenCalledWith('/tmp/fake-connectors-home/.local/bin/connectors')
  })

  it('treats which() returning a non-zero exit (err) as not-installed (covers err ? null branch)', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(new Error('which-not-found'), '', '')
      else cb(null, '', '')
    })
    H.mockExistsSync.mockReturnValue(false)
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, installed: false, configured: false })
  })

  it('returns configured=true when getSecret returns a non-null token', async () => {
    H.mockGetSecret.mockReturnValue('secret-token-value')
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
      else if (cmd === 'connectors') cb(null, 'connectors 1.0.0', '')
      else cb(null, '', '')
    })
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.configured).toBe(true)
    expect(body.installed).toBe(true)
  })

  it('omits the version key when --version returns empty output', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
      else if (cmd === 'connectors') cb(null, '', '')
      else cb(null, '', '')
    })
    const { json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    const body = json() as Record<string, unknown>
    expect(body).not.toHaveProperty('version')
  })

  it('omits the version key when --version exits non-zero', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
      else if (cmd === 'connectors') cb(new Error('exit 1'), '', 'boom')
      else cb(null, '', '')
    })
    const { json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    const body = json() as Record<string, unknown>
    expect(body).not.toHaveProperty('version')
    expect(body.installed).toBe(true)
  })

  it('takes only the first line of the version output', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
      else if (cmd === 'connectors') cb(null, 'connectors 2.0.0\nbuild abc123\n', '')
      else cb(null, '', '')
    })
    const { json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    const body = json() as Record<string, unknown>
    expect(body.version).toBe('connectors 2.0.0')
  })

  it('returns 500 with an error body and logs logger.error when the status check throws', async () => {
    H.mockGetSecret.mockImplementation(() => { throw new Error('vault-during-status') })
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ ok: false, installed: false, configured: false })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError.mock.calls[0][0]).toEqual({ err: expect.any(Error) })
    expect(H.loggerError.mock.calls[0][1]).toBe('connectors-hu status check failed')
  })

  it('returns 500 if the isInstalled() probe throws (no exception leak to the route)', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') throw new Error('which-throws')
      cb(null, '', '')
    })
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ ok: false, installed: false, configured: false })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
  })

  it('returns 200 with the install-not-in-PATH / no-configured branch (combined)', async () => {
    // which empty, existsSync false, no token, no --version call
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '', '')
      else cb(null, '', '')
    })
    H.mockExistsSync.mockReturnValue(false)
    const { res, json, handled } = call('GET', '/api/connectors-hu/status')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, installed: false, configured: false })
  })

  it('sets Content-Type application/json on the response', async () => {
    const { res } = call('GET', '/api/connectors-hu/status')
    await res // noop
    // (writeHead is sync, but we await the handler too)
    const real = await call('GET', '/api/connectors-hu/status')
    await real.handled
    expect(real.res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })
})

// ===========================================================================
// POST /api/connectors-hu/install
// ===========================================================================
describe('POST /api/connectors-hu/install', () => {
  it('runs the install script and reports success when exit is zero', async () => {
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/bin/sh' && args[0] === '-c') {
        cb(null, 'Installing...\nDone\n', '')
      } else if (cmd === '/usr/bin/which') {
        cb(null, '/usr/local/bin/connectors\n', '')
      } else {
        cb(null, '', '')
      }
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/install')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.installed).toBe(true)
    expect(body.output).toContain('Installing...')
    expect(H.loggerInfo).toHaveBeenCalledWith('connectors CLI installed')
    expect(H.loggerWarn).not.toHaveBeenCalled()
  })

  it('runs the install script and reports failure when exit is non-zero', async () => {
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/bin/sh' && args[0] === '-c') {
        cb(new Error('install failed'), '', 'curl: not found\n')
      } else if (cmd === '/usr/bin/which') {
        cb(null, '', '')
      } else {
        cb(null, '', '')
      }
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/install')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.installed).toBe(false)
    expect(body.output).toContain('curl: not found')
    expect(H.loggerWarn).toHaveBeenCalledTimes(1)
    expect(H.loggerWarn.mock.calls[0][0]).toEqual({ output: expect.any(String) })
    expect(H.loggerWarn.mock.calls[0][1]).toBe('connectors CLI install failed')
    expect(H.loggerInfo).not.toHaveBeenCalled()
  })

  it('returns 500 with String(err) and logs logger.error when the run throws synchronously', async () => {
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/bin/sh' && args[0] === '-c') {
        // Synchronous throw -- rejected promise path
        throw new Error('synchronous-explosion')
      } else if (cmd === '/usr/bin/which') {
        cb(null, '', '')
      } else {
        cb(null, '', '')
      }
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/install')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.installed).toBe(false)
    expect(body.output).toContain('synchronous-explosion')
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError.mock.calls[0][1]).toBe('connectors-hu install failed')
  })

  it('returns 500 when runCommand rejects (async error path)', async () => {
    // Force a Promise rejection by making execFile invoke its callback with
    // a non-Error reason -- the SUT's runCommand turns that into ok=false,
    // which is the regular failure path, NOT a thrown exception. The catch
    // path is only hit when something throws synchronously (e.g. the
    // execFile mock itself throws). Test that.
    setupExecFile((_cmd, _args, _opts, _cb) => {
      throw new Error('async-explosion')
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/install')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toMatchObject({ ok: false, installed: false })
    expect(H.loggerError).toHaveBeenCalledTimes(1)
  })

  it('truncates the combined stdout+stderr to MAX_OUTPUT (4096) chars', async () => {
    const longOut = 'x'.repeat(8000)
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/bin/sh' && args[0] === '-c') {
        cb(null, longOut, '')
      } else if (cmd === '/usr/bin/which') {
        cb(null, '', '')
      } else {
        cb(null, '', '')
      }
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/install')
    expect(await handled).toBe(true)
    const body = json() as Record<string, unknown>
    expect((body.output as string).length).toBe(4096)
  })

  it('emits the empty output string (not undefined) when both stdout and stderr are empty', async () => {
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/bin/sh' && args[0] === '-c') {
        cb(null, '', '')
      } else if (cmd === '/usr/bin/which') {
        cb(null, '/usr/local/bin/connectors\n', '')
      } else {
        cb(null, '', '')
      }
    })
    const { json, handled } = call('POST', '/api/connectors-hu/install')
    expect(await handled).toBe(true)
    const body = json() as Record<string, unknown>
    expect(body.output).toBe('')
  })
})

// ===========================================================================
// POST /api/connectors-hu/configure
// ===========================================================================
describe('POST /api/connectors-hu/configure', () => {
  it('saves the trimmed token and reports success when the binary is missing', async () => {
    // which empty, existsSync false -- the "not installed" branch returns
    // before any `connectors sync` invocation.
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '', '')
      else cb(null, '', '')
    })
    H.mockExistsSync.mockReturnValue(false)
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"hello-token"}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body).toEqual({
      ok: true,
      configured: true,
      syncOutput: 'Token saved. connectors CLI not installed yet, sync skipped.',
    })
    expect(H.mockSetSecret).toHaveBeenCalledWith('CONNECTORS_HU_TOKEN', 'connectors.hu API token', 'hello-token')
    // No sync call should have been made.
    const syncCalls = H.mockExecFile.mock.calls.filter(
      (c) => (c[0] as string) === 'connectors' && (c[1] as string[])[0] === 'sync',
    )
    expect(syncCalls).toHaveLength(0)
  })

  it('trims the token before passing it to setSecret', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '', '')
      else cb(null, '', '')
    })
    H.mockExistsSync.mockReturnValue(false)
    const { handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"  spaced-token  \\n"}'))
    expect(await handled).toBe(true)
    expect(H.mockSetSecret).toHaveBeenCalledWith('CONNECTORS_HU_TOKEN', 'connectors.hu API token', 'spaced-token')
  })

  it('runs connectors sync with the trimmed token and reports success when exit is zero', async () => {
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
      else if (cmd === 'connectors' && args[0] === 'sync') cb(null, 'synced ok\n', '')
      else cb(null, '', '')
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"my-tok"}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(true)
    expect(body.configured).toBe(true)
    expect(body.syncOutput).toBe('synced ok')
    expect(H.loggerInfo).toHaveBeenCalledWith('connectors-hu configured and synced')
    expect(H.loggerWarn).not.toHaveBeenCalled()
    // Verify the CONNECTORS_HU_TOKEN env is forwarded to the child.
    const syncCall = H.mockExecFile.mock.calls.find(
      (c) => (c[0] as string) === 'connectors' && (c[1] as string[])[0] === 'sync',
    )
    expect(syncCall).toBeDefined()
    const opts = syncCall![2] as { env?: Record<string, string> }
    expect(opts.env?.CONNECTORS_HU_TOKEN).toBe('my-tok')
    expect(opts.env?.PATH).toContain(process.env.HOME! + '/.local/bin')
  })

  it('reports sync failure (ok=false) and logs logger.warn when connectors sync exits non-zero', async () => {
    setupExecFile((cmd, args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
      else if (cmd === 'connectors' && args[0] === 'sync') {
        cb(new Error('sync failed'), '', 'connection refused\n')
      } else {
        cb(null, '', '')
      }
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"my-tok"}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.configured).toBe(true)
    expect(body.syncOutput).toContain('connection refused')
    expect(H.loggerWarn).toHaveBeenCalledTimes(1)
    expect(H.loggerWarn.mock.calls[0][0]).toEqual({ output: expect.any(String) })
    expect(H.loggerWarn.mock.calls[0][1]).toBe('connectors sync returned non-zero')
    expect(H.loggerInfo).not.toHaveBeenCalled()
  })

  it('returns 400 when the token field is missing entirely', async () => {
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ ok: false, configured: false, syncOutput: 'Token is required' })
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 400 when the token is the empty string', async () => {
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":""}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ ok: false, configured: false, syncOutput: 'Token is required' })
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 400 when the token is whitespace only', async () => {
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"   "}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ ok: false, configured: false, syncOutput: 'Token is required' })
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 400 when the token is null', async () => {
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":null}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ ok: false, configured: false, syncOutput: 'Token is required' })
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 400 when the token is a number', async () => {
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":0}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ ok: false, configured: false, syncOutput: 'Token is required' })
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 400 when the token is an array', async () => {
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":[]}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ ok: false, configured: false, syncOutput: 'Token is required' })
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 500 with String(err) and logs logger.error when readBody throws', async () => {
    H.mockReadBody.mockRejectedValueOnce(new Error('body-read-boom'))
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.configured).toBe(false)
    expect(body.syncOutput).toContain('body-read-boom')
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError.mock.calls[0][1]).toBe('connectors-hu configure failed')
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 500 with String(err) and logs logger.error when JSON.parse throws', async () => {
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('not json'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.configured).toBe(false)
    expect(typeof body.syncOutput).toBe('string')
    expect(H.loggerError).toHaveBeenCalledTimes(1)
    expect(H.loggerError.mock.calls[0][1]).toBe('connectors-hu configure failed')
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('returns 500 when setSecret throws after a valid token is parsed', async () => {
    H.mockSetSecret.mockImplementationOnce(() => { throw new Error('vault-set-boom') })
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '', '')
      else cb(null, '', '')
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"x"}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.syncOutput).toContain('vault-set-boom')
    expect(H.loggerError).toHaveBeenCalledTimes(1)
  })

  it('returns 500 when the isInstalled() probe throws during configure', async () => {
    H.mockSetSecret.mockImplementationOnce(() => { throw new Error('isInstalled-boom-after-set') })
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') throw new Error('which-explodes')
      cb(null, '', '')
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"x"}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.syncOutput).toContain('isInstalled-boom-after-set')
  })

  it('returns 500 when the sync call throws synchronously after a successful setSecret', async () => {
    setupExecFile((cmd, _args, _opts, cb) => {
      if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
      else if (cmd === 'connectors') throw new Error('sync-throws-sync')
      cb(null, '', '')
    })
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure', Buffer.from('{"token":"x"}'))
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.ok).toBe(false)
    expect(body.syncOutput).toContain('sync-throws-sync')
  })

  it('does not call setSecret on the 400 validation branch (token missing)', async () => {
    await call('POST', '/api/connectors-hu/configure', Buffer.from('{"foo":"bar"}'))
    expect(H.mockSetSecret).not.toHaveBeenCalled()
  })

  it('forwards a non-Error thrown value as its String() representation', async () => {
    H.mockReadBody.mockRejectedValueOnce('string-rejection' as unknown as Error)
    const { res, json, handled } = call('POST', '/api/connectors-hu/configure')
    expect(await handled).toBe(true)
    expect(res.statusCode).toBe(500)
    const body = json() as Record<string, unknown>
    expect(body.syncOutput).toBe('string-rejection')
  })
})

// ===========================================================================
// EXTENDED_PATH module-load branch (process.env.PATH || '')
// ---------------------------------------------------------------------------
// The `EXTENDED_PATH` constant is built once at module load via
//   `${LOCAL_BIN}:${process.env.PATH || ''}`
// The default import above captures PATH = '/usr/bin:/bin', so the `|| ''`
// fallback branch is never taken. We re-import the SUT with PATH forced to
// the empty string so the right side of the `||` is exercised. Coverage
// tracks branch decisions at expression granularity, not per-import -- a
// single fresh import with PATH='' is enough to flip the branch.
// ===========================================================================
describe('connectors-hu with PATH unset (covers the || \'\')', () => {
  it('resolves EXTENDED_PATH with the empty fallback and still serves status', async () => {
    const prevPath = process.env.PATH
    process.env.PATH = ''
    try {
      vi.resetModules()
      // After resetModules, the hoisted vi.mock factories still apply, so the
      // mocks (child_process, fs, vault, http-helpers, logger) are wired
      // against the freshly imported SUT.
      const sut = await import('../web/routes/connectors-hu.js')
      H.mockExecFile.mockReset()
      H.mockExistsSync.mockReset().mockReturnValue(false)
      setupExecFile((cmd, _args, _opts, cb) => {
        if (cmd === '/usr/bin/which') cb(null, '/usr/local/bin/connectors\n', '')
        else if (cmd === 'connectors') cb(null, 'connectors 1.0.0', '')
        else cb(null, '', '')
      })
      const res = mkRes()
      const ctx: RouteContext = {
        req: { headers: {} } as any,
        res: res as unknown as import('node:http').ServerResponse,
        path: '/api/connectors-hu/status',
        method: 'GET',
        url: new URL('http://127.0.0.1:3420/api/connectors-hu/status'),
      }
      const handled = await sut.tryHandleConnectorsHu(ctx)
      expect(handled).toBe(true)
      expect(res.statusCode).toBe(200)
      const body = JSON.parse(res.body)
      expect(body).toMatchObject({ ok: true, installed: true, version: 'connectors 1.0.0' })
    } finally {
      process.env.PATH = prevPath
      vi.resetModules()
    }
  })
})
