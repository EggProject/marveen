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
// The dispatcher reaches into config/logger/mcp-list-parser/mcp-list/
// agent-config/dashboard-settings/vault/vault-bindings/http-helpers/sanitize/
// atomic-write/child_process.execSync. Every collaborator is mocked here so
// the dispatcher runs against a deterministic fake and never touches the
// live store, the network, or the host shell.
//
// One helper is exported: `vaultAndBindEnvSecrets` -- covered separately.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const path = require('node:path') as typeof import('node:path')

  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-connectors-'))
  fs.writeFileSync(
    path.join(projectRoot, 'mcp-catalog.json'),
    JSON.stringify([
      { id: 'gmail', name: 'Gmail', type: 'remote', url: 'https://example.test/mcp', authType: 'apikey', env: {}, transport: 'http' },
      { id: 'local-tool', name: 'Local Tool', type: 'local', command: 'node server.js', env: {}, args: ['a', 'b'] },
    ]),
  )

  return {
    projectRoot,
    PROJECT_ROOT: projectRoot,
    OLLAMA_URL: 'http://ollama.test:11434',
    MAIN_AGENT_ID: 'marveen',

    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),

    slugify: vi.fn(<T>(s: T) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')),
    catalogMatchesConfigured: vi.fn(() => false),

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

    readFileOr: vi.fn((_p: string, fallback: string) => fallback),
    AGENTS_BASE_DIR: path.join(projectRoot, 'agents'),
    listAgentNames: vi.fn(() => [] as string[]),

    getExternalProjectPaths: vi.fn(() => [] as string[]),
    addExternalProjectPath: vi.fn((p: string): { paths: string[]; error?: string } => ({ paths: [p] })),
    removeExternalProjectPath: vi.fn(() => [] as string[]),
    getGitHubRepos: vi.fn(() => [] as unknown[]),
    installGitHubRepo: vi.fn(async () => ({ repo: { name: 'foo' }, requiredEnvVars: [] })),
    removeGitHubRepo: vi.fn((): { ok: boolean; error?: string } => ({ ok: true })),
    updateGitHubRepo: vi.fn((): { ok: boolean; error?: string } => ({ ok: true })),
    detectRequiredEnvVars: vi.fn(() => [] as string[]),

    listSecrets: vi.fn(() => [] as Array<{ id: string; label: string; createdAt: string; updatedAt: string }>),
    setSecret: vi.fn(),
    getSecret: vi.fn(() => null as string | null),
    deleteSecret: vi.fn(() => true),

    getBindings: vi.fn(() => [] as unknown[]),
    addBinding: vi.fn(),
    removeBinding: vi.fn(() => true),
    removeBindingsForSecret: vi.fn(),
    syncSecret: vi.fn(() => ({ updated: 1, errors: [] as string[] })),
    syncAllBindings: vi.fn(() => ({ updated: 0, errors: [] as string[] })),
    scanMcpConfigs: vi.fn(() => [] as unknown[]),
    unsyncBinding: vi.fn(),

    atomicWriteFileSync: vi.fn(),

    shellEscape: vi.fn((s: string) => `'${String(s).replace(/'/g, "'\\''")}'`),

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
  process.env.HOME = '/tmp/routes-connectors-home'
  process.env.USERPROFILE = '/tmp/routes-connectors-home'
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
  writeFileSync(
    join(H.projectRoot, 'mcp-catalog.json'),
    JSON.stringify([
      { id: 'gmail', name: 'Gmail', type: 'remote', url: 'https://example.test/mcp', authType: 'apikey', env: {}, transport: 'http' },
      { id: 'local-tool', name: 'Local Tool', type: 'local', command: 'node server.js', env: {}, args: ['a', 'b'] },
    ]),
  )
  rmSync(join(H.projectRoot, 'mcp-catalog.local.json'), { force: true })
})

// ============================================================================
// vaultAndBindEnvSecrets
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

  it('returns false for wrong methods on known paths', async () => {
    const a = await call('PATCH', '/api/connectors')
    expect(a.handled).toBe(false)
    const b = await call('PUT', '/api/mcp-catalog')
    expect(b.handled).toBe(false)
    const c = await call('PUT', '/api/vault')
    expect(c.handled).toBe(false)
    const d = await call('PUT', '/api/ollama/models')
    expect(d.handled).toBe(false)
  })
})

// ============================================================================
// GET /api/connectors
// ============================================================================

describe('GET /api/connectors', () => {
  it('returns 200 with an array even when settings.json read throws', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) throw new Error('boom')
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors')
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(json())).toBe(true)
  })

  it('emits a plugin:* entry per enabled plugin and dedupes by slug', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) {
        return JSON.stringify({
          enabledPlugins: {
            'Slack@Marketplace': true,
            'Telegram@Official': true,
            'Disabled@X': false,
            'Slack@Other': true,
          },
        })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'plugin:slack')).toBeTruthy()
    expect(body.find(e => e.name === 'plugin:telegram')).toBeTruthy()
    expect(body.filter(e => (e.name as string).startsWith('plugin:slack'))).toHaveLength(1)
  })

  it('reads remote + local MCP servers from .mcp.json / .claude.json', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { remote: { url: 'https://r.test' }, local: { command: 'echo hi' } } })
      }
      if (p.endsWith('.claude.json')) {
        return JSON.stringify({ mcpServers: { dup: { command: 'x' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'remote')).toMatchObject({ type: 'remote', source: 'local-project', scope: 'global' })
    expect(body.find(e => e.name === 'local')).toMatchObject({ type: 'local', endpoint: 'echo hi' })
  })

  it('falls back to getMcpListCache entries when not declared in a file', async () => {
    H.getMcpListCache.mockReturnValue({
      entries: [
        { name: 'plain', normalizedId: 'plain', endpoint: 'https://x', status: 'connected', source: 'local' },
        { name: 'Claude.ai Gmail', normalizedId: 'gmail', endpoint: 'u', status: 'connected', source: 'claude.ai' },
        { name: 'plugin:tg', normalizedId: 'tg', endpoint: 'cmd', status: 'unknown', source: 'plugin' },
      ],
      lastRefreshed: 0, refreshing: false, error: undefined,
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'plain')).toMatchObject({ status: 'connected', type: 'local', source: 'local' })
    expect(body.find(e => e.name === 'Claude.ai Gmail')).toMatchObject({ type: 'remote', source: 'claude.ai' })
    expect(body.find(e => e.name === 'plugin:tg')).toMatchObject({ status: 'configured', source: 'plugin' })
  })

  it('discovers per-agent .mcp.json entries (agent + agent-project scopes)', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'real')
    mkdirSync(realProj, { recursive: true })
    writeFileSync(join(realProj, '.mcp.json'), JSON.stringify({ mcpServers: { projServer: { command: 'proj-cmd' } } }))
    writeFileSync(join(projectsDir, 'flatfile'), 'not-a-dir')

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) {
        return JSON.stringify({ mcpServers: { agentServer: { command: 'agent-cmd' } } })
      }
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { projServer: { command: 'proj-cmd' } } })
      }
      return fallback
    })

    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'agentServer')).toMatchObject({ scope: 'agent:archivist', source: 'agent' })
    expect(body.find(e => e.name === 'projServer')).toMatchObject({ scope: 'project:archivist/real', source: 'agent-project' })
  })

  it('walks external project paths', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'rc-ext-'))
    const extMcp = join(extDir, '.mcp.json')
    writeFileSync(extMcp, JSON.stringify({ mcpServers: { extSrv: { command: 'ext-cmd' } } }))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === extMcp) return JSON.stringify({ mcpServers: { extSrv: { command: 'ext-cmd' } } })
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'extSrv')).toMatchObject({
      source: 'external-project',
      scope: `project:external/${path.basename(extDir)}`,
    })
  })

  it('dedupes file-source servers via the globalSeen set', async () => {
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

  it('dedupes cache entries that repeat a name already declared in a file', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { shared: { command: 'a' } } })
      }
      return fallback
    })
    H.getMcpListCache.mockReturnValue({
      entries: [{ name: 'shared', normalizedId: 'shared', endpoint: '', status: 'connected', source: 'local' }],
      lastRefreshed: 0, refreshing: false, error: undefined,
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.filter(e => e.name === 'shared')).toHaveLength(1)
  })

  it('hits the existsSync false branch for an agent with no projects/ in a detail lookup', async () => {
    H.listAgentNames.mockReturnValue(['noproj'])
    mkdirSync(join(H.AGENTS_BASE_DIR, 'noproj'), { recursive: true })
    // Connector is NOT in any file, so the scan walks every agent. The agent
    // has no projects/ subdir, so existsSync(projectsDir) returns false and the
    // inner loop is skipped.
    const { res, json } = await call('GET', '/api/connectors/ghost')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('covers an unknown item.type (not local/remote) in the catalog install branch', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'odd', name: 'Odd', type: 'unsupported', command: 'broken' }]),
    )
    // The dispatcher has no else branch for unsupported types -- it falls
    // through to the success path and returns ok because no error was thrown.
    const { res } = await call('POST', '/api/mcp-catalog/odd/install', { body: {} })
    expect(res.statusCode).toBe(200)
  })

  it('tolerates a catalog item with no name field (item.name ?? "" branch)', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'noname', type: 'remote', url: 'https://x' }]),
    )
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'noname')).toBeDefined()
  })

  it('falls back to empty endpoint when a server has neither URL nor command', async () => {
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

  it('tolerates a file with no mcpServers field', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ other: 'field' })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors')
    expect(res.statusCode).toBe(200)
    expect(Array.isArray(json())).toBe(true)
  })

  it('covers per-agent + per-project + ext-project loops with cfg.url=undefined (local type, empty endpoint)', async () => {
    H.listAgentNames.mockReturnValue(['arr'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'arr', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'sub')
    mkdirSync(realProj, { recursive: true })

    const extDir = mkdtempSync(join(tmpdir(), 'rc-empty-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.AGENTS_BASE_DIR, 'arr', '.mcp.json')) {
        return JSON.stringify({ mcpServers: { aSrv: { env: { X: 'y' } } } })
      }
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { pSrv: { env: { X: 'y' } } } })
      }
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { eSrv: { env: { X: 'y' } } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    for (const name of ['aSrv', 'pSrv', 'eSrv']) {
      const entry = body.find(e => e.name === name)
      expect(entry).toBeDefined()
      expect(entry).toMatchObject({ type: 'local', endpoint: '' })
    }
  })

  it('hits the truthy branch of cfg.url ? "remote" : "local" in agent, agent-project, and ext-project loops', async () => {
    H.listAgentNames.mockReturnValue(['arr'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'arr', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'sub')
    mkdirSync(realProj, { recursive: true })

    const extDir = mkdtempSync(join(tmpdir(), 'rc-truthy-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.AGENTS_BASE_DIR, 'arr', '.mcp.json')) {
        return JSON.stringify({ mcpServers: { aRmt: { url: 'https://a' } } })
      }
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { pRmt: { url: 'https://p' } } })
      }
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { eRmt: { url: 'https://e' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors')
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'aRmt')).toMatchObject({ type: 'remote', endpoint: 'https://a' })
    expect(body.find(e => e.name === 'pRmt')).toMatchObject({ type: 'remote', endpoint: 'https://p' })
    expect(body.find(e => e.name === 'eRmt')).toMatchObject({ type: 'remote', endpoint: 'https://e' })
  })

  it('covers parsed.mcpServers || {} in agent, agent-project, and ext-project loops', async () => {
    H.listAgentNames.mockReturnValue(['arr'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'arr', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    const realProj = join(projectsDir, 'sub')
    mkdirSync(realProj, { recursive: true })

    const extDir = mkdtempSync(join(tmpdir(), 'rc-nomcp-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])

    // Files have NO mcpServers field, so parsed.mcpServers is undefined and the
    // `|| {}` fallback fires in every loop. No connectors get pushed, but every
    // branch is exercised.
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.AGENTS_BASE_DIR, 'arr', '.mcp.json')) return JSON.stringify({ other: 'a' })
      if (p === join(realProj, '.mcp.json')) return JSON.stringify({ other: 'p' })
      if (p === join(extDir, '.mcp.json')) return JSON.stringify({ other: 'e' })
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors')
    expect(res.statusCode).toBe(200)
    const body = json() as Array<Record<string, unknown>>
    expect(body).toHaveLength(0)
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
  it('returns 200/ok on successful refresh', async () => {
    H.refreshMcpListCache.mockResolvedValue({
      entries: [{}, {}], lastRefreshed: 42, refreshing: false, error: undefined,
    })
    const { res, json } = await call('POST', '/api/connectors/refresh')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, count: 2, lastRefreshed: 42, error: undefined })
  })

  it('returns 502 when the refresh reports an error', async () => {
    H.refreshMcpListCache.mockResolvedValue({ entries: [], lastRefreshed: 9, refreshing: false, error: 'spawn ENOENT' })
    const { res, json } = await call('POST', '/api/connectors/refresh')
    expect(res.statusCode).toBe(502)
    expect(json()).toMatchObject({ ok: false, error: 'spawn ENOENT' })
  })
})

// ============================================================================
// /api/connectors/external-paths
// ============================================================================

describe('/api/connectors/external-paths', () => {
  it('GET lists paths', async () => {
    H.getExternalProjectPaths.mockReturnValue(['/a', '/b'])
    const { json } = await call('GET', '/api/connectors/external-paths')
    expect(json()).toEqual({ paths: ['/a', '/b'] })
  })

  it('POST adds a path', async () => {
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

  it('DELETE removes a path', async () => {
    H.removeExternalProjectPath.mockReturnValue([])
    const { res, json } = await call('DELETE', '/api/connectors/external-paths', { body: { path: '/x' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, paths: [] })
  })
})

// ============================================================================
// /api/connectors/github-repos
// ============================================================================

describe('/api/connectors/github-repos', () => {
  it('GET lists repos', async () => {
    H.getGitHubRepos.mockReturnValue([{ name: 'a' }])
    const { json } = await call('GET', '/api/connectors/github-repos')
    expect(json()).toEqual({ repos: [{ name: 'a' }] })
  })

  it('POST installs a repo (no env)', async () => {
    const { res, json } = await call('POST', '/api/connectors/github-repos', {
      body: { url: 'https://github.com/foo/bar' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, repo: { name: 'foo' }, requiredEnvVars: [] })
    expect(H.installGitHubRepo).toHaveBeenCalledWith('https://github.com/foo/bar', undefined)
  })

  it('POST installs a repo and persists env to vault', async () => {
    const { res, json } = await call('POST', '/api/connectors/github-repos', {
      body: { url: 'https://github.com/foo/bar', env: { TOKEN: 't' } },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, repo: { name: 'foo' }, requiredEnvVars: [] })
    expect(H.setSecret.mock.calls[0][0]).toMatch(/^github-env-token-/)
    const mapping = (H.installGitHubRepo.mock.calls[0] as unknown as [string, Record<string, string> | undefined] | undefined)?.[1]
    expect(mapping?.TOKEN).toMatch(/^github-env-token-/)
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

  it('DELETE 404s when the repo is unknown', async () => {
    H.removeGitHubRepo.mockReturnValue({ ok: false, error: 'Repo not found' })
    const { res, json } = await call('DELETE', '/api/connectors/github-repos/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Repo not found' })
  })

  it('PATCH /api/connectors/github-repos/:name updates', async () => {
    const { res } = await call('PATCH', '/api/connectors/github-repos/foo--bar')
    expect(res.statusCode).toBe(200)
    expect(H.updateGitHubRepo).toHaveBeenCalledWith('foo--bar')
  })

  it('PATCH 400s when update fails', async () => {
    H.updateGitHubRepo.mockReturnValue({ ok: false, error: 'Directory missing' })
    const { res, json } = await call('PATCH', '/api/connectors/github-repos/missing')
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Directory missing' })
  })
})

// ============================================================================
// GET /api/connectors/:name
// ============================================================================

describe('GET /api/connectors/:name', () => {
  it('returns plugin metadata when a match is found', async () => {
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

  it('404s for plugin: with no match', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) return JSON.stringify({ enabledPlugins: {} })
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/plugin:nope')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('404s for plugin: when settings.json read throws', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) throw new Error('boom')
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/plugin:nope')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('handles plugin: with multiple :segments (uses last segment for match)', async () => {
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

  it('exercises the segments[last] || rawSuffix branch when a path has empty trailing segments', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) {
        return JSON.stringify({ enabledPlugins: { 'Slack@Marketplace': true } })
      }
      return fallback
    })
    // path "plugin:slack:" -> rawSuffix='slack:', segments=['slack',''], segments[last]='',
    // plain = '' || 'slack:' = 'slack:' (no match against 'Slack@Marketplace' -> 'slack').
    const { res, json } = await call('GET', '/api/connectors/plugin:slack:')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('covers the settings.enabledPlugins || {} branch when enabledPlugins is missing (detail lookup)', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('settings.json')) return JSON.stringify({})
      return fallback
    })
    const { res } = await call('GET', '/api/connectors/plugin:slack')
    expect(res.statusCode).toBe(404)
  })

  it('covers the existsSync false branch for an agent with no projects/ in GET /api/connectors', async () => {
    H.listAgentNames.mockReturnValue(['noproj'])
    mkdirSync(join(H.AGENTS_BASE_DIR, 'noproj'), { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.AGENTS_BASE_DIR, 'noproj', '.mcp.json')) {
        return JSON.stringify({ mcpServers: { x: { command: 'a' } } })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors')
    expect(res.statusCode).toBe(200)
    const body = json() as Array<Record<string, unknown>>
    expect(body.find(e => e.name === 'x')).toMatchObject({ scope: 'agent:noproj' })
  })

  it('resolves from PROJECT_ROOT/.mcp.json and redacts env', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({
          mcpServers: { projSrv: { command: 'node', args: ['s', '1'], env: { TOKEN: 'p', FLAG: 'x' } } },
        })
      }
      return fallback
    })
    const { res, json } = await call('GET', '/api/connectors/projSrv')
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      name: 'projSrv', scope: 'project', type: 'local',
      command: 'node', args: 's 1', env: { TOKEN: '***', FLAG: '***' },
    })
  })

  it('reports remote type when URL is configured', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { r: { url: 'https://r.test' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/r')
    expect(json()).toMatchObject({ type: 'remote', command: 'https://r.test', args: '' })
  })

  it('uses cfg.url as command when no command field exists', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { urlOnly: { url: 'https://w' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/urlOnly')
    expect(json()).toMatchObject({ type: 'remote', command: 'https://w', args: '' })
  })

  it('uses empty command when neither command nor URL is set', async () => {
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

  it('skips non-directories in agent projects while looking up', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
    writeFileSync(join(projectsDir, 'flatfile'), 'x')
    const realProj = join(projectsDir, 'blog')
    mkdirSync(realProj, { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(realProj, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { blogSrv: { command: 'a' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/connectors/blogSrv')
    expect(json()).toMatchObject({ scope: 'project:archivist/blog' })
  })

  it('scans external project paths for the connector', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'rc-det-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(extDir, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { extSrv: { command: 'a' } } })
      }
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
})

// ============================================================================
// POST /api/connectors (add MCP server)
// ============================================================================

describe('POST /api/connectors (add MCP server)', () => {
  it('400s when name is missing/blank', async () => {
    const { res, json } = await call('POST', '/api/connectors', { body: { type: 'http', url: 'https://x' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Name is required' })
  })

  it('400s when sanitized name is empty', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: '!!!', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Name must contain at least one letter, number, hyphen, or underscore' })
  })

  it('installs an http MCP server with env and reports apikey auth', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'gmail', type: 'http', url: 'https://example.test/mcp', scope: 'project', env: { TOKEN: 't' } },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'gmail', nameChanged: false })
  })

  it('installs an sse MCP server', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'sse-tool', type: 'sse', url: 'https://sse.test', scope: 'user' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'sse-tool', nameChanged: false })
  })

  it('reports nameChanged=true when sanitization alters the raw name', async () => {
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
      body: { name: 'local-tool', type: 'stdio', command: 'node', args: 'foo bar', env: { TOKEN: 'p', EMPTY: '' }, scope: 'project' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, name: 'local-tool', nameChanged: false })
    expect(H.setSecret).toHaveBeenCalledWith('local-tool-token', 'TOKEN (local-tool)', 'p')
    expect(H.execSync).toHaveBeenCalledWith(expect.stringContaining('claude mcp add'), expect.any(Object))
  })

  it('installs a stdio MCP server with no env secrets', async () => {
    const { res } = await call('POST', '/api/connectors', {
      body: { name: 'no-env-stdio', type: 'stdio', command: 'node' },
    })
    expect(res.statusCode).toBe(200)
    expect(H.setSecret).not.toHaveBeenCalled()
  })

  it('400s when neither URL nor command is supplied', async () => {
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'useless', type: 'stdio' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'URL (http/sse) or command (stdio) required' })
  })

  it('returns 500 + error message when execSync throws', async () => {
    H.execSync.mockImplementation(() => { throw Object.assign(new Error('spawn failed'), { message: 'spawn failed' }) })
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'boom', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'spawn failed' })
  })

  it('falls back to default error when thrown error has no message', async () => {
    const err: any = new Error()
    err.message = ''
    H.execSync.mockImplementation(() => { throw err })
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'silent', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(500)
    expect((json() as Record<string, string>).error).toBe('Failed to add connector')
  })

  it('logs but still returns ok when upsertLocalCatalogEntry fails', async () => {
    H.atomicWriteFileSync.mockImplementation(() => { throw new Error('disk full') })
    const { res, json } = await call('POST', '/api/connectors', {
      body: { name: 'gmail', type: 'http', url: 'https://x' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'gmail', nameChanged: false })
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to persist MCP into mcp-catalog.local.json')
  })

  it('merges into an existing mcp-catalog.local.json entry by id', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.local.json'),
      JSON.stringify([{ id: 'gmail', name: 'Old Name', type: 'remote', url: 'https://old.test' }]),
    )
    const { res } = await call('POST', '/api/connectors', {
      body: { name: 'gmail', type: 'http', url: 'https://new.test' },
    })
    expect(res.statusCode).toBe(200)
    const lastCall = H.atomicWriteFileSync.mock.calls[H.atomicWriteFileSync.mock.calls.length - 1]
    const persisted = JSON.parse(lastCall[1])
    expect(persisted.find((e: any) => e.id === 'gmail').url).toBe('https://new.test')
  })

  it('exercises the user-scope branch (data.scope !== "project") in stdio vault+bind', async () => {
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res } = await call('POST', '/api/connectors', {
      body: { name: 'user-scope-tool', type: 'stdio', command: 'node', env: { TOKEN: 'plaintext' }, scope: 'user' },
    })
    expect(res.statusCode).toBe(200)
    expect(H.setSecret).toHaveBeenCalledWith('user-scope-tool-token', 'TOKEN (user-scope-tool)', 'plaintext')
  })
})

// ============================================================================
// DELETE /api/connectors/:name
// ============================================================================

describe('DELETE /api/connectors/:name', () => {
  it('removes the connector from every detected MCP file', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const agentProjDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(agentProjDir, { recursive: true })
    const realProj = join(agentProjDir, 'blog')
    mkdirSync(realProj, { recursive: true })

    const extDir = mkdtempSync(join(tmpdir(), 'rc-del-'))
    H.getExternalProjectPaths.mockReturnValue([extDir])

    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) return JSON.stringify({ mcpServers: { victim: { command: 'x' } } })
      if (p === join(H.AGENTS_BASE_DIR, 'archivist', '.mcp.json')) return JSON.stringify({ mcpServers: { victim: { command: 'y' } } })
      if (p === join(realProj, '.mcp.json')) return JSON.stringify({ mcpServers: { victim: { command: 'z' } } })
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res, json } = await call('DELETE', '/api/connectors/victim')
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

  it('handles agent with no projects/ dir', async () => {
    H.listAgentNames.mockReturnValue(['loner'])
    mkdirSync(join(H.AGENTS_BASE_DIR, 'loner'), { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { loneSrv: { command: 'x' } } })
      }
      return fallback
    })
    const { res } = await call('DELETE', '/api/connectors/loneSrv')
    expect(res.statusCode).toBe(200)
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('returns 404 when neither file nor cache holds the connector', async () => {
    const { res, json } = await call('DELETE', '/api/connectors/ghost')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found in any config' })
  })

  it('returns the cache-purge branch when no file contained the name', async () => {
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
  it('returns the plugin: short-circuit note', async () => {
    const { res, json } = await call('POST', '/api/connectors/plugin:slack/assign', { body: { agents: [] } })
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
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('reads the connector config from external project paths', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'rc-assign-'))
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

  it('404s when the connector config does not exist anywhere', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const { res, json } = await call('POST', '/api/connectors/ghost/assign', { body: { agents: ['archivist'] } })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Connector not found' })
  })

  it('writes the connector config to every target agent mcp.json', async () => {
    H.listAgentNames.mockReturnValue(['archivist', 'backend'])
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
    expect(H.atomicWriteFileSync).toHaveBeenCalledTimes(1)
  })

  it('tolerates a non-array agents[] and an unreadable target mcp.json', async () => {
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
      return fallback
    })
    H.atomicWriteFileSync.mockReset()
    const { res } = await call('POST', '/api/connectors/cfgSrv/assign', { body: { agents: ['newone'] } })
    expect(res.statusCode).toBe(200)
    const payload = JSON.parse(H.atomicWriteFileSync.mock.calls[0][1])
    expect(payload.mcpServers.cfgSrv).toMatchObject({ command: 'a' })
  })

  it('merges into an existing mcpServers block', async () => {
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
    expect(payload.mcpServers).toMatchObject({ addSrv: { command: 'a' }, otherSrv: { command: 'b' } })
  })

  it('returns false for non-POST method on /assign', async () => {
    const { handled } = await call('GET', '/api/connectors/srv/assign')
    expect(handled).toBe(false)
  })
})

// ============================================================================
// GET /api/mcp-catalog
// ============================================================================

describe('GET /api/mcp-catalog', () => {
  it('marks entries from getMcpListCache as installed (normalizedId match)', async () => {
    H.getMcpListCache.mockReturnValue({
      entries: [{ name: 'n', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'claude.ai' }],
      lastRefreshed: 0, refreshing: false, error: undefined,
    })
    const { res, json } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, any>>
    const gmail = arr.find(e => e.id === 'gmail')
    expect(gmail).toMatchObject({ installed: true, installedSource: 'claude.ai', configMatch: false })
  })

  it('falls back to nameSlug when normalizedId does not match', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'slugid', name: 'Gmail', type: 'remote', url: 'https://x', env: {} }]),
    )
    H.getMcpListCache.mockReturnValue({
      entries: [{ name: 'gmail', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'local' }],
      lastRefreshed: 0, refreshing: false, error: undefined,
    })
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    const entry = arr.find(e => e.id === 'slugid')
    expect(entry).toMatchObject({ installed: true, installedSource: 'local' })
  })

  it('triggers configMatch when catalogMatchesConfigured returns true', async () => {
    H.catalogMatchesConfigured.mockReturnValue(true)
    H.getMcpListCache.mockReturnValue({ entries: [], lastRefreshed: 0, refreshing: false, error: undefined })
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    const gmail = arr.find(e => e.id === 'gmail')
    expect(gmail).toMatchObject({ installed: true, installedSource: 'local', configMatch: true })
  })

  it('returns 500 when loadMcpCatalog throws', async () => {
    rmSync(join(H.projectRoot, 'mcp-catalog.json'))
    const { res, json } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to load catalog' })
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to load MCP catalog')
  })

  it('iterates the .mcp.json file in collectConfiguredServerSlugs', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { 'gmail-personal': { command: 'x' } } })
      }
      return fallback
    })
    H.catalogMatchesConfigured.mockImplementation((...args: unknown[]) => {
      const [idSlug, nameSlug, slugs] = args as [unknown, unknown, string[]]
      void idSlug; void nameSlug
      for (const s of slugs) if (s === 'gmail-personal') return true
      return false
    })
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ installed: true, configMatch: true })
  })

  it('iterates external project paths in collectConfiguredServerSlugs', async () => {
    const extDir = mkdtempSync(join(tmpdir(), 'rc-catalog-'))
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

  it('warns when mcp-catalog.local.json is not a JSON array', async () => {
    writeFileSync(join(H.projectRoot, 'mcp-catalog.local.json'), '{"oops":"not-an-array"}')
    const { res } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(200)
    expect(H.loggerWarn).toHaveBeenCalledWith(expect.anything(), 'mcp-catalog.local.json is not a JSON array, ignoring')
  })

  it('errors when mcp-catalog.local.json fails to parse', async () => {
    writeFileSync(join(H.projectRoot, 'mcp-catalog.local.json'), 'NOT JSON{')
    const { res } = await call('GET', '/api/mcp-catalog')
    expect(res.statusCode).toBe(200)
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to parse mcp-catalog.local.json, ignoring')
  })

  it('uses local catalog to override committed entries by id', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.local.json'),
      JSON.stringify([{ id: 'gmail', name: 'Gmail (local)', type: 'remote', url: 'https://local.test/mcp' }]),
    )
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ name: 'Gmail (local)' })
  })

  it('iterates per-agent .mcp.json paths in collectConfiguredServerSlugs', async () => {
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

  it('skips empty slugs in collectConfiguredServerSlugs (slugify returned "")', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { '!!!': { command: 'x' } } })
      }
      return fallback
    })
    const { json } = await call('GET', '/api/mcp-catalog')
    expect(Array.isArray(json())).toBe(true)
  })

  it('marks an item as installed via its cached source (first-wins branch)', async () => {
    H.getMcpListCache.mockReturnValue({
      entries: [
        { name: 'a', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'claude.ai' },
        { name: 'b', normalizedId: 'gmail', endpoint: '', status: 'connected', source: 'local' },
      ],
      lastRefreshed: 0, refreshing: false, error: undefined,
    })
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr.find(e => e.id === 'gmail')).toMatchObject({ installed: true, installedSource: 'claude.ai' })
  })

  it('handles catalog entries with no id field', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ name: 'tool', type: 'remote', url: 'https://x' }]),
    )
    const { json } = await call('GET', '/api/mcp-catalog')
    const arr = json() as Array<Record<string, any>>
    expect(arr[0]).toBeDefined()
  })
})

// ============================================================================
// POST /api/mcp-catalog/:id/install
// ============================================================================

describe('POST /api/mcp-catalog/:id/install', () => {
  it('installs a local catalog item with default non-secret env as -e flags', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([
        { id: 'gmail', name: 'Gmail', type: 'local', command: 'node', args: ['x', 'y'], env: { DEFAULT_TOKEN: 'val', SECRET: '' } },
      ]),
    )
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res } = await call('POST', '/api/mcp-catalog/gmail/install', {
      body: { env: { SECRET: 'plaintext' } },
    })
    expect(res.statusCode).toBe(200)
    expect(H.execSync.mock.calls[0][0]).toMatch(/-e 'DEFAULT_TOKEN'='val'/)
    expect(H.setSecret).toHaveBeenCalledWith('gmail-secret', 'SECRET (gmail)', 'plaintext')
  })

  it('drops a default env key when the user supplied a secret for that key', async () => {
    // Catalog item defaultEnv contains TOKEN='catalogval' but the user submitted
    // TOKEN='plaintext' -- the catalog default must be filtered out so -e
    // tokens don't carry a stale value while the secret is in the Vault.
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([
        { id: 'gmail', name: 'Gmail', type: 'local', command: 'node', args: [], env: { TOKEN: 'catalogval' } },
      ]),
    )
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res } = await call('POST', '/api/mcp-catalog/gmail/install', {
      body: { env: { TOKEN: 'plaintext' } },
    })
    expect(res.statusCode).toBe(200)
    expect(H.execSync.mock.calls[0][0]).not.toMatch(/TOKEN/)
    expect(H.setSecret).toHaveBeenCalledWith('gmail-token', 'TOKEN (gmail)', 'plaintext')
  })

  it('installs a local catalog item when no env overrides are submitted', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'plain', name: 'Plain', type: 'local', command: 'node', args: [], env: {} }]),
    )
    const { res } = await call('POST', '/api/mcp-catalog/plain/install', { body: {} })
    expect(res.statusCode).toBe(200)
  })

  it('installs a local catalog item whose env field is undefined (item.env || {} branch)', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'noenv', name: 'NoEnv', type: 'local', command: 'node', args: [] }]),
    )
    H.syncSecret.mockReturnValue({ updated: 1, errors: [] })
    const { res } = await call('POST', '/api/mcp-catalog/noenv/install', { body: { env: { TOKEN: 'plaintext' } } })
    expect(res.statusCode).toBe(200)
    expect(H.setSecret).toHaveBeenCalledWith('noenv-token', 'TOKEN (noenv)', 'plaintext')
  })

  it('appends the oauth authNote to the install message', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'oauth-tool', name: 'OT', type: 'local', command: 'node', env: {}, authType: 'oauth', authNote: 'auth then' }]),
    )
    const { res, json } = await call('POST', '/api/mcp-catalog/oauth-tool/install', { body: {} })
    expect(res.statusCode).toBe(200)
    expect((json() as Record<string, string>).message).toMatch(/auth then/)
  })

  it('installs a remote catalog item with transport=http when set', async () => {
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

  it('400s when remote item has no URL', async () => {
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

  it('tolerates an unparseable body as empty env', async () => {
    writeFileSync(
      join(H.projectRoot, 'mcp-catalog.json'),
      JSON.stringify([{ id: 'plain', name: 'Plain', type: 'local', command: 'node', args: [], env: {} }]),
    )
    const { res } = await call('POST', '/api/mcp-catalog/plain/install', { raw: 'not-json' })
    expect(res.statusCode).toBe(200)
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

  it('falls back to "Failed to install" when error has no message', async () => {
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

  it('falls through to project-scope execSync when user-scope throws', async () => {
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

  it('returns 500 when JSON.parse itself throws (catalog unreadable)', async () => {
    rmSync(join(H.projectRoot, 'mcp-catalog.json'))
    const { res, json } = await call('DELETE', '/api/mcp-catalog/gmail/uninstall')
    expect(res.statusCode).toBe(500)
    expect(H.loggerError).toHaveBeenCalledWith(expect.anything(), 'Failed to uninstall MCP from catalog')
    expect((json() as Record<string, string>).error).toBeTruthy()
  })

  it('falls back to "Failed to uninstall" when error has no message', async () => {
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
// /api/vault
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
    expect(body.secrets.map(s => s.id)).toEqual(['regular'])
  })

  it('POST 400s when id or value is missing', async () => {
    const { res, json } = await call('POST', '/api/vault', { body: { id: '   ', value: 'v' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'id and value required' })
  })

  it('POST sets the secret and reports sync (label defaults to id)', async () => {
    H.syncSecret.mockReturnValue({ updated: 2, errors: [] })
    const { res, json } = await call('POST', '/api/vault', { body: { id: 'tok', label: '', value: 'v' } })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, synced: 2 })
    expect(H.setSecret).toHaveBeenCalledWith('tok', 'tok', 'v')
  })

  it('GET /api/vault/:id 404s when missing', async () => {
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

  it('GET skips subroutes sync/import/ssh-servers/ssh-keys', async () => {
    for (const sub of ['sync', 'import', 'ssh-servers', 'ssh-keys']) {
      const { handled } = await call('GET', `/api/vault/${sub}`)
      expect(handled).toBe(false)
    }
  })

  it('GET /api/vault/scan returns findings', async () => {
    H.scanMcpConfigs.mockReturnValue([{ a: 1 }])
    const { res, json } = await call('GET', '/api/vault/scan')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ findings: [{ a: 1 }] })
  })

  it('GET /api/vault/bindings is handled here', async () => {
    H.getBindings.mockReturnValue([])
    const { res } = await call('GET', '/api/vault/bindings')
    expect(res.statusCode).toBe(200)
  })

  it('DELETE /api/vault/:id 404s when missing', async () => {
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

  it('DELETE skips subroutes sync/scan/import/ssh-servers/ssh-keys/bindings', async () => {
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
  it('hits the existsSync false branch when an agent has no projects/ dir', async () => {
    H.listAgentNames.mockReturnValue(['noproj'])
    mkdirSync(join(H.AGENTS_BASE_DIR, 'noproj'), { recursive: true })
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { srv: { command: 'x' } } })
      }
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', envVar: 'TOKEN', serverName: 'srv' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, synced: 1 })
  })

  it('GET lists bindings', async () => {
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

  it('POST 400s when no targets are supplied and search finds nothing', async () => {
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'a', envVar: 'X', serverName: 'ghost' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No targets found for this server' })
  })

  it('POST creates an env binding when serverName resolves to an existing config', async () => {
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
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p === join(H.PROJECT_ROOT, '.mcp.json')) {
        return JSON.stringify({ mcpServers: { h: { url: 'https://h' } } })
      }
      return fallback
    })
    const { res, json } = await call('POST', '/api/vault/bindings', {
      body: { vaultSecretId: 'sec', serverName: 'h', headerName: 'Authorization', headerScheme: 'Bearer' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, synced: 1, errors: [] })
    const bindingArg = H.addBinding.mock.calls[0][0] as Record<string, unknown>
    expect(bindingArg.headerName).toBe('Authorization')
    expect(bindingArg.headerScheme).toBe('Bearer')
  })

  it('POST header binding defaults scheme to Bearer when omitted', async () => {
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

  it('POST walks agent + agent-project search paths before declaring no targets', async () => {
    H.listAgentNames.mockReturnValue(['archivist'])
    const projectsDir = join(H.AGENTS_BASE_DIR, 'archivist', 'projects')
    mkdirSync(projectsDir, { recursive: true })
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

  it('POST reports a sync error when syncSecret surfaces one', async () => {
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
    const extDir = mkdtempSync(join(tmpdir(), 'rc-bind-'))
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
  it('returns findings', async () => {
    H.scanMcpConfigs.mockReturnValue([{ a: 1 }])
    const { json } = await call('GET', '/api/vault/scan')
    expect(json()).toEqual({ findings: [{ a: 1 }] })
  })
})

describe('POST /api/vault/import', () => {
  it('skips requests where the env value cannot be located', async () => {
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

  it('sets a vault entry when the env value is reachable (no binding)', async () => {
    const file = join(H.projectRoot, 'rc-imp', '.mcp.json')
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

  it('creates + syncs the binding when createBinding=true', async () => {
    const file = join(H.projectRoot, 'rc-bnd', '.mcp.json')
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

  it('moves on after the first target that yields a value', async () => {
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

  it('ignores non-string env values', async () => {
    const file = join(H.projectRoot, 'rc-weird', '.mcp.json')
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
  it('formats models on a successful fetch (filters out embed-* names)', async () => {
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
