// Channel-coordinator core coverage: live-pid, reconcilePending, idle->backfill
// success/hw-null, and the entry-point catch handler.
//
// The project's bug MD notes that each main() invocation leaves orphan
// Promises on the heap (~10 test ceiling). To stay under that, this file
// contains only ~5 tests. The backfilling/runLoop/processBatch branches
// live in channel-coordinator-runloop-extra.test.ts to keep each worker
// under the OOM threshold.

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
  const dir = join(tmpdir(), `cc-full-${stamp}`)
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

// =============================================================================
// 1. acquireSingleInstanceLock live-pid branch (line 151)
// =============================================================================

describe('acquireSingleInstanceLock: live prev pid branch', () => {
  it('exits with code 1 when a live other process holds the pid file', async () => {
    const ctx = setupCtx('cc-live-')
    writeFileSync(join(ctx.stateDir, 'coordinator.pid'), String(0x7FFFFFFE))
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation(((pid: number) => true) as never)

    const exitCalls: number[] = []
    ctx.exitSpy.mockImplementation(((c?: number) => {
      exitCalls.push(c ?? 0)
    }) as never)

    const m = makeMocks()
    installMocks(m)

    try {
      vi.resetModules()
      await import(SRC)
      expect(exitCalls).toContain(1)
      expect(
        m.loggerError.mock.calls.some((c) =>
          /another live instance/.test(String(c[1] ?? c[0] ?? '')),
        ),
      ).toBe(true)
    } finally {
      killSpy.mockRestore()
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 2. reconcilePending branches (consolidated)
// =============================================================================

describe('reconcilePending: query error + happy + JSON.parse catch + handoff throws', () => {
  it('consolidated branches', async () => {
    const ctx = setupCtx('cc-rec-')
    const m = makeMocks()
    m.getEventsNeedingHandoff
      .mockImplementationOnce(() => {
        throw new Error('SQLITE_BUSY')
      })
      .mockReturnValueOnce([
        {
          id: 7,
          source: 'telegram',
          update_id: 100,
          chat_id: 1,
          user_id: 2,
          username: 'szabi',
          message_id: 50,
          kind: 'message',
          content: 'hello',
          meta: JSON.stringify({ voice: { file_id: 'voice-1' } }),
          tg_date: 1700000000,
          status: 'pending',
          agent_message_id: null,
          error: null,
          created_at: 1700000000,
          delivered_at: null,
        },
        {
          id: 8,
          source: 'telegram',
          update_id: 200,
          chat_id: 1,
          user_id: 2,
          username: 'szabi',
          message_id: 60,
          kind: 'message',
          content: 'plain',
          meta: '{ not valid json',
          tg_date: 1700000000,
          status: 'pending',
          agent_message_id: null,
          error: null,
          created_at: 1700000000,
          delivered_at: null,
        },
      ])
      .mockReturnValue([])
    let handoffCall = 0
    m.createHandoffMessage.mockImplementation(() => {
      handoffCall++
      if (handoffCall === 2) throw new Error('db locked')
      return 1000 + handoffCall
    })
    installMocks(m)

    try {
      // advance(5000) -> 2 reconcilePending calls (initial + post-sleep)
      await runMain(5000)
      expect(findLog(m.loggerError, 'reconcile query failed')).toBe(true)
      expect(m.createHandoffMessage).toHaveBeenCalledTimes(2)
      expect(m.markEventDelivered).toHaveBeenCalledTimes(1)
      expect(findLog(m.loggerError, 'reconcile re-handoff failed')).toBe(true)
      expect(findLog(m.loggerWarn, 're-queued abandoned')).toBe(true)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 3. runLoop idle -> backfill: success + hw=null
// =============================================================================

describe('runLoop idle -> backfill: success + hw=null', () => {
  it('success: setOffset called with hw value; hw=null: skip setOffset', async () => {
    const ctx = setupCtx('cc-seed-ok-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(2))
    m.probeHighWater.mockResolvedValue(999)
    installMocks(m)

    try {
      await runMain(11000)
      expect(m.probeHighWater).toHaveBeenCalledTimes(1)
      expect(m.setOffset).toHaveBeenCalledWith('telegram', 999)
      expect(findLog(m.loggerWarn, 'native channel DOWN')).toBe(true)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})

// =============================================================================
// 4. entry-point catch handler (lines 436-439)
// =============================================================================

describe('entry-point catch handler', () => {
  it('logs and exits(1) when main() throws (readToken path)', async () => {
    const ctx = setupCtx('cc-catch-')
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.COORDINATOR_STATE_DIR

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
      expect(findLog(m.loggerError, 'channel-coordinator: crashed')).toBe(true)
    } finally {
      teardown()
      rmSync(ctx.stateDir, { recursive: true, force: true })
      process.argv[1] = undefined
    }
  })
})
