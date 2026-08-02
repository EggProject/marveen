import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { getSettingDefinition, type SettingDefinition } from './config-registry.js'
import { STORE_DIR } from './paths.js'

export type ConfigScalar = string | number
export type ConfigOverrides = Record<string, ConfigScalar>

export const CONFIG_OVERRIDES_PATH = join(STORE_DIR, 'config-overrides.json')

export function parseConfigOverrides(raw: string): ConfigOverrides {
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('config_overrides_not_an_object')
  }

  const result: ConfigOverrides = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string' && typeof value !== 'number') {
      throw new Error(`config_override_invalid_value:${key}`)
    }
    result[key] = value
  }
  return result
}

export function readConfigOverrides(
  path: string = CONFIG_OVERRIDES_PATH,
  deps: {
    exists: (path: string) => boolean
    read: (path: string, encoding: BufferEncoding) => string
  } = { exists: existsSync, read: readFileSync },
): ConfigOverrides {
  if (!deps.exists(path)) return {}
  try {
    return parseConfigOverrides(deps.read(path, 'utf-8'))
  } catch {
    return {}
  }
}

export function coerceSettingValue(def: SettingDefinition, raw: ConfigScalar): ConfigScalar {
  if (def.type !== 'int') return String(raw)
  const parsed = typeof raw === 'number' ? raw : Number.parseInt(raw, 10)
  return Number.isFinite(parsed) ? parsed : def.default
}

export function resolveConfigValue(
  key: string,
  overrides: ConfigOverrides,
  definition: SettingDefinition | undefined = getSettingDefinition(key),
): ConfigScalar {
  if (!definition) throw new Error(`Unknown setting key: ${key}`)
  return key in overrides
    ? coerceSettingValue(definition, overrides[key])
    : definition.default
}
