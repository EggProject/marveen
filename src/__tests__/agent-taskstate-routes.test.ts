// 100% coverage suite for src/web/routes/agent-taskstate.ts.
//
// tryHandleAgentTaskState owns four HTTP endpoints backed by src/web/agent-
// taskstate.ts (pure JSON-LDU store under PROJECT_ROOT/store/agent-taskstate):
//
//   POST   /api/agent-taskstate/:agent          <- write a record
//   GET    /api/agent-taskstate/:agent/replay   <- returns injected block (or null)
//   POST   /api/agent-taskstate/:agent/consume  <- mark consumed (single-replay guard)
//   GET    /api/agent-taskstate/:agent          <- read raw record (debug)
//   DELETE /api/agent-taskstate/:agent          <- explicit clear (best-effort)
//
// Sandbox: PROJECT_ROOT is pinned at a tmpdir-scoped value via the mocked
// config.js; the underlying agent-taskstate.js module stays real so every
// branch in the routing glue is exercised against real I/O. The listed
// db/config/agent-config/agent-process/auth-gate/agent-bundle/logger
// collaborators are stubbed so their side-effects never fire.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'agent-taskstate-routes-'))
const PROJECT = join(SANDBOX, 'project')
const STORE = join(PROJECT, 'store', 'agent-taskstate')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => join(PROJECT, 'store'), enumerable: true },
    },
  )
})

vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))
vi.mock('../web/agent-config.js', () => ({ agentDir: vi.fn() }))
vi.mock('../web/agent-process.js', () => ({}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/agent-bundle.js', () => ({}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))

// Import AFTER every mock is registered.
const { tryHandleAgentTaskState } = await import('../web/routes/agent-taskstate.js')
const {
  readTaskState,
  writeTaskState,
  markConsumed,
  clearTaskState,
} = await import('../web/agent-taskstate.js')

// -----------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------
interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string | string[]>): MockRes
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

function mkReq(opts: { body?: Buffer | string }): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(method: string, fullPath: string, opts: { body?: Buffer | string } = {}): Promise<{
  res: MockRes
  handled: boolean
  json: () => Record<string, unknown> | null
}> {
  const req = mkReq(opts)
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
    fedPeer: null,
  }
  const handled = await tryHandleAgentTaskState(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

const AGENT = 'taskstate-test-agent'

beforeAll(() => {
  mkdirSync(PROJECT, { recursive: true })
})

beforeEach(() => {
  rmSync(STORE, { recursive: true, force: true })
})

afterEach(() => {
  clearTaskState(AGENT)
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

// -----------------------------------------------------------------------
// Dispatcher surface (path/method filter)
// -----------------------------------------------------------------------
describe('tryHandleAgentTaskState -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for a wrong-method request on a known taskstate prefix', async () => {
    // PATCH is not handled; the only handled methods on /:agent are POST/GET/DELETE
    // and /replay (GET) and /consume (POST).
    const { handled } = await call('PATCH', `/api/agent-taskstate/${AGENT}`)
    expect(handled).toBe(false)
  })

  it('returns false for an /replay request made via POST', async () => {
    const { handled } = await call('POST', `/api/agent-taskstate/${AGENT}/replay`)
    expect(handled).toBe(false)
  })

  it('returns false for a /consume request made via GET', async () => {
    const { handled } = await call('GET', `/api/agent-taskstate/${AGENT}/consume`)
    expect(handled).toBe(false)
  })
})

// -----------------------------------------------------------------------
// POST /api/agent-taskstate/:agent
// -----------------------------------------------------------------------
describe('POST /api/agent-taskstate/:agent', () => {
  it('writes a record with all structured fields and echoes it back', async () => {
    const body = JSON.stringify({
      doneSteps: ['merged #276'],
      alreadyDelegated: ['Zara: frontend modal'],
      nextAction: 'open the PR',
      pendingDecision: 'whether to gate on RESPAWN_ENABLED',
      summary: 'building X',
    })
    const { res, json } = await call('POST', `/api/agent-taskstate/${AGENT}`, { body })
    expect(res.statusCode).toBe(200)
    const out = json() as { ok: boolean; record: Record<string, unknown> }
    expect(out.ok).toBe(true)
    expect(out.record).toMatchObject({
      agent: AGENT,
      doneSteps: ['merged #276'],
      alreadyDelegated: ['Zara: frontend modal'],
      nextAction: 'open the PR',
      pendingDecision: 'whether to gate on RESPAWN_ENABLED',
      summary: 'building X',
      consumed: false,
    })
    expect(typeof out.record.ts).toBe('number')
  })

  it('accepts a partial body and defaults omitted fields to empty', async () => {
    const { res, json } = await call('POST', `/api/agent-taskstate/${AGENT}`, { body: '{}' })
    expect(res.statusCode).toBe(200)
    const out = json() as { ok: boolean; record: Record<string, unknown> }
    expect(out.ok).toBe(true)
    expect(out.record.doneSteps).toEqual([])
    expect(out.record.alreadyDelegated).toEqual([])
    expect(out.record.nextAction).toBe('')
    expect(out.record.pendingDecision).toBe('')
    expect(out.record.summary).toBe('')
  })

  it('returns 400 with { error: "Invalid JSON" } when the body is not parseable', async () => {
    const { res, json } = await call('POST', `/api/agent-taskstate/${AGENT}`, { body: 'not-json{' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid JSON' })
  })

  it('produces a record that round-trips through readTaskState (file written under STORE)', () => {
    writeTaskState(AGENT, { nextAction: 'persist-me', doneSteps: ['a'] }, Date.now())
    const r = readTaskState(AGENT)
    expect(r).not.toBeNull()
    expect(r?.nextAction).toBe('persist-me')
    expect(r?.doneSteps).toEqual(['a'])
  })
})

// -----------------------------------------------------------------------
// GET /api/agent-taskstate/:agent/replay
// -----------------------------------------------------------------------
describe('GET /api/agent-taskstate/:agent/replay', () => {
  it('returns additionalContext:null when there is no record', async () => {
    const { res, json } = await call('GET', `/api/agent-taskstate/${AGENT}/replay?source=compact`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ additionalContext: null })
  })

  it('returns the injection block on a replay-source (compact)', async () => {
    // Seed via the underlying writeTaskState so shouldReplayTaskState returns true.
    writeTaskState(AGENT, {
      summary: 'rebuild hook wiring',
      doneSteps: ['merged #276'],
      alreadyDelegated: ['Zara: frontend modal'],
      nextAction: 'open the PR',
      pendingDecision: 'gate on RESPAWN_ENABLED?',
    }, Date.now())

    const { res, json } = await call('GET', `/api/agent-taskstate/${AGENT}/replay?source=compact`)
    expect(res.statusCode).toBe(200)
    const out = json() as { additionalContext: string | null }
    expect(out.additionalContext).not.toBeNull()
    expect(out.additionalContext!).toContain('TASK-FOLYTATAS (NEM uj feladat)')
    expect(out.additionalContext!).toContain('merged #276')
    expect(out.additionalContext!).toContain('open the PR')
  })

  it('returns additionalContext:null when the source is not replay-eligible', async () => {
    writeTaskState(AGENT, { nextAction: 'next', doneSteps: ['x'] }, Date.now())
    const { res, json } = await call('GET', `/api/agent-taskstate/${AGENT}/replay?source=clear`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ additionalContext: null })
  })

  it('returns additionalContext:null when source query param is omitted (empty default)', async () => {
    writeTaskState(AGENT, { nextAction: 'next', doneSteps: ['x'] }, Date.now())
    const { res, json } = await call('GET', `/api/agent-taskstate/${AGENT}/replay`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ additionalContext: null })
  })

  it('does NOT consume the record on replay (replays again next call)', async () => {
    writeTaskState(AGENT, { nextAction: 'next', doneSteps: ['x'] }, Date.now())
    const a = await call('GET', `/api/agent-taskstate/${AGENT}/replay?source=compact`)
    const b = await call('GET', `/api/agent-taskstate/${AGENT}/replay?source=compact`)
    expect((a.json() as { additionalContext: string | null }).additionalContext).not.toBeNull()
    // Second call must still return the injection -- replay is read-only on purpose.
    expect((b.json() as { additionalContext: string | null }).additionalContext).not.toBeNull()
  })
})

// -----------------------------------------------------------------------
// POST /api/agent-taskstate/:agent/consume
// -----------------------------------------------------------------------
describe('POST /api/agent-taskstate/:agent/consume', () => {
  it('flips the consumed flag so the next replay is suppressed', async () => {
    writeTaskState(AGENT, { nextAction: 'next', doneSteps: ['x'] }, Date.now())
    const { res, json } = await call('POST', `/api/agent-taskstate/${AGENT}/consume`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    const stored = readTaskState(AGENT)
    expect(stored?.consumed).toBe(true)

    const replay = await call('GET', `/api/agent-taskstate/${AGENT}/replay?source=compact`)
    expect((replay.json() as { additionalContext: string | null }).additionalContext).toBeNull()
  })

  it('is a no-op when there is no record to consume (still returns ok:true)', async () => {
    const { res, json } = await call('POST', `/api/agent-taskstate/never-written/consume`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    // markConsumed on missing record returns silently -> readTaskState remains null.
    expect(readTaskState('never-written')).toBeNull()
  })
})

// -----------------------------------------------------------------------
// GET /api/agent-taskstate/:agent
// -----------------------------------------------------------------------
describe('GET /api/agent-taskstate/:agent', () => {
  it('returns the raw record JSON for an existing agent', async () => {
    writeTaskState(AGENT, {
      nextAction: 'next',
      summary: 'building X',
      doneSteps: ['merged #276'],
    }, 1_700_000_000_000)
    const { res, json } = await call('GET', `/api/agent-taskstate/${AGENT}`)
    expect(res.statusCode).toBe(200)
    const out = json() as { agent: string; ts: number; nextAction: string; summary: string }
    expect(out.agent).toBe(AGENT)
    expect(out.ts).toBe(1_700_000_000_000)
    expect(out.nextAction).toBe('next')
    expect(out.summary).toBe('building X')
  })

  it('returns null JSON body when there is no record (readTaskState null)', async () => {
    const { res, json } = await call('GET', `/api/agent-taskstate/${AGENT}`)
    expect(res.statusCode).toBe(200)
    expect(json()).toBeNull()
  })
})

// -----------------------------------------------------------------------
// DELETE /api/agent-taskstate/:agent
// -----------------------------------------------------------------------
describe('DELETE /api/agent-taskstate/:agent', () => {
  it('removes the record and returns ok:true', async () => {
    writeTaskState(AGENT, { nextAction: 'next' }, Date.now())
    expect(readTaskState(AGENT)).not.toBeNull()

    const { res, json } = await call('DELETE', `/api/agent-taskstate/${AGENT}`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(readTaskState(AGENT)).toBeNull()
  })

  it('is a no-op when there is no record (still returns ok:true)', async () => {
    const { res, json } = await call('DELETE', `/api/agent-taskstate/never-written`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })
})
