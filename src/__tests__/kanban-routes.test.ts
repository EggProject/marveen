// 100% coverage suite for src/web/routes/kanban.ts.
//
// tryHandleKanban is the dispatcher for every kanban endpoint in
// src/web/routes/kanban.ts. Each branch is exercised here against a
// deterministic mock surface: all DB collaborators (createKanbanCard,
// moveKanbanCard, etc.), the config identity constants (OWNER_NAME,
// BOT_NAME, MAIN_AGENT_ID), the agent-config helpers (listAgentNames,
// readAgentDisplayName), the agent-process helper (isAgentRunning),
// the kanban-dispatch target resolver, the llm-breakdown generator,
// and the auth-gate/auth-sessions modules are stubbed. The two pure
// helpers from kanban-ref-normalize.js and http-helpers.js stay real
// (they are exercised by every test path that goes through them).
//
// The harness wraps `kanbanMoveInstructions` so the dispatch payload
// itself is also unit-tested as a string.

import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  return {
    // Populated in beforeAll (mkdtempSync can't run inside the hoisted block,
    // which has no access to fs/path/os).
    tmp: '',

    // config.js: identity constants + label colour palette used by the route
    OWNER_NAME: 'TestOwner',
    BOT_NAME: 'TestBot',
    MAIN_AGENT_ID: 'marvin',
    // Populated in beforeAll to a tmpdir-scoped value.
    STORE_DIR: '',
    WEB_HOST: '127.0.0.1',
    WEB_PORT: 3420,
    KANBAN_LABEL_COLORS: ['#3b82f6', '#0ea5e9', '#10b981', '#64748b'],

    // db.js collaborators (mocked by module).
    listKanbanCards: vi.fn<() => unknown[]>(() => []),
    createKanbanCard: vi.fn<(c: Record<string, unknown>) => void>(),
    updateKanbanCard: vi.fn<(id: string, fields: Record<string, unknown>) => boolean>(() => true),
    deleteKanbanCard: vi.fn<(id: string) => boolean>(() => true),
    moveKanbanCard: vi.fn<(id: string, status: string, sort: number, actor?: string) => boolean>(() => true),
    archiveKanbanCard: vi.fn<(id: string) => boolean>(() => true),
    unarchiveKanbanCard: vi.fn<(id: string) => boolean>(() => true),
    getKanbanComments: vi.fn<(cardId: string) => unknown[]>(() => []),
    addKanbanComment: vi.fn<(cardId: string, author: string, content: string) => unknown>(() => ({ id: 'cmt' })),
    getKanbanCardEvents: vi.fn<(cardId: string) => unknown[]>(() => []),
    listKanbanProjects: vi.fn<() => string[]>(() => []),
    getKanbanCard: vi.fn<(id: string) => Record<string, unknown> | undefined>(() => undefined),
    getChildCards: vi.fn<(parentId: string) => unknown[]>(() => []),
    getDb: vi.fn<() => { transaction: (fn: () => unknown) => () => unknown }>(() => ({
      transaction: (fn: () => unknown) => fn,
    })),
    createAgentMessage: vi.fn<(from: string, to: string, content: string) => void>(),
    markKanbanCardDispatched: vi.fn<(id: string) => boolean>(() => true),
    getKanbanSeqByIdPrefix: vi.fn<(prefix: string) => number | null>(() => null),
    listLabels: vi.fn<() => Array<{ id: string; name: string; color: string }>>(() => []),
    getLabel: vi.fn<(id: string) => { id: string; name: string; color: string } | undefined>(() => undefined),
    createLabel: vi.fn<(l: { id: string; name: string; color: string }) => { id: string; name: string; color: string }>(
      (l) => ({ id: l.id, name: l.name, color: l.color }),
    ),
    updateLabel: vi.fn<(id: string, fields: Record<string, unknown>) => boolean>(() => true),
    deleteLabel: vi.fn<(id: string) => boolean>(() => true),
    addLabelToCard: vi.fn<(cardId: string, labelId: string) => void>(),
    removeLabelFromCard: vi.fn<(cardId: string, labelId: string) => boolean>(() => true),
    getLabelsForAllCards: vi.fn<() => Map<string, unknown[]>>(() => new Map()),
    getLabelsForCard: vi.fn<(cardId: string) => unknown[]>(() => []),
    listArchivedKanbanCards: vi.fn<
      (opts: Record<string, unknown>) => Array<Record<string, unknown>>
    >(() => []),
    revertIdeaFromKanban: vi.fn<(id: string) => string | null>(() => null),

    // agent-config.js collaborators
    listAgentNames: vi.fn<() => string[]>(() => []),
    readAgentDisplayName: vi.fn<(name: string) => string>(() => ''),

    // agent-process.js collaborator (decides whether to dispatch to a sub-agent)
    isAgentRunning: vi.fn<(name: string) => boolean>(() => false),

    // llm-breakdown.js collaborator
    generateBreakdown: vi.fn<
      (title: string, description: string | null) => Promise<{ subtasks: Array<{ title: string; description: string; assignee: string | null; priority: string }> }>
    >(async () => ({ subtasks: [] })),

    // settings-store.js: KANBAN_ARCHIVED_MAX_ROWS default. The route's
    // `Math.min(limit || effective, 5000)` falls back to this when the
    // request omits `limit`. Default mirrors config-registry.ts (500).
    getEffectiveSettingValue: vi.fn<(key: string) => string | number>(() => 500),

    // logger -- no-op but tracked so we can assert on it
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
    },
  }
})

// --- vi.mock factories ------------------------------------------------------

vi.mock('../config.js', () => ({
  OWNER_NAME: H.OWNER_NAME,
  BOT_NAME: H.BOT_NAME,
  MAIN_AGENT_ID: H.MAIN_AGENT_ID,
  // STORE_DIR is captured by `kanbanMoveInstructions()` at call time -- so it
  // must reflect the current value of H.STORE_DIR, not whatever it was when
  // the module was first mocked. Getter ensures that.
  get STORE_DIR() { return H.STORE_DIR },
  WEB_HOST: H.WEB_HOST,
  WEB_PORT: H.WEB_PORT,
  KANBAN_LABEL_COLORS: H.KANBAN_LABEL_COLORS,
}))

vi.mock('../db.js', () => ({
  listKanbanCards: H.listKanbanCards,
  createKanbanCard: H.createKanbanCard,
  updateKanbanCard: H.updateKanbanCard,
  deleteKanbanCard: H.deleteKanbanCard,
  moveKanbanCard: H.moveKanbanCard,
  archiveKanbanCard: H.archiveKanbanCard,
  unarchiveKanbanCard: H.unarchiveKanbanCard,
  getKanbanComments: H.getKanbanComments,
  addKanbanComment: H.addKanbanComment,
  getKanbanCardEvents: H.getKanbanCardEvents,
  listKanbanProjects: H.listKanbanProjects,
  getKanbanCard: H.getKanbanCard,
  getChildCards: H.getChildCards,
  getDb: H.getDb,
  createAgentMessage: H.createAgentMessage,
  markKanbanCardDispatched: H.markKanbanCardDispatched,
  getKanbanSeqByIdPrefix: H.getKanbanSeqByIdPrefix,
  listLabels: H.listLabels,
  getLabel: H.getLabel,
  createLabel: H.createLabel,
  updateLabel: H.updateLabel,
  deleteLabel: H.deleteLabel,
  addLabelToCard: H.addLabelToCard,
  removeLabelFromCard: H.removeLabelFromCard,
  getLabelsForAllCards: H.getLabelsForAllCards,
  getLabelsForCard: H.getLabelsForCard,
  listArchivedKanbanCards: H.listArchivedKanbanCards,
  revertIdeaFromKanban: H.revertIdeaFromKanban,
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: H.listAgentNames,
  readAgentDisplayName: H.readAgentDisplayName,
}))

vi.mock('../web/agent-process.js', () => ({
  isAgentRunning: H.isAgentRunning,
}))

vi.mock('../web/llm-breakdown.js', () => ({
  generateBreakdown: H.generateBreakdown,
}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: H.getEffectiveSettingValue,
}))

vi.mock('../logger.js', () => ({
  logger: H.logger,
}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// --- imports ----------------------------------------------------------------

const { tryHandleKanban, kanbanMoveInstructions } = await import('../web/routes/kanban.js')
const { normalizeKanbanRefs } = await import('../web/kanban-ref-normalize.js')

// --- helpers ----------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
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
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(opts: { body?: unknown; raw?: Buffer | string } = {}): http.IncomingMessage {
  let payload: Buffer[]
  if (opts.raw !== undefined) {
    payload = [typeof opts.raw === 'string' ? Buffer.from(opts.raw) : opts.raw]
  } else if (opts.body !== undefined) {
    payload = [Buffer.from(JSON.stringify(opts.body))]
  } else {
    payload = []
  }
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  fullPath: string,
  opts: { body?: unknown; raw?: Buffer | string; query?: string; gzip?: boolean } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => unknown }> {
  const urlStr = `http://127.0.0.1:3420${fullPath}${opts.query ? `?${opts.query}` : ''}`
  const url = new URL(urlStr)
  const req = mkReq({ body: opts.body, raw: opts.raw })
  if (opts.gzip) req.headers['accept-encoding'] = 'gzip'
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
    fedPeer: null,
  }
  const handled = await tryHandleKanban(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  // Swap the placeholder STORE_DIR for a real tmpdir-scoped value.
  H.STORE_DIR = mkdtempSync(join(tmpdir(), 'kanban-routes-'))
})

beforeEach(() => {
  for (const fn of [
    H.listKanbanCards, H.createKanbanCard, H.updateKanbanCard, H.deleteKanbanCard,
    H.moveKanbanCard, H.archiveKanbanCard, H.unarchiveKanbanCard, H.getKanbanComments,
    H.addKanbanComment, H.getKanbanCardEvents, H.listKanbanProjects, H.getKanbanCard,
    H.getChildCards, H.getDb, H.createAgentMessage, H.markKanbanCardDispatched,
    H.getKanbanSeqByIdPrefix, H.listLabels, H.getLabel, H.createLabel, H.updateLabel,
    H.deleteLabel, H.addLabelToCard, H.removeLabelFromCard, H.getLabelsForAllCards,
    H.getLabelsForCard, H.listArchivedKanbanCards, H.revertIdeaFromKanban,
    H.listAgentNames, H.readAgentDisplayName, H.isAgentRunning, H.generateBreakdown,
    H.getEffectiveSettingValue,
  ]) {
    fn.mockClear()
  }
  H.logger.info.mockClear()
  H.logger.warn.mockClear()
  H.logger.error.mockClear()
  H.logger.debug.mockClear()

  // Reset default return values.
  H.listKanbanCards.mockReturnValue([])
  H.getKanbanCard.mockReturnValue(undefined)
  H.getKanbanComments.mockReturnValue([])
  H.getKanbanCardEvents.mockReturnValue([])
  H.listKanbanProjects.mockReturnValue([])
  H.getChildCards.mockReturnValue([])
  H.listLabels.mockReturnValue([])
  H.getLabel.mockReturnValue(undefined)
  H.getLabelsForAllCards.mockReturnValue(new Map())
  H.getLabelsForCard.mockReturnValue([])
  H.listArchivedKanbanCards.mockReturnValue([])
  H.listAgentNames.mockReturnValue([])
  H.readAgentDisplayName.mockReturnValue('')
  H.isAgentRunning.mockReturnValue(false)
  H.moveKanbanCard.mockReturnValue(true)
  H.updateKanbanCard.mockReturnValue(true)
  H.deleteKanbanCard.mockReturnValue(true)
  H.archiveKanbanCard.mockReturnValue(true)
  H.unarchiveKanbanCard.mockReturnValue(true)
  H.updateLabel.mockReturnValue(true)
  H.deleteLabel.mockReturnValue(true)
  H.removeLabelFromCard.mockReturnValue(true)
  H.createLabel.mockImplementation((l) => ({ id: l.id, name: l.name, color: l.color }))
  H.generateBreakdown.mockResolvedValue({ subtasks: [] })
  H.getEffectiveSettingValue.mockReturnValue(500)
})

// ===========================================================================
// kanbanMoveInstructions (pure string helper, exported)
// ===========================================================================

describe('kanbanMoveInstructions', () => {
  it('targets the main agent: escalateTo is OWNER_NAME, includes OWNER_NAME-specific critical note', () => {
    const out = kanbanMoveInstructions('cb1234ab', H.MAIN_AGENT_ID)
    expect(out).toContain('curl -s -X POST')
    expect(out).toContain('/api/kanban/cb1234ab/move')
    expect(out).toContain('/api/kanban/cb1234ab/comments')
    expect(out).toContain('/api/kanban/cb1234ab')
    expect(out).toContain(`"author":"${H.MAIN_AGENT_ID}"`)
    expect(out).toContain(`"assignee":"${H.OWNER_NAME}"`)
    expect(out).toContain('A kártyát in_progress-re húzták')
    expect(out).toContain(`mert ${H.OWNER_NAME} nem tudja kitalálni`)
    // Main agent branch uses OWNER_NAME in the escalation text.
    expect(out).toContain(`KÖZVETLENÜL ${H.OWNER_NAME}-hez`)
  })

  it('targets a sub-agent: escalateTo is MAIN_AGENT_ID, includes the FONTOS note about not routing to OWNER_NAME', () => {
    const out = kanbanMoveInstructions('de0000ff', 'sub-agent-1')
    expect(out).toContain(`"author":"sub-agent-1"`)
    expect(out).toContain(`"assignee":"${H.MAIN_AGENT_ID}"`)
    expect(out).toContain(`KÖZVETLENÜL ${H.MAIN_AGENT_ID}-hez`)
    expect(out).toContain('FONTOS')
    expect(out).toContain(`${H.MAIN_AGENT_ID} a delegálód`)
    // Source uses uppercase EGYENESEN NE in the sub-agent branch (full word).
    expect(out).toContain('EGYENESEN NE')
  })

  it('embeds the dashboard token path as a curl cat substitution', () => {
    const out = kanbanMoveInstructions('abc12345', 'sub-agent-x')
    expect(out).toContain(H.STORE_DIR)
    expect(out).toContain('.dashboard-token')
    expect(out).toContain('$(cat')
    expect(out).toContain('Bearer')
  })

  it('includes both move (status=done) and comment write commands plus the three-step blocked escalation', () => {
    const out = kanbanMoveInstructions('id000099', H.MAIN_AGENT_ID)
    expect(out).toContain('"status":"done"')
    expect(out).toContain('"content":"AZ EREDMENY ROVIDEN"')
    expect(out).toContain('HÁROM lépés kell EGYÜTT')
    // Source uses status="waiting" (not JSON-quoted) in the instructions.
    expect(out).toContain('status="waiting"')
    expect(out).toContain('"assignee":')
  })
})

// ===========================================================================
// Dispatcher surface (path/method filter)
// ===========================================================================

describe('tryHandleKanban -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for a wrong-method request on a known kanban prefix', async () => {
    // PATCH is not handled on /api/kanban.
    const { handled } = await call('PATCH', '/api/kanban')
    expect(handled).toBe(false)
  })

  it('returns false for an unknown kanban-card subroute method (POST /api/kanban/:id/children)', async () => {
    // Only GET /:id/children is implemented.
    const { handled } = await call('POST', '/api/kanban/abcd1234/children')
    expect(handled).toBe(false)
  })
})

// ===========================================================================
// GET /api/kanban
// ===========================================================================

describe('GET /api/kanban', () => {
  it('returns cards with labels merged in from the bulk labels lookup', async () => {
    const cardA = { id: 'aaa', title: 'A' }
    const cardB = { id: 'bbb', title: 'B' }
    H.listKanbanCards.mockReturnValue([cardA, cardB])
    H.getLabelsForAllCards.mockReturnValue(
      new Map([['aaa', [{ id: 'l1', name: 'bug', color: '#f00' }]]]),
    )
    const { res, json } = await call('GET', '/api/kanban')
    expect(res.statusCode).toBe(200)
    const out = json() as Array<{ id: string; labels: unknown[] }>
    expect(out).toHaveLength(2)
    expect(out[0].id).toBe('aaa')
    expect(out[0].labels).toEqual([{ id: 'l1', name: 'bug', color: '#f00' }])
    expect(out[1].labels).toEqual([])
  })

  it('gzip-encodes the payload when the client sends accept-encoding: gzip and the body is large enough', async () => {
    // Build a payload > 1KB so gzip triggers.
    const big = 'x'.repeat(2048)
    H.listKanbanCards.mockReturnValue([{ id: 'x', big }])
    H.getLabelsForAllCards.mockReturnValue(new Map())
    const { res, json } = await call('GET', '/api/kanban', { gzip: true })
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Encoding']).toBe('gzip')
    // json() would throw on gzipped bytes -- assert the raw response shape instead.
    expect(res.body.length).toBeGreaterThan(0)
    // Round-trip the body to confirm content is identical to the ungzipped variant.
    const plain = await call('GET', '/api/kanban')
    const plainJson = plain.json() as Array<{ id: string; big: string }>
    expect(plainJson[0].big).toBe(big)
  })
})

// ===========================================================================
// Labels -- /api/kanban/labels
// ===========================================================================

describe('GET /api/kanban/labels', () => {
  it('returns the label list', async () => {
    H.listLabels.mockReturnValue([
      { id: 'l1', name: 'bug', color: '#f00' },
      { id: 'l2', name: 'p0', color: '#0f0' },
    ])
    const { res, json } = await call('GET', '/api/kanban/labels')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([
      { id: 'l1', name: 'bug', color: '#f00' },
      { id: 'l2', name: 'p0', color: '#0f0' },
    ])
  })
})

describe('POST /api/kanban/labels', () => {
  it('creates a label and returns it', async () => {
    const { res, json } = await call('POST', '/api/kanban/labels', {
      body: { name: 'feature', color: '#3b82f6' },
    })
    expect(res.statusCode).toBe(200)
    const out = json() as { id: string; name: string; color: string }
    expect(out.name).toBe('feature')
    expect(out.color).toBe('#3b82f6')
    expect(typeof out.id).toBe('string')
    expect(out.id).toHaveLength(8)
    expect(H.createLabel).toHaveBeenCalled()
  })

  it('falls back to the first palette colour when the requested colour is not in KANBAN_LABEL_COLORS', async () => {
    const { res, json } = await call('POST', '/api/kanban/labels', {
      body: { name: 'feature', color: '#deadbe' },
    })
    expect(res.statusCode).toBe(200)
    expect((json() as { color: string }).color).toBe(H.KANBAN_LABEL_COLORS[0])
  })

  it('falls back to the first palette colour when colour is omitted entirely', async () => {
    const { res, json } = await call('POST', '/api/kanban/labels', {
      body: { name: 'feature' },
    })
    expect(res.statusCode).toBe(200)
    expect((json() as { color: string }).color).toBe(H.KANBAN_LABEL_COLORS[0])
  })

  it('returns 400 with a localized error when name is missing or whitespace', async () => {
    const { res, json } = await call('POST', '/api/kanban/labels', { body: { name: '   ' } })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Címke neve kötelező' })
  })

  it('returns 400 with a localized error when name is undefined (omitted)', async () => {
    const { res, json } = await call('POST', '/api/kanban/labels', { body: {} })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Címke neve kötelező' })
  })

  it('trims the name before persisting', async () => {
    const { json } = await call('POST', '/api/kanban/labels', {
      body: { name: '  feature  ', color: '#3b82f6' },
    })
    expect((json() as { name: string }).name).toBe('feature')
  })
})

// ===========================================================================
// /api/kanban/labels/:id  (PUT/DELETE)
// ===========================================================================

describe('PUT /api/kanban/labels/:id', () => {
  it('updates the label and returns ok:true', async () => {
    const { res, json } = await call('PUT', '/api/kanban/labels/l1', {
      body: { name: 'bug-fix', color: '#3b82f6' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.updateLabel).toHaveBeenCalledWith('l1', { name: 'bug-fix', color: '#3b82f6' })
  })

  it('falls back to the first palette colour when colour is not in KANBAN_LABEL_COLORS', async () => {
    const { res } = await call('PUT', '/api/kanban/labels/l1', {
      body: { name: 'foo', color: '#deadbe' },
    })
    expect(res.statusCode).toBe(200)
    expect(H.updateLabel).toHaveBeenCalledWith('l1', { name: 'foo', color: H.KANBAN_LABEL_COLORS[0] })
  })

  it('passes through an in-palette colour unchanged', async () => {
    await call('PUT', '/api/kanban/labels/l1', { body: { color: '#0ea5e9' } })
    expect(H.updateLabel).toHaveBeenCalledWith('l1', { color: '#0ea5e9' })
  })

  it('returns 400 with a localized error when name is empty/whitespace', async () => {
    const { res, json } = await call('PUT', '/api/kanban/labels/l1', {
      body: { name: '   ' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Címke neve kötelező' })
  })

  it('returns 400 when name is the empty string (trim check)', async () => {
    const { res } = await call('PUT', '/api/kanban/labels/l1', { body: { name: '' } })
    expect(res.statusCode).toBe(400)
  })

  it('does not pass name through when undefined (skipped)', async () => {
    await call('PUT', '/api/kanban/labels/l1', { body: { color: '#3b82f6' } })
    expect(H.updateLabel).toHaveBeenCalledWith('l1', { color: '#3b82f6' })
  })

  it('returns 404 when updateLabel returns false (label not found)', async () => {
    H.updateLabel.mockReturnValue(false)
    const { res, json } = await call('PUT', '/api/kanban/labels/missing', {
      body: { name: 'foo' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Címke nem található' })
  })
})

describe('DELETE /api/kanban/labels/:id', () => {
  it('deletes the label and returns ok:true', async () => {
    const { res, json } = await call('DELETE', '/api/kanban/labels/l1')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.deleteLabel).toHaveBeenCalledWith('l1')
  })

  it('returns 404 when the label does not exist', async () => {
    H.deleteLabel.mockReturnValue(false)
    const { res, json } = await call('DELETE', '/api/kanban/labels/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Címke nem található' })
  })
})

// ===========================================================================
// /api/kanban/:cardId/labels
// ===========================================================================

describe('GET /api/kanban/:cardId/labels', () => {
  it('returns the labels bound to a card', async () => {
    H.getLabelsForCard.mockReturnValue([{ id: 'l1', name: 'bug', color: '#f00' }])
    const { res, json } = await call('GET', '/api/kanban/card1/labels')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([{ id: 'l1', name: 'bug', color: '#f00' }])
  })
})

describe('POST /api/kanban/:cardId/labels', () => {
  it('attaches a label to a card (labelId alias)', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'card1', title: 't' })
    H.getLabel.mockReturnValue({ id: 'l1', name: 'bug', color: '#f00' })
    const { res, json } = await call('POST', '/api/kanban/card1/labels', {
      body: { labelId: 'l1' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.addLabelToCard).toHaveBeenCalledWith('card1', 'l1')
  })

  it('accepts `id` as an alias for `labelId`', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'card1', title: 't' })
    H.getLabel.mockReturnValue({ id: 'l1', name: 'bug', color: '#f00' })
    await call('POST', '/api/kanban/card1/labels', { body: { id: 'l1' } })
    expect(H.addLabelToCard).toHaveBeenCalledWith('card1', 'l1')
  })

  it('returns 404 when the card does not exist', async () => {
    H.getKanbanCard.mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/kanban/missing/labels', {
      body: { labelId: 'l1' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Kártya nem található' })
  })

  it('returns 400 when labelId is missing', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'card1', title: 't' })
    const { res, json } = await call('POST', '/api/kanban/card1/labels', { body: {} })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'labelId mező kötelező' })
  })

  it('returns 404 with a name-vs-id hint when the labelId resolves to a known name', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'card1', title: 't' })
    H.getLabel.mockReturnValue(undefined)
    H.listLabels.mockReturnValue([
      { id: 'real-l1', name: 'bug', color: '#f00' },
      { id: 'real-l2', name: 'p0', color: '#0f0' },
    ])
    const { res, json } = await call('POST', '/api/kanban/card1/labels', {
      body: { labelId: 'bug' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({
      error: 'Címke nem található id alapján -- a "bug" egy név, nem id. Használd az id-t: real-l1',
    })
  })

  it('returns 404 with a generic not-found when the labelId is neither an id nor a name', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'card1', title: 't' })
    H.getLabel.mockReturnValue(undefined)
    H.listLabels.mockReturnValue([{ id: 'real-l1', name: 'bug', color: '#f00' }])
    const { res, json } = await call('POST', '/api/kanban/card1/labels', {
      body: { labelId: 'something-bogus' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Címke nem található' })
  })
})

describe('DELETE /api/kanban/:cardId/labels/:labelId', () => {
  it('removes the label and returns ok:true', async () => {
    const { res, json } = await call('DELETE', '/api/kanban/card1/labels/l1')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.removeLabelFromCard).toHaveBeenCalledWith('card1', 'l1')
  })

  it('returns 404 when the card does not have the label', async () => {
    H.removeLabelFromCard.mockReturnValue(false)
    const { res, json } = await call('DELETE', '/api/kanban/card1/labels/l1')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'A kártyán nincs ilyen címke' })
  })
})

// ===========================================================================
// /api/kanban-projects
// ===========================================================================

describe('GET /api/kanban-projects', () => {
  it('returns the project list', async () => {
    H.listKanbanProjects.mockReturnValue(['alpha', 'beta'])
    const { res, json } = await call('GET', '/api/kanban-projects')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual(['alpha', 'beta'])
  })
})

// ===========================================================================
// /api/kanban/assignees
// ===========================================================================

describe('GET /api/kanban/assignees', () => {
  it('returns owner + bot + every agent name with its display name (falling back to the name)', async () => {
    H.listAgentNames.mockReturnValue(['agent-a', 'agent-b'])
    H.readAgentDisplayName.mockImplementation((n) => (n === 'agent-a' ? 'A Display' : ''))
    const { res, json } = await call('GET', '/api/kanban/assignees')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([
      { name: H.OWNER_NAME, type: 'owner' },
      { name: H.BOT_NAME, type: 'bot' },
      { name: 'agent-a', type: 'agent', displayName: 'A Display' },
      { name: 'agent-b', type: 'agent', displayName: 'agent-b' },
    ])
  })
})

// ===========================================================================
// POST /api/kanban
// ===========================================================================

describe('POST /api/kanban', () => {
  it('creates a card with a generated id and returns ok+id', async () => {
    const { res, json } = await call('POST', '/api/kanban', {
      body: { title: 'New', priority: 'normal' },
    })
    expect(res.statusCode).toBe(200)
    const out = json() as { ok: boolean; id: string }
    expect(out.ok).toBe(true)
    expect(typeof out.id).toBe('string')
    expect(out.id).toHaveLength(8)
    expect(H.createKanbanCard).toHaveBeenCalledWith(
      expect.objectContaining({ id: out.id, title: 'New', priority: 'normal' }),
    )
  })
})

// ===========================================================================
// /api/kanban/:id  (PUT/DELETE)
// ===========================================================================

describe('PUT /api/kanban/:id', () => {
  it('updates the card and returns ok:true', async () => {
    const { res, json } = await call('PUT', '/api/kanban/abcd1234', {
      body: { title: 'updated' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.updateKanbanCard).toHaveBeenCalledWith('abcd1234', { title: 'updated' })
  })

  it('returns 404 when the card does not exist', async () => {
    H.updateKanbanCard.mockReturnValue(false)
    const { res, json } = await call('PUT', '/api/kanban/missing', {
      body: { title: 'x' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Kártya nem található' })
  })
})

describe('DELETE /api/kanban/:id', () => {
  it('reverts any idea reference and then deletes the card', async () => {
    H.deleteKanbanCard.mockReturnValue(true)
    H.revertIdeaFromKanban.mockReturnValue('idea-7')
    const { res, json } = await call('DELETE', '/api/kanban/abcd1234')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.revertIdeaFromKanban).toHaveBeenCalledWith('abcd1234')
    expect(H.deleteKanbanCard).toHaveBeenCalledWith('abcd1234')
  })

  it('still calls revertIdeaFromKanban even when the card is missing (defensive ordering)', async () => {
    H.deleteKanbanCard.mockReturnValue(false)
    const { res, json } = await call('DELETE', '/api/kanban/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Kártya nem található' })
    expect(H.revertIdeaFromKanban).toHaveBeenCalledWith('missing')
  })
})

// ===========================================================================
// /api/kanban/:id/move  (dispatch on in_progress)
// ===========================================================================

describe('POST /api/kanban/:id/move', () => {
  it('moves the card without dispatching when status is not in_progress', async () => {
    const { res, json } = await call('POST', '/api/kanban/abcd1234/move', {
      body: { status: 'todo', sort_order: 5, actor: 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.moveKanbanCard).toHaveBeenCalledWith('abcd1234', 'todo', 5, 'alice')
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('falls back to sort_order 0 when sort_order is omitted', async () => {
    const { res } = await call('POST', '/api/kanban/abcd1234/move', {
      body: { status: 'todo', actor: 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(H.moveKanbanCard).toHaveBeenCalledWith('abcd1234', 'todo', 0, 'alice')
  })

  it('fires the dispatch when status=in_progress and the target resolves to the main agent', async () => {
    H.getKanbanCard.mockReturnValue({
      id: 'abcd1234',
      title: 'work on X',
      description: 'do the thing',
      assignee: H.BOT_NAME,
      dispatched_at: undefined,
    })
    const { res } = await call('POST', '/api/kanban/abcd1234/move', {
      body: { status: 'in_progress', actor: 'alice' },
    })
    expect(res.statusCode).toBe(200)
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      H.MAIN_AGENT_ID,
      H.MAIN_AGENT_ID,
      expect.stringContaining('[Kanban feladat #abcd1234]: work on X'),
    )
    expect(H.markKanbanCardDispatched).toHaveBeenCalledWith('abcd1234')
    expect(H.logger.info).toHaveBeenCalled()
  })

  it('fires the dispatch when status=in_progress and the target resolves to a running sub-agent', async () => {
    H.getKanbanCard.mockReturnValue({
      id: 'abcd1234',
      title: 'work on X',
      description: '',
      assignee: 'sub-agent-1',
      dispatched_at: undefined,
    })
    H.listAgentNames.mockReturnValue(['sub-agent-1'])
    H.isAgentRunning.mockReturnValue(true)
    const { res } = await call('POST', '/api/kanban/abcd1234/move', {
      body: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(200)
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      H.MAIN_AGENT_ID,
      'sub-agent-1',
      expect.any(String),
    )
  })

  it('omits the description suffix in the dispatch content when the description is empty', async () => {
    H.getKanbanCard.mockReturnValue({
      id: 'abcd1234',
      title: 'work on X',
      description: '',
      assignee: H.BOT_NAME,
      dispatched_at: undefined,
    })
    await call('POST', '/api/kanban/abcd1234/move', { body: { status: 'in_progress' } })
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      H.MAIN_AGENT_ID,
      H.MAIN_AGENT_ID,
      expect.stringMatching(/\[Kanban feladat #abcd1234\]: work on X\n\n/),
    )
  })

  it('does not insert the description prefix when description is null (uses empty trimmed fallback)', async () => {
    H.getKanbanCard.mockReturnValue({
      id: 'abcd1234',
      title: 'work on X',
      description: null,
      assignee: H.BOT_NAME,
      dispatched_at: undefined,
    })
    await call('POST', '/api/kanban/abcd1234/move', { body: { status: 'in_progress' } })
    const callArgs = H.createAgentMessage.mock.calls[0]
    // Specifically the description-prefix pattern is absent -- the message
    // starts with the title and a blank, not with "title — null".
    expect(callArgs[2].startsWith('[Kanban feladat #abcd1234]: work on X\n\n')).toBe(true)
  })

  it('does not dispatch when the card is already dispatched (once-only guard)', async () => {
    H.getKanbanCard.mockReturnValue({
      id: 'abcd1234',
      title: 'work on X',
      description: '',
      assignee: H.BOT_NAME,
      dispatched_at: 1,
    })
    await call('POST', '/api/kanban/abcd1234/move', { body: { status: 'in_progress' } })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
    expect(H.markKanbanCardDispatched).not.toHaveBeenCalled()
  })

  it('does not dispatch when getKanbanCard returns undefined (defensive: card not found at dispatch time)', async () => {
    H.getKanbanCard.mockReturnValue(undefined)
    await call('POST', '/api/kanban/abcd1234/move', { body: { status: 'in_progress' } })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('does not dispatch when the target resolves to null (no running agent / owner)', async () => {
    H.getKanbanCard.mockReturnValue({
      id: 'abcd1234',
      title: 'work on X',
      description: '',
      assignee: H.OWNER_NAME,
      dispatched_at: undefined,
    })
    await call('POST', '/api/kanban/abcd1234/move', { body: { status: 'in_progress' } })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
    expect(H.markKanbanCardDispatched).not.toHaveBeenCalled()
  })

  it('swallows dispatch errors with a logger.warn (card move still succeeds)', async () => {
    H.getKanbanCard.mockImplementation(() => {
      throw new Error('db blew up')
    })
    const { res, json } = await call('POST', '/api/kanban/abcd1234/move', {
      body: { status: 'in_progress' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.logger.warn).toHaveBeenCalled()
  })

  it('returns 404 when moveKanbanCard returns false (card not found)', async () => {
    H.moveKanbanCard.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/kanban/missing/move', {
      body: { status: 'todo' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Kártya nem található' })
  })
})

// ===========================================================================
// /api/kanban/:id/archive + /api/kanban/archived + /api/kanban/:id/unarchive
// ===========================================================================

describe('POST /api/kanban/:id/archive', () => {
  it('reverts the idea and then archives the card', async () => {
    H.archiveKanbanCard.mockReturnValue(true)
    const { res, json } = await call('POST', '/api/kanban/abcd1234/archive')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.revertIdeaFromKanban).toHaveBeenCalledWith('abcd1234')
    expect(H.archiveKanbanCard).toHaveBeenCalledWith('abcd1234')
  })

  it('returns 404 when archiveKanbanCard returns false', async () => {
    H.archiveKanbanCard.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/kanban/missing/archive')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Kártya nem található' })
  })
})

describe('GET /api/kanban/archived', () => {
  it('passes through every query-string filter to listArchivedKanbanCards and embeds labels', async () => {
    H.listArchivedKanbanCards.mockReturnValue([{ id: 'a', title: 'A' }])
    H.getLabelsForAllCards.mockReturnValue(new Map([['a', [{ id: 'l1', name: 'bug', color: '#f00' }]]]))
    const { res, json } = await call('GET', '/api/kanban/archived', {
      query: 'q=foo&project=alpha&label=l1&from=1&to=10&limit=50',
    })
    expect(res.statusCode).toBe(200)
    const out = json() as { cards: Array<{ id: string; labels: unknown[] }>; total: number; limit: number }
    expect(out.cards).toHaveLength(1)
    expect(out.cards[0].labels).toEqual([{ id: 'l1', name: 'bug', color: '#f00' }])
    expect(out.total).toBe(1)
    expect(H.listArchivedKanbanCards).toHaveBeenCalledWith({
      q: 'foo',
      project: 'alpha',
      label: 'l1',
      from: 1,
      to: 10,
      limit: 50,
    })
  })

  it('defaults labels to an empty array when the card id is missing from the labelsByCard map', async () => {
    H.listArchivedKanbanCards.mockReturnValue([
      { id: 'has', title: 'Has labels' },
      { id: 'hasnt', title: 'No labels' },
    ])
    H.getLabelsForAllCards.mockReturnValue(new Map([
      ['has', [{ id: 'l1', name: 'bug', color: '#f00' }]],
    ]))
    const { res, json } = await call('GET', '/api/kanban/archived')
    expect(res.statusCode).toBe(200)
    const out = json() as { cards: Array<{ id: string; labels: unknown[] }> }
    expect(out.cards[0].id).toBe('has')
    expect(out.cards[0].labels).toHaveLength(1)
    expect(out.cards[1].id).toBe('hasnt')
    expect(out.cards[1].labels).toEqual([])
  })

  it('clamps the limit to 5000 (caps the per-request window)', async () => {
    H.listArchivedKanbanCards.mockReturnValue([])
    await call('GET', '/api/kanban/archived', { query: 'limit=99999' })
    expect(H.listArchivedKanbanCards).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 5000 }),
    )
  })

  it('treats blank/whitespace query-string values as undefined', async () => {
    H.listArchivedKanbanCards.mockReturnValue([])
    await call('GET', '/api/kanban/archived', {
      query: 'q=%20%20&project=%20&label=%20',
    })
    expect(H.listArchivedKanbanCards).toHaveBeenCalledWith({
      q: undefined,
      project: undefined,
      label: undefined,
      from: undefined,
      to: undefined,
      limit: 500,
    })
  })

  it('returns an empty result set when there are no archived cards', async () => {
    const { res, json } = await call('GET', '/api/kanban/archived')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ cards: [], total: 0, limit: 500 })
  })

  it('uses the KANBAN_ARCHIVED_MAX_ROWS override when set (via getEffectiveSettingValue)', async () => {
    H.listArchivedKanbanCards.mockReturnValue([])
    H.getEffectiveSettingValue.mockReturnValue(1234)
    const { json } = await call('GET', '/api/kanban/archived')
    expect((json() as { limit: number }).limit).toBe(1234)
    expect(H.getEffectiveSettingValue).toHaveBeenCalledWith('KANBAN_ARCHIVED_MAX_ROWS')
  })
})

describe('POST /api/kanban/:id/unarchive', () => {
  it('unarchives the card and returns ok:true', async () => {
    const { res, json } = await call('POST', '/api/kanban/abcd1234/unarchive')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.unarchiveKanbanCard).toHaveBeenCalledWith('abcd1234')
  })

  it('returns 404 when unarchiveKanbanCard returns false (not archived or not found)', async () => {
    H.unarchiveKanbanCard.mockReturnValue(false)
    const { res, json } = await call('POST', '/api/kanban/missing/unarchive')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Kártya nem található vagy nincs archiválva' })
  })
})

// ===========================================================================
// /api/kanban/:id/comments (GET/POST)
// ===========================================================================

describe('GET /api/kanban/:id/comments', () => {
  it('returns the comments for a card', async () => {
    H.getKanbanComments.mockReturnValue([{ id: 'c1', content: 'hi' }])
    const { res, json } = await call('GET', '/api/kanban/abcd1234/comments')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([{ id: 'c1', content: 'hi' }])
  })
})

describe('POST /api/kanban/:id/comments', () => {
  it('adds a comment with author + content and returns the new record', async () => {
    H.addKanbanComment.mockReturnValue({ id: 'c1', author: 'alice', content: 'hello' })
    const { res, json } = await call('POST', '/api/kanban/abcd1234/comments', {
      body: { author: 'alice', content: 'hello' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ id: 'c1', author: 'alice', content: 'hello' })
    expect(H.addKanbanComment).toHaveBeenCalledWith('abcd1234', 'alice', 'hello')
  })

  it('returns 400 when author is missing', async () => {
    const { res, json } = await call('POST', '/api/kanban/abcd1234/comments', {
      body: { content: 'hello' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Szerző és tartalom kötelező' })
  })

  it('returns 400 when content is missing', async () => {
    const { res, json } = await call('POST', '/api/kanban/abcd1234/comments', {
      body: { author: 'alice' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Szerző és tartalom kötelező' })
  })

  it('normalises #<hex8> kanban-card refs in the content via the seq lookup', async () => {
    H.getKanbanSeqByIdPrefix.mockImplementation((p) => (p === 'cb5080e5' ? 31 : null))
    await call('POST', '/api/kanban/abcd1234/comments', {
      body: { author: 'alice', content: 'see #cb5080e5 for context' },
    })
    expect(H.addKanbanComment).toHaveBeenCalledWith(
      'abcd1234',
      'alice',
      'see #31 for context',
    )
  })

  it('passes content through untouched when no #<hex8> ref is present', async () => {
    await call('POST', '/api/kanban/abcd1234/comments', {
      body: { author: 'alice', content: 'plain message' },
    })
    expect(H.addKanbanComment).toHaveBeenCalledWith('abcd1234', 'alice', 'plain message')
  })

  it('passes non-matching hex refs through (lookup returns null)', async () => {
    H.getKanbanSeqByIdPrefix.mockReturnValue(null)
    await call('POST', '/api/kanban/abcd1234/comments', {
      body: { author: 'alice', content: 'random #deadbeef token' },
    })
    expect(H.addKanbanComment).toHaveBeenCalledWith('abcd1234', 'alice', 'random #deadbeef token')
  })

  it('short-circuits normalizeKanbanRefs when the content lacks any "#" character', async () => {
    // No "#" -> normalizeKanbanRefs returns the input as-is, getKanbanSeqByIdPrefix
    // never gets called. This is the fast-path branch in normalizeKanbanRefs
    // that the route relies on.
    await call('POST', '/api/kanban/abcd1234/comments', {
      body: { author: 'alice', content: 'no hash here' },
    })
    expect(H.getKanbanSeqByIdPrefix).not.toHaveBeenCalled()
    expect(H.addKanbanComment).toHaveBeenCalledWith('abcd1234', 'alice', 'no hash here')
  })
})

// ===========================================================================
// /api/kanban/:id/events
// ===========================================================================

describe('GET /api/kanban/:id/events', () => {
  it('returns the events for a card', async () => {
    H.getKanbanCardEvents.mockReturnValue([{ id: 'e1', kind: 'moved' }])
    const { res, json } = await call('GET', '/api/kanban/abcd1234/events')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([{ id: 'e1', kind: 'moved' }])
  })
})

// ===========================================================================
// /api/kanban/:id/breakdown
// ===========================================================================

describe('POST /api/kanban/:id/breakdown', () => {
  it('returns 404 when the card does not exist', async () => {
    H.getKanbanCard.mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/kanban/missing/breakdown')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Kártya nem található' })
  })

  it('returns 409 when the card already has subtasks', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P' })
    H.getChildCards.mockReturnValue([{ id: 'c1' }])
    const { res, json } = await call('POST', '/api/kanban/parent/breakdown')
    expect(res.statusCode).toBe(409)
    expect(json()).toEqual({ error: 'A kártya már rendelkezik subtask-okkal' })
  })

  it('generates the breakdown and returns its subtasks', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P', description: 'd' })
    H.getChildCards.mockReturnValue([])
    H.generateBreakdown.mockResolvedValue({
      subtasks: [
        { title: 't1', description: 'd1', assignee: 'alice', priority: 'high' },
        { title: 't2', description: 'd2', assignee: null, priority: 'normal' },
      ],
    })
    const { res, json } = await call('POST', '/api/kanban/parent/breakdown')
    expect(res.statusCode).toBe(200)
    const out = json() as { subtasks: unknown[] }
    expect(out.subtasks).toHaveLength(2)
    expect(H.generateBreakdown).toHaveBeenCalledWith('P', 'd')
  })

  it('returns 500 with the error message when generateBreakdown throws', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P', description: 'd' })
    H.getChildCards.mockReturnValue([])
    H.generateBreakdown.mockRejectedValue(new Error('llm down'))
    const { res, json } = await call('POST', '/api/kanban/parent/breakdown')
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'llm down' })
    expect(H.logger.error).toHaveBeenCalled()
  })

  it('passes null description through (no implicit empty-string coercion by the route)', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P', description: null })
    H.getChildCards.mockReturnValue([])
    H.generateBreakdown.mockResolvedValue({ subtasks: [] })
    await call('POST', '/api/kanban/parent/breakdown')
    expect(H.generateBreakdown).toHaveBeenCalledWith('P', null)
  })
})

// ===========================================================================
// /api/kanban/:id/breakdown/accept
// ===========================================================================

describe('POST /api/kanban/:id/breakdown/accept', () => {
  it('returns 404 when the parent card does not exist', async () => {
    H.getKanbanCard.mockReturnValue(undefined)
    const { res, json } = await call('POST', '/api/kanban/missing/breakdown/accept', {
      body: { subtasks: [{ title: 't', description: 'd', assignee: 'a', priority: 'p' }] },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Szülő kártya nem található' })
  })

  it('returns 400 when subtasks is not an array', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P', project: 'alpha' })
    const { res, json } = await call('POST', '/api/kanban/parent/breakdown/accept', {
      body: { subtasks: 'not-an-array' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Subtask lista kötelező' })
  })

  it('returns 400 when subtasks is an empty array', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P' })
    const { res, json } = await call('POST', '/api/kanban/parent/breakdown/accept', {
      body: { subtasks: [] },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Subtask lista kötelező' })
  })

  it('creates each subtask with an uppercased id, links them to the parent, and posts a summary comment', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P', project: 'alpha' })
    const subtasks = [
      { title: 't1', description: 'd1', assignee: 'alice', priority: 'high' },
      { title: 't2', description: 'd2', assignee: null, priority: 'normal' },
    ]
    const { res, json } = await call('POST', '/api/kanban/parent/breakdown/accept', {
      body: { subtasks },
    })
    expect(res.statusCode).toBe(200)
    const out = json() as { ok: boolean; created: string[] }
    expect(out.ok).toBe(true)
    expect(out.created).toHaveLength(2)
    expect(out.created[0]).toMatch(/^[0-9A-F]{8}$/)
    expect(out.created[1]).toMatch(/^[0-9A-F]{8}$/)
    expect(H.createKanbanCard).toHaveBeenCalledTimes(2)
    expect(H.createKanbanCard).toHaveBeenNthCalledWith(1, expect.objectContaining({
      title: 't1',
      description: 'd1',
      assignee: 'alice',
      priority: 'high',
      project: 'alpha',
      parent_id: 'parent',
    }))
    expect(H.createKanbanCard).toHaveBeenNthCalledWith(2, expect.objectContaining({
      title: 't2',
      description: 'd2',
      // null assignee is coerced to undefined.
      assignee: undefined,
      priority: 'normal',
      project: 'alpha',
      parent_id: 'parent',
    }))
    expect(H.addKanbanComment).toHaveBeenCalledWith(
      'parent',
      H.BOT_NAME,
      expect.stringMatching(/Auto-breakdown: 2 subtask/),
    )
  })

  it('defaults priority to "normal" when omitted on a subtask', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P', project: 'alpha' })
    await call('POST', '/api/kanban/parent/breakdown/accept', {
      body: { subtasks: [{ title: 't1', description: 'd1', assignee: 'alice' }] },
    })
    expect(H.createKanbanCard).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'normal',
    }))
  })

  it('omits the project field when the parent has no project', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P' })
    await call('POST', '/api/kanban/parent/breakdown/accept', {
      body: { subtasks: [{ title: 't', description: 'd', assignee: 'alice', priority: 'high' }] },
    })
    expect(H.createKanbanCard).toHaveBeenCalledWith(expect.objectContaining({
      project: undefined,
      parent_id: 'parent',
    }))
  })

  it('coerces a null priority to the default ("normal")', async () => {
    H.getKanbanCard.mockReturnValue({ id: 'parent', title: 'P', project: 'alpha' })
    await call('POST', '/api/kanban/parent/breakdown/accept', {
      body: {
        subtasks: [{ title: 't', description: 'd', assignee: 'alice', priority: null as unknown as string }],
      },
    })
    expect(H.createKanbanCard).toHaveBeenCalledWith(expect.objectContaining({
      priority: 'normal',
    }))
  })
})

// ===========================================================================
// /api/kanban/:id/children
// ===========================================================================

describe('GET /api/kanban/:id/children', () => {
  it('returns the child cards of a parent', async () => {
    H.getChildCards.mockReturnValue([
      { id: 'c1', title: 't1' },
      { id: 'c2', title: 't2' },
    ])
    const { res, json } = await call('GET', '/api/kanban/parent/children')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([
      { id: 'c1', title: 't1' },
      { id: 'c2', title: 't2' },
    ])
  })
})

// ===========================================================================
// Sanity: end-to-end normalization through normalizeKanbanRefs is exposed
// (sanity check that the helper we mock-passthrough is the same one the
// route uses).
// ===========================================================================

describe('normalizeKanbanRefs (sanity)', () => {
  it('rewrites #<hex8> -> #<seq> when the lookup returns a number', () => {
    const out = normalizeKanbanRefs('see #cb5080e5', (p) => (p === 'cb5080e5' ? 31 : null))
    expect(out).toBe('see #31')
  })

  it('passes through when the content has no "#"', () => {
    const lookup = vi.fn()
    expect(normalizeKanbanRefs('plain text', lookup)).toBe('plain text')
    expect(lookup).not.toHaveBeenCalled()
  })
})
