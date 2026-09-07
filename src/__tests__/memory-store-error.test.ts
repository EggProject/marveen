// Pure unit tests for the MemoryStoreError class shape.
// Mirrors the H.4 errors.test.ts pattern: no DB, no fs, no mocks.
// Verifies the AppError convention: new.target.name plumbing, readonly
// query field, message format, ErrorOptions cause propagation, and the
// abstract guard on AppError itself.

import { describe, expect, it } from 'vitest'
import { AppError } from '../errors.js'
import { MemoryStoreError } from '../db.js'

describe('MemoryStoreError', () => {
  it('extends AppError (instanceof chain)', () => {
    const e = new MemoryStoreError('SELECT 1')
    expect(e).toBeInstanceOf(MemoryStoreError)
    expect(e).toBeInstanceOf(AppError)
    expect(e).toBeInstanceOf(Error)
  })

  it('preserves the query field verbatim', () => {
    const e = new MemoryStoreError('SELECT 1 FROM bogus')
    expect(e.query).toBe('SELECT 1 FROM bogus')
  })

  it('sets name from new.target.name plumbing (AppError invariant)', () => {
    const e = new MemoryStoreError('SELECT 1')
    expect(e.name).toBe('MemoryStoreError')
  })

  it('formats message as "MemoryStore query failed: <query>"', () => {
    const e = new MemoryStoreError('SELECT 1')
    expect(e.message).toBe('MemoryStore query failed: SELECT 1')
  })

  it('propagates cause through ErrorOptions', () => {
    const root = new Error('SQLITE_ERROR: no such column: bogus')
    const e = new MemoryStoreError('SELECT bogus', { cause: root })
    expect(e.cause).toBe(root)
  })

  it('handles missing cause (cause is undefined)', () => {
    const e = new MemoryStoreError('SELECT 1')
    expect(e.cause).toBeUndefined()
  })

  it('refuses direct AppError instantiation (abstract guard)', () => {
    expect(() => new (AppError as unknown as new (msg: string) => Error)('x')).toThrow(TypeError)
  })
})
