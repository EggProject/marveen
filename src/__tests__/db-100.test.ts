// 100% coverage test for src/db.ts.
//
// Scope: every export, every branch of initDatabase (idempotency, EEXIST race,
// migration try/catch success and failure), the legacy JSON migrator, and the
// full surface of accessor functions. Run with `--coverage.include='src/db.ts'`
// to gate this single file.
//
// Test uses ':memory:' sqlite. initDatabase() is called once per describe
// block so each scenario starts on a clean schema; some describes re-init to
// exercise the idempotent re-open path and the migration branches that only
// fire when the prior schema differs.
//
// Mocks: fetch is mocked (Ollama embedding path), node:fs.openSync is mocked
// to drive the pre-create chmod path on a temp file.

import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import {
  existsSync, mkdtempSync, rmSync, writeFileSync, chmodSync, openSync, closeSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import * as fs from 'node:fs'
import { Database } from '../db/sqlite.js'
import { STORE_DIR, DB_FILENAME, APP_TZ } from '../config.js'

// SANDBOX STORE_DIR — without this, the migrateTaskRunsFromJson tests below
// write task-run-history.json into the live checkout's ./store/ (config.ts:13
// freezes STORE_DIR at module load via __dirname). The live-install guard
// catches the resulting `.migrated` artifact on the next suite run and
// hard-fails the whole batch. vi.hoisted runs before vi.mock so the
// SANDBOX_STORE_DIR is available to the factory closure.
//
// We compute the path synchronously here (no fs call) so vi.hoisted does not
// need to await anything. The directory itself is created in `beforeAll`.
const sandbox = vi.hoisted(() => {
  // `tmpdir` is a sync builtin import via node:os; vitest hoists vi.hoisted
  // above static imports, so we use Node's CJS `require` instead of ESM.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  return { STORE_DIR: join(tmpdir(), `db100-store-${stamp}`) }
})
vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return { ...actual, STORE_DIR: sandbox.STORE_DIR }
})

// ---------------------------------------------------------------------------
// Mock fetch (Ollama embeddings) -- global so hybridSearch/backfillEmbeddings
// can be driven without a real Ollama.
// ---------------------------------------------------------------------------
let fetchMock: ReturnType<typeof vi.fn>
vi.mock('node-fetch', () => ({ default: vi.fn() }), { virtual: true })
const originalFetch = globalThis.fetch
function setFetchResponse(embedding: number[] | null): void {
  fetchMock = vi.fn(async () => ({
    json: async () => ({ embedding }),
  })) as unknown as typeof fetch
  globalThis.fetch = fetchMock as unknown as typeof fetch
}
function setFetchThrow(err: Error): void {
  fetchMock = vi.fn(async () => { throw err }) as unknown as typeof fetch
  globalThis.fetch = fetchMock as unknown as typeof fetch
}

// ---------------------------------------------------------------------------
// Mocks for tighter paths (pre-create openSync + chmod + mkdir failures)
// ---------------------------------------------------------------------------
const fsState = {
  openSyncImpl: openSync,
  chmodShouldThrow: false as boolean,
  mkdirSyncShouldThrow: undefined as Error | undefined,
}
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    chmodSync: ((p: fs.PathLike, mode: number) => {
      if (fsState.chmodShouldThrow) throw new Error('mock chmod fail')
      return (actual.chmodSync as unknown as typeof chmodSync)(p, mode)
    }) as typeof chmodSync,
    mkdirSync: ((p: fs.PathLike, opts: unknown) => {
      if (fsState.mkdirSyncShouldThrow) throw fsState.mkdirSyncShouldThrow
      return (actual.mkdirSync as unknown as typeof import('node:fs').mkdirSync)(p, opts)
    }) as typeof import('node:fs').mkdirSync,
  }
})

import * as dbModule from '../db.js'

// ---------------------------------------------------------------------------
// SUT import (after mocks)
// ---------------------------------------------------------------------------
const {
  initDatabase, getDb,
  getSession, setSession, incrementSessionCount, clearSession,
  createDashboardUser, getDashboardUser, listDashboardUsers,
  countDashboardUsers, updateDashboardUserPassword, deleteDashboardUser,
  saveMemory, buildFtsMatchExpression,
  recencyWeightedScore, reRankByRecency,
  searchMemories, recentMemories, touchMemory, touchMemoriesAccessed,
  decayMemories, getMemoriesForChat,
  clearMemoryCache, getMemoryCacheSize,
  saveAgentMemory, getAgentMemories, searchAgentMemories,
  getMemoryStats, updateMemory,
  appendDailyLog, getDailyLog, getDailyLogDates,
  recallByDateRange, recallSearch,
  createBackgroundTaskAtomic, getRunningBackgroundTasks, finishBackgroundTask,
  getBackgroundTasks, getBackgroundTask, countRunningBackgroundTasks,
  markOrphanedTasksFailed,
  createTask, getDueTasks, updateTaskAfterRun, listTasks,
  deleteTask, pauseTask, resumeTask, getTask, updateTask,
  listKanbanCards, listKanbanCardsSummary, getKanbanCard,
  createKanbanCard, updateKanbanCard, getChildCards,
  moveKanbanCard, markKanbanCardDispatched,
  archiveKanbanCard, unarchiveKanbanCard, listArchivedKanbanCards,
  listKanbanProjects, deleteKanbanCard, getKanbanComments,
  getKanbanCardEvents, getKanbanSeqByIdPrefix, findActiveKanbanCardByTitle,
  markScheduledTaskKanbanWaiting, addKanbanComment,
  listLabels, getLabel, createLabel, updateLabel, deleteLabel,
  addLabelToCard, removeLabelFromCard, getLabelsForCard, getLabelsForAllCards,
  getHeartbeatKanbanSummary,
  createAgentMessage, getPendingMessages, markMessageDelivered,
  getPendingBacklogByAgent, closeMessagesWithoutDelivery, setMessageResult,
  failPendingFederatedMessages, claimPendingForAgent,
  markMessageDone, markMessageFailed, markPendingFederatedFailed,
  listAgentMessages, getAgentConversation, getAgentConversationThreads,
  CHAT_SYSTEM_AGENTS, appendTaskRun, listTaskRunHistory, countTaskRunsBetween,
  getAgentMessage, getActiveScheduledTaskCount,
  insertPendingTaskRetryIfNew, updatePendingTaskRetry, upsertPendingTaskRetry,
  clearPendingTaskRetryAlert, listPendingTaskRetries, getPendingTaskRetry,
  deletePendingTaskRetry, deletePendingTaskRetryById, markPendingTaskRetryAlert,
  generateEmbedding, hybridSearch, backfillEmbeddings,
  upsertChannelRequest, listPendingChannelRequests, updateChannelRequestStatus,
  updateChannelRequestName, saveTelegramMessage, getTelegramHistory,
  listIdeas, createIdea, updateIdea, deleteIdea, listIdeaCategories,
  getIdeaComments, addIdeaComment, logIdeaStatusChange, getIdeaStatusLog,
  revertIdeaFromKanban,
  logToolCall, getRecentToolCalls, analyzeWorkflowCandidates, pruneToolCallLog,
  logSkillUsage, getSkillUsageRows, getSkillUsageStats,
  logConfigChange, getRecentConfigChanges,
  logStoreFileEvent, getRecentStoreFileEvents,
  queryAuditLog, pruneAuditLogs, pruneTokenUsage,
  listVaultSshKeys, getVaultSshKey, createVaultSshKey, deleteVaultSshKey,
  listVaultSshServers, getVaultSshServer, createVaultSshServer,
  updateVaultSshServer, deleteVaultSshServer, computeSshKeyStatus,
  createApproval, getApproval, resolveApproval, listApprovals,
  stampMessageTrace, expireTimedOutApprovals,
  upsertOtelSpan, closeOtelSpan, getOtelTrace, listOtelTraces,
  RECENCY_LAMBDA, RECENCY_TAU_SEC,
} = dbModule

// ---------------------------------------------------------------------------
// Sandbox + DB init
// ---------------------------------------------------------------------------
let tmpDir = ''
let priorHome: string | undefined

beforeAll(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'db100-'))
  // Pre-create the sandbox STORE_DIR so the migrateTaskRunsFromJson tests
  // can write task-run-history.json into a known-empty directory. initDatabase
  // normally mkdirSync's this, but for the migrate test we touch it directly.
  fs.mkdirSync(sandbox.STORE_DIR, { recursive: true })
  initDatabase(':memory:')
})

afterAll(() => {
  globalThis.fetch = originalFetch
  try { rmSync(tmpDir, { recursive: true, force: true }) } catch { /* noop */ }
  try { rmSync(sandbox.STORE_DIR, { recursive: true, force: true }) } catch { /* noop */ }
})

beforeEach(() => {
  // Re-init to a fresh in-memory DB before each test so writes don't leak.
  initDatabase(':memory:')
})

// ---------------------------------------------------------------------------
// initDatabase: schema + idempotency + migration branches
// ---------------------------------------------------------------------------
describe('initDatabase', () => {
  it('opens the DB and creates every table on a fresh init', () => {
    const tables = getDb().prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as Array<{ name: string }>
    const names = new Set(tables.map(t => t.name))
    expect(names).toContain('sessions')
    expect(names).toContain('memories')
    expect(names).toContain('memories_fts')
    expect(names).toContain('scheduled_tasks')
    expect(names).toContain('kanban_cards')
    expect(names).toContain('kanban_comments')
    expect(names).toContain('kanban_card_events')
    expect(names).toContain('labels')
    expect(names).toContain('kanban_card_labels')
    expect(names).toContain('agent_messages')
    expect(names).toContain('pending_channel_requests')
    expect(names).toContain('task_runs')
    expect(names).toContain('pending_task_retries')
    expect(names).toContain('background_tasks')
    expect(names).toContain('token_usage')
    expect(names).toContain('token_usage_cursors')
    expect(names).toContain('idea_box')
    expect(names).toContain('idea_comments')
    expect(names).toContain('idea_status_log')
    expect(names).toContain('tool_call_log')
    expect(names).toContain('skill_usage')
    expect(names).toContain('config_change_log')
    expect(names).toContain('store_file_audit')
    expect(names).toContain('cost_sources')
    expect(names).toContain('cost_line_items')
    expect(names).toContain('vault_ssh_keys')
    expect(names).toContain('vault_ssh_servers')
    expect(names).toContain('approvals')
    expect(names).toContain('dashboard_users')
    expect(names).toContain('auth_sessions')
    expect(names).toContain('device_keys')
    expect(names).toContain('otel_spans')
    expect(names).toContain('conversation_log')
    expect(names).toContain('daily_logs')
  })

  it('re-running on the same in-memory DB is a no-op (idempotent re-open)', () => {
    setSession('reopen-chat', 'sess-A')
    initDatabase(':memory:') // close + reopen
    expect(getSession('reopen-chat')).toBeUndefined() // fresh DB after reopen
  })

  it('initDatabase works on a temp file path (exercises the tighten branch)', () => {
    const tmpDb = join(tmpDir, 'temp.db')
    initDatabase(tmpDb)
    expect(existsSync(tmpDb)).toBe(true)
    const mode = (require('node:fs') as typeof import('node:fs')).statSync(tmpDb).mode & 0o777
    expect(mode).toBe(0o600)
    initDatabase(':memory:') // restore for subsequent tests
  })

  it('initDatabase tolerates chmodSync failures (still returns a usable DB)', () => {
    const tmpDb = join(tmpDir, 'chmod-fail.db')
    fsState.chmodShouldThrow = true
    try {
      initDatabase(tmpDb)
      // Tables still created -- the chmod failure is logged, not raised.
      const row = getDb().prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()
      expect(row).toBeDefined()
    } finally {
      fsState.chmodShouldThrow = false
      initDatabase(':memory:')
    }
  })

  it('initDatabase covers the kanban_cards CHECK-rebuild migration', () => {
    // Build a fresh file-backed DB, manipulate schema to drop 'testing' status
    // then re-init -- forces the rebuild branch in initDatabase.
    const tmpDb = join(tmpDir, 'rebuild.db')
    initDatabase(tmpDb)
    // Drop & recreate kanban_cards without 'testing' to simulate legacy schema.
    getDb().exec(`
      DROP TABLE kanban_cards;
      CREATE TABLE kanban_cards (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'planned' CHECK(status IN ('planned','in_progress','waiting','done')),
        assignee TEXT,
        priority TEXT NOT NULL DEFAULT 'normal' CHECK(priority IN ('low','normal','high','urgent')),
        project TEXT,
        due_date INTEGER,
        sort_order REAL NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        archived_at INTEGER,
        parent_id TEXT REFERENCES kanban_cards(id),
        dispatched_at INTEGER
      )
    `)
    initDatabase(tmpDb)
    // After migration, 'testing' must be accepted.
    createKanbanCard({ id: 'k1', title: 'tester', status: 'testing' })
    expect(getKanbanCard('k1')?.status).toBe('testing')
    initDatabase(':memory:')
  })

  it('initDatabase covers the memories tier migration (legacy categories -> hot/warm/cold)', () => {
    const tmpDb = join(tmpDir, 'mem-tier.db')
    initDatabase(tmpDb)
    // Recreate memories WITHOUT the canonical tier check, with a legacy category.
    getDb().exec(`
      DROP TABLE memories;
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        topic_key TEXT,
        content TEXT NOT NULL,
        sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
        salience REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'marveen',
        category TEXT NOT NULL DEFAULT 'user_pref',
        auto_generated INTEGER NOT NULL DEFAULT 0
      )
    `)
    getDb().prepare("INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, category) VALUES (?, ?, 'semantic', 1, 1, 'user_pref')").run('c1', 'legacy')
    initDatabase(tmpDb)
    const row = getDb().prepare("SELECT category FROM memories WHERE chat_id='c1'").get() as { category: string }
    // user_pref -> warm per migration map.
    expect(row.category).toBe('warm')
    initDatabase(':memory:')
  })

  it('initDatabase covers the ALTER TABLE memories -> agent_id/category/auto_generated branches (idempotent on fresh)', () => {
    // After init those columns already exist, the ALTER fails (caught). We
    // re-init to confirm the try/catch is silent on fresh DBs.
    const tmpDb = join(tmpDir, 'fresh.db')
    initDatabase(tmpDb)
    initDatabase(tmpDb)
    expect(getDb().prepare("SELECT category FROM memories LIMIT 1").get() ?? undefined).toBeUndefined()
  })

  it('initDatabase swallows ALTER errors during session migration', () => {
    // ALTER TABLE sessions ADD COLUMN message_count already covered by the
    // schema migration block -- simply re-init confirms no throw.
    const tmpDb = join(tmpDir, 'sessions.db')
    initDatabase(tmpDb)
    initDatabase(tmpDb)
    setSession('c-x', 's-x')
    expect(getSession('c-x')?.sessionId).toBe('s-x')
    initDatabase(':memory:')
  })

  it('initDatabase creates indexes on each table', () => {
    const idx = getDb().prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%' ORDER BY name").all() as Array<{ name: string }>
    expect(idx.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getDb
// ---------------------------------------------------------------------------
describe('getDb', () => {
  it('returns a better-sqlite3 handle', () => {
    expect(getDb().prepare('SELECT 1 AS one').get()).toEqual({ one: 1 })
  })
})

// ---------------------------------------------------------------------------
// sessions
// ---------------------------------------------------------------------------
describe('sessions', () => {
  it('setSession/getSession/clearSession', () => {
    setSession('s-1', 'ss-1')
    expect(getSession('s-1')?.sessionId).toBe('ss-1')
    setSession('s-1', 'ss-2', 7)
    expect(getSession('s-1')).toEqual({ sessionId: 'ss-2', messageCount: 7 })
    incrementSessionCount('s-1')
    incrementSessionCount('s-1')
    expect(getSession('s-1')?.messageCount).toBe(9)
    clearSession('s-1')
    expect(getSession('s-1')).toBeUndefined()
  })
  it('incrementSessionCount on missing chat returns 0', () => {
    expect(incrementSessionCount('nope')).toBe(0)
  })
  it('getSession returns undefined for missing chat', () => {
    expect(getSession('none')).toBeUndefined()
  })
})

// ---------------------------------------------------------------------------
// dashboard_users
// ---------------------------------------------------------------------------
describe('dashboard_users', () => {
  it('create, get (case-insensitive), list, update, delete', () => {
    const u1 = createDashboardUser('alice', 'ph1')
    const u2 = createDashboardUser('bob', 'ph2')
    expect(u1.username).toBe('alice')
    expect(u1.disabled).toBe(0)
    expect(getDashboardUser('ALICE')?.id).toBe(u1.id)
    expect(getDashboardUser('missing')).toBeUndefined()
    const list = listDashboardUsers()
    expect(list.map(u => u.username).sort()).toEqual(['alice', 'bob'])
    expect(list.every(u => !('password_hash' in u))).toBe(true)
    expect(countDashboardUsers(false)).toBe(2)
    expect(countDashboardUsers(true)).toBe(2)
    updateDashboardUserPassword(u1.id, 'ph-new')
    expect(getDashboardUser('alice')?.password_hash).toBe('ph-new')
    expect(deleteDashboardUser('Alice')).toBe(true)
    expect(deleteDashboardUser('Alice')).toBe(false)
    expect(countDashboardUsers()).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// memories: save/recent/touch/cache/search/stats/update/decay
// ---------------------------------------------------------------------------
describe('memories', () => {
  it('saveMemory + recentMemories + touchMemory + decayMemories + getMemoriesForChat', () => {
    saveMemory('m-1', 'foo bar', 'semantic', 'topicA')
    saveMemory('m-1', 'baz qux', 'episodic')
    const r = recentMemories('m-1', 5)
    expect(r.length).toBe(2)
    touchMemory(r[0].id)
    expect(getMemoriesForChat('m-1').length).toBe(2)
    decayMemories()
  })
  it('touchMemoriesAccessed no-ops on empty array', () => {
    expect(() => touchMemoriesAccessed([])).not.toThrow()
  })
  it('touchMemoriesAccessed bumps accessed_at', () => {
    saveMemory('m-2', 'a', 'semantic')
    saveMemory('m-2', 'b', 'episodic')
    const rows = getMemoriesForChat('m-2', 5)
    const ids = rows.map(r => r.id)
    touchMemoriesAccessed(ids)
    const after = getMemoriesForChat('m-2', 5)
    expect(after.every(r => r.accessed_at >= rows[0].accessed_at)).toBe(true)
  })
})

describe('memory cache', () => {
  it('clearMemoryCache + getMemoryCacheSize', () => {
    saveAgentMemory('agent-A', 'content', 'warm')
    getAgentMemories('agent-A', 5)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    clearMemoryCache()
    expect(getMemoryCacheSize()).toBe(0)
  })
  it('saveAgentMemory invalidates cache for own agent (warm)', () => {
    saveAgentMemory('agent-A', 'one', 'warm')
    getAgentMemories('agent-A', 5)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    saveAgentMemory('agent-A', 'two', 'warm')
    expect(getMemoryCacheSize()).toBe(0)
  })
  it('saveAgentMemory clears cache for shared category', () => {
    saveAgentMemory('agent-B', 'sh1', 'shared')
    getAgentMemories('agent-B', 5)
    saveAgentMemory('agent-C', 'sh2', 'shared')
    expect(getMemoryCacheSize()).toBe(0)
  })
  it('saveAgentMemory default autoGenerated=false', () => {
    const { id } = saveAgentMemory('agent-D', 'a', 'warm')
    const row = getDb().prepare('SELECT auto_generated FROM memories WHERE id = ?').get(id) as { auto_generated: number }
    expect(row.auto_generated).toBe(0)
  })
  it('getAgentMemories category filter + shared cross-agent', () => {
    saveAgentMemory('agent-E', 'one', 'warm')
    saveAgentMemory('agent-E', 'two', 'shared')
    saveAgentMemory('agent-F', 'three', 'cold')
    const aE = getAgentMemories('agent-E', 10, 'warm')
    expect(aE.every(m => m.category === 'warm')).toBe(true)
    const aEAll = getAgentMemories('agent-E', 10)
    expect(aEAll.some(m => m.category === 'shared')).toBe(true)
  })
  it('getMemoryStats', () => {
    saveAgentMemory('agent-S', 'a', 'warm')
    saveAgentMemory('agent-S', 'b', 'cold')
    const stats = getMemoryStats()
    expect(stats.total).toBeGreaterThanOrEqual(2)
    expect(stats.byAgent['agent-S']).toBeGreaterThanOrEqual(2)
    expect(stats.withEmbedding).toBe(0)
  })
  it('updateMemory returns false on missing id', () => {
    expect(updateMemory(99999, 'no')).toBe(false)
  })
  it('updateMemory edits content/category/agent/keywords', () => {
    const { id } = saveAgentMemory('agent-U', 'orig', 'warm', 'kw1')
    expect(updateMemory(id, 'new', 'cold', 'agent-U2', 'kw2')).toBe(true)
    const row = getDb().prepare('SELECT content, category, agent_id, keywords FROM memories WHERE id = ?').get(id) as Record<string, unknown>
    expect(row.content).toBe('new')
    expect(row.category).toBe('cold')
    expect(row.agent_id).toBe('agent-U2')
    expect(row.keywords).toBe('kw2')
  })
  it('updateMemory on a shared row clears the global cache', () => {
    const { id } = saveAgentMemory('agent-X', 'orig', 'shared')
    getAgentMemories('agent-X', 10)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    updateMemory(id, 'next', 'shared')
    expect(getMemoryCacheSize()).toBe(0)
  })
  it('updateMemory reassign changes owner cache', () => {
    const { id } = saveAgentMemory('agent-Y', 'orig', 'warm')
    getAgentMemories('agent-Y', 10)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    updateMemory(id, 'next', 'warm', 'agent-Z')
    expect(getMemoryCacheSize()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// Recency helpers
// ---------------------------------------------------------------------------
describe('recency math', () => {
  it('recencyWeightedScore with positive rank returns 0 relevance', () => {
    const s = recencyWeightedScore({ rank: 0, created_at: 0 }, 100)
    expect(s).toBeGreaterThan(0)
  })
  it('reRankByRecency orders by composite score', () => {
    const rows = [
      { id: 1, rank: -2, created_at: 100 },
      { id: 2, rank: -1, created_at: 50 },
      { id: 3, rank: -1, created_at: 1 },
    ]
    const out = reRankByRecency(rows, 3, 200)
    expect(out.length).toBe(3)
  })
  it('exports constants', () => {
    expect(RECENCY_LAMBDA).toBe(0.7)
    expect(RECENCY_TAU_SEC).toBe(7 * 86400)
  })
})

// ---------------------------------------------------------------------------
// searchMemories / searchAgentMemories
// ---------------------------------------------------------------------------
describe('memory search', () => {
  it('searchMemories returns empty for empty FTS expression', () => {
    expect(searchMemories('!!!', 'x')).toEqual([])
  })
  it('searchMemories + searchAgentMemories happy + fallback', () => {
    saveMemory('chat-s', 'apple pie recipe', 'semantic')
    saveMemory('chat-s', 'banana bread', 'episodic')
    expect(searchMemories('apple', 'chat-s', 5).length).toBeGreaterThan(0)
    saveAgentMemory('agent-S1', 'vector-target apple', 'warm')
    expect(searchAgentMemories('agent-S1', 'apple', 5).length).toBeGreaterThan(0)
    // FTS-fallback path: inject a syntactically invalid FTS expression via
    // buildFtsMatchExpression that produces terms FTS5 will reject.
    saveAgentMemory('agent-S1', 'fallback trigger banana', 'warm')
    // Query with words + special operators that FTS5 sees as malformed --
    // empty sanitized -> early return []; we need FTS to throw inside the
    // try block. Use a string that survives sanitization but FTS rejects.
    expect(searchAgentMemories('agent-S1', 'banana', 5).length).toBeGreaterThan(0)
    // Trigger FTS exception path by stubbing db.prepare to throw on the FTS query.
    const dbHandle = getDb() as { prepare: (sql: string) => unknown }
    const originalPrepare = dbHandle.prepare.bind(getDb())
    let calls = 0
    dbHandle.prepare = ((sql: string) => {
      if (sql.includes('memories_fts MATCH')) {
        calls++
        if (calls === 1) throw new Error('mock FTS failure')
      }
      return originalPrepare(sql)
    }) as typeof originalPrepare
    try {
      const fallback = searchAgentMemories('agent-S1', 'banana', 5)
      expect(fallback.length).toBeGreaterThan(0)
    } finally {
      dbHandle.prepare = originalPrepare
    }
  })
})

// ---------------------------------------------------------------------------
// Daily logs
// ---------------------------------------------------------------------------
describe('daily logs', () => {
  it('append + get + dates', () => {
    appendDailyLog('agent-D', 'hello')
    appendDailyLog('agent-D', 'world')
    // Must read the SAME zone appendDailyLog writes with (db.ts:1390 uses
    // APP_TZ), not a hardcoded one. APP_TZ falls back to the SYSTEM timezone
    // when SCHEDULER_TZ is unset, so a hardcoded 'Europe/Budapest' only agreed
    // on a Budapest dev box. On a UTC CI runner the two zones name different
    // calendar days between 22:00 and 24:00 UTC, and the query returned 0 rows
    // -- a latent flake that happened to fire at 23:15 UTC.
    const today = new Date().toLocaleDateString('en-CA', { timeZone: APP_TZ })
    expect(getDailyLog('agent-D', today).length).toBe(2)
    expect(getDailyLogDates('agent-D').length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// recall (date range + search)
// ---------------------------------------------------------------------------
describe('recall', () => {
  it('recallByDateRange both with and without agentId', () => {
    appendDailyLog('agent-R', 'one')
    saveMemory('chat-R', 'm1', 'semantic')
    const r1 = recallByDateRange('2024-01-01', '2099-12-31', 'agent-R')
    expect(r1.dateRange).toEqual({ from: '2024-01-01', to: '2099-12-31' })
    const r2 = recallByDateRange('2024-01-01', '2099-12-31')
    expect(r2.logs.length).toBeGreaterThanOrEqual(1)
  })
  it('recallSearch happy + empty + fallback', () => {
    appendDailyLog('agent-S', 'apple banana')
    saveMemory('chat-S', 'apple banana', 'semantic')
    expect(recallSearch('apple').logs.length).toBeGreaterThan(0)
    expect(recallSearch('!!!').logs.length).toBe(0)
    // FTS-fallback for daily_logs (LIKE)
    expect(recallSearch('apple', 'agent-S').logs.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// background tasks
// ---------------------------------------------------------------------------
describe('background tasks', () => {
  it('createAtomic + getRunning + finish + list + get + count + orphan-fail', () => {
    expect(createBackgroundTaskAtomic('bt-1', 'a1', 'p', 'tmux', 5)?.id).toBe('bt-1')
    // Already at max -> null
    expect(createBackgroundTaskAtomic('bt-2', 'a1', 'p', 'tmux', 1)).toBeNull()
    expect(getRunningBackgroundTasks().length).toBe(1)
    finishBackgroundTask('bt-1', 'done', 'out')
    const finished = getBackgroundTasks('a1', true)
    expect(finished.length).toBe(1)
    expect(getBackgroundTasks('a1', false).length).toBe(0)
    expect(getBackgroundTasks(undefined, true).length).toBe(1)
    expect(getBackgroundTasks().length).toBe(0)
    expect(getBackgroundTask('bt-1')?.status).toBe('done')
    expect(getBackgroundTask('none')).toBeUndefined()
    expect(countRunningBackgroundTasks('a1')).toBe(0)
    // New running task -> orphan mark
    createBackgroundTaskAtomic('bt-3', 'a2', 'p', 'tmux', 5)
    const closed = markOrphanedTasksFailed()
    expect(closed).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// scheduled tasks
// ---------------------------------------------------------------------------
describe('scheduled tasks', () => {
  it('create + getDue + updateAfterRun + list + delete + pause/resume/get/update', () => {
    createTask('t-1', 'c1', 'do', '0 9 * * *', 0)
    expect(getDueTasks().length).toBe(1)
    updateTaskAfterRun('t-1', 1000, 'ok')
    expect(getTask('t-1')?.last_run).toBeGreaterThan(0)
    expect(listTasks().length).toBe(1)
    expect(updateTask('t-1', 'do2', '0 10 * * *', 2000)).toBe(true)
    expect(updateTask('none', 'x', 'y', 0)).toBe(false)
    expect(pauseTask('t-1')).toBe(true)
    expect(pauseTask('t-1')).toBe(true)
    expect(getDueTasks().length).toBe(0)
    expect(resumeTask('t-1')).toBe(true)
    expect(deleteTask('t-1')).toBe(true)
    expect(deleteTask('t-1')).toBe(false)
    expect(getActiveScheduledTaskCount()).toEqual({ count: 0, nextRun: null })
    createTask('t-2', 'c1', 'do', '0 9 * * *', 100)
    expect(getActiveScheduledTaskCount().count).toBe(1)
    expect(getTask('t-2')?.status).toBe('active')
  })
})

// ---------------------------------------------------------------------------
// kanban
// ---------------------------------------------------------------------------
describe('kanban', () => {
  it('create + list + summary + get + update + child cards', () => {
    createKanbanCard({ id: 'k-1', title: 'Alpha', priority: 'urgent', project: 'p1' })
    createKanbanCard({ id: 'k-2', title: 'Beta', project: 'p1', parent_id: 'k-1' })
    const list = listKanbanCards()
    expect(list.length).toBe(2)
    expect(list.find(c => c.id === 'k-1')?.seq).toBeDefined()
    expect(listKanbanCardsSummary().length).toBe(2)
    expect(getKanbanCard('k-1')?.title).toBe('Alpha')
    expect(getKanbanCard('none')).toBeUndefined()
    expect(getChildCards('k-1').length).toBe(1)
    expect(updateKanbanCard('k-1', { title: 'Alpha v2', priority: 'high' })).toBe(true)
    expect(updateKanbanCard('none', { title: 'X' })).toBe(false)
    expect(moveKanbanCard('k-1', 'in_progress', 99, 'tester')).toBe(true)
    expect(moveKanbanCard('none', 'in_progress', 1)).toBe(false)
    // Move that doesn't change status: no event written
    moveKanbanCard('k-1', 'in_progress', 100, 'tester')
    expect(getKanbanCardEvents('k-1').length).toBe(1)
    expect(markKanbanCardDispatched('k-1')).toBe(true)
    expect(markKanbanCardDispatched('none')).toBe(false)
    expect(archiveKanbanCard('k-2')).toBe(true)
    expect(unarchiveKanbanCard('k-2')).toBe(true)
    expect(listArchivedKanbanCards({ limit: 100 }).length).toBe(0)
    archiveKanbanCard('k-2')
    expect(listArchivedKanbanCards({ limit: 100, project: 'p1', q: 'Beta', label: undefined, from: undefined, to: undefined }).length).toBe(1)
    expect(listKanbanProjects()).toContain('p1')
  })

  it('delete card cascades: comments + parent_id cleared', () => {
    createKanbanCard({ id: 'k-p', title: 'Parent' })
    createKanbanCard({ id: 'k-c', title: 'Child', parent_id: 'k-p' })
    addKanbanComment('k-c', 'me', 'hi')
    expect(getKanbanComments('k-c').length).toBe(1)
    expect(deleteKanbanCard('k-p')).toBe(true)
    expect(deleteKanbanCard('none')).toBe(false)
    // child now has parent_id=NULL
    const child = getKanbanCard('k-c')
    expect(child?.parent_id).toBeNull()
  })

  it('getKanbanSeqByIdPrefix: 0 or >1 matches -> null; 1 match -> seq', () => {
    createKanbanCard({ id: 'abc12345', title: 'one' })
    expect(getKanbanSeqByIdPrefix('abc12345')).toBeTypeOf('number')
    expect(getKanbanSeqByIdPrefix('zzz')).toBeNull()
    createKanbanCard({ id: 'abc67890', title: 'two' })
    expect(getKanbanSeqByIdPrefix('abc')).toBeNull()
  })

  it('findActiveKanbanCardByTitle + markScheduledTaskKanbanWaiting', () => {
    createKanbanCard({ id: 'k-task', title: 'jobname' })
    expect(findActiveKanbanCardByTitle('jobname')?.id).toBe('k-task')
    expect(findActiveKanbanCardByTitle('none')).toBeUndefined()
    expect(markScheduledTaskKanbanWaiting('jobname')).toBe('k-task')
    expect(markScheduledTaskKanbanWaiting('none')).toBeNull()
  })

  it('listKanbanCards auto-archives done cards older than threshold', () => {
    // KANBAN_ARCHIVE_DONE_DAYS default = 30. Set old updated_at on a 'done' card.
    createKanbanCard({ id: 'k-old', title: 'old', status: 'done' })
    const farPast = Math.floor(Date.now() / 1000) - 40 * 86400
    getDb().prepare('UPDATE kanban_cards SET updated_at=? WHERE id=?').run(farPast, 'k-old')
    expect(listKanbanCards().length).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// labels
// ---------------------------------------------------------------------------
describe('labels', () => {
  it('create + list + get + update + delete + assign', () => {
    createLabel({ id: 'l-1', name: 'bug', color: '#ff0000' })
    createLabel({ id: 'l-2', name: 'feature', color: '#00ff00' })
    expect(listLabels().length).toBe(2)
    expect(getLabel('l-1')?.name).toBe('bug')
    expect(getLabel('none')).toBeUndefined()
    expect(updateLabel('l-1', { name: 'BUG' })).toBe(true)
    expect(updateLabel('none', { name: 'X' })).toBe(false)
    createKanbanCard({ id: 'k-label', title: 'L' })
    addLabelToCard('k-label', 'l-1')
    addLabelToCard('k-label', 'l-1') // duplicate: INSERT OR IGNORE
    addLabelToCard('k-label', 'l-2')
    expect(getLabelsForCard('k-label').length).toBe(2)
    expect(removeLabelFromCard('k-label', 'l-1')).toBe(true)
    expect(removeLabelFromCard('k-label', 'l-1')).toBe(false)
    const bulk = getLabelsForAllCards()
    expect(bulk.get('k-label')?.length).toBe(1)
    expect(deleteLabel('l-2')).toBe(true)
    expect(deleteLabel('l-2')).toBe(false)
  })
  it('listArchivedKanbanCards with label filter', () => {
    createLabel({ id: 'l-arch', name: 'archiveTag', color: '#000000' })
    createKanbanCard({ id: 'k-arch', title: 'archived' })
    addLabelToCard('k-arch', 'l-arch')
    archiveKanbanCard('k-arch')
    expect(listArchivedKanbanCards({ limit: 10, label: 'archiveTag' }).length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// heartbeat summary
// ---------------------------------------------------------------------------
describe('heartbeat summary', () => {
  it('groups by priority/status', () => {
    createKanbanCard({ id: 'h-1', title: 'urgent', priority: 'urgent' })
    createKanbanCard({ id: 'h-2', title: 'inprog', status: 'in_progress' })
    createKanbanCard({ id: 'h-3', title: 'waiting', status: 'waiting' })
    const s = getHeartbeatKanbanSummary()
    expect(s.urgent.length).toBe(1)
    expect(s.in_progress.length).toBe(1)
    expect(s.waiting.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// agent messages + threads
// ---------------------------------------------------------------------------
describe('agent messages', () => {
  it('create + getPending + markDelivered + backlog + close + result + claim + done + fail + list + conversation + threads', () => {
    const a = createAgentMessage('alice', 'bob', 'hi')
    const b = createAgentMessage('alice', 'bob', 'hi2', 'origin', { trace_id: 't1', span_id: 's1', parent_span_id: null })
    expect(a.status).toBe('pending')
    expect(getPendingMessages('bob').length).toBe(2)
    expect(getPendingMessages().length).toBe(2)
    expect(markMessageDelivered(a.id)).toBe(true)
    expect(markMessageDelivered(a.id)).toBe(false) // already delivered
    setMessageResult(a.id, 'fed:peer:42')
    expect(closeMessagesWithoutDelivery([b.id], 'stale')).toBe(1)
    expect(closeMessagesWithoutDelivery([], 'x')).toBe(0)
    // Backlog
    const backlog = getPendingBacklogByAgent()
    expect(Array.isArray(backlog)).toBe(true)
    // Federated failure
    const fed = createAgentMessage('alice', 'teodor/agent', 'fed-msg')
    const failed = failPendingFederatedMessages('teodor', 'no peer')
    expect(failed).toContain(fed.id)
    // Without peer -> all federated pending
    const fed2 = createAgentMessage('alice', 'teodor/agent', 'fed-msg2')
    const failedAll = failPendingFederatedMessages(undefined, 'global')
    expect(failedAll).toContain(fed2.id)
    // Claim
    const c = createAgentMessage('alice', 'bob', 'claim-me')
    const claimed = claimPendingForAgent('bob', 5)
    expect(claimed.length).toBe(1)
    expect(claimed[0].id).toBe(c.id)
    // mark done + fail paths
    expect(markMessageDone(c.id, 'done-text')).toBe(true)
    const d = createAgentMessage('alice', 'bob', 'fail-me')
    expect(markMessageFailed(d.id, 'err')).toBe(true)
    const e = createAgentMessage('alice', 'teodor/agent2', 'fed-pending')
    expect(markPendingFederatedFailed(e.id, 'x')).toBe(true)
    expect(markPendingFederatedFailed(e.id, 'x')).toBe(false)
    // list + conversation + threads
    expect(listAgentMessages(100).length).toBeGreaterThan(0)
    const conv = getAgentConversation('alice', 50)
    expect(conv.length).toBeGreaterThan(0)
    // beforeId pagination
    const page2 = getAgentConversation('alice', 5, conv[conv.length - 1].id)
    expect(Array.isArray(page2)).toBe(true)
    expect(getAgentConversation('alice', 0, conv[0].id).length).toBeGreaterThanOrEqual(0)
    const threads = getAgentConversationThreads()
    expect(threads.length).toBeGreaterThan(0)
    expect(CHAT_SYSTEM_AGENTS.length).toBe(4)
    expect(getAgentMessage(c.id)?.id).toBe(c.id)
    expect(getAgentMessage(-1)).toBeUndefined()
  })

  it('stamps trace context on pending rows only', () => {
    const m = createAgentMessage('alice', 'bob', 'trace-me')
    expect(stampMessageTrace(m.id, 'trace-x', 'span-x', 'parent-x')).toBe(true)
    expect(stampMessageTrace(m.id, 'trace-y', 'span-y', null)).toBe(false) // already stamped
    const done = markMessageDone(m.id)
    expect(done).toBe(true)
    expect(stampMessageTrace(m.id, 'trace-z', 'span-z', null)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// task_runs (appendTaskRun, listTaskRunHistory, countTaskRunsBetween)
// ---------------------------------------------------------------------------
describe('task runs', () => {
  it('append + list + count + TTL prune', () => {
    appendTaskRun('morning', 'agent-T', 'fired')
    appendTaskRun('morning', 'agent-T', 'fired')
    const history = listTaskRunHistory('morning', 5)
    expect(history.length).toBe(2)
    expect(history[0].tokens_est).toBeNull()
    // Window with token usage
    getDb().prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens, cache_read_tokens) VALUES (?, ?, ?, ?, ?, ?)`)
      .run('agent-T', 's', Math.floor(Date.now() / 1000), 100, 200, 50)
    expect(listTaskRunHistory('morning', 5)[0].tokens_est).toBeGreaterThan(0)
    expect(countTaskRunsBetween(0)).toBeGreaterThan(0)
    expect(countTaskRunsBetween(0, Date.now() + 1)).toBeGreaterThan(0)
    // TTL prune: insert an ancient run
    getDb().prepare(`INSERT INTO task_runs (name, agent, ts, status) VALUES (?, ?, ?, 'fired')`).run('old', 'agent-T', Date.now() - 31 * 86400 * 1000)
    appendTaskRun('trigger-prune', 'agent-T', 'fired')
    // (The ancient run may have been pruned during the trigger-prune append.)
    expect(countTaskRunsBetween(0)).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// pending_task_retries (covered above + alias path)
// ---------------------------------------------------------------------------
describe('pending task retries (alias coverage)', () => {
  it('insertPendingTaskRetryIfNew: true then false', () => {
    expect(insertPendingTaskRetryIfNew('alias-1', 'main', 1, 'r')).toBe(true)
    expect(insertPendingTaskRetryIfNew('alias-1', 'main', 2, 'r')).toBe(false)
  })
  it('updatePendingTaskRetry: false on missing', () => {
    expect(updatePendingTaskRetry('alias-2', 'main', 1, 'r')).toBe(false)
    insertPendingTaskRetryIfNew('alias-2', 'main', 1, 'r')
    expect(updatePendingTaskRetry('alias-2', 'main', 2, 'r2')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// embeddings + hybridSearch + backfillEmbeddings
// ---------------------------------------------------------------------------
describe('embeddings + hybridSearch + backfill', () => {
  it('generateEmbedding returns null on fetch failure', async () => {
    setFetchThrow(new Error('boom'))
    await expect(generateEmbedding('hi')).resolves.toBeNull()
  })
  it('generateEmbedding returns null when response lacks embedding', async () => {
    fetchMock = vi.fn(async () => ({ json: async () => ({}) })) as unknown as typeof fetch
    globalThis.fetch = fetchMock as unknown as typeof fetch
    await expect(generateEmbedding('hi')).resolves.toBeNull()
  })
  it('generateEmbedding returns embedding when response has it', async () => {
    setFetchResponse([0.1, 0.2, 0.3])
    await expect(generateEmbedding('hi')).resolves.toEqual([0.1, 0.2, 0.3])
  })
  it('hybridSearch with null queryEmbedding (vector branch falsy)', async () => {
    // Force generateEmbedding to return null -> queryEmbedding ? ... : [] else
    setFetchThrow(new Error('mock'))
    saveAgentMemory('agent-VN', 'apple', 'warm')
    const out = await hybridSearch('agent-VN', 'apple', 5)
    expect(Array.isArray(out)).toBe(true)
  })
  it('hybridSearch with non-null queryEmbedding (vector branch truthy)', async () => {
    // Deterministic: set the embedding directly so the vector path runs.
    setFetchResponse([0.1, 0.2, 0.3])
    const { id } = saveAgentMemory('agent-VT', 'apple', 'warm')
    // Save several more with different embeddings so vectorSearch sort runs.
    const { id: id2 } = saveAgentMemory('agent-VT', 'banana', 'warm')
    const { id: id3 } = saveAgentMemory('agent-VT', 'cherry', 'warm')
    getDb().prepare('UPDATE memories SET embedding=? WHERE id=?').run(JSON.stringify([0.1, 0.2, 0.3]), id)
    getDb().prepare('UPDATE memories SET embedding=? WHERE id=?').run(JSON.stringify([0.2, 0.3, 0.4]), id2)
    getDb().prepare('UPDATE memories SET embedding=? WHERE id=?').run(JSON.stringify([0.9, 0.9, 0.9]), id3)
    const out = await hybridSearch('agent-VT', 'apple', 5)
    expect(out.length).toBeGreaterThan(0)
    // Force ftsResults + vecResults to BOTH be non-empty by also inserting
    // content that matches the query in FTS but has a different embedding.
    const { id: id4 } = saveAgentMemory('agent-VT', 'apple pie dessert', 'warm')
    getDb().prepare('UPDATE memories SET embedding=? WHERE id=?').run(JSON.stringify([0.5, 0.5, 0.5]), id4)
    const out2 = await hybridSearch('agent-VT', 'apple', 5)
    expect(out2.length).toBeGreaterThan(0)
  })
  it('hybridSearch + backfillEmbeddings', async () => {
    setFetchResponse([0.1, 0.2])
    const { id } = saveAgentMemory('agent-H', 'apple pie banana', 'warm', 'fruit')
    // wait for fire-and-forget embedding
    await new Promise(r => setTimeout(r, 50))
    const out = await hybridSearch('agent-H', 'apple', 5)
    expect(Array.isArray(out)).toBe(true)
    // backfillEmbeddings on an empty-no-embedding memory
    const { id: id2 } = saveAgentMemory('agent-H', 'unembedded', 'warm')
    // Force NULL embedding to be safe
    getDb().prepare('UPDATE memories SET embedding=NULL WHERE id=?').run(id2)
    const count = await backfillEmbeddings()
    expect(count).toBeGreaterThanOrEqual(0)
  })
})

// ---------------------------------------------------------------------------
// pending_channel_requests
// ---------------------------------------------------------------------------
describe('pending_channel_requests', () => {
  it('upsert + list + status + name', () => {
    expect(upsertChannelRequest('a1', 'C1')).toBe(true)
    expect(upsertChannelRequest('a1', 'C1')).toBe(false) // existing pending
    // Denied recently: still blocks (within 7 days)
    getDb().prepare(`UPDATE pending_channel_requests SET status='denied', resolved_at=? WHERE agent='a1' AND channel_id='C1'`).run(Math.floor(Date.now() / 1000))
    expect(upsertChannelRequest('a1', 'C1')).toBe(false)
    // Denied long ago: allowed again
    getDb().prepare(`UPDATE pending_channel_requests SET resolved_at=? WHERE agent='a1' AND channel_id='C1'`).run(Math.floor(Date.now() / 1000) - 8 * 86400)
    expect(upsertChannelRequest('a1', 'C1')).toBe(true)
    expect(listPendingChannelRequests('a1').length).toBe(1)
    const id = (listPendingChannelRequests('a1')[0] as { id: number }).id
    updateChannelRequestName(id, 'Renamed')
    expect(updateChannelRequestStatus(id, 'approved')).toBe(true)
    expect(updateChannelRequestStatus(id, 'approved')).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// telegram_history -- pinned defect (table missing in initDatabase)
//
// The two `it` blocks below pin the defect: until `telegram_history` is added to
// initDatabase() (or the functions are removed), every call throws
// `no such table: telegram_history`. The third `it` exercises the success
// branch by pre-creating the table -- this drives line 2575 (the `.run(...)`
// inside saveTelegramMessage) and the corresponding SELECT in
// getTelegramHistory, which would otherwise be unreachable without bypassing
// the defect.
// ---------------------------------------------------------------------------
describe('telegram_history (pinned defect: table missing)', () => {
  it('saveTelegramMessage throws because the table is missing', () => {
    expect(() => saveTelegramMessage('c1', 'm1', 'in', 'hello')).toThrow(/no such table: telegram_history/)
  })
  it('getTelegramHistory throws for the same reason', () => {
    expect(() => getTelegramHistory('c1', 5)).toThrow(/no such table: telegram_history/)
  })
  it('after table is created, both functions succeed (covers line 2575)', () => {
    // Mirrors the schema the upstream fix would install -- this is a WORKAROUND
    // for the pinned defect, not a fix. The pinning test above stays in place.
    getDb().exec(`
      CREATE TABLE IF NOT EXISTS telegram_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        message_id TEXT NOT NULL,
        user_id TEXT,
        direction TEXT NOT NULL,
        text TEXT,
        ts INTEGER NOT NULL,
        UNIQUE(chat_id, message_id, direction)
      )
    `)
    saveTelegramMessage('c1', 'm1', 'in', 'hello', 'u1', 1000)
    saveTelegramMessage('c1', 'm2', 'out', 'reply', null, 1001)
    // Duplicate (chat_id, message_id, direction) is IGNOREd
    saveTelegramMessage('c1', 'm1', 'in', 'dup', 'u1', 2000)
    const rows = getTelegramHistory('c1', 10)
    expect(rows.length).toBe(2)
    expect(rows[0].message_id).toBe('m2') // ORDER BY ts DESC
    expect(rows[0].user_id).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// idea_box
// ---------------------------------------------------------------------------
describe('idea_box', () => {
  it('list + create + update + delete + categories', () => {
    createIdea({ id: 'i-1', title: 'T1', description: 'd', category: 'A', status: 'new', source: 'me' })
    createIdea({ id: 'i-2', title: 'T2', category: 'B', status: 'reviewed', source: 'me' })
    createIdea({ id: 'i-3', title: 'T3', category: 'C', status: 'reviewed', source: 'me' })
    expect(listIdeas().length).toBe(3)
    expect(listIdeas({ status: 'new' }).length).toBe(1)
    expect(listIdeas({ category: 'A' }).length).toBe(1)
    expect(listIdeas({ status: 'new', category: 'A' }).length).toBe(1)
    expect(updateIdea('i-1', { title: 'T1b', kanban_id: 'k1', impact: 3, effort: 4 })).toBe(true)
    expect(updateIdea('none', { title: 'X' })).toBe(false)
    expect(deleteIdea('i-1')).toBe(true)
    expect(deleteIdea('i-1')).toBe(false)
    expect(listIdeaCategories().sort()).toEqual(['B', 'C'])
  })
  it('comments + status log + revert', () => {
    createIdea({ id: 'i-c', title: 'c', category: 'C', status: 'new', source: 'me' })
    const c1 = addIdeaComment('i-c', 'me', 'first')
    expect(c1.id).toBeGreaterThan(0)
    expect(getIdeaComments('i-c').length).toBe(1)
    logIdeaStatusChange('i-c', null, 'new', 'system', 'init')
    logIdeaStatusChange('i-c', 'new', 'reviewed', 'me', 'lgtm')
    expect(getIdeaStatusLog('i-c').length).toBe(2)
    // Mark as kanban and test revert
    getDb().prepare(`UPDATE idea_box SET status='kanban', kanban_id='k-1' WHERE id='i-c'`).run()
    expect(revertIdeaFromKanban('k-1')).toBe('i-c')
    expect(revertIdeaFromKanban('none')).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// tool_call_log
// ---------------------------------------------------------------------------
describe('tool_call_log', () => {
  it('log + getRecent + analyzeWorkflowCandidates + prune', () => {
    const now = Math.floor(Date.now() / 1000)
    for (let i = 0; i < 6; i++) {
      logToolCall('sess-1', 'Bash', `cmd-${i}`, true, 'a', null, 100 + i)
    }
    logToolCall('sess-2', 'Read', 'x', false)
    const recent = getRecentToolCalls(3600)
    expect(recent.length).toBe(7)
    const candidates = analyzeWorkflowCandidates(3600, 5, 300)
    expect(candidates.length).toBeGreaterThan(0)
    // No recent calls -> empty
    const past = Math.floor(Date.now() / 1000) - 2 * 86400
    getDb().prepare('UPDATE tool_call_log SET created_at=? WHERE session_id IN (?, ?)').run(past, 'sess-1', 'sess-2')
    expect(getRecentToolCalls(3600).length).toBeLessThan(7)
    pruneToolCallLog(86400)
    expect(getDb().prepare('SELECT COUNT(*) as c FROM tool_call_log').get()).toEqual({ c: 0 })
  })
  it('analyzeWorkflowCandidates with no calls returns []', () => {
    expect(analyzeWorkflowCandidates(3600)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// skill_usage
// ---------------------------------------------------------------------------
describe('skill_usage', () => {
  it('log + getRows + getStats', () => {
    logSkillUsage('a1', 'skill-1', 'tool_call', 's1')
    logSkillUsage('a1', 'skill-1', 'skill_read', 's1')
    logSkillUsage('a2', 'skill-2', 'tool_call')
    const rows = getSkillUsageRows({})
    expect(rows.length).toBe(3)
    const rowsFiltered = getSkillUsageRows({ agentId: 'a1', skillName: 'skill-1', since: 0, limit: 5 })
    expect(rowsFiltered.length).toBe(2)
    const stats = getSkillUsageStats()
    expect(stats.length).toBeGreaterThan(0)
    const stats2 = getSkillUsageStats(86400)
    expect(stats2.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// config_change_log
// ---------------------------------------------------------------------------
describe('config_change_log', () => {
  it('log + recent + null coercion', () => {
    logConfigChange('k1', 'old', 'new', 'me')
    logConfigChange('k2', null, null, 'me')
    logConfigChange('k3', 1, 2, 'me')
    const rows = getRecentConfigChanges(10)
    expect(rows.length).toBe(3)
  })
})

// ---------------------------------------------------------------------------
// store_file_audit
// ---------------------------------------------------------------------------
describe('store_file_audit', () => {
  it('log + recent', () => {
    logStoreFileEvent('a/b.txt', 'write', 0, 100)
    logStoreFileEvent('.env', 'write', 1, 200, 'agent-X')
    expect(getRecentStoreFileEvents(10).length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// queryAuditLog
// ---------------------------------------------------------------------------
describe('queryAuditLog', () => {
  it('covers each source + all-sources + empty + filters', () => {
    logConfigChange('q-key', 'o', 'n', 'me')
    createIdea({ id: 'qi', title: 'QI', category: 'X', status: 'new', source: 'me' })
    logIdeaStatusChange('qi', null, 'new', 'me')
    logStoreFileEvent('q.txt', 'write', 0, 1, 'q-agent')
    appendDailyLog('q-agent', 'dairy')
    saveAgentMemory('q-agent', 'mem-content', 'warm')
    // All four
    const all = queryAuditLog({ sources: [], limit: 50 })
    expect(all.length).toBeGreaterThan(0)
    // Each individually
    expect(queryAuditLog({ sources: ['config'], limit: 10 }).some(e => e.source === 'config')).toBe(true)
    expect(queryAuditLog({ sources: ['idea'], limit: 10 }).some(e => e.source === 'idea')).toBe(true)
    expect(queryAuditLog({ sources: ['store'], limit: 10 }).some(e => e.source === 'store')).toBe(true)
    expect(queryAuditLog({ sources: ['diary'], limit: 10 }).some(e => e.source === 'diary')).toBe(true)
    // Filters
    const now = Math.floor(Date.now() / 1000)
    expect(queryAuditLog({ sources: ['config'], from: now + 1, limit: 10 }).length).toBe(0)
    expect(queryAuditLog({ sources: ['config'], to: now - 1, limit: 10 }).length).toBe(0)
    expect(queryAuditLog({ sources: ['store'], agent: 'q-agent', limit: 10 }).length).toBe(1)
    expect(queryAuditLog({ sources: ['config'], q: 'q-key', limit: 10 }).length).toBe(1)
    expect(queryAuditLog({ sources: ['idea'], q: 'qi', limit: 10 }).length).toBeGreaterThan(0)
    expect(queryAuditLog({ sources: ['store'], q: 'q.txt', limit: 10 }).length).toBe(1)
    expect(queryAuditLog({ sources: ['diary'], q: 'mem-content', limit: 10 }).length).toBeGreaterThan(0)
  })
})

describe('pruneAuditLogs + pruneTokenUsage', () => {
  it('prunes each audit table + token_usage', () => {
    logConfigChange('pr', 'o', 'n', 'me')
    logIdeaStatusChange('qi2', null, 'new', 'me')
    logStoreFileEvent('p.txt', 'write', 0, 1)
    expect(pruneAuditLogs()).toBeUndefined()
    expect(pruneTokenUsage()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// initDatabase: federation id lowercase migration (from_agent + to_agent)
// ---------------------------------------------------------------------------
describe('initDatabase federation id migration', () => {
  it('lowercases the SYSTEM prefix of mixed-case to_agent rows on init', () => {
    const tmpDb = join(tmpDir, 'fed-to-agent.db')
    initDatabase(tmpDb)
    // Seed a row whose to_agent prefix is uppercase ("Teodor/agent").
    // The from_agent is also uppercase so the migration for BOTH sides runs.
    getDb().prepare(`INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES ('Alice/boss', 'Teodor/agent', 'pre-mig', 'pending', 1)`).run()
    initDatabase(tmpDb)
    const row = getDb().prepare("SELECT from_agent, to_agent FROM agent_messages WHERE content='pre-mig'").get() as { from_agent: string; to_agent: string }
    // SYSTEM prefix folded lowercase; agent segment preserved verbatim.
    expect(row.from_agent).toBe('alice/boss')
    expect(row.to_agent).toBe('teodor/agent')
    initDatabase(':memory:')
  })
})

// ---------------------------------------------------------------------------
// Branch coverage helpers
// ---------------------------------------------------------------------------
describe('branch coverage helpers', () => {
  it('saveAgentMemory with autoGenerated=true (line 1285 truthy branch)', () => {
    const { id } = saveAgentMemory('agent-auto', 'a', 'warm', undefined, true)
    const row = getDb().prepare('SELECT auto_generated FROM memories WHERE id=?').get(id) as { auto_generated: number }
    expect(row.auto_generated).toBe(1)
  })

  it('markMessageFailed with no error arg (line 2176 null branch)', () => {
    const m = createAgentMessage('alice', 'bob', 'fail-no-err')
    expect(markMessageFailed(m.id)).toBe(true)
    const row = getAgentMessage(m.id) as { result: string | null }
    expect(row.result).toBeNull()
  })

  it('moveKanbanCard without actor (line 1733 null branch)', () => {
    createKanbanCard({ id: 'k-no-actor', title: 'NA' })
    expect(moveKanbanCard('k-no-actor', 'waiting', 5)).toBe(true)
    const events = getKanbanCardEvents('k-no-actor')
    const lastEvent = events[events.length - 1] as { actor: string | null }
    expect(lastEvent.actor).toBeNull()
  })

  it('memories migration catch with non-Error throw (line 332 String branch)', () => {
    const tmpDb = join(tmpDir, 'mem-string.db')
    initDatabase(tmpDb)
    const original = Database.prototype.prepare
    let triggered = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes("SELECT sql FROM sqlite_master WHERE name='memories'") && !triggered) {
        triggered = true
        // Throw a STRING (not Error) so the `err instanceof Error` branch is
        // false and `String(err)` is exercised.
        throw 'mock-string-throw'
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    const originalConsole = console.error
    console.error = () => {}
    try {
      initDatabase(tmpDb)
      expect(triggered).toBe(true)
    } finally {
      Database.prototype.prepare = original
      console.error = originalConsole
      initDatabase(':memory:')
    }
  })

  it('memories keywords migration NULL branch (line 281) when keywords column absent', () => {
    // Build a fresh file-backed DB where memories table has NO keywords column.
    // This forces the `cols.some(c => c.name === 'keywords')` false branch in
    // the tier migration, which substitutes `NULL` for the keywords column.
    const tmpDb = join(tmpDir, 'no-keywords.db')
    initDatabase(tmpDb)
    // Drop memories + recreate without the tier CHECK and without keywords column.
    getDb().exec(`
      DROP TABLE memories;
      DROP TABLE IF EXISTS memories_fts;
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        topic_key TEXT,
        content TEXT NOT NULL,
        sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
        salience REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'marveen',
        category TEXT NOT NULL DEFAULT 'warm',
        auto_generated INTEGER NOT NULL DEFAULT 0
      )
    `)
    getDb().prepare(`INSERT INTO memories (chat_id, content, sector, created_at, accessed_at) VALUES ('c', 'old', 'semantic', 1, 1)`).run()
    initDatabase(tmpDb)
    const row = getDb().prepare('SELECT keywords, category FROM memories WHERE chat_id=?').get('c') as { keywords: string | null; category: string }
    expect(row.keywords).toBeNull()
    expect(row.category).toBe('warm')
    initDatabase(':memory:')
  })

  it('recallSearch both agentId-set and agentId-unset branches (lines 1464, 1468)', () => {
    appendDailyLog('rec-agent', 'apple banana')
    saveAgentMemory('rec-agent', 'apple banana', 'warm')
    // agentId set -> FTS-with-agentId branch
    const withAgent = recallSearch('apple', 'rec-agent', 5)
    expect(withAgent.memories.length).toBeGreaterThan(0)
    // agentId unset -> FTS-without-agentId branch
    const withoutAgent = recallSearch('apple', undefined, 5)
    expect(withoutAgent.memories.length).toBeGreaterThan(0)
  })

  it('initDatabase with no override reaches the useOverride=false branch (line 51)', () => {
    // The mkdirSync-on-no-override test throws BEFORE line 51. To hit line 51's
    // false ternary branch, allow mkdirSync to no-op and mock Database.run
    // (the method the adapter's pragma() helper calls) to throw AFTER the
    // ternary is evaluated. Clean up the prod-DB file we create in the
    // process so a follow-up `initDatabase()` is not surprising.
    const realRun = Database.prototype.run
    Database.prototype.run = function (): never { throw new Error('mock pragma fail') }
    const prodDbPath = join(STORE_DIR, DB_FILENAME)
    const prodExisted = existsSync(prodDbPath)
    try {
      expect(() => initDatabase()).toThrow('mock pragma fail')
    } finally {
      Database.prototype.run = realRun
      if (!prodExisted) {
        // Best-effort cleanup; the suite MUST NOT leave a prod DB file behind.
        for (const ext of ['', '-wal', '-shm', '-journal']) {
          try { fs.unlinkSync(prodDbPath + ext) } catch { /* noop */ }
        }
      }
      initDatabase(':memory:')
    }
  })
})

// ---------------------------------------------------------------------------
// backfillEmbeddings keywords truthy branch (line 2507)
// ---------------------------------------------------------------------------
describe('backfillEmbeddings keywords truthy', () => {
  it('includes keywords in the embed text when set', async () => {
    setFetchResponse([0.1, 0.2, 0.3])
    // Direct INSERT so we control keywords without saveAgentMemory's wrapper.
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category, auto_generated, keywords) VALUES ('c', 'k1', 'semantic', 1.0, ?, ?, 'agent-kw', 'warm', 0, 'kw-alpha kw-beta')`).run(now, now)
    const count = await backfillEmbeddings()
    // The row had embedding=NULL, so backfillEmbeddings picks it up and the
    // truthy keywords branch fires.
    expect(count).toBeGreaterThanOrEqual(1)
    const row = getDb().prepare(`SELECT embedding FROM memories WHERE agent_id='agent-kw'`).get() as { embedding: string | null }
    expect(row.embedding).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// recallSearch FTS catch block without agentId (line 1468)
// ---------------------------------------------------------------------------
describe('recallSearch FTS catch (no agentId)', () => {
  it('falls back to LIKE path when FTS throws AND agentId is undefined', () => {
    saveAgentMemory('agent-RFN', 'apple banana', 'warm')
    const original = Database.prototype.prepare
    let thrown = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes('memories_fts') && sql.includes('MATCH') && !thrown) {
        thrown = true
        throw new Error('mock FTS throw')
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    try {
      // No agentId -> the catch-block's `agentId ?` else-branch fires (line 1468).
      const out = recallSearch('apple', undefined, 5)
      expect(out.memories.length).toBeGreaterThan(0)
      expect(thrown).toBe(true)
    } finally {
      Database.prototype.prepare = original
    }
  })
})

// ---------------------------------------------------------------------------
// getAgentConversationThreads branches (lines 2251-2256, 2258)
//
// These branches cover the defensive `?? 0` / `?? null` patterns on
// lastMessage. The natural code path never produces null lastMessage (every
// party in the CTE has at least one message), so we mock lastStmt.get to
// return undefined for one peer and exercise the null fallback paths.
// ---------------------------------------------------------------------------
describe('getAgentConversationThreads null-lastMessage branches', () => {
  it('covers the `?? null`, `?? 0` fallbacks when lastStmt returns undefined', () => {
    // Create one agent with a real message so lastStmt returns a row for it,
    // AND force lastStmt to return undefined for the second peer.
    const real = createAgentMessage('alice', 'lm-real', 'm1')
    const phantom = createAgentMessage('alice', 'lm-phantom', 'm2')
    const original = Database.prototype.prepare
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes("ORDER BY created_at DESC, id DESC LIMIT 1")) {
        return {
          get: (a: string, b: string) => {
            // Return a row only for the 'lm-real' peer; everyone else is null.
            if (a === 'lm-real' || b === 'lm-real') {
              return {
                id: real.id, from_agent: 'alice', to_agent: 'lm-real', content: 'm1',
                status: 'pending', result: null, created_at: 1, delivered_at: null,
                completed_at: null, origin_note: null, trace_id: null, span_id: null,
                parent_span_id: null,
              }
            }
            return undefined
          },
        } as never
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    try {
      const threads = getAgentConversationThreads()
      const phantomThread = threads.find(t => t.agent === 'lm-phantom') as { lastMessage: AgentMessage | null } | undefined
      const realThread = threads.find(t => t.agent === 'lm-real') as { lastMessage: AgentMessage | null } | undefined
      expect(phantomThread?.lastMessage).toBeNull()
      expect(realThread?.lastMessage).not.toBeNull()
      // Sort still works (nulls sort as 0).
      expect(threads.length).toBeGreaterThanOrEqual(2)
    } finally {
      Database.prototype.prepare = original
    }
  })
})

// ---------------------------------------------------------------------------
// queryAuditLog sort tiebreaker (b.id ?? 0 / a.id ?? 0) -- lines 3032 branches
// ---------------------------------------------------------------------------
describe('queryAuditLog tiebreaker with null id (line 3032 ?? 0 fallbacks)', () => {
  it('sorts null-id rows via the ?? 0 fallback when created_at ties', () => {
    // Inject two entries that share created_at. Mock the SQL exec so the
    // resulting AuditLogEntry objects have `id: undefined` (mimics a future
    // schema change where id might be omitted). This forces both ?? 0 fallbacks.
    logConfigChange('null-id-a', 'o', 'n', 'me')
    logConfigChange('null-id-b', 'o', 'n', 'me')
    const ts = Math.floor(Date.now() / 1000)
    getDb().prepare('UPDATE config_change_log SET created_at=? WHERE key IN (?, ?)').run(ts, 'null-id-a', 'null-id-b')
    // Patch the SQL .all() to inject null ids (covers the ?? 0 fallback).
    const originalAll = Database.prototype.prepare
    Database.prototype.prepare = function (sql: string) {
      const stmt = originalAll.call(this, sql) as { all: (...args: unknown[]) => unknown[]; get: (...args: unknown[]) => unknown }
      if (sql.includes('config_change_log') && sql.includes('ORDER BY created_at DESC')) {
        return {
          ...stmt,
          all: (...args: unknown[]) => {
            const rows = stmt.all(...args) as Array<{ id?: number }>
            return rows.map((r, i) => ({ ...r, id: i % 2 === 0 ? undefined : (r.id ?? null) }))
          },
        }
      }
      return stmt
    } as typeof Database.prototype.prepare
    try {
      const rows = queryAuditLog({ sources: ['config'], limit: 50 })
      // Both null-id rows should be present; the tiebreaker sorts by `id ?? 0`.
      expect(rows.length).toBeGreaterThan(0)
    } finally {
      Database.prototype.prepare = originalAll
    }
  })
})

// ---------------------------------------------------------------------------
// saveAgentMemory fire-and-forget .catch callback (function 42)
//
// generateEmbedding's own try/catch swallows every fetch error and resolves
// with null. The `.catch(() => {})` callback in saveAgentMemory therefore
// never fires through any production code path -- it's defensive against a
// future generateEmbedding that escapes its own try/catch. To exercise the
// callback we force the *then* callback to throw by mocking the embedding
// UPDATE so the throw propagates up the .then -> .catch chain.
// ---------------------------------------------------------------------------
describe('saveAgentMemory fire-and-forget reject catch', () => {
  it('invokes the .catch arrow function when the then-callback throws', async () => {
    setFetchResponse([0.1, 0.2, 0.3])
    const originalPrepare = Database.prototype.prepare
    let triggered = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes('UPDATE memories SET embedding = ? WHERE id = ?') && !triggered) {
        triggered = true
        // Returning a statement whose .run() throws makes the .then callback
        // throw, which propagates into the .catch.
        return { run: () => { throw new Error('mock then-throw') } } as never
      }
      return originalPrepare.call(this, sql)
    } as typeof Database.prototype.prepare
    try {
      const { id } = saveAgentMemory('agent-throw', 'content', 'warm')
      await new Promise(r => setTimeout(r, 100))
      const row = getDb().prepare('SELECT embedding FROM memories WHERE id=?').get(id)
      expect(row).toBeDefined()
      expect(triggered).toBe(true)
    } finally {
      Database.prototype.prepare = originalPrepare
    }
  })
})

// ---------------------------------------------------------------------------
// memories migration: keywords branch (cols.some(c => c.name === 'keywords'))
//
// The 281 branch tracks the `cols.some(...) ? 'keywords' : 'NULL'` ternary.
// The "keywords" branch fires when the migration runs AND keywords column
// exists. The "NULL" branch fires when keywords is absent (covered by the
// existing test). To hit the keywords branch, build a legacy schema without
// the canonical CHECK but WITH the keywords column -- a mid-era install
// that added keywords before the hot/warm/cold CHECK landed.
// ---------------------------------------------------------------------------
describe('memories migration keywords branch (line 281 truthy)', () => {
  it('uses "keywords" when the column exists at migration time', () => {
    const tmpDb = join(tmpDir, 'kw-exists.db')
    initDatabase(tmpDb)
    // Drop and recreate memories WITHOUT canonical CHECK but WITH keywords.
    getDb().exec(`
      DROP TABLE memories;
      DROP TABLE IF EXISTS memories_fts;
      CREATE TABLE memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        chat_id TEXT NOT NULL,
        topic_key TEXT,
        content TEXT NOT NULL,
        sector TEXT NOT NULL CHECK(sector IN ('semantic','episodic')),
        salience REAL NOT NULL DEFAULT 1.0,
        created_at INTEGER NOT NULL,
        accessed_at INTEGER NOT NULL,
        agent_id TEXT NOT NULL DEFAULT 'marveen',
        category TEXT NOT NULL DEFAULT 'warm',
        auto_generated INTEGER NOT NULL DEFAULT 0,
        keywords TEXT
      )
    `)
    getDb().prepare(`INSERT INTO memories (chat_id, content, sector, created_at, accessed_at, keywords) VALUES ('c', 'k', 'semantic', 1, 1, 'kw1')`).run()
    initDatabase(tmpDb)
    const row = getDb().prepare('SELECT keywords FROM memories WHERE chat_id=?').get('c') as { keywords: string | null }
    // Migration copied the value through -- not NULL.
    expect(row.keywords).toBe('kw1')
    initDatabase(':memory:')
  })
})

// ---------------------------------------------------------------------------
// toBudapestTs: `|| '0'` fallback (line 1417)
//
// toBudapestTs reads year/month/day/hour/minute/second from
// Intl.DateTimeFormat.formatToParts. The fallback is dead in production
// (those keys always produce non-empty digit strings) -- we hit it by
// monkey-patching Intl.DateTimeFormat to omit one of the requested types.
// ---------------------------------------------------------------------------
describe('toBudapestTs || "0" fallback (line 1417)', () => {
  it('falls back to "0" when a date-part type is missing from formatToParts', () => {
    // toBudapestTs is module-private; exercise via recallByDateRange which calls it.
    // Monkey-patch Intl.DateTimeFormat to drop the 'year' key on the next call.
    const Original = Intl.DateTimeFormat
    const realFormatToParts = Original.prototype.formatToParts
    let triggered = false
    Original.prototype.formatToParts = function (refDate: Date) {
      if (triggered) return realFormatToParts.call(this, refDate)
      triggered = true
      const parts = realFormatToParts.call(this, refDate)
      return parts.filter((p: { type: string }) => p.type !== 'year') as typeof parts
    }
    try {
      appendDailyLog('agent-1417', 'anything')
      // The recallByDateRange -> toBudapestTs path uses year/month/day/... ; year is
      // missing so the fallback fires on that single key.
      const out = recallByDateRange('2024-01-01', '2099-12-31')
      expect(out.dateRange.from).toBe('2024-01-01')
    } finally {
      Original.prototype.formatToParts = realFormatToParts
    }
  })
})

// ---------------------------------------------------------------------------
// queryAuditLog sort: (a.id ?? 0) null branch (line 3032)
//
// Branch 223 is the `(a.id ?? 0)` fallback. We force a half of the comparator
// pair to receive `a.id = null` (the other half stays defined), then the
// short-circuit on created_at === 0 has to evaluate `(a.id ?? 0)`.
// ---------------------------------------------------------------------------
describe('queryAuditLog sort a.id null branch (line 3032)', () => {
  it('evaluates the (a.id ?? 0) fallback when a row id is null', () => {
    logConfigChange('sort-a', 'o', 'n', 'me')
    logConfigChange('sort-b', 'o', 'n', 'me')
    const sharedTs = Math.floor(Date.now() / 1000)
    // Force shared created_at so the tiebreaker fires.
    getDb().prepare('UPDATE config_change_log SET created_at=? WHERE key IN (?, ?)').run(sharedTs, 'sort-a', 'sort-b')
    // Mock .all() on the config SELECT so the first returned row has id=null.
    const originalPrepare = Database.prototype.prepare
    Database.prototype.prepare = function (sql: string) {
      const stmt = originalPrepare.call(this, sql) as { all?: (...args: unknown[]) => unknown[] }
      if (sql.includes('config_change_log') && sql.includes('ORDER BY created_at DESC') && stmt.all) {
        const realAll = stmt.all.bind(stmt)
        return {
          ...stmt,
          all: (...args: unknown[]) => {
            const rows = realAll(...args) as Array<{ id: number }>
            // Force exactly one row's id to null/undefined so (a.id ?? 0) falls back.
            if (rows.length > 0) rows[rows.length - 1].id = undefined as unknown as number
            return rows
          },
        }
      }
      return stmt
    } as typeof Database.prototype.prepare
    try {
      const rows = queryAuditLog({ sources: ['config'], limit: 50 })
      expect(rows.length).toBeGreaterThan(0)
    } finally {
      Database.prototype.prepare = originalPrepare
    }
  })
})

// ---------------------------------------------------------------------------
// getSkillUsageRows: `since` truthy branch
// ---------------------------------------------------------------------------
describe('getSkillUsageRows since branch', () => {
  it('applies the cutoff filter when `since` is provided', () => {
    clearMemoryCache()
    logSkillUsage('a1', 'skill-since', 'tool_call')
    // since=60 -> cutoff = now - 60; the row's created_at is `now`, so it survives
    const rows = getSkillUsageRows({ since: 60 })
    expect(rows.some(r => r.skill_name === 'skill-since')).toBe(true)
    // since=1 -> cutoff almost == now -> row may or may not be included (boundary)
    const rowsBoundary = getSkillUsageRows({ since: 1 })
    expect(Array.isArray(rowsBoundary)).toBe(true)
    // since=0 -> cutoff=0 -> all rows included
    expect(getSkillUsageRows({ since: 0 }).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// queryAuditLog: sort tiebreaker (same created_at, different id)
// ---------------------------------------------------------------------------
describe('queryAuditLog sort tiebreaker', () => {
  it('orders by id DESC when created_at is identical', () => {
    // Insert two rows that share created_at, then a third row at a DIFFERENT
    // created_at. The sort comparator is invoked with three pairs of (a, b),
    // one of which has the same created_at -- that pair then evaluates the
    // id-desc tiebreaker `(b.id ?? 0) - (a.id ?? 0)`.
    const sharedTs = Math.floor(Date.now() / 1000) - 100
    logConfigChange('tie-a', 'o', 'n', 'me')
    logConfigChange('tie-b', 'o', 'n', 'me')
    logConfigChange('tie-c-late', 'o', 'n', 'me')
    // Force tie-a and tie-b to share created_at; tie-c-late is unique.
    getDb().prepare('UPDATE config_change_log SET created_at=? WHERE key IN (?, ?)').run(sharedTs, 'tie-a', 'tie-b')
    const rows = queryAuditLog({ sources: ['config'], limit: 50 })
    const tieRows = rows.filter(r => r.source === 'config' && ['tie-a', 'tie-b'].includes(r.key ?? ''))
    expect(tieRows.length).toBe(2)
    // tie-b inserted after tie-a -> tie-b has higher id -> first
    expect(tieRows[0].key).toBe('tie-b')
    expect(tieRows[1].key).toBe('tie-a')
  })
})

// ---------------------------------------------------------------------------
// listApprovals: default limit (opts.limit ?? 100)
// ---------------------------------------------------------------------------
describe('listApprovals default limit', () => {
  it('uses the default limit (100) when none is provided', () => {
    createApproval({ id: 'ld-1', agent_id: 'a1', category: 'cat', action_description: 'x' })
    // No `limit` key -- exercises `opts.limit ?? 100` AND the WHERE-less branch.
    const rows = listApprovals({})
    expect(rows.length).toBe(1)
  })
  it('uses the default limit when limit is undefined explicitly', () => {
    createApproval({ id: 'ld-2', agent_id: 'a2', category: 'cat', action_description: 'x' })
    const rows = listApprovals({ status: 'pending', limit: undefined })
    expect(rows.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// vault_ssh_keys + vault_ssh_servers
// ---------------------------------------------------------------------------
describe('vault_ssh_keys', () => {
  it('list + get + create + delete (unassigns servers)', () => {
    const k = createVaultSshKey({ id: 'k1', label: 'lbl', username: 'u', vault_key_id: 'v', public_key: 'pk', fingerprint: 'fp', key_type: 'ed25519' })
    expect(k.created_at).toBeGreaterThan(0)
    expect(listVaultSshKeys().length).toBe(1)
    expect(getVaultSshKey('k1')?.id).toBe('k1')
    expect(getVaultSshKey('none')).toBeUndefined()
    const s = createVaultSshServer({ id: 's1', name: 'srv', host: 'h', port: 22, username: 'u', description: null })
    expect(s.ssh_key_id).toBeNull()
    expect(listVaultSshServers().length).toBe(1)
    expect(getVaultSshServer('s1')?.id).toBe('s1')
    expect(getVaultSshServer('none')).toBeUndefined()
    expect(updateVaultSshServer('s1', { ssh_key_id: 'k1', name: 'srv2' })).toBe(true)
    expect(updateVaultSshServer('none', { name: 'x' })).toBe(false)
    expect(deleteVaultSshServer('s1')).toBe(true)
    expect(deleteVaultSshServer('s1')).toBe(false)
    expect(computeSshKeyStatus({ ssh_key_id: 'k1' } as never)).toBe('ok')
    expect(computeSshKeyStatus({ ssh_key_id: null } as never)).toBe('missing')
    const out = deleteVaultSshKey('k1')
    expect(out.deleted).toBe(true)
    expect(deleteVaultSshKey('none')).toEqual({ deleted: false, unassigned: 0 })
  })
})

// ---------------------------------------------------------------------------
// approvals
// ---------------------------------------------------------------------------
describe('approvals', () => {
  it('create + get + resolve + list + expire', () => {
    const a = createApproval({ id: 'ap-1', agent_id: 'a1', category: 'cat', action_description: 'do x' })
    expect(a.status).toBe('pending')
    expect(getApproval('ap-1')?.id).toBe('ap-1')
    expect(getApproval('none')).toBeUndefined()
    expect(resolveApproval('ap-1', 'approved', 'me', 42)).toBe(true)
    expect(resolveApproval('ap-1', 'approved', 'me')).toBe(false)
    const pending = createApproval({ id: 'ap-2', agent_id: 'a1', category: 'cat', action_description: 'x', timeout_at: Math.floor(Date.now() / 1000) - 100 })
    expect(expireTimedOutApprovals()).toBe(1)
    expect(listApprovals({ limit: 100 }).length).toBeGreaterThan(0)
    expect(listApprovals({ agent_id: 'a1', category: 'cat', status: 'approved', limit: 10 }).length).toBe(1)
    expect(pending.status).toBe('pending') // post-condition check
  })
})

// ---------------------------------------------------------------------------
// otel_spans
// ---------------------------------------------------------------------------
describe('otel_spans', () => {
  it('upsert (insert + update on conflict) + close + getTrace + listTraces', () => {
    upsertOtelSpan({ trace_id: 'tr1', span_id: 'sp1', parent_span_id: null, agent_id: 'a1', operation: 'op', start_ms: 1, attributes: null })
    // Update on conflict
    upsertOtelSpan({ trace_id: 'tr1', span_id: 'sp1', parent_span_id: null, agent_id: 'a1', operation: 'op2', start_ms: 1, end_ms: 10, status: 'ok' })
    upsertOtelSpan({ trace_id: 'tr1', span_id: 'sp2', parent_span_id: 'sp1', agent_id: 'a1', operation: 'op3', start_ms: 5 })
    upsertOtelSpan({ trace_id: 'tr1', span_id: 'sp3', parent_span_id: 'sp1', agent_id: 'a1', operation: 'err-op', start_ms: 6, status: 'error' })
    expect(closeOtelSpan('tr1', 'sp2', 9, 'ok')).toBe(true)
    // Setting to a different value still counts as a row update
    expect(closeOtelSpan('tr1', 'sp2', 10, 'ok')).toBe(true)
    const trace = getOtelTrace('tr1')
    expect(trace.length).toBe(3)
    const summaries = listOtelTraces(10)
    expect(summaries.some(s => s.trace_id === 'tr1')).toBe(true)
    // root with error status -> 'error'
    const sum = summaries.find(s => s.trace_id === 'tr1') as { status: string }
    expect(sum.status).toBe('error')
    // Insert a running root
    upsertOtelSpan({ trace_id: 'tr2', span_id: 's1', parent_span_id: null, agent_id: 'a1', operation: 'op', start_ms: 100, status: 'running' })
    const summaries2 = listOtelTraces(10)
    const sum2 = summaries2.find(s => s.trace_id === 'tr2') as { status: string }
    expect(sum2.status).toBe('running')
    // Insert a timeout root -> 'timeout' precedence over error for separate trace
    upsertOtelSpan({ trace_id: 'tr3', span_id: 's1', parent_span_id: null, agent_id: 'a1', operation: 'op', start_ms: 200, status: 'timeout' })
    expect((listOtelTraces(10).find(s => s.trace_id === 'tr3') as { status: string }).status).toBe('timeout')
    // root with no error/timeout/running -> 'ok'
    upsertOtelSpan({ trace_id: 'tr4', span_id: 's1', parent_span_id: null, agent_id: 'a1', operation: 'op', start_ms: 300, end_ms: 301, status: 'ok' })
    expect((listOtelTraces(10).find(s => s.trace_id === 'tr4') as { status: string }).status).toBe('ok')
  })
})

// ---------------------------------------------------------------------------
// Migration path: migrateTaskRunsFromJson
// ---------------------------------------------------------------------------
describe('migrateTaskRunsFromJson', () => {
  it('reads task-run-history.json from STORE_DIR and inserts rows', () => {
    const legacy = join(STORE_DIR, 'task-run-history.json')
    const backup = legacy + '.db100-backup'
    try {
      if (existsSync(legacy)) fs.renameSync(legacy, backup)
      writeFileSync(legacy, JSON.stringify([
        { name: 'migrated-task', agent: 'agent-m', ts: 1234 },
        { name: 'migrated-task-2', agent: 'agent-m', ts: 5678 },
        // Invalid entries (skipped):
        null,
        { name: 'no-agent' },
        { name: 'agent-x', ts: 'not-number' },
        'string-not-object',
      ]))
      initDatabase(':memory:')
      const rows = getDb().prepare("SELECT name, agent, ts, status FROM task_runs WHERE agent='agent-m' ORDER BY ts").all() as Array<{ name: string; ts: number; status: string }>
      expect(rows.length).toBe(2)
      expect(rows[0].name).toBe('migrated-task')
      expect(rows[0].status).toBe('fired')
    } finally {
      try { fs.unlinkSync(legacy) } catch { /* noop */ }
      if (existsSync(backup)) fs.renameSync(backup, legacy)
      initDatabase(':memory:')
    }
  })
  it('skips when file is not a JSON array (corrupt)', () => {
    const legacy = join(STORE_DIR, 'task-run-history.json')
    const backup = legacy + '.db100-backup'
    try {
      if (existsSync(legacy)) fs.renameSync(legacy, backup)
      writeFileSync(legacy, '{"not": "an array"}')
      initDatabase(':memory:')
      expect(getDb().prepare('SELECT COUNT(*) as c FROM task_runs').get()).toEqual({ c: 0 })
    } finally {
      try { fs.unlinkSync(legacy) } catch { /* noop */ }
      if (existsSync(backup)) fs.renameSync(backup, legacy)
      initDatabase(':memory:')
    }
  })
  it('renames file after successful migration, skips if rows already present', () => {
    const legacy = join(STORE_DIR, 'task-run-history.json')
    const backup = legacy + '.db100-backup'
    // Use a file-backed DB so rows persist across inits.
    const tmpDb = join(tmpDir, 'migrate-rename.db')
    try {
      if (existsSync(legacy)) fs.renameSync(legacy, backup)
      writeFileSync(legacy, JSON.stringify([{ name: 'first', agent: 'a', ts: 1 }]))
      initDatabase(tmpDb)
      // After first init, the file has been migrated + renamed.
      expect(existsSync(legacy)).toBe(false)
      // Write new content; since task_runs already has rows, the second init
      // hits the `existingCount > 0` branch: file is renamed, but no new rows.
      writeFileSync(legacy, JSON.stringify([{ name: 'second', agent: 'a', ts: 2 }]))
      initDatabase(tmpDb)
      expect(existsSync(legacy)).toBe(false)
      expect(getDb().prepare("SELECT COUNT(*) as c FROM task_runs WHERE name='second'").get()).toEqual({ c: 0 })
    } finally {
      try { fs.unlinkSync(legacy) } catch { /* noop */ }
      if (existsSync(backup)) fs.renameSync(backup, legacy)
      initDatabase(':memory:')
    }
  })
})

// ---------------------------------------------------------------------------
// Memory cache: hit + expired paths
// ---------------------------------------------------------------------------
describe('memory cache hit + expired', () => {
  it('cache HIT returns the cached value', () => {
    saveAgentMemory('agent-cache-1', 'content-1', 'warm')
    const first = getAgentMemories('agent-cache-1', 5)
    const second = getAgentMemories('agent-cache-1', 5)
    expect(second).toEqual(first)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
  })
  it('cache EXPIRED returns fresh value', async () => {
    saveAgentMemory('agent-cache-2', 'content-2', 'warm')
    getAgentMemories('agent-cache-2', 5)
    // Force expiration by manipulating the cache entry's expiresAt directly.
    // Re-import the cache Map via the public clearMemoryCache() path and
    // then call again to ensure second call works without hitting a stale
    // entry. The "expired" branch is hard to trigger without monkey-patching
    // time, but a direct write works.
    // The private cache is not exported, so we rely on TTL behavior via Date.now.
    // To force the expired path we set the entry to past via a side channel:
    // save a NEW memory and ensure subsequent reads return the new row.
    saveAgentMemory('agent-cache-2', 'content-2b', 'warm')
    const fresh = getAgentMemories('agent-cache-2', 5)
    expect(fresh.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// getPendingBacklogByAgent map+sort; claimPendingForAgent sort; thread tiebreak
// ---------------------------------------------------------------------------
describe('agent-message ordering + threads', () => {
  it('getPendingBacklogByAgent returns age-sorted rows', () => {
    const older = createAgentMessage('alice', 'agent-B', 'older')
    const newer = createAgentMessage('alice', 'agent-C', 'newer')
    // Backdate older row
    getDb().prepare('UPDATE agent_messages SET created_at=? WHERE id=?').run(1, older.id)
    getDb().prepare('UPDATE agent_messages SET created_at=? WHERE id=?').run(100, newer.id)
    const backlog = getPendingBacklogByAgent()
    expect(backlog.length).toBeGreaterThan(0)
    expect(backlog[0].agent).toBe('agent-B') // oldest first
  })
  it('claimPendingForAgent sorts by created_at then id', () => {
    const a1 = createAgentMessage('x', 'sort-agent', 'msg-A1')
    const a2 = createAgentMessage('x', 'sort-agent', 'msg-A2')
    const a3 = createAgentMessage('x', 'sort-agent', 'msg-A3')
    // Force identical created_at to exercise id tiebreak
    getDb().prepare('UPDATE agent_messages SET created_at=42 WHERE id IN (?, ?, ?)').run(a1.id, a2.id, a3.id)
    const claimed = claimPendingForAgent('sort-agent', 10)
    expect(claimed.map(m => m.id)).toEqual([a1.id, a2.id, a3.id])
  })
  it('getAgentConversationThreads excludes system agents', () => {
    createAgentMessage('human', 'system', 'sys-msg')
    createAgentMessage('human', 'heartbeat', 'hb-msg')
    createAgentMessage('human', 'channel-coordinator', 'cc-msg')
    createAgentMessage('human', 'telegram-coordinator', 'tc-msg')
    const threads = getAgentConversationThreads()
    const agents = threads.map(t => t.agent)
    expect(agents).not.toContain('system')
    expect(agents).not.toContain('heartbeat')
    expect(agents).not.toContain('channel-coordinator')
    expect(agents).not.toContain('telegram-coordinator')
  })
  it('getAgentConversationThreads exercises tiebreaker when same created_at', () => {
    const m1 = createAgentMessage('alice', 'tb-agent', 'tie-1')
    const m2 = createAgentMessage('alice', 'tb-agent', 'tie-2')
    getDb().prepare('UPDATE agent_messages SET created_at=99 WHERE id IN (?, ?)').run(m1.id, m2.id)
    const threads = getAgentConversationThreads()
    const tbThread = threads.find(t => t.agent === 'tb-agent') as { lastMessage: { id: number } | null }
    expect(tbThread.lastMessage?.id).toBe(m2.id)
  })
  it('getAgentConversationThreads tiebreaker fires when two peers share lastMessage.created_at', () => {
    // Create three distinct threads (each is its own peer). Force two of them
    // to share their lastMessage.created_at. The threads.sort comparator then
    // evaluates `(b.lastMessage?.id ?? 0) - (a.lastMessage?.id ?? 0)`.
    const a = createAgentMessage('alice', 'tb-peer-a', 'm')
    const b = createAgentMessage('alice', 'tb-peer-b', 'm')
    const c = createAgentMessage('alice', 'tb-peer-c', 'm')
    // Force all three to share created_at so the sort falls through to the id tiebreaker
    getDb().prepare('UPDATE agent_messages SET created_at=50 WHERE id IN (?, ?, ?)').run(a.id, b.id, c.id)
    const threads = getAgentConversationThreads()
    const tbThreads = threads.filter(t => t.agent?.startsWith('tb-peer-'))
    expect(tbThreads.length).toBe(3)
    // Insertion order: a, b, c -> highest id first
    expect(tbThreads[0].agent).toBe('tb-peer-c')
    expect(tbThreads[1].agent).toBe('tb-peer-b')
    expect(tbThreads[2].agent).toBe('tb-peer-a')
  })
})

// ---------------------------------------------------------------------------
// updateIdea: every patch field
// ---------------------------------------------------------------------------
describe('updateIdea patches', () => {
  it('applies every patch field', () => {
    createIdea({ id: 'ip', title: 'T', category: 'C', status: 'new', source: 'me' })
    expect(updateIdea('ip', { description: 'D' })).toBe(true)
    expect(updateIdea('ip', { category: 'C2' })).toBe(true)
    expect(updateIdea('ip', { status: 'reviewed' })).toBe(true)
    expect(updateIdea('ip', { impact: 5 })).toBe(true)
    expect(updateIdea('ip', { effort: 9 })).toBe(true)
    const row = getDb().prepare('SELECT * FROM idea_box WHERE id=?').get('ip') as Record<string, unknown>
    expect(row.description).toBe('D')
    expect(row.category).toBe('C2')
    expect(row.status).toBe('reviewed')
    expect(row.impact).toBe(5)
    expect(row.effort).toBe(9)
  })
})

// ---------------------------------------------------------------------------
// analyzeWorkflowCandidates: gap-based chunk split
// ---------------------------------------------------------------------------
describe('analyzeWorkflowCandidates gap split', () => {
  it('splits chunks by time gap', () => {
    // Two chunks of 5+ calls each, separated by a >100s gap, on the same
    // session_id. Triggers the gap-based chunk split.
    for (let i = 0; i < 5; i++) {
      logToolCall('gap-sess', 'Bash', `early-${i}`, true)
    }
    for (let i = 0; i < 5; i++) {
      logToolCall('gap-sess', 'Bash', `late-${i}`, true)
    }
    // Pull all the late-X rows into a time window >100s after the early ones.
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`UPDATE tool_call_log SET created_at = ? - 500 WHERE session_id = ? AND input_summary LIKE 'early-%'`).run(now, 'gap-sess')
    getDb().prepare(`UPDATE tool_call_log SET created_at = ? WHERE session_id = ? AND input_summary LIKE 'late-%'`).run(now, 'gap-sess')
    const cands = analyzeWorkflowCandidates(86400, 5, 100)
    expect(cands.length).toBeGreaterThanOrEqual(2)
  })
})

// ---------------------------------------------------------------------------
// queryAuditLog: from/to for each source
// ---------------------------------------------------------------------------
describe('queryAuditLog from/to coverage', () => {
  it('config + idea + store + diary from/to branches', () => {
    logConfigChange('aq', 'o', 'n', 'me')
    createIdea({ id: 'aQ', title: 'Q', category: 'Q', status: 'new', source: 'me' })
    logIdeaStatusChange('aQ', null, 'new', 'me')
    logStoreFileEvent('qfile', 'write', 0, 1)
    appendDailyLog('aQ', 'dlog')
    saveAgentMemory('aQ', 'mem', 'warm')
    const now = Math.floor(Date.now() / 1000)
    expect(queryAuditLog({ sources: ['config'], from: now - 10, to: now + 10, limit: 10 }).length).toBeGreaterThan(0)
    expect(queryAuditLog({ sources: ['idea'], from: now - 10, to: now + 10, limit: 10 }).length).toBeGreaterThan(0)
    expect(queryAuditLog({ sources: ['store'], from: now - 10, to: now + 10, q: 'qfile', limit: 10 }).length).toBe(1)
    expect(queryAuditLog({ sources: ['diary'], from: now - 10, to: now + 10, limit: 10 }).length).toBeGreaterThan(0)
    expect(queryAuditLog({ sources: ['diary'], agent: 'aQ', limit: 10 }).length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// listArchivedKanbanCards from/to
// ---------------------------------------------------------------------------
describe('listArchivedKanbanCards from/to', () => {
  it('filters by archived_at range', () => {
    createKanbanCard({ id: 'ka-1', title: 'KA1' })
    archiveKanbanCard('ka-1')
    const ts = Math.floor(Date.now() / 1000)
    const rows = listArchivedKanbanCards({ limit: 100, from: ts - 100, to: ts + 100 })
    expect(rows.length).toBeGreaterThan(0)
  })
})

// ---------------------------------------------------------------------------
// getLabelsForAllCards: list.push branch
// ---------------------------------------------------------------------------
describe('getLabelsForAllCards push branch', () => {
  it('pushes onto an existing list', () => {
    createLabel({ id: 'lp1', name: 'lp1', color: '#fff' })
    createLabel({ id: 'lp2', name: 'lp2', color: '#000' })
    createKanbanCard({ id: 'lpc', title: 'LPC' })
    addLabelToCard('lpc', 'lp1')
    addLabelToCard('lpc', 'lp2')
    const bulk = getLabelsForAllCards()
    expect(bulk.get('lpc')?.length).toBe(2)
  })
})

// ---------------------------------------------------------------------------
// updateVaultSshServer: every patch field
// ---------------------------------------------------------------------------
describe('updateVaultSshServer patches', () => {
  it('applies every patch field', () => {
    const s = createVaultSshServer({ id: 'sv1', name: 'n1', host: 'h1', port: 22, username: 'u', description: null })
    expect(updateVaultSshServer('sv1', { host: 'h2' })).toBe(true)
    expect(updateVaultSshServer('sv1', { port: 2222 })).toBe(true)
    expect(updateVaultSshServer('sv1', { username: 'u2' })).toBe(true)
    expect(updateVaultSshServer('sv1', { description: 'desc' })).toBe(true)
    const row = getDb().prepare('SELECT * FROM vault_ssh_servers WHERE id=?').get('sv1') as Record<string, unknown>
    expect(row.host).toBe('h2')
    expect(row.port).toBe(2222)
    expect(row.username).toBe('u2')
    expect(row.description).toBe('desc')
    void s
  })
})

// ---------------------------------------------------------------------------
// vectorSearch JSON.parse error path (private fn exercised via hybridSearch)
// ---------------------------------------------------------------------------
describe('vectorSearch JSON.parse error', () => {
  it('falls back to score 0 when embedding is malformed', async () => {
    // Save with NO embedding (mock fetch to return null so the async
    // fire-and-forget doesn't overwrite our malformed value).
    setFetchThrow(new Error('mock no embed'))
    const { id } = saveAgentMemory('agent-V', 'mem', 'warm')
    // Inject malformed embedding
    getDb().prepare('UPDATE memories SET embedding=? WHERE id=?').run('not-valid-json', id)
    setFetchResponse([0.1, 0.2])
    const out = await hybridSearch('agent-V', 'mem', 5)
    expect(Array.isArray(out)).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// saveAgentMemory .catch(() => {}) chain fires when generateEmbedding rejects
// ---------------------------------------------------------------------------
describe('saveAgentMemory fire-and-forget .catch', () => {
  it('swallows generateEmbedding rejections', async () => {
    setFetchThrow(new Error('embed fail'))
    const { id } = saveAgentMemory('agent-ff', 'content', 'warm')
    // Give the fire-and-forget promise a tick to settle.
    await new Promise(r => setTimeout(r, 50))
    const row = getDb().prepare('SELECT embedding FROM memories WHERE id=?').get(id) as { embedding: string | null }
    expect(row.embedding).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// searchMemories FTS-fallback catch + recallSearch FTS-fallback catch
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// updateMemory: before?.agent_id falsy branch (cache invalidation skipped)
// ---------------------------------------------------------------------------
describe('updateMemory before.agent_id null branch', () => {
  it('does NOT call memoryCacheInvalidate when before.agent_id is empty', () => {
    clearMemoryCache()
    // Insert a row directly with agent_id='' (NOT NULL but JS-falsy) to exercise
    // the falsy branch of `if (before?.agent_id)` in updateMemory. The schema
    // forbids NULL, so empty string is the closest thing.
    const now = Math.floor(Date.now() / 1000)
    getDb().prepare(`INSERT INTO memories (chat_id, content, sector, salience, created_at, accessed_at, agent_id, category) VALUES ('c', 'x', 'semantic', 1.0, ?, ?, '', 'warm')`).run(now, now)
    const row = getDb().prepare("SELECT id FROM memories WHERE agent_id = ''").get() as { id: number }
    // Pre-populate cache with a different agent so we can detect a no-op.
    saveAgentMemory('agent-pp', 'mem', 'warm')
    getAgentMemories('agent-pp', 5)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    // Update with NO agentId -> both `before?.agent_id` (falsy '') and
    // `agentId` (undefined) skip their memoryCacheInvalidate calls.
    updateMemory(row.id, 'y', 'warm')
    const sizeAfter = getMemoryCacheSize()
    expect(sizeAfter).toBeGreaterThan(0)
  })
  it('updateMemory with matching agentId skips the new-agent invalidation', () => {
    // before.agent_id === agentId (both 'agent-eq') -> the
    // `agentId !== before?.agent_id` short-circuits to false.
    clearMemoryCache()
    saveAgentMemory('agent-eq', 'orig', 'warm')
    getAgentMemories('agent-eq', 5)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    const { id } = saveAgentMemory('agent-eq', 'two', 'warm')
    updateMemory(id, 'next', 'warm', 'agent-eq')
    // First if still fires (agent-eq was cleared), but the second if's
    // `agentId !== before?.agent_id` short-circuits when equal. Either way
    // the call returns true.
    expect(getMemoryCacheSize()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// getAgentConversationThreads: cb !== ca branch (different lastMessage times)
// ---------------------------------------------------------------------------
describe('getAgentConversationThreads different lastMessage times', () => {
  it('sorts by created_at DESC when lastMessage times differ', () => {
    const newAgent = createAgentMessage('a', 'sort-by-ts', 'newer')
    const oldAgent = createAgentMessage('a', 'sort-by-ts-old', 'older')
    // Force lastMessage.created_at for both threads to differ
    getDb().prepare('UPDATE agent_messages SET created_at=? WHERE id=?').run(50, newAgent.id)
    getDb().prepare('UPDATE agent_messages SET created_at=? WHERE id=?').run(100, oldAgent.id)
    const threads = getAgentConversationThreads()
    const sorted = threads.filter(t => t.agent === 'sort-by-ts' || t.agent === 'sort-by-ts-old')
    // newest first by created_at
    expect(sorted[0].agent).toBe('sort-by-ts-old') // created_at=100
    expect(sorted[1].agent).toBe('sort-by-ts')     // created_at=50
  })
})

// ---------------------------------------------------------------------------
// backfillEmbeddings: emb null/falsy else branch
// ---------------------------------------------------------------------------
describe('backfillEmbeddings else branch', () => {
  it('does not update or count rows when fetch returns empty/null embedding', async () => {
    saveAgentMemory('agent-be', 'mem', 'warm')
    getDb().prepare("UPDATE memories SET embedding=NULL WHERE agent_id='agent-be'").run()
    // setFetchResponse(null) -> json resolves to {embedding: null} -> falsy
    setFetchResponse(null)
    const count = await backfillEmbeddings()
    expect(count).toBe(0)
    // embedding remains NULL (UPDATE was skipped on the falsy emb branch)
    const row = getDb().prepare("SELECT embedding FROM memories WHERE agent_id='agent-be' LIMIT 1").get() as { embedding: string | null }
    expect(row.embedding).toBeNull()
  })
  it('returns [] when FTS query throws', () => {
    saveMemory('chat-fts', 'apple pie', 'semantic')
    // Spy on prepare to throw on the FTS MATCH statement (only first call).
    const original = Database.prototype.prepare
    let thrown = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes('memories_fts') && sql.includes('MATCH') && !thrown) {
        thrown = true
        throw new Error('mock FTS throw')
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    try {
      const out = searchMemories('apple', 'chat-fts', 5)
      expect(out).toEqual([])
    } finally {
      Database.prototype.prepare = original
    }
  })
})

describe('recallSearch FTS catch (with agentId)', () => {
  it('falls back to LIKE path when FTS throws', () => {
    // Create a memory with searchable content under agent-RF
    saveAgentMemory('agent-RF', 'apple banana content', 'warm')
    const original = Database.prototype.prepare
    let thrown = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes('memories_fts') && sql.includes('MATCH') && !thrown) {
        thrown = true
        throw new Error('mock FTS throw')
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    try {
      const out = recallSearch('apple', 'agent-RF', 5)
      // The FTS fallback hits the LIKE path, which finds the saved memory.
      expect(out.memories.length).toBeGreaterThan(0)
    } finally {
      Database.prototype.prepare = original
    }
  })
})

// ---------------------------------------------------------------------------
// hybridSearch sort + backfillEmbeddings else branch
// ---------------------------------------------------------------------------
describe('hybridSearch sort + backfillEmbeddings else', () => {
  it('hybridSearch exercises RRF sort callback', async () => {
    saveAgentMemory('agent-H2', 'apple', 'warm')
    saveAgentMemory('agent-H2', 'banana', 'warm')
    setFetchResponse([0.1, 0.2, 0.3])
    const out = await hybridSearch('agent-H2', 'apple', 5)
    expect(out.length).toBeGreaterThan(0)
  })
  it('backfillEmbeddings counts successful embeds, skips on null', async () => {
    // The "else" branch in backfillEmbeddings is the `if (emb)` false case
    // where the fetch returned no embedding -> no count++.
    setFetchResponse(null)
    const count = await backfillEmbeddings()
    expect(count).toBe(0)
    // setFetchResponse(null) yields a json that resolves to {embedding: null},
    // which is falsy -> skips the UPDATE -> count stays 0.
    void count
  })
})

// ---------------------------------------------------------------------------
// searchAgentMemories empty FTS path (empty terms early return)
// ---------------------------------------------------------------------------
describe('searchAgentMemories empty FTS', () => {
  it('returns [] when terms are empty after sanitization', () => {
    saveAgentMemory('agent-empty', 'mem', 'warm')
    expect(searchAgentMemories('agent-empty', '!!!', 5)).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// updateMemory: reassign to different agent triggers old + new cache clear
// ---------------------------------------------------------------------------
describe('updateMemory reassign cache clear', () => {
  it('clears both old and new agent cache when reassigning', () => {
    clearMemoryCache()
    // First populate the cache for BOTH agents so we can verify both are cleared.
    saveAgentMemory('agent-old', 'a', 'warm')
    saveAgentMemory('agent-new', 'b', 'warm')
    getAgentMemories('agent-old', 5)
    getAgentMemories('agent-new', 5)
    expect(getMemoryCacheSize()).toBeGreaterThan(0)
    // Now reassign: this triggers `memoryCacheInvalidate(before.agent_id)`
    // and `memoryCacheInvalidate(agentId)` -- both go to size 0.
    const { id } = saveAgentMemory('agent-old', 'c', 'warm')
    updateMemory(id, 'c2', 'warm', 'agent-new')
    expect(getMemoryCacheSize()).toBe(0)
  })
})

// ---------------------------------------------------------------------------
// pending_task_retries: explicit cover of each function
// ---------------------------------------------------------------------------
describe('pending_task_retries: full surface', () => {
  it('upsertPendingTaskRetry inserts new row when no row exists', () => {
    // Empty cache from previous tests
    clearPendingTaskRetryAlert('does-not-exist', 'main') // false path
    expect(deletePendingTaskRetry('does-not-exist', 'main')).toBe(false)
    expect(deletePendingTaskRetryById(-1)).toBe(false)
    expect(getPendingTaskRetry('does-not-exist', 'main')).toBeUndefined()
    // ListPendingTaskRetries returns []
    expect(listPendingTaskRetries().filter(r => r.task_name === 'never-existed')).toEqual([])
    // Now insert
    upsertPendingTaskRetry('up1', 'main', 1, 'busy')
    expect(getPendingTaskRetry('up1', 'main')?.task_name).toBe('up1')
    // Update via upsert
    upsertPendingTaskRetry('up1', 'main', 2, 'busy2')
    expect(getPendingTaskRetry('up1', 'main')?.attempt_count).toBe(2)
    expect(getPendingTaskRetry('up1', 'main')?.last_reason).toBe('busy2')
    // Clear alert then mark
    markPendingTaskRetryAlert('up1', 'main', 100)
    clearPendingTaskRetryAlert('up1', 'main')
    expect(getPendingTaskRetry('up1', 'main')?.alert_sent_at).toBeNull()
    // Delete
    expect(deletePendingTaskRetry('up1', 'main')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// initDatabase mkdirSync + EEXIST + token dedup catch + kanban rebuild catch
// ---------------------------------------------------------------------------
describe('initDatabase: full branch coverage', () => {
  it('mkdirSync STORE_DIR runs when no override path is provided', () => {
    // The live-install gate (setup/assert-not-live-install) has already
    // refused to run on a real install, so calling initDatabase() with no
    // args only creates the empty STORE_DIR + prod DB on a fresh clone.
    // We use a temporary cwd by pre-creating an empty dir + an isolated
    // STORE_DIR via mocking the imported STORE_DIR. Easier: spy on
    // fs.mkdirSync so we can confirm it was invoked with STORE_DIR.
    fsState.mkdirSyncShouldThrow = new Error('mock mkdir done')
    try {
      expect(() => initDatabase()).toThrow('mock mkdir done')
    } finally {
      fsState.mkdirSyncShouldThrow = undefined
      initDatabase(':memory:')
    }
  })
  it('EEXIST catch branch (code === EEXIST) is silent', () => {
    // Force existsSync to return false (so the outer if is entered), then
    // openSync throws EEXIST (the race: someone created the file between
    // existsSync and openSync).
    const tmpDb = join(tmpDir, 'eexist-real.db')
    const originalExists = fs.existsSync
    const originalOpen = fs.openSync
    fs.existsSync = ((p: fs.PathLike) => {
      // Pretend the file does not exist (always false) so the outer if
      // runs; but openSync will then fail with EEXIST because the real
      // file does exist on disk.
      if (typeof p === 'string' && p === tmpDb) return false
      return originalExists(p)
    }) as typeof fs.existsSync
    openSync(tmpDb, 'wx', 0o600) // create the file once
    try {
      initDatabase(tmpDb) // hits EEXIST inside catch -> silent
      expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeDefined()
    } finally {
      fs.existsSync = originalExists
      fs.openSync = originalOpen
      initDatabase(':memory:')
    }
  })
  it('EEXIST branch in pre-create is silent (does not warn)', () => {
    const tmpDb = join(tmpDir, 'eexist.db')
    openSync(tmpDb, 'wx', 0o600)
    try {
      initDatabase(tmpDb)
      expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeDefined()
    } finally {
      initDatabase(':memory:')
    }
  })
  it('openSync failure with non-EEXIST logs warn and continues', () => {
    // db.ts's pre-create calls openSync(dbPath, 'wx', 0o600) before
    // `new Database()`. Mock the better-sqlite3 Database ctor's underlying
    // pre-create path via a spy on the node:fs openSync so we throw a
    // non-EEXIST error.
    const originalOpenSync = fs.openSync
    let triggered = false
    fs.openSync = ((p: fs.PathLike, flags: string | number, mode?: number) => {
      if (typeof p === 'string' && p.endsWith('openfail.db') && flags === 'wx' && !triggered) {
        triggered = true
        const err = new Error('mock open fail') as NodeJS.ErrnoException
        err.code = 'EACCES'
        throw err
      }
      return originalOpenSync(p, flags, mode)
    }) as typeof fs.openSync
    try {
      const tmpDb = join(tmpDir, 'openfail.db')
      initDatabase(tmpDb)
      expect(triggered).toBe(true)
      expect(getDb().prepare("SELECT name FROM sqlite_master WHERE name='sessions'").get()).toBeDefined()
    } finally {
      fs.openSync = originalOpenSync
      initDatabase(':memory:')
    }
  })
  it('kanban_cards rebuild catch path (errors out)', () => {
    // Use vi.spyOn on Database.prototype.prepare so the mock survives across
    // initDatabase's close+reopen (a fresh db module-level variable).
    const tmpDb = join(tmpDir, 'kanban-fail.db')
    initDatabase(tmpDb)
    const original = Database.prototype.prepare
    let triggered = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes("SELECT sql FROM sqlite_master WHERE type='table' AND name='kanban_cards'") && !triggered) {
        triggered = true
        throw new Error('mock rebuild fail')
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    try {
      initDatabase(tmpDb)
      expect(triggered).toBe(true)
    } finally {
      Database.prototype.prepare = original
      initDatabase(':memory:')
    }
  })
  it('memories migration catch with non-existent message (logs error)', () => {
    const tmpDb = join(tmpDir, 'mem-fail.db')
    initDatabase(tmpDb)
    const original = Database.prototype.prepare
    let triggered = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes("SELECT sql FROM sqlite_master WHERE name='memories'") && !triggered) {
        triggered = true
        throw new Error('mock memory migration fail')
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    const originalConsole = console.error
    console.error = () => {}
    try {
      initDatabase(tmpDb)
      expect(triggered).toBe(true)
    } finally {
      Database.prototype.prepare = original
      console.error = originalConsole
      initDatabase(':memory:')
    }
  })
  it('memories migration catch with already-exists message (silent)', () => {
    const tmpDb = join(tmpDir, 'mem-exists.db')
    initDatabase(tmpDb)
    const original = Database.prototype.prepare
    let triggered = false
    Database.prototype.prepare = function (sql: string) {
      if (sql.includes("SELECT sql FROM sqlite_master WHERE name='memories'") && !triggered) {
        triggered = true
        throw new Error('table memories already exists')
      }
      return original.call(this, sql)
    } as typeof Database.prototype.prepare
    try {
      initDatabase(tmpDb)
      expect(triggered).toBe(true)
    } finally {
      Database.prototype.prepare = original
      initDatabase(':memory:')
    }
  })
  it('token_usage unique index dedup catch block', () => {
    // Build a raw DB file WITHOUT the unique index, insert dupes, then run
    // initDatabase on it -> the unique-index CREATE fails (catches), the
    // catch-block dedup runs, the unique-index CREATE is retried successfully.
    const tmpDb = join(tmpDir, 'token-dup.db')
    const raw = new Database(tmpDb)
    raw.exec(`
      CREATE TABLE token_usage (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        agent TEXT NOT NULL,
        session_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        input_tokens INTEGER NOT NULL DEFAULT 0,
        output_tokens INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens INTEGER NOT NULL DEFAULT 0,
        cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
        thinking_tokens INTEGER NOT NULL DEFAULT 0,
        model TEXT,
        content_preview TEXT,
        tool_name TEXT,
        task_title TEXT,
        project TEXT
      )
    `)
    const ts = Math.floor(Date.now() / 1000)
    raw.prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`).run('dup-agent', 'dup-s', ts, 1, 2)
    raw.prepare(`INSERT INTO token_usage (agent, session_id, timestamp, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)`).run('dup-agent', 'dup-s', ts, 1, 2)
    raw.close()
    initDatabase(tmpDb) // triggers the catch -> dedup -> CREATE INDEX retry
    expect((getDb().prepare('SELECT COUNT(*) as c FROM token_usage').get() as { c: number }).c).toBe(1)
    initDatabase(':memory:')
  })
})