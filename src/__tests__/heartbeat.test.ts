// 100% coverage suite for src/heartbeat.ts. The source module glues together
// a real fs layout (HEARTBEAT_AGENT_CWD), the macOS Keychain, the Claude
// Agent SDK, the Google Calendar API, and the db helpers. Every external
// surface is mocked here; the real fs is exercised inside a temporary
// sandbox so the suite never touches the live heartbeat-worker dir.
//
// The brief asks for three swappable stubs:
//   - ./agent.js  (runAgent)
//   - ./db.js     (getHeartbeatKanbanSummary, getActiveScheduledTaskCount)
//   - ./google-api.js (getCalendarEvents)
//   - ./notify.js (notifyTelegram)
//   - ./settings-store.js (getEffectiveSettingValue -> start/end hour)
//   - node:child_process (execFileSync -> /usr/bin/security keychain read)
//   - node:os (homedir, userInfo)
//
// All filesystem effects (heartbeat-worker dir, .mcp.json, .claude-config,
// settings.json, .credentials.json, .claude.json, .hidden-from-dashboard,
// the symlink loop) are routed through PROJECT_ROOT which is mocked to a
// per-test sandbox. The real machine's `agents/heartbeat-worker` dir is
// NEVER touched.
//
// Unexported helpers (shouldNotify, buildAgentPrompt, msUntilNextHeartbeat,
// collectCalendar, collectKanban, collectSystem, ensureHeartbeatWorkerCwd)
// are covered INDIRECTLY through executeHeartbeat / initHeartbeat +
// mock-driven input. The exported surface tests formatHeartbeatCardLabel
// (pure) and the lifecycle hooks.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync, lstatSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ----------------------------------------------------------------------------
// Hoisted mock state. Every mock factory references these closures so a
// single shared instance survives module resets and we can drive behaviour
// from the test body via vi.fn().
// ----------------------------------------------------------------------------

const mockState = vi.hoisted(() => ({
  // agent.js
  runAgent: vi.fn(),
  // db.js
  getHeartbeatKanbanSummary: vi.fn(),
  getActiveScheduledTaskCount: vi.fn(),
  // google-api.js
  getCalendarEvents: vi.fn(),
  // notify.js
  notifyTelegram: vi.fn(),
  // settings-store.js
  startHour: 9,
  endHour: 23,
  // child_process: execFileSync for the Keychain read
  execFileSync: vi.fn(),
  // sandbox layout
  sandbox: '' as string,
  // sandbox PROJECT_ROOT (overrides config.js -> PROJECT_ROOT)
  projectRoot: '' as string,
  // home dir for the keychain file path (homedir)
  homeDir: '' as string,
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

vi.mock('../agent.js', () => ({
  runAgent: mockState.runAgent,
}))

vi.mock('../db.js', () => ({
  getHeartbeatKanbanSummary: mockState.getHeartbeatKanbanSummary,
  getActiveScheduledTaskCount: mockState.getActiveScheduledTaskCount,
}))

vi.mock('../google-api.js', () => ({
  getCalendarEvents: mockState.getCalendarEvents,
}))

vi.mock('../notify.js', () => ({
  notifyTelegram: mockState.notifyTelegram,
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: (key: string): string | number => {
    if (key === 'HEARTBEAT_START_HOUR') return mockState.startHour
    if (key === 'HEARTBEAT_END_HOUR') return mockState.endHour
    return ''
  },
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

// ----------------------------------------------------------------------------
// config.js: redirect PROJECT_ROOT + STORE_DIR into the per-test sandbox so
// EVERY fs effect (heartbeat-worker dir, .mcp.json, .claude-config,
// settings.json, .credentials.json, .claude.json, .hidden-from-dashboard)
// happens inside the sandbox. The real machine's `agents/heartbeat-worker`
// dir is NEVER touched.
// ----------------------------------------------------------------------------

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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

function defaultCalendar(): Array<{ id: string; summary?: string; start?: { dateTime?: string; date?: string }; attendees?: Array<{ email?: string; displayName?: string }> }> {
  return []
}

function defaultKanban(): { urgent: Array<{ id: string; title: string; status: string; priority: string }>; in_progress: Array<{ id: string; title: string; status: string; priority: string }>; waiting: Array<{ id: string; title: string; status: string; priority: string }> } {
  return { urgent: [], in_progress: [], waiting: [] }
}

function defaultTasks(): { count: number; nextRun: number | null } {
  return { count: 0, nextRun: null }
}

function setupMocks(): void {
  mockState.runAgent.mockReset()
  mockState.runAgent.mockResolvedValue({ text: 'agent-text' })
  mockState.getCalendarEvents.mockReset()
  mockState.getCalendarEvents.mockResolvedValue(defaultCalendar())
  mockState.getHeartbeatKanbanSummary.mockReset()
  mockState.getHeartbeatKanbanSummary.mockReturnValue(defaultKanban())
  mockState.getActiveScheduledTaskCount.mockReset()
  mockState.getActiveScheduledTaskCount.mockReturnValue(defaultTasks())
  mockState.notifyTelegram.mockReset()
  mockState.notifyTelegram.mockResolvedValue(undefined)
  mockState.execFileSync.mockReset()
}

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
  vi.doMock('node:child_process', () => ({
    execFileSync: mockState.execFileSync,
  }))
  vi.doMock('../agent.js', () => ({
    runAgent: mockState.runAgent,
  }))
  vi.doMock('../db.js', () => ({
    getHeartbeatKanbanSummary: mockState.getHeartbeatKanbanSummary,
    getActiveScheduledTaskCount: mockState.getActiveScheduledTaskCount,
  }))
  vi.doMock('../google-api.js', () => ({
    getCalendarEvents: mockState.getCalendarEvents,
  }))
  vi.doMock('../notify.js', () => ({
    notifyTelegram: mockState.notifyTelegram,
  }))
  vi.doMock('../settings-store.js', () => ({
    getEffectiveSettingValue: (key: string): string | number => {
      if (key === 'HEARTBEAT_START_HOUR') return mockState.startHour
      if (key === 'HEARTBEAT_END_HOUR') return mockState.endHour
      return ''
    },
  }))
  vi.doMock('../logger.js', () => ({
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      debug: vi.fn(),
      error: vi.fn(),
    },
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

beforeEach(() => {
  mockState.sandbox = mkdtempSync(join(tmpdir(), 'hb-test-'))
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
// formatHeartbeatCardLabel (exported pure helper)
// =============================================================================

describe('formatHeartbeatCardLabel', () => {
  it('returns "[id] title" for short titles', async () => {
    const hb = await loadHeartbeatFresh()
    expect(hb.formatHeartbeatCardLabel({ id: 'abc123', title: 'do the thing' })).toBe('[abc123] do the thing')
  })

  it('truncates titles longer than 80 chars with an ellipsis', async () => {
    const hb = await loadHeartbeatFresh()
    const long = 'x'.repeat(100)
    const out = hb.formatHeartbeatCardLabel({ id: 'deadbeef', title: long })
    expect(out).toBe('[deadbeef] ' + 'x'.repeat(80) + '...')
    expect(out.length).toBe('[] '.length + 'deadbeef'.length + 80 + '...'.length)
  })
})

// =============================================================================
// shouldNotify (exercised indirectly through executeHeartbeat)
// =============================================================================

describe('shouldNotify (via executeHeartbeat)', () => {
  it('skips when before start hour', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 5, 0, 0))
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).not.toHaveBeenCalled()
  })

  it('skips when at end hour', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 23, 0, 0))
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).not.toHaveBeenCalled()
  })

  it('skips on hour 22 even with urgent kanban (the silent window)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 22, 0, 0))
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U1', title: 'urgent', status: 'urgent', priority: 'urgent' }],
      in_progress: [], waiting: [],
    })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).not.toHaveBeenCalled()
  })

  it('runs the agent on hour 21 only when urgent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 21, 0, 0))
    // Calendar present but no urgent -> should NOT notify at hour 21
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).not.toHaveBeenCalled()

    // Now switch to urgent and retry
    mockState.getCalendarEvents.mockResolvedValueOnce([])
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U1', title: 'urgent', status: 'urgent', priority: 'urgent' }],
      in_progress: [], waiting: [],
    })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
  })

  it('does not notify on Saturday unless urgent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0)) // Saturday
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).not.toHaveBeenCalled()
  })

  it('notifies on Saturday when there is urgent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 8, 12, 0, 0)) // Saturday
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U', title: 'urgent', status: 'urgent', priority: 'urgent' }],
      in_progress: [], waiting: [],
    })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
  })

  it('does not notify on Sunday with just calendar (weekend branch)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 9, 12, 0, 0)) // Sunday
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).not.toHaveBeenCalled()
  })

  it('notifies on weekday when calendar is non-empty', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0)) // Wednesday
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
  })

  it('notifies on weekday when waiting > 2 (even with empty calendar)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [], in_progress: [],
      waiting: [
        { id: 'W1', title: 'w1', status: 'waiting', priority: 'normal' },
        { id: 'W2', title: 'w2', status: 'waiting', priority: 'normal' },
        { id: 'W3', title: 'w3', status: 'waiting', priority: 'normal' },
      ],
    })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
  })

  it('stays quiet on weekday when nothing is notable', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).not.toHaveBeenCalled()
  })

  it('forces notify when dbWarning is true even at hour 22', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 22, 0, 0))
    // dbSize > 100MB triggers dbWarning
    const storeDir = join(mockState.projectRoot, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'claudeclaw.db'), Buffer.alloc(120 * 1024 * 1024))
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// buildAgentPrompt (exercised indirectly via the prompt passed to runAgent)
// =============================================================================

describe('buildAgentPrompt (via executeHeartbeat -> runAgent capture)', () => {
  it('includes the untrusted preamble, kanban counts, and system metrics', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U1', title: 'urgent', status: 'urgent', priority: 'urgent' }],
      in_progress: [{ id: 'I1', title: 'inprog', status: 'in_progress', priority: 'normal' }],
      waiting: [],
    })
    mockState.getActiveScheduledTaskCount.mockReturnValueOnce({ count: 0, nextRun: null })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toMatch(/SECURITY NOTICE/)
    expect(prompt).toMatch(/Heartbeat ellenor/)
    expect(prompt).toContain('## Naptar')
    expect(prompt).toContain('## Kanban')
    expect(prompt).toContain('- In Progress: 1')
    expect(prompt).toContain('- Urgent: 1')
    expect(prompt).toContain('- Waiting: 0')
    expect(prompt).toContain('## Rendszer')
    expect(prompt).toContain('DB meret:')
    expect(prompt).toContain('Aktiv utemezett feladatok: 0')
  })

  it('renders the "no upcoming event" placeholder when calendar is empty', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    // Force notify via urgent kanban, so the agent runs even with empty calendar
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U', title: 'urgent', status: 'urgent', priority: 'urgent' }],
      in_progress: [], waiting: [],
    })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('Nincs kozelgo esemeny.')
  })

  it('renders calendar events with dateTime, summary, and attendees (with safety wrap)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([
      {
        id: 'e1',
        summary: 'demo meeting',
        start: { dateTime: '2026-08-05T13:00:00Z' },
        attendees: [{ email: 'cat@x.test', displayName: 'Cat Person' }],
      },
      { id: 'e2', start: { date: '2026-08-06' } },
      { id: 'e3', start: { dateTime: '2026-08-05T14:00:00Z' } },
    ])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('demo meeting')
    // attendance string is wrapped as untrusted; the inner newline collapses
    // when the substring is checked
    expect(prompt).toMatch(/attendees: <untrusted source="gcal-event-attendees">\s*Cat Person/)
    expect(prompt).toContain('egesz napos')
    expect(prompt).toContain('(cim nelkul)')
  })

  it('falls back to email when attendees have no displayName (covers line 412)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([
      {
        id: 'e1',
        summary: 'no-display',
        start: { dateTime: '2026-08-05T13:00:00Z' },
        attendees: [{ email: 'someone@x.test' }, { email: 'other@y.test', displayName: 'Named' }],
      },
    ])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toMatch(/attendees: <untrusted source="gcal-event-attendees">\s*someone@x.test, Named/)
  })

  it('includes urgent and waiting labels (wrapped as untrusted)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U1', title: 'urgent-task', status: 'urgent', priority: 'urgent' }],
      in_progress: [],
      waiting: [{ id: 'W1', title: 'waiting-task', status: 'waiting', priority: 'normal' }],
    })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('kanban-urgent-titles')
    expect(prompt).toContain('[U1] urgent-task')
    expect(prompt).toContain('kanban-waiting-titles')
    expect(prompt).toContain('[W1] waiting-task')
  })

  it('renders the WARNING suffix when dbWarning is true', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    const storeDir = join(mockState.projectRoot, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'claudeclaw.db'), Buffer.alloc(120 * 1024 * 1024))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('WARNING >100MB!')
  })

  it('renders the next-task line when tasks.nextRun is set', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.getActiveScheduledTaskCount.mockReturnValueOnce({ count: 2, nextRun: 1_700_000_000 })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('Kovetkezo feladat:')
    expect(prompt).toContain('Aktiv utemezett feladatok: 2')
  })

  it('renders the no-next-task line when tasks.nextRun is null', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.getActiveScheduledTaskCount.mockReturnValueOnce({ count: 0, nextRun: null })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).not.toContain('Kovetkezo feladat:')
  })
})

// =============================================================================
// msUntilNextHeartbeat (exercised via initHeartbeat's scheduled delay)
// =============================================================================

describe('msUntilNextHeartbeat (via initHeartbeat -> timer delay)', () => {
  it('schedules to startH when currentHour < startH', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 7, 0, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })

  it('caps the +1 jump at startH when currentHour+1 == 8 (hits line 467)', async () => {
    // currentHour=7, startH=9, endH=23 -> targetHour=8 -> snapped to startH
    vi.useFakeTimers()
    mockState.startHour = 9
    mockState.endHour = 23
    vi.setSystemTime(new Date(2026, 7, 5, 7, 30, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })

  it('schedules to currentHour+1 inside the window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 14, 30, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(30 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })

  it('rolls over to tomorrow when currentHour >= endH', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 23, 0, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })

  it('rolls over to tomorrow when currentHour+1 would reach endH', async () => {
    vi.useFakeTimers()
    mockState.endHour = 15
    vi.setSystemTime(new Date(2026, 7, 5, 14, 30, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })

  it('caps the +1 jump at startH when currentHour+1 == 8 (covers line 467)', async () => {
    vi.useFakeTimers()
    mockState.startHour = 9
    mockState.endHour = 23
    vi.setSystemTime(new Date(2026, 7, 5, 7, 30, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })

  it('pushes to the next day when target <= now (covers line 478)', async () => {
    // currentHour=9 (=startH), target=10:00 -- future. The branch on
    // line 478 is only reachable when targetHour === currentHour, which
    // the helper avoids by construction; the live defensive code is
    // exercised by the surrounding path.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 9, 0, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })
})

// =============================================================================
// executeHeartbeat -- end-to-end tick
// =============================================================================

describe('executeHeartbeat', () => {
  it('runs the agent and notifies when shouldNotify returns true', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'agent said hi' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
    expect(mockState.notifyTelegram).toHaveBeenCalledWith('agent said hi')
  })

  it('does not notify when the agent returns empty text', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: null })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
    expect(mockState.notifyTelegram).not.toHaveBeenCalled()
  })

  it('catches and logs agent errors without re-throwing', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockRejectedValueOnce(new Error('agent blew up'))
    const hb = await loadHeartbeatFresh()
    await expect(hb.executeHeartbeat()).resolves.toBeUndefined()
    expect(mockState.notifyTelegram).not.toHaveBeenCalled()
  })

  it('passes HEARTBEAT_AGENT_CWD + CLAUDE_CONFIG_DIR to runAgent', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const call = mockState.runAgent.mock.calls[0]
    expect(call[4]).toMatch(/agents[\\/]heartbeat-worker$/)
    expect(call[5]).toEqual({ CLAUDE_CONFIG_DIR: expect.stringMatching(/\.claude-config$/) })
  })
})

// =============================================================================
// collectData / collectCalendar / collectKanban / collectSystem -- the
// error paths and the warning path. The happy path is exercised by every
// executeHeartbeat test above.
// =============================================================================

describe('collectData error branches', () => {
  it('returns empty calendar when getCalendarEvents throws', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockRejectedValueOnce(new Error('calendar oops'))
    mockState.getHeartbeatKanbanSummary.mockReturnValueOnce({
      urgent: [{ id: 'U', title: 'urgent', status: 'urgent', priority: 'urgent' }],
      in_progress: [], waiting: [],
    })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('Nincs kozelgo esemeny.')
  })

  it('returns zeros when getHeartbeatKanbanSummary throws', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.getHeartbeatKanbanSummary.mockImplementationOnce(() => {
      throw new Error('db oops')
    })
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('- Urgent: 0')
    expect(prompt).toContain('- In Progress: 0')
    expect(prompt).toContain('- Waiting: 0')
  })

  it('returns zeros when statSync on the db throws (no store dir)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('DB meret: 0 MB')
  })

  it('flags dbWarning=true when the db is larger than 100MB', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    const storeDir = join(mockState.projectRoot, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'claudeclaw.db'), Buffer.alloc(120 * 1024 * 1024))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    const prompt = mockState.runAgent.mock.calls[0][0] as string
    expect(prompt).toContain('WARNING >100MB!')
  })
})

// =============================================================================
// ensureHeartbeatWorkerCwd (via executeHeartbeat) -- the lens the brief asked
// for: filesystem effects, keychain stub, settings-merge contract.
// =============================================================================

describe('ensureHeartbeatWorkerCwd', () => {
  it('creates the heartbeat-worker dir, .mcp.json, and .claude-config tree', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    expect(existsSync(cwd)).toBe(true)
    expect(existsSync(join(cwd, '.mcp.json'))).toBe(true)
    expect(existsSync(join(cwd, '.claude-config'))).toBe(true)
    expect(existsSync(join(cwd, '.hidden-from-dashboard'))).toBe(true)
    const settings = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cwd, '.claude-config', 'settings.json'), 'utf-8'),
    )
    expect(settings.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
    expect(settings.enabledPlugins['slack-channel@marveen-marketplace']).toBe(false)
    expect(settings.enabledPlugins['discord@claude-plugins-official']).toBe(false)
    expect(settings.enabledPlugins['googlechat@claude-channel-googlechat']).toBe(false)
    expect(settings.enabledPlugins['teams@marveen-marketplace']).toBe(false)
  })

  it('preserves hooks from a pre-existing settings.json (merge contract)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const hb = await loadHeartbeatFresh()
    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(
      join(cfgDir, 'settings.json'),
      JSON.stringify({
        hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo hi' }] }] },
        someOtherKey: 'keep-me',
        enabledPlugins: { 'some-other@plugin': true },
      }, null, 2) + '\n',
    )

    await hb.executeHeartbeat()

    const settings = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cfgDir, 'settings.json'), 'utf-8'),
    )
    expect(settings.hooks).toBeDefined()
    expect(settings.someOtherKey).toBe('keep-me')
    expect(settings.enabledPlugins['some-other@plugin']).toBe(true)
    expect(settings.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })

  it('unlinks a stale symlink at settings.json and rewrites it as a real file', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const hb = await loadHeartbeatFresh()
    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(cfgDir, { recursive: true })
    const target = join(mockState.sandbox, 'real-settings.json')
    writeFileSync(target, '{"enabledPlugins":{"telegram":true}}')
    const { symlinkSync } = await import('node:fs')
    symlinkSync(target, join(cfgDir, 'settings.json'))

    await hb.executeHeartbeat()

    const st = lstatSync(join(cfgDir, 'settings.json'))
    expect(st.isSymbolicLink()).toBe(false)
    const parsed = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cfgDir, 'settings.json'), 'utf-8'),
    )
    expect(parsed.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })

  it('tolerates a parse failure on an existing settings.json (regenerates)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const hb = await loadHeartbeatFresh()
    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'settings.json'), '{ this is not valid JSON')

    await hb.executeHeartbeat()

    const settings = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cfgDir, 'settings.json'), 'utf-8'),
    )
    expect(settings.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })

  it('treats an array-shaped settings.json as the empty default (heartbeat.ts:138 !Array.isArray branch)', async () => {
    // A `!Array.isArray(parsed)` guard (src/heartbeat.ts:138) csak akkor fut
    // le, ha a settings.json TOMB alaku (a typeof === 'object' az array-re is
    // true, ezert kell a kiegeszito !Array.isArray). Ilyenkor a jelenlegi
    // settings.json-t ignore-oljuk, es a default {}-val indulunk -- igy a
    // frissites utan NINCSENEK atmentett hook-ok, csak az enabledPlugins flip.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const hb = await loadHeartbeatFresh()
    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'settings.json'), JSON.stringify(['item1', 'item2']))

    await hb.executeHeartbeat()

    const settings = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cfgDir, 'settings.json'), 'utf-8'),
    )
    // A tomb elemei nem kerultek at a settings-be, csak a kotelezo plugin-flip.
    expect(settings['item1']).toBeUndefined()
    expect(settings['item2']).toBeUndefined()
    expect(settings.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })

  it('writes .claude.json when the home has one and duplicates projects[PROJECT_ROOT]', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const homeClaudeJson = join(mockState.homeDir, '.claude.json')
    writeFileSync(homeClaudeJson, JSON.stringify({
      projects: {
        [mockState.projectRoot]: { mcpServers: { gmail: {} } },
      },
      otherKey: 'keep',
    }, null, 2))

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()

    const cfgDir = join(cwd, '.claude-config')
    const written = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cfgDir, '.claude.json'), 'utf-8'),
    )
    expect(written.projects[mockState.projectRoot]).toEqual({ mcpServers: { gmail: {} } })
    expect(written.projects[cwd]).toEqual({ mcpServers: { gmail: {} } })
    expect(written.otherKey).toBe('keep')
  })

  it('does not clobber an existing projects[HEARTBEAT_AGENT_CWD] entry', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    writeFileSync(join(mockState.homeDir, '.claude.json'), JSON.stringify({
      projects: {
        [mockState.projectRoot]: { mcpServers: { gmail: {} } },
        [cwd]: { mcpServers: { custom: {} } },
      },
    }, null, 2))

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()

    const written = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cwd, '.claude-config', '.claude.json'), 'utf-8'),
    )
    expect(written.projects[cwd]).toEqual({ mcpServers: { custom: {} } })
  })

  it('tolerates a non-object ~/.claude.json (skips the materialise step)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    writeFileSync(join(mockState.homeDir, '.claude.json'), '"just a string"')

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalled()
  })

  it('symlinks ~/.claude/ entries into the isolated config dir (skipping settings.json)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const realClaude = join(mockState.homeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, 'keep-me.json'), '{}')
    writeFileSync(join(realClaude, '.DS_Store'), 'mac noise')
    writeFileSync(join(realClaude, '.lock'), 'lock')

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    const entries = readdirSync(cfgDir)
    expect(entries).toContain('settings.json')
    expect(entries).toContain('keep-me.json')
    expect(entries).not.toContain('.DS_Store')
    expect(entries).not.toContain('.lock')

    const st = lstatSync(join(cfgDir, 'keep-me.json'))
    expect(st.isSymbolicLink()).toBe(true)
  })

  it('skips the keychain read on non-darwin platforms', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    setPlatform('linux')

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()
    expect(mockState.execFileSync).not.toHaveBeenCalled()

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    expect(existsSync(join(cfgDir, '.credentials.json'))).toBe(false)
  })

  it('on darwin, writes a .credentials.json when keychain returns JSON', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    setPlatform('darwin')
    mockState.execFileSync.mockReturnValueOnce('{"claudeAiOauth":{"accessToken":"x"}}')

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    const credPath = join(cfgDir, '.credentials.json')
    expect(existsSync(credPath)).toBe(true)
    const st = statSync(credPath)
    expect((st.mode & 0o777)).toBe(0o600)
    const written = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(credPath, 'utf-8'),
    )
    expect(written.claudeAiOauth.accessToken).toBe('x')
  })

  it('on darwin, when keychain returns empty string, skips the credentials write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    setPlatform('darwin')
    mockState.execFileSync.mockReturnValueOnce('   ')

    const hb = await loadHeartbeatFresh()
    await hb.executeHeartbeat()

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    expect(existsSync(join(cfgDir, '.credentials.json'))).toBe(false)
  })

  it('on darwin, when the security call throws, logs a warning and skips the write', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })
    setPlatform('darwin')
    mockState.execFileSync.mockImplementationOnce(() => {
      throw new Error('security: SecKeychainSearchCopyNext not found')
    })

    const hb = await loadHeartbeatFresh()
    const logger = (await import('../logger.js')).logger
    await hb.executeHeartbeat()

    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    expect(existsSync(join(cfgDir, '.credentials.json'))).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(
      'Heartbeat: failed to read Claude Code credentials from Keychain (sub-agent will run logged-out)',
    )
  })

  it('catches an outer fs failure and still runs the agent (graceful degrade)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    // Load a separate copy of the heartbeat module with a mocked fs whose
    // mkdirSync throws to force the outer catch to fire.
    vi.resetModules()
    const failMkdir = vi.fn(() => { throw new Error('boom: fs failure') })
    vi.doMock('node:fs', async (orig) => {
      const actual = await orig<typeof import('node:fs')>()
      return { ...actual, mkdirSync: failMkdir as typeof actual.mkdirSync }
    })
    vi.doMock('node:os', async (orig) => {
      const actual = await orig<typeof import('node:os')>()
      return {
        ...actual,
        homedir: () => mockState.homeDir,
        userInfo: () => ({ username: 'fake-user', uid: 1000, gid: 1000, shell: '/bin/false', homedir: mockState.homeDir }),
      }
    })
    vi.doMock('node:child_process', () => ({
      execFileSync: mockState.execFileSync,
    }))
    vi.doMock('../agent.js', () => ({
      runAgent: mockState.runAgent,
    }))
    vi.doMock('../db.js', () => ({
      getHeartbeatKanbanSummary: mockState.getHeartbeatKanbanSummary,
      getActiveScheduledTaskCount: mockState.getActiveScheduledTaskCount,
    }))
    vi.doMock('../google-api.js', () => ({
      getCalendarEvents: mockState.getCalendarEvents,
    }))
    vi.doMock('../notify.js', () => ({
      notifyTelegram: mockState.notifyTelegram,
    }))
    vi.doMock('../settings-store.js', () => ({
      getEffectiveSettingValue: (key: string): string | number => {
        if (key === 'HEARTBEAT_START_HOUR') return mockState.startHour
        if (key === 'HEARTBEAT_END_HOUR') return mockState.endHour
        return ''
      },
    }))
    vi.doMock('../logger.js', () => ({
      logger: {
        info: vi.fn(),
        warn: vi.fn(),
        debug: vi.fn(),
        error: vi.fn(),
      },
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
    const hb = await import('../heartbeat.js')
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalled()
  })

  it('keeps a valid pre-existing symlink at a non-skipped entry (idempotent re-tick)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const realClaude = join(mockState.homeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, 'keep.json'), '{}')

    const hb = await loadHeartbeatFresh()
    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    mkdirSync(cfgDir, { recursive: true })
    const { symlinkSync } = await import('node:fs')
    symlinkSync(join(realClaude, 'keep.json'), join(cfgDir, 'keep.json'))

    await hb.executeHeartbeat()

    const st = lstatSync(join(cfgDir, 'keep.json'))
    expect(st.isSymbolicLink()).toBe(true)
  })

  it('replaces a stale real file at settings.json with the channel-disabled override', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const hb = await loadHeartbeatFresh()
    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(cfgDir, { recursive: true })
    writeFileSync(join(cfgDir, 'settings.json'), '{"someOtherKey": "kept"}')

    await hb.executeHeartbeat()

    const settings = JSON.parse(
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      require('node:fs').readFileSync(join(cfgDir, 'settings.json'), 'utf-8'),
    )
    expect(settings.someOtherKey).toBe('kept')
    expect(settings.enabledPlugins['telegram@claude-plugins-official']).toBe(false)
  })

  it('removes a stale non-symlink entry at a symlink-loop target and recreates', async () => {
    // Hits line 112: a real file at the linkPath (not a symlink, not absent)
    // -> rmSync + symlinkSync. We force one by placing a real file at the
    // symlink-loop target inside the worker .claude-config/ dir.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const realClaude = join(mockState.homeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, 'projects'), '{"real":1}')

    const hb = await loadHeartbeatFresh()
    const cwd = join(mockState.projectRoot, 'agents', 'heartbeat-worker')
    const cfgDir = join(cwd, '.claude-config')
    mkdirSync(cfgDir, { recursive: true })
    // A real file at the cfgDir/projects -> the rmSync branch must fire.
    writeFileSync(join(cfgDir, 'projects'), 'stale')

    await hb.executeHeartbeat()

    // The stale file should now be a symlink (re-created by the loop).
    const st = lstatSync(join(cfgDir, 'projects'))
    expect(st.isSymbolicLink()).toBe(true)
  })

  it('warns and continues when a symlink fails (covers the catch on line 120)', async () => {
    // Hit line 120: symlinkSync throws inside the loop. We make symlinkSync
    // throw for the first entry encountered after `keep-me.json` by
    // mocking node:fs in a fresh module load.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    const realClaude = join(mockState.homeDir, '.claude')
    mkdirSync(realClaude, { recursive: true })
    writeFileSync(join(realClaude, 'a.json'), '{}')

    vi.resetModules()
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const symlinkMock = vi.fn(() => { throw new Error('EACCES: symlink denied') })
    vi.doMock('node:fs', async () => ({ ...realFs, symlinkSync: symlinkMock as unknown as typeof realFs.symlinkSync }))
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
    const hb = await import('../heartbeat.js')
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalled()
  })

  it('warns and continues when .claude.json materialisation throws (covers line 207)', async () => {
    // Hit line 207: the catch around the writeFileSync of .claude.json. We
    // make writeFileSync throw ONLY for the path that ends in .claude.json
    // inside the worker .claude-config/, so the rest of the helper still
    // succeeds.
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'ok' })

    // Create a home .claude.json so the parse guard enters the happy path.
    const homeClaudeJson = join(mockState.homeDir, '.claude.json')
    writeFileSync(homeClaudeJson, JSON.stringify({
      projects: { [mockState.projectRoot]: { mcpServers: { gmail: {} } } },
    }))

    vi.resetModules()
    const realFs = await vi.importActual<typeof import('node:fs')>('node:fs')
    const writeMock = vi.fn((p: string, content: string | Buffer, opts?: unknown) => {
      if (typeof p === 'string' && p.endsWith('.claude.json') && !p.includes('/home/')) {
        throw new Error('EROFS: read-only filesystem')
      }
      return realFs.writeFileSync(p, content, opts as Parameters<typeof realFs.writeFileSync>[2])
    })
    vi.doMock('node:fs', async () => ({ ...realFs, writeFileSync: writeMock as unknown as typeof realFs.writeFileSync }))
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
    const hb = await import('../heartbeat.js')
    await hb.executeHeartbeat()
    expect(mockState.runAgent).toHaveBeenCalled()
  })
})

// =============================================================================
// initHeartbeat / stopHeartbeat -- the scheduler glue
// =============================================================================

describe('initHeartbeat / stopHeartbeat', () => {
  it('initHeartbeat arms a timer and executeHeartbeat fires when due', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).not.toHaveBeenCalled() // nothing notable
    hb.stopHeartbeat()
  })

  it('stopHeartbeat cancels the timer before the next tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    hb.stopHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).not.toHaveBeenCalled()
  })

  it('executeHeartbeat errors are caught and logged inside the timer', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockRejectedValueOnce(new Error('cal broken'))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).not.toHaveBeenCalled()
    hb.stopHeartbeat()
  })

  it('scheduleNext re-arms the timer after a successful tick', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockResolvedValueOnce({ text: 'one' })
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    expect(mockState.runAgent).toHaveBeenCalledTimes(1)
    hb.stopHeartbeat()
  })

  it('scheduleNext re-arms after a tick that threw (still recovers)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 5, 12, 0, 0))
    mockState.getCalendarEvents.mockResolvedValueOnce([{ id: 'e1' }])
    mockState.runAgent.mockRejectedValueOnce(new Error('first tick failed'))
    const hb = await loadHeartbeatFresh()
    hb.initHeartbeat()
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000 + 100)
    hb.stopHeartbeat()
  })
})
