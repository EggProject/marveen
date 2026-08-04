// Tests for src/channel-coordinator/ingest.ts.
//
// The module owns a per-process better-sqlite3 handle to <store>/claudeclaw.db
// (separate from the dashboard's singleton in src/db.ts) and exposes the
// at-least-once ingest pipeline: insertIncomingEvent -> createHandoffMessage
// -> markEventDelivered / markEventFailed, plus getOffset / setOffset for the
// persisted getUpdates cursor and getEventsNeedingHandoff for the no-message-
// loss replay path. The DB handle is cached in a module-level `let db`, so
// every describe block resets it via initIngestDb(':memory:') (fresh in-memory
// store) / closeIngestDb().
//
// Sandbox: STORE_DIR is redirected into a tmpdir-scoped directory via a
// ../config.js mock, so initIngestDb() (no arg, exercises the
// join(STORE_DIR, DB_FILENAME) default branch) writes into the sandbox and
// never touches the live install. vitest isolates module registries per test
// file so the redirect cannot leak into other suites. The on-disk sandbox is
// removed in afterAll to satisfy the live-install-guard convention.

import { describe, it, expect, beforeEach, afterEach, afterAll, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// --- Sandbox setup -------------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), 'channel-coordinator-ingest-'))
const STORE = join(SANDBOX, 'store')
// The default-path branch resolves to <STORE>/claudeclaw.db; better-sqlite3
// refuses to create the file if the parent directory is missing, so we mkdir
// it up front (mkTempStore from temp-sandbox.ts does the same).
import { mkdirSync } from 'node:fs'
mkdirSync(STORE, { recursive: true })

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: STORE }
})

const {
  initIngestDb,
  insertIncomingEvent,
  createHandoffMessage,
  markEventDelivered,
  markEventFailed,
  getEventsNeedingHandoff,
  getOffset,
  setOffset,
  closeIngestDb,
  COORDINATOR_AGENT_ID,
} = await import('../channel-coordinator/ingest.js')

const { MAIN_AGENT_ID } = await import('../config.js')

const sampleEvent = (update_id: number) => ({
  update_id,
  kind: 'message',
  chat_id: 1268077055,
  user_id: 1268077055,
  username: 'szabolcs',
  message_id: update_id,
  content: `msg ${update_id}`,
  meta: { hello: 'world' },
  tg_date: 1700000000,
})

// ---- initIngestDb --------------------------------------------------------

describe('initIngestDb', () => {
  afterEach(() => { closeIngestDb() })

  it('uses the default STORE_DIR/DB_FILENAME path when no override is given', () => {
    // Exercises the `dbPath = join(STORE_DIR, DB_FILENAME)` default branch.
    const db = initIngestDb()
    expect(db).toBeDefined()
    const expectedPath = join(STORE, 'claudeclaw.db')
    expect(existsSync(expectedPath)).toBe(true)
  })

  it('uses an explicit override path when provided', () => {
    const override = join(SANDBOX, 'override.db')
    const db = initIngestDb(override)
    expect(db).toBeDefined()
    expect(existsSync(override)).toBe(true)
  })

  it('returns the cached handle on subsequent calls (idempotent init)', () => {
    const first = initIngestDb(':memory:')
    const second = initIngestDb(':memory:')
    const third = initIngestDb() // default-path call must still return the cache
    expect(second).toBe(first)
    expect(third).toBe(first)
  })

  it('sets journal_mode=WAL on the new handle', () => {
    // A file-backed DB is required -- :memory: databases always report
    // journal_mode='memory' regardless of the pragma, because WAL has no
    // meaningful semantics for a private heap-backed store. Use the default
    // path (which lands inside the sandbox) so we can observe the WAL.
    const db = initIngestDb()
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal')
  })

  it('creates the incoming_events, agent_messages, poll_offset tables and the two indexes', () => {
    const db = initIngestDb(':memory:')
    const names = (db.prepare(
      "SELECT name FROM sqlite_master WHERE type IN ('table','index') AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as { name: string }[]).map((r) => r.name)
    expect(names).toContain('incoming_events')
    expect(names).toContain('agent_messages')
    expect(names).toContain('poll_offset')
    expect(names).toContain('idx_incoming_events_source_update')
    expect(names).toContain('idx_incoming_events_status')
  })

  it('re-running the schema is a no-op (CREATE IF NOT EXISTS / UNIQUE INDEX)', () => {
    const db1 = initIngestDb(':memory:')
    // Insert a row, then call again: the cached branch returns the same handle
    // without touching the schema. If the schema were recreated it would
    // succeed but DROP+CREATE; here we verify the cache short-circuits.
    insertIncomingEvent('telegram', sampleEvent(1))
    const db2 = initIngestDb(':memory:')
    expect(db2).toBe(db1)
  })
})

// ---- insertIncomingEvent -------------------------------------------------

describe('insertIncomingEvent', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  it('returns inserted=true and a numeric eventId on the first insert', () => {
    const r = insertIncomingEvent('telegram', sampleEvent(1))
    expect(r.inserted).toBe(true)
    expect(typeof r.eventId).toBe('number')
    expect(r.eventId).toBeGreaterThan(0)
  })

  it('dedupes on (source, update_id) -- duplicate returns inserted=false, eventId=null', () => {
    const first = insertIncomingEvent('telegram', sampleEvent(2))
    const second = insertIncomingEvent('telegram', sampleEvent(2))
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.eventId).toBeNull()
  })

  it('treats different sources as independent -- same update_id from two sources both insert', () => {
    const a = insertIncomingEvent('telegram', sampleEvent(3))
    const b = insertIncomingEvent('slack', sampleEvent(3))
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(true)
    expect(a.eventId).not.toBe(b.eventId)
  })

  it('persists every column of the incoming_events row', () => {
    const r = insertIncomingEvent('telegram', sampleEvent(4))
    const row = initIngestDb(':memory:').prepare('SELECT * FROM incoming_events WHERE id = ?').get(r.eventId) as Record<string, unknown>
    expect(row.source).toBe('telegram')
    expect(row.update_id).toBe(4)
    expect(row.chat_id).toBe(1268077055)
    expect(row.user_id).toBe(1268077055)
    expect(row.username).toBe('szabolcs')
    expect(row.message_id).toBe(4)
    expect(row.kind).toBe('message')
    expect(row.content).toBe('msg 4')
    expect(JSON.parse(row.meta as string)).toEqual({ hello: 'world' })
    expect(row.tg_date).toBe(1700000000)
    expect(row.status).toBe('pending')
    expect(typeof row.created_at).toBe('number')
    expect((row.created_at as number)).toBeGreaterThan(0)
    expect(row.delivered_at).toBeNull()
    expect(row.error).toBeNull()
  })
})

// ---- createHandoffMessage ------------------------------------------------

describe('createHandoffMessage', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  it('inserts a pending agent_messages row from COORDINATOR to MAIN', () => {
    const id = createHandoffMessage('<channel>hi</channel>')
    expect(typeof id).toBe('number')
    expect(id).toBeGreaterThan(0)
    const row = initIngestDb(':memory:').prepare('SELECT * FROM agent_messages WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.from_agent).toBe(COORDINATOR_AGENT_ID)
    expect(row.to_agent).toBe(MAIN_AGENT_ID)
    expect(row.content).toBe('<channel>hi</channel>')
    expect(row.status).toBe('pending')
    expect(typeof row.created_at).toBe('number')
    expect((row.created_at as number)).toBeGreaterThan(0)
    expect(row.delivered_at).toBeNull()
    expect(row.completed_at).toBeNull()
    expect(row.result).toBeNull()
  })

  it('returns a fresh id for each call (auto-increment primary key)', () => {
    const a = createHandoffMessage('one')
    const b = createHandoffMessage('two')
    expect(b).toBeGreaterThan(a)
  })
})

// ---- markEventDelivered --------------------------------------------------

describe('markEventDelivered', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  it('sets status=delivered, agent_message_id, and a non-null delivered_at', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(5))
    const amId = createHandoffMessage('h')
    markEventDelivered(ins.eventId!, amId)
    const row = initIngestDb(':memory:').prepare('SELECT * FROM incoming_events WHERE id = ?').get(ins.eventId) as Record<string, unknown>
    expect(row.status).toBe('delivered')
    expect(row.agent_message_id).toBe(amId)
    expect(typeof row.delivered_at).toBe('number')
    expect((row.delivered_at as number)).toBeGreaterThan(0)
  })
})

// ---- markEventFailed -----------------------------------------------------

describe('markEventFailed', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  it('sets status=failed and stores the error string', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(6))
    markEventFailed(ins.eventId!, 'boom')
    const row = initIngestDb(':memory:').prepare('SELECT * FROM incoming_events WHERE id = ?').get(ins.eventId) as Record<string, unknown>
    expect(row.status).toBe('failed')
    expect(row.error).toBe('boom')
  })
})

// ---- getEventsNeedingHandoff --------------------------------------------
// No-message-loss replay: events whose handoff never landed, or whose
// agent_message was abandoned by the router, must be re-queued.

describe('getEventsNeedingHandoff', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  it('returns events never handed off (agent_message_id IS NULL)', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(10))
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(ids).toContain(ins.eventId)
  })

  it('returns events whose agent_message was marked failed by the router', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(11))
    const amId = createHandoffMessage('h')
    markEventDelivered(ins.eventId!, amId)
    initIngestDb(':memory:').prepare("UPDATE agent_messages SET status = 'failed' WHERE id = ?").run(amId)
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(ids).toContain(ins.eventId)
  })

  it('returns events whose agent_message row was deleted (LEFT JOIN -> am.id IS NULL)', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(12))
    const amId = createHandoffMessage('h')
    markEventDelivered(ins.eventId!, amId)
    initIngestDb(':memory:').prepare('DELETE FROM agent_messages WHERE id = ?').run(amId)
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(ids).toContain(ins.eventId)
  })

  it('excludes events with status=failed (terminal failure, no replay)', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(13))
    markEventFailed(ins.eventId!, 'oops')
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(ids).not.toContain(ins.eventId)
  })

  it('excludes events whose handoff is in-flight (status pending/delivered/done)', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(14))
    const amId = createHandoffMessage('h')
    markEventDelivered(ins.eventId!, amId)
    // agent_messages.status stays 'pending' (default) -> not 'failed' -> excluded
    initIngestDb(':memory:').prepare("UPDATE agent_messages SET status = 'delivered' WHERE id = ?").run(amId)
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(ids).not.toContain(ins.eventId)
  })

  it('filters by source (a different source is excluded)', () => {
    const tg = insertIncomingEvent('telegram', sampleEvent(15))
    const slack = insertIncomingEvent('slack', sampleEvent(15))
    const tgIds = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(tgIds).toContain(tg.eventId)
    expect(tgIds).not.toContain(slack.eventId)
    const slackIds = getEventsNeedingHandoff('slack').map((e) => e.id)
    expect(slackIds).toContain(slack.eventId)
    expect(slackIds).not.toContain(tg.eventId)
  })

  it('respects the limit parameter', () => {
    for (let i = 0; i < 5; i++) insertIncomingEvent('telegram', sampleEvent(100 + i))
    expect(getEventsNeedingHandoff('telegram')).toHaveLength(5)
    expect(getEventsNeedingHandoff('telegram', 2)).toHaveLength(2)
    expect(getEventsNeedingHandoff('telegram', 0)).toHaveLength(0)
  })

  it('orders by id ASC (oldest pending event first)', () => {
    const first = insertIncomingEvent('telegram', sampleEvent(200))
    insertIncomingEvent('telegram', sampleEvent(201))
    insertIncomingEvent('telegram', sampleEvent(202))
    const need = getEventsNeedingHandoff('telegram')
    expect(need[0].id).toBe(first.eventId)
    expect(need.map((e) => e.id)).toEqual([200, 201, 202].map((uid) => {
      // re-derive ids from update_id order -- ids match update_ids because
      // auto-increment mirrors insertion order in this suite
      return need.find((e) => e.update_id === uid)!.id
    }))
  })
})

// ---- getOffset / setOffset ----------------------------------------------

describe('getOffset', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  it('returns 0 when no poll_offset row exists for the source (no-row branch)', () => {
    expect(getOffset('telegram')).toBe(0)
    expect(getOffset('slack')).toBe(0)
  })

  it('returns the persisted last_update_id when a row exists', () => {
    setOffset('telegram', 42)
    expect(getOffset('telegram')).toBe(42)
  })
})

describe('setOffset', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  it('inserts a new poll_offset row with a non-zero updated_at', () => {
    setOffset('telegram', 100)
    const row = initIngestDb(':memory:').prepare('SELECT * FROM poll_offset WHERE source = ?').get('telegram') as Record<string, unknown>
    expect(row.source).toBe('telegram')
    expect(row.last_update_id).toBe(100)
    expect(typeof row.updated_at).toBe('number')
    expect((row.updated_at as number)).toBeGreaterThan(0)
  })

  it('upserts an existing offset row (ON CONFLICT DO UPDATE)', () => {
    setOffset('telegram', 100)
    setOffset('telegram', 200)
    expect(getOffset('telegram')).toBe(200)
    const rows = initIngestDb(':memory:').prepare('SELECT COUNT(*) c FROM poll_offset WHERE source = ?').get('telegram') as { c: number }
    expect(rows.c).toBe(1)
  })
})

// ---- closeIngestDb + requireDb throw branch -----------------------------

describe('closeIngestDb', () => {
  it('closes the cached handle and resets db to null (subsequent ops throw)', () => {
    initIngestDb(':memory:')
    closeIngestDb()
    // requireDb()'s `if (!db) throw` branch fires on the next operation call.
    expect(() => insertIncomingEvent('telegram', sampleEvent(99))).toThrow('ingest db not initialized')
  })

  it('every operation throws after closeIngestDb (requireDb guard covers all entry points)', () => {
    initIngestDb(':memory:')
    closeIngestDb()
    expect(() => insertIncomingEvent('telegram', sampleEvent(1))).toThrow('ingest db not initialized')
    expect(() => createHandoffMessage('x')).toThrow('ingest db not initialized')
    expect(() => markEventDelivered(1, 1)).toThrow('ingest db not initialized')
    expect(() => markEventFailed(1, 'x')).toThrow('ingest db not initialized')
    expect(() => getEventsNeedingHandoff('telegram')).toThrow('ingest db not initialized')
    expect(() => getOffset('telegram')).toThrow('ingest db not initialized')
    expect(() => setOffset('telegram', 1)).toThrow('ingest db not initialized')
  })

  it('is a no-op when called before initIngestDb (db already null)', () => {
    // closeIngestDb's `if (db)` short-circuits on the no-handle branch.
    expect(() => closeIngestDb()).not.toThrow()
    expect(() => closeIngestDb()).not.toThrow()
    // Subsequent init still works.
    const db = initIngestDb(':memory:')
    expect(db).toBeDefined()
    closeIngestDb()
  })

  it('initializes cleanly again after closeIngestDb (full reset)', () => {
    const first = initIngestDb(':memory:')
    insertIncomingEvent('telegram', sampleEvent(1))
    closeIngestDb()
    const second = initIngestDb(':memory:')
    expect(second).not.toBe(first) // fresh handle, fresh in-memory store
    // The new store is empty (no rows survived).
    expect(getOffset('telegram')).toBe(0)
    closeIngestDb()
  })
})

// ---- teardown -----------------------------------------------------------

afterAll(() => {
  // Defensive: ensure the sandbox handle is released before we rmSync, so the
  // WAL sidecar file (-wal/-shm) doesn't keep the dir busy on some filesystems.
  closeIngestDb()
  rmSync(SANDBOX, { recursive: true, force: true })
})