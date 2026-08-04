import { describe, it, expect, afterEach } from 'vitest'
import chalk from 'chalk'
import { color, setColorsEnabled, areColorsEnabled, getChalk, type ColorPreset } from '../../ui/theme.js'

const PRESETS: ColorPreset[] = ['primary', 'success', 'warn', 'error', 'dim', 'muted', 'bold']

afterEach(() => { setColorsEnabled(true) })

describe('ui/theme', () => {
  it('getChalk returns the chalk instance', () => {
    expect(getChalk()).toBe(chalk)
    expect(typeof getChalk().cyan).toBe('function')
  })

  it('setColorsEnabled(true) forces truecolor and flips the flag', () => {
    setColorsEnabled(true)
    expect(areColorsEnabled()).toBe(true)
    expect(chalk.level).toBe(3)
  })

  it('setColorsEnabled(false) forces level 0 and flips the flag', () => {
    setColorsEnabled(false)
    expect(areColorsEnabled()).toBe(false)
    expect(chalk.level).toBe(0)
  })

  it('every preset wraps the text with ANSI codes when colours are on', () => {
    setColorsEnabled(true)
    for (const preset of PRESETS) {
      const out = color(preset, 'x')
      expect(out, preset).toContain('x')
      // eslint-disable-next-line no-control-regex
      expect(/\[/.test(out), preset).toBe(true)
    }
  })

  it('every preset is a pass-through when colours are off', () => {
    setColorsEnabled(false)
    for (const preset of PRESETS) {
      expect(color(preset, 'x'), preset).toBe('x')
    }
  })
})
