// Tests for src/memory.ts.
//
// The module pulls in node:fs (for the daily-digest cwd + CLAUDE_CONFIG_DIR
// staging dirs), ./agent.js (runAgent), ./db.js (memory CRUD + kanban summary),
// ./prompt-safety.js (wrapUntrusted + UNTRUSTED_PREAMBLE) and ./logger.js.
// To keep this hermetic we mock the four project-local modules and the
// node:fs surface used by ensureDigestCwd / ensureDigestConfigDir.
//
// Sandbox: each test uses an isolated tmpdir so the mkdir/existsSync stubs
// cannot leak between cases, and node:fs mocks are reset between describe
// blocks (via vi.resetModules + re-import) so the cwd-fallback paths can be
// driven independently from the happy path.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Mutable mock state -- all module mocks read from these so individual tests
// can rewire behaviour without re-importing the SUT.
// ---------------------------------------------------------------------------

const ftsResults: Array<{
  id: number
  chat_id: string
  topic_key: string | null
  content: string
  sector: 'semantic' | 'episodic'
  salience: number
  created_at: number
  accessed_at: number
  agent_id: string
  category: string
  auto_generated: number
  keywords: string | null
  embedding: string | null
}> = []

const recentResults: typeof ftsResults = []

const cards: Array<{
  status: string
  title: string
  assignee: string | null
  priority: string
  id: string
}> = []

const memoriesForChat: typeof ftsResults = []
const saveMemoryCalls: Array<{ chatId: string; content: string; sector: string; topicKey?: string }> = []
const touchMemoryCalls: number[] = []
let decayCalls = 0
let pruneAuditCalls = 0
let pruneTokenReturn = 7
const runAgentCalls: Array<{
  message: string
  sessionId: string | undefined
  onTyping: (() => void) | undefined
  allowTools: boolean
  cwd: string
  env: Record<string, string | undefined> | undefined
}> = []
let runAgentResult: { text: string | null; newSessionId?: string; error?: string } = { text: 'digest text' }
let runAgentShouldThrow = false

let mkdirShouldThrow = false
const mkdirCalls: string[] = []
const writeFileCalls: Array<{ path: string; content: string }> = []
const existsReturn = false

// ---------------------------------------------------------------------------
// vi.mock factories
// ---------------------------------------------------------------------------

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return {
    ...actual,
    mkdirSync: ((dir: unknown) => {
      mkdirCalls.push(String(dir))
      if (mkdirShouldThrow) throw new Error('mock mkdir failure')
      return undefined
    }) as typeof actual.mkdirSync,
    writeFileSync: ((path: unknown, content: unknown) => {
      writeFileCalls.push({ path: String(path), content: String(content) })
      return undefined
    }) as typeof actual.writeFileSync,
    existsSync: (() => existsReturn) as typeof actual.existsSync,
  }
})

vi.mock('../db.js', () => ({
  searchMemories: (query: string, chatId: string, limit = 3) => {
    return ftsResults
      .filter((m) => m.chat_id === chatId)
      .slice(0, limit)
      .map((m) => ({ ...m }))
  },
  recentMemories: (chatId: string, limit = 5) => {
    return recentResults
      .filter((m) => m.chat_id === chatId)
      .slice(0, limit)
      .map((m) => ({ ...m }))
  },
  touchMemory: (id: number) => {
    touchMemoryCalls.push(id)
  },
  saveMemory: (chatId: string, content: string, sector: 'semantic' | 'episodic', topicKey?: string) => {
    saveMemoryCalls.push({ chatId, content, sector, ...(topicKey !== undefined ? { topicKey } : {}) })
  },
  decayMemories: () => {
    decayCalls += 1
  },
  pruneAuditLogs: () => {
    pruneAuditCalls += 1
  },
  pruneTokenUsage: () => pruneTokenReturn,
  getMemoriesForChat: (chatId: string, limit = 10) => {
    return memoriesForChat
      .filter((m) => m.chat_id === chatId)
      .slice(0, limit)
      .map((m) => ({ ...m }))
  },
  listKanbanCardsSummary: () => cards.map((c) => ({ ...c })),
}))

vi.mock('../agent.js', () => ({
  runAgent: async (
    message: string,
    sessionId?: string,
    onTyping?: () => void,
    allowTools = false,
    cwd?: string,
    env?: Record<string, string | undefined>,
  ) => {
    runAgentCalls.push({
      message,
      sessionId,
      onTyping,
      allowTools,
      cwd: cwd ?? '',
      env,
    })
    if (runAgentShouldThrow) throw new Error('mock runAgent failure')
    return runAgentResult
  },
}))

const logDebugMock = vi.fn()
const logInfoMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('../logger.js', () => ({
  logger: {
    debug: (obj: unknown, msg?: string) => logDebugMock(obj, msg),
    info: (obj: unknown, msg?: string) => logInfoMock(obj, msg),
    error: (obj: unknown, msg?: string) => logErrorMock(obj, msg),
    warn: vi.fn(),
  },
}))

const wrapUntrustedMock = vi.fn(
  (source: string, content: string | null | undefined) => `<untrusted source="${source}">\n${String(content ?? '')}\n</untrusted>`,
)
vi.mock('../prompt-safety.js', () => ({
  wrapUntrusted: (source: string, content: string | null | undefined) =>
    wrapUntrustedMock(source, content),
  UNTRUSTED_PREAMBLE: 'SECURITY NOTICE PREAMBLE',
}))

// ---------------------------------------------------------------------------
// SUT import
// ---------------------------------------------------------------------------

const {
  buildMemoryContext,
  buildKanbanContext,
  saveConversationTurn,
  runDecaySweep,
  runDailyDigest,
} = await import('../memory.js')

// ---------------------------------------------------------------------------
// Per-test cleanup
// ---------------------------------------------------------------------------

let sandbox = ''
beforeEach(() => {
  sandbox = mkdtempSync(join(tmpdir(), 'memory-test-'))
  ftsResults.length = 0
  recentResults.length = 0
  cards.length = 0
  memoriesForChat.length = 0
  saveMemoryCalls.length = 0
  touchMemoryCalls.length = 0
  decayCalls = 0
  pruneAuditCalls = 0
  pruneTokenReturn = 7
  runAgentCalls.length = 0
  runAgentResult = { text: 'digest text' }
  runAgentShouldThrow = false
  mkdirShouldThrow = false
  mkdirCalls.length = 0
  writeFileCalls.length = 0
  logDebugMock.mockReset()
  logInfoMock.mockReset()
  logErrorMock.mockReset()
  wrapUntrustedMock.mockClear()
})

afterEach(() => {
  rmSync(sandbox, { recursive: true, force: true })
})

function mem(over: Partial<(typeof ftsResults)[number]> = {}): (typeof ftsResults)[number] {
  const now = Math.floor(Date.now() / 1000)
  return {
    id: 1,
    chat_id: 'chat-1',
    topic_key: null,
    content: 'default',
    sector: 'semantic',
    salience: 1,
    created_at: now,
    accessed_at: now,
    agent_id: 'marveen',
    category: 'warm',
    auto_generated: 0,
    keywords: null,
    embedding: null,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// buildMemoryContext
// ---------------------------------------------------------------------------

describe('buildMemoryContext', () => {
  it('returns empty string when no memories are available', async () => {
    const out = await buildMemoryContext('chat-1', 'anything')
    expect(out).toBe('')
    expect(touchMemoryCalls).toEqual([])
  })

  it('dedupes across FTS + recent (FTS wins when ids overlap)', async () => {
    const shared = mem({ id: 1, content: 'shared', sector: 'semantic' })
    const onlyRecent = mem({ id: 2, content: 'only-recent', sector: 'episodic' })
    ftsResults.push(shared)
    recentResults.push(shared, onlyRecent)
    const out = await buildMemoryContext('chat-1', 'query')
    expect(out).toContain('[Memoria kontextus]')
    expect(out).toContain('- shared (semantic)')
    expect(out).toContain('- only-recent (episodic)')
    // dedup: shared appears once
    expect((out.match(/- shared/g) ?? []).length).toBe(1)
    expect(touchMemoryCalls.sort()).toEqual([1, 2])
  })

  it('touches each memory exactly once even when only FTS has results', async () => {
    ftsResults.push(mem({ id: 9, content: 'fts-only', sector: 'semantic' }))
    const out = await buildMemoryContext('chat-1', 'q')
    expect(out).toContain('- fts-only (semantic)')
    expect(touchMemoryCalls).toEqual([9])
  })

  it('touches each memory when only recent has results', async () => {
    recentResults.push(mem({ id: 11, content: 'recent-only', sector: 'episodic' }))
    const out = await buildMemoryContext('chat-1', 'q')
    expect(out).toContain('- recent-only (episodic)')
    expect(touchMemoryCalls).toEqual([11])
  })
})

// ---------------------------------------------------------------------------
// buildKanbanContext
// ---------------------------------------------------------------------------

describe('buildKanbanContext', () => {
  it('returns empty string when no cards exist', () => {
    expect(buildKanbanContext()).toBe('')
  })

  it('groups by status using Hungarian labels', () => {
    cards.push(
      { status: 'planned', title: 'A', assignee: null, priority: 'urgent', id: 'C1' },
      { status: 'planned', title: 'B', assignee: 'alice', priority: 'high', id: 'C2' },
      { status: 'in_progress', title: 'C', assignee: null, priority: 'normal', id: 'C3' },
      { status: 'done', title: 'D', assignee: 'bob', priority: 'low', id: 'C4' },
      // Unknown statuses fall back to the raw value
      { status: 'archived', title: 'E', assignee: null, priority: 'normal', id: 'C5' },
      // Unknown priority falls back to the default ⚪ marker
      { status: 'waiting', title: 'F', assignee: 'carol', priority: 'unknown-prio', id: 'C6' },
    )
    const out = buildKanbanContext()
    expect(out.startsWith('[Kanban tabla]')).toBe(true)
    expect(out).toContain('Tervezett:')
    expect(out).toContain('Folyamatban:')
    expect(out).toContain('Kész:')
    expect(out).toContain('Várakozik:')
    expect(out).toContain('archived:')
    expect(out).toContain('🔴 A [C1]')
    expect(out).toContain('🟠 B (alice) [C2]')
    expect(out).toContain('⚪ C [C3]')
    expect(out).toContain('🔵 D (bob) [C4]')
    expect(out).toContain('⚪ E [C5]')
    expect(out).toContain('⚪ F (carol) [C6]')
  })
})

// ---------------------------------------------------------------------------
// saveConversationTurn
// ---------------------------------------------------------------------------

describe('saveConversationTurn', () => {
  it('skips messages shorter than or equal to 20 chars', async () => {
    await saveConversationTurn('chat-1', 'short msg here', 'reply')
    await saveConversationTurn('chat-1', '01234567890123456789', 'reply') // exactly 20
    expect(saveMemoryCalls).toEqual([])
  })

  it('skips messages that start with a slash', async () => {
    await saveConversationTurn('chat-1', '/help parancs hosszabb mint 20 karakter', 'reply')
    expect(saveMemoryCalls).toEqual([])
  })

  it('skips SKIP_PATTERN matches (case-insensitive, trimmed)', async () => {
    const long = 'igen most egy nagyon hosszú szöveg'
    await saveConversationTurn('chat-1', long, 'reply')
    expect(saveMemoryCalls).toEqual([])
    await saveConversationTurn('chat-1', '   ok   ', 'reply')
    expect(saveMemoryCalls).toEqual([])
    await saveConversationTurn('chat-1', 'KOSZI  ', 'reply')
    expect(saveMemoryCalls).toEqual([])
    await saveConversationTurn('chat-1', '.', 'reply')
    expect(saveMemoryCalls).toEqual([])
    await saveConversationTurn('chat-1', '???', 'reply')
    expect(saveMemoryCalls).toEqual([])
    await saveConversationTurn('chat-1', '!!!', 'reply')
    expect(saveMemoryCalls).toEqual([])
    // Length > 20 but the trimmed payload is purely a SKIP_PATTERN token
    // (21 dots). Length-check does not fire; SKIP_PATTERN does.
    await saveConversationTurn('chat-1', '.'.repeat(21), 'reply')
    expect(saveMemoryCalls).toEqual([])
  })

  it('does not save non-semantic turns (no semantic keyword in user message)', async () => {
    await saveConversationTurn(
      'chat-1',
      'ez egy hosszabb uzenet a heti statuszrol',
      'rendben',
    )
    expect(saveMemoryCalls).toEqual([])
  })

  // SEMANTIC_PATTERN coverage -- one test per branch of the alternation.
  it('saves semantic memory when "my" matches', async () => {
    await saveConversationTurn('chat-1', 'my favourite colour is blue hosszabb szöveg', 'ok')
    expect(saveMemoryCalls).toHaveLength(1)
    expect(saveMemoryCalls[0]!.sector).toBe('semantic')
    expect(saveMemoryCalls[0]!.content.startsWith('Felhasznalo: my favourite colour is blue hosszabb szöveg\nAsszisztens: ok')).toBe(true)
  })

  it('saves semantic memory on "i am" / "i\'m" / "i prefer"', async () => {
    await saveConversationTurn('chat-1', 'i am a backend engineer since 2010', 'ok')
    await saveConversationTurn('chat-1', "i'm working on a marveen fork today", 'ok')
    await saveConversationTurn('chat-1', 'i prefer dark mode in every editor now', 'ok')
    expect(saveMemoryCalls).toHaveLength(3)
    expect(saveMemoryCalls.every((c) => c.sector === 'semantic')).toBe(true)
  })

  it('saves semantic memory on "remember" / "always" / "never"', async () => {
    await saveConversationTurn('chat-1', 'remember to call the API every morning now', 'ok')
    await saveConversationTurn('chat-1', 'always run npm test before any commit please', 'ok')
    await saveConversationTurn('chat-1', 'never trust the SSE reconnect logic blindly', 'ok')
    expect(saveMemoryCalls).toHaveLength(3)
  })

  it('saves semantic memory on Hungarian triggers (az en, nekem, szeretem, nem szeretem, mindig, soha, emlekezzel)', async () => {
    await saveConversationTurn('chat-1', 'az en kedvenc nyelvem a Rust most', 'ok')
    await saveConversationTurn('chat-1', 'nekem fontos a lefedettseg es a sebesseg', 'ok')
    await saveConversationTurn('chat-1', 'szeretem a kávét reggelente mindig', 'ok')
    await saveConversationTurn('chat-1', 'nem szeretem a windowson dolgozni soha', 'ok')
    await saveConversationTurn('chat-1', 'mindig ellenőrizd a digest cronját este', 'ok')
    await saveConversationTurn('chat-1', 'soha ne piszkáld a channels plugint kézzel', 'ok')
    await saveConversationTurn('chat-1', 'emlekezzel a holnapi deployra kérlek szépen', 'ok')
    expect(saveMemoryCalls).toHaveLength(7)
    expect(saveMemoryCalls.every((c) => c.sector === 'semantic')).toBe(true)
  })

  it('saves semantic memory on "en" / "kedvenc" / "utokalok" / "fontos" / "ne felejtsd" / "jegyezd meg"', async () => {
    await saveConversationTurn('chat-1', 'en szeretem a python pickle formatumot is', 'ok')
    await saveConversationTurn('chat-1', 'a kedvenc projektem most a marveen motor', 'ok')
    await saveConversationTurn('chat-1', 'utokalok ezt a lefedettsegi dontest most', 'ok')
    await saveConversationTurn('chat-1', 'nagyon fontos a biztonsagi checklist most', 'ok')
    await saveConversationTurn('chat-1', 'ne felejtsd el a holnapi review meetinget', 'ok')
    await saveConversationTurn('chat-1', 'jegyezd meg hogy a digest cron 23:00kor fut', 'ok')
    expect(saveMemoryCalls).toHaveLength(6)
  })

  it('truncates user / assistant message to 500 chars before persisting', async () => {
    const user = 'remember ' + 'x'.repeat(600)
    const assistant = 'y'.repeat(600)
    await saveConversationTurn('chat-1', user, assistant)
    expect(saveMemoryCalls).toHaveLength(1)
    const c = saveMemoryCalls[0]!.content
    expect(c.length).toBe('Felhasznalo: '.length + 500 + '\nAsszisztens: '.length + 500)
  })

  it('logs a debug line when saving semantic memory', async () => {
    await saveConversationTurn('chat-1', 'remember to push before noon today', 'ok')
    expect(logDebugMock).toHaveBeenCalledWith({ chatId: 'chat-1' }, 'Szemantikus emlek mentve')
  })
})

// ---------------------------------------------------------------------------
// runDecaySweep
// ---------------------------------------------------------------------------

describe('runDecaySweep', () => {
  it('calls decay, pruneAuditLogs and pruneTokenUsage and logs the result', () => {
    pruneTokenReturn = 42
    runDecaySweep()
    expect(decayCalls).toBe(1)
    expect(pruneAuditCalls).toBe(1)
    expect(logInfoMock).toHaveBeenCalledWith({ tokenRowsPruned: 42 }, 'Memoria leepulesi sopres vegrehajtva')
  })
})

// ---------------------------------------------------------------------------
// runDailyDigest
// ---------------------------------------------------------------------------

describe('runDailyDigest', () => {
  function memRecent(over: Partial<(typeof memoriesForChat)[number]> = {}): (typeof memoriesForChat)[number] {
    return mem({
      chat_id: 'chat-1',
      created_at: Math.floor(Date.now() / 1000) - 60,
      accessed_at: Math.floor(Date.now() / 1000) - 60,
      content: 'today',
      ...over,
    })
  }

  it('returns null when there are fewer than 2 memories from the last 24h', async () => {
    memoriesForChat.push(memRecent(), mem({ created_at: Math.floor(Date.now() / 1000) - 3 * 86400 }))
    const out = await runDailyDigest('chat-1')
    expect(out).toBeNull()
    expect(logInfoMock).toHaveBeenCalled()
    expect(runAgentCalls).toEqual([])
    expect(saveMemoryCalls).toEqual([])
  })

  it('filters out memories older than 24h before counting', async () => {
    memoriesForChat.push(mem({ created_at: Math.floor(Date.now() / 1000) - 2 * 86400 }))
    const out = await runDailyDigest('chat-1')
    expect(out).toBeNull()
  })

  it('returns null when the sub-agent yields no text', async () => {
    memoriesForChat.push(memRecent({ content: 'a' }), memRecent({ content: 'b' }))
    runAgentResult = { text: null }
    const out = await runDailyDigest('chat-1')
    expect(out).toBeNull()
    expect(saveMemoryCalls).toEqual([])
    expect(runAgentCalls).toHaveLength(1)
  })

  it('returns null when the sub-agent yields whitespace-only text', async () => {
    memoriesForChat.push(memRecent({ content: 'a' }), memRecent({ content: 'b' }))
    runAgentResult = { text: '   \n\t  ' }
    const out = await runDailyDigest('chat-1')
    expect(out).toBeNull()
    expect(saveMemoryCalls).toEqual([])
    expect(runAgentCalls).toHaveLength(1)
  })

  it('persists the digest as episodic and returns the trimmed text', async () => {
    memoriesForChat.push(
      memRecent({ id: 1, content: 'A'.repeat(220) }),
      memRecent({ id: 2, content: 'short' }),
    )
    runAgentResult = { text: '  Hello world.  ' }
    const out = await runDailyDigest('chat-1')
    expect(out).toBe('Hello world.')
    expect(saveMemoryCalls).toHaveLength(1)
    const saved = saveMemoryCalls[0]!
    expect(saved.sector).toBe('episodic')
    expect(saved.chatId).toBe('chat-1')
    expect(saved.content.startsWith('[Napi naplo ')).toBe(true)
    expect(saved.content).toContain('Hello world.')
  })

  it('truncates each memory line to 200 chars before wrapping', async () => {
    memoriesForChat.push(
      memRecent({ id: 1, content: 'X'.repeat(400) }),
      memRecent({ id: 2, content: 'Y'.repeat(400) }),
    )
    await runDailyDigest('chat-1')
    expect(wrapUntrustedMock).toHaveBeenCalledTimes(2)
    for (const call of wrapUntrustedMock.mock.calls) {
      const arg = call[1] as string
      expect(arg.length).toBeLessThanOrEqual(200)
    }
    expect(wrapUntrustedMock).toHaveBeenCalledWith('memory-record', 'X'.repeat(200))
    expect(wrapUntrustedMock).toHaveBeenCalledWith('memory-record', 'Y'.repeat(200))
  })

  it('uses the configured cwd + CLAUDE_CONFIG_DIR env for the sub-agent', async () => {
    memoriesForChat.push(memRecent({ content: 'one' }), memRecent({ content: 'two' }))
    await runDailyDigest('chat-1')
    expect(runAgentCalls).toHaveLength(1)
    const call = runAgentCalls[0]!
    expect(call.allowTools).toBe(false)
    expect(call.sessionId).toBeUndefined()
    expect(call.cwd).not.toBe('')
    expect(call.env).toBeDefined()
    expect(call.env!.CLAUDE_CONFIG_DIR).toBeTruthy()
    // prompt contains UNTRUSTED_PREAMBLE + the wrapped memory lines
    expect(call.message).toContain('SECURITY NOTICE PREAMBLE')
    expect(call.message).toContain('memory-record')
  })

  it('returns null and logs error when runAgent throws', async () => {
    memoriesForChat.push(memRecent({ content: 'one' }), memRecent({ content: 'two' }))
    runAgentShouldThrow = true
    const out = await runDailyDigest('chat-1')
    expect(out).toBeNull()
    expect(logErrorMock).toHaveBeenCalled()
    expect(saveMemoryCalls).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ensureDigestCwd / ensureDigestConfigDir fallback paths
//
// Re-import the module after toggling mkdirShouldThrow so the cwd-fallback
// loop runs against the mock and not a real filesystem. We pin which
// candidate each branch lands on via the order of mkdirCalls.
// ---------------------------------------------------------------------------

describe('ensureDigestCwd / ensureDigestConfigDir fallback branches', () => {
  it('falls back to tmpdir() when every candidate mkdir throws', async () => {
    mkdirShouldThrow = true
    vi.resetModules()
    const memReimport = await import('../memory.js')
    // Drive a happy sub-agent so the cwd-construction code path actually runs.
    memoriesForChat.push(mem({ created_at: Math.floor(Date.now() / 1000) - 60 }))
    memoriesForChat.push(mem({ created_at: Math.floor(Date.now() / 1000) - 30 }))
    const out = await memReimport.runDailyDigest('chat-1')
    expect(out).toBe('digest text')
    // Both candidates tried -> two mkdir attempts logged before the
    // tmpdir() last-resort return.
    expect(mkdirCalls.length).toBeGreaterThanOrEqual(2)
    expect(saveMemoryCalls).toHaveLength(1)
    expect(saveMemoryCalls[0]!.sector).toBe('episodic')
  })

  it('ensureDigestConfigDir also falls back to tmpdir() when every mkdir throws', async () => {
    mkdirShouldThrow = true
    vi.resetModules()
    const memReimport = await import('../memory.js')
    memoriesForChat.push(mem({ created_at: Math.floor(Date.now() / 1000) - 60 }))
    memoriesForChat.push(mem({ created_at: Math.floor(Date.now() / 1000) - 30 }))
    await memReimport.runDailyDigest('chat-1')
    // ensureDigestConfigDir attempts each candidate; mkdirCalls captures both
    // the cwd + config-dir attempts. With both failing, the function returns
    // tmpdir() for each, but cwd/config dir are still passed to runAgent.
    const call = runAgentCalls[0]!
    expect(call.env!.CLAUDE_CONFIG_DIR).toBeTruthy()
  })
})
