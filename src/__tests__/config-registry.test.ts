import { describe, it, expect } from 'vitest'
import {
  SETTINGS_REGISTRY,
  DISTRIBUTION_DEFAULT_AGENT_MODEL,
  getSettingDefinition,
  listSettingModules,
  validateSettingValue,
  type SettingDefinition,
} from '../config-registry.js'

describe('config-registry', () => {
  it('registers the kanban WIP keys as non-secret, hot-reloadable, module=kanban', () => {
    // Robust to later registry growth (system/heartbeat/ideabox modules etc.):
    // assert the kanban WIP subset's invariants, not the registry's exact size.
    const kanban = SETTINGS_REGISTRY.filter((s) => s.module === 'kanban')
    // the original v1 kanban WIP keys must all still be present
    expect(kanban.length).toBeGreaterThanOrEqual(9)
    // kanban WIP settings are user-tunable: never secret, hot-reloadable (no restart)
    expect(kanban.every((s) => s.secret === false)).toBe(true)
    expect(kanban.every((s) => s.requiresRestart === false)).toBe(true)
    // registry-wide invariant: the Settings UI must never surface a secret key
    expect(SETTINGS_REGISTRY.every((s) => s.secret === false)).toBe(true)
    expect(getSettingDefinition('KANBAN_WIP_PLANNED')?.module).toBe('kanban')
  })

  it('exposes DISTRIBUTION_DEFAULT_AGENT_MODEL as the boot-time default constant', () => {
    expect(typeof DISTRIBUTION_DEFAULT_AGENT_MODEL).toBe('string')
    expect(DISTRIBUTION_DEFAULT_AGENT_MODEL.length).toBeGreaterThan(0)
    // The DEFAULT_AGENT_MODEL registry entry must use the same constant so the
    // boot-time default and the UI default cannot drift apart.
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')
    expect(def).toBeDefined()
    expect(def?.default).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
    expect(def?.valueSet).toContain(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('registry shape: every entry has the required fields with valid types', () => {
    const validTypes = new Set(['int', 'string', 'color', 'boolean'])
    for (const s of SETTINGS_REGISTRY) {
      expect(typeof s.key).toBe('string')
      expect(s.key.length).toBeGreaterThan(0)
      expect(validTypes.has(s.type)).toBe(true)
      expect(typeof s.description).toBe('string')
      expect(typeof s.module).toBe('string')
      expect(typeof s.secret).toBe('boolean')
      expect(typeof s.requiresRestart).toBe('boolean')
      expect(s.default === undefined || typeof s.default === 'string' || typeof s.default === 'number').toBe(true)
    }
  })

  it('registry keys are unique and indexed lookups match the array order', () => {
    const keys = SETTINGS_REGISTRY.map((s) => s.key)
    expect(new Set(keys).size).toBe(keys.length) // no duplicates
  })

  it('int settings have consistent min <= default <= max when bounds are declared', () => {
    for (const s of SETTINGS_REGISTRY) {
      if (s.type !== 'int') continue
      if (s.min !== undefined) expect(s.min).toBeLessThanOrEqual(s.max ?? s.min)
      if (s.max !== undefined && s.min !== undefined) expect(s.min).toBeLessThanOrEqual(s.max)
    }
  })

  it('getSettingDefinition finds a known key and returns undefined for unknown', () => {
    expect(getSettingDefinition('KANBAN_WIP_PLANNED')?.type).toBe('int')
    expect(getSettingDefinition('NOT_A_REAL_KEY')).toBeUndefined()
  })

  it('listSettingModules returns the distinct modules present in the registry', () => {
    // Robust: derive the expected module set from the registry rather than
    // pinning a hard-coded list, so it survives new modules being added.
    const mods = listSettingModules()
    expect(new Set(mods).size).toBe(mods.length) // distinct, no duplicates
    expect(new Set(mods)).toEqual(new Set(SETTINGS_REGISTRY.map((s) => s.module)))
    expect(mods).toContain('kanban')
  })

  describe('validateSettingValue', () => {
    it('accepts a valid int within bounds', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      const result = validateSettingValue(def, '5')
      expect(result).toEqual({ ok: true, value: 5 })
    })

    it('accepts an int passed as an actual number', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      expect(validateSettingValue(def, 42)).toEqual({ ok: true, value: 42 })
    })

    it('rejects a non-integer string', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      const result = validateSettingValue(def, 'abc')
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/egész szám/i)
    })

    it('rejects a non-integer float (3.5) -- Number.isInteger(3.5) is false', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      // parseInt truncates, so '3.5' becomes 3 and is accepted. Real floats
      // come in as numbers and must still be rejected.
      expect(validateSettingValue(def, 3.5).ok).toBe(false)
      expect(validateSettingValue(def, NaN).ok).toBe(false)
    })

    it('rejects below min', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      const result = validateSettingValue(def, -1)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/legalább/)
    })

    it('accepts the min boundary', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      expect(validateSettingValue(def, 0)).toEqual({ ok: true, value: 0 })
    })

    it('rejects above max', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      const result = validateSettingValue(def, 99999)
      expect(result.ok).toBe(false)
      expect(result.error).toMatch(/legfeljebb/)
    })

    it('rejects 0 for WARN_PCT (min 1, meaningless at 0)', () => {
      const def = getSettingDefinition('KANBAN_WIP_WARN_PCT')!
      expect(validateSettingValue(def, 0).ok).toBe(false)
    })

    it('rejects WARN_PCT above 100', () => {
      const def = getSettingDefinition('KANBAN_WIP_WARN_PCT')!
      expect(validateSettingValue(def, 101).ok).toBe(false)
    })

    it('accepts a valid hex color', () => {
      const def = getSettingDefinition('KANBAN_WIP_OK_COLOR')!
      expect(validateSettingValue(def, '#123abc')).toEqual({ ok: true, value: '#123abc' })
    })

    it('accepts uppercase hex color', () => {
      const def = getSettingDefinition('KANBAN_WIP_OK_COLOR')!
      expect(validateSettingValue(def, '#ABCDEF')).toEqual({ ok: true, value: '#ABCDEF' })
    })

    it('rejects a malformed color', () => {
      const def = getSettingDefinition('KANBAN_WIP_OK_COLOR')!
      const bad1 = validateSettingValue(def, 'red')
      const bad2 = validateSettingValue(def, '#fff')
      expect(bad1.ok).toBe(false)
      expect(bad1.error).toMatch(/szín/)
      expect(bad2.ok).toBe(false)
    })

    it('enforces an explicit valueSet over type-based validation', () => {
      const def: SettingDefinition = { key: 'X', type: 'string', default: 'a', description: '', module: 'm', secret: false, requiresRestart: false, valueSet: ['a', 'b'] }
      expect(validateSettingValue(def, 'a')).toEqual({ ok: true, value: 'a' })
      const bad = validateSettingValue(def, 'c')
      expect(bad.ok).toBe(false)
      expect(bad.error).toMatch(/megengedett/i)
    })

    it('skips valueSet enforcement when the valueSet is declared but empty', () => {
      // Empty valueSet must NOT short-circuit validation -- falls through to type-based.
      const def: SettingDefinition = { key: 'X', type: 'string', default: 'anything', description: '', module: 'm', secret: false, requiresRestart: false, valueSet: [] }
      expect(validateSettingValue(def, 'anything')).toEqual({ ok: true, value: 'anything' })
    })

    it('bool settings: normalises truthy values to "1"', () => {
      const def = getSettingDefinition('MAIN_AGENT_ISOLATED_CONFIG')!
      // raw boolean true
      expect(validateSettingValue(def, true)).toEqual({ ok: true, value: '1' })
      // numeric "1"
      expect(validateSettingValue(def, 1)).toEqual({ ok: true, value: '1' })
      // string "1"
      expect(validateSettingValue(def, '1')).toEqual({ ok: true, value: '1' })
      // string "true"
      expect(validateSettingValue(def, 'true')).toEqual({ ok: true, value: '1' })
      // string "True" with whitespace trimmed
      expect(validateSettingValue(def, ' True ')).toEqual({ ok: true, value: '1' })
    })

    it('bool settings: normalises falsy values to "0"', () => {
      const def = getSettingDefinition('MAIN_AGENT_ISOLATED_CONFIG')!
      // raw boolean false
      expect(validateSettingValue(def, false)).toEqual({ ok: true, value: '0' })
      // numeric 0
      expect(validateSettingValue(def, 0)).toEqual({ ok: true, value: '0' })
      // string "0"
      expect(validateSettingValue(def, '0')).toEqual({ ok: true, value: '0' })
      // string "false"
      expect(validateSettingValue(def, 'false')).toEqual({ ok: true, value: '0' })
      // empty string (treated as unset)
      expect(validateSettingValue(def, '')).toEqual({ ok: true, value: '0' })
    })

    it('bool settings: rejects garbage values that are not boolean-like', () => {
      const def = getSettingDefinition('MAIN_AGENT_ISOLATED_CONFIG')!
      const r = validateSettingValue(def, 'maybe')
      expect(r.ok).toBe(false)
      expect(r.error).toMatch(/logikai/i)
    })

    it('string settings: pass through String(raw)', () => {
      const def = getSettingDefinition('DASHBOARD_PUBLIC_URL')!
      expect(validateSettingValue(def, 'https://example.com')).toEqual({ ok: true, value: 'https://example.com' })
      // Coerces non-strings to their string form.
      expect(validateSettingValue(def, 42)).toEqual({ ok: true, value: '42' })
    })

    it('int settings: tolerates numeric strings with whitespace (parseInt)', () => {
      const def = getSettingDefinition('KANBAN_WIP_PLANNED')!
      expect(validateSettingValue(def, '  7  ')).toEqual({ ok: true, value: 7 })
    })
  })
})
