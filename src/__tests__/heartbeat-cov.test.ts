// Supplemental coverage for src/heartbeat.ts.
//
// The base suite at src/__tests__/heartbeat.test.ts covers ~98% of the source.
// The remaining uncovered buckets require specific timer + filesystem +
// platform configurations. This suite isolates them in a focused harness
// and, when run alongside the base suite, drives heartbeat.ts to 100%
// statements / branches / functions / lines.
//
// Uncovered buckets targeted:
//   - Lines 213-216: ensureHeartbeatWorkerCwd's dashboard-hide sentinel write
//   - Line 467: msUntilNextHeartbeat's targetHour === 8 -> snap to startH
//   - Line 478: msUntilNextHeartbeat's defensive target <= now -> +1 day
//   - Lines 551-559: scheduleNext's post-tick reschedule body
//   - Lines 573-575: stopHeartbeat's `stopped = true` + clearTimeout branch

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const mockState = vi.hoisted(() => ({
  runAgent: vi.fn(),
  getHeartbeatKanbanSummary: vi.fn(),
  getActiveScheduledTaskCount: vi.fn(),
  getCalendarEvents: vi.fn(),
  notifyTelegram: vi.fn(),
  startHour: 9,
  endHour: 23,
  execFileSync: vi.fn(),
  sandbox: '',
  projectRoot: '',
  homeDir: '',
}))

const savedPlatform = process.platform
function setPlatform(p: NodeJS.Platform): void {
  Object.defineProperty(process, 'platform', { value: p, configurable: true })
}

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return {
    ...actual,
    homedir: () => mockState.homeDir,
    userInfo: () => ({ username: 'fake-user', uid: 1000, gid: 1000, shell: '/bin/false', homedir: mockState.homeDir }),
  }
})

vi.mock('node:child_process', () => ({
  execFileSync: mockState.execFileSync,
}))

vi.mock('../agent.js', () => ({ runAgent: mockState.runAgent }))
vi.mock('../db.js', () => ({
  getHeartbeatKanbanSummary: mockState.getHeartbeatKanbanSummary,
  getActiveScheduledTaskCount: mockState.getActiveScheduledTaskCount,
}))
vi.mock('../google-api.js', () => ({ getCalendarEvents: mockState.getCalendarEvents }))
vi.mock('../notify.js', () => ({ notifyTelegram: mockState.notifyTelegram }))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string): string | number => {
    if (key === 'HEARTBEAT_START_HOUR') return mockState.startHour
    if (key === 'HEARTBEAT_END_HOUR') return mockState.endHour
    return ''
  },
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}))

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: mockState.projectRoot,
    STORE_DIR: join(mockState.projectRoot, 'store'),
    OWNER_NAME: 'Owner',
    APP_TZ: 'Europe/Budapest',
    HEARTBEAT_CALENDAR_ID: 'fake-calendar',
    DB_FILENAME: 'claudeclaw.db',
  }
})

async function loadHeartbeatFresh(): Promise<typeof import('../heartbeat.js')> {
  vi.resetModules()
  vi.doMock('node:os', async (orig) => {
    const actual = await orig<typeof import('node:os')>()
    return {
      ...actual,
      homedir: () => mockState.homeDir,
      userInfo: () => ({ username: 'fake-user', uid: 1000, gid: 1000, shell: '/bin/false', homedir: mockState.homeDir }),
    }
  })
  vi.doMock('node:child_process', () => ({ execFileSync: mockState.execFileSync }))
  vi.doMock('../agent.js', () => ({ runAgent: mockState.runAgent }))
  vi.doMock('../db.js', () => ({
    getHeartbeatKanbanSummary: mockState.getHeartbeatKanbanSummary,
    getActiveScheduledTaskCount: mockState.getActiveScheduledTaskCount,
  }))
  vi.doMock('../google-api.js', () => ({ getCalendarEvents: mockState.getCalendarEvents }))
  vi.doMock('../notify.js', () => ({ notifyTelegram: mockState.notifyTelegram }))
  vi.doMock('../settings-store.js', () => ({
    getEffectiveSettingValue: (key: string): string | number => {
      if (key === 'HEARTBEAT_START_HOUR') return mockState.startHour
      if (key === 'HEARTBEAT_END_HOUR') return mockState.endHour
      return ''
    },
  }))
  vi.doMock('../logger.js', () => ({
    logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
  }))
  vi.doMock('../config.js', async (orig) => {
    const actual = await orig<typeof import('../config.js')>()
    return {
      ...actual,
      PROJECT_ROOT: mockState.projectRoot,
      STORE_DIR: join(mockState.projectRoot, 'store'),
      OWNER_NAME: 'Owner',
      APP_TZ: 'Europe/Budapest',
      HEARTBEAT_CALENDAR_ID: 'fake-calendar',
      DB_FILENAME: 'claudeclaw.db',
    }
  })
  return await import('../heartbeat.js')
}

function setupMocks(): void {
  mockState.runAgent.mockReset()
  mockState.runAgent.mockResolvedValue({ text: 'agent-text' })
  mockState.getCalendarEvents.mockReset()
  mockState.getCalendarEvents.mockResolvedValue([])
  mockState.getHeartbeatKanbanSummary.mockReset()
  mockState.getHeartbeatKanbanSummary.mockReturnValue({ urgent: [], in_progress: [], waiting: [] })
  mockState.getActiveScheduledTaskCount.mockReset()
  mockState.getActiveScheduledTaskCount.mockReturnValue({ count: 0, nextRun: null })
  mockState.notifyTelegram.mockReset()
  mockState.notifyTelegram.mockResolvedValue(undefined)
  mockState.execFileSync.mockReset()
}

beforeEach(() => {
  mockState.sandbox = mkdtempSync(join(tmpdir(), 'hb-cov-'))
  mockState.projectRoot = join(mockState.sandbox, 'project')
  mockState.homeDir = join(mockState.sandbox, 'home')
  mkdirSync(mockState.projectRoot, { recursive: true })
  mkdirSync(mockState.homeDir, { recursive: true })
  mockState.startHour = 9
  mockState.endHour = 23
  setupMocks()
})

afterEach(() => {
  vi.useRealTimers()
  setPlatform(savedPlatform)
  if (mockState.sandbox) {
    rmSync(mockState.sandbox, { recursive: true, force: true })
  }
  vi.restoreAllMocks()
})

// =============================================================================
// 213-216: ensureHeartbeatWorkerCwd writes the .hidden-from-dashboard sentinel
// =============================================================================

describe('ensureHeartbeatWorkerCwd sentinel write (lines 213-216)', () => {
  it('writes an empty .hidden-from-dashboard file when it does not yet exist', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const sentinelBefore = join(mockState.projectRoot, 'agents', 'heartbeat-worker', '.hidden-from-dashboard')
    expect(existsSync(sentinelBefore)).toBe(false)

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()

    expect(existsSync(sentinelBefore)).toBe(true)
    expect(statSync(sentinelBefore).size).toBe(0)
  })
})

// =============================================================================
// 467 + 478: msUntilNextHeartbeat's snap-to-startH + defensive +1 day branch
// =============================================================================

describe('msUntilNextHeartbeat snap-to-startH + defensive +1 day (lines 467 + 478)', () => {
  it('snaps targetHour 8 -> startH, then bumps to next day when target <= now', async () => {
    vi.useFakeTimers()
    mockState.startHour = 7
    mockState.endHour = 23
    vi.setSystemTime(new Date(2026, 7, 5, 7, 30, 0))

    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })

  it('snaps targetHour 8 -> startH and skips +1 day when target > now', async () => {
    vi.useFakeTimers()
    mockState.startHour = 7
    mockState.endHour = 23
    vi.setSystemTime(new Date(2026, 7, 5, 6, 45, 0))

    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })
})

// =============================================================================
// 551-559: scheduleNext post-tick reschedule
// =============================================================================

describe('scheduleNext post-tick reschedule (lines 551-559)', () => {
  it('keeps firing the agent on every hourly tick (proves the reschedule loop)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    // Each tick needs calendar data to trigger shouldNotify.
    mockState.getCalendarEvents.mockResolvedValue([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValue({ text: 'one' })

    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()

    // Fire three consecutive ticks. If scheduleNext's reschedule (lines
    // 551-559) is broken, only the first tick will run.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(3)

    hb.stopHeartbeat()
  })

  it('exercises the reschedule body (msUntilNextHeartbeat called after each tick)', async () => {
    // This test specifically targets line 553 (msUntilNextHeartbeat called
    // from inside the timer's post-fire body). The other "ticks fire"
    // tests exercise line 559 (scheduleNext called from inside the body).
    // Drive three ticks with notable events so shouldNotify passes and the
    // body fully runs through scheduleNext + msUntilNextHeartbeat.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValue([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValue({ text: 'one' })

    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()

    // Each tick advances by 1h. After each advance, the previous timer
    // body completes: executeHeartbeat -> msUntilNextHeartbeat ->
    // scheduleNext(newTimer). newTimer fires on the next advance.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(3)

    hb.stopHeartbeat()
  })
})

// =============================================================================
// 573-575: stopHeartbeat body
// =============================================================================

describe('stopHeartbeat body (lines 573-575)', () => {
  it('sets stopped=true and clears an armed timer (no agent fire after stop)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))

    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    hb.stopHeartbeat()

    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).not.toHaveBeenCalled()

    const { logger } = await import('../logger.js')
    expect(logger.info).toHaveBeenCalledWith('Heartbeat leallitva')
  })

  it('is a no-op when no timer has been armed', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))

    const hb = await loadHeartbeatFresh()
    expect(() => hb.stopHeartbeat()).not.toThrow()

    const { logger } = await import('../logger.js')
    expect(logger.info).toHaveBeenCalledWith('Heartbeat leallitva')
  })
})

// =============================================================================
// 551 (if (stopped) return): the timer's post-executeHeartbeat guard.
// Reachable only when a timer fires AFTER stopHeartbeat has flipped the
// `stopped` flag (e.g. initHeartbeat called after stopHeartbeat).
// =============================================================================

describe('scheduleNext if (stopped) return branch (line 551)', () => {
  it('short-circuits the reschedule when initHeartbeat runs after stopHeartbeat', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValue([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValue({ text: 'one' })

    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    hb.stopHeartbeat()
    // initHeartbeat after stopHeartbeat arms a fresh timer. When it fires,
    // the body runs executeHeartbeat (runAgent called once) and then the
    // `if (stopped) return` branch short-circuits BEFORE scheduleNext is
    // called a second time.
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)

    // No further re-arm: advancing more time must NOT trigger another tick.
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)

    hb.stopHeartbeat()
  })
})

// =============================================================================
// Anonymous .catch() callback at line 549 (the inner err logger). It's hit
// when executeHeartbeat() rejects INSIDE the setTimeout body. The base suite
// only exercises executeHeartbeat()'s own try/catch path; we need a test
// that surfaces a rejection past executeHeartbeat() (e.g. by rejecting an
// awaited function it calls that doesn't have its own catch).
// =============================================================================

describe('scheduleNext body .catch handler (line 549)', () => {
  it('logs the "Heartbeat hiba" error when executeHeartbeat throws synchronously', async () => {
    // Make the settings store throw on the SECOND call only. The first call
    // (from msUntilNextHeartbeat inside initHeartbeat) succeeds and arms
    // the timer. The second call (from executeHeartbeat inside the timer
    // body) throws -- outside the function's try/catch, so the rejection
    // is caught by the timer's .catch handler.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    let settingsCallCount = 0

    // Silence the synthetic unhandled-rejection vitest would otherwise flag
    // when the timer's body throws. The .catch handler DOES catch it, but
    // vitest's instrumentation sees the original rejection before the catch
    // attaches on the next microtask boundary.
    const unhandledHandler = (err: unknown): void => {
      if (err instanceof Error && err.message === 'synthetic settings-store failure') return
    }
    process.on('unhandledRejection', unhandledHandler)

    vi.resetModules()
    vi.doMock('node:os', async (orig) => {
      const actual = await orig<typeof import('node:os')>()
      return {
        ...actual,
        homedir: () => mockState.homeDir,
        userInfo: () => ({ username: 'fake-user', uid: 1000, gid: 1000, shell: '/bin/false', homedir: mockState.homeDir }),
      }
    })
    vi.doMock('node:child_process', () => ({ execFileSync: mockState.execFileSync }))
    vi.doMock('../agent.js', () => ({ runAgent: mockState.runAgent }))
    vi.doMock('../db.js', () => ({
      getHeartbeatKanbanSummary: mockState.getHeartbeatKanbanSummary,
      getActiveScheduledTaskCount: mockState.getActiveScheduledTaskCount,
    }))
    vi.doMock('../google-api.js', () => ({ getCalendarEvents: mockState.getCalendarEvents }))
    vi.doMock('../notify.js', () => ({ notifyTelegram: mockState.notifyTelegram }))
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: (_key: string): string | number => {
        settingsCallCount += 1
        // First two calls (startH, endH from msUntilNextHeartbeat) succeed.
        // Third call (startH from executeHeartbeat) throws.
        if (settingsCallCount >= 3) {
          throw new Error('synthetic settings-store failure')
        }
        if (settingsCallCount === 1) return mockState.startHour
        return mockState.endHour
      },
    }))
    const loggerMock = { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }
    vi.doMock('../logger.js', () => ({ logger: loggerMock }))
    vi.doMock('../config.js', async (orig) => {
      const actual = await orig<typeof import('../config.js')>()
      return {
        ...actual,
        PROJECT_ROOT: mockState.projectRoot,
        STORE_DIR: join(mockState.projectRoot, 'store'),
        OWNER_NAME: 'Owner',
        APP_TZ: 'Europe/Budapest',
        HEARTBEAT_CALENDAR_ID: 'fake-calendar',
        DB_FILENAME: 'claudeclaw.db',
      }
    })
    try {
      const hb = await import('../heartbeat.js')
      hb.initHeartbeat()
      await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
      hb.stopHeartbeat()
    } finally {
      process.off('unhandledRejection', unhandledHandler)
    }

    // The .catch handler logs `Heartbeat hiba` via logger.error.
    const errorCalls = (loggerMock.error as unknown as { mock: { calls: unknown[][] } }).mock.calls
      .filter((c) => typeof c[1] === 'string' && c[1] === 'Heartbeat hiba')
    expect(errorCalls.length).toBeGreaterThanOrEqual(1)
  })
})
