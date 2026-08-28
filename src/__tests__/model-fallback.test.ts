import { describe, it, expect } from 'vitest'
import {
  DEFAULT_MODEL_CHAIN,
  DEFAULT_REVERT_AFTER_MINUTES,
  DEFAULT_MODEL_FALLBACK,
  normalizeModelFallbackConfig,
  detectsUsageLimit,
  nextFallbackModel,
  decideModelAction,
  type ModelFallbackFacts,
} from '../model-fallback.js'

const CHAIN = [...DEFAULT_MODEL_CHAIN]
const PRIMARY = CHAIN[0]
const SONNET = CHAIN[1]
const HAIKU = CHAIN[2]

describe('DEFAULT_MODEL_CHAIN', () => {
  it('is a readonly array of resolved model ids with at least a primary + 2 fallbacks', () => {
    expect(Array.isArray(DEFAULT_MODEL_CHAIN)).toBe(true)
    expect(DEFAULT_MODEL_CHAIN.length).toBeGreaterThanOrEqual(3)
    expect(PRIMARY).toBe('claude-opus-4-8[1m]')
    expect(SONNET).toBe('claude-sonnet-5')
    expect(HAIKU).toBe('claude-haiku-4-5-20251001')
  })
})

describe('DEFAULT_REVERT_AFTER_MINUTES', () => {
  it('is the 330-minute default (well past the 5h plan window)', () => {
    expect(typeof DEFAULT_REVERT_AFTER_MINUTES).toBe('number')
    expect(Number.isInteger(DEFAULT_REVERT_AFTER_MINUTES)).toBe(true)
    expect(DEFAULT_REVERT_AFTER_MINUTES).toBe(330)
  })
})

describe('DEFAULT_MODEL_FALLBACK', () => {
  it('is the disabled default config assembled from the constants above', () => {
    expect(DEFAULT_MODEL_FALLBACK).toEqual({
      enabled: false,
      chain: [...DEFAULT_MODEL_CHAIN],
      revertAfterMinutes: DEFAULT_REVERT_AFTER_MINUTES,
    })
  })
})

describe('detectsUsageLimit', () => {
  it('returns false for empty input', () => {
    expect(detectsUsageLimit('')).toBe(false)
  })

  it('returns false for whitespace-only input', () => {
    expect(detectsUsageLimit('   \n\n\t  ')).toBe(false)
  })

  it('matches "usage limit reached" in the live region', () => {
    expect(detectsUsageLimit('You have Usage limit reached.')).toBe(true)
  })

  it('matches "reached your usage limit" in the live region', () => {
    expect(detectsUsageLimit('You have reached your usage limit.')).toBe(true)
  })

  it('matches "hit your usage limit" in the live region', () => {
    expect(detectsUsageLimit('You have hit your usage limit.')).toBe(true)
  })

  it('matches "hit the usage limit" in the live region', () => {
    expect(detectsUsageLimit('You have hit the usage limit for the day.')).toBe(true)
  })

  it('matches "approaching usage limit" in the live region', () => {
    expect(detectsUsageLimit('You are approaching usage limit.')).toBe(true)
  })

  it('matches "approaching your usage limit" in the live region', () => {
    expect(detectsUsageLimit('You are approaching your usage limit.')).toBe(true)
  })

  it('matches "usage limit reset" in the live region', () => {
    expect(detectsUsageLimit('Your usage limit reset time is 18:00.')).toBe(true)
  })

  it('matches "usage limit will reset" in the live region', () => {
    expect(detectsUsageLimit('Your usage limit will reset soon.')).toBe(true)
  })

  it('matches "limit will reset at" in the live region', () => {
    expect(detectsUsageLimit('Your limit will reset at midnight.')).toBe(true)
  })

  it('matches "N-hour limit reached" in the live region', () => {
    expect(detectsUsageLimit('5-hour limit reached ∙ resets 3pm')).toBe(true)
  })

  it('matches "upgrade to increase your usage limit" in the live region', () => {
    expect(detectsUsageLimit('/upgrade to increase your usage limit')).toBe(true)
  })

  it('matches case-insensitively (banner shouting in the live region)', () => {
    expect(detectsUsageLimit('USAGE LIMIT REACHED')).toBe(true)
  })

  it('ignores the phrase when it is only in scrollback, outside the bottom 15-line region', () => {
    const scrollback = [
      'you reached your usage limit',
      ...Array(40).fill('normal output line'),
    ].join('\n')
    expect(detectsUsageLimit(scrollback)).toBe(false)
  })

  it('still matches when the phrase lives inside the bottom 15-line region', () => {
    const padded = [...Array(14).fill('normal output line'), 'reached your usage limit'].join('\n')
    expect(detectsUsageLimit(padded)).toBe(true)
  })

  it('matches at the 15-line boundary itself', () => {
    const padded = [...Array(13).fill('normal output line'), 'normal output line', 'reached your usage limit'].join('\n')
    expect(detectsUsageLimit(padded)).toBe(true)
  })

  it('does NOT match a transient API 429 / generic rate limit', () => {
    expect(detectsUsageLimit('  ⎿  API Error: 429 rate_limit_error: too many requests')).toBe(false)
    expect(detectsUsageLimit('  ⎿  API Error: 429 overloaded_error: server busy, retrying')).toBe(false)
  })

  it('does NOT match a plain "rate limit exceeded" that lacks "usage"', () => {
    expect(detectsUsageLimit('Rate limit exceeded; backing off 60s.')).toBe(false)
  })
})

describe('nextFallbackModel', () => {
  it('walks one step down the chain from the primary', () => {
    expect(nextFallbackModel(PRIMARY, CHAIN)).toBe(SONNET)
  })

  it('walks one step down from the first fallback to the second', () => {
    expect(nextFallbackModel(SONNET, CHAIN)).toBe(HAIKU)
  })

  it('returns null at the bottom of the chain', () => {
    expect(nextFallbackModel(HAIKU, CHAIN)).toBeNull()
  })

  it('treats an unknown current model as the primary and returns chain[1]', () => {
    expect(nextFallbackModel('some-unknown-model', CHAIN)).toBe(SONNET)
  })

  it('returns null for a chain of length 1', () => {
    expect(nextFallbackModel(PRIMARY, [PRIMARY])).toBeNull()
  })

  it('returns null for an empty chain', () => {
    expect(nextFallbackModel(PRIMARY, [])).toBeNull()
  })

  it('returns null when the unknown-model branch falls off an empty chain[1]', () => {
    // chain.length < 2 wins first; this guards the `chain[1] ?? null` arm
    // against a length-1 chain where indexOf is -1 AND there is no fallback.
    expect(nextFallbackModel('alien-model', ['opus'])).toBeNull()
  })

  it('returns null when chain[1] is undefined (sparse chain) and the current model is unknown', () => {
    // Defensive `?? null` arm: a caller hands us a sparse array where
    // chain.length >= 2 but chain[1] is missing. We must collapse it to null
    // rather than returning undefined.
    const sparse: string[] = ['opus']
    sparse.length = 5 // holes at indices 1..4
    expect(sparse.length).toBe(5)
    expect(sparse[1]).toBeUndefined()
    expect(nextFallbackModel('alien-model', sparse)).toBeNull()
  })
})

describe('decideModelAction', () => {
  const base: ModelFallbackFacts = {
    limitDetected: false,
    currentModel: PRIMARY,
    chain: CHAIN,
    downgradedAt: null,
    now: 1_000_000,
    revertAfterMs: 60_000,
  }

  it('downgrades from the primary when a limit is detected', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'downgrade', model: SONNET })
  })

  it('downgrades from the first fallback when a limit is detected', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: SONNET, downgradedAt: 500_000 }))
      .toEqual({ kind: 'downgrade', model: HAIKU })
  })

  it('returns none when the limit is detected at the bottom of the chain', () => {
    expect(decideModelAction({ ...base, limitDetected: true, currentModel: HAIKU, downgradedAt: 500_000 }))
      .toEqual({ kind: 'none' })
  })

  it('returns none when the limit is detected but the chain has no fallback', () => {
    expect(decideModelAction({
      ...base,
      limitDetected: true,
      currentModel: PRIMARY,
      chain: [PRIMARY],
    })).toEqual({ kind: 'none' })
  })

  it('returns none when the next fallback happens to equal the current model (defensive guard)', () => {
    // contrived duplicate in chain: chain[1] === current -- we must NOT issue
    // a "downgrade" to itself.
    expect(decideModelAction({
      ...base,
      limitDetected: true,
      currentModel: PRIMARY,
      chain: [PRIMARY, PRIMARY],
    })).toEqual({ kind: 'none' })
  })

  it('prefers downgrade over revert when both conditions look applicable (limit wins)', () => {
    // The limit-detected branch is evaluated first; even though the revert
    // window has also elapsed, we must downgrade, not revert.
    const downgradedAt = base.now - base.revertAfterMs - 1
    expect(decideModelAction({
      ...base,
      limitDetected: true,
      currentModel: PRIMARY,
      downgradedAt,
    })).toEqual({ kind: 'downgrade', model: SONNET })
  })

  it('reverts to the primary once the window has elapsed AND the limit is gone', () => {
    const downgradedAt = base.now - base.revertAfterMs - 1
    expect(decideModelAction({
      ...base,
      limitDetected: false,
      currentModel: HAIKU,
      downgradedAt,
    })).toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('treats the window boundary itself as elapsed (>= comparison)', () => {
    const downgradedAt = base.now - base.revertAfterMs
    expect(decideModelAction({
      ...base,
      limitDetected: false,
      currentModel: SONNET,
      downgradedAt,
    })).toEqual({ kind: 'revert', model: PRIMARY })
  })

  it('does not revert before the window has fully elapsed', () => {
    const downgradedAt = base.now - (base.revertAfterMs - 1)
    expect(decideModelAction({
      ...base,
      limitDetected: false,
      currentModel: SONNET,
      downgradedAt,
    })).toEqual({ kind: 'none' })
  })

  it('does not revert when the agent is already on the primary, even past the window', () => {
    expect(decideModelAction({
      ...base,
      limitDetected: false,
      currentModel: PRIMARY,
      downgradedAt: 0,
    })).toEqual({ kind: 'none' })
  })

  it('does nothing when on the primary with no downgrade history and no limit', () => {
    expect(decideModelAction({ ...base, limitDetected: false, currentModel: PRIMARY, downgradedAt: null }))
      .toEqual({ kind: 'none' })
  })

  it('does nothing when limit-free but downgradedAt is null (never downgraded)', () => {
    expect(decideModelAction({
      ...base,
      limitDetected: false,
      currentModel: SONNET,
      downgradedAt: null,
    })).toEqual({ kind: 'none' })
  })

  it('does nothing on a chain with no primary entry (empty chain)', () => {
    expect(decideModelAction({
      ...base,
      limitDetected: false,
      currentModel: SONNET,
      chain: [],
      downgradedAt: base.now - base.revertAfterMs - 1,
    })).toEqual({ kind: 'none' })
  })
})

describe('normalizeModelFallbackConfig', () => {
  it('returns the defaults when raw is null', () => {
    expect(normalizeModelFallbackConfig(null)).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('returns the defaults when raw is undefined', () => {
    expect(normalizeModelFallbackConfig(undefined)).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('returns the defaults when raw is a string (not an object)', () => {
    expect(normalizeModelFallbackConfig('nope')).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('returns the defaults when raw is a number primitive', () => {
    expect(normalizeModelFallbackConfig(42)).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('returns the defaults when raw is a boolean primitive', () => {
    expect(normalizeModelFallbackConfig(true)).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('returns the defaults for an empty object', () => {
    expect(normalizeModelFallbackConfig({})).toEqual(DEFAULT_MODEL_FALLBACK)
  })

  it('honors enabled=true', () => {
    const out = normalizeModelFallbackConfig({ enabled: true })
    expect(out.enabled).toBe(true)
  })

  it('honors enabled=false', () => {
    const out = normalizeModelFallbackConfig({ enabled: false })
    expect(out.enabled).toBe(false)
  })

  it('rejects enabled=true as a string-coerced truthy (must be literal true)', () => {
    const out = normalizeModelFallbackConfig({ enabled: 'true' })
    expect(out.enabled).toBe(false)
  })

  it('rejects enabled=1 (numeric truthy is not the literal true)', () => {
    const out = normalizeModelFallbackConfig({ enabled: 1 })
    expect(out.enabled).toBe(false)
  })

  it('keeps the default chain when raw.chain is a string', () => {
    const out = normalizeModelFallbackConfig({ chain: 'opus,sonnet' })
    expect(out.chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
  })

  it('keeps the default chain when raw.chain is an empty array', () => {
    const out = normalizeModelFallbackConfig({ chain: [] })
    expect(out.chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
  })

  it('keeps the default chain when raw.chain has only one surviving trimmed entry', () => {
    const out = normalizeModelFallbackConfig({ chain: ['only-one'] })
    expect(out.chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
  })

  it('keeps the default chain when raw.chain is all blanks/whitespace', () => {
    const out = normalizeModelFallbackConfig({ chain: ['', '   ', '\t'] })
    expect(out.chain).toEqual(DEFAULT_MODEL_FALLBACK.chain)
  })

  it('drops blanks and non-string entries, keeping valid strings when >= 2 survive', () => {
    const out = normalizeModelFallbackConfig({ chain: ['a', 2 as unknown as string, '', 'b'] })
    expect(out.chain).toEqual(['a', 'b'])
  })

  it('drops blanks while keeping non-blank strings when the cleaned chain has >= 2 entries', () => {
    const out = normalizeModelFallbackConfig({ chain: ['', '   ', 'a', 'b'] })
    expect(out.chain).toEqual(['a', 'b'])
  })

  it('preserves a valid override chain verbatim', () => {
    const out = normalizeModelFallbackConfig({ chain: ['a', 'b', 'c'] })
    expect(out.chain).toEqual(['a', 'b', 'c'])
  })

  it('keeps the default revertAfterMinutes when it is missing', () => {
    const out = normalizeModelFallbackConfig({})
    expect(out.revertAfterMinutes).toBe(DEFAULT_REVERT_AFTER_MINUTES)
  })

  it('keeps the default revertAfterMinutes when it is a non-number string', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: '30' })
    expect(out.revertAfterMinutes).toBe(DEFAULT_REVERT_AFTER_MINUTES)
  })

  it('keeps the default revertAfterMinutes when it is NaN', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: Number.NaN })
    expect(out.revertAfterMinutes).toBe(DEFAULT_REVERT_AFTER_MINUTES)
  })

  it('keeps the default revertAfterMinutes when it is +Infinity', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: Number.POSITIVE_INFINITY })
    expect(out.revertAfterMinutes).toBe(DEFAULT_REVERT_AFTER_MINUTES)
  })

  it('keeps the default revertAfterMinutes when it is -Infinity', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: Number.NEGATIVE_INFINITY })
    expect(out.revertAfterMinutes).toBe(DEFAULT_REVERT_AFTER_MINUTES)
  })

  it('keeps the default revertAfterMinutes when it is zero (must be > 0)', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: 0 })
    expect(out.revertAfterMinutes).toBe(DEFAULT_REVERT_AFTER_MINUTES)
  })

  it('keeps the default revertAfterMinutes when it is negative', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: -5 })
    expect(out.revertAfterMinutes).toBe(DEFAULT_REVERT_AFTER_MINUTES)
  })

  it('floors a positive decimal revertAfterMinutes down to an integer', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: 12.9 })
    expect(out.revertAfterMinutes).toBe(12)
  })

  it('accepts a positive integer revertAfterMinutes verbatim', () => {
    const out = normalizeModelFallbackConfig({ revertAfterMinutes: 120 })
    expect(out.revertAfterMinutes).toBe(120)
  })

  it('returns a fully custom config when every field is well-formed', () => {
    const cfg = normalizeModelFallbackConfig({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
    expect(cfg).toEqual({ enabled: true, chain: ['a', 'b', 'c'], revertAfterMinutes: 120 })
  })
})
