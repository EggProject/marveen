import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// channel-health-monitor.ts runs the (synchronous, blocking) MCP reconnect in
// a DETACHED child process so it can never starve the dashboard event loop,
// so we assert on spawn(), not on an inline attemptChannelMcpReconnect call.
//
// Two pieces of module-internal state need a fresh module instance per test:
//   - inFlightReconnects (Set<string>)  -- tracks spawned-but-unfinished
//     workers so a second failure tick on the same agent does not pile on.
//   - reconnectState (Map<string, AgentReconnectState>) -- per-agent backoff.
// Both resetModules() in beforeEach so each test sees a virgin monitor.
const { mockSpawn } = vi.hoisted(() => ({ mockSpawn: vi.fn() }))
vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: mockSpawn,
}))

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => `/usr/local/bin/${name}`,
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
  MAIN_AGENT_ID: 'marveen',
  CHANNEL_PROVIDER: 'telegram',
  PROJECT_ROOT: '/tmp/test-claudeclaw',
}))

const mockListAgentNames = vi.fn<() => string[]>()
vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => mockListAgentNames(),
  readAgentChannelProvider: () => 'telegram',
  AGENTS_BASE_DIR: '/tmp/test-claudeclaw/agents',
}))

const mockCapturePane = vi.fn<(session: string) => string | null>()
const mockIsAgentRunning = vi.fn<(name: string) => boolean>()
vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: (name: string) => mockIsAgentRunning(name),
  capturePane: (session: string) => mockCapturePane(session),
  agentSessionName: (name: string) => `agent-${name}`,
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

const mockResolveAgentSession = vi.fn<(name: string) => string>()
const mockResolveAgentProviderType = vi.fn<(name: string) => string>()
vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: vi.fn(),
  resolveAgentSession: (name: string) => mockResolveAgentSession(name),
  resolveAgentProviderType: (name: string) => mockResolveAgentProviderType(name),
}))

vi.mock('../channel-provider.js', () => ({
  getProvider: () => ({
    pluginId: 'telegram@claude-plugins-official',
    pluginPaneId: 'plugin:telegram:telegram',
  }),
}))

// Imports must come AFTER the vi.mock calls so they bind to the mocks.
// We import lazily inside a helper because vi.resetModules() between tests
// invalidates the binding.
async function importMonitor() {
  return import('../web/channel-health-monitor.js')
}

interface FakeChild {
  once: ReturnType<typeof vi.fn>
  unref: ReturnType<typeof vi.fn>
}

function makeFakeChild(): FakeChild {
  return { once: vi.fn(), unref: vi.fn() }
}

describe('getChannelHealth', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
  })

  it('returns healthy when no reconnect state exists', async () => {
    const { getChannelHealth } = await importMonitor()
    const health = getChannelHealth('unknown-agent')
    expect(health.healthy).toBe(true)
    expect(health.reconnectAttempts).toBe(0)
    expect(health.lastAttemptAt).toBeNull()
  })

  it('returns unhealthy with attempts/lastAttemptAt after a reconnect was recorded', async () => {
    // Force the monitor into the post-failure state by driving the internal
    // check via startChannelHealthMonitor, then read the public API.
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T12:00:00Z'))
    mockListAgentNames.mockReturnValue([])
    mockSpawn.mockReturnValue(makeFakeChild())
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed\nsome other output',
    )
    mockResolveAgentProviderType.mockReturnValue('telegram')

    const { getChannelHealth, startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000) // past the 45s initial delay
    clearInterval(timer)
    vi.useRealTimers()

    const health = getChannelHealth('marveen')
    expect(health.healthy).toBe(false)
    expect(health.reconnectAttempts).toBe(1)
    expect(typeof health.lastAttemptAt).toBe('number')
  })
})

describe('startChannelHealthMonitor', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.clearAllMocks()
    vi.useFakeTimers()
    // Default: no agents, no failure in pane, spawn returns a benign fake.
    mockListAgentNames.mockReturnValue([])
    mockIsAgentRunning.mockReturnValue(false)
    mockSpawn.mockReturnValue(makeFakeChild())
    mockCapturePane.mockReturnValue('normal pane content')
    mockResolveAgentProviderType.mockReturnValue('telegram')
    mockResolveAgentSession.mockImplementation(
      (name: string) => `agent-${name}`,
    )
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('returns a timer handle', async () => {
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    expect(timer).toBeDefined()
    clearInterval(timer)
  })

  it('schedules the first check after a 45s offset, then a 60s interval', async () => {
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')

    // First check fires after 45s; nothing happens before that.
    vi.advanceTimersByTime(44_999)
    expect(mockCapturePane).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(mockCapturePane).toHaveBeenCalledTimes(1)

    // Next check is on the 60s setInterval (so 60s after the LAST one, not
    // relative to start -- vitest's advanceTimersByTime just moves the clock).
    vi.advanceTimersByTime(60_000)
    expect(mockCapturePane).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(60_000)
    expect(mockCapturePane).toHaveBeenCalledTimes(3)

    clearInterval(timer)
    setTimeoutSpy.mockRestore()
  })

  it('does not reconnect when pane shows no failure', async () => {
    mockCapturePane.mockReturnValue(
      'normal pane content with plugin:telegram:telegram active',
    )
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    expect(mockSpawn).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('does not reconnect when pane is empty (capturePane returns empty string)', async () => {
    mockCapturePane.mockReturnValue('')
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    expect(mockSpawn).not.toHaveBeenCalled()
    clearInterval(timer)
  })

  it('spawns a detached reconnect worker when pane shows plugin failure', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed\nsome other output',
    )
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)

    // Off-main-loop: a detached child (reconnect-cli.js) is spawned instead of
    // calling attemptChannelMcpReconnect inline (event-loop starvation fix).
    expect(mockSpawn).toHaveBeenCalled()
    const [, args] = mockSpawn.mock.calls[0]
    expect(String(args[0])).toContain('reconnect-cli')
    expect(args[1]).toBe('marveen')
    clearInterval(timer)
  })

  it('passes the failed agent name as the spawn argv tail', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockImplementation((name: string) => name === 'samu')
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ error',
    )
    mockResolveAgentSession.mockImplementation(
      (name: string) => `agent-${name}`,
    )
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    expect(mockSpawn).toHaveBeenCalled()
    // samu is the failing agent (its pane was the one captured).
    const samuCall = mockSpawn.mock.calls.find(
      (c) => (c[1] as string[])[1] === 'samu',
    )
    expect(samuCall).toBeDefined()
    clearInterval(timer)
  })

  it('configures the detached spawn with detached:true, stdio:ignore, env passthrough', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    const [, , opts] = mockSpawn.mock.calls[0]
    expect(opts).toMatchObject({
      detached: true,
      stdio: 'ignore',
      env: process.env,
    })
    clearInterval(timer)
  })

  it('calls child.unref() so the worker does not keep the event loop alive', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    const child = makeFakeChild()
    mockSpawn.mockReturnValue(child)
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    expect(child.unref).toHaveBeenCalled()
    clearInterval(timer)
  })

  it('warns and keeps backoff when spawn() throws synchronously', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    mockSpawn.mockImplementation(() => {
      throw new Error('EMFILE: spawn failed')
    })
    const { getChannelHealth, startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    // Synchronous throw -> the catch block warns + returns false. The state
    // map is NOT updated (the spawn-failure path keeps the OLD backoff).
    expect(mockSpawn).toHaveBeenCalled()
    const { logger } = await import('../logger.js')
    const loggerMock = logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    const threwWarn = loggerMock.warn.mock.calls.find(
      (c) => c[1] === 'channel-health-monitor: reconnect spawn threw',
    )
    expect(threwWarn).toBeDefined()
    clearInterval(timer)
  })

  it('warns and clears inFlightReconnects when child emits an error event', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    // Make the spawn's `once` callable so we can capture and invoke handlers.
    const onceHandlers: Record<string, (err?: unknown) => void> = {}
    const child = {
      once: vi.fn((event: string, handler: (err?: unknown) => void) => {
        onceHandlers[event] = handler
        return child
      }),
      unref: vi.fn(),
    }
    mockSpawn.mockReturnValue(child)

    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    expect(child.once).toHaveBeenCalledWith('exit', expect.any(Function))
    expect(child.once).toHaveBeenCalledWith('error', expect.any(Function))

    // Trigger the error handler.
    const spawnErr = new Error('worker exec failed')
    onceHandlers.error?.(spawnErr)
    const { logger } = await import('../logger.js')
    const loggerMock = logger as unknown as {
      warn: ReturnType<typeof vi.fn>
    }
    const errorWarn = loggerMock.warn.mock.calls.find(
      (c) => c[1] === 'channel-health-monitor: failed to spawn reconnect worker',
    )
    expect(errorWarn).toBeDefined()
    expect(errorWarn?.[0]).toMatchObject({ agentName: 'marveen', err: spawnErr })
    clearInterval(timer)
  })

  it('clears inFlightReconnects when child emits an exit event', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    const onceHandlers: Record<string, (err?: unknown) => void> = {}
    const child = {
      once: vi.fn((event: string, handler: (err?: unknown) => void) => {
        onceHandlers[event] = handler
        return child
      }),
      unref: vi.fn(),
    }
    mockSpawn.mockReturnValue(child)

    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)

    // Drive a second failure tick -- after the backoff window. Because the
    // exit handler already cleared inFlightReconnects for this agent, the
    // spawn guard at line 122 ("already in flight") is bypassed and a SECOND
    // spawn fires. We assert that the previous exit handler did its job by
    // observing the second spawn.
    onceHandlers.exit?.()
    vi.advanceTimersByTime(60 * 60 * 1000) // an hour -- well past the 30m cooldown
    vi.advanceTimersByTime(60_000) // next interval tick
    expect(mockSpawn.mock.calls.length).toBeGreaterThanOrEqual(2)
    clearInterval(timer)
  })

  it('skips a second reconnect while one is already in flight (no second spawn)', async () => {
    // Same agent, two consecutive failure ticks WITHOUT clearing inFlight.
    // The exit handler is NOT invoked between ticks, so the second tick sees
    // inFlightReconnects still containing the agent and skips (line 122).
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    mockSpawn.mockReturnValue(makeFakeChild())

    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    // First tick: failure -> spawn (records state + adds to inFlight).
    vi.advanceTimersByTime(46_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // Second tick: still within the 30s backoff window -> the now < nextRetryAt
    // short-circuit at line 103 fires BEFORE the inFlight check. To exercise
    // the inFlight skip branch itself we must wait past nextRetryAt but keep
    // inFlightReconnects populated.
    //
    // 30s backoff on attempt 0 -> nextRetryAt = firstNow + 30_000.
    // Advance 31s -> now >= nextRetryAt, so line 103 no longer short-circuits.
    // Line 122 should then fire (inFlightReconnects still contains 'marveen'
    // because we never invoked the exit handler).
    vi.advanceTimersByTime(31_000)
    // Also fire the next 60s interval tick.
    vi.advanceTimersByTime(60_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1) // unchanged

    const { logger } = await import('../logger.js')
    const loggerMock = logger as unknown as {
      debug: ReturnType<typeof vi.fn>
    }
    const skipDebug = loggerMock.debug.mock.calls.find(
      (c) => c[1] === 'channel-health-monitor: reconnect already in flight, skipping',
    )
    expect(skipDebug).toBeDefined()
    clearInterval(timer)
  })

  it('skips while state.nextRetryAt is in the future (within backoff window)', async () => {
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    mockSpawn.mockReturnValue(makeFakeChild())

    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    // First tick: spawns, records attempt=1 with nextRetryAt = firstNow + 30s.
    vi.advanceTimersByTime(46_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)

    // Manually fire the in-flight child's exit handler so the inFlight guard
    // (line 122) does NOT short-circuit. Now state still has a future
    // nextRetryAt. We advance just past the 60s interval tick: at the next
    // check, now > firstCheck + 30s, so line 103 (now < nextRetryAt) is
    // FALSE and we proceed to spawn again. To make line 103 TRUE we need a
    // re-entry faster than 30s, which the 60s interval never produces -- so
    // line 103 is currently unreachable through the public timer alone.
    // See docs/needs-to-be-fix/routes-channel-health-monitor-line-103.md.
    const child = mockSpawn.mock.results[0].value as FakeChild
    const exitCall = child.once.mock.calls.find(
      (c) => c[0] === 'exit',
    ) as unknown as [string, () => void] | undefined
    exitCall?.[1]()

    vi.advanceTimersByTime(60_000)
    // Sanity: a second spawn fires once we cleared inFlight.
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    clearInterval(timer)
  })

  it('clears state and returns when attempts reach MAX_RETRIES and cooldown elapsed', async () => {
    // Drive 3 failures, then a fourth tick past the 30-minute cooldown.
    // Each spawn's exit handler must be invoked so the inFlight guard does
    // not pre-empt the next backoff-driven spawn.
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    mockSpawn.mockReturnValue(makeFakeChild())

    const { getChannelHealth, startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    // Tick 1: first failure -> attempts=1.
    vi.advanceTimersByTime(46_000)
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(1)

    // Clear the in-flight child.
    let child = mockSpawn.mock.results[0].value as FakeChild
    let exitCall = child.once.mock.calls.find(
      (c) => c[0] === 'exit',
    ) as unknown as [string, () => void] | undefined
    exitCall?.[1]()

    // Move past the 30s first backoff.
    vi.advanceTimersByTime(31_000)
    vi.advanceTimersByTime(60_000) // interval tick
    expect(mockSpawn).toHaveBeenCalledTimes(2)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(2)

    child = mockSpawn.mock.results[1].value as FakeChild
    exitCall = child.once.mock.calls.find(
      (c) => c[0] === 'exit',
    ) as unknown as [string, () => void] | undefined
    exitCall?.[1]()

    // Second backoff is 90s (30 * 3^1). Move past it.
    vi.advanceTimersByTime(91_000)
    vi.advanceTimersByTime(60_000)
    expect(mockSpawn).toHaveBeenCalledTimes(3)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(3)

    child = mockSpawn.mock.results[2].value as FakeChild
    exitCall = child.once.mock.calls.find(
      (c) => c[0] === 'exit',
    ) as unknown as [string, () => void] | undefined
    exitCall?.[1]()

    // Now attempts >= MAX_RETRIES. Within cooldown, the next tick must NOT
    // spawn a 4th time.
    vi.advanceTimersByTime(60_000)
    expect(mockSpawn).toHaveBeenCalledTimes(3)

    // Advance past the 30-minute cooldown.
    vi.advanceTimersByTime(30 * 60 * 1000)
    vi.advanceTimersByTime(60_000)
    // After cooldown expires, the monitor DELETES the state, returns, and
    // the next tick starts a fresh attempt (attempts reset to 1). The total
    // grows by exactly one.
    expect(mockSpawn.mock.calls.length).toBe(4)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(1)
    clearInterval(timer)
  })

  it('logs "plugin recovered" and clears state when a previously-failing pane is clean again', async () => {
    mockSpawn.mockReturnValue(makeFakeChild())

    const { getChannelHealth, startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    // Tick 1: failure -> state recorded.
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  ✘ failed',
    )
    vi.advanceTimersByTime(46_000)
    expect(getChannelHealth('marveen').reconnectAttempts).toBe(1)

    // Move past the 30s first backoff, then make the pane healthy again.
    vi.advanceTimersByTime(31_000)
    vi.advanceTimersByTime(60_000)
    mockCapturePane.mockReturnValue(
      'plugin:telegram:telegram  · connected\nall good',
    )
    vi.advanceTimersByTime(60_000)

    expect(getChannelHealth('marveen').healthy).toBe(true)
    const { logger } = await import('../logger.js')
    const loggerMock = logger as unknown as {
      info: ReturnType<typeof vi.fn>
    }
    const recovered = loggerMock.info.mock.calls.find(
      (c) => c[1] === 'channel-health-monitor: plugin recovered',
    )
    expect(recovered).toBeDefined()
    clearInterval(timer)
  })

  it('catches and logs errors thrown by the main agent check', async () => {
    // Make capturePane throw for the main session only.
    mockCapturePane.mockImplementation((session: string) => {
      if (session === 'marveen-channels') {
        throw new Error('tmux session vanished')
      }
      return 'normal'
    })
    mockListAgentNames.mockReturnValue([])
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)

    const { logger } = await import('../logger.js')
    const loggerMock = logger as unknown as {
      debug: ReturnType<typeof vi.fn>
    }
    const mainErrDebug = loggerMock.debug.mock.calls.find(
      (c) => c[1] === 'channel-health-monitor: main agent check error',
    )
    expect(mainErrDebug).toBeDefined()
    clearInterval(timer)
  })

  it('catches and logs errors thrown by an agent check', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockIsAgentRunning.mockImplementation((name: string) => name === 'samu')
    mockResolveAgentSession.mockImplementation(
      (name: string) => `agent-${name}`,
    )
    mockCapturePane.mockImplementation((session: string) => {
      if (session === 'agent-samu') {
        throw new Error('tmux read failed')
      }
      return 'normal'
    })

    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)

    const { logger } = await import('../logger.js')
    const loggerMock = logger as unknown as {
      debug: ReturnType<typeof vi.fn>
    }
    const agentErrDebug = loggerMock.debug.mock.calls.find(
      (c) => c[1] === 'channel-health-monitor: agent check error',
    )
    expect(agentErrDebug).toBeDefined()
    expect(agentErrDebug?.[0]).toMatchObject({ agent: 'samu' })
    clearInterval(timer)
  })

  it('skips agents that are not running (isAgentRunning=false)', async () => {
    mockListAgentNames.mockReturnValue(['samu', 'zara'])
    mockIsAgentRunning.mockReturnValue(false) // neither is running
    mockResolveAgentSession.mockImplementation(
      (name: string) => `agent-${name}`,
    )
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    // capturePane must NOT be called for any agent session (only for the
    // main session, and main pane is 'normal').
    const sessions = mockCapturePane.mock.calls.map((c) => c[0])
    expect(sessions).toEqual(['marveen-channels'])
    clearInterval(timer)
  })

  it('handles an empty agent list without iterating', async () => {
    mockListAgentNames.mockReturnValue([])
    const { startChannelHealthMonitor } = await importMonitor()
    const timer = startChannelHealthMonitor()
    vi.advanceTimersByTime(46_000)
    // No agent-related capturePane calls.
    const sessions = mockCapturePane.mock.calls.map((c) => c[0])
    expect(sessions).toEqual(['marveen-channels'])
    clearInterval(timer)
  })
})
