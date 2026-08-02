import { describe, expect, it } from 'vitest'
import {
  coerceSettingValue,
  parseConfigOverrides,
  readConfigOverrides,
  resolveConfigValue,
} from '../config-resolution.js'
import { getSettingDefinition } from '../config-registry.js'

describe('config-resolution', () => {
  it('parses scalar override objects', () => {
    expect(parseConfigOverrides('{"WEB_PORT":4000,"BOT_NAME":"Ada"}')).toEqual({
      WEB_PORT: 4000,
      BOT_NAME: 'Ada',
    })
  })

  it.each(['null', '[]'])('rejects non-object override roots: %s', (raw) => {
    expect(() => parseConfigOverrides(raw)).toThrow('config_overrides_not_an_object')
  })

  it('rejects non-scalar values', () => {
    expect(() => parseConfigOverrides('{"BOT_NAME":true}')).toThrow('config_override_invalid_value:BOT_NAME')
  })

  it('returns empty when the override file is absent', () => {
    expect(readConfigOverrides('/x', { exists: () => false, read: () => '' })).toEqual({})
  })

  it('reads a valid override file through injected I/O', () => {
    expect(readConfigOverrides('/x', { exists: () => true, read: () => '{"WEB_PORT":"4444"}' }))
      .toEqual({ WEB_PORT: '4444' })
  })

  it('fails closed to an empty object on unreadable or invalid content', () => {
    expect(readConfigOverrides('/x', { exists: () => true, read: () => { throw new Error('no') } })).toEqual({})
    expect(readConfigOverrides('/x', { exists: () => true, read: () => '[]' })).toEqual({})
  })

  it('coerces integer settings and falls back on invalid integers', () => {
    const def = getSettingDefinition('WEB_PORT')!
    expect(coerceSettingValue(def, 4000)).toBe(4000)
    expect(coerceSettingValue(def, '4001')).toBe(4001)
    expect(coerceSettingValue(def, 'invalid')).toBe(3420)
  })

  it('normalizes non-integer settings to strings', () => {
    expect(coerceSettingValue(getSettingDefinition('BOT_NAME')!, 42)).toBe('42')
  })

  it('resolves an override before the registry default', () => {
    expect(resolveConfigValue('WEB_PORT', { WEB_PORT: '4444' })).toBe(4444)
    expect(resolveConfigValue('WEB_PORT', {})).toBe(3420)
  })

  it('rejects unknown keys', () => {
    expect(() => resolveConfigValue('UNKNOWN', {})).toThrow('Unknown setting key: UNKNOWN')
  })
})
