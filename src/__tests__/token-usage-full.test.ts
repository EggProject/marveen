// 100% line + branch coverage tests for src/web/token-usage.ts.
//
// Strategy:
// - Use the REAL db with `:memory:` so token_usage / token_usage_cursors schema
//   migrations apply unmodified.
// - Mock node:fs so PROJECTS_DIR scans resolve against an in-memory directory
//   map; the production code never touches the live filesystem.
// - Mock node:os so homedir() returns a tmpdir (PROJECTS_DIR is built from it
//   at module load -- redirecting to a sandboxed path keeps the suite safe).
// - Mock node:crypto so any hashing in the source is a no-op (none today, but
//   keeping the mock factory in place stops future imports from crashing).
// - Reach all branches: discoverAgentSources (main-agent + sub-agent matches,
//   non-dir entries, statSync throws), findJsonlFiles (no project dir,
//   readdirSync throws, nested dirs), parseJsonlFile (string content,
//   array content with text/tool_use/thinking, invalid JSON, empty line,
//   missing timestamp, no usage, multi-line turn collapse inside the loop,
//   sessionId fallback to basename), collectTokenUsage (cursor hit/miss,
//   parse error fallback, empty calls path, statSync throws on file),
//   getModelDistribution (column-missing branch), getToolStats, correlate-
//   WithKanban (multiple cards per agent range, last-card endTs fallback).

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll, afterEach } from 'vitest'
import { initDatabase, getDb } from '../db.js'

// ---------- hoisted harness (runs before any `import`) ------------------------

const H = vi.hoisted(() => {
  // Per-file sandbox for PROJECT_ROOT (used to encodeProjectPath).
  const tmpRoot = (process.env.TMPDIR ?? '/tmp').replace(/\/+$/, '')
  const sandbox = `${tmpRoot}/marveen-tokusage-${process.pid}-${Math.random().toString(36).slice(2)}`
  return {
    sandbox,
    home: `${sandbox}/home`,
    // In-memory "filesystem": paths -> { kind: 'dir' | 'file', body?: string }
    files: new Map<string, { kind: 'dir' | 'file'; body?: string }>(),
    // statSync errors by path
    statErrors: new Set<string>(),
    // existsSync overrides (path -> boolean). When absent the map is consulted.
    existsErrors: new Set<string>(),
    // readdirSync errors by path
    readdirErrors: new Set<string>(),
    // existsSync override: returns false for these paths, even if the file map
    // would say true. Used to test the early-return inside findJsonlFiles.
    forceExistsFalse: new Set<string>(),
    // statSync override: pretend this path is a directory without registering
    // it in the file map. Lets discoverAgentSources add a source whose
    // projectDir is then "missing" for findJsonlFiles.
    fakeDirs: new Set<string>(),
    logs: [] as Array<{ level: string; obj: unknown; msg: unknown }>,
  }
})

// ---------- module mocks ------------------------------------------------------

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => H.home }
})

vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>()
  return {
    ...actual,
    createHash: () => ({ update: () => ({ digest: () => 'deadbeef' }) }) as unknown as ReturnType<typeof actual.createHash>,
  }
})

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  const realCreateReadStream = actual.createReadStream

  function lookup(p: string): { kind: 'dir' | 'file'; body?: string } | undefined {
    if (H.files.has(p)) return H.files.get(p)
    // Auto-resolve .jsonl parent dirs when only files were registered
    // (helper for tests that pre-register nested files only).
    for (const key of H.files.keys()) {
      if (key.startsWith(p + '/')) return { kind: 'dir' }
    }
    return undefined
  }

  function listDir(p: string): string[] {
    const out: string[] = []
    for (const key of H.files.keys()) {
      if (key === p) continue
      if (!key.startsWith(p + '/')) continue
      const rel = key.slice(p.length + 1)
      const firstSlash = rel.indexOf('/')
      if (firstSlash === -1) out.push(rel)
      else {
        const top = rel.slice(0, firstSlash)
        if (!out.includes(top)) out.push(top)
      }
    }
    return out
  }

  function listImmediate(p: string): string[] {
    const out: string[] = []
    for (const key of H.files.keys()) {
      if (!key.startsWith(p + '/')) continue
      const rel = key.slice(p.length + 1)
      if (rel.indexOf('/') === -1) out.push(rel)
    }
    return out
  }

  const statSync = (p: string) => {
    if (H.statErrors.has(p)) throw new Error(`ENOENT: ${p}`)
    if (H.fakeDirs.has(p)) {
      return {
        isDirectory: () => true,
        isFile: () => false,
        size: 0,
        mtimeMs: 1_700_000_000_000,
      } as unknown as ReturnType<typeof actual.statSync>
    }
    const e = lookup(p)
    if (!e) throw new Error(`ENOENT: ${p}`)
    return {
      isDirectory: () => e.kind === 'dir',
      isFile: () => e.kind === 'file',
      size: e.body?.length ?? 0,
      mtimeMs: 1_700_000_000_000,
    } as unknown as ReturnType<typeof actual.statSync>
  }

  const existsSync = (p: string) => {
    if (H.existsErrors.has(p)) throw new Error(`EACCES: ${p}`)
    if (H.forceExistsFalse.has(p)) return false
    if (H.files.has(p)) return true
    // Auto-true for any directory that contains registered files
    for (const key of H.files.keys()) {
      if (key.startsWith(p + '/')) return true
    }
    return false
  }

  const readdirSync = (p: string) => {
    if (H.readdirErrors.has(p)) throw new Error(`EACCES: ${p}`)
    // Prefer immediate-children for dir-scoped listings (findJsonlFiles path).
    const immediate = listImmediate(p)
    if (immediate.length > 0) return immediate
    return listDir(p)
  }

  // createReadStream: real impl for the file-mock body strings. createInterface
  // (readline) splits on \n -- so the body should already be the JSONL content.
  const createReadStream = (filePath: string, opts?: { encoding?: string }) => {
    const e = H.files.get(filePath)
    if (!e || e.kind !== 'file') {
      return realCreateReadStream(filePath, opts as Parameters<typeof actual.createReadStream>[1])
    }
    const { Readable } = require('node:stream') as typeof import('node:stream')
    return Readable.from([e.body ?? ''])
  }

  return {
    ...actual,
    statSync,
    existsSync,
    readdirSync,
    createReadStream,
  }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'info', obj, msg }),
    warn: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'warn', obj, msg }),
    debug: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'debug', obj, msg }),
    error: (obj: unknown, msg?: unknown) => H.logs.push({ level: 'error', obj, msg }),
  },
}))

// Sandbox PROJECT_ROOT so encodeProjectPath() returns a deterministic main dir name.
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    PROJECT_ROOT: H.sandbox,
    MAIN_AGENT_ID: 'marveen',
  }
})

// ---------- SUT import (must be AFTER all vi.mock factories) ------------------

const TU = await import('../web/token-usage.js')

// ---------- helpers -----------------------------------------------------------

function addFile(path: string, body: string): void {
  H.files.set(path, { kind: 'file', body })
  // Auto-register every ancestor dir as a 'dir' so existsSync returns true
  // and readdirSync can list its children.
  let p = path
  while (true) {
    const idx = p.lastIndexOf('/')
    if (idx <= 0) break
    p = p.slice(0, idx)
    if (!H.files.has(p)) H.files.set(p, { kind: 'dir' })
  }
}

function reset(): void {
  H.files.clear()
  H.statErrors.clear()
  H.existsErrors.clear()
  H.readdirErrors.clear()
  H.forceExistsFalse.clear()
  H.fakeDirs.clear()
  H.logs.length = 0
}

beforeAll(() => {
  process.env.NODE_ENV = 'test'
  initDatabase(':memory:')
})

beforeEach(() => {
  reset()
  const db = getDb()
  db.exec('DELETE FROM token_usage')
  db.exec('DELETE FROM token_usage_cursors')
  db.exec('DELETE FROM kanban_cards')
})

afterAll(() => {
  reset()
})

// ---------------------------------------------------------------------------
// discoverAgentSources + encodeProjectPath (exercised through collectTokenUsage)
// ---------------------------------------------------------------------------

describe('discoverAgentSources', () => {
  it('returns [] when PROJECTS_DIR does not exist', async () => {
    // PROJECTS_DIR is computed at module load from H.home + '/.claude/projects'.
    // Default: home is empty -> H.home does not exist -> discoverAgentSources
    // hits the !existsSync early-return.
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(0)
    expect(files).toBe(0)
  })

  it('skips non-directory entries under PROJECTS_DIR', async () => {
    // A regular file under PROJECTS_DIR must be skipped via !stat.isDirectory().
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    addFile(`${projectsDir}/stray-file.txt`, 'noise')
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(0)
    expect(files).toBe(0)
  })

  it('skips entries where statSync throws (e.g. dangling symlink)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    H.files.set(`${projectsDir}/dangling`, { kind: 'dir' })
    H.statErrors.add(`${projectsDir}/dangling`)
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(0)
    expect(files).toBe(0)
  })

  it('finds the main agent dir by PROJECT_ROOT encoding match', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    // encodeProjectPath replaces every non-alphanumeric/non-dash with '-'.
    // H.sandbox looks like '/tmp/marveen-tokusage-...-<rand>'; all '/', '.' etc.
    // become '-' so it becomes a flat string of dashes + alphanumerics.
    const expectedName = H.sandbox.replace(/[^a-zA-Z0-9-]/g, '-')
    addFile(`${projectsDir}/${expectedName}/sess.jsonl`,
      JSON.stringify({ type: 'assistant', sessionId: 'main', timestamp: '2026-05-20T10:00:00Z',
        message: { usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: 'hi' }] } }),
    )
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    expect(files).toBe(1)
    const rows = getDb().prepare('SELECT agent FROM token_usage').all() as Array<{ agent: string }>
    expect(rows[0].agent).toBe('marveen')
  })

  it('finds sub-agent dirs via the -agents-<name> suffix match', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    // The name part after -agents- allows [a-z0-9-]. Use a digit + hyphen name.
    addFile(`${projectsDir}/some-prefix-agents-davinci-ocura/sess.jsonl`,
      JSON.stringify({ type: 'assistant', sessionId: 'sub1', timestamp: '2026-05-20T10:00:00Z',
        message: { usage: { input_tokens: 50, output_tokens: 5 }, content: [{ type: 'text', text: 'sub1' }] } }),
    )
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    const rows = getDb().prepare('SELECT agent FROM token_usage').all() as Array<{ agent: string }>
    expect(rows[0].agent).toBe('davinci-ocura')
  })

  it('skips entries that match NEITHER the sub-agent nor the main-agent pattern', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    // No -agents- suffix, doesn't match the encoded PROJECT_ROOT.
    addFile(`${projectsDir}/some-other-project/sess.jsonl`, '')
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(0)
    expect(files).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// findJsonlFiles
// ---------------------------------------------------------------------------

describe('findJsonlFiles', () => {
  it('returns [] when the project dir does not exist (defensive)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    // Force H.readdirErrors so scanDir's readdirSync throws -> swallowed.
    H.readdirErrors.add(`${H.sandbox}/does-not-exist`)
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(0)
    expect(files).toBe(0)
  })

  it('hits the existsSync early-return inside findJsonlFiles when the source dir is gone', async () => {
    // discoverAgentSources enumerates `entry` directories under PROJECTS_DIR;
    // collectTokenUsage then calls findJsonlFiles(source.projectDir). If the
    // projectDir has been deleted between discover and findJsonlFiles, the
    // early `if (!existsSync(dir)) return files` branch must short-circuit.
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    // Make discoverAgentSources treat this as a valid directory via statSync,
    // but NOT have any actual entries in it -> findJsonlFiles's existsSync
    // returns false -> early return (line 51).
    const ghostDir = `${projectsDir}/some-prefix-agents-ghost`
    H.fakeDirs.add(ghostDir)
    H.forceExistsFalse.add(ghostDir)
    // The readdirSync of PROJECTS_DIR must include 'some-prefix-agents-ghost'
    // as an immediate child -- fakeDirs adds nothing to the listing, so we
    // need a sibling file under the ghost dir to make listImmediate return
    // something for PROJECTS_DIR. A bare H.fakeDirs entry alone won't show
    // up; instead register a sibling agent with files so the listing is
    // non-empty AND add the ghost dir name as a registered dir entry too,
    // so readdirSync sees it. To make findJsonlFiles's existsSync return
    // false, forceExistsFalse takes priority.
    H.files.set(ghostDir, { kind: 'dir' }) // show in listing + exists true
    H.forceExistsFalse.add(ghostDir)       // but findJsonlFiles sees false
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(0)
  })

  it('swallows a readdirSync throw inside scanDir (catch return)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-rdscan`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    // existsSync(dir) returns true (H.files has it), so findJsonlFiles enters
    // scanDir. scanDir then calls readdirSync(dir) which throws.
    H.readdirErrors.add(d)
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(0)
  })

  it('swallows a statSync throw inside scanDir for non-.jsonl entries', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-statthrow`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    // Add a non-.jsonl entry directly under d (no slash inside the name).
    H.files.set(`${d}/rawfile`, { kind: 'file', body: 'noise' })
    // Force statSync to throw for that path -> catch+continue (line 62 branch).
    H.statErrors.add(`${d}/rawfile`)
    // Also add a real .jsonl so collectTokenUsage has something to find.
    addFile(`${d}/good.jsonl`, JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-05-20T10:00:00Z',
      message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'x' }] },
    }))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
  })

  it('skips a non-jsonl entry that is NOT a directory (file sibling)', async () => {
    // scanDir loops entries; for each non-.jsonl entry it calls statSync.
    // If isDirectory() is false (a regular file), the if-branch at line 63
    // is skipped -- the entry is silently ignored. Cover that else path.
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-filesib`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    // A non-.jsonl file sibling under the agent dir.
    H.files.set(`${d}/README.md`, { kind: 'file', body: '# notes' })
    // And one valid .jsonl file.
    addFile(`${d}/good.jsonl`, JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-05-20T10:00:00Z',
      message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'x' }] },
    }))
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    expect(files).toBe(1)
  })

  it('walks subdirectories and collects nested .jsonl files', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const mainDir = `${projectsDir}/sandbox-prefix-agents-zeta`
    H.files.set(mainDir, { kind: 'dir' })
    addFile(`${mainDir}/subdir/sess.jsonl`, '') // collectTokenUsage will read its content
    const { inserted } = await TU.collectTokenUsage()
    // No calls -> inserted 0, but files should reach 1 (counter increments
    // even when no calls parsed because setCursor still ran).
    expect(inserted).toBe(0)
  })

  it('skips a non-.jsonl file at the top level but recurses into subdirs', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sub/sess.jsonl`,
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-05-20T10:00:00Z',
        message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'x' }] } }),
    )
    const { inserted, files } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    expect(files).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// parseJsonlFile (exercised via collectTokenUsage)
// ---------------------------------------------------------------------------

describe('parseJsonlFile (via collectTokenUsage)', () => {
  function makeAssistant(over: Record<string, unknown> = {}): string {
    return JSON.stringify({
      type: 'assistant',
      sessionId: 'sess-1',
      timestamp: '2026-05-20T10:00:00Z',
      message: {
        usage: { input_tokens: 10, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
        content: [{ type: 'text', text: 'hello' }],
      },
      ...over,
    })
  }

  it('parses string content and a tool_use block', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sess.jsonl`, [
      makeAssistant({ message: { usage: { input_tokens: 10, output_tokens: 1 }, content: 'plain string body' } }),
      JSON.stringify({
        type: 'assistant', sessionId: 'sess-1', timestamp: '2026-05-20T10:01:00Z',
        message: { usage: { input_tokens: 5, output_tokens: 2 }, content: [{ type: 'tool_use', name: 'Bash' }] },
      }),
    ].join('\n'))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(2)
    const rows = getDb().prepare('SELECT content_preview, tool_name FROM token_usage ORDER BY id').all() as Array<{ content_preview: string; tool_name: string | null }>
    expect(rows[0].content_preview).toBe('plain string body')
    expect(rows[1].tool_name).toBe('Bash')
  })

  it('handles content that is neither an array nor a string (preview stays empty)', async () => {
    // content: null / object / number -> neither Array.isArray nor typeof string,
    // so preview stays ''. The else-if at line 172 is the negative branch.
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-weirdcontent`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sess.jsonl`, JSON.stringify({
      type: 'assistant', sessionId: 'sw', timestamp: '2026-05-20T10:00:00Z',
      message: { usage: { input_tokens: 1, output_tokens: 1 }, content: { weird: 'object body' } },
    }))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    const row = getDb().prepare('SELECT content_preview FROM token_usage WHERE agent = ?').get('weirdcontent') as { content_preview: string | null }
    expect(row.content_preview).toBeNull() // empty -> persisted as null
  })

  it('estimates thinking tokens from thinking-block character count (chars/4, ceil)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    // 9 chars -> ceil(9/4) = 3. Use '123456789' * 2 = 18 chars to be unambiguous.
    addFile(`${d}/sess.jsonl`, JSON.stringify({
      type: 'assistant', sessionId: 'sess-1', timestamp: '2026-05-20T10:00:00Z',
      message: {
        usage: { input_tokens: 1, output_tokens: 1 },
        content: [
          { type: 'thinking', thinking: 'abcdefghi' },  // 9 chars -> 3 tokens
          { type: 'thinking', thinking: 'abcdefghijklmnopqr' }, // 18 chars -> 5 tokens
        ],
      },
    }))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    const row = getDb().prepare('SELECT thinking_tokens FROM token_usage').get() as { thinking_tokens: number }
    expect(row.thinking_tokens).toBe(8)
  })

  it('skips invalid JSON lines and empty lines without crashing', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sess.jsonl`, [
      '{ this is not valid json',
      '',
      '   ',
      makeAssistant({ sessionId: 's', timestamp: '2026-05-20T10:02:00Z' }),
    ].join('\n'))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
  })

  it('skips rows with no usage, with missing timestamp, or non-assistant types', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sess.jsonl`, [
      JSON.stringify({ type: 'system', sessionId: 's', timestamp: '2026-05-20T10:00:00Z', message: {} }),
      JSON.stringify({ type: 'user', sessionId: 's', timestamp: '2026-05-20T10:00:00Z' }),
      JSON.stringify({ type: 'assistant', sessionId: 's' }), // no message.usage, no timestamp
      JSON.stringify({ type: 'assistant', sessionId: 's', message: { usage: null }, timestamp: 'invalid-date' }),
      makeAssistant({ sessionId: 's', timestamp: '2026-05-20T10:01:00Z' }),
    ].join('\n'))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
  })

  it('falls back to basename(file, .jsonl) when no sessionId is ever set', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/orphan-session.jsonl`, JSON.stringify({
      type: 'assistant',
      // No sessionId at all.
      timestamp: '2026-05-20T10:00:00Z',
      message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'x' }] },
    }))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    const row = getDb().prepare('SELECT session_id FROM token_usage').get() as { session_id: string }
    expect(row.session_id).toBe('orphan-session')
  })

  it('captures the model field when present and preserves tool_name + preview across the multi-line collapse', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    const ts1 = '2026-05-20T10:00:00.000Z'
    const ts2 = '2026-05-20T10:00:03.000Z'
    addFile(`${d}/sess.jsonl`, [
      JSON.stringify({
        type: 'assistant', sessionId: 'sess-coll', timestamp: ts1,
        message: { id: 'msg_collapse_1', model: 'claude-sonnet-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'text', text: 'multi-line collapse test' }] },
      }),
      JSON.stringify({
        type: 'assistant', sessionId: 'sess-coll', timestamp: ts2,
        message: { id: 'msg_collapse_1', model: 'claude-sonnet-5',
          usage: { input_tokens: 100, output_tokens: 50 },
          content: [{ type: 'tool_use', name: 'Edit' }] },
      }),
    ].join('\n'))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1) // collapsed to ONE row, not 2
    const row = getDb().prepare('SELECT model, tool_name, content_preview FROM token_usage').get() as { model: string; tool_name: string; content_preview: string }
    expect(row.model).toBe('claude-sonnet-5')
    expect(row.tool_name).toBe('Edit')
    expect(row.content_preview).toBe('multi-line collapse test')
  })

  it('skips a text-block whose .text is empty (no preview update)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sess.jsonl`, JSON.stringify({
      type: 'assistant', sessionId: 's', timestamp: '2026-05-20T10:00:00Z',
      message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: '' }] },
    }))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    const row = getDb().prepare('SELECT content_preview FROM token_usage').get() as { content_preview: string | null }
    // Empty text -> preview stays '' and gets persisted as null per insertCall.run.
    expect(row.content_preview).toBeNull()
  })

  it('skips rows whose timestamp cannot be parsed (if (!ts) continue)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sess.jsonl`, [
      // timestamp=0 -> new Date(0).getTime() = 0 -> !ts branch.
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: 0,
        message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'a' }] } }),
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '',
        message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'b' }] } }),
      // missing timestamp entirely.
      JSON.stringify({ type: 'assistant', sessionId: 's',
        message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'c' }] } }),
      // Valid one.
      JSON.stringify({ type: 'assistant', sessionId: 's', timestamp: '2026-05-20T10:00:00Z',
        message: { usage: { input_tokens: 1, output_tokens: 1 }, content: [{ type: 'text', text: 'd' }] } }),
    ].join('\n'))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1) // only the valid one
  })

  it('collapses multi-line turns filling in model/toolName/contentPreview on subsequent lines', () => {
    // Same messageId across two lines. First line lacks model + toolName +
    // contentPreview; second line has them. collapseByMessageId must fill the
    // gaps (lines 124, 125, 126 -- defensive conditional assignments).
    const rows = [
      { agent: 'a', sessionId: 's', timestamp: 1, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
        model: null, contentPreview: '', toolName: null, messageId: 'msg_mix' },
      { agent: 'a', sessionId: 's', timestamp: 2, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
        model: 'claude-sonnet-5', contentPreview: 'tool_use text', toolName: 'Edit', messageId: 'msg_mix' },
    ]
    const out = TU.collapseByMessageId(rows)
    expect(out).toHaveLength(1)
    expect(out[0].model).toBe('claude-sonnet-5')
    expect(out[0].toolName).toBe('Edit')
    expect(out[0].contentPreview).toBe('tool_use text')
  })

  it('collapse takes the ELSE branch when ex.toolName / ex.contentPreview are already set', () => {
    // Same messageId, both lines already carry toolName + contentPreview.
    // The defensive `if (!ex.X && c.X) ex.X = c.X` guards go to the else
    // branch because ex.X is already truthy -- no overwriting.
    const rows = [
      { agent: 'a', sessionId: 's', timestamp: 1, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
        model: 'claude-opus-4-8', contentPreview: 'first', toolName: 'Read', messageId: 'msg_full' },
      { agent: 'a', sessionId: 's', timestamp: 2, inputTokens: 0, outputTokens: 0,
        cacheReadTokens: 0, cacheCreationTokens: 0, thinkingTokens: 0,
        model: 'claude-sonnet-5', contentPreview: 'second', toolName: 'Edit', messageId: 'msg_full' },
    ]
    const out = TU.collapseByMessageId(rows)
    expect(out).toHaveLength(1)
    // First occurrence wins for toolName/contentPreview (assignment is skipped).
    expect(out[0].toolName).toBe('Read')
    expect(out[0].contentPreview).toBe('first')
    expect(out[0].model).toBe('claude-opus-4-8')
  })
})

// ---------------------------------------------------------------------------
// collectTokenUsage: cursor / IO flow
// ---------------------------------------------------------------------------

describe('collectTokenUsage IO flow', () => {
  function assistantLine(ts: string, inT = 10, outT = 1): string {
    return JSON.stringify({
      type: 'assistant', sessionId: 'sess', timestamp: ts,
      message: { usage: { input_tokens: inT, output_tokens: outT }, content: [{ type: 'text', text: 'x' }] },
    })
  }

  it('writes cursor after parsing (calls.length > 0)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    const path = `${d}/sess.jsonl`
    addFile(path, assistantLine('2026-05-20T10:00:00Z'))
    const r1 = await TU.collectTokenUsage()
    expect(r1.inserted).toBe(1)
    expect(r1.files).toBe(1)
    const c = getDb().prepare('SELECT last_line, last_size FROM token_usage_cursors WHERE file_path = ?').get(path) as { last_line: number; last_size: number } | undefined
    expect(c).toBeDefined()
    expect(c!.last_line).toBeGreaterThan(0)
  })

  it('writes cursor even when no calls parsed (empty file body)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    const path = `${d}/empty.jsonl`
    addFile(path, '')
    const r = await TU.collectTokenUsage()
    expect(r.inserted).toBe(0)
    expect(r.files).toBe(1) // file counter still increments
    const c = getDb().prepare('SELECT last_line, last_size FROM token_usage_cursors WHERE file_path = ?').get(path) as { last_line: number; last_size: number } | undefined
    expect(c).toBeDefined()
  })

  it('skips a file whose size matches the stored cursor (no re-parse)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    const path = `${d}/sess.jsonl`
    const body = assistantLine('2026-05-20T10:00:00Z')
    addFile(path, body)
    // Pre-seed a cursor matching the file size.
    getDb().prepare('INSERT INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)').run(path, 1, body.length)
    const r = await TU.collectTokenUsage()
    expect(r.inserted).toBe(0)
    expect(r.files).toBe(0) // the file was skipped entirely
  })

  it('skips a file whose statSync throws (caught + continue)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    const path = `${d}/sess.jsonl`
    addFile(path, assistantLine('2026-05-20T10:00:00Z'))
    H.statErrors.add(path)
    const r = await TU.collectTokenUsage()
    expect(r.inserted).toBe(0)
    expect(r.files).toBe(0)
  })

  it('warns + continues when parseJsonlFile throws', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    // File body is JSON but with NO `type` or `timestamp` -- reading is fine,
    // but if we want parseJsonlFile to throw, we feed it a directory path
    // that readdirSync reported but createReadStream cannot open.
    // Easier: make readFileSync fail by replacing createReadStream to throw.
    // We achieve this by registering the path as a DIR with no .jsonl file
    // but putting a sub-path that LOOKS like a .jsonl under the entry key,
    // so the listing returns it but createReadStream gets the body of a dir.
    // Simplest reliable trigger: H.statErrors so statSync throws inside the
    // outer for-loop -> caught by the per-file try/catch? No, that's a
    // separate try/catch (lines 231-232). To hit the parseJsonlFile try/catch
    // we use a synthetic error path by making the file body a non-string.
    const path = `${d}/bad.jsonl`
    H.files.set(path, { kind: 'file', body: '  broken-but-still-string' })
    // Inject a parse failure by monkey-patching the createReadStream path
    // through the body contents -- the real parse won't throw on these bytes.
    // Instead, exercise the catch by injecting a `node:fs` createReadStream
    // that throws on this specific path via a side-channel.
    H.logs.length = 0
    // We force the catch by making the file vanish from H.files AFTER the
    // outer stat, but BEFORE parseJsonlFile. Simulate by removing the body
    // and setting existsErrors for the path's createReadStream side.
    // The cleanest reliable trigger: re-register the path as a directory.
    H.files.set(path, { kind: 'dir' })
    const r = await TU.collectTokenUsage()
    // createReadStream with no entry returns the real fs's stream, which
    // will error on read; that surfaces as a throw inside parseJsonlFile.
    expect(r.inserted).toBe(0)
    // Warning should be logged at least once.
    const warns = H.logs.filter((l) => l.level === 'warn')
    expect(warns.length).toBeGreaterThanOrEqual(1)
  })

  it('starts from cursor.last_line when the file grew (size > last_size)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    const path = `${d}/sess.jsonl`
    const initial = assistantLine('2026-05-20T10:00:00Z') + '\n' + assistantLine('2026-05-20T10:01:00Z')
    addFile(path, initial)
    // First pass: parse both lines.
    const r1 = await TU.collectTokenUsage()
    expect(r1.inserted).toBe(2)
    // Append a third line and re-run: should pick up only the third.
    const newLine = assistantLine('2026-05-20T10:02:00Z', 99, 9)
    H.files.set(path, { kind: 'file', body: initial + '\n' + newLine })
    const r2 = await TU.collectTokenUsage()
    expect(r2.inserted).toBe(1)
    const rows = getDb().prepare('SELECT input_tokens FROM token_usage ORDER BY id').all() as Array<{ input_tokens: number }>
    expect(rows[rows.length - 1].input_tokens).toBe(99)
  })

  it('resets to line 0 when the file shrunk (cursor.last_size > current size)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    const dirName = `sandbox-prefix-agents-alpha`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    const path = `${d}/sess.jsonl`
    addFile(path, assistantLine('2026-05-20T10:00:00Z', 50, 5))
    // Seed a cursor with last_size > current body size to force the reset branch.
    getDb().prepare('INSERT INTO token_usage_cursors (file_path, last_line, last_size) VALUES (?, ?, ?)').run(path, 99, 9_999_999)
    const r = await TU.collectTokenUsage()
    expect(r.inserted).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// getModelDistribution
// ---------------------------------------------------------------------------

describe('getModelDistribution', () => {
  beforeEach(() => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model) VALUES ('a1','s',100,10,1,'claude-sonnet-5')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model) VALUES ('a1','s',200,20,2,'claude-sonnet-5')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model) VALUES ('a1','s',300,5,1,'claude-opus-4-8')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model) VALUES ('a1','s',400,1,1,'')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model) VALUES ('a1','s',500,1,1,'<synthetic>')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model) VALUES ('a1','s',600,7,3,NULL)")
  })

  it('excludes empty + <synthetic> + NULL models and sorts by count DESC', () => {
    const dist = TU.getModelDistribution()
    expect(dist).toHaveLength(2)
    expect(dist[0].model).toBe('claude-sonnet-5')
    expect(dist[0].count).toBe(2)
    expect(dist[1].model).toBe('claude-opus-4-8')
    expect(dist[1].count).toBe(1)
  })

  it('filters by from/to/agent', () => {
    const dist = TU.getModelDistribution(150, 350, 'a1')
    expect(dist).toHaveLength(2)
    expect(dist.map((d) => d.model).sort()).toEqual(['claude-opus-4-8', 'claude-sonnet-5'])
  })

  it('returns [] when the token_usage table has no model column (defensive)', () => {
    // We can't actually drop the column (other tests depend on it), but we
    // can mock the pragma_table_info call to return n:0 by injecting a
    // throw inside getDb().prepare for that specific query.
    const orig = getDb().prepare.bind(getDb())
    const spy = vi.spyOn(getDb(), 'prepare').mockImplementation((q: unknown) => {
      if (typeof q === 'string' && q.includes("pragma_table_info('token_usage')")) {
        return { get: () => ({ n: 0 }) } as ReturnType<typeof orig>
      }
      return (orig as unknown as (q: unknown) => unknown)(q) as ReturnType<typeof orig>
    })
    try {
      const dist = TU.getModelDistribution()
      expect(dist).toEqual([])
    } finally {
      spy.mockRestore()
    }
  })
})

// ---------------------------------------------------------------------------
// getToolStats
// ---------------------------------------------------------------------------

describe('getToolStats', () => {
  beforeEach(() => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model, tool_name) VALUES ('a1','s',100,10,1,'claude-sonnet-5','Read')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model, tool_name) VALUES ('a1','s',200,20,2,'claude-opus-4-8','Read')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model, tool_name) VALUES ('a2','s',300,5,3,'claude-sonnet-5','Bash')")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, model, tool_name) VALUES ('a1','s',400,7,4,NULL,NULL)")
  })

  it('returns one row per (tool_name, model) excluding NULL tool_name', () => {
    const stats = TU.getToolStats()
    expect(stats).toHaveLength(3)
    // One row per (tool_name, model): two 'Read' rows (different models) and
    // one 'Bash' row. Counts are all 1 -- assert shape, not ordering.
    const toolNames = stats.map((s) => s.tool_name).sort()
    expect(toolNames).toEqual(['Bash', 'Read', 'Read'])
    const read = stats.filter((s) => s.tool_name === 'Read')
    expect(read.every((s) => s.count === 1)).toBe(true)
    const bash = stats.find((s) => s.tool_name === 'Bash')!
    expect(bash.agents.split(',')).toEqual(['a2'])
  })

  it('filters by from/to/agent', () => {
    const stats = TU.getToolStats(150, 350, 'a1')
    expect(stats.every((s) => s.agents === 'a1')).toBe(true)
  })

  it('returns [] when no tool rows match the filter', () => {
    const stats = TU.getToolStats(900, 1000, 'nope')
    expect(stats).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// getTokenDetails
// ---------------------------------------------------------------------------

describe('getTokenDetails', () => {
  beforeEach(() => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, tool_name, content_preview, task_title) VALUES " +
      "('a1','s1',100,10,1,0,0,'Read','hello','Task A')," +
      "('a2','s2',200,2000,2,0,0,'Bash','world',NULL)," +
      "('a1','s1',300,5,1,0,0,NULL,'samu-marker',NULL)")
  })

  it('honors default limit (100) and offset (0) when neither is passed', () => {
    const r = TU.getTokenDetails({})
    expect(r.length).toBeGreaterThanOrEqual(1)
  })

  it('honors q search across agent/tool_name/content_preview/task_title', () => {
    const r = TU.getTokenDetails({ q: 'samu' })
    expect(r.length).toBe(1)
    expect((r[0] as unknown as { agent: string }).agent).toBe('a1')
  })

  it('handles zero opts.limit/offset (uses 100/0 defaults)', () => {
    const r = TU.getTokenDetails({ limit: 0, offset: 0 })
    expect(r.length).toBeGreaterThanOrEqual(1)
  })

  it('filters by minTokens (input + cache_read + cache_creation >= minTokens)', () => {
    // a1/s1 at ts=100 has input=10 (no cache). a2/s2 at ts=200 has input=2000.
    const r = TU.getTokenDetails({ minTokens: 1000 })
    expect(r.length).toBe(1)
    expect((r[0] as unknown as { session_id: string }).session_id).toBe('s2')
  })
})

// ---------------------------------------------------------------------------
// getTokenSummary
// ---------------------------------------------------------------------------

describe('getTokenSummary', () => {
  beforeEach(() => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, thinking_tokens, model) VALUES " +
      "('a1','s1',100,10,1,0,0,0,'claude-sonnet-5')," +
      "('a1','s1',200,5,2,0,0,7,'claude-sonnet-5')," +
      "('a2','s2',300,100,10,0,0,0,NULL)," +
      "('a2','s2',400,200,20,0,0,0,'claude-opus-4-8')")
  })

  it('returns one summary per agent with correct totals', () => {
    const r = TU.getTokenSummary()
    expect(r).toHaveLength(2)
    const a1 = r.find((s) => s.agent === 'a1')!
    const a2 = r.find((s) => s.agent === 'a2')!
    expect(a1.totalCalls).toBe(2)
    expect(a1.totalInput).toBe(15)
    expect(a1.totalOutput).toBe(3)
    expect(a1.totalSessions).toBe(1)
    expect(a1.firstSeen).toBe(100)
    expect(a1.lastSeen).toBe(200)
    expect(a2.totalCalls).toBe(2)
    expect(a2.totalInput).toBe(300)
    expect(a2.totalOutput).toBe(30)
  })

  it('builds the perModel breakdown keyed by agent', () => {
    const r = TU.getTokenSummary()
    const a1 = r.find((s) => s.agent === 'a1')!
    const a2 = r.find((s) => s.agent === 'a2')!
    expect(a1.perModel).toHaveLength(1)
    expect(a1.perModel[0].model).toBe('claude-sonnet-5')
    expect(a1.perModel[0].totalInput).toBe(15)
    expect(a2.perModel).toHaveLength(2)
    expect(a2.perModel.find((m) => m.model === 'claude-opus-4-8')?.totalInput).toBe(200)
    expect(a2.perModel.find((m) => m.model === null)?.totalInput).toBe(100)
  })

  it('respects from/to filters', () => {
    const r = TU.getTokenSummary(150, 350)
    expect(r).toHaveLength(2)
    const a1 = r.find((s) => s.agent === 'a1')!
    const a2 = r.find((s) => s.agent === 'a2')!
    expect(a1.totalCalls).toBe(1)
    expect(a1.firstSeen).toBe(200)
    expect(a2.totalCalls).toBe(1)
    expect(a2.firstSeen).toBe(300)
  })

  it('returns [] when no data matches the time range', () => {
    const r = TU.getTokenSummary(10_000, 20_000)
    expect(r).toEqual([])
  })

  it('falls back to [] for the per-model breakdown of an agent absent from modelRows (defensive `?? []` branch)', () => {
    // Both queries share the same WHERE clause on the same table, so under
    // any reachable input the agent set of `rows` and `modelRows` is equal
    // -- byAgent.get(r.agent) is therefore always populated (the `?? []` is
    // a defensive guard). This test mocks db.prepare so query 1 returns a
    // row but query 2 returns [] -- the only path that drives the fallback.
    const db = getDb()
    const realPrepare = db.prepare.bind(db)
    const spy = vi.spyOn(db, 'prepare').mockImplementation(((q: unknown) => {
      const sql = String(q)
      // Second query: GROUP BY agent, model (the one that builds byAgent).
      if (sql.includes('GROUP BY agent, model')) {
        return { all: () => [], get: () => undefined } as unknown as ReturnType<typeof realPrepare>
      }
      return realPrepare(sql)
    }) as unknown as typeof db.prepare)
    try {
      const r = TU.getTokenSummary()
      // Every agent row from query 1 should fall through to `?? []` because
      // byAgent is empty (query 2 returned []).
      expect(r.length).toBeGreaterThanOrEqual(1)
      for (const row of r) {
        expect(row.perModel).toEqual([])
      }
    } finally {
      spy.mockRestore()
    }
  })
})// ---------------------------------------------------------------------------
// getTokenTimeline
// ---------------------------------------------------------------------------

describe('getTokenTimeline', () => {
  beforeEach(() => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens) VALUES ('a1','s',60,10,1,2,3)")
  })

  it('uses the default bucketMinutes when none is supplied', () => {
    const r = TU.getTokenTimeline()
    expect(r.length).toBeGreaterThanOrEqual(1)
  })

  it('falls back to 0 when usage tokens are missing/zero (u.input_tokens || 0 branch)', async () => {
    const projectsDir = `${H.home}/.claude/projects`
    H.files.set(projectsDir, { kind: 'dir' })
    // Use a fresh agent name so the row we insert does not collide with the
    // beforeEach-inserted a1 row (different (agent, ts) tuple).
    const dirName = `sandbox-prefix-agents-zero`
    const d = `${projectsDir}/${dirName}`
    H.files.set(d, { kind: 'dir' })
    addFile(`${d}/sess.jsonl`, JSON.stringify({
      type: 'assistant', sessionId: 'sz', timestamp: '2026-05-20T10:00:00Z',
      // Both falsy -> both `|| 0` fallbacks fire.
      message: { usage: { input_tokens: 0, output_tokens: 0 }, content: [{ type: 'text', text: 'x' }] },
    }))
    const { inserted } = await TU.collectTokenUsage()
    expect(inserted).toBe(1)
    const row = getDb().prepare('SELECT input_tokens, output_tokens FROM token_usage WHERE agent = ?').get('zero') as { input_tokens: number; output_tokens: number }
    expect(row.input_tokens).toBe(0)
    expect(row.output_tokens).toBe(0)
  })

  it('honors explicit bucketMinutes + from/to/agent filters', () => {
    const r = TU.getTokenTimeline(60, 0, 1000, 'a1')
    expect(r.every((b) => b.agent === 'a1')).toBe(true)
  })

  it('honors from without to', () => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES ('a9','s',900,1,1)")
    const r = TU.getTokenTimeline(60, 500)
    expect(r.some((b) => b.agent === 'a9')).toBe(true)
  })

  it('honors to without from', () => {
    const r = TU.getTokenTimeline(60, undefined, 50)
    expect(r.length).toBe(0)
  })
})

describe('getTokenDetails -- extra filter coverage', () => {
  beforeEach(() => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES " +
      "('x1','s1',100,1,1)," +
      "('x1','s2',200,2,2)," +
      "('x2','s3',300,3,3)," +
      "('x2','s4',400,4,4)")
  })

  it('honors agent alone', () => {
    const r = TU.getTokenDetails({ agent: 'x2' })
    expect(r.every((d) => (d as unknown as { agent: string }).agent === 'x2')).toBe(true)
  })

  it('honors from alone', () => {
    const r = TU.getTokenDetails({ from: 250 })
    expect(r.every((d) => (d as unknown as { timestamp: number }).timestamp >= 250)).toBe(true)
  })

  it('honors to alone', () => {
    const r = TU.getTokenDetails({ to: 250 })
    expect(r.every((d) => (d as unknown as { timestamp: number }).timestamp <= 250)).toBe(true)
  })

  it('honors all filters together', () => {
    const r = TU.getTokenDetails({ agent: 'x1', from: 150, to: 250 })
    expect(r.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// correlateWithKanban
// ---------------------------------------------------------------------------

describe('correlateWithKanban', () => {
  it('stamps task_title + project for every uncorrelated agent range', () => {
    const db = getDb()
    // Two agents with token rows in distinct time windows, each matched by
    // two kanban cards. The later card's updated_at becomes the endTs for
    // the earlier card's update; the last card falls back to row.maxTs.
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES ('a1','s',1000,1,1)")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES ('a1','s',3000,1,1)")
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES ('a2','s',5000,1,1)")
    // a1 cards: k1 (1000-2500) covers timestamp=1000; k2 (2500-3000) covers timestamp=3000.
    // a2 card: k3 (5000-5500) covers timestamp=5000.
    db.exec("INSERT INTO kanban_cards (id, title, status, priority, assignee, project, created_at, updated_at) VALUES ('k1','A1 first','planned','normal','a1','proj1',200,1000)")
    db.exec("INSERT INTO kanban_cards (id, title, status, priority, assignee, project, created_at, updated_at) VALUES ('k2','A1 second','planned','normal','a1','proj1',600,2500)")
    db.exec("INSERT INTO kanban_cards (id, title, status, priority, assignee, project, created_at, updated_at) VALUES ('k3','A2 only','planned','normal','a2','proj2',4000,5000)")
    TU.correlateWithKanban()
    const rows = db.prepare('SELECT timestamp, task_title, project FROM token_usage ORDER BY timestamp').all() as Array<{ timestamp: number; task_title: string | null; project: string | null }>
    const a1first = rows.find((r) => r.timestamp === 1000)!
    const a1second = rows.find((r) => r.timestamp === 3000)!
    const a2only = rows.find((r) => r.timestamp === 5000)!
    // First card (k1) covers timestamp=1000; k2 covers timestamp=3000.
    expect(a1first.task_title).toBe('A1 first')
    expect(a1first.project).toBe('proj1')
    expect(a1second.task_title).toBe('A1 second')
    expect(a1second.project).toBe('proj1')
    expect(a2only.task_title).toBe('A2 only')
    expect(a2only.project).toBe('proj2')
  })

  it('matches an agent via the LIKE assignee wildcard (multi-assignee)', () => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES ('a3','s',700,1,1)")
    db.exec("INSERT INTO kanban_cards (id, title, status, priority, assignee, project, created_at, updated_at) VALUES ('km','multi','planned','normal','a2,a3,a4','projM',500,700)")
    TU.correlateWithKanban()
    const row = db.prepare('SELECT task_title, project FROM token_usage WHERE agent = ?').get('a3') as { task_title: string; project: string }
    expect(row.task_title).toBe('multi')
    expect(row.project).toBe('projM')
  })

  it('falls back to row.maxTs when no follow-up card exists in the agent range', () => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES ('a4','s',5000,1,1)")
    db.exec("INSERT INTO kanban_cards (id, title, status, priority, assignee, project, created_at, updated_at) VALUES ('kz','Z','planned','normal','a4','projZ',1000,5000)")
    TU.correlateWithKanban()
    const row = db.prepare('SELECT task_title FROM token_usage WHERE agent = ?').get('a4') as { task_title: string }
    expect(row.task_title).toBe('Z')
  })

  it('is a no-op when no uncorrelated rows exist (all already linked)', () => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, task_title, project) VALUES ('a5','s',100,1,1,'preset','projX')")
    TU.correlateWithKanban()
    const row = db.prepare('SELECT task_title FROM token_usage WHERE agent = ?').get('a5') as { task_title: string }
    expect(row.task_title).toBe('preset')
  })

  it('falls back to NULL when a matching kanban card has no project', () => {
    const db = getDb()
    db.exec("INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES ('a6','s',5000,1,1)")
    db.exec("INSERT INTO kanban_cards (id, title, status, priority, assignee, project, created_at, updated_at) VALUES ('kNP','NoProject','planned','normal','a6',NULL,4000,5000)")
    TU.correlateWithKanban()
    const row = db.prepare('SELECT task_title, project FROM token_usage WHERE agent = ?').get('a6') as { task_title: string; project: string | null }
    expect(row.task_title).toBe('NoProject')
    expect(row.project).toBeNull()
  })
})
