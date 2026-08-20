import { recallByDateRange, recallSearch, getDailyLogDates } from '../../db.js'
import { MAIN_AGENT_ID, APP_TZ } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function todayBudapest(): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(new Date())
}

function budapestDate(d: Date): string {
  return new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(d)
}

// Return the Date instant that is 12:00 in TZ on the given ISO date string.
// Both dayOfWeekBudapest and addDays share this anchor: noon UTC crosses a
// calendar day for install zones at UTC+12 and beyond, which used to make
// the weekday read off by one (Pacific/Auckland swings UTC+12/+13 across
// the year, so the skew was not even constant). For dateStr 'YYYY-MM-DD',
// the returned Date satisfies:
//   new Intl.DateTimeFormat('sv-SE', { timeZone: TZ }).format(zonedNoon(dateStr)) === dateStr
//   new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short', hour: 'numeric' })
//     .format(zonedNoon(dateStr)).includes('12')
function zonedNoon(dateStr: string): Date {
  const probe = new Date(`${dateStr}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(probe)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
  const localYear = Number(get('year'))
  const localMonth = Number(get('month'))
  const localDay = Number(get('day'))
  let localHour = Number(get('hour'))
  if (localHour === 24) localHour = 0  // some ICU builds render midnight as '24' with hour12:false
  const localMinute = Number(get('minute'))
  const localSecond = Number(get('second'))
  // probe expressed as if its local components were UTC: that gives us the
  // TZ offset as (probe - localAsUtcMs) / 60_000 minutes.
  const localAsUtcMs = Date.UTC(localYear, localMonth - 1, localDay, localHour, localMinute, localSecond)
  const offsetMinutes = (probe.getTime() - localAsUtcMs) / 60_000
  // Build the UTC ms for "12:00 local on dateStr" and shift by the offset.
  const [y, m, d] = dateStr.split('-').map(Number)
  const targetLocalMs = Date.UTC(y, m - 1, d, 12, 0, 0)
  return new Date(targetLocalMs + offsetMinutes * 60_000)
}

function addDays(dateStr: string, days: number): string {
  const ms = zonedNoon(dateStr).getTime() + days * 86_400_000
  return budapestDate(new Date(ms))
}

function dayOfWeekBudapest(dateStr: string): number {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TZ, weekday: 'short' }).format(zonedNoon(dateStr))
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[weekday]
}

// Test-only export: runs the post-fix weekday algorithm against an explicit TZ
// so the cross-zone pin test in recall.test.ts can exercise UTC+12+ zones
// without faking APP_TZ (test-sandbox-setup mocks config.js, which leaks
// APP_TZ=undefined into this module; the production TZ is therefore
// uncontrollable from a dynamic import inside vitest). The test asserts the
// algorithm directly: for dateStr YYYY-MM-DD, the weekday must be the day of
// the week in `tz` at LOCAL noon on that date, not at noon UTC (the bug).
export function __test__dayOfWeekBudapestWithTz(tz: string, dateStr: string): number {
  // Anchor at local noon in tz. We construct the dateStr-as-UTC-noon, then
  // shift by the tz offset to land at local noon.
  const probe = new Date(`${dateStr}T12:00:00Z`)
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).formatToParts(probe)
  const get = (type: Intl.DateTimeFormatPartTypes): string =>
    parts.find((p) => p.type === type)?.value ?? ''
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
  const targetLocalMs = Date.UTC(y, m - 1, d, 12, 0, 0)
  const noonLocal = new Date(targetLocalMs + offsetMinutes * 60_000)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(noonLocal)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[weekday]
}

// Test-only export: the OLD (buggy) weekday algorithm against an explicit TZ.
// Kept so the cross-zone pin test can assert that the pre-fix path gives a
// different answer for UTC+12+ zones, documenting that the production
// dayOfWeekBudapest no longer uses this anchor.
export function __test__buggyDayOfWeekBudapest(tz: string, dateStr: string): number {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short' }).format(d)
  const map: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return map[weekday]
}

function startOfWeek(dateStr: string): string {
  const dow = dayOfWeekBudapest(dateStr)
  const diff = dow === 0 ? -6 : 1 - dow
  return addDays(dateStr, diff)
}

function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 8) + '01'
}

function endOfMonth(dateStr: string): string {
  const [y, m] = dateStr.split('-').map(Number)
  const last = new Date(Date.UTC(y, m, 0))
  return budapestDate(last)
}

const HU_MONTHS: Record<string, string> = {
  'januar': '01', 'februar': '02', 'marcius': '03', 'aprilis': '04',
  'majus': '05', 'junius': '06', 'julius': '07', 'augusztus': '08',
  'szeptember': '09', 'oktober': '10', 'november': '11', 'december': '12',
  'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
  'maj': '05', 'jun': '06', 'jul': '07', 'aug': '08',
  'szept': '09', 'okt': '10', 'nov': '11', 'dec': '12',
}

const HU_DAYS: Record<string, number> = {
  'hetfo': 1, 'kedd': 2, 'szerda': 3, 'csutortok': 4,
  'pentek': 5, 'szombat': 6, 'vasarnap': 0,
}

interface DateRange { from: string; to: string }

function stripAccents(s: string): string {
  return s
    .replace(/á/g, 'a').replace(/é/g, 'e').replace(/í/g, 'i')
    .replace(/ó/g, 'o').replace(/ö/g, 'o').replace(/ő/g, 'o')
    .replace(/ú/g, 'u').replace(/ü/g, 'u').replace(/ű/g, 'u')
}

function lastOccurrence(targetDow: number, today: string): string {
  const todayDow = dayOfWeekBudapest(today)
  let diff = todayDow - targetDow
  if (diff <= 0) diff += 7
  return addDays(today, -diff)
}

export function parseDateExpression(input: string): DateRange | null {
  const raw = input.trim()
  const s = stripAccents(raw.toLowerCase())
  const today = todayBudapest()

  if (/^(\d{4})-(\d{2})-(\d{2})$/.test(raw)) {
    return { from: raw, to: raw }
  }

  const rangeMatch = raw.match(/^(\d{4}-\d{2}-\d{2})\s*[-–]\s*(\d{4}-\d{2}-\d{2})$/)
  if (rangeMatch) {
    return { from: rangeMatch[1], to: rangeMatch[2] }
  }

  if (s === 'ma' || s === 'today') return { from: today, to: today }
  if (s === 'tegnap' || s === 'yesterday') {
    const d = addDays(today, -1)
    return { from: d, to: d }
  }
  if (s === 'tegnapelott') {
    const d = addDays(today, -2)
    return { from: d, to: d }
  }

  for (const [name, dow] of Object.entries(HU_DAYS)) {
    if (s === name || s === `mult ${name}` || s === `elozo ${name}`) {
      const d = lastOccurrence(dow, today)
      return { from: d, to: d }
    }
  }

  const daysAgoMatch = s.match(/^(\d+)\s*nap(?:ja|pal?\s+ezelott)?$/)
  if (daysAgoMatch) {
    const d = addDays(today, -parseInt(daysAgoMatch[1], 10))
    return { from: d, to: d }
  }

  const weeksAgoMatch = s.match(/^(\d+)\s*het(?:e|tel?\s+ezelott)?$/)
  if (weeksAgoMatch) {
    const daysBack = parseInt(weeksAgoMatch[1], 10) * 7
    const from = addDays(today, -daysBack)
    const to = addDays(from, 6)
    return { from, to: to > today ? today : to }
  }

  if (s === 'ezen a heten' || s === 'ez a het' || s === 'this week') {
    return { from: startOfWeek(today), to: today }
  }
  if (s === 'mult heten' || s === 'elozo het' || s === 'last week') {
    const lastWeekDay = addDays(today, -7)
    const from = startOfWeek(lastWeekDay)
    return { from, to: addDays(from, 6) }
  }

  if (s === 'ebben a honapban' || s === 'ez a honap' || s === 'this month') {
    return { from: startOfMonth(today), to: today }
  }
  if (s === 'mult honapban' || s === 'elozo honap' || s === 'last month') {
    const prevMonth = addDays(startOfMonth(today), -1)
    return { from: startOfMonth(prevMonth), to: prevMonth }
  }

  const lastNDaysMatch = s.match(/^(?:utolso|elmult)\s+(\d+)\s*nap$/)
  if (lastNDaysMatch) {
    return { from: addDays(today, -parseInt(lastNDaysMatch[1], 10)), to: today }
  }

  for (const [name, num] of Object.entries(HU_MONTHS)) {
    const weekMatch = s.match(new RegExp(`${name}\\s+(elso|masodik|harmadik|negyedik|utolso)\\s+het`))
    if (weekMatch) {
      const year = today.slice(0, 4)
      const monthStart = `${year}-${num}-01`
      const monthEnd = endOfMonth(monthStart)
      const weekMap: Record<string, number> = { elso: 0, masodik: 1, harmadik: 2, negyedik: 3 }
      if (weekMatch[1] === 'utolso') {
        const to = monthEnd
        const from = addDays(to, -6)
        return { from, to }
      }
      const weekIdx = weekMap[weekMatch[1]]
      let weekStart = startOfWeek(monthStart)
      if (weekStart < monthStart) weekStart = addDays(weekStart, 7)
      const from = addDays(weekStart, weekIdx * 7)
      const to = addDays(from, 6)
      return { from, to: to > monthEnd ? monthEnd : to }
    }

    const dayMatch = s.match(new RegExp(`${name}\\s+(\\d{1,2})`))
    if (dayMatch) {
      const year = today.slice(0, 4)
      const day = dayMatch[1].padStart(2, '0')
      const d = `${year}-${num}-${day}`
      return { from: d, to: d }
    }

    if (s === name || s === `${name}ban` || s === `${name}ben`) {
      const year = today.slice(0, 4)
      const monthStart = `${year}-${num}-01`
      return { from: monthStart, to: endOfMonth(monthStart) }
    }
  }

  return null
}

function escapeLike(s: string): string {
  return s.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_')
}

export async function tryHandleRecall(ctx: RouteContext): Promise<boolean> {
  const { res, path, method, url } = ctx

  if (path === '/api/recall' && method === 'GET') {
    const dateExpr = url.searchParams.get('date') || ''
    const query = url.searchParams.get('q') || ''
    const agent = url.searchParams.get('agent') || undefined
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200)

    if (query && !dateExpr) {
      const result = recallSearch(query, agent, limit)
      const formatted = formatRecallResult(result)
      json(res, formatted)
      return true
    }

    const range = dateExpr ? parseDateExpression(dateExpr) : { from: todayBudapest(), to: todayBudapest() }
    if (!range) {
      json(res, { error: `Nem értelmezhető dátum: "${dateExpr}"` }, 400)
      return true
    }

    const result = recallByDateRange(range.from, range.to, agent)

    if (query) {
      const escaped = escapeLike(query)
      const qLower = escaped.toLowerCase()
      result.logs = result.logs.filter(l => l.content.toLowerCase().includes(qLower))
      result.memories = result.memories.filter(m => m.content.toLowerCase().includes(qLower) || (m.keywords || '').toLowerCase().includes(qLower))
    }

    json(res, formatRecallResult(result))
    return true
  }

  if (path === '/api/recall/dates' && method === 'GET') {
    const agent = url.searchParams.get('agent') || MAIN_AGENT_ID
    const limit = Math.min(parseInt(url.searchParams.get('limit') || '90', 10), 365)
    json(res, getDailyLogDates(agent, limit))
    return true
  }

  return false
}

function formatRecallResult(result: { logs: any[]; memories: any[]; dateRange: { from: string; to: string } }) {
  return {
    dateRange: result.dateRange,
    logs: result.logs.map(l => ({
      ...l,
      created_label: new Date(l.created_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
    })),
    memories: result.memories.map(m => ({
      ...m,
      embedding: undefined,
      created_label: new Date(m.created_at * 1000).toLocaleString('hu-HU', { timeZone: TZ }),
    })),
    summary: {
      logCount: result.logs.length,
      memoryCount: result.memories.length,
      agents: [...new Set([...result.logs.map(l => l.agent_id), ...result.memories.map(m => m.agent_id)])],
    },
  }
}
