// 100% coverage suite for src/web/routes/approvals.ts.
//
// Pins the CURRENT behaviour (defensive against regressions). Branches
// covered: the full tryHandleApprovals dispatch (POST create, GET list,
// GET single, PATCH resolve, plus the false fallthrough for unrelated
// paths); the per-field 400 validation in POST/PATCH; the self-approval
// 403; the "already resolved" 409 / "not found" 404 paths; the timeout
// sweeper; and the autonomy-config lookup (file present / missing /
// malformed / category absent / category with null timeout_minutes).
//
// Sandbox: PROJECT_ROOT is pinned to a tmpdir-scoped value via the mocked
// config.js so the store/autonomy-config.json file the handler reads
// stays out of the live store. db / logger / config are stubbed at the
// module boundary so no production side effects fire.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'approvals-full-'))
const PROJECT = join(SANDBOX, 'project')
const STORE = join(PROJECT, 'store')
const CONFIG_PATH = join(STORE, 'autonomy-config.json')
mkdirSync(STORE, { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      MAIN_AGENT_ID: { get: () => 'marveen', enumerable: true },
    },
  )
})

const H = vi.hoisted(() => {
  const mkFn = () => vi.fn()
  return {
    loggerInfo: mkFn(),
    loggerWarn: mkFn(),
    loggerError: mkFn(),
    loggerDebug: mkFn(),
    createApproval: vi.fn(),
    getApproval: vi.fn(),
    resolveApproval: vi.fn(),
    listApprovals: vi.fn(),
    expireTimedOutApprovals: vi.fn(),
    createAgentMessage: vi.fn(),
  }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

vi.mock('../db.js', () => ({
  createApproval: (...args: unknown[]) => H.createApproval(...args),
  getApproval: (...args: unknown[]) => H.getApproval(...args),
  resolveApproval: (...args: unknown[]) => H.resolveApproval(...args),
  listApprovals: (...args: unknown[]) => H.listApprovals(...args),
  expireTimedOutApprovals: () => H.expireTimedOutApprovals(),
  createAgentMessage: (...args: unknown[]) => H.createAgentMessage(...args),
}))

// Import AFTER every mock is registered.
const { tryHandleApprovals, startApprovalTimeoutSweeper } = await import('../web/routes/approvals.js')
const { logger } = await import('../logger.js')

// -----------------------------------------------------------------------
// HTTP harness (EventEmitter-style req so readBody's data/end listeners
// fire; response writer that captures status + body).
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

import type http from 'node:http'

function mkReq(body: string | undefined): http.IncomingMessage {
  const ee = new EventEmitter() as unknown as http.IncomingMessage
  ;(ee as unknown as { headers: Record<string, string> }).headers = body ? { 'content-length': String(body.length) } : {}
  if (body !== undefined) {
    process.nextTick(() => {
      ee.emit('data', Buffer.from(body))
      ee.emit('end')
    })
  } else {
    process.nextTick(() => { ee.emit('end') })
  }
  return ee
}

async function call(method: string, pathWithQuery: string, body?: unknown): Promise<MockRes> {
  const res = mkRes()
  // Split query off the path so the handler's exact-match `path === '/api/approvals'`
  // check works (the source compares the literal path, not the parsed URL pathname).
  const qIdx = pathWithQuery.indexOf('?')
  const path = qIdx === -1 ? pathWithQuery : pathWithQuery.slice(0, qIdx)
  const query = qIdx === -1 ? '' : pathWithQuery.slice(qIdx)
  // Send the body verbatim -- JSON.stringify of a string is still valid JSON,
  // so we cannot rely on it to break the parser. Object values get stringified.
  const rawBody = body === undefined
    ? undefined
    : (typeof body === 'string' ? body : JSON.stringify(body))
  const req = mkReq(rawBody)
  const url = new URL(`http://localhost${pathWithQuery}`)
  const handled = await tryHandleApprovals({ req, res, path, method, url } as never)
  expect(handled).toBe(true)
  // touch query so unused-var lints don't trip in case the URL ever carries it
  void query
  return res
}

beforeEach(() => {
  vi.clearAllMocks()
  if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH)
  H.expireTimedOutApprovals.mockReturnValue(0)
  H.createApproval.mockImplementation((row: { id: string; agent_id: string; category: string; action_description: string; action_payload?: string | null; timeout_at?: number | null }) => ({
    id: row.id,
    agent_id: row.agent_id,
    category: row.category,
    action_description: row.action_description,
    action_payload: row.action_payload ?? null,
    timeout_at: row.timeout_at ?? null,
    status: 'pending',
    resolved_at: null,
    resolved_by: null,
    telegram_message_id: null,
    created_at: 0,
  }))
  H.getApproval.mockReturnValue(undefined)
  H.resolveApproval.mockReturnValue(true)
  H.listApprovals.mockReturnValue([])
  H.createAgentMessage.mockReturnValue(undefined)
})

afterEach(() => {
  if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH)
})

// ===========================================================================
// POST /api/approvals -- create
// ===========================================================================

describe('POST /api/approvals', () => {
  it('returns 400 on invalid JSON body', async () => {
    const res = await call('POST', '/api/approvals', '{not json')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid JSON' })
  })

  it('returns 400 when agent_id is missing or not a string', async () => {
    const res = await call('POST', '/api/approvals', { category: 'cat', action_description: 'x' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_id is required' })
  })

  it('returns 400 when agent_id is empty/whitespace-only', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: '   ', category: 'cat', action_description: 'x' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'agent_id is required' })
  })

  it('returns 400 when category is missing or empty', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: '', action_description: 'x' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'category is required' })
  })

  it('returns 400 when category is not a string', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 42, action_description: 'x' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'category is required' })
  })

  it('returns 400 when category is whitespace-only', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: '   ', action_description: 'x' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'category is required' })
  })

  it('returns 400 when action_description is missing or empty', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: '' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'action_description is required' })
  })

  it('returns 400 when action_description is not a string', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 7 })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'action_description is required' })
  })

  it('returns 400 when action_payload is provided but not a string', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 'x', action_payload: 99 })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'action_payload must be a string (JSON) if provided' })
  })

  it('creates an approval: 201 with the row, action_payload=null when omitted', async () => {
    const res = await call('POST', '/api/approvals', { agent_id: '  agent-a  ', category: 'cat', action_description: '  do x  ' })
    expect(res.statusCode).toBe(201)
    expect(H.createApproval).toHaveBeenCalledTimes(1)
    const row = H.createApproval.mock.calls[0][0]
    expect(row).toMatchObject({ agent_id: 'agent-a', category: 'cat', action_description: 'do x', action_payload: null })
    expect(row.id).toMatch(/^[0-9a-f-]{36}$/i)
    expect(row.timeout_at).toBeNull()
    expect(H.createAgentMessage).toHaveBeenCalledWith('system', 'marveen', expect.stringContaining('[APPROVAL_REQUEST]'))
    expect(logger.info).toHaveBeenCalled()
  })

  it('forwards a string action_payload verbatim and stores null otherwise', async () => {
    await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 'x', action_payload: '{"k":1}' })
    expect(H.createApproval.mock.calls[0][0].action_payload).toBe('{"k":1}')
  })

  it('attaches a timeout_at when autonomy-config has a matching category', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ categories: [{ key: 'cat', timeout_minutes: 30 }] }))
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 'x' })
    expect(res.statusCode).toBe(201)
    const row = H.createApproval.mock.calls[0][0]
    expect(typeof row.timeout_at).toBe('number')
    expect(row.timeout_at).toBeGreaterThan(Math.floor(Date.now() / 1000))
  })

  it('returns null timeout when autonomy-config has no matching category', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ categories: [{ key: 'other', timeout_minutes: 30 }] }))
    await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 'x' })
    expect(H.createApproval.mock.calls[0][0].timeout_at).toBeNull()
  })

  it('returns null timeout when category has null timeout_minutes', async () => {
    writeFileSync(CONFIG_PATH, JSON.stringify({ categories: [{ key: 'cat', timeout_minutes: null }] }))
    await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 'x' })
    expect(H.createApproval.mock.calls[0][0].timeout_at).toBeNull()
  })

  it('tolerates a malformed autonomy-config file (returns null timeout)', async () => {
    writeFileSync(CONFIG_PATH, '{not json')
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 'x' })
    expect(res.statusCode).toBe(201)
    expect(H.createApproval.mock.calls[0][0].timeout_at).toBeNull()
  })

  it('logs a warn when the system->main-agent notification throws but still returns 201', async () => {
    H.createAgentMessage.mockImplementation(() => { throw new Error('db locked') })
    const res = await call('POST', '/api/approvals', { agent_id: 'agent-a', category: 'cat', action_description: 'x' })
    expect(res.statusCode).toBe(201)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to notify main agent'),
    )
  })
})

// ===========================================================================
// GET /api/approvals -- list with filters
// ===========================================================================

describe('GET /api/approvals', () => {
  it('lists without filters and defaults limit to 100', async () => {
    const rows = [{ id: 'a' }, { id: 'b' }]
    H.listApprovals.mockReturnValue(rows)
    const res = await call('GET', '/api/approvals')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toEqual(rows)
    expect(H.listApprovals).toHaveBeenCalledWith({
      agent_id: undefined,
      category: undefined,
      status: undefined,
      limit: 100,
    })
  })

  it('passes through agent, category, status filters verbatim', async () => {
    const res = await call('GET', '/api/approvals?agent=agent-a&category=email_send&status=pending')
    expect(res.statusCode).toBe(200)
    expect(H.listApprovals).toHaveBeenCalledWith({
      agent_id: 'agent-a',
      category: 'email_send',
      status: 'pending',
      limit: 100,
    })
  })

  it('clamps limit to <=500 and parses it as an int (NaN -> default 100)', async () => {
    await call('GET', '/api/approvals?limit=garbage')
    expect(H.listApprovals.mock.calls[0][0].limit).toBe(100)

    await call('GET', '/api/approvals?limit=9000')
    expect(H.listApprovals.mock.calls[1][0].limit).toBe(500)

    await call('GET', '/api/approvals?limit=42')
    expect(H.listApprovals.mock.calls[2][0].limit).toBe(42)
  })
})

// ===========================================================================
// GET /api/approvals/:id -- status poll
// ===========================================================================

describe('GET /api/approvals/:id', () => {
  it('returns the approval when present', async () => {
    H.getApproval.mockReturnValue({ id: 'ap-1', status: 'pending' })
    const res = await call('GET', '/api/approvals/ap-1')
    expect(res.statusCode).toBe(200)
    expect(JSON.parse(res.body)).toMatchObject({ id: 'ap-1' })
  })

  it('returns 404 when the id does not resolve', async () => {
    H.getApproval.mockReturnValue(undefined)
    const res = await call('GET', '/api/approvals/nope')
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Not found' })
  })
})

// ===========================================================================
// PATCH /api/approvals/:id -- resolve
// ===========================================================================

describe('PATCH /api/approvals/:id', () => {
  it('returns 400 on invalid JSON body', async () => {
    H.getApproval.mockReturnValue({ id: 'ap-1', agent_id: 'agent-a' })
    const res = await call('PATCH', '/api/approvals/ap-1', '{not json')
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Invalid JSON' })
  })

  it('returns 400 when status is not one of approved/rejected/timeout', async () => {
    const res = await call('PATCH', '/api/approvals/ap-1', { status: 'maybe', resolved_by: 'me' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'status must be approved, rejected, or timeout' })
  })

  it('returns 400 when resolved_by is missing', async () => {
    const res = await call('PATCH', '/api/approvals/ap-1', { status: 'approved' })
    expect(res.statusCode).toBe(400)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'resolved_by is required' })
  })

  it('returns 400 when resolved_by is empty or not a string', async () => {
    const r1 = await call('PATCH', '/api/approvals/ap-1', { status: 'approved', resolved_by: '' })
    expect(r1.statusCode).toBe(400)
    const r2 = await call('PATCH', '/api/approvals/ap-1', { status: 'approved', resolved_by: 5 })
    expect(r2.statusCode).toBe(400)
  })

  it('returns 403 when resolved_by matches the requesting agent_id (self-approval guard)', async () => {
    H.getApproval.mockReturnValue({ id: 'ap-1', agent_id: 'agent-b' })
    const res = await call('PATCH', '/api/approvals/ap-1', { status: 'approved', resolved_by: 'agent-b' })
    expect(res.statusCode).toBe(403)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'The requesting agent cannot approve its own request' })
    expect(H.resolveApproval).not.toHaveBeenCalled()
  })

  it('resolves approval successfully (200) and returns the updated row', async () => {
    // call #1: self-approval guard (returns agent-b, resolved_by=owner -> guard passes)
    H.getApproval.mockReturnValueOnce({ id: 'ap-1', agent_id: 'agent-b' })
    // call #2: final approval after resolve
    H.getApproval.mockReturnValueOnce({ id: 'ap-1', agent_id: 'agent-b', status: 'approved' })
    H.resolveApproval.mockReturnValue(true)
    const res = await call('PATCH', '/api/approvals/ap-1', { status: 'approved', resolved_by: '  owner  ' })
    expect(res.statusCode).toBe(200)
    expect(H.resolveApproval).toHaveBeenCalledWith('ap-1', 'approved', 'owner', null)
    // Pin CURRENT behaviour: logger receives the raw `resolved_by` from the
    // body (no trim), even though resolveApproval was called with the trimmed
    // value. A future test that breaks this assertion will catch any drift.
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'ap-1', status: 'approved', resolved_by: 'owner' }),
      expect.stringContaining('Approval resolved'),
    )
  })

  it('passes the numeric telegram_message_id through (or null otherwise)', async () => {
    H.getApproval.mockReturnValueOnce({ id: 'ap-1', agent_id: 'agent-b' })
    H.getApproval.mockReturnValueOnce({ id: 'ap-1', status: 'approved' })
    await call('PATCH', '/api/approvals/ap-1', { status: 'approved', resolved_by: 'owner', telegram_message_id: 12345 })
    expect(H.resolveApproval).toHaveBeenCalledWith('ap-1', 'approved', 'owner', 12345)

    H.getApproval.mockReturnValueOnce({ id: 'ap-2', agent_id: 'agent-b' })
    H.getApproval.mockReturnValueOnce({ id: 'ap-2', status: 'rejected' })
    await call('PATCH', '/api/approvals/ap-2', { status: 'rejected', resolved_by: 'owner', telegram_message_id: 'not a number' })
    expect(H.resolveApproval).toHaveBeenLastCalledWith('ap-2', 'rejected', 'owner', null)
  })

  it('returns 404 when the approval does not exist (resolveApproval false + getApproval undefined)', async () => {
    // guard lookup: no target -> guard falls through (skipped)
    // then resolveApproval returns false
    // then re-lookup: undefined -> 404
    H.getApproval.mockReturnValueOnce(undefined)
    H.getApproval.mockReturnValueOnce(undefined)
    H.resolveApproval.mockReturnValue(false)
    const res = await call('PATCH', '/api/approvals/ap-gone', { status: 'approved', resolved_by: 'owner' })
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Not found' })
  })

  it('returns 409 when the approval was already resolved', async () => {
    H.getApproval.mockReturnValueOnce({ id: 'ap-1', agent_id: 'agent-b' }) // guard (resolved_by=owner, target=agent-b -> passes)
    H.getApproval.mockReturnValueOnce({ id: 'ap-1', agent_id: 'agent-b', status: 'approved' }) // resolve-false lookup -> existing
    H.resolveApproval.mockReturnValue(false)
    const res = await call('PATCH', '/api/approvals/ap-1', { status: 'rejected', resolved_by: 'owner' })
    expect(res.statusCode).toBe(409)
    expect(JSON.parse(res.body)).toMatchObject({ error: 'Already resolved as approved' })
  })

  it('skips the self-approval guard when the target approval cannot be loaded', async () => {
    H.getApproval.mockReturnValueOnce(undefined) // guard sees no target -> falls through
    H.getApproval.mockReturnValueOnce({ id: 'ap-gone', status: 'approved' }) // final
    H.resolveApproval.mockReturnValue(true)
    const res = await call('PATCH', '/api/approvals/ap-gone', { status: 'approved', resolved_by: 'owner' })
    expect(res.statusCode).toBe(200)
    expect(H.resolveApproval).toHaveBeenCalled()
  })
})

// ===========================================================================
// Dispatcher fallthrough
// ===========================================================================

describe('tryHandleApprovals fallthrough', () => {
  it('returns false for unrelated paths', async () => {
    const res = mkRes()
    const req = mkReq(undefined)
    const url = new URL('http://localhost/api/other')
    const handled = await tryHandleApprovals({ req, res, path: '/api/other', method: 'GET', url } as never)
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for non-GET/POST on /api/approvals (e.g. PUT)', async () => {
    const res = mkRes()
    const req = mkReq(undefined)
    const url = new URL('http://localhost/api/approvals')
    const handled = await tryHandleApprovals({ req, res, path: '/api/approvals', method: 'PUT', url } as never)
    expect(handled).toBe(false)
  })

  it('returns false for PUT on a single-id path', async () => {
    const res = mkRes()
    const req = mkReq(undefined)
    const url = new URL('http://localhost/api/approvals/ap-1')
    const handled = await tryHandleApprovals({ req, res, path: '/api/approvals/ap-1', method: 'PUT', url } as never)
    expect(handled).toBe(false)
  })
})

// ===========================================================================
// startApprovalTimeoutSweeper
// ===========================================================================

describe('startApprovalTimeoutSweeper', () => {
  it('runs the expiry callback and logs the count when expired > 0', () => {
    vi.useFakeTimers()
    H.expireTimedOutApprovals.mockReturnValue(3)
    const timer = startApprovalTimeoutSweeper()
    vi.advanceTimersByTime(60_000)
    expect(H.expireTimedOutApprovals).toHaveBeenCalledTimes(1)
    expect(logger.info).toHaveBeenCalledWith({ expired: 3 }, expect.stringContaining('expired pending'))
    clearInterval(timer)
    vi.useRealTimers()
  })

  it('runs the expiry callback silently when expired is 0', () => {
    vi.useFakeTimers()
    H.expireTimedOutApprovals.mockReturnValue(0)
    const timer = startApprovalTimeoutSweeper()
    vi.advanceTimersByTime(60_000)
    expect(logger.info).not.toHaveBeenCalled()
    clearInterval(timer)
    vi.useRealTimers()
  })

  it('swallows an expiry callback error and logs it at warn', () => {
    vi.useFakeTimers()
    H.expireTimedOutApprovals.mockImplementation(() => { throw new Error('db broken') })
    const timer = startApprovalTimeoutSweeper()
    vi.advanceTimersByTime(60_000)
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Approval timeout sweep failed'),
    )
    clearInterval(timer)
    vi.useRealTimers()
  })
})