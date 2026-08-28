// 100% coverage for src/web/cron.ts.
//
// Layer strategy:
//   - Mock '../config.js' to control APP_TZ and SCHEDULER_TZ_CONFIGURED (the
//     two module-level constants cron.ts pulls in at import time). This lets
//     every test pin a stable, known zone and SCHEDULER_TZ_CONFIGURED state
//     instead of inheriting whatever the host's process env happens to look
//     like today.
//   - The real `cron-parser` is NOT mocked: cron.ts is a thin adapter over it,
//     and the whole point of the module is the boundary between cron-parser's
//     semantics and the scheduler's. Mocking it would make the assertions
//     tautological.
//   - From the heavy-deps template (../db.js, ../logger.js, ../web/auth-*.js,
//     node:child_process, node:os) NONE apply to cron.ts: the file imports
//     only `cron-parser` and `../config.js`, so mocking the others would be
//     a no-op. Documented here so the next reviewer does not add them.
//   - temp-sandbox.ts is not used either: cron.ts does no filesystem work,
//     and the suite is fully deterministic. Kept an explicit no-fs comment
//     so the absence is visible.
//
// Determinism:
//   - All time-pinned tests use vi.useFakeTimers + vi.setSystemTime; no real
//     setTimeout / setInterval is invoked from this suite.
//   - process.env is snapshotted per test, restored in afterEach.
//   - cron.ts binds `const CRON_TZ = APP_TZ` at module-evaluation time. Tests
//     that flip APP_TZ therefore call `vi.resetModules()` + dynamic re-import
//     so the freshly-imported module sees the new value. Without this the
//     default-tz tests would silently observe whichever APP_TZ was current at
//     the first import (the whole bug class that the comment in cron.ts
//     warns about).
//
// Functions exercised (every branch, every line):
//   - resolveCronTz           (config / TZ / system-default + ignore env.SCHEDULER_TZ)
//   - effectiveCronTz         (binds the same logic to process.env + Intl)
//   - computeNextRun          (Math.floor + CronExpressionParser.parse + next)
//   - isValidCronShape        (typeof guard, empty, length, regex, parse throw,
//                              parse success -- 6 branches)
//   - cronDueBetween          (delegates to cronPrevOccurrence)
//   - cronPrevOccurrence      (success + try/catch swallows throw + tz-default)
//   - cronMatchesNow          (back-compat shim over cronDueBetween)
//   - CRON_SHAPE_RX           (exported constant, pinned by direct tests)

import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'

// --- config.js mock --------------------------------------------------------
// cron.ts imports exactly two symbols from config.js: APP_TZ (used as the
// default tz for computeNextRun / isValidCronShape / cronDueBetween /
// cronPrevOccurrence / cronMatchesNow) and SCHEDULER_TZ_CONFIGURED (passed to
// effectiveCronTz). The mock is rewritten per test via helpers below so each
// scenario gets the exact consts it needs BEFORE the cron module is imported.

type ConfigShape = {
  APP_TZ: string
  SCHEDULER_TZ_CONFIGURED: string | undefined
}

const configState = vi.hoisted(() => ({
  APP_TZ: 'UTC' as string,
  SCHEDULER_TZ_CONFIGURED: undefined as string | undefined,
}))

vi.mock('../config.js', () => ({
  get APP_TZ(): string {
    return configState.APP_TZ
  },
  get SCHEDULER_TZ_CONFIGURED(): string | undefined {
    return configState.SCHEDULER_TZ_CONFIGURED
  },
}))

// --- env snapshot ---------------------------------------------------------
//
// `effectiveCronTz()` reads `process.env` directly. Snapshot before every
// test so a stray env mutation does not leak across tests.

const envSnap = vi.hoisted(() => ({ snap: { ...process.env }, restore: () => {} }))

beforeEach(() => {
  envSnap.snap = { ...process.env }
})
afterEach(() => {
  for (const k of Object.keys(process.env)) {
    if (!(k in envSnap.snap)) delete process.env[k]
  }
  for (const [k, v] of Object.entries(envSnap.snap)) {
    process.env[k] = v
  }
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.resetModules()
})

// --- suite-scoped helpers -------------------------------------------------

function setTz(appTz: string, configured: string | undefined): void {
  configState.APP_TZ = appTz
  configState.SCHEDULER_TZ_CONFIGURED = configured
  // Reset so the next import of cron.js evaluates `const CRON_TZ = APP_TZ`
  // against the new value.
  vi.resetModules()
}

async function loadCron(): Promise<typeof import('../web/cron.js')> {
  return import('../web/cron.js')
}

const ms = (utc: string): number => Date.parse(utc)

const UTC = 'UTC'
const BUDAPEST = 'Europe/Budapest'

// -- Module-level constant -------------------------------------------------

describe('CRON_SHAPE_RX', () => {
  it('matches a standard 5-field expression', async () => {
    const { CRON_SHAPE_RX } = await loadCron()
    expect(CRON_SHAPE_RX.test('30 7 * * *')).toBe(true)
  })

  it('matches a 6-field expression that includes seconds', async () => {
    const { CRON_SHAPE_RX } = await loadCron()
    expect(CRON_SHAPE_RX.test('0 30 7 * * *')).toBe(true)
  })

  it('rejects an expression with too few fields', async () => {
    const { CRON_SHAPE_RX } = await loadCron()
    expect(CRON_SHAPE_RX.test('30 7 * *')).toBe(false)
  })

  it('rejects an expression with too many fields', async () => {
    const { CRON_SHAPE_RX } = await loadCron()
    expect(CRON_SHAPE_RX.test('0 0 30 7 * * *')).toBe(false)
  })

  it('rejects empty / whitespace-only strings', async () => {
    const { CRON_SHAPE_RX } = await loadCron()
    expect(CRON_SHAPE_RX.test('')).toBe(false)
    expect(CRON_SHAPE_RX.test('   ')).toBe(false)
  })

  // The regex uses single \s between fields; a single contiguous block of
  // whitespace still satisfies the \s+ quantifier (one or more), so the
  // shape-count check is what fails, not the regex itself. Covered in the
  // field-count tests above.
  it('rejects empty input', async () => {
    const { CRON_SHAPE_RX } = await loadCron()
    expect(CRON_SHAPE_RX.test('   ')).toBe(false) // all whitespace -> tokens are \S+
    expect(CRON_SHAPE_RX.test('* * * *')).toBe(false) // 4 \S+ tokens
  })
})

// -- resolveCronTz ---------------------------------------------------------

describe('resolveCronTz source precedence', () => {
  it('prefers configured SCHEDULER_TZ regardless of process.env.TZ', async () => {
    const { resolveCronTz } = await loadCron()
    expect(resolveCronTz('Europe/Budapest', { TZ: 'UTC' }, 'UTC')).toEqual({
      tz: 'Europe/Budapest',
      source: 'SCHEDULER_TZ',
    })
  })

  it('falls back to env.TZ when configured is undefined', async () => {
    const { resolveCronTz } = await loadCron()
    expect(resolveCronTz(undefined, { TZ: 'Europe/Budapest' }, 'Europe/Budapest')).toEqual({
      tz: 'Europe/Budapest',
      source: 'TZ',
    })
  })

  it('returns the system zone with source "TZ" when env.TZ explains the system zone', async () => {
    // The reporter explains WHY the system zone is what it is; the tz
    // reported stays as systemTz. Locked here so a future "show the env
    // value" change is a deliberate decision.
    const { resolveCronTz } = await loadCron()
    expect(resolveCronTz(undefined, { TZ: 'Europe/Budapest' }, 'Europe/Budapest')).toEqual({
      tz: 'Europe/Budapest',
      source: 'TZ',
    })
  })

  it('returns the system zone with source "system-default" when env.TZ is unset', async () => {
    const { resolveCronTz } = await loadCron()
    expect(resolveCronTz(undefined, {}, 'UTC')).toEqual({ tz: 'UTC', source: 'system-default' })
  })

  it('treats a configured value as authoritative even with no env.TZ', async () => {
    const { resolveCronTz } = await loadCron()
    expect(resolveCronTz('Europe/Budapest', {}, 'UTC')).toEqual({
      tz: 'Europe/Budapest',
      source: 'SCHEDULER_TZ',
    })
  })

  it('ignores an env.SCHEDULER_TZ (cfg() does not read process.env)', async () => {
    // The reverse-direction defect from the 2026-07 outage: a SCHEDULER_TZ
    // exported into process.env but never reaching cfg() must still report
    // system-default, not falsely announce SCHEDULER_TZ.
    const { resolveCronTz } = await loadCron()
    expect(resolveCronTz(undefined, { SCHEDULER_TZ: 'Europe/Budapest' }, 'UTC')).toEqual({
      tz: 'UTC',
      source: 'system-default',
    })
  })

  it('treats a truthy configured value as a hit even when it equals the system zone', async () => {
    const { resolveCronTz } = await loadCron()
    expect(resolveCronTz('UTC', {}, 'UTC')).toEqual({ tz: 'UTC', source: 'SCHEDULER_TZ' })
  })
})

// -- effectiveCronTz -------------------------------------------------------

describe('effectiveCronTz binds resolveCronTz to the real env + Intl', () => {
  it('reports SCHEDULER_TZ when the config layer has it set', async () => {
    setTz(BUDAPEST, BUDAPEST)
    vi.stubGlobal('Intl', {
      ...Intl,
      DateTimeFormat: () =>
        ({ resolvedOptions: () => ({ timeZone: 'Atlantic/Reykjavik' }) }) as unknown as Intl.DateTimeFormat,
    })
    const { effectiveCronTz } = await loadCron()
    expect(effectiveCronTz()).toEqual({ tz: BUDAPEST, source: 'SCHEDULER_TZ' })
  })

  it('reports TZ-source when env.TZ is set and SCHEDULER_TZ is not configured', async () => {
    setTz(UTC, undefined)
    delete process.env.SCHEDULER_TZ
    process.env.TZ = 'Europe/Budapest'
    vi.stubGlobal('Intl', {
      ...Intl,
      DateTimeFormat: () =>
        ({ resolvedOptions: () => ({ timeZone: 'Europe/Budapest' }) }) as unknown as Intl.DateTimeFormat,
    })
    const { effectiveCronTz } = await loadCron()
    expect(effectiveCronTz()).toEqual({ tz: 'Europe/Budapest', source: 'TZ' })
  })

  it('reports system-default (and uses the Intl-resolved host zone) when neither is configured', async () => {
    setTz(UTC, undefined)
    delete process.env.SCHEDULER_TZ
    delete process.env.TZ
    vi.stubGlobal('Intl', {
      ...Intl,
      DateTimeFormat: () =>
        ({ resolvedOptions: () => ({ timeZone: 'Atlantic/Reykjavik' }) }) as unknown as Intl.DateTimeFormat,
    })
    const { effectiveCronTz } = await loadCron()
    expect(effectiveCronTz()).toEqual({ tz: 'Atlantic/Reykjavik', source: 'system-default' })
  })

  it('reads SCHEDULER_TZ from the config module, NOT from process.env', async () => {
    // The whole fix: a SCHEDULER_TZ set in config-overrides.json is reachable
    // through SCHEDULER_TZ_CONFIGURED but is NOT in process.env -- so a
    // correctly configured install must report SCHEDULER_TZ, not
    // system-default.
    setTz(BUDAPEST, BUDAPEST)
    delete process.env.SCHEDULER_TZ
    vi.stubGlobal('Intl', {
      ...Intl,
      DateTimeFormat: () =>
        ({ resolvedOptions: () => ({ timeZone: 'Atlantic/Reykjavik' }) }) as unknown as Intl.DateTimeFormat,
    })
    const { effectiveCronTz } = await loadCron()
    expect(effectiveCronTz().source).toBe('SCHEDULER_TZ')
  })
})

// -- computeNextRun --------------------------------------------------------

describe('computeNextRun', () => {
  it('returns Math.floor of the next occurrence in the passed zone', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z')) // 07:30:20 Budapest
    const { computeNextRun } = await loadCron()
    // Next "30 7" after 07:30:20 Budapest is tomorrow 07:30 Budapest ==
    // 2026-07-16T05:30:00Z.
    expect(computeNextRun('30 7 * * *', BUDAPEST)).toBe(
      Math.floor(Date.parse('2026-07-16T05:30:00Z') / 1000),
    )
  })

  it('uses CRON_TZ (== APP_TZ) when tz is omitted', async () => {
    setTz(BUDAPEST, undefined)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z'))
    const { computeNextRun } = await loadCron()
    expect(computeNextRun('30 7 * * *')).toBe(
      Math.floor(Date.parse('2026-07-16T05:30:00Z') / 1000),
    )
  })

  it('honours a 6-field (with-seconds) cron', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:29:00Z'))
    const { computeNextRun } = await loadCron()
    // Next "0 30 7 * * *" after 07:29:00 Budapest is TODAY 07:30:00.
    expect(computeNextRun('0 30 7 * * *', BUDAPEST)).toBe(
      Math.floor(Date.parse('2026-07-15T05:30:00Z') / 1000),
    )
  })

  it('returns an integer second (Math.floor, not a fractional ms)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:29:59.999Z'))
    const { computeNextRun } = await loadCron()
    const n = computeNextRun('30 7 * * *', BUDAPEST)
    expect(Number.isInteger(n)).toBe(true)
  })
})

// -- isValidCronShape ------------------------------------------------------

describe('isValidCronShape', () => {
  it('rejects a non-string', async () => {
    const { isValidCronShape } = await loadCron()
    expect(isValidCronShape(undefined)).toBe(false)
    expect(isValidCronShape(null)).toBe(false)
    expect(isValidCronShape(123)).toBe(false)
    expect(isValidCronShape({})).toBe(false)
    expect(isValidCronShape([])).toBe(false)
    expect(isValidCronShape(true)).toBe(false)
  })

  it('rejects an empty / whitespace-only string', async () => {
    const { isValidCronShape } = await loadCron()
    expect(isValidCronShape('')).toBe(false)
    expect(isValidCronShape('   ')).toBe(false)
    expect(isValidCronShape('\t\n')).toBe(false)
  })

  it('rejects a string longer than 100 chars', async () => {
    const { isValidCronShape } = await loadCron()
    const long = '* * * * * ' + 'a'.repeat(100)
    expect(isValidCronShape(long)).toBe(false)
  })

  it('rejects a string that does not match the field shape', async () => {
    const { isValidCronShape } = await loadCron()
    // 4 fields -> regex fail before parser is reached.
    expect(isValidCronShape('30 7 * *')).toBe(false)
    // Oversized field count -> regex fail.
    expect(isValidCronShape('0 0 30 7 * * *')).toBe(false)
  })

  it('rejects a shape-matching string that cron-parser cannot parse', async () => {
    // Regex passes (5 fields), but the values are junk to cron-parser.
    const { isValidCronShape } = await loadCron()
    expect(isValidCronShape('99 99 99 99 99')).toBe(false)
  })

  it('accepts a real 5-field cron', async () => {
    const { isValidCronShape } = await loadCron()
    expect(isValidCronShape('30 7 * * *')).toBe(true)
    expect(isValidCronShape('*/15 * * * *')).toBe(true)
    expect(isValidCronShape('0 2,14 * * *')).toBe(true)
  })

  it('accepts a real 6-field cron (with seconds)', async () => {
    const { isValidCronShape } = await loadCron()
    expect(isValidCronShape('0 30 7 * * *')).toBe(true)
  })

  it('trims surrounding whitespace before validating', async () => {
    const { isValidCronShape } = await loadCron()
    expect(isValidCronShape('   30 7 * * *   ')).toBe(true)
  })

  it('rejects the empty string after trimming (no false pass)', async () => {
    const { isValidCronShape } = await loadCron()
    expect(isValidCronShape(' ')).toBe(false)
  })
})

// -- cronPrevOccurrence + cronDueBetween -----------------------------------

describe('cronPrevOccurrence', () => {
  it('returns the previous occurrence as a number when one falls in the window', async () => {
    const { cronPrevOccurrence } = await loadCron()
    const at = ms('2026-07-15T05:30:00Z') // 07:30 Budapest
    const from = at - 30_000
    const to = at + 30_000
    // The 07:30 occurrence IS in (from, to], so we get its ms back.
    expect(cronPrevOccurrence('30 7 * * *', from, to, BUDAPEST)).toBe(at)
  })

  it('returns null when no occurrence falls in the window', async () => {
    const { cronPrevOccurrence } = await loadCron()
    // Window [07:31, 07:35] -- the 07:30 occurrence is BEFORE from.
    expect(
      cronPrevOccurrence('30 7 * * *', ms('2026-07-15T05:31:00Z'), ms('2026-07-15T05:35:00Z'), BUDAPEST),
    ).toBeNull()
  })

  it('returns null when an occurrence is exactly on the from edge (half-open)', async () => {
    const { cronPrevOccurrence } = await loadCron()
    // 07:30 == from -> excluded, null. (from, to] is the contract.
    const at = ms('2026-07-15T05:30:00Z')
    expect(cronPrevOccurrence('30 7 * * *', at, at + 60_000, BUDAPEST)).toBeNull()
  })

  it('returns the occurrence when it lands EXACTLY on the to edge (inclusive)', async () => {
    // The +1ms nudge in cronPrevOccurrence buys us a true half-open (from,
    // to]: an O === toMs is included here AND excluded next tick (O === from
    // then, also excluded). Without the +1, a boundary occurrence is lost.
    const { cronPrevOccurrence } = await loadCron()
    const at = ms('2026-07-15T05:30:00Z')
    expect(cronPrevOccurrence('30 7 * * *', at - 60_000, at, BUDAPEST)).toBe(at)
  })

  it('swallows an invalid-cron throw into null (catch branch)', async () => {
    // Path that is otherwise unreachable from cronDueBetween (caller also
    // catches, but cronPrevOccurrence has its own try/catch contract worth
    // locking directly).
    const { cronPrevOccurrence } = await loadCron()
    const at = ms('2026-07-15T05:30:00Z')
    // '99 99 99 99 99' has 5 fields so it passes the shape regex and reaches
    // cron-parser, which then rejects the values. Either way
    // cronPrevOccurrence must return null and not throw.
    expect(() => cronPrevOccurrence('99 99 99 99 99', at - 60_000, at, BUDAPEST)).not.toThrow()
    expect(cronPrevOccurrence('99 99 99 99 99', at - 60_000, at, BUDAPEST)).toBeNull()
  })

  it('swallows an unknown-timezone throw into null', async () => {
    const { cronPrevOccurrence } = await loadCron()
    const at = ms('2026-07-15T05:30:00Z')
    expect(cronPrevOccurrence('30 7 * * *', at - 60_000, at, 'Europe/Budapesst')).toBeNull()
  })

  it('uses CRON_TZ (APP_TZ) when tz is omitted', async () => {
    setTz(BUDAPEST, undefined)
    const { cronPrevOccurrence } = await loadCron()
    const at = ms('2026-07-15T05:30:00Z')
    expect(cronPrevOccurrence('30 7 * * *', at - 60_000, at)).toBe(at)
  })
})

describe('cronDueBetween delegates to cronPrevOccurrence', () => {
  it('returns true when an occurrence is in the window', async () => {
    const { cronDueBetween } = await loadCron()
    expect(
      cronDueBetween(
        '30 7 * * *',
        ms('2026-07-15T05:29:30Z'),
        ms('2026-07-15T05:31:00Z'),
        BUDAPEST,
      ),
    ).toBe(true)
  })

  it('returns false when no occurrence is in the window', async () => {
    const { cronDueBetween } = await loadCron()
    expect(
      cronDueBetween(
        '30 7 * * *',
        ms('2026-07-15T05:31:00Z'),
        ms('2026-07-15T05:35:00Z'),
        BUDAPEST,
      ),
    ).toBe(false)
  })

  it('returns false when an occurrence is exactly on the from edge', async () => {
    const { cronDueBetween } = await loadCron()
    const at = ms('2026-07-15T05:30:00Z')
    expect(cronDueBetween('30 7 * * *', at, at + 60_000, BUDAPEST)).toBe(false)
  })

  it('uses CRON_TZ (APP_TZ) when tz is omitted', async () => {
    setTz(BUDAPEST, undefined)
    const { cronDueBetween } = await loadCron()
    expect(
      cronDueBetween('30 7 * * *', ms('2026-07-15T05:29:30Z'), ms('2026-07-15T05:31:00Z')),
    ).toBe(true)
  })

  it('is false for an occurrence exactly on the to edge if it is the only hit and from eats it', async () => {
    // Cover the dual-edge case: occurrence at to, from >= to -> half-open
    // makes it excluded.
    const { cronDueBetween } = await loadCron()
    const at = ms('2026-07-15T05:30:00Z')
    expect(cronDueBetween('30 7 * * *', at - 60_000, at - 1, BUDAPEST)).toBe(false)
  })
})

// -- cronMatchesNow back-compat --------------------------------------------

describe('cronMatchesNow back-compat shim', () => {
  it('is equivalent to cronDueBetween with a (now - catchUpMs, now] window', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z'))
    const { cronMatchesNow } = await loadCron()
    expect(cronMatchesNow('30 7 * * *', 60_000, BUDAPEST)).toBe(true)
    expect(cronMatchesNow('30 7 * * *', 60_000, UTC)).toBe(false)
  })

  it('an interval cron is timezone-invariant', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T12:00:20Z')) // 14:00 Budapest / 12:00 UTC
    const { cronMatchesNow } = await loadCron()
    expect(cronMatchesNow('*/15 * * * *', 60_000, BUDAPEST)).toBe(true)
    expect(cronMatchesNow('*/15 * * * *', 60_000, UTC)).toBe(true)
  })

  it('returns false when no occurrence lands in the catchUpMs window', async () => {
    vi.useFakeTimers()
    // Set clock to 06:00 UTC (08:00 Budapest). The 07:30 occurrence is 90 min
    // ago; a 60s window misses it -> false (and not starved, just outside
    // the window).
    vi.setSystemTime(new Date('2026-07-15T06:00:00Z'))
    const { cronMatchesNow } = await loadCron()
    expect(cronMatchesNow('30 7 * * *', 60_000, BUDAPEST)).toBe(false)
  })

  it('default catchUpMs is 60000 (one minute)', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z'))
    const { cronMatchesNow } = await loadCron()
    // Inside 60s? yes.
    expect(cronMatchesNow('30 7 * * *', undefined, BUDAPEST)).toBe(true)
  })

  it('uses CRON_TZ (APP_TZ) when tz is omitted', async () => {
    setTz(BUDAPEST, undefined)
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-07-15T05:30:20Z'))
    const { cronMatchesNow } = await loadCron()
    expect(cronMatchesNow('30 7 * * *')).toBe(true)
  })
})

// -- Sparse-cron starvation regression (full simulation) -------------------

describe('sparse-cron starvation is fixed under realistic tick drift', () => {
  // Drive contiguous (previous-tick, now] windows exactly like the runner,
  // ticks 61s apart over a full day. A daily cron must fire EXACTLY once
  // (not zero -> starvation, not twice -> double fire); a */15 cron fires
  // on essentially every occurrence.

  it('fires a daily cron exactly once over 24h with 61s ticks', async () => {
    const { cronDueBetween } = await loadCron()
    const start = ms('2026-07-14T22:00:30Z')
    const end = start + 24 * 3600 * 1000
    let lastCheck = start
    let fires = 0
    for (let now = start + 61_000; now <= end; now += 61_000) {
      if (cronDueBetween('30 7 * * *', lastCheck, now, BUDAPEST)) fires++
      lastCheck = now
    }
    expect(fires).toBe(1)
  })

  it('fires a twice-daily cron exactly twice over 24h with 61s ticks', async () => {
    const { cronDueBetween } = await loadCron()
    const start = ms('2026-07-14T22:00:30Z')
    const end = start + 24 * 3600 * 1000
    let lastCheck = start
    let fires = 0
    for (let now = start + 61_000; now <= end; now += 61_000) {
      if (cronDueBetween('0 2,14 * * *', lastCheck, now, BUDAPEST)) fires++
      lastCheck = now
    }
    expect(fires).toBe(2)
  })

  it('fires a */15 interval cron ~96 times over 24h', async () => {
    const { cronDueBetween } = await loadCron()
    const start = ms('2026-07-14T22:00:30Z')
    const end = start + 24 * 3600 * 1000
    let lastCheck = start
    let fires = 0
    for (let now = start + 61_000; now <= end; now += 61_000) {
      if (cronDueBetween('*/15 * * * *', lastCheck, now, BUDAPEST)) fires++
      lastCheck = now
    }
    expect(fires).toBeGreaterThanOrEqual(95)
  })

  it('a 3-minute tick gap still catches a daily occurrence (exactly once)', async () => {
    const { cronDueBetween } = await loadCron()
    const start = ms('2026-07-14T22:00:30Z')
    const end = start + 24 * 3600 * 1000
    let lastCheck = start
    let fires = 0
    for (let now = start + 180_000; now <= end; now += 180_000) {
      if (cronDueBetween('30 7 * * *', lastCheck, now, BUDAPEST)) fires++
      lastCheck = now
    }
    expect(fires).toBe(1)
  })
})
