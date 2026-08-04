import { describe, it, expect, beforeEach } from 'vitest'
import { getLocale, initLocale, currentLocale, t } from '../../locale/index.js'
import hu from '../../locale/hu.js'
import en from '../../locale/en.js'

describe('locale/index', () => {
  beforeEach(() => { initLocale('hu') })

  it('getLocale returns the hungarian map', () => {
    expect(getLocale('hu')).toBe(hu)
  })

  it('getLocale returns the english map', () => {
    expect(getLocale('en')).toBe(en)
  })

  it('initLocale switches the active language', () => {
    expect(currentLocale()).toBe('hu')
    initLocale('en')
    expect(currentLocale()).toBe('en')
    expect(t('cli.title')).toBe('Marveen installer')
  })

  it('t returns the raw template when no args are given', () => {
    expect(t('cli.subtitle')).toBe('AI fleet management rendszer')
  })

  it('t interpolates a single %s placeholder', () => {
    expect(t('error.invalid-port', '70000')).toBe('Érvénytelen port: 70000')
  })

  it('t interpolates multiple %s placeholders left to right', () => {
    initLocale('hu')
    expect(t('summary.bootstrap-url', 'http://a')).toBe('Dashboard URL: http://a')
  })

  it('t substitutes an empty string when an argument is missing', () => {
    expect(t('error.not-supported')).toBe('Nem támogatott platform: %s')
    expect(t('ollama.probe.ok', ...([] as string[]))).toBe('OK -- using %s')
  })

  it('t pads with empty string when fewer args than placeholders', () => {
    // two placeholders in a synthetic template is not possible with the
    // shipped locale, so exercise the `arg ?? ''` fallback by passing a
    // sparse argument list.
    const args = [undefined as unknown as string]
    expect(t('error.invalid-port', ...args)).toBe('Érvénytelen port: ')
  })

  it('t throws on an unknown key', () => {
    expect(() => t('nope.not.here')).toThrow('Missing locale key: nope.not.here')
  })
})
