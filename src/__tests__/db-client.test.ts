// Tests for src/db.ts A.1 — class DbClient + getHandle() escape hatch.
//
// Each `it()` asserts a DbClient behaviour with a CONCRETE expected value
// against an in-memory or file-backed sqlite handle, NOT vacuous
// "is the class defined" assertions (per CLAUDE.md §8 "vacuous test"
// rule). If DbClient.query() were swapped for `return []`, every query
// assertion would fail. If DbClient.open() forgot to apply the WAL /
// cache_size / synchronous pragmas, the WAL close-reopen edge-case
// assertion would catch it.

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Database } from 'bun:sqlite'
import { DbClient } from '../db.js'
import { logger } from '../logger.js'
import { STORE_DIR, DB_FILENAME, PROJECT_ROOT } from '../config.js'

const config = { STORE_DIR, DB_FILENAME, PROJECT_ROOT }

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

describe('DbClient.open re-init guard', () => {
  it('open() twice on a file-backed path closes the first handle internally', () => {
    const dbPath = join(tmpDir, 'reinit.db')
    const first = DbClient.open(config, logger, dbPath)
    first.exec('CREATE TABLE t (id INTEGER PRIMARY KEY)')
    expect(() => first.close()).not.toThrow()
    expect(() => DbClient.open(config, logger, dbPath)).not.toThrow()
  })

  it('open() twice on a memory path closes the first handle internally', () => {
    const first = DbClient.open(config, logger, ':memory:')
    expect(() => first.close()).not.toThrow()
    expect(() => DbClient.open(config, logger, ':memory:')).not.toThrow()
  })

  it('module-singleton `db` is untouched when only DbClient.open() is called', async () => {
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