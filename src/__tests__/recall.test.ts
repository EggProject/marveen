import { describe, it, expect, vi, beforeEach } from 'vitest'
import { parseDateExpression } from '../web/routes/recall.js'

// Pin "today" to 2026-05-19 (Tuesday) in the install zone for deterministic tests
const FAKE_TODAY = '2026-05-19'

vi.mock('../web/routes/recall.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../web/routes/recall.js')>()
  return mod
})

// We can't easily mock todayBudapest inside the module, so we test the parser
// with inputs that are absolute or relative. For relative tests we accept that
// results shift with the real date and verify structural correctness instead.

describe('parseDateExpression', () => {
  describe('ISO dates', () => {
    it('parses single ISO date', () => {
      expect(parseDateExpression('2026-05-19')).toEqual({ from: '2026-05-19', to: '2026-05-19' })
    })

    it('parses ISO date range with dash', () => {
      expect(parseDateExpression('2026-05-10-2026-05-15')).toEqual({ from: '2026-05-10', to: '2026-05-15' })
    })

    it('parses ISO date range with en-dash', () => {
      const r = parseDateExpression('2026-05-01–2026-05-07')
      expect(r).toEqual({ from: '2026-05-01', to: '2026-05-07' })
    })
  })

  describe('relative keywords', () => {
    it('parses "ma"', () => {
      const r = parseDateExpression('ma')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
      expect(r!.from).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    })

    it('parses "tegnap"', () => {
      const r = parseDateExpression('tegnap')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "tegnapelőtt"', () => {
      const r = parseDateExpression('tegnapelőtt')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "yesterday"', () => {
      const r = parseDateExpression('yesterday')
      expect(r).not.toBeNull()
    })
  })

  describe('N days/weeks ago', () => {
    it('parses "3 napja"', () => {
      const r = parseDateExpression('3 napja')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "5 nappal ezelőtt"', () => {
      const r = parseDateExpression('5 nappal ezelőtt')
      expect(r).not.toBeNull()
    })

    it('parses "2 hete"', () => {
      const r = parseDateExpression('2 hete')
      expect(r).not.toBeNull()
      expect(r!.from).not.toBe(r!.to)
    })

    it('parses "1 héttel ezelőtt"', () => {
      const r = parseDateExpression('1 héttel ezelőtt')
      expect(r).not.toBeNull()
    })
  })

  describe('week references', () => {
    it('parses "múlt héten"', () => {
      const r = parseDateExpression('múlt héten')
      expect(r).not.toBeNull()
      expect(r!.from < r!.to).toBe(true)
    })

    it('parses "ezen a héten"', () => {
      const r = parseDateExpression('ezen a héten')
      expect(r).not.toBeNull()
    })

    it('parses "ez a hét"', () => {
      const r = parseDateExpression('ez a hét')
      expect(r).not.toBeNull()
    })
  })

  describe('month references', () => {
    it('parses "ebben a hónapban"', () => {
      const r = parseDateExpression('ebben a hónapban')
      expect(r).not.toBeNull()
      expect(r!.from.endsWith('-01')).toBe(true)
    })

    it('parses "múlt hónapban"', () => {
      const r = parseDateExpression('múlt hónapban')
      expect(r).not.toBeNull()
    })

    it('parses "elmúlt 7 nap"', () => {
      const r = parseDateExpression('elmúlt 7 nap')
      expect(r).not.toBeNull()
    })

    it('parses "utolsó 30 nap"', () => {
      const r = parseDateExpression('utolsó 30 nap')
      expect(r).not.toBeNull()
    })
  })

  describe('Hungarian month names', () => {
    it('parses "május első hete"', () => {
      const r = parseDateExpression('május első hete')
      expect(r).not.toBeNull()
      expect(r!.from.includes('-05-')).toBe(true)
      // First week must start ON or AFTER May 1
      expect(r!.from >= `${r!.from.slice(0, 4)}-05-01`).toBe(true)
    })

    it('parses "január első hete" (start-of-month edge)', () => {
      const r = parseDateExpression('január első hete')
      expect(r).not.toBeNull()
      expect(r!.from >= `${r!.from.slice(0, 4)}-01-01`).toBe(true)
    })

    it('parses "március második hete"', () => {
      const r = parseDateExpression('március második hete')
      expect(r).not.toBeNull()
      expect(r!.from.includes('-03-')).toBe(true)
    })

    it('parses "december utolsó hete"', () => {
      const r = parseDateExpression('december utolsó hete')
      expect(r).not.toBeNull()
      expect(r!.to.includes('-12-3')).toBe(true)
    })

    // The two lookups below used to carry a `?? 0` fallback that no input
    // could reach (recall-unreachable-defensive-fallbacks).
    // The fallbacks are gone, so these two tests are what guarantee every key
    // of the weekday map and of weekMap actually resolves.
    //
    // The month-week branch derives its year from the real clock
    // (`today.slice(0, 4)`), so both tests pin the system time; without that a
    // run crossing New Year could read two different years across calls.
    //
    // They do NOT pin the install zone, because they cannot: APP_TZ is
    // resolved once when config.ts loads, from the .env file with a fallback
    // to the process zone, and neither vi.stubEnv('SCHEDULER_TZ') nor
    // vi.stubEnv('TZ') reaches it (verified). That is acceptable here: the
    // zones where these assertions do not hold are UTC+12 and beyond, and
    // there the SUT itself yields inconsistent week starts across the year,
    // which is filed separately as
    // recall-dayofweek-noon-utc-far-east-skew.
    // Making the test pass there would assert a wrong result, not a right one.
    // CI (ubuntu, UTC) and the documented install zone both hold.
    const withPinnedClock = (fn: () => void): void => {
      vi.useFakeTimers()
      try {
        vi.setSystemTime(new Date('2026-06-15T09:00:00Z'))
        fn()
      } finally {
        vi.useRealTimers()
      }
    }

    const monthNames = [
      'január', 'február', 'március', 'április', 'május', 'június',
      'július', 'augusztus', 'szeptember', 'október', 'november', 'december',
    ]

    it('starts the first week of all 12 months on the same weekday (covers all 7 weekday-map keys)', () => {
      withPinnedClock(() => {
        // In any year, common or leap, the 12 month-firsts land on all 7
        // weekdays, so this loop reads every entry of the weekday map. A
        // broken entry makes the lookup yield undefined, `1 - undefined` is
        // NaN, and addDays then formats an Invalid Date, which throws. A
        // merely WRONG entry shifts that month's week start off the others.
        const weekdays = new Set<number>()
        for (const name of monthNames) {
          const r = parseDateExpression(`${name} első hete`)
          expect(r).not.toBeNull()
          weekdays.add(new Date(`${r!.from}T12:00:00Z`).getUTCDay())
        }
        expect(weekdays.size).toBe(1)
      })
    })

    it('spaces the ordinal weeks exactly 7 days apart (covers all 4 weekMap keys)', () => {
      withPinnedClock(() => {
        const dayIndex = (s: string): number => Math.round(new Date(`${s}T12:00:00Z`).getTime() / 86400000)
        const ordinals = ['első', 'második', 'harmadik', 'negyedik']
        const starts = ordinals.map((o) => {
          const r = parseDateExpression(`június ${o} hete`)
          expect(r).not.toBeNull()
          return dayIndex(r!.from)
        })
        expect(starts[1] - starts[0]).toBe(7)
        expect(starts[2] - starts[0]).toBe(14)
        expect(starts[3] - starts[0]).toBe(21)
      })
    })

    it('parses "május 10"', () => {
      const r = parseDateExpression('május 10')
      expect(r).not.toBeNull()
      expect(r!.from.endsWith('-05-10')).toBe(true)
      expect(r!.from).toBe(r!.to)
    })

    it('parses "januárban"', () => {
      const r = parseDateExpression('januárban')
      expect(r).not.toBeNull()
      expect(r!.from.endsWith('-01-01')).toBe(true)
      expect(r!.to.endsWith('-01-31')).toBe(true)
    })

    it('parses abbreviated "szept"', () => {
      const r = parseDateExpression('szept')
      expect(r).not.toBeNull()
      expect(r!.from.includes('-09-')).toBe(true)
    })
  })

  describe('Hungarian day names', () => {
    it('parses "hétfő"', () => {
      const r = parseDateExpression('hétfő')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "csütörtök"', () => {
      const r = parseDateExpression('csütörtök')
      expect(r).not.toBeNull()
      expect(r!.from).toBe(r!.to)
    })

    it('parses "múlt péntek"', () => {
      const r = parseDateExpression('múlt péntek')
      expect(r).not.toBeNull()
    })

    it('parses "vasárnap"', () => {
      const r = parseDateExpression('vasárnap')
      expect(r).not.toBeNull()
    })

    it('parses "szerda"', () => {
      const r = parseDateExpression('szerda')
      expect(r).not.toBeNull()
    })
  })

  describe('invalid input', () => {
    it('returns null for empty string', () => {
      expect(parseDateExpression('')).toBeNull()
    })

    it('returns null for gibberish', () => {
      expect(parseDateExpression('xyzzy')).toBeNull()
    })

    it('returns null for partial date', () => {
      expect(parseDateExpression('2026-05')).toBeNull()
    })
  })
})
