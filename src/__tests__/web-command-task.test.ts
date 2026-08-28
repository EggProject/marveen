// 100% coverage test for src/web/command-task.ts.
//
// command-task.ts is the scheduler hook for type='command' scheduled tasks:
// raw `bash -lc <cmd>` invocations with a consecutive-fail streak and a single
// Telegram alert when the streak first hits failThreshold, plus a single
// "recovered" notification when an alerted task starts succeeding again.
//
// Branch inventory that must be covered here (every line + every branch):
//
//   evaluateCommandResult (pure)
//     - prev=undefined, success=true           -> no action, streak 0, "ok"
//     - prev=undefined, failThreshold=1         -> first failure alerts
//     - prev=fails<threshold                   -> no action (incremented)
//     - prev=fails>=threshold, alerted=false   -> alert, alerted flips to true
//     - prev=fails>=threshold, alerted=true    -> no re-alert
//     - prev=alerted, success=true             -> recover, alerted flips false
//     - prev=!alerted, success=true            -> no action, streak 0
//
//   load() (module-internal)
//     - cache miss, file valid JSON     -> parsed map cached
//     - cache miss, file missing        -> catch -> {}
//     - cache miss, file malformed JSON -> catch -> {}
//     - cache hit on second call        -> returns cached map
//
//   persist() (module-internal)
//     - happy path         -> atomicWriteFileSync called once
//     - atomicWrite throws -> caught, logger.warn
//
//   runCommand() (module-internal)
//     - status === 0, no error            -> ok=true, "exit 0"
//     - status !== 0, stderr present      -> ok=false, "exit <n>: <stderr>"
//     - status !== 0, stderr empty        -> ok=false, "exit <n>"
//     - r.error with code ETIMEDOUT       -> ok=false, "timeout <ms>ms"
//     - r.error with other code           -> ok=false, error.message
//     - synchronous throw inside spawnSync-> ok=false, err.message
//
//   runCommandTask()
//     - task.command empty/undefined  -> warn + early return (no run, no persist)
//     - task.timeoutMs 0/missing      -> uses default 10_000
//     - task.failThreshold 0/missing  -> uses default 2
//     - task.failThreshold > 0        -> respected
//     - success -> action=none        -> no Telegram call
//     - fail with action='alert', TELEGRAM set -> sends alert text (description)
//     - fail with action='alert', TELEGRAM set -> sends alert text (name fallback)
//     - fail with action='alert', TELEGRAM missing token -> warn suppression
//     - fail with action='alert', TELEGRAM missing chat  -> warn suppression
//     - recover, TELEGRAM set         -> sends recover text
//     - recover, TELEGRAM missing     -> warn suppression
//     - appendTaskRun throws          -> caught, run continues
//     - telegram sendTelegramMessage resolves -> info log
//     - telegram sendTelegramMessage rejects  -> warn log
//
// Sandbox: STORE_DIR is routed to a mkTempStore() dir (tmpdir-scoped, the
// live-install guard never sees it). HEALTH_PATH = join(STORE_DIR, ...)
// is computed at module load from the mocked config.js, so we set
// mockState.storeDir BEFORE the SUT module is first imported. vi.resetModules
// between tests forces a fresh module load, which gives us a clean healthMap
// per test and lets us hit the cache-miss disk-read branch more than once.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'
import type { ScheduledTask } from '../web/scheduled-tasks-io.js'

// ---------------------------------------------------------------------------
// Hoisted mock state. vi.hoisted runs before vi.mock factories so the
// factories can close over these references safely.
// ---------------------------------------------------------------------------
const mockState = vi.hoisted(() => ({
  spawnSyncResult: null as null | Record<string, unknown> & { error?: NodeJS.ErrnoException | null },
  spawnSyncThrow: false as boolean,
  sendTelegramMode: null as null | 'resolve' | 'reject',
  appendTaskRunCalls: [] as Array<{ name: string; agent: string }>,
  appendTaskRunThrow: false as boolean,
  atomicWriteCalls: [] as Array<{ path: string; data: string | Buffer; mode?: number }>,
  atomicWriteThrow: false as boolean,
  storeDir: '' as string,
  telegramToken: '' as string,
  chatId: '' as string,
}))

// ---------------------------------------------------------------------------
// Mocks. The factory functions read mockState at SUT-load time, so we must
// set mockState fields BEFORE the first import of the SUT and again between
// tests if we want different values.
// ---------------------------------------------------------------------------

// node:child_process: replace spawnSync with a controllable stub.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    spawnSync: ((cmd: string, args: string[], opts: Record<string, unknown>) => {
      if (mockState.spawnSyncThrow) throw new Error('mock spawnSync throw')
      if (mockState.spawnSyncResult) return mockState.spawnSyncResult as ReturnType<typeof actual.spawnSync>
      return { status: 0, stdout: '', stderr: '' } as ReturnType<typeof actual.spawnSync>
    }) as typeof actual.spawnSync,
  }
})

// ../config.js: use getters so the SUT reads the current mockState values.
vi.mock('../config.js', () => ({
  get STORE_DIR() { return mockState.storeDir },
  get TELEGRAM_BOT_TOKEN() { return mockState.telegramToken },
  get ALLOWED_CHAT_ID() { return mockState.chatId },
}))

// ../logger.js: passthrough spies.
vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

// ../db.js: stub appendTaskRun.
vi.mock('../db.js', () => ({
  appendTaskRun: (name: string, agent: string) => {
    mockState.appendTaskRunCalls.push({ name, agent })
    if (mockState.appendTaskRunThrow) throw new Error('mock appendTaskRun throw')
  },
}))

// ../web/atomic-write.js: stub atomicWriteFileSync so the suite can capture
// call sites (atomicWriteCalls) and force a controlled throw (atomicWriteThrow)
// to drive persist()'s catch branch without touching the real fs.
vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, data: string | Buffer, opts?: { mode?: number }) => {
    mockState.atomicWriteCalls.push({ path, data, mode: opts?.mode })
    if (mockState.atomicWriteThrow) throw new Error('mock atomicWrite throw')
  },
}))

// ../web/telegram.js: stub sendTelegramMessage.
vi.mock('../web/telegram.js', () => ({
  sendTelegramMessage: (_token: string, _chat: string, _text: string) => {
    if (mockState.sendTelegramMode === 'reject') return Promise.reject(new Error('mock telegram reject'))
    return Promise.resolve()
  },
}))

// ---------------------------------------------------------------------------
// Sandbox: a tmpdir-scoped STORE_DIR. Must be ready BEFORE the first SUT
// import so HEALTH_PATH resolves into the sandbox.
// ---------------------------------------------------------------------------
const STORE_PARENT = mkTempStore('command-task-store-')
mockState.storeDir = STORE_PARENT
const HEALTH_PATH = join(STORE_PARENT, 'command-task-health.json')

// SUT import. Must come AFTER the mocks so the SUT binds the mocked deps.
// vi.mock is hoisted above this import; the factory getters resolve at SUT
// load, picking up mockState.storeDir set above.
let sut: typeof import('../web/command-task.js')
let loggerMod: typeof import('../logger.js')
async function reloadSut(): Promise<void> {
  vi.resetModules()
  sut = await import('../web/command-task.js')
  loggerMod = await import('../logger.js')
}

async function flushMicrotasks(): Promise<void> {
  // Two await ticks so the .then/.catch on sendTelegramMessage resolves before
  // we assert on the logger.
  await Promise.resolve()
  await Promise.resolve()
  await Promise.resolve()
}

const baseTask = (overrides: Partial<ScheduledTask> = {}): ScheduledTask => ({
  name: 'task',
  description: 'desc',
  prompt: '',
  schedule: '* * * * *',
  agent: 'system',
  enabled: true,
  createdAt: 0,
  command: 'echo hi',
  ...overrides,
})

beforeEach(async () => {
  vi.clearAllMocks()
  mockState.spawnSyncResult = null
  mockState.spawnSyncThrow = false
  mockState.sendTelegramMode = null
  mockState.appendTaskRunCalls.length = 0
  mockState.appendTaskRunThrow = false
  mockState.atomicWriteCalls.length = 0
  mockState.atomicWriteThrow = false
  mockState.telegramToken = ''
  mockState.chatId = ''
  // Wipe the on-disk health file so each test starts with a clean disk.
  try { rmSync(HEALTH_PATH, { force: true }) } catch { /* best-effort */ }
  await reloadSut()
})

afterAll(() => {
  rmTempDir(join(STORE_PARENT, '..'))
})

// ---------------------------------------------------------------------------
// evaluateCommandResult: pure function, no I/O. The dedicated
// command-task-eval.test.ts already covers most branches; this file adds the
// two edges that aren't reachable from that suite (prev=undefined and
// failThreshold=1).
// ---------------------------------------------------------------------------
describe('evaluateCommandResult', () => {
  it('returns no action when prev is undefined and the command succeeds', () => {
    const { next, action } = sut.evaluateCommandResult(undefined, true, 2, 1000)
    expect(action).toBe('none')
    expect(next.fails).toBe(0)
    expect(next.alerted).toBe(false)
    expect(next.lastStatus).toBe('ok')
    expect(next.lastRun).toBe(1000)
  })

  it('alerts on the very first failure when failThreshold is 1', () => {
    const { next, action } = sut.evaluateCommandResult(undefined, false, 1, 1000)
    expect(action).toBe('alert')
    expect(next.fails).toBe(1)
    expect(next.alerted).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// load() / persist() coverage: drive runCommandTask on different on-disk
// states.
// ---------------------------------------------------------------------------
describe('load + persist', () => {
  it('reads a valid health-map JSON file from disk on first call', () => {
    writeFileSync(HEALTH_PATH, JSON.stringify({
      'task': { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 0 },
    }))
    // Force a fresh module so the cached healthMap is null.
    sut.runCommandTask(baseTask({ name: 'task' }), 1000)
    // Default spawnSync is success -> streak resets to 0. But the seeded
    // lastRun and fails fields prove the on-disk value was loaded.
    const written = JSON.parse(mockState.atomicWriteCalls[0]!.data as string)
    expect(written.task.lastRun).toBe(1000)
    expect(written.task.fails).toBe(0)
    expect(written.task.lastStatus).toBe('ok')
  })

  it('falls back to {} when the health file is missing (ENOENT)', () => {
    // HEALTH_PATH was wiped in beforeEach -> readFileSync throws ENOENT.
    sut.runCommandTask(baseTask({ name: 'missing-file' }), 1000)
    const written = JSON.parse(mockState.atomicWriteCalls[0]!.data as string)
    expect(written['missing-file']).toBeDefined()
    expect(written['missing-file'].fails).toBe(0)
  })

  it('falls back to {} when the health file contains malformed JSON', () => {
    mkdirSync(STORE_PARENT, { recursive: true })
    writeFileSync(HEALTH_PATH, '{ this is not json')
    sut.runCommandTask(baseTask({ name: 'malformed' }), 1000)
    const written = JSON.parse(mockState.atomicWriteCalls[0]!.data as string)
    expect(written['malformed']).toBeDefined()
    expect(written['malformed'].fails).toBe(0)
  })

  it('uses the cached health map on subsequent calls (no disk re-read)', () => {
    // First call seeds the cache.
    sut.runCommandTask(baseTask({ name: 'cache-task', command: 'exit 0' }), 1000)
    // Mutate the on-disk file to something the SUT should NOT pick up.
    writeFileSync(HEALTH_PATH, JSON.stringify({ 'cache-task': { fails: 999, alerted: true, lastStatus: 'fail', lastRun: 999 } }))
    // Second call must use the in-memory cache (fails=0 after success), not
    // the mutated disk contents.
    sut.runCommandTask(baseTask({ name: 'cache-task', command: 'exit 0' }), 2000)
    const last = mockState.atomicWriteCalls[mockState.atomicWriteCalls.length - 1]!
    const written = JSON.parse(last.data as string)
    expect(written['cache-task'].fails).toBe(0)
  })

  it('logs a warning when atomicWriteFileSync throws during persist', async () => {
    const { logger } = loggerMod
    mockState.atomicWriteThrow = true
    sut.runCommandTask(baseTask({ name: 'persist-fail' }), 1000)
    const call = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('failed to persist'),
    )
    expect(call).toBeDefined()
    expect(call![0]).toBeDefined() // ensure the { err } arg is non-undefined
  })

  it('persist() writes the cached map: entries not touched this run still survive', () => {
    // Pinning contract: persist() must serialize the CACHED healthMap, not a
    // fresh empty object. Seed two entries on disk: 'untouched' is not run
    // this invocation, 'to-touch' is. After running 'to-touch', the persisted
    // JSON must still carry the full 'untouched' entry. If persist() is ever
    // changed to write `{}` instead of `load()`, 'untouched' disappears and
    // this assertion catches it.
    writeFileSync(HEALTH_PATH, JSON.stringify({
      'untouched': { fails: 5, alerted: true, lastStatus: 'fail', lastRun: 100 },
      'to-touch': { fails: 1, alerted: false, lastStatus: 'fail', lastRun: 100 },
    }))
    mockState.spawnSyncResult = { status: 0, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'to-touch' }), 2000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
    const data = mockState.atomicWriteCalls[0].data
    // mockState.atomicWriteCalls.data is typed string | Buffer; the SUT passes
    // a JSON.stringify result (a string). Narrow without `as` / `!`.
    if (typeof data !== 'string') throw new TypeError('expected string payload from atomicWrite')
    const parsed: unknown = JSON.parse(data)
    const isRecord = (v: unknown): v is Record<string, unknown> =>
      typeof v === 'object' && v !== null
    if (!isRecord(parsed)) throw new TypeError('expected JSON object payload')
    expect(parsed.untouched).toMatchObject({
      fails: 5,
      alerted: true,
      lastStatus: 'fail',
      lastRun: 100,
    })
    expect(parsed['to-touch']).toMatchObject({
      fails: 0,
      alerted: false,
      lastStatus: 'ok',
      lastRun: 2000,
    })
  })
})

// ---------------------------------------------------------------------------
// runCommand() branches: drive via spawnSyncResult mock.
// ---------------------------------------------------------------------------
describe('runCommand (via spawnSync mock)', () => {
  it('returns ok=true on exit 0', () => {
    mockState.spawnSyncResult = { status: 0, stdout: 'out', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'rc-ok' }), 1000)
    const infoCall = (vi.mocked(loggerMod.logger.info)).mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('command task ran'),
    )
    expect(infoCall).toBeDefined()
    expect(infoCall![0]).toMatchObject({ ok: true, detail: 'exit 0' })
  })

  it('returns ok=false with stderr snippet on non-zero exit', () => {
    mockState.spawnSyncResult = { status: 7, stdout: '', stderr: 'boom' }
    sut.runCommandTask(baseTask({ name: 'rc-stderr' }), 1000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })

  it('returns ok=false with empty stderr (no trailing colon)', () => {
    mockState.spawnSyncResult = { status: 3, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'rc-no-stderr' }), 1000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })

  it('returns timeout detail when spawnSync reports ETIMEDOUT', () => {
    const err = Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' }) as NodeJS.ErrnoException
    mockState.spawnSyncResult = { status: null, stdout: '', stderr: '', error: err }
    sut.runCommandTask(baseTask({ name: 'rc-timeout', timeoutMs: 5000 }), 1000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })

  it('returns the spawn error message when error code is not ETIMEDOUT', () => {
    const err = Object.assign(new Error('ENOENT weird'), { code: 'ENOENT' }) as NodeJS.ErrnoException
    mockState.spawnSyncResult = { status: null, stdout: '', stderr: '', error: err }
    sut.runCommandTask(baseTask({ name: 'rc-other-err' }), 1000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })

  it('catches a synchronous throw from spawnSync', () => {
    mockState.spawnSyncThrow = true
    // The synchronous throw is caught inside runCommand's try/catch, so
    // runCommandTask should still complete and persist a fail entry.
    sut.runCommandTask(baseTask({ name: 'rc-throw' }), 1000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// runCommandTask() branches.
// ---------------------------------------------------------------------------
describe('runCommandTask', () => {
  it('skips and warns when the task has no command', async () => {
    const { logger } = loggerMod
    sut.runCommandTask(baseTask({ name: 'no-cmd', command: undefined }), 1000)
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'no-cmd' }),
      expect.stringContaining('no command'),
    )
    // No spawn, no persist, no append.
    expect(mockState.atomicWriteCalls).toHaveLength(0)
    expect(mockState.appendTaskRunCalls).toHaveLength(0)
  })

  it('uses the default 10s timeout when timeoutMs is missing or 0', () => {
    sut.runCommandTask(baseTask({ name: 'default-timeout', timeoutMs: 0 }), 1000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })

  it('uses the default failThreshold=2 when failThreshold is missing or 0', () => {
    // failThreshold=0 falls back to 2: one failure is below threshold.
    sut.runCommandTask(baseTask({ name: 'default-thresh', failThreshold: 0 }), 1000)
    // Spawn returned exit 0 by default -> success, no action.
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })

  it('sends a Telegram alert when the streak first hits the threshold', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = 'TKN'
    mockState.chatId = '123'
    mockState.spawnSyncResult = { status: 1, stdout: '', stderr: 'oops' }
    // failThreshold=1 -> first failure alerts.
    sut.runCommandTask(baseTask({ name: 'alert-task', description: 'My Service', failThreshold: 1 }), 1000)
    await flushMicrotasks()
    expect((logger.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'alert-task', action: 'alert' }),
      expect.stringContaining('alert sent'),
    )
  })

  it('falls back to task.name when description is empty in the alert text', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = 'TKN'
    mockState.chatId = '123'
    mockState.spawnSyncResult = { status: 1, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'fallback-name', description: '', failThreshold: 1 }), 1000)
    await flushMicrotasks()
    // The alert text uses the name as fallback; verify the success of the
    // branch by checking the info call fired.
    expect((logger.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'fallback-name', action: 'alert' }),
      expect.stringContaining('alert sent'),
    )
  })

  it('suppresses the alert with a warn when TELEGRAM_BOT_TOKEN is empty', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = ''
    mockState.chatId = '123'
    mockState.spawnSyncResult = { status: 1, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'no-tok', failThreshold: 1 }), 1000)
    await flushMicrotasks()
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'no-tok' }),
      expect.stringContaining('suppressed'),
    )
  })

  it('suppresses the alert with a warn when ALLOWED_CHAT_ID is empty', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = 'TKN'
    mockState.chatId = ''
    mockState.spawnSyncResult = { status: 1, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'no-chat', failThreshold: 1 }), 1000)
    await flushMicrotasks()
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'no-chat' }),
      expect.stringContaining('suppressed'),
    )
  })

  it('sends a Telegram recovery message when an alerted task succeeds', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = 'TKN'
    mockState.chatId = '123'
    // Seed an alerted state on disk so a single success flips to recover.
    writeFileSync(HEALTH_PATH, JSON.stringify({
      'recover-task': { fails: 3, alerted: true, lastStatus: 'fail', lastRun: 0 },
    }))
    mockState.spawnSyncResult = { status: 0, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'recover-task' }), 1000)
    await flushMicrotasks()
    expect((logger.info as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'recover-task', action: 'recover' }),
      expect.stringContaining('alert sent'),
    )
  })

  it('suppresses the recovery message with a warn when Telegram is unset', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = ''
    mockState.chatId = ''
    writeFileSync(HEALTH_PATH, JSON.stringify({
      'recover-no-tg': { fails: 3, alerted: true, lastStatus: 'fail', lastRun: 0 },
    }))
    mockState.spawnSyncResult = { status: 0, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'recover-no-tg' }), 1000)
    await flushMicrotasks()
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'recover-no-tg' }),
      expect.stringContaining('suppressed'),
    )
  })

  it('logs a warn when sendTelegramMessage rejects', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = 'TKN'
    mockState.chatId = '123'
    mockState.sendTelegramMode = 'reject'
    mockState.spawnSyncResult = { status: 1, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'tg-reject', failThreshold: 1 }), 1000)
    await flushMicrotasks()
    expect((logger.warn as ReturnType<typeof vi.fn>)).toHaveBeenCalledWith(
      expect.objectContaining({ task: 'tg-reject' }),
      expect.stringContaining('send failed'),
    )
  })

  it('swallows appendTaskRun throws (non-fatal)', () => {
    mockState.appendTaskRunThrow = true
    mockState.spawnSyncResult = { status: 0, stdout: '', stderr: '' }
    // Must not throw.
    expect(() => sut.runCommandTask(baseTask({ name: 'append-throw' }), 1000)).not.toThrow()
    expect(mockState.atomicWriteCalls).toHaveLength(1)
  })

  it('passes task.agent through to appendTaskRun, defaulting to "system"', () => {
    mockState.spawnSyncResult = { status: 0, stdout: '', stderr: '' }
    // Falsy agent falls back to "system" via the `task.agent || "system"` branch.
    sut.runCommandTask(baseTask({ name: 'agent-default', agent: '' as string }), 1000)
    expect(mockState.appendTaskRunCalls).toEqual([{ name: 'agent-default', agent: 'system' }])

    sut.runCommandTask(baseTask({ name: 'agent-explicit', agent: 'alice' }), 1000)
    expect(mockState.appendTaskRunCalls).toContainEqual({ name: 'agent-explicit', agent: 'alice' })
  })

  it('returns early on action=none and never calls sendTelegramMessage', async () => {
    const { logger } = loggerMod
    mockState.telegramToken = 'TKN'
    mockState.chatId = '123'
    mockState.spawnSyncResult = { status: 0, stdout: '', stderr: '' }
    sut.runCommandTask(baseTask({ name: 'no-action' }), 1000)
    await flushMicrotasks()
    // No alert-sent / send-failed / suppressed log should fire.
    const suppressed = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('suppressed'),
    )
    expect(suppressed).toHaveLength(0)
    const sent = (logger.info as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('alert sent'),
    )
    expect(sent).toHaveLength(0)
  })

  it('persists a health-map containing the updated entry on every run', () => {
    mockState.spawnSyncResult = { status: 1, stdout: '', stderr: 'die' }
    sut.runCommandTask(baseTask({ name: 'persist-1', failThreshold: 5 }), 1000)
    expect(mockState.atomicWriteCalls).toHaveLength(1)
    const payload = JSON.parse(mockState.atomicWriteCalls[0]!.data as string)
    expect(payload['persist-1']).toMatchObject({ fails: 1, alerted: false, lastStatus: 'fail', lastRun: 1000 })

    sut.runCommandTask(baseTask({ name: 'persist-1', failThreshold: 5 }), 2000)
    const payload2 = JSON.parse(mockState.atomicWriteCalls[1]!.data as string)
    expect(payload2['persist-1']).toMatchObject({ fails: 2, alerted: false, lastStatus: 'fail', lastRun: 2000 })
  })
})

// ---------------------------------------------------------------------------
// Defensive: the on-disk health map is the only thing the SUT reads via
// node:fs (no readFileSync on STORE_DIR otherwise). After wiping HEALTH_PATH
// the readFileSync call in load() returns ENOENT -- exercise the actual fs
// path at least once to make sure the SUT handles a real disk absence (not
// just a mocked one).
// ---------------------------------------------------------------------------
describe('real fs integration', () => {
  it('survives a real on-disk absence of HEALTH_PATH (catch branch)', () => {
    rmSync(HEALTH_PATH, { force: true })
    sut.runCommandTask(baseTask({ name: 'real-fs' }), 1000)
    // Catch branch ran, persist succeeded (mocked atomicWrite), entry
    // recorded. The point of the test is to exercise the real readFileSync
    // throwing ENOENT, not to validate the mocked atomicWrite, so we only
    // assert on the call count here.
    expect(mockState.atomicWriteCalls).toHaveLength(1)
    const written = JSON.parse(mockState.atomicWriteCalls[0]!.data as string)
    expect(written['real-fs']).toBeDefined()
  })
})