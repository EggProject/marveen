import { existsSync, mkdirSync, readFileSync, watch, type FSWatcher } from 'node:fs'
import { join } from 'node:path'
import { STORE_DIR } from './config.js'
import { readEnvFile } from './env.js'
import { atomicWriteFileSync } from './web/atomic-write.js'
import { getSettingDefinition, validateSettingValue, type SettingDefinition } from './config-registry.js'
import { logger, type LoggerLike } from './logger.js'

// Writable override layer for registry-backed settings. Resolution order for
// any registered key is: config-overrides.json > .env > registry default.
// Writes are atomic (tmp file + rename, via atomicWriteFileSync) so a crash
// mid-write can never leave a half-written or zero-byte overrides file. A
// directory watch keeps the in-memory cache in sync if the file is edited
// outside this process (e.g. by hand over SSH); our own writes update the
// cache directly without waiting for the watch event.
export const OVERRIDES_PATH = join(STORE_DIR, 'config-overrides.json')

export class SettingsStore {
  private cache: Record<string, string | number> = {}
  private watcher: FSWatcher | undefined
  private readonly log: LoggerLike

  // Arrow-property callback binds `this` lexically at construction time
  // (F.3 pattern: src/store-watcher.ts:60-66) -- survives vi.resetModules()
  // re-evaluation AND the watcher handle ALWAYS sees the correct instance.
  private readonly onFsEvent = (_eventType: string, filename: string | null): void => {
    if (filename === 'config-overrides.json') this.cache = this.loadFromDisk()
  }

  constructor(opts: { log?: LoggerLike } = {}) {
    this.log = opts.log ?? logger
    this.cache = this.loadFromDisk()
  }

  private loadFromDisk(): Record<string, string | number> {
    try {
      if (!existsSync(OVERRIDES_PATH)) return {}
      const raw = readFileSync(OVERRIDES_PATH, 'utf-8')
      const parsed = JSON.parse(raw)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed
      return {}
    } catch {
      return {}
    }
  }

  // FR2 fix: mirrors F.3 StoreWatcher.start() pattern (src/store-watcher.ts:140-150)
  // -- WARN + RETURN, NOT strict THROW. The runtime check warns on the second call
  // without opening a duplicate fs.watch handle.
  private ensureWatching(): void {
    if (this.watcher) {
      this.log.warn(
        { storeDir: STORE_DIR },
        'settings-store: ensureWatching called twice (FR2 double-fs.watch guard)',
      )
      return
    }
    try {
      mkdirSync(STORE_DIR, { recursive: true })
      this.watcher = watch(STORE_DIR, { persistent: false }, this.onFsEvent)
    } catch {
      // Best-effort: if the platform/FS doesn't support watching the
      // directory, the cache simply stays as of the last read/write from this
      // process -- still correct for the common single-process case.
    }
  }

  // Public test escape hatch -- delegates to the arrow-property callback.
  __test_handleWatchEvent(event: unknown, filename: string | null): void {
    this.onFsEvent(typeof event === 'string' ? event : 'rename', filename)
  }

  getOverrides(): Record<string, string | number> {
    this.ensureWatching()
    return { ...this.cache }
  }

  getEffectiveSettingValue(key: string): string | number {
    this.ensureWatching()
    const def = getSettingDefinition(key)
    if (!def) throw new Error(`Unknown setting key: ${key}`)
    if (key in this.cache) return coerce(def, this.cache[key])
    const envValue = readEnvFile([key])[key]
    if (envValue !== undefined) return coerce(def, envValue)
    return def.default
  }

  setOverride(key: string, rawValue: unknown): SetOverrideResult {
    const def = getSettingDefinition(key)
    if (!def) return { ok: false, error: `Ismeretlen kulcs: ${key}` }

    const validation = validateSettingValue(def, rawValue)
    if (!validation.ok) return { ok: false, error: validation.error }

    this.ensureWatching()
    mkdirSync(STORE_DIR, { recursive: true })
    const next = { ...this.loadFromDisk(), [key]: validation.value! }
    atomicWriteFileSync(OVERRIDES_PATH, JSON.stringify(next, null, 2))
    this.cache = next
    return { ok: true }
  }

  reloadOverridesForTest(): void {
    this.cache = this.loadFromDisk()
  }
}

function coerce(def: SettingDefinition, raw: string | number): string | number {
  if (def.type === 'int') return typeof raw === 'number' ? raw : parseInt(raw, 10)
  return String(raw)
}

// Module-singleton + thin re-export shim (F.3 pattern, byte-identical mocks).
const settingsStore = new SettingsStore()
export function getOverrides(): Record<string, string | number> { return settingsStore.getOverrides() }
export function getEffectiveSettingValue(key: string): string | number { return settingsStore.getEffectiveSettingValue(key) }
export function setOverride(key: string, rawValue: unknown): SetOverrideResult { return settingsStore.setOverride(key, rawValue) }
export function reloadOverridesForTest(): void { settingsStore.reloadOverridesForTest() }
export function __test_handleWatchEvent(event: unknown, filename: string | null): void { settingsStore.__test_handleWatchEvent(event, filename) }

export interface SetOverrideResult {
  ok: boolean
  error?: string
}
