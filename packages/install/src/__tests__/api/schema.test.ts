import { describe, it, expect } from 'vitest'
import { SettingsKey, SettingsRequest, VaultId, VaultRequest } from '../../api/schema.js'

describe('api/schema VaultId', () => {
  it('accepts upper-case ids with digits and underscores', () => {
    expect(VaultId.safeParse('ANTHROPIC_API_KEY').success).toBe(true)
    expect(VaultId.safeParse('MINIMAX2_KEY').success).toBe(true)
  })

  it('rejects an empty id', () => {
    expect(VaultId.safeParse('').success).toBe(false)
  })

  it('rejects lower case and punctuation', () => {
    expect(VaultId.safeParse('anthropic_api_key').success).toBe(false)
    expect(VaultId.safeParse('ANTHROPIC-API-KEY').success).toBe(false)
  })

  it('rejects an id longer than 128 characters', () => {
    expect(VaultId.safeParse('A'.repeat(129)).success).toBe(false)
    expect(VaultId.safeParse('A'.repeat(128)).success).toBe(true)
  })
})

describe('api/schema SettingsKey', () => {
  it('accepts an upper-case settings key', () => {
    expect(SettingsKey.safeParse('MINIMAX_BASE_URL').success).toBe(true)
  })

  it('rejects a lower-case settings key', () => {
    expect(SettingsKey.safeParse('minimax_base_url').success).toBe(false)
  })
})

describe('api/schema VaultRequest', () => {
  it('accepts a complete payload', () => {
    const parsed = VaultRequest.safeParse({ id: 'DEEPSEEK_API_KEY', label: 'DeepSeek API key', value: 'x'.repeat(24) })
    expect(parsed.success).toBe(true)
  })

  it('rejects a missing label', () => {
    expect(VaultRequest.safeParse({ id: 'A', value: 'v' }).success).toBe(false)
  })

  it('rejects an empty value', () => {
    expect(VaultRequest.safeParse({ id: 'A', label: 'l', value: '' }).success).toBe(false)
  })

  it('rejects a value over 8192 characters', () => {
    expect(VaultRequest.safeParse({ id: 'A', label: 'l', value: 'x'.repeat(8193) }).success).toBe(false)
  })

  it('rejects a label over 256 characters', () => {
    expect(VaultRequest.safeParse({ id: 'A', label: 'l'.repeat(257), value: 'v' }).success).toBe(false)
  })
})

describe('api/schema SettingsRequest', () => {
  it('accepts a payload with the installer actor', () => {
    expect(SettingsRequest.safeParse({ key: 'OLLAMA_BASE_URL', value: 'http://x', actor: 'installer' }).success).toBe(true)
  })

  it('accepts a payload without an actor', () => {
    expect(SettingsRequest.safeParse({ key: 'OLLAMA_BASE_URL', value: 'http://x' }).success).toBe(true)
  })

  it('rejects a foreign actor', () => {
    expect(SettingsRequest.safeParse({ key: 'A', value: 'v', actor: 'operator' }).success).toBe(false)
  })

  it('rejects a bad key and an over-long value', () => {
    expect(SettingsRequest.safeParse({ key: 'bad key', value: 'v' }).success).toBe(false)
    expect(SettingsRequest.safeParse({ key: 'A', value: 'v'.repeat(4097) }).success).toBe(false)
  })
})
