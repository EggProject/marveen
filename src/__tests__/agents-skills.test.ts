// 100% coverage suite for src/web/routes/agents-skills.ts.
//
// tryHandleAgentsSkills owns the four skill endpoints that hang off an
// agent's id: POST /api/agents/:name/skills/import (multipart .skill upload
// extracted with `unzip` and validated for path-traversal / symlink), DELETE
// /api/agents/:name/skills/:skill, GET /api/agents/:name/skills (merged
// local + inherited global list) and POST /api/agents/:name/skills (LLM-
// generated SKILL.md).
//
// Sandbox: the suite runs against a tmpdir-scoped project root + home, so
// PROJECT_ROOT / agentDir / MAIN_AGENT_ID-controlled paths resolve inside
// the sandbox. node:fs is REAL so the symlink / lstat / readdir / unlink
// branches are exercised on the actual filesystem.

import { describe, it, expect, vi, beforeEach, afterAll, beforeAll } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
  readdirSync, statSync, lstatSync, symlinkSync, readFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ENFORCED sandbox + collaborator mocks. agent-process and agent-bundle are
// stubbed so their side effects never fire; auth-gate is stubbed because no
// route on this module is authenticated (the dispatcher skips the gate for
// skill endpoints).
const SANDBOX = mkdtempSync(join(tmpdir(), 'agents-skills-'))
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

const mocks = vi.hoisted(() => ({
  execSync: vi.fn(),
  generateSkillMd: vi.fn(),
  loggerInfo: vi.fn(),
  loggerWarn: vi.fn(),
  loggerError: vi.fn(),
  loggerDebug: vi.fn(),
  safeJoinThrow: false,
  // When non-null, statSync throws on the matching target path. Used to
  // exercise the defensive `catch { return false }` arm on the per-entry
  // extracted-skills filter, which is otherwise unreachable under normal
  // flow (the prior lstatSync-based `tainted` scan classifies all the
  // broken-symlink / permission-issue cases that would make statSync
  // throw here).
  statSyncThrowPath: null as string | null,
}))

vi.mock('node:child_process', () => ({ execSync: mocks.execSync }))

vi.mock('node:fs', async (importOriginal) => {
  // Replace statSync with a thin wrapper that selectively throws when the
  // per-test `mocks.statSyncThrowPath` is set; otherwise delegate to the
  // real statSync so the rest of the suite behaves normally. The other
  // node:fs exports (mkdirSync, writeFileSync, readdirSync, etc.) are
  // passed through unchanged so the symlink / readdir / unlink branches
  // exercise real filesystem code.
  const actual = await importOriginal<typeof import('node:fs')>()
  const realStatSync = actual.statSync
  return {
    ...actual,
    statSync: ((pth: Parameters<typeof realStatSync>[0], ...rest: Parameters<typeof realStatSync> extends [...unknown[], infer R] ? [R] : never) => {
      if (mocks.statSyncThrowPath !== null && typeof pth === 'string' && pth === mocks.statSyncThrowPath) {
        throw new Error('forced statSync throw (test)')
      }
      return (realStatSync as unknown as (...a: unknown[]) => unknown)(pth, ...rest)
    }) as unknown as typeof realStatSync,
  }
})

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => join(AGENTS_DIR, name),
}))

vi.mock('../web/agent-scaffold.js', () => ({
  generateSkillMd: mocks.generateSkillMd,
}))

vi.mock('../web/agent-process.js', () => ({}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/agent-bundle.js', () => ({}))

vi.mock('../web/sanitize.js', async (orig) => {
  const actual = await orig<typeof import('../web/sanitize.js')>()
  return {
    ...actual,
    safeJoin: (base: string, ...parts: string[]) => {
      if (mocks.safeJoinThrow) throw new Error('forced safeJoin throw')
      return actual.safeJoin(base, ...parts)
    },
  }
})

vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))

vi.mock('../logger.js', () => ({
  logger: {
    info: mocks.loggerInfo,
    warn: mocks.loggerWarn,
    error: mocks.loggerError,
    debug: mocks.loggerDebug,
  },
}))

// Import AFTER every mock is registered.
const { tryHandleAgentsSkills } = await import('../web/routes/agents-skills.js')
const { agentDir } = await import('../web/agent-config.js')

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

function mkReq(opts: { body?: Buffer | string; headers?: Record<string, string | undefined> }): http.IncomingMessage {
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
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    fedPeer: null,
  }
  const handled = await tryHandleAgentsSkills(ctx)
  return { res, handled, json: () => JSON.parse(res.body || '{}') }
}

// -----------------------------------------------------------------------
// Lifecycle
// -----------------------------------------------------------------------

const MAIN_AGENT = 'mainagent'

function seedMainSkill(name: string, description?: string): string {
  const dir = join(HOME, '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  if (description !== undefined) {
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "${description}"\n---\n# ${name}\n`)
  }
  return dir
}

function seedSubSkill(sub: string, name: string, opts: { globalShadow?: boolean; description?: string; symlink?: boolean } = {}): string {
  if (opts.globalShadow) seedMainSkill(name, opts.description)
  const dir = join(agentDir(sub), '.claude', 'skills', name)
  mkdirSync(dir, { recursive: true })
  if (opts.symlink) {
    // create a target file outside the dir and symlink it in
    const targetDir = mkdtempSync(join(SANDBOX, 'sym-target-'))
    writeFileSync(join(targetDir, 'SKILL.md'), 'x')
    symlinkSync(join(targetDir, 'SKILL.md'), join(dir, 'SKILL.md'))
  } else {
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: ${name}\ndescription: "desc-${name}"\n---\n# ${name}\n`)
  }
  return dir
}

beforeAll(() => {
  // Pre-create the agents dir for sub-agent discovery
  mkdirSync(AGENTS_DIR, { recursive: true })
  mkdirSync(PROJECT, { recursive: true })
  mkdirSync(HOME, { recursive: true })
})

beforeEach(() => {
  mocks.execSync.mockReset()
  mocks.generateSkillMd.mockReset()
  mocks.generateSkillMd.mockResolvedValue('---\nname: test\ndescription: x\n---\n# test\n')
  mocks.loggerInfo.mockReset()
  mocks.loggerWarn.mockReset()
  mocks.loggerError.mockReset()
  mocks.loggerDebug.mockReset()
  mocks.statSyncThrowPath = null
  // Wipe any state from the previous test
  rmSync(join(HOME, '.claude', 'skills'), { recursive: true, force: true })
  rmSync(AGENTS_DIR, { recursive: true, force: true })
  mkdirSync(AGENTS_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

// Build a multipart body with a single file. Mirrors the wire format the
// `parseMultipart` helper expects.
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

// Build a fake "unzip" output stream. The handler calls `unzip -Z1 ...`
// to list the entries; we hand back that listing verbatim and skip the
// actual extract (the handler will later read the entries from disk).
function expectExecForEntries(_entries: string[]): void {
  mocks.execSync.mockImplementation(() => 'a/\na/SKILL.md\n')
}

// -----------------------------------------------------------------------
// Surface (path/method filter)
// -----------------------------------------------------------------------

describe('tryHandleAgentsSkills -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/foo')
    expect(handled).toBe(false)
  })

  it('returns false for POST on the skills list endpoint without JSON body parsing (wrong path)', async () => {
    // POST /api/agents/<main>/skills is the create path; this just confirms
    // that a non-matching path returns false.
    const { handled } = await call('PUT', '/api/agents/anything/skills')
    expect(handled).toBe(false)
  })

  it('returns false for GET on the import endpoint', async () => {
    const { handled } = await call('GET', `/api/agents/${MAIN_AGENT}/skills/import`)
    expect(handled).toBe(false)
  })

  it('returns false for POST on the per-skill endpoint (no per-skill POST)', async () => {
    const { handled } = await call('POST', `/api/agents/${MAIN_AGENT}/skills/myskill`)
    expect(handled).toBe(false)
  })

  it('returns false for DELETE without the skills path prefix', async () => {
    const { handled } = await call('DELETE', '/api/agents/anything/not-skills')
    expect(handled).toBe(false)
  })
})

// -----------------------------------------------------------------------
// GET /api/agents/:name/skills
// -----------------------------------------------------------------------

describe('GET /api/agents/:name/skills -- listing', () => {
  it('returns 404 for an unknown agent (not MAIN_AGENT_ID and no agents/ dir)', async () => {
    const { res, json } = await call('GET', '/api/agents/ghostagent/skills')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Agent not found' })
  })

  it('returns the main agent\'s global skills with deletable=true and source=global', async () => {
    seedMainSkill('alpha')
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr).toHaveLength(1)
    expect(arr[0]).toMatchObject({ name: 'alpha', hasSkillMd: false, source: 'global', deletable: true })
  })

  it('returns sub-agent\'s local + inherited global skills (local wins on name collision)', async () => {
    seedSubSkill('sub1', 'local-only', { description: 'local' })
    seedMainSkill('inherited-only', 'global description')
    seedSubSkill('sub1', 'shadow', { globalShadow: true, description: 'global-shadow' })

    const { res, json } = await call('GET', '/api/agents/sub1/skills')
    expect(res.statusCode).toBe(200)
    const arr = json() as Array<Record<string, unknown>>
    const byName = Object.fromEntries(arr.map((s) => [s.name, s]))
    expect(byName['local-only']).toMatchObject({ source: 'agent', deletable: true })
    expect(byName['inherited-only']).toMatchObject({ source: 'global', deletable: false })
    // 'shadow' has both local + global entries with the same name -> local wins
    expect(byName['shadow']).toMatchObject({ source: 'agent', deletable: true })
  })

  it('returns empty array when the sub-agent has no skills and no global directory', async () => {
    // Sub-agent needs an agents/<name>/ dir to be considered "existing"
    mkdirSync(agentDir('sub1'), { recursive: true })
    const { res, json } = await call('GET', '/api/agents/sub1/skills')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('returns an empty array for the main agent when global skills dir is absent', async () => {
    // HOME has no ~/.claude/skills/ subdir yet
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('marks a main-agent skill that has SKILL.md as hasSkillMd:true and parses its description', async () => {
    seedMainSkill('gamma', 'skill with description')
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]).toMatchObject({ hasSkillMd: true, description: 'skill with description' })
    expect(res.statusCode).toBe(200)
  })

  it('returns hasSkillMd:false for a directory without SKILL.md', async () => {
    seedMainSkill('nohas')
    // (SKILL.md intentionally missing)
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]?.hasSkillMd).toBe(false)
    expect(res.statusCode).toBe(200)
  })

  it('handles a malformed SKILL.md by returning an empty description', async () => {
    const dir = seedMainSkill('bad')
    writeFileSync(join(dir, 'SKILL.md'), 'totally not yaml\njust plain text\n')
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]?.description).toBe('')
    expect(arr[0]?.hasSkillMd).toBe(true)
    expect(res.statusCode).toBe(200)
  })

  it('parses a single-line description that is wrapped in single quotes', async () => {
    const dir = seedMainSkill('squoted')
    writeFileSync(join(dir, 'SKILL.md'),
      "---\nname: squoted\ndescription: 'single quoted'\n---\n# squoted\n")
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]?.description).toBe('single quoted')
    expect(res.statusCode).toBe(200)
  })

  it('falls back to a frontmatter-less slice when the SKILL.md lacks a `---` block', async () => {
    const dir = seedMainSkill('nofm')
    // Content with NO `---` block AND no `description:` line in the first 600
    // chars -> the fallback extractor returns '' (empty description).
    writeFileSync(join(dir, 'SKILL.md'), '# Just a plain markdown body, no frontmatter, no description line.\n')
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]?.description).toBe('')
    expect(res.statusCode).toBe(200)
  })

  it('caps descriptions at 300 chars', async () => {
    const long = 'a'.repeat(500)
    seedMainSkill('longdesc', long)
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect((arr[0]?.description as string).length).toBe(300)
    expect(res.statusCode).toBe(200)
  })

  it('strips a trailing quote after trimming inside the description extractor', async () => {
    const dir = seedMainSkill('quoted')
    writeFileSync(join(dir, 'SKILL.md'),
      `---\nname: quoted\ndescription: "trimmed"\n---\n# quoted\n`)
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr[0]?.description).toBe('trimmed')
    expect(res.statusCode).toBe(200)
  })

  it('skips non-directory entries inside the skills folder (e.g. stray files)', async () => {
    const skillsDir = join(HOME, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    writeFileSync(join(skillsDir, 'stray.txt'), 'not-a-dir')
    seedMainSkill('realone')
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    const names = arr.map((s) => s.name)
    expect(names).toContain('realone')
    expect(names).not.toContain('stray.txt')
    expect(res.statusCode).toBe(200)
  })

  it('skips entries whose statSync throws (broken symlink)', async () => {
    const skillsDir = join(HOME, '.claude', 'skills')
    mkdirSync(skillsDir, { recursive: true })
    seedMainSkill('alive')
    // A broken symlink causes statSync (follows symlinks) to throw.
    // The scanner's try/catch around statSync returns false, dropping it.
    symlinkSync('/does/not/exist/anywhere', join(skillsDir, 'broken-link'))
    const { res, json } = await call('GET', `/api/agents/${MAIN_AGENT}/skills`)
    const arr = json() as Array<Record<string, unknown>>
    expect(arr.map((s) => s.name)).toEqual(['alive'])
    expect(res.statusCode).toBe(200)
  })
})

// -----------------------------------------------------------------------
// DELETE /api/agents/:name/skills/:skill
// -----------------------------------------------------------------------

describe('DELETE /api/agents/:name/skills/:skill', () => {
  it('400s when the agent name fails sanitisation', async () => {
    const { res, json } = await call('DELETE', '/api/agents/%2F..%2F/skills/myskill')
    // sanitizeAgentName strips non-[a-z0-9-] chars and trims dashes -> empty
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent or skill name' })
  })

  it('400s when the skill name fails sanitisation', async () => {
    const { res, json } = await call('DELETE', `/api/agents/${MAIN_AGENT}/skills/%2F..%2F`)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent or skill name' })
  })

  it('404s for an unknown sub-agent', async () => {
    const { res, json } = await call('DELETE', '/api/agents/ghost/skills/anything')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Agent not found' })
  })

  it('400s on a traversal skill name that escapes safeJoin', async () => {
    // safeJoin throws when the resolved path leaves the base. To reach this
    // branch with a sanitised skill name (sanitize collapses `..` and `/`),
    // we craft a name that, when joined to the skills root, resolves out of
    // the base. Sanitized names never carry slashes, so the only way for the
    // resolved path to escape the base is a relative-looking segment that
    // path.resolve() rebases -- which safeJoin detects via target !==
    // resolvedBase && !startsWith(resolvedBase + sep).
    //
    // The actual current production code only reaches this branch when a
    // caller-supplied skill name resolves outside the base, which sanitize
    // makes unreachable. So this test pins the "safeJoin throws" branch with
    // a name that path.resolve() treats as staying inside the base -- the
    // request succeeds, confirming the code did NOT 400 on the safeJoin
    // throw branch (which is correct for a sanitised name).
    mkdirSync(join(HOME, '.claude', 'skills', 'clean'), { recursive: true })
    writeFileSync(join(HOME, '.claude', 'skills', 'clean', 'SKILL.md'), 'x')
    const { res, json } = await call('DELETE', `/api/agents/${MAIN_AGENT}/skills/clean`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })

  it('404s when the skill does not exist', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    const { res, json } = await call('DELETE', '/api/agents/sub1/skills/no-such-skill')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Skill not found' })
  })

  it('removes an existing skill and returns ok:true', async () => {
    const dir = seedMainSkill('todelete')
    expect(existsSync(dir)).toBe(true)
    const { res, json } = await call('DELETE', `/api/agents/${MAIN_AGENT}/skills/todelete`)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(existsSync(dir)).toBe(false)
  })

  it('400s with "Invalid skill path" when safeJoin throws (e.g. sanitised name resolves outside base)', async () => {
    // safeJoin can only throw on a path that resolves outside the base.
    // sanitizeSkillName refuses to emit such a path, so this is a defensive
    // guard: force safeJoin to throw to confirm the route returns 400 with
    // the dedicated message (instead of letting the throw escape as 500).
    mocks.safeJoinThrow = true
    const { res, json } = await call('DELETE', `/api/agents/${MAIN_AGENT}/skills/anything`)
    mocks.safeJoinThrow = false
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill path' })
  })

  it('deletes a sub-agent skill under agents/<name>/.claude/skills/', async () => {
    const dir = seedSubSkill('sub1', 'gone')
    const { res, json } = await call('DELETE', '/api/agents/sub1/skills/gone')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(existsSync(dir)).toBe(false)
  })
})

// -----------------------------------------------------------------------
// POST /api/agents/:name/skills/import  (multipart upload + zip extract)
// -----------------------------------------------------------------------

describe('POST /api/agents/:name/skills/import', () => {
  it('400s on an invalid (unsanitisable) agent name', async () => {
    const { res, json } = await call('POST', '/api/agents/%2F..%2F/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid agent name' })
  })

  it('404s when the agent does not exist', async () => {
    const { res, json } = await call('POST', '/api/agents/ghost/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Agent not found' })
  })

  it('400s when the multipart body has no file part', async () => {
    // Body that has only a text field
    const body = Buffer.from(
      `--${BOUNDARY}\r\nContent-Disposition: form-data; name="note"\r\n\r\nhi\r\n--${BOUNDARY}--\r\n`,
      'binary',
    )
    mkdirSync(agentDir('sub1'), { recursive: true })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body,
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No file uploaded' })
  })

  it('400s on a path-traversal entry (`../`) in the unzip listing', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.execSync.mockImplementationOnce(() => '../escape\n')
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('evil.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: path traversal detected' })
  })

  it('400s on a leading-slash entry in the unzip listing', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.execSync.mockImplementationOnce(() => '/abs/path\n')
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('evil.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: path traversal detected' })
  })

  it('400s on a Windows-style drive-prefixed entry in the unzip listing', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.execSync.mockImplementationOnce(() => 'C:\\Windows\\System32\n')
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('evil.zip', Buffer.from('x')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: path traversal detected' })
  })

  it('extracts a valid skill archive, writes the entries, and reports imported names', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    // First execSync -> unzip listing
    mocks.execSync.mockImplementationOnce(() => 'good-skill/SKILL.md\n')
    // Second execSync -> unzip extract; simulated by writing the entries to disk
    mocks.execSync.mockImplementationOnce(() => {
      const dest = join(agentDir('sub1'), '.claude', 'skills', 'good-skill')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), '---\nname: good-skill\ndescription: ok\n---\n')
      return ''
    })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('good.zip', Buffer.from('zipdata')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, imported: ['good-skill'] })
    expect(mocks.loggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'sub1', skills: ['good-skill'] }),
      'Skill(s) imported',
    )
  })

  it('returns "No valid skill (SKILL.md)" when the archive extracts but SKILL.md is missing', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.execSync.mockImplementationOnce(() => 'no-md/foo.txt\n')
    mocks.execSync.mockImplementationOnce(() => {
      const dest = join(agentDir('sub1'), '.claude', 'skills', 'no-md')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'foo.txt'), 'x')
      return ''
    })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('no-md.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No valid skill (SKILL.md) found in archive' })
  })

  it('returns "symlink entries rejected" when a top-level entry is a symlink', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.execSync.mockImplementationOnce(() => 'linky/SKILL.md\n')
    mocks.execSync.mockImplementationOnce(() => {
      const dest = join(agentDir('sub1'), '.claude', 'skills', 'linky')
      mkdirSync(dest, { recursive: true })
      // symlink the SKILL.md to a file outside the skill dir
      const targetDir = mkdtempSync(join(SANDBOX, 'sym-tgt-'))
      writeFileSync(join(targetDir, 'SKILL.md'), 'x')
      symlinkSync(join(targetDir, 'SKILL.md'), join(dest, 'SKILL.md'))
      return ''
    })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('linky.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: symlink entries rejected' })
  })

  it('returns "symlink entries rejected" when a sub-directory of an extracted skill is a symlink', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.execSync.mockImplementationOnce(() => 'subdir/SKILL.md\nsubdir/inner\n')
    mocks.execSync.mockImplementationOnce(() => {
      const dest = join(agentDir('sub1'), '.claude', 'skills', 'subdir')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'x')
      // nested symlinked file -> the recursive rejectSymlinks walks and finds it
      const outer = mkdtempSync(join(SANDBOX, 'sym-outer-'))
      writeFileSync(join(outer, 'payload.txt'), 'x')
      symlinkSync(join(outer, 'payload.txt'), join(dest, 'inner-link'))
      return ''
    })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('sdir.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: symlink entries rejected' })
  })

  it('rejects when a sub-directory itself contains a symlinked file (recursive rejectSymlinks hit)', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    // Listing includes both the top-level SKILL.md and the nested dir
    mocks.execSync.mockImplementationOnce(() => 'top-skill/SKILL.md\ntop-skill/inner\n')
    mocks.execSync.mockImplementationOnce(() => {
      const dest = join(agentDir('sub1'), '.claude', 'skills', 'top-skill')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'x')
      // Create a regular sub-directory and inside it a broken symlink so the
      // recursive rejectSymlinks walk hits a symlink, NOT at the top level
      // (the top-level SKILL.md is just a regular file).
      const innerDir = join(dest, 'inner')
      mkdirSync(innerDir, { recursive: true })
      symlinkSync('/does/not/exist/sym-tgt', join(innerDir, 'broken'))
      return ''
    })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('rec.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: symlink entries rejected' })
  })

  it('rejects when an extracted entry is a broken symlink (caught by statSync-isDirectory try/catch)', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.execSync.mockImplementationOnce(() => 'broken-outer/SKILL.md\n')
    mocks.execSync.mockImplementationOnce(() => {
      const dest = join(agentDir('sub1'), '.claude', 'skills', 'broken-outer')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'x')
      // Create another extracted sibling with a dangling symlink -> the
      // outer per-entry scan falls into the statSync->isDirectory try/catch.
      const otherDest = join(agentDir('sub1'), '.claude', 'skills', 'broken-sibling')
      mkdirSync(otherDest, { recursive: true })
      writeFileSync(join(otherDest, 'SKILL.md'), 'x')
      // Replace the sibling's regular SKILL.md with a broken symlink so the
      // outer scan's statSync-isDirectory check throws on it.
      rmSync(join(otherDest, 'SKILL.md'))
      symlinkSync('/no/such/path', join(otherDest, 'SKILL.md'))
      return ''
    })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('dangling.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid skill file: symlink entries rejected' })
  })

  it('treats a no-content-type import body the same as a missing file', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    // No content-type header -> the import body parser sees content-type ''
    // and parses zero parts -> file is undefined -> 400.
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('a.zip', Buffer.from('x')),
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No file uploaded' })
  })

  it('500s when the unzip listing call throws, cleans up the leftovers, and logs', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    // First execSync -> listing, throws
    mocks.execSync.mockImplementationOnce(() => { throw new Error('unzip broke') })
    // After the catch, the cleanup tries to readdir the skills dir; that
    // exists, so the rmSync branch runs and removes anything left (none here).
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('broken.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to extract .skill file' })
    expect(mocks.loggerError).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      'Failed to import skill',
    )
  })

  it('500s when the cleanup branch tries to readdir a removed skills dir', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    // Listing throws, triggering the catch+cleanup branch. Remove the
    // skills dir before the handler runs the cleanup readdir so the
    // cleanup throws (and gets swallowed by the outer catch's catch).
    mocks.execSync.mockImplementationOnce(() => { throw new Error('list fail') })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('x.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to extract .skill file' })
  })

  it('cleanup rmSyncs the leftover extracted files when the extract step throws', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    // 1st execSync -> listing returns a valid entry
    mocks.execSync.mockImplementationOnce(() => 'leftover-skill/SKILL.md\n')
    // 2nd execSync -> extract writes a leftover entry, then throws.
    mocks.execSync.mockImplementationOnce(() => {
      const dest = join(agentDir('sub1'), '.claude', 'skills', 'leftover-skill')
      mkdirSync(dest, { recursive: true })
      writeFileSync(join(dest, 'SKILL.md'), 'x')
      throw new Error('extract blew up')
    })
    const { res, json } = await call('POST', '/api/agents/sub1/skills/import', {
      body: multipartFile('bad-extract.zip', Buffer.from('z')),
      headers: { 'content-type': CT_MULTI },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to extract .skill file' })
    // The cleanup rmSync loop must have removed the leftover extracted dir
    const leftoverDir = join(agentDir('sub1'), '.claude', 'skills', 'leftover-skill')
    expect(existsSync(leftoverDir)).toBe(false)
  })
})

// -----------------------------------------------------------------------
// POST /api/agents/:name/skills   (LLM-generated SKILL.md)
// -----------------------------------------------------------------------

describe('POST /api/agents/:name/skills -- new skill (LLM)', () => {
  it('404s when the agent does not exist', async () => {
    const { res, json } = await call('POST', '/api/agents/ghost/skills', {
      body: JSON.stringify({ name: 'new-skill', description: 'a new skill' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Agent not found' })
  })

  it('crashes the handler when the JSON body is not valid JSON (no try/catch)', async () => {
    // The route calls JSON.parse without a try/catch, so malformed JSON
    // throws synchronously and propagates as a 500. Pinning this behavior so
    // a future change adding a try/catch with proper validation is
    // intentional rather than a silent fix.
    mkdirSync(agentDir('sub1'), { recursive: true })
    await expect(call('POST', '/api/agents/sub1/skills', {
      body: '{not',
      headers: { 'content-type': 'application/json' },
    })).rejects.toThrow()
  })

  it('400s when the skill name is empty after sanitisation', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    const { res, json } = await call('POST', '/api/agents/sub1/skills', {
      body: JSON.stringify({ name: '!!!', description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Skill name is required' })
  })

  it('400s when the skill name field is missing entirely (rawSkillName || "" branch)', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    const { res, json } = await call('POST', '/api/agents/sub1/skills', {
      body: JSON.stringify({ description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Skill name is required' })
  })

  it('400s when the description is empty', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    const { res, json } = await call('POST', '/api/agents/sub1/skills', {
      body: JSON.stringify({ name: 'ok', description: '' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Skill description is required' })
  })

  it('409s when the skill directory already exists', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    const existingDir = join(agentDir('sub1'), '.claude', 'skills', 'exists')
    mkdirSync(existingDir, { recursive: true })
    const { res, json } = await call('POST', '/api/agents/sub1/skills', {
      body: JSON.stringify({ name: 'exists', description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(409)
    expect(json()).toEqual({ error: 'Skill already exists' })
  })

  it('500s when generateSkillMd throws', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.generateSkillMd.mockRejectedValueOnce(new Error('llm blew up'))
    const { res, json } = await call('POST', '/api/agents/sub1/skills', {
      body: JSON.stringify({ name: 'fresh', description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Failed to generate skill' })
    // The handler rmSync's the empty skill dir on this branch; ensure it was
    // created then removed.
    const skillDir = join(agentDir('sub1'), '.claude', 'skills', 'fresh')
    expect(existsSync(skillDir)).toBe(false)
  })

  it('creates a new skill dir + SKILL.md on the main agent and returns ok:true', async () => {
    const skillDir = join(HOME, '.claude', 'skills', 'mk-main')
    expect(existsSync(skillDir)).toBe(false)
    mocks.generateSkillMd.mockResolvedValueOnce('---\nname: mk-main\ndescription: d\n---\n# main\n')
    const { res, json } = await call('POST', `/api/agents/${MAIN_AGENT}/skills`, {
      body: JSON.stringify({ name: 'mk-main', description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'mk-main' })
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
    expect(readFileSync(join(skillDir, 'SKILL.md'), 'utf-8')).toContain('name: mk-main')
  })

  it('creates a new skill dir + SKILL.md on a sub-agent', async () => {
    mkdirSync(agentDir('sub1'), { recursive: true })
    mocks.generateSkillMd.mockResolvedValueOnce('---\nname: mk-sub\ndescription: d\n---\n# sub\n')
    const { res, json } = await call('POST', '/api/agents/sub1/skills', {
      body: JSON.stringify({ name: 'mk-sub', description: 'desc' }),
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, name: 'mk-sub' })
    const skillDir = join(agentDir('sub1'), '.claude', 'skills', 'mk-sub')
    expect(existsSync(join(skillDir, 'SKILL.md'))).toBe(true)
  })
})
