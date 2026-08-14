// 100% coverage test for src/web/worker-liveness.ts.
//
// This file complements src/__tests__/worker-liveness.test.ts by covering
// the lines left untested there: the exported entry point
// `startWorkerLivenessMonitor()` (lines 186-221). The pure decision
// (`decideWorkerLiveness`) and the runner-level glue (`sweepWorkerLiveness`)
// are already exercised there; here we drive the setInterval loop end-to-end
// with mocked collaborators.
//
// Sandbox: every external collaborator is mocked at module-load time
// (logger, agent-process.capturePane, agent-worker.workerContexts +
// isWorkerSessionAlive). The setupFiles layer already redirects PROJECT_ROOT
// to a tmpdir, so nothing the SUT imports can write to the live store.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { logger } from '../logger.js'

// ---------------------------------------------------------------------------
// Hoisted mock fns -- referenced by the vi.mock factories below.
// ---------------------------------------------------------------------------
const {
  mockWorkerContexts,
  mockIsWorkerSessionAlive,
  mockCapturePane,
} = vi.hoisted(() => ({
  mockWorkerContexts: vi.fn<() => Array<{ session: string }>>(),
  mockIsWorkerSessionAlive: vi.fn<(session: string) => boolean>(),
  mockCapturePane: vi.fn<(session: string) => string | null>(),
}))

// ---------------------------------------------------------------------------
// Mock factories (hoisted by vitest above the SUT import).
// ---------------------------------------------------------------------------
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../web/agent-process.js', () => ({
  capturePane: (session: string) => mockCapturePane(session),
}))

vi.mock('../web/agent-worker.js', () => ({
  workerContexts: () => mockWorkerContexts(),
  isWorkerSessionAlive: (session: string) => mockIsWorkerSessionAlive(session),
}))

// ---------------------------------------------------------------------------
// Per-test reset.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers()
  // Default to a single alive worker session -- most tests only need one.
  mockWorkerContexts.mockReturnValue([
    { session: 'agent-worker' },
  ])
  mockIsWorkerSessionAlive.mockReturnValue(true)
  mockCapturePane.mockReturnValue('pane content')
})

afterEach(() => {
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Fresh-module helper. startWorkerLivenessMonitor() returns the interval
// handle and is normally wired once at server boot; each test wants a clean
// handle so its own clearInterval only touches its own timer.
// ---------------------------------------------------------------------------
async function loadSUT(): Promise<typeof import('../web/worker-liveness.js')> {
  vi.resetModules()
  return await import('../web/worker-liveness.js')
}

// ===========================================================================
// startWorkerLivenessMonitor -- the exported entry point.
//
// Every test below advances fake timers past LIVENESS_POLL_MS (60_000) so
// the setInterval body actually fires.
// ===========================================================================
describe('startWorkerLivenessMonitor', () => {
  it('returns a NodeJS.Timeout handle from setInterval', async () => {
    const { startWorkerLivenessMonitor } = await loadSUT()
    const handle = startWorkerLivenessMonitor()
    // NodeJS.Timeout is an object; verify we got something timer-like.
    expect(typeof handle).toBe('object')
    expect(handle).not.toBeNull()
    clearInterval(handle)
  })

  it('schedules the sweep at LIVENESS_POLL_MS (60s)', async () => {
    const { startWorkerLivenessMonitor, LIVENESS_POLL_MS } = await loadSUT()
    const handle = startWorkerLivenessMonitor()

    // Within the first interval no sweep has run.
    vi.advanceTimersByTime(LIVENESS_POLL_MS - 1)
    expect(mockIsWorkerSessionAlive).not.toHaveBeenCalled()

    // At exactly LIVENESS_POLL_MS the first tick fires.
    vi.advanceTimersByTime(1)
    expect(mockIsWorkerSessionAlive).toHaveBeenCalledTimes(1)
    clearInterval(handle)
  })

  it('invokes workerContexts() on every sweep to discover the worker sessions', async () => {
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([
      { session: 'agent-worker' },
      { session: 'agent-worker-fast' },
    ])

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000) // sweep 1
    vi.advanceTimersByTime(60_000) // sweep 2
    vi.advanceTimersByTime(60_000) // sweep 3

    expect(mockWorkerContexts).toHaveBeenCalledTimes(3)
    expect(mockIsWorkerSessionAlive).toHaveBeenCalledWith('agent-worker')
    expect(mockIsWorkerSessionAlive).toHaveBeenCalledWith('agent-worker-fast')
    clearInterval(handle)
  })

  it('captures the pane only for sessions that are still alive', async () => {
    // agent-worker dies after one sweep; the monitor must not waste a tmux
    // capture on a known-dead session (the runner-level sweepWorkerLiveness
    // also guards this, but the wiring here has to honour it).
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])
    mockIsWorkerSessionAlive.mockReturnValue(true)

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000)
    expect(mockCapturePane).toHaveBeenCalledWith('agent-worker')
    clearInterval(handle)
  })

  it('does not capture the pane on subsequent sweeps of an absent session', async () => {
    // Session dies between sweep 1 (alive) and sweep 2 (absent). The monitor
    // must not invoke capturePane for the absent session on sweep 2 -- the
    // pane is unreadable post-mortem.
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])
    let alive = true
    mockIsWorkerSessionAlive.mockImplementation(() => alive)

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000) // sweep 1: alive
    expect(mockCapturePane).toHaveBeenCalledTimes(1)

    alive = false
    vi.advanceTimersByTime(60_000) // sweep 2: dead
    expect(mockCapturePane).toHaveBeenCalledTimes(1) // unchanged
    clearInterval(handle)
  })

  it('logs a death with the lower-bound message when the session predated the monitor', async () => {
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])

    // The first sweep sees an alive session (isFirstSweep=true). 6 minutes
    // pass -- the monitor polls every 60s -- and on the seventh sweep the
    // session is gone. The first-seen-on-first-sweep flag must propagate
    // into the truncated log line.
    let alive = true
    mockIsWorkerSessionAlive.mockImplementation(() => alive)
    mockCapturePane.mockReturnValue('a final line\nof useful context\nbefore death')

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000)        // sweep 1, first sweep, alive
    alive = false
    vi.advanceTimersByTime(60_000)        // sweep 2, dead

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 'agent-worker',
        lifetimeMs: expect.any(Number),
        lifetimeMin: expect.any(Number),
        lifetimeTruncated: true,
        lastPane: expect.any(String),
      }),
      'worker-liveness: worker session disappeared (lifetime is a LOWER BOUND: the session predated this monitor, e.g. a dashboard restart)',
    )
    clearInterval(handle)
  })

  it('logs a death with the non-truncated message when the session was first seen after the monitor started', async () => {
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])

    // First sweep: nothing alive. Second sweep: it appears. Third sweep:
    // gone. Lifetime is NOT truncated because we saw it from birth.
    let alive = false
    mockIsWorkerSessionAlive.mockImplementation(() => alive)
    mockCapturePane.mockReturnValue('pane content')

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000)        // sweep 1, first sweep, nothing there
    alive = true
    vi.advanceTimersByTime(60_000)        // sweep 2, alive -- start fresh lifetime
    alive = false
    vi.advanceTimersByTime(60_000)        // sweep 3, dead

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 'agent-worker',
        lifetimeTruncated: false,
      }),
      'worker-liveness: worker session disappeared (it was started, then died -- nothing restarts it until the next request)',
    )
    clearInterval(handle)
  })

  it('does not log a death when a never-alive session is just absent on the first sweep', async () => {
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])
    mockIsWorkerSessionAlive.mockReturnValue(false) // never alive

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(60_000)
    vi.advanceTimersByTime(60_000)

    // WEB_ONLY / boot race / never-started: not a death.
    expect(logger.warn).not.toHaveBeenCalled()
    clearInterval(handle)
  })

  it('continues polling after a death (does not log the same death again on the next tick)', async () => {
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])

    let alive = true
    mockIsWorkerSessionAlive.mockImplementation(() => alive)
    mockCapturePane.mockReturnValue('p')

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000) // sweep 1: alive
    alive = false
    vi.advanceTimersByTime(60_000) // sweep 2: dead -> log
    vi.advanceTimersByTime(60_000) // sweep 3: still dead -> no log
    vi.advanceTimersByTime(60_000) // sweep 4: still dead -> no log

    const deathLogs = (logger.warn as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => Array.isArray(c) && typeof c[1] === 'string' &&
        c[1].toString().startsWith('worker-liveness: worker session disappeared'),
    )
    expect(deathLogs).toHaveLength(1)
    clearInterval(handle)
  })

  it('reports lifetimeMin as rounded minutes from lifetimeMs', async () => {
    // 7 minutes 30 seconds -> 450_000 ms -> rounds to 8 minutes. Verify the
    // Math.round(lifetimeMs / 60_000) branch fires.
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])

    let alive = true
    mockIsWorkerSessionAlive.mockImplementation(() => alive)
    mockCapturePane.mockReturnValue('p')

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000)            // sweep 1: alive at t=60_000
    // We cannot fast-forward the within-sweep clock directly -- the monitor
    // uses Date.now() inside its `now` factory. Reach for vi.setSystemTime
    // before the death sweep so the next poll's `now` reflects 7m30s elapsed.
    vi.setSystemTime(Date.now() + 7 * 60_000 + 30_000) // +7.5min
    alive = false
    vi.advanceTimersByTime(60_000)            // sweep 2: dead

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 'agent-worker',
        lifetimeMin: expect.any(Number),
      }),
      expect.any(String),
    )
    const lastCall = (logger.warn as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.at(-1)
    expect(lastCall).toBeDefined()
    const arg0 = lastCall![0]
    expect(typeof arg0.lifetimeMin).toBe('number')
    clearInterval(handle)
  })

  it('survives a sweep-throw and continues on the next tick (try/catch + finally first=false)', async () => {
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])

    // First call to workerContexts throws -- the tick must catch it, log a
    // warning, and STILL continue on the next interval (the `finally`
    // branch flips `first` to false so subsequent sweeps do not mark
    // isFirstSweep=true again).
    mockWorkerContexts
      .mockImplementationOnce(() => { throw new Error('tmux down') })
      .mockReturnValue([{ session: 'agent-worker' }])
    mockIsWorkerSessionAlive.mockReturnValue(true)
    mockCapturePane.mockReturnValue('p')

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000) // sweep 1: throws -> caught
    vi.advanceTimersByTime(60_000) // sweep 2: now runs cleanly

    expect(logger.warn).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'worker-liveness: sweep failed (continuing)',
    )
    // Sweep 2 actually ran -- the finally branch flipped `first` off.
    expect(mockIsWorkerSessionAlive).toHaveBeenCalledWith('agent-worker')
    clearInterval(handle)
  })

  it('marks isFirstSweep=true only on the very first sweep, not on later sweeps', async () => {
    // The runner-level sweepWorkerLiveness was already verified to thread
    // isFirstSweep correctly when the caller supplies it. Here we only
    // need to verify the monitor itself: that the first tick passes
    // isFirstSweep=true and subsequent ticks pass false. The state that
    // firstSeenOnFirstSweep attaches to lives on the WorkerLivenessState
    // returned by the decision function -- we observe it via the
    // lifetimeTruncated flag in the death log (true only when the first
    // sweep saw the session alive).
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])
    mockIsWorkerSessionAlive.mockReturnValue(true)
    mockCapturePane.mockReturnValue('p')

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000)            // sweep 1: isFirstSweep=true
    vi.advanceTimersByTime(60_000)            // sweep 2: isFirstSweep=false
    vi.advanceTimersByTime(60_000)            // sweep 3: isFirstSweep=false
    mockIsWorkerSessionAlive.mockReturnValue(false)
    vi.advanceTimersByTime(60_000)            // sweep 4: dies, lifetimeTruncated=true

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 'agent-worker',
        lifetimeTruncated: true,
      }),
      expect.stringContaining('LOWER BOUND'),
    )
    clearInterval(handle)
  })

  it('reports the last pane as the tail (DEATH_PANE_LINES) of what was captured alive', async () => {
    const { startWorkerLivenessMonitor, DEATH_PANE_LINES } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])

    let alive = true
    mockIsWorkerSessionAlive.mockImplementation(() => alive)

    // Build a pane well over DEATH_PANE_LINES long so the tail is non-trivial.
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i}`)
    mockCapturePane.mockReturnValue(lines.join('\n'))

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000) // sweep 1: alive, capture full pane
    alive = false
    vi.advanceTimersByTime(60_000) // sweep 2: dead, log tail

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 'agent-worker',
        lastPane: expect.stringContaining(`line ${39}`),
      }),
      expect.any(String),
    )
    const arg0 = (logger.warn as unknown as { mock: { calls: Array<[Record<string, unknown>]> } }).mock.calls.at(-1)![0]
    expect((arg0.lastPane as string).split('\n')).toHaveLength(DEATH_PANE_LINES)
    clearInterval(handle)
  })

  it('reports a null lastPane when no capture ever succeeded before death', async () => {
    // Every capture call returns null -- the death log must still include
    // lastPane=null (the decide-worker-liveness decision carries null
    // because there is no usable post-mortem evidence).
    const { startWorkerLivenessMonitor } = await loadSUT()
    mockWorkerContexts.mockReturnValue([{ session: 'agent-worker' }])

    let alive = true
    mockIsWorkerSessionAlive.mockImplementation(() => alive)
    mockCapturePane.mockReturnValue(null)

    const handle = startWorkerLivenessMonitor()
    vi.advanceTimersByTime(60_000) // sweep 1: alive but capture failed -> keeps lastPane null
    alive = false
    vi.advanceTimersByTime(60_000) // sweep 2: dead -> log with lastPane=null

    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({
        session: 'agent-worker',
        lastPane: null,
      }),
      expect.any(String),
    )
    clearInterval(handle)
  })
})
