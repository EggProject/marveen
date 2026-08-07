// 100% coverage suite for src/web/claude-credentials-guard.ts.
//
// The SUT has three layers:
//   1. Pure helpers (looksLikeSetupToken, credentialsGuardEnabled,
//      isPromotableSetupCredential, classifyAuthProbe) -- tested directly
//      with no fs / process / platform interaction.
//   2. Private side-effecting helpers (readFleetToken, tokenHash,
//      readVerifiedHash, liveTestToken, tokenIsValid, stampTokenVerified,
//      liveProbeAuth) -- exercised through the public lifecycle functions.
//   3. Public lifecycle functions (syncFleetTokenFromSharedCredentials,
//      quarantineFleetToken, quarantineFleetTokenIfDead, fleetTokenBootPass,
//      renameSharedCredentialsIfSafe).
//
// Strategy: mock every side-effecting dep (node:fs, node:os, node:child_process,
// config.js, platform.js, agent-process.js, logger.js) so the SUT never
// touches the real filesystem, real binaries, or real crypto. node:crypto's
// real createHash is preserved so tokenHash stays faithful to sha256 (it is
// the round-trip key the rest of the file relies on). The "virtual filesystem"
// lives in `m.files` so each test can stage files deterministically and
// inspect rename / write outcomes.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { join } from 'node:path'
import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Hoisted mock state. vi.mock factories run at hoist time and cannot close
// over top-level `const` declarations (TDZ at hoist time); vi.hoisted() puts
// the shared state in a scope the factories can read. ONE vi.hoisted() call
// holds all shared values -- separate calls run in separate TDZ scopes.
// ---------------------------------------------------------------------------

const P = vi.hoisted(() => {
  const path = require('node:path') as typeof import('node:path')
  const SANDBOX = '/sandbox'
  const STORE_DIR = path.join(SANDBOX, 'store')
  const HOME = path.join(SANDBOX, 'home')
  const TMP = '/tmp'
  return {
    SANDBOX,
    STORE_DIR,
    HOME,
    TMP,
    FLEET_TOKEN_PATH: path.join(STORE_DIR, '.claude-oauth-token'),
    FLEET_TOKEN_BAD_PATH: path.join(STORE_DIR, '.claude-oauth-token.bad'),
    VERIFIED_STAMP_PATH: path.join(STORE_DIR, '.claude-oauth-token.verified'),
    HOME_CREDENTIALS_PATH: path.join(HOME, '.claude', '.credentials.json'),
    BAK_CREDENTIALS_PATH: path.join(HOME, '.claude', '.credentials.json') + '.bak',
    HOME_CLAUDE_DIR: path.join(HOME, '.claude'),
  }
})

const m = vi.hoisted(() => {
  // Virtual filesystem: path -> content. existsSync/renameSync consult this
  // map; readFileSync throws ENOENT for any path not in the map.
  const files = new Map<string, string>()
  let tmpCounter = 0
  return {
    files,
    // For platform.js / child_process mocks.
    platform: 'linux-server' as 'macos' | 'linux-server' | 'linux-gui',
    claudeBin: '/mock/claude',
    // execFileSync mock: null = success with stdout, Error = throws.
    execFileSyncBehavior: null as null | { output: string } | Error,
    // execFile mock callback result.
    execFileCallback: null as null | ((cmd: string, args: string[]) => { error: Error | null; stdout: string; stderr: string } | { code: 'ENOENT' }),
    // Logger spies.
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),
    loggerFatal: vi.fn(),
    // Per-test fault overrides for fs functions. Setting any of these
    // causes the top-level vi.mock factory to use the override instead
    // of the default pass-through behaviour.
    renameSyncImpl: null as null | ((from: string, to: string) => void),
    writeFileSyncImpl: null as null | ((p: string, content: string | Buffer) => void),
    readFileSyncImpl: null as null | ((p: string) => string),
    mkdtempSyncImpl: null as null | ((prefix: string) => string),
    rmSyncImpl: null as null | ((p: string, opts?: unknown) => void),
    nextTmpCounter(): number {
      return tmpCounter++
    },
  }
})

// ---------------------------------------------------------------------------
// config.js -> redirect STORE_DIR into the sandbox so VERIFIED_STAMP and
// FLEET_OAUTH_TOKEN_PATH land inside our virtual fs.
// ---------------------------------------------------------------------------

vi.mock('../config.js', () => ({
  PROJECT_ROOT: P.SANDBOX,
  STORE_DIR: P.STORE_DIR,
  DB_FILENAME: 'claudeclaw.db',
  PID_FILENAME: 'claudeclaw.pid',
}))

// ---------------------------------------------------------------------------
// platform.js -> PLATFORM + resolveFromPath. PLATFORM is read once at SUT
// import; tests that need a different platform use vi.resetModules() +
// vi.doMock() before importing.
// ---------------------------------------------------------------------------

vi.mock('../platform.js', () => ({
  PLATFORM: 'linux-server',
  resolveFromPath: () => m.claudeBin,
}))

// ---------------------------------------------------------------------------
// agent-process.js -> just enough to give the SUT its FLEET_OAUTH_TOKEN_PATH
// constant. No other agent-process symbols are imported by the SUT.
// ---------------------------------------------------------------------------

vi.mock('../web/agent-process.js', () => ({
  FLEET_OAUTH_TOKEN_PATH: P.FLEET_TOKEN_PATH,
}))

// ---------------------------------------------------------------------------
// logger.js -> silence + assert.
// ---------------------------------------------------------------------------

vi.mock('../logger.js', () => ({
  logger: {
    info: m.loggerInfo,
    warn: m.loggerWarn,
    error: m.loggerError,
    debug: m.loggerDebug,
    fatal: m.loggerFatal,
    trace: vi.fn(),
  },
}))

// ---------------------------------------------------------------------------
// node:os -> homedir, tmpdir. Both SUT imports are redirected into the
// sandbox so HOME_CREDENTIALS lives inside the virtual fs.
// ---------------------------------------------------------------------------

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => P.HOME,
    tmpdir: () => P.TMP,
  }
})

// ---------------------------------------------------------------------------
// node:fs -> virtual filesystem backed by `m.files`. The SUT only uses 6 of
// these: existsSync, readFileSync, writeFileSync, renameSync, mkdtempSync,
// rmSync. Pass everything else through to the real fs (none of these paths
// appear in the SUT; this is just a safety net).
// ---------------------------------------------------------------------------

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (p: string) => m.files.has(p),
    readFileSync: (p: string) => {
      if (m.readFileSyncImpl) return m.readFileSyncImpl(p)
      if (!m.files.has(p)) {
        const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, open '${p}'`)
        e.code = 'ENOENT'
        throw e
      }
      return m.files.get(p) ?? ''
    },
    writeFileSync: (p: string, content: string | Buffer) => {
      if (m.writeFileSyncImpl) {
        m.writeFileSyncImpl(p, content)
        return
      }
      m.files.set(p, typeof content === 'string' ? content : content.toString())
    },
    renameSync: (from: string, to: string) => {
      if (m.renameSyncImpl) {
        m.renameSyncImpl(from, to)
        return
      }
      if (!m.files.has(from)) {
        const e: NodeJS.ErrnoException = new Error(`ENOENT: no such file or directory, rename '${from}'`)
        e.code = 'ENOENT'
        throw e
      }
      const content = m.files.get(from) ?? ''
      m.files.set(to, content)
      m.files.delete(from)
    },
    mkdtempSync: (prefix: string) => {
      if (m.mkdtempSyncImpl) return m.mkdtempSyncImpl(prefix)
      return `${P.TMP}/cred-guard-${m.nextTmpCounter()}`
    },
    rmSync: (p: string, opts?: unknown) => {
      if (m.rmSyncImpl) {
        m.rmSyncImpl(p, opts)
        return
      }
      // Default: remove the path from the virtual fs (best-effort: only
      // honoured for paths that exist; ignores options).
      m.files.delete(p)
    },
  }
})

// ---------------------------------------------------------------------------
// node:child_process -> execFileSync + execFile. Tests drive these via
// m.execFileSyncBehavior and m.execFileCallback.
// ---------------------------------------------------------------------------

vi.mock('node:child_process', () => ({
  execFileSync: (_cmd: string, _args: readonly unknown[], _opts?: unknown) => {
    const beh = m.execFileSyncBehavior
    if (beh instanceof Error) throw beh
    if (beh && 'output' in beh) return beh.output
    return ''
  },
  execFile: (_cmd: string, _args: readonly unknown[], _opts: unknown, cb?: (err: Error | null, stdout: string, stderr: string) => void) => {
    const cbFn = cb as (err: Error | null, stdout: string, stderr: string) => void
    const result = m.execFileCallback
    if (!result) {
      cbFn(null, '', '')
      return
    }
    const r = result(_cmd, [...(_args as string[])])
    if ('code' in r && r.code === 'ENOENT') {
      const err = new Error('spawn ENOENT') as NodeJS.ErrnoException
      err.code = 'ENOENT'
      cbFn(err, '', '')
      return
    }
    cbFn(r.error, r.stdout, r.stderr)
  },
}))

// ---------------------------------------------------------------------------
// Import SUT AFTER every mock is registered. We use a helper that resets the
// module registry and re-imports -- this is the only way to give each test
// a fresh PLATFORM binding (PLATFORM is read once at module-eval time).
// ---------------------------------------------------------------------------

type Sut = typeof import('../web/claude-credentials-guard.js')
async function loadSUT(platform?: 'macos' | 'linux-server' | 'linux-gui'): Promise<Sut> {
  vi.resetModules()
  // Re-register the platform mock on every loadSUT call. Without this,
  // a vi.doUnmock('../platform.js') in a previous afterEach would let
  // the NEXT test's import resolve to the real platform.js (which
  // honours process.platform, breaking platform-specific assertions).
  vi.doMock('../platform.js', () => ({
    PLATFORM: platform ?? m.platform,
    resolveFromPath: () => m.claudeBin,
  }))
  return import('../web/claude-credentials-guard.js')
}

// ---------------------------------------------------------------------------
// Test-time reset. The m.* state holds across tests; clear it before each.
// ---------------------------------------------------------------------------

beforeEach(() => {
  m.files.clear()
  m.execFileSyncBehavior = null
  m.execFileCallback = null
  m.platform = 'linux-server'
  m.loggerInfo.mockReset()
  m.loggerWarn.mockReset()
  m.loggerError.mockReset()
  m.loggerDebug.mockReset()
  m.loggerFatal.mockReset()
})

afterEach(() => {
  // Reset per-test fault flags so subsequent tests see the default
  // (pass-through) virtual fs again. vi.doMock is intentionally NOT
  // used for node:fs here -- the top-level vi.mock factory reads from
  // m.* and we control behaviour through m.* flags instead.
  m.renameSyncImpl = null
  m.writeFileSyncImpl = null
  m.readFileSyncImpl = null
  m.mkdtempSyncImpl = null
  m.rmSyncImpl = null
  // No vi.doUnmock('../platform.js') here: loadSUT re-registers the
  // platform mock on every call (see loadSUT body), so we never need
  // to undo a previous registration.
})

// ---------------------------------------------------------------------------
// 1. Pure helpers
// ---------------------------------------------------------------------------

describe('looksLikeSetupToken', () => {
  it('accepts a well-formed setup-token', async () => {
    const { looksLikeSetupToken } = await loadSUT()
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(80))).toBe(true)
  })

  it('rejects a truncated token (the ~80-byte failure mode)', async () => {
    const { looksLikeSetupToken } = await loadSUT()
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(10))).toBe(false)
  })

  it('rejects the wrong prefix (e.g. a credentials JSON blob or api key)', async () => {
    const { looksLikeSetupToken } = await loadSUT()
    expect(looksLikeSetupToken('sk-ant-api03-' + 'A'.repeat(80))).toBe(false)
    expect(looksLikeSetupToken('{"claudeAiOauth":{}}')).toBe(false)
    expect(looksLikeSetupToken('')).toBe(false)
  })

  it('rejects a token with a stray newline / whitespace', async () => {
    const { looksLikeSetupToken } = await loadSUT()
    expect(looksLikeSetupToken('sk-ant-oat01-' + 'A'.repeat(80) + '\n')).toBe(false)
    expect(looksLikeSetupToken('  sk-ant-oat01-' + 'A'.repeat(80))).toBe(false)
  })
})

describe('credentialsGuardEnabled', () => {
  const prev = process.env['CLAUDE_CREDENTIALS_GUARD']
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAUDE_CREDENTIALS_GUARD']
    else process.env['CLAUDE_CREDENTIALS_GUARD'] = prev
  })

  it('is OFF by default (flag unset)', async () => {
    const { credentialsGuardEnabled } = await loadSUT()
    delete process.env['CLAUDE_CREDENTIALS_GUARD']
    expect(credentialsGuardEnabled()).toBe(false)
  })

  it('is OFF for any value other than exactly "1"', async () => {
    const { credentialsGuardEnabled } = await loadSUT()
    process.env['CLAUDE_CREDENTIALS_GUARD'] = 'true'
    expect(credentialsGuardEnabled()).toBe(false)
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '0'
    expect(credentialsGuardEnabled()).toBe(false)
  })

  it('is ON only for "1"', async () => {
    const { credentialsGuardEnabled } = await loadSUT()
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '1'
    expect(credentialsGuardEnabled()).toBe(true)
  })
})

describe('isPromotableSetupCredential', () => {
  const NOW = 1_784_000_000_000
  const DAY = 24 * 60 * 60 * 1000
  const oat = 'sk-ant-oat01-' + 'A'.repeat(80)

  it('promotes the bootcamp shape: oat01 + ~1-year expiry (refreshToken presence is irrelevant)', async () => {
    const { isPromotableSetupCredential } = await loadSUT()
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 365 * DAY }, NOW)).toBe(true)
  })

  it('REJECTS a rotating-family oat01 with short expiry (hours/days)', async () => {
    const { isPromotableSetupCredential } = await loadSUT()
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 8 * 60 * 60 * 1000 }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + 30 * DAY }, NOW)).toBe(false)
  })

  it('rejects at exactly the boundary minus one, accepts at the 90-day boundary', async () => {
    const { isPromotableSetupCredential, MIN_PROMOTABLE_LIFETIME_MS } = await loadSUT()
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + MIN_PROMOTABLE_LIFETIME_MS }, NOW)).toBe(true)
    expect(isPromotableSetupCredential({ accessToken: oat, expiresAt: NOW + MIN_PROMOTABLE_LIFETIME_MS - 1 }, NOW)).toBe(false)
  })

  it('rejects a non-setup-token prefix and a missing/absent expiresAt (conservative)', async () => {
    const { isPromotableSetupCredential } = await loadSUT()
    expect(isPromotableSetupCredential({ accessToken: 'sk-ant-sid01-' + 'A'.repeat(80), expiresAt: NOW + 365 * DAY }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({ accessToken: oat }, NOW)).toBe(false)
    expect(isPromotableSetupCredential({}, NOW)).toBe(false)
  })
})

describe('classifyAuthProbe', () => {
  it('ok: ran clean and answered OK', async () => {
    const { classifyAuthProbe } = await loadSUT()
    expect(classifyAuthProbe({ ran: true, exitedNonZero: false, output: 'OK' })).toBe('ok')
  })

  it('auth-rejected: the live bug-3 signature (401 Invalid bearer token)', async () => {
    const { classifyAuthProbe } = await loadSUT()
    expect(classifyAuthProbe({
      ran: true, exitedNonZero: true,
      output: 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
    })).toBe('auth-rejected')
  })

  it('auth-rejected: invalid API key variant', async () => {
    const { classifyAuthProbe } = await loadSUT()
    expect(classifyAuthProbe({ ran: true, exitedNonZero: true, output: 'Invalid API key' })).toBe('auth-rejected')
  })

  it('inconclusive: nonzero exit WITHOUT an auth signature (network flake) must not kill a credential', async () => {
    const { classifyAuthProbe } = await loadSUT()
    expect(classifyAuthProbe({ ran: true, exitedNonZero: true, output: 'fetch failed: ETIMEDOUT' })).toBe('inconclusive')
  })

  it('inconclusive: the probe never ran (binary missing)', async () => {
    const { classifyAuthProbe } = await loadSUT()
    expect(classifyAuthProbe({ ran: false, exitedNonZero: true, output: '' })).toBe('inconclusive')
  })

  it('inconclusive: clean exit with an unexpected answer (no OK)', async () => {
    const { classifyAuthProbe } = await loadSUT()
    expect(classifyAuthProbe({ ran: true, exitedNonZero: false, output: 'I cannot comply' })).toBe('inconclusive')
  })
})

// ---------------------------------------------------------------------------
// 2. renameSharedCredentialsIfSafe -- all branches.
// ---------------------------------------------------------------------------

describe('renameSharedCredentialsIfSafe', () => {
  const FLAG = 'CLAUDE_CREDENTIALS_GUARD'
  const prevFlag = process.env[FLAG]
  afterEach(() => {
    if (prevFlag === undefined) delete process.env[FLAG]
    else process.env[FLAG] = prevFlag
  })

  function setCredFile(content = '{"oops":1}'): void {
    m.files.set(P.HOME_CREDENTIALS_PATH, content)
  }
  function setBakFile(content = '{"old":1}'): void {
    m.files.set(P.BAK_CREDENTIALS_PATH, content)
  }
  function setFleetToken(token: string): void {
    m.files.set(P.FLEET_TOKEN_PATH, token)
  }
  function setVerifiedStamp(hash: string): void {
    m.files.set(P.VERIFIED_STAMP_PATH, hash + '\n')
  }

  it('returns "disabled" and never touches fs when the flag is off', async () => {
    delete process.env[FLAG]
    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('disabled')
    expect(m.files.has(P.BAK_CREDENTIALS_PATH)).toBe(false)
  })

  it('returns "not-linux" on macOS even with the flag on (never renames)', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    const { renameSharedCredentialsIfSafe } = await loadSUT('macos')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('not-linux')
    expect(m.files.get(P.HOME_CREDENTIALS_PATH)).toBe('{"oops":1}')
    expect(m.files.has(P.BAK_CREDENTIALS_PATH)).toBe(false)
  })

  it('returns "no-credentials" when no credentials.json AND no .bak exist', async () => {
    process.env[FLAG] = '1'
    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('no-credentials')
  })

  it('returns "already-renamed" when only the .bak is present (steady state)', async () => {
    process.env[FLAG] = '1'
    setBakFile()
    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('already-renamed')
  })

  it('returns "token-invalid" when no fleet token is present (does not rename)', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    // No fleet token -> tokenIsValid returns false
    m.execFileSyncBehavior = { output: 'OK' } // would succeed if reached, but shouldn't
    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('token-invalid')
    expect(m.files.get(P.HOME_CREDENTIALS_PATH)).toBe('{"oops":1}')
    expect(m.files.has(P.BAK_CREDENTIALS_PATH)).toBe(false)
  })

  it('returns "token-invalid" when the fleet token is malformed', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    setFleetToken('garbage-not-a-setup-token')
    m.execFileSyncBehavior = { output: 'OK' } // would succeed if reached, but shouldn't
    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('token-invalid')
    expect(m.files.has(P.BAK_CREDENTIALS_PATH)).toBe(false)
  })

  it('returns "token-invalid" when the live test FAILS (and does NOT rename)', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileSyncBehavior = new Error('live test failed')
    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('token-invalid')
    expect(m.loggerWarn).toHaveBeenCalled()
    expect(m.files.get(P.HOME_CREDENTIALS_PATH)).toBe('{"oops":1}')
    expect(m.files.has(P.BAK_CREDENTIALS_PATH)).toBe(false)
  })

  it('returns "renamed" and moves credentials.json -> .bak on the cached-stamp fast path', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    const token = 'sk-ant-oat01-' + 'A'.repeat(80)
    setFleetToken(token)
    // Pre-compute the hash that the real sha256 produces for this token.
    const { createHash } = await import('node:crypto')
    const expectedHash = createHash('sha256').update(token).digest('hex')
    setVerifiedStamp(expectedHash)
    // execFileSync MUST NOT be called on the cached-stamp fast path.
    m.execFileSyncBehavior = new Error('should not be called on cached path')

    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('renamed')

    expect(m.files.has(P.HOME_CREDENTIALS_PATH)).toBe(false)
    expect(m.files.get(P.BAK_CREDENTIALS_PATH)).toBe('{"oops":1}')
    expect(m.loggerWarn).toHaveBeenCalled()
  })

  it('returns "renamed" after a successful live test (fresh stamp written)', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileSyncBehavior = { output: 'OK' }

    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('renamed')
    expect(m.files.get(P.BAK_CREDENTIALS_PATH)).toBe('{"oops":1}')
    expect(m.files.has(P.HOME_CREDENTIALS_PATH)).toBe(false)
    expect(m.files.has(P.VERIFIED_STAMP_PATH)).toBe(true)
  })

  it('still returns "renamed" when the stamp write throws (optimisation swallowed)', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileSyncBehavior = { output: 'OK' }

    // Force the post-pass writeFileSync on VERIFIED_STAMP to throw. The SUT
    // catches and continues; the rename still completes.
    m.writeFileSyncImpl = (p, _content) => {
      if (p === P.VERIFIED_STAMP_PATH) throw new Error('disk full')
      m.files.set(p, typeof _content === 'string' ? _content : _content.toString())
    }

    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('renamed')
    expect(m.files.has(P.BAK_CREDENTIALS_PATH)).toBe(true)
  })

  it('returns "error" when the rename itself throws (e.g. permission denied)', async () => {
    process.env[FLAG] = '1'
    setCredFile()
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    const { createHash } = await import('node:crypto')
    const h = createHash('sha256').update('sk-ant-oat01-' + 'A'.repeat(80)).digest('hex')
    setVerifiedStamp(h)

    m.renameSyncImpl = () => {
      throw new Error('EACCES: permission denied')
    }

    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    expect(renameSharedCredentialsIfSafe('/nonexistent/claude')).toBe('error')
    expect(m.files.get(P.HOME_CREDENTIALS_PATH)).toBe('{"oops":1}')
  })
})

// ---------------------------------------------------------------------------
// 3. liveProbeAuth exercised via quarantineFleetTokenIfDead -- the four
//    public result values.
// ---------------------------------------------------------------------------

describe('liveProbeAuth -- via quarantineFleetTokenIfDead', () => {
  function setFleetToken(t: string): void {
    m.files.set(P.FLEET_TOKEN_PATH, t)
  }
  function setVerifiedStamp(h: string): void {
    m.files.set(P.VERIFIED_STAMP_PATH, h + '\n')
  }

  it('returns "no-token" when there is no fleet token to probe', async () => {
    const { quarantineFleetTokenIfDead } = await loadSUT()
    expect(await quarantineFleetTokenIfDead()).toBe('no-token')
  })

  it('returns "healthy" on a clean probe AND stamps the verified mark', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })

    const { quarantineFleetTokenIfDead } = await loadSUT()
    expect(await quarantineFleetTokenIfDead()).toBe('healthy')
    expect(m.files.has(P.VERIFIED_STAMP_PATH)).toBe(true)
  })

  it('returns "quarantined" when the live probe is auth-rejected', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileCallback = () => ({
      error: new Error('401'),
      stdout: '',
      stderr: 'Failed to authenticate. API Error: 401 Invalid bearer token',
    })

    const { quarantineFleetTokenIfDead } = await loadSUT()
    expect(await quarantineFleetTokenIfDead()).toBe('quarantined')
    expect(m.files.has(P.FLEET_TOKEN_PATH)).toBe(false)
    expect(m.files.has(P.FLEET_TOKEN_BAD_PATH)).toBe(true)
    expect(m.files.has(P.VERIFIED_STAMP_PATH)).toBe(false)
  })

  it('returns "inconclusive" on a network-flake probe (no auth signature, nonzero exit)', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileCallback = () => ({ error: new Error('ETIMEDOUT'), stdout: '', stderr: 'fetch failed: ETIMEDOUT' })

    const { quarantineFleetTokenIfDead } = await loadSUT()
    expect(await quarantineFleetTokenIfDead()).toBe('inconclusive')
    expect(m.files.get(P.FLEET_TOKEN_PATH)).toBe('sk-ant-oat01-' + 'A'.repeat(80))
  })

  it('returns "inconclusive" when the binary is missing (spawn ENOENT)', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileCallback = () => ({ code: 'ENOENT' as const })

    const { quarantineFleetTokenIfDead } = await loadSUT()
    expect(await quarantineFleetTokenIfDead()).toBe('inconclusive')
  })

  it('returns "inconclusive" when the outer try-catch catches (mkdtempSync throws)', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))

    m.mkdtempSyncImpl = () => {
      throw new Error('EACCES')
    }

    const { quarantineFleetTokenIfDead } = await loadSUT()
    expect(await quarantineFleetTokenIfDead()).toBe('inconclusive')
  })

  it('swallows rmSync failures in finally (best-effort cleanup)', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })

    m.rmSyncImpl = () => {
      throw new Error('EACCES')
    }

    const { quarantineFleetTokenIfDead } = await loadSUT()
    expect(await quarantineFleetTokenIfDead()).toBe('healthy')
  })
})

// ---------------------------------------------------------------------------
// 4. fleetTokenBootPass -- all branches.
// ---------------------------------------------------------------------------

describe('fleetTokenBootPass', () => {
  const DAY = 24 * 60 * 60 * 1000
  const oat = 'sk-ant-oat01-' + 'A'.repeat(80)

  function setFleetToken(t: string): void {
    m.files.set(P.FLEET_TOKEN_PATH, t)
  }
  function setVerifiedStamp(h: string): void {
    m.files.set(P.VERIFIED_STAMP_PATH, h + '\n')
  }
  function setCredFile(content: string): void {
    m.files.set(P.HOME_CREDENTIALS_PATH, content)
  }

  it('delegates to syncFleetTokenFromSharedCredentials when no fleet token (returns "no-credentials")', async () => {
    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('no-credentials')
  })

  it('returns "malformed-left-alone" when the fleet token is not a well-formed setup-token', async () => {
    setFleetToken('garbage')
    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('malformed-left-alone')
    expect(m.loggerWarn).toHaveBeenCalled()
  })

  it('returns "validated-cached" when the verified stamp already matches', async () => {
    setFleetToken(oat)
    const { createHash } = await import('node:crypto')
    const h = createHash('sha256').update(oat).digest('hex')
    setVerifiedStamp(h)
    m.execFileCallback = () => {
      throw new Error('should not probe on cached path')
    }

    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('validated-cached')
  })

  it('returns "validated" on a successful fresh probe and stamps the verified mark', async () => {
    setFleetToken(oat)
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })

    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('validated')
    expect(m.files.has(P.VERIFIED_STAMP_PATH)).toBe(true)
  })

  it('returns "quarantined" when a fresh probe proves the token auth-rejected', async () => {
    setFleetToken(oat)
    m.execFileCallback = () => ({
      error: new Error('401'),
      stdout: '',
      stderr: '401 {"type":"error","error":{"type":"authentication_error","message":"Invalid bearer token"}}',
    })

    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('quarantined')
    expect(m.files.has(P.FLEET_TOKEN_BAD_PATH)).toBe(true)
  })

  it('returns "validate-inconclusive" on a network flake (no auth signature)', async () => {
    setFleetToken(oat)
    m.execFileCallback = () => ({ error: new Error('ETIMEDOUT'), stdout: '', stderr: 'fetch failed' })

    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('validate-inconclusive')
  })

  it('returns "fleet-token-present" when fleetTokenBootPass finds one (via sync)', async () => {
    // No fleet token initially; the sync backfill finds one in the shared
    // credentials.json and promotes it. Pinning test for the branch where
    // fleetTokenBootPass delegates to syncFleetTokenFromSharedCredentials
    // and the sync returns 'synced'.
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: oat, expiresAt: Date.now() + 365 * DAY },
    })
    setCredFile(json)
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })

    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('synced')
    expect(m.files.has(P.FLEET_TOKEN_PATH)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 5. syncFleetTokenFromSharedCredentials -- all six return values.
// ---------------------------------------------------------------------------

describe('syncFleetTokenFromSharedCredentials', () => {
  const DAY = 24 * 60 * 60 * 1000
  const oat = 'sk-ant-oat01-' + 'A'.repeat(80)

  function setCredFile(json: string): void {
    m.files.set(P.HOME_CREDENTIALS_PATH, json)
  }
  function setFleetToken(t: string): void {
    m.files.set(P.FLEET_TOKEN_PATH, t)
  }

  it('returns "fleet-token-present" when the fleet token file already has content', async () => {
    setFleetToken(oat)
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('fleet-token-present')
  })

  it('returns "no-credentials" when fleet token file is whitespace only and no shared credentials.json', async () => {
    // Pinning: readFleetToken trims and returns null for whitespace; this
    // takes the "no fleet token" path -> 'no-credentials'.
    setFleetToken('   \n')
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('no-credentials')
  })

  it('returns "no-credentials" when the shared credentials.json does not exist', async () => {
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('no-credentials')
  })

  it('returns "no-credentials" when the shared credentials.json is malformed JSON', async () => {
    setCredFile('not-valid-json{')
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('no-credentials')
  })

  it('returns "not-setup-token" when the credential is not a promotable long-lived setup-token', async () => {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-api03-' + 'A'.repeat(80),
        expiresAt: Date.now() + 365 * DAY,
      },
    })
    setCredFile(json)
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('not-setup-token')
  })

  it('returns "not-setup-token" for a rotating oat01 (expiry < 90 days)', async () => {
    const json = JSON.stringify({
      claudeAiOauth: {
        accessToken: oat,
        expiresAt: Date.now() + 8 * 60 * 60 * 1000,
      },
    })
    setCredFile(json)
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('not-setup-token')
  })

  it('returns "live-test-failed" when the live probe rejects the would-be-promoted token', async () => {
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: oat, expiresAt: Date.now() + 365 * DAY },
    })
    setCredFile(json)
    m.execFileCallback = () => ({ error: new Error('401'), stdout: '', stderr: 'Invalid bearer token' })

    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('live-test-failed')
    expect(m.files.has(P.FLEET_TOKEN_PATH)).toBe(false)
  })

  it('returns "synced" on a successful probe -- writes the fleet token AND the verified stamp', async () => {
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: oat, expiresAt: Date.now() + 365 * DAY },
    })
    setCredFile(json)
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })

    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('synced')
    expect(m.files.get(P.FLEET_TOKEN_PATH)).toBe(oat)
    expect(m.files.has(P.VERIFIED_STAMP_PATH)).toBe(true)
  })

  it('returns "not-setup-token" when JSON parses to {} (no claudeAiOauth key)', async () => {
    setCredFile('{}')
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('not-setup-token')
  })

  it('returns "live-test-failed" on an inconclusive probe (must NOT promote)', async () => {
    const json = JSON.stringify({
      claudeAiOauth: { accessToken: oat, expiresAt: Date.now() + 365 * DAY },
    })
    setCredFile(json)
    m.execFileCallback = () => ({ error: new Error('ETIMEDOUT'), stdout: '', stderr: 'fetch failed' })

    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('live-test-failed')
  })

  it('returns "error" when an unexpected exception is thrown inside the try block', async () => {
    setFleetToken('')
    setCredFile('{"claudeAiOauth":{"accessToken":"sk-ant-oat01-' + 'A'.repeat(80) + '","expiresAt":' + (Date.now() + 365 * DAY) + '}}')
    // The probe will succeed so the SUT reaches writeFileSync(FLEET_OAUTH_TOKEN_PATH).
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })
    // Force the writeFileSync call that PROMOTES the new fleet token to throw.
    // This is the post-probe write; if it throws, the outer try/catch lands
    // in the 'error' branch.
    m.writeFileSyncImpl = (p, _content) => {
      if (p === P.FLEET_TOKEN_PATH) throw new Error('disk full')
      m.files.set(p, typeof _content === 'string' ? _content : _content.toString())
    }

    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('error')
    expect(m.loggerWarn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6. quarantineFleetToken -- the public quarantine operation.
// ---------------------------------------------------------------------------

describe('quarantineFleetToken', () => {
  function setFleetToken(t: string): void {
    m.files.set(P.FLEET_TOKEN_PATH, t)
  }
  function setVerifiedStamp(h: string): void {
    m.files.set(P.VERIFIED_STAMP_PATH, h + '\n')
  }

  it('returns false and does nothing when no fleet token file exists', async () => {
    const { quarantineFleetToken } = await loadSUT()
    expect(quarantineFleetToken('test reason')).toBe(false)
    expect(m.files.has(P.FLEET_TOKEN_BAD_PATH)).toBe(false)
  })

  it('renames the fleet token to .bad AND drops the verified stamp', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))
    setVerifiedStamp('abc123')

    const { quarantineFleetToken } = await loadSUT()
    expect(quarantineFleetToken('reauth-healer: agent 401 + fleet token failed live probe')).toBe(true)
    expect(m.files.has(P.FLEET_TOKEN_PATH)).toBe(false)
    expect(m.files.get(P.FLEET_TOKEN_BAD_PATH)).toBe('sk-ant-oat01-' + 'A'.repeat(80))
    expect(m.files.has(P.VERIFIED_STAMP_PATH)).toBe(false)
    expect(m.loggerError).toHaveBeenCalled()
  })

  it('returns false when the rename throws (e.g. EACCES)', async () => {
    setFleetToken('sk-ant-oat01-' + 'A'.repeat(80))

    m.renameSyncImpl = () => {
      throw new Error('EACCES')
    }
    // Drive the "rmSync swallows" branch as well by making rmSync throw.
    m.rmSyncImpl = () => {
      throw new Error('EACCES rmSync')
    }

    const { quarantineFleetToken } = await loadSUT()
    expect(quarantineFleetToken('test')).toBe(false)
    expect(m.loggerWarn).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 7. stampTokenVerified -- the public "record verified" helper.
// ---------------------------------------------------------------------------

describe('stampTokenVerified', () => {
  it('writes a sha256(token) + newline to VERIFIED_STAMP', async () => {
    const token = 'sk-ant-oat01-' + 'A'.repeat(80)
    const { stampTokenVerified } = await loadSUT()
    stampTokenVerified(token)
    const stored = m.files.get(P.VERIFIED_STAMP_PATH)
    expect(stored).toMatch(/^[0-9a-f]{64}\n$/)
  })

  it('swallows writeFileSync errors silently (optimisation only)', async () => {
    m.writeFileSyncImpl = () => {
      throw new Error('disk full')
    }
    const { stampTokenVerified } = await loadSUT()
    expect(() => stampTokenVerified('whatever')).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 8. liveTestToken -- the private sync live-test helper.
// ---------------------------------------------------------------------------

describe('liveTestToken', () => {
  const oat = 'sk-ant-oat01-' + 'A'.repeat(80)

  it('returns true when execFileSync output contains \\bOK\\b', async () => {
    m.execFileSyncBehavior = { output: 'OK\n' }
    const { liveTestToken } = await loadSUT()
    expect(liveTestToken(oat, '/mock/claude')).toBe(true)
  })

  it('returns true when output is "  OK  " (surrounding whitespace)', async () => {
    m.execFileSyncBehavior = { output: '   OK   ' }
    const { liveTestToken } = await loadSUT()
    expect(liveTestToken(oat, '/mock/claude')).toBe(true)
  })

  it('returns false when execFileSync throws', async () => {
    m.execFileSyncBehavior = new Error('exec failed')
    const { liveTestToken } = await loadSUT()
    expect(liveTestToken(oat, '/mock/claude')).toBe(false)
  })

  it('returns false when output does not contain \\bOK\\b', async () => {
    m.execFileSyncBehavior = { output: 'I cannot comply with that request' }
    const { liveTestToken } = await loadSUT()
    expect(liveTestToken(oat, '/mock/claude')).toBe(false)
  })

  it('swallows rmSync failures in finally (best-effort cleanup of the tmp dir)', async () => {
    m.execFileSyncBehavior = { output: 'OK\n' }
    m.rmSyncImpl = () => {
      throw new Error('EACCES')
    }
    const { liveTestToken } = await loadSUT()
    // Must NOT propagate the rmSync throw.
    expect(liveTestToken(oat, '/mock/claude')).toBe(true)
  })

  it('skips rmSync in finally when mkdtempSync threw (dir is still null)', async () => {
    // If mkdtempSync throws, `dir` never gets assigned. The catch returns
    // false, then finally runs with `if (dir)` evaluating false. The rmSync
    // branch is NOT taken -- it would be a real `rmSync(undefined, ...)`,
    // which is exactly the path this branch guards against.
    m.mkdtempSyncImpl = () => {
      throw new Error('EACCES')
    }
    const { liveTestToken } = await loadSUT()
    expect(liveTestToken(oat, '/mock/claude')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 9. Branch coverage for the readVerifiedHash / liveProbeAuth /
//    syncFleetTokenFromSharedCredentials / renameSharedCredentialsIfSafe
//    default-value fallbacks.
// ---------------------------------------------------------------------------

describe('branch coverage -- default-value fallbacks', () => {
  const DAY = 24 * 60 * 60 * 1000
  const oat = 'sk-ant-oat01-' + 'A'.repeat(80)

  it('readVerifiedHash: returns null when the stamp is whitespace-only (trim || null fallback)', async () => {
    // The `readVerifiedHash` function returns the trimmed contents OR null
    // for whitespace-only files. Pin this branch by stamping an empty value.
    m.files.set(P.VERIFIED_STAMP_PATH, '   \n\n   ')
    m.files.set(P.FLEET_TOKEN_PATH, oat)
    const { fleetTokenBootPass } = await loadSUT()
    // The cached-stamp branch is skipped (the whitespace doesn't match the
    // hash), so fleetTokenBootPass must probe -- which proves the readVerifiedHash
    // path was walked. We mock a successful probe.
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })
    expect(await fleetTokenBootPass()).toBe('validated')
  })

  it('readVerifiedHash: ENOENT path returns null (catch branch)', async () => {
    // No stamp file -> readVerifiedHash throws ENOENT, caught and returns null.
    m.files.set(P.FLEET_TOKEN_PATH, oat)
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })
    const { fleetTokenBootPass } = await loadSUT()
    expect(await fleetTokenBootPass()).toBe('validated')
  })

  it('liveProbeAuth: stdout and stderr are null-coalesced to empty strings', async () => {
    // The `?? ''` fallback for stdout/stderr when the child returns nulls
    // (rare but the SUT guards against it). Pin this branch.
    m.files.set(P.FLEET_TOKEN_PATH, oat)
    m.execFileCallback = () => ({ error: null, stdout: null as unknown as string, stderr: null as unknown as string })
    const { quarantineFleetTokenIfDead } = await loadSUT()
    // output will be '\n' (from `${null ?? ''}\n${null ?? ''}`), no OK,
    // classifyAuthProbe -> 'inconclusive'. Confirms the null-fallback branches.
    expect(await quarantineFleetTokenIfDead()).toBe('inconclusive')
  })

  it('syncFleetTokenFromSharedCredentials: pinning -- the (cred.accessToken ?? "") fallback is unreachable in the current SUT', async () => {
    // The SUT does `(cred.accessToken ?? '').trim()` on line 224. If the
    // JSON's claudeAiOauth has no accessToken, cred.accessToken is undefined.
    // isPromotableSetupCredential (called on line 223) does the same `?? ''`
    // check on line 189 and rejects empty tokens, so the SUT short-circuits
    // with 'not-setup-token' BEFORE reaching the line 224 fallback. This
    // pinning test documents that current behaviour.
    //
    // Branch coverage for the `?? ''` default on line 224 is documented in
    // docs/needs-to-be-fix/claude-credentials-guard-line-224-dead-code.md:
    // the fallback is dead code because isPromotableSetupCredential already
    // enforces the same guarantee.
    const json = JSON.stringify({
      claudeAiOauth: { expiresAt: Date.now() + 365 * DAY },
    })
    m.files.set(P.HOME_CREDENTIALS_PATH, json)
    const { syncFleetTokenFromSharedCredentials } = await loadSUT()
    expect(await syncFleetTokenFromSharedCredentials()).toBe('not-setup-token')
  })

  it('renameSharedCredentialsIfSafe: defaults to resolveFromPath("claude") when claudeBin is undefined', async () => {
    process.env['CLAUDE_CREDENTIALS_GUARD'] = '1'
    m.files.set(P.HOME_CREDENTIALS_PATH, '{"oops":1}')
    const token = oat
    m.files.set(P.FLEET_TOKEN_PATH, token)
    // Pre-stamp the verified hash so tokenIsValid takes the cached-stamp
    // fast path AND the platform check passes (so the rename proceeds).
    const { createHash } = await import('node:crypto')
    const h = createHash('sha256').update(token).digest('hex')
    m.files.set(P.VERIFIED_STAMP_PATH, h + '\n')

    const { renameSharedCredentialsIfSafe } = await loadSUT('linux-server')
    // No claudeBin arg -> SUT uses resolveFromPath('claude') (our mock
    // returns '/mock/claude').
    expect(renameSharedCredentialsIfSafe()).toBe('renamed')
    expect(m.files.has(P.BAK_CREDENTIALS_PATH)).toBe(true)
  })

  it('liveTestToken: rmSync throws in finally -- the catch branch is exercised', async () => {
    // This exercises the `catch { /* best effort */ }` in the finally block.
    m.execFileSyncBehavior = { output: 'OK\n' }
    m.rmSyncImpl = () => {
      throw new Error('EACCES')
    }
    const { liveTestToken } = await loadSUT()
    expect(liveTestToken(oat, '/mock/claude')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 10. Trying to cover line 224 `?? ''` via vi.doMock on the SUT module.
//     Investigation shows the SUT's internal binding to isPromotableSetupCredential
//     cannot be overridden through vi.doMock (the override applies to the module
//     exports but not to the local binding inside the SUT's own functions).
//     See the bug MD: docs/needs-to-be-fix/claude-credentials-guard-line-224-dead-code.md
// ---------------------------------------------------------------------------

describe('line 224 unreachable branch investigation', () => {
  it('does NOT propagate the isPromotableSetupCredential override into syncFleetTokenFromSharedCredentials', async () => {
    const DAY = 24 * 60 * 60 * 1000
    const json = JSON.stringify({
      claudeAiOauth: { expiresAt: Date.now() + 365 * DAY },
    })
    m.files.set(P.HOME_CREDENTIALS_PATH, json)
    m.execFileCallback = () => ({ error: null, stdout: 'OK', stderr: '' })

    vi.resetModules()
    vi.doMock('../web/claude-credentials-guard.js', async (importOriginal) => {
      const actual = await importOriginal<typeof import('../web/claude-credentials-guard.js')>()
      return {
        ...actual,
        isPromotableSetupCredential: () => true,
      }
    })
    // Re-register the platform mock (otherwise the doMock on the SUT would
    // nullify it). Config/agent-process/child_process/fs/os mocks are
    // already set at file top, but a vi.resetModules() cleared them.
    vi.doMock('../config.js', () => ({
      PROJECT_ROOT: P.SANDBOX,
      STORE_DIR: P.STORE_DIR,
      DB_FILENAME: 'claudeclaw.db',
      PID_FILENAME: 'claudeclaw.pid',
    }))
    vi.doMock('../platform.js', () => ({
      PLATFORM: 'linux-server',
      resolveFromPath: () => m.claudeBin,
    }))
    vi.doMock('../web/agent-process.js', () => ({
      FLEET_OAUTH_TOKEN_PATH: P.FLEET_TOKEN_PATH,
    }))
    const sut = await import('../web/claude-credentials-guard.js')
    // The exported isPromotableSetupCredential IS the stub (returns true).
    expect(sut.isPromotableSetupCredential({ accessToken: '', expiresAt: Date.now() + 365 * DAY }, Date.now())).toBe(true)
    // But the SUT's syncFleetTokenFromSharedCredentials uses the LOCAL binding
    // (the original). So cred.accessToken = undefined still returns
    // 'not-setup-token' -- confirming the line 224 `?? ''` fallback is dead code.
    expect(await sut.syncFleetTokenFromSharedCredentials()).toBe('not-setup-token')
  })
})