// Tests for the class form invariants of src/db.ts:1606 ChannelPairingStore cluster.
//
// The free-function form (upsertChannelRequest / listPendingChannelRequests /
// updateChannelRequestStatus / updateChannelRequestName) is covered by the
// pre-existing channel-request*.test.ts files. This file adds it() blocks that
// specifically exercise the ChannelPairingStore class; each block states its
// own intent in its it() title.
//
// Sandbox: each test creates its own `new Database(':memory:')` via the
// makeStore() helper, then constructs `new ChannelPairingStore({ getDb: () => db })`
// with a closure that resolves the live handle on every method invocation.
// This mirrors the module-singleton's `new ChannelPairingStore()` shape
// (which defaults deps to the module-level getDb) while giving each test a
// fresh, isolated schema.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import type { ChannelPairingStore as ChannelPairingStoreType } from '../db.js'

let ChannelPairingStore: typeof ChannelPairingStoreType

beforeAll(async () => {
  const mod = await import('../db.js')
  ChannelPairingStore = mod.ChannelPairingStore
})

// Mirror of the production schema (src/db.ts:3065-3184 migration block).
// The CHECK constraint + unique partial index together produce the dedup
// semantics that upsertRequest relies on. A no-op upsertRequest that skips
// the SELECT check would silently pass every duplicate insert via the
// INSERT, but the unique partial index on (agent, channel_id) WHERE status =
// 'pending' would still raise -- so the makeStore helper faithfully mirrors
// both the table definition AND the index.
function makeStore(): { db: Database; store: ChannelPairingStoreType } {
  const db = new Database(':memory:')
  db.exec(`
    CREATE TABLE pending_channel_requests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      agent TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      channel_name TEXT,
      user_id TEXT,
      requested_at INTEGER NOT NULL,
      resolved_at INTEGER,
      status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','approved','denied'))
    )
  `)
  db.exec(`CREATE UNIQUE INDEX idx_pcr_agent_channel ON pending_channel_requests(agent, channel_id) WHERE status = 'pending'`)
  const store = new ChannelPairingStore({ getDb: () => db })
  return { db, store }
}

describe('ChannelPairingStore', () => {
  let db: Database
  let store: ChannelPairingStoreType

  beforeEach(() => {
    const ctx = makeStore()
    db = ctx.db
    store = ctx.store
  })

  afterEach(() => {
    db.close()
  })

  // ---- upsertRequest -------------------------------------------------------

  // Fresh (agent, channel) pair: returns true and inserts a pending row with
  // the supplied user_id. A no-op upsertRequest that always returns true
  // would pass the first assertion but the `listPending` length check would
  // fail if the INSERT was skipped, and the toMatchObject check on the row
  // would fail if user_id wasn't threaded through the SQL.
  it('returns true and inserts a row for a fresh (agent, channel) pair', () => {
    expect(store.upsertRequest('a1', 'C1', 'U1')).toBe(true)

    const rows = store.listPending('a1')
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ agent: 'a1', channel_id: 'C1', user_id: 'U1', status: 'pending' })
  })

  // Re-insert of the same (agent, channel) while the prior row is still
  // pending: returns false AND does not create a second row. A no-op that
  // unconditionally returns false would pass this assertion but fail the
  // earlier test, so the two together lock down the dedup behavior.
  it('returns false when the same pending pair is re-inserted (dedup)', () => {
    store.upsertRequest('a1', 'C1')
    expect(store.upsertRequest('a1', 'C1')).toBe(false)
    expect(store.listPending('a1')).toHaveLength(1)
  })

  // (agent, channel) pairs are scoped per-agent: same channel_id under
  // different agents produces two distinct rows with distinct ids. A
  // no-op upsertRequest that always returns true (without dedup) would
  // pass the first assertion but fail the second listPending('agent-b')
  // length check, because the second call would short-circuit on a
  // cross-agent collision.
  it('isolates (agent, channel) pairs per-agent', () => {
    store.upsertRequest('agent-a', 'C1')
    expect(store.upsertRequest('agent-b', 'C1')).toBe(true)

    const rowsA = store.listPending('agent-a')
    const rowsB = store.listPending('agent-b')
    expect(rowsA).toHaveLength(1)
    expect(rowsB).toHaveLength(1)
    expect(rowsA[0]?.id).not.toBe(rowsB[0]?.id)
  })

  // The seven-day denied-recency override: a row in 'denied' status whose
  // COALESCE(resolved_at, requested_at) is within the seven-day window
  // blocks re-insertion, but one older than seven days allows it. A
  // no-op upsertRequest that skips the SELECT check would always return
  // true and fail the first assertion; one that always returns false
  // would fail the second.
  it('honours the seven-day denied-recency override', () => {
    const now = Math.floor(Date.now() / 1000)
    db.prepare(
      `INSERT INTO pending_channel_requests(agent, channel_id, user_id, requested_at, resolved_at, status) VALUES('a1', 'C1', NULL, ?, ?, 'denied')`
    ).run(now - 86400, now - 86400)
    db.prepare(
      `INSERT INTO pending_channel_requests(agent, channel_id, user_id, requested_at, resolved_at, status) VALUES('a2', 'C2', NULL, ?, ?, 'denied')`
    ).run(now - 30 * 86400, now - 30 * 86400)

    expect(store.upsertRequest('a1', 'C1')).toBe(false) // denied within 7d -> block
    expect(store.upsertRequest('a2', 'C2')).toBe(true)  // denied >7d ago -> re-insert
  })

  // Optional userId defaults to NULL when omitted. A no-op upsertRequest
  // that always passed an empty string would fail the toMatchObject check
  // because user_id would be '' rather than null.
  it('returns true and inserts with userId=null when userId is omitted', () => {
    expect(store.upsertRequest('a1', 'C1')).toBe(true)
    const rows = store.listPending('a1')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.user_id).toBeNull()
  })

  // ---- updateStatus --------------------------------------------------------

  // Unknown id: returns false and changes nothing. Paired with a positive
  // control (a real pending id returns true) so the always-() => false gut
  // is caught: the second toBe(true) FAILS under that gut.
  it('returns false for an unknown id, true for a known pending id', () => {
    expect(store.updateStatus(99999, 'approved')).toBe(false)
    store.upsertRequest('a1', 'C1')
    const row = store.listPending('a1')[0]
    expect(row).toBeDefined()
    expect(store.updateStatus(row!.id, 'approved')).toBe(true)
  })

  // Pending -> approved transition: returns true and the row leaves the
  // pending list. A no-op updateStatus that skipped the WHERE status =
  // 'pending' guard would still set the row, but the .changes > 0 check
  // catches that path -- the row WOULD be updated, so this specific test
  // also guards against a no-op that returns true without running SQL.
  it('returns true and transitions status when pending', () => {
    store.upsertRequest('a1', 'C1')
    const row = store.listPending('a1')[0]
    expect(row).toBeDefined()
    expect(store.updateStatus(row!.id, 'approved')).toBe(true)
    expect(store.listPending('a1')).toHaveLength(0)
  })

  // Re-running updateStatus after the row has already moved out of
  // 'pending' must return false (the WHERE status = 'pending' guard).
  // A no-op updateStatus that always returned true would pass the first
  // updateStatus call but fail this one.
  it('returns false when the row is not pending (status guard)', () => {
    store.upsertRequest('a1', 'C1')
    const row = store.listPending('a1')[0]
    expect(row).toBeDefined()
    expect(store.updateStatus(row!.id, 'denied')).toBe(true)
    expect(store.updateStatus(row!.id, 'approved')).toBe(false)
    expect(store.listPending('a1')).toHaveLength(0)
  })

  // ---- updateName ----------------------------------------------------------

  // updateName mutates channel_name in place on the live row. A no-op
  // updateName that skipped the SQL would leave channel_name as null
  // (the column default) and fail the toBe('general') assertion.
  it('mutates channel_name in place', () => {
    store.upsertRequest('a1', 'C1')
    const row = store.listPending('a1')[0]
    expect(row).toBeDefined()
    store.updateName(row!.id, 'general')
    expect(store.listPending('a1')[0]?.channel_name).toBe('general')
  })

  // ---- listPending ---------------------------------------------------------

  // Empty case: listPending returns [] (not null, not undefined) for an
  // agent with no pending rows. Paired with a positive control on a
  // different agent that has a row so the always-() => [] gut is caught:
  // the second toHaveLength(1) FAILS under that gut.
  it('returns [] for a no-rows agent; a different agent with rows returns 1', () => {
    expect(store.listPending('a-nonexistent')).toHaveLength(0)
    store.upsertRequest('other-agent', 'C1')
    expect(store.listPending('other-agent')).toHaveLength(1)
  })

  // Ordering: listPending sorts by requested_at DESC. We sleep briefly
  // between inserts to ensure distinct timestamps, then assert the later
  // row appears first. A no-op listPending that returned rows in
  // insertion order would fail this assertion.
  it('orders results by requested_at DESC', async () => {
    store.upsertRequest('a1', 'C-older')
    await new Promise(r => setTimeout(r, 1100))
    store.upsertRequest('a1', 'C-newer')

    const rows = store.listPending('a1')
    expect(rows).toHaveLength(2)
    expect(rows[0]?.channel_id).toBe('C-newer')
    expect(rows[1]?.channel_id).toBe('C-older')
  })

  // ---- free-function wrapper compatibility ---------------------------------

  // T12-equivalent (mirrors approval-store-classes.test.ts T12). The four
  // module-level wrappers must wire through to the live module-singleton
  // after initDatabase(':memory:'). Without this assertion, a no-op stub
  // `function upsertChannelRequest() { return true }` would pass the
  // previous typeof/arity checks but fail here, because listPending would
  // return [] (no row was inserted). Production callers in
  // channel-request-watcher.ts and routes/agents.ts rely on the shim
  // writing to the same handle the rest of the module sees.
  it('the four free-fn shims write through the module-singleton after initDatabase', async () => {
    const dbModule = await import('../db.js')
    dbModule.initDatabase(':memory:')

    expect(dbModule.upsertChannelRequest('shim-agent', 'C1', 'U1')).toBe(true)
    const rows = dbModule.listPendingChannelRequests('shim-agent')
    expect(rows).toHaveLength(1)
    expect(rows[0]?.user_id).toBe('U1')
    const id = rows[0]?.id
    expect(typeof id).toBe('number')

    expect(dbModule.updateChannelRequestStatus(id, 'approved')).toBe(true)
    dbModule.updateChannelRequestName(id, 'general')

    // Cross-form regression (T14-equivalent): the class-side view on the
    // SAME handle must see the post-shim state. The row was approved so
    // listPending returns []; the name update is on a non-pending column
    // so a direct SELECT on the class-side handle would see 'general'.
    const classStore = new ChannelPairingStore({ getDb: () => dbModule.getDb() })
    expect(classStore.listPending('shim-agent')).toHaveLength(0)

    dbModule.getDb().close()
  })
})
