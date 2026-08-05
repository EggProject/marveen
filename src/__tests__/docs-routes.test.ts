// Functional tests for the read-only docs viewer (routes/docs.ts).
// Mirrors research-routes.test.ts: real handler under a sandboxed PROJECT_ROOT,
// emphasis on the path-traversal arm of /api/docs/:name and the error fall-
// backs inside the listing path. No db/auth/session wiring is needed -- docs.ts
// imports none of those modules.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'os'
import type { RouteContext } from '../web/routes/types.js'

// ENFORCED sandbox: PROJECT_ROOT is redirected into an mkdtemp root before the
// route module loads so the handler reads / writes inside the temp tree, not
// the live repo. The earlier research-routes suite did the same thing for the
// same reason -- a previous docs test left <repoRoot>/docs/ fixtures behind
// after running, which is the exact failure mode this guard prevents.
const tmpRoot = mkdtempSync(join(tmpdir(), 'docs-routes-'))
const DOCS_TMP = join(tmpRoot, 'docs')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: tmpRoot }
})

// Per-test fault injector for node:fs. Tests set statFault.readFileSync to a
// path-suffix string to force a synchronous throw from the readFileSync call
// inside the per-file try block; set statFault.statSync to a builder that
// mutates the stat object (used to coerce birthtimeMs to 0). Default =
// pass-through. ESM exports are non-configurable so vi.spyOn cannot redefine
// them -- the Proxy approach below is the canonical workaround in this repo.
const fsFault: {
  readFileSync?: { suffix: string; message: string }
  statSync?: { suffix: string; builder: (s: import('node:fs').Stats) => import('node:fs').Stats }
} = {}
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'readFileSync' && fsFault.readFileSync) {
        const fault = fsFault.readFileSync
        return ((p: unknown, ...rest: unknown[]) => {
          if (typeof p === 'string' && p.endsWith(fault.suffix)) {
            throw new Error(fault.message)
          }
          return target.readFileSync(p as Parameters<typeof target.readFileSync>[0], ...(rest as [Parameters<typeof target.readFileSync>[1]]))
        }) as typeof target.readFileSync
      }
      if (prop === 'statSync' && fsFault.statSync) {
        const fault = fsFault.statSync
        return ((p: unknown, ...rest: unknown[]) => {
          const s = target.statSync(p as Parameters<typeof target.statSync>[0], ...(rest as [Parameters<typeof target.statSync>[1]]))
          if (typeof p === 'string' && p.endsWith(fault.suffix)) {
            return fault.builder(s)
          }
          return s
        }) as typeof target.statSync
      }
      if (prop === 'readdirSync') {
        return ((p: unknown, ...rest: unknown[]) => {
          const r = target.readdirSync(p as Parameters<typeof target.readdirSync>[0], ...(rest as [Parameters<typeof target.readdirSync>[1]]))
          // eslint-disable-next-line no-console
          if (typeof p === 'string' && p.includes('docs-routes')) console.log('PROXY readdirSync', p, '->', r)
          return r
        }) as typeof target.readdirSync
      }
      return Reflect.get(target, prop, receiver)
    },
  })
})

const { tryHandleDocs } = await import('../web/routes/docs.js')

function fakeCtx(path: string, method = 'GET'): { ctx: RouteContext; out: { status: number; body: any } } {
  const out: { status: number; body: any } = { status: 0, body: null }
  const res: any = {
    writeHead(status: number) { out.status = status; return res },
    end(chunk?: string) { if (chunk !== undefined && chunk !== null) out.body = JSON.parse(chunk) },
  }
  const url = new URL(`http://localhost:3420${path}`)
  const ctx = { req: {} as any, res, path: url.pathname, method, url } as RouteContext
  return { ctx, out }
}

describe('docs routes', () => {
  beforeEach(() => {
    mkdirSync(DOCS_TMP, { recursive: true })
    fsFault.readFileSync = undefined
    fsFault.statSync = undefined
  })
  afterEach(() => {
    rmSync(DOCS_TMP, { recursive: true, force: true })
  })

  // -- /api/docs list --------------------------------------------------

  it('lists markdown files with parsed title and created date', async () => {
    writeFileSync(join(DOCS_TMP, 'alpha.md'), '# Alpha Title\n\nbody')
    writeFileSync(join(DOCS_TMP, 'beta.md'), '# Beta Title\n\nbody')
    const { ctx, out } = fakeCtx('/api/docs')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toHaveLength(2)
    const alpha = out.body.find((d: any) => d.name === 'alpha.md')
    expect(alpha.title).toBe('Alpha Title')
    expect(typeof alpha.created).toBe('string')
    expect(alpha.created).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(out.body.every((d: any) => !('ms' in d))).toBe(true)
  })

  it('falls back to the filename when the file has no heading', async () => {
    writeFileSync(join(DOCS_TMP, 'no-heading.md'), 'plain body, no title line\n')
    const { ctx, out } = fakeCtx('/api/docs')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.body[0].title).toBe('no-heading.md')
  })

  it('returns empty list when DOCS_DIR does not exist', async () => {
    rmSync(DOCS_TMP, { recursive: true, force: true })
    const { ctx, out } = fakeCtx('/api/docs')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body).toEqual([])
  })

  it('skips non-markdown files and directories', async () => {
    writeFileSync(join(DOCS_TMP, 'keep.md'), '# Keep\n')
    writeFileSync(join(DOCS_TMP, 'ignore.txt'), 'not a doc')
    mkdirSync(join(DOCS_TMP, 'subdir'))
    const { ctx, out } = fakeCtx('/api/docs')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.body.map((d: any) => d.name)).toEqual(['keep.md'])
  })

  it('sorts by mtime desc and tie-breaks by name asc', async () => {
    writeFileSync(join(DOCS_TMP, 'a-older.md'), '# A\n')
    writeFileSync(join(DOCS_TMP, 'b-newer.md'), '# B\n')
    utimesSync(join(DOCS_TMP, 'a-older.md'), new Date(1000_000_000_000), new Date(1000_000_000_000))
    utimesSync(join(DOCS_TMP, 'b-newer.md'), new Date(2000_000_000_000), new Date(2000_000_000_000))
    const { ctx, out } = fakeCtx('/api/docs')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.body.map((d: any) => d.name)).toEqual(['b-newer.md', 'a-older.md'])
  })

  it('falls back to filename title when readFileSync throws on a file', async () => {
    writeFileSync(join(DOCS_TMP, 'broken.md'), 'x')
    fsFault.readFileSync = { suffix: 'broken.md', message: 'synthetic read failure' }
    const { ctx, out } = fakeCtx('/api/docs')
    expect(await tryHandleDocs(ctx)).toBe(true)
    const broken = out.body.find((d: any) => d.name === 'broken.md')
    expect(broken.title).toBe('broken.md')
    expect(broken.created).toBeNull()
  })

  it('falls back to mtime when birthtimeMs is zero', async () => {
    writeFileSync(join(DOCS_TMP, 'no-birth.md'), '# X\n')
    fsFault.statSync = {
      suffix: 'no-birth.md',
      builder: (s) => ({ ...s, birthtimeMs: 0 }),
    }
    const { ctx, out } = fakeCtx('/api/docs')
    expect(await tryHandleDocs(ctx)).toBe(true)
    const item = out.body.find((d: any) => d.name === 'no-birth.md')
    expect(item).toBeDefined()
    // mtime-derived ISO date should still be present (not the epoch).
    expect(item.created).not.toBe('1970-01-01')
    expect(item.created).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  // -- /api/docs/:name single -------------------------------------------

  it('serves a single doc with title and content', async () => {
    writeFileSync(join(DOCS_TMP, 'guide.md'), '# Guide\n\ncontents here')
    const { ctx, out } = fakeCtx('/api/docs/guide.md')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.status).toBe(200)
    expect(out.body.name).toBe('guide.md')
    expect(out.body.title).toBe('Guide')
    expect(out.body.content).toBe('# Guide\n\ncontents here')
  })

  it('rejects a non-markdown filename', async () => {
    const { ctx, out } = fakeCtx('/api/docs/notes.txt')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.status).toBe(400)
    expect(out.body).toEqual({ error: 'Invalid doc name' })
  })

  it('rejects encoded path traversal in the file name', async () => {
    // %2e%2e%2f -> "../" after decodeURIComponent; the basename() check catches it.
    const { ctx, out } = fakeCtx('/api/docs/%2e%2e%2fsecret.md')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.status).toBe(400)
  })

  it('404s on a missing but well-formed file name', async () => {
    const { ctx, out } = fakeCtx('/api/docs/missing.md')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.status).toBe(404)
    expect(out.body).toEqual({ error: 'Not found' })
  })

  it('404s when the path resolves to a directory', async () => {
    mkdirSync(join(DOCS_TMP, 'looks-like-a-doc.md'))
    const { ctx, out } = fakeCtx('/api/docs/looks-like-a-doc.md')
    expect(await tryHandleDocs(ctx)).toBe(true)
    expect(out.status).toBe(404)
  })

  // -- not-my-route ----------------------------------------------------

  it('ignores non-docs paths', async () => {
    const { ctx } = fakeCtx('/api/agents')
    expect(await tryHandleDocs(ctx)).toBe(false)
  })

  it('ignores POST on /api/docs', async () => {
    const { ctx } = fakeCtx('/api/docs', 'POST')
    expect(await tryHandleDocs(ctx)).toBe(false)
  })

  it('ignores nested paths past /api/docs/<name>', async () => {
    const { ctx } = fakeCtx('/api/docs/foo/bar')
    expect(await tryHandleDocs(ctx)).toBe(false)
  })
})
