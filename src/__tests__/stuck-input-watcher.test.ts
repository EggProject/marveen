import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

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


// The stuck-input-watcher drives per-session state through three I/O helpers
// (captureParkedInputView, sendEnterToSession, recoverStuckInputForSession)
// and a small set of agent queries (isAgentRunning, listAgentNames,
// readAgentRemoteHost, resolveAgentSession). We mock the dependencies
// directly and let child_process pass through (vi.mock below) so the watcher
// exercises ONLY the orchestration code in src/web/stuck-input-watcher.ts.

const mockCapture = vi.fn<(session: string, host: string | null) => string | null>()
const mockSendEnter = vi.fn<(session: string, host: string | null) => boolean>()
const mockRecover = vi.fn()
const mockListAgentNames = vi.fn<() => string[]>()
const mockIsAgentRunning = vi.fn<(name: string) => boolean>()
const mockReadHost = vi.fn<(name: string) => string | null>()
const mockResolveSession = vi.fn<(name: string) => string>()
const mockSendAlert = vi.fn()

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
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
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => mockListAgentNames(),
  readAgentRemoteHost: (name: string) => mockReadHost(name),
}))

vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => mockIsAgentRunning(name),
  captureParkedInputView: (session: string, host: string | null) => mockCapture(session, host),
  sendEnterToSession: (session: string, host: string | null) => mockSendEnter(session, host),
}))

vi.mock('../web/channel-mcp-reconnect.js', () => ({
  resolveAgentSession: (name: string) => mockResolveSession(name),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/channel-monitor.js', () => ({
  recoverStuckInputForSession: (session: string, prev: unknown, thresholds: unknown, allowPlainReinject: boolean) =>
    mockRecover(session, prev, thresholds, allowPlainReinject),
  sendAlert: (text: string) => mockSendAlert(text),
}))

// Keep the real pane-state helpers so the watcher's call into
// stuckInputSignature / parkedPasteSignature / decideStuckInputRecovery goes
// through the actual pure logic -- that logic is the same one exercised by
// stuck-input-fast-recovery.test.ts, and the watcher's job is the I/O +
// per-session state map around it. Mocking these would mean the tests would
// assert against the mocks, not against the real decision flow.

import { logger } from '../logger.js'
import {
  stuckInputSignature,
  parkedPasteSignature,
  decideStuckInputRecovery,
  type StuckInputState,
} from '../pane-state.js'
import { startStuckInputWatcher } from '../web/stuck-input-watcher.js'

const NO_STATE: StuckInputState = { parkedSig: null, firstSeenAt: null, lastRecoverAt: null, attempts: 0 }

// Timer-layout notes:
// startStuckInputWatcher schedules both setTimeout(sweep, 20_000) and
// setInterval(sweep, 15_000) at T=0. As vitest's fake timer advances:
//   T=15: interval tick #1
//   T=20: setTimeout (initial)
//   T=30: interval tick #2
//   T=35: interval tick #3
// Tests use `vi.advanceTimersByTimeAsync(20_000)` to fire BOTH the interval
// tick at T=15 and the initial setTimeout at T=20 in a single advance (so
// "one tick" really means 2 sweeps). The default mockResolvedValue(NO_STATE)
// keeps the additional sweep calls from throwing.

beforeEach(() => {
  vi.clearAllMocks()
  // Anchor the fake clock so Date.now() advances with vi.advanceTimersByTime*,
  // which decideStuckInputRecovery needs to count confirm windows elapsed.
  vi.useFakeTimers({ now: 1_700_000_000_000 })
  // Default: recover returns NO_STATE so the spell clears; sub-agents give a
  // non-empty fleet; capture returns an idle pane so recoverParkedPaste exits
  // early (returns false) and checkLocalSession / bareEnterRecovery run.
  mockRecover.mockResolvedValue(NO_STATE)
  mockListAgentNames.mockReturnValue([])
  mockIsAgentRunning.mockReturnValue(true)
  mockResolveSession.mockImplementation((name: string) => `agent-${name}`)
  mockReadHost.mockReturnValue(null)
  mockCapture.mockReturnValue(IDLE)
  mockSendEnter.mockReturnValue(true)
  mockSendAlert.mockReset()
})

afterEach(() => {
  vi.useRealTimers()
})

// A captured pane that reads as a parked input (stuckInputSignature non-null).
const PARKED_CHANNEL = [
  '',
  '─'.repeat(80),
  '❯ <channel source="plugin:telegram" chat_id="123">rovid uzenet</channel>',
  '─'.repeat(80),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// A captured pane that reads as a parked `[Pasted text #N +N chars]` placeholder.
const PARKED_PASTE = [
  '',
  '─'.repeat(80),
  '❯ [Pasted text #1 +1234 chars]',
  '  hello world',
  '─'.repeat(80),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// An idle pane: no parked text, no placeholder.
const IDLE = [
  '',
  '─'.repeat(80),
  '❯ ',
  '─'.repeat(80),
  '  ⏵⏵ bypass permissions on (shift+tab to cycle)',
].join('\n')

// Filter helper: only the recover() calls for a given session.
function recoverCallsFor(session: string): unknown[][] {
  return mockRecover.mock.calls.filter((c) => c[0] === session)
}

describe('startStuckInputWatcher -- lifecycle', () => {
  it('returns a timer handle and the sweep runs after the initial delay', async () => {
    mockListAgentNames.mockReturnValue([])

    const timer = startStuckInputWatcher()
    expect(timer).toBeDefined()
    // 20_000 ms covers both the initial setTimeout (T=20) AND the first
    // interval tick (T=15) -- see the timer-layout note above.
    await vi.advanceTimersByTimeAsync(20_000)
    expect(mockCapture).toHaveBeenCalled()
    clearInterval(timer)
  })

  it('keeps sweeping on every interval tick', async () => {
    mockListAgentNames.mockReturnValue([])

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)
    const countAfterFirst = mockCapture.mock.calls.length
    await vi.advanceTimersByTimeAsync(15_000)
    expect(mockCapture.mock.calls.length).toBeGreaterThan(countAfterFirst)
    clearInterval(timer)
  })
})

describe('startStuckInputWatcher -- main channels session path', () => {
  it('runs recoverParkedPaste FIRST for the main session and skips checkLocalSession on paste hit', async () => {
    mockCapture.mockReturnValue(PARKED_PASTE)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // Paste hit -> checkLocalSession must NOT run for the main session. The
    // default mockRecover would have been called had checkLocalSession run.
    expect(recoverCallsFor('marveen-channels').length).toBe(0)
    clearInterval(timer)
  })

  it('runs checkLocalSession for the main session when no paste placeholder is parked', async () => {
    mockCapture.mockReturnValue(PARKED_CHANNEL)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    const mainCalls = recoverCallsFor('marveen-channels')
    expect(mainCalls.length).toBeGreaterThan(0)
    // MAIN allowPlainReinject=false (phantom-injection guard for the main
    // session -- see the header in stuck-input-watcher.ts).
    expect(mainCalls[0]?.[3]).toBe(false)
    clearInterval(timer)
  })

  it('catches errors from the main session check and logs them at debug', async () => {
    mockCapture.mockImplementation(() => { throw new Error('main pane capture exploded') })

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(vi.mocked(logger.debug)).toHaveBeenCalled()
    clearInterval(timer)
  })
})

describe('startStuckInputWatcher -- sub-agent paths', () => {
  it('skips capture for a non-running sub-agent (the watch-state delete branch)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockReturnValue(false)
    mockResolveSession.mockReturnValue('agent-samu')
    mockReadHost.mockReturnValue(null)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // Non-running agent: no capture happens for it (watchState.delete + continue).
    const subAgentCaptures = mockCapture.mock.calls.filter((c) => c[0] === 'agent-samu')
    expect(subAgentCaptures.length).toBe(0)
    expect(recoverCallsFor('agent-samu').length).toBe(0)
    clearInterval(timer)
  })

  it('runs the local full-escalation on a local running sub-agent (allowPlainReinject=true)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-samu')
    mockReadHost.mockReturnValue(null)
    mockCapture.mockReturnValue(PARKED_CHANNEL)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // Local sub-agent -> checkLocalSession is called with allowPlainReinject=true.
    const subCalls = recoverCallsFor('agent-samu')
    expect(subCalls.length).toBeGreaterThan(0)
    expect(subCalls[0]?.[3]).toBe(true)
    clearInterval(timer)
  })

  it('does NOT route a remote running sub-agent through recoverStuckInputForSession', async () => {
    mockListAgentNames.mockReturnValue(['laptop-boni'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-laptop-boni')
    mockReadHost.mockReturnValue('laptop.example.com')

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // Remote: only bareEnterRecovery -- no recover call for the sub-agent.
    expect(recoverCallsFor('agent-laptop-boni').length).toBe(0)
    clearInterval(timer)
  })

  it('bareEnterRecovery fires the recovery Enter after the confirm window elapses', async () => {
    // Covers src/web/stuck-input-watcher.ts lines 155-159 -- the `recover=true`
    // branch inside bareEnterRecovery: log info + sendEnterToSession.
    mockListAgentNames.mockReturnValue(['laptop-boni'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-laptop-boni')
    mockReadHost.mockReturnValue('laptop.example.com')
    mockCapture.mockReturnValue(PARKED_CHANNEL)

    const timer = startStuckInputWatcher()
    // 35_000 ms covers T=15, T=20, T=30. THRESHOLDS.confirmMs=10s, so by T=30
    // (15s after the first observation at T=15) the spell crosses the
    // confirm window and bareEnterRecovery sends a recovery Enter.
    await vi.advanceTimersByTimeAsync(35_000)

    const sendCalls = mockSendEnter.mock.calls.filter((c) => c[0] === 'agent-laptop-boni')
    expect(sendCalls.length).toBeGreaterThan(0)
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'laptop-boni' }),
      expect.stringContaining('parked input persisted past confirm window'),
    )
    clearInterval(timer)
  })

  it('recoverParkedPaste logs the give-up warning when attempts maxAttempts via injected decision', async () => {
    // Covers src/web/stuck-input-watcher.ts lines 124-125 -- the maxAttempts
    // give-up branch inside recoverParkedPaste. The branch is unreachable
    // through decideStuckInputRecovery's normal return values (see
    // docs/needs-to-be-fix/stuck-input-watcher-give-up-inner-if-unreachable.md).
    // We force it by mocking pane-state for this test only and re-importing
    // the watcher via vi.resetModules. The freshly imported watcher sees a
    // decideStuckInputRecovery that always returns the unreachable shape
    // (recover=false, next.attempts=3, parkedSig != null). With prev
    // freshly NO_STATE on the first sweep, the inner if fires.
    vi.doMock('../pane-state.js', () => ({
      stuckInputSignature: () => null,
      parkedPasteSignature: () => 'parked-paste',
      decideStuckInputRecovery: () => ({
        recover: false,
        next: { parkedSig: 'parked-paste', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
      }),
    }))
    vi.resetModules()
    const { startStuckInputWatcher: freshStart } = await import('../web/stuck-input-watcher.js')

    // One remote sub-agent. recoverParkedPaste hits the give-up branch
    // (paste sig present + attempts >= maxAttempts + prev < maxAttempts).
    mockListAgentNames.mockReturnValue(['laptop-boni'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-laptop-boni')
    mockReadHost.mockReturnValue('laptop.example.com')
    mockCapture.mockReturnValue(PARKED_PASTE)
    mockSendEnter.mockReturnValue(true)
    vi.mocked(logger.warn).mockClear()

    const timer = freshStart()
    await vi.advanceTimersByTimeAsync(15_000)

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'laptop-boni' }),
      expect.stringContaining('paste placeholder still parked after max recovery Enters'),
    )
    clearInterval(timer)
    vi.doUnmock('../pane-state.js')
    vi.resetModules()
  })

  it('bareEnterRecovery logs the give-up warning when attempts maxAttempts via injected decision', async () => {
    // Covers src/web/stuck-input-watcher.ts lines 164-165 -- the maxAttempts
    // give-up branch inside bareEnterRecovery. Same dead-branch reasoning as
    // recoverParkedPaste; here we make parkedPasteSignature return null so
    // bareEnterRecovery is the path that fires. We also exercise both
    // outcomes of the inner if (prev.attempts < maxAttempts is true on the
    // first sweep, false on the second sweep once watchState carries
    // attempts=3 from the first tick).
    vi.doMock('../pane-state.js', () => ({
      stuckInputSignature: () => 'parked-typing',
      parkedPasteSignature: () => null,
      decideStuckInputRecovery: () => ({
        recover: false,
        next: { parkedSig: 'parked-typing', firstSeenAt: 1, lastRecoverAt: 1, attempts: 3 },
      }),
    }))
    vi.resetModules()
    const { startStuckInputWatcher: freshStart } = await import('../web/stuck-input-watcher.js')

    mockListAgentNames.mockReturnValue(['laptop-boni'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-laptop-boni')
    mockReadHost.mockReturnValue('laptop.example.com')
    mockCapture.mockReturnValue(PARKED_CHANNEL)
    mockSendEnter.mockReturnValue(true)
    vi.mocked(logger.warn).mockClear()

    const timer = freshStart()
    // Two ticks: first tick -> prev=NO_STATE (true branch fires warn);
    // second tick -> prev=stale-attempts=3 (false branch, no warn).
    await vi.advanceTimersByTimeAsync(35_000)

    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ label: 'laptop-boni' }),
      expect.stringContaining('input still parked after max recovery Enters'),
    )
    clearInterval(timer)
    vi.doUnmock('../pane-state.js')
    vi.resetModules()
  })

  it('the parked-paste branch on a remote sub-agent skips the bare-Enter recovery (sendEnter from paste path)', async () => {
    mockListAgentNames.mockReturnValue(['laptop-boni'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-laptop-boni')
    mockReadHost.mockReturnValue('laptop.example.com')
    mockCapture.mockReturnValue(PARKED_PASTE)

    const timer = startStuckInputWatcher()
    // 35_000 ms covers T=15, T=20, T=30 -- three sweeps, with the third past
    // the THRESHOLDS confirmMs (10s) since the first spell observation.
    await vi.advanceTimersByTimeAsync(35_000)

    // recoverParkedPaste calls sendEnterToSession when recover=true. The
    // paste path runs the bare Enter, NOT recoverStuckInputForSession.
    const sendCalls = mockSendEnter.mock.calls.filter((c) => c[0] === 'agent-laptop-boni')
    expect(sendCalls.length).toBeGreaterThan(0)
    expect(recoverCallsFor('agent-laptop-boni').length).toBe(0)
    clearInterval(timer)
  })

  it('catches errors from a per-agent sub-agent check and logs them at debug', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-samu')
    mockReadHost.mockReturnValue(null)
    mockCapture.mockImplementation((session: string) =>
      session === 'marveen-channels' ? IDLE : (() => { throw new Error('agent pane exploded') })(),
    )

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(vi.mocked(logger.debug)).toHaveBeenCalled()
    clearInterval(timer)
  })

  it('a null pane capture ends any spell (the pane == null branch in bareEnterRecovery)', async () => {
    // Covers src/web/stuck-input-watcher.ts line 143 -- the `pane == null`
    // short-circuit in bareEnterRecovery (a failed capture treats it as
    // nothing parked and ends any active spell).
    mockListAgentNames.mockReturnValue(['laptop-boni'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-laptop-boni')
    mockReadHost.mockReturnValue('laptop.example.com')
    mockCapture.mockReturnValue(null)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // recoverParkedPaste: pane==null -> sig==null -> returns false.
    // bareEnterRecovery: pane==null -> sig==null -> no recovery, ends spell.
    // No sendEnter, no warn.
    expect(mockSendEnter).not.toHaveBeenCalled()
    expect(vi.mocked(logger.warn)).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('a null pane capture in recoverParkedPaste also ends the spell (no paste-path recovery)', async () => {
    // Covers src/web/stuck-input-watcher.ts line 111 -- the `pane == null`
    // short-circuit in recoverParkedPaste. The function returns false
    // immediately and the caller falls through to the typing / bare-Enter
    // path (or no-op for the main session).
    mockListAgentNames.mockReturnValue([])
    mockCapture.mockReturnValue(null)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // recoverParkedPaste returns false on the null pane -> checkLocalSession
    // runs for main, mocked recover returns NO_STATE so no spell persists.
    expect(mockSendEnter).not.toHaveBeenCalled()
    expect(recoverCallsFor('marveen-channels').length).toBeGreaterThan(0) // checkLocalSession ran
    clearInterval(timer)
  })

  it('walks multiple sub-agents in a single sweep', async () => {
    mockListAgentNames.mockReturnValue(['samu', 'boni', 'zara'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockImplementation((name: string) => `agent-${name}`)
    mockReadHost.mockReturnValue(null)
    mockCapture.mockReturnValue(IDLE)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // Each sweep produces 1 main + 3 sub-agent recover calls; advancing 20s
    // fires 2 sweeps, so at least one call per agent+main is enough.
    expect(recoverCallsFor('marveen-channels').length).toBeGreaterThan(0)
    expect(recoverCallsFor('agent-samu').length).toBeGreaterThan(0)
    expect(recoverCallsFor('agent-boni').length).toBeGreaterThan(0)
    expect(recoverCallsFor('agent-zara').length).toBeGreaterThan(0)
    clearInterval(timer)
  })
})

// ---------------------------------------------------------------------------
// Targeted tests for the watcher's escalation / give-up side effects. The
// pure decision logic itself is covered by stuck-input-fast-recovery.test.ts;
// here we assert that the watcher wires the I/O side effects correctly.
// ---------------------------------------------------------------------------

describe('startStuckInputWatcher -- escalation side effects', () => {
  it('a give-up on the MAIN session does NOT alert (channel-monitor owns MAIN alerts)', async () => {
    mockListAgentNames.mockReturnValue([])
    mockCapture.mockReturnValue(PARKED_CHANNEL)
    // recoverStuckInputForSession returns next.attempts >= maxAttempts with
    // a non-null parkedSig -- the give-up branch in checkLocalSession. MAIN
    // has alertOnGiveUp=false, so sendAlert must NOT fire.
    const stuck: StuckInputState = { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 5 }
    mockRecover.mockResolvedValueOnce(stuck)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(recoverCallsFor('marveen-channels').length).toBeGreaterThan(0)
    expect(mockSendAlert).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('a give-up on a SUB-agent DOES alert (sub-agents own their own restart prompts)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-samu')
    mockReadHost.mockReturnValue(null)
    mockCapture.mockReturnValue(IDLE)
    const stuck: StuckInputState = { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 5 }
    // First call (main, IDLE -> NO_STATE), second call (sub-agent, give-up).
    mockRecover
      .mockResolvedValueOnce(NO_STATE)
      .mockResolvedValueOnce(stuck)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    expect(mockSendAlert).toHaveBeenCalledTimes(1)
    expect(mockSendAlert.mock.calls[0]?.[0]).toMatch(/samu/)
    clearInterval(timer)
  })

  it('a give-up alerts on every tick where next.attempts has hit maxAttempts', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-samu')
    mockReadHost.mockReturnValue(null)
    mockCapture.mockReturnValue(IDLE)
    const stuck: StuckInputState = { parkedSig: 'sig', firstSeenAt: 1, lastRecoverAt: 1, attempts: 5 }
    // Sequence: main NO_STATE, sub-agent stuck (give-up fires),
    //           main NO_STATE, sub-agent stuck (give-up fires again --
    //           the prev.attempts < maxAttempts inner guard was dropped
    //           because decideStuckInputRecovery's budget-spent branch
    //           makes prev.attempts == next.attempts and the inner guard
    //           was structurally dead).
    mockRecover
      .mockResolvedValueOnce(NO_STATE)
      .mockResolvedValueOnce(stuck)
      .mockResolvedValueOnce(NO_STATE)
      .mockResolvedValueOnce(stuck)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)
    await vi.advanceTimersByTimeAsync(15_000)

    // Two alerts: the first sweep's give-up fires, then the second sweep's
    // give-up also fires because prev.attempts is no longer gated.
    expect(mockSendAlert).toHaveBeenCalledTimes(2)
    clearInterval(timer)
  })

  it('spell clears when next.parkedSig is null (the watchState.delete branch)', async () => {
    mockListAgentNames.mockReturnValue([])
    mockCapture.mockReturnValue(PARKED_CHANNEL)
    // Default: recover returns NO_STATE so the delete branch fires.
    mockRecover.mockResolvedValue(NO_STATE)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(35_000)

    expect(recoverCallsFor('marveen-channels').length).toBeGreaterThan(0)
    expect(mockSendAlert).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('walks the sub-agent capture with the agent session and host (host-aware)', async () => {
    mockListAgentNames.mockReturnValue(['laptop-boni'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-laptop-boni')
    mockReadHost.mockReturnValue('laptop.example.com')
    mockCapture.mockReturnValue(PARKED_CHANNEL)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    // The remote sub-agent must be captured with its host (host-aware tmux).
    const subAgentCaptures = mockCapture.mock.calls.filter((c) => c[0] === 'agent-laptop-boni')
    expect(subAgentCaptures.length).toBeGreaterThan(0)
    expect(subAgentCaptures[0]?.[1]).toBe('laptop.example.com')
    clearInterval(timer)
  })

  it('captures the local sub-agent with host=null', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockReturnValue(true)
    mockResolveSession.mockReturnValue('agent-samu')
    mockReadHost.mockReturnValue(null)
    mockCapture.mockReturnValue(IDLE)

    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    const subAgentCaptures = mockCapture.mock.calls.filter((c) => c[0] === 'agent-samu')
    expect(subAgentCaptures.length).toBeGreaterThan(0)
    expect(subAgentCaptures[0]?.[1]).toBeNull()
    clearInterval(timer)
  })

  it('captures the main session with host=null', async () => {
    const timer = startStuckInputWatcher()
    await vi.advanceTimersByTimeAsync(20_000)

    const mainCaptures = mockCapture.mock.calls.filter((c) => c[0] === 'marveen-channels')
    expect(mainCaptures.length).toBeGreaterThan(0)
    expect(mainCaptures[0]?.[1]).toBeNull()
    clearInterval(timer)
  })
})

// ---------------------------------------------------------------------------
// Side-channel: verify the watcher's real-world imports are exactly what the
// source declares. This is a sanity test that catches a silent drift in the
// dependency set (e.g. someone removing an import without removing the call).
// ---------------------------------------------------------------------------

describe('stuck-input-watcher -- dependency surface', () => {
  it('uses stuckInputSignature, parkedPasteSignature, and decideStuckInputRecovery directly', () => {
    expect(typeof stuckInputSignature).toBe('function')
    expect(typeof parkedPasteSignature).toBe('function')
    expect(typeof decideStuckInputRecovery).toBe('function')
    const sig = stuckInputSignature(PARKED_CHANNEL)
    expect(sig).not.toBeNull()
    const pasteSig = parkedPasteSignature(PARKED_PASTE)
    expect(pasteSig).not.toBeNull()
    expect(parkedPasteSignature(IDLE)).toBeNull()
  })
})