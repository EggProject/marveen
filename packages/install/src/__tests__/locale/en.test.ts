import { describe, it, expect } from 'vitest'
import en from '../../locale/en.js'

describe('locale/en', () => {
  it('exports a non-empty key set', () => {
    expect(Object.keys(en).length).toBeGreaterThan(50)
  })

  it('every key maps to a non-empty string', () => {
    for (const [key, value] of Object.entries(en)) {
      expect(typeof value, key).toBe('string')
      expect(value.trim().length, key).toBeGreaterThan(0)
    }
  })

  it('has the documented anchor keys', () => {
    expect(en['cli.title']).toBe('Marveen installer')
    expect(en['cli.subtitle']).toBe('AI fleet management system')
    expect(en['provider.ollama.default']).toBe('http://localhost:11434')
  })

  it('keeps %s placeholders on the parametrised keys', () => {
    expect(en['error.invalid-port']).toContain('%s')
    expect(en['error.not-supported']).toContain('%s')
    expect(en['summary.bootstrap-url']).toContain('%s')
    expect(en['ollama.probe.ok']).toContain('%s')
  })
})
