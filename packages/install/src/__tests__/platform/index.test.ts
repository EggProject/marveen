import { describe, it, expect, afterEach } from 'vitest'
import { createPlatformProvider, LinuxProvider, MacosProvider } from '../../platform/index.js'
import { initLocale } from '../../locale/index.js'
import { makeShell } from '../_helpers.js'

const REAL_PLATFORM = process.platform

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true })
}

afterEach(() => {
  setPlatform(REAL_PLATFORM)
  initLocale('hu')
})

describe('platform/index factory', () => {
  it('returns a LinuxProvider on linux', () => {
    setPlatform('linux')
    const provider = createPlatformProvider(makeShell())
    expect(provider).toBeInstanceOf(LinuxProvider)
    expect(provider.kind).toBe('linux')
  })

  it('returns a MacosProvider on darwin', () => {
    setPlatform('darwin')
    const provider = createPlatformProvider(makeShell())
    expect(provider).toBeInstanceOf(MacosProvider)
    expect(provider.kind).toBe('macos')
  })

  it('throws a localised error on every other platform', () => {
    setPlatform('win32')
    expect(() => createPlatformProvider(makeShell())).toThrow('Nem támogatott platform: win32')
  })

  it('uses the active locale for the error message', () => {
    setPlatform('freebsd')
    initLocale('en')
    expect(() => createPlatformProvider(makeShell())).toThrow('Unsupported platform: freebsd')
  })
})
