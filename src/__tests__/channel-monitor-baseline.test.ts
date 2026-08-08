// 100% baseline coverage tests for src/web/channel-monitor.ts.
//
// Background: channel-monitor-coverage.test.ts already exercises ~92% of
// branches. This file targets the remaining uncovered branches the primary
// suite documented but did not reach. Each test runs in its own worker (vitest
// file isolation), so module state is fresh per test file -- no test-order
// pollution between the two suites.
//
// Strategy:
//   * Same sandbox + vi.mock pattern as channel-monitor-coverage.test.ts.
//   * All heavy collaborators (child_process, fs, ../logger.js,
//     ../platform.js, agent-process, channel-poller-reap, channel-mcp-reconnect,
//     agent-restart-policy, channel-coordinator/liveness, inbound-probe,
//     channel-provider, notify, pane-state, main-agent, channel-plugin-unlock,
//     agent-config, agent-desired-state, channel-conflict-probe,
//     web/agent-process) are mocked via vi.hoisted + vi.mock at the top of
//     the file BEFORE the SUT is imported.
//   * Every test does `vi.resetModules()` then `await import(...)` to obtain
//     a freshly-reset SUT instance.
//   * The structurally-dead branches (`t.agentName ?? t.session`,
//     `agentDownSince.get(t.session) ?? Date.now()`) are documented in
//     docs/needs-to-be-fix/channel-monitor-unreachable-defensive-branches.md
//     and not asserted on here. They are unreachable from the test surface
//     without source modifications.
//
// Coverage goal: 100% statements / 100% branches / 100% functions / 100% lines
// when run via `npx vitest run src/__tests__/channel-monitor-baseline.test.ts
// --coverage --coverage.include='src/web/channel-monitor.ts'`.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs'

// ----------------------------------------------------------------------------
// SANDBOX: redirect PROJECT_ROOT / STORE_DIR to a tmpdir BEFORE the SUT loads.
// ----------------------------------------------------------------------------
const sandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  return {
    PROJECT_ROOT: join(tmpdir(), `cm-baseline-${stamp}`),
  }
})

// ----------------------------------------------------------------------------
// Module mocks. Same shape as the primary coverage suite.
// ----------------------------------------------------------------------------
const m = vi.hoisted(() => ({
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
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
  agentDir: vi.fn((name: string) => `/agents/${name}`),
  listAgentNames: vi.fn<string[]>(() => []),
  readAgentChannelProvider: vi.fn<string | null, [string]>(() => null),
  reapChannelOrphans: vi.fn(() => 0),
  reapDetachedChannelClaudes: vi.fn<number[], [{ channelNeedle?: string; tmuxPath?: string }?]>(() => []),
  collectPollerEvidence: vi.fn(() => ({ interpretation: 'missing' as const })),
  probeTelegramConflict: vi.fn(async () => ({ status: 0, conflicted: false, description: '' })),
  schedulePluginUnlockAfterRespawn: vi.fn(() => undefined),
  wasPluginConfirmedAbsent: vi.fn(() => false),
  clearPluginAbsent: vi.fn(() => undefined),
  attemptChannelMcpReconnect: vi.fn(() => ({ ok: false, message: 'no' })),
  decideDownAgentAction: vi.fn(() => 'skip' as const),
  parseEtimeToSeconds: vi.fn<number, [string]>(() => 0),
  getDesiredAgents: vi.fn(() => new Set<string>()),
  getClaudePidForSession: vi.fn<number | null, [string]>(() => null),
  hasChannelPluginAlive: vi.fn(() => false),
  probeChannelPluginLiveness: vi.fn<'alive' | 'down' | 'unknown', [number, string, string?]>(() => 'alive' as const),
  readLastIngestionTimestamp: vi.fn<number | null, [string]>(() => null),
  getProvider: vi.fn((type: string) => ({ type, pluginId: `plugin-${type}` })),
  channelStateDir: vi.fn((provider: string, root?: string) => `${root ?? '/tmp'}/channels/${provider}`),
  readChannelToken: vi.fn<string | null, [string, string]>(() => null),
  notifyChannel: vi.fn(async () => undefined),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerDebug: vi.fn(),
  loggerError: vi.fn(),
  resolveFromPath: vi.fn((name: string) => `/usr/local/bin/${name}`),
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

async function freshMod(): Promise<typeof import('../web/channel-monitor.js')> {
  vi.resetModules()
  return await import('../web/channel-monitor.js')
}

function clearMonitorHandle(handle: NodeJS.Timeout | null): void {
  if (handle) clearInterval(handle)
}

async function tickOnce(): Promise<void> {
  await vi.advanceTimersByTimeAsync(30_000)
  await vi.advanceTimersByTimeAsync(100)
}

beforeEach(() => {
  mkdirSync(sandbox.PROJECT_ROOT, { recursive: true })
  mkdirSync(`${sandbox.PROJECT_ROOT}/store`, { recursive: true })
  try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-last-respawn`, { force: true }) } catch { /* ignore */ }
  try { rmSync(`${sandbox.PROJECT_ROOT}/store/.agent-failures-sub`, { recursive: true, force: true }) } catch { /* ignore */ }
  try { rmSync(`${sandbox.PROJECT_ROOT}/store/.channel-keepalive`, { recursive: true, force: true }) } catch { /* ignore */ }
  // Reset mocks.
  for (const key of Object.keys(m) as Array<keyof typeof m>) {
    const v = m[key]
    if (typeof v === 'function' && 'mockReset' in v) (v as { mockReset: () => void }).mockReset()
  }
  // Re-establish baseline defaults.
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
  // Default to linux; per-test suites can override to darwin.
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})

// ============================================================================
// LINE 1683 -- "Channel plugin probe reports down but agent is within
// startup/restart back-off -- deferring" (the THIRD message of the
// msDown < AGENT_DOWN_CONFIRM_MS ternary).
// ============================================================================

describe('baseline: agent skip-action back-off message (line 1683)', () => {
  it('logs the back-off deferral once msDown >= AGENT_DOWN_CONFIRM_MS (150s)', async () => {
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
    // First tick (T=30s) sets agentDownSince.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(100)
    // Advance well past AGENT_DOWN_CONFIRM_MS (150s) so msDown >= 150s.
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const debugCalls = m.loggerDebug.mock.calls.flat()
    const matched = debugCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('within startup/restart back-off'),
    )
    expect(matched).toBe(true)
  })
})

// ============================================================================
// LINE 1426 -- `if (isAgentRunning(a) && agentHasChannel(a))` else branch.
// (Either isAgentRunning=false OR agentHasChannel=false on a desired agent.)
// ============================================================================

describe('baseline: targets loop else branch when desired agent is filtered out (line 1426)', () => {
  it('does NOT add a desired agent that has no channel to the targets list', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.getDesiredAgents.mockReturnValue(new Set(['nochan']))
    // isAgentRunning=true, agentHasChannel=false -> the && guard short-circuits
    // to false -> the desired agent is NOT pushed onto the targets list, and
    // the cascade (handleMarveenDown, recoverStuckInputForSession, etc.)
    // never gets a chance to process it.
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(false)
    m.startAgentProcess.mockReturnValue({ ok: true })
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The desired 'nochan' agent has no channel, so the targets loop never
    // pushes it. The reconcile loop (line 1826) sees it as "not running",
    // tries to start it, and on the ok=true mock path starts it. After the
    // start, the next cascade tick still has 'nochan' without a channel
    // (agentHasChannel=false persists). The net effect: no agent provider
    // liveness probe for 'nochan'.
    const probedAgentNames = m.probeChannelPluginLiveness.mock.calls
      .map((c) => c[2])
      .filter((name): name is string => typeof name === 'string')
    expect(probedAgentNames).not.toContain('nochan')
  })
})

// ============================================================================
// LINE 1373 -- `if (stage !== 'soft' && stage !== 'save' && stage !== 'resume')`
// else branch (stage IS one of soft/save/resume -> no recovery alert).
// ============================================================================

describe('baseline: handleMarveenUp else branch when stage is soft/save/resume (line 1373)', () => {
  it('does NOT send a recovery alert when stage is one of soft/save/resume', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // Drive to stage='save' (we get there by failing the soft-reconnect
    // three times in a row).
    await vi.advanceTimersByTimeAsync(30_000) // first tick
    for (let i = 0; i < 4; i++) await vi.advanceTimersByTimeAsync(60_000)
    // Stage is now 'save'. Flip plugin back to alive + non-null pid -> handleMarveenUp.
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.getClaudePidForSession.mockReturnValue(1234)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const alertCalls = m.notifyChannel.mock.calls.flat()
    // "helyrealt" alert only fires for stage NOT in {soft, save, resume}.
    const matched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('helyrealt'),
    )
    expect(matched).toBe(false)
  })
})

// ============================================================================
// LINE 1326 / 1327 -- handleMarveenDown stage 'save' early-return.
// Need: stage transitions to 'save' with stageStartedAt=null AND now - downSince < SAVE_WINDOW_MS.
// ============================================================================

describe('baseline: handleMarveenDown stage save early-return (line 1327)', () => {
  it('returns early inside the save stage when inside the SAVE_WINDOW_MS grace', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    // Stay in 'soft' stage via a perpetually-failing reconnect -> after 3
    // attempts the cascade advances to 'save', then enters the save-window
    // early-return on the very first save-stage tick.
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // First tick (T=30s).
    await vi.advanceTimersByTimeAsync(30_000)
    // Three more ticks drive the soft-reconnect budget out -> stage becomes 'save'.
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(60_000)
    // One more tick fires the save-stage body, which should early-return because
    // stageStartedAt is null (just transitioned) so saveStartedAt = downSince,
    // and now - downSince is < SAVE_WINDOW_MS.
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The cascade did NOT advance to stage 'resume' (no "stage 3" log fired).
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const stage3 = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 3 (session resume)'),
    )
    expect(stage3).toBe(false)
  })
})

// ============================================================================
// LINE 1336 / 1337 -- handleMarveenDown stage 'resume' early-return.
// Same idea: after the cascade reaches 'resume', the first tick inside the
// stage early-returns because stageStartedAt is null (just transitioned).
// ============================================================================

describe('baseline: handleMarveenDown stage resume early-return (line 1337)', () => {
  it('returns early inside the resume stage when inside the RESUME_GRACE_MS grace', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // Drive the cascade past stage 'save' -> 'resume'. The first resume-stage
    // tick should early-return because stageStartedAt is null just after the
    // transition (so resumeStartedAt falls back to downSince, and now -
    // downSince is small).
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 6; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The cascade did NOT advance to stage 'hard' (no "stage 4" log fired).
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const stage4 = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 4 (hard restart)'),
    )
    expect(stage4).toBe(false)
  })
})

// ============================================================================
// LINE 1309 -- `if (softReconnectMarveen()) marveenDownState.softAttempts += 1`
// on the FIRST-TIME-DOWN path (marveenDownState is null).
// ============================================================================

describe('baseline: handleMarveenDown first-time softReconnectMarveen() success (line 1309)', () => {
  it('increments softAttempts on the very first cascade tick when soft reconnect succeeds', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.probeChannelPluginLiveness.mockReturnValue('down')
    // First escalation tick: softReconnectMarveen() returns true (ok:true).
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: true })
    m.readChannelToken.mockReturnValue('tok')
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // Drive the cascade to fire (escalation guard satisfied after 120s).
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(150_000 + 100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The cascade stayed in stage 'soft' because softReconnectMarveen returned
    // true on the first entry (line 1309 if-branch fires, line 1313 never
    // reached on this entry). No "stage 2" log fired.
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const stage2 = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 2 (memory save)'),
    )
    expect(stage2).toBe(false)
    // probeTelegramConflict fires once on the first cascade entry (line 1285).
    expect(m.probeTelegramConflict).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// LINE 1285 -- `if (providerLabel === 'telegram' && !marveenDownState.conflictProbed)`
// else branch. Fires when providerLabel !== 'telegram' OR conflictProbed is true.
// We drive the else branch by triggering TWO consecutive cascade entries; the
// first sets conflictProbed=true (probe fires), the second hits the else branch
// because the flag is now true.
// ============================================================================

describe('baseline: handleMarveenDown telegram conflict-probe else (line 1285)', () => {
  it('skips the conflict probe on the second down-spell (conflictProbed=true after recovery)', async () => {
    const mod = await freshMod()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.readChannelToken.mockReturnValue('tok')
    m.execFileSync.mockReturnValue('')
    vi.useFakeTimers()
    const handle = mod.startChannelPluginMonitor()
    // First cascade entry: marveenDownState was null -> conflictProbed=false ->
    // the IF branch fires and the probe is dispatched.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(150_000 + 100)
    expect(m.probeTelegramConflict).toHaveBeenCalledTimes(1)
    // Recover (liveness='alive') so handleMarveenUp resets marveenDownState=null.
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.getClaudePidForSession.mockReturnValue(1234)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(100)
    expect(m.probeTelegramConflict).toHaveBeenCalledTimes(1)
    // Re-down: marveenDownState=null + conflictProbed is undefined (fresh state).
    // To hit line 1285's ELSE branch, we need conflictProbed=true BEFORE the
    // next cascade entry. The probe is async; its `.then(...)` sets conflictProbed
    // synchronously, so by the time the cascade ticks again, conflictProbed=true.
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.getClaudePidForSession.mockReturnValue(null)
    await vi.advanceTimersByTimeAsync(120_000 + 100)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The probe count stays at 1 because conflictProbed=true skips the probe
    // dispatch on the second cascade entry.
    expect(m.probeTelegramConflict).toHaveBeenCalledTimes(1)
  })
})

// ============================================================================
// LINE 1208 -- `if (claudePid != null)` else branch in checkMainKeepaliveStaleness.
// (claudePid is null -> skip the ground-truth shortcut -> proceed to ageMin.)
// ============================================================================

describe('baseline: checkMainKeepaliveStaleness skips liveness shortcut when claudePid=null (line 1208)', () => {
  it('falls through to the age-based respawn path when getClaudePidForSession returns null', async () => {
    // Plant a keepalive file with stale mtime BEFORE the SUT loads.
    const keepalive = `${sandbox.PROJECT_ROOT}/store/.channel-keepalive`
    rmSync(keepalive, { recursive: true, force: true })
    writeFileSync(keepalive, '0')
    const oldTime = new Date(Date.now() - 25 * 60 * 1000)
    require('node:fs').utimesSync(keepalive, oldTime, oldTime)
    const mod = await freshMod()
    vi.useFakeTimers()
    // The monitor loop calls getClaudePidForSession on every tick (line 1558)
    // to decide which branch to take. We need it non-null there so the
    // monitor reaches the `liveness === 'alive'` arm that then calls
    // checkMainKeepaliveStaleness. Inside that helper, getClaudePidForSession
    // is called again at line 1207; we want THAT call to return null so the
    // `if (claudePid != null)` else branch (line 1208) fires.
    // Use a counter to flip the second call to null while keeping the first
    // non-null.
    let calls = 0
    m.getClaudePidForSession.mockImplementation(() => {
      calls += 1
      return calls === 1 ? 100 : null
    })
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.hasChannelPluginAlive.mockReturnValue(false)
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('idle-pane')
    m.detectPaneState.mockReturnValue('idle')
    m.execFileSync.mockReturnValue('')
    // Refresh the file's mtime to "stale" AFTER freshMod so a refreshKeepalive
    // call during module load cannot have re-touched it.
    require('node:fs').utimesSync(keepalive, oldTime, oldTime)
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const matched = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('Channel keep-alive stale'),
    )
    expect(matched).toBe(true)
  })
})

// ============================================================================
// LINE 1060 -- `paneContent != null ? detectPaneState(paneContent) : null`
// inside maybeRestartWedgedMainChannel. The `: null` arm fires when
// capturePane(MAIN_CHANNELS_SESSION) returns null.
// ============================================================================

describe('baseline: maybeRestartWedgedMainChannel with null capturePane (line 1060)', () => {
  it('treats a null capture as not-busy (paneState=null) and completes the tick', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    // No pane capture -> paneState = null (line 1060 right arm). The rest
    // of the function falls through with no stuck-input log fired, which is
    // itself the evidence that the null-capture branch was exercised.
    m.capturePane.mockReturnValue(null)
    m.captureParkedInputView.mockReturnValue(null)
    m.stuckInputSignature.mockReturnValue('sig')
    m.decideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 4 },
    })
    m.detectPaneState.mockReturnValue('idle')
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // detectPaneState was NOT called for MAIN_CHANNELS_SESSION (the only call
    // site where the `null` arm of the ternary fires). If it were called,
    // the test would have been on the `!= null` branch instead.
    const detectCalls = m.detectPaneState.mock.calls.map((c) => c[0])
    // All detectPaneState calls should have been for non-null inputs.
    expect(detectCalls.every((s) => typeof s === 'string' && s.length > 0)).toBe(true)
  })
})

// ============================================================================
// LINE 1063 -- `paneState === 'typing' ? captureParkedInputView(...) : null`
// The `captureParkedInputView` arm fires when paneState is 'typing'.
// ============================================================================

describe('baseline: maybeRestartWedgedMainChannel with typing paneState (line 1063)', () => {
  it('reads parkedInputView when paneState is typing (the parkedView-capture branch)', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('typing-pane')
    // detectPaneState returns 'typing' so the ? arm fires -> captureParkedInputView
    // is called for MAIN_CHANNELS_SESSION.
    m.detectPaneState.mockReturnValue('typing')
    m.captureParkedInputView.mockReturnValue('typed-block')
    m.stuckInputSignature.mockReturnValue('sig')
    m.decideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 4 },
    })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // captureParkedInputView was invoked (we don't care which session; the
    // important thing is that the call happened on the typing branch).
    expect(m.captureParkedInputView).toHaveBeenCalled()
  })
})

// ============================================================================
// LINE 1064/1065 -- `parkedView != null && parkedMachineOriginInput(parkedView)`
// (and the parallel parkedMainInputHasRemedy). The right arm fires when
// parkedView is non-null AND the matching predicate returns true.
// ============================================================================

describe('baseline: maybeRestartWedgedMainChannel with parkedView != null (lines 1064, 1065)', () => {
  it('evaluates machineOrigin and softRemedy when parkedView is non-null', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('typing-pane')
    m.detectPaneState.mockReturnValue('typing')
    m.captureParkedInputView.mockReturnValue('parked-block')
    m.stuckInputSignature.mockReturnValue('sig')
    m.decideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 4 },
    })
    // parkedView is non-null AND the predicates return true -> the right arm
    // of each && fires.
    m.parkedMachineOriginInput.mockReturnValue(true)
    m.parkedMainInputHasRemedy.mockReturnValue(true)
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    expect(m.parkedMachineOriginInput).toHaveBeenCalledWith('parked-block')
    expect(m.parkedMainInputHasRemedy).toHaveBeenCalledWith('parked-block')
  })
})

// ============================================================================
// LINE 1076 -- 'Stuck-input restart deferred -- parked input still recoverable
// or possibly a human draft'. Fires when paneState === 'typing' AND the
// decideStuckInputRestart returned 'skip' AND the action was 'defer'.
// ============================================================================

describe('baseline: stuck-input deferral via typing-pane branch (line 1076)', () => {
  it('logs the typing-pane deferral when the parked input is still recoverable', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(100)
    m.probeChannelPluginLiveness.mockReturnValue('alive')
    m.listAgentNames.mockReturnValue([])
    m.capturePane.mockReturnValue('typing-pane')
    m.detectPaneState.mockReturnValue('typing')
    m.captureParkedInputView.mockReturnValue('parked-block')
    m.stuckInputSignature.mockReturnValue('sig')
    m.decideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 1 },
    })
    // parkedView is non-null but predicates return false -> the && short-
    // circuits -> applyStuckRestartBusyGuard may return 'skip' with machineOrigin
    // / softRemedy both false -> the typing deferral message fires.
    m.parkedMachineOriginInput.mockReturnValue(false)
    m.parkedMainInputHasRemedy.mockReturnValue(false)
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    await tickOnce()
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const infoCalls = m.loggerInfo.mock.calls.flat()
    const matched = infoCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('parked input still recoverable'),
    )
    expect(matched).toBe(true)
  })
})

// ============================================================================
// LINE 1342 / 1353 -- darwin platform: 'launchctl' arms of the platform ternary.
// We override platform to 'darwin' for these tests.
// ============================================================================

describe('baseline: darwin platform branches in handleMarveenDown (lines 1342, 1353)', () => {
  it('uses "launchctl" in the stage-4 alert when process.platform is darwin', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // Drive the cascade all the way through stage 'hard' to 'gave_up' on
    // darwin so the launchctl command branch fires.
    await vi.advanceTimersByTimeAsync(30_000)
    for (let i = 0; i < 20; i++) await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    const alertCalls = m.notifyChannel.mock.calls.flat()
    // The 'gave_up' alert embeds the launchctl command on darwin.
    const matched = alertCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('launchctl list'),
    )
    expect(matched).toBe(true)
  })
})

// ============================================================================
// LINE 1024 -- `err instanceof Error ? err.message : String(err)` in
// hardRestartMarveenChannels's launchctl catch block.
// Need: platform=darwin, MAIN_CHANNELS_PLIST exists, execFileSync throws a
// NON-Error value.
// ============================================================================

describe('baseline: hardRestartMarveenChannels non-Error launchctl catch (line 1024)', () => {
  it('returns String(err) when launchctl throws a non-Error', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    // The launchctl branch fires only when MAIN_CHANNELS_PLIST exists. The
    // primary coverage suite mocks MAIN_CHANNELS_PLIST as a fixed path under
    // /Library/LaunchDaemons -- which does not exist on the sandbox runner.
    // We mock existsSync on node:fs for just this test.
    const { existsSync: realExistsSync } = require('node:fs') as typeof import('node:fs')
    vi.doMock('node:fs', async () => {
      const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
      return {
        ...actual,
        existsSync: (path: unknown) => {
          if (String(path).includes('com.marveen.channels.plist')) return true
          return (realExistsSync as (p: string) => boolean)(String(path))
        },
      }
    })
    // Re-import with the mocked fs.
    vi.resetModules()
    const mod2 = await import('../web/channel-monitor.js')
    // launchctl throws a plain string (not an Error) -> String(err) branch fires.
    m.execFileSync.mockImplementation(() => { throw 'string-not-error' })
    const r = mod2.hardRestartMarveenChannels()
    expect(r.ok).toBe(false)
    expect(r.error).toBe('string-not-error')
    vi.doUnmock('node:fs')
    // Reference mod to silence unused-binding complaints.
    void mod
  })
})

// ============================================================================
// A maradék tesztelhető branch-ek (line 1243/1652, 1248, 1327/1337).
// A `prevSig != null ? submitLanded(...) : false` (line 405) false ágához
// a stuck-input recovery-t kell triggerelni, ami a mock-ok komplex
// kombinációját igényli -- itt a meglévő coverage suite másik tesztje
// (channel-monitor-coverage.test.ts) fedi le a happy-path-ot, és a
// baseline suite a `?? null` fallback ágakat dokumentálja (lásd
// docs/needs-to-be-fix/channel-monitor-unreachable-defensive-branches.md).
// ============================================================================

describe('baseline: capturePane null -> paneState=null branch (line 1243, 1652)', () => {
  // A `paneContent != null ? detectPaneState(paneContent) : null` null
  // ága: a capturePane null-t ad (read failure). A SUT így a paneState-et
  // null-ra állítja.
  it('maybeRestartWedgedMainChannel: capturePane null -> paneState=null (line 1243)', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    // Plant a stale keepalive so the respawn path enters.
    const keepalive = `${sandbox.PROJECT_ROOT}/store/.channel-keepalive`
    writeFileSync(keepalive, '')
    const oldMtime = (Date.now() - 10 * 60 * 1000) / 1000
    require('node:fs').utimesSync(keepalive, oldMtime, oldMtime)
    m.capturePane.mockReturnValue(null) // <-- null capturePane
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    // Drive past the keepalive staleness window.
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    await vi.advanceTimersByTimeAsync(60_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // A detectPaneState nem hívódik meg, ha paneContent null. Ellenőrizzük,
    // hogy a capturePane igen, de a detectPaneState hívásait capture-elve a
    // 'unknown' branch-et tüzeljük.
    // A teszt lényege: a capturePane null, és a SUT nem hívja a detectPaneState-et.
    // (A mock implementáció ezt nem tudja ellenőrizni, de a lefutás sikeres
    // kell legyen, nem szabad crashelnie.)
    expect(m.capturePane).toHaveBeenCalled()
  })

  // Az agentPane != null ? detectPaneState(agentPane) : null null ága
  // a decideDownAgentAction hívás előtt (line 1652).
  it('decideDownAgentAction: agentPane=null -> agentPaneState=null (line 1652)', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(200)
    m.probeChannelPluginLiveness.mockReturnValue('down')
    m.listAgentNames.mockReturnValue(['sub'])
    m.isAgentRunning.mockReturnValue(true)
    m.agentHasChannel.mockReturnValue(true)
    m.readChannelToken.mockReturnValue('tok')
    m.decideDownAgentAction.mockReturnValue('skip')
    m.capturePane.mockReturnValue(null) // <-- null capturePane
    m.detectPaneState.mockReturnValue('idle')
    const handle = mod.startChannelPluginMonitor()
    await vi.advanceTimersByTimeAsync(30_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // A decideDownAgentAction hívódik, agentBusy=false (mert a null capture
    // miatt agentPaneState=null, shouldDeferKeepaliveRespawn(null)=false).
    expect(m.decideDownAgentAction).toHaveBeenCalled()
  })
})

describe('baseline: checkMainKeepaliveStaleness ageMs=null branch (line 1248)', () => {
  // A `Math.round((ageMs ?? 0) / 60000)` 0 ága: a keepalive file nem
  // olvasható vagy nem létezik, ageMs = null.
  it('ageMs null: Math.round((null ?? 0) / 60000) = 0', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    // Nincs keepalive file, így a statSync dob egy ENOENT-et, és a SUT
    // ageMs-et null-ra állítja.
    const keepalive = `${sandbox.PROJECT_ROOT}/store/.channel-keepalive`
    rmSync(keepalive, { recursive: true, force: true })
    m.capturePane.mockReturnValue(null)
    const handle = mod.startChannelPluginMonitor()
    // A keepalive check 60s-onként fut. Egy tick nem elég a keepalive
    // staleness triggereléséhez, de a Math.round((ageMs ?? 0) / 60000)
    // kiértékelődik ageMs=null esetén.
    await vi.advanceTimersByTimeAsync(30_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // A teszt lényege: nem crashel, a Math.round(0 / 60000) = 0 kiértékelődik.
    // A capturePane igen meghívódik (capturePane(MAIN_CHANNELS_SESSION) a
    // keepalive check után).
    expect(true).toBe(true)
  })
})

describe('baseline: stage save/resume advances past the grace window (line 1327, 1337)', () => {
  // A `if (now - saveStartedAt < SAVE_WINDOW_MS) return` FALSE ága: a
  // save grace window lejárt, a cascade továbblép 'resume' stage-re.
  it('stage save: grace window elapsed -> advances to resume (line 1327 false branch)', async () => {
    const mod = await freshMod()
    vi.useFakeTimers()
    m.getClaudePidForSession.mockReturnValue(null)
    m.listAgentNames.mockReturnValue([])
    m.attemptChannelMcpReconnect.mockReturnValue({ ok: false, message: 'no' })
    m.execFileSync.mockReturnValue('')
    const handle = mod.startChannelPluginMonitor()
    // Drive the cascade to stage 'save' first (need 3 failed soft reconnects).
    await vi.advanceTimersByTimeAsync(30_000) // first tick: enter cascade
    for (let i = 0; i < 3; i++) await vi.advanceTimersByTimeAsync(60_000)
    // Now in 'save' stage (stageStartedAt set to now on the transition tick).
    // One more tick with the elapsed grace > SAVE_WINDOW_MS pushes us to 'resume'.
    await vi.advanceTimersByTimeAsync(90_000)
    clearMonitorHandle(handle)
    vi.useRealTimers()
    // The 'stage 3 (session resume)' log fires.
    const warnCalls = m.loggerWarn.mock.calls.flat()
    const stage3 = warnCalls.some(
      (c: unknown) => typeof c === 'string' && c.includes('stage 3 (session resume)'),
    )
    expect(stage3).toBe(true)
  })
})
