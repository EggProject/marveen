// acquireSingleInstanceLock live-pid branch coverage (lines 150-151 of
// src/channel-coordinator.ts). When the PID file is held by a live other
// process (process.kill succeeds), the coordinator logs and exits with 1.
//
// Lives in its own file (separate vitest worker) so the heap pressure of
// driving main() doesn't compound the OOM seen when many main()-invoking
// tests share one worker.

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
  const dir = join(tmpdir(), `cc-live-${stamp}`)
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

beforeEach(() => {
  vi.useFakeTimers()
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

describe('acquireSingleInstanceLock: live prev pid branch', () => {
  it('exits with code 1 when a live other process holds the pid file', async () => {
    const ctx = setupCtx('cc-live-')
    writeFileSync(join(ctx.stateDir, 'coordinator.pid'), String(0x7FFFFFFE))
    // Simulate a live prev pid by making process.kill signal-able.
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
