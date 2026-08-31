import { describe, it, expect } from 'vitest'
import {
  AutoRestartSchedule,
  DEFAULT_AUTO_RESTART,
  mainRestartMechanism,
  parseHHMM,
  normalizeAutoRestartConfig,
  restartDue,
  dailyDueAtMs,
} from '../auto-restart.js'

// Anti-vacuous regression suite for the AutoRestartSchedule class form.
//
// Each assertion must FAIL if the implementation were stubbed to a constant
// return (e.g. `() => 0`, `() => null`, `() => true`). The equivalence
// assertions also catch wrapper-vs-class drift: if a wrapper returned a copy
// or a re-derived value, `AutoRestartSchedule.X(args) === X(args)` would
// fail. The DEFAULT referential check catches accidental spreads.

describe('AutoRestartSchedule static methods', () => {
  describe('mainRestartMechanism', () => {
    it('returns launchd when launchctl is present', () => {
      expect(AutoRestartSchedule.mainRestartMechanism(true)).toBe('launchd')
    })
    it('returns tmux-respawn when launchctl is absent', () => {
      expect(AutoRestartSchedule.mainRestartMechanism(false)).toBe('tmux-respawn')
    })
    it('is not vacuous (false does not yield launchd)', () => {
      expect(AutoRestartSchedule.mainRestartMechanism(false)).not.toBe('launchd')
    })
  })

  describe('parseHHMM', () => {
    it('parses 03:00 as 180 minutes since midnight', () => {
      expect(AutoRestartSchedule.parseHHMM('03:00')).toBe(180)
    })
    it('rejects an out-of-range HH:MM (99:99) as null', () => {
      expect(AutoRestartSchedule.parseHHMM('99:99')).toBeNull()
    })
    it('parses 00:00 as 0', () => {
      expect(AutoRestartSchedule.parseHHMM('00:00')).toBe(0)
    })
    it('rejects non-string input as null', () => {
      expect(AutoRestartSchedule.parseHHMM(null)).toBeNull()
      expect(AutoRestartSchedule.parseHHMM(42)).toBeNull()
    })
  })

  describe('normalizeAutoRestartConfig', () => {
    it('fills missing fields with the documented defaults', () => {
      expect(
        AutoRestartSchedule.normalizeAutoRestartConfig({
          enabled: true,
          mode: 'fresh',
          dailyTime: '03:00',
        }),
      ).toEqual({
        enabled: true,
        mode: 'fresh',
        dailyTime: '03:00',
        intervalHours: null,
        handoff: false,
      })
    })
    it('clears intervalHours when dailyTime is set (daily wins)', () => {
      const c = AutoRestartSchedule.normalizeAutoRestartConfig({
        enabled: true,
        mode: 'fresh',
        dailyTime: '03:00',
        intervalHours: 6,
        handoff: true,
      })
      expect(c.dailyTime).toBe('03:00')
      expect(c.intervalHours).toBeNull()
    })
    it('keeps a positive, finite intervalHours when no daily time is set', () => {
      const c = AutoRestartSchedule.normalizeAutoRestartConfig({
        enabled: true,
        mode: 'continue',
        intervalHours: 8,
      })
      expect(c.intervalHours).toBe(8)
    })
    it('drops a non-finite intervalHours to null', () => {
      const c = AutoRestartSchedule.normalizeAutoRestartConfig({ intervalHours: Number.NaN })
      expect(c.intervalHours).toBeNull()
    })
    it('returns safe defaults for null input', () => {
      expect(AutoRestartSchedule.normalizeAutoRestartConfig(null)).toEqual(DEFAULT_AUTO_RESTART)
    })
  })

  describe('restartDue', () => {
    it('is due when never restarted and now is at the scheduled time', () => {
      expect(AutoRestartSchedule.restartDue(null, 1_000_000, 1_000_000)).toBe(true)
    })
    it('is not due when lastRestart is at or after dueAtMs', () => {
      expect(AutoRestartSchedule.restartDue(1_000_000, 1_005_000, 1_000_000)).toBe(false)
    })
    it('is not due when nowMs is strictly before dueAtMs', () => {
      expect(AutoRestartSchedule.restartDue(null, 999_999, 1_000_000)).toBe(false)
    })
    it('is not due for a non-finite dueAtMs', () => {
      expect(AutoRestartSchedule.restartDue(null, 1_000_000, Number.NaN)).toBe(false)
      expect(AutoRestartSchedule.restartDue(null, 1_000_000, Number.POSITIVE_INFINITY)).toBe(false)
    })
  })

  describe('dailyDueAtMs', () => {
    it('adds minutes-since-midnight to local midnight (180 -> 180 * 60_000)', () => {
      expect(AutoRestartSchedule.dailyDueAtMs(0, 180)).toBe(180 * 60_000)
    })
    it('returns localMidnightMs unchanged for 0 minutes', () => {
      expect(AutoRestartSchedule.dailyDueAtMs(1_700_000_000_000, 0)).toBe(1_700_000_000_000)
    })
  })
})

describe('AutoRestartSchedule wrapper equivalence', () => {
  // Each `AutoRestartSchedule.X(args) === X(args)` would fail if the wrapper
  // returned a copy, a different value, or the wrappers themselves diverged
  // from the class methods (e.g. one refactored and the other forgotten).
  it('mainRestartMechanism: class and wrapper agree', () => {
    expect(AutoRestartSchedule.mainRestartMechanism(true)).toBe(mainRestartMechanism(true))
    expect(AutoRestartSchedule.mainRestartMechanism(false)).toBe(mainRestartMechanism(false))
  })
  it('parseHHMM: class and wrapper agree', () => {
    expect(AutoRestartSchedule.parseHHMM('03:00')).toBe(parseHHMM('03:00'))
    expect(AutoRestartSchedule.parseHHMM('23:59')).toBe(parseHHMM('23:59'))
    expect(AutoRestartSchedule.parseHHMM('bogus')).toBe(parseHHMM('bogus'))
  })
  it('normalizeAutoRestartConfig: class and wrapper agree', () => {
    const input = { enabled: true, mode: 'fresh' as const, dailyTime: '03:00', intervalHours: 6, handoff: true }
    expect(AutoRestartSchedule.normalizeAutoRestartConfig(input)).toEqual(
      normalizeAutoRestartConfig(input),
    )
  })
  it('restartDue: class and wrapper agree', () => {
    expect(AutoRestartSchedule.restartDue(null, 1_000_000, 1_000_000)).toBe(restartDue(null, 1_000_000, 1_000_000))
    expect(AutoRestartSchedule.restartDue(1_000_000, 1_005_000, 1_000_000)).toBe(restartDue(1_000_000, 1_005_000, 1_000_000))
  })
  it('dailyDueAtMs: class and wrapper agree', () => {
    expect(AutoRestartSchedule.dailyDueAtMs(0, 180)).toBe(dailyDueAtMs(0, 180))
    expect(AutoRestartSchedule.dailyDueAtMs(1_700_000_000_000, 0)).toBe(dailyDueAtMs(1_700_000_000_000, 0))
  })
})

describe('AutoRestartSchedule.DEFAULT', () => {
  // Referential: same object, not a copy.
  it('is the SAME reference as the legacy DEFAULT_AUTO_RESTART', () => {
    expect(AutoRestartSchedule.DEFAULT).toBe(DEFAULT_AUTO_RESTART)
  })
  it('has the documented default shape', () => {
    expect(AutoRestartSchedule.DEFAULT).toEqual({
      enabled: false,
      mode: 'continue',
      dailyTime: null,
      intervalHours: null,
      handoff: false,
    })
  })
})

describe('AutoRestartSchedule instance', () => {
  it('can be instantiated with the default constructor (no state, no throw)', () => {
    expect(() => new AutoRestartSchedule()).not.toThrow()
    const inst = new AutoRestartSchedule()
    expect(inst).toBeInstanceOf(AutoRestartSchedule)
  })
})