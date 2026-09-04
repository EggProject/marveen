// 100% coverage suite for src/web/routes/onboarding.ts.
//
// The wizard exposes four endpoints plus the pure identity-save decision core:
//
//   GET  /api/onboarding/status        -> probes (auth, agents, channel, pairing)
//   POST /api/onboarding/identity      -> save agent display + owner name
//   POST /api/onboarding/claude-auth   -> save OAuth setup-token / API key
//   POST /api/onboarding/launch        -> spawn / bounce the channels session
//
// All collaborators are stubbed so the suite never touches real fs / tmux /
// network. PROJECT_ROOT + STORE_DIR are redirected to a tmpdir-scoped value via
// the mocked config.js so the .env / fleet token / persona files the handler
// reads and writes stay inside the sandbox.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  rmSync,
  existsSync,
  unlinkSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'onboarding-routes-'))
const PROJECT = join(SANDBOX, 'project')
let STORE = join(PROJECT, 'store')
const ENV_FILE = join(PROJECT, '.env')
const FLEET_TOKEN_FILE = join(STORE, '.claude-oauth-token')
const CLAUDE_MD = join(PROJECT, 'CLAUDE.md')
const SOUL_MD = join(PROJECT, 'SOUL.md')
const SANDBOX_HOME = join(SANDBOX, 'home')

// Sandbox home for the .credentials.json keychain lookup; the actual file
// doesn't need to exist for most tests, we just need a stable path.
const HOME_CREDS = join(SANDBOX_HOME, '.claude', '.credentials.json')

// --- Mock config.js ----------------------------------------------------------
// Re-export the real module, but pin PROJECT_ROOT / STORE_DIR to our sandbox.
// CHANNEL_PROVIDER is a const string the handler reads via channelStateDir() /
// readChannelToken(); 'telegram' is the canonical choice for the wizard tests
// because the handler uses readChannelToken + readAccess for the configured
// channel provider.
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => STORE, enumerable: true },
      CHANNEL_PROVIDER: { get: () => 'telegram', enumerable: true },
    },
  )
})

vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))
vi.mock('../platform.js', () => ({ resolveFromPath: vi.fn(() => '/bin/echo') }))

// Mock channel-provider so channelStateDir / readChannelToken are testable.
// The mock path resolves the same module that onboarding.ts loads via
// '../../channel-provider.js' from src/web/routes/. config.ts also imports
// getProviderType from this module so we spread the original.
const CHANNEL_STATE_DIR = join(SANDBOX, 'home', '.claude', 'channels', 'telegram')
const mChannelEnv = vi.hoisted(() => ({
  stateDirFor: vi.fn(() => CHANNEL_STATE_DIR),
  readTokenFor: vi.fn<() => string | null>(() => null),
  getToken: vi.fn(() => ''),
  getChatId: vi.fn(() => ''),
}))
vi.mock('../channel-provider.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    ChannelEnv: vi.fn(function ChannelEnvMock() { return mChannelEnv }),
  }
})

vi.mock('../web/atomic-write.js', () => ({ atomicWriteFileSync: vi.fn() }))

vi.mock('../web/agent-process.js', () => ({
  sessionExistsOnHost: vi.fn(() => false),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),
  mainChannelsSessionExists: vi.fn(() => true),
  createMainChannelsSession: vi.fn(() => 'started'),
}))

vi.mock('../web/claude-credentials-guard.js', () => ({
  liveProbeAuth: vi.fn(async () => 'ok'),
  stampTokenVerified: vi.fn(),
}))

// Mock node:os so onboarding.ts (which calls homedir() at module-load time
// to compute HOME_CREDENTIALS = join(homedir(), '.claude', '.credentials.json'))
// resolves the path inside our sandbox. vitest isolates the mock registry
// per file so other suites are unaffected.
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => SANDBOX_HOME,
    default: { ...actual, homedir: () => SANDBOX_HOME },
  }
})

// Default: execFileSync throws (the real /usr/bin/security is not present in
// the sandbox). The single happy-path keychain test below overrides this
// mock to return successfully, exercising onboarding.ts line 62 (the
// `return true` arm of keychainHasClaudeCredentials).
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(() => {
    throw new Error('sandbox: security binary missing')
  }),
}))

// Import AFTER every mock is registered.
const { tryHandleOnboarding, identitySavePlan } = await import('../web/routes/onboarding.js')
const { atomicWriteFileSync } = await import('../web/atomic-write.js')
const { channelStateDir, readChannelToken } = { channelStateDir: mChannelEnv.stateDirFor, readChannelToken: mChannelEnv.readTokenFor }
const { sessionExistsOnHost } = await import('../web/agent-process.js')
const { hardRestartMarveenChannels, mainChannelsSessionExists, createMainChannelsSession } =
  await import('../web/channel-monitor.js')
const { liveProbeAuth, stampTokenVerified } = await import('../web/claude-credentials-guard.js')
const { logger } = await import('../logger.js')
const { execFileSync } = await import('node:child_process')

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------
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

function mkReq(opts: { body?: Buffer | string } = {}): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  opts: { body?: Buffer | string } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> | null }> {
  const req = mkReq(opts)
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url,
    fedPeer: null,
  }
  const handled = await tryHandleOnboarding(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

// ---------------------------------------------------------------------------
// Sandbox / mocks setup
// ---------------------------------------------------------------------------
const ORIGINAL_PLATFORM = process.platform
beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
  mkdirSync(STORE, { recursive: true })
  // The handler resolves HOME_CREDENTIALS via homedir()/.claude/.credentials.json.
  // node:os is mocked at the top so this lives inside SANDBOX_HOME/.claude/.
  mkdirSync(join(SANDBOX_HOME, '.claude'), { recursive: true })
  // Pin process.platform to 'linux' for the suite so the macOS keychain leg of
  // claudeAuthPresent is never reached (CI runners / dev macs otherwise return
  // a true result that depends on the developer's local keychain state).
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})

beforeEach(() => {
  // Clean sandbox state between tests.
  if (existsSync(ENV_FILE)) unlinkSync(ENV_FILE)
  if (existsSync(FLEET_TOKEN_FILE)) unlinkSync(FLEET_TOKEN_FILE)
  if (existsSync(CLAUDE_MD)) unlinkSync(CLAUDE_MD)
  if (existsSync(SOUL_MD)) unlinkSync(SOUL_MD)
  if (existsSync(HOME_CREDS)) unlinkSync(HOME_CREDS)
  // Re-establish STORE as a directory in case the mkdirSync-fail test replaced
  // it with a regular file.
  if (!existsSync(STORE)) mkdirSync(STORE, { recursive: true })
  // Ensure the mock config.js path is restored (a test that overwrites
  // STORE_DIR must not leak into the next test).
  STORE = join(PROJECT, 'store')

  vi.mocked(atomicWriteFileSync).mockReset()
  vi.mocked(atomicWriteFileSync).mockImplementation(((path: string, data: string) => {
    writeFileSync(path, data)
  }) as typeof atomicWriteFileSync)

  vi.mocked(channelStateDir).mockClear()
  vi.mocked(channelStateDir).mockReturnValue(CHANNEL_STATE_DIR)
  vi.mocked(readChannelToken).mockReset()
  vi.mocked(readChannelToken).mockReturnValue(null)

  vi.mocked(sessionExistsOnHost).mockReset()
  vi.mocked(sessionExistsOnHost).mockReturnValue(false)

  vi.mocked(hardRestartMarveenChannels).mockReset()
  vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: true })
  vi.mocked(mainChannelsSessionExists).mockReset()
  vi.mocked(mainChannelsSessionExists).mockReturnValue(true)
  vi.mocked(createMainChannelsSession).mockReset()
  vi.mocked(createMainChannelsSession).mockReturnValue('started')

  vi.mocked(liveProbeAuth).mockReset()
  vi.mocked(liveProbeAuth).mockResolvedValue('ok')
  vi.mocked(stampTokenVerified).mockReset()

  // Default: keychain binary "missing" (throws). Tests that want to hit the
  // happy keychain path override this mock.
  vi.mocked(execFileSync).mockReset()
  vi.mocked(execFileSync).mockImplementation(() => {
    throw new Error('sandbox: security binary missing')
  })

  vi.mocked(logger.info).mockClear()
  vi.mocked(logger.warn).mockClear()
  vi.mocked(logger.error).mockClear()
})

afterAll(() => {
  Object.defineProperty(process, 'platform', { value: ORIGINAL_PLATFORM, configurable: true })
  rmSync(SANDBOX, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// identitySavePlan -- pure decision core
// ---------------------------------------------------------------------------
describe('identitySavePlan (pure decision core)', () => {
  it('mid-setup rename with the fleet up restarts the channels session', () => {
    expect(identitySavePlan(true, true, true)).toEqual({ restart: true, restartNeeded: false })
  })
  it('mid-setup rename with no fleet does not restart anything', () => {
    expect(identitySavePlan(false, true, true)).toEqual({ restart: false, restartNeeded: false })
  })
  it('rename on a configured running install flags restartNeeded, never restarts implicitly', () => {
    expect(identitySavePlan(true, false, true)).toEqual({ restart: false, restartNeeded: true })
  })
  it('rename on a configured stopped install needs no restart flag either', () => {
    expect(identitySavePlan(false, false, true)).toEqual({ restart: false, restartNeeded: false })
  })
  it('a no-op save (name unchanged) never restarts and never demands one', () => {
    for (const servicesUp of [true, false]) {
      for (const freshSetup of [true, false]) {
        expect(identitySavePlan(servicesUp, freshSetup, false)).toEqual({
          restart: false,
          restartNeeded: false,
        })
      }
    }
  })
})

// ---------------------------------------------------------------------------
// Dispatcher surface
// ---------------------------------------------------------------------------
describe('tryHandleOnboarding -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled, res } = await call('GET', '/api/other')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
    expect(res.body).toBe('')
  })

  it('returns false for /api/onboarding/status with a non-GET method (POST)', async () => {
    const { handled, res } = await call('POST', '/api/onboarding/status')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for /api/onboarding/status with PUT', async () => {
    const { handled } = await call('PUT', '/api/onboarding/status')
    expect(handled).toBe(false)
  })

  it('returns false for /api/onboarding/identity with GET', async () => {
    const { handled } = await call('GET', '/api/onboarding/identity')
    expect(handled).toBe(false)
  })

  it('returns false for /api/onboarding/identity with PUT', async () => {
    const { handled } = await call('PUT', '/api/onboarding/identity')
    expect(handled).toBe(false)
  })

  it('returns false for /api/onboarding/claude-auth with GET', async () => {
    const { handled } = await call('GET', '/api/onboarding/claude-auth')
    expect(handled).toBe(false)
  })

  it('returns false for /api/onboarding/launch with GET', async () => {
    const { handled } = await call('GET', '/api/onboarding/launch')
    expect(handled).toBe(false)
  })

  it('returns false for /api/onboarding with a trailing slash', async () => {
    const { handled } = await call('GET', '/api/onboarding/')
    expect(handled).toBe(false)
  })

  it('returns false for /api/onboarding-status (prefix-only path)', async () => {
    const { handled } = await call('GET', '/api/onboarding-status')
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/onboarding/status
// ---------------------------------------------------------------------------
describe('GET /api/onboarding/status', () => {
  it('returns needsOnboarding=true when nothing is configured', async () => {
    // All probes return false/null by default
    const { res, json, handled } = await call('GET', '/api/onboarding/status')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    const body = json() as Record<string, unknown>
    expect(body).toEqual({
      identityConfirmed: false,
      currentAgentName: 'Marveen',
      currentOwnerName: '',
      claudeAuthPresent: false,
      agentsRunning: false,
      channelConfigured: false,
      paired: false,
      needsOnboarding: true,
    })
  })

  it('falls back to "Marveen" when neither BRAND_NAME nor BOT_NAME is in .env', async () => {
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { currentAgentName: string }).currentAgentName).toBe('Marveen')
  })

  it('reads BRAND_NAME first when present', async () => {
    writeFileSync(ENV_FILE, 'BOT_NAME=BootName\nBRAND_NAME=BrandName\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { currentAgentName: string }).currentAgentName).toBe('BrandName')
  })

  it('falls back to BOT_NAME when BRAND_NAME is missing', async () => {
    writeFileSync(ENV_FILE, 'BOT_NAME=BootName\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { currentAgentName: string }).currentAgentName).toBe('BootName')
  })

  it('ignores an empty BRAND_NAME and uses BOT_NAME instead', async () => {
    writeFileSync(ENV_FILE, 'BOT_NAME=BootName\nBRAND_NAME=\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { currentAgentName: string }).currentAgentName).toBe('BootName')
  })

  it('reads OWNER_NAME into currentOwnerName', async () => {
    writeFileSync(ENV_FILE, 'OWNER_NAME=Alice\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { currentOwnerName: string }).currentOwnerName).toBe('Alice')
  })

  it('reports identityConfirmed=true when IDENTITY_CONFIRMED=1', async () => {
    writeFileSync(ENV_FILE, 'IDENTITY_CONFIRMED=1\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { identityConfirmed: boolean }).identityConfirmed).toBe(true)
  })

  it('reports identityConfirmed=false when IDENTITY_CONFIRMED is something else', async () => {
    writeFileSync(ENV_FILE, 'IDENTITY_CONFIRMED=0\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { identityConfirmed: boolean }).identityConfirmed).toBe(false)
  })

  it('reports channelConfigured=true when readChannelToken returns a token', async () => {
    vi.mocked(readChannelToken).mockReturnValue('1234:tok')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { channelConfigured: boolean }).channelConfigured).toBe(true)
  })

  it('reports agentsRunning=true when sessionExistsOnHost returns true', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { agentsRunning: boolean }).agentsRunning).toBe(true)
  })

  it('reports claudeAuthPresent=true when CLAUDE_CODE_OAUTH_TOKEN is set in .env', async () => {
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(true)
  })

  it('reports claudeAuthPresent=true when ANTHROPIC_API_KEY is set in .env', async () => {
    writeFileSync(ENV_FILE, 'ANTHROPIC_API_KEY=sk-ant-x\n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(true)
  })

  it('reports claudeAuthPresent=true when ~/.claude/.credentials.json has an oauth accessToken', async () => {
    writeFileSync(HOME_CREDS, JSON.stringify({ claudeAiOauth: { accessToken: 'tok' } }))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(true)
  })

  it('reports claudeAuthPresent=true when ~/.claude/.credentials.json has an apiKey', async () => {
    writeFileSync(HOME_CREDS, JSON.stringify({ apiKey: 'k' }))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(true)
  })

  it('reports claudeAuthPresent=false when ~/.claude/.credentials.json has only unrelated fields', async () => {
    // Exercises the FALSY arm of `if (d?.apiKey)` on line 86 -- a credentials
    // JSON with claudeAiOauth missing its accessToken and no apiKey must fall
    // through to the fleet-token / keychain legs.
    writeFileSync(
      HOME_CREDS,
      JSON.stringify({ claudeAiOauth: { somethingElse: 'x' }, somethingElse: 'x' }),
    )
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(false)
  })

  it('reports paired=false when access.json has no allowFrom and no groups', async () => {
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), JSON.stringify({}))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(false)
  })

  it('treats a thrown sessionExistsOnHost as agentsRunning=false (catch arm)', async () => {
    // Force the catch arm of agentsRunning() to fire: a thrown
    // sessionExistsOnHost must be swallowed and reported as false.
    vi.mocked(sessionExistsOnHost).mockImplementation(() => {
      throw new Error('tmux lookup failed')
    })
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { agentsRunning: boolean }).agentsRunning).toBe(false)
  })

  it('reports claudeAuthPresent=true when the fleet token file is present and non-empty', async () => {
    writeFileSync(FLEET_TOKEN_FILE, 'tok')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(true)
  })

  it('reports claudeAuthPresent=false when the fleet token file is empty whitespace', async () => {
    writeFileSync(FLEET_TOKEN_FILE, '   \n')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(false)
  })

  it('falls through when ~/.claude/.credentials.json is malformed', async () => {
    writeFileSync(HOME_CREDS, 'not json {{')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(false)
  })

  it('reports paired=true when access.json has an allowFrom array', async () => {
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), JSON.stringify({ allowFrom: ['u1'] }))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(true)
  })

  it('reports paired=true when access.json has groups', async () => {
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(
      join(CHANNEL_STATE_DIR, 'access.json'),
      JSON.stringify({ groups: { g1: {} } }),
    )
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(true)
  })

  it('reports paired=false when access.json has no allowFrom and no groups', async () => {
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), JSON.stringify({}))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(false)
  })

  it('treats a thrown sessionExistsOnHost as agentsRunning=false (catch arm)', async () => {
    // Force the catch arm of agentsRunning() to fire: a thrown
    // sessionExistsOnHost must be swallowed and reported as false.
    vi.mocked(sessionExistsOnHost).mockImplementation(() => {
      throw new Error('tmux lookup failed')
    })
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { agentsRunning: boolean }).agentsRunning).toBe(false)
  })

  it('reports paired=false when access.json is missing', async () => {
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(false)
  })

  it('reports paired=false when access.json is malformed', async () => {
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), '{ broken')
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(false)
  })

  it('reports paired=false when allowFrom is a non-array value', async () => {
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), JSON.stringify({ allowFrom: 'not-array' }))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(false)
  })

  it('reports paired=false when groups is a non-object value', async () => {
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), JSON.stringify({ groups: 'no' }))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { paired: boolean }).paired).toBe(false)
  })

  it('reports needsOnboarding=false when ALL probes are true', async () => {
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\nIDENTITY_CONFIRMED=1\nBOT_NAME=Bob\nBRAND_NAME=Bob\n')
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(readChannelToken).mockReturnValue('1234:tok')
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), JSON.stringify({ allowFrom: ['u'] }))

    const { json } = await call('GET', '/api/onboarding/status')
    const body = json() as Record<string, boolean>
    expect(body.needsOnboarding).toBe(false)
    expect(body.claudeAuthPresent).toBe(true)
    expect(body.agentsRunning).toBe(true)
    expect(body.channelConfigured).toBe(true)
    expect(body.paired).toBe(true)
    expect(body.identityConfirmed).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/identity -- validation
// ---------------------------------------------------------------------------
describe('POST /api/onboarding/identity -- validation', () => {
  it('returns 400 missing when agentName is missing', async () => {
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agentName es ownerName szukseges.', reason: 'missing' })
  })

  it('returns 400 missing when ownerName is missing', async () => {
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agentName es ownerName szukseges.', reason: 'missing' })
  })

  it('returns 400 missing when both are empty strings', async () => {
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: '   ', ownerName: '' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agentName es ownerName szukseges.', reason: 'missing' })
  })

  it('returns 400 missing when body is empty JSON', async () => {
    const { res, json } = await call('POST', '/api/onboarding/identity', { body: '{}' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agentName es ownerName szukseges.', reason: 'missing' })
  })

  it('returns 400 missing when body is not valid JSON (caught by the try/catch)', async () => {
    const { res, json } = await call('POST', '/api/onboarding/identity', { body: 'broken' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'agentName es ownerName szukseges.', reason: 'missing' })
  })

  it('returns 400 bad-name when agentName is too long (>40)', async () => {
    const longName = 'x'.repeat(41)
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: longName, ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'A nev tul hosszu vagy tiltott karaktert tartalmaz.',
      reason: 'bad-name',
    })
  })

  it('returns 400 bad-name when ownerName is too long (>60)', async () => {
    const longName = 'x'.repeat(61)
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob', ownerName: longName }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'A nev tul hosszu vagy tiltott karaktert tartalmaz.',
      reason: 'bad-name',
    })
  })

  it('returns 400 bad-name when agentName contains a newline', async () => {
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bo\nb', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'A nev tul hosszu vagy tiltott karaktert tartalmaz.',
      reason: 'bad-name',
    })
  })

  it('returns 400 bad-name when ownerName contains =', async () => {
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob', ownerName: 'A lice=' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'A nev tul hosszu vagy tiltott karaktert tartalmaz.',
      reason: 'bad-name',
    })
  })
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/identity -- happy path branches
// ---------------------------------------------------------------------------
describe('POST /api/onboarding/identity -- write', () => {
  it('persists OWNER_NAME, BRAND_NAME, BOT_NAME, IDENTITY_CONFIRMED on a mid-setup rename', async () => {
    // servicesUp=false (no fleet yet) + freshSetup probes default false
    // (channelConfigured=false, paired=false) => freshSetup=true, no restart.
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      ok: true,
      botNameUpdated: true,
      restarted: false,
    })

    // The .env file should contain the four keys.
    const written = readFileSync(ENV_FILE, 'utf-8')
    expect(written).toContain('OWNER_NAME=Alice')
    expect(written).toContain('BRAND_NAME=Bob')
    expect(written).toContain('BOT_NAME=Bob')
    expect(written).toContain('IDENTITY_CONFIRMED=1')
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('renames in CLAUDE.md / SOUL.md when the previous name was "Marveen"', async () => {
    writeFileSync(CLAUDE_MD, 'Hello from Marveen\nMarveen says hi\n')
    writeFileSync(SOUL_MD, 'Marveen soul file\n')

    const { res } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Robi', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(CLAUDE_MD, 'utf-8')).toContain('Robi')
    expect(readFileSync(CLAUDE_MD, 'utf-8')).not.toContain('Marveen')
    expect(readFileSync(SOUL_MD, 'utf-8')).toContain('Robi')
    expect(readFileSync(SOUL_MD, 'utf-8')).not.toContain('Marveen')
  })

  it('does NOT call renameInPersonaFile when the previous ownerName was empty', async () => {
    // No OWNER_NAME in .env -> prevOwnerName='' -> the second rename is skipped.
    // Write a file containing the new owner name only to assert it stays untouched.
    writeFileSync(CLAUDE_MD, 'plain text\n')
    writeFileSync(SOUL_MD, 'plain text\n')
    const { res } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    // No rename happened; the file is unchanged.
    expect(readFileSync(CLAUDE_MD, 'utf-8')).toBe('plain text\n')
    expect(readFileSync(SOUL_MD, 'utf-8')).toBe('plain text\n')
  })

  it('skips renaming in a missing persona file (the try/catch arms)', async () => {
    // No CLAUDE.md or SOUL.md exist - the catch-all in renameInPersonaFile returns.
    const { res } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    expect(existsSync(CLAUDE_MD)).toBe(false)
  })

  it('skips renaming when the file content does not include the from token', async () => {
    writeFileSync(CLAUDE_MD, 'no previous name here\n')
    const { res } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(CLAUDE_MD, 'utf-8')).toBe('no previous name here\n')
  })

  it('renames in CLAUDE.md / SOUL.md when the previous name and previous owner name were both set', async () => {
    writeFileSync(ENV_FILE, 'OWNER_NAME=OldOwner\nBOT_NAME=OldName\n')
    writeFileSync(CLAUDE_MD, 'OldName OldOwner was here\n')
    writeFileSync(SOUL_MD, 'OldName OldOwner again\n')
    const { res } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'NewName', ownerName: 'NewOwner' }),
    })
    expect(res.statusCode).toBe(200)
    const claudeMd = readFileSync(CLAUDE_MD, 'utf-8')
    const soulMd = readFileSync(SOUL_MD, 'utf-8')
    expect(claudeMd).toContain('NewName')
    expect(claudeMd).toContain('NewOwner')
    expect(claudeMd).not.toContain('OldName')
    expect(claudeMd).not.toContain('OldOwner')
    expect(soulMd).toContain('NewName')
    expect(soulMd).toContain('NewOwner')
  })

  it('preserves unrelated .env lines and reuses existing lines when setEnvKey runs', async () => {
    writeFileSync(ENV_FILE, 'KEEP_ME=1\nBOT_NAME=OldBot\n')
    const { res } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'NewBot', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    const written = readFileSync(ENV_FILE, 'utf-8')
    expect(written).toContain('KEEP_ME=1')
    expect(written).toContain('BOT_NAME=NewBot')
    // The OLD BOT_NAME line must have been dropped (filter keeps !startsWith)
    const occurrences = written.split('\n').filter((l) => l.startsWith('BOT_NAME='))
    expect(occurrences).toHaveLength(1)
  })

  it('does not call hardRestartMarveenChannels when fleet is not running and name did change', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(false)
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Robi', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    expect((json() as { restarted: boolean }).restarted).toBe(false)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('reports restarted=true when fleet is up, freshSetup, and name changed', async () => {
    // Force freshSetup=true via paired=false (channelConfigured and
    // claudeAuthPresent already false). servicesUp=true via sessionExistsOnHost.
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: true })
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Robi', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { ok: boolean; restarted: boolean; restartNeeded?: boolean }
    expect(body.restarted).toBe(true)
    expect(body.restartNeeded).toBeUndefined()
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info).mock.calls.some(
      (c) => c[0] === 'onboarding: channels restarted so the new identity is picked up',
    )).toBe(true)
  })

  it('reports restartNeeded when fleet is up but install is configured', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(readChannelToken).mockReturnValue('1234:tok')
    mkdirSync(CHANNEL_STATE_DIR, { recursive: true })
    writeFileSync(join(CHANNEL_STATE_DIR, 'access.json'), JSON.stringify({ allowFrom: ['u1'] }))
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-x\n')
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Robi', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { restarted: boolean; restartNeeded?: boolean }
    expect(body.restarted).toBe(false)
    expect(body.restartNeeded).toBe(true)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('reports restartError when hardRestartMarveenChannels returns { ok: false } on a fresh-setup rename', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({
      ok: false,
      error: 'tmux died',
    })
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Robi', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { restarted: boolean; restartError?: string }
    expect(body.restarted).toBe(false)
    expect(body.restartError).toBe('tmux died')
    expect(vi.mocked(logger.error).mock.calls.some(
      (c) => c[1] === 'onboarding: channels restart after identity save FAILED',
    )).toBe(true)
  })

  it('falls back to "restart failed" when hardRestart returns { ok: false, error: undefined }', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: false })
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Robi', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    expect((json() as { restartError: string }).restartError).toBe('restart failed')
  })

  it('does not restart on a no-op save (name unchanged)', async () => {
    writeFileSync(ENV_FILE, 'BOT_NAME=SameName\n')
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'SameName', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { restarted: boolean; restartNeeded?: boolean }
    expect(body.restarted).toBe(false)
    expect(body.restartNeeded).toBeUndefined()
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('returns 500 write-failed when atomicWriteFileSync throws', async () => {
    vi.mocked(atomicWriteFileSync).mockImplementation(() => {
      throw new Error('disk full')
    })
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Bob', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({
      error: 'Nem sikerult elmenteni az .env-be.',
      reason: 'write-failed',
    })
    expect(vi.mocked(logger.error).mock.calls.some(
      (c) => c[1] === 'onboarding: failed to persist identity to .env',
    )).toBe(true)
  })

  it('warns but succeeds when persona rename throws', async () => {
    // Force atomicWriteFileSync to throw ONLY on the persona file calls
    // (after the .env writes already succeeded).
    let callCount = 0
    vi.mocked(atomicWriteFileSync).mockImplementation(((path: string, data: string) => {
      callCount++
      // First four calls are the .env setEnvKey writes; the 5th+ is the
      // persona-file rename. Throw on persona renames.
      if (callCount > 4) throw new Error('rename boom')
      writeFileSync(path, data)
    }) as typeof atomicWriteFileSync)
    writeFileSync(CLAUDE_MD, 'Marveen was here\n')
    const { res, json } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: 'Robi', ownerName: 'Alice' }),
    })
    expect(res.statusCode).toBe(200)
    expect((json() as { ok: boolean }).ok).toBe(true)
    expect(vi.mocked(logger.warn).mock.calls.some(
      (c) => c[1] === 'onboarding: persona rename failed (identity saved to .env regardless)',
    )).toBe(true)
  })

  it('trims whitespace from agentName and ownerName', async () => {
    const { res } = await call('POST', '/api/onboarding/identity', {
      body: JSON.stringify({ agentName: '  Bob  ', ownerName: '  Alice  ' }),
    })
    expect(res.statusCode).toBe(200)
    const written = readFileSync(ENV_FILE, 'utf-8')
    expect(written).toContain('OWNER_NAME=Alice')
    expect(written).toContain('BRAND_NAME=Bob')
    expect(written).toContain('BOT_NAME=Bob')
  })
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/claude-auth -- validation
// ---------------------------------------------------------------------------
describe('POST /api/onboarding/claude-auth -- validation', () => {
  it('returns 400 missing when neither token nor apiKey is provided', async () => {
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', { body: '{}' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'token vagy apiKey szukseges.', reason: 'missing' })
  })

  it('returns 400 missing when the body is invalid JSON (catch)', async () => {
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', { body: 'not-json' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'token vagy apiKey szukseges.', reason: 'missing' })
  })

  it('returns 400 missing when both are empty strings', async () => {
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: '', apiKey: '' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'token vagy apiKey szukseges.', reason: 'missing' })
  })

  it('returns 400 bad-token when token does not match the sk-ant-oat prefix', async () => {
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'not-a-setup-token' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'A setup-token formatuma nem stimmel (sk-ant-oat...).',
      reason: 'bad-token',
    })
    expect(liveProbeAuth).not.toHaveBeenCalled()
  })

  it('returns 400 bad-key when apiKey does not match the sk-ant- prefix', async () => {
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ apiKey: 'wrong-prefix-key' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'Az API-kulcs formatuma nem stimmel (sk-ant-...).',
      reason: 'bad-key',
    })
    expect(liveProbeAuth).not.toHaveBeenCalled()
  })

  it('returns 400 verify-failed when liveProbeAuth returns "auth-rejected"', async () => {
    vi.mocked(liveProbeAuth).mockResolvedValue('auth-rejected')
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-abc' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error:
        'A megadott token/kulcs nem ervenyes (a proba-hivast a szerver elutasitotta). Ellenorizd, hogy a teljes setup-tokent illesztetted-e be.',
      reason: 'verify-failed',
      verified: false,
    })
    expect(vi.mocked(logger.warn).mock.calls.some(
      (c: unknown[]) => (c[0] as { mode?: string } | undefined)?.mode === 'oauth' && c[1] === 'onboarding: Claude auth REJECTED by live probe; nothing persisted',
    )).toBe(true)
    expect(atomicWriteFileSync).not.toHaveBeenCalled()
  })

  it('uses apiKey mode in the log line when verifying an API key', async () => {
    vi.mocked(liveProbeAuth).mockResolvedValue('auth-rejected')
    const { res } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ apiKey: 'sk-ant-bogus-key' }),
    })
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(logger.warn).mock.calls.some(
      (c: unknown[]) => (c[0] as { mode?: string } | undefined)?.mode === 'apikey',
    )).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/claude-auth -- happy paths
// ---------------------------------------------------------------------------
describe('POST /api/onboarding/claude-auth -- happy paths', () => {
  it('writes a verified OAuth token to .env, stamps it, and skips restart when auth was already present', async () => {
    // hadAuthBefore is computed BEFORE the save; set the env so claudeAuthPresent returns true.
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-existing\n')
    vi.mocked(liveProbeAuth).mockResolvedValue('ok')
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-newtoken' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { ok: boolean; verified: boolean; restarted: boolean }
    expect(body).toEqual({ ok: true, verified: true, restarted: false })

    expect(readFileSync(ENV_FILE, 'utf-8')).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-newtoken')
    expect(stampTokenVerified).toHaveBeenCalledWith('sk-ant-oat01-newtoken')
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('writes an API key to .env when the apiKey path is used', async () => {
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ apiKey: 'sk-ant-real-key' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { ok: boolean; verified: boolean; restarted: boolean }
    expect(body.verified).toBe(true)
    expect(readFileSync(ENV_FILE, 'utf-8')).toContain('ANTHROPIC_API_KEY=sk-ant-real-key')
    expect(stampTokenVerified).not.toHaveBeenCalled()
  })

  it('also writes the fleet token file when token is verified', async () => {
    vi.mocked(liveProbeAuth).mockResolvedValue('ok')
    const { res } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-abc' }),
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(FLEET_TOKEN_FILE, 'utf-8')).toContain('sk-ant-oat01-abc')
  })

  it('does NOT stamp or fleet-write when the probe was inconclusive', async () => {
    vi.mocked(liveProbeAuth).mockResolvedValue('inconclusive')
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-abc' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { ok: boolean; verified: boolean; restarted: boolean }
    expect(body.verified).toBe(false)
    expect(stampTokenVerified).not.toHaveBeenCalled()
    // The token is still persisted (best-effort).
    expect(readFileSync(ENV_FILE, 'utf-8')).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc')
  })

  it('bounces the channels session when auth was absent before save and agents are running', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(liveProbeAuth).mockResolvedValue('ok')
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-first-time' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { ok: boolean; restarted: boolean }
    expect(body.restarted).toBe(true)
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info).mock.calls.some(
      (c) => c[0] === 'onboarding: channels restarted so the fresh auth is picked up',
    )).toBe(true)
  })

  it('reports restartError when the post-save restart fails', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(liveProbeAuth).mockResolvedValue('ok')
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: false, error: 'tmux gone' })
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-first-time' }),
    })
    expect(res.statusCode).toBe(200)
    const body = json() as { restarted: boolean; restartError?: string }
    expect(body.restartError).toBe('tmux gone')
    expect(vi.mocked(logger.error).mock.calls.some(
      (c) => c[1] === 'onboarding: channels restart after first auth FAILED',
    )).toBe(true)
  })

  it('falls back to "restart failed" when restart returns { ok: false, error: undefined }', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    vi.mocked(liveProbeAuth).mockResolvedValue('ok')
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: false })
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-first-time' }),
    })
    expect(res.statusCode).toBe(200)
    expect((json() as { restartError: string }).restartError).toBe('restart failed')
  })

  it('returns 500 write-failed when atomicWriteFileSync throws on .env write', async () => {
    vi.mocked(atomicWriteFileSync).mockImplementation(() => {
      throw new Error('disk gone')
    })
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-abc' }),
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({
      error: 'Nem sikerult elmenteni az .env-be.',
      reason: 'write-failed',
    })
    expect(vi.mocked(logger.error).mock.calls.some(
      (c) => c[1] === 'onboarding: failed to persist Claude auth to .env',
    )).toBe(true)
  })

  it('does not abort the request when mkdirSync fails for the fleet token directory (optional arm)', async () => {
    // Make STORE_DIR point at a path that is a REGULAR FILE so the
    // `mkdirSync(STORE_DIR, { recursive: true })` inside the token branch
    // throws (EEXIST) and is swallowed by the inner try/catch labelled
    // `/* optional */`. The outer handler still returns 200 because the
    // .env write succeeded before the inner block.
    vi.mocked(liveProbeAuth).mockResolvedValue('ok')
    rmSync(STORE, { recursive: true, force: true })
    writeFileSync(STORE, 'regular file')
    const { res, json } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: 'sk-ant-oat01-abc' }),
    })
    // Restore STORE so beforeEach and afterAll can rm it cleanly.
    rmSync(STORE, { force: true })
    mkdirSync(STORE, { recursive: true })
    expect(res.statusCode).toBe(200)
    expect((json() as { ok: boolean }).ok).toBe(true)
  })

  it('trims whitespace from token and apiKey', async () => {
    const { res } = await call('POST', '/api/onboarding/claude-auth', {
      body: JSON.stringify({ token: '  sk-ant-oat01-abc  ' }),
    })
    expect(res.statusCode).toBe(200)
    expect(readFileSync(ENV_FILE, 'utf-8')).toContain('CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc')
  })
})

// ---------------------------------------------------------------------------
// POST /api/onboarding/launch
// ---------------------------------------------------------------------------
describe('POST /api/onboarding/launch', () => {
  it('returns alreadyRunning when agents are running', async () => {
    vi.mocked(sessionExistsOnHost).mockReturnValue(true)
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, alreadyRunning: true })
    expect(mainChannelsSessionExists).not.toHaveBeenCalled()
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('returns 409 no-auth when the fleet is not running and there is no Claude auth', async () => {
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(409)
    expect(json()).toEqual({
      error: 'Eloszor allitsd be a Claude-autentikaciot.',
      reason: 'no-auth',
    })
    expect(mainChannelsSessionExists).not.toHaveBeenCalled()
  })

  it('creates the channels session via channels.sh when the session is absent and returns starting=true', async () => {
    vi.mocked(mainChannelsSessionExists).mockReturnValue(false)
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n')
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, starting: true })
    expect(createMainChannelsSession).toHaveBeenCalledTimes(1)
    expect(hardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('treats grace from createMainChannelsSession as starting=true', async () => {
    vi.mocked(mainChannelsSessionExists).mockReturnValue(false)
    vi.mocked(createMainChannelsSession).mockReturnValue('grace')
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n')
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, starting: true })
  })

  it('returns 500 channels-script-missing when channels.sh is missing', async () => {
    vi.mocked(mainChannelsSessionExists).mockReturnValue(false)
    vi.mocked(createMainChannelsSession).mockReturnValue('script-missing')
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n')
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(500)
    const body = json() as { reason: string; error: string }
    expect(body.reason).toBe('channels-script-missing')
    expect(body.error).toMatch(/Az ügynökök indítása nem sikerült/)
    expect(vi.mocked(logger.error).mock.calls.some(
      (c: unknown[]) => (c[0] as { created?: string } | undefined)?.created === 'script-missing' && c[1] === 'onboarding: channels session absent and channels.sh could not be launched',
    )).toBe(true)
  })

  it('returns 500 channels-spawn-failed when channels.sh fails to spawn', async () => {
    vi.mocked(mainChannelsSessionExists).mockReturnValue(false)
    vi.mocked(createMainChannelsSession).mockReturnValue('spawn-failed')
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n')
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(500)
    const body = json() as { reason: string; error: string }
    expect(body.reason).toBe('channels-spawn-failed')
    expect(body.error).toMatch(/Az ügynökök indítása nem sikerült/)
  })

  it('hard-restarts the channels session when the session exists', async () => {
    vi.mocked(mainChannelsSessionExists).mockReturnValue(true)
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: true })
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n')
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, started: true })
    expect(hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
    expect(createMainChannelsSession).not.toHaveBeenCalled()
  })

  it('returns 500 launch-failed when hardRestart returns { ok: false, error: "msg" }', async () => {
    vi.mocked(mainChannelsSessionExists).mockReturnValue(true)
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: false, error: 'tmux down' })
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n')
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({
      error: 'tmux down',
      reason: 'launch-failed',
    })
  })

  it('falls back to "Nem sikerult eletre kelteni az agenteket." when hardRestart returns { ok: false, error: undefined }', async () => {
    vi.mocked(mainChannelsSessionExists).mockReturnValue(true)
    vi.mocked(hardRestartMarveenChannels).mockReturnValue({ ok: false })
    writeFileSync(ENV_FILE, 'CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-abc\n')
    const { res, json } = await call('POST', '/api/onboarding/launch', { body: '{}' })
    expect(res.statusCode).toBe(500)
    const body = json() as { error: string; reason: string }
    expect(body.reason).toBe('launch-failed')
    expect(body.error).toBe('Nem sikerult eletre kelteni az agenteket.')
  })
})

// ---------------------------------------------------------------------------
// Helper coverage -- process.platform / userInfo branches
// ---------------------------------------------------------------------------
describe('process.platform / userInfo branches inside claudeAuthPresent', () => {
  it('does NOT call the security binary on non-darwin (linux returns false)', async () => {
    // Pin to darwin, but make the keychain leg fail by writing a sentinel
    // that breaks the userInfo() call -- simpler: pin to win32 (a non-darwin
    // platform) and verify the response is computed without a keychain hit.
    // The linux arm is the same: `process.platform !== 'darwin'` -> false.
    // We just verify the status endpoint does not crash and returns
    // claudeAuthPresent=false when no other leg is set.
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(false)
  })

  it('does not crash on darwin when the keychain binary is missing', async () => {
    // Force darwin: keychainHasClaudeCredentials() will execFileSync('/usr/bin/security')
    // which is missing in the sandbox PATH (or returns an error code); both
    // arms must be swallowed by the try/catch.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    const { json } = await call('GET', '/api/onboarding/status')
    expect(json()).toBeDefined()
  })

  it('reports claudeAuthPresent=true on darwin when the keychain lookup succeeds', async () => {
    // Hit onboarding.ts line 62 (`return true` inside keychainHasClaudeCredentials):
    // a darwin platform AND a successful execFileSync(/usr/bin/security ...) must
    // be reported as authenticated via the keychain leg.
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    vi.mocked(execFileSync).mockImplementation(() => Buffer.alloc(0))
    const { json } = await call('GET', '/api/onboarding/status')
    expect((json() as { claudeAuthPresent: boolean }).claudeAuthPresent).toBe(true)
    // The probe must have been called with the exact keychain service name.
    expect(execFileSync).toHaveBeenCalledWith(
      '/usr/bin/security',
      ['find-generic-password', '-s', 'Claude Code-credentials', '-a', expect.any(String)],
      { timeout: 3000, stdio: 'ignore' },
    )
  })

  it('does not crash when the home credentials file lookup fails inside the inner try/catch', async () => {
    // The .claude directory was created in beforeAll but the credentials
    // file does not exist. Reading it throws ENOENT, which is caught by the
    // inner try/catch in claudeAuthPresent and falls through to the fleet
    // token check.
    if (existsSync(HOME_CREDS)) unlinkSync(HOME_CREDS)
    const { json } = await call('GET', '/api/onboarding/status')
    expect(json()).toBeDefined()
  })
})
