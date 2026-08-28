import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ----------------------------------------------------------------------------
// reconnect-cli.ts is a thin CLI shim: argv -> attemptChannelMcpReconnect
// -> process.exit. 100% coverage requires every branch of the binary
// control flow (missing arg / ok:true / ok:false / thrown / ternary both
// arms).
//
// The module has NO entry-point guard -- its body runs the moment the
// module is first imported. We exploit vi.resetModules() between tests
// so each test re-imports a fresh copy with its own argv.
//
// vi.mock child_process (per the per-suite mock template) and the inner
// reconnect helper so we can drive each branch without forking tmux/ssh
// for real. The success/failure/throw ternary AND the catch block are all
// observable through the spy-instrumented `process.exit` and the logger
// hooks; assertions match on the LAST invocation's signal so any
// incidental prepass noise from vitest's coverage loader does not race
// the test's argv-driven run.
// ----------------------------------------------------------------------------

const {
  mockAttemptChannelMcpReconnect,
  mockLogger,
} = vi.hoisted(() => ({
  mockAttemptChannelMcpReconnect: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('../web/channel-mcp-reconnect.js', () => ({
  attemptChannelMcpReconnect: mockAttemptChannelMcpReconnect,
}))

vi.mock('../logger.js', () => ({
  logger: mockLogger,
}))

interface Observation {
  exitCodes: number[]
  attemptCalls: unknown[][]
  infoCalls: unknown[][]
  errorCalls: unknown[][]
  consoleErrorCalls: unknown[][]
}

async function observeReconnectCli(
  agentName: string | undefined,
  mockResult?: { ok: boolean; message: string } | Error,
): Promise<Observation> {
  // mockImplementation is required -- a plain spy delegates to the real
  // process.exit, which vitest refuses to allow in the worker (it would
  // tear down the whole process). Our override is a no-op so vi's
  // built-in call recorder captures the exit code without the worker
  // dying.
  vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never)

  // Reset the module registry so any cached copy from earlier in the
  // suite (vitest's coverage prepass included) does not survive into
  // this import.
  vi.resetModules()

  if (agentName === undefined) {
    process.argv = ['node', 'reconnect-cli.js']
  } else {
    process.argv = ['node', 'reconnect-cli.js', agentName]
  }

  if (mockResult instanceof Error) {
    mockAttemptChannelMcpReconnect.mockImplementation(() => {
      throw mockResult
    })
  } else if (mockResult) {
    mockAttemptChannelMcpReconnect.mockImplementation(() => mockResult)
  } else {
    mockAttemptChannelMcpReconnect.mockReset()
  }

  // Await so the top-level body of reconnect-cli has run before we
  // assert. The body is synchronous inside the module but `import()`
  // is always a microtask; without the await the spy call records
  // would land AFTER the assertions execute -- and the unhandled
  // process.exit rejection would fire before the test even exits.
  await import('../web/reconnect-cli.js')

  const exitCodes = vi
    .mocked(process.exit)
    .mock.calls.map((c) => c[0] as number)

  const consoleErrorMock = (
    console.error as unknown as { mock?: { calls: unknown[][] } }
  ).mock

  return {
    exitCodes,
    attemptCalls: mockAttemptChannelMcpReconnect.mock.calls,
    infoCalls: mockLogger.info.mock.calls,
    errorCalls: mockLogger.error.mock.calls,
    consoleErrorCalls: consoleErrorMock?.calls ?? [],
  }
}

describe('reconnect-cli', () => {
  let origArgv: string[]

  beforeEach(() => {
    // resetModules first so any prior import of reconnect-cli (vitest's
    // own module-graph pass to wire coverage + sourcemaps can pre-load
    // it) is purged, letting the dynamic import in observeReconnectCli
    // truly run the body fresh with the argv WE control.
    vi.resetModules()
    vi.clearAllMocks()
    origArgv = process.argv
    vi.spyOn(console, 'error').mockImplementation(() => {})
  })

  afterEach(() => {
    process.argv = origArgv
    vi.resetModules()
    vi.restoreAllMocks()
  })

  it('prints to stderr and exits 2 when no agentName argument is supplied', async () => {
    const obs = await observeReconnectCli(undefined)

    // The !agentName branch must fire at least once: console.error +
    // process.exit(2).
    expect(obs.consoleErrorCalls).toContainEqual([
      'reconnect-cli: missing agentName argument',
    ])
    expect(obs.exitCodes).toContain(2)
  })

  it('exits 0 and logs info when attemptChannelMcpReconnect returns ok:true', async () => {
    const obs = await observeReconnectCli('samu', {
      ok: true,
      message: 'Activated Reconnect via /mcp (Up x2)',
    })

    // The reconnect helper was invoked with samu at least once (the
    // run driven by this test's argv).
    expect(obs.attemptCalls).toContainEqual(['samu'])

    // The info-log path must fire at least once with the ok:true
    // payload -- that is the success branch's only signal.
    expect(obs.infoCalls).toContainEqual([
      {
        agentName: 'samu',
        ok: true,
        message: 'Activated Reconnect via /mcp (Up x2)',
      },
      'reconnect-cli: reconnect attempt finished',
    ])

    // Exit code 0 (ok:true ternary branch) fired.
    expect(obs.exitCodes).toContain(0)
    expect(obs.errorCalls).toHaveLength(0)
  })

  it('exits 1 and logs info when attemptChannelMcpReconnect returns ok:false', async () => {
    const obs = await observeReconnectCli('zara', {
      ok: false,
      message: 'Pane busy -- reconnect deferred',
    })

    expect(obs.attemptCalls).toContainEqual(['zara'])
    // The info log is the success-path hook; on ok:false it still runs
    // (with ok:false in the payload) and the ternary picks exit(1).
    expect(obs.infoCalls).toContainEqual([
      {
        agentName: 'zara',
        ok: false,
        message: 'Pane busy -- reconnect deferred',
      },
      'reconnect-cli: reconnect attempt finished',
    ])
    expect(obs.exitCodes).toContain(1)
    expect(obs.errorCalls).toHaveLength(0)
  })

  it('catches a thrown error, logs it, and exits 1', async () => {
    const thrown = new Error('tmux binary not found')
    const obs = await observeReconnectCli('marveen', thrown)

    expect(obs.attemptCalls).toContainEqual(['marveen'])
    // The catch branch logs at error level and exits 1; no info log on
    // the thrown path.
    expect(obs.errorCalls.length).toBeGreaterThanOrEqual(1)
    const matchingErrorCall = obs.errorCalls.find(
      ([payload]) =>
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { agentName?: unknown }).agentName === 'marveen' &&
        (payload as { err?: unknown }).err === thrown,
    )
    expect(matchingErrorCall).toBeDefined()
    expect(matchingErrorCall?.[1]).toBe(
      'reconnect-cli: reconnect attempt threw',
    )
    expect(obs.exitCodes).toContain(1)
    // The success info log must NOT fire on a thrown path.
    const samuInfo = obs.infoCalls.find(
      ([payload]) =>
        typeof payload === 'object' &&
        payload !== null &&
        (payload as { agentName?: unknown }).agentName === 'marveen',
    )
    expect(samuInfo).toBeUndefined()
  })
})
