// Coverage suite for src/web/profiles.ts -- the security-profile registry.
//
// SANDBOXING NOTE (why this file mocks ../config.js instead of using
// CLAUDECLAW_ENV_DIR):
//
//   profiles.ts computes `PROFILES_DIR = join(PROJECT_ROOT, 'templates',
//   'profiles')` at MODULE SCOPE, where PROJECT_ROOT is the export from
//   src/config.ts -- which is `join(dirname(fileURLToPath(import.meta.url)),
//   '..')`, i.e. anchored to the file's own location on disk.
//
//   The `CLAUDECLAW_ENV_DIR` hook does NOT redirect it: that env var is read
//   by src/env.ts and only rebinds env.ts's OWN private PROJECT_ROOT (the one
//   used to locate `.env`). config.ts's exported PROJECT_ROOT ignores it
//   entirely. Setting CLAUDECLAW_ENV_DIR before a dynamic import would
//   therefore leave PROFILES_DIR pointing at the REAL `templates/profiles/`
//   of this checkout, and the suite would assert against the 7 shipped
//   profile fixtures instead of controlled ones.
//
//   So the sandbox seam here is `vi.mock('../config.js')` with a tmpdir
//   PROJECT_ROOT. The temp dir is still minted by the shared
//   `mkTempDir` helper, inside an async `vi.hoisted` block so it exists
//   before the hoisted mock factory runs.
//
// Because every filesystem read in profiles.ts happens at CALL time
// (`existsSync`/`readdirSync`/`readFileSync` live inside the functions, not at
// module scope), one module instance suffices: each test reshapes the
// directory underneath the frozen PROFILES_DIR constant.

import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

const { SANDBOX } = await vi.hoisted(async () => {
  // vi.mock factories are hoisted above the static imports, so the helper has
  // to be pulled in dynamically here rather than relying on the import above.
  const { mkTempDir: mk } = await import('./setup/temp-sandbox.js')
  return { SANDBOX: mk('marveen-profiles-') }
})

// profiles.ts consumes exactly one binding from config.ts (PROJECT_ROOT), so a
// one-key factory is a complete stand-in -- and it keeps config.ts's heavy
// import graph (cron-parser, channel-provider, .env reads) out of this suite.
vi.mock('../config.js', () => ({ PROJECT_ROOT: SANDBOX }))

const {
  PROFILES_DIR,
  HARDCODED_DEFAULT_PROFILE,
  listProfileTemplates,
  loadProfileTemplate,
  resolveProfilePlaceholders,
} = await import('../web/profiles.js')

/** Write a fixture into PROFILES_DIR. `body` is serialized when it is an
 *  object, or written verbatim when it is a string -- the string form is how
 *  the malformed-JSON branches get exercised. */
function writeProfile(filename: string, body: unknown): void {
  mkdirSync(PROFILES_DIR, { recursive: true })
  const content = typeof body === 'string' ? body : JSON.stringify(body)
  writeFileSync(join(PROFILES_DIR, filename), content, 'utf-8')
}

/** Remove PROFILES_DIR entirely (the `!existsSync` branch) or reset it to an
 *  empty-but-present directory. */
function resetProfilesDir(create: boolean): void {
  rmTempDir(PROFILES_DIR)
  if (create) mkdirSync(PROFILES_DIR, { recursive: true })
}

beforeEach(() => {
  resetProfilesDir(true)
})

afterAll(() => {
  rmTempDir(SANDBOX)
})

describe('PROFILES_DIR', () => {
  it('is templates/profiles under the config PROJECT_ROOT', () => {
    expect(PROFILES_DIR).toBe(join(SANDBOX, 'templates', 'profiles'))
  })

  it('is sandboxed to os.tmpdir(), never the live checkout', () => {
    // Guards the mock seam itself: if vi.mock('../config.js') ever stops
    // taking effect, PROFILES_DIR silently reverts to the real
    // templates/profiles/ and every assertion below would be testing the
    // shipped fixtures. Fail loudly here instead.
    expect(PROFILES_DIR.startsWith(SANDBOX)).toBe(true)
  })
})

describe('HARDCODED_DEFAULT_PROFILE', () => {
  it('is a permissive fallback whose id is "default"', () => {
    expect(HARDCODED_DEFAULT_PROFILE.id).toBe('default')
    expect(HARDCODED_DEFAULT_PROFILE.permissionMode).toBe('permissive')
    expect(HARDCODED_DEFAULT_PROFILE.label).toBe('Alapértelmezett')
    expect(HARDCODED_DEFAULT_PROFILE.description).toBe('Permissive fallback.')
  })

  it('denies the Supabase MCP wildcard and allows nothing explicitly', () => {
    // This is the last-resort profile used when templates/profiles/ is missing
    // entirely, so its deny list is the floor for a broken install.
    expect(HARDCODED_DEFAULT_PROFILE.filesystem.allow).toEqual([])
    expect(HARDCODED_DEFAULT_PROFILE.filesystem.deny).toEqual(['mcp__claude_ai_Supabase__*'])
  })
})

describe('listProfileTemplates', () => {
  it('falls back to the hardcoded default when PROFILES_DIR does not exist', () => {
    resetProfilesDir(false)
    expect(existsSync(PROFILES_DIR)).toBe(false)
    expect(listProfileTemplates()).toEqual([HARDCODED_DEFAULT_PROFILE])
  })

  it('falls back to the hardcoded default when the directory is empty', () => {
    // Directory present but yields zero entries -> the `out.length ? ... : ...`
    // ternary takes its falsy arm.
    expect(listProfileTemplates()).toEqual([HARDCODED_DEFAULT_PROFILE])
  })

  it('returns every well-formed .json profile in the directory', () => {
    writeProfile('alpha.json', {
      id: 'alpha',
      label: 'Alpha',
      description: 'first',
      permissionMode: 'strict',
      filesystem: { allow: ['Read(/a/**)'], deny: [] },
    })
    writeProfile('beta.json', {
      id: 'beta',
      label: 'Beta',
      description: 'second',
      permissionMode: 'permissive',
      filesystem: { allow: [], deny: ['Bash(sudo:*)'] },
    })

    const ids = listProfileTemplates().map((p) => p.id).sort()
    expect(ids).toEqual(['alpha', 'beta'])
  })

  it('preserves the full template shape, not just the id', () => {
    writeProfile('strictish.json', {
      id: 'strictish',
      label: 'Strict',
      description: 'locked down',
      permissionMode: 'strict',
      filesystem: { allow: ['Read(${AGENT_DIR}/**)'], deny: ['Bash(sudo:*)'] },
    })

    const [profile] = listProfileTemplates()
    expect(profile).toEqual({
      id: 'strictish',
      label: 'Strict',
      description: 'locked down',
      permissionMode: 'strict',
      filesystem: { allow: ['Read(${AGENT_DIR}/**)'], deny: ['Bash(sudo:*)'] },
    })
  })

  it('skips entries whose filename does not end in .json', () => {
    writeProfile('real.json', { id: 'real' })
    writeProfile('notes.txt', 'id: not-a-profile')
    writeProfile('archive.json.bak', JSON.stringify({ id: 'stale' }))
    writeProfile('json', JSON.stringify({ id: 'extensionless' }))

    expect(listProfileTemplates().map((p) => p.id)).toEqual(['real'])
  })

  it('skips malformed JSON instead of throwing', () => {
    writeProfile('good.json', { id: 'good' })
    writeProfile('truncated.json', '{ "id": "truncated"')
    writeProfile('garbage.json', 'not json at all')
    writeProfile('empty.json', '')

    expect(() => listProfileTemplates()).not.toThrow()
    expect(listProfileTemplates().map((p) => p.id)).toEqual(['good'])
  })

  it('skips a JSON literal `null` (property access inside the try throws)', () => {
    // JSON.parse('null') succeeds, so the guard that rejects this is the
    // `p.id` read throwing TypeError inside the same try block.
    writeProfile('null.json', 'null')
    writeProfile('kept.json', { id: 'kept' })

    expect(listProfileTemplates().map((p) => p.id)).toEqual(['kept'])
  })

  it('skips well-formed JSON objects that carry no id', () => {
    writeProfile('noid.json', { label: 'orphan', description: 'has no id' })
    writeProfile('emptyid.json', { id: '' })
    writeProfile('kept.json', { id: 'kept' })

    expect(listProfileTemplates().map((p) => p.id)).toEqual(['kept'])
  })

  it('falls back to the hardcoded default when every candidate is rejected', () => {
    // Directory is non-empty, but nothing survives the filters -> out stays
    // empty and the fallback fires.
    writeProfile('bad.json', '{{{')
    writeProfile('noid.json', { label: 'orphan' })
    writeProfile('readme.md', '# not a profile')

    expect(listProfileTemplates()).toEqual([HARDCODED_DEFAULT_PROFILE])
  })
})

describe('loadProfileTemplate', () => {
  it('loads <id>.json when it exists and parses', () => {
    writeProfile('researcher.json', {
      id: 'researcher',
      label: 'Kutató',
      description: 'read-mostly',
      permissionMode: 'strict',
      filesystem: { allow: ['Read(${HOME}/**)'], deny: [] },
    })

    const profile = loadProfileTemplate('researcher')
    expect(profile.id).toBe('researcher')
    expect(profile.permissionMode).toBe('strict')
    expect(profile.filesystem.allow).toEqual(['Read(${HOME}/**)'])
  })

  it('falls back to default.json when the requested id has no file', () => {
    writeProfile('default.json', {
      id: 'default',
      label: 'On-disk default',
      description: 'from templates/profiles',
      permissionMode: 'permissive',
      filesystem: { allow: [], deny: [] },
    })

    const profile = loadProfileTemplate('does-not-exist')
    expect(profile.id).toBe('default')
    expect(profile.label).toBe('On-disk default')
  })

  it('falls back to default.json when the requested file is malformed', () => {
    writeProfile('broken.json', '{ oops')
    writeProfile('default.json', {
      id: 'default',
      label: 'On-disk default',
      description: 'from templates/profiles',
      permissionMode: 'permissive',
      filesystem: { allow: [], deny: [] },
    })

    expect(loadProfileTemplate('broken').id).toBe('default')
    expect(loadProfileTemplate('broken').label).toBe('On-disk default')
  })

  it('returns the hardcoded default when default.json is absent (no infinite recursion)', () => {
    // 'missing' -> not found -> recurse('default') -> not found -> id ===
    // 'default' so the recursion terminates at the hardcoded constant.
    expect(loadProfileTemplate('missing')).toEqual(HARDCODED_DEFAULT_PROFILE)
  })

  it('returns the hardcoded default when default.json itself is malformed', () => {
    // The `id === 'default'` path where the file EXISTS but the try block
    // falls through -- this reaches the final return, not the recursion.
    writeProfile('default.json', 'this is not json')
    expect(loadProfileTemplate('default')).toEqual(HARDCODED_DEFAULT_PROFILE)
  })

  it('returns the hardcoded default when PROFILES_DIR does not exist at all', () => {
    resetProfilesDir(false)
    expect(loadProfileTemplate('anything')).toEqual(HARDCODED_DEFAULT_PROFILE)
    expect(loadProfileTemplate('default')).toEqual(HARDCODED_DEFAULT_PROFILE)
  })

  it('prefers on-disk default.json over the hardcoded constant', () => {
    writeProfile('default.json', {
      id: 'default',
      label: 'Disk wins',
      description: 'operator edited',
      permissionMode: 'strict',
      filesystem: { allow: [], deny: ['Bash(sudo:*)'] },
    })

    const profile = loadProfileTemplate('default')
    expect(profile.label).toBe('Disk wins')
    expect(profile.permissionMode).toBe('strict')
  })

  // --- profiles-traversal-id --------------------------------------------
  // `loadProfileTemplate` rejects any id whose characters fall outside
  // [a-z0-9-] before touching the filesystem, so a traversal like
  // "../../outside" can never escape PROFILES_DIR.
  it('rejects traversal ids and falls back to the on-disk default', () => {
    writeProfile('default.json', {
      id: 'default',
      label: 'On-disk default',
      description: 'd',
      permissionMode: 'permissive',
      filesystem: { allow: [], deny: [] },
    })
    // Plant a file two levels up -- i.e. outside templates/profiles/.
    writeFileSync(
      join(SANDBOX, 'outside.json'),
      JSON.stringify({
        id: 'outside',
        label: 'ESCAPED',
        description: 'not a profile',
        permissionMode: 'permissive',
        filesystem: { allow: [], deny: [] },
      }),
      'utf-8',
    )

    const escaped = loadProfileTemplate('../../outside')
    // Allowlist regex short-circuits before any filesystem read, so the
    // planted outside.json is unreachable and the recursion falls back to
    // the on-disk default.
    expect(escaped.label).toBe('On-disk default')
    expect(escaped.id).toBe('default')
  })

  it('rejects ids containing characters outside [a-z0-9-]', () => {
    writeProfile('default.json', {
      id: 'default',
      label: 'On-disk default',
      description: 'd',
      permissionMode: 'permissive',
      filesystem: { allow: [], deny: [] },
    })
    expect(loadProfileTemplate('../package.json').id).toBe('default')
    expect(loadProfileTemplate('foo/bar').id).toBe('default')
    expect(loadProfileTemplate('foo bar').id).toBe('default')
    expect(loadProfileTemplate('').id).toBe('default')
    expect(loadProfileTemplate('sub_dev').id).toBe('default')
  })

  it('accepts ids with hyphens and digits (matches every shipped profile)', () => {
    writeProfile('developer-junior.json', {
      id: 'developer-junior',
      label: 'Junior',
      description: 'd',
      permissionMode: 'strict',
      filesystem: { allow: [], deny: [] },
    })
    expect(loadProfileTemplate('developer-junior').id).toBe('developer-junior')
    expect(loadProfileTemplate('sub-dev').id).toBe('default')
  })
})

describe('resolveProfilePlaceholders', () => {
  const ctx = { HOME: '/Users/tester', AGENT_DIR: '/agents/scout' }

  it('substitutes ${HOME}', () => {
    expect(resolveProfilePlaceholders('Read(${HOME}/.ssh/**)', ctx)).toBe(
      'Read(/Users/tester/.ssh/**)',
    )
  })

  it('substitutes ${AGENT_DIR}', () => {
    expect(resolveProfilePlaceholders('Read(${AGENT_DIR}/**)', ctx)).toBe(
      'Read(/agents/scout/**)',
    )
  })

  it('substitutes ${WORKDIR} with AGENT_DIR (documented alias)', () => {
    expect(resolveProfilePlaceholders('Bash(cd ${WORKDIR})', ctx)).toBe(
      'Bash(cd /agents/scout)',
    )
  })

  it('replaces every occurrence, not just the first (global flags)', () => {
    expect(
      resolveProfilePlaceholders('${HOME}:${HOME}|${AGENT_DIR}:${AGENT_DIR}|${WORKDIR}:${WORKDIR}', ctx),
    ).toBe(
      '/Users/tester:/Users/tester|/agents/scout:/agents/scout|/agents/scout:/agents/scout',
    )
  })

  it('handles all three placeholders in one value', () => {
    expect(resolveProfilePlaceholders('${HOME}+${AGENT_DIR}+${WORKDIR}', ctx)).toBe(
      '/Users/tester+/agents/scout+/agents/scout',
    )
  })

  it('returns the value unchanged when it holds no placeholder', () => {
    expect(resolveProfilePlaceholders('Bash(sudo:*)', ctx)).toBe('Bash(sudo:*)')
  })

  it('returns an empty string unchanged', () => {
    expect(resolveProfilePlaceholders('', ctx)).toBe('')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(resolveProfilePlaceholders('${STORE_DIR}/x', ctx)).toBe('${STORE_DIR}/x')
  })

  it('is case-sensitive (${home} is not a placeholder)', () => {
    expect(resolveProfilePlaceholders('${home}', ctx)).toBe('${home}')
  })

  it('accepts empty context values', () => {
    expect(resolveProfilePlaceholders('${HOME}/x', { HOME: '', AGENT_DIR: '' })).toBe('/x')
  })

  // --- regression coverage: profiles-replace-dollar-pattern ----------------
  // A replacer-fn form passes the matched group back to JavaScript verbatim,
  // so `$&`, `` $` ``, `$'` and `$n` in ctx values are now treated as
  // literal text. See profiles-replace-dollar-pattern.
  it('treats `$&` in a context value as literal text', () => {
    const out = resolveProfilePlaceholders('${HOME}/x', {
      HOME: '/home/a$&b',
      AGENT_DIR: '/agents/scout',
    })
    expect(out).toBe('/home/a$&b/x')
  })

  it('treats a backtick pattern in a context value as literal text', () => {
    const out = resolveProfilePlaceholders('${AGENT_DIR}/x', {
      HOME: '/Users/tester',
      AGENT_DIR: '/a$`z',
    })
    expect(out).toBe('/a$`z/x')
  })
})
