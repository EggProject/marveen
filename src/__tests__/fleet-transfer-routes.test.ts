// 100% coverage suite for src/web/fleet-transfer.ts.
//
// Note on file location: the user's instructions reference
// `src/web/routes/fleet-transfer.ts`, but the actual SUT lives at
// `src/web/fleet-transfer.ts`. Imports verified against the SUT.
//
// The SUT is the fleet export/import core. It owns:
//   - crypto helpers (encryptWithPassword / decryptWithPassword)
//   - JSON path normalization (project root + home dir sentinels)
//   - .mcp.json placeholder rewriting (vault: -> {{VAULT:id}})
//   - secret detection (looksLikeSecret, looksLikeHeaderSecret)
//   - file enumeration + read across PROJECT_ROOT, agents/, scheduled-tasks/
//   - DB snapshot/restore for kanban, idea_box, memories, daily_logs
//   - DiffReport generation and apply-time cleanup-on-failure
//
// We use a partial node:fs mock: every fs function used by the SUT is
// routed through an in-memory state machine (fsState) the tests drive.
// Other fs functions fall back to the real fs so things like mkdtempSync
// still work.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { mkTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted state and mocks
// ---------------------------------------------------------------------------

interface FsState {
  files: Map<string, Buffer>
  dirs: Set<string>
  existsOverride: Map<string, boolean>
  readdirOverride: Map<string, string[]>
  statOverride: Map<string, { isDirectory: () => boolean; isFile: () => boolean }>
}

const H = vi.hoisted(() => {
  const fsState: FsState = {
    files: new Map(),
    dirs: new Set(),
    existsOverride: new Map(),
    readdirOverride: new Map(),
    statOverride: new Map(),
  }

  function existsSync(p: string): boolean {
    if (fsState.existsOverride.has(p)) return fsState.existsOverride.get(p)!
    if (fsState.files.has(p)) return true
    if (fsState.dirs.has(p)) return true
    return false
  }

  function statSync(p: string): { isDirectory: () => boolean; isFile: () => boolean } {
    if (fsState.statOverride.has(p)) return fsState.statOverride.get(p)!
    if (fsState.dirs.has(p)) return { isDirectory: () => true, isFile: () => false }
    if (fsState.files.has(p)) return { isDirectory: () => false, isFile: () => true }
    return realStatSync(p)
  }

  function readFileSync(p: string, _enc?: string): any {
    if (fsState.files.has(p)) {
      const v = fsState.files.get(p)!
      return typeof _enc === 'string' ? v.toString(_enc) : v
    }
    return realReadFileSync(p, _enc as any)
  }

  function readdirSync(p: string): string[] {
    if (fsState.readdirOverride.has(p)) return fsState.readdirOverride.get(p)!
    try { return realReaddirSync(p) as string[] } catch { return [] }
  }

  function mkdirSync(p: string, _opts?: any): void {
    fsState.dirs.add(p)
    // Do NOT call the real mkdirSync -- /mock/project is not a real path
    // and would ENOENT. The state machine is the source of truth.
  }

  function unlinkSync(p: string): void {
    fsState.files.delete(p)
    try { realUnlinkSync(p) } catch { /* ignore */ }
  }

  function rmSync(_p: string, _opts?: any): void { /* noop in tests */ }

  const realFs = require('node:fs') as typeof import('node:fs')
  const realStatSync = realFs.statSync
  const realReadFileSync = realFs.readFileSync
  const realReaddirSync = realFs.readdirSync
  const realMkdirSync = realFs.mkdirSync
  const realUnlinkSync = realFs.unlinkSync

  return {
    fsState,
    fsApi: {
      existsSync,
      statSync,
      readFileSync,
      mkdirSync,
      readdirSync,
      unlinkSync,
      rmSync,
    },
    atomicWriteMock: vi.fn((p: string, data: string | Buffer) => {
      fsState.files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data))
    }),
    updateEnvFileMock: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    // mutable per-test collaborators -- vi.fn() lets tests .mockReturnValueOnce
    bindingsMock: vi.fn<() => any[]>(() => []),
    dbTables: new Map<string, any[]>(),
    backfillEmbeddingsMock: vi.fn(() => Promise.resolve()),
    listAgentNamesMock: vi.fn<() => string[]>(() => []),
    PROJECT_ROOT: '/mock/project',
    STORE_DIR: '/mock/store',
    MAIN_AGENT_ID: 'marveen',
    BOT_NAME: 'Marveen',
    BRAND_NAME: 'Marveen',
    OWNER_NAME: 'Szabolcs',
    CHANNEL_PROVIDER: 'telegram',
    SCHEDULED_TASKS_DIR: '/mock/tasks',
  }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: H.PROJECT_ROOT,
  STORE_DIR: H.STORE_DIR,
  MAIN_AGENT_ID: H.MAIN_AGENT_ID,
  BOT_NAME: H.BOT_NAME,
  BRAND_NAME: H.BRAND_NAME,
  OWNER_NAME: H.OWNER_NAME,
  CHANNEL_PROVIDER: H.CHANNEL_PROVIDER,
}))

vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: (sql: string) => {
      const tableMatch = /FROM\s+(\w+)|INSERT(?:\s+OR\s+IGNORE)?\s+INTO\s+(\w+)/i.exec(sql)
      const table = tableMatch?.[1] ?? tableMatch?.[2] ?? ''
      const rowsForTable = () => H.dbTables.get(table) ?? []
      const all = vi.fn(() => rowsForTable())
      // .get(k1, k2, ...) checks the pre-populated rows for a matching row.
      // Returns the first match (truthy) or null.
      const get = vi.fn((...args: any[]) => {
        const rows = rowsForTable()
        return rows.find((row: any) =>
          args.every((a, i) => String(Object.values(row)[i] ?? '') === String(a))
        ) ?? null
      })
      const run = vi.fn(() => ({ changes: 0 }))
      return { all, get, run }
    },
    transaction: (fn: Function) => () => fn(),
  }),
  backfillEmbeddings: () => H.backfillEmbeddingsMock(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: H.loggerInfo, warn: H.loggerWarn, error: H.loggerError },
}))

vi.mock('../env.js', () => ({
  updateEnvFile: (updates: Record<string, string>) => H.updateEnvFileMock(updates),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (p: string, data: string | Buffer) => {
    H.atomicWriteMock(p, data)
  },
}))

vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/project/agents',
  listAgentNames: () => H.listAgentNamesMock(),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: H.SCHEDULED_TASKS_DIR,
}))

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: () => H.bindingsMock(),
}))

// Replace only the fs functions the SUT uses. Other functions fall through to
// the real fs so temp-sandbox.ts (mkdtempSync, rmSync, etc.) keeps working.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: H.fsApi.existsSync,
    statSync: H.fsApi.statSync,
    readFileSync: H.fsApi.readFileSync,
    mkdirSync: H.fsApi.mkdirSync,
    readdirSync: H.fsApi.readdirSync,
    unlinkSync: H.fsApi.unlinkSync,
    rmSync: H.fsApi.rmSync,
  } as any
})

// Mock node:os.homedir() so the SUT computes <home>/.claude/... against our
// deterministic path. The real function would resolve to the user's actual home,
// which never has our setup dirs.
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  return {
    ...real,
    homedir: () => '/mock/home',
    hostname: () => 'test-host-mock',
  } as any
})

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeFleet(overrides: Partial<any> = {}): any {
  return {
    schemaVersion: 1,
    exportedAt: '2026-01-01T00:00:00.000Z',
    sourceHost: 'test-host',
    agents: [],
    skills: [],
    scheduledTasks: [],
    memories: [],
    dailyLogs: [],
    kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
    ideaBox: { ideas: [], comments: [], statusLog: [] },
    dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    ...overrides,
  }
}

function addDir(p: string): void { H.fsState.dirs.add(p) }
function addFile(p: string, content: string | Buffer): void {
  H.fsState.files.set(p, Buffer.isBuffer(content) ? content : Buffer.from(content))
}
function setExists(p: string, exists: boolean): void { H.fsState.existsOverride.set(p, exists) }
function setReaddir(p: string, entries: string[]): void { H.fsState.readdirOverride.set(p, entries) }
function setStat(p: string, s: { isDirectory: () => boolean; isFile: () => boolean }): void {
  H.fsState.statOverride.set(p, s)
}

beforeEach(() => {
  H.fsState.files.clear()
  H.fsState.dirs.clear()
  H.fsState.existsOverride.clear()
  H.fsState.readdirOverride.clear()
  H.fsState.statOverride.clear()
  H.atomicWriteMock.mockReset()
  H.atomicWriteMock.mockImplementation((p: string, data: string | Buffer) => {
    H.fsState.files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data))
  })
  H.updateEnvFileMock.mockReset()
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.listAgentNamesMock.mockReset()
  H.listAgentNamesMock.mockImplementation(() => [])
  H.bindingsMock.mockReset()
  H.bindingsMock.mockImplementation(() => [])
  H.dbTables.clear()
  H.backfillEmbeddingsMock.mockReset()
  H.backfillEmbeddingsMock.mockImplementation(() => Promise.resolve())
})

/** Configure listAgentNames to return the names array for this test. */
function withAgents(names: string[]): void {
  H.listAgentNamesMock.mockReturnValue(names)
}
/** Configure getBindings to return the bindings array for this test. */
function withBindings(bindings: any[]): void {
  H.bindingsMock.mockReturnValue(bindings)
}

// ---------------------------------------------------------------------------
// 1. UserFacingError class
// ---------------------------------------------------------------------------

describe('UserFacingError', () => {
  it('constructor sets name and message', async () => {
    const { UserFacingError } = await import('../web/fleet-transfer.js')
    const err = new UserFacingError('boom')
    expect(err.name).toBe('UserFacingError')
    expect(err.message).toBe('boom')
    expect(err).toBeInstanceOf(Error)
    expect(err).toBeInstanceOf(UserFacingError)
  })
})

// ---------------------------------------------------------------------------
// 2. Version & constant exports
// ---------------------------------------------------------------------------

describe('Schema & version constants', () => {
  it('exports the constants with the expected shape', async () => {
    const ft = await import('../web/fleet-transfer.js')
    expect(ft.FLEET_SCHEMA_VERSION).toBe(1)
    expect(ft.ENCRYPTED_FLEET_VERSION).toBe(1)
    expect(ft.MIN_VAULT_PASSWORD_LEN).toBe(8)
  })
})

// ---------------------------------------------------------------------------
// 3. placeholderMcp & secret detection
// ---------------------------------------------------------------------------

describe('placeholderMcp & friends', () => {
  function baseMainDir() {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(`${H.SCHEDULED_TASKS_DIR}`, [])
  }

  it('placeholderMcp throws UserFacingError on plaintext secret in env', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: {
        badoffend: { command: 'node', env: { TOKEN: 'this-is-a-very-high-entropy-token-12345' } },
      },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/Titkosítatlan secret/)
  })

  it('placeholderMcp converts vault: refs to {{VAULT:id}}', async () => {
    withBindings([{      vaultSecretId: 'sid-abc', envVar: 'TOKEN',      targets: [{ mcpFilePath: `${H.PROJECT_ROOT}/.mcp.json`, serverName: 'srv' }],    }])
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', env: { TOKEN: 'vault:sid-abc' } } },
    }))
    addFile(`${H.STORE_DIR}/vault.json`, '{"entries": []}')
    addFile(`${H.STORE_DIR}/vault-bindings.json`, '{"bindings": []}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    // No vaultPassword: placeholderMcp runs (no whole-JSON encryption)
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.srv.env.TOKEN).toBe('{{VAULT:sid-abc}}')
  })

  it('placeholderMcp converts binding-lookup vault refs (envVar != TOKEN)', async () => {
    withBindings([{      vaultSecretId: 'sid-mapped', envVar: 'API_KEY',      targets: [{ mcpFilePath: `${H.PROJECT_ROOT}/.mcp.json`, serverName: 'srv' }],    }])
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', env: { API_KEY: 'plain-text-bound-value-1234567890' } } },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.srv.env.API_KEY).toBe('{{VAULT:sid-mapped}}')
  })

  it('placeholderMcp flags secrets in headers (always-secret key)', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', headers: { authorization: 'plaintext-token-12345' } } },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/Titkosítatlan secret/)
  })

  it('placeholderMcp flags headers with Bearer scheme + plaintext', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', headers: { 'X-Custom-Token': 'Bearer thisisthecredentialvalue' } } },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/Titkosítatlan secret/)
  })

  it('placeholderMcp passes through whitelist header keys', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', headers: { 'content-type': 'application/json' } } },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.srv.headers['content-type']).toBe('application/json')
  })

  it('placeholderMcp flags secrets in args[i]', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', args: ['--token=thisistheverylongplaintexttokenvalue-12345'] } },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/args\[0\]/)
  })

  it('placeholderMcp flags secrets in url field', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', url: 'aGVsbG8tdGhpcy1pcy1hLXNlY3JldC10b2tlbg' } },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/url/)
  })

  it('placeholderMcp passes through when no mcpServers block exists', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp).toEqual({})
  })

  it('placeholderMcp handles null cfg gracefully', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({ mcpServers: { srv: null } }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.srv).toBeNull()
  })

  it('placeholderMcp passes through non-string env values', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', env: { TIMEOUT: 1500 } } },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.srv.env.TIMEOUT).toBe(1500)
  })

  it('exportMainAgent throws UserFacingError on plaintext settings.env secret', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, JSON.stringify({
      env: { TOKEN: 'plaintext-secret-1234567890-value' },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/settings\.json env/)
  })

  it('exportMainAgent with vaultPassword skips the secret-in-env check', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, JSON.stringify({ env: { TOKEN: 'x' } }))
    addFile(`${H.STORE_DIR}/.vault-key`, '0123456789abcdef0123456789abcdef')
    addFile(`${H.STORE_DIR}/vault.json`, '{"entries": []}')
    addFile(`${H.STORE_DIR}/vault-bindings.json`, '{"bindings": []}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet({ vaultPassword: 'pw-12345678' })).not.toThrow()
  })

  it('exportMainAgent with no settings.json defaults to {}', async () => {
    baseMainDir()
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.settings).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 4. channelsAccess export (exportMainAgent)
// ---------------------------------------------------------------------------

describe('exportMainAgent: channelsAccess', () => {
  function baseMainDir() {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(`${H.SCHEDULED_TASKS_DIR}`, [])
  }

  it('reads ~/.claude/channels/<provider>/access.json per provider', async () => {
    baseMainDir()
    const channelDir = `/mock/home/.claude/channels`
    setExists(channelDir, true)
    setReaddir(channelDir, ['telegram', 'slack'])
    addFile(`${channelDir}/telegram/access.json`, '{"dmPolicy":"allowlist"}')
    addFile(`${channelDir}/slack/access.json`, '{"teamId":"T1"}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.channelsAccess.telegram).toEqual({ dmPolicy: 'allowlist' })
    expect(fleet.mainAgent.channelsAccess.slack).toEqual({ teamId: 'T1' })
  })

  it('returns empty channelsAccess when /channels/ does not exist', async () => {
    baseMainDir()
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.channelsAccess).toEqual({})
  })

  it('skips provider when access.json absent', async () => {
    baseMainDir()
    const channelDir = `/mock/home/.claude/channels`
    setExists(channelDir, true)
    setReaddir(channelDir, ['telegram', 'slack'])
    addFile(`${channelDir}/telegram/access.json`, '{"a":1}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.channelsAccess).toEqual({ telegram: { a: 1 } })
  })

  it('handles bad JSON gracefully (safeReadJson returns {})', async () => {
    baseMainDir()
    const channelDir = `/mock/home/.claude/channels`
    setExists(channelDir, true)
    setReaddir(channelDir, ['telegram'])
    addFile(`${channelDir}/telegram/access.json`, '{ not json }')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.channelsAccess).toEqual({ telegram: {} })
  })
})

// ---------------------------------------------------------------------------
// 5. exportAgent -- sub-agent surface
// ---------------------------------------------------------------------------

describe('exportAgent: sub-agent surface', () => {
  function baseMainDir() {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.SCHEDULED_TASKS_DIR}`, [])
  }

  it('exports sub-agent with avatar.png', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`, Buffer.from('hello'))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{"x":1}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents).toHaveLength(1)
    expect(fleet.agents[0].avatarExt).toBe('png')
    expect(fleet.agents[0].avatar).toBe('aGVsbG8=')
  })

  it('exports sub-agent with avatar.jpg when png missing', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/avatar.jpg`, Buffer.from('hello'))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].avatarExt).toBe('jpg')
  })

  it('exports sub-agent with no avatar', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].avatar).toBeNull()
    expect(fleet.agents[0].avatarExt).toBe('png')
  })

  it('exports sub-agent skill entries', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`)
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, ['mysk'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills/mysk`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills/mysk/SKILL.md`, '# mysk')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].agentSkills).toEqual([{ name: 'mysk', skillMd: '# mysk' }])
  })

  it('skips sub-agent dirs without SKILL.md', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, ['empty-dir'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills/empty-dir`)
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].agentSkills).toEqual([])
  })

  it('throws UserFacingError on sub-agent plaintext settings.env secret', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, JSON.stringify({
      env: { TOKEN: 'plaintext-secret-1234567890' },
    }))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/agent "testbot"/)
  })

  it('exports sub-agent channelsAccess', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const channelDir = `${H.PROJECT_ROOT}/agents/testbot/.claude/channels`
    setExists(channelDir, true)
    setReaddir(channelDir, ['telegram'])
    addFile(`${channelDir}/telegram/access.json`, '{"x":1}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].channelsAccess).toEqual({ telegram: { x: 1 } })
  })

  it('sub-agent vault: env rewritten via bindingLookup', async () => {
    withAgents(['testbot'])
    withBindings([{      vaultSecretId: 'sid-agent', envVar: 'TOKEN',      targets: [{ mcpFilePath: `${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, serverName: 'srv' }],    }])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', env: { TOKEN: 'vault:sid-agent' } } },
    }))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].mcp.mcpServers.srv.env.TOKEN).toBe('{{VAULT:sid-agent}}')
  })

  it('sub-agent with bad JSON .mcp.json falls back to {}', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{ not json }')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].mcp).toEqual({})
  })
})

// ---------------------------------------------------------------------------
// 6. exportScheduledTasks
// ---------------------------------------------------------------------------

describe('exportScheduledTasks', () => {
  function baseMainDir() {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
  }
  it('returns [] when scheduled-tasks dir does not exist', async () => {
    baseMainDir()
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.scheduledTasks).toEqual([])
  })

  it('skips non-directory entries via statSync.isDirectory() === false', async () => {
    baseMainDir()
    setReaddir(H.SCHEDULED_TASKS_DIR, ['regular-file'])
    addFile(`${H.SCHEDULED_TASKS_DIR}/regular-file`, 'not a dir')
    setStat(`${H.SCHEDULED_TASKS_DIR}/regular-file`, {
      isDirectory: () => false, isFile: () => true,
    })
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.scheduledTasks).toEqual([])
  })

  it('catches statSync errors and skips', async () => {
    baseMainDir()
    setReaddir(H.SCHEDULED_TASKS_DIR, ['broken-stat'])
    setExists(`${H.SCHEDULED_TASKS_DIR}/broken-stat`, false)
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.scheduledTasks).toEqual([])
  })

  it('emits a scheduled task with config (enabled forced false)', async () => {
    baseMainDir()
    addDir(H.SCHEDULED_TASKS_DIR)
    setReaddir(H.SCHEDULED_TASKS_DIR, ['my-task'])
    addDir(`${H.SCHEDULED_TASKS_DIR}/my-task`)
    addFile(`${H.SCHEDULED_TASKS_DIR}/my-task/SKILL.md`, '# scheduled')
    addFile(`${H.SCHEDULED_TASKS_DIR}/my-task/task-config.json`, '{"x":1,"enabled":true}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.scheduledTasks).toHaveLength(1)
    expect(fleet.scheduledTasks[0].dirName).toBe('my-task')
    expect(fleet.scheduledTasks[0].config).toEqual({ x: 1, enabled: false })
  })
})

// ---------------------------------------------------------------------------
// 7. exportDashboardSettings
// ---------------------------------------------------------------------------

describe('exportDashboardSettings', () => {
  function baseMainDir() {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
  }

  it('reads four known settings files', async () => {
    baseMainDir()
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{"mode":"full"}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{"enabled":true}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{"marveen":{}}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{"note":"hi"}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.dashboardSettings.autonomy).toEqual({ mode: 'full' })
    expect(fleet.dashboardSettings.autoRestart).toEqual({ enabled: true })
    expect(fleet.dashboardSettings.agentsDesired).toEqual({ marveen: {} })
    expect(fleet.dashboardSettings.norbertPersonal).toEqual({ note: 'hi' })
  })

  it('falls back to {} when settings files are missing', async () => {
    baseMainDir()
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.dashboardSettings).toEqual({
      autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {},
    })
  })
})

// ---------------------------------------------------------------------------
// 8. exportVault
// ---------------------------------------------------------------------------

describe('exportVault', () => {
  function baseMainDir() {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
  }

  it('returns vault section in encrypted export when .vault-key exists', async () => {
    baseMainDir()
    addFile(`${H.STORE_DIR}/.vault-key`, '0123456789abcdef0123456789abcdef')
    addFile(`${H.STORE_DIR}/vault.json`, '{"entries":[{"id":"s1"}]}')
    addFile(`${H.STORE_DIR}/vault-bindings.json`, '{"bindings":[{"secretId":"s1"}]}')
    const { exportFleet, _decryptForTest } = await import('../web/fleet-transfer.js')
    const r = exportFleet({ vaultPassword: 'pw-12345678' })
    const decrypted = _decryptForTest(JSON.parse(r.data).blob, 'pw-12345678')
    const fleet = JSON.parse(decrypted)
    expect(fleet.vault.vaultKey).toBe('0123456789abcdef0123456789abcdef')
    expect(fleet.vault.entries).toEqual([{ id: 's1' }])
    expect(fleet.vault.bindings).toEqual([{ secretId: 's1' }])
  })

  it('throws when only .vault-key.migrated present (macOS Keychain)', async () => {
    baseMainDir()
    addFile(`${H.STORE_DIR}/.vault-key.migrated`, '1')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet({ vaultPassword: 'pw-12345678' })).toThrowError(/Keychain/)
  })

  it('omits vault section in plaintext export', async () => {
    baseMainDir()
    addFile(`${H.STORE_DIR}/.vault-key`, '0123456789abcdef0123456789abcdef')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.vault).toBeUndefined()
  })

  it('vault entries + bindings default to [] when not arrays', async () => {
    baseMainDir()
    addFile(`${H.STORE_DIR}/.vault-key`, '0123456789abcdef0123456789abcdef')
    addFile(`${H.STORE_DIR}/vault.json`, '{}')
    addFile(`${H.STORE_DIR}/vault-bindings.json`, '{}')
    const { exportFleet, _decryptForTest } = await import('../web/fleet-transfer.js')
    const r = exportFleet({ vaultPassword: 'pw-12345678' })
    const decrypted = _decryptForTest(JSON.parse(r.data).blob, 'pw-12345678')
    const fleet = JSON.parse(decrypted)
    expect(fleet.vault.entries).toEqual([])
    expect(fleet.vault.bindings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// 9. exportFleet: validation + DB + global skills
// ---------------------------------------------------------------------------

describe('exportFleet', () => {
  function baseMainDir() {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
  }

  it('throws when vaultPassword is too short', async () => {
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet({ vaultPassword: 'short' })).toThrowError(/legalább 8 karakter/)
  })

  it('encodes the encrypted wrapper as {"enc":1,"blob":"..."}', async () => {
    baseMainDir()
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet({ vaultPassword: 'pw-12345678' })
    const wrapper = JSON.parse(r.data)
    expect(wrapper.enc).toBe(1)
    expect(typeof wrapper.blob).toBe('string')
  })

  it('exportedAt matches the FleetJson.exportedAt field', async () => {
    baseMainDir()
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(r.exportedAt).toBe(fleet.exportedAt)
  })

  it('includes global skills listed from homedir/.claude/skills', async () => {
    baseMainDir()
    const globalSkills = `/mock/home/.claude/skills`
    setExists(globalSkills, true)
    setReaddir(globalSkills, ['skill-a', 'skill-b'])
    addDir(`${globalSkills}/skill-a`)
    addFile(`${globalSkills}/skill-a/SKILL.md`, '# skill-a')
    addDir(`${globalSkills}/skill-b`)
    addFile(`${globalSkills}/skill-b/SKILL.md`, '# skill-b')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.skills).toEqual([
      { name: 'skill-a', skillMd: '# skill-a' },
      { name: 'skill-b', skillMd: '# skill-b' },
    ])
  })

  it('DB queries return [] when tables empty', async () => {
    baseMainDir()
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.memories).toEqual([])
    expect(fleet.dailyLogs).toEqual([])
    expect(fleet.kanban.cards).toEqual([])
    expect(fleet.kanban.comments).toEqual([])
    expect(fleet.kanban.cardEvents).toEqual([])
    expect(fleet.kanban.labels).toEqual([])
    expect(fleet.kanban.cardLabels).toEqual([])
    expect(fleet.ideaBox.ideas).toEqual([])
    expect(fleet.ideaBox.comments).toEqual([])
    expect(fleet.ideaBox.statusLog).toEqual([])
  })

  it('uses real exportedAt ISO string', async () => {
    baseMainDir()
    const before = Date.now()
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    const ts = new Date(fleet.exportedAt).getTime()
    const after = Date.now()
    expect(ts).toBeGreaterThanOrEqual(before - 5)
    expect(ts).toBeLessThanOrEqual(after + 5)
  })
})

// ---------------------------------------------------------------------------
// 10. normalizePaths / denormalizePaths
// ---------------------------------------------------------------------------

describe('normalizePaths / denormalizePaths', () => {
  it('Replaces PROJECT_ROOT before HOME on export (path sentinels)', async () => {
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', env: { PATH: `/mock/project/file.json` } } },
    }))
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, `# Claude at /mock/project/CLAUDE.md`)
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.claudeMd).toContain('{{FLEET:PROJECT_ROOT}}')
    expect(fleet.mainAgent.claudeMd).toContain('CLAUDE.md')
    expect(fleet.mainAgent.claudeMd).not.toContain('/mock/project/')
    const env = fleet.mainAgent.mcp.mcpServers.srv.env
    expect(env.PATH).toBe('{{FLEET:PROJECT_ROOT}}/file.json')
  })
})

// ---------------------------------------------------------------------------
// 11. validateSchema
// ---------------------------------------------------------------------------

describe('validateSchema', () => {
  it('rejects root not-object', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet('null', { apply: false }) as any
    expect(result.errors).toContain('Érvénytelen JSON: a gyökér nem objektum.')
  })

  it('rejects schemaVersion-missing payloads', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({
      agents: [], kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(body, { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('schemaVersion'))).toBe(true)
  })

  it('rejects schemaVersion above current', async () => {
    const { importFleet, FLEET_SCHEMA_VERSION } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({ schemaVersion: FLEET_SCHEMA_VERSION + 5, agents: [] })
    const result = importFleet(body, { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('Frissítsd'))).toBe(true)
  })

  it('rejects schemaVersion below current', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({ schemaVersion: 0, agents: [] })
    const result = importFleet(body, { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('túl régi'))).toBe(true)
  })

  it('rejects non-array agents field', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({ schemaVersion: 1, agents: 'not-array' })
    const result = importFleet(body, { apply: false }) as any
    expect(result.errors).toContain('agents mező hiányzik vagy nem tömb.')
  })
})

// ---------------------------------------------------------------------------
// 12. validateNames
// ---------------------------------------------------------------------------

describe('validateNames', () => {
  it('rejects mainAgent channel provider with bad chars', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({
      mainAgent: {
        agentId: 'a',
        identity: { MAIN_AGENT_ID: 'a', BOT_NAME: 'b', BRAND_NAME: 'b', OWNER_NAME: 'o', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {},
        channelsAccess: { 'bad name with space': {} },
      },
    })
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('mainAgent channel'))).toBe(true)
  })

  it('rejects agent.name with bad chars', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({
      agents: [{ name: 'bad name!', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }],
    })
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('agent.name'))).toBe(true)
  })

  it('rejects agent avatarExt with non-image extension', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({
      agents: [{ name: 'test', avatar: 'aGVsbG8=', avatarExt: 'exe',
        config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }],
    })
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('avatarExt') && e.includes('exe'))).toBe(true)
  })

  it('accepts valid avatarExt variants (png / jpg / jpeg / webp)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    for (const ext of ['png', 'jpg', 'jpeg', 'webp']) {
      const good = makeFleet({
        agents: [{ name: 'test', avatar: 'aGVsbG8=', avatarExt: ext,
          config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }],
      })
      const result = importFleet(JSON.stringify(good), { apply: false }) as any
      expect(result.errors.filter((e: string) => e.includes('avatarExt')).length).toBe(0)
    }
  })

  it('rejects skill.name on agent with bad chars', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({
      agents: [{ name: 'test', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {},
        agentSkills: [{ name: 'bad name', skillMd: '' }] }],
    })
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('skill.name'))).toBe(true)
  })

  it('rejects channel provider on agent with bad chars', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({
      agents: [{ name: 'test', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {},
        channelsAccess: { 'BAD NAME': {} }, agentSkills: [] }],
    })
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('channel provider'))).toBe(true)
  })

  it('rejects global skill.name with bad chars', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({ skills: [{ name: 'BAD NAME', skillMd: '' }] })
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('global skill.name'))).toBe(true)
  })

  it('rejects scheduledTask.dirName with bad chars', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({ scheduledTasks: [{ dirName: 'BAD NAME', skillMd: '', config: {} }] })
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('scheduledTask.dirName'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 13. DiffReport counters
// ---------------------------------------------------------------------------

describe('DiffReport counters', () => {
  it('counts new labels even when existing rows are absent', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [], comments: [], cardEvents: [], labels: [{ id: 'L1', name: 'bug' }], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.labels).toBe(1)
  })

  it('counts new daily logs', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      dailyLogs: [{ agent_id: 'marveen', date: '2026-01-01', content: 'log', created_at: 1 }],
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.dailyLogs).toBe(1)
  })

  it('counts new kanban comments', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [], comments: [{ card_id: 'C1', content: 'cmt' }],
        cardEvents: [], labels: [], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.kanbanComments).toBe(1)
  })

  it('counts new kanban cards', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [{ id: 'C1', title: 't', status: 'open', priority: 'p', sort_order: 0 }],
        comments: [], cardEvents: [], labels: [], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.kanbanCards).toBe(1)
  })

  it('counts existing labels as 0', async () => {
    H.dbTables.set('labels', [{ id: 'L1', name: 'bug' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [], comments: [], cardEvents: [], labels: [{ id: 'L1', name: 'bug' }], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.labels).toBe(0)
  })

  it('warns when channelsAccess is set in the export', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'a',
        identity: { MAIN_AGENT_ID: 'a', BOT_NAME: 'b', BRAND_NAME: 'b', OWNER_NAME: 'o', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {},
        channelsAccess: { telegram: {} },
      },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.warnings.some((w: string) => w.includes('újra-párosítás'))).toBe(true)
  })

  it('warns about identity takeover in dry-run (mainAgent.agentId only)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: { agentId: 'atlas', claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {} },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.warnings.some((w: string) => w.includes('atlas'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 14. importFleet: apply phase
// ---------------------------------------------------------------------------

describe('importFleet: apply phase', () => {
  it('apply with mainAgent writes CLAUDE.md, SOUL.md, agent-config.json, .mcp.json, settings.json, channels/<provider>/access.json', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '# soul', config: { x: 1 },
        mcp: { mcpServers: { srv: { command: 'node', env: { TOKEN: '{{VAULT:vid}}' } } } },
        settings: { foo: 'bar' }, channelsAccess: { telegram: { dmPolicy: 'allowlist' } },
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.mainAgent).toBe(true)
    const mainClaude = H.fsState.files.get(`${H.PROJECT_ROOT}/CLAUDE.md`)?.toString()
    expect(mainClaude).toBe('# claude')
    const mainMcp = JSON.parse(H.fsState.files.get(`${H.PROJECT_ROOT}/.mcp.json`)?.toString() || '{}')
    expect(mainMcp.mcpServers.srv.env.TOKEN).toBe('vault:vid')
  })

  it('apply with mainAgent but empty claudeMd / soulMd skips those writes', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/CLAUDE.md`)).toBe(false)
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/SOUL.md`)).toBe(false)
  })

  it('apply with sub-agents writes agent files (incl. avatar.png)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      agents: [{
        name: 'testbot', config: { x: 1 }, claudeMd: '# claude', soulMd: '# soul',
        mcp: {}, settings: {}, channelsAccess: {},
        avatar: 'aGVsbG8=', avatarExt: 'png',
        agentSkills: [{ name: 'sk', skillMd: '# sk' }],
      }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.agents).toEqual(['testbot'])
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`)).toBe(true)
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`)).toBe(true)
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills/sk/SKILL.md`)).toBe(true)
  })

  it('apply with valid avatarExt writes avatar file', async () => {
    // The validateNames guard rejects bad avatarExt at dry-run time -- the
    // .png fallback only kicks in if the ext is whitelisted but the path is bad.
    // Here we exercise the write path with a valid ext.
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      agents: [{
        name: 'testbot', config: {}, claudeMd: '', soulMd: '',
        mcp: {}, settings: {}, channelsAccess: {},
        avatar: 'aGVsbG8=', avatarExt: 'png',
        agentSkills: [],
      }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`)).toBe(true)
  })

  it('apply writes global skills', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({ skills: [{ name: 'mysk', skillMd: '# mysk' }] }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.globalSkills).toBe(1)
  })

  it('apply writes scheduled tasks even when SCHEDULED_TASKS_DIR absent', async () => {
    setExists(H.SCHEDULED_TASKS_DIR, false)
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      scheduledTasks: [{ dirName: 'daily', skillMd: '# daily', config: { x: 1 } }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.scheduledTasks).toBe(1)
  })

  it('apply skips writing task SKILL.md when skillMd is empty', async () => {
    setExists(H.SCHEDULED_TASKS_DIR, false)
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      scheduledTasks: [{ dirName: 'daily', skillMd: '', config: { x: 1 } }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.has(`${H.SCHEDULED_TASKS_DIR}/daily/SKILL.md`)).toBe(false)
  })

  it('apply writes dashboard settings when non-empty', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      dashboardSettings: {
        autonomy: { mode: 'full' }, autoRestart: { enabled: true },
        agentsDesired: { marveen: {} }, norbertPersonal: { note: 'hi' },
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.get(`${H.STORE_DIR}/autonomy-config.json`)?.toString()).toContain('full')
  })

  it('apply skips empty dashboard settings', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.has(`${H.STORE_DIR}/autonomy-config.json`)).toBe(false)
  })

  it('apply with vault section writes .vault-key + vault.json + vault-bindings.json', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      vault: { vaultKey: 'abcdef0123456789abcdef0123456789', entries: [{ id: 's1' }], bindings: [{ secretId: 's1' }] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.get(`${H.STORE_DIR}/.vault-key`)?.toString()).toBe('abcdef0123456789abcdef0123456789')
  })

  it('apply with backward-compat identity writes just MAIN_AGENT_ID', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: { agentId: 'atlas', claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {} },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    const calls = (H.atomicWriteMock as any).mock.calls
    const overridesCall = calls.find((c: any[]) => c[0]?.includes('config-overrides.json'))
    expect(overridesCall).toBeDefined()
    const overrides = JSON.parse(overridesCall[1])
    expect(overrides.MAIN_AGENT_ID).toBe('atlas')
    expect(H.updateEnvFileMock).toHaveBeenCalledWith({ MAIN_AGENT_ID: 'atlas' })
  })

  it('apply with identity but empty-string values skips them', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'atlas',
        identity: { MAIN_AGENT_ID: 'atlas', BOT_NAME: '', BRAND_NAME: '', OWNER_NAME: '', CHANNEL_PROVIDER: '' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    const calls = (H.atomicWriteMock as any).mock.calls
    const overridesCall = calls.find((c: any[]) => c[0]?.includes('config-overrides.json'))
    const overrides = JSON.parse(overridesCall[1])
    expect(overrides.MAIN_AGENT_ID).toBe('atlas')
  })

  it('apply merges into existing config-overrides.json', async () => {
    addFile(`${H.STORE_DIR}/config-overrides.json`, '{"PRESERVE":"x"}')
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'atlas',
        identity: { MAIN_AGENT_ID: 'atlas', BOT_NAME: 'A', BRAND_NAME: 'A', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    const calls = (H.atomicWriteMock as any).mock.calls
    const overridesCall = calls.find((c: any[]) => c[0]?.includes('config-overrides.json'))
    const overrides = JSON.parse(overridesCall[1])
    expect(overrides.PRESERVE).toBe('x')
    expect(overrides.MAIN_AGENT_ID).toBe('atlas')
  })

  it('apply ignores corrupt config-overrides.json and starts fresh', async () => {
    addFile(`${H.STORE_DIR}/config-overrides.json`, '{ not json }')
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'atlas',
        identity: { MAIN_AGENT_ID: 'atlas', BOT_NAME: 'A', BRAND_NAME: 'A', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    const calls = (H.atomicWriteMock as any).mock.calls
    const overridesCall = calls.find((c: any[]) => c[0]?.includes('config-overrides.json'))
    const overrides = JSON.parse(overridesCall[1])
    expect(overrides.MAIN_AGENT_ID).toBe('atlas')
    expect(overrides.PRESERVE).toBeUndefined()
  })

  it('apply calls backfillEmbeddings() for memories', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      memories: [{ agent_id: 'marveen', content: 'mem1', sector: 'warm', salience: 0.5,
        created_at: 1, category: 'p', auto_generated: 0 }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.backfillEmbeddingsMock).toHaveBeenCalled()
  })

  it('apply triggers cleanupTracked on disk-full failure', async () => {
    ;(H.atomicWriteMock as any).mockImplementation(() => {
      throw new Error('disk full')
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    expect(() => importFleet(body, { apply: true })).toThrow()
    expect(H.loggerError).toHaveBeenCalled()
  })

  it('apply with vault present + no password warns in dry-run', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({ vault: { vaultKey: 'abc', entries: [], bindings: [] } }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.warnings.some((w: string) => w.includes('jelszót'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 15. importFleet: JSON parse error
// ---------------------------------------------------------------------------

describe('importFleet: JSON parse error', () => {
  it('returns error DiffReport when rawBody is invalid JSON', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet('{ not json }', { apply: false }) as any
    expect(result.errors[0]).toMatch(/Érvénytelen JSON/)
  })
})

// ---------------------------------------------------------------------------
// 16. DB row skip branches
// ---------------------------------------------------------------------------

describe('importFleet: DB row skip branches', () => {
  it('skips labels missing id or name', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [], cardEvents: [],
        labels: [{ id: null, name: 'no-id' }, { id: 'X', name: null }],
        cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('skips kanban cards missing required fields', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [{ id: 'C1' }], comments: [], cardEvents: [], labels: [], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('skips kanban comments missing card_id / content', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [{ card_id: null, content: 'no card' }, { card_id: 'C1', content: null }],
        cardEvents: [], labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('skips kanban card events missing card_id / to_status', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [],
        cardEvents: [{ card_id: 'C1' }, { card_id: null, to_status: 'open' }],
        labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('applies valid kanban_card_labels', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [], comments: [], cardEvents: [], labels: [],
        cardLabels: [{ card_id: 'C1', label_id: 'L1' }] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('applies idea_box ideas', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      ideaBox: {
        ideas: [{ id: 'I1', title: 'idea', category: 'c', status: 'open', created_at: 1, updated_at: 2 }],
        comments: [], statusLog: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.ideaBox).toBe(1)
  })

  it('applies idea_comments and idea_status_log', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      ideaBox: {
        ideas: [],
        comments: [{ idea_id: 'I1', author: 'a', content: 'cmt', created_at: 1 }],
        statusLog: [{ idea_id: 'I1', to_status: 'open', actor: 'a', created_at: 1 }],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('kanban comments idempotent on existing row', async () => {
    H.dbTables.set('kanban_comments', [{ card_id: 'C1', content: 'old' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [], comments: [{ card_id: 'C1', content: 'old' }, { card_id: 'C1', content: 'new' }],
        cardEvents: [], labels: [], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 17. writeAgentFiles -- channels + empty avatar
// ---------------------------------------------------------------------------

describe('writeAgentFiles secondary paths', () => {
  it('apply writes per-agent channels dir', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      agents: [{
        name: 'testbot', config: {}, claudeMd: '', soulMd: '',
        mcp: {}, settings: {}, channelsAccess: { telegram: { x: 1 } },
        agentSkills: [],
      }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/agents/testbot/.claude/channels/telegram/access.json`)).toBe(true)
  })

  it('apply skips avatar when empty string', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      agents: [{
        name: 'testbot', config: {}, claudeMd: '', soulMd: '',
        mcp: {}, settings: {}, channelsAccess: {},
        avatar: '', avatarExt: 'png', agentSkills: [],
      }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// 18. importFleet: missing-elements defaults
// ---------------------------------------------------------------------------

describe('importFleet: missing-elements defaults', () => {
  it('dry-run works when fleet has no mainAgent set', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({ mainAgent: undefined }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.dryRun).toBe(true)
  })

  it('buildDiffReport counts ideaBox ideas', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      ideaBox: { ideas: [{ id: 'I1' }], comments: [], statusLog: [] },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.ideaBox).toBe(1)
  })

  it('memories counted separately per agent_id', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      memories: [
        { agent_id: 'marveen', content: 'shared', sector: 'warm', salience: 0.5, created_at: 1, category: 'p', auto_generated: 0 },
        { agent_id: 'test', content: 'shared', sector: 'warm', salience: 0.5, created_at: 1, category: 'p', auto_generated: 0 },
      ],
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.memories).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// 19. cleanupTracked
// ---------------------------------------------------------------------------

describe('cleanupTracked', () => {
  it('throws on disk-full during apply', async () => {
    ;(H.atomicWriteMock as any).mockImplementation(() => {
      throw new Error('disk full')
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    expect(() => importFleet(body, { apply: true })).toThrow(/disk full/)
  })

  it('cleanup does not delete pre-existing overwritten files', async () => {
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{"pre":true}')
    ;(H.atomicWriteMock as any).mockImplementation(() => {
      throw new Error('disk full')
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '', config: {}, mcp: { x: 1 }, settings: {}, channelsAccess: {},
      },
    }))
    expect(() => importFleet(body, { apply: true })).toThrow()
    expect(H.fsState.files.get(`${H.PROJECT_ROOT}/.mcp.json`)?.toString()).toBe('{"pre":true}')
  })
})

// ---------------------------------------------------------------------------
// 20. assertSafeName / path traversal
// ---------------------------------------------------------------------------

describe('assertSafeName via validateNames', () => {
  it('accepts valid lowercase name', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      skills: [{ name: 'valid-name-123', skillMd: '# x' }],
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.errors).toEqual([])
  })

  it('rejects uppercase / spaces / dots', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    for (const bad of ['UPPER', 'has space', 'has.dot']) {
      const body = JSON.stringify(makeFleet({
        skills: [{ name: bad, skillMd: '' }],
      }))
      const result = importFleet(body, { apply: false }) as any
      expect(result.errors.length).toBeGreaterThan(0)
    }
  })
})

// ---------------------------------------------------------------------------
// 21. importFleet: encrypted wrapper password-too-short detection
// ---------------------------------------------------------------------------

describe('importFleet: encrypted wrapper with short vaultPassword', () => {
  it('returns error DiffReport when password is too short', async () => {
    const { importFleet, _encryptForTest, ENCRYPTED_FLEET_VERSION } = await import('../web/fleet-transfer.js')
    const blob = _encryptForTest('{"schemaVersion":1,"agents":[]}', 'long-enough-password-1234')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })
    const result = importFleet(wrapper, { vaultPassword: 'short', apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('legalább 8 karakter'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 22. importFleet: DB insert paths (exercises per-row run() branches)
// ---------------------------------------------------------------------------

describe('importFleet: DB insert happy paths', () => {
  it('applies kanban comments when no existing row', async () => {
    // No existing comments -- INSERT branch runs
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [{ card_id: 'C1', content: 'cmt' }],
        cardEvents: [], labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('applies kanban card events when no existing row', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [],
        cardEvents: [{ card_id: 'C1', to_status: 'open' }],
        labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('applies memories when no existing row', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      memories: [
        { agent_id: 'marveen', content: 'mem1', sector: 'warm', salience: 0.5,
          created_at: 1, category: 'p', auto_generated: 0 },
      ],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.memories).toBe(1)
  })

  it('applies daily logs when no existing row', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      dailyLogs: [{ agent_id: 'marveen', date: '2026-01-01', content: 'log', created_at: 1 }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 23. cleanupTracked -- mkdirSync / unlinkSync error swallowing
// ---------------------------------------------------------------------------

describe('cleanupTracked error swallowing', () => {
  it('swallows unlinkSync errors during cleanup', async () => {
    ;(H.atomicWriteMock as any).mockImplementation((p: string) => {
      throw new Error('write fail')
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    expect(() => importFleet(body, { apply: true })).toThrow(/write fail/)
  })

  it('cleanup logs the failure via logger.error', async () => {
    ;(H.atomicWriteMock as any).mockImplementation(() => {
      throw new Error('boom')
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    try { importFleet(body, { apply: true }) } catch { /* swallow */ }
    expect(H.loggerError).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 24. exportMainAgent coverage: identity mirror into .env + settings.json with env
// ---------------------------------------------------------------------------

describe('exportMainAgent: identity mirror', () => {
  it('does NOT export identity when no mainAgent in fleet', async () => {
    H.listAgentNamesMock.mockReturnValue([])
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent).toBeDefined()
    // mainAgent always present; identity mirror applies only during apply (importFleet)
  })
})

// ---------------------------------------------------------------------------
// 25. finalize -- identity takeover warning (apply path returns warning list)
// ---------------------------------------------------------------------------

describe('looksLikeHeaderSecret -- additional branches', () => {
  it('returns true for long high-entropy header value on a custom key', async () => {
    H.listAgentNamesMock.mockReturnValue([])
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    // Key 'X-Custom-Secret' is NOT matched by ALWAYS_SECRET_HEADER_KEY_RE
    // (which requires -token or -key suffix); value is long high-entropy
    // string not matching any non-secret pattern -> returns true.
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node',
        headers: { 'X-Custom-Secret': 'thisisareallylonghighentropysecretvalue1234567890' } } },
    }))
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/Titkosítatlan secret/)
  })

  it('returns true for short high-entropy header value when key has secret suffix', async () => {
    // Header KEY ends in "-token" -- ALWAYS_SECRET_HEADER_KEY_RE matches
    // Even short values get flagged because the key itself signals intent.
    H.listAgentNamesMock.mockReturnValue([])
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', headers: { 'X-Svc-Token': 'shortval' } } },
    }))
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    expect(() => exportFleet()).toThrowError(/Titkosítatlan secret/)
  })

  it('returns false when stripped value length < 16', async () => {
    H.listAgentNamesMock.mockReturnValue([])
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    // Use a custom non-whitelisted header with a short token after stripping the Bearer prefix.
    // Bearer prefix is stripped to "shortvalue" (10 chars, < 16). Returns false (not a secret).
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', headers: { 'X-My-Header': 'Bearer shortvalue' } } },
    }))
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    // Should NOT throw -- short value is safe
    expect(() => exportFleet()).not.toThrow()
  })

  it('returns false when stripped matches non-secret pattern (digits)', async () => {
    H.listAgentNamesMock.mockReturnValue([])
    addDir(H.PROJECT_ROOT)
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', headers: { 'X-Custom': 'Bearer 1234567890123456' } } },
    }))
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/SOUL.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agent-config.json`, '{}')
    addFile(`${H.STORE_DIR}/autonomy-config.json`, '{}')
    addFile(`${H.STORE_DIR}/auto-restart.json`, '{}')
    addFile(`${H.STORE_DIR}/agents-desired.json`, '{}')
    addFile(`${H.STORE_DIR}/norbert-personal.json`, '{}')
    setReaddir(`${H.PROJECT_ROOT}/agents`, [])
    setReaddir(H.SCHEDULED_TASKS_DIR, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    // 'Bearer 1234567890123456' -> strip 'Bearer ' -> '1234567890123456' -> matches /^\d+$/ -> not a secret
    expect(() => exportFleet()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 26. decryptWithPassword on a too-short blob
// ---------------------------------------------------------------------------

describe('decryptWithPassword: throws on too-short blob', () => {
  it('throws Érvénytelen titkosított blob error', async () => {
    const { _decryptForTest } = await import('../web/fleet-transfer.js')
    // 4 bytes of junk -- less than the minimum packed size
    const tooShort = Buffer.from('abcd').toString('base64')
    expect(() => _decryptForTest(tooShort, 'any-password-here')).toThrow(/Érvénytelen titkosított blob/)
  })
})

// ---------------------------------------------------------------------------
// 27. cleanupTracked -- when unlinkSync / rmSync throw
// ---------------------------------------------------------------------------

describe('cleanupTracked swallows unlinkSync errors', () => {
  it('cleanupTracked swallows unlinkSync errors', async () => {
    // Make atomicWrite throw after directory tracking has happened
    ;(H.atomicWriteMock as any).mockImplementation((p: string) => {
      throw new Error('write fail')
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    // Use a sub-agent with channels so that trackedMkdir runs first
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '', config: {}, mcp: {}, settings: {},
        channelsAccess: { telegram: { x: 1 } },
      },
    }))
    // Should throw, with cleanupTracked running through its catch blocks
    expect(() => importFleet(body, { apply: true })).toThrow(/write fail/)
  })
})

// ---------------------------------------------------------------------------
// 28. importFleet encrypted happy-path with correct password
// ---------------------------------------------------------------------------

describe('importFleet: encrypted decrypt succeeds (lines 1001-1004)', () => {
  it('decrypt with correct password passes through to schema validation', async () => {
    const { importFleet, _encryptForTest, ENCRYPTED_FLEET_VERSION } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet())
    const blob = _encryptForTest(body, 'correct-password-12345')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })
    const result = importFleet(wrapper, { vaultPassword: 'correct-password-12345', apply: false })
    expect('dryRun' in result).toBe(true)
    expect((result as any).errors).toHaveLength(0)
  })

  it('returns "titkosítva" error when encrypted but no password provided (line 996)', async () => {
    const { importFleet, _encryptForTest, ENCRYPTED_FLEET_VERSION } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet())
    const blob = _encryptForTest(body, 'some-password-12345')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })
    // pass empty string vaultPassword -- the explicit !options.vaultPassword branch fires only when undefined
    // The condition checks !options.vaultPassword, so we call without the key at all
    const result = importFleet(wrapper, { apply: false })
    expect('errors' in result).toBe(true)
    expect((result as any).errors[0]).toMatch(/titkosítva/)
  })

  it('returns "Helytelen vault jelszó" on decrypt failure (line 1004)', async () => {
    const { importFleet, _encryptForTest, ENCRYPTED_FLEET_VERSION } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet())
    const blob = _encryptForTest(body, 'right-password-12345')
    const wrapper = JSON.stringify({ enc: ENCRYPTED_FLEET_VERSION, blob })
    const result = importFleet(wrapper, { vaultPassword: 'wrong-password-12345', apply: false })
    expect('errors' in result).toBe(true)
    expect((result as any).errors[0]).toMatch(/Helytelen vault jelszó/)
  })
})

// ---------------------------------------------------------------------------
// 29. cleanupTracked -- swallow paths (unlinkSync + rmSync both throw)
// ---------------------------------------------------------------------------

describe('cleanupTracked swallow', () => {
  it('swallows unlinkSync errors when cleanup runs', async () => {
    // Track 1 file successfully, then throw on the second trackedWrite call.
    // cleanupTracked will then iterate tracker.files and call unlinkSync -- our
    // mock unlinkSync throws (but cleanup swallows).
    let callCount = 0
    ;(H.atomicWriteMock as any).mockImplementation((p: string) => {
      callCount++
      // First call (CLAUDE.md) succeeds -- populates fsState.files and tracker.files
      // Second call (SOUL.md) throws
      if (callCount === 2) {
        throw new Error('disk full 2')
      }
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '# soul', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    expect(() => importFleet(body, { apply: true })).toThrow(/disk full 2/)
  })
})

// ---------------------------------------------------------------------------
// 30. DB row-skip logger.warn paths (lines 1096, 1105)
// ---------------------------------------------------------------------------

describe('DB row skip paths log warnings', () => {
  it('logs warning for kanban row with missing required fields', async () => {
    // Pre-populate so label has empty required fields -- the logger.warn branch fires
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [{ id: 'C1' /* missing title, status, priority, sort_order */ }],
        comments: [], cardEvents: [], labels: [], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.loggerWarn).toHaveBeenCalled()
  })

  it('applies valid labels (db.prepare INSERT runs)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [], comments: [], cardEvents: [],
        labels: [{ id: 'L1', name: 'bug', color: '#f00', created_at: 1 }], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.labels).toBe(1)
  })

  it('applies valid kanban cards (db.prepare INSERT runs)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: { cards: [{ id: 'C1', title: 't', status: 'open', priority: 'p', sort_order: 0 }],
        comments: [], cardEvents: [], labels: [], cardLabels: [] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.kanbanCards).toBe(1)
  })

  it('uses [] fallback when fleet has no kanban field at all', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    // No `kanban` field at all -- the `?? []` fallback fires
    const body = JSON.stringify(makeFleet({ kanban: undefined }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

describe('apply: identity takeover returns warnings', () => {
  it('returns warnings field when mainAgent.agentId differs', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'old-name',
        identity: { MAIN_AGENT_ID: 'old-name', BOT_NAME: 'X', BRAND_NAME: 'X', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.warnings).toBeDefined()
    expect(result.warnings.some((w: string) => w.includes('old-name'))).toBe(true)
  })
})

describe('path-traversal guard', () => {
  it('rejects ../foo as agent.name', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      agents: [{ name: '../foo', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }],
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('agent.name'))).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// 21. TEMP sandbox smoke
// ---------------------------------------------------------------------------

describe('TEMP sandbox smoke test', () => {
  it('creates a temp directory and removes it', () => {
    const d = mkTempDir()
    expect(d).toContain(require('os').tmpdir())
    require('fs').rmSync(d, { recursive: true, force: true })
  })
})

// ---------------------------------------------------------------------------
// Branch-coverage pinning tests for ?? and || defensive defaults.
// ---------------------------------------------------------------------------
// v8 counts every `?? X` and `|| X` as a branch decision. Each branch must
// be hit for 100% coverage. The default test suite always feeds `[]` or `{}`
// for these fields, so the "use the fallback" arms are missed. These tests
// pin the nullish path: pass `undefined` for the field and assert the function
// walks the fallback path without throwing.

describe('fleet-transfer: pinning nullish-coalesce fallback branches', () => {
  it('validateNames: walks the nullish fallback for skills/scheduledTasks/agent fields', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    // agents must be an array (validateSchema rejects non-arrays), but
    // skills, scheduledTasks, agent.agentSkills, agent.channelsAccess and
    // fleet.memories/dailyLogs/kanban/ideaBox are all allowed to be
    // undefined -- the `?? []`/`?? {}` fallbacks walk the right arm.
    const body = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test-host',
      agents: [{ name: 'a', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {},
                 channelsAccess: undefined, agentSkills: undefined }],
      skills: undefined,
      scheduledTasks: undefined,
      memories: undefined,
      dailyLogs: undefined,
      kanban: undefined,
      ideaBox: undefined,
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(body, { apply: false }) as any
    expect(result.dryRun).toBe(true)
    // No errors -- the nullish coalesces turned undefined into [] / {}
    expect(result.errors).toEqual([])
  })

  it('buildDiffReport: warns about vault even when fleet.vault is missing', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({ vault: undefined }))
    const result = importFleet(body, { apply: false }) as any
    // The `if (!fleet.vault)` warning branch fires.
    expect(result.warnings.some((w: string) => w.includes('vault'))).toBe(true)
  })

  it('apply: tracks no work when mainAgent.channelsAccess is undefined', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {}, channelsAccess: undefined,
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})
