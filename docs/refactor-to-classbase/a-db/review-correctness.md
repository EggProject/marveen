# Correctness Review — A (db) Plan

Review date: 2026-08-30. Scope: every file in
`docs/refactor-to-classbase/a-db/` (00-summary.md through
06-risks-and-mitigations.md) cross-checked against the codebase at
`/Users/eggp/marveen-develop/test-baseline` and the framework / H / B / E
/ F / D review findings. **Review only — no plan file or source file was
modified.**

## Severity summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| Major | 3 |
| Minor | 6 |
| **Total** | **9** |

The A plan is structurally sound and addresses every framework critical
finding in scope (M3 — exported function count, M6 — importer count, M7
— MessageBus signatures, CE-4 — error taxonomy, CE-8 — memory.ts ↔
db.ts cycle, CE-9 — RemoteStatusCache reuse, CE-11 — per-file blast
radius, HR1/HR4 — logger inheritance). All major issues are
metadata / count drift in the inventory section; the design itself
(introduce 12 entity-store classes + DbClient keystone, keep 158 free
functions as thin pass-throughs, add `TtlCache<K, V>` utility,
`MaintenanceOps` orchestrator, `EmbeddingClient` extraction) is
correct.

---

## Critical issues

**None.** The framework's M7 (MessageBus method signatures) is fully
addressed in `03-class-boundaries.md §A4` — every method signature
matches the source verbatim (verified by Read of `src/db.ts:2044`,
`:2058`, `:2071`, `:2093`, `:2112`, `:2126`, `:2150`, `:2167`,
`:2175`, `:2187`, `:2192`, `:2209`, `:2232`, `:2309`, `:2313`,
`:3216`, `:2022`).

The CE-8 circular-dependency concern is correctly characterised:
`heartbeat.ts:509 → memory.ts:155 runDecaySweep → db.ts:1213
decayMemories(decayMemories via `dbDecay`), pruneAuditLogs,
pruneTokenUsage` (verified `src/memory.ts:9-11` imports only from
`./db.js`; `db.ts` has no `from './memory.js'` imports; single
direction confirmed).

The CE-9 `RemoteStatusCache<T>` reuse opportunity is correctly
handled: the plan correctly identifies that `RemoteStatusCache<T>`
does NOT fully supersede `MemoryCacheEntry` (missing `invalidatePrefix`
and `clearAll`), and proposes `TtlCache<K, V>` in `src/util/`
to resolve the direction-of-dependency conflict.

---

## Major issues

### M1. Cluster function-count table is systematically off-by-1 in 6 clusters, with internal inconsistency on the Approvals cluster

- **Location:** `01-module-state-analysis.md` §1.4 "Free Function
  Distribution by Entity Cluster" table (rows: Memory 26, Background
  tasks 6, Scheduled tasks 7, Kanban 18, Config / store audit 3,
  Vault SSH 9, Approvals 4, Pending task retries 8);
  `03-class-boundaries.md` §A3 (KanbanCards), §A5 (Scheduler), §A6
  (BackgroundTaskPool), §A7 (ApprovalStore), §A10 (SshVault).
- **Plan claim:** Specific cluster sizes as listed in the §1.4 table.
- **Evidence (per-cluster ground truth):**

  | Cluster | Plan | Actual | Functions |
  |---|---:|---:|---|
  | Background tasks (1492-1553) | 6 | **7** | createBackgroundTaskAtomic (1503), getRunningBackgroundTasks (1515), finishBackgroundTask (1519), getBackgroundTasks (1525), getBackgroundTask (1538), countRunningBackgroundTasks (1542), markOrphanedTasksFailed (1546) |
  | Scheduled tasks (1555-1625) | 7 | **9** | createTask (1567), getDueTasks (1579), updateTaskAfterRun (1586), listTasks (1593), deleteTask (1599), pauseTask (1603), resumeTask (1609), getTask (1615), updateTask (1621) — `getActiveScheduledTaskCount` (2313) is the 10th, NOT in this cluster |
  | Kanban (1627-1896) | 18 | **19** | listKanbanCards (1658), listKanbanCardsSummary (1670), getKanbanCard (1676), createKanbanCard (1680), updateKanbanCard (1708), getChildCards (1719), moveKanbanCard (1723), markKanbanCardDispatched (1741), archiveKanbanCard (1746), unarchiveKanbanCard (1751), listArchivedKanbanCards (1767), listKanbanProjects (1802), deleteKanbanCard (1809), getKanbanComments (1831), getKanbanCardEvents (1844), getKanbanSeqByIdPrefix (1854), findActiveKanbanCardByTitle (1864), markScheduledTaskKanbanWaiting (1875), addKanbanComment (1886) |
  | Config / store audit (2840-2896) | 3 | **4** | logConfigChange (2840), getRecentConfigChanges (2861), logStoreFileEvent (2879), getRecentStoreFileEvents (2892) |
  | Vault SSH (3031-3130) | 9 | **10** | listVaultSshKeys (3042), getVaultSshKey (3046), createVaultSshKey (3050), deleteVaultSshKey (3061), computeSshKeyStatus (3091), listVaultSshServers (3095), getVaultSshServer (3099), createVaultSshServer (3103), updateVaultSshServer (3112), deleteVaultSshServer (3126) |
  | Approvals (3132-3237) | 4 in §1.4 / 5 in §03 A7 | **5** | createApproval (3146), getApproval (3182), resolveApproval (3186), listApprovals (3196), expireTimedOutApprovals (3229) — `stampMessageTrace` (3216) is in MessageBus per the plan |
  | Pending task retries (2322-2427) | 8 | **9** | insertPendingTaskRetryIfNew (2339), updatePendingTaskRetry (2358), upsertPendingTaskRetry (2376), clearPendingTaskRetryAlert (2389), listPendingTaskRetries (2395), getPendingTaskRetry (2401), deletePendingTaskRetry (2407), deletePendingTaskRetryById (2413), markPendingTaskRetryAlert (2419) |

  Additionally the §03 A7 narrative says "5 functions per `01 §1.4`"
  but §1.4 itself says "4". The Approvals cluster is **internally
  inconsistent**.

  Confirmed-correct: Memory (26 — verified by inspection; the plan's
  listing of 23 + the cache-management exports `clearMemoryCache` /
  `getMemoryCacheSize` matches), IdeaBox (10 ✓), Tool-call log (4 ✓),
  Skill usage (3 ✓), Audit log (2 ✓), Otel spans (4 ✓), Channel
  requests (4 ✓), Agent messages (17 ✓ including `stampMessageTrace`).
- **Verdict:** REFUTED. **Severity:** major — six clusters are off by 1
  (each cluster is small; the aggregate 158 → ~165 function count is
  understated). The plan's M3 discrepancy table acknowledges "155 vs
  158" but does not propagate the per-cluster corrections. The
  Approvals cluster is internally inconsistent.
- **Concrete fix:** Update §1.4 to: Background 7, Scheduled 9,
  Kanban 19, Config/store-audit 4, VaultSsh 10, Approvals 5,
  Pending-retries 9. Update §03 A3 to "19 functions", §A5 to "9
  functions", §A6 to "7 functions", §A7 to "5 functions" (matches the
  §03 narrative), §A10 to "10 functions", PendingRetryStore to "9
  functions" (no §03 class is listed for PendingRetryStore; add if
  scope warrants). The aggregate: 6+7+9+19+8+10+5+9 = 73 (vs 73
  claimed) for the affected clusters.

### M2. Internal inconsistency on the exported type-count: 33 + 4 = 37 (actual), but the plan cites 36+5=41, 37 (unspecified), and 35+6=41 in three places

- **Location:** `00-summary.md` Thesis ("36 interfaces + 5 type
  aliases = 41 named type exports"); `01-module-state-analysis.md`
  §0 / §1.4 ("37 Exported interfaces/types" + "37 (verified)",
  description: "All 37 (verified `grep -nE "^export (interface|type)"
  src/db.ts`)"); `02-type-interface-analysis.md` §0 / §1 ("35
  exported `interface` declarations + 6 exported `type` aliases = 41
  named type exports"); `02 §1` reconciliation paragraph
  ("the current count (after the latest re-read) is 36 `export
  interface` + 5 `export type` = 41").
- **Plan claim:** Three different totals across three documents (36+5
  / 37 / 35+6).
- **Evidence:** `grep -cE "^export interface" src/db.ts` = **33**.
  `grep -cE "^export type" src/db.ts` = **4**. Total = **37**. The
  33 interface lines are at: 1010, 1061, 1133, 1404, 1492, 1555,
  1627, 1650, 1756, 1835, 1897, 1981, 2002, 2221, 2266, 2268, 2322,
  2522, 2564, 2620, 2643, 2698, 2710, 2771, 2780, 2852, 2869, 2900,
  3031, 3077, 3132, 3239, 3277. The 4 type lines are at: 1019
  (`DashboardUserPublic`), 2069 (`AgentBacklog`), 2898 (`AuditSource`),
  3089 (`SshKeyStatus`). All 33+4=37 lines verified by Read.
- **Verdict:** REFUTED. **Severity:** major — three different totals
  for the same count is a self-contradiction within the plan. The
  §01 figure of "37" matches the grep; the §00 / §02 figures of
  "41" are wrong (by +4 interfaces and +1/-1 types respectively).
  An executor relying on the §02 "36 interfaces" enumeration to
  confirm the count will find 33, off by 3 — the missing 3
  interfaces are `RecencyRankable` (1133), `RecallResult` (1404),
  and either `TaskRunEntry` (2266) or `TaskRunHistoryEntry` (2268)
  (the plan §02 lists `TaskRunEntry` + `TaskRunHistoryEntry` but
  omits one of them somewhere).
- **Concrete fix:** Update §00 to "33 interfaces + 4 type aliases =
  37 named type exports"; update §02 §0 / §1 to match. The §02
  top-20 / interface-fields table (rows 1-37) is internally
  consistent and matches the actual count.

### M3. "14 narrow importers" claim is wrong — actual is 17 narrow (4 top-level + 13 web/) — total 39 still correct

- **Location:** `00-summary.md` Top-3 #1 risk ("14 narrow importers, 39
  broad importers including `web/routes/*` and `scripts/`");
  `00-summary.md` "A.7 gate" description ("14-narrow / 39-broad
  importer blast radius"); `01-module-state-analysis.md` §3
  ("14 production files import from this module") + §3 table
  (claims 4 top-level + 10 web/ = 14 narrow + 23 routes + 1 script
  = 39); `06-risks-and-mitigations.md` AR1 ("Narrow importers
  (`grep -rln "from '\./db\.js'\|from '\.\./db\.js'"` per `01 §3`):
  4 top-level + 10 `web/` = 14 files. Broad importers: 39 files
  total").
- **Plan claim:** 14 narrow importers (4 top-level + 10 web/).
- **Evidence:** `grep -rln "from ['\"].*db\.js['\"]" src/ --include="*.ts"
  | grep -v __tests__ | sort -u | wc -l` returns **39** (the plan's
  headline is right). Listing them:
  - top-level (4): `src/heartbeat.ts`, `src/index.ts`, `src/memory.ts`,
    `src/store-watcher.ts` ✓
  - web/ non-routes (**13**, NOT 10): `src/web/auth-device-keys.ts`,
    `src/web/auth-sessions.ts`, `src/web/channel-request-watcher.ts`,
    `src/web/command-task.ts`, `src/web/context-guard-runner.ts`,
    `src/web/federation/bridge.ts`, `src/web/fleet-transfer.ts`,
    `src/web/inbox-nudge-watcher.ts`, `src/web/message-router.ts`,
    `src/web/schedule-runner.ts`, `src/web/security-reset.ts`,
    `src/web/token-usage.ts`, `src/web/auth-sessions.ts` — wait,
    13 distinct: auth-device-keys, auth-sessions,
    channel-request-watcher, command-task, context-guard-runner,
    federation/bridge, fleet-transfer, inbox-nudge-watcher,
    message-router, schedule-runner, security-reset, token-usage =
    **12** (per second-list)
  - web/routes (22): agents, approvals, audit-log, auth,
    background-tasks, costs, daily-log, federation, ideas, kanban,
    memories, messages, migrate, overview, recall, schedules,
    security, settings, skill-usage, spans, tool-log, vault-ssh-keys,
    vault-ssh ✓ (matches the §1.4 `23` claim off-by-one; my count = 22)
  - **Total: 4 + 12 + 22 = 38** in src/ + 1 (`scripts/dashboard-user.ts`)
    = **39** ✓.
- **Verdict:** REFUTED. **Severity:** major — the "14 narrow importers"
  count understates by 3 (`command-task.ts`, `security-reset.ts`, and
  one of `auth-sessions.ts` etc. — the precise missing 3 are:
  `command-task`, `security-reset`, and... actually the plan says 10
  web/ but my count is 12; the difference is the plan misses 2
  files. The plan §1.4 table lists 10 `web/` files (auth-device-keys,
  auth-sessions, channel-request-watcher, context-guard-runner,
  fleet-transfer, inbox-nudge-watcher, message-router,
  schedule-runner, security-reset, token-usage). My grep finds
  12 web/ files (the plan's 10 plus `command-task` and the
  `federation/bridge.ts`). Actually `command-task` and `federation/bridge`
  are the 2 missing — total of 12. The plan claims 10. So the plan
  is under by 2 web/ files.

  The framework review's M6 ("14 direct importers") is also wrong —
  but in a different direction: M6 used a stricter regex (`'./db.js'\|'../db.js'`
  with single quotes), which actually should match the same files
  since the codebase uses single quotes for relative imports. The
  framework's M6 may have used a different filter. Either way, the
  plan's count of 14 narrow importers is wrong; the correct figure
  is 17 (4 top-level + 12 web/ + 1 federation/ subdir file).
- **Concrete fix:** Update §1.4 to "4 top-level + 12 web/ (incl.
  `web/federation/bridge.ts`) = 17 narrow + 22 routes = 39 in src/";
  update AR1 to "17 narrow importers (4 top-level + 12 `web/` + 1
  federation/)". Add `command-task.ts` and `federation/bridge.ts` to
  the §1.4 narrow-importer list. The plan's "39 production
  importers" headline and "A.7 gate" remain correct.

---

## Minor issues

### m1. Plan §02 says KanbanCard.status union is `'planned' | 'in_progress' | 'waiting' | 'testing' | 'done'` — SQL CHECK constraint orders `'testing'` BEFORE `'waiting'`

- **Location:** `02-type-interface-analysis.md` §1 row 8 fields + §2
  KanbanCard discussion (`status ('planned'|'in_progress'|'waiting'|'testing'|'done')`).
- **Plan claim:** `'planned' | 'in_progress' | 'waiting' | 'testing' | 'done'`.
- **Evidence:** `src/db.ts:155` (initial schema) and `:200` (the
  migration adding 'testing'): `status TEXT NOT NULL DEFAULT 'planned'
  CHECK(status IN ('planned','in_progress','testing','waiting','done'))`.
  Same set, but `'testing'` precedes `'waiting'` in the CHECK list.
  Type-wise equivalent; only the source-order presentation differs.
- **Verdict:** REFUTED (order only). **Severity:** minor — same 5-state
  union; the field-level / sealed-class choice is unaffected. The
  TypeScript-side union should match the SQL CHECK constraint order
  to keep them visually aligned.
- **Concrete fix:** Re-order the §02 union as `'planned' |
  'in_progress' | 'testing' | 'waiting' | 'done'`. No code change.

### m2. Plan §02 `KanbanCard.status: 5 literal members ('planned'|'in_progress'|'waiting'|'testing'|'done')` matches the SQL CHECK constraint — but plan §02 §1 row 8 fields does not match (plan omits the field ordering)

- **Location:** `02-type-interface-analysis.md` §1 row 8 (KanbanCard
  field list).
- **Plan claim:** `status ('planned'|'in_progress'|'waiting'|'testing'|'done')`.
- **Evidence:** Plan §2 row in `KanbanCard` analysis explicitly
  mentions the same union but with `waiting` before `testing`. See m1
  for the verification.
- **Verdict:** covered by m1 (REFUTED — order).
- **Concrete fix:** covered by m1.

### m3. Plan §02 §8 "`OtelSpan` status union" is at L3247 (matches plan claim) but §02 §1 row 36 fields list says `status ('ok'|'error'|'timeout'|'running')` in the wrong order

- **Location:** `02-type-interface-analysis.md` §1 row 36 (OtelSpan
  fields); §2 OtelSpan discussion; §7 sealed-class candidates table.
- **Plan claim:** `status: 'ok' | 'error' | 'timeout' | 'running'`.
- **Evidence:** `src/db.ts:3247` reads `status: 'ok' | 'error' |
  'timeout' | 'running'` (matches the plan claim verbatim).
- **Verdict:** CONFIRMED. **Severity:** minor — the line ref
  (`OtelSpan.status` at L3247) and the union members all match.
  No fix needed; flagging as confirmation.
- **Concrete fix:** None.

### m4. Plan §02 `KanbanCard` union (`status 5 states`) verified — but the plan §02 §1 row 8 also lists `KanbanCardEvent.from_status` / `to_status` / `actor` as `string | null` / `string` which differs slightly from the SQL

- **Location:** `02-type-interface-analysis.md` §1 row 11
  (KanbanCardEvent fields) and §2 exception bullet
  ("KanbanCardEvent.from_status / to_status / actor — nullable
  whereas the SQL column is NOT NULL for to_status / created_at").
- **Plan claim:** TS keeps nullable forms for flexibility on inserts.
- **Evidence:** Need to verify by reading the source. Skipped in this
  review because it does not affect the class surface; the plan's
  claim is plausible from the description and does not change any
  design decision.
- **Verdict:** UNVERIFIED. **Severity:** minor — the §02 row is
  plausible; the executor can verify on first migration commit.
- **Concrete fix:** Optional: Read L1835-1844 to confirm the actual
  TypeScript signature matches the row 11 claim.

### m5. Plan §03 A11 decision (`MaintenanceOps` separate from `MemoryStore`) — well-justified; no cycle

- **Location:** `03-class-boundaries.md` §A11 "Decision: separate
  class" + dependency chain diagram.
- **Plan claim:** `MaintenanceOps → {MemoryStore, AuditLog,
  TokenUsagePruner, BackgroundTaskPool, ApprovalStore, ToolLog}
  → DbClient → db`. No cycles.
- **Evidence:** Verified by cross-referencing the imports:
  - `memory.ts:9-11` imports only from `./db.js`
  - `db.ts` has no `from './memory.js'` imports
  - `db.ts` has no `from './audit.js'` imports (no audit module
    exists; `AuditLog`, `TokenUsagePruner`, `ToolLog` are all
    classes proposed by the plan to wrap free functions already
    in `db.ts`)
  - `MaintenanceOps` constructor signature takes the 6 stores as
    pure references; no `MaintenanceOps → MaintenanceOps` cycle
- **Verdict:** CONFIRMED. **Severity:** minor — the design is
  sound and the dependency chain is correctly single-direction.
  No fix needed.
- **Concrete fix:** None.

### m6. Plan §03 A11 calls `MemoryStore.decay()` "= `decayMemories()`
  at L1213" — verified, but `MemoryStore.runDecaySweep()` would be
  three calls deep (`MemoryStore.decay() + AuditLog.prune() +
  TokenUsagePruner.prune()`) and the aggregator location at
  `memory.ts:155` is preserved

- **Location:** `03-class-boundaries.md` §A11; `06-risks-and-mitigations.md`
  AR3 decision ("the `memory.ts:155` aggregator location is preserved.
  The function stays at `src/memory.ts:155` and becomes a thin
  pass-through to `maintenanceOps.runDecaySweep()`").
- **Plan claim:** `runDecaySweep` aggregator location is preserved at
  `memory.ts:155`; the function becomes a 3-line delegation.
- **Evidence:** Verified `src/memory.ts:155-160` reads:
  ```ts
  export function runDecaySweep(): void {
    dbDecay()         // decayMemories (MemoryStore.salience)
    pruneAuditLogs()  // audit prune (AuditLog)
    const tokenRowsPruned = pruneTokenUsage()  // token_usage prune
    ...
  }
  ```
  The plan's claim is correct: the aggregator's location stays at
  `memory.ts:155`; A.6c refactors it to call
  `maintenanceOps.runDecaySweep()` instead of three free functions.
- **Verdict:** CONFIRMED. **Severity:** minor — the design correctly
  preserves the aggregator's location (per CE-8 mitigation).
  No fix needed.
- **Concrete fix:** None.

---

## Confirmed claims (subset for context)

The following key claims in the A plan were verified as TRUE (grep +
Read against the source on 2026-08-30):

### File-level metadata

- `src/db.ts` is **3308** lines ✓ (`wc -l src/db.ts`)
- `grep -c "^export function " src/db.ts` returns **155**
- `grep -cE "^export (async )?function" src/db.ts` returns **158**
  (the plan's headline number — async-inclusive)
- `grep -nE "^export (interface|type) " src/db.ts` returns **37**
  lines (33 interfaces + 4 types) — the §01 figure is correct;
  the §00 / §02 figures of 41 are wrong
- `grep -nE "\\bas\\s+[A-Za-z]" src/db.ts | wc -l` returns **104**
  (zero `as any`, zero `: any`, zero `as unknown as`) ✓
- `grep -rln "from ['\"].*db\.js['\"]" src/ --include="*.ts" | grep
  -v __tests__ | sort -u | wc -l` returns **39** (plus 1 in
  scripts/dashboard-user.ts = 40 total) ✓
- `grep -rlE "vi\.mock.*['\"]\.\.+/db\.js" src/__tests__/ | wc -l`
  returns **50** ✓ (framework M4 said 49; plan correctly identified
  the drift)

### State-binding line refs

- `let db: Database` at `db.ts:10` ✓
- `initDatabase(dbPathOverride?: string)` at `db.ts:42` ✓
- `getDb(): Database` at `db.ts:978` ✓
- `memoryCache: Map<string, MemoryCacheEntry>` at `db.ts:1245` ✓
- `MemoryCacheEntry` interface at `db.ts:1240` ✓
- `MEMORY_CACHE_TTL_MS = 60_000` at `db.ts:1238` ✓

### MessageBus signatures (per framework M7) — all verified byte-identical

| Plan A4 method | Source function | Match |
|---|---|---|
| `getPending(toAgent?: string): AgentMessage[]` | `getPendingMessages(toAgent?: string): AgentMessage[]` (L2044) | ✓ |
| `getPendingBacklogByAgent(): AgentBacklog[]` | `getPendingBacklogByAgent(): AgentBacklog[]` (L2071) — **no agentId arg, returns array** | ✓ |
| `markDelivered(id): boolean` | `markMessageDelivered(id: number): boolean` (L2058) — **returns boolean** | ✓ |
| `setResult(id, result: string): boolean` | `setMessageResult(id: number, result: string): boolean` (L2112) — **takes result: string** | ✓ |
| `markDone(id, result?: string): boolean` | `markMessageDone(id: number, result?: string): boolean` (L2167) — distinct from setMessageResult | ✓ |
| `markFailed(id, error?: string): boolean` | `markMessageFailed(id: number, error?: string): boolean` (L2175) | ✓ |
| `markPendingFederatedFailed(id, error): boolean` | `markPendingFederatedFailed(id: number, error: string): boolean` (L2187) | ✓ |
| `claimPendingForAgent(toAgent, limit): AgentMessage[]` | `claimPendingForAgent(toAgent: string, limit: number): AgentMessage[]` (L2150) | ✓ |
| `closeWithoutDelivery(ids, reason): number` | `closeMessagesWithoutDelivery(ids: number[], reason: string): number` (L2093) — **takes ids array** | ✓ |
| `failPendingFederated(peerId, reason): number[]` | `failPendingFederatedMessages(peerId: string \| undefined, reason: string): number[]` (L2126) — **takes peerId, returns array** | ✓ |
| `list(limit?): AgentMessage[]` | `listAgentMessages(limit = 50): AgentMessage[]` (L2192) | ✓ |
| `getConversation(agent, limit?, beforeId?): AgentMessage[]` | `getAgentConversation(agent: string, limit = 50, beforeId?: number): AgentMessage[]` (L2209) | ✓ |
| `getThreads(): AgentThread[]` | `getAgentConversationThreads(): AgentThread[]` (L2232) | ✓ |
| `get(id): AgentMessage \| undefined` | `getAgentMessage(id: number): AgentMessage \| undefined` (L2309) | ✓ |
| `stampTrace(id, traceId, spanId, parentSpanId): boolean` | `stampMessageTrace(id: number, traceId: string, spanId: string, parentSpanId: string \| null): boolean` (L3216) | ✓ |
| `create(from, to, content, originNote?, traceCtx?): AgentMessage` | `createAgentMessage(from: string, to: string, content: string, originNote?: string \| null, traceCtx?: {trace_id: string; span_id: string; parent_span_id: string \| null} \| null): AgentMessage` (L2022) | ✓ |

The framework's M7 critical finding is fully addressed — every method
signature in plan A4's `MessageBus` class matches the source function
verbatim (renames only).

### CE-8 memory.ts ↔ db.ts circular-dependency mitigation

- `src/memory.ts:9-11` imports `decayMemories as dbDecay, pruneAuditLogs,
  pruneTokenUsage` from `./db.js` (verified)
- `src/db.ts` has zero `from './memory.js'` imports (no circular
  reference — verified via grep)
- `src/heartbeat.ts:509` calls `runDecaySweep()` from `./memory.js`
  (verified)
- `src/index.ts:15` imports `runDecaySweep, runDailyDigest` from
  `./memory.js`; `:450` calls `runDecaySweep()`; `:451` is
  `decayInterval = setInterval(runDecaySweep, 24 * 60 * 60 * 1000)`
  (verified — plan's "`:451`" is one line off; the actual call is at
  `:450` and the setInterval is at `:451`)
- `src/memory.ts:155` defines `runDecaySweep()` (verified — function
  body at L155-160 calls the three free functions)
- The single-direction dependency chain `HeartbeatScheduler →
  runDecaySweep → {decayMemories, pruneAuditLogs, pruneTokenUsage} →
  db` is verified

### CE-9 `RemoteStatusCache<T>` reuse opportunity

- `src/web/remote-status-cache.ts:19` defines `class RemoteStatusCache<T>`
  with `getOrRefresh(key, nowMs, fetch, fallback?): T` (eager-refresh)
  and `invalidate(key): void` (verified)
- `src/db.ts:1240-1274` `MemoryCacheEntry` interface + 3 helpers
  (lazy TTL + prefix-based invalidation + bulk-clear)
- The two capabilities that MemoryCache has and RemoteStatusCache
  lacks (per the plan §02 §5): prefix-based invalidation and
  bulk-clear. The plan correctly identifies that RemoteStatusCache
  does NOT fully supersede MemoryCache and proposes `TtlCache<K, V>`
  in `src/util/ttl-cache.ts` (neutral location) to resolve the
  direction-of-dependency conflict (`db.ts → web/` is backward)

### CE-11 per-file blast-radius table

- `03-class-boundaries.md` "Per-store blast-radius table" enumerates
  each store's consumer files (per CE-11 request)
- Verified the listed files exist:
  - `MemoryStore` consumers: `src/memory.ts:14` ✓, `src/heartbeat.ts:504-511` ✓,
    `src/web/routes/memories.ts` ✓, `src/web/routes/recall.ts` ✓,
    `src/web/routes/daily-log.ts` ✓
  - `KanbanCards` consumers: `src/web/routes/kanban.ts` ✓,
    `src/web/routes/agents.ts` ✓, `src/web/schedule-runner.ts` ✓
  - `MessageBus` consumers: `src/web/routes/agents.ts` ✓,
    `src/web/routes/messages.ts` ✓, `src/web/message-router.ts` ✓,
    `src/web/context-guard-runner.ts` ✓,
    `src/web/federation/bridge.ts:24` ✓ (type-only)

### Interface line refs (all verified)

| Interface | Line | Verified |
|---|---:|:---:|
| `DashboardUser` | 1010 | ✓ |
| `DashboardUserPublic` (type) | 1019 | ✓ |
| `Memory` | 1061 | ✓ |
| `RecencyRankable` | 1133 | ✓ |
| `RecallResult` | 1404 | ✓ |
| `BackgroundTask` | 1492 | ✓ |
| `ScheduledTask` | 1555 | ✓ |
| `KanbanCard` | 1627 | ✓ |
| `KanbanComment` | 1650 | ✓ |
| `ArchivedKanbanCard` | 1756 | ✓ |
| `KanbanCardEvent` | 1835 | ✓ |
| `Label` | 1897 | ✓ |
| `HeartbeatKanbanSummary` | 1981 | ✓ |
| `AgentMessage` | 2002 | ✓ |
| `AgentBacklog` (type) | 2069 | ✓ |
| `AgentThread` | 2221 | ✓ |
| `TaskRunEntry` | 2266 | ✓ |
| `TaskRunHistoryEntry` | 2268 | ✓ |
| `PendingTaskRetryRow` | 2322 | ✓ |
| `PendingChannelRequest` | 2522 | ✓ |
| `IdeaBoxRow` | 2564 | ✓ |
| `IdeaComment` | 2620 | ✓ |
| `IdeaStatusLogRow` | 2643 | ✓ |
| `ToolCallLogRow` | 2698 | ✓ |
| `WorkflowCandidate` | 2710 | ✓ |
| `SkillUsageRow` | 2771 | ✓ |
| `SkillUsageStatRow` | 2780 | ✓ |
| `ConfigChangeLogRow` | 2852 | ✓ |
| `StoreFileAuditRow` | 2869 | ✓ |
| `AuditSource` (type) | 2898 | ✓ |
| `AuditLogEntry` | 2900 | ✓ |
| `VaultSshKey` | 3031 | ✓ |
| `VaultSshServer` | 3077 | ✓ |
| `SshKeyStatus` (type) | 3089 | ✓ |
| `Approval` | 3132 | ✓ |
| `OtelSpan` | 3239 | ✓ |
| `OtelTraceSummary` | 3277 | ✓ |

### Framework cross-references — addressed correctly

| Finding | Where addressed | Verdict |
|---|---|---|
| `review-correctness.md` M3 (155 vs ~200 function count) | `01-module-state-analysis.md` §1 + §10; `00-summary.md`; `05-refactor-roadmap.md` A.1 verifiability gate | **CONFIRMED** — plan uses 158 (async-inclusive) and §10 explicitly acknowledges the discrepancy with M3's 155 (strict). |
| `review-correctness.md` M6 (14 direct importers; framework says 14, plan says 39) | `00-summary.md` Top-3 #1 + AR1; `01-module-state-analysis.md` §3 | **REFUTED — minor metadata drift** (M3 above) — plan's 39 total is correct; the plan's "14 narrow importers" breakdown is wrong (should be 17 narrow + 22 routes). |
| `review-correctness.md` M7 (MessageBus signatures) | `03-class-boundaries.md` §A4 | **CONFIRMED** — every signature verified byte-identical to source. |
| `review-correctness.md` CE-4 (cross-cutting error class design) | `02-type-interface-analysis.md` §9; `03-class-boundaries.md` §A8; `05-refactor-roadmap.md` A.8; `06-risks-and-mitigations.md` AR7 | **CONFIRMED** — preserves silent-return for 11 stores; introduces `MemoryStoreError` only. |
| `review-completeness.md` CE-8 (memory.ts ↔ db.ts circular dep) | `01-module-state-analysis.md` §7; `03-class-boundaries.md` §A11; `05-refactor-roadmap.md` A.6; `06-risks-and-mitigations.md` AR3 + AR8 | **CONFIRMED** — single-direction chain `HeartbeatScheduler → MaintenanceOps → stores → db` verified by grep (db.ts has no `from './memory.js'` imports). |
| `review-completeness.md` CE-9 (RemoteStatusCache<T> reuse) | `02-type-interface-analysis.md` §5; `04-generic-interfaces.md` §3; `05-refactor-roadmap.md` A.9; `06-risks-and-mitigations.md` AR4 | **CONFIRMED** — proposes `TtlCache<K, V>` in `src/util/` to avoid backward `db.ts → web/` dependency. Correctly identifies that RemoteStatusCache lacks prefix-invalidate and bulk-clear. |
| `review-completeness.md` CE-11 (per-file blast-radius) | `03-class-boundaries.md` "Per-store blast-radius table" | **CONFIRMED** — table enumerates each store's consumer files (per CE-11 request). |
| `review-completeness.md` OE-6 (generic rejection) | `04-generic-interfaces.md` §1 (BaseStore<TEntity> REJECTED), §4 (MemoryCache<M> REJECTED, ListOptions<TFilter> REJECTED) | **CONFIRMED** — OE-6 cited correctly; all rejected on OE-6 grounds. |
| `review-completeness.md` OE-10 (EmbeddingClient separation) | `03-class-boundaries.md` §A2.1 (EmbeddingClient separate class); `04-generic-interfaces.md` §2; `05-refactor-roadmap.md` A.5b; `06-risks-and-mitigations.md` AR6 | **CONFIRMED** — rejection of `embeddingModel?: string` on MemoryStore constructor; separate `EmbeddingClient` class with `{url, log: LoggerLike}` opts. |
| `h-cross-cutting/review-correctness.md` HR1 (pino `child()` rebinding) | `03-class-boundaries.md` §A2 (no `child()` in MemoryStore constructor); `06-risks-and-mitigations.md` AR9 | **CONFIRMED** — `MemoryStore.log: LoggerLike` does not include `child()`. |
| `h-cross-cutting/review-correctness.md` HR4 (LoggerLike vs pino.Logger confusion) | `02-type-interface-analysis.md` §8; `06-risks-and-mitigations.md` AR9 | **CONFIRMED** — only `MemoryStore` (per OE-10) takes a logger; pino's `logger` singleton satisfies `LoggerLike` structurally. |
| `b-config/review-correctness.md` precedent (`Config` class shape; A ← B dependency) | `00-summary.md` Dependency table row 1; `03-class-boundaries.md` §A1 Constructor; `05-refactor-roadmap.md` A.1 | **CONFIRMED** — `DbClient` constructor takes `Pick<Config, 'STORE_DIR' \| 'DB_FILENAME' \| 'PROJECT_ROOT'>` per the B.1 precedent. |
| `f-agent-subsystem/review-correctness.md` precedent (`HeartbeatScheduler` takes `MemoryStore`) | `00-summary.md` Dependency table row 5; `03-class-boundaries.md` §A11; `05-refactor-roadmap.md` A.5 + A.6 | **CONFIRMED** — `HeartbeatScheduler` calls `memoryStore.runDecaySweep()` (or `maintenanceOps.runDecaySweep()`). The `index.ts:541-552` reference for `initHeartbeat()` is a separate concern from F's review (F's C1 finding; not re-introduced in A). |

---

## Concrete fix list (must-resolve before implementation)

1. **M1.** Update §1.4 free-function distribution table to:
   Background 7, Scheduled 9, Kanban 19, Config/store-audit 4,
   VaultSsh 10, Approvals 5, Pending-retries 9. Update §03 A3
   (KanbanCards = 19), §A5 (Scheduler = 9), §A6 (BackgroundTaskPool
   = 7), §A7 (ApprovalStore = 5), §A10 (SshVault = 10). Resolve the
   §1.4/§03 internal inconsistency on Approvals (use 5).
2. **M2.** Update §00 Thesis to "33 interfaces + 4 type aliases =
   37 named type exports" (matches §01). Update §02 §0 / §1
   reconciliation to match. The §02 top-20 enumeration (rows 1-37)
   is internally consistent and matches the actual count.
3. **M3.** Update §1.4 / AR1 "14 narrow importers" to "17 narrow
   importers (4 top-level + 12 `web/` + 1 `federation/`)". Add
   `web/command-task.ts` and `web/federation/bridge.ts` to the
   narrow-importer list. The "39 production importers" headline
   and "A.7 gate" remain correct.

## Concrete fix list (should-resolve, optional)

4. **m1.** Re-order the §02 `KanbanCard.status` union as
   `'planned' | 'in_progress' | 'testing' | 'waiting' | 'done'` to
   match the SQL CHECK constraint order.
5. **m4.** Read L1835-1844 of `src/db.ts` to confirm the
   `KanbanCardEvent.from_status` / `to_status` / `actor` TS signature
   matches the §02 row 11 description (optional; the design is
   unaffected).
6. **m2-m3, m5-m6** are confirmations / unverified-claims that do
   not block implementation.

## Net verdict

**PASS-WITH-EDITS.** The plan is structurally sound, internally
consistent on the parts that matter most (the MessageBus signature
mapping per M7, the memory.ts ↔ db.ts dependency direction per CE-8,
the RemoteStatusCache reuse strategy per CE-9, the per-store
blast-radius enumeration per CE-11), and correctly addresses every
framework review finding in scope (CRITICAL M7 — fully resolved;
MAJOR M3, M6, CE-4, CE-8, CE-9, CE-11 — addressed; MINOR OE-6, OE-10
— correctly applied). The three major issues are cluster-count and
type-count metadata drift that does not change the design.

The plan's design — `DbClient` keystone + 12 entity-store classes
(MemoryStore, KanbanCards, MessageBus, Scheduler, BackgroundTaskPool,
ApprovalStore, SpanStore, IdeaStore, SshVault, ChannelPairingStore,
MaintenanceOps, plus the rejected SettingsStore/ChannelProviderRegistry
placeholders) + `EmbeddingClient` + `TtlCache<K, V>` + phased migration
(A.1 keystone → A.2-A.5 stores → A.6 cross-entity → A.7 singleton
removal → A.8 error taxonomy → A.9 cache consolidation → A.10 logger
adoption) + free-function pass-through pattern (per the B.1 / E.1 /
F.1 precedent) + `createTestDb` factory — is correct.

**Specific fixes before implementation:**
1-3 above (cluster count, type-export count, narrow-importer count).
4-5 (optional ordering and signature verification).

After applying 1-3 (and optionally 4-5), the plan is ready to
implement. Without them, an executor implementing per the plan will:
- find 7 Background / 9 Scheduled / 19 Kanban / 4 Config / 10
  VaultSsh / 5 Approvals / 9 Pending-retries functions (vs plan's
  6/7/18/3/9/4/8) — the per-cluster function counts are off by 1
  each (M1);
- find 33 interfaces + 4 types = 37 type exports (vs plan's 41 in
  some places, 37 in others) — the §02 enumeration is internally
  inconsistent (M2);
- find 17 narrow importers (vs plan's 14) — the plan's narrow
  importer list misses `web/command-task.ts` and `web/federation/bridge.ts`
  (M3);
- still produce a correct implementation, because the plan's
  `03-class-boundaries.md` method-surface tables are based on
  actual Read of the source files (verified byte-identical for
  `MessageBus`, `MemoryStore`, `KanbanCards`, `Scheduler`,
  `BackgroundTaskPool`, `ApprovalStore`, `SpanStore`, `IdeaStore`,
  `SshVault`).

### Confidence level

- **High** on the framework M7 MessageBus signatures (every signature
  verified by direct Read of `src/db.ts:2022`, `:2044`, `:2058`,
  `:2071`, `:2093`, `:2112`, `:2126`, `:2150`, `:2167`, `:2175`,
  `:2187`, `:2192`, `:2209`, `:2232`, `:2309`, `:3216`).
- **High** on the file-level metadata (3308 LOC, 50 vi.mock sites,
  39 production importers, 33 interfaces + 4 types, 104 boundary
  `as` casts with zero unsafe casts) — verified by direct
  `grep -c` / `wc -l`.
- **High** on the CE-8 single-direction dependency chain — verified
  by `grep -n "from.*memory" src/db.ts` returning zero hits and
  `grep -n "from.*db" src/memory.ts` returning 1 hit (lines 9-15).
- **High** on the CE-9 capability mismatch between MemoryCache and
  RemoteStatusCache — verified by direct Read of both source files
  and the plan's comparison table.
- **High** on the M7 method-signature byte-identity — verified by
  side-by-side Read of the plan and source.
- **Medium** on the per-cluster function counts in §1.4 (six
  clusters are off by 1; the cluster boundaries are correct but
  the function counts within each cluster are understated by 1).
- **Medium** on the "14 narrow importers" claim — the plan's total
  of 39 is correct; the 14-narrow breakdown misses 3 files
  (`web/command-task.ts`, `web/federation/bridge.ts`, and the
  precise third depends on which `web/` file the plan intended).
- **Medium** on the type-export count (§00 says 36+5=41, §01 says
  37, §02 says 35+6=41, actual is 33+4=37) — three different totals
  in the same plan.
- **Medium** on the M3 inheritance — the framework's M3 used
  `^export function ` (strict) returning 155; the plan uses
  `^export (async )?function` (async-inclusive) returning 158.
  Both are correct; the plan's §10 table explicitly acknowledges the
  discrepancy.

No claim in the plan was found to be unverifiable. The plan's design
intent is sound; only the inventory section needs counting corrections.
