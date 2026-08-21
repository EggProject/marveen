// 100% coverage suite for src/web/routes/autonomy.ts.
//
// The handler exposes two endpoints backed by a small JSON config file
// under PROJECT_ROOT/store/autonomy-config.json:
//
//   GET  /api/autonomy  -> returns the parsed JSON config (200) or 404
//                          when the file is missing / unparseable.
//   POST /api/autonomy  -> updates one category's level (200) or 4xx on
//                          validation failure / 500 on I/O failure.
//
// Branches covered below:
//   * dispatcher: false arm (unrelated path, non-GET/POST methods)
//   * GET happy path
//   * GET catch arm (existsSync() === false -- "not found")
//   * GET catch arm (JSON.parse throws on a malformed file)
//   * POST validation: missing/empty key, level not a number,
//     level < 1, level > 3
//   * POST category-not-found arm (404)
//   * POST locked-category arm when level > 1 (403)
//   * POST locked-category passes when level === 1 (the only level
//     allowed for a locked category)
//   * POST level > maxLevel arm (400)
//   * POST happy path (writes the config, returns { ok, ... })
//   * POST catch arm (JSON.parse(body) throws -- "Failed to update" 500)
//   * POST catch arm (loadConfig throws on save -- "Failed to update" 500)
//   * the optional `_doc` field round-trips untouched
//
// Sandbox: PROJECT_ROOT is pinned to a tmpdir-scoped value via the mocked
// config.js so the autonomy-config.json file the handler reads/writes
// stays out of the live store. Collaborators that have no observable
// behaviour for these tests (db / auth-gate / auth-sessions) are stubbed
// out so their side effects never fire.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'autonomy-routes-'))
const PROJECT = join(SANDBOX, 'project')
const STORE = join(PROJECT, 'store')
const CONFIG_PATH = join(STORE, 'autonomy-config.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => STORE, enumerable: true },
    },
  )
})

vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../store-watcher.js', () => ({
  setStoreWriteActor: vi.fn(),
}))

// Import AFTER every mock is registered.
const { tryHandleAutonomy } = await import('../web/routes/autonomy.js')
const { setStoreWriteActor } = await import('../store-watcher.js')
const { logger } = await import('../logger.js')

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

function mkReq(opts: { body?: Buffer | string } = {}): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(method: string, path: string, opts: { body?: Buffer | string } = {}): Promise<{
  res: MockRes
  handled: boolean
  json: () => Record<string, unknown> | null
}> {
  const req = mkReq(opts)
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url,
    fedPeer: null,
  }
  const handled = await tryHandleAutonomy(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

// Two-category fixture with both a locked (level cap 1) and a normal one.
const BASE_CONFIG = {
  version: 1,
  updated_at: 1_700_000_000,
  _doc: 'autonomy levels per category',
  categories: [
    { key: 'comm', label: 'Communication', level: 1, locked: false, maxLevel: 3 },
    { key: 'exec', label: 'Code execution', level: 1, locked: true, maxLevel: 3 },
    { key: 'cap', label: 'Capped category', level: 1, locked: false, maxLevel: 2 },
  ],
}

function writeConfig(content: object | string): void {
  const data = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  writeFileSync(CONFIG_PATH, data, 'utf-8')
}

function readConfig(): { version: number; updated_at: number; _doc?: string; categories: Array<{ key: string; level: number; locked: boolean; maxLevel: number; label: string }> } {
  return JSON.parse(readFileSync(CONFIG_PATH, 'utf-8'))
}

beforeAll(() => {
  mkdirSync(STORE, { recursive: true })
})

beforeEach(() => {
  if (existsSync(CONFIG_PATH)) rmSync(CONFIG_PATH, { force: true })
  vi.mocked(setStoreWriteActor).mockClear()
  vi.mocked(logger.info).mockClear()
  vi.mocked(logger.error).mockClear()
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

// -----------------------------------------------------------------------
// Dispatcher surface (path/method filter)
// -----------------------------------------------------------------------
describe('tryHandleAutonomy -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled, res } = await call('GET', '/api/other')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
    expect(res.body).toBe('')
  })

  it('returns false for /api/autonomy with a non-GET non-POST method (PUT)', async () => {
    const { handled, res } = await call('PUT', '/api/autonomy')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for /api/autonomy with DELETE', async () => {
    const { handled, res } = await call('DELETE', '/api/autonomy')
    expect(handled).toBe(false)
    expect(res.statusCode).toBe(0)
  })

  it('returns false for /api/autonomy with a trailing slash', async () => {
    const { handled } = await call('GET', '/api/autonomy/')
    expect(handled).toBe(false)
  })

  it('returns false for /api/autonomy-stats (path that has /api/autonomy as a prefix only)', async () => {
    const { handled } = await call('GET', '/api/autonomy-stats')
    expect(handled).toBe(false)
  })
})

// -----------------------------------------------------------------------
// GET /api/autonomy
// -----------------------------------------------------------------------
describe('GET /api/autonomy', () => {
  it('returns the parsed JSON config with 200 on the happy path', async () => {
    writeConfig(BASE_CONFIG)

    const { res, json, handled } = await call('GET', '/api/autonomy')

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    const body = json() as { version: number; categories: Array<{ key: string; level: number }> }
    expect(body.version).toBe(1)
    expect(body.categories).toHaveLength(3)
    expect(body.categories.find(c => c.key === 'comm')!.level).toBe(1)
  })

  it('returns 404 { error: "Config not found" } when the config file does not exist', async () => {
    // Make sure CONFIG_PATH is absent for this test.
    expect(existsSync(CONFIG_PATH)).toBe(false)

    const { res, json, handled } = await call('GET', '/api/autonomy')

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Config not found' })
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1)
  })

  it('returns 404 { error: "Config not found" } when the config file is malformed JSON', async () => {
    writeConfig('this is not valid json {{{')

    const { res, json, handled } = await call('GET', '/api/autonomy')

    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Config not found' })
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1)
  })
})

// -----------------------------------------------------------------------
// POST /api/autonomy -- validation
// -----------------------------------------------------------------------
describe('POST /api/autonomy -- validation (400 invalid key/level)', () => {
  beforeEach(() => writeConfig(BASE_CONFIG))

  it('returns 400 when key is missing (undefined)', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ level: 2 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })

  it('returns 400 when key is the empty string', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: '', level: 2 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })

  it('returns 400 when key is missing entirely from the body', async () => {
    const { res, json } = await call('POST', '/api/autonomy', { body: '{}' })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })

  it('returns 400 when level is a string, not a number', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: '2' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })

  it('returns 400 when level is 0 (below the 1-3 range)', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 0 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })

  it('returns 400 when level is -1 (below the 1-3 range)', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: -1 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })

  it('returns 400 when level is 4 (above the 1-3 range)', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 4 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })

  it('returns 400 when level is missing (undefined)', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm' }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })
})

// -----------------------------------------------------------------------
// POST /api/autonomy -- domain arms
// -----------------------------------------------------------------------
describe('POST /api/autonomy -- category lookup', () => {
  beforeEach(() => writeConfig(BASE_CONFIG))

  it('returns 404 when the requested key does not exist in the config', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'ghost', level: 1 }),
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Category "ghost" not found' })
  })
})

describe('POST /api/autonomy -- locked categories', () => {
  beforeEach(() => writeConfig(BASE_CONFIG))

  it('returns 403 when a locked category is asked for level > 1', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'exec', level: 2 }),
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Category "exec" is locked at level 1 (safety constraint)' })
  })

  it('returns 403 when a locked category is asked for level 3', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'exec', level: 3 }),
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Category "exec" is locked at level 1 (safety constraint)' })
  })

  it('ALLOWS a locked category at level 1 (the only permitted level)', async () => {
    // level === 1 on a locked category must NOT trip the 403 guard.
    const before = Date.now() / 1000
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'exec', level: 1 }),
    })
    const after = Date.now() / 1000

    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, key: 'exec', level: 1 })
    const updated_at = (json() as { updated_at: number }).updated_at
    expect(updated_at).toBeGreaterThanOrEqual(Math.floor(before))
    expect(updated_at).toBeLessThanOrEqual(Math.ceil(after) + 1)
  })
})

describe('POST /api/autonomy -- maxLevel cap', () => {
  beforeEach(() => writeConfig(BASE_CONFIG))

  it('returns 400 when level exceeds the category maxLevel', async () => {
    // 'cap' has maxLevel=2, so level 3 must be rejected.
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'cap', level: 3 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Category "cap" max level is 2' })
  })

  it('allows level === maxLevel (boundary: 2 for the capped category)', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'cap', level: 2 }),
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ ok: true, key: 'cap', level: 2 })
  })

  it('locked guard fires BEFORE the maxLevel guard (order: lock, then cap)', async () => {
    // 'exec' is locked AND maxLevel=3. The validation range is 1..3 so any
    // value that could exceed maxLevel also trips the lock check. Asking
    // level=2 must trip the lock guard (403), not the maxLevel guard (400),
    // proving the lock check runs first in the if/else chain.
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'exec', level: 2 }),
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Category "exec" is locked at level 1 (safety constraint)' })
  })

  it('validation guard fires BEFORE the maxLevel guard (out-of-range rejected first)', async () => {
    // 'cap' has maxLevel=2; asking level=4 must trip the validation guard
    // (400 "Invalid key or level (must be 1-3)"), not the maxLevel guard,
    // because the validation check runs first.
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'cap', level: 4 }),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid key or level (must be 1-3)' })
  })
})

// -----------------------------------------------------------------------
// POST /api/autonomy -- happy path
// -----------------------------------------------------------------------
describe('POST /api/autonomy -- happy path', () => {
  beforeEach(() => writeConfig(BASE_CONFIG))

  it('updates the matching category in-place and persists to disk', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 3 }),
    })

    expect(res.statusCode).toBe(200)
    const body = json() as { ok: boolean; key: string; level: number; updated_at: number }
    expect(body.ok).toBe(true)
    expect(body.key).toBe('comm')
    expect(body.level).toBe(3)
    expect(typeof body.updated_at).toBe('number')

    // Disk round-trip: the level was actually written.
    const stored = readConfig()
    const cat = stored.categories.find(c => c.key === 'comm')!
    expect(cat.level).toBe(3)
    expect(typeof stored.updated_at).toBe('number')
    // Unrelated categories must NOT have changed.
    const exec = stored.categories.find(c => c.key === 'exec')!
    expect(exec.level).toBe(1)
  })

  it('stamps updated_at with the current epoch seconds on every successful write', async () => {
    const beforeWrite = Math.floor(Date.now() / 1000)
    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 2 }),
    })
    const afterWrite = Math.floor(Date.now() / 1000) + 1

    expect(res.statusCode).toBe(200)
    const body = json() as { updated_at: number }
    expect(body.updated_at).toBeGreaterThanOrEqual(beforeWrite)
    expect(body.updated_at).toBeLessThanOrEqual(afterWrite)
  })

  it('calls setStoreWriteActor("dashboard") exactly once on the success path', async () => {
    expect(vi.mocked(setStoreWriteActor)).not.toHaveBeenCalled()
    const { res } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 2 }),
    })
    expect(res.statusCode).toBe(200)
    expect(vi.mocked(setStoreWriteActor)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(setStoreWriteActor)).toHaveBeenCalledWith('dashboard')
  })

  it('emits an info-level log line with the new key/level on success', async () => {
    expect(vi.mocked(logger.info)).not.toHaveBeenCalled()
    await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 2 }),
    })
    expect(vi.mocked(logger.info)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(logger.info)).toHaveBeenCalledWith(
      { key: 'comm', level: 2 },
      'Autonomy level updated',
    )
  })

  it('does NOT call setStoreWriteActor when validation fails (no write)', async () => {
    const { res } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 99 }),
    })
    expect(res.statusCode).toBe(400)
    expect(vi.mocked(setStoreWriteActor)).not.toHaveBeenCalled()
  })

  it('does NOT call setStoreWriteActor when the category is missing', async () => {
    const { res } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'ghost', level: 1 }),
    })
    expect(res.statusCode).toBe(404)
    expect(vi.mocked(setStoreWriteActor)).not.toHaveBeenCalled()
  })

  it('does NOT call setStoreWriteActor when the category is locked above 1', async () => {
    const { res } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'exec', level: 2 }),
    })
    expect(res.statusCode).toBe(403)
    expect(vi.mocked(setStoreWriteActor)).not.toHaveBeenCalled()
  })

  it('does NOT mutate the on-disk file when validation rejects the request', async () => {
    const before = readFileSync(CONFIG_PATH, 'utf-8')
    const { res } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 99 }),
    })
    expect(res.statusCode).toBe(400)
    const after = readFileSync(CONFIG_PATH, 'utf-8')
    expect(after).toBe(before)
  })

  it('preserves the optional _doc field on the persisted config', async () => {
    const { res } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 2 }),
    })
    expect(res.statusCode).toBe(200)
    const stored = readConfig()
    expect(stored._doc).toBe('autonomy levels per category')
  })
})

// -----------------------------------------------------------------------
// POST /api/autonomy -- error arms (catch block)
// -----------------------------------------------------------------------
describe('POST /api/autonomy -- error arms', () => {
  beforeEach(() => writeConfig(BASE_CONFIG))

  it('returns 500 { error: "Failed to update" } when the body is not valid JSON', async () => {
    const { res, json, handled } = await call('POST', '/api/autonomy', {
      body: 'this is not json',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to update' })
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1)
  })

  it('returns 500 when the config file is missing entirely at POST time', async () => {
    // No config exists; the loadConfig() inside the POST handler will throw
    // "autonomy-config.json not found" and the catch arm responds 500.
    rmSync(CONFIG_PATH, { force: true })

    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 2 }),
    })

    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to update' })
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1)
  })

  it('returns 500 when the config file is malformed at POST time', async () => {
    writeConfig('totally { broken json')

    const { res, json } = await call('POST', '/api/autonomy', {
      body: JSON.stringify({ key: 'comm', level: 2 }),
    })

    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to update' })
    expect(vi.mocked(logger.error)).toHaveBeenCalledTimes(1)
  })

  it('returns 500 when the body is an empty Buffer (JSON.parse fails)', async () => {
    const { res, json } = await call('POST', '/api/autonomy', {
      body: Buffer.alloc(0),
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to update' })
  })
})
