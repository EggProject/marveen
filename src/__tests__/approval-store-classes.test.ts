// Tests for the class form invariants of src/db.ts:2283 ApprovalStore cluster.
//
// The free-function form (createApproval / getApproval / resolveApproval /
// listApprovals / expireTimedOutApprovals) is covered by
// src/__tests__/approvals.test.ts. This file adds 15 it() blocks (T1-T15)
// that specifically exercise the ApprovalStore class; each block states its
// own intent in its it() title and in the comment directly above it.
//
// Sandbox: each test creates its own `new Database(':memory:')` via the
// createSchema() helper, then constructs `new ApprovalStore({ getDb: () => db,
// log: noopLog })` with a closure that resolves the live handle on every
// method invocation. This mirrors the module-singleton's `new ApprovalStore()`
// shape (which defaults deps to getDb + logger) while giving each test a
// fresh, isolated schema.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { runScript } from '../db/sqlite.js'
import type { LoggerLike } from '../logger.js'
import type { ApprovalStore as ApprovalStoreType } from '../db.js'

let ApprovalStore: typeof ApprovalStoreType

beforeAll(async () => {
  const mod = await import('../db.js')
  ApprovalStore = mod.ApprovalStore
})

// Same shape as src/__tests__/process-lock-classes.test.ts:18-20 -- a plain
// object literal already satisfies LoggerLike structurally, so no cast.
const noop = (): undefined => undefined
const noopLog: LoggerLike = { info: noop, warn: noop, error: noop, debug: noop }

// Mirror of the production schema (src/db.ts:3335-3353) so the class methods
// see the same CHECK constraints + indexes they would on the live store.
// No try/catch around the runScript calls: every caller passes a freshly
// created `new Database(':memory:')`, so a throw here is a real schema error
// that must not be swallowed.
function createSchema(db: Database): void {
  runScript(db, `
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      category TEXT NOT NULL,
      action_description TEXT NOT NULL,
      action_payload TEXT,
      status TEXT NOT NULL DEFAULT 'pending'
        CHECK(status IN ('pending','approved','rejected','timeout')),
      timeout_at INTEGER,
      telegram_message_id INTEGER,
      requested_at INTEGER NOT NULL DEFAULT (unixepoch()),
      resolved_at INTEGER,
      resolved_by TEXT
    )
  `)
  runScript(db, `CREATE INDEX IF NOT EXISTS idx_approvals_status ON approvals(status, requested_at)`)
  runScript(db, `CREATE INDEX IF NOT EXISTS idx_approvals_agent ON approvals(agent_id, requested_at)`)
}

function makeStore(): { store: ApprovalStoreType; db: Database } {
  const db = new Database(':memory:')
  createSchema(db)
  const store = new ApprovalStore({ getDb: () => db, log: noopLog })
  return { store, db }
}

describe('ApprovalStore class form', () => {
  let store: ApprovalStoreType
  let db: Database

  beforeEach(() => {
    const ctx = makeStore()
    store = ctx.store
    db = ctx.db
  })

  afterEach(() => {
    db.close()
  })

  // ---- T1 ------------------------------------------------------------------
  // create() round-trip: row is retrievable via get() with the same id, the
  // status starts as 'pending', and requested_at is stamped within the
  // wall-clock window. Three separate field assertions: a no-op
  // `return { id: params.id, ... }` would pass `get(id).id === params.id` but
  // would also leave the row un-INSERTed, so get() would return undefined
  // and fail the first assertion; a no-op that skips the requested_at
  // stamp would leave it as the column DEFAULT (unixepoch()), which would
  // usually pass the wall-clock window — so we also assert list().length
  // === 1 after a second create, falsifying the "always return undefined"
  // form.
  it('T1: create() persists a pending row and get() reads it back', () => {
    const before = Math.floor(Date.now() / 1000)
    store.create({ id: 'ap-1', agent_id: 'a', category: 'c', action_description: 'd' })
    const after = Math.floor(Date.now() / 1000)

    // Second create() guards against a no-op that returns the input object
    // but doesn't INSERT -- list() would return 0 rows.
    store.create({ id: 'ap-2', agent_id: 'a', category: 'c', action_description: 'd' })

    const row = store.get('ap-1')
    expect(row).toBeDefined()
    expect(row?.id).toBe('ap-1')
    expect(row?.status).toBe('pending')
    expect(row?.requested_at).toBeGreaterThanOrEqual(before)
    expect(row?.requested_at).toBeLessThanOrEqual(after)
    expect(store.list({}).length).toBe(2)
  })

  // ---- T2 ------------------------------------------------------------------
  // create() honours optional timeout_at and action_payload. Three creates
  // with all-3 combinations of present/null: both-present, only-payload,
  // only-timeout. Asserting the EXACT input value on both fields rules out
  // a regression that dropped either parameter from the INSERT.
  it('T2: create() honours optional timeout_at and action_payload', () => {
    const timeoutAt = Math.floor(Date.now() / 1000) + 600
    const payload = JSON.stringify({ target: 'logs' })

    store.create({
      id: 'ap-both',
      agent_id: 'a',
      category: 'c',
      action_description: 'd',
      action_payload: payload,
      timeout_at: timeoutAt,
    })
    store.create({
      id: 'ap-payload-only',
      agent_id: 'a',
      category: 'c',
      action_description: 'd',
      action_payload: payload,
    })
    store.create({
      id: 'ap-timeout-only',
      agent_id: 'a',
      category: 'c',
      action_description: 'd',
      timeout_at: timeoutAt,
    })

    const both = store.get('ap-both')
    expect(both?.action_payload).toBe(payload)
    expect(both?.timeout_at).toBe(timeoutAt)

    const payloadOnly = store.get('ap-payload-only')
    expect(payloadOnly?.action_payload).toBe(payload)
    expect(payloadOnly?.timeout_at).toBeNull()

    const timeoutOnly = store.get('ap-timeout-only')
    expect(timeoutOnly?.action_payload).toBeNull()
    expect(timeoutOnly?.timeout_at).toBe(timeoutAt)
  })

  // ---- T3 ------------------------------------------------------------------
  // get() returns undefined for an unknown id (negative case) and the row
  // for a known id (positive case). Both halves are load-bearing: a no-op
  // `return undefined` would pass the negative case but fail the positive
  // one; a no-op `return {}` would fail the negative case because
  // `toBeUndefined()` is strict.
  it('T3: get() returns undefined for unknown id, row for known id', () => {
    store.create({ id: 'ap-1', agent_id: 'a', category: 'c', action_description: 'd' })

    expect(store.get('nonexistent')).toBeUndefined()
    expect(store.get('ap-1')?.id).toBe('ap-1')
  })

  // ---- T4 ------------------------------------------------------------------
  // resolve() is idempotent at the boolean level AND respects the
  // `AND status = 'pending'` guard. First call resolves (true), second call
  // is a no-op (false because the status is no longer 'pending'), and the
  // row.status remains 'approved' after the second call. A regression that
  // dropped the `status='pending'` guard would let the second call succeed
  // AND would overwrite resolved_at to a later timestamp.
  it('T4: resolve() is idempotent and respects the pending-status guard', () => {
    store.create({ id: 'ap-1', agent_id: 'a', category: 'c', action_description: 'd' })

    expect(store.resolve('ap-1', 'approved', 'me', 42001)).toBe(true)
    const firstRow = store.get('ap-1')
    const firstResolvedAt = firstRow?.resolved_at
    expect(firstRow?.status).toBe('approved')

    // Second call: status is no longer 'pending', so the WHERE clause skips
    // the row and the boolean is false.
    expect(store.resolve('ap-1', 'rejected', 'someone-else', 42002)).toBe(false)

    const secondRow = store.get('ap-1')
    expect(secondRow?.status).toBe('approved')
    expect(secondRow?.resolved_by).toBe('me')
    expect(secondRow?.resolved_at).toBe(firstResolvedAt)
    expect(secondRow?.telegram_message_id).toBe(42001)
  })

  // ---- T5 ------------------------------------------------------------------
  // resolve() sets resolved_at, resolved_by, telegram_message_id. Three
  // separate field assertions; each is concrete and load-bearing.
  it('T5: resolve() sets resolved_at, resolved_by, telegram_message_id', () => {
    store.create({ id: 'ap-1', agent_id: 'a', category: 'c', action_description: 'd' })

    const before = Math.floor(Date.now() / 1000)
    store.resolve('ap-1', 'approved', 'me', 42001)
    const after = Math.floor(Date.now() / 1000)

    const row = store.get('ap-1')
    expect(row?.resolved_by).toBe('me')
    expect(row?.telegram_message_id).toBe(42001)
    expect(row?.resolved_at).toBeGreaterThanOrEqual(before)
    expect(row?.resolved_at).toBeLessThanOrEqual(after)
  })

  // ---- T6 ------------------------------------------------------------------
  // list() ORDER BY requested_at DESC + filter combinations. Insert 4 rows
  // with explicit requested_at values 100/200/300/400 across two agents,
  // two categories, and three statuses; unfiltered list must come back
  // newest-first; then filter by agent_id, category, status='pending',
  // status='approved', and limit=2 -- each filter returns the exact ids
  // expected. A regression that dropped ORDER BY would pass length but
  // fail the exact id array; a regression that dropped any filter would
  // return all 4 rows.
  it('T6: list() ORDER BY requested_at DESC + filter combinations', () => {
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`).run('l-1', 'ag-1', 'cat-A', 'd', 'pending', 100)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`).run('l-2', 'ag-1', 'cat-A', 'd', 'approved', 200)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`).run('l-3', 'ag-2', 'cat-B', 'd', 'pending', 300)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`).run('l-4', 'ag-2', 'cat-B', 'd', 'pending', 400)

    // No filter: ORDER BY requested_at DESC -> [l-4, l-3, l-2, l-1]
    expect(store.list({}).map(r => r.id)).toEqual(['l-4', 'l-3', 'l-2', 'l-1'])

    // agent_id filter
    expect(store.list({ agent_id: 'ag-1' }).map(r => r.id).sort()).toEqual(['l-1', 'l-2'])

    // category filter
    expect(store.list({ category: 'cat-B' }).map(r => r.id).sort()).toEqual(['l-3', 'l-4'])

    // status filter
    expect(store.list({ status: 'pending' }).map(r => r.id).sort()).toEqual(['l-1', 'l-3', 'l-4'])
    expect(store.list({ status: 'approved' }).map(r => r.id)).toEqual(['l-2'])

    // limit
    expect(store.list({ limit: 2 }).length).toBe(2)
  })

  // ---- T7 ------------------------------------------------------------------
  // list() limit clamp (capped at 500). The clamp is verified indirectly
  // via SQL's `LIMIT ?` receiving the clamped value. Insert 600 rows with
  // distinct requested_at values, then ask for limit: 9000; the result
  // must have exactly 500 rows, not 9000 (which would exceed total).
  it('T7: list() clamps limit at 500', () => {
    const stmt = db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`)
    for (let i = 0; i < 600; i++) {
      stmt.run(`clamp-${i}`, 'a', 'c', 'd', 'pending', i)
    }

    // limit: 9000 must clamp to 500
    expect(store.list({ limit: 9000 }).length).toBe(500)
  })

  // ---- T8 ------------------------------------------------------------------
  // expireTimedOut() flips status from 'pending' to 'timeout', respects the
  // timeout_at column (only rows whose timeout_at <= now and is NOT NULL
  // are affected), and leaves non-pending rows alone. Four fixtures:
  // (a) pending + past timeout_at -> flipped, (b) pending + future
  // timeout_at -> untouched, (c) pending + NULL timeout_at -> untouched,
  // (d) approved + past timeout_at -> untouched (status guard). The
  // returned change count must equal 1.
  it('T8: expireTimedOut() flips pending rows with past timeout_at only', () => {
    const now = Math.floor(Date.now() / 1000)
    const past = now - 100
    const future = now + 100

    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('past', 'a', 'c', 'd', 'pending', 100, past)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('future', 'a', 'c', 'd', 'pending', 100, future)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`).run('no-timeout', 'a', 'c', 'd', 'pending', 100)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at, resolved_at, resolved_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run('already-approved', 'a', 'c', 'd', 'approved', 100, past, now - 50, 'someone')

    expect(store.expireTimedOut()).toBe(1)

    expect(store.get('past')?.status).toBe('timeout')
    expect(store.get('future')?.status).toBe('pending')
    expect(store.get('no-timeout')?.status).toBe('pending')
    expect(store.get('already-approved')?.status).toBe('approved')
  })

  // ---- T9 ------------------------------------------------------------------
  // expireTimedOut() returns the change count, not a constant. After
  // inserting 3 expired rows + 1 future row, expireTimedOut() must return
  // exactly 3. A no-op `return 0` would fail this; a no-op `return N`
  // would fail any case where the actual count differs from N.
  it('T9: expireTimedOut() returns the change count', () => {
    const now = Math.floor(Date.now() / 1000)
    const past = now - 100
    const future = now + 100

    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e-1', 'a', 'c', 'd', 'pending', 100, past)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e-2', 'a', 'c', 'd', 'pending', 100, past)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e-3', 'a', 'c', 'd', 'pending', 100, past)
    db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e-future', 'a', 'c', 'd', 'pending', 100, future)

    expect(store.expireTimedOut()).toBe(3)
  })

  // ---- T10 -----------------------------------------------------------------
  // Per-instance isolation: two ApprovalStores on two different :memory:
  // handles do not see each other's writes. Wrapped in try/finally so both
  // .close() calls fire even if an assertion throws.
  it('T10: per-instance isolation (two ApprovalStores on independent :memory: handles)', () => {
    const ctxA = makeStore()
    const ctxB = makeStore()
    try {
      const storeA = ctxA.store
      const storeB = ctxB.store

      expect(storeA.list({}).length).toBe(0)
      expect(storeB.list({}).length).toBe(0)

      storeB.create({ id: 'ap-B', agent_id: 'b', category: 'c', action_description: 'd' })

      expect(storeA.list({}).length).toBe(0)
      expect(storeB.list({}).length).toBe(1)
      expect(storeB.list({})[0].id).toBe('ap-B')
    } finally {
      ctxA.db.close()
      ctxB.db.close()
    }
  })

  // ---- T11 -----------------------------------------------------------------
  // DI override via constructor deps.getDb. Construct
  // `new ApprovalStore({ getDb: () => customDb, log: noopLog })` where
  // customDb is a separate :memory: handle. Write through the store, then
  // read through `customDb.prepare(...)` directly: the row must be visible
  // through the raw handle (proving the closure wires through). A
  // regression where the constructor's DI dep was ignored would leave the
  // store writing to the wrong (or no) handle.
  it('T11: DI override via constructor deps.getDb', () => {
    const customDb = new Database(':memory:')
    try {
      createSchema(customDb)
      const diStore = new ApprovalStore({ getDb: () => customDb, log: noopLog })

      diStore.create({ id: 'di-1', agent_id: 'a', category: 'c', action_description: 'd' })

      // Read through the raw handle: the row MUST be there.
      const row = customDb.prepare(`SELECT id, status FROM approvals WHERE id = ?`).get('di-1') as { id: string; status: string } | undefined
      expect(row?.id).toBe('di-1')
      expect(row?.status).toBe('pending')

      // Read through a fresh store on the SAME closure: same row.
      const sameView = new ApprovalStore({ getDb: () => customDb, log: noopLog })
      expect(sameView.get('di-1')?.id).toBe('di-1')
    } finally {
      customDb.close()
    }
  })

  // ---- T12 -----------------------------------------------------------------
  // Free-fn shim delegates to the module-singleton after
  // initDatabase(':memory:'). The module-singleton's `getDb` accessor
  // resolves the LIVE module-level `db` on every call, so a write through
  // the shim is observable through `getApproval` afterwards.
  it('T12: free-fn shim delegates to the module-singleton after initDatabase', async () => {
    const dbModule = await import('../db.js')

    dbModule.initDatabase(':memory:')

    expect(dbModule.listApprovals({}).length).toBe(0)

    dbModule.createApproval({
      id: 'shim-1',
      agent_id: 'a',
      category: 'c',
      action_description: 'd',
    })

    expect(dbModule.listApprovals({}).length).toBe(1)
    expect(dbModule.getApproval('shim-1')?.id).toBe('shim-1')

    dbModule.getDb().close()
  })

  // ---- T13 -----------------------------------------------------------------
  // DbClient.open(':memory:') + ApprovalStore end-to-end round-trip. Real
  // production factory used to create the handle, and a new ApprovalStore
  // built on top of it via a closure. End-to-end create + get + resolve +
  // expireTimedOut round-trip with concrete ids proves the DI seam matches
  // production wiring.
  it('T13: DbClient.open(":memory:") + ApprovalStore end-to-end round-trip', async () => {
    const dbModule = await import('../db.js')
    const cfgModule = await import('../config.js')
    const client = dbModule.DbClient.open(
      { STORE_DIR: cfgModule.STORE_DIR, DB_FILENAME: cfgModule.DB_FILENAME, PROJECT_ROOT: cfgModule.PROJECT_ROOT },
      noopLog,
      ':memory:',
    )
    const diStore = new ApprovalStore({ getDb: () => client.getHandle(), log: noopLog })

    // create
    const created = diStore.create({
      id: 'e2e-1',
      agent_id: 'a',
      category: 'c',
      action_description: 'd',
    })
    expect(created.status).toBe('pending')

    // get
    expect(diStore.get('e2e-1')?.id).toBe('e2e-1')

    // resolve
    expect(diStore.resolve('e2e-1', 'approved', 'me', 42001)).toBe(true)
    expect(diStore.get('e2e-1')?.status).toBe('approved')

    // expireTimedOut: insert a past-timeout pending row to confirm
    // the singleton's getDb accessor resolves the live handle.
    const now = Math.floor(Date.now() / 1000)
    client.getHandle().prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('e2e-past', 'a', 'c', 'd', 'pending', 100, now - 100)
    expect(diStore.expireTimedOut()).toBe(1)
    expect(diStore.get('e2e-past')?.status).toBe('timeout')

    client.getHandle().close()
  })

  // ---- T14 -----------------------------------------------------------------
  // Cross-form regression: the same write sequence executed once via the
  // free-fn shim (createApproval / getApproval / resolveApproval /
  // listApprovals / expireTimedOutApprovals) and once via the class method
  // (store.create / store.get / store.resolve / store.list /
  // store.expireTimedOut) on the SAME :memory: handle must produce the SAME
  // row snapshot at every step. If the shim and class-method implementations
  // diverged (e.g. shim returns from a cached snapshot, class hits the DB),
  // this assertion would surface a mismatch.
  it('T14: free-fn shim and class method produce identical snapshots on the same handle', async () => {
    const dbModule = await import('../db.js')
    dbModule.initDatabase(':memory:')

    // Class-side store (closure over getDb so it sees the same handle)
    const classStore = new ApprovalStore({ getDb: () => dbModule.getDb(), log: noopLog })

    // 1) create via shim -> both views see it
    dbModule.createApproval({
      id: 'cross-1',
      agent_id: 'a',
      category: 'c',
      action_description: 'd',
    })
    const afterCreateShim = dbModule.listApprovals({})
    const afterCreateClass = classStore.list({})
    expect(afterCreateShim).toEqual(afterCreateClass)
    expect(afterCreateShim[0].id).toBe('cross-1')

    // 2) resolve via class method -> shim view sees the new value
    expect(classStore.resolve('cross-1', 'approved', 'me', 42001)).toBe(true)
    const afterResolveShim = dbModule.getApproval('cross-1')
    const afterResolveClass = classStore.get('cross-1')
    expect(afterResolveShim).toEqual(afterResolveClass)
    expect(afterResolveShim?.status).toBe('approved')
    expect(afterResolveShim?.telegram_message_id).toBe(42001)

    // 3) expireTimedOut via shim -> class view sees the flip
    const now = Math.floor(Date.now() / 1000)
    dbModule.getDb().prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at, timeout_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('cross-past', 'a', 'c', 'd', 'pending', 100, now - 100)
    expect(dbModule.expireTimedOutApprovals()).toBe(1)
    expect(dbModule.getApproval('cross-past')?.status).toBe('timeout')
    expect(classStore.get('cross-past')?.status).toBe('timeout')

    dbModule.getDb().close()
  })

  // ---- T15 -----------------------------------------------------------------
  // Schema CHECK constraint on `status` rejects invalid values (defensive).
  // Direct INSERT bypassing the class method proves the schema is wired
  // through the constructor's `getDb` closure (the test handle is the
  // same one the class methods see). A throw here also proves the
  // `getDb()` accessor resolves a real, schema-constrained handle.
  it('T15: schema CHECK constraint on status rejects invalid values', () => {
    expect(() => {
      db.prepare(`INSERT INTO approvals (id, agent_id, category, action_description, status, requested_at) VALUES (?, ?, ?, ?, ?, ?)`)
        .run('bad', 'a', 'c', 'd', 'garbage', 100)
    }).toThrow()
  })
})