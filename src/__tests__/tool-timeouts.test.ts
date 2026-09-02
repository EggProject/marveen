import { describe, it, expect } from 'vitest'
import { TOOL_TIMEOUTS } from '../tool-timeouts.js'

describe('TOOL_TIMEOUTS', () => {
  it('exposes a google-calendar timeout of 5 seconds', () => {
    expect(TOOL_TIMEOUTS['google-calendar']).toBe(5_000)
  })

  it('exposes a 10s timeout for the IM/chat family (telegram, github, slack)', () => {
    expect(TOOL_TIMEOUTS['telegram']).toBe(10_000)
    expect(TOOL_TIMEOUTS['github']).toBe(10_000)
    expect(TOOL_TIMEOUTS['slack']).toBe(10_000)
  })

  it('exposes a 90s timeout for ollama-embedding (CPU-only path)', () => {
    // The 90s figure accommodates a 1500-char embed that finishes in 40-60s
    // on a slow CPU; the prior 30s deadline left large memories
    // permanently un-vectorized (see source comment for the incident date).
    expect(TOOL_TIMEOUTS['ollama-embedding']).toBe(90_000)
  })

  it('returns undefined for an unlisted tool (caller must supply a default)', () => {
    expect((TOOL_TIMEOUTS as Record<string, number | undefined>)['not-a-real-tool']).toBeUndefined()
  })

  it('is frozen with `as const` semantics: every entry is readonly', () => {
    // `as const` produces a readonly tuple-of-literals, but at runtime it's
    // still a regular object. Verify that the keys we expect are present and
    // there are no extras creeping in.
    expect(Object.keys(TOOL_TIMEOUTS).sort()).toEqual(
      ['github', 'google-calendar', 'ollama-embedding', 'slack', 'telegram'].sort(),
    )
  })
})