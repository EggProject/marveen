// SQLite adapter — central entry point for all database access.
//
// The codebase migrated from `better-sqlite3` (Node-native, incompatible with
// bun) to `bun:sqlite` (built into the bun runtime, 3-6x faster). All code
// runs under bun at production and test time. There is NO node fallback:
// tests that need bun:sqlite must be launched with `bun vitest run` so the
// workers inherit bun as their executable.
//
// API gaps handled here:
//   1. `.pragma(source)` convenience is missing in bun:sqlite — wrapped as
//      `pragma()`.
//   2. bun:sqlite's `.run()` / `.exec()` accept multi-statement SQL (per the
//      bun docs, including CREATE TRIGGER blocks with internal `;` in BEGIN
//      bodies), so `runScript()` passes the block through unchanged.
//
// All source code and tests import from this module rather than from
// `bun:sqlite` directly, so the adapter is the single mock surface — tests
// mock `../db/sqlite.js`.

import { Database } from 'bun:sqlite'

// `Database` is a class — usable both as `new Database(...)` (value) and as a
// type annotation. Re-exporting it here lets consumers import it from
// `db/sqlite.js` instead of `bun:sqlite` directly, so vi.mock in tests targets
// a single stable path.
export { Database }

// Common binding type for prepared-statement parameters. bun:sqlite accepts
// any of these on `.run(...params)` / `.get(...params)` / `.all(...params)`.
export type SQLQueryBindings = string | number | bigint | null | boolean | Date | Uint8Array | Buffer

// .pragma(...) helper — bun:sqlite has no dedicated .pragma() method,
// so we issue the PRAGMA as a regular statement.
export function pragma(db: Database, source: string): unknown {
  return db.run(`PRAGMA ${source}`)
}

// getPragma(...) — read the current value of a PRAGMA. better-sqlite3 had
// `.pragma(source, { simple: true })` which returned the value directly;
// bun:sqlite has no equivalent, so we prepare + .get() and read the first
// column. Used by the test suite to assert on WAL mode / cache size etc.
export function getPragma(db: Database, source: string): unknown {
  const row = db.prepare(`PRAGMA ${source}`).get() as Record<string, unknown> | null
  if (!row) return null
  // PRAGMA rows use the pragma name as the column key (e.g. `journal_mode`).
  const value = Object.values(row)[0]
  return value
}

// Multi-statement DDL runner. bun:sqlite's `.run()` accepts multi-statement
// SQL (per the bun docs, including CREATE TRIGGER blocks whose BEGIN bodies
// contain internal semicolons). We pass the whole block through unchanged.
export function runScript(db: Database, sql: string): void {
  db.run(sql)
}