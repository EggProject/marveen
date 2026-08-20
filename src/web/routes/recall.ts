import { DateTime } from 'luxon'
import { recallByDateRange, recallSearch, getDailyLogDates } from '../../db.js'
import { MAIN_AGENT_ID, APP_TZ } from '../../config.js'
import { json } from '../http-helpers.js'
import type { RouteContext } from './types.js'

const TZ = APP_TZ  // install zone (config.APP_TZ); was hardcoded Europe/Budapest

function todayBudapest(): string {
  return DateTime.now().setZone(TZ).toFormat('yyyy-MM-dd')
}

// Test-only export: the weekday algorithm against an explicit TZ.
// Kept so the cross-zone pin test in recall.test.ts can exercise UTC+12+
// zones without faking APP_TZ (test-sandbox-setup mocks config.js, which
// leaks APP_TZ=undefined into this module; the production TZ is therefore
// uncontrollable from a dynamic import inside vitest).
export function __test__dayOfWeekBudapestWithTz(tz: string, dateStr: string): number {
  return DateTime.fromISO(dateStr, { zone: tz }).weekday % 7
}

// Luxon parses dateStr as midnight IN the zone, so the calendar day is never
// re-derived from a UTC instant. That is what retires the noon-UTC anchor bug
// (recall-dayofweek-noon-utc-far-east-skew): for install zones at UTC+12 and
// beyond the old probe crossed a calendar day and read the weekday for
// dateStr+1.
function addDays(dateStr: string, days: number): string {
  return DateTime.fromISO(dateStr, { zone: TZ }).plus({ days }).toFormat('yyyy-MM-dd')
}

// Luxon's weekday is 1=Monday..7=Sunday; callers here want 0=Sunday..6=Saturday,
// which `% 7` gives directly (Sun 7->0, Mon 1->1, ... Sat 6->6).
function dayOfWeekBudapest(dateStr: string): number {
  return DateTime.fromISO(dateStr, { zone: TZ }).weekday % 7
}

// Test-only export: the PRODUCTION weekday helper (TZ-baked, no parameter).
// Used by the cross-zone pin test in recall.test.ts to assert that the SUT
// -- not just a test-only helper -- resolves the weekday in the install zone.
export const __test__dayOfWeekBudapestProduction = dayOfWeekBudapest

function startOfWeek(dateStr: string): string {
  const weekday = DateTime.fromISO(dateStr, { zone: TZ }).weekday
  const offset = weekday === 7 ? -6 : 1 - weekday
  return addDays(dateStr, offset)
}

function startOfMonth(dateStr: string): string {
  return dateStr.slice(0, 8) + '01'
}

function endOfMonth(dateStr: string): string {
  return DateTime.fromISO(dateStr, { zone: TZ }).endOf('month').toFormat('yyyy-MM-dd')
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
