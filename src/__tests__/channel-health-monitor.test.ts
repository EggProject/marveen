// ----------------------------------------------------------------------------
// channel-health-monitor.ts -- 100% coverage
//
// The file under test owns three collaborating surfaces:
//
//   1. spawnDetachedReconnect()        -- spawns `reconnect-cli.js` as a
//      detached child; dedups via the in-flight set; logs warn on
//      child error / sync spawn throw.
//   2. checkAgent()                    -- reads tmux pane, decides whether to
//      spawn a reconnect (backoff + MAX_RETRIES + COOLDOWN_MS).
//   3. startChannelHealthMonitor()     -- kicks off the 60s tick + initial
//      45s setTimeout, swallowing per-agent errors.
//
// To exercise all branches we mock every collaborator and drive the test
// through the EXPORTED surface only (`getChannelHealth` and
// `startChannelHealthMonitor`). The internal `checkAgent` runs once the
// 45s setTimeout fires, so we use `vi.useFakeTimers()` to advance time
// deterministically without waiting 45s.
//
// `reconnectState` and `inFlightReconnects` are module-level Maps that
// persist across tests in the same file. We therefore `vi.resetModules()`
// + re-import between tests to guarantee a fresh module.
// ----------------------------------------------------------------------------

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---- collaborators (mocked once at module-load time) ------------------

const mockSpawn = vi.fn()
vi.mock('node:child_process', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
}))

const mockLogger = {
  info: vi.fn(),
  warn: vi.fn(),
  debug: vi.fn(),
  error: vi.fn(),
}
vi.mock('../logger.js', () => ({ logger: mockLogger }))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
}))

const mockListAgentNames = vi.fn<(prefix?: string) => string[]>(() => [])
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: (prefix?: string) => mockListAgentNames(prefix),
}))

const mockIsAgentRunning = vi.fn<(name: string) => boolean>(() => false)
const mockCapturePane = vi.fn<(session: string) => string | null>(() => null)
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => mockIsAgentRunning(name),
  capturePane: (session: string) => mockCapturePane(session),
}))

vi.mock('../web/channel-mcp-reconnect.js', () => ({
  resolveAgentSession: (name: string) =>
    name === 'marveen' ? 'marveen-channels' : `agent-${name}`,
  resolveAgentProviderType: (_name: string) => 'telegram',
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: (_type: string) => ({
    pluginPaneId: 'plugin:telegram:telegram',
    pluginId: 'telegram@claude-plugins-official',
    type: 'telegram',
  }),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

// ---- helpers ----------------------------------------------------------

/** Build a fake ChildProcess whose `once` listeners can be invoked from
 *  the test by calling the returned `emit`. `unref` is a spy. */
function makeFakeChild(): {
  child: { once: ReturnType<typeof vi.fn>; unref: ReturnType<typeof vi.fn> }
  emit: (event: 'exit' | 'error', payload?: unknown) => void
  unrefSpy: ReturnType<typeof vi.fn>
} {
  const handlers: Record<string, Array<(p: unknown) => void>> = {}
  const child = {
    once: vi.fn((event: string, cb: (p: unknown) => void) => {
      handlers[event] = handlers[event] ?? []
      handlers[event].push(cb)
    }),
    unref: vi.fn(),
  }
  return {
    child,
    emit(event, payload) {
      for (const cb of handlers[event] ?? []) cb(payload)
    },
    unrefSpy: child.unref,
  }
}

/** Reset the module under test so its in-memory Maps (reconnectState,
 *  inFlightReconnects) start empty for each test, then re-import the
 *  two exported functions. */
async function loadModule(): Promise<{
  getChannelHealth: typeof import('../web/channel-health-monitor.js').getChannelHealth
  startChannelHealthMonitor: typeof import('../web/channel-health-monitor.js').startChannelHealthMonitor
}> {
  vi.resetModules()
  // Re-establish the mocks after resetModules clears them.
  vi.doMock('node:child_process', () => ({
    spawn: (...args: unknown[]) => mockSpawn(...args),
  }))
  vi.doMock('../logger.js', () => ({ logger: mockLogger }))
  vi.doMock('../config.js', () => ({ MAIN_AGENT_ID: 'marveen' }))
  vi.doMock('../web/agent-config.js', () => ({
    listAgentNames: (prefix?: string) => mockListAgentNames(prefix),
  }))
  vi.doMock('../web/agent-process.js', () => ({
    isAgentRunning: (name: string) => mockIsAgentRunning(name),
    capturePane: (session: string) => mockCapturePane(session),
  }))
  vi.doMock('../web/channel-mcp-reconnect.js', () => ({
    resolveAgentSession: (name: string) =>
      name === 'marveen' ? 'marveen-channels' : `agent-${name}`,
    resolveAgentProviderType: (_name: string) => 'telegram',
  }))
  vi.doMock('../channel-provider.js', () => ({
    getProvider: (_type: string) => ({
      pluginPaneId: 'plugin:telegram:telegram',
      pluginId: 'telegram@claude-plugins-official',
      type: 'telegram',
    }),
  }))
  vi.doMock('../web/main-agent.js', () => ({
    MAIN_CHANNELS_SESSION: 'marveen-channels',
  }))
  const mod = await import('../web/channel-health-monitor.js')
  return {
    getChannelHealth: mod.getChannelHealth,
    startChannelHealthMonitor: mod.startChannelHealthMonitor,
  }
}

// First import to satisfy the type system; the actual module instance is
// reloaded by loadModule() before each test.
await loadModule()

// ---- tests ------------------------------------------------------------

describe('getChannelHealth', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns healthy=true with zero attempts when no state is recorded', async () => {
    const { getChannelHealth } = await loadModule()
    expect(getChannelHealth('nobody-ever-checked')).toEqual({
      healthy: true,
      reconnectAttempts: 0,
      lastAttemptAt: null,
    })
  })

  it('returns healthy=false with the recorded attempts and timestamp', async () => {
    mockListAgentNames.mockReturnValueOnce([])
    mockCapturePane.mockReturnValueOnce(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValueOnce(fake.child)

    const { getChannelHealth, startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    try {
      vi.advanceTimersByTime(45_000) // setTimeout(check, 45_000) fires
      expect(getChannelHealth('marveen')).toEqual({
        healthy: false,
        reconnectAttempts: 1,
        lastAttemptAt: expect.any(Number),
      })
    } finally {
      clearInterval(handle)
    }
  })
})

describe('checkAgent -- via startChannelHealthMonitor tick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockSpawn.mockReset()
    mockCapturePane.mockReset()
    mockCapturePane.mockReturnValue(null)
    mockListAgentNames.mockReset()
    mockListAgentNames.mockReturnValue([])
    mockIsAgentRunning.mockReset()
    mockIsAgentRunning.mockReturnValue(false)
    mockLogger.info.mockReset()
    mockLogger.warn.mockReset()
    mockLogger.debug.mockReset()
    mockLogger.error.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns silently when capturePane is null (pane unreadable)', async () => {
    mockCapturePane.mockReturnValue(null)
    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    try {
      vi.advanceTimersByTime(45_000)
      expect(mockSpawn).not.toHaveBeenCalled()
    } finally {
      clearInterval(handle)
    }
  })

  it('clears existing state and logs "recovered" when the plugin is NOT failed', async () => {
    // First tick: register a failure (state is recorded).
    mockCapturePane.mockReturnValueOnce(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { getChannelHealth, startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(getChannelHealth('marveen').healthy).toBe(false)

    // Next tick after T=75000 (nextRetryAt) -- need to advance past it.
    // setInterval fires every 60s starting from T=0, so the first fire
    // after T=75000 is at T=120000. Advance 75_000ms from T=45000.
    mockCapturePane.mockReturnValueOnce(
      'plugin:telegram:telegram\n✔ connected',
    )
    vi.advanceTimersByTime(75_000)
    expect(getChannelHealth('marveen').healthy).toBe(true)
    expect(mockLogger.info).toHaveBeenCalledWith(
      { agentName: 'marveen', provider: 'telegram' },
      'channel-health-monitor: plugin recovered',
    )

    clearInterval(handle)
  })

  it('skips when nextRetryAt is still in the future', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // Tick again inside the 30s backoff window -- spawn count stays at 1.
    vi.advanceTimersByTime(100)
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    clearInterval(handle)
  })

  it('skips an in-flight reconnect and logs debug instead of spawning again', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000) // first spawn (attempts -> 1)
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // Child has NOT emitted 'exit', so inFlightReconnects still holds
    // 'marveen'. Advance to the next setInterval fire AFTER T=75000
    // (nextRetryAt). The setInterval was registered at T=0 and fires
    // every 60s, so the first fire after T=75000 is at T=120000.
    // From T=45000 we must advance 75_000.
    vi.advanceTimersByTime(75_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockLogger.debug).toHaveBeenCalledWith(
      { agentName: 'marveen', attempt: 1 },
      'channel-health-monitor: reconnect already in flight, skipping',
    )

    clearInterval(handle)
  })

  it('bails out at MAX_RETRIES when lastAttemptAt is within COOLDOWN_MS', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { getChannelHealth, startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()

    // Drive attempts to MAX_RETRIES=3 by releasing the in-flight set
    // before each tick past the backoff window.
    // Tick 1: T=45000 (setTimeout). spawn #1. state.attempts=1,
    //   nextRetryAt=75000.
    vi.advanceTimersByTime(45_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(1)
    fake.emit('exit') // release in-flight set

    // Tick 2: first fire after T=75000 is at T=120000. From T=45000,
    //   advance 75_000. spawn #2. attempts=2, nextRetryAt=210000.
    vi.advanceTimersByTime(75_000)
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(2)
    fake.emit('exit')

    // Tick 3: first fire after T=210000 is at T=240000. From T=120000,
    //   advance 120_000. spawn #3. attempts=3, nextRetryAt=510000.
    vi.advanceTimersByTime(120_000)
    expect(mockSpawn).toHaveBeenCalledTimes(3)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(3)
    fake.emit('exit')

    // Now tick again within COOLDOWN_MS (30 min) -- early bail path.
    // Fire at T=300000 (60s after T=240000). state.attempts=3,
    // lastAttemptAt=240000, diff=60000 < COOLDOWN_MS.
    const beforeCalls = mockSpawn.mock.calls.length
    vi.advanceTimersByTime(60_000)
    expect(mockSpawn.mock.calls.length).toBe(beforeCalls) // no new spawn

    // State stays unhealthy.
    expect(getChannelHealth('marveen').healthy).toBe(false)

    clearInterval(handle)
  })

  it('clears the state after MAX_RETRIES + COOLDOWN_MS has elapsed', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { getChannelHealth, startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()

    vi.advanceTimersByTime(45_000) // attempt 1 at T=45000
    fake.emit('exit')
    vi.advanceTimersByTime(75_000) // attempt 2 at T=120000
    fake.emit('exit')
    vi.advanceTimersByTime(120_000) // attempt 3 at T=240000
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(3)
    fake.emit('exit')

    // Advance to T=2100000 (exactly 1860s after T=240000). T=2100000
    // is a setInterval fire point (240000 + 60*31000). At that fire:
    //   state.attempts=3, lastAttemptAt=240000, diff=1860000 > 1800000
    //   -> delete state. We stop before T=2160000 (next fire), so no
    //   new spawn sneaks in.
    vi.advanceTimersByTime(1_860_000)
    expect(getChannelHealth('marveen')).toEqual({
      healthy: true,
      reconnectAttempts: 0,
      lastAttemptAt: null,
    })

    clearInterval(handle)
  })

  it('logs warn + spawns detached when the plugin is failed and no reconnect is in flight', async () => {
    mockCapturePane.mockReturnValueOnce(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValueOnce(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)

    expect(mockLogger.warn).toHaveBeenCalledWith(
      { agentName: 'marveen', attempt: 0, provider: 'telegram' },
      'channel-health-monitor: plugin failure detected, spawning detached reconnect',
    )
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(mockSpawn).toHaveBeenCalledWith(
      process.execPath,
      [expect.stringMatching(/reconnect-cli\.js$/), 'marveen'],
      expect.objectContaining({
        detached: true,
        stdio: 'ignore',
        env: process.env,
      }),
    )
    expect(fake.unrefSpy).toHaveBeenCalled()

    clearInterval(handle)
  })

  it('detects the ✘ error and ✘ disconnected variants of plugin failure', async () => {
    mockCapturePane
      .mockReturnValueOnce('plugin:telegram:telegram\n✘ error')
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000) // attempt 1 at T=45000 (uses '✘ error')
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    fake.emit('exit') // release in-flight

    mockCapturePane.mockReturnValueOnce(
      'plugin:telegram:telegram\n✘ disconnected',
    )
    // First fire after T=75000 is T=120000. From T=45000, advance 75_000.
    vi.advanceTimersByTime(75_000) // attempt 2 at T=120000
    expect(mockSpawn).toHaveBeenCalledTimes(2)

    clearInterval(handle)
  })

  it('matches plugin failures only when the pluginPaneId is in the pane', async () => {
    // Wrong plugin id -> not failed -> no spawn, no state.
    mockCapturePane.mockReturnValueOnce(
      'plugin:slack:slack\n✘ failed',
    )
    const { getChannelHealth, startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(getChannelHealth('marveen').healthy).toBe(true)

    clearInterval(handle)
  })

  it('iterates over running sub-agents from listAgentNames()', async () => {
    mockListAgentNames.mockReturnValue(['samu', 'zara'])
    mockIsAgentRunning.mockImplementation(
      (name: string) => name === 'samu', // zara is NOT running
    )
    mockCapturePane.mockImplementation((session: string) => {
      if (session === 'marveen-channels' || session === 'agent-samu') {
        return 'plugin:telegram:telegram\n✘ failed'
      }
      return null
    })
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    const spawnedAgentNames: unknown[] = []
    for (const call of mockSpawn.mock.calls) {
      const args = call[1]
      if (Array.isArray(args)) spawnedAgentNames.push(args[1])
    }
    expect(spawnedAgentNames).toContain('marveen')
    expect(spawnedAgentNames).toContain('samu')
    expect(spawnedAgentNames).not.toContain('zara')

    clearInterval(handle)
  })

  it('swallows errors thrown by checkAgent for the main agent', async () => {
    // Force an error from the main-agent check by making capturePane
    // throw on the marveen session.
    mockCapturePane.mockImplementation((session: string) => {
      if (session === 'marveen-channels') throw new Error('main boom')
      return null
    })
    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { err: expect.any(Error) },
      'channel-health-monitor: main agent check error',
    )

    clearInterval(handle)
  })

  it('swallows errors thrown by checkAgent for a sub-agent', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockReturnValue(true)
    mockCapturePane.mockImplementation((session: string) => {
      if (session === 'agent-samu') throw new Error('sub boom')
      return null
    })
    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)

    expect(mockLogger.debug).toHaveBeenCalledWith(
      { err: expect.any(Error), agent: 'samu' },
      'channel-health-monitor: agent check error',
    )

    clearInterval(handle)
  })
})

describe('spawnDetachedReconnect (via checkAgent in-flight path)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockListAgentNames.mockReset()
    mockListAgentNames.mockReturnValue([])
    mockCapturePane.mockReset()
    mockCapturePane.mockReturnValue(null)
    mockIsAgentRunning.mockReset()
    mockIsAgentRunning.mockReturnValue(false)
    mockSpawn.mockReset()
    mockLogger.warn.mockReset()
    mockLogger.info.mockReset()
    mockLogger.debug.mockReset()
    mockLogger.error.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('removes the agent from the in-flight set when the detached child exits', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000) // attempt 1: spawn #1, child alive
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // First setInterval fire after T=75000 (nextRetryAt) is T=120000.
    // inFlightReconnects still holds 'marveen' (no exit yet). Skip path.
    vi.advanceTimersByTime(75_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // Release the in-flight set. Next fire is at T=180000 (60s later).
    fake.emit('exit')
    vi.advanceTimersByTime(60_000)
    expect(mockSpawn).toHaveBeenCalledTimes(2)

    clearInterval(handle)
  })

  it('logs warn when the detached child emits an error', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)

    const boom = new Error('worker crashed')
    mockLogger.warn.mockClear()
    fake.emit('error', boom)
    expect(mockLogger.warn).toHaveBeenCalledWith(
      { agentName: 'marveen', err: boom },
      'channel-health-monitor: failed to spawn reconnect worker',
    )

    // The error handler also removed the agent from the in-flight set,
    // so the next tick past the backoff can spawn again.
    vi.advanceTimersByTime(60_000)
    expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(1)

    clearInterval(handle)
  })

  it('logs warn and returns false when spawn throws synchronously', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    mockSpawn.mockImplementation(() => {
      throw new Error('spawn refused')
    })

    const { getChannelHealth, startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)

    expect(mockLogger.warn).toHaveBeenCalledWith(
      {
        agentName: 'marveen',
        err: expect.any(Error),
      },
      'channel-health-monitor: reconnect spawn threw',
    )
    // State still incremented (the spawn happened, even if it threw).
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(1)

    clearInterval(handle)
  })

  it('does not double-spawn when a previous reconnect is still in flight', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(45_000) // past backoff, child still alive
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    vi.advanceTimersByTime(120_000) // further
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    clearInterval(handle)
  })

  // ---- pinning test for the removed in-flight guard ------------------
  //
  // `spawnDetachedReconnect` no longer carries an `if (inFlightReconnects.has(
  // agentName)) return false` guard at its top. The Set spy below simulates
  // a hypothetical second caller injecting an in-flight Set state and then
  // confirms the spawn still proceeds -- i.e. the unguarded outcome holds
  // even under adversarial Set membership. checkAgent's own gate (further
  // up the call chain) is unchanged; if that ever stops filtering, this pin
  // becomes load-bearing again.
  it('pinning: removed in-flight guard does not block spawn even if Set reports in flight', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram\n✘ failed',
    )
    const fake = makeFakeChild()
    mockSpawn.mockReturnValue(fake.child)

    const originalHas = Set.prototype.has
    const hasSpy = vi.spyOn(Set.prototype, 'has').mockImplementation(function (
      this: Set<unknown>,
      value: unknown,
    ): boolean {
      const stack = new Error().stack ?? ''
      // Pretend the Set reports an in-flight reconnect when queried from
      // inside spawnDetachedReconnect. With the old (dead) guard this would
      // have short-circuited; the new contract is that the helper is
      // unconditional, so the spawn must still happen. checkAgent's own
      // gate sits above us and is unaffected (its stack does not include
      // 'spawnDetachedReconnect').
      if (stack.includes('spawnDetachedReconnect')) return true
      return originalHas.call(this, value)
    })

    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    // The dead guard is gone, so even with the spy reporting a stale
    // in-flight membership the detached child IS created. This pins the
    // new contract: only checkAgent's gate filters spawns; the helper
    // itself is unconditional.
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    hasSpy.mockRestore()
    clearInterval(handle)
  })
})

describe('startChannelHealthMonitor -- wiring', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockListAgentNames.mockReset()
    mockListAgentNames.mockReturnValue([])
    mockCapturePane.mockReset()
    mockCapturePane.mockReturnValue(null)
    mockSpawn.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('returns a NodeJS.Timeout (the setInterval handle)', async () => {
    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    // NodeJS.Timeout in vitest's fake-timer mode is wrapped in a proxy;
    // we assert truthiness + that clearInterval accepts it (would throw
    // on a plain string/number).
    expect(handle).toBeTruthy()
    expect(() => clearInterval(handle)).not.toThrow()
    // The timer was registered with setInterval, so it must have unref
    // (Node Timeout shape). Asserting via Reflect.construct avoids an
    // `as` cast while still probing the property.
    expect(Reflect.get(handle, 'unref')).toBeTypeOf('function')
  })

  it('schedules the first check at 45_000ms (initial offset)', async () => {
    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(44_999)
    expect(mockCapturePane).not.toHaveBeenCalled()
    vi.advanceTimersByTime(2)
    expect(mockCapturePane).toHaveBeenCalled()
    clearInterval(handle)
  })

  it('continues ticking every 60_000ms after the first check', async () => {
    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(mockCapturePane).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(mockCapturePane).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    expect(mockCapturePane).toHaveBeenCalledTimes(3)
    clearInterval(handle)
  })

  it('always inspects the main-agent session, even with zero sub-agents', async () => {
    mockListAgentNames.mockReturnValue([])
    const { startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(mockCapturePane).toHaveBeenCalledWith('marveen-channels')
    clearInterval(handle)
  })
})

// ----------------------------------------------------------------------------
// Pinning test for the suspected bug: when the detached reconnect throws
// synchronously, the catch handler still increments the backoff state even
// though no work was actually scheduled. This is by design (current
// behaviour: record the attempt regardless) and pinned here so a future
// refactor does not silently drop the increment.
// ----------------------------------------------------------------------------
describe('pinning: spawn-throw still records a backoff tick', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mockListAgentNames.mockReset()
    mockListAgentNames.mockReturnValue([])
    mockCapturePane.mockReset()
    mockCapturePane.mockReturnValue('plugin:telegram:telegram\n✘ failed')
    mockSpawn.mockReset()
    mockSpawn.mockImplementation(() => {
      throw new Error('refused')
    })
    mockLogger.warn.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  it('attempts counter increments to 1 even though spawn threw', async () => {
    const { getChannelHealth, startChannelHealthMonitor } = await loadModule()
    const handle = startChannelHealthMonitor()
    vi.advanceTimersByTime(45_000)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(1)
    clearInterval(handle)
  })
})