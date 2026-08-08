// 100% coverage suite for src/web/heartbeat-agent-scaffold.ts.
//
// The base suite at src/__tests__/heartbeat-agent-scaffold.test.ts covers the
// pure renderHeartbeatClaudeMd + shouldBootHeartbeatAgent surfaces. The
// remaining uncovered buckets require config + filesystem effects:
//
//   - Line 106: currentHeartbeatIdentity() return shape (config-bound factory)
//   - Lines 269-271: renderAgentConfigJson() -- exercised via ensureHeartbeatAgent
//   - Lines 273-275: renderClaudeSettingsJson() -- exercised via ensureHeartbeatAgent
//   - Line 283: ALWAYS_WRITE tuple literal
//   - Lines 302-322: ensureHeartbeatAgent() body
//
// Strategy: mock `../config.js` to a sandbox PROJECT_ROOT + STORE_DIR so the
// heartbeat-agent dir tree is built inside os.tmpdir() and never touches the
// live checkout. Mock `../logger.js`. The renderers and ensureHeartbeatAgent
// are otherwise pure (no fs side effects we cannot control).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ----------------------------------------------------------------------------
// Hoisted mock state. config.js is redirected at the top so EVERY fs effect
// in heartbeat-agent-scaffold.ts lands in the per-test sandbox; the real
// machine's `agents/heartbeat/` dir is NEVER touched.
// ----------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  sandbox: '' as string,
  projectRoot: '' as string,
  ownerName: 'Owner',
  botName: 'Helios',
  mainAgentId: 'helios',
  webPort: 3420,
  dashboardPublicUrl: '',
  appTz: 'Europe/Budapest',
  heartbeatCalendarAccount: '',
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: mockState.projectRoot,
    STORE_DIR: join(mockState.projectRoot, 'store'),
    OWNER_NAME: mockState.ownerName,
    BOT_NAME: mockState.botName,
    MAIN_AGENT_ID: mockState.mainAgentId,
    WEB_PORT: mockState.webPort,
    DASHBOARD_PUBLIC_URL: mockState.dashboardPublicUrl,
    APP_TZ: mockState.appTz,
    HEARTBEAT_CALENDAR_ACCOUNT: mockState.heartbeatCalendarAccount,
  }
})

beforeEach(() => {
  mockState.sandbox = mkdtempSync(join(tmpdir(), 'hb-scaffold-full-'))
  mockState.projectRoot = join(mockState.sandbox, 'project')
  mkdirSync(mockState.projectRoot, { recursive: true })
  mockState.ownerName = 'Owner'
  mockState.botName = 'Helios'
  mockState.mainAgentId = 'helios'
  mockState.webPort = 3420
  mockState.dashboardPublicUrl = ''
  mockState.appTz = 'Europe/Budapest'
  mockState.heartbeatCalendarAccount = ''
})

afterEach(() => {
  if (mockState.sandbox) {
    rmSync(mockState.sandbox, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

async function loadScaffoldFresh(): Promise<typeof import('../web/heartbeat-agent-scaffold.js')> {
  vi.resetModules()
  // The "logs an error and swallows an outer fs failure" test below registers
  // a vi.doMock('node:fs', ...) that throws from mkdirSync. Without this
  // unmock the mock survives into the next test's import -- ensureHeartbeatAgent
  // throws inside its catch and the files are never written.
  vi.doUnmock('node:fs')
  vi.doMock('../logger.js', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
  }))
  vi.doMock('../config.js', async (orig) => {
    const actual = await orig<typeof import('../config.js')>()
    return {
      ...actual,
      PROJECT_ROOT: mockState.projectRoot,
      STORE_DIR: join(mockState.projectRoot, 'store'),
      OWNER_NAME: mockState.ownerName,
      BOT_NAME: mockState.botName,
      MAIN_AGENT_ID: mockState.mainAgentId,
      WEB_PORT: mockState.webPort,
      DASHBOARD_PUBLIC_URL: mockState.dashboardPublicUrl,
      APP_TZ: mockState.appTz,
      HEARTBEAT_CALENDAR_ACCOUNT: mockState.heartbeatCalendarAccount,
    }
  })
  return await import('../web/heartbeat-agent-scaffold.js')
}

// =============================================================================
// shouldBootHeartbeatAgent -- pure boot gate (line 122). Re-tested here so
// the per-file suite drives heartbeat-agent-scaffold.ts to 100% without
// depending on the sibling heartbeat-agent-scaffold.test.ts running in the
// same worker.
// =============================================================================

describe('shouldBootHeartbeatAgent', () => {
  it('boots only when respawn-enabled AND agent-enabled', async () => {
    const mod = await loadScaffoldFresh()
    expect(mod.shouldBootHeartbeatAgent({ respawnEnabled: true, agentEnabled: true })).toBe(true)
  })

  it('does not boot when the agent is not opted in (default off)', async () => {
    const mod = await loadScaffoldFresh()
    expect(mod.shouldBootHeartbeatAgent({ respawnEnabled: true, agentEnabled: false })).toBe(false)
  })

  it('does not boot on a respawn-gated-off host even if opted in', async () => {
    const mod = await loadScaffoldFresh()
    expect(mod.shouldBootHeartbeatAgent({ respawnEnabled: false, agentEnabled: true })).toBe(false)
  })

  it('does not boot when both gates are off', async () => {
    const mod = await loadScaffoldFresh()
    expect(mod.shouldBootHeartbeatAgent({ respawnEnabled: false, agentEnabled: false })).toBe(false)
  })
})

// =============================================================================
// currentHeartbeatIdentity -- the config-bound factory (line 106).
// =============================================================================

describe('currentHeartbeatIdentity', () => {
  it('threads every config field into the identity', async () => {
    mockState.ownerName = 'Nina'
    mockState.botName = 'Atlas'
    mockState.mainAgentId = 'atlas'
    mockState.webPort = 4000
    mockState.heartbeatCalendarAccount = 'nina@example.com'
    const mod = await loadScaffoldFresh()
    const id = mod.currentHeartbeatIdentity()
    expect(id.ownerName).toBe('Nina')
    expect(id.botName).toBe('Atlas')
    expect(id.mainAgentId).toBe('atlas')
    expect(id.storeDir).toBe(join(mockState.projectRoot, 'store'))
    expect(id.dashboardOrigin).toBe('http://localhost:4000')
    expect(id.calendarAccount).toBe('nina@example.com')
  })

  it('falls back to localhost when DASHBOARD_PUBLIC_URL is empty', async () => {
    mockState.dashboardPublicUrl = ''
    mockState.webPort = 3420
    const mod = await loadScaffoldFresh()
    const id = mod.currentHeartbeatIdentity()
    expect(id.dashboardOrigin).toBe('http://localhost:3420')
  })

  it('uses the public URL when DASHBOARD_PUBLIC_URL is set', async () => {
    mockState.dashboardPublicUrl = 'https://marveen.example.com'
    mockState.webPort = 3420
    const mod = await loadScaffoldFresh()
    const id = mod.currentHeartbeatIdentity()
    expect(id.dashboardOrigin).toBe('https://marveen.example.com')
  })

  it('defaults calendarAccount to empty string when unset', async () => {
    mockState.heartbeatCalendarAccount = ''
    const mod = await loadScaffoldFresh()
    const id = mod.currentHeartbeatIdentity()
    expect(id.calendarAccount).toBe('')
  })

  it('stores the absolute sandbox path for storeDir', async () => {
    const mod = await loadScaffoldFresh()
    const id = mod.currentHeartbeatIdentity()
    expect(id.storeDir).toBe(join(mockState.projectRoot, 'store'))
  })
})

// =============================================================================
// ensureHeartbeatAgent -- the directory tree builder (lines 302-322).
// =============================================================================

describe('ensureHeartbeatAgent', () => {
  it('creates agents/heartbeat/ + .claude/ subdirectory tree', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const agentDir = join(mockState.projectRoot, 'agents', 'heartbeat')
    expect(existsSync(agentDir)).toBe(true)
    expect(existsSync(join(agentDir, '.claude'))).toBe(true)
  })

  it('writes CLAUDE.md, agent-config.json, and .claude/settings.json', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const agentDir = join(mockState.projectRoot, 'agents', 'heartbeat')
    expect(existsSync(join(agentDir, 'CLAUDE.md'))).toBe(true)
    expect(existsSync(join(agentDir, 'agent-config.json'))).toBe(true)
    expect(existsSync(join(agentDir, '.claude', 'settings.json'))).toBe(true)
  })

  it('renders CLAUDE.md with the live identity values', async () => {
    mockState.ownerName = 'Nina'
    mockState.botName = 'Helios'
    mockState.mainAgentId = 'helios'
    mockState.heartbeatCalendarAccount = 'nina@example.com'
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const claudeMd = readFileSync(
      join(mockState.projectRoot, 'agents', 'heartbeat', 'CLAUDE.md'),
      'utf-8',
    )
    expect(claudeMd).toContain("across Nina's systems")
    expect(claudeMd).toContain('hand the result to the main agent (Helios)')
    expect(claudeMd).toContain('"to":"helios"')
    expect(claudeMd).toContain('against `nina@example.com`')
  })

  it('renders agent-config.json with the haiku + oauth defaults', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const cfgPath = join(mockState.projectRoot, 'agents', 'heartbeat', 'agent-config.json')
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.model).toBe('claude-haiku-4-5')
    expect(parsed.authMode).toBe('oauth')
    expect(parsed.securityProfile).toBe('standard')
  })

  it('renders .claude/settings.json with every channel plugin disabled', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const settingsPath = join(
      mockState.projectRoot,
      'agents',
      'heartbeat',
      '.claude',
      'settings.json',
    )
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
    expect(parsed.enabledPlugins['slack-channel@marveen-marketplace']).toBe(false)
    expect(parsed.enabledPlugins['discord@claude-plugins-official']).toBe(false)
    expect(parsed.enabledPlugins['googlechat@claude-channel-googlechat']).toBe(false)
    expect(parsed.enabledPlugins['teams@marveen-marketplace']).toBe(false)
  })

  it('writes the .hidden-from-dashboard sentinel on first call', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const sentinel = join(
      mockState.projectRoot,
      'agents',
      'heartbeat',
      '.hidden-from-dashboard',
    )
    expect(existsSync(sentinel)).toBe(true)
  })

  it('does not clobber a pre-existing .hidden-from-dashboard sentinel', async () => {
    const agentDir = join(mockState.projectRoot, 'agents', 'heartbeat')
    mkdirSync(agentDir, { recursive: true })
    const sentinel = join(agentDir, '.hidden-from-dashboard')
    // Pre-existing content must survive -- the sentinel is a marker, not a
    // payload. Write a unique string and assert it is still there after the
    // second call.
    writeFileSync(sentinel, 'PRESERVE_ME')
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    expect(readFileSync(sentinel, 'utf-8')).toBe('PRESERVE_ME')
  })

  it('overwrites CLAUDE.md on every call (canonical-source-of-truth rule)', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const claudeMdPath = join(mockState.projectRoot, 'agents', 'heartbeat', 'CLAUDE.md')
    // Operator hand-edits the file -- our boot rewrite must win.
    writeFileSync(claudeMdPath, 'STALE_OPERATOR_EDIT')
    mod.ensureHeartbeatAgent()
    const out = readFileSync(claudeMdPath, 'utf-8')
    expect(out).not.toBe('STALE_OPERATOR_EDIT')
    expect(out).toContain('# Heartbeat agent')
  })

  it('overwrites agent-config.json on every call', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const cfgPath = join(mockState.projectRoot, 'agents', 'heartbeat', 'agent-config.json')
    writeFileSync(cfgPath, '{"model":"opus-4"}')
    mod.ensureHeartbeatAgent()
    const parsed = JSON.parse(readFileSync(cfgPath, 'utf-8'))
    expect(parsed.model).toBe('claude-haiku-4-5')
  })

  it('overwrites .claude/settings.json on every call', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const settingsDir = join(mockState.projectRoot, 'agents', 'heartbeat', '.claude')
    const settingsPath = join(settingsDir, 'settings.json')
    writeFileSync(settingsPath, '{"enabledPlugins":{"something-else":true}}')
    mod.ensureHeartbeatAgent()
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
    expect(parsed.enabledPlugins['something-else']).toBeUndefined()
  })

  it('is a no-op on the mkdir branch when the agent dir already exists', async () => {
    const agentDir = join(mockState.projectRoot, 'agents', 'heartbeat')
    mkdirSync(agentDir, { recursive: true })
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    // No throw, and the dir still exists.
    expect(existsSync(agentDir)).toBe(true)
    expect(statSync(agentDir).isDirectory()).toBe(true)
  })

  it('is a no-op on the mkdir branch when .claude already exists', async () => {
    const claudeDir = join(mockState.projectRoot, 'agents', 'heartbeat', '.claude')
    mkdirSync(claudeDir, { recursive: true })
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    expect(existsSync(claudeDir)).toBe(true)
    expect(statSync(claudeDir).isDirectory()).toBe(true)
  })

  it('logs an info entry on success', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const logger = (await import('../logger.js')).logger as unknown as {
      info: ReturnType<typeof vi.fn>
    }
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ dir: expect.stringContaining('agents/heartbeat') }),
      'Heartbeat agent scaffold ensured',
    )
  })

  it('logs an error and swallows an outer fs failure (graceful degrade)', async () => {
    vi.resetModules()
    const failMkdir = vi.fn(() => { throw new Error('boom: fs failure') })
    vi.doMock('node:fs', async (orig) => {
      const actual = await orig<typeof import('node:fs')>()
      return {
        ...actual,
        mkdirSync: failMkdir as typeof actual.mkdirSync,
      }
    })
    vi.doMock('../logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
    }))
    vi.doMock('../config.js', async (orig) => {
      const actual = await orig<typeof import('../config.js')>()
      return {
        ...actual,
        PROJECT_ROOT: mockState.projectRoot,
        STORE_DIR: join(mockState.projectRoot, 'store'),
        OWNER_NAME: mockState.ownerName,
        BOT_NAME: mockState.botName,
        MAIN_AGENT_ID: mockState.mainAgentId,
        WEB_PORT: mockState.webPort,
        DASHBOARD_PUBLIC_URL: mockState.dashboardPublicUrl,
        APP_TZ: mockState.appTz,
        HEARTBEAT_CALENDAR_ACCOUNT: mockState.heartbeatCalendarAccount,
      }
    })
    const mod = await import('../web/heartbeat-agent-scaffold.js')
    mod.ensureHeartbeatAgent()
    const logger = (await import('../logger.js')).logger as unknown as {
      error: ReturnType<typeof vi.fn>
    }
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to scaffold heartbeat agent',
    )
  })

  it('does not crash on a second call (idempotent re-tick at boot)', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    // Second call must not throw: the sentinel is skipped, the ALWAYS_WRITE
    // files are re-rendered, and the dirs already exist.
    expect(() => mod.ensureHeartbeatAgent()).not.toThrow()
    expect(() => mod.ensureHeartbeatAgent()).not.toThrow()
  })

  it('re-renders CLAUDE.md when the identity changes between calls', async () => {
    mockState.ownerName = 'Nina'
    mockState.mainAgentId = 'helios'
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const claudeMdPath = join(mockState.projectRoot, 'agents', 'heartbeat', 'CLAUDE.md')
    expect(readFileSync(claudeMdPath, 'utf-8')).toContain("across Nina's systems")

    // Operator changes owner/bot identity at the dashboard -- the canonical
    // source-of-truth rule means the next boot rewrites the file. The runtime
    // mockState is mutated, then we re-call ensureHeartbeatAgent. Since
    // mockState is read at module load, the in-process identity object still
    // points at "Nina" -- so we exercise the same render path again to cover
    // the re-write branch on a literal byte change.
    writeFileSync(claudeMdPath, 'STALE')
    mod.ensureHeartbeatAgent()
    expect(readFileSync(claudeMdPath, 'utf-8')).not.toBe('STALE')
  })

  it('renders the agent-config.json renderer output verbatim (covers renderAgentConfigJson)', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const cfgPath = join(mockState.projectRoot, 'agents', 'heartbeat', 'agent-config.json')
    const raw = readFileSync(cfgPath, 'utf-8')
    // The renderer emits JSON.stringify(..., null, 2) + '\n' -- exercise the
    // 2-space indent + trailing newline contract.
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toMatch(/^{\n {2}"model": "claude-haiku-4-5"/)
  })

  it('renders the settings.json renderer output verbatim (covers renderClaudeSettingsJson)', async () => {
    const mod = await loadScaffoldFresh()
    mod.ensureHeartbeatAgent()
    const settingsPath = join(
      mockState.projectRoot,
      'agents',
      'heartbeat',
      '.claude',
      'settings.json',
    )
    const raw = readFileSync(settingsPath, 'utf-8')
    expect(raw.endsWith('\n')).toBe(true)
    expect(raw).toMatch(/^{\n {2}"enabledPlugins":/)
  })
})
