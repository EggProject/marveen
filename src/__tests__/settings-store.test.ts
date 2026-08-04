// Tests for src/settings-store.ts.
//
// Coverage target: 100% of statements / branches / functions / lines in
// src/settings-store.ts. The module has three interesting paths that need
// explicit exercises to be covered:
//   1. `loadFromDisk` -- every return-{} branch (file missing, JSON throws,
//      parsed value is null / non-object / array).
//   2. `coerce` -- the non-int branch (`return String(raw)`), which only
//      fires for cached or env-supplied values of color / string / boolean
//      settings that actually go through `getEffectiveSettingValue`. Setting
//      a color override and checking `getOverrides()` is NOT enough -- the
//      cache is returned verbatim there.
//   3. `getEffectiveSettingValue` -- the .env fallback path (no override,
//      readEnvFile returns a value).
//
// Sandbox: STORE_DIR is baked into OVERRIDES_PATH at import time via
// `src/config.ts`, so we cannot use CLAUDECLAW_ENV_DIR for it (that hook
// only redirects env.ts). The redirect is the `../config.js` vi.mock
// applied below; vitest isolates module registries per test file, so the
// hook cannot leak across suites. The .env resolution layer (env.ts) reads
// the live repo-root .env by default, which would leak host state into the
// "fallback to .env" assertion -- that mock is also done below, with
// `vi.fn()` so individual tests can shape its return value.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

const STORE = mkTempStore('settings-store-')
const OVERRIDES = join(STORE, 'config-overrides.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: STORE }
})

// `readEnvFile` is a vi.fn so individual tests can shape what it returns:
// the default empty {} matches the "no .env value" scenario; tests that
// exercise the env-fallback branch mockReturnValueOnce() to inject a value.
const readEnvFileMock = vi.fn(() => ({}) as Record<string, string>)
vi.mock('../env.js', async (orig) => {
  const actual = await orig<typeof import('../env.js')>()
  return { ...actual, readEnvFile: readEnvFileMock }
})

const {
  OVERRIDES_PATH,
  getEffectiveSettingValue,
  setOverride,
  getOverrides,
  reloadOverridesForTest,
} = await import('../settings-store.js')

describe('settings-store', () => {
  beforeEach(() => {
    mkdirSync(STORE, { recursive: true })
    if (existsSync(OVERRIDES)) rmSync(OVERRIDES)
    readEnvFileMock.mockReset()
    readEnvFileMock.mockImplementation(() => ({}))
    reloadOverridesForTest()
  })

  afterEach(() => {
    rmTempDir(STORE)
  })

  it('resolves OVERRIDES_PATH inside the sandbox (the guard this suite relies on)', () => {
    expect(OVERRIDES_PATH).toBe(OVERRIDES)
  })

  it('falls back to the registry default when no override and no .env value exist', () => {
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(80)
    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#6b7280')
  })

  it('throws for a key not in the registry', () => {
    expect(() => getEffectiveSettingValue('NOT_A_REAL_KEY')).toThrow()
  })

  it('persists a valid override and resolves it ahead of the default', () => {
    const result = setOverride('KANBAN_WIP_WARN_PCT', 42)
    expect(result.ok).toBe(true)
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(42)
  })

  it('writes the overrides file atomically (content matches what was set)', () => {
    setOverride('KANBAN_WIP_OK_COLOR', '#112233')
    expect(existsSync(OVERRIDES)).toBe(true)
    const onDisk = JSON.parse(readFileSync(OVERRIDES, 'utf-8'))
    expect(onDisk.KANBAN_WIP_OK_COLOR).toBe('#112233')
  })

  it('rejects an invalid value and does not write or change the cache', () => {
    setOverride('KANBAN_WIP_WARN_PCT', 50) // baseline valid override
    const result = setOverride('KANBAN_WIP_WARN_PCT', 0) // 0 disallowed (min: 1)
    expect(result.ok).toBe(false)
    // rollback: the earlier valid override must still be in effect, not 0
    // and not silently reset to the registry default either.
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(50)
  })

  it('rejects an unknown key without touching the file', () => {
    const before = existsSync(OVERRIDES) ? readFileSync(OVERRIDES, 'utf-8') : null
    const result = setOverride('NOT_A_REAL_KEY', 'x')
    expect(result.ok).toBe(false)
    const after = existsSync(OVERRIDES) ? readFileSync(OVERRIDES, 'utf-8') : null
    expect(after).toBe(before)
  })

  it('merges multiple overrides instead of clobbering previously set keys', () => {
    setOverride('KANBAN_WIP_WARN_PCT', 60)
    setOverride('KANBAN_WIP_OK_COLOR', '#abcdef')
    const overrides = getOverrides()
    expect(overrides.KANBAN_WIP_WARN_PCT).toBe(60)
    expect(overrides.KANBAN_WIP_OK_COLOR).toBe('#abcdef')
  })

  // ----- coerce: non-int branch (return String(raw)) ---------------------

  it('coerce: non-int (color) cached value round-trips through String(raw)', () => {
    // getOverrides() returns cache verbatim; only getEffectiveSettingValue
    // feeds the value through coerce(). Asserting the *resolved* value
    // covers the String(raw) branch in coerce for a non-int type.
    setOverride('KANBAN_WIP_OK_COLOR', '#abcdef')
    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#abcdef')
  })

  it('coerce: non-int (string with valueSet) cached value round-trips through String(raw)', () => {
    setOverride('KANBAN_SWIMLANE_DEFAULT_GROUP', 'assignee')
    expect(getEffectiveSettingValue('KANBAN_SWIMLANE_DEFAULT_GROUP')).toBe('assignee')
  })

  it('coerce: int cached value as a string still parses via parseInt (no data loss)', () => {
    // setOverride always writes the parsed number, but the cache can hold a
    // string when the file is hand-edited or restored from a backup. coerce
    // must not NaN out in that case -- the int branch's parseInt fallback
    // is part of the contract.
    writeFileSync(OVERRIDES, JSON.stringify({ KANBAN_WIP_WARN_PCT: '99' }))
    reloadOverridesForTest()
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(99)
  })

  // ----- getEffectiveSettingValue: env fallback ---------------------------

  it('falls back to .env when no override exists, parsing through coerce', () => {
    readEnvFileMock.mockImplementationOnce(() => ({ KANBAN_WIP_WARN_PCT: '77' }))
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(77)
  })

  it('falls back to .env for a non-int setting, going through String(raw)', () => {
    readEnvFileMock.mockImplementationOnce(() => ({ KANBAN_WIP_OK_COLOR: '#654321' }))
    expect(getEffectiveSettingValue('KANBAN_WIP_OK_COLOR')).toBe('#654321')
  })

  it('prefers an override over a same-key .env value', () => {
    setOverride('KANBAN_WIP_WARN_PCT', 33)
    readEnvFileMock.mockImplementation(() => ({ KANBAN_WIP_WARN_PCT: '99' }))
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(33)
  })

  // ----- loadFromDisk: malformed-JSON / non-object guards ----------------

  it('loadFromDisk: returns {} when the file contains invalid JSON', () => {
    writeFileSync(OVERRIDES, 'not-json-{[')
    reloadOverridesForTest()
    expect(getOverrides()).toEqual({})
  })

  it('loadFromDisk: returns {} when the JSON value is null', () => {
    writeFileSync(OVERRIDES, 'null')
    reloadOverridesForTest()
    expect(getOverrides()).toEqual({})
  })

  it('loadFromDisk: returns {} when the JSON value is an array', () => {
    writeFileSync(OVERRIDES, '[]')
    reloadOverridesForTest()
    expect(getOverrides()).toEqual({})
  })

  it('loadFromDisk: returns {} when the JSON value is a non-object primitive', () => {
    writeFileSync(OVERRIDES, '42')
    reloadOverridesForTest()
    expect(getOverrides()).toEqual({})
  })

  // ----- ensureWatching: best-effort mkdir on a non-directory path -------

  it('ensureWatching: starts a directory watcher that survives a setOverride round-trip', () => {
    // The watcher is module-scope; we cannot assert it directly, but we
    // can prove it does NOT throw when STORE_DIR is a real directory by
    // running a full setOverride + reload cycle. The branch it covers is
    // `ensureWatching`'s mkdirSync + watch() success path.
    setOverride('KANBAN_WIP_WARN_PCT', 77)
    reloadOverridesForTest()
    expect(getEffectiveSettingValue('KANBAN_WIP_WARN_PCT')).toBe(77)
  })
})
