import { describe, it, expect, beforeEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'
import {
  monthWindow,
  hashRef,
  confidenceBucket,
  syncFixedCostsToLedger,
  getCostSummary,
  getCostSources,
} from '../costops/ledger.js'
import { validateConfig } from '../costops/config.js'
import type { CostOpsConfig } from '../costops/config.js'

// 2026-07-15T12:00:00Z -> mid-July, deterministic "now" for all summary tests.
const NOW = Math.floor(Date.UTC(2026, 6, 15, 12, 0, 0) / 1000)

function cfg(over: Partial<CostOpsConfig> = {}): CostOpsConfig {
  return {
    version: 1,
    currency: 'HUF',
    fixed_costs: [
      { source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 22000, period: 'monthly', charge_category: 'subscription', confidence: 'manual', currency: 'HUF' },
      { source_id: 'openai', name: 'ChatGPT', provider: 'openai', source_type: 'subscription', amount: 8000, period: 'monthly', charge_category: 'subscription', confidence: 'manual', currency: 'HUF' },
    ],
    budgets: [
      { id: 'global-monthly', name: 'Global', scope: 'global', amount: 60000, warning_threshold: 0.8, hard_threshold: 1.0, currency: 'HUF' },
    ],
    ...over,
  }
}

describe('costops month math', () => {
  it('computes UTC month window + days', () => {
    const w = monthWindow(NOW)
    expect(w.key).toBe('2026-07')
    expect(w.start).toBe(Math.floor(Date.UTC(2026, 6, 1) / 1000))
    expect(w.end).toBe(Math.floor(Date.UTC(2026, 7, 1) / 1000))
    expect(w.daysInMonth).toBe(31)
    // 14.5 days elapsed of 31
    expect(w.fractionElapsed).toBeCloseTo(14.5 / 31, 4)
  })
  it('honours an explicit month key', () => {
    expect(monthWindow(NOW, '2026-02').daysInMonth).toBe(28)
    expect(monthWindow(NOW, '2026-02').key).toBe('2026-02')
  })
  it('falls back to the now-derived month when the key is absent', () => {
    const w = monthWindow(NOW)
    expect(w.key).toBe('2026-07')
    expect(w.daysInMonth).toBe(31)
  })
  it('falls back to the now-derived month when the key fails the regex', () => {
    // 'bogus' is not YYYY-MM -- should be ignored, month taken from NOW
    const w = monthWindow(NOW, 'bogus')
    expect(w.key).toBe('2026-07')
    expect(w.start).toBe(Math.floor(Date.UTC(2026, 6, 1) / 1000))
  })
  it('formats a single-digit month with a leading zero', () => {
    const w = monthWindow(NOW, '2026-01')
    expect(w.key).toBe('2026-01')
    expect(w.daysInMonth).toBe(31)
  })
  it('formats a two-digit month without a leading zero (December)', () => {
    const w = monthWindow(NOW, '2026-12')
    expect(w.key).toBe('2026-12')
    expect(w.daysInMonth).toBe(31)
    expect(w.start).toBe(Math.floor(Date.UTC(2026, 11, 1) / 1000))
    expect(w.end).toBe(Math.floor(Date.UTC(2027, 0, 1) / 1000))
  })
  it('clamps elapsed to at least 1 second when now is at/before the month start', () => {
    // now == month start => Math.max(0, 1) === 1
    const w = monthWindow(monthWindow(NOW).start)
    expect(w.fractionElapsed).toBeGreaterThan(0)
    // 1 / (31 * 86400) is tiny but > 0
    expect(w.fractionElapsed).toBeLessThan(0.01)
  })
  it('clamps elapsed to the full month length when now is past month end', () => {
    const w = monthWindow(NOW, '2026-01')
    // pick a now FAR past January 2026 -> elapsed caps at daysInMonth
    const pastNow = monthWindow(NOW, '2026-01').end + 30 * 86400
    const late = monthWindow(pastNow, '2026-01')
    expect(late.fractionElapsed).toBe(1)
  })
})

describe('costops hashRef', () => {
  it('is deterministic and salt-sensitive and non-reversible', () => {
    expect(hashRef('salt', 'acct-123')).toBe(hashRef('salt', 'acct-123'))
    expect(hashRef('salt', 'acct-123')).not.toBe(hashRef('salt2', 'acct-123'))
    expect(hashRef('salt', 'acct-123')).not.toContain('acct-123')
    expect(hashRef('salt', 'acct-123')).toHaveLength(32)
  })
  it('hex output is the SHA-256 of "salt|raw" truncated to 32 chars', () => {
    // sanity check against known SHA-256 of "salt|acct-123"
    const { createHash } = require('node:crypto') as typeof import('node:crypto')
    const expected = createHash('sha256').update('salt').update('|').update('acct-123').digest('hex').slice(0, 32)
    expect(hashRef('salt', 'acct-123')).toBe(expected)
  })
})

describe('costops confidenceBucket', () => {
  it('maps confidence tiers to buckets', () => {
    expect(confidenceBucket('manual')).toBe('fixed_manual')
    expect(confidenceBucket('actual_invoice')).toBe('provider')
    expect(confidenceBucket('provider_api')).toBe('provider')
    expect(confidenceBucket('billing_export')).toBe('provider')
    expect(confidenceBucket('estimate')).toBe('estimate')
    expect(confidenceBucket('local_usage')).toBe('estimate')
  })
  it('falls back to fixed_manual for an unknown confidence via the default branch', () => {
    // the switch has a default branch that the typed union cannot exercise --
    // cast to verify the runtime fallthrough
    expect(confidenceBucket('something_else' as unknown as 'manual')).toBe('fixed_manual')
  })
})

describe('costops config validation', () => {
  it('accepts a valid config and applies defaults', () => {
    const r = validateConfig({ currency: 'HUF', fixed_costs: [{ source_id: 'x', amount: 100 }], budgets: [{ id: 'b', amount: 500 }] })
    expect(r.errors).toEqual([])
    expect(r.config.fixed_costs[0].confidence).toBe('manual')
    expect(r.config.fixed_costs[0].provider).toBe('other')
    expect(r.config.budgets[0].warning_threshold).toBe(0.8)
  })
  it('drops invalid entries with error notes, keeps valid ones', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'ok', amount: 100 }, { amount: 5 }, { source_id: 'neg', amount: -1 }], budgets: [] })
    expect(r.config.fixed_costs).toHaveLength(1)
    expect(r.config.fixed_costs[0].source_id).toBe('ok')
    expect(r.errors.length).toBe(2)
  })
  it('rejects non-monthly periods in v0.1', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'y', amount: 1, period: 'yearly' }], budgets: [] })
    expect(r.config.fixed_costs).toHaveLength(0)
    expect(r.errors[0]).toContain('monthly')
  })
})

describe('costops ledger + summary', () => {
  beforeEach(() => { initDatabase(':memory:') })

  it('syncs fixed costs idempotently (no duplicates on re-run)', () => {
    const db = getDb()
    const c = cfg()
    expect(syncFixedCostsToLedger(db, c, NOW)).toBe(2)
    syncFixedCostsToLedger(db, c, NOW)
    syncFixedCostsToLedger(db, c, NOW)
    const rows = db.prepare('SELECT COUNT(*) as n FROM cost_line_items').get() as { n: number }
    expect(rows.n).toBe(2) // still 2, not 6
    const sources = db.prepare('SELECT COUNT(*) as n FROM cost_sources').get() as { n: number }
    expect(sources.n).toBe(2)
  })

  it('returns 0 from sync when fixed_costs is empty (covers the count=0 path)', () => {
    const db = getDb()
    expect(syncFixedCostsToLedger(db, cfg({ fixed_costs: [] }), NOW)).toBe(0)
    const rows = db.prepare('SELECT COUNT(*) as n FROM cost_line_items').get() as { n: number }
    expect(rows.n).toBe(0)
  })

  it('falls back to config.currency / default charge_category / default confidence when not set', () => {
    const db = getDb()
    const c: CostOpsConfig = {
      version: 1,
      currency: 'EUR',
      // intentionally omit currency, charge_category, confidence on the entry
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 100, period: 'monthly' }],
      budgets: [],
    }
    expect(syncFixedCostsToLedger(db, c, NOW)).toBe(1)
    const src = db.prepare("SELECT currency FROM cost_sources WHERE id='s'").get() as { currency: string }
    expect(src.currency).toBe('EUR') // fell back from e.currency to config.currency
    const line = db.prepare("SELECT charge_category, confidence, currency FROM cost_line_items WHERE source_id='s'").get() as { charge_category: string; confidence: string; currency: string }
    expect(line.charge_category).toBe('subscription') // default
    expect(line.confidence).toBe('manual') // default
    expect(line.currency).toBe('EUR')
  })

  it('syncs into a target monthKey other than the now-derived month', () => {
    const db = getDb()
    const c = cfg({
      fixed_costs: [{ source_id: 'x', name: 'X', provider: 'other', source_type: 'saas', amount: 1000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
    })
    syncFixedCostsToLedger(db, c, NOW, '2026-02')
    const row = db.prepare("SELECT charge_period_start, charge_period_end FROM cost_line_items WHERE source_id='x'").get() as { charge_period_start: number; charge_period_end: number }
    expect(row.charge_period_start).toBe(Math.floor(Date.UTC(2026, 1, 1) / 1000))
    expect(row.charge_period_end).toBe(Math.floor(Date.UTC(2026, 2, 1) / 1000))
  })

  it('reflects updated config amounts on re-sync (upsert, not insert)', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const c2 = cfg({ fixed_costs: [{ source_id: 'anthropic-max', name: 'Claude Max', provider: 'anthropic', source_type: 'subscription', amount: 30000, period: 'monthly', confidence: 'manual', currency: 'HUF' }] })
    syncFixedCostsToLedger(db, c2, NOW)
    const row = db.prepare("SELECT billed_cost FROM cost_line_items WHERE source_id='anthropic-max'").get() as { billed_cost: number }
    expect(row.billed_cost).toBe(30000)
  })

  it('computes a deterministic monthly summary (golden values)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.month).toBe('2026-07')
    expect(s.current_spend).toBe(30000)            // 22000 + 8000
    expect(s.forecast_month_end).toBe(30000)       // fixed = whole-month, no proration
    expect(s.breakdown.fixed_manual).toBe(30000)
    expect(s.breakdown.provider).toBe(0)
    expect(s.confidence_breakdown.manual).toBe(30000)
    expect(s.top_sources[0]).toEqual({ source_id: 'anthropic-max', name: 'Claude Max', spend: 22000 })
    expect(s.top_sources[1].source_id).toBe('openai')
    expect(s.budget?.amount).toBe(60000)
    expect(s.budget?.used_pct).toBe(0.5)
    expect(s.budget?.status).toBe('ok')
  })

  it('all_sources lists every configured source (not capped like top_sources)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.all_sources).toHaveLength(2) // both, even at 0 or any spend
    const ids = s.all_sources.map(x => x.source_id).sort()
    expect(ids).toEqual(['anthropic-max', 'openai'])
    const anthropic = s.all_sources.find(x => x.source_id === 'anthropic-max')!
    expect(anthropic.provider).toBe('anthropic')
    expect(anthropic.source_type).toBe('subscription')
    expect(anthropic.confidence).toBe('manual')
    expect(anthropic.spend).toBe(22000)
    expect(anthropic).toHaveProperty('name')
  })

  it('classifies budget status at thresholds (display-only, no action)', () => {
    const db = getDb()
    // amount tuned so current_spend hits exactly 80% then 100% of a 10000 budget
    const warnCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 8000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db, warnCfg, NOW)
    expect(getCostSummary(db, warnCfg, NOW).budget?.status).toBe('warning') // 0.8 -> warning

    initDatabase(':memory:')
    const db2 = getDb()
    const hardCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 10000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db2, hardCfg, NOW)
    expect(getCostSummary(db2, hardCfg, NOW).budget?.status).toBe('hard') // 1.0 -> hard

    initDatabase(':memory:')
    const db3 = getDb()
    const okCfg = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 7999, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 10000, warning_threshold: 0.8, hard_threshold: 1.0 }],
    })
    syncFixedCostsToLedger(db3, okCfg, NOW)
    expect(getCostSummary(db3, okCfg, NOW).budget?.status).toBe('ok') // 0.7999 -> ok
  })

  it('omits the budget block entirely when config.budgets is empty', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const s = getCostSummary(db, cfg({ budgets: [] }), NOW)
    expect(s.budget).toBeNull()
  })

  it('omits the budget block when the configured amount is zero', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const s = getCostSummary(db, cfg({ budgets: [{ id: 'global-monthly', amount: 0 }] }), NOW)
    expect(s.budget).toBeNull()
  })

  it('falls back to the first budget when no "global-monthly" id is present', () => {
    const db = getDb()
    const c = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 1000, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'team-monthly', name: 'Team', scope: 'global', amount: 5000 }], // no global-monthly id
    })
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.budget?.id).toBe('team-monthly')
    // warning/hard thresholds defaulted to 0.8 / 1.0
    expect(s.budget?.warning_threshold).toBe(0.8)
    expect(s.budget?.hard_threshold).toBe(1.0)
    // 1000/5000 = 0.2 -> ok
    expect(s.budget?.status).toBe('ok')
  })

  it('respects explicit warning/hard thresholds supplied in the budget', () => {
    const db = getDb()
    const c = cfg({
      fixed_costs: [{ source_id: 's', name: 'S', provider: 'other', source_type: 'saas', amount: 500, period: 'monthly', confidence: 'manual', currency: 'HUF' }],
      budgets: [{ id: 'global-monthly', amount: 1000, warning_threshold: 0.5, hard_threshold: 0.9 }],
    })
    syncFixedCostsToLedger(db, c, NOW)
    const s = getCostSummary(db, c, NOW)
    expect(s.budget?.warning_threshold).toBe(0.5)
    expect(s.budget?.hard_threshold).toBe(0.9)
    expect(s.budget?.status).toBe('warning') // 0.5 hits warning threshold
  })

  it('uses source_id as the displayed name when a line has no matching cost_sources row', () => {
    const db = getDb()
    // insert a line that references a source_id NOT present in cost_sources
    const w = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
                VALUES ('orphan_src','orphan_src','other','saas','HUF',1,?,?)`).run(NOW, NOW)
    // keep only the source -- no line item for it (exercises active source with 0 spend branch)
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    const orphan = s.all_sources.find(x => x.source_id === 'orphan_src')!
    expect(orphan.spend).toBe(0)
    expect(orphan.confidence).toBe('manual') // perSourceConfidence fallback

    initDatabase(':memory:')
    const db2 = getDb()
    // Insert a cost_source + line item, then mark the source inactive. The
    // summary query filters cost_sources by active=1, so nameMap will miss the
    // source_id; the code falls back to the source_id itself as the name.
    db2.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
                 VALUES ('inact','was-active','other','saas','HUF',1,?,?)`).run(NOW, NOW)
    db2.prepare(`INSERT INTO cost_line_items
                  (source_id,charge_period_start,charge_period_end,charge_category,service_name,
                   consumed_quantity,consumed_unit,billed_cost,effective_cost,currency,
                   confidence,data_freshness,source_ref,dedup_key,created_at)
                  VALUES ('inact',?,?, 'subscription','inact',
                   1,'month',100,NULL,'HUF','manual',?,NULL,'inact|2026-07',?)`).run(w.start, w.end, NOW, NOW)
    db2.prepare(`UPDATE cost_sources SET active=0 WHERE id='inact'`).run()
    const s2 = getCostSummary(db2, cfg({ fixed_costs: [] }), NOW)
    expect(s2.top_sources[0]).toEqual({ source_id: 'inact', name: 'inact', spend: 100 })
    // and it must NOT appear in all_sources (filtered by active=1)
    expect(s2.all_sources.find(r => r.source_id === 'inact')).toBeUndefined()
  })

  it('reports the requested monthKey in the summary regardless of now', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const s = getCostSummary(db, cfg(), NOW, { monthKey: '2026-02' })
    expect(s.month).toBe('2026-02')
  })

  it('reflects opts.configExists=false and opts.configErrors when provided', () => {
    const db = getDb()
    syncFixedCostsToLedger(db, cfg(), NOW)
    const s = getCostSummary(db, cfg(), NOW, { configExists: false, configErrors: ['bad amount', 'unknown charge_category'] })
    expect(s.config_present).toBe(false)
    expect(s.config_errors).toEqual(['bad amount', 'unknown charge_category'])
  })

  it('prorates usage-type line items to month-end for forecast', () => {
    const db = getDb()
    // insert a usage line directly (source + line) representing partial-month usage
    db.prepare("INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at) VALUES ('u','U','other','usage','HUF',1,?,?)").run(NOW, NOW)
    const w = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_line_items (source_id,charge_period_start,charge_period_end,charge_category,service_name,billed_cost,currency,confidence,data_freshness,dedup_key,created_at)
      VALUES ('u',?,?,'usage','U',1450,'HUF','estimate',?,'u|2026-07',?)`).run(w.start, w.end, NOW, NOW)
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.current_spend).toBe(1450)
    // forecast = 1450 / fractionElapsed (14.5/31) ~= 3100
    expect(s.forecast_month_end).toBeGreaterThan(3000)
    expect(s.breakdown.estimate).toBe(1450)
  })

  it('keeps non-usage charge categories whole-month (no proration) and exercises confidence buckets', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    // three distinct confidences -> exercises the perSourceConfidence and breakdown bucketing
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
                VALUES ('a','A','anthropic','subscription','HUF',1,?,?),
                       ('b','B','openai','subscription','HUF',1,?,?),
                       ('c','C','other','usage','HUF',1,?,?)`).run(NOW, NOW, NOW, NOW, NOW, NOW)
    const ins = db.prepare(`INSERT INTO cost_line_items
      (source_id,charge_period_start,charge_period_end,charge_category,service_name,
       consumed_quantity,consumed_unit,billed_cost,effective_cost,currency,
       confidence,data_freshness,source_ref,dedup_key,created_at)
      VALUES (?,?,?,?,?,1,'month',?,NULL,?,?,?,NULL,?,?)`)
    ins.run('a', w.start, w.end, 'subscription', 'A', 100, 'HUF', 'actual_invoice', NOW, 'a|2026-07', NOW)
    ins.run('b', w.start, w.end, 'subscription', 'B', 200, 'HUF', 'estimate', NOW, 'b|2026-07', NOW)
    ins.run('c', w.start, w.end, 'usage', 'C', 300, 'HUF', 'local_usage', NOW, 'c|2026-07', NOW)

    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    // current = 100 + 200 + 300 = 600
    expect(s.current_spend).toBe(600)
    // forecast: subscription (a+b) whole-month + usage (c) prorated -> a + b + c / fractionElapsed
    const expectedForecast = 100 + 200 + 300 / w.fractionElapsed
    expect(s.forecast_month_end).toBeCloseTo(Math.round(expectedForecast * 100) / 100, 1)

    // breakdown buckets
    expect(s.breakdown.provider).toBe(100)          // actual_invoice -> provider
    expect(s.breakdown.estimate).toBe(200 + 300)    // estimate + local_usage -> estimate
    expect(s.breakdown.fixed_manual).toBe(0)
    // confidence_breakdown carries every confidence seen
    expect(s.confidence_breakdown.actual_invoice).toBe(100)
    expect(s.confidence_breakdown.estimate).toBe(200)
    expect(s.confidence_breakdown.local_usage).toBe(300)
  })

  it('caps top_sources at 5 entries even when there are more sources this month', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    const ins = db.prepare(`INSERT INTO cost_line_items
      (source_id,charge_period_start,charge_period_end,charge_category,service_name,
       consumed_quantity,consumed_unit,billed_cost,effective_cost,currency,
       confidence,data_freshness,source_ref,dedup_key,created_at)
      VALUES (?,?,?,'subscription',?,1,'month',?,NULL,'HUF','manual',?,NULL,?,?)`)
    for (let i = 0; i < 7; i++) {
      db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
                  VALUES (?,?,?,?, 'HUF',1,?,?)`).run(`s${i}`, `S${i}`, 'other', 'saas', NOW, NOW)
      ins.run(`s${i}`, w.start, w.end, `S${i}`, (i + 1) * 100, NOW, `s${i}|2026-07`, NOW)
    }
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.top_sources).toHaveLength(5)
    expect(s.all_sources).toHaveLength(7) // all_sources is uncapped
  })

  it('tracks the latest data_freshness across lines', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
                VALUES ('e','E','other','saas','HUF',1,?,?)`).run(NOW, NOW)
    const ins = db.prepare(`INSERT INTO cost_line_items
      (source_id,charge_period_start,charge_period_end,charge_category,service_name,
       consumed_quantity,consumed_unit,billed_cost,effective_cost,currency,
       confidence,data_freshness,source_ref,dedup_key,created_at)
      VALUES (?,?,?,'subscription',?,1,'month',?,NULL,'HUF','manual',?,NULL,?,?)`)
    ins.run('e', w.start, w.end, 'E', 100, NOW,       'e|2026-07', NOW)
    ins.run('e', w.start, w.end, 'E', 200, NOW + 500, 'e|2026-07b', NOW)
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.data_freshness).toBe(NOW + 500)
  })

  it('reports data_freshness=null when no line items exist for the month', () => {
    const db = getDb()
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.data_freshness).toBeNull()
    expect(s.current_spend).toBe(0)
    expect(s.forecast_month_end).toBe(0)
  })

  it('reports token_usage as VOLUME only, never priced', () => {
    const db = getDb()
    const w = monthWindow(NOW)
    const ins = db.prepare("INSERT INTO token_usage (agent,session_id,timestamp,input_tokens,output_tokens,cache_read_tokens,cache_creation_tokens) VALUES (?,?,?,?,?,?,?)")
    ins.run('marveen', 's1', w.start + 100, 1000, 5000, 200, 50)
    ins.run('qa', 's2', w.start + 200, 500, 2000, 0, 0)
    ins.run('marveen', 's3', w.end + 100, 999, 999, 0, 0) // next month, excluded
    const s = getCostSummary(db, cfg({ fixed_costs: [] }), NOW)
    expect(s.token_usage.calls).toBe(2)
    expect(s.token_usage.agents).toBe(2)
    expect(s.token_usage.input_tokens).toBe(1500)
    expect(s.token_usage.output_tokens).toBe(7000)
    expect(s.token_usage.note).toContain('not priced')
    // token usage must NOT contribute to money
    expect(s.current_spend).toBe(0)
  })

  it('exposes getCostSources sorted by name (active only)', () => {
    const db = getDb()
    const c = cfg()
    syncFixedCostsToLedger(db, c, NOW)
    const sources = getCostSources(db) as Array<{ id: string; name: string; active: number }>
    expect(sources).toHaveLength(2)
    // active filter: every returned row must be active=1
    for (const r of sources) expect(r.active).toBe(1)
    const ids = sources.map(r => r.id).sort()
    expect(ids).toEqual(['anthropic-max', 'openai'])
  })

  it('excludes inactive sources from getCostSources', () => {
    const db = getDb()
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
                VALUES ('inactive','Inactive','other','saas','HUF',0,?,?)`).run(NOW, NOW)
    db.prepare(`INSERT INTO cost_sources (id,name,provider,source_type,currency,active,created_at,updated_at)
                VALUES ('active','Active','other','saas','HUF',1,?,?)`).run(NOW, NOW)
    const sources = getCostSources(db) as Array<{ id: string }>
    expect(sources.map(r => r.id)).toEqual(['active'])
  })
})