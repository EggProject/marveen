import { describe, it, expect } from 'vitest'
import hu from '../../locale/hu.js'

describe('locale/hu', () => {
  it('exports a non-empty key set', () => {
    expect(Object.keys(hu).length).toBeGreaterThan(50)
  })

  it('every key maps to a non-empty string', () => {
    for (const [key, value] of Object.entries(hu)) {
      expect(typeof value, key).toBe('string')
      expect(value.trim().length, key).toBeGreaterThan(0)
    }
  })

  it('has the documented anchor keys', () => {
    expect(hu['cli.title']).toBe('Marveen telepítő')
    expect(hu['cli.subtitle']).toBe('AI fleet management rendszer')
    expect(hu['provider.ollama.default']).toBe('http://localhost:11434')
  })

  it('keeps %s placeholders on the parametrised keys', () => {
    expect(hu['error.invalid-port']).toContain('%s')
    expect(hu['error.not-supported']).toContain('%s')
    expect(hu['summary.bootstrap-url']).toContain('%s')
    expect(hu['ollama.probe.ok']).toContain('%s')
  })
})
