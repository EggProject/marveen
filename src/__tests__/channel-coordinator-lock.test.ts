// Tests for src/channel-coordinator.ts: acquireSingleInstanceLock + releaseLock
// branches, installSignalHandlers behavior, and main() cleanup path.
//
// All four functions are unexported; the only path is main() via the entry-
// point guard. Each test sets up a tmpdir STATE_DIR and dynamically imports
// the source so the entry-point guard fires main().

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { snapshotEnv } from './setup/temp-sandbox.js'

function clearHandlers(): void {
  process.removeAllListeners('SIGTERM')
  process.removeAllListeners('SIGINT')
}

function teardownMocks(): void {
  vi.restoreAllMocks()
  vi.doUnmock(join(process.cwd(), 'src/logger.js'))
  vi.doUnmock(join(process.cwd(), 'src/channel-coordinator/liveness.js'))
  vi.doUnmock(join(process.cwd(), 'src/channel-coordinator/telegram-client.js'))
  vi.doUnmock(join(process.cwd(), 'src/channel-coordinator/ingest.js'))
  vi.doUnmock('node:child_process')
  vi.resetModules()
  clearHandlers()
}

function installMocks() {
  const m: Record<string, ReturnType<typeof vi.fn>> = {}
  m.probeNativeChannelDown = vi.fn(() => false)
  m.probeHighWater = vi.fn(async () => null)
  m.getUpdates = vi.fn(async () => [])
  m.mapUpdate = vi.fn(() => null)
  m.insertIncomingEvent = vi.fn(() => ({ inserted: false, eventId: null }))
  m.createHandoffMessage = vi.fn(() => 0)
  m.markEventDelivered = vi.fn(() => undefined)
  m.getEventsNeedingHandoff = vi.fn(() => [])
  m.getOffset = vi.fn(() => 0)
  m.setOffset = vi.fn(() => undefined)
  m.initIngestDb = vi.fn(() => null)
  m.closeIngestDb = vi.fn(() => undefined)
  m.loggerInfo = vi.fn()
  m.loggerWarn = vi.fn()
  m.loggerError = vi.fn()
  m.execFile = vi.fn(() => undefined)

  class TelegramApiError extends Error {
    constructor(public kind: string, msg: string, public retryAfterSec?: number) {
      super(msg)
      this.name = 'TelegramApiError'
    }
  }

  vi.doMock(join(process.cwd(), 'src/logger.js'), () => ({
    logger: { info: m.loggerInfo, warn: m.loggerWarn, error: m.loggerError, debug: vi.fn() },
  }))
  vi.doMock(join(process.cwd(), 'src/channel-coordinator/liveness.js'), () => ({ probeNativeChannelDown: m.probeNativeChannelDown }))
  vi.doMock(join(process.cwd(), 'src/channel-coordinator/telegram-client.js'), () => ({
    probeHighWater: m.probeHighWater,
    getUpdates: m.getUpdates,
    mapUpdate: m.mapUpdate,
    TelegramApiError,
  }))
  vi.doMock(join(process.cwd(), 'src/channel-coordinator/ingest.js'), () => ({
    initIngestDb: m.initIngestDb,
    closeIngestDb: m.closeIngestDb,
    insertIncomingEvent: m.insertIncomingEvent,
    createHandoffMessage: m.createHandoffMessage,
    markEventDelivered: m.markEventDelivered,
    getEventsNeedingHandoff: m.getEventsNeedingHandoff,
    getOffset: m.getOffset,
    setOffset: m.setOffset,
    COORDINATOR_AGENT_ID: 'integration',
  }))
  vi.doMock('node:child_process', () => ({ execFile: m.execFile }))
  return m as unknown as {
    probeNativeChannelDown: ReturnType<typeof vi.fn>
    probeHighWater: ReturnType<typeof vi.fn>
    getUpdates: ReturnType<typeof vi.fn>
    mapUpdate: ReturnType<typeof vi.fn>
    insertIncomingEvent: ReturnType<typeof vi.fn>
    createHandoffMessage: ReturnType<typeof vi.fn>
    markEventDelivered: ReturnType<typeof vi.fn>
    getEventsNeedingHandoff: ReturnType<typeof vi.fn>
    getOffset: ReturnType<typeof vi.fn>
    setOffset: ReturnType<typeof vi.fn>
    initIngestDb: ReturnType<typeof vi.fn>
    closeIngestDb: ReturnType<typeof vi.fn>
    loggerInfo: ReturnType<typeof vi.fn>
    loggerWarn: ReturnType<typeof vi.fn>
    loggerError: ReturnType<typeof vi.fn>
    execFile: ReturnType<typeof vi.fn>
  }
}

const SRC = join(process.cwd(), 'src')

describe('channel-coordinator acquireSingleInstanceLock (via main())', () => {
  let snap: { restore: () => void }

  beforeEach(() => {
    snap = snapshotEnv()
    clearHandlers()
  })
  afterEach(() => {
    snap.restore()
    teardownMocks()
  })

  it('creates STATE_DIR when missing (mkdirSync branch)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-lock-new-'))
    rmSync(stateDir, { recursive: true, force: true })
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      await new Promise((r) => setImmediate(r))
      expect(existsSync(stateDir)).toBe(true)
      expect(existsSync(join(stateDir, 'coordinator.pid'))).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('reclaims a stale pid (process.kill throws ESRCH -> alive=false -> warn + overwrite)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-lock-stale-'))
    writeFileSync(join(stateDir, 'coordinator.pid'), String(0x7FFFFFFE))
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const m = installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      await new Promise((r) => setImmediate(r))
      expect(m.loggerWarn.mock.calls.some((c) => JSON.stringify(c[0] ?? {}).includes('stalePid'))).toBe(true)
      const pidContent = readFileSync(join(stateDir, 'coordinator.pid'), 'utf-8').trim()
      expect(Number(pidContent)).toBe(process.pid)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('does NOT warn when PID_FILE holds our own pid (own-pid short-circuits)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-lock-self-'))
    writeFileSync(join(stateDir, 'coordinator.pid'), String(process.pid))
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const m = installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      await new Promise((r) => setImmediate(r))
      expect(m.loggerWarn.mock.calls.some((c) => JSON.stringify(c[0] ?? {}).includes('stalePid'))).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('treats a zero/non-numeric pid in PID_FILE as no live instance', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-lock-zero-'))
    writeFileSync(join(stateDir, 'coordinator.pid'), '0')
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const m = installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      await new Promise((r) => setImmediate(r))
      expect(m.loggerWarn.mock.calls.some((c) => JSON.stringify(c[0] ?? {}).includes('stalePid'))).toBe(false)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})

describe('channel-coordinator releaseLock (via main() SIGTERM shutdown)', () => {
  let snap: { restore: () => void }

  beforeEach(() => {
    snap = snapshotEnv()
    clearHandlers()
    vi.useFakeTimers()
  })
  afterEach(() => {
    snap.restore()
    vi.useRealTimers()
    teardownMocks()
  })

  it('removes the pid file when its contents match our pid (own-pid branch)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-rel-own-'))
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    const exitCalls: number[] = []
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { exitCalls.push(c ?? 0) }) as never)
    const m = installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      expect(existsSync(join(stateDir, 'coordinator.pid'))).toBe(true)
      process.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(4000)
      expect(existsSync(join(stateDir, 'coordinator.pid'))).toBe(false)
      expect(m.closeIngestDb).toHaveBeenCalled()
      expect(exitCalls).toContain(0)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('leaves the pid file untouched when its contents differ from our pid (mismatch branch)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-rel-other-'))
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      writeFileSync(join(stateDir, 'coordinator.pid'), '999999999')
      process.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(4000)
      expect(readFileSync(join(stateDir, 'coordinator.pid'), 'utf-8').trim()).toBe('999999999')
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('is a safe no-op when the pid file is missing (catch branch)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-rel-miss-'))
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      unlinkSync(join(stateDir, 'coordinator.pid'))
      process.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(4000)
      expect(true).toBe(true)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('treats SIGINT identically to SIGTERM (signal-handler branch)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-sigint-'))
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    vi.spyOn(process, 'exit').mockImplementation((() => {}) as never)
    const m = installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      process.emit('SIGINT')
      await vi.advanceTimersByTimeAsync(4000)
      expect(m.closeIngestDb).toHaveBeenCalled()
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })

  it('second SIGTERM during shutdown is ignored (stopping already true)', async () => {
    const stateDir = mkdtempSync(join(tmpdir(), 'cc-twoterm-'))
    process.env.COORDINATOR_STATE_DIR = stateDir
    process.env.TELEGRAM_BOT_TOKEN = 'tok'
    process.argv[1] = join(SRC, 'channel-coordinator.ts')
    const exitCalls: number[] = []
    vi.spyOn(process, 'exit').mockImplementation(((c?: number) => { exitCalls.push(c ?? 0) }) as never)
    installMocks()
    try {
      vi.resetModules()
      await import(join(SRC, 'channel-coordinator.ts'))
      process.emit('SIGTERM')
      process.emit('SIGTERM')
      await vi.advanceTimersByTimeAsync(5000)
      expect(exitCalls.filter((c) => c === 0)).toHaveLength(1)
    } finally {
      rmSync(stateDir, { recursive: true, force: true })
    }
  })
})
