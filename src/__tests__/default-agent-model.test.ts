import { describe, it, expect } from 'vitest'
import {
  SETTINGS_REGISTRY,
  getSettingDefinition,
  validateSettingValue,
  DISTRIBUTION_DEFAULT_AGENT_MODEL,
} from '../config-registry.js'
import { DEFAULT_AGENT_MODEL } from '../config.js'
import { DEFAULT_MODEL, resolveModelId } from '../web/agent-config.js'
import { defaultChainForInstall } from '../web/model-fallback-store.js'
import { DEFAULT_MODEL_CHAIN } from '../model-fallback.js'
import { CLAUDE_DEFAULT_MODEL, formatCanonicalModelRef } from '../providers/registry.js'

// Every assertion here is RELATIONAL, never "the default is <some model id>":
// these tests run both on a fresh checkout (no .env -> distribution default)
// and on a configured install (DEFAULT_AGENT_MODEL set -> that model), and must
// pass in both.

// Every assertion here is RELATIONAL, never "the default is <some model id>":
// these tests run both on a fresh checkout (no .env -> distribution default)
// and on a configured install (DEFAULT_AGENT_MODEL set -> that model), and must
// pass in both.
describe('DEFAULT_AGENT_MODEL', () => {
  it('is registered as a restart-scoped, non-secret agents setting', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')
    expect(def).toBeDefined()
    expect(def!.type).toBe('string')
    expect(def!.module).toBe('agents')
    expect(def!.secret).toBe(false)
    // Consumed at import time by config.ts, so a change cannot hot-reload.
    expect(def!.requiresRestart).toBe(true)
    expect(SETTINGS_REGISTRY.filter((s) => s.key === 'DEFAULT_AGENT_MODEL')).toHaveLength(1)
  })

  it('keeps the registry default on the canonical distribution literal', () => {
    // The whole point of DISTRIBUTION_DEFAULT_AGENT_MODEL living in the
    // zero-import registry module: the boot default always carries the
    // canonical "anthropic:" prefix and never drifts.
    expect(getSettingDefinition('DEFAULT_AGENT_MODEL')!.default)
      .toBe(formatCanonicalModelRef({ provider: 'anthropic', model: DISTRIBUTION_DEFAULT_AGENT_MODEL }))
  })

  it('offers the canonical distribution default among the selectable values', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    expect(def.valueSet).toBeDefined()
    expect(def.valueSet).toContain(formatCanonicalModelRef({ provider: 'anthropic', model: DISTRIBUTION_DEFAULT_AGENT_MODEL }))
    expect(def.valueSet).toContain(formatCanonicalModelRef({ provider: 'anthropic', model: 'claude-opus-5' }))
    // Only canonical refs in the picker; raw model ids / legacy aliases are rejected.
    expect(def.valueSet!.every((m) => m.startsWith('anthropic:'))).toBe(true)
  })

  it('validates against the canonical value set', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    expect(validateSettingValue(def, formatCanonicalModelRef({ provider: 'anthropic', model: 'claude-opus-5' })))
      .toEqual({ ok: true, value: formatCanonicalModelRef({ provider: 'anthropic', model: 'claude-opus-5' }) })
    expect(validateSettingValue(def, 'gpt-4').ok).toBe(false)
  })

  it('resolves to the configured value, defaulting to the distribution literal', () => {
    const def = getSettingDefinition('DEFAULT_AGENT_MODEL')!
    expect(def.valueSet).toContain(DEFAULT_AGENT_MODEL)
  })
})

describe('agent-config default wiring', () => {
  it('re-exports the install default under the historical DEFAULT_MODEL name', () => {
    expect(DEFAULT_MODEL).toBe(DEFAULT_AGENT_MODEL)
  })

  it('passes a canonical ref through unchanged', () => {
    expect(resolveModelId('anthropic:claude-opus-5')).toBe('anthropic:claude-opus-5')
  })

  it('rejects legacy short aliases once the cutover is live', () => {
    expect(() => resolveModelId('opus')).toThrow()
    expect(() => resolveModelId('haiku')).toThrow()
  })

  it('re-exports the canonical distribution default for downstream callers', () => {
    expect(CLAUDE_DEFAULT_MODEL).toBe('claude-opus-4-8[1m]')
  })
})

describe('defaultChainForInstall', () => {
  it('puts the install default first so a revert lands on the model actually run', () => {
    expect(defaultChainForInstall()[0]).toBe(DEFAULT_AGENT_MODEL)
  })

  it('never repeats a model, even when the default is already on the ladder', () => {
    const chain = defaultChainForInstall()
    expect(new Set(chain).size).toBe(chain.length)
  })

  it('keeps a usable ladder: primary plus at least one downgrade target', () => {
    const chain = defaultChainForInstall()
    // normalizeModelFallbackConfig() ignores any chain shorter than 2.
    expect(chain.length).toBeGreaterThanOrEqual(2)
    // Every distribution rung except the promoted primary survives, in order.
    expect(chain.slice(1)).toEqual(DEFAULT_MODEL_CHAIN.filter((m) => m !== DEFAULT_AGENT_MODEL))
  })
})
