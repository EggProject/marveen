// 100% coverage for src/web/claude-plans.ts.
//
// Branch inventory that must be covered here:
//
//   resolveClaudePlans(rawJson, homeDir)
//     - JSON.parse throws (malformed JSON)                        -> catch -> []
//     - parsed is not an array (object / primitive / null)         -> []
//     - empty array                                                -> []
//     - validatePlan drops an entry that's not an object          -> entry skipped
//     - validatePlan drops an entry with missing/empty id         -> entry skipped
//     - validatePlan drops an entry with bad-charset id           -> entry skipped
//     - validatePlan drops an entry with missing label            -> entry skipped
//     - validatePlan drops an entry with missing configDir        -> entry skipped
//     - validatePlan drops an entry with unsafe configDir         -> entry skipped
//       (delegated to expandAndValidateConfigDir -- we mock the
//       helper so both the accept and reject cases are reachable
//       inside claude-plans.ts regardless of the helper's own truth
//       table, since the helper is exercised in its own suite.)
//     - validatePlan drops an entry with invalid planType         -> entry skipped
//     - validatePlan drops an entry with non-boolean channelsAllowed -> entry skipped
//     - valid entry is kept, label is trimmed
//     - duplicate id -> first occurrence wins
//     - optional expectedOrgType / expectedEmail kept when present
//     - optional fields omitted when blank/non-string
//
//   readClaudePlans()
//     - file missing (statSync throws)                  -> []
//     - file exists but readFileSync throws             -> []
//     - file exists, valid JSON                         -> resolves to plan array
//     - cached: same mtime, second call returns cache (without re-reading)
//     - invalidated: bumped mtime, second call re-reads
//     - cached sentinel -1 for missing file
//
//   getClaudePlan(id)
//     - id is null                                       -> null
//     - id is undefined                                  -> null
//     - id is empty string                               -> null
//     - id is whitespace-only string                     -> null
//     - id is known                                      -> plan
//     - id is unknown                                    -> null
//
//   resolveAgentConfigDir(name)
//     - no planId -> falls back to readAgentClaudeConfigDir(name)
//     - planId set, plan resolves -> plan.configDir, planUnresolved=false
//     - planId set, plan missing  -> readAgentClaudeConfigDir(name), planUnresolved=true
//
//   CLAUDE_PLANS_PATH constant
//     - equals join(PROJECT_ROOT, 'store', 'claude-plans.json')

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  existsSync as realExistsSync,
  mkdirSync as realMkdirSync,
  readFileSync as realReadFileSync,
  rmSync as realRmSync,
  statSync as realStatSync,
  utimesSync as realUtimesSync,
  writeFileSync as realWriteFileSync,
} from 'node:fs'
import { join, dirname } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Sandbox: store/claude-plans.json lives under our tmpdir sandbox. PROJECT_ROOT
// is mocked to be the parent of the store dir so the SUT's join() lands inside
// it (CLAUDE_PLANS_PATH = join(PROJECT_ROOT, 'store', 'claude-plans.json')).
// ---------------------------------------------------------------------------
const STORE = mkTempStore('web-claude-plans-')
const PROJECT_ROOT_FOR_TEST = dirname(STORE)
const PLANS_PATH = join(STORE, 'claude-plans.json')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: PROJECT_ROOT_FOR_TEST, STORE_DIR: STORE }
})

// Mock ./agent-config.js -- the SUT calls three helpers from this module:
//   expandAndValidateConfigDir(raw, home)            -> path-or-null
//   readAgentClaudeConfigDir(name)                   -> path-or-null
//   readAgentClaudePlan(name)                        -> id-or-null
//
// We use simple hoisted vi.fn() so each test can stage its own return values
// without re-importing the SUT.
const mockExpandAndValidate = vi.fn<(raw: string, home: string) => string | null>()
const mockReadAgentClaudeConfigDir = vi.fn<(name: string) => string | null>()
const mockReadAgentClaudePlan = vi.fn<(name: string) => string | null>()

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    expandAndValidateConfigDir: mockExpandAndValidate,
    readAgentClaudeConfigDir: mockReadAgentClaudeConfigDir,
    readAgentClaudePlan: mockReadAgentClaudePlan,
  }
})

// Default mock implementations: the validator returns the input verbatim so
// reachability into the validatePlan branches is predictable, and the per-
// agent helpers return null unless a specific test re-stages them. Each test
// can use mockImplementationOnce(...) to drive a single branch.
mockExpandAndValidate.mockImplementation((raw: string) => raw)
mockReadAgentClaudeConfigDir.mockReturnValue(null)
mockReadAgentClaudePlan.mockReturnValue(null)

const sut = await import('../web/claude-plans.js')

// ---------------------------------------------------------------------------
// Reload the SUT with vi.resetModules() so the module-scope `plansCache` is
// dropped to a fresh `null`. Used by the readClaudePlans cache test which
// needs to start with an empty cache state and by tests that mutate the file
// across runs.
// ---------------------------------------------------------------------------
async function loadFreshSUT(): Promise<typeof import('../web/claude-plans.js')> {
  vi.resetModules()
  return await import('../web/claude-plans.js')
}

function planJson(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: 'pro',
    label: 'Personal PRO',
    configDir: '/home/op/.claude-pro',
    planType: 'personal',
    channelsAllowed: true,
    ...over,
  }
}

beforeEach(() => {
  rmTempDir(STORE)
  realMkdirSync(STORE, { recursive: true })
  mockExpandAndValidate.mockReset()
  mockReadAgentClaudeConfigDir.mockReset()
  mockReadAgentClaudePlan.mockReset()
  // Reset defaults after the reset.
  mockExpandAndValidate.mockImplementation((raw: string) => raw)
  mockReadAgentClaudeConfigDir.mockReturnValue(null)
  mockReadAgentClaudePlan.mockReturnValue(null)
})

afterEach(() => {
  rmTempDir(STORE)
})

// ===========================================================================
// Module-scope constant
// ===========================================================================

describe('CLAUDE_PLANS_PATH', () => {
  it('equals join(PROJECT_ROOT, store, claude-plans.json)', () => {
    expect(sut.CLAUDE_PLANS_PATH).toBe(join(PROJECT_ROOT_FOR_TEST, 'store', 'claude-plans.json'))
    expect(sut.CLAUDE_PLANS_PATH).toBe(PLANS_PATH)
  })
})

// ===========================================================================
// resolveClaudePlans -- pure JSON + validation pass
// ===========================================================================

describe('resolveClaudePlans -- JSON envelope', () => {
  it('returns [] for malformed JSON (JSON.parse throws)', () => {
    expect(sut.resolveClaudePlans('not json at all', '/home/op')).toEqual([])
  })

  it('returns [] for an empty string', () => {
    expect(sut.resolveClaudePlans('', '/home/op')).toEqual([])
  })

  it('returns [] when the parsed JSON is not an array (object)', () => {
    expect(sut.resolveClaudePlans('{}', '/home/op')).toEqual([])
  })

  it('returns [] when the parsed JSON is null', () => {
    expect(sut.resolveClaudePlans('null', '/home/op')).toEqual([])
  })

  it('returns [] for an empty array', () => {
    expect(sut.resolveClaudePlans('[]', '/home/op')).toEqual([])
  })
})

describe('resolveClaudePlans -- validatePlan branches', () => {
  it('drops entries that are not objects', () => {
    const raw = JSON.stringify(['a-string', 42, true, null, planJson()])
    const plans = sut.resolveClaudePlans(raw, '/home/op')
    expect(plans).toHaveLength(1)
    expect(plans[0]!.id).toBe('pro')
  })

  it('drops entries with missing id', () => {
    const raw = JSON.stringify([planJson({ id: undefined }), planJson()])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with empty or whitespace-only id', () => {
    const raw = JSON.stringify([
      planJson({ id: '' }),
      planJson({ id: '   ' }),
      planJson(),
    ])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with bad-charset id (space, slash, quote)', () => {
    const raw = JSON.stringify([
      planJson({ id: 'a b' }),
      planJson({ id: 'a/b' }),
      planJson({ id: 'a"b' }),
      planJson({ id: "a'b" }),
      planJson({ id: 'a;b' }),
      planJson(),
    ])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with missing label', () => {
    const raw = JSON.stringify([planJson({ label: undefined }), planJson()])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with empty/whitespace label', () => {
    const raw = JSON.stringify([
      planJson({ id: 'a', label: '' }),
      planJson({ id: 'b', label: '   ' }),
      planJson(),
    ])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with missing configDir', () => {
    const raw = JSON.stringify([planJson({ configDir: undefined }), planJson()])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with empty/whitespace configDir', () => {
    const raw = JSON.stringify([
      planJson({ id: 'a', configDir: '' }),
      planJson({ id: 'b', configDir: '   ' }),
      planJson(),
    ])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries the configDir validator rejects (returns null)', () => {
    // Stage: every configDir returns null except the final entry.
    mockExpandAndValidate.mockImplementation((raw: string) =>
      raw === '/home/op/.claude-pro' ? raw : null,
    )
    const raw = JSON.stringify([
      planJson({ id: 'unsafe-a', configDir: '/bad/path' }),
      planJson({ id: 'unsafe-b', configDir: '/also/bad' }),
      planJson(),
    ])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with invalid planType', () => {
    const raw = JSON.stringify([
      planJson({ id: 'a', planType: 'enterprise' }),
      planJson({ id: 'b', planType: '' }),
      planJson({ id: 'c', planType: null }),
      planJson({ id: 'd', planType: 42 }),
      planJson(),
    ])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('drops entries with non-boolean channelsAllowed', () => {
    const raw = JSON.stringify([
      planJson({ id: 'a', channelsAllowed: 'yes' }),
      planJson({ id: 'b', channelsAllowed: null }),
      planJson({ id: 'c', channelsAllowed: 1 }),
      planJson({ id: 'd', channelsAllowed: 0 }),
      planJson(),
    ])
    expect(sut.resolveClaudePlans(raw, '/home/op').map(p => p.id)).toEqual(['pro'])
  })

  it('trims label and id when constructing the plan', () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const raw = JSON.stringify([
      planJson({ id: '  pro-id  ', label: '  PRO label  ' }),
    ])
    const [p] = sut.resolveClaudePlans(raw, '/home/op')
    expect(p!.id).toBe('pro-id')
    expect(p!.label).toBe('PRO label')
  })

  it('accepts both valid planTypes (personal, team)', () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const raw = JSON.stringify([
      planJson({ id: 'personal-p', planType: 'personal' }),
      planJson({ id: 'team-t', planType: 'team' }),
    ])
    const plans = sut.resolveClaudePlans(raw, '/home/op')
    expect(plans.map(p => p.planType).sort()).toEqual(['personal', 'team'])
  })

  it('accepts both boolean states for channelsAllowed', () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const raw = JSON.stringify([
      planJson({ id: 'yes', channelsAllowed: true }),
      planJson({ id: 'no', channelsAllowed: false }),
    ])
    const plans = sut.resolveClaudePlans(raw, '/home/op')
    expect(plans.find(p => p.id === 'yes')!.channelsAllowed).toBe(true)
    expect(plans.find(p => p.id === 'no')!.channelsAllowed).toBe(false)
  })

  it('dedupes by id, first occurrence wins', () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const raw = JSON.stringify([
      planJson({ id: 'dup', label: 'First' }),
      planJson({ id: 'dup', label: 'Second' }),
    ])
    const plans = sut.resolveClaudePlans(raw, '/home/op')
    expect(plans).toHaveLength(1)
    expect(plans[0]!.label).toBe('First')
  })

  it('includes expectedOrgType / expectedEmail when present', () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const raw = JSON.stringify([planJson({
      id: 'team', planType: 'team', channelsAllowed: false,
      expectedOrgType: 'company', expectedEmail: 'x@corp.com',
    })])
    const [p] = sut.resolveClaudePlans(raw, '/home/op')
    expect(p!.expectedOrgType).toBe('company')
    expect(p!.expectedEmail).toBe('x@corp.com')
  })

  it('trims optional expectedOrgType / expectedEmail when present', () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const raw = JSON.stringify([planJson({
      expectedOrgType: '  company  ', expectedEmail: '  x@corp.com  ',
    })])
    const [p] = sut.resolveClaudePlans(raw, '/home/op')
    expect(p!.expectedOrgType).toBe('company')
    expect(p!.expectedEmail).toBe('x@corp.com')
  })

  it('omits expectedOrgType / expectedEmail when absent or non-string', () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const raw = JSON.stringify([
      planJson({ id: 'absent' }),
      planJson({ id: 'numeric', expectedOrgType: 42, expectedEmail: 99 }),
      planJson({ id: 'blank', expectedOrgType: '', expectedEmail: '   ' }),
    ])
    const plans = sut.resolveClaudePlans(raw, '/home/op')
    for (const p of plans) {
      expect(p.expectedOrgType).toBeUndefined()
      expect(p.expectedEmail).toBeUndefined()
    }
  })

  it('uses the configured configDir in the plan, not the raw value', () => {
    // Stage: the validator rewrites the path. The returned plan MUST carry
    // the rewritten value (this is how tilde expansion lands in the path
    // field even though the validator runs inside the per-entry loop).
    mockExpandAndValidate.mockImplementation((raw: string) => {
      if (raw === '~/.claude-pro') return '/home/op/.claude-pro'
      return raw
    })
    const raw = JSON.stringify([planJson({ configDir: '~/.claude-pro' })])
    const [p] = sut.resolveClaudePlans(raw, '/home/op')
    expect(p!.configDir).toBe('/home/op/.claude-pro')
  })
})

// ===========================================================================
// readClaudePlans -- disk read + mtime cache
// ===========================================================================

describe('readClaudePlans -- disk', () => {
  it('returns [] when the file is missing (statSync throws)', async () => {
    const { readClaudePlans } = await loadFreshSUT()
    expect(realExistsSync(PLANS_PATH)).toBe(false)
    expect(readClaudePlans()).toEqual([])
  })

  it('returns [] when readFileSync throws (path exists for statSync but cannot be read)', async () => {
    // statSync of a directory succeeds (returns the dir's mtime) but
    // readFileSync throws EISDIR, exercising the inner catch branch that
    // falls back to rawJson = '' -> resolveClaudePlans('') -> [].
    realMkdirSync(PLANS_PATH, { recursive: true })
    const { readClaudePlans } = await loadFreshSUT()
    expect(readClaudePlans()).toEqual([])
  })

  it('returns [] when the file contains malformed JSON', async () => {
    const { readClaudePlans } = await loadFreshSUT()
    realWriteFileSync(PLANS_PATH, 'not valid json')
    expect(readClaudePlans()).toEqual([])
  })

  it('reads the file and returns the resolved plans', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    realWriteFileSync(PLANS_PATH, JSON.stringify([
      planJson({ id: 'a' }),
      planJson({ id: 'b', label: 'B' }),
    ]))
    const { readClaudePlans } = await loadFreshSUT()
    const plans = readClaudePlans()
    expect(plans).toHaveLength(2)
    expect(plans.map(p => p.id).sort()).toEqual(['a', 'b'])
  })

  it('caches the plans by mtime (no second statSync / readFileSync)', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    // Pin the mtime FIRST so the cache key is stable across subsequent
    // touches (the agent-config.test.ts suite uses the same pattern).
    const fixedMtime = new Date(Date.now() - 60_000)
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'one' })]))
    realUtimesSync(PLANS_PATH, fixedMtime, fixedMtime)
    const { readClaudePlans } = await loadFreshSUT()
    const first = readClaudePlans()
    // Overwrite the file with new content but keep mtime pinned so the
    // second readClaudePlans() hits the cache (cache.mtimeMs === file
    // mtimeMs).
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'two' })]))
    realUtimesSync(PLANS_PATH, fixedMtime, fixedMtime)
    const second = readClaudePlans()
    // First read populated cache; second read returns the cached array even
    // though the file on disk now has different content (same mtime).
    expect(second).toBe(first)
    expect(second[0]!.id).toBe('one')
  })

  it('invalidates the cache when the mtime changes', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'one' })]))
    const someDate = new Date(Date.now() - 60_000)
    realUtimesSync(PLANS_PATH, someDate, someDate)
    const { readClaudePlans } = await loadFreshSUT()
    const first = readClaudePlans()
    expect(first[0]!.id).toBe('one')
    // Bump mtime AND content. readClaudePlans must re-read and re-resolve.
    const future = new Date(Date.now() + 60_000)
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'two' })]))
    realUtimesSync(PLANS_PATH, future, future)
    const second = readClaudePlans()
    expect(second).not.toBe(first)
    expect(second[0]!.id).toBe('two')
  })

  it('returns the cached [] for a continuously-missing file across reads', async () => {
    const { readClaudePlans } = await loadFreshSUT()
    expect(realExistsSync(PLANS_PATH)).toBe(false)
    const first = readClaudePlans()
    const second = readClaudePlans()
    expect(first).toEqual([])
    expect(second).toEqual([])
    expect(second).toBe(first)
  })

  it('transitions from cached missing-file to a present file (mtime -1 -> real)', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    const { readClaudePlans } = await loadFreshSUT()
    expect(realExistsSync(PLANS_PATH)).toBe(false)
    expect(readClaudePlans()).toEqual([])
    // Now write the file -- the mtime jumps from -1 sentinel to a real value.
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'fresh' })]))
    expect(readClaudePlans().map(p => p.id)).toEqual(['fresh'])
  })
})

// ===========================================================================
// getClaudePlan -- id lookup
// ===========================================================================

describe('getClaudePlan', () => {
  it('returns null for null', () => {
    expect(sut.getClaudePlan(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(sut.getClaudePlan(undefined)).toBeNull()
  })

  it('returns null for an empty string', () => {
    expect(sut.getClaudePlan('')).toBeNull()
  })

  it('returns null when the file is missing (no plans registered)', async () => {
    const { getClaudePlan } = await loadFreshSUT()
    expect(realExistsSync(PLANS_PATH)).toBe(false)
    expect(getClaudePlan('anything')).toBeNull()
  })

  it('returns null when the id is not in the registry', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'known' })]))
    const { getClaudePlan } = await loadFreshSUT()
    expect(getClaudePlan('unknown')).toBeNull()
  })

  it('returns the matching plan when the id exists', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    realWriteFileSync(PLANS_PATH, JSON.stringify([
      planJson({ id: 'alpha' }),
      planJson({ id: 'beta', label: 'Beta' }),
    ]))
    const { getClaudePlan } = await loadFreshSUT()
    const p = getClaudePlan('beta')
    expect(p).not.toBeNull()
    expect(p!.id).toBe('beta')
    expect(p!.label).toBe('Beta')
  })

  it('returns null when called with a whitespace-only id on a populated registry', async () => {
    // Coverage of the `if (!id)` guard: any falsy id (including whitespace-
    // only since `'' || '  '` ... wait, `if (!id)` requires falsy. Whitespace
    // is truthy, so this hits the readClaudePlans().find path. Document the
    // current behavior: whitespace-id returns null because no plan has that
    // id, not because of the falsy-guard.
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'known' })]))
    const { getClaudePlan } = await loadFreshSUT()
    expect(getClaudePlan('   ')).toBeNull()
  })
})

// ===========================================================================
// resolveAgentConfigDir -- single source of truth for an agent's config dir
// ===========================================================================

describe('resolveAgentConfigDir', () => {
  it('falls back to readAgentClaudeConfigDir when no claudePlan is set', () => {
    mockReadAgentClaudePlan.mockReturnValue(null)
    mockReadAgentClaudeConfigDir.mockReturnValue('/x/from/raw')
    const r = sut.resolveAgentConfigDir('alice')
    expect(r).toEqual({ configDir: '/x/from/raw', planUnresolved: false })
    expect(mockReadAgentClaudePlan).toHaveBeenCalledWith('alice')
    expect(mockReadAgentClaudeConfigDir).toHaveBeenCalledWith('alice')
  })

  it('returns the named plan configDir when the plan resolves', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'p1', configDir: '/from/plan' })]))
    const { resolveAgentConfigDir } = await loadFreshSUT()
    mockReadAgentClaudePlan.mockReturnValue('p1')
    mockReadAgentClaudeConfigDir.mockReturnValue('/should/not/be/used')
    const r = resolveAgentConfigDir('alice')
    expect(r).toEqual({ configDir: '/from/plan', planUnresolved: false })
    // The named plan path wins, so the raw-configDir helper must NOT be
    // consulted.
    expect(mockReadAgentClaudeConfigDir).not.toHaveBeenCalled()
  })

  it('falls back to readAgentClaudeConfigDir with planUnresolved=true when the plan id does not resolve', async () => {
    mockExpandAndValidate.mockImplementation((raw: string) => raw)
    realWriteFileSync(PLANS_PATH, JSON.stringify([planJson({ id: 'p1' })]))
    const { resolveAgentConfigDir } = await loadFreshSUT()
    mockReadAgentClaudePlan.mockReturnValue('ghost')
    mockReadAgentClaudeConfigDir.mockReturnValue('/from/raw-configDir')
    const r = resolveAgentConfigDir('alice')
    expect(r).toEqual({ configDir: '/from/raw-configDir', planUnresolved: true })
    expect(mockReadAgentClaudeConfigDir).toHaveBeenCalledWith('alice')
  })

  it('returns {configDir: null, planUnresolved: false} when neither plan nor raw configDir is set', async () => {
    const { resolveAgentConfigDir } = await loadFreshSUT()
    mockReadAgentClaudePlan.mockReturnValue(null)
    mockReadAgentClaudeConfigDir.mockReturnValue(null)
    const r = resolveAgentConfigDir('alice')
    expect(r).toEqual({ configDir: null, planUnresolved: false })
  })

  it('passes the agent name through to readAgentClaudePlan', () => {
    mockReadAgentClaudePlan.mockReturnValue(null)
    mockReadAgentClaudeConfigDir.mockReturnValue(null)
    sut.resolveAgentConfigDir('agent-with-dashes_and.dots')
    expect(mockReadAgentClaudePlan).toHaveBeenCalledWith('agent-with-dashes_and.dots')
    expect(mockReadAgentClaudeConfigDir).toHaveBeenCalledWith('agent-with-dashes_and.dots')
  })

  it('uses the cached plan registry: a missing-file lookup is consistent across calls', async () => {
    // Both resolveAgentConfigDir and getClaudePlan share the same module-
    // scope cache; a missing file yields the same [] for every call until
    // the file appears.
    const { resolveAgentConfigDir, getClaudePlan } = await loadFreshSUT()
    mockReadAgentClaudePlan.mockReturnValue('doesnt-matter')
    mockReadAgentClaudeConfigDir.mockReturnValue(null)
    expect(realExistsSync(PLANS_PATH)).toBe(false)
    expect(resolveAgentConfigDir('alice').planUnresolved).toBe(true)
    expect(getClaudePlan('doesnt-matter')).toBeNull()
  })
})
