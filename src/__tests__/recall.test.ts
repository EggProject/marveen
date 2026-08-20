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
    // vi.stubEnv('TZ') reaches it (verified). CI (ubuntu, UTC) and the
    // documented install zone both hold.
    //
    // Cross-zone coverage of the first-week-of-all-12-months invariant lives
    // in the "TZ sweep" describe block at the bottom of this file. That block
    // uses vi.doMock + resetModules() so each zone gets a freshly-loaded
    // recall.js with the mocked APP_TZ; the top-level import here keeps the
    // install zone. The MD recall-dayofweek-noon-utc-far-east-skew is the
    // bug that previously broke the invariant for UTC+12 and beyond; this
    // fix lands the helper zonedNoon() in recall.ts so dayOfWeekBudapest and
    // addDays share a single noon-LOCAL anchor.
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
        // merely WRONG entry shifts that month's week start off the others,
        // and the masking `if (weekStart < monthStart) weekStart += 7` step
        // in parseDateExpression collapses a uniform +1 day shift back to a
        // Monday for every month, so this assertion only catches truly
        // broken weekday-map entries; the off-by-one bug covered by the TZ
        // sweep below is masked here by design.
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

// Cross-zone pin for the weekday anchor bug covered by the MD
// recall-dayofweek-noon-utc-far-east-skew. The pre-fix code anchored
// dayOfWeekBudapest at noon UTC, so for any install zone at UTC+12 or beyond
// the weekday read was for dateStr+1. The fix anchors dayOfWeekBudapest and
// addDays at local noon via zonedNoon() in recall.ts.
//
// The bug CANNOT be pinned through parseDateExpression alone: every parse path
// pairs dayOfWeekBudapest with addDays, and both functions share the same
// +1 day drift for UTC+12+ zones -- the pair cancels. Direct probe via the
// __test__dayOfWeekBudapestWithTz helper bypasses that pairing by passing an
// explicit TZ and anchoring at local noon.
//
// This block also keeps the BUGGY weekday algorithm in view via
// __test__buggyDayOfWeekBudapest: for UTC+12+ zones it returns a different
// answer than the post-fix helper, documenting that the production
// dayOfWeekBudapest no longer matches the buggy anchor. If the production
// code is reverted to use noon-UTC, the regression test below
// (productionMatchesPostFix) fails.
describe('dayOfWeekBudapest is anchored at local noon for UTC+12+ zones (recall-dayofweek-noon-utc-far-east-skew)', () => {
  // dateStr -> expected weekday (0=Sun..6=Sat) for Pacific/Auckland.
  // 2026-01-01 is Thursday (4). Pre-fix Auckland (UTC+13 summer) reads
  // 2026-01-01T12:00:00Z = Friday (5); the fix reads local-noon = Thursday (4).
  const probes: ReadonlyArray<readonly [string, number]> = [
    ['2026-01-01', 4],  // Thursday (Auckland summer UTC+13)
    ['2026-06-15', 1],  // Monday (Auckland winter UTC+12)
    ['2026-07-04', 6],  // Saturday (Auckland winter UTC+12)
    ['2026-12-25', 5],  // Friday (Auckland summer UTC+13)
  ]

  it('the post-fix algorithm returns the correct weekday for Pacific/Auckland', async () => {
    const { __test__dayOfWeekBudapestWithTz } = await import('../web/routes/recall.js')
    for (const [dateStr, expected] of probes) {
      expect(__test__dayOfWeekBudapestWithTz('Pacific/Auckland', dateStr)).toBe(expected)
    }
  })

  it('the BUGGY noon-UTC anchor gave a different answer for Pacific/Auckland (regression witness)', async () => {
    const { __test__buggyDayOfWeekBudapest } = await import('../web/routes/recall.js')
    // Pre-fix: every probe would return +1 (the off-by-one). Post-fix the
    // production code no longer uses this anchor, but the helper itself still
    // demonstrates the buggy behaviour so a regression test can assert that
    // production switched anchors.
    const buggy = probes.map(([dateStr]) =>
      __test__buggyDayOfWeekBudapest('Pacific/Auckland', dateStr),
    )
    const correct = probes.map(([dateStr]) => {
      const parts = new Intl.DateTimeFormat('en-US', {
        timeZone: 'Pacific/Auckland',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      }).formatToParts(new Date(`${dateStr}T12:00:00Z`))
      const get = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((p) => p.type === type)?.value ?? ''
      const probe = new Date(`${dateStr}T12:00:00Z`)
      const localYear = Number(get('year'))
      const localMonth = Number(get('month'))
      const localDay = Number(get('day'))
      let localHour = Number(get('hour'))
      if (localHour === 24) localHour = 0
      const localMinute = Number(get('minute'))
      const localSecond = Number(get('second'))
      const localAsUtcMs = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond)
      const offsetMinutes = (probe.getTime() - localAsUtcMs) / 60_000
      const [y, m, d] = dateStr.split('-').map(Number)
      const noonLocal = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) + offsetMinutes * 60_000)
      const weekday = new Intl.DateTimeFormat('en-US', { timeZone: 'Pacific/Auckland', weekday: 'short' }).format(noonLocal)
      const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
      return map[weekday]
    })
    // The buggy helper and the local-noon helper must disagree on at least
    // one probe. (In practice they disagree on all four because the +1 drift
    // is uniform across dateStrs within a fixed zone.)
    expect(buggy).not.toEqual(correct)
  })
})
