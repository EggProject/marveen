import { describe, it, expect, vi, beforeEach } from 'vitest'
import { homedir } from 'node:os'
import { join } from 'node:path'

// Regression cover for the 04:00 auto-update boot crash: a transient PATH gap
// makes `which claude` fail, and a module-level `resolveFromPath('claude')`
// then threw at import time, taking the whole dashboard (and the scheduler that
// lives in it) down. tryResolveFromPath must fall back to known install dirs,
// and makeLazyBinResolver must not resolve (or throw) until first use.

const mockExecSync = vi.fn()
const mockExistsSync = vi.fn()

vi.mock('node:child_process', () => ({
  execSync: (...args: unknown[]) => mockExecSync(...args),
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return { ...real, existsSync: (p: string) => mockExistsSync(p) }
})

import { tryResolveFromPath, resolveFromPath, makeLazyBinResolver, LazyBin } from '../platform.js'

beforeEach(() => {
  mockExecSync.mockReset()
  mockExistsSync.mockReset()
  mockExistsSync.mockReturnValue(false)
})

describe('tryResolveFromPath', () => {
  it('returns the which-resolved path when PATH resolves the binary', () => {
    mockExecSync.mockReturnValue('/opt/homebrew/bin/claude\n')
    expect(tryResolveFromPath('claude')).toBe('/opt/homebrew/bin/claude')
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('falls back to a known install dir when which fails (transient PATH gap)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which: no claude in PATH') })
    mockExistsSync.mockImplementation((p: string) => p === '/opt/homebrew/bin/claude')
    expect(tryResolveFromPath('claude')).toBe('/opt/homebrew/bin/claude')
  })

  it('probes /usr/local/bin when /opt/homebrew/bin has no binary', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockImplementation((p: string) => p === '/usr/local/bin/tmux')
    expect(tryResolveFromPath('tmux')).toBe('/usr/local/bin/tmux')
  })

  it('probes the user-level install dirs (~/.local/bin native, ~/.bun/bin bun) -- the bootcamp/AVX-fallback layout', () => {
    const home = homedir()
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockImplementation((p: string) => p === join(home, '.local', 'bin', 'claude'))
    expect(tryResolveFromPath('claude')).toBe(join(home, '.local', 'bin', 'claude'))
    mockExistsSync.mockImplementation((p: string) => p === join(home, '.bun', 'bin', 'claude'))
    expect(tryResolveFromPath('claude')).toBe(join(home, '.bun', 'bin', 'claude'))
  })

  it('user-level dirs win over system dirs (PATH-precedence parity)', () => {
    const home = homedir()
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockImplementation((p: string) =>
      p === join(home, '.local', 'bin', 'claude') || p === '/usr/bin/claude')
    expect(tryResolveFromPath('claude')).toBe(join(home, '.local', 'bin', 'claude'))
  })

  it('returns null (does NOT throw) when the binary is absent everywhere', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    expect(tryResolveFromPath('claude')).toBeNull()
  })

  it('rejects an invalid binary name before touching the shell', () => {
    expect(() => tryResolveFromPath('claude; rm -rf /')).toThrow(/Invalid binary name/)
    expect(mockExecSync).not.toHaveBeenCalled()
  })
})

describe('resolveFromPath', () => {
  it('throws only when the binary is truly unresolvable', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    expect(() => resolveFromPath('claude')).toThrow(/Required binary not found/)
  })
})

describe('makeLazyBinResolver', () => {
  it('does not resolve at construction time (safe during a boot-time PATH gap)', () => {
    makeLazyBinResolver('claude')
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExistsSync).not.toHaveBeenCalled()
    // LazyBin form (H.3): same contract -- constructor is no-I/O.
    new LazyBin('claude')
    expect(mockExecSync).not.toHaveBeenCalled()
    expect(mockExistsSync).not.toHaveBeenCalled()
  })

  it('resolves on first call and memoises the result', () => {
    mockExecSync.mockReturnValue('/opt/homebrew/bin/tmux\n')
    const tmuxBin = makeLazyBinResolver('tmux')
    expect(tmuxBin()).toBe('/opt/homebrew/bin/tmux')
    expect(tmuxBin()).toBe('/opt/homebrew/bin/tmux')
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('surfaces the not-found error on first use, not at import', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    const claudeBin = makeLazyBinResolver('claude')
    expect(() => claudeBin()).toThrow(/Required binary not found/)
  })
})

describe('LazyBin', () => {
  it('resolves on first call and memoises the result (class form)', () => {
    mockExecSync.mockReturnValue('/opt/homebrew/bin/tmux\n')
    const bin = new LazyBin('tmux')
    expect(bin.resolve()).toBe('/opt/homebrew/bin/tmux')
    expect(bin.resolve()).toBe('/opt/homebrew/bin/tmux')
    expect(mockExecSync).toHaveBeenCalledTimes(1)
  })

  it('invalidate() drops the memoised value and observes PATH changes (e.g. after install)', () => {
    mockExecSync.mockReturnValueOnce('/opt/homebrew/bin/claude\n')
    mockExecSync.mockReturnValueOnce('/usr/local/bin/claude\n')
    const bin = new LazyBin('claude')
    expect(bin.resolve()).toBe('/opt/homebrew/bin/claude')
    expect(mockExecSync).toHaveBeenCalledTimes(1)
    bin.invalidate()
    expect(bin.resolve()).toBe('/usr/local/bin/claude')
    expect(mockExecSync).toHaveBeenCalledTimes(2)
  })

  it('surfaces the not-found error on first use, not at import (class form)', () => {
    mockExecSync.mockImplementation(() => { throw new Error('which failed') })
    mockExistsSync.mockReturnValue(false)
    const bin = new LazyBin('claude')
    expect(() => bin.resolve()).toThrow(/Required binary not found/)
  })

  it('retries the resolver after a thrown resolve() (cached stays null on throw)', () => {
    // Regression cover for the cached-failure path: a transient PATH gap
    // (the original 2026-08-13 incident) makes the first resolve() throw;
    // a later resolve() against a recovered PATH must succeed. If `cached`
    // were assigned a sentinel on throw, this test would FAIL because the
    // second resolve() would return the sentinel rather than re-call.
    mockExecSync.mockImplementationOnce(() => { throw new Error('which failed: PATH gap') })
    mockExecSync.mockReturnValueOnce('/opt/homebrew/bin/claude\n')
    const bin = new LazyBin('claude')
    expect(() => bin.resolve()).toThrow(/Required binary not found/)
    expect(bin.resolve()).toBe('/opt/homebrew/bin/claude')
  })

  it('uses an injected resolver in place of the default resolveFromPath', () => {
    // Pins the `resolver` constructor parameter. Without this test, the
    // parameter could be deleted (or hardcoded to resolveFromPath) without
    // any test failing -- the class would still pass every other assertion.
    let calls = 0
    const bin = new LazyBin('claude', (name) => {
      calls += 1
      return `/custom/path/to/${name}`
    })
    expect(bin.resolve()).toBe('/custom/path/to/claude')
    expect(bin.resolve()).toBe('/custom/path/to/claude')
    expect(calls).toBe(1)
    bin.invalidate()
    expect(bin.resolve()).toBe('/custom/path/to/claude')
    expect(calls).toBe(2)
  })
})
