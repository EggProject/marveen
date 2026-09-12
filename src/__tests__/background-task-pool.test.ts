// Tests for the class form invariants of src/db.ts BackgroundTaskPool cluster.
//
// The free-function form (createBackgroundTaskAtomic / getRunningBackgroundTasks /
// finishBackgroundTask / getBackgroundTasks / getBackgroundTask /
// countRunningBackgroundTasks / markOrphanedTasksFailed) is covered by the
// pre-existing src/__tests__/db-100.test.ts 'background tasks' describe block
// (which imports the free functions via the shim path) and by the 16 call sites
// in src/web/routes/background-tasks.ts. This file adds it() blocks that
// specifically exercise the BackgroundTaskPool class; each block states its
// own intent in its it() title.
//
// Sandbox: each class-only test creates its own `new Database(':memory:')` via
// the makeStore() helper, then constructs `new BackgroundTaskPool({ getDb: () => db })`
// with a closure that resolves the live handle on every method invocation.
// This mirrors the module-singleton's `new BackgroundTaskPool()` shape (which
// defaults deps to the module-level getDb) while giving each test a fresh,
// isolated schema.

import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { Database } from 'bun:sqlite'
import type { BackgroundTaskPool as BackgroundTaskPoolType } from '../db.js'

let BackgroundTaskPool: typeof BackgroundTaskPoolType

beforeAll(async () => {
  const mod = await import('../db.js')
  BackgroundTaskPool = mod.BackgroundTaskPool
})

// Mirror of the production schema (src/db.ts background_tasks migration block).
// The CHECK constraint mirrors the running/done/failed/timeout enum.
function makeStore(): { db: Database; pool: BackgroundTaskPoolType } {
  const db = new Database(':memory:')
  db.prepare(`
    CREATE TABLE background_tasks (
      id TEXT PRIMARY KEY,
      agent_id TEXT NOT NULL,
      prompt TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'running' CHECK(status IN ('running','done','failed','timeout')),
      tmux_session TEXT,
      started_at INTEGER NOT NULL,
      finished_at INTEGER,
      output TEXT
    )
  `).run()
  const pool = new BackgroundTaskPool({ getDb: () => db })
  return { db, pool }
}

describe('BackgroundTaskPool', () => {
  let db: Database
  let pool: BackgroundTaskPoolType

  beforeEach(() => {
    const ctx = makeStore()
    db = ctx.db
    pool = ctx.pool
  })

  afterEach(() => {
    db.close()
  })

  // ---- Default constructor singleton wiring -------------------------------

  // The zero-arg constructor resolves `getDb` to the module-level singleton.
  // The equivalence test below (and the shim-writes-through test further
  // down) already exercise the singleton path with assertions on rows; this
  // test verifies the singleton route specifically — i.e., a no-arg
  // `new BackgroundTaskPool()` must write to the SAME handle as getDb().
  // A no-op constructor that left `getDb` undefined would throw
  // "this.getDb is not a function" on the createAtomic call.
  it('default constructor resolves getDb to the module singleton', async () => {
    const dbModule = await import('../db.js')
    dbModule.initDatabase(':memory:')
    const pool = new BackgroundTaskPool()
    const row = pool.createAtomic('singleton-1', 's-agent', 'p', 'tmux', 5)
    expect(row?.id).toBe('singleton-1')
    expect(dbModule.getBackgroundTask('singleton-1')?.id).toBe('singleton-1')
    dbModule.getDb().close()
  })

  // ---- createAtomic -------------------------------------------------------

  // Fresh insert: returns the row with the exact field shape. A no-op
  // createAtomic that returned null would fail the not.toBeNull() check;
  // one that returned the wrong field values would fail the per-field
  // toBe assertions. started_at is checked via typeof to avoid the
  // expect.any(Number) matcher tripping @typescript-eslint/no-unsafe-assignment.
  it('createAtomic returns the inserted row for a fresh agent', () => {
    const result = pool.createAtomic('bt-1', 'a1', 'do work', 'tmux-1', 5)
    expect(result).not.toBeNull()
    expect(result?.id).toBe('bt-1')
    expect(result?.agent_id).toBe('a1')
    expect(result?.prompt).toBe('do work')
    expect(result?.status).toBe('running')
    expect(result?.tmux_session).toBe('tmux-1')
    expect(typeof result?.started_at).toBe('number')
    expect(result?.finished_at).toBeNull()
    expect(result?.output).toBeNull()
  })

  // Boundary case: maxConcurrent=0 makes the function short-circuit because
  // 0 running tasks already meets the cap. The positive control (cap=1,
  // 0 running) is asserted first so a no-op `() => null` stub cannot pass
  // — the toBeNull() assertion on cap=1 would fail the positive control
  // and the not.toBeNull() on cap=1 would fail the negative side.
  it('createAtomic returns null when maxConcurrent is zero, succeeds when cap >= running', () => {
    expect(pool.createAtomic('bt-positive', 'a0', 'p', 'tmux', 1)).not.toBeNull()
    expect(pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 0)).toBeNull()
  })

  // Concurrent-cap transaction test (load-bearing invariant per A.3
  // roadmap). maxConcurrent=1: first call succeeds, second returns null.
  // A no-op createAtomic that skipped the SELECT COUNT check would return
  // both rows and fail the second toBeNull() check.
  it('createAtomic with maxConcurrent=1 returns null on the second call (transactional cap)', () => {
    const first = pool.createAtomic('bt-1', 'a1', 'p1', 'tmux', 1)
    expect(first).not.toBeNull()
    expect(first?.id).toBe('bt-1')

    const second = pool.createAtomic('bt-2', 'a1', 'p2', 'tmux', 1)
    expect(second).toBeNull()
  })

  // The cap is per-agent: agent-a hits maxConcurrent=1 and is blocked,
  // agent-b is unaffected. A no-op createAtomic that used a global COUNT
  // (no agent_id filter) would return null for agent-b too.
  it('createAtomic cap is scoped per-agent', () => {
    expect(pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 1)).not.toBeNull()
    expect(pool.createAtomic('bt-2', 'a1', 'p', 'tmux', 1)).toBeNull()
    expect(pool.createAtomic('bt-3', 'a2', 'p', 'tmux', 1)).not.toBeNull()
  })

  // ---- getRunning ---------------------------------------------------------

  // Empty store: returns []. Paired with the positive control below so the
  // always-() => [] gut is caught.
  it('getRunning returns [] when no tasks are running', () => {
    expect(pool.getRunning()).toEqual([])
  })

  // After one createAtomic: exactly that row, in order. A no-op that
  // returned the wrong shape would fail toEqual.
  it('getRunning returns the one running task after createAtomic', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    const rows = pool.getRunning()
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('bt-1')
    expect(rows[0]?.status).toBe('running')
  })

  // ---- finish -------------------------------------------------------------

  // After finish('done'), the row's status flips and finished_at is set.
  // A no-op finish that skipped the UPDATE would leave status='running'
  // and fail the toBe('done') assertion.
  it('finish transitions status to the supplied value and sets finished_at', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    pool.finish('bt-1', 'done', 'output text')
    const row = pool.get('bt-1')
    expect(row?.status).toBe('done')
    expect(row?.output).toBe('output text')
    expect(row?.finished_at).toBeTypeOf('number')
  })

  // The three possible terminal statuses are all wired. A no-op finish that
  // hard-coded 'done' would fail one of these toBe assertions.
  it('finish accepts done, failed, and timeout status values', () => {
    pool.createAtomic('bt-d', 'a1', 'p', 'tmux', 5)
    pool.createAtomic('bt-f', 'a1', 'p', 'tmux', 5)
    pool.createAtomic('bt-t', 'a1', 'p', 'tmux', 5)
    pool.finish('bt-d', 'done', null)
    pool.finish('bt-f', 'failed', 'boom')
    pool.finish('bt-t', 'timeout', null)
    expect(pool.get('bt-d')?.status).toBe('done')
    expect(pool.get('bt-f')?.status).toBe('failed')
    expect(pool.get('bt-t')?.status).toBe('timeout')
  })

  // ---- list ---------------------------------------------------------------

  // agentId supplied + includeFinished=false: returns only running rows
  // for that agent. A no-op list that ignored agentId would leak rows
  // from other agents and fail the toHaveLength(1) check.
  it('list(agentId, false) returns only running rows for that agent', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    pool.createAtomic('bt-2', 'a2', 'p', 'tmux', 5)
    pool.finish('bt-1', 'done', 'x')
    const rows = pool.list('a1', false)
    expect(rows).toEqual([])
    const rows2 = pool.list('a1', true)
    expect(rows2).toHaveLength(1)
    expect(rows2[0]?.id).toBe('bt-1')
  })

  // agentId supplied + includeFinished=true: includes terminal rows too.
  // A no-op that hard-coded includeFinished=false would fail this.
  it('list(agentId, true) includes finished rows for that agent', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    pool.finish('bt-1', 'done', 'x')
    const rows = pool.list('a1', true)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.status).toBe('done')
  })

  // agentId omitted + includeFinished=false: returns all running rows
  // across agents. A no-op that filtered by some default agent would
  // fail the toHaveLength(2) check.
  it('list(undefined, false) returns all running rows across agents', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    pool.createAtomic('bt-2', 'a2', 'p', 'tmux', 5)
    pool.finish('bt-1', 'done', 'x')
    const rows = pool.list(undefined, false)
    expect(rows).toHaveLength(1)
    expect(rows[0]?.id).toBe('bt-2')
  })

  // agentId omitted + includeFinished=true: returns everything.
  it('list(undefined, true) returns all rows including finished', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    pool.createAtomic('bt-2', 'a2', 'p', 'tmux', 5)
    pool.finish('bt-1', 'done', 'x')
    const rows = pool.list(undefined, true)
    expect(rows).toHaveLength(2)
  })

  // ---- get ----------------------------------------------------------------

  // Known id: returns the row. Unknown id: returns undefined (not null).
  it('get returns the row for a known id and undefined for an unknown id', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    expect(pool.get('bt-1')?.id).toBe('bt-1')
    expect(pool.get('nonexistent')).toBeUndefined()
  })

  // ---- countRunning -------------------------------------------------------

  // Zero on a fresh agent, N after N inserts. A no-op countRunning that
  // ignored agent_id would return the global count and fail the toBe(2) check.
  it('countRunning returns 0 when empty, N after N inserts for that agent', () => {
    expect(pool.countRunning('a1')).toBe(0)
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    pool.createAtomic('bt-2', 'a1', 'p', 'tmux', 5)
    expect(pool.countRunning('a1')).toBe(2)
    expect(pool.countRunning('a2')).toBe(0)
  })

  // Decrements after finish. A no-op countRunning that did not re-evaluate
  // would still return 2.
  it('countRunning drops to 0 after finish transitions a row to a terminal status', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    expect(pool.countRunning('a1')).toBe(1)
    pool.finish('bt-1', 'done', 'x')
    expect(pool.countRunning('a1')).toBe(0)
  })

  // ---- markOrphaned -------------------------------------------------------

  // After createAtomic succeeds, markOrphaned returns the count (1) and the
  // row's status becomes 'failed' with output '(orphaned on restart)'. A
  // no-op markOrphaned that skipped the UPDATE would fail both assertions.
  it('markOrphaned fails all running tasks and returns the affected count', () => {
    pool.createAtomic('bt-1', 'a1', 'p', 'tmux', 5)
    pool.createAtomic('bt-2', 'a2', 'p', 'tmux', 5)

    const closed = pool.markOrphaned()
    expect(closed).toBe(2)

    expect(pool.get('bt-1')?.status).toBe('failed')
    expect(pool.get('bt-1')?.output).toBe('(orphaned on restart)')
    expect(pool.get('bt-2')?.status).toBe('failed')
    expect(pool.getRunning()).toEqual([])
  })

  // ---- free-function wrapper compatibility ---------------------------------

  // The seven module-level wrappers must wire through to the live
  // module-singleton after initDatabase(':memory:'). Without this assertion,
  // a no-op stub `function createBackgroundTaskAtomic() { return null }`
  // would pass the per-class tests but fail here, because list would
  // return [] (no row was inserted). Production callers in
  // src/web/routes/background-tasks.ts and src/web.ts rely on the shim
  // writing to the same handle the rest of the module sees.
  it('the seven free-fn shims write through the module-singleton after initDatabase', async () => {
    const dbModule = await import('../db.js')
    dbModule.initDatabase(':memory:')

    expect(dbModule.createBackgroundTaskAtomic('shim-1', 's-agent', 'p', 'tmux', 5)?.id).toBe('shim-1')
    expect(dbModule.getRunningBackgroundTasks()).toHaveLength(1)

    dbModule.finishBackgroundTask('shim-1', 'done', 'shim-output')

    const listed = dbModule.getBackgroundTasks('s-agent', true)
    expect(listed).toHaveLength(1)
    expect(listed[0]?.status).toBe('done')

    expect(dbModule.getBackgroundTasks('s-agent', false)).toEqual([])
    expect(dbModule.getBackgroundTasks(undefined, true)).toHaveLength(1)
    expect(dbModule.getBackgroundTasks()).toEqual([])

    expect(dbModule.getBackgroundTask('shim-1')?.output).toBe('shim-output')
    expect(dbModule.countRunningBackgroundTasks('s-agent')).toBe(0)

    dbModule.createBackgroundTaskAtomic('shim-2', 's-agent', 'p2', 'tmux', 5)
    expect(dbModule.markOrphanedTasksFailed()).toBe(1)

    dbModule.getDb().close()
  })

  // ---- equivalence: free-fn vs. class method ------------------------------

  // For each of the 7 methods, the free-fn (via the module-singleton) MUST
  // return byte-identical results to the class method on the SAME handle.
  // This catches future drift between the shim body and the class body.
  // Init with the production schema so the module-level singleton sees a
  // real table.
  it('free-fn shims return byte-identical results to the class methods on the same handle', async () => {
    const dbModule = await import('../db.js')
    dbModule.initDatabase(':memory:')

    const live = new BackgroundTaskPool({ getDb: () => dbModule.getDb() })

    // createAtomic
    const liveCreate = live.createAtomic('eq-1', 'eq-agent', 'eq-prompt', 'eq-tmux', 5)
    const shimCreate = dbModule.createBackgroundTaskAtomic('eq-2', 'eq-agent', 'eq-prompt', 'eq-tmux', 5)
    expect(shimCreate?.id).toBe('eq-2')
    expect(liveCreate?.id).toBe('eq-1')
    // Both share structure (status, agent_id, etc.), differ only on id+started_at
    expect(shimCreate?.status).toBe(liveCreate?.status)
    expect(shimCreate?.agent_id).toBe(liveCreate?.agent_id)

    // getRunning
    expect(dbModule.getRunningBackgroundTasks()).toEqual(live.getRunning())

    // finish
    dbModule.finishBackgroundTask('eq-1', 'done', 'shim')
    live.finish('eq-2', 'done', 'class')
    expect(dbModule.getBackgroundTask('eq-1')?.output).toBe('shim')
    expect(live.get('eq-2')?.output).toBe('class')

    // list (with agentId)
    expect(dbModule.getBackgroundTasks('eq-agent', true)).toEqual(live.list('eq-agent', true))
    expect(dbModule.getBackgroundTasks('eq-agent', false)).toEqual(live.list('eq-agent', false))

    // list (no agentId)
    expect(dbModule.getBackgroundTasks(undefined, true)).toEqual(live.list(undefined, true))
    expect(dbModule.getBackgroundTasks()).toEqual(live.list())

    // get
    expect(dbModule.getBackgroundTask('eq-1')).toEqual(live.get('eq-1'))

    // countRunning
    expect(dbModule.countRunningBackgroundTasks('eq-agent')).toBe(live.countRunning('eq-agent'))

    // markOrphaned -- both should agree on the count (0 here, no running rows)
    expect(dbModule.markOrphanedTasksFailed()).toBe(live.markOrphaned())

    dbModule.getDb().close()
  })
})
