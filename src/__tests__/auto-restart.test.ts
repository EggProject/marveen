import { describe, it, expect, vi } from 'vitest'
import {
  parseHHMM,
  normalizeAutoRestartConfig,
  restartDue,
  dailyDueAtMs,
  mainRestartMechanism,
  DEFAULT_AUTO_RESTART,
} from '../auto-restart.js'

describe('mainRestartMechanism', () => {
  it('returns launchd when launchctl is present (macOS path)', () => {
    expect(mainRestartMechanism(true)).toBe('launchd')
  })

  it('returns tmux-respawn when launchctl is absent (Linux/non-launchd path)', () => {
    expect(mainRestartMechanism(false)).toBe('tmux-respawn')
  })
})

describe('parseHHMM', () => {
  it('parses valid times to minutes since midnight', () => {
    expect(parseHHMM('00:00')).toBe(0)
    expect(parseHHMM('03:00')).toBe(180)
    expect(parseHHMM('23:59')).toBe(23 * 60 + 59)
    expect(parseHHMM('9:30')).toBe(570)
  })
  it('rejects malformed or out-of-range values', () => {
    for (const bad of ['', '3', '24:00', '12:60', '-1:00', 'aa:bb', '12:5', 12 as unknown, null]) {
      expect(parseHHMM(bad as unknown)).toBeNull()
    }
  })
})

describe('normalizeAutoRestartConfig', () => {
  it('returns safe defaults for junk input', () => {
    expect(normalizeAutoRestartConfig(null)).toEqual(DEFAULT_AUTO_RESTART)
    expect(normalizeAutoRestartConfig('nope')).toEqual(DEFAULT_AUTO_RESTART)
    expect(normalizeAutoRestartConfig({})).toEqual(DEFAULT_AUTO_RESTART)
  })
  it('keeps a valid daily config and clears interval (daily wins)', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: 6, handoff: true })
    expect(c).toEqual({ enabled: true, mode: 'fresh', dailyTime: '03:00', intervalHours: null, handoff: true })
  })
  it('keeps a valid interval config when no daily time', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, mode: 'continue', intervalHours: 8 })
    expect(c).toEqual({ enabled: true, mode: 'continue', dailyTime: null, intervalHours: 8, handoff: false })
  })
  it('drops an invalid dailyTime and non-positive interval', () => {
    const c = normalizeAutoRestartConfig({ enabled: true, dailyTime: '99:99', intervalHours: 0 })
    expect(c.dailyTime).toBeNull()
    expect(c.intervalHours).toBeNull()
  })
  it('defaults mode to continue for an unknown mode', () => {
    expect(normalizeAutoRestartConfig({ mode: 'wild' }).mode).toBe('continue')
  })
  it('drops non-finite interval values (NaN, Infinity)', () => {
    expect(normalizeAutoRestartConfig({ intervalHours: Number.NaN }).intervalHours).toBeNull()
    expect(normalizeAutoRestartConfig({ intervalHours: Number.POSITIVE_INFINITY }).intervalHours).toBeNull()
    expect(normalizeAutoRestartConfig({ intervalHours: Number.NEGATIVE_INFINITY }).intervalHours).toBeNull()
  })
  it('drops non-numeric interval values (string, boolean)', () => {
    expect(normalizeAutoRestartConfig({ intervalHours: '8' as unknown }).intervalHours).toBeNull()
    expect(normalizeAutoRestartConfig({ intervalHours: true as unknown }).intervalHours).toBeNull()
  })
  it('drops negative interval even though typeof === number and isFinite', () => {
    expect(normalizeAutoRestartConfig({ intervalHours: -3 }).intervalHours).toBeNull()
  })
  it('keeps a positive, finite interval when no daily time is set', () => {
    expect(normalizeAutoRestartConfig({ intervalHours: 1.5 }).intervalHours).toBe(1.5)
  })
  it('keeps the trimmed dailyTime string when valid', () => {
    const c = normalizeAutoRestartConfig({ dailyTime: '  09:30  ' })
    expect(c.dailyTime).toBe('09:30')
    expect(c.intervalHours).toBeNull()
  })
  it('treats a missing falsy enabled/handoff flags as false', () => {
    expect(normalizeAutoRestartConfig({ enabled: false, handoff: false }).enabled).toBe(false)
    expect(normalizeAutoRestartConfig({ enabled: false, handoff: false }).handoff).toBe(false)
    expect(normalizeAutoRestartConfig({ enabled: 1 as unknown, handoff: 'yes' as unknown }).enabled).toBe(false)
    expect(normalizeAutoRestartConfig({ enabled: 1 as unknown, handoff: 'yes' as unknown }).handoff).toBe(false)
  })
})

describe('restartDue', () => {
  const DUE = 1_000_000

  it('is not due before the scheduled time', () => {
    expect(restartDue(null, DUE - 1, DUE)).toBe(false)
  })
  it('is due at/after the scheduled time when never restarted', () => {
    expect(restartDue(null, DUE, DUE)).toBe(true)
    expect(restartDue(null, DUE + 5_000, DUE)).toBe(true)
  })
  it('does not re-fire once restarted at/after the due point', () => {
    expect(restartDue(DUE, DUE + 5_000, DUE)).toBe(false)
    expect(restartDue(DUE + 1, DUE + 5_000, DUE)).toBe(false)
  })
  it('fires again for a later due point even if restarted at an earlier one', () => {
    const earlier = DUE - 86_400_000 // yesterday's restart
    expect(restartDue(earlier, DUE + 1, DUE)).toBe(true)
  })
  it('is never due for a non-finite dueAt', () => {
    expect(restartDue(null, DUE, Number.NaN)).toBe(false)
    expect(restartDue(null, DUE, Number.POSITIVE_INFINITY)).toBe(false)
  })
})

describe('dailyDueAtMs', () => {
  it('adds the minutes-since-midnight offset to local midnight', () => {
    const midnight = 1_700_000_000_000
    expect(dailyDueAtMs(midnight, 0)).toBe(midnight)
    expect(dailyDueAtMs(midnight, 180)).toBe(midnight + 180 * 60_000) // 03:00
  })
})