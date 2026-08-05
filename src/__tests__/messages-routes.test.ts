// 100% coverage suite for src/web/routes/messages.ts.
//
// `tryHandleMessages` owns four endpoints:
//
//   POST /api/messages                -- send, with a stack of guards
//   GET  /api/messages/threads        -- sidebar threads
//   GET  /api/messages/backlog        -- pending count per agent
//   GET  /api/messages                -- list (with optional agent/status/before/limit)
//   PUT  /api/messages/:id            -- mark done/failed + delegator notification
//
// We mock every collaborator so the suite stays deterministic. The mocks
// follow the convention listed in the task: db, config, logger, the two
// auth modules, plus the imports messages.ts actually pulls in
// (channel-coordinator/ingest for COORDINATOR_AGENT_ID, prompt-safety for
// sanitizeAgentIdent, web/agent-config for isKnownAgent, web/http-helpers
// for readBody/json/jsonMaybeGzip, web/kanban-ref-normalize for the
// rewrites, web/federation/address + web/federation/config for qualified
// addressing).
//
// Branches covered:
//   * dispatcher: false arm (any unrelated path or wrong method)
//   * POST missing from/to/content (4 permutations) -> 400
//   * POST whitespace-only from/to/content -> 400
//   * POST coordinator impersonation -> 403
//   * POST qualified-from (federation impersonation) -> 403
//   * POST unknown agent -> 403
//   * POST owner-as-sender bypass -> ok
//   * POST qualified-to: bad parse, federation disabled, target==self,
//     unknown peer, ok path -> storedTo normalised to lowercase system
//   * POST colon-form to -> 400
//   * POST success with origin_note (trimmed and 120-char capped)
//   * POST success without origin_note
//   * POST kanban ref normalization applied
//   * GET /api/messages/threads
//   * GET /api/messages/backlog
//   * GET /api/messages: status=pending+agent, status=pending, agent only,
//     no params
//   * GET /api/messages: limit cap, before pagination, before non-numeric
//   * PUT /api/messages/:id: status=done with trace, status=done without
//     trace, status=failed with trace, status=invalid (not found -> 404),
//     same from/to (skip notification), content starts with [Eredmény]
//     (skip notification), notification with result, notification without
//     result, notification result > 500 chars truncated

import { describe, it, expect, vi, beforeEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import type { RouteContext } from '../web/routes/types.js'

// -----------------------------------------------------------------------------
// Mocks for the route's collaborators
// -----------------------------------------------------------------------------

const H = vi.hoisted(() => {
  return {
    // db.ts
    createAgentMessage: vi.fn(),
    getPendingMessages: vi.fn(),
    listAgentMessages: vi.fn(),
    getAgentConversation: vi.fn(),
    getAgentConversationThreads: vi.fn(),
    markMessageDone: vi.fn(),
    markMessageFailed: vi.fn(),
    getAgentMessage: vi.fn(),
    getPendingBacklogByAgent: vi.fn(),
    closeOtelSpan: vi.fn(),
    getKanbanSeqByIdPrefix: vi.fn(),
    // agent-config.ts
    isKnownAgent: vi.fn(),
    // federation
    getFederationConfig: vi.fn(),
  }
})

vi.mock('../db.js', () => ({
  createAgentMessage: H.createAgentMessage,
  getPendingMessages: H.getPendingMessages,
  listAgentMessages: H.listAgentMessages,
  getAgentConversation: H.getAgentConversation,
  getAgentConversationThreads: H.getAgentConversationThreads,
  markMessageDone: H.markMessageDone,
  markMessageFailed: H.markMessageFailed,
  getAgentMessage: H.getAgentMessage,
  getPendingBacklogByAgent: H.getPendingBacklogByAgent,
  closeOtelSpan: H.closeOtelSpan,
  getKanbanSeqByIdPrefix: H.getKanbanSeqByIdPrefix,
}))

vi.mock('../config.js', () => ({
  OWNER_NAME: 'zack',
}))

vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// channel-coordinator/ingest.js -> COORDINATOR_AGENT_ID
vi.mock('../channel-coordinator/ingest.js', () => ({
  COORDINATOR_AGENT_ID: 'telegram-coordinator',
}))

// web/agent-config.js -> isKnownAgent
vi.mock('../web/agent-config.js', () => ({
  isKnownAgent: H.isKnownAgent,
}))

// web/federation/config.js -> getFederationConfig
vi.mock('../web/federation/config.js', () => ({
  getFederationConfig: H.getFederationConfig,
}))

// web/federation/address.js and web/kanban-ref-normalize.js are
// dependency-free pure helpers -- leave the real implementations in
// place. The test only needs their behaviour, not isolation.

// Import the SUT AFTER every mock is registered.
const { tryHandleMessages } = await import('../web/routes/messages.js')

// -----------------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------------

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

function mkReq(opts: { body?: Buffer | string; headers?: Record<string, string | string[]> } = {}): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(opts: {
  method?: string
  path?: string
  query?: string
  body?: Buffer | string
}): Promise<{
  res: MockRes
  handled: boolean
  json: () => unknown
  ctx: RouteContext
}> {
  const method = opts.method ?? 'GET'
  const path = opts.path ?? '/api/messages'
  const req = mkReq({ body: opts.body })
  const res = mkRes()
  const urlStr = `http://127.0.0.1:3420${path}${opts.query ? `?${opts.query}` : ''}`
  const ctx: RouteContext = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(urlStr),
  }
  const handled = await tryHandleMessages(ctx)
  return {
    res,
    handled,
    json: () => (res.body ? JSON.parse(res.body) : null),
    ctx,
  }
}

// -----------------------------------------------------------------------------
// Per-test mock state reset
// -----------------------------------------------------------------------------

beforeEach(() => {
  // db.ts
  H.createAgentMessage.mockReset()
  H.getPendingMessages.mockReset().mockReturnValue([])
  H.listAgentMessages.mockReset().mockReturnValue([])
  H.getAgentConversation.mockReset().mockReturnValue([])
  H.getAgentConversationThreads.mockReset().mockReturnValue([])
  H.markMessageDone.mockReset().mockReturnValue(false)
  H.markMessageFailed.mockReset().mockReturnValue(false)
  H.getAgentMessage.mockReset()
  H.getPendingBacklogByAgent.mockReset().mockReturnValue([])
  H.closeOtelSpan.mockReset().mockReturnValue(true)
  H.getKanbanSeqByIdPrefix.mockReset().mockReturnValue(null)
  // agent-config
  H.isKnownAgent.mockReset().mockReturnValue(false)
  // federation config
  H.getFederationConfig.mockReset().mockReturnValue({
    enabled: false,
    systemId: 'home',
    peers: [],
  })
})

// =============================================================================
// Dispatcher surface
// =============================================================================

describe('tryHandleMessages -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call({ method: 'GET', path: '/api/other' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/messages on DELETE', async () => {
    const { handled } = await call({ method: 'DELETE' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/messages/threads on POST', async () => {
    const { handled } = await call({ method: 'POST', path: '/api/messages/threads' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/messages/backlog on POST', async () => {
    const { handled } = await call({ method: 'POST', path: '/api/messages/backlog' })
    expect(handled).toBe(false)
  })

  it('returns false for /api/messages/xyz (no PUT id match)', async () => {
    const { handled } = await call({ method: 'PUT', path: '/api/messages/xyz' })
    expect(handled).toBe(false)
  })
})

// =============================================================================
// POST /api/messages -- validation
// =============================================================================

describe('POST /api/messages -- validation', () => {
  it('returns 400 when from is missing', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'from, to, and content are required' })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('returns 400 when to is missing', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'a', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'from, to, and content are required' })
  })

  it('returns 400 when content is missing', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'a', to: 'b' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'from, to, and content are required' })
  })

  it('returns 400 when from is whitespace-only', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: '   ', to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'from, to, and content are required' })
  })

  it('returns 400 when to is whitespace-only', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'a', to: '   ', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'from, to, and content are required' })
  })

  it('returns 400 when content is whitespace-only', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'a', to: 'b', content: '   ' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'from, to, and content are required' })
  })
})

// =============================================================================
// POST /api/messages -- security guards
// =============================================================================

describe('POST /api/messages -- channel-coordinator impersonation guard', () => {
  it('returns 403 when sanitizeAgentIdent(from) === COORDINATOR_AGENT_ID', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'telegram-coordinator', to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'from is reserved for the in-process channel coordinator' })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('returns 403 even when from has surrounding dots (sanitize strips, trim does not)', async () => {
    // The bypass test: '@telegram-coordinator' / 'telegram-coordinator.' both
    // survive .trim() != 'telegram-coordinator' but sanitize to that constant.
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'telegram-coordinator.', to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'from is reserved for the in-process channel coordinator' })
  })
})

describe('POST /api/messages -- federation impersonation guard', () => {
  it('returns 403 when from contains a slash (qualified remote id)', async () => {
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'teodor/teodor', to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({
      error: 'from must be a local agent id without "/" -- federated senders are only accepted via /api/federation/inbox',
    })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })
})

describe('POST /api/messages -- unknown agent guard', () => {
  it('returns 403 when from is not a known agent and not the owner', async () => {
    H.isKnownAgent.mockReturnValue(false)
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'attacker', to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({
      error: "unknown agent 'attacker' -- from must be a registered fleet agent id",
    })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('accepts the message when from is the OWNER_NAME (no agent dir, owner-as-sender bypass)', async () => {
    H.isKnownAgent.mockReturnValue(false)
    H.createAgentMessage.mockReturnValue({
      id: 7,
      from_agent: 'zack',
      to_agent: 'b',
      content: 'c',
      status: 'pending',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: null,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'zack', to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect((json() as { id: number }).id).toBe(7)
    expect(H.createAgentMessage).toHaveBeenCalledWith('zack', 'b', 'c', null)
  })

  it('accepts the message when from is a known fleet agent', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.createAgentMessage.mockReturnValue({
      id: 8,
      from_agent: 'dev1',
      to_agent: 'b',
      content: 'c',
      status: 'pending',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: null,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    const { res, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'b', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.createAgentMessage).toHaveBeenCalledWith('dev1', 'b', 'c', null)
  })
})

// =============================================================================
// POST /api/messages -- qualified `to` validation
// =============================================================================

describe('POST /api/messages -- qualified `to` validation', () => {
  it('returns 400 when the qualified `to` does not parse (multiple slashes)', async () => {
    H.isKnownAgent.mockReturnValue(true)
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'peer/x/y', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid federated address in to (expected "<system>/<agent>")' })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('returns 400 when the qualified `to` does not parse (bad characters)', async () => {
    H.isKnownAgent.mockReturnValue(true)
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'peer/bad..id', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid federated address in to (expected "<system>/<agent>")' })
  })

  it('returns 400 when federation is disabled and to is qualified', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.getFederationConfig.mockReturnValue({
      enabled: false,
      systemId: 'home',
      peers: [],
    })
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'peer/agent', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Federation is disabled on this system' })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('returns 400 when the qualified `to` resolves to THIS system', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.getFederationConfig.mockReturnValue({
      enabled: true,
      systemId: 'home',
      peers: [],
    })
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'home/bob', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: "'home' is this system -- address the agent locally as 'bob'" })
  })

  it('returns 400 when the qualified `to` peer is unknown', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.getFederationConfig.mockReturnValue({
      enabled: true,
      systemId: 'home',
      peers: [],
    })
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'unknown/agent', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: "Unknown federation peer 'unknown'" })
  })

  it('normalises the system segment to lowercase and reformats the stored `to`', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.getFederationConfig.mockReturnValue({
      enabled: true,
      systemId: 'home',
      peers: [{ id: 'peer', baseUrl: 'https://peer', outboundToken: '', inboundToken: '', trust: 'untrusted' }],
    })
    H.createAgentMessage.mockReturnValue({
      id: 11,
      from_agent: 'dev1',
      to_agent: 'peer/Bob',
      content: 'c',
      status: 'pending',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: null,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    const { res, handled } = await call({
      method: 'POST',
      // Mixed-case system id; lowercase per the route's normalisation rule.
      body: JSON.stringify({ from: 'dev1', to: 'PEER/Bob', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    // Stored address: lowercase system, agent case preserved.
    expect(H.createAgentMessage).toHaveBeenCalledWith('dev1', 'peer/Bob', 'c', null)
  })
})

// =============================================================================
// POST /api/messages -- colon-form `to` guard
// =============================================================================

describe('POST /api/messages -- colon-form `to` guard', () => {
  it('returns 400 when `to` is the untrusted source form "federation:x:y"', async () => {
    H.isKnownAgent.mockReturnValue(true)
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'federation:teodor:teodor', content: 'c' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({
      error: 'Invalid recipient: use "<system>/<agent>" (slash) for a federated address, not the "federation:x:y" source form',
    })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })
})

// =============================================================================
// POST /api/messages -- happy path & origin_note
// =============================================================================

describe('POST /api/messages -- happy path', () => {
  it('creates the message and echoes the AgentMessage object on success', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.createAgentMessage.mockReturnValue({
      id: 100,
      from_agent: 'dev1',
      to_agent: 'dev2',
      content: 'hello',
      status: 'pending',
      result: null,
      created_at: 12345,
      delivered_at: null,
      completed_at: null,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    const { res, json, handled } = await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'dev2', content: 'hello' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      id: 100,
      from_agent: 'dev1',
      to_agent: 'dev2',
      content: 'hello',
    })
    expect(H.createAgentMessage).toHaveBeenCalledWith('dev1', 'dev2', 'hello', null)
  })

  it('trims from and passes the trimmed value to createAgentMessage', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.createAgentMessage.mockReturnValue({
      id: 101,
      from_agent: 'dev1',
      to_agent: 'b',
      content: 'c',
      status: 'pending',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: null,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    await call({
      method: 'POST',
      body: JSON.stringify({ from: '  dev1  ', to: 'b', content: 'c' }),
    })
    expect(H.createAgentMessage).toHaveBeenCalledWith('dev1', 'b', 'c', null)
  })

  it('trims and 120-chars-caps a provided origin_note', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.createAgentMessage.mockReturnValue({
      id: 102,
      from_agent: 'dev1',
      to_agent: 'b',
      content: 'c',
      status: 'pending',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: null,
      origin_note: 'tag',
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    const long = 'x'.repeat(200)
    await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'b', content: 'c', origin_note: `  ${long}  ` }),
    })
    const lastCall = H.createAgentMessage.mock.calls[H.createAgentMessage.mock.calls.length - 1]
    const originNoteArg = lastCall[3]
    expect(originNoteArg).toHaveLength(120)
    expect(originNoteArg).toBe('x'.repeat(120))
  })

  it('collapses whitespace-only origin_note to null', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.createAgentMessage.mockReturnValue({
      id: 103,
      from_agent: 'dev1',
      to_agent: 'b',
      content: 'c',
      status: 'pending',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: null,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'b', content: 'c', origin_note: '   ' }),
    })
    expect(H.createAgentMessage).toHaveBeenCalledWith('dev1', 'b', 'c', null)
  })

  it('passes the trimmed content through normalizeKanbanRefs before insert', async () => {
    H.isKnownAgent.mockReturnValue(true)
    H.getKanbanSeqByIdPrefix.mockReturnValue(42)
    H.createAgentMessage.mockReturnValue({
      id: 104,
      from_agent: 'dev1',
      to_agent: 'b',
      content: 'see #cb5080e5',
      status: 'pending',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: null,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    await call({
      method: 'POST',
      body: JSON.stringify({ from: 'dev1', to: 'b', content: '  see #cb5080e5  ' }),
    })
    // The hex token should be rewritten to its kanban seq via the lookup.
    expect(H.getKanbanSeqByIdPrefix).toHaveBeenCalledWith('cb5080e5')
    expect(H.createAgentMessage).toHaveBeenCalledWith('dev1', 'b', 'see #42', null)
  })
})

// =============================================================================
// GET /api/messages/threads
// =============================================================================

describe('GET /api/messages/threads', () => {
  it('returns the threads payload and writes 200', async () => {
    H.getAgentConversationThreads.mockReturnValue([
      { peer: 'a', count: 3, lastMessage: { id: 1, created_at: 1 } },
    ])
    const { res, json, handled } = await call({
      method: 'GET',
      path: '/api/messages/threads',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([
      { peer: 'a', count: 3, lastMessage: { id: 1, created_at: 1 } },
    ])
    expect(H.getAgentConversationThreads).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// GET /api/messages/backlog
// =============================================================================

describe('GET /api/messages/backlog', () => {
  it('returns the per-agent backlog payload', async () => {
    H.getPendingBacklogByAgent.mockReturnValue([
      { agent: 'a', pending: 5, oldest_pending_at: 1 },
    ])
    const { res, json, handled } = await call({
      method: 'GET',
      path: '/api/messages/backlog',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([
      { agent: 'a', pending: 5, oldest_pending_at: 1 },
    ])
    expect(H.getPendingBacklogByAgent).toHaveBeenCalledTimes(1)
  })
})

// =============================================================================
// GET /api/messages
// =============================================================================

describe('GET /api/messages -- query parameter routing', () => {
  it('uses getPendingMessages(agent) when status=pending and agent is set', async () => {
    H.getPendingMessages.mockReturnValue([{ id: 1 }])
    await call({ method: 'GET', query: 'status=pending&agent=dev1' })
    expect(H.getPendingMessages).toHaveBeenCalledWith('dev1')
    expect(H.listAgentMessages).not.toHaveBeenCalled()
    expect(H.getAgentConversation).not.toHaveBeenCalled()
  })

  it('uses getPendingMessages() with no args when status=pending and no agent', async () => {
    H.getPendingMessages.mockReturnValue([{ id: 1 }])
    await call({ method: 'GET', query: 'status=pending' })
    expect(H.getPendingMessages).toHaveBeenCalledWith()
    expect(H.listAgentMessages).not.toHaveBeenCalled()
  })

  it('uses getAgentConversation(agent, limit, before) when only agent is set', async () => {
    H.getAgentConversation.mockReturnValue([{ id: 1 }])
    await call({ method: 'GET', query: 'agent=dev1&limit=25&before=10' })
    expect(H.getAgentConversation).toHaveBeenCalledWith('dev1', 25, 10)
    expect(H.listAgentMessages).not.toHaveBeenCalled()
  })

  it('uses getAgentConversation(agent, limit, undefined) when before is non-numeric', async () => {
    H.getAgentConversation.mockReturnValue([])
    await call({ method: 'GET', query: 'agent=dev1&before=NaN-string' })
    // parseInt('NaN-string', 10) -> NaN, Number.isFinite(NaN) -> false, so undefined is passed.
    expect(H.getAgentConversation).toHaveBeenCalledWith('dev1', 50, undefined)
  })

  it('uses getAgentConversation(agent, limit, undefined) when before is omitted', async () => {
    H.getAgentConversation.mockReturnValue([])
    await call({ method: 'GET', query: 'agent=dev1' })
    expect(H.getAgentConversation).toHaveBeenCalledWith('dev1', 50, undefined)
  })

  it('falls back to listAgentMessages(limit) with no params (default limit 50)', async () => {
    H.listAgentMessages.mockReturnValue([{ id: 1 }])
    await call({ method: 'GET' })
    expect(H.listAgentMessages).toHaveBeenCalledWith(50)
    expect(H.getPendingMessages).not.toHaveBeenCalled()
    expect(H.getAgentConversation).not.toHaveBeenCalled()
  })

  it('caps an explicit limit above 200 at 200', async () => {
    H.listAgentMessages.mockReturnValue([])
    await call({ method: 'GET', query: 'limit=999' })
    expect(H.listAgentMessages).toHaveBeenCalledWith(200)
  })

  it('uses an explicit limit below 200 verbatim', async () => {
    H.listAgentMessages.mockReturnValue([])
    await call({ method: 'GET', query: 'limit=10' })
    expect(H.listAgentMessages).toHaveBeenCalledWith(10)
  })
})

// =============================================================================
// PUT /api/messages/:id -- mark done / failed
// =============================================================================

describe('PUT /api/messages/:id -- mark done', () => {
  it('calls markMessageDone, closes the OTel span, and returns 200 ok', async () => {
    H.markMessageDone.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 1,
      from_agent: 'executor',
      to_agent: 'owner',
      content: 'work done',
      status: 'done',
      result: 'success',
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: 'trace-1',
      span_id: 'span-1',
      parent_span_id: null,
    })
    const { res, json, handled } = await call({
      method: 'PUT',
      path: '/api/messages/1',
      body: JSON.stringify({ status: 'done', result: 'success' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.markMessageDone).toHaveBeenCalledWith(1, 'success')
    expect(H.closeOtelSpan).toHaveBeenCalledTimes(1)
    const spanArgs = H.closeOtelSpan.mock.calls[0]
    expect(spanArgs[0]).toBe('trace-1')
    expect(spanArgs[1]).toBe('span-1')
    expect(spanArgs[3]).toBe('ok')
  })

  it('does NOT close the OTel span when the message has no trace_id / span_id', async () => {
    H.markMessageDone.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 2,
      from_agent: 'executor',
      to_agent: 'owner',
      content: 'work done',
      status: 'done',
      result: 'ok',
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    const { res, handled } = await call({
      method: 'PUT',
      path: '/api/messages/2',
      body: JSON.stringify({ status: 'done' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.closeOtelSpan).not.toHaveBeenCalled()
  })
})

describe('PUT /api/messages/:id -- mark failed', () => {
  it('calls markMessageFailed and closes the OTel span with status=error', async () => {
    H.markMessageFailed.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 3,
      from_agent: 'executor',
      to_agent: 'owner',
      content: 'failed task',
      status: 'failed',
      result: 'oops',
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: 'trace-2',
      span_id: 'span-2',
      parent_span_id: null,
    })
    const { res, json, handled } = await call({
      method: 'PUT',
      path: '/api/messages/3',
      body: JSON.stringify({ status: 'failed', result: 'oops' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.markMessageFailed).toHaveBeenCalledWith(3, 'oops')
    const spanArgs = H.closeOtelSpan.mock.calls[0]
    expect(spanArgs[3]).toBe('error')
  })
})

describe('PUT /api/messages/:id -- delegator notification', () => {
  it('creates a reverse [Eredmény] notification when from !== to and content is not itself a result', async () => {
    H.markMessageDone.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 4,
      from_agent: 'executor',
      to_agent: 'delegator',
      content: 'plain task content',
      status: 'done',
      result: 'success',
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    H.createAgentMessage.mockReturnValue({ id: 99 })
    const { res, handled } = await call({
      method: 'PUT',
      path: '/api/messages/4',
      body: JSON.stringify({ status: 'done', result: 'success' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(H.createAgentMessage).toHaveBeenCalledWith(
      'delegator',
      'executor',
      '[Eredmény] msg_id:4 status:done\n\nsuccess',
    )
  })

  it('truncates the result in the notification to 500 characters', async () => {
    H.markMessageDone.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 5,
      from_agent: 'executor',
      to_agent: 'delegator',
      content: 'plain task',
      status: 'done',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    H.createAgentMessage.mockReturnValue({ id: 100 })
    const bigResult = 'R'.repeat(800)
    await call({
      method: 'PUT',
      path: '/api/messages/5',
      body: JSON.stringify({ status: 'done', result: bigResult }),
    })
    const args = H.createAgentMessage.mock.calls[H.createAgentMessage.mock.calls.length - 1]
    const summary = args[2]
    // '[Eredmény] msg_id:5 status:done\n\n' = 31 chars; then truncated to 500 chars of 'R'.
    expect(summary.startsWith('[Eredmény] msg_id:5 status:done\n\n')).toBe(true)
    const summaryBody = summary.slice('[Eredmény] msg_id:5 status:done\n\n'.length)
    expect(summaryBody).toHaveLength(500)
    expect(summaryBody).toBe('R'.repeat(500))
  })

  it('substitutes "(nincs eredmény)" when result is omitted', async () => {
    H.markMessageDone.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 6,
      from_agent: 'executor',
      to_agent: 'delegator',
      content: 'plain task',
      status: 'done',
      result: null,
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    H.createAgentMessage.mockReturnValue({ id: 101 })
    await call({
      method: 'PUT',
      path: '/api/messages/6',
      body: JSON.stringify({ status: 'done' }),
    })
    const args = H.createAgentMessage.mock.calls[H.createAgentMessage.mock.calls.length - 1]
    expect(args[2]).toBe('[Eredmény] msg_id:6 status:done\n\n(nincs eredmény)')
  })

  it('skips the notification when from_agent === to_agent (self message)', async () => {
    H.markMessageDone.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 7,
      from_agent: 'self',
      to_agent: 'self',
      content: 'plain task',
      status: 'done',
      result: 'ok',
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    H.createAgentMessage.mockReturnValue({ id: 102 })
    await call({
      method: 'PUT',
      path: '/api/messages/7',
      body: JSON.stringify({ status: 'done', result: 'ok' }),
    })
    // No notification because the executor IS the delegator.
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('skips the notification when the original content is already a [Eredmény] report (no ping-pong)', async () => {
    H.markMessageDone.mockReturnValue(true)
    H.getAgentMessage.mockReturnValue({
      id: 8,
      from_agent: 'executor',
      to_agent: 'delegator',
      content: '[Eredmény] msg_id:42 status:done\n\nprior report',
      status: 'done',
      result: 'ok',
      created_at: 1,
      delivered_at: null,
      completed_at: 2,
      origin_note: null,
      trace_id: null,
      span_id: null,
      parent_span_id: null,
    })
    H.createAgentMessage.mockReturnValue({ id: 103 })
    await call({
      method: 'PUT',
      path: '/api/messages/8',
      body: JSON.stringify({ status: 'done', result: 'ok' }),
    })
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })
})

describe('PUT /api/messages/:id -- failure paths', () => {
  it('returns 404 when the status is not done/failed (other status string)', async () => {
    const { res, json, handled } = await call({
      method: 'PUT',
      path: '/api/messages/10',
      body: JSON.stringify({ status: 'delivered' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Message not found or invalid status' })
    expect(H.markMessageDone).not.toHaveBeenCalled()
    expect(H.markMessageFailed).not.toHaveBeenCalled()
    expect(H.createAgentMessage).not.toHaveBeenCalled()
  })

  it('returns 404 when markMessageDone returns false (id not found)', async () => {
    H.markMessageDone.mockReturnValue(false)
    const { res, json, handled } = await call({
      method: 'PUT',
      path: '/api/messages/999',
      body: JSON.stringify({ status: 'done' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Message not found or invalid status' })
  })

  it('returns 404 when markMessageFailed returns false (id not found)', async () => {
    H.markMessageFailed.mockReturnValue(false)
    const { res, json, handled } = await call({
      method: 'PUT',
      path: '/api/messages/998',
      body: JSON.stringify({ status: 'failed', result: 'broken' }),
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Message not found or invalid status' })
  })

  it('returns false for PUT on a non-numeric id', async () => {
    const { handled } = await call({
      method: 'PUT',
      path: '/api/messages/abc',
      body: JSON.stringify({ status: 'done' }),
    })
    expect(handled).toBe(false)
  })
})
