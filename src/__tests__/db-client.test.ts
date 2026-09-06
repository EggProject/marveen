// Tests for src/db.ts A.1 — class DbClient + getHandle() escape hatch.
//
// Each `it()` asserts a DbClient behaviour with a CONCRETE expected value
// against an in-memory or file-backed sqlite handle, NOT vacuous
// "is the class defined" assertions (per CLAUDE.md §8 "vacuous test"
// rule). If DbClient.query() were swapped for `return []`, every query
// assertion would fail. If DbClient.open() forgot to apply the WAL /
// cache_size / synchronous pragmas, the WAL close-reopen edge-case
// assertion would catch it.

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { DbClient } from '../db.js'
import { logger } from '../logger.js'
import { STORE_DIR, DB_FILENAME, PROJECT_ROOT } from '../config.js'

const config = { STORE_DIR, DB_FILENAME, PROJECT_ROOT }

// -- Migration injection (Commit 1 / Commit 2 tests) -----------------------
// Wrap runScript so individual tests can force a throw at a specific call
// count, then delegate back to the real impl for normal-call tests. Default
// behaviour is a pass-through so the existing tests in this file are
// unaffected.

const migrationInjection = vi.hoisted(() => ({ failAfter: -1, callCount: 0 }))

vi.mock('../db/sqlite.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../db/sqlite.js')>()
  return {
    ...actual,
    runScript: (db: unknown, sql: string) => {
      migrationInjection.callCount++
      if (migrationInjection.failAfter >= 0 && migrationInjection.callCount > migrationInjection.failAfter) {
        throw new Error(`injected migration failure at call ${migrationInjection.callCount}`)
      }
      return actual.runScript(db as never, sql)
    },
  }
})

beforeEach(() => {
  migrationInjection.failAfter = -1
  migrationInjection.callCount = 0
})

// -- Sandbox lifecycle ----------------------------------------------------

let tmpDir: string
beforeAll(() => {
  process.env.NODE_ENV = 'test'
  tmpDir = mkdtempSync(join(tmpdir(), 'marveen-db-client-'))
})
afterAll(() => {
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true })
})

// =========================================================================
// query<T>: thin wrapper around db.prepare(...).all(...)
// =========================================================================

describe('DbClient.query<T>', () => {
  it('SELECT 1 returns [{ n: 1 }]', () => {
    const client = DbClient.open(config, logger, ':memory:')
    expect(client.query<{ n: number }>('SELECT 1 as n')).toEqual([{ n: 1 }])
    client.close()
  })

  it('returns [] for a query with no matches', () => {
    const client = DbClient.open(config, logger, ':memory:')
    expect(client.query<{ id: number }>('SELECT 1 as id WHERE 1 = 0')).toEqual([])
    client.close()
  })

  it('passes params through to prepare.all(...)', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
    client.exec("INSERT INTO t (val) VALUES ('hello')")
    expect(client.query<{ val: string }>('SELECT val FROM t WHERE id = ?', [1])).toEqual([
      { val: 'hello' },
    ])
    client.close()
  })
})

// =========================================================================
// exec: thin wrapper around db.prepare(...).run(...)
// =========================================================================

describe('DbClient.exec', () => {
  it('CREATE TABLE does not throw', () => {
    const client = DbClient.open(config, logger, ':memory:')
    expect(() => client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')).not.toThrow()
    client.close()
  })

  it('INSERT ... VALUES passes params through', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
    expect(() => client.exec("INSERT INTO t (val) VALUES ('a')")).not.toThrow()
    const rows = client.query<{ val: string }>('SELECT val FROM t')
    expect(rows).toEqual([{ val: 'a' }])
    client.close()
  })
})

// =========================================================================
// transaction<T>: thin wrapper around db.transaction(fn)
// =========================================================================

describe('DbClient.transaction', () => {
  it('insert via transaction returns lastInsertRowid', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, val TEXT)')
    const id = client.transaction<number>(() => {
      const result = client.getHandle().prepare("INSERT INTO t (val) VALUES ('x')").run()
      return Number(result.lastInsertRowid)
    })
    expect(id).toBe(1)
    client.close()
  })

  it('rolls back on throw', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, val TEXT)')
    expect(() => {
      client.transaction(() => {
        client.exec("INSERT INTO t (val) VALUES ('a')")
        throw new Error('forced rollback')
      })
    }).toThrow('forced rollback')
    // The 'a' insert must have been rolled back.
    expect(client.query<{ val: string }>('SELECT val FROM t')).toEqual([])
    client.close()
  })
})

// =========================================================================
// getHandle: escape hatch for the 9 production getDb() callers
// =========================================================================

describe('DbClient.getHandle', () => {
  it('returns a Database instance', () => {
    const client = DbClient.open(config, logger, ':memory:')
    expect(client.getHandle()).toBeInstanceOf(Database)
    client.close()
  })

  it('returns the same instance on every call', () => {
    const client = DbClient.open(config, logger, ':memory:')
    expect(client.getHandle()).toBe(client.getHandle())
    client.close()
  })
})

// =========================================================================
// close + getHandle after close (handle unusable after close)
// =========================================================================

describe('DbClient.close lifecycle', () => {
  it('close() does not throw', () => {
    const client = DbClient.open(config, logger, ':memory:')
    expect(() => client.close()).not.toThrow()
  })

  it('getHandle() throws after close()', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.close()
    expect(() => client.getHandle().prepare('SELECT 1')).toThrow()
  })

  it('query() throws after close()', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.close()
    expect(() => client.query('SELECT 1')).toThrow()
  })

  it('exec() throws after close()', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.close()
    expect(() => client.exec('CREATE TABLE x (id INTEGER)')).toThrow()
  })

  it('transaction() throws after close()', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.close()
    expect(() => client.transaction(() => 1)).toThrow()
  })

  it('idempotent: a second close() does not throw', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.close()
    expect(() => client.close()).not.toThrow()
  })
})

// =========================================================================
// T2 P1 #4 — WAL close-reopen edge case (PRAGMA cache_size)
// =========================================================================
//
// open(':memory:') then set a custom cache_size, then close(), then
// open(':memory:') again -- the second open must RE-APPLY the default
// PRAGMAs (cache_size = -65536). If DbClient.open() skipped the PRAGMA
// pass on the second open (because it's "in memory", maybe), the
// custom cache_size would persist.

describe('DbClient.open WAL close-reopen edge case', () => {
  it('cache_size is back to -65536 after close() + open()', () => {
    const client = DbClient.open(config, logger, ':memory:')
    client.exec('PRAGMA cache_size = -1234')
    client.close()
    const second = DbClient.open(config, logger, ':memory:')
    const row = second.query<{ cache_size: number }>('PRAGMA cache_size')
    expect(row[0]?.cache_size).toBe(-65536)
    second.close()
  })

  it('file-backed: second open completes in <100ms (no WAL-busy deadlock)', () => {
    const dbPath = join(tmpDir, 'wal-reopen.db')
    const first = DbClient.open(config, logger, dbPath)
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    first.exec("INSERT INTO t DEFAULT VALUES")
    first.close()

    const start = Date.now()
    const second = DbClient.open(config, logger, dbPath)
    const duration = Date.now() - start
    expect(duration).toBeLessThan(100)
    // The second handle is live and usable.
    expect(second.query<{ c: number }>('SELECT COUNT(*) as c FROM t')).toEqual([{ c: 1 }])
    second.close()
  })
})

// =========================================================================
// T2 P0 #1 — re-init guard race (factory closes its OWN handle, NOT the
// module-singleton `db`). Two DbClient.open() calls on the same path,
// close between them; the second open must succeed.
// =========================================================================

describe('DbClient.open re-init (caller must close first)', () => {
  it('file-backed: close() + open() on the same path succeeds', () => {
    const dbPath = join(tmpDir, 'reinit.db')
    const first = DbClient.open(config, logger, dbPath)
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    expect(() => first.close()).not.toThrow()
    expect(() => DbClient.open(config, logger, dbPath)).not.toThrow()
  })

  it('memory: close() + open() on :memory: succeeds', () => {
    const first = DbClient.open(config, logger, ':memory:')
    expect(() => first.close()).not.toThrow()
    expect(() => DbClient.open(config, logger, ':memory:')).not.toThrow()
  })

  it('module-singleton `db` is untouched when only DbClient.open() is called', () => {
    // The 155 free functions close over the module-singleton `db`. A bare
    // DbClient.open() must NOT close that singleton. We can't read it from
    // outside, but we can prove the invariant: open a memory DbClient,
    // close it, then a NEW DbClient.open(':memory:') succeeds. If
    // DbClient.open() had accidentally closed the module singleton, every
    // subsequent free-function call in the suite would crash.
    const first = DbClient.open(config, logger, ':memory:')
    first.close()
    expect(() => DbClient.open(config, logger, ':memory:').close()).not.toThrow()
  })
})

// =========================================================================
// Module surface (DbClient is exported)
// =========================================================================

describe('module surface', () => {
  it('DbClient is exported as a class', () => {
    expect(typeof DbClient).toBe('function')
    expect(DbClient.name).toBe('DbClient')
  })

  it('class surface: query, exec, transaction, getHandle, close are instance methods', () => {
    const client = DbClient.open(config, logger, ':memory:')
    expect(typeof client.query).toBe('function')
    expect(typeof client.exec).toBe('function')
    expect(typeof client.transaction).toBe('function')
    expect(typeof client.getHandle).toBe('function')
    expect(typeof client.close).toBe('function')
    client.close()
  })

  it('class surface: open is a static method', () => {
    expect(typeof DbClient.open).toBe('function')
  })
})

// =========================================================================
// Commit 1 — Migration FD leak fix
// =========================================================================
//
// The raw SQLite handle is created at the top of DbClient.open and assigned
// to client.handle only at the very end of the migration block. Any throw
// between those two points (corrupted schema, bad migration data) used to
// leak the raw FD + file lock until process exit.
//
// The fix wraps the migration block in try/catch and closes the raw handle
// on throw. The behavioural assertion: after a throwing migration, a
// subsequent DbClient.open() on the same file path must succeed with no
// lock contention (the FD has been released).

describe('DbClient.open closes raw handle on migration throw', () => {
  it('second open() on the same file path succeeds after a migration throw', () => {
    const dbPath = join(tmpDir, 'fd-leak.db')
    // Force runScript to throw on the very first call. The throw happens
    // BEFORE client.handle is assigned, so the raw handle would leak
    // without the fix.
    migrationInjection.failAfter = 0

    // The first open() must propagate the injected error verbatim.
    expect(() => DbClient.open(config, logger, dbPath)).toThrow(
      /injected migration failure/,
    )

    // Reset injection so the second open() runs the real migration block.
    // With the FD leak fix, the raw handle was closed in the catch above;
    // the file lock is gone, so this open() succeeds and reaches
    // client.handle = handle.
    migrationInjection.failAfter = -1
    migrationInjection.callCount = 0
    const second = DbClient.open(config, logger, dbPath)
    expect(second.getHandle()).toBeInstanceOf(Database)
    // The second open is fully usable (pragma and migration completed).
    expect(second.query<{ n: number }>('SELECT 1 as n')).toEqual([{ n: 1 }])
    second.close()
  })

  it('Database.prototype.close is invoked exactly once on the raw handle when the migration throws', () => {
    // The catch block must call handle.close() to release the FD + file
    // lock. Spy on Database.prototype.close to count the invocations.
    const closeSpy = vi.spyOn(Database.prototype, 'close')
    try {
      const dbPath = join(tmpDir, 'fd-leak-spy.db')
      migrationInjection.failAfter = 0

      expect(() => DbClient.open(config, logger, dbPath)).toThrow(
        /injected migration failure/,
      )

      // Exactly one close call: the raw handle from the first (failing)
      // open(). If the fix were absent, closeSpy would have 0 calls.
      expect(closeSpy).toHaveBeenCalledTimes(1)
    } finally {
      closeSpy.mockRestore()
    }
  })
})

// =========================================================================
// Commit 2 — migrateTaskRunsFromJson race fix (mkdir-based file lock)
// =========================================================================
//
// Pre-existing race: two parallel DbClient.open() calls on a fresh install
// both passed the existingCount > 0 early-return and both inserted the
// same rows (task_runs has no UNIQUE constraint on (name, agent, ts)).
//
// The fix serializes the migration with a mkdir-based file lock. The lock
// dir is `<STORE_DIR>/.task_runs_migrate.lock` and contains a `pid` file;
// if the holder is dead, the lock is taken over (stale-lock detection).
// mkdir is atomic on POSIX (returns EEXIST if the dir already exists).
//
// Tests:
//   1. Parallel open() calls produce exactly N rows (no duplicates)
//   2. A held lock prevents the second open() from migrating
//   3. After successful open(), the lock dir is gone (released)
//   4. A stale lock (dead PID) is taken over

describe('DbClient.open serialize migrateTaskRunsFromJson with file lock', () => {
  // Helper: a per-test isolated STORE_DIR so the lock dir and JSON file
  // don't collide with other tests or the real production store.
  function setupRaceSandbox(label: string): { storeDir: string; dbPath: string; legacyPath: string } {
    const storeDir = mkdtempSync(join(tmpdir(), `marveen-race-${label}-`))
    const dbPath = join(storeDir, 'race.db')
    const legacyPath = join(storeDir, 'task-run-history.json')
    writeFileSync(
      legacyPath,
      JSON.stringify([
        { name: `${label}-a`, agent: 'agent-1', ts: 1 },
        { name: `${label}-b`, agent: 'agent-2', ts: 2 },
        { name: `${label}-c`, agent: 'agent-3', ts: 3 },
      ]),
    )
    return { storeDir, dbPath, legacyPath }
  }

  it('two parallel open() calls produce exactly N rows (multi-process)', async () => {
    // Fresh DB + JSON with 2 rows. Two child processes call DbClient.open
    // on the same path concurrently; the mkdir-based lock ensures only
    // one migrates. This test FAILS if the lock is removed (both children
    // would pass the existingCount > 0 check and double-insert).
    const storeDir = mkdtempSync(join(tmpdir(), 'marveen-race-parallel-'))
    const dbPath = join(storeDir, 'race.db')
    const lockDir = join(storeDir, '.task_runs_migrate.lock')
    try {
      writeFileSync(
        join(storeDir, 'task-run-history.json'),
        JSON.stringify([
          { name: 'p-a', agent: 'agent-1', ts: 10 },
          { name: 'p-b', agent: 'agent-2', ts: 20 },
        ]),
      )

      // Pre-initialize the .db file in the parent process: DbClient.open()
      // constructs `new Database(dbPath, { strict: true })` which throws
      // SQLITE_CANTOPEN if the file does not exist. Without this pre-init
      // step, the first child process's Database constructor throws before
      // the mkdir lock can even be tested. Pre-create the .db file with
      // strict: false (does NOT run the migration or apply pragmas) so
      // the children's DbClient.open (strict: true) resolves an existing
      // file. Using DbClient.open here would run the full migration,
      // renaming the JSON to .migrated before the children spawn —
      // making the test vacuous (children would find no JSON and skip
      // migration, never testing the lock).
      {
        const preInit = new Database(dbPath, { strict: false })
        preInit.close()
      }

      // Child script: open + close on the shared path. The child runs as
      // a separate bun process so the lock actually serialises two
      // concurrent migrations.
      const childScript = join(storeDir, 'child.mts')
      const repoRoot = process.cwd()
      writeFileSync(
        childScript,
        [
          `import { DbClient } from '${repoRoot}/src/db.ts'`,
          `import { logger } from '${repoRoot}/src/logger.ts'`,
          `const cfg = { STORE_DIR: process.env.STORE_DIR!, DB_FILENAME: 'race.db', PROJECT_ROOT: ${JSON.stringify(repoRoot)} }`,
          `const c = DbClient.open(cfg, logger, process.env.STORE_DIR + '/race.db')`,
          `c.close()`,
        ].join('\n'),
      )

      // Spawn 2 children in parallel. Bun.spawn returns a subprocess;
      // .exited is a promise that resolves with the exit code.
      const env = { ...process.env, STORE_DIR: storeDir }
      const [r1, r2] = await Promise.all([
        Bun.spawn(['bun', 'run', childScript], { env, cwd: repoRoot }).exited,
        Bun.spawn(['bun', 'run', childScript], { env, cwd: repoRoot }).exited,
      ])
      expect(r1).toBe(0)
      expect(r2).toBe(0)

      // Exactly N rows (2 from the JSON, no duplicate). The first child
      // acquires the lock, migrates, releases; the second child waits on
      // the lock then sees the renamed JSON and returns.
      const client = DbClient.open({ ...config, STORE_DIR: storeDir }, logger, dbPath)
      const rows = client.query<{ c: number }>('SELECT COUNT(*) as c FROM task_runs')
      expect(rows[0]?.c).toBe(2)

      // JSON has been renamed, lock dir has been released.
      expect(existsSync(join(storeDir, 'task-run-history.json'))).toBe(false)
      expect(existsSync(join(storeDir, 'task-run-history.json.migrated'))).toBe(true)
      expect(existsSync(lockDir)).toBe(false)
      client.close()
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('a held lock prevents the second open() from migrating (JSON file stays)', async () => {
    const storeDir = mkdtempSync(join(tmpdir(), 'marveen-race-held-'))
    const cfg = { ...config, STORE_DIR: storeDir }
    const dbPath = join(storeDir, 'held.db')
    const legacyPath = join(storeDir, 'task-run-history.json')
    // The test suite globally forbids process.kill (src/__tests__/setup/
    // forbid-system-calls.ts). Spy on process.kill for this test and
    // simulate an alive foreign pid (the holder would be a different
    // live process holding the lock). The real holder pid is not used
    // by the production code path here -- we only need the spy to make
    // the isMigrationLockStale kill(0) check return "alive".
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((() => true) as unknown) as typeof process.kill)
    try {
      writeFileSync(
        legacyPath,
        JSON.stringify([{ name: 'h-a', agent: 'a', ts: 1 }]),
      )

      // Simulate "another process holds the lock" by writing the lock
      // dir + pid + token files. The pid is a different number from
      // process.pid (so the production code goes through the kill(0)
      // path, not the self-pid token-check path); the token is an
      // arbitrary UUID that does not match this process's own
      // MIGRATION_LOCK_TOKEN (which doesn't matter for the kill(0)
      // path, but keeps the fixture realistic).
      const lockDir = join(storeDir, '.task_runs_migrate.lock')
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), '1234567')
      writeFileSync(join(lockDir, 'token'), '00000000-0000-0000-0000-000000000000')

      const client = DbClient.open(cfg, logger, dbPath)
      expect(existsSync(legacyPath)).toBe(true)
      expect(existsSync(`${legacyPath}.migrated`)).toBe(false)
      const rows = client.query<{ c: number }>('SELECT COUNT(*) as c FROM task_runs')
      expect(rows[0]?.c).toBe(0)
      client.close()
    } finally {
      killSpy.mockRestore()
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('lock dir is released after open() completes (success path)', () => {
    const { storeDir, dbPath } = setupRaceSandbox('release')
    const cfg = { ...config, STORE_DIR: storeDir }
    try {
      const client = DbClient.open(cfg, logger, dbPath)
      client.close()
      // The lock dir must be gone (released in finally). If it leaked,
      // subsequent opens would see a stale lock.
      const lockDir = join(storeDir, '.task_runs_migrate.lock')
      expect(existsSync(lockDir)).toBe(false)
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('stale lock (PID of a dead process) is taken over and migration runs', () => {
    const { storeDir, dbPath, legacyPath } = setupRaceSandbox('stale')
    const cfg = { ...config, STORE_DIR: storeDir }
    try {
      // Pretend a previous crashed process left a lock dir with a pid
      // that doesn't exist anymore. PID 999999999 is virtually never a
      // real process on any sane system; process.kill(pid, 0) returns
      // ESRCH for it.
      const lockDir = join(storeDir, '.task_runs_migrate.lock')
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), '999999999')

      // open() detects the stale lock, takes it over, and migrates.
      const client = DbClient.open(cfg, logger, dbPath)
      // Migration ran: JSON renamed, rows inserted.
      expect(existsSync(legacyPath)).toBe(false)
      expect(existsSync(`${legacyPath}.migrated`)).toBe(true)
      const rows = client.query<{ c: number }>('SELECT COUNT(*) as c FROM task_runs')
      expect(rows[0]?.c).toBe(3)
      client.close()
      // Lock dir released by the takeover path.
      expect(existsSync(lockDir)).toBe(false)
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })

  it('stale lock (recycled PID with mismatched token) is taken over and migration runs', () => {
    // Pre-fix behavior (PID-only stale check): if pid === process.pid,
    // the lock is treated as alive and migration is skipped forever.
    // Linux reuses crashed PIDs immediately, so a recycled-PID attacker
    // (or a benign race after a crash) would lock out migration for
    // every subsequent DbClient.open() until the stale lock is manually
    // deleted. The fix is a per-process UUID 'token' file alongside the
    // pid file: isMigrationLockStale requires BOTH pid AND token to
    // match (otherwise stale -> takeover). This test simulates the
    // recycled-PID scenario by writing pid=process.pid (the fast-path
    // match) and a token that does NOT match the current process's
    // token -- the lock must be taken over and the migration must run.
    const { storeDir, dbPath, legacyPath } = setupRaceSandbox('pidrecycle')
    const cfg = { ...config, STORE_DIR: storeDir }
    try {
      const lockDir = join(storeDir, '.task_runs_migrate.lock')
      mkdirSync(lockDir)
      writeFileSync(join(lockDir, 'pid'), String(process.pid))
      // A recognisably-different token; the production code's read+compare
      // must return "stale" because MIGRATION_LOCK_TOKEN (this process's
      // own UUID, generated at module load time) does not equal this.
      writeFileSync(join(lockDir, 'token'), 'deadbeef-dead-beef-dead-beefdeadbeef')

      const client = DbClient.open(cfg, logger, dbPath)
      // Migration ran despite the "self" pid: the token mismatch made
      // the stale check return true, so the lock was taken over.
      expect(existsSync(legacyPath)).toBe(false)
      expect(existsSync(`${legacyPath}.migrated`)).toBe(true)
      const rows = client.query<{ c: number }>('SELECT COUNT(*) as c FROM task_runs')
      expect(rows[0]?.c).toBe(3)
      client.close()
      // Lock dir released by the takeover path.
      expect(existsSync(lockDir)).toBe(false)
    } finally {
      rmSync(storeDir, { recursive: true, force: true })
    }
  })
})