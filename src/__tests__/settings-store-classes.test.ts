// Tests for the class form invariants of src/settings-store.ts.
//
// This file mirrors src/__tests__/settings-store.test.ts (free-function form)
// for the public surface, but adds 6 it() blocks per the F.4 plan that
// specifically exercise the SettingsStore class:
//
//   1. FR2 double-fs.watch guard (WARN + RETURN, NOT strict THROW)
//   2. setOverride updates the per-instance cache synchronously
//   3. __test_handleWatchEvent shape coverage (5 input variants in 1 it())
//   4. Constructor DI pass-through (mockLog stored as this.log)
//   5. Per-instance isolation (two instances have independent caches)
//   6. Cache identity preservation (getOverrides() spread is immutable)
//
// Sandbox: STORE_DIR is redirected via the vi.mock('../config.js') factory
// below. The vi.mock('node:fs') factory runs BEFORE the dynamic import so
// the watch counter is in place when the module-singleton `settingsStore`
// opens its watcher handle.

import { describe, it, expect, beforeEach, afterEach, vi, type Mock } from 'vitest'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'
import type { LoggerLike } from '../logger.js'

const STORE = mkTempStore('settings-store-classes-')
const OVERRIDES = join(STORE, 'config-overrides.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: STORE }
})

// Capture every watch() call so test 1 can assert that ensureWatching does
// NOT open a second handle on the second invocation. The factory must be
// hoisted; using vi.hoisted lets us share the counter with the assertions
// below (which run after the module import).
const fsMockState = vi.hoisted(() => ({ watchCallCount: 0 }))

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    watch: ((_dir: string, _options: unknown, _cb: (eventType: string, filename: string | null) => void) => {
      fsMockState.watchCallCount += 1
      return {
        close: () => undefined,
      } as unknown as ReturnType<typeof actual.watch>
    }) as typeof actual.watch,
  }
})

const {
  SettingsStore,
  setOverride,
  getOverrides,
  __test_handleWatchEvent,
} = await import('../settings-store.js')

type MockLog = {
  info: Mock
  warn: Mock
  error: Mock
  debug: Mock
}

function makeMockLog(): MockLog {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }
}

// Cast a MockLog to LoggerLike so the SettingsStore constructor's
// `opts.log` parameter accepts it. The Mock instances do not literally
// match LogFn's overload signature `(msg: string): void | (obj: object,
// msg?: string): void`; the cast is the same one store-watcher.test.ts:754
// uses for its injected logger.
function asLogger(mock: MockLog): LoggerLike {
  return mock as unknown as LoggerLike
}

describe('settings-store class form (F.4)', () => {
  beforeEach(() => {
    mkdirSync(STORE, { recursive: true })
    if (existsSync(OVERRIDES)) rmSync(OVERRIDES)
    fsMockState.watchCallCount = 0
  })

  afterEach(() => {
    rmTempDir(STORE)
  })

  // ---- T1 ------------------------------------------------------------------
  // FR2 double-fs.watch guard. Mirrors F.3 StoreWatcher.start() pattern
  // (src/store-watcher.ts:140-150): WARN + RETURN, NOT strict THROW. The
  // mockLog.warn assertion is load-bearing -- it proves the WARN+RETURN
  // path was taken (not the strict-throw that F.3 rejected) AND that the
  // injected log was the one called (DI is used, not ceremony).
  it('T1 FR2: ensureWatching called twice warns and does NOT open a second fs.watch handle', () => {
    const mockLog = makeMockLog()
    const instance = new SettingsStore({ log: asLogger(mockLog) })

    expect(fsMockState.watchCallCount).toBe(0) // constructor does not call watch

    instance.getOverrides() // first ensureWatching -> opens watch
    expect(fsMockState.watchCallCount).toBe(1)

    instance.getOverrides() // second ensureWatching -> WARN+RETURN, no second watch
    expect(fsMockState.watchCallCount).toBe(1)

    expect(mockLog.warn).toHaveBeenCalledTimes(1)
    expect(mockLog.warn).toHaveBeenCalledWith(
      expect.objectContaining({ storeDir: STORE }),
      expect.stringContaining('ensureWatching called twice'),
    )
  })

  // ---- T2 ------------------------------------------------------------------
  // setOverride updates the cache synchronously. The cache update inside
  // setOverride body (this.cache = next) is what makes the immediately
  // following getEffectiveSettingValue see the new value WITHOUT waiting
  // for the watch debounce. If the cache update were missing, the second
  // call would resolve to the registry default (80).
  it('T2: setOverride updates the cache synchronously (getEffectiveSettingValue sees the new value immediately)', () => {
    const instance = new SettingsStore()
    expect(instance.getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(80) // default

    const result = instance.setOverride('KANBAN_WIP_WARN_PCT', 42)
    expect(result.ok).toBe(true)

    // NO reloadOverridesForTest() here -- the cache update is synchronous.
    expect(instance.getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(42)
  })

  // ---- T3 ------------------------------------------------------------------
  // __test_handleWatchEvent shape coverage. 5 variants cover:
  //   - happy path: matches the overrides filename -> cache IS reloaded
  //   - null filename (Linux gap): cache NOT reloaded
  //   - change event (NOT rename): cache IS reloaded (arrow-property is
  //     event-agnostic; the test documents the contract for a future
  //     refactor that might add an eventType filter)
  //   - other filename: cache NOT reloaded
  //   - subdirectory path: cache NOT reloaded (basename-only check)
  it('T3: __test_handleWatchEvent shape coverage (5 variants)', () => {
    // Helper: build a fresh instance with a known cache value.
    function fresh(cached: number): InstanceType<typeof SettingsStore> {
      const inst = new SettingsStore()
      writeFileSync(OVERRIDES, JSON.stringify({ BAR: cached }))
      inst.reloadOverridesForTest()
      expect(inst.getOverrides().BAR).toBe(cached)
      return inst
    }

    // T3a -- happy path: matches the overrides filename -> cache IS reloaded.
    {
      const inst = fresh(99)
      writeFileSync(OVERRIDES, JSON.stringify({ BAR: 100 }))
      inst.__test_handleWatchEvent('rename', 'config-overrides.json')
      expect(inst.getOverrides().BAR).toBe(100)
    }

    // T3b -- null filename (Linux gap): cache NOT reloaded.
    {
      const inst = fresh(99)
      writeFileSync(OVERRIDES, JSON.stringify({ BAR: 200 }))
      inst.__test_handleWatchEvent('rename', null)
      expect(inst.getOverrides().BAR).toBe(99)
    }

    // T3c -- change event (NOT rename): cache IS reloaded (arrow-property
    // is event-agnostic; documents the contract for a future refactor).
    {
      const inst = fresh(99)
      writeFileSync(OVERRIDES, JSON.stringify({ BAR: 200 }))
      inst.__test_handleWatchEvent('change', 'config-overrides.json')
      expect(inst.getOverrides().BAR).toBe(200)
    }

    // T3d -- other filename: cache NOT reloaded.
    {
      const inst = fresh(99)
      writeFileSync(OVERRIDES, JSON.stringify({ BAR: 200 }))
      inst.__test_handleWatchEvent('rename', 'OTHER.json')
      expect(inst.getOverrides().BAR).toBe(99)
    }

    // T3e -- subdirectory path: cache NOT reloaded (basename-only check).
    {
      const inst = fresh(99)
      writeFileSync(OVERRIDES, JSON.stringify({ BAR: 200 }))
      inst.__test_handleWatchEvent('rename', 'subdir/config-overrides.json')
      expect(inst.getOverrides().BAR).toBe(99)
    }
  })

  // ---- T4 ------------------------------------------------------------------
  // Constructor DI pass-through. T1 already proved DI USAGE (this.log.warn
  // was called). This test proves DI INJECTION -- the mockLog is stored on
  // the instance, not dropped on the floor.
  it('T4: constructor stores the injected log as this.log (DI pass-through)', () => {
    const mockLog = makeMockLog()
    const loggerLike = asLogger(mockLog)
    const instance = new SettingsStore({ log: loggerLike })
    expect((instance as unknown as { log: LoggerLike }).log).toBe(loggerLike)
  })

  // ---- T5 ------------------------------------------------------------------
  // Per-instance isolation. The class form gives each instance its own
  // cache; the free-function form had a single module-scope cache. Two
  // `new SettingsStore()` calls MUST produce two independent caches -- if
  // the implementation were free-fn form (or singleton-only), this would
  // fail because the second setOverride would leak into the first instance.
  it('T5: per-instance isolation (two instances have independent caches)', () => {
    const s1 = new SettingsStore()
    const s2 = new SettingsStore()

    const result = s1.setOverride('KANBAN_WIP_WARN_PCT', 42)
    expect(result.ok).toBe(true)
    expect(s1.getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(42)

    // s2 has NOT been touched -- its cache must be empty.
    expect(s2.getOverrides().KANBAN_WIP_WARN_PCT).toBeUndefined()
    // s2 falls back to the registry default, NOT s1's override.
    expect(s2.getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(80)
  })

  // ---- T6 ------------------------------------------------------------------
  // Cache identity preservation (load-bearing). getOverrides() returns
  // `{ ...this.cache }` -- a fresh spread copy on every call. Two
  // consecutive calls MUST produce two distinct object references
  // (a !== b). If the implementation dropped the spread and returned
  // `this.cache` directly, both calls would return the SAME reference,
  // and this assertion would FAIL.
  //
  // The original "spread is immutable under setOverride" variant was
  // vacuous: setOverride rebinds `this.cache = next` to a fresh object,
  // so the old reference stays unchanged EITHER WAY (with or without
  // the spread). Reference-identity is the only assertion that actually
  // distinguishes the two implementations.
  it('T6: getOverrides() returns a fresh spread object on every call (reference inequality)', () => {
    const instance = new SettingsStore()
    const result = instance.setOverride('KANBAN_WIP_WARN_PCT', 42)
    expect(result.ok).toBe(true)

    const a = instance.getOverrides()
    const b = instance.getOverrides()

    // Load-bearing: a and b are distinct object references.
    expect(a).not.toBe(b)
    // The two snapshots are equal in content (same keys + values).
    expect(a).toEqual(b)
    // And both see the override we just set.
    expect(a.KANBAN_WIP_WARN_PCT).toBe(42)
    expect(b.KANBAN_WIP_WARN_PCT).toBe(42)

    // Sanity check that mutating a does NOT bleed into b or into the
    // instance's internal cache (the spread must be a copy).
    ;(a as Record<string, unknown>).KANBAN_WIP_WARN_PCT = 'mutated'
    expect(b.KANBAN_WIP_WARN_PCT).toBe(42)
    expect(instance.getOverrides().KANBAN_WIP_WARN_PCT).toBe(42)
  })
})
