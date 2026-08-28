import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import type http from 'node:http'

// ----------------------------------------------------------------------------
// src/web.ts is a boot function: it builds one http.createServer request
// handler, wires an EADDRINUSE port-reclaim path, and starts ~20 background
// intervals. Nothing here may touch a real socket, a real child process or a
// real store, so EVERY module it imports is replaced with a vi.doMock factory
// and web.ts itself is only ever loaded through loadWeb() (dynamic import after
// vi.resetModules), which lets each test pick a different config shape.
//
// The fake server below stands in for node:http's Server: listen() invokes its
// callback synchronously, `listening` is a writable flag the tests flip, and
// 'error' is emitted by hand to drive the reclaim path.
// ----------------------------------------------------------------------------

// --- fake http server -------------------------------------------------------

type ReqHandler = (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void

class FakeServer extends EventEmitter {
  listening = true
  listenCalls: Array<{ port: number; host: string }> = []
  closeCalls: Array<((err?: Error) => void) | undefined> = []

  listen(port: number, host: string, cb?: () => void): this {
    this.listenCalls.push({ port, host })
    cb?.()
    return this
  }

  close(cb?: (err?: Error) => void): this {
    this.closeCalls.push(cb)
    return this
  }
}

// --- shared mock state ------------------------------------------------------

const H = vi.hoisted(() => {
  const mkFn = () => vi.fn()
  return {
    createServer: vi.fn(),
    mkdirSync: mkFn(),
    tmpdir: vi.fn(() => '/tmp'),
    execSync: mkFn(),
    execFileSync: mkFn(),
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    loadOrCreateDashboardToken: vi.fn(() => 'TOK'),
    resolveAuth: mkFn(),
    requiresAuth: mkFn(),
    isFederationWireEndpoint: mkFn(),
    sweepExpiredSessions: mkFn(),
    sweepExpiredDeviceKeys: mkFn(),
    isBlockedCrossOriginWrite: mkFn(),
    originMatchesServedHost: mkFn(),
    json: mkFn(),
    detectLanIp: vi.fn(() => '10.0.0.5'),
    listAgentNames: mkFn(),
    ensureAgentHooks: mkFn(),
    ensureAgentStalenessHook: mkFn(),
    ensureEgressGate: mkFn(),
    ensureGovernanceGateCommands: mkFn(),
    ensureQuarantineReader: mkFn(),
    ensureDefaultScheduledTasks: mkFn(),
    agentSettingsPath: vi.fn((n: string) => `/agents/${n}/settings.json`),
    ensureAutonomySection: mkFn(),
    shouldRegisterHooks: mkFn(),
    pruneStaleHooksFromSettingsFile: mkFn(),
    refreshMarveenBotUsername: mkFn(),
    collectTokenUsage: mkFn(),
    ensureFederationClaudeMdSection: mkFn(),
    sweepOrphanTaskStates: mkFn(),
    sweepOrphanedBackgroundTasks: mkFn(),
    startWorkerSession: mkFn(),
    startWorkerLivenessMonitor: mkFn(),
    workerImportFails: { value: false },
    livenessImportFails: { value: false },
  }
})

/** Every `start*` loop web.ts owns, keyed by the export name it is mocked as. */
const LOOP_EXPORTS = [
  'startMessageRouter',
  'startScheduleRunner',
  'startChannelPluginMonitor',
  'startInboundProber',
  'startChannelHealthMonitor',
  'startStuckInputWatcher',
  'startStuckToolCallWatcher',
  'startInboxNudgeWatcher',
  'startReauthHealer',
  'startAutoRestartRunner',
  'startModelFallbackRunner',
  'startContextGuardRunner',
  'startUpdateChecker',
  'startFederationPoller',
  'startCapabilitySummaryRunner',
  'startApprovalTimeoutSweeper',
  'startCostsSyncTask',
] as const
type LoopExport = (typeof LOOP_EXPORTS)[number]

const loops = new Map<LoopExport, ReturnType<typeof vi.fn>>()
for (const name of LOOP_EXPORTS) loops.set(name, vi.fn())

/** Route dispatch table, in the exact order web.ts walks it. */
const ROUTE_MODULES: Array<[string, string]> = [
  ['./web/routes/auth.js', 'tryHandleAuth'],
  ['./web/routes/security.js', 'tryHandleSecurity'],
  ['./web/routes/profiles.js', 'tryHandleProfiles'],
  ['./web/routes/messages.js', 'tryHandleMessages'],
  ['./web/routes/federation.js', 'tryHandleFederation'],
  ['./web/routes/daily-log.js', 'tryHandleDailyLog'],
  ['./web/routes/memories.js', 'tryHandleMemories'],
  ['./web/routes/migrate.js', 'tryHandleMigrate'],
  ['./web/routes/kanban.js', 'tryHandleKanban'],
  ['./web/routes/schedules.js', 'tryHandleSchedules'],
  ['./web/routes/connectors-hu.js', 'tryHandleConnectorsHu'],
  ['./web/routes/connectors.js', 'tryHandleConnectors'],
  ['./web/routes/docs.js', 'tryHandleDocs'],
  ['./web/routes/research.js', 'tryHandleResearch'],
  ['./web/routes/agents-skills.js', 'tryHandleAgentsSkills'],
  ['./web/routes/skills.js', 'tryHandleSkills'],
  ['./web/routes/agent-terminal.js', 'tryHandleAgentTerminal'],
  ['./web/routes/agent-conversation.js', 'tryHandleAgentConversation'],
  ['./web/routes/agent-taskstate.js', 'tryHandleAgentTaskState'],
  ['./web/routes/agents.js', 'tryHandleAgents'],
  ['./web/routes/marveen.js', 'tryHandleMarveen'],
  ['./web/routes/background-tasks.js', 'tryHandleBackgroundTasks'],
  ['./web/routes/recall.js', 'tryHandleRecall'],
  ['./web/routes/overview.js', 'tryHandleOverview'],
  ['./web/routes/updates.js', 'tryHandleUpdates'],
  ['./web/routes/onboarding.js', 'tryHandleOnboarding'],
  ['./web/routes/status.js', 'tryHandleStatus'],
  ['./web/routes/autonomy.js', 'tryHandleAutonomy'],
  ['./web/routes/approvals.js', 'tryHandleApprovals'],
  ['./web/routes/token-usage.js', 'tryHandleTokenUsage'],
  ['./web/routes/costs.js', 'tryHandleCosts'],
  ['./web/routes/ideas.js', 'tryHandleIdeas'],
  ['./web/routes/spans.js', 'tryHandleSpans'],
  ['./web/routes/tool-log.js', 'tryHandleToolLog'],
  ['./web/routes/skill-usage.js', 'tryHandleSkillUsage'],
  ['./web/routes/settings.js', 'tryHandleSettings'],
  ['./web/routes/voice.js', 'tryHandleVoice'],
  ['./web/routes/vault-ssh-keys.js', 'tryHandleVaultSshKeys'],
  ['./web/routes/vault-ssh.js', 'tryHandleVaultSsh'],
  ['./web/routes/audit-log.js', 'tryHandleAuditLog'],
  ['./web/routes/fleet-q.js', 'tryHandleFleetQ'],
  ['./web/routes/fleet.js', 'tryHandleFleet'],
  ['./web/routes/static.js', 'tryHandleStatic'],
]
/** Dispatch order as walked by the handler (routes.js order above matches). */
const ROUTE_ORDER = ROUTE_MODULES.map(([, name]) => name)

const routes = new Map<string, ReturnType<typeof vi.fn>>()
for (const [, name] of ROUTE_MODULES) routes.set(name, vi.fn())

function route(name: string): ReturnType<typeof vi.fn> {
  const fn = routes.get(name)
  if (!fn) throw new Error(`unknown route mock: ${name}`)
  return fn
}
function loop(name: LoopExport): ReturnType<typeof vi.fn> {
  const fn = loops.get(name)
  if (!fn) throw new Error(`unknown loop mock: ${name}`)
  return fn
}

// --- config knobs -----------------------------------------------------------

interface ConfigShape {
  PROJECT_ROOT: string
  WEB_HOST: string
  DASHBOARD_PUBLIC_URL: string
  DASHBOARD_ALLOWED_ORIGINS: string
  MAIN_AGENT_ID: string
}

const DEFAULT_CONFIG: ConfigShape = {
  PROJECT_ROOT: '/opt/marveen',
  WEB_HOST: '127.0.0.1',
  DASHBOARD_PUBLIC_URL: '',
  DASHBOARD_ALLOWED_ORIGINS: '',
  MAIN_AGENT_ID: 'marveen',
}

// --- module registration ----------------------------------------------------

function registerMocks(config: ConfigShape): void {
  vi.doMock('node:http', () => ({ default: { createServer: H.createServer }, createServer: H.createServer }))
  vi.doMock('node:fs', () => ({ default: { mkdirSync: H.mkdirSync }, mkdirSync: H.mkdirSync }))
  vi.doMock('node:os', () => ({ default: { tmpdir: H.tmpdir }, tmpdir: H.tmpdir }))
  vi.doMock('node:child_process', () => ({ execSync: H.execSync, execFileSync: H.execFileSync }))

  vi.doMock('../config.js', () => ({ ...config }))
  vi.doMock('../logger.js', () => ({ logger: H.logger }))

  vi.doMock('../web/dashboard-auth.js', () => ({ loadOrCreateDashboardToken: H.loadOrCreateDashboardToken }))
  vi.doMock('../web/auth-gate.js', () => ({
    resolveAuth: H.resolveAuth,
    requiresAuth: H.requiresAuth,
    isFederationWireEndpoint: H.isFederationWireEndpoint,
  }))
  vi.doMock('../web/auth-sessions.js', () => ({ sweepExpiredSessions: H.sweepExpiredSessions }))
  vi.doMock('../web/auth-device-keys.js', () => ({ sweepExpiredDeviceKeys: H.sweepExpiredDeviceKeys }))
  vi.doMock('../web/csrf-origin.js', () => ({
    isBlockedCrossOriginWrite: H.isBlockedCrossOriginWrite,
    originMatchesServedHost: H.originMatchesServedHost,
  }))
  vi.doMock('../web/http-helpers.js', () => ({ json: H.json }))
  vi.doMock('../web/network-info.js', () => ({ detectLanIp: H.detectLanIp }))
  vi.doMock('../web/agent-config.js', () => ({
    AGENTS_BASE_DIR: '/opt/marveen/agents',
    listAgentNames: H.listAgentNames,
  }))
  vi.doMock('../web/agent-scaffold.js', () => ({
    ensureAgentHooks: H.ensureAgentHooks,
    ensureAgentStalenessHook: H.ensureAgentStalenessHook,
    ensureEgressGate: H.ensureEgressGate,
    ensureGovernanceGateCommands: H.ensureGovernanceGateCommands,
    ensureQuarantineReader: H.ensureQuarantineReader,
    ensureDefaultScheduledTasks: H.ensureDefaultScheduledTasks,
    agentSettingsPath: H.agentSettingsPath,
    ensureAutonomySection: H.ensureAutonomySection,
  }))
  vi.doMock('../web/hook-registration-guard.js', () => ({
    shouldRegisterHooks: H.shouldRegisterHooks,
    pruneStaleHooksFromSettingsFile: H.pruneStaleHooksFromSettingsFile,
  }))
  vi.doMock('../web/telegram.js', () => ({ refreshMarveenBotUsername: H.refreshMarveenBotUsername }))
  vi.doMock('../web/token-usage.js', () => ({ collectTokenUsage: H.collectTokenUsage }))
  vi.doMock('../web/federation/onboarding.js', () => ({
    ensureFederationClaudeMdSection: H.ensureFederationClaudeMdSection,
  }))
  vi.doMock('../web/agent-taskstate.js', () => ({ sweepOrphanTaskStates: H.sweepOrphanTaskStates }))

  // Background loops, each in its own module.
  vi.doMock('../web/message-router.js', () => ({ startMessageRouter: loop('startMessageRouter') }))
  vi.doMock('../web/update-checker.js', () => ({ startUpdateChecker: loop('startUpdateChecker') }))
  vi.doMock('../web/schedule-runner.js', () => ({ startScheduleRunner: loop('startScheduleRunner') }))
  vi.doMock('../web/channel-monitor.js', () => ({ startChannelPluginMonitor: loop('startChannelPluginMonitor') }))
  vi.doMock('../web/inbound-probe.js', () => ({ startInboundProber: loop('startInboundProber') }))
  vi.doMock('../web/channel-health-monitor.js', () => ({ startChannelHealthMonitor: loop('startChannelHealthMonitor') }))
  vi.doMock('../web/stuck-input-watcher.js', () => ({ startStuckInputWatcher: loop('startStuckInputWatcher') }))
  vi.doMock('../web/inbox-nudge-watcher.js', () => ({ startInboxNudgeWatcher: loop('startInboxNudgeWatcher') }))
  vi.doMock('../web/stuck-tool-call-watcher.js', () => ({ startStuckToolCallWatcher: loop('startStuckToolCallWatcher') }))
  vi.doMock('../web/reauth-healer.js', () => ({ startReauthHealer: loop('startReauthHealer') }))
  vi.doMock('../web/auto-restart-runner.js', () => ({ startAutoRestartRunner: loop('startAutoRestartRunner') }))
  vi.doMock('../web/model-fallback-runner.js', () => ({ startModelFallbackRunner: loop('startModelFallbackRunner') }))
  vi.doMock('../web/context-guard-runner.js', () => ({ startContextGuardRunner: loop('startContextGuardRunner') }))
  vi.doMock('../web/federation/poller.js', () => ({ startFederationPoller: loop('startFederationPoller') }))
  vi.doMock('../web/federation/capability-runner.js', () => ({
    startCapabilitySummaryRunner: loop('startCapabilitySummaryRunner'),
  }))

  // Dynamically imported (worker warm-up + liveness monitor).
  vi.doMock('../web/agent-worker.js', () => {
    if (H.workerImportFails.value) throw new Error('agent-worker import boom')
    return { startWorkerSession: H.startWorkerSession }
  })
  vi.doMock('../web/worker-liveness.js', () => {
    if (H.livenessImportFails.value) throw new Error('worker-liveness import boom')
    return { startWorkerLivenessMonitor: H.startWorkerLivenessMonitor }
  })

  // Route modules. Three of them also export a non-route symbol web.ts uses.
  const extras: Record<string, Record<string, unknown>> = {
    './web/routes/approvals.js': { startApprovalTimeoutSweeper: loop('startApprovalTimeoutSweeper') },
    './web/routes/costs.js': { startCostsSyncTask: loop('startCostsSyncTask') },
    './web/routes/background-tasks.js': { sweepOrphanedBackgroundTasks: H.sweepOrphanedBackgroundTasks },
  }
  for (const [spec, exportName] of ROUTE_MODULES) {
    const testSpec = spec.replace('./web/', '../web/')
    vi.doMock(testSpec, () => ({ [exportName]: route(exportName), ...(extras[spec] ?? {}) }))
  }
}

// --- harness ----------------------------------------------------------------

let server: FakeServer
let handler: ReqHandler
const origExit = process.exit.bind(process)
const origKill = process.kill.bind(process)
const exitCalls: Array<number | string | null | undefined> = []
const killCalls: Array<{ pid: number; signal: unknown }> = []
let killImpl: (pid: number, signal?: unknown) => void = () => {}

async function loadWeb(
  overrides: Partial<ConfigShape> = {},
): Promise<(port?: number) => http.Server> {
  vi.resetModules()
  registerMocks({ ...DEFAULT_CONFIG, ...overrides })
  const mod = await import('../web.js')
  return mod.startWebServer
}

/** Boot the server with the current mock shape and expose its request handler. */
async function boot(port = 3420, overrides: Partial<ConfigShape> = {}): Promise<FakeServer> {
  const startWebServer = await loadWeb(overrides)
  startWebServer(port)
  return server
}

interface FakeRes {
  statusCode?: number
  headers: Record<string, string>
  head: Array<[number, Record<string, string> | undefined]>
  body: string[]
  ended: boolean
  setHeader(k: string, v: string): void
  writeHead(code: number, hdrs?: Record<string, string>): void
  end(chunk?: string): void
}

function mkRes(): FakeRes {
  const res: FakeRes = {
    headers: {},
    head: [],
    body: [],
    ended: false,
    setHeader(k, v) { res.headers[k] = v },
    writeHead(code, hdrs) { res.statusCode = code; res.head.push([code, hdrs]) },
    end(chunk) { res.ended = true; if (chunk !== undefined) res.body.push(chunk) },
  }
  return res
}

function mkReq(opts: { url?: string; method?: string; headers?: Record<string, string> } = {}): http.IncomingMessage {
  const req = { headers: opts.headers ?? {} } as Record<string, unknown>
  if (opts.url !== undefined) req['url'] = opts.url
  if (opts.method !== undefined) req['method'] = opts.method
  return req as unknown as http.IncomingMessage
}

/** Drive one request through the captured createServer handler. */
async function request(opts: Parameters<typeof mkReq>[0] = {}): Promise<FakeRes> {
  const res = mkRes()
  await handler(mkReq(opts), res as unknown as http.ServerResponse)
  return res
}

// Captured before any vi.useFakeTimers() call so flush() can yield a REAL
// macrotask: the two dynamic import()s inside startWebServer are resolved by
// vitest's module runner, which needs more than a microtask drain even though
// both modules are mock factories.
const realSetTimeout = globalThis.setTimeout

async function flush(rounds = 4): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await new Promise<void>((resolve) => { realSetTimeout(resolve, 0) })
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  exitCalls.length = 0
  killCalls.length = 0
  killImpl = () => {}
  H.workerImportFails.value = false
  H.livenessImportFails.value = false
  delete process.env['WEB_ONLY']
  delete process.env['MARVEEN_AGENT_BACKEND']

  server = new FakeServer()
  H.createServer.mockImplementation((h: ReqHandler) => {
    handler = h
    return server
  })

  // Defaults: nothing is blocked, everything authenticates as the dashboard
  // token, every route declines, every loop hands back a distinct handle.
  H.loadOrCreateDashboardToken.mockReturnValue('TOK')
  H.isBlockedCrossOriginWrite.mockReturnValue(false)
  H.originMatchesServedHost.mockReturnValue(false)
  H.resolveAuth.mockReturnValue({ kind: 'token' })
  H.requiresAuth.mockReturnValue(false)
  H.isFederationWireEndpoint.mockReturnValue(false)
  H.listAgentNames.mockReturnValue([])
  H.shouldRegisterHooks.mockReturnValue({ register: false, reason: 'test' })
  H.pruneStaleHooksFromSettingsFile.mockReturnValue([])
  H.ensureAgentHooks.mockReturnValue(false)
  H.ensureAgentStalenessHook.mockReturnValue(false)
  H.ensureEgressGate.mockReturnValue(false)
  H.ensureGovernanceGateCommands.mockReturnValue(false)
  H.sweepExpiredSessions.mockReturnValue(0)
  H.sweepExpiredDeviceKeys.mockReturnValue(0)
  H.sweepOrphanTaskStates.mockReturnValue(0)
  H.refreshMarveenBotUsername.mockResolvedValue(undefined)
  H.collectTokenUsage.mockResolvedValue(undefined)
  H.startWorkerLivenessMonitor.mockReturnValue({ id: 'liveness' })
  for (const [, fn] of routes) fn.mockResolvedValue(false)
  for (const [name, fn] of loops) fn.mockReturnValue({ id: name })

  vi.spyOn(process.stderr, 'write').mockReturnValue(true)
  Object.defineProperty(process, 'exit', {
    configurable: true,
    writable: true,
    value: (code?: number | string | null) => { exitCalls.push(code); return undefined },
  })
  Object.defineProperty(process, 'kill', {
    configurable: true,
    writable: true,
    value: (pid: number, signal?: unknown) => { killCalls.push({ pid, signal }); killImpl(pid, signal); return true },
  })
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  Object.defineProperty(process, 'exit', { configurable: true, writable: true, value: origExit })
  Object.defineProperty(process, 'kill', { configurable: true, writable: true, value: origKill })
})

// ----------------------------------------------------------------------------
// Boot wiring
// ----------------------------------------------------------------------------

describe('startWebServer boot', () => {
  it('creates the agents dir, loads the token, listens on WEB_HOST and prints the bootstrap URL', async () => {
    const srv = await boot(4000)

    expect(H.mkdirSync).toHaveBeenCalledWith('/opt/marveen/agents', { recursive: true })
    expect(H.loadOrCreateDashboardToken).toHaveBeenCalledOnce()
    expect(srv.listenCalls).toEqual([{ port: 4000, host: '127.0.0.1' }])
    expect(process.stderr.write).toHaveBeenCalledWith(
      expect.stringContaining('http://127.0.0.1:4000/?token=TOK'),
    )
  })

  it('defaults the port to 3420', async () => {
    const startWebServer = await loadWeb()
    startWebServer()
    expect(server.listenCalls).toEqual([{ port: 3420, host: '127.0.0.1' }])
  })

  it('starts every background loop and seeds the one-shot boot work', async () => {
    await boot()
    await flush()

    for (const name of LOOP_EXPORTS) expect(loop(name), name).toHaveBeenCalled()
    expect(H.refreshMarveenBotUsername).toHaveBeenCalled()
    expect(H.ensureFederationClaudeMdSection).toHaveBeenCalled()
    expect(H.ensureAutonomySection).toHaveBeenCalledWith('marveen')
    expect(H.ensureDefaultScheduledTasks).toHaveBeenCalled()
    expect(H.sweepOrphanedBackgroundTasks).toHaveBeenCalled()
    expect(H.sweepOrphanTaskStates).toHaveBeenCalled()
    expect(H.collectTokenUsage).toHaveBeenCalled()
    expect(H.startWorkerSession).toHaveBeenCalled()
    expect(H.startWorkerLivenessMonitor).toHaveBeenCalled()
  })

  it('logs the reauth healer only when it returned a handle', async () => {
    loop('startReauthHealer').mockReturnValue(undefined)
    await boot()
    expect(H.logger.info).not.toHaveBeenCalledWith(expect.stringContaining('Reauth healer'))
  })
})

// ----------------------------------------------------------------------------
// WEB_ONLY
// ----------------------------------------------------------------------------

describe('WEB_ONLY mode', () => {
  it('skips every background service but still sweeps auth sessions', async () => {
    process.env['WEB_ONLY'] = 'true'
    await boot()
    await flush()

    expect(H.logger.info).toHaveBeenCalledWith('[staging] WEB_ONLY mode: background services disabled')
    for (const name of LOOP_EXPORTS) {
      if (name === 'startApprovalTimeoutSweeper') continue
      expect(loop(name), name).not.toHaveBeenCalled()
    }
    expect(loop('startApprovalTimeoutSweeper')).toHaveBeenCalled()
    expect(H.startWorkerSession).not.toHaveBeenCalled()
    expect(H.startWorkerLivenessMonitor).not.toHaveBeenCalled()
    expect(H.collectTokenUsage).not.toHaveBeenCalled()
    expect(H.ensureFederationClaudeMdSection).not.toHaveBeenCalled()
  })

  it('close() tolerates the undefined interval handles WEB_ONLY leaves behind', async () => {
    process.env['WEB_ONLY'] = 'true'
    const srv = await boot()
    const cb = vi.fn()
    srv.close(cb)
    expect(srv.closeCalls).toEqual([cb])
  })
})

// ----------------------------------------------------------------------------
// Agent worker warm-up + liveness monitor (dynamic imports)
// ----------------------------------------------------------------------------

describe('worker warm-up', () => {
  it('is skipped on the sdk backend', async () => {
    process.env['MARVEEN_AGENT_BACKEND'] = 'SDK'
    await boot()
    await flush()
    expect(H.startWorkerSession).not.toHaveBeenCalled()
    expect(H.startWorkerLivenessMonitor).not.toHaveBeenCalled()
  })

  it('warns when the agent-worker import fails', async () => {
    H.workerImportFails.value = true
    await boot()
    await flush()
    expect(H.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to pre-start agent worker (will lazy-start on first use)',
    )
  })

  it('warns when the worker-liveness import fails', async () => {
    H.livenessImportFails.value = true
    await boot()
    await flush()
    expect(H.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to start the worker liveness monitor',
    )
  })

  it('does not start either worker when close() ran before the imports resolved', async () => {
    const srv = await boot()
    srv.close()
    await flush()
    expect(H.startWorkerLivenessMonitor).not.toHaveBeenCalled()
    expect(H.startWorkerSession).not.toHaveBeenCalled()
  })

  it('clears the startup watchdog on close() (no spurious exit)', async () => {
    const srv = await boot()
    await flush()
    srv.close()
    srv.listening = false

    vi.advanceTimersByTime(7 * 60 * 1000 + 60 * 1000)

    expect(exitCalls).toEqual([])
  })

  it('clears the liveness interval when close() runs after the import resolved', async () => {
    const srv = await boot()
    await flush()
    expect(H.startWorkerLivenessMonitor).toHaveBeenCalled()
    srv.close()
    expect(srv.closeCalls).toHaveLength(1)
  })
})

// ----------------------------------------------------------------------------
// One-shot boot work: failures are logged, never thrown
// ----------------------------------------------------------------------------

describe('boot-time failure handling', () => {
  it('warns when the inbound prober throws', async () => {
    loop('startInboundProber').mockImplementation(() => { throw new Error('probe boom') })
    await boot()
    expect(H.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Inbound prober failed to start',
    )
  })

  it('warns when the scheduled-task seed throws', async () => {
    H.ensureDefaultScheduledTasks.mockImplementation(() => { throw new Error('seed boom') })
    await boot()
    expect(H.logger.warn).toHaveBeenCalledWith(expect.anything(), 'Scheduled tasks seed skipped')
  })

  it('warns when the background-task sweep throws', async () => {
    H.sweepOrphanedBackgroundTasks.mockImplementation(() => { throw new Error('sweep boom') })
    await boot()
    expect(H.logger.warn).toHaveBeenCalledWith(expect.anything(), 'Background task sweep skipped')
  })

  it('warns when the task-state orphan sweep throws', async () => {
    H.sweepOrphanTaskStates.mockImplementation(() => { throw new Error('orphan boom') })
    await boot()
    expect(H.logger.warn).toHaveBeenCalledWith(expect.anything(), 'Task-state orphan sweep skipped')
  })

  it('logs the swept count when orphan task states were removed', async () => {
    H.sweepOrphanTaskStates.mockReturnValue(3)
    await boot()
    expect(H.logger.info).toHaveBeenCalledWith({ swept: 3 }, 'Orphan agent task-state records swept')
  })

  it('warns when the startup token collection rejects', async () => {
    H.collectTokenUsage.mockRejectedValue(new Error('collect boom'))
    await boot()
    await flush()
    expect(H.logger.warn).toHaveBeenCalledWith(expect.anything(), 'Startup token usage collection failed')
  })

  it('swallows a failing Marveen bot-username warm-up', async () => {
    H.refreshMarveenBotUsername.mockRejectedValue(new Error('telegram down'))
    await boot()
    await flush()
    // The warm-up is best-effort: no log, no throw, and boot completes.
    expect(H.ensureDefaultScheduledTasks).toHaveBeenCalled()
  })
})

// ----------------------------------------------------------------------------
// Hook backfill
// ----------------------------------------------------------------------------

describe('hook backfill', () => {
  it('is skipped when the guard refuses', async () => {
    H.shouldRegisterHooks.mockReturnValue({ register: false, reason: 'worktree' })
    await boot()
    expect(H.logger.info).toHaveBeenCalledWith(
      { reason: 'worktree', projectRoot: '/opt/marveen' },
      'Hook registration skipped',
    )
    expect(H.ensureAgentHooks).not.toHaveBeenCalled()
  })

  it('patches the main agent plus every listed agent and logs each patched set', async () => {
    H.shouldRegisterHooks.mockReturnValue({ register: true })
    H.listAgentNames.mockReturnValue(['boni'])
    H.pruneStaleHooksFromSettingsFile.mockReturnValue(['stale-hook'])
    H.ensureAgentHooks.mockReturnValue(true)
    H.ensureAgentStalenessHook.mockReturnValue(true)
    H.ensureEgressGate.mockReturnValue(true)
    H.ensureGovernanceGateCommands.mockReturnValue(true)

    await boot()

    expect(H.shouldRegisterHooks).toHaveBeenCalledWith({
      projectRoot: '/opt/marveen',
      webOnly: false,
      tmpDir: '/tmp',
    })
    expect(H.agentSettingsPath).toHaveBeenCalledWith('marveen')
    expect(H.agentSettingsPath).toHaveBeenCalledWith('boni')
    expect(H.ensureQuarantineReader).toHaveBeenCalledTimes(2)
    expect(H.logger.info).toHaveBeenCalledWith(
      { pruned: ['stale-hook', 'stale-hook'] },
      'Stale hook entries pruned from agent settings.json',
    )
    expect(H.logger.info).toHaveBeenCalledWith(
      { patched: ['marveen', 'boni'] },
      'PreCompact hook backfilled into agent settings.json',
    )
    expect(H.logger.info).toHaveBeenCalledWith(
      { patched: ['marveen', 'boni'] },
      'staleness-guard UserPromptSubmit hook backfilled into agent settings.json',
    )
    expect(H.logger.info).toHaveBeenCalledWith(
      { patched: ['marveen', 'boni'] },
      'egress-gate WebFetch hook backfilled into agent settings.json',
    )
    expect(H.logger.info).toHaveBeenCalledWith(
      { patched: ['marveen', 'boni'] },
      'governance gate hook commands upgraded to absolute node path in agent settings.json',
    )
  })

  it('logs nothing when no agent needed patching', async () => {
    H.shouldRegisterHooks.mockReturnValue({ register: true })
    await boot()
    expect(H.logger.info).not.toHaveBeenCalledWith(
      expect.anything(),
      'PreCompact hook backfilled into agent settings.json',
    )
  })

  it('warns when a scaffold call throws', async () => {
    H.shouldRegisterHooks.mockReturnValue({ register: true })
    H.ensureAgentHooks.mockImplementation(() => { throw new Error('hook boom') })
    await boot()
    expect(H.logger.warn).toHaveBeenCalledWith(expect.anything(), 'Agent hook backfill skipped')
  })
})

// ----------------------------------------------------------------------------
// Periodic sweeps
// ----------------------------------------------------------------------------

describe('periodic sweeps', () => {
  it('logs swept sessions and device keys on the hourly tick', async () => {
    H.sweepExpiredSessions.mockReturnValue(2)
    H.sweepExpiredDeviceKeys.mockReturnValue(5)
    await boot()

    vi.advanceTimersByTime(60 * 60 * 1000)

    expect(H.logger.info).toHaveBeenCalledWith({ swept: 2 }, 'Expired auth sessions swept')
    expect(H.logger.info).toHaveBeenCalledWith({ swept: 5 }, 'Expired device keys swept')
  })

  it('stays quiet when nothing expired', async () => {
    await boot()
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(H.logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Expired auth sessions swept')
    expect(H.logger.info).not.toHaveBeenCalledWith(expect.anything(), 'Expired device keys swept')
  })

  it('warns when the session sweep throws', async () => {
    H.sweepExpiredSessions.mockImplementation(() => { throw new Error('sweep boom') })
    await boot()
    vi.advanceTimersByTime(60 * 60 * 1000)
    expect(H.logger.warn).toHaveBeenCalledWith(expect.anything(), 'Auth session sweep failed')
  })

  it('warns when the hourly token collection rejects', async () => {
    await boot()
    H.collectTokenUsage.mockRejectedValue(new Error('periodic boom'))
    vi.advanceTimersByTime(60 * 60 * 1000)
    await flush()
    expect(H.logger.warn).toHaveBeenCalledWith(expect.anything(), 'Periodic token usage collection failed')
  })
})

// ----------------------------------------------------------------------------
// Listener self-heal watchdog
// ----------------------------------------------------------------------------

describe('listener self-heal', () => {
  it('exits(1) once the grace elapsed and the server is not listening', async () => {
    const srv = await boot()
    srv.listening = false

    vi.advanceTimersByTime(7 * 60 * 1000)
    expect(exitCalls).toHaveLength(0)

    vi.advanceTimersByTime(60 * 1000)
    expect(exitCalls).toEqual([1])
    expect(H.logger.error).toHaveBeenCalledWith(
      { port: 3420 },
      'Web server not listening -- exiting(1) for a clean launchd restart',
    )
  })

  it('stays quiet while the server is listening', async () => {
    await boot()
    vi.advanceTimersByTime(7 * 60 * 1000 + 5 * 60 * 1000)
    expect(exitCalls).toHaveLength(0)
  })
})

// ----------------------------------------------------------------------------
// close() teardown
// ----------------------------------------------------------------------------

describe('close()', () => {
  it('clears every interval and delegates to the original close', async () => {
    const srv = await boot()
    await flush()
    const cb = vi.fn()

    srv.close(cb)

    expect(srv.closeCalls).toEqual([cb])
  })

  it('works without a callback', async () => {
    const srv = await boot()
    await flush()
    srv.close()
    expect(srv.closeCalls).toEqual([undefined])
  })
})

// ----------------------------------------------------------------------------
// EADDRINUSE port reclaim
// ----------------------------------------------------------------------------

/** Wire execFileSync so `ps -o comm=` / `ps -o uid=` answer per pid. */
function psAnswers(map: Record<number, { comm?: string | Error; uid?: string | Error }>): void {
  H.execFileSync.mockImplementation((_bin: string, args: string[]) => {
    const pid = Number(args[1])
    const field = args[3]
    const entry = map[pid] ?? {}
    const value = field === 'comm=' ? entry.comm : entry.uid
    if (value instanceof Error) throw value
    return value ?? ''
  })
}

describe('EADDRINUSE reclaim', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'getuid', { configurable: true, writable: true, value: () => 501 })
  })

  function emitInUse(srv: FakeServer): void {
    const err: NodeJS.ErrnoException = new Error('listen EADDRINUSE')
    err.code = 'EADDRINUSE'
    srv.emit('error', err)
  }

  it('SIGTERMs our own node listener, SIGKILLs the survivor and re-listens', async () => {
    const srv = await boot(4100)
    H.execSync.mockReturnValue(` 111 \n${process.pid}\nnope\n0\n`)
    psAnswers({ 111: { comm: 'node', uid: '501' } })

    emitInUse(srv)

    expect(killCalls).toEqual([{ pid: 111, signal: 'SIGTERM' }])

    // Still alive at the 1500ms check -> escalate to SIGKILL, then re-bind.
    vi.advanceTimersByTime(1500)

    expect(killCalls).toEqual([
      { pid: 111, signal: 'SIGTERM' },
      { pid: 111, signal: 0 },
      { pid: 111, signal: 'SIGKILL' },
    ])
    expect(srv.listenCalls).toEqual([
      { port: 4100, host: '127.0.0.1' },
      { port: 4100, host: '127.0.0.1' },
    ])
    expect(H.logger.info).toHaveBeenCalledWith({ port: 4100 }, 'Web dashboard: re-listen bound after port reclaim')
  })

  it('skips the SIGKILL when the victim is already gone', async () => {
    const srv = await boot()
    H.execSync.mockReturnValue('111\n')
    psAnswers({ 111: { comm: 'node', uid: '501' } })
    killImpl = (_pid, signal) => { if (signal === 0) throw new Error('ESRCH') }

    emitInUse(srv)
    vi.advanceTimersByTime(1500)

    expect(killCalls.filter(c => c.signal === 'SIGKILL')).toHaveLength(0)
    expect(srv.listenCalls).toHaveLength(2)
  })

  it('survives a SIGTERM and a SIGKILL that both throw', async () => {
    const srv = await boot()
    H.execSync.mockReturnValue('111\n')
    psAnswers({ 111: { comm: 'node', uid: '501' } })
    killImpl = (_pid, signal) => { if (signal !== 0) throw new Error('ESRCH') }

    emitInUse(srv)
    vi.advanceTimersByTime(1500)

    expect(killCalls.map(c => c.signal)).toEqual(['SIGTERM', 0, 'SIGKILL'])
    expect(srv.listenCalls).toHaveLength(2)
  })

  it('refuses to kill a non-node process holding the port', async () => {
    const srv = await boot(4200)
    H.execSync.mockReturnValue('222\n')
    psAnswers({ 222: { comm: 'nginx', uid: '501' } })

    emitInUse(srv)

    expect(H.logger.warn).toHaveBeenCalledWith(
      { port: 4200, pid: 222, cmd: 'nginx' },
      'Port held by non-node process -- refusing to kill',
    )
    expect(exitCalls).toEqual([1])
  })

  it('skips a pid whose `ps -o comm=` lookup fails', async () => {
    const srv = await boot()
    H.execSync.mockReturnValue('333\n')
    psAnswers({ 333: { comm: new Error('no such process') } })

    emitInUse(srv)

    expect(killCalls).toHaveLength(0)
    expect(exitCalls).toEqual([1])
  })

  it('skips a pid owned by another user and one whose uid lookup fails', async () => {
    const srv = await boot()
    H.execSync.mockReturnValue('444\n555\n')
    psAnswers({
      444: { comm: 'node', uid: '999' },
      555: { comm: 'node', uid: new Error('gone') },
    })

    emitInUse(srv)

    expect(killCalls).toHaveLength(0)
    expect(exitCalls).toEqual([1])
  })

  it('treats an unparseable owner uid as ours and still kills the node listener', async () => {
    const srv = await boot()
    H.execSync.mockReturnValue('666\n')
    psAnswers({ 666: { comm: 'tsx', uid: 'not-a-number' } })

    emitInUse(srv)

    expect(killCalls).toEqual([{ pid: 666, signal: 'SIGTERM' }])
  })

  it('skips the uid check entirely when process.getuid is unavailable', async () => {
    const srv = await boot()
    Object.defineProperty(process, 'getuid', { configurable: true, writable: true, value: undefined })
    H.execSync.mockReturnValue('777\n')
    psAnswers({ 777: { comm: 'node' } })

    emitInUse(srv)

    expect(killCalls).toEqual([{ pid: 777, signal: 'SIGTERM' }])
    expect(H.execFileSync).toHaveBeenCalledTimes(1)
  })

  it('exits(1) when the port holder list is empty', async () => {
    const srv = await boot(4300)
    H.execSync.mockReturnValue('')

    emitInUse(srv)

    expect(H.logger.error).toHaveBeenCalledWith(
      { port: 4300 },
      'Port foglalt de nem talaltunk felszabadithato node processt -- kilepes',
    )
    expect(exitCalls).toEqual([1])
  })

  it('logs and exits(1) when the reclaim itself throws', async () => {
    const srv = await boot()
    H.execSync.mockImplementation(() => { throw new Error('lsof boom') })

    emitInUse(srv)

    expect(H.logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Port-reclaim failed -- kilepes',
    )
    expect(exitCalls).toEqual([1])
  })

  it('logs any other listener error without reclaiming', async () => {
    const srv = await boot()
    const err: NodeJS.ErrnoException = new Error('EACCES')
    err.code = 'EACCES'

    srv.emit('error', err)

    expect(H.execSync).not.toHaveBeenCalled()
    expect(H.logger.error).toHaveBeenCalledWith({ err }, 'Web szerver hiba')
  })
})

// ----------------------------------------------------------------------------
// Request handling: CORS + CSRF
// ----------------------------------------------------------------------------

describe('CORS', () => {
  it('emits CORS headers for an allowlisted origin', async () => {
    await boot(4400)
    const res = await request({ url: '/x', headers: { origin: 'http://localhost:4400' } })

    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:4400')
    expect(res.headers['Vary']).toBe('Origin')
    expect(res.headers['Access-Control-Allow-Headers']).toBe('Content-Type, Authorization')
  })

  it('emits CORS headers for a proxy host that matches the served host', async () => {
    await boot()
    H.originMatchesServedHost.mockReturnValue(true)
    const res = await request({ url: '/x', headers: { origin: 'https://box.ts.net', host: 'box.ts.net', 'x-forwarded-host': 'box.ts.net' } })

    expect(H.originMatchesServedHost).toHaveBeenCalledWith('https://box.ts.net', 'box.ts.net', 'box.ts.net')
    expect(res.headers['Access-Control-Allow-Origin']).toBe('https://box.ts.net')
  })

  it('emits no CORS headers for a foreign origin, nor when Origin is absent', async () => {
    await boot()
    const foreign = await request({ url: '/x', headers: { origin: 'https://evil.test' } })
    expect(foreign.headers['Access-Control-Allow-Origin']).toBeUndefined()

    const none = await request({ url: '/x' })
    expect(none.headers['Access-Control-Allow-Origin']).toBeUndefined()
  })

  it('answers OPTIONS preflights with 204 and stops', async () => {
    await boot()
    const res = await request({ url: '/api/x', method: 'OPTIONS' })

    expect(res.head).toEqual([[204, undefined]])
    expect(res.ended).toBe(true)
    expect(H.isBlockedCrossOriginWrite).not.toHaveBeenCalled()
  })

  it('allowlists the LAN host, the public URL and the extra origins from config', async () => {
    await boot(4500, {
      WEB_HOST: '192.168.1.9',
      DASHBOARD_PUBLIC_URL: 'https://dash.example.com/',
      DASHBOARD_ALLOWED_ORIGINS: ' https://a.example.com/ , , https://b.example.com ',
    })

    for (const origin of ['http://192.168.1.9:4500', 'https://dash.example.com', 'https://a.example.com', 'https://b.example.com']) {
      const res = await request({ url: '/x', headers: { origin } })
      expect(res.headers['Access-Control-Allow-Origin'], origin).toBe(origin)
    }
  })

  it('does not add a WEB_HOST entry when the host is localhost', async () => {
    await boot(4600, { WEB_HOST: 'localhost' })
    const res = await request({ url: '/x', headers: { origin: 'http://localhost:4600' } })
    expect(res.headers['Access-Control-Allow-Origin']).toBe('http://localhost:4600')
  })
})

describe('CSRF gate', () => {
  it('rejects a cross-origin write with 403', async () => {
    await boot()
    H.isBlockedCrossOriginWrite.mockReturnValue(true)

    const res = await request({ url: '/api/agents', method: 'POST', headers: { origin: 'https://evil.test', host: 'localhost:3420' } })

    expect(res.head).toEqual([[403, { 'Content-Type': 'application/json' }]])
    expect(res.body).toEqual([JSON.stringify({ error: 'Origin not allowed' })])
    expect(H.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ method: 'POST', path: '/api/agents', origin: 'https://evil.test' }),
      'CSRF: blocked write from foreign origin',
    )
    expect(H.resolveAuth).not.toHaveBeenCalled()
  })
})

// ----------------------------------------------------------------------------
// Request handling: auth gate
// ----------------------------------------------------------------------------

describe('auth gate', () => {
  it('401s a gated path with no principal', async () => {
    await boot()
    H.requiresAuth.mockReturnValue(true)
    H.resolveAuth.mockReturnValue({ kind: 'none' })

    const res = await request({ url: '/api/agents' })

    expect(res.head).toEqual([[401, { 'Content-Type': 'application/json' }]])
    expect(res.body).toEqual([JSON.stringify({ error: 'Unauthorized' })])
    expect(H.logger.warn).not.toHaveBeenCalledWith(expect.anything(), 'federation: rejected wire-endpoint auth')
  })

  it('logs the rejection when the gated path is a federation wire endpoint', async () => {
    await boot()
    H.requiresAuth.mockReturnValue(true)
    H.resolveAuth.mockReturnValue({ kind: 'none' })
    H.isFederationWireEndpoint.mockReturnValue(true)

    await request({ url: '/api/federation/wire', method: 'POST' })

    expect(H.logger.warn).toHaveBeenCalledWith(
      { path: '/api/federation/wire', method: 'POST' },
      'federation: rejected wire-endpoint auth',
    )
  })

  it.each([
    [{ kind: 'token' }, { kind: 'token' }, null],
    [{ kind: 'device', device: 'iphone' }, { kind: 'device', device: 'iphone' }, null],
    [{ kind: 'session', user: 'eggp' }, { kind: 'session', user: 'eggp' }, null],
    [{ kind: 'federation', peer: 'peer-1' }, { kind: 'federation', peer: 'peer-1' }, 'peer-1'],
    [{ kind: 'none' }, undefined, null],
  ])('maps the %o principal onto the route context', async (resolved, expectedAuth, expectedPeer) => {
    await boot()
    H.resolveAuth.mockReturnValue(resolved)
    route('tryHandleAuth').mockResolvedValue(true)

    await request({ url: '/api/whatever' })

    expect(route('tryHandleAuth')).toHaveBeenCalledWith(
      expect.objectContaining({ auth: expectedAuth, fedPeer: expectedPeer }),
    )
  })

  it('passes the request, url, path and method through to the handlers', async () => {
    await boot(4700)
    route('tryHandleAuth').mockResolvedValue(true)

    await request({ url: '/api/x?y=1', method: 'PUT' })

    const ctx = route('tryHandleAuth').mock.calls[0]?.[0] as { path: string; method: string; url: URL }
    expect(ctx.path).toBe('/api/x')
    expect(ctx.method).toBe('PUT')
    expect(ctx.url.searchParams.get('y')).toBe('1')
    expect(H.resolveAuth).toHaveBeenCalledWith(expect.anything(), expect.any(URL), '/api/x', 'PUT', 'TOK')
  })

  it('falls back to "/" and GET when the request carries neither', async () => {
    await boot()
    route('tryHandleAuth').mockResolvedValue(true)

    await request({})

    expect(H.resolveAuth).toHaveBeenCalledWith(expect.anything(), expect.any(URL), '/', 'GET', 'TOK')
  })
})

// ----------------------------------------------------------------------------
// Request handling: dispatch
// ----------------------------------------------------------------------------

describe('route dispatch', () => {
  it('answers /api/network-info before any route runs', async () => {
    await boot(4800)

    await request({ url: '/api/network-info' })

    expect(H.json).toHaveBeenCalledWith(expect.anything(), { lan_ip: '10.0.0.5', port: 4800 })
    expect(route('tryHandleAuth')).not.toHaveBeenCalled()
  })

  it('still dispatches /api/network-info on a non-GET method', async () => {
    await boot()
    await request({ url: '/api/network-info', method: 'POST' })
    expect(H.json).not.toHaveBeenCalled()
    expect(route('tryHandleAuth')).toHaveBeenCalled()
  })

  it('404s when every handler declines', async () => {
    await boot()

    const res = await request({ url: '/nope' })

    for (const name of ROUTE_ORDER) expect(route(name), name).toHaveBeenCalledOnce()
    expect(res.head).toEqual([[404, undefined]])
    expect(res.body).toEqual(['Not found'])
  })

  it.each(ROUTE_ORDER.map((name, i) => [name, i]))(
    '%s short-circuits the chain when it handles the request',
    async (name, index) => {
      await boot()
      route(name).mockResolvedValue(true)

      const res = await request({ url: '/x' })

      expect(route(name)).toHaveBeenCalledOnce()
      for (const later of ROUTE_ORDER.slice(index + 1)) {
        expect(route(later), `${later} must not run after ${name}`).not.toHaveBeenCalled()
      }
      expect(res.head).toHaveLength(0)
    },
  )

  it('passes WEB_DIR to the three handlers that need it', async () => {
    await boot()
    route('tryHandleStatic').mockResolvedValue(true)

    await request({ url: '/index.html' })

    for (const name of ['tryHandleAgents', 'tryHandleMarveen', 'tryHandleStatic']) {
      expect(route(name), name).toHaveBeenCalledWith(expect.anything(), '/opt/marveen/web')
    }
  })

  it('turns a handler throw into a logged 500', async () => {
    await boot()
    const boom = new Error('route boom')
    route('tryHandleKanban').mockRejectedValue(boom)

    await request({ url: '/api/kanban' })

    expect(H.logger.error).toHaveBeenCalledWith({ err: boom }, 'Web szerver hiba')
    expect(H.json).toHaveBeenCalledWith(expect.anything(), { error: 'Szerver hiba' }, 500)
  })
})
