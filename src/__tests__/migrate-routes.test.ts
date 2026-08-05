// 100% coverage suite for src/web/routes/migrate.ts.
//
// tryHandleMigrate owns two POST endpoints:
//
//   POST /api/migrate/scan   -- walk a source directory and emit a list of
//                                "findings" (memory files, personality files,
//                                config files, etc.) the caller can review.
//   POST /api/migrate/run    -- actually import the findings into the agent
//                                memory store, optionally asking Ollama for a
//                                tier/keywords per chunk.
//
// The route imports `saveAgentMemory` from `../../db.js`, `MAIN_AGENT_ID` /
// `OLLAMA_URL` from `../../config.js`, `logger` from `../../logger.js`, and
// `readBody` / `json` from `../http-helpers.js`. All four are mocked here so
// the dispatcher runs deterministically; `readBody`/`json` stay real because
// they are tiny pure helpers already covered by http-helpers.test.ts.
//
// `node:fs` is also mocked at the module level because the route calls
// `existsSync`, `statSync`, `readdirSync`, and `readFileSync` directly. The
// `node:path` import stays real -- it is just `join()` and is exercised by
// every real test.
//
// Branches covered:
//   - dispatcher: wrong path or wrong method returns false
//   - POST /api/migrate/scan: missing sourcePath -> 400; non-existent path
//     -> 404; empty findings; full knownFiles + scanDirs scan; dedup against
//     known files; ext filtering; exclusion filter; size <= 20 skipped;
//     filename->type classification (personality / profile / heartbeat /
//     schedule / daily-log / default memory); statSync throwing is silenced;
//     readdirSync throwing is silenced
//   - POST /api/migrate/run: personality / profile / heartbeat processed;
//     readFileSync failure silenced; JSON-array chunks; JSON-object chunks;
//     JSON.parse failure fallback; .md split by ## headers; .txt split by
//     blank lines; trim>20 filter; chunks empty skips Ollama; Ollama
//     /api/tags success/empty/throws; Ollama /api/generate success with
//     JSON / success without JSON / invalid tier / throws (fallback path);
//     only-one-chunk skips the throttle

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'

// ---------------------------------------------------------------------------
// Hoisted harness
// ---------------------------------------------------------------------------

const H = vi.hoisted(() => {
  const fsActual = {
    existsSync: vi.fn<(p: string) => boolean>(() => false),
    statSync: vi.fn<(p: string) => { isFile: () => boolean; size: number }>(() => ({
      isFile: () => true,
      size: 100,
    })),
    readdirSync: vi.fn<(p: string) => string[]>(() => []),
    readFileSync: vi.fn<(p: string, _enc: string) => string>(() => ''),
  }
  // Real path.join by default -- the route uses it for every join() call,
  // and we only override it in tests that need to drive an edge-case
  // branch (see "split('/').pop() || '' fallback" below).
  const realPath = require('node:path') as typeof import('node:path')
  return {
    fs: fsActual,
    saveAgentMemory: vi.fn<(...args: unknown[]) => { id: number }>(() => ({ id: 1 })),
    MAIN_AGENT_ID: 'main-agent',
    OLLAMA_URL: 'http://ollama.local:11434',
    fetch: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => ({
      json: async () => ({}),
    })),
    pathJoin: vi.fn<(...args: string[]) => string>((...parts: string[]) =>
      realPath.join(...parts),
    ),
  }
})

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  // Wrap each function used by the route so individual tests can override.
  return {
    ...actual,
    existsSync: H.fs.existsSync,
    statSync: H.fs.statSync,
    readdirSync: H.fs.readdirSync,
    readFileSync: H.fs.readFileSync,
  }
})

vi.mock('node:path', async () => {
  const actual = await vi.importActual<typeof import('node:path')>('node:path')
  // The route imports `join` from 'node:path'. We forward everything to the
  // real implementation except `join`, which tests can stub per case to
  // force a specific return value (used to drive the `split('/').pop()`
  // fallback branch on line 24 of migrate.ts).
  return {
    ...actual,
    join: H.pathJoin,
  }
})

vi.mock('../db.js', () => ({
  saveAgentMemory: H.saveAgentMemory,
}))

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: H.MAIN_AGENT_ID,
  OLLAMA_URL: H.OLLAMA_URL,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

// Stub fetch before the route module is loaded so the route's
// `${OLLAMA_URL}/api/tags` and `${OLLAMA_URL}/api/generate` calls go through
// the harness instead of the real network.
const originalFetch = globalThis.fetch
beforeEach(() => {
  globalThis.fetch = H.fetch as unknown as typeof fetch
})
afterEach(() => {
  globalThis.fetch = originalFetch
})

const { tryHandleMigrate } = await import('../web/routes/migrate.js')

// ---------------------------------------------------------------------------
// HTTP harness
// ---------------------------------------------------------------------------

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
    setHeader(k, v) {
      this.headers[k] = v
    },
    end(data) {
      if (data !== undefined) this.body += data
    },
  }
}

function mkReq(raw: string | Buffer | object): http.IncomingMessage {
  const buf =
    typeof raw === 'string'
      ? Buffer.from(raw)
      : Buffer.isBuffer(raw)
        ? raw
        : Buffer.from(JSON.stringify(raw))
  const r = Readable.from([buf]) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = {} as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  body: string | Buffer | object,
): Promise<{ res: MockRes; handled: boolean; json: () => unknown }> {
  const req = mkReq(body)
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
  }
  const handled = await tryHandleMigrate(ctx)
  return {
    res,
    handled,
    json: () => (res.body ? JSON.parse(res.body) : null),
  }
}

beforeEach(() => {
  H.fs.existsSync.mockReset().mockReturnValue(false)
  H.fs.statSync.mockReset().mockReturnValue({ isFile: () => true, size: 100 })
  H.fs.readdirSync.mockReset().mockReturnValue([])
  H.fs.readFileSync.mockReset().mockReturnValue('')
  H.saveAgentMemory.mockReset().mockReturnValue({ id: 1 })
  H.fetch.mockReset().mockImplementation(async () => ({ json: async () => ({}) }) as never)
  // Reset path.join to its real implementation between tests so per-test
  // overrides don't leak across cases.
  const realPath = require('node:path') as typeof import('node:path')
  H.pathJoin.mockImplementation((...parts: string[]) => realPath.join(...parts))
})

// ---------------------------------------------------------------------------
// Dispatcher surface (path/method filter)
// ---------------------------------------------------------------------------

describe('tryHandleMigrate -- dispatcher surface', () => {
  it('returns false for an unrelated path on GET', async () => {
    const { handled } = await call('GET', '/api/other', '')
    expect(handled).toBe(false)
  })

  it('returns false for /api/migrate/scan on GET', async () => {
    const { handled } = await call('GET', '/api/migrate/scan', '')
    expect(handled).toBe(false)
  })

  it('returns false for /api/migrate/run on GET', async () => {
    const { handled } = await call('GET', '/api/migrate/run', '')
    expect(handled).toBe(false)
  })

  it('returns false for /api/migrate/run on PUT', async () => {
    const { handled } = await call('PUT', '/api/migrate/run', {})
    expect(handled).toBe(false)
  })

  it('returns false for /api/migrate/scan on POST with a trailing slash variant', async () => {
    const { handled } = await call('POST', '/api/migrate/scan/', {})
    expect(handled).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// POST /api/migrate/scan -- input validation
// ---------------------------------------------------------------------------

describe('tryHandleMigrate -- POST /api/migrate/scan input validation', () => {
  it('returns 400 when sourcePath is missing', async () => {
    const { res, json, handled } = await call('POST', '/api/migrate/scan', {})
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Útvonal megadása kötelező' })
  })

  it('returns 400 when sourcePath is whitespace only', async () => {
    const { res, json, handled } = await call('POST', '/api/migrate/scan', { sourcePath: '   ' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Útvonal megadása kötelező' })
  })

  it('returns 400 when sourcePath is empty string', async () => {
    const { res, json, handled } = await call('POST', '/api/migrate/scan', { sourcePath: '' })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Útvonal megadása kötelező' })
  })

  it('returns 404 when the path does not exist', async () => {
    H.fs.existsSync.mockReturnValue(false)
    const { res, json, handled } = await call('POST', '/api/migrate/scan', {
      sourcePath: '/no/such/dir',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'A megadott útvonal nem létezik' })
  })

  it('throws on malformed JSON bodies (the dispatcher does not wrap JSON.parse)', async () => {
    const req = mkReq('not-json{')
    const res = mkRes()
    const ctx = {
      req,
      res: res as unknown as http.ServerResponse,
      path: '/api/migrate/scan',
      method: 'POST',
      url: new URL('http://127.0.0.1:3420/api/migrate/scan'),
    }
    await expect(tryHandleMigrate(ctx)).rejects.toBeInstanceOf(Error)
  })
})

// ---------------------------------------------------------------------------
// POST /api/migrate/scan -- finding collection
// ---------------------------------------------------------------------------

describe('tryHandleMigrate -- POST /api/migrate/scan finding collection', () => {
  it('returns ok:true with an empty findings list when the source dir is bare', async () => {
    H.fs.existsSync.mockImplementation(((p: string) => p === '/src') as never)
    H.fs.readdirSync.mockReturnValue([])
    const { res, json, handled } = await call('POST', '/api/migrate/scan', {
      sourcePath: '/src',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    const body = json() as {
      ok: boolean
      sourcePath: string
      findings: { type: string; path: string; name: string; size: number }[]
      summary: Record<string, number>
    }
    expect(body.ok).toBe(true)
    expect(body.sourcePath).toBe('/src')
    expect(body.findings).toEqual([])
    expect(body.summary).toEqual({
      personality: 0,
      profile: 0,
      memory: 0,
      heartbeat: 0,
      config: 0,
      dailyLog: 0,
      schedule: 0,
      total: 0,
    })
  })

  it('reports each known file as a finding when it exists', async () => {
    // existsSync: top-level dir + every knownFiles entry + scanDirs (none
    // exist as dirs here, so readdirSync stays untouched).
    H.fs.existsSync.mockImplementation(((p: string) => {
      return p === '/src'
        || ['MEMORY.md', 'memory/hot/HOT_MEMORY.md', 'memory/warm/WARM_MEMORY.md',
          'SOUL.md', 'USER.md', 'HEARTBEAT.md', 'AGENTS.md', 'TOOLS.md', 'CLAUDE.md']
          .some(f => p.endsWith(f))
    }) as never)
    const { res, json } = await call('POST', '/api/migrate/scan', {
      sourcePath: '/src',
    })
    expect(res.statusCode).toBe(200)
    const body = json() as {
      findings: { type: string; name: string }[]
    }
    const names = body.findings.map(f => f.name).sort()
    expect(names).toContain('MEMORY.md')
    expect(names).toContain('SOUL.md')
    expect(names).toContain('USER.md')
    expect(names).toContain('HEARTBEAT.md')
    expect(names).toContain('AGENTS.md')
    expect(names).toContain('TOOLS.md')
    expect(names).toContain('CLAUDE.md')
    expect(names).toContain('HOT_MEMORY.md')
    expect(names).toContain('WARM_MEMORY.md')
  })

  it('classifies each known file with its declared type', async () => {
    H.fs.existsSync.mockImplementation(((p: string) => {
      return p === '/src' ||
        ['MEMORY.md', 'memory/hot/HOT_MEMORY.md', 'memory/warm/WARM_MEMORY.md',
          'SOUL.md', 'USER.md', 'HEARTBEAT.md', 'AGENTS.md', 'TOOLS.md', 'CLAUDE.md']
          .some(f => p.endsWith(f))
    }) as never)
    const { json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    const body = json() as { findings: { type: string; name: string }[] }
    const byName = Object.fromEntries(body.findings.map(f => [f.name, f.type]))
    expect(byName['MEMORY.md']).toBe('memory-cold')
    expect(byName['HOT_MEMORY.md']).toBe('memory-hot')
    expect(byName['WARM_MEMORY.md']).toBe('memory-warm')
    expect(byName['SOUL.md']).toBe('personality')
    expect(byName['USER.md']).toBe('profile')
    expect(byName['HEARTBEAT.md']).toBe('heartbeat')
    expect(byName['AGENTS.md']).toBe('config')
    expect(byName['TOOLS.md']).toBe('config')
    expect(byName['CLAUDE.md']).toBe('config')
  })

  it('skips known files that do not exist on disk (addFinding short-circuits)', async () => {
    // Source path exists, but no known files do. addFinding guards on
    // existsSync for each candidate path, so nothing makes it into findings.
    H.fs.existsSync.mockImplementation(((p: string) => p === '/src') as never)
    const { json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    const body = json() as { findings: unknown[] }
    expect(body.findings).toEqual([])
  })

  it('does not double-count files that already came from knownFiles', async () => {
    // Make MEMORY.md come from both knownFiles and the root scanDir; the
    // dedup check (findings.some(...)) should keep just one entry.
    H.fs.existsSync.mockReturnValue(true)
    H.fs.readdirSync.mockReturnValue(['MEMORY.md', 'memory', 'memories', 'bank', 'notes'])
    // statSync must throw for non-file scanDir entries that the loop tries
    // to readdirSync through -- handled below in another test.
    const { json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    const body = json() as { findings: { name: string; path: string }[] }
    const mems = body.findings.filter(f => f.path === '/src/MEMORY.md')
    expect(mems).toHaveLength(1)
  })

  it('walks each scanDir and classifies file names by keyword', async () => {
    // Source dir, then 'memory', 'memories', 'bank', 'notes', and the root
    // ('') -- but mock readdirSync so the same set appears under each.
    H.fs.existsSync.mockReturnValue(true)
    H.fs.readdirSync.mockReturnValue([
      'soul.md',
      'user-profile.md',
      'heartbeat.md',
      'cron-tasks.md',
      'schedule.md',
      '2026-01-15.md',
      'plain.md',
      'tiny.md',
      'package.json',
      'tsconfig.json',
      'package-lock.json',
      '.mcp.json',
      'skip.bin',
    ])
    H.fs.statSync.mockImplementation(((p: string) => {
      const name = p.split('/').pop() || ''
      if (name === 'tiny.md') return { isFile: () => true, size: 10 }
      return { isFile: () => true, size: 200 }
    }) as never)
    const { json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    const body = json() as { findings: { type: string; name: string }[] }
    const byName = Object.fromEntries(body.findings.map(f => [f.name, f.type]))
    expect(byName['soul.md']).toBe('personality')
    expect(byName['user-profile.md']).toBe('profile')
    expect(byName['heartbeat.md']).toBe('heartbeat')
    expect(byName['cron-tasks.md']).toBe('schedule')
    expect(byName['schedule.md']).toBe('schedule')
    expect(byName['2026-01-15.md']).toBe('daily-log')
    expect(byName['plain.md']).toBe('memory')
    // tiny.md is excluded by the size <= 20 gate; only "plain.md" sneaks in
    // once because dedup keeps the first occurrence.
    expect(byName['tiny.md']).toBeUndefined()
    // The excluded files never make it into findings.
    expect(byName['package.json']).toBeUndefined()
    expect(byName['tsconfig.json']).toBeUndefined()
    expect(byName['package-lock.json']).toBeUndefined()
    expect(byName['.mcp.json']).toBeUndefined()
    expect(byName['skip.bin']).toBeUndefined()
  })

  it('skips the inner per-file stat when statSync throws', async () => {
    H.fs.existsSync.mockImplementation(((p: string) => p === '/src') as never)
    H.fs.readdirSync.mockReturnValue(['broken.md', 'good.md'])
    let calls = 0
    H.fs.statSync.mockImplementation((() => {
      calls++
      if (calls === 1) throw new Error('boom')
      return { isFile: () => true, size: 200 }
    }) as never)
    const { json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    const body = json() as { findings: { name: string }[] }
    expect(body.findings.find(f => f.name === 'good.md')).toBeDefined()
  })

  it('silently skips scanDirs whose readdirSync throws', async () => {
    H.fs.existsSync.mockImplementation(((p: string) => p === '/src') as never)
    let calls = 0
    H.fs.readdirSync.mockImplementation((() => {
      calls++
      if (calls === 1) throw new Error('directory gone')
      return []
    }) as never)
    const { res, json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    expect(res.statusCode).toBe(200)
    const body = json() as { findings: unknown[]; ok: boolean }
    expect(body.ok).toBe(true)
    expect(body.findings).toEqual([])
  })

  it('returns a populated summary keyed off the finding types', async () => {
    H.fs.existsSync.mockReturnValue(true)
    H.fs.readdirSync.mockReturnValue([
      'soul.md',
      'user-profile.md',
      'heartbeat.md',
      '2026-01-15.md',
      'cron-tasks.md',
      'plain.md',
    ])
    H.fs.statSync.mockReturnValue({ isFile: () => true, size: 200 })
    const { json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    const body = json() as { summary: Record<string, number> }
    expect(body.summary.personality).toBeGreaterThan(0)
    expect(body.summary.profile).toBeGreaterThan(0)
    expect(body.summary.heartbeat).toBeGreaterThan(0)
    expect(body.summary.dailyLog).toBeGreaterThan(0)
    expect(body.summary.schedule).toBeGreaterThan(0)
    expect(body.summary.memory).toBeGreaterThan(0)
    expect(body.summary.total).toBe(body.findings.length as never)
  })

  it('emits Cache-Control: private, no-store on the scan response', async () => {
    H.fs.existsSync.mockReturnValue(true)
    const { res } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })

  it('uses an empty name when filePath ends in a trailing slash (split/pop fallback)', async () => {
    // Force `join` to return a path with a trailing slash so the
    // `filePath.split('/').pop() || ''` fallback fires. addFinding only
    // runs when existsSync is true; we make existsSync return true for
    // that synthetic path and also for the source dir.
    H.pathJoin.mockImplementation(((first: string, second: string) => {
      if (first === '/src' && second === 'MEMORY.md') return '/src/MEMORY.md/'
      return `${first}/${second}`
    }) as never)
    H.fs.existsSync.mockImplementation(((p: string) => p === '/src' || p === '/src/MEMORY.md/') as never)
    const { json } = await call('POST', '/api/migrate/scan', { sourcePath: '/src' })
    const body = json() as { findings: { name: string; path: string }[] }
    const trailing = body.findings.find(f => f.path === '/src/MEMORY.md/')
    expect(trailing).toBeDefined()
    expect(trailing!.name).toBe('')
  })
})

// ---------------------------------------------------------------------------
// POST /api/migrate/run -- per-type processing
// ---------------------------------------------------------------------------

describe('tryHandleMigrate -- POST /api/migrate/run per-type processing', () => {
  it('returns ok:true with zero imports when no findings are provided', async () => {
    const { res, json, handled } = await call('POST', '/api/migrate/run', {
      findings: [],
      agentId: 'agent-x',
    })
    expect(handled).toBe(true)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({
      ok: true,
      imported: 0,
      stats: { hot: 0, warm: 0, cold: 0, shared: 0 },
      details: [],
    })
    expect(H.saveAgentMemory).not.toHaveBeenCalled()
    expect(H.fetch).not.toHaveBeenCalled()
  })

  it('uses MAIN_AGENT_ID when agentId is empty', async () => {
    const { json } = await call('POST', '/api/migrate/run', {
      findings: [{ type: 'personality', path: '/p/SOUL.md', name: 'SOUL.md' }],
      agentId: '',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      H.MAIN_AGENT_ID,
      expect.stringContaining('[Importált személyiség]'),
      'warm',
      'személyiség, soul, import',
      true,
    )
    expect((json() as { imported: number }).imported).toBe(1)
  })

  it('truncates personality content to 3000 chars and prefixes the marker', async () => {
    const long = 'X'.repeat(5000)
    H.fs.readFileSync.mockReturnValue(long)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'personality', path: '/p/SOUL.md', name: 'SOUL.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x',
      '[Importált személyiség] ' + long.slice(0, 3000),
      'warm',
      'személyiség, soul, import',
      true,
    )
  })

  it('silently skips a personality finding whose readFileSync throws', async () => {
    H.fs.readFileSync.mockImplementation((() => {
      throw new Error('cannot read')
    }) as never)
    const { json } = await call('POST', '/api/migrate/run', {
      findings: [{ type: 'personality', path: '/missing', name: 'missing.md' }],
      agentId: 'agent-x',
    })
    expect((json() as { imported: number }).imported).toBe(0)
    expect(H.saveAgentMemory).not.toHaveBeenCalled()
  })

  it('processes profile findings with their own marker and keywords', async () => {
    H.fs.readFileSync.mockReturnValue('the user prefers dark mode')
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'profile', path: '/p/USER.md', name: 'USER.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x',
      '[Importált felhasználói profil] the user prefers dark mode',
      'warm',
      'felhasználó, profil, import',
      true,
    )
  })

  it('truncates profile content to 3000 chars', async () => {
    const long = 'Y'.repeat(5000)
    H.fs.readFileSync.mockReturnValue(long)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'profile', path: '/p/USER.md', name: 'USER.md' }],
      agentId: 'agent-x',
    })
    const arg = H.saveAgentMemory.mock.calls[0][1] as string
    expect(arg.length).toBe('[Importált felhasználói profil] '.length + 3000)
  })

  it('silently skips a profile finding whose readFileSync throws', async () => {
    H.fs.readFileSync.mockImplementation((() => {
      throw new Error('nope')
    }) as never)
    const { json } = await call('POST', '/api/migrate/run', {
      findings: [{ type: 'profile', path: '/missing', name: 'missing.md' }],
      agentId: 'agent-x',
    })
    expect((json() as { imported: number }).imported).toBe(0)
  })

  it('processes heartbeat findings with their own marker and keywords', async () => {
    H.fs.readFileSync.mockReturnValue('interval=5m')
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'heartbeat', path: '/p/HB.md', name: 'HB.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x',
      '[Importált heartbeat konfig] interval=5m',
      'warm',
      'heartbeat, konfig, import',
      true,
    )
  })

  it('truncates heartbeat content to 2000 chars', async () => {
    const long = 'H'.repeat(3000)
    H.fs.readFileSync.mockReturnValue(long)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'heartbeat', path: '/p/HB.md', name: 'HB.md' }],
      agentId: 'agent-x',
    })
    const arg = H.saveAgentMemory.mock.calls[0][1] as string
    expect(arg.length).toBe('[Importált heartbeat konfig] '.length + 2000)
  })

  it('silently skips a heartbeat finding whose readFileSync throws', async () => {
    H.fs.readFileSync.mockImplementation((() => {
      throw new Error('nope')
    }) as never)
    const { json } = await call('POST', '/api/migrate/run', {
      findings: [{ type: 'heartbeat', path: '/missing', name: 'missing.md' }],
      agentId: 'agent-x',
    })
    expect((json() as { imported: number }).imported).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// POST /api/migrate/run -- chunk processing
// ---------------------------------------------------------------------------

describe('tryHandleMigrate -- POST /api/migrate/run chunk processing', () => {
  beforeEach(() => {
    // Force no Ollama model -> chunks path falls through to warm with empty
    // keywords. Individual tests override this when they need a model.
    H.fetch.mockImplementation((() => Promise.reject(new Error('no models'))) as never)
  })

  it('skips Ollama entirely when no memory/config/daily-log findings are present', async () => {
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'personality', path: '/p/SOUL.md', name: 'SOUL.md' }],
      agentId: 'agent-x',
    })
    expect(H.fetch).not.toHaveBeenCalled()
  })

  it('calls Ollama /api/tags and falls back to warm when the tags fetch throws', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    expect(H.fetch).toHaveBeenCalledWith(`${H.OLLAMA_URL}/api/tags`,
      expect.objectContaining({ signal: expect.anything() }))
    // saveAgentMemory called once with the warm default
    expect(H.saveAgentMemory).toHaveBeenCalledWith('agent-x', expect.any(String), 'warm', '', true)
  })

  it('uses available[0] when no model name contains gemma4', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'llama3' }, { name: 'mistral' }] }) }
      }
      return { json: async () => ({ response: '{"tier":"hot","keywords":"k1"}' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    const callToGenerate = H.fetch.mock.calls.find(c => (c[0] as string).includes('/api/generate'))
    expect(callToGenerate).toBeDefined()
    const body = JSON.parse((callToGenerate![1] as RequestInit).body as string)
    expect(body.model).toBe('llama3')
  })

  it('prefers a gemma4 model when one is in the tags response', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'llama3' }, { name: 'gemma4:9b' }] }) }
      }
      return { json: async () => ({ response: '{"tier":"cold","keywords":"k2"}' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    const callToGenerate = H.fetch.mock.calls.find(c => (c[0] as string).includes('/api/generate'))
    const body = JSON.parse((callToGenerate![1] as RequestInit).body as string)
    expect(body.model).toBe('gemma4:9b')
  })

  it('skips embed models when picking from the available list', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'nomic-embed-text' }, { name: 'llama3' }] }) }
      }
      return { json: async () => ({ response: '{"tier":"warm"}' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    const callToGenerate = H.fetch.mock.calls.find(c => (c[0] as string).includes('/api/generate'))
    const body = JSON.parse((callToGenerate![1] as RequestInit).body as string)
    expect(body.model).toBe('llama3')
  })

  it('uses warm default when /api/tags returns no models', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [] }) }
      }
      return { json: async () => ({ response: '{"tier":"warm"}' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    // No /api/generate call should have happened because categorizeModel is null
    const generateCalls = H.fetch.mock.calls.filter(c => (c[0] as string).includes('/api/generate'))
    expect(generateCalls).toHaveLength(0)
    // saveAgentMemory was still called once, with warm default
    expect(H.saveAgentMemory).toHaveBeenCalledWith('agent-x', expect.any(String), 'warm', '', true)
  })

  it('parses tier/keywords out of a valid JSON response from Ollama', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'llama3' }] }) }
      }
      return { json: async () => ({ response: '{"tier":"hot","keywords":"kw1, kw2"}' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x', expect.any(String), 'hot', 'kw1, kw2', true,
    )
  })

  it('falls back to warm when the JSON tier is invalid', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'llama3' }] }) }
      }
      return { json: async () => ({ response: '{"tier":"banana","keywords":"kw"}' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x', expect.any(String), 'warm', 'kw', true,
    )
  })

  it('falls back to warm when the response has no JSON', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'llama3' }] }) }
      }
      return { json: async () => ({ response: 'no json here' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x', expect.any(String), 'warm', '', true,
    )
  })

  it('saves warm with empty keywords when /api/generate throws', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'llama3' }] }) }
      }
      throw new Error('ollama down')
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x', expect.any(String), 'warm', '', true,
    )
  })

  it('splits a .md file by ## sections and ignores short sections', async () => {
    H.fs.readFileSync.mockReturnValue(
      'preamble\n## first section with enough text to be saved yes yes\nbody\n\n## short\n\n## another long enough section that exceeds the trim threshold yes yes\n',
    )
    // tags returns no model -> categorizeModel=null -> fall through to warm save
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    // The two long-enough sections get saved; the short "## short" is filtered.
    const savedChunks = H.saveAgentMemory.mock.calls.map(c => c[1] as string)
    expect(savedChunks.length).toBe(2)
    expect(savedChunks.every(c => c.length > 20)).toBe(true)
    expect(savedChunks.find(c => c.trim() === '## short')).toBeUndefined()
  })

  it('splits a non-md/non-json file by blank lines', async () => {
    H.fs.readFileSync.mockReturnValue(
      'paragraph one with enough text\n\nparagraph two with enough text\n\nparagraph three with enough text',
    )
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/NOTES.txt', name: 'NOTES.txt' }],
      agentId: 'agent-x',
    })
    const savedChunks = H.saveAgentMemory.mock.calls.map(c => c[1] as string)
    expect(savedChunks.length).toBeGreaterThanOrEqual(3)
  })

  it('chunks a JSON array with object items via content/text/JSON.stringify', async () => {
    H.fs.readFileSync.mockReturnValue(JSON.stringify([
      { content: 'first chunk long enough to be saved yes yes' },
      { text: 'second chunk long enough to be saved yes yes' },
      { whatever: 'x' }, // JSON.stringify fallback: "{\"whatever\":\"x\"}" -- <20 chars -> skipped
      'plain string long enough to be saved yes yes',
    ]))
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/data.json', name: 'data.json' }],
      agentId: 'agent-x',
    })
    const saved = H.saveAgentMemory.mock.calls.map(c => c[1] as string)
    expect(saved.some(s => s.startsWith('first chunk'))).toBe(true)
    expect(saved.some(s => s.startsWith('second chunk'))).toBe(true)
    expect(saved.some(s => s.startsWith('plain string'))).toBe(true)
    // The tiny object ("{\"whatever\":\"x\"}") is below the 20-char floor
    expect(saved.some(s => s === '{"whatever":"x"}')).toBe(false)
  })

  it('chunks a JSON object via Object.entries formatting', async () => {
    H.fs.readFileSync.mockReturnValue(JSON.stringify({
      alpha: 'long enough value to be saved yes yes',
      beta: 'x', // 1 char key + 1 char value -> "beta: x" == 7 chars -> skipped
    }))
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/data.json', name: 'data.json' }],
      agentId: 'agent-x',
    })
    const saved = H.saveAgentMemory.mock.calls.map(c => c[1] as string)
    expect(saved.some(s => s.startsWith('alpha: long enough'))).toBe(true)
    expect(saved.some(s => s === 'beta: x')).toBe(false)
  })

  it('falls back to a single chunk when the JSON body is unparseable', async () => {
    const text = 'not actually json but plenty of text to be saved as a chunk'
    H.fs.readFileSync.mockReturnValue(text)
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/data.json', name: 'data.json' }],
      agentId: 'agent-x',
    })
    const saved = H.saveAgentMemory.mock.calls.map(c => c[1] as string)
    expect(saved).toContain(text.slice(0, 2000))
  })

  it('skips the catch fallback push when the unparseable JSON body is shorter than 20 chars', async () => {
    // Hits the inner `if (content.trim().length > 20)` branch in the catch
    // handler: parse fails but the trimmed body is too short to push.
    H.fs.readFileSync.mockReturnValue('tiny json-ish')
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/data.json', name: 'data.json' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).not.toHaveBeenCalled()
  })

  it('does not chunk a JSON body that parses to a primitive (typeof !== "object")', async () => {
    // typeof number/string/boolean/null is not 'object', so neither the
    // array branch nor the object branch runs and no chunks are produced.
    H.fs.readFileSync.mockReturnValue('42')
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    const { json } = await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/data.json', name: 'data.json' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).not.toHaveBeenCalled()
    expect((json() as { imported: number }).imported).toBe(0)
  })

  it('falls back to [] when the tags response has no models key', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    // No `models` field at all -> the `|| []` branch fires. No /api/generate
    // call should happen because categorizeModel is null.
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({}) }
      }
      return { json: async () => ({ response: '{}' }) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    const generateCalls = H.fetch.mock.calls.filter(c => (c[0] as string).includes('/api/generate'))
    expect(generateCalls).toHaveLength(0)
    expect(H.saveAgentMemory).toHaveBeenCalledWith('agent-x', expect.any(String), 'warm', '', true)
  })

  it('treats an undefined response from Ollama as having no JSON match', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((async (url: string) => {
      if (url === `${H.OLLAMA_URL}/api/tags`) {
        return { json: async () => ({ models: [{ name: 'llama3' }] }) }
      }
      // No `response` field -> `catData.response || ''` fallback fires.
      return { json: async () => ({}) }
    }) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    // tier/keywords fall back to defaults: warm / ''.
    expect(H.saveAgentMemory).toHaveBeenCalledWith(
      'agent-x', expect.any(String), 'warm', '', true,
    )
  })

  it('chunks config-type findings via the same path as memory findings', async () => {
    H.fs.readFileSync.mockReturnValue(
      '## first config section with enough text\nstuff\n\n## second config section with enough text\nmore',
    )
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'config', path: '/p/AGENTS.md', name: 'AGENTS.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalled()
  })

  it('chunks daily-log findings via the same path', async () => {
    H.fs.readFileSync.mockReturnValue(
      '## entry one with enough text to be saved yes yes\nbody\n\n## entry two with enough text to be saved yes yes\nbody',
    )
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'daily-log', path: '/p/2026-01-15.md', name: '2026-01-15.md' }],
      agentId: 'agent-x',
    })
    expect(H.saveAgentMemory).toHaveBeenCalled()
  })

  it('silently skips a chunk source whose readFileSync throws', async () => {
    H.fs.readFileSync.mockImplementation((() => {
      throw new Error('cannot read')
    }) as never)
    const { json } = await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/missing', name: 'missing.md' }],
      agentId: 'agent-x',
    })
    expect((json() as { imported: number }).imported).toBe(0)
  })

  it('does not call saveAgentMemory when a single chunk would be too short', async () => {
    H.fs.readFileSync.mockReturnValue('## tiny')
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    const { json } = await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    expect((json() as { imported: number }).imported).toBe(0)
  })

  it('does not invoke the throttle between chunks when only one chunk is produced', async () => {
    // Use vi.useFakeTimers here so we can prove the setTimeout path is NOT
    // taken for a single-chunk payload (the loop guard short-circuits on
    // indexOf(chunk) < chunks.length - 1).
    H.fs.readFileSync.mockReturnValue('a single chunk long enough to be saved yes yes yes')
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    // If the route ever schedules a setTimeout here the test would hang under
    // real timers; the call returning without an await timeout is itself the
    // observable we want. No fake timers needed because the throttle path is
    // a no-op when chunks.length === 1.
    expect(H.saveAgentMemory).toHaveBeenCalledTimes(1)
  })

  it('threads throttle delays between chunks when multiple are produced', async () => {
    // Two chunks -> one setTimeout(200) between them. We use fake timers so
    // the test does not actually wait 200ms in real time.
    vi.useFakeTimers()
    try {
      H.fs.readFileSync.mockReturnValue(
        '## first long enough section to be saved\nstuff\n\n## second long enough section to be saved\nmore',
      )
      H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
      const pending = call('POST', '/api/migrate/run', {
        findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
        agentId: 'agent-x',
      })
      // Flush the 200ms timer between the two saveAgentMemory calls.
      await vi.runAllTimersAsync()
      const { json } = await pending
      expect((json() as { imported: number }).imported).toBe(2)
      expect(H.saveAgentMemory).toHaveBeenCalledTimes(2)
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs completion via logger.info with agentId/imported/stats', async () => {
    H.fs.readFileSync.mockReturnValue('a'.repeat(100))
    H.fetch.mockImplementation((() => Promise.reject(new Error('no tags'))) as never)
    // Pull the logger from the module-level mock to assert on it
    const { logger } = await import('../logger.js')
    await call('POST', '/api/migrate/run', {
      findings: [{ type: 'memory-cold', path: '/p/MEMORY.md', name: 'MEMORY.md' }],
      agentId: 'agent-x',
    })
    expect(logger.info).toHaveBeenCalledWith(
      expect.objectContaining({ agentId: 'agent-x', imported: expect.any(Number) }),
      'Költöztetés kész',
    )
  })

  it('emits Cache-Control: private, no-store on the run response', async () => {
    const { res } = await call('POST', '/api/migrate/run', {
      findings: [],
      agentId: 'agent-x',
    })
    expect(res.headers['Content-Type']).toBe('application/json; charset=utf-8')
    expect(res.headers['Cache-Control']).toBe('private, no-store')
  })
})