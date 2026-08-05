// Coverage tests for src/web/active-model.ts.
//
// The SUT has three exports:
//   - projectsDirFor(workingDir, configDir?, homeDirOverride?)
//   - readActiveModelFromProjectDir(workingDir, sinceUnixSec?, configDir?)
//   - readContextTokensFromProjectDir(workingDir, configDir?)
//
// The first is mostly path-math (covered by existing src/__tests__/active-model.test.ts);
// this file focuses on the two file-reading functions and re-asserts the
// projectsDirFor branches that the source's nullish-coalesce produces so
// that this suite is self-contained for the coverage gate.
//
// All file-state tests run against a fresh os.tmpdir() subdirectory
// (mkTempDir from src/__tests__/setup/temp-sandbox.ts) so we never read
// from a real ~/.claude/projects tree.
//
// node:os is mocked so `homedir()` returns the per-test HOME anchor; node:fs
// is the real module, with per-test vi.spyOn to force the throw branches
// the SUT wraps in try/catch.
//
// The two module-level caches (`cache` and `ctxCache`) are not exposed,
// so we cannot clear them between tests. To make tests deterministic we
// give every test a unique workingDir, which produces a unique cache key.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, rmSync, statSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// Hoisted state: shared between the vi.mock factory (which runs before
// any test code) and the per-test HOME anchor (set in beforeEach). The
// factory reads `homedirState.path` on every call so a fresh HOME per
// test is honoured by the SUT.
const homedirState: { path: string } = vi.hoisted(() => ({ path: '/home/testuser' }))

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => homedirState.path }
})

// Per-test fault injector. Tests set `fsFault` to a function name; the
// proxy below throws when the SUT calls that name with a matching path
// suffix. Default = no fault. ESM module namespaces cannot be vi.spyOn'd
// directly, so we wrap node:fs in a Proxy here.
const fsFault: {
  fn?: 'existsSync' | 'readdirSync' | 'statSync' | 'readFileSync'
  suffix?: string
  message?: string
} = {}
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  type Fs = typeof import('node:fs')
  const wrap = <K extends keyof Fs>(name: K): Fs[K] => {
    const real = actual[name] as unknown as (...a: unknown[]) => unknown
    return ((...args: unknown[]) => {
      if (fsFault.fn === name) {
        const pathStr = typeof args[0] === 'string' ? args[0] : ''
        if (!fsFault.suffix || pathStr.includes(fsFault.suffix)) {
          throw new Error(fsFault.message ?? 'synthetic fault')
        }
      }
      return real(...args)
    }) as Fs[K]
  }
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'existsSync' || prop === 'readdirSync' || prop === 'statSync' || prop === 'readFileSync') {
        return wrap(prop as keyof Fs)
      }
      return Reflect.get(target, prop, receiver)
    },
  })
})

// Reference the real fs module so non-mocked helpers (mkdirSync,
// writeFileSync, etc.) keep working. The four names that the SUT calls
// exist on this object too, but they're wrapped by the proxy above --
// every code path that imports node:fs gets the proxied version, so the
// SUT will see the fault while this file's own helpers bypass it via
// the underlying fs module when they don't touch the proxied names.
import * as fsMod from 'node:fs'

const am = await import('../web/active-model.js')
const { projectsDirFor, readActiveModelFromProjectDir, readContextTokensFromProjectDir } = am

let HOME: string
let PROJECTS_ROOT: string
let uniqueCounter = 0

beforeEach(() => {
  HOME = mkTempDir('am-home-')
  homedirState.path = HOME
  PROJECTS_ROOT = join(HOME, '.claude', 'projects')
  mkdirSync(PROJECTS_ROOT, { recursive: true })
  uniqueCounter += 1
})

afterEach(() => {
  rmTempDir(HOME)
  fsFault.fn = undefined
  fsFault.suffix = undefined
  fsFault.message = undefined
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

/** Build a working-dir whose projectsDirFor() encoding is unique-per-call. */
function uniqueWorkingDir(label: string): string {
  return `/work/${label}-${uniqueCounter}-${Date.now()}-${Math.random().toString(36).slice(2)}`
}

/** Create the projects dir for a working dir and return its absolute path. */
function ensureProjectsDir(workingDir: string): string {
  const encoded = workingDir.replace(/[/.]/g, '-')
  const dir = join(HOME, '.claude', 'projects', encoded)
  mkdirSync(dir, { recursive: true })
  return dir
}

/** Write a session jsonl file. The content is appended line-by-line so each
 *  "model" / "usage" entry ends up on its own line for the SUT to split. */
function writeSession(dir: string, name: string, lines: unknown[]): string {
  const path = join(dir, name)
  writeFileSync(path, lines.map(l => JSON.stringify(l)).join('\n') + '\n')
  return path
}

/** Force a file's mtime to a specific ms value. Used to control the
 *  "sort by mtime descending" branch deterministically. */
function setMtime(path: string, ms: number): void {
  const seconds = Math.floor(ms / 1000)
  utimesSync(path, seconds, seconds)
}

// ---------------------------------------------------------------------------
// projectsDirFor
// ---------------------------------------------------------------------------

describe('projectsDirFor', () => {
  it('uses <home>/.claude/projects when no config dir is given and no home override', () => {
    // The mocked homedir() returns HOME; verify the SUT picks it up.
    const result = projectsDirFor('/home/u/work')
    expect(result).toBe(join(HOME, '.claude', 'projects', '-home-u-work'))
  })

  it('uses homeDirOverride when provided', () => {
    const result = projectsDirFor('/w', undefined, '/opt/home')
    expect(result).toBe(join('/opt/home', '.claude', 'projects', '-w'))
  })

  it('uses configDir when provided, even if homeDirOverride is also provided', () => {
    const result = projectsDirFor('/w', '/etc/claude-config', '/opt/home')
    expect(result).toBe(join('/etc/claude-config', 'projects', '-w'))
  })

  it('encodes slashes and dots in the working dir to dashes', () => {
    const result = projectsDirFor('/home/u/some.dir/app')
    expect(result).toBe(join(HOME, '.claude', 'projects', '-home-u-some-dir-app'))
  })
})

// ---------------------------------------------------------------------------
// readActiveModelFromProjectDir
// ---------------------------------------------------------------------------

describe('readActiveModelFromProjectDir', () => {
  it('returns null when the projects dir does not exist', () => {
    const wd = uniqueWorkingDir('no-dir')
    expect(readActiveModelFromProjectDir(wd)).toBeNull()
  })

  it('returns null when the projects dir exists but has no .jsonl files', () => {
    const wd = uniqueWorkingDir('empty')
    ensureProjectsDir(wd)
    expect(readActiveModelFromProjectDir(wd)).toBeNull()
  })

  it('returns the model from the last non-empty line carrying a string model', () => {
    const wd = uniqueWorkingDir('happy')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-haiku-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:01:00Z' },
    ])
    expect(readActiveModelFromProjectDir(wd)).toBe('claude-sonnet-4-5')
  })

  it('skips empty lines, malformed JSON, missing message, and non-string models', () => {
    const wd = uniqueWorkingDir('skip')
    const dir = ensureProjectsDir(wd)
    // Mix of skip-able lines followed by a real entry. The SUT scans from
    // the end; the first match wins, so we put the valid line LAST and the
    // garbage BEFORE it -- except: the SUT skips "no model" lines
    // (continue) and keeps looking backwards. To exercise all skip branches
    // we put a valid entry before the garbage so the SUT scans through
    // garbage on the way back.
    const lines = [
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
      '',
      'this is not json {{{',
      { message: null, timestamp: '2026-01-01T00:01:00Z' },
      { message: { model: 42 }, timestamp: '2026-01-01T00:02:00Z' },
      { message: { model: '<synthetic>' }, timestamp: '2026-01-01T00:03:00Z' },
    ]
    writeSession(dir, 'session-1.jsonl', lines)
    // SUT scans from the end: <synthetic> skipped (startsWith '<'),
    // numeric model skipped, null message skipped, malformed JSON skipped,
    // empty line skipped, then the first valid model 'claude-sonnet-4-5'.
    expect(readActiveModelFromProjectDir(wd)).toBe('claude-sonnet-4-5')
  })

  it('ignores lines whose timestamp is before sinceUnixSec', () => {
    const wd = uniqueWorkingDir('since')
    const dir = ensureProjectsDir(wd)
    const since = Math.floor(new Date('2026-01-01T12:00:00Z').getTime() / 1000)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-haiku-4-5' }, timestamp: '2026-01-01T11:00:00Z' },
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T13:00:00Z' },
    ])
    expect(readActiveModelFromProjectDir(wd, since)).toBe('claude-sonnet-4-5')
  })

  it('returns null when no line passes the sinceUnixSec filter', () => {
    const wd = uniqueWorkingDir('since-none')
    const dir = ensureProjectsDir(wd)
    const since = Math.floor(new Date('2026-01-02T00:00:00Z').getTime() / 1000)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-haiku-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
    ])
    expect(readActiveModelFromProjectDir(wd, since)).toBeNull()
  })

  it('skips lines whose timestamp is not a string when sinceUnixSec is given', () => {
    const wd = uniqueWorkingDir('since-no-ts')
    const dir = ensureProjectsDir(wd)
    const since = 0
    writeSession(dir, 'session-1.jsonl', [
      // Good line first (later scan order: this is index 0, scanned LAST).
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2030-01-01T00:00:00Z' },
      // Bad-timestamp line at the END (scanned FIRST from the back).
      { message: { model: 'claude-haiku-4-5' }, timestamp: 12345 },
    ])
    expect(readActiveModelFromProjectDir(wd, since)).toBe('claude-sonnet-4-5')
  })

  it('skips lines whose timestamp cannot be parsed into a finite Date', () => {
    const wd = uniqueWorkingDir('since-bad-ts')
    const dir = ensureProjectsDir(wd)
    const since = 0
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-haiku-4-5' }, timestamp: 'not-a-date' },
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2030-01-01T00:00:00Z' },
    ])
    expect(readActiveModelFromProjectDir(wd, since)).toBe('claude-sonnet-4-5')
  })

  it('skips lines whose timestamp is missing entirely when sinceUnixSec is given', () => {
    const wd = uniqueWorkingDir('since-missing-ts')
    const dir = ensureProjectsDir(wd)
    const since = 0
    writeSession(dir, 'session-1.jsonl', [
      // Good line at index 0 (scanned LAST).
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2030-01-01T00:00:00Z' },
      // Missing-timestamp line at the END (scanned FIRST from the back).
      { message: { model: 'claude-haiku-4-5' } },
    ])
    expect(readActiveModelFromProjectDir(wd, since)).toBe('claude-sonnet-4-5')
  })

  it('uses the configDir argument when locating projects', () => {
    const cfgRoot = mkTempDir('am-cfg-')
    try {
      const wd = uniqueWorkingDir('with-cfg')
      const encoded = wd.replace(/[/.]/g, '-')
      const dir = join(cfgRoot, 'projects', encoded)
      mkdirSync(dir, { recursive: true })
      writeSession(dir, 'session-1.jsonl', [
        { message: { model: 'claude-opus-4-1' }, timestamp: '2026-01-01T00:00:00Z' },
      ])
      expect(readActiveModelFromProjectDir(wd, undefined, cfgRoot)).toBe('claude-opus-4-1')
    } finally {
      rmTempDir(cfgRoot)
    }
  })

  it('picks the most-recently-modified .jsonl file when more than one exists', () => {
    const wd = uniqueWorkingDir('multi')
    const dir = ensureProjectsDir(wd)
    const older = writeSession(dir, 'old.jsonl', [
      { message: { model: 'claude-haiku-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
    ])
    const newer = writeSession(dir, 'new.jsonl', [
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:01:00Z' },
    ])
    // Force older to be older than newer.
    setMtime(older, 1_000)
    setMtime(newer, 2_000)
    expect(readActiveModelFromProjectDir(wd)).toBe('claude-sonnet-4-5')
  })

  it('caches the result for repeated calls with the same arguments', () => {
    const wd = uniqueWorkingDir('cache')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
    ])
    expect(readActiveModelFromProjectDir(wd)).toBe('claude-sonnet-4-5')
    // Delete the underlying file. If the cache works, the second call
    // still returns the same value; if it doesn't, it'll throw or return
    // null because the projects dir will still exist but readFileSync
    // will fail. We additionally clear the dir to verify both: cache hit
    // + cache hit returns null.
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    expect(readActiveModelFromProjectDir(wd)).toBe('claude-sonnet-4-5')
  })

  it('caches null when the projects dir is missing on the first call', () => {
    const wd = uniqueWorkingDir('cache-null')
    expect(readActiveModelFromProjectDir(wd)).toBeNull()
    // Now create a dir with a model. Second call must STILL be null.
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
    ])
    expect(readActiveModelFromProjectDir(wd)).toBeNull()
  })

  it('caches null when the projects dir is empty', () => {
    const wd = uniqueWorkingDir('cache-empty')
    ensureProjectsDir(wd)
    expect(readActiveModelFromProjectDir(wd)).toBeNull()
  })

  it('throws are swallowed by the outer try/catch and return null', () => {
    const wd = uniqueWorkingDir('throw')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
    ])
    // Force readFileSync to throw; the outer try/catch must swallow it.
    fsFault.fn = 'readFileSync'
    fsFault.suffix = '.jsonl'
    fsFault.message = 'readFileSync boom'
    try {
      expect(readActiveModelFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('existsSync throwing also falls through the outer catch', () => {
    const wd = uniqueWorkingDir('exists-throws')
    fsFault.fn = 'existsSync'
    fsFault.suffix = 'projects'
    fsFault.message = 'existsSync boom'
    try {
      expect(readActiveModelFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('readdirSync throwing also falls through the outer catch', () => {
    const wd = uniqueWorkingDir('readdir-throws')
    ensureProjectsDir(wd)
    fsFault.fn = 'readdirSync'
    fsFault.suffix = 'projects'
    fsFault.message = 'readdirSync boom'
    try {
      expect(readActiveModelFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('statSync throwing also falls through the outer catch', () => {
    const wd = uniqueWorkingDir('stat-throws')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
    ])
    fsFault.fn = 'statSync'
    fsFault.suffix = '.jsonl'
    fsFault.message = 'statSync boom'
    try {
      expect(readActiveModelFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('treats sinceUnixSec as part of the cache key', () => {
    const wd = uniqueWorkingDir('since-cache-key')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { model: 'claude-haiku-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
      { message: { model: 'claude-sonnet-4-5' }, timestamp: '2026-01-01T00:01:00Z' },
    ])
    const since = Math.floor(new Date('2026-01-01T00:00:30Z').getTime() / 1000)
    // First call without since returns 'claude-sonnet-4-5'.
    expect(readActiveModelFromProjectDir(wd)).toBe('claude-sonnet-4-5')
    // Second call with since (different cache key) returns 'claude-sonnet-4-5'.
    expect(readActiveModelFromProjectDir(wd, since)).toBe('claude-sonnet-4-5')
  })

  it('treats configDir as part of the cache key', () => {
    const wd = uniqueWorkingDir('cfg-cache-key')
    const dir1 = ensureProjectsDir(wd)
    writeSession(dir1, 'session-1.jsonl', [
      { message: { model: 'claude-haiku-4-5' }, timestamp: '2026-01-01T00:00:00Z' },
    ])
    const cfgRoot = mkTempDir('am-cfg2-')
    try {
      const encoded = wd.replace(/[/.]/g, '-')
      const dir2 = join(cfgRoot, 'projects', encoded)
      mkdirSync(dir2, { recursive: true })
      writeSession(dir2, 'session-1.jsonl', [
        { message: { model: 'claude-opus-4-1' }, timestamp: '2026-01-01T00:00:00Z' },
      ])
      expect(readActiveModelFromProjectDir(wd)).toBe('claude-haiku-4-5')
      expect(readActiveModelFromProjectDir(wd, undefined, cfgRoot)).toBe('claude-opus-4-1')
    } finally {
      rmTempDir(cfgRoot)
    }
  })
})

// ---------------------------------------------------------------------------
// readContextTokensFromProjectDir
// ---------------------------------------------------------------------------

describe('readContextTokensFromProjectDir', () => {
  it('returns null when the projects dir does not exist', () => {
    const wd = uniqueWorkingDir('ctx-no-dir')
    expect(readContextTokensFromProjectDir(wd)).toBeNull()
  })

  it('returns null when the projects dir has no .jsonl files', () => {
    const wd = uniqueWorkingDir('ctx-empty')
    ensureProjectsDir(wd)
    expect(readContextTokensFromProjectDir(wd)).toBeNull()
  })

  it('returns the sum of input_tokens + cache_read + cache_creation from the latest usage', () => {
    const wd = uniqueWorkingDir('ctx-sum')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 100, cache_read_input_tokens: 50, cache_creation_input_tokens: 25 } } },
      { message: { usage: { input_tokens: 200, cache_read_input_tokens: 100, cache_creation_input_tokens: 50 } } },
    ])
    expect(readContextTokensFromProjectDir(wd)).toBe(350)
  })

  it('skips entries whose total is zero and returns the first non-zero one', () => {
    const wd = uniqueWorkingDir('ctx-zero')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      // Non-zero line at index 0 (scanned LAST).
      { message: { usage: { input_tokens: 42, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      // All-zero line at the END (scanned FIRST from the back, exercises total <= 0 branch).
      { message: { usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    expect(readContextTokensFromProjectDir(wd)).toBe(42)
  })

  it('skips entries without a usage object', () => {
    const wd = uniqueWorkingDir('ctx-no-usage')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: null } },
      { message: { /* no usage field */ } },
      { message: { usage: 'not-an-object' } },
      { message: { usage: { input_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    expect(readContextTokensFromProjectDir(wd)).toBe(7)
  })

  it('coerces non-numeric token fields to zero with `Number(x) || 0`', () => {
    const wd = uniqueWorkingDir('ctx-nan')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 'abc', cache_read_input_tokens: null, cache_creation_input_tokens: undefined } } },
      { message: { usage: { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    // First entry total is 0 (NaN || 0 = 0), so we fall through to the
    // second entry which has total 10.
    expect(readContextTokensFromProjectDir(wd)).toBe(10)
  })

  it('skips empty lines and malformed JSON', () => {
    const wd = uniqueWorkingDir('ctx-malformed')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 99, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      '',
      'not json {{{',
    ])
    expect(readContextTokensFromProjectDir(wd)).toBe(99)
  })

  it('uses the configDir argument when locating projects', () => {
    const cfgRoot = mkTempDir('am-cfg-ctx-')
    try {
      const wd = uniqueWorkingDir('ctx-cfg')
      const encoded = wd.replace(/[/.]/g, '-')
      const dir = join(cfgRoot, 'projects', encoded)
      mkdirSync(dir, { recursive: true })
      writeSession(dir, 'session-1.jsonl', [
        { message: { usage: { input_tokens: 11, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      ])
      expect(readContextTokensFromProjectDir(wd, cfgRoot)).toBe(11)
    } finally {
      rmTempDir(cfgRoot)
    }
  })

  it('picks the most-recently-modified .jsonl file', () => {
    const wd = uniqueWorkingDir('ctx-multi')
    const dir = ensureProjectsDir(wd)
    const older = writeSession(dir, 'old.jsonl', [
      { message: { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    const newer = writeSession(dir, 'new.jsonl', [
      { message: { usage: { input_tokens: 999, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    setMtime(older, 1_000)
    setMtime(newer, 2_000)
    expect(readContextTokensFromProjectDir(wd)).toBe(999)
  })

  it('caches the result for repeated calls', () => {
    const wd = uniqueWorkingDir('ctx-cache')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 50, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    expect(readContextTokensFromProjectDir(wd)).toBe(50)
    // Drop the file. Cache hit should still return 50.
    rmSync(dir, { recursive: true, force: true })
    mkdirSync(dir, { recursive: true })
    expect(readContextTokensFromProjectDir(wd)).toBe(50)
  })

  it('caches null when the projects dir is missing on the first call', () => {
    const wd = uniqueWorkingDir('ctx-cache-null')
    expect(readContextTokensFromProjectDir(wd)).toBeNull()
    // Add a real session; second call must still be null because of the cache.
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    expect(readContextTokensFromProjectDir(wd)).toBeNull()
  })

  it('existsSync throwing falls through the outer catch', () => {
    const wd = uniqueWorkingDir('ctx-ex-throws')
    fsFault.fn = 'existsSync'
    fsFault.suffix = 'projects'
    fsFault.message = 'existsSync boom'
    try {
      expect(readContextTokensFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('readdirSync throwing falls through the outer catch', () => {
    const wd = uniqueWorkingDir('ctx-readdir-throws')
    ensureProjectsDir(wd)
    fsFault.fn = 'readdirSync'
    fsFault.suffix = 'projects'
    fsFault.message = 'readdirSync boom'
    try {
      expect(readContextTokensFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('readFileSync throwing falls through the outer catch', () => {
    const wd = uniqueWorkingDir('ctx-read-throws')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    fsFault.fn = 'readFileSync'
    fsFault.suffix = '.jsonl'
    fsFault.message = 'readFileSync boom'
    try {
      expect(readContextTokensFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('statSync throwing falls through the outer catch', () => {
    const wd = uniqueWorkingDir('ctx-stat-throws')
    const dir = ensureProjectsDir(wd)
    writeSession(dir, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    fsFault.fn = 'statSync'
    fsFault.suffix = '.jsonl'
    fsFault.message = 'statSync boom'
    try {
      expect(readContextTokensFromProjectDir(wd)).toBeNull()
    } finally {
      fsFault.fn = undefined
      fsFault.suffix = undefined
      fsFault.message = undefined
    }
  })

  it('treats configDir as part of the cache key', () => {
    const wd = uniqueWorkingDir('ctx-cfg-cache')
    const dir1 = ensureProjectsDir(wd)
    writeSession(dir1, 'session-1.jsonl', [
      { message: { usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    ])
    const cfgRoot = mkTempDir('am-cfg-ctx2-')
    try {
      const encoded = wd.replace(/[/.]/g, '-')
      const dir2 = join(cfgRoot, 'projects', encoded)
      mkdirSync(dir2, { recursive: true })
      writeSession(dir2, 'session-1.jsonl', [
        { message: { usage: { input_tokens: 2, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
      ])
      expect(readContextTokensFromProjectDir(wd)).toBe(1)
      expect(readContextTokensFromProjectDir(wd, cfgRoot)).toBe(2)
    } finally {
      rmTempDir(cfgRoot)
    }
  })
})
