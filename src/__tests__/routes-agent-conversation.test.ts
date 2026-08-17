import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { IncomingMessage, ServerResponse } from 'node:http'
import { Socket } from 'node:net'
import {
  mkdirSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { RouteContext } from '../web/routes/types.js'

const H = vi.hoisted(() => {
  const fs = require('node:fs')
  const os = require('node:os')
  const path = require('node:path')
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'routes-agent-conversation-'))
  const projectRoot = path.join(sandbox, 'project')
  const agentsRoot = path.join(sandbox, 'agents')
  const projectsDir = path.join(sandbox, 'projects')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(agentsRoot, { recursive: true })

  return {
    sandbox,
    projectRoot,
    agentsRoot,
    projectsDir,
    json: vi.fn<(res: unknown, data: unknown, status?: number) => void>(),
    agentDir: vi.fn<(name: string) => string>(name => path.join(agentsRoot, name)),
    resolveAgentConfigDir: vi.fn<(name: string) => { configDir: string | null }>(() => ({ configDir: null })),
    projectsDirFor: vi.fn<(workingDir: string, configDir?: string) => string>(() => projectsDir),
    isMainChannelsAgent: vi.fn<(name: string) => boolean>(name => name === 'main'),
  }
})

vi.mock('../config.js', () => ({
  PROJECT_ROOT: H.projectRoot,
}))

vi.mock('../web/http-helpers.js', () => ({
  json: H.json,
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: H.agentDir,
}))

vi.mock('../web/claude-plans.js', () => ({
  resolveAgentConfigDir: H.resolveAgentConfigDir,
}))

vi.mock('../web/active-model.js', () => ({
  projectsDirFor: H.projectsDirFor,
}))

vi.mock('../web/main-agent.js', () => ({
  isMainChannelsAgent: H.isMainChannelsAgent,
}))

const { tryHandleAgentConversation } = await import('../web/routes/agent-conversation.js')

interface CallResult {
  handled: boolean
  status: number
  body: unknown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function record(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) throw new TypeError('Expected an object response')
  return value
}

function makeContext(method: string, fullPath: string): RouteContext {
  const url = new URL(`http://127.0.0.1:3420${fullPath}`)
  const req = new IncomingMessage(new Socket())
  const res = new ServerResponse(req)
  return {
    req,
    res,
    path: url.pathname,
    method,
    url,
  } satisfies RouteContext
}

async function call(method: string, fullPath: string): Promise<CallResult> {
  H.json.mockClear()
  const handled = await tryHandleAgentConversation(makeContext(method, fullPath))
  const response = H.json.mock.calls.at(-1)
  return {
    handled,
    status: response ? (response[2] ?? 200) : 0,
    body: response?.[1],
  }
}

function writeTranscript(sessionId: string, lines: string[], mtimeMs = Date.now()): string {
  mkdirSync(H.projectsDir, { recursive: true })
  const file = join(H.projectsDir, `${sessionId}.jsonl`)
  writeFileSync(file, lines.join('\n'))
  const time = new Date(mtimeMs)
  utimesSync(file, time, time)
  return file
}

function userLine(text: string, timestamp = '2026-08-07T10:00:00.000Z'): string {
  return JSON.stringify({
    type: 'user',
    timestamp,
    message: { content: `<channel>${text}</channel>` },
  })
}

beforeEach(() => {
  rmSync(H.projectsDir, { recursive: true, force: true })
  H.json.mockReset()
  H.agentDir.mockReset().mockImplementation(name => join(H.agentsRoot, name))
  H.resolveAgentConfigDir.mockReset().mockReturnValue({ configDir: null })
  H.projectsDirFor.mockReset().mockReturnValue(H.projectsDir)
  H.isMainChannelsAgent.mockReset().mockImplementation(name => name === 'main')
})

afterAll(() => {
  rmSync(H.sandbox, { recursive: true, force: true })
})

describe('tryHandleAgentConversation dispatcher', () => {
  it('declines unrelated paths and wrong methods', async () => {
    expect((await call('GET', '/api/other')).handled).toBe(false)
    expect((await call('POST', '/api/agents/a/conversation')).handled).toBe(false)
    expect(H.json).not.toHaveBeenCalled()
  })

  it('pins the malformed encoded agent-name failure', async () => {
    await expect(call('GET', '/api/agents/%E0%A4%A/conversation')).rejects.toThrow(URIError)
    expect(H.json).not.toHaveBeenCalled()
  })
})

describe('transcript discovery', () => {
  it('returns the empty-history payload when the projects directory is absent', async () => {
    const result = await call('GET', '/api/agents/agent%20one/conversation')

    expect(result.handled).toBe(true)
    expect(result.status).toBe(200)
    expect(result.body).toEqual({
      agent: 'agent one',
      entries: [],
      total: 0,
      offset: 0,
      hasOlder: false,
      note: 'Nincs még beszélgetés-előzmény ehhez az agenthez.',
    })
    expect(H.resolveAgentConfigDir).toHaveBeenCalledWith('agent one')
    expect(H.projectsDirFor).toHaveBeenCalledWith(join(H.agentsRoot, 'agent one'), undefined)
  })

  it('returns empty history when the directory contains no jsonl file', async () => {
    mkdirSync(H.projectsDir, { recursive: true })
    writeFileSync(join(H.projectsDir, 'ignore.txt'), 'not a transcript')

    const result = await call('GET', '/api/agents/a/conversation')

    expect(result.body).toMatchObject({ agent: 'a', entries: [], total: 0 })
  })

  it('treats transcript-directory read failures as no history', async () => {
    writeFileSync(H.projectsDir, 'this path is a file, not a directory')

    const result = await call('GET', '/api/agents/a/conversation')

    expect(result.status).toBe(200)
    expect(result.body).toMatchObject({ agent: 'a', entries: [], total: 0 })
  })

  it('uses PROJECT_ROOT and no isolated config for the main channels agent', async () => {
    writeTranscript('main-session', [userLine('hello')])

    const result = await call('GET', '/api/agents/main/conversation')

    expect(result.status).toBe(200)
    expect(H.resolveAgentConfigDir).not.toHaveBeenCalled()
    expect(H.projectsDirFor).toHaveBeenCalledWith(H.projectRoot, undefined)
    expect(result.body).toMatchObject({ agent: 'main', sessionId: 'main-session', total: 1 })
  })

  it('passes an isolated config directory and chooses the newest jsonl by mtime', async () => {
    H.resolveAgentConfigDir.mockReturnValue({ configDir: join(H.sandbox, 'isolated-config') })
    writeTranscript('older', [userLine('old')], 1_700_000_000_000)
    writeTranscript('newer', [userLine('new')], 1_800_000_000_000)
    writeFileSync(join(H.projectsDir, 'ignored.log'), 'ignored')

    const result = await call('GET', '/api/agents/sub/conversation')

    expect(H.projectsDirFor).toHaveBeenCalledWith(
      join(H.agentsRoot, 'sub'),
      join(H.sandbox, 'isolated-config'),
    )
    expect(result.body).toMatchObject({ sessionId: 'newer', total: 1 })
  })

  it('returns 500 when the selected jsonl cannot be read', async () => {
    mkdirSync(join(H.projectsDir, 'broken.jsonl'), { recursive: true })

    const result = await call('GET', '/api/agents/a/conversation')

    expect(result.handled).toBe(true)
    expect(result.status).toBe(500)
    expect(result.body).toEqual({ error: 'A beszélgetés feldolgozása nem sikerült' })
  })
})

describe('timeline parsing', () => {
  it('parses inbound messages, notes, messaging tools, and every action label', async () => {
    const long = 'x'.repeat(6001)
    const assistantBlocks = [
      { type: 'text', text: '  narrated note  ' },
      { type: 'text', text: '   ' },
      { type: 'text', text: 42 },
      { type: 'tool_use', name: 'Bash', input: { description: 'list files', command: 'ignored' } },
      { type: 'tool_use', name: 'Bash', input: { description: 42, command: 'c'.repeat(100) } },
      { type: 'tool_use', name: 'Read', input: { file_path: '/tmp/a.txt' } },
      { type: 'tool_use', name: 'Write', input: { file_path: '/tmp/b.txt' } },
      { type: 'tool_use', name: 'Edit', input: { file_path: '/tmp/c.txt' } },
      { type: 'tool_use', name: 'mcp__mail__search_gmail', input: { query: 'from:a' } },
      { type: 'tool_use', name: 'mcp__mail__draft_gmail', input: { subject: 'Draft' } },
      { type: 'tool_use', name: 'mcp__mail__send_gmail', input: { subject: 'Sent' } },
      { type: 'tool_use', name: 'mcp__docs__import_to_google_doc', input: { file_name: 'Doc' } },
      { type: 'tool_use', name: 'mcp__slides__import_to_google_slides', input: { file_name: 'Deck' } },
      { type: 'tool_use', name: 'WebSearch', input: { query: 'vitest' } },
      { type: 'tool_use', name: 'mcp__browser__WebFetch', input: { url: 'https://example.test' } },
      { type: 'tool_use', name: 'mcp__files__download_attachment', input: {} },
      { type: 'tool_use', name: 'mcp__custom__do_thing', input: {} },
      { type: 'tool_use', name: 123, input: null },
      { type: 'tool_use', name: 'mcp__telegram__reply', input: { text: 'telegram reply' } },
      { type: 'tool_use', name: 'plugin__reply', input: { text: long } },
      { type: 'tool_use', name: 'plugin__reply', input: { text: 42 } },
      { type: 'tool_use', name: 'mcp__telegram__react', input: { emoji: 'ok' } },
      { type: 'tool_use', name: 'plugin__react', input: {} },
      { type: 'tool_use', name: 'mcp__telegram__edit_message', input: { text: 'edited' } },
      { type: 'tool_use', name: 'plugin__edit_message', input: { text: 42 } },
      { type: 'unknown' },
    ]
    writeTranscript('rich', [
      '',
      '   ',
      'not json',
      JSON.stringify({ type: 'user', timestamp: 123 }),
      JSON.stringify({ type: 'user', timestamp: 123, message: { content: 42 } }),
      JSON.stringify({ type: 'user', message: { content: 'plain text' } }),
      JSON.stringify({ type: 'user', message: { content: '<channel broken' } }),
      JSON.stringify({
        type: 'user',
        timestamp: '2026-08-07T09:00:00.000Z',
        message: { content: '<channel> first inbound </channel><channel>   </channel><channel>second inbound</channel>' },
      }),
      JSON.stringify({ type: 'assistant', message: { content: 'not-an-array' } }),
      JSON.stringify({
        type: 'assistant',
        timestamp: '2026-08-07T09:01:00.000Z',
        message: { content: assistantBlocks },
      }),
      JSON.stringify({ type: 'other', message: { content: [] } }),
    ])

    const result = await call('GET', '/api/agents/a/conversation?limit=2000&offset=0')
    const body = record(result.body)
    const entries = body.entries
    if (!Array.isArray(entries)) throw new TypeError('Expected entries array')

    expect(result.status).toBe(200)
    expect(body.sessionId).toBe('rich')
    expect(body.hasOlder).toBe(false)
    expect(entries).toContainEqual({
      ts: '2026-08-07T09:00:00.000Z',
      kind: 'in',
      text: 'first inbound',
    })
    expect(entries).toContainEqual({
      ts: '2026-08-07T09:00:00.000Z',
      kind: 'in',
      text: 'second inbound',
    })
    expect(entries).toContainEqual({
      ts: '2026-08-07T09:01:00.000Z',
      kind: 'note',
      text: 'narrated note',
    })
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Bash: list files' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: `Bash: ${'c'.repeat(80)}` }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Read: /tmp/a.txt' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Write: /tmp/b.txt' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Edit: /tmp/c.txt' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Gmail keresés: from:a' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Gmail draft: Draft' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Email küldés: Sent' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Google Doc: Doc' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Google Slides: Deck' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Web keresés: vitest' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Web lekérés: https://example.test' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'Csatolmány letöltés' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: 'do_thing' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'action', text: '' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'out', text: 'telegram reply', label: 'válasz' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'out', text: `${'x'.repeat(6000)} …`, label: 'válasz' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'out', text: 'ok', label: 'reakció' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'out', text: '?', label: 'reakció' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'out', text: 'edited', label: 'szerkesztés' }))
    expect(entries).toContainEqual(expect.objectContaining({ kind: 'out', text: '', label: 'szerkesztés' }))
  })
})

describe('pagination', () => {
  beforeEach(() => {
    writeTranscript('pages', [
      userLine('one'),
      userLine('two'),
      userLine('three'),
      userLine('four'),
      userLine('five'),
    ])
  })

  it('windows older entries with a floored positive offset', async () => {
    const result = await call('GET', '/api/agents/a/conversation?limit=2&offset=1.9')

    expect(result.body).toMatchObject({
      total: 5,
      offset: 1,
      hasOlder: true,
      count: 2,
      entries: [
        expect.objectContaining({ text: 'three' }),
        expect.objectContaining({ text: 'four' }),
      ],
    })
  })

  it('caps a large limit and returns an empty page when offset exceeds total', async () => {
    const result = await call('GET', '/api/agents/a/conversation?limit=9999&offset=999')

    expect(result.body).toMatchObject({
      total: 5,
      offset: 999,
      hasOlder: false,
      count: 0,
      entries: [],
    })
  })

  it('uses defaults for non-finite query values', async () => {
    const result = await call('GET', '/api/agents/a/conversation?limit=oops&offset=Infinity')

    expect(result.body).toMatchObject({ total: 5, offset: 0, count: 5, hasOlder: false })
  })

  it('uses defaults for finite non-positive query values', async () => {
    const result = await call('GET', '/api/agents/a/conversation?limit=-2&offset=-3')

    expect(result.body).toMatchObject({ total: 5, offset: 0, count: 5, hasOlder: false })
  })

  it('returns floored limit entries for a fractional request', async () => {
    const result = await call('GET', '/api/agents/a/conversation?limit=2.5')

    expect(result.body).toMatchObject({ total: 5, count: 2, entries: [
      expect.objectContaining({ text: 'four' }),
      expect.objectContaining({ text: 'five' }),
    ] })
  })

  it('covers the defensive null session id fallback', async () => {
    H.json.mockClear()
    const ctx = makeContext('GET', '/api/agents/a/conversation')
    const popSpy = vi.spyOn(Array.prototype, 'pop').mockReturnValueOnce(undefined)
    const pending = tryHandleAgentConversation(ctx)
    popSpy.mockRestore()
    const handled = await pending
    const response = H.json.mock.calls.at(-1)

    expect(handled).toBe(true)
    expect(response?.[1]).toMatchObject({ sessionId: null })
  })
})
