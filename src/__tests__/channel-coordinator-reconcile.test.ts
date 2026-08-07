// reconcilePending branch coverage (lines 270-298 of src/channel-coordinator.ts):
// query error branch (line 275-276) + happy path + JSON.parse catch (line 281) +
// createHandoffMessage throw branch (line 294).
//
// Lives in its own file (separate vitest worker) so the heap pressure of
// driving main() through these scenarios doesn't compound the OOM seen when
// many main()-invoking tests share one worker.

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
  const dir = join(tmpdir(), `cc-rec-${stamp}`)
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

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('reconcilePending branches', () => {
  it('query error: logs and returns; happy path: re-handoff with JSON.parse catch + handoff throws', async () => {
    const ctx = setupCtx('cc-rec-')
    const m = makeMocks()
    // First reconcilePending call: query throws -> catch + return (line 275-276).
    // Second call: return 2 events:
    //   - event 7: valid JSON meta, createHandoffMessage returns ok (happy path).
    //   - event 8: invalid JSON meta -> inner catch (line 281), createHandoffMessage throws (line 294).
    // Third call+: return [].
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
        {
          // null meta -> exercises `if (ev.meta)` falsy branch
          // content=null -> exercises `ev.content ?? ''` falsy branch
          id: 9,
          source: 'telegram',
          update_id: 300,
          chat_id: 1,
          user_id: 2,
          username: 'szabi',
          message_id: 70,
          kind: 'message',
          content: null,
          meta: null,
          tg_date: 1700000000,
          status: 'pending',
          agent_message_id: null,
          error: null,
          created_at: 1700000000,
          delivered_at: null,
        },
      ])
      .mockReturnValue([])
    // Throw on the 2nd createHandoffMessage invocation (per-event handoff error).
    let handoffCall = 0
    m.createHandoffMessage.mockImplementation(() => {
      handoffCall++
      if (handoffCall === 2) throw new Error('db locked')
      return 1000 + handoffCall
    })
    installMocks(m)

    try {
      // advance(5000) -> 2 reconcilePending calls
      await runMain(5000)
      expect(findLog(m.loggerError, 'reconcile query failed')).toBe(true)
      // 3 events processed: 2 successful handoffs + 1 throw on the 2nd.
      expect(m.createHandoffMessage).toHaveBeenCalledTimes(3)
      expect(m.markEventDelivered).toHaveBeenCalledTimes(2)
      expect(findLog(m.loggerError, 'reconcile re-handoff failed')).toBe(true)
      expect(findLog(m.loggerWarn, 're-queued abandoned')).toBe(true)
    } finally {
      await shutdownAndCleanup(ctx)
      teardown()
    }
  })
})
