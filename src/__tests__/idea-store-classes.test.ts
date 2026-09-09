// Tests for the class form invariants of src/db.ts:1634 IdeaStore cluster.
//
// The free-function form (listIdeas / createIdea / updateIdea / ...) is
// covered by src/__tests__/db-100.test.ts idea_box / comments + status log +
// revert describe blocks. This file adds 15 it() blocks per the plan that
// specifically exercise the IdeaStore class:
//
//   1. list() default order (created_at DESC, no filter)
//   2. list() status filter
//   3. create() round-trip (timestamps stamped + row persisted)
//   4. update() patch fields (all 7 patchable fields round-trip)
//   5. update() missing id returns false; existing id returns true
//   6. delete() idempotent (true then false)
//   7. categories() DISTINCT sorted
//   8. addComment() bumps parent idea's updated_at
//   9. comments() ASC order
//   10. statusLog() preserves from/to/actor/note for both rows
//   11. revertFromKanban() flips status, nulls kanban_id, appends log row
//   12. Per-instance isolation (two IdeaStores on independent :memory: handles)
//   13. Shim path: free-fn shim delegates to the module-singleton after
//       initDatabase(':memory:') is called
//   14. DbClient.open(':memory:') end-to-end integration (create→list→
//       update→delete with concrete id round-trip)
//   15. Cross-form regression: free-fn shim and class method produce the
//       same row snapshot for the same write sequence on the same DB handle
//
// Sandbox: each test creates its own `new Database(':memory:')` via the
// createSchema() helper, then constructs `new IdeaStore(() => db, noopLog)`
// with a closure that resolves the live handle on every method invocation.
// This mirrors the module-singleton's `new IdeaStore(getDb, logger)` shape
// while giving each test a fresh, isolated schema.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import { runScript } from '../db/sqlite.js'
import type { LoggerLike } from '../logger.js'
import type { IdeaStore as IdeaStoreType } from '../db.js'

let IdeaStore: typeof IdeaStoreType

beforeAll(async () => {
  const mod = await import('../db.js')
  IdeaStore = mod.IdeaStore
})

function noopLog(): LoggerLike {
  return {
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    debug: () => undefined,
  } as unknown as LoggerLike
}

// Mirror of the production schema (src/db.ts:3070-3115) so the class methods
// see the same CHECK constraints + impact/effort columns + indexes they would
// on the live store. impact/effort are added via ALTER in production (post-
// release columns); we replicate the same idempotent ALTER shape here so the
// test schema matches the production migration end-state.
function createSchema(db: Database): void {
  runScript(db, `
    CREATE TABLE IF NOT EXISTS idea_box (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      category TEXT NOT NULL DEFAULT 'Egyéb',
      status TEXT NOT NULL DEFAULT 'new' CHECK(status IN ('new','reviewed','kanban','rejected')),
      source TEXT NOT NULL DEFAULT 'marveen',
      kanban_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `)
  runScript(db, `CREATE INDEX IF NOT EXISTS idx_idea_box_status ON idea_box(status)`)
  runScript(db, `CREATE INDEX IF NOT EXISTS idx_idea_box_category ON idea_box(category)`)
  try { runScript(db, 'ALTER TABLE idea_box ADD COLUMN impact INTEGER') } catch { /* already exists */ }
  try { runScript(db, 'ALTER TABLE idea_box ADD COLUMN effort INTEGER') } catch { /* already exists */ }
  runScript(db, `
    CREATE TABLE IF NOT EXISTS idea_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id TEXT NOT NULL,
      author TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `)
  runScript(db, `CREATE INDEX IF NOT EXISTS idx_idea_comments_idea ON idea_comments(idea_id)`)
  runScript(db, `
    CREATE TABLE IF NOT EXISTS idea_status_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      idea_id TEXT NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      actor TEXT NOT NULL DEFAULT 'system',
      note TEXT,
      created_at INTEGER NOT NULL
    )
  `)
  runScript(db, `CREATE INDEX IF NOT EXISTS idx_idea_status_log_idea ON idea_status_log(idea_id, created_at)`)
}

function makeStore(): { store: IdeaStoreType; db: Database } {
  const db = new Database(':memory:')
  createSchema(db)
  const store = new IdeaStore(() => db, noopLog())
  return { store, db }
}

function ideaFixture(overrides: Partial<{
  id: string
  title: string
  description: string | null
  category: string
  status: 'new' | 'reviewed' | 'kanban' | 'rejected'
  source: string
  kanban_id: string | null
  impact: number | null
  effort: number | null
}> = {}): Omit<import('../db.js').IdeaBoxRow, 'created_at' | 'updated_at'> {
  return {
    id: overrides.id ?? 'i-1',
    title: overrides.title ?? 'title',
    description: overrides.description ?? null,
    category: overrides.category ?? 'Egyéb',
    status: overrides.status ?? 'new',
    source: overrides.source ?? 'test',
    kanban_id: overrides.kanban_id ?? null,
    impact: overrides.impact ?? null,
    effort: overrides.effort ?? null,
  }
}

describe('IdeaStore class form', () => {
  let store: IdeaStoreType
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
  // list() with no filter orders by created_at DESC. Insert 3 rows with
  // distinct timestamps via direct SQL (the IdeaStore has no clock-control
  // API); then list() must return them in newest-first order with concrete
  // ids. If the ORDER BY were dropped or reversed, the assertion would fail.
  it('T1: list() default order is created_at DESC, no filter', () => {
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-1', 'a', 'A', 'new', 'me', 100, 100)
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-2', 'b', 'A', 'new', 'me', 200, 200)
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-3', 'c', 'A', 'new', 'me', 300, 300)

    const rows = store.list()
    expect(rows.map(r => r.id)).toEqual(['i-3', 'i-2', 'i-1'])
  })

  // ---- T2 ------------------------------------------------------------------
  // list({status}) filter. Mixed-status fixtures; only matching rows
  // returned. If the WHERE clause were dropped, all 3 rows would come back.
  it('T2: list({status}) returns only rows with matching status', () => {
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-1', 'a', 'A', 'new', 'me', 100, 100)
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-2', 'b', 'A', 'reviewed', 'me', 200, 200)
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-3', 'c', 'A', 'new', 'me', 300, 300)

    const rows = store.list({ status: 'new' })
    expect(rows.length).toBe(2)
    expect(rows.map(r => r.id).sort()).toEqual(['i-1', 'i-3'])
  })

  // ---- T3 ------------------------------------------------------------------
  // create() round-trip: timestamps stamped by the implementation, persisted
  // to the row, equal to each other, and within 1s of "before". Reading
  // back via list() proves the INSERT actually persisted (not just returned).
  it('T3: create() stamps created_at = updated_at and persists the row', () => {
    const before = Math.floor(Date.now() / 1000)
    store.create(ideaFixture({ id: 'i-1', title: 'a' }))
    const after = Math.floor(Date.now() / 1000)

    const rows = store.list()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('i-1')
    expect(rows[0].created_at).toBe(rows[0].updated_at)
    expect(rows[0].created_at).toBeGreaterThanOrEqual(before)
    expect(rows[0].created_at).toBeLessThanOrEqual(after)
  })

  // ---- T4 ------------------------------------------------------------------
  // update() patches all 7 patchable fields. Each field gets its own
  // distinct value; the assertion checks each one individually so a
  // regression that drops ANY field would surface as a concrete mismatch.
  it('T4: update() patches every patchable field', () => {
    store.create(ideaFixture({ id: 'i-1', title: 'old', category: 'A', status: 'new', kanban_id: null, impact: null, effort: null }))

    const ok = store.update('i-1', {
      title: 'new',
      description: 'desc',
      category: 'B',
      status: 'reviewed',
      kanban_id: 'k-1',
      impact: 5,
      effort: 9,
    })
    expect(ok).toBe(true)

    const rows = store.list()
    expect(rows.length).toBe(1)
    expect(rows[0].title).toBe('new')
    expect(rows[0].description).toBe('desc')
    expect(rows[0].category).toBe('B')
    expect(rows[0].status).toBe('reviewed')
    expect(rows[0].kanban_id).toBe('k-1')
    expect(rows[0].impact).toBe(5)
    expect(rows[0].effort).toBe(9)
  })

  // ---- T5 ------------------------------------------------------------------
  // update() missing id returns false (negative case); existing id returns
  // true (positive case). Both halves are load-bearing: a no-op constant
  // `true` would pass the missing-id test; a no-op constant `false` would
  // pass the existing-id test.
  it('T5: update() returns false for missing id, true for existing id', () => {
    store.create(ideaFixture({ id: 'i-1', title: 'a' }))

    // T5a -- negative case
    expect(store.update('nope', { title: 'X' })).toBe(false)

    // T5b -- positive case (proves the false wasn't from a no-op)
    expect(store.update('i-1', { title: 'b' })).toBe(true)
  })

  // ---- T6 ------------------------------------------------------------------
  // delete() is idempotent at the boolean level: first call true, second
  // false. Reading back via list() (length 0) proves the DELETE actually
  // removed the row, not just returned a boolean without doing the work.
  it('T6: delete() returns true then false for the same id; row is gone', () => {
    store.create(ideaFixture({ id: 'i-1', title: 'a' }))
    expect(store.delete('i-1')).toBe(true)
    expect(store.list().length).toBe(0)
    expect(store.delete('i-1')).toBe(false)
  })

  // ---- T7 ------------------------------------------------------------------
  // categories() returns DISTINCT values sorted ASC. Three rows across two
  // categories; the result must collapse duplicates AND sort. A regression
  // that dropped DISTINCT would return 3 rows; one that dropped ORDER BY
  // could still pass length but fail the sorted content check.
  it('T7: categories() returns DISTINCT categories sorted ASC', () => {
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-1', 'a', 'B', 'new', 'me', 100, 100)
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-2', 'b', 'C', 'new', 'me', 200, 200)
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-3', 'c', 'B', 'new', 'me', 300, 300)

    expect(store.categories()).toEqual(['B', 'C'])
  })

  // ---- T8 ------------------------------------------------------------------
  // addComment() bumps the parent idea's updated_at. Snapshot the parent's
  // updated_at before the call; after the call the parent's updated_at
  // must be strictly greater. A regression that forgot the UPDATE on the
  // parent would leave the timestamp unchanged and fail this assertion.
  it('T8: addComment() bumps the parent idea updated_at', () => {
    store.create(ideaFixture({ id: 'i-1', title: 'a' }))
    const beforeUpdatedAt = store.list()[0].updated_at

    // Advance the clock so the parent update produces a strictly greater
    // timestamp. Real DBs use seconds resolution; one second is enough.
    const oneSecond = 1
    // Wait by spinning on Date.now in case of fast machines; we already
    // round to seconds so a setTimeout is the most reliable approach.
    // Use a synchronous sleep fallback for very fast clocks.
    const waitStart = Date.now()
    while (Date.now() - waitStart < (oneSecond + 0.05) * 1000) { /* spin */ }

    store.addComment('i-1', 'me', 'hello')
    const afterUpdatedAt = store.list()[0].updated_at

    expect(afterUpdatedAt).toBeGreaterThan(beforeUpdatedAt)
  })

  // ---- T9 ------------------------------------------------------------------
  // comments() returns rows ORDER BY created_at ASC. Two comments inserted
  // with explicit timestamps in reverse order; the result must come back
  // in chronological order, NOT insertion order.
  it('T9: comments() returns rows in created_at ASC order', () => {
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-1', 'a', 'A', 'new', 'me', 100, 100)
    // Insert comments in REVERSE chronological order to prove the ORDER BY
    // is doing the work, not just preserving insertion order.
    db.prepare(`INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)`).run('i-1', 'me', 'second', 200)
    db.prepare(`INSERT INTO idea_comments (idea_id, author, content, created_at) VALUES (?, ?, ?, ?)`).run('i-1', 'me', 'first', 100)

    const rows = store.comments('i-1')
    expect(rows.map(c => c.content)).toEqual(['first', 'second'])
  })

  // ---- T10 -----------------------------------------------------------------
  // statusLog() preserves all 5 columns (from_status / to_status / actor /
  // note) for both rows. The first log row has a NULL from_status (init)
  // and the second has a non-NULL from_status; both notes round-trip.
  it('T10: statusLog() preserves from/to/actor/note across multiple rows', () => {
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).run('i-1', 'a', 'A', 'new', 'me', 100, 100)

    store.logStatusChange('i-1', null, 'new', 'system', 'init')
    store.logStatusChange('i-1', 'new', 'reviewed', 'me', 'lgtm')

    const rows = store.statusLog('i-1')
    expect(rows.length).toBe(2)
    expect(rows[0].from_status).toBeNull()
    expect(rows[0].to_status).toBe('new')
    expect(rows[0].actor).toBe('system')
    expect(rows[0].note).toBe('init')
    expect(rows[1].from_status).toBe('new')
    expect(rows[1].to_status).toBe('reviewed')
    expect(rows[1].actor).toBe('me')
    expect(rows[1].note).toBe('lgtm')
  })

  // ---- T11 -----------------------------------------------------------------
  // revertFromKanban() flips a kanban-status idea back to 'reviewed',
  // nulls the kanban_id, and appends a status-log row with the
  // "Kanban card removed: <id>" note. Missing kanbanId returns null.
  it('T11: revertFromKanban() reverts status, nulls kanban_id, logs; missing returns null', () => {
    db.prepare(`INSERT INTO idea_box (id, title, category, status, source, kanban_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run('i-1', 'a', 'A', 'kanban', 'me', 'k-1', 100, 100)

    // T11a -- happy path: revert + log
    expect(store.revertFromKanban('k-1')).toBe('i-1')
    const idea = store.list()[0]
    expect(idea.status).toBe('reviewed')
    expect(idea.kanban_id).toBeNull()

    const log = store.statusLog('i-1')
    expect(log.length).toBe(1)
    expect(log[0].from_status).toBe('kanban')
    expect(log[0].to_status).toBe('reviewed')
    expect(log[0].actor).toBe('system')
    expect(log[0].note).toBe('Kanban card removed: k-1')

    // T11b -- missing kanban id: returns null, no side effects
    expect(store.revertFromKanban('nonexistent')).toBeNull()
    expect(store.statusLog('i-1').length).toBe(1)
  })

  // ---- T12 -----------------------------------------------------------------
  // Per-instance isolation: two IdeaStores on two different :memory: handles
  // do not see each other's writes. The free-fn form had a single module-
  // level `db` so this test would be impossible to express; the class form
  // gives each instance its own accessor closure.
  it('T12: per-instance isolation (two IdeaStores on independent :memory: handles)', () => {
    const ctxA = makeStore()
    const ctxB = makeStore()
    const storeA = ctxA.store
    const storeB = ctxB.store

    expect(storeA.list().length).toBe(0)
    expect(storeB.list().length).toBe(0)

    storeB.create(ideaFixture({ id: 'i-B', title: 'B' }))

    expect(storeA.list().length).toBe(0)
    expect(storeB.list().length).toBe(1)
    expect(storeB.list()[0].id).toBe('i-B')

    ctxA.db.close()
    ctxB.db.close()
  })

  // ---- T13 -----------------------------------------------------------------
  // Shim path: the free-fn shim (listIdeas / createIdea) delegates to the
  // module-singleton after initDatabase(':memory:'). The module-singleton's
  // `getDb` accessor resolves the LIVE module-level `db` on every call, so
  // a write through the shim is observable through listIdeas() afterwards.
  it('T13: free-fn shim delegates to the module-singleton after initDatabase', async () => {
    const dbModule = await import('../db.js')

    // Re-imported module may already have a singleton with a stale `db`
    // reference; initDatabase(':memory:') gives it a fresh handle.
    dbModule.initDatabase(':memory:')

    expect(dbModule.listIdeas().length).toBe(0)

    dbModule.createIdea({
      id: 'shim-1',
      title: 'shim test',
      description: null,
      category: 'A',
      status: 'new',
      source: 'shim',
      kanban_id: null,
      impact: null,
      effort: null,
    })

    expect(dbModule.listIdeas().length).toBe(1)
    expect(dbModule.listIdeas()[0].id).toBe('shim-1')

    // Cleanup: close the in-memory handle so other test files that import
    // the module see a clean slate.
    dbModule.getDb().close()
  })

  // ---- T14 -----------------------------------------------------------------
  // DbClient.open(':memory:') integration: the real production factory is
  // used to create the handle, and a new IdeaStore is built on top of it
  // via a closure. End-to-end create -> list -> update -> delete round-trip
  // with concrete ids proves the DI seam matches production wiring.
  it('T14: DbClient.open(":memory:") + IdeaStore end-to-end round-trip', async () => {
    const dbModule = await import('../db.js')
    const cfgModule = await import('../config.js')
    const client = dbModule.DbClient.open(
      { STORE_DIR: cfgModule.STORE_DIR, DB_FILENAME: cfgModule.DB_FILENAME, PROJECT_ROOT: cfgModule.PROJECT_ROOT },
      noopLog(),
      ':memory:',
    )
    const store = new IdeaStore(() => client.getHandle(), noopLog())

    // create
    store.create({
      id: 'e2e-1',
      title: 'e2e title',
      description: null,
      category: 'E2E',
      status: 'new',
      source: 'test',
      kanban_id: null,
      impact: null,
      effort: null,
    })

    // list
    let rows = store.list()
    expect(rows.length).toBe(1)
    expect(rows[0].id).toBe('e2e-1')
    expect(rows[0].status).toBe('new')

    // update
    expect(store.update('e2e-1', { status: 'reviewed', impact: 7 })).toBe(true)
    rows = store.list()
    expect(rows[0].status).toBe('reviewed')
    expect(rows[0].impact).toBe(7)

    // delete
    expect(store.delete('e2e-1')).toBe(true)
    expect(store.list().length).toBe(0)

    client.getHandle().close()
  })

  // ---- T15 -----------------------------------------------------------------
  // Cross-form regression: the same write sequence executed once via the
  // free-fn shim (listIdeas/createIdea/updateIdea/deleteIdea) and once via
  // the class method (store.list/store.create/store.update/store.delete)
  // on the SAME :memory: handle must produce the SAME row snapshot at
  // every step. If the shim and class-method implementations diverged
  // (e.g. shim returns from a cached snapshot, class hits the DB), this
  // assertion would surface a mismatch.
  it('T15: free-fn shim and class method produce identical snapshots on the same handle', async () => {
    const dbModule = await import('../db.js')
    dbModule.initDatabase(':memory:')

    // Class-side store (closure over getDb so it sees the same handle)
    const classStore = new IdeaStore(() => dbModule.getDb(), noopLog())

    // 1) create via shim -> both views see it
    dbModule.createIdea({
      id: 'cross-1',
      title: 'cross test',
      description: null,
      category: 'A',
      status: 'new',
      source: 'cross',
      kanban_id: null,
      impact: null,
      effort: null,
    })
    const afterCreateShim = dbModule.listIdeas()
    const afterCreateClass = classStore.list()
    expect(afterCreateShim).toEqual(afterCreateClass)
    expect(afterCreateShim[0].id).toBe('cross-1')

    // 2) update via class method -> shim view sees the new value
    expect(classStore.update('cross-1', { title: 'cross test v2' })).toBe(true)
    const afterUpdateShim = dbModule.listIdeas()
    const afterUpdateClass = classStore.list()
    expect(afterUpdateShim).toEqual(afterUpdateClass)
    expect(afterUpdateShim[0].title).toBe('cross test v2')

    // 3) delete via shim -> class view sees it gone
    expect(dbModule.deleteIdea('cross-1')).toBe(true)
    expect(dbModule.listIdeas().length).toBe(0)
    expect(classStore.list().length).toBe(0)

    dbModule.getDb().close()
  })
})