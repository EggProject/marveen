// 100% coverage for the live reauth-healer watchdog loop.
//
// The two existing suites (reauth-healer.test.ts and reauth-quiet-hours.test.ts)
// cover the pure decision function (decideReauthAction) and the quiet-hours
// routing helpers (isQuietHour, localHour, routeEscalation, flushQuietSummary,
// buildEscalationMessage, buildQuietSummaryMessage) -- all of those modules
// are pure and exercised directly. What is NOT covered is everything that
// runs only on the live tick:
//
//   * startReauthHealer() -- the disabled-by-RESPAWN_ENABLED branch and the
//     active branch that schedules the initial sweep + the recurring interval
//   * sweep() inside startReauthHealer -- the main agent first, then each
//     listed sub-agent, skipping the ones isAgentRunning() says are down,
//     then flushQuietSummary() at the end
//   * checkSession() -- the per-session decision wiring: capturePane null /
//     clean / first-run-gate / dead-token, the side-effect routing
//     (sendKeys, restartAgent, escalate, restartMain), the inner dynamic
//     import of ./channel-monitor.js, the cross-path respawn-grace check
//   * sendNotify() -- the fire-and-forget /bin/bash notify.sh invocation
//   * sendBestEffortLogin() -- the scripted /login keystroke sequence
//   * restartFirstRunGatedAgent() -- the kill-session + 1s sleep + restart
//
// The dynamic import of ./channel-monitor.js (line 323) -- a real production
// dep imported late to avoid a circular reference -- means this suite has to
// mock ../web/channel-monitor.js even though the source uses the relative
// './channel-monitor.js' specifier. Vitest's mock registry is keyed by the
// resolved module id, so the two specs hit the same entry.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

const MAIN_ID = 'marveen'
const MAIN_SESSION = 'marveen-channels'

// Mirror the source constants so the assertions can read as production.
const INITIAL_DELAY_MS = 90_000
const PROBE_INTERVAL_MS = 3 * 60 * 1000

const T0 = 1_700_000_000_000

// Build a fresh vi.fn whose return value tracks mocks.quarantineResult.
// Returning a vi.fn (not a bare async arrow) lets a test override it with
// mockRejectedValueOnce for the "quarantine throws" branch.
const quarantineFn = vi.fn<() => Promise<'no-token' | 'healthy' | 'quarantined' | 'inconclusive'>>()
quarantineFn.mockImplementation(async () => 'no-token')

const mocks = vi.hoisted(() => ({
  // logger
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  debug: vi.fn(),
  // config
  respawnEnabled: true,
  // platform
  resolveFromPathReturn: '/usr/bin/tmux',
  // agent-config
  listAgentNames: vi.fn<() => string[]>(),
  // agent-process
  isAgentRunning: vi.fn<(name: string) => boolean>(),
  capturePane: vi.fn<(session: string) => string | null>(),
  startAgentProcess: vi.fn<(name: string) => { ok: boolean; error?: string }>(),
  // claude-credentials-guard
  quarantineResult: 'no-token' as 'no-token' | 'healthy' | 'quarantined' | 'inconclusive',
  // channel-monitor (dynamically imported from checkSession)
  hardRestartResult: { ok: true } as { ok: boolean; error?: string },
  lastMainRespawn: 0,
  // child_process execFile (used to track tmux/bash calls for assertions)
  execFileCalls: [] as Array<{ cmd: string; args: string[]; err: unknown }>,
}))

// Re-bind quarantineFn's return value to mocks.quarantineResult on every
// call so tests can flip the result by mutating mocks.quarantineResult and
// then resetting the mock implementation.
quarantineFn.mockImplementation(async () => mocks.quarantineResult)

// capture every execFile call. The callback is invoked synchronously with
// no error so the in-flight Promises (sendBestEffortLogin's per-step wait,
// restartFirstRunGatedAgent's kill-session wait) settle on the next microtask
// instead of leaking across tests.
vi.mock('node:child_process', () => ({
  execFile(cmd: string, args: string[], _opts: unknown, cb?: (err: unknown) => void) {
    const err = null
    mocks.execFileCalls.push({ cmd, args, err })
    if (typeof cb === 'function') cb(err)
    return {} as never
  },
}))

// Logger: info/warn/error/debug are asserted on directly.
vi.mock('../logger.js', () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
    error: mocks.error,
    debug: mocks.debug,
  },
}))

// Config: getters so RESPAWN_ENABLED flips between tests without re-mocking
// the whole module. PROJECT_ROOT is read at module-eval time (NOTIFY_SCRIPT
// is joined from it) and held constant here for that reason.
vi.mock('../config.js', () => ({
  get MAIN_AGENT_ID() { return MAIN_ID },
  get PROJECT_ROOT() { return '/sandbox' },
  get RESPAWN_ENABLED() { return mocks.respawnEnabled },
  get APP_TZ() { return 'Europe/London' },
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: () => mocks.resolveFromPathReturn,
  makeLazyBinResolver: () => () => mocks.resolveFromPathReturn,
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: mocks.listAgentNames,
}))

vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: mocks.isAgentRunning,
  capturePane: mocks.capturePane,
  startAgentProcess: mocks.startAgentProcess,
}))

vi.mock('../web/claude-credentials-guard.js', () => ({
  quarantineFleetTokenIfDead: quarantineFn,
}))

vi.mock('../web/channel-mcp-reconnect.js', () => ({
  resolveAgentSession: (name: string) => name,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: MAIN_SESSION,
}))

// Dynamically imported by checkSession when a main-agent dead-token restart
// fires; vitest's mock registry keys by resolved id, so the relative spec
// the source uses still hits this mock. The mock factory reads from
// mocks.hardRestartResult and mocks.lastMainRespawn on every call (no
// closure capture), so a test can swap mocks.hardRestartResult to a function
// that throws and drive the .then() callback to throw -> .catch() branch.
vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => {
    if (typeof mocks.hardRestartResult === 'function') return (mocks.hardRestartResult as () => { ok: boolean })()
    return mocks.hardRestartResult
  },
  lastMainRespawnAt: () => mocks.lastMainRespawn,
}))

// reauth-detect and tmux-keys are PURE and intentionally NOT mocked --
// calling the real functions is closer to production, and reauth-detect's
// rules are the contract we are exercising end-to-end.

const DEAD_PANE = 'Some output\nPlease run /login\nMore output'
const FIRST_RUN_PANE = 'Claude Code\n\nSelect login method\n\n❯'

let sandbox: string
let savedPlatform: PropertyDescriptor | undefined
let savedDisplay: string | undefined
let savedWayland: string | undefined

/** Fresh module registry -> fresh module-scope watchState / quietSuppressed
 *  maps in the reauth-healer module. */
async function loadModule(): Promise<typeof import('../web/reauth-healer.js')> {
  vi.resetModules()
  return import('../web/reauth-healer.js')
}

/** Advance to the first sweep (t = INITIAL_DELAY_MS). */
async function firstSweep(): Promise<void> {
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
}

/** Advance to the next PROBE_INTERVAL_MS boundary. */
async function nextSweep(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
}

/** All execFile calls whose command path is `/bin/bash` (notify.sh). */
function notifyCalls(): Array<{ cmd: string; args: string[]; err: unknown }> {
  return mocks.execFileCalls.filter((c) => c.cmd === '/bin/bash')
}

/** All execFile calls whose command path is the mocked tmux binary. */
function tmuxCalls(): Array<{ cmd: string; args: string[]; err: unknown }> {
  return mocks.execFileCalls.filter((c) => c.cmd === mocks.resolveFromPathReturn)
}

/** Force the platform to linux-server and clear display vars for the duration
 *  of one test, so hostCanInteractiveLogin() returns false. */
function pinHeadless(): void {
  savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  savedDisplay = process.env['DISPLAY']
  savedWayland = process.env['WAYLAND_DISPLAY']
  delete process.env['DISPLAY']
  delete process.env['WAYLAND_DISPLAY']
}
function unpinHeadless(): void {
  if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform)
  if (savedDisplay === undefined) delete process.env['DISPLAY']
  else process.env['DISPLAY'] = savedDisplay
  if (savedWayland === undefined) delete process.env['WAYLAND_DISPLAY']
  else process.env['WAYLAND_DISPLAY'] = savedWayland
}

/** The mirror of pinHeadless: a host where hostCanInteractiveLogin() returns
 *  true, so the best-effort /login send-keys actually fires.
 *
 *  hostCanInteractiveLogin() is `process.platform === 'darwin' || DISPLAY ||
 *  WAYLAND_DISPLAY`. Tests that assert send-keys happened used to inherit the
 *  host's answer: true on a macOS dev box, FALSE on a headless Linux CI runner,
 *  where the gate silently skipped the whole sequence and the assertions saw
 *  zero tmux calls. Pinning linux+DISPLAY exercises the same branch on every
 *  host, and deliberately picks linux rather than darwin so the non-darwin half
 *  of the gate is the one under test. */
function pinInteractive(): void {
  savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  savedDisplay = process.env['DISPLAY']
  savedWayland = process.env['WAYLAND_DISPLAY']
  process.env['DISPLAY'] = ':0'
  delete process.env['WAYLAND_DISPLAY']
}

beforeEach(() => {
  sandbox = mkTempDir('marveen-reauth-healer-routes-')
  vi.clearAllMocks()
  quarantineFn.mockClear()
  quarantineFn.mockImplementation(async () => mocks.quarantineResult)
  mocks.respawnEnabled = true
  mocks.resolveFromPathReturn = '/usr/bin/tmux'
  mocks.listAgentNames.mockReturnValue([])
  mocks.isAgentRunning.mockReturnValue(true)
  mocks.capturePane.mockReturnValue('clean pane with no auth markers')
  mocks.startAgentProcess.mockReturnValue({ ok: true })
  mocks.quarantineResult = 'no-token'
  mocks.hardRestartResult = { ok: true }
  mocks.lastMainRespawn = 0
  mocks.execFileCalls.length = 0
  vi.useFakeTimers({ now: T0 })
})

afterEach(() => {
  if (savedPlatform) unpinHeadless()
  savedPlatform = undefined
  savedDisplay = undefined
  savedWayland = undefined
  vi.useRealTimers()
  rmTempDir(sandbox)
})

describe('startReauthHealer: production gate', () => {
  it('returns null and logs once when RESPAWN_ENABLED is false (no interval is armed)', async () => {
    mocks.respawnEnabled = false
    const mod = await loadModule()
    const handle = mod.startReauthHealer()
    expect(handle).toBeNull()
    expect(mocks.info).toHaveBeenCalledTimes(1)
    expect(mocks.info.mock.calls[0]![0]).toBe('reauth-healer disabled (respawn is production-only)')
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS * 5)
    expect(mocks.listAgentNames).not.toHaveBeenCalled()
    expect(mocks.capturePane).not.toHaveBeenCalled()
  })

  it('returns the interval handle, runs the first sweep after INITIAL_DELAY_MS, then repeats every PROBE_INTERVAL_MS', async () => {
    const mod = await loadModule()
    const handle = mod.startReauthHealer()
    expect(handle).toBeDefined()
    expect(mocks.capturePane).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS - 1)
    expect(mocks.capturePane).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.capturePane).toHaveBeenCalledTimes(1)
    expect(mocks.capturePane).toHaveBeenCalledWith(MAIN_SESSION)
    mocks.capturePane.mockClear()
    await nextSweep()
    expect(mocks.capturePane).toHaveBeenCalledTimes(1)
    clearInterval(handle as NodeJS.Timeout)
    mocks.capturePane.mockClear()
    await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS * 5)
    expect(mocks.capturePane).not.toHaveBeenCalled()
  })
})

describe('sweep: per-agent iteration', () => {
  it('checks the main agent exactly once and skips sub-agents when listAgentNames is empty', async () => {
    mocks.listAgentNames.mockReturnValue([])
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    expect(mocks.capturePane).toHaveBeenCalledTimes(1)
    expect(mocks.capturePane).toHaveBeenCalledWith(MAIN_SESSION)
  })

  it('iterates sub-agents in list order and skips ones isAgentRunning reports down', async () => {
    mocks.listAgentNames.mockReturnValue(['scout', 'broken', 'data'])
    mocks.isAgentRunning.mockImplementation((name: string) => name !== 'broken')
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    expect(mocks.capturePane.mock.calls.map((c) => c[0])).toEqual([MAIN_SESSION, 'scout', 'data'])
  })

  it('logs and swallows a main-agent check failure', async () => {
    mocks.capturePane.mockImplementation((session: string) => {
      if (session === MAIN_SESSION) throw new Error('main capture-pane blew up')
      return 'clean'
    })
    mocks.listAgentNames.mockReturnValue(['scout'])
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    expect(mocks.debug).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'main capture-pane blew up' }) },
      'reauth-healer: main agent check error',
    )
    expect(mocks.capturePane).toHaveBeenCalledWith('scout')
  })

  it('logs and swallows a sub-agent check failure without skipping the rest', async () => {
    mocks.listAgentNames.mockReturnValue(['broken', 'scout'])
    mocks.capturePane.mockImplementation((session: string) => {
      if (session === 'broken') throw new Error('sub-agent capture-pane blew up')
      return 'clean'
    })
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    expect(mocks.debug).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'sub-agent capture-pane blew up' }), agent: 'broken' },
      'reauth-healer: agent check error',
    )
    expect(mocks.capturePane).toHaveBeenCalledWith('scout')
  })
})

describe('checkSession: sendKeys branch (sub-agent, dead token, canInteractiveLogin)', () => {
  it('runs the scripted /login keystroke sequence against the tmux session', async () => {
    pinInteractive()
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    // The third sweep hits the dead-token threshold (3 consecutive).
    const send = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
    expect(send.length).toBeGreaterThanOrEqual(3)
    expect(send[0]!.args).toContain('-l')
    expect(send.some((c) => c.args.includes('Enter'))).toBe(true)
    expect(mocks.warn).toHaveBeenCalledWith(
      { label: 'scout', session: 'scout' },
      'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys',
    )
  })

  it('handles a zero-delay loginSequence step without sleeping (the step.delayMs <= 0 branch)', async () => {
    pinInteractive()
    // Mock tmux-keys so loginSequence returns one step with delayMs=0; this
    // hits the `if (step.delayMs > 0)` false branch inside sendBestEffortLogin.
    const tmuxKeys = await import('../web/tmux-keys.js')
    vi.spyOn(tmuxKeys, 'loginSequence').mockReturnValue([
      { kind: 'literal', text: '/login', delayMs: 0 },
    ])
    vi.spyOn(tmuxKeys, 'literalKeyArgs').mockReturnValue(['send-keys', '-t', 'scout', '-l', '--', '/login'])
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    // At least one send-keys call (the literal step); no sleep() because delayMs=0.
    const send = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
    expect(send.length).toBeGreaterThanOrEqual(1)
    expect(mocks.warn).toHaveBeenCalledWith(
      { label: 'scout', session: 'scout' },
      'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys',
    )
  })

  it('skips tmux send-keys entirely when canInteractiveLogin is false (headless cascade guard)', async () => {
    pinHeadless()
    try {
      mocks.listAgentNames.mockReturnValue(['scout'])
      mocks.capturePane.mockReturnValue(DEAD_PANE)
      const mod = await loadModule()
      mod.startReauthHealer()
      await firstSweep()
      await nextSweep()
      await nextSweep()
      // On the third sweep the threshold is hit; headless -> sendKeys=false
      // but escalate=true. Escalation is logged via logger.error (warn is
      // reserved for the suppressed-quiet and fleet-quarantine paths).
      expect(mocks.error).toHaveBeenCalledWith(
        { label: 'scout', session: 'scout', reason: expect.stringMatching(/login/i), quiet: false },
        'reauth-healer: dead OAuth token on live session -- escalating to owner',
      )
      expect(mocks.warn).not.toHaveBeenCalledWith(
        expect.anything(),
        'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys',
      )
      // No send-keys calls at all (sendKeys path suppressed).
      const tmuxSendKeys = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
      expect(tmuxSendKeys).toHaveLength(0)
    } finally {
      unpinHeadless()
    }
  })
})

describe('checkSession: first-run-gate restartAgent branch (sub-agent)', () => {
  it('kills the session and restarts the sub-agent (kill-session + startAgentProcess)', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(FIRST_RUN_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    const tmuxKill = tmuxCalls().filter((c) => c.args[0] === 'kill-session')
    expect(tmuxKill.map((c) => [c.cmd, c.args])).toEqual([['/usr/bin/tmux', ['kill-session', '-t', 'scout']]])
    expect(mocks.startAgentProcess).toHaveBeenCalledWith('scout')
    expect(mocks.warn).toHaveBeenCalledWith(
      { label: 'scout', session: 'scout', reason: expect.stringMatching(/Select login method/i) },
      'reauth-healer: first-run gate on live sub-agent -- restarting it (re-seeds hasCompletedOnboarding)',
    )
  })

  it('warns when startAgentProcess reports a failure', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(FIRST_RUN_PANE)
    mocks.startAgentProcess.mockReturnValue({ ok: false, error: 'tmux has-session failed' })
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(mocks.warn).toHaveBeenCalledWith(
      { name: 'scout', error: 'tmux has-session failed' },
      'reauth-healer: first-run-gate relaunch failed',
    )
  })

  it('warns when startAgentProcess throws', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(FIRST_RUN_PANE)
    mocks.startAgentProcess.mockImplementation(() => { throw new Error('boom') })
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(mocks.warn).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'boom' }), name: 'scout' },
      'reauth-healer: first-run-gate relaunch threw',
    )
  })
})

describe('checkSession: escalate branch (main agent, dead token, not first-run gate)', () => {
  it('calls /bin/bash notify.sh with the buildEscalationMessage text', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    const notify = notifyCalls()
    expect(notify).toHaveLength(1)
    expect(notify[0]!.args[0]).toMatch(/\/notify\.sh$/)
    expect(notify[0]!.args[1]).toContain(MAIN_ID)
    expect(notify[0]!.args[1]).toContain('Please run /login')
  })

  it('logs the fleet-token liveness result when it is quarantined', async () => {
    mocks.quarantineResult = 'quarantined'
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(mocks.warn).toHaveBeenCalledWith(
      { label: MAIN_ID, result: 'quarantined' },
      'reauth-healer: fleet-token liveness check',
    )
  })

  it('invokes hardRestartMarveenChannels after the quarantine resolves', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    mocks.hardRestartResult = { ok: true }
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    // Drain microtasks so the .then() chain reaches hardRestartMarveenChannels.
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(mocks.warn).toHaveBeenCalledWith(
      { ok: true },
      'reauth-healer: main dead-token restart triggered',
    )
  })

  it('skips the main restart when lastMainRespawnAt is within the cross-path grace window', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    // Within 15min of "now": grace suppresses the restart.
    mocks.lastMainRespawn = T0 + INITIAL_DELAY_MS - 60_000
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(mocks.info).toHaveBeenCalledWith('reauth-healer: main dead-token restart skipped -- within cross-path respawn grace')
    expect(mocks.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'reauth-healer: main dead-token restart triggered',
    )
  })

  it('logs a debug when quarantineFleetTokenIfDead throws', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    quarantineFn.mockRejectedValueOnce(new Error('live probe crashed'))
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    expect(mocks.debug).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'live probe crashed' }) },
      'reauth-healer: fleet-token liveness check failed',
    )
  })

  it('logs a debug when the dynamic channel-monitor import rejects', async () => {
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    mocks.lastMainRespawn = -1
    mocks.hardRestartResult = (() => { throw new Error('hardRestart boom') }) as unknown as { ok: boolean }
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    for (let i = 0; i < 20; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) await Promise.resolve()
    expect(mocks.debug).toHaveBeenCalledWith(
      { err: expect.objectContaining({ message: 'hardRestart boom' }) },
      'reauth-healer: main dead-token restart import failed',
    )
    expect(mocks.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'reauth-healer: main dead-token restart triggered',
    )
    mocks.hardRestartResult = { ok: true }
  })

  it('logs a warn when notify.sh reports an error (errored execFile callback)', async () => {
    const cp = await import('node:child_process')
    const realExecFile = cp.execFile
    ;(cp as unknown as { execFile: unknown }).execFile = ((
      cmd: string,
      args: string[],
      _opts: unknown,
      cb?: (err: unknown) => void,
    ) => {
      mocks.execFileCalls.push({ cmd, args, err: cmd === '/bin/bash' ? new Error('notify.sh exit 1') : null })
      if (typeof cb === 'function') cb(cmd === '/bin/bash' ? new Error('notify.sh exit 1') : null)
      return {} as never
    }) as unknown
    try {
      mocks.listAgentNames.mockReturnValue([])
      mocks.capturePane.mockReturnValue(DEAD_PANE)
      const mod = await loadModule()
      mod.startReauthHealer()
      await firstSweep()
      await nextSweep()
      await nextSweep()
      await vi.advanceTimersByTimeAsync(0)
      await Promise.resolve()
      expect(mocks.warn).toHaveBeenCalledWith(
        { err: expect.objectContaining({ message: 'notify.sh exit 1' }) },
        'reauth-healer: notify.sh escalation failed',
      )
    } finally {
      ;(cp as unknown as { execFile: typeof cp.execFile }).execFile = realExecFile
    }
  })
})

describe('checkSession: spell reset / quiet suppression', () => {
  it('a clean pane between dead spells ends the escalation spell', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValueOnce(DEAD_PANE)
      .mockReturnValueOnce(DEAD_PANE)
      .mockReturnValueOnce(DEAD_PANE)
      .mockReturnValue('clean pane')
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(notifyCalls()).toHaveLength(1)
    await nextSweep()
    // Spell is reset: no new notify on the next sweep.
    expect(notifyCalls()).toHaveLength(1)
    expect(mocks.capturePane).toHaveBeenCalledTimes(4)
  })

  it('routes the first night-time escalation into the quiet buffer, not to notify.sh', async () => {
    // 23:30 UTC on Jan 10 2026 = 23:30 London (winter, no DST).
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(notifyCalls()).toHaveLength(0)
    expect(mocks.warn).toHaveBeenCalledWith(
      { label: MAIN_ID, session: MAIN_SESSION, reason: expect.stringMatching(/login/i) },
      'reauth-healer: dead token escalation suppressed (quiet hours), queued for morning summary',
    )
  })

  it('flushes the morning summary at the first non-quiet sweep after a night escalation', async () => {
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep() // t = QUIET_T0 + 90s, still inside the quiet window
    await nextSweep()
    await nextSweep() // third sweep: dead-token reached threshold, suppressed
    expect(notifyCalls()).toHaveLength(0)
    // Advance WELL past 06:00 -- the next sweep is well into daytime.
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    // Some interval boundary in the morning will fire flushQuietSummary:
    // the second-or-later notify is the morning summary.
    const after = notifyCalls()
    const summary = after.find((c) => c.args[1].includes('Reggeli token-összegzés'))
    expect(summary).toBeDefined()
  })

  it('drops a healed agent from the morning summary, and emits nothing if all are healed', async () => {
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep() // dead-token reached threshold, suppressed
    expect(notifyCalls()).toHaveLength(0)
    // Heal between night and morning: consecutiveDead -> 0, watchState cleared.
    mocks.capturePane.mockReturnValue('clean pane')
    // Advance past 06:00 -- the next non-quiet sweep calls flushQuietSummary,
    // which finds stillDeadCount=0 (watchState cleared) and returns without
    // notifying (the "all healed" path).
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    // No morning summary was sent.
    const summary = notifyCalls().find((c) => c.args[1].includes('Reggeli token-összegzés'))
    expect(summary).toBeUndefined()
  })

  it('exercises the flushQuietSummary + stampAlert + entry-shaped callbacks from sweep end-to-end', async () => {
    // Drive the watchState-stamp branch directly: routeEscalation adds an
    // entry, then a non-quiet sweep triggers flushQuietSummary which calls
    // both the stillDeadCount and the stampAlert callback for an agent that
    // IS still dead (so stampAlert's `if (st)` true branch is covered).
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep() // dead-token threshold, suppressed into quiet buffer
    expect(notifyCalls()).toHaveLength(0)
    // Advance past 06:00. Each interval boundary past 06:00 fires a sweep
    // whose flushQuietSummary walks the buffer; the first such sweep calls
    // the stillDeadCount callback (line 391) and the stampAlert callback
    // (lines 393-395) -- both with watchState populated, so the `if (st)`
    // branch fires.
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    const summary = notifyCalls().find((c) => c.args[1].includes('Reggeli token-összegzés'))
    expect(summary).toBeDefined()
  })
})

describe('checkSession: capturePane null ends the spell', () => {
  it('treats a missing pane as not-applicable and resets the spell', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValueOnce(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    mocks.capturePane.mockReturnValue(null)
    await nextSweep()
    await nextSweep()
    expect(notifyCalls()).toHaveLength(0)
    expect(mocks.capturePane).toHaveBeenCalledTimes(3)
  })
})

describe('checkSession: main-agent first-run gate is escalate-only, no restart', () => {
  it('main agent with the picker: escalate but never restartMain and never restartAgent', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(FIRST_RUN_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(notifyCalls()).toHaveLength(1)
    expect(mocks.warn).not.toHaveBeenCalledWith(
      expect.anything(),
      'reauth-healer: main dead-token restart triggered',
    )
    const killMain = tmuxCalls().filter(
      (c) => c.args[0] === 'kill-session' && c.args.includes('-t') && c.args[c.args.length - 1] === MAIN_SESSION,
    )
    expect(killMain).toHaveLength(0)
  })
})