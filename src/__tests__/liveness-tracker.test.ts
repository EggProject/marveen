import { describe, it, expect } from 'vitest'
import { LivenessTracker } from '../channel-coordinator.js'

describe('streak transitions', () => {
  it('incrementDownStreak returns the new value each call (1, 2, 3, ...)', () => {
    const t = new LivenessTracker()
    expect(t.incrementDownStreak()).toBe(1)
    expect(t.incrementDownStreak()).toBe(2)
    expect(t.incrementDownStreak()).toBe(3)
  })

  it('resetDownStreak returns the counter to 0 -- next incrementDownStreak returns 1', () => {
    const t = new LivenessTracker()
    t.incrementDownStreak()
    t.incrementDownStreak()
    t.incrementDownStreak()
    t.resetDownStreak()
    expect(t.incrementDownStreak()).toBe(1)
  })
})

describe('state machine', () => {
  it('setState transitions and is observable -- idle -> backfilling -> idle', () => {
    const t = new LivenessTracker()
    expect(t.getState()).toBe('idle')
    t.setState('backfilling')
    expect(t.getState()).toBe('backfilling')
    t.setState('idle')
    expect(t.getState()).toBe('idle')
  })

  it('walks DOWN -> backfilling -> idle end-to-end with streak and reset', () => {
    const t = new LivenessTracker()
    // IDLE detection -- first consecutive DOWN probe
    const firstStreak = t.incrementDownStreak()
    expect(firstStreak).toBe(1)
    // Second consecutive DOWN probe crosses the debounce threshold
    const secondStreak = t.incrementDownStreak()
    expect(secondStreak).toBe(2)
    // DOWN confirmed -- enter BACKFILLING
    t.setState('backfilling')
    expect(t.getState()).toBe('backfilling')
    // Native recovered -- yield back to IDLE and clear the streak
    t.yieldToIdle()
    expect(t.getState()).toBe('idle')
    expect(t.incrementDownStreak()).toBe(1)
  })

  it('yieldToIdle transitions to idle AND clears the streak in one call', () => {
    const t = new LivenessTracker()
    t.setState('backfilling')
    t.incrementDownStreak()
    t.incrementDownStreak()
    t.yieldToIdle()
    expect(t.getState()).toBe('idle')
    expect(t.incrementDownStreak()).toBe(1)
  })
})

describe('409 cooldown', () => {
  it('inactive at construction -- confirmedUpUntil defaults to 0, so Date.now() < 0 is false', () => {
    const t = new LivenessTracker()
    expect(t.getNativeConfirmedUpUntil()).toBe(0)
    expect(t.inNative409Cooldown(Date.now())).toBe(false)
    expect(t.inNative409Cooldown(Date.now() + 60_000)).toBe(false)
  })

  it('active after setNativeConfirmedUpUntil with future expiry -- before/at/after the boundary', () => {
    const t = new LivenessTracker()
    const future = Date.now() + 60_000
    t.setNativeConfirmedUpUntil(future)
    expect(t.getNativeConfirmedUpUntil()).toBe(future)
    // Strict `<` boundary: the cooldown is active strictly before the
    // confirmedUpUntil deadline, expired at and after it.
    expect(t.inNative409Cooldown(future - 1)).toBe(true)
    expect(t.inNative409Cooldown(future)).toBe(false)
    expect(t.inNative409Cooldown(future + 1)).toBe(false)
  })
})

describe('shutdown latch', () => {
  it('is idempotent -- first setStopping returns true and flips state; subsequent calls return false; isStopping stays true', () => {
    const t = new LivenessTracker()
    expect(t.isStopping()).toBe(false)
    expect(t.setStopping()).toBe(true)
    expect(t.isStopping()).toBe(true)
    expect(t.setStopping()).toBe(false)
    expect(t.isStopping()).toBe(true)
    expect(t.setStopping()).toBe(false)
    expect(t.isStopping()).toBe(true)
  })
})
