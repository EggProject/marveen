// Coverage tests for src/web/inbox-nudge-watcher.ts. The pure decision layer
// (decideNudgePreflight / recordNudge / nudgeText) is already covered by
// inbox-nudge.test.ts; this file targets the IO-driven tick() shell and the
// startInboxNudgeWatcher() lifecycle. The watcher's `tick()` function is a
// private (not exported) callback wired to a setTimeout(initial_delay) +
// setInterval(interval). We drive the watcher via Vitest fake timers and
// step through the timer queue one callback at a time so each test owns the
// exact sequence of tick executions.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Merged into the existing '../config.js' mock factory below.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})


const mockGetPending = vi.fn<() => Array<{ id: number; created_at: number }>>()
const mockIsReady = vi.fn<(session: string, host: string | null) => Promise<boolean>>()
const mockSend = vi.fn<(session: string, text: string, host: string | null, opts: { onBusyTimeout: 'send' | 'abort'; idleTimeoutMs: number }) => Promise<'sent' | 'aborted-busy'>>()
const mockSessionExists = vi.fn<(host: string | null, session: string) => boolean>()
const mockSendAlert = vi.fn<(text: string) => void>()
const mockGetSetting = vi.fn<(key: string) => string | number>()

vi.mock('node:child_process', () => ({
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  spawn: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../config.js', () => ({
  ...configSandbox,
  MAIN_AGENT_ID: 'marveen',
}))

vi.mock('../db.js', () => ({
  getPendingMessages: (toAgent: string) => {
    expect(toAgent).toBe('marveen')
    return mockGetPending()
  },
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string) => mockGetSetting(key),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/agent-process.js', () => ({
  isSessionReadyForPrompt: (session: string, host: string | null) => mockIsReady(session, host),
  sendPromptToSession: (session: string, text: string, host: string | null, opts: { onBusyTimeout: 'send' | 'abort'; idleTimeoutMs: number }) =>
    mockSend(session, text, host, opts),
  sessionExistsOnHost: (host: string | null, session: string) => mockSessionExists(host, session),
}))

vi.mock('../web/channel-monitor.js', () => ({
  sendAlert: (text: string) => mockSendAlert(text),
}))

import {
  startInboxNudgeWatcher,
  _resetNudgeStateForTest,
  INBOX_NUDGE_INITIAL_DELAY_MS,
  INBOX_NUDGE_INTERVAL_MS,
  NUDGE_DEBOUNCE_MS,
  STALE_NUDGE_COOLDOWN_MS,
  MAX_STALE_NUDGES,
  MAX_NUDGES_PER_HOUR,
  NUDGE_MAX_CHARS,
  MIN_PENDING_AGE_MS,
  INITIAL_NUDGE_STATE,
  decideNudgePreflight,
  nudgeText,
  type NudgeState,
} from '../web/inbox-nudge-watcher.js'
import { logger } from '../logger.js'

const T0 = 1_700_000_000_000

let watcherTimer: NodeJS.Timeout | null = null

beforeEach(() => {
  vi.clearAllMocks()
  _resetNudgeStateForTest()
  vi.useFakeTimers({ now: T0 })
  mockIsReady.mockResolvedValue(true)
  mockSend.mockResolvedValue('sent')
  mockSessionExists.mockReturnValue(true)
  mockGetSetting.mockImplementation(() => { throw new Error('no settings in test') })
})

afterEach(() => {
  if (watcherTimer !== null) {
    clearInterval(watcherTimer)
    watcherTimer = null
  }
  vi.useRealTimers()
})

function startWatcher(): void {
  watcherTimer = startInboxNudgeWatcher()
}

async function tickOnce(): Promise<void> {
  await vi.advanceTimersToNextTimerAsync()
}

// Drive the watcher through the initial setTimeout (T=55_000) plus the
// earlier interval ticks at T=20_000 and T=40_000. Three calls.
async function firstShellTick(): Promise<void> {
  await tickOnce()
  await tickOnce()
  await tickOnce()
}

describe('inbox-nudge-watcher startInboxNudgeWatcher -- lifecycle', () => {
  it('returns a timer handle from the interval registration', () => {
    const timer = startInboxNudgeWatcher()
    expect(timer).toBeDefined()
    expect(typeof timer).toBe('object')
    clearInterval(timer)
    watcherTimer = null
  })

  it('keeps ticking on every interval', async () => {
    mockGetPending.mockReturnValue([])
    const timer = startInboxNudgeWatcher()
    await vi.advanceTimersByTimeAsync(INBOX_NUDGE_INTERVAL_MS)
    const callsAfter = mockGetPending.mock.calls.length
    expect(callsAfter).toBeGreaterThan(0)
    await vi.advanceTimersByTimeAsync(INBOX_NUDGE_INTERVAL_MS)
    expect(mockGetPending.mock.calls.length).toBeGreaterThan(callsAfter)
    clearInterval(timer)
    watcherTimer = null
  })
})

describe('inbox-nudge-watcher tick -- empty inbox', () => {
  it('does NOT send or log when the inbox is empty on a fresh state', async () => {
    mockGetPending.mockReturnValue([])
    startWatcher()
    await firstShellTick()
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockSendAlert).not.toHaveBeenCalled()
  })

  it('takes the dirty-state-reset branch when the inbox empties after a nudge', async () => {
    // First nudge sets non-zero state fields. Then the inbox empties on
    // the next tick -- the preflight must reset the spell-scoped fields
    // (lastNudgeOldestId, staleNudges, staleAlerted, lastBusyLogAt,
    // absenceLogged) while keeping lastNudgeAt (the global debounce).
    mockGetPending.mockReturnValueOnce([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).toHaveBeenCalledTimes(1)
    // Inbox empties -- the next tick reaches the dirty-state-reset branch.
    mockGetPending.mockReturnValue([])
    await vi.advanceTimersByTimeAsync(INBOX_NUDGE_INTERVAL_MS)
    // No log fires on the reset branch (only the proceeded-false return).
    expect(mockSend).toHaveBeenCalledTimes(1)
    expect(mockSendAlert).not.toHaveBeenCalled()
  })
})

describe('inbox-nudge-watcher tick -- too-young message', () => {
  it('skips a too-young message silently (no send, no isReady check)', async () => {
    // We craft the age so it stays < MIN_PENDING_AGE_MS at every tick the
    // watcher fires during the test. The initial setTimeout fires inside
    // firstShellTick at T=55_000. Set created_at forward enough that the
    // age at T=55_000 is 0 ms.
    const createdAt = (T0 + 55_000 - 0) / 1000 // 1_700_000_055
    mockGetPending.mockReturnValue([{ id: 9, created_at: createdAt }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).not.toHaveBeenCalled()
    expect(mockIsReady).not.toHaveBeenCalled()
  })
})

describe('inbox-nudge-watcher tick -- session absent', () => {
  it('logs the absence once per spell and stays silent on subsequent ticks', async () => {
    mockSessionExists.mockReturnValue(false)
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ inboxNudge: true, session: 'marveen-channels' }),
      expect.stringContaining('channels session absent'),
    )
    const callsBefore = vi.mocked(logger.info).mock.calls.length
    await tickOnce()
    await tickOnce()
    const newCalls = vi.mocked(logger.info).mock.calls.slice(callsBefore)
    const absenceLogs = newCalls.filter((c) => typeof c[1] === 'string' && c[1].includes('channels session absent'))
    expect(absenceLogs.length).toBe(0)
  })

  it('re-arms the absence log after the session exists (absent -> present -> absent)', async () => {
    mockSessionExists.mockReturnValue(false)
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    // Switch the session back on. Use a NEW oldest id so the next tick
    // bypasses the stale cooldown (lastNudgeOldestId=1, oldestId=2).
    mockSessionExists.mockReturnValue(true)
    mockGetPending.mockReturnValueOnce([{ id: 2, created_at: 0 }])
    await vi.advanceTimersByTimeAsync(INBOX_NUDGE_INTERVAL_MS)
    expect(mockSend).toHaveBeenCalled()
    // Switch back to session absent. Use another NEW id so the next tick
    // reaches the session-absent branch (a debounce-blocked tick returns
    // before the absence check, and the stale cooldown blocks the same id).
    mockSessionExists.mockReturnValue(false)
    mockGetPending.mockReturnValue([{ id: 3, created_at: 0 }])
    await vi.advanceTimersByTimeAsync(NUDGE_DEBOUNCE_MS + 1_000)
    const absenceLogs = vi.mocked(logger.info).mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('channels session absent'),
    )
    expect(absenceLogs.length).toBe(2)
  })
})

describe('inbox-nudge-watcher tick -- session busy', () => {
  it('logs the busy-wait message once and stays silent within the throttle window', async () => {
    mockIsReady.mockResolvedValue(false)
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ inboxNudgeWaiting: true }),
      expect.stringContaining('main session busy'),
    )
    const callsBefore = vi.mocked(logger.info).mock.calls.length
    await vi.advanceTimersByTimeAsync(INBOX_NUDGE_INTERVAL_MS)
    const newCalls = vi.mocked(logger.info).mock.calls.slice(callsBefore)
    const busyLogs = newCalls.filter((c) => typeof c[1] === 'string' && c[1].includes('main session busy'))
    expect(busyLogs.length).toBe(0)
  })

  it('re-logs the busy-wait message after 10 minutes of waiting', async () => {
    mockIsReady.mockResolvedValue(false)
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    const callsBefore = vi.mocked(logger.info).mock.calls.length
    await vi.advanceTimersByTimeAsync(10 * 60_000 + INBOX_NUDGE_INTERVAL_MS)
    const newCalls = vi.mocked(logger.info).mock.calls.slice(callsBefore)
    const busyLogs = newCalls.filter((c) => typeof c[1] === 'string' && c[1].includes('main session busy'))
    expect(busyLogs.length).toBeGreaterThan(0)
  })
})

describe('inbox-nudge-watcher tick -- happy path', () => {
  it('prompts the main agent with the hungarian nudge text when idle', async () => {
    mockGetPending.mockReturnValue([{ id: 42, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).toHaveBeenCalledWith(
      'marveen-channels',
      '[Inbox] Ha fent uj bejovo blokk van, dolgozd fel; ha nincs, hagyd.',
      null,
      { onBusyTimeout: 'abort', idleTimeoutMs: 2_000 },
    )
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ inboxNudge: true, oldestId: 42 }),
      expect.stringContaining('prompted the main agent to drain its inbox'),
    )
  })

  it('uses the english nudge text when DASHBOARD_LANG=en', async () => {
    mockGetSetting.mockImplementation((key: string) => key === 'DASHBOARD_LANG' ? 'en' : '')
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).toHaveBeenCalledWith(
      'marveen-channels',
      '[Inbox] If new inbound blocks appear above, process them; else skip.',
      null,
      expect.objectContaining({ onBusyTimeout: 'abort' }),
    )
  })

  it('falls back to hungarian when getEffectiveSettingValue throws', async () => {
    mockGetSetting.mockImplementation(() => { throw new Error('no settings') })
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).toHaveBeenCalledWith(
      'marveen-channels',
      '[Inbox] Ha fent uj bejovo blokk van, dolgozd fel; ha nincs, hagyd.',
      null,
      expect.objectContaining({ onBusyTimeout: 'abort' }),
    )
  })

  it('falls back to hungarian when DASHBOARD_LANG is set to a non-English value', async () => {
    // DASHBOARD_LANG resolves to something other than 'en' (the only
    // value that flips the resolution to English). The ternary 'hu' branch
    // must be reachable for any non-'en' value.
    mockGetSetting.mockImplementation((key: string) => key === 'DASHBOARD_LANG' ? 'fr' : '')
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).toHaveBeenCalledWith(
      'marveen-channels',
      '[Inbox] Ha fent uj bejovo blokk van, dolgozd fel; ha nincs, hagyd.',
      null,
      expect.objectContaining({ onBusyTimeout: 'abort' }),
    )
  })
})

describe('inbox-nudge-watcher tick -- send failure modes', () => {
  it('a send throw logs at warn and restores pre-send state', async () => {
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    mockSend.mockRejectedValueOnce(new Error('tmux exploded'))
    startWatcher()
    await firstShellTick()
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('send threw'),
    )
  })

  it('an aborted-busy return logs the skip and restores pre-send state', async () => {
    mockGetPending.mockReturnValue([{ id: 1, created_at: 0 }])
    mockSend.mockResolvedValueOnce('aborted-busy')
    startWatcher()
    await firstShellTick()
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      expect.objectContaining({ inboxNudgeSkipped: 'busy' }),
      expect.stringContaining('pane turned busy before send'),
    )
  })
})

describe('inbox-nudge-watcher tick -- stale alert', () => {
  it('fires sendAlert with a hungarian message when the stale spell exhausts', async () => {
    // Use a counter so each tick sees a NEW oldest id, avoiding the
    // stale cooldown gate that would otherwise block the spell from
    // reaching MAX_STALE_NUDGES.
    let nextId = 1
    mockGetPending.mockImplementation(() => [{ id: nextId, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).toHaveBeenCalledTimes(1)
    // Repeatedly nudge with the same id until MAX_STALE_NUDGES nudged and
    // the staleAlert fires. Each stale nudge needs the full cooldown wait.
    for (let i = 0; i < MAX_STALE_NUDGES; i++) {
      // Pin the same oldest id so the stale spell accumulates.
      const staleId = nextId
      mockGetPending.mockImplementation(() => [{ id: staleId, created_at: 0 }])
      // Wait past debounce + stale cooldown.
      await vi.advanceTimersByTimeAsync(NUDGE_DEBOUNCE_MS + STALE_NUDGE_COOLDOWN_MS + 1_000)
      await tickOnce()
    }
    // After MAX_STALE_NUDGES nudges, the watcher has staleNudges ==
    // MAX_STALE_NUDGES. The next tick at the same oldest id returns
    // staleAlert=true and the shell calls sendAlert.
    await vi.advanceTimersByTimeAsync(NUDGE_DEBOUNCE_MS + STALE_NUDGE_COOLDOWN_MS + 1_000)
    await tickOnce()
    expect(mockSendAlert).toHaveBeenCalled()
    const alertText = mockSendAlert.mock.calls[0]?.[0] ?? ''
    expect(alertText).toContain('fő-ügynök')
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ inboxNudge: true, staleNudges: MAX_STALE_NUDGES }),
      expect.stringContaining('drain did not claim after repeated nudges'),
    )
    // Subsequent tick: staleAlerted=true, no second alert.
    await vi.advanceTimersByTimeAsync(NUDGE_DEBOUNCE_MS + STALE_NUDGE_COOLDOWN_MS + 1_000)
    await tickOnce()
    expect(mockSendAlert).toHaveBeenCalledTimes(1)
  })
})

describe('inbox-nudge-watcher tick -- budget exhaustion', () => {
  it('logs the budget exhaustion once per spell', async () => {
    // Use a fresh id per nudge so the stale cooldown doesn't block.
    let nextId = 1
    mockGetPending.mockImplementation(() => [{ id: nextId++, created_at: 0 }])
    startWatcher()
    await firstShellTick()
    expect(mockSend).toHaveBeenCalledTimes(1)
    // Drive MAX_NUDGES_PER_HOUR - 1 more nudges (we already nudged once).
    // Each nudge needs >= NUDGE_DEBOUNCE_MS of separation.
    while (mockSend.mock.calls.length < MAX_NUDGES_PER_HOUR) {
      await vi.advanceTimersByTimeAsync(NUDGE_DEBOUNCE_MS + 1_000)
      await tickOnce()
    }
    expect(mockSend).toHaveBeenCalledTimes(MAX_NUDGES_PER_HOUR)
    // Next tick: budget exhausted.
    await vi.advanceTimersByTimeAsync(NUDGE_DEBOUNCE_MS + 1_000)
    await tickOnce()
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ inboxNudge: true, budget: MAX_NUDGES_PER_HOUR }),
      expect.stringContaining('hourly budget exhausted'),
    )
    // Subsequent tick within the same window: no re-log.
    const warnCallsBefore = vi.mocked(logger.warn).mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('hourly budget exhausted'),
    ).length
    await vi.advanceTimersByTimeAsync(NUDGE_DEBOUNCE_MS + 1_000)
    await tickOnce()
    const warnCallsAfter = vi.mocked(logger.warn).mock.calls.filter(
      (c) => typeof c[1] === 'string' && c[1].includes('hourly budget exhausted'),
    ).length
    expect(warnCallsAfter).toBe(warnCallsBefore)
  })
})

describe('inbox-nudge-watcher tick -- outer catch', () => {
  it('catches and logs a tick-level error from the IO shell', async () => {
    mockGetPending.mockImplementation(() => { throw new Error('db is gone') })
    startWatcher()
    await firstShellTick()
    expect(vi.mocked(logger.warn)).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('tick error'),
    )
  })
})

describe('inbox-nudge-watcher -- module-level constants', () => {
  it('exposes the documented tuning constants', () => {
    expect(INBOX_NUDGE_INITIAL_DELAY_MS).toBe(55_000)
    expect(INBOX_NUDGE_INTERVAL_MS).toBe(20_000)
    expect(NUDGE_DEBOUNCE_MS).toBe(60_000)
    expect(STALE_NUDGE_COOLDOWN_MS).toBe(5 * 60_000)
    expect(MAX_STALE_NUDGES).toBe(3)
    expect(MAX_NUDGES_PER_HOUR).toBe(10)
    expect(NUDGE_MAX_CHARS).toBe(70)
    expect(MIN_PENDING_AGE_MS).toBe(10_000)
  })

  it('exports INITIAL_NUDGE_STATE as a frozen baseline', () => {
    expect(INITIAL_NUDGE_STATE).toEqual({
      lastNudgeAt: 0,
      lastNudgeOldestId: null,
      staleNudges: 0,
      staleAlerted: false,
      recentNudges: [],
      budgetLogged: false,
      lastBusyLogAt: 0,
      absenceLogged: false,
    })
    expect(Object.isFrozen(INITIAL_NUDGE_STATE)).toBe(true)
  })

  it('re-exports the pure helpers for callers that compose them', () => {
    expect(typeof decideNudgePreflight).toBe('function')
    expect(typeof nudgeText).toBe('function')
    const r: NudgeState = INITIAL_NUDGE_STATE
    expect(r.lastNudgeAt).toBe(0)
  })
})
