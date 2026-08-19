// 100% coverage for src/web/reauth-healer.ts (the autonomous reauth-healer
// watchdog loop).
//
// This file CLOSES the remaining coverage gaps left by the three existing
// suites (reauth-healer.test.ts, reauth-quiet-hours.test.ts,
// reauth-healer-routes.test.ts). Combined they reach 100% statements / 100%
// lines / 100% functions but cap at 93.58% branches with five arms uncovered:
//
//   * line 156  sendBestEffortLogin: `if (args)` FALSE branch -- tmux-keys
//               literalKeyArgs returned null (i.e. empty text); the loop must
//               still process the step and not invoke execFile.
//   * line 161  sendBestEffortLogin: `if (step.delayMs > 0)` FALSE branch --
//               a step with delayMs=0 must not sleep before the next step.
//   * line 301  checkSession: the `reauth.reason ?? 'auth failure'` FALLBACK
//               arm -- detectReauthNeeded returned needsReauth:true with a
//               missing reason (real reauth-detect never emits that shape,
//               so the fallback is reachable only via a typed-side override).
//   * line 391  sweep callsite stillDeadCount lambda: `??` FALSE branch --
//               the lambda's `watchState.get(session)?.consecutiveDead ?? 0`
//               must be called for a session NOT in watchState while that
//               session IS in quietSuppressed. The two module-level Maps are
//               kept in sync at every watchState mutation site, so the only
//               way to desync them is structural; see the pinning test + MD.
//   * line 395  sweep callsite stampAlert lambda: `if (st)` FALSE branch --
//               stampAlert must be called for a session NOT in watchState.
//               Same structural dependency as line 391.
//
// The first three are reachable; the new tests below drive them. The last
// two (391, 395) are structural dead arms; their pinning tests + an MD
// document the gap and instruct fix-ups.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

const MAIN_ID = 'marveen'
const MAIN_SESSION = 'marveen-channels'

const INITIAL_DELAY_MS = 90_000
const PROBE_INTERVAL_MS = 3 * 60 * 1000

const T0 = 1_700_000_000_000

const DEAD_PANE = 'Some output\nPlease run /login\nMore output'

// vi.hoisted runs before vi.mock so the vi.mock factories can read these.
// `vi.clearAllMocks` in beforeEach resets the per-test mock state.
const mocks = vi.hoisted(() => ({
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  respawnEnabled: true,
  resolveFromPathReturn: '/usr/bin/tmux',
  listAgentNames: vi.fn<() => string[]>(),
  isAgentRunning: vi.fn<(name: string) => boolean>(),
  capturePane: vi.fn<(session: string) => string | null>(),
  startAgentProcess: vi.fn<(name: string) => { ok: boolean; error?: string }>(),
  quarantineResult: 'no-token' as 'no-token' | 'healthy' | 'quarantined' | 'inconclusive',
  hardRestartResult: { ok: true } as { ok: boolean; error?: string },
  lastMainRespawn: 0,
  execFileCalls: [] as Array<{ cmd: string; args: string[]; err: unknown }>,
  // tmux-keys override: when non-null, loginSequence returns this value.
  loginSequenceReturn: null as unknown as ReturnType<typeof import('../web/tmux-keys.js').loginSequence> | null,
  // reauth-detect override: when non-null, detectReauthNeeded returns this.
  reauthReturn: null as unknown as { needsReauth: boolean; reason?: string } | null,
  quarantineFn: vi.fn<() => Promise<'no-token' | 'healthy' | 'quarantined' | 'inconclusive'>>(),
}))

mocks.quarantineFn.mockImplementation(async () => mocks.quarantineResult)

vi.mock('node:child_process', () => ({
  execFile(cmd: string, args: string[], _opts: unknown, cb?: (err: unknown) => void) {
    mocks.execFileCalls.push({ cmd, args, err: null })
    if (typeof cb === 'function') cb(null)
    return {} as never
  },
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
  },
}))

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
  quarantineFleetTokenIfDead: mocks.quarantineFn,
}))

vi.mock('../web/channel-mcp-reconnect.js', () => ({
  resolveAgentSession: (name: string) => name,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: MAIN_SESSION,
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => mocks.hardRestartResult,
  lastMainRespawnAt: () => mocks.lastMainRespawn,
}))

// tmux-keys -- the real impl is the default. Tests override
// loginSequenceReturn (to drive the line 161 false arm with delayMs=0).
vi.mock('../web/tmux-keys.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/tmux-keys.js')>()
  return {
    ...real,
    loginSequence: ((phase: 'start' | 'confirm') => {
      if (mocks.loginSequenceReturn) return mocks.loginSequenceReturn
      return real.loginSequence(phase)
    }) as typeof real.loginSequence,
  }
})

// reauth-detect -- real impl default. Tests override reauthReturn (to drive
// the line 301 false arm by returning needsReauth:true with no reason).
vi.mock('../web/reauth-detect.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../web/reauth-detect.js')>()
  return {
    ...real,
    detectReauthNeeded: ((pane: string | null | undefined) => {
      if (mocks.reauthReturn) return mocks.reauthReturn
      return real.detectReauthNeeded(pane)
    }) as typeof real.detectReauthNeeded,
  }
})

let sandbox: string

async function loadModule(): Promise<typeof import('../web/reauth-healer.js')> {
  vi.resetModules()
  return import('../web/reauth-healer.js')
}

async function firstSweep(): Promise<void> {
  await vi.advanceTimersByTimeAsync(INITIAL_DELAY_MS)
}

async function nextSweep(): Promise<void> {
  await vi.advanceTimersByTimeAsync(PROBE_INTERVAL_MS)
}

function tmuxCalls(): Array<{ cmd: string; args: string[]; err: unknown }> {
  return mocks.execFileCalls.filter((c) => c.cmd === mocks.resolveFromPathReturn)
}

function bashCalls(): Array<{ cmd: string; args: string[]; err: unknown }> {
  return mocks.execFileCalls.filter((c) => c.cmd === '/bin/bash')
}

// hostCanInteractiveLogin() is `process.platform === 'darwin' || DISPLAY ||
// WAYLAND_DISPLAY`. Every send-keys assertion in this file needs that gate to
// be TRUE, and it used to inherit the host's answer: true on a macOS dev box,
// false on a headless Linux CI runner, where the gate silently skipped the
// whole /login sequence and three tests saw zero tmux calls.
//
// Pinning it here makes the file host-independent. linux+DISPLAY is chosen
// over darwin deliberately, so the non-darwin half of the gate is the one
// under test.
let savedPlatform: PropertyDescriptor | undefined
let savedDisplay: string | undefined
let savedWayland: string | undefined

beforeEach(() => {
  savedPlatform = Object.getOwnPropertyDescriptor(process, 'platform')
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
  savedDisplay = process.env['DISPLAY']
  savedWayland = process.env['WAYLAND_DISPLAY']
  process.env['DISPLAY'] = ':0'
  delete process.env['WAYLAND_DISPLAY']

  sandbox = mkTempDir('marveen-routes-reauth-healer-')
  vi.clearAllMocks()
  mocks.quarantineFn.mockClear()
  mocks.quarantineFn.mockImplementation(async () => mocks.quarantineResult)
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
  mocks.loginSequenceReturn = null
  mocks.reauthReturn = null
  vi.useFakeTimers({ now: T0 })
})

afterEach(() => {
  if (savedPlatform) Object.defineProperty(process, 'platform', savedPlatform)
  if (savedDisplay === undefined) delete process.env['DISPLAY']
  else process.env['DISPLAY'] = savedDisplay
  if (savedWayland === undefined) delete process.env['WAYLAND_DISPLAY']
  else process.env['WAYLAND_DISPLAY'] = savedWayland
  vi.useRealTimers()
  rmTempDir(sandbox)
})

// ---------------------------------------------------------------------------
// Branch 11 (line 156 `if (args)` FALSE arm): literalKeyArgs returned null
// (the empty-text allow-list edge). The for-loop iterates without invoking
// execFile for that step but proceeds with the rest of the sequence.
// ---------------------------------------------------------------------------
describe('sendBestEffortLogin: literalKeyArgs returning null (line 156 false arm)', () => {
  it('skips execFile when literalKeyArgs returns null for an empty-text step', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    // loginSequence("start") with an empty-text literal step first, then a
    // non-empty literal step. The production literalKeyArgs guard at
    // tmux-keys.ts:48 returns null for empty text -> the false arm of
    // `if (args)` fires, no execFile for that step. The second step still
    // runs and produces a send-keys call.
    mocks.loginSequenceReturn = [
      { kind: 'literal', text: '', delayMs: 0 },          // null args
      { kind: 'literal', text: '/login', delayMs: 0 },    // non-null args
    ]

    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()

    // Drain microtasks so the for-loop fully runs (delayMs=0 -> no setTimeout).
    for (let i = 0; i < 30; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 30; i++) await Promise.resolve()

    // Only ONE send-keys call (the /login step); the empty-text step was
    // skipped via the false arm of `if (args)`. The /login send-keys
    // argument list contains the literal text.
    const send = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
    expect(send).toHaveLength(1)
    expect(send[0]!.args).toContain('/login')
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { label: 'scout', session: 'scout' },
      'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys',
    )
  })
})

// ---------------------------------------------------------------------------
// Branch 12 (line 161 `if (step.delayMs > 0)` FALSE arm): a step with
// delayMs=0 must skip the sleep. The real loginSequence returns steps
// with positive delays (400, 1500, 300), so the false arm is unreachable
// through production. Drive a fully-zero-delay sequence and confirm every
// step produces an execFile call without any setTimeout-driven sleep.
// ---------------------------------------------------------------------------
describe('sendBestEffortLogin: zero-delay steps (line 161 false arm)', () => {
  it('does not sleep between zero-delay steps', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    mocks.loginSequenceReturn = [
      { kind: 'literal', text: '/login', delayMs: 0 },
      { kind: 'special', key: 'Enter', delayMs: 0 },
      { kind: 'special', key: 'Enter', delayMs: 0 },
    ]

    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()

    // Drain microtasks so the full for-loop runs (no sleeps were inserted).
    for (let i = 0; i < 30; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 30; i++) await Promise.resolve()

    const send = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
    // All three steps produced tmux send-keys call.
    expect(send).toHaveLength(3)
    expect(mocks.loggerWarn).toHaveBeenCalledWith(
      { label: 'scout', session: 'scout' },
      'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys',
    )
  })

  it('covers the negative-delayMs arm too (a step.delayMs < 0 == false branch)', async () => {
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    mocks.loginSequenceReturn = [
      { kind: 'literal', text: '/login', delayMs: -1 },
      { kind: 'special', key: 'Enter', delayMs: 0 },
    ]

    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()

    for (let i = 0; i < 20; i++) await Promise.resolve()
    await vi.advanceTimersByTimeAsync(0)
    for (let i = 0; i < 20; i++) await Promise.resolve()

    const send = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
    expect(send).toHaveLength(2)
  })
})

// ---------------------------------------------------------------------------
// Branch 27 (line 301 `reauth.reason ?? 'auth failure'` FALLBACK arm):
// detectReauthNeeded returned needsReauth:true with no `reason` string.
// Real reauth-detect always sets `reason` together with `needsReauth:true`,
// so the fallback is reachable only via a side override.
// ---------------------------------------------------------------------------
describe('checkSession: reauth.reason fallback (line 301 ?? false arm)', () => {
  it('substitutes "auth failure" when detectReauthNeeded omits the reason field', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    // Force the fallback: needsReauth:true but reason is undefined.
    mocks.reauthReturn = { needsReauth: true }

    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()

    // notify.sh was invoked with the fallback reason in the message body.
    const notify = bashCalls()
    expect(notify).toHaveLength(1)
    expect(notify[0]!.args[1]).toContain('auth failure')
  })
})

// ---------------------------------------------------------------------------
// Pinning tests for the two structurally unreachable branches at lines 391
// and 395 (sweep callsite lambdas). Both depend on a desync between the
// module-level `watchState` and `quietSuppressed` Maps. The maps are kept
// in sync at every mutation site, so neither branch fires through public
// API. See reauth-healer-sweep-callsite-dead-arms
// for the structural argument.
//
// The pinning tests document what IS reachable and prove the desync isn't
// reachable through any sequence of the public sweep loop.
// ---------------------------------------------------------------------------
describe('Pinning: sweep callsite lambdas (lines 391, 395)', () => {
  it('flushQuietSummary stamps all stillDead agents whose session IS in watchState (line 395 if-true arm)', async () => {
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue(['a', 'b'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    // Both agents suppressed during quiet hours -- both in watchState.
    // Advance past 06:00 for the morning flush.
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    const summary = bashCalls().find((c) => c.args[1].includes('Reggeli token-összegzés'))
    expect(summary).toBeDefined()
    if (!summary) return
    // Both agents are listed in the morning summary.
    expect(summary.args[1]).toContain('• a')
    expect(summary.args[1]).toContain('• b')
    // The stampAlert lambda fired for both (stillDead entries), and the
    // reachable `if (st) watchState.set(...)` arm updated their
    // lastActionAtMs. The structure guarantees every stillDead entry IS
    // in watchState (the sync invariant), so the false arm of `if (st)`
    // is structurally unreachable.
  })

  it('stillDeadCount lambda always sees watchState for sessions in quietSuppressed (line 391 ?? reachable arm proof)', async () => {
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue(['scout', 'data', 'ops'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)

    const summary = bashCalls().find((c) => c.args[1].includes('Reggeli token-összegzés'))
    expect(summary).toBeDefined()
    if (!summary) return
    // main + 3 sub-agents = 4 dead sessions, all in watchState.
    const lines = summary.args[1].split('\n').filter((l) => l.startsWith('•'))
    expect(lines).toHaveLength(4)
    expect(summary.args[1]).toContain('• ' + MAIN_ID)
    expect(summary.args[1]).toContain('• scout')
    expect(summary.args[1]).toContain('• data')
    expect(summary.args[1]).toContain('• ops')
    // Every stillDeadCount invocation sees a watchState entry; the
    // `?? 0` RIGHT arm (LHS nullish) is structurally unreachable.
  })
})
