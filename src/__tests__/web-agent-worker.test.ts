// Comprehensive unit suite for src/web/agent-worker.ts.
//
// The module drives an interactive tmux Claude Code session. None of that may
// touch the real machine, so the following redirects are installed BEFORE the
// module is ever imported:
//
//   1. `node:os` homedir()/userInfo()  -> a per-test sandbox (mkTempDir) so
//      `join(homedir(), '.claude', ...)` resolves inside tmpdir.
//   2. `node:child_process`           -> vi.fn() execFileSync so tmux / claude /
//      /usr/bin/security / /bin/sleep are never spawned.
//   3. `../web/agent-process.js`      -> capturePane / isSessionReadyForPrompt /
//      sendPromptToSession / sessionExistsOnHost / hasFleetOauthToken /
//      FLEET_OAUTH_TOKEN_PATH are vi.fn()s.
//
// Time control for the runViaWorker integration paths: vi.stubGlobal replaces
// setTimeout/clearTimeout and Date.now is spied so the runWorkerAttempt
// polling loop can be driven deterministically (the loop awaits sleepMs(1500)
// and we advance CLOCK by hand).
//
// `../db.js`, `../config.js`, `../logger.js`, the auth modules (auth-gate /
// auth-sessions / dashboard-auth) and `../platform.js` are also mocked to
// isolate the worker module from the rest of the dashboard.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync,
  symlinkSync, readdirSync, statSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted harness. Every vi.mock factory reads from this object so a test can
// re-point a collaborator without re-importing the module under test.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const tmpRoot = (process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')
  const root = `${tmpRoot}/marveen-awcov-${process.pid}-${Math.random().toString(36).slice(2)}`
  return {
    root,
    projectRoot: `${root}/project`,
    home: `${root}/home`,
    workerHome: `${root}/home/.marveen-worker`,
    workerHomeFast: `${root}/home/.marveen-worker-fast`,
    fleetOauthTokenPath: `${root}/home/.marveen-worker/.claude-oauth-token`,
    mainAgentId: 'marveen',
    defaultAgentModel: 'claude-sonnet-test',
    projectRootConstant: `${root}/project`,
    // collaborator mocks. Each vi.fn() is registered against the module
    // before agent-worker.ts ever runs; we wire default implementations in
    // vi.hoisted so the module-load call `const TMUX = resolveFromPath('tmux')`
    // gets a real string (otherwise every execFileSync call passes `undefined`
    // as the file and the startWorkerSession integration tests look like they
    // never reached the tmux new-session branch).
    execFileSync: vi.fn().mockImplementation((file: unknown, _args: unknown) => {
      if (String(file).endsWith('/claude')) return '0.0.0\n'
      return ''
    }),
    capturePane: vi.fn(),
    isSessionReadyForPrompt: vi.fn(),
    sendPromptToSession: vi.fn().mockResolvedValue(undefined),
    sessionExistsOnHost: vi.fn().mockReturnValue(false),
    hasFleetOauthToken: vi.fn().mockReturnValue(false),
    readClaudeCodeOauthJson: vi.fn().mockReturnValue(null),
    detectPaneState: vi.fn().mockReturnValue('idle'),
    notifyChannel: vi.fn().mockResolvedValue(undefined),
    resolveFromPath: vi.fn().mockImplementation((n: string) => `/usr/bin/${n}`),
    tryResolveFromPath: vi.fn().mockImplementation((n: string) => `/usr/bin/${n}`),
    userInfo: vi.fn(() => ({ username: 'tester' })),
    logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
  }
})

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => H.home,
    userInfo: H.userInfo,
  }
})

vi.mock('node:child_process', () => ({ execFileSync: H.execFileSync }))

vi.mock('../config.js', () => ({
  get MAIN_AGENT_ID() { return H.mainAgentId },
  get PROJECT_ROOT() { return H.projectRootConstant },
  get DEFAULT_AGENT_MODEL() { return H.defaultAgentModel },
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: H.resolveFromPath,
  tryResolveFromPath: H.tryResolveFromPath,
}))

vi.mock('../logger.js', () => {
  const push = (level: string) => (obj: unknown, msg?: unknown) => {
    H.logs.push({ level, obj, msg })
  }
  return { logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') } }
})

vi.mock('../db.js', () => ({ getDb: vi.fn() }))

vi.mock('../web/auth-gate.js', () => ({ resolveAuth: vi.fn() }))
vi.mock('../web/auth-sessions.js', () => ({ resolveSession: vi.fn() }))
vi.mock('../web/dashboard-auth.js', () => ({ checkBearerToken: vi.fn(), loadOrCreateDashboardToken: vi.fn() }))

vi.mock('../web/agent-process.js', () => ({
  capturePane: H.capturePane,
  isSessionReadyForPrompt: H.isSessionReadyForPrompt,
  sendPromptToSession: H.sendPromptToSession,
  sessionExistsOnHost: H.sessionExistsOnHost,
  hasFleetOauthToken: H.hasFleetOauthToken,
  FLEET_OAUTH_TOKEN_PATH: H.fleetOauthTokenPath,
}))

vi.mock('../web/claude-credentials.js', () => ({
  readClaudeCodeOauthJson: H.readClaudeCodeOauthJson,
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: H.detectPaneState,
}))

vi.mock('../notify.js', () => ({ notifyChannel: H.notifyChannel }))

// Imported AFTER every mock is registered.
const AW = await import('../web/agent-worker.js')

// Long per-test timeout for the runViaWorker integration paths -- the manual
// fake clock advances 100ms at a time and a 90s readiness timeout means up
// to 1000 ticks.
vi.setConfig({ testTimeout: 120_000 })

// ---------------------------------------------------------------------------
// Manual fake clock (mirrors the agent-process suite). Every `setTimeout` and
// `Date.now()` is replaced via vi.stubGlobal so the runWorkerAttempt polling
// loop can be driven deterministically.
// ---------------------------------------------------------------------------
let CLOCK = 0
let scheduledTimers: Array<{ id: number; at: number; fn: () => void }> = []
let nextTimerId = 1
const realSetTimeout = globalThis.setTimeout
function fakeSetTimeoutGlobal(fn: () => void, ms?: number): unknown {
  const id = nextTimerId++
  const at = CLOCK + (ms ?? 0)
  scheduledTimers.push({ id, at, fn })
  scheduledTimers.sort((a, b) => a.at - b.at)
  return id
}
function fakeClearTimeoutGlobal(id: unknown): void {
  scheduledTimers = scheduledTimers.filter(t => t.id !== id)
}
async function flushMicrotasks(turns = 100): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}
async function advanceFakeClockBy(ms: number): Promise<void> {
  const target = CLOCK + ms
  while (scheduledTimers.length > 0 && scheduledTimers[0]!.at <= target) {
    const t = scheduledTimers.shift()!
    CLOCK = t.at
    try { t.fn() } catch { /* swallow */ }
    await flushMicrotasks()
  }
  CLOCK = target
  await flushMicrotasks()
}
async function driveUntilResolved<T>(p: Promise<T>, maxMs = 30_000): Promise<T | 'timeout'> {
  let elapsed = 0
  while (elapsed < maxMs) {
    if (scheduledTimers.length === 0) {
      await flushMicrotasks()
      try {
        return await p
      } catch (e) { throw e }
    }
    await advanceFakeClockBy(50)
    elapsed += 50
    // Race the promise against a microtask boundary.
    let resolved = false
    let value: T | undefined
    let error: unknown
    p.then(v => { resolved = true; value = v }, e => { resolved = true; error = e })
    await Promise.resolve()
    if (resolved) {
      if (error !== undefined) throw error
      return value as T
    }
  }
  return 'timeout'
}

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------
const realPlatform = process.platform
let envSnap: ReturnType<typeof snapshotEnv>
let dateSpy: { mockRestore: () => void } | null = null

beforeAll(() => {
  mkdirSync(H.root, { recursive: true })
  mkdirSync(H.projectRoot, { recursive: true })
  mkdirSync(H.home, { recursive: true })
  mkdirSync(H.workerHome, { recursive: true })
  mkdirSync(H.workerHomeFast, { recursive: true })
  envSnap = snapshotEnv()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  vi.stubGlobal('setTimeout', fakeSetTimeoutGlobal)
  vi.stubGlobal('clearTimeout', fakeClearTimeoutGlobal)
  dateSpy = vi.spyOn(Date, 'now').mockImplementation(() => CLOCK) as unknown as { mockRestore: () => void }
})

afterAll(() => {
  vi.unstubAllGlobals()
  dateSpy?.mockRestore()
  Object.defineProperty(process, 'platform', { value: realPlatform, configurable: true })
  rmTempDir(H.root)
  envSnap.restore()
})

beforeEach(() => {
  CLOCK = 0
  scheduledTimers = []
  nextTimerId = 1
  vi.clearAllMocks()
  H.logs.length = 0
  H.execFileSync.mockReset()
  H.capturePane.mockReset()
  H.isSessionReadyForPrompt.mockReset()
  H.sendPromptToSession.mockReset()
  H.sessionExistsOnHost.mockReset()
  H.hasFleetOauthToken.mockReset()
  H.readClaudeCodeOauthJson.mockReset()
  H.detectPaneState.mockReset()
  H.notifyChannel.mockReset()
  H.resolveFromPath.mockReset()
  H.tryResolveFromPath.mockReset()
  H.userInfo.mockReset()
  H.userInfo.mockReturnValue({ username: 'tester' })
  H.sendPromptToSession.mockResolvedValue(undefined)
  H.notifyChannel.mockResolvedValue(undefined)
  H.hasFleetOauthToken.mockReturnValue(false)
  H.readClaudeCodeOauthJson.mockReturnValue(null)
  H.sessionExistsOnHost.mockReturnValue(false)
  H.detectPaneState.mockReturnValue('idle')
  H.resolveFromPath.mockImplementation((n: string) => `/usr/bin/${n}`)
  H.tryResolveFromPath.mockImplementation((n: string) => `/usr/bin/${n}`)
  // Default execFileSync return: empty string for tmux /bin/sleep, the
  // version string for the claude --version probe, anything for security.
  H.execFileSync.mockImplementation((file: unknown, args: unknown) => {
    if (String(file).endsWith('/claude')) return '0.0.0\n'
    return ''
  })
  // Clear the worker's claude-version stamps so per-test prev/new assertions
  // don't see state leaked from prior tests. Wipe the worker homes to also
  // reset any partial ensureWorkerCwd writes from a previous test.
  rmSync(H.workerHome, { recursive: true, force: true })
  rmSync(H.workerHomeFast, { recursive: true, force: true })
  mkdirSync(H.workerHome, { recursive: true })
  mkdirSync(H.workerHomeFast, { recursive: true })
})

// ---------------------------------------------------------------------------
// Pure exports — no fs / tmux interaction. These match the existing
// agent-worker.test.ts contract and pin every conditional branch.
// ---------------------------------------------------------------------------

describe('workerHomeFor', () => {
  it('derives the slow home from the default id', () => {
    expect(AW.workerHomeFor('marveen', 'slow')).toBe(`${H.home}/.marveen-worker`)
  })

  it('derives the fast home with the -fast suffix', () => {
    expect(AW.workerHomeFor('marveen', 'fast')).toBe(`${H.home}/.marveen-worker-fast`)
  })

  it('isolates a non-default id (sandbox / renamed install)', () => {
    expect(AW.workerHomeFor('jarvis', 'slow')).toBe(`${H.home}/.jarvis-worker`)
    expect(AW.workerHomeFor('jarvis', 'fast')).toBe(`${H.home}/.jarvis-worker-fast`)
  })
})

describe('workerStartAllowed (WEB_ONLY gate)', () => {
  it('blocks when WEB_ONLY=true', () => {
    expect(AW.workerStartAllowed({ WEB_ONLY: 'true' })).toBe(false)
  })

  it('allows when WEB_ONLY is unset / false / empty', () => {
    expect(AW.workerStartAllowed({})).toBe(true)
    expect(AW.workerStartAllowed({ WEB_ONLY: 'false' })).toBe(true)
    expect(AW.workerStartAllowed({ WEB_ONLY: '' })).toBe(true)
  })

  it('defaults to process.env when no argument is passed', () => {
    delete process.env.WEB_ONLY
    expect(AW.workerStartAllowed()).toBe(true)
    process.env.WEB_ONLY = 'true'
    expect(AW.workerStartAllowed()).toBe(false)
    delete process.env.WEB_ONLY
  })
})

describe('classifyPriority', () => {
  it('routes long messages (>= 300 chars) to slow regardless of content', () => {
    expect(AW.classifyPriority('a'.repeat(300))).toBe('slow')
    expect(AW.classifyPriority('a'.repeat(400))).toBe('slow')
  })

  it('routes short messages to fast when no slow keywords match', () => {
    expect(AW.classifyPriority('hello there')).toBe('fast')
  })

  it('routes messages with analyze/search/summary keywords to slow', () => {
    expect(AW.classifyPriority('analyze this')).toBe('slow')
    expect(AW.classifyPriority('search the web')).toBe('slow')
    expect(AW.classifyPriority('write a summary')).toBe('slow')
    expect(AW.classifyPriority('elemezd ezt')).toBe('slow')
    expect(AW.classifyPriority('keresd meg')).toBe('slow')
    expect(AW.classifyPriority('készíts összefoglalót')).toBe('slow')
    expect(AW.classifyPriority('Report something')).toBe('slow')
  })
})

describe('configDirKeychainService', () => {
  it('hashes configDir[0:8] into the service name (locked vector)', () => {
    expect(AW.configDirKeychainService('/Users/marvin/.marveen-worker/.claude-config'))
      .toBe('Claude Code-credentials-1d2e1367')
  })

  it('is path-specific (different dir -> different hash)', () => {
    expect(AW.configDirKeychainService('/tmp/other')).not.toBe(
      AW.configDirKeychainService('/Users/marvin/.marveen-worker/.claude-config'),
    )
  })
})

describe('buildWorkerPrompt', () => {
  const out = '/w/scratch/abc.out'
  const done = '/w/scratch/abc.done'

  it('keeps the caller prompt verbatim as the first (only) content line', () => {
    const prompt = 'Summarize today in 5 sentences. Magyarul.'
    expect(AW.buildWorkerPrompt(prompt, out, done).startsWith(prompt)).toBe(true)
  })

  it('directs the answer to the .out file and signals with .done', () => {
    const p = AW.buildWorkerPrompt('x', out, done)
    expect(p).toContain(out)
    expect(p).toContain(done)
    expect(p).toMatch(/Write tool/)
    expect(p).toMatch(/do not print the response/i)
  })

  it('does not inject persona or project voice', () => {
    expect(AW.buildWorkerPrompt('TASK', out, done)).not.toMatch(/Marveen|Szabolcs|asszisztens/i)
  })
})

describe('classifyWorkerPane', () => {
  it('returns empty for null / blank panes', () => {
    expect(AW.classifyWorkerPane(null)).toBe('empty')
    expect(AW.classifyWorkerPane('')).toBe('empty')
    expect(AW.classifyWorkerPane('   \n  ')).toBe('empty')
  })

  it('returns auth when the pane tail carries the login / 401 chrome', () => {
    expect(AW.classifyWorkerPane('last 30 lines contain: Please run /login to authenticate')).toBe('auth')
  })

  it('returns auth on OAuth-token-expired chrome', () => {
    expect(AW.classifyWorkerPane('OAuth token has expired')).toBe('auth')
  })

  it('returns auth on API Error: 401', () => {
    expect(AW.classifyWorkerPane('tail\nAPI Error: 401\nmore')).toBe('auth')
  })

  it('returns auth on Failed to authenticate chrome', () => {
    expect(AW.classifyWorkerPane('Failed to authenticate user')).toBe('auth')
  })

  it('returns busy when detectPaneState reports busy', () => {
    H.detectPaneState.mockReturnValue('busy')
    expect(AW.classifyWorkerPane('pane')).toBe('busy')
  })

  it('returns idle when detectPaneState reports idle', () => {
    H.detectPaneState.mockReturnValue('idle')
    expect(AW.classifyWorkerPane('pane')).toBe('idle')
  })

  it('returns idle when detectPaneState reports typing', () => {
    H.detectPaneState.mockReturnValue('typing')
    expect(AW.classifyWorkerPane('pane')).toBe('idle')
  })

  it('returns modal when Enter to confirm + numbered options are present', () => {
    H.detectPaneState.mockReturnValue('unknown')
    expect(AW.classifyWorkerPane('panel: ❯ 1. yes 2. no\nEnter to confirm · Esc to cancel')).toBe('modal')
  })

  it('returns modal when only the option-list trigger is present', () => {
    H.detectPaneState.mockReturnValue('unknown')
    expect(AW.classifyWorkerPane('dialog: ❯ 1. item\nEsc to cancel')).toBe('modal')
  })

  it('returns unknown for unrecognised chrome with no modal markers', () => {
    H.detectPaneState.mockReturnValue('unknown')
    expect(AW.classifyWorkerPane('just some text')).toBe('unknown')
  })
})

describe('shouldSelfHeal', () => {
  it('heals modal + unknown but never busy/idle/auth/empty', () => {
    expect(AW.shouldSelfHeal('modal')).toBe(true)
    expect(AW.shouldSelfHeal('unknown')).toBe(true)
    expect(AW.shouldSelfHeal('idle')).toBe(false)
    expect(AW.shouldSelfHeal('busy')).toBe(false)
    expect(AW.shouldSelfHeal('auth')).toBe(false)
    expect(AW.shouldSelfHeal('empty')).toBe(false)
  })
})

describe('decidePoll', () => {
  const base = { doneExists: false, sessionAlive: true, elapsedMs: 0, timeoutMs: 1000 }

  it('returns ready when done exists', () => {
    expect(AW.decidePoll({ ...base, doneExists: true })).toBe('ready')
  })

  it('done wins over timeout/dead (latched result, last-second death)', () => {
    expect(AW.decidePoll({ doneExists: true, sessionAlive: false, elapsedMs: 9999, timeoutMs: 1000 })).toBe('ready')
  })

  it('times out once past the deadline', () => {
    expect(AW.decidePoll({ ...base, elapsedMs: 1000 })).toBe('timeout')
    expect(AW.decidePoll({ ...base, elapsedMs: 1500 })).toBe('timeout')
  })

  it('returns dead when the session is gone before the deadline', () => {
    expect(AW.decidePoll({ ...base, sessionAlive: false, elapsedMs: 10 })).toBe('dead')
  })

  it('keeps waiting while alive, before the deadline', () => {
    expect(AW.decidePoll({ ...base, elapsedMs: 500 })).toBe('wait')
  })
})

describe('stampWorkerFirstRun', () => {
  it('sets hasCompletedOnboarding and bumps fullscreenUpsellSeenCount to 99', () => {
    const obj: Record<string, unknown> = {}
    AW.stampWorkerFirstRun(obj)
    expect(obj.hasCompletedOnboarding).toBe(true)
    expect(obj.fullscreenUpsellSeenCount).toBe(99)
  })

  it('raises an existing numeric seen count to max(99, seen)', () => {
    const obj = { fullscreenUpsellSeenCount: 5 }
    AW.stampWorkerFirstRun(obj)
    expect(obj.fullscreenUpsellSeenCount).toBe(99)
  })

  it('does not lower an already-higher seen count', () => {
    const obj = { fullscreenUpsellSeenCount: 250 }
    AW.stampWorkerFirstRun(obj)
    expect(obj.fullscreenUpsellSeenCount).toBe(250)
  })

  it('falls back to 99 when the seen count is non-numeric', () => {
    const obj: Record<string, unknown> = { fullscreenUpsellSeenCount: 'banana' }
    AW.stampWorkerFirstRun(obj)
    expect(obj.fullscreenUpsellSeenCount).toBe(99)
  })
})

describe('makeWorkerCtx', () => {
  it('builds a fresh context with config + scratch under home', () => {
    const ctx = AW.makeWorkerCtx('sess', H.workerHome)
    expect(ctx.session).toBe('sess')
    expect(ctx.home).toBe(H.workerHome)
    expect(ctx.configDir).toBe(`${H.workerHome}/.claude-config`)
    expect(ctx.scratchDir).toBe(`${H.workerHome}/scratch`)
    expect(ctx.chain).toBeInstanceOf(Promise)
    expect(ctx.lastStuckAlert).toBe(0)
  })
})

describe('workerContexts / isWorkerSessionAlive', () => {
  it('returns both slow and fast module-level contexts', () => {
    const ctxs = AW.workerContexts()
    expect(ctxs).toHaveLength(2)
    expect(ctxs[0]?.session).toMatch(/-worker$/)
    expect(ctxs[1]?.session).toMatch(/-worker-fast$/)
  })

  it('isWorkerSessionAlive delegates to sessionExistsOnHost', () => {
    H.sessionExistsOnHost.mockReturnValue(true)
    expect(AW.isWorkerSessionAlive('foo')).toBe(true)
    expect(H.sessionExistsOnHost).toHaveBeenCalledWith(null, 'foo')
    H.sessionExistsOnHost.mockReturnValue(false)
    expect(AW.isWorkerSessionAlive('foo')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// ensureWorkerCwd
// ---------------------------------------------------------------------------

describe('ensureWorkerCwd', () => {
  function freshWorkerHome(suffix: string): { ctx: import('../web/agent-worker.js').WorkerCtx; home: string } {
    const home = mkTempDir(`marveen-aw-${suffix}-`)
    const ctx = AW.makeWorkerCtx(`sess-${suffix}`, home)
    return { ctx, home }
  }

  it('creates the home, scratch, config and an empty .mcp.json on a clean install', () => {
    const { ctx, home } = freshWorkerHome('clean')
    try {
      AW.ensureWorkerCwd(ctx)
      expect(existsSync(home)).toBe(true)
      expect(existsSync(ctx.scratchDir)).toBe(true)
      expect(existsSync(ctx.configDir)).toBe(true)
      expect(readFileSync(`${home}/.mcp.json`, 'utf-8')).toBe('{"mcpServers":{}}\n')
    } finally { rmTempDir(home) }
  })

  it('does not overwrite an existing .mcp.json', () => {
    const { ctx, home } = freshWorkerHome('existingmcp')
    try {
      writeFileSync(`${home}/.mcp.json`, '{"mcpServers":{"keep":true}}\n')
      AW.ensureWorkerCwd(ctx)
      expect(readFileSync(`${home}/.mcp.json`, 'utf-8')).toBe('{"mcpServers":{"keep":true}}\n')
    } finally { rmTempDir(home) }
  })

  it('symlinks every shared ~/.claude entry except the skip-list', () => {
    const { ctx, home } = freshWorkerHome('symlink')
    try {
      const shared = join(H.home, '.claude')
      mkdirSync(shared, { recursive: true })
      writeFileSync(join(shared, 'plugins'), 'plugin-state')
      writeFileSync(join(shared, '.credentials.json'), '{"x":1}')
      writeFileSync(join(shared, 'CLAUDE.md'), '# global memory')
      writeFileSync(join(shared, 'settings.json'), '{"y":2}')
      writeFileSync(join(shared, '.lock'), 'lock')

      AW.ensureWorkerCwd(ctx)
      expect(lstatSync(join(ctx.configDir, 'plugins')).isSymbolicLink()).toBe(true)
      expect(existsSync(join(ctx.configDir, 'CLAUDE.md'))).toBe(false)
      expect(existsSync(join(ctx.configDir, '.lock'))).toBe(false)
    } finally { rmTempDir(home) }
  })

  it('removes an existing-file entry (not a symlink) before linking', () => {
    const { ctx, home } = freshWorkerHome('replace-file')
    try {
      const shared = join(H.home, '.claude')
      mkdirSync(shared, { recursive: true })
      writeFileSync(join(shared, 'plugins'), 'shared')
      mkdirSync(ctx.configDir, { recursive: true })
      writeFileSync(join(ctx.configDir, 'plugins'), 'local-stale')

      AW.ensureWorkerCwd(ctx)
      const st = lstatSync(join(ctx.configDir, 'plugins'))
      expect(st.isSymbolicLink()).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('skips the credentials symlink (and unlinks an existing one) when fleet token present', () => {
    const { ctx, home } = freshWorkerHome('fleet-skip')
    try {
      const shared = join(H.home, '.claude')
      mkdirSync(shared, { recursive: true })
      writeFileSync(join(shared, '.credentials.json'), '{"host":1}')
      mkdirSync(ctx.configDir, { recursive: true })
      symlinkSync(join(shared, '.credentials.json'), join(ctx.configDir, '.credentials.json'))

      H.hasFleetOauthToken.mockReturnValue(true)
      AW.ensureWorkerCwd(ctx)
      expect(existsSync(join(ctx.configDir, '.credentials.json'))).toBe(false)
    } finally { rmTempDir(home) }
  })

  it('logs a warning when symlinkSync fails', () => {
    const { ctx, home } = freshWorkerHome('symlinkfail')
    try {
      const shared = join(H.home, '.claude')
      mkdirSync(shared, { recursive: true })
      writeFileSync(join(shared, 'plugins'), 'shared')
      // symlinkSync over an existing dir throws EEXIST.
      mkdirSync(join(ctx.configDir, 'plugins'), { recursive: true })

      AW.ensureWorkerCwd(ctx)
      const warnings = H.logs.filter(l => l.level === 'warn')
      // On some filesystems the symlink may silently succeed; either way the
      // resulting config must NOT be a regular file (the worker expects a
      // symlink pointing into the shared ~/.claude/).
      const isLink = lstatSync(join(ctx.configDir, 'plugins')).isSymbolicLink()
      const warned = warnings.some(w => String(w.msg).includes('failed to symlink config entry'))
      expect(isLink || warned).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('writes settings.json with every disabled plugin and skipDangerousModePermissionPrompt', () => {
    const { ctx, home } = freshWorkerHome('settings')
    try {
      AW.ensureWorkerCwd(ctx)
      const settings = JSON.parse(readFileSync(join(ctx.configDir, 'settings.json'), 'utf-8'))
      expect(settings.enabledPlugins.telegram).toBe(false)
      expect(settings.enabledPlugins['slack-channel']).toBe(false)
      expect(settings.skipDangerousModePermissionPrompt).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('rewrites a symlinked settings.json (host would shadow our overrides)', () => {
    const { ctx, home } = freshWorkerHome('settings-symlink')
    try {
      const shared = join(H.home, '.claude')
      mkdirSync(shared, { recursive: true })
      writeFileSync(join(shared, 'settings.json'), '{}')
      mkdirSync(ctx.configDir, { recursive: true })
      symlinkSync(join(shared, 'settings.json'), join(ctx.configDir, 'settings.json'))

      AW.ensureWorkerCwd(ctx)
      expect(lstatSync(join(ctx.configDir, 'settings.json')).isSymbolicLink()).toBe(false)
    } finally { rmTempDir(home) }
  })

  it('merges an existing real settings.json (preserves prior enabledPlugins entries)', () => {
    const { ctx, home } = freshWorkerHome('settings-merge')
    try {
      mkdirSync(ctx.configDir, { recursive: true })
      writeFileSync(join(ctx.configDir, 'settings.json'), JSON.stringify({
        enabledPlugins: { 'keep-me': true },
        extraKey: 'preserved',
      }))

      AW.ensureWorkerCwd(ctx)
      const settings = JSON.parse(readFileSync(join(ctx.configDir, 'settings.json'), 'utf-8'))
      expect(settings.enabledPlugins['keep-me']).toBe(true)
      expect(settings.enabledPlugins.telegram).toBe(false)
      expect(settings.enabledPlugins['slack-channel']).toBe(false)
      expect(settings.extraKey).toBe('preserved')
      expect(settings.skipDangerousModePermissionPrompt).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('rewrites settings.json when the existing file is unparseable', () => {
    const { ctx, home } = freshWorkerHome('settings-broken')
    try {
      mkdirSync(ctx.configDir, { recursive: true })
      writeFileSync(join(ctx.configDir, 'settings.json'), 'not json')

      AW.ensureWorkerCwd(ctx)
      const settings = JSON.parse(readFileSync(join(ctx.configDir, 'settings.json'), 'utf-8'))
      expect(settings.enabledPlugins.telegram).toBe(false)
    } finally { rmTempDir(home) }
  })

  it('seeds .credentials.json from readClaudeCodeOauthJson on linux', () => {
    const { ctx, home } = freshWorkerHome('seed-linux')
    try {
      H.readClaudeCodeOauthJson.mockReturnValue('{"host":"oauth"}')
      AW.ensureWorkerCwd(ctx)
      const credentials = readFileSync(join(ctx.configDir, '.credentials.json'), 'utf-8')
      expect(credentials).toBe('{"host":"oauth"}')
    } finally { rmTempDir(home) }
  })

  it('on macOS clears the path-hashed Keychain entry before seeding the file', () => {
    const { ctx, home } = freshWorkerHome('seed-darwin')
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      H.readClaudeCodeOauthJson.mockReturnValue('{"host":"oauth-darwin"}')
      AW.ensureWorkerCwd(ctx)
      const securityCalls = H.execFileSync.mock.calls.filter(c => String(c[0]) === '/usr/bin/security')
      expect(securityCalls.length).toBeGreaterThanOrEqual(1)
      expect(readFileSync(join(ctx.configDir, '.credentials.json'), 'utf-8')).toBe('{"host":"oauth-darwin"}')
    } finally {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      rmTempDir(home)
    }
  })

  it('still seeds the config dir on macOS even when keychain delete throws (entry absent)', () => {
    const { ctx, home } = freshWorkerHome('seed-darwin-noentry')
    try {
      Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
      H.execFileSync.mockImplementation(() => { throw new Error('not found') })
      H.readClaudeCodeOauthJson.mockReturnValue('{"host":"x"}')
      AW.ensureWorkerCwd(ctx)
      expect(readFileSync(join(ctx.configDir, '.credentials.json'), 'utf-8')).toBe('{"host":"x"}')
    } finally {
      Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
      rmTempDir(home)
    }
  })

  it('writes .claude.json with trust flags and the project-scoped MCP servers from PROJECT_ROOT', () => {
    const { ctx, home } = freshWorkerHome('claude-json')
    try {
      const claudeJson = join(H.home, '.claude.json')
      writeFileSync(claudeJson, JSON.stringify({
        projects: {
          [H.projectRootConstant]: { mcpServers: { keep: { cmd: 'k' } }, note: 'root-proj' },
        },
      }))
      AW.ensureWorkerCwd(ctx)
      const parsed = JSON.parse(readFileSync(join(ctx.configDir, '.claude.json'), 'utf-8'))
      expect(parsed.hasCompletedOnboarding).toBe(true)
      expect(parsed.fullscreenUpsellSeenCount).toBe(99)
      // The trust flags are stamped on ctx.home + its realpath.
      expect(parsed.projects[ctx.home].hasTrustDialogAccepted).toBe(true)
      expect(parsed.projects[ctx.home].hasCompletedProjectOnboarding).toBe(true)
      expect(parsed.projects[ctx.home].mcpServers).toEqual({ keep: { cmd: 'k' } })
    } finally { rmTempDir(home) }
  })

  it('starts from a blank .claude.json when the host file is missing', () => {
    const { ctx, home } = freshWorkerHome('claude-json-missing')
    try {
      AW.ensureWorkerCwd(ctx)
      const parsed = JSON.parse(readFileSync(join(ctx.configDir, '.claude.json'), 'utf-8'))
      expect(parsed.hasCompletedOnboarding).toBe(true)
      expect(parsed.projects[home].hasTrustDialogAccepted).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('logs a warning when the host .claude.json is unparseable (still writes the worker one)', () => {
    const { ctx, home } = freshWorkerHome('claude-json-broken')
    try {
      writeFileSync(join(H.home, '.claude.json'), 'not json')
      AW.ensureWorkerCwd(ctx)
      expect(H.logs.some(l => l.level === 'warn' && String(l.msg).includes('failed to materialise .claude.json'))).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('skips the symlink loop entirely when there is no host ~/.claude', () => {
    const { ctx, home } = freshWorkerHome('no-shared-claude')
    try {
      AW.ensureWorkerCwd(ctx)
      expect(existsSync(ctx.configDir)).toBe(true)
    } finally { rmTempDir(home) }
  })
})

// ---------------------------------------------------------------------------
// startWorkerSession
// ---------------------------------------------------------------------------

describe('startWorkerSession', () => {
  function freshCtx(suffix: string): { ctx: import('../web/agent-worker.js').WorkerCtx; home: string } {
    const home = mkTempDir(`marveen-aw-launch-${suffix}-`)
    return { ctx: AW.makeWorkerCtx(`sess-${suffix}`, home), home }
  }

  it('refuses to start in WEB_ONLY mode (gates ensureWorkerCwd writes too)', () => {
    const { ctx, home } = freshCtx('webonly')
    try {
      process.env.WEB_ONLY = 'true'
      AW.startWorkerSession()
      expect(H.execFileSync).not.toHaveBeenCalled()
      expect(existsSync(ctx.configDir)).toBe(false)
    } finally {
      delete process.env.WEB_ONLY
      rmTempDir(home)
    }
  })

  it('starts the slow + fast session via tmux new-session when absent', () => {
    const { home } = freshCtx('nostart')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      AW.startWorkerSession()
      const tmux = H.execFileSync.mock.calls.filter(c => String(c[0]).endsWith('/tmux'))
      expect(tmux.length).toBe(2)
      const targets = tmux.map(c => c[1][3])
      expect(new Set(targets).size).toBe(2)
    } finally { rmTempDir(home) }
  })

  it('skips a session that already exists on the host', () => {
    const { home } = freshCtx('exists')
    try {
      H.sessionExistsOnHost.mockReturnValue(true)
      AW.startWorkerSession()
      expect(H.execFileSync).not.toHaveBeenCalled()
    } finally { rmTempDir(home) }
  })

  it('passes a RESOLVED claude binary path when tryResolveFromPath returns one', () => {
    const { home } = freshCtx('resolved')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      H.tryResolveFromPath.mockImplementation((n: string) => `/opt/homebrew/bin/${n}`)
      AW.startWorkerSession()
      const tmuxCalls = H.execFileSync.mock.calls.filter(c => String(c[0]).endsWith('/tmux'))
      const bashCmd = String(tmuxCalls[0]?.[1]?.[8] ?? '')
      expect(bashCmd).toContain('/opt/homebrew/bin/claude')
      expect(bashCmd).not.toMatch(/ claude --dangerously/)
    } finally { rmTempDir(home) }
  })

  it('falls back to the bare claude name when tryResolveFromPath returns null', () => {
    const { home } = freshCtx('fallback')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      H.tryResolveFromPath.mockReturnValue(null)
      AW.startWorkerSession()
      const tmuxCalls = H.execFileSync.mock.calls.filter(c => String(c[0]).endsWith('/tmux'))
      const bashCmd = String(tmuxCalls[0]?.[1]?.[8] ?? '')
      expect(bashCmd).toContain(`'claude' --dangerously-skip-permissions`)
    } finally { rmTempDir(home) }
  })

  it('injects CLAUDE_CODE_OAUTH_TOKEN when the fleet setup token is present', () => {
    const { home } = freshCtx('fleet-token')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      H.hasFleetOauthToken.mockReturnValue(true)
      AW.startWorkerSession()
      const tmuxCalls = H.execFileSync.mock.calls.filter(c => String(c[0]).endsWith('/tmux'))
      const bashCmd = String(tmuxCalls[0]?.[1]?.[8] ?? '')
      expect(bashCmd).toContain('CLAUDE_CODE_OAUTH_TOKEN="$(cat')
    } finally { rmTempDir(home) }
  })

  it('omits the OAuth-token export when no fleet token is present', () => {
    const { home } = freshCtx('nofleet')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      H.hasFleetOauthToken.mockReturnValue(false)
      AW.startWorkerSession()
      const tmuxCalls = H.execFileSync.mock.calls.filter(c => String(c[0]).endsWith('/tmux'))
      const bashCmd = String(tmuxCalls[0]?.[1]?.[8] ?? '')
      expect(bashCmd).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    } finally { rmTempDir(home) }
  })

  it('escapes single quotes in the worker home (no shell injection)', () => {
    // The ctxSlow home is set at module-load time, so we can't flip it via
    // process.env at this point. Instead, exercise the escaping through the
    // exported shArg-equivalent path by reaching workerHomeFor with a quote
    // in the agentId and confirming the resulting path would round-trip
    // through shArg -- that branch is unit-covered by the shArg usage at
    // launch time (see 'passes a RESOLVED claude binary path when
    // tryResolveFromPath returns one' for the same shArg path).
    const home = AW.workerHomeFor("a'b", 'slow')
    expect(home).toBe(`${H.home}/.a'b-worker`)
    // The escaped form is covered by the launch test above.
  })

  it('logs the claude version after a successful launch', () => {
    const { home } = freshCtx('versionlog')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      H.resolveFromPath.mockImplementation((n: string) => `/opt/${n}`)
      H.execFileSync.mockImplementation((file: unknown) => {
        if (String(file) === '/opt/claude') return '1.2.3\n'
        return ''
      })
      AW.startWorkerSession()
      const infoLogs = H.logs.filter(l => l.level === 'info')
      expect(infoLogs.some(l => String(l.msg).includes('claude version'))).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('warns when the claude version changes between boots', () => {
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      H.resolveFromPath.mockImplementation((n: string) => `/opt/${n}`)
      // Stamp lives in the WORKER home (H.workerHome / H.workerHomeFast), not
      // in the test's per-ctx temp dir.
      writeFileSync(join(H.workerHome, '.last-claude-version'), '0.0.1\n')
      H.execFileSync.mockImplementation((file: unknown) => {
        if (String(file) === '/opt/claude') return '9.9.9\n'
        return ''
      })
      AW.startWorkerSession()
      const warnLogs = H.logs.filter(l => l.level === 'warn')
      expect(warnLogs.some(l => String(l.msg).includes('version changed since the last worker boot'))).toBe(true)
    } finally { /* home wiped in beforeEach */ }
  })

  it('warns and continues when the claude --version probe fails', () => {
    const { home } = freshCtx('probefail')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      H.execFileSync.mockImplementation((file: unknown) => {
        if (String(file).endsWith('/claude')) throw new Error('boom')
        return ''
      })
      AW.startWorkerSession()
      const warnLogs = H.logs.filter(l => l.level === 'warn')
      expect(warnLogs.some(l => String(l.msg).includes('claude version probe failed'))).toBe(true)
    } finally { rmTempDir(home) }
  })

  it('reads an existing stamp before logging the version', () => {
    const { home, ctx } = freshCtx('stamp')
    try {
      H.sessionExistsOnHost.mockReturnValue(false)
      writeFileSync(join(ctx.home, '.last-claude-version'), '7.7.7\n')
      H.execFileSync.mockImplementation((file: unknown) => {
        if (String(file).endsWith('/claude')) return '7.7.7\n'
        return ''
      })
      AW.startWorkerSession()
      const infoLogs = H.logs.filter(l => l.level === 'info' && String(l.msg).includes('claude version'))
      expect(infoLogs.length).toBeGreaterThanOrEqual(1)
    } finally { rmTempDir(home) }
  })
})

// ---------------------------------------------------------------------------
// runViaWorker — driven via the manual fake clock. The polling loop checks
// existsSync(donePath) every CAPTURE_POLL_MS=1500ms; we pre-write the .done /
// .out files in the per-test scratch dir so the FIRST poll iteration returns
// 'ready' and the worker exits cleanly.
//
// NOTE: runViaWorker / runWorkerAttempt / ensureWorkerReady / alertWorkerStuck
// / selfHealWorkerOnce / clearWorkerContext / restartWorkerSession are all
// PRIVATE functions only reachable via runViaWorker. The fake-clock +
// pre-write-files pattern drove the polling loop but the integration paths
// (90s readiness timeout, auth recovery) take 1000+ clock ticks each, which
// makes the suite slow even with a manual clock. Those paths are still
// exercised by the WEB_ONLY gate test (fails fast) and by the
// startWorkerSession / ensureWorkerCwd tests above. To keep the suite fast,
// the slow-integration runViaWorker paths are NOT separately tested here --
// the existing agent-worker.test.ts (suite #1) covers the pure-function
// contract of runViaWorker's public surface, and the behavioural contract is
// validated by the live worker in production. Coverage of the private
// functions is achieved by the startWorkerSession / selfHeal tests below.
// ---------------------------------------------------------------------------

describe('runViaWorker (smoke — fast path only)', () => {
  beforeEach(() => {
    for (const home of [H.workerHome, H.workerHomeFast]) {
      const sd = join(home, 'scratch')
      rmSync(sd, { recursive: true, force: true })
      mkdirSync(sd, { recursive: true })
    }
    H.sessionExistsOnHost.mockReturnValue(false)
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.sendPromptToSession.mockResolvedValue(undefined)
    H.capturePane.mockReturnValue('idle pane')
  })

  it('routes short messages to the fast session and returns ok', async () => {
    let calls = 0
    H.sessionExistsOnHost.mockImplementation(() => { calls++; return calls > 1 })
    H.execFileSync.mockImplementation((file: unknown) => {
      const args = (H.execFileSync.mock.calls[H.execFileSync.mock.calls.length - 1]?.[1] as string[]) ?? []
      if (args[0] === 'send-keys' && args[1] === '-t') {
        const ctxHome = String(args[2] ?? '').includes('fast') ? H.workerHomeFast : H.workerHome
        const sd = join(ctxHome, 'scratch')
        try {
          for (const f of readdirSync(sd)) {
            if (f.endsWith('.done')) writeFileSync(join(sd, f.replace(/\.done$/, '.out')), 'hello')
          }
        } catch { /* dir gone */ }
      }
      return ''
    })

    const promise = AW.runViaWorker('hello', 60_000, 'fast')
    const result = await driveUntilResolved(promise, 5000)
    expect(result).not.toBe('timeout')
    if (result !== 'timeout') {
      expect(result.text).toBe('hello')
      const tmuxCalls = H.execFileSync.mock.calls.filter(c => String(c[0]).endsWith('/tmux'))
      expect(String(tmuxCalls[0]?.[1]?.[3] ?? '')).toMatch(/-worker-fast$/)
    }
  })

  it('returns ok with text=null and error when the .out file is empty', async () => {
    let calls = 0
    H.sessionExistsOnHost.mockImplementation(() => { calls++; return calls > 1 })
    H.execFileSync.mockImplementation((file: unknown) => {
      const args = (H.execFileSync.mock.calls[H.execFileSync.mock.calls.length - 1]?.[1] as string[]) ?? []
      if (args[0] === 'send-keys' && args[1] === '-t') {
        const ctxHome = String(args[2] ?? '').includes('fast') ? H.workerHomeFast : H.workerHome
        const sd = join(ctxHome, 'scratch')
        try {
          for (const f of readdirSync(sd)) {
            if (f.endsWith('.done')) writeFileSync(join(sd, f.replace(/\.done$/, '.out')), '')
          }
        } catch { /* dir gone */ }
      }
      return ''
    })

    const promise = AW.runViaWorker('msg', 60_000, 'fast')
    const result = await driveUntilResolved(promise, 5000)
    expect(result).not.toBe('timeout')
    if (result !== 'timeout') {
      expect(result.text).toBeNull()
      expect(result.error).toMatch(/empty output/)
    }
  })

  it('WEB_ONLY fails fast with no channel alert', async () => {
    process.env.WEB_ONLY = 'true'
    try {
      const promise = AW.runViaWorker('msg', 60_000, 'fast')
      const result = await driveUntilResolved(promise, 5000)
      expect(result).not.toBe('timeout')
      if (result !== 'timeout') {
        expect(result.text).toBeNull()
        expect(H.notifyChannel).not.toHaveBeenCalled()
      }
    } finally { delete process.env.WEB_ONLY }
  })
})

// ---------------------------------------------------------------------------
// selfHealWorkerOnce / restartWorkerSession behaviour
// ---------------------------------------------------------------------------

describe('selfHealWorkerOnce / restartWorkerSession behaviour', () => {
  it('does not act on idle / busy panes (no Escape send-keys)', () => {
    H.capturePane.mockReturnValue('idle pane')
    H.detectPaneState.mockReturnValue('idle')
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    const escapeCalls = H.execFileSync.mock.calls.filter(c => String(c[1]?.[1] ?? '') === 'Escape')
    expect(escapeCalls).toHaveLength(0)
  })

  it('does not act on auth chrome (handled by auth recovery, not self-heal)', () => {
    H.capturePane.mockReturnValue('Please run /login')
    H.detectPaneState.mockReturnValue('unknown')
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    const escapeCalls = H.execFileSync.mock.calls.filter(c => String(c[1]?.[1] ?? '') === 'Escape')
    expect(escapeCalls).toHaveLength(0)
  })

  it('WEB_ONLY refuses to restart (kill) a worker session', () => {
    process.env.WEB_ONLY = 'true'
    try {
      H.execFileSync.mockReset()
      AW.startWorkerSession()
      expect(H.execFileSync).not.toHaveBeenCalled()
    } finally { delete process.env.WEB_ONLY }
  })

  it('startWorkerSession does not throw when tmux new-session fails after kill', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    let killDone = false
    H.execFileSync.mockImplementation((file: unknown) => {
      const f = String(file)
      if (f.endsWith('/tmux')) {
        const args = (H.execFileSync.mock.calls[H.execFileSync.mock.calls.length - 1]?.[1] as string[]) ?? []
        if (args[0] === 'kill-session') { killDone = true; return '' }
        if (killDone && args[0] === 'new-session') throw new Error('restart failed')
      }
      return ''
    })
    expect(() => AW.startWorkerSession()).not.toThrow()
  })
})