import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, stat, readFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFs, defaultFs, ensureParentDir, resetFsFactory, setFsFactory } from '../../shell/fs.js'

let dir = ''

// Resolved before any hook runs, so the module-level fs factory (the one
// installed at import time) is exercised too.
const bootAdapter = createFs()

beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'marveen-fs-')) })
afterEach(async () => {
  resetFsFactory()
  await rm(dir, { recursive: true, force: true })
})

describe('shell/fs atomicWrite', () => {
  it('creates the file with the given content', async () => {
    const path = join(dir, 'a.txt')
    await defaultFs.atomicWrite(path, 'hello')
    expect(await readFile(path, 'utf-8')).toBe('hello')
  })

  it('applies the requested mode', async () => {
    const path = join(dir, 'secret.txt')
    await defaultFs.atomicWrite(path, 'x', 0o600)
    const st = await stat(path)
    expect(st.mode & 0o777).toBe(0o600)
  })

  it('leaves no temp file behind', async () => {
    const path = join(dir, 'b.txt')
    await defaultFs.atomicWrite(path, 'x', 0o644)
    expect((await readdir(dir)).filter((f) => f.endsWith('.tmp'))).toEqual([])
  })

  it('overwrites an existing file', async () => {
    const path = join(dir, 'c.txt')
    await defaultFs.atomicWrite(path, 'one')
    await defaultFs.atomicWrite(path, 'two')
    expect(await readFile(path, 'utf-8')).toBe('two')
  })

  it('swallows a chmod failure and still renames the file', async () => {
    const path = join(dir, 'd.txt')
    await defaultFs.atomicWrite(path, 'x', Number.NaN)
    expect(await readFile(path, 'utf-8')).toBe('x')
  })
})

describe('shell/fs ensureDir', () => {
  it('creates nested directories', async () => {
    const path = join(dir, 'a', 'b', 'c')
    await defaultFs.ensureDir(path)
    expect((await stat(path)).isDirectory()).toBe(true)
  })

  it('is idempotent', async () => {
    const path = join(dir, 'x')
    await defaultFs.ensureDir(path)
    await defaultFs.ensureDir(path)
    expect((await stat(path)).isDirectory()).toBe(true)
  })
})

describe('shell/fs readFile + exists', () => {
  it('reads back written content', async () => {
    const path = join(dir, 'r.txt')
    await defaultFs.atomicWrite(path, 'tartalom')
    expect(await defaultFs.readFile(path)).toBe('tartalom')
  })

  it('exists returns true for a present path', async () => {
    const path = join(dir, 'e.txt')
    await defaultFs.atomicWrite(path, 'x')
    expect(await defaultFs.exists(path)).toBe(true)
  })

  it('exists returns false for a missing path', async () => {
    expect(await defaultFs.exists(join(dir, 'nope'))).toBe(false)
  })
})

describe('shell/fs factory', () => {
  it('createFs returns the default adapter', () => {
    expect(bootAdapter).toBe(defaultFs)
    expect(createFs()).toBe(defaultFs)
  })

  it('setFsFactory swaps the adapter', () => {
    const fake = { atomicWrite: vi.fn(), ensureDir: vi.fn(), readFile: vi.fn(), exists: vi.fn() }
    setFsFactory(() => fake as never)
    expect(createFs()).toBe(fake)
  })

  it('resetFsFactory restores the default adapter', () => {
    setFsFactory(() => ({} as never))
    resetFsFactory()
    expect(createFs()).toBe(defaultFs)
  })

  it('ensureParentDir creates the parent of a file path', async () => {
    const ensureDir = vi.fn(async () => undefined)
    await ensureParentDir({ ensureDir } as never, '/a/b/c.service')
    expect(ensureDir).toHaveBeenCalledWith('/a/b')
  })
})
