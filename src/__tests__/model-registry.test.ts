import { describe, expect, it } from 'vitest'
import {
  CLAUDE_DEFAULT_MODEL,
  formatCanonicalModelRef,
  getProvider,
  getProviderModels,
  isProviderId,
  isProviderModel,
  ModelRegistryError,
  parseCanonicalModelRef,
  PROVIDERS,
  PROVIDER_IDS,
} from '../providers/registry.js'

describe('model-registry', () => {
  it('exposes the shipped provider set', () => {
    expect(PROVIDER_IDS).toEqual(['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama'])
  })

  it('classifies known providers', () => {
    expect(isProviderId('anthropic')).toBe(true)
    expect(isProviderId('MiniMax')).toBe(false)
    expect(isProviderId('claude')).toBe(false)
  })

  it('rejects malformed canonical refs', () => {
    expect(() => parseCanonicalModelRef('claude-opus-5')).toThrow(ModelRegistryError)
    expect(() => parseCanonicalModelRef('claude:')).toThrow(ModelRegistryError)
    expect(() => parseCanonicalModelRef(':foo')).toThrow(ModelRegistryError)
    expect(() => parseCanonicalModelRef('unknown:foo')).toThrow(ModelRegistryError)
  })

  it('parses and formats canonical refs', () => {
    const ref = parseCanonicalModelRef('anthropic:claude-sonnet-5')
    expect(ref).toEqual({ provider: 'anthropic', model: 'claude-sonnet-5' })
    expect(formatCanonicalModelRef(ref)).toBe('anthropic:claude-sonnet-5')
  })

  it('parses the canonical MiniMax ref', () => {
    const ref = parseCanonicalModelRef('minimax:MiniMax-M3')
    expect(ref).toEqual({ provider: 'minimax', model: 'MiniMax-M3' })
    expect(getProvider('minimax').vaultSecretId).toBe('MINIMAX_API_KEY')
  })

  it.each(['ollama', 'openrouter'] as const)('validates the provider: %s', (id) => {
    expect(PROVIDERS[id]).toBeDefined()
  })

  it('recognises provider model ids', () => {
    expect(isProviderModel('anthropic', 'claude-opus-5')).toBe(true)
    expect(isProviderModel('anthropic', 'MiniMax-M3')).toBe(false)
    expect(isProviderModel('minimax', 'MiniMax-M3')).toBe(true)
    expect(isProviderModel('minimax', 'claude-opus-5')).toBe(false)
    expect(isProviderModel('openrouter', 'meta-llama/llama-3.1-8b-instruct')).toBe(true)
    expect(isProviderModel('openrouter', 'auto:premium_reasoning')).toBe(true)
    expect(isProviderModel('ollama', 'qwen2.5:7b')).toBe(true)
    expect(isProviderModel('ollama', '')).toBe(false)
  })

  it('returns the shipped Claude default model', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-opus-4-8[1m]')
    expect(getProvider('anthropic').models.some((m) => m.id === CLAUDE_DEFAULT_MODEL)).toBe(true)
  })

  it('lists MiniMax models and no extras', () => {
    expect(getProviderModels('minimax').map((m) => m.id)).toEqual(['MiniMax-M3'])
  })
})
