// 100% coverage suite for src/web/routes/ideas.ts.
//
// The handler is the Idea Box REST surface. Endpoints:
//
//   GET    /api/ideas                      -> list + computed `stale` flag
//   GET    /api/ideas/categories           -> distinct category names
//   POST   /api/ideas                      -> create (title required, impact/effort 1-5)
//   PUT    /api/ideas/:id                  -> patch (+ status-change audit row)
//   DELETE /api/ideas/:id                  -> delete
//   GET    /api/ideas/:id/comments         -> comment list
//   POST   /api/ideas/:id/comments         -> add comment
//   POST   /api/ideas/:id/promote          -> single kanban card
//   POST   /api/ideas/:id/breakdown        -> LLM subtask suggestions (no write)
//   POST   /api/ideas/:id/promote-breakdown-> parent card + one child per subtask
//   POST   /api/ideas/:id/revert           -> kanban -> reviewed
//   GET    /api/ideas/:id/status-log       -> status audit rows
//
// Everything the module touches is mocked: db.js (all ten idea/kanban
// helpers plus getDb), config.js (MAIN_AGENT_ID / BOT_NAME), logger.js,
// settings-store.js (IDEA_STALE_DAYS), llm-breakdown.js (generateBreakdown),
// and the auth modules the route dispatcher normally pulls in. Only
// http-helpers.js runs for real -- it is what writes into the mock response.
//
// Determinism:
//   * `node:crypto` randomUUID is a counter, so every generated id is fixed.
//   * `Date.now()` is pinned with fake timers (Date only -- the stream-based
//     readBody() must keep real microtask scheduling).
//   * No timers are scheduled by the module under test.
//
// Sandbox: CLAUDECLAW_ENV_DIR is pointed at an os.tmpdir() scratch dir via
// src/__tests__/setup/temp-sandbox.ts before any import resolves, so nothing
// in the transitive graph can reach the live store. config.js is fully
// mocked (it is the only live consumer of it in this graph), so this is a
// second line of defence rather than the primary one.
//
// Pinned defects (NOT fixed here):
//   * routes-ideas-promote-double       -- re-promoting orphans the first kanban card
//   * routes-ideas-body-parse-500       -- malformed/`null` JSON body throws out of the handler
//   * routes-ideas-breakdown-nonerror   -- non-Error throw yields a 500 with an empty body
//   * routes-ideas-title-validation     -- title is not trimmed nor type-checked

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkTempDir, rmTempDir, snapshotEnv } from './setup/temp-sandbox.js'

// --- sandbox (must be set before the module graph resolves) --------------
const SANDBOX = mkTempDir('ideas-routes-')
const ENV = snapshotEnv()
process.env.CLAUDECLAW_ENV_DIR = SANDBOX

// --- deterministic ids ---------------------------------------------------
let uuidCounter = 0
function nextUuid(): string {
  uuidCounter += 1
  return `${String(uuidCounter).padStart(8, '0')}-0000-4000-8000-000000000000`
}
/** What `randomUUID().slice(0, 8)` produces for the n-th call in a test. */
function idOf(n: number): string {
  return String(n).padStart(8, '0')
}

vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>()
  return { ...actual, randomUUID: () => nextUuid() }
})

// --- collaborators -------------------------------------------------------
vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'main-agent',
  BOT_NAME: 'TestBot',
}))

vi.mock('../db.js', () => ({
  getDb: vi.fn(),
  listIdeas: vi.fn(),
  createIdea: vi.fn(),
  updateIdea: vi.fn(),
  deleteIdea: vi.fn(),
  listIdeaCategories: vi.fn(),
  createKanbanCard: vi.fn(),
  getIdeaComments: vi.fn(),
  addIdeaComment: vi.fn(),
  logIdeaStatusChange: vi.fn(),
  getIdeaStatusLog: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../settings-store.js', () => ({ getEffectiveSettingValue: vi.fn() }))
vi.mock('../web/llm-breakdown.js', () => ({ generateBreakdown: vi.fn() }))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Import AFTER every mock is registered.
const { tryHandleIdeas } = await import('../web/routes/ideas.js')
const db = await import('../db.js')
const { logger } = await import('../logger.js')
const { getEffectiveSettingValue } = await import('../settings-store.js')
const { generateBreakdown } = await import('../web/llm-breakdown.js')

type IdeaRow = import('../db.js').IdeaBoxRow

// -----------------------------------------------------------------------
// Clock
// -----------------------------------------------------------------------
// 2026-03-01T00:00:00Z -> 1772323200 unix seconds.
const NOW_MS = Date.UTC(2026, 2, 1, 0, 0, 0)
const NOW_S = Math.floor(NOW_MS / 1000)
const DAY = 86400

// -----------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------
interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  end(data?: string): void
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
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(body?: string): http.IncomingMessage {
  const payload = body === undefined ? [] : [Buffer.from(body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

interface CallResult {
  handled: boolean
  status: number
  body: unknown
}

async function call(method: string, rawPath: string, body?: string): Promise<CallResult> {
  const url = new URL(`http://127.0.0.1:3420${rawPath}`)
  const res = mkRes()
  const handled = await tryHandleIdeas({
    req: mkReq(body),
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
    fedPeer: null,
  })
  return {
    handled,
    status: res.statusCode,
    body: res.body === '' ? undefined : JSON.parse(res.body),
  }
}

// -----------------------------------------------------------------------
// DB fixtures
// -----------------------------------------------------------------------
const ideaRows = new Map<string, IdeaRow>()
/** Every SQL string handed to the fake `getDb().prepare()`. */
const preparedSql: string[] = []

function mkIdea(over: Partial<IdeaRow> = {}): IdeaRow {
  return {
    id: 'idea-1',
    title: 'Napelemes kutyaház',
    description: 'Leírás',
    category: 'Hardver',
    status: 'new',
    source: 'manual',
    kanban_id: null,
    impact: null,
    effort: null,
    created_at: NOW_S - 10 * DAY,
    updated_at: NOW_S - 10 * DAY,
    ...over,
  }
}

function seedIdea(over: Partial<IdeaRow> = {}): IdeaRow {
  const row = mkIdea(over)
  ideaRows.set(row.id, row)
  return row
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
})

afterAll(() => {
  vi.useRealTimers()
  ENV.restore()
  rmTempDir(SANDBOX)
})

beforeEach(() => {
  vi.clearAllMocks()
  ideaRows.clear()
  preparedSql.length = 0
  uuidCounter = 0
  vi.mocked(db.getDb).mockReturnValue({
    prepare: (sql: string) => {
      preparedSql.push(sql)
      return { get: (id: string) => ideaRows.get(id) }
    },
  } as unknown as ReturnType<typeof db.getDb>)
  vi.mocked(getEffectiveSettingValue).mockReturnValue(7)
  vi.mocked(db.listIdeas).mockReturnValue([])
  vi.mocked(db.listIdeaCategories).mockReturnValue([])
  vi.mocked(db.updateIdea).mockReturnValue(true)
  vi.mocked(db.deleteIdea).mockReturnValue(true)
  vi.mocked(db.getIdeaComments).mockReturnValue([])
  vi.mocked(db.getIdeaStatusLog).mockReturnValue([])
})

// =======================================================================
describe('tryHandleIdeas -- dispatcher fall-through', () => {
  it('returns false for a path outside /api/ideas', async () => {
    const r = await call('GET', '/api/kanban')
    expect(r.handled).toBe(false)
    expect(r.status).toBe(0)
  })

  it.each([
    ['POST', '/api/ideas/categories'], // matches :id but is neither PUT nor DELETE
    ['PATCH', '/api/ideas/idea-1'],
    ['PUT', '/api/ideas/idea-1/comments'],
    ['DELETE', '/api/ideas/idea-1/promote'],
    ['GET', '/api/ideas/idea-1/breakdown'],
    ['GET', '/api/ideas/idea-1/promote-breakdown'],
    ['GET', '/api/ideas/idea-1/revert'],
    ['POST', '/api/ideas/idea-1/status-log'],
    ['DELETE', '/api/ideas'],
    ['PUT', '/api/ideas/categories/extra'],
  ])('returns false for %s %s', async (method, path) => {
    const r = await call(method, path)
    expect(r.handled).toBe(false)
    expect(r.status).toBe(0)
  })
})

// =======================================================================
describe('GET /api/ideas', () => {
  it('lists without filters and flags a stale "new" idea', async () => {
    vi.mocked(db.listIdeas).mockReturnValue([
      mkIdea({ id: 'a', status: 'new', updated_at: NOW_S - 8 * DAY }),
      mkIdea({ id: 'b', status: 'new', updated_at: NOW_S - 2 * DAY }),
      mkIdea({ id: 'c', status: 'reviewed', updated_at: NOW_S - 400 * DAY }),
    ])

    const r = await call('GET', '/api/ideas')

    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(db.listIdeas).toHaveBeenCalledWith({ status: undefined, category: undefined })
    const rows = r.body as Array<IdeaRow & { stale: boolean }>
    expect(rows.map(x => [x.id, x.stale])).toEqual([
      ['a', true],   // new + older than the threshold
      ['b', false],  // new but recent
      ['c', false],  // ancient but not 'new' -- short-circuits
    ])
    // The full row is spread through, not just the id.
    expect(rows[0].title).toBe('Napelemes kutyaház')
  })

  it('forwards the status and category query params', async () => {
    await call('GET', '/api/ideas?status=reviewed&category=Hardver')
    expect(db.listIdeas).toHaveBeenCalledWith({ status: 'reviewed', category: 'Hardver' })
  })

  it('treats empty query params as absent', async () => {
    await call('GET', '/api/ideas?status=&category=')
    expect(db.listIdeas).toHaveBeenCalledWith({ status: undefined, category: undefined })
  })

  it('honours a configured IDEA_STALE_DAYS threshold', async () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue(30)
    vi.mocked(db.listIdeas).mockReturnValue([
      mkIdea({ id: 'a', status: 'new', updated_at: NOW_S - 20 * DAY }),
      mkIdea({ id: 'b', status: 'new', updated_at: NOW_S - 40 * DAY }),
    ])

    const r = await call('GET', '/api/ideas')

    expect(getEffectiveSettingValue).toHaveBeenCalledWith('IDEA_STALE_DAYS')
    expect((r.body as Array<{ id: string; stale: boolean }>).map(x => x.stale)).toEqual([false, true])
  })

  it('falls back to 7 days when the setting is not a usable number', async () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue('nem-szam')
    vi.mocked(db.listIdeas).mockReturnValue([
      mkIdea({ id: 'a', status: 'new', updated_at: NOW_S - 6 * DAY }),
      mkIdea({ id: 'b', status: 'new', updated_at: NOW_S - 8 * DAY }),
    ])

    const r = await call('GET', '/api/ideas')
    expect((r.body as Array<{ stale: boolean }>).map(x => x.stale)).toEqual([false, true])
  })

  it('clamps a negative threshold to a single day', async () => {
    vi.mocked(getEffectiveSettingValue).mockReturnValue(-5)
    vi.mocked(db.listIdeas).mockReturnValue([
      mkIdea({ id: 'a', status: 'new', updated_at: NOW_S - 2 * 3600 }),
      mkIdea({ id: 'b', status: 'new', updated_at: NOW_S - 2 * DAY }),
    ])

    const r = await call('GET', '/api/ideas')
    expect((r.body as Array<{ stale: boolean }>).map(x => x.stale)).toEqual([false, true])
  })

  it('returns an empty array when there are no ideas', async () => {
    const r = await call('GET', '/api/ideas')
    expect(r.body).toEqual([])
  })
})

// =======================================================================
describe('GET /api/ideas/categories', () => {
  it('returns the distinct category list', async () => {
    vi.mocked(db.listIdeaCategories).mockReturnValue(['Hardver', 'Szoftver'])
    const r = await call('GET', '/api/ideas/categories')
    expect(r.handled).toBe(true)
    expect(r.status).toBe(200)
    expect(r.body).toEqual(['Hardver', 'Szoftver'])
  })
})

// =======================================================================
describe('POST /api/ideas', () => {
  it('rejects a missing title', async () => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ description: 'x' }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'title required' })
    expect(db.createIdea).not.toHaveBeenCalled()
  })

  it('rejects an empty title', async () => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ title: '' }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'title required' })
  })

  it('applies the defaults for the optional fields', async () => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ title: 'Csak cím' }))

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, id: idOf(1) })
    expect(db.createIdea).toHaveBeenCalledWith({
      id: idOf(1),
      title: 'Csak cím',
      description: null,
      category: 'Egyéb',
      status: 'new',
      source: 'manual',
      kanban_id: null,
      impact: null,
      effort: null,
    })
  })

  it('stores every supplied field', async () => {
    const r = await call('POST', '/api/ideas', JSON.stringify({
      title: 'Teljes',
      description: 'Leírás',
      category: 'Hardver',
      source: 'telegram',
      impact: 4,
      effort: 2,
    }))

    expect(r.status).toBe(200)
    expect(db.createIdea).toHaveBeenCalledWith({
      id: idOf(1),
      title: 'Teljes',
      description: 'Leírás',
      category: 'Hardver',
      status: 'new',
      source: 'telegram',
      kanban_id: null,
      impact: 4,
      effort: 2,
    })
  })

  it('treats an explicit null impact/effort as unset', async () => {
    await call('POST', '/api/ideas', JSON.stringify({ title: 'T', impact: null, effort: null }))
    expect(db.createIdea).toHaveBeenCalledWith(expect.objectContaining({ impact: null, effort: null }))
  })

  it('rounds fractional impact and effort', async () => {
    await call('POST', '/api/ideas', JSON.stringify({ title: 'T', impact: 3.4, effort: 1.6 }))
    expect(db.createIdea).toHaveBeenCalledWith(expect.objectContaining({ impact: 3, effort: 2 }))
  })

  it.each([
    ['impact', 0],
    ['impact', 6],
    ['impact', 'abc'],
  ])('rejects %s=%s', async (field, value) => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ title: 'T', [field]: value }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'impact must be 1-5 or null' })
    expect(db.createIdea).not.toHaveBeenCalled()
  })

  it.each([
    ['effort', 0],
    ['effort', 6],
    ['effort', 'abc'],
  ])('rejects %s=%s', async (field, value) => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ title: 'T', [field]: value }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'effort must be 1-5 or null' })
    expect(db.createIdea).not.toHaveBeenCalled()
  })

  it('validates impact before effort', async () => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ title: 'T', impact: 9, effort: 9 }))
    expect(r.body).toEqual({ error: 'impact must be 1-5 or null' })
  })
})

// =======================================================================
describe('PUT /api/ideas/:id', () => {
  it('404s when the idea does not exist', async () => {
    const r = await call('PUT', '/api/ideas/nincs', JSON.stringify({ title: 'x' }))
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
    expect(db.updateIdea).not.toHaveBeenCalled()
  })

  it('patches the idea and logs a status transition', async () => {
    seedIdea({ id: 'idea-1', status: 'new' })

    const r = await call('PUT', '/api/ideas/idea-1', JSON.stringify({
      title: 'Új cím', status: 'reviewed', impact: 5, effort: 1,
    }))

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(db.updateIdea).toHaveBeenCalledWith('idea-1', {
      title: 'Új cím', status: 'reviewed', impact: 5, effort: 1,
    })
    expect(db.logIdeaStatusChange).toHaveBeenCalledWith('idea-1', 'new', 'reviewed', 'main-agent')
  })

  it('does not log when the status is unchanged', async () => {
    seedIdea({ id: 'idea-1', status: 'reviewed' })
    const r = await call('PUT', '/api/ideas/idea-1', JSON.stringify({ status: 'reviewed' }))
    expect(r.status).toBe(200)
    expect(db.logIdeaStatusChange).not.toHaveBeenCalled()
  })

  it('does not log when the patch carries no status', async () => {
    seedIdea({ id: 'idea-1', status: 'new' })
    const r = await call('PUT', '/api/ideas/idea-1', JSON.stringify({ category: 'Szoftver' }))
    expect(r.status).toBe(200)
    expect(db.logIdeaStatusChange).not.toHaveBeenCalled()
  })

  it('404s when the UPDATE touches no row', async () => {
    seedIdea({ id: 'idea-1' })
    vi.mocked(db.updateIdea).mockReturnValue(false)

    const r = await call('PUT', '/api/ideas/idea-1', JSON.stringify({ title: 'x' }))

    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
    expect(db.logIdeaStatusChange).not.toHaveBeenCalled()
  })

  it('returns 400 title required when title is provided as a non-string (null/number)', async () => {
    // ideas.ts:130 ternary branch[1] (typeof !== 'string' -> trimmed = '')
    // plus the `if (!trimmed)` branch on line 131. A title present but not
    // a string must NOT be accepted: trimmed defaults to '' and validation
    // rejects with the same 400 as a missing title.
    seedIdea({ id: 'idea-1' })
    const r = await call('PUT', '/api/ideas/idea-1', JSON.stringify({ title: 42 }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'title required' })
  })

  it('rounds fractional impact/effort before the update', async () => {
    seedIdea({ id: 'idea-1' })
    await call('PUT', '/api/ideas/idea-1', JSON.stringify({ impact: 2.5, effort: 4.4 }))
    expect(db.updateIdea).toHaveBeenCalledWith('idea-1', { impact: 3, effort: 4 })
  })

  it('passes an explicit null impact/effort straight through', async () => {
    seedIdea({ id: 'idea-1' })
    await call('PUT', '/api/ideas/idea-1', JSON.stringify({ impact: null, effort: null }))
    expect(db.updateIdea).toHaveBeenCalledWith('idea-1', { impact: null, effort: null })
  })

  it.each([0, 6, 'abc'])('rejects impact=%s before looking the idea up', async (value) => {
    const r = await call('PUT', '/api/ideas/nincs', JSON.stringify({ impact: value }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'impact must be 1-5 or null' })
  })

  it.each([0, 6, 'abc'])('rejects effort=%s before looking the idea up', async (value) => {
    const r = await call('PUT', '/api/ideas/nincs', JSON.stringify({ effort: value }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'effort must be 1-5 or null' })
  })

  it('decodes a percent-encoded id', async () => {
    seedIdea({ id: 'ötlet 1' })
    const r = await call('PUT', `/api/ideas/${encodeURIComponent('ötlet 1')}`, JSON.stringify({ title: 'x' }))
    expect(r.status).toBe(200)
    expect(db.updateIdea).toHaveBeenCalledWith('ötlet 1', { title: 'x' })
  })
})

// =======================================================================
describe('DELETE /api/ideas/:id', () => {
  it('deletes an existing idea', async () => {
    const r = await call('DELETE', '/api/ideas/idea-1')
    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(db.deleteIdea).toHaveBeenCalledWith('idea-1')
  })

  it('404s when nothing was deleted', async () => {
    vi.mocked(db.deleteIdea).mockReturnValue(false)
    const r = await call('DELETE', '/api/ideas/nincs')
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
  })

  it('decodes a percent-encoded id', async () => {
    await call('DELETE', `/api/ideas/${encodeURIComponent('a b')}`)
    expect(db.deleteIdea).toHaveBeenCalledWith('a b')
  })
})

// =======================================================================
describe('/api/ideas/:id/comments', () => {
  it('GET returns the comment list', async () => {
    vi.mocked(db.getIdeaComments).mockReturnValue([
      { id: 1, idea_id: 'idea-1', author: 'main-agent', content: 'szia', created_at: NOW_S },
    ])

    const r = await call('GET', '/api/ideas/idea-1/comments')

    expect(r.status).toBe(200)
    expect(r.body).toEqual({
      comments: [{ id: 1, idea_id: 'idea-1', author: 'main-agent', content: 'szia', created_at: NOW_S }],
    })
    expect(db.getIdeaComments).toHaveBeenCalledWith('idea-1')
  })

  it('GET decodes a percent-encoded id', async () => {
    await call('GET', `/api/ideas/${encodeURIComponent('a b')}/comments`)
    expect(db.getIdeaComments).toHaveBeenCalledWith('a b')
  })

  it('POST stores a trimmed comment with a trimmed author', async () => {
    seedIdea({ id: 'idea-1' })
    const stored = { id: 7, idea_id: 'idea-1', author: 'Gabor', content: 'megjegyzés', created_at: NOW_S }
    vi.mocked(db.addIdeaComment).mockReturnValue(stored)

    const r = await call('POST', '/api/ideas/idea-1/comments', JSON.stringify({
      author: '  Gabor  ', content: '  megjegyzés  ',
    }))

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, comment: stored })
    expect(db.addIdeaComment).toHaveBeenCalledWith('idea-1', 'Gabor', 'megjegyzés')
  })

  it('POST falls back to MAIN_AGENT_ID when the author is absent', async () => {
    seedIdea({ id: 'idea-1' })
    vi.mocked(db.addIdeaComment).mockReturnValue(
      { id: 1, idea_id: 'idea-1', author: 'main-agent', content: 'c', created_at: NOW_S },
    )
    await call('POST', '/api/ideas/idea-1/comments', JSON.stringify({ content: 'c' }))
    expect(db.addIdeaComment).toHaveBeenCalledWith('idea-1', 'main-agent', 'c')
  })

  it('POST falls back to MAIN_AGENT_ID when the author is blank', async () => {
    seedIdea({ id: 'idea-1' })
    vi.mocked(db.addIdeaComment).mockReturnValue(
      { id: 1, idea_id: 'idea-1', author: 'main-agent', content: 'c', created_at: NOW_S },
    )
    await call('POST', '/api/ideas/idea-1/comments', JSON.stringify({ author: '   ', content: 'c' }))
    expect(db.addIdeaComment).toHaveBeenCalledWith('idea-1', 'main-agent', 'c')
  })

  it.each([
    ['missing', {}],
    ['empty', { content: '' }],
    ['whitespace-only', { content: '   \n ' }],
    ['not a string', { content: 42 }],
  ])('POST rejects a %s content', async (_label, payload) => {
    const r = await call('POST', '/api/ideas/idea-1/comments', JSON.stringify(payload))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'content required' })
    expect(db.addIdeaComment).not.toHaveBeenCalled()
  })
})

// =======================================================================
describe('POST /api/ideas/:id/promote', () => {
  it('404s for an unknown idea', async () => {
    const r = await call('POST', '/api/ideas/nincs/promote', JSON.stringify({}))
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
    expect(db.createKanbanCard).not.toHaveBeenCalled()
  })

  it('creates a "detail" card by default', async () => {
    seedIdea({ id: 'idea-1', title: 'Kutyaház', description: 'Leírás', status: 'reviewed' })

    const r = await call('POST', '/api/ideas/idea-1/promote', JSON.stringify({}))

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, kanban_id: idOf(1) })
    expect(db.createKanbanCard).toHaveBeenCalledWith({
      id: idOf(1),
      title: '[Részlet kidolgozás] Kutyaház',
      description: 'Leírás',
      status: 'waiting',
      priority: 'normal',
      assignee: 'TestBot',
      project: 'Fejlesztési ötletek',
    })
    expect(db.logIdeaStatusChange).toHaveBeenCalledWith('idea-1', 'reviewed', 'kanban', 'main-agent', 'promote:detail')
    expect(db.updateIdea).toHaveBeenCalledWith('idea-1', { status: 'kanban', kanban_id: idOf(1) })
  })

  it('creates a planned card for phase=plan and keeps the raw title', async () => {
    seedIdea({ id: 'idea-1', title: 'Kutyaház', status: 'new' })

    const r = await call('POST', '/api/ideas/idea-1/promote', JSON.stringify({ phase: 'plan' }))

    expect(r.status).toBe(200)
    expect(db.createKanbanCard).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Kutyaház',
      status: 'planned',
    }))
    expect(db.logIdeaStatusChange).toHaveBeenCalledWith('idea-1', 'new', 'kanban', 'main-agent', 'promote:plan')
  })

  it('maps a null description to an empty string', async () => {
    seedIdea({ id: 'idea-1', description: null })
    await call('POST', '/api/ideas/idea-1/promote', JSON.stringify({}))
    expect(db.createKanbanCard).toHaveBeenCalledWith(expect.objectContaining({ description: '' }))
  })

  it('reads the idea through the shared idea_box lookup', async () => {
    seedIdea({ id: 'idea-1' })
    await call('POST', '/api/ideas/idea-1/promote', JSON.stringify({}))
    expect(preparedSql).toContain('SELECT * FROM idea_box WHERE id = ?')
  })

  it('decodes a percent-encoded id', async () => {
    seedIdea({ id: 'a b' })
    const r = await call('POST', `/api/ideas/${encodeURIComponent('a b')}/promote`, JSON.stringify({}))
    expect(r.status).toBe(200)
  })

  // PINNED DEFECT -- routes-ideas-promote-double
  it('returns 409 with the existing kanban_id when re-promoting a kanban idea', async () => {
    seedIdea({ id: 'idea-1', status: 'kanban', kanban_id: 'regi-kartya' })

    const r = await call('POST', '/api/ideas/idea-1/promote', JSON.stringify({}))

    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ kanban_id: 'regi-kartya' })
    // A guard a card/idea write-ok ELOTT rovidre zar -- az eredeti card megmarad.
    expect(db.createKanbanCard).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
    expect(db.logIdeaStatusChange).not.toHaveBeenCalled()
  })
})

// =======================================================================
describe('POST /api/ideas/:id/breakdown', () => {
  it('404s for an unknown idea', async () => {
    const r = await call('POST', '/api/ideas/nincs/breakdown')
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
    expect(generateBreakdown).not.toHaveBeenCalled()
  })

  it('returns the generated subtasks', async () => {
    seedIdea({ id: 'idea-1', title: 'Kutyaház', description: 'Leírás' })
    const subtasks = [
      { title: 'Terv', description: 'd1', assignee: null, priority: 'normal' as const },
      { title: 'Építés', description: 'd2', assignee: 'acs', priority: 'high' as const },
    ]
    vi.mocked(generateBreakdown).mockResolvedValue({ subtasks })

    const r = await call('POST', '/api/ideas/idea-1/breakdown')

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ subtasks })
    expect(generateBreakdown).toHaveBeenCalledWith('Kutyaház', 'Leírás')
  })

  it('forwards a null description to the generator', async () => {
    seedIdea({ id: 'idea-1', title: 'T', description: null })
    vi.mocked(generateBreakdown).mockResolvedValue({ subtasks: [] })
    await call('POST', '/api/ideas/idea-1/breakdown')
    expect(generateBreakdown).toHaveBeenCalledWith('T', null)
  })

  it('500s and logs when the generator rejects', async () => {
    seedIdea({ id: 'idea-1' })
    vi.mocked(generateBreakdown).mockRejectedValue(new Error('LLM timeout'))

    const r = await call('POST', '/api/ideas/idea-1/breakdown')

    expect(r.handled).toBe(true)
    expect(r.status).toBe(500)
    expect(r.body).toEqual({ error: 'LLM timeout' })
    expect(logger.error).toHaveBeenCalledWith(
      expect.objectContaining({ ideaId: 'idea-1' }),
      'Idea breakdown generation failed',
    )
  })

  it('returns a useful 500 body when a non-Error value is thrown', async () => {
    seedIdea({ id: 'idea-1' })
    vi.mocked(generateBreakdown).mockRejectedValue('csak egy string')

    const r = await call('POST', '/api/ideas/idea-1/breakdown')

    expect(r.status).toBe(500)
    // type-guard on the caught `unknown`: when the throw is not an Error, fall
    // back to String(err) so the client gets the actual reason instead of `{}`.
    expect(r.body).toEqual({ error: 'csak egy string' })
  })

  it('decodes a percent-encoded id', async () => {
    seedIdea({ id: 'a b', title: 'T', description: null })
    vi.mocked(generateBreakdown).mockResolvedValue({ subtasks: [] })
    const r = await call('POST', `/api/ideas/${encodeURIComponent('a b')}/breakdown`)
    expect(r.status).toBe(200)
  })
})

// =======================================================================
describe('POST /api/ideas/:id/promote-breakdown', () => {
  it('404s for an unknown idea', async () => {
    const r = await call('POST', '/api/ideas/nincs/promote-breakdown', JSON.stringify({ subtasks: [] }))
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
  })

  // PINNED DEFECT -- routes-ideas-promote-double (sibling)
  it('returns 409 with the existing kanban_id when re-promoting a kanban idea via breakdown', async () => {
    seedIdea({ id: 'idea-1', status: 'kanban', kanban_id: 'regi-kartya' })

    const r = await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A' }],
    }))

    expect(r.status).toBe(409)
    expect(r.body).toMatchObject({ kanban_id: 'regi-kartya' })
    expect(db.createKanbanCard).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
    expect(db.logIdeaStatusChange).not.toHaveBeenCalled()
  })

  it('rejects a non-array subtasks field', async () => {
    seedIdea({ id: 'idea-1' })
    const r = await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({ subtasks: 'nem tomb' }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Legalább egy jóváhagyott alfeladat kötelező' })
    expect(db.createKanbanCard).not.toHaveBeenCalled()
  })

  it('rejects an empty subtasks array', async () => {
    seedIdea({ id: 'idea-1' })
    const r = await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({ subtasks: [] }))
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Legalább egy jóváhagyott alfeladat kötelező' })
  })

  it('creates a parent card plus one child per subtask', async () => {
    seedIdea({ id: 'idea-1', title: 'Kutyaház', description: 'Alap leírás', status: 'reviewed' })

    const r = await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [
        { title: 'Terv', description: 'rajz', assignee: 'tervezo', priority: 'high' },
        { title: 'Építés' },
      ],
    }))

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true, parent_id: idOf(1), child_count: 2 })
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(1, {
      id: idOf(1),
      title: 'Kutyaház',
      description: 'Alap leírás',
      status: 'planned',
      priority: 'normal',
      assignee: 'TestBot',
      project: 'Fejlesztési ötletek',
    })
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(2, {
      id: idOf(2),
      title: 'Terv',
      description: 'rajz',
      status: 'planned',
      priority: 'high',
      assignee: 'tervezo',
      project: 'Fejlesztési ötletek',
      parent_id: idOf(1),
    })
    // Missing description/assignee/priority fall back.
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(3, expect.objectContaining({
      id: idOf(3),
      title: 'Építés',
      description: '',
      priority: 'normal',
      assignee: 'TestBot',
      parent_id: idOf(1),
    }))
    expect(db.logIdeaStatusChange).toHaveBeenCalledWith(
      'idea-1', 'reviewed', 'kanban', 'main-agent', 'promote-breakdown:2 subtasks',
    )
    expect(db.updateIdea).toHaveBeenCalledWith('idea-1', { status: 'kanban', kanban_id: idOf(1) })
  })

  it('appends the success criteria to the parent description', async () => {
    seedIdea({ id: 'idea-1', description: 'Alap' })

    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A' }],
      success_criteria: '  Működik a kutyaház  ',
    }))

    expect(db.createKanbanCard).toHaveBeenNthCalledWith(1, expect.objectContaining({
      description: 'Alap\n\n## Siker-kritérium\nMűködik a kutyaház',
    }))
  })

  it('trims the leading blank lines when the idea has no description', async () => {
    seedIdea({ id: 'idea-1', description: null })

    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A' }],
      success_criteria: 'Kritérium',
    }))

    expect(db.createKanbanCard).toHaveBeenNthCalledWith(1, expect.objectContaining({
      description: '## Siker-kritérium\nKritérium',
    }))
  })

  it('ignores a whitespace-only success criteria', async () => {
    seedIdea({ id: 'idea-1', description: 'Alap' })
    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A' }],
      success_criteria: '   ',
    }))
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(1, expect.objectContaining({ description: 'Alap' }))
  })

  it('uses an empty parent description when both sources are absent', async () => {
    seedIdea({ id: 'idea-1', description: null })
    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({ subtasks: [{ title: 'A' }] }))
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(1, expect.objectContaining({ description: '' }))
  })

  it('skips subtasks with no title and does not count them', async () => {
    seedIdea({ id: 'idea-1' })

    const r = await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: '' }, { description: 'cim nelkul' }, { title: 'Van cím' }],
    }))

    expect(r.body).toEqual({ ok: true, parent_id: idOf(1), child_count: 1 })
    expect(db.createKanbanCard).toHaveBeenCalledTimes(2)
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: 'Van cím' }))
    expect(db.logIdeaStatusChange).toHaveBeenCalledWith(
      'idea-1', 'new', 'kanban', 'main-agent', 'promote-breakdown:1 subtasks',
    )
  })

  it('downgrades an unknown priority to normal', async () => {
    seedIdea({ id: 'idea-1' })
    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A', priority: 'kritikus' }],
    }))
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(2, expect.objectContaining({ priority: 'normal' }))
  })

  it.each(['low', 'normal', 'high', 'urgent'])('keeps the valid priority %s', async (priority) => {
    seedIdea({ id: 'idea-1' })
    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A', priority }],
    }))
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(2, expect.objectContaining({ priority }))
  })

  it('falls back to BOT_NAME for a null assignee', async () => {
    seedIdea({ id: 'idea-1' })
    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'A', assignee: null }],
    }))
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(2, expect.objectContaining({ assignee: 'TestBot' }))
  })

  it('truncates a long child title and description', async () => {
    seedIdea({ id: 'idea-1' })

    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({
      subtasks: [{ title: 'c'.repeat(200), description: 'd'.repeat(700) }],
    }))

    expect(db.createKanbanCard).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: 'c'.repeat(120),
      description: 'd'.repeat(500),
    }))
  })

  it('coerces a non-string child title', async () => {
    seedIdea({ id: 'idea-1' })
    await call('POST', '/api/ideas/idea-1/promote-breakdown', JSON.stringify({ subtasks: [{ title: 42 }] }))
    expect(db.createKanbanCard).toHaveBeenNthCalledWith(2, expect.objectContaining({ title: '42' }))
  })

  it('decodes a percent-encoded id', async () => {
    seedIdea({ id: 'a b' })
    const r = await call(
      'POST',
      `/api/ideas/${encodeURIComponent('a b')}/promote-breakdown`,
      JSON.stringify({ subtasks: [{ title: 'A' }] }),
    )
    expect(r.status).toBe(200)
    expect(db.updateIdea).toHaveBeenCalledWith('a b', { status: 'kanban', kanban_id: idOf(1) })
  })
})

// =======================================================================
describe('POST /api/ideas/:id/revert', () => {
  it('404s for an unknown idea', async () => {
    const r = await call('POST', '/api/ideas/nincs/revert')
    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
  })

  it.each(['new', 'reviewed', 'rejected'] as const)('400s for a %s idea', async (status) => {
    seedIdea({ id: 'idea-1', status })
    const r = await call('POST', '/api/ideas/idea-1/revert')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Csak kanban státuszú ötlet vonható vissza' })
    expect(db.updateIdea).not.toHaveBeenCalled()
  })

  it('reverts a kanban idea and clears the card link', async () => {
    seedIdea({ id: 'idea-1', status: 'kanban', kanban_id: 'kartya-1' })

    const r = await call('POST', '/api/ideas/idea-1/revert')

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ ok: true })
    expect(db.updateIdea).toHaveBeenCalledWith('idea-1', { status: 'reviewed', kanban_id: null })
    expect(db.logIdeaStatusChange).toHaveBeenCalledWith(
      'idea-1', 'kanban', 'reviewed', 'main-agent', 'Manuális visszavonás',
    )
  })

  it('decodes a percent-encoded id', async () => {
    seedIdea({ id: 'a b', status: 'kanban' })
    const r = await call('POST', `/api/ideas/${encodeURIComponent('a b')}/revert`)
    expect(r.status).toBe(200)
    expect(db.updateIdea).toHaveBeenCalledWith('a b', { status: 'reviewed', kanban_id: null })
  })
})

// =======================================================================
describe('GET /api/ideas/:id/status-log', () => {
  it('returns the audit rows', async () => {
    const rows = [{
      id: 1, idea_id: 'idea-1', from_status: 'new', to_status: 'reviewed',
      actor: 'main-agent', note: null, created_at: NOW_S,
    }]
    vi.mocked(db.getIdeaStatusLog).mockReturnValue(rows)

    const r = await call('GET', '/api/ideas/idea-1/status-log')

    expect(r.status).toBe(200)
    expect(r.body).toEqual({ log: rows })
    expect(db.getIdeaStatusLog).toHaveBeenCalledWith('idea-1')
  })

  it('decodes a percent-encoded id', async () => {
    await call('GET', `/api/ideas/${encodeURIComponent('a b')}/status-log`)
    expect(db.getIdeaStatusLog).toHaveBeenCalledWith('a b')
  })
})

// =======================================================================
// Pinned defects -- these assert the CURRENT behaviour, not the desired one.
// =======================================================================
describe('pinned defects', () => {
  it('rejects a comment for a non-existent idea with 404', async () => {
    const r = await call('POST', '/api/ideas/nincs-ilyen/comments', JSON.stringify({ content: 'c' }))

    expect(r.status).toBe(404)
    expect(r.body).toEqual({ error: 'Ötlet nem található' })
    expect(db.addIdeaComment).not.toHaveBeenCalled()
  })

  // routes-ideas-title-validation
  it('creates an idea whose title is only whitespace', async () => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ title: '   ' }))
    expect(r.status).toBe(400)
    expect(db.createIdea).not.toHaveBeenCalled()
  })

  it('creates an idea whose title is not a string', async () => {
    const r = await call('POST', '/api/ideas', JSON.stringify({ title: { hu: 'objektum' } }))
    expect(r.status).toBe(400)
    expect(db.createIdea).not.toHaveBeenCalled()
  })

  // routes-ideas-body-parse-500
  it.each([
    ['POST', '/api/ideas'],
    ['PUT', '/api/ideas/idea-1'],
    ['POST', '/api/ideas/idea-1/comments'],
    ['POST', '/api/ideas/idea-1/promote'],
    ['POST', '/api/ideas/idea-1/promote-breakdown'],
  ])('returns 400 Invalid JSON on a malformed body (%s %s)', async (method, path) => {
    seedIdea({ id: 'idea-1' })
    const r = await call(method, path, 'nem json')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Invalid JSON' })
    expect(db.createIdea).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
  })

  it.each([
    ['POST', '/api/ideas'],
    ['PUT', '/api/ideas/idea-1'],
    ['POST', '/api/ideas/idea-1/comments'],
    ['POST', '/api/ideas/idea-1/promote'],
    ['POST', '/api/ideas/idea-1/promote-breakdown'],
  ])('returns 400 Invalid JSON on a literal null body (%s %s)', async (method, path) => {
    seedIdea({ id: 'idea-1' })
    const r = await call(method, path, 'null')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Invalid JSON' })
    expect(db.createIdea).not.toHaveBeenCalled()
    expect(db.updateIdea).not.toHaveBeenCalled()
  })

  it('returns 400 Invalid JSON on an empty body', async () => {
    const r = await call('POST', '/api/ideas', '')
    expect(r.status).toBe(400)
    expect(r.body).toEqual({ error: 'Invalid JSON' })
  })
})
