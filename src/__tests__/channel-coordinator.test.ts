// Tests for src/channel-coordinator.ts.
//
// Coverage scope: pure helpers (inNative409Cooldown, neutralizeChannelTags,
// buildHandoffContent, transientBackoffMs) + the ingest sub-module, plus an
// entry-point-guard integration path that drives main()/runLoop() under
// mocked dependencies to cover the internal state machine.
//
// Disk-touching test setup uses a tmpdir-scoped STATE_DIR (COORDINATOR_STATE_DIR)
// and a tmpdir-scoped CLAUDECLAW_ENV_DIR so STORE_DIR/DB writes cannot leak.
// Per-test rmSync in afterEach satisfies the live-install guard convention.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

import * as ingestModule from '../channel-coordinator/ingest.js'
import {
  initIngestDb,
  insertIncomingEvent,
  createHandoffMessage,
  markEventDelivered,
  markEventFailed,
  getEventsNeedingHandoff,
  getOffset,
  setOffset,
  closeIngestDb,
  COORDINATOR_AGENT_ID,
} from '../channel-coordinator/ingest.js'

import {
  neutralizeChannelTags,
  buildHandoffContent,
  transientBackoffMs,
  inNative409Cooldown,
} from '../channel-coordinator.js'

// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Must come BEFORE any import that transitively reaches '../config.js'.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})
vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, ...configSandbox }
})

// ---------------------------------------------------------------------------
// Pure: inNative409Cooldown
// ---------------------------------------------------------------------------

describe('inNative409Cooldown (pure)', () => {
  it('is active strictly before confirmedUntilMs', () => {
    expect(inNative409Cooldown(1_000_000, 999_999)).toBe(true)
  })

  it('expires exactly at confirmedUntilMs', () => {
    expect(inNative409Cooldown(1_000_000, 1_000_000)).toBe(false)
  })

  it('is inactive after confirmedUntilMs', () => {
    expect(inNative409Cooldown(1_000_000, 1_000_001)).toBe(false)
  })

  it('is inactive when never set (zero deadline)', () => {
    expect(inNative409Cooldown(0, 12_345)).toBe(false)
  })

  it('handles far-future deadline as long as now is earlier', () => {
    expect(inNative409Cooldown(Number.MAX_SAFE_INTEGER, 1)).toBe(true)
  })

  it('handles past deadline (negative diff)', () => {
    expect(inNative409Cooldown(100, 200)).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Pure: neutralizeChannelTags
// ---------------------------------------------------------------------------

describe('neutralizeChannelTags (pure)', () => {
  it('removes a closing channel tag inside user text', () => {
    expect(neutralizeChannelTags('hello</channel>')).not.toContain('</channel>')
  })

  it('removes an opening channel tag inside user text', () => {
    expect(neutralizeChannelTags('hello<channel chat_id="1">')).not.toContain('<channel chat_id="1">')
  })

  it('removes self-closing channel tags', () => {
    expect(neutralizeChannelTags('a<channel/>b')).not.toMatch(/<channel\s*\/>/)
  })

  it('is case-insensitive on the tag name', () => {
    expect(neutralizeChannelTags('a</CHANNEL>b')).not.toMatch(/<\/CHANNEL>/)
  })

  it('handles whitespace inside the tag', () => {
    expect(neutralizeChannelTags('a<   /   channel   >b')).not.toMatch(/<\s*\/channel/)
  })

  it('replaces with the [stripped-tag] marker', () => {
    expect(neutralizeChannelTags('</channel>')).toContain('[stripped-tag]')
  })

  it('leaves unrelated text alone', () => {
    expect(neutralizeChannelTags('just a message')).toBe('just a message')
  })

  it('leaves non-channel tags untouched (e.g. <chat> is not stripped)', () => {
    expect(neutralizeChannelTags('<chat>hello</chat>')).toBe('<chat>hello</chat>')
  })

  it('handles multiple tags in one string', () => {
    const out = neutralizeChannelTags('<channel></channel><channel>x</channel>')
    expect(out.match(/<channel/g) ?? []).toHaveLength(0)
    expect(out.match(/<\/channel>/g) ?? []).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Pure: buildHandoffContent
// Covers every branch in the `attrs` join: chat_id, message_id, username, user_id,
// ts (tg_date -> ISO), kind != 'message', voiceFileId attachment fields.
// ---------------------------------------------------------------------------

describe('buildHandoffContent (pure)', () => {
  it('frames a fully populated message', () => {
    const out = buildHandoffContent({
      kind: 'message',
      chat_id: 1268077055,
      user_id: 1268077055,
      username: 'szabolcs',
      message_id: 522,
      content: 'itt vagy?',
      tg_date: 1700000000,
    })
    expect(out).toContain('source="telegram"')
    expect(out).toContain('chat_id="1268077055"')
    expect(out).toContain('message_id="522"')
    expect(out).toContain('user="szabolcs"')
    expect(out).toContain('user_id="1268077055"')
    expect(out).toContain('ts="2023-11-14T22:13:20.000Z"')
    expect(out).toContain('itt vagy?')
    expect(out).toMatch(/^<channel [^>]+>\n/)
    expect(out).toMatch(/\n<\/channel>$/)
  })

  it('omits chat_id when null', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: null, user_id: 1, username: 'u',
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out).not.toContain('chat_id=')
  })

  it('omits message_id when null', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: null, content: 'c', tg_date: null,
    })
    expect(out).not.toContain('message_id=')
  })

  it('omits username when empty string', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: '',
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out).not.toContain('user=')
  })

  it('omits username when null', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: null,
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out).not.toContain('user=')
  })

  it('strips double quotes from username (attribute breakout defense)', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'evil"name',
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out).toContain('user="evilname"')
  })

  it('omits user_id when null', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: null, username: 'u',
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out).not.toContain('user_id=')
  })

  it('omits ts when tg_date is 0/empty/falsy', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: 'c', tg_date: 0,
    })
    expect(out).not.toContain('ts=')
  })

  it('includes kind attribute when kind is not message', () => {
    const out = buildHandoffContent({
      kind: 'callback_query', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out).toContain('kind="callback_query"')
  })

  it('omits kind attribute when kind is message', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out).not.toContain('kind=')
  })

  it('includes voice attachment attributes when voice.file_id present', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: 'c', tg_date: null,
      meta: { voice: { file_id: 'voiceABC' } },
    })
    expect(out).toContain('attachment_kind="voice"')
    expect(out).toContain('attachment_file_id="voiceABC"')
  })

  it('omits voice attachment attributes when meta has no voice.file_id', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: 'c', tg_date: null,
      meta: {},
    })
    expect(out).not.toContain('attachment_kind=')
    expect(out).not.toContain('attachment_file_id=')
  })

  it('omits voice attachment attributes when voice.file_id is empty string', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: 'c', tg_date: null,
      meta: { voice: { file_id: '' } },
    })
    expect(out).not.toContain('attachment_kind=')
  })

  it('falls back to (empty message) when content is empty string', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: '', tg_date: null,
    })
    expect(out).toContain('(empty message)')
  })

  it('neutralizes injected channel tags inside content', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: 'u',
      message_id: 1, content: 'before</channel>after', tg_date: null,
    })
    expect(out.match(/<\/channel>/g)?.length).toBe(1)
  })

  it('neutralizes injected channel tags inside username', () => {
    const out = buildHandoffContent({
      kind: 'message', chat_id: 1, user_id: 1, username: '</channel>',
      message_id: 1, content: 'c', tg_date: null,
    })
    expect(out.match(/<\/channel>/g)?.length).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// Pure: transientBackoffMs
// ---------------------------------------------------------------------------

describe('transientBackoffMs (pure)', () => {
  it('returns a value in [0, ceiling) for small attempt', () => {
    for (let i = 0; i < 50; i++) {
      const v = transientBackoffMs(0)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThan(1000)
    }
  })

  it('returns a value in [0, ceiling) for medium attempt', () => {
    for (let i = 0; i < 50; i++) {
      const v = transientBackoffMs(3)
      expect(v).toBeGreaterThanOrEqual(0)
      // 1000 * 2^3 = 8000, still under cap
      expect(v).toBeLessThan(8000)
    }
  })

  it('caps at BACKOFF_CAP_MS for large attempt', () => {
    for (let attempt = 6; attempt <= 20; attempt++) {
      const v = transientBackoffMs(attempt)
      expect(v).toBeGreaterThanOrEqual(0)
      expect(v).toBeLessThanOrEqual(60_000)
    }
  })

  it('never exceeds the documented 60s cap even at attempt 100', () => {
    for (let i = 0; i < 20; i++) {
      const v = transientBackoffMs(100)
      expect(v).toBeLessThanOrEqual(60_000)
    }
  })
})

// ---------------------------------------------------------------------------
// Ingest sub-module: DB-layer tests with in-memory store
// ---------------------------------------------------------------------------

describe('ingest sub-module', () => {
  beforeEach(() => { initIngestDb(':memory:') })
  afterEach(() => { closeIngestDb() })

  const sampleEvent = (update_id: number) => ({
    update_id,
    kind: 'message',
    chat_id: 1268077055,
    user_id: 1268077055,
    username: 'szabolcs',
    message_id: update_id,
    content: `msg ${update_id}`,
    meta: {},
    tg_date: 1700000000,
  })

  it('insertIncomingEvent returns inserted=true on first call', () => {
    const r = insertIncomingEvent('telegram', sampleEvent(100))
    expect(r.inserted).toBe(true)
    expect(r.eventId).not.toBeNull()
  })

  it('insertIncomingEvent dedupes by (source, update_id)', () => {
    const first = insertIncomingEvent('telegram', sampleEvent(100))
    const second = insertIncomingEvent('telegram', sampleEvent(100))
    expect(first.inserted).toBe(true)
    expect(second.inserted).toBe(false)
    expect(second.eventId).toBeNull()
  })

  it('insertIncomingEvent treats different update_ids as distinct rows', () => {
    const a = insertIncomingEvent('telegram', sampleEvent(100))
    const b = insertIncomingEvent('telegram', sampleEvent(101))
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(true)
    expect(a.eventId).not.toEqual(b.eventId)
  })

  it('insertIncomingEvent treats different sources as distinct', () => {
    const a = insertIncomingEvent('telegram', sampleEvent(200))
    const b = insertIncomingEvent('slack', sampleEvent(200))
    expect(a.inserted).toBe(true)
    expect(b.inserted).toBe(true)
  })

  it('createHandoffMessage writes a pending agent_message from coordinator to main', () => {
    const db = initIngestDb(':memory:')
    const amId = createHandoffMessage('<channel>hello</channel>')
    const row = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(amId) as Record<string, unknown>
    expect(row['from_agent']).toBe(COORDINATOR_AGENT_ID)
    expect(row['status']).toBe('pending')
    expect(row['content']).toBe('<channel>hello</channel>')
  })

  it('markEventDelivered flips incoming_events status and links agent_message_id', () => {
    const db = initIngestDb(':memory:')
    const ins = insertIncomingEvent('telegram', sampleEvent(300))
    const amId = createHandoffMessage('content')
    markEventDelivered(ins.eventId!, amId)
    const row = db.prepare('SELECT status, agent_message_id FROM incoming_events WHERE id = ?').get(ins.eventId) as Record<string, unknown>
    expect(row['status']).toBe('delivered')
    expect(row['agent_message_id']).toBe(amId)
  })

  it('getOffset returns 0 when no row exists for the source', () => {
    expect(getOffset('telegram')).toBe(0)
  })

  it('setOffset then getOffset roundtrips', () => {
    setOffset('telegram', 500)
    expect(getOffset('telegram')).toBe(500)
  })

  it('setOffset UPSERTs (overwrites existing row)', () => {
    setOffset('telegram', 500)
    setOffset('telegram', 512)
    expect(getOffset('telegram')).toBe(512)
  })

  it('setOffset scopes by source (different sources keep independent offsets)', () => {
    setOffset('telegram', 100)
    setOffset('slack', 999)
    expect(getOffset('telegram')).toBe(100)
    expect(getOffset('slack')).toBe(999)
  })

  it('getEventsNeedingHandoff returns rows with no agent_message_id', () => {
    const ins = insertIncomingEvent('telegram', sampleEvent(400))
    const need = getEventsNeedingHandoff('telegram')
    expect(need.map((e) => e.id)).toContain(ins.eventId)
  })

  it('getEventsNeedingHandoff excludes rows whose agent_message is in-flight', () => {
    const a = insertIncomingEvent('telegram', sampleEvent(401))
    const amA = createHandoffMessage('c')
    markEventDelivered(a.eventId!, amA) // status still pending
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(ids).not.toContain(a.eventId)
  })

  it('getEventsNeedingHandoff includes rows whose agent_message was marked failed', () => {
    const db = initIngestDb(':memory:')
    const ins = insertIncomingEvent('telegram', sampleEvent(402))
    const amId = createHandoffMessage('c')
    markEventDelivered(ins.eventId!, amId)
    db.prepare("UPDATE agent_messages SET status = 'failed' WHERE id = ?").run(amId)
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    expect(ids).toContain(ins.eventId)
  })

  it('getEventsNeedingHandoff returns events ordered by id ASC', () => {
    insertIncomingEvent('telegram', sampleEvent(500))
    insertIncomingEvent('telegram', sampleEvent(501))
    insertIncomingEvent('telegram', sampleEvent(502))
    const ids = getEventsNeedingHandoff('telegram').map((e) => e.id)
    const sorted = [...ids].sort((a, b) => a - b)
    expect(ids).toEqual(sorted)
  })

  it('getEventsNeedingHandoff respects the limit parameter', () => {
    insertIncomingEvent('telegram', sampleEvent(600))
    insertIncomingEvent('telegram', sampleEvent(601))
    insertIncomingEvent('telegram', sampleEvent(602))
    const limited = getEventsNeedingHandoff('telegram', 2)
    expect(limited).toHaveLength(2)
  })

  it('end-to-end: insert -> handoff -> mark delivered -> read agent_message row', () => {
    const db = initIngestDb(':memory:')
    const ins = insertIncomingEvent('telegram', sampleEvent(700))
    const amId = createHandoffMessage(buildHandoffContent(sampleEvent(700)))
    markEventDelivered(ins.eventId!, amId)
    const am = db.prepare('SELECT * FROM agent_messages WHERE id = ?').get(amId) as Record<string, unknown>
    expect(am['from_agent']).toBe(COORDINATOR_AGENT_ID)
    expect(am['status']).toBe('pending')
    expect(String(am['content'])).toContain('chat_id="1268077055"')
    const ev = db.prepare('SELECT * FROM incoming_events WHERE id = ?').get(ins.eventId) as Record<string, unknown>
    expect(ev['status']).toBe('delivered')
    expect(ev['agent_message_id']).toBe(amId)
  })

  it('closeIngestDb is idempotent (safe to call twice)', () => {
    closeIngestDb()
    closeIngestDb() // must not throw
  })

  it('initIngestDb returns the same handle on repeated calls (singleton)', () => {
    const a = initIngestDb(':memory:')
    const b = initIngestDb(':memory:')
    expect(a).toBe(b)
  })

  it('markEventFailed records the error string in incoming_events.error', () => {
    // Sanity: ensure markEventFailed is exported by the ingest module.
    expect(typeof ingestModule.markEventFailed).toBe('function')
    const db = initIngestDb(':memory:')
    const ins = insertIncomingEvent('telegram', sampleEvent(800))
    markEventFailed(ins.eventId!, 'something broke')
    const row = db.prepare('SELECT status, error FROM incoming_events WHERE id = ?').get(ins.eventId) as Record<string, unknown>
    expect(row['status']).toBe('failed')
    expect(row['error']).toBe('something broke')
  })
})

// ---------------------------------------------------------------------------
// Single end-to-end integration test: trigger main() via the entry-point
// guard so the internal runLoop/lock/signal-handler code paths are exercised
// at least once. Mocks keep the runtime hermetic; SIGTERM cleans up at end.
// All other branch coverage on the internal state machine would need the
// source modified to be exportable, so we keep ONE test that proves the
// wired path and accept that v8 will report partial coverage on internals.
// ---------------------------------------------------------------------------

describe('main() entry-point bootstrap (one-shot)', () => {
  it('triggers main, acquires lock, runs one tick, releases on SIGTERM', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'marveen-cc-once-'))
    const origArgv = process.argv[1]
    const origEnvDir = process.env.COORDINATOR_STATE_DIR
    const origToken = process.env.TELEGRAM_BOT_TOKEN
    const exitCalls: number[] = []
    process.env.COORDINATOR_STATE_DIR = tmpDir
    process.env.TELEGRAM_BOT_TOKEN = 'integration-test-token'
    process.argv[1] = fileURLToPath(new URL('../channel-coordinator.ts', import.meta.url))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0)
    }) as never)

    // Mock the liveness probe so BACKFILLING is never entered (idle loop is
    // fine for this one-shot -- we only need main()/lock/signal-handler/runLoop
    // entry exercised). Mock child_process so sendAlert -> notify.sh never
    // runs. Mock ingest as a single-pass nop so initIngestDb() resolves.
    vi.doMock('../logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))
    vi.doMock('../channel-coordinator/telegram-client.js', () => ({
      probeHighWater: vi.fn(async () => null),
      getUpdates: vi.fn(async () => []),
      mapUpdate: vi.fn(() => null),
      TelegramApiError: class TelegramApiError extends Error {
        constructor(public kind: string, msg: string) { super(msg); this.name = 'TelegramApiError' }
      },
    }))
    vi.doMock('../channel-coordinator/liveness.js', () => ({
      probeNativeChannelDown: vi.fn(() => false),
    }))
    vi.doMock('../channel-coordinator/ingest.js', () => ({
      initIngestDb: vi.fn(),
      closeIngestDb: vi.fn(),
      insertIncomingEvent: vi.fn(() => ({ inserted: false, eventId: null })),
      createHandoffMessage: vi.fn(() => 0),
      markEventDelivered: vi.fn(),
      getEventsNeedingHandoff: vi.fn(() => []),
      getOffset: vi.fn(() => 0),
      setOffset: vi.fn(),
      COORDINATOR_AGENT_ID: 'integration',
    }))

    try {
      vi.resetModules()
      await import('../channel-coordinator.ts')
      // One tick: TICK_MS=5000ms -> wait 6s for the loop to call probe once.
      await new Promise((r) => setTimeout(r, 6000))
      expect(existsSync(join(tmpDir, 'coordinator.pid'))).toBe(true)
      // SIGTERM triggers the installed handler; onSignal sets stopping=true.
      process.emit('SIGTERM')
      // The handler's setTimeout(...,3000) lets main() clean up before exit.
      await new Promise((r) => setTimeout(r, 4000))
      // After releaseLock(), the pid file is removed.
      expect(existsSync(join(tmpDir, 'coordinator.pid'))).toBe(false)
    } finally {
      exitSpy.mockRestore()
      vi.doUnmock('../logger.js')
      vi.doUnmock('../channel-coordinator/telegram-client.js')
      vi.doUnmock('../channel-coordinator/liveness.js')
      vi.doUnmock('../channel-coordinator/ingest.js')
      vi.resetModules()
      if (origArgv === undefined) delete process.argv[1]
      else process.argv[1] = origArgv
      if (origEnvDir === undefined) delete process.env.COORDINATOR_STATE_DIR
      else process.env.COORDINATOR_STATE_DIR = origEnvDir
      if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = origToken
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 20000)

  // Trigger main() with no TELEGRAM_BOT_TOKEN and no .env file -> readToken()
  // throws -> main().catch() logs + calls process.exit(1). Exercises the
  // entry-point catch handler (lines 436-439).
  it('entry-point catch handler runs when main() throws', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'marveen-cc-crash-'))
    const origArgv = process.argv[1]
    const origEnvDir = process.env.COORDINATOR_STATE_DIR
    const origToken = process.env.TELEGRAM_BOT_TOKEN
    const exitCalls: number[] = []
    delete process.env.TELEGRAM_BOT_TOKEN
    delete process.env.COORDINATOR_STATE_DIR  // no STATE_DIR -> .env read fails too
    process.argv[1] = fileURLToPath(new URL('../channel-coordinator.ts', import.meta.url))
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCalls.push(code ?? 0)
    }) as never)

    vi.doMock('../logger.js', () => ({
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
    }))

    try {
      vi.resetModules()
      await import('../channel-coordinator.ts')
      await new Promise((r) => setTimeout(r, 100))  // let readToken throw synchronously
      expect(exitCalls).toContain(1)
    } finally {
      exitSpy.mockRestore()
      vi.doUnmock('../logger.js')
      vi.resetModules()
      if (origArgv === undefined) delete process.argv[1]
      else process.argv[1] = origArgv
      if (origEnvDir === undefined) delete process.env.COORDINATOR_STATE_DIR
      else process.env.COORDINATOR_STATE_DIR = origEnvDir
      if (origToken === undefined) delete process.env.TELEGRAM_BOT_TOKEN
      else process.env.TELEGRAM_BOT_TOKEN = origToken
      rmSync(tmpDir, { recursive: true, force: true })
    }
  }, 5000)
})
