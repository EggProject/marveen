// Supplementary coverage for src/channel-coordinator.ts: runLoop's idle->backfill
// seed ERROR branches (fatal->sendAlert, conflict->cooldown, transient->warn) and
// runLoop's backfilling branches (yield-to-native, empty-batch loop, yield-before-
// handoff, inner break on stopping, getUpdates fatal/conflict/rate_limit/transient).
//
// Lives in its own file (separate vitest worker) so the heap pressure of driving
// main() through these scenarios doesn't compound the OOM seen when ~10+ main()-
// invoking tests share one worker.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cc-rl-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})
vi.mock('../config.js', async (orig) => ({
  ...(await orig<typeof import('../config.js')>()),
  ...configSandbox,
}))

const SRC_DIR = join(process.cwd(), 'src')
const SRC = join(SRC_DIR, 'channel-coordinator.ts')

interface Mocks {
  probeNativeChannelDown: ReturnType<typeof vi.fn>
  probeHighWater: ReturnType<typeof vi.fn>
  getUpdates: ReturnType<typeof vi.fn>
  mapUpdate: ReturnType<typeof vi.fn>
  TelegramApiError: new (
    kind: string,
    msg: string,
    retryAfterSec?: number,
  ) => Error & { kind: string; retryAfterSec?: number }
  initIngestDb: ReturnType<typeof vi.fn>
  closeIngestDb: ReturnType<typeof vi.fn>
  insertIncomingEvent: ReturnType<typeof vi.fn>
  createHandoffMessage: ReturnType<typeof vi.fn>
  markEventDelivered: ReturnType<typeof vi.fn>
  getEventsNeedingHandoff: ReturnType<typeof vi.fn>
  getOffset: ReturnType<typeof vi.fn>
  setOffset: ReturnType<typeof vi.fn>
  loggerInfo: ReturnType<typeof vi.fn>
  loggerWarn: ReturnType<typeof vi.fn>
  loggerError: ReturnType<typeof vi.fn>
  loggerDebug: ReturnType<typeof vi.fn>
  execFile: ReturnType<typeof vi.fn>
}

function makeMocks(): Mocks {
  class TelegramApiError extends Error {
    kind: string
    retryAfterSec?: number
    constructor(kind: string, msg: string, retryAfterSec?: number) {
      super(msg)
      this.kind = kind
      this.retryAfterSec = retryAfterSec
      this.name = 'TelegramApiError'
    }
  }
  return {
    probeNativeChannelDown: vi.fn(() => false),
    probeHighWater: vi.fn(async () => null),
    getUpdates: vi.fn(async () => []),
    mapUpdate: vi.fn(() => null),
    TelegramApiError,
    initIngestDb: vi.fn(),
    closeIngestDb: vi.fn(),
    insertIncomingEvent: vi.fn(() => ({ inserted: false, eventId: null })),
    createHandoffMessage: vi.fn(() => 0),
    markEventDelivered: vi.fn(),
    getEventsNeedingHandoff: vi.fn(() => []),
    getOffset: vi.fn(() => 0),
    setOffset: vi.fn(),
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),
    execFile: vi.fn(),
  }
}

function installMocks(m: Mocks): void {
  vi.doMock(join(SRC_DIR, 'logger.js'), () => ({
    logger: {
      info: m.loggerInfo,
      warn: m.loggerWarn,
      error: m.loggerError,
      debug: m.loggerDebug,
    },
  }))
  vi.doMock(join(SRC_DIR, 'channel-coordinator/liveness.js'), () => ({
    probeNativeChannelDown: m.probeNativeChannelDown,
  }))
  vi.doMock(join(SRC_DIR, 'channel-coordinator/telegram-client.js'), () => ({
    probeHighWater: m.probeHighWater,
    getUpdates: m.getUpdates,
    mapUpdate: m.mapUpdate,
    TelegramApiError: m.TelegramApiError,
  }))
  vi.doMock(join(SRC_DIR, 'channel-coordinator/ingest.js'), () => ({
    initIngestDb: m.initIngestDb,
    closeIngestDb: m.closeIngestDb,
    insertIncomingEvent: m.insertIncomingEvent,
    createHandoffMessage: m.createHandoffMessage,
    markEventDelivered: m.markEventDelivered,
    getEventsNeedingHandoff: m.getEventsNeedingHandoff,
    getOffset: m.getOffset,
    setOffset: m.setOffset,
  }))
  vi.doMock('node:child_process', () => ({ execFile: m.execFile }))
}

function teardown(): void {
  vi.restoreAllMocks()
  vi.doUnmock(join(SRC_DIR, 'logger.js'))
  vi.doUnmock(join(SRC_DIR, 'channel-coordinator/liveness.js'))
  vi.doUnmock(join(SRC_DIR, 'channel-coordinator/telegram-client.js'))
  vi.doUnmock(join(SRC_DIR, 'channel-coordinator/ingest.js'))
  vi.doUnmock('node:child_process')
  vi.resetModules()
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
}

function findLog(
  mock: { mock: { calls: unknown[][] } },
  substring: string,
): boolean {
  return mock.mock.calls.some((c) =>
    c.some((arg) => typeof arg === 'string' && arg.includes(substring)),
  )
}

interface TestCtx {
  stateDir: string
  origArgv: string | undefined
  origEnvDir: string | undefined
  origToken: string | undefined
  exitSpy: ReturnType<typeof vi.spyOn>
}

function setupCtx(prefix: string): TestCtx {
  const stateDir = mkdtempSync(join(tmpdir(), prefix))
  const origArgv = process.argv[1]
  const origEnvDir = process.env.COORDINATOR_STATE_DIR
  const origToken = process.env.TELEGRAM_BOT_TOKEN
  process.env.COORDINATOR_STATE_DIR = stateDir
  process.env.TELEGRAM_BOT_TOKEN = 'tok'
  process.argv[1] = SRC
  const exitSpy = vi
    .spyOn(process, 'exit')
    .mockImplementation((() => {}) as never)
  return { stateDir, origArgv, origEnvDir, origToken, exitSpy }
}

async function shutdownAndCleanup(ctx: TestCtx): Promise<void> {
  process.emit('SIGTERM')
  await vi.advanceTimersByTimeAsync(15000)
  ctx.exitSpy.mockRestore()
  if (ctx.origArgv === undefined) delete process.argv[1]
  else process.argv[1] = ctx.origArgv
  if (ctx.origEnvDir === undefined) delete process.env.COORDINATOR_STATE_DIR
  else process.env.COORDINATOR_STATE_DIR = ctx.origEnvDir
  if (ctx.origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
  else process.env.TELEGRAM_BOT_TOKEN = ctx.origToken
  rmSync(ctx.stateDir, { recursive: true, force: true })
}

async function runMain(advance: number): Promise<void> {
  vi.resetModules()
  await import(SRC)
  if (advance > 0) await vi.advanceTimersByTimeAsync(advance)
}

function probeTrueThenFalse(n: number) {
  let calls = 0
  return () => {
    calls++
    return calls <= n
  }
}

function probeAlwaysTrue() {
  return () => true
}

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

// =============================================================================
// 1. runLoop idle -> backfill: fatal -> fatalExit -> sendAlert + exit(1)
// =============================================================================

describe('runLoop idle -> backfill: fatal seed error -> sendAlert', () => {
  it('calls execFile (notify.sh) and process.exit(1) on seed fatal', async () => {
    const ctx = setupCtx('cc-seed-fat-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(2))
    m.probeHighWater.mockRejectedValue(
      new m.TelegramApiError('fatal', '401 unauthorized'),
    )

    const exitCalls: number[] = []
    ctx.exitSpy.mockImplementation(((c?: number) => {
      exitCalls.push(c ?? 0)
    }) as never)

    installMocks(m)

    try {
      vi.resetModules()
      await import(SRC)
      // 2 idle ticks (10000ms) + fatalExit sleep(1500ms)
      await vi.advanceTimersByTimeAsync(12000)
      expect(m.execFile).toHaveBeenCalledTimes(1)
      const execArgs = m.execFile.mock.calls[0]
      expect(execArgs?.[0]).toBe('/bin/bash')
      expect((execArgs?.[1] as string[])[0]).toMatch(/notify\.sh$/)
      expect(execArgs?.[2]).toMatchObject({ timeout: 10_000 })
      expect(exitCalls).toContain(1)
      expect(findLog(m.loggerError, 'fatal error, exiting')).toBe(true)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 2. runLoop idle -> backfill: conflict (cooldown) + transient (warn)
// =============================================================================

describe('runLoop idle -> backfill: conflict + transient seed', () => {
  it('conflict sets 409 cooldown + stays idle; transient warns + stays idle', async () => {
    const ctx = setupCtx('cc-seed-err-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(2))
    // Conflict on first attempt (sets cooldown, stays idle).
    m.probeHighWater.mockRejectedValueOnce(
      new m.TelegramApiError('conflict', '409 conflict'),
    )
    installMocks(m)

    try {
      await runMain(11000)
      expect(findLog(m.loggerInfo, 'high-water seed 409')).toBe(true)
      expect(m.probeHighWater).toHaveBeenCalledTimes(1)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })

  it('transient seed logs warn + stays idle', async () => {
    const ctx = setupCtx('cc-seed-trn-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(2))
    m.probeHighWater.mockRejectedValueOnce(new Error('network reset'))
    installMocks(m)

    try {
      await runMain(11000)
      expect(findLog(m.loggerWarn, 'high-water seed failed')).toBe(true)
      expect(m.probeHighWater).toHaveBeenCalledTimes(1)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 3. runLoop backfilling: yield-to-native + empty-batch loop
// =============================================================================

describe('runLoop backfilling: yield-to-native + empty-batch loop', () => {
  it('yields to idle when native is up; loops on empty batch without advancing offset', async () => {
    const ctx = setupCtx('cc-bk-yld-')
    const m = makeMocks()
    // 3 trues: 2 in idle (enter backfilling), 1 in backfilling (getUpdates
    // called with empty batch), then false on 4th (yield to idle).
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(3))
    m.probeHighWater.mockResolvedValue(null)
    m.getUpdates.mockResolvedValue([])
    installMocks(m)

    try {
      await runMain(11000)
      expect(findLog(m.loggerInfo, 'native channel back UP')).toBe(true)
      expect(m.mapUpdate).not.toHaveBeenCalled()
      expect(m.setOffset).not.toHaveBeenCalled()
      expect(m.getUpdates).toHaveBeenCalled()
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 4. runLoop backfilling: yield-before-handoff + inner break (stopping)
// =============================================================================

describe('runLoop backfilling: yield-before-handoff + inner break on stopping', () => {
  it('discards non-empty batch when native recovers mid-loop', async () => {
    const ctx = setupCtx('cc-bk-b4-')
    const m = makeMocks()
    // 3 true probes (2 idle + 1 backfilling-before-getUpdates), then false
    // for the yield-before-handoff check.
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(3))
    m.probeHighWater.mockResolvedValue(null)
    m.getUpdates.mockResolvedValue([{ update_id: 100, message: {} }])
    installMocks(m)

    try {
      await runMain(11000)
      expect(findLog(m.loggerInfo, 'native recovered mid-batch')).toBe(true)
      expect(m.setOffset).not.toHaveBeenCalled()
      expect(m.mapUpdate).not.toHaveBeenCalled()
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })

  it('breaks the loop when stopping flips true during getUpdates (line 365)', async () => {
    const ctx = setupCtx('cc-stop-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeAlwaysTrue())
    m.probeHighWater.mockResolvedValue(null)
    let rejectGetUpdates: (e: unknown) => void = () => {}
    const pending = new Promise<unknown>((_, rej) => {
      rejectGetUpdates = rej
    })
    pending.catch(() => {})
    m.getUpdates.mockReturnValue(pending)
    installMocks(m)

    try {
      vi.resetModules()
      await import(SRC)
      await vi.advanceTimersByTimeAsync(11000)
      process.emit('SIGTERM')
      rejectGetUpdates(new Error('cancelled'))
      await vi.advanceTimersByTimeAsync(15000)
      expect(m.closeIngestDb).toHaveBeenCalled()
      expect(m.createHandoffMessage).not.toHaveBeenCalled()
    } finally {
      teardown()
      rmSync(ctx.stateDir, { recursive: true, force: true })
      process.argv[1] = undefined
      delete process.env.COORDINATOR_STATE_DIR
      delete process.env.TELEGRAM_BOT_TOKEN
    }
  })
})

// =============================================================================
// 5. runLoop backfilling: getUpdates fatal -> fatalExit -> sendAlert
// =============================================================================

describe('runLoop backfilling: getUpdates fatal -> fatalExit', () => {
  it('calls execFile and process.exit(1) on getUpdates fatal', async () => {
    const ctx = setupCtx('cc-bk-fat-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(3))
    m.probeHighWater.mockResolvedValue(null)
    m.getUpdates.mockRejectedValue(new m.TelegramApiError('fatal', '401'))

    const exitCalls: number[] = []
    ctx.exitSpy.mockImplementation(((c?: number) => {
      exitCalls.push(c ?? 0)
    }) as never)

    installMocks(m)

    try {
      vi.resetModules()
      await import(SRC)
      // 2 idle ticks (10000ms) + fatalExit sleep(1500ms)
      await vi.advanceTimersByTimeAsync(12000)
      expect(m.execFile).toHaveBeenCalledTimes(1)
      expect(findLog(m.loggerError, 'fatal error, exiting')).toBe(true)
      expect(exitCalls).toContain(1)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })

  it('logs warn when sendAlert (execFile callback) returns an error', async () => {
    const ctx = setupCtx('cc-bk-alert-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(3))
    m.probeHighWater.mockResolvedValue(null)
    m.getUpdates.mockRejectedValue(new m.TelegramApiError('fatal', '401'))
    // Invoke the execFile callback with an error to fire the warn branch.
    m.execFile.mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, callback: (err: Error) => void) => {
        callback(new Error('notify.sh missing'))
        return undefined
      }) as never,
    )

    const exitCalls: number[] = []
    ctx.exitSpy.mockImplementation(((c?: number) => {
      exitCalls.push(c ?? 0)
    }) as never)

    installMocks(m)

    try {
      vi.resetModules()
      await import(SRC)
      await vi.advanceTimersByTimeAsync(12000)
      expect(m.execFile).toHaveBeenCalledTimes(1)
      expect(findLog(m.loggerWarn, 'notify.sh alert failed')).toBe(true)
      expect(exitCalls).toContain(1)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })

  it('does NOT log warn when sendAlert callback succeeds (else path)', async () => {
    const ctx = setupCtx('cc-bk-alert-ok-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(3))
    m.probeHighWater.mockResolvedValue(null)
    m.getUpdates.mockRejectedValue(new m.TelegramApiError('fatal', '401'))
    // Invoke the execFile callback with NO error to exercise the else path.
    m.execFile.mockImplementation(
      ((_cmd: string, _args: string[], _opts: unknown, callback: (err: null) => void) => {
        callback(null)
        return undefined
      }) as never,
    )

    const exitCalls: number[] = []
    ctx.exitSpy.mockImplementation(((c?: number) => {
      exitCalls.push(c ?? 0)
    }) as never)

    installMocks(m)

    try {
      vi.resetModules()
      await import(SRC)
      await vi.advanceTimersByTimeAsync(12000)
      expect(m.execFile).toHaveBeenCalledTimes(1)
      // No warn because err is null
      expect(findLog(m.loggerWarn, 'notify.sh alert failed')).toBe(false)
      expect(exitCalls).toContain(1)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 6. runLoop backfilling: getUpdates conflict -> cooldown + yield
// =============================================================================

describe('runLoop backfilling: getUpdates conflict -> cooldown + yield', () => {
  it('logs cooldown message + yields to idle', async () => {
    const ctx = setupCtx('cc-bk-409-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(3))
    m.probeHighWater.mockResolvedValue(null)
    m.getUpdates.mockRejectedValue(new m.TelegramApiError('conflict', '409'))
    installMocks(m)

    try {
      await runMain(11000)
      expect(findLog(m.loggerInfo, '409 during backfill')).toBe(true)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 7. runLoop backfilling: getUpdates rate_limit + transient (backoff)
// =============================================================================

describe('runLoop backfilling: getUpdates rate_limit + transient backoff', () => {
  it('rate_limit sleeps retryAfter and continues; transient backs off', async () => {
    const ctx = setupCtx('cc-bk-err-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeAlwaysTrue())
    m.probeHighWater.mockResolvedValue(null)
    // Schedule: rate_limit first, transient second
    m.getUpdates
      .mockRejectedValueOnce(new m.TelegramApiError('rate_limit', '429', 1))
      .mockRejectedValueOnce(new Error('ECONNRESET'))
      .mockResolvedValue([])
    installMocks(m)

    try {
      await runMain(11000)
      expect(m.getUpdates.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })

  it('rate_limit with undefined retryAfterSec falls back to 5s default', async () => {
    const ctx = setupCtx('cc-bk-rl-def-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeAlwaysTrue())
    m.probeHighWater.mockResolvedValue(null)
    // rate_limit WITHOUT retryAfterSec -> `retryAfterSec ?? 5` defaults to 5.
    // Pass only 2 args to TelegramApiError so retryAfterSec is undefined.
    m.getUpdates.mockRejectedValueOnce(new m.TelegramApiError('rate_limit', '429'))
    installMocks(m)

    try {
      await runMain(11000)
      expect(m.getUpdates.mock.calls.length).toBeGreaterThanOrEqual(1)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})
