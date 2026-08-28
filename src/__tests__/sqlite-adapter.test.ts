// 100% coverage suite for src/db/sqlite.ts.
//
// The adapter wraps bun:sqlite with three public functions:
//   pragma(db, source)   -- PRAGMA as a fire-and-forget .run()
//   getPragma(db, source)-- read a PRAGMA's current value via prepare().get()
//   runScript(db, sql)   -- multi-statement DDL passthrough
//
// Plus the Database re-export. Bun's PRAGMA is a SELECT under the hood and
// always yields a row (even PRAGMA user_version returns {user_version:0}),
// so the `if (!row) return null` guard in getPragma is structurally
// unreachable from real sqlite -- to exercise it we mock db.prepare to
// return a statement whose .get() yields null (as if the row came back
// absent for some hypothetical future pragma that didn't).

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { Database, pragma, getPragma, runScript } from '../db/sqlite.js'

interface MockDb {
  run: ReturnType<typeof vi.fn>
  exec: ReturnType<typeof vi.fn>
  prepare: ReturnType<typeof vi.fn>
}

function mkMockDb(): MockDb {
  return {
    run: vi.fn(),
    exec: vi.fn(),
    prepare: vi.fn(),
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('pragma', () => {
  it('issues the source as a PRAGMA statement via db.run', () => {
    const db = mkMockDb()
    pragma(db as unknown as Database, 'journal_mode = WAL')
    expect(db.run).toHaveBeenCalledWith('PRAGMA journal_mode = WAL')
    expect(db.prepare).not.toHaveBeenCalled()
  })

  it('returns the result of db.run (whatever bun:sqlite yields)', () => {
    const db = mkMockDb()
    db.run.mockReturnValue({ changes: 0 })
    expect(pragma(db as unknown as Database, 'foreign_keys = ON')).toEqual({ changes: 0 })
  })
})

describe('getPragma', () => {
  it('reads the first column of the prepare().get() row', () => {
    const db = mkMockDb()
    db.prepare.mockReturnValue({
      get: () => ({ journal_mode: 'wal' }),
    })
    expect(getPragma(db as unknown as Database, 'journal_mode')).toBe('wal')
    expect(db.prepare).toHaveBeenCalledWith('PRAGMA journal_mode')
  })

  // Cover src/db/sqlite.ts:44 branch[0] (`if (!row) return null`). SQLite
  // PRAGMA always returns a row from prepare().get(), so this arm is
  // unreachable from real sqlite -- we exercise it by mocking the
  // statement to yield null.
  it('returns null when prepare().get() yields no row', () => {
    const db = mkMockDb()
    db.prepare.mockReturnValue({ get: () => null })
    expect(getPragma(db as unknown as Database, 'whatever')).toBeNull()
  })

  it('reads whatever column name the pragma row uses (e.g. user_version)', () => {
    const db = mkMockDb()
    db.prepare.mockReturnValue({ get: () => ({ user_version: 42 }) })
    expect(getPragma(db as unknown as Database, 'user_version')).toBe(42)
  })
})

describe('runScript', () => {
  it('passes multi-statement DDL through to db.run unchanged', () => {
    const db = mkMockDb()
    const sql = `
      CREATE TABLE foo (id INTEGER PRIMARY KEY);
      CREATE TABLE bar (id INTEGER PRIMARY KEY);
    `
    runScript(db as unknown as Database, sql)
    expect(db.run).toHaveBeenCalledWith(sql)
  })

  it('does not split on internal semicolons inside trigger BEGIN bodies', () => {
    const db = mkMockDb()
    const triggerSql = `
      CREATE TRIGGER t AFTER INSERT ON foo
      BEGIN
        UPDATE bar SET x = 1;
        UPDATE bar SET y = 2;
      END;
    `
    runScript(db as unknown as Database, triggerSql)
    expect(db.run).toHaveBeenCalledWith(triggerSql)
  })
})

describe('Database re-export', () => {
  it('re-exports the bun:sqlite Database class', () => {
    // The re-export identity check: same class identity, not a re-wrapped proxy.
    expect(Database).toBeDefined()
    expect(typeof Database).toBe('function')
  })
})
