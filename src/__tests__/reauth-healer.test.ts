// 100% line/branch/function/statement coverage for src/web/reauth-healer.ts.
//
// Three layers in this file:
//   1. Pure decision function (decideReauthAction).
//   2. Quiet-hours helpers (isQuietHour, localHour, buildEscalationMessage,
//      buildQuietSummaryMessage, routeEscalation, flushQuietSummary).
//   3. Live watchdog loop (startReauthHealer, sweep, checkSession,
//      sendBestEffortLogin, restartFirstRunGatedAgent, sendNotify).
//
// Layer 3 pulls in a web of collaborators that touch disk/state:
//   - capturePane / isAgentRunning / startAgentProcess (agent-process)
//   - quarantineFleetTokenIfDead (claude-credentials-guard)
//   - hardRestartMarveenChannels / lastMainRespawnAt (channel-monitor --
//     dynamically imported by checkSession to dodge a cycle)
//   - execFile (node:child_process) for tmux and notify.sh
//
// The PROJECT_ROOT/PROJECT_ROOT-derived constants are read at module-eval time
// (NOTIFY_SCRIPT is joined from PROJECT_ROOT at import), so the only safe path
// is to redirect config.js to a tmpdir-scoped sandbox BEFORE the module loads.
// Same pattern as costops-config.test.ts:14-17 and db-100.test.ts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// Mirror the source constants so the assertions can read as production.
// Hoisted so vi.mock factories (also hoisted) can close over them.
const h = vi.hoisted(() => ({
  MAIN_ID: 'marveen',
  MAIN_SESSION: 'marveen-channels',
  INITIAL_DELAY_MS: 90_000,
  PROBE_INTERVAL_MS: 3 * 60 * 1000,
  ESCALATION_COOLDOWN_MS: 3 * 60 * 60 * 1000,
  DEAD_PROBE_THRESHOLD: 3,
  T0: 1_700_000_000_000,
}))
const MAIN_ID = h.MAIN_ID
const MAIN_SESSION = h.MAIN_SESSION
const INITIAL_DELAY_MS = h.INITIAL_DELAY_MS
const PROBE_INTERVAL_MS = h.PROBE_INTERVAL_MS
const ESCALATION_COOLDOWN_MS = h.ESCALATION_COOLDOWN_MS
const DEAD_PROBE_THRESHOLD = h.DEAD_PROBE_THRESHOLD
const T0 = h.T0

// All hoisted mocks live inside vi.hoisted() so vi.mock factories (also
// hoisted) can close over them safely. quarantineFn is hoisted with the
// rest, and re-bound to mocks.quarantineResult on every call from
// beforeEach().
const mocks = vi.hoisted(() => {
  const quarantineFn = vi.fn<() => Promise<'no-token' | 'healthy' | 'quarantined' | 'inconclusive'>>()
  quarantineFn.mockImplementation(async () => 'no-token')
  return {
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
    quarantineFn,
    // channel-monitor (dynamically imported from checkSession)
    hardRestartResult: { ok: true } as { ok: boolean; error?: string } | (() => { ok: boolean }),
    lastMainRespawn: 0,
    // child_process execFile (used to track tmux/bash calls for assertions)
    execFileCalls: [] as Array<{ cmd: string; args: string[]; err: unknown }>,
    // reauth-detect override -- when set, replaces the real detectReauthNeeded.
    // Used to exercise branches the production detector cannot reach (e.g. the
    // `?? 'auth failure'` fallback at line 301 when needsReauth=true but the
    // reason field is absent).
    reauthDetectOverride: null as null | ((pane: string | null | undefined) => { needsReauth: boolean; reason?: string }),
  }
})

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
// NOTE: vi.mock factories are hoisted to the top of the file. They cannot
// close over top-level `const` declarations (TDZ at hoist time), only over
// values returned from vi.hoisted() -- so MAIN_ID / MAIN_SESSION / T0 are
// referenced through `h` here.
vi.mock('../config.js', () => ({
  get MAIN_AGENT_ID() { return h.MAIN_ID },
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
  MAIN_CHANNELS_SESSION: h.MAIN_SESSION,
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

// reauth-detect: by default the real implementation runs (closer to
// production). Tests that need an unreachable reason field set
// mocks.reauthDetectOverride before loadModule().
vi.mock('../web/reauth-detect.js', async (orig) => {
  const actual = await orig<typeof import('../web/reauth-detect.js')>()
  return {
    ...actual,
    detectReauthNeeded: (pane: string | null | undefined) => {
      if (mocks.reauthDetectOverride) return mocks.reauthDetectOverride(pane)
      return actual.detectReauthNeeded(pane)
    },
  }
})

// tmux-keys is real (its functions are pure). loginSequence / literalKeyArgs /
// specialKeyArgs are exercised against the mocked execFile so we get end-to-end
// assertions on the keystroke sequence without a real tmux binary.

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
  sandbox = mkTempDir('marveen-reauth-healer-')
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
  mocks.reauthDetectOverride = null
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

// ----------------------------------------------------------------------------
// Layer 1: pure decision function
// ----------------------------------------------------------------------------

import { decideReauthAction, NO_REAUTH_STATE, type ReauthHealerState } from '../web/reauth-healer.js'
import { APP_TZ } from '../config.js'

const T = { threshold: DEAD_PROBE_THRESHOLD, cooldownMs: ESCALATION_COOLDOWN_MS }
const base = (over: Partial<Parameters<typeof decideReauthAction>[0]> = {}) => ({
  isDeadToken: true,
  sessionAlive: true,
  isMain: false,
  canInteractiveLogin: true,
  prev: NO_REAUTH_STATE,
  nowMs: 1_000_000,
  ...over,
})

// Autonomous re-auth healer decision (Adam stability-fix #1). Conservative:
// false-positive avoidance is the priority since the action injects /login.
describe('decideReauthAction', () => {
  it('clean token resets the spell, no action', () => {
    const d = decideReauthAction(base({ isDeadToken: false, prev: { consecutiveDead: 2, lastActionAtMs: 5 } }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.escalate).toBe(false)
    expect(d.next).toEqual(NO_REAUTH_STATE)
  })

  it('dead session-gone resets the spell (capture-null treated as not-applicable)', () => {
    const d = decideReauthAction(base({ sessionAlive: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(false)
    expect(d.next.consecutiveDead).toBe(0)
  })

  it('debounces: 1st and 2nd dead probes do not act', () => {
    const p1 = decideReauthAction(base({ prev: NO_REAUTH_STATE }), T)
    expect(p1.escalate).toBe(false)
    expect(p1.next.consecutiveDead).toBe(1)
    const p2 = decideReauthAction(base({ prev: p1.next }), T)
    expect(p2.escalate).toBe(false)
    expect(p2.next.consecutiveDead).toBe(2)
  })

  it('3rd consecutive dead probe escalates + send-keys (sub-agent)', () => {
    const d = decideReauthAction(base({ prev: { consecutiveDead: 2, lastActionAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(true)
    expect(d.next.lastActionAtMs).toBe(2_000_000)
    expect(d.next.consecutiveDead).toBe(3)
  })

  it('main agent at threshold escalates but does NOT send-keys', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false)
  })

  it('headless host at threshold escalates but does NOT send-keys (cascade guard)', () => {
    // A headless Linux fleet host: /login would fail AND rotate the shared OAuth
    // token into a fleet-wide 401 cascade, so escalate-only even for a sub-agent.
    const d = decideReauthAction(base({ canInteractiveLogin: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.escalate).toBe(true)
    expect(d.sendKeys).toBe(false)
  })

  it('cooldown: still-dead within 30min does not re-fire', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 5, lastActionAtMs },
      nowMs: lastActionAtMs + 10 * 60 * 1000, // 10 min later
    }), T)
    expect(d.escalate).toBe(false)
    expect(d.sendKeys).toBe(false)
    expect(d.next.lastActionAtMs).toBe(lastActionAtMs) // unchanged
    expect(d.next.consecutiveDead).toBe(6) // keeps counting
  })

  it('cooldown: re-fires after 30min if still dead (does not forget)', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      prev: { consecutiveDead: 12, lastActionAtMs },
      nowMs: lastActionAtMs + 3 * 60 * 60 * 1000 + 60_000, // 3h + 1min later
    }), T)
    expect(d.escalate).toBe(true)
    expect(d.next.lastActionAtMs).toBe(lastActionAtMs + 3 * 60 * 60 * 1000 + 60_000)
  })

  it('a heal between dead spells lets the next spell alert immediately', () => {
    // dead x3 -> alert
    const a = decideReauthAction(base({ prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(a.escalate).toBe(true)
    // healed -> reset
    const b = decideReauthAction(base({ isDeadToken: false, prev: a.next }), T)
    expect(b.next).toEqual(NO_REAUTH_STATE)
    // dead again x3 from fresh -> alerts again (lastActionAtMs was reset)
    let s: ReauthHealerState = b.next
    let last = { escalate: false } as { escalate: boolean }
    for (let i = 0; i < 3; i++) { const r = decideReauthAction(base({ prev: s, nowMs: 9_000_000 }), T); s = r.next; last = r }
    expect(last.escalate).toBe(true)
  })
})

// 2026-07-16 first-run gate (bootcamp): the "Select login method" picker /
// browser sign-in screen is NOT a dead token. A /login send-keys there is
// actively harmful (Enter accepts a login method -> browser OAuth on a VALID
// credential); the heal is a sub-agent restart, which re-seeds the flag.
describe('decideReauthAction: first-run gate', () => {
  const gated = { consecutiveDead: 2, lastActionAtMs: null } as ReauthHealerState

  it('suppresses /login send-keys and restarts instead (sub-agent, at threshold)', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(true)
    expect(d.escalate).toBe(true)
  })

  it('restart works headless too (canInteractiveLogin false)', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, canInteractiveLogin: false, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(true)
  })

  it('main agent: never restarted, never send-keys -- escalate-only', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, isMain: true, prev: gated }), T)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(false)
    expect(d.restartMain).toBe(false)
    expect(d.escalate).toBe(true)
  })

  it('a genuine 401 (not first-run gate) keeps the legacy behavior: send-keys, no restart', () => {
    const d = decideReauthAction(base({ prev: gated }), T)
    expect(d.sendKeys).toBe(true)
    expect(d.restartAgent).toBe(false)
  })

  it('below threshold: no restart', () => {
    const d = decideReauthAction(base({ isFirstRunGate: true, prev: NO_REAUTH_STATE }), T)
    expect(d.restartAgent).toBe(false)
    expect(d.escalate).toBe(false)
  })
})

// GAP 2a (PLAN.md, 2026-07-23 marveen-channels silent outage): once GAP 1 lands,
// a dead main-agent token is a legitimate restart target (fresh process either
// picks the still-good fleet token back up, or the token is quarantined by the
// escalate branch first) -- decideReauthAction gains restartMain, gated at the
// exact same fireNow threshold as escalate, for the main agent only, and never
// on the first-run gate (see the "escalate-only" test above, extended with
// restartMain === false).
describe('decideReauthAction: restartMain (main agent dead-token restart)', () => {
  it('3rd consecutive dead probe fires restartMain for the main agent (not first-run gate)', () => {
    const d = decideReauthAction(base({ isMain: true, prev: { consecutiveDead: 2, lastActionAtMs: null }, nowMs: 2_000_000 }), T)
    expect(d.escalate).toBe(true)
    expect(d.restartMain).toBe(true)
    expect(d.sendKeys).toBe(false)
    expect(d.restartAgent).toBe(false)
  })

  it('debounces: below threshold, restartMain stays false', () => {
    const p1 = decideReauthAction(base({ isMain: true, prev: NO_REAUTH_STATE }), T)
    expect(p1.restartMain).toBe(false)
    const p2 = decideReauthAction(base({ isMain: true, prev: p1.next }), T)
    expect(p2.restartMain).toBe(false)
  })

  it('sub-agent never gets restartMain, even at threshold', () => {
    const d = decideReauthAction(base({ isMain: false, prev: { consecutiveDead: 2, lastActionAtMs: null } }), T)
    expect(d.restartMain).toBe(false)
  })

  it('cooldown: still-dead within 30min does not re-fire restartMain', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 5, lastActionAtMs },
      nowMs: lastActionAtMs + 10 * 60 * 1000, // 10 min later
    }), T)
    expect(d.restartMain).toBe(false)
    expect(d.escalate).toBe(false)
  })

  it('cooldown: restartMain re-fires after 30min if still dead (mirrors escalate)', () => {
    const lastActionAtMs = 1_000_000
    const d = decideReauthAction(base({
      isMain: true,
      prev: { consecutiveDead: 12, lastActionAtMs },
      nowMs: lastActionAtMs + 3 * 60 * 60 * 1000 + 60_000, // 3h + 1min later
    }), T)
    expect(d.restartMain).toBe(true)
    expect(d.escalate).toBe(true)
  })
})

// ----------------------------------------------------------------------------
// Layer 2: quiet-hours helpers
// ----------------------------------------------------------------------------

import {
  isQuietHour,
  localHour,
  routeEscalation,
  flushQuietSummary,
  buildQuietSummaryMessage,
  buildEscalationMessage,
  type QuietSuppressedEntry,
} from '../web/reauth-healer.js'

const entry = (session: string, label = session, consecutiveDead = 10): QuietSuppressedEntry => ({
  session,
  label,
  reason: 'API Error: 401',
  consecutiveDead,
})

describe('isQuietHour / localHour', () => {
  it('23:00-05:59 csendes, 06:00-22:59 nem', () => {
    expect(isQuietHour(23)).toBe(true)
    expect(isQuietHour(0)).toBe(true)
    expect(isQuietHour(5)).toBe(true)
    expect(isQuietHour(6)).toBe(false)
    expect(isQuietHour(12)).toBe(false)
    expect(isQuietHour(22)).toBe(false)
  })

  it('localHour a host TZ-től függetlenül az install-zóna (Óra APP_TZ) óráját adja', () => {
    // TZ-agnostic: localHour must equal an independent hour extraction in APP_TZ,
    // whatever APP_TZ is (Europe/London on this install). No hardcoded zone -> a
    // future SCHEDULER_TZ change does not break this test.
    const hourIn = (ms: number) =>
      parseInt(new Intl.DateTimeFormat('en-GB', { timeZone: APP_TZ, hour: '2-digit', hour12: false }).format(new Date(ms)), 10)
    for (const ms of [Date.UTC(2026, 6, 9, 22, 30), Date.UTC(2026, 6, 10, 4, 5), Date.UTC(2026, 0, 10, 22, 30)]) {
      expect(localHour(ms)).toBe(hourIn(ms))
    }
  })
})

describe('routeEscalation', () => {
  it('nappal azonnal notify-ol, nem gyűjt', () => {
    const sent: string[] = []
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry('agent-spock', 'spock'), false, (m) => sent.push(m), suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('spock')
    expect(suppressed.size).toBe(0)
  })

  it('csendes sávban NINCS notify, a riasztás a reggeli összegzőre vár', () => {
    const sent: string[] = []
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry('agent-spock', 'spock'), true, (m) => sent.push(m), suppressed)
    routeEscalation(entry('agent-scotty', 'scotty'), true, (m) => sent.push(m), suppressed)
    expect(sent).toHaveLength(0)
    expect([...suppressed.keys()]).toEqual(['agent-spock', 'agent-scotty'])
  })

  it('ismételt éjszakai eszkaláció felülírja a bejegyzést, nem duplikál', () => {
    const suppressed = new Map<string, QuietSuppressedEntry>()
    routeEscalation(entry('agent-spock', 'spock', 10), true, () => {}, suppressed)
    routeEscalation(entry('agent-spock', 'spock', 20), true, () => {}, suppressed)
    expect(suppressed.size).toBe(1)
    expect(suppressed.get('agent-spock')?.consecutiveDead).toBe(20)
  })
})

describe('flushQuietSummary', () => {
  it('csendes sáv alatt no-op (a gyűjtő érintetlen marad)', () => {
    const sent: string[] = []
    const suppressed = new Map([['agent-spock', entry('agent-spock', 'spock')]])
    flushQuietSummary(true, () => 10, (m) => sent.push(m), () => {}, suppressed)
    expect(sent).toHaveLength(0)
    expect(suppressed.size).toBe(1)
  })

  it('06:00 után EGY összegző megy ki a még mindig halott agensekről, cooldown-stampeléssel', () => {
    const sent: string[] = []
    const stamped: string[] = []
    const suppressed = new Map([
      ['agent-spock', entry('agent-spock', 'spock', 50)],
      ['agent-scotty', entry('agent-scotty', 'scotty', 40)],
    ])
    const stillDead = (s: string) => (s === 'agent-spock' ? 120 : s === 'agent-scotty' ? 110 : 0)
    flushQuietSummary(false, stillDead, (m) => sent.push(m), (s) => stamped.push(s), suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('spock')
    expect(sent[0]).toContain('scotty')
    expect(sent[0]).toContain('Reggeli token-összegzés')
    expect(stamped.sort()).toEqual(['agent-scotty', 'agent-spock'])
    expect(suppressed.size).toBe(0)
  })

  it('reggelre meggyógyult agent kimarad; ha mind meggyógyult, nincs üzenet', () => {
    const sent: string[] = []
    const suppressed = new Map([
      ['agent-spock', entry('agent-spock', 'spock')],
      ['agent-scotty', entry('agent-scotty', 'scotty')],
    ])
    flushQuietSummary(false, (s) => (s === 'agent-spock' ? 99 : 0), (m) => sent.push(m), () => {}, suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0]).toContain('spock')
    expect(sent[0]).not.toContain('scotty')

    const sent2: string[] = []
    const allHealed = new Map([['agent-data', entry('agent-data', 'data')]])
    flushQuietSummary(false, () => 0, (m) => sent2.push(m), () => {}, allHealed)
    expect(sent2).toHaveLength(0)
    expect(allHealed.size).toBe(0)
  })

  it('pinning: stampAlert `if (st)` false branch (dead-code guard, see bug MD)', async () => {
    // The sweep's stampAlert callback (src/web/reauth-healer.ts:393-395) has
    // an `if (st)` check that is genuinely unreachable in normal flow.
    // We reach it by combining two spies:
    //   1. A Map.prototype.set spy to identify the watchState Map (it
    //      holds objects with `lastActionAtMs` -- unique to ReauthHealerState).
    //   2. A Map.prototype.get spy that intercepts watchState reads. The
    //      spy's `tripped` flag flips to true the FIRST TIME execFile is
    //      called for /bin/bash (the morning summary's notify.sh call) --
    //      by the time notify fires, stillDeadCount has already run with a
    //      valid state, so the next watchState read is stampAlert. The
    //      spy returns undefined for THAT read, hitting the false branch.
    // See reauth-healer-stampalert-if-st-dead-code.
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)

    const originalSet = Map.prototype.set
    const originalGet = Map.prototype.get
    let watchStateMap: Map<unknown, unknown> | null = null
    const setSpy = vi.spyOn(Map.prototype, 'set').mockImplementation(function(
      this: Map<unknown, unknown>,
      key: unknown,
      value: unknown,
    ) {
      if (
        value && typeof value === 'object' && 'lastActionAtMs' in (value as object)
        && 'consecutiveDead' in (value as object)
      ) {
        watchStateMap = this
      }
      return originalSet.call(this, key, value)
    })
    let notifySeen = false
    let readsAfterNotify = 0
    const getSpy = vi.spyOn(Map.prototype, 'get').mockImplementation(function(
      this: Map<unknown, unknown>,
      key: unknown,
    ) {
      if (watchStateMap && this === watchStateMap && key === MAIN_SESSION) {
        if (notifySeen) {
          readsAfterNotify += 1
          // First read after notifySeen is stillDeadCount (return state so
          // the entry passes the > 0 filter); SECOND read is stampAlert
          // (return undefined to fire the false branch).
          if (readsAfterNotify === 2) return undefined
        }
        return { consecutiveDead: 5, lastActionAtMs: null }
      }
      return originalGet.call(this, key)
    })
    try {
      const mod = await loadModule()
      // Hook execFile BEFORE startReauthHealer to detect the notify.sh call.
      const cp = await import('node:child_process')
      const realExecFile = cp.execFile
      ;(cp as unknown as { execFile: typeof cp.execFile }).execFile = ((
        cmd: string,
        args: string[],
        opts: unknown,
        cb?: (err: unknown) => void,
      ) => {
        mocks.execFileCalls.push({ cmd, args, err: null })
        if (cmd === '/bin/bash') notifySeen = true
        if (typeof cb === 'function') cb(null)
        return {} as never
      }) as typeof cp.execFile
      try {
        mod.startReauthHealer()
        await firstSweep()
        await nextSweep()
        await nextSweep()
        expect(notifyCalls()).toHaveLength(0)
        await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
        const summary = notifyCalls().find((c) => c.args[1].includes('Reggeli token-összegzés'))
        expect(summary).toBeDefined()
        expect(notifySeen).toBe(true)
        expect(readsAfterNotify).toBeGreaterThanOrEqual(2)
      } finally {
        ;(cp as unknown as { execFile: typeof cp.execFile }).execFile = realExecFile
      }
    } finally {
      getSpy.mockRestore()
      setSpy.mockRestore()
    }
  })
})

describe('pinning: stillDeadCount `?? 0` right arm (sweep callback at line 391)', () => {
  it('pinning: stillDeadCount returns 0 when watchState.get returns nullish (orphan suppressed entry)', async () => {
    // The sweep's stillDeadCount callback at line 391:
    //   (session) => watchState.get(session)?.consecutiveDead ?? 0
    // has a `?? 0` right arm that fires when watchState.get returns nullish.
    // In production, the agent that lands in `quietSuppressed` ALSO lands in
    // `watchState` (both are managed together in checkSession at line 281-285),
    // so the stillDeadCount call always finds a state object. The `?? 0`
    // arm is unreachable from the production flow.
    //
    // We reach it here by using routeEscalation DIRECTLY (bypassing
    // checkSession) to put an entry into the module-private `quietSuppressed`
    // map without populating watchState. Then we drive a non-quiet sweep:
    // flushQuietSummary sees the suppressed entry, stillDeadCount is invoked,
    // watchState.get returns undefined (session is not tracked), and the
    // `?? 0` right arm fires (stillDeadCount returns 0, entry filtered, no
    // notify for the orphan -- the "all healed" path the bug MD documents).
    const QUIET_T0 = Date.UTC(2026, 0, 10, 23, 30)
    vi.setSystemTime(QUIET_T0)
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE) // keep checkSession in a normal flow
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep() // dead-token threshold, main agent is now in watchState + quietSuppressed
    expect(notifyCalls()).toHaveLength(0)
    // Add an orphan entry directly via routeEscalation -- this populates the
    // module-private quietSuppressed map without touching watchState. The
    // next non-quiet sweep's flushQuietSummary will iterate suppressed,
    // call stillDeadCount for this session, see watchState.get return
    // undefined, hit the `?? 0` right arm, get 0, filter the entry out.
    mod.routeEscalation(
      { session: 'orphan-pinning-session', label: 'orphan', reason: 'test', consecutiveDead: 5 },
      true, // quiet -> suppressed (default quietSuppressed)
      () => {},
    )
    await vi.advanceTimersByTimeAsync(7 * 60 * 60 * 1000)
    // The orphan session was suppressed but never tracked in watchState.
    // flushQuietSummary on the first non-quiet sweep hits the `?? 0` right arm
    // (watchState.get returns undefined for `orphan-pinning-session`,
    // stillDeadCount returns 0, entry filtered). The summary that does go out
    // covers the main agent, NOT the orphan (filtered out by consecutiveDead > 0).
    const summaries = notifyCalls().filter((c) => c.args[1].includes('Reggeli token-összegzés'))
    expect(summaries.length).toBeGreaterThanOrEqual(1)
    for (const s of summaries) {
      expect(s.args[1]).not.toContain('orphan')
    }
  })
})

describe('éjszaka -> reggel szimuláció (a 2026-07-09-es spock+scotty eset)', () => {
  it('23:10-től 05:40-ig 14 eszkaláció-tick alatt NULLA notify, 06:0x-kor pontosan EGY összegző', () => {
    const sent: string[] = []
    const suppressed = new Map<string, QuietSuppressedEntry>()
    const notify = (m: string) => sent.push(m)

    // Night: the healer's 30-min cooldown fires ~14 escalation decisions
    // across two agents between 23:10 and 05:40 -- all routed during quiet.
    for (let i = 0; i < 7; i++) {
      routeEscalation(entry('agent-spock', 'spock', 10 + i * 10), true, notify, suppressed)
      routeEscalation(entry('agent-scotty', 'scotty', 10 + i * 10), true, notify, suppressed)
      // Mid-night sweeps with nothing to flush stay silent too.
      flushQuietSummary(true, () => 999, notify, () => {}, suppressed)
    }
    expect(sent).toHaveLength(0)

    // 06:0x, first non-quiet sweep: both still dead -> one summary, then the
    // suppression buffer is empty so later sweeps send nothing extra.
    const stamped: string[] = []
    flushQuietSummary(false, () => 130, notify, (s) => stamped.push(s), suppressed)
    expect(sent).toHaveLength(1)
    expect(sent[0].split('\n').filter((l) => l.startsWith('•'))).toHaveLength(2)
    expect(stamped).toHaveLength(2)
    flushQuietSummary(false, () => 130, notify, () => {}, suppressed)
    expect(sent).toHaveLength(1)
  })
})

describe('üzenet-szövegek', () => {
  it('az egyedi eszkaláció szövege változatlan formátumú', () => {
    const msg = buildEscalationMessage('spock', 'API Error: 401', 3)
    expect(msg).toContain('spock')
    expect(msg).toContain('API Error: 401')
    expect(msg).toContain('Manuális browser /login')
  })

  it('az összegző megnevezi a sávot és agensenként a hozzávetőleges időt', () => {
    const msg = buildQuietSummaryMessage([entry('agent-spock', 'spock', 140)])
    expect(msg).toContain('23:00-06:00')
    expect(msg).toContain('• spock')
    expect(msg).toMatch(/~\d+ perce/)
  })

  it('az összegző üzres bemenetre is élhető fejléccel + összegző szöveggel tér vissza', () => {
    const msg = buildQuietSummaryMessage([])
    expect(msg).toContain('Reggeli token-összegzés')
    expect(msg).toContain('Manuális browser /login')
  })

  it('a per-minute kalkuláció a consecutiveDead * PROBE_INTERVAL_MS-ből indul', () => {
    // consecutiveDead = 0 -> ~0 minutes
    expect(buildEscalationMessage('x', 'r', 0)).toMatch(/~0 perce/)
    // consecutiveDead = 6 -> ~18 minutes (6 * 3min)
    expect(buildEscalationMessage('x', 'r', 6)).toMatch(/~18 perce/)
  })
})

// ----------------------------------------------------------------------------
// Layer 3: live watchdog loop
// ----------------------------------------------------------------------------

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
    // Replace tmux-keys via vi.doMock + resetModules so the reauth-healer
    // module picks up our stubbed loginSequence/literalKeyArgs -- vi.spyOn
    // on an ESM namespace does NOT propagate to importers, so this needs the
    // module-graph swap. loginSequence returns one step with delayMs=0; this
    // hits the `if (step.delayMs > 0)` false branch inside sendBestEffortLogin.
    vi.doMock('../web/tmux-keys.js', () => ({
      loginSequence: () => [{ kind: 'literal' as const, text: '/login', delayMs: 0 }],
      literalKeyArgs: (_session: string, text: string) => ['send-keys', '-t', 'scout', '-l', '--', text],
      specialKeyArgs: () => null,
    }))
    const mod = await loadModule()
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    // Exactly one send-keys call (the literal step); no sleep() because delayMs=0.
    const send = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
    expect(send.length).toBe(1)
    expect(mocks.warn).toHaveBeenCalledWith(
      { label: 'scout', session: 'scout' },
      'reauth-healer: confirmed dead token on live sub-agent -- best-effort /login send-keys',
    )
    vi.doUnmock('../web/tmux-keys.js')
  })

  it('skips tmux send-keys when literalKeyArgs returns null (the args falsy branch)', async () => {
    pinInteractive()
    // Replace tmux-keys via vi.doMock so the reauth-healer module picks up our
    // stubs. The literal step's literalKeyArgs returns null, which hits the
    // `if (args)` false branch (line 156); the special step proceeds normally.
    vi.doMock('../web/tmux-keys.js', () => ({
      loginSequence: () => [
        { kind: 'literal' as const, text: '/login', delayMs: 0 },
        { kind: 'special' as const, key: 'Enter', delayMs: 0 },
      ],
      literalKeyArgs: () => null,
      specialKeyArgs: (_session: string, name: string) => ['send-keys', '-t', 'scout', name],
    }))
    const mod = await loadModule()
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    // Only the special-key step reaches execFile; the literal step is skipped.
    const send = tmuxCalls().filter((c) => c.args[0] === 'send-keys')
    expect(send.length).toBe(1)
    expect(send[0]!.args).toContain('Enter')
    vi.doUnmock('../web/tmux-keys.js')
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

  it('falls back to reason="auth failure" when detectReauthNeeded returns needsReauth without reason', async () => {
    // The `?? 'auth failure'` fallback at reauth-healer.ts:301 is reachable
    // only when detectReauthNeeded returns needsReauth=true with reason
    // undefined -- a state the production detector never produces (every
    // REAUTH_MARKERS entry has a reason). To exercise the branch we patch
    // detectReauthNeeded via mocks.reauthDetectOverride.
    mocks.reauthDetectOverride = () => ({ needsReauth: true })
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    const notify = notifyCalls()
    expect(notify).toHaveLength(1)
    expect(notify[0]!.args[1]).toContain('auth failure')
    expect(notify[0]!.args[1]).not.toContain('Please run /login')
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
    mocks.quarantineFn.mockRejectedValueOnce(new Error('live probe crashed'))
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
    mocks.hardRestartResult = () => { throw new Error('hardRestart boom') }
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
    ;(cp as unknown as { execFile: typeof cp.execFile }).execFile = ((
      cmd: string,
      args: string[],
      _opts: unknown,
      cb?: (err: unknown) => void,
    ) => {
      mocks.execFileCalls.push({ cmd, args, err: cmd === '/bin/bash' ? new Error('notify.sh exit 1') : null })
      if (typeof cb === 'function') cb(cmd === '/bin/bash' ? new Error('notify.sh exit 1') : null)
      return {} as never
    }) as typeof cp.execFile
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

  it('main-agent first-run gate skips the fleet-token quarantine (token is presumably fine)', async () => {
    mocks.listAgentNames.mockReturnValue([])
    mocks.capturePane.mockReturnValue(FIRST_RUN_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    await vi.advanceTimersByTimeAsync(0)
    await Promise.resolve()
    // quarantineFleetTokenIfDead should NOT have been called because the
    // first-run-gate branch skips the .then() block.
    expect(mocks.quarantineFn).not.toHaveBeenCalled()
  })
})

describe('checkSession: sub-agent goes down then comes back', () => {
  it('removes a sub-agent from both watchState and quietSuppressed when it goes down', async () => {
    // The "isAgentRunning(name) === false" branch on line 376-380 deletes
    // both maps. Cover by setting up an agent that is initially reported as
    // running, accumulating a dead-token spell, then going down.
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    mocks.isAgentRunning.mockReturnValue(true)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(notifyCalls().length).toBeGreaterThanOrEqual(1)
    // Now the agent goes down -- the next sweep must NOT try to capturePane
    // for it (it was filtered at the isAgentRunning check), and the watch
    // state must be cleared. We capture by counting capturePane calls.
    mocks.isAgentRunning.mockReturnValue(false)
    const callsBefore = mocks.capturePane.mock.calls.length
    await nextSweep()
    const callsAfter = mocks.capturePane.mock.calls.length
    // The main-agent capture-pane call still runs (it's checked before the
    // sub-agent iteration), but the scout call is skipped.
    expect(callsAfter - callsBefore).toBe(1) // only main capture-pane
  })
})

// ----------------------------------------------------------------------------
// Layer 3b: macOS / headless detection
// ----------------------------------------------------------------------------

describe('hostCanInteractiveLogin (via checkSession)', () => {
  it('darwin returns true regardless of DISPLAY env (canInteractiveLogin true -> sendKeys fires)', async () => {
    // macOS dev hosts are always considered able to complete interactive /login
    // even without a DISPLAY env var (the production rule is darwin=true).
    Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true })
    delete process.env['DISPLAY']
    delete process.env['WAYLAND_DISPLAY']
    mocks.listAgentNames.mockReturnValue(['scout'])
    mocks.capturePane.mockReturnValue(DEAD_PANE)
    const mod = await loadModule()
    mod.startReauthHealer()
    await firstSweep()
    await nextSweep()
    await nextSweep()
    expect(tmuxCalls().some((c) => c.args[0] === 'send-keys')).toBe(true)
  })

  it('linux with DISPLAY set returns true (hostCanInteractiveLogin env branch)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    process.env['DISPLAY'] = ':0'
    delete process.env['WAYLAND_DISPLAY']
    try {
      mocks.listAgentNames.mockReturnValue(['scout'])
      mocks.capturePane.mockReturnValue(DEAD_PANE)
      const mod = await loadModule()
      mod.startReauthHealer()
      await firstSweep()
      await nextSweep()
      await nextSweep()
      // With DISPLAY set, sendKeys fires (canInteractiveLogin=true).
      expect(tmuxCalls().some((c) => c.args[0] === 'send-keys')).toBe(true)
    } finally {
      delete process.env['DISPLAY']
    }
  })

  it('linux with WAYLAND_DISPLAY set returns true (the || branch)', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
    delete process.env['DISPLAY']
    process.env['WAYLAND_DISPLAY'] = 'wayland-0'
    try {
      mocks.listAgentNames.mockReturnValue(['scout'])
      mocks.capturePane.mockReturnValue(DEAD_PANE)
      const mod = await loadModule()
      mod.startReauthHealer()
      await firstSweep()
      await nextSweep()
      await nextSweep()
      expect(tmuxCalls().some((c) => c.args[0] === 'send-keys')).toBe(true)
    } finally {
      delete process.env['WAYLAND_DISPLAY']
    }
  })
})