import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, readFileSync, rmSync, mkdtempSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// ENFORCED sandbox -- the previous version of this file would have hit
// <repoRoot>/store/costops-config.json directly. COSTOPS_CONFIG_PATH and
// COSTOPS_EXAMPLE_PATH are computed from PROJECT_ROOT at module load time
// (config.ts:12, costops/config.ts:16-17), so the only safe path is to
// redirect PROJECT_ROOT to a tmpdir-scoped sandbox BEFORE the module loads.
const SANDBOX = mkdtempSync(join(tmpdir(), 'costops-config-'))
const STORE = join(SANDBOX, 'store')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})

const {
  COSTOPS_CONFIG_PATH,
  COSTOPS_EXAMPLE_PATH,
  loadCostopsConfig,
  ensureExampleConfig,
  validateConfig,
} = await import('../costops/config.js')

describe('costops/config.ts constants', () => {
  it('computes COSTOPS_CONFIG_PATH and COSTOPS_EXAMPLE_PATH inside the sandbox', () => {
    expect(COSTOPS_CONFIG_PATH).toBe(join(STORE, 'costops-config.json'))
    expect(COSTOPS_EXAMPLE_PATH).toBe(join(STORE, 'costops-config.json.example'))
  })
})

describe('loadCostopsConfig', () => {
  beforeEach(() => {
    mkdirSync(STORE, { recursive: true })
    rmSync(COSTOPS_CONFIG_PATH, { force: true })
    rmSync(COSTOPS_EXAMPLE_PATH, { force: true })
  })

  it('returns an empty config with exists=false when the config file is missing', () => {
    const r = loadCostopsConfig()
    expect(r.exists).toBe(false)
    expect(r.errors).toEqual([])
    expect(r.config).toEqual({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
    // ensureExampleConfig() ran -- the placeholder skeleton should now exist on disk
    expect(existsSync(COSTOPS_EXAMPLE_PATH)).toBe(true)
  })

  it('reads and validates the config when the file exists', () => {
    writeFileSync(COSTOPS_CONFIG_PATH, JSON.stringify({
      version: 1,
      currency: 'EUR',
      fixed_costs: [{ source_id: 'a', amount: 100 }],
      budgets: [{ id: 'b', amount: 200 }],
    }))
    const r = loadCostopsConfig()
    expect(r.exists).toBe(true)
    expect(r.errors).toEqual([])
    expect(r.config.currency).toBe('EUR')
    expect(r.config.fixed_costs).toHaveLength(1)
    expect(r.config.fixed_costs[0].source_id).toBe('a')
    expect(r.config.budgets).toHaveLength(1)
  })

  it('returns an empty config with a JSON-parse error when the file is malformed', () => {
    writeFileSync(COSTOPS_CONFIG_PATH, '{not valid json')
    const r = loadCostopsConfig()
    expect(r.exists).toBe(true)
    expect(r.errors).toEqual(['config is not valid JSON'])
    expect(r.config).toEqual({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
  })
})

describe('ensureExampleConfig', () => {
  beforeEach(() => {
    mkdirSync(STORE, { recursive: true })
    rmSync(COSTOPS_EXAMPLE_PATH, { force: true })
  })

  it('writes the safe placeholder skeleton when the example file is missing', () => {
    ensureExampleConfig()
    expect(existsSync(COSTOPS_EXAMPLE_PATH)).toBe(true)
    const content = JSON.parse(readFileSync(COSTOPS_EXAMPLE_PATH, 'utf-8'))
    expect(content.version).toBe(1)
    expect(content.currency).toBe('HUF')
    expect(content.fixed_costs.length).toBeGreaterThan(0)
    expect(content.budgets.length).toBeGreaterThan(0)
    // every entry amount is 0 (placeholder, no real numbers)
    for (const e of content.fixed_costs) expect(e.amount).toBe(0)
    for (const b of content.budgets) expect(b.amount).toBe(0)
  })

  it('does not overwrite an existing example file', () => {
    writeFileSync(COSTOPS_EXAMPLE_PATH, '{"preset":true}')
    ensureExampleConfig()
    expect(readFileSync(COSTOPS_EXAMPLE_PATH, 'utf-8')).toBe('{"preset":true}')
  })

  it('swallows write errors and does not throw when the example path is unwritable', () => {
    // Make the parent directory read-only so writeFileSync fails with EACCES
    // (existsSync on the child path still returns false because no file has been
    // created yet, so the write branch runs and the catch is hit). This proves
    // ensureExampleConfig never bubbles a write error to its caller.
    chmodSync(STORE, 0o555)
    try {
      expect(() => ensureExampleConfig()).not.toThrow()
    } finally {
      chmodSync(STORE, 0o755) // restore so afterAll rmSync works
    }
  })
})

describe('validateConfig', () => {
  it('returns defaults for null input', () => {
    const r = validateConfig(null)
    expect(r.errors).toEqual([])
    expect(r.config).toEqual({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
  })

  it('returns defaults for a non-object primitive input (string)', () => {
    const r = validateConfig('not-an-object')
    expect(r.errors).toEqual([])
    expect(r.config).toEqual({ version: 1, currency: 'HUF', fixed_costs: [], budgets: [] })
  })

  it('keeps a valid config and respects explicit version + currency', () => {
    const r = validateConfig({
      version: 2,
      currency: 'USD',
      fixed_costs: [{ source_id: 'a', amount: 100 }],
      budgets: [{ id: 'b', amount: 200 }],
    })
    expect(r.errors).toEqual([])
    expect(r.config.version).toBe(2)
    expect(r.config.currency).toBe('USD')
  })

  it('falls back to version=1 when the version field is missing or non-numeric', () => {
    expect(validateConfig({}).config.version).toBe(1)
    expect(validateConfig({ version: 'v2' }).config.version).toBe(1)
    expect(validateConfig({ version: null }).config.version).toBe(1)
  })

  it('falls back to currency=HUF when the currency field is missing or non-string', () => {
    expect(validateConfig({}).config.currency).toBe('HUF')
    expect(validateConfig({ currency: 42 }).config.currency).toBe('HUF')
    expect(validateConfig({ currency: null }).config.currency).toBe('HUF')
  })

  it('treats a non-array fixed_costs field as an empty array', () => {
    const r = validateConfig({ fixed_costs: 'not an array' })
    expect(r.config.fixed_costs).toEqual([])
  })

  it('treats a non-array budgets field as an empty array', () => {
    const r = validateConfig({ budgets: 42 })
    expect(r.config.budgets).toEqual([])
  })

  it('drops a fixed_costs entry missing source_id (null entry)', () => {
    const r = validateConfig({ fixed_costs: [null] })
    expect(r.config.fixed_costs).toEqual([])
    expect(r.errors).toContain('fixed_costs[0]: missing source_id')
  })

  it('drops a fixed_costs entry missing source_id (empty object)', () => {
    const r = validateConfig({ fixed_costs: [{}] })
    expect(r.config.fixed_costs).toEqual([])
    expect(r.errors).toContain('fixed_costs[0]: missing source_id')
  })

  it('drops a fixed_costs entry with a non-string source_id', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 42, amount: 100 }] })
    expect(r.config.fixed_costs).toEqual([])
    expect(r.errors).toContain('fixed_costs[0]: missing source_id')
  })

  it('drops a fixed_costs entry with an empty source_id', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: '', amount: 100 }] })
    expect(r.config.fixed_costs).toEqual([])
    expect(r.errors).toContain('fixed_costs[0]: missing source_id')
  })

  it('drops a fixed_costs entry missing the amount field', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'a' }] })
    expect(r.config.fixed_costs).toEqual([])
    expect(r.errors[0]).toContain('amount')
    expect(r.errors[0]).toContain('a')
  })

  it('drops a fixed_costs entry with a non-number amount', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'a', amount: '100' }] })
    expect(r.config.fixed_costs).toEqual([])
  })

  it('drops a fixed_costs entry with an Infinity amount', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'a', amount: Infinity }] })
    expect(r.config.fixed_costs).toEqual([])
  })

  it('drops a fixed_costs entry with a NaN amount', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'a', amount: NaN }] })
    expect(r.config.fixed_costs).toEqual([])
  })

  it('drops a fixed_costs entry with a negative amount', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'a', amount: -1 }] })
    expect(r.config.fixed_costs).toEqual([])
  })

  it('drops a fixed_costs entry whose period is anything other than "monthly"', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'a', amount: 1, period: 'yearly' }] })
    expect(r.config.fixed_costs).toEqual([])
    expect(r.errors[0]).toContain('monthly')
  })

  it('keeps a fixed_costs entry with an explicit monthly period', () => {
    const r = validateConfig({ fixed_costs: [{ source_id: 'a', amount: 1, period: 'monthly' }] })
    expect(r.config.fixed_costs).toHaveLength(1)
  })

  it('applies every default to a minimal valid fixed_costs entry (currency falls back to outer)', () => {
    const r = validateConfig({ currency: 'EUR', fixed_costs: [{ source_id: 'a', amount: 1 }] })
    expect(r.config.fixed_costs).toHaveLength(1)
    expect(r.config.fixed_costs[0]).toEqual({
      source_id: 'a',
      name: 'a',              // defaults to source_id
      provider: 'other',
      source_type: 'manual',
      amount: 1,
      period: 'monthly',      // always coerced to monthly in v0.1
      charge_category: 'subscription',
      confidence: 'manual',
      currency: 'EUR',        // falls back to outer config currency
      notes: undefined,
    })
  })

  it('preserves every optional field on a fully-specified fixed_costs entry', () => {
    const r = validateConfig({
      fixed_costs: [{
        source_id: 'anthropic-max',
        amount: 22000,
        name: 'Claude Max',
        provider: 'anthropic',
        source_type: 'subscription',
        charge_category: 'subscription',
        confidence: 'actual_invoice',
        currency: 'USD',
        notes: 'inv-2026-08',
      }],
    })
    expect(r.config.fixed_costs[0]).toEqual({
      source_id: 'anthropic-max',
      name: 'Claude Max',
      provider: 'anthropic',
      source_type: 'subscription',
      amount: 22000,
      period: 'monthly',
      charge_category: 'subscription',
      confidence: 'actual_invoice',
      currency: 'USD',
      notes: 'inv-2026-08',
    })
  })

  it('drops a budgets entry missing id', () => {
    const r = validateConfig({ budgets: [{}] })
    expect(r.config.budgets).toEqual([])
    expect(r.errors).toContain('budgets[0]: missing id')
  })

  it('drops a budgets entry with a non-string id', () => {
    const r = validateConfig({ budgets: [{ id: 42, amount: 1 }] })
    expect(r.config.budgets).toEqual([])
  })

  it('drops a budgets entry with an empty id', () => {
    const r = validateConfig({ budgets: [{ id: '', amount: 1 }] })
    expect(r.config.budgets).toEqual([])
  })

  it('drops a budgets entry missing the amount field', () => {
    const r = validateConfig({ budgets: [{ id: 'b' }] })
    expect(r.config.budgets).toEqual([])
    expect(r.errors[0]).toContain('amount')
  })

  it('drops a budgets entry with a non-number amount', () => {
    const r = validateConfig({ budgets: [{ id: 'b', amount: '100' }] })
    expect(r.config.budgets).toEqual([])
  })

  it('drops a budgets entry with an Infinity amount', () => {
    const r = validateConfig({ budgets: [{ id: 'b', amount: Infinity }] })
    expect(r.config.budgets).toEqual([])
  })

  it('drops a budgets entry with a negative amount', () => {
    const r = validateConfig({ budgets: [{ id: 'b', amount: -1 }] })
    expect(r.config.budgets).toEqual([])
  })

  it('applies every default to a minimal valid budget (currency falls back to outer)', () => {
    const r = validateConfig({ currency: 'EUR', budgets: [{ id: 'b', amount: 1 }] })
    expect(r.config.budgets).toHaveLength(1)
    expect(r.config.budgets[0]).toEqual({
      id: 'b',
      name: 'b',              // defaults to id
      scope: 'global',
      scope_ref: undefined,
      amount: 1,
      currency: 'EUR',        // falls back to outer config currency
      warning_threshold: 0.8,
      hard_threshold: 1.0,
    })
  })

  it('preserves every optional field on a fully-specified budget entry', () => {
    const r = validateConfig({
      budgets: [{
        id: 'provider-anthropic',
        amount: 50000,
        name: 'Anthropic monthly',
        scope: 'provider',
        scope_ref: 'anthropic',
        currency: 'USD',
        warning_threshold: 0.5,
        hard_threshold: 0.95,
      }],
    })
    expect(r.config.budgets[0]).toEqual({
      id: 'provider-anthropic',
      name: 'Anthropic monthly',
      scope: 'provider',
      scope_ref: 'anthropic',
      amount: 50000,
      currency: 'USD',
      warning_threshold: 0.5,
      hard_threshold: 0.95,
    })
  })

  it('reports multiple errors when multiple entries are invalid, and keeps the valid ones', () => {
    const r = validateConfig({
      fixed_costs: [
        { source_id: 'ok', amount: 100 },
        { amount: 5 },                          // missing source_id
        { source_id: 'neg', amount: -1 },       // negative amount
        { source_id: 'np', amount: 1, period: 'weekly' }, // unsupported period
      ],
      budgets: [
        { id: 'ok', amount: 1 },
        { amount: 1 },                          // missing id
        { id: 'neg', amount: -1 },              // negative amount
      ],
    })
    expect(r.config.fixed_costs).toHaveLength(1)
    expect(r.config.fixed_costs[0].source_id).toBe('ok')
    expect(r.config.budgets).toHaveLength(1)
    expect(r.config.budgets[0].id).toBe('ok')
    // 3 fixed_costs errors + 2 budgets errors
    expect(r.errors).toHaveLength(5)
  })
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})