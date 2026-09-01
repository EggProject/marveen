// Supplementary coverage for src/channel-coordinator.ts: readToken branches,
// transient seed error path, and down-streak-reset path.
//
// Lives in its own file (separate vitest worker) so heap pressure of driving
// main() through these scenarios doesn't compound the OOM seen when many
// main()-invoking tests share one worker.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cc-bs-${stamp}`)
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

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('readToken branches', () => {
  it('throws when neither env nor .env provides TELEGRAM_BOT_TOKEN', async () => {
    const ctx = setupCtx('cc-tok-')
    delete process.env.TELEGRAM_BOT_TOKEN
    const exitCalls: number[] = []
    ctx.exitSpy.mockImplementation(((c?: number) => {
      exitCalls.push(c ?? 0)
    }) as never)
    const m = makeMocks()
    installMocks(m)

    try {
      vi.resetModules()
      await import(SRC)
      await vi.advanceTimersByTimeAsync(50)
      expect(exitCalls).toContain(1)
    } finally {
      teardown()
      rmSync(ctx.stateDir, { recursive: true, force: true })
      process.argv[1] = undefined as unknown as string
    }
  })

  it('reads double-quoted token; skips non-matching keys (else branch)', async () => {
    const ctx = setupCtx('cc-tok-dq-')
    delete process.env.TELEGRAM_BOT_TOKEN
    // OTHER_VAR exercises the key-not-matching else branch.
    writeFileSync(
      join(ctx.stateDir, '.env'),
      '# comment\nNOT_A_LINE\nOTHER_VAR=ignored\nTELEGRAM_BOT_TOKEN="abc"\n',
      { mode: 0o600 },
    )
    const m = makeMocks()
    installMocks(m)

    try {
      await runMain(5000)
      expect(m.initIngestDb).toHaveBeenCalled()
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })

  it('reads single-quoted token (single-quoted AND branch)', async () => {
    const ctx = setupCtx('cc-tok-sq-')
    delete process.env.TELEGRAM_BOT_TOKEN
    // Only single-quoted value present to exercise the single-quoted AND branch.
    writeFileSync(
      join(ctx.stateDir, '.env'),
      "TELEGRAM_BOT_TOKEN='only-single-quoted'\n",
      { mode: 0o600 },
    )
    const m = makeMocks()
    installMocks(m)

    try {
      await runMain(5000)
      expect(m.initIngestDb).toHaveBeenCalled()
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })

  it('reads unquoted token (no-quote else branch)', async () => {
    const ctx = setupCtx('cc-tok-nq-')
    delete process.env.TELEGRAM_BOT_TOKEN
    // Unquoted value exercises the `if (...)` falsy branch (no quote-stripping).
    writeFileSync(
      join(ctx.stateDir, '.env'),
      'TELEGRAM_BOT_TOKEN=no-quotes-value\n',
      { mode: 0o600 },
    )
    const m = makeMocks()
    installMocks(m)

    try {
      await runMain(5000)
      expect(m.initIngestDb).toHaveBeenCalled()
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

describe('runLoop idle -> backfill: transient seed path', () => {
  it('transient seed logs warn + stays idle (err is Error)', async () => {
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

  it('transient seed with non-Error rejection uses String(err) branch', async () => {
    const ctx = setupCtx('cc-seed-str-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(2))
    // Reject with a non-Error value to exercise `String(err)` branch.
    m.probeHighWater.mockRejectedValueOnce('just a string error')
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

describe('down streak reset when probe goes false mid-debounce', () => {
  it('resets downStreak when probe goes false, preventing transition', async () => {
    const ctx = setupCtx('cc-streak-')
    const m = makeMocks()
    let calls = 0
    m.probeNativeChannelDown.mockImplementation(() => {
      calls++
      // DOWN, UP, DOWN -- never reaches DOWN_DEBOUNCE=2.
      return calls === 1 || calls === 3
    })
    installMocks(m)

    try {
      await runMain(15000)
      expect(m.probeHighWater).not.toHaveBeenCalled()
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})
