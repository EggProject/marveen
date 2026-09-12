import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  closeIngestDb,
  COORDINATOR_AGENT_ID,
  createHandoffMessage,
  getEventsNeedingHandoff,
  getOffset,
  initIngestDb,
  insertIncomingEvent,
  markEventDelivered,
  markEventFailed,
  setOffset,
  type IncomingEventRow,
} from '../channel-coordinator/ingest.js'

// Local type-guard mirroring the project convention used in
// src/web/password-hash.ts (assertPasswordPolicy). Vitest's lint rule
// forbids `!` non-null assertions, so we use a runtime check + an
// `asserts value is T` signature to narrow the type for downstream use.
function assertIsNumber(value: number | null): asserts value is number {
  if (value === null) throw new Error('expected non-null number')
}

let tempDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'ingest-worker-test-'))
  initIngestDb(join(tempDir, 'a.db'))
})

afterEach(() => {
  closeIngestDb()
  rmSync(tempDir, { recursive: true, force: true })
})

const validEv = {
  kind: 'message',
  chat_id: 100,
  user_id: 200,
  username: 'tester',
  message_id: 1,
  content: 'hello',
  meta: { foo: 'bar' },
  tg_date: 1700000000,
}

describe('IngestWorker class extraction', () => {
  it('initIngestDb is idempotent -- second call returns the same non-null Database handle', () => {
    const first = initIngestDb(join(tempDir, 'a.db'))
    const second = initIngestDb(join(tempDir, 'a.db'))
    expect(first).not.toBeNull()
    expect(second).toBe(first)
  })

  it('closeIngestDb closes the handle and nulls the singleton -- new init returns different handle, old handle throws on use', () => {
    const first = initIngestDb(join(tempDir, 'a.db'))
    closeIngestDb()
    const second = initIngestDb(join(tempDir, 'b.db'))
    expect(second).not.toBe(first)
    expect(() => first.prepare('SELECT 1').get()).toThrow()
  })

  it('insertIncomingEvent first call returns inserted=true with eventId>0 and row lands with correct update_id and pending status', () => {
    const db = initIngestDb(join(tempDir, 'a.db'))
    const r = insertIncomingEvent('telegram', { ...validEv, update_id: 100 })
    expect(r.inserted).toBe(true)
    assertIsNumber(r.eventId)
    expect(r.eventId).toBeGreaterThan(0)
    const row = db
      .prepare('SELECT update_id, status FROM incoming_events WHERE id = ?')
      .get(r.eventId) as { update_id: number; status: string }
    expect(row.update_id).toBe(100)
    expect(row.status).toBe('pending')
  })

  it('insertIncomingEvent same (source, update_id) returns inserted=false with eventId=null and no duplicate row is created', () => {
    const db = initIngestDb(join(tempDir, 'a.db'))
    const r1 = insertIncomingEvent('telegram', { ...validEv, update_id: 100 })
    const r2 = insertIncomingEvent('telegram', { ...validEv, update_id: 100 })
    expect(r1.inserted).toBe(true)
    expect(r2.inserted).toBe(false)
    expect(r2.eventId).toBeNull()
    const count = db
      .prepare('SELECT COUNT(*) as c FROM incoming_events WHERE source = ? AND update_id = ?')
      .get('telegram', 100) as { c: number }
    expect(count.c).toBe(1)
  })

  it('createHandoffMessage inserts an agent_messages row with from_agent=COORDINATOR_AGENT_ID and status=pending', () => {
    const db = initIngestDb(join(tempDir, 'a.db'))
    const id = createHandoffMessage('test handoff')
    expect(id).toBeGreaterThan(0)
    const row = db
      .prepare('SELECT from_agent, to_agent, status, content FROM agent_messages WHERE id = ?')
      .get(id) as { from_agent: string; to_agent: string; status: string; content: string }
    expect(row.from_agent).toBe('telegram-coordinator')
    expect(row.status).toBe('pending')
    expect(row.content).toBe('test handoff')
  })

  it('setOffset + getOffset round-trip with UPSERT semantics -- last write wins', () => {
    expect(getOffset('telegram')).toBe(0)
    setOffset('telegram', 12345)
    expect(getOffset('telegram')).toBe(12345)
    setOffset('telegram', 99999)
    expect(getOffset('telegram')).toBe(99999)
  })

  it('markEventDelivered transitions status to delivered and sets agent_message_id', () => {
    const db = initIngestDb(join(tempDir, 'a.db'))
    const r = insertIncomingEvent('telegram', { ...validEv, update_id: 200 })
    assertIsNumber(r.eventId)
    const handoffId = createHandoffMessage('hi')
    markEventDelivered(r.eventId, handoffId)
    const row = db
      .prepare('SELECT status, agent_message_id FROM incoming_events WHERE id = ?')
      .get(r.eventId) as { status: string; agent_message_id: number | null }
    expect(row.status).toBe('delivered')
    expect(row.agent_message_id).toBe(handoffId)
  })

  it('markEventFailed transitions status to failed and stores the error string', () => {
    const db = initIngestDb(join(tempDir, 'a.db'))
    const r = insertIncomingEvent('telegram', { ...validEv, update_id: 300 })
    assertIsNumber(r.eventId)
    markEventFailed(r.eventId, 'network timeout')
    const row = db
      .prepare('SELECT status, error FROM incoming_events WHERE id = ?')
      .get(r.eventId) as { status: string; error: string | null }
    expect(row.status).toBe('failed')
    expect(row.error).toBe('network timeout')
  })

  it('getEventsNeedingHandoff returns only rows where handoff is still pending (agent_message_id IS NULL)', () => {
    const db = initIngestDb(join(tempDir, 'a.db'))
    const r1 = insertIncomingEvent('telegram', { ...validEv, update_id: 401 })
    const r2 = insertIncomingEvent('telegram', { ...validEv, update_id: 402 })
    const r3 = insertIncomingEvent('telegram', { ...validEv, update_id: 403 })
    assertIsNumber(r1.eventId)
    assertIsNumber(r2.eventId)
    assertIsNumber(r3.eventId)
    const handoffId = createHandoffMessage('hi')
    markEventDelivered(r1.eventId, handoffId)
    markEventFailed(r2.eventId, 'downstream error')
    // r3 remains pending with agent_message_id IS NULL
    const needing: IncomingEventRow[] = getEventsNeedingHandoff('telegram')
    expect(needing).toHaveLength(1)
    expect(needing[0].id).toBe(r3.eventId)
    expect(needing[0].update_id).toBe(403)
    const count = db
      .prepare("SELECT COUNT(*) as c FROM incoming_events WHERE source = ? AND status != 'failed' AND agent_message_id IS NULL")
      .get('telegram') as { c: number }
    expect(count.c).toBe(needing.length)
  })

  it('COORDINATOR_AGENT_ID const at the module level matches the literal', () => {
    expect(COORDINATOR_AGENT_ID).toBe('telegram-coordinator')
  })

  it('defensive guard -- every shim throws Error with /ingest db not initialized/ when called before initIngestDb; singleton stays null', () => {
    closeIngestDb() // ensure clean state
    const ev = { ...validEv, update_id: 999 }
    const matchers = expect.objectContaining({
      message: expect.stringMatching(/ingest db not initialized/),
    })
    expect(() => insertIncomingEvent('telegram', ev)).toThrow(matchers)
    expect(() => createHandoffMessage('test')).toThrow(matchers)
    expect(() => markEventDelivered(1, 2)).toThrow(matchers)
    expect(() => markEventFailed(1, 'err')).toThrow(matchers)
    expect(() => getEventsNeedingHandoff('telegram')).toThrow(matchers)
    expect(() => getOffset('telegram')).toThrow(matchers)
    expect(() => setOffset('telegram', 100)).toThrow(matchers)
    // singleton still null after the throws -- a subsequent insert also throws
    expect(() => insertIncomingEvent('telegram', ev)).toThrow(matchers)
  })

  it('IngestWorker class is internal -- not present on the module export object, default export absent, named keys do not include it', async () => {
    const mod: Record<string, unknown> = await import('../channel-coordinator/ingest.js')
    expect(mod.IngestWorker).toBeUndefined()
    expect(mod.default).toBeUndefined()
    expect(Object.keys(mod)).not.toContain('IngestWorker')
  })
})