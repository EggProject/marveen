// 100% coverage for src/web/agent-team.ts.
//
// Strategy: redirect PROJECT_ROOT to a single temp sandbox for the whole file
// (mirrors the pattern in agent-config.test.ts). Per-test cleanup wipes the
// sandbox so every test starts from an empty agents/ directory. MAIN_AGENT_ID
// is overridden so listAgentNames() / sanitizeTeamConfig() can be exercised
// against a stable value (`'mainagent'`) regardless of the host's actual env.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'agentteam-'))
const PROJECT = join(SANDBOX, 'project')
const HOME = join(SANDBOX, 'home')
const AGENTS_DIR = join(PROJECT, 'agents')

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  // `PROJECT` is a module-scope const declared below -- vi.mock factories are
  // hoisted above it. Use a getter so the value is picked up the first time
  // agent-config.ts reads PROJECT_ROOT.
  return Object.defineProperties(
    { ...actual, MAIN_AGENT_ID: 'mainagent' },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => join(PROJECT, 'store'), enumerable: true },
    },
  )
})

const at = await import('../web/agent-team.js')

function seedAgent(name: string, config: Record<string, unknown> = {}): string {
  const dir = join(AGENTS_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
  return dir
}

function resetSandbox(): void {
  rmSync(PROJECT, { recursive: true, force: true })
  mkdirSync(AGENTS_DIR, { recursive: true })
}

beforeEach(resetSandbox)
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// DEFAULT_TEAM
// ---------------------------------------------------------------------------

describe('DEFAULT_TEAM', () => {
  it('is a member with no manager, no delegates, no trustFrom', () => {
    expect(at.DEFAULT_TEAM).toEqual({
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
  })
})

// ---------------------------------------------------------------------------
// readAgentTeam
// ---------------------------------------------------------------------------

describe('readAgentTeam', () => {
  it('returns DEFAULT_TEAM when the agent has no config file', () => {
    expect(at.readAgentTeam('ghost')).toEqual({
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
  })

  it('returns DEFAULT_TEAM when config.team is missing', () => {
    seedAgent('notm', { model: 'sonnet' })
    expect(at.readAgentTeam('notm')).toEqual({
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
  })

  it('returns DEFAULT_TEAM when config.team is null', () => {
    seedAgent('nullteam', { team: null })
    expect(at.readAgentTeam('nullteam').role).toBe('member')
  })

  it('returns DEFAULT_TEAM when config.team is a non-object (string)', () => {
    seedAgent('strteam', { team: 'not-a-team' })
    expect(at.readAgentTeam('strteam')).toEqual({
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
  })

  it('returns DEFAULT_TEAM when the config JSON is unparseable', () => {
    const dir = seedAgent('badjson')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    expect(at.readAgentTeam('badjson').role).toBe('member')
  })

  it('keeps role: leader verbatim', () => {
    seedAgent('lead', { team: { role: 'leader', reportsTo: 'boss', delegatesTo: [], autoDelegation: true, trustFrom: [] } })
    expect(at.readAgentTeam('lead').role).toBe('leader')
  })

  it('coerces any non-"leader" role to "member"', () => {
    seedAgent('mem1', { team: { role: 'whatever' } })
    seedAgent('mem2', { team: { role: 42 } })
    seedAgent('mem3', { team: { role: null } })
    expect(at.readAgentTeam('mem1').role).toBe('member')
    expect(at.readAgentTeam('mem2').role).toBe('member')
    expect(at.readAgentTeam('mem3').role).toBe('member')
  })

  it('trims a non-empty string reportsTo', () => {
    seedAgent('rt1', { team: { reportsTo: '  boss  ' } })
    expect(at.readAgentTeam('rt1').reportsTo).toBe('boss')
  })

  it('returns null for empty / whitespace / non-string reportsTo', () => {
    seedAgent('rt2', { team: { reportsTo: '' } })
    seedAgent('rt3', { team: { reportsTo: '   ' } })
    seedAgent('rt4', { team: { reportsTo: 42 } })
    seedAgent('rt5', { team: { reportsTo: null } })
    expect(at.readAgentTeam('rt2').reportsTo).toBeNull()
    expect(at.readAgentTeam('rt3').reportsTo).toBeNull()
    expect(at.readAgentTeam('rt4').reportsTo).toBeNull()
    expect(at.readAgentTeam('rt5').reportsTo).toBeNull()
  })

  it('keeps string entries in delegatesTo and drops non-strings', () => {
    seedAgent('del1', { team: { delegatesTo: ['a', 42, null, 'b', 'a'] } })
    expect(at.readAgentTeam('del1').delegatesTo).toEqual(['a', 'b', 'a'])
  })

  it('returns [] when delegatesTo is not an array', () => {
    seedAgent('del2', { team: { delegatesTo: 'nope' } })
    expect(at.readAgentTeam('del2').delegatesTo).toEqual([])
  })

  it('keeps string entries in trustFrom and drops non-strings', () => {
    seedAgent('tf1', { team: { trustFrom: ['a', 7, 'b'] } })
    expect(at.readAgentTeam('tf1').trustFrom).toEqual(['a', 'b'])
  })

  it('returns [] when trustFrom is not an array', () => {
    seedAgent('tf2', { team: { trustFrom: {} } })
    expect(at.readAgentTeam('tf2').trustFrom).toEqual([])
  })

  it('coerces autoDelegation to a boolean', () => {
    seedAgent('ad1', { team: { autoDelegation: true } })
    seedAgent('ad2', { team: { autoDelegation: 'yes' } })
    seedAgent('ad3', { team: { autoDelegation: 0 } })
    expect(at.readAgentTeam('ad1').autoDelegation).toBe(true)
    expect(at.readAgentTeam('ad2').autoDelegation).toBe(true)
    expect(at.readAgentTeam('ad3').autoDelegation).toBe(false)
  })

  it('returns a full valid TeamConfig when the stored shape is correct', () => {
    seedAgent('full', {
      team: {
        role: 'leader',
        reportsTo: 'mainagent',
        delegatesTo: ['a', 'b'],
        autoDelegation: true,
        trustFrom: ['x'],
      },
    })
    expect(at.readAgentTeam('full')).toEqual({
      role: 'leader',
      reportsTo: 'mainagent',
      delegatesTo: ['a', 'b'],
      autoDelegation: true,
      trustFrom: ['x'],
    })
  })
})

// ---------------------------------------------------------------------------
// resolveSecurityProfileId
// ---------------------------------------------------------------------------

describe('resolveSecurityProfileId', () => {
  it('treats null / undefined / non-string storedProfile as empty', () => {
    expect(resolveWith(null, 'member')).toBe('default')
    expect(resolveWith(undefined, 'member')).toBe('default')
    expect(resolveWith(42, 'member')).toBe('default')
    expect(resolveWith(null, 'leader')).toBe('applier')
  })

  it('treats empty / whitespace storedProfile as empty', () => {
    expect(resolveWith('', 'member')).toBe('default')
    expect(resolveWith('   ', 'member')).toBe('default')
  })

  it('treats the literal "default" as the empty signal', () => {
    expect(resolveWith('default', 'member')).toBe('default')
    expect(resolveWith('default', 'leader')).toBe('applier')
  })

  it('returns the explicit non-default profile verbatim (trimmed)', () => {
    expect(resolveWith('sub-dev', 'member')).toBe('sub-dev')
    expect(resolveWith('  applier  ', 'leader')).toBe('applier')
    expect(resolveWith('sub-dev', 'leader')).toBe('sub-dev')
  })

  it('falls back to "applier" for a leader with no explicit profile', () => {
    expect(resolveWith(null, 'leader')).toBe('applier')
    expect(resolveWith('', 'leader')).toBe('applier')
  })

  it('falls back to "default" for a member with no explicit profile', () => {
    expect(resolveWith(null, 'member')).toBe('default')
    expect(resolveWith('', 'member')).toBe('default')
  })

  function resolveWith(stored: unknown, role: 'leader' | 'member') {
    return at.resolveSecurityProfileId(stored as string | null | undefined, { role })
  }
})

// ---------------------------------------------------------------------------
// resolveAgentSecurityProfile (read-and-resolve convenience wrapper)
// ---------------------------------------------------------------------------

describe('resolveAgentSecurityProfile', () => {
  it('reads the stored securityProfile and resolves via role', () => {
    seedAgent('r1', { securityProfile: 'sub-dev', team: { role: 'leader' } })
    expect(at.resolveAgentSecurityProfile('r1')).toBe('sub-dev')
  })

  it('returns "applier" for a leader with no explicit profile', () => {
    seedAgent('r2', { team: { role: 'leader' } })
    expect(at.resolveAgentSecurityProfile('r2')).toBe('applier')
  })

  it('returns "default" for a member with no explicit profile', () => {
    seedAgent('r3', { team: { role: 'member' } })
    expect(at.resolveAgentSecurityProfile('r3')).toBe('default')
  })

  it('falls back to defaults when the agent has no config file', () => {
    expect(at.resolveAgentSecurityProfile('ghost')).toBe('default')
  })
})

// ---------------------------------------------------------------------------
// writeAgentTeam
// ---------------------------------------------------------------------------

describe('writeAgentTeam', () => {
  it('creates the agent-config.json with the team block when none exists', () => {
    mkdirSync(join(AGENTS_DIR, 'w1'), { recursive: true })
    at.writeAgentTeam('w1', {
      role: 'leader',
      reportsTo: 'mainagent',
      delegatesTo: ['x'],
      autoDelegation: true,
      trustFrom: [],
    })
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'w1', 'agent-config.json'), 'utf-8'))
    expect(json.team).toEqual({
      role: 'leader',
      reportsTo: 'mainagent',
      delegatesTo: ['x'],
      autoDelegation: true,
      trustFrom: [],
    })
  })

  it('merges with the existing config (other keys survive)', () => {
    seedAgent('w2', { model: 'sonnet', displayName: 'X' })
    at.writeAgentTeam('w2', {
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'w2', 'agent-config.json'), 'utf-8'))
    expect(json.team.role).toBe('member')
    expect(json.model).toBe('sonnet')
    expect(json.displayName).toBe('X')
  })

  it('overwrites a previously stored team block', () => {
    seedAgent('w3', { team: { role: 'leader', reportsTo: 'old' } })
    at.writeAgentTeam('w3', {
      role: 'member',
      reportsTo: 'mainagent',
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'w3', 'agent-config.json'), 'utf-8'))
    expect(json.team.reportsTo).toBe('mainagent')
    expect(json.team.role).toBe('member')
  })

  it('starts fresh when the existing file is unparseable JSON', () => {
    const dir = seedAgent('w4')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    at.writeAgentTeam('w4', {
      role: 'leader',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: true,
      trustFrom: ['a'],
    })
    const json = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8'))
    expect(json.team.role).toBe('leader')
    expect(json.team.trustFrom).toEqual(['a'])
  })
})

// ---------------------------------------------------------------------------
// sanitizeTeamConfig
// ---------------------------------------------------------------------------

describe('sanitizeTeamConfig', () => {
  it('keeps a known reportsTo and known delegates/trustFrom', () => {
    seedAgent('keeper')
    seedAgent('worker')
    const out = at.sanitizeTeamConfig('keeper', {
      role: 'leader',
      reportsTo: 'worker',
      delegatesTo: ['worker'],
      autoDelegation: false,
      trustFrom: ['worker'],
    })
    expect(out.team.reportsTo).toBe('worker')
    expect(out.team.delegatesTo).toEqual(['worker'])
    expect(out.team.trustFrom).toEqual(['worker'])
    expect(out.warnings).toEqual({ droppedSelf: [], droppedUnknown: [] })
  })

  it('accepts MAIN_AGENT_ID as a known manager', () => {
    seedAgent('under')
    const out = at.sanitizeTeamConfig('under', {
      role: 'member',
      reportsTo: 'mainagent',
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.reportsTo).toBe('mainagent')
    expect(out.warnings.droppedUnknown).toEqual([])
  })

  it('drops a self-reference in reportsTo and warns', () => {
    seedAgent('selfish')
    const out = at.sanitizeTeamConfig('selfish', {
      role: 'member',
      reportsTo: 'selfish',
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.reportsTo).toBeNull()
    expect(out.warnings.droppedSelf).toEqual(['reportsTo'])
  })

  it('drops an unknown reportsTo and warns with the bad id', () => {
    seedAgent('org1')
    const out = at.sanitizeTeamConfig('org1', {
      role: 'member',
      reportsTo: 'ghost',
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.reportsTo).toBeNull()
    expect(out.warnings.droppedUnknown).toEqual(['ghost'])
  })

  it('drops a self-reference in delegatesTo', () => {
    seedAgent('self_deleg')
    const out = at.sanitizeTeamConfig('self_deleg', {
      role: 'member',
      reportsTo: null,
      delegatesTo: ['self_deleg', 'other'],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.delegatesTo).toEqual([])
    expect(out.warnings.droppedSelf).toEqual(['delegatesTo'])
  })

  it('drops unknown delegates and warns with each bad id', () => {
    seedAgent('org2')
    const out = at.sanitizeTeamConfig('org2', {
      role: 'member',
      reportsTo: null,
      delegatesTo: ['phantom-a', 'phantom-b'],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.delegatesTo).toEqual([])
    expect(out.warnings.droppedUnknown.sort()).toEqual(['phantom-a', 'phantom-b'])
  })

  it('dedupes delegatesTo that repeat the same id', () => {
    seedAgent('a')
    seedAgent('b')
    const out = at.sanitizeTeamConfig('a', {
      role: 'member',
      reportsTo: null,
      delegatesTo: ['b', 'b', 'b'],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.delegatesTo).toEqual(['b'])
  })

  it('drops a self-reference in trustFrom', () => {
    seedAgent('self_trust')
    const out = at.sanitizeTeamConfig('self_trust', {
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: ['self_trust'],
    })
    expect(out.team.trustFrom).toEqual([])
    expect(out.warnings.droppedSelf).toEqual(['trustFrom'])
  })

  it('drops unknown trustFrom ids and warns', () => {
    seedAgent('org3')
    const out = at.sanitizeTeamConfig('org3', {
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: ['mystery'],
    })
    expect(out.team.trustFrom).toEqual([])
    expect(out.warnings.droppedUnknown).toEqual(['mystery'])
  })

  it('passes an empty trustFrom through unchanged', () => {
    seedAgent('no_trust')
    const out = at.sanitizeTeamConfig('no_trust', {
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.trustFrom).toEqual([])
    expect(out.warnings).toEqual({ droppedSelf: [], droppedUnknown: [] })
  })

  it('does not duplicate droppedSelf warnings when multiple self ids appear', () => {
    seedAgent('dup_self')
    const out = at.sanitizeTeamConfig('dup_self', {
      role: 'member',
      reportsTo: null,
      delegatesTo: ['dup_self', 'dup_self'],
      autoDelegation: false,
      trustFrom: ['dup_self', 'dup_self'],
    })
    // droppedSelf is deduped (one entry per field name)
    expect(out.warnings.droppedSelf).toEqual(['delegatesTo', 'trustFrom'])
  })

  it('keeps a null reportsTo as null without warnings', () => {
    seedAgent('null_rep')
    const out = at.sanitizeTeamConfig('null_rep', {
      role: 'member',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.reportsTo).toBeNull()
    expect(out.warnings).toEqual({ droppedSelf: [], droppedUnknown: [] })
  })

  it('keeps an empty-string reportsTo without warnings', () => {
    seedAgent('empty_rep')
    const out = at.sanitizeTeamConfig('empty_rep', {
      role: 'member',
      reportsTo: '',
      delegatesTo: [],
      autoDelegation: false,
      trustFrom: [],
    })
    expect(out.team.reportsTo).toBe('')
    expect(out.warnings.droppedUnknown).toEqual([])
  })

  it('collects multiple droppedUnknown ids across fields', () => {
    seedAgent('multi')
    const out = at.sanitizeTeamConfig('multi', {
      role: 'member',
      reportsTo: 'gh1',
      delegatesTo: ['gh2'],
      autoDelegation: false,
      trustFrom: ['gh3'],
    })
    expect(out.team.reportsTo).toBeNull()
    expect(out.team.delegatesTo).toEqual([])
    expect(out.team.trustFrom).toEqual([])
    expect(out.warnings.droppedUnknown.sort()).toEqual(['gh1', 'gh2', 'gh3'])
  })

  it('accepts MAIN_AGENT_ID in delegatesTo and trustFrom', () => {
    seedAgent('main_user')
    const out = at.sanitizeTeamConfig('main_user', {
      role: 'member',
      reportsTo: null,
      delegatesTo: ['mainagent'],
      autoDelegation: false,
      trustFrom: ['mainagent'],
    })
    expect(out.team.delegatesTo).toEqual(['mainagent'])
    expect(out.team.trustFrom).toEqual(['mainagent'])
  })

  it('preserves role and autoDelegation verbatim', () => {
    seedAgent('preserve')
    const out = at.sanitizeTeamConfig('preserve', {
      role: 'leader',
      reportsTo: null,
      delegatesTo: [],
      autoDelegation: true,
      trustFrom: [],
    })
    expect(out.team.role).toBe('leader')
    expect(out.team.autoDelegation).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// reportsToCreatesCycle
// ---------------------------------------------------------------------------

describe('reportsToCreatesCycle', () => {
  function reader(chain: Record<string, string | null>) {
    return (name: string) => ({ reportsTo: name in chain ? chain[name] : null })
  }

  const MAIN = 'mainagent'

  it('returns false when proposedReportsTo is null or main', () => {
    expect(at.reportsToCreatesCycle('a', null, reader({}), MAIN)).toBe(false)
    expect(at.reportsToCreatesCycle('a', MAIN, reader({}), MAIN)).toBe(false)
  })

  it('returns true when proposedReportsTo is the agent itself', () => {
    expect(at.reportsToCreatesCycle('a', 'a', reader({}), MAIN)).toBe(true)
  })

  it('returns false for a straightforward manager assignment', () => {
    expect(at.reportsToCreatesCycle('a', 'b', reader({ b: MAIN }), MAIN)).toBe(false)
  })

  it('returns true on a two-node cycle', () => {
    expect(at.reportsToCreatesCycle('a', 'b', reader({ b: 'a' }), MAIN)).toBe(true)
  })

  it('returns true on a transitive cycle', () => {
    const read = reader({ c: 'b', b: 'a', a: MAIN })
    expect(at.reportsToCreatesCycle('a', 'c', read, MAIN)).toBe(true)
  })

  it('terminates on a pre-existing loop that does not involve the agent', () => {
    const read = reader({ x: 'y', y: 'x' })
    expect(at.reportsToCreatesCycle('a', 'x', read, MAIN)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// cleanupTeamReferences
// ---------------------------------------------------------------------------

describe('cleanupTeamReferences', () => {
  it('does nothing when no other agent references the removed name', () => {
    seedAgent('keeper', { team: { role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false } })
    at.cleanupTeamReferences('removed')
    const after = at.readAgentTeam('keeper')
    expect(after.reportsTo).toBeNull()
    expect(after.delegatesTo).toEqual([])
  })

  it('reassigns reportsTo to MAIN_AGENT_ID when the removed agent was a manager', () => {
    seedAgent('follower', { team: { role: 'member', reportsTo: 'former-manager', delegatesTo: [], autoDelegation: false } })
    at.cleanupTeamReferences('former-manager')
    expect(at.readAgentTeam('follower').reportsTo).toBe('mainagent')
  })

  it('removes the removed agent from delegatesTo lists', () => {
    seedAgent('other', { team: { role: 'leader', reportsTo: null, delegatesTo: ['removed', 'keep'], autoDelegation: false } })
    at.cleanupTeamReferences('removed')
    expect(at.readAgentTeam('other').delegatesTo).toEqual(['keep'])
  })

  it('removes the removed agent from trustFrom lists', () => {
    seedAgent('peer', { team: { role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false, trustFrom: ['removed', 'keep'] } })
    at.cleanupTeamReferences('removed')
    expect(at.readAgentTeam('peer').trustFrom).toEqual(['keep'])
  })

  it('rewrites reportsTo to null when MAIN_AGENT_ID itself is removed', () => {
    seedAgent('orphan', { team: { role: 'member', reportsTo: 'mainagent', delegatesTo: [], autoDelegation: false } })
    at.cleanupTeamReferences('mainagent')
    expect(at.readAgentTeam('orphan').reportsTo).toBeNull()
  })

  it('handles an agent whose trustFrom is missing (undefined)', () => {
    seedAgent('no_tf', { team: { role: 'member', reportsTo: null, delegatesTo: [], autoDelegation: false } })
    // No exception, no spurious write.
    expect(() => at.cleanupTeamReferences('removed')).not.toThrow()
    const after = at.readAgentTeam('no_tf')
    expect(after.trustFrom).toEqual([])
  })

  it('rewrites multiple agents referencing the removed name', () => {
    seedAgent('follower1', { team: { role: 'member', reportsTo: 'removed', delegatesTo: [], autoDelegation: false } })
    seedAgent('follower2', { team: { role: 'member', reportsTo: 'removed', delegatesTo: ['removed'], autoDelegation: false } })
    at.cleanupTeamReferences('removed')
    expect(at.readAgentTeam('follower1').reportsTo).toBe('mainagent')
    expect(at.readAgentTeam('follower2').reportsTo).toBe('mainagent')
    expect(at.readAgentTeam('follower2').delegatesTo).toEqual([])
  })

  it('rewrites both delegatesTo and trustFrom in a single pass', () => {
    seedAgent('multi', { team: {
      role: 'member',
      reportsTo: 'removed',
      delegatesTo: ['removed', 'keep-del'],
      autoDelegation: false,
      trustFrom: ['removed', 'keep-tf'],
    } })
    at.cleanupTeamReferences('removed')
    const after = at.readAgentTeam('multi')
    expect(after.reportsTo).toBe('mainagent')
    expect(after.delegatesTo).toEqual(['keep-del'])
    expect(after.trustFrom).toEqual(['keep-tf'])
  })

  // The previous pinning test for the `(team.trustFrom ?? [])` dead branch
  // was removed when trustFrom was narrowed to a required `string[]`: that
  // fallback no longer exists, so the dead-branch documentation has no
  // surviving code to pin.
})
