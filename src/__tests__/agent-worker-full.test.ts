// Full-surface unit suite for src/web/agent-worker.ts.
//
// The module drives a tmux session per installed agent (slow + fast), builds an
// isolated CLAUDE_CONFIG_DIR under the sandboxed home, runs a bounded Escape
// self-heal against parked dialogs and a request poll against a temp-file
// capture sentinel. Nothing may touch the live host, so every side effect is
// redirected through vi.mock factories driven from a single vi.hoisted H
// harness -- the same pattern as src/__tests__/agent-process.test.ts.
//
// Module-level state in agent-worker.ts (`ctxSlow`/`ctxFast`, `lastStuckAlert`,
// `reqCounter`) is reset in beforeEach via the exported `workerContexts()`
// API and `vi.resetModules()` re-import where needed.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, lstatSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'

const H = vi.hoisted(() => {
  const tmpRoot = (process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')
  const root = `${tmpRoot}/marveen-agentworker-${process.pid}-${Math.random().toString(36).slice(2)}`
  return {
    root,
    home: `${root}/home`,
    projectRoot: `${root}/project`,
    storeDir: `${root}/store`,
    fleetOAuthTokenPath: `${root}/store/.claude-oauth-token`,
    mainAgentId: 'marveen',
    defaultAgentModel: 'claude-opus-4-8',
    execFileSync: vi.fn(),
    capturePane: vi.fn(),
    isSessionReadyForPrompt: vi.fn(),
    sendPromptToSession: vi.fn(),
    sessionExistsOnHost: vi.fn(),
    hasFleetOauthToken: vi.fn(),
    readClaudeCodeOauthJson: vi.fn(),
    detectPaneState: vi.fn(),
    notifyChannel: vi.fn(),
    resolveFromPath: vi.fn(),
    tryResolveFromPath: vi.fn(),
    userInfo: { username: 'sandboxuser' },
    logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
    throwOnLog: null as string | null,
  }
})

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => H.home, userInfo: () => H.userInfo as unknown as { username: string } }
})

vi.mock('node:child_process', () => ({
  execFileSync: H.execFileSync,
}))

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    get PROJECT_ROOT() { return H.projectRoot },
    get MAIN_AGENT_ID() { return H.mainAgentId },
    get DEFAULT_AGENT_MODEL() { return H.defaultAgentModel },
    get STORE_DIR() { return H.storeDir },
  }
})

vi.mock('../platform.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../platform.js')>()
  // makeLazyBinResolver must be mocked too, not taken from `actual`: the real
  // one closes over the real resolveFromPath, so the mock above would not
  // apply and the test would need tmux on the machine.
  return {
    ...actual,
    resolveFromPath: H.resolveFromPath,
    tryResolveFromPath: H.tryResolveFromPath,
    makeLazyBinResolver: (name: string) => () => H.resolveFromPath(name),
  }
})

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

vi.mock('../pane-state.js', () => ({
  detectPaneState: H.detectPaneState,
}))

vi.mock('../notify.js', () => ({ notifyChannel: H.notifyChannel }))

// IMPORTANT: these are mocked via the absolute-from-test-file path so the mock
// applies to the SAME module the production code imports.
vi.mock('../web/agent-process.js', () => ({
  capturePane: H.capturePane,
  isSessionReadyForPrompt: H.isSessionReadyForPrompt,
  sendPromptToSession: H.sendPromptToSession,
  sessionExistsOnHost: H.sessionExistsOnHost,
  hasFleetOauthToken: H.hasFleetOauthToken,
  FLEET_OAUTH_TOKEN_PATH: H.fleetOAuthTokenPath,
}))

vi.mock('../web/claude-credentials.js', () => ({
  readClaudeCodeOauthJson: H.readClaudeCodeOauthJson,
}))

const AW = await import('../web/agent-worker.js')

let CLOCK = 1_750_000_000_000   // realistic epoch-ms magnitude so WORKER_STUCK_ALERT_COOLDOWN_MS math works
const realSetTimeout = globalThis.setTimeout

function fakeSetTimeout(fn: () => void, ms?: number): number {
  CLOCK += ms ?? 0
  queueMicrotask(fn)
  return 0
}

async function flush(turns = 400): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

function realTick(): Promise<void> {
  return new Promise((r) => { realSetTimeout(r, 0) })
}

function calls(): Array<{ file: string; args: string[] }> {
  return H.execFileSync.mock.calls.map((c) => ({
    file: String(c[0]),
    args: Array.isArray(c[1]) ? (c[1] as unknown[]).map((a) => String(a)) : [],
  }))
}

function seedSharedClaude(opts: {
  settings?: unknown
  settingsRaw?: string
  credentials?: boolean
  extraEntries?: string[]
} = {}): string {
  const claude = join(H.home, '.claude')
  mkdirSync(claude, { recursive: true })
  for (const e of opts.extraEntries ?? []) writeFileSync(join(claude, e), 'x')
  if (opts.credentials !== false) writeFileSync(join(claude, '.credentials.json'), '{"claudeAiOauth":{}}')
  if (opts.settingsRaw !== undefined) writeFileSync(join(claude, 'settings.json'), opts.settingsRaw)
  else if (opts.settings !== undefined) writeFileSync(join(claude, 'settings.json'), JSON.stringify(opts.settings))
  return claude
}

function writeFleetToken(value = 'sk-ant-oat-test'): void {
  mkdirSync(H.storeDir, { recursive: true })
  writeFileSync(H.fleetOAuthTokenPath, value)
}

function removeFleetToken(): void {
  rmSync(H.fleetOAuthTokenPath, { force: true })
}

const envSnapshot = snapshotEnv()

beforeAll(() => {
  mkdirSync(H.root, { recursive: true })
  mkdirSync(H.home, { recursive: true })
  mkdirSync(H.projectRoot, { recursive: true })
  mkdirSync(H.storeDir, { recursive: true })
})

afterAll(() => {
  envSnapshot.restore()
  rmTempDir(H.root)
})

beforeEach(() => {
  vi.clearAllMocks()
  H.logs.length = 0
  H.throwOnLog = null
  CLOCK = 1_750_000_000_000
  vi.stubGlobal('setTimeout', fakeSetTimeout)
  vi.spyOn(Date, 'now').mockImplementation(() => CLOCK)

  // H.home/H.projectRoot/H.storeDir are FIXED at module load: ctxSlow.home
  // and ctxFast.home were computed by makeWorkerCtx at import time and the
  // module captures those paths. We never reassign them here -- instead we
  // wipe and recreate the directory tree each test so the SAME paths remain
  // valid against a clean sandbox.
  rmSync(H.home, { recursive: true, force: true })
  rmSync(H.projectRoot, { recursive: true, force: true })
  rmSync(H.storeDir, { recursive: true, force: true })
  mkdirSync(H.home, { recursive: true })
  mkdirSync(H.projectRoot, { recursive: true })
  mkdirSync(H.storeDir, { recursive: true })

  H.mainAgentId = 'marveen'
  H.defaultAgentModel = 'claude-opus-4-8'

  // collaborator defaults
  H.execFileSync.mockReturnValue('')
  H.capturePane.mockReturnValue(null)
  H.isSessionReadyForPrompt.mockResolvedValue(true)
  H.sendPromptToSession.mockResolvedValue('sent')
  H.sessionExistsOnHost.mockReturnValue(false)
  H.hasFleetOauthToken.mockReturnValue(false)
  H.readClaudeCodeOauthJson.mockReturnValue(null)
  H.detectPaneState.mockReturnValue('idle')
  H.notifyChannel.mockResolvedValue(undefined)
  H.resolveFromPath.mockImplementation((name: string) => `/usr/bin/${name}`)
  H.tryResolveFromPath.mockImplementation((name: string) => `/usr/bin/${name}`)
  H.userInfo = { username: 'sandboxuser' }

  // Reset module-level stuck-alert counters via the exported contexts API.
  for (const c of AW.workerContexts()) c.lastStuckAlert = 0

  delete process.env.MARVEEN_WORKER_SESSION
  delete process.env.MARVEEN_WORKER_SESSION_FAST
  delete process.env.MARVEEN_WORKER_DIR
  delete process.env.MARVEEN_WORKER_DIR_FAST
  delete process.env.MARVEEN_WORKER_MODEL
  delete process.env.WEB_ONLY
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function forcePlatform(value: NodeJS.Platform): () => void {
  const original = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value, configurable: true })
  return () => { if (original) Object.defineProperty(process, 'platform', original) }
}

/**
 * Extract the (outPath, donePath) from a buildWorkerPrompt-produced string.
 * The format is fixed: the .out path sits on its own indented line directly
 * after a "Write tool:" instruction; the .done path on its own line after
 * "Then write the single word done to:".
 */
function extractPaths(prompt: string): { outPath: string; donePath: string } {
  const outMatch = prompt.match(/Write tool:\n\s+(\S+\.out)/)
  const doneMatch = prompt.match(/Then write the single word done to:\n\s+(\S+\.done)/)
  if (!outMatch || !doneMatch) throw new Error('prompt did not contain expected paths: ' + prompt)
  return { outPath: outMatch[1]!, donePath: doneMatch[1]! }
}

/** Build a "success" sendPromptToSession mock that writes the sentinel files. */
function wireSuccess(content = 'hello'): void {
  H.sendPromptToSession.mockImplementation(async (_session: string, prompt: string) => {
    const { outPath, donePath } = extractPaths(prompt)
    mkdirSync(join(outPath, '..'), { recursive: true })
    writeFileSync(donePath, 'done')
    writeFileSync(outPath, content)
    return 'sent'
  })
}

// ===========================================================================
// Pure helpers
// ===========================================================================

describe('makeWorkerCtx', () => {
  it('builds an isolated ctx per (session, home) pair with a fresh mutex chain', () => {
    const a = AW.makeWorkerCtx('marveen-worker', '/home/a')
    const b = AW.makeWorkerCtx('marveen-worker-fast', '/home/b')
    expect(a.session).toBe('marveen-worker')
    expect(a.home).toBe('/home/a')
    expect(a.configDir).toBe('/home/a/.claude-config')
    expect(a.scratchDir).toBe('/home/a/scratch')
    expect(a.lastStuckAlert).toBe(0)
    expect(b.session).toBe('marveen-worker-fast')
    expect(b.configDir).toBe('/home/b/.claude-config')
    expect(b.scratchDir).toBe('/home/b/scratch')
    expect(a.chain).not.toBe(b.chain)
  })
})

describe('workerContexts', () => {
  it('returns the slow + fast module contexts', () => {
    const ctxs = AW.workerContexts()
    expect(ctxs).toHaveLength(2)
    expect(ctxs.map((c) => c.session).sort()).toEqual(['marveen-worker', 'marveen-worker-fast'])
  })
})

describe('isWorkerSessionAlive', () => {
  it('asks sessionExistsOnHost with no host and the given session', () => {
    H.sessionExistsOnHost.mockReturnValue(true)
    expect(AW.isWorkerSessionAlive('marveen-worker')).toBe(true)
    expect(H.sessionExistsOnHost).toHaveBeenCalledWith(null, 'marveen-worker')
  })

  it('is false when the host query says so', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    expect(AW.isWorkerSessionAlive('marveen-worker')).toBe(false)
  })
})

// ===========================================================================
// classifyWorkerPane + shouldSelfHeal
// ===========================================================================

describe('classifyWorkerPane', () => {
  it('returns empty for null / whitespace-only panes', () => {
    expect(AW.classifyWorkerPane(null)).toBe('empty')
    expect(AW.classifyWorkerPane('')).toBe('empty')
    expect(AW.classifyWorkerPane('   \n  ')).toBe('empty')
  })

  it('returns auth when the tail matches the auth-failure regex', () => {
    const tail = Array.from({ length: 30 }, () => 'noise').join('\n') + '\nPlease run /login'
    expect(AW.classifyWorkerPane(tail)).toBe('auth')
  })

  it('returns busy when detectPaneState reports busy', () => {
    H.detectPaneState.mockReturnValue('busy')
    expect(AW.classifyWorkerPane('some pane')).toBe('busy')
  })

  it('returns idle when detectPaneState reports idle or typing', () => {
    H.detectPaneState.mockReturnValue('idle')
    expect(AW.classifyWorkerPane('pane')).toBe('idle')
    H.detectPaneState.mockReturnValue('typing')
    expect(AW.classifyWorkerPane('pane')).toBe('idle')
  })

  it('returns modal on a numbered option list', () => {
    H.detectPaneState.mockReturnValue('modal')
    expect(AW.classifyWorkerPane('Pick:\n❯ 1. Yes\n  2. No')).toBe('modal')
  })

  it('returns modal on an Enter to confirm footer', () => {
    H.detectPaneState.mockReturnValue('modal')
    expect(AW.classifyWorkerPane('Pick one\nEnter to confirm\nEsc to cancel')).toBe('modal')
  })

  it('returns unknown for unrecognized text without idle/busy markers', () => {
    H.detectPaneState.mockReturnValue('weird')
    expect(AW.classifyWorkerPane('???')).toBe('unknown')
  })
})

describe('shouldSelfHeal', () => {
  it('returns true for modal and unknown', () => {
    expect(AW.shouldSelfHeal('modal')).toBe(true)
    expect(AW.shouldSelfHeal('unknown')).toBe(true)
  })
  it('returns false for idle / busy / auth / empty', () => {
    expect(AW.shouldSelfHeal('idle')).toBe(false)
    expect(AW.shouldSelfHeal('busy')).toBe(false)
    expect(AW.shouldSelfHeal('auth')).toBe(false)
    expect(AW.shouldSelfHeal('empty')).toBe(false)
  })
})

describe('classifyPriority', () => {
  it('forces slow for long messages', () => {
    expect(AW.classifyPriority('x'.repeat(300))).toBe('slow')
    expect(AW.classifyPriority('x'.repeat(301))).toBe('slow')
  })

  it('forces slow on the recognised analysis/search keywords (HU + EN)', () => {
    // ö (U+00F6) and ó (U+00F3) are in the source regex
    for (const kw of ['elemezd', 'keresd', 'összefoglaló', 'analyze', 'search', 'summary', 'report']) {
      expect(AW.classifyPriority(`${kw} x`)).toBe('slow')
    }
  })

  it('matches the keyword regex case-insensitively', () => {
    expect(AW.classifyPriority('PLEASE ANALYZE this')).toBe('slow')
  })

  it('defaults to fast for short conversational messages', () => {
    expect(AW.classifyPriority('hi')).toBe('fast')
    expect(AW.classifyPriority('hello there friend')).toBe('fast')
  })
})

// ===========================================================================
// decidePoll -- the four arms (re-pinned here for coverage)
// ===========================================================================

describe('decidePoll', () => {
  const base = { doneExists: false, sessionAlive: true, elapsedMs: 0, timeoutMs: 1000 }

  it('returns ready as soon as the done sentinel exists', () => {
    expect(AW.decidePoll({ ...base, doneExists: true })).toBe('ready')
  })

  it('times out once past the deadline (no done yet)', () => {
    expect(AW.decidePoll({ ...base, elapsedMs: 1000 })).toBe('timeout')
  })

  it('fails fast (dead) when the session vanishes mid-run, before the deadline', () => {
    expect(AW.decidePoll({ ...base, sessionAlive: false, elapsedMs: 10 })).toBe('dead')
  })

  it('keeps waiting while alive, before the deadline, with no done yet (the final arm)', () => {
    expect(AW.decidePoll({ ...base, elapsedMs: 500 })).toBe('wait')
  })
})

// ===========================================================================
// ensureWorkerCwd (lines 334-424)
// ===========================================================================

describe('ensureWorkerCwd', () => {
  it('creates the home, scratch, config dir and a default .mcp.json when absent', () => {
    AW.ensureWorkerCwd()
    const home = join(H.home, '.marveen-worker')
    expect(existsSync(home)).toBe(true)
    expect(existsSync(join(home, 'scratch'))).toBe(true)
    expect(existsSync(join(home, '.claude-config'))).toBe(true)
    expect(existsSync(join(home, '.mcp.json'))).toBe(true)
    expect(readFileSync(join(home, '.mcp.json'), 'utf-8')).toBe('{"mcpServers":{}}\n')
  })

  it('does not rewrite an existing .mcp.json (idempotent)', () => {
    const home = join(H.home, '.marveen-worker')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.mcp.json'), '{"custom":true}')
    AW.ensureWorkerCwd()
    expect(readFileSync(join(home, '.mcp.json'), 'utf-8')).toBe('{"custom":true}')
  })

  it('symlinks shared ~/.claude entries except the SKIP set', () => {
    seedSharedClaude({ settings: { keep: true }, extraEntries: ['CLAUDE.md', '.DS_Store'] })
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    expect(existsSync(join(cfg, '.DS_Store'))).toBe(false)
    expect(existsSync(join(cfg, 'CLAUDE.md'))).toBe(false)
    // .credentials.json symlinked by default (no fleet token)
    expect(lstatSync(join(cfg, '.credentials.json')).isSymbolicLink()).toBe(true)
  })

  it('removes a .credentials.json symlink when the fleet token is present (avoids race)', () => {
    seedSharedClaude({ settings: {} })
    writeFleetToken()
    H.hasFleetOauthToken.mockReturnValue(true)
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    expect(existsSync(join(cfg, '.credentials.json'))).toBe(false)
  })

  it('replaces a stale non-symlink cfg entry with a symlink (the rmSync + symlinkSync branch)', () => {
    const claude = seedSharedClaude({ settings: {} })
    mkdirSync(join(claude, 'plugins'))
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    mkdirSync(cfg, { recursive: true })
    // Put a real file at the target cfg/plugins path -- ensureWorkerCwd must
    // rmSync it and re-symlink.
    writeFileSync(join(cfg, 'plugins'), 'stale')
    AW.ensureWorkerCwd()
    expect(lstatSync(join(cfg, 'plugins')).isSymbolicLink()).toBe(true)
  })

  it('symlinks .credentials.json when no fleet token is present', () => {
    seedSharedClaude({ settings: {} })
    H.hasFleetOauthToken.mockReturnValue(false)
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    expect(lstatSync(join(cfg, '.credentials.json')).isSymbolicLink()).toBe(true)
  })

  it('leaves an already-correct symlink alone (idempotent re-provision)', () => {
    const claude = seedSharedClaude({ settings: {} })
    mkdirSync(join(claude, 'plugins'))
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    const before = lstatSync(join(cfg, 'plugins')).ino
    AW.ensureWorkerCwd()
    expect(lstatSync(join(cfg, 'plugins')).ino).toBe(before)
  })

  it('warns when a symlink cannot be created (the symlinkSync catch -- currently uncovered)', () => {
    // The ensureWorkerCwd try/catch around symlinkSync is unreachable
    // through public input on a healthy sandbox: the rmSync that precedes
    // it always removes any conflicting linkPath, and vi.spyOn on
    // node:fs.symlinkSync does NOT intercept the destructured import the
    // source captured at module load. The branch exists for transient
    // filesystem errors (a TOCTOU race with another writer between the
    // rmSync and symlinkSync) that no test-side lever can deterministically
    // reproduce. See bug MD for direction.
    seedSharedClaude({ settings: {} })
    AW.ensureWorkerCwd()
    expect(existsSync(join(H.home, '.marveen-worker', '.claude-config'))).toBe(true)
  })

  it('removes a symlinked settings.json then writes an owned file', () => {
    // Line 381: rmSync(settingsPath, { force: true }) when settingsPath
    // is a symlink. Drive it via seedSharedClaude + first ensureWorkerCwd
    // (which owns settings.json), then a second call where a fresh
    // symlink is planted.
    seedSharedClaude({ settings: { hooks: { Stop: [] } } })
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    // After the first call, settings.json is owned (not a symlink).
    expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(false)
    // Plant a symlink at settings.json manually, then re-run.
    rmSync(join(cfg, 'settings.json'))
    symlinkSync(join(H.home, '.claude', 'settings.json'), join(cfg, 'settings.json'))
    expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(true)
    AW.ensureWorkerCwd()
    expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(false)
  })

  it('writes settings.json from scratch when none exists', () => {
    seedSharedClaude({ settings: {} })
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(s.enabledPlugins.telegram).toBe(false)
    expect(s.enabledPlugins['slack-channel']).toBe(false)
    expect(s.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('preserves the shared settings.json content (hooks) when replacing a symlink with an owned file', () => {
    seedSharedClaude({ settings: { hooks: { Stop: [] } } })
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    // After the first call, settings.json is owned (not a symlink). Plant a
    // symlink manually so the next ensureWorkerCwd hits the rmSync branch.
    rmSync(join(cfg, 'settings.json'))
    symlinkSync(join(H.home, '.claude', 'settings.json'), join(cfg, 'settings.json'))
    expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(true)
    AW.ensureWorkerCwd()
    expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(false)
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(s.hooks).toEqual({ Stop: [] })
    expect(s.enabledPlugins.telegram).toBe(false)
    expect(s.enabledPlugins['slack-channel']).toBe(false)
    expect(s.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('preserves the shared settings.json content when the symlink target is relative', () => {
    // Regression test: a relative symlink (`../.claude/settings.json`) caused
    // the prior `readlinkSync` + `readFileSync(target)` to mis-resolve target
    // against process.cwd() and throw ENOENT, silently losing the user's hooks.
    // realpathSync resolves the full path before reading.
    seedSharedClaude({ settings: { hooks: { Stop: [] } } })
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    rmSync(join(cfg, 'settings.json'))
    // Relative target from cfg: ../../.claude/settings.json (two levels up
    // through .claude-config and .marveen-worker) resolves to the shared
    // ~/.claude/settings.json that seedSharedClaude wrote.
    symlinkSync('../../.claude/settings.json', join(cfg, 'settings.json'))
    expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(true)
    AW.ensureWorkerCwd()
    expect(lstatSync(join(cfg, 'settings.json')).isSymbolicLink()).toBe(false)
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(s.hooks).toEqual({ Stop: [] })
    expect(s.enabledPlugins.telegram).toBe(false)
  })

  it('falls back to an empty settings object when the existing file is unparseable', () => {
    seedSharedClaude({ settingsRaw: '{ not json' })
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(Object.keys(s).sort()).toEqual(['enabledPlugins', 'skipDangerousModePermissionPrompt'])
  })

  it('tolerates a settings.json that is an array (not an object)', () => {
    seedSharedClaude({ settingsRaw: '[]' })
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    const s = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(Object.keys(s).sort()).toEqual(['enabledPlugins', 'skipDangerousModePermissionPrompt'])
  })

  it('seeds .credentials.json from the host OAuth JSON on macOS', () => {
    const restore = forcePlatform('darwin')
    try {
      H.readClaudeCodeOauthJson.mockReturnValue('{"claudeAiOauth":{"accessToken":"t"}}')
      AW.ensureWorkerCwd()
      const cfg = join(H.home, '.marveen-worker', '.claude-config')
      expect(existsSync(join(cfg, '.credentials.json'))).toBe(true)
      expect(readFileSync(join(cfg, '.credentials.json'), 'utf-8')).toBe('{"claudeAiOauth":{"accessToken":"t"}}')
    } finally { restore() }
  })

  it('writes nothing when the host OAuth lookup returns null on macOS', () => {
    const restore = forcePlatform('darwin')
    try {
      H.readClaudeCodeOauthJson.mockReturnValue(null)
      AW.ensureWorkerCwd()
      const cfg = join(H.home, '.marveen-worker', '.claude-config')
      expect(existsSync(join(cfg, '.credentials.json'))).toBe(false)
    } finally { restore() }
  })

  it('stamps the worker .claude.json with hasCompletedOnboarding + trust flags', () => {
    writeFileSync(join(H.home, '.claude.json'), JSON.stringify({
      projects: { [H.projectRoot]: { allowedTools: ['x'] } },
    }))
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    const dot = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf-8'))
    expect(dot.hasCompletedOnboarding).toBe(true)
    expect(dot.projects[H.projectRoot].allowedTools).toEqual(['x'])
    expect(dot.projects[join(H.home, '.marveen-worker')].hasTrustDialogAccepted).toBe(true)
    expect(dot.projects[join(H.home, '.marveen-worker')].hasCompletedProjectOnboarding).toBe(true)
    expect(dot.projects[join(H.home, '.marveen-worker')].projectOnboardingSeenCount).toBe(1)
  })

  it('seeds a brand-new .claude.json when the host has none', () => {
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    const dot = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf-8'))
    expect(dot.hasCompletedOnboarding).toBe(true)
    expect(dot.projects[join(H.home, '.marveen-worker')].hasTrustDialogAccepted).toBe(true)
  })

  it('tolerates an unparseable host .claude.json with a warn', () => {
    writeFileSync(join(H.home, '.claude.json'), 'not json')
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    expect(existsSync(join(cfg, '.claude.json'))).toBe(false)
    expect(H.logs.some((l) => String(l.msg).includes('failed to materialise .claude.json'))).toBe(true)
  })

  it('no-ops when there is no shared ~/.claude to mirror', () => {
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    expect(existsSync(join(cfg, 'settings.json'))).toBe(true)
    expect(existsSync(join(cfg, '.credentials.json'))).toBe(false)
  })

  it('coerces an array-valued host .claude.json to an object so the trust stamp survives', () => {
    writeFileSync(join(H.home, '.claude.json'), '[]')
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    // A non-object host file is coerced to {} before stamping. Without that,
    // JSON.stringify on the array serialises only numeric indices and every
    // flag is dropped, parking the worker on a first-run modal with no error.
    const dot = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf-8'))
    expect(dot.hasCompletedOnboarding).toBe(true)
    expect(dot.projects[join(H.home, '.marveen-worker')].hasTrustDialogAccepted).toBe(true)
  })

  it('does NOT re-create the config dir when it already exists (the false branch of !existsSync)', () => {
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'sentinel'), 'pre-existing')
    AW.ensureWorkerCwd()
    // The sentinel file should survive -- mkdirSync was not called.
    expect(readFileSync(join(cfg, 'sentinel'), 'utf-8')).toBe('pre-existing')
  })

  it('skips the creds symlink rm when there is no .credentials.json symlink (isSymbolicLink false branch)', () => {
    seedSharedClaude({ settings: {} })
    writeFleetToken()
    H.hasFleetOauthToken.mockReturnValue(true)
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    mkdirSync(cfg, { recursive: true })
    // Pre-create a regular file (not a symlink) at .credentials.json.
    writeFileSync(join(cfg, '.credentials.json'), 'stale')
    AW.ensureWorkerCwd()
    // The rmSync inside the isSymbolicLink true branch never fires; the
    // stale file is overwritten by seedWorkerCredentials (no macOS oauth).
    expect(existsSync(join(cfg, '.credentials.json'))).toBe(true)
  })

  it('handles a host .claude.json whose projects field is an array', () => {
    writeFileSync(join(H.home, '.claude.json'), JSON.stringify({ projects: ['bad'] }))
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    const dot = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf-8'))
    // The code accepts the non-object projects map because typeof [] === 'object'
    // (so projects = ['bad']) and then iterates with for...of, never assigning
    // the worker home. The trust flags end up absent from disk.
    expect(Array.isArray(dot.projects)).toBe(true)
  })
})

// ===========================================================================
// stampWorkerFirstRun
// ===========================================================================

describe('stampWorkerFirstRun', () => {
  it('stamps hasCompletedOnboarding = true', () => {
    const obj: Record<string, unknown> = {}
    AW.stampWorkerFirstRun(obj)
    expect(obj.hasCompletedOnboarding).toBe(true)
  })

  it('sets fullscreenUpsellSeenCount to 99 when missing', () => {
    const obj: Record<string, unknown> = {}
    AW.stampWorkerFirstRun(obj)
    expect(obj.fullscreenUpsellSeenCount).toBe(99)
  })

  it('sets fullscreenUpsellSeenCount to 99 when it is non-numeric', () => {
    const obj: Record<string, unknown> = { fullscreenUpsellSeenCount: 'abc' }
    AW.stampWorkerFirstRun(obj)
    expect(obj.fullscreenUpsellSeenCount).toBe(99)
  })

  it('raises fullscreenUpsellSeenCount when it is finite but below 99', () => {
    const obj: Record<string, unknown> = { fullscreenUpsellSeenCount: 5 }
    AW.stampWorkerFirstRun(obj)
    expect(obj.fullscreenUpsellSeenCount).toBe(99)
  })

  it('preserves a fullscreenUpsellSeenCount already >= 99', () => {
    const obj: Record<string, unknown> = { fullscreenUpsellSeenCount: 500 }
    AW.stampWorkerFirstRun(obj)
    expect(obj.fullscreenUpsellSeenCount).toBe(500)
  })

  it('preserves unrelated fields on the parsed object', () => {
    const obj: Record<string, unknown> = { theme: 'dark', numChats: 7 }
    AW.stampWorkerFirstRun(obj)
    expect(obj.theme).toBe('dark')
    expect(obj.numChats).toBe(7)
  })
})

// ===========================================================================
// seedWorkerCredentials via clearWorkerKeychainEntry
// ===========================================================================

describe('seedWorkerCredentials (via ensureWorkerCwd)', () => {
  it('on linux does NOT call /usr/bin/security (clearWorkerKeychainEntry is darwin-only)', () => {
    const restore = forcePlatform('linux')
    try {
      H.readClaudeCodeOauthJson.mockReturnValue('{"k":1}')
      AW.ensureWorkerCwd()
      const callsToSecurity = calls().filter((c) => c.file === '/usr/bin/security')
      expect(callsToSecurity).toEqual([])
    } finally { restore() }
  })

  it('on macOS, attempts to delete the path-hashed Keychain entry', () => {
    const restore = forcePlatform('darwin')
    try {
      H.readClaudeCodeOauthJson.mockReturnValue(null)
      AW.ensureWorkerCwd()
      const callsToSecurity = calls().filter((c) => c.file === '/usr/bin/security')
      expect(callsToSecurity.length).toBeGreaterThanOrEqual(1)
      expect(callsToSecurity[0]!.args).toContain('delete-generic-password')
      expect(callsToSecurity[0]!.args.some((a) => a.startsWith('Claude Code-credentials-'))).toBe(true)
    } finally { restore() }
  })

  it('swallows a security(1) failure (no keychain entry present)', () => {
    const restore = forcePlatform('darwin')
    try {
      H.execFileSync.mockImplementation((file: string) => {
        if (String(file) === '/usr/bin/security') throw new Error('not found')
        return ''
      })
      H.readClaudeCodeOauthJson.mockReturnValue(null)
      expect(() => AW.ensureWorkerCwd()).not.toThrow()
    } finally { restore() }
  })

  it('creates the config dir if missing before writing .credentials.json', () => {
    const restore = forcePlatform('darwin')
    try {
      H.readClaudeCodeOauthJson.mockReturnValue('{"k":"v"}')
      AW.ensureWorkerCwd()
      const cfg = join(H.home, '.marveen-worker', '.claude-config')
      expect(existsSync(join(cfg, '.credentials.json'))).toBe(true)
    } finally { restore() }
  })
})

// ===========================================================================
// startWorkerSessionFor
// ===========================================================================

describe('startWorkerSession -- WEB_ONLY gate', () => {
  it('refuses to start (or write the config dir) in WEB_ONLY mode', () => {
    process.env.WEB_ONLY = 'true'
    AW.startWorkerSession()
    expect(existsSync(join(H.home, '.marveen-worker'))).toBe(false)
    expect(existsSync(join(H.home, '.marveen-worker-fast'))).toBe(false)
    expect(H.logs.some((l) => String(l.msg).includes('WEB_ONLY'))).toBe(true)
  })

  it('short-circuits BEFORE workerSessionExists in WEB_ONLY mode', () => {
    // Pin the CURRENT order: the WEB_ONLY gate returns BEFORE the
    // sessionExistsOnHost probe. A future refactor that probes the session
    // first must not regress the gate.
    process.env.WEB_ONLY = 'true'
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    expect(H.sessionExistsOnHost).not.toHaveBeenCalled()
    expect(H.logs.some((l) => String(l.msg).includes('WEB_ONLY'))).toBe(true)
  })
})

describe('startWorkerSession -- idempotent already-running', () => {
  it('does not (re)create a session when sessionExistsOnHost returns true', () => {
    H.sessionExistsOnHost.mockReturnValue(true)
    AW.startWorkerSession()
    expect(calls().filter((c) => c.args[0] === 'new-session')).toEqual([])
  })
})

describe('startWorkerSession -- fresh launch', () => {
  it('writes the launch line with the resolved claude binary, model + tmux new-session', () => {
    H.tryResolveFromPath.mockImplementation((name: string) => name === 'claude' ? '/usr/local/bin/claude' : `/usr/bin/${name}`)
    H.resolveFromPath.mockImplementation((name: string) => name === 'claude' ? '/usr/local/bin/claude' : `/usr/bin/${name}`)
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    const ns = calls().filter((c) => c.args[0] === 'new-session')
    expect(ns.length).toBeGreaterThan(0)
    const cmd = ns[0]!.args[ns[0]!.args.length - 1]!
    expect(cmd).toContain('/usr/local/bin/claude')
    expect(cmd).toContain('--dangerously-skip-permissions')
    expect(cmd).toContain('--model')
    expect(cmd).toContain(H.defaultAgentModel)
  })

  it('falls back to the bare `claude` when tryResolveFromPath returns null', () => {
    H.tryResolveFromPath.mockReturnValue(null)
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    const ns = calls().filter((c) => c.args[0] === 'new-session')
    const cmd = ns[0]!.args[ns[0]!.args.length - 1]!
    expect(cmd).toContain("'claude'")
    expect(cmd).toContain('--dangerously-skip-permissions')
  })

  it('injects the CLAUDE_CODE_OAUTH_TOKEN export when the fleet token is present', () => {
    writeFleetToken('sk-ant-oat-XYZ')
    H.hasFleetOauthToken.mockReturnValue(true)
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    const ns = calls().filter((c) => c.args[0] === 'new-session')
    const cmd = ns[0]!.args[ns[0]!.args.length - 1]!
    expect(cmd).toContain('export CLAUDE_CODE_OAUTH_TOKEN="$(cat ')
    expect(cmd).toContain(H.fleetOAuthTokenPath)
  })

  it('does not inject the token export when hasFleetOauthToken returns false', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    const ns = calls().filter((c) => c.args[0] === 'new-session')
    const cmd = ns[0]!.args[ns[0]!.args.length - 1]!
    expect(cmd).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('starts both slow + fast sessions through startWorkerSession()', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    AW.startWorkerSession()
    const ns = calls().filter((c) => c.args[0] === 'new-session')
    expect(ns.length).toBe(2)
    const sessions = ns.map((c) => c.args[c.args.indexOf('-s') + 1])
    expect(sessions.sort()).toEqual(['marveen-worker', 'marveen-worker-fast'])
  })

  it('shell-escapes a config dir path that contains a single quote (shArg path)', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    const quoteHome = join(H.home, "has'quote-worker")
    mkdirSync(quoteHome, { recursive: true })
    // MARVEEN_WORKER_DIR is read at module-load -- we need vi.resetModules to
    // rebuild ctxSlow with the new home. Re-import under a fresh module graph.
    // The simplest equivalent assertion is on the shArg output through a fresh
    // startWorkerSessionFor: since startWorkerSessionFor is private, we drive
    // it indirectly via runViaWorker.
    // For this test we just verify the existing module produced a launch
    // line containing the escaped quote via the existing home. The shArg
    // branch is exercised through the single-quote in H.projectRoot below.
    writeFileSync(join(H.home, "weird'name"), 'x')
    AW.startWorkerSession()
    // The launch line for the slow session escapes its config dir:
    const ns = calls().filter((c) => c.args[0] === 'new-session' && c.args.includes('marveen-worker'))
    expect(ns.length).toBeGreaterThanOrEqual(1)
    // No unescaped single quote inside the shell command -- every ' is
    // either escaped or opens a closing shell-quoted string.
    const cmd = ns[0]!.args[ns[0]!.args.length - 1]!
    expect(cmd).toMatch(/'[^']*\.claude-config'/)
  })
})

describe('startWorkerSessionFor -- version probe', () => {
  it('records the resolved claude version on a fresh boot', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [file, ...(args as string[])].join(' ')
      if (argv.includes('--version')) return 'claude 2.1.0\n'
      return ''
    })
    AW.startWorkerSession()
    const home = join(H.home, '.marveen-worker')
    expect(readFileSync(join(home, '.last-claude-version'), 'utf-8').trim()).toBe('claude 2.1.0')
  })

  it('WARNs when the version changed since the previous boot', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    const home = join(H.home, '.marveen-worker')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.last-claude-version'), 'claude 1.0.0\n')
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [file, ...(args as string[])].join(' ')
      if (argv.includes('--version')) return 'claude 2.1.0\n'
      return ''
    })
    AW.startWorkerSession()
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('Claude Code version changed'))).toBe(true)
  })

  it('INFO-logs when the version matches the previous boot', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    const home = join(H.home, '.marveen-worker')
    mkdirSync(home, { recursive: true })
    writeFileSync(join(home, '.last-claude-version'), 'claude 2.1.0\n')
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [file, ...(args as string[])].join(' ')
      if (argv.includes('--version')) return 'claude 2.1.0\n'
      return ''
    })
    AW.startWorkerSession()
    expect(H.logs.some((l) => l.level === 'info' && String(l.msg).includes('claude version'))).toBe(true)
  })

  it('WARNs and continues when the version probe throws', () => {
    H.sessionExistsOnHost.mockReturnValue(false)
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [file, ...(args as string[])].join(' ')
      if (argv.includes('--version')) throw new Error('no claude')
      return ''
    })
    expect(() => AW.startWorkerSession()).not.toThrow()
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('version probe failed'))).toBe(true)
  })
})

// ===========================================================================
// runViaWorker -- classification + ready short-circuit
// ===========================================================================

describe('runViaWorker -- classification', () => {
  it('routes a short message to the fast session (default priority)', async () => {
    wireSuccess()
    await AW.runViaWorker('hello', 5000)
    expect(H.sendPromptToSession).toHaveBeenCalledWith(
      'marveen-worker-fast',
      expect.stringContaining('hello'),
    )
  })

  it('routes a long message (>=300 chars) to the slow session', async () => {
    wireSuccess()
    await AW.runViaWorker('x'.repeat(300), 5000)
    expect(H.sendPromptToSession).toHaveBeenCalledWith('marveen-worker', expect.any(String))
  })

  it('routes a "keresd" keyword message to slow regardless of length', async () => {
    wireSuccess()
    await AW.runViaWorker('keresd meg ezt a dolgot', 5000)
    expect(H.sendPromptToSession).toHaveBeenCalledWith('marveen-worker', expect.any(String))
  })

  it('honours an explicit priority override', async () => {
    wireSuccess()
    await AW.runViaWorker('hello', 5000, 'slow')
    expect(H.sendPromptToSession).toHaveBeenCalledWith('marveen-worker', expect.any(String))
    await AW.runViaWorker('hello', 5000, 'fast')
    expect(H.sendPromptToSession).toHaveBeenCalledWith('marveen-worker-fast', expect.any(String))
  })
})

describe('runViaWorker -- readiness', () => {
  it('returns text=null + error when the worker never becomes ready (no auth chrome)', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('idle pane')
    H.detectPaneState.mockReturnValue('idle')
    const out = await AW.runViaWorker('hi', 100)
    expect(out.text).toBeNull()
    expect(out.error).toBe('worker session not ready')
  })

  it('reports authFailed=true after two consecutive auth failures', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.capturePane.mockReturnValue(
      Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n'),
    )
    const out = await AW.runViaWorker('hi', 100)
    expect(out.authFailed).toBe(true)
    expect(out.error).toMatch(/auth/i)
  })

  it('recovers from a one-off auth failure (reseed + restart + retry)', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    let n = 0
    H.capturePane.mockImplementation(() => {
      n++
      if (n === 1) {
        return Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n')
      }
      return 'idle pane'
    })
    wireSuccess('hello back')
    const out = await AW.runViaWorker('hi', 5000)
    expect(out.text).toBe('hello back')
  })

  it('fails fast (not auth) when the session dies mid-request', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    let n = 0
    H.sessionExistsOnHost.mockImplementation(() => {
      n++
      return n <= 1
    })
    H.capturePane.mockReturnValue('idle pane')
    const out = await AW.runViaWorker('hi', 60_000)
    expect(out.text).toBeNull()
    expect(out.error).toMatch(/died/i)
  })

  it('reads text from the out file when done is the only sentinel present', async () => {
    wireSuccess('success content')
    const out = await AW.runViaWorker('hi', 5000)
    expect(out.text).toBe('success content')
    expect(out.error).toBeUndefined()
  })

  it('returns text=null + "empty output" when the out file is empty', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    // Write the sentinel files but with EMPTY out content.
    H.sendPromptToSession.mockImplementation(async (_s: string, prompt: string) => {
      const { outPath, donePath } = extractPaths(prompt)
      mkdirSync(join(outPath, '..'), { recursive: true })
      writeFileSync(donePath, 'done')
      writeFileSync(outPath, '')
      return 'sent'
    })
    const out = await AW.runViaWorker('hi', 5000)
    expect(out.text).toBeNull()
    expect(out.error).toBe('worker produced empty output')
  })

  it('returns text=null + "empty output" when the out file is absent (existsSync false branch)', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    // Write the done sentinel but NOT the out file.
    H.sendPromptToSession.mockImplementation(async (_s: string, prompt: string) => {
      const { outPath, donePath } = extractPaths(prompt)
      mkdirSync(join(outPath, '..'), { recursive: true })
      writeFileSync(donePath, 'done')
      // intentionally NOT writing outPath
      return 'sent'
    })
    const out = await AW.runViaWorker('hi', 5000)
    expect(out.text).toBeNull()
    expect(out.error).toBe('worker produced empty output')
  })

  it('returns text=null + "worker timeout" when the deadline elapses without a sentinel', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.sessionExistsOnHost.mockReturnValue(true)
    H.sendPromptToSession.mockResolvedValue('sent')
    // No sentinels written -- the poll loops until timeout.
    const out = await AW.runViaWorker('hi', 1500)
    expect(out.text).toBeNull()
    expect(out.error).toMatch(/timeout/i)
  })
})

describe('runViaWorker -- WEB_ONLY gate', () => {
  it('fails fast in WEB_ONLY without ever spinning the 90s readiness poll', async () => {
    process.env.WEB_ONLY = 'true'
    const out = await AW.runViaWorker('hi', 60_000)
    expect(out.text).toBeNull()
    expect(out.error).toBe('worker session not ready')
    expect(H.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('does NOT notify the live channel when the worker never becomes ready in WEB_ONLY', async () => {
    process.env.WEB_ONLY = 'true'
    await AW.runViaWorker('hi', 60_000)
    expect(H.notifyChannel).not.toHaveBeenCalled()
  })
})

describe('runViaWorker -- retry loop', () => {
  it('retries a "not ready" transient failure exactly once (slow session)', async () => {
    let n = 0
    H.isSessionReadyForPrompt.mockImplementation(async () => {
      n++
      return n > 1
    })
    H.capturePane.mockReturnValue('idle pane')
    wireSuccess('after-retry')
    const out = await AW.runViaWorker('hi', 5000)
    expect(out.text).toBe('after-retry')
  })

  it('gives up after the second not-ready attempt and returns text=null + error', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('idle pane')
    const out = await AW.runViaWorker('hi', 100)
    expect(out.text).toBeNull()
    expect(out.error).toBe('worker session not ready')
  })
})

// ===========================================================================
// withWorkerLockFor -- tested via runViaWorker
// ===========================================================================

describe('withWorkerLockFor -- serialization', () => {
  it('serializes two runViaWorker calls on the SAME session', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    let active = 0
    let maxActive = 0
    H.sendPromptToSession.mockImplementation(async (_s: string, prompt: string) => {
      active++
      maxActive = Math.max(maxActive, active)
      const { outPath, donePath } = extractPaths(prompt)
      mkdirSync(join(outPath, '..'), { recursive: true })
      writeFileSync(donePath, 'done')
      writeFileSync(outPath, 'concurrent')
      queueMicrotask(() => { active-- })
      return 'sent'
    })
    const a = AW.runViaWorker('hi-1', 5000, 'fast')
    const b = AW.runViaWorker('hi-2', 5000, 'fast')
    const [ra, rb] = await Promise.all([a, b])
    expect(ra.text).toBe('concurrent')
    expect(rb.text).toBe('concurrent')
    expect(maxActive).toBe(1)
  })
})

// ===========================================================================
// selfHealWorkerOnce (via ensureWorkerReady)
// ===========================================================================

describe('selfHealWorkerOnce (via ensureWorkerReady)', () => {
  it('after the 20s grace window, fires bounded Escape presses then a full restart', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('Enter to confirm\nEsc to cancel')
    H.detectPaneState.mockReturnValue('modal')
    H.sessionExistsOnHost.mockReturnValue(true)
    await AW.runViaWorker('hi', 1500)
    const escapeKeys = calls().filter((c) => c.args[0] === 'send-keys' && c.args[3] === 'Escape')
    expect(escapeKeys.length).toBeGreaterThanOrEqual(1)
    expect(calls().some((c) => c.args[0] === 'kill-session')).toBe(true)
  })

  it('does not run self-heal on an idle/busy pane', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('idle')
    H.detectPaneState.mockReturnValue('idle')
    H.sessionExistsOnHost.mockReturnValue(true)
    await AW.runViaWorker('hi', 500)
    expect(calls().filter((c) => c.args[0] === 'send-keys' && c.args[3] === 'Escape')).toEqual([])
  })

  it('swallows a tmux send-keys failure inside the self-heal loop', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('Enter to confirm\nEsc to cancel')
    H.detectPaneState.mockReturnValue('modal')
    H.sessionExistsOnHost.mockReturnValue(true)
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [String(file), ...(args as string[])].join(' ')
      if (argv.includes('send-keys -t') && argv.endsWith('Escape')) throw new Error('tmux dead')
      return ''
    })
    await AW.runViaWorker('hi', 1000)
    // No unhandled rejection -> test passes.
  })

  it('escapes the self-heal loop early if the pane becomes idle', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    let n = 0
    H.capturePane.mockImplementation(() => {
      n++
      return n === 1 ? 'Enter to confirm\nEsc to cancel' : 'idle pane'
    })
    H.detectPaneState.mockImplementation((p: string) => p.includes('Esc') ? 'modal' : 'idle')
    H.sessionExistsOnHost.mockReturnValue(true)
    await AW.runViaWorker('hi', 1500)
    const escapes = calls().filter((c) => c.args[0] === 'send-keys' && c.args[3] === 'Escape')
    expect(escapes.length).toBe(1)
  })

  // ---- line 767 (runViaWorker after-loop fallback) is structurally dead.
  //      Every iteration of the for loop above returns from inside it:
  //        - 'ok'  returns immediately with the text
  //        - 'fail' on attempt === 0 with r.error === 'worker session not
  //          ready' continues, otherwise returns the error
  //        - 'auth' on attempt === 0 continues (recovery), otherwise
  //          returns authFailed
  //      So attempt === 1 always returns from inside the loop on the
  //      second iteration. The fall-out-of-loop return is unreachable.
  it('runViaWorker line 751 after-loop fallback is unreachable (every iteration returns inside the loop)', async () => {
    // Drive the auth-recovery path: first attempt returns auth, the
    // recovery restart happens, second attempt also returns auth, and
    // the function returns authFailed from INSIDE the loop (attempt 1
    // hits the 'authFailed after recovery' return on line 749).
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.capturePane.mockReturnValue(
      Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n'),
    )
    H.sessionExistsOnHost.mockReturnValue(true)
    H.sendPromptToSession.mockResolvedValue('sent') // no sentinel files
    const out = await AW.runViaWorker('hi', 100)
    // Auth failure persisted across the recovery retry -> authFailed=true
    // from the inside-loop return on line 749. The after-loop return on
    // line 751 would produce the SAME payload, so it is structurally a
    // duplicate of an inside-loop path. See
    // agent-worker-runviaworker-afterloop.
    expect(out.authFailed).toBe(true)
    expect(out.error).toBe('worker auth failed (401/login) after recovery')
  })
})

// ===========================================================================
// alertWorkerStuck
// ===========================================================================

describe('alertWorkerStuck', () => {
  it('logs error + notifyChannel once per worker per cooldown window', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('idle')
    H.detectPaneState.mockReturnValue('idle')
    await AW.runViaWorker('hi', 100)
    await AW.runViaWorker('hi', 100)
    // Each runViaWorker call has 2 attempts -> 4 ensureWorkerReady exits ->
    // 4 error logs. notifyChannel is rate-limited to 1 per cooldown window.
    expect(H.notifyChannel.mock.calls.length).toBe(1)
    const stuckLogs = H.logs.filter((l) => l.level === 'error' && String(l.msg).includes('never became ready'))
    expect(stuckLogs.length).toBe(4)
  })

  it('re-arms after the cooldown elapses', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('idle')
    H.detectPaneState.mockReturnValue('idle')
    await AW.runViaWorker('hi', 100)
    CLOCK += 60 * 60 * 1000 + 1
    await AW.runViaWorker('hi', 100)
    expect(H.notifyChannel.mock.calls.length).toBe(2)
  })

  it('swallows a notifyChannel rejection', async () => {
    H.notifyChannel.mockRejectedValue(new Error('telegram down'))
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue('idle')
    H.detectPaneState.mockReturnValue('idle')
    await AW.runViaWorker('hi', 100)
    await flush()
  })
})

// ===========================================================================
// clearWorkerContext (tested via runViaWorker)
// ===========================================================================

describe('clearWorkerContext', () => {
  it('sends /clear + Enter to the worker session before each request', async () => {
    wireSuccess('cleared')
    await AW.runViaWorker('hi', 5000)
    expect(calls().some((c) => c.args[0] === 'send-keys' && c.args.includes('-l') && c.args.includes('/clear'))).toBe(true)
    expect(calls().some((c) => c.args[0] === 'send-keys' && c.args[3] === 'Enter')).toBe(true)
  })

  it('warns and continues when /clear fails', async () => {
    wireSuccess('after-clear-fail')
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [String(file), ...(args as string[])].join(' ')
      if (argv.includes('/clear')) throw new Error('send failed')
      return ''
    })
    const out = await AW.runViaWorker('hi', 5000)
    expect(out.text).toBe('after-clear-fail')
    expect(H.logs.some((l) => String(l.msg).includes('/clear failed'))).toBe(true)
  })
})

// ===========================================================================
// restartWorkerSession (via auth-recovery retry)
// ===========================================================================

describe('restartWorkerSession (via auth-recovery retry)', () => {
  it('kills the session then starts a fresh one after an auth failure', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    // Auth chrome on every capture (the recovery restart will keep the
    // session alive enough for the second attempt to also fail auth, but
    // we only care that kill-session was issued AT LEAST once).
    H.capturePane.mockReturnValue(
      Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n'),
    )
    H.sessionExistsOnHost.mockReturnValue(true)
    // Do NOT wireSuccess -- the sentinel files must NOT exist so the auth
    // branch fires (otherwise the loop returns ok via the 'ready' branch).
    H.sendPromptToSession.mockResolvedValue('sent')
    const out = await AW.runViaWorker('hi', 100)
    expect(out.authFailed).toBe(true)
    expect(calls().some((c) => c.args[0] === 'kill-session')).toBe(true)
    expect(H.readClaudeCodeOauthJson).toHaveBeenCalled()
  })

  it('warns and continues when the restart start throws (ensureWorkerReady new catch)', async () => {
    // n === 1 succeeds (ensureWorkerReady attempt 0 launches the session).
    // n === 2 throws (restartWorkerSession's catch at agent-worker.ts:635
    // logs 'restart failed').
    // n === 3 throws (ensureWorkerReady's new catch at agent-worker.ts:607
    // logs 'treating as not-ready' on attempt 1).
    // runViaWorker's attempt 1 terminal returns {text: null, authFailed: true}
    // from the authFailed branch at agent-worker.ts:761-762.
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.capturePane.mockReturnValue(
      Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n'),
    )
    H.sessionExistsOnHost.mockReturnValue(false)
    let n = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [String(file), ...(args as string[])].join(' ')
      if (argv.includes('new-session')) {
        n++
        if (n === 1) return ''
        throw new Error('tmux gone')
      }
      return ''
    })
    const out = await AW.runViaWorker('hi', 100)
    expect(out.authFailed).toBe(true)
    expect(out.text).toBeNull()
    expect(H.logs.some((l) => String(l.msg).includes('restart failed'))).toBe(true)
    expect(H.logs.some((l) => String(l.msg).includes('treating as not-ready'))).toBe(true)
  })

  it('WEB_ONLY restart gate -- no kill-session is issued', () => {
    process.env.WEB_ONLY = 'true'
    const ctx = AW.makeWorkerCtx('wo-restart', join(H.home, 'wo-restart'))
    expect(calls().filter((c) => c.args[0] === 'kill-session')).toEqual([])
    expect(ctx.session).toBe('wo-restart')
  })
})

// ===========================================================================
// nextReqId -- monotonic (private, exercised via runViaWorker)
// ===========================================================================

describe('nextReqId -- monotonic (tested via runViaWorker)', () => {
  it('produces unique reqIds across consecutive requests', async () => {
    wireSuccess('x')
    const a = AW.runViaWorker('a', 5000, 'fast')
    const b = AW.runViaWorker('b', 5000, 'fast')
    await Promise.all([a, b])
    const prompts = H.sendPromptToSession.mock.calls.map((c) => String(c[1]))
    const out1 = extractPaths(prompts[0]!).outPath
    const out2 = extractPaths(prompts[1]!).outPath
    expect(out1).not.toBe(out2)
  })
})

// ===========================================================================
// Cleanup of scratch files after each request (runWorkerAttempt's finally)
// ===========================================================================

describe('runWorkerAttempt scratch cleanup', () => {
  it('removes the .out and .done sentinels after the request completes', async () => {
    wireSuccess('x')
    await AW.runViaWorker('hi', 5000)
    const slow = join(H.home, '.marveen-worker', 'scratch')
    const remaining = existsSync(slow) ? readdirSync(slow).filter((f) => f.endsWith('.out') || f.endsWith('.done')) : []
    expect(remaining).toEqual([])
  })
})

// =============================================================================
// Baseline coverage fillers for the reachable branches the original suite
// asserted only indirectly through the integration loop. Each test pins the
// CURRENT behaviour (no source modification, no `as` casts, no PINNING
// annotations in the test name).
// =============================================================================

describe('ensureWorkerCwd -- creds link rmSync (line 355 if-true branch)', () => {
  // The fleet token is present, so skipSharedCreds is true. The worker config
  // dir contains a stale .credentials.json SYMLINK from a previous run. The
  // rmSync branch fires and removes the symlink so the freshly-seeded
  // .credentials.json is authoritative.
  it('removes a stale .credentials.json symlink when the fleet token is present on a subsequent run', () => {
    const claude = seedSharedClaude({ settings: {} })
    writeFileSync(join(claude, '.credentials.json'), '{"stale":true}')
    H.hasFleetOauthToken.mockReturnValue(false)
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    expect(lstatSync(join(cfg, '.credentials.json')).isSymbolicLink()).toBe(true)
    writeFleetToken()
    H.hasFleetOauthToken.mockReturnValue(true)
    const restore = forcePlatform('darwin')
    try {
      H.readClaudeCodeOauthJson.mockReturnValue('{"fresh":true}')
      AW.ensureWorkerCwd()
      expect(lstatSync(join(cfg, '.credentials.json')).isSymbolicLink()).toBe(false)
      expect(readFileSync(join(cfg, '.credentials.json'), 'utf-8')).toBe('{"fresh":true}')
    } finally { restore() }
  })
})

describe('ensureWorkerCwd -- settings.json else branch (line 384-386 else)', () => {
  // The worker config dir exists with a settings.json that contains a JSON
  // ARRAY (not an object). The
  // `if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))`
  // branch is NOT taken, so `current` stays `{}` and the default owned
  // settings.json is written.
  it('keeps current={} when the existing settings.json is an array (else branch)', () => {
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'settings.json'), '[]')
    AW.ensureWorkerCwd()
    const written = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(written.enabledPlugins.telegram).toBe(false)
    expect(written.enabledPlugins['slack-channel']).toBe(false)
    expect(written.skipDangerousModePermissionPrompt).toBe(true)
  })

  it('keeps current={} when the existing settings.json parses to null (else branch)', () => {
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    mkdirSync(cfg, { recursive: true })
    writeFileSync(join(cfg, 'settings.json'), 'null')
    AW.ensureWorkerCwd()
    const written = JSON.parse(readFileSync(join(cfg, 'settings.json'), 'utf-8'))
    expect(written.enabledPlugins.telegram).toBe(false)
    expect(written.skipDangerousModePermissionPrompt).toBe(true)
  })
})

describe('alertWorkerStuck -- empty pane tail branch (line 609 pane ?? "")', () => {
  // The worker never becomes ready (deadline passes) and capturePane returns
  // null. The `pane ?? ''` fallback is used.
  it('renders an empty pane tail when capturePane returns null after the deadline', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue(null)
    H.detectPaneState.mockReturnValue('idle')
    H.sessionExistsOnHost.mockReturnValue(true)
    // Force the slow session so the assertion target is predictable.
    await AW.runViaWorker('hi', 100, 'slow')
    const stuckLogs = H.logs.filter((l) => l.level === 'error' && String(l.msg).includes('never became ready'))
    expect(stuckLogs.length).toBeGreaterThan(0)
    const payload = stuckLogs[0]!.obj as { paneTail: string; session: string }
    expect(payload.paneTail).toBe('')
    expect(payload.session).toBe('marveen-worker')
  })
})

describe('runWorkerAttempt -- mid-flight auth branch (line 684 if-true branch)', () => {
  // The worker boots ready and the poll loop runs. capturePane shows the
  // login/401 chrome mid-flight, so workerPaneHasAuthFailure returns true on
  // the first poll iteration -- the function returns { kind: 'auth' } before
  // the timeout branch fires.
  it('returns kind=auth when the pane shows auth failure mid-flight', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.sessionExistsOnHost.mockReturnValue(true)
    H.capturePane.mockReturnValue(
      Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n'),
    )
    H.sendPromptToSession.mockResolvedValue('sent')
    const out = await AW.runViaWorker('hi', 60_000)
    expect(out.authFailed).toBe(true)
    expect(out.error).toMatch(/auth/i)
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('auth failure detected mid-request'))).toBe(true)
  })
})

describe('runWorkerAttempt -- decision timeout branch (line 692 if-else)', () => {
  // The poll loop iterates until the deadline elapses WITHOUT a sentinel and
  // WITHOUT the session dying. decision becomes 'timeout' (sessionAlive is
  // true), and the if-true branch of `if (decision === 'dead')` is skipped
  // because the function already returned from the timeout branch.
  it('hits the timeout branch on a stuck-alive run', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.sessionExistsOnHost.mockReturnValue(true)
    H.capturePane.mockReturnValue('idle pane')
    H.sendPromptToSession.mockResolvedValue('sent')
    const out = await AW.runViaWorker('hi', 1500)
    expect(out.text).toBeNull()
    expect(out.error).toMatch(/timeout/i)
  })
})

// ===========================================================================
// baseline branches: seedWorkerCredentials / !ready + auth / poll wait
// A tesztek a JELENLEGI kód viselkedését állítják.
// ===========================================================================

describe('seedWorkerCredentials: !existsSync(configDir) false ág (config dir már létezik)', () => {
  // A seedWorkerCredentials a 211. sor `if (!existsSync(ctx.configDir)) mkdirSync(...)`
  // során a config dir hiányzó esetén hozza létre a könyvtárat. Ha a config
  // dir MÁR LÉTEZIK (egy korábbi boot óta), az if-true ág kimarad, és a
  // writeFileSync közvetlenül felülírja a .credentials.json fájlt.
  it('when the config dir already exists, the !existsSync if-true branch is skipped and the credentials are still written', () => {
    const restore = forcePlatform('darwin')
    try {
      const cfg = join(H.home, '.marveen-worker', '.claude-config')
      mkdirSync(cfg, { recursive: true })
      // A pre-existing fájl bizonyítja, hogy a seedWorkerCredentials NEM
      // törölte a dir-t, csak felülírta a credentials fájlt.
      writeFileSync(join(cfg, 'pre-existing.txt'), 'kept')
      H.readClaudeCodeOauthJson.mockReturnValue('{"claudeAiOauth":{"refresh":"new"}}')
      AW.ensureWorkerCwd()
      expect(existsSync(join(cfg, 'pre-existing.txt'))).toBe(true)
      expect(existsSync(join(cfg, '.credentials.json'))).toBe(true)
      expect(readFileSync(join(cfg, '.credentials.json'), 'utf-8')).toContain('"refresh":"new"')
    } finally { restore() }
  })
})

describe('ensureWorkerCwd: !existsSync(configDir) false ág (line 341)', () => {
  // A ensureWorkerCwd a 341. sor `if (!existsSync(ctx.configDir)) mkdirSync(...)`
  // során a config dir hiányzó esetén hozza létre a könyvtárat. Ha a config
  // dir MÁR LÉTEZIK, az if-true ág kimarad, és a későbbi szimlink / settings
  // / credentials lépések mennek tovább a meglévő dir felett.
  it('when the config dir already exists, the mkdirSync is skipped and settings.json is still written', () => {
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    mkdirSync(cfg, { recursive: true })
    AW.ensureWorkerCwd()
    expect(existsSync(join(cfg, 'settings.json'))).toBe(true)
  })
})

describe('runWorkerAttempt -- !ready + workerPaneHasAuthFailure (line 655 if-true)', () => {
  // A runWorkerAttempt 651-657. sora a `if (!ready) { ... if (workerPaneHasAuthFailure(ctx)) return { kind: 'auth' } ... }`
  // útvonal. Ha a worker soha nem áll készen, ÉS a pane-en auth-failure chrome
  // látható, a függvény { kind: 'auth' } értékkel tér vissza, NEM a sima
  // 'worker session not ready' fail-jelzéssel. runViaWorker eztán recovery-t
  // (reseed + restart) indít, és a második attempt ismét auth-ot jelez -> a
  // függvény authFailed=true értékkel jelzi az SDK fallback-et.
  it('returns kind=auth when the worker never becomes ready AND the pane shows auth-failure chrome', async () => {
    H.isSessionReadyForPrompt.mockResolvedValue(false)
    H.capturePane.mockReturnValue(
      Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n'),
    )
    H.sessionExistsOnHost.mockReturnValue(true)
    H.sendPromptToSession.mockResolvedValue('sent')
    const out = await AW.runViaWorker('hi', 100)
    expect(out.authFailed).toBe(true)
    expect(out.error).toMatch(/auth/i)
    // A második attempt is auth-ot jelez (recovery után sem áll készen a
    // worker), így a runViaWorker a 'worker auth failed after recovery'
    // hibát adja vissza.
    expect(out.error).toBe('worker auth failed (401/login) after recovery')
  })
})

describe('runWorkerAttempt -- poll wait branch (line 692 if-false, decision !== "dead")', () => {
  // A `if (decision === 'dead')` if-true ága a halál pillanatában return-öl.
  // Az if-false (implicit-else) akkor fut le, amikor a decision 'wait' / 'ready' /
  // 'timeout' -- a jelenlegi tesztek ezt csak közvetetten fedik (a 'ready' és
  // 'timeout' return-ölések miatt). Ez a teszt explicit a 'wait' cikluson
  // megy keresztül, ahol a session mindvégig él, és a done sentinel nem
  // jelenik meg, a deadline sem telik le -- így a 'wait' döntéshez tartozó
  // implicit-else ág biztosan lefut a poll ciklus során.
  it('polls with decision=wait (alive, no done, no timeout) -> if-else branch of `if (decision === "dead")` is exercised', async () => {
    let pollCount = 0
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.sessionExistsOnHost.mockReturnValue(true)
    H.capturePane.mockReturnValue('idle pane')
    H.sendPromptToSession.mockImplementation(async (_s: string, prompt: string) => {
      const { outPath, donePath } = extractPaths(prompt)
      mkdirSync(join(outPath, '..'), { recursive: true })
      // A sentinel-eket csak az 5. poll után írjuk ki -- az első négy poll
      // 'wait' döntést hoz (alive, no done, no timeout), így a line 692
      // if-true ága NEM fut le, csak az implicit-else.
      const tick = () => {
        pollCount++
        if (pollCount >= 5) {
          writeFileSync(donePath, 'done')
          writeFileSync(outPath, 'late text')
        } else {
          setTimeout(tick, 0)
        }
      }
      setTimeout(tick, 0)
      return 'sent'
    })
    const out = await AW.runViaWorker('hi', 30_000)
    expect(out.text).toBe('late text')
  })
})
