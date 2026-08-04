import { describe, it, expect, vi, afterEach, afterAll } from 'vitest'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createState, defaultState, resetConfFactory, setConfFactory, type InstallerState } from '../../state/conf.js'

// Built before any hook runs, so the module-level conf factory (the one
// installed at import time) is exercised too.
const bootStore = createState()

afterEach(() => { resetConfFactory() })
afterAll(async () => { await rm(dirname(bootStore.path), { recursive: true, force: true }) })

describe('state/conf defaults', () => {
  it('defaultState returns the documented defaults', () => {
    expect(defaultState()).toEqual({
      lastInstalledVersion: '',
      lastProvider: 'skip',
      skippedSteps: [],
      uninstalledAt: null,
    })
  })

  it('defaultState hands out a fresh skippedSteps array', () => {
    const a = defaultState()
    a.skippedSteps.push('build')
    expect(defaultState().skippedSteps).toEqual([])
  })
})

describe('state/conf factory', () => {
  it('passes the project name, suffix, defaults and schema', () => {
    const factory = vi.fn((options: unknown) => { void options; return {} as never })
    setConfFactory(factory as never)
    createState()
    const opts = factory.mock.calls[0]![0] as Record<string, unknown>
    expect(opts['projectName']).toBe('marveen-installer')
    expect(opts['projectSuffix']).toBe('marveen')
    expect(opts['defaults']).toEqual(defaultState())
    expect(opts['schema']).toEqual({
      lastInstalledVersion: { type: 'string' },
      lastProvider: { type: 'string', enum: ['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama', 'skip'] },
      skippedSteps: { type: 'array', items: { type: 'string' } },
      uninstalledAt: { type: ['string', 'null'] },
    })
  })

  it('setConfFactory swaps the store implementation', () => {
    const store = { get: vi.fn(), set: vi.fn() }
    setConfFactory(() => store as never)
    expect(createState()).toBe(store)
  })
})

describe('state/conf real store', () => {
  it('is created through the module-level factory', () => {
    expect(bootStore.path).toContain('marveen-installer')
    expect(bootStore.get('lastProvider')).toBe('skip')
  })

  it('get/set round-trips and the schema rejects bad values', async () => {
    resetConfFactory()
    const state = createState()
    try {
      expect(state.get('lastProvider')).toBe('skip')
      expect(state.get('skippedSteps')).toEqual([])
      expect(state.get('uninstalledAt')).toBeNull()

      state.set('lastProvider', 'minimax')
      expect(state.get('lastProvider')).toBe('minimax')

      state.set('lastInstalledVersion', '1.28.1')
      expect(state.get('lastInstalledVersion')).toBe('1.28.1')

      state.set('skippedSteps', ['build', 'bumblebee'])
      expect(state.get('skippedSteps')).toEqual(['build', 'bumblebee'])

      const stamp = new Date().toISOString()
      state.set('uninstalledAt', stamp)
      expect(state.get('uninstalledAt')).toBe(stamp)

      expect(() => { state.set('lastProvider', 'nincs-ilyen' as InstallerState['lastProvider']) })
        .toThrow(/must be equal to one of the allowed values/)
      expect(() => { state.set('skippedSteps', 'nem-tomb' as unknown as string[]) })
        .toThrow(/must be array/)
      expect(() => { state.set('lastInstalledVersion', 42 as unknown as string) })
        .toThrow(/must be string/)
    } finally {
      await rm(dirname(state.path), { recursive: true, force: true })
    }
  })
})
