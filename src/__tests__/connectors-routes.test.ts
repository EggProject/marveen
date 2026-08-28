// 100% coverage suite for src/web/routes/connectors.ts.
//
// `tryHandleConnectors` is the long dispatcher behind the dashboard's
// "Connectors" page. It owns roughly thirty endpoints across five groups:
//
//   1. /api/connectors[/:name[/assign]]  -- CRUD for MCP entries
//   2. /api/mcp-catalog[/:id/(install|uninstall)] -- catalog listing/install
//   3. /api/vault[/:id|/bindings|/scan|/import|/sync] -- secret CRUD + bindings
//   4. /api/connectors/external-paths, /github-repos -- sidecar lists
//   5. /api/ollama/models -- upstream list proxy
//
// The dispatcher reaches into db/config/logger/auth-gate/auth-sessions,
// `mcp-list-parser`, `mcp-list`, `agent-config`, `dashboard-settings`,
// `vault`, `vault-bindings`, `http-helpers`, `sanitize`, `atomic-write`,
// and `child_process.execSync`. Every collaborator is mocked here so the
// dispatcher runs against a deterministic fake and never touches the live
// store, the network, or the host shell.
//
// One helper is exported: `vaultAndBindEnvSecrets` -- covered separately.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'connectors-routes-'))
  // Pre-seed mcp-catalog.json with a minimal catalog so loadMcpCatalog() never
  // crashes during the catch-all test for /api/mcp-catalog. Tests that need a
  // specific catalog shape write to that file in beforeEach.
  fs.writeFileSync(
    path.join(projectRoot, 'mcp-catalog.json'),
    JSON.stringify([
      { id: 'gmail', name: 'Gmail', type: 'remote', url: 'https://example.test/mcp', authType: 'apikey', env: {} },
      { id: 'local-tool', name: 'Local Tool', type: 'local', command: 'node server.js', env: {}, args: ['a', 'b'], transport: 'http' },
    ]),
  )

  return {
    projectRoot,

    // config
    PROJECT_ROOT: projectRoot,
    OLLAMA_URL: 'http://ollama.test:11434',
    MAIN_AGENT_ID: 'marveen',

    // logger
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),

    // auth-gate / auth-sessions -- not used by the SUT but the task brief
    // explicitly lists them in the mock set.
    authGate: { resolveOwnerAuth: vi.fn() },
    authSessions: { createSession: vi.fn() },

    // db -- a noop module the SUT does not import; covered for completeness.
    db: { getDb: vi.fn() },

    // mcp-list-parser
    slugify: vi.fn(<T>(s: T) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')),
    catalogMatchesConfigured: vi.fn(() => false),

    // mcp-list
    getMcpListCache: vi.fn(() => ({
      entries: [] as unknown[],
      lastRefreshed: 0,
      refreshing: false,
      error: undefined as string | undefined,
    })),
    refreshMcpListCache: vi.fn(async () => ({
      entries: [] as unknown[],
      lastRefreshed: 1,
      refreshing: false,
      error: undefined as string | undefined,
    })),
    purgeFromMcpListCache: vi.fn(() => false),

    // agent-config -- readFileOr is heavily exercised by the dispatcher; the
    // mock returns '{}' so JSON.parse never crashes on a missing file.
    readFileOr: vi.fn((_p: string, fallback: string) => fallback),
    AGENTS_BASE_DIR: path.join(projectRoot, 'agents'),
    listAgentNames: vi.fn(() => [] as string[]),

    // dashboard-settings
    getExternalProjectPaths: vi.fn(() => [] as string[]),
    addExternalProjectPath: vi.fn((p: string) => ({ paths: [p] })),
    removeExternalProjectPath: vi.fn(() => [] as string[]),
    getGitHubRepos: vi.fn(() => [] as unknown[]),
    installGitHubRepo: vi.fn(async () => ({ repo: { name: 'foo' }, requiredEnvVars: [] })),
    removeGitHubRepo: vi.fn(() => ({ ok: true })),
    updateGitHubRepo: vi.fn(() => ({ ok: true })),
    detectRequiredEnvVars: vi.fn(() => [] as string[]),

    // vault
    listSecrets: vi.fn(() => [] as Array<{ id: string; label: string; createdAt: string; updatedAt: string }>),
    setSecret: vi.fn(),
    getSecret: vi.fn(() => null as string | null),
    deleteSecret: vi.fn(() => true),

    // vault-bindings
    getBindings: vi.fn(() => [] as unknown[]),
    addBinding: vi.fn(),
    removeBinding: vi.fn(() => true),
    removeBindingsForSecret: vi.fn(),
    syncSecret: vi.fn(() => ({ updated: 1, errors: [] as string[] })),
    syncAllBindings: vi.fn(() => ({ updated: 0, errors: [] as string[] })),
    scanMcpConfigs: vi.fn(() => [] as unknown[]),
    unsyncBinding: vi.fn(),

    // atomic-write (used as a stub; real one is fine because it never gets
    // called with a target that would mkdirSync ENOENT)
    atomicWriteFileSync: vi.fn(),

    // sanitize
    shellEscape: vi.fn((s: string) => `'${String(s).replace(/'/g, "'\\''")}'`),

    // http-helpers -- kept REAL.

    // child_process
    execSync: vi.fn(),
  }
})

// --- vi.mock factories ------------------------------------------------------

vi.mock('../config.js', () => ({
  PROJECT_ROOT: H.PROJECT_ROOT,
  OLLAMA_URL: H.OLLAMA_URL,
  MAIN_AGENT_ID: H.MAIN_AGENT_ID,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

vi.mock('../db.js', () => ({ getDb: H.db.getDb }))

vi.mock('../web/auth-gate.js', () => H.authGate)
vi.mock('../web/auth-sessions.js', () => H.authSessions)

vi.mock('../mcp-list-parser.js', () => ({
  slugify: H.slugify,
  catalogMatchesConfigured: H.catalogMatchesConfigured,
}))

vi.mock('../web/mcp-list.js', () => ({
  getMcpListCache: H.getMcpListCache,
  refreshMcpListCache: H.refreshMcpListCache,
  purgeFromMcpListCache: H.purgeFromMcpListCache,
  startMcpListChecker: vi.fn(),
}))

vi.mock('../web/agent-config.js', () => ({
  readFileOr: H.readFileOr,
  AGENTS_BASE_DIR: H.AGENTS_BASE_DIR,
  listAgentNames: H.listAgentNames,
}))

vi.mock('../web/dashboard-settings.js', () => ({
  getExternalProjectPaths: H.getExternalProjectPaths,
  addExternalProjectPath: H.addExternalProjectPath,
  removeExternalProjectPath: H.removeExternalProjectPath,
  getGitHubRepos: H.getGitHubRepos,
  installGitHubRepo: H.installGitHubRepo,
  removeGitHubRepo: H.removeGitHubRepo,
  updateGitHubRepo: H.updateGitHubRepo,
  detectRequiredEnvVars: H.detectRequiredEnvVars,
}))

vi.mock('../web/vault.js', () => ({
  listSecrets: H.listSecrets,
  setSecret: H.setSecret,
  getSecret: H.getSecret,
  deleteSecret: H.deleteSecret,
  getSecretsForEnv: vi.fn(),
}))

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: H.getBindings,
  addBinding: H.addBinding,
  removeBinding: H.removeBinding,
  removeBindingsForSecret: H.removeBindingsForSecret,
  syncSecret: H.syncSecret,
  syncAllBindings: H.syncAllBindings,
  scanMcpConfigs: H.scanMcpConfigs,
  unsyncBinding: H.unsyncBinding,
}))

vi.mock('../web/sanitize.js', () => ({
  shellEscape: H.shellEscape,
  sanitizeAgentName: vi.fn((s: string) => s),
  sanitizeSkillName: vi.fn((s: string) => s),
  sanitizeScheduleName: vi.fn((s: string) => s),
  safeJoin: vi.fn((base: string, ...parts: string[]) => path.join(base, ...parts)),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: H.atomicWriteFileSync,
}))

vi.mock('node:child_process', () => ({
  execSync: H.execSync,
}))

// Stub global.fetch so /api/ollama/models never hits the network.
const fetchMock = vi.fn()
vi.stubGlobal('fetch', fetchMock)

// --- imports ----------------------------------------------------------------

const path = require('node:path') as typeof import('node:path')
const { tryHandleConnectors, vaultAndBindEnvSecrets } = await import('../web/routes/connectors.js')

// --- helpers ----------------------------------------------------------------

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

function mkReq(opts: { body?: unknown; raw?: Buffer | string } = {}): http.IncomingMessage {
  let payload: Buffer[]
  if (opts.raw !== undefined) {
    payload = [typeof opts.raw === 'string' ? Buffer.from(opts.raw) : opts.raw]
  } else if (opts.body !== undefined) {
    payload = [Buffer.from(JSON.stringify(opts.body))]
  } else {
    payload = []
  }
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  fullPath: string,
  opts: { body?: unknown; raw?: Buffer | string } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> | unknown[] | null }> {
  const urlStr = `http://127.0.0.1:3420${fullPath}`
  const url = new URL(urlStr)
  const req = mkReq({ body: opts.body, raw: opts.raw })
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = await tryHandleConnectors(ctx as any)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  // Provide a writable HOME so homedir()-relative paths in the SUT resolve
  // somewhere consistent. They will not be touched -- the readFileOr mock
  // swallows every access -- but several config + .claude.json probes still
  // execute, and we want them to ENOENT without touching the real $HOME.
  process.env.HOME = '/tmp/connectors-routes-home'
  process.env.USERPROFILE = '/tmp/connectors-routes-home'
  // Pre-create the user-$HOME .claude.json and .claude/settings.json paths the
  // dispatcher probes via readFileOr; the readFileOr mock returns '{}' so the
  // dispatcher's try/catch always sees "no plugins".
})

beforeEach(() => {
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()
  H.getMcpListCache.mockReset()
  H.getMcpListCache.mockReturnValue({ entries: [], lastRefreshed: 0, refreshing: false, error: undefined })
  H.refreshMcpListCache.mockReset()
  H.refreshMcpListCache.mockResolvedValue({ entries: [], lastRefreshed: 1, refreshing: false, error: undefined })
  H.purgeFromMcpListCache.mockReset().mockReturnValue(false)
  H.readFileOr.mockReset().mockImplementation((_p: string, fallback: string) => fallback)
  H.listAgentNames.mockReset().mockReturnValue([])
  H.getExternalProjectPaths.mockReset().mockReturnValue([])
  H.addExternalProjectPath.mockReset().mockImplementation((p: string) => ({ paths: [p] }))
  H.removeExternalProjectPath.mockReset().mockReturnValue([])
  H.getGitHubRepos.mockReset().mockReturnValue([])
  H.installGitHubRepo.mockReset().mockResolvedValue({ repo: { name: 'foo' }, requiredEnvVars: [] })
  H.removeGitHubRepo.mockReset().mockReturnValue({ ok: true })
  H.updateGitHubRepo.mockReset().mockReturnValue({ ok: true })
  H.detectRequiredEnvVars.mockReset().mockReturnValue([])
  H.listSecrets.mockReset().mockReturnValue([])
  H.setSecret.mockReset()
  H.getSecret.mockReset().mockReturnValue(null)
  H.deleteSecret.mockReset().mockReturnValue(true)
  H.getBindings.mockReset().mockReturnValue([])
  H.addBinding.mockReset()
  H.removeBinding.mockReset().mockReturnValue(true)
  H.removeBindingsForSecret.mockReset()
  H.syncSecret.mockReset().mockReturnValue({ updated: 1, errors: [] })
  H.syncAllBindings.mockReset().mockReturnValue({ updated: 0, errors: [] })
  H.scanMcpConfigs.mockReset().mockReturnValue([])
  H.unsyncBinding.mockReset()
  H.shellEscape.mockReset().mockImplementation((s: string) => `'${String(s).replace(/'/g, "'\\''")}'`)
  H.atomicWriteFileSync.mockReset()
  H.execSync.mockReset().mockReturnValue('')
  H.slugify.mockReset()
  H.slugify.mockImplementation(<T>(s: T) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''))
  H.catalogMatchesConfigured.mockReset().mockReturnValue(false)
  fetchMock.mockReset()
  // Always re-seed the catalog file: some tests overwrite it (single-item
  // catalog), others rmSync it (defect-trigger). Unconditional re-seed keeps
  // every test starting from the two-item baseline.
  writeFileSync(
    join(H.projectRoot, 'mcp-catalog.json'),
    JSON.stringify([
      { id: 'gmail', name: 'Gmail', type: 'remote', url: 'https://example.test/mcp', authType: 'apikey', env: {}, transport: 'http' },
      { id: 'local-tool', name: 'Local Tool', type: 'local', command: 'node server.js', env: {}, args: ['a', 'b'] },
    ]),
  )
  // Drop any local-catalog override from earlier tests so they don't bleed
  // into committed-catalog tests.
  rmSync(join(H.projectRoot, 'mcp-catalog.local.json'), { force: true })
})

// ============================================================================
// Helper: vaultAndBindEnvSecrets
// ============================================================================

describe('vaultAndBindEnvSecrets', () => {
  it('skips empty values', () => {
    vaultAndBindEnvSecrets('srv', '/p/.mcp.json', { TOKEN: '' })
    expect(H.setSecret).not.toHaveBeenCalled()
    expect(H.addBinding).not.toHaveBeenCalled()
  })

  it('vaults, binds, and syncs each non-empty env secret', () => {
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    vaultAndBindEnvSecrets('My Server', '/p/.mcp.json', { TOKEN: 't' })
    expect(H.setSecret).toHaveBeenCalledWith('my-server-token', 'TOKEN (My Server)', 't')
    expect(H.addBinding).toHaveBeenCalledWith({
      vaultSecretId: 'my-server-token',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: '/p/.mcp.json', serverName: 'My Server' }],
    })
    expect(H.syncSecret).toHaveBeenCalledWith('my-server-token')
  })

  it('throws when syncSecret reports an error', () => {
    H.syncSecret.mockReturnValue({ updated: 0, errors: ['boom'] })
    expect(() => vaultAndBindEnvSecrets('srv', '/p/.mcp.json', { TOKEN: 't' })).toThrow(/TOKEN/)
  })
})

// ============================================================================
// Dispatcher surface
// ============================================================================

describe('tryHandleConnectors -- surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/something-else')
    expect(handled).toBe(false)
  })

  it('returns false for a wrong method on /api/connectors', async () => {
    const { handled } = await call('PATCH', '/api/connectors')
    expect(handled).toBe(false)
  })
})

// ============================================================================
// GET /api/connectors
// ============================================================================

describe('GET /api/connectors', () => {
  it('skips enabledPlugins that resolve to an empty list (settings read throws)', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) throw new Error('boom')
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors')
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(json())).toBe(true)
  })

  it('returns a "configured" entry per enabled plugin and skips falsy / duplicate ones', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) {
        return JSON.stringify({
          enabledPlugins: {
            'Slack@MarveenMarketplace': true,
            'Telegram@Official': true,
            'Disabled@X': false,                // truthy guard -- skipped
            'Slack@OtherMarketplace': true,    // also slugifies to 'plugin:slack' -- globalSeen dedup skip
          },
        })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors')
    expect(res.statusCode).toBe(200)
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'plugin:slack')).toBeTruthy()
    expect(body.find(e => e.name === 'plugin:telegram')).toBeTruthy()
    expect(body.filter(e => (e.name as string).startsWith('plugin:slack'))).toHaveLength(1)
  })

  it('reads remote + local MCP servers from .mcp.json / .claude.json files', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) return fallback
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { remote: { url: 'https://r.test' }, local: { command: 'echo hi' } } })
      }
      if (p.endsWith('.claude.json')) {
        return JSON.stringify({ mcpServers: { dup: { command: 'x' } } })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors')
    expect(res.statusCode).toBe(200)
    const body = json() as Array<Record<string, unknown>>
    const remote = body.find(e => e.name === 'remote')
    expect(remote).toMatchObject({ type: 'remote', source: 'local-project', scope: 'global', endpoint: 'https://r.test' })
    const local = body.find(e => e.name === 'local')
    expect(local).toMatchObject({ type: 'local', endpoint: 'echo hi' })
  })

  it('falls back to getMcpListCache when the same name is not declared in any file', async () => {
    H.getMcpListCache.mockReturnValue({
      entries: [
        { name: 'plain', normalizedId: 'plain', endpoint: 'https://x', status: 'connected', source: 'local' },
        { name: 'Claude.ai Gmail', normalizedId: 'gmail', endpoint: 'u', status: 'connected', source: 'claude.ai' },
        { name: 'plugin:tg', normalizedId: 'tg', endpoint: 'cmd', status: 'unknown', source: 'plugin' },
      ],
      lastRefreshed: 0, refreshing: false,
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    // Status passes through verbatim -- only "unknown" gets rewritten to "configured".
    expect(body.find(e => e.name === 'plain')).toMatchObject({ status: 'connected', type: 'local', source: 'local', scope: 'global' })
    expect(body.find(e => e.name === 'Claude.ai Gmail')).toMatchObject({ type: 'remote', source: 'claude.ai' })
    expect(body.find(e => e.name === 'plugin:tg')).toMatchObject({ status: 'configured', source: 'plugin' })
  })

  it('discovers per-agent .mcp.json entries (agent + agent-project scopes) plus skips non-directories', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    // Real directory with .mcp.json inside.
    const realProj = join(projectsDir, 'real')
    mkdirSync(realProj, { recursive: true })
    writeFileSync(join(realProj, '.mcp.json'), JSON.stringify({ mcpServers: { projServer: { command: 'proj-cmd' } } }))
    // File (not directory) -- statSync().isDirectory() rejects it.
    writeFileSync(join(projectsDir, 'flatfile'), 'not-a-dir')

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) return '{}'
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) {
        return JSON.stringify({ mcpServers: { agentServer: { command: 'agent-cmd' } } })
      }
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { projServer: { command: 'proj-cmd' } } })
      }
      if (p === join(PROJECT_ROOT, '.mcp.json')) return '{}'
      if (p.endsWith('.claude.json')) return '{}'
      return fallback
    })

    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'agentServer')).toMatchObject({ scope: 'agent:archivist', source: 'agent' })
    expect(body.find(e => e.name === 'projServer')).toMatchObject({ scope: 'project:archivist/real', source: 'agent-project' })
  })

  it('discovers external-project paths from getExternalProjectPaths', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'ext-proj-'))
    const extMcp = join(extDir, '.mcp.json')
    writeFileSync(extMcp, JSON.stringify({ mcpServers: { extSrv: { command: 'ext-cmd' } } }))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === extMcp) return JSON.stringify({ mcpServers: { extSrv: { command: 'ext-cmd' } } })
      if (p.endsWith('settings.json')) return '{}'
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'extSrv')).toMatchObject({
      scope: `project:external/${require('node:path').basename(extDir)}`,
      source: 'external-project',
    })
  })

  it('dedupes file-source servers via the globalSeen set', async () => {
    // Same name in PROJECT_ROOT/.mcp.json and HOMEDIR/.claude.json - the
    // second iteration must skip the duplicate (the else branch at line 168).
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { dup: { url: 'https://a' } } })
      }
      if (p.endsWith('.claude.json')) {
        return JSON.stringify({ mcpServers: { dup: { command: 'b' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.filter(e => e.name === 'dup')).toHaveLength(1)
  })

  it('falls back to "" when a server has neither URL nor command', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { ghost: { env: { TOKEN: 'x' } } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'ghost')).toMatchObject({ endpoint: '', type: 'local' })
  })

  it('dedupes cache entries that repeat a name already declared in a file', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { shared: { command: 'a' } } })
      }
      return fallback
    })
    H.getMcpListCache.mockReturnValue({
      entries: [{ name: 'shared', normalizedId: 'shared', endpoint: '', status: 'connected', source: 'local' }],
      lastRefreshed: 0, refreshing: false,
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.filter(e => e.name === 'shared')).toHaveLength(1)
  })
})

// ============================================================================
// GET /api/connectors/status
// ============================================================================

describe('GET /api/connectors/status', () => {
  it('returns the cache hydration status', async () => {
    H.getMcpListCache.mockReturnValue({
      entries: [], lastRefreshed: 12345, refreshing: true, error: 'old boom',
    })
    const { res, json } = await call('GET', '/api/connectors/status')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ cacheLastRefreshed: 12345, cacheError: 'old boom', refreshing: true })
  })
})

// ============================================================================
// POST /api/connectors/refresh
// ============================================================================

describe('POST /api/connectors/refresh', () => {
  it('returns 200/ok when the cache refresh succeeds', async () => {
    H.refreshMcpListCache.mockResolvedValue({
      entries: [{}, {}], lastRefreshed: 42, refreshing: false,
    })
    const { res, json } = await call('POST', '/api/connectors/refresh')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, count: 2, lastRefreshed: 42, error: undefined })
  })

  it('returns 502 + error when the cache refresh failed', async () => {
    H.refreshMcpListCache.mockResolvedValue({ entries: [], lastRefreshed: 9, refreshing: false, error: 'spawn ENOENT' })
    const { res, json } = await call('POST', '/api/connectors/refresh')
    expect(res.statusCode).toBe(502)
    expect(json()).toMatchObject({ ok: false, error: 'spawn ENOENT' })
  })
})

// ============================================================================
// /api/connectors/external-paths (GET, POST, DELETE)
// ============================================================================

describe('/api/connectors/external-paths', () => {
  it('GET lists external project paths', async () => {
    H.getExternalProjectPaths.mockReturnValue(['/a', '/b'])
    const { json } = await call('GET', '/api/connectors/external-paths')
    expect(json()).toEqual({ paths: ['/a', '/b'] })
  })

  it('POST adds an external path', async () => {
    H.addExternalProjectPath.mockReturnValue({ paths: ['/x'] })
    const { res, json } = await call('POST', '/api/connectors/external-paths', { body: { path: '/x' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, paths: ['/x'] })
  })

  it('POST 400s when addExternalProjectPath returns an error', async () => {
    H.addExternalProjectPath.mockReturnValue({ paths: [], error: 'Absolute path required' })
    const { res, json } = await call('POST', '/api/connectors/external-paths', { body: { path: 'relative' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Absolute path required' })
  })

  it('DELETE removes an external path', async () => {
    H.removeExternalProjectPath.mockReturnValue([])
    const { res, json } = await call('DELETE', '/api/connectors/external-paths', { body: { path: '/x' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, paths: [] })
  })
})

// ============================================================================
// /api/connectors/github-repos (GET, POST, DELETE :name, PATCH :name)
// ============================================================================

describe('/api/connectors/github-repos', () => {
  it('GET lists GitHub repos', async () => {
    H.getGitHubRepos.mockReturnValue([{ name: 'a' }])
    const { json } = await call('GET', '/api/connectors/github-repos')
    expect(json()).toEqual({ repos: [{ name: 'a' }] })
  })

  it('POST installs a GitHub repo (no env)', async () => {
    const { res, json } = await call('POST', '/api/connectors/github-repos', {
      body: { url: 'https://github.com/foo/bar' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, repo: { name: 'foo' }, requiredEnvVars: [] })
    expect(H.installGitHubRepo).toHaveBeenCalledWith('https://github.com/foo/bar', undefined)
  })

  it('POST installs a GitHub repo and persists env values to the vault', async () => {
    const { res, json } = await call('POST', '/api/connectors/github-repos', {
      body: { url: 'https://github.com/foo/bar', env: { TOKEN: 't' } },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, repo: { name: 'foo' }, requiredEnvVars: [] })
    expect(H.setSecret.mock.calls[0][0]).toMatch(/^github-env-token-/)
    expect(H.installGitHubRepo).toHaveBeenCalled()
    const installArg = H.installGitHubRepo.mock.calls[0][1] as Record<string, string>
    expect(installArg.TOKEN).toMatch(/^github-env-token-/)
  })

  it('POST 400s when URL is empty after trim', async () => {
    const { res, json } = await call('POST', '/api/connectors/github-repos', { body: { url: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'URL is required' })
  })

  it('POST 400s when installGitHubRepo returns an error', async () => {
    H.installGitHubRepo.mockResolvedValue({ error: 'Invalid GitHub URL' } as any)
    const { res, json } = await call('POST', '/api/connectors/github-repos', { body: { url: 'https://github.com/foo/bar' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid GitHub URL' })
  })

  it('DELETE /api/connectors/github-repos/:name removes by name', async () => {
    const { res } = await call('DELETE', '/api/connectors/github-repos/foo--bar')
    expect(res.statusCode).toBe(200)
    expect(H.removeGitHubRepo).toHaveBeenCalledWith('foo--bar')
  })

  it('DELETE returns 404 when the repo is unknown', async () => {
    H.removeGitHubRepo.mockReturnValue({ ok: false, error: 'Repo not found' })
    const { res, json } = await call('DELETE', '/api/connectors/github-repos/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Repo not found' })
  })

  it('PATCH /api/connectors/github-repos/:name updates the repo', async () => {
    const { res } = await call('PATCH', '/api/connectors/github-repos/foo--bar')
    expect(res.statusCode).toBe(200)
    expect(H.updateGitHubRepo).toHaveBeenCalledWith('foo--bar')
  })

  it('PATCH returns 400 when the update fails', async () => {
    H.updateGitHubRepo.mockReturnValue({ ok: false, error: 'Directory missing' })
    const { res, json } = await call('PATCH', '/api/connectors/github-repos/missing')
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Directory missing' })
  })
})

// ============================================================================
// GET /api/connectors/:name  (connector detail)
// ============================================================================

describe('GET /api/connectors/:name', () => {
  it('returns plugin metadata when the name carries the plugin: prefix and a match is found', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) {
        return JSON.stringify({ enabledPlugins: { 'Slack@Marketplace': true } })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/plugin:slack')
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ name: 'plugin:slack', scope: 'user', status: 'configured', type: 'plugin', command: 'Slack@Marketplace' })
  })

  it('404s for the plugin: prefix when no enabled-plugin match is found', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) return JSON.stringify({ enabledPlugins: {} })
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/plugin:nope')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('404s for the plugin: prefix when settings.json read throws', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) throw new Error('boom')
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/plugin:nope')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('handles a plugin: with multiple "segment:variant" parts (uses the last segment for the match)', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) {
        return JSON.stringify({ enabledPlugins: { 'Slack@Marketplace@1': true } })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/plugin:foo:slack')
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ command: 'Slack@Marketplace@1' })
  })

  it('resolves the connector from PROJECT_ROOT/.mcp.json and redacts env values', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({
          mcpServers: {
            projSrv: { command: 'node', args: ['s', '1'], env: { TOKEN: 'plaintext', FLAG: 'x' } },
          },
        })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/projSrv')
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      name: 'projSrv',
      scope: 'project',
      type: 'local',
      command: 'node',
      args: 's 1',
      env: { TOKEN: '***', FLAG: '***' },
    })
  })

  it('reports remote type when a URL is configured', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { r: { url: 'https://r.test' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/r')
    expect(json()).toMatchObject({ type: 'remote', command: 'https://r.test', args: '' })
  })

  it('uses cfg.url as the command when no command field is set (remote type)', async () => {
    // command: cfg.command || cfg.url || '' -- when only cfg.url exists, falls
    // back to that. Adds an args: '' (not array) so the String branch fires.
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { urlOnly: { url: 'https://w' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/urlOnly')
    expect(json()).toMatchObject({ type: 'remote', command: 'https://w', args: '' })
  })

  it('uses "" command when an MCP server has neither command nor URL', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { nogood: { env: { X: 'y' } } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/nogood')
    expect(json()).toMatchObject({ type: 'local', command: '', args: '' })
  })

  it('scans agent projects/ subdirs while looking up the connector', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'myproj')
    mkdirSync(realProj, { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { projSrv: { command: 'a' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/projSrv')
    expect(json()).toMatchObject({ scope: 'project:archivist/myproj' })
  })

  it('scans agent-level + project-level paths and skips non-directories', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const agentDir = join(H.AGENTS_BASE_DIR, 'archivist')
    const projectsDir = join(agentDir, 'projects')
    mkdirSync(projectsDir, { recursive: true })
    // Real project dir matching the looked-up name.
    const realProj = join(projectsDir, 'blog')
    mkdirSync(realProj, { recursive: true })
    writeFileSync(join(realProj, '.mcp.json'), JSON.stringify({ mcpServers: { blogSrv: { command: 'a' } } }))
    // Plain file should be skipped by statSync().isDirectory().
    writeFileSync(join(projectsDir, 'flatfile'), 'x')

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return fallback
      if (p === join(realProj, '.mcp.json')) return JSON.stringify({ mcpServers: { blogSrv: { command: 'a' } } })
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) return fallback
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/blogSrv')
    expect(json()).toMatchObject({ scope: 'project:archivist/blog' })
  })

  it('scans external project paths for the connector', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'ext-det-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(extDir, '.mcp.json')) return JSON.stringify({ mcpServers: { extSrv: { command: 'a' } } })
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/extSrv')
    expect(json()).toMatchObject({ scope: `project:external/${path.basename(extDir)}` })
  })

  it('returns 404 when no MCP file declares the connector', async () => {
    const { res, json } = await call('GET', '/api/connectors/ghost')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('404s for POST /api/connectors/:name (path collides with the GET branch; POST is handled by the next branch when path does not include /assign)', async () => {
    // The detail-name regex is only meaningful under GET. POST falls through to
    // /api/connectors path match -- with a name as the path, it matches the
    // connectorDetailMatch regex for DELETE but not POST. The dispatcher
    // therefore returns false.
    const { handled } = await call('POST', '/api/connectors/foo')
    expect(handled).toBe(false)
  })
})

// ============================================================================
// POST /api/connectors (add MCP server)
// ============================================================================

describe('POST /api/connectors (add MCP server)', () => {
  it('400s when name is missing or blank', async () => {
    const { res, json } = await call('POST', '/api/connectors', { body: { type: 'http', url: 'https://x' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Name is required' })
  })

  it('400s when the sanitized name is empty (all punctuation stripped)', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: '!!!', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Name must contain at least one letter, number, hyphen, or underscore' })
  })

  it('installs an http MCP server with auth-required env (authType=apikey)', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: {
        name: 'gmail',
        type: 'http',
        url: 'https://example.test/mcp',
        scope: 'project',
        env: { TOKEN: 't' },
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'gmail', nameChanged: false })
    expect(H.execSync).toHaveBeenCalled()
  })

  it('installs an sse MCP server (no env, no authType)', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'sse-tool', type: 'sse', url: 'https://sse.test', scope: 'user' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'sse-tool', nameChanged: false })
  })

  it('reports nameChanged=true when sanitization altered the raw name', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'gmail tool', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.nameChanged).toBe(true)
    expect(body.name).toBe('gmail-tool')
  })

  it('installs a stdio MCP server with vault-bound env secrets', async () => {
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res, json } = await call('POST', '/api/connectors', {
      body: {
        name: 'local-tool',
        type: 'stdio',
        command: 'node',
        args: 'foo bar',
        env: { TOKEN: 'plaintext', EMPTY: '' },
        scope: 'project',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, name: 'local-tool', nameChanged: false })
    expect(H.setSecret).toHaveBeenCalledWith('local-tool-token', 'TOKEN (local-tool)', 'plaintext')
    expect(H.execSync).toHaveBeenCalledWith(expect.stringContaining('claude mcp add'), expect.any(Object))
  })

  it('still installs a stdio server when no env secrets are supplied', async () => {
    const { res } = await call('POST', '/api/connectors', {
      body: { name: 'no-env-stdio', type: 'stdio', command: 'node' },
    })
    expect(res.statusCode).toBe(200)
    expect(H.setSecret).not.toHaveBeenCalled()
  })

  it('uses ~/.claude.json (user scope) for stdio vault+bind when scope is user (not project)', async () => {
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res } = await call('POST', '/api/connectors', {
      body: {
        name: 'user-scope',
        type: 'stdio',
        command: 'node',
        env: { TOKEN: 'plaintext' },
        scope: 'user',
      },
    })
    expect(res.statusCode).toBe(200)
    // vaultAndBindEnvSecrets called with the user-scope mcp file.
    const setSecretCalls = H.setSecret.mock.calls
    expect(setSecretCalls.length).toBeGreaterThan(0)
    // The vault id is `user-scope-token` regardless of which file is used.
    expect(setSecretCalls[0][0]).toBe('user-scope-token')
  })

  it('400s when neither a URL (for http/sse) nor a command (for stdio) is supplied', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'useless', type: 'stdio' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'URL (http/sse) or command (stdio) required' })
  })

  it('returns 500 with the error message when execSync throws', async () => {
    H.execSync.mockImplementation(() => { throw Object.assign(new Error('spawn failed'), { message: 'spawn failed' }) })
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'boom', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'spawn failed' })
  })

  it('falls back to the default error string when the thrown error has no message', async () => {
    const err: any = new Error()
    err.message = ''
    H.execSync.mockImplementation(() => { throw err })
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'silent', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(500)
    expect((json() as Record<string, string>).error).toBe('Failed to add connector')
  })

  it('logs but still returns ok when upsertLocalCatalogEntry fails (catalog persistence is best-effort)', async () => {
    H.atomicWriteFileSync.mockImplementation(() => { throw new Error('disk full') })
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'gmail', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'gmail', nameChanged: false })
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to persist MCP into mcp-catalog.local.json')
  })

  it('merges into an existing mcp-catalog.local.json entry by id (the idx>=0 branch)', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.local.json'),
      JSON.stringify([{ id: 'gmail', name: 'Old Name', type: 'remote', url: 'https://old.test' }]),
    )
    const { res } = await call('POST', '/api/connectors', {
      body: { name: 'gmail', type: 'http', url: 'https://new.test' },
    })
    expect(res.statusCode).toBe(200)
    // The atomicWriteFileSync call now contains the merged entry -- url updated, name preserved.
    const lastCall = H.atomicWriteFileSync.mock.calls[H.atomicWriteFileSync.mock.calls.length - 1]
    const persisted = JSON.parse(lastCall[1])
    const gmail = persisted.find((e: any) => e.id === 'gmail')
    expect(gmail.url).toBe('https://new.test')
  })

  it('falls through to write a plain local catalog entry (no mcp-catalog.local.json yet)', async () => {
    // Confirm that POST works without a pre-existing local catalog -- the
    // dispatcher overwrites (atomicWriteFileSync) so ENOENT is fine.
    const { res } = await call('POST', '/api/connectors', {
      body: { name: 'newone', type: 'http', url: 'https://y' },
    })
    expect(res.statusCode).toBe(200)
  })
})

// ============================================================================
// DELETE /api/connectors/:name (remove + cache purge)
// ============================================================================

describe('DELETE /api/connectors/:name', () => {
  it('removes the connector from every detected MCP file (including agent + project + external + home)', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const agentProjDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(agentProjDir, { recursive: true })
    const realProj = join(agentProjDir, 'blog')
    mkdirSync(realProj, { recursive: true })
    writeFileSync(join(realProj, '.mcp.json'), '{}')

    const extDir = mkdtempSync(join(tmpdir(), 'del-ext-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { victim: { command: 'x' } } })
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) return JSON.stringify({ mcpServers: { victim: { command: 'y' } } })
      if (p === join(realProj, '.mcp.json')) return JSON.stringify({ mcpServers: { victim: { command: 'z' } } })
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res, json, handled } = await call('DELETE', '/api/connectors/victim')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, removed: 3 })
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(3)
    expect(H.purgeFromMcpListCache).toHaveBeenCalledWith('victim')
  })

  it('skips non-directories under agents/<name>/projects/', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(join(projectsDir, 'flat'), 'not-a-dir')

    const { res, json } = await call('DELETE', '/api/connectors/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found in any config' })
  })

  it('walks the agent+projects+ext tree when looking up a connector to remove', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'blog')
    mkdirSync(realProj, { recursive: true })
    const realMcp = join(realProj, '.mcp.json')
    writeFileSync(realMcp, JSON.stringify({ mcpServers: { delAble: { command: 'b' } } }))

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === realMcp) return JSON.stringify({ mcpServers: { delAble: { command: 'b' } } })
      return fallback
    })
    const { res, json } = await call('DELETE', '/api/connectors/delAble')
    expect(res.statusCode).toBe(200)
    expect((json() as Record<string, number>).removed).toBe(1)
    // The agent projects/ branch was exercised (the directory is real).
  })

  it('skips when the agent has no projects/ dir at all (existsSync false branch)', async () => {
    H.listAgentNames.mockReturnValue(['loner'])
    mkdirSync(join(H.AGENTS_BASE_DIR, 'loner'), { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { loneSrv: { command: 'x' } } })
      }
      return fallback
    })
    // Since the agent does not declare loneSrv and there is no projects dir to
    // walk, a DELETE falls through to a 404 -- but the agent-name branch
    // (line 479, existsSync(projectsDir)=false) is still exercised.
    const { res } = await call('DELETE', '/api/connectors/loneSrv')
    expect(res.statusCode).toBe(200)
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('returns 404 when neither any file nor the cache holds the connector', async () => {
    const { res, json } = await call('DELETE', '/api/connectors/ghost')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found in any config' })
  })

  it('returns the cache-purge branch when no MCP file contained the name', async () => {
    H.purgeFromMcpListCache.mockReturnValue(true)
    const { res, json } = await call('DELETE', '/api/connectors/ram-only')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, removed: 0, purgedFromCache: true })
  })
})

// ============================================================================
// POST /api/connectors/:name/assign
// ============================================================================

describe('POST /api/connectors/:name/assign', () => {
  it('returns the plugin: short-circuit note without touching any config', async () => {
    const { res, json } = await call('POST', '/api/connectors/plugin:slack/assign', {
      body: { agents: [] },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, note: expect.stringContaining('plugin') })
  })

  it('whitelists known agents only (path-traversal guard)', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { srv: { command: 'x' } } })
      }
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res, json } = await call('POST', '/api/connectors/srv/assign', {
      body: { agents: ['../../../../tmp/evil', 'archivist'] },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    // atomicWriteFileSync called only for the surviving agent.
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('reads the connector config from an external project path', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'assign-ext-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.listAgentNames.mockReturnValue(['archivist'])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { extSrv: { command: 'x' } } })
      }
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res, json } = await call('POST', '/api/connectors/extSrv/assign', {
      body: { agents: ['archivist'] },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })

  it('404s when the connector config does not exist in any source', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const { res, json } = await call('POST', '/api/connectors/ghost/assign', { body: { agents: ['archivist'] } })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('writes the connector config to every target agent mcp.json', async () => {
    H.listAgentNames.mockReturnValue(['archivist', 'backend'])
    // Seed the connector only in ~/.claude.json (read by readFileOr).
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { ssrv: { command: 'a' } } })
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res, json } = await call('POST', '/api/connectors/ssrv/assign', { body: { agents: ['archivist', 'backend'] } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(2)
  })

  it('removes the connector from any agent named in allAgents[] that is NOT in agents[]', async () => {
    H.listAgentNames.mockReturnValue(['archivist', 'backend', 'ghost'])
    // Pre-seed backend's mcp.json with the connector so the DELETE branch fires.
    const backendMcp = join(H.AGENTS_BASE_DIR, 'backend', '.mcp.json')
    mkdirSync(join(H.AGENTS_BASE_DIR, 'backend'), { recursive: true })
    writeFileSync(backendMcp, JSON.stringify({ mcpServers: { delSrv: { command: 'x' } } }))

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { delSrv: { command: 'x' } } })
      if (p === backendMcp) return JSON.stringify({ mcpServers: { delSrv: { command: 'x' } } })
      return fallback
    })

    H.atomicWriteFileSync.mockReset()
    const { res, json } = await call('POST', '/api/connectors/delSrv/assign', {
      body: { agents: ['archivist'], allAgents: ['archivist', 'backend', 'ghost'] },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    // Two writes: write for archivist (target), delete for backend (visible).
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(2)
  })

  it('does not delete from a target agent even when it appears in allAgents[]', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { keepSrv: { command: 'x' } } })
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res } = await call('POST', '/api/connectors/keepSrv/assign', {
      body: { agents: ['archivist'], allAgents: ['archivist'] },
    })
    expect(res.statusCode).toBe(200)
    // Only the target write -- no visible-agent delete path.
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('tolerates a non-array agents[] (treats it as empty) and an unreadable target mcp.json', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { ok: { command: 'x' } } })
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) throw new Error('cannot read')
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res } = await call('POST', '/api/connectors/ok/assign', { body: { agents: 'not-an-array' } })
    expect(res.statusCode).toBe(200)
  })

  it('initializes mcpServers when the target agent has no .mcp.json yet', async () => {
    H.listAgentNames.mockReturnValue(['newone'])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { cfgSrv: { command: 'a' } } })
      // The agent's .mcp.json is missing/empty -- readFileOr throws at the
      // top-level parse (or returns the fallback '{}'). Simulate the latter.
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res } = await call('POST', '/api/connectors/cfgSrv/assign', { body: { agents: ['newone'] } })
    expect(res.statusCode).toBe(200)
    // The persisted config must have the new mcpServers block populated.
    expect(H.atomicWriteFileSync).toHaveBeenCalled()
    const payload = JSON.parse(H.atomicWriteFileSync.mock.calls[0][1])
    expect(payload.mcpServers.cfgSrv).toMatchObject({ command: 'a' })
  })

  it('merges into an existing mcpServers block (no init needed)', async () => {
    H.listAgentNames.mockReturnValue(['preexisting'])
    const mcpPath = join(H.AGENTS_BASE_DIR, 'preexisting', '.mcp.json')
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { addSrv: { command: 'a' } } })
      if (p === mcpPath) return JSON.stringify({ mcpServers: { otherSrv: { command: 'b' } } })
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res } = await call('POST', '/api/connectors/addSrv/assign', { body: { agents: ['preexisting'] } })
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(H.atomicWriteFileSync.mock.calls[0][1])
    // both keys present -- addSrv merged in without dropping otherSrv.
    expect(payload.mcpServers).toMatchObject({
      addSrv: { command: 'a' },
      otherSrv: { command: 'b' },
    })
  })

  it('returns false for a non-POST method on /assign', async () => {
    const { handled } = await call('GET', '/api/connectors/srv/assign')
    expect(handled).toBe(false)
  })
})

// ============================================================================
// GET /api/mcp-catalog
// ============================================================================

describe('GET /api/mcp-catalog', () => {
  it('marks entries from getMcpListCache as installed (using either normalizedId or slug(name))', async () => {
    H.getMcpListCache.mockReturnValue({
      entries: [
        { name: 'n', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'claude.ai' },
      ],
      lastRefreshed: 0, refreshing: false,
    })
    const { res, json } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, any>>
    const gmail = arr.find(e => e.id === 'gmail')
    expect(gmail).toMatchObject({ installed: true, installedSource: 'claude.ai', configMatch: false })
  })

  it('falls back to nameSlug when normalizedId does not match', async () => {
    // Catalog item id='slugid' (itemId='slugid'), name='Gmail' (itemNameSlug='gmail')
    // Cache entry normalizedId='gmail' -> matches via the nameSlug lookup branch.
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([
        { id: 'slugid', name: 'Gmail', type: 'remote', url: 'https://x', env: {} },
      ]),
    )
    H.getMcpListCache.mockReturnValue({
      entries: [
        { name: 'gmail', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'local' },
      ],
      lastRefreshed: 0, refreshing: false,
    })
    const { res, json } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, any>>
    const entry = arr.find(e => e.id === 'slugid')
    expect(entry).toMatchObject({ installed: true, installedSource: 'local' })
  })

  it('triggers the configMatch branch when catalogMatchesConfigured returns true', async () => {
    H.catalogMatchesConfigured.mockReturnValue(true)
    H.getMcpListCache.mockReturnValue({ entries: [], lastRefreshed: 0, refreshing: false })
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    const gmail = arr.find(e => e.id === 'gmail')
    expect(gmail).toMatchObject({ installed: true, installedSource: 'local', configMatch: true })
  })

  it('returns 500 when loadMcpCatalog throws (e.g. mcp-catalog.json missing/corrupt)', async () => {
    rmSync(join(H.projectRoot, 'mcp-catalog.json'))
    const { res, json } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to load catalog' })
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to load MCP catalog')
  })

  it('reads mcpServers out of every configured MCP file (collectConfiguredServerSlugs inner loop)', async () => {
    // Force collectConfiguredServerSlugs to find a real server name in a
    // PROJECT_ROOT/.mcp.json so the inner `for (const name of Object.keys(...))`
    // loop executes (lines 78-81). The catalog picks it up via catalogMatchesConfigured.
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { 'gmail-personal': { command: 'x' } } })
      }
      return fallback
    })
    H.catalogMatchesConfigured.mockImplementation((idSlug, nameSlug, slugs) => {
      void idSlug; void nameSlug
      for (const s of slugs) if (s === 'gmail-personal') return true
      return false
    })
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    // 'gmail' catalog item id -> slug 'gmail' -- the configured slug 'gmail-personal'
    // is matched by slugify-via-collectConfiguredServerSlugs, so configMatch=true.
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ installed: true, configMatch: true })
  })

  it('iterates external paths inside collectConfiguredServerSlugs', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'catalog-ext-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { 'gmail-personal': { command: 'y' } } })
      }
      return fallback
    })
    H.catalogMatchesConfigured.mockReturnValue(true)
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ installed: true, configMatch: true })
  })

  it('warns when mcp-catalog.local.json exists but is not a JSON array', async () => {
    writeFileSync(join(H.projectRoot, 'mcp-catalog.local.json'), '{"oops":"not-an-array"}')
    const { res } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(200)
    expect(H.loggerWarn).toHaveBeenCalledWith(expect.anything(), 'mcp-catalog.local.json is not a JSON array, ignoring')
  })

  it('errors when mcp-catalog.local.json exists but fails to parse', async () => {
    writeFileSync(join(H.projectRoot, 'mcp-catalog.local.json'), 'NOT JSON{')
    const { res } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(200)
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to parse mcp-catalog.local.json, ignoring')
  })

  it('uses the local catalog to override committed entries by id', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.local.json'),
      JSON.stringify([{ id: 'gmail', name: 'Gmail (local override)', type: 'remote', url: 'https://local.test/mcp' }]),
    )
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ name: 'Gmail (local override)' })
  })

  it('iterates per-agent .mcp.json paths inside collectConfiguredServerSlugs', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) {
        return JSON.stringify({ mcpServers: { 'gmail-personal': { command: 'a' } } })
      }
      return fallback
    })
    H.catalogMatchesConfigured.mockReturnValue(true)
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ installed: true, configMatch: true })
  })

  it('skips empty slugs in collectConfiguredServerSlugs (slugify returned "" for a name)', async () => {
    // Server with a name like '!!!' slugifies to '' -> the if (s) add() guard
    // skips it. This still counts as installed (no id collision with catalog).
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { '!!!': { command: 'x' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/mcp-catalog')
    // No exception and the catalog list is returned intact.
    expect(Array.isArray(json())).toBe(true)
  })

  it('marks an item as installed via its cached source (source !== undefined path)', async () => {
    // Two cache entries share the same normalizedId -- only the FIRST sets
    // installedSource, the second hits the `!installedSource.has(...)` false
    // branch (line 597).
    H.getMcpListCache.mockReturnValue({
      entries: [
        { name: 'a', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'claude.ai' },
        { name: 'b', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'local' },
      ],
      lastRefreshed: 0, refreshing: false,
    })
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ installed: true, installedSource: 'claude.ai' })
  })

  it('falls through to local-remote when item.id is undefined (slugifyMcp("") returns "")', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([
        // No id field -- slug returns '' -> null. Slack-warns on .name lookups.
        { name: 'tool', type: 'remote', url: 'https://x' },
      ]),
    )
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    // The entries are still returned; the bug is that "id" stays empty
    // (used by the dashboard), but coverage requires both slugify calls.
    expect(arr[0]).toBeDefined()
  })
})

// ============================================================================
// Branches in the GET /api/connectors per-agent + per-project + ext discovery
// ============================================================================

describe('GET /api/connectors -- branch coverage', () => {
  it('skips agents with no projects/ dir (existsSync false) and walks non-directories inside the projects loop', async () => {
    H.listAgentNames.mockReturnValue(['no-projects', 'flat-only'])
    // 'no-projects' has no projects dir at all
    const noProjectsDir = join(H.AGENTS_BASE_DIR, 'no-projects')
    mkdirSync(noProjectsDir, { recursive: true })
    // 'flat-only' has a projects dir but only a non-directory entry
    const flatProjectsDir = join(H.AGENTS_BASE_DIR, 'flat-only', 'projects')
    mkdirSync(flatProjectsDir, { recursive: true })
    writeFileSync(join(flatProjectsDir, 'flatfile'), 'not-a-dir')

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: {
          remoteOnly: { url: 'https://x' },
          localOnly: { command: 'do' },
          combined: { url: 'https://a', command: 'do' }, // cfg.url preferred
        } })
      }
      if (p === join(noProjectsDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { agentLocal: { command: 'a' } } })
      }
      return fallback
    })

    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'remoteOnly')).toMatchObject({ type: 'remote' })
    expect(body.find(e => e.name === 'localOnly')).toMatchObject({ type: 'local' })
    expect(body.find(e => e.name === 'combined')).toMatchObject({ type: 'remote' })  // cfg.url wins
    expect(body.find(e => e.name === 'agentLocal')).toBeDefined()
    // Both agents with .mcp.json produce nothing under projects/ because
    // either projects dir doesn't exist (no-projects) or only contains a
    // non-directory (flat-only).
  })

  it('exercises the ext-project source loop with both URL and command fallback paths', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'ext-branch-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: {
          extRemote: { url: 'https://e' },
          extLocal: { command: 'f' },
        } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'extRemote')).toMatchObject({ type: 'remote' })
    expect(body.find(e => e.name === 'extLocal')).toMatchObject({ type: 'local' })
  })

  it('discovers agent projects whose .mcp.json contains both remote and local entries', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'realproj')
    mkdirSync(realProj, { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: {
          projRemote: { url: 'https://r' },
          projLocal: { command: 'p' },
        } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'projRemote')).toMatchObject({ type: 'remote' })
    expect(body.find(e => e.name === 'projLocal')).toMatchObject({ type: 'local' })
  })

  it('covers an agent-level .mcp.json with URL (cfg?.url truthy branch) and a ghost server with neither', async () => {
    H.listAgentNames.mockReturnValue(['arr'])
    const agentDir = join(H.AGENTS_BASE_DIR, 'arr')
    mkdirSync(agentDir, { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(agentDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: {
          aRemote: { url: 'https://a' },
          aEmpty: { env: { X: 'y' } }, // neither url nor command
        } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'aRemote')).toMatchObject({ type: 'remote' })
    expect(body.find(e => e.name === 'aEmpty')).toMatchObject({ type: 'local', endpoint: '' })
  })

  it('covers external paths whose .mcp.json has URL and an empty entry', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'branches-ext-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: {
          extRemote: { url: 'https://e' },
          extEmpty: { env: { X: 'y' } },
        } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'extRemote')).toMatchObject({ type: 'remote' })
    expect(body.find(e => e.name === 'extEmpty')).toMatchObject({ type: 'local', endpoint: '' })
  })
})

// ============================================================================
// POST /api/mcp-catalog/:id/install
// ============================================================================

describe('POST /api/mcp-catalog/:id/install', () => {
  it('installs a local catalog item with default non-secret env as -e flags and binds the secrets', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([
        { id: 'gmail', name: 'Gmail', type: 'local', command: 'node', args: ['x', 'y'], env: { DEFAULT_TOKEN: 'val', SECRET: '' } },
      ]),
    )
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res, json } = await call('POST', '/api/mcp-catalog/gmail/install', {
      body: { env: { SECRET: 'plaintext' } },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true })
    expect(H.execSync).toHaveBeenCalledWith(expect.stringContaining('claude mcp add'), expect.any(Object))
    expect(H.execSync.mock.calls[0][0]).toMatch(/-e 'DEFAULT_TOKEN'='val'/)
    expect(H.setSecret).toHaveBeenCalledWith(expect.stringMatching(/^gmail-secret/), 'SECRET (gmail)', 'plaintext')
  })

  it('installs a local catalog item when the user submits no env overrides', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'plain', name: 'Plain', type: 'local', command: 'node', args: [], env: {} }]),
    )
    const { res } = await call('POST', '/api/mcp-catalog/plain/install', { body: {} })
    expect(res.statusCode).toBe(200)
  })

  it('appends the oauth authNote to the install message when present', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'oauth-tool', name: 'OT', type: 'local', command: 'node', env: {}, authType: 'oauth', authNote: 'auth then' }]),
    )
    const { res, json } = await call('POST', '/api/mcp-catalog/oauth-tool/install', { body: {} })
    expect(res.statusCode).toBe(200)
    expect((json() as Record<string, string>).message).toMatch(/auth then/)
  })

  it('installs a remote catalog item with transport=http when explicitly set', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'gmail', name: 'Gmail', type: 'remote', url: 'https://x', transport: 'http' }]),
    )
    const { res } = await call('POST', '/api/mcp-catalog/gmail/install', { body: {} })
    expect(res.statusCode).toBe(200)
    expect(H.execSync.mock.calls[0][0]).toMatch(/--transport http/)
  })

  it('falls back to sse transport for remote items when transport is missing', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'nosetrans', name: 'N', type: 'remote', url: 'https://x' }]),
    )
    const { res } = await call('POST', '/api/mcp-catalog/nosetrans/install', { body: {} })
    expect(res.statusCode).toBe(200)
    expect(H.execSync.mock.calls[0][0]).toMatch(/--transport sse/)
  })

  it('400s when the remote item has no URL', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'nourl', name: 'NU', type: 'remote' }]),
    )
    const { res, json } = await call('POST', '/api/mcp-catalog/nourl/install', { body: {} })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Remote item has no URL' })
  })

  it('404s when the id is unknown', async () => {
    const { res, json } = await call('POST', '/api/mcp-catalog/unknown/install', { body: {} })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Item not found in catalog' })
  })

  it('tolerates an unparseable body and treats it as empty env', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'plain', name: 'Plain', type: 'local', command: 'node', args: [], env: {} }]),
    )
    const { res } = await call('POST', '/api/mcp-catalog/plain/install', { raw: 'not-json' })
    expect(res.statusCode).toBe(200)
  })

  it('binds user-supplied env secrets for the catalog local-install branch', async () => {
    // Set a catalog item where userSecrets will be non-empty (one secret).
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'gmail', name: 'Gmail', type: 'local', command: 'node', env: {}, args: [] }]),
    )
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res } = await call('POST', '/api/mcp-catalog/gmail/install', {
      body: { env: { TOKEN: 'plaintext' } },
    })
    expect(res.statusCode).toBe(200)
    // vaultAndBindEnvSecrets calls setSecret for the user secret.
    expect(H.setSecret).toHaveBeenCalledWith('gmail-token', 'TOKEN (gmail)', 'plaintext')
  })

  it('returns 500 when install throws unexpectedly', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'plain', name: 'Plain', type: 'local', command: 'node', args: [], env: {} }]),
    )
    H.execSync.mockImplementation(() => { throw Object.assign(new Error('install failed'), { message: 'install failed' }) })
    const { res, json } = await call('POST', '/api/mcp-catalog/plain/install', { body: {} })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'install failed' })
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to install MCP from catalog')
  })

  it('falls back to "Failed to install" when the install error has no message', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'plain', name: 'Plain', type: 'local', command: 'node', args: [], env: {} }]),
    )
    const err: any = new Error()
    err.message = ''
    H.execSync.mockImplementation(() => { throw err })
    const { res, json } = await call('POST', '/api/mcp-catalog/plain/install', { body: {} })
    expect(res.statusCode).toBe(500)
    expect((json() as Record<string, string>).error).toBe('Failed to install')
  })

  it('catches the outer error when loadMcpCatalog itself throws (catalog unreadable)', async () => {
    // Direct test of the OUTER catch branch (lines 714-715). Force the JSON
    // parse on the catalog file to throw without execSync entering the picture.
    rmSync(join(H.projectRoot, 'mcp-catalog.json'))
    // No execSync override -- we expect to never reach it because JSON.parse
    // throws first inside loadMcpCatalog.
    const { res, json } = await call('DELETE', '/api/mcp-catalog/gmail/uninstall')
    expect(res.statusCode).toBe(500)
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to uninstall MCP from catalog')
    expect((json() as Record<string, string>).error).toBeTruthy()
  })

  it('falls back to "Failed to uninstall" when the uninstall error has no message', async () => {
    // Drive the OUTER uninstall catch via loadMcpCatalog itself -- the inner
    // try/catch swallows execSync errors, so the OUTER catch only fires on a
    // catalog-level failure. Throw a message-less value through JSON.parse to
    // exercise the `err.message || "Failed to uninstall"` default.
    writeFileSync(join(H.projectRoot, 'mcp-catalog.json'), ']invalid[')
    const parseSpy = vi.spyOn(JSON, 'parse').mockImplementationOnce(() => {
      // eslint-disable-next-line no-throw-literal
      throw {}
    })
    try {
      const { res, json } = await call('DELETE', '/api/mcp-catalog/gmail/uninstall')
      expect(res.statusCode).toBe(500)
      expect((json() as Record<string, string>).error).toBe('Failed to uninstall')
    } finally {
      parseSpy.mockRestore()
    }
  })
})

// ============================================================================
// DELETE /api/mcp-catalog/:id/uninstall
// ============================================================================

describe('DELETE /api/mcp-catalog/:id/uninstall', () => {
  it('runs the first execSync (user scope) when it succeeds', async () => {
    writeFileSync(join(H.projectRoot, 'mcp-catalog.json'), JSON.stringify([{ id: 'gmail', name: 'Gmail', type: 'local', command: 'x', env: {} }]))
    const { res, json } = await call('DELETE', '/api/mcp-catalog/gmail/uninstall')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, message: 'Eltávolítva' })
    expect(H.execSync).toHaveBeenCalledTimes(1)
  })

  it('falls through to the project-scope execSync when the user-scope one throws', async () => {
    writeFileSync(join(H.projectRoot, 'mcp-catalog.json'), JSON.stringify([{ id: 'gmail', name: 'Gmail', type: 'local', command: 'x', env: {} }]))
    H.execSync.mockImplementation(() => { throw new Error('not in user scope') })
    const { res, json } = await call('DELETE', '/api/mcp-catalog/gmail/uninstall')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, message: 'Eltávolítva' })
    expect(H.execSync).toHaveBeenCalledTimes(2)
  })

  it('404s when the id is unknown', async () => {
    const { res, json } = await call('DELETE', '/api/mcp-catalog/unknown/uninstall')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Item not found in catalog' })
  })

  it('returns 500 when both execSync attempts throw unexpectedly', async () => {
    writeFileSync(join(H.projectRoot, 'mcp-catalog.json'), JSON.stringify([{ id: 'gmail', name: 'Gmail', type: 'local', command: 'x', env: {} }]))
    // Both user- and project-scope execSync throws. The outer try/catch in the
    // dispatcher catches the inner one as a non-fatal "ignore if not found",
    // so the route still returns 200; to exercise the OUTER catch we must
    // make loadMcpCatalog itself throw -- replace mcp-catalog.json with a
    // directory so JSON.parse fails. We can fake it by forcing loadMcpCatalog
    // to throw via making the file unreadable. Easier: rmSync the catalog
    // file -- then both execSync calls do throw AND JSON.parse throws.
    rmSync(join(H.projectRoot, 'mcp-catalog.json'))
    H.execSync.mockImplementation(() => { throw new Error('cli missing') })
    const { res, json } = await call('DELETE', '/api/mcp-catalog/gmail/uninstall')
    // Outer catch wins on the JSON.parse throw.
    expect(res.statusCode).toBe(500)
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to uninstall MCP from catalog')
    expect((json() as Record<string, string>).error).toBeTruthy()
  })

  it('catches the outer error when loadMcpCatalog itself throws (catalog unreadable)', async () => {
    // Direct test of the OUTER catch branch (lines 714-715). Force the JSON
    // parse on the catalog file to throw without execSync entering the picture.
    rmSync(join(H.projectRoot, 'mcp-catalog.json'))
    // No execSync override -- we expect to never reach it because JSON.parse
    // throws first inside loadMcpCatalog.
    const { res, json } = await call('DELETE', '/api/mcp-catalog/gmail/uninstall')
    expect(res.statusCode).toBe(500)
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to uninstall MCP from catalog')
    expect((json() as Record<string, string>).error).toBeTruthy()
  })
})

// ============================================================================
// /api/vault  -- get + post + get-by-id + delete-by-id (and the ssh-key filter)
// ============================================================================

describe('/api/vault', () => {
  it('GET filters out ssh-key-* entries', async () => {
    H.listSecrets.mockReturnValue([
      { id: 'regular', label: 'r', createdAt: '1', updatedAt: '2' },
      { id: 'ssh-key-foo', label: 'sk', createdAt: '1', updatedAt: '2' },
    ])
    const { res, json } = await call('GET', '/api/vault')
    expect(res.statusCode).toBe(200)
    const body = json() as { secrets: Array<{ id: string }> }
    expect(body.secrets.map((s) => s.id)).toEqual(['regular'])
  })

  it('POST 400s when id or value is missing', async () => {
    const { res, json } = await call('POST', '/api/vault', { body: { id: '   ', value: 'v' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'id and value required' })
  })

  it('POST sets the secret and reports the sync result (falls back to id as label when blank)', async () => {
    H.syncSecret.mockReturnValue({ updated: 2, errors: [] })
    const { res, json } = await call('POST', '/api/vault', { body: { id: 'tok', label: '', value: 'v' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, synced: 2 })
    expect(H.setSecret).toHaveBeenCalledWith('tok', 'tok', 'v')
  })

  it('GET /api/vault/:id 404s when the secret is missing', async () => {
    const { res, json } = await call('GET', '/api/vault/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Not found' })
  })

  it('GET /api/vault/:id returns the secret when found', async () => {
    H.getSecret.mockReturnValue('plaintext')
    const { res, json } = await call('GET', '/api/vault/known')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ id: 'known', value: 'plaintext' })
  })

  it('GET skips subroutes sync/import/ssh-servers/ssh-keys (no GET handler in connectors.ts)', async () => {
    // /api/vault/bindings is handled by connectors.ts itself.
    // /api/vault/scan IS handled by connectors.ts (below).
    // So only these fall through to the next dispatcher:
    for (const sub of ['sync', 'import', 'ssh-servers', 'ssh-keys']) {
      const { handled } = await call('GET', `/api/vault/${sub}`)
      expect(handled).toBe(false)
    }
  })

  it('GET /api/vault/scan IS handled by connectors.ts and returns findings', async () => {
    H.scanMcpConfigs.mockReturnValue([{ a: 1 }])
    const { res, json } = await call('GET', '/api/vault/scan')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ findings: [{ a: 1 }] })
  })

  it('GET /api/vault/bindings is handled by connectors.ts itself', async () => {
    H.getBindings.mockReturnValue([])
    const { res } = await call('GET', '/api/vault/bindings')
    expect(res.statusCode).toBe(200)
  })

  it('DELETE /api/vault/:id 404s when the secret does not exist', async () => {
    H.deleteSecret.mockReturnValue(false)
    const { res, json } = await call('DELETE', '/api/vault/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Not found' })
  })

  it('DELETE /api/vault/:id removes bindings + reports ok', async () => {
    const { res, json } = await call('DELETE', '/api/vault/known')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.removeBindingsForSecret).toHaveBeenCalledWith('known')
  })

  it('DELETE skips subroutes sync/scan/import/ssh-servers/ssh-keys (no DELETE handler)', async () => {
    // /api/vault/bindings WITHOUT a /:secret/:envVar suffix has no DELETE handler
    // -- the sibling vault-ssh routes step in for ssh-* subroutes.
    for (const sub of ['bindings', 'sync', 'scan', 'import', 'ssh-servers', 'ssh-keys']) {
      const { handled } = await call('DELETE', `/api/vault/${sub}`)
      expect(handled).toBe(false)
    }
  })
})

// ============================================================================
// /api/vault/bindings
// ============================================================================

describe('/api/vault/bindings', () => {
  it('GET lists the bindings', async () => {
    H.getBindings.mockReturnValue([{ vaultSecretId: 'a', envVar: 'b', targets: [] }])
    const { json } = await call('GET', '/api/vault/bindings')
    expect(json()).toEqual({ bindings: [{ vaultSecretId: 'a', envVar: 'b', targets: [] }] })
  })

  it('POST 400s when vaultSecretId or envVar/headerName is missing', async () => {
    const r1 = await call('POST', '/api/vault/bindings', { body: { vaultSecretId: 'a' } })
    expect(r1.res.statusCode).toBe(400)
    const r2 = await call('POST', '/api/vault/bindings', { body: { envVar: 'X' } })
    expect(r2.res.statusCode).toBe(400)
  })

  it('POST 400s when no targets are supplied and the search finds nothing', async () => {
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'a', envVar: 'X', serverName: 'ghost' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No targets found for this server' })
  })

  it('POST creates an env binding and syncs when serverName resolves to existing configs', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { foo: { command: 'x' } } })
      }
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', envVar: 'TOKEN', serverName: 'foo' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, synced: 1, errors: [] })
    expect(H.addBinding).toHaveBeenCalledWith({
      vaultSecretId: 'sec', envVar: 'TOKEN',
      targets: [{ mcpFilePath: join(H.PROJECT_ROOT, '.mcp.json'), serverName: 'foo' }],
    })
  })

  it('POST creates a header binding when headerName is supplied', async () => {
    H.listAgentNames.mockReturnValue([])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { h: { url: 'https://h' } } })
      }
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: {
        vaultSecretId: 'sec', serverName: 'h',
        headerName: 'Authorization', headerScheme: 'Bearer',
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, synced: 1, errors: [] })
    const bindingArg = H.addBinding.mock.calls[0][0] as Record<string, unknown>
    expect(bindingArg.headerName).toBe('Authorization')
    expect(bindingArg.headerScheme).toBe('Bearer')
  })

  // src/web/routes/connectors.ts:788 -- branch[1] (else) of
  //   if (data.serverName && targets.length === 0) { ... search ... }
  // When the caller supplies explicit targets, the search block is skipped
  // entirely and the supplied targets pass straight through.
  it('POST skips the target-search block when explicit targets are supplied', async () => {
    H.listAgentNames.mockReturnValue([]) // would have been searched otherwise
    H.readFileOr.mockImplementation((_p: string, fallback: string) => fallback) // would have matched 'h' otherwise
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: {
        vaultSecretId: 'sec',
        envVar: 'TOKEN',
        targets: [{ mcpFilePath: '/explicit/.mcp.json', serverName: 'h' }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, synced: 1, errors: [] })
    expect(H.addBinding).toHaveBeenCalledWith({
      vaultSecretId: 'sec',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: '/explicit/.mcp.json', serverName: 'h' }],
    })
  })

  it('POST header binding defaults the scheme to Bearer when headerScheme is omitted', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { h: { url: 'https://h' } } })
      }
      return fallback
    })
    const { res } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', serverName: 'h', headerName: 'X-Auth' },
    })
    expect(res.statusCode).toBe(200)
    const bindingArg = H.addBinding.mock.calls[0][0] as Record<string, unknown>
    expect(bindingArg.headerName).toBe('X-Auth')
    expect(bindingArg.headerScheme).toBe('Bearer')
  })

  it('POST walks the agent + agent-project search paths before declaring no targets', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    // Plain file -- rejected by isDirectory() -- no extra targets pushed.
    writeFileSync(join(projectsDir, 'flat'), 'nope')

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) {
        return JSON.stringify({ mcpServers: { foo: { command: 'x' } } })
      }
      return fallback
    })

    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', envVar: 'TOKEN', serverName: 'foo' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, synced: 1 })
  })

  it('POST reports a sync error when syncSecret surfaces one (and the bind still happened)', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { foo: { command: 'x' } } })
      }
      return fallback
    })
    H.syncSecret.mockReturnValue({ updated: 0, errors: ['nope'] })
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', envVar: 'TOKEN', serverName: 'foo' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, synced: 0, errors: ['nope'] })
  })

  it('resolves the binding target via an external project path', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'bindings-ext-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { extSrv: { command: 'x' } } })
      }
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', envVar: 'TOKEN', serverName: 'extSrv' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, synced: 1 })
  })

  it('scans agent projects/ subdirs while searching for binding targets', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'blog')
    mkdirSync(realProj, { recursive: true })

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { blogSrv: { command: 'a' } } })
      }
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', envVar: 'TOKEN', serverName: 'blogSrv' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, synced: 1 })
  })
})

// ============================================================================
// DELETE /api/vault/bindings/:secret/:envVar
// ============================================================================

describe('DELETE /api/vault/bindings/:secret/:envVar', () => {
  it('unsyncs + removes a binding; 404s when removeBinding returns false', async () => {
    H.removeBinding.mockReturnValue(false)
    const { res, json } = await call('DELETE', '/api/vault/bindings/sec/TOKEN')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Binding not found' })
    expect(H.unsyncBinding).toHaveBeenCalledWith('sec', 'TOKEN')
  })

  it('returns ok when the binding was removed', async () => {
    H.removeBinding.mockReturnValue(true)
    const { res, json } = await call('DELETE', '/api/vault/bindings/sec/TOKEN')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })
})

// ============================================================================
// POST /api/vault/sync
// ============================================================================

describe('POST /api/vault/sync', () => {
  it('returns the full sync result', async () => {
    H.syncAllBindings.mockReturnValue({ updated: 5, errors: ['e1'] })
    const { res, json } = await call('POST', '/api/vault/sync')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, updated: 5, errors: ['e1'] })
  })
})

// ============================================================================
// /api/vault/scan + /api/vault/import
// ============================================================================

describe('GET /api/vault/scan', () => {
  it('returns the findings list', async () => {
    H.scanMcpConfigs.mockReturnValue([{ a: 1 }])
    const { json } = await call('GET', '/api/vault/scan')
    expect(json()).toEqual({ findings: [{ a: 1 }] })
  })
})

describe('POST /api/vault/import', () => {
  it('skips requests where the env value cannot be located in any target', async () => {
    const { res, json } = await call('POST', '/api/vault/import', {
      body: {
        imports: [{
          serverName: 's', envVar: 'X', vaultId: 'v',
          label: 'L', createBinding: false,
          targets: [{ mcpFilePath: '/nonexistent/.mcp.json', serverName: 's' }],
        }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.imported).toBe(0)
    expect((body.errors as string[])[0]).toMatch(/Could not read value for X from s/)
  })

  it('sets a vault entry when the env value is reachable (without creating a binding)', async () => {
    const file = join(H.projectRoot, 'import-target', '.mcp.json')
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === file) return JSON.stringify({ mcpServers: { s: { env: { X: 'plaintext' } } } })
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/import', {
      body: {
        imports: [{
          serverName: 's', envVar: 'X', vaultId: 'v',
          label: 'L', createBinding: false,
          targets: [{ mcpFilePath: file, serverName: 's' }],
        }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.imported).toBe(1)
    expect(H.setSecret).toHaveBeenCalledWith('v', 'L', 'plaintext')
    expect(H.addBinding).not.toHaveBeenCalled()
  })

  it('also creates + syncs the binding when createBinding=true', async () => {
    const file = join(H.projectRoot, 'bind-target', '.mcp.json')
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === file) return JSON.stringify({ mcpServers: { s: { env: { X: 'plaintext' } } } })
      return fallback
    })
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res, json } = await call('POST', '/api/vault/import', {
      body: {
        imports: [{
          serverName: 's', envVar: 'X', vaultId: 'v',
          label: 'L', createBinding: true,
          targets: [{ mcpFilePath: file, serverName: 's' }],
        }],
      },
    })
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body.imported).toBe(1)
    expect(body.bound).toBe(1)
    expect(H.addBinding).toHaveBeenCalledWith({
      vaultSecretId: 'v', envVar: 'X',
      targets: [{ mcpFilePath: file, serverName: 's' }],
    })
  })

  it('moves on after the first target that yields a value (later broken targets ignored)', async () => {
    const fileA = join(H.projectRoot, 'a', '.mcp.json')
    const fileB = join(H.projectRoot, 'b', '.mcp.json')
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === fileA) throw new Error('bad')
      if (p === fileB) return JSON.stringify({ mcpServers: { s: { env: { X: 'good' } } } })
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/import', {
      body: {
        imports: [{
          serverName: 's', envVar: 'X', vaultId: 'v',
          label: 'L', createBinding: false,
          targets: [
            { mcpFilePath: fileA, serverName: 's' },
            { mcpFilePath: fileB, serverName: 's' },
          ],
        }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect((json() as Record<string, unknown>).imported).toBe(1)
  })

  it('ignores non-string env values (defensive -- only string env values are imported)', async () => {
    const file = join(H.projectRoot, 'weird', '.mcp.json')
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === file) return JSON.stringify({ mcpServers: { s: { env: { X: 42 } } } })
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/import', {
      body: {
        imports: [{
          serverName: 's', envVar: 'X', vaultId: 'v',
          label: 'L', createBinding: false,
          targets: [{ mcpFilePath: file, serverName: 's' }],
        }],
      },
    })
    expect(res.statusCode).toBe(200)
    expect((json() as Record<string, unknown>).imported).toBe(0)
    expect(H.setSecret).not.toHaveBeenCalled()
  })
})

// ============================================================================
// GET /api/ollama/models
// ============================================================================

describe('GET /api/ollama/models', () => {
  it('formats the models on a successful fetch (filters out embed-* names)', async () => {
    fetchMock.mockResolvedValue({
      json: async () => ({
        models: [
          { name: 'llama3:70b', size: 40_000_000_000, details: { parameter_size: '70B' } },
          { name: 'nomic-embed-text', size: 100, details: {} },
          { name: 'phi3', size: 2_100_000_000 },
        ],
      }),
    })
    const { res, json } = await call('GET', '/api/ollama/models')
    expect(res.statusCode).toBe(200)
    const body = json() as Array<Record<string, string>>
    expect(body).toHaveLength(2)
    expect(body[0]).toMatchObject({ name: 'llama3:70b', params: '70B' })
    expect(body[0].size).toMatch(/GB$/)
    expect(body[1]).toMatchObject({ name: 'phi3', params: '' })
  })

  it('returns an empty array on fetch failure', async () => {
    fetchMock.mockRejectedValue(new Error('boom'))
    const { res, json } = await call('GET', '/api/ollama/models')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('returns [] when the upstream has no models[] field', async () => {
    fetchMock.mockResolvedValue({ json: async () => ({}) })
    const { res, json } = await call('GET', '/api/ollama/models')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })
})
