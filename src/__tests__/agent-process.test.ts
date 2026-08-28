// Full-surface unit suite for src/web/agent-process.ts.
//
// The module drives tmux (locally and over ssh), provisions isolated Claude
// Code config dirs under $HOME, and reads/writes JSON state under STORE_DIR.
// None of that may touch the real machine, so three redirects are installed
// before the module is ever imported:
//
//   1. `node:os` homedir()  -> a per-test sandbox (mkTempDir), so every
//      `join(homedir(), '.claude', ...)` path resolves inside tmpdir.
//   2. `node:child_process` -> vi.fn() execSync/execFileSync, so tmux / ssh /
//      claude / bun / sleep are never spawned. Tests assert on the recorded
//      argv and drive return values / throws per call.
//   3. `../config.js`       -> STORE_DIR / PROJECT_ROOT pinned at a tmpdir path
//      string built in vi.hoisted(). FLEET_OAUTH_TOKEN_PATH is a MODULE-SCOPE
//      const (`join(STORE_DIR, '.claude-oauth-token')`), so the value must
//      exist before the first import -- hence the hoisted path, with the real
//      directory created in beforeAll.
//
// `node:fs` stays REAL: every path is already inside the sandbox, and the
// filesystem branches (symlink vs stale copy, unparseable JSON, EISDIR) are
// exactly what needs exercising.
//
// Collaborator modules are mocked at their boundary (agent-config, vault,
// notify, channel-poller-reap, ...) so this suite covers agent-process.ts and
// nothing else. `./ssh-tmux.js` is only PARTIALLY mocked -- the pure builders
// (buildTmuxInvocation / classifyRunState / ...) stay real because
// agent-process's own branches are keyed on their output.

import { describe, it, expect, vi, beforeEach, afterEach, beforeAll, afterAll } from 'vitest'
import {
  mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, lstatSync, readlinkSync, statSync, chmodSync,
  symlinkSync, realpathSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted harness. Every vi.mock factory below reads from this object, so a
// test can re-point a collaborator without re-importing the module under test.
// Paths are built as plain strings (no fs) because vi.hoisted runs before any
// import is evaluated; the directories themselves are created in beforeAll.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => {
  const tmpRoot = (process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')
  const root = `${tmpRoot}/marveen-agentproc-${process.pid}-${Math.random().toString(36).slice(2)}`
  return {
    root,
    storeDir: `${root}/store`,
    projectRoot: `${root}/project`,
    // Mutable per-test state -------------------------------------------------
    home: `${root}/home`,
    agentsRoot: `${root}/agents`,
    channelProvider: 'telegram',
    mainAgentId: 'marveen',
    ollamaUrl: 'http://127.0.0.1:11434',
    subagentInboxTee: false,
    mainChannelsSession: 'marveen-channels',
    // Collaborator mocks -----------------------------------------------------
    execSync: vi.fn(),
    execFileSync: vi.fn(),
    bins: { tmux: '/usr/bin/tmux', claude: '/usr/bin/claude' } as Record<string, string>,
    // agent-config
    listAgentNames: vi.fn(),
    readAgentModel: vi.fn(),
    readAgentClaudeConfigDir: vi.fn(),
    readAgentClaudePlan: vi.fn(),
    readAgentChannelProvider: vi.fn(),
    readAgentAuthMode: vi.fn(),
    readAgentDisplayName: vi.fn(),
    readAgentRemoteConfig: vi.fn(),
    readAgentRemoteHost: vi.fn(),
    readAgentMemoryIsolation: vi.fn(),
    // others
    resolveAgentConfigDir: vi.fn(),
    provisionMemoryBoundaryDir: vi.fn(),
    renameSharedCredentialsIfSafe: vi.fn(),
    ensureControlDir: vi.fn(),
    cleanStaleSshSockets: vi.fn(),
    parseTelegramToken: vi.fn(),
    getProvider: vi.fn(),
    getProviderType: vi.fn(),
    channelStateDir: vi.fn(),
    readChannelToken: vi.fn(),
    getEffectiveSettingValue: vi.fn(),
    loadProfileTemplate: vi.fn(),
    resolveAgentSecurityProfile: vi.fn(),
    writeAgentSettingsFromProfile: vi.fn(),
    ensureFleetRosterSection: vi.fn(),
    ensureAutonomySection: vi.fn(),
    schedulePluginUnlockAfterRespawn: vi.fn(),
    getSecret: vi.fn(),
    reapChannelOrphans: vi.fn(),
    reapDetachedChannelClaudes: vi.fn(),
    notifyChannel: vi.fn(),
    // pane-state (mocked so pane classification is driven, not string-crafted)
    paneLooksIdle: vi.fn(),
    decideSubmitFollowup: vi.fn(),
    shouldClearTruncatedPreamble: vi.fn(),
    detectsPastePlaceholder: vi.fn(),
    detectPaneState: vi.fn(),
    parkedInputText: vi.fn(),
    stripGhostSuggestion: vi.fn(),
    paneShowsContextSaturation: vi.fn(),
    idleConsideringDimGhost: vi.fn(),
    detectsFirstRunGate: vi.fn(),
    detectsModelConsentDialog: vi.fn(),
    // logger sink (assertable). `throwOnLog` makes the sink itself fail once
    // for a given message -- the only way an inner modal-dismiss helper (each
    // of which swallows its own errors) can throw out to a caller's guard.
    logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
    throwOnLog: null as string | null,
  }
})

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => H.home }
})

vi.mock('node:child_process', () => ({
  execSync: H.execSync,
  execFileSync: H.execFileSync,
}))

vi.mock('../config.js', () => ({
  get STORE_DIR() { return H.storeDir },
  get PROJECT_ROOT() { return H.projectRoot },
  get CHANNEL_PROVIDER() { return H.channelProvider },
  get MAIN_AGENT_ID() { return H.mainAgentId },
  get OLLAMA_URL() { return H.ollamaUrl },
  get SUBAGENT_INBOX_TEE() { return H.subagentInboxTee },
}))

vi.mock('../platform.js', () => ({
  makeLazyBinResolver: (name: string) => () => H.bins[name] ?? `/usr/bin/${name}`,
}))

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
  paneLooksIdle: H.paneLooksIdle,
  decideSubmitFollowup: H.decideSubmitFollowup,
  shouldClearTruncatedPreamble: H.shouldClearTruncatedPreamble,
  detectsPastePlaceholder: H.detectsPastePlaceholder,
  detectPaneState: H.detectPaneState,
  parkedInputText: H.parkedInputText,
  stripGhostSuggestion: H.stripGhostSuggestion,
  paneShowsContextSaturation: H.paneShowsContextSaturation,
  idleConsideringDimGhost: H.idleConsideringDimGhost,
  detectsFirstRunGate: H.detectsFirstRunGate,
  detectsModelConsentDialog: H.detectsModelConsentDialog,
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(H.agentsRoot, name),
  listAgentNames: H.listAgentNames,
  readAgentModel: H.readAgentModel,
  readAgentClaudeConfigDir: H.readAgentClaudeConfigDir,
  readAgentClaudePlan: H.readAgentClaudePlan,
  readAgentChannelProvider: H.readAgentChannelProvider,
  readAgentAuthMode: H.readAgentAuthMode,
  readAgentDisplayName: H.readAgentDisplayName,
  readAgentRemoteConfig: H.readAgentRemoteConfig,
  readAgentRemoteHost: H.readAgentRemoteHost,
  readAgentMemoryIsolation: H.readAgentMemoryIsolation,
}))

vi.mock('../web/claude-plans.js', () => ({ resolveAgentConfigDir: H.resolveAgentConfigDir }))
vi.mock('../web/memory-boundary.js', () => ({ provisionMemoryBoundaryDir: H.provisionMemoryBoundaryDir }))
vi.mock('../web/claude-credentials-guard.js', () => ({ renameSharedCredentialsIfSafe: H.renameSharedCredentialsIfSafe }))
vi.mock('../web/telegram.js', () => ({ parseTelegramToken: H.parseTelegramToken }))
vi.mock('../web/profiles.js', () => ({ loadProfileTemplate: H.loadProfileTemplate }))
vi.mock('../web/agent-team.js', () => ({ resolveAgentSecurityProfile: H.resolveAgentSecurityProfile }))
vi.mock('../web/channel-plugin-unlock.js', () => ({ schedulePluginUnlockAfterRespawn: H.schedulePluginUnlockAfterRespawn }))
vi.mock('../web/vault.js', () => ({ getSecret: H.getSecret }))
vi.mock('../web/main-agent.js', () => ({ get MAIN_CHANNELS_SESSION() { return H.mainChannelsSession } }))
vi.mock('../notify.js', () => ({ notifyChannel: H.notifyChannel }))
vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: H.getEffectiveSettingValue }))

vi.mock('../web/agent-scaffold.js', () => ({
  writeAgentSettingsFromProfile: H.writeAgentSettingsFromProfile,
  ensureFleetRosterSection: H.ensureFleetRosterSection,
  ensureAutonomySection: H.ensureAutonomySection,
}))

vi.mock('../web/channel-poller-reap.js', () => ({
  reapChannelOrphans: H.reapChannelOrphans,
  reapDetachedChannelClaudes: H.reapDetachedChannelClaudes,
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: H.getProvider,
  getProviderType: H.getProviderType,
  channelStateDir: H.channelStateDir,
  readChannelToken: H.readChannelToken,
}))

// ssh-tmux: keep the pure builders/classifiers real (agent-process branches on
// them), stub only the two functions with real side effects on the host.
vi.mock('../web/ssh-tmux.js', async (orig) => {
  const actual = await orig<typeof import('../web/ssh-tmux.js')>()
  return { ...actual, ensureControlDir: H.ensureControlDir, cleanStaleSshSockets: H.cleanStaleSshSockets }
})

// Imported AFTER every mock is registered.
const AP = await import('../web/agent-process.js')

// ---------------------------------------------------------------------------
// Deterministic clock. The module awaits `delay(ms)` in a dozen hot paths and
// two of them (waitForPaneIdle, clearStaleParkedInput's cooldown) branch on
// Date.now(). A plain "resolve setTimeout immediately" stub would make
// waitForPaneIdle spin forever, so the stub ALSO advances a virtual clock by
// the requested delay and Date.now() reads that clock. Every wait therefore
// completes in microtasks while time still moves forward monotonically.
// ---------------------------------------------------------------------------
let CLOCK = 0
const realSetTimeout = globalThis.setTimeout

function fakeSetTimeout(fn: () => void, ms?: number): number {
  CLOCK += ms ?? 0
  queueMicrotask(fn)
  return 0
}

/** Drain the microtask queue so every queued fake-timer callback has run. */
async function flush(turns = 200): Promise<void> {
  for (let i = 0; i < turns; i++) await Promise.resolve()
}

/** Real-timer yield, for the rare assertion that must outlast a macrotask. */
function realTick(): Promise<void> {
  return new Promise((r) => { realSetTimeout(r, 0) })
}

// ---------------------------------------------------------------------------
// Shared per-test fixture helpers
// ---------------------------------------------------------------------------

/** Recorded `execFileSync` invocations reduced to the tmux/ssh argv. */
function calls(): Array<{ file: string; args: string[] }> {
  return H.execFileSync.mock.calls.map((c) => ({
    file: String(c[0]),
    args: Array.isArray(c[1]) ? c[1].map((a) => String(a)) : [],
  }))
}

/** The argv of every recorded call, flattened for substring assertions. */
function argvStrings(): string[] {
  return calls().map((c) => [c.file, ...c.args].join(' '))
}

/** Seed a shared ~/.claude tree in the sandbox home. */
function seedSharedClaude(opts: {
  settings?: unknown
  settingsRaw?: string
  installedPlugins?: unknown
  installedRaw?: string
  knownMarketplaces?: boolean
  extraEntries?: string[]
  credentials?: boolean
  pluginSubdirs?: string[]
} = {}): string {
  const claude = join(H.home, '.claude')
  mkdirSync(claude, { recursive: true })
  mkdirSync(join(claude, 'projects'), { recursive: true })
  for (const e of opts.extraEntries ?? []) writeFileSync(join(claude, e), 'x')
  if (opts.credentials !== false) writeFileSync(join(claude, '.credentials.json'), '{"claudeAiOauth":{}}')
  if (opts.settingsRaw !== undefined) writeFileSync(join(claude, 'settings.json'), opts.settingsRaw)
  else if (opts.settings !== undefined) writeFileSync(join(claude, 'settings.json'), JSON.stringify(opts.settings))

  const plugins = join(claude, 'plugins')
  mkdirSync(plugins, { recursive: true })
  for (const sub of opts.pluginSubdirs ?? ['cache', 'marketplaces', 'data']) {
    mkdirSync(join(plugins, sub), { recursive: true })
  }
  if (opts.knownMarketplaces !== false) {
    writeFileSync(join(plugins, 'known_marketplaces.json'), '{"claude-plugins-official":{}}')
  }
  if (opts.installedRaw !== undefined) writeFileSync(join(plugins, 'installed_plugins.json'), opts.installedRaw)
  else if (opts.installedPlugins !== undefined) {
    writeFileSync(join(plugins, 'installed_plugins.json'), JSON.stringify(opts.installedPlugins))
  }
  return claude
}

/** Write the fleet OAuth token so hasFleetOauthToken() is true. */
function writeFleetToken(value = 'sk-ant-oat-test'): void {
  mkdirSync(H.storeDir, { recursive: true })
  writeFileSync(AP.FLEET_OAUTH_TOKEN_PATH, value)
}

function removeFleetToken(): void {
  rmSync(AP.FLEET_OAUTH_TOKEN_PATH, { force: true })
}

const envSnapshot = snapshotEnv()

beforeAll(() => {
  mkdirSync(H.root, { recursive: true })
})

afterAll(() => {
  envSnapshot.restore()
  rmTempDir(H.root)
})

beforeEach(() => {
  vi.clearAllMocks()
  H.logs.length = 0
  H.throwOnLog = null
  CLOCK = 1_000_000
  vi.stubGlobal('setTimeout', fakeSetTimeout)
  vi.spyOn(Date, 'now').mockImplementation(() => CLOCK)

  // Fresh sandbox per test: home + agents + store all live under it.
  const sandbox = mkTempDir('agentproc-')
  H.home = join(sandbox, 'home')
  H.agentsRoot = join(sandbox, 'agents')
  H.projectRoot = join(sandbox, 'project')
  mkdirSync(H.home, { recursive: true })
  mkdirSync(H.agentsRoot, { recursive: true })
  mkdirSync(H.projectRoot, { recursive: true })
  // STORE_DIR is pinned (module-scope FLEET_OAUTH_TOKEN_PATH) -- reset its
  // contents instead of re-pointing it.
  rmSync(H.storeDir, { recursive: true, force: true })
  mkdirSync(H.storeDir, { recursive: true })

  H.channelProvider = 'telegram'
  H.mainAgentId = 'marveen'
  H.subagentInboxTee = false
  H.mainChannelsSession = 'marveen-channels'
  H.bins = { tmux: '/usr/bin/tmux', claude: '/usr/bin/claude' }

  // Sensible defaults; individual tests override what they exercise.
  H.execFileSync.mockReturnValue('')
  H.execSync.mockReturnValue('')
  H.listAgentNames.mockReturnValue([])
  H.readAgentModel.mockReturnValue('claude-opus-4-8')
  H.readAgentClaudePlan.mockReturnValue(null)
  H.readAgentChannelProvider.mockReturnValue(null)
  H.readAgentAuthMode.mockReturnValue('oauth')
  H.readAgentDisplayName.mockReturnValue('Testy')
  H.readAgentRemoteConfig.mockReturnValue({ host: null, workdir: null })
  H.readAgentRemoteHost.mockReturnValue(null)
  H.readAgentMemoryIsolation.mockReturnValue(false)
  H.resolveAgentConfigDir.mockReturnValue({ configDir: null, planUnresolved: false })
  H.parseTelegramToken.mockReturnValue(null)
  H.getProvider.mockImplementation((t: string) => ({ type: t, pluginId: `${t}@marketplace` }))
  H.getProviderType.mockImplementation((v: string | undefined) => v ?? 'telegram')
  H.channelStateDir.mockImplementation((_p: string, dir: string) => join(dir, '.channel'))
  H.readChannelToken.mockReturnValue(null)
  H.getEffectiveSettingValue.mockReturnValue('')
  H.loadProfileTemplate.mockReturnValue({ permissionMode: 'permissive' })
  H.resolveAgentSecurityProfile.mockReturnValue('default')
  H.getSecret.mockReturnValue(null)
  H.notifyChannel.mockResolvedValue(undefined)

  // pane-state defaults: idle, nothing parked, no dialogs.
  H.paneLooksIdle.mockReturnValue(true)
  H.decideSubmitFollowup.mockReturnValue('done')
  H.shouldClearTruncatedPreamble.mockReturnValue(false)
  H.detectsPastePlaceholder.mockReturnValue(false)
  H.detectPaneState.mockReturnValue('idle')
  H.parkedInputText.mockReturnValue('')
  H.stripGhostSuggestion.mockImplementation((s: string) => s)
  H.paneShowsContextSaturation.mockReturnValue(false)
  H.idleConsideringDimGhost.mockReturnValue(true)
  H.detectsFirstRunGate.mockReturnValue(null)
  H.detectsModelConsentDialog.mockReturnValue(false)

  AP.resetSharedConfigCollisionAlert()
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

// ===========================================================================
// Pure helpers
// ===========================================================================

describe('delay', () => {
  it('resolves after the requested delay', async () => {
    const before = Date.now()
    await AP.delay(250)
    expect(Date.now() - before).toBe(250)
  })
})

describe('scopeChannelPlugins', () => {
  const IDS = Object.values(AP.CHANNEL_PLUGIN_IDS)

  it('enables only the named provider plugin and disables every other channel plugin', () => {
    const out = AP.scopeChannelPlugins('slack')
    expect(out[AP.CHANNEL_PLUGIN_IDS.slack]).toBe(true)
    for (const id of IDS) {
      if (id !== AP.CHANNEL_PLUGIN_IDS.slack) expect(out[id]).toBe(false)
    }
  })

  it('disables every channel plugin for a channel-less agent (null provider)', () => {
    const out = AP.scopeChannelPlugins(null)
    for (const id of IDS) expect(out[id]).toBe(false)
  })

  it('preserves non-channel plugins from the existing map', () => {
    const out = AP.scopeChannelPlugins('telegram', { 'some-other@mkt': true, [AP.CHANNEL_PLUGIN_IDS.slack]: true })
    expect(out['some-other@mkt']).toBe(true)
    expect(out[AP.CHANNEL_PLUGIN_IDS.slack]).toBe(false)
    expect(out[AP.CHANNEL_PLUGIN_IDS.telegram]).toBe(true)
  })

  it('treats an unknown provider id as "no own plugin"', () => {
    const out = AP.scopeChannelPlugins('irc')
    for (const id of IDS) expect(out[id]).toBe(false)
  })
})

describe('ownChannelProviderForScope', () => {
  it('returns the resolved provider only when the agent has its own token', () => {
    expect(AP.ownChannelProviderForScope(true, 'slack')).toBe('slack')
  })
  it('returns null without an own token', () => {
    expect(AP.ownChannelProviderForScope(false, 'slack')).toBeNull()
  })
  it('returns null when there is no resolved provider', () => {
    expect(AP.ownChannelProviderForScope(true, null)).toBeNull()
  })
})

describe('buildTelegramMcpServerConfig', () => {
  it('wraps the bun stdio server in the channel-inbound-tee and pins the state dir', () => {
    const cfg = AP.buildTelegramMcpServerConfig('/bun/bin/bun', '/plug/dir', '/state/dir')
    expect(cfg.command).toBe('node')
    expect(cfg.args[0]).toBe(join(H.projectRoot, 'scripts', 'channel-inbound-tee.mjs'))
    expect(cfg.args.slice(1)).toEqual(['/bun/bin/bun', 'run', '--cwd', '/plug/dir', '--shell=bun', '--silent', 'start'])
    expect(cfg.env).toEqual({ TELEGRAM_STATE_DIR: '/state/dir' })
  })
})

describe('hasFleetOauthToken', () => {
  it('is true for a non-empty token file', () => {
    writeFleetToken()
    expect(AP.hasFleetOauthToken()).toBe(true)
  })
  it('is false when the file is absent', () => {
    removeFleetToken()
    expect(AP.hasFleetOauthToken()).toBe(false)
  })
  it('is false for a whitespace-only token file', () => {
    writeFleetToken('   \n  ')
    expect(AP.hasFleetOauthToken()).toBe(false)
  })
  it('is false when reading the path throws (a directory in its place)', () => {
    removeFleetToken()
    mkdirSync(AP.FLEET_OAUTH_TOKEN_PATH, { recursive: true })
    expect(AP.hasFleetOauthToken()).toBe(false)
    rmSync(AP.FLEET_OAUTH_TOKEN_PATH, { recursive: true, force: true })
  })
})

describe('shouldAlertSharedConfigCollision', () => {
  it('never alerts on macOS (the collision does not manifest there)', () => {
    expect(AP.shouldAlertSharedConfigCollision(false, 5, 'darwin')).toBe(false)
  })
  it('alerts on linux without a token and >1 same-provider contender', () => {
    expect(AP.shouldAlertSharedConfigCollision(false, 2, 'linux')).toBe(true)
  })
  it('never alerts when the fleet token is present', () => {
    expect(AP.shouldAlertSharedConfigCollision(true, 9, 'linux')).toBe(false)
  })
  it('does not alert for a single contender', () => {
    expect(AP.shouldAlertSharedConfigCollision(false, 1, 'linux')).toBe(false)
  })
  it('defaults the platform to process.platform', () => {
    expect(AP.shouldAlertSharedConfigCollision(false, 2)).toBe(process.platform !== 'darwin')
  })
})

describe('maxSameProviderContenders', () => {
  it('is 0 for an empty fleet', () => {
    expect(AP.maxSameProviderContenders([])).toBe(0)
  })
  it('ignores stopped agents and channel-less agents', () => {
    expect(AP.maxSameProviderContenders([
      { provider: 'telegram', running: false, hasChannel: true },
      { provider: 'telegram', running: true, hasChannel: false },
    ])).toBe(0)
  })
  it('takes the max per provider, never the cross-provider sum', () => {
    expect(AP.maxSameProviderContenders([
      { provider: 'telegram', running: true, hasChannel: true },
      { provider: 'telegram', running: true, hasChannel: true },
      { provider: 'slack', running: true, hasChannel: true },
    ])).toBe(2)
  })
})

describe('countSameProviderChannelContenders', () => {
  it('excludes the main agent and counts the starting agent as running', () => {
    H.listAgentNames.mockReturnValue(['marveen', 'zara', 'boni'])
    H.readChannelToken.mockReturnValue('tok')
    // zara is the one starting (no tmux session yet); boni's list-sessions says stopped.
    H.execFileSync.mockReturnValue('other-session\n')
    expect(AP.countSameProviderChannelContenders('zara')).toBe(1)
  })

  it('counts a running same-provider sibling alongside the starting agent', () => {
    H.listAgentNames.mockReturnValue(['marveen', 'zara', 'boni'])
    H.readChannelToken.mockReturnValue('tok')
    H.execFileSync.mockReturnValue('agent-boni\n')
    expect(AP.countSameProviderChannelContenders('zara')).toBe(2)
  })
})

describe('agentSessionName', () => {
  it('prefixes the agent name', () => {
    expect(AP.agentSessionName('zara')).toBe('agent-zara')
  })
})

describe('identitySlashCommands', () => {
  it('returns only the /name command', () => {
    expect(AP.identitySlashCommands('Zoé')).toEqual(['/name Zoé'])
  })
})

// ===========================================================================
// Config-dir resolution
// ===========================================================================

describe('resolveMainAgentConfigDir', () => {
  it('returns null when MAIN_AGENT_CONFIG_DIR is unset', () => {
    H.getEffectiveSettingValue.mockReturnValue('')
    expect(AP.resolveMainAgentConfigDir()).toBeNull()
  })

  it('returns null when the setting is nullish', () => {
    H.getEffectiveSettingValue.mockReturnValue(null)
    expect(AP.resolveMainAgentConfigDir()).toBeNull()
  })

  it('returns null when the settings-store throws', () => {
    H.getEffectiveSettingValue.mockImplementation(() => { throw new Error('store down') })
    expect(AP.resolveMainAgentConfigDir()).toBeNull()
  })

  it('expands a leading ~ against homedir()', () => {
    const target = join(H.home, 'alt-claude')
    mkdirSync(target, { recursive: true })
    H.getEffectiveSettingValue.mockReturnValue('~/alt-claude')
    expect(AP.resolveMainAgentConfigDir()).toBe(target)
  })

  it('fails closed with a warn when the configured dir does not exist', () => {
    H.getEffectiveSettingValue.mockReturnValue(join(H.home, 'nope'))
    expect(AP.resolveMainAgentConfigDir()).toBeNull()
    expect(H.logs.some((l) => l.level === 'warn' && String(l.msg).includes('does not exist'))).toBe(true)
  })

  it('returns an existing absolute dir unchanged', () => {
    const target = join(H.home, 'explicit')
    mkdirSync(target, { recursive: true })
    H.getEffectiveSettingValue.mockReturnValue(`  ${target}  `)
    expect(AP.resolveMainAgentConfigDir()).toBe(target)
  })
})

describe('ensureMainAgentIsolatedConfigDir', () => {
  it('is a no-op when MAIN_AGENT_ISOLATED_CONFIG is off', () => {
    H.getEffectiveSettingValue.mockReturnValue('0')
    expect(AP.ensureMainAgentIsolatedConfigDir()).toBeNull()
  })

  it('is a no-op when the settings lookup throws', () => {
    H.getEffectiveSettingValue.mockImplementation(() => { throw new Error('boom') })
    expect(AP.ensureMainAgentIsolatedConfigDir()).toBeNull()
  })

  it('is a hard no-op without the fleet OAuth token', () => {
    H.getEffectiveSettingValue.mockReturnValue('1')
    removeFleetToken()
    expect(AP.ensureMainAgentIsolatedConfigDir()).toBeNull()
  })

  it('provisions .channels-config under PROJECT_ROOT when enabled with a token', () => {
    H.getEffectiveSettingValue.mockReturnValue('1')
    writeFleetToken()
    seedSharedClaude({ settings: {} })
    const out = AP.ensureMainAgentIsolatedConfigDir('slack')
    expect(out).toBe(join(H.projectRoot, '.channels-config'))
    expect(H.getProviderType).toHaveBeenCalledWith('slack')
    expect(existsSync(join(H.projectRoot, '.channels-config', 'settings.json'))).toBe(true)
  })

  it('accepts an explicit platform argument', () => {
    H.getEffectiveSettingValue.mockReturnValue('0')
    expect(AP.ensureMainAgentIsolatedConfigDir(undefined, 'linux')).toBeNull()
  })
})

// ===========================================================================
// provisionIsolatedConfigDir (via ensureIsolatedChannelConfigDir)
// ===========================================================================

describe('ensureIsolatedChannelConfigDir', () => {
  const NAME = 'zara'
  const cfgPath = (): string => join(H.agentsRoot, NAME, '.claude-config')

  beforeEach(() => {
    mkdirSync(join(H.agentsRoot, NAME), { recursive: true })
  })

  it('returns null when there is no shared ~/.claude to mirror', () => {
    expect(AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')).toBeNull()
  })

  it('symlinks shared entries and owns settings.json + plugins/', () => {
    seedSharedClaude({ settings: { hooks: { Stop: [] }, enabledPlugins: { keepme: true } } })
    const cfg = AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(cfg).toBe(cfgPath())

    // projects/ is symlinked (shared transcripts)
    expect(lstatSync(join(cfgPath(), 'projects')).isSymbolicLink()).toBe(true)
    expect(readlinkSync(join(cfgPath(), 'projects'))).toBe(join(H.home, '.claude', 'projects'))
    // settings.json is a real owned file, not a link
    expect(lstatSync(join(cfgPath(), 'settings.json')).isSymbolicLink()).toBe(false)
    // .credentials.json is deliberately absent (auth comes from the env token)
    expect(existsSync(join(cfgPath(), '.credentials.json'))).toBe(false)

    const s = JSON.parse(readFileSync(join(cfgPath(), 'settings.json'), 'utf-8'))
    expect(s.hooks).toEqual({ Stop: [] })
    expect(s.enabledPlugins.keepme).toBe(true)
    expect(s.enabledPlugins[AP.CHANNEL_PLUGIN_IDS.telegram]).toBe(true)
    expect(s.enabledPlugins[AP.CHANNEL_PLUGIN_IDS.slack]).toBe(false)
  })

  it('disables every channel plugin for a channel-less agent (null provider)', () => {
    seedSharedClaude({ settings: {} })
    AP.ensureIsolatedChannelConfigDir(NAME, null)
    const s = JSON.parse(readFileSync(join(cfgPath(), 'settings.json'), 'utf-8'))
    for (const id of Object.values(AP.CHANNEL_PLUGIN_IDS)) expect(s.enabledPlugins[id]).toBe(false)
  })

  it('falls back to an empty settings object when the shared settings.json is unparseable', () => {
    seedSharedClaude({ settingsRaw: '{ not json' })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const s = JSON.parse(readFileSync(join(cfgPath(), 'settings.json'), 'utf-8'))
    expect(Object.keys(s)).toEqual(['enabledPlugins'])
  })

  it('works when the shared settings.json is absent entirely', () => {
    seedSharedClaude()
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(existsSync(join(cfgPath(), 'settings.json'))).toBe(true)
  })

  it('removes a stale non-symlink entry and replaces it with a symlink', () => {
    seedSharedClaude({ extraEntries: ['CLAUDE.md'] })
    mkdirSync(cfgPath(), { recursive: true })
    writeFileSync(join(cfgPath(), 'CLAUDE.md'), 'stale copy')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(lstatSync(join(cfgPath(), 'CLAUDE.md')).isSymbolicLink()).toBe(true)
  })

  it('leaves an already-correct symlink alone (idempotent re-provision)', () => {
    seedSharedClaude({ settings: {} })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const before = lstatSync(join(cfgPath(), 'projects')).ino
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(lstatSync(join(cfgPath(), 'projects')).ino).toBe(before)
  })

  it('drops a .credentials.json left behind by an older build', () => {
    seedSharedClaude({ settings: {} })
    mkdirSync(cfgPath(), { recursive: true })
    writeFileSync(join(cfgPath(), '.credentials.json'), '{"stale":true}')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(existsSync(join(cfgPath(), '.credentials.json'))).toBe(false)
  })

  it('warns per entry when the isolated dir is not writable, then fails closed', () => {
    seedSharedClaude({ settings: {}, extraEntries: ['CLAUDE.md'] })
    mkdirSync(cfgPath(), { recursive: true })
    chmodSync(cfgPath(), 0o555)
    try {
      expect(AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')).toBeNull()
      expect(H.logs.some((l) => String(l.msg).includes('symlink failed'))).toBe(true)
      expect(H.logs.some((l) => String(l.msg).includes('provisioning failed'))).toBe(true)
    } finally {
      chmodSync(cfgPath(), 0o755)
    }
  })

  it('warns when a plugins/ subdir symlink cannot be created', () => {
    seedSharedClaude({ settings: {}, knownMarketplaces: false })
    mkdirSync(join(cfgPath(), 'plugins'), { recursive: true })
    chmodSync(join(cfgPath(), 'plugins'), 0o555)
    try {
      expect(AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')).toBe(cfgPath())
      expect(H.logs.some((l) => String(l.msg).includes('plugin symlink failed'))).toBe(true)
    } finally {
      chmodSync(join(cfgPath(), 'plugins'), 0o755)
    }
  })

  it('symlinks plugins/{cache,marketplaces,data} and copies known_marketplaces.json', () => {
    seedSharedClaude({ settings: {} })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    for (const sub of ['cache', 'marketplaces', 'data']) {
      expect(lstatSync(join(cfgPath(), 'plugins', sub)).isSymbolicLink()).toBe(true)
    }
    expect(readFileSync(join(cfgPath(), 'plugins', 'known_marketplaces.json'), 'utf-8'))
      .toBe('{"claude-plugins-official":{}}')
  })

  it('skips plugin subdirs that do not exist in the shared config', () => {
    seedSharedClaude({ settings: {}, pluginSubdirs: ['cache'], knownMarketplaces: false })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(existsSync(join(cfgPath(), 'plugins', 'marketplaces'))).toBe(false)
    expect(existsSync(join(cfgPath(), 'plugins', 'known_marketplaces.json'))).toBe(false)
  })

  it('replaces a stale non-symlink plugin subdir with a symlink', () => {
    seedSharedClaude({ settings: {} })
    mkdirSync(join(cfgPath(), 'plugins', 'cache'), { recursive: true })
    writeFileSync(join(cfgPath(), 'plugins', 'cache', 'junk'), 'x')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(lstatSync(join(cfgPath(), 'plugins', 'cache')).isSymbolicLink()).toBe(true)
  })

  it('leaves an existing plugin-subdir symlink in place', () => {
    seedSharedClaude({ settings: {} })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const before = lstatSync(join(cfgPath(), 'plugins', 'cache')).ino
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(lstatSync(join(cfgPath(), 'plugins', 'cache')).ino).toBe(before)
  })

  it('re-points every project-scoped install at this agent cwd', () => {
    seedSharedClaude({
      settings: {},
      installedPlugins: {
        plugins: {
          [AP.CHANNEL_PLUGIN_IDS.telegram]: [
            { scope: 'project', projectPath: '/some/other/agent' },
            { scope: 'user', projectPath: '/untouched' },
          ],
        },
      },
    })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const inst = JSON.parse(readFileSync(join(cfgPath(), 'plugins', 'installed_plugins.json'), 'utf-8'))
    const entries = inst.plugins[AP.CHANNEL_PLUGIN_IDS.telegram]
    expect(entries[0].projectPath).toBe(join(H.agentsRoot, NAME))
    expect(entries[1].projectPath).toBe('/untouched')
  })

  it('tolerates an installed_plugins.json with no plugins key', () => {
    seedSharedClaude({ settings: {}, installedPlugins: {} })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(existsSync(join(cfgPath(), 'plugins', 'installed_plugins.json'))).toBe(true)
  })

  it('warns and continues when installed_plugins.json is unparseable', () => {
    seedSharedClaude({ settings: {}, installedRaw: 'NOT JSON' })
    const cfg = AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(cfg).toBe(cfgPath())
    expect(H.logs.some((l) => String(l.msg).includes('failed to seed installed_plugins.json'))).toBe(true)
  })

  it('seeds .claude.json from the shared one and forces hasCompletedOnboarding', () => {
    seedSharedClaude({ settings: {} })
    writeFileSync(join(H.home, '.claude.json'), JSON.stringify({ theme: 'dark', hasCompletedOnboarding: false }))
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const dot = JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8'))
    expect(dot.theme).toBe('dark')
    expect(dot.hasCompletedOnboarding).toBe(true)
  })

  it('falls back to a minimal seed when the shared .claude.json is unparseable', () => {
    seedSharedClaude({ settings: {} })
    writeFileSync(join(H.home, '.claude.json'), '{{{')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')))
      .toEqual({ hasCompletedOnboarding: true })
  })

  it('seeds a minimal .claude.json when there is no shared one', () => {
    seedSharedClaude({ settings: {} })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')))
      .toEqual({ hasCompletedOnboarding: true })
  })

  it('re-seeds hasCompletedOnboarding on an existing isolated .claude.json', () => {
    seedSharedClaude({ settings: {} })
    mkdirSync(cfgPath(), { recursive: true })
    writeFileSync(join(cfgPath(), '.claude.json'), JSON.stringify({ projects: {} }))
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const dot = JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8'))
    expect(dot.hasCompletedOnboarding).toBe(true)
  })

  it('leaves an already-onboarded isolated .claude.json untouched', () => {
    seedSharedClaude({ settings: {} })
    mkdirSync(cfgPath(), { recursive: true })
    const raw = JSON.stringify({ hasCompletedOnboarding: true })
    writeFileSync(join(cfgPath(), '.claude.json'), raw)
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')).toBe(raw)
  })

  it('leaves an unparseable isolated .claude.json for Claude Code to recreate', () => {
    seedSharedClaude({ settings: {} })
    mkdirSync(cfgPath(), { recursive: true })
    writeFileSync(join(cfgPath(), '.claude.json'), 'garbage')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')).toBe('garbage')
  })

  it('warns when the onboarding seed step itself throws', () => {
    seedSharedClaude({ settings: {} })
    // A shared config that parses to `null`: the seed copy succeeds, then the
    // hasCompletedOnboarding assignment throws on it -- the outer guard.
    writeFileSync(join(H.home, '.claude.json'), 'null')
    const cfg = AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(cfg).toBe(cfgPath())
    expect(H.logs.some((l) => String(l.msg).includes('failed to seed onboarding state'))).toBe(true)
  })

  it('returns null and warns when provisioning fails outright', () => {
    seedSharedClaude({ settings: {} })
    // A regular FILE at the .claude-config path makes the mkdirSync fail.
    writeFileSync(cfgPath(), 'not a dir')
    expect(AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')).toBeNull()
    expect(H.logs.some((l) => String(l.msg).includes('provisioning failed'))).toBe(true)
  })
})

// ===========================================================================
// reconcileMcpServers (reached through a re-provision)
// ===========================================================================

describe('isolated .claude.json MCP reconcile', () => {
  const NAME = 'zara'
  const cfgPath = (): string => join(H.agentsRoot, NAME, '.claude-config')

  function provisionWithIsolatedDot(isolated: Record<string, unknown>, shared?: string): void {
    seedSharedClaude({ settings: {} })
    if (shared !== undefined) writeFileSync(join(H.home, '.claude.json'), shared)
    mkdirSync(cfgPath(), { recursive: true })
    writeFileSync(join(cfgPath(), '.claude.json'), JSON.stringify(isolated))
  }

  beforeEach(() => {
    mkdirSync(join(H.agentsRoot, NAME), { recursive: true })
  })

  it('copies servers missing from the isolated config', () => {
    provisionWithIsolatedDot(
      { hasCompletedOnboarding: true, mcpServers: { existing: { command: 'a' } } },
      JSON.stringify({ mcpServers: { existing: { command: 'SHARED' }, added: { command: 'b' } } }),
    )
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const dot = JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8'))
    expect(dot.mcpServers.added).toEqual({ command: 'b' })
    // never overwrites an entry the agent already evolved
    expect(dot.mcpServers.existing).toEqual({ command: 'a' })
  })

  it('creates mcpServers on the isolated side when it had none', () => {
    provisionWithIsolatedDot(
      { hasCompletedOnboarding: true },
      JSON.stringify({ mcpServers: { fresh: { command: 'c' } } }),
    )
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const dot = JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8'))
    expect(dot.mcpServers).toEqual({ fresh: { command: 'c' } })
  })

  it('is a no-op when there is nothing to add', () => {
    provisionWithIsolatedDot(
      { hasCompletedOnboarding: true, mcpServers: { same: { command: 'a' } } },
      JSON.stringify({ mcpServers: { same: { command: 'a' } } }),
    )
    const before = readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')).toBe(before)
  })

  it('is a no-op when the shared config has no mcpServers object', () => {
    provisionWithIsolatedDot(
      { hasCompletedOnboarding: true },
      JSON.stringify({ mcpServers: ['not', 'an', 'object'] }),
    )
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const dot = JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8'))
    expect(dot.mcpServers).toBeUndefined()
  })

  it('is a no-op when the shared config is unparseable', () => {
    provisionWithIsolatedDot({ hasCompletedOnboarding: true }, 'not-json')
    const before = readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')).toBe(before)
  })

  it('is a no-op when there is no shared .claude.json at all', () => {
    provisionWithIsolatedDot({ hasCompletedOnboarding: true })
    const before = readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8')).toBe(before)
  })

  it('refuses to repair a non-object mcpServers on the isolated side', () => {
    provisionWithIsolatedDot(
      { hasCompletedOnboarding: true, mcpServers: 'oops' },
      JSON.stringify({ mcpServers: { fresh: { command: 'c' } } }),
    )
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    const dot = JSON.parse(readFileSync(join(cfgPath(), '.claude.json'), 'utf-8'))
    expect(dot.mcpServers).toBe('oops')
    expect(H.logs.some((l) => String(l.msg).includes('mcpServers is not an object'))).toBe(true)
  })

  it('preserves the 0600 mode across the tmp+rename write', () => {
    provisionWithIsolatedDot(
      { hasCompletedOnboarding: true },
      JSON.stringify({ mcpServers: { fresh: { command: 'c' } } }),
    )
    const dot = join(cfgPath(), '.claude.json')
    rmSync(dot)
    writeFileSync(dot, JSON.stringify({ hasCompletedOnboarding: true }), { mode: 0o600 })
    AP.ensureIsolatedChannelConfigDir(NAME, 'telegram')
    expect(statSync(dot).mode & 0o777).toBe(0o600)
  })
})

// ===========================================================================
// Shared-root onboarding / trust / consent stamps
// ===========================================================================

describe('ensureSharedClaudeOnboarded', () => {
  it('creates ~/.claude.json with the flag when it is missing', () => {
    const p = join(H.home, '.claude.json')
    expect(AP.ensureSharedClaudeOnboarded(p)).toBe(true)
    expect(JSON.parse(readFileSync(p, 'utf-8'))).toEqual({ hasCompletedOnboarding: true })
    expect(statSync(p).mode & 0o777).toBe(0o600)
  })

  it('is a no-op when the flag is already set', () => {
    const p = join(H.home, '.claude.json')
    writeFileSync(p, JSON.stringify({ hasCompletedOnboarding: true }))
    expect(AP.ensureSharedClaudeOnboarded(p)).toBe(false)
  })

  it('re-seeds a flag that vanished, preserving the rest of the file', () => {
    const p = join(H.home, '.claude.json')
    writeFileSync(p, JSON.stringify({ projects: { '/a': {} } }))
    expect(AP.ensureSharedClaudeOnboarded(p)).toBe(true)
    const data = JSON.parse(readFileSync(p, 'utf-8'))
    expect(data.hasCompletedOnboarding).toBe(true)
    expect(data.projects).toEqual({ '/a': {} })
  })

  it('leaves an unparseable file alone and reports no change', () => {
    const p = join(H.home, '.claude.json')
    writeFileSync(p, 'not json')
    expect(AP.ensureSharedClaudeOnboarded(p)).toBe(false)
    expect(readFileSync(p, 'utf-8')).toBe('not json')
  })

  it('defaults to the homedir-anchored path', () => {
    expect(AP.ensureSharedClaudeOnboarded()).toBe(true)
    expect(existsSync(join(H.home, '.claude.json'))).toBe(true)
  })
})

describe('stampProjectTrustForDir', () => {
  const dotPath = (): string => join(H.home, '.claude.json')

  it('stamps trust flags for a dir in a file that does not exist yet', () => {
    const projectDir = join(H.agentsRoot, 'zara')
    mkdirSync(projectDir, { recursive: true })
    expect(AP.stampProjectTrustForDir(dotPath(), projectDir)).toBe(true)
    const data = JSON.parse(readFileSync(dotPath(), 'utf-8'))
    expect(data.hasCompletedOnboarding).toBe(true)
    expect(data.projects[projectDir]).toEqual({
      hasTrustDialogAccepted: true,
      hasCompletedProjectOnboarding: true,
      projectOnboardingSeenCount: 1,
    })
  })

  it('also stamps the realpath when it differs from the given dir', () => {
    const real = join(H.agentsRoot, 'real-target')
    mkdirSync(real, { recursive: true })
    const linkDir = join(H.agentsRoot, 'linked')
    symlinkSync(real, linkDir)
    AP.stampProjectTrustForDir(dotPath(), linkDir)
    const data = JSON.parse(readFileSync(dotPath(), 'utf-8'))
    // realpathSync also resolves the tmpdir prefix (/var -> /private/var on
    // macOS), so compare against the resolved value rather than `real`.
    expect(Object.keys(data.projects).sort()).toEqual([linkDir, realpathSync(linkDir)].sort())
    expect(Object.keys(data.projects)).toHaveLength(2)
  })

  it('tolerates a project dir that does not resolve', () => {
    const missing = join(H.agentsRoot, 'never-created')
    expect(AP.stampProjectTrustForDir(dotPath(), missing)).toBe(true)
    const data = JSON.parse(readFileSync(dotPath(), 'utf-8'))
    expect(Object.keys(data.projects)).toEqual([missing])
  })

  it('preserves existing per-project keys and a prior seen count', () => {
    const projectDir = join(H.agentsRoot, 'zara')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(dotPath(), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [projectDir]: { allowedTools: ['x'], projectOnboardingSeenCount: 7 } },
    }))
    expect(AP.stampProjectTrustForDir(dotPath(), projectDir)).toBe(true)
    const entry = JSON.parse(readFileSync(dotPath(), 'utf-8')).projects[projectDir]
    expect(entry.allowedTools).toEqual(['x'])
    expect(entry.projectOnboardingSeenCount).toBe(7)
  })

  it('replaces a non-object projects map', () => {
    const projectDir = join(H.agentsRoot, 'zara')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(dotPath(), JSON.stringify({ projects: ['bogus'] }))
    expect(AP.stampProjectTrustForDir(dotPath(), projectDir)).toBe(true)
    expect(JSON.parse(readFileSync(dotPath(), 'utf-8')).projects[projectDir].hasTrustDialogAccepted).toBe(true)
  })

  it('replaces a non-object per-project entry', () => {
    const projectDir = join(H.agentsRoot, 'zara')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(dotPath(), JSON.stringify({ projects: { [projectDir]: 'nope' } }))
    expect(AP.stampProjectTrustForDir(dotPath(), projectDir)).toBe(true)
    expect(JSON.parse(readFileSync(dotPath(), 'utf-8')).projects[projectDir].hasTrustDialogAccepted).toBe(true)
  })

  it('returns false and writes nothing when everything is already stamped', () => {
    const projectDir = join(H.agentsRoot, 'zara')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(dotPath(), JSON.stringify({
      hasCompletedOnboarding: true,
      projects: {
        [projectDir]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
        [realpathSync(projectDir)]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true },
      },
    }))
    const before = readFileSync(dotPath(), 'utf-8')
    expect(AP.stampProjectTrustForDir(dotPath(), projectDir)).toBe(false)
    expect(readFileSync(dotPath(), 'utf-8')).toBe(before)
  })

  it('returns false on an unparseable file', () => {
    writeFileSync(dotPath(), '<<<')
    expect(AP.stampProjectTrustForDir(dotPath(), join(H.agentsRoot, 'zara'))).toBe(false)
    expect(H.logs.some((l) => String(l.msg).includes('could not stamp trust flags'))).toBe(true)
  })
})

describe('stampFableOverageConsent', () => {
  const dotPath = (): string => join(H.home, '.claude.json')

  it('returns false when the file does not exist', () => {
    expect(AP.stampFableOverageConsent(dotPath())).toBe(false)
  })

  it('returns false on an unparseable file', () => {
    writeFileSync(dotPath(), 'nope')
    expect(AP.stampFableOverageConsent(dotPath())).toBe(false)
    expect(H.logs.some((l) => String(l.msg).includes('could not stamp consent'))).toBe(true)
  })

  it('keys the consent on the organization uuid', () => {
    writeFileSync(dotPath(), JSON.stringify({ oauthAccount: { organizationUuid: 'org-1', accountUuid: 'acct-1' } }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(true)
    expect(JSON.parse(readFileSync(dotPath(), 'utf-8')).fableOverageConsentV2).toEqual({ 'org-1': true })
  })

  it('falls back to acct:<accountUuid> for an org-less account', () => {
    writeFileSync(dotPath(), JSON.stringify({ oauthAccount: { accountUuid: 'acct-9' } }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(true)
    expect(JSON.parse(readFileSync(dotPath(), 'utf-8')).fableOverageConsentV2).toEqual({ 'acct:acct-9': true })
  })

  it('ignores empty-string uuids', () => {
    writeFileSync(dotPath(), JSON.stringify({ oauthAccount: { organizationUuid: '', accountUuid: '' } }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(false)
  })

  it('leaves a config root that has never authenticated alone', () => {
    writeFileSync(dotPath(), JSON.stringify({ hasCompletedOnboarding: true }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(false)
  })

  it('ignores a non-object oauthAccount', () => {
    writeFileSync(dotPath(), JSON.stringify({ oauthAccount: ['x'] }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(false)
  })

  it('merges into an existing consent map', () => {
    writeFileSync(dotPath(), JSON.stringify({
      oauthAccount: { organizationUuid: 'org-2' },
      fableOverageConsentV2: { 'org-old': true },
    }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(true)
    expect(JSON.parse(readFileSync(dotPath(), 'utf-8')).fableOverageConsentV2)
      .toEqual({ 'org-old': true, 'org-2': true })
  })

  it('replaces a non-object consent map', () => {
    writeFileSync(dotPath(), JSON.stringify({
      oauthAccount: { organizationUuid: 'org-3' },
      fableOverageConsentV2: ['bad'],
    }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(true)
    expect(JSON.parse(readFileSync(dotPath(), 'utf-8')).fableOverageConsentV2).toEqual({ 'org-3': true })
  })

  it('is a no-op when the consent is already recorded', () => {
    writeFileSync(dotPath(), JSON.stringify({
      oauthAccount: { organizationUuid: 'org-4' },
      fableOverageConsentV2: { 'org-4': true },
    }))
    expect(AP.stampFableOverageConsent(dotPath())).toBe(false)
  })
})

describe('stampFableOverageConsentSharedRoots', () => {
  function seedRoot(dir: string, org: string): string {
    mkdirSync(dir, { recursive: true })
    const p = join(dir, '.claude.json')
    writeFileSync(p, JSON.stringify({ oauthAccount: { organizationUuid: org } }))
    return p
  }

  it('stamps the shared home root and both worker roots', () => {
    H.getEffectiveSettingValue.mockReturnValue('0')
    const home = seedRoot(H.home, 'org-home')
    const w1 = seedRoot(join(H.home, '.marveen-worker', '.claude-config'), 'org-w1')
    const w2 = seedRoot(join(H.home, '.marveen-worker-fast', '.claude-config'), 'org-w2')
    delete process.env.MARVEEN_WORKER_DIR
    delete process.env.MARVEEN_WORKER_DIR_FAST

    AP.stampFableOverageConsentSharedRoots()

    for (const [p, org] of [[home, 'org-home'], [w1, 'org-w1'], [w2, 'org-w2']] as const) {
      expect(JSON.parse(readFileSync(p, 'utf-8')).fableOverageConsentV2).toEqual({ [org]: true })
    }
  })

  it('honours the MARVEEN_WORKER_DIR overrides and skips absent roots', () => {
    H.getEffectiveSettingValue.mockReturnValue('0')
    const customRoot = join(H.home, 'custom-worker')
    const p = seedRoot(join(customRoot, '.claude-config'), 'org-custom')
    process.env.MARVEEN_WORKER_DIR = customRoot
    process.env.MARVEEN_WORKER_DIR_FAST = join(H.home, 'does-not-exist')

    AP.stampFableOverageConsentSharedRoots()
    expect(JSON.parse(readFileSync(p, 'utf-8')).fableOverageConsentV2).toEqual({ 'org-custom': true })
    delete process.env.MARVEEN_WORKER_DIR
    delete process.env.MARVEEN_WORKER_DIR_FAST
  })

  it('includes the main agent isolated config root when that is enabled', () => {
    H.getEffectiveSettingValue.mockReturnValue('1')
    writeFleetToken()
    seedSharedClaude({ settings: {} })
    writeFileSync(join(H.home, '.claude.json'), JSON.stringify({ oauthAccount: { organizationUuid: 'org-main' } }))

    AP.stampFableOverageConsentSharedRoots()

    const isolated = join(H.projectRoot, '.channels-config', '.claude.json')
    expect(JSON.parse(readFileSync(isolated, 'utf-8')).fableOverageConsentV2).toEqual({ 'org-main': true })
  })
})

// ===========================================================================
// tmux plumbing: run state, session queries
// ===========================================================================

describe('agentRunState', () => {
  it('is running when the session is listed locally', () => {
    H.execFileSync.mockReturnValue('agent-zara\nother\n')
    expect(AP.agentRunState('zara')).toBe('running')
    expect(calls()[0].file).toBe('/usr/bin/tmux')
    expect(calls()[0].args).toEqual(['list-sessions', '-F', '#{session_name}'])
  })

  it('is stopped when the session is absent from the list', () => {
    H.execFileSync.mockReturnValue('other\n')
    expect(AP.agentRunState('zara')).toBe('stopped')
  })

  it('routes through ssh for a remote agent and sets the longer timeout', () => {
    H.readAgentRemoteHost.mockReturnValue('laptop')
    H.execFileSync.mockReturnValue('agent-zara\n')
    expect(AP.agentRunState('zara')).toBe('running')
    expect(H.ensureControlDir).toHaveBeenCalled()
    expect(calls()[0].file).toBe('ssh')
    expect(H.execFileSync.mock.calls[0][2]).toMatchObject({ timeout: 8000 })
  })

  it('reads a local probe failure as stopped', () => {
    H.execFileSync.mockImplementation(() => { throw Object.assign(new Error('no server'), { status: 1 }) })
    expect(AP.agentRunState('zara')).toBe('stopped')
  })

  it('reads a remote non-255 exit as stopped (reachable host, no tmux server)', () => {
    H.readAgentRemoteHost.mockReturnValue('laptop')
    H.execFileSync.mockImplementation(() => { throw Object.assign(new Error('no server'), { status: 1 }) })
    expect(AP.agentRunState('zara')).toBe('stopped')
  })

  it('reads a remote ssh transport failure as unreachable', () => {
    H.readAgentRemoteHost.mockReturnValue('laptop')
    H.execFileSync.mockImplementation(() => { throw Object.assign(new Error('ssh'), { status: 255 }) })
    expect(AP.agentRunState('zara')).toBe('unreachable')
  })

  it('reads a remote throw without an exit status as unreachable', () => {
    H.readAgentRemoteHost.mockReturnValue('laptop')
    H.execFileSync.mockImplementation(() => { throw new Error('killed') })
    expect(AP.agentRunState('zara')).toBe('unreachable')
  })

  it('tolerates a non-object thrown value', () => {
    H.readAgentRemoteHost.mockReturnValue('laptop')
    H.execFileSync.mockImplementation(() => { throw 'string failure' })
    expect(AP.agentRunState('zara')).toBe('unreachable')
  })
})

describe('isAgentRunning', () => {
  it('is true only for the running state', () => {
    H.execFileSync.mockReturnValue('agent-zara\n')
    expect(AP.isAgentRunning('zara')).toBe(true)
    H.execFileSync.mockReturnValue('')
    expect(AP.isAgentRunning('zara')).toBe(false)
  })
})

describe('sessionExistsOnHost', () => {
  it('is true when the session is listed', () => {
    H.execFileSync.mockReturnValue('marveen-channels\n')
    expect(AP.sessionExistsOnHost(null, 'marveen-channels')).toBe(true)
  })
  it('is false when the query fails', () => {
    H.execFileSync.mockImplementation(() => { throw new Error('nope') })
    expect(AP.sessionExistsOnHost('laptop', 'agent-x')).toBe(false)
  })
})

describe('getAgentRunningSince', () => {
  it('returns the parsed session_created timestamp', () => {
    H.execFileSync.mockReturnValue(' 1750000000 \n')
    expect(AP.getAgentRunningSince('zara')).toBe(1750000000)
    expect(calls()[0].args).toEqual(['display-message', '-p', '-t', 'agent-zara', '#{session_created}'])
  })
  it('returns null for unparseable output', () => {
    H.execFileSync.mockReturnValue('not-a-number')
    expect(AP.getAgentRunningSince('zara')).toBeNull()
  })
  it('returns null when the query throws', () => {
    H.execFileSync.mockImplementation(() => { throw new Error('no session') })
    expect(AP.getAgentRunningSince('zara')).toBeNull()
  })
})

describe('agentHasChannel / resolveAgentProvider', () => {
  it('is true when the agent has its own provider token', () => {
    H.readChannelToken.mockReturnValue('tok')
    expect(AP.agentHasChannel('zara')).toBe(true)
    expect(H.channelStateDir).toHaveBeenCalledWith('telegram', join(H.agentsRoot, 'zara'))
  })

  it('falls back to the legacy telegram token lookup', () => {
    H.readChannelToken.mockReturnValue(null)
    H.parseTelegramToken.mockReturnValue('legacy-tok')
    expect(AP.agentHasChannel('zara')).toBe(true)
  })

  it('is false for a token-less telegram agent', () => {
    H.readChannelToken.mockReturnValue(null)
    H.parseTelegramToken.mockReturnValue(null)
    expect(AP.agentHasChannel('zara')).toBe(false)
  })

  it('is false for a token-less non-telegram agent (no legacy fallback)', () => {
    H.readAgentChannelProvider.mockReturnValue('slack')
    H.readChannelToken.mockReturnValue(null)
    expect(AP.agentHasChannel('zara')).toBe(false)
    expect(H.parseTelegramToken).not.toHaveBeenCalled()
  })

  it.each(['slack', 'telegram', 'discord', 'googlechat', 'teams'])(
    'honours the explicit per-agent provider %s',
    (provider) => {
      H.readAgentChannelProvider.mockReturnValue(provider)
      H.readChannelToken.mockReturnValue('tok')
      AP.agentHasChannel('zara')
      expect(H.channelStateDir).toHaveBeenCalledWith(provider, join(H.agentsRoot, 'zara'))
    },
  )

  it('falls back to the global CHANNEL_PROVIDER for an unrecognised value', () => {
    H.channelProvider = 'slack'
    H.readAgentChannelProvider.mockReturnValue('carrier-pigeon')
    H.readChannelToken.mockReturnValue('tok')
    AP.agentHasChannel('zara')
    expect(H.channelStateDir).toHaveBeenCalledWith('slack', join(H.agentsRoot, 'zara'))
  })
})

describe('getAgentProcessInfo', () => {
  it('reports the session name when running', () => {
    H.execFileSync.mockReturnValue('agent-zara\n')
    expect(AP.getAgentProcessInfo('zara')).toEqual({ running: true, session: 'agent-zara' })
  })
  it('omits the session when stopped', () => {
    H.execFileSync.mockReturnValue('')
    expect(AP.getAgentProcessInfo('zara')).toEqual({ running: false })
  })
})

describe('stopAgentProcess', () => {
  it('refuses when the agent is not running', () => {
    H.execFileSync.mockReturnValue('')
    expect(AP.stopAgentProcess('zara')).toEqual({ ok: false, error: 'Agent is not running' })
  })

  it('kills the session, sleeps, and reaps local orphan pollers', () => {
    H.execFileSync.mockReturnValue('agent-zara\n')
    expect(AP.stopAgentProcess('zara')).toEqual({ ok: true })
    expect(argvStrings().some((s) => s.includes('kill-session -t agent-zara'))).toBe(true)
    expect(H.execSync).toHaveBeenCalledWith('sleep 2', { timeout: 4000 })
    expect(H.reapChannelOrphans).toHaveBeenCalledWith('telegram', join(H.agentsRoot, 'zara'))
  })

  it('warns but still succeeds when the post-stop reap throws', () => {
    H.execFileSync.mockReturnValue('agent-zara\n')
    H.reapChannelOrphans.mockImplementation(() => { throw new Error('pkill failed') })
    expect(AP.stopAgentProcess('zara')).toEqual({ ok: true })
    expect(H.logs.some((l) => String(l.msg).includes('post-stop channel-poller reap failed'))).toBe(true)
  })

  it('skips the local reap for a remote agent', () => {
    H.readAgentRemoteHost.mockReturnValue('laptop')
    H.execFileSync.mockReturnValue('agent-zara\n')
    expect(AP.stopAgentProcess('zara')).toEqual({ ok: true })
    expect(H.reapChannelOrphans).not.toHaveBeenCalled()
  })

  it('reports failure when kill-session throws', () => {
    let first = true
    H.execFileSync.mockImplementation(() => {
      if (first) { first = false; return 'agent-zara\n' }
      throw new Error('tmux exploded')
    })
    expect(AP.stopAgentProcess('zara')).toEqual({ ok: false, error: 'Failed to stop tmux session' })
  })
})

describe('restartAgentProcess', () => {
  it('stops first when running, then starts', () => {
    // list-sessions says running for the guard + the stop, then empty so the
    // start's own already-running check passes.
    const outs = ['agent-zara\n', 'agent-zara\n', '', '']
    H.execFileSync.mockImplementation(() => outs.shift() ?? '')
    mkdirSync(join(H.agentsRoot, 'zara'), { recursive: true })
    expect(AP.restartAgentProcess('zara')).toEqual({ ok: true })
  })

  it('aborts when the stop fails', () => {
    let call = 0
    H.execFileSync.mockImplementation(() => {
      call++
      if (call <= 2) return 'agent-zara\n'
      throw new Error('cannot kill')
    })
    expect(AP.restartAgentProcess('zara')).toEqual({ ok: false, error: 'Failed to stop tmux session' })
  })

  it('starts directly when the agent is not running', () => {
    H.execFileSync.mockReturnValue('')
    expect(AP.restartAgentProcess('ghost')).toEqual({ ok: false, error: 'Agent not found' })
  })
})

// ===========================================================================
// startAgentProcess -- local launch
// ===========================================================================

/** The shell command handed to `tmux new-session -d -s <session> <cmd>`. */
function launchCmd(): string {
  const c = calls().find((x) => x.args[0] === 'new-session')
  if (!c) throw new Error('no new-session call recorded')
  return c.args[4]
}

/** Create an agent dir (with the settings.json the scoping step rewrites). */
function setupLocalAgent(name = 'zara'): string {
  const dir = join(H.agentsRoot, name)
  mkdirSync(join(dir, '.claude'), { recursive: true })
  writeFileSync(join(dir, '.claude', 'settings.json'), JSON.stringify({ enabledPlugins: { keep: true } }))
  return dir
}

describe('startAgentProcess -- guards', () => {
  it('refuses an unknown agent', () => {
    expect(AP.startAgentProcess('ghost')).toEqual({ ok: false, error: 'Agent not found' })
  })

  it('refuses when the agent is already running', () => {
    setupLocalAgent()
    H.execFileSync.mockReturnValue('agent-zara\n')
    expect(AP.startAgentProcess('zara')).toEqual({ ok: false, error: 'Agent is already running' })
  })

  it('provisions the memory boundary only when the agent opts in', () => {
    setupLocalAgent()
    AP.startAgentProcess('zara')
    expect(H.provisionMemoryBoundaryDir).not.toHaveBeenCalled()

    vi.clearAllMocks()
    H.execFileSync.mockReturnValue('')
    H.readAgentMemoryIsolation.mockReturnValue(true)
    H.readAgentModel.mockReturnValue('claude-opus-4-8')
    H.loadProfileTemplate.mockReturnValue({ permissionMode: 'permissive' })
    H.resolveAgentConfigDir.mockReturnValue({ configDir: null, planUnresolved: false })
    H.getProvider.mockImplementation((t: string) => ({ type: t, pluginId: `${t}@mkt` }))
    H.channelStateDir.mockImplementation((_p: string, dir: string) => join(dir, '.channel'))
    AP.startAgentProcess('zara')
    expect(H.provisionMemoryBoundaryDir).toHaveBeenCalledWith(join(H.agentsRoot, 'zara'))
  })

  it('runs the credentials guard and the shared-onboarding re-seed before launch', () => {
    setupLocalAgent()
    AP.startAgentProcess('zara')
    expect(H.renameSharedCredentialsIfSafe).toHaveBeenCalledWith('/usr/bin/claude')
    expect(JSON.parse(readFileSync(join(H.home, '.claude.json'), 'utf-8')).hasCompletedOnboarding).toBe(true)
  })

  it('kills any stale session and reaps orphan pollers before spawning', () => {
    setupLocalAgent()
    expect(AP.startAgentProcess('zara')).toEqual({ ok: true })
    expect(argvStrings().some((s) => s.includes('kill-session -t agent-zara'))).toBe(true)
    expect(H.execSync).toHaveBeenCalledWith('sleep 3', { timeout: 5000 })
    expect(H.reapChannelOrphans).toHaveBeenCalled()
    expect(H.reapDetachedChannelClaudes).toHaveBeenCalledWith({ tmuxPath: '/usr/bin/tmux' })
  })

  it('continues when the pre-launch kill-session fails', () => {
    setupLocalAgent()
    H.execSync.mockImplementation(() => { throw new Error('no such session') })
    expect(AP.startAgentProcess('zara')).toEqual({ ok: true })
  })

  it('warns and continues when either pre-launch reap throws', () => {
    setupLocalAgent()
    H.reapChannelOrphans.mockImplementation(() => { throw new Error('reap 1') })
    H.reapDetachedChannelClaudes.mockImplementation(() => { throw new Error('reap 2') })
    expect(AP.startAgentProcess('zara')).toEqual({ ok: true })
    expect(H.logs.some((l) => String(l.msg).includes('pre-launch channel-poller reap failed'))).toBe(true)
    expect(H.logs.some((l) => String(l.msg).includes('pre-launch detached-claude reap failed'))).toBe(true)
  })

  it('reports failure when the tmux new-session spawn throws', () => {
    setupLocalAgent()
    let n = 0
    H.execFileSync.mockImplementation((_f: string, args: string[]) => {
      n++
      if (args[0] === 'new-session') throw new Error('tmux down')
      return ''
    })
    expect(AP.startAgentProcess('zara')).toEqual({ ok: false, error: 'Failed to start tmux session' })
    expect(n).toBeGreaterThan(0)
    expect(H.logs.some((l) => l.level === 'error' && String(l.msg).includes('Failed to start agent tmux session'))).toBe(true)
  })
})

describe('startAgentProcess -- model/auth env', () => {
  beforeEach(() => { setupLocalAgent() })

  it('emits no BYO-endpoint exports for a Claude model on OAuth', () => {
    AP.startAgentProcess('zara')
    const cmd = launchCmd()
    expect(cmd).not.toContain('ANTHROPIC_BASE_URL')
    expect(cmd).not.toContain('ANTHROPIC_API_KEY')
    expect(cmd).toContain("--model 'claude-opus-4-8'")
  })

  it('exports the per-agent API key in authMode=api', () => {
    H.readAgentAuthMode.mockReturnValue('api')
    H.getSecret.mockImplementation((k: string) => (k === 'agent-zara-api-key' ? 'sk-agent' : null))
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain('export ANTHROPIC_API_KEY="sk-agent" &&')
  })

  it('emits no API key export when the vault entry is missing', () => {
    H.readAgentAuthMode.mockReturnValue('api')
    H.getSecret.mockReturnValue(null)
    AP.startAgentProcess('zara')
    expect(launchCmd()).not.toContain('ANTHROPIC_API_KEY')
  })

  // Stale third-party ids from before the DeepSeek/OpenRouter removal. These
  // never reached the Ollama branch back then ('/' was the OpenRouter
  // discriminator), so routing them there now would 404 opaquely upstream.
  it.each([
    'deepseek-v4-pro',
    'deepseek/deepseek-chat-v3.1',
    'openrouter-auto:tier1',
    'qwen/qwen3-max',
  ])('refuses to launch a stale third-party model id (%s)', (stale) => {
    H.readAgentModel.mockReturnValue(stale)
    const result = AP.startAgentProcess('zara')
    expect(result.ok).toBe(false)
    expect(result.error).toContain(stale)
    expect(calls().some((c) => c.args[0] === 'new-session')).toBe(false)
  })

  it('routes a bare tag (no slash) at the local Ollama endpoint', () => {
    H.readAgentModel.mockReturnValue('qwen3.6:27b')
    AP.startAgentProcess('zara')
    const cmd = launchCmd()
    expect(cmd).toContain('export ANTHROPIC_AUTH_TOKEN=ollama')
    expect(cmd).toContain(`export ANTHROPIC_BASE_URL=${H.ollamaUrl}`)
    expect(cmd).toContain("export ANTHROPIC_MODEL='qwen3.6:27b'")
  })

  it('drops the skip-permissions flag for a strict security profile', () => {
    H.loadProfileTemplate.mockReturnValue({ permissionMode: 'strict' })
    AP.startAgentProcess('zara')
    expect(launchCmd()).not.toContain('--dangerously-skip-permissions')
  })

  it('keeps the skip-permissions flag for a permissive profile', () => {
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain('--dangerously-skip-permissions')
  })
})

describe('startAgentProcess -- config dir and fleet OAuth', () => {
  beforeEach(() => { setupLocalAgent() })

  it('uses the resolved claude-plan config dir and skips isolation', () => {
    H.resolveAgentConfigDir.mockReturnValue({ configDir: '/plan/cfg', planUnresolved: false })
    writeFleetToken()
    seedSharedClaude({ settings: {} })
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain('export CLAUDE_CONFIG_DIR="/plan/cfg" &&')
    expect(existsSync(join(H.agentsRoot, 'zara', '.claude-config'))).toBe(false)
  })

  it('warns when a configured claude plan no longer resolves', () => {
    H.resolveAgentConfigDir.mockReturnValue({ configDir: null, planUnresolved: true })
    H.readAgentClaudePlan.mockReturnValue('gone-plan')
    AP.startAgentProcess('zara')
    expect(H.logs.some((l) => String(l.msg).includes('does not resolve in store/claude-plans.json'))).toBe(true)
  })

  it('provisions an isolated config dir for a Claude-OAuth agent when the fleet token exists', () => {
    writeFleetToken()
    seedSharedClaude({ settings: {} })
    AP.startAgentProcess('zara')
    const cfg = join(H.agentsRoot, 'zara', '.claude-config')
    const cmd = launchCmd()
    expect(cmd).toContain(`export CLAUDE_CONFIG_DIR="${cfg}" &&`)
    expect(cmd).toContain(`export CLAUDE_CODE_OAUTH_TOKEN="$(cat '${AP.FLEET_OAUTH_TOKEN_PATH}')" &&`)
    // trust + consent stamps land in the ISOLATED root, not the shared one
    expect(existsSync(join(cfg, '.claude.json'))).toBe(true)
  })

  it('keeps the shared root when provisioning is impossible, still exporting the token', () => {
    writeFleetToken()
    // no shared ~/.claude -> provisionIsolatedConfigDir returns null
    AP.startAgentProcess('zara')
    const cmd = launchCmd()
    expect(cmd).not.toContain('CLAUDE_CONFIG_DIR')
    expect(cmd).toContain('export CLAUDE_CODE_OAUTH_TOKEN=')
    expect(JSON.parse(readFileSync(join(H.home, '.claude.json'), 'utf-8')).projects).toBeDefined()
  })

  it('keeps the shared root and warns when there is no fleet OAuth token', () => {
    removeFleetToken()
    AP.startAgentProcess('zara')
    expect(launchCmd()).not.toContain('CLAUDE_CODE_OAUTH_TOKEN')
    expect(H.logs.some((l) => String(l.msg).includes('no fleet OAuth token'))).toBe(true)
  })

  it('skips isolation entirely for a BYO-endpoint (Ollama) channel-less agent', () => {
    writeFleetToken()
    seedSharedClaude({ settings: {} })
    H.readAgentModel.mockReturnValue('qwen3.6:27b')
    AP.startAgentProcess('zara')
    expect(launchCmd()).not.toContain('CLAUDE_CONFIG_DIR')
    // the shared-home token export still applies
    expect(launchCmd()).toContain('CLAUDE_CODE_OAUTH_TOKEN')
  })

  it('skips isolation and plugin scoping for the main agent', () => {
    setupLocalAgent('marveen')
    writeFleetToken()
    seedSharedClaude({ settings: {} })
    AP.startAgentProcess('marveen')
    expect(launchCmd()).not.toContain('CLAUDE_CONFIG_DIR')
    expect(existsSync(join(H.agentsRoot, 'marveen', '.claude-config'))).toBe(false)
    // settings.json left exactly as written
    const s = JSON.parse(readFileSync(join(H.agentsRoot, 'marveen', '.claude', 'settings.json'), 'utf-8'))
    expect(s).toEqual({ enabledPlugins: { keep: true } })
  })
})

describe('startAgentProcess -- channel wiring', () => {
  function channelAgent(provider = 'telegram'): void {
    setupLocalAgent()
    H.readAgentChannelProvider.mockReturnValue(provider)
    H.readChannelToken.mockReturnValue('bot-token')
  }

  it.each([
    ['telegram', 'TELEGRAM_STATE_DIR'],
    ['slack', 'SLACK_STATE_DIR'],
    ['discord', 'DISCORD_STATE_DIR'],
    ['googlechat', 'GOOGLECHAT_STATE_DIR'],
    ['teams', 'TEAMS_STATE_DIR'],
  ])('exports %s state via %s', (provider, envVar) => {
    channelAgent(provider)
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain(`export ${envVar}="${join(H.agentsRoot, 'zara', '.channel')}"`)
  })

  it('adds the slack audit log export only for slack', () => {
    channelAgent('slack')
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain(`export SLACK_AUDIT_LOG="${join(H.agentsRoot, 'zara', '.channel')}/audit.jsonl"`)
  })

  it('passes --channels with the provider plugin id and raises the MCP batch limits', () => {
    channelAgent('telegram')
    AP.startAgentProcess('zara')
    const cmd = launchCmd()
    expect(cmd).toContain('--channels plugin:telegram@marketplace')
    expect(cmd).toContain('export MCP_SERVER_CONNECTION_BATCH_SIZE=10')
    expect(cmd).toContain('export MCP_CONNECTION_NONBLOCKING=1')
    expect(cmd).toContain('export MCP_TIMEOUT=60000')
  })

  it('emits no channel setup for a channel-less agent', () => {
    setupLocalAgent()
    AP.startAgentProcess('zara')
    const cmd = launchCmd()
    expect(cmd).not.toContain('--channels')
    expect(cmd).not.toContain('MCP_SERVER_CONNECTION_BATCH_SIZE')
    expect(cmd).not.toContain('STATE_DIR')
  })

  it('accepts the legacy telegram token as a channel', () => {
    setupLocalAgent()
    H.readChannelToken.mockReturnValue(null)
    H.parseTelegramToken.mockReturnValue('legacy')
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain('--channels plugin:telegram@marketplace')
  })

  it('schedules the post-respawn plugin unlock for a channel sub-agent', () => {
    channelAgent('telegram')
    AP.startAgentProcess('zara')
    expect(H.schedulePluginUnlockAfterRespawn).toHaveBeenCalledWith('agent-zara', 'telegram')
  })

  it('does not schedule the unlock probe for a channel-less agent', () => {
    setupLocalAgent()
    AP.startAgentProcess('zara')
    expect(H.schedulePluginUnlockAfterRespawn).not.toHaveBeenCalled()
  })

  it('does not schedule the unlock probe for the main agent', () => {
    setupLocalAgent('marveen')
    H.readChannelToken.mockReturnValue('bot-token')
    AP.startAgentProcess('marveen')
    expect(H.schedulePluginUnlockAfterRespawn).not.toHaveBeenCalled()
  })

  it('scopes the sub-agent settings.json to its own plugin when it owns a token', () => {
    channelAgent('slack')
    AP.startAgentProcess('zara')
    const s = JSON.parse(readFileSync(join(H.agentsRoot, 'zara', '.claude', 'settings.json'), 'utf-8'))
    expect(s.keep).toBeUndefined()
    expect(s.enabledPlugins.keep).toBe(true)
    expect(s.enabledPlugins[AP.CHANNEL_PLUGIN_IDS.slack]).toBe(true)
    expect(s.enabledPlugins[AP.CHANNEL_PLUGIN_IDS.telegram]).toBe(false)
  })

  it('disables every channel plugin for a sub-agent with only a legacy token', () => {
    setupLocalAgent()
    H.readChannelToken.mockReturnValue(null)
    H.parseTelegramToken.mockReturnValue('legacy')
    AP.startAgentProcess('zara')
    const s = JSON.parse(readFileSync(join(H.agentsRoot, 'zara', '.claude', 'settings.json'), 'utf-8'))
    for (const id of Object.values(AP.CHANNEL_PLUGIN_IDS)) expect(s.enabledPlugins[id]).toBe(false)
  })

  it('warns when the sub-agent settings.json cannot be read', () => {
    const dir = join(H.agentsRoot, 'zara')
    mkdirSync(dir, { recursive: true })
    AP.startAgentProcess('zara')
    expect(H.logs.some((l) => String(l.msg).includes('Could not scope channel plugins'))).toBe(true)
  })
})

describe('startAgentProcess -- teams display-name sync', () => {
  beforeEach(() => {
    setupLocalAgent()
    H.readAgentChannelProvider.mockReturnValue('teams')
    H.readChannelToken.mockReturnValue('teams-token')
    mkdirSync(join(H.agentsRoot, 'zara', '.channel'), { recursive: true })
  })
  const envPath = (): string => join(H.agentsRoot, 'zara', '.channel', '.env')

  it('appends the display name to an .env that lacks it', () => {
    writeFileSync(envPath(), 'TEAMS_APP_ID=abc\n')
    AP.startAgentProcess('zara')
    expect(readFileSync(envPath(), 'utf-8')).toBe('TEAMS_APP_ID=abc\nTEAMS_BOT_DISPLAY_NAME=Testy\n')
  })

  it('appends a newline first when the .env does not end with one', () => {
    writeFileSync(envPath(), 'TEAMS_APP_ID=abc')
    AP.startAgentProcess('zara')
    expect(readFileSync(envPath(), 'utf-8')).toBe('TEAMS_APP_ID=abc\nTEAMS_BOT_DISPLAY_NAME=Testy\n')
  })

  it('creates the line when there is no .env at all', () => {
    AP.startAgentProcess('zara')
    expect(readFileSync(envPath(), 'utf-8')).toBe('TEAMS_BOT_DISPLAY_NAME=Testy\n')
  })

  it('rewrites a drifted display name in place', () => {
    writeFileSync(envPath(), 'TEAMS_BOT_DISPLAY_NAME=Old\nX=1\n')
    AP.startAgentProcess('zara')
    expect(readFileSync(envPath(), 'utf-8')).toBe('TEAMS_BOT_DISPLAY_NAME=Testy\nX=1\n')
  })

  it('writes nothing when the name already matches', () => {
    const raw = 'TEAMS_BOT_DISPLAY_NAME=Testy\n'
    writeFileSync(envPath(), raw)
    AP.startAgentProcess('zara')
    expect(readFileSync(envPath(), 'utf-8')).toBe(raw)
  })

  it('skips the sync when the agent has no display name', () => {
    H.readAgentDisplayName.mockReturnValue('')
    writeFileSync(envPath(), 'X=1\n')
    AP.startAgentProcess('zara')
    expect(readFileSync(envPath(), 'utf-8')).toBe('X=1\n')
  })

  it('never blocks the launch when the .env is unreadable', () => {
    mkdirSync(envPath(), { recursive: true })
    expect(AP.startAgentProcess('zara')).toEqual({ ok: true })
  })

  it('skips the sync for a channel-less teams agent', () => {
    H.readChannelToken.mockReturnValue(null)
    H.parseTelegramToken.mockReturnValue(null)
    AP.startAgentProcess('zara')
    expect(existsSync(envPath())).toBe(false)
  })
})

describe('startAgentProcess -- --continue gating', () => {
  it('resumes a channel-less agent that has a prior project dir', () => {
    setupLocalAgent()
    const encoded = join(H.agentsRoot, 'zara').replace(/\//g, '-')
    mkdirSync(join(H.home, '.claude', 'projects', encoded), { recursive: true })
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain('--continue ')
  })

  it('launches fresh when opts.fresh is set', () => {
    setupLocalAgent()
    const encoded = join(H.agentsRoot, 'zara').replace(/\//g, '-')
    mkdirSync(join(H.home, '.claude', 'projects', encoded), { recursive: true })
    AP.startAgentProcess('zara', { fresh: true })
    expect(launchCmd()).not.toContain('--continue')
  })

  it('always launches a channel-having agent fresh (CC 2.1.193 plugin regression)', () => {
    setupLocalAgent()
    H.readChannelToken.mockReturnValue('tok')
    const encoded = join(H.agentsRoot, 'zara').replace(/\//g, '-')
    mkdirSync(join(H.home, '.claude', 'projects', encoded), { recursive: true })
    AP.startAgentProcess('zara')
    expect(launchCmd()).not.toContain('--continue')
  })

  it('launches fresh on a brand-new agent with no project dir', () => {
    setupLocalAgent()
    AP.startAgentProcess('zara')
    expect(launchCmd()).not.toContain('--continue')
  })

  it('probes the isolated projects root when a config dir is in play', () => {
    setupLocalAgent()
    H.resolveAgentConfigDir.mockReturnValue({ configDir: join(H.home, 'plancfg'), planUnresolved: false })
    const encoded = join(H.agentsRoot, 'zara').replace(/\//g, '-')
    mkdirSync(join(H.home, 'plancfg', 'projects', encoded), { recursive: true })
    AP.startAgentProcess('zara')
    expect(launchCmd()).toContain('--continue ')
  })
})

// ===========================================================================
// startAgentProcess -- per-agent .mcp.json tee (SUBAGENT_INBOX_TEE)
// ===========================================================================

describe('startAgentProcess -- telegram mcp.json + inbound tee', () => {
  const dir = (): string => join(H.agentsRoot, 'zara')

  beforeEach(() => {
    setupLocalAgent()
    H.subagentInboxTee = true
    H.readChannelToken.mockReturnValue('bot-token')
  })

  it('writes .mcp.json at the newest cached plugin version and drops --channels', () => {
    const cache = join(H.home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram')
    for (const v of ['0.0.6', '0.0.11', '0.0.9', 'not-a-version']) mkdirSync(join(cache, v), { recursive: true })

    AP.startAgentProcess('zara')

    const mcp = JSON.parse(readFileSync(join(dir(), '.mcp.json'), 'utf-8'))
    const server = mcp.mcpServers['plugin:telegram:telegram']
    expect(server.command).toBe('node')
    expect(server.args[0]).toBe(join(H.projectRoot, 'scripts', 'channel-inbound-tee.mjs'))
    expect(server.args[1]).toBe(join(H.home, '.bun', 'bin', 'bun'))
    expect(server.args).toContain(join(cache, '0.0.9'))
    expect(server.env).toEqual({ TELEGRAM_STATE_DIR: join(dir(), '.channel') })
    // the --channels path is suppressed so only ONE poller exists
    expect(launchCmd()).not.toContain('--channels')
  })

  it('forces every channel plugin off so the marketplace path cannot double-load', () => {
    mkdirSync(join(H.home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.7'), { recursive: true })
    AP.startAgentProcess('zara')
    const s = JSON.parse(readFileSync(join(dir(), '.claude', 'settings.json'), 'utf-8'))
    for (const id of Object.values(AP.CHANNEL_PLUGIN_IDS)) expect(s.enabledPlugins[id]).toBe(false)
  })

  it('falls back to the pinned default version when the cache dir is absent', () => {
    AP.startAgentProcess('zara')
    const mcp = JSON.parse(readFileSync(join(dir(), '.mcp.json'), 'utf-8'))
    expect(mcp.mcpServers['plugin:telegram:telegram'].args).toContain(
      join(H.home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', '0.0.6'),
    )
  })

  it('falls back to the pinned default when no cached dir matches a version', () => {
    mkdirSync(join(H.home, '.claude', 'plugins', 'cache', 'claude-plugins-official', 'telegram', 'latest'), { recursive: true })
    AP.startAgentProcess('zara')
    const mcp = JSON.parse(readFileSync(join(dir(), '.mcp.json'), 'utf-8'))
    expect(mcp.mcpServers['plugin:telegram:telegram'].args.some((a: string) => a.endsWith('/0.0.6'))).toBe(true)
  })

  it('falls back to the --channels flag when the .mcp.json write fails', () => {
    mkdirSync(join(dir(), '.mcp.json'), { recursive: true })
    AP.startAgentProcess('zara')
    expect(H.logs.some((l) => String(l.msg).includes('Could not write mcp.json'))).toBe(true)
    expect(launchCmd()).toContain('--channels plugin:telegram@marketplace')
  })

  it('does not take the tee path for a non-telegram channel agent', () => {
    H.readAgentChannelProvider.mockReturnValue('slack')
    AP.startAgentProcess('zara')
    expect(existsSync(join(dir(), '.mcp.json'))).toBe(false)
    expect(launchCmd()).toContain('--channels plugin:slack@marketplace')
  })

  it('does not take the tee path for the main agent', () => {
    setupLocalAgent('marveen')
    AP.startAgentProcess('marveen')
    expect(existsSync(join(H.agentsRoot, 'marveen', '.mcp.json'))).toBe(false)
  })

  it('does not take the tee path for a channel-less agent', () => {
    H.readChannelToken.mockReturnValue(null)
    H.parseTelegramToken.mockReturnValue(null)
    AP.startAgentProcess('zara')
    expect(existsSync(join(dir(), '.mcp.json'))).toBe(false)
  })
})

// ===========================================================================
// Shared-config collision alert (non-darwin only)
// ===========================================================================

describe('shared ~/.claude plugin-slot collision alert', () => {
  let restorePlatform: (() => void) | null = null

  function forcePlatform(value: NodeJS.Platform): void {
    const original = Object.getOwnPropertyDescriptor(process, 'platform')
    Object.defineProperty(process, 'platform', { value, configurable: true })
    restorePlatform = () => { if (original) Object.defineProperty(process, 'platform', original) }
  }

  afterEach(() => {
    restorePlatform?.()
    restorePlatform = null
  })

  /** Two RUNNING same-provider channel sub-agents, no fleet token. */
  function twoContenders(): void {
    setupLocalAgent('zara')
    removeFleetToken()
    H.listAgentNames.mockReturnValue(['marveen', 'zara', 'boni'])
    H.readChannelToken.mockReturnValue('tok')
    H.execFileSync.mockImplementation((_f: string, args: string[]) =>
      args[0] === 'list-sessions' ? 'agent-boni\n' : '')
  }

  it('raises a loud operator alert once per degradation episode on linux', async () => {
    forcePlatform('linux')
    twoContenders()

    AP.startAgentProcess('zara')
    expect(H.notifyChannel).toHaveBeenCalledTimes(1)
    expect(String(H.notifyChannel.mock.calls[0][0])).toContain('store/.claude-oauth-token')
    expect(H.logs.some((l) => l.level === 'error' && String(l.msg).includes('plugin-slot collision'))).toBe(true)

    // second spawn in the same episode stays silent
    AP.startAgentProcess('zara')
    expect(H.notifyChannel).toHaveBeenCalledTimes(1)
    await flush()
  })

  it('re-arms the alert once the fleet token comes back', () => {
    forcePlatform('linux')
    twoContenders()
    AP.startAgentProcess('zara')
    expect(H.notifyChannel).toHaveBeenCalledTimes(1)

    writeFleetToken()
    seedSharedClaude({ settings: {} })
    AP.startAgentProcess('zara')   // token present -> resets the one-shot latch

    removeFleetToken()
    AP.startAgentProcess('zara')
    expect(H.notifyChannel).toHaveBeenCalledTimes(2)
  })

  it('stays silent for a single contender', () => {
    forcePlatform('linux')
    setupLocalAgent('zara')
    removeFleetToken()
    H.listAgentNames.mockReturnValue(['zara'])
    H.readChannelToken.mockReturnValue('tok')
    AP.startAgentProcess('zara')
    expect(H.notifyChannel).not.toHaveBeenCalled()
  })

  it('stays silent on macOS regardless of contender count', () => {
    forcePlatform('darwin')
    twoContenders()
    AP.startAgentProcess('zara')
    expect(H.notifyChannel).not.toHaveBeenCalled()
  })

  it('never alerts for a channel-less agent (it cannot contend for a slot)', () => {
    forcePlatform('linux')
    setupLocalAgent('zara')
    removeFleetToken()
    H.listAgentNames.mockReturnValue(['zara', 'boni'])
    H.readChannelToken.mockReturnValue(null)
    H.parseTelegramToken.mockReturnValue(null)
    AP.startAgentProcess('zara')
    expect(H.notifyChannel).not.toHaveBeenCalled()
    expect(H.logs.some((l) => String(l.msg).includes('no fleet OAuth token'))).toBe(true)
  })

  it('swallows a notifyChannel rejection', async () => {
    forcePlatform('linux')
    twoContenders()
    H.notifyChannel.mockRejectedValue(new Error('telegram down'))
    expect(() => AP.startAgentProcess('zara')).not.toThrow()
    await flush()
  })
})

// ===========================================================================
// startAgentProcess -- remote (ssh) launch
// ===========================================================================

describe('startRemoteAgentProcess', () => {
  beforeEach(() => {
    mkdirSync(join(H.agentsRoot, 'remoty'), { recursive: true })
    H.readAgentRemoteConfig.mockReturnValue({ host: 'laptop', workdir: '/Users/me/work' })
    H.readAgentRemoteHost.mockReturnValue('laptop')
  })

  it('starts a detached remote tmux session and schedules identity setup', () => {
    H.execFileSync.mockImplementation((_f: string, args: string[]) => {
      if (args.some((a) => a.includes('list-sessions'))) throw Object.assign(new Error('no server'), { status: 1 })
      return ''
    })
    expect(AP.startAgentProcess('remoty')).toEqual({ ok: true })
    const newSession = calls().find((c) => c.args.some((a) => a.includes('new-session')))
    expect(newSession?.file).toBe('ssh')
    // The whole tmux argv rides as ONE shell-quoted ssh argument, so the inner
    // single quotes arrive escaped -- assert on the stable, quote-free pieces.
    const remoteCmd = newSession?.args.join(' ') ?? ''
    expect(remoteCmd).toContain("'agent-remoty'")
    expect(remoteCmd).toContain('/Users/me/work')
    expect(remoteCmd).toContain('claude --continue --dangerously-skip-permissions --model')
    expect(H.cleanStaleSshSockets).toHaveBeenCalledWith('laptop')
  })

  it('refuses when the remote session is already running', () => {
    H.execFileSync.mockReturnValue('agent-remoty\n')
    expect(AP.startAgentProcess('remoty')).toEqual({ ok: false, error: 'Agent is already running' })
  })

  it('refuses on an unreachable host rather than risking a duplicate session', () => {
    H.execFileSync.mockImplementation(() => { throw Object.assign(new Error('ssh'), { status: 255 }) })
    expect(AP.startAgentProcess('remoty')).toEqual({
      ok: false,
      error: "Remote host 'laptop' unreachable -- refusing to start (cannot confirm state)",
    })
  })

  it('pre-flights `which claude` on the laptop', () => {
    H.execFileSync.mockImplementation((_f: string, args: string[]) => {
      if (args.some((a) => a.includes('list-sessions'))) throw Object.assign(new Error('x'), { status: 1 })
      if (args.includes('which claude')) throw new Error('not found')
      return ''
    })
    expect(AP.startAgentProcess('remoty')).toEqual({
      ok: false,
      error: "claude not found on PATH on 'laptop' (or host unreachable)",
    })
  })

  it('omits --continue when the remote session-dir probe fails', () => {
    H.execFileSync.mockImplementation((_f: string, args: string[]) => {
      if (args.some((a) => a.includes('list-sessions'))) throw Object.assign(new Error('x'), { status: 1 })
      if (args.some((a) => a.startsWith('test -d'))) throw new Error('absent')
      return ''
    })
    AP.startAgentProcess('remoty')
    const newSession = calls().find((c) => c.args.some((a) => a.includes('new-session')))
    expect(newSession?.args.join(' ')).not.toContain('--continue')
  })

  it('skips the prior-session probe entirely with opts.fresh', () => {
    H.execFileSync.mockImplementation((_f: string, args: string[]) => {
      if (args.some((a) => a.includes('list-sessions'))) throw Object.assign(new Error('x'), { status: 1 })
      return ''
    })
    AP.startAgentProcess('remoty', { fresh: true })
    expect(argvStrings().some((s) => s.includes('test -d'))).toBe(false)
    const newSession = calls().find((c) => c.args.some((a) => a.includes('new-session')))
    expect(newSession?.args.join(' ')).not.toContain('--continue')
  })

  it('reports failure when the remote new-session throws', () => {
    H.execFileSync.mockImplementation((_f: string, args: string[]) => {
      if (args.some((a) => a.includes('list-sessions'))) throw Object.assign(new Error('x'), { status: 1 })
      if (args.some((a) => a.includes('new-session'))) throw new Error('remote tmux failed')
      return ''
    })
    expect(AP.startAgentProcess('remoty')).toEqual({ ok: false, error: 'Failed to start remote tmux session' })
    expect(H.logs.some((l) => l.level === 'error' && String(l.msg).includes('Failed to start remote agent'))).toBe(true)
  })

  it('does not take the remote path when only a host is configured', () => {
    H.readAgentRemoteConfig.mockReturnValue({ host: 'laptop', workdir: null })
    H.readAgentRemoteHost.mockReturnValue(null)
    setupLocalAgent('remoty')
    AP.startAgentProcess('remoty')
    expect(calls().find((c) => c.args[0] === 'new-session')?.file).toBe('/usr/bin/tmux')
  })
})

// ===========================================================================
// Pane capture helpers
// ===========================================================================

/** Drive successive `capture-pane` results (string = stdout, Error = throw).
 *  The last entry repeats. Every non-capture tmux call returns ''. */
function paneSequence(seq: Array<string | Error>): void {
  let i = 0
  H.execFileSync.mockImplementation((file: string, args: string[]) => {
    const argv = [file, ...args].join(' ')
    if (!argv.includes('capture-pane')) return ''
    const v = seq[Math.min(i, seq.length - 1)]
    i++
    if (v instanceof Error) throw v
    return v
  })
}

/** All send-keys payloads recorded so far. */
function sentKeys(): string[] {
  return calls().filter((c) => c.args[0] === 'send-keys').map((c) => c.args.slice(3).join(' '))
}

describe('capturePane', () => {
  it('returns the pane text', () => {
    paneSequence(['hello pane'])
    expect(AP.capturePane('agent-zara')).toBe('hello pane')
    expect(calls()[0].args).toEqual(['capture-pane', '-t', 'agent-zara', '-p'])
  })
  it('returns null when the capture fails', () => {
    paneSequence([new Error('no session')])
    expect(AP.capturePane('agent-zara')).toBeNull()
  })
  it('routes over ssh for a remote host', () => {
    paneSequence(['x'])
    AP.capturePane('agent-zara', 'laptop')
    expect(calls()[0].file).toBe('ssh')
  })
  // captureTmux timeout default: `host ? 8000 : 3000`. The remote branch is
  // already pinned by the agentRunState suite (ssh timeout=8000). The local
  // branch only takes the 3000ms default when the caller passes no `opts`,
  // which capturePane does (captureTmux wraps it with the default timeout).
  // Pin that here so the `host ? 8000 : 3000` ternary's else arm is covered.
  it('uses the 3000ms default timeout for a local captureTmux (host=null)', () => {
    paneSequence(['x'])
    AP.capturePane('agent-zara')
    expect(H.execFileSync.mock.calls[0][2]).toMatchObject({ timeout: 3000 })
  })
  it('uses the 8000ms default timeout for a remote captureTmux (host=string, no opts)', () => {
    paneSequence(['x'])
    AP.capturePane('agent-zara', 'laptop')
    expect(H.execFileSync.mock.calls[0][2]).toMatchObject({ timeout: 8000 })
  })
})

describe('captureParkedInputView', () => {
  it('captures WITH colour (-e) and strips the dim ghost suggestion', () => {
    paneSequence(['[2mghost[0m real'])
    H.stripGhostSuggestion.mockReturnValue('real')
    expect(AP.captureParkedInputView('agent-zara')).toBe('real')
    expect(calls()[0].args).toEqual(['capture-pane', '-t', 'agent-zara', '-e', '-p'])
  })
  it('returns null when the capture fails', () => {
    paneSequence([new Error('boom')])
    expect(AP.captureParkedInputView('agent-zara')).toBeNull()
  })
})

describe('sendEnterToSession', () => {
  it('sends a bare Enter', () => {
    expect(AP.sendEnterToSession('agent-zara')).toBe(true)
    expect(calls()[0].args).toEqual(['send-keys', '-t', 'agent-zara', 'Enter'])
  })
  it('swallows and reports a tmux failure', () => {
    H.execFileSync.mockImplementation(() => { throw new Error('gone') })
    expect(AP.sendEnterToSession('agent-zara')).toBe(false)
    expect(H.logs.some((l) => String(l.msg).includes('failed to send recovery Enter'))).toBe(true)
  })
})

describe('clearInputBuffer', () => {
  it('sends Ctrl-U', async () => {
    await AP.clearInputBuffer('agent-zara')
    expect(sentKeys()).toEqual(['C-u'])
  })
  it('warns when the keystroke fails', async () => {
    H.execFileSync.mockImplementation(() => { throw new Error('nope') })
    await AP.clearInputBuffer('agent-zara')
    expect(H.logs.some((l) => String(l.msg).includes('Failed to clear pane input buffer'))).toBe(true)
  })
})

// ===========================================================================
// Modal dismissals
// ===========================================================================

describe('dismissResumeSummaryModalIfPresent', () => {
  it('picks option 1 and confirms when the modal is visible', async () => {
    paneSequence(['... Resume from summary ...'])
    await AP.dismissResumeSummaryModalIfPresent('agent-zara')
    expect(sentKeys()).toEqual(['1', 'Enter'])
    expect(H.logs.some((l) => String(l.msg).includes('resume-from-summary modal'))).toBe(true)
  })
  it('does nothing when the modal is absent', async () => {
    paneSequence(['idle pane'])
    await AP.dismissResumeSummaryModalIfPresent('agent-zara')
    expect(sentKeys()).toEqual([])
  })
  it('warns when the probe fails', async () => {
    paneSequence([new Error('capture failed')])
    await AP.dismissResumeSummaryModalIfPresent('agent-zara')
    expect(H.logs.some((l) => String(l.msg).includes('Failed to probe/dismiss resume-from-summary'))).toBe(true)
  })
})

describe('dismissModelConsentDialogIfPresent', () => {
  it('actively selects option 1 -- never the bare Enter that would switch the model', async () => {
    paneSequence(['Fable 5 now uses usage credits'])
    H.detectsModelConsentDialog.mockReturnValue(true)
    await AP.dismissModelConsentDialogIfPresent('agent-zara')
    expect(sentKeys()).toEqual(['1', 'Enter'])
  })
  it('does nothing when the dialog is absent', async () => {
    paneSequence(['idle'])
    await AP.dismissModelConsentDialogIfPresent('agent-zara')
    expect(sentKeys()).toEqual([])
  })
  it('warns when the probe fails', async () => {
    paneSequence([new Error('x')])
    await AP.dismissModelConsentDialogIfPresent('agent-zara')
    expect(H.logs.some((l) => String(l.msg).includes('Failed to probe/answer model usage-credit'))).toBe(true)
  })
})

describe('answerFirstRunGates', () => {
  it('reports unchanged when no gate is on screen', async () => {
    paneSequence(['idle'])
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('unchanged')
    expect(sentKeys()).toEqual([])
  })

  it('reports unchanged when the pane cannot be captured', async () => {
    paneSequence([new Error('x')])
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('unchanged')
  })

  it('never answers the login picker', async () => {
    paneSequence(['Select login method'])
    H.detectsFirstRunGate.mockReturnValue('login')
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('login')
    expect(sentKeys()).toEqual([])
  })

  it('answers the folder-trust dialog with 1 + Enter', async () => {
    paneSequence(['trust?'])
    H.detectsFirstRunGate.mockReturnValueOnce('trust').mockReturnValue(null)
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('cleared')
    expect(sentKeys()).toEqual(['1', 'Enter'])
  })

  it('answers the bypass-permissions dialog with 2 + Enter', async () => {
    paneSequence(['bypass?'])
    H.detectsFirstRunGate.mockReturnValueOnce('bypass-permissions').mockReturnValue(null)
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('cleared')
    expect(sentKeys()).toEqual(['2', 'Enter'])
  })

  it('accepts the theme/welcome default with a bare Enter', async () => {
    paneSequence(['theme?'])
    H.detectsFirstRunGate.mockReturnValueOnce('theme').mockReturnValue(null)
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('cleared')
    expect(sentKeys()).toEqual(['Enter'])
  })

  it('walks a chain of gates and stops at the login picker', async () => {
    paneSequence(['gate'])
    H.detectsFirstRunGate
      .mockReturnValueOnce('trust')
      .mockReturnValueOnce('bypass-permissions')
      .mockReturnValue('login')
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('login')
  })

  it('gives up as unchanged when the very first keystroke fails', async () => {
    H.detectsFirstRunGate.mockReturnValue('theme')
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      if ([file, ...args].join(' ').includes('capture-pane')) return 'gate'
      throw new Error('send failed')
    })
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('unchanged')
    expect(H.logs.some((l) => String(l.msg).includes('answer keystroke failed'))).toBe(true)
  })

  it('reports cleared when a later keystroke fails after an earlier success', async () => {
    let sends = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      if ([file, ...args].join(' ').includes('capture-pane')) return 'gate'
      sends++
      if (sends > 1) throw new Error('send failed')
      return ''
    })
    H.detectsFirstRunGate.mockReturnValue('theme')
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('cleared')
  })

  it('stops after the bounded number of steps when gates keep reappearing', async () => {
    paneSequence(['gate'])
    H.detectsFirstRunGate.mockReturnValue('theme')
    expect(await AP.answerFirstRunGates('agent-zara')).toBe('cleared')
    expect(sentKeys()).toHaveLength(6)
  })
})

// ===========================================================================
// scheduleIdentitySetup
// ===========================================================================

describe('scheduleIdentitySetup', () => {
  it('dismisses the modals, then sends /name', async () => {
    paneSequence(['idle'])
    await AP.scheduleIdentitySetup('agent-zara', 'Zoe')
    await flush()
    expect(sentKeys()).toContain('/name Zoe Enter')
    expect(H.logs.some((l) => String(l.msg).includes('Set session /name'))).toBe(true)
  })

  it('dismisses a survey modal before the identity command', async () => {
    paneSequence(['How is Claude doing this session?'])
    await AP.scheduleIdentitySetup('agent-zara', 'Zoe')
    await flush()
    expect(sentKeys()[0]).toBe('0')
    expect(H.logs.some((l) => String(l.msg).includes('session-rating modal'))).toBe(true)
  })

  it('warns when the survey probe itself fails', async () => {
    paneSequence([new Error('capture down')])
    await AP.scheduleIdentitySetup('agent-zara', 'Zoe')
    await flush()
    expect(H.logs.some((l) => String(l.msg).includes('Failed to probe/dismiss session-rating modal'))).toBe(true)
  })

  it('warns when the /name send fails', async () => {
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      if ([file, ...args].join(' ').includes('capture-pane')) return 'idle'
      throw new Error('send-keys failed')
    })
    await AP.scheduleIdentitySetup('agent-zara', 'Zoe')
    await flush()
    expect(H.logs.some((l) => String(l.msg).includes('Failed to set session /name'))).toBe(true)
  })

  it('threads the host through to every remote keystroke', async () => {
    paneSequence(['idle'])
    await AP.scheduleIdentitySetup('agent-zara', 'Zoe', 'laptop')
    await flush()
    expect(calls().every((c) => c.file === 'ssh')).toBe(true)
  })
})

// ===========================================================================
// waitForPaneIdle
// ===========================================================================

describe('waitForPaneIdle', () => {
  it('returns true as soon as the pane looks idle', async () => {
    paneSequence(['idle'])
    H.paneLooksIdle.mockReturnValue(true)
    expect(await AP.waitForPaneIdle('agent-zara')).toBe(true)
  })

  it('keeps polling until the pane settles', async () => {
    paneSequence(['busy', 'busy', 'idle'])
    H.paneLooksIdle.mockImplementation((p: string) => p === 'idle')
    expect(await AP.waitForPaneIdle('agent-zara')).toBe(true)
  })

  it('treats a capture failure as "not yet idle" and keeps polling', async () => {
    paneSequence([new Error('x'), 'idle'])
    H.paneLooksIdle.mockReturnValue(true)
    expect(await AP.waitForPaneIdle('agent-zara')).toBe(true)
  })

  it('returns false when the budget elapses with a busy pane', async () => {
    paneSequence(['busy'])
    H.paneLooksIdle.mockReturnValue(false)
    expect(await AP.waitForPaneIdle('agent-zara', null, 900)).toBe(false)
  })
})

// ===========================================================================
// isSessionReadyForPrompt
// ===========================================================================

describe('isSessionReadyForPrompt', () => {
  it('requires two agreeing idle samples', async () => {
    paneSequence(['idle', 'idle'])
    expect(await AP.isSessionReadyForPrompt('agent-zara')).toBe(true)
  })

  it('is false when the first capture fails', async () => {
    paneSequence([new Error('x')])
    expect(await AP.isSessionReadyForPrompt('agent-zara')).toBe(false)
  })

  it('is false when the second capture fails', async () => {
    paneSequence(['idle', new Error('x')])
    expect(await AP.isSessionReadyForPrompt('agent-zara')).toBe(false)
  })

  it('refuses a saturated pane on the first sample', async () => {
    paneSequence(['100% context used'])
    H.paneShowsContextSaturation.mockReturnValue(true)
    expect(await AP.isSessionReadyForPrompt('agent-zara')).toBe(false)
    expect(H.logs.some((l) => String(l.msg).includes('context saturation'))).toBe(true)
  })

  it('refuses a pane that saturates between the two samples', async () => {
    paneSequence(['idle', 'saturated'])
    H.paneShowsContextSaturation.mockImplementation((p: string) => p === 'saturated')
    expect(await AP.isSessionReadyForPrompt('agent-zara')).toBe(false)
  })

  it('is false when the first sample is not idle', async () => {
    paneSequence(['busy'])
    H.idleConsideringDimGhost.mockReturnValue(false)
    expect(await AP.isSessionReadyForPrompt('agent-zara')).toBe(false)
  })

  it('is false when the second sample disagrees', async () => {
    paneSequence(['idle', 'busy'])
    H.idleConsideringDimGhost.mockImplementation((p: string) => p === 'idle')
    expect(await AP.isSessionReadyForPrompt('agent-zara')).toBe(false)
  })

  it('pays for the dim-stripped capture only when the plain view reads as typing', async () => {
    paneSequence(['typing-pane'])
    H.detectPaneState.mockReturnValue('typing')
    H.stripGhostSuggestion.mockReturnValue('')
    H.idleConsideringDimGhost.mockReturnValue(true)
    await AP.isSessionReadyForPrompt('agent-zara')
    expect(calls().some((c) => c.args.includes('-e'))).toBe(true)
    expect(H.idleConsideringDimGhost).toHaveBeenCalledWith('typing-pane', '')
  })

  it('skips the dim-stripped capture when the plain view is already idle', async () => {
    paneSequence(['idle', 'idle'])
    H.detectPaneState.mockReturnValue('idle')
    await AP.isSessionReadyForPrompt('agent-zara')
    expect(calls().some((c) => c.args.includes('-e'))).toBe(false)
    expect(H.idleConsideringDimGhost).toHaveBeenCalledWith('idle', null)
  })
})

// ===========================================================================
// sendPromptToSession
// ===========================================================================

/** The literal (`send-keys -l`) chunk payloads, in order. */
function literalChunks(): string[] {
  return calls()
    .filter((c) => c.args[0] === 'send-keys' && c.args[3] === '-l')
    .map((c) => c.args[4])
}

/** Every capture returns `pane`; non-capture calls succeed silently. */
function steadyPane(pane: string): void {
  H.execFileSync.mockImplementation((file: string, args: string[]) =>
    [file, ...args].join(' ').includes('capture-pane') ? pane : '')
}

describe('sendPromptToSession -- delivery', () => {
  beforeEach(() => {
    steadyPane('idle')
    H.paneLooksIdle.mockReturnValue(true)
    H.decideSubmitFollowup.mockReturnValue('done')
  })

  it('streams the text and submits with Enter', async () => {
    expect(await AP.sendPromptToSession('agent-zara', 'hello world')).toBe('sent')
    expect(literalChunks()).toEqual(['hello world'])
    expect(sentKeys().at(-1)).toBe('Enter')
  })

  it('flattens newlines into spaces', async () => {
    await AP.sendPromptToSession('agent-zara', 'line one\r\nline two\nline three')
    expect(literalChunks()).toEqual(['line one line two line three'])
  })

  it('splits long text into 80-character chunks', async () => {
    const text = 'x'.repeat(200)
    await AP.sendPromptToSession('agent-zara', text)
    expect(literalChunks().map((c) => c.length)).toEqual([80, 80, 40])
    expect(literalChunks().join('')).toBe(text)
  })

  it('slides the chunk boundary past a dash so tmux cannot read it as a flag', async () => {
    const text = 'a'.repeat(80) + '-' + 'b'.repeat(30)
    await AP.sendPromptToSession('agent-zara', text)
    const chunks = literalChunks()
    expect(chunks[0]).toBe('a'.repeat(80) + '-')
    expect(chunks[1]).toBe('b'.repeat(30))
    expect(chunks.some((c) => c.startsWith('-'))).toBe(false)
  })

  it('prepends a space when a dash run exceeds the slide cap', async () => {
    const text = 'a'.repeat(80) + '-'.repeat(20) + 'b'
    await AP.sendPromptToSession('agent-zara', text)
    const chunks = literalChunks()
    expect(chunks[0]).toBe('a'.repeat(80) + '-'.repeat(8))
    expect(chunks[1]).toBe(' ' + '-'.repeat(12) + 'b')
  })

  it('dismisses the modals before touching the input box', async () => {
    steadyPane('How is Claude doing this session')
    await AP.sendPromptToSession('agent-zara', 'hi')
    expect(sentKeys()[0]).toBe('0')
  })
})

describe('sendPromptToSession -- idle gate', () => {
  beforeEach(() => { H.decideSubmitFollowup.mockReturnValue('done') })

  it('waits for idle by default and then sends', async () => {
    steadyPane('idle')
    H.paneLooksIdle.mockReturnValue(true)
    expect(await AP.sendPromptToSession('agent-zara', 'hi')).toBe('sent')
  })

  it('sends best-effort with a warn when the pane never idles', async () => {
    steadyPane('busy')
    H.paneLooksIdle.mockReturnValue(false)
    expect(await AP.sendPromptToSession('agent-zara', 'hi', null, { idleTimeoutMs: 600 })).toBe('sent')
    expect(H.logs.some((l) => String(l.msg).includes('sending best-effort'))).toBe(true)
    expect(literalChunks()).toEqual(['hi'])
  })

  it('aborts without any keystroke when the caller opted for abort-on-busy', async () => {
    steadyPane('busy')
    H.paneLooksIdle.mockReturnValue(false)
    const r = await AP.sendPromptToSession('agent-zara', 'hi', null, {
      onBusyTimeout: 'abort', idleTimeoutMs: 600,
    })
    expect(r).toBe('aborted-busy')
    expect(literalChunks()).toEqual([])
    expect(H.logs.some((l) => String(l.msg).includes('aborting per caller policy'))).toBe(true)
  })

  it('skips the idle wait entirely for the forceSend path', async () => {
    steadyPane('busy')
    H.paneLooksIdle.mockReturnValue(false)
    expect(await AP.sendPromptToSession('agent-zara', 'hi', null, { waitForIdle: false })).toBe('sent')
    expect(H.logs.some((l) => String(l.msg).includes('wait-until-idle budget'))).toBe(false)
  })
})

describe('sendPromptToSession -- stale preamble pre-flight', () => {
  beforeEach(() => {
    H.paneLooksIdle.mockReturnValue(true)
    H.decideSubmitFollowup.mockReturnValue('done')
  })

  it('clears the buffer when a truncated preamble is still parked', async () => {
    steadyPane('TEAM MEMBER NOTICE -- trunc')
    H.shouldClearTruncatedPreamble.mockReturnValue(true)
    await AP.sendPromptToSession('agent-zara', 'payload')
    expect(sentKeys()).toContain('C-u')
    expect(H.logs.some((l) => String(l.msg).includes('Cleared stale preamble'))).toBe(true)
  })

  it('leaves a clean buffer alone', async () => {
    steadyPane('idle')
    H.shouldClearTruncatedPreamble.mockReturnValue(false)
    await AP.sendPromptToSession('agent-zara', 'payload')
    expect(sentKeys()).not.toContain('C-u')
  })

  it('proceeds when the pre-send capture fails', async () => {
    // Capture order before the pre-send probe: survey modal, resume-summary
    // modal, model-consent dialog, one waitForPaneIdle poll -- so the 5th
    // capture is the truncated-preamble probe under test.
    let n = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [file, ...args].join(' ')
      if (!argv.includes('capture-pane')) return ''
      n++
      if (n === 5) throw new Error('capture died')
      return 'idle'
    })
    expect(await AP.sendPromptToSession('agent-zara', 'payload')).toBe('sent')
    expect(H.logs.some((l) => String(l.msg).includes('Pre-send capture-pane failed'))).toBe(true)
  })
})

describe('sendPromptToSession -- post-send retry loop', () => {
  beforeEach(() => {
    H.paneLooksIdle.mockReturnValue(true)
    steadyPane('idle')
  })

  it('stops immediately when the prompt landed', async () => {
    H.decideSubmitFollowup.mockReturnValue('done')
    await AP.sendPromptToSession('agent-zara', 'hi')
    expect(sentKeys().filter((k) => k === 'Enter')).toHaveLength(1)
  })

  it('fires a retry-Enter for verbatim text parked under an idle footer', async () => {
    H.decideSubmitFollowup.mockReturnValueOnce('retry-enter').mockReturnValue('done')
    await AP.sendPromptToSession('agent-zara', 'hi')
    expect(sentKeys().filter((k) => k === 'Enter')).toHaveLength(2)
  })

  it('gives up with a warn once the retry budget is spent', async () => {
    H.decideSubmitFollowup.mockReturnValue('give-up')
    await AP.sendPromptToSession('agent-zara', 'hi')
    expect(H.logs.some((l) => String(l.msg).includes('still parked after retries'))).toBe(true)
  })

  it('breaks out when the retry-Enter itself fails', async () => {
    H.decideSubmitFollowup.mockReturnValue('retry-enter')
    let enters = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [file, ...args].join(' ')
      if (argv.includes('capture-pane')) return 'idle'
      if (args[3] === 'Enter') {
        enters++
        if (enters > 1) throw new Error('send failed')
      }
      return ''
    })
    expect(await AP.sendPromptToSession('agent-zara', 'hi')).toBe('sent')
    expect(H.logs.some((l) => String(l.msg).includes('Retry-Enter send failed'))).toBe(true)
  })

  it('Ctrl-C clears a paste placeholder and replays the chunk stream', async () => {
    H.decideSubmitFollowup.mockReturnValueOnce('clear-and-resend').mockReturnValue('done')
    // placeholder is present on the first discard probe, gone afterwards
    H.detectsPastePlaceholder.mockReturnValueOnce(true).mockReturnValue(false)
    await AP.sendPromptToSession('agent-zara', 'payload')
    expect(sentKeys()).toContain('C-c')
    expect(literalChunks()).toEqual(['payload', 'payload'])
    expect(H.logs.some((l) => String(l.msg).includes('paste placeholder detected'))).toBe(true)
  })

  it('resends even when the placeholder resists clearing', async () => {
    H.decideSubmitFollowup.mockReturnValueOnce('clear-and-resend').mockReturnValue('done')
    H.detectsPastePlaceholder.mockReturnValue(true)
    await AP.sendPromptToSession('agent-zara', 'payload')
    expect(sentKeys().filter((k) => k === 'C-c')).toHaveLength(3)
    expect(H.logs.some((l) => String(l.msg).includes('failed to clear paste placeholder'))).toBe(true)
  })

  it('skips the Ctrl-C entirely when the box is already empty', async () => {
    H.decideSubmitFollowup.mockReturnValueOnce('clear-and-resend').mockReturnValue('done')
    H.detectsPastePlaceholder.mockReturnValue(false)
    await AP.sendPromptToSession('agent-zara', 'payload')
    expect(sentKeys()).not.toContain('C-c')
  })

  it('gives up on the discard when the Ctrl-C send fails', async () => {
    H.decideSubmitFollowup.mockReturnValueOnce('clear-and-resend').mockReturnValue('done')
    H.detectsPastePlaceholder.mockReturnValue(true)
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      if ([file, ...args].join(' ').includes('capture-pane')) return 'idle'
      if (args[3] === 'C-c') throw new Error('ctrl-c failed')
      return ''
    })
    await AP.sendPromptToSession('agent-zara', 'payload')
    expect(H.logs.some((l) => String(l.msg).includes('Ctrl-C send failed'))).toBe(true)
  })

  it('breaks out when the clear-and-resend replay itself fails', async () => {
    H.decideSubmitFollowup.mockReturnValue('clear-and-resend')
    H.detectsPastePlaceholder.mockReturnValue(false)
    let literals = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      if ([file, ...args].join(' ').includes('capture-pane')) return 'idle'
      if (args[3] === '-l') {
        literals++
        if (literals > 1) throw new Error('replay failed')
      }
      return ''
    })
    expect(await AP.sendPromptToSession('agent-zara', 'payload')).toBe('sent')
    expect(H.logs.some((l) => String(l.msg).includes('Clear-and-resend chunk replay failed'))).toBe(true)
  })

  it('passes a truncated payload hint to the follow-up decision', async () => {
    H.decideSubmitFollowup.mockReturnValue('done')
    await AP.sendPromptToSession('agent-zara', 'y'.repeat(200))
    expect(H.decideSubmitFollowup).toHaveBeenCalledWith('idle', 'y'.repeat(96), 0, 4)
  })
})

// ===========================================================================
// clearStaleParkedInput
// ===========================================================================

/**
 * Drive the un-wedge probe. `state` feeds detectPaneState, `parked` feeds
 * parkedInputText; both may be per-call sequences (last entry repeats).
 */
function unwedgeDriver(opts: {
  state?: Array<string | null>
  parked?: string[]
  colourFails?: boolean
  captureFails?: boolean
}): void {
  const states = opts.state ?? ['typing']
  const parkeds = opts.parked ?? ['stuck line']
  let si = 0
  let pi = 0
  H.execFileSync.mockImplementation((file: string, args: string[]) => {
    const argv = [file, ...args].join(' ')
    if (!argv.includes('capture-pane')) return ''
    if (opts.captureFails) throw new Error('capture failed')
    if (args.includes('-e') && opts.colourFails) throw new Error('colour capture failed')
    return 'pane'
  })
  H.detectPaneState.mockImplementation(() => {
    const v = states[Math.min(si, states.length - 1)]
    si++
    return v
  })
  H.parkedInputText.mockImplementation(() => {
    const v = parkeds[Math.min(pi, parkeds.length - 1)]
    pi++
    return v
  })
}

describe('clearStaleParkedInput', () => {
  it('does nothing when the pane cannot be captured', async () => {
    unwedgeDriver({ captureFails: true })
    expect(await AP.clearStaleParkedInput('s-capfail')).toBe(false)
  })

  it('does nothing when the pane is not in the typing state', async () => {
    unwedgeDriver({ state: ['busy'] })
    expect(await AP.clearStaleParkedInput('s-busy')).toBe(false)
    expect(sentKeys()).toEqual([])
  })

  it('does nothing when nothing real is parked (dim ghost only)', async () => {
    unwedgeDriver({ state: ['typing'], parked: [''] })
    expect(await AP.clearStaleParkedInput('s-ghost')).toBe(false)
  })

  it('falls back to the plain capture when the dim-stripped one fails', async () => {
    unwedgeDriver({ state: ['typing', 'idle'], colourFails: true })
    expect(await AP.clearStaleParkedInput('s-fallback')).toBe(false)
    // the -e capture was attempted and its failure did not abort the probe
    expect(calls().some((c) => c.args.includes('-e'))).toBe(true)
  })

  it('leaves the box alone when the text changed across the settle window', async () => {
    unwedgeDriver({ state: ['typing', 'typing'], parked: ['first', 'second'] })
    expect(await AP.clearStaleParkedInput('s-typing-human')).toBe(false)
    expect(sentKeys()).toEqual([])
  })

  it('leaves the box alone when it stopped being a typing pane', async () => {
    unwedgeDriver({ state: ['typing', 'idle'] })
    expect(await AP.clearStaleParkedInput('s-settled')).toBe(false)
  })

  it('leaves the box alone when the confirm capture fails', async () => {
    let n = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      if (![file, ...args].join(' ').includes('capture-pane')) return ''
      n++
      if (n > 2) throw new Error('gone')
      return 'pane'
    })
    H.detectPaneState.mockReturnValue('typing')
    H.parkedInputText.mockReturnValue('stuck')
    expect(await AP.clearStaleParkedInput('s-confirmfail')).toBe(false)
  })

  it('clears a genuinely stale parked line with Ctrl-U', async () => {
    unwedgeDriver({ state: ['typing', 'typing', 'idle'] })
    expect(await AP.clearStaleParkedInput('s-clean')).toBe(true)
    expect(sentKeys()).toContain('C-u')
    expect(H.logs.some((l) => String(l.msg).includes('cleared stale parked input'))).toBe(true)
  })

  it('breaks the Ctrl-U loop when the post-clear capture fails', async () => {
    let n = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      if (![file, ...args].join(' ').includes('capture-pane')) return ''
      n++
      if (n > 3) throw new Error('gone')
      return 'pane'
    })
    H.detectPaneState.mockReturnValue('typing')
    H.parkedInputText.mockReturnValue('stuck')
    expect(await AP.clearStaleParkedInput('s-breakclear')).toBe(true)
  })

  it('escalates to Home + kill-to-end when Ctrl-U alone does not empty the box', async () => {
    // typing through the whole Ctrl-U loop, then finally cleared
    unwedgeDriver({
      state: ['typing', 'typing', 'typing', 'typing', 'typing', 'typing', 'idle'],
    })
    await AP.clearStaleParkedInput('s-escalate')
    expect(sentKeys()).toContain('C-a')
    expect(sentKeys()).toContain('C-k')
  })

  it('never auto-clears the MAIN channels session box', async () => {
    H.mainChannelsSession = 'marveen-channels'
    unwedgeDriver({ state: ['typing', 'typing'] })
    expect(await AP.clearStaleParkedInput('marveen-channels')).toBe(false)
    expect(sentKeys()).toEqual([])
    expect(H.logs.some((l) => l.level === 'debug' && String(l.msg).includes('left untouched'))).toBe(true)
  })

  it('backs off on the cooldown instead of re-running the settle sleep', async () => {
    unwedgeDriver({ state: ['typing', 'typing'] })
    await AP.clearStaleParkedInput('marveen-channels')   // records an attempt
    const before = calls().length
    expect(await AP.clearStaleParkedInput('marveen-channels')).toBe(false)
    // second call bails before the confirm capture: at most one capture pair
    expect(calls().length - before).toBeLessThanOrEqual(2)
  })

  it('records a failure and backs off when the box resists clearing', async () => {
    unwedgeDriver({ state: ['typing'] })
    expect(await AP.clearStaleParkedInput('s-stubborn')).toBe(false)
    expect(H.logs.some((l) => String(l.msg).includes('resisted clearing, backing off'))).toBe(true)
  })

  it('escalates to the operator once after enough consecutive failures', async () => {
    const SESSION = 's-escalate-notify'
    for (let i = 0; i < 7; i++) {
      unwedgeDriver({ state: ['typing'] })
      await AP.clearStaleParkedInput(SESSION)
      CLOCK += 40_000   // step past the un-wedge cooldown
    }
    expect(H.notifyChannel).toHaveBeenCalledTimes(1)
    expect(String(H.notifyChannel.mock.calls[0][0])).toContain(SESSION)
    expect(H.logs.some((l) => String(l.msg).includes('escalated to operator'))).toBe(true)
  })

  it('sanitises the parked-text preview in the operator notification', async () => {
    const SESSION = 's-escalate-sanitize'
    for (let i = 0; i < 6; i++) {
      unwedgeDriver({ state: ['typing'], parked: ['<script>&bad'] })
      await AP.clearStaleParkedInput(SESSION)
      CLOCK += 40_000
    }
    const text = String(H.notifyChannel.mock.calls[0][0])
    expect(text).not.toContain('<script>')
    expect(text).toContain('script')
  })

  it('swallows a rejected escalation notification', async () => {
    H.notifyChannel.mockRejectedValue(new Error('telegram down'))
    const SESSION = 's-escalate-reject'
    for (let i = 0; i < 6; i++) {
      unwedgeDriver({ state: ['typing'] })
      await AP.clearStaleParkedInput(SESSION)
      CLOCK += 40_000
    }
    expect(H.notifyChannel).toHaveBeenCalled()
    await flush()
  })

  it('keys the cooldown per host so a remote pane is tracked separately', async () => {
    unwedgeDriver({ state: ['typing', 'typing'] })
    await AP.clearStaleParkedInput('shared-name', 'laptop')
    expect(calls().every((c) => c.file === 'ssh')).toBe(true)
  })
})

// ===========================================================================
// Defensive guards reachable only by making a collaborator misbehave
// ===========================================================================

describe('scheduleIdentitySetup -- outer dismiss guard', () => {
  it('still sends /name when a modal dismiss escapes its own error handling', async () => {
    paneSequence([new Error('capture down')])
    // The dismiss helpers swallow everything EXCEPT a failure of the log sink
    // they use to report the swallow -- that escapes to the outer guard.
    H.throwOnLog = 'Failed to probe/dismiss session-rating modal'
    await AP.scheduleIdentitySetup('agent-zara', 'Zoe')
    await flush()
    expect(H.logs.some((l) => String(l.msg).includes('Post-restart modal dismiss failed'))).toBe(true)
    expect(sentKeys()).toContain('/name Zoe Enter')
  })
})

describe('clearStaleParkedInput -- main-agent failure accounting', () => {
  it('accumulates the fail count across cooldown windows for the same stuck text', async () => {
    // `unwedgeAttempts` is module-level state that outlives a test, so use a
    // session key no other test has touched.
    const MAIN = 'main-fail-accounting'
    H.mainChannelsSession = MAIN

    unwedgeDriver({ state: ['typing', 'typing'] })
    await AP.clearStaleParkedInput(MAIN)
    const first = H.logs.filter((l) => String(l.msg).includes('left untouched')).at(-1)
    expect(first?.obj).toMatchObject({ fails: 1 })

    // Past the cooldown, the SAME parked text must carry the prior count
    // forward rather than restarting at 1.
    CLOCK += 40_000
    unwedgeDriver({ state: ['typing', 'typing'] })
    await AP.clearStaleParkedInput(MAIN)
    const second = H.logs.filter((l) => String(l.msg).includes('left untouched')).at(-1)
    expect(second?.obj).toMatchObject({ fails: 2 })

    // A DIFFERENT parked text resets the counter.
    CLOCK += 40_000
    unwedgeDriver({ state: ['typing', 'typing'], parked: ['a brand new line'] })
    await AP.clearStaleParkedInput(MAIN)
    const third = H.logs.filter((l) => String(l.msg).includes('left untouched')).at(-1)
    expect(third?.obj).toMatchObject({ fails: 1 })
  })
})

// =========================================================================
// Default-arg branches on the private tmux + modal helpers.
//
// runTmux(host, tmuxArgs, opts = {}): caller-provided opts vs the {} default.
// runTmux(..., opts.timeout ?? 3000): explicit timeout vs the 3000 default.
// dismissSurveyModalIfPresent(session, host = null): host omitted vs explicit.
// discardPlaceholderBuffer(session, host = null): host omitted vs explicit.
//
// Production call sites always pass opts/host explicitly, so the defaults
// never fire. The __test_* wrappers (cycle 47-48 pattern, f75caf6) expose
// each helper with no optional params, so calling them exercises the
// default-arg branch on the underlying private function.
// =========================================================================
describe('__test_runTmux (default args)', () => {
  it('uses the `opts = {}` default when the caller passes none (L765)', () => {
    AP.__test_runTmux(null, ['list-sessions'])
    // opts defaulted -> opts.timeout ?? 3000 fires -> timeout = 3000.
    expect(H.execFileSync.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 3000 })
  })

  it('uses the `opts.timeout ?? 3000` default when opts is `{}` (L776)', () => {
    AP.__test_runTmux(null, ['list-sessions'])
    // Same call; the second coverage dimension is the ?? 3000 fallback when
    // opts has no `.timeout` key. Asserting timeout=3000 already pins both.
    expect(H.execFileSync.mock.calls.at(-1)?.[2]).toMatchObject({ timeout: 3000 })
  })
})

describe('__test_dismissSurveyModalIfPresent (default host = null)', () => {
  it('uses host=null when the caller omits it (L1397)', async () => {
    paneSequence(['How is Claude doing this session'])
    await AP.__test_dismissSurveyModalIfPresent('agent-zara')
    // captureTmux is called with host=null -> local tmux (not ssh).
    expect(calls().some((c) => c.file === '/usr/bin/tmux')).toBe(true)
  })

  it('no-ops when the modal marker is absent', async () => {
    paneSequence(['some unrelated pane content'])
    H.execFileSync.mockClear()
    await AP.__test_dismissSurveyModalIfPresent('agent-zara')
    expect(calls().find((c) => c.args[0] === 'send-keys')).toBeUndefined()
  })
})

describe('__test_discardPlaceholderBuffer (default host = null)', () => {
  it('uses host=null when the caller omits it (L1659)', async () => {
    // Mock detectsPastePlaceholder: true for placeholder text, false for clean.
    H.detectsPastePlaceholder.mockImplementation((pane: string) => pane.includes('[paste]'))
    // Pane shows placeholder -> the helper sends Ctrl-C repeatedly until
    // the placeholder is gone (or PLACEHOLDER_DISCARD_MAX retries).
    paneSequence(['[paste] placeholder-1', '[paste] placeholder-2', 'plain'])
    const ok = await AP.__test_discardPlaceholderBuffer('agent-zara')
    expect(ok).toBe(true)
    // local tmux path: send-keys via local /usr/bin/tmux.
    expect(calls().some((c) => c.file === '/usr/bin/tmux' && c.args[0] === 'send-keys')).toBe(true)
  })

  it('returns false when the placeholder is never cleared', async () => {
    // Stub detectsPastePlaceholder to always detect the placeholder.
    H.detectsPastePlaceholder.mockReturnValue(true)
    paneSequence(Array(10).fill('[paste] still-here'))
    const ok = await AP.__test_discardPlaceholderBuffer('agent-zara')
    expect(ok).toBe(false)
  })
})
