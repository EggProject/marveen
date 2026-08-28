import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  setLastInboundModality,
  getLastInboundModality,
  clearLastInboundModality,
} from '../web/voice-modality.js'

// The voice-modality module is a process-local TTL store. The store is a
// module-scope Map, so each test must clear it before running to avoid bleed.
// TTL is 10 minutes (10 * 60 * 1000 ms); we exercise the boundary with fake
// timers so the test is deterministic.

const TEN_MIN_MS = 10 * 60 * 1000

beforeEach(() => {
  // Clear every key we might have touched. Cheap because the store is a Map.
  clearLastInboundModality('agent-a', 'chat-1')
  clearLastInboundModality('agent-a', 42)
  clearLastInboundModality('agent-b', 'chat-1')
  clearLastInboundModality('', '')
})

afterEach(() => {
  vi.useRealTimers()
})

describe('setLastInboundModality', () => {
  it('stores a voice modality for a string chatId', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('voice')
  })

  it('stores a text modality for a string chatId', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'text')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('text')
  })

  it('stores a modality for a numeric chatId', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 42, 'voice')
    expect(getLastInboundModality('agent-a', 42)).toBe('voice')
  })

  it('overwrites an existing entry for the same (agentId, chatId) pair', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    // advance but stay within TTL; overwrite must keep the entry fresh
    vi.setSystemTime(new Date('2026-01-01T00:05:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'text')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('text')
  })

  it('keeps entries for different (agentId, chatId) pairs isolated', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    setLastInboundModality('agent-a', 42, 'text')
    setLastInboundModality('agent-b', 'chat-1', 'voice')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('voice')
    expect(getLastInboundModality('agent-a', 42)).toBe('text')
    expect(getLastInboundModality('agent-b', 'chat-1')).toBe('voice')
  })
})

describe('getLastInboundModality', () => {
  it('returns null when no entry has been set', () => {
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
  })

  it('returns null when the entry has expired and removes the dead key', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    // jump past the 10-minute TTL
    vi.setSystemTime(new Date('2026-01-01T00:10:01Z'))
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
    // the expired entry must have been removed from the store; a follow-up
    // call must not see it either
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
  })

  it('returns the stored value when within the TTL window', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    vi.setSystemTime(new Date('2026-01-01T00:09:59Z'))
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('voice')
  })

  it('returns the stored value at exactly the TTL boundary (comparator is strict)', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'text')
    // exactly TEN_MIN_MS elapsed -> the comparator is `> TTL_MS`, so an
    // entry that is exactly TTL_MS old is still considered fresh
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z').getTime() + TEN_MIN_MS)
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('text')
  })

  it('returns null one millisecond past the TTL boundary', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z').getTime() + TEN_MIN_MS + 1)
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
  })
})

describe('clearLastInboundModality', () => {
  it('removes an existing entry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('voice')
    clearLastInboundModality('agent-a', 'chat-1')
    expect(getLastInboundModality('agent-a', 'chat-1')).toBeNull()
  })

  it('is a no-op when the entry does not exist', () => {
    // must not throw and must leave any unrelated entry untouched
    setLastInboundModality('agent-a', 'chat-1', 'voice')
    expect(() => clearLastInboundModality('agent-b', 'chat-1')).not.toThrow()
    expect(getLastInboundModality('agent-a', 'chat-1')).toBe('voice')
  })

  it('removes a numeric-chatId entry', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    setLastInboundModality('agent-a', 42, 'voice')
    expect(getLastInboundModality('agent-a', 42)).toBe('voice')
    clearLastInboundModality('agent-a', 42)
    expect(getLastInboundModality('agent-a', 42)).toBeNull()
  })
})
