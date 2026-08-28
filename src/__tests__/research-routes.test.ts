// 100% coverage suite for src/web/routes/research.ts.
//
// tryHandleResearch owns two read-only HTTP endpoints for each agent's
// research/ folder:
//
//   GET /api/research                  -> list {agent, docs[]} per agent
//   GET /api/research/<agent>/<file>   -> single doc {agent, name, title, content}
//
// Everything is gated through the bearer-token middleware upstream
// (auth-gate.ts), so this module only reads the filesystem. Nothing is
// writable; filenames pass NAME_RE (a character-class allowlist that
// excludes path separators) and the agent segment is allowlisted
// against [MAIN_AGENT_ID, ...listAgentNames()] before any filesystem call.
//
// Sandbox: PROJECT_ROOT is pinned at a tmpdir-scoped value via the mocked
// config.js; the listed db/config/logger/auth-gate/auth-sessions collaborators
// are stubbed so their side-effects never fire. agent-config.js is partially
// stubbed -- agentConfigRoot + listAgentNames are overridden to resolve under
// the sandbox, agentDir is left alone because research.ts does not call it.
// http-helpers.js is left real so the json() side-effects (writeHead + end)
// are exercised end-to-end through the fake res.

import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest'
import { mkdirSync, rmSync, writeFileSync, utimesSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir } from './setup/temp-sandbox.js'
import type { RouteContext } from '../web/routes/types.js'

const SANDBOX = mkTempDir('research-routes-')
const AGENTS_TMP = join(SANDBOX, 'agents')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual },
    {
      PROJECT_ROOT: { get: () => SANDBOX, enumerable: true },
    },
  )
})
vi.mock('../web/agent-config.js', async (orig) => {
  const actual = await orig<typeof import('../web/agent-config.js')>()
  const { MAIN_AGENT_ID } = await import('../config.js')
  return {
    ...actual,
    AGENTS_BASE_DIR: AGENTS_TMP,
    agentDir: (name: string) => join(AGENTS_TMP, name),
    agentConfigRoot: (name: string) => (name === MAIN_AGENT_ID ? SANDBOX : join(AGENTS_TMP, name)),
    listAgentNames: () => {
      // Force-rebuild the agent list on every call so tests that mutate the
      // agents/ tree (e.g. removing the research dir of a sub-agent) are
      // observable without process restart.
      const { existsSync, readdirSync, statSync } = require('node:fs') as typeof import('node:fs')
      if (!existsSync(AGENTS_TMP)) return []
      return readdirSync(AGENTS_TMP).filter((f) => {
        try { return statSync(join(AGENTS_TMP, f)).isDirectory() } catch { return false }
      })
    },
  }
})
vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))
vi.mock('../logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}))
vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Import AFTER every mock is registered.
const { tryHandleResearch } = await import('../web/routes/research.js')
const { PROJECT_ROOT, MAIN_AGENT_ID } = await import('../config.js')
const { agentConfigRoot } = await import('../web/agent-config.js')

// -----------------------------------------------------------------------
// HTTP harness
// -----------------------------------------------------------------------
interface Out { status: number; body: any }
function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: Out } {
  const out: Out = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url, fedPeer: null } as RouteContext
  return { ctx, out }
}

// -----------------------------------------------------------------------
// Fixture helpers
// -----------------------------------------------------------------------
const SUB_AGENT_ID = 'zz-research-test-sub'
const SUB_DIR = join(AGENTS_TMP, SUB_AGENT_ID)
const SUB_RESEARCH_DIR = join(SUB_DIR, 'research')
const MAIN_RESEARCH_DIR = join(SANDBOX, 'research')

function seedMain(name: string, body = `# Main Doc\n\nBody\n`): string {
  mkdirSync(MAIN_RESEARCH_DIR, { recursive: true })
  const p = join(MAIN_RESEARCH_DIR, name)
  writeFileSync(p, body)
  return p
}
function seedSub(name: string, body = `# Sub Doc\n\nBody\n`): string {
  mkdirSync(SUB_RESEARCH_DIR, { recursive: true })
  const p = join(SUB_RESEARCH_DIR, name)
  writeFileSync(p, body)
  return p
}
function cleanFixtures(): void {
  rmSync(SUB_DIR, { recursive: true, force: true })
  rmSync(MAIN_RESEARCH_DIR, { recursive: true, force: true })
}

describe('research routes', () => {
  beforeAll(() => {
    // Guarantee the sub-agent directory exists so listAgentNames() picks it up.
    mkdirSync(SUB_DIR, { recursive: true })
  })
  afterAll(() => {
    rmSync(SANDBOX, { recursive: true, force: true })
  })
  beforeEach(() => {
    mkdirSync(SUB_RESEARCH_DIR, { recursive: true })
    mkdirSync(MAIN_RESEARCH_DIR, { recursive: true })
    seedSub('alpha.md', '# Alpha Report\n\nBody\n')
    seedMain('zz-test-main-research.md', '# Main Research\n\nBody\n')
  })
  afterEach(() => cleanFixtures())

  // -----------------------------------------------------------------------
  // GET /api/research -- list endpoint
  // -----------------------------------------------------------------------

  it('lists seeded docs for sub-agent and main agent', async () => {
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    const sub = out.body.find((a: any) => a.agent === SUB_AGENT_ID)
    expect(sub?.docs.map((d: any) => d.name)).toContain('alpha.md')
    expect(sub?.docs.find((d: any) => d.name === 'alpha.md')?.title).toBe('Alpha Report')
    const main = out.body.find((a: any) => a.agent === MAIN_AGENT_ID)
    expect(main?.docs.map((d: any) => d.name)).toContain('zz-test-main-research.md')
  })

  it('uses the filename as title when no H1 heading is present', async () => {
    // Replace alpha.md with content that has no leading # heading.
    writeFileSync(join(SUB_RESEARCH_DIR, 'alpha.md'), 'No heading here, just prose.\n')
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const sub = out.body.find((a: any) => a.agent === SUB_AGENT_ID)
    expect(sub.docs.find((d: any) => d.name === 'alpha.md').title).toBe('alpha.md')
  })

  it('reports an empty list when an agent has no research directory', async () => {
    // Strip the sub-agent's research/ folder so readdirSync throws ENOENT.
    rmSync(SUB_RESEARCH_DIR, { recursive: true, force: true })
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    // Main still has docs; sub-agent entry is dropped by .filter(a => a.docs.length > 0).
    expect(out.body.find((a: any) => a.agent === SUB_AGENT_ID)).toBeUndefined()
    expect(out.body.find((a: any) => a.agent === MAIN_AGENT_ID)?.docs.length).toBeGreaterThan(0)
  })

  it('returns an empty list when no agent has any docs', async () => {
    rmSync(MAIN_RESEARCH_DIR, { recursive: true, force: true })
    rmSync(SUB_RESEARCH_DIR, { recursive: true, force: true })
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('skips non-md entries and md-named directories in the listing', async () => {
    // Add a notes.txt (rejected by NAME_RE) and a subdir.md/ directory
    // (passes NAME_RE but statSync.isFile() is false).
    writeFileSync(join(SUB_RESEARCH_DIR, 'notes.txt'), 'ignore me')
    mkdirSync(join(SUB_RESEARCH_DIR, 'subdir.md'))
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const sub = out.body.find((a: any) => a.agent === SUB_AGENT_ID)
    expect(sub.docs.map((d: any) => d.name)).toEqual(['alpha.md'])
  })

  it('sorts docs newest-first by mtimeMs and falls back to name on tie', async () => {
    // Pin every file's mtime to a fixed instant so the comparator is fully
    // deterministic across filesystems with different timestamp resolutions.
    const alphaPath = join(SUB_RESEARCH_DIR, 'alpha.md')
    const samePath = seedSub('same.md', '# Same\n')
    const oldPath = seedSub('z-old.md', '# Old Report\n')

    const NEW_TIME = new Date(1_700_000_000_000)
    const OLD_TIME = new Date(1_700_000_000_000 - 60_000)
    utimesSync(alphaPath, NEW_TIME, NEW_TIME)
    utimesSync(samePath, NEW_TIME, NEW_TIME)
    utimesSync(oldPath, OLD_TIME, OLD_TIME)

    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const sub = out.body.find((a: any) => a.agent === SUB_AGENT_ID)
    // alpha and same have identical mtime -> alphabetical tiebreak (alpha < same).
    // Both are newer than z-old.md.
    expect(sub.docs.map((d: any) => d.name)).toEqual(['alpha.md', 'same.md', 'z-old.md'])
  })

  it('orders files with different mtimes newest-first regardless of name', async () => {
    // Sort path that exercises the `(b.ms - a.ms)` short-circuit: every pair
    // has a different mtime, so localeCompare is never consulted.
    const alphaPath = join(SUB_RESEARCH_DIR, 'alpha.md')
    const oldPath = seedSub('z-old.md', '# Old Report\n')

    const NEW_TIME = new Date(1_700_000_000_000)
    const OLD_TIME = new Date(1_700_000_000_000 - 60_000)
    utimesSync(alphaPath, NEW_TIME, NEW_TIME)
    utimesSync(oldPath, OLD_TIME, OLD_TIME)

    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const sub = out.body.find((a: any) => a.agent === SUB_AGENT_ID)
    expect(sub.docs.map((d: any) => d.name)).toEqual(['alpha.md', 'z-old.md'])
  })

  // -----------------------------------------------------------------------
  // GET /api/research/<agent>/<file> -- single-doc endpoint
  // -----------------------------------------------------------------------

  it('serves a single doc with content and H1-derived title', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/alpha.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.content).toContain('Alpha Report')
    expect(out.body.title).toBe('Alpha Report')
    expect(out.body.name).toBe('alpha.md')
    expect(out.body.agent).toBe(SUB_AGENT_ID)
  })

  it('serves a single doc from the main agent directory', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${MAIN_AGENT_ID}/zz-test-main-research.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.title).toBe('Main Research')
  })

  it('rejects encoded path traversal in the file name', async () => {
    // %2e%2e%2f => "../" after the handler's decodeURIComponent
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/%2e%2e%2f%2e%2e%2fsecret.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('Invalid file name')
  })

  it('rejects traversal aimed at dotfiles outside research/', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/%2e%2e%2f.env`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('rejects non-.md file names', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/notes.txt`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('returns 400 when the encoded filename is malformed (stray percent)', async () => {
    // %G0 is not valid hex after the %, so decodeURIComponent throws URIError.
    // Before the fix this throw escaped the handler and produced a 500 from web.ts.
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/foo%G0.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body.error).toBe('Invalid file name')
  })

  it('rejects unknown agents', async () => {
    const { ctx, out } = fakeCtx('/api/research/zz-no-such-agent/alpha.md')
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('Unknown agent')
  })

  it('404s on a missing but well-formed file name', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/missing.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('Not found')
  })

  it('404s when the resolved path is a directory rather than a file', async () => {
    mkdirSync(join(SUB_RESEARCH_DIR, 'looks-like-file.md'))
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/looks-like-file.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  it('uses the filename as title when the single-doc body has no H1 heading', async () => {
    writeFileSync(join(SUB_RESEARCH_DIR, 'alpha.md'), 'plain text only\n')
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/alpha.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.body.title).toBe('alpha.md')
  })

  // -----------------------------------------------------------------------
  // Non-matching routes -- returned false
  // -----------------------------------------------------------------------

  it('ignores non-research paths', async () => {
    const { ctx } = fakeCtx('/api/agents')
    expect(await tryHandleResearch(ctx)).toBe(false)
  })

  it('ignores POST /api/research (wrong method on the list endpoint)', async () => {
    const { ctx, out } = fakeCtx('/api/research', 'POST')
    expect(await tryHandleResearch(ctx)).toBe(false)
    expect(out.status).toBe(0) // nothing written
  })

  it('ignores non-GET methods on the single-doc endpoint', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/alpha.md`, 'DELETE')
    expect(await tryHandleResearch(ctx)).toBe(false)
    expect(out.status).toBe(0)
  })

  it('returns false for too many path segments under /api/research/<a>/<f>', async () => {
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/extra/alpha.md`)
    expect(await tryHandleResearch(ctx)).toBe(false)
    expect(out.status).toBe(0)
  })

  it('returns false for GET /api/research without a file segment', async () => {
    // /api/research/<agent> alone does not match the single-doc regex.
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}`)
    expect(await tryHandleResearch(ctx)).toBe(false)
    expect(out.status).toBe(0)
  })

  // -----------------------------------------------------------------------
  // Symlink-traversal regression (routes-research-symlink-traversal P1 SEC)
  // -----------------------------------------------------------------------

  it('404s on a single-doc path that is a symlink, even if the target is readable', async () => {
    // Plant agents/<sub>/research/leak.md -> /etc/passwd. Before the fix,
    // existsSync + statSync followed the link, so /api/research/<sub>/leak.md
    // served /etc/passwd verbatim. After the fix, statSync(throwIfNoEntry:false)
    // plus !st.isFile() || st.isSymbolicLink() short-circuits to 404.
    symlinkSync('/etc/passwd', join(SUB_RESEARCH_DIR, 'leak.md'))
    const { ctx, out } = fakeCtx(`/api/research/${SUB_AGENT_ID}/leak.md`)
    expect(await tryHandleResearch(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body.error).toBe('Not found')
  })

  it('excludes symlinks from the listing even when they point at readable files', async () => {
    // Same fixture, but on the listing branch: Dirent.isSymbolicLink() filter
    // drops the entry without ever calling statSync on it.
    symlinkSync('/etc/passwd', join(SUB_RESEARCH_DIR, 'leak.md'))
    const { ctx, out } = fakeCtx('/api/research')
    expect(await tryHandleResearch(ctx)).toBe(true)
    const sub = out.body.find((a: any) => a.agent === SUB_AGENT_ID)
    expect(sub.docs.map((d: any) => d.name)).not.toContain('leak.md')
    expect(sub.docs.map((d: any) => d.name)).toContain('alpha.md')
  })

  // -----------------------------------------------------------------------
  // Sanity: agentConfigRoot mock wiring matches what research.ts expects
  // -----------------------------------------------------------------------

  it('routes main-agent research files to SANDBOX/research/', () => {
    expect(agentConfigRoot(MAIN_AGENT_ID)).toBe(SANDBOX)
    expect(agentConfigRoot(MAIN_AGENT_ID)).toBe(PROJECT_ROOT)
    expect(agentConfigRoot(SUB_AGENT_ID)).toBe(SUB_DIR)
  })
})