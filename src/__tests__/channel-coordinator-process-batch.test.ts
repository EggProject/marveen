// processBatch branch coverage (lines 233-258 of src/channel-coordinator.ts).
// Lives in its own file (separate vitest worker) so the heap pressure of
// driving main() through the 5 batch branches (mapUpdate null, insert throws,
// dedup, happy, handoff throws) doesn't compound the OOM.

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
  const dir = join(tmpdir(), `cc-pb1-${stamp}`)
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

function eventFor(updateId: number, chatId = 1) {
  return {
    update_id: updateId,
    kind: 'message' as const,
    chat_id: chatId,
    user_id: chatId,
    username: 'u',
    message_id: updateId,
    content: `msg ${updateId}`,
    meta: {},
    tg_date: 1700000000,
  }
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

describe('processBatch branches via runLoop backfilling', () => {
  it('mapUpdate null + insert throws + dedup + happy + handoff throws', async () => {
    const ctx = setupCtx('cc-pb-')
    const m = makeMocks()
    m.probeNativeChannelDown.mockImplementation(probeTrueThenFalse(12))
    m.probeHighWater.mockResolvedValue(null)
    // Five distinct batches to exercise every processBatch branch.
    m.getUpdates
      .mockResolvedValueOnce([{ update_id: 555, message: {} }])
      .mockResolvedValueOnce([{ update_id: 100, message: {} }])
      .mockResolvedValueOnce([{ update_id: 200, message: {} }])
      .mockResolvedValueOnce([
        { update_id: 300, message: {} },
        { update_id: 301, message: {} },
      ])
      .mockResolvedValueOnce([{ update_id: 400, message: {} }])
      .mockResolvedValue([])

    m.mapUpdate.mockImplementation((u: { update_id: number }) => {
      if (u.update_id === 555) return null
      return eventFor(u.update_id)
    })
    let insertCount = 0
    m.insertIncomingEvent.mockImplementation(() => {
      insertCount++
      if (insertCount === 2) throw new Error('SQLITE_BUSY')
      if (insertCount === 3) return { inserted: false, eventId: null }
      return { inserted: true, eventId: 1000 + insertCount }
    })
    let handoffCount = 0
    m.createHandoffMessage.mockImplementation(() => {
      handoffCount++
      // 3 handoffs total: batch 2, batch 4 event 2, batch 5.
      // Throw on the 3rd to exercise the handoff-failed branch.
      if (handoffCount === 3) throw new Error('agent_messages insert failed')
      return 2000 + handoffCount
    })
    installMocks(m)

    try {
      await runMain(11000)
      expect(findLog(m.loggerInfo, 'backfilled to main agent')).toBe(true)
      expect(findLog(m.loggerError, 'insertIncomingEvent failed')).toBe(true)
      expect(findLog(m.loggerError, 'handoff failed')).toBe(true)
      expect(m.setOffset).toHaveBeenCalledWith('telegram', 555)
      expect(m.setOffset).toHaveBeenCalledWith('telegram', 100)
      expect(m.setOffset).toHaveBeenCalledWith('telegram', 200)
      expect(m.setOffset).toHaveBeenCalledWith('telegram', 301)
      expect(m.setOffset).toHaveBeenCalledWith('telegram', 400)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})
