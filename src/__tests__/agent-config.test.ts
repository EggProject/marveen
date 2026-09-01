// 100% coverage for src/web/agent-config.ts.
//
// Strategy: redirect PROJECT_ROOT and homedir() to a single temp sandbox for
// the whole file. Per-test cleanup wipes the contents (so each test starts
// from an empty agents/ and store/) and calls invalidateModelProfileMapCache()
// to drop the per-module mtime cache between reads.
//
// MAIN_AGENT_ID is overridden so `agentConfigRoot` can be exercised against a
// stable value (`'mainagent'`) regardless of the host's actual env.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync,
  statSync, utimesSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Flag-controlled override: when set, every statSync call against the model-
// profile-map path throws, which is the only reliable way to force the outer
// try/catch in readModelProfileMap (macOS root bypasses chmod-0 on the parent
// dir, so a permission-based throw does not actually fire).
let forceStatError = false

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  // `PROJECT` / `STORE` are module-scope consts declared below -- vi.mock
  // factories are hoisted above them. Defer the reads with getters so the
  // values are picked up the first time PROJECT_ROOT / STORE_DIR is
  // accessed, after the consts have been initialised.
  return Object.defineProperties(
    { ...actual, MAIN_AGENT_ID: 'mainagent' },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => STORE, enumerable: true },
    },
  )
})
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  const realStatSync = actual.statSync
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'statSync') {
        return ((p: string) => {
          if (forceStatError) throw new Error('mocked stat failure')
          return realStatSync(p)
        }) as typeof statSync
      }
      return Reflect.get(target, prop, receiver)
    },
  })
})

const SANDBOX = mkdtempSync(join(tmpdir(), 'agentcfg-'))
const PROJECT = join(SANDBOX, 'project')
const STORE = join(PROJECT, 'store')
const HOME = join(SANDBOX, 'home')
const AGENTS_DIR = join(PROJECT, 'agents')
const PERSONAS_DIR = join(PROJECT, 'personas')
const MAP_PATH = join(STORE, 'model-profile-map.json')

const ac = await import('../web/agent-config.js')

function seedAgent(name: string, config: Record<string, unknown> = {}): string {
  const dir = join(AGENTS_DIR, name)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'agent-config.json'), JSON.stringify(config))
  return dir
}

function resetSandbox(): void {
  rmSync(PROJECT, { recursive: true, force: true })
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(STORE, { recursive: true })
  mkdirSync(PERSONAS_DIR, { recursive: true })
  ac.invalidateModelProfileMapCache()
}

beforeEach(resetSandbox)
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// Module-scope constants and re-exports
// ---------------------------------------------------------------------------

describe('module-scope constants', () => {
  it('AGENTS_BASE_DIR is PROJECT_ROOT/agents', () => {
    expect(ac.AGENTS_BASE_DIR).toBe(AGENTS_DIR)
  })

  it('DEFAULT_MODEL re-exports DEFAULT_AGENT_MODEL', () => {
    expect(ac.DEFAULT_MODEL).toBe(ac.DEFAULT_MODEL)
    expect(ac.DEFAULT_MODEL).toBe('claude-opus-4-8[1m]')
  })

  it('MODEL_ALIASES maps every short name to a full Claude model id', () => {
    expect(ac.MODEL_ALIASES['opus']).toBe('claude-opus-4-8[1m]')
    expect(ac.MODEL_ALIASES['sonnet']).toBe('claude-sonnet-5')
    expect(ac.MODEL_ALIASES['sonnet-5']).toBe('claude-sonnet-5')
    expect(ac.MODEL_ALIASES['sonnet5']).toBe('claude-sonnet-5')
    expect(ac.MODEL_ALIASES['opus-5']).toBe('claude-opus-5')
    expect(ac.MODEL_ALIASES['opus5']).toBe('claude-opus-5')
    expect(ac.MODEL_ALIASES['haiku']).toBe('claude-haiku-4-5-20251001')
    expect(ac.MODEL_ALIASES['inherit']).toBe(ac.DEFAULT_MODEL)
  })

  it('HIDDEN_AGENT_SENTINEL is .hidden-from-dashboard', () => {
    expect(ac.HIDDEN_AGENT_SENTINEL).toBe('.hidden-from-dashboard')
  })
})

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------

describe('agentDir', () => {
  it('joins the agent name under AGENTS_BASE_DIR', () => {
    expect(ac.agentDir('foo')).toBe(join(AGENTS_DIR, 'foo'))
  })

  it('rejects path-traversal components via safeJoin', () => {
    expect(() => ac.agentDir('../escape')).toThrow()
  })
})

describe('agentConfigRoot', () => {
  it('returns PROJECT_ROOT for the main agent', () => {
    expect(ac.agentConfigRoot('mainagent')).toBe(PROJECT)
  })

  it('returns agentDir(name) for sub-agents', () => {
    expect(ac.agentConfigRoot('helper')).toBe(join(AGENTS_DIR, 'helper'))
  })
})

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

describe('readFileOr', () => {
  it('returns the file contents when the file exists', () => {
    const path = join(SANDBOX, 'present.txt')
    writeFileSync(path, 'hello')
    expect(ac.readFileOr(path, 'fallback')).toBe('hello')
  })

  it('returns the fallback when the file is missing', () => {
    expect(ac.readFileOr(join(SANDBOX, 'missing.txt'), 'fallback')).toBe('fallback')
  })
})

describe('extractDescriptionFromClaudeMd', () => {
  it('returns the first non-heading, non-blank line trimmed to 200 chars', () => {
    const md = `# Title\n\nThis is the description line.\n\nMore body.`
    expect(ac.extractDescriptionFromClaudeMd(md)).toBe('This is the description line.')
  })

  it('skips leading headings and blank lines', () => {
    const md = `\n\n# H1\n## H2\n\nFirst real paragraph here.`
    expect(ac.extractDescriptionFromClaudeMd(md)).toBe('First real paragraph here.')
  })

  it('truncates a long first paragraph to 200 characters', () => {
    const long = 'a'.repeat(500)
    expect(ac.extractDescriptionFromClaudeMd(long)).toHaveLength(200)
    expect(ac.extractDescriptionFromClaudeMd(long)).toBe('a'.repeat(200))
  })

  it('returns an empty string when no body line exists', () => {
    expect(ac.extractDescriptionFromClaudeMd('# only a heading')).toBe('')
    expect(ac.extractDescriptionFromClaudeMd('')).toBe('')
  })
})

describe('findAvatarForAgent', () => {
  it('returns the avatar.png path when it exists', () => {
    const dir = seedAgent('av1')
    writeFileSync(join(dir, 'avatar.png'), '')
    expect(ac.findAvatarForAgent('av1')).toBe(join(dir, 'avatar.png'))
  })

  it('returns avatar.jpg when png is absent', () => {
    const dir = seedAgent('av2')
    writeFileSync(join(dir, 'avatar.jpg'), '')
    expect(ac.findAvatarForAgent('av2')).toBe(join(dir, 'avatar.jpg'))
  })

  it('returns avatar.jpeg when png and jpg are absent', () => {
    const dir = seedAgent('av3')
    writeFileSync(join(dir, 'avatar.jpeg'), '')
    expect(ac.findAvatarForAgent('av3')).toBe(join(dir, 'avatar.jpeg'))
  })

  it('returns avatar.webp when the other formats are absent', () => {
    const dir = seedAgent('av4')
    writeFileSync(join(dir, 'avatar.webp'), '')
    expect(ac.findAvatarForAgent('av4')).toBe(join(dir, 'avatar.webp'))
  })

  it('prefers png over later extensions when multiple are present', () => {
    const dir = seedAgent('av5')
    writeFileSync(join(dir, 'avatar.png'), '')
    writeFileSync(join(dir, 'avatar.jpg'), '')
    expect(ac.findAvatarForAgent('av5')).toBe(join(dir, 'avatar.png'))
  })

  it('returns null when no avatar exists', () => {
    seedAgent('av6')
    expect(ac.findAvatarForAgent('av6')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Model resolution
// ---------------------------------------------------------------------------

describe('resolveModelId', () => {
  it('returns the alias when one matches', () => {
    expect(ac.resolveModelId('opus')).toBe('claude-opus-4-8[1m]')
    expect(ac.resolveModelId('haiku')).toBe('claude-haiku-4-5-20251001')
  })

  it('returns the input verbatim when no alias matches', () => {
    expect(ac.resolveModelId('claude-future-99')).toBe('claude-future-99')
  })
})

describe('readModelProfileMap', () => {
  it('returns null when the map file does not exist', () => {
    expect(ac.readModelProfileMap()).toBeNull()
  })

  it('returns the parsed state when the map is valid', () => {
    writeFileSync(MAP_PATH, JSON.stringify({
      version: '1',
      profiles: {
        premium_reasoning: 'claude-opus-4-8[1m]',
        build_strong: 'claude-sonnet-5',
        analysis_efficient: 'claude-sonnet-5',
        routine_lowcost: 'claude-haiku-4-5-20251001',
      },
    }))
    const state = ac.readModelProfileMap()
    expect(state?.ok).toBe(true)
    expect(state?.ok && state.map.profiles.premium_reasoning).toBe('claude-opus-4-8[1m]')
  })

  it('caches the parsed state and re-uses it on subsequent reads (same mtime)', () => {
    const mtime = new Date(Date.now() - 60_000)
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'a',
        build_strong: 'b',
        analysis_efficient: 'c',
        routine_lowcost: 'd',
      },
    }))
    utimesSync(MAP_PATH, mtime, mtime)
    const first = ac.readModelProfileMap()
    // Overwrite the file with new content; the new write bumps the mtime,
    // so we restore it to the original value to keep the cache hit.
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'changed',
        build_strong: 'b',
        analysis_efficient: 'c',
        routine_lowcost: 'd',
      },
    }))
    utimesSync(MAP_PATH, mtime, mtime)
    const second = ac.readModelProfileMap()
    expect(second).toBe(first)
  })

  it('re-reads the file when the mtime changes', () => {
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'first',
        build_strong: 'b',
        analysis_efficient: 'c',
        routine_lowcost: 'd',
      },
    }))
    ac.readModelProfileMap()
    // Bump the mtime to a future instant so the next read sees a fresh value.
    const future = new Date(Date.now() + 60_000)
    utimesSync(MAP_PATH, future, future)
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'second',
        build_strong: 'b',
        analysis_efficient: 'c',
        routine_lowcost: 'd',
      },
    }))
    const reread = ac.readModelProfileMap()
    expect(reread?.ok && reread.map.profiles.premium_reasoning).toBe('second')
  })

  it('returns profile_map_unparseable when the JSON is broken', () => {
    writeFileSync(MAP_PATH, '{not json')
    const state = ac.readModelProfileMap()
    expect(state).toEqual({ ok: false, error: 'profile_map_unparseable' })
  })

  it('returns the validation error from validateModelProfileMap', () => {
    writeFileSync(MAP_PATH, JSON.stringify({ profiles: { wrong_key: 'x' } }))
    const state = ac.readModelProfileMap()
    expect(state?.ok).toBe(false)
    if (state && !state.ok) expect(state.error).toContain('profile_map')
  })

  it('returns profile_map_read_error when statSync throws', () => {
    // vi.spyOn cannot reach the named import in agent-config.ts (the binding
    // is captured at import time), so the proxy on node:fs intercepts the
    // statSync call and throws for the map path only. macOS root bypasses
    // chmod-0, so this is the only reliable way to hit the outer try/catch.
    writeFileSync(MAP_PATH, '{}')
    forceStatError = true
    try {
      const state = ac.readModelProfileMap()
      expect(state).toEqual({ ok: false, error: 'profile_map_read_error' })
    } finally {
      forceStatError = false
    }
  })
})

describe('invalidateModelProfileMapCache', () => {
  it('drops the cached state so the next read re-parses the file', () => {
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'first',
        build_strong: 'b',
        analysis_efficient: 'c',
        routine_lowcost: 'd',
      },
    }))
    const first = ac.readModelProfileMap()
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'second',
        build_strong: 'b',
        analysis_efficient: 'c',
        routine_lowcost: 'd',
      },
    }))
    ac.invalidateModelProfileMapCache()
    const reread = ac.readModelProfileMap()
    expect(reread).not.toBe(first)
    expect(reread?.ok && reread.map.profiles.premium_reasoning).toBe('second')
  })
})

describe('resolveAgentModelDetailed', () => {
  it('returns default when the config file is missing', () => {
    const res = ac.resolveAgentModelDetailed('ghost')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
    expect(res.source).toBe('default')
  })

  it('returns default when the config file has invalid JSON', () => {
    const dir = seedAgent('badjson')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    const res = ac.resolveAgentModelDetailed('badjson')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
    expect(res.source).toBe('default')
  })

  it('returns the explicit model when one is set (no profile map)', () => {
    seedAgent('withmodel', { model: 'opus' })
    const res = ac.resolveAgentModelDetailed('withmodel')
    expect(res.model).toBe('claude-opus-4-8[1m]')
    expect(res.source).toBe('explicit_model')
  })

  it('passes a literal model id through verbatim', () => {
    seedAgent('verbatim', { model: 'claude-future-99' })
    const res = ac.resolveAgentModelDetailed('verbatim')
    expect(res.model).toBe('claude-future-99')
  })

  it('resolves a modelProfile against a valid profile map', () => {
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'claude-opus-4-8[1m]',
        build_strong: 'claude-sonnet-5',
        analysis_efficient: 'claude-sonnet-5',
        routine_lowcost: 'claude-haiku-4-5-20251001',
      },
    }))
    seedAgent('tier', { modelProfile: 'build_strong' })
    const res = ac.resolveAgentModelDetailed('tier')
    expect(res.model).toBe('claude-sonnet-5')
    expect(res.source).toBe('model_profile')
  })

  it('explicit model wins over modelProfile', () => {
    writeFileSync(MAP_PATH, JSON.stringify({
      profiles: {
        premium_reasoning: 'claude-opus-4-8[1m]',
        build_strong: 'claude-sonnet-5',
        analysis_efficient: 'claude-sonnet-5',
        routine_lowcost: 'claude-haiku-4-5-20251001',
      },
    }))
    seedAgent('both', { model: 'haiku', modelProfile: 'premium_reasoning' })
    const res = ac.resolveAgentModelDetailed('both')
    expect(res.model).toBe('claude-haiku-4-5-20251001')
    expect(res.source).toBe('explicit_model')
  })

  it('reports an error when an unknown profile is named', () => {
    seedAgent('bogus', { modelProfile: 'mystery-tier' })
    const res = ac.resolveAgentModelDetailed('bogus')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
    expect(res.source).toBe('default')
    expect(res.error).toContain('unknown_model_profile')
  })

  it('reports an error when a profile is named but the map is missing', () => {
    seedAgent('nomap', { modelProfile: 'build_strong' })
    const res = ac.resolveAgentModelDetailed('nomap')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
    expect(res.error).toBe('model_profile_map_missing')
  })

  it('reports the map error when the map is present but invalid', () => {
    writeFileSync(MAP_PATH, '{not json')
    seedAgent('badmap', { modelProfile: 'build_strong' })
    const res = ac.resolveAgentModelDetailed('badmap')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
    expect(res.error).toBe('profile_map_unparseable')
  })

  it('falls back to default when no model field is present', () => {
    seedAgent('blank', {})
    const res = ac.resolveAgentModelDetailed('blank')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
    expect(res.source).toBe('default')
  })

  it('ignores a non-string model field', () => {
    seedAgent('weird', { model: 42 })
    const res = ac.resolveAgentModelDetailed('weird')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
  })

  it('ignores an empty-string model field', () => {
    seedAgent('blankmodel', { model: '   ' })
    const res = ac.resolveAgentModelDetailed('blankmodel')
    expect(res.model).toBe(ac.DEFAULT_MODEL)
  })
})

describe('readAgentModel', () => {
  it('returns just the model field from resolveAgentModelDetailed', () => {
    seedAgent('rm1', { model: 'sonnet' })
    expect(ac.readAgentModel('rm1')).toBe('claude-sonnet-5')
  })

  it('returns the default when the agent has no config', () => {
    expect(ac.readAgentModel('nonexistent')).toBe(ac.DEFAULT_MODEL)
  })
})

describe('writeAgentModelProfile', () => {
  it('persists modelProfile into agent-config.json', () => {
    seedAgent('wp1')
    ac.writeAgentModelProfile('wp1', 'build_strong')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wp1', 'agent-config.json'), 'utf-8'))
    expect(json.modelProfile).toBe('build_strong')
  })

  it('removes modelProfile when passed null', () => {
    seedAgent('wp2', { model: 'haiku', modelProfile: 'build_strong' })
    ac.writeAgentModelProfile('wp2', null)
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wp2', 'agent-config.json'), 'utf-8'))
    expect('modelProfile' in json).toBe(false)
    expect(json.model).toBe('haiku')
  })

  it('starts fresh when the existing file is unreadable', () => {
    const dir = seedAgent('wp3')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    ac.writeAgentModelProfile('wp3', 'analysis_efficient')
    const json = JSON.parse(readFileSync(join(dir, 'agent-config.json'), 'utf-8'))
    expect(json.modelProfile).toBe('analysis_efficient')
  })

  it('creates the config file when none exists yet', () => {
    mkdirSync(join(AGENTS_DIR, 'wp4'), { recursive: true })
    ac.writeAgentModelProfile('wp4', 'routine_lowcost')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wp4', 'agent-config.json'), 'utf-8'))
    expect(json.modelProfile).toBe('routine_lowcost')
  })
})

describe('writeAgentModel', () => {
  it('persists model into agent-config.json', () => {
    seedAgent('wm1')
    ac.writeAgentModel('wm1', 'sonnet')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wm1', 'agent-config.json'), 'utf-8'))
    expect(json.model).toBe('sonnet')
  })

  it('overwrites an existing model and keeps the other fields', () => {
    seedAgent('wm2', { model: 'haiku', displayName: 'X' })
    ac.writeAgentModel('wm2', 'opus')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wm2', 'agent-config.json'), 'utf-8'))
    expect(json.model).toBe('opus')
    expect(json.displayName).toBe('X')
  })
})

// ---------------------------------------------------------------------------
// Display name + security profile
// ---------------------------------------------------------------------------

describe('readAgentDisplayName', () => {
  it('returns the configured displayName when present', () => {
    seedAgent('dn1', { displayName: 'My Agent' })
    expect(ac.readAgentDisplayName('dn1')).toBe('My Agent')
  })

  it('trims surrounding whitespace from displayName', () => {
    seedAgent('dn2', { displayName: '  Spaced  ' })
    expect(ac.readAgentDisplayName('dn2')).toBe('Spaced')
  })

  it('returns a title-cased version of the name when displayName is missing', () => {
    seedAgent('helperbot')
    expect(ac.readAgentDisplayName('helperbot')).toBe('Helperbot')
  })

  it('returns a title-cased version when displayName is empty or non-string', () => {
    seedAgent('dn3', { displayName: '' })
    expect(ac.readAgentDisplayName('dn3')).toBe('Dn3')
    seedAgent('dn4', { displayName: 42 })
    expect(ac.readAgentDisplayName('dn4')).toBe('Dn4')
  })

  it('falls through to title-cased name on JSON parse error', () => {
    const dir = seedAgent('dn5')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    expect(ac.readAgentDisplayName('dn5')).toBe('Dn5')
  })
})

describe('writeAgentDisplayName', () => {
  it('persists displayName into agent-config.json', () => {
    seedAgent('wd1')
    ac.writeAgentDisplayName('wd1', 'Cool Bot')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wd1', 'agent-config.json'), 'utf-8'))
    expect(json.displayName).toBe('Cool Bot')
  })

  it('overwrites an existing displayName', () => {
    seedAgent('wd2', { displayName: 'Old' })
    ac.writeAgentDisplayName('wd2', 'New')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wd2', 'agent-config.json'), 'utf-8'))
    expect(json.displayName).toBe('New')
  })
})

describe('readAgentSecurityProfile', () => {
  it('returns the configured profile when present', () => {
    seedAgent('sp1', { securityProfile: 'developer-senior' })
    expect(ac.readAgentSecurityProfile('sp1')).toBe('developer-senior')
  })

  it('trims the configured profile', () => {
    seedAgent('sp2', { securityProfile: '  reviewer  ' })
    expect(ac.readAgentSecurityProfile('sp2')).toBe('reviewer')
  })

  it('returns "default" when the profile is missing', () => {
    seedAgent('sp3')
    expect(ac.readAgentSecurityProfile('sp3')).toBe('default')
  })

  it('returns "default" when the profile is not a string or is empty', () => {
    seedAgent('sp4', { securityProfile: '' })
    expect(ac.readAgentSecurityProfile('sp4')).toBe('default')
    seedAgent('sp5', { securityProfile: '   ' })
    expect(ac.readAgentSecurityProfile('sp5')).toBe('default')
    seedAgent('sp6', { securityProfile: 42 })
    expect(ac.readAgentSecurityProfile('sp6')).toBe('default')
  })

  it('returns "default" on JSON parse error', () => {
    const dir = seedAgent('sp7')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    expect(ac.readAgentSecurityProfile('sp7')).toBe('default')
  })
})

describe('writeAgentSecurityProfile', () => {
  it('persists the securityProfile into agent-config.json', () => {
    seedAgent('wsp1')
    ac.writeAgentSecurityProfile('wsp1', 'reviewer')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wsp1', 'agent-config.json'), 'utf-8'))
    expect(json.securityProfile).toBe('reviewer')
  })
})

// ---------------------------------------------------------------------------
// claudeConfigDir
// ---------------------------------------------------------------------------

describe('expandAndValidateConfigDir', () => {
  it('returns null for empty or whitespace-only input', () => {
    expect(ac.expandAndValidateConfigDir('', HOME)).toBeNull()
    expect(ac.expandAndValidateConfigDir('   ', HOME)).toBeNull()
  })

  it('returns the absolute path verbatim', () => {
    expect(ac.expandAndValidateConfigDir('/var/lib/claude', HOME)).toBe('/var/lib/claude')
  })

  it('expands a bare ~ to the home dir', () => {
    expect(ac.expandAndValidateConfigDir('~', HOME)).toBe(HOME)
  })

  it('expands ~/... against the home dir', () => {
    expect(ac.expandAndValidateConfigDir('~/.claude-x', HOME)).toBe(join(HOME, '.claude-x'))
  })

  it('rejects a tilde in the middle of the string', () => {
    expect(ac.expandAndValidateConfigDir('/abs/foo~bar', HOME)).toBeNull()
  })

  it('rejects ~user form', () => {
    expect(ac.expandAndValidateConfigDir('~root/.x', HOME)).toBeNull()
  })

  it('rejects a double tilde', () => {
    expect(ac.expandAndValidateConfigDir('~~/x', HOME)).toBeNull()
  })

  it('rejects disallowed characters', () => {
    expect(ac.expandAndValidateConfigDir('/abs/with"quote', HOME)).toBeNull()
    expect(ac.expandAndValidateConfigDir('/abs/with$var', HOME)).toBeNull()
    expect(ac.expandAndValidateConfigDir('/abs/with;rm', HOME)).toBeNull()
    expect(ac.expandAndValidateConfigDir('/abs/with space', HOME)).toBeNull()
    expect(ac.expandAndValidateConfigDir('/abs/with`whoami`', HOME)).toBeNull()
    expect(ac.expandAndValidateConfigDir('/abs/with(parens)', HOME)).toBeNull()
  })

  it('rejects .. segments', () => {
    expect(ac.expandAndValidateConfigDir('/var/../etc', HOME)).toBeNull()
    expect(ac.expandAndValidateConfigDir('~/../etc', HOME)).toBeNull()
  })

  it('accepts a path with allowed specials (dot, dash, underscore)', () => {
    expect(ac.expandAndValidateConfigDir('~/.claude-coding_v2.x', HOME))
      .toBe(join(HOME, '.claude-coding_v2.x'))
  })

  it('returns null when the post-expansion path contains disallowed chars', () => {
    expect(ac.expandAndValidateConfigDir('~/.claude-x', '/home/with space')).toBeNull()
  })

  it('trims surrounding whitespace', () => {
    expect(ac.expandAndValidateConfigDir('  /abs/path  ', HOME)).toBe('/abs/path')
  })
})

describe('resolveClaudeConfigDir', () => {
  it('returns null for empty / non-object / unparseable JSON', () => {
    expect(ac.resolveClaudeConfigDir('{}', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('null', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('[]', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('"x"', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('42', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('not json', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('', HOME)).toBeNull()
  })

  it('returns null when the field is missing or not a string', () => {
    expect(ac.resolveClaudeConfigDir('{"model":"sonnet"}', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('{"claudeConfigDir":null}', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('{"claudeConfigDir":42}', HOME)).toBeNull()
    expect(ac.resolveClaudeConfigDir('{"claudeConfigDir":{}}', HOME)).toBeNull()
  })

  it('returns the resolved absolute path for a valid value', () => {
    expect(ac.resolveClaudeConfigDir('{"claudeConfigDir":"~/.claude-x"}', HOME))
      .toBe(join(HOME, '.claude-x'))
  })

  it('returns null for a value that fails validation', () => {
    expect(ac.resolveClaudeConfigDir('{"claudeConfigDir":"/abs/with$bad"}', HOME)).toBeNull()
  })
})

describe('readAgentClaudeConfigDir', () => {
  it('reads the configured value and expands it against homedir()', () => {
    seedAgent('ccd1', { claudeConfigDir: '~/.claude-alt' })
    expect(ac.readAgentClaudeConfigDir('ccd1')).toBe(join(HOME, '.claude-alt'))
  })

  it('returns null when the field is missing', () => {
    seedAgent('ccd2', { model: 'sonnet' })
    expect(ac.readAgentClaudeConfigDir('ccd2')).toBeNull()
  })

  it('returns null when the agent has no config file', () => {
    expect(ac.readAgentClaudeConfigDir('nonexistent')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Remote config
// ---------------------------------------------------------------------------

describe('resolveRemoteConfig', () => {
  it('returns null/null for empty input', () => {
    expect(ac.resolveRemoteConfig('{}')).toEqual({ host: null, workdir: null })
  })

  it('returns null/null for unparseable JSON', () => {
    expect(ac.resolveRemoteConfig('not json')).toEqual({ host: null, workdir: null })
  })

  it('returns null/null for a non-object JSON value', () => {
    expect(ac.resolveRemoteConfig('null')).toEqual({ host: null, workdir: null })
    expect(ac.resolveRemoteConfig('[]')).toEqual({ host: null, workdir: null })
    expect(ac.resolveRemoteConfig('"x"')).toEqual({ host: null, workdir: null })
  })

  it('returns null/null when either field is missing', () => {
    expect(ac.resolveRemoteConfig('{"remoteHost":"a@b"}')).toEqual({ host: null, workdir: null })
    expect(ac.resolveRemoteConfig('{"remoteWorkdir":"/x"}')).toEqual({ host: null, workdir: null })
  })

  it('returns null/null when either field is not a string', () => {
    expect(ac.resolveRemoteConfig('{"remoteHost":42,"remoteWorkdir":"/x"}')).toEqual({ host: null, workdir: null })
    expect(ac.resolveRemoteConfig('{"remoteHost":"a@b","remoteWorkdir":null}')).toEqual({ host: null, workdir: null })
  })

  it('returns null/null when either field is empty after trim', () => {
    expect(ac.resolveRemoteConfig('{"remoteHost":"","remoteWorkdir":"/x"}')).toEqual({ host: null, workdir: null })
    expect(ac.resolveRemoteConfig('{"remoteHost":"a@b","remoteWorkdir":"   "}')).toEqual({ host: null, workdir: null })
  })

  it('returns null/null when the host charset fails validation', () => {
    expect(ac.resolveRemoteConfig('{"remoteHost":"a:b","remoteWorkdir":"/x"}')).toEqual({ host: null, workdir: null })
  })

  it('returns null/null when the workdir fails validation', () => {
    expect(ac.resolveRemoteConfig('{"remoteHost":"a@b","remoteWorkdir":"rel/path"}')).toEqual({ host: null, workdir: null })
    expect(ac.resolveRemoteConfig('{"remoteHost":"a@b","remoteWorkdir":"/var/../etc"}')).toEqual({ host: null, workdir: null })
  })

  it('returns the parsed pair on success', () => {
    const out = ac.resolveRemoteConfig('{"remoteHost":"a@b","remoteWorkdir":"/srv/x"}')
    expect(out).toEqual({ host: 'a@b', workdir: '/srv/x' })
  })

  it('trims both fields before returning', () => {
    const out = ac.resolveRemoteConfig('{"remoteHost":"  a@b  ","remoteWorkdir":"  /srv/x  "}')
    expect(out).toEqual({ host: 'a@b', workdir: '/srv/x' })
  })
})

describe('readAgentRemoteConfig + readAgentRemoteHost', () => {
  it('returns the configured remote pair', () => {
    seedAgent('rmt1', { remoteHost: 'a@b', remoteWorkdir: '/srv/x' })
    expect(ac.readAgentRemoteConfig('rmt1')).toEqual({ host: 'a@b', workdir: '/srv/x' })
  })

  it('readAgentRemoteHost returns just the host', () => {
    seedAgent('rmt2', { remoteHost: 'a@b', remoteWorkdir: '/srv/x' })
    expect(ac.readAgentRemoteHost('rmt2')).toBe('a@b')
  })

  it('returns null host for a local agent', () => {
    seedAgent('rmt3')
    expect(ac.readAgentRemoteHost('rmt3')).toBeNull()
  })

  it('returns null host when the agent has no config file', () => {
    expect(ac.readAgentRemoteHost('nonexistent')).toBeNull()
  })
})

describe('writeAgentRemoteConfig', () => {
  it('persists a valid host/workdir pair and returns ok', () => {
    seedAgent('wr1')
    const result = ac.writeAgentRemoteConfig('wr1', 'a@b', '/srv/x')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.remote).toEqual({ host: 'a@b', workdir: '/srv/x' })
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wr1', 'agent-config.json'), 'utf-8'))
    expect(json.remoteHost).toBe('a@b')
    expect(json.remoteWorkdir).toBe('/srv/x')
  })

  it('clears both fields when both inputs are empty', () => {
    seedAgent('wr2', { remoteHost: 'a@b', remoteWorkdir: '/srv/x', model: 'sonnet' })
    const result = ac.writeAgentRemoteConfig('wr2', '', '')
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.remote).toEqual({ host: null, workdir: null })
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wr2', 'agent-config.json'), 'utf-8'))
    expect('remoteHost' in json).toBe(false)
    expect('remoteWorkdir' in json).toBe(false)
    expect(json.model).toBe('sonnet')
  })

  it('returns an error when only one of the two is set', () => {
    seedAgent('wr3')
    expect(ac.writeAgentRemoteConfig('wr3', 'a@b', '').ok).toBe(false)
    expect(ac.writeAgentRemoteConfig('wr3', '', '/srv/x').ok).toBe(false)
  })

  it('returns an error when the values fail validation', () => {
    seedAgent('wr4')
    expect(ac.writeAgentRemoteConfig('wr4', 'bad:host', '/srv/x').ok).toBe(false)
    expect(ac.writeAgentRemoteConfig('wr4', 'a@b', 'rel/path').ok).toBe(false)
  })

  it('starts fresh when the existing file is unparseable JSON', () => {
    const dir = seedAgent('wr5')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    const result = ac.writeAgentRemoteConfig('wr5', 'a@b', '/srv/x')
    expect(result.ok).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// channelProvider
// ---------------------------------------------------------------------------

describe('readAgentChannelProvider', () => {
  it('returns the configured provider', () => {
    seedAgent('cp1', { channelProvider: 'telegram' })
    expect(ac.readAgentChannelProvider('cp1')).toBe('telegram')
  })

  it('trims whitespace', () => {
    seedAgent('cp2', { channelProvider: '  slack  ' })
    expect(ac.readAgentChannelProvider('cp2')).toBe('slack')
  })

  it('returns null when missing or non-string', () => {
    seedAgent('cp3')
    expect(ac.readAgentChannelProvider('cp3')).toBeNull()
    seedAgent('cp4', { channelProvider: 42 })
    expect(ac.readAgentChannelProvider('cp4')).toBeNull()
    seedAgent('cp5', { channelProvider: '' })
    expect(ac.readAgentChannelProvider('cp5')).toBeNull()
  })

  it('returns null when the agent has no config file', () => {
    expect(ac.readAgentChannelProvider('nonexistent')).toBeNull()
  })
})

describe('writeAgentChannelProvider', () => {
  it('persists the provider', () => {
    seedAgent('wcp1')
    ac.writeAgentChannelProvider('wcp1', 'telegram')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wcp1', 'agent-config.json'), 'utf-8'))
    expect(json.channelProvider).toBe('telegram')
  })
})

// ---------------------------------------------------------------------------
// authMode
// ---------------------------------------------------------------------------

describe('readAgentAuthMode', () => {
  it('returns the configured mode when valid', () => {
    seedAgent('am1', { authMode: 'own_team' })
    expect(ac.readAgentAuthMode('am1')).toBe('own_team')
  })

  it('returns "shared" when missing, empty, invalid, or non-string', () => {
    seedAgent('am2')
    expect(ac.readAgentAuthMode('am2')).toBe('shared')
    seedAgent('am3', { authMode: '' })
    expect(ac.readAgentAuthMode('am3')).toBe('shared')
    seedAgent('am4', { authMode: 'mystery' })
    expect(ac.readAgentAuthMode('am4')).toBe('shared')
    seedAgent('am5', { authMode: 42 })
    expect(ac.readAgentAuthMode('am5')).toBe('shared')
  })

  it('returns "shared" when the agent has no config file', () => {
    expect(ac.readAgentAuthMode('nonexistent')).toBe('shared')
  })
})

describe('writeAgentAuthMode', () => {
  it('persists a valid mode', () => {
    seedAgent('wam1')
    ac.writeAgentAuthMode('wam1', 'api')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wam1', 'agent-config.json'), 'utf-8'))
    expect(json.authMode).toBe('api')
  })

  it('silently ignores an invalid mode', () => {
    mkdirSync(join(AGENTS_DIR, 'wam2'), { recursive: true })
    ac.writeAgentAuthMode('wam2', 'mystery' as never)
    // No file is written: the early return short-circuits before
    // atomicWriteFileSync.
    expect(existsSync(join(AGENTS_DIR, 'wam2', 'agent-config.json'))).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// memoryIsolation
// ---------------------------------------------------------------------------

describe('readAgentMemoryIsolation', () => {
  it('returns true only when the field is exactly the boolean true', () => {
    seedAgent('mi1', { memoryIsolation: true })
    expect(ac.readAgentMemoryIsolation('mi1')).toBe(true)
  })

  it('returns false for false, missing, or any other value', () => {
    seedAgent('mi2', { memoryIsolation: false })
    expect(ac.readAgentMemoryIsolation('mi2')).toBe(false)
    seedAgent('mi3')
    expect(ac.readAgentMemoryIsolation('mi3')).toBe(false)
    seedAgent('mi4', { memoryIsolation: 'true' })
    expect(ac.readAgentMemoryIsolation('mi4')).toBe(false)
    seedAgent('mi5', { memoryIsolation: 1 })
    expect(ac.readAgentMemoryIsolation('mi5')).toBe(false)
  })

  it('returns false when the agent has no config file', () => {
    expect(ac.readAgentMemoryIsolation('nonexistent')).toBe(false)
  })

  it('returns false when the config file is unparseable JSON', () => {
    const dir = seedAgent('mi6')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    expect(ac.readAgentMemoryIsolation('mi6')).toBe(false)
  })
})

describe('writeAgentMemoryIsolation', () => {
  it('persists true when enabled', () => {
    seedAgent('wmi1')
    ac.writeAgentMemoryIsolation('wmi1', true)
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wmi1', 'agent-config.json'), 'utf-8'))
    expect(json.memoryIsolation).toBe(true)
  })

  it('removes the key when disabled', () => {
    seedAgent('wmi2', { memoryIsolation: true, model: 'sonnet' })
    ac.writeAgentMemoryIsolation('wmi2', false)
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wmi2', 'agent-config.json'), 'utf-8'))
    expect('memoryIsolation' in json).toBe(false)
    expect(json.model).toBe('sonnet')
  })
})

// ---------------------------------------------------------------------------
// claudePlan
// ---------------------------------------------------------------------------

describe('readAgentClaudePlan', () => {
  it('returns the trimmed plan id when set', () => {
    seedAgent('cp_a1', { claudePlan: '  team-pro  ' })
    expect(ac.readAgentClaudePlan('cp_a1')).toBe('team-pro')
  })

  it('returns null when missing, empty, non-string', () => {
    seedAgent('cp_a2')
    expect(ac.readAgentClaudePlan('cp_a2')).toBeNull()
    seedAgent('cp_a3', { claudePlan: '' })
    expect(ac.readAgentClaudePlan('cp_a3')).toBeNull()
    seedAgent('cp_a4', { claudePlan: '   ' })
    expect(ac.readAgentClaudePlan('cp_a4')).toBeNull()
    seedAgent('cp_a5', { claudePlan: 42 })
    expect(ac.readAgentClaudePlan('cp_a5')).toBeNull()
  })

  it('returns null when the agent has no config file', () => {
    expect(ac.readAgentClaudePlan('nonexistent')).toBeNull()
  })
})

describe('writeAgentClaudePlan', () => {
  it('persists a non-empty plan id (trimmed)', () => {
    seedAgent('wcp_p1')
    ac.writeAgentClaudePlan('wcp_p1', '  team-pro  ')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wcp_p1', 'agent-config.json'), 'utf-8'))
    expect(json.claudePlan).toBe('team-pro')
  })

  it('removes the key when given empty or whitespace', () => {
    seedAgent('wcp_p2', { claudePlan: 'team-pro', model: 'sonnet' })
    ac.writeAgentClaudePlan('wcp_p2', '')
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wcp_p2', 'agent-config.json'), 'utf-8'))
    expect('claudePlan' in json).toBe(false)
    expect(json.model).toBe('sonnet')

    ac.writeAgentClaudePlan('wcp_p2', '   ')
    const json2 = JSON.parse(readFileSync(join(AGENTS_DIR, 'wcp_p2', 'agent-config.json'), 'utf-8'))
    expect('claudePlan' in json2).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// listAgentNames + hidden sentinel
// ---------------------------------------------------------------------------

describe('listAgentNames', () => {
  it('returns an empty list when AGENTS_BASE_DIR does not exist', () => {
    rmSync(AGENTS_DIR, { recursive: true, force: true })
    expect(ac.listAgentNames()).toEqual([])
  })

  it('returns only sub-directory names, no files', () => {
    mkdirSync(join(AGENTS_DIR, 'a'), { recursive: true })
    mkdirSync(join(AGENTS_DIR, 'b'), { recursive: true })
    writeFileSync(join(AGENTS_DIR, 'c.txt'), 'x')
    expect(ac.listAgentNames().sort()).toEqual(['a', 'b'])
  })

  it('hides agents carrying the HIDDEN_AGENT_SENTINEL file', () => {
    mkdirSync(join(AGENTS_DIR, 'visible'), { recursive: true })
    mkdirSync(join(AGENTS_DIR, 'hidden'), { recursive: true })
    writeFileSync(join(AGENTS_DIR, 'hidden', ac.HIDDEN_AGENT_SENTINEL), '')
    expect(ac.listAgentNames()).toEqual(['visible'])
  })

  it('skips entries whose statSync throws (defensive filter catch)', () => {
    // proxy-mock forces statSync to throw -- exercises the per-entry
    // try/catch in listAgentNames' filter. Restore the flag afterwards so
    // the next test is not poisoned.
    mkdirSync(join(AGENTS_DIR, 'real'), { recursive: true })
    mkdirSync(join(AGENTS_DIR, 'broken'), { recursive: true })
    forceStatError = true
    try {
      expect(ac.listAgentNames()).toEqual([])
    } finally {
      forceStatError = false
    }
  })
})

// ---------------------------------------------------------------------------
// Voice config
// ---------------------------------------------------------------------------

describe('KNOWN_VOICE_MODELS / DEFAULT_VOICE_CONFIG', () => {
  it('KNOWN_VOICE_MODELS is a Set with the two bundled models', () => {
    expect(ac.KNOWN_VOICE_MODELS).toBeInstanceOf(Set)
    expect(ac.KNOWN_VOICE_MODELS.has('hu_HU-imre-medium')).toBe(true)
    expect(ac.KNOWN_VOICE_MODELS.has('hu_HU-anna-medium')).toBe(true)
    expect(ac.KNOWN_VOICE_MODELS.size).toBe(2)
  })

  it('DEFAULT_VOICE_CONFIG uses imre + text', () => {
    expect(ac.DEFAULT_VOICE_CONFIG).toEqual({
      responseMode: 'text',
      voiceModel: 'hu_HU-imre-medium',
    })
  })
})

describe('readAgentVoiceConfig', () => {
  it('returns the defaults when the config file is missing', () => {
    expect(ac.readAgentVoiceConfig('ghost')).toEqual(ac.DEFAULT_VOICE_CONFIG)
  })

  it('returns the defaults when voice is missing', () => {
    seedAgent('vc1', {})
    expect(ac.readAgentVoiceConfig('vc1')).toEqual(ac.DEFAULT_VOICE_CONFIG)
  })

  it('returns the configured responseMode and voiceModel when both are valid', () => {
    seedAgent('vc2', { voice: { responseMode: 'voice', voiceModel: 'hu_HU-anna-medium' } })
    expect(ac.readAgentVoiceConfig('vc2')).toEqual({
      responseMode: 'voice',
      voiceModel: 'hu_HU-anna-medium',
    })
  })

  it('falls back to default responseMode when the configured one is invalid', () => {
    seedAgent('vc3', { voice: { responseMode: 'shout' as never, voiceModel: 'hu_HU-anna-medium' } })
    expect(ac.readAgentVoiceConfig('vc3').responseMode).toBe('text')
    expect(ac.readAgentVoiceConfig('vc3').voiceModel).toBe('hu_HU-anna-medium')
  })

  it('falls back to default voiceModel when the configured one is unknown', () => {
    seedAgent('vc4', { voice: { responseMode: 'voice', voiceModel: 'unknown-model' } })
    expect(ac.readAgentVoiceConfig('vc4').responseMode).toBe('voice')
    expect(ac.readAgentVoiceConfig('vc4').voiceModel).toBe('hu_HU-imre-medium')
  })

  it('returns defaults on JSON parse error', () => {
    const dir = seedAgent('vc5')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    expect(ac.readAgentVoiceConfig('vc5')).toEqual(ac.DEFAULT_VOICE_CONFIG)
  })

  it('uses agentConfigRoot (PROJECT_ROOT) for the main agent', () => {
    // The main agent's config lives at PROJECT_ROOT, not under agents/.
    writeFileSync(join(PROJECT, 'agent-config.json'), JSON.stringify({
      voice: { responseMode: 'auto', voiceModel: 'hu_HU-anna-medium' },
    }))
    expect(ac.readAgentVoiceConfig('mainagent')).toEqual({
      responseMode: 'auto',
      voiceModel: 'hu_HU-anna-medium',
    })
  })
})

describe('writeAgentVoiceConfig', () => {
  it('persists a full patch', () => {
    seedAgent('wvc1')
    ac.writeAgentVoiceConfig('wvc1', {
      responseMode: 'voice',
      voiceModel: 'hu_HU-anna-medium',
    })
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wvc1', 'agent-config.json'), 'utf-8'))
    expect(json.voice).toEqual({
      responseMode: 'voice',
      voiceModel: 'hu_HU-anna-medium',
    })
  })

  it('merges with the existing config (only the patched field changes)', () => {
    seedAgent('wvc2', { voice: { responseMode: 'voice', voiceModel: 'hu_HU-imre-medium' }, model: 'sonnet' })
    ac.writeAgentVoiceConfig('wvc2', { voiceModel: 'hu_HU-anna-medium' })
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wvc2', 'agent-config.json'), 'utf-8'))
    expect(json.voice.voiceModel).toBe('hu_HU-anna-medium')
    expect(json.voice.responseMode).toBe('voice')
    expect(json.model).toBe('sonnet')
  })

  it('throws on an invalid responseMode', () => {
    seedAgent('wvc3')
    expect(() => ac.writeAgentVoiceConfig('wvc3', { responseMode: 'shout' as never }))
      .toThrow(/Invalid responseMode/)
  })

  it('throws on an unknown voiceModel', () => {
    seedAgent('wvc4')
    expect(() => ac.writeAgentVoiceConfig('wvc4', { voiceModel: 'mystery' }))
      .toThrow(/Unknown voiceModel/)
  })

  it('works against the main agent (PROJECT_ROOT)', () => {
    ac.writeAgentVoiceConfig('mainagent', { responseMode: 'auto' })
    const json = JSON.parse(readFileSync(join(PROJECT, 'agent-config.json'), 'utf-8'))
    expect(json.voice.responseMode).toBe('auto')
  })
})

// ---------------------------------------------------------------------------
// isKnownAgent
// ---------------------------------------------------------------------------

describe('isKnownAgent', () => {
  it('returns false for an empty name', () => {
    expect(ac.isKnownAgent('')).toBe(false)
  })

  it('returns true for the main agent (even with no on-disk dir)', () => {
    expect(ac.isKnownAgent('mainagent')).toBe(true)
  })

  it('returns true for a sub-agent with an existing directory', () => {
    seedAgent('known')
    expect(ac.isKnownAgent('known')).toBe(true)
  })

  it('returns false for a sub-agent without a directory', () => {
    expect(ac.isKnownAgent('ghost')).toBe(false)
  })

  it('returns false when the path is a file, not a directory', () => {
    writeFileSync(join(AGENTS_DIR, 'not-a-dir'), 'x')
    expect(ac.isKnownAgent('not-a-dir')).toBe(false)
  })

  it('returns false when statSync throws on the agent dir', () => {
    mkdirSync(join(AGENTS_DIR, 'crashy'), { recursive: true })
    forceStatError = true
    try {
      expect(ac.isKnownAgent('crashy')).toBe(false)
    } finally {
      forceStatError = false
    }
  })
})

// ---------------------------------------------------------------------------
// Capabilities
// ---------------------------------------------------------------------------

describe('readAgentCapabilities', () => {
  it('returns the array from agent-config.json when present', () => {
    seedAgent('cap1', { capabilities: ['design', 'code'] })
    expect(ac.readAgentCapabilities('cap1')).toEqual(['design', 'code'])
  })

  it('falls back to the persona file when the config field is missing', () => {
    mkdirSync(join(PERSONAS_DIR), { recursive: true })
    writeFileSync(join(PERSONAS_DIR, 'cap2.md'), `---
capabilities: [alpha, "beta", 'gamma']
---
# Persona
`)
    expect(ac.readAgentCapabilities('cap2')).toEqual(['alpha', 'beta', 'gamma'])
  })

  it('returns [] when neither config nor persona has capabilities', () => {
    seedAgent('cap3')
    expect(ac.readAgentCapabilities('cap3')).toEqual([])
  })

  it('returns [] when the persona has no YAML frontmatter', () => {
    mkdirSync(PERSONAS_DIR, { recursive: true })
    writeFileSync(join(PERSONAS_DIR, 'cap4.md'), '# No frontmatter\n')
    expect(ac.readAgentCapabilities('cap4')).toEqual([])
  })

  it('returns [] when the persona has frontmatter but no capabilities line', () => {
    mkdirSync(PERSONAS_DIR, { recursive: true })
    writeFileSync(join(PERSONAS_DIR, 'cap5.md'), `---
other: value
---
`)
    expect(ac.readAgentCapabilities('cap5')).toEqual([])
  })

  it('returns [] when the persona file does not exist', () => {
    expect(ac.readAgentCapabilities('cap6')).toEqual([])
  })

  it('ignores a non-array config field and falls through to the persona', () => {
    mkdirSync(PERSONAS_DIR, { recursive: true })
    writeFileSync(join(PERSONAS_DIR, 'cap7.md'), `---
capabilities: [from-persona]
---
`)
    seedAgent('cap7', { capabilities: 'not-an-array' })
    expect(ac.readAgentCapabilities('cap7')).toEqual(['from-persona'])
  })

  it('falls through to the persona on JSON parse error', () => {
    mkdirSync(PERSONAS_DIR, { recursive: true })
    writeFileSync(join(PERSONAS_DIR, 'cap8.md'), `---
capabilities: [from-persona]
---
`)
    const dir = seedAgent('cap8')
    writeFileSync(join(dir, 'agent-config.json'), '{not valid')
    expect(ac.readAgentCapabilities('cap8')).toEqual(['from-persona'])
  })
})

describe('writeAgentCapabilities', () => {
  it('persists capabilities into agent-config.json', () => {
    seedAgent('wcap1')
    ac.writeAgentCapabilities('wcap1', ['x', 'y'])
    const json = JSON.parse(readFileSync(join(AGENTS_DIR, 'wcap1', 'agent-config.json'), 'utf-8'))
    expect(json.capabilities).toEqual(['x', 'y'])
  })
})

// ---------------------------------------------------------------------------
// Smoke check: PROJECT_ROOT/STORE_DIR override took effect
// ---------------------------------------------------------------------------

describe('test sandbox wiring', () => {
  it('PROJECT_ROOT / AGENTS_BASE_DIR resolve inside the sandbox', () => {
    expect(ac.AGENTS_BASE_DIR.startsWith(SANDBOX)).toBe(true)
    expect(readdirSync(AGENTS_DIR)).toEqual([])
  })
})