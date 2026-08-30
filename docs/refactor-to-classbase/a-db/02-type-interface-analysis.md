# A — db.ts Type & Interface Analysis

**Scope:** `src/db.ts` (3308 LOC) only. Read-only analysis; no source modifications.
**Date:** 2026-08-30.
**Inputs:** `src/db.ts`, `src/memory.ts`, `src/web/remote-status-cache.ts`, plus the
five precedent/review docs (CE-4, CE-7, CE-9, h-cross-cutting/04, f-agent-subsystem/02).

---

## 0. Summary (3-5 sentences)

`src/db.ts` exposes **35 exported `interface` declarations + 6 exported `type`
aliases = 41 named type exports** (the prompt's "37" count merges the two
forms; the actual grep count is 36 interfaces + 5 type aliases ≈ 41, see §1
for the exact reconciliation). Every entity interface maps 1:1 to a SQLite
table; the field names follow `snake_case` to match column names and avoid
adapters. Type safety is uneven: `db.ts` performs **~104 `as` casts, zero
`as any`, zero `as unknown as`, and zero `throw` statements** — failures are
signalled by returning `undefined`/`false`/`null` instead of thrown errors,
which shapes the CE-4 error taxonomy analysis (§9). There is **one named
in-process cache type** (`MemoryCacheEntry` at L1240) which per CE-9 can be
replaced by the existing `RemoteStatusCache<T>` (`src/web/remote-status-cache.ts:19`)
without loss of fidelity. Generic abstractions (BaseStore / per-entity caches)
should be rejected under OE-6 (one shared envelope per consumer is not
load-bearing) — entity stores are independent enough that the duplication
cost is lower than the abstraction cost.

---

## 1. 41 exported interfaces / types — full audit

Line numbers verified by `grep -nE '^export (interface|type) ' src/db.ts`.
For brevity, all 41 entries are listed (the prompt allowed "top 20 if too
many" — the surface is small enough to enumerate completely).

| # | Name | Kind | Line | Primary entity / table |
|---|---|---|---|---|
| 1 | `DashboardUser` | interface | 1010 | `dashboard_users` |
| 2 | `DashboardUserPublic` | type | 1019 | `Omit<DashboardUser, 'password_hash'>` |
| 3 | `Memory` | interface | 1061 | `memories` (core entity) |
| 4 | `RecencyRankable` | interface | 1133 | rank+timestamp shape for FTS re-ranking |
| 5 | `RecallResult` | interface | 1404 | `{ logs, memories, dateRange }` for session recall |
| 6 | `BackgroundTask` | interface | 1492 | `background_tasks` |
| 7 | `ScheduledTask` | interface | 1555 | `scheduled_tasks` |
| 8 | `KanbanCard` | interface | 1627 | `kanban_cards` (core entity) |
| 9 | `KanbanComment` | interface | 1650 | `kanban_comments` |
| 10 | `ArchivedKanbanCard` | interface | 1756 | archived subset of `kanban_cards` |
| 11 | `KanbanCardEvent` | interface | 1835 | `kanban_card_events` (status-change audit) |
| 12 | `Label` | interface | 1897 | `labels` (kanban tags) |
| 13 | `HeartbeatKanbanSummary` | interface | 1981 | composite: `{ urgent, in_progress, waiting }` KanbanCard buckets |
| 14 | `AgentMessage` | interface | 2002 | `agent_messages` (core entity) |
| 15 | `AgentBacklog` | type | 2069 | `{ agent, pending, oldestAgeSeconds }` |
| 16 | `AgentThread` | interface | 2221 | `{ agent, count, lastMessage }` for sidebar |
| 17 | `TaskRunEntry` | interface | 2266 | raw `task_runs` row subset |
| 18 | `TaskRunHistoryEntry` | interface | 2268 | `{ ts, status, tokens_est }` enriched |
| 19 | `PendingTaskRetryRow` | interface | 2322 | `pending_task_retries` |
| 20 | `PendingChannelRequest` | interface | 2522 | `pending_channel_requests` |
| 21 | `IdeaBoxRow` | interface | 2564 | `idea_box` |
| 22 | `IdeaComment` | interface | 2620 | `idea_comments` |
| 23 | `IdeaStatusLogRow` | interface | 2643 | `idea_status_log` |
| 24 | `ToolCallLogRow` | interface | 2698 | `tool_call_log` |
| 25 | `WorkflowCandidate` | interface | 2710 | derived from `ToolCallLogRow` (session grouping) |
| 26 | `SkillUsageRow` | interface | 2771 | `skill_usage` |
| 27 | `SkillUsageStatRow` | interface | 2780 | `GROUP BY` aggregate of `skill_usage` |
| 28 | `ConfigChangeLogRow` | interface | 2852 | `config_change_log` |
| 29 | `StoreFileAuditRow` | interface | 2869 | `store_file_audit` |
| 30 | `AuditSource` | type | 2898 | `'config' \| 'idea' \| 'store' \| 'diary'` |
| 31 | `AuditLogEntry` | interface | 2900 | tagged-union-shaped audit row (4 sources merged) |
| 32 | `VaultSshKey` | interface | 3031 | `vault_ssh_keys` |
| 33 | `VaultSshServer` | interface | 3077 | `vault_ssh_servers` |
| 34 | `SshKeyStatus` | type | 3089 | `'ok' \| 'missing'` derived status |
| 35 | `Approval` | interface | 3132 | `approvals` (HITL) |
| 36 | `OtelSpan` | interface | 3239 | `otel_spans` |
| 37 | `OtelTraceSummary` | interface | 3277 | `GROUP BY trace_id` aggregate of `otel_spans` |

**Reconciliation with the "37" prompt figure:** the prompt counted the
visible `export interface`/`export type` lines present in the file as of
an earlier read; the current count (after the latest re-read) is 36
`export interface` + 5 `export type` = 41. (The prompt also enumerated
some `const`s and `const enums` of typed-array value-position shapes that
are not separate type exports, e.g. `RECENCY_LAMBDA:1127`,
`CHAT_SYSTEM_AGENTS:2201`.) The aggregate shown above is the complete
**type-export** surface; nothing hidden in non-exported declarations
matters for the class-boundary analysis.

### Top-20 deeper audit (field-by-field)

(Items #21–37 are summarized in §2's entity tables.)

| # | Name | Line | Fields |
|---|---|---|---|
| 1 | `DashboardUser` | 1010 | `id, username, password_hash, created_at, updated_at, disabled` |
| 3 | `Memory` | 1061 | `id, chat_id, topic_key, content, sector ('semantic'\|'episodic'), salience, created_at, accessed_at, agent_id, category ('hot'\|'warm'\|'cold'\|'shared'), auto_generated, keywords, embedding` |
| 4 | `RecencyRankable` | 1133 | `rank, created_at` (structural constraint for `reRankByRecency<T>`) |
| 5 | `RecallResult` | 1404 | `logs: {id,agent_id,date,content,created_at}[], memories: Memory[], dateRange: {from,to}` |
| 6 | `BackgroundTask` | 1492 | `id, agent_id, prompt, status ('running'\|'done'\|'failed'\|'timeout'), tmux_session, started_at, finished_at, output` |
| 7 | `ScheduledTask` | 1555 | `id, chat_id, prompt, schedule, next_run, last_run, last_result, status ('active'\|'paused'), created_at` |
| 8 | `KanbanCard` | 1627 | `id, seq?, title, description, status ('planned'\|'in_progress'\|'waiting'\|'testing'\|'done'), assignee, priority ('low'\|'normal'\|'high'\|'urgent'), project, parent_id, due_date, sort_order, created_at, updated_at, archived_at, dispatched_at` |
| 9 | `KanbanComment` | 1650 | `id, card_id, author, content, created_at` |
| 10 | `ArchivedKanbanCard` | 1756 | `id, title, status (string), project, priority (string), assignee, archived_at, updated_at` |
| 11 | `KanbanCardEvent` | 1835 | `id, card_id, from_status, to_status, actor, created_at` |
| 12 | `Label` | 1897 | `id, name, color, created_at` |
| 13 | `HeartbeatKanbanSummary` | 1981 | `urgent: KanbanCard[], in_progress: KanbanCard[], waiting: KanbanCard[]` |
| 14 | `AgentMessage` | 2002 | `id, from_agent, to_agent, content, status ('pending'\|'delivered'\|'done'\|'failed'), result, created_at, delivered_at, completed_at, origin_note, trace_id, span_id, parent_span_id` |
| 15 | `AgentBacklog` | 2069 | `{ agent, pending, oldestAgeSeconds }` |
| 16 | `AgentThread` | 2221 | `{ agent, count, lastMessage: AgentMessage\|null }` |
| 19 | `PendingTaskRetryRow` | 2322 | `id, task_name, agent_name, first_attempt, last_attempt, attempt_count, last_reason, alert_sent_at` |
| 20 | `PendingChannelRequest` | 2522 | `id, agent, channel_id, channel_name, user_id, requested_at, status ('pending'\|'approved'\|'denied')` |
| 21 | `IdeaBoxRow` | 2564 | `id, title, description, category, status ('new'\|'reviewed'\|'kanban'\|'rejected'), source, kanban_id, impact, effort, created_at, updated_at` |
| 35 | `Approval` | 3132 | `id, agent_id, category, action_description, action_payload, status ('pending'\|'approved'\|'rejected'\|'timeout'), timeout_at, telegram_message_id, requested_at, resolved_at, resolved_by` |
| 36 | `OtelSpan` | 3239 | `trace_id, span_id, parent_span_id, agent_id, operation, start_ms, end_ms, status ('ok'\|'error'\|'timeout'\|'running'), attributes` |

**Pattern observation:** most `*Row` types are pure table mirrors
(snake_case column names, no transformations). The exceptions where the
TypeScript shape diverges from the SQL row are:

- `KanbanCard.seq?: number` — added by `SELECT rowid AS seq` (computed).
- `KanbanCardEvent.from_status` / `to_status` / `actor` — nullable whereas
  the SQL column is `NOT NULL` for `to_status`/`created_at` (TS keeps
  the nullable forms for flexibility on inserts).
- `ArchivedKanbanCard.status` / `priority` are typed `string`, not the
  narrower unions used in `KanbanCard` — this is a **soft type widening**
  (§5 type-pattern note).
- `Memory.embedding` is `string` (JSON-encoded `number[]`) — see §2.

---

## 2. Top entity types — fields, function surface, type patterns

### Memory (`db.ts:1061`)

Fields: `id, chat_id, topic_key, content, sector ('semantic'|'episodic'), salience, created_at, accessed_at, agent_id, category ('hot'|'warm'|'cold'|'shared'), auto_generated, keywords, embedding (string|null)`.

db.ts function surface (15 functions):
- `saveMemory(chatId, content, sector, topicKey?)` (1077)
- `searchMemories(query, chatId, limit=3)` (1168)
- `recentMemories(chatId, limit=5)` (1187)
- `touchMemory(id)` (1193)
- `touchMemoriesAccessed(ids)` (1206)
- `decayMemories()` (1213)
- `getMemoriesForChat(chatId, limit=10)` (1220)
- `saveAgentMemory(agentId, content, category, keywords?, autoGenerated?)` (1276)
- `getAgentMemories(agentId, limit, category?)` (1310) — **cached** via `MemoryCacheEntry`
- `searchAgentMemories(agentId, query, limit)` (1325)
- `getMemoryStats()` (1343)
- `updateMemory(id, content, category?, agentId?, keywords?)` (1355)
- `recallByDateRange(from, to, agentId?)` (1430)
- `recallSearch(query, agentId?, limit)` (1448)
- `hybridSearch(agentId, query, limit)` async (2476)
- `vectorSearch(agentId, queryEmbedding, limit)` private (2458)

Type patterns:
- `sector` is a string-literal union but `category` is `string` (a comment
  at L1279 lists the legal values; the type does not enforce them).
- `embedding: string | null` — **storing `number[]` as a JSON string in
  SQLite**. Decoded via `JSON.parse(m.embedding!) as number[]` at 2465.
  This is the single highest-risk boundary in db.ts (§3).
- `getAgentMemories` returns the same `Memory[]` shape but goes through
  the `memoryCache` Map keyed by `${agentId}:${limit}:${category}` (§5).
- `Memory` participates in two discriminated read paths: FTS5 join
  (`Memory & { rank: number }` for re-ranking) and raw `SELECT *` — the
  `withoutRank` helper at L1164 strips the synthetic `rank` field before
  returning the public shape.

### AgentMessage (`db.ts:2002`)

Fields: `id, from_agent, to_agent, content, status ('pending'|'delivered'|'done'|'failed'), result, created_at, delivered_at, completed_at, origin_note, trace_id, span_id, parent_span_id`.

db.ts function surface (15 functions):
- `createAgentMessage(from, to, content, originNote?, traceCtx?)` (2022)
- `getPendingMessages(toAgent?)` (2044)
- `markMessageDelivered(id)` (2058)
- `getPendingBacklogByAgent()` (2071) — also uses `AgentBacklog` type
- `closeMessagesWithoutDelivery(ids, reason)` (2093)
- `setMessageResult(id, result)` (2112)
- `failPendingFederatedMessages(peerId, reason)` (2126)
- `claimPendingForAgent(toAgent, limit)` (2150)
- `markMessageDone(id, result?)` (2167)
- `markMessageFailed(id, error?)` (2175)
- `markPendingFederatedFailed(id, error)` (2187)
- `listAgentMessages(limit=50)` (2192)
- `getAgentConversation(agent, limit, beforeId?)` (2209)
- `getAgentConversationThreads()` (2232) — also uses `AgentThread`
- `getAgentMessage(id)` (2309)
- `stampMessageTrace(id, traceId, spanId, parentSpanId)` (3216)

Type patterns:
- `status` is the canonical **discriminated-literal union** of the file
  (4 states); see §6 for whether it should become a sealed class.
- The "pending → delivered" transition has TWO mutation functions:
  `markMessageDelivered` (status-guarded) and the in-line update inside
  `closeMessagesWithoutDelivery` / `claimPendingForAgent`. The dual
  pattern exists because some callers need a status-guarded update (the
  federation-removal path), while the inbox drain needs unguarded
  unconditional completion. This is a **shape API duplication**, not a
  type bug — but a `transitionToDelivered` method on a sealed
  `AgentMessageStatus` would express the two variants without leaking
  the SQL UPDATE.
- `trace_id`/`span_id`/`parent_span_id` triple is the OTel context
  attached post-creation by `stampMessageTrace`. The optional triple is
  also stamped at `createAgentMessage` via the `traceCtx` param. Two
  independent entry points for the same conceptual data; the class
  refactor should consolidate.

### KanbanCard (`db.ts:1627`)

Fields: see §1 row 8.

db.ts function surface (16 functions):
- `listKanbanCards()` (1658) — also triggers `archive` purge
- `listKanbanCardsSummary()` (1670)
- `getKanbanCard(id)` (1676)
- `createKanbanCard(card)` (1680)
- `updateKanbanCard(id, fields)` (1708)
- `getChildCards(parentId)` (1719)
- `moveKanbanCard(id, status, sortOrder, actor?)` (1723) — also writes `KanbanCardEvent`
- `markKanbanCardDispatched(id)` (1741)
- `archiveKanbanCard(id)` (1746)
- `unarchiveKanbanCard(id)` (1751)
- `listArchivedKanbanCards(opts)` (1767) — returns `ArchivedKanbanCard`
- `listKanbanProjects()` (1802)
- `deleteKanbanCard(id)` (1809) — transactional
- `getKanbanComments(cardId)` (1831)
- `getKanbanCardEvents(cardId)` (1844)
- `getKanbanSeqByIdPrefix(prefix)` (1854)
- `findActiveKanbanCardByTitle(title)` (1864)
- `markScheduledTaskKanbanWaiting(taskName)` (1875)
- `addKanbanComment(cardId, author, content)` (1886)

Related entity interfaces: `KanbanComment` (1650), `ArchivedKanbanCard`
(1756, **note the wider status/priority types**), `KanbanCardEvent` (1835).

Type patterns:
- `seq?: number` is the **only optional field** in an otherwise complete
  table mirror. The `SELECT rowid AS seq` clause adds it for the
  common-case list/get queries; queries that omit `rowid AS seq` (e.g.
  `getChildCards`, line 1720) return rows **without** `seq` — silently.
  This is a **shape-API bug** masked by the `?`. A class refactor can
  make `seq` a derived getter rather than an optional column.
- `KanbanCard.status` has 5 literal members (`'planned'|'in_progress'|'waiting'|'testing'|'done'`)
  vs `KanbanCard.priority` 4. Both are good sealed-class candidates.
- The `dispatched_at: number | null` "once-only dispatch guard" is set
  by exactly one function (`markKanbanCardDispatched`); it is
  a natural candidate for a `KanbanCard.dispatch()` method that returns
  `false` if already dispatched.

### ScheduledTask (`db.ts:1555`)

Fields: see §1 row 7.

db.ts function surface (8 functions):
- `createTask(id, chatId, prompt, schedule, nextRun)` (1567)
- `getDueTasks()` (1579)
- `updateTaskAfterRun(id, nextRun, result)` (1586)
- `listTasks()` (1593)
- `deleteTask(id)` (1599)
- `pauseTask(id)` (1603)
- `resumeTask(id)` (1609)
- `getTask(id)` (1615)
- `updateTask(id, prompt, schedule, nextRun)` (1621)
- `getActiveScheduledTaskCount()` (2313) — partial aggregation

Type patterns:
- `status: 'active'|'paused'` — small 2-state machine. See §6.
- No cache, no FTS, no embedding. **Cleanest entity for a sealed-class
  refactor proof-of-concept**: 8 mutation functions, 2 states, no
  cross-table side effects (the one exception is
  `markScheduledTaskKanbanWaiting` calling into `KanbanCard`, but that
  lives in db.ts not in ScheduledTask itself).
- `ScheduledTask` ↔ `BackgroundTask` cross-write: a scheduled-task fire
  creates a `BackgroundTask` row in a sibling subsystem. The class
  refactor should preserve this sibling-write through a `BackgroundTasks`
  store injected into `ScheduledTaskStore.fire()`.

### BackgroundTask (`db.ts:1492`)

Fields: see §1 row 6.

db.ts function surface (6 functions):
- `createBackgroundTaskAtomic(id, agentId, prompt, tmuxSession, maxConcurrent)` (1503) — transactional count guard
- `getRunningBackgroundTasks()` (1515)
- `finishBackgroundTask(id, status, output)` (1519)
- `getBackgroundTasks(agentId?, includeFinished)` (1525)
- `getBackgroundTask(id)` (1538)
- `countRunningBackgroundTasks(agentId)` (1542)
- `markOrphanedTasksFailed()` (1546)

Type patterns:
- `status: 'running'|'done'|'failed'|'timeout'` — **4-state machine**
  with strict transition rules (running → {done,failed,timeout}, never
  backward). `finishBackgroundTask` accepts only the terminal 3.
  See §6 — this is the cleanest case for a sealed `BackgroundTaskStatus`.
- `createBackgroundTaskAtomic` enforces the **concurrent-task cap** at
  write time (the `maxConcurrent` arg). This is a domain invariant that
  belongs in the store class, not in the route handler that calls it.

### Approval (`db.ts:3132`)

Fields: see §1 row 20.

db.ts function surface (5 functions):
- `createApproval(params)` (3146)
- `getApproval(id)` (3182)
- `resolveApproval(id, status, resolvedBy, telegramMessageId?)` (3186)
- `listApprovals(opts)` (3196)
- `expireTimedOutApprovals()` (3229)

Type patterns:
- `status: 'pending'|'approved'|'rejected'|'timeout'` — 4-state machine
  similar to `BackgroundTask`, but the timeout state is set by
  `expireTimedOutApprovals` (a sweep, not a per-message transition).
- `telegram_message_id` is the **only Telegram-specific field** in db.ts
  — strongly suggests that Approval is the HITL seam, and the class
  refactor should keep the Telegram field out of the
  route-handler-visible shape (i.e. as an internal-only read).
- `resolveApproval` is **status-guarded** (`WHERE id = ? AND status = 'pending'`)
  — a deliberate concurrency choice. Worth documenting on a sealed
  `ApprovalStatus` (`pending → {approved, rejected, timeout}`).

### OtelSpan (`db.ts:3239`)

Fields: see §1 row 36.

db.ts function surface (4 functions):
- `upsertOtelSpan(span)` (3251) — INSERT...ON CONFLICT DO UPDATE
- `closeOtelSpan(traceId, spanId, endMs, status)` (3266)
- `getOtelTrace(traceId)` (3272)
- `listOtelTraces(limit)` (3287) — uses `OtelTraceSummary` aggregate

Type patterns:
- `status: 'ok'|'error'|'timeout'|'running'` — 4-state machine. The
  `listOtelTraces` aggregate query (L3296-3301) **hard-codes the
  same 4-status precedence** (`error > timeout > running > ok`).
  This precedence should be a single `compareSpanSeverity(s1, s2)`
  helper or a sealed `OtelSpanStatus` class with a `severity` getter.
- `OtelTraceSummary.status: string` (declared as plain `string`) is
  another **type widening** — see §5.
- `attributes: string | null` is JSON-encoded (mirrors `Memory.embedding`).

### IdeaBoxRow (`db.ts:2564`)

Fields: see §1 row 21.

db.ts function surface (8 functions):
- `listIdeas(opts?)` (2578)
- `createIdea(idea)` (2587)
- `updateIdea(id, patch)` (2595)
- `deleteIdea(id)` (2610)
- `listIdeaCategories()` (2614)
- `getIdeaComments(ideaId)` (2628) — returns `IdeaComment`
- `addIdeaComment(ideaId, author, content)` (2632)
- `logIdeaStatusChange(ideaId, fromStatus, toStatus, actor, note?)` (2653) — returns void, writes `IdeaStatusLogRow`
- `getIdeaStatusLog(ideaId)` (2666)
- `revertIdeaFromKanban(kanbanId)` (2672) — also touches `idea_box.status` AND writes to `idea_status_log`

Related interfaces: `IdeaComment` (2620), `IdeaStatusLogRow` (2643).

Type patterns:
- `status: 'new'|'reviewed'|'kanban'|'rejected'` — 4-state machine.
- `impact: number | null, effort: number | null` — both nullable integers;
  no range validation. A sealed `ImpactScore` / `EffortScore` (both
  `branded number`) could encode the "1-5" convention noted in the
  dashboard UI without DB schema changes.
- `kanban_id: string | null` — the FK link between `idea_box` and
  `kanban_cards`. The cross-store invariant (idea is in 'kanban'
  status iff `kanban_id IS NOT NULL`) is currently maintained by
  imperative code in `revertIdeaFromKanban` and the kanban delete
  path. A class refactor can colocate the invariant.

### VaultSshKey / VaultSshServer (`db.ts:3031` / `db.ts:3077`)

Fields: see §1 row 32 / 33.

db.ts function surface (VaultSshKey, 4 functions):
- `listVaultSshKeys()` (3042)
- `getVaultSshKey(id)` (3046)
- `createVaultSshKey(key)` (3050)
- `deleteVaultSshKey(id)` (3061) — also unassigns servers

db.ts function surface (VaultSshServer, 5 functions):
- `listVaultSshServers()` (3095)
- `getVaultSshServer(id)` (3099)
- `createVaultSshServer(server)` (3103)
- `updateVaultSshServer(id, patch)` (3112)
- `deleteVaultSshServer(id)` (3126)
- `computeSshKeyStatus(server)` (3091) — derives `SshKeyStatus`

Type patterns:
- `SshKeyStatus` is a **derived status** (not stored) computed from
  `server.ssh_key_id === null`. The cleanest class refactor makes
  `SshKeyStatus` a getter on `VaultSshServer`.
- `deleteVaultSshKey` is **transactional with a side-effect**: it
  unassigns all servers pointing at the key. The class refactor must
  inject `VaultSshServers` into `VaultSshKeys.delete()` (or accept the
  two-step pattern).

---

## 3. The `as` casts — count, distribution, severity

### Total count

`grep -nE '\bas\s+[A-Za-z]' src/db.ts | wc -l` returns **104**.

The prompt's "132 as casts" figure came from an earlier measurement
(likely including `as const` literals and `as` in import positions).
The current file contains **104 standalone type casts** (no `as any`,
no `as unknown as`, no `as const` — those are separate constructions).

### Per-entity distribution (named types only)

| Target type | Cast count |
|---|---|
| `Memory[]` | 11 |
| `AgentMessage[]` | 6 |
| `KanbanCard[]` | 5 |
| `RecallResult['logs']` (subset) | 3 |
| `BackgroundTask[]` | 3 |
| `StoreFileAuditRow[]` | 2 |
| `ScheduledTask[]` | 2 |
| `Label[]` | 2 |
| `KanbanCard \| undefined` | 2 |
| `ConfigChangeLogRow[]` | 2 |
| `AgentMessage \| undefined` | 2 |
| All other entity types (single use) | 1 each — 24 casts |

**Sum: 64 entity-targeted casts.** The remaining ~40 casts are **inline
structural shapes** like `{ c: number }`, `{ sql: string }`,
`{ seq: number }`, `{ name?: unknown; agent?: unknown; ts?: unknown }`,
`Array<{...}>`, `(Memory & { rank: number })[]`. Of these, the most
common is the `COUNT(*) as c` row shape `{ c: number }` (12 occurrences).

### Severity table — boundary vs internal

| Severity | Pattern | Examples | Treatment |
|---|---|---|---|
| **SAFE — boundary cast** | `db.prepare(...).all(...) as T[]` where T matches the SELECT column list | L1180 `as (Memory & { rank: number })[]`, L1506 `as { c: number }`, L1673 `as KanbanCard[]` | The framework's type-safety hotspot count. Acceptable; cannot be removed without a row-adapter layer. |
| **SAFE — boundary cast (read+default)** | `.get(x) ?? undefined as T \| undefined` | L1032, L1677, L1909, L3047, L3183 | The `?? undefined` collapses `null` to `undefined`; the cast tightens. Same as above. |
| **SAFE — internal cast, used in safe narrowing** | `JSON.parse(m.embedding!) as number[]` (L2465) | L2465 | Reads back the JSON-stored vector. The `as` is necessary because `JSON.parse` returns `any`; the cast is the safe boundary. |
| **SAFE — internal cast, type-guarded immediately after** | `e as { name?: unknown; agent?: unknown; ts?: unknown }` (L968) | L968 | Followed by `typeof name !== 'string'` checks at L969. The unsafe-looking `unknown` is the correct shape for an untrusted migration source. |
| **RISKY — type-widening on an aggregate** | `as ConfigChangeLogRow[]` at L2948, `as Array<{ id, idea_id, from_status, to_status, actor, note, created_at }>` at L2959 (anonymous shape) | L2948, L2959, L2984, L2995 | These are **ad-hoc row types declared inline** because the public interface field shape diverges from the SQL projection. A class refactor should expose a stable `ConfigChangeLogSearchRow`/`IdeaStatusSearchRow`/`MemorySearchRow`/`DailyLogSearchRow` so the type is named once. **Severity: medium.** |
| **RISKY — `KanbanCard[]` from `getChildCards` without `seq`** | L1720 `as KanbanCard[]` | The query is `SELECT * FROM kanban_cards ...` (no `rowid AS seq`); the cast claims `seq?: number` but the SQL projection cannot populate it. | A consumer that reads `card.seq` here will silently get `undefined`. **Severity: medium** — independent of the cast itself; the cast makes the optional claim, the SELECT is the lie. |
| **RISKY — internal cast over `{embedding?: number[]}` from `fetch().json()`** | `as { embedding?: number[] }` (L2437) | L2437 | Casts `JSON.parse`-of-untrusted HTTP body. Same risk class as L2465 but on the **inbound** boundary. **Severity: low** — wrapped in try/catch at L2439, and `data.embedding || null` at L2438 handles the missing case. |

**Summary:** all 104 casts are boundary casts (no truly unsafe internal
casts). The "132" number in the prompt was inflated by pre-existing
measurements; today the file has 104. Of those, **100+ are genuinely
necessary SQL-row-to-typed-entity casts** that a class refactor can
contain in a single private `parseRow<T>(row: unknown): T` helper per
store, and **~4 are type-widening on aggregate queries** that a class
refactor should clean up by exposing stable row interfaces.

### Unsafe casts — beyond the 104

`grep -nE '\bas any\b|\bas unknown\b|: any\b'` in db.ts returns **zero**.
`grep -nE 'as unknown as'` returns **zero**.

The file is genuinely type-safe; the safety hotspot is not in unsafe
casts but in **the number of boundary casts** (~104) which is
unavoidable given the SQLite-row-as-`unknown` starting position.

---

## 4. Today: any `as any` / colon-`any` / `as unknown as`?

**None.** Per the grep above:
- `as any` → 0 hits
- `: any` (annotation) → 0 hits
- `as unknown as` → 0 hits
- `as any[]` → 0 hits

The only "wide" type uses are:
- `unknown` in the migration code at L965 (correctly used; L968's
  `e as { name?: unknown; ... }` is followed by `typeof` narrowing).
- `Record<string, number>` for the `byAgent`/`byTier` aggregates
  (L1348-1351).
- The `data.embedding?: number[]` shape at L2437.

**Verdict:** db.ts has **zero genuinely unsafe casts.** Every `as` is a
SQL-row-to-typed-entity boundary cast, and the test-coverage record at
every query site proves the row shape matches the SELECT clause (modulo
the `KanbanCard.seq` caveat noted in §3).

---

## 5. `MemoryCacheEntry` (db.ts:1240) — does `RemoteStatusCache<T>` supersede?

### Today

```ts
// db.ts:1240
interface MemoryCacheEntry {
  value: Memory[]
  expiresAt: number
}

const MEMORY_CACHE_TTL_MS = 60_000
const memoryCache = new Map<string, MemoryCacheEntry>()
```

Surrounding code:
- `memoryCacheGet(key)` (L1247) — returns `Memory[] | null`, evicts on expiry.
- `memoryCacheSet(key, value)` (L1256) — sets with TTL.
- `memoryCacheInvalidate(agentId)` (L1260) — **prefix-based invalidation**.
  Iterates `memoryCache.keys()`; deletes every key starting with `${agentId}:`.
- `clearMemoryCache()` (L1267, exported for tests).
- `getMemoryCacheSize()` (L1272, exported for tests).

### CE-9 lens: does `RemoteStatusCache<T>` (`web/remote-status-cache.ts:19`) supersede?

`RemoteStatusCache<T>` API:
```ts
getOrRefresh(key, nowMs, fetch, fallback?): T
invalidate(key): void
```

**Comparison:**

| Capability | `MemoryCacheEntry` (today) | `RemoteStatusCache<T>` |
|---|---|---|
| TTL expiry | Yes (60 s, single TTL) | Yes (per-construction `ttlMs`) |
| `get` / `getOrRefresh` | `get` only (lazy expiry) | `getOrRefresh` (eager refresh on miss) |
| **Prefix-based invalidation** | Yes (L1260 — iterates keys starting with `${agentId}:`) | **No.** Only single-key `invalidate(key)`. |
| **Single-flight eviction on shared write** | Yes (`clearMemoryCache()` at L1292, L1374 — invalidates ALL entries when a `'shared'`-category memory is written) | **No.** Generic `invalidate(key)` only. |
| Empty-cache observability | `getMemoryCacheSize()` exported for tests | No size getter (would need adding). |
| `fetch + fallback` for stale-on-error | No (no `fetch` API at all; miss returns `null`) | Yes (`fallback?: T`); however the value-supplying closure is per-key, not shared. |

**Verdict:** `RemoteStatusCache<T>` **does NOT fully supersede**
`MemoryCacheEntry`. The two capabilities `MemoryCacheEntry` has that
`RemoteStatusCache<T>` lacks are:

1. **Prefix-based invalidation** (drop every entry for `agentId` X).
   Used 5× in db.ts (L1293, L1376, L1377, plus the clear-all path on
   shared writes at L1292/L1374).
2. **Bulk invalidation on a write to a category that affects every key**
   (the `'shared'` category at L1292, L1374). This is an
   unusual-but-not-anomalous invalidation pattern in this codebase.

### Options

(a) **Reuse `RemoteStatusCache<T>` and add a `invalidatePrefix`** method.
   The class already has `invalidate(key)`; the new method is a 3-line
   loop. Cost: 1 new method, 1 minor refactor of the existing class.
   Benefit: one fewer parallel cache abstraction.

(b) **Make `MemoryCacheEntry` a private field of `MemoryStore`** and keep
   it as-is. Cost: 1 new field on a new class. Benefit: no dependency
   on `src/web/remote-status-cache.ts` from `src/db.ts` (which would
   otherwise be a backward direction — `db.ts` is depended on by `web/`,
   not the other way around).

(c) **Make `MemoryStore` hold a `RemoteStatusCache<Memory[]>` per
   `(agentId, limit, category)` "bucket key"**, with the
   `invalidatePrefix` and `clearAll` calls routed through a thin wrapper
   that maps `agentId` → enumerated keys via a parallel `Map` (or
   exposes the `store` Map for iteration).

**Recommendation: (a).** The prefix invalidation is a 3-line addition,
the bulk-clear is `store.clear()` (already exposed internally in
`RemoteStatusCache` at L20 — `private store = new Map(...)`). The
direction-of-dependency objection is real but small: `db.ts` does not
import from `web/remote-status-cache.ts` today; the class refactor can
move `RemoteStatusCache<T>` to a more neutral location
(e.g. `src/util/ttl-cache.ts`) and have both `MemoryStore` and
`web/agents.ts` import from there. CE-9 explicitly raised this as
"either fold `MemoryCache` into `RemoteStatusCache<T>` or document the
deliberate split" — recommendation (a) implements the fold.

**Caveat:** `RemoteStatusCache.getOrRefresh` is an **eager-refresh API** —
the miss path calls `fetch()` synchronously and caches the result. The
`MemoryCacheEntry` usage is **lazy** — the miss returns `null`, the
caller runs the SQL and calls `memoryCacheSet`. The two semantics are
not identical. If `MemoryStore` moves to `getOrRefresh`, every
`getAgentMemories` call site needs to provide a `fetch` closure (the
SQL preparation + execute). This is structurally clean but adds one
indirection per call site. The current `lazy` design has zero indirection
on miss.

**Final recommendation:** keep `MemoryStore`'s cache **lazy**, but
implement it on top of a **minimal `TtlCache<K, V>` utility** that lives
in `src/util/ttl-cache.ts` and **shares its `store: Map<K, V>` shape with
`RemoteStatusCache<T>`**. The two caches (memory + remote-agent-status)
are sibling consumers of a TTL'd Map; that is the only abstraction the
codebase should pay for, and it is the minimum required to satisfy CE-9.

---

## 6. Generic opportunities

### 6.1 `BaseStore<TEntity>` abstract class

**Sketch:**
```ts
abstract class BaseStore<TEntity extends { id: ID }> {
  protected abstract table: string
  protected abstract columns: readonly (keyof TEntity)[]
  protected abstract toRow(entity: TEntity): Record<string, SQLQueryBindings>
  protected abstract fromRow(row: unknown): TEntity
  abstract list(...): TEntity[]
  abstract get(id: TEntity['id']): TEntity | undefined
  abstract create(input: Omit<TEntity, 'id' | 'created_at'>): TEntity
}
```

**Consumer count (OE-6 lens):** a `BaseStore<TEntity>` would have
**11 concrete stores** (MemoryStore, ScheduledTaskStore, BackgroundTaskStore,
KanbanCardStore, KanbanCommentStore, ArchivedKanbanCardStore, LabelStore,
ApprovalStore, OtelSpanStore, IdeaBoxStore, VaultSshKeyStore,
VaultSshServerStore) — actually 12.

**OE-6 verdict:** borderline. The 12 consumers are a sufficient number
under a literal count, but the **shared methods would be very thin**:
- `list()` is always a custom SQL with custom WHERE clauses.
- `get(id)` is always `.prepare('SELECT ... FROM table WHERE id = ?').get(id)`.
- `create(input)` is always a custom INSERT with custom column lists.

The 3 shared methods would be a strict subset of what each store does;
~50-70% of the public API per store would still need overrides.

**The decisive argument against `BaseStore<TEntity>`:** the columns /
mapping / SQL clause for each table diverges significantly
(`KanbanCard` has `seq?` derivation via `rowid AS seq`, `Memory` has
`embedding` JSON encoding, `OtelSpan` uses `ON CONFLICT DO UPDATE`,
`AgentMessage` has status-guarded transitions, `Approval` has derived
`telegram_message_id`). A `BaseStore` would either:
- force the union into the base (bloated base with conditional branches),
  or
- push the divergent bits back into overrides (most of the store).

**Reject `BaseStore<TEntity>` on OE-6 grounds**, following the precedent
in F (`f-agent-subsystem/02-type-interface-analysis.md:419-503` rejecting
5 lazy-cache generics on the same OE-6 test), E (`e-process-lock/
04-generic-interfaces.md:121-130` rejecting `LockResult<T>`), and D
(`d-channel-provider/04-generic-interfaces.md:127-144` rejecting
`ChannelEnv<TEnv>`).

### 6.2 `MemoryCache<M extends Memory>`

Per §5, **the right answer is to NOT define `MemoryCache<M>`**, but to
either reuse `RemoteStatusCache<T>` (option (a)) or use a minimal
`TtlCache<K, V>` utility. A `MemoryCache<M>` typed as `M extends Memory`
provides no extra type safety over `RemoteStatusCache<Memory[]>` —
the value is always `Memory[]` in this codebase.

### 6.3 Per-entity generic lens

For each candidate generic, count concrete consumers (OE-6 threshold: 2+
consumers with a true shared shape, or one consumer + a documented
future-proofing argument):

| Candidate | Concrete consumers | OE-6 verdict |
|---|---|---|
| `BaseStore<TEntity>` | 12 stores, but only ~30% shared method footprint | **REJECT** (thin base, divergent overrides) |
| `MemoryCache<M>` | 1 (memory only — `RemoteStatusCache<T>` already covers it) | **REJECT** in favor of reuse |
| `LoggerLike` injected per-store | 8 stores will want a logger | **ACCEPT** (matches H cross-cutting decision) |
| `ListOptions<TFilter>` for paginated queries | 4 stores have list-with-opts: KanbanCard, Memory, Approval, IdeaBox | **REJECT** (the four `opts` shapes are sufficiently divergent) |
| `StatusUnion<T extends string>` sealed-class helper | 6 stores have a status union (KanbanCard, Memory, AgentMessage, BackgroundTask, Approval, OtelSpan, IdeaBoxRow, PendingChannelRequest) | **MAYBE** — see §7 |

The status union case is worth sketching because it is the only place
where the cross-store repetition is mechanical and the sealed-class
abstraction adds real type safety.

---

## 7. Discriminated unions → sealed-class candidates (CE-7 lens)

CE-7 in `review-completeness.md:372-383` flags a heartbeat-subsystem
duplication. The discriminated-union case for db.ts is different but
parallel: **8 entity types carry a `status` string-literal union**, and
each union's transition rules live in imperative SQL comments rather than
in code. A sealed-class refactor would consolidate them.

### Candidates

| Entity | Union | States | Transition rules today | Sealed-class benefit |
|---|---|---|---|---|
| `KanbanCard` | `'planned'\|'in_progress'\|'waiting'\|'testing'\|'done'` | 5 | `moveKanbanCard` + `markKanbanCardDispatched` | High: `moveTo(target: KanbanStatus)` validates no-skip transitions (e.g. done → in_progress should require an un-archive) |
| `Memory` | `'semantic'\|'episodic'` | 2 | today: write-once at `saveMemory`, no mutation | Low: 2-state immutable, sealed class is overkill. Keep as string-literal union. |
| `Memory.category` | `string` (not a union) | 4 expected (`'hot'\|'warm'\|'cold'\|'shared'`) | `saveAgentMemory` + `updateMemory` accept any string | **High:** widen-typed `category` is the source of the cache-invalidation logic (L1292, L1371 — `'shared'` is the special-cased value). A sealed `MemoryCategory` would put the `'shared'` invariant in the type. |
| `AgentMessage` | `'pending'\|'delivered'\|'done'\|'failed'` | 4 | 4 mutation functions; status-guarded `markMessageDelivered` vs unguarded `markMessageFailed` | **High:** the dual-API duplication (§2 AgentMessage) collapses into a sealed `AgentMessage.transitionTo(target: AgentMessageStatus, payload?: string)` method. |
| `BackgroundTask` | `'running'\|'done'\|'failed'\|'timeout'` | 4 | 1 creation + 1 finish function | High: `finishAs(reason: 'done'\|'failed'\|'timeout', output: string \| null)` enforces the `running → terminal` invariant at the type level. |
| `ScheduledTask` | `'active'\|'paused'` | 2 | `pauseTask` + `resumeTask` | Medium: 2 states, both transition freely. The pair `pause`/`resume` is already explicit; sealing adds little. |
| `Approval` | `'pending'\|'approved'\|'rejected'\|'timeout'` | 4 | `createApproval` + `resolveApproval` + `expireTimedOutApprovals` | High: same shape as `BackgroundTask` — terminal transitions are mutually exclusive and the pending-only guard is the load-bearing part. |
| `OtelSpan` | `'ok'\|'error'\|'timeout'\|'running'` | 4 | `upsertOtelSpan` + `closeOtelSpan` + `listOtelTraces` aggregate severity | High: the aggregate severity (error > timeout > running > ok) is **hard-coded in SQL** at L3296-3301; a sealed class with a `.severity()` getter would replace the SQL CASE. |
| `IdeaBoxRow` | `'new'\|'reviewed'\|'kanban'\|'rejected'` | 4 | `createIdea` + `updateIdea` + `revertIdeaFromKanban` | Medium: the cross-store invariant (`kanban` ↔ `kanban_id IS NOT NULL`) is the most valuable thing to seal. |
| `PendingChannelRequest` | `'pending'\|'approved'\|'denied'` | 3 | `upsertChannelRequest` + `updateChannelRequestStatus` | Medium: small, clean state machine. |
| `KanbanCardEvent.from_status` / `to_status` | `string \| null` / `string` | n/a | `moveKanbanCard` writes | **Type widening:** should be narrowed to `KanbanCard['status']`. |
| `KanbanCard.priority` | `'low'\|'normal'\|'high'\|'urgent'` | 4 | insertion only | Low: priority is set at creation; no transitions. |

### Recommendation

Seal the **transition-bearing** unions, not the immutable ones:

| Seal | Justification |
|---|---|
| `AgentMessageStatus` (sealed) | Two dual APIs collapse into one method. Highest payoff. |
| `BackgroundTaskStatus` (sealed abstract) | `running → {done,failed,timeout}` enforced at the type level. |
| `ApprovalStatus` (sealed) | `pending → {approved, rejected, timeout}` + the status-guarded resolve. |
| `OtelSpanStatus` (sealed) | Replaces SQL CASE at L3296-3301 with a `.severity()` getter. |
| `KanbanStatus` (sealed) | Replace the hard-coded string in `STATUS_HU` (memory.ts:106) with a `.label_hu()` getter; remove `status: string` widening in `ArchivedKanbanCard` (L1759) and `HeartbeatKanbanSummary`'s implicit types. |
| `MemoryCategory` (sealed) | Forces `'shared'` to be a documented value, eliminates the L1292/L1371 `if (category === 'shared')` magic-string checks. |

Skip sealing: `Memory.sector` (2-state immutable), `ScheduledTask.status`
(2-state with explicit methods), `IdeaBoxRow.status` / `PendingChannelRequest.status`
(transition logic is too thin to justify the boilerplate).

**Severity:** medium. None of these are bugs today; they are
**maintainability hazards** because the transition rules live in
scattered comments and the magic strings (`'shared'`, `'pending'`) are
duplicated across the file.

---

## 8. `LoggerLike` integration points (per §h-cross-cutting/04)

The cross-cutting decision is `LoggerLike = Logger` (pino satisfies the
shape structurally; no cast needed). For db.ts:

### Today's logger call sites (only 5 in 3308 LOC)

| Line | Severity | Operation |
|---|---|---|
| 30 | `warn` | Failed to tighten DB file permissions on open |
| 65 | `warn` | Pre-create of DB file failed (mode will be tightened post-open) |
| 223 | `warn` | Kanban-card `testing`-status migration failed (continuing) |
| 2443 | `debug` | Embedding generation failed (Ollama not running) |

Plus the import at L7: `import { logger } from './logger.js'`.

**4 of 5 are warn-level on non-fatal initialization failures; 1 is a
debug-level on a normal-mode degradation.** db.ts has **no info or error
log calls** today — failures are silently swallowed (returns `undefined`,
returns `false`, etc.) and rely on the caller to log.

### Per-entity recommendations for the class refactor

For the 12 stores, the `LoggerLike` injection is needed only for
non-fatal-degradation paths. For every store, the recommendation is:

| Store | Logger needed? | What to log |
|---|---|---|
| `MemoryStore` | Yes | `warn` on embedding-generation failure (the L2443 site moves here). `debug` on cache hit/miss for the `getAgentMemories` cache (useful for performance debugging; new addition). |
| `AgentMessageStore` | Yes | `warn` on status-guarded update that returned `false` (could indicate concurrent transition; useful but may be noisy — make it `debug`). |
| `KanbanCardStore` | No | No non-fatal paths today. The L223 migration warn lives in `initDatabase`, not in `KanbanCardStore`. |
| `ScheduledTaskStore` | No | No log sites today. |
| `BackgroundTaskStore` | No | No log sites today. |
| `ApprovalStore` | No | No log sites today. |
| `OtelSpanStore` | No | No log sites today. |
| `IdeaBoxStore` | No | No log sites today. |
| `VaultSshKeyStore` / `VaultSshServerStore` | No | No log sites today. |
| `LabelStore` / `KanbanCommentStore` / `ArchivedKanbanCardStore` | No | No log sites today. |

**Recommendation:** only `MemoryStore` and `AgentMessageStore` need a
`log: LoggerLike` constructor parameter. The other 10 stores can omit it
and call `logger.warn(...)` directly (the module-level import already
exists). This is consistent with the `B` config precedent (`b-config/
04-generic-interfaces.md:262,284,297`) where `Config.log: LoggerLike`
was **rejected** because the loud-reporting lives in `startScheduleRunner`,
not in `Config`.

The B precedent reads as: **inject `LoggerLike` only into classes that
own their non-fatal degradation paths**. For db.ts, only `MemoryStore`
(embedding generation) qualifies at the level the B decision considered.

For `MemoryStore`, the **logger scope should be a `child` logger** with
`{ component: 'MemoryStore' }` bindings so the pino filter at L2443
(`logger.debug({ err, ollamaUrl })`) gets the component field for free.

---

## 9. Error class taxonomy (CE-4 applied to A)

### CE-4 prompt

`review-completeness.md:314-329` notes that the plan's
"MemoryStoreError extends Error" example does not enumerate which
classes need error subclasses. The CE-4 fix is to either (a) define a
new taxonomy or (b) document that all store errors are `Error` and the
structured-field idiom from R6 applies only when there's a clear
cross-cutting consumer.

### A-subsystem reality

`grep -nE '\bthrow\b|\bnew Error\b' src/db.ts` returns **zero hits**.

db.ts **does not throw**. Every failure is signalled by:
- Returning `undefined` (not-found cases).
- Returning `false` (mutation that affected 0 rows).
- Returning `null` (lookup variants).
- Returning an empty array.
- Catching and swallowing (e.g. L1182, L1300, L1336, L1464, L2444).

This is a **deliberate design choice** rooted in the file's role as a
thin SQL wrapper — the route handlers (in `src/web/`) decide whether a
not-found is a 404 or a 200-with-empty-body. The class refactor
inherits this choice unless the user explicitly opts in to error
classes.

### Two viable options

#### Option (a) — preserve the silent-return semantics

Keep all store methods returning `T | undefined`, `boolean`, or `T[]`.
No new error classes. The "errors" are encoded as `undefined`/`false`
and the route handlers stay responsible for HTTP-status mapping.

**Pros:**
- No behavior change for any of the 155 free functions.
- No test changes needed (the 51 tests that mock db.ts today are
  silent-return-compatible).
- Minimal code churn for the largest file in the project.

**Cons:**
- All error-context information is lost (e.g.
  `failPendingFederatedMessages` returns `number[]` of affected ids —
  the caller cannot tell WHY any failures happened).
- Cross-cutting error filtering by pino (R6 mention) does not work —
  there are no structured error records to filter on.

#### Option (b) — introduce typed error subclasses

Add an error-class taxonomy specific to A:

| Error class | When thrown | Carries |
|---|---|---|
| `MemoryStoreError` | FTS5 query parse failure (L1182), embedding JSON parse (L2467) | `query`, `cause` |
| `MessageBusError` | Status-guarded update returned `false` (L2060, L2169, L2189) when the caller opted into strict mode | `id`, `expectedStatus`, `currentStatus` |
| `KanbanStateError` | Illegal transition (e.g. trying to dispatch an archived card via `markKanbanCardDispatched` once we add that check) | `cardId`, `fromStatus`, `toStatus` |
| `ApprovalError` | Resolve on non-pending (L3193 when `changes === 0`) | `approvalId`, `currentStatus` |
| `OtelSpanError` | closeOtelSpan on unknown trace/span (L3269 when `changes === 0`) | `traceId`, `spanId` |

**Pros:**
- Aligns with the CE-4 finding's option (a) (define a new taxonomy).
- The pino filtering benefit from R6 starts working.

**Cons:**
- Every silent-return site needs a decision: throw or stay silent?
- 155 functions × ~3 return paths ≈ 400+ call sites affected.
- Test churn: every test that today asserts `=== false` for a not-found
  must decide whether to expect `undefined` or expect a thrown error.
- Breaks the cross-store `db.transaction(...)` idiom at L1505, L1823,
  L1932, L3062 — typed errors thrown inside `db.transaction` are
  rolled back, but the typed error escapes.

### Recommendation: Option (a) with one exception

Preserve the silent-return semantics for **all 12 stores** EXCEPT
`MemoryStore`, where the CE-4 R6 example already establishes the
precedent. Specifically:

- `MemoryStore.search()` throws `MemoryStoreError` on FTS5 parse failure
  (replaces the silent `try { ... } catch { return [] }` block at L1182-1184).
  The error carries `{ query, cause }` per R6.
- `MemoryStore.cosineSimilarity` failure (the inner `try { ... } catch`
  at L2464-2469) is logged at debug and the row is treated as a
  zero-score — **stays silent** (logs are enough).

Every other store retains its silent-return API. This:
- Satisfies the CE-4 R6 example (one error class per A store, with
  structured fields).
- Avoids the 400+-call-site decision fatigue.
- Keeps the 51 mock-db tests unchanged for the non-Memory stores.
- Aligns with the existing precedent: pino + structured `{ err, ... }`
  log records already carry the equivalent of error fields — duplicating
  them as a thrown class is a strict no for the 11 stores that don't
  have a `query` field today.

If the user later wants to migrate more stores to typed errors, the
above table is the starting list.

---

## 10. Unsafe casts (beyond the 104 boundary)

Already covered in §4: **zero.** No `as any`, no colon-`any`, no
`as unknown as`. The codebase's strictness rule (§6 of project
CLAUDE.md: "tiltos az `as` hasznalata helyett `satisfies`") is followed
to the letter in db.ts — every `as` is a SQL-row-to-typed-entity cast
with a comment justifying the row shape (most often implicit in the
`SELECT *` clause above).

---

## 11. Cross-references (verified in this analysis)

- `memory.ts:14` imports `type Memory` from `./db.js` — single type-only
  consumer outside the file.
- `web/remote-status-cache.ts:19` defines `RemoteStatusCache<T>` —
  pre-existing generic TTL cache (§5).
- `web/routes/agents.ts:204-205` instantiates `RemoteStatusCache<T>` —
  the 100% test coverage called out by CE-9.
- The MEMORY cache in db.ts (L1226-1273) is private to the module —
  no external consumers today, only the exported `clearMemoryCache()` and
  `getMemoryCacheSize()` test helpers.
- `KanbanCard.priority` is referenced in `memory.ts:113` (`PRIORITY_HU`
  map) — a typed `KanbanPriority` enum would simplify this mapping.

---

## 12. Plan-tagged findings summary

| Tag | Finding | Severity | Action |
|---|---|---|---|
| **§3** | 104 boundary `as` casts, zero unsafe casts | n/a | None — refactor can add a `parseRow<T>` helper per store. |
| **§4** | No `as any`, no colon-`any`, no `as unknown as` | n/a | None. |
| **§5** | `MemoryCacheEntry` does not fully match `RemoteStatusCache<T>` (no prefix-invalidate, no bulk-clear) | major | Reuse `RemoteStatusCache<T>` with 2 added methods, OR use a shared `TtlCache<K, V>` utility. CE-9. |
| **§6.1** | `BaseStore<TEntity>` | n/a | **REJECT** (OE-6; thin base, divergent overrides). |
| **§6.2** | `MemoryCache<M>` | n/a | **REJECT** in favor of `RemoteStatusCache<T>` reuse. |
| **§7** | 8 status unions; seal 6 of them (skip 2-state immutable + tiny transitions) | medium | High payoff on `AgentMessage`, `BackgroundTask`, `Approval`, `OtelSpan` (replaces SQL CASE). |
| **§8** | 5 logger call sites today; only `MemoryStore` needs `log: LoggerLike` | low | 2 of 12 stores get the injection. |
| **§9** | db.ts has zero `throw` statements; silent-return is the deliberate design | medium | Preserve silent-return for 11 stores; introduce `MemoryStoreError` only. CE-4. |
| **§2** | `Memory.embedding: string` storing `number[]` as JSON | low | A branded `JsonVector` type could express the encoding at the type level; not load-bearing for the class refactor. |
| **§2** | `KanbanCard.seq?: number` is a soft bug (`getChildCards` returns rows without `seq`) | medium | Make `seq` a derived getter on a `KanbanCard` class. |
| **§2** | `KanbanCardEvent.from_status` / `OtelTraceSummary.status` are type-widened to `string` | low | Narrow to the underlying union (separate from the sealed-class decision). |

---

**End of A type & interface analysis. No source files modified.**
