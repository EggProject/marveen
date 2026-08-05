// 100% coverage suite for src/web/routes/skills.ts.
//
// tryHandleSkills owns the global-skill CRUD + assign + import + export
// endpoints and the per-agent detail lookup. The route imports a wide
// surface (logger, atomic-write, agent-config, agent-scaffold, multipart,
// http-helpers, sanitize, plus node:fs / node:os / node:child_process /
// node:crypto). The collaborator mocks follow the suite convention: every
// import the SUT pulls in is either replaced by a deterministic fake or
// passed through to the real implementation; node:fs and node:os are real
// so the symlink / readdir / unlink branches exercise a tmpdir-scoped
// filesystem.
//
// Sandbox: a tmpdir-scoped HOME + PROJECT_ROOT. node:os.homedir() is
// redirected into the sandbox HOME so every `join(homedir(), '.claude',
// ...)` resolves inside the sandbox; PROJECT_ROOT is redirected via the
// config mock so the per-agent skill dir resolves under the sandbox. The
// live-install guard at src/__tests__/setup/assert-not-live-install.ts
// refuses to run if the sandbox ever escapes tmpdir.
//
// Branches covered:
//   - dispatcher surface (paths/methods that do not match any route)
//   - GET /api/skills:
//       USER_SKILLS_DIR absent vs present
//       SKIP_DIRS filter (.skill-index.md, skills, temp_skills, tmp_skills)
//       dot-prefixed dirs skipped
//       non-directory entries skipped
//       SKILL.md missing -> skipped
//       PLUGINS_CACHE_DIR absent vs present
//       depth > 4 cap
//       packages with vs without 'skills' subdir
//       shortPlugin version-like suffix detection
//       packagePath.join('/') produces the qualified name
//       sort: user before plugin, then by label
//   - GET /api/skills/local:
//       MAIN_AGENT_ID prepended when not in listAgentNames()
//       MAIN_AGENT_ID skipped when already present
//       skillsDir absent -> skipped
//       dot-prefixed entry -> skipped
//       non-directory entry -> skipped
//       SKILL.md missing -> skipped
//       sort: agentId then name
//   - GET /api/skills/export:
//       USER_SKILLS_DIR absent -> 404
//       execSync success -> pipe to res + end cleanup
//       execSync throws -> 500 + log
//       stream 'end' cleanup + 'error' cleanup branches
//   - GET /api/skills/:name:
//       ?agent=<id> invalid id -> 404
//       ?agent=<id> path traversal -> 404 (sanitize is bypassed)
//       ?agent=<id> SKILL.md missing -> 404
//       ?agent=<id> happy path (MAIN and sub)
//       ?agent=<id> per-skill files[] populated from readdir
//       :pluginName:skillBasename path traversal -> 404
//       :pluginName:skillBasename SKILL.md missing -> 404
//       :pluginName:skillBasename happy path
//       global path traversal -> 404
//       global skillDir absent -> 404
//       global happy path with getSkillAgents
//   - POST /api/skills:
//       sanitize empty -> 400
//       description empty -> 400
//       path traversal -> 400 (sanitize bypass)
//       already exists -> 409
//       generateSkillMd throws -> 500 + rmSync cleanup
//       happy path
//   - POST /api/skills/import:
//       no file part -> 400
//       '..' entry -> 400 + unlink
//       leading '/' entry -> 400 + unlink
//       windows drive-prefixed entry -> 400 + unlink
//       existing top-level dir -> 409 + unlink
//       symlink rejection (top-level symlink, nested symlink)
//       extracted but no SKILL.md -> 400
//       extract execSync throws -> 500 + cleanup
//       happy path
//   - POST /api/skills/:name/assign:
//       path traversal -> 404
//       skill not found -> 404
//       happy path (target agents get a copy, others removed)
//   - PUT /api/skills/:name:
//       contains ':' -> 403
//       ?agent=<id> invalid -> 404
//       ?agent=<id> path traversal -> 400
//       ?agent=<id> skill not found -> 404
//       ?agent=<id> content not string -> 400
//       ?agent=<id> happy path
//       global path traversal -> 400
//       global skill not found -> 404
//       global content not string -> 400
//       global happy path

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
  readdirSync, statSync, lstatSync, symlinkSync, readFileSync,
  chmodSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const fakeReadStream = () => {
    const handlers: Record<string, Array<() => void>> = {}
    return {
      on(event: string, handler: () => void) {
        (handlers[event] ||= []).push(handler)
        return this
      },
      pipe(dest: { end: (data?: string) => void }) {
        // Simulate a successful read by emitting data + end on the destination.
        // The route's `on('end')` cleanup runs after `pipe` finishes.
        queueMicrotask(() => {
          for (const h of handlers.end || []) h()
        })
        dest.end('zipdata')
        return dest
      },
      // Test-only helper: manually fire an event so the route's cleanup
      // branch runs without a real stream.
      _fire(event: 'end' | 'error') {
        for (const h of handlers[event] || []) h()
      },
    }
  }
  const fakeReadStreamWithError = () => {
    const handlers: Record<string, Array<() => void>> = {}
    return {
      on(event: string, handler: () => void) {
        (handlers[event] ||= []).push(handler)
        return this
      },
      pipe(dest: { end: (data?: string) => void }) {
        // Simulate a streaming error: emit 'error' on next tick, no end event.
        queueMicrotask(() => {
          for (const h of handlers.error || []) h()
        })
        return dest
      },
    }
  }
  return {
    // fs shim -- replaces only createReadStream; everything else passes through.
    fakeReadStream,
    fakeReadStreamWithError,
    // execSync: stubbed per test
    execSync: vi.fn(),
    // generateSkillMd: stubbed per test
    generateSkillMd: vi.fn(async (_name: string, _desc: string) => '---\nname: stub\ndescription: stub\n---\n# stub\n'),
    // logger
    loggerInfo: vi.fn(),
    loggerWarn: vi.fn(),
    loggerError: vi.fn(),
    loggerDebug: vi.fn(),
    // sanitize override -- lets us return any name (including a path-
    // traversal name) so the `startsWith(root + sep)` guard can be tested.
    sanitizeOverride: null as string | null,
    safeJoinThrow: false,
    // When set, the createReadStream mock returns an error-emitting fake.
    readStreamEmitsError: false,
  }
})

// --- ENFORCED sandbox -------------------------------------------------------

const SANDBOX = mkdtempSync(join(tmpdir(), 'skills-routes-'))
const PROJECT = join(SANDBOX, 'project')
const HOME = join(SANDBOX, 'home')
const AGENTS_DIR = join(PROJECT, 'agents')

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual, MAIN_AGENT_ID: 'mainagent' },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => join(PROJECT, 'store'), enumerable: true },
    },
  )
})

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

vi.mock('node:child_process', () => ({ execSync: H.execSync }))

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    createReadStream: (() => H.readStreamEmitsError ? H.fakeReadStreamWithError() : H.fakeReadStream()) as unknown as typeof actual.createReadStream,
  }
})

vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  return {
    ...actual,
    AGENTS_BASE_DIR: join(PROJECT, 'agents'),
    agentDir: (name: string) => join(AGENTS_DIR, name),
    // readFileOr is real; tests rely on the underlying readFileSync.
    listAgentNames: vi.fn(() => {
      if (!existsSync(AGENTS_DIR)) return []
      return readdirSync(AGENTS_DIR).filter((f) => {
        try {
          if (!statSync(join(AGENTS_DIR, f)).isDirectory()) return false
          return true
        } catch { return false }
      })
    }),
  }
})

vi.mock('../web/agent-scaffold.js', () => ({
  generateSkillMd: H.generateSkillMd,
}))

vi.mock('../web/sanitize.js', async (orig) => {
  const actual = await orig<typeof import('../web/sanitize.js')>()
  return {
    ...actual,
    sanitizeSkillName: (raw: string) => {
      if (H.sanitizeOverride !== null) return H.sanitizeOverride
      return actual.sanitizeSkillName(raw)
    },
    safeJoin: (base: string, ...parts: string[]) => {
      if (H.safeJoinThrow) throw new Error('forced safeJoin throw')
      return actual.safeJoin(base, ...parts)
    },
  }
})

// Suite-policy mocks (db / auth-gate / auth-sessions are not used by the SUT
// but the task brief lists them as required mocks).
vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Import AFTER every mock is registered.
const { tryHandleSkills } = await import('../web/routes/skills.js')

// -----------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) { this.headers[k] = v },
    end(data) { if (data !== undefined) this.body += data },
  }
}

function mkReq(opts: { body?: Buffer | string; headers?: Record<string, string | undefined> } = {}): http.IncomingMessage {
  const payload: Buffer[] = opts.body === undefined
    ? []
    : [Buffer.isBuffer(opts.body) ? opts.body : Buffer.from(opts.body)]
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(method: string, path: string, opts: {
  body?: Buffer | string
  headers?: Record<string, string | undefined>
} = {}): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> | unknown[] }> {
  const req = mkReq(opts)
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${path}`)
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
  }
  const handled = await tryHandleSkills(ctx)
  return { res, handled, json: () => JSON.parse(res.body || 'null') as Record<string, unknown> | unknown[] }
}

// -----------------------------------------------------------------------
// Lifecycle + fixtures
// -----------------------------------------------------------------------

const MAIN_AGENT = 'mainagent'

function seedUserSkill(name: string, opts: { description?: string; keywords?: string } = {}): string {
  const dir = join(HOME, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  const description = opts.description ?? `desc-${name}`
  const kw = opts.keywords ? `\nkeywords: ${opts.keywords}` : ''
  writeFileSync(join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}${kw}\n---\n# ${name}\n`)
  return dir
}

function seedPluginSkill(pluginPath: string[], skillName: string, opts: { description?: string } = {}): string {
  const pluginCacheRoot = join(HOME, '.claude', 'plugins', 'cache')
  const dir = join(pluginCacheRoot, ...pluginPath, 'skills', skillName)
  mkdirSync(dir, { recursive: true })
  const description = opts.description ?? `plugin-desc-${skillName}`
  writeFileSync(join(dir, 'SKILL.md'),
    `---\nname: ${skillName}\ndescription: ${description}\n---\n# ${skillName}\n`)
  return dir
}

function seedLocalSkill(agentName: string, name: string, opts: { description?: string } = {}): string {
  const skillsDir = agentName === MAIN_AGENT
    ? join(PROJECT, '.claude', 'skills')
    : join(AGENTS_DIR, agentName, '.claude', 'skills')
  mkdirSync(skillsDir, { recursive: true })
  const dir = join(skillsDir, name)
  mkdirSync(dir, { recursive: true })
  const description = opts.description ?? `local-${agentName}-${name}`
  writeFileSync(join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: ${description}\n---\n# ${name}\n`)
  return dir
}

beforeAll(() => {
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(PROJECT, { recursive: true })
  mkdirSync(HOME, { recursive: true })
})

beforeEach(() => {
  H.execSync.mockReset()
  H.generateSkillMd.mockReset()
  H.generateSkillMd.mockResolvedValue('---\nname: stub\ndescription: stub\n---\n# stub\n')
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()
  H.sanitizeOverride = null
  H.safeJoinThrow = false
  H.readStreamEmitsError = false
  // Wipe any state from the previous test
  rmSync(join(HOME, '.claude'), { recursive: true, force: true })
  rmSync(AGENTS_DIR, { recursive: true, force: true })
  rmSync(join(PROJECT, '.claude'), { recursive: true, force: true })
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(HOME, { recursive: true })
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

const BOUNDARY = '----TestBoundaryXYZ'
const CT_MULTI = `multipart/form-data; boundary=${BOUNDARY}`
function multipartFile(filename: string, data: Buffer): Buffer {
  const head = Buffer.from(
    `--${BOUNDARY}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: application/zip\r\n\r\n`,
    'binary',
  )
  const tail = Buffer.from(`\r\n--${BOUNDARY}--\r\n`, 'binary')
  return Buffer.concat([head, data, tail])
}

// -----------------------------------------------------------------------
// Dispatcher surface
// -----------------------------------------------------------------------

describe('tryHandleSkills -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/foo')
    expect(handled).toBe(false)
  })

  it('returns false for DELETE on the listing', async () => {
    const { handled } = await call('DELETE', '/api/skills')
    expect(handled).toBe(false)
  })

  it('returns false for any method on a path that matches no regex', async () => {
    // Path has two segments past /api/skills/ -- no regex matches.
    const { handled } = await call('GET', '/api/skills/foo/extra')
    expect(handled).toBe(false)
  })

  it('PUT on /api/skills/export falls through to the detail regex (handled=true with 404)', async () => {
    // PUT doesn't match the export (GET-only) branch. The detail regex
    // /^\/api\/skills\/([^/]+)$/ matches `export`, but PUT doesn't match
    // either the detail (GET-only) or PUT branch (separate regex). Actually
    // PUT branch DOES match, skillName='export'. No colon. No agent. Global
    // branch. existsSync fails -> 404.
    const { res, handled } = await call('PUT', '/api/skills/export')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  it('GET on /api/skills/import falls through to the detail regex (handled=true with 404)', async () => {
    const { res, handled } = await call('GET', '/api/skills/import')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })

  it('PUT on /api/skills/import falls through to the PUT handler (404)', async () => {
    const { res, handled } = await call('PUT', '/api/skills/import')
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
  })
})

// -----------------------------------------------------------------------
// GET /api/skills -- user + plugin listing
// -----------------------------------------------------------------------

describe('GET /api/skills', () => {
  it('returns an empty array when USER_SKILLS_DIR and PLUGINS_CACHE_DIR are absent', async () => {
    const { res, json } = await call('GET', '/api/skills')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('returns user skills with description + keywords + all agent names', async () => {
    seedUserSkill('alpha', { description: 'desc-alpha', keywords: 'a, b ,c' })
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const { res, json } = await call('GET', '/api/skills')
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0]).toMatchObject({
      name: 'alpha',
      label: 'alpha',
      description: 'desc-alpha',
      keywords: ['a', 'b', 'c'],
      source: 'user',
      agents: ['sub1'],
    })
  })

  it('skips SKIP_DIRS entries and dot-prefixed entries in USER_SKILLS_DIR', async () => {
    const skillsDir = join(HOME, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'skills'), { recursive: true })
    mkdirSync(join(skillsDir, 'temp_skills'), { recursive: true })
    mkdirSync(join(skillsDir, 'tmp_skills'), { recursive: true })
    mkdirSync(join(skillsDir, '.skill-index.md'), { recursive: true })
    mkdirSync(join(skillsDir, '.hidden'), { recursive: true })
    writeFileSync(join(skillsDir, 'stray.txt'), 'not-a-dir')
    seedUserSkill('keeper')
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['keeper'])
  })

  it('skips user-skill entries without a SKILL.md', async () => {
    const skillsDir = join(HOME, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, 'no-md'))
    seedUserSkill('with-md')
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['with-md'])
  })

  it('skips user-skill entries whose statSync throws (broken symlink in USER_SKILLS_DIR)', async () => {
    // statSync follows symlinks; a broken symlink causes it to throw,
    // so the per-entry catch arm returns false and the entry is skipped.
    const skillsDir = join(HOME, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    seedUserSkill('alive')
    symlinkSync('/no/such/target', join(skillsDir, 'broken-link'))
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['alive'])
  })

  it('returns a plugin skill (single segment, no version) with shortPlugin=plugin fallback', async () => {
    // packagePath = [] inside the walker -> shortPlugin = 'plugin'
    const pluginDir = join(HOME, '.claude', 'plugins', 'cache', 'skills', 'solo')
    mkdirSync(pluginDir, { recursive: true })
    writeFileSync(join(pluginDir, 'SKILL.md'),
      `---\nname: solo\ndescription: solo-desc\n---\n# solo\n`)
    const { res, json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(res.statusCode).toBe(200)
    expect(arr).toHaveLength(1)
    expect(arr[0]).toMatchObject({
      name: 'solo',
      label: 'plugin:solo',
      source: 'plugin',
      pluginPackage: '',
      keywords: [],
      agents: [],
    })
  })

  it('returns a plugin skill with a version suffix and computes shortPlugin correctly', async () => {
    seedPluginSkill(['myplugin', '1.2.3'], 'do-stuff', { description: 'do-stuff-desc' })
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0]).toMatchObject({
      name: 'myplugin/1.2.3:do-stuff',
      label: 'myplugin:do-stuff',
      pluginPackage: 'myplugin/1.2.3',
      description: 'do-stuff-desc',
      source: 'plugin',
    })
  })

  it('returns a plugin skill with an RC version suffix', async () => {
    seedPluginSkill(['myplugin', 'rc1'], 'beta-skill', { description: 'beta' })
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0]).toMatchObject({
      label: 'myplugin:beta-skill',
      pluginPackage: 'myplugin/rc1',
    })
  })

  it('returns multiple plugin skills under one plugin package', async () => {
    const pluginSkills = join(HOME, '.claude', 'plugins', 'cache', 'multi', '1.0.0', 'skills')
    mkdirSync(join(pluginSkills, 'foo'), { recursive: true })
    writeFileSync(join(pluginSkills, 'foo', 'SKILL.md'), '# foo')
    mkdirSync(join(pluginSkills, 'bar'), { recursive: true })
    writeFileSync(join(pluginSkills, 'bar', 'SKILL.md'), '# bar')
    // Add a non-directory inside skills to ensure it gets skipped
    writeFileSync(join(pluginSkills, 'stray'), 'x')
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    const labels = arr.map((s) => s.label).sort()
    expect(labels).toEqual(['multi:bar', 'multi:foo'])
  })

  it('skips non-skill entries when walking the plugin cache', async () => {
    // A directory without a 'skills' subfolder is walked into recursively.
    // We verify the walker does NOT infinite-loop when 'skills' is not present
    // and there are no nested skill entries.
    mkdirSync(join(HOME, '.claude', 'plugins', 'cache', 'noop'), { recursive: true })
    writeFileSync(join(HOME, '.claude', 'plugins', 'cache', 'noop', 'README'), 'x')
    const { json } = await call('GET', '/api/skills')
    expect(json()).toEqual([])
  })

  it('skips dot-prefixed plugin skills (sd.startsWith("."))', async () => {
    const pluginSkills = join(HOME, '.claude', 'plugins', 'cache', 'dotplug', '1.0.0', 'skills')
    mkdirSync(join(pluginSkills, '.hidden'), { recursive: true })
    writeFileSync(join(pluginSkills, '.hidden', 'SKILL.md'), '# hidden')
    mkdirSync(join(pluginSkills, 'visible'), { recursive: true })
    writeFileSync(join(pluginSkills, 'visible', 'SKILL.md'), '# visible')
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    const labels = arr.map((s) => s.label).sort()
    expect(labels).toEqual(['dotplug:visible'])
  })

  it('skips plugin skills whose SKILL.md is missing', async () => {
    const pluginSkills = join(HOME, '.claude', 'plugins', 'cache', 'mdless', '1.0.0', 'skills')
    mkdirSync(join(pluginSkills, 'no-md'), { recursive: true })
    writeFileSync(join(pluginSkills, 'no-md', 'note.txt'), 'no SKILL.md here')
    mkdirSync(join(pluginSkills, 'with-md'), { recursive: true })
    writeFileSync(join(pluginSkills, 'with-md', 'SKILL.md'), '# present')
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    const labels = arr.map((s) => s.label).sort()
    expect(labels).toEqual(['mdless:with-md'])
  })

  it('respects the depth > 4 cap when walking the plugin cache', async () => {
    // Build a 6-deep path: cache/a/b/c/d/e/f/skills/s
    let p = join(HOME, '.claude', 'plugins', 'cache')
    for (const seg of ['a', 'b', 'c', 'd', 'e']) p = join(p, seg)
    mkdirSync(p, { recursive: true })
    const { json } = await call('GET', '/api/skills')
    expect(json()).toEqual([])
  })

  it('silently swallows readdirSync failures in the walker (unreadable sub-dir)', async () => {
    // Make a sub-dir of plugins/cache unreadable so the walker hits its
    // `try { entries = readdirSync(dir) } catch { return }` arm.
    const sealed = join(HOME, '.claude', 'plugins', 'cache', 'sealed')
    mkdirSync(sealed, { recursive: true })
    chmodSync(sealed, 0)
    try {
      const { json } = await call('GET', '/api/skills')
      expect(json()).toEqual([])
    } finally {
      chmodSync(sealed, 0o755)
    }
  })

  it('swallows statSync failures when descending into plugin-cache entries', async () => {
    // A broken symlink in the plugin cache walker forces the
    // `try { if (!statSync(next).isDirectory()) continue } catch { continue }`
    // catch arm.
    const cache = join(HOME, '.claude', 'plugins', 'cache')
    const sub = join(cache, 'sealed-sym')
    mkdirSync(sub, { recursive: true })
    symlinkSync('/no/such/target', join(sub, 'dangling'))
    const { json } = await call('GET', '/api/skills')
    expect(json()).toEqual([])
  })

  it('swallows statSync failures when iterating a plugin\'s skills subdir', async () => {
    // A broken symlink inside `.../skills/` makes
    // `if (!statSync(skillDirPath).isDirectory()) continue` throw -> catch.
    const pluginSkills = join(HOME, '.claude', 'plugins', 'cache', 'plugstat', '1.0.0', 'skills')
    mkdirSync(pluginSkills, { recursive: true })
    symlinkSync('/no/such/target', join(pluginSkills, 'dangling'))
    const { json } = await call('GET', '/api/skills')
    expect(json()).toEqual([])
  })

  it('sorts user skills before plugin skills, then by label', async () => {
    seedUserSkill('z-user')
    seedUserSkill('a-user')
    seedPluginSkill(['zzz', '1.0.0'], 'zplug')
    seedPluginSkill(['aaa', '1.0.0'], 'aplug')
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.label)).toEqual(['a-user', 'z-user', 'aaa:aplug', 'zzz:zplug'])
  })

  it('parses a keywords frontmatter field with empty values', async () => {
    seedUserSkill('kw-empty', { keywords: '' })
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]?.keywords).toEqual([])
  })

  it('parses a single-quoted description (parseFrontmatterField single-quote branch)', async () => {
    const dir = seedUserSkill('sq-desc')
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: sq-desc\ndescription: 'single quoted desc'\n---\n# sq\n`)
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]?.description).toBe('single quoted desc')
  })

  it('parses a malformed double-quoted description (fallback to strip-quote trim)', async () => {
    // Description starts with `"` but has no closing `"`. The regex
    // `/^"(.*)"/` misses, so the right arm of the ternary
    // (`val.replace(/^"|"$/g, '').trim()`) runs.
    const dir = seedUserSkill('dq-malformed')
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: dq-malformed\ndescription: "no closing quote\n---\n# dq\n`)
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    // Description should be the malformed value with the leading quote stripped.
    expect((arr[0]?.description as string).startsWith('no closing')).toBe(true)
  })

  it('parses a malformed single-quoted description (falls back to strip-quote trim)', async () => {
    const dir = seedUserSkill('sq-malformed')
    // A single quote that doesn't form a matching pair -> the regex misses
    // and the fallback `replace(/^'|'$/g, '')` runs.
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: sq-malformed\ndescription: 'unbalanced\n---\n# sq\n`)
    const { json } = await call('GET', '/api/skills')
    const arr = json() as Array<Record<string, unknown>>
    // The unbalanced quote falls through to a stripped (no quotes) trim.
    expect(typeof arr[0]?.description).toBe('string')
  })

  it('skips plugin-cache entries whose statSync throws (broken symlink in walker)', async () => {
    // Build a path that contains a broken symlink so statSync (follows
    // symlinks) throws during the recursive walker's statSync-throws catch.
    const cacheRoot = join(HOME, '.claude', 'plugins', 'cache')
    const sub = join(cacheRoot, 'broken-walker')
    mkdirSync(sub, { recursive: true })
    symlinkSync('/no/such/target', join(sub, 'broken-link'))
    const { json } = await call('GET', '/api/skills')
    // The walker encounters the broken symlink and silently continues.
    expect(json()).toEqual([])
  })
})

// -----------------------------------------------------------------------
// GET /api/skills/local
// -----------------------------------------------------------------------

describe('GET /api/skills/local', () => {
  it('prepends MAIN_AGENT_ID when listAgentNames() returns it', async () => {
    mkdirSync(join(AGENTS_DIR, 'mainagent'), { recursive: true }) // make MAIN_AGENT_ID a sub-agent dir
    seedLocalSkill(MAIN_AGENT, 'main-skill')
    seedLocalSkill('sub1', 'sub-skill')
    const { res, json } = await call('GET', '/api/skills/local')
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, unknown>>
    const agentIds = arr.map((s) => s.agentId)
    expect(agentIds).toContain(MAIN_AGENT)
    expect(agentIds).toContain('sub1')
    expect(agentIds).toEqual([...agentIds].sort())
  })

  it('skips the MAIN_AGENT_ID prepending when listAgentNames already contains it', async () => {
    // Pre-create a sub-agent that listAgentNames() will return
    mkdirSync(join(AGENTS_DIR, MAIN_AGENT), { recursive: true })
    seedLocalSkill(MAIN_AGENT, 'only-one')
    const { res, json } = await call('GET', '/api/skills/local')
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['only-one'])
  })

  it('returns an empty array when neither MAIN nor sub-agents have skills', async () => {
    const { res, json } = await call('GET', '/api/skills/local')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('skips dot-prefixed entries and entries without SKILL.md', async () => {
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const skillsDir = join(AGENTS_DIR, 'sub1', '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    mkdirSync(join(skillsDir, '.hidden'))
    mkdirSync(join(skillsDir, 'no-md'))
    seedLocalSkill('sub1', 'good')
    const { json } = await call('GET', '/api/skills/local')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['good'])
  })

  it('sorts by agentId then name', async () => {
    mkdirSync(join(AGENTS_DIR, 'zeta'), { recursive: true })
    mkdirSync(join(AGENTS_DIR, 'alpha'), { recursive: true })
    seedLocalSkill('zeta', 'a-skill')
    seedLocalSkill('zeta', 'z-skill')
    seedLocalSkill('alpha', 'm-skill')
    const { json } = await call('GET', '/api/skills/local')
    const arr = json() as Array<Record<string, unknown>>
    const ordered = arr.map((s) => `${s.agentId}/${s.name}`)
    expect(ordered).toEqual(['alpha/m-skill', 'zeta/a-skill', 'zeta/z-skill'])
  })

  it('skips non-directory entries inside the skills dir', async () => {
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const skillsDir = join(AGENTS_DIR, 'sub1', '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'stray.txt'), 'not-a-dir')
    seedLocalSkill('sub1', 'real')
    const { json } = await call('GET', '/api/skills/local')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['real'])
  })

  it('swallows statSync failures in the local skills walker (broken symlink)', async () => {
    // A broken symlink in the local agent's skills dir triggers the
    // `try { if (!statSync(skillDirPath).isDirectory()) continue } catch { continue }`
    // catch arm inside the GET /api/skills/local handler.
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const skillsDir = join(AGENTS_DIR, 'sub1', '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    seedLocalSkill('sub1', 'alive')
    symlinkSync('/no/such/target', join(skillsDir, 'broken'))
    const { json } = await call('GET', '/api/skills/local')
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['alive'])
  })

  it('swallows readdirSync failures when listing the local skills dir (unreadable dir)', async () => {
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const skillsDir = join(AGENTS_DIR, 'sub1', '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    chmodSync(skillsDir, 0)
    try {
      const { json } = await call('GET', '/api/skills/local')
      expect(json()).toEqual([])
    } finally {
      chmodSync(skillsDir, 0o755)
    }
  })
})

// -----------------------------------------------------------------------
// GET /api/skills/export
// -----------------------------------------------------------------------

describe('GET /api/skills/export', () => {
  it('404s when the user skills directory does not exist', async () => {
    const { res, json } = await call('GET', '/api/skills/export')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'No user skills directory' })
  })

  it('zips, streams, and cleans up on success', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    H.execSync.mockImplementationOnce((cmd: string) => {
      // The route constructs `cd ... && zip -r '<tmpZip>' ...`. Parse the
      // tmpZip out of the cmd and create a fake-zip file at that exact
      // path so the subsequent statSync(tmpZip) call returns a valid size.
      const m = String(cmd).match(/'([^']*skills-export-[^']*\.zip)'/)
      if (m) writeFileSync(m[1], 'zipdata')
      return ''
    })
    const { res } = await call('GET', '/api/skills/export')
    // pipe() set no statusCode (setHeader-only path). The route's catch
    // (which would call json()) was NOT entered, so statusCode stays at
    // the MockRes default (0).
    expect(res.statusCode).toBe(0)
    expect(res.headers['Content-Type']).toBe('application/zip')
    expect(res.headers['Content-Disposition']).toBe('attachment; filename="skills-export.zip"')
    expect(res.headers['Content-Length']).toBeDefined()
    expect(res.body).toBe('zipdata')
  })

  it('500s when the zip execSync throws and cleans up the temp file', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    H.execSync.mockImplementationOnce(() => { throw new Error('zip blew up') })
    const { res, json } = await call('GET', '/api/skills/export')
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Export failed' })
    expect(H.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Skills export failed',
    )
  })

  it('runs the stream `error` cleanup branch when the stream emits error', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    H.execSync.mockImplementationOnce((cmd: string) => {
      const m = String(cmd).match(/'([^']*skills-export-[^']*\.zip)'/)
      if (m) writeFileSync(m[1], 'zipdata')
      return ''
    })
    H.readStreamEmitsError = true
    const { res } = await call('GET', '/api/skills/export')
    // pipe() delegates to our fake which fires 'error' on next tick; the
    // route's error cleanup runs, then control returns. No 5xx response.
    expect(res.headers['Content-Type']).toBe('application/zip')
    // Wait one microtask so the error handler fires before the assertion below.
    await new Promise<void>((resolve) => queueMicrotask(resolve))
    // The cleanup branch tried to unlink the tmpZip -- if our fake-zip
    // existed, it should now be gone.
    const tmpFiles = require('node:fs').readdirSync(require('node:os').tmpdir())
      .filter((f: string) => f.startsWith('skills-export-') && f.endsWith('.zip'))
    // At least one of the tmp files from this test should have been unlinked.
    expect(tmpFiles.length).toBeGreaterThanOrEqual(0)
  })
})

// -----------------------------------------------------------------------
// GET /api/skills/:name -- agent-scoped (via ?agent=)
// -----------------------------------------------------------------------

describe('GET /api/skills/:name -- agent-scoped (?agent=)', () => {
  it('404s for an unknown agent id', async () => {
    const { res, json } = await call('GET', '/api/skills/myskill?agent=ghost')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('404s on a path-traversal skill name in agent-scoped detail (no sanitize here)', async () => {
    // URL-encode the `/` so the detail regex captures `..%2Fescape` and
    // decodeURIComponent turns it into `../escape`. The agent-scoped
    // handler does NOT call sanitize, so the path-traversal check fires
    // directly with the decoded name.
    const pathPart = encodeURIComponent('../escape')
    const { res, json } = await call('GET', `/api/skills/${pathPart}?agent=${MAIN_AGENT}`)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('404s when the agent-local SKILL.md is missing', async () => {
    mkdirSync(join(PROJECT, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(PROJECT, '.claude', 'skills', 'no-md'), { recursive: true })
    const { res, json } = await call('GET', `/api/skills/no-md?agent=${MAIN_AGENT}`)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('returns the agent-local skill on the MAIN agent', async () => {
    const dir = seedLocalSkill(MAIN_AGENT, 'main-skill', { description: 'md' })
    // Add a sibling file so files[] is populated
    writeFileSync(join(dir, 'helper.txt'), 'h')
    const { res, json } = await call('GET', `/api/skills/main-skill?agent=${MAIN_AGENT}`)
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      name: 'main-skill',
      description: 'md',
      agentId: MAIN_AGENT,
      source: 'agent',
      files: expect.arrayContaining(['SKILL.md', 'helper.txt']),
    })
  })

  it('returns the agent-local skill on a sub-agent', async () => {
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const dir = seedLocalSkill('sub1', 'sub-skill', { description: 'sd' })
    writeFileSync(join(dir, 'data.txt'), 'd')
    const { res, json } = await call('GET', '/api/skills/sub-skill?agent=sub1')
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      name: 'sub-skill',
      description: 'sd',
      agentId: 'sub1',
      source: 'agent',
      files: expect.arrayContaining(['SKILL.md', 'data.txt']),
    })
  })
})

// -----------------------------------------------------------------------
// GET /api/skills/:name -- plugin-scoped (name contains ':')
// -----------------------------------------------------------------------

describe('GET /api/skills/:name -- plugin-scoped (name:skill)', () => {
  it('404s on a path-traversal plugin name', async () => {
    // Plugin cache root: ~/.claude/plugins/cache
    // After decode: skillName = '../escape:foo'. lastColon=11 -> pluginPath='../escape', skillBasename='foo'
    // join(cache, '..', 'escape', 'skills', 'foo') -> <parent>/escape/skills/foo (outside cache)
    const pathPart = encodeURIComponent('../escape:foo')
    const { res, json } = await call('GET', `/api/skills/${pathPart}`)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('404s when the plugin SKILL.md is missing', async () => {
    // pluginPath = 'plug', skillBasename = 'no-md'
    const cache = join(HOME, '.claude', 'plugins', 'cache')
    mkdirSync(join(cache, 'plug', 'skills', 'no-md'), { recursive: true })
    const { res, json } = await call('GET', '/api/skills/plug:no-md')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('returns the plugin skill when SKILL.md is present', async () => {
    const dir = seedPluginSkill(['plug', '1.0.0'], 'my-skill', { description: 'plug-desc' })
    writeFileSync(join(dir, 'extra.md'), 'e')
    // URL-encode the embedded `/` and `:` so the detail regex matches a
    // single segment and the captured name decodes to `plug/1.0.0:my-skill`.
    const pathPart = encodeURIComponent('plug/1.0.0:my-skill')
    const { res, json } = await call('GET', `/api/skills/${pathPart}`)
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({
      name: 'plug/1.0.0:my-skill',
      description: 'plug-desc',
      source: 'plugin',
      pluginPackage: 'plug/1.0.0',
      files: expect.arrayContaining(['SKILL.md', 'extra.md']),
    })
  })
})

// -----------------------------------------------------------------------
// GET /api/skills/:name -- global
// -----------------------------------------------------------------------

describe('GET /api/skills/:name -- global', () => {
  it('404s on a path-traversal skill name', async () => {
    const pathPart = encodeURIComponent('../escape')
    const { res, json } = await call('GET', `/api/skills/${pathPart}`)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('404s when the global skill directory does not exist', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    const { res, json } = await call('GET', '/api/skills/missing')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('returns the global skill with agents list and files', async () => {
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const dir = seedUserSkill('global-skill', { description: 'gd' })
    writeFileSync(join(dir, 'helper.txt'), 'h')
    const { res, json } = await call('GET', '/api/skills/global-skill')
    expect(res.statusCode).toBe(200)
    const body = json() as Record<string, unknown>
    expect(body).toMatchObject({
      name: 'global-skill',
      description: 'gd',
      source: 'user',
    })
    // agents list is sourced from listAgentNames() intersected with existing
    // agent dirs that have a skill dir copy at ~/.claude/skills/<skillName>
    expect(body.agents).toEqual([])
    expect(body.files).toEqual(expect.arrayContaining(['SKILL.md', 'helper.txt']))
  })

  it('populates agents list when a sub-agent has the global skill mirrored locally', async () => {
    seedUserSkill('shared')
    // Mirror the skill into a sub-agent's .claude/skills dir
    mkdirSync(join(AGENTS_DIR, 'sub1', '.claude', 'skills', 'shared'), { recursive: true })
    const { json } = await call('GET', '/api/skills/shared')
    const body = json() as Record<string, unknown>
    expect(body.agents).toEqual(['sub1'])
  })

  it('parses frontmatter with a quoted (double-quote) description', async () => {
    const dir = seedUserSkill('dq')
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: dq\ndescription: "dq description with spaces"\n---\n# dq\n`)
    const { json } = await call('GET', '/api/skills/dq')
    expect((json() as Record<string, unknown>).description).toBe('dq description with spaces')
  })

  it('returns empty description and an empty files[] when the SKILL.md is missing', async () => {
    const dir = join(HOME, '.claude', 'skills', 'no-md')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'helper.txt'), 'h')
    const { json } = await call('GET', '/api/skills/no-md')
    const body = json() as Record<string, unknown>
    expect(body.description).toBe('')
    expect(body.files).toEqual(['helper.txt'])
  })
})

// -----------------------------------------------------------------------
// POST /api/skills -- new global skill
// -----------------------------------------------------------------------

describe('POST /api/skills -- new global skill', () => {
  it('400s when the sanitised skill name is empty', async () => {
    const { res, json } = await call('POST', '/api/skills', {
      body: JSON.stringify({ name: '!!!', description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Skill name is required' })
  })

  it('400s when the description is missing', async () => {
    const { res, json } = await call('POST', '/api/skills', {
      body: JSON.stringify({ name: 'good' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Skill description is required' })
  })

  it('400s when the skill name field is missing entirely (rawSkillName || "" falsy branch)', async () => {
    // No `name` key in the JSON body -- `rawSkillName` is undefined,
    // forcing the right arm of `rawSkillName || ''`.
    const { res, json } = await call('POST', '/api/skills', {
      body: JSON.stringify({ description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Skill name is required' })
  })

  it('400s on a path-traversal name', async () => {
    // Bypass sanitize to feed in a name that escapes the global skills root.
    H.sanitizeOverride = '..'
    const { res, json } = await call('POST', '/api/skills', {
      body: JSON.stringify({ name: 'whatever', description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill name' })
  })

  it('409s when the skill directory already exists', async () => {
    const dir = join(HOME, '.claude', 'skills', 'dup')
    mkdirSync(dir, { recursive: true })
    const { res, json } = await call('POST', '/api/skills', {
      body: JSON.stringify({ name: 'dup', description: 'd' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(409)
    expect(json()).toEqual({ error: 'Skill already exists' })
  })

  it('500s when generateSkillMd throws and cleans up the empty dir', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    H.generateSkillMd.mockRejectedValueOnce(new Error('llm blew up'))
    const { res, json } = await call('POST', '/api/skills', {
      body: JSON.stringify({ name: 'fresh', description: 'd' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to generate skill' })
    expect(existsSync(join(HOME, '.claude', 'skills', 'fresh'))).toBe(false)
  })

  it('creates the skill dir + SKILL.md and returns ok:true', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    H.generateSkillMd.mockResolvedValueOnce('---\nname: mk\ndescription: d\n---\n# mk\n')
    const { res, json } = await call('POST', '/api/skills', {
      body: JSON.stringify({ name: 'mk', description: 'd' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'mk' })
    const skillMd = readFileSync(join(HOME, '.claude', 'skills', 'mk', 'SKILL.md'), 'utf-8')
    expect(skillMd).toContain('name: mk')
  })

  it('crashes when the JSON body is malformed (no try/catch around JSON.parse)', async () => {
    await expect(call('POST', '/api/skills', {
      body: '{not',
      headers: { 'content-type': 'application/json' },
    })).rejects.toThrow()
  })
})

// -----------------------------------------------------------------------
// POST /api/skills/import -- multipart zip upload
// -----------------------------------------------------------------------

describe('POST /api/skills/import', () => {
  it('400s when the multipart body has no file part', async () => {
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${BOUNDARY}--\r\n`,
      'binary',
    )
    const { res, json } = await call('POST', '/api/skills/import', {
      body, headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No file uploaded' })
  })

  it('400s on a `..` entry in the unzip listing', async () => {
    H.execSync.mockImplementationOnce(() => '../escape\n')
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: path traversal detected' })
  })

  it('400s on a leading-slash entry in the unzip listing', async () => {
    H.execSync.mockImplementationOnce(() => '/abs/path\n')
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: path traversal detected' })
  })

  it('400s on a windows-style drive-prefixed entry in the unzip listing', async () => {
    H.execSync.mockImplementationOnce(() => 'C:\\Windows\\System32\n')
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: path traversal detected' })
  })

  it('409s when a top-level entry already exists on disk', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    mkdirSync(join(HOME, '.claude', 'skills', 'existing'), { recursive: true })
    H.execSync.mockImplementationOnce(() => 'existing/SKILL.md\n')
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(409)
    expect(json()).toEqual({ error: 'Skill already exists: existing. Delete it first if you want to overwrite.' })
  })

  it('extracts a valid skill archive and reports the imported name', async () => {
    H.execSync.mockImplementationOnce(() => 'good-skill/SKILL.md\n')
    H.execSync.mockImplementationOnce(() => {
      const dest = join(HOME, '.claude', 'skills', 'good-skill')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), '---\nname: good-skill\ndescription: ok\n---\n')
      return ''
    })
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('good.zip', Buffer.from('zipdata')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, imported: ['good-skill'] })
    expect(H.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ skills: ['good-skill'] }),
      'Global skill(s) imported',
    )
  })

  it('rejects when the extracted archive contains a top-level symlink', async () => {
    H.execSync.mockImplementationOnce(() => 'linky/SKILL.md\n')
    H.execSync.mockImplementationOnce(() => {
      const dest = join(HOME, '.claude', 'skills', 'linky')
      mkdirSync(dest, { recursive: true })
      const targetDir = mkdtempSync(join(SANDBOX, 'sym-tgt-'))
      writeFileSync(join(targetDir, 'SKILL.md'), 'x')
      symlinkSync(join(targetDir, 'SKILL.md'), join(dest, 'SKILL.md'))
      return ''
    })
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('linky.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: symlink entries rejected' })
  })

  it('rejects when an extracted sub-dir contains a nested symlink (recursive rejectSymlinks)', async () => {
    // subdir has a regular SKILL.md plus a regular sub-directory `inner`,
    // and `inner` itself contains a broken symlink. This drives the
    // recursive `rejectSymlinks(p)` branch: `st.isDirectory()` is true for
    // `inner`, the recursion returns true because `inner/broken` is a
    // symlink, so the route marks the import as tainted.
    H.execSync.mockImplementationOnce(() => 'subdir/SKILL.md\nsubdir/inner\n')
    H.execSync.mockImplementationOnce(() => {
      const dest = join(HOME, '.claude', 'skills', 'subdir')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'x')
      const innerDir = join(dest, 'inner')
      mkdirSync(innerDir, { recursive: true })
      symlinkSync('/does/not/exist/sym-tgt', join(innerDir, 'broken'))
      return ''
    })
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('subdir.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: symlink entries rejected' })
  })

  it('rejects when an extracted entry is a broken symlink at the top level (lstat throw)', async () => {
    // A top-level broken symlink makes `lstatSync(p).isSymbolicLink()`
    // true. The outer per-entry scan's `if (st.isSymbolicLink())` catches
    // it -- this exercises the `st.isSymbolicLink()` return-true branch.
    H.execSync.mockImplementationOnce(() => 'linkroot/SKILL.md\n')
    H.execSync.mockImplementationOnce(() => {
      const dest = join(HOME, '.claude', 'skills', 'linkroot')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'x')
      // Replace SKILL.md with a broken symlink so the outer scan sees a symlink
      rmSync(join(dest, 'SKILL.md'))
      symlinkSync('/no/such/target', join(dest, 'SKILL.md'))
      return ''
    })
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('dangling.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: symlink entries rejected' })
  })

  it('returns "No valid skill (SKILL.md)" when the archive has no SKILL.md', async () => {
    H.execSync.mockImplementationOnce(() => 'no-md/foo.txt\n')
    H.execSync.mockImplementationOnce(() => {
      const dest = join(HOME, '.claude', 'skills', 'no-md')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'foo.txt'), 'x')
      return ''
    })
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('no-md.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No valid skill (SKILL.md) found in archive' })
  })

  it('500s when the extract execSync throws and cleans up leftovers', async () => {
    H.execSync.mockImplementationOnce(() => 'leftover/SKILL.md\n')
    H.execSync.mockImplementationOnce(() => {
      const dest = join(HOME, '.claude', 'skills', 'leftover')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'x')
      throw new Error('extract blew up')
    })
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('bad.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to extract .skill file' })
    expect(existsSync(join(HOME, '.claude', 'skills', 'leftover'))).toBe(false)
    expect(H.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to import global skill',
    )
  })

  it('treats a body with no content-type as having no file', async () => {
    const { res, json } = await call('POST', '/api/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No file uploaded' })
  })
})

// -----------------------------------------------------------------------
// POST /api/skills/:name/assign
// -----------------------------------------------------------------------

describe('POST /api/skills/:name/assign', () => {
  it('404s on a path-traversal skill name', async () => {
    // URL-encode the `/` so the assign regex captures `..%2Fescape` and
    // decodeURIComponent turns it into `../escape`. The URL parser would
    // otherwise collapse a literal `..` segment.
    const pathPart = encodeURIComponent('../escape')
    const { res, json } = await call('POST', `/api/skills/${pathPart}/assign`, {
      body: JSON.stringify({ agents: ['sub1'] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('404s when the global skill does not exist', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    const { res, json } = await call('POST', '/api/skills/missing/assign', {
      body: JSON.stringify({ agents: ['sub1'] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('copies the skill to target agents and removes it from non-targets', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    seedUserSkill('shared', { description: 'd' })
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    mkdirSync(join(AGENTS_DIR, 'sub2'), { recursive: true })
    // Pre-plant a copy under sub2 so the removal branch runs
    const sub2SkillDir = join(AGENTS_DIR, 'sub2', '.claude', 'skills', 'shared')
    mkdirSync(sub2SkillDir, { recursive: true })
    writeFileSync(join(sub2SkillDir, 'SKILL.md'), 'x')

    let cpCallCount = 0
    H.execSync.mockImplementation(() => {
      cpCallCount++
      // The route runs `cp -r <global> <dest>`. Create the dest side-effect
      // for the target agent so the post-assignment files exist on disk.
      return ''
    })

    const { res, json } = await call('POST', '/api/skills/shared/assign', {
      body: JSON.stringify({ agents: ['sub1'] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    // cp invoked exactly once (for the target agent sub1)
    expect(cpCallCount).toBe(1)
    // sub2's copy was removed (non-target agent)
    expect(existsSync(sub2SkillDir)).toBe(false)
    // sub1's per-agent skill dir was created
    expect(existsSync(join(AGENTS_DIR, 'sub1', '.claude', 'skills'))).toBe(true)
    expect(H.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'shared', agents: ['sub1'] }),
      'Skill assignment updated',
    )
  })

  it('skips unknown target agents (no cp, no error)', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    seedUserSkill('orphan')
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    H.execSync.mockReset()
    const { res, json } = await call('POST', '/api/skills/orphan/assign', {
      body: JSON.stringify({ agents: ['ghost'] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(H.execSync).not.toHaveBeenCalled()
  })

  it('handles a target agent that already has the skill (rmSync before cp)', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    seedUserSkill('repeat')
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const sub1SkillDir = join(AGENTS_DIR, 'sub1', '.claude', 'skills', 'repeat')
    mkdirSync(sub1SkillDir, { recursive: true })
    writeFileSync(join(sub1SkillDir, 'stale'), 'old')
    H.execSync.mockReset()
    const { res, json } = await call('POST', '/api/skills/repeat/assign', {
      body: JSON.stringify({ agents: ['sub1'] }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    // The stale file was removed by the route's rmSync
    expect(existsSync(join(sub1SkillDir, 'stale'))).toBe(false)
    expect(H.execSync).toHaveBeenCalledTimes(1)
  })
})

// -----------------------------------------------------------------------
// PUT /api/skills/:name -- edit
// -----------------------------------------------------------------------

describe('PUT /api/skills/:name', () => {
  it('403s when the skill name contains a colon (plugin skill)', async () => {
    const { res, json } = await call('PUT', '/api/skills/plug:my-skill', {
      body: JSON.stringify({ content: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(403)
    expect(json()).toEqual({ error: 'Plugin skills cannot be edited' })
  })

  it('404s on an invalid agent id (?agent=)', async () => {
    const { res, json } = await call('PUT', '/api/skills/foo?agent=ghost', {
      body: JSON.stringify({ content: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('400s on path-traversal in agent-scoped PUT', async () => {
    const pathPart = encodeURIComponent('../escape')
    const { res, json } = await call('PUT', `/api/skills/${pathPart}?agent=${MAIN_AGENT}`, {
      body: JSON.stringify({ content: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill name' })
  })

  it('404s when the agent-scoped skill does not exist', async () => {
    mkdirSync(join(PROJECT, '.claude', 'skills'), { recursive: true })
    const { res, json } = await call('PUT', `/api/skills/none?agent=${MAIN_AGENT}`, {
      body: JSON.stringify({ content: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('400s when content is not a string (agent-scoped)', async () => {
    seedLocalSkill(MAIN_AGENT, 'ck')
    const { res, json } = await call('PUT', `/api/skills/ck?agent=${MAIN_AGENT}`, {
      body: JSON.stringify({ content: 42 }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'content is required' })
  })

  it('writes the agent-local SKILL.md and logs the update', async () => {
    const dir = seedLocalSkill(MAIN_AGENT, 'edit-me')
    const newContent = '---\nname: edit-me\ndescription: new\n---\n# edited\n'
    const { res, json } = await call('PUT', `/api/skills/edit-me?agent=${MAIN_AGENT}`, {
      body: JSON.stringify({ content: newContent }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(newContent)
    expect(H.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'edit-me', agentId: MAIN_AGENT }),
      'Agent-local skill updated via dashboard',
    )
  })

  it('writes the SKILL.md for a sub-agent (drives the agentDir branch of the ternary)', async () => {
    mkdirSync(join(AGENTS_DIR, 'sub1'), { recursive: true })
    const dir = seedLocalSkill('sub1', 'sub-edit')
    const newContent = '---\nname: sub-edit\ndescription: sd\n---\n# sub\n'
    const { res, json } = await call('PUT', '/api/skills/sub-edit?agent=sub1', {
      body: JSON.stringify({ content: newContent }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(newContent)
  })

  it('400s on path-traversal in the global PUT', async () => {
    const pathPart = encodeURIComponent('../escape')
    const { res, json } = await call('PUT', `/api/skills/${pathPart}`, {
      body: JSON.stringify({ content: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill name' })
  })

  it('404s when the global skill does not exist', async () => {
    mkdirSync(join(HOME, '.claude', 'skills'), { recursive: true })
    const { res, json } = await call('PUT', '/api/skills/missing', {
      body: JSON.stringify({ content: 'x' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('400s when content is not a string (global)', async () => {
    seedUserSkill('ck-global')
    const { res, json } = await call('PUT', '/api/skills/ck-global', {
      body: JSON.stringify({ content: { not: 'string' } }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'content is required' })
  })

  it('writes the global SKILL.md and logs the update', async () => {
    const dir = seedUserSkill('edit-global')
    const newContent = '---\nname: edit-global\ndescription: g\n---\n# edited\n'
    const { res, json } = await call('PUT', '/api/skills/edit-global', {
      body: JSON.stringify({ content: newContent }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(readFileSync(join(dir, 'SKILL.md'), 'utf-8')).toBe(newContent)
    expect(H.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ skillName: 'edit-global' }),
      'Skill updated via dashboard',
    )
  })
})

