// 100% coverage for src/web/federation/local-catalog.ts.
//
// Strategy: redirect PROJECT_ROOT / STORE_DIR / homedir() to a single temp
// sandbox so AGENTS_BASE_DIR (= PROJECT_ROOT/agents) and the per-agent
// `.claude/skills` resolution land inside tmpdir. Per-test cleanup wipes the
// contents and recreates the bare agents/ skeleton so each test starts from
// an empty catalog.
//
// federation/config.ts has no relevance for local-catalog (the module reads
// filesystem-only state) but the rules call for the test seams to be armed
// up front -- calling _setFederationStoreDirForTest + reloadFederationForTest
// keeps the suite self-consistent if a future change introduces a federation
// store read in this code path.

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest'
import {
  mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync,
  readFileSync, readdirSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// Per-test switch: when set to a path substring, every statSync whose target
// contains the substring throws. Used to force the inner `try/catch` in
// listAgentLocalSkills' filter callback to its `return false` branch without
// needing actual filesystem corruption (the only reliable cross-platform
// trigger; chmod-based tricks are bypassed by macOS root).
let forceStatThrowFor: string | null = null

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  const realStatSync = actual.statSync
  const proxy: typeof import('node:fs') = new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'statSync') {
        return ((p: string) => {
          if (forceStatThrowFor && p.includes(forceStatThrowFor)) {
            throw new Error('mocked statSync failure')
          }
          return realStatSync(p)
        }) as typeof actual.statSync
      }
      return Reflect.get(target, prop, receiver)
    },
  })
  return proxy
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => STORE, enumerable: true },
    },
  )
})
vi.mock('../web/federation/config.js', async (orig) => {
  const actual = await orig<typeof import('../web/federation/config.js')>()
  return {
    ...actual,
    _setFederationStoreDirForTest: actual._setFederationStoreDirForTest,
    reloadFederationForTest: actual.reloadFederationForTest,
  }
})

const SANDBOX = mkdtempSync(join(tmpdir(), 'fed-local-catalog-'))
const PROJECT = join(SANDBOX, 'project')
const STORE = join(PROJECT, 'store')
const HOME = join(SANDBOX, 'home')
const AGENTS_DIR = join(PROJECT, 'agents')

const lc = await import('../web/federation/local-catalog.js')
const agentConfig = await import('../web/agent-config.js')
const { _setFederationStoreDirForTest, reloadFederationForTest } = await import('../web/federation/config.js')
const { COORDINATOR_AGENT_ID } = await import('../channel-coordinator/ingest.js')

function resetSandbox(): void {
  rmSync(PROJECT, { recursive: true, force: true })
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(STORE, { recursive: true })
  _setFederationStoreDirForTest(STORE)
  reloadFederationForTest()
}

function makeAgent(name: string): string {
  const dir = join(AGENTS_DIR, name)
  mkdirSync(dir, { recursive: true })
  return dir
}

function makeSkill(agent: string, skillName: string, skillBody: string | null): string {
  const dir = join(AGENTS_DIR, agent, '.claude', 'skills', skillName)
  mkdirSync(dir, { recursive: true })
  if (skillBody !== null) writeFileSync(join(dir, 'SKILL.md'), skillBody)
  return dir
}

beforeEach(resetSandbox)
afterAll(() => { rmSync(SANDBOX, { recursive: true, force: true }) })

// ---------------------------------------------------------------------------
// MANIFEST_EXCLUDED_AGENTS
// ---------------------------------------------------------------------------

describe('MANIFEST_EXCLUDED_AGENTS', () => {
  it('is a Set containing heartbeat, channel-coordinator, and COORDINATOR_AGENT_ID', () => {
    expect(lc.MANIFEST_EXCLUDED_AGENTS).toBeInstanceOf(Set)
    expect(lc.MANIFEST_EXCLUDED_AGENTS.has('heartbeat')).toBe(true)
    expect(lc.MANIFEST_EXCLUDED_AGENTS.has('channel-coordinator')).toBe(true)
    expect(lc.MANIFEST_EXCLUDED_AGENTS.has(COORDINATOR_AGENT_ID)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// catalogAgentNames
// ---------------------------------------------------------------------------

describe('catalogAgentNames', () => {
  it('returns an empty list when agents/ does not exist', () => {
    rmSync(AGENTS_DIR, { recursive: true, force: true })
    expect(lc.catalogAgentNames()).toEqual([])
  })

  it('returns sub-directory names with the plumbing set filtered out', () => {
    makeAgent('alpha')
    makeAgent('bravo')
    makeAgent('heartbeat')
    makeAgent('channel-coordinator')
    makeAgent(COORDINATOR_AGENT_ID)
    expect(lc.catalogAgentNames().sort()).toEqual(['alpha', 'bravo'])
  })

  it('inherits the HIDDEN_AGENT_SENTINEL filter from listAgentNames', () => {
    makeAgent('visible')
    const hidden = makeAgent('hidden')
    writeFileSync(join(hidden, agentConfig.HIDDEN_AGENT_SENTINEL), '')
    expect(lc.catalogAgentNames()).toEqual(['visible'])
  })

  it('skips non-directory entries (defensive listAgentNames filter)', () => {
    makeAgent('real')
    writeFileSync(join(AGENTS_DIR, 'stray.txt'), 'not-a-dir')
    expect(lc.catalogAgentNames()).toEqual(['real'])
  })
})

// ---------------------------------------------------------------------------
// readSkillDescription
// ---------------------------------------------------------------------------

describe('readSkillDescription', () => {
  it('extracts a description from a SKILL.md with YAML frontmatter', () => {
    const dir = makeSkill('a', 'with-fm', '---\ndescription: First line of the skill\n---\n# body')
    expect(lc.readSkillDescription(dir)).toBe('First line of the skill')
  })

  it('extracts a description from a SKILL.md with CRLF frontmatter', () => {
    const dir = makeSkill('a', 'with-crlf', '---\r\ndescription: crlf line\r\n---\r\nbody')
    expect(lc.readSkillDescription(dir)).toBe('crlf line')
  })

  it('falls back to the first 600 chars when no frontmatter block exists', () => {
    const body = 'no frontmatter here, just prose\nsecond line'
    const dir = makeSkill('a', 'no-fm', body)
    // No frontmatter -> block = md.slice(0, 600). The regex
    // /^description:\s*(.+)$/m must match a literal `description:` line in the
    // body. We assert the slice is returned verbatim otherwise (empty string
    // when no description line is present).
    const out = lc.readSkillDescription(dir)
    expect(typeof out).toBe('string')
    // No description: line present -> empty string after the fallback slice.
    expect(out).toBe('')
  })

  it('extracts a description from a body-only file (no frontmatter, but a description: line)', () => {
    // The fallback slice path: md has no `^---\r?\n...---` block, so block =
    // md.slice(0, 600); the regex finds a description line in the body.
    const body = 'description: extracted from body\n# header\nbody'
    const dir = makeSkill('a', 'body-desc', body)
    expect(lc.readSkillDescription(dir)).toBe('extracted from body')
  })

  it('strips a single layer of matching surrounding quotes from the description', () => {
    const dir = makeSkill('a', 'quoted', '---\ndescription: "double quoted"\n---')
    expect(lc.readSkillDescription(dir)).toBe('double quoted')
    const dir2 = makeSkill('a', 'quoted2', "---\ndescription: 'single quoted'\n---")
    expect(lc.readSkillDescription(dir2)).toBe('single quoted')
  })

  it('caps the description at 300 characters', () => {
    const longDesc = 'x'.repeat(1000)
    const dir = makeSkill('a', 'long', `---\ndescription: ${longDesc}\n---`)
    expect(lc.readSkillDescription(dir).length).toBe(300)
  })

  it('returns an empty string when SKILL.md is missing', () => {
    const dir = join(AGENTS_DIR, 'a', '.claude', 'skills', 'absent')
    mkdirSync(dir, { recursive: true })
    expect(lc.readSkillDescription(dir)).toBe('')
  })
})

// ---------------------------------------------------------------------------
// listAgentLocalSkills
// ---------------------------------------------------------------------------

describe('listAgentLocalSkills', () => {
  it('returns [] when the per-agent skills directory does not exist', () => {
    makeAgent('a')
    expect(lc.listAgentLocalSkills('a')).toEqual([])
  })

  it('returns {agent,name,description} entries for every skill sub-directory', () => {
    makeAgent('a')
    makeSkill('a', 'alpha', '---\ndescription: alpha desc\n---')
    makeSkill('a', 'bravo', '---\ndescription: bravo desc\n---')
    const out = lc.listAgentLocalSkills('a').sort((x, y) => x.name.localeCompare(y.name))
    expect(out).toEqual([
      { agent: 'a', name: 'alpha', description: 'alpha desc' },
      { agent: 'a', name: 'bravo', description: 'bravo desc' },
    ])
  })

  it('returns entries sorted by name regardless of directory creation order', () => {
    // The returned list is hashed by summarySourceHash to decide whether an
    // agent's LLM capability summary is stale, so its order must depend on the
    // content and not on the host filesystem. readdirSync returns sorted order
    // on macOS/APFS but hash order on ext4: without the explicit .sort() this
    // assertion passes on a dev Mac and fails on a Linux CI runner.
    //
    // Deliberately NO defensive .sort() on the result here -- that is exactly
    // what would hide the regression.
    makeAgent('a')
    for (const name of ['zulu', 'mike', 'alpha']) {
      makeSkill('a', name, `---\ndescription: ${name} desc\n---`)
    }
    expect(lc.listAgentLocalSkills('a').map((s) => s.name)).toEqual(['alpha', 'mike', 'zulu'])
  })

  it('skips stray files at the skills-root level (defensive statSync filter)', () => {
    makeAgent('a')
    makeSkill('a', 'real', '---\ndescription: r\n---')
    writeFileSync(join(AGENTS_DIR, 'a', '.claude', 'skills', 'README.md'), 'not a dir')
    const out = lc.listAgentLocalSkills('a')
    expect(out).toEqual([{ agent: 'a', name: 'real', description: 'r' }])
  })

  it('returns [] when readdirSync throws on the skills directory', () => {
    makeAgent('a')
    const skillsDir = join(AGENTS_DIR, 'a', '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    // Replace the directory with a regular file so readdirSync throws ENOTDIR.
    // The outer function guards with existsSync (true here), so the inner
    // readdirSync call is the one that must throw -- caught by the
    // try/catch wrapping readdirSync.
    rmSync(skillsDir, { recursive: true, force: true })
    writeFileSync(skillsDir, 'not a directory')
    expect(lc.listAgentLocalSkills('a')).toEqual([])
  })

  it('drops entries whose statSync throws (defensive filter catch)', () => {
    makeAgent('a')
    makeSkill('a', 'good', '---\ndescription: g\n---')
    makeSkill('a', 'broken', null)
    // Make the proxy-mocked statSync throw for anything inside the `broken`
    // skill dir, so the filter's inner try/catch takes its `return false`
    // branch and `broken` is excluded from the catalog.
    forceStatThrowFor = join(AGENTS_DIR, 'a', '.claude', 'skills', 'broken')
    try {
      const out = lc.listAgentLocalSkills('a')
      expect(out).toEqual([{ agent: 'a', name: 'good', description: 'g' }])
    } finally {
      forceStatThrowFor = null
    }
  })
})

// ---------------------------------------------------------------------------
// Sanity: ensure the redirected fixtures actually surface in the sandbox path.
// ---------------------------------------------------------------------------

describe('sandbox wiring', () => {
  it('AGENTS_BASE_DIR resolves inside the sandbox', () => {
    expect(agentConfig.AGENTS_BASE_DIR).toBe(AGENTS_DIR)
    expect(agentConfig.AGENTS_BASE_DIR.startsWith(SANDBOX)).toBe(true)
  })

  it('listAgentNames() reaches the sandbox agents/ directory', () => {
    makeAgent('zeta')
    expect(readdirSync(AGENTS_DIR)).toContain('zeta')
    expect(agentConfig.listAgentNames()).toContain('zeta')
    // Smoke-check the sandbox helpers we rely on throughout the suite.
    expect(typeof existsSync).toBe('function')
    expect(typeof readFileSync).toBe('function')
  })
})
