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

  it('ships an empty extraEnvVars for providers that need no provider-specific tunings', () => {
    // Anthropic / DeepSeek / OpenRouter / Ollama carry no Claude Code
    // tunings beyond the 3 core env vars; the runtime shell fragment
    // builder must skip the extraEnvVars loop on those entries.
    expect(getProvider('anthropic').extraEnvVars).toEqual({})
    expect(getProvider('deepseek').extraEnvVars).toEqual({})
    expect(getProvider('openrouter').extraEnvVars).toEqual({})
    expect(getProvider('ollama').extraEnvVars).toEqual({})
  })

  it('ships the MiniMax provider-specific tunings for the 1M-context M3 model', () => {
    // The MiniMax M3 + 1M-context variant needs a fixed set of Claude Code
    // env vars on every invocation; any omission leaves the model unusable.
    // The list is the contract, not the rationale -- see provider-runtime
    // tests for the shell-fragment emission contract.
    expect(getProvider('minimax').extraEnvVars).toEqual({
      API_TIMEOUT_MS: '3000000',
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3[1m]',
      ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3[1m]',
      ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: '1000000',
      CLAUDE_CODE_ALWAYS_ENABLE_EFFORT: '1',
      CLAUDE_AUTOCOMPACT_PCT_OVERRIDE: '50',
      CLAUDE_CODE_DISABLE_FAST_MODE: '1',
    })
  })
})
