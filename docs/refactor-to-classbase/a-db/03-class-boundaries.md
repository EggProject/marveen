# A (db) — Class boundaries

Concrete class candidates for the A subsystem. **Signatures only; no
implementation.** Every claim below cites a file:line verified against
`src/db.ts` (3308 LOC) on 2026-08-30, plus the cross-references in the
precedent reviews (H/B/E/F/D + `review-correctness.md`/`review-completeness.md`).

**Reading note.** A produces **13 new classes** — one keystone (`DbClient`)
plus 12 entity stores. Two of the 12 (`SettingsStore` db-internal,
`ChannelProviderRegistry` db-internal) are listed for the brief's
completeness but **rejected for having no source cluster in db.ts to
extract** — see §A12 and §A13 below. The remaining 10 are 1:1 migrations
of the entity clusters documented in `a-db/01-module-state-analysis.md
§1.4`. The per-store blast-radius table at the end enumerates importers
per store, addressing `review-completeness.md` CE-11.

---

## Class candidate inventory

| Class | New? | Migration source | Phase |
|---|---|---|---|
| `DbClient` | new | `let db: Database` at `db.ts:10` + `getDb()` at `db.ts:978` | A.1 |
| `MemoryStore` | new | L1061-1503 + L2429-2504 (embedding pipeline) — 26 functions per `02 §2` | A.5 |
| `KanbanCards` | new | L1627-1896 — 18 functions (cards + comments + events + archive + projects + dispatch) | A.4 |
| `MessageBus` | new | L2002-2219 — 17 functions (agent messages + threads + backlog + federated) | A.4 |
| `Scheduler` | new | L1555-1625 — 8 functions (scheduled_tasks CRUD) | A.2 |
| `BackgroundTaskPool` | new | L1492-1553 — 6 functions (atomic create + orphan marking) | A.3 |
| `ApprovalStore` | new | L3132-3237 — 5 functions (HITL gates + `expireTimedOutApprovals`) | A.2 |
| `SpanStore` | new | L3239-3307 — 4 functions (`upsertOtelSpan`, `closeOtelSpan`, `getOtelTrace`, `listOtelTraces`) | A.3 |
| `IdeaStore` | new | L2564-2681 — 8 functions (IdeaBox + comments + status log + revert) | A.2 |
| `SshVault` | new | L3031-3130 — 9 functions (VaultSshKey + VaultSshServer + `computeSshKeyStatus`) | A.3 |
| `SettingsStore` (db-internal) | **NOT built** — no source cluster | n/a | n/a (see §A12) |
| `ChannelProviderRegistry` (db-internal) | **NOT built** — no source cluster (the D subsystem already has its own ChannelProviderRegistry at `d-channel-provider/03-class-boundaries.md §D3`) | n/a | n/a (see §A13) |

**Ten classes total** land; two brief-listed candidates are rejected.
The free-function pass-through pattern matches the B.1 / E.1 / F.1
precedent: every cluster's free functions stay as `export function …` thin
wrappers that delegate to a process-wide singleton store instance, removed
only after every importer migrates (A.7 gate).

---

## A1. `DbClient`

### Source and migration

- **Source file:** `src/db.ts` (same file, alongside `let db`).
- **Migration source:** `let db: Database` at `db.ts:10` + `getDb()` at
  `db.ts:978` + `initDatabase()` at `db.ts:42`. The class absorbs the
  raw `Database` handle, exposes a narrow facade for entity stores, and
  keeps the existing `getDb()` escape hatch for the 9 production files
  that bypass the function façade today (per `01 §1.3`).

### Public surface (signatures only)

```ts
class DbClient {
  constructor(
    config: Pick<Config, 'STORE_DIR' | 'DB_FILENAME' | 'PROJECT_ROOT'>,
    log: LoggerLike,
  )

  // -- low-level SQL facade (used by entity stores internally) --
  query<T = unknown>(sql: string, params?: unknown[]): T[]
  exec(sql: string, params?: unknown[]): void
  transaction<T>(fn: () => T): T
  getHandle(): Database   // escape hatch for the 9 getDb() callers

  // -- lifecycle --
  close(): void           // closes the underlying Database handle
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `query<T>(sql, params?)` | `db.prepare(...).all(...)` | n/a (new) | Thin wrapper; the entity stores call this from inside their public methods. Returns `T[]` typed by the caller's row-interface. |
| `exec(sql, params?)` | `db.prepare(...).run(...)` | n/a (new) | Returns void; the `lastInsertRowid` is accessible via the row handle returned from `prepare` for the `INSERT` cases that need it. |
| `transaction<T>(fn)` | `db.transaction(...)` at L1505, L1823, L1932, L3062 | n/a (new) | Re-export of `bun:sqlite`'s `db.transaction`. The 4 transactional call sites today (`createBackgroundTaskAtomic`, `deleteKanbanCard`, `addLabelToCard`, `deleteVaultSshKey`) become `this.db.transaction(() => { ... })` inside the entity store methods. |
| `getHandle()` | `getDb()` | `db.ts:978` | The escape hatch for the 9 production files that today call `getDb()`. Returns the underlying `Database` instance. Status quo for these 9 files until their per-phase migration lands. |
| `close()` | n/a (new) | n/a | Closes the underlying `Database` handle. Today `db.ts:42-78` `initDatabase` closes a pre-existing handle in the re-init guard but never exposes a public `close()`; the A.7 singleton removal introduces `close()` so `App.shutdown()` can drain the handle. |

### Constructor

- `(config, log)`. The `config` parameter is the `B.1` `Config` instance
  restricted to the 3 fields A needs (`STORE_DIR`, `DB_FILENAME`,
  `PROJECT_ROOT`). `log` is the H.1 `LoggerLike`. **No I/O in the
  constructor body** — `DbClient` opens the database in a separate
  `open()` method (see below), matching the E.1 `PortLockAcquirer` /
  `B.1` `Config` precedent.
- **The constructor takes `config` and `log` for typing, but the
  underlying `Database` open happens in a separate `init()` method** —
  this matches `initDatabase()` today being called separately from
  `new DbClient(...)` (so test harnesses can construct `DbClient` early
  without a DB file existing).

[ASSUMPTION: the exact split between constructor and `init()` is a
sequencing decision; if tests prefer to construct with the DB file
already opened, the constructor can take an optional pre-opened
`Database` handle.]

### Static factory

```ts
class DbClient {
  static open(
    config: Pick<Config, 'STORE_DIR' | 'DB_FILENAME' | 'PROJECT_ROOT'>,
    log: LoggerLike,
    dbPathOverride?: string,
  ): DbClient
}
```

`DbClient.open(config, log, dbPathOverride?)` is the equivalent of
`initDatabase(dbPathOverride?)` at `db.ts:42`: it opens the
`bun:sqlite` handle, applies the PRAGMAs (WAL, cache_size, mmap_size,
synchronous=NORMAL), tightens file permissions, and runs the ~30
`runScript(db, ...)` schema migrations (L80-948) plus the legacy
`migrateTaskRunsFromJson()` (L950). Returns a fully-initialized
`DbClient`.

### Generic params

None. The `Database` type is concrete.

### Dependencies

- `Config` (B.1) for `STORE_DIR` / `DB_FILENAME` / `PROJECT_ROOT`.
- `LoggerLike` (H.1) for non-fatal init warnings (the 4 warn-level
  sites at `db.ts:30`, `:65`, `:223`, `:2443`).
- `Database` (from `src/db/sqlite.ts`).
- `tightenDbPermissions` (L25) and `runScript` — internal helpers that
  become private methods.

### Lifecycle

- **One instance per process** — constructed at boot by `App` (D.3
  keystone) and passed into every entity store via constructor injection.
- **One instance per test** — tests construct `DbClient.open({...},
  log, ':memory:')` for isolation; the existing `vi.mock('../db.js')`
  factories stay unchanged until A.7.

### Free functions that REMAIN after A.1

| Symbol | Location | Why it stays |
|---|---|---|
| `initDatabase(dbPathOverride?)` | `db.ts:42` | Thin wrapper: `DbClient.open(config, log, dbPathOverride?)`. Removed in A.7 after every importer migrates. |
| `getDb()` | `db.ts:978` | Thin wrapper: `dbClient.getHandle()`. Removed in A.7 after the 9 escape-hatch callers migrate. |
| `let db: Database` at L10 | `db.ts:10` | The module-singleton survives until A.7. |

---

## A2. `MemoryStore`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `Memory` cluster at `db.ts:1061-1503` (15
  Memory + recall functions) + embedding pipeline at L2429-2504
  (`generateEmbedding`, `hybridSearch`, `backfillEmbeddings`) +
  internal helpers `buildFtsMatchExpression` (L1096), `recencyWeightedScore`
  (L1138), `reRankByRecency` (L1150), `withoutRank` (L1164), `toBudapestTs`
  (L1410), `escapeLike` (L1426), `cosineSimilarity` (L2448), `vectorSearch`
  (L2458) + cache helpers at L1247-1274 (`memoryCacheGet`,
  `memoryCacheSet`, `memoryCacheInvalidate`, `clearMemoryCache`,
  `getMemoryCacheSize`).
- Total: **26 exported functions + 9 internal helpers** per
  `02 §2 Memory` and `01 §1.4 Memory cluster`.

### Public surface (signatures only)

```ts
class MemoryStore {
  constructor(
    private readonly db: DbClient,
    private readonly cache: TtlCache<string, Memory[]>,
    private readonly embedding: EmbeddingClient,
    private readonly log: LoggerLike,
  )

  // -- chat-scoped memory --
  saveMemory(chatId: string, content: string, sector: Memory['sector'], topicKey?: string): Memory
  searchMemories(query: string, chatId: string, limit?: number): Memory[]
  recentMemories(chatId: string, limit?: number): Memory[]
  touchMemory(id: number): void
  touchMemoriesAccessed(ids: number[]): void
  getMemoriesForChat(chatId: string, limit?: number): Memory[]

  // -- agent-scoped memory --
  saveAgentMemory(agentId: string, content: string, category: string, keywords?: string, autoGenerated?: boolean): Memory
  getAgentMemories(agentId: string, limit?: number, category?: string): Memory[]
  searchAgentMemories(agentId: string, query: string, limit?: number): Memory[]
  getMemoryStats(): { total: number; byAgent: Record<string, number>; byTier: Record<string, number>; withEmbedding: number }
  updateMemory(id: number, content: string, category?: string, agentId?: string, keywords?: string): boolean

  // -- recall --
  recallByDateRange(from: string, to: string, agentId?: string): RecallResult
  recallSearch(query: string, agentId?: string, limit?: number): RecallResult

  // -- daily log --
  appendDailyLog(agentId: string, content: string): void
  getDailyLog(agentId: string, date: string): { id: number; content: string; created_at: number }[]
  getDailyLogDates(agentId: string, limit?: number): string[]

  // -- decay sweep (cross-entity — also called by runDecaySweep) --
  decay(): void   // replaces decayMemories() at L1213; per AR3 below

  // -- embedding pipeline --
  generateEmbedding(text: string): Promise<number[] | null>   // forwards to this.embedding.generate()
  hybridSearch(agentId: string, query: string, limit?: number): Promise<Memory[]>
  backfillEmbeddings(): Promise<number>

  // -- cache management --
  clearCache(): void   // replaces clearMemoryCache() at L1267
  cacheSize(): number  // replaces getMemoryCacheSize() at L1272

  // -- error class (per CE-4 §A.8) --
  search(query: string, agentId: string, limit?: number): Memory[]   // throws MemoryStoreError on FTS5 parse failure (replaces silent return at L1182-1184)
}
```

### Constructor

- `(db, cache, embedding, log)`. The `db` is `DbClient` (A.1). The `cache`
  is the shared `TtlCache<string, Memory[]>` utility (per CE-9 / A.9).
  The `embedding` is `EmbeddingClient` (the per-OE-10 separate class;
  see A.5.1 below). The `log` is `LoggerLike` for the embedding-failure
  warning at `db.ts:2443` and the cache-hit/miss debug (new addition
  per `02 §8`).
- **No I/O in the constructor.** The class is a thin wrapper; all DB
  IO happens in method bodies.

### Generic params

None. `Memory[]` is the value type for the cache.

### Dependencies

- `DbClient` (A.1).
- `TtlCache<string, Memory[]>` (A.9) — replaces `db.ts:1238-1274`.
- `EmbeddingClient` (A.5.1) — separates the embedding pipeline.
- `LoggerLike` (H.1) — the only A store that needs a logger per
  `02 §8`.
- The shared `RECENCY_LAMBDA` / `RECENCY_TAU_SEC` constants stay
  module-level inside `db.ts` (per OE-10: making them constructor opts
  is a regression — they're tunable via const today).

### Lifecycle

- **One instance per process**, constructed by `App` at boot and passed
  to `HeartbeatScheduler` (F.1) and `ContextGuardRunner` (B.5).

### Free functions that REMAIN after A.5

| Symbol | Location | Why it stays |
|---|---|---|
| All 26 exported memory + recall + embedding functions | `db.ts:1061-1503`, L2429-2504 | Thin pass-through wrappers that delegate to `memoryStore.<method>(...)`. Removed in A.7. |
| `clearMemoryCache()` at L1267 | `db.ts:1267` | Thin wrapper: `memoryStore.clearCache()`. Removed in A.7. |
| `getMemoryCacheSize()` at L1272 | `db.ts:1272` | Thin wrapper: `memoryStore.cacheSize()`. Removed in A.7. |
| `MemoryCacheEntry` interface at L1240 | `db.ts:1240` | Becomes a private type alias for the cache value. Re-exported as `MemoryCacheEntry = { value: Memory[]; expiresAt: number }` for the 0 external consumers (only the internal `memoryCacheGet`/`memoryCacheSet` helpers read it). Removed in A.7. |

### A5.1 `EmbeddingClient` (per OE-10)

- **Source file:** `src/db/embedding-client.ts` [ASSUMPTION: new file].
- **Migration source:** `generateEmbedding` at `db.ts:2429`, the
  `OLLAMA_URL` config import at `db.ts:5`, and the inner HTTP fetch
  at `db.ts:2437-2469`.
- **Public surface:**
  ```ts
  class EmbeddingClient {
    constructor(opts: { url: string; log: LoggerLike })

    generate(text: string): Promise<number[] | null>
    cosineSimilarity(a: number[], b: number[]): number
  }
  ```
- **Rationale (OE-10):** `MemoryStore` should NOT take `embeddingModel`
  in its constructor; the embedding pipeline is a separate concern
  (separate HTTP client, separate SDK, separate error path at L2467).
  If the model changes (e.g., OpenAI → local embed), only
  `EmbeddingClient` is reconstructed.
- **Dependencies:** `LoggerLike` (H.1) for the failure-warning at
  `db.ts:2443`; `fetch` (global) for the Ollama HTTP call at L2437-2469.

---

## A3. `KanbanCards`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `KanbanCard` cluster at L1627-1896 (18 functions
  per `01 §1.4`): `listKanbanCards`, `listKanbanCardsSummary`,
  `getKanbanCard`, `createKanbanCard`, `updateKanbanCard`, `getChildCards`,
  `moveKanbanCard`, `markKanbanCardDispatched`, `archiveKanbanCard`,
  `unarchiveKanbanCard`, `listArchivedKanbanCards`, `listKanbanProjects`,
  `deleteKanbanCard`, `getKanbanComments`, `addKanbanComment`,
  `getKanbanCardEvents`, `getKanbanSeqByIdPrefix`,
  `findActiveKanbanCardByTitle`, `markScheduledTaskKanbanWaiting`.
- Related entities: `Label` (L1897-1979, 8 functions) — the brief
  classifies Labels as `KanbanCards`-owned per `01 §4`. Total: 26
  functions (18 cards + 8 labels).

### Public surface (signatures only)

```ts
class KanbanCards {
  constructor(private readonly db: DbClient)

  // -- cards --
  list(): KanbanCard[]
  listSummary(): { status: string; title: string; assignee: string | null; priority: KanbanCard['priority']; id: string }[]
  get(id: string): KanbanCard | undefined
  create(card: Omit<KanbanCard, 'created_at' | 'updated_at' | 'archived_at' | 'dispatched_at' | 'seq'>): KanbanCard
  update(id: string, fields: Partial<Omit<KanbanCard, 'id' | 'created_at'>>): boolean
  getChildCards(parentId: string): KanbanCard[]
  move(id: string, status: KanbanCard['status'], sortOrder: number, actor?: string): boolean
  markDispatched(id: string): boolean
  archive(id: string): boolean
  unarchive(id: string): boolean
  listArchived(opts: { project?: string; limit?: number; offset?: number }): ArchivedKanbanCard[]
  listProjects(): string[]
  delete(id: string): boolean   // transactional (L1809)
  findActiveByTitle(title: string): KanbanCard | undefined
  getSeqByIdPrefix(prefix: string): number | null

  // -- comments --
  getComments(cardId: string): KanbanComment[]
  addComment(cardId: string, author: string, content: string): KanbanComment

  // -- events --
  getEvents(cardId: string): KanbanCardEvent[]

  // -- cross-store hook --
  markScheduledTaskWaiting(taskName: string): string | null   // writes to kanban_cards from Scheduler.fire()

  // -- heartbeat summary (cross-store, but lives here) --
  getHeartbeatSummary(): HeartbeatKanbanSummary

  // -- labels (KanbanCards-owned per 01 §4) --
  listLabels(): Label[]
  getLabel(id: string): Label | undefined
  createLabel(label: { id: string; name: string; color: string }): Label
  updateLabel(id: string, fields: Partial<Pick<Label, 'name' | 'color'>>): boolean
  deleteLabel(id: string): boolean
  addLabelToCard(cardId: string, labelId: string): void
  removeLabelFromCard(cardId: string, labelId: string): boolean
  getLabelsForCard(cardId: string): Label[]
  getLabelsForAllCards(): Map<string, Label[]>
}
```

### Constructor

- `(db)`. Just `DbClient`. No logger needed (per `02 §8` — no non-fatal
  degradation paths in KanbanCard today).

### Generic params

None.

### Dependencies

- `DbClient` (A.1) for the SQL facade.
- `Scheduler` (A.2) — `markScheduledTaskWaiting` writes a `KanbanCard`
  from a `Scheduler.fire()` cross-store call. Constructor takes
  `Scheduler` as a second arg OR is wired by `App` via late-binding;
  per `02 §2 ScheduledTask cross-write` the second option is preferred
  (avoids cycle).

### Lifecycle

- **One instance per process**, constructed by `App` and passed to
  `web/routes/kanban.ts` via `RouteContext`.

### Free functions that REMAIN after A.4

All 26 KanbanCard + Label free functions survive as thin pass-through
wrappers. Removed in A.7.

---

## A4. `MessageBus`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `AgentMessage` cluster at L2002-2219 + task-run
  helpers at L2266-2313 (17 functions per `01 §1.4`).

### Public surface (signatures only, per M7 + brief)

```ts
class MessageBus {
  constructor(private readonly db: DbClient)

  // -- creation --
  create(from: string, to: string, content: string, originNote?: string, traceCtx?: TraceContext): AgentMessage

  // -- inbox reads --
  getPending(toAgent?: string): AgentMessage[]    // was getPendingMessages (L2044)
  getPendingBacklogByAgent(): AgentBacklog[]      // L2071 — no agentId arg, returns array
  claimPendingForAgent(toAgent: string, limit: number): AgentMessage[]   // L2150

  // -- transitions (status-guarded) --
  markDelivered(id: number): boolean              // was markMessageDelivered (L2058), status-guarded 'pending'->'delivered'
  markDone(id: number, result?: string): boolean  // L2167
  markFailed(id: number, error?: string): boolean // L2175
  markPendingFederatedFailed(id: number, error: string): boolean   // L2187

  // -- result-setting (no status change) --
  setResult(id: number, result: string): boolean  // was setMessageResult (L2112)

  // -- bulk operations --
  closeWithoutDelivery(ids: number[], reason: string): number              // was closeMessagesWithoutDelivery (L2093)
  failPendingFederated(peerId: string | undefined, reason: string): number[]  // was failPendingFederatedMessages (L2126)

  // -- reads --
  list(limit?: number): AgentMessage[]             // was listAgentMessages (L2192)
  getConversation(agent: string, limit?: number, beforeId?: number): AgentMessage[]   // L2209
  getThreads(): AgentThread[]                       // was getAgentConversationThreads (L2232)
  get(id: number): AgentMessage | undefined         // was getAgentMessage (L2309)

  // -- trace stamping (cross-entity with SpanStore) --
  stampTrace(id: number, traceId: string, spanId: string, parentSpanId: string | null): boolean   // was stampMessageTrace (L3216)
}
```

### Constructor

- `(db)`. No logger (per `02 §8` — AgentMessageStore has potential
  status-guarded-update warnings but those are debug-level; the route
  handlers log today, no new logger sites).

### Generic params

None.

### Dependencies

- `DbClient` (A.1).
- `SpanStore` (A.3) — `stampTrace` writes to `agent_messages` from the
  OTel tracing context. Constructor takes `SpanStore` as a second arg
  OR is wired by `App` via late-binding. **Note:** the source function
  `stampMessageTrace` at L3216 lives in the `agent_messages` cluster
  semantically but the line number is in the OtelSpan section; the
  class migration keeps it on `MessageBus`.

### Lifecycle

- **One instance per process**, constructed by `App` and passed to
  `web/routes/agents.ts`, `web/routes/messages.ts`,
  `web/federation/bridge.ts` (type-only), `web/message-router.ts`,
  `web/context-guard-runner.ts`, `web/federation/`.

### Free functions that REMAIN after A.4

All 17 MessageBus free functions survive as thin pass-through
wrappers. The M7-corrected signatures (per `review-correctness.md M7`)
must be byte-identical to the source functions above. Removed in A.7.

---

## A5. `Scheduler`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `ScheduledTask` cluster at L1555-1625 (8
  functions per `01 §1.4`).

### Public surface (signatures only)

```ts
class Scheduler {
  constructor(private readonly db: DbClient, private readonly tasks: BackgroundTaskPool)

  create(id: string, chatId: string, prompt: string, schedule: string, nextRun: number): void
  getDue(now?: number): ScheduledTask[]                  // was getDueTasks (L1579)
  updateAfterRun(id: string, nextRun: number, result: string): void
  list(): ScheduledTask[]
  get(id: string): ScheduledTask | undefined
  update(id: string, prompt: string, schedule: string, nextRun: number): boolean
  delete(id: string): boolean
  pause(id: string): boolean
  resume(id: string): boolean
  getActiveCount(): { count: number; nextRun: number | null }   // was getActiveScheduledTaskCount (L2313)
}
```

### Constructor

- `(db, tasks)`. The `tasks` is `BackgroundTaskPool` (A.3) — a fired
  scheduled task creates a `BackgroundTask` row in the sibling store
  (per `02 §2 ScheduledTask cross-write`).

### Generic params

None.

### Dependencies

- `DbClient` (A.1).
- `BackgroundTaskPool` (A.3) — sibling write on fire.

### Lifecycle

- One instance per process.

### Free functions that REMAIN

8 ScheduledTask free functions survive. Removed in A.7.

---

## A6. `BackgroundTaskPool`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `BackgroundTask` cluster at L1492-1553
  (6 functions per `01 §1.4`).

### Public surface (signatures only)

```ts
class BackgroundTaskPool {
  constructor(private readonly db: DbClient)

  createAtomic(id: string, agentId: string, prompt: string, tmuxSession: string, maxConcurrent: number): BackgroundTask | null   // transactional count guard (L1503)
  getRunning(): BackgroundTask[]
  finish(id: string, status: 'done' | 'failed' | 'timeout', output: string | null): void
  getTasks(agentId?: string, includeFinished?: boolean): BackgroundTask[]
  get(id: string): BackgroundTask | undefined
  countRunning(agentId: string): number
  markOrphanedFailed(): number
}
```

### Constructor

- `(db)`. No logger.

### Generic params

None.

### Dependencies

- `DbClient` (A.1).

### Lifecycle

- One instance per process.

---

## A7. `ApprovalStore`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `Approval` cluster at L3132-3237 (5 functions
  per `01 §1.4`: `createApproval`, `getApproval`, `resolveApproval`,
  `listApprovals`, `expireTimedOutApprovals`).

### Public surface (signatures only)

```ts
class ApprovalStore {
  constructor(private readonly db: DbClient)

  create(params: {
    agentId: string; category: string; actionDescription: string;
    actionPayload: string; timeoutAt: number; telegramMessageId?: number | null;
  }): Approval
  get(id: string): Approval | undefined
  resolve(id: string, status: 'approved' | 'rejected' | 'timeout', resolvedBy: string, telegramMessageId?: number | null): boolean   // status-guarded
  list(opts: { status?: Approval['status']; agentId?: string; limit?: number; offset?: number }): Approval[]
  expireTimedOut(): number   // sweep target
}
```

### Constructor

- `(db)`. No logger (no non-fatal paths in ApprovalStore).

### Generic params

None.

### Dependencies

- `DbClient` (A.1).

### Lifecycle

- One instance per process.

---

## A8. `SpanStore`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `OtelSpan` cluster at L3239-3307 (4 functions
  per `01 §1.4`).

### Public surface (signatures only)

```ts
class SpanStore {
  constructor(private readonly db: DbClient)

  upsert(span: Omit<OtelSpan, 'end_ms' | 'status'> & { end_ms?: number | null; status?: OtelSpan['status'] }): void   // INSERT...ON CONFLICT DO UPDATE (L3251)
  close(traceId: string, spanId: string, endMs: number, status: OtelSpan['status']): boolean   // L3266
  getTrace(traceId: string): OtelSpan[]    // was getOtelTrace (L3272)
  listTraces(limit?: number): OtelTraceSummary[]   // was listOtelTraces (L3287)
}
```

### Constructor

- `(db)`. No logger.

### Generic params

None.

### Dependencies

- `DbClient` (A.1).

### Lifecycle

- One instance per process.

---

## A9. `IdeaStore`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `IdeaBoxRow` cluster at L2564-2681
  (10 functions per `01 §1.4`; brief lists 8 — the discrepancy is
  `getIdeaComments` and `addIdeaComment` which are comment-cluster
  functions; both belong to `IdeaStore`).

### Public surface (signatures only)

```ts
class IdeaStore {
  constructor(private readonly db: DbClient, private readonly cards: KanbanCards)   // cross-store: revertIdeaFromKanban writes kanban_id

  list(opts?: { status?: string; category?: string }): IdeaBoxRow[]
  create(idea: Omit<IdeaBoxRow, 'created_at' | 'updated_at'>): void
  update(id: string, patch: Partial<Pick<IdeaBoxRow, 'title' | 'description' | 'category' | 'status' | 'kanban_id' | 'impact' | 'effort'>>): boolean
  delete(id: string): boolean
  listCategories(): string[]
  getComments(ideaId: string): IdeaComment[]
  addComment(ideaId: string, author: string, content: string): IdeaComment
  logStatusChange(ideaId: string, fromStatus: string, toStatus: string, actor: string, note?: string): void
  getStatusLog(ideaId: string): IdeaStatusLogRow[]
  revertFromKanban(kanbanId: string): string | null   // cross-store: writes to idea_box.status AND idea_status_log
}
```

### Constructor

- `(db, cards)`. The `cards` is `KanbanCards` (A.3) — `revertFromKanban`
  joins via `kanban_id` (per `01 §4` cross-store hook).

### Generic params

None.

### Dependencies

- `DbClient` (A.1).
- `KanbanCards` (A.3) — for `revertFromKanban`.

### Lifecycle

- One instance per process.

---

## A10. `SshVault`

### Source and migration

- **Source file:** `src/db.ts`.
- **Migration source:** `VaultSshKey` cluster at L3031-3074 +
  `VaultSshServer` cluster at L3077-3130 + `computeSshKeyStatus` at
  L3091 (9 functions per `01 §1.4`).

### Public surface (signatures only)

```ts
class SshVault {
  constructor(private readonly db: DbClient)

  // -- keys --
  listKeys(): VaultSshKey[]
  getKey(id: string): VaultSshKey | undefined
  createKey(key: Pick<VaultSshKey, 'id' | 'label' | 'username' | 'vault_key_id' | 'public_key' | 'fingerprint' | 'key_type'>): VaultSshKey
  deleteKey(id: string): { deleted: boolean; unassigned: number }   // transactional + side-effect (L3061)

  // -- servers --
  listServers(): VaultSshServer[]
  getServer(id: string): VaultSshServer | undefined
  createServer(server: Pick<VaultSshServer, 'id' | 'name' | 'host' | 'port' | 'username' | 'description'>): VaultSshServer
  updateServer(id: string, patch: Partial<Pick<VaultSshServer, 'name' | 'host' | 'port' | 'username' | 'ssh_key_id' | 'description'>>): boolean
  deleteServer(id: string): boolean
  computeKeyStatus(server: VaultSshServer): SshKeyStatus   // derived (L3091); class refactor makes this a getter on VaultSshServer
}
```

### Constructor

- `(db)`. No logger.

### Generic params

None.

### Dependencies

- `DbClient` (A.1).

### Lifecycle

- One instance per process.

---

## A11. (Cross-entity) `MaintenanceOps`

### Source and migration

- **Source file:** `src/db.ts` + `src/memory.ts`.
- **Migration source:** `runDecaySweep()` at `memory.ts:155-160` (cross-entity
  aggregator) + `pruneAuditLogs()` at `db.ts:3006` + `pruneTokenUsage()`
  at `db.ts:3018` + `markOrphanedTasksFailed()` at `db.ts:1546` +
  `expireTimedOutApprovals()` at `db.ts:3229` + `pruneToolCallLog()` at
  `db.ts:2764`.

### Public surface (signatures only)

```ts
class MaintenanceOps {
  constructor(
    private readonly memory: MemoryStore,
    private readonly auditLog: AuditLog,
    private readonly tokenUsage: TokenUsagePruner,
    private readonly backgroundTasks: BackgroundTaskPool,
    private readonly approvals: ApprovalStore,
    private readonly toolLog: ToolLog,
  )

  // -- the cross-entity sweep --
  runDecaySweep(): { tokensPruned: number }   // orchestrates memory.decay + auditLog.prune + tokenUsage.prune

  // -- orphan/expired sweeps --
  markOrphanedTasksFailed(): number            // delegates to backgroundTasks
  expireTimedOutApprovals(): number            // delegates to approvals
  pruneToolCallLog(olderThanSecs?: number): void   // delegates to toolLog
}
```

### Constructor

- Takes the 6 dependent stores. The single-direction dependency chain
  is `MaintenanceOps → {memory, auditLog, tokenUsage, backgroundTasks,
  approvals, toolLog} → db`; no cycles.

### Decision: separate class vs. on MemoryStore

Per AR8 below, the cross-entity sweeps could live on `MemoryStore`
(the decay sweep is conceptually "memory hygiene") OR on a separate
`MaintenanceOps` class. **Decision: separate class** because:
1. `runDecaySweep` touches THREE stores (MemoryStore, AuditLog,
   TokenUsagePruner) — MemoryStore alone cannot orchestrate this.
2. The other sweeps (`markOrphanedTasksFailed`, `expireTimedOutApprovals`,
   `pruneToolCallLog`) are independent of memory; they are pure
   per-table maintenance.
3. A separate `MaintenanceOps` class makes the construction order
   explicit at `App` boot (per CE-8 construction-order table).

### Free functions that REMAIN after A.6

`runDecaySweep` at `memory.ts:155` survives as a thin pass-through
wrapper that delegates to `maintenanceOps.runDecaySweep()`. Removed in
A.7 only if every caller (`src/index.ts:15`, `:451`; `src/heartbeat.ts:509-512`)
migrates to `App.maintenanceOps.runDecaySweep()`.

---

## A12. `SettingsStore` (db-internal) — **NOT BUILT**

### Decision

Per `02-type-interface-analysis.md §2`, `src/db.ts` has **no
settings-related functions**. The `SettingsStore` (db-internal) class
candidate listed in the brief has **no source cluster to extract** —
db.ts does not export any `settings*` or `*Setting*` functions.

### What this means

- The brief's mention of `SettingsStore (db-internal): wraps the ~5
  settings-store-related db.ts functions` is a **planning-time error**.
  Per `01 §1.4`, db.ts has 18 entity clusters; none is "settings".
  The `settings-store.ts` file at `src/settings-store.ts:15-17` is
  a separate F subsystem (per `f-agent-subsystem/00-summary.md §F.4`),
  not a db.ts cluster.
- **No class is built.** The brief's slot for `SettingsStore` (db-internal)
  is replaced with no-op.

---

## A13. `ChannelProviderRegistry` (db-internal) — **NOT BUILT**

### Decision

`src/db.ts` has **no channel-provider-registry-related functions**.
The `ChannelProviderRegistry` class at `src/channel-provider.ts` is a
D-subsystem class (per `d-channel-provider/03-class-boundaries.md §D3`).
The brief's mention of a separate "db-internal" `ChannelProviderRegistry`
that wraps "the ~3 channel-provider-registry db.ts functions" is
**factually incorrect** — db.ts has no `upsertChannelProvider` or similar.

Per `01 §1.4`, the only channel-related cluster in db.ts is
`Channel requests (pairing)` at L2522-2562 (4 functions:
`upsertChannelRequest`, `listPendingChannelRequests`,
`updateChannelRequestStatus`, `updateChannelRequestName`). These
belong in a new **`ChannelPairingStore`** class, NOT in a
`ChannelProviderRegistry` (which lives in `src/channel-provider.ts`).

### What this means

- The brief's slot for `ChannelProviderRegistry` (db-internal) is
  replaced with **`ChannelPairingStore`** — a new class wrapping the
  4 channel-request functions at L2522-2562.
- **`ChannelPairingStore`** has the public surface:
  ```ts
  class ChannelPairingStore {
    constructor(private readonly db: DbClient)
    upsertRequest(agent: string, channelId: string, userId?: string): boolean
    listPending(agent: string): PendingChannelRequest[]
    updateStatus(id: number, status: 'approved' | 'denied'): boolean
    updateName(id: number, channelName: string): void
  }
  ```
- Phase: A.2 (small leaf store, ~4 functions, low blast radius).

---

## Per-store blast-radius table (per CE-11)

The table below lists each store's consumer files. Numbers are
approximate (`grep -rE "<symbol-name>" src/` would yield exact counts;
the brief is "every consumer file" — not every symbol import).

| Store | Direct importers (production) | Test files |
|---|---|---|
| `DbClient` (A.1) | All 14 narrow importers of `db.ts` + 25 routes + 1 script = 39 (per `01 §3`); also indirectly consumed by every entity store via constructor | 50 `vi.mock('../db.js')` files (per `01 §6`) |
| `MemoryStore` (A.5) | `src/memory.ts:14` (type-only `Memory`); `src/heartbeat.ts:504-511` (`runDecaySweep` call); `src/web/routes/memories.ts`; `src/web/routes/recall.ts`; `src/web/routes/daily-log.ts` | `memory.test.ts`, `routes-recall.test.ts`, `routes-daily-log.test.ts`, `memories-routes.test.ts` |
| `KanbanCards` (A.4) | `src/web/routes/kanban.ts` (~15 symbols); `src/web/routes/agents.ts`; `src/web/routes/heartbeat` (via `getHeartbeatKanbanSummary`); `src/web/schedule-runner.ts` (via `markScheduledTaskKanbanWaiting`) | `kanban-routes.test.ts`, `agents-routes.test.ts`, `schedule-runner-full.test.ts` |
| `MessageBus` (A.4) | `src/web/routes/agents.ts` (5 symbols); `src/web/routes/messages.ts`; `src/web/message-router.ts`; `src/web/context-guard-runner.ts`; `src/web/federation/` (`bridge.ts:24` type-only); `src/web/channel-request-watcher.ts` | `agents-routes.test.ts`, `message-router-tick-cap.test.ts`, `message-router-full.test.ts`, `context-guard-runner.test.ts` |
| `Scheduler` (A.2) | `src/web/schedule-runner.ts`; `src/web/routes/schedules.ts` | `routes-schedules.test.ts`, `schedule-runner-full.test.ts` |
| `BackgroundTaskPool` (A.3) | `src/agent.ts` (lifecycle); `src/web/routes/background-tasks.ts` | `background-tasks-routes.test.ts` |
| `ApprovalStore` (A.2) | `src/web/routes/approvals.ts`; `src/web/telegram` (HITL gate) | `routes-approvals-full.test.ts` |
| `SpanStore` (A.3) | `src/web/routes/spans.ts`; `src/web/mcp-list.ts` (lazy cache consumer per `f-agent-subsystem/02`); `src/agent.ts` (per CE-15 trace logging) | `spans-routes.test.ts` |
| `IdeaStore` (A.2) | `src/web/routes/ideas.ts` (11 symbols); `src/web/routes/kanban.ts` (cross-store via `revertFromKanban`) | `ideas-routes.test.ts` |
| `SshVault` (A.3) | `src/web/routes/vault-ssh.ts`; `src/web/routes/vault-ssh-keys.ts` | `routes-vault-ssh.test.ts`, `routes-vault-ssh-keys.test.ts` |
| `ChannelPairingStore` (A.2, replacing the rejected db-internal `ChannelProviderRegistry`) | `src/web/channel-request-watcher.ts`; `src/web/routes/agents.ts` | `channel-request-watcher.test.ts` |
| `MaintenanceOps` (A.6) | `src/index.ts:15`, `:451` (`setInterval(runDecaySweep, ...)`); `src/heartbeat.ts:509-512` (opportunistic call); `src/web/routes/approvals.ts:57` (via `expireTimedOutApprovals`); `src/web/routes/tool-log.ts:62` (via `pruneToolCallLog`) | `index.test.ts`, `heartbeat.test.ts`, `heartbeat-cov.test.ts`, `tool-log-routes.test.ts` |

### Notes on the blast radius

- **The 9 production files calling `getDb()` directly** (per `01 §1.3`):
  `auth-sessions.ts`, `token-usage.ts`, `auth-device-keys.ts`,
  `fleet-transfer.ts`, `routes/costs.ts`, `routes/overview.ts`,
  `routes/ideas.ts`, `routes/agents.ts`, `scripts/dashboard-user.ts`.
  These keep `getDb()` as the escape hatch until A.7; the
  `DbClient.getHandle()` method preserves the access.
- **The 14 narrow importers of `db.ts`** (per `01 §3` grep) include
  4 top-level (`heartbeat.ts`, `index.ts`, `memory.ts`,
  `store-watcher.ts`) + 10 `web/` (`auth-device-keys.ts`,
  `auth-sessions.ts`, `channel-request-watcher.ts`,
  `context-guard-runner.ts`, `fleet-transfer.ts`,
  `inbox-nudge-watcher.ts`, `message-router.ts`, `schedule-runner.ts`,
  `security-reset.ts`, `token-usage.ts`). The remaining 25 files
  importing `db.js` are in `web/routes/` and `scripts/` (per `01 §3`).
- **Cross-store dependencies** (must be wired at App boot, not in
  constructors to avoid cycles):
  - `MemoryStore` ← `DbClient`
  - `KanbanCards` ← `DbClient`
  - `MessageBus` ← `DbClient`, `SpanStore` (for `stampTrace`)
  - `Scheduler` ← `DbClient`, `BackgroundTaskPool` (for `createAtomic`)
  - `BackgroundTaskPool` ← `DbClient`
  - `ApprovalStore` ← `DbClient`
  - `SpanStore` ← `DbClient`
  - `IdeaStore` ← `DbClient`, `KanbanCards` (for `revertFromKanban`)
  - `SshVault` ← `DbClient`
  - `ChannelPairingStore` ← `DbClient`
  - `MaintenanceOps` ← `MemoryStore`, `AuditLog`, `TokenUsagePruner`,
    `BackgroundTaskPool`, `ApprovalStore`, `ToolLog`

**No cycles** in the dependency graph (per AR3 below).

---

## Summary of free functions vs class surface after A.7

| Symbol | After A.7 | Notes |
|---|---|---|
| 13 classes (A.1, A.2, A.4, A.5, A.6, A.7, A.8, A.9, A.10, A.11, plus `SettingsStore` (db-internal) and `ChannelProviderRegistry` (db-internal) REJECTED, replaced by `ChannelPairingStore`) | **new** | Per the per-class §s above |
| All 158 exported free functions | **removed in A.7** | After every importer migrates to the class API |
| `let db: Database` at `db.ts:10` | **removed in A.7** | After every importer migrates |
| `initDatabase` at `db.ts:42` | thin wrapper, removed in A.7 | |
| `getDb()` at `db.ts:978` | thin wrapper, removed in A.7 | |
| `memoryCache` Map at `db.ts:1245` | moves into `MemoryStore` constructor; replaced by `TtlCache<K, V>` (A.9) | |
| `MemoryCacheEntry` interface at `db.ts:1240` | private type on `TtlCache`; no external surface | |
| `runDecaySweep` at `memory.ts:155` | thin wrapper: `maintenanceOps.runDecaySweep()`; removed in A.7 | |

---

**End of A class-boundaries plan. No source files modified.**
