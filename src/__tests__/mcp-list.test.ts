// 100% line/branch/function/statement coverage for src/web/mcp-list.ts.
//
// The module exports four public symbols (getMcpListCache,
// purgeFromMcpListCache, refreshMcpListCache, startMcpListChecker) plus a
// private working-dir pair (getMcpListWorkingDir, cleanupMcpListWorkingDir)
// and a process.exit listener registered at import time.
//
// Branch inventory covered here:
//
//   getMcpListCache            always returns the cache reference
//   purgeFromMcpListCache      name found (returns true) + not found
//   refreshMcpListCache
//     - first call starts a new promise, sets refreshing=true, captures
//       previousCount, awaits the execFile promise
//     - second concurrent call returns the same inflight promise
//     - execFile resolves with {stdout, stderr, execError=null}
//     - execFile resolves with non-zero err + non-empty stdout (parses)
//     - execFile rejects (no stdout) -> catch block
//     - stderr trim > 0 -> logger.debug
//     - stderr trim == 0 (whitespace-only) -> no debug
//     - previousCount>0 + outcome.entries.length===0 + !retainedStale
//       -> logger.warn (defensive regression branch)
//     - previousCount>0 + outcome.entries.length===0 + retainedStale
//       -> no warn (legitimate transient failure)
//     - outcome.error set -> cache.error populated
//     - execError with no outcome.error -> info.softError set
//   getMcpListWorkingDir       not exists -> mkdtempSync; exists -> return
//   cleanupMcpListWorkingDir   mcpListWorkingDir is null -> noop;
//                              is set -> rmSync + null
//                              rmSync throws -> swallowed (best effort)
//   process.once('exit', ...)  registered on first import (asserted via
//                              process.listeners('exit').length)
//
// Each test gets a fresh module registry (via vi.resetModules + dynamic
// import) so the singleton mcpListCache / inflightRefresh / mcpListWorkingDir
// are isolated. Exit listeners that the module registers are tracked and
// removed in afterEach to prevent cross-test pollution.

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Hoisted mocks so vi.mock factories can close over them. The child_process
// callback fires synchronously inside execFile so the in-flight promise
// settles on the next microtask -- no real `claude` binary is spawned.
// ---------------------------------------------------------------------------

interface ExecFileResult {
  // err can be anything -- the catch block in the SUT tests
  // `err instanceof Error ? err.message : String(err)`, so we
  // exercise the String() fallback by passing a string here.
  err: Error | string | null
  stdout: string | null
  stderr: string | null
}

interface FsCall {
  name: 'existsSync' | 'mkdtempSync' | 'rmSync'
  args: unknown[]
}

const mocks = vi.hoisted(() => ({
  info: vi.fn<(...args: unknown[]) => void>(),
  warn: vi.fn<(...args: unknown[]) => void>(),
  debug: vi.fn<(...args: unknown[]) => void>(),
  error: vi.fn<(...args: unknown[]) => void>(),
  fsCalls: [] as FsCall[],
  // existsSync result controller -- true means the working dir "exists",
  // false forces mkdtempSync to fire.
  existsResult: true as boolean,
  // rmSync fault -- when set, rmSync throws. Used to exercise the
  // `try { rmSync(...) } catch {}` best-effort branch.
  rmSyncFault: null as Error | null,
  // Working dir path returned by mkdtempSync (under os.tmpdir()).
  mkdtempReturn: '/tmp/marveen-mcp-list-test',
  // CLAUDE binary path returned by resolveFromPath.
  claudePath: '/usr/bin/claude',
  // execFile result override. When set, the next execFile call uses this.
  execResult: null as ExecFileResult | null,
  execCalls: [] as Array<{ cmd: string; args: readonly string[] }>,
}))

// node:child_process: callback-style execFile. The callback is invoked
// synchronously so the awaiting Promise settles on the next microtask
// instead of leaving a real child pending.
vi.mock('node:child_process', () => ({
  execFile(
    cmd: string,
    args: readonly string[],
    _opts: unknown,
    cb?: (err: Error | null, stdout: string | null, stderr: string | null) => void,
  ): unknown {
    mocks.execCalls.push({ cmd, args })
    if (typeof cb !== 'function') return {} as never
    const r = mocks.execResult
    if (r) {
      cb(r.err, r.stdout, r.stderr)
    } else {
      cb(null, '', '')
    }
    return {} as never
  },
}))

// node:fs: record every call; mkdtempSync returns the sandbox path.
// rmSync is the only branch where we surface a fault (via rmSyncFault).
vi.mock('node:fs', () => ({
  existsSync(p: string): boolean {
    mocks.fsCalls.push({ name: 'existsSync', args: [p] })
    return mocks.existsResult
  },
  mkdtempSync(_prefix: string): string {
    mocks.fsCalls.push({ name: 'mkdtempSync', args: [_prefix] })
    return mocks.mkdtempReturn
  },
  rmSync(p: string, opts: unknown): void {
    mocks.fsCalls.push({ name: 'rmSync', args: [p, opts] })
    if (mocks.rmSyncFault) throw mocks.rmSyncFault
  },
}))

// node:os: real tmpdir() (returns os.tmpdir() which already lives in a
// tmpdir sandbox on the test runner), and a fixed homedir so path
// scrubbing stays deterministic.
vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return {
    ...actual,
    tmpdir: actual.tmpdir,
    homedir: () => '/tmp/marveen-test-home',
  }
})

vi.mock('../platform.js', () => ({
  resolveFromPath: () => mocks.claudePath,
  makeLazyBinResolver: () => () => mocks.claudePath,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
    debug: mocks.debug,
    error: mocks.error,
  },
}))

// ---------------------------------------------------------------------------
// Module loader. vi.resetModules() lets every test start from a fresh
// module scope so the mcpListCache singleton + inflightRefresh + the
// module-level `process.once('exit', ...)` registration are not shared
// across tests.
// ---------------------------------------------------------------------------

type Module = typeof import('../web/mcp-list.js')

async function loadModule(): Promise<Module> {
  vi.resetModules()
  return import('../web/mcp-list.js')
}

// ---------------------------------------------------------------------------
// Lifecycle. Each test gets:
//   - a fresh tmpdir scratch dir (cleaned up in afterEach)
//   - cleared mocks
//   - a fresh module registry
//   - any 'exit' listeners this test added are removed afterwards so
//     cross-test pollution cannot accumulate.
// ---------------------------------------------------------------------------

let sandbox: string
let exitListenerSnapshotBefore: number

beforeEach(() => {
  sandbox = mkTempDir('marveen-mcp-list-')
  vi.clearAllMocks()
  // vi.clearAllMocks clears call history but NOT mock implementations;
  // reset() on each spy so a previous test's `mockImplementation(() =>
  // { throw ... })` does not leak into the next.
  mocks.info.mockReset()
  mocks.warn.mockReset()
  mocks.debug.mockReset()
  mocks.error.mockReset()
  mocks.fsCalls.length = 0
  mocks.execCalls.length = 0
  mocks.existsResult = true
  mocks.rmSyncFault = null
  mocks.mkdtempReturn = sandbox
  mocks.claudePath = '/usr/bin/claude'
  mocks.execResult = null
  exitListenerSnapshotBefore = process.listeners('exit').length
})

afterEach(() => {
  // Remove any 'exit' listeners we added during this test. Without this
  // every loadModule() accumulates a new closure on process, and by the
  // 11th test a 'MaxListenersExceededWarning' fires and the cleanup
  // tests see 19 rmSync calls instead of 1.
  const current = process.listeners('exit')
  for (let i = exitListenerSnapshotBefore; i < current.length; i++) {
    const listener = current[i]
    if (listener) process.removeListener('exit', listener)
  }
  rmTempDir(sandbox)
})

// ---------------------------------------------------------------------------
// process.once('exit', cleanupMcpListWorkingDir)
// ---------------------------------------------------------------------------

describe('module-level registration', () => {
  it('registers a process exit listener at import time', async () => {
    const before = process.listeners('exit').length
    await loadModule()
    const after = process.listeners('exit').length
    expect(after).toBe(before + 1)
  })
})

// ---------------------------------------------------------------------------
// getMcpListCache
// ---------------------------------------------------------------------------

describe('getMcpListCache', () => {
  it('returns the cache singleton with its initial shape', async () => {
    const mod = await loadModule()
    const cache = mod.getMcpListCache()
    expect(cache.entries).toEqual([])
    expect(cache.lastRefreshed).toBe(0)
    expect(cache.refreshing).toBe(false)
    expect(cache.error).toBeUndefined()
  })

  it('returns the same reference on every call', async () => {
    const mod = await loadModule()
    const a = mod.getMcpListCache()
    const b = mod.getMcpListCache()
    expect(a).toBe(b)
  })
})

// ---------------------------------------------------------------------------
// purgeFromMcpListCache
// ---------------------------------------------------------------------------

describe('purgeFromMcpListCache', () => {
  it('returns false when the name is not in the cache', async () => {
    const mod = await loadModule()
    const result = mod.purgeFromMcpListCache('nope')
    expect(result).toBe(false)
    expect(mod.getMcpListCache().entries).toEqual([])
  })

  it('returns true and removes the entry when the name is found', async () => {
    const mod = await loadModule()
    // Seed the cache with a fake entry by reaching through the module
    // via refreshMcpListCache (execFile resolves with parseable stdout).
    mocks.execResult = {
      err: null,
      stdout: 'my-server: node /x - Connected',
      stderr: '',
    }
    await mod.refreshMcpListCache()
    expect(mod.getMcpListCache().entries).toHaveLength(1)
    const purged = mod.purgeFromMcpListCache('my-server')
    expect(purged).toBe(true)
    expect(mod.getMcpListCache().entries).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// refreshMcpListCache
// ---------------------------------------------------------------------------

describe('refreshMcpListCache', () => {
  it('parses parseable stdout, updates entries, refreshes lastRefreshed', async () => {
    const mod = await loadModule()
    mocks.execResult = {
      err: null,
      stdout:
        'claude.ai Gmail: https://gmail.example/mcp - Connected\n' +
        'plugin:telegram:telegram: bun /path - Connected',
      stderr: '',
    }
    const cache = await mod.refreshMcpListCache()
    expect(cache.entries).toHaveLength(2)
    expect(cache.entries[0]?.normalizedId).toBe('gmail')
    expect(cache.entries[1]?.normalizedId).toBe('telegram')
    expect(cache.lastRefreshed).toBeGreaterThan(0)
    expect(cache.refreshing).toBe(false)
    expect(cache.error).toBeUndefined()
  })

  it('does NOT warn on first-refresh success with zero entries (previousCount=0)', async () => {
    const mod = await loadModule()
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    // previousCount was 0, so the defensive warn branch must not fire
    // even though outcome.entries.length is 0.
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('warns when a populated cache collapses to zero on a clean exit', async () => {
    const mod = await loadModule()
    // 1) Seed the cache with one entry.
    mocks.execResult = {
      err: null,
      stdout: 'seed: node /x - Connected',
      stderr: '',
    }
    await mod.refreshMcpListCache()
    expect(mod.getMcpListCache().entries).toHaveLength(1)
    mocks.warn.mockClear()

    // 2) Next refresh returns parseable output but with no valid entries
    //    AND stderr to drive the warn path (which logs stderr slice).
    mocks.execResult = {
      err: null,
      stdout: 'unparseable-noise',
      stderr: 'deprecation: blah',
    }
    await mod.refreshMcpListCache()
    expect(mod.getMcpListCache().entries).toEqual([])
    expect(mocks.warn).toHaveBeenCalledTimes(1)
    const [warnArg, warnMsg] = mocks.warn.mock.calls[0] ?? []
    expect(warnMsg).toContain('MCP list cache refresh returned 0 entries after non-empty cache')
    expect(warnArg).toMatchObject({ previousCount: 1 })
  })

  it('does NOT warn on the legitimate transient failure path (retainedStale)', async () => {
    const mod = await loadModule()
    // 1) Seed the cache.
    mocks.execResult = {
      err: null,
      stdout: 'seed: node /x - Connected',
      stderr: '',
    }
    await mod.refreshMcpListCache()
    expect(mod.getMcpListCache().entries).toHaveLength(1)
    mocks.warn.mockClear()

    // 2) Next refresh fails AND stdout is empty -> retainedStale=true.
    //    outcome.entries.length === previousEntries.length === 1, so the
    //    "zero entries" warn must NOT fire.
    mocks.execResult = {
      err: new Error('spawn ENOENT'),
      stdout: '',
      stderr: '',
    }
    await mod.refreshMcpListCache()
    expect(mod.getMcpListCache().entries).toHaveLength(1) // retained
    // No "0 entries after non-empty cache" warn.
    const defensiveWarn = mocks.warn.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('0 entries after non-empty cache'),
    )
    expect(defensiveWarn).toBeUndefined()
  })

  it('parses stdout when execError is non-null (health-check failure)', async () => {
    const mod = await loadModule()
    mocks.execResult = {
      err: new Error('exit 1'),
      stdout: 'claude.ai Gmail: https://gmail.example/mcp - Connected',
      stderr: '',
    }
    const cache = await mod.refreshMcpListCache()
    expect(cache.entries).toHaveLength(1)
    expect(cache.error).toBeUndefined()
    // info.softError should be populated since execError && !outcome.error
    const infoCall = mocks.info.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1] === 'MCP list cache refreshed',
    )
    expect(infoCall).toBeDefined()
    const payload = infoCall?.[0] as Record<string, unknown>
    expect(payload).toMatchObject({
      count: 1,
      retainedStale: false,
      softError: 'exit 1',
    })
  })

  it('populates cache.error when applyRefreshOutcome surfaces one', async () => {
    const mod = await loadModule()
    mocks.execResult = {
      err: new Error('ENOENT: claude not found'),
      stdout: '',
      stderr: '',
    }
    const cache = await mod.refreshMcpListCache()
    expect(cache.error).toBe('ENOENT: claude not found')
  })

  it('logs debug when stderr is non-empty after trim', async () => {
    const mod = await loadModule()
    mocks.execResult = {
      err: null,
      stdout: 'claude.ai Gmail: https://gmail.example/mcp - Connected',
      stderr: '  warning: something  ',
    }
    await mod.refreshMcpListCache()
    const debugCall = mocks.debug.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1] === 'claude mcp list stderr',
    )
    expect(debugCall).toBeDefined()
  })

  it('does not log debug when stderr is whitespace-only (trim -> empty)', async () => {
    const mod = await loadModule()
    mocks.execResult = {
      err: null,
      stdout: 'claude.ai Gmail: https://gmail.example/mcp - Connected',
      stderr: '   ',
    }
    await mod.refreshMcpListCache()
    const debugCall = mocks.debug.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1] === 'claude mcp list stderr',
    )
    expect(debugCall).toBeUndefined()
  })

  it('returns the same promise to concurrent callers (single inflight)', async () => {
    const mod = await loadModule()
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    const p1 = mod.refreshMcpListCache()
    const p2 = mod.refreshMcpListCache()
    expect(p1).toBe(p2)
    await p1
    // Only one execFile call -- the second invocation saw the inflight
    // and returned the same promise.
    expect(mocks.execCalls.length).toBe(1)
  })

  it('clears inflightRefresh after success so a follow-up call starts a new refresh', async () => {
    const mod = await loadModule()
    mocks.execResult = { err: null, stdout: 'first: node /x - Connected', stderr: '' }
    await mod.refreshMcpListCache()
    mocks.execResult = { err: null, stdout: 'second: node /x - Connected', stderr: '' }
    await mod.refreshMcpListCache()
    // Two distinct execFile invocations -- each refresh started its own
    // inflight because the previous one completed and nulled the slot.
    expect(mocks.execCalls.length).toBe(2)
    // Second refresh overwrites the first (the cache is replaced, not
    // appended to). Only the second entry is in the cache now.
    expect(mod.getMcpListCache().entries.map((e) => e.normalizedId)).toEqual(['second'])
  })

  it('clears inflightRefresh after failure so a follow-up call can start a new refresh', async () => {
    const mod = await loadModule()
    // First call: fail (rejection -> catch path).
    mocks.execResult = { err: new Error('boom'), stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    // Follow-up call after a successful reload: a new inflight must
    // start (the failed one cleared inflightRefresh in its finally).
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    const p = mod.refreshMcpListCache()
    expect(p).toBeInstanceOf(Promise)
    const cache = await p
    // Cache is in the success shape: refreshing=false, error=undefined.
    expect(cache.refreshing).toBe(false)
    expect(cache.error).toBeUndefined()
  })

  it('coerces a non-Error rejection into a string in the catch block', async () => {
    // The catch block does `err instanceof Error ? err.message : String(err)`.
    // The err comes from the inner Promise's reject(); the source passes
    // `err` straight through. Pass a string as the execFile callback's
    // err parameter so the source rejects with a string -- the catch
    // block then falls through to the String(err) branch.
    const mod = await loadModule()
    mocks.execResult = {
      err: 'string-not-error',
      stdout: '',
      stderr: '',
    }
    const cache = await mod.refreshMcpListCache()
    expect(cache.error).toBe('string-not-error')
  })

  it('propagates execFile rejection (no stdout) into the catch block', async () => {
    const mod = await loadModule()
    // err && !stdoutStr -> reject(err) in the inner Promise -> catch.
    mocks.execResult = {
      err: new Error('spawn ENOENT claude'),
      stdout: '',
      stderr: '',
    }
    const cache = await mod.refreshMcpListCache()
    // catch branch: previous entries empty, error set on cache
    expect(cache.entries).toEqual([])
    expect(cache.error).toBe('spawn ENOENT claude')
    // Logger.warn fired for the catch branch
    const failWarn = mocks.warn.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('keeping stale entries'),
    )
    expect(failWarn).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// getMcpListWorkingDir -- private but exercised through refreshMcpListCache
// ---------------------------------------------------------------------------

describe('getMcpListWorkingDir (via refreshMcpListCache)', () => {
  it('returns the cached dir without mkdtempSync when existsSync reports it as present', async () => {
    const mod = await loadModule()
    mocks.existsResult = true
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    // First refresh: mcpListWorkingDir is null -> mkdtempSync fires once.
    await mod.refreshMcpListCache()
    const mkdtempAfterFirst = mocks.fsCalls.filter((c) => c.name === 'mkdtempSync').length
    // Second refresh: mcpListWorkingDir is set, existsSync=true -> return
    // cached dir; no new mkdtempSync.
    mocks.fsCalls.length = 0
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    const mkdtempCalls = mocks.fsCalls.filter((c) => c.name === 'mkdtempSync')
    const existsCalls = mocks.fsCalls.filter((c) => c.name === 'existsSync')
    expect(mkdtempCalls.length).toBe(0)
    expect(existsCalls.length).toBeGreaterThanOrEqual(1)
    expect(mkdtempAfterFirst).toBe(1)
  })

  it('recreates the dir via mkdtempSync when existsSync reports it as missing', async () => {
    const mod = await loadModule()
    mocks.existsResult = false
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    const mkdtempAfterFirst = mocks.fsCalls.filter((c) => c.name === 'mkdtempSync').length
    // Second refresh: existsSync=false -> mkdtempSync called again.
    mocks.fsCalls.length = 0
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    const mkdtempCalls = mocks.fsCalls.filter((c) => c.name === 'mkdtempSync')
    expect(mkdtempCalls.length).toBe(1)
    expect(mkdtempAfterFirst).toBe(1)
  })

  it('first refresh creates the working dir (mcpListWorkingDir null -> mkdtempSync)', async () => {
    const mod = await loadModule()
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    const mkdtempCalls = mocks.fsCalls.filter((c) => c.name === 'mkdtempSync')
    expect(mkdtempCalls.length).toBe(1)
    // existsSync NOT called on first refresh (short-circuit because
    // mcpListWorkingDir is null).
    const existsCalls = mocks.fsCalls.filter((c) => c.name === 'existsSync')
    expect(existsCalls.length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// cleanupMcpListWorkingDir -- private, exercised via process 'exit' listener
// ---------------------------------------------------------------------------

describe('cleanupMcpListWorkingDir (via process exit)', () => {
  it('runs rmSync + nulls the working dir when triggered', async () => {
    const mod = await loadModule()
    // Seed the dir through a refresh so mcpListWorkingDir is set.
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    mocks.fsCalls.length = 0

    // Trigger the 'exit' listener registered for THIS module instance.
    // afterEach will remove it. emit('exit') fires every registered
    // listener, but only the latest module instance has a non-null
    // mcpListWorkingDir -- so only that listener calls rmSync.
    process.emit('exit', 0)

    const rmCalls = mocks.fsCalls.filter((c) => c.name === 'rmSync')
    expect(rmCalls.length).toBe(1)
    expect(rmCalls[0]?.args[0]).toBe(sandbox)
    expect(rmCalls[0]?.args[1]).toEqual({ recursive: true, force: true })
  })

  it('no-ops when mcpListWorkingDir is null (no refresh ever ran)', async () => {
    await loadModule()
    mocks.fsCalls.length = 0
    process.emit('exit', 0)
    const rmCalls = mocks.fsCalls.filter((c) => c.name === 'rmSync')
    expect(rmCalls.length).toBe(0)
  })

  it('swallows rmSync failures (best-effort cleanup)', async () => {
    const mod = await loadModule()
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    await mod.refreshMcpListCache()
    mocks.rmSyncFault = new Error('EACCES')
    // Should not throw -- the listener swallows the error.
    expect(() => process.emit('exit', 0)).not.toThrow()
    mocks.rmSyncFault = null
  })
})

// ---------------------------------------------------------------------------
// startMcpListChecker
// ---------------------------------------------------------------------------

describe('startMcpListChecker', () => {
  it('schedules a refreshMcpListCache call after 30s via setTimeout', async () => {
    const mod = await loadModule()
    vi.useFakeTimers()
    mocks.execResult = { err: null, stdout: '', stderr: '' }
    try {
      mod.startMcpListChecker()
      // Advance 30s and let the microtask queue drain.
      await vi.advanceTimersByTimeAsync(30_000)
      // execFile must have been called from the timer callback.
      expect(mocks.execCalls.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// cache.error scrubbing (path-scrub side-effect on error string)
// ---------------------------------------------------------------------------

describe('cache.error path scrubbing', () => {
  it('scrubs /Users paths in error messages stored on the cache', async () => {
    const mod = await loadModule()
    mocks.execResult = {
      err: new Error('ENOENT /Users/alice/.local/bin/claude'),
      stdout: '',
      stderr: '',
    }
    const cache = await mod.refreshMcpListCache()
    expect(cache.error).toBeDefined()
    expect(cache.error).not.toContain('alice')
  })

  it('scrubs outcome.error via the truthy arm of `outcome.error ?`', async () => {
    // Reach the success path (no catch) AND outcome.error truthy:
    // execError set + stdout has lines but no parseable entries +
    // previousEntries = []. Then mcpListCache.error = scrubPaths('exit 1').
    const mod = await loadModule()
    mocks.execResult = {
      err: new Error('exit 1'),
      // Lines that look like data but the parser rejects (no `: ` + ` - ` triple).
      stdout: 'just some banner text\nno valid format here',
      stderr: '',
    }
    const cache = await mod.refreshMcpListCache()
    expect(cache.error).toBe('exit 1')
  })
})

// ---------------------------------------------------------------------------
// execFile callback signature: stdoutStr / stderrStr defaults
// ---------------------------------------------------------------------------

describe('execFile callback null/undefined handling', () => {
  it('normalises null stdout/stderr to empty strings via ??', async () => {
    const mod = await loadModule()
    // Pass null for stdout and stderr so the `?? ''` right arm fires.
    mocks.execResult = {
      err: null,
      stdout: null,
      stderr: null,
    }
    const cache = await mod.refreshMcpListCache()
    // If the ?? '' didn't fire, scrubPaths would receive null and crash;
    // the refresh would land in the catch block. Here it must succeed.
    expect(cache.error).toBeUndefined()
  })

  it('normalises undefined stdout/stderr to empty strings via ??', async () => {
    const mod = await loadModule()
    mocks.execResult = {
      err: null,
      stdout: undefined as unknown as string,
      stderr: undefined as unknown as string,
    }
    const cache = await mod.refreshMcpListCache()
    expect(cache.error).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// startMcpListChecker: refreshMcpListCache().catch(() => {}) arm
// ---------------------------------------------------------------------------

describe('startMcpListChecker -- refresh rejection arm', () => {
  it('fires the .catch(() => {}) callback when refresh rejects', async () => {
    const mod = await loadModule()
    // Strategy: force the async IIFE inside refreshMcpListCache to reject
    // by making logger.warn throw during the catch block. The catch
    // block is reached by a failing execFile (err && !stdoutStr); the
    // block then calls logger.warn; warn throws -> IIFE rejects ->
    // .catch() fires.
    mocks.warn.mockImplementation(() => {
      throw new Error('boom from warn')
    })
    mocks.execResult = {
      err: new Error('original failure'),
      stdout: '',
      stderr: '',
    }
    vi.useFakeTimers()
    try {
      mod.startMcpListChecker()
      await vi.advanceTimersByTimeAsync(30_000)
      // Let microtasks drain so refreshMcpListCache().catch resolves.
      await Promise.resolve()
      // The .catch(() => {}) callback fired (no-op). execFile ran.
      expect(mocks.execCalls.length).toBeGreaterThanOrEqual(1)
    } finally {
      vi.useRealTimers()
    }
  })
})

// ---------------------------------------------------------------------------
// Pinning test for the dead `execError ?` truthy arm in the warn payload
// (line 135). See mcp-list-warn-execError-dead-branch.
//
// The test asserts what production guarantees: whenever the warn fires
// (previousCount > 0, outcome.entries empty, !retainedStale), the
// destructured `execError` from the await is null. That makes the
// truthy arm of `execError ? scrubPaths(execError.message) : null`
// unreachable in every reachable case.
// ---------------------------------------------------------------------------

describe('pinning: warn payload execError is always null', () => {
  it('fires the warn with execError=null when a populated cache collapses to zero', async () => {
    const mod = await loadModule()
    mocks.execResult = { err: null, stdout: 'seed: node /x - Connected', stderr: '' }
    await mod.refreshMcpListCache()
    mocks.warn.mockClear()
    mocks.execResult = {
      err: null,
      stdout: 'no-valid-entries-here',
      stderr: 'deprecation',
    }
    await mod.refreshMcpListCache()
    const defensiveWarn = mocks.warn.mock.calls.find(
      (c) => typeof c[1] === 'string' && c[1].includes('0 entries after non-empty cache'),
    )
    expect(defensiveWarn).toBeDefined()
    const payload = defensiveWarn?.[0] as Record<string, unknown>
    // execError must be null in the warn payload. This is the only
    // reachable value: applyRefreshOutcome sets retainedStale=true
    // whenever execError is set AND previousEntries is non-empty, so
    // the warn's `!retainedStale` precondition excludes the truthy arm.
    expect(payload.execError).toBeNull()
  })
})