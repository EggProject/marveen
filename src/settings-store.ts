import { mkdirSync, watch, type FSWatcher } from 'node:fs'
import { STORE_DIR } from './paths.js'
import {
  CONFIG_OVERRIDES_PATH,
  readConfigOverrides,
  resolveConfigValue,
  type ConfigOverrides,
} from './config-resolution.js'
import { atomicWriteFileSync } from './web/atomic-write.js'
import { getSettingDefinition, validateSettingValue } from './config-registry.js'

// Writable canonical layer for registry-backed settings. Runtime resolution is:
// config-overrides.json > registry default. `.env` is migration input only and
// is never consulted by production reads.
export const OVERRIDES_PATH = CONFIG_OVERRIDES_PATH

let cache: ConfigOverrides = {}
let watcher: FSWatcher | undefined

function loadFromDisk(): ConfigOverrides {
  return readConfigOverrides(OVERRIDES_PATH)
}

cache = loadFromDisk()

// Lazily start the directory watch on first use rather than at import time,
// so importing this module in a test (no STORE_DIR yet) does not throw.
function ensureWatching(): void {
  if (watcher) return
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    watcher = watch(STORE_DIR, { persistent: false }, (_event, filename) => {
      if (filename === 'config-overrides.json') cache = loadFromDisk()
    })
  } catch {
    // Best-effort: if the platform/FS doesn't support watching the
    // directory, the cache simply stays as of the last read/write from this
    // process -- still correct for the common single-process case.
  }
}

export function getOverrides(): ConfigOverrides {
  ensureWatching()
  return { ...cache }
}

// Resolves the effective value for a registered key from the single production
// source. `.env` is intentionally absent; the migration command owns that input.
export function getEffectiveSettingValue(key: string): string | number {
  ensureWatching()
  return resolveConfigValue(key, cache)
}

export interface SetOverrideResult {
  ok: boolean
  error?: string
}

// Validates against the registry, then atomically persists the whole
// overrides file and updates the in-memory cache. Validation happens before
// any disk write, so an invalid value never reaches the file -- combined
// with the atomic write, a failure at any point leaves the previous state
// fully intact (no partial save).
export function setOverride(key: string, rawValue: unknown): SetOverrideResult {
  const def = getSettingDefinition(key)
  if (!def) return { ok: false, error: `Ismeretlen kulcs: ${key}` }

  const validation = validateSettingValue(def, rawValue)
  if (!validation.ok) return { ok: false, error: validation.error }

  ensureWatching()
  mkdirSync(STORE_DIR, { recursive: true })
  const next = { ...loadFromDisk(), [key]: validation.value! }
  atomicWriteFileSync(OVERRIDES_PATH, JSON.stringify(next, null, 2))
  cache = next
  return { ok: true }
}

// Test-only escape hatch: forces the in-memory cache back to whatever is
// currently on disk (or empty if absent), bypassing the watch debounce.
export function reloadOverridesForTest(): void {
  cache = loadFromDisk()
}
