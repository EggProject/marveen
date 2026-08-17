// Full-surface unit suite for src/web/routes/background-tasks.ts.
//
// Covers:
//   * spawnBackgroundTask -- concurrency rejection, tmux spawn failure,
//     happy path (session name, argv, BG_PROMPT env, scheduled timers).
//   * pollUntilDone (reached through the 10s interval spawnBackgroundTask
//     installs) -- task vanished / no longer running / no session / session
//     died / ___BG_DONE___ marker / capture failure / marker not yet there.
//   * checkAndFinalize (reached through the 30min timeout) -- still running
//     with and without a session, already finished, empty capture.
//   * sweepOrphanedBackgroundTasks -- orphan with/without session, capture
//     fallback, live session re-arming the watchers, orphan counter log.
//   * tryHandleBackgroundTasks -- POST validation + 429 + 201, GET list with
//     agent/all filters and label formatting, GET one (404 / live output /
//     finished), DELETE (404 / kill / fallback output), and the
//     "not my route" false returns.
//
// Every side effect (tmux via node:child_process, id generation via
// node:crypto, db, config, logger) is mocked; the module under test is
// imported AFTER the mocks so its module graph sees them. `../http-helpers.js`
// is deliberately delegated to the real implementation through importActual:
// it is a pure request/response helper with no db, fs or network reach, and
// exercising the real `json()` is what makes the status-code assertions
// meaningful.
//
// Timers: the module installs a 30-minute setTimeout and a 10-second
// setInterval per task. The suite runs on vi.useFakeTimers() throughout, so
// nothing is ever wall-clock dependent.

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from 'vitest'
import { Readable } from 'node:stream'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted harness: every vi.mock factory reads from this object so a test can
// re-point a collaborator without re-importing the module under test.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  // node:child_process
  execFileSync: vi.fn(),
  execSync: vi.fn(),
  // node:crypto -- randomBytes(4) drives the task id.
  idBytes: 'abcd12ef',
  // db
  createBackgroundTaskAtomic: vi.fn(),
  finishBackgroundTask: vi.fn(),
  getBackgroundTasks: vi.fn(),
  getBackgroundTask: vi.fn(),
  getRunningBackgroundTasks: vi.fn(),
  markOrphanedTasksFailed: vi.fn(),
  // logger
  logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
  // platform.resolveFromPath -- filled in below with sandbox paths.
  tmuxPath: '/usr/bin/tmux',
  claudePath: '/usr/bin/claude',
}))

const TZ = 'Europe/Budapest'

vi.mock('node:child_process', () => ({
  execFileSync: H.execFileSync,
  execSync: H.execSync,
}))

vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>()
  return { ...actual, randomBytes: () => Buffer.from(H.idBytes, 'hex') }
})

vi.mock('../platform.js', () => ({
  resolveFromPath: (name: string) => (name === 'tmux' ? H.tmuxPath : H.claudePath),
  makeLazyBinResolver: (name: string) => () => (name === 'tmux' ? H.tmuxPath : H.claudePath),
}))

vi.mock('../db.js', () => ({
  createBackgroundTaskAtomic: H.createBackgroundTaskAtomic,
  finishBackgroundTask: H.finishBackgroundTask,
  getBackgroundTasks: H.getBackgroundTasks,
  getBackgroundTask: H.getBackgroundTask,
  getRunningBackgroundTasks: H.getRunningBackgroundTasks,
  markOrphanedTasksFailed: H.markOrphanedTasksFailed,
}))

vi.mock('../config.js', () => ({ APP_TZ: TZ }))

vi.mock('../logger.js', () => {
  const push = (level: string) => (obj: unknown, msg?: unknown) => {
    H.logs.push({ level, obj, msg })
  }
  return { logger: { info: push('info'), warn: push('warn'), error: push('error'), debug: push('debug') } }
})

// Pure helper module: keep the real implementation so status codes and the
// JSON body are produced by production code, not by a stub.
vi.mock('../web/http-helpers.js', async (orig) => await orig<typeof import('../web/http-helpers.js')>())

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// TEMP sandbox: the resolved tmux / claude binaries point inside os.tmpdir()
// so nothing in the suite can ever reference a real install path. Created
// before the dynamic import below because TMUX / CLAUDE are module-level
// consts captured at import time.
const envSnapshot = snapshotEnv()
const SANDBOX = mkTempDir('bg-tasks-routes-')
const SANDBOX_BIN = join(SANDBOX, 'bin')
mkdirSync(SANDBOX_BIN, { recursive: true })
H.tmuxPath = join(SANDBOX_BIN, 'tmux')
H.claudePath = join(SANDBOX_BIN, 'claude')

// Imported AFTER every mock is registered.
const { tryHandleBackgroundTasks, spawnBackgroundTask, sweepOrphanedBackgroundTasks } = await import(
  '../web/routes/background-tasks.js'
)
type BackgroundTask = import('../db.js').BackgroundTask

afterAll(() => {
  envSnapshot.restore()
  rmTempDir(SANDBOX)
})

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------
const TASK_ID = H.idBytes.toUpperCase()
const SESSION = `bg-${TASK_ID}`
const POLL_MS = 10_000
const TIMEOUT_MS = 30 * 60 * 1000

function mkTask(over: Partial<BackgroundTask> = {}): BackgroundTask {
  return {
    id: TASK_ID,
    agent_id: 'agent-1',
    prompt: 'do the thing',
    status: 'running',
    tmux_session: SESSION,
    started_at: 1_700_000_000,
    finished_at: null,
    output: null,
    ...over,
  }
}

/** Expected label for a unix-seconds timestamp, computed the same way the
 *  route does. Keeps the assertion independent of the host ICU build. */
function label(seconds: number): string {
  return new Date(seconds * 1000).toLocaleString('hu-HU', { timeZone: TZ })
}

type TmuxSub = 'list-sessions' | 'capture-pane' | 'kill-session' | 'new-session'

interface TmuxPlan {
  /** Session names `list-sessions` reports as alive. */
  sessions?: string[]
  /** capture-pane output per session; a missing entry yields ''. */
  panes?: Record<string, string>
  /** Subcommands that should throw (tmux missing, session gone, ...). */
  fail?: TmuxSub[]
}

const tmuxCalls: Array<{ sub: TmuxSub; args: string[]; env?: NodeJS.ProcessEnv }> = []

function programTmux(plan: TmuxPlan = {}): void {
  const fail = new Set<TmuxSub>(plan.fail ?? [])
  H.execFileSync.mockImplementation(
    (bin: string, args: string[], opts?: { env?: NodeJS.ProcessEnv }) => {
      expect(bin).toBe(H.tmuxPath)
      const sub = args[0] as TmuxSub
      tmuxCalls.push({ sub, args, env: opts?.env })
      if (fail.has(sub)) throw new Error(`tmux ${sub} failed`)
      if (sub === 'list-sessions') return `${(plan.sessions ?? []).join('\n')}\n`
      if (sub === 'capture-pane') return plan.panes?.[args[2]] ?? ''
      return ''
    },
  )
}

function callsOf(sub: TmuxSub): Array<{ sub: TmuxSub; args: string[]; env?: NodeJS.ProcessEnv }> {
  return tmuxCalls.filter(c => c.sub === sub)
}

// --- HTTP doubles ----------------------------------------------------------
interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  ended: boolean
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}

function mkRes(): MockRes {
  const res: MockRes = {
    statusCode: 0,
    headers: {},
    body: '',
    ended: false,
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      this.ended = true
      if (data !== undefined) this.body += data
    },
  }
  return res
}

function mkReq(body?: unknown): http.IncomingMessage {
  const payload =
    body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))]
  const r = Readable.from(payload) as unknown as http.IncomingMessage
  r.headers = {}
  return r
}

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; query?: string } = {},
): Promise<{ res: MockRes; handled: boolean; json: <T = Record<string, unknown>>() => T }> {
  const res = mkRes()
  const ctx: RouteContext = {
    req: mkReq(opts.body),
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}${opts.query ?? ''}`),
  }
  const handled = await tryHandleBackgroundTasks(ctx)
  return { res, handled, json: <T,>() => JSON.parse(res.body || '{}') as T }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useFakeTimers({ shouldAdvanceTime: false })
  H.logs.length = 0
  tmuxCalls.length = 0
  H.idBytes = 'abcd12ef'
  programTmux({ sessions: [SESSION] })
  H.createBackgroundTaskAtomic.mockReturnValue(mkTask())
  H.getBackgroundTask.mockReturnValue(undefined)
  H.getBackgroundTasks.mockReturnValue([])
  H.getRunningBackgroundTasks.mockReturnValue([])
})

afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// spawnBackgroundTask
// ---------------------------------------------------------------------------
describe('spawnBackgroundTask', () => {
  it('rejects when the per-agent concurrency cap is reached', () => {
    H.createBackgroundTaskAtomic.mockReturnValue(null)

    const result = spawnBackgroundTask('agent-1', 'hello')

    expect(result).toEqual({ error: 'Maximum 3 egyidejű háttérfeladat ágensenként.' })
    expect(H.execFileSync).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(0)
  })

  it('passes the id, session name and MAX_CONCURRENT to the atomic insert', () => {
    spawnBackgroundTask('agent-7', 'prompt text')

    expect(H.createBackgroundTaskAtomic).toHaveBeenCalledWith(
      TASK_ID, 'agent-7', 'prompt text', SESSION, 3,
    )
  })

  it('derives the task id from randomBytes as uppercase hex', () => {
    H.idBytes = '00ff10aa'
    spawnBackgroundTask('agent-1', 'hello')

    expect(H.createBackgroundTaskAtomic).toHaveBeenCalledWith(
      '00FF10AA', 'agent-1', 'hello', 'bg-00FF10AA', 3,
    )
  })

  it('spawns a detached tmux session running claude and returns the task', () => {
    const task = mkTask()
    H.createBackgroundTaskAtomic.mockReturnValue(task)

    const result = spawnBackgroundTask('agent-1', 'hello')

    expect(result).toBe(task)
    const spawn = callsOf('new-session')[0]
    expect(spawn.args.slice(0, 8)).toEqual([
      'new-session', '-d', '-s', SESSION, '-x', '200', '-y', '50',
    ])
    expect(spawn.args[8]).toContain(`${H.claudePath} -p "$BG_PROMPT" --output-format text`)
    expect(spawn.args[8]).toContain(`echo '___BG_DONE___'`)
    // The prompt travels in the environment, never inlined into the shell
    // string, so quoting in the prompt cannot break out of the command.
    expect(spawn.env?.BG_PROMPT).toBe('hello')
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'Background task started' }),
    )
  })

  it('truncates the logged prompt to 100 characters', () => {
    const prompt = 'x'.repeat(250)
    spawnBackgroundTask('agent-1', prompt)

    const entry = H.logs.find(l => l.msg === 'Background task started')
    expect((entry?.obj as { prompt: string }).prompt).toHaveLength(100)
  })

  it('arms the timeout and the poll interval on success', () => {
    spawnBackgroundTask('agent-1', 'hello')
    expect(vi.getTimerCount()).toBe(2)
  })

  it('marks the task failed and returns an error when tmux cannot start', () => {
    programTmux({ fail: ['new-session'] })

    const result = spawnBackgroundTask('agent-1', 'hello')

    expect(result).toEqual({ error: 'Nem sikerült elindítani a háttérfeladatot' })
    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', '(spawn failed)')
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'error', msg: 'Failed to spawn background task tmux session' }),
    )
    expect(vi.getTimerCount()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// pollUntilDone -- driven through the interval spawnBackgroundTask installs
// ---------------------------------------------------------------------------
describe('pollUntilDone', () => {
  function spawnAndPoll(): void {
    spawnBackgroundTask('agent-1', 'hello')
    tmuxCalls.length = 0
    vi.advanceTimersByTime(POLL_MS)
  }

  it('stops polling when the task row disappeared', () => {
    H.getBackgroundTask.mockReturnValue(undefined)
    spawnAndPoll()

    expect(vi.getTimerCount()).toBe(1) // only the 30min timeout survives
    expect(tmuxCalls).toHaveLength(0)
    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
  })

  it('stops polling when the task is no longer running', () => {
    H.getBackgroundTask.mockReturnValue(mkTask({ status: 'done' }))
    spawnAndPoll()

    expect(vi.getTimerCount()).toBe(1)
    expect(tmuxCalls).toHaveLength(0)
  })

  it('stops polling when the task has no tmux session', () => {
    H.getBackgroundTask.mockReturnValue(mkTask({ tmux_session: null }))
    spawnAndPoll()

    expect(vi.getTimerCount()).toBe(1)
    expect(tmuxCalls).toHaveLength(0)
    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
  })

  it('finishes the task as done when the tmux session vanished', () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: ['other-session'] })
    spawnAndPoll()

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'done', '(session ended)')
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'Background task session ended' }),
    )
    expect(vi.getTimerCount()).toBe(1)
  })

  it('treats a list-sessions failure as a dead session', () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ fail: ['list-sessions'] })
    spawnAndPoll()

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'done', '(session ended)')
  })

  it('captures the pane, strips the marker and kills the session when done', () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({
      sessions: [SESSION],
      panes: { [SESSION]: '  answer line 1\nanswer line 2\n___BG_DONE___\nnoise after\n' },
    })
    spawnAndPoll()

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(
      TASK_ID, 'done', 'answer line 1\nanswer line 2',
    )
    expect(callsOf('kill-session')[0].args).toEqual(['kill-session', '-t', SESSION])
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'Background task completed' }),
    )
    expect(vi.getTimerCount()).toBe(1)
  })

  it('swallows a kill-session failure after completion', () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({
      sessions: [SESSION],
      panes: { [SESSION]: 'out\n___BG_DONE___' },
      fail: ['kill-session'],
    })

    expect(() => spawnAndPoll()).not.toThrow()
    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'done', 'out')
  })

  it('keeps polling while the marker has not appeared yet', () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], panes: { [SESSION]: 'still working...' } })
    spawnAndPoll()

    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(2) // interval still armed

    // Marker shows up on the next tick.
    programTmux({ sessions: [SESSION], panes: { [SESSION]: 'done output\n___BG_DONE___' } })
    vi.advanceTimersByTime(POLL_MS)
    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'done', 'done output')
  })

  it('keeps polling when capture-pane fails', () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], fail: ['capture-pane'] })
    spawnAndPoll()

    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// checkAndFinalize -- driven through the 30 minute timeout
// ---------------------------------------------------------------------------
describe('checkAndFinalize', () => {
  /** Arm a task, then jump straight past the timeout. The interval is
   *  neutralised first so only the timeout callback observes the db. */
  function spawnAndTimeout(task: BackgroundTask | undefined): void {
    H.getBackgroundTask.mockReturnValue(mkTask({ status: 'done' }))
    spawnBackgroundTask('agent-1', 'hello')
    vi.advanceTimersByTime(POLL_MS) // clears the poll interval
    H.getBackgroundTask.mockReturnValue(task)
    H.finishBackgroundTask.mockClear()
    tmuxCalls.length = 0
    vi.advanceTimersByTime(TIMEOUT_MS)
  }

  it('does nothing when the task row disappeared', () => {
    spawnAndTimeout(undefined)
    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
  })

  it('does nothing when the task already finished', () => {
    spawnAndTimeout(mkTask({ status: 'failed' }))
    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
  })

  it('records the captured pane and kills the session', () => {
    programTmux({ sessions: [SESSION], panes: { [SESSION]: '  partial output  ' } })
    spawnAndTimeout(mkTask())

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'timeout', 'partial output')
    expect(callsOf('kill-session')).toHaveLength(1)
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'Background task timed out after 30 minutes' }),
    )
  })

  it('falls back to (timeout) when the pane is blank', () => {
    programTmux({ sessions: [SESSION], panes: { [SESSION]: '   \n  ' } })
    spawnAndTimeout(mkTask())

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'timeout', '(timeout)')
  })

  it('falls back to (timeout) when capture-pane fails', () => {
    programTmux({ sessions: [SESSION], fail: ['capture-pane'] })
    spawnAndTimeout(mkTask())

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'timeout', '(timeout)')
  })

  it('skips capture and kill when the task has no session', () => {
    spawnAndTimeout(mkTask({ tmux_session: null }))

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'timeout', '(timeout)')
    expect(tmuxCalls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// sweepOrphanedBackgroundTasks
// ---------------------------------------------------------------------------
describe('sweepOrphanedBackgroundTasks', () => {
  it('does nothing and logs nothing when no task is running', () => {
    sweepOrphanedBackgroundTasks()

    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
    expect(H.logs).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('fails a running task that never had a session', () => {
    H.getRunningBackgroundTasks.mockReturnValue([mkTask({ tmux_session: null })])

    sweepOrphanedBackgroundTasks()

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', '(orphaned on restart)')
    expect(tmuxCalls).toHaveLength(0)
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'info', obj: { orphaned: 1 }, msg: 'Swept orphaned background tasks on startup' }),
    )
  })

  it('keeps whatever the dead session left in the pane', () => {
    H.getRunningBackgroundTasks.mockReturnValue([mkTask()])
    programTmux({ sessions: [], panes: { [SESSION]: ' leftover output \n' } })

    sweepOrphanedBackgroundTasks()

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', 'leftover output')
  })

  it('falls back to (orphaned on restart) when the pane cannot be read', () => {
    H.getRunningBackgroundTasks.mockReturnValue([mkTask()])
    programTmux({ sessions: [], fail: ['capture-pane'] })

    sweepOrphanedBackgroundTasks()

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', '(orphaned on restart)')
  })

  it('re-arms the watchers for a task whose session survived', () => {
    H.getRunningBackgroundTasks.mockReturnValue([mkTask()])
    programTmux({ sessions: [SESSION], panes: { [SESSION]: 'working' } })

    sweepOrphanedBackgroundTasks()

    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
    expect(H.logs).toHaveLength(0)
    expect(vi.getTimerCount()).toBe(2)

    // The re-armed interval is a live poller: finish the task through it.
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], panes: { [SESSION]: 'result\n___BG_DONE___' } })
    vi.advanceTimersByTime(POLL_MS)
    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'done', 'result')
  })

  it('re-arms the 30 minute timeout for a surviving session', () => {
    H.getRunningBackgroundTasks.mockReturnValue([mkTask()])
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], panes: { [SESSION]: 'still working' } })

    sweepOrphanedBackgroundTasks()
    // The task never produces the marker, so only the timeout can end it.
    vi.advanceTimersByTime(TIMEOUT_MS)

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'timeout', 'still working')
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'warn', msg: 'Background task timed out after 30 minutes' }),
    )
  })

  it('counts only the orphans when live and dead sessions are mixed', () => {
    const alive = mkTask({ id: 'AAAAAAAA', tmux_session: 'bg-AAAAAAAA' })
    const dead = mkTask({ id: 'BBBBBBBB', tmux_session: 'bg-BBBBBBBB' })
    H.getRunningBackgroundTasks.mockReturnValue([alive, dead])
    programTmux({ sessions: ['bg-AAAAAAAA'], panes: { 'bg-BBBBBBBB': 'crashed' } })

    sweepOrphanedBackgroundTasks()

    expect(H.finishBackgroundTask).toHaveBeenCalledTimes(1)
    expect(H.finishBackgroundTask).toHaveBeenCalledWith('BBBBBBBB', 'failed', 'crashed')
    expect(H.logs).toContainEqual(
      expect.objectContaining({ obj: { orphaned: 1 } }),
    )
  })
})

// ---------------------------------------------------------------------------
// POST /api/background-tasks
// ---------------------------------------------------------------------------
describe('POST /api/background-tasks', () => {
  it('rejects a missing prompt', async () => {
    const { res, handled, json } = await call('POST', '/api/background-tasks', {
      body: { agent_id: 'agent-1' },
    })

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Prompt megadása kötelező' })
    expect(H.createBackgroundTaskAtomic).not.toHaveBeenCalled()
  })

  it('rejects a whitespace-only prompt', async () => {
    const { res } = await call('POST', '/api/background-tasks', {
      body: { agent_id: 'agent-1', prompt: '   ' },
    })

    expect(res.statusCode).toBe(400)
  })

  it('rejects a missing agent id', async () => {
    const { res, json } = await call('POST', '/api/background-tasks', {
      body: { prompt: 'hello' },
    })

    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Agent ID megadása kötelező' })
  })

  it('rejects a whitespace-only agent id', async () => {
    const { res, json } = await call('POST', '/api/background-tasks', {
      body: { agent_id: ' ', prompt: 'hello' },
    })

    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Agent ID megadása kötelező' })
  })

  it('returns 429 when the concurrency cap rejects the spawn', async () => {
    H.createBackgroundTaskAtomic.mockReturnValue(null)

    const { res, json } = await call('POST', '/api/background-tasks', {
      body: { agent_id: 'agent-1', prompt: 'hello' },
    })

    expect(res.statusCode).toBe(429)
    expect(json()).toEqual({ error: 'Maximum 3 egyidejű háttérfeladat ágensenként.' })
  })

  it('creates the task with trimmed inputs and answers 201', async () => {
    const task = mkTask()
    H.createBackgroundTaskAtomic.mockReturnValue(task)

    const { res, handled, json } = await call('POST', '/api/background-tasks', {
      body: { agent_id: '  agent-9 ', prompt: '  do it  ' },
    })

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(201)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(json()).toEqual(task)
    expect(H.createBackgroundTaskAtomic).toHaveBeenCalledWith(TASK_ID, 'agent-9', 'do it', SESSION, 3)
  })

  it('returns 400 with { error: "Invalid JSON" } when the body is not parseable (pinned defect)', async () => {
    const { res, json } = await call('POST', '/api/background-tasks', { body: 'not-json{' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
    expect(H.createBackgroundTaskAtomic).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// GET /api/background-tasks
// ---------------------------------------------------------------------------
describe('GET /api/background-tasks', () => {
  it('lists running tasks with formatted labels', async () => {
    const task = mkTask()
    H.getBackgroundTasks.mockReturnValue([task])

    const { res, handled, json } = await call('GET', '/api/background-tasks')

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.getBackgroundTasks).toHaveBeenCalledWith(undefined, false)
    expect(json<Array<Record<string, unknown>>>()[0]).toEqual({
      ...task,
      started_label: label(task.started_at),
      finished_label: null,
    })
  })

  it('passes the agent filter and all=true through', async () => {
    const task = mkTask({ status: 'done', finished_at: 1_700_003_600 })
    H.getBackgroundTasks.mockReturnValue([task])

    const { json } = await call('GET', '/api/background-tasks', { query: '?agent=agent-3&all=true' })

    expect(H.getBackgroundTasks).toHaveBeenCalledWith('agent-3', true)
    expect(json<Array<Record<string, unknown>>>()[0].finished_label).toBe(label(1_700_003_600))
  })

  it('treats an empty agent parameter as no filter and all!=true as false', async () => {
    await call('GET', '/api/background-tasks', { query: '?agent=&all=1' })

    expect(H.getBackgroundTasks).toHaveBeenCalledWith(undefined, false)
  })
})

// ---------------------------------------------------------------------------
// GET /api/background-tasks/:id
// ---------------------------------------------------------------------------
describe('GET /api/background-tasks/:id', () => {
  it('404s an unknown id', async () => {
    H.getBackgroundTask.mockReturnValue(undefined)

    const { res, handled, json } = await call('GET', `/api/background-tasks/${TASK_ID}`)

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Háttérfeladat nem található' })
  })

  it('attaches the live pane for a running task', async () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], panes: { [SESSION]: 'live text' } })

    const { json } = await call('GET', `/api/background-tasks/${TASK_ID}`)

    expect(json().liveOutput).toBe('live text')
    expect(callsOf('capture-pane')[0].args).toEqual(['capture-pane', '-t', SESSION, '-p', '-S', '-500'])
  })

  it('returns liveOutput null when the running task has no session', async () => {
    H.getBackgroundTask.mockReturnValue(mkTask({ tmux_session: null }))

    const { json } = await call('GET', `/api/background-tasks/${TASK_ID}`)

    expect(json().liveOutput).toBeNull()
    expect(tmuxCalls).toHaveLength(0)
  })

  it('does not capture a pane for a finished task and labels finished_at', async () => {
    const task = mkTask({ status: 'done', finished_at: 1_700_000_600, output: 'result' })
    H.getBackgroundTask.mockReturnValue(task)

    const { json } = await call('GET', `/api/background-tasks/${TASK_ID}`)

    expect(json()).toEqual({
      ...task,
      liveOutput: null,
      started_label: label(task.started_at),
      finished_label: label(1_700_000_600),
    })
    expect(tmuxCalls).toHaveLength(0)
  })

  it('returns liveOutput null when capture-pane fails', async () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], fail: ['capture-pane'] })

    const { json } = await call('GET', `/api/background-tasks/${TASK_ID}`)

    expect(json().liveOutput).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// DELETE /api/background-tasks/:id
// ---------------------------------------------------------------------------
describe('DELETE /api/background-tasks/:id', () => {
  it('404s an unknown id', async () => {
    H.getBackgroundTask.mockReturnValue(undefined)

    const { res, json } = await call('DELETE', `/api/background-tasks/${TASK_ID}`)

    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Háttérfeladat nem található' })
    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
  })

  it('kills the session and stores the captured output', async () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], panes: { [SESSION]: ' half done \n' } })

    const { res, handled, json } = await call('DELETE', `/api/background-tasks/${TASK_ID}`)

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, status: 'cancelled' })
    expect(callsOf('kill-session')).toHaveLength(1)
    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', 'half done')
    expect(H.logs).toContainEqual(
      expect.objectContaining({ level: 'info', msg: 'Background task cancelled via DELETE' }),
    )
  })

  it('falls back to (cancelled) when the pane is empty', async () => {
    H.getBackgroundTask.mockReturnValue(mkTask())
    programTmux({ sessions: [SESSION], panes: { [SESSION]: '  ' } })

    await call('DELETE', `/api/background-tasks/${TASK_ID}`)

    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', '(cancelled)')
  })

  it('skips tmux entirely when the task has no session', async () => {
    H.getBackgroundTask.mockReturnValue(mkTask({ tmux_session: null }))

    await call('DELETE', `/api/background-tasks/${TASK_ID}`)

    expect(tmuxCalls).toHaveLength(0)
    expect(H.finishBackgroundTask).toHaveBeenCalledWith(TASK_ID, 'failed', '(cancelled)')
  })

  it('does not kill a session for an already finished task', async () => {
    H.getBackgroundTask.mockReturnValue(mkTask({ status: 'done', output: 'result' }))

    const { res, handled, json } = await call('DELETE', `/api/background-tasks/${TASK_ID}`)

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(tmuxCalls).toHaveLength(0)
    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
    expect(json()).toEqual({ ok: true, status: 'done' })
  })

  it.each(['done', 'failed', 'timeout'] as const)(
    'returns the terminal status without touching tmux for status=%s',
    async (status) => {
      H.getBackgroundTask.mockReturnValue(mkTask({ status }))

      const { json } = await call('DELETE', `/api/background-tasks/${TASK_ID}`)

      expect(tmuxCalls).toHaveLength(0)
      expect(H.finishBackgroundTask).not.toHaveBeenCalled()
      expect(json()).toEqual({ ok: true, status })
    },
  )
})

// ---------------------------------------------------------------------------
// Routes the module does not own
// ---------------------------------------------------------------------------
describe('tryHandleBackgroundTasks fallthrough', () => {
  it.each([
    ['GET', '/api/agents'],
    ['PUT', '/api/background-tasks'],
    ['DELETE', '/api/background-tasks'],
    ['POST', `/api/background-tasks/${TASK_ID}`],
    ['GET', '/api/background-tasks/abcd12ef'],       // lowercase id
    ['GET', '/api/background-tasks/ABCD12E'],        // too short
    ['GET', `/api/background-tasks/${TASK_ID}/logs`], // trailing segment
  ])('returns false for %s %s', async (method, path) => {
    const { res, handled } = await call(method, path)

    expect(handled).toBe(false)
    expect(res.ended).toBe(false)
    expect(H.finishBackgroundTask).not.toHaveBeenCalled()
  })
})
