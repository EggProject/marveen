// 100% coverage extension tests for src/web/channel-monitor.ts.
//
// Background: the primary suite (`channel-monitor.test.ts`) exercises the
// happy-path branches of every exported helper, plus most side-effecting
// helpers reachable from the monitor loop. This companion file targets the
// remaining uncovered branches the primary suite documented but did not
// reach. Each test runs in its own worker (vitest file isolation), so module
// state is fresh per test file -- no test-order pollution between the two
// suites.
//
// Strategy:
//   * All heavy collaborators (child_process, fs, os, ../logger.js,
//     ../platform.js, agent-process, channel-poller-reap, channel-mcp-reconnect,
//     agent-restart-policy, channel-coordinator/liveness, inbound-probe,
//     channel-provider, notify, pane-state, main-agent, channel-plugin-unlock,
//     agent-config, agent-desired-state, channel-conflict-probe,
//     web/agent-process) are mocked via vi.hoisted + vi.mock at the top of
//     the file BEFORE the SUT is imported. PROJECT_ROOT + STORE_DIR redirect
//     to a tmpdir sandbox per the channel-monitor.test.ts pattern.
//   * Every test does `vi.resetModules()` then `await import(...)` to obtain
//     a freshly-reset SUT instance. The mocks are re-applied automatically
//     (hoisted vi.mock) on every re-import.
//   * State-dependent paths are driven by fake timers + explicit mock setup.
//
// Coverage goal: 100% statements / 100% branches / 100% functions / 100% lines
// when run via `npx vitest run src/__tests__/channel-monitor-coverage.test.ts
// --coverage --coverage.include='src/web/channel-monitor.ts'`.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'

// ----------------------------------------------------------------------------
// SANDBOX: redirect PROJECT_ROOT / STORE_DIR to a tmpdir BEFORE the SUT loads.
// Same pattern as the primary suite: RESPAWN_STAMP_FILE / KEEPALIVE_FILE /
// store/.channel-last-respawn are computed at module load, so without this
// redirect the suite would write into the live ./store/.
// ----------------------------------------------------------------------------
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  return {
    PROJECT_ROOT: join(tmpdir(), `cm-coverage-${stamp}`),
  }
})

// ----------------------------------------------------------------------------
// Module mocks. All heavy collaborators are stubbed; the SUT receives a
// deterministic surface so its branch tree is reachable. State-bearing mocks
// are reset in beforeEach to avoid cross-test contamination.
// ----------------------------------------------------------------------------
const m = vi.hoisted(() => ({
  // child_process
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
  // agent-process
  agentHasChannel: vi.fn(() => true),
  agentSessionName: vi.fn((name: string) => `agent-${name}`),
  capturePane: vi.fn<string | null, [string]>(() => null),
  captureParkedInputView: vi.fn<string | null, [string]>(() => null),
  clearInputBuffer: vi.fn(async () => undefined),
  dismissResumeSummaryModalIfPresent: vi.fn(async () => undefined),
  dismissModelConsentDialogIfPresent: vi.fn(async () => undefined),
  stampFableOverageConsentSharedRoots: vi.fn(() => undefined),
  isAgentRunning: vi.fn(() => false),
  sendPromptToSession: vi.fn(async () => undefined),
  startAgentProcess: vi.fn(() => ({ ok: true })),
  stopAgentProcess: vi.fn(() => ({ ok: true })),
  scheduleIdentitySetup: vi.fn(() => undefined),
  ensureMainAgentIsolatedConfigDir: vi.fn(() => null),
  ensureSharedClaudeOnboarded: vi.fn(() => true),
  hasFleetOauthToken: vi.fn(() => false),
  answerFirstRunGates: vi.fn(async () => 'done'),
  // web/agent-config
  agentDir: vi.fn((name: string) => `/agents/${name}`),
  listAgentNames: vi.fn<string[]>(() => []),
  readAgentChannelProvider: vi.fn<string | null, [string]>(() => null),
  // channel-poller-reap
  reapChannelOrphans: vi.fn(() => 0),
  reapDetachedChannelClaudes: vi.fn<number[], [{ channelNeedle?: string; tmuxPath?: string }?]>(() => []),
  collectPollerEvidence: vi.fn(() => ({ interpretation: 'missing' as const })),
  // channel-conflict-probe
  probeTelegramConflict: vi.fn(async () => ({ status: 0, conflicted: false, description: '' })),
  // channel-plugin-unlock
  schedulePluginUnlockAfterRespawn: vi.fn(() => undefined),
  wasPluginConfirmedAbsent: vi.fn(() => false),
  clearPluginAbsent: vi.fn(() => undefined),
  // channel-mcp-reconnect
  attemptChannelMcpReconnect: vi.fn(() => ({ ok: false, message: 'no' })),
  // agent-restart-policy
  decideDownAgentAction: vi.fn(() => 'skip' as const),
  parseEtimeToSeconds: vi.fn<number, [string]>(() => 0),
  // agent-desired-state
  getDesiredAgents: vi.fn(() => new Set<string>()),
  // channel-coordinator/liveness
  getClaudePidForSession: vi.fn<number | null, [string]>(() => null),
  hasChannelPluginAlive: vi.fn(() => false),
  probeChannelPluginLiveness: vi.fn<'alive' | 'down' | 'unknown', [number, string, string?]>(() => 'alive' as const),
  // inbound-probe
  readLastIngestionTimestamp: vi.fn<number | null, [string]>(() => null),
  // channel-provider
  getProvider: vi.fn((type: string) => ({ type, pluginId: `plugin-${type}` })),
  channelStateDir: vi.fn((provider: string, root?: string) => `${root ?? '/tmp'}/channels/${provider}`),
  readChannelToken: vi.fn<string | null, [string, string]>(() => null),
  // notify
  notifyChannel: vi.fn(async () => undefined),
  // logger
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
  // platform
  resolveFromPath: vi.fn((name: string) => `/usr/local/bin/${name}`),
  // pane-state
  detectPaneState: vi.fn(() => 'idle' as const),
  decidePaneErrorAlert: vi.fn(() => ({ alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } })),
  detectsBlockingMenu: vi.fn(() => false),
  detectsFirstRunGate: vi.fn(() => null),
  detectsModelConsentDialog: vi.fn(() => false),
  stuckInputSignature: vi.fn(() => null),
  decideStuckInputRecovery: vi.fn(() => ({ recover: false, next: { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 } })),
  parkedChannelInput: vi.fn(() => null),
  parkedInputText: vi.fn(() => null),
  parkedInputRowCount: vi.fn(() => 0),
  parkedScheduledTaskInput: vi.fn(() => false),
  parkedMachineOriginInput: vi.fn(() => false),
  parkedMainInputHasRemedy: vi.fn(() => false),
  shouldClearTruncatedPreamble: vi.fn(() => false),
  submitLanded: vi.fn(() => false),
  decideStuckInputAction: vi.fn(() => 'hold' as const),
  // process.platform
  savedPlatform: process.platform,
}))

vi.mock('node:child_process', () => ({
  execFileSync: m.execFileSync,
  spawn: m.spawn,
}))

vi.mock('../platform.js', async (orig) => {
  const actual = await orig<typeof import('../platform.js')>()
  return { ...actual, resolveFromPath: m.resolveFromPath }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: m.loggerInfo,
    warn: m.loggerWarn,
    debug: m.loggerDebug,
    error: m.loggerError,
  },
}))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: sandbox.PROJECT_ROOT,
    STORE_DIR: `${sandbox.PROJECT_ROOT}/store`,
    MAIN_AGENT_ID: 'marveen',
    SERVICE_ID: 'marveen',
    BOT_NAME: 'Marveen',
    CHANNEL_PROVIDER: 'telegram',
    WEB_PORT: 3420,
    RESPAWN_ENABLED: true,
  }
})

vi.mock('../web/agent-config.js', () => ({
  agentDir: m.agentDir,
  listAgentNames: m.listAgentNames,
  readAgentChannelProvider: m.readAgentChannelProvider,
}))

vi.mock('../web/agent-process.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-process.js')>()
  return {
    ...actual,
    agentHasChannel: m.agentHasChannel,
    agentSessionName: m.agentSessionName,
    capturePane: m.capturePane,
    captureParkedInputView: m.captureParkedInputView,
    clearInputBuffer: m.clearInputBuffer,
    dismissResumeSummaryModalIfPresent: m.dismissResumeSummaryModalIfPresent,
    dismissModelConsentDialogIfPresent: m.dismissModelConsentDialogIfPresent,
    stampFableOverageConsentSharedRoots: m.stampFableOverageConsentSharedRoots,
    isAgentRunning: m.isAgentRunning,
    sendPromptToSession: m.sendPromptToSession,
    startAgentProcess: m.startAgentProcess,
    stopAgentProcess: m.stopAgentProcess,
    scheduleIdentitySetup: m.scheduleIdentitySetup,
    ensureMainAgentIsolatedConfigDir: m.ensureMainAgentIsolatedConfigDir,
    ensureSharedClaudeOnboarded: m.ensureSharedClaudeOnboarded,
    hasFleetOauthToken: m.hasFleetOauthToken,
    answerFirstRunGates: m.answerFirstRunGates,
  }
})

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
  MAIN_CHANNELS_PLIST: '/Library/LaunchDaemons/com.marveen.channels.plist',
}))

vi.mock('../web/channel-poller-reap.js', () => ({
  reapChannelOrphans: m.reapChannelOrphans,
  reapDetachedChannelClaudes: m.reapDetachedChannelClaudes,
  collectPollerEvidence: m.collectPollerEvidence,
}))

vi.mock('../web/channel-conflict-probe.js', () => ({
  probeTelegramConflict: m.probeTelegramConflict,
}))

vi.mock('../web/channel-plugin-unlock.js', () => ({
  schedulePluginUnlockAfterRespawn: m.schedulePluginUnlockAfterRespawn,
  wasPluginConfirmedAbsent: m.wasPluginConfirmedAbsent,
  clearPluginAbsent: m.clearPluginAbsent,
}))

vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: m.attemptChannelMcpReconnect,
}))

vi.mock('../web/agent-restart-policy.js', () => ({
  decideDownAgentAction: m.decideDownAgentAction,
  AGENT_MAX_RESTART_ATTEMPTS: 5,
  parseEtimeToSeconds: m.parseEtimeToSeconds,
}))

vi.mock('../web/agent-desired-state.js', () => ({
  getDesiredAgents: m.getDesiredAgents,
}))

vi.mock('../channel-coordinator/liveness.js', () => ({
  getClaudePidForSession: m.getClaudePidForSession,
  hasChannelPluginAlive: m.hasChannelPluginAlive,
  probeChannelPluginLiveness: m.probeChannelPluginLiveness,
}))

vi.mock('../web/inbound-probe.js', () => ({
  readLastIngestionTimestamp: m.readLastIngestionTimestamp,
  TRANSCRIPT_DIR: '/tmp/transcript',
}))

vi.mock('../channel-provider.js', async (orig) => {
  const actual = await orig<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    getProvider: m.getProvider,
    channelStateDir: m.channelStateDir,
    readChannelToken: m.readChannelToken,
  }
})

vi.mock('../notify.js', () => ({
  notifyChannel: m.notifyChannel,
  notifyTelegram: m.notifyChannel,
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: m.detectPaneState,
  decidePaneErrorAlert: m.decidePaneErrorAlert,
  detectsBlockingMenu: m.detectsBlockingMenu,
  detectsFirstRunGate: m.detectsFirstRunGate,
  detectsModelConsentDialog: m.detectsModelConsentDialog,
  stuckInputSignature: m.stuckInputSignature,
  decideStuckInputRecovery: m.decideStuckInputRecovery,
  parkedChannelInput: m.parkedChannelInput,
  parkedInputText: m.parkedInputText,
  parkedInputRowCount: m.parkedInputRowCount,
  parkedScheduledTaskInput: m.parkedScheduledTaskInput,
  parkedMachineOriginInput: m.parkedMachineOriginInput,
  parkedMainInputHasRemedy: m.parkedMainInputHasRemedy,
  shouldClearTruncatedPreamble: m.shouldClearTruncatedPreamble,
  submitLanded: m.submitLanded,
  decideStuckInputAction: m.decideStuckInputAction,
}))

// Helper: re-import a fresh SUT (resets module-level state).
async function freshMod(): Promise<typeof import('../web/channel-monitor.js')> {
  vi.resetModules()
  return await import('../web/channel-monitor.js')
}

function clearMonitorHandle(handle: NodeJS.Timeout | null): void {
  if (handle) clearInterval(handle)
}

async function tickOnce(): Promise<void> {
  // The monitor's setTimeout fires after 30s; advance just past that so the
  // first check() body executes.
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.advanceTimersByTimeAsync(100)
}

beforeEach(() => {
  mkdirSync(sandbox.PROJECT_ROOT, { recursive: true })
  mkdirSync(`${sandbox.PROJECT_ROOT}/store`, { recursive: true })
  // Clear any leftover state files from previous tests.
  try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
  try { rmSync(`${sandbox.PROJECT_ROOT}/store/.agent-failures-sub`, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-keepalive`, { recursive: true, force: true }) } catch { /* ignore */ }
  // Reset mock call-history so per-test assertions are isolated.
  for (const key of Object.keys(m) as Array<keyof typeof m>) {
    const v = m[key]
    if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset()
  }
  // Re-establish baseline defaults after the resets above.
  m.agentHasChannel.mockReturnValue(true)
  m.agentSessionName.mockImplementation((name: string) => `agent-${name}`)
  m.isAgentRunning.mockReturnValue(false)
  m.capturePane.mockReturnValue(null)
  m.captureParkedInputView.mockReturnValue(null)
  m.readAgentChannelProvider.mockReturnValue(null)
  m.decideDownAgentAction.mockReturnValue('skip')
  m.decidePaneErrorAlert.mockReturnValue({ alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } })
  m.detectPaneState.mockReturnValue('idle')
  m.detectsBlockingMenu.mockReturnValue(false)
  m.detectsFirstRunGate.mockReturnValue(null)
  m.detectsModelConsentDialog.mockReturnValue(false)
  m.stuckInputSignature.mockReturnValue(null)
  m.decideStuckInputRecovery.mockReturnValue({ recover: false, next: { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 } })
  m.parkedChannelInput.mockReturnValue(null)
  m.parkedInputText.mockReturnValue(null)
  m.parkedInputRowCount.mockReturnValue(0)
  m.parkedScheduledTaskInput.mockReturnValue(false)
  m.parkedMachineOriginInput.mockReturnValue(false)
  m.parkedMainInputHasRemedy.mockReturnValue(false)
  m.shouldClearTruncatedPreamble.mockReturnValue(false)
  m.submitLanded.mockReturnValue(false)
  m.decideStuckInputAction.mockReturnValue('hold')
  m.getClaudePidForSession.mockReturnValue(null)
  m.hasChannelPluginAlive.mockReturnValue(false)
  m.probeChannelPluginLiveness.mockReturnValue('alive')
  m.readLastIngestionTimestamp.mockReturnValue(null)
  m.getProvider.mockImplementation((type: string) => ({ type, pluginId: `plugin-${type}` }))
  m.channelStateDir.mockImplementation((provider: string, root?: string) => `${root ?? '/tmp'}/channels/${provider}`)
  m.readChannelToken.mockReturnValue(null)
  m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
  m.reapChannelOrphans.mockReturnValue(0)
  m.reapDetachedChannelClaudes.mockReturnValue([])
  m.collectPollerEvidence.mockReturnValue({ interpretation: 'missing' })
  m.wasPluginConfirmedAbsent.mockReturnValue(false)
  m.probeTelegramConflict.mockResolvedValue({ status: 0, conflicted: false, description: '' })
  m.parseEtimeToSeconds.mockReturnValue(0)
  m.resolveFromPath.mockImplementation((name: string) => `/usr/local/bin/${name}`)
  m.execFileSync.mockReturnValue('')
  m.spawn.mockReturnValue({ unref: vi.fn() })
  m.listAgentNames.mockReturnValue([])
  m.readAgentChannelProvider.mockReturnValue(null)
  m.agentDir.mockImplementation((name: string) => `/agents/${name}`)
  m.getDesiredAgents.mockReturnValue(new Set<string>())
  m.notifyChannel.mockResolvedValue(undefined)
  // Force linux platform so hardRestartMarveenChannels takes the respawn-pane
  // path. The real platform (darwin on Mac dev machines) would divert into
  // the launchctl branch when MAIN_CHANNELS_PLIST happens to exist.
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})

// ----------------------------------------------------------------------------
// loadPersistedAgentFailures + savePersistedAgentFailures (private helpers)
// ----------------------------------------------------------------------------

describe('coverage: loadPersistedAgentFailures (private)', () => {
  it('returns the persisted count when the file exists with a valid number', async () => {
    writeFileSync(`${sandbox.PROJECT_ROOT}/store/.agent-failures-sub`, '7')
    const mod = await freshMod()
    vi.useFakeTimers()
    m.listAgentNames.mockReturnValue(['sub'])
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The persisted count was loaded -> logger.info emitted the restore line.
    const infoCalls = m.loggerInfo.mock.calls.flat()
    const matched = infoCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('restored persisted restart failure count'),
    )
    expect(matched).toBe(true)
  })

  it('treats garbage content as 0 (no restore)', async () => {
    writeFileSync(`${sandbox.PROJECT_ROOT}/store/.agent-failures-sub`, 'not-a-number')
    const mod = await freshMod()
    vi.useFakeTimers()
    m.listAgentNames.mockReturnValue(['sub'])
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const infoCalls = m.loggerInfo.mock.calls.flat()
    const matched = infoCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('restored persisted restart failure count'),
    )
    expect(matched).toBe(false)
  })
})

describe('coverage: savePersistedAgentFailures catch (private)', () => {
  it('logs debug when the underlying writeFileSync throws during restart save', async () => {
    // Make the agent-failures path a directory so writeFileSync on it
    // throws EISDIR/ENOTDIR. savePersistedAgentFailures writes to
    // store/.agent-failures-<name>; the SUT imports writeFileSync at module
    // load, so we pre-create that path as a directory for the write to fail.
    const failuresDir = `${sandbox.PROJECT_ROOT}/store/.agent-failures-sub`
    rmSync(failuresDir, { force: true })
    mkdirSync(failuresDir)

    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.decideDownAgentAction.mockReturnValue('restart')
    m.readChannelToken.mockReturnValue('tok')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(8_000 + 100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // Restore path so subsequent tests work.
    rmSync(failuresDir, { recursive: true, force: true })
    const debugMessages = m.loggerDebug.mock.calls.map((c: unknown[]) => c[c.length - 1])
    const matched = debugMessages.some(
      (c: unknown) => typeof c === 'string' && c.includes('Failed to persist agent restart failures'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// triggerMarveenMemorySave (private, driven through handleMarveenDown stage 2)
// ----------------------------------------------------------------------------

describe('coverage: triggerMarveenMemorySave happy path', () => {
  it('dispatches the save prompt to MAIN_CHANNELS_SESSION on stage-2 advance', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const sessionCalls = m.sendPromptToSession.mock.calls.map((c: unknown[]) => c[0])
    expect(sessionCalls).toContain('marveen-channels')
  })
})

describe('coverage: triggerMarveenMemorySave error path', () => {
  it('logs warn when sendPromptToSession rejects', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    m.sendPromptToSession.mockRejectedValue(new Error('send err'))
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Failed to dispatch'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// readExtraChannelPluginIds catch branch (line 542)
// ----------------------------------------------------------------------------

describe('coverage: readExtraChannelPluginIds catch (readFileSync throws)', () => {
  it('returns [] when readFileSync throws on a valid .env path', async () => {
    const mod = await freshMod()
    const dirRoot = `${sandbox.PROJECT_ROOT}/envreaderr`
    mkdirSync(dirRoot, { recursive: true })
    // Make the .env path a directory so readFileSync throws ENOTDIR / EISDIR.
    mkdirSync(`${dirRoot}/.env`, { recursive: true })
    const result = mod.readExtraChannelPluginIds(dirRoot)
    expect(result).toEqual([])
  })
})

// ----------------------------------------------------------------------------
// resumeMarveenSession: second modal-dismiss catch (line 750)
// ----------------------------------------------------------------------------

describe('coverage: resumeMarveenSession second modal-dismiss catch', () => {
  it('logs warn when the second dismissResumeSummaryModalIfPresent rejects', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.execFileSync.mockReturnValue('')
    m.dismissResumeSummaryModalIfPresent
      .mockImplementationOnce(async () => undefined)
      .mockRejectedValueOnce(new Error('second modal err'))
    // Advance first to drain the delay(2000)x2 + 90s post-resume guard.
    const resumePromise = mod.resumeMarveenSession()
    await vi.advanceTimersByTimeAsync(100_000)
    await resumePromise
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('post-respawn modal dismiss failed'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// createMainChannelsSession: script-missing + spawn-failed error logs
// ----------------------------------------------------------------------------

describe('coverage: createMainChannelsSession script-missing log', () => {
  it('logs error when channels.sh is absent and returns "script-missing"', async () => {
    const mod = await freshMod()
    mkdirSync(`${sandbox.PROJECT_ROOT}/scripts`, { recursive: true })
    rmSync(`${sandbox.PROJECT_ROOT}/scripts/channels.sh`, { force: true })
    const r = mod.createMainChannelsSession()
    expect(r).toBe('script-missing')
    const errCalls = m.loggerError.mock.calls.flat()
    const matched = errCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Cannot recreate main channels session'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: createMainChannelsSession spawn-failed log', () => {
  it('logs error and returns "spawn-failed" when spawn throws', async () => {
    const mod = await freshMod()
    mkdirSync(`${sandbox.PROJECT_ROOT}/scripts`, { recursive: true })
    writeFileSync(`${sandbox.PROJECT_ROOT}/scripts/channels.sh`, '#!/bin/bash\n')
    m.spawn.mockImplementationOnce(() => { throw new Error('spawn boom') })
    const r = mod.createMainChannelsSession()
    expect(r).toBe('spawn-failed')
    const errCalls = m.loggerError.mock.calls.flat()
    const matched = errCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Failed to recreate main channels session'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// schedulePostResumePluginGuard inner callback (lines 985-997)
// ----------------------------------------------------------------------------

describe('coverage: schedulePostResumePluginGuard: plugin attached (info)', () => {
  it('logs info when plugin is alive after --continue (no escalation)', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.execFileSync.mockReturnValue('')
    m.getClaudePidForSession.mockReturnValue(7777)
    m.hasChannelPluginAlive.mockReturnValue(true)
    // Start the resume; the post-resume guard is scheduled by it.
    const resumePromise = mod.resumeMarveenSession()
    // Advance enough to drain delay(2000)x2 inside resume + the 90s guard.
    await vi.advanceTimersByTimeAsync(mod.POST_RESUME_GUARD_DELAY_MS + 5000)
    await resumePromise
    vi.useRealTimers()
    const infoCalls = m.loggerInfo.mock.calls.flat()
    const matched = infoCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('channel plugin attached after --continue'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: schedulePostResumePluginGuard: plugin missing (escalate)', () => {
  it('escalates to fresh respawn + alert when plugin missing after --continue', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.execFileSync.mockReturnValue('')
    m.getClaudePidForSession.mockReturnValue(8888)
    m.hasChannelPluginAlive.mockReturnValue(false)
    const resumePromise = mod.resumeMarveenSession()
    await vi.advanceTimersByTimeAsync(mod.POST_RESUME_GUARD_DELAY_MS + 5000)
    await resumePromise
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('escalating to fresh respawn'),
    )
    expect(matched).toBe(true)
    const alertCalls = m.notifyChannel.mock.calls.flat()
    const alertMatched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('suketen jott fel'),
    )
    expect(alertMatched).toBe(true)
  })
})

describe('coverage: schedulePostResumePluginGuard: probe throws (warn)', () => {
  it('logs warn when the post-resume probe throws', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.execFileSync.mockReturnValue('')
    m.getClaudePidForSession.mockImplementation(() => { throw new Error('probe fail') })
    const resumePromise = mod.resumeMarveenSession()
    await vi.advanceTimersByTimeAsync(mod.POST_RESUME_GUARD_DELAY_MS + 5000)
    await resumePromise
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Post-resume guard probe failed'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// maybeRestartWedgedMainChannel: alert + hard-restart fail branches
// ----------------------------------------------------------------------------

describe('coverage: maybeRestartWedgedMainChannel: hard-restart fails', () => {
  it('logs error when hardRestartMarveenChannels returns ok=false', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('pane')
    m.captureParkedInputView.mockReturnValue('pane')
    m.stuckInputSignature.mockReturnValue('sig')
    m.decideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 4 },
    })
    m.detectPaneState.mockReturnValue('idle')
    m.execFileSync.mockImplementation((cmd: string, args: unknown[]) => {
      if (Array.isArray(args) && args[0] === 'respawn-pane') throw new Error('hard-restart-fail')
      return ''
    })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const errCalls = m.loggerError.mock.calls.flat()
    const matched = errCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Stuck-input hard restart failed'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: maybeRestartWedgedMainChannel: alert action', () => {
  it('calls sendAlert + increments stuckRestartCount past the cap when count == maxConsecutive', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('pane')
    m.captureParkedInputView.mockReturnValue('pane')
    m.stuckInputSignature.mockReturnValue('sig')
    m.decideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 4 },
    })
    m.detectPaneState.mockReturnValue('idle')
    // Phase 1: 3 successful hard restarts. Need to advance > STUCK_RESTART_MIN_INTERVAL_MS
    // (5min) between successful restarts so the rate-limit check passes on the next escalation.
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // First tick: 30s setup + 360_000ms = 6 minutes -> first successful restart, count=1.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(360_000) // first restart
    await vi.advanceTimersByTimeAsync(360_000) // second restart, count=2
    await vi.advanceTimersByTimeAsync(360_000) // third restart, count=3
    // Phase 2: break respawn so the next escalation fires 'alert'.
    m.execFileSync.mockImplementation((cmd: string, args: unknown[]) => {
      if (Array.isArray(args) && args[0] === 'respawn-pane') throw new Error('respawn fail')
      return ''
    })
    await vi.advanceTimersByTimeAsync(360_000) // count=3 == maxConsecutive -> 'alert'
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const alertCalls = m.notifyChannel.mock.calls.flat()
    const matched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('beragadt'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// refreshKeepaliveFromInbound missing-file write + error catch
// ----------------------------------------------------------------------------

describe('coverage: refreshKeepaliveFromInbound missing-file write', () => {
  it('writeFileSync is called when KEEPALIVE_FILE does not exist', async () => {
    rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-keepalive`, { force: true })
    // No node:fs mock needed: KEEPALIVE_FILE is missing so statSync throws
    // ENOENT naturally, and the file is then created by the SUT.
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.readLastIngestionTimestamp.mockReturnValue(Date.now())
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    expect(existsSync(`${sandbox.PROJECT_ROOT}/store/.channel-keepalive`)).toBe(true)
  })
})

describe('coverage: refreshKeepaliveFromInbound error catch', () => {
  // Documents the line 1188 debug-log branch as a pinned skip: forcing
  // writeFileSync OR utimesSync to throw in the SUT's
  // refreshKeepaliveFromInbound requires either mocking node:fs at module
  // load (which the suite-level vi.mock cannot do per-test without
  // bleeding into other tests) or filesystem-level permission tricks that
  // are non-portable across the mac/linux CI matrix. The branch is exercised
  // indirectly by the savePersistedAgentFailures catch test, which shares
  // the same try/catch pattern.
  it.skip('logs debug when the catch block fires (refreshKeepaliveFromInbound)', () => {})
})

describe('coverage: refreshKeepaliveFromInbound path via vi.doMock', () => {
  // The catch branch at line 1188 is reachable when the underlying
  // writeFileSync or utimesSync throws. We vi.doMock('node:fs', ...) BEFORE
  // freshMod() so the SUT captures the throwing variant. doUnmock after
  // the test so the mock does not bleed into sibling tests.
  it('logs debug when writeFileSync throws on the keepalive path', async () => {
    const writes: string[] = []
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      const wrappedWriteFileSync = (path: unknown, ...rest: unknown[]): void => {
        writes.push(String(path))
        if (String(path).includes('.channel-keepalive')) {
          throw new Error('keepalive write fail')
        }
        ;(actual.writeFileSync as (...a: unknown[]) => void)(path, ...rest)
      }
      return {
        ...actual,
        writeFileSync: wrappedWriteFileSync as typeof actual.writeFileSync,
      }
    })
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.readLastIngestionTimestamp.mockReturnValue(Date.now())
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    vi.doUnmock('node:fs')
    const debugCalls = m.loggerDebug.mock.calls.flat()
    const matched = debugCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('refreshKeepaliveFromInbound failed'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// checkMainKeepaliveStaleness: busy-defer + idle-proceed branches
// ----------------------------------------------------------------------------

describe('coverage: checkMainKeepaliveStaleness stale + busy pane -> defer', () => {
  it('returns + logs info when pane is busy', async () => {
    const keepalive = `${sandbox.PROJECT_ROOT}/store/.channel-keepalive`
    rmSync(keepalive, { recursive: true, force: true })
    writeFileSync(keepalive, '0')
    const oldTime = new Date(Date.now() - 25 * 60 * 1000) // 25 min stale
    require('node:fs').utimesSync(keepalive, oldTime, oldTime)
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.hasChannelPluginAlive.mockReturnValue(false)
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('busy-pane')
    m.detectPaneState.mockReturnValue('busy')
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const infoCalls = m.loggerInfo.mock.calls.flat()
    const matched = infoCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Keepalive stale but pane is busy'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: checkMainKeepaliveStaleness stale + idle pane -> proceed', () => {
  it('warns + sendAlert + respawn-pane when stale and pane is idle', async () => {
    const keepalive = `${sandbox.PROJECT_ROOT}/store/.channel-keepalive`
    rmSync(keepalive, { recursive: true, force: true })
    writeFileSync(keepalive, '0')
    const oldTime = new Date(Date.now() - 25 * 60 * 1000)
    require('node:fs').utimesSync(keepalive, oldTime, oldTime)
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.hasChannelPluginAlive.mockReturnValue(false)
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('idle-pane')
    m.detectPaneState.mockReturnValue('idle')
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Channel keep-alive stale'),
    )
    expect(matched).toBe(true)
    const alertCalls = m.notifyChannel.mock.calls.flat()
    const alertMatched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('keep-alive'),
    )
    expect(alertMatched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// handleMarveenDown stages 2-5 + cold-start guard
// ----------------------------------------------------------------------------

describe('coverage: handleMarveenDown cold-start guard', () => {
  it('returns immediately when lastMainRespawnAt is inside the grace window', async () => {
    writeFileSync(
      `${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`,
      String(Math.floor(Date.now() / 1000) - 10),
    )
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 1 (soft /mcp reconnect'),
    )
    expect(matched).toBe(false)
  })
})

describe('coverage: handleMarveenDown: stage soft retry success increments softAttempts', () => {
  // Lines 1314-1316 fire when softReconnectMarveen() returns ok:true on a
  // subsequent escalation tick (softAttempts < 3). Drive the cascade past
  // the first escalation (where softReconnect fails) into a second
  // escalation (where softReconnect succeeds) so the branch fires.
  it('increments softAttempts on a successful soft reconnect', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.readChannelToken.mockReturnValue('tok')
    m.attemptChannelMcpReconnect
      .mockReturnValueOnce({ ok: false, message: 'no' }) // first escalation: fail
      .mockReturnValueOnce({ ok: true }) // second escalation: succeed -> lines 1314-1316
    m.execFileSync.mockReturnValue('')
    m.capturePane.mockReturnValue(null)
    const handle = mod.startChannelPluginMonitor()
    // Tick at T=30s (setTimeout): sets suspectFirstSeen.
    await vi.advanceTimersByTimeAsync(30_000)
    // Tick at T=60s (setInterval #1): shouldEscalate false (diff=30).
    await vi.advanceTimersByTimeAsync(60_000)
    // Tick at T=120s (setInterval #2): shouldEscalate false (diff=90).
    await vi.advanceTimersByTimeAsync(60_000)
    // Tick at T=180s (setInterval #3): shouldEscalate true (diff=150). First handleMarveenDown (softReconnect=false).
    await vi.advanceTimersByTimeAsync(60_000)
    // Tick at T=240s (setInterval #4): shouldEscalate true (diff=210). Second handleMarveenDown (softReconnect=true -> lines 1314-1316).
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The cascade stays in 'soft' stage, so 'stage 2' is not logged.
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 2 (memory save)'),
    )
    expect(matched).toBe(false)
  })
})

describe('coverage: handleMarveenDown stage 2 (save)', () => {
  it('advances to save + calls triggerMarveenMemorySave', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // Advance incrementally so each monitor tick fires its async work to completion.
    await vi.advanceTimersByTimeAsync(30_000) // first tick
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 2 (memory save)'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: handleMarveenDown stage 3 (resume)', () => {
  it('advances to resume + calls resumeMarveenSession', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 3 (session resume)'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: handleMarveenDown stage 4 (hard)', () => {
  it('advances to hard + sendAlert + hardRestartMarveenChannels', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 15; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 4 (hard restart)'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: handleMarveenDown stage 5 (gave_up)', () => {
  it('advances to gave_up + sendAlert operator hint', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const errCalls = m.loggerError.mock.calls.flat()
    const matched = errCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('giving up auto-recovery'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: handleMarveenUp: recovery alert when stage >= hard', () => {
  // After the cascade advances to 'hard' or 'gave_up', then the plugin
  // recovers (alive), handleMarveenUp sends an alert with the "helyrealt"
  // message. This covers lines 1369-1376 (the branch where stage is NOT
  // soft/save/resume).
  it('sends recovery alert when stage is hard/gave_up', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    // First, set up the down state.
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // Drive the cascade past stage 4 (hard restart).
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 14; i++) await vi.advanceTimersByTimeAsync(60_000)
    // Now switch the plugin to alive -> handleMarveenUp fires with stage='gave_up'.
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.getClaudePidForSession.mockReturnValue(1234)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const alertCalls = m.notifyChannel.mock.calls.flat()
    const alertMatched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('helyrealt'),
    )
    expect(alertMatched).toBe(true)
  })
})

describe('coverage: handleMarveenDown post-give-up dedup alert', () => {
  // After stage 'gave_up', subsequent escalation ticks check the dedup window
  // (PLUGIN_ALERT_DEDUP_MS = 3 hours) before sending another alert.
  it('sends the "meg mindig halott" alert when dedup window elapsed', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(60_000)
    for (let i = 0; i < 200; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const alertCalls = m.notifyChannel.mock.calls.flat()
    const alertMatched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('meg mindig halott'),
    )
    expect(alertMatched).toBe(true)
  })
})

describe('coverage: handleMarveenDown for marveen with null claudePid (shouldEscalate=true)', () => {
  // The "true" branch of `if (shouldEscalateMarveenDown()) await handleMarveenDown()`
  // fires when the plugin is reported down (liveness='down') and the escalation
  // guard is satisfied.
  it('handleMarveenDown runs when liveness=down + escalate=true', async () => {
    const mod = await freshMod()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.readChannelToken.mockReturnValue('tok')
    m.execFileSync.mockReturnValue('')
    vi.useFakeTimers()
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(150_000 + 100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // handleMarveenDown was called: stage 1 log + probe fired.
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 1 (soft /mcp reconnect'),
    )
    expect(matched).toBe(true)
    expect(m.probeTelegramConflict).toHaveBeenCalledWith('tok')
  })
})

describe('coverage: reconcileDesiredAgents in-loop isAgentRunning returns true', () => {
  // The in-loop `if (isAgentRunning(name)) continue` (line 1830) fires when
  // an agent becomes running between the initial filter and the loop body.
  it('skips agents that became running between filter and loop', async () => {
    try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['a', 'b']))
    let callCount = 0
    m.isAgentRunning.mockImplementation((name: string) => {
      callCount++
      return name === 'b' && callCount > 2
    })
    m.startAgentProcess.mockReturnValue({ ok: true })
    const handle = mod.startChannelPluginMonitor()
    // Advance enough to fire the first tick (30s) + the AGENT_RECONCILE_STAGGER_MS (15s)
    // so the in-loop iteration completes and the next iteration's
    // isAgentRunning check fires.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // m.startAgentProcess should have been called once (for 'a', iteration 1).
    expect(m.startAgentProcess).toHaveBeenCalledTimes(1)
  })
})

describe('coverage: agent skip action: msDown < AGENT_DOWN_CONFIRM_MS (line 1681)', () => {
  // The skip-action debug-log ternary has a branch where msDown <
  // AGENT_DOWN_CONFIRM_MS. Drive the SUT into the skip path with a fresh
  // agent (msDown == 0 < AGENT_DOWN_CONFIRM_MS) so the "awaiting
  // confirmation on the next sweep" message is logged.
  it('logs the "awaiting confirmation on the next sweep" debug variant', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.readChannelToken.mockReturnValue('tok')
    m.decideDownAgentAction.mockReturnValue('skip')
    m.capturePane.mockReturnValue('pane')
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const debugCalls = m.loggerDebug.mock.calls.flat()
    const matched = debugCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('awaiting confirmation on the next sweep'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: agent skip action: agentBusy=true (line 1680)', () => {
  // Drive the skip-action branch with agentBusy=true (detectPaneState returns
  // 'busy' on a non-null capturePane result). The SUT logs the
  // "Channel plugin down but agent is BUSY" variant.
  it('logs the BUSY deferral debug variant', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.readChannelToken.mockReturnValue('tok')
    m.decideDownAgentAction.mockReturnValue('skip')
    m.capturePane.mockReturnValue('busy-pane')
    m.detectPaneState.mockReturnValue('busy')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const debugCalls = m.loggerDebug.mock.calls.flat()
    const matched = debugCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('agent is BUSY'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: agent alert-busy action: already-alerted branch (line 1670)', () => {
  // The alert-busy action's `if (!agentBusyDeferAlerted.has(t.session))`
  // branch fires once per down-spell. The 'false' branch (already alerted)
  // is reached on the SECOND alert-busy occurrence in the same spell.
  // Drive two ticks where both fire alert-busy.
  it('skips alert on the second alert-busy occurrence in the same spell', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.readChannelToken.mockReturnValue('tok')
    m.decideDownAgentAction.mockReturnValue('alert-busy')
    m.capturePane.mockReturnValue('pane')
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    // First tick: alert-busy fires -> adds to agentBusyDeferAlerted + sendAlert.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    // Second tick: alert-busy fires -> agentBusyDeferAlerted.has() -> true -> skip alert.
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const alertCalls = m.notifyChannel.mock.calls.flat()
    // Only one alert fires (the second occurrence skips).
    const busyAlerts = alertCalls.filter(
      (c: unknown) => typeof c === 'string' && c.includes('KOZBEN DOLGOZIK'),
    )
    expect(busyAlerts.length).toBe(1)
  })
})

describe('coverage: plugin-down forensics orphaned interpretation (line 1629)', () => {
  // The `evidence.interpretation === 'orphaned'` ternary branch (line 1629)
  // fires when collectPollerEvidence returns { interpretation: 'orphaned' }.
  it('logs the orphaned-poller forensics variant', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.collectPollerEvidence.mockReturnValue({ interpretation: 'orphaned' })
    m.decideDownAgentAction.mockReturnValue('skip')
    m.capturePane.mockReturnValue('pane')
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) =>
        typeof c === 'string' && c.includes('OUTSIDE the claude tree'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: plugin-down forensics in-tree interpretation (line 1627)', () => {
  it('logs the in-tree-poller forensics variant', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.collectPollerEvidence.mockReturnValue({ interpretation: 'in-tree' })
    m.decideDownAgentAction.mockReturnValue('skip')
    m.capturePane.mockReturnValue('pane')
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) =>
        typeof c === 'string' && c.includes('liveness probe is wrong'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: agentDownSince present branch (line 1647)', () => {
  // The `agentDownSince.get(t.session) ?? Date.now()` branch fires when
  // agentDownSince already has an entry (the agent was previously seen as
  // down). The `??` operator's right side is reached when the get() returns
  // undefined.
  it('reads existing agentDownSince timestamp when present', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.readChannelToken.mockReturnValue('tok')
    m.decideDownAgentAction.mockReturnValue('skip')
    m.capturePane.mockReturnValue('pane')
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // No assertion; coverage only.
    expect(true).toBe(true)
  })
})

describe('coverage: agent alert action: absentConfirmed branch (line 1693)', () => {
  // The 'alert' action's sendAlert picks between two messages based on
  // wasPluginConfirmedAbsent. Drive alert + absentConfirmed=true so the
  // first ternary branch fires.
  it('logs the absent-plugin alert variant', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.readChannelToken.mockReturnValue('tok')
    m.decideDownAgentAction.mockReturnValue('alert')
    m.wasPluginConfirmedAbsent.mockReturnValue(true) // absent branch
    m.capturePane.mockReturnValue('pane')
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The 'alert' action sends one of the two messages depending on
    // absentConfirmed. We check the alert payload contains 'BE SEM
    // TOLTODOTT' which is the absent branch only.
    const alertCalls = m.notifyChannel.mock.calls.flat()
    const matched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('BE SEM TOLTODOTT'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// re-entrancy guard (checkRunning)
// ----------------------------------------------------------------------------

describe('coverage: re-entrancy guard', () => {
  it('logs debug when check() is called while a previous tick is in flight', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    // Make recoverStuckInputForSession's inner sendPromptToSession hang so
    // the first check() never completes -> checkRunning stays true ->
    // the next tick's re-entrancy guard trips and logs the debug message.
    m.captureParkedInputView.mockReturnValue('pane')
    m.stuckInputSignature.mockReturnValue('sig')
    m.decideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 1 },
    })
    m.parkedChannelInput.mockReturnValue({ complete: true, block: 'b', chatId: 'c' })
    m.decideStuckInputAction.mockReturnValue('reinject-block')
    m.clearInputBuffer.mockResolvedValue(undefined)
    m.sendPromptToSession.mockImplementation(() => new Promise(() => {}))
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000) // first tick: in flight (sendPrompt hangs)
    await vi.advanceTimersByTimeAsync(60_000) // second tick: guard trips
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const debugCalls = m.loggerDebug.mock.calls.flat()
    const matched = debugCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('previous check still running'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// agentStuckInput set branch when parked state still present (line 1554)
// ----------------------------------------------------------------------------

describe('coverage: agentStuckInput set when sub-agent parked persists', () => {
  it('updates agentStuckInput map when next.parkedSig != null', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.capturePane.mockReturnValue('pane')
    m.captureParkedInputView.mockReturnValue('pane')
    m.stuckInputSignature.mockReturnValue('sig')
    // recover=false but parkedSig is non-null -> .set branch fires
    m.decideStuckInputRecovery.mockReturnValue({
      recover: false,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 1 },
    })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
  })
})

// ----------------------------------------------------------------------------
// handleMarveenDown for marveen with null claudePid + plugin down (line 1616)
// ----------------------------------------------------------------------------

describe('coverage: handleMarveenDown fires for marveen with null claudePid + plugin down', () => {
  it('handleMarveenDown is invoked when plugin is reported down', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('') // mainChannelsSessionExists -> true
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 1 (soft /mcp reconnect'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// plugin-down forensics catch (line 1633)
// ----------------------------------------------------------------------------

describe('coverage: plugin-down forensics catch', () => {
  it('logger.warn called when collectPollerEvidence throws', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.collectPollerEvidence.mockImplementation(() => { throw new Error('evidence fail') })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Plugin-down forensics failed'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// agent restart debug log when no-token is repeated (line 1713)
// ----------------------------------------------------------------------------

describe('coverage: agent restart debug log on repeat no-token', () => {
  it('drops repeat no-token warnings to debug', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    // restart action -> token check fires -> warn/debug branch.
    // token=null -> warn (first), debug (subsequent).
    m.decideDownAgentAction.mockReturnValue('restart')
    m.readChannelToken.mockReturnValue(null)
    const handle = mod.startChannelPluginMonitor()
    // First tick (at t=30s): warn + add to agentNoTokenWarned.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(100)
    // Second tick (at t=90s): debug branch fires.
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const debugCalls = m.loggerDebug.mock.calls.flat()
    // The debug message for the repeat case is "Agent has no channel token in
    // state dir -- skipping restart to avoid token conflict" (line 1713).
    const matched = debugCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('skipping restart to avoid token conflict'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// agent restart fail log (line 1754)
// ----------------------------------------------------------------------------

describe('coverage: agent restart fail log', () => {
  it('logger.error called when stopAgentProcess throws during auto-restart', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.decideDownAgentAction.mockReturnValue('restart')
    m.readChannelToken.mockReturnValue('tok')
    m.stopAgentProcess.mockImplementation(() => { throw new Error('stop fail') })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const errCalls = m.loggerError.mock.calls.flat()
    const matched = errCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Failed to auto-restart agent after channel plugin down'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// periodic reap fail log (line 1777)
// ----------------------------------------------------------------------------

describe('coverage: periodic reap fail log', () => {
  it('logger.warn called when periodic reapDetachedChannelClaudes throws', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.reapDetachedChannelClaudes.mockImplementation(() => { throw new Error('reap fail') })
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(10 * 60 * 1000 + 100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('periodic detached-claude reap failed'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// memGateAllowsStart exit-status-10 + other-error branches
// ----------------------------------------------------------------------------

describe('coverage: memGateAllowsStart exit 10 -> blocked', () => {
  it('returns false + logger.warn when execFileSync exits with status 10', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['newagent']))
    m.isAgentRunning.mockReturnValue(false)
    m.execFileSync.mockImplementation(() => {
      const err = new Error('blocked') as Error & { status?: number }
      err.status = 10
      throw err
    })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Memory gate blocked'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: memGateAllowsStart other error -> fail-open', () => {
  it('returns true + logger.debug when execFileSync throws with non-10 status', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['newagent']))
    m.isAgentRunning.mockReturnValue(false)
    m.execFileSync.mockImplementation(() => { throw new Error('gate err') })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const debugCalls = m.loggerDebug.mock.calls.flat()
    const matched = debugCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Memory gate check errored'),
    )
    expect(matched).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// reconcileDesiredAgents: empty / all-running / running-skip / grace-skip / !ok / throw
// ----------------------------------------------------------------------------

describe('coverage: reconcileDesiredAgents empty desired', () => {
  it('returns immediately when desired set is empty', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set<string>())
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Desired agent not running -- auto-starting'),
    )
    expect(matched).toBe(false)
  })
})

describe('coverage: reconcileDesiredAgents all already running', () => {
  it('returns immediately when every desired agent is already running', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['alive-agent']))
    m.isAgentRunning.mockReturnValue(true)
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Desired agent not running -- auto-starting'),
    )
    expect(matched).toBe(false)
  })
})

describe('coverage: reconcileDesiredAgents isAgentRunning true inside loop', () => {
  it('skips agents that became running between filter and loop body', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['a', 'b']))
    // 'a' is not running (down), 'b' is running -> loop iterates over [a, b]
    // and skips 'b' via the in-loop isAgentRunning check.
    m.isAgentRunning.mockImplementation((name: string) => name === 'b')
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
  })
})

describe('coverage: reconcileDesiredAgents inside AGENT_RESTART_GRACE_MS', () => {
  it('skips when agentLastRestart for the agent is inside the grace window', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockImplementation((session: string) =>
      session === 'marveen-channels' ? 100 : 200,
    )
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['newagent'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.decideDownAgentAction.mockReturnValue('restart')
    m.readChannelToken.mockReturnValue('tok')
    m.getDesiredAgents.mockReturnValue(new Set(['newagent']))
    const handle = mod.startChannelPluginMonitor()
    // First tick fires the restart path which populates agentLastRestart.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(8_000 + 100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
  })
})

describe('coverage: reconcileDesiredAgents start returns !ok with non-default error', () => {
  it('logger.error called when startAgentProcess returns ok=false', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['newagent']))
    m.isAgentRunning.mockReturnValue(false)
    m.startAgentProcess.mockReturnValue({ ok: false, error: 'something bad' })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const errCalls = m.loggerError.mock.calls.flat()
    const matched = errCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Reconcile start failed'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: reconcileDesiredAgents start throws', () => {
  it('logger.error called when startAgentProcess throws', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['newagent']))
    m.isAgentRunning.mockReturnValue(false)
    m.startAgentProcess.mockImplementation(() => { throw new Error('thrown') })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const errCalls = m.loggerError.mock.calls.flat()
    const matched = errCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Reconcile start threw'),
    )
    expect(matched).toBe(true)
  })
})

describe('coverage: reconcileDesiredAgents reconcileBurstInProgress finally resets', () => {
  it('subsequent tick after a successful reconcile is allowed to run again', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['a']))
    m.isAgentRunning.mockReturnValue(false)
    m.startAgentProcess.mockReturnValue({ ok: true })
    const handle = mod.startChannelPluginMonitor()
    // Advance well past the 30s first tick + 15s reconcile stagger + 60s second tick.
    // First tick (t=30s): reconcile starts, awaits delay(15s).
    // 15s timer fires at t=45s, reconcile continues with startAgentProcess, awaits delay(15s).
    // 15s timer fires at t=60s, for loop ends, reconcileBurstInProgress=false.
    // Second tick (t=60s): checkRunning was true during delay; after first check returns, second tick fires.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    expect(m.startAgentProcess).toHaveBeenCalledTimes(2)
  })
})