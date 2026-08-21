// 100% coverage suite for src/web/routes/docs.ts.
//
// tryHandleDocs owns two read-only endpoints backed by the repo's docs/
// folder:
//
//   GET  /api/docs              -- list docs (name/title/created)
//   GET  /api/docs/<name>       -- fetch one doc's content + title
//
// DOCS_DIR is computed from PROJECT_ROOT (src/config.ts:12) at module load
// time, so we redirect PROJECT_ROOT into a tmpdir sandbox via vi.mock to
// keep the live checkout's docs/ untouched. We also wrap node:fs.statSync
// to drive the per-file inner catch (statSync throws -> filename fallback)
// and the birthtimeMs === 0 branch (mtimeMs fallback when the filesystem
// does not track birth time).

import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import type http from 'node:http'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// --- vi.hoisted: real fs via require() (bypasses the vi.mock applied to
//     ESM-style imports) + mock-state holders that the vi.mock factories
//     close over. vi.hoisted runs before static imports, so these handles
//     are guaranteed to be in place when the factory function bodies fire.

const hoisted = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const fs = require('node:fs') as typeof import('node:fs')
  return {
    realFs: fs,
    fsState: {
      statSyncOverride: undefined as ((p: string) => import('node:fs').Stats) | undefined,
    },
  }
})

// --- sandbox: PROJECT_ROOT -> tmpdir, so DOCS_DIR = <tmpdir>/docs ---------

const SANDBOX = mkdtempSync(join(tmpdir(), 'docs-routes-'))
const DOCS_DIR = join(SANDBOX, 'docs')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX }
})

// Wrap statSync only. readdirSync/readFileSync/existsSync pass through, so
// the happy paths read real files from the sandbox.
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return {
    ...actual,
    statSync: ((p: import('node:fs').PathLike) => {
      const ps = typeof p === 'string' ? p : p.toString()
      if (hoisted.fsState.statSyncOverride) return hoisted.fsState.statSyncOverride(ps)
      return actual.statSync(p)
    }) as typeof actual.statSync,
  }
})

const { tryHandleDocs } = await import('../web/routes/docs.js')

// --- HTTP harness ---------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
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
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

async function call(method: string, fullPath: string): Promise<{
  res: MockRes
  handled: boolean
  json: () => unknown
}> {
  const res = mkRes()
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const ctx = {
    req: {} as http.IncomingMessage,
    res: res as unknown as http.ServerResponse,
    path: url.pathname,
    method,
    url,
    fedPeer: null,
  }
  const handled = await tryHandleDocs(ctx)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : null) }
}

// --- lifecycle ------------------------------------------------------------

beforeAll(() => {
  mkdirSync(DOCS_DIR, { recursive: true })
})

beforeEach(() => {
  hoisted.fsState.statSyncOverride = undefined
  rmSync(DOCS_DIR, { recursive: true, force: true })
  mkdirSync(DOCS_DIR, { recursive: true })
})

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
})

// --- dispatcher surface ---------------------------------------------------

describe('tryHandleDocs -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for POST on /api/docs (only GET is handled)', async () => {
    const { handled } = await call('POST', '/api/docs')
    expect(handled).toBe(false)
  })

  it('returns false for PUT on /api/docs/<name> (only GET is handled)', async () => {
    writeFileSync(join(DOCS_DIR, 'valid.md'), '# valid')
    const { handled } = await call('PUT', '/api/docs/valid.md')
    expect(handled).toBe(false)
  })

  it('returns false for /api/docs/<name>/<extra> (regex requires single segment)', async () => {
    // The match regex `^/api/docs/([^/]+)$` excludes additional path
    // segments, so /api/docs/foo/bar.md falls through to `return false`.
    const { handled } = await call('GET', '/api/docs/foo/bar.md')
    expect(handled).toBe(false)
  })

  it('returns false for /api/docs/ (the regex requires a non-empty segment)', async () => {
    // The `[^/]+` group needs at least one character; the empty trailing
    // segment after /api/docs/ doesn't match.
    const { handled } = await call('GET', '/api/docs/')
    expect(handled).toBe(false)
  })
})

// --- GET /api/docs --------------------------------------------------------

describe('GET /api/docs', () => {
  it('returns an empty array when the docs directory does not exist (readdirSync ENOENT catch)', async () => {
    // readdirSync throws ENOENT -> caught -> files = []. This drives the
    // outer try/catch fallback. Tests the sandbox with DOCS_DIR removed.
    rmSync(DOCS_DIR, { recursive: true, force: true })
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('returns an empty array when the docs directory is empty', async () => {
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual([])
  })

  it('filters out non-markdown files (NAME_RE.allow)', async () => {
    writeFileSync(join(DOCS_DIR, 'real.md'), '# Real')
    writeFileSync(join(DOCS_DIR, 'skipme.txt'), 'not markdown')
    writeFileSync(join(DOCS_DIR, 'README'), 'no extension')
    writeFileSync(join(DOCS_DIR, 'no-md.markdown'), 'wrong extension')
    const { res, json } = await call('GET', '/api/docs')
    const docs = json() as Array<{ name: string }>
    expect(docs.map(d => d.name)).toEqual(['real.md'])
  })

  it('filters out subdirectories even when their name ends in .md (statSync.isFile)', async () => {
    writeFileSync(join(DOCS_DIR, 'file.md'), '# F')
    mkdirSync(join(DOCS_DIR, 'dir.md'))
    const { res, json } = await call('GET', '/api/docs')
    const docs = json() as Array<{ name: string }>
    expect(docs.map(d => d.name)).toEqual(['file.md'])
  })

  it('uses the first `# ...` heading as the title when present', async () => {
    writeFileSync(join(DOCS_DIR, 'has-heading.md'), '# My Title\n\nbody text')
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<{ name: string; title: string; created: string | null }>
    expect(docs).toHaveLength(1)
    expect(docs[0]).toMatchObject({ name: 'has-heading.md', title: 'My Title' })
  })

  it('trims whitespace from the extracted title', async () => {
    // `#   Padded Title   \nbody` -> titleOf trims -> 'Padded Title'.
    writeFileSync(join(DOCS_DIR, 'padded.md'), '#   Padded Title   \nbody')
    const { res, json } = await call('GET', '/api/docs')
    const docs = json() as Array<{ title: string }>
    expect(docs[0]?.title).toBe('Padded Title')
  })

  it('falls back to the filename when no `# heading` matches', async () => {
    // titleOf's regex `^#\s+(.+)$/m` only matches `^#<space>...`. A file with
    // no heading at all, or with `#Heading` (no space after #), falls back to
    // the filename.
    writeFileSync(join(DOCS_DIR, 'no-heading.md'), 'just body text\nno heading here')
    const { res, json } = await call('GET', '/api/docs')
    const docs = json() as Array<{ name: string; title: string }>
    expect(docs[0]).toMatchObject({ name: 'no-heading.md', title: 'no-heading.md' })
  })

  it('falls back to filename + null created when statSync throws for the file (inner catch)', async () => {
    // The per-file try/catch: readFileSync/titleOf succeed, then statSync
    // throws on the SECOND call (the one inside the .map) -> catch fires.
    // The FIRST statSync call (inside readdirSync().filter()) must succeed,
    // otherwise the OUTER catch fires and `files` becomes [] (different
    // branch). We arm the mock to succeed once per path, then throw on
    // subsequent calls for that path.
    //
    // The catch resets `title = name` so that a doc whose statSync throws
    // reports the filename as its title (matching the inner-catch comment),
    // and `created` stays null because the assignment is on the same line
    // as the throw site.
    writeFileSync(join(DOCS_DIR, 'broken.md'), '# Title\nbody')
    const seen = new Set<string>()
    hoisted.fsState.statSyncOverride = (p) => {
      if (!p.endsWith('broken.md')) return hoisted.realFs.statSync(p)
      if (!seen.has(p)) {
        seen.add(p)
        return hoisted.realFs.statSync(p)
      }
      throw new Error('mocked statSync failure for inner catch')
    }
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<{ name: string; title: string; created: string | null }>
    const broken = docs.find(d => d.name === 'broken.md')
    expect(broken).toEqual({ name: 'broken.md', title: 'broken.md', created: null })
  })

  it('PINNING routes-docs-inner-catch-no-title-reset: inner catch should reset title to filename when statSync throws after readFileSync', async () => {
    // The catch comment in src/web/routes/docs.ts says "keep filename as
    // title, created stays null"; this pins the fixed behaviour where the
    // catch actually resets `title = name` after titleOf had overwritten
    // it with the extracted `# heading`. Bug MD:
    // routes-docs-inner-catch-no-title-reset
    writeFileSync(join(DOCS_DIR, 'broken.md'), '# Real Title\nbody')
    const seen = new Set<string>()
    hoisted.fsState.statSyncOverride = (p) => {
      if (!p.endsWith('broken.md')) return hoisted.realFs.statSync(p)
      if (!seen.has(p)) {
        seen.add(p)
        return hoisted.realFs.statSync(p)
      }
      throw new Error('mocked statSync failure for inner catch')
    }
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<{ name: string; title: string; created: string | null }>
    const broken = docs.find(d => d.name === 'broken.md')
    expect(broken?.title).toBe('broken.md')
  })

  it('falls back to mtimeMs when birthtimeMs is 0 (filesystem does not track birthtime)', async () => {
    // The truthy branch of `s.birthtimeMs && s.birthtimeMs > 0` is false for
    // birthtimeMs === 0, so the ternary takes the mtimeMs branch. We pin
    // mtime to a known date so the assertion is exact.
    const known = new Date('2024-03-15T10:00:00Z')
    writeFileSync(join(DOCS_DIR, 'no-birthtime.md'), '# t')
    utimesSync(join(DOCS_DIR, 'no-birthtime.md'), known, known)
    hoisted.fsState.statSyncOverride = (p) => {
      const real = hoisted.realFs.statSync(p)
      ;(real as { birthtimeMs: number }).birthtimeMs = 0
      return real
    }
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<{ name: string; created: string | null }>
    expect(docs[0]?.created).toBe('2024-03-15')
  })

  it('formats created as YYYY-MM-DD (slice(0, 10) of an ISO string)', async () => {
    writeFileSync(join(DOCS_DIR, 'today.md'), '# t')
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<{ created: string | null }>
    expect(docs[0]?.created).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  // docs.ts sorts on `birthtimeMs` (falling back to mtimeMs only when the
  // filesystem reports 0), so a test must control BIRTHTIME, not mtime.
  //
  // utimesSync only sets atime/mtime. On macOS/APFS the kernel additionally
  // drags birthtime backwards to keep it <= mtime, so setting mtime happened to
  // set birthtime too and these tests passed. ext4 does no such thing: birthtime
  // stayed at "now" for all three files and the sort fell through to the name
  // tie-break, which is exactly how both tests failed on the first Linux CI run.
  //
  // Overriding statSync makes the intended ordering explicit and filesystem
  // independent. The real stat object is reused so isFile() still works.
  function stubTimes(msByName: Record<string, number>): void {
    hoisted.fsState.statSyncOverride = (p: string) => {
      const stat = hoisted.realFs.statSync(p)
      const ms = msByName[p.slice(p.lastIndexOf('/') + 1)]
      if (ms !== undefined) {
        stat.birthtimeMs = ms
        stat.mtimeMs = ms
      }
      return stat
    }
  }

  it('sorts newest-first by ms, tie-breaking by name ascending', async () => {
    for (const f of ['a.md', 'b.md', 'c.md']) writeFileSync(join(DOCS_DIR, f), `# ${f}`)
    stubTimes({
      'a.md': Date.parse('2024-01-01T00:00:00Z'),
      'b.md': Date.parse('2024-01-02T00:00:00Z'),
      'c.md': Date.parse('2024-01-03T00:00:00Z'),
    })
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<{ name: string }>
    expect(docs.map(d => d.name)).toEqual(['c.md', 'b.md', 'a.md'])
  })

  it('tie-breaks by name ascending when mtimes are equal', async () => {
    const same = Date.parse('2024-06-15T12:00:00Z')
    for (const f of ['b.md', 'a.md', 'c.md']) writeFileSync(join(DOCS_DIR, f), `# ${f}`)
    stubTimes({ 'a.md': same, 'b.md': same, 'c.md': same })
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<{ name: string }>
    expect(docs.map(d => d.name)).toEqual(['a.md', 'b.md', 'c.md'])
  })

  it('strips the internal `ms` field from the wire payload', async () => {
    // `ms` is used only inside the sort comparator; it must NOT leak to the
    // response shape.
    writeFileSync(join(DOCS_DIR, 'x.md'), '# X')
    const { res, json } = await call('GET', '/api/docs')
    expect(res.statusCode).toBe(200)
    const docs = json() as Array<Record<string, unknown>>
    expect(docs[0]).not.toHaveProperty('ms')
    expect(Object.keys(docs[0] ?? {}).sort()).toEqual(['created', 'name', 'title'])
  })
})

// --- GET /api/docs/<name> -- happy path -----------------------------------

describe('GET /api/docs/<name> -- happy path', () => {
  it('returns file content + extracted title when the file exists', async () => {
    writeFileSync(join(DOCS_DIR, 'hello.md'), '# Hello\nbody content here')
    const { res, json } = await call('GET', '/api/docs/hello.md')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      name: 'hello.md',
      title: 'Hello',
      content: '# Hello\nbody content here',
    })
  })

  it('falls back to filename when the file has no `# heading`', async () => {
    writeFileSync(join(DOCS_DIR, 'plain.md'), 'just body, no heading')
    const { res, json } = await call('GET', '/api/docs/plain.md')
    expect(res.statusCode).toBe(200)
    expect(json()).toMatchObject({ name: 'plain.md', title: 'plain.md' })
  })

  it('decodes percent-encoded segments via decodeURIComponent', async () => {
    // The match regex captures the raw path segment (incl. any %-encoded
    // chars), then decodeURIComponent runs on the captured group. To
    // exercise the decode path without violating NAME_RE (which excludes
    // every char that needs encoding), we encode a `-` as `%2D` -- the
    // decoded value is the same char but the call goes through decodeURIComponent.
    // Note: NAME_RE would already pass on the un-encoded form, so this is
    // really a regression guard that the decode step does not corrupt names.
    writeFileSync(join(DOCS_DIR, 'dashed-name.md'), '# spaced')
    const { res, json } = await call('GET', '/api/docs/dashed%2Dname.md')
    expect(res.statusCode).toBe(200)
    const body = json() as { name: string; title: string }
    expect(body.name).toBe('dashed-name.md')
    expect(body.title).toBe('spaced')
  })
})

// --- GET /api/docs/<name> -- 400 invalid name -----------------------------

describe('GET /api/docs/<name> -- 400 invalid name', () => {
  it('returns 400 when the decoded name fails NAME_RE (illegal char)', async () => {
    // `@` is not in NAME_RE's character class. match[1] = 'bad@name.md'
    // (already decoded by the time we test), NAME_RE.test is false -> 400.
    // NOTE: `%40` decodes to `@`, so this hits the NAME_RE branch first.
    const { res, json } = await call('GET', '/api/docs/bad%40name.md')
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid doc name' })
  })

  it('returns 400 when the decoded name contains a slash (path traversal)', async () => {
    // /api/docs/..%2Ffoo.md -> match[1] = '..%2Ffoo.md' -> decoded = '../foo.md'
    // NAME_RE excludes '/' so the regex fails and the 400 short-circuits
    // BEFORE any filesystem access happens.
    const { res, json } = await call('GET', '/api/docs/..%2Ffoo.md')
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid doc name' })
  })
})

// --- GET /api/docs/<name> -- 404 not found --------------------------------

describe('GET /api/docs/<name> -- 404 not found', () => {
  it('returns 404 when the file does not exist', async () => {
    // existsSync(file) === false -> first half of the OR short-circuits -> 404.
    const { res, json } = await call('GET', '/api/docs/missing.md')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Not found' })
  })

  it('returns 404 when the path exists but is a directory (statSync.isFile false)', async () => {
    // NAME_RE allows '.md' names, so a directory named 'not-a-file.md' slips
    // past the regex. existsSync(file) === true, but statSync(file).isFile()
    // === false, so the second half of the OR fires -> 404.
    mkdirSync(join(DOCS_DIR, 'not-a-file.md'))
    const { res, json } = await call('GET', '/api/docs/not-a-file.md')
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Not found' })
  })
})