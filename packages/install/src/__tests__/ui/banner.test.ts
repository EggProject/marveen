import { describe, it, expect, beforeEach } from 'vitest'
import { banner, boxed } from '../../ui/banner.js'
import { setColorsEnabled } from '../../ui/theme.js'

beforeEach(() => { setColorsEnabled(false) })

describe('ui/banner', () => {
  it('renders the title inside a box', () => {
    const out = banner({ title: 'Marveen telepítő' })
    expect(out).toContain('Marveen telepítő')
    expect(out).toContain('╭')
    expect(out).toContain('╯')
  })

  it('renders the subtitle on its own line', () => {
    const out = banner({ title: 'Cím', subtitle: 'Alcím' })
    expect(out).toContain('Cím')
    expect(out).toContain('Alcím')
    const lines = out.split('\n').map((l) => l.trim())
    expect(lines.findIndex((l) => l.includes('Alcím'))).toBeGreaterThan(lines.findIndex((l) => l.includes('Cím')))
  })

  it('omits the subtitle line when not provided', () => {
    const withSub = banner({ title: 'T', subtitle: 'S' })
    const withoutSub = banner({ title: 'T' })
    expect(withoutSub.split('\n').length).toBeLessThan(withSub.split('\n').length)
  })

  it('honours explicit width / padding / margin / border overrides', () => {
    const out = banner({
      title: 'T',
      width: 40,
      padding: 0,
      margin: 0,
      borderStyle: 'single',
      borderColor: 'green',
    })
    expect(out).toContain('┌')
    expect(out.split('\n')[0]).toHaveLength(40)
  })

  it('boxed wraps arbitrary text with the boxen defaults', () => {
    expect(boxed('hello')).toContain('hello')
  })

  it('boxed forwards explicit boxen options', () => {
    const out = boxed('hello', { borderStyle: 'double', padding: 0 })
    expect(out).toContain('╔')
  })

  it('colourises the title when colours are enabled', () => {
    setColorsEnabled(true)
    const out = banner({ title: 'T', subtitle: 'S' })
    // eslint-disable-next-line no-control-regex
    expect(/\[/.test(out)).toBe(true)
    setColorsEnabled(false)
  })
})
