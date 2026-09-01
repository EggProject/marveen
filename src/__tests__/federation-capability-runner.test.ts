// 100% coverage for src/web/federation/capability-runner.ts.
//
// The capability-summary runner is a single-flight loop: every tick it picks
// one (or three, on cold start) agent from the local catalog whose cached
// summary is stale, runs it through the shared one-shot LLM (runAgent), and
// writes the result back. The reconciler is gated on `federation.enabled`
// (no LLM spend when the feature is off), is single-flight (a tick that
// finds a run already in flight is a no-op), and survives per-item
// generation throws so one wedged agent never aborts the batch.
//
// Sandbox:
//   - `os.tmpdir()`-scoped store dir + CLAUDECLAW_ENV_DIR pointing at its
//     parent; with vi.resetModules() before every test, config.ts's
//     module-scope `STORE_DIR = join(PROJECT_ROOT, 'store')` re-evaluates
//     against the current env so capabilities.js and federation/config.js
//     both resolve inside the sandbox, never touching the live checkout.
//   - `node:os` is mocked so `homedir()` is also pinned to the sandbox --
//     defense in depth in case a future indirect dep joins.
//   - `../web/atomic-write.js` is mocked at the factory level so the spy
//     defaults to the REAL implementation; the per-item error test
//     overrides with mockImplementationOnce to force one generation to throw.
//   - `../web/federation/local-catalog.js` is partially mocked -- the real
//     listAgentLocalSkills() is preserved so capabilities.js's
//     readSummarySource() works end-to-end; only catalogAgentNames is stubbed.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ---------------------------------------------------------------------------
// Sandbox creation. Run at file load so CLAUDECLAW_ENV_DIR is set BEFORE any
// module-eval (vitest hoists vi.mock above imports).
// ---------------------------------------------------------------------------

const ENV_DIR = mkdtempSync(join(tmpdir(), 'marveen-cap-runner-'))
const STORE = join(ENV_DIR, 'store')
mkdirSync(STORE, { recursive: true })
process.env.CLAUDECLAW_ENV_DIR = ENV_DIR

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => ENV_DIR }
})

// ---------------------------------------------------------------------------
// Hoisted mock state. Referenceable from vi.mock factory closures.
// ---------------------------------------------------------------------------

const mocks = vi.hoisted(() => ({
  runAgent: vi.fn<(
    msg: string,
    sessionId?: string,
    onTyping?: () => void,
    allowTools?: boolean,
    cwd?: string,
    env?: Record<string, string | undefined>,
    opts?: { timeoutMs?: number; timeoutAsError?: boolean },
  ) => Promise<{ text: string | null; newSessionId?: string; error?: string }>>(),
  getEffectiveSettingValue: vi.fn<(key: string) => string | number>(),
  catalogAgentNames: vi.fn<() => string[]>(),
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../agent.js', () => ({ runAgent: mocks.runAgent }))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: mocks.getEffectiveSettingValue,
}))

vi.mock('../logger.js', () => ({ logger: mocks.logger }))

// Partial mock: keep the real `listAgentLocalSkills` etc., swap out
// `catalogAgentNames` so the test can drive which local agents the runner
// sees without needing a real `agents/` tree.
vi.mock('../web/federation/local-catalog.js', async (orig) => {
  const actual = await orig<typeof import('../web/federation/local-catalog.js')>()
  return {
    ...actual,
    catalogAgentNames: mocks.catalogAgentNames,
  }
})

// atomic-write: the factory captures the REAL implementation via
// importOriginal, then installs a vi.fn that delegates to it. Tests that
// need to force a write to throw use mockImplementationOnce. Without this
// default-during-the-real-impl dance the cache file would not actually land
// on disk in tests that DON'T throw, which would break freshHash() / cache
// reads in subsequent assertions.
vi.mock('../web/atomic-write.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/atomic-write.js')>()
  const fn = vi.fn(actual.atomicWriteFileSync)
  return { atomicWriteFileSync: fn, __capRunnerSpy: { fn } }
})

// ---------------------------------------------------------------------------
// Per-test reset. vi.resetModules forces config.ts to re-eval against the
// current env. The atomic-write spy must also be reset to the real impl
// after a per-test mockImplementationOnce.
// ---------------------------------------------------------------------------

let configMod: typeof import('../web/federation/config.js')
let capsMod: typeof import('../web/federation/capabilities.js')
let runnerMod: typeof import('../web/federation/capability-runner.js')
let atomicWriteSpy: ReturnType<typeof vi.fn>

beforeEach(async () => {
  vi.resetModules()
  process.env.CLAUDECLAW_ENV_DIR = ENV_DIR

  // Wipe the sandbox so each test starts from an empty cache.
  rmSync(STORE, { recursive: true, force: true })
  mkdirSync(STORE, { recursive: true })

  vi.clearAllMocks()
  mocks.getEffectiveSettingValue.mockReturnValue('hu')
  mocks.catalogAgentNames.mockReturnValue([])
  mocks.runAgent.mockResolvedValue({ text: 'mocked summary text', error: undefined })

  configMod = await import('../web/federation/config.js')
  capsMod = await import('../web/federation/capabilities.js')
  runnerMod = await import('../web/federation/capability-runner.js')

  // Re-bind the atomic-write spy after vi.resetModules: vi.resetModules
  // wipes the import cache so the previous spy is stale; the freshly
  // re-imported module exposes its own spy on its namespace.
  const awMod = await import('../web/atomic-write.js') as {
    atomicWriteFileSync: ReturnType<typeof vi.fn>
    __capRunnerSpy?: { fn: ReturnType<typeof vi.fn> }
  }
  atomicWriteSpy = awMod.__capRunnerSpy?.fn ?? awMod.atomicWriteFileSync
  // Default impl: the real writer. Per-item error test overrides with
  // mockImplementationOnce.
  const real = await vi.importActual<typeof import('../web/atomic-write.js')>('../web/atomic-write.js')
  atomicWriteSpy.mockImplementation(real.atomicWriteFileSync)

  // Test seams: redirect the federation config store and the capability
  // cache store to the same sandbox dir.
  configMod._setFederationStoreDirForTest(STORE)
  capsMod._setCapabilityStoreDirForTest(STORE)
  capsMod._resetCapabilityCacheForTest()
  configMod.reloadFederationForTest()
})

afterAll(() => {
  rmSync(ENV_DIR, { recursive: true, force: true })
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeConfig(enabled: boolean): void {
  configMod.writeFederationConfig({
    enabled,
    systemId: 'test-sys',
    peers: [],
  })
  configMod.reloadFederationForTest()
}

/** Build a valid source hash for `agentName` against the (empty) persona in
 *  the sandbox, so the runner's `pickStaleAgents` recognises a hand-written
 *  cache entry as fresh. */
function freshHash(agentName: string, lang: 'hu' | 'en'): string {
  return capsMod.summarySourceHash(capsMod.readSummarySource(agentName), lang)
}

// ===========================================================================
// Module-level constants
// ===========================================================================

describe('module-level constants', () => {
  it('exports the documented initial-delay and interval slots', () => {
    expect(runnerMod.CAPABILITY_RUNNER_INITIAL_DELAY_MS).toBe(65_000)
    expect(runnerMod.CAPABILITY_RUNNER_INTERVAL_MS).toBe(5 * 60_000)
  })
})

// ===========================================================================
// startCapabilitySummaryRunner -- the exported entry point.
// ===========================================================================

describe('startCapabilitySummaryRunner', () => {
  it('returns a NodeJS.Timeout interval handle', () => {
    writeConfig(false)
    const handle = runnerMod.startCapabilitySummaryRunner()
    expect(handle).toBeDefined()
    expect(typeof (handle as { unref?: () => void }).unref).toBe('function')
    clearInterval(handle)
  })

  it('arms an initial setTimeout(.unref()) AND a recurring setInterval', () => {
    writeConfig(false)
    const setTimeoutSpy = vi.spyOn(global, 'setTimeout')
    const setIntervalSpy = vi.spyOn(global, 'setInterval')

    try {
      const handle = runnerMod.startCapabilitySummaryRunner()
      expect(setTimeoutSpy).toHaveBeenCalled()
      expect(setTimeoutSpy.mock.calls[0]?.[1]).toBe(65_000)
      expect(setIntervalSpy).toHaveBeenCalled()
      expect(setIntervalSpy.mock.calls[0]?.[1]).toBe(5 * 60_000)
      clearInterval(handle)
    } finally {
      setTimeoutSpy.mockRestore()
      setIntervalSpy.mockRestore()
    }
  })
})

// ===========================================================================
// _capabilityRunnerTickForTest -- test seam
// ===========================================================================

describe('_capabilityRunnerTickForTest', () => {
  it('returns a Promise and resolves after the tick settles', async () => {
    writeConfig(false)
    const p = runnerMod._capabilityRunnerTickForTest()
    expect(p).toBeInstanceOf(Promise)
    await p
  })

  it('returns the SAME inflight promise on the second call (single-flight)', async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockReturnValue(['a'])
    mocks.runAgent.mockImplementation(
      () => new Promise(() => { /* never resolves -- single-flight test */ }),
    )

    const p1 = runnerMod._capabilityRunnerTickForTest()
    const p2 = runnerMod._capabilityRunnerTickForTest()
    // Second call hits `if (inflight) return` -- the SAME inflight is returned.
    expect(p1).toBe(p2)
    // Only ONE batch -- no second catalogAgentNames / runAgent invocation.
    expect(mocks.catalogAgentNames).toHaveBeenCalledTimes(1)
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)

    // Unblock the never-resolving runAgent so beforeEach's module reset
    // next round is clean.
    mocks.runAgent.mockResolvedValue({ text: 'ok', error: undefined })
  })
})

// ===========================================================================
// runOnce -- disabled early-return
// ===========================================================================

describe('runOnce (disabled branch)', () => {
  it('skips the whole pipeline when federation is disabled', async () => {
    writeConfig(false)
    mocks.catalogAgentNames.mockReturnValue(['a', 'b', 'c'])

    await runnerMod._capabilityRunnerTickForTest()

    // catalogAgentNames is the FIRST thing after the early-return guard.
    // If the guard fires, catalogAgentNames is never reached.
    expect(mocks.catalogAgentNames).not.toHaveBeenCalled()
    expect(mocks.runAgent).not.toHaveBeenCalled()
    expect(existsSync(join(STORE, 'capability-summaries.json'))).toBe(false)
  })
})

// ===========================================================================
// runOnce -- empty catalog
// ===========================================================================

describe('runOnce (empty catalog)', () => {
  it('skips generation when catalogAgentNames returns []', async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockReturnValue([])

    await runnerMod._capabilityRunnerTickForTest()

    expect(mocks.runAgent).not.toHaveBeenCalled()
    // pruneCapabilityCache IS called (with an empty Set), readCapabilityCache IS
    // called -- the empty-batch path then makes the for-loop a no-op.
    expect(existsSync(join(STORE, 'capability-summaries.json'))).toBe(false)
  })
})

// ===========================================================================
// runOnce -- cold-start batch (Object.keys(cache).length === 0 -> COLD_START_BATCH)
// ===========================================================================

describe('runOnce (cold start)', () => {
  it('runs a batch of up to 3 against an empty cache', async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockReturnValue(['a', 'b', 'c', 'd', 'e'])
    mocks.runAgent.mockResolvedValue({ text: 'a fresh summary', error: undefined })

    await runnerMod._capabilityRunnerTickForTest()

    // COLD_START_BATCH = 3 -- at most 3 generations per tick on empty cache.
    expect(mocks.runAgent).toHaveBeenCalledTimes(3)
    // All three were attempted with the documented runner options.
    const opts = mocks.runAgent.mock.calls[0]?.[6] as { timeoutMs?: number; timeoutAsError?: boolean }
    expect(opts?.timeoutMs).toBe(5 * 60_000)
    expect(opts?.timeoutAsError).toBe(true)
    // Cache file is populated.
    const cache = capsMod.readCapabilityCache()
    expect(Object.keys(cache).sort()).toEqual(['a', 'b', 'c'])
    for (const name of ['a', 'b', 'c']) {
      expect(cache[name]?.summary).toBe('a fresh summary')
    }
  })
})

// ===========================================================================
// runOnce -- steady-state batch (cache populated -> limit 1)
// ===========================================================================

describe('runOnce (steady state)', () => {
  it('regenerates at most one agent per tick when the cache is populated', async () => {
    writeConfig(true)
    // Pre-seed a FRESH summary for 'a' (oldest lastAttemptAt) so pickStaleAgents
    // picks 'b' as the next stale candidate (limit 1). 'c' has no entry but
    // lastAttemptAt=50 makes it stale-eligible too -- the sort picks the
    // agent with the smaller lastAttemptAt: that's 'b' (0 < 50).
    capsMod.writeCapabilityCache({
      a: { summary: 'old', sourceHash: freshHash('a', 'hu'), generatedAt: 1, lastAttemptAt: 100 },
      c: { sourceHash: freshHash('c', 'hu'), lastAttemptAt: 50 },
    })
    mocks.catalogAgentNames.mockReturnValue(['a', 'b', 'c'])
    mocks.runAgent.mockResolvedValue({ text: 'new summary', error: undefined })

    await runnerMod._capabilityRunnerTickForTest()

    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
    // Cache file now has 'b' as a fresh summary alongside the unchanged 'a' and 'c'.
    const cache = capsMod.readCapabilityCache()
    expect(cache.a?.summary).toBe('old') // untouched
    expect(cache.b?.summary).toBe('new summary') // regenerated
    expect(cache.c?.summary).toBeUndefined() // still pending
  })

  it('skips generation entirely when every agent is fresh (batch empty)', async () => {
    writeConfig(true)
    // Cache covers ALL three agents with fresh summaries -- pickStaleAgents
    // returns [].
    capsMod.writeCapabilityCache({
      a: { summary: 'a-sum', sourceHash: freshHash('a', 'hu'), generatedAt: 1 },
      b: { summary: 'b-sum', sourceHash: freshHash('b', 'hu'), generatedAt: 1 },
      c: { summary: 'c-sum', sourceHash: freshHash('c', 'hu'), generatedAt: 1 },
    })
    mocks.catalogAgentNames.mockReturnValue(['a', 'b', 'c'])

    await runnerMod._capabilityRunnerTickForTest()

    expect(mocks.runAgent).not.toHaveBeenCalled()
  })
})

// ===========================================================================
// runOnce -- per-item error isolation (generateOneSummary throws)
// ===========================================================================

describe('runOnce (per-item error isolation)', () => {
  it('continues the batch and logs a warn when one generation throws', async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockReturnValue(['a', 'b', 'c'])
    mocks.runAgent.mockResolvedValue({ text: 'fresh summary', error: undefined })

    // Force the FIRST writeCapabilityCache to throw so generateOneSummary
    // rejects. The real impl is restored in the next beforeEach.
    atomicWriteSpy.mockImplementationOnce(() => {
      throw new Error('disk full')
    })

    await runnerMod._capabilityRunnerTickForTest()

    // All three were attempted despite the first one throwing.
    expect(mocks.runAgent).toHaveBeenCalledTimes(3)
    // The per-item catch fired exactly once, against agent 'a'.
    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), agent: 'a' }),
      'capability runner: generation attempt threw',
    )
    // 'b' and 'c' landed in the cache.
    const cache = capsMod.readCapabilityCache()
    expect(cache.b?.summary).toBe('fresh summary')
    expect(cache.c?.summary).toBe('fresh summary')
  })
})

// ===========================================================================
// tick -- outer .catch when runOnce rejects
// ===========================================================================

describe('tick (outer error guard)', () => {
  it('swallows a thrown runOnce via the outer .catch and clears inflight', async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockImplementation(() => {
      throw new Error('catalog read failed')
    })

    // The runner's catch must log the warn and the promise must still resolve.
    await runnerMod._capabilityRunnerTickForTest()

    expect(mocks.logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'capability runner: tick error',
    )

    // After the await, inflight must have been cleared by the .finally so a
    // subsequent tick is free to run again.
    mocks.catalogAgentNames.mockImplementation(() => ['a'])
    mocks.runAgent.mockResolvedValue({ text: 'fresh', error: undefined })
    await runnerMod._capabilityRunnerTickForTest()
    expect(mocks.runAgent).toHaveBeenCalledTimes(1)
  })
})

// ===========================================================================
// resolveLang -- 'hu' default, 'en' explicit, 'hu' on throw
// ===========================================================================

describe('resolveLang (driven through runOnce)', () => {
  it("defaults to 'hu' when DASHBOARD_LANG is unset", async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockReturnValue(['a'])
    mocks.getEffectiveSettingValue.mockReturnValue('')
    mocks.runAgent.mockResolvedValue({ text: 'magyar szöveg', error: undefined })

    await runnerMod._capabilityRunnerTickForTest()

    // The cache entry was written with the 'hu' hash.
    const cache = capsMod.readCapabilityCache()
    expect(cache.a?.sourceHash).toBe(freshHash('a', 'hu'))
  })

  it("returns 'en' when DASHBOARD_LANG === 'en'", async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockReturnValue(['a'])
    mocks.getEffectiveSettingValue.mockImplementation((key: string) => (key === 'DASHBOARD_LANG' ? 'en' : ''))
    mocks.runAgent.mockResolvedValue({ text: 'english summary', error: undefined })

    await runnerMod._capabilityRunnerTickForTest()

    const cache = capsMod.readCapabilityCache()
    expect(cache.a?.sourceHash).toBe(freshHash('a', 'en'))
    // The 'hu' and 'en' hashes differ (different lang prefix feeds the sha256).
    expect(cache.a?.sourceHash).not.toBe(freshHash('a', 'hu'))
  })

  it("falls back to 'hu' when getEffectiveSettingValue throws", async () => {
    writeConfig(true)
    mocks.catalogAgentNames.mockReturnValue(['a'])
    mocks.getEffectiveSettingValue.mockImplementation((key: string) => {
      if (key === 'DASHBOARD_LANG') throw new Error('settings registry corrupted')
      return ''
    })
    mocks.runAgent.mockResolvedValue({ text: 'magyar', error: undefined })

    await runnerMod._capabilityRunnerTickForTest()

    // Cache wrote -- the catch in resolveLang swallowed the throw.
    const cache = capsMod.readCapabilityCache()
    expect(cache.a?.sourceHash).toBe(freshHash('a', 'hu'))
  })
})
