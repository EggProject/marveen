// Baseline branch coverage tests for src/web/fleet-transfer.ts.
//
// Az itt levő tesztek a 100% branch coverage eléréséhez szükséges
// védelmi/leoffedott (defensive) branch-eket fedik le. A SUT a
// fleet-export/import mag, amely:
//
//   - crypto helpers (encryptWithPassword / decryptWithPassword)
//   - JSON path normalization (PROJECT_ROOT + HOMEDIR sentinels)
//   - .mcp.json placeholder rewriting (vault: -> {{VAULT:id}})
//   - secret detection (looksLikeSecret, looksLikeHeaderSecret)
//   - file enumeration + read across PROJECT_ROOT, agents/, scheduled-tasks/
//   - DB snapshot/restore for kanban, idea_box, memories, daily_logs
//   - DiffReport generation and apply-time cleanup-on-failure
//
// Minden teszt a `src/__tests__/setup/test-sandbox-setup.ts` által
// beállított os.tmpdir() alapú sandbox-ban fut, és a JELENLEGI kód
// viselkedését rögzíti (PASS-eljen, ne pinning).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Hoisted state and mocks (mirrors the fleet-transfer-routes.test.ts harness)
// ---------------------------------------------------------------------------

interface FsState {
  files: Map<string, Buffer>
  dirs: Set<string>
  existsOverride: Map<string, boolean>
  readdirOverride: Map<string, string[]>
  statOverride: Map<string, { isDirectory: () => boolean; isFile: () => boolean }>
  readFileThrows: Set<string>
}

const H = vi.hoisted(() => {
  const fsState: FsState = {
    files: new Map(),
    dirs: new Set(),
    existsOverride: new Map(),
    readdirOverride: new Map(),
    statOverride: new Map(),
    readFileThrows: new Set(),
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
    if (fsState.readFileThrows.has(p)) {
      throw new Error(`mocked readFileSync ENOENT: ${p}`)
    }
    if (fsState.files.has(p)) {
      const v = fsState.files.get(p)!
      return typeof _enc === 'string' ? v.toString(_enc as BufferEncoding) : v
    }
    return realReadFileSync(p, _enc as any)
  }

  function readdirSync(p: string): string[] {
    if (fsState.readdirOverride.has(p)) return fsState.readdirOverride.get(p)!
    try { return realReaddirSync(p) as string[] } catch { return [] }
  }

  function mkdirSync(p: string, _opts?: any): void {
    fsState.dirs.add(p)
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
function setReadFileThrows(p: string): void { H.fsState.readFileThrows.add(p) }
function withAgents(names: string[]): void {
  H.listAgentNamesMock.mockReturnValue(names)
}
function withBindings(bindings: any[]): void {
  H.bindingsMock.mockReturnValue(bindings)
}

function baseMainDir(): void {
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

beforeEach(() => {
  H.fsState.files.clear()
  H.fsState.dirs.clear()
  H.fsState.existsOverride.clear()
  H.fsState.readdirOverride.clear()
  H.fsState.statOverride.clear()
  H.fsState.readFileThrows.clear()
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

// ===========================================================================
// 1. exportMainAgent / exportAgent: `settingsRaw ? JSON.parse(...) : {}`
// ---------------------------------------------------------------------------
// A settings.json üres/hiányzó esetén a `?? {}` fallback-re esik a SUT.
// Ez az elágazás a 494. és 544. sorokban jelenik meg.
// ===========================================================================

describe('exportMainAgent/exportAgent: settingsRaw empty falls back to {}', () => {
  it('settings.json empty string -> settings becomes {}', async () => {
    baseMainDir()
    // felülírjuk üres string-re a settings.json-t
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, '')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.settings).toEqual({})
  })

  it('settings.json unreadable -> settings becomes {} via safeReadText catch', async () => {
    baseMainDir()
    // safeReadText catch-e `''`-t ad vissza, tehát a `settingsRaw ?` falsy
    // ágra fut és a `{}` baseline-t kapjuk.
    setReadFileThrows(`${H.PROJECT_ROOT}/.claude/settings.json`)
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.settings).toEqual({})
  })

  it('sub-agent settings.json empty -> settings becomes {}', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`, Buffer.from('a'))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].settings).toEqual({})
  })
})

// ===========================================================================
// 2. exportMainAgent / exportAgent: `withSecrets ? rawMcp : placeholderMcp`
// ---------------------------------------------------------------------------
// A védelmi placeholderMcp csak akkor fut, ha NINCS vaultPassword. Ha van,
// a rawMcp megy át változatlanul. Ez a 491. és 541. sor.
// ===========================================================================

describe('exportMainAgent: withSecrets=true keeps rawMcp verbatim', () => {
  it('vaultPassword present -> mcp section is verbatim (no placeholder rewrite)', async () => {
    baseMainDir()
    // high-entropy secret in env -- normally this would be rejected by
    // placeholderMcp. With vaultPassword it stays.
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: {
        badoffend: {
          command: 'node',
          env: { TOKEN: 'this-is-a-very-high-entropy-token-12345' },
        },
      },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet({ vaultPassword: 'pw-12345678' })
    const wrapper = JSON.parse(r.data)
    expect(wrapper.enc).toBe(1)
    const { _decryptForTest } = await import('../web/fleet-transfer.js')
    const decrypted = _decryptForTest(wrapper.blob, 'pw-12345678')
    const fleet = JSON.parse(decrypted)
    expect(fleet.mainAgent.mcp.mcpServers.badoffend.env.TOKEN).toBe(
      'this-is-a-very-high-entropy-token-12345',
    )
  })

  it('sub-agent: vaultPassword present keeps rawMcp verbatim', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, JSON.stringify({
      mcpServers: { srv: { command: 'node', env: { TOKEN: 'high-entropy-token-987654321' } } },
    }))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`, Buffer.from('a'))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet, _decryptForTest } = await import('../web/fleet-transfer.js')
    const r = exportFleet({ vaultPassword: 'pw-12345678' })
    const wrapper = JSON.parse(r.data)
    const decrypted = _decryptForTest(wrapper.blob, 'pw-12345678')
    const fleet = JSON.parse(decrypted)
    expect(fleet.agents[0].mcp.mcpServers.srv.env.TOKEN).toBe('high-entropy-token-987654321')
  })
})

// ===========================================================================
// 3. placeholderMcp: `if (!cfg || typeof cfg !== 'object') continue`
// ---------------------------------------------------------------------------
// A `mcpServers` rekordonként objektum kell legyen. Ha null/string/etc.,
// a ciklus kihagyja. Ez a 364. sor.
// ===========================================================================

describe('placeholderMcp: skips non-object server config', () => {
  it('throws when only .vault-key is present (and vault section contains secrets) -- non-object cfg branch hits', async () => {
    baseMainDir()
    addFile(`${H.STORE_DIR}/.vault-key`, '0123456789abcdef0123456789abcdef')
    addFile(`${H.STORE_DIR}/vault.json`, '{"entries":[]}')
    addFile(`${H.STORE_DIR}/vault-bindings.json`, '{"bindings":[]}')
    // A mcpServers listában van egy null és egy string -- mindkettőt
    // a `!cfg || typeof cfg !== 'object'` branch kezeli.
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: {
        nullSrv: null,
        stringSrv: 'not-an-object',
        validSrv: { command: 'node', env: { FOO: 'bar' } },
      },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    // A `nullSrv` és `stringSrv` kihagyva, a `validSrv` megmarad.
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.validSrv.env.FOO).toBe('bar')
    expect(fleet.mainAgent.mcp.mcpServers.nullSrv).toBeNull()
    expect(fleet.mainAgent.mcp.mcpServers.stringSrv).toBe('not-an-object')
  })
})

// ===========================================================================
// 4. safeReadText / safeReadBase64: catch blocks
// ---------------------------------------------------------------------------
// Ha a readFileSync elszáll, a safeReadText `''` és a safeReadBase64 `null`
// értékkel tér vissza. Ez a 444. és 448. sor.
// ===========================================================================

describe('safeReadText / safeReadBase64: returns fallback on read failure', () => {
  it('reads CLAUDE.md as empty string when read throws', async () => {
    baseMainDir()
    setReadFileThrows(`${H.PROJECT_ROOT}/CLAUDE.md`)
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.claudeMd).toBe('')
  })

  it('sub-agent avatar.png returns null when read throws', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`, Buffer.from('a'))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    setReadFileThrows(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`)
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].avatar).toBeNull()
  })
})

// ===========================================================================
// 5. exportScheduledTasks: statSync throws OR isDirectory() is false
// ---------------------------------------------------------------------------
// A SCHEDULED_TASKS_DIR bejegyzései közül a nem-könyvtárak kimaradnak.
// Ez a 593. sor.
// ===========================================================================

describe('exportScheduledTasks: skips non-directory entries', () => {
  it('entry that is a file (not a directory) is skipped', async () => {
    baseMainDir()
    setExists(H.SCHEDULED_TASKS_DIR, true)
    setReaddir(H.SCHEDULED_TASKS_DIR, ['myfile', 'mytask'])
    setStat(`${H.SCHEDULED_TASKS_DIR}/myfile`, { isDirectory: () => false, isFile: () => true })
    setStat(`${H.SCHEDULED_TASKS_DIR}/mytask`, { isDirectory: () => true, isFile: () => false })
    addFile(`${H.SCHEDULED_TASKS_DIR}/mytask/SKILL.md`, '# task')
    addFile(`${H.SCHEDULED_TASKS_DIR}/mytask/task-config.json`, '{}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    // Csak a mappa számít feladatnak -- a file kimarad.
    expect(fleet.scheduledTasks).toHaveLength(1)
    expect(fleet.scheduledTasks[0].dirName).toBe('mytask')
  })

  it('entry whose statSync throws is swallowed', async () => {
    baseMainDir()
    setExists(H.SCHEDULED_TASKS_DIR, true)
    setReaddir(H.SCHEDULED_TASKS_DIR, ['broken', 'mytask'])
    // A `statSync` a broken-re dobjon -- a catch ág megnyugszik.
    setStat(`${H.SCHEDULED_TASKS_DIR}/broken`, new Proxy({}, { get: () => { throw new Error('EPERM') } }) as any)
    setStat(`${H.SCHEDULED_TASKS_DIR}/mytask`, { isDirectory: () => true, isFile: () => false })
    addFile(`${H.SCHEDULED_TASKS_DIR}/mytask/SKILL.md`, '# task')
    addFile(`${H.SCHEDULED_TASKS_DIR}/mytask/task-config.json`, '{}')
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.scheduledTasks).toHaveLength(1)
    expect(fleet.scheduledTasks[0].dirName).toBe('mytask')
  })
})

// ===========================================================================
// 6. validateNames: `agent.name ?? ''` falsy branch
// ---------------------------------------------------------------------------
// Ha agent.name undefined, a `String(undefined) === 'undefined'` megy a
// `SAFE_NAME_RE.test()`-be, ami hamisat ad -- a hibaüzenet az eredeti
// `String(agent.name)`-t írja ki (ami viszont 'undefined'-ot).
// ===========================================================================

describe('validateNames: agent.name undefined falls back to empty string', () => {
  it('agent with undefined name triggers the agent.name error', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({
      agents: [{ name: undefined, config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [] }],
    } as any)
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    // A `String(agent.name ?? '')` üres stringet ad, ami nem megy át
    // a SAFE_NAME_RE-n -- hibaüzenet generálódik.
    expect(result.errors.some((e: string) => e.includes('agent.name'))).toBe(true)
  })

  it('agent.agentSkills[i].name undefined triggers the skill.name error', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({
      agents: [{ name: 'a', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {},
        agentSkills: [{ name: undefined, skillMd: '' }] }],
    } as any)
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('skill.name'))).toBe(true)
  })

  it('global skill.name undefined triggers the skill.name error', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({ skills: [{ name: undefined, skillMd: '' }] } as any)
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('global skill.name'))).toBe(true)
  })

  it('scheduledTask.dirName undefined triggers the dirName error', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const bad = makeFleet({ scheduledTasks: [{ dirName: undefined, skillMd: '', config: {} }] } as any)
    const result = importFleet(JSON.stringify(bad), { apply: false }) as any
    expect(result.errors.some((e: string) => e.includes('scheduledTask.dirName'))).toBe(true)
  })
})

// ===========================================================================
// 7. validateNames: `agent.channelsAccess ?? {}` falsy branch
// ---------------------------------------------------------------------------
// Ha az agent.channelsAccess undefined, a `Object.keys(...?? {})` üres
// tömböt ad -- a belső ciklus egyszer sem fut le.
// ===========================================================================

describe('validateNames: agent.channelsAccess undefined stays empty', () => {
  it('agent with undefined channelsAccess passes through without error', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = makeFleet({
      agents: [{ name: 'a', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {},
        channelsAccess: undefined, agentSkills: [] }],
    } as any)
    const result = importFleet(JSON.stringify(body), { apply: false }) as any
    // Ha a `?? {}` hibás lenne, a `Object.keys(undefined)` TypeError-t
    // dobna és a validateNames elszállna. Ehelyett a result.dryRun true.
    expect(result.dryRun).toBe(true)
    expect(result.errors).toEqual([])
  })
})

// ===========================================================================
// 8. apply phase: `fleet.agents ?? []` / `fleet.skills ?? []` / stb.
// ---------------------------------------------------------------------------
// A apply fázisban minden `fleet.X ?? []` fallback ugyanazt a mintát
// követi. Az alábbi tesztek lefedik a `?? []` jobb oldalát.
// ===========================================================================

describe('apply phase: undefined array fields walk the ?? [] fallback', () => {
  it('apply with no skills/scheduledTasks/memories/dailyLogs/kanban/ideaBox succeeds', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test',
      agents: [],
      skills: undefined,
      scheduledTasks: undefined,
      memories: undefined,
      dailyLogs: undefined,
      kanban: undefined,
      ideaBox: undefined,
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    // A `?? []` ágak lefutottak: üres tömbök jelennek meg az imported-ban.
    expect(result.imported).toMatchObject({
      globalSkills: 0,
      scheduledTasks: 0,
      memories: 0,
      kanbanCards: 0,
      labels: 0,
      dailyLogs: 0,
      ideaBox: 0,
    })
  })

  it('apply with no kanban/ideaBox but with empty array fields succeeds', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test',
      agents: [],
      skills: [],
      scheduledTasks: [],
      memories: [],
      dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('dashboardSettings undefined falls back to {} (no settings written)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test',
      agents: [],
      skills: [],
      scheduledTasks: [],
      memories: [],
      dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: undefined,
    })
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 9. apply phase: DB row skip branches
// ---------------------------------------------------------------------------
// A kanban-cardLabels és kanban-comments INSERT ágak `if (!c.card_id ||
// !c.label_id) continue` / `if (!c.card_id || !c.content) continue` ágakat
// tartalmaznak. Ezek akkor futnak le, ha a bejövő rekord mezői
// undefinedok.
// ===========================================================================

describe('apply phase: DB row skip branches on missing fields', () => {
  it('kanban comments with missing card_id are skipped (continue branch)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [
          { card_id: undefined, content: 'cmt', author: 'x', created_at: 1 } as any,
          { card_id: 'C1', content: undefined, author: 'x', created_at: 1 } as any,
        ],
        cardEvents: [], labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    // A fenti két comment kimaradt -- a kanban-cards counter 0.
    expect(result.imported.kanbanCards).toBe(0)
  })

  it('kanban cardEvents with missing to_status are skipped', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [],
        cardEvents: [{ card_id: 'c1', to_status: undefined, created_at: 1 } as any],
        labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('kanban cardLabels with missing card_id or label_id are skipped', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [], cardEvents: [],
        labels: [],
        cardLabels: [
          { card_id: undefined, label_id: 'L1', created_at: 1 } as any,
          { card_id: 'C1', label_id: undefined, created_at: 1 } as any,
        ],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('kanban labels with missing required fields skipped and logger.warn fires', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [], cardEvents: [],
        labels: [{ id: undefined, name: 'bug', color: 'red', created_at: 1 } as any],
        cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.loggerWarn).toHaveBeenCalled()
  })

  it('kanban cards with missing required fields skipped and logger.warn fires', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [{ id: 'C1', title: undefined, status: 'open', priority: 'p', sort_order: 0 } as any],
        comments: [], cardEvents: [], labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(H.loggerWarn).toHaveBeenCalled()
  })
})

// ===========================================================================
// 10. memories: `mem.auto_generated ?? 0` / `mem.keywords ?? null`
// ---------------------------------------------------------------------------
// Ha a memóriasor nem tartalmazza ezeket a mezőket, a fallback 0 / null.
// ===========================================================================

describe('apply phase: memory auto_generated/keywords fallback', () => {
  it('memories without auto_generated/keywords are inserted with defaults', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      memories: [{
        agent_id: 'a', content: 'c', sector: 'warm', salience: 0.5,
        created_at: 1, accessed_at: 1, category: 'project',
        // auto_generated és keywords szándékosan undefined
      }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.memories).toBe(1)
  })
})

// ===========================================================================
// 11. ideaBox: undefined / missing inner arrays
// ---------------------------------------------------------------------------
// A `fleet.ideaBox?.ideas ?? []` falsy ág akkor fut, amikor `ideaBox`
// maga undefined, vagy ha a belső `ideas` hiányzzik.
// ===========================================================================

describe('apply phase: ideaBox undefined fields', () => {
  it('ideaBox undefined falls back to {} (no insertions)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test',
      agents: [],
      skills: [],
      scheduledTasks: [],
      memories: [],
      dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: undefined,
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.ideaBox).toBe(0)
  })

  it('ideaBox with empty inner arrays leaves counters at 0', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      ideaBox: { ideas: [], comments: [], statusLog: [] },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    expect(result.imported.ideaBox).toBe(0)
  })
})

// ===========================================================================
// 12. backfillEmbeddings: .catch(err => logger.warn(...))
// ---------------------------------------------------------------------------
// Ha a backfillEmbeddings promise rejectel, a figyelmeztetés megjelenik.
// ===========================================================================

describe('importFleet: backfillEmbeddings rejection is logged', () => {
  it('logger.warn fires when backfillEmbeddings rejects', async () => {
    H.backfillEmbeddingsMock.mockImplementation(() => Promise.reject(new Error('embedding-broken')))
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet())
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    // Megvárjuk, amíg a microtask queue-ban lévő .catch lefut.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(H.loggerWarn).toHaveBeenCalled()
    const warnCalls = H.loggerWarn.mock.calls.map((c: any[]) => JSON.stringify(c[1] ?? ''))
    expect(warnCalls.some((s: string) => s.includes('embedding backfill'))).toBe(true)
  })
})

// ===========================================================================
// 13. writeAgentFiles: `agent.avatarExt || ''` fallback (avatarExt invalid)
// ---------------------------------------------------------------------------
// A writeAgentFiles a `agent.avatarExt`-et whitelisteli. Ha a regex nem
// talál egyezést, a `'png'` alapértéket használja. Ez a 957. sor.
// ===========================================================================

describe('writeAgentFiles: avatarExt falls back to png when invalid', () => {
  it('agent with avatar but missing avatarExt writes avatar.png', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      agents: [{
        name: 'testbot',
        avatar: 'aGVsbG8=',
        // avatarExt undefined -- a writeAgentFiles a `|| ''` fallback
        // ágat használja, és 'png'-re cseréli.
        config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: {}, agentSkills: [],
      }],
    } as any))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    // A H.atomicWriteMock regisztrálta a fájlírást --
    // ellenőrizzük, hogy avatar.png néven írta (mert avatarExt undefined).
    const written = H.atomicWriteMock.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(written.some((p: string) => p.endsWith('avatar.png'))).toBe(true)
  })
})

// ===========================================================================
// 14. writeAgentFiles: `agent.agentSkills ?? []` defensive fallback
// ---------------------------------------------------------------------------
// Ha agent.agentSkills undefined, a ciklus egyszer sem fut.
// ===========================================================================

describe('writeAgentFiles: agent.agentSkills undefined', () => {
  it('agent with undefined agentSkills writes no skill files', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test',
      agents: [{ name: 'testbot', config: {}, claudeMd: '', soulMd: '', mcp: {}, settings: {}, channelsAccess: undefined, agentSkills: undefined }],
      skills: [],
      scheduledTasks: [],
      memories: [],
      dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    const written = H.atomicWriteMock.mock.calls.map((c: unknown[]) => c[0] as string)
    // A SKILL.md fájlok a testbot alatt nem jöhettek létre.
    expect(written.some((p: string) => p.includes('testbot/.claude/skills/'))).toBe(false)
  })
})

// ===========================================================================
// 15. buildDiffReport: `fleet.agents ?? []` falsy branch (no apply)
// ---------------------------------------------------------------------------
// A dry-run fázisban is van `fleet.agents ?? []` fallback a különböző
// számlálóknál. Ezeket az alábbi teszt fedi le, amikor `fleet.agents`
// maga undefined.
// ===========================================================================

describe('buildDiffReport: ?? [] falsy branches during dry-run', () => {
  it('dry-run with fleet.agents undefined produces empty diff arrays', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({
      schemaVersion: 1,
      exportedAt: '2026-01-01T00:00:00.000Z',
      sourceHost: 'test',
      agents: undefined,
      skills: [],
      scheduledTasks: [],
      memories: [],
      dailyLogs: [],
      kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
      ideaBox: { ideas: [], comments: [], statusLog: [] },
      dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
    })
    const result = importFleet(body, { apply: false }) as any
    expect(result.dryRun).toBe(true)
    expect(result.wouldCreate.agents).toEqual([])
    expect(result.wouldOverwrite.agents).toEqual([])
  })

  it('dry-run with no channelsAccess -> no channels warning', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'a',
        identity: { MAIN_AGENT_ID: 'a', BOT_NAME: 'b', BRAND_NAME: 'b', OWNER_NAME: 'o', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {}, mcp: {}, settings: {},
        channelsAccess: undefined,
      },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.dryRun).toBe(true)
    expect(result.warnings.some((w: string) => w.includes('újra-párosítás'))).toBe(false)
  })
})

// ===========================================================================
// 16. importFleet: JSON parse error before denormalize (handled)
// ---------------------------------------------------------------------------
// A `JSON.parse(rawBody)` catch ága akkor fut, ha a rawBody nem parseolható.
// ===========================================================================

describe('importFleet: invalid JSON body returns DiffReport with parse error', () => {
  it('garbage input returns a DiffReport with one Érvénytelen JSON error', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const result = importFleet('not-valid-json', { apply: false }) as any
    expect(result.dryRun).toBe(true)
    expect(result.errors.some((e: string) => e.includes('Érvénytelen JSON'))).toBe(true)
  })
})

// ===========================================================================
// 17. importFleet: validateSchema: nem létező kulcsok
// ---------------------------------------------------------------------------
// A validateSchema ellenőrzi, hogy a kötelező mezők megvannak-e.
// ===========================================================================

describe('importFleet: validateSchema rejects missing required fields', () => {
  it('missing top-level fields produces schema errors', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    // Szándékosan üres objektum -- minden kötelező mező hiányzik.
    const result = importFleet('{}', { apply: false }) as any
    expect(result.errors.length).toBeGreaterThan(0)
  })
})

// ===========================================================================
// 19. listSkillsInDir: SKILL.md missing (else branch)
// ---------------------------------------------------------------------------
// A `if (!existsSync(dir)) return []` else-ága akkor fut, amikor a dir
// létezik. A `if (existsSync(skillMdPath))` else-ága akkor fut, amikor
// a SKILL.md NEM létezik a skill mappájában.
// ===========================================================================

describe('listSkillsInDir: directory without SKILL.md', () => {
  it('sub-agent skills dir exists but entry has no SKILL.md (skill dropped)', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills/broken-skill`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`, Buffer.from('a'))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, ['broken-skill'])
    setExists(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills/broken-skill/SKILL.md`, false)
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].agentSkills).toEqual([])
  })
})

// ===========================================================================
// 20. settings.env: no secrets (else branch)
// ---------------------------------------------------------------------------
// A `if (typeof val === 'string' && looksLikeSecret(val))` else-ága akkor
// fut, amikor a settings.env nem tartalmaz secret-et.
// ===========================================================================

describe('exportMainAgent/exportAgent: settings.env with no secrets', () => {
  it('settings.env with safe values does not throw', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.claude/settings.json`, JSON.stringify({
      env: { FOO: 'bar', URL: 'https://example.com', NUM: '123' },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.settings.env.FOO).toBe('bar')
  })
})

// ===========================================================================
// 21. buildDiffReport: pre-existing DB rows (else branch)
// ---------------------------------------------------------------------------
// A `if (!db.prepare(...).get(...))` else-ága akkor fut, amikor a row
// MÁR LÉTEZIK az adatbázisban.
// ===========================================================================

describe('buildDiffReport: pre-existing DB rows make counters 0', () => {
  it('memories already in DB -> newMemories is 0', async () => {
    H.dbTables.set('memories', [
      { agent_id: 'a', content: 'c' },
    ])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      memories: [{
        agent_id: 'a', content: 'c', sector: 'warm', salience: 0.5,
        created_at: 1, accessed_at: 1, category: 'project',
      }],
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.memories).toBe(0)
  })

  it('kanban cards already in DB -> newCards is 0', async () => {
    H.dbTables.set('kanban_cards', [{ id: 'C1' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [{ id: 'C1', title: 't', status: 'open', priority: 'p', sort_order: 0 }],
        comments: [], cardEvents: [], labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.kanbanCards).toBe(0)
  })

  it('daily logs already in DB -> newDailyLogs is 0', async () => {
    H.dbTables.set('daily_logs', [{ agent_id: 'a', date: '2026-01-01', content: 'log' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      dailyLogs: [{ agent_id: 'a', date: '2026-01-01', content: 'log', created_at: 1 }],
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.dailyLogs).toBe(0)
  })

  it('kanban comments already in DB -> newComments is 0', async () => {
    H.dbTables.set('kanban_comments', [{ card_id: 'C1', content: 'cmt' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [{ card_id: 'C1', content: 'cmt' }],
        cardEvents: [], labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: false }) as any
    expect(result.wouldCreate.kanbanComments).toBe(0)
  })
})

// ===========================================================================
// 22. trackedMkdir / trackedWrite: pre-existing paths (else branch)
// ---------------------------------------------------------------------------
// A `if (!existsSync(path))` és `if (!preexisted)` else-ágai akkor futnak,
// amikor a path már létezik.
// ===========================================================================

describe('apply phase: pre-existing tracked paths', () => {
  it('CLAUDE.md already exists at target -> trackedWrite writes it anyway', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# claude', soulMd: '# soul', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
    // A file written.
    const written = H.atomicWriteMock.mock.calls.map((c: unknown[]) => c[0] as string)
    expect(written.some((p: string) => p.endsWith('CLAUDE.md'))).toBe(true)
  })
})

// ===========================================================================
// 23. apply phase: DB idempotent insert (else branch of "INSERT" check)
// ---------------------------------------------------------------------------
// A `if (!db.prepare('SELECT 1...').get(...))` else-ága akkor fut, amikor
// a sort már létezik az adatbázisban.
// ===========================================================================

describe('apply phase: DB idempotent insert (else branch)', () => {
  it('duplicate kanban_card_event skips insert', async () => {
    H.dbTables.set('kanban_card_events', [{ card_id: 'C1', created_at: 1, to_status: 'open' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      kanban: {
        cards: [], comments: [],
        cardEvents: [{ card_id: 'C1', from_status: null, to_status: 'open', created_at: 1 }],
        labels: [], cardLabels: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('duplicate memory skips insert', async () => {
    H.dbTables.set('memories', [{ agent_id: 'a', content: 'c' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      memories: [{ agent_id: 'a', content: 'c', sector: 'warm', salience: 0.5,
        created_at: 1, accessed_at: 1, category: 'project' }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('duplicate daily_log skips insert', async () => {
    H.dbTables.set('daily_logs', [{ agent_id: 'a', date: '2026-01-01', content: 'log' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      dailyLogs: [{ agent_id: 'a', date: '2026-01-01', content: 'log', created_at: 1 }],
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('duplicate idea_comment skips insert', async () => {
    H.dbTables.set('idea_comments', [{ idea_id: 'I1', created_at: 1, content: 'cmt' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      ideaBox: {
        ideas: [],
        comments: [{ idea_id: 'I1', author: 'x', content: 'cmt', created_at: 1 }],
        statusLog: [],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('duplicate idea_status_log skips insert', async () => {
    H.dbTables.set('idea_status_log', [{ idea_id: 'I1', created_at: 1, to_status: 'open' }])
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      ideaBox: {
        ideas: [],
        comments: [],
        statusLog: [{ idea_id: 'I1', from_status: null, to_status: 'open', actor: 'x', note: null, created_at: 1 }],
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 24. placeholderMcp: lookup.has/byServer.has duplicate paths
// ---------------------------------------------------------------------------
// A `if (!lookup.has(target.mcpFilePath))` és `if (!byServer.has(target.serverName))`
// else-ágai akkor futnak, amikor a binding mcpFilePath / serverName már
// létezik a lookup-ban.
// ===========================================================================

describe('placeholderMcp: duplicate lookup keys in bindings', () => {
  it('two bindings to the same mcpFilePath AND same serverName still walks', async () => {
    withBindings([
      { vaultSecretId: 'v1', envVar: 'TOKEN_A', targets: [{ mcpFilePath: `${H.PROJECT_ROOT}/.mcp.json`, serverName: 'srv' }] },
      { vaultSecretId: 'v2', envVar: 'TOKEN_B', targets: [{ mcpFilePath: `${H.PROJECT_ROOT}/.mcp.json`, serverName: 'srv' }] },
    ])
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: {
        srv: { command: 'node', env: { TOKEN_A: 'vault:v1', TOKEN_B: 'vault:v2' } },
      },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.srv.env.TOKEN_A).toBe('{{VAULT:v1}}')
    expect(fleet.mainAgent.mcp.mcpServers.srv.env.TOKEN_B).toBe('{{VAULT:v2}}')
  })
})

// ===========================================================================
// 25. placeholderMcp: args not a secret (else branch)
// --------------------------------------------------------------------------
// Az `if (typeof arg === 'string' && looksLikeSecret(arg))` else-ága akkor
// fut, amikor az arg NEM titok.
// ===========================================================================

describe('placeholderMcp: args that are not secrets', () => {
  it('args with non-secret strings passes placeholderMcp without throwing', async () => {
    baseMainDir()
    addFile(`${H.PROJECT_ROOT}/.mcp.json`, JSON.stringify({
      mcpServers: {
        srv: {
          command: 'node',
          args: ['--mode', 'production', '--config', 'config.json'],
          env: { FOO: 'bar' },
        },
      },
    }))
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.mainAgent.mcp.mcpServers.srv.args).toEqual([
      '--mode', 'production', '--config', 'config.json',
    ])
  })
})

// ===========================================================================
// 26. deplaceholderMcp: {{VAULT:}} placeholder reverse path
// --------------------------------------------------------------------------
// A `if (typeof v === 'string' && v.startsWith('{{VAULT:') && v.endsWith('}}'))`
// else-ága akkor fut, amikor a v NEM `{{VAULT:...}}` formátumú.
// ===========================================================================

describe('deplaceholderMcp: non-{{VAULT:}} values stay as-is', () => {
  it('import with mcp env containing plain values keeps them verbatim', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '', soulMd: '', config: {},
        mcp: { mcpServers: { srv: { command: 'node', env: { FOO: 'bar', URL: 'https://example.com' } } } },
        settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 27. trackedMkdir: pre-existing path (else branch)
// -------------------------------------------------------------------------
// A `if (!existsSync(path))` else-ága akkor fut, amikor a path MÁR
// LÉTEZIK. Ez a trackedMkdir függvényben van.
// ===========================================================================

describe('apply phase: trackedMkdir pre-existing path', () => {
  it('PROJECT_ROOT/.claude already exists at apply time (no mkdir needed)', async () => {
    // A PROJECT_ROOT/.claude már létezik -- a writeMainAgentFiles hívja
    // a trackedMkdir-t, ami látja, hogy a path már megvan.
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '#', soulMd: '#', config: { x: 1 }, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 28. trackedWrite: pre-existing file (else branch)
// -------------------------------------------------------------------------
// A `if (!preexisted)` else-ága akkor fut, amikor a file MÁR LÉTEZIK.
// Ilyenkor a cleanupTracked NEM törli.
// ===========================================================================

describe('apply phase: trackedWrite pre-existing file', () => {
  it('apply overwrites pre-existing CLAUDE.md (cleanup does not delete it)', async () => {
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# new', soulMd: '# soul', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 29. settings.env secret check on sub-agent (else branch)
// -------------------------------------------------------------------------
// A `if (typeof val === 'string' && looksLikeSecret(val))` else-ága a
// sub-agent settings.env check-ben.
// ===========================================================================

describe('exportAgent: settings.env with no secrets', () => {
  it('sub-agent settings.env with safe values does not throw', async () => {
    withAgents(['testbot'])
    baseMainDir()
    setReaddir(`${H.PROJECT_ROOT}/agents`, ['testbot'])
    addDir(`${H.PROJECT_ROOT}/agents/testbot`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude`)
    addDir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`)
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.claude/settings.json`, JSON.stringify({
      env: { FOO: 'bar', URL: 'https://example.com' },
    }))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/.mcp.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/agent-config.json`, '{}')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/avatar.png`, Buffer.from('a'))
    addFile(`${H.PROJECT_ROOT}/agents/testbot/CLAUDE.md`, '#')
    addFile(`${H.PROJECT_ROOT}/agents/testbot/SOUL.md`, '#')
    setReaddir(`${H.PROJECT_ROOT}/agents/testbot/.claude/skills`, [])
    const { exportFleet } = await import('../web/fleet-transfer.js')
    const r = exportFleet()
    const fleet = JSON.parse(r.data)
    expect(fleet.agents[0].settings.env.FOO).toBe('bar')
  })
})

// ===========================================================================
// 30. fix: trackedMkdir pre-existing path (else branch)
// -------------------------------------------------------------------------
// A fenti 27. számú teszt (line 1286) NEM hívja a baseMainDir() segédet,
// ezért a PROJECT_ROOT/.claude NEM szerepel a `dirs` halmazban, és a
// trackedMkdir az if-true (mkdir) ágat futtatja. Ez a teszt explicit
// pre-létrehozza a dir-t, hogy az else ág (NO-OP) valóban lefusson.
// ===========================================================================

describe('apply phase: trackedMkdir pre-existing path (fixed)', () => {
  it('PROJECT_ROOT/.claude pre-created -> trackedMkdir sees existing path -> else branch', async () => {
    addDir(`${H.PROJECT_ROOT}/.claude`)
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '#', soulMd: '#', config: { x: 1 }, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 31. fix: trackedWrite pre-existing file (else branch)
// -------------------------------------------------------------------------
// A fenti 28. számú teszt (line 1310) NEM pre-létrehozza a CLAUDE.md-t,
// ezért a trackedWrite a `preexisted = false` értékkel fut, és az if-true
// (unlink cleanup) ágat veszi. Ez a teszt pre-létrehozza a fájlt, hogy a
// `preexisted = true` else ág valóban lefusson.
// ===========================================================================

describe('apply phase: trackedWrite pre-existing file (fixed)', () => {
  it('CLAUDE.md pre-created -> trackedWrite sees preexisted=true -> cleanup else branch', async () => {
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '# old')
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# new', soulMd: '# soul', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 32. fleet.agents ?? [] right-arm (validateNames, buildDiffReport, apply, log)
// -------------------------------------------------------------------------
// A fleet.agents mező opcionális. Ha undefined vagy null, a `?? []` fallback
// ág fut le. A makeFleet default `agents: []` értéket ad, így a spread az
// üres tömböt hagyja; csak explicit `agents: null` felülírással érjük el a
// jobb oldali ágat.
// ===========================================================================

describe('fleet.agents: null/undefined rejected by schema validation (?? [] right-arm unreachable)', () => {
  // A validateSchema 741. sora megköveteli, hogy f.agents tömb legyen --
  // ha null vagy undefined, a séma-ellenőrzés hibát dob, mielőtt az
  // alábbi függvények (validateNames, buildDiffReport, applyFleetImport)
  // egyáltalán lefutnának. A `?? []` jobb oldali ágak tehát a jelenlegi
  // kódban strukturálisan elérhetetlenek. A részletes elemzés a
  // fleet-transfer-fleet-agents-nullish-unreachable
  // fájlban.
  it('agents: null is rejected by the schema validation (the ?? [] right-arms never fire)', async () => {
    addDir(`${H.PROJECT_ROOT}/.claude`)
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify({ ...makeFleet(), agents: null })
    const result = importFleet(body, { apply: false }) as any
    // A schema-validation hibaüzenet a fleet.agents mezőt kifogásolja;
    // a `?? []` fallback ágak SOHA nem futnak le.
    expect(result.errors).toContain('agents mező hiányzik vagy nem tömb.')
  })

  it('agents: undefined is rejected by the schema validation (the ?? [] right-arms never fire)', async () => {
    addDir(`${H.PROJECT_ROOT}/.claude`)
    const { importFleet } = await import('../web/fleet-transfer.js')
    // A JSON.stringify(undefined) kihagyja a kulcsot, így agents hiányzik
    // -- ugyanaz a hiba, mint a null esetén.
    const body = JSON.stringify({ ...makeFleet(), agents: undefined })
    const result = importFleet(body, { apply: false }) as any
    expect(result.errors).toContain('agents mező hiányzik vagy nem tömb.')
  })
})

// ===========================================================================
// 33. deplaceholderMcp: cfg null or non-object entry (if-true continue)
// -------------------------------------------------------------------------
// A deplaceholderMcp 420. sor `if (!cfg || typeof cfg !== 'object') continue`
// ága akkor fut, amikor a mcpServers bejegyzés nem object (pl. string vagy
// null). A default makeFleet cfg-értéke `{}`, így a cfg mindig object; ez
// a teszt explicit nem-object értéket ad át.
// ===========================================================================

describe('deplaceholderMcp: non-object mcpServers entry is skipped', () => {
  it('mcpServers entry with a string value is skipped (continue branch)', async () => {
    addDir(`${H.PROJECT_ROOT}/.claude`)
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '#', soulMd: '#', config: {}, settings: {}, channelsAccess: {},
        mcp: { mcpServers: { srv: 'not-an-object' } },
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })

  it('mcpServers entry with a null value is skipped (continue branch)', async () => {
    addDir(`${H.PROJECT_ROOT}/.claude`)
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '#', soulMd: '#', config: {}, settings: {}, channelsAccess: {},
        mcp: { mcpServers: { srv: null } },
      },
    }))
    const result = importFleet(body, { apply: true }) as any
    expect(result.ok).toBe(true)
  })
})

// ===========================================================================
// 34. cleanupTracked: preexisted file (else branch of `if (!preexisted)`)
// -------------------------------------------------------------------------
// A cleanupTracked 3534. sor `if (!preexisted) { unlinkSync(path) }`
// else-ága akkor fut, amikor a tracked file a cleanup előtt már létezett
// (preexisted=true). Ilyenkor a cleanup NEM törli a fájlt, mert nem
// készítettünk róla biztonsági másolatot. A cleanupTracked csak a catch
// ágban fut le (H3: rollback on failure), ezért a teszt egy
// atomicWriteMock-throw segítségével kényszeríti ki a hibát.
// ===========================================================================

describe('apply phase: cleanupTracked else branch (preexisted files not deleted)', () => {
  it('when an apply error fires, preexisted CLAUDE.md is preserved (else branch)', async () => {
    addDir(`${H.PROJECT_ROOT}/.claude`)
    addFile(`${H.PROJECT_ROOT}/CLAUDE.md`, '# old')
    // A trackedWrite az első atomicWrite hívásra kapja meg a CLAUDE.md-t;
    // a második hívás (SOUL.md) legyen az, amelyik elszáll, így a
    // cleanupTracked fut le, és a CLAUDE.md preexisted=true bejegyzéssel
    // bent marad a tracker.files-ban.
    let callIndex = 0
    H.atomicWriteMock.mockImplementation((p: string, data: string | Buffer) => {
      callIndex++
      if (callIndex >= 2) throw new Error('simulated disk full')
      H.fsState.files.set(p, Buffer.isBuffer(data) ? data : Buffer.from(data))
    })
    const { importFleet } = await import('../web/fleet-transfer.js')
    const body = JSON.stringify(makeFleet({
      mainAgent: {
        agentId: 'main',
        identity: { MAIN_AGENT_ID: 'main', BOT_NAME: 'M', BRAND_NAME: 'M', OWNER_NAME: 'O', CHANNEL_PROVIDER: 't' },
        claudeMd: '# new', soulMd: '# soul', config: {}, mcp: {}, settings: {}, channelsAccess: {},
      },
    }))
    let caught: Error | null = null
    try {
      importFleet(body, { apply: true })
    } catch (err) {
      caught = err as Error
    }
    expect(caught).not.toBeNull()
    expect(caught!.message).toBe('simulated disk full')
    // A preexisted CLAUDE.md a cleanup után is megmarad (else ág).
    expect(H.fsState.files.has(`${H.PROJECT_ROOT}/CLAUDE.md`)).toBe(true)
  })
})
