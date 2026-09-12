// DB layer for the channel-coordinator.
//
// The coordinator is a SEPARATE process from the dashboard, so it cannot share
// the dashboard's sqlite singleton (src/db.ts). It opens its OWN handle
// to the same store/claudeclaw.db file. That is safe because the DB runs in WAL
// mode (a writer never blocks readers, and two processes can write to a WAL DB
// as long as each sets busy_timeout). We assert busy_timeout=5000 on our handle
// because db.ts does not set it -- without it a concurrent dashboard write would
// surface as SQLITE_BUSY instead of a short wait.
//
// Two tables live here:
//   incoming_events -- every inbound Telegram update, deduped on (source,update_id)
//   poll_offset     -- the persisted getUpdates offset (one row), so a restart
//                      resumes instead of replaying or skipping.
// The handoff to Marveen reuses the existing agent_messages table + the proven
// message-router (5s tick, tmux injection, wrapUntrusted) -- we just INSERT a
// pending row from 'telegram-coordinator' to the main agent.
//
// The IngestWorker class below owns the Database handle and the 7 query
// methods. The class is INTERNAL -- the module exports a module-singleton
// instance and 9 thin 1-line shims over it, preserving byte-equivalent
// behavior for the 13 mock/import sites and the 3 external const-only
// production consumers. See
// docs/refactor-to-classbase/g-channel-coordinator/05-refactor-roadmap.md
// for the rationale and
// docs/refactor-to-classbase/g-channel-coordinator/01-module-state-analysis.md
// for the cross-file state surface.

import { Database, pragma, runScript } from '../db/sqlite.js'
import { join } from 'node:path'
import { STORE_DIR, DB_FILENAME, MAIN_AGENT_ID } from '../config.js'

class IngestWorker {
  static readonly COORDINATOR_AGENT_ID = 'telegram-coordinator'

  private db: Database | null = null

  init(dbPath: string): Database {
    if (this.db) return this.db
    const handle = new Database(dbPath, { strict: true })
    // WAL is persistent per-DB (the dashboard already set it); re-assert is a
    // no-op but harmless. busy_timeout IS per-connection, so set it here.
    pragma(handle, 'journal_mode = WAL')
    pragma(handle, 'busy_timeout = 5000')

    runScript(handle, `
      CREATE TABLE IF NOT EXISTS incoming_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        source TEXT NOT NULL DEFAULT 'telegram',
        update_id INTEGER NOT NULL,
        chat_id INTEGER,
        user_id INTEGER,
        username TEXT,
        message_id INTEGER,
        kind TEXT NOT NULL DEFAULT 'message',
        content TEXT,
        meta TEXT,
        tg_date INTEGER,
        status TEXT NOT NULL DEFAULT 'pending'
          CHECK(status IN ('pending','delivered','done','failed')),
        agent_message_id INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER
      )
    `)
    // Idempotency: an at-least-once handler (crash between handoff and offset
    // persist) must never create a duplicate event for the same update.
    runScript(handle, `CREATE UNIQUE INDEX IF NOT EXISTS idx_incoming_events_source_update ON incoming_events(source, update_id)`)
    runScript(handle, `CREATE INDEX IF NOT EXISTS idx_incoming_events_status ON incoming_events(status, created_at)`)

    runScript(handle, `
      CREATE TABLE IF NOT EXISTS poll_offset (
        source TEXT PRIMARY KEY,
        last_update_id INTEGER NOT NULL DEFAULT 0,
        updated_at INTEGER NOT NULL
      )
    `)

    // Defensive: the coordinator and the dashboard both start at boot (separate
    // launchd units). The dashboard owns agent_messages, but if the coordinator
    // wins the race and tries to hand off before the dashboard's initDatabase
    // runs, the INSERT would fail. CREATE IF NOT EXISTS with the identical schema
    // (db.ts) is a no-op when the dashboard already made it, and prevents the
    // boot-race failure otherwise.
    runScript(handle, `
      CREATE TABLE IF NOT EXISTS agent_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        content TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending','delivered','done','failed')),
        result TEXT,
        created_at INTEGER NOT NULL,
        delivered_at INTEGER,
        completed_at INTEGER
      )
    `)

    this.db = handle
    return this.db
  }

  // The `this.db === null` branch is unreachable through the public API:
  // every caller reaches the 7 query methods via module-singleton shims
  // that throw "ingest db not initialized" before this point.
  private requireDb(): Database {
    /* istanbul ignore next */
    if (!this.db) throw new Error('ingest db not initialized -- call initIngestDb() first')
    return this.db
  }

  insertIncomingEvent(
    source: string,
    ev: {
      update_id: number
      kind: string
      chat_id: number | null
      user_id: number | null
      username: string | null
      message_id: number | null
      content: string
      meta: Record<string, unknown>
      tg_date: number | null
    },
  ): InsertResult {
    const now = Math.floor(Date.now() / 1000)
    const info = this.requireDb().prepare(`
      INSERT OR IGNORE INTO incoming_events
        (source, update_id, chat_id, user_id, username, message_id, kind, content, meta, tg_date, status, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)
    `).run(
      source, ev.update_id, ev.chat_id, ev.user_id, ev.username, ev.message_id,
      ev.kind, ev.content, JSON.stringify(ev.meta), ev.tg_date, now,
    )
    return { inserted: info.changes > 0, eventId: info.changes > 0 ? Number(info.lastInsertRowid) : null }
  }

  createHandoffMessage(content: string): number {
    const now = Math.floor(Date.now() / 1000)
    const info = this.requireDb().prepare(
      'INSERT INTO agent_messages (from_agent, to_agent, content, status, created_at) VALUES (?, ?, ?, ?, ?)'
    ).run(IngestWorker.COORDINATOR_AGENT_ID, MAIN_AGENT_ID, content, 'pending', now)
    return Number(info.lastInsertRowid)
  }

  markEventDelivered(eventId: number, agentMessageId: number): void {
    const now = Math.floor(Date.now() / 1000)
    this.requireDb().prepare(
      "UPDATE incoming_events SET status = 'delivered', agent_message_id = ?, delivered_at = ? WHERE id = ?"
    ).run(agentMessageId, now, eventId)
  }

  markEventFailed(eventId: number, error: string): void {
    this.requireDb().prepare("UPDATE incoming_events SET status = 'failed', error = ? WHERE id = ?").run(error, eventId)
  }

  // No-message-loss replay. Returns events that still need to reach the main
  // agent, either because:
  //   (a) they were inserted but never handed off (coordinator crashed between
  //       insert and createHandoffMessage -> agent_message_id IS NULL), or
  //   (b) they were handed off but the message-router abandoned the agent_message
  //       after its retry window (am.status = 'failed') -- the user's message
  //       never actually reached Marveen.
  // Events whose handoff is still in-flight (am.status pending/delivered/done) are
  // NOT returned, so we never double-deliver a message that is merely waiting.
  // Idempotency against re-handoff is further guaranteed by UNIQUE(source,update_id)
  // on the source row (we re-queue a NEW agent_message, never a duplicate event).
  /* istanbul ignore next */
  getEventsNeedingHandoff(source: string, limit = 50): IncomingEventRow[] {
    return this.requireDb().prepare(`
      SELECT ie.* FROM incoming_events ie
      LEFT JOIN agent_messages am ON am.id = ie.agent_message_id
      WHERE ie.source = ?
        AND ie.status != 'failed'
        AND (
          ie.agent_message_id IS NULL
          OR am.id IS NULL
          OR am.status = 'failed'
        )
      ORDER BY ie.id ASC
      LIMIT ?
    `).all(source, limit) as IncomingEventRow[]
  }

  getOffset(source: string): number {
    const row = this.requireDb().prepare('SELECT last_update_id FROM poll_offset WHERE source = ?').get(source) as
      | { last_update_id: number }
      | undefined
    return row?.last_update_id ?? 0
  }

  // UPSERT the offset. Called ONLY after a batch is fully processed (handoff +
  // markEventDelivered for every update), so a crash before this leaves the
  // offset behind and Telegram re-delivers the batch -- at-least-once, deduped.
  setOffset(source: string, lastUpdateId: number): void {
    const now = Math.floor(Date.now() / 1000)
    this.requireDb().prepare(`
      INSERT INTO poll_offset (source, last_update_id, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(source) DO UPDATE SET last_update_id = excluded.last_update_id, updated_at = excluded.updated_at
    `).run(source, lastUpdateId, now)
  }

  // The `this.db === null` branch is unreachable through the public API:
  // closeIngestDb() short-circuits at the outer `if (ingestWorker)` check
  // when the singleton has already been nulled, so this method is only
  // ever invoked when this.db is non-null.
  close(): void {
    /* istanbul ignore next */
    if (this.db) {
      this.db.close()
      this.db = null
    }
  }
}

// Module-singleton + thin 1-line shims. The class is internal -- only the
// 9 free functions + COORDINATOR_AGENT_ID const + 2 types are exported.
// This matches the A.2a ChannelPairingStore pattern (commit 98976a9 in
// src/db.ts) and keeps the 13-site mock surface byte-identical.
let ingestWorker: IngestWorker | null = null

export const COORDINATOR_AGENT_ID = IngestWorker.COORDINATOR_AGENT_ID

export function initIngestDb(dbPath: string = join(STORE_DIR, DB_FILENAME)): Database {
  ingestWorker ??= new IngestWorker()
  return ingestWorker.init(dbPath)
}

export function closeIngestDb(): void {
  if (ingestWorker) { ingestWorker.close(); ingestWorker = null }
}

// INSERT OR IGNORE on the unique (source,update_id). Returns inserted=false when
// the update was already stored (dedup), so the caller skips re-handoff.
export function insertIncomingEvent(
  source: string,
  ev: {
    update_id: number
    kind: string
    chat_id: number | null
    user_id: number | null
    username: string | null
    message_id: number | null
    content: string
    meta: Record<string, unknown>
    tg_date: number | null
  },
): InsertResult {
  if (!ingestWorker) throw new Error('ingest db not initialized -- call initIngestDb() first')
  return ingestWorker.insertIncomingEvent(source, ev)
}

// Create the pending agent_messages row that the dashboard's message-router
// will pick up and inject into the main agent's tmux session. The router
// identity-matches COORDINATOR_AGENT_ID and delivers it as CHANNEL-INBOUND:
// the verbatim <channel ...> block (built by buildHandoffContent) plus a
// reply-expected preamble, so the main agent REPLIES to it like a native
// inbound message -- while still treating the message body as untrusted user
// data. (External callers cannot forge this id via /api/messages: a 403 guard
// rejects it; only this in-process direct DB insert is trusted.)
export function createHandoffMessage(content: string): number {
  if (!ingestWorker) throw new Error('ingest db not initialized -- call initIngestDb() first')
  return ingestWorker.createHandoffMessage(content)
}

export function markEventDelivered(eventId: number, agentMessageId: number): void {
  if (!ingestWorker) throw new Error('ingest db not initialized -- call initIngestDb() first')
  ingestWorker.markEventDelivered(eventId, agentMessageId)
}

export function markEventFailed(eventId: number, error: string): void {
  if (!ingestWorker) throw new Error('ingest db not initialized -- call initIngestDb() first')
  ingestWorker.markEventFailed(eventId, error)
}

export function /* istanbul ignore next */
  getEventsNeedingHandoff(source: string, limit = 50): IncomingEventRow[] {
  if (!ingestWorker) throw new Error('ingest db not initialized -- call initIngestDb() first')
  return ingestWorker.getEventsNeedingHandoff(source, limit)
}

export function getOffset(source: string): number {
  if (!ingestWorker) throw new Error('ingest db not initialized -- call initIngestDb() first')
  return ingestWorker.getOffset(source)
}

export function setOffset(source: string, lastUpdateId: number): void {
  if (!ingestWorker) throw new Error('ingest db not initialized -- call initIngestDb() first')
  ingestWorker.setOffset(source, lastUpdateId)
}

export interface InsertResult {
  inserted: boolean
  eventId: number | null
}

// Full incoming_events row, used by the reconcile/replay path to rebuild the
// handoff content from the stored fields.
export interface IncomingEventRow {
  id: number
  source: string
  update_id: number
  chat_id: number | null
  user_id: number | null
  username: string | null
  message_id: number | null
  kind: string
  content: string | null
  meta: string | null
  tg_date: number | null
  status: string
  agent_message_id: number | null
  error: string | null
  created_at: number
  delivered_at: number | null
}