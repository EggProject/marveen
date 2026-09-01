// 100% coverage test for src/web/auto-restart-runner.ts.
//
// The runner is a 60-second loop that consults each agent's auto-restart config
// (`store/auto-restart.json`) and triggers either a tmux/launchd restart of the
// main channels session, or a `restartAgentProcess(...)` of a sub-agent, when
// the per-agent schedule comes due. Two safety rules dominate the test matrix:
//
//   IDLE-GUARD       never restart a busy pane (defer to the next tick).
//   SEED-ON-FIRST-SIGHT on first sight we record `lastRestart = now` without
//                    acting, so a daily slot that already passed before boot
//                    does not trigger a spurious restart.
//
// Sandbox: every dependency is mocked at the module level (child_process,
// node:fs, the store/agent-config/agent-process/auto-restart-store/...
// collaborators), so no filesystem state needs to be redirected into a tmpdir.
// vitest isolates module registries per test file, and `vi.resetModules()`
// before each dynamic import gives the SUT a fresh `lastRestart` Map, which is
// module-scope state. vi.useFakeTimers + vi.setSystemTime drive the 60s sweep
// loop deterministically.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger } from '../logger.js'

// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Merged into the existing '../config.js' mock factory below.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})


// ---------------------------------------------------------------------------
// Hoisted mock fns. The vi.mock() factories below reference these; vi.hoisted
// keeps the declarations available in the hoisted factory scope.
// ---------------------------------------------------------------------------
const {
  mockExecFileSync,
  mockExistsSync,
  mockListAgentNames,
  mockReadAgentRemoteHost,
  mockAgentRunState,
  mockAgentSessionName,
  mockRestartAgentProcess,
  mockCapturePane,
  mockRespawnMainSessionFresh,
  mockPaneLooksIdle,
  mockReadAutoRestartConfig,
} = vi.hoisted(() => ({
  mockExecFileSync: vi.fn(),
  mockExistsSync: vi.fn(),
  mockListAgentNames: vi.fn<() => string[]>(),
  mockReadAgentRemoteHost: vi.fn<(name: string) => string | null>(),
  mockAgentRunState: vi.fn<(name: string) => string>(),
  mockAgentSessionName: vi.fn<(name: string) => string>(),
  mockRestartAgentProcess: vi.fn(),
  mockCapturePane: vi.fn<(session: string, host: string | null) => string | null>(),
  mockRespawnMainSessionFresh: vi.fn(),
  mockPaneLooksIdle: vi.fn<(pane: string) => boolean>(),
  mockReadAutoRestartConfig: vi.fn<(name: string) => unknown>(),
}))

// ---------------------------------------------------------------------------
// Mock factories. Hoisted by vitest above the SUT import.
// ---------------------------------------------------------------------------
vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  ...configSandbox,
  MAIN_AGENT_ID: 'marveen',
  SERVICE_ID: 'marveen',
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => mockListAgentNames(),
  readAgentRemoteHost: (name: string) => mockReadAgentRemoteHost(name),
}))

vi.mock('../web/agent-process.js', () => ({
  agentRunState: (name: string) => mockAgentRunState(name),
  agentSessionName: (name: string) => mockAgentSessionName(name),
  restartAgentProcess: (name: string, opts?: { fresh?: boolean }) =>
    mockRestartAgentProcess(name, opts),
  capturePane: (session: string, host: string | null) => mockCapturePane(session, host),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/channel-monitor.js', () => ({
  respawnMainSessionFresh: () => mockRespawnMainSessionFresh(),
}))

vi.mock('../pane-state.js', () => ({
  paneLooksIdle: (pane: string) => mockPaneLooksIdle(pane),
}))

vi.mock('../web/auto-restart-store.js', () => ({
  readAutoRestartConfig: (name: string) => mockReadAutoRestartConfig(name),
}))

// ---------------------------------------------------------------------------
// Fresh-module helper. Each test calls loadSUT() to reset the SUT's module
// cache, which re-creates the module-scope `lastRestart` Map empty.
// ---------------------------------------------------------------------------
async function loadSUT(): Promise<typeof import('../web/auto-restart-runner.js')> {
  vi.resetModules()
  return await import('../web/auto-restart-runner.js')
}

// ---------------------------------------------------------------------------
// Per-test timer / mock reset.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  // Anchor at noon LOCAL. The SUT computes daily slots off `setHours(0,0,0,0)`
  // -- local midnight -- so all test times must be set in local terms, not
  // UTC strings, or the offset between the fake clock and dailyDueAt lands
  // the assertion in the wrong place. The local-time constructor `new Date(y,
  // m, d, h, m, s)` works on every host's wall clock.
  vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0))
  // Default mocks that most tests need; individual tests override as needed.
  mockListAgentNames.mockReturnValue([])
  mockAgentSessionName.mockImplementation((name) => `agent-${name}`)
  mockReadAgentRemoteHost.mockReturnValue(null)
  mockAgentRunState.mockReturnValue('running')
  mockCapturePane.mockReturnValue('idle pane')
  mockPaneLooksIdle.mockReturnValue(true)
  mockExistsSync.mockReturnValue(true)
})

afterEach(() => {
  vi.useRealTimers()
})

// ===========================================================================
// startAutoRestartRunner -- the exported entry point.
// ===========================================================================
describe('startAutoRestartRunner', () => {
  it('returns a NodeJS.Timeout handle (the setInterval id)', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: false, dailyTime: null, intervalHours: null, mode: 'continue', handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    expect(timer).toBeDefined()
    expect(typeof timer).toBe('object')
    clearInterval(timer)
  })

  it('checks the main agent + every name returned by listAgentNames on every sweep', async () => {
    mockListAgentNames.mockReturnValue(['samu', 'iris', 'zara'])
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: false, dailyTime: null, intervalHours: null, mode: 'continue', handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000) // initial setTimeout fires

    expect(mockReadAutoRestartConfig).toHaveBeenCalledTimes(4)
    expect(mockReadAutoRestartConfig).toHaveBeenCalledWith('marveen')
    expect(mockReadAutoRestartConfig).toHaveBeenCalledWith('samu')
    expect(mockReadAutoRestartConfig).toHaveBeenCalledWith('iris')
    expect(mockReadAutoRestartConfig).toHaveBeenCalledWith('zara')
    clearInterval(timer)
  })

  it('logs a debug message when checkAgent throws for the main agent', async () => {
    mockReadAutoRestartConfig.mockImplementation(() => {
      throw new Error('store read failed')
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'auto-restart: main check error',
    )
    clearInterval(timer)
  })

  it('logs a debug message when checkAgent throws for a sub-agent', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadAutoRestartConfig.mockImplementation((name: string) => {
      if (name === 'samu') throw new Error('store read failed')
      return {
        enabled: false, dailyTime: null, intervalHours: null, mode: 'continue', handoff: false,
      }
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)

    expect(logger.debug).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything(), agent: 'samu' }),
      'auto-restart: agent check error',
    )
    clearInterval(timer)
  })
})

// ===========================================================================
// First-sight seed. The "no restart on the first sweep" branch.
// ===========================================================================
describe('first-sight seed', () => {
  it('records lastRestart=nowMs and returns without acting on first sight', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: '03:00',
      intervalHours: null,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('also seeds without restarting on first sight for intervalHours configs', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
    clearInterval(timer)
  })
})

// ===========================================================================
// schedule -> due -> restart. Covers computeDueAt + performRestart happy path.
// ===========================================================================
describe('intervalHours restart', () => {
  // The runner sweeps main + every listAgentNames() entry on every tick. To
  // assert on sub-agent-only behaviour we keep main disabled (the disabled
  // branch is covered separately), so the only enabled agent in each sweep
  // is the one under test.
  const mainDisabled = {
    enabled: false, dailyTime: null, intervalHours: null, mode: 'continue', handoff: false,
  }
  function withMainDisabledAnd(subCfg: Record<string, unknown>): void {
    mockReadAutoRestartConfig.mockImplementation((name) =>
      name === 'marveen' ? mainDisabled : subCfg,
    )
  }

  it('restarts a sub-agent after the interval elapses (fresh mode)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    withMainDisabledAnd({
      enabled: true, dailyTime: null, intervalHours: 1, mode: 'fresh', handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)                       // seed
    vi.advanceTimersByTime(3_600_000 + 60_000)           // past the 1h interval

    expect(mockRestartAgentProcess).toHaveBeenCalledTimes(1)
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('samu', { fresh: true })
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'samu', mode: 'fresh' },
      'auto-restart: restarted session',
    )
    clearInterval(timer)
  })

  it('passes fresh: false to restartAgentProcess when cfg.mode is continue', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    withMainDisabledAnd({
      enabled: true, dailyTime: null, intervalHours: 1, mode: 'continue', handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockRestartAgentProcess).toHaveBeenCalledWith('samu', { fresh: false })
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'samu', mode: 'continue' },
      'auto-restart: restarted session',
    )
    clearInterval(timer)
  })

  it('logs the fresh mode in the success line when cfg.mode is fresh', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    withMainDisabledAnd({
      enabled: true, dailyTime: null, intervalHours: 1, mode: 'fresh', handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(logger.info).toHaveBeenCalledWith(
      { name: 'samu', mode: 'fresh' },
      'auto-restart: restarted session',
    )
    clearInterval(timer)
  })

  it('does NOT restart before the interval elapses (dueAt not reached)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 24,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(60_000) // far short of 24h

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('updates lastRestart after a successful restart (no double-fire on the next tick)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)                       // seed
    vi.advanceTimersByTime(3_600_000 + 60_000)           // restart
    vi.advanceTimersByTime(60_000)                       // next interval: NOT due yet

    expect(mockRestartAgentProcess).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })
})

// ===========================================================================
// sessionFor -- picks MAIN_CHANNELS_SESSION for main, agent-<name> otherwise.
// ===========================================================================
describe('sessionFor', () => {
  it('uses MAIN_CHANNELS_SESSION for the main agent and passes host=null', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockCapturePane).toHaveBeenCalledWith('marveen-channels', null)
    clearInterval(timer)
  })

  it('uses agent-<name> for sub-agents and forwards readAgentRemoteHost', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadAgentRemoteHost.mockReturnValue('laptop.local')
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockCapturePane).toHaveBeenCalledWith('agent-samu', 'laptop.local')
    clearInterval(timer)
  })
})

// ===========================================================================
// paneIsIdle -- the IDLE-GUARD. Three branches: capture-pane null, pane not
// idle, pane idle.
// ===========================================================================
describe('paneIsIdle / IDLE-GUARD', () => {
  it('treats a null capture as busy (defer)', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockCapturePane.mockReturnValue(null)

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'marveen', session: 'marveen-channels' },
      'auto-restart: due but pane is busy, deferring to next tick',
    )
    clearInterval(timer)
  })

  it('defers when paneLooksIdle returns false', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockCapturePane.mockReturnValue('busy pane content')
    mockPaneLooksIdle.mockReturnValue(false)

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(logger.info).toHaveBeenCalledWith(
      { name: 'marveen', session: 'marveen-channels' },
      'auto-restart: due but pane is busy, deferring to next tick',
    )
    clearInterval(timer)
  })

  it('restarts when paneLooksIdle returns true', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    // Main restart routes through restartMainChannelsSession(), so the
    // tmux/launchd leg runs -- restartAgentProcess is NEVER called for main.
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })
})

// ===========================================================================
// computeDueAt -- dailyTime invalid, neither dailyTime nor intervalHours, and
// dailyTime valid (verified via the restart-at-slot test).
// ===========================================================================
describe('computeDueAt', () => {
  it('returns null when dailyTime is invalid (parseHHMM rejects the value)', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: '99:99',
      intervalHours: null,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(60_000 * 10)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('returns null when neither dailyTime nor intervalHours is set', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: null,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(60_000 * 10)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('restarts at the configured daily slot via local midnight + HH:MM', async () => {
    // Boot at 12:00, daily slot at 12:01. Sweep 1 (setTimeout, +40s) seeds
    // lastRestart=12:00:40; sweep 2 (setInterval, +60s) fires at 12:01:00
    // with dailyDueAt=12:01:00 and lastRestart=12:00:40, so restartDue
    // returns true and the launchd leg fires. The natural timing here --
    // 40s + 60s -- keeps every setInterval fire inside the window we
    // advance through, no system-time jumps that confuse vitest's scheduler.
    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0))
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: '12:01',
      intervalHours: null,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000) // sweep 1: seed at 12:00:40

    expect(mockExecFileSync).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000) // sweep 2 fires at 12:01:00

    expect(mockExecFileSync).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })
})

// ===========================================================================
// disabled schedule. Covers `if (!cfg.enabled) { delete; return }` and the
// "re-seed cleanly if re-enabled later" comment in the source.
// ===========================================================================
describe('disabled schedule', () => {
  it('does not restart when enabled=false', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: false,
      dailyTime: null,
      intervalHours: null,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(60_000 * 5)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('re-seeds cleanly after a disable -> re-enable cycle', async () => {
    // Boot at 12:00 with dailyTime='12:01'. Sweep 1 (setTimeout, +40s)
    // seeds lastRestart=12:00:40. Sweep 2 (setInterval, +60s) fires at
    // 12:01:00 with cfg.enabled=false -> deletes lastRestart. Sweep 3
    // (setInterval, +60s more) fires at 12:02:00 with cfg.enabled=true.
    // If the delete in sweep 2 worked, sweep 3 sees an empty map and takes
    // the first-sight seed branch (no restart). Without the delete, sweep 3
    // would see lastRestart=12:00:40 and (dailyDueAt=12:01:00, nowMs=
    // 12:02:00) -- restartDue returns true and the launchd leg fires.
    const enabledCfg = {
      enabled: true,
      dailyTime: '12:01',
      intervalHours: null,
      mode: 'continue',
      handoff: false,
    }
    const disabledCfg = {
      enabled: false,
      dailyTime: null,
      intervalHours: null,
      mode: 'continue',
      handoff: false,
    }
    mockReadAutoRestartConfig
      .mockReturnValueOnce(enabledCfg)   // sweep 1: seed
      .mockReturnValueOnce(disabledCfg)  // sweep 2: disabled -> delete
      .mockReturnValue(enabledCfg)       // sweep 3+: enabled again

    vi.setSystemTime(new Date(2026, 0, 15, 12, 0, 0))
    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)                       // sweep 1 at 12:00:40
    vi.advanceTimersByTime(60_000)                       // sweep 2 at 12:01:00

    expect(mockExecFileSync).not.toHaveBeenCalled()

    vi.advanceTimersByTime(60_000)                       // sweep 3 at 12:02:00

    // If the delete worked, sweep 3 took the first-sight seed branch --
    // no launchctl call. Without the delete, sweep 3 would have restarted
    // (dailyDueAt reached and lastRestart < dueAt).
    expect(mockExecFileSync).not.toHaveBeenCalled()
    clearInterval(timer)
  })
})

// ===========================================================================
// Sub-agent tri-state gate. ONLY 'running' is eligible. The comment explicitly
// warns that auto-restart must not resurrect dead agents or risk a duplicate
// session while SSH is flaky.
// ===========================================================================
describe('sub-agent run-state gate', () => {
  it('does not restart a stopped sub-agent', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockAgentRunState.mockReturnValue('stopped')
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(60_000 * 5)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('does not restart an unreachable sub-agent (SSH-independence invariant)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockAgentRunState.mockReturnValue('unreachable')
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(60_000 * 5)

    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('restarts a running sub-agent', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockAgentRunState.mockReturnValue('running')
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockRestartAgentProcess).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })

  it('skips the agentRunState probe for the main agent (always considered present)', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockAgentRunState.mockReturnValue('unreachable')

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)

    expect(mockAgentRunState).not.toHaveBeenCalled()
    clearInterval(timer)
  })
})

// ===========================================================================
// restartMainChannelsSession -- macOS launchd leg vs Linux/other respawn leg.
// ===========================================================================
describe('restartMainChannelsSession', () => {
  it('uses /bin/launchctl kickstart when /bin/launchctl exists (macOS)', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockExistsSync.mockReturnValue(true)

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/bin/launchctl',
      ['kickstart', '-k', expect.stringMatching(/^gui\/\d+\/com\.marveen\.channels$/)],
      { timeout: 10_000 },
    )
    expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('uses respawnMainSessionFresh when /bin/launchctl is absent (Linux)', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockExistsSync.mockReturnValue(false)

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000)

    expect(mockExecFileSync).not.toHaveBeenCalled()
    expect(mockRespawnMainSessionFresh).toHaveBeenCalledTimes(1)
    clearInterval(timer)
  })

  it('passes an empty uid when process.getuid is not a function', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockExistsSync.mockReturnValue(true)

    const originalGetuid = process.getuid
    // The guard is `typeof process.getuid === 'function'`. Removing the
    // property for the duration of the test exercises the fallback branch.
    delete process.getuid

    try {
      const { startAutoRestartRunner } = await loadSUT()
      const timer = startAutoRestartRunner()
      vi.advanceTimersByTime(40_000)
      vi.advanceTimersByTime(3_600_000 + 60_000)

      expect(mockExecFileSync).toHaveBeenCalledWith(
        '/bin/launchctl',
        ['kickstart', '-k', 'gui//com.marveen.channels'],
        { timeout: 10_000 },
      )
      clearInterval(timer)
    } finally {
      ;(process as unknown as { getuid: typeof originalGetuid }).getuid = originalGetuid
    }
  })
})

// ===========================================================================
// performRestart error path -- throws are caught and logged, lastRestart is
// NOT updated, so the runner retries on the next sweep.
// ===========================================================================
describe('performRestart failure', () => {
  it('logs a warning and retries next tick when restartAgentProcess throws', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockRestartAgentProcess.mockImplementation(() => {
      throw new Error('boom')
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)                       // seed
    vi.advanceTimersByTime(3_600_000 + 60_000)           // first due: throws
    vi.advanceTimersByTime(60_000)                       // second tick: still due, throws again

    expect(mockRestartAgentProcess).toHaveBeenCalledTimes(2)
    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.anything(), name: 'samu' },
      'auto-restart: restart failed',
    )
    clearInterval(timer)
  })

  it('does NOT update lastRestart when restartAgentProcess throws (next tick re-fires)', async () => {
    // Two intervals past the seed: if the throw path had been incorrectly
    // stamping lastRestart, the third tick would be a no-op. It fires
    // because lastRestart was NOT updated -- the regression this guards.
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true,
      dailyTime: null,
      intervalHours: 1,
      mode: 'continue',
      handoff: false,
    })
    mockRestartAgentProcess.mockImplementation(() => {
      throw new Error('boom')
    })

    const { startAutoRestartRunner } = await loadSUT()
    const timer = startAutoRestartRunner()
    vi.advanceTimersByTime(40_000)
    vi.advanceTimersByTime(3_600_000 + 60_000) // due -> throw 1
    vi.advanceTimersByTime(60_000)             // due -> throw 2
    vi.advanceTimersByTime(60_000)             // due -> throw 3

    expect(mockRestartAgentProcess).toHaveBeenCalledTimes(3)
    clearInterval(timer)
  })
})

// ===========================================================================
// Unreachable defensive code coverage. Two `??` fallbacks on lines 51 and 131
// are dead under the SUT's own control flow: checkAgent only calls
// computeDueAt after `lastRestart.has(name)` is true, and the SUT only sets
// numbers into lastRestart. So `lastRestart.get(name)` is guaranteed to
// return a number inside both branches -- the `?? nowMs` and `?? null`
// fallbacks cannot fire through the public API. Patching Map.prototype.get
// to return undefined makes both fallbacks runnable; the seed path uses
// `.has`, not `.get`, so the seed itself still lands normally.
// ===========================================================================
describe('unreachable ?? fallback coverage', () => {
  it('forces both ?? fallbacks by patching Map.prototype.get to return undefined', async () => {
    mockReadAutoRestartConfig.mockReturnValue({
      enabled: true, dailyTime: null, intervalHours: 1, mode: 'continue', handoff: false,
    })

    const origGet = Map.prototype.get
    Map.prototype.get = function (this: Map<unknown, unknown>, key: unknown) {
      if (key === 'marveen') return undefined
      return origGet.call(this, key)
    }

    try {
      const { startAutoRestartRunner } = await loadSUT()
      const timer = startAutoRestartRunner()
      vi.advanceTimersByTime(40_000)                       // seed (.has, not .get)
      vi.advanceTimersByTime(3_600_000 + 60_000)           // exercise both ?? fallbacks

      // With `get(name)` returning undefined, line 51 falls back to `nowMs`,
      // so dueAt = nowMs + intervalHours -- strictly in the future, so
      // restartDue returns false and neither restart path runs.
      expect(mockExecFileSync).not.toHaveBeenCalled()
      expect(mockRespawnMainSessionFresh).not.toHaveBeenCalled()
      clearInterval(timer)
    } finally {
      Map.prototype.get = origGet
    }
  })
})
