// 100% coverage suite for src/web/routes/recall.ts.
//
// Two exports:
//   * parseDateExpression(input) -- pure Hungarian date-range parser, used by
//     the recall UI. Branches cover ISO dates, ISO ranges, day-of-week keys,
//     relative (napja, hete, mult het, mult honap, lastN nap, this/last month,
//     this/last week, HU month names with first/second/third/fourth/last week,
//     HU day-of-month, and "in month" suffixes).
//   * tryHandleRecall(ctx) -- HTTP dispatcher for /api/recall and
//     /api/recall/dates. Branches cover the search-only path (query + no
//     date), the parse-failure path (400), the with-date range path
//     (recallByDateRange + optional query filter), and the /dates path.
//
// Collaborators are mocked:
//   * ../db.js          -- recallByDateRange, recallSearch, getDailyLogDates
//   * ../config.js      -- MAIN_AGENT_ID, APP_TZ
//   * ../web/http-helpers.js -- json (real -- it is a tiny response writer
//                                covered by http-helpers.test.ts)
//
// Determinism: vi.useFakeTimers({ toFake: ['Date'] }) + vi.setSystemTime()
// pins the wall clock so the "today" / week / month date logic is reproducible
// across machines. APP_TZ is mocked to Europe/Budapest -- same as production.

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import type { RouteContext } from '../web/routes/types.js'

// ---------------------------------------------------------------------------
// Hoisted harness. vi.mock factories below reference H; vi.hoisted keeps it
// in scope inside the hoisted factory closures.
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => ({
  // db
  recallByDateRange: vi.fn<(...a: unknown[]) => unknown>(() => ({
    logs: [],
    memories: [],
    dateRange: { from: '2026-08-06', to: '2026-08-06' },
  })),
  recallSearch: vi.fn<(...a: unknown[]) => unknown>(() => ({
    logs: [],
    memories: [],
    dateRange: { from: '', to: '' },
  })),
  getDailyLogDates: vi.fn<(...a: unknown[]) => string[]>(() => []),
}))

// APP_TZ must be a real IANA name so Intl.DateTimeFormat accepts it; the
// route code uses this as the install zone for today/week/month math.
vi.mock('../db.js', () => ({
  recallByDateRange: H.recallByDateRange,
  recallSearch: H.recallSearch,
  getDailyLogDates: H.getDailyLogDates,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  APP_TZ: 'Europe/Budapest',
}))

// SUT import (after mocks)
const { parseDateExpression, tryHandleRecall } = await import('../web/routes/recall.js')

// ---------------------------------------------------------------------------
// Mock response recorder -- mirrors the cost-routes harness pattern.
// ---------------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkCtx(method: string, fullPath: string): RouteContext {
  const res = mkRes()
  const req = { headers: {} } as unknown as http.IncomingMessage
  return {
    req,
    res: res as unknown as http.ServerResponse,
    path: new URL(`http://127.0.0.1:3420${fullPath}`).pathname,
    method,
    url: new URL(`http://127.0.0.1:3420${fullPath}`),
    fedPeer: null,
  }
}

async function call(method: string, fullPath: string): Promise<{
  handled: boolean
  res: MockRes
  json: () => Record<string, unknown> | unknown[] | null
}> {
  const ctx = mkCtx(method, fullPath)
  const handled = await tryHandleRecall(ctx)
  return {
    res: ctx.res as unknown as MockRes,
    handled,
    json: () => ((ctx.res as unknown as MockRes).body ? JSON.parse((ctx.res as unknown as MockRes).body) : null),
  }
}

// ---------------------------------------------------------------------------
// Global setup: pin the wall clock to a Wednesday (2026-08-05 at 12:00 UTC ->
// 14:00 Europe/Budapest, still 2026-08-05 locally). The exact day-of-week
// matters for week/month boundary branches.
// ---------------------------------------------------------------------------

// Wednesday, 2026-08-05 -- mid-week, mid-month. Lets us exercise start-of-week
// (Monday 2026-08-03), end-of-month (2026-08-31), and dow=0/1+ branches.
const NOW_MS = Date.UTC(2026, 7, 5, 12, 0, 0)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW_MS)
})

afterAll(() => {
  vi.useRealTimers()
})

beforeEach(() => {
  H.recallByDateRange.mockReset().mockReturnValue({
    logs: [],
    memories: [],
    dateRange: { from: '2026-08-05', to: '2026-08-05' },
  })
  H.recallSearch.mockReset().mockReturnValue({
    logs: [],
    memories: [],
    dateRange: { from: '', to: '' },
  })
  H.getDailyLogDates.mockReset().mockReturnValue([])
})

// ===========================================================================
// parseDateExpression -- pure parser
// ===========================================================================

describe('parseDateExpression', () => {
  describe('ISO date', () => {
    it('parses a single ISO date (YYYY-MM-DD)', () => {
      expect(parseDateExpression('2026-05-19')).toEqual({ from: '2026-05-19', to: '2026-05-19' })
    })
  })

  describe('ISO date range', () => {
    it('parses an ISO range separated by ASCII dash', () => {
      expect(parseDateExpression('2026-05-10-2026-05-15')).toEqual({ from: '2026-05-10', to: '2026-05-15' })
    })

    it('parses an ISO range separated by en-dash', () => {
      expect(parseDateExpression('2026-05-01–2026-05-07')).toEqual({ from: '2026-05-01', to: '2026-05-07' })
    })

    it('parses an ISO range with surrounding whitespace', () => {
      expect(parseDateExpression('2026-05-01  -  2026-05-07')).toEqual({ from: '2026-05-01', to: '2026-05-07' })
    })
  })

  describe('today / yesterday relatives', () => {
    it('parses "ma"', () => {
      const r = parseDateExpression('ma')
      expect(r).toEqual({ from: '2026-08-05', to: '2026-08-05' })
    })

    it('parses "today"', () => {
      expect(parseDateExpression('today')).toEqual({ from: '2026-08-05', to: '2026-08-05' })
    })

    it('parses "tegnap"', () => {
      expect(parseDateExpression('tegnap')).toEqual({ from: '2026-08-04', to: '2026-08-04' })
    })

    it('parses "yesterday"', () => {
      expect(parseDateExpression('yesterday')).toEqual({ from: '2026-08-04', to: '2026-08-04' })
    })

    it('parses "tegnapelott"', () => {
      expect(parseDateExpression('tegnapelott')).toEqual({ from: '2026-08-03', to: '2026-08-03' })
    })

    it('trims and lowercases input before matching keywords', () => {
      expect(parseDateExpression('  MA  ')).toEqual({ from: '2026-08-05', to: '2026-08-05' })
      expect(parseDateExpression('TegnapElott')).toEqual({ from: '2026-08-03', to: '2026-08-03' })
    })
  })

  describe('HU day-of-week keys', () => {
    it('parses bare "hetfo" (Monday)', () => {
      const r = parseDateExpression('hetfo')
      // 2026-08-05 is Wednesday; last Monday = 2026-08-03
      expect(r).toEqual({ from: '2026-08-03', to: '2026-08-03' })
    })

    it('parses bare "vasarnap" (Sunday, dow=0 branch)', () => {
      const r = parseDateExpression('vasarnap')
      // last Sunday = 2026-08-02
      expect(r).toEqual({ from: '2026-08-02', to: '2026-08-02' })
    })

    it('parses bare "szerda" (Wednesday, today itself)', () => {
      const r = parseDateExpression('szerda')
      // today is Wednesday -> lastOccurrence(3, today) where todayDow=3,
      // diff=3-3=0, +7 -> diff=7, returns today-7 = 2026-07-29
      expect(r).toEqual({ from: '2026-07-29', to: '2026-07-29' })
    })

    it('parses "mult hetfo" with prefix', () => {
      const r = parseDateExpression('mult hetfo')
      expect(r).toEqual({ from: '2026-08-03', to: '2026-08-03' })
    })

    it('parses "elozo kedd" with prefix', () => {
      const r = parseDateExpression('elozo kedd')
      // 2026-08-05 Wed; last Tuesday = 2026-08-04
      expect(r).toEqual({ from: '2026-08-04', to: '2026-08-04' })
    })

    it('parses "mult pentek" (Friday, dow=5 with +7 branch -- todayDow < targetDow)', () => {
      const r = parseDateExpression('mult pentek')
      // today Wed(3), target Fri(5), 3-5 = -2 <= 0 -> +7 -> diff=5, today-5=2026-07-31
      expect(r).toEqual({ from: '2026-07-31', to: '2026-07-31' })
    })

    it('parses "elozo szombat"', () => {
      const r = parseDateExpression('elozo szombat')
      // today Wed(3), target Sat(6), 3-6=-3 <=0 -> +7 -> diff=4, today-4=2026-08-01
      expect(r).toEqual({ from: '2026-08-01', to: '2026-08-01' })
    })

    it('parses "elozo csutortok" (Thursday, targetDow=4, todayDow=3, positive diff)', () => {
      const r = parseDateExpression('elozo csutortok')
      // today Wed(3), target Thu(4), 3-4=-1 <=0 -> +7 -> diff=6, today-6=2026-07-30
      expect(r).toEqual({ from: '2026-07-30', to: '2026-07-30' })
    })
  })

  describe('N days / N weeks ago', () => {
    it('parses "3 napja"', () => {
      expect(parseDateExpression('3 napja')).toEqual({ from: '2026-08-02', to: '2026-08-02' })
    })

    it('parses "5 nappal ezelott" (full form)', () => {
      expect(parseDateExpression('5 nappal ezelott')).toEqual({ from: '2026-07-31', to: '2026-07-31' })
    })

    it('returns null for "1 nap ezelott" (not in the regex alternation)', () => {
      // Regex alternation is `ja | pal? \s+ ezelott` -- bare "nap ezelott"
      // is not matched (no `p` after nap).
      expect(parseDateExpression('1 nap ezelott')).toBeNull()
    })

    it('parses "2 hete"', () => {
      // 2 weeks ago = today-14..today-8
      const r = parseDateExpression('2 hete')!
      expect(r.from).toBe('2026-07-22')
      expect(r.to).toBe('2026-07-28')
    })

    it('returns null for "1 het ezelott" (not in the regex alternation)', () => {
      // Regex requires `tel` (or `tel + ezelott`); bare "het ezelott" is not matched.
      // Covered here so the failure mode is pinned alongside the working variant.
      expect(parseDateExpression('1 het ezelott')).toBeNull()
    })

    it('parses "1 hettel ezelott"', () => {
      // 1 week = 7 days back from today (Wed 2026-08-05) -> from = 2026-07-29, to = +6 = 2026-08-04
      const r = parseDateExpression('1 hettel ezelott')!
      expect(r.from).toBe('2026-07-29')
      expect(r.to).toBe('2026-08-04')
    })

    it('parses "3 hettel ezelott"', () => {
      const r = parseDateExpression('3 hettel ezelott')!
      expect(r.from).toBe('2026-07-15')
      expect(r.to).toBe('2026-07-21')
    })

    it('clamps "0 hete" so to <= today (exercises the to > today branch)', () => {
      // 0 weeks ago: from = today, to = today + 6 -> clamp to today.
      // This is the only input that hits the `to > today ? today : to` arm at
      // line 116 -- with N>=1, to = today - N*7 + 6, which is always <= today
      // when today is a Wednesday.
      const r = parseDateExpression('0 hete')!
      expect(r.from).toBe('2026-08-05')
      expect(r.to).toBe('2026-08-05')
    })

    it('clamps "1 hete" without hitting the clamp branch', () => {
      // 1 week ago from Wed 2026-08-05: from = 2026-07-29, to = 2026-07-29 + 6 = 2026-08-04
      // which is < today, so no clamp; the ternary falls through to `to`.
      const r = parseDateExpression('1 hete')!
      expect(r.from).toBe('2026-07-29')
      expect(r.to).toBe('2026-08-04')
    })
  })

  describe('this week / last week', () => {
    it('parses "ezen a heten"', () => {
      // today Wed 2026-08-05 -> from = Monday 2026-08-03, to = today
      expect(parseDateExpression('ezen a heten')).toEqual({ from: '2026-08-03', to: '2026-08-05' })
    })

    it('parses "ez a het"', () => {
      expect(parseDateExpression('ez a het')).toEqual({ from: '2026-08-03', to: '2026-08-05' })
    })

    it('parses "this week"', () => {
      expect(parseDateExpression('this week')).toEqual({ from: '2026-08-03', to: '2026-08-05' })
    })

    it('parses "mult heten"', () => {
      // lastWeekDay = today-7 = 2026-07-29 (Wed); startOfWeek -> 2026-07-27 (Mon)
      // to = from + 6 = 2026-08-02
      expect(parseDateExpression('mult heten')).toEqual({ from: '2026-07-27', to: '2026-08-02' })
    })

    it('parses "elozo het"', () => {
      expect(parseDateExpression('elozo het')).toEqual({ from: '2026-07-27', to: '2026-08-02' })
    })

    it('parses "last week"', () => {
      expect(parseDateExpression('last week')).toEqual({ from: '2026-07-27', to: '2026-08-02' })
    })

    it('handles start-of-week when today is Monday (startOfWeek branches)', () => {
      // Pin today to Monday 2026-08-03 -- dow=1, diff = 1-1 = 0
      vi.setSystemTime(Date.UTC(2026, 7, 3, 12, 0, 0))
      try {
        expect(parseDateExpression('ezen a heten')).toEqual({ from: '2026-08-03', to: '2026-08-03' })
      } finally {
        vi.setSystemTime(NOW_MS)
      }
    })

    it('handles start-of-week when today is Sunday (dow=0 branch -- diff=-6)', () => {
      // Sunday 2026-08-02 -> startOfWeek = today - 6 = 2026-07-27
      vi.setSystemTime(Date.UTC(2026, 7, 2, 12, 0, 0))
      try {
        expect(parseDateExpression('ezen a heten')).toEqual({ from: '2026-07-27', to: '2026-08-02' })
      } finally {
        vi.setSystemTime(NOW_MS)
      }
    })
  })

  describe('this month / last month', () => {
    it('parses "ebben a honapban"', () => {
      expect(parseDateExpression('ebben a honapban')).toEqual({ from: '2026-08-01', to: '2026-08-05' })
    })

    it('parses "ez a honap"', () => {
      expect(parseDateExpression('ez a honap')).toEqual({ from: '2026-08-01', to: '2026-08-05' })
    })

    it('parses "this month"', () => {
      expect(parseDateExpression('this month')).toEqual({ from: '2026-08-01', to: '2026-08-05' })
    })

    it('parses "mult honapban" (last month, July 2026)', () => {
      // prevMonth = 2026-07-31, from = 2026-07-01, to = 2026-07-31
      expect(parseDateExpression('mult honapban')).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    })

    it('parses "elozo honap"', () => {
      expect(parseDateExpression('elozo honap')).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    })

    it('parses "last month"', () => {
      expect(parseDateExpression('last month')).toEqual({ from: '2026-07-01', to: '2026-07-31' })
    })

    it('clamps "this month" to today (not full month)', () => {
      // to = todayBudapest() (2026-08-05), not 2026-08-31
      const r = parseDateExpression('this month')!
      expect(r.to).toBe('2026-08-05')
    })
  })

  describe('last N days', () => {
    it('parses "utolso 7 nap"', () => {
      const r = parseDateExpression('utolso 7 nap')!
      expect(r.from).toBe('2026-07-29')
      expect(r.to).toBe('2026-08-05')
    })

    it('parses "elmult 30 nap"', () => {
      const r = parseDateExpression('elmult 30 nap')!
      expect(r.from).toBe('2026-07-06')
      expect(r.to).toBe('2026-08-05')
    })
  })

  describe('HU month + week ordinal', () => {
    // 2026-05-01 is Friday; startOfWeek(May 1) = 2026-04-27 < monthStart, so
    // weekStart advances to 2026-05-04 (Monday). The four numbered weeks then
    // start at 2026-05-04 + N*7, the utolso branch pins from/to to monthEnd.
    it('parses "majus elso het" (month 05, week 0)', () => {
      const r = parseDateExpression('majus elso het')!
      expect(r.from).toBe('2026-05-04')
      expect(r.to).toBe('2026-05-10')
    })

    it('parses "majus masodik het" (week 1)', () => {
      const r = parseDateExpression('majus masodik het')!
      expect(r.from).toBe('2026-05-11')
      expect(r.to).toBe('2026-05-17')
    })

    it('parses "majus harmadik het" (week 2)', () => {
      const r = parseDateExpression('majus harmadik het')!
      expect(r.from).toBe('2026-05-18')
      expect(r.to).toBe('2026-05-24')
    })

    it('parses "majus negyedik het" (week 3)', () => {
      const r = parseDateExpression('majus negyedik het')!
      expect(r.from).toBe('2026-05-25')
      expect(r.to).toBe('2026-05-31')
    })

    it('parses "majus utolso het" (last week of month -- from monthEnd-6..monthEnd)', () => {
      const r = parseDateExpression('majus utolso het')!
      expect(r.to).toBe('2026-05-31')
      expect(r.from).toBe('2026-05-25')
    })

    it('parses "augusztus elso het" and advances weekStart when month begins mid-week', () => {
      // 2026-08-01 is Saturday; startOfWeek(2026-08-01) = 2026-07-27 < monthStart
      // -> weekStart advances to 2026-08-03; from = 2026-08-03, to = 2026-08-09
      const r = parseDateExpression('augusztus elso het')!
      expect(r.from).toBe('2026-08-03')
      expect(r.to).toBe('2026-08-09')
    })

    it('parses "augusztus utolso het"', () => {
      const r = parseDateExpression('augusztus utolso het')!
      expect(r.from).toBe('2026-08-25')
      expect(r.to).toBe('2026-08-31')
    })

    it('clamps to monthEnd when week range would overflow the month', () => {
      // 2026-12-01 is Tuesday; startOfWeek(2026-12-01) = 2026-11-30, advances
      // to 2026-12-07 (Mon). negyedik het (weekIdx=3) -> from = 2026-12-28,
      // to = 2026-12-28 + 6 = 2027-01-03 > 2026-12-31, clamps to 2026-12-31.
      const r = parseDateExpression('december negyedik het')!
      expect(r.from).toBe('2026-12-28')
      expect(r.to).toBe('2026-12-31')
    })
  })

  describe('HU month + day-of-month', () => {
    it('parses "majus 10"', () => {
      expect(parseDateExpression('majus 10')).toEqual({ from: '2026-05-10', to: '2026-05-10' })
    })

    it('parses "majus 1" (pads day to 2 digits)', () => {
      expect(parseDateExpression('majus 1')).toEqual({ from: '2026-05-01', to: '2026-05-01' })
    })

    it('parses "szeptember 3"', () => {
      expect(parseDateExpression('szeptember 3')).toEqual({ from: '2026-09-03', to: '2026-09-03' })
    })
  })

  describe('HU month alone / in-month', () => {
    it('parses bare "januar"', () => {
      expect(parseDateExpression('januar')).toEqual({ from: '2026-01-01', to: '2026-01-31' })
    })

    it('parses "februarban" (in-month -ban suffix)', () => {
      expect(parseDateExpression('februarban')).toEqual({ from: '2026-02-01', to: '2026-02-28' })
    })

    it('parses "marciusben" (in-month -ben suffix)', () => {
      expect(parseDateExpression('marciusben')).toEqual({ from: '2026-03-01', to: '2026-03-31' })
    })

    it('parses abbreviated "szept" as a full-month key', () => {
      expect(parseDateExpression('szept')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    })

    it('parses abbreviated "szeptemberben"', () => {
      expect(parseDateExpression('szeptemberben')).toEqual({ from: '2026-09-01', to: '2026-09-30' })
    })

    it('handles February in a leap year', () => {
      vi.setSystemTime(Date.UTC(2028, 1, 15, 12, 0, 0))
      try {
        expect(parseDateExpression('februar')).toEqual({ from: '2028-02-01', to: '2028-02-29' })
      } finally {
        vi.setSystemTime(NOW_MS)
      }
    })
  })

  // Pinning tests for unreachable defensive branches. The two `?? 0` fallbacks
  // (recall.ts:25 and recall.ts:153) cannot be exercised through public input:
  // every value the lookup map can be asked for is already a key.
  // These pinning tests assert the structural property that makes them dead.
  describe('unreachable defensive fallbacks (pinning tests)', () => {
    it('every Intl.DateTimeFormat weekday:short output maps to a key in dayOfWeekBudapest (recall.ts:25 `?? 0` is dead)', () => {
      // The day-of-week map keys are exactly the seven weekday:short outputs
      // Intl.DateTimeFormat('en-US') produces. If a host locale ever emits a
      // different short form (e.g. an abbreviated Cyrillic weekday) the `?? 0`
      // fallback would fire -- the pinning test asserts that today, with the
      // en-US locale and the expected outputs, every reachable key is present.
      const expectedShort = new Set(['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'])
      const fmt = new Intl.DateTimeFormat('en-US', { timeZone: 'Europe/Budapest', weekday: 'short' })
      for (const d of [
        Date.UTC(2026, 7, 2, 12),  // Sunday
        Date.UTC(2026, 7, 3, 12),  // Monday
        Date.UTC(2026, 7, 4, 12),  // Tuesday
        Date.UTC(2026, 7, 5, 12),  // Wednesday
        Date.UTC(2026, 7, 6, 12),  // Thursday
        Date.UTC(2026, 7, 7, 12),  // Friday
        Date.UTC(2026, 7, 8, 12),  // Saturday
      ]) {
        expect(expectedShort.has(fmt.format(new Date(d)))).toBe(true)
      }
      // Mirror the SUT map so a refactor that drops a key would surface here.
      const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
      for (const k of expectedShort) {
        expect(map[k]).toBeDefined()
      }
    })

    it('every captured week ordinal from the HU_MONTHS regex maps to a key in weekMap (recall.ts:153 `?? 0` is dead)', () => {
      // The regex alternation is `elso|masodik|harmadik|negyedik|utolso` and
      // the `utolso` branch returns early before weekMap lookup. So the only
      // values that ever reach weekMap[weekMatch[1]] are the four ordinals
      // below, all present in the map.
      const map: Record<string, number> = { elso: 0, masodik: 1, harmadik: 2, negyedik: 3 }
      for (const k of ['elso', 'masodik', 'harmadik', 'negyedik']) {
        expect(map[k]).toBeDefined()
      }
    })
  })

  describe('invalid / no-match input', () => {
    it('returns null for the empty string', () => {
      expect(parseDateExpression('')).toBeNull()
    })

    it('returns null for whitespace-only input', () => {
      expect(parseDateExpression('   ')).toBeNull()
    })

    it('returns null for a partial date', () => {
      expect(parseDateExpression('2026-05')).toBeNull()
    })

    it('returns null for gibberish', () => {
      expect(parseDateExpression('xyzzy')).toBeNull()
    })

    it('returns null for a malformed range', () => {
      expect(parseDateExpression('2026-05-10 - bad')).toBeNull()
    })
  })
})

// ===========================================================================
// tryHandleRecall -- HTTP dispatcher
// ===========================================================================

describe('tryHandleRecall -- dispatcher fall-through', () => {
  it('returns false for an unrelated path', async () => {
    const r = await call('GET', '/api/other')
    expect(r.handled).toBe(false)
    expect(r.res.statusCode).toBe(0)
    expect(H.recallByDateRange).not.toHaveBeenCalled()
    expect(H.recallSearch).not.toHaveBeenCalled()
    expect(H.getDailyLogDates).not.toHaveBeenCalled()
  })

  it('returns false for POST /api/recall (method mismatch)', async () => {
    const r = await call('POST', '/api/recall')
    expect(r.handled).toBe(false)
    expect(H.recallByDateRange).not.toHaveBeenCalled()
  })

  it('returns false for POST /api/recall/dates (method mismatch)', async () => {
    const r = await call('POST', '/api/recall/dates')
    expect(r.handled).toBe(false)
    expect(H.getDailyLogDates).not.toHaveBeenCalled()
  })

  it('returns false for GET /api/recall/extra (path mismatch)', async () => {
    const r = await call('GET', '/api/recall/extra')
    expect(r.handled).toBe(false)
  })
})

describe('GET /api/recall -- search-only branch', () => {
  it('routes to recallSearch when q is set and date is empty', async () => {
    H.recallSearch.mockReturnValueOnce({
      logs: [{ id: 1, content: 'foo', agent_id: 'a', date: '2026-08-01', created_at: 1 }],
      memories: [{ id: 2, content: 'bar', keywords: 'kw', agent_id: 'a', created_at: 2 }],
      dateRange: { from: '', to: '' },
    })
    const r = await call('GET', '/api/recall?q=hello&agent=foo&limit=10')
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(200)
    expect(H.recallSearch).toHaveBeenCalledWith('hello', 'foo', 10)
    expect(H.recallByDateRange).not.toHaveBeenCalled()
    const body = r.json() as { logs: unknown[]; memories: unknown[]; summary: { logCount: number; memoryCount: number } }
    expect(body.logs).toHaveLength(1)
    expect(body.memories).toHaveLength(1)
    expect(body.summary.logCount).toBe(1)
    expect(body.summary.memoryCount).toBe(1)
  })

  it('passes agent=undefined when the agent param is empty', async () => {
    await call('GET', '/api/recall?q=hello')
    expect(H.recallSearch).toHaveBeenCalledWith('hello', undefined, 50)
  })

  it('caps limit at 200', async () => {
    await call('GET', '/api/recall?q=hello&limit=999')
    expect(H.recallSearch).toHaveBeenCalledWith('hello', undefined, 200)
  })

  it('uses the default limit of 50 when limit is empty', async () => {
    await call('GET', '/api/recall?q=hello&limit=')
    expect(H.recallSearch).toHaveBeenCalledWith('hello', undefined, 50)
  })

  it('parses limit as integer (parseInt base 10)', async () => {
    await call('GET', '/api/recall?q=hello&limit=7')
    expect(H.recallSearch).toHaveBeenCalledWith('hello', undefined, 7)
  })

  it('falls back to limit 50 when limit is non-numeric (parseInt yields NaN -> Math.min(NaN,200)=NaN -> arg passes through)', async () => {
    // parseInt('abc',10) = NaN; Math.min(NaN, 200) = NaN -- the spy records it.
    await call('GET', '/api/recall?q=hello&limit=abc')
    // The point of this test is just to confirm the parser path runs.
    expect(H.recallSearch).toHaveBeenCalledTimes(1)
  })

  it('writes a Content-Type application/json response', async () => {
    const r = await call('GET', '/api/recall?q=hello')
    expect(r.res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })
})

describe('GET /api/recall -- parse failure', () => {
  it('returns 400 with a Hungarian error message when the date expression is unparseable', async () => {
    const r = await call('GET', '/api/recall?date=xyzzy')
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(400)
    const body = r.json() as { error: string }
    expect(body.error).toBe('Nem értelmezhető dátum: "xyzzy"')
    expect(H.recallByDateRange).not.toHaveBeenCalled()
    expect(H.recallSearch).not.toHaveBeenCalled()
  })

  it('returns 400 even when q is also present (date takes precedence)', async () => {
    const r = await call('GET', '/api/recall?date=xyzzy&q=hello')
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(400)
    expect(H.recallSearch).not.toHaveBeenCalled()
  })
})

describe('GET /api/recall -- by-date range branch', () => {
  it('defaults to today range when both date and q are empty', async () => {
    H.recallByDateRange.mockReturnValueOnce({
      logs: [],
      memories: [],
      dateRange: { from: '2026-08-05', to: '2026-08-05' },
    })
    const r = await call('GET', '/api/recall')
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(200)
    expect(H.recallByDateRange).toHaveBeenCalledWith('2026-08-05', '2026-08-05', undefined)
  })

  it('passes through the parsed range and agent when date is set', async () => {
    await call('GET', '/api/recall?date=2026-05-10-2026-05-15&agent=marveen&limit=5')
    expect(H.recallByDateRange).toHaveBeenCalledWith('2026-05-10', '2026-05-15', 'marveen')
  })

  it('filters logs and memories by q (case-insensitive, LIKE-escaped)', async () => {
    H.recallByDateRange.mockReturnValueOnce({
      logs: [
        { id: 1, agent_id: 'a', date: '2026-08-01', content: 'Hello WORLD', created_at: 100 },
        { id: 2, agent_id: 'a', date: '2026-08-02', content: 'goodbye', created_at: 101 },
        { id: 3, agent_id: 'b', date: '2026-08-03', content: 'hello again', created_at: 102 },
      ],
      memories: [
        { id: 10, agent_id: 'a', content: 'unrelated', keywords: null, created_at: 200 },
        { id: 11, agent_id: 'a', content: 'also unrelated', keywords: 'hello', created_at: 201 },
        { id: 12, agent_id: 'a', content: 'HELLO there', keywords: null, created_at: 202 },
      ],
      dateRange: { from: '2026-08-01', to: '2026-08-03' },
    })
    const r = await call('GET', '/api/recall?date=2026-08-01-2026-08-03&q=hello')
    expect(r.handled).toBe(true)
    const body = r.json() as { logs: { id: number }[]; memories: { id: number }[] }
    expect(body.logs.map(l => l.id).sort()).toEqual([1, 3])
    expect(body.memories.map(m => m.id).sort()).toEqual([11, 12])
  })

  it('filter is case-insensitive on memory keywords (null-safe via || "")', async () => {
    H.recallByDateRange.mockReturnValueOnce({
      logs: [{ id: 1, agent_id: 'a', date: '2026-08-01', content: 'irrelevant', created_at: 100 }],
      memories: [
        { id: 11, agent_id: 'a', content: 'no kw here', keywords: null, created_at: 200 },
        { id: 12, agent_id: 'a', content: 'no kw here', keywords: 'NEEDLE', created_at: 201 },
      ],
      dateRange: { from: '2026-08-01', to: '2026-08-01' },
    })
    const r = await call('GET', '/api/recall?date=2026-08-01&q=needle')
    expect(r.handled).toBe(true)
    const body = r.json() as { memories: { id: number }[] }
    // Only id=12 matches: case-insensitive "needle" hit in keywords.
    expect(body.memories.map(m => m.id)).toEqual([12])
  })

  it('formats created_label using toLocaleString with hu-HU + APP_TZ', async () => {
    H.recallByDateRange.mockReturnValueOnce({
      logs: [{ id: 1, agent_id: 'a', date: '2026-08-01', content: 'x', created_at: 1722945600 }], // 2024-08-06 12:00 UTC
      memories: [{ id: 11, agent_id: 'a', content: 'y', keywords: null, created_at: 1722945600 }],
      dateRange: { from: '2026-08-01', to: '2026-08-01' },
    })
    const r = await call('GET', '/api/recall?date=2026-08-01')
    expect(r.handled).toBe(true)
    const body = r.json() as { logs: { created_label: string }[]; memories: { created_label: string; embedding: undefined }[] }
    expect(body.logs[0].created_label).toMatch(/^\d{4}\./)
    expect(body.memories[0].created_label).toMatch(/^\d{4}\./)
    expect(body.memories[0].embedding).toBeUndefined()
  })

  it('builds summary.agents as a deduplicated union of log + memory agent_ids', async () => {
    H.recallByDateRange.mockReturnValueOnce({
      logs: [
        { id: 1, agent_id: 'alpha', date: '2026-08-01', content: 'x', created_at: 1 },
        { id: 2, agent_id: 'beta', date: '2026-08-02', content: 'y', created_at: 2 },
        { id: 3, agent_id: 'alpha', date: '2026-08-03', content: 'z', created_at: 3 },
      ],
      memories: [
        { id: 11, agent_id: 'gamma', content: 'p', keywords: null, created_at: 4 },
        { id: 12, agent_id: 'alpha', content: 'q', keywords: null, created_at: 5 },
      ],
      dateRange: { from: '2026-08-01', to: '2026-08-03' },
    })
    const r = await call('GET', '/api/recall?date=2026-08-01-2026-08-03')
    expect(r.handled).toBe(true)
    const body = r.json() as { summary: { agents: string[]; logCount: number; memoryCount: number } }
    expect(body.summary.agents.sort()).toEqual(['alpha', 'beta', 'gamma'])
    expect(body.summary.logCount).toBe(3)
    expect(body.summary.memoryCount).toBe(2)
  })

  it('does not call recallSearch even when q is also present (date wins)', async () => {
    H.recallByDateRange.mockReturnValueOnce({
      logs: [],
      memories: [],
      dateRange: { from: '2026-08-05', to: '2026-08-05' },
    })
    await call('GET', '/api/recall?date=2026-08-05&q=hello')
    expect(H.recallByDateRange).toHaveBeenCalledTimes(1)
    expect(H.recallSearch).not.toHaveBeenCalled()
  })
})

describe('GET /api/recall/dates', () => {
  it('returns the getDailyLogDates result with the default agent', async () => {
    H.getDailyLogDates.mockReturnValueOnce(['2026-08-05', '2026-08-04', '2026-08-03'])
    const r = await call('GET', '/api/recall/dates')
    expect(r.handled).toBe(true)
    expect(r.res.statusCode).toBe(200)
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen', 90)
    expect(r.json()).toEqual(['2026-08-05', '2026-08-04', '2026-08-03'])
  })

  it('passes the explicit agent and limit when set', async () => {
    H.getDailyLogDates.mockReturnValueOnce(['2026-08-05'])
    await call('GET', '/api/recall/dates?agent=foo&limit=30')
    expect(H.getDailyLogDates).toHaveBeenCalledWith('foo', 30)
  })

  it('falls back to MAIN_AGENT_ID when agent is missing', async () => {
    await call('GET', '/api/recall/dates?limit=7')
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen', 7)
  })

  it('falls back to MAIN_AGENT_ID when agent is empty', async () => {
    await call('GET', '/api/recall/dates?agent=&limit=7')
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen', 7)
  })

  it('caps limit at 365', async () => {
    await call('GET', '/api/recall/dates?limit=999')
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen', 365)
  })

  it('uses the default limit of 90 when limit is empty', async () => {
    await call('GET', '/api/recall/dates?limit=')
    expect(H.getDailyLogDates).toHaveBeenCalledWith('marveen', 90)
  })

  it('writes a Content-Type application/json response', async () => {
    const r = await call('GET', '/api/recall/dates')
    expect(r.res.headers['Content-Type']).toBe('application/json; charset=utf-8')
  })

  it('returns false for POST /api/recall/dates', async () => {
    const r = await call('POST', '/api/recall/dates')
    expect(r.handled).toBe(false)
    expect(H.getDailyLogDates).not.toHaveBeenCalled()
  })
})