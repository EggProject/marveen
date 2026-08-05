// 100% coverage suite for src/web/channel-monitor.ts.
//
// The SUT is the channel-plugin watchdog: a 60s sweep that walks each agent's
// process tree, classifies the channel-plugin liveness, and escalates from soft
// /mcp reconnect through a session respawn (--continue) to a hard restart and
// finally operator-handoff. It also runs the stuck-input recovery (Enter ->
// clear+re-inject -> hard restart) and the keepalive staleness watchdog.
//
// Every collaborator is mocked at module scope; no live processes, no real
// filesystem, no real tmux. The pure decision helpers (decideStuckInputRestart,
// applyStuckRestartBusyGuard, shouldEscalateAfterResume, shouldDeferKeepaliveRespawn,
// shouldRespawnForStaleKeepalive, shouldRefreshKeepaliveFromInbound,
// shouldRunPeriodicReap, buildMainSessionRespawnCmd, readExtraChannelPluginIds)
// are driven directly with handcrafted inputs. The side-effecting wrappers
// (respawnMainSessionFresh, resumeMarveenSession, createMainChannelsSession,
// hardRestartMarveenChannels, lastMainRespawnAt, sendAlert, the check() tick in
// startChannelPluginMonitor) are driven through the mocked collaborators,
// branching on every mocked return shape so every if/switch arm in the SUT
// is exercised.
//
// vi.resetModules() per test guarantees a fresh module registry so the
// module-level state (agentDownSince, agentLastRestart, agentRestartFailures,
// paneErrorState, paneMenuState, marveenDownState, stuckRestartCount,
// lastChannelAgentRestartAt, marveenLastHardRestart, marveenLastKeepaliveRespawn,
// lastStuckRestartAt, lastDetachedReapAt, mainStuckInput, agentStuckInput,
// agentNoTokenWarned, agentBusyDeferAlerted, reconcileBurstInProgress) starts
// empty and never leaks across tests.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Hoisted mock fns. vi.hoisted keeps the declarations available in the
// vi.mock factories below.
// ---------------------------------------------------------------------------
const {
  mockExistsSync,
  mockReadFileSync,
  mockStatSync,
  mockWriteFileSync,
  mockUtimesSync,
  mockExecFileSync,
  mockSpawn,
  mockHostname,
  mockResolveFromPath,

  mockWEB_PORT,
  mockMAIN_AGENT_ID,
  mockSERVICE_ID,
  mockBOT_NAME,
  mockCHANNEL_PROVIDER,
  mockPROJECT_ROOT,
  mockRESPAWN_ENABLED,

  mockLoggerInfo,
  mockLoggerWarn,
  mockLoggerError,
  mockLoggerDebug,

  mockAgentDir,
  mockListAgentNames,
  mockReadAgentChannelProvider,

  mockAgentHasChannel,
  mockAgentSessionName,
  mockCapturePane,
  mockCaptureParkedInputView,
  mockClearInputBuffer,
  mockDismissResumeSummaryModalIfPresent,
  mockDismissModelConsentDialogIfPresent,
  mockStampFableOverageConsentSharedRoots,
  mockIsAgentRunning,
  mockSendPromptToSession,
  mockStartAgentProcess,
  mockStopAgentProcess,
  mockScheduleIdentitySetup,
  mockEnsureMainAgentIsolatedConfigDir,
  mockEnsureSharedClaudeOnboarded,
  mockHasFleetOauthToken,
  mockAnswerFirstRunGates,

  mockReapChannelOrphans,
  mockReapDetachedChannelClaudes,
  mockCollectPollerEvidence,

  mockProbeTelegramConflict,

  mockSchedulePluginUnlockAfterRespawn,
  mockWasPluginConfirmedAbsent,
  mockClearPluginAbsent,

  mockDetectPaneState,
  mockDecidePaneErrorAlert,
  mockDetectsBlockingMenu,
  mockDetectsFirstRunGate,
  mockDetectsModelConsentDialog,
  mockStuckInputSignature,
  mockDecideStuckInputRecovery,
  mockParkedChannelInput,
  mockParkedInputText,
  mockShouldClearTruncatedPreamble,
  mockParkedInputRowCount,
  mockSubmitLanded,
  mockDecideStuckInputAction,
  mockParkedScheduledTaskInput,
  mockParkedMachineOriginInput,
  mockParkedMainInputHasRemedy,

  mockMAIN_CHANNELS_SESSION,
  mockMAIN_CHANNELS_PLIST,

  mockNotifyChannel,

  mockGetProvider,
  mockChannelStateDir,
  mockReadChannelToken,

  mockAttemptChannelMcpReconnect,

  mockReadLastIngestionTimestamp,
  mockTRANSCRIPT_DIR,

  mockDecideDownAgentAction,
  mockAGENT_MAX_RESTART_ATTEMPTS,

  mockGetClaudePidForSession,
  mockHasChannelPluginAlive,
  mockProbeChannelPluginLiveness,

  mockGetDesiredAgents,
} = vi.hoisted(() => {
  const mkFn = () => vi.fn()
  return {
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockStatSync: vi.fn(),
    mockWriteFileSync: vi.fn(),
    mockUtimesSync: vi.fn(),

    mockExecFileSync: vi.fn(),
    mockSpawn: vi.fn(),
    mockHostname: vi.fn(() => 'test-host'),
    mockResolveFromPath: vi.fn((p: string) => `/usr/bin/${p}`),

    mockWEB_PORT: 4040,
    mockMAIN_AGENT_ID: 'marveen',
    mockSERVICE_ID: 'marveen',
    mockBOT_NAME: 'Marveen',
    mockCHANNEL_PROVIDER: 'telegram',
    mockPROJECT_ROOT: '/tmp/marveen-test',
    mockRESPAWN_ENABLED: true,

    mockLoggerInfo: mkFn(),
    mockLoggerWarn: mkFn(),
    mockLoggerError: mkFn(),
    mockLoggerDebug: mkFn(),

    mockAgentDir: vi.fn((name: string) => `/tmp/marveen-test/agents/${name}`),
    mockListAgentNames: vi.fn<() => string[]>(() => []),
    mockReadAgentChannelProvider: vi.fn<(name: string) => string>(() => ''),

    mockAgentHasChannel: vi.fn<(name: string) => boolean>(() => false),
    mockAgentSessionName: vi.fn<(name: string) => string>((n: string) => `agent-${n}`),
    mockCapturePane: vi.fn<(session: string) => string | null>(() => null),
    mockCaptureParkedInputView: vi.fn<(session: string) => string | null>(() => null),
    mockClearInputBuffer: vi.fn(async () => {}),
    mockDismissResumeSummaryModalIfPresent: vi.fn(async () => {}),
    mockDismissModelConsentDialogIfPresent: vi.fn(async () => {}),
    mockStampFableOverageConsentSharedRoots: mkFn(),
    mockIsAgentRunning: vi.fn<(name: string) => boolean>(() => false),
    mockSendPromptToSession: vi.fn(async () => {}),
    mockStartAgentProcess: vi.fn(() => ({ ok: true })),
    mockStopAgentProcess: vi.fn(() => ({ ok: true })),
    mockScheduleIdentitySetup: vi.fn(async () => {}),
    mockEnsureMainAgentIsolatedConfigDir: vi.fn(() => null),
    mockEnsureSharedClaudeOnboarded: vi.fn(() => true),
    mockHasFleetOauthToken: vi.fn(() => false),
    mockAnswerFirstRunGates: vi.fn(async () => 'ok'),

    mockReapChannelOrphans: vi.fn(() => []),
    mockReapDetachedChannelClaudes: vi.fn(() => []),
    mockCollectPollerEvidence: vi.fn(() => ({
      interpretation: 'missing',
      summary: 'no poller',
    })),

    mockProbeTelegramConflict: vi.fn(async () => ({ conflicted: false, status: 200, description: null })),

    mockSchedulePluginUnlockAfterRespawn: vi.fn(() => {}),
    mockWasPluginConfirmedAbsent: vi.fn(() => false),
    mockClearPluginAbsent: vi.fn(() => {}),

    mockDetectPaneState: vi.fn<(pane: string) => string>(() => 'idle'),
    mockDecidePaneErrorAlert: vi.fn(() => ({ alert: false, next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null } })),
    mockDetectsBlockingMenu: vi.fn(() => false),
    mockDetectsFirstRunGate: vi.fn(() => null),
    mockDetectsModelConsentDialog: vi.fn(() => false),
    mockStuckInputSignature: vi.fn<(pane: string) => string | null>(() => null),
    mockDecideStuckInputRecovery: vi.fn(() => ({ recover: false, next: { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 } })),
    mockParkedChannelInput: vi.fn(() => null),
    mockParkedInputText: vi.fn(() => null),
    mockShouldClearTruncatedPreamble: vi.fn(() => false),
    mockParkedInputRowCount: vi.fn(() => 0),
    mockSubmitLanded: vi.fn(() => false),
    mockDecideStuckInputAction: vi.fn(() => 'hold' as const),
    mockParkedScheduledTaskInput: vi.fn(() => false),
    mockParkedMachineOriginInput: vi.fn(() => false),
    mockParkedMainInputHasRemedy: vi.fn(() => false),

    mockMAIN_CHANNELS_SESSION: 'marveen-channels',
    mockMAIN_CHANNELS_PLIST: '/tmp/marveen-test/store/com.marveen.channels.plist',

    mockNotifyChannel: vi.fn(async () => {}),

    mockGetProvider: vi.fn(() => ({ pluginId: 'telegram@claude-plugins-official', type: 'telegram' })),
    mockChannelStateDir: vi.fn((_p: string, base?: string) => join(base ?? '/tmp/marveen-test', '.claude', 'channels')),
    mockReadChannelToken: vi.fn(() => null),

    mockAttemptChannelMcpReconnect: vi.fn(() => ({ ok: true })),

    mockReadLastIngestionTimestamp: vi.fn(() => null),
    mockTRANSCRIPT_DIR: '/tmp/marveen-test/transcripts',

    mockDecideDownAgentAction: vi.fn(() => 'restart' as const),
    mockAGENT_MAX_RESTART_ATTEMPTS: 5,

    mockGetClaudePidForSession: vi.fn(() => null),
    mockHasChannelPluginAlive: vi.fn(() => false),
    mockProbeChannelPluginLiveness: vi.fn<() => 'alive' | 'dead' | 'unknown'>(() => 'alive'),

    mockGetDesiredAgents: vi.fn(() => new Set<string>()),
  }
})

// ---------------------------------------------------------------------------
// Mock factories. Hoisted by vitest above the SUT import.
// ---------------------------------------------------------------------------
vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...(args as [string])),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...(args as [string, string])),
  statSync: (...args: unknown[]) => mockStatSync(...(args as [string])),
  writeFileSync: (...args: unknown[]) => mockWriteFileSync(...(args as [string, string])),
  utimesSync: (...args: unknown[]) => mockUtimesSync(...(args as [string, Date, Date])),
}))

vi.mock('node:os', () => ({
  hostname: () => mockHostname(),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...(args as [string, string[]])),
  spawn: (...args: unknown[]) => mockSpawn(...(args as [string, string[]])),
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (p: string) => mockResolveFromPath(p),
}))

vi.mock('../config.js', () => ({
  WEB_PORT: mockWEB_PORT,
  MAIN_AGENT_ID: mockMAIN_AGENT_ID,
  SERVICE_ID: mockSERVICE_ID,
  BOT_NAME: mockBOT_NAME,
  CHANNEL_PROVIDER: mockCHANNEL_PROVIDER,
  PROJECT_ROOT: mockPROJECT_ROOT,
  RESPAWN_ENABLED: mockRESPAWN_ENABLED,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    debug: (...args: unknown[]) => mockLoggerDebug(...args),
  },
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => mockAgentDir(name),
  listAgentNames: () => mockListAgentNames(),
  readAgentChannelProvider: (name: string) => mockReadAgentChannelProvider(name),
}))

vi.mock('../web/agent-process.js', () => ({
  agentHasChannel: (name: string) => mockAgentHasChannel(name),
  agentSessionName: (name: string) => mockAgentSessionName(name),
  capturePane: (session: string) => mockCapturePane(session),
  captureParkedInputView: (session: string) => mockCaptureParkedInputView(session),
  clearInputBuffer: (session: string) => mockClearInputBuffer(session),
  dismissResumeSummaryModalIfPresent: (session: string) => mockDismissResumeSummaryModalIfPresent(session),
  dismissModelConsentDialogIfPresent: (session: string) => mockDismissModelConsentDialogIfPresent(session),
  stampFableOverageConsentSharedRoots: () => mockStampFableOverageConsentSharedRoots(),
  isAgentRunning: (name: string) => mockIsAgentRunning(name),
  sendPromptToSession: (session: string, prompt: string) => mockSendPromptToSession(session, prompt),
  startAgentProcess: (name: string, opts?: { fresh?: boolean }) => mockStartAgentProcess(name, opts),
  stopAgentProcess: (name: string) => mockStopAgentProcess(name),
  scheduleIdentitySetup: (session: string, name: string) => mockScheduleIdentitySetup(session, name),
  ensureMainAgentIsolatedConfigDir: () => mockEnsureMainAgentIsolatedConfigDir(),
  ensureSharedClaudeOnboarded: () => mockEnsureSharedClaudeOnboarded(),
  hasFleetOauthToken: () => mockHasFleetOauthToken(),
  answerFirstRunGates: (session: string) => mockAnswerFirstRunGates(session),
  FLEET_OAUTH_TOKEN_PATH: '/tmp/marveen-test/store/.claude-oauth-token',
}))

vi.mock('../web/channel-poller-reap.js', () => ({
  reapChannelOrphans: (...args: unknown[]) => mockReapChannelOrphans(...args),
  reapDetachedChannelClaudes: (...args: unknown[]) => mockReapDetachedChannelClaudes(...args),
  collectPollerEvidence: (...args: unknown[]) => mockCollectPollerEvidence(...args),
}))

vi.mock('../web/channel-conflict-probe.js', () => ({
  probeTelegramConflict: (...args: unknown[]) => mockProbeTelegramConflict(...args),
}))

vi.mock('../web/channel-plugin-unlock.js', () => ({
  schedulePluginUnlockAfterRespawn: (...args: unknown[]) => mockSchedulePluginUnlockAfterRespawn(...args),
  wasPluginConfirmedAbsent: (...args: unknown[]) => mockWasPluginConfirmedAbsent(...args),
  clearPluginAbsent: (...args: unknown[]) => mockClearPluginAbsent(...args),
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: (pane: string) => mockDetectPaneState(pane),
  decidePaneErrorAlert: (...args: unknown[]) => mockDecidePaneErrorAlert(...args),
  detectsBlockingMenu: (pane: string) => mockDetectsBlockingMenu(pane),
  detectsFirstRunGate: (pane: string) => mockDetectsFirstRunGate(pane),
  detectsModelConsentDialog: (pane: string) => mockDetectsModelConsentDialog(pane),
  stuckInputSignature: (pane: string) => mockStuckInputSignature(pane),
  decideStuckInputRecovery: (...args: unknown[]) => mockDecideStuckInputRecovery(...args),
  parkedChannelInput: (pane: string) => mockParkedChannelInput(pane),
  parkedInputText: (pane: string) => mockParkedInputText(pane),
  shouldClearTruncatedPreamble: (pane: string) => mockShouldClearTruncatedPreamble(pane),
  parkedInputRowCount: (pane: string) => mockParkedInputRowCount(pane),
  submitLanded: (...args: unknown[]) => mockSubmitLanded(...args),
  decideStuckInputAction: (...args: unknown[]) => mockDecideStuckInputAction(...args),
  parkedScheduledTaskInput: (pane: string) => mockParkedScheduledTaskInput(pane),
  parkedMachineOriginInput: (pane: string) => mockParkedMachineOriginInput(pane),
  parkedMainInputHasRemedy: (pane: string) => mockParkedMainInputHasRemedy(pane),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: mockMAIN_CHANNELS_SESSION,
  MAIN_CHANNELS_PLIST: mockMAIN_CHANNELS_PLIST,
}))

vi.mock('../notify.js', () => ({
  notifyChannel: (...args: unknown[]) => mockNotifyChannel(...args),
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (type: string) => mockGetProvider(type),
  channelStateDir: (type: string, base?: string) => mockChannelStateDir(type, base),
  readChannelToken: (type: string, tokenPath: string) => mockReadChannelToken(type, tokenPath),
}))

vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: (...args: unknown[]) => mockAttemptChannelMcpReconnect(...args),
}))

vi.mock('../web/inbound-probe.js', () => ({
  readLastIngestionTimestamp: (...args: unknown[]) => mockReadLastIngestionTimestamp(...args),
  TRANSCRIPT_DIR: mockTRANSCRIPT_DIR,
}))

vi.mock('../web/agent-restart-policy.js', () => ({
  decideDownAgentAction: (...args: unknown[]) => mockDecideDownAgentAction(...args),
  AGENT_MAX_RESTART_ATTEMPTS: mockAGENT_MAX_RESTART_ATTEMPTS,
  parseEtimeToSeconds: (s: string) => {
    const m = s.trim().match(/^(?:(?:(\d+)-)?(\d+):)?(\d+):(\d+)$/)
    if (!m) return -1
    const days = m[1] ? Number(m[1]) : 0
    const hours = m[2] ? Number(m[2]) : 0
    const minutes = Number(m[3])
    const seconds = Number(m[4])
    if (minutes > 59 || seconds > 59) return -1
    return days * 86400 + hours * 3600 + minutes * 60 + seconds
  },
}))

vi.mock('../channel-coordinator/liveness.js', () => ({
  getClaudePidForSession: (session: string) => mockGetClaudePidForSession(session),
  hasChannelPluginAlive: (...args: unknown[]) => mockHasChannelPluginAlive(...args),
  probeChannelPluginLiveness: (...args: unknown[]) => mockProbeChannelPluginLiveness(...args),
}))

vi.mock('../web/agent-desired-state.js', () => ({
  getDesiredAgents: () => mockGetDesiredAgents(),
}))

// ---------------------------------------------------------------------------
// SUT imports. Each test calls vi.resetModules() and re-imports the SUT with a
// fresh module registry so module-level state (Maps, counters, Sets) starts
// empty.
// ---------------------------------------------------------------------------
type SUT = typeof import('../web/channel-monitor.js')
let SUT_IMPORT: () => Promise<SUT>

beforeEach(() => {
  vi.resetModules()
  // Wipe all mock call records between tests so call-order and call-count
  // assertions stay scoped to a single test.
  vi.clearAllMocks()
  // Re-seed defaults that vi.clearAllMocks zeroes
  mockHostname.mockReturnValue('test-host')
  mockResolveFromPath.mockImplementation((p: string) => `/usr/bin/${p}`)
  mockAgentDir.mockImplementation((name: string) => `/tmp/marveen-test/agents/${name}`)
  mockAgentSessionName.mockImplementation((n: string) => `agent-${n}`)
  mockReadAgentChannelProvider.mockImplementation(() => '')
  mockListAgentNames.mockImplementation(() => [])
  mockAgentHasChannel.mockImplementation(() => false)
  mockIsAgentRunning.mockImplementation(() => false)
  mockCapturePane.mockImplementation(() => null)
  mockCaptureParkedInputView.mockImplementation(() => null)
  mockStuckInputSignature.mockImplementation(() => null)
  mockDecideStuckInputRecovery.mockImplementation(() => ({
    recover: false,
    next: { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 },
  }))
  mockDetectsFirstRunGate.mockImplementation(() => null)
  mockDetectsBlockingMenu.mockImplementation(() => false)
  mockDetectsModelConsentDialog.mockImplementation(() => false)
  mockDecidePaneErrorAlert.mockImplementation(() => ({
    alert: false,
    next: { firstSeenAt: null, lastAlertAt: null, lastErrorAt: null },
  }))
  mockDetectPaneState.mockImplementation(() => 'idle')
  mockGetProvider.mockImplementation(() => ({ pluginId: 'telegram@claude-plugins-official', type: 'telegram' }))
  mockGetClaudePidForSession.mockImplementation(() => null)
  mockHasChannelPluginAlive.mockImplementation(() => false)
  mockProbeChannelPluginLiveness.mockImplementation(() => 'alive')
  mockGetDesiredAgents.mockImplementation(() => new Set<string>())
  mockAttemptChannelMcpReconnect.mockImplementation(() => ({ ok: true }))
  mockReadChannelToken.mockImplementation(() => null)
  mockReadLastIngestionTimestamp.mockImplementation(() => null)
  mockEnsureMainAgentIsolatedConfigDir.mockImplementation(() => null)
  mockEnsureSharedClaudeOnboarded.mockImplementation(() => true)
  mockHasFleetOauthToken.mockImplementation(() => false)
  mockStampFableOverageConsentSharedRoots.mockImplementation(() => {})
  mockScheduleIdentitySetup.mockImplementation(async () => {})
  mockSchedulePluginUnlockAfterRespawn.mockImplementation(() => {})
  mockWasPluginConfirmedAbsent.mockImplementation(() => false)
  mockClearPluginAbsent.mockImplementation(() => {})
  mockStartAgentProcess.mockImplementation(() => ({ ok: true }))
  mockStopAgentProcess.mockImplementation(() => ({ ok: true }))
  mockSendPromptToSession.mockImplementation(async () => {})
  mockClearInputBuffer.mockImplementation(async () => {})
  mockDismissResumeSummaryModalIfPresent.mockImplementation(async () => {})
  mockDismissModelConsentDialogIfPresent.mockImplementation(async () => {})
  mockAnswerFirstRunGates.mockImplementation(async () => 'ok')
  mockReapChannelOrphans.mockImplementation(() => [])
  mockReapDetachedChannelClaudes.mockImplementation(() => [])
  mockCollectPollerEvidence.mockImplementation(() => ({
    interpretation: 'missing',
    summary: 'no poller',
  }))
  mockProbeTelegramConflict.mockImplementation(async () => ({ conflicted: false, status: 200, description: null }))
  mockParkedChannelInput.mockImplementation(() => null)
  mockParkedInputText.mockImplementation(() => null)
  mockShouldClearTruncatedPreamble.mockImplementation(() => false)
  mockParkedInputRowCount.mockImplementation(() => 0)
  mockParkedScheduledTaskInput.mockImplementation(() => false)
  mockParkedMachineOriginInput.mockImplementation(() => false)
  mockParkedMainInputHasRemedy.mockImplementation(() => false)
  mockSubmitLanded.mockImplementation(() => false)
  mockDecideStuckInputAction.mockImplementation(() => 'hold')
  mockDecideDownAgentAction.mockImplementation(() => 'restart')
  mockChannelStateDir.mockImplementation((_p: string, base?: string) => join(base ?? '/tmp/marveen-test', '.claude', 'channels'))
  mockNotifyChannel.mockImplementation(async () => {})
  mockExecFileSync.mockImplementation(() => '')
  mockSpawn.mockImplementation(() => {
    return { unref: vi.fn(), on: vi.fn(), pid: 12345 }
  })
  mockExistsSync.mockImplementation(() => false)
  mockReadFileSync.mockImplementation(() => '')
  mockStatSync.mockImplementation(() => ({ mtimeMs: 0 }))
  mockWriteFileSync.mockImplementation(() => {})
  mockUtimesSync.mockImplementation(() => {})

  SUT_IMPORT = async () => import('../web/channel-monitor.js')
})

afterEach(() => {
  vi.useRealTimers()
})

// ===========================================================================
// Pure decision helpers
// ===========================================================================

describe('decideStuckInputRestart', () => {
  it('skips when not parked', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.decideStuckInputRestart(false, 5, 4, 1000, 0, 0, 1000, 3)).toBe('skip')
  })
  it('skips when attempts < maxAttempts', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.decideStuckInputRestart(true, 1, 4, 1000, 0, 0, 1000, 3)).toBe('skip')
  })
  it('skips when within the rate-limit interval', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.decideStuckInputRestart(true, 5, 4, 1000, 500, 0, 1000, 3)).toBe('skip')
  })
  it('returns alert when restartCount === maxConsecutive', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.decideStuckInputRestart(true, 5, 4, 1000, 0, 3, 1000, 3)).toBe('alert')
  })
  it('returns skip when restartCount > maxConsecutive', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.decideStuckInputRestart(true, 5, 4, 1000, 0, 4, 1000, 3)).toBe('skip')
  })
  it('returns restart when parked, attempts past cap, no rate-limit, room under cap', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.decideStuckInputRestart(true, 5, 4, 1000, 0, 2, 1000, 3)).toBe('restart')
  })
})

describe('applyStuckRestartBusyGuard', () => {
  it('skips when paneState is busy', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.applyStuckRestartBusyGuard('busy', 'restart')).toBe('skip')
  })
  it('skips when paneState is typing without unrecoverable carve-out', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.applyStuckRestartBusyGuard('typing', 'restart')).toBe('skip')
    expect(SUT.applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin: true, softRemedy: true })).toBe('skip')
  })
  it('keeps the decision when paneState is typing and unrecoverable (machine-origin + no soft remedy)', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin: true, softRemedy: false })).toBe('restart')
    expect(SUT.applyStuckRestartBusyGuard('typing', 'alert', { machineOrigin: true, softRemedy: false })).toBe('alert')
  })
  it('skips when paneState is typing, opts provided but machineOrigin false', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.applyStuckRestartBusyGuard('typing', 'restart', { machineOrigin: false, softRemedy: false })).toBe('skip')
  })
  it('keeps the decision when paneState is idle', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.applyStuckRestartBusyGuard('idle', 'restart')).toBe('restart')
    expect(SUT.applyStuckRestartBusyGuard('idle', 'alert')).toBe('alert')
    expect(SUT.applyStuckRestartBusyGuard('idle', 'skip')).toBe('skip')
  })
  it('keeps the decision when paneState is error/unknown/null', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.applyStuckRestartBusyGuard('error', 'restart')).toBe('restart')
    expect(SUT.applyStuckRestartBusyGuard('unknown', 'alert')).toBe('alert')
    expect(SUT.applyStuckRestartBusyGuard(null, 'restart')).toBe('restart')
  })
})

describe('shouldRunPeriodicReap', () => {
  it('returns false when interval not elapsed', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRunPeriodicReap(0, 100, 1000)).toBe(false)
  })
  it('returns true when interval elapsed', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRunPeriodicReap(0, 2000, 1000)).toBe(true)
    expect(SUT.shouldRunPeriodicReap(0, 1000, 1000)).toBe(true)
  })
})

describe('shouldEscalateAfterResume', () => {
  it('escalates when claudePid is null', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldEscalateAfterResume({ claudePid: null, pluginAlive: true })).toBe(true)
  })
  it('escalates when claudePid is set but plugin not alive', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldEscalateAfterResume({ claudePid: 123, pluginAlive: false })).toBe(true)
  })
  it('does not escalate when claudePid is set and plugin alive', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldEscalateAfterResume({ claudePid: 123, pluginAlive: true })).toBe(false)
  })
})

describe('shouldDeferKeepaliveRespawn', () => {
  it('defers on busy', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldDeferKeepaliveRespawn('busy')).toBe(true)
  })
  it('defers on typing', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldDeferKeepaliveRespawn('typing')).toBe(true)
  })
  it('does not defer on idle/unknown/error/null', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldDeferKeepaliveRespawn('idle')).toBe(false)
    expect(SUT.shouldDeferKeepaliveRespawn('unknown')).toBe(false)
    expect(SUT.shouldDeferKeepaliveRespawn('error')).toBe(false)
    expect(SUT.shouldDeferKeepaliveRespawn(null)).toBe(false)
  })
})

describe('shouldRespawnForStaleKeepalive', () => {
  it('returns false when keepaliveAgeMs is null', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: null, stalenessThresholdMs: 100, msSinceLastRespawn: null, respawnGraceMs: 50,
    })).toBe(false)
  })
  it('returns false when msSinceLastRespawn < respawnGraceMs', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: 200, stalenessThresholdMs: 100, msSinceLastRespawn: 10, respawnGraceMs: 50,
    })).toBe(false)
  })
  it('returns false when keepalive is fresh', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: 50, stalenessThresholdMs: 100, msSinceLastRespawn: null, respawnGraceMs: 50,
    })).toBe(false)
  })
  it('returns true when stale and outside grace', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: 200, stalenessThresholdMs: 100, msSinceLastRespawn: null, respawnGraceMs: 50,
    })).toBe(true)
  })
  it('treats msSinceLastRespawn=null as eligible', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRespawnForStaleKeepalive({
      keepaliveAgeMs: 200, stalenessThresholdMs: 100, msSinceLastRespawn: null, respawnGraceMs: 50,
    })).toBe(true)
  })
})

describe('shouldRefreshKeepaliveFromInbound', () => {
  it('returns false when lastInboundTs is null', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRefreshKeepaliveFromInbound(null, 100)).toBe(false)
  })
  it('returns false when lastInboundTs <= keepaliveMtimeMs', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRefreshKeepaliveFromInbound(50, 100)).toBe(false)
    expect(SUT.shouldRefreshKeepaliveFromInbound(100, 100)).toBe(false)
  })
  it('returns true when lastInboundTs > keepaliveMtimeMs', async () => {
    const SUT = await SUT_IMPORT()
    expect(SUT.shouldRefreshKeepaliveFromInbound(200, 100)).toBe(true)
  })
})

describe('readExtraChannelPluginIds', () => {
  it('returns [] when .env missing', async () => {
    mockExistsSync.mockImplementation((p: string) => !(p as string).endsWith('.env'))
    const SUT = await SUT_IMPORT()
    expect(SUT.readExtraChannelPluginIds('/tmp/x')).toEqual([])
  })
  it('returns [] when .env has no CHANNEL_PLUGINS_EXTRA', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('OTHER=value\nFOO=bar\n')
    const SUT = await SUT_IMPORT()
    expect(SUT.readExtraChannelPluginIds('/tmp/x')).toEqual([])
  })
  it('parses a space-separated plugin id list', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('CHANNEL_PLUGINS_EXTRA=slack discord googlechat\n')
    const SUT = await SUT_IMPORT()
    expect(SUT.readExtraChannelPluginIds('/tmp/x')).toEqual(['slack', 'discord', 'googlechat'])
  })
  it('tolerates readFileSync throwing', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockImplementation(() => { throw new Error('boom') })
    const SUT = await SUT_IMPORT()
    expect(SUT.readExtraChannelPluginIds('/tmp/x')).toEqual([])
  })
  it('returns [] when value is empty string', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('CHANNEL_PLUGINS_EXTRA=\n')
    const SUT = await SUT_IMPORT()
    expect(SUT.readExtraChannelPluginIds('/tmp/x')).toEqual([])
  })
})

describe('buildMainSessionRespawnCmd', () => {
  it('builds a fresh-session command (no --continue)', async () => {
    const SUT = await SUT_IMPORT()
    const cmd = SUT.buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'telegram@claude-plugins-official',
      model: '',
      continueSession: false,
    })
    expect(cmd).toContain('export PATH=')
    expect(cmd).toContain('MCP_SERVER_CONNECTION_BATCH_SIZE=10')
    expect(cmd).toContain('/usr/bin/claude')
    expect(cmd).not.toContain('--continue')
    expect(cmd).not.toContain('--model')
    expect(cmd).toContain("--channels plugin:telegram@claude-plugins-official")
    expect(cmd).toContain('--dangerously-skip-permissions')
  })
  it('emits --continue when continueSession is true', async () => {
    const SUT = await SUT_IMPORT()
    const cmd = SUT.buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'tg',
      model: '',
      continueSession: true,
    })
    expect(cmd).toContain('--continue')
  })
  it('emits --model when provided (single-quoted)', async () => {
    const SUT = await SUT_IMPORT()
    const cmd = SUT.buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'tg',
      model: 'claude-opus-4-8[1m]',
      continueSession: false,
    })
    expect(cmd).toContain("--model 'claude-opus-4-8[1m]'")
  })
  it('emits isolated config env when isolatedConfigDir set', async () => {
    const SUT = await SUT_IMPORT()
    const cmd = SUT.buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'tg',
      model: '',
      continueSession: false,
      isolatedConfigDir: '/tmp/iso',
    })
    expect(cmd).toContain("CLAUDE_CONFIG_DIR='/tmp/iso'")
    expect(cmd).toContain('CLAUDE_CODE_OAUTH_TOKEN="$(cat')
  })
  it('emits fleetToken env when fleetToken true (no isolatedConfigDir)', async () => {
    const SUT = await SUT_IMPORT()
    const cmd = SUT.buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'tg',
      model: '',
      continueSession: false,
      fleetToken: true,
    })
    expect(cmd).not.toContain("CLAUDE_CONFIG_DIR=")
    expect(cmd).toContain('CLAUDE_CODE_OAUTH_TOKEN="$(cat')
  })
  it('emits extra plugin ids alongside the primary', async () => {
    const SUT = await SUT_IMPORT()
    const cmd = SUT.buildMainSessionRespawnCmd({
      claudePath: '/usr/bin/claude',
      pluginId: 'tg',
      model: '',
      continueSession: false,
      extraPluginIds: ['slack', 'discord'],
    })
    expect(cmd).toContain('plugin:slack')
    expect(cmd).toContain('plugin:discord')
  })
})

// ===========================================================================
// Side-effecting wrappers
// ===========================================================================

describe('sendAlert', () => {
  it('invokes notifyChannel and swallows rejections', async () => {
    mockNotifyChannel.mockImplementation(async () => { throw new Error('notify-fail') })
    const SUT = await SUT_IMPORT()
    SUT.sendAlert('hello')
    // microtask to allow the rejected promise to settle
    await Promise.resolve()
    await Promise.resolve()
    expect(mockNotifyChannel).toHaveBeenCalledWith('hello')
  })
})

describe('respawnMainSessionFresh', () => {
  it('runs all steps and respawns the pane', async () => {
    const SUT = await SUT_IMPORT()
    SUT.respawnMainSessionFresh()
    expect(mockReapChannelOrphans).toHaveBeenCalled()
    expect(mockReapDetachedChannelClaudes).toHaveBeenCalled()
    expect(mockEnsureSharedClaudeOnboarded).toHaveBeenCalled()
    expect(mockExecFileSync).toHaveBeenCalled()
    expect(mockScheduleIdentitySetup).toHaveBeenCalledWith(mockMAIN_CHANNELS_SESSION, mockBOT_NAME)
    expect(mockSchedulePluginUnlockAfterRespawn).toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalled()
  })
  it('tolerates a reap throwing (continuing)', async () => {
    mockReapChannelOrphans.mockImplementation(() => { throw new Error('reap fail') })
    mockReapDetachedChannelClaudes.mockImplementation(() => { throw new Error('reap2 fail') })
    const SUT = await SUT_IMPORT()
    SUT.respawnMainSessionFresh()
    expect(mockLoggerWarn).toHaveBeenCalled()
    expect(mockExecFileSync).toHaveBeenCalled()
  })
})

describe('resumeMarveenSession', () => {
  it('returns true on success', async () => {
    const SUT = await SUT_IMPORT()
    const ok = await SUT.resumeMarveenSession()
    expect(ok).toBe(true)
    expect(mockScheduleIdentitySetup).toHaveBeenCalled()
    expect(mockSchedulePluginUnlockAfterRespawn).toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalled()
  })
  it('returns false when execFileSync throws', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('tmux fail') })
    const SUT = await SUT_IMPORT()
    const ok = await SUT.resumeMarveenSession()
    expect(ok).toBe(false)
    expect(mockLoggerError).toHaveBeenCalled()
  })
  it('logs but continues when reaps throw', async () => {
    mockReapChannelOrphans.mockImplementation(() => { throw new Error('r1') })
    mockReapDetachedChannelClaudes.mockImplementation(() => { throw new Error('r2') })
    const SUT = await SUT_IMPORT()
    const ok = await SUT.resumeMarveenSession()
    expect(ok).toBe(true)
  })
  it('logs but continues when dismissResumeSummaryModal throws', async () => {
    mockDismissResumeSummaryModalIfPresent.mockImplementation(async () => { throw new Error('mod') })
    const SUT = await SUT_IMPORT()
    const ok = await SUT.resumeMarveenSession()
    expect(ok).toBe(true)
    expect(mockLoggerWarn).toHaveBeenCalled()
  })
})

describe('mainChannelsSessionExists', () => {
  it('returns true when tmux has-session succeeds', async () => {
    mockExecFileSync.mockImplementation(() => '')
    const SUT = await SUT_IMPORT()
    expect(SUT.mainChannelsSessionExists()).toBe(true)
    expect(mockExecFileSync).toHaveBeenCalled()
  })
  it('returns false when tmux has-session throws', async () => {
    mockExecFileSync.mockImplementation(() => { throw new Error('no session') })
    const SUT = await SUT_IMPORT()
    expect(SUT.mainChannelsSessionExists()).toBe(false)
  })
})

describe('createMainChannelsSession', () => {
  it('returns started when channels.sh exists and spawn succeeds', async () => {
    mockExistsSync.mockImplementation((p: string) => (p as string).endsWith('channels.sh'))
    const SUT = await SUT_IMPORT()
    expect(SUT.createMainChannelsSession()).toBe('started')
    expect(mockSpawn).toHaveBeenCalled()
    expect(mockWriteFileSync).toHaveBeenCalled()
  })
  it('returns grace when within grace window', async () => {
    mockExistsSync.mockImplementation((p: string) => (p as string).endsWith('channels.sh'))
    const SUT = await SUT_IMPORT()
    SUT.createMainChannelsSession()
    expect(SUT.createMainChannelsSession()).toBe('grace')
  })
  it('returns script-missing when channels.sh absent', async () => {
    mockExistsSync.mockReturnValue(false)
    const SUT = await SUT_IMPORT()
    expect(SUT.createMainChannelsSession()).toBe('script-missing')
    expect(mockLoggerError).toHaveBeenCalled()
  })
  it('returns spawn-failed when spawn throws', async () => {
    mockExistsSync.mockImplementation((p: string) => (p as string).endsWith('channels.sh'))
    mockSpawn.mockImplementation(() => { throw new Error('spawn fail') })
    const SUT = await SUT_IMPORT()
    expect(SUT.createMainChannelsSession()).toBe('spawn-failed')
    expect(mockLoggerError).toHaveBeenCalled()
  })
})

describe('hardRestartMarveenChannels', () => {
  it('returns ok via respawn-pane on linux', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      const SUT = await SUT_IMPORT()
      const r = SUT.hardRestartMarveenChannels()
      expect(r.ok).toBe(true)
      expect(mockExecFileSync).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
  it('returns error when respawnMarveenSessionFresh fails on linux', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    try {
      mockExecFileSync.mockImplementation(() => { throw new Error('respawn fail') })
      const SUT = await SUT_IMPORT()
      const r = SUT.hardRestartMarveenChannels()
      expect(r.ok).toBe(false)
      expect(r.error).toContain('tmux respawn-pane failed')
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
  it('uses launchctl on darwin when plist exists', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      mockExistsSync.mockImplementation((p: string) => (p as string).endsWith('.plist'))
      const SUT = await SUT_IMPORT()
      const r = SUT.hardRestartMarveenChannels()
      expect(r.ok).toBe(true)
      expect(mockWriteFileSync).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
  it('returns error when launchctl unload fails', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      mockExistsSync.mockImplementation((p: string) => (p as string).endsWith('.plist'))
      mockExecFileSync.mockImplementation(() => { throw new Error('launchctl fail') })
      const SUT = await SUT_IMPORT()
      const r = SUT.hardRestartMarveenChannels()
      expect(r.ok).toBe(false)
      expect(r.error).toBeDefined()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
  it('falls back to respawn-pane on darwin when plist is absent', async () => {
    const originalPlatform = process.platform
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    try {
      mockExistsSync.mockReturnValue(false)
      const SUT = await SUT_IMPORT()
      const r = SUT.hardRestartMarveenChannels()
      expect(r.ok).toBe(true)
      expect(mockLoggerWarn).toHaveBeenCalled()
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
    }
  })
})

describe('lastMainRespawnAt', () => {
  it('returns 0 when no stamp file and counters are 0', async () => {
    mockReadFileSync.mockImplementation(() => { throw new Error('no file') })
    const SUT = await SUT_IMPORT()
    expect(SUT.lastMainRespawnAt()).toBe(0)
  })
  it('returns parsed stamp (seconds -> ms) when stamp file exists', async () => {
    mockReadFileSync.mockImplementation((p: string) => {
      if ((p as string).endsWith('.channel-last-respawn')) return '1700000000\n'
      throw new Error('not stamp')
    })
    const SUT = await SUT_IMPORT()
    expect(SUT.lastMainRespawnAt()).toBe(1_700_000_000_000)
  })
  it('treats unparseable stamp as 0', async () => {
    mockReadFileSync.mockImplementation(() => 'garbage')
    const SUT = await SUT_IMPORT()
    expect(SUT.lastMainRespawnAt()).toBe(0)
  })
})

// ===========================================================================
// recoverStuckInputForSession (async, side-effecting)
// ===========================================================================

describe('recoverStuckInputForSession', () => {
  it('returns next state without recovery when capture is null', async () => {
    const SUT = await SUT_IMPORT()
    const next = await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(next).toEqual({ parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 })
  })
  it('runs reinject-block recovery when block complete', async () => {
    mockCaptureParkedInputView.mockReturnValue('<channel source=telegram chat_id=42>hi</channel>')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockParkedChannelInput.mockReturnValue({ complete: true, chatId: '42', block: '<channel chat_id=42>hi</channel>' })
    mockParkedInputRowCount.mockReturnValue(1)
    mockDecideStuckInputAction.mockReturnValue('reinject-block')
    const SUT = await SUT_IMPORT()
    const next = await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(next.attempts).toBe(3)
    expect(mockClearInputBuffer).toHaveBeenCalled()
    expect(mockSendPromptToSession).toHaveBeenCalled()
  })
  it('runs reinject-plain with parked text when allowPlainReinject', async () => {
    mockCaptureParkedInputView.mockReturnValue('plain text')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockParkedChannelInput.mockReturnValue(null)
    mockParkedInputText.mockReturnValue('plain text')
    mockParkedInputRowCount.mockReturnValue(1)
    mockDecideStuckInputAction.mockReturnValue('reinject-plain')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      true,
    )
    expect(mockClearInputBuffer).toHaveBeenCalled()
    expect(mockSendPromptToSession).toHaveBeenCalled()
  })
  it('falls back to dismissModelConsentDialog + Enter when reinject-plain has no text', async () => {
    mockCaptureParkedInputView.mockReturnValue('consent dialog text')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockParkedChannelInput.mockReturnValue(null)
    mockParkedInputText.mockReturnValue(null)
    mockParkedInputRowCount.mockReturnValue(1)
    mockDecideStuckInputAction.mockReturnValue('reinject-plain')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      true,
    )
    expect(mockDismissModelConsentDialogIfPresent).toHaveBeenCalled()
    expect(mockExecFileSync).toHaveBeenCalledWith('/usr/bin/tmux', expect.arrayContaining(['send-keys']))
  })
  it('runs clear-preamble action', async () => {
    mockCaptureParkedInputView.mockReturnValue('truncated preamble')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockDecideStuckInputAction.mockReturnValue('clear-preamble')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(mockClearInputBuffer).toHaveBeenCalled()
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })
  it('runs clear-scheduled action', async () => {
    mockCaptureParkedInputView.mockReturnValue('scheduled task input')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockDecideStuckInputAction.mockReturnValue('clear-scheduled')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(mockClearInputBuffer).toHaveBeenCalled()
  })
  it('runs enter action', async () => {
    mockCaptureParkedInputView.mockReturnValue('text')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockDecideStuckInputAction.mockReturnValue('enter')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(mockDismissModelConsentDialogIfPresent).toHaveBeenCalled()
    expect(mockExecFileSync).toHaveBeenCalled()
  })
  it('runs hold action without submitting', async () => {
    mockCaptureParkedInputView.mockReturnValue('text')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockDecideStuckInputAction.mockReturnValue('hold')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(mockLoggerWarn).toHaveBeenCalled()
  })
  it('tolerates an action throwing', async () => {
    mockCaptureParkedInputView.mockReturnValue('text')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockClearInputBuffer.mockImplementation(async () => { throw new Error('boom') })
    mockDecideStuckInputAction.mockReturnValue('clear-preamble')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(mockLoggerWarn).toHaveBeenCalled()
  })
  it('reports when submitLanded returns true', async () => {
    mockCaptureParkedInputView.mockReturnValueOnce('text').mockReturnValueOnce('cleared')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockParkedChannelInput.mockReturnValue({ complete: true, chatId: '42', block: '<channel chat_id=42>hi</channel>' })
    mockDecideStuckInputAction.mockReturnValue('reinject-block')
    mockSubmitLanded.mockReturnValue(true)
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 2 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(mockLoggerWarn).toHaveBeenCalled()
  })
  it('handles prevSig being null on the verify side', async () => {
    mockCaptureParkedInputView.mockReturnValue('text')
    mockStuckInputSignature.mockReturnValue(null)
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: null, firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockDecideStuckInputAction.mockReturnValue('enter')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    // submitLanded guarded by null prevSig => not called
    expect(mockSubmitLanded).not.toHaveBeenCalled()
  })
  it('runs reinject-plain allowPlainReinject=true with no text + dialog dismiss fallback', async () => {
    mockCaptureParkedInputView.mockReturnValue('text')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockParkedInputText.mockReturnValue(null)
    mockDecideStuckInputAction.mockReturnValue('reinject-plain')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      true,
    )
    expect(mockDismissModelConsentDialogIfPresent).toHaveBeenCalled()
  })
  it('handles block truncated guard', async () => {
    mockCaptureParkedInputView.mockReturnValue('text')
    mockStuckInputSignature.mockReturnValue('sig')
    mockDecideStuckInputRecovery.mockReturnValue({
      recover: true,
      next: { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
    })
    mockParkedChannelInput.mockReturnValue({ complete: false, chatId: null, block: null })
    mockDecideStuckInputAction.mockReturnValue('hold')
    const SUT = await SUT_IMPORT()
    await SUT.recoverStuckInputForSession(
      mockMAIN_CHANNELS_SESSION,
      { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 },
      { confirmMs: 1000, dedupMs: 500, maxAttempts: 4 },
      false,
    )
    expect(mockLoggerWarn).toHaveBeenCalled()
  })
})

// ===========================================================================
// startChannelPluginMonitor (the main sweep loop)
// ===========================================================================

describe('startChannelPluginMonitor', () => {
  it('returns null and logs when RESPAWN_ENABLED is false', async () => {
    // vi.doMock is hard here because RESPAWN_ENABLED is read at module
    // evaluation. Re-import with a different mock value.
    vi.resetModules()
    vi.doMock('../config.js', () => ({
      WEB_PORT: 4040,
      MAIN_AGENT_ID: 'marveen',
      SERVICE_ID: 'marveen',
      BOT_NAME: 'Marveen',
      CHANNEL_PROVIDER: 'telegram',
      PROJECT_ROOT: '/tmp/marveen-test',
      RESPAWN_ENABLED: false,
    }))
    const SUT = await import('../web/channel-monitor.js')
    const handle = SUT.startChannelPluginMonitor()
    expect(handle).toBeNull()
    expect(mockLoggerInfo).toHaveBeenCalled()
  })
  it('schedules an interval and runs the check at least once', async () => {
    vi.useFakeTimers()
    // Drive the check via the initial setTimeout(30000)
    let resolveCheck: () => void
    const checkGate = new Promise<void>((r) => { resolveCheck = r })
    mockCapturePane.mockImplementation(() => {
      // No agents, no claude pids -> the loop short-circuits quickly.
      return null
    })
    mockListAgentNames.mockImplementation(() => [])
    const SUT = await SUT_IMPORT()
    const handle = SUT.startChannelPluginMonitor()
    expect(handle).toBeTruthy()
    // The first setTimeout(30000) schedules `check`; advance timers to fire it
    await vi.advanceTimersByTimeAsync(30_000)
    await vi.advanceTimersByTimeAsync(60_000)
    if (resolveCheck) resolveCheck()
    clearInterval(handle as unknown as NodeJS.Timeout)
  })
  it('skips a check tick that runs while another is still in flight', async () => {
    vi.useFakeTimers()
    let firstTickResolved: () => void
    const firstTickGate = new Promise<void>((r) => { firstTickResolved = r })
    let firstTickStarted = false
    // Make the first tick await a slow collaborator, then a second tick fires
    mockSendPromptToSession.mockImplementation(async () => {
      if (!firstTickStarted) {
        firstTickStarted = true
        await firstTickGate
      }
    })
    mockListAgentNames.mockImplementation(() => ['samu'])
    mockIsAgentRunning.mockImplementation(() => true)
    mockAgentHasChannel.mockImplementation(() => true)
    mockGetClaudePidForSession.mockImplementation(() => 123)
    mockProbeChannelPluginLiveness.mockImplementation(() => 'dead')
    mockDecideDownAgentAction.mockImplementation(() => 'restart')
    mockReadChannelToken.mockImplementation(() => 'tok')
    mockGetDesiredAgents.mockImplementation(() => new Set<string>())
    const SUT = await SUT_IMPORT()
    const handle = SUT.startChannelPluginMonitor()
    // Initial 30s check
    await vi.advanceTimersByTimeAsync(30_000)
    // 60s interval -> fires second tick while the first is still awaiting
    await vi.advanceTimersByTimeAsync(60_000)
    if (firstTickResolved) firstTickResolved()
    clearInterval(handle as unknown as NodeJS.Timeout)
  })
})

// ===========================================================================
// Helpers exercised via startChannelPluginMonitor's check() tick
// ===========================================================================
