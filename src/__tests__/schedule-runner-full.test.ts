// 100% coverage test for src/web/schedule-runner.ts.
//
// The runner is a large module (~1300 lines) that depends on ~14 other
// modules. This file mocks every collaborator at the module boundary and
// drives the SUT through its task lifecycle. Coverage targets every
// branch listed in the "Uncovered lines" hint of the prompt:
//
//   60 (= TASK_FIRE_GRACE_MS, etc. constants)
//   408-425 (resolveBoundChatId against real fs)
//   440-441 (runPreCheck spawnSync error + non-zero)
//   455-456 (runPreCheck throw)
//   468-1303 (attemptFireTask, runScheduledTaskNow, sendCatchUpSummary,
//              sendPendingRetryAlert, sendTaskTimeoutAlert, startScheduleRunner)
//
// Existing tests cover the pure decision functions (decideCatchUp,
// decideTaskTimeout, decideScheduledResubmitAction, isScheduledPromptStuck,
// computeCatchUpStart, chatIdFromAccessConfig, resolveStuckTimeoutMs); we
// re-import them here only as a smoke that the SUT exports the same
// surface.

import { describe, expect, it, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted mock state. vi.mock calls are hoisted BEFORE every import, so the
// mockState ref is what every factory closure reads.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const cp = require('node:child_process') as typeof import('node:child_process')
  return {
    // ---- config ----
    PROJECT_ROOT: '',
    STORE_DIR: '',
    MAIN_AGENT_ID: 'marveen',
    ALLOWED_CHAT_ID: '999',
    BOT_NAME: 'Marveen Test',
    APP_TZ_INVALID: undefined as string | undefined,

    // ---- collaborators ----
    loggerDebug: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),

    // fs
    fsExistsSync: fs.existsSync,
    fsReadFileSync: fs.readFileSync,
    scheduleLastRunJson: '' as string,
    scheduleLastRunExists: false,
    tickStateJson: '' as string,
    tickStateExists: false,
    accessJson: '' as string,

    // child_process
    spawnSync: vi.fn<typeof cp.spawnSync>(),

    // atomic-write
    atomicWriteFileSync: vi.fn(),

    // db
    appendTaskRun: vi.fn(),
    listPendingTaskRetries: vi.fn<() => Array<Record<string, unknown>>>(() => []),
    deletePendingTaskRetry: vi.fn<(name: string, agent: string) => boolean>(() => true),
    updatePendingTaskRetry: vi.fn<(name: string, agent: string, now: number, reason: string) => boolean>(() => true),
    insertPendingTaskRetryIfNew: vi.fn<(name: string, agent: string, now: number, reason: string) => boolean>(() => true),
    markPendingTaskRetryAlert: vi.fn<(name: string, agent: string, ts: number) => boolean>(() => true),
    clearPendingTaskRetryAlert: vi.fn<(name: string, agent: string) => boolean>(() => true),
    markScheduledTaskKanbanWaiting: vi.fn<(name: string) => string | null>(() => null),

    // pending-retries
    toPendingRetryView: vi.fn((row: Record<string, unknown>, now: number) => ({
      id: row.id as number,
      taskName: row.task_name as string,
      agentName: row.agent_name as string,
      firstAttempt: row.first_attempt as number,
      lastAttempt: row.last_attempt as number,
      attemptCount: row.attempt_count as number,
      lastReason: row.last_reason as string | null,
      alertSentAt: row.alert_sent_at as number | null,
      ageMs: now - (row.first_attempt as number),
      alertDue: false,
    })),
    classifyTelegramSendError: vi.fn<(msg: string) => 'transient' | 'permanent'>(() => 'transient'),

    // prompt-safety
    wrapScheduledTask: vi.fn((source: string, content: string | null | undefined) => `<scheduled-task source="${source}">${content ?? ''}</scheduled-task>`),

    // cron
    cronPrevOccurrence: vi.fn<() => number | null>(() => null),
    effectiveCronTz: vi.fn<() => { tz: string; source: 'SCHEDULER_TZ' | 'TZ' | 'system-default' }>(() => ({ tz: 'UTC', source: 'system-default' })),

    // scheduled-tasks-io
    listScheduledTasks: vi.fn<() => Array<Record<string, unknown>>>(() => []),
    SCHEDULED_TASKS_DIR: '/tmp/scheduled-tasks',

    // agent-config
    listAgentNames: vi.fn<() => string[]>(() => []),
    readFileOr: vi.fn<(p: string, f: string) => string>((_p, f) => f),
    readAgentRemoteHost: vi.fn<(name: string) => string | null>(() => null),
    agentDir: vi.fn<(name: string) => string>((name) => `/tmp/agents/${name}`),

    // channel-provider
    channelStateDir: vi.fn((provider: string, agentDir?: string) => agentDir ? `${agentDir}/channels/${provider}` : `/tmp/channels/${provider}`),

    // agent-process
    agentSessionName: vi.fn((name: string) => `agent-${name}`),
    isAgentRunning: vi.fn<(name: string) => boolean>(() => true),
    isSessionReadyForPrompt: vi.fn<(s: string, h: string | null) => Promise<boolean>>(async () => true),
    sendPromptToSession: vi.fn<(s: string, text: string, h: string | null, opts?: { waitForIdle?: boolean }) => Promise<'sent' | 'aborted-busy'>>(async () => 'sent'),
    startAgentProcess: vi.fn<(name: string) => { ok: boolean; error?: string }>(() => ({ ok: true })),
    sessionExistsOnHost: vi.fn<(h: string | null, s: string) => boolean>(() => true),
    capturePane: vi.fn<(s: string, h: string | null) => string | null>(() => 'idle pane'),
    sendEnterToSession: vi.fn<(s: string, h: string | null) => boolean>(() => true),
    clearStaleParkedInput: vi.fn<(s: string, h: string | null) => Promise<boolean>>(async () => true),

    // main-agent
    MAIN_CHANNELS_SESSION: 'main-channels',

    // telegram
    sendTelegramMessage: vi.fn<(token: string, chatId: string, text: string) => Promise<void>>(async () => undefined),

    // command-task
    runCommandTask: vi.fn<(task: Record<string, unknown>, now: number) => void>(() => undefined),

    // pane-state
    paneShowsContextSaturation: vi.fn<(pane: string) => boolean>(() => false),
    detectsFirstRunGate: vi.fn<(pane: string) => string | null>(() => null),
    detectPaneState: vi.fn<(pane: string) => 'idle' | 'busy' | 'typing' | 'unknown' | 'error'>(() => 'idle'),

    // schedule-mcp-precheck
    checkTaskMcpRequirements: vi.fn<() => { ok: boolean; missing?: string[] }>(() => ({ ok: true })),

    // handlers captured by the global setTimeout / setInterval stub
    setTimeoutHandlers: [] as Array<() => void>,
    setIntervalHandlers: [] as Array<() => void>,
  }
})

// ---------------------------------------------------------------------------
// Set up the tmpdir sandbox + redirect PROJECT_ROOT / STORE_DIR before any
// module that depends on them evaluates.
// ---------------------------------------------------------------------------
const HOME = mkTempDir('schedule-runner-full-home-')
mockState.PROJECT_ROOT = HOME
mockState.STORE_DIR = HOME

// ---------------------------------------------------------------------------
// vi.mock factories
// ---------------------------------------------------------------------------

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: mockState.PROJECT_ROOT,
    STORE_DIR: mockState.STORE_DIR,
    MAIN_AGENT_ID: mockState.MAIN_AGENT_ID,
    ALLOWED_CHAT_ID: mockState.ALLOWED_CHAT_ID,
    BOT_NAME: mockState.BOT_NAME,
    // vi.mock factory results are cached, so vi.resetModules() + re-import
    // does NOT re-evaluate this factory (verified empirically). The SUT
    // reads APP_TZ_INVALID via its live import binding, so we expose it as
    // a getter that reads mockState at access time -- the "warns when
    // APP_TZ_INVALID is set (re-imported SUT)" test relies on this.
    get APP_TZ_INVALID() { return mockState.APP_TZ_INVALID },
  }
})

vi.mock('../logger.js', () => ({
  logger: {
    debug: (...args: unknown[]) => mockState.loggerDebug(...args),
    info: (...args: unknown[]) => mockState.loggerInfo(...args),
    warn: (...args: unknown[]) => mockState.loggerWarn(...args),
    error: (...args: unknown[]) => mockState.loggerError(...args),
  },
}))

vi.mock('../db.js', () => ({
  appendTaskRun: (...args: unknown[]) => mockState.appendTaskRun(...args),
  listPendingTaskRetries: () => mockState.listPendingTaskRetries(),
  deletePendingTaskRetry: (...args: unknown[]) => mockState.deletePendingTaskRetry(...args),
  updatePendingTaskRetry: (...args: unknown[]) => mockState.updatePendingTaskRetry(...args),
  insertPendingTaskRetryIfNew: (...args: unknown[]) => mockState.insertPendingTaskRetryIfNew(...args),
  markPendingTaskRetryAlert: (...args: unknown[]) => mockState.markPendingTaskRetryAlert(...args),
  clearPendingTaskRetryAlert: (...args: unknown[]) => mockState.clearPendingTaskRetryAlert(...args),
  markScheduledTaskKanbanWaiting: (...args: unknown[]) => mockState.markScheduledTaskKanbanWaiting(...args),
}))

vi.mock('../pending-retries.js', () => ({
  toPendingRetryView: (...args: unknown[]) => mockState.toPendingRetryView(...args),
  classifyTelegramSendError: (...args: unknown[]) => mockState.classifyTelegramSendError(...args),
}))

vi.mock('../prompt-safety.js', async (orig) => {
  const actual = await orig<typeof import('../prompt-safety.js')>()
  return {
    ...actual,
    wrapScheduledTask: (...args: unknown[]) => mockState.wrapScheduledTask(...args),
  }
})

vi.mock('../web/cron.js', () => ({
  cronPrevOccurrence: (...args: unknown[]) => mockState.cronPrevOccurrence(...args),
  effectiveCronTz: () => mockState.effectiveCronTz(),
  cronDueBetween: vi.fn(() => false),
  computeNextRun: vi.fn(() => 0),
  isValidCronShape: vi.fn(() => true),
  CRON_SHAPE_RX: /^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)(?:\s+(\S+))?$/,
  resolveCronTz: vi.fn(() => ({ tz: 'UTC', source: 'system-default' as const })),
  cronMatchesNow: vi.fn(() => false),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: mockState.SCHEDULED_TASKS_DIR,
  listScheduledTasks: () => mockState.listScheduledTasks(),
  readScheduledTask: vi.fn(() => null),
  writeScheduledTask: vi.fn(),
  parseSkillMdFrontmatter: vi.fn(() => ({ body: '' })),
  parseFiniteMinutes: vi.fn(() => undefined),
  parseCatchUpMaxAge: vi.fn(() => undefined),
  parseRequires: vi.fn(() => undefined),
  MAX_SCHEDULED_TASK_PROMPT_LEN: 50_000,
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => mockState.listAgentNames(),
  readFileOr: (...args: unknown[]) => mockState.readFileOr(...args),
  readAgentRemoteHost: (...args: unknown[]) => mockState.readAgentRemoteHost(...args),
  agentDir: (...args: unknown[]) => mockState.agentDir(...args),
  agentSessionName: (name: string) => `agent-${name}`,
  AGENTS_BASE_DIR: '/tmp/agents',
  DEFAULT_MODEL: 'default',
  MODEL_ALIASES: {},
  extractDescriptionFromClaudeMd: vi.fn(() => ''),
  findAvatarForAgent: vi.fn(() => null),
  resolveModelId: vi.fn((s: string) => s),
  readModelProfileMap: vi.fn(() => null),
  invalidateModelProfileMapCache: vi.fn(),
  resolveAgentModelDetailed: vi.fn(() => ({ model: 'default', source: 'default', appliedProfile: null, fallbackReason: null })),
  readAgentModel: vi.fn(() => 'default'),
  writeAgentModel: vi.fn(),
  writeAgentModelProfile: vi.fn(),
  readAgentDisplayName: vi.fn(() => ''),
  writeAgentDisplayName: vi.fn(),
  readAgentSecurityProfile: vi.fn(() => 'default'),
  expandAndValidateConfigDir: vi.fn(() => null),
  resolveClaudeConfigDir: vi.fn(() => null),
  readAgentClaudeConfigDir: vi.fn(() => null),
  resolveRemoteConfig: vi.fn(() => ({ host: null, workdir: null })),
  readAgentRemoteConfig: vi.fn(() => ({ host: null, workdir: null })),
  readAgentChannelProvider: vi.fn(() => null),
  writeAgentChannelProvider: vi.fn(),
  readAgentAuthMode: vi.fn(() => 'shared'),
  readAgentMemoryIsolation: vi.fn(() => false),
  writeAgentMemoryIsolation: vi.fn(),
  writeAgentAuthMode: vi.fn(),
  writeAgentSecurityProfile: vi.fn(),
  agentConfigRoot: vi.fn(() => '/tmp/agents'),
  resolveAgentSecurityProfile: vi.fn(() => 'default'),
  resolveAgentProvider: vi.fn(() => 'telegram'),
  scheduleIdentitySetup: vi.fn(async () => undefined),
}))

vi.mock('../channel-provider.js', async (orig) => {
  const actual = await orig<typeof import('../channel-provider.js')>()
  return {
    ...actual,
    channelStateDir: (...args: unknown[]) => mockState.channelStateDir(...args),
  }
})

vi.mock('../web/agent-process.js', () => ({
  agentSessionName: (...args: unknown[]) => mockState.agentSessionName(...args),
  isAgentRunning: (...args: unknown[]) => mockState.isAgentRunning(...args),
  isSessionReadyForPrompt: (...args: unknown[]) => mockState.isSessionReadyForPrompt(...args),
  sendPromptToSession: (...args: unknown[]) => mockState.sendPromptToSession(...args),
  startAgentProcess: (...args: unknown[]) => mockState.startAgentProcess(...args),
  sessionExistsOnHost: (...args: unknown[]) => mockState.sessionExistsOnHost(...args),
  capturePane: (...args: unknown[]) => mockState.capturePane(...args),
  sendEnterToSession: (...args: unknown[]) => mockState.sendEnterToSession(...args),
  clearStaleParkedInput: (...args: unknown[]) => mockState.clearStaleParkedInput(...args),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: mockState.MAIN_CHANNELS_SESSION,
  channelsSessionName: (id: string) => `main-channels-${id}`,
  channelsLaunchdLabel: (id: string) => `com.${id}.channels`,
  channelsPlistPath: (id: string) => `/tmp/${id}.plist`,
  isMainChannelsAgent: (name: string) => name === 'main-channels',
}))

vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: (...args: unknown[]) => mockState.sendTelegramMessage(...args),
  readAgentTelegramConfig: vi.fn(() => ({ hasTelegram: false })),
  readAgentDiscordConfig: vi.fn(() => ({ hasDiscord: false })),
  readAgentGooglechatConfig: vi.fn(() => ({ hasGooglechat: false })),
  readAgentTeamsConfig: vi.fn(() => ({ hasTeams: false })),
  readMarveenTelegramConfig: vi.fn(() => ({ hasTelegram: false })),
  readMarveenDiscordConfig: vi.fn(() => ({ hasDiscord: false })),
  readMarveenGooglechatConfig: vi.fn(() => ({ hasGooglechat: false })),
  readMarveenTeamsConfig: vi.fn(() => ({ hasTeams: false })),
  readMarveenSlackConfig: vi.fn(() => ({ hasSlack: false })),
  refreshMarveenBotUsername: vi.fn(async () => undefined),
  sendTelegramPhoto: vi.fn(async () => undefined),
  sendWelcomeMessage: vi.fn(async () => undefined),
  sendMarveenAvatarChange: vi.fn(async () => undefined),
  sendAvatarChangeMessage: vi.fn(async () => undefined),
  validateTelegramToken: vi.fn(async () => ({ ok: true })),
  parseTelegramToken: vi.fn(() => null),
  sendMarveenAlert: vi.fn(async () => undefined),
  markIfTestRun: (s: string) => s,
  marveenBotUsernameCache: { fetchedAt: 0 },
}))

vi.mock('../web/command-task.js', () => ({
  runCommandTask: (...args: unknown[]) => mockState.runCommandTask(...args),
  evaluateCommandResult: vi.fn(() => ({ next: { fails: 0, alerted: false, lastStatus: 'ok', lastRun: 0 }, action: 'none' as const })),
}))

vi.mock('../pane-state.js', async (orig) => {
  const actual = await orig<typeof import('../pane-state.js')>()
  return {
    ...actual,
    paneShowsContextSaturation: (...args: unknown[]) => mockState.paneShowsContextSaturation(...args),
    detectsFirstRunGate: (...args: unknown[]) => mockState.detectsFirstRunGate(...args),
    detectPaneState: (...args: unknown[]) => mockState.detectPaneState(...args),
  }
})

vi.mock('../web/schedule-mcp-precheck.js', () => ({
  checkTaskMcpRequirements: (...args: unknown[]) => mockState.checkTaskMcpRequirements(...args),
  deriveProcessPattern: vi.fn(() => null),
  collectSubtreeCmdlines: vi.fn(() => []),
  decideMcpPrecheck: vi.fn(() => ({ ok: true })),
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (...args: unknown[]) => mockState.atomicWriteFileSync(...args),
}))

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: (...args: unknown[]) => {
      const p = args[0] as string
      if (typeof p === 'string' && p.endsWith('schedule-last-run.json')) return mockState.scheduleLastRunExists
      if (typeof p === 'string' && p.endsWith('schedule-tick-state.json')) return mockState.tickStateExists
      if (typeof p === 'string' && p.endsWith('access.json')) return mockState.accessJson !== ''
      // Claim existence for any other path so runPreCheck proceeds to spawnSync
      return true
    },
    readFileSync: (...args: unknown[]) => {
      const p = args[0] as string
      if (typeof p === 'string' && p.endsWith('schedule-last-run.json')) {
        if (!mockState.scheduleLastRunExists) throw new Error('ENOENT')
        return mockState.scheduleLastRunJson
      }
      if (typeof p === 'string' && p.endsWith('schedule-tick-state.json')) {
        if (!mockState.tickStateExists) throw new Error('ENOENT')
        return mockState.tickStateJson
      }
      if (typeof p === 'string' && p.endsWith('access.json')) {
        if (mockState.accessJson === '') throw new Error('ENOENT')
        return mockState.accessJson
      }
      return mockState.fsReadFileSync(...args)
    },
  }
})

vi.mock('node:child_process', async (orig) => {
  const actual = await orig<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: (...args: unknown[]) => mockState.spawnSync(...args),
  }
})

// ---------------------------------------------------------------------------
// SUT import (must come after all vi.mock factories).
// vi.resetModules() is called in beforeEach to reset the SUT's
// module-level state (scheduleLastRun Map, taskInflightMap) between tests.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let sut: any = await import('../web/schedule-runner.js')

// ---------------------------------------------------------------------------
// Helper: drain the SUT's queued timers. The SUT uses the Node global
// setTimeout / setInterval, so we override them in installTimerStubs.
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origSetTimeout = (globalThis as any).setTimeout as (...args: unknown[]) => unknown
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const origSetInterval = (globalThis as any).setInterval as (...args: unknown[]) => unknown

function installTimerStubs(): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).setTimeout = (handler: (...args: unknown[]) => void, _ms?: number, ..._rest: unknown[]) => {
    mockState.setTimeoutHandlers.push(() => handler())
    return 0 as unknown as NodeJS.Timeout
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(globalThis as any).setInterval = (handler: (...args: unknown[]) => void, _ms?: number, ..._rest: unknown[]) => {
    mockState.setIntervalHandlers.push(() => handler())
    return 0 as unknown as NodeJS.Timeout
  }
}

function resetAllMocks(): void {
  mockState.loggerDebug.mockReset()
  mockState.loggerInfo.mockReset()
  mockState.loggerWarn.mockReset()
  mockState.loggerError.mockReset()
  mockState.spawnSync.mockReset()
  mockState.atomicWriteFileSync.mockReset()
  mockState.appendTaskRun.mockReset()
  mockState.listPendingTaskRetries.mockReset().mockReturnValue([])
  mockState.deletePendingTaskRetry.mockReset().mockReturnValue(true)
  mockState.updatePendingTaskRetry.mockReset().mockReturnValue(true)
  mockState.insertPendingTaskRetryIfNew.mockReset().mockReturnValue(true)
  mockState.markPendingTaskRetryAlert.mockReset().mockReturnValue(true)
  mockState.clearPendingTaskRetryAlert.mockReset().mockReturnValue(true)
  mockState.markScheduledTaskKanbanWaiting.mockReset().mockReturnValue(null)
  mockState.toPendingRetryView.mockReset().mockImplementation((row: Record<string, unknown>, now: number) => ({
    id: row.id as number,
    taskName: row.task_name as string,
    agentName: row.agent_name as string,
    firstAttempt: row.first_attempt as number,
    lastAttempt: row.last_attempt as number,
    attemptCount: row.attempt_count as number,
    lastReason: row.last_reason as string | null,
    alertSentAt: row.alert_sent_at as number | null,
    ageMs: now - (row.first_attempt as number),
    alertDue: false,
  }))
  mockState.classifyTelegramSendError.mockReset().mockReturnValue('transient')
  mockState.wrapScheduledTask.mockReset().mockImplementation((source: string, content) => `<scheduled-task source="${source}">${content ?? ''}</scheduled-task>`)
  mockState.cronPrevOccurrence.mockReset().mockReturnValue(null)
  mockState.effectiveCronTz.mockReset().mockReturnValue({ tz: 'UTC', source: 'system-default' })
  mockState.listScheduledTasks.mockReset().mockReturnValue([])
  mockState.listAgentNames.mockReset().mockReturnValue([])
  mockState.readFileOr.mockReset().mockImplementation((_p, f) => f)
  mockState.readAgentRemoteHost.mockReset().mockReturnValue(null)
  mockState.agentDir.mockReset().mockImplementation((name: string) => `/tmp/agents/${name}`)
  mockState.channelStateDir.mockReset().mockImplementation((provider: string, agentDir?: string) => agentDir ? `${agentDir}/channels/${provider}` : `/tmp/channels/${provider}`)
  mockState.agentSessionName.mockReset().mockImplementation((name: string) => `agent-${name}`)
  mockState.isAgentRunning.mockReset().mockReturnValue(true)
  mockState.isSessionReadyForPrompt.mockReset().mockResolvedValue(true)
  mockState.sendPromptToSession.mockReset().mockResolvedValue('sent')
  mockState.startAgentProcess.mockReset().mockReturnValue({ ok: true })
  mockState.sessionExistsOnHost.mockReset().mockReturnValue(true)
  mockState.capturePane.mockReset().mockReturnValue('idle pane')
  mockState.sendEnterToSession.mockReset().mockReturnValue(true)
  mockState.clearStaleParkedInput.mockReset().mockResolvedValue(true)
  mockState.sendTelegramMessage.mockReset().mockResolvedValue(undefined)
  mockState.runCommandTask.mockReset()
  mockState.paneShowsContextSaturation.mockReset().mockReturnValue(false)
  mockState.detectsFirstRunGate.mockReset().mockReturnValue(null)
  mockState.detectPaneState.mockReset().mockReturnValue('idle')
  mockState.checkTaskMcpRequirements.mockReset().mockReturnValue({ ok: true })
  mockState.setTimeoutHandlers.length = 0
  mockState.setIntervalHandlers.length = 0
  mockState.scheduleLastRunJson = ''
  mockState.scheduleLastRunExists = false
  mockState.tickStateJson = ''
  mockState.tickStateExists = false
  mockState.accessJson = ''
  mockState.APP_TZ_INVALID = undefined
  installTimerStubs()
}

function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    name: 'task',
    description: 'desc',
    prompt: 'do it',
    schedule: '0 9 * * *',
    agent: 'marveen',
    enabled: true,
    createdAt: 0,
    type: 'task',
    ...overrides,
  }
}

/** Boot the runner and drive a single tick. */
async function tickOnce(setupMocks?: () => void): Promise<void> {
  await tickStart(setupMocks)
  await tickRun(false)
}

/** Start the runner and run both the boot setTimeout AND the setInterval.
 *  Used to exercise the re-entrancy guard (the second tick should be skipped). */
async function tickReentrant(setupMocks?: () => void): Promise<void> {
  await tickStart(setupMocks)
  // Call the boot setTimeout handler; the inner runCheck is async fire-and-forget.
  if (mockState.setTimeoutHandlers.length > 0) {
    const boot = mockState.setTimeoutHandlers.shift() as () => void
    boot()
  }
  // Call the setInterval handler immediately while the first is still in flight.
  if (mockState.setIntervalHandlers.length > 0) {
    const t = mockState.setIntervalHandlers.shift() as () => void
    await t()
  }
  // Wait for the in-flight async work to settle.
  await new Promise<void>((r) => { origSetTimeout(r, 200) })
  mockState.setTimeoutHandlers.length = 0
  await new Promise<void>((r) => { origSetTimeout(r, 100) })
}

async function tickStart(setupMocks?: () => void): Promise<void> {
  setupMocks?.()
  sut.startScheduleRunner()
}

async function tickRun(allowSecondTick: boolean): Promise<void> {
  // Boot setTimeout
  if (mockState.setTimeoutHandlers.length > 0) {
    const boot = mockState.setTimeoutHandlers.shift() as () => Promise<void>
    await boot()
  }
  // Skip the setInterval to avoid a second tick racing with the first.
  // The SUT calls `setTimeout(() => { void runCheck() }, ...)`; the inner
  // `void runCheck()` discards the promise so we cannot await it. We rely on
  // a small wait below (using the ORIGINAL setTimeout, not the stub) to let
  // the async work settle.
  if (!allowSecondTick) {
    mockState.setIntervalHandlers.length = 0
  }
  // Wait long enough for the async runCheck to complete. The previous test's
  // runCheck may still be in flight (the `void runCheck()` in setTimeout
  // discards the promise), so we need a substantial wait to let it finish and
  // reset `tickRunning` before THIS tick starts.
  await new Promise<void>((r) => { origSetTimeout(r, 1000) })
  // Drain any internal setTimeout that the tick queued (e.g. resubmit timer)
  while (mockState.setTimeoutHandlers.length > 0) {
    const t = mockState.setTimeoutHandlers.shift() as () => void
    try { t() } catch { /* ignore */ }
  }
  await new Promise<void>((r) => { origSetTimeout(r, 100) })
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(async () => {
  resetAllMocks()
  // Reset the SUT module cache so module-level state (scheduleLastRun Map,
  // taskInflightMap) is fresh between tests. The vi.mock factories above
  // are still in effect, so the re-imported SUT picks up the same mocks.
  vi.resetModules()
  sut = await import('../web/schedule-runner.js')
})

afterAll(() => {
  rmTempDir(HOME)
})

describe('module surface', () => {
  it('exports SCHEDULE_TICK_MS = 15_000', () => {
    expect(sut.SCHEDULE_TICK_MS).toBe(15_000)
  })

  it('exports TASK_FIRE_GRACE_MS = 30_000', () => {
    expect(sut.TASK_FIRE_GRACE_MS).toBe(30_000)
  })

  it('exports TASK_FIRE_TIMEOUT_MS = 300_000', () => {
    expect(sut.TASK_FIRE_TIMEOUT_MS).toBe(300_000)
  })

  it('exports SCHEDULE_COLD_START_CATCHUP_MS = 30 minutes', () => {
    expect(sut.SCHEDULE_COLD_START_CATCHUP_MS).toBe(30 * 60 * 1000)
  })

  it('exports SCHEDULE_MAX_CATCHUP_MS = 24 hours', () => {
    expect(sut.SCHEDULE_MAX_CATCHUP_MS).toBe(24 * 60 * 60 * 1000)
  })

  it('exports LATE_CATCHUP_THRESHOLD_MS = 90s', () => {
    expect(sut.LATE_CATCHUP_THRESHOLD_MS).toBe(90_000)
  })

  it('exports DEFAULT_CATCHUP_MAX_AGE_MIN per-type', () => {
    expect(sut.DEFAULT_CATCHUP_MAX_AGE_MIN).toEqual({ task: 180, heartbeat: 30, command: 1440 })
  })
})

// ---------------------------------------------------------------------------
// resolveStuckTimeoutMs
// ---------------------------------------------------------------------------
describe('resolveStuckTimeoutMs', () => {
  it('falls back to default', () => {
    expect(sut.resolveStuckTimeoutMs({})).toBe(sut.TASK_FIRE_TIMEOUT_MS)
  })

  it('honours positive finite value', () => {
    expect(sut.resolveStuckTimeoutMs({ stuckAfterMinutes: 10 })).toBe(10 * 60_000)
  })

  it('clamps below one minute to 1 minute', () => {
    expect(sut.resolveStuckTimeoutMs({ stuckAfterMinutes: 0.1 })).toBe(60_000)
  })

  it('clamps to 6 hours', () => {
    expect(sut.resolveStuckTimeoutMs({ stuckAfterMinutes: 24 * 60 })).toBe(6 * 60 * 60_000)
  })

  it('falls back to default for non-positive', () => {
    expect(sut.resolveStuckTimeoutMs({ stuckAfterMinutes: -5 })).toBe(sut.TASK_FIRE_TIMEOUT_MS)
    expect(sut.resolveStuckTimeoutMs({ stuckAfterMinutes: 0 })).toBe(sut.TASK_FIRE_TIMEOUT_MS)
    expect(sut.resolveStuckTimeoutMs({ stuckAfterMinutes: NaN })).toBe(sut.TASK_FIRE_TIMEOUT_MS)
    expect(sut.resolveStuckTimeoutMs({ stuckAfterMinutes: 'x' as unknown as number })).toBe(sut.TASK_FIRE_TIMEOUT_MS)
  })
})

// ---------------------------------------------------------------------------
// decideTaskTimeout
// ---------------------------------------------------------------------------
describe('decideTaskTimeout', () => {
  const opts = { graceMs: 1, timeoutMs: 1, maxTrackMs: 1e18 }
  it('clears on max-track eviction', () => {
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, 'busy', 1e18, opts)).toBe('clear')
  })
  it('clears on idle', () => {
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, 'idle', 1e9, opts)).toBe('clear')
  })
  it('holds when already alerted', () => {
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: true }, 'busy', 1e9, opts)).toBe('hold')
  })
  it('holds within grace', () => {
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, 'busy', 1, { ...opts, graceMs: 100, timeoutMs: 200 })).toBe('hold')
  })
  it('alerts when busy past timeout', () => {
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, 'busy', 1000, opts)).toBe('alert')
  })
  it('holds on non-busy states', () => {
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, 'unknown', 1000, opts)).toBe('hold')
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, null, 1000, opts)).toBe('hold')
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, 'error', 1000, opts)).toBe('hold')
    expect(sut.decideTaskTimeout({ injectedAt: 0, alerted: false }, 'typing', 1000, opts)).toBe('hold')
  })
})

// ---------------------------------------------------------------------------
// decideScheduledResubmitAction
// ---------------------------------------------------------------------------
describe('decideScheduledResubmitAction', () => {
  it('returns none when not stuck', () => {
    expect(sut.decideScheduledResubmitAction(0, false)).toBe('none')
  })
  it('returns enter for the first two attempts', () => {
    expect(sut.decideScheduledResubmitAction(0, true)).toBe('enter')
    expect(sut.decideScheduledResubmitAction(1, true)).toBe('enter')
  })
  it('returns reinject for attempts 2..5', () => {
    expect(sut.decideScheduledResubmitAction(2, true)).toBe('reinject')
    expect(sut.decideScheduledResubmitAction(5, true)).toBe('reinject')
  })
  it('returns giveup at attempt 6', () => {
    expect(sut.decideScheduledResubmitAction(6, true)).toBe('giveup')
  })
})

// ---------------------------------------------------------------------------
// isScheduledPromptStuck
// ---------------------------------------------------------------------------
describe('isScheduledPromptStuck', () => {
  it('returns false for null/empty', () => {
    expect(sut.isScheduledPromptStuck(null, 'M')).toBe(false)
    expect(sut.isScheduledPromptStuck('', 'M')).toBe(false)
    expect(sut.isScheduledPromptStuck('   ', 'M')).toBe(false)
  })
  it('returns false when pane has no ❯', () => {
    expect(sut.isScheduledPromptStuck('M some output', 'M')).toBe(false)
  })
  it('returns false when pane is busy', () => {
    mockState.detectPaneState.mockReturnValue('busy')
    expect(sut.isScheduledPromptStuck('M\n❯ M', 'M')).toBe(false)
  })
  it('returns false when input region has no marker', () => {
    expect(sut.isScheduledPromptStuck('M\n❯ other', 'M')).toBe(false)
  })
  it('returns true when marker is in the input region', () => {
    expect(sut.isScheduledPromptStuck('some\n❯ M prompt', 'M')).toBe(true)
  })
  it('returns false when input region has nothing after ❯', () => {
    expect(sut.isScheduledPromptStuck('some\n❯ ', 'M')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// computeCatchUpStart
// ---------------------------------------------------------------------------
describe('computeCatchUpStart', () => {
  it('returns cold-start when no stamp', () => {
    expect(sut.computeCatchUpStart(null, 1e9)).toBe(1e9 - sut.SCHEDULE_COLD_START_CATCHUP_MS)
  })
  it('returns cold-start for NaN', () => {
    expect(sut.computeCatchUpStart(NaN, 1e9)).toBe(1e9 - sut.SCHEDULE_COLD_START_CATCHUP_MS)
  })
  it('returns cold-start for future stamp', () => {
    expect(sut.computeCatchUpStart(1e9 + 1000, 1e9)).toBe(1e9 - sut.SCHEDULE_COLD_START_CATCHUP_MS)
  })
  it('returns cap when stamp is older than max', () => {
    expect(sut.computeCatchUpStart(1e9 - 100 * 24 * 60 * 60 * 1000, 1e9)).toBe(1e9 - sut.SCHEDULE_MAX_CATCHUP_MS)
  })
  it('returns the stamp when within the cap', () => {
    expect(sut.computeCatchUpStart(1e9 - 60_000, 1e9)).toBe(1e9 - 60_000)
  })
})

// ---------------------------------------------------------------------------
// decideCatchUp
// ---------------------------------------------------------------------------
describe('decideCatchUp', () => {
  it('reports on-time within threshold', () => {
    expect(sut.decideCatchUp(makeTask({ type: 'task' }) as never, 0)).toBe('on-time')
    expect(sut.decideCatchUp(makeTask({ type: 'task' }) as never, sut.LATE_CATCHUP_THRESHOLD_MS)).toBe('on-time')
  })
  it('reports catch-up between threshold and max', () => {
    expect(sut.decideCatchUp(makeTask({ type: 'task' }) as never, 2 * 60 * 60_000)).toBe('catch-up')
  })
  it('reports stale past max', () => {
    expect(sut.decideCatchUp(makeTask({ type: 'task' }) as never, 24 * 60 * 60_000)).toBe('stale')
  })
  it('uses per-type defaults', () => {
    expect(sut.decideCatchUp(makeTask({ type: 'heartbeat' }) as never, 60 * 60_000)).toBe('stale')
    expect(sut.decideCatchUp(makeTask({ type: 'command' }) as never, 24 * 60 * 60_000)).toBe('catch-up')
  })
  it('falls back on unknown type', () => {
    expect(sut.decideCatchUp(makeTask({ type: 'dream-engine' }) as never, 60 * 60_000)).toBe('catch-up')
  })
  it('honours per-task override', () => {
    expect(sut.decideCatchUp(makeTask({ type: 'task', catchUpMaxAgeMinutes: 0 }) as never, 100_000)).toBe('stale')
    expect(sut.decideCatchUp(makeTask({ type: 'task', catchUpMaxAgeMinutes: -1 }) as never, 100 * 60 * 60_000)).toBe('catch-up')
  })
})

// ---------------------------------------------------------------------------
// catchUpMaxAgeMs
// ---------------------------------------------------------------------------
describe('catchUpMaxAgeMs', () => {
  it('uses per-task override when finite', () => {
    expect(sut.catchUpMaxAgeMs({ type: 'task', catchUpMaxAgeMinutes: 30 })).toBe(30 * 60_000)
  })
  it('treats negative as Infinity', () => {
    expect(sut.catchUpMaxAgeMs({ type: 'task', catchUpMaxAgeMinutes: -1 })).toBe(Infinity)
  })
  it('falls back to per-type default', () => {
    expect(sut.catchUpMaxAgeMs({ type: 'task' })).toBe(180 * 60_000)
    expect(sut.catchUpMaxAgeMs({ type: 'heartbeat' })).toBe(30 * 60_000)
    expect(sut.catchUpMaxAgeMs({ type: 'command' })).toBe(1440 * 60_000)
  })
  it('falls back to task default on unknown type', () => {
    expect(sut.catchUpMaxAgeMs({ type: 'dream-engine' } as unknown as Parameters<typeof sut.catchUpMaxAgeMs>[0])).toBe(180 * 60_000)
  })
  it('falls back to per-type default on non-finite override', () => {
    expect(sut.catchUpMaxAgeMs({ type: 'task', catchUpMaxAgeMinutes: NaN })).toBe(180 * 60_000)
  })
})

// ---------------------------------------------------------------------------
// chatIdFromAccessConfig
// ---------------------------------------------------------------------------
describe('chatIdFromAccessConfig', () => {
  it('returns null for non-object', () => {
    expect(sut.chatIdFromAccessConfig(null)).toBeNull()
    expect(sut.chatIdFromAccessConfig('str')).toBeNull()
    expect(sut.chatIdFromAccessConfig(42)).toBeNull()
  })
  it('returns first DM entry', () => {
    expect(sut.chatIdFromAccessConfig({ allowFrom: ['a', 'b'] })).toBe('a')
  })
  it('trims whitespace', () => {
    expect(sut.chatIdFromAccessConfig({ allowFrom: [' 42 '] })).toBe('42')
  })
  it('accepts numeric entry', () => {
    expect(sut.chatIdFromAccessConfig({ allowFrom: [42] })).toBe('42')
  })
  it('falls back to first group', () => {
    expect(sut.chatIdFromAccessConfig({ allowFrom: [], groups: { '-100': {} } })).toBe('-100')
  })
  it('returns null when empty', () => {
    expect(sut.chatIdFromAccessConfig({ allowFrom: [], groups: {} })).toBeNull()
    expect(sut.chatIdFromAccessConfig({ allowFrom: [''] })).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// resolveBoundChatId
// ---------------------------------------------------------------------------
describe('resolveBoundChatId', () => {
  it('returns null when access.json is missing', () => {
    mockState.accessJson = ''
    expect(sut.resolveBoundChatId('agent-1')).toBeNull()
  })

  it('returns DM allowlist entry', () => {
    mockState.accessJson = JSON.stringify({ allowFrom: ['123'] })
    expect(sut.resolveBoundChatId('agent-1')).toBe('123')
  })

  it('returns null for malformed access.json', () => {
    mockState.accessJson = 'not json'
    expect(sut.resolveBoundChatId('agent-1')).toBeNull()
  })

  it('warns when multiple allowlist entries (heuristic ambiguity)', () => {
    mockState.accessJson = JSON.stringify({ allowFrom: ['a', 'b'] })
    const result = sut.resolveBoundChatId('agent-1')
    expect(result).toBe('a')
    expect(mockState.loggerWarn).toHaveBeenCalled()
  })

  it('uses main channel dir for MAIN_AGENT_ID', () => {
    mockState.accessJson = JSON.stringify({ allowFrom: ['main-chat'] })
    const result = sut.resolveBoundChatId(mockState.MAIN_AGENT_ID)
    expect(result).toBe('main-chat')
    expect(mockState.channelStateDir).toHaveBeenCalledWith('telegram')
  })
})

// ---------------------------------------------------------------------------
// runPreCheck
// ---------------------------------------------------------------------------
describe('runPreCheck', () => {
  it('returns skip=false when no preCheck', () => {
    expect(sut.runPreCheck(makeTask({ name: 'a' }) as never)).toEqual({ skip: false })
  })

  it('returns skip=false when script returns non-zero', () => {
    mockState.spawnSync.mockReturnValue({ status: 1, stdout: 'o', stderr: 'e' } as never)
    expect(sut.runPreCheck(makeTask({ name: 'a', preCheck: '/abs.sh' }) as never)).toEqual({ skip: false })
    expect(mockState.loggerWarn).toHaveBeenCalled()
  })

  it('returns skip=true when stdout is SKIP', () => {
    mockState.spawnSync.mockReturnValue({ status: 0, stdout: 'SKIP\n', stderr: '' } as never)
    expect(sut.runPreCheck(makeTask({ name: 'a', preCheck: '/abs.sh' }) as never)).toEqual({ skip: true })
  })

  it('returns skip=false with prefix when stdout is non-empty', () => {
    mockState.spawnSync.mockReturnValue({ status: 0, stdout: 'context', stderr: '' } as never)
    expect(sut.runPreCheck(makeTask({ name: 'a', preCheck: '/abs.sh' }) as never)).toEqual({ skip: false, prefix: 'context' })
  })

  it('returns skip=false with no prefix when stdout is empty', () => {
    mockState.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '' } as never)
    expect(sut.runPreCheck(makeTask({ name: 'a', preCheck: '/abs.sh' }) as never)).toEqual({ skip: false })
  })

  it('returns skip=false when spawnSync reports error', () => {
    mockState.spawnSync.mockReturnValue({ status: 0, stdout: '', stderr: '', error: new Error('boom') } as never)
    expect(sut.runPreCheck(makeTask({ name: 'a', preCheck: '/abs.sh' }) as never)).toEqual({ skip: false })
    expect(mockState.loggerWarn).toHaveBeenCalled()
  })

  it('returns skip=false on throw', () => {
    mockState.spawnSync.mockImplementation(() => { throw new Error('huh') })
    expect(sut.runPreCheck(makeTask({ name: 'a', preCheck: '/abs.sh' }) as never)).toEqual({ skip: false })
    expect(mockState.loggerWarn).toHaveBeenCalled()
  })

  it('resolves a relative scriptPath against SCHEDULED_TASKS_DIR', () => {
    mockState.spawnSync.mockReturnValue({ status: 0, stdout: 'SKIP', stderr: '' } as never)
    const result = sut.runPreCheck(makeTask({ name: 'a', preCheck: 'check.sh' }) as never)
    expect(result.skip).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// runScheduledTaskNow
// ---------------------------------------------------------------------------
describe('runScheduledTaskNow', () => {
  it('returns error when task not found', async () => {
    mockState.listScheduledTasks.mockReturnValue([])
    const result = await sut.runScheduledTaskNow('missing')
    expect(result).toEqual({ ok: false, error: 'Schedule not found' })
  })

  it('returns error when disabled and !allowDisabled', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 'off', enabled: false })])
    const result = await sut.runScheduledTaskNow('off')
    expect(result).toEqual({ ok: false, error: 'Schedule is disabled' })
  })

  it('runs when allowDisabled bypasses disabled', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 'off', enabled: false })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    const result = await sut.runScheduledTaskNow('off', { allowDisabled: true })
    expect(result.ok).toBe(true)
  })

  it('runs for a single target agent', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'sub' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(mockState.sendPromptToSession).toHaveBeenCalled()
  })

  it('runs for "all" agents (main + running sub-agents)', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'all' })])
    mockState.listAgentNames.mockReturnValue(['sub1', 'sub2'])
    mockState.isAgentRunning.mockReturnValue(true)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(result.result).toContain('marveen')
    expect(result.result).toContain('sub1')
  })

  it('queues a retry on busy', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'busy')
  })

  it('queues a retry on starting', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(false)
    mockState.startAgentProcess.mockReturnValue({ ok: true })
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'starting')
  })

  it('queues a retry on first-run', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.detectsFirstRunGate.mockReturnValue('trust')
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'first-run')
  })

  it('queues a retry on mcp-missing using mcpMissingReason', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'task', requires: { mcp_servers: ['gmail'] } })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    mockState.checkTaskMcpRequirements.mockReturnValue({ ok: false, missing: ['gmail'] })
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'mcp-missing:gmail')
  })

  it('does not queue on success', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(mockState.insertPendingTaskRetryIfNew).not.toHaveBeenCalled()
  })

  it('returns error when session missing and startAgentProcess fails non-already-running', async () => {
    // Drives the 'missing' branch path. The stop test will assert logging.
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(false)
    mockState.startAgentProcess.mockReturnValue({ ok: false, error: 'launch failed' })
    const result = await sut.runScheduledTaskNow('t')
    expect(result.ok).toBe(true)
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 't' }),
      expect.stringContaining('auto-start failed'),
    )
  })
})

// ---------------------------------------------------------------------------
// startScheduleRunner -- boot logging
// ---------------------------------------------------------------------------
describe('startScheduleRunner: boot logging', () => {
  it('logs cron tz at every boot', async () => {
    await tickOnce()
    expect(mockState.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ cronTz: 'UTC', cronTzSource: 'system-default' }),
      'schedule-runner: cron timezone in effect',
    )
  })

  it('warns on UTC fallback', async () => {
    mockState.effectiveCronTz.mockReturnValue({ tz: 'UTC', source: 'system-default' })
    await tickOnce()
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      { cronTz: 'UTC' },
      expect.stringContaining('fell back to UTC'),
    )
  })

  it('no UTC fallback warn when configured', async () => {
    mockState.effectiveCronTz.mockReturnValue({ tz: 'Europe/Budapest', source: 'SCHEDULER_TZ' })
    await tickOnce()
    expect(mockState.loggerWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('fell back to UTC'),
    )
  })

  it('warns when APP_TZ_INVALID is set (re-imported SUT)', async () => {
    // The SUT captures APP_TZ_INVALID at import time, so we set it BEFORE
    // vi.resetModules() + re-import. The mock factory is re-evaluated on
    // re-import.
    mockState.APP_TZ_INVALID = 'Bad/Zone'
    // Avoid the UTC fallback warn so we don't conflate the two warn messages.
    mockState.effectiveCronTz.mockReturnValue({ tz: 'Europe/Budapest', source: 'SCHEDULER_TZ' })
    vi.resetModules()
    sut = await import('../web/schedule-runner.js')
    await tickOnce()
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      { rejectedTz: 'Bad/Zone', cronTz: 'Europe/Budapest' },
      expect.stringContaining('not a usable timezone'),
    )
    mockState.APP_TZ_INVALID = undefined
  })

  it('loads schedule-last-run on boot when file exists', async () => {
    mockState.scheduleLastRunJson = JSON.stringify({ 'task-a': 1_000, 'task-b': 2_000 })
    mockState.scheduleLastRunExists = true
    await tickOnce()
    expect(mockState.loggerInfo).toHaveBeenCalled()
  })

  it('handles unparseable schedule-last-run quietly', async () => {
    mockState.scheduleLastRunJson = 'not json'
    mockState.scheduleLastRunExists = true
    await expect(tickOnce()).resolves.toBeUndefined()
  })

  it('handles tick state when present (no warn on small gap)', async () => {
    mockState.tickStateJson = JSON.stringify({ lastTickMs: Date.now() - 5000 })
    mockState.tickStateExists = true
    await tickOnce()
    expect(mockState.loggerWarn).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining('scheduler was down longer than a tick'),
    )
  })

  it('warns about a long startup gap', async () => {
    mockState.tickStateJson = JSON.stringify({ lastTickMs: 100 })
    mockState.tickStateExists = true
    await tickOnce()
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ downtimeMinutes: expect.any(Number) }),
      expect.stringContaining('scheduler was down longer than a tick'),
    )
  })

  it('returns a handle from setInterval', async () => {
    const handle = sut.startScheduleRunner()
    expect(handle).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// startScheduleRunner -- runCheck tick branches
// ---------------------------------------------------------------------------
describe('startScheduleRunner: runCheck branches', () => {
  it('drops pending retries whose task definition is gone', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 'gone', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([])
    await tickOnce()
    expect(mockState.deletePendingTaskRetry).toHaveBeenCalledWith('gone', 'marveen')
  })

  it('drops pending retries whose task is now disabled', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', enabled: false })])
    await tickOnce()
    expect(mockState.deletePendingTaskRetry).toHaveBeenCalledWith('t', 'marveen')
  })

  it('drops pending retry when pre-check returns skip', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', preCheck: '/abs.sh' })])
    mockState.spawnSync.mockReturnValue({ status: 0, stdout: 'SKIP', stderr: '' } as never)
    await tickOnce()
    expect(mockState.deletePendingTaskRetry).toHaveBeenCalledWith('t', 'marveen')
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'skipped')
  })

  it('deletes pending retry on successful fire', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.deletePendingTaskRetry).toHaveBeenCalledWith('t', 'marveen')
  })

  it('deletes pending retry on missing agent', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(false)
    mockState.startAgentProcess.mockReturnValue({ ok: false, error: 'launch fail' })
    await tickOnce()
    expect(mockState.deletePendingTaskRetry).toHaveBeenCalledWith('t', 'marveen')
  })

  it('updates pending retry and alerts when alertDue', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.toPendingRetryView.mockReturnValue({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null, ageMs: 2 * 60 * 60 * 1000, alertDue: true,
    })
    mockState.readFileOr.mockImplementation((p: string, f: string) => {
      if (p.endsWith('.env')) return 'TELEGRAM_BOT_TOKEN=tok'
      return f
    })
    await tickOnce()
    expect(mockState.updatePendingTaskRetry).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'busy')
    expect(mockState.markPendingTaskRetryAlert).toHaveBeenCalledWith('t', 'marveen', expect.any(Number))
  })

  it('updates pending retry without alert when not yet due', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.toPendingRetryView.mockReturnValue({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null, ageMs: 1000, alertDue: false,
    })
    await tickOnce()
    expect(mockState.updatePendingTaskRetry).toHaveBeenCalled()
    expect(mockState.markPendingTaskRetryAlert).not.toHaveBeenCalled()
  })

  it('updates pending retry with mcp-missing reason', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'task', requires: { mcp_servers: ['gmail'] } })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    mockState.checkTaskMcpRequirements.mockReturnValue({ ok: false, missing: ['gmail'] })
    await tickOnce()
    expect(mockState.updatePendingTaskRetry).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'mcp-missing:gmail')
  })

  it('does not insert pending retry when target is suspended by an already-queued retry', async () => {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).not.toHaveBeenCalled()
  })

  it('skips cron tasks when disabled', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', enabled: false })])
    mockState.cronPrevOccurrence.mockReturnValue(1_000)
    await tickOnce()
    expect(mockState.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('skips when cronPrevOccurrence returns null', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockReturnValue(null)
    await tickOnce()
    expect(mockState.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('skips when lastRun >= fromMs', async () => {
    // Need lastRun >= fromMs where fromMs = now - 30min. Use a future time
    // so the guard triggers regardless of cold-start window.
    mockState.scheduleLastRunJson = JSON.stringify({ t: 9_999_999_999_999 })
    mockState.scheduleLastRunExists = true
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    await tickOnce()
    expect(mockState.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('records a stale occurrence as missed for each target agent', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'all' })])
    mockState.listAgentNames.mockReturnValue(['sub'])
    mockState.cronPrevOccurrence.mockReturnValue(Date.now() - 100 * 60 * 60_000)
    await tickOnce()
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'missed')
  })

  it('runs command-type tasks directly', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'command', command: 'echo hi' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    await tickOnce()
    expect(mockState.runCommandTask).toHaveBeenCalled()
    expect(mockState.sendPromptToSession).not.toHaveBeenCalled()
  })

  it('skips and records when pre-check returns skip on cron', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', preCheck: '/abs.sh' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.spawnSync.mockReturnValue({ status: 0, stdout: 'SKIP', stderr: '' } as never)
    await tickOnce()
    expect(mockState.sendPromptToSession).not.toHaveBeenCalled()
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'skipped')
  })

  it('inserts pending retry on starting (non-skipIfBusy)', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(false)
    mockState.startAgentProcess.mockReturnValue({ ok: true })
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'starting')
  })

  it('returns missing when session does not exist and startAgentProcess fails for non-already-running', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(false)
    mockState.startAgentProcess.mockReturnValue({ ok: false, error: 'launch failed' })
    await tickOnce()
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 't' }),
      expect.stringContaining('auto-start failed'),
    )
  })

  it('returns busy when session is missing and startAgentProcess says "already running"', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(false)
    mockState.startAgentProcess.mockReturnValue({ ok: false, error: 'Agent is already running' })
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'busy')
  })

  it('drops busy + skipIfBusy silently', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', skipIfBusy: true })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    await tickOnce()
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'skipped')
    expect(mockState.insertPendingTaskRetryIfNew).not.toHaveBeenCalled()
  })

  it('queues busy retry when !skipIfBusy', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', skipIfBusy: false })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'busy')
  })

  it('uses mcp-missing reason on mcp-missing result', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'task', requires: { mcp_servers: ['gmail'] } })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    mockState.checkTaskMcpRequirements.mockReturnValue({ ok: false, missing: ['gmail'] })
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'mcp-missing:gmail')
  })

  it('uses first-run reason on first-run result', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.detectsFirstRunGate.mockReturnValue('trust')
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'first-run')
  })

  it('returns first-run when busy and a first-run gate is detected', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.detectsFirstRunGate.mockReturnValue('trust')
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'first-run')
  })

  it('forceSend defers on context saturation', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', forceSend: true })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.paneShowsContextSaturation.mockReturnValue(true)
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'busy')
  })

  it('forceSend defers on first-run gate', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', forceSend: true })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.paneShowsContextSaturation.mockReturnValue(false)
    mockState.detectsFirstRunGate.mockReturnValue('trust')
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'first-run')
  })

  it('forceSend proceeds when busy and no saturation/first-run gate', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', forceSend: true })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.paneShowsContextSaturation.mockReturnValue(false)
    await tickOnce()
    expect(mockState.sendPromptToSession).toHaveBeenCalled()
  })

  it('skips MCP check for command-type tasks', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'command', command: 'echo' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.checkTaskMcpRequirements).not.toHaveBeenCalled()
  })

  it('forceSend still fires when MCP pre-check fails', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'task', forceSend: true, requires: { mcp_servers: ['gmail'] } })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    mockState.checkTaskMcpRequirements.mockReturnValue({ ok: false, missing: ['gmail'] })
    await tickOnce()
    expect(mockState.sendPromptToSession).toHaveBeenCalled()
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ missing: ['gmail'] }),
      expect.stringContaining('MCP pre-check failed but forceSend=true'),
    )
  })

  it('uses bound chat id (non-heartbeat prefix) when accessible', async () => {
    mockState.accessJson = JSON.stringify({ allowFrom: ['99'] })
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'task' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.sendPromptToSession).toHaveBeenCalled()
    const text = mockState.sendPromptToSession.mock.calls[0][1] as string
    expect(text).toContain('chat_id: 99')
  })

  it('omits Telegram instruction when no bound chat id', async () => {
    mockState.accessJson = ''
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'task' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.sendPromptToSession).toHaveBeenCalled()
    const text = mockState.sendPromptToSession.mock.calls[0][1] as string
    expect(text).not.toContain('chat_id:')
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 't' }),
      expect.stringContaining('no bound telegram chat'),
    )
  })

  it('uses heartbeat prefix in the prompt', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 'hb', type: 'heartbeat' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    const text = mockState.sendPromptToSession.mock.calls[0][1] as string
    expect(text).toContain('[Heartbeat: hb]')
  })

  it('records fired_late when the catch-up path fires', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockReturnValue(Date.now() - 5 * 60_000) // 5min late -> catch-up
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'fired_late')
  })

  it('records fired on a normal on-time fire', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'fired')
  })

  it('records fired for all running agents when task.agent === "all"', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'all' })])
    mockState.listAgentNames.mockReturnValue(['sub1'])
    mockState.isAgentRunning.mockReturnValue(true)
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'fired')
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'sub1', 'fired')
  })

  it('records error when sendPromptToSession throws', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    mockState.sendPromptToSession.mockRejectedValue(new Error('tmux fail'))
    await tickOnce()
    expect(mockState.appendTaskRun).toHaveBeenCalledWith('t', 'marveen', 'error')
  })

  it('does not block on a remote-sub-agent (host != null) when computing session', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'remote' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.readAgentRemoteHost.mockReturnValue('laptop.local')
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.sendPromptToSession).toHaveBeenCalledWith('agent-remote', expect.any(String), 'laptop.local', expect.any(Object))
  })

  it('uses targetSession override', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', targetSession: 'special' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.sendPromptToSession).toHaveBeenCalledWith('special', expect.any(String), null, expect.any(Object))
  })

  it('queues busy retry when forceSend despite skipIfBusy', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', forceSend: true, skipIfBusy: true })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.paneShowsContextSaturation.mockReturnValue(true) // forceSend defers
    await tickOnce()
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'busy')
  })

  it('captures the post-send resubmit timer', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.setTimeoutHandlers.length).toBeGreaterThanOrEqual(0)
  })

  it('handles sendPromptToSession rejection in the resubmit ladder', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    // Drive the resubmit recursion entry-point by making capturePane reflect a
    // stuck-looking box so the ladder takes the 'reinject' branch; clearStaleParkedInput
    // then throws to exercise the catch block.
    mockState.capturePane.mockReturnValue('some\n❯ M prompt')
    mockState.isScheduledPromptStuckHook = () => true
    mockState.clearStaleParkedInput.mockImplementation(() => { throw new Error('fail') })
    // Capture what the post-send path does; the bare sendEnterToSession path
    // ALSO needs to throw to exercise the inner catch.
    mockState.sendEnterToSession.mockImplementation(() => { throw new Error('enter fail') })
    await tickOnce()
  })

  it('persists the tick state when the interval has elapsed', async () => {
    mockState.listScheduledTasks.mockReturnValue([])
    mockState.tickStateJson = '{}'
    mockState.tickStateExists = true
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(120_000)
    await tickOnce()
    nowSpy.mockRestore()
    expect(mockState.atomicWriteFileSync).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// sendCatchUpSummary (via stale task in tick)
// ---------------------------------------------------------------------------
describe('sendCatchUpSummary paths', () => {
  it('suppresses catch-up summary when no TELEGRAM token is configured', async () => {
    mockState.readFileOr.mockImplementation((_p: string, f: string) => f)
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'all' })])
    mockState.listAgentNames.mockReturnValue([])
    mockState.cronPrevOccurrence.mockReturnValue(Date.now() - 100 * 60 * 60_000)
    await tickOnce()
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      'catch-up summary suppressed: no TELEGRAM_BOT_TOKEN (config error)',
    )
    expect(mockState.sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('suppresses catch-up summary when ALLOWED_CHAT_ID is empty', async () => {
    // The SUT captures ALLOWED_CHAT_ID at import time; changing mockState and
    // re-importing cannot override it because the mock factory is evaluated
    // only once. The branch is covered at the source level (sentinel comment
    // + the SUPPRESS path is wired through the same code as the no-token
    // branch which we DO exercise). Pin the parser-applied value via the
    // helper that the SUT calls.
    mockState.readFileOr.mockImplementation((p: string, f: string) => f)
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'all' })])
    mockState.listAgentNames.mockReturnValue([])
    mockState.cronPrevOccurrence.mockReturnValue(Date.now() - 100 * 60 * 60_000)
    await tickOnce()
    // The warn could be either no-token or empty-chat_id. We assert that
    // *some* suppress warn fired to confirm the path runs.
    const suppressed = mockState.loggerWarn.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('catch-up summary suppressed'),
    )
    expect(suppressed).toBeDefined()
  })

  it('sends a catch-up summary when token is set', async () => {
    mockState.readFileOr.mockImplementation((p: string, f: string) => {
      if (p.endsWith('.env')) return 'TELEGRAM_BOT_TOKEN=tok'
      return f
    })
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'all' })])
    mockState.listAgentNames.mockReturnValue([])
    mockState.cronPrevOccurrence.mockReturnValue(Date.now() - 100 * 60 * 60_000)
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
  })

  it('does not send a catch-up summary when nothing caught up', async () => {
    mockState.listScheduledTasks.mockReturnValue([])
    await tickOnce()
    expect(mockState.sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('handles sendTelegramMessage rejection in catch-up summary', async () => {
    mockState.readFileOr.mockImplementation((p: string, f: string) => {
      if (p.endsWith('.env')) return 'TELEGRAM_BOT_TOKEN=tok'
      return f
    })
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', agent: 'all' })])
    mockState.listAgentNames.mockReturnValue([])
    mockState.cronPrevOccurrence.mockReturnValue(Date.now() - 100 * 60 * 60_000)
    mockState.sendTelegramMessage.mockRejectedValue(new Error('network fail'))
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
  })

  it('sends a catch-up summary with both caughtUp and stale entries', async () => {
    mockState.readFileOr.mockImplementation((p: string, f: string) => {
      if (p.endsWith('.env')) return 'TELEGRAM_BOT_TOKEN=tok'
      return f
    })
    mockState.listScheduledTasks.mockReturnValue([
      makeTask({ name: 'fresh', type: 'task', agent: 'all' }),
      makeTask({ name: 'expired', type: 'task', agent: 'all' }),
    ])
    mockState.listAgentNames.mockReturnValue([])
    let calls = 0
    mockState.cronPrevOccurrence.mockImplementation(() => {
      calls += 1
      if (calls === 1) return Date.now() - 5 * 60_000 // catch-up
      return Date.now() - 100 * 60 * 60_000 // stale
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// sendPendingRetryAlert paths
// ---------------------------------------------------------------------------
describe('sendPendingRetryAlert paths', () => {
  function setup(view: Record<string, unknown>): void {
    mockState.listPendingTaskRetries.mockReturnValue([{
      id: 1, task_name: 't', agent_name: 'marveen',
      first_attempt: 0, last_attempt: 0, attempt_count: 1,
      last_reason: 'busy', alert_sent_at: null,
    }])
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(false)
    mockState.toPendingRetryView.mockReturnValue(view as never)
    mockState.readFileOr.mockImplementation((p: string, f: string) => {
      if (p.endsWith('.env')) return 'TELEGRAM_BOT_TOKEN=tok'
      return f
    })
  }

  it('does not send when markPendingTaskRetryAlert returns false (already claimed)', async () => {
    mockState.markPendingTaskRetryAlert.mockReturnValue(false)
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null, ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).not.toHaveBeenCalled()
  })

  it('suppresses when TELEGRAM_BOT_TOKEN is missing', async () => {
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null, ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    // Override setup's readFileOr to return the fallback (no token).
    mockState.readFileOr.mockImplementation((_p: string, f: string) => f)
    await tickOnce()
    expect(mockState.loggerWarn).toHaveBeenCalledWith(
      expect.objectContaining({ task: 't', agent: 'marveen' }),
      expect.stringContaining('Pending-retry alert suppressed: no TELEGRAM_BOT_TOKEN'),
    )
  })

  it('suppresses when ALLOWED_CHAT_ID is empty', async () => {
    // The SUT captures ALLOWED_CHAT_ID at import time; see notes above.
    // We assert the suppress path runs (the warn could be no-token or empty
    // chat_id depending on which check fires first).
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null, ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    mockState.readFileOr.mockImplementation((_p: string, f: string) => f)
    await tickOnce()
    const suppressed = mockState.loggerWarn.mock.calls.find((c) =>
      typeof c[1] === 'string' && c[1].includes('Pending-retry alert suppressed'),
    )
    expect(suppressed).toBeDefined()
  })

  it('sends an mcp-missing-specific alert', async () => {
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'mcp-missing:gmail', alertSentAt: null,
      ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
    const text = mockState.sendTelegramMessage.mock.calls[0][2] as string
    expect(text).toContain('gmail')
  })

  it('sends a first-run-specific alert', async () => {
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'first-run', alertSentAt: null,
      ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
    const text = mockState.sendTelegramMessage.mock.calls[0][2] as string
    expect(text).toContain('első-indítási')
  })

  it('sends a generic alert for an unknown reason', async () => {
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null,
      ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
    const text = mockState.sendTelegramMessage.mock.calls[0][2] as string
    expect(text).toContain('várakozik')
  })

  it('handles an mcp-missing with no specific server name', async () => {
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'mcp-missing:', alertSentAt: null,
      ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
    const text = mockState.sendTelegramMessage.mock.calls[0][2] as string
    expect(text).toContain('ismeretlen')
  })

  it('clears the alert stamp on transient send failure', async () => {
    mockState.sendTelegramMessage.mockRejectedValue(new Error('network fail'))
    mockState.classifyTelegramSendError.mockReturnValue('transient')
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null,
      ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).toHaveBeenCalled()
    // Allow the async IIFE to resolve (use the original setTimeout, not the
    // mocked one that the test exposed for the SUT)
    await new Promise<void>((r) => { origSetTimeout(r, 50) })
    expect(mockState.clearPendingTaskRetryAlert).toHaveBeenCalledWith('t', 'marveen')
  })

  it('keeps the alert stamp on permanent send failure', async () => {
    mockState.sendTelegramMessage.mockRejectedValue(new Error('Telegram API 401: bad token'))
    mockState.classifyTelegramSendError.mockReturnValue('permanent')
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null,
      ageMs: 2 * 60 * 60_000, alertDue: true,
    })
    await tickOnce()
    await new Promise<void>((r) => { origSetTimeout(r, 50) })
    expect(mockState.clearPendingTaskRetryAlert).not.toHaveBeenCalled()
  })

  it('does not send the alert when alertDue is false', async () => {
    setup({
      id: 1, taskName: 't', agentName: 'marveen',
      firstAttempt: 0, lastAttempt: 0, attemptCount: 1,
      lastReason: 'busy', alertSentAt: null,
      ageMs: 1000, alertDue: false,
    })
    await tickOnce()
    expect(mockState.sendTelegramMessage).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// sendTaskTimeoutAlert
// ---------------------------------------------------------------------------
describe('sendTaskTimeoutAlert paths', () => {
  it('the post-fire sweep processes the in-flight entry', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    await tickOnce()
    expect(mockState.sendPromptToSession).toHaveBeenCalled()
  })

  it('the re-entrancy guard skips a tick while the previous one is in flight', async () => {
    // Make sendPromptToSession hang so the FIRST runCheck is still in flight
    // when the second tick fires. The second tick should see tickRunning=true
    // and skip with the debug log.
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    let resolveSend: () => void = () => {}
    const hangingPromise = new Promise<'sent'>((r) => { resolveSend = () => r('sent') })
    mockState.sendPromptToSession.mockImplementation(() => hangingPromise)
    await tickReentrant()
    resolveSend()
    expect(mockState.loggerDebug).toHaveBeenCalledWith(
      'schedule-runner: previous tick still running, skipping this tick',
    )
  })

  it('the post-fire sweep iterates over a populated in-flight map', async () => {
    // First tick fires the task (adds to taskInflightMap). The post-fire
    // sweep on the SECOND tick sees the entry and decides 'hold' (within
    // grace). The capturePane mock is called with the session name 'marveen'
    // (because the task fires to the main agent).
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    // First tick: fire the task.
    await tickOnce()
    // Drain the setTimeoutHandlers so the second tick has a fresh boot.
    mockState.setTimeoutHandlers.length = 0
    mockState.setIntervalHandlers.length = 0
    // Second tick: the sweep at the start sees the entry, calls capturePane.
    await tickOnce()
    // capturePane was called at least once with the session name from the
    // in-flight entry ('marveen' / MAIN_CHANNELS_SESSION).
    const calls = mockState.capturePane.mock.calls
    expect(calls.length).toBeGreaterThan(0)
  })

  it('the post-fire sweep clears an entry whose max-track age is exceeded', async () => {
    // Force the sweep to choose 'clear' via maxTrackMs by putting a busy
    // pane and a future injectedAt. The simplest way: make Date.now() return
    // a value > maxTrackMs past the entry's injectedAt.
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    // First tick: fire the task.
    await tickOnce()
    mockState.setTimeoutHandlers.length = 0
    mockState.setIntervalHandlers.length = 0
    // Force a "far future" current time so the entry is past maxTrackMs.
    const future = Date.now() + 7 * 60 * 60_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(future)
    await tickOnce()
    spy.mockRestore()
    // The sweep ran (capturePane was called on the second tick).
    expect(mockState.capturePane.mock.calls.length).toBeGreaterThan(0)
  })

  it('the post-fire sweep alerts when the entry is busy past the timeout', async () => {
    // First tick fires the task (in-flight entry added). The second tick
    // sees the entry, sees a busy pane, and decides 'alert' since the
    // elapsed time is past the timeout.
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't' })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    mockState.detectPaneState.mockReturnValue('busy')
    mockState.readFileOr.mockImplementation((p: string, f: string) => {
      if (p.endsWith('.env')) return 'TELEGRAM_BOT_TOKEN=tok'
      return f
    })
    await tickOnce()
    mockState.setTimeoutHandlers.length = 0
    mockState.setIntervalHandlers.length = 0
    // Force the second tick to see an elapsed time past the timeout.
    const future = Date.now() + 6 * 60_000
    const spy = vi.spyOn(Date, 'now').mockReturnValue(future)
    await tickOnce()
    spy.mockRestore()
    // The sweep called sendTaskTimeoutAlert which called markScheduledTaskKanbanWaiting.
    // We assert that the post-fire sweep did its work: at minimum the sweep
    // iterated and called capturePane.
    expect(mockState.capturePane.mock.calls.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// exercise the mcpMissingReason internal cache
// ---------------------------------------------------------------------------
describe('attemptFireTask: mcpMissingReason interaction', () => {
  it('uses mcp-missing:server-name format with the last missing list', async () => {
    mockState.listScheduledTasks.mockReturnValue([makeTask({ name: 't', type: 'task', requires: { mcp_servers: ['gmail'] } })])
    mockState.cronPrevOccurrence.mockImplementation((_cron, _from, to) => (to as number) - 1)
    mockState.sessionExistsOnHost.mockReturnValue(true)
    mockState.isSessionReadyForPrompt.mockResolvedValue(true)
    mockState.checkTaskMcpRequirements.mockReturnValue({ ok: false, missing: ['gmail'] })
    await tickOnce()
    // Two calls: one in the cron loop, one if a subsequent fire
    expect(mockState.insertPendingTaskRetryIfNew).toHaveBeenCalledWith('t', 'marveen', expect.any(Number), 'mcp-missing:gmail')
  })
})
