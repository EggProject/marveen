# Type & Interface Analysis — classbase refactor preparation

Scope: every TypeScript file at `src/` top level (excluding `__tests__/` and
nested subdirectories `channel-coordinator/`, `costops/`, `db/`, `web/`, which
were only briefly scanned). This document is **planning only** — no source files
were modified.

---

## Brief summary

- **Total exported interfaces + type aliases (top-level `src/`):** ~95 across
  14 files (the bulk live in `db.ts` and `pane-state.ts`).
- **Top 3 most-shared types:**
  1. `Memory` (`db.ts`) — 6 source files (the only one in 6+ files; everywhere
     touches memories).
  2. `AutoRestartConfig` (`auto-restart.ts`) — 4 files (config + runner +
     tests + normalize path).
  3. `AgentMessage` (`db.ts`) — 4 files (DB + message-router + agent-worker +
     dashboard sidebar).
- **Generic opportunities identified:** 5 (most load-bearing is the
  `*Runner<TFacts, TDecision>` shape that 3+ decision functions in
  `pane-state.ts` already approximate but only loosely).
- **Type-safety hotspots (top 10 by `' as '` count):** 10 files, dominated by
  `db.ts` (132), `pane-state.ts` (41), `prompt-safety.ts` (19).

---

## Shared types inventory (sorted by reuse count)

Count = number of distinct non-test `*.ts` files that reference the symbol name
(`grep -rln '\b<Name>\b' --include='*.ts' | grep -v __tests__`).

| Reuse | Name | Defined in | Files using it (non-test) |
|------:|------|------------|---------------------------|
| 6 | `Memory` | `db.ts` | `db.ts`, `memory.ts`, `agent.ts`, `web/heartbeat-agent-scaffold.ts`, `web/channel-monitor.ts`, `web/routes/memories.ts`, `web/routes/migrate.ts` |
| 4 | `AutoRestartConfig` | `auto-restart.ts` | `auto-restart.ts`, `web/auto-restart-runner.ts`, `web/auto-restart-store.ts`, plus its normalize path |
| 4 | `AgentMessage` | `db.ts` | `db.ts`, `web/routes/messages.ts`, `web/message-router.ts`, `web/agent-worker.ts` |
| 3 | `StuckInputState` | `pane-state.ts` | `pane-state.ts`, `web/stuck-input-watcher.ts`, `web/agent-process.ts` |
| 3 | `PaneState` | `pane-state.ts` | `pane-state.ts`, `web/schedule-runner.ts`, `web/agent-process.ts` |
| 3 | `McpListEntry` | `mcp-list-parser.ts` | `mcp-list-parser.ts`, `web/mcp-list.ts`, `web/routes/connectors*.ts` |
| 2 | `StuckToolCallState` | `pane-state.ts` | `pane-state.ts`, `web/stuck-tool-call-watcher.ts` |
| 2 | `SettingDefinition` | `config-registry.ts` | `config-registry.ts`, `settings-store.ts` |
| 2 | `ProcessLockContext` | `process-lock.ts` | `process-lock.ts`, `index.ts` |
| 2 | `PidfileLockContext` | `process-lock.ts` | `process-lock.ts`, `index.ts` |
| 2 | `ModelFallbackConfig` | `model-fallback.ts` | `model-fallback.ts`, `web/model-fallback-runner.ts` |
| 2 | `ContextGuardConfig` | `context-guard.ts` | `context-guard.ts`, `web/context-guard-runner.ts` |
| 2 | `ChannelProvider` | `channel-provider.ts` | `channel-provider.ts`, `notify.ts` (+ many internal usages within `channel-provider.ts`) |

Single-file types (defined and only used inside one file — low refactor
priority, listed for completeness): `KanbanCard`, `DispatchResolveOpts`,
`RefreshInput`, `RefreshOutcome`, `RecencyRankable`, `ParkedChannelInput`,
`OtelSpan`, `AuditLogEntry`, `Approval`, `IdeaBoxRow`, `OtelTraceSummary`,
`VaultSshKey`, `VaultSshServer`, `Label`, `PendingChannelRequest`,
`PendingTaskRetryRow`, `BackgroundTask`, `ScheduledTask`, `KanbanComment`,
`ArchivedKanbanCard`, `KanbanCardEvent`, `MemoryCacheEntry` (private to db.ts),
`HeartbeatKanbanSummary`, `SkillUsageRow`, `ToolCallLogRow`,
`ConfigChangeLogRow`, `StoreFileAuditRow`, `DashboardUser`, `DashboardUserPublic`,
`IdeaComment`, `IdeaStatusLogRow`, `WorkflowCandidate`, `SkillUsageStatRow`,
`PendingRetryView`, `AgentBacklog`, `AgentThread`, `TaskRunEntry`,
`TaskRunHistoryEntry`, `MailCredentials`, `SendMailOptions`,
`ListMessagesOptions`, `GraphMessage`, `CalendarEvent`, `TokenData`,
`ClientCredentials`, `CalendarListResponse`, `CostOpsConfig`, `FixedCostEntry`,
`BudgetEntry`, `MonthWindow`, `EnrollOptions`, `EnrollResult`,
`RemoveEnrolledOptions`, `RemoveEnrolledResult`, `GitRunner`, `PidfileRunner`,
`TeamConfigForTrust`, `TrustContext`, `ConnectionBundleInput`,
`ConnectionBundle`, `HostKeySources`, `ResolvedHostKey`, `ParsedKey`,
`MergeResult`, `RemoveResult`, `DispatchResolveOpts`, `RunAgentOpts`,
`AgentResultClassification`, `ChannelProviderType`, `SettingType`,
`SettingValidationResult`, `AutoRestartMode`, `MainRestartMechanism`,
`GuardPhase`, `GuardActionType`, `GuardInputs`, `GuardDecision`, `GuardState`,
`SubmitFollowupAction`, `StuckInputAction`, `StuckInputActionFacts`,
`StuckInputThresholds`, `StuckInputDecision`, `DetectPaneStateOptions`,
`FirstRunGateKind`, `PaneErrorAlertState`, `PaneErrorAlertThresholds`,
`PaneErrorAlertDecision`, `ToolCallProgressSignature`, `StuckToolCallThresholds`,
`StuckToolCallDecision`, `ModelAction`, `ModelFallbackFacts`,
`ModelProfileId`, `ModelProfileMap`, `ModelProfileMapState`,
`ModelResolution`, `ModelResolutionSource`, `AgentModelConfig`,
`PreflightResult`, `ConcurrencyResult`, `LockWriteErrorKind`, `MergeAction`,
`AuditSource`, `SshKeyStatus`, `ProcessLockContext`, `PidfileLockContext`,
`SignalOutcome`, `ExclusiveCreateOutcome`, `AcquirePortLockOptions`,
`AcquirePidfileLockOptions`, `LogFn`, `RouteContext`, `HostKeySources`,
`HostKeySources`, `RefreshInput`, `RefreshOutcome`, `McpListSource`,
`McpListStatus`, `PlatformType`, `ClaudeSettings`, `SystemInfo`,
`HeartbeatData`, `ClaudeSettings`, `PendingRetryView`, `DispatchResolveOpts`,
`MailCredentials`, `SetOverrideResult`.

(For full coverage see the `grep -E '^(export )?(interface |type )'` output
collected during the analysis — the bulk of the export surface is in `db.ts`
and `pane-state.ts`.)

---

## Entity types (data + associated behavior — natural class candidates)

Each entry: **type → location → behavior functions operating on it → class
candidacy**.

### 1. `Memory`
- **Location:** `src/db.ts:1061`
- **Behavior:** `saveMemory`, `searchMemories`, `recentMemories`,
  `touchMemory`, `touchMemoriesAccessed`, `decayMemories`,
  `getMemoriesForChat`, `getAgentMemories`, `searchAgentMemories`,
  `getMemoryStats`, `updateMemory`, `hybridSearch`, `vectorSearch`,
  `saveAgentMemory`, `reRankByRecency`, `buildFtsMatchExpression`,
  `generateEmbedding` (in `db.ts`), plus `buildMemoryContext`,
  `saveConversationTurn` (in `memory.ts`).
- **Class candidacy:** **Strong.** All ops touch the `Memory` shape and the
  `memoryCache` (`db.ts:1245`) plus FTS + embedding pipelines are
  *infrastructure* bound to the entity. A `MemoryStore` class with methods
  `save/search/recent/touch/decay/reRankByRecency/hybridSearch` would let the
  module-level singletons (`db`, `memoryCache`) become instance state, and the
  free-function surface becomes the class API. The `RECENCY_LAMBDA` /
  `RECENCY_TAU_SEC` constants would become constructor opts. Cross-cutting:
  the existing `MemoryCacheEntry` (private interface at `db.ts:1240`) already
  encodes the per-key TTL — exactly the kind of state a class would own.

### 2. `KanbanCard`
- **Location:** `src/db.ts:1627`
- **Behavior:** `listKanbanCards`, `listKanbanCardsSummary`, `getKanbanCard`,
  `createKanbanCard`, `updateKanbanCard`, `getChildCards`, `moveKanbanCard`,
  `markKanbanCardDispatched`, `archiveKanbanCard`, `unarchiveKanbanCard`,
  `listArchivedKanbanCards`, `listKanbanProjects`, `deleteKanbanCard`,
  `getKanbanComments`, `getKanbanCardEvents`, `getKanbanSeqByIdPrefix`,
  `findActiveKanbanCardByTitle`, `markScheduledTaskKanbanWaiting`,
  `addKanbanComment`. The `KanbanCardEvent` (`db.ts:1835`) is a child entity;
  `KanbanComment` (`db.ts:1650`) and `Label` (`db.ts:1897`) are joined
  entities; `ArchivedKanbanCard` (`db.ts:1756`) is a projection.
- **Class candidacy:** **Strong.** Most behavior is intrinsic to the card
  (status transitions, dispatch-once guard, archive/unarchive). The
  status-change audit (`moveKanbanCard` writes a `kanban_card_events` row
  only when `prev !== status`) is a natural invariant a class could enforce
  internally instead of via a SQL `INSERT` at the call site. A
  `KanbanCards` (or `KanbanBoard`) class with `move/update/archive/comment/
  dispatch/dispatchOnce` methods would also subsume the `Label` /
  `KanbanComment` join entities as composed values.

### 3. `AgentMessage`
- **Location:** `src/db.ts:2002`
- **Behavior:** `createAgentMessage`, `getPendingMessages`,
  `markMessageDelivered`, `getPendingBacklogByAgent`,
  `closeMessagesWithoutDelivery`, `setMessageResult`,
  `failPendingFederatedMessages`, `claimPendingForAgent`, `markMessageDone`,
  `markMessageFailed`, `markPendingFederatedFailed`, `listAgentMessages`,
  `getAgentConversation`, `getAgentConversationThreads`, `getAgentMessage`,
  `stampMessageTrace`. The `AgentThread` (`db.ts:2221`) and `AgentBacklog`
  (`db.ts:2069`) are projections on the entity.
- **Class candidacy:** **Strong + discriminated-union friendly.** The status
  field (`pending | delivered | done | failed`) plus trace-context (trace_id,
  span_id, parent_span_id) plus origin_note make this a textbook sealed-class
  hierarchy: a `MessageBus` class with `create/claimPending/deliver/fail/done`
  methods where the **status transition is enforced by the class** rather than
  scattered across 8 separate `mark*` free functions. The `claimPendingForAgent`
  "claim oldest pending in a single `UPDATE … RETURNING`" pattern would
  become a class method (`bus.claimPending(toAgent, limit)`).

### 4. `ScheduledTask`
- **Location:** `src/db.ts:1555`
- **Behavior:** `createTask`, `getDueTasks`, `updateTaskAfterRun`,
  `listTasks`, `deleteTask`, `pauseTask`, `resumeTask`, `getTask`,
  `updateTask`, `getActiveScheduledTaskCount`. Plus `PendingTaskRetryRow`
  (`db.ts:2322`) for retry queue.
- **Class candidacy:** **Medium.** The pure `restartDue` / `dailyDueAtMs` /
  `parseHHMM` helpers in `auto-restart.ts` and the retry-queue logic in
  `pending-retries.ts` would benefit from a `Scheduler` class that owns the
  "is this task due + is the agent busy + has it been alerted" decision
  end-to-end. Currently the decision is split across
  `pending-retries.ts:shouldSendAlert`, `pending-retries.ts:classifyTelegramSendError`,
  and `web/schedule-runner.ts` — a single `Scheduler.advance(task, now)`
  method would consolidate.

### 5. `BackgroundTask`
- **Location:** `src/db.ts:1492`
- **Behavior:** `createBackgroundTaskAtomic`, `getRunningBackgroundTasks`,
  `finishBackgroundTask`, `getBackgroundTasks`, `getBackgroundTask`,
  `countRunningBackgroundTasks`, `markOrphanedTasksFailed`. Plus
  `command-task.ts` in web/.
- **Class candidacy:** **Medium.** `createBackgroundTaskAtomic` is already
  doing transactional concurrency control (`maxConcurrent` cap); a
  `BackgroundTaskPool` class with `tryAcquire(maxConcurrent) / finish / reap`
  methods is a clean fit.

### 6. `Approval`
- **Location:** `src/db.ts:3132`
- **Behavior:** `createApproval`, `getApproval`, `resolveApproval`,
  `listApprovals`, `expireTimedOutApprovals`. Plus `web/routes/approvals.ts`.
- **Class candidacy:** **Medium.** Status transitions (`pending → approved
  | rejected | timeout`) plus the timeout-sweeper logic is a perfect state
  machine — `ApprovalStore` with `request / resolve / sweepExpired` methods.

### 7. `OtelSpan` / `OtelTraceSummary`
- **Location:** `src/db.ts:3239` / `src/db.ts:3277`
- **Behavior:** `upsertOtelSpan`, `closeOtelSpan`, `getOtelTrace`,
  `listOtelTraces`. The `trace_id / span_id / parent_span_id` triple is the
  classic tree-walking span shape.
- **Class candidacy:** **Strong + discriminated union.** A `SpanStore` class
  with `startSpan(parent) / closeSpan(traceId, spanId, status) /
  listTraces() / getTrace(traceId)`. The `status: 'ok'|'error'|'timeout'|'running'`
  field plus trace-context fields are well-suited to a sealed-class hierarchy
  for `SpanStatus`.

### 8. `IdeaBoxRow` / `IdeaComment` / `IdeaStatusLogRow`
- **Location:** `src/db.ts:2564` / `src/db.ts:2620` / `src/db.ts:2643`
- **Behavior:** `listIdeas`, `createIdea`, `updateIdea`, `deleteIdea`,
  `listIdeaCategories`, `getIdeaComments`, `addIdeaComment`,
  `getIdeaStatusLog`, `logIdeaStatusChange`, `revertIdeaFromKanban`.
- **Class candidacy:** **Medium.** Status transitions
  (`new → reviewed → kanban | rejected`) plus `revertIdeaFromKanban` hook are
  a clean state machine. Lower reuse than `Memory` / `KanbanCard`, but the
  status-log pattern (one row per real transition) is identical to the
  `KanbanCardEvent` pattern.

### 9. `SettingDefinition`
- **Location:** `src/config-registry.ts:20`
- **Behavior:** `validateSettingValue`, `getSettingDefinition`,
  `listSettingModules`. Plus the consumer side `getEffectiveSettingValue`,
  `setOverride`, `getOverrides`, `reloadOverridesForTest` (in
  `settings-store.ts`).
- **Class candidacy:** **Medium.** The registry is a static list of 35+
  entries (`SETTINGS_REGISTRY`) — currently exported as a bare array. A
  `SettingsRegistry` class with `define(entry) / validate(key, raw) /
  getDefinition(key) / listModules()` methods would also centralize the
  `HEX_COLOR_RE` private regex (`config-registry.ts:35`) and the
  `coerce(def, raw)` helper (`settings-store.ts:63`).

### 10. `VaultSshKey` / `VaultSshServer`
- **Location:** `src/db.ts:3031` / `src/db.ts:3077`
- **Behavior:** `listVaultSshKeys`, `getVaultSshKey`, `createVaultSshKey`,
  `deleteVaultSshKey`, `listVaultSshServers`, `getVaultSshServer`,
  `createVaultSshServer`, `updateVaultSshServer`, `deleteVaultSshServer`,
  `computeSshKeyStatus`. Plus the enrollment helpers in `remote-enroll-*`.
- **Class candidacy:** **Medium.** The `ssh_key_id` FK plus
  `computeSshKeyStatus` derivation is a clear parent/child boundary. A
  `SshVault` class encapsulating both entities plus enrollment would be
  cohesive.

### 11. `MemoryCacheEntry` (private), `KanbanCardEvent`, `KanbanComment`
- These are **child entities** of the above — natural candidates to become
  nested classes (composition) inside `MemoryStore` / `KanbanCards`.

### 12. `ChannelProvider`
- **Location:** `src/channel-provider.ts:11`
- **Behavior:** the five provider objects (`telegram`, `slack`, `discord`,
  `googlechat`, `teams`) plus `getChannelToken`, `getChannelChatId`,
  `getProvider`, `getProviderType`, `channelStateDir`, `readChannelToken`,
  `withTestRunMarking` wrapper.
- **Class candidacy:** **Strong.** This is the most obvious classbase
  candidate in the codebase — 5 implementations of the same interface
  (`ChannelProviderType` is a string-literal union), with `markIfTestRun`
  applied via a wrapper object. The 5 provider objects could become 5 classes
  (`TelegramChannelProvider implements ChannelProvider`, etc.), with
  `getProvider(type)` returning an instance. The `withTestRunMarking` wrapper
  is a textbook Decorator — `withTestRunMarking(provider: ChannelProvider)`
  becomes `new TestRunMarkingDecorator(provider)` returning an instance of the
  same interface.

---

## Generic opportunities (parameterized classes)

For each: location → current duplication → proposed class signature
(sketch only) → expected impact.

### G1. `PaneWatcher<TState, TThresholds, TDecision>` — generic watcher base
- **Location:** `pane-state.ts` decision functions (`decidePaneErrorAlert`,
  `decideStuckInputRecovery`, `decideStuckToolCallRecovery`).
- **Current duplication:** Each watcher has the same shape:
  `{ ...State, ...Thresholds } -> { recover/alert: boolean, next: State }`.
  The spell-start, clock-skew, retry-budget, and confirm/dedup gates are
  repeated literally three times. The `NO_STUCK_INPUT` and
  `NO_STUCK_TOOL_CALL` constants are near-duplicates.
- **Proposed signature (sketch):**
  ```ts
  abstract class PaneWatcher<TState, TThresholds> {
    abstract readonly NO_STATE: TState
    abstract step(
      observation: unknown,
      prev: TState,
      now: number,
      thresholds: TThresholds,
    ): { act: boolean; next: TState }
  }
  ```
- **Impact:** Removes ~120 lines of duplicated decision machinery across the
  three watchers. Pure-logic `decideX` functions become subclasses with only
  the state-specific transition logic.

### G2. `MemoryCache<TKey, TValue>` — typed TTL cache
- **Location:** `db.ts:1238-1274` (the `memoryCache` Map + `MEMORY_CACHE_TTL_MS`
  constant + the three helpers `memoryCacheGet/Set/Invalidate` +
  `clearMemoryCache`/`getMemoryCacheSize` exports).
- **Current duplication:** None outside this module yet, but the cache's
  "invalidate all keys starting with `<agentId>:`" idiom and the test-only
  `getMemoryCacheSize` / `clearMemoryCache` exports are begging for a typed
  container class.
- **Proposed signature (sketch):**
  ```ts
  class TtlCache<K, V> {
    constructor(private ttlMs: number) {}
    get(key: K): V | null
    set(key: K, value: V): void
    invalidatePrefix(prefix: K extends string ? K : string): void
    clear(): void
    size(): number
  }
  ```
- **Impact:** `MemoryStore` becomes the cache's consumer; the cache becomes
  reusable for any future TTL-cache need (e.g., the in-flight
  `vault-key-cache` if one is added).

### G3. `RetryQueue<TKey, TRow>` — generic retry-queue with alert policy
- **Location:** `pending-retries.ts` (decision) + `db.ts:2339-2423` (DB ops for
  `PendingTaskRetryRow`).
- **Current duplication:** `shouldSendAlert(now, firstAttempt, alertSentAt,
  thresholdMs)` is generic over threshold but the DB ops are typed to the
  specific `(taskName, agentName)` pair. A typed class could merge the
  "decide + record + alert" triad into `queue.alertIfDue()`.
- **Proposed signature (sketch):**
  ```ts
  class RetryQueue<TRow extends { first_attempt: number; alert_sent_at: number | null }> {
    shouldAlert(row: TRow, now: number, thresholdMs: number): boolean
    markAlerted(row: TRow, ts: number): void
    classifyFailure(errMessage: string): 'transient' | 'permanent'
  }
  ```
- **Impact:** The pending-task-retry subsystem gets a typed owner instead of
  the current split between `pending-retries.ts` (decide) and `db.ts` (record).

### G4. `SettingsStore<TOverrides>` — typed override layer
- **Location:** `settings-store.ts` (currently `Record<string, string | number>`
  cache + watcher + atomic write).
- **Current duplication:** None outside this module yet. The cache uses an
  untyped `Record<string, string | number>` because the `SettingDefinition.type`
  is checked at read time.
- **Proposed signature (sketch):**
  ```ts
  class SettingsStore {
    constructor(private registry: SettingDefinition[]) {}
    get<T extends string = string>(key: T): string | number | undefined
    set(key: string, rawValue: unknown): SetOverrideResult
    invalidate(): void
  }
  ```
- **Impact:** The `Record<string, string | number>` becomes a property of the
  class; the `cache` / `watcher` module-level state is encapsulated; tests
  stop needing the `__test_handleWatchEvent` and `reloadOverridesForTest`
  escape hatches.

### G5. `LoggerLike` interface unification (not a class, but a generic
  interface used by every decision module)
- **Location:** `process-lock.ts:19` (`type LogFn`) and the `log: { info, warn,
  error }` shape on `ProcessLockContext` / `PidfileLockContext`.
- **Current duplication:** Every pure-logic module that wants to surface
  structured logs re-defines `{ info(obj, msg?), warn, error }` instead of
  importing the pino `Logger` interface directly. This blocks a classbase
  refactor because every class needs its own `LogFn` alias.
- **Proposed signature (sketch):**
  ```ts
  import type { Logger } from 'pino'
  type LogFn = Logger
  ```
- **Impact:** Eliminates 5+ identical aliases; classes can take a `Logger` in
  the constructor; the pino transport/level decisions stay at the import
  boundary.

---

## Type-safety hotspots (`as` / `: any` usage, top 10)

Count = occurrences of ` as ` (cast) in non-test files. `: any` is rare at
top level (only `index.ts` and `agent.ts` had any, with 1 occurrence each).

| Rank | File | ` as ` count | `: any` count | Notes |
|-----:|------|-------------:|--------------:|-------|
| 1 | `db.ts` | 132 | 0 | `?? undefined as X \| undefined` pattern is the dominant idiom; row-mapping at the SQL boundary is `as Memory[]` etc. **Immediate generics opportunity** — see `MemoryStore<T>` sketch. |
| 2 | `pane-state.ts` | 41 | 0 | Most casts are `match[1]!` non-null assertions on RegExp capture groups, plus the regex arrays (`BUSY_INDICATORS: RegExp[]`) cast through `as const` boundaries. **Immediate generics opportunity** — `PaneWatcher<T>` sketch in G1. |
| 3 | `prompt-safety.ts` | 19 | 0 | All casts are `(err as NodeJS.ErrnoException)?.code` shape — standard library narrowing idiom. Lower priority; the casts are correct. |
| 4 | `index.ts` | 12 | 1 | The `: any` is in `process.env.MARVEEN_AGENT_BACKEND` access; the `as` casts are pidfile / process table reads. Acceptable as-is — these are `unknown`-from-runtime data. |
| 5 | `config.ts` | 11 | 0 | `cfg(key)` returning `string \| undefined`, plus `(err as NodeJS.ErrnoException)?.code` style. The constants at the bottom (`WEB_PORT`, `APP_TZ`) are `parseInt` results with no `as`; the `as` cluster is in the override-reader / cron-tz probe. |
| 6 | `agent.ts` | 11 | 1 | `(event as any).subtype` / `(event as any).sessionId` for untyped SDK events; this is a legitimate third-party boundary, but `AgentResultClassification` (already exported here) could grow a generic `classifySdkEvent<TEvent extends ...>(event: TEvent)` to lift the cast. **Immediate generics opportunity.** |
| 7 | `heartbeat.ts` | 9 | 0 | `(err as NodeJS.ErrnoException)?.code` style. Acceptable. |
| 8 | `update-preflight.ts` | 7 | 0 | `Number.parseInt` returns plus `(err as NodeJS.ErrnoException)?.code`. Acceptable. |
| 9 | `model-profiles.ts` | 7 | 0 | `as Record<ModelProfileId, string>` for the typed empty object literal + `as unknown` boundary on raw JSON. **Immediate generics opportunity** — see `validateModelProfileMap`. |
| 10 | `web.ts` | 6 | 0 | The `as const` chains in the `ctxAuth` block (`{ kind: 'token' as const }`) plus `(err as NodeJS.ErrnoException)?.code`. The `as const` block could become a typed `AuthContextKind` discriminated-union class (see D1 below). |

All ten are **candidates for stricter generics** — but the highest-leverage
ones are **db.ts**, **pane-state.ts**, and **agent.ts**, because the `as`
casts there are *boundary* casts (DB rows → typed memory, regex captures →
typed matches, SDK events → typed classifications), each of which a class
parameterized over `T` could eliminate at the seam.

---

## Discriminated unions → sealed-class candidates

For each: union definition → call sites that switch on tag → sealed-class
sketch.

### D1. `AuthResult` (auth-kind discrimination) — high reuse
- **Union definition:** Lives in `web/auth-gate.ts` (not top-level `src/`),
  but **consumed** in `web.ts:155-159`:
  ```ts
  auth.kind === 'token'    ? { kind: 'token' as const }
  auth.kind === 'device'   ? { kind: 'device' as const, device: auth.device }
  auth.kind === 'session'  ? { kind: 'session' as const, user: auth.user }
  auth.kind === 'federation' ? { kind: 'federation' as const, peer: auth.peer }
  ```
- **Call sites:** `web.ts` is the central route dispatcher. The
  `RouteContext.auth` field (`web/routes/types.ts`) carries this through to
  every route handler. Currently `ctxAuth` is a `?`-chained ternary of
  `as const` objects — a textbook discriminated-union re-projection.
- **Sealed-class sketch:**
  ```ts
  abstract class AuthContext {
    abstract readonly kind: 'token' | 'device' | 'session' | 'federation'
  }
  class TokenAuth extends AuthContext { readonly kind = 'token' as const }
  class DeviceAuth extends AuthContext { readonly kind = 'device' as const; constructor(public device: DeviceRow) { super() } }
  class SessionAuth extends AuthContext { readonly kind = 'session' as const; constructor(public user: DashboardUserPublic) { super() } }
  class FederationAuth extends AuthContext { readonly kind = 'federation' as const; constructor(public peer: string) { super() } }
  ```
- **Impact:** Eliminates the `as const` chain in `web.ts`, gives every route
  handler a typed `.device` / `.user` / `.peer` accessor via a single
  instanceof check or the `kind` discriminator, and lets the auth-gate return
  an `AuthContext` directly instead of `AuthResult`.

### D2. `ModelAction`
- **Union definition:** `model-fallback.ts:115`:
  ```ts
  type ModelAction =
    | { kind: 'none' }
    | { kind: 'downgrade'; model: string }
    | { kind: 'revert'; model: string }
  ```
- **Call sites:** `decideModelAction` itself; the runner in
  `web/model-fallback-runner.ts` would `switch (action.kind)`.
- **Sealed-class sketch:**
  ```ts
  abstract class ModelAction { abstract readonly kind: string }
  class NoAction extends ModelAction { readonly kind = 'none' as const }
  class DowngradeAction extends ModelAction { readonly kind = 'downgrade' as const; constructor(public model: string) { super() } }
  class RevertAction extends ModelAction { readonly kind = 'revert' as const; constructor(public model: string) { super() } }
  ```
- **Impact:** Small but clean. The pattern (`{ kind, ...payload }`) matches
  the codebase's idiom for action shapes (see `PaneErrorAlertDecision`,
  `StuckInputDecision`, `StuckToolCallDecision`, `ModelFallbackFacts`).

### D3. `SubmitFollowupAction` / `StuckInputAction`
- **Union definition:** `pane-state.ts:900` / `pane-state.ts:1373`. Both
  encode the discrete actions a recovery loop should take.
- **Call sites:** `decideSubmitFollowup` (`pane-state.ts:940`) and
  `decideStuckInputAction` (`pane-state.ts:1417`); consumed in
  `web/agent-process.ts`.
- **Sealed-class sketch:** Same shape as D2 — abstract base + 4-5 sealed
  subclasses. The benefit is mostly aesthetic + future-proofing for adding
  new recovery actions.
- **Impact:** Low immediate value, but consistent with D2/D4.

### D4. `OtelSpan['status']`
- **Union definition:** `db.ts:3247`: `'ok' | 'error' | 'timeout' | 'running'`.
  Carries alongside `trace_id / span_id / parent_span_id` and the
  `attributes` JSON string.
- **Call sites:** `upsertOtelSpan` / `closeOtelSpan` / `listOtelTraces`
  (in `db.ts`). The waterfall UI in `web/routes/spans.ts` joins + groups
  spans by status.
- **Sealed-class sketch:** A `Span` class hierarchy with `OkSpan` /
  `ErrorSpan` / `TimeoutSpan` / `RunningSpan`, each carrying the same row
  shape. The store (`SpanStore`) is already a strong entity candidate (see
  E7).
- **Impact:** Medium. The status enum is small but it lives alongside a
  complex entity (`OtelSpan` with parent/child relations); a `Span` class
  hierarchy would make the "running → ok/error/timeout" transition explicit.

### D5. `PreflightResult` / `ConcurrencyResult` (update-preflight)
- **Union definition:** `update-preflight.ts:46-50`:
  ```ts
  type PreflightResult =
    | { ok: true }
    | { ok: false; reason: 'dirty-tree'; message: string }
    | { ok: false; reason: 'detached-head'; message: string }
    | { ok: false; reason: 'local-commits'; message: string; ahead: number }
  ```
- **Call sites:** `checkUpdatePreflight` / `checkNoConcurrentUpdate`; the
  result is consumed by `web/routes/updates.ts` to render a 409 message.
- **Sealed-class sketch:**
  ```ts
  abstract class PreflightResult { abstract readonly ok: boolean }
  class PreflightOk extends PreflightResult { readonly ok = true as const }
  class PreflightDirtyTree extends PreflightResult { readonly ok = false as const; readonly reason = 'dirty-tree' as const; constructor(public message: string) { super() } }
  class PreflightDetachedHead extends PreflightResult { readonly ok = false as const; readonly reason = 'detached-head' as const; constructor(public message: string) { super() } }
  class PreflightLocalCommits extends PreflightResult { readonly ok = false as const; readonly reason = 'local-commits' as const; constructor(public message: string, public ahead: number) { super() } }
  ```
- **Impact:** Low — these are pure-data unions consumed at a single point.
  Keep them as type aliases; the sealed-class route is reserved for entities
  that also own behavior.

### D6. `ModelProfileMapState`
- **Union definition:** `model-profiles.ts:38`:
  ```ts
  type ModelProfileMapState =
    | { ok: true; map: ModelProfileMap }
    | { ok: false; error: string }
  ```
- **Call sites:** `validateModelProfileMap`, `resolveAgentModelFromConfig`.
- **Sealed-class sketch:** Same shape as D5. Low priority.

### D7. `MergeAction` (remote-enroll-core)
- **Union definition:** `remote-enroll-core.ts:170`: `'added' | 'replaced'`.
  Carries alongside `MergeResult { content, action }` (`remote-enroll-core.ts:172`).
- **Call sites:** `mergeAuthorizedKeys` (in `remote-enroll-core.ts`),
  `enrollAuthorizedKey` (in `remote-enroll-fs.ts`).
- **Sealed-class sketch:** A `MergeResult` class with two subclasses or a
  single class with a `kind: 'added' | 'replaced'` field and methods
  `describe()` for the CLI message.
- **Impact:** Low — only the CLI surfaces the action verb.

---

## Options / config patterns (function-style options → typed config classes)

For each: current shape → call sites → typed class opportunity.

### O1. `EnrollOptions` / `RemoveEnrolledOptions` (remote-enroll-fs)
- **Current:** Two near-identical option bags at `remote-enroll-fs.ts:28-43`
  and `remote-enroll-fs.ts:212-219`, each carrying
  `{ sshDir, lockRetries?, lockRetryDelayMs?, staleLockMs?, sleep? }`. The
  `enrollAuthorizedKey` / `removeEnrolledKey` destructuring is duplicated.
- **Call sites:** `enrollAuthorizedKey` (fs-side), `removeEnrolledKey`
  (fs-side); CLI scripts that invoke them.
- **Typed class opportunity:** A `LockOptions` class with
  `constructor(sshDir, { lockRetries = 20, lockRetryDelayMs = 100, staleLockMs = 15000, sleep = defaultSleep })`.
  Both `EnrollOptions` and `RemoveEnrolledOptions` extend it (or compose it).

### O2. `EnrollResult` / `RemoveEnrolledResult` / `MergeResult`
- **Current:** Three result bags across `remote-enroll-core.ts` /
  `remote-enroll-fs.ts`. `MergeResult` has `{ content, action }`;
  `EnrollResult` has `{ action, authorizedKeysPath, warnings }`;
  `RemoveEnrolledResult` has `{ removed, authorizedKeysPath }`.
- **Typed class opportunity:** A `RemoteEnrollment` class encapsulating the
  whole lifecycle (`enroll / remove / list`), with typed return objects and
  a single source-of-truth `mergeAuthorizedKeys` as a private method.

### O3. `GitRunner` / `PidfileRunner` (update-preflight)
- **Current:** `update-preflight.ts:30-44` (`GitRunner` interface) and
  `update-preflight.ts:58-69` (`PidfileRunner` interface) — both are
  interface-for-mock-injection (pure-logic + injected side effects).
- **Call sites:** `checkUpdatePreflight(git)`, `checkNoConcurrentUpdate(pf)`.
- **Typed class opportunity:** The interfaces are already the right shape;
  in a classbase refactor, the concrete `DefaultGitRunner` /
  `DefaultPidfileRunner` could become real classes (with the I/O methods)
  and the pure functions stay free, taking the class instance via
  interface. No immediate win beyond explicit constructor wiring.

### O4. `RefreshInput` / `RefreshOutcome` (mcp-list-parser)
- **Current:** `mcp-list-parser.ts:165-180`. The `applyRefreshOutcome` pure
  function takes `{ stdout, execError, previousEntries }` and returns
  `{ entries, error, retainedStale }`.
- **Call sites:** `web/mcp-list.ts` (the cache wrapper).
- **Typed class opportunity:** A `McpListCache` class with
  `refresh(stdout, execError)` method. The pure `applyRefreshOutcome` stays
  as a static helper.

### O5. `ChannelProvider` (channel-provider.ts) — best class candidate
- **Current:** `channel-provider.ts:11-23` is already an interface; the 5
  provider objects (`telegramProvider`, `slackProvider`, `discordProvider`,
  `googlechatProvider`, `teamsProvider`) at `channel-provider.ts:53, 134,
  243, 324, 364` implement it. `withTestRunMarking`
  (`channel-provider.ts:490`) is a Decorator wrapper.
- **Call sites:** `getProvider(type)` is called by `notify.ts`,
  `web/agent-process.ts`, `web/channel-monitor.ts`, and routes.
- **Typed class opportunity:** Convert the 5 provider objects to classes
  implementing `ChannelProvider`:
  ```ts
  abstract class BaseChannelProvider implements ChannelProvider {
    abstract readonly type: ChannelProviderType
    // shared default impls for splitMessage (delegates to format.ts)
  }
  class TelegramChannelProvider extends BaseChannelProvider { ... }
  // ...etc
  ```
  `withTestRunMarking(provider)` becomes `new TestRunMarkingDecorator(provider)`.
- **Impact:** High. This is the most natural classbase target in the
  codebase — 5 implementations of one interface plus a Decorator is a
  textbook OOP pattern.

### O6. `ChannelProviderType` (the tag)
- Already a string-literal union. In a sealed-class refactor it stays the
  type-narrowing tag (the abstract base class's `type` field uses it).

---

## Brief observations on subdirectories (high-level only)

### `web/`
- ~85 files. The dominant patterns are *runner* modules (start/stop with
  intervals), *route* modules (handle a single HTTP endpoint), and *store*
  modules (read/write a single DB-backed entity). The runner pattern
  (`startXxxRunner(): NodeJS.Timeout`) is duplicated 15+ times and would
  benefit from a generic `Runner<T>` interface — but this is a deeper
  refactor than classbase.
- `web/auth-gate.ts`, `web/auth-sessions.ts`, `web/auth-device-keys.ts`,
  `web/dashboard-auth.ts` form a cohesive auth subsystem that maps cleanly
  to a `DashboardAuth` class plus several `*Store` classes.

### `db/`
- A single file (`db.ts` itself at top level, plus `db/sqlite.ts` for the
  `Database` wrapper). The classbase refactor would consolidate the
  top-level `db.ts` into per-entity store classes (see E1, E2, E3 above).

### `costops/`
- `costops/config.ts` already has clean discriminated types (`CostConfidence`,
  `ChargeCategory`) and uses string-literal unions consistently. The
  `FixedCostEntry` and `BudgetEntry` types would naturally become classes
  inside a `CostOpsLedger` class, but the value-add is limited because
  this module is already well-factored.

### `channel-coordinator/`
- Single-purpose Telegram-backfill poller. The state machine (`State =
  'idle' | 'backfilling'` at `channel-coordinator.ts:100`) plus the
  `nativeConfirmedUpUntil` cooldown are textbook class candidates:
  `class BackfillCoordinator { private state: 'idle' | 'backfilling'; ... }`.
  This was the most obvious class candidate outside of `ChannelProvider`,
  but it's a single-instance program with no shared reuse, so the gain is
  mostly readability, not testability.

---

## Refactor priority summary (when the classbase plan is actually executed)

**Highest value (most files touched, biggest structural win):**
1. **`MemoryStore<TMemory extends Memory>`** (E1) — touches `db.ts`,
   `memory.ts`, agent, channels, heartbeat, dashboard.
2. **`ChannelProvider` sealed class hierarchy** (E2, O5) — touches
   `channel-provider.ts`, `notify.ts`, every channel-touching route.
3. **`KanbanCards` class** (E2) — touches `db.ts`, `web/routes/kanban.ts`,
   `kanban-dispatch.ts`, `heartbeat.ts`.

**Medium value:**
4. **`AgentMessage` / `MessageBus` class** (E3, D2) — touches
   `web/message-router.ts`, `db.ts`, `web/agent-worker.ts`.
5. **`SpanStore` with `Span` sealed hierarchy** (E7, D4) — touches `db.ts`,
   `web/routes/spans.ts`, message-router middleware.
6. **`PaneWatcher<TState, TThresholds>` generic base** (G1) — consolidates
   `pane-state.ts` decision machinery.
7. **`AuthContext` sealed hierarchy** (D1) — touches `web.ts`,
   `web/auth-gate.ts`, every gated route.

**Lower value (mostly aesthetic, future-proofing):**
- `SettingsRegistry` (E9), `RemoteEnrollment` (E2), `RetryQueue<T>` (G3),
  `BackgroundTaskPool` (E5), `ApprovalStore` (E6), `CostOpsLedger`,
  `BackfillCoordinator`.

---

*Document ends. No source files were modified during this analysis.*
