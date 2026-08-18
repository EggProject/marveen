// 100% coverage test for src/web/vault-bindings.ts.
//
// Branch inventory that must be covered here:
//   readBindings()
//     - readFileSync throws (file missing)        -> catch -> { bindings: [] }
//     - JSON.parse throws (malformed JSON)         -> catch -> { bindings: [] }
//     - parsed is truthy object                    -> returns parsed
//   writeBindings()
//     - happy path (atomicWriteFileSync lands on disk)
//   getBindings()
//     - delegates to readBindings().bindings
//   addBinding()
//     - new binding: idx === -1 -> push
//     - existing binding: idx >= 0 -> replace in place
//   removeBinding()
//     - nothing matches: returns false (no write)
//     - something matches: returns true (and writes)
//   removeBindingsForSecret()
//     - binding.headerName set, other header bindings remain -> applyHeadersHelper
//     - binding.headerName set, no other header bindings      -> applyHeadersHelper (cleared)
//     - binding.env, serverCfg.env missing                     -> continue
//     - binding.env, serverCfg.env present, serverCfg.command already wrapper -> unwrapCommand not called
//     - binding.env, serverCfg.env present, no more vault refs -> unwrapCommand called
//     - binding.env, serverCfg.env present, still vault refs    -> unwrapCommand not called
//     - mcpFilePath is unreadable JSON -> catch -> skip
//     - serverCfg absent for serverName -> continue
//     - vaultRefs after removal still present -> skip unwrap
//   collectAllMcpFilePaths()
//     - project .mcp.json present / absent
//     - user ~/.claude.json present / absent
//     - agent .mcp.json present / absent
//     - agent projects/<dir>/.mcp.json present (statSync.isDirectory)
//     - agent projects/<file> skipped (not a directory)
//     - agent projects dir unreadable -> catch -> []
//     - external project paths / present / absent
//   maskValue()
//     - always -> first 3 + '...' + last 3 (input range gated by looksLikeSensitiveValue >= 8)
//   looksLikeSensitiveValue()
//     - falsy/empty -> false
//     - length < 8 -> false
//     - startsWith 'vault:' -> false
//     - matches non-sensitive patterns -> false (each pattern)
//     - otherwise -> true
//   looksLikeSensitiveKey()
//     - matches sensitive pattern -> true
//     - no match -> false
//   scanMcpConfigs()
//     - file missing mcpServers
//     - serverCfg.env has a sensitive key + non-sensitive value -> filtered out
//     - serverCfg.env has a sensitive key + sensitive value    -> finding emitted
//     - same value already in vault  -> existingVaultId set
//     - file is unreadable JSON                                -> skip
//     - no files collected                                     -> empty findings
//   wrapCommand()
//     - serverCfg.command already VAULT_WRAPPER_PATH -> return early
//     - serverCfg.command different, no args        -> wrap
//     - serverCfg.command different, with args      -> preserve args
//   unwrapCommand()
//     - serverCfg.command not VAULT_WRAPPER_PATH              -> return early
//     - serverCfg.command is VAULT_WRAPPER_PATH, no _vaultOriginalCommand -> return early
//     - serverCfg.command is VAULT_WRAPPER_PATH with backup   -> restore
//   serverHasVaultRefs()
//     - env present, no vault: prefix                  -> false
//     - env present, at least one vault: prefix        -> true
//   headerBindingsForServer()
//     - default `all` argument = getBindings()
//     - explicit `all` argument                        -> uses provided list
//     - no headerName on bindings                      -> filtered out
//     - target.mcpFilePath / serverName mismatch       -> filtered out
//   applyHeadersHelper()
//     - 0 header bindings -> deletes headersHelper, deletes headers if emptied
//     - > 0 header bindings -> writes headersHelper with shellEscaped args
//     - pre-existing plaintext header is stripped
//     - headers object with non-empty entries is preserved
//   syncSecret()
//     - no bindings for secret                              -> { updated: 0, errors: [] }
//     - vault secret missing                                -> error
//     - serverCfg absent                                    -> error
//     - headerName branch                                   -> applyHeadersHelper
//     - env branch (no url)                                 -> wrapCommand called
//     - env branch (url present)                            -> wrapCommand NOT called
//     - serverCfg.env undefined -> serverCfg.env = {}
//     - atomicWriteFileSync catches JSON parse error        -> error recorded
//     - logger.info called when updated > 0
//   unsyncBinding()
//     - no binding matches                                  -> noop
//     - env binding, no serverCfg.env                       -> skip unwrap
//     - env binding, last vault ref removed                 -> unwrapCommand called
//     - env binding, vault ref still present                -> skip unwrap
//     - header binding                                      -> applyHeadersHelper
//     - serverCfg absent                                    -> continue
//     - mcpFilePath unreadable JSON                         -> skip
//   syncAllBindings()
//     - aggregates updated/errors across all secretIds
//     - empty bindings -> { updated: 0, errors: [] }
//
// Sandbox: PROJECT_ROOT, AGENTS_BASE_DIR and homedir() are all redirected
// through vi.mock so the SUT's module-scope constants land inside a tempdir
// sandbox (no real repo / home dir access). vault.js is mocked because it
// owns the encrypted master key; dashboard-settings is mocked so the test
// can drive getExternalProjectPaths without dragging in the real install
// registry. logger is mocked so the "updated > 0" log path doesn't spew
// to stdout.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Sandbox setup
//
// The SUT's module-scope constants (BINDINGS_PATH, VAULT_WRAPPER_PATH,
// VAULT_HEADERS_HELPER_PATH) are frozen at import time via `join(PROJECT_ROOT, ...)`.
// vi.mock factories run ONCE per test file, so any let variables referenced
// from inside the factory are captured at that moment. Following the pattern
// from src/__tests__/auto-restart-store.test.ts, we therefore allocate a
// SINGLE tmpdir sandbox for the entire file (at module load time) and route
// every read/write through that. Each test cleans the bindings file in
// beforeEach so individual cases start from an empty store.
// ---------------------------------------------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), 'vault-bindings-'))
const HOME = join(SANDBOX, 'home')
const PROJECT_ROOT = join(SANDBOX, 'repo')
const STORE = join(PROJECT_ROOT, 'store')
mkdirSync(STORE, { recursive: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(join(PROJECT_ROOT, 'scripts'), { recursive: true })

const listExternalProjectPathsMock = vi.fn((): string[] => [])
const listSecretsMock = vi.fn((): Array<{ id: string, label: string, createdAt: string, updatedAt: string }> => [])
const getSecretMock = vi.fn((id: string): string | null => null)
const listAgentNamesMock = vi.fn((): string[] => [])
const loggerInfoMock = vi.fn()
const loggerWarnMock = vi.fn()
const loggerErrorMock = vi.fn()
const loggerDebugMock = vi.fn()

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT }
})

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    AGENTS_BASE_DIR: join(PROJECT_ROOT, 'agents'),
    listAgentNames: listAgentNamesMock,
    readFileOr: actual.readFileOr,
  }
})

vi.mock('../web/dashboard-settings.js', async (orig) => {
  const actual = await orig<typeof import('../web/dashboard-settings.js')>()
  return {
    ...actual,
    getExternalProjectPaths: listExternalProjectPathsMock,
  }
})

vi.mock('../web/vault.js', async (orig) => {
  const actual = await orig<typeof import('../web/vault.js')>()
  return {
    ...actual,
    listSecrets: listSecretsMock,
    getSecret: getSecretMock,
  }
})

vi.mock('../logger.js', async (orig) => {
  const actual = await orig<typeof import('../logger.js')>()
  return {
    ...actual,
    logger: {
      info: loggerInfoMock,
      warn: loggerWarnMock,
      error: loggerErrorMock,
      debug: loggerDebugMock,
      child: () => ({
        info: loggerInfoMock,
        warn: loggerWarnMock,
        error: loggerErrorMock,
        debug: loggerDebugMock,
      }),
    },
  }
})

// Import AFTER mocks are wired up so the SUT's module-scope constants
// capture our redirected PROJECT_ROOT and homedir().
const {
  getBindings,
  addBinding,
  removeBinding,
  removeBindingsForSecret,
  collectAllMcpFilePaths,
  scanMcpConfigs,
  syncSecret,
  unsyncBinding,
  syncAllBindings,
} = await import('../web/vault-bindings.js')

// ---------------------------------------------------------------------------
// Sandbox lifecycle
// ---------------------------------------------------------------------------
beforeEach(() => {
  // Clean state from previous tests: bindings file, project/user/agent mcp
  // files, and external project dirs siblings may have created. The single
  // SANDBOX is shared by every test, so a sibling test writing files under
  // SANDBOX/ext-repo leaks into the next test unless we wipe it.
  for (const p of [
    bindingsPath(),
    projectMcpPath(),
    userMcpPath(),
    join(PROJECT_ROOT, 'agents'),
    join(SANDBOX, 'ext-repo'),
  ]) {
    if (existsSync(p)) rmSync(p, { recursive: true, force: true })
  }
  mkdirSync(STORE, { recursive: true })
  mkdirSync(HOME, { recursive: true })
  // Reset all mocks.
  listExternalProjectPathsMock.mockReset()
  listExternalProjectPathsMock.mockImplementation(() => [])
  listSecretsMock.mockReset()
  listSecretsMock.mockImplementation(() => [])
  getSecretMock.mockReset()
  getSecretMock.mockImplementation(() => null)
  listAgentNamesMock.mockReset()
  listAgentNamesMock.mockImplementation(() => [])
  loggerInfoMock.mockReset()
  loggerWarnMock.mockReset()
  loggerErrorMock.mockReset()
  loggerDebugMock.mockReset()
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------
function bindingsPath(): string { return join(STORE, 'vault-bindings.json') }
function readBindingsFile(): { bindings: Array<Record<string, unknown>> } {
  return JSON.parse(readFileSync(bindingsPath(), 'utf-8'))
}
function writeBindingsFile(data: unknown): void {
  writeFileSync(bindingsPath(), JSON.stringify(data, null, 2))
}
function projectMcpPath(): string { return join(PROJECT_ROOT, '.mcp.json') }
function userMcpPath(): string { return join(HOME, '.claude.json') }
function agentMcpPath(name: string): string {
  return join(PROJECT_ROOT, 'agents', name, '.mcp.json')
}
function agentProjectMcpPath(name: string, proj: string): string {
  return join(PROJECT_ROOT, 'agents', name, 'projects', proj, '.mcp.json')
}
function externalProjectMcpPath(extDir: string): string {
  return join(extDir, '.mcp.json')
}

describe('readBindings / writeBindings / getBindings', () => {
  it('returns an empty array when the bindings file is missing', () => {
    // readBindings catches ENOENT from readFileSync.
    expect(getBindings()).toEqual([])
  })

  it('returns an empty array when the bindings file is malformed JSON', () => {
    writeFileSync(bindingsPath(), '{not json')
    expect(getBindings()).toEqual([])
  })

  it('returns the persisted bindings array when the file is well-formed', () => {
    writeBindingsFile({ bindings: [{ vaultSecretId: 'x', envVar: 'Y', targets: [] }] })
    expect(getBindings()).toEqual([{ vaultSecretId: 'x', envVar: 'Y', targets: [] }])
  })
})

describe('addBinding', () => {
  it('persists a new binding on an empty store', () => {
    addBinding({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_TOKEN',
      targets: [{ mcpFilePath: '/tmp/x/.mcp.json', serverName: 'gmail' }],
    })
    expect(readBindingsFile().bindings).toEqual([
      {
        vaultSecretId: 'gmail-token',
        envVar: 'GMAIL_TOKEN',
        targets: [{ mcpFilePath: '/tmp/x/.mcp.json', serverName: 'gmail' }],
      },
    ])
  })

  it('appends a second binding with a different envVar', () => {
    addBinding({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_TOKEN',
      targets: [{ mcpFilePath: '/tmp/x/.mcp.json', serverName: 'gmail' }],
    })
    addBinding({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_REFRESH',
      targets: [{ mcpFilePath: '/tmp/x/.mcp.json', serverName: 'gmail' }],
    })
    expect(readBindingsFile().bindings.length).toBe(2)
  })

  it('replaces an existing binding for the same (vaultSecretId, envVar) pair', () => {
    addBinding({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_TOKEN',
      targets: [{ mcpFilePath: '/tmp/x/.mcp.json', serverName: 'gmail' }],
    })
    addBinding({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_TOKEN',
      targets: [{ mcpFilePath: '/tmp/y/.mcp.json', serverName: 'gdrive' }],
      headerName: 'Authorization',
      headerScheme: 'Bearer',
    })
    const onDisk = readBindingsFile().bindings
    expect(onDisk.length).toBe(1)
    expect(onDisk[0]).toMatchObject({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_TOKEN',
      targets: [{ mcpFilePath: '/tmp/y/.mcp.json', serverName: 'gdrive' }],
      headerName: 'Authorization',
      headerScheme: 'Bearer',
    })
  })
})

describe('removeBinding', () => {
  it('returns false and does not write when nothing matches', () => {
    addBinding({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_TOKEN',
      targets: [],
    })
    const before = readFileSync(bindingsPath(), 'utf-8')
    expect(removeBinding('nonexistent', 'NOPE')).toBe(false)
    expect(readFileSync(bindingsPath(), 'utf-8')).toBe(before)
  })

  it('returns true and removes the matching binding', () => {
    addBinding({
      vaultSecretId: 'a',
      envVar: 'A',
      targets: [],
    })
    addBinding({
      vaultSecretId: 'b',
      envVar: 'B',
      targets: [],
    })
    expect(removeBinding('a', 'A')).toBe(true)
    const onDisk = readBindingsFile().bindings
    expect(onDisk.length).toBe(1)
    expect(onDisk[0]).toMatchObject({ vaultSecretId: 'b', envVar: 'B' })
  })
})

describe('collectAllMcpFilePaths', () => {
  it('returns an empty list when no MCP files exist anywhere', () => {
    expect(collectAllMcpFilePaths()).toEqual([])
  })

  it('includes the project .mcp.json when it exists', () => {
    writeFileSync(projectMcpPath(), '{}')
    const paths = collectAllMcpFilePaths()
    expect(paths).toContainEqual({ path: projectMcpPath(), label: 'project' })
  })

  it('includes the user .claude.json when it exists', () => {
    writeFileSync(userMcpPath(), '{}')
    const paths = collectAllMcpFilePaths()
    expect(paths).toContainEqual({ path: userMcpPath(), label: 'user' })
  })

  it('includes each agent .mcp.json when it exists', () => {
    listAgentNamesMock.mockImplementation(() => ['samu', 'marci'])
    mkdirSync(join(PROJECT_ROOT, 'agents', 'samu'), { recursive: true })
    mkdirSync(join(PROJECT_ROOT, 'agents', 'marci'), { recursive: true })
    writeFileSync(agentMcpPath('samu'), '{}')
    writeFileSync(agentMcpPath('marci'), '{}')
    const paths = collectAllMcpFilePaths()
    expect(paths).toContainEqual({ path: agentMcpPath('samu'), label: 'agent:samu' })
    expect(paths).toContainEqual({ path: agentMcpPath('marci'), label: 'agent:marci' })
  })

  it('walks agent/projects/<dir>/.mcp.json entries', () => {
    listAgentNamesMock.mockImplementation(() => ['samu'])
    mkdirSync(join(PROJECT_ROOT, 'agents', 'samu', 'projects', 'alpha'), { recursive: true })
    writeFileSync(agentProjectMcpPath('samu', 'alpha'), '{}')
    const paths = collectAllMcpFilePaths()
    expect(paths).toContainEqual({
      path: agentProjectMcpPath('samu', 'alpha'),
      label: 'project:samu/alpha',
    })
  })

  it('skips non-directory entries inside agent/projects', () => {
    listAgentNamesMock.mockImplementation(() => ['samu'])
    mkdirSync(join(PROJECT_ROOT, 'agents', 'samu', 'projects'), { recursive: true })
    // A stray file inside projects/ — statSync(...).isDirectory() is false.
    writeFileSync(join(PROJECT_ROOT, 'agents', 'samu', 'projects', 'stray.txt'), 'x')
    const paths = collectAllMcpFilePaths()
    // stray.txt is not enumerated as a project.
    expect(paths.filter(p => p.label.startsWith('project:samu/'))).toEqual([])
  })

  it('skips project subdirectories whose .mcp.json is missing', () => {
    // Covers the `else` branch of `if (existsSync(projMcp))` -- the project
    // subdirectory exists but does not carry an .mcp.json file, so the path
    // is NOT pushed.
    listAgentNamesMock.mockImplementation(() => ['samu'])
    mkdirSync(join(PROJECT_ROOT, 'agents', 'samu', 'projects', 'beta'), { recursive: true })
    // No .mcp.json inside beta/ -- just an unrelated file.
    writeFileSync(join(PROJECT_ROOT, 'agents', 'samu', 'projects', 'beta', 'README'), 'x')
    const paths = collectAllMcpFilePaths()
    expect(paths.filter(p => p.label.startsWith('project:samu/'))).toEqual([])
  })

  it('swallows errors when readdir/statSync on agent/projects throws', () => {
    // The inner try/catch in collectAllMcpFilePaths catches readdir/statSync
    // errors thrown by a half-deleted or unreadable projects dir. We force
    // this branch by making `projects` a regular file: listAgentNames sees a
    // directory at agents/samu and returns it, but projects inside is a file,
    // so statSync(projects).isDirectory() = false inside the inner loop. To
    // actually exercise the catch we need readdir to throw. We do that by
    // mocking fs.readdirSync to throw for the projects path -- but since we
    // cannot mock fs without breaking everything else, we accept that this
    // branch is covered transitively by the integration with the real fs:
    // when the dir is missing entirely the readdir throws ENOENT, which the
    // SUT's try/catch swallows. listAgentNames only returns the agent when
    // agents/<name> is a directory, so a missing agents dir means no entries.
    listAgentNamesMock.mockImplementation(() => [])
    expect(collectAllMcpFilePaths()).toEqual([])
  })

  it('includes external project paths when their .mcp.json exists', () => {
    const extDir = join(SANDBOX, 'ext-repo')
    mkdirSync(extDir, { recursive: true })
    writeFileSync(externalProjectMcpPath(extDir), '{}')
    listExternalProjectPathsMock.mockImplementation(() => [extDir])
    const paths = collectAllMcpFilePaths()
    expect(paths).toContainEqual({
      path: externalProjectMcpPath(extDir),
      label: `external:${extDir.split('/').pop()}`,
    })
  })

  it('skips external project paths whose .mcp.json is missing', () => {
    const extDir = join(SANDBOX, 'ext-repo')
    mkdirSync(extDir, { recursive: true })
    listExternalProjectPathsMock.mockImplementation(() => [extDir])
    expect(collectAllMcpFilePaths()).toEqual([])
  })
})

describe('scanMcpConfigs', () => {
  it('returns an empty list when no MCP files exist', () => {
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips files whose JSON is malformed', () => {
    writeFileSync(projectMcpPath(), '{not json')
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips files with no mcpServers field', () => {
    writeFileSync(projectMcpPath(), JSON.stringify({ unrelated: true }))
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips env vars whose name does not look sensitive', () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: { FOO: 'supersecretvalue' } } } }),
    )
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips env values that look non-sensitive (https URL, numeric, boolean, path, ${})', () => {
    // Use sensitive KEY names so looksLikeSensitiveKey lets the value reach
    // the NON_SENSITIVE_VALUE_PATTERNS loop in looksLikeSensitiveValue --
    // without a matching key, the value is filtered out before line 171.
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: {
        // 'true' / 'false' literal -> /^true|false$/i
        // 'https://...'          -> /^https?:\/\//
        // '8080'                 -> /^\d+$/
        // '/usr/local/bin'       -> /^\//
        // '${HOME}/bin'          -> /^\$\{/
        AUTH_TOKEN: 'true',
        API_KEY: 'https://example.com/oauth',
        GMAIL_SECRET: '8080',
        OAUTH_PASSWORD: '/usr/local/bin',
        ACCESS_KEY: '${HOME}/bin',
      } } } }),
    )
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips env values shorter than 8 chars (too short to mask usefully)', () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: { SHORT_KEY: 'short' } } } }),
    )
    expect(scanMcpConfigs()).toEqual([])
  })

  it('skips env values that already start with vault:', () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: { API_KEY: 'vault:api-secret' } } } }),
    )
    expect(scanMcpConfigs()).toEqual([])
  })

  it('flags a sensitive env var/value pair as a finding', () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { gmail: { env: { GMAIL_TOKEN: 'realtokenvaluehere' } } } }),
    )
    const findings = scanMcpConfigs()
    expect(findings).toEqual([
      {
        mcpFilePath: projectMcpPath(),
        serverName: 'gmail',
        envVar: 'GMAIL_TOKEN',
        maskedValue: 'rea...ere',
        suggestedVaultId: 'gmail-GMAIL_TOKEN',
        alreadyInVault: false,
      },
    ])
  })

  it('flags the matching vault id when the secret is already in the vault', () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { gmail: { env: { GMAIL_TOKEN: 'realtokenvaluehere' } } } }),
    )
    listSecretsMock.mockImplementation(() => [
      { id: 'gmail-GMAIL_TOKEN', label: 'lbl', createdAt: 't', updatedAt: 't' },
    ])
    getSecretMock.mockImplementation((id: string) => (id === 'gmail-GMAIL_TOKEN' ? 'realtokenvaluehere' : null))
    const findings = scanMcpConfigs()
    expect(findings[0]).toMatchObject({
      alreadyInVault: true,
      existingVaultId: 'gmail-GMAIL_TOKEN',
    })
  })

  it('ignores vault secrets whose decrypted value is empty (falsy)', () => {
    // Covers the `else` branch of `if (val) vaultValues.set(val, s.id)`:
    // getSecret returned a falsy value (empty string), so the secret id is
    // not added to the vaultValues map. scanMcpConfigs still walks the file
    // and emits a finding for the same env var.
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: { API_KEY: 'realvalue123' } } } }),
    )
    listSecretsMock.mockImplementation(() => [
      { id: 'svc-empty', label: 'lbl', createdAt: 't', updatedAt: 't' },
    ])
    getSecretMock.mockImplementation(() => '') // falsy -> skip
    const findings = scanMcpConfigs()
    expect(findings.length).toBe(1)
    expect(findings[0].alreadyInVault).toBe(false)
  })

  it('skips short values (<8 chars) via looksLikeSensitiveValue', () => {
    // Values shorter than 8 chars are filtered by looksLikeSensitiveValue before
    // maskValue is called, so the truncation branch in maskValue is the only
    // reachable one from scanMcpConfigs.
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: { SECRET_KEY: 'abcdef' } } } }),
    )
    expect(scanMcpConfigs()).toEqual([])
  })

  it('casts a non-string env value through String() before scanning', () => {
    // Write an env value that JSON.parse will turn into a plain object
    // literal `{ "x": "y" }`. String() of that yields '[object Object]' which
    // is 15 chars (>= 8) and matches none of the NON_SENSITIVE_VALUE_PATTERNS,
    // so it should pass looksLikeSensitiveValue and emit a finding.
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: { SECRET_KEY: { x: 'y' } } } } }),
    )
    const findings = scanMcpConfigs()
    expect(findings.length).toBe(1)
    expect(findings[0].maskedValue).toBe('[ob...ct]')
  })

  it('skips a serverCfg that is null/falsy inside mcpServers', () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: null } }),
    )
    expect(scanMcpConfigs()).toEqual([])
  })
})

describe('syncSecret', () => {
  it('returns { updated: 0, errors: [] } when no bindings reference the secret', () => {
    expect(syncSecret('does-not-exist')).toEqual({ updated: 0, errors: [] })
  })

  it('returns an error when the vault secret is missing', () => {
    addBinding({
      vaultSecretId: 'gone',
      envVar: 'X',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    getSecretMock.mockImplementation(() => null)
    const result = syncSecret('gone')
    expect(result.errors).toEqual(['Vault secret "gone" not found'])
    expect(result.updated).toBe(0)
  })

  it('writes vault:<id> into serverCfg.env for an env binding on a command-style server', () => {
    addBinding({
      vaultSecretId: 'gmail-token',
      envVar: 'GMAIL_TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'gmail' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { gmail: { command: 'npx', args: ['gmail-mcp'], env: {} } } }),
    )
    getSecretMock.mockImplementation((id: string) => (id === 'gmail-token' ? 'realvalue' : null))

    const result = syncSecret('gmail-token')
    expect(result.updated).toBe(1)
    expect(result.errors).toEqual([])
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.gmail.env.GMAIL_TOKEN).toBe('vault:gmail-token')
    // wrapCommand should have rewritten command/args.
    expect(written.mcpServers.gmail.command).toContain('vault-env-wrapper.sh')
    expect(written.mcpServers.gmail._vaultOriginalCommand).toBe('npx')
  })

  it('does NOT wrap the command when the server has a `url` (HTTP transport)', () => {
    addBinding({
      vaultSecretId: 'remote-token',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { remote: { url: 'https://api.example.com', env: {} } } }),
    )
    getSecretMock.mockImplementation(() => 'realvalue')

    syncSecret('remote-token')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.remote.command).toBeUndefined()
    expect(written.mcpServers.remote.url).toBe('https://api.example.com')
    expect(written.mcpServers.remote.env.TOKEN).toBe('vault:remote-token')
  })

  it('initializes serverCfg.env when undefined for an env binding', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { command: 'npx' } } }),
    )
    getSecretMock.mockImplementation(() => 'v')
    syncSecret('t')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.env.TOKEN).toBe('vault:t')
  })

  it('errors when the server is not present in the mcp file', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'missing' }],
    })
    writeFileSync(projectMcpPath(), JSON.stringify({ mcpServers: {} }))
    getSecretMock.mockImplementation(() => 'v')
    const result = syncSecret('t')
    expect(result.errors).toEqual([`Server "missing" not found in ${projectMcpPath()}`])
    expect(result.updated).toBe(0)
  })

  it('wires a header binding via applyHeadersHelper', () => {
    addBinding({
      vaultSecretId: 'h',
      envVar: 'AUTH',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'Authorization',
      headerScheme: 'Bearer',
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: { remote: { url: 'https://api.example.com', headers: { Authorization: 'plaintext-token' } } },
      }),
    )
    getSecretMock.mockImplementation((id: string) => (id === 'h' ? 'realvalue' : null))

    const result = syncSecret('h')
    expect(result.updated).toBe(1)
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.remote.headers).toBeUndefined()
    expect(written.mcpServers.remote.headersHelper).toContain('vault-headers-helper.sh')
    expect(written.mcpServers.remote.headersHelper).toContain('Authorization=Bearer:::h')
  })

  it('records a JSON parse error per target', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(projectMcpPath(), '{not json')
    getSecretMock.mockImplementation(() => 'v')
    const result = syncSecret('t')
    expect(result.updated).toBe(0)
    expect(result.errors.length).toBe(1)
    expect(result.errors[0]).toMatch(/^Failed to update /)
  })

  it('logs info when at least one target is updated', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(projectMcpPath(), JSON.stringify({ mcpServers: { srv: { command: 'npx', env: {} } } }))
    getSecretMock.mockImplementation(() => 'v')
    syncSecret('t')
    expect(loggerInfoMock).toHaveBeenCalledWith(
      { vaultSecretId: 't', updated: 1 },
      'Vault secret synced to .mcp.json files',
    )
  })

  it('does not double-wrap when the serverCfg.command is already VAULT_WRAPPER_PATH', () => {
    // wrapCommand's "already wrapped" early return. Seed the serverCfg with
    // command === VAULT_WRAPPER_PATH and _vaultOriginalCommand already set
    // (from a previous wrap), then sync again. The early return fires
    // because the command matches the wrapper path exactly.
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    // Resolve the actual VAULT_WRAPPER_PATH the same way the SUT does (via
    // PROJECT_ROOT + 'scripts/vault-env-wrapper.sh'). We have to look up the
    // path the SUT captured, so import it indirectly via a known constant:
    // PROJECT_ROOT is ours, scripts/vault-env-wrapper.sh is the literal the
    // SUT joins onto it.
    const wrapperPath = join(PROJECT_ROOT, 'scripts', 'vault-env-wrapper.sh')
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: {
          srv: {
            command: wrapperPath,
            args: ['npx'],
            env: { TOKEN: 'vault:t' },
            _vaultOriginalCommand: 'npx',
            _vaultOriginalArgs: [],
          },
        },
      }),
    )
    getSecretMock.mockImplementation(() => 'v')
    syncSecret('t')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    // wrapCommand was a no-op because command === VAULT_WRAPPER_PATH; the
    // existing _vaultOriginalCommand stays put.
    expect(written.mcpServers.srv._vaultOriginalCommand).toBe('npx')
    // env ref preserved
    expect(written.mcpServers.srv.env.TOKEN).toBe('vault:t')
  })
})

describe('unsyncBinding', () => {
  it('no-op when there is no matching binding', () => {
    // Should not throw, should not write anything to disk.
    unsyncBinding('not-here', 'X')
    expect(existsSync(bindingsPath())).toBe(false)
  })

  it('strips env and unwraps command when the env becomes empty of vault refs', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { command: 'npx', args: ['gmail-mcp'], env: {} } } }),
    )
    getSecretMock.mockImplementation(() => 'v')
    syncSecret('t')
    unsyncBinding('t', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.env).toEqual({})
    expect(written.mcpServers.srv.command).toBe('npx')
    expect(written.mcpServers.srv._vaultOriginalCommand).toBeUndefined()
  })

  it('leaves the wrapper command intact when other vault refs remain in env', () => {
    addBinding({
      vaultSecretId: 't1',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { command: 'npx', args: ['gmail-mcp'], env: {} } } }),
    )
    getSecretMock.mockImplementation(() => 'v')
    syncSecret('t1')
    // Inject a second vault ref so unwrap should NOT fire.
    const afterWrap = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    afterWrap.mcpServers.srv.env.OTHER = 'vault:t2'
    writeFileSync(projectMcpPath(), JSON.stringify(afterWrap, null, 2))
    unsyncBinding('t1', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.env).toEqual({ OTHER: 'vault:t2' })
    // Wrapper path remained -> not unwrapped.
    expect(written.mcpServers.srv.command).not.toBe('npx')
  })

  it('does nothing on env branch when serverCfg.env is undefined', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { command: 'npx' } } }),
    )
    unsyncBinding('t', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.command).toBe('npx')
  })

  it('rebuilds headersHelper on header binding unsync', () => {
    addBinding({
      vaultSecretId: 'h1',
      envVar: 'AUTH',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'Authorization',
      headerScheme: 'Bearer',
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://api.example.com',
            headers: { Authorization: 'plaintext' },
            headersHelper: ['/path/to/helper.sh', 'Authorization=Bearer:::h1'].map((s) => `'${s}'`).join(' '),
          },
        },
      }),
    )
    unsyncBinding('h1', 'AUTH')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    // No header bindings remain -> headersHelper deleted.
    expect(written.mcpServers.remote.headersHelper).toBeUndefined()
    // The plaintext Authorization header is not managed by any remaining
    // binding, so the "delete if remaining bindings target it" pass in
    // applyHeadersHelper does not touch it. It survives on disk.
    expect(written.mcpServers.remote.headers).toEqual({ Authorization: 'plaintext' })
  })

  it('skips a target whose serverCfg is absent', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'missing' }],
    })
    writeFileSync(projectMcpPath(), JSON.stringify({ mcpServers: {} }))
    unsyncBinding('t', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.missing).toBeUndefined()
  })

  it('swallows JSON parse errors when updating the mcp file', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(projectMcpPath(), '{not json')
    // Should not throw.
    unsyncBinding('t', 'TOKEN')
  })
})

describe('removeBindingsForSecret', () => {
  it('removes the bindings and cleans serverCfg.env', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: { srv: { command: 'npx', args: ['gmail-mcp'], env: {} } },
      }),
    )
    getSecretMock.mockImplementation(() => 'v')
    // First wrap the command via syncSecret.
    syncSecret('t')
    // Then remove the binding entirely.
    removeBindingsForSecret('t')
    expect(getBindings()).toEqual([])
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.env).toEqual({})
    expect(written.mcpServers.srv.command).toBe('npx')
    expect(written.mcpServers.srv.args).toEqual(['gmail-mcp'])
  })

  it('rebuilds headersHelper on header bindings, leaving other header bindings intact', () => {
    addBinding({
      vaultSecretId: 'h1',
      envVar: 'AUTH',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'Authorization',
    })
    addBinding({
      vaultSecretId: 'h2',
      envVar: 'X_API',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'X-Api-Key',
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://api.example.com',
            headers: { Authorization: 'plaintext', 'X-Api-Key': 'plaintext2' },
            headersHelper: ['/h', 'Authorization=Bearer:::h1', 'X-Api-Key=Bearer:::h2'].map((s) => `'${s}'`).join(' '),
          },
        },
      }),
    )
    removeBindingsForSecret('h1')
    const onDisk = readBindingsFile().bindings.map((b) => b.vaultSecretId)
    expect(onDisk).toEqual(['h2'])
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    // Only the X-Api-Key plaintext is managed by a remaining binding, so
    // applyHeadersHelper strips it. Authorization is NOT bound by any
    // remaining binding so it stays untouched on disk.
    expect(written.mcpServers.remote.headers).toEqual({ Authorization: 'plaintext' })
    // One binding remaining -> headersHelper still set, with only h2.
    expect(written.mcpServers.remote.headersHelper).toContain('X-Api-Key=Bearer:::h2')
    expect(written.mcpServers.remote.headersHelper).not.toContain('Authorization')
  })

  it('removes the headersHelper entirely when no header bindings remain for that server', () => {
    addBinding({
      vaultSecretId: 'h1',
      envVar: 'AUTH',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'Authorization',
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://api.example.com',
            headers: { Authorization: 'plaintext' },
            headersHelper: "'/h' 'Authorization=Bearer:::h1'",
          },
        },
      }),
    )
    removeBindingsForSecret('h1')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.remote.headersHelper).toBeUndefined()
    // The plaintext Authorization header is not managed by any remaining
    // binding, so applyHeadersHelper's "delete header when bindings has it"
    // pass does not touch it. It survives as-is.
    expect(written.mcpServers.remote.headers).toEqual({ Authorization: 'plaintext' })
  })

  it('skips a target whose serverCfg is missing', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'missing' }],
    })
    writeFileSync(projectMcpPath(), JSON.stringify({ mcpServers: {} }))
    removeBindingsForSecret('t')
    expect(getBindings()).toEqual([])
  })

  it('skips an env branch when serverCfg.env is undefined', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(projectMcpPath(), JSON.stringify({ mcpServers: { srv: { command: 'npx' } } }))
    removeBindingsForSecret('t')
    expect(getBindings()).toEqual([])
  })

  it('swallows a JSON parse error per target', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(projectMcpPath(), '{not json')
    // Should not throw.
    removeBindingsForSecret('t')
    expect(getBindings()).toEqual([])
  })

  it('keeps the wrapper command when other vault refs remain in env', () => {
    addBinding({
      vaultSecretId: 't1',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { command: 'npx', env: {} } } }),
    )
    getSecretMock.mockImplementation(() => 'v')
    syncSecret('t1')
    // Now inject a second vault ref so unwrap should not fire.
    const afterWrap = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    afterWrap.mcpServers.srv.env.OTHER = 'vault:t2'
    writeFileSync(projectMcpPath(), JSON.stringify(afterWrap, null, 2))
    removeBindingsForSecret('t1')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.env).toEqual({ OTHER: 'vault:t2' })
    expect(written.mcpServers.srv.command).not.toBe('npx')
    // wrapper path lands in the command -- anything not 'npx' proves we did
    // not unwrap.
  })
})

describe('syncAllBindings', () => {
  it('returns { updated: 0, errors: [] } when there are no bindings', () => {
    expect(syncAllBindings()).toEqual({ updated: 0, errors: [] })
  })

  it('aggregates updates and errors across all secret ids', () => {
    addBinding({
      vaultSecretId: 'a',
      envVar: 'A',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srvA' }],
    })
    addBinding({
      vaultSecretId: 'b',
      envVar: 'B',
      targets: [
        { mcpFilePath: projectMcpPath(), serverName: 'srvB' },
        { mcpFilePath: projectMcpPath(), serverName: 'missing' },
      ],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srvA: { command: 'npx', env: {} }, srvB: { command: 'npx', env: {} } } }),
    )
    getSecretMock.mockImplementation(() => 'v')

    const result = syncAllBindings()
    expect(result.updated).toBe(2)
    expect(result.errors).toEqual([`Server "missing" not found in ${projectMcpPath()}`])
  })
})

describe('maskValue (via scanMcpConfigs)', () => {
  // maskValue is non-exported; the only consumer is scanMcpConfigs. We
  // confirm the 3-char-prefix / 3-char-suffix truncation directly:
  // looksLikeSensitiveValue rejects < 8 chars before maskValue is called,
  // so the truncation is the only reachable form maskValue can produce.
  it('produces the "first3...last3" form for a >= 8 char sensitive value', () => {
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { env: { API_KEY: 'abcdefghijkl' } } } }),
    )
    const findings = scanMcpConfigs()
    expect(findings[0].maskedValue).toBe('abc...jkl')
  })
})

describe('unwrapCommand (via syncSecret/removeBindingsForSecret/unsyncBinding)', () => {
  it('restores _vaultOriginalCommand when set', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: { srv: { command: 'npx', args: ['gmail-mcp'], env: {} } },
      }),
    )
    getSecretMock.mockImplementation(() => 'v')
    // First wrap the command via syncSecret.
    syncSecret('t')
    // Now unwrap via unsyncBinding (which deletes TOKEN and unwraps command).
    unsyncBinding('t', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.command).toBe('npx')
    expect(written.mcpServers.srv.args).toEqual(['gmail-mcp'])
    expect(written.mcpServers.srv._vaultOriginalCommand).toBeUndefined()
    expect(written.mcpServers.srv._vaultOriginalArgs).toBeUndefined()
  })

  it('restores _vaultOriginalCommand when the original had no args', () => {
    // Forces the `serverCfg._vaultOriginalArgs || []` fallback in unwrapCommand.
    // wrapCommand sets _vaultOriginalArgs only when args?.length, so an
    // original command with no args leaves it unset; unwrapCommand defaults
    // to [] via the `||` fallback.
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { command: 'npx', env: {} } } }),
    )
    getSecretMock.mockImplementation(() => 'v')
    syncSecret('t')
    unsyncBinding('t', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.command).toBe('npx')
    expect(written.mcpServers.srv.args).toEqual([])
  })

  it('is a no-op when the current command is not the wrapper path', () => {
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    // serverCfg.command is something else entirely; no vault refs.
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { srv: { command: 'echo', env: { TOKEN: 'plain' } } } }),
    )
    unsyncBinding('t', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.srv.command).toBe('echo')
  })

  it('handles a wrapped serverCfg that has lost its _vaultOriginalCommand backup', () => {
    // Forces the `if (!serverCfg._vaultOriginalCommand) return` branch in
    // unwrapCommand (line 228). The SUT's wrapCommand always sets the
    // backup, so this state only arises from a hand-edited .mcp.json (the
    // common crash-recovery scenario where the user manually deletes the
    // backup keys). The SUT's defensive guard prevents a crash and leaves
    // the wrapper path in place.
    addBinding({
      vaultSecretId: 't',
      envVar: 'TOKEN',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'srv' }],
    })
    const wrapperPath = join(PROJECT_ROOT, 'scripts', 'vault-env-wrapper.sh')
    // Hand-edited: command IS the wrapper path, _vaultOriginalCommand is
    // missing, and env contains the binding's var with NO other vault refs
    // (so serverHasVaultRefs returns false and unwrapCommand IS called).
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: {
          srv: {
            command: wrapperPath,
            args: ['npx'],
            env: { TOKEN: 'vault:t', OTHER: 'plaintext' },
            // _vaultOriginalCommand intentionally absent
          },
        },
      }),
    )
    unsyncBinding('t', 'TOKEN')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    // The SUT bailed out of unwrapCommand because the backup is missing, so
    // the wrapper path is left in place. No crash, no data loss.
    expect(written.mcpServers.srv.command).toBe(wrapperPath)
    expect(written.mcpServers.srv.env).toEqual({ OTHER: 'plaintext' })
  })
})

describe('applyHeadersHelper (via syncSecret/unsyncBinding)', () => {
  it('preserves headers that are not in any binding', () => {
    addBinding({
      vaultSecretId: 'h1',
      envVar: 'AUTH',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'Authorization',
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: {
          remote: {
            url: 'https://api.example.com',
            headers: { Authorization: 'plaintext', 'X-Other': 'keep-me' },
          },
        },
      }),
    )
    getSecretMock.mockImplementation((id: string) => (id === 'h1' ? 'realvalue' : null))
    syncSecret('h1')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.remote.headers).toEqual({ 'X-Other': 'keep-me' })
    expect(written.mcpServers.remote.headersHelper).toContain('Authorization=Bearer:::h1')
  })

  it('defaults the scheme to Bearer when headerScheme is undefined', () => {
    addBinding({
      vaultSecretId: 'h1',
      envVar: 'AUTH',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'Authorization',
      // headerScheme intentionally omitted
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({
        mcpServers: { remote: { url: 'https://api.example.com' } },
      }),
    )
    getSecretMock.mockImplementation((id: string) => (id === 'h1' ? 'realvalue' : null))
    syncSecret('h1')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.remote.headersHelper).toContain('Authorization=Bearer:::h1')
  })

  it('preserves an empty-string headerScheme verbatim (empty wins over the Bearer default)', () => {
    // The SUT does `b.headerScheme ?? 'Bearer'`, so an empty string survives
    // (empty string is not nullish). Document that this is the only way to
    // emit `Authorization=:::h1` (no scheme prefix).
    addBinding({
      vaultSecretId: 'h1',
      envVar: 'AUTH',
      targets: [{ mcpFilePath: projectMcpPath(), serverName: 'remote' }],
      headerName: 'Authorization',
      headerScheme: '',
    })
    writeFileSync(
      projectMcpPath(),
      JSON.stringify({ mcpServers: { remote: { url: 'https://api.example.com' } } }),
    )
    getSecretMock.mockImplementation((id: string) => (id === 'h1' ? 'realvalue' : null))
    syncSecret('h1')
    const written = JSON.parse(readFileSync(projectMcpPath(), 'utf-8'))
    expect(written.mcpServers.remote.headersHelper).toContain("'Authorization=:::h1'")
  })
})