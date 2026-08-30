# A Subsystem: Module State and Structure Analysis

**Source file:** `src/db.ts`
**LOC:** 3308 (verified via `wc -l`, NOT ~3900 as framework estimate)
**Exported functions:** 158 (verified via `grep -nE "^export (async )?function"`, NOT 155 as framework M3 estimate)
**Exported interfaces/types:** 37 (matches B-B count)
**Non-exported helpers:** 10 (verified)

---

## Brief Summary

The A subsystem is a single 3308-LOC module (`src/db.ts`) that wraps a `bun:sqlite` Database singleton with 158 free functions across 11 logical entity clusters and 37 exported type contracts. The whole module is procedural — every function closes over the module-level `let db: Database` singleton at line 10 — with no class encapsulation, no constructor injection, and no provider interface. Initialization happens through one `initDatabase()` entrypoint (line 42) that performs idempotent schema migration; thereafter all functions call `db.prepare(...).run/.all/.get(...)` directly. The only intra-module mutable state outside the DB handle is the per-agent TTL `memoryCache` Map at line 1245, which is tightly coupled to the MemoryStore cluster. 39 production files import from this module, with 23 of those being HTTP route handlers under `src/web/routes/`. The cross-call surface between A and `src/memory.ts` (CE-8) is the only non-trivial inter-module coupling: `memory.ts` calls `decayMemories`, `pruneAuditLogs`, and `pruneTokenUsage` inside its `runDecaySweep()` aggregator.

---

## 1. db.ts Inventory

### 1.1 Module-Level Mutable State

```ts
// src/db.ts:10
let db: Database
```

A single module-level binding typed as `Database` (the `bun:sqlite` handle re-exported from `./db/sqlite.js`). Every exported function dereferences `db` directly — there is **no accessor abstraction beyond `getDb()`** and **no per-entity store object**. Re-exporting `getDb` (line 978) gives callers an escape hatch but the internal functions never use it.

**Other module-level mutable state:**

| Variable | Line | Scope | Notes |
| --- | --- | --- | --- |
| `db` | 10 | module singleton | the only handle to the open sqlite DB |
| `memoryCache` | 1245 | module Map | `Map<string, MemoryCacheEntry>`, TTL=60s, per-agent+limit+category key, Memory entity only |
| `RUN_TABLE` (etc.) | various | migration-only | computed inside `migrateTaskRunsFromJson` (line 950), no leaked module state |

### 1.2 Initialization Flow: `initDatabase`

```ts
// src/db.ts:42
export function initDatabase(dbPathOverride?: string): void
```

Flow (lines 42-78):
1. Idempotent re-init guard: closes any pre-existing `db` handle (line 49-51) before opening a new one, so repeated calls (tests, hot-reload) don't leak the old sqlite fd.
2. Resolves the DB path from `STORE_DIR/DB_FILENAME` (config-driven) or accepts a `dbPathOverride` for tests. `:memory:` skip path for the chmod + mmap pragmas.
3. Pre-creates the file via `openSync('wx', 0o600)` to close the TOCTOU window on fresh installs (lines 57-68).
4. Opens the DB with `new Database(dbPath, { strict: true })` (line 69).
5. Applies PRAGMAs: `journal_mode=WAL`, `cache_size=-65536`, `mmap_size=268435456` (skipped for `:memory:`), `synchronous=NORMAL`.
6. Calls `tightenDbPermissions()` to chmod sidecars (WAL/SHM/journal) to 0o600.
7. Runs ~30 `runScript(db, ...)` calls (lines 80-970) that issue idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` statements. Includes one try/catch `ALTER TABLE` migration for the `sessions.message_count` column (lines 90-94).
8. One legacy migration `migrateTaskRunsFromJson()` (line 950) runs at the tail to backfill from JSON file storage if a legacy data dir is present.

**Caller of `initDatabase`:** `src/index.ts:14` (production boot). Tests call it via `vi.hoisted` wrappers (e.g. `kanban-routes.test.ts` does NOT mock initDatabase; it relies on the harness to skip boot).

### 1.3 Accessor: `getDb`

```ts
// src/db.ts:978
export function getDb(): Database
```

Returns the singleton handle. Used by **9 production files** (verified via `grep -lE "getDb\(\)"` over importers): `auth-sessions.ts`, `token-usage.ts`, `auth-device-keys.ts`, `fleet-transfer.ts`, `routes/costs.ts`, `routes/overview.ts`, `routes/ideas.ts`, `routes/agents.ts`, `scripts/dashboard-user.ts`. These are the only files that reach past the function façade and use the raw DB API directly (typically for `db.transaction(...)` or `db.prepare(...)` ad-hoc queries).

### 1.4 Free Function Distribution by Entity Cluster (158 total)

| Cluster | Count | Line Range | Sample Anchors |
| --- | --- | --- | --- |
| Sessions | 5 | 984-1008 | `getSession`, `setSession`, `incrementSessionCount`, `clearSession` |
| Dashboard users | 6 | 1010-1059 | `createDashboardUser`, `getDashboardUser`, `listDashboardUsers`, `updateDashboardUserPassword`, `deleteDashboardUser` |
| Memory (incl. cache + embedding) | 26 | 1061-1503 | `saveMemory`, `searchMemories`, `recentMemories`, `touchMemory`, `touchMemoriesAccessed`, `decayMemories`, `getMemoriesForChat`, `saveAgentMemory`, `getAgentMemories`, `searchAgentMemories`, `getMemoryStats`, `updateMemory`, `appendDailyLog`, `getDailyLog`, `getDailyLogDates`, `recallByDateRange`, `recallSearch`, `buildFtsMatchExpression`, `recencyWeightedScore`, `reRankByRecency`, `generateEmbedding`, `hybridSearch`, `backfillEmbeddings` |
| Background tasks | 6 | 1492-1553 | `createBackgroundTaskAtomic`, `getRunningBackgroundTasks`, `finishBackgroundTask`, `getBackgroundTasks`, `getBackgroundTask`, `countRunningBackgroundTasks`, `markOrphanedTasksFailed` |
| Scheduled tasks | 7 | 1555-1625 | `createTask`, `getDueTasks`, `updateTaskAfterRun`, `listTasks`, `deleteTask`, `pauseTask`, `resumeTask`, `getTask`, `updateTask` |
| Kanban (cards + comments + events) | 18 | 1627-1896 | `listKanbanCards`, `listKanbanCardsSummary`, `getKanbanCard`, `createKanbanCard`, `updateKanbanCard`, `getChildCards`, `moveKanbanCard`, `markKanbanCardDispatched`, `archiveKanbanCard`, `unarchiveKanbanCard`, `listArchivedKanbanCards`, `listKanbanProjects`, `deleteKanbanCard`, `getKanbanComments`, `addKanbanComment`, `getKanbanCardEvents`, `getKanbanSeqByIdPrefix`, `findActiveKanbanCardByTitle`, `markScheduledTaskKanbanWaiting` |
| Labels | 8 | 1897-1979 | `listLabels`, `getLabel`, `createLabel`, `updateLabel`, `deleteLabel`, `addLabelToCard`, `removeLabelFromCard`, `getLabelsForCard`, `getLabelsForAllCards` |
| Kanban summary (heartbeat) | 1 | 1981-2000 | `getHeartbeatKanbanSummary` |
| Agent messages (message bus) | 17 | 2002-2219 | `createAgentMessage`, `getPendingMessages`, `markMessageDelivered`, `getPendingBacklogByAgent`, `closeMessagesWithoutDelivery`, `setMessageResult`, `failPendingFederatedMessages`, `claimPendingForAgent`, `markMessageDone`, `markMessageFailed`, `markPendingFederatedFailed`, `listAgentMessages`, `getAgentConversation`, `getAgentConversationThreads`, `appendTaskRun`, `listTaskRunHistory`, `countTaskRunsBetween`, `getAgentMessage`, `getActiveScheduledTaskCount` |
| Pending task retries | 8 | 2322-2427 | `insertPendingTaskRetryIfNew`, `updatePendingTaskRetry`, `upsertPendingTaskRetry`, `clearPendingTaskRetryAlert`, `listPendingTaskRetries`, `getPendingTaskRetry`, `deletePendingTaskRetry`, `deletePendingTaskRetryById`, `markPendingTaskRetryAlert` |
| Channel requests (pairing) | 4 | 2522-2562 | `upsertChannelRequest`, `listPendingChannelRequests`, `updateChannelRequestStatus`, `updateChannelRequestName` |
| IdeaBox | 10 | 2564-2681 | `listIdeas`, `createIdea`, `updateIdea`, `deleteIdea`, `listIdeaCategories`, `getIdeaComments`, `addIdeaComment`, `logIdeaStatusChange`, `getIdeaStatusLog`, `revertIdeaFromKanban` |
| Tool-call log / workflow | 4 | 2683-2769 | `logToolCall`, `getRecentToolCalls`, `analyzeWorkflowCandidates`, `pruneToolCallLog` |
| Skill usage | 3 | 2771-2838 | `logSkillUsage`, `getSkillUsageRows`, `getSkillUsageStats` |
| Config / store audit | 3 | 2840-2896 | `logConfigChange`, `getRecentConfigChanges`, `logStoreFileEvent`, `getRecentStoreFileEvents` |
| Audit log (cross-entity) | 2 | 2898-3016 | `queryAuditLog`, `pruneAuditLogs` |
| Token usage prune | 1 | 3018-3029 | `pruneTokenUsage` |
| Vault SSH (keys + servers) | 9 | 3031-3130 | `listVaultSshKeys`, `getVaultSshKey`, `createVaultSshKey`, `deleteVaultSshKey`, `listVaultSshServers`, `getVaultSshServer`, `createVaultSshServer`, `updateVaultSshServer`, `deleteVaultSshServer`, `computeSshKeyStatus` |
| Approvals (Telegram gates) | 4 | 3132-3237 | `createApproval`, `getApproval`, `resolveApproval`, `listApprovals`, `stampMessageTrace`, `expireTimedOutApprovals` |
| Otel spans (tracing) | 4 | 3239-3307 | `upsertOtelSpan`, `closeOtelSpan`, `getOtelTrace`, `listOtelTraces` |

**Total across clusters:** 158 exported functions + 10 internal helpers + 37 exported types = 205 top-level declarations.

**Internal helpers (10, not exported):**

| Helper | Line | Purpose |
| --- | --- | --- |
| `tightenDbPermissions` | 25 | chmod DB file + sidecars to 0o600 |
| `migrateTaskRunsFromJson` | 950 | legacy JSON→sqlite backfill (one-shot at boot) |
| `withoutRank` | 1164 | strips `rank` field from re-ranked rows before returning |
| `memoryCacheGet` | 1247 | TTL cache read |
| `memoryCacheSet` | 1256 | TTL cache write |
| `memoryCacheInvalidate` | 1260 | per-agent prefix eviction |
| `toBudapestTs` | 1410 | converts date string to Budapest TZ timestamp for recall |
| `escapeLike` | 1426 | LIKE pattern escape |
| `cosineSimilarity` | 2448 | vector distance for hybrid search |
| `vectorSearch` | 2458 | embedding-similarity memory search |

---

## 2. The 37 Exported Interfaces / Types (Top 20 + remainder)

All 37 (verified `grep -nE "^export (interface|type)" src/db.ts`):

| # | Name | Kind | Line | Owner Cluster |
| --- | --- | --- | --- | --- |
| 1 | `DashboardUser` | interface | 1010 | Dashboard users |
| 2 | `DashboardUserPublic` | type (Omit) | 1019 | Dashboard users |
| 3 | `Memory` | interface | 1061 | Memory |
| 4 | `RecencyRankable` | interface | 1133 | Memory (ranker constraint) |
| 5 | `RecallResult` | interface | 1404 | Memory (recall search) |
| 6 | `BackgroundTask` | interface | 1492 | Background tasks |
| 7 | `ScheduledTask` | interface | 1555 | Scheduled tasks |
| 8 | `KanbanCard` | interface | 1627 | Kanban |
| 9 | `KanbanComment` | interface | 1650 | Kanban |
| 10 | `ArchivedKanbanCard` | interface | 1756 | Kanban (archive view) |
| 11 | `KanbanCardEvent` | interface | 1835 | Kanban (audit) |
| 12 | `Label` | interface | 1897 | Labels |
| 13 | `HeartbeatKanbanSummary` | interface | 1981 | Kanban summary |
| 14 | `AgentMessage` | interface | 2002 | Message bus |
| 15 | `AgentBacklog` | type | 2069 | Message bus |
| 16 | `AgentThread` | interface | 2221 | Message bus |
| 17 | `TaskRunEntry` | interface | 2266 | Task runs |
| 18 | `TaskRunHistoryEntry` | interface | 2268 | Task runs |
| 19 | `PendingTaskRetryRow` | interface | 2322 | Pending retries |
| 20 | `PendingChannelRequest` | interface | 2522 | Channel requests |
| 21 | `IdeaBoxRow` | interface | 2564 | IdeaBox |
| 22 | `IdeaComment` | interface | 2620 | IdeaBox |
| 23 | `IdeaStatusLogRow` | interface | 2643 | IdeaBox |
| 24 | `ToolCallLogRow` | interface | 2698 | Tool log |
| 25 | `WorkflowCandidate` | interface | 2710 | Tool log |
| 26 | `SkillUsageRow` | interface | 2771 | Skill usage |
| 27 | `SkillUsageStatRow` | interface | 2780 | Skill usage |
| 28 | `ConfigChangeLogRow` | interface | 2852 | Config audit |
| 29 | `StoreFileAuditRow` | interface | 2869 | Store audit |
| 30 | `AuditSource` | type (literal union) | 2898 | Audit log |
| 31 | `AuditLogEntry` | interface | 2900 | Audit log |
| 32 | `VaultSshKey` | interface | 3031 | Vault SSH |
| 33 | `VaultSshServer` | interface | 3077 | Vault SSH |
| 34 | `SshKeyStatus` | type (literal union) | 3089 | Vault SSH |
| 35 | `Approval` | interface | 3132 | Approvals |
| 36 | `OtelSpan` | interface | 3239 | Otel |
| 37 | `OtelTraceSummary` | interface | 3277 | Otel |

Top 20 by relevance to refactor are listed; full enumeration matches the count. Of these, **6 are pure data rows** (KanbanCard, AgentMessage, Memory, BackgroundTask, ScheduledTask, Approval, OtelSpan — the canonical entity types that survive an entity-store extraction). The remaining ~30 are either view shapes (HeartbeatKanbanSummary, AgentThread, RecallResult, AuditLogEntry), audit/log rows (ToolCallLogRow, SkillUsageRow, StoreFileAuditRow, IdeaStatusLogRow, KanbanCardEvent, TaskRunHistoryEntry, ConfigChangeLogRow), or pure value types (SshKeyStatus, AuditSource, AgentBacklog, TaskRunEntry).

---

## 3. Direct Importer Distribution (39 production files)

Verified via `grep -rl "from '.*db\.js'" src/ scripts/ | grep -v __tests__`. **Discrepancy:** framework M6 cites "14 direct importers"; ground truth is **39 production importers**. The 14 figure may refer to importers calling `getDb()` directly (9 files actually call it) or to a different cut; either way, the count should be reconciled in the next framework pass.

| Directory | Count | Role |
| --- | --- | --- |
| `src/` (top-level, NOT in web/) | 4 | core lifecycle: `index.ts` (boot), `memory.ts` (cross-call surface), `heartbeat.ts` (decay sweep consumer), `store-watcher.ts` (store audit logger) |
| `src/web/` (top-level) | 10 | cross-cutting web services: `auth-sessions`, `auth-device-keys`, `message-router`, `channel-request-watcher`, `security-reset`, `context-guard-runner`, `schedule-runner`, `inbox-nudge-watcher`, `token-usage`, `fleet-transfer` |
| `src/web/federation/` | 1 | `bridge.ts` (importer of `AgentMessage` type only — type-only import, see CE-9) |
| `src/web/routes/` | 23 | one per HTTP endpoint family: `agents`, `approvals`, `audit-log`, `auth`, `background-tasks`, `costs`, `daily-log`, `federation`, `ideas`, `kanban`, `memories`, `messages`, `migrate`, `overview`, `recall`, `schedules`, `security`, `settings`, `skill-usage`, `spans`, `tool-log`, `vault-ssh`, `vault-ssh-keys` |
| `scripts/` | 1 | `scripts/dashboard-user.ts` (admin CLI for dashboard users) |
| **Total** | **39** | |

**Top consumers (by import-line count in the `from '../../db.js'` clause):**

1. `src/web/routes/agents.ts` (5 symbols): `createAgentMessage, listPendingChannelRequests, updateChannelRequestStatus, getDb, claimPendingForAgent, markMessageFailed`
2. `src/web/routes/kanban.ts` (multi-symbol block, ~15 symbols)
3. `src/web/routes/memories.ts` (multi-symbol block)
4. `src/web/routes/ideas.ts` (11 symbols in one import)
5. `src/memory.ts` (9 symbols: `searchMemories, recentMemories, touchMemory, saveMemory, decayMemories as dbDecay, pruneAuditLogs, pruneTokenUsage, getMemoriesForChat, listKanbanCardsSummary, type Memory`)
6. `scripts/dashboard-user.ts` (8 symbols)

**Type-only importers:** `src/web/federation/bridge.ts:24` imports `type { AgentMessage }` only — relevant for the `RemoteStatusCache<T>` reuse opportunity flagged in CE-9.

**Test importers (separate count):** 50 `vi.mock('../db.js', ...)` blocks across `src/__tests__/` (see §6 below).

---

## 4. Entity Cluster Map → Future Entity Stores

Natural groupings derived from the function distribution above. Each cluster maps cleanly to one or two future entity-store classes.

| Entity Store (future class) | Functions in cluster | Notes |
| --- | --- | --- |
| **MemoryStore** | 26 (incl. embedding + cache + recall) | Owns `memoryCache` Map at L1245. Will need TTL invalidation policy exposed. Embedding helpers (`generateEmbedding`, `hybridSearch`, `backfillEmbeddings`) are MemoryStore-internal. |
| **KanbanStore** | 18 | Cards + comments + events + archived variants. Pure CRUD, no cross-entity coupling. |
| **LabelStore** | 8 | Many-to-many `card_labels` table. Tightly coupled to Kanban (every function takes `cardId` or returns labels-for-card). Candidate for **KanbanStore-owned** instead of standalone. |
| **MessageBus** | 17 | Agent messages, threads, backlog, federated-pending, task-run history. Largest cross-cutting consumer is `context-guard-runner.ts` and `message-router.ts`. |
| **Scheduler** | 7 | `scheduled_tasks` CRUD + `getDueTasks`. Distinct from BackgroundTaskPool. |
| **BackgroundTaskPool** | 6 | Atomic create + orphan-marking. Used by `agent.ts` lifecycle. |
| **ApprovalStore** | 6 (incl. `stampMessageTrace`) | Telegram-approval gates. `expireTimedOutApprovals()` is a periodic sweep target. |
| **VaultSSH** | 9 (keys + servers) | Single store; split internal. |
| **IdeaStore** | 10 | IdeaBox with comments + status log + revert-from-kanban hook. |
| **ToolLog** | 4 | Tool-call append + workflow candidate analysis + prune. |
| **SkillUsageStore** | 3 | Skill invocation counts. |
| **AuditLog** | 2 | Cross-entity log query + prune. |
| **ConfigAudit + StoreAudit** | 4 | Two thin tables, can share an `AuditLogger` facade. |
| **DashboardUserStore** | 6 | Dashboard HTTP auth users. Single-table, low coupling. |
| **SessionStore** | 4 | `sessions` table. Used by `chatId → sessionId` mapping. |
| **ChannelRequestStore** | 4 | Telegram pairing requests. |
| **PendingRetryStore** | 8 | Per-task retry records. |
| **TokenUsagePruner** | 1 | Cross-entity: prunes `token_usage` rows. Standalone utility. |
| **OtelSpanStore** | 4 | Tracing spans. |

**Cross-store calls inside db.ts:** the only meaningful intra-module coupling is:
- `MemoryStore` ← `MemoryCache` (internal)
- `Scheduler` ↔ `KanbanStore` (`markScheduledTaskKanbanWaiting`, `findActiveKanbanCardByTitle`)
- `IdeaStore` → `KanbanStore` (`revertIdeaFromKanban` joins via `kanban_id`)
- `MessageBus` → `MemoryCache` invalidation on `markMessageDone`? (verified: NO, message functions don't touch the memory cache)

There are **no generic CRUD wrappers** — every entity has its own bespoke `db.prepare(...).run/.all` calls. This means extraction is mechanical (lift each cluster into its own class), but a future-state opportunity exists to introduce a shared `RowMapper<T>` or `EntityTable<T>` generic.

---

## 5. Re-init Hazards

### 5.1 Singleton Double-Init

The `if (db) { try { db.close() } catch {} }` block at lines 49-51 is the **only** guard. It does:
1. Detects an existing handle.
2. Closes it (catching "already closed" errors).
3. Falls through to re-open at the new path.

**What breaks if double-init fires without the guard:**
- `new Database(dbPath, { strict: true })` on an existing WAL-mode DB while the old handle still holds the WAL file → `SQLITE_BUSY` or schema-mismatch errors.
- All in-flight `db.prepare(...).run()` calls on the old handle would dereference a closed handle → exception mid-transaction.
- The `memoryCache` Map (line 1245) would survive a re-init but reference rows in a closed DB → `TypeError: Cannot read properties of null` on next read.

### 5.2 Schema Migration Double-Fire

All schema setup uses `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` (lines 80-948). These are **idempotent by SQL semantics** — running them twice is a no-op. The only **non-idempotent** migration is the legacy `migrateTaskRunsFromJson()` at line 950 — if re-run, it would re-insert rows from the JSON file. There is **no flag** like `migrations_applied_at` to gate this. Currently safe because `migrateTaskRunsFromJson` is idempotent at the data layer (it inserts with the original `ts`, deduping on PK), but a future schema migration added to `initDatabase` must follow the same `IF NOT EXISTS` discipline.

### 5.3 HMR / Hot-Reload Implications

No `import.meta.hot` accept handler in `db.ts`. Under Bun's HMR, a re-evaluation of the module would re-run `runScript(db, ...)` with a fresh `db` binding — but the OLD `db` handle from the previous module instance would still be held by every other module that imported it at startup. Those modules' references to `getDb()` would return the NEW handle (since the closure rebinds), but any **direct** `import { getDb } from './db.js'` use would now resolve to a different function reference, which is fine. The actual hazard is the unclosed old handle leaking the fd until process exit. This matches the warning at lines 47-48 ("Idempotent re-init: close a previous handle before opening a new one").

### 5.4 Concurrency / Multi-Process

`bun:sqlite` is single-connection per process. Two processes opening the same WAL file simultaneously is **safe for reads** but **serialized for writes** via SQLite's built-in locking. There is no application-level coordination. The chmod-to-0o600 hardening at boot (lines 25-33, 57-78) is the only defense against cross-process tampering.

---

## 6. Test Mock Patterns

Verified via `grep -rE "vi\.mock.*['\"]\\.\\.\\/db\\.js" src/__tests__/`. **50 test files** use `vi.mock('../db.js', ...)` (NOT 35 or 49 — the ground-truth count is 50). All 50 imports use the relative `../db.js` path (not `../../db.js` from nested subdirs; the test files all live at `src/__tests__/level-1` directly).

Three mock patterns observed:

| Pattern | Count | Description |
| --- | --- | --- |
| **Full-replacement (named exports)** | ~36 | `vi.mock('../db.js', () => ({ listKanbanCards: vi.fn()..., createKanbanCard: vi.fn()..., ... }))`. Each collaborator gets its own `vi.fn` with a typed signature. The user can assert call counts and argument shapes. **Example:** `kanban-routes.test.ts:60-90`, `memories-routes.test.ts:30-45`. |
| **Empty-replacement** | 5 | `vi.mock('../db.js', () => ({}))`. Replaces the entire module with `{}` — every named export becomes `undefined`. Used when the test never invokes the route handler that touches the DB, only the auth/middleware path. **Examples:** `fleet-q-routes.test.ts`, `voice-routes.test.ts`, `marveen-routes.test.ts`, `agent-terminal-routes.test.ts`, `connectors-routes.test.ts`. |
| **Partial-replacement (1-3 symbols)** | ~9 | `vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))`. Picks the exact collaborators the test cares about. **Example:** `autonomy-routes.test.ts` (just `getDb` + `logConfigChange`). |

**No `vi.hoisted` spread-actual pattern observed for `db.js`.** A handful of tests use `vi.hoisted` to allocate `vi.fn` state (e.g. `kanban-routes.test.ts:26` declares `H` as a hoisted mock factory), but the mock factory returns named exports directly — never `...actual`. This means the refactor to entity-store classes will **break all 50 mocks** unless the new export shape keeps the existing top-level function names (e.g. `MemoryStore` instance methods that are still callable as `searchMemories(...)` via a re-export shim).

**Important compatibility constraint:** the test mock contracts above prove that **the route handlers must continue to call free-function names** — they cannot be rewritten to instantiate `new MemoryStore()` at the call site without also rewriting all 50 mock factories. The refactor strategy is therefore:
1. Introduce entity-store classes internally.
2. Keep the top-level free-function names as **thin pass-through exports** that delegate to a process-wide singleton store instance.
3. Test mocks stay unchanged.

---

## 7. Cross-Call Surface (CE-8)

`src/memory.ts` is the only non-trivial inter-module consumer that calls A-subsystem prune/sweep functions. Verified via `grep -rn "decayMemories\|pruneAuditLogs\|pruneTokenUsage" src/`.

| db.ts target | Line | Caller | Aggregator |
| --- | --- | --- | --- |
| `decayMemories()` | 1213 | `src/memory.ts:157` (renamed `dbDecay`) | `runDecaySweep()` at `src/memory.ts:155` |
| `pruneAuditLogs()` | 3006 | `src/memory.ts:158` | same |
| `pruneTokenUsage(): number` | 3018 | `src/memory.ts:159` | same (returned count) |
| `markOrphanedTasksFailed()` | 1546 | direct callers (no aggregator) | used by heartbeat / cleanup paths |
| `expireTimedOutApprovals()` | 3229 | `src/web/routes/approvals.ts:57` | invoked at route handler invocation, no aggregator |
| `pruneToolCallLog()` | 2764 | `src/web/routes/tool-log.ts:62` | invoked at route handler invocation, no aggregator |

**The `runDecaySweep()` aggregator (memory.ts:155):**

```ts
// src/memory.ts:155-160
export function runDecaySweep(): void {
  dbDecay()         // decayMemories (MemoryStore.salience)
  pruneAuditLogs()  // audit prune (AuditLog)
  const tokenRowsPruned = pruneTokenUsage()  // token_usage prune
  ...
}
```

**Production caller chain:**
- `src/index.ts:15` imports `runDecaySweep` and schedules it via `setInterval(runDecaySweep, 24 * 60 * 60 * 1000)` (line 451).
- `src/heartbeat.ts:504-511` calls `runDecaySweep()` opportunistically inside `executeHeartbeat()`.

**CE-8 implication for refactor:** the decay sweep crosses **three entity stores** (MemoryStore, AuditLog, TokenUsagePruner). The aggregator function lives in `src/memory.ts` because that's where the "memory hygiene" concept is named. The refactor must preserve this boundary: `runDecaySweep()` stays in `memory.ts` and calls three store methods (e.g. `memoryStore.decay()`, `auditLog.prune()`, `tokenUsage.prune()`). No new coupling between the stores themselves.

---

## 8. Memory Cache (db.ts:1245)

```ts
// src/db.ts:1238-1273
const MEMORY_CACHE_TTL_MS = 60_000

interface MemoryCacheEntry {
  value: Memory[]
  expiresAt: number
}

const memoryCache = new Map<string, MemoryCacheEntry>()

function memoryCacheGet(key: string): Memory[] | null { ... }
function memoryCacheSet(key, value) { ... }
function memoryCacheInvalidate(agentId: string): void {
  for (const key of memoryCache.keys()) {
    if (key.startsWith(`${agentId}:`)) memoryCache.delete(key)
  }
}

export function clearMemoryCache(): void { memoryCache.clear() }
export function getMemoryCacheSize(): number { return memoryCache.size }
```

**Cache key shape:** `${agentId}:${limit}:${category}` (constructed inline in `getAgentMemories` at L1310-1321).

**Write-path eviction rules (lines 1230-1236, 1289-1293, 1374-1376):**
- `saveAgentMemory` with `category='shared'` → `clearMemoryCache()` (every agent sees shared).
- `saveAgentMemory` otherwise → `memoryCacheInvalidate(agentId)` (the author's agent).
- `updateMemory` → same two branches on `before.agent_id` vs the new `agent_id`.
- No eviction on `decayMemories` (intentional: salience shifts don't change the row set).

**Interaction with future MemoryStore extraction:** the cache MUST move with the MemoryStore class. If `MemoryStore` becomes an instance, the cache should be instance state (not module-level). The exported `clearMemoryCache()` / `getMemoryCacheSize()` test hooks will need to remain (or be replaced with `MemoryStore.prototype.clearCache()` / `.cacheSize`), and tests that touch them (search `clearMemoryCache` in `src/__tests__/memory.test.ts`) will need updating. **Constraint for refactor:** the cache key shape and TTL must stay stable, or every consumer of `getAgentMemories` gets an unrelated behavioral change.

---

## 9. Side Effects Summary

`src/db.ts` has **two categories of side effects beyond SQLite IO:**

1. **SQLite file IO:** every function calls `db.prepare(...).run/.all/.get(...)`. WAL writes go through `journal_mode=WAL` (line 70). `mmap_size=268435456` enables memory-mapped IO (line 76). `:memory:` mode is supported for tests.

2. **Filesystem chmod (boot only):** `tightenDbPermissions` (line 25) chmods the DB file + WAL/SHM/journal sidecars to 0o600. `openSync('wx', 0o600)` (line 59) pre-creates the file with tight mode on fresh installs. Skipped for `:memory:`.

3. **No process signals, no fs writes outside the DB dir, no network IO.** (The `OLLAMA_URL` config import at line 5 is for `generateEmbedding` callers, not for db.ts itself.)

4. **Migration side effects:** `migrateTaskRunsFromJson` (line 950) reads a legacy JSON file at boot. Idempotent at data level.

---

## 10. Discrepancies With Framework Reference

| Framework estimate | Ground truth | Where verified |
| --- | --- | --- |
| ~3900 LOC | **3308 LOC** | `wc -l src/db.ts` |
| 155 free functions | **158 exported functions** | `grep -cE "^export (async )?function"` |
| 14 direct importers (per M6) | **39 production importers** | `grep -rl "from '.*db\.js'" \| grep -v __tests__` |
| ~35 test mocks | **50 vi.mock('../db.js') blocks** | `grep -rE "vi\.mock.*db\\.js" src/__tests__/` |

All four discrepancies are below-estimates. None changes the refactor strategy but each should be reflected in the next framework pass.

---

## 11. Refactor-Relevant Constraints Summary

1. **Singleton `db` at L10** must become constructor-injected into entity-store classes, OR entity stores must continue to use a module-level accessor (`getDb()`). The latter is cheaper and matches the existing test mock contracts (50 vi.mock blocks assume free-function exports).

2. **`memoryCache` at L1245** must move with MemoryStore; cache key shape and TTL must stay stable.

3. **Schema migrations** in `initDatabase` (lines 80-948) are idempotent via `IF NOT EXISTS` and can be moved to a one-time migration helper invoked at boot. The legacy `migrateTaskRunsFromJson` at L950 is one-shot at boot.

4. **Test mock contracts** (50 files, ~36 full-replacement, ~9 partial, ~5 empty) assume the free-function names stay. The refactor must keep `export function searchMemories(...)` etc. as thin pass-throughs.

5. **`runDecaySweep` (memory.ts:155)** crosses three entity stores. Refactor must preserve the aggregator's location and call shape.

6. **`getDb()` escape hatch** (line 978) is used by 9 files; if entity stores take a Database constructor arg, those 9 files will need to either (a) keep calling `getDb()` directly (status quo), or (b) receive a store instance from a higher-level factory.

7. **`src/web/federation/bridge.ts:24`** is a type-only importer of `AgentMessage`. Relevant to CE-9 (`RemoteStatusCache<T>`) — the type can be re-exported from a `MessageBus` namespace without runtime coupling.
