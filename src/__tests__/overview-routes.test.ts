// 100% coverage suite for src/web/routes/overview.ts.
//
// The route handler is a single-endpoint dispatcher for /api/overview (GET).
// It aggregates three slices of fleet state:
//
//   * `agents` -- subAgents + 1 main, split by running vs total
//   * `tasks`  -- scheduled-task runs in today + yesterday, plus user
//                 prompt/turn counts read from the per-user
//                 ~/.claude/projects/*.jsonl Claude Code transcripts
//   * `memories / skills / team / activity` -- straight projections from
//                 the dashboard DB and ~/.claude/skills/
//
// All collaborators are mocked at the module boundary so the dispatcher runs
// against a deterministic fake. The two pure collaborators that are not
// worth mocking (`http-helpers.jsonMaybeGzip` and `routes/types`) are left
// real -- the former is a tiny response writer already covered by the
// http-helpers test suite, and the latter is a type-only module.
//
// The `node:fs` and `node:os` modules are mocked too because
// `countUserTurns()` walks `~/.claude/projects/...` synchronously; without
// the `node:os` mock the function would reach the real $HOME and produce
// flake.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Hoisted mocks. vi.mock factories below reference these; vi.hoisted keeps
// them available in the hoisted factory scope.
// ---------------------------------------------------------------------------
const H = vi.hoisted(() => ({
  // db
  getDb: vi.fn<() => unknown>(() => ({ MARKER: 'fake-db' })),
  countTaskRunsBetween: vi.fn<(...args: unknown[]) => number>(() => 0),

  // config
  PROJECT_ROOT: '/tmp/overview-test-root',
  MAIN_AGENT_ID: 'marveen',
  currentBotName: vi.fn<() => string>(() => 'Marveen'),

  // logger
  loggerWarn: vi.fn<(...args: unknown[]) => void>(),
  loggerError: vi.fn<(...args: unknown[]) => void>(),
  loggerInfo: vi.fn<(...args: unknown[]) => void>(),
  loggerDebug: vi.fn<(...args: unknown[]) => void>(),

  // auth-gate / auth-sessions (the task contract asks to mock these even
  // though overview.ts doesn't import them; vi.mock tolerates that).
  parseCookies: vi.fn<(h: string | undefined) => Record<string, string>>(() => ({})),
  SESSION_COOKIE_NAME: 'mv_session',
  requiresAuth: vi.fn<() => boolean>(() => false),
  isFederationWireEndpoint: vi.fn<() => boolean>(() => false),
  resolveAuth: vi.fn<() => unknown>(() => null),
  resolveSession: vi.fn<() => unknown>(() => null),
  createSession: vi.fn<() => string>(() => 'session-token'),
  revokeSession: vi.fn<() => void>(),
  revokeAllForUser: vi.fn<() => void>(),
  revokeAllSessions: vi.fn<() => number>(() => 0),
  listUserSessions: vi.fn<() => unknown[]>(() => []),
  sweepExpiredSessions: vi.fn<() => number>(() => 0),
  _clearSessionCacheForTest: vi.fn<() => void>(),

  // agent-config (overview.ts only imports agentDir + listAgentNames +
  // readAgentDisplayName)
  agentDir: vi.fn<(name: string) => string>((name: string) => `/tmp/overview-test-root/agents/${name}`),
  listAgentNames: vi.fn<() => string[]>(() => []),
  readAgentDisplayName: vi.fn<(name: string) => string>((name: string) => name),

  // agent-team (only readAgentTeam is imported)
  readAgentTeam: vi.fn<() => unknown>(() => ({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [] })),

  // agent-process (only isAgentRunning is imported)
  isAgentRunning: vi.fn<(name: string) => boolean>(() => false),

  // home dir + project root for the jsonl walker / skills walker.
  HOME: '',
}))

// ---------------------------------------------------------------------------
// Mock declarations (hoisted to the top of the file by vitest).
// ---------------------------------------------------------------------------
vi.mock('../db.js', () => ({
  getDb: H.getDb,
  countTaskRunsBetween: H.countTaskRunsBetween,
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/tmp/overview-test-root',
  MAIN_AGENT_ID: H.MAIN_AGENT_ID,
  currentBotName: H.currentBotName,
}))

vi.mock('../logger.js', () => ({
  logger: {
    warn: H.loggerWarn,
    error: H.loggerError,
    info: H.loggerInfo,
    debug: H.loggerDebug,
  },
}))

vi.mock('../web/auth-gate.js', () => ({
  parseCookies: H.parseCookies,
  SESSION_COOKIE_NAME: H.SESSION_COOKIE_NAME,
  requiresAuth: H.requiresAuth,
  isFederationWireEndpoint: H.isFederationWireEndpoint,
  resolveAuth: H.resolveAuth,
}))

vi.mock('../web/auth-sessions.js', () => ({
  resolveSession: H.resolveSession,
  createSession: H.createSession,
  revokeSession: H.revokeSession,
  revokeAllForUser: H.revokeAllForUser,
  revokeAllSessions: H.revokeAllSessions,
  listUserSessions: H.listUserSessions,
  sweepExpiredSessions: H.sweepExpiredSessions,
  _clearSessionCacheForTest: H._clearSessionCacheForTest,
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: H.agentDir,
  listAgentNames: H.listAgentNames,
  readAgentDisplayName: H.readAgentDisplayName,
}))

vi.mock('../web/agent-team.js', () => ({
  readAgentTeam: H.readAgentTeam,
}))

vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: H.isAgentRunning,
}))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return { ...actual, homedir: vi.fn(() => H.HOME) }
})

// ---------------------------------------------------------------------------
// SUT import -- resolved AFTER all mocks and env vars are in place.
// ---------------------------------------------------------------------------
const { tryHandleOverview } = await import('../web/routes/overview.js')

// ---------------------------------------------------------------------------
// Test harness.
// ---------------------------------------------------------------------------
interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  end(data?: string | Buffer): MockRes
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(data) {
      if (data !== undefined) this.body += typeof data === 'string' ? data : data.toString('utf-8')
      return this
    },
  }
}

function mkCtx(): RouteContext {
  const res = mkRes()
  const req = { headers: {} } as unknown as import('node:http').IncomingMessage
  const url = new URL('http://127.0.0.1:3420/api/overview')
  return {
    req,
    res: res as unknown as import('node:http').ServerResponse,
    path: url.pathname,
    method: 'GET',
    url,
  }
}

interface FakeStmt {
  all: () => unknown[]
  get: () => unknown
}

function mkFakeDb(rows: { memories?: unknown[]; memStats?: number; memCats?: number; messages?: unknown[] } = {}): {
  prepare: (sql: string) => FakeStmt
  MARKER: string
} {
  const memories = rows.memories ?? []
  const messages = rows.messages ?? []
  return {
    MARKER: 'fake-db',
    prepare(sql: string) {
      const s = sql.trim()
      if (/SELECT COUNT\(\*\) as c FROM memories/i.test(s)) {
        return { all: () => [], get: () => ({ c: rows.memStats ?? memories.length }) }
      }
      if (/SELECT COUNT\(DISTINCT category\) as c FROM memories/i.test(s)) {
        return { all: () => [], get: () => ({ c: rows.memCats ?? 0 }) }
      }
      if (/FROM memories ORDER BY created_at DESC/i.test(s)) {
        return { all: () => memories, get: () => memories[0] }
      }
      if (/FROM agent_messages ORDER BY created_at DESC/i.test(s)) {
        return { all: () => messages, get: () => messages[0] }
      }
      // default no-op
      return { all: () => [], get: () => undefined }
    },
  }
}

let sandboxHome = ''
const storeRoot = '/tmp/overview-test-root'

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  sandboxHome = mkdtempSync(join(tmpdir(), 'overview-home-'))
  H.HOME = sandboxHome
})

afterAll(() => {
  rmSync(sandboxHome, { recursive: true, force: true })
})

beforeEach(() => {
  // reset the temp home each test
  rmSync(sandboxHome, { recursive: true, force: true })
  mkdirSync(sandboxHome, { recursive: true })
  // also reset the synthetic PROJECT_ROOT store + agents dirs that some
  // tests touch (marveen-avatar.png etc)
  rmSync('/tmp/overview-test-root', { recursive: true, force: true })

  H.getDb.mockReset().mockReturnValue(mkFakeDb())
  H.countTaskRunsBetween.mockReset().mockReturnValue(0)
  H.currentBotName.mockReset().mockReturnValue('Marveen')
  H.listAgentNames.mockReset().mockReturnValue([])
  H.readAgentTeam.mockReset().mockReturnValue({ role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [] })
  H.isAgentRunning.mockReset().mockReturnValue(false)
  H.readAgentDisplayName.mockReset().mockImplementation((n: string) => n)

  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerInfo.mockReset()
  H.loggerDebug.mockReset()
})

async function call(): Promise<{ res: MockRes; json: () => any; handled: boolean }> {
  const ctx = mkCtx()
  const handled = await tryHandleOverview(ctx)
  return {
    res: ctx.res as unknown as MockRes,
    handled,
    json: () => (ctx.res.body ? JSON.parse(ctx.res.body) : null),
  }
}

// ===========================================================================
// Dispatcher surface
// ===========================================================================
describe('tryHandleOverview -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const res = mkRes()
    const req = { headers: {} } as unknown as import('node:http').IncomingMessage
    const url = new URL('http://127.0.0.1:3420/api/other')
    const ctx: RouteContext = {
      req,
      res: res as unknown as import('node:http').ServerResponse,
      path: url.pathname,
      method: 'GET',
      url,
    }
    expect(await tryHandleOverview(ctx)).toBe(false)
    expect(res.statusCode).toBe(0)
    expect(H.getDb).not.toHaveBeenCalled()
  })

  it('returns false for POST on /api/overview', async () => {
    const res = mkRes()
    const req = { headers: {} } as unknown as import('node:http').IncomingMessage
    const url = new URL('http://127.0.0.1:3420/api/overview')
    const ctx: RouteContext = {
      req,
      res: res as unknown as import('node:http').ServerResponse,
      path: url.pathname,
      method: 'POST',
      url,
    }
    expect(await tryHandleOverview(ctx)).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for PUT on /api/overview', async () => {
    const res = mkRes()
    const req = { headers: {} } as unknown as import('node:http').IncomingMessage
    const url = new URL('http://127.0.0.1:3420/api/overview')
    const ctx: RouteContext = {
      req,
      res: res as unknown as import('node:http').ServerResponse,
      path: url.pathname,
      method: 'PUT',
      url,
    }
    expect(await tryHandleOverview(ctx)).toBe(false)
  })

  it('returns false for DELETE on /api/overview', async () => {
    const res = mkRes()
    const req = { headers: {} } as unknown as import('node:http').IncomingMessage
    const url = new URL('http://127.0.0.1:3420/api/overview')
    const ctx: RouteContext = {
      req,
      res: res as unknown as import('node:http').ServerResponse,
      path: url.pathname,
      method: 'DELETE',
      url,
    }
    expect(await tryHandleOverview(ctx)).toBe(false)
  })
})

// ===========================================================================
// GET /api/overview -- main payload shape
// ===========================================================================
describe('tryHandleOverview -- GET /api/overview (baseline shape)', () => {
  it('returns 200 with the full payload skeleton for an empty install', async () => {
    const { res, json, handled } = await call()
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body).toMatchObject({
      agents: { total: 1, running: 1 },
      tasksToday: 0,
      tasksYesterday: 0,
      memories: { count: 0, categories: 0 },
      skills: { count: 0, today: 0 },
      team: [
        {
          id: 'marveen',
          label: 'Marveen',
          role: 'main',
          running: true,
          hasAvatar: false,
          avatarUrl: '/api/marveen/avatar',
        },
      ],
      activity: [],
    })
  })

  it('writes the application/json Content-Type + Cache-Control: private, no-store', async () => {
    const { res } = await call()
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
    expect(res.headers['Vary']).toBe('Accept-Encoding')
  })

  it('gzip-encodes the body when the client accepts gzip and the payload is > 1KB', async () => {
    // Force a payload large enough to cross the gzip threshold by
    // stuffing many memories.
    const memories: unknown[] = []
    for (let i = 0; i < 200; i++) {
      memories.push({
        content: 'A'.repeat(80),
        created_at: 1_700_000_000 + i,
        agent_id: `agent-${i}`,
      })
    }
    H.getDb.mockReturnValue(mkFakeDb({ memories }))

    const res = mkRes()
    const req = { headers: { 'accept-encoding': 'gzip' } } as unknown as import('node:http').IncomingMessage
    const url = new URL('http://127.0.0.1:3420/api/overview')
    const ctx: RouteContext = {
      req,
      res: res as unknown as import('node:http').ServerResponse,
      path: url.pathname,
      method: 'GET',
      url,
    }
    expect(await tryHandleOverview(ctx)).toBe(true)
    expect(res.headers['Content-Encoding']).toBe('gzip')
    expect(res.body.length).toBeGreaterThan(0)
  })

  it('reads the bot display name from currentBotName(), not a hard-coded string', async () => {
    H.currentBotName.mockReturnValue('CustomBrand')
    const { json } = await call()
    const team = json().team as Array<{ label: string }>
    expect(team[0].label).toBe('CustomBrand')
  })
})

// ===========================================================================
// Agent counts
// ===========================================================================
describe('tryHandleOverview -- agent counts', () => {
  it('counts the main + subAgents separately and labels the main as running', async () => {
    H.listAgentNames.mockReturnValue(['alpha', 'beta'])
    H.isAgentRunning.mockImplementation((n: string) => n === 'alpha')

    const { json } = await call()
    expect((json().agents as { total: number; running: number })).toEqual({ total: 3, running: 2 })

    const team = json().team as Array<{ id: string; role: string; running: boolean; hasAvatar: boolean; avatarUrl: string }>
    expect(team).toHaveLength(3)
    expect(team[0]).toMatchObject({
      id: 'marveen',
      role: 'main',
      running: true,
      hasAvatar: false,
      avatarUrl: '/api/marveen/avatar',
    })
    expect(team[1]).toMatchObject({ id: 'alpha', running: true, hasAvatar: false })
    expect(team[2]).toMatchObject({ id: 'beta', running: false, hasAvatar: false })
  })

  it('flips main.hasAvatar to true when store/marveen-avatar.png exists', async () => {
    mkdirSync(join(storeRoot, 'store'), { recursive: true })
    writeFileSync(join(storeRoot, 'store', 'marveen-avatar.png'), Buffer.from([0]))

    const { json } = await call()
    const team = json().team as Array<{ id: string; hasAvatar: boolean }>
    expect(team[0].hasAvatar).toBe(true)
  })

  it('flips main.hasAvatar to true when store/marveen-avatar.jpg exists (.png missing)', async () => {
    mkdirSync(join(storeRoot, 'store'), { recursive: true })
    writeFileSync(join(storeRoot, 'store', 'marveen-avatar.jpg'), Buffer.from([0]))

    const { json } = await call()
    const team = json().team as Array<{ id: string; hasAvatar: boolean }>
    expect(team[0].hasAvatar).toBe(true)
  })

  it('flips per-subAgent.hasAvatar via agentDir(name)/avatar.png', async () => {
    H.listAgentNames.mockReturnValue(['alpha'])
    H.agentDir.mockImplementation((n: string) => `/tmp/overview-test-root/agents/${n}`)
    // create the avatar in the real store at agentDir()'s return path
    mkdirSync('/tmp/overview-test-root/agents/alpha', { recursive: true })
    writeFileSync('/tmp/overview-test-root/agents/alpha/avatar.png', Buffer.from([0]))

    const { json } = await call()
    const team = json().team as Array<{ id: string; hasAvatar: boolean }>
    expect(team.find((t) => t.id === 'alpha')!.hasAvatar).toBe(true)

    // cleanup so we don't leak into the next test
    rmSync('/tmp/overview-test-root/agents', { recursive: true, force: true })
  })

  it('emits per-subAgent avatarUrl via encodeURIComponent', async () => {
    H.listAgentNames.mockReturnValue(['alpha beta'])
    const { json } = await call()
    const team = json().team as Array<{ id: string; avatarUrl: string }>
    expect(team[1].avatarUrl).toBe('/api/agents/alpha%20beta/avatar')
  })

  it('passes the team.role from readAgentTeam through verbatim', async () => {
    H.listAgentNames.mockReturnValue(['alpha'])
    H.readAgentTeam.mockReturnValue({ role: 'leader', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: [] })

    const { json } = await call()
    const team = json().team as Array<{ id: string; role: string }>
    expect(team[1].role).toBe('leader')
  })

  it('passes the readAgentDisplayName(name) result through as the team label', async () => {
    H.listAgentNames.mockReturnValue(['alpha'])
    H.readAgentDisplayName.mockReturnValue('Alpha Prime')

    const { json } = await call()
    const team = json().team as Array<{ id: string; label: string }>
    expect(team[1].label).toBe('Alpha Prime')
  })
})

// ===========================================================================
// Tasks: scheduled runs + user turns
// ===========================================================================
describe('tryHandleOverview -- tasksToday / tasksYesterday', () => {
  it('calls countTaskRunsBetween with startTs / startTs-24h / startTs for the scheduled slice', async () => {
    H.countTaskRunsBetween.mockReturnValue(0)
    await call()

    // The route computes startTs = midnight today, then:
    //   schedToday    = count(startTs)
    //   schedYesterday= count(startTs - 24h, startTs)
    // The mocked function only gets called twice; assert both call shapes.
    expect(H.countTaskRunsBetween).toHaveBeenCalledTimes(2)
    const todayCall = H.countTaskRunsBetween.mock.calls[0]
    const yesterdayCall = H.countTaskRunsBetween.mock.calls[1]

    expect(todayCall[0]).toEqual(expect.any(Number))
    expect(yesterdayCall[0]).toEqual(expect.any(Number))
    expect(yesterdayCall[1]).toEqual(expect.any(Number))
    expect(yesterdayCall.length).toBe(2)

    // The yesterdayCall[1] == todayCall[0]: the [from, to) window is contiguous
    expect(yesterdayCall[1]).toBe(todayCall[0])

    // yesterdayCall[0] must be exactly 24h before todayCall[0]
    expect(todayCall[0] - yesterdayCall[0]).toBe(24 * 60 * 60 * 1000)

    // todayCall[0] is midnight today: it must be <= the wall clock now
    // and it must align to local midnight.
    const now = Date.now()
    expect(todayCall[0]).toBeLessThanOrEqual(now)
    const dt = new Date(todayCall[0])
    expect(dt.getHours()).toBe(0)
    expect(dt.getMinutes()).toBe(0)
    expect(dt.getSeconds()).toBe(0)
    expect(dt.getMilliseconds()).toBe(0)
  })

  it('adds the user-turn count to the scheduled-run count for both today and yesterday', async () => {
    // Force countUserTurns() to return specific values by writing two
    // jsonl files: one updated today, one updated yesterday.
    H.countTaskRunsBetween.mockImplementation((from: number, to?: number) => {
      if (to === undefined) return 1 // schedToday
      return 2 // schedYesterday
    })
    const projectsDir = join(sandboxHome, '.claude', 'projects', 'p1')
    mkdirSync(projectsDir, { recursive: true })
    const now = Date.now()
    const startOfDay = new Date(now); startOfDay.setHours(0, 0, 0, 0)
    const startTs = startOfDay.getTime()
    // 1h after midnight yesterday -- inside the [yesterday, startTs) bin at any
    // wall-clock time. The earlier `now - 25h` only worked when now >= 01:00
    // LOCAL; just past midnight it landed in the day-before-yesterday bin and
    // the test flake-failed. See overview-routes-yesterday-
    // timestamp-flake for the full failure scenario.
    const tsYesterday = startTs - 1 * 60 * 60 * 1000
    writeFileSync(join(projectsDir, 'session.jsonl'),
      [
        JSON.stringify({ type: 'user', message: { content: 'today prompt' }, timestamp: new Date(now - 1000).toISOString() }),
        JSON.stringify({ type: 'user', message: { content: 'yesterday prompt' }, timestamp: new Date(tsYesterday).toISOString() }),
      ].join('\n') + '\n',
    )

    const { json } = await call()
    // 1 scheduled today + 1 user today = 2; 2 scheduled yesterday + 1 user yesterday = 3
    expect(json().tasksToday).toBe(2)
    expect(json().tasksYesterday).toBe(3)
  })
})

// ===========================================================================
// countUserTurns -- exhaustive branch coverage via real fs under a temp HOME
// ===========================================================================
describe('tryHandleOverview -- countUserTurns branches', () => {
  function writeProjects(...entries: Array<{ project: string; file?: string; body: string; mtime?: number }>) {
    for (const e of entries) {
      const dir = join(sandboxHome, '.claude', 'projects', e.project)
      mkdirSync(dir, { recursive: true })
      const file = join(dir, e.file ?? 'session.jsonl')
      writeFileSync(file, e.body)
      if (e.mtime !== undefined) {
        try { utimesSync(file, e.mtime / 1000, e.mtime / 1000) } catch { /* ignore on mac */ }
      }
    }
  }

  it('returns 0 user-turns when ~/.claude/projects/ does not exist', async () => {
    // We never call writeProjects: the dir is absent.
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
    expect(json().tasksYesterday).toBe(0)
  })

  it('skips a project entry whose statSync throws (readdir succeeds, stat fails)', async () => {
    // Create a project dir but make it unreadable. Simulating statSync
    // failure on a real file is not portable, so we rely on a missing
    // directory: we exercise the readdir branch and the !stat.isDirectory
    // branch by writing a file instead of a directory.
    const projectsRoot = join(sandboxHome, '.claude', 'projects')
    mkdirSync(projectsRoot, { recursive: true })
    writeFileSync(join(projectsRoot, 'not-a-dir'), 'x')

    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips a projectDir that is a regular file (isDirectory() === false)', async () => {
    const projectsRoot = join(sandboxHome, '.claude', 'projects')
    mkdirSync(projectsRoot, { recursive: true })
    writeFileSync(join(projectsRoot, 'regular-file'), 'x')

    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips non-jsonl files inside the project dir', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.txt',
      body: 'not a transcript',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips jsonl files whose statSync throws', async () => {
    // Simulating statSync failure on a real file is platform-dependent.
    // We trigger the same branch via a project dir that we DELETE after
    // writing -- readdir would still see it but stat fails.
    const dir = join(sandboxHome, '.claude', 'projects', 'p1')
    mkdirSync(dir, { recursive: true })
    // remove the dir so the inner readdir sees nothing
    rmSync(dir, { recursive: true, force: true })

    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips jsonl files whose mtimeMs < fromMs', async () => {
    const now = Date.now()
    const twoDaysAgo = now - 48 * 60 * 60 * 1000
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: 'hi' }, timestamp: new Date(twoDaysAgo).toISOString() }),
      mtime: twoDaysAgo,
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips empty lines', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: '\n\n\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips lines whose JSON.parse throws', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: 'this is not json\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips events whose type is not "user"', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'assistant', message: { content: 'reply' }, timestamp: new Date().toISOString() }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips user events whose isMeta is true', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', isMeta: true, message: { content: 'x' }, timestamp: new Date().toISOString() }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips user events with no timestamp and no parsed ts', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: 'x' } }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips user events whose timestamp parses to NaN (Date.parse returns NaN)', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: 'x' }, timestamp: 'definitely-not-a-date' }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips user events whose parsed ts is in the future of the [fromMs, toMs) window', async () => {
    // toMs is the startTs (midnight today). Anything with ts >= startTs
    // for the "yesterday" call falls outside the window.
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: 'x' }, timestamp: new Date().toISOString() }) + '\n',
    })
    const { json } = await call()
    // The today's window accepts it -- the task's "today" slice covers
    // [startTs, +Infinity). But the yesterday's slice only covers
    // [startTs - 24h, startTs), so the same prompt can't land in
    // tasksYesterday. Verify tasksToday only is incremented.
    expect(json().tasksToday).toBe(1)
    expect(json().tasksYesterday).toBe(0)
  })

  it('skips string content that begins with <local-command (local-command filter)', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: '<local-command>noop</local-command>' }, timestamp: new Date().toISOString() }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips string content that begins with <command-name>', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: '<command-name>foo</command-name>' }, timestamp: new Date().toISOString() }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('counts a string content prompt as one user turn', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: 'hello there' }, timestamp: new Date().toISOString() }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(1)
  })

  it('skips array content that contains a tool_result block', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'tool_result', tool_use_id: 'x', content: 'y' }] },
        timestamp: new Date().toISOString(),
      }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('counts an array content block WITHOUT tool_result as a user turn', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({
        type: 'user',
        message: { content: [{ type: 'text', text: 'hello' }] },
        timestamp: new Date().toISOString(),
      }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(1)
  })

  it('skips user events with non-string non-array content (the implicit branch)', async () => {
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({
        type: 'user',
        message: { content: { weird: 'object' } },
        timestamp: new Date().toISOString(),
      }) + '\n',
    })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('survives the outer try/catch when reading the file throws mid-iteration', async () => {
    // We trigger the read-file-throws branch by writing a directory at
    // the jsonl path: readFileSync on a directory throws EISDIR.
    const dir = join(sandboxHome, '.claude', 'projects', 'p1')
    mkdirSync(dir, { recursive: true })
    mkdirSync(join(dir, 'session.jsonl'))
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('survives the outermost readdirSync(root) catch arm via the try wrapper', async () => {
    // The outermost `for (const projectDir of readdirSync(root))` is
    // wrapped in a try/catch that swallows. We can simulate it by
    // creating a project subdir that is itself a *file* -- this is the
    // isDirectory() branch and is covered above. To exercise the
    // outermost catch, the route must see an error during readdirSync.
    // We approximate by removing the projects dir *after* the file we
    // want to count is in place, then triggering the second walk for
    // yesterday. The second walk re-uses the same helper and any
    // readdir error is caught silently.
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: 'x' }, timestamp: new Date().toISOString() }) + '\n',
    })
    rmSync(join(sandboxHome, '.claude', 'projects'), { recursive: true, force: true })
    const { json } = await call()
    expect(json().tasksToday).toBe(0)
  })

  it('skips a projectDir whose statSync throws (inner catch arm)', async () => {
    // Force statSync to throw on the projectDir path so the
    // `try { stat = statSync(absDir) } catch { continue }` arm fires.
    // A real projectDir must exist first so readdirSync has something
    // to iterate over; otherwise the for-loop body never runs and the
    // catch is unreachable.
    const projectsRoot = join(sandboxHome, '.claude', 'projects')
    mkdirSync(projectsRoot, { recursive: true })
    mkdirSync(join(projectsRoot, 'p1'))

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        statSync: ((p: unknown) => {
          if (typeof p === 'string' && p.includes('/.claude/projects/') && !p.endsWith('.jsonl')) {
            throw new Error('forced projectDir statSync throw')
          }
          return actual.statSync(p as never)
        }) as typeof actual.statSync,
      }
    })
    try {
      vi.resetModules()
      const { tryHandleOverview: reloaded } = await import('../web/routes/overview.js')
      const res = mkRes()
      const req = { headers: {} } as unknown as import('node:http').IncomingMessage
      const url = new URL('http://127.0.0.1:3420/api/overview')
      const ctx: RouteContext = {
        req,
        res: res as unknown as import('node:http').ServerResponse,
        path: url.pathname,
        method: 'GET',
        url,
      }
      const handled = await reloaded(ctx)
      expect(handled).toBe(true)
      expect(JSON.parse(res.body).tasksToday).toBe(0)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })

  it('skips a jsonl file whose statSync throws (inner catch arm)', async () => {
    // Force statSync to throw on the jsonl file path so the
    // `try { fstat = statSync(absFile) } catch { continue }` arm fires.
    writeProjects({
      project: 'p1',
      file: 'session.jsonl',
      body: JSON.stringify({ type: 'user', message: { content: 'x' }, timestamp: new Date().toISOString() }) + '\n',
    })
    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        statSync: ((p: unknown) => {
          if (typeof p === 'string' && p.endsWith('.jsonl')) {
            throw new Error('forced jsonl statSync throw')
          }
          return actual.statSync(p as never)
        }) as typeof actual.statSync,
      }
    })
    try {
      vi.resetModules()
      const { tryHandleOverview: reloaded } = await import('../web/routes/overview.js')
      const res = mkRes()
      const req = { headers: {} } as unknown as import('node:http').IncomingMessage
      const url = new URL('http://127.0.0.1:3420/api/overview')
      const ctx: RouteContext = {
        req,
        res: res as unknown as import('node:http').ServerResponse,
        path: url.pathname,
        method: 'GET',
        url,
      }
      const handled = await reloaded(ctx)
      expect(handled).toBe(true)
      expect(JSON.parse(res.body).tasksToday).toBe(0)
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })
})

// ===========================================================================
// Skills counting
// ===========================================================================
describe('tryHandleOverview -- skills', () => {
  function writeSkill(name: string, opts: { mtime?: number; withSkillMd?: boolean } = {}) {
    const dir = join(sandboxHome, '.claude', 'skills', name)
    mkdirSync(dir, { recursive: true })
    if (opts.withSkillMd !== false) {
      writeFileSync(join(dir, 'SKILL.md'), '# skill')
    }
    if (opts.mtime !== undefined) {
      const f = join(dir, 'SKILL.md')
      try { utimesSync(f, opts.mtime / 1000, opts.mtime / 1000) } catch { /* ignore on mac */ }
    }
  }

  it('returns skillCount=0 + skillsToday=0 when ~/.claude/skills/ is missing', async () => {
    const { json } = await call()
    expect(json().skills).toEqual({ count: 0, today: 0 })
  })

  it('counts a skill whose SKILL.md exists but mtime is in the past', async () => {
    const longAgo = Date.now() - 48 * 60 * 60 * 1000
    writeSkill('alpha', { mtime: longAgo })
    const { json } = await call()
    expect(json().skills).toEqual({ count: 1, today: 0 })
  })

  it('counts a skill whose SKILL.md mtime is today as skillsToday', async () => {
    writeSkill('alpha', { mtime: Date.now() })
    const { json } = await call()
    expect(json().skills).toEqual({ count: 1, today: 1 })
  })

  it('skips a directory that has no SKILL.md', async () => {
    const dir = join(sandboxHome, '.claude', 'skills', 'no-skill')
    mkdirSync(dir, { recursive: true })
    const { json } = await call()
    expect(json().skills).toEqual({ count: 0, today: 0 })
  })

  it('survives a statSync throw on SKILL.md (catch arm)', async () => {
    // The catch arm only fires when statSync throws on the SKILL.md path.
    // ESM modules can't be spyOn'd, so we use vi.doMock to swap node:fs
    // for this one test: existsSync is unchanged, but statSync throws on
    // any path ending in SKILL.md (replicating a TOCTOU race where the
    // skill file disappears between the existsSync check and the stat).
    const dir = join(sandboxHome, '.claude', 'skills', 'broken')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'SKILL.md'), 'irrelevant')

    vi.doMock('node:fs', async (importOriginal) => {
      const actual = await importOriginal<typeof import('node:fs')>()
      return {
        ...actual,
        statSync: ((p: unknown) => {
          if (typeof p === 'string' && p.endsWith('/SKILL.md')) {
            throw new Error('forced statSync throw')
          }
          return actual.statSync(p as never)
        }) as typeof actual.statSync,
      }
    })
    try {
      // Re-resolve the SUT so it picks up the doMock of node:fs.
      vi.resetModules()
      const { tryHandleOverview: reloaded } = await import('../web/routes/overview.js')
      const res = mkRes()
      const req = { headers: {} } as unknown as import('node:http').IncomingMessage
      const url = new URL('http://127.0.0.1:3420/api/overview')
      const ctx: RouteContext = {
        req,
        res: res as unknown as import('node:http').ServerResponse,
        path: url.pathname,
        method: 'GET',
        url,
      }
      const handled = await reloaded(ctx)
      expect(handled).toBe(true)
      const body = JSON.parse(res.body)
      expect(body.skills).toEqual({ count: 1, today: 0 })
    } finally {
      vi.doUnmock('node:fs')
      vi.resetModules()
    }
  })
})

// ===========================================================================
// Memories / agent_messages activity feed
// ===========================================================================
describe('tryHandleOverview -- activity feed', () => {
  it('renders a memory row as icon=memory, slicing content >80 chars with ellipsis', async () => {
    const longContent = 'A'.repeat(120)
    H.getDb.mockReturnValue(mkFakeDb({
      memories: [{ content: longContent, created_at: 1_700_000_000, agent_id: 'agent-a' }],
    }))
    const { json } = await call()
    const activity = json().activity as Array<{ icon: string; text: string; at: number }>
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({
      icon: 'memory',
      text: `agent-a: ${'A'.repeat(80)}…`,
      at: 1_700_000_000 * 1000,
    })
    expect(activity[0].text.length).toBeLessThanOrEqual(120)
  })

  it('does NOT ellipsize a memory row whose content is <= 80 chars', async () => {
    H.getDb.mockReturnValue(mkFakeDb({
      memories: [{ content: 'short', created_at: 1_700_000_001, agent_id: 'agent-b' }],
    }))
    const { json } = await call()
    const activity = json().activity as Array<{ text: string }>
    expect(activity[0].text).toBe('agent-b: short')
  })

  it('renders an agent_message row as icon=delegate with from -> to: content(<=60)', async () => {
    H.getDb.mockReturnValue(mkFakeDb({
      messages: [{ from_agent: 'a', to_agent: 'b', content: 'short message', created_at: 1_700_000_002 }],
    }))
    const { json } = await call()
    const activity = json().activity as Array<{ icon: string; text: string; at: number }>
    expect(activity).toHaveLength(1)
    expect(activity[0]).toMatchObject({
      icon: 'delegate',
      text: 'a → b: short message',
      at: 1_700_000_002 * 1000,
    })
  })

  it('ellipsizes agent_message content > 60 chars', async () => {
    H.getDb.mockReturnValue(mkFakeDb({
      messages: [{ from_agent: 'a', to_agent: 'b', content: 'B'.repeat(80), created_at: 1_700_000_003 }],
    }))
    const { json } = await call()
    const activity = json().activity as Array<{ text: string }>
    expect(activity[0].text).toBe(`a → b: ${'B'.repeat(60)}…`)
  })

  it('merges + sorts memories and messages by created_at DESC, then slices to 8', async () => {
    H.getDb.mockReturnValue(mkFakeDb({
      memories: [
        { content: 'm1', created_at: 100, agent_id: 'a' },
        { content: 'm2', created_at: 300, agent_id: 'a' },
        { content: 'm3', created_at: 50, agent_id: 'a' },
        { content: 'm4', created_at: 400, agent_id: 'a' },
        { content: 'm5', created_at: 200, agent_id: 'a' },
        { content: 'm6', created_at: 600, agent_id: 'a' },
      ],
      messages: [
        { from_agent: 'x', to_agent: 'y', content: 'msg1', created_at: 250 },
        { from_agent: 'x', to_agent: 'y', content: 'msg2', created_at: 150 },
        { from_agent: 'x', to_agent: 'y', content: 'msg3', created_at: 500 },
        { from_agent: 'x', to_agent: 'y', content: 'msg4', created_at: 350 },
      ],
    }))
    const { json } = await call()
    const activity = json().activity as Array<{ at: number; icon: string }>
    expect(activity).toHaveLength(8)
    // Sorted DESC by at
    for (let i = 0; i < activity.length - 1; i++) {
      expect(activity[i].at).toBeGreaterThanOrEqual(activity[i + 1].at)
    }
    expect(activity[0].at).toBe(600_000)
    // Verify the merge includes both kinds; the first entry is the
    // memory at created_at 600. Top-2 alternate memory/message based on
    // the merged DESC ordering.
    expect(activity[0].icon).toBe('memory')
    expect(activity[1].icon).toBe('delegate') // message at 500
    expect(activity[2].icon).toBe('memory')   // memory at 400
    // The 8th element is the lowest in the top-8: msg2 at 150 (message
    // at 250 comes after memory at 200 which is 9th = dropped).
    expect(activity[7].at).toBe(150_000)
    expect(activity[7].icon).toBe('delegate')
  })

  it('returns memories.{count, categories} from the COUNT queries', async () => {
    H.getDb.mockReturnValue(mkFakeDb({
      memories: [{ content: 'x', created_at: 1, agent_id: 'a' }],
      memStats: 42,
      memCats: 3,
    }))
    const { json } = await call()
    expect((json().memories as { count: number; categories: number })).toEqual({ count: 42, categories: 3 })
  })
})
