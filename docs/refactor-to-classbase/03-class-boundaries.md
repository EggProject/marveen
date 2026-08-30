# Class Boundaries

For each class candidate: source files with line refs, public method
surface, constructor, generics, dependencies, lifecycle, and migration
source. **Signatures only; no implementation.**

All line refs are into `src/` (e.g., `db.ts:1061` means
`src/db.ts:1061`).

---

## Part A — Per-entity stores (Phase 6 + Phase 7)

### A1. `MemoryStore`

- **Source files:** `db.ts` (entity at `db.ts:1061`; behavior in the
  ~17 functions listed at `02-type-interface-analysis.md` Section
  Entity-1), `memory.ts` (`buildMemoryContext`, `runDecaySweep`,
  `runDailyDigest`, `saveConversationTurn`), `agent.ts`,
  `web/heartbeat-agent-scaffold.ts`, `web/channel-monitor.ts`,
  `web/routes/memories.ts`, `web/routes/migrate.ts`
- **Public method surface:**
  - `save(memory: Omit<Memory, 'id' | 'createdAt'>): Memory`
  - `saveAgentMemory(agentId: string, payload: AgentMemoryInput): Memory`
  - `search(query: string, opts: SearchOpts): Memory[]`
  - `searchAgentMemories(agentId: string, query: string, opts: SearchOpts): Memory[]`
  - `recent(limit: number): Memory[]`
  - `recentForChat(chatId: string, limit: number): Memory[]`
  - `recentForAgent(agentId: string, limit: number): Memory[]`
  - `touch(id: number): void`
  - `touchMany(ids: number[]): void`
  - `decay(now: number): number` (returns count decayed)
  - `update(id: number, patch: MemoryPatch): Memory`
  - `hybridSearch(query: string, embedding: number[], opts: HybridSearchOpts): RankedMemory[]`
  - `vectorSearch(embedding: number[], opts: VectorSearchOpts): Memory[]`
  - `stats(): MemoryStats`
  - `reRankByRecency(results: Memory[], now: number): Memory[]`
- **Constructor:** `constructor(db: Database, opts: { recencyLambda: number; recencyTauSec: number; embeddingModel?: string })`
- **Generics:** none (the cache generic is its own class, see
  `04-generic-interfaces.md` G2)
- **Dependencies:** `Database` (from `db/sqlite.ts`), the new
  `TtlCache<string, MemoryCacheEntry>` (see G2) injected as
  `cache: TtlCache<string, MemoryCacheEntry>`, `EmbeddingClient` (new
  thin wrapper around the SDK call sites)
- **Lifecycle:** instantiated in `index.ts` after `initDatabase()`;
  held in the `App` instance; never reloaded in prod (the `cache`
  invalidates on file-write via `store-watcher`); in tests,
  per-test instantiation with `:memory:` db
- **Migration source:** replaces the `memoryCache` Map + `RECENCY_*`
  constants + the ~17 free functions in `db.ts` (lines ~1080–1620 per
  the entity cluster), plus the `MemoryCacheEntry` private interface at
  `db.ts:1240`

### A2. `KanbanCards`

- **Source files:** `db.ts` (entity at `db.ts:1627`; behavior in
  the ~18 functions listed at `02-type-interface-analysis.md` Section
  Entity-2), `kanban-dispatch.ts`, `heartbeat.ts`, `web/routes/kanban.ts`
- **Public method surface:**
  - `create(input: NewKanbanCard): KanbanCard`
  - `get(id: number): KanbanCard | null`
  - `list(filter: KanbanFilter): KanbanCard[]`
  - `listSummary(filter: KanbanFilter): KanbanCardSummary[]`
  - `listArchived(filter: KanbanFilter): ArchivedKanbanCard[]`
  - `listProjects(): KanbanProject[]`
  - `update(id: number, patch: KanbanPatch): KanbanCard`
  - `move(id: number, status: KanbanStatus, prevStatus: KanbanStatus): KanbanCard`
  - `archive(id: number): KanbanCard`
  - `unarchive(id: number): KanbanCard`
  - `delete(id: number): void`
  - `dispatch(id: number, agentId: string): KanbanCard` (one-shot guard
    via `markKanbanCardDispatched`)
  - `markScheduledWaiting(id: number): void`
  - `addComment(id: number, comment: NewKanbanComment): KanbanComment`
  - `comments(id: number): KanbanComment[]`
  - `events(id: number): KanbanCardEvent[]`
  - `findActiveByTitle(title: string): KanbanCard | null`
  - `findByIdPrefix(prefix: string): number | null`
  - `children(parentId: number): KanbanCard[]`
- **Constructor:** `constructor(db: Database)`
- **Generics:** none
- **Dependencies:** `Database`; uses the `dispatch` guard internally
  (the `prev !== status` event-write logic at the `moveKanbanCard`
  call site moves into the class)
- **Lifecycle:** instantiated in `index.ts` once; held in `App`
- **Migration source:** replaces the ~18 free functions in `db.ts`
  spanning `listKanbanCards` through `findActiveKanbanCardByTitle` and
  the `KanbanCardEvent` insert logic scattered across those functions

### A3. `MessageBus`

- **Source files:** `db.ts` (entity at `db.ts:2002`), `web/routes/messages.ts`,
  `web/message-router.ts`, `web/agent-worker.ts`
- **Public method surface:**
  - `create(input: NewAgentMessage): AgentMessage`
  - `get(id: number): AgentMessage | null`
  - `pending(limit?: number): AgentMessage[]`
  - `pendingBacklog(agentId: string): AgentBacklog`
  - `claimPending(toAgent: string, limit: number): AgentMessage[]`
    (the single `UPDATE … RETURNING` from `claimPendingForAgent`)
  - `markDelivered(id: number): void`
  - `markDone(id: number, result: unknown): void`
  - `markFailed(id: number, error: string): void`
  - `failPendingFederated(reason: string): number`
  - `closeUndelivered(): number`
  - `list(filter: MessageFilter): AgentMessage[]`
  - `conversation(agentId: string, opts: ConversationOpts): AgentMessage[]`
  - `threads(agentId: string): AgentThread[]`
  - `stampTrace(id: number, ctx: TraceContext): void`
- **Constructor:** `constructor(db: Database, logger: Logger)`
- **Generics:** none
- **Dependencies:** `Database`, `Logger`
- **Lifecycle:** instantiated in `index.ts`; held in `App`; `pending`
  and `claimPending` are the hot path used by `web/agent-worker.ts`
- **Migration source:** replaces the 13 functions listed at
  `02-type-interface-analysis.md` Section Entity-3

### A4. `Scheduler`

- **Source files:** `db.ts` (entity at `db.ts:1555`; `PendingTaskRetryRow`
  at `db.ts:2322`), `auto-restart.ts`, `pending-retries.ts`,
  `web/schedule-runner.ts`, `web/auto-restart-runner.ts`
- **Public method surface:**
  - `create(input: NewScheduledTask): ScheduledTask`
  - `due(now: number, limit: number): ScheduledTask[]`
  - `updateAfterRun(id: number, outcome: RunOutcome): void`
  - `list(filter: TaskFilter): ScheduledTask[]`
  - `get(id: number): ScheduledTask | null`
  - `update(id: number, patch: TaskPatch): ScheduledTask`
  - `pause(id: number): void`
  - `resume(id: number): void`
  - `delete(id: number): void`
  - `activeCount(): number`
  - `advance(task: ScheduledTask, now: number): RunPlan` (consolidates
    `pending-retries.ts:shouldSendAlert` + `restartDue` + the
    `web/schedule-runner.ts` decision)
  - `classifyFailure(message: string): 'transient' | 'permanent'`
  - `alertIfDue(row: PendingTaskRetryRow, now: number): boolean`
  - `markAlerted(rowId: number, ts: number): void`
- **Constructor:** `constructor(db: Database, logger: Logger, opts: { alertThresholdMs: number })`
- **Generics:** none
- **Dependencies:** `Database`, `Logger`
- **Lifecycle:** instantiated in `index.ts`; held in `App`; consumed
  per-tick by `web/schedule-runner.ts`
- **Migration source:** replaces the `ScheduledTask` free functions in
  `db.ts`, the decision logic in `pending-retries.ts`, and the
  `restartDue`/`dailyPhaseAtMs`/`parseHHMM` helpers in `auto-restart.ts`

### A5. `BackgroundTaskPool`

- **Source files:** `db.ts` (entity at `db.ts:1492`), `web/command-task.ts`
- **Public method surface:**
  - `tryAcquire(input: NewBackgroundTask): BackgroundTask | null` (the
    `maxConcurrent` cap logic from `createBackgroundTaskAtomic`)
  - `finish(id: number, outcome: RunOutcome): void`
  - `running(): BackgroundTask[]`
  - `list(filter: TaskFilter): BackgroundTask[]`
  - `get(id: number): BackgroundTask | null`
  - `countRunning(): number`
  - `reapOrphans(now: number): number`
- **Constructor:** `constructor(db: Database, opts: { maxConcurrent: number; orphanThresholdMs: number })`
- **Generics:** none
- **Dependencies:** `Database`
- **Lifecycle:** instantiated in `index.ts`; held in `App`
- **Migration source:** replaces the 7 functions listed at
  `02-type-interface-analysis.md` Section Entity-5

### A6. `ApprovalStore`

- **Source files:** `db.ts` (entity at `db.ts:3132`), `web/routes/approvals.ts`
- **Public method surface:**
  - `request(input: NewApproval): Approval`
  - `get(id: number): Approval | null`
  - `resolve(id: number, decision: 'approved' | 'rejected', actor: string): Approval`
  - `list(filter: ApprovalFilter): Approval[]`
  - `sweepExpired(now: number): number`
- **Constructor:** `constructor(db: Database)`
- **Generics:** none
- **Dependencies:** `Database`
- **Lifecycle:** instantiated in `index.ts`; held in `App`; the
  `sweepExpired` method is called by `web/approval-timeout-sweeper.ts`
- **Migration source:** replaces the 5 functions listed at
  `02-type-interface-analysis.md` Section Entity-6

### A7. `SpanStore`

- **Source files:** `db.ts` (entity at `db.ts:3239`; summary projection
  at `db.ts:3277`), `web/routes/spans.ts`, `web/message-router.ts`
  (for trace stamping middleware)
- **Public method surface:**
  - `startSpan(input: NewSpan): OtelSpan` (the running span)
  - `closeSpan(traceId: string, spanId: string, status: SpanStatus, error?: string): OtelSpan`
  - `upsert(span: OtelSpan): OtelSpan`
  - `getTrace(traceId: string): OtelTraceSummary`
  - `listTraces(filter: TraceFilter): OtelTraceSummary[]`
- **Constructor:** `constructor(db: Database)`
- **Generics:** none
- **Dependencies:** `Database`
- **Lifecycle:** instantiated in `index.ts`; held in `App`; called per
  span start/close from middleware
- **Migration source:** replaces the 4 functions listed at
  `02-type-interface-analysis.md` Section Entity-7

### A8. `IdeaStore`

- **Source files:** `db.ts` (entity at `db.ts:2564`; comment at
  `db.ts:2620`; status log at `db.ts:2643`)
- **Public method surface:**
  - `list(filter: IdeaFilter): IdeaBoxRow[]`
  - `create(input: NewIdea): IdeaBoxRow`
  - `update(id: number, patch: IdeaPatch): IdeaBoxRow`
  - `delete(id: number): void`
  - `categories(): IdeaCategory[]`
  - `comments(ideaId: number): IdeaComment[]`
  - `addComment(ideaId: number, body: string, author: string): IdeaComment`
  - `statusLog(ideaId: number): IdeaStatusLogRow[]`
  - `transition(id: number, next: IdeaStatus, actor: string): IdeaBoxRow`
  - `revertFromKanban(ideaId: number): IdeaBoxRow`
- **Constructor:** `constructor(db: Database, logger: Logger)`
- **Generics:** none
- **Dependencies:** `Database`, `Logger`
- **Lifecycle:** instantiated in `index.ts`; held in `App`
- **Migration source:** replaces the 9 functions listed at
  `02-type-interface-analysis.md` Section Entity-8

### A9. `SshVault`

- **Source files:** `db.ts` (entity at `db.ts:3031`; server at
  `db.ts:3077`), `remote-enroll-fs.ts`, `remote-enroll-core.ts`
- **Public method surface:**
  - `listKeys(): VaultSshKey[]`
  - `getKey(id: number): VaultSshKey | null`
  - `createKey(input: NewVaultSshKey): VaultSshKey`
  - `deleteKey(id: number): void`
  - `listServers(): VaultSshServer[]`
  - `getServer(id: number): VaultSshServer | null`
  - `createServer(input: NewVaultSshServer): VaultSshServer`
  - `updateServer(id: number, patch: VaultSshServerPatch): VaultSshServer`
  - `deleteServer(id: number): void`
  - `enroll(opts: EnrollOptions): EnrollResult`
  - `remove(opts: RemoveEnrolledOptions): RemoveEnrolledResult`
  - `computeStatus(keyId: number, serverId: number): SshKeyStatus`
- **Constructor:** `constructor(db: Database, opts: LockOptions)`
- **Generics:** none
- **Dependencies:** `Database`; the `LockOptions` class from O1
  (`04-generic-interfaces.md`)
- **Lifecycle:** instantiated in `index.ts`; held in `App`; per-call
  by the CLI scripts in `bin/`
- **Migration source:** replaces the 9 free functions in `db.ts`
  plus the file-side `enrollAuthorizedKey` / `removeEnrolledKey`
  pair in `remote-enroll-fs.ts`

### A10. `SettingsRegistry`

- **Source files:** `config-registry.ts` (entity at `config-registry.ts:20`;
  `SettingType` at `config-registry.ts:18`; `HEX_COLOR_RE` private
  regex at `config-registry.ts:35`)
- **Public method surface:**
  - `define(entry: SettingDefinition): void`
  - `undefine(key: string): void`
  - `getDefinition(key: string): SettingDefinition | null`
  - `listModules(): string[]`
  - `listKeys(module?: string): string[]`
  - `validate(def: SettingDefinition, raw: unknown): SettingValidationResult`
- **Constructor:** `constructor(entries: SettingDefinition[])`
- **Generics:** none
- **Dependencies:** none (data-only; pure functions over the
  `entries` array)
- **Lifecycle:** instantiated at module load (the static
  `SETTINGS_REGISTRY` array becomes the constructor argument);
  effectively a singleton
- **Migration source:** replaces `SETTINGS_REGISTRY`,
  `getSettingDefinition`, `listSettingModules`,
  `validateSettingValue` in `config-registry.ts`

### A11. `SettingsStore`

- **Source files:** `settings-store.ts` (cache at `settings-store.ts:46`;
  `cache` Map + `watcher` + `ensureWatching`)
- **Public method surface:**
  - `getEffective(key: string): string | number | undefined`
  - `getOverrides(): Record<string, string | number>`
  - `setOverride(key: string, raw: unknown): SetOverrideResult`
  - `clearOverride(key: string): void`
  - `invalidate(): void`
  - `startWatching(): void` (replaces `ensureWatching`)
  - `stopWatching(): void` (replaces the watcher close logic)
  - `handleWatchEvent(event: WatchEvent): void` (test-only escape
    hatch, replaces `__test_handleWatchEvent`)
  - `reloadFromDisk(): void` (test-only escape hatch, replaces
    `reloadOverridesForTest`)
- **Constructor:** `constructor(registry: SettingsRegistry, opts: { overridesPath: string; pollMs?: number })`
- **Generics:** none (per-store typed; see `04-generic-interfaces.md`
  G4 for the broader `SettingsStore<TOverrides>` future)
- **Dependencies:** `SettingsRegistry`, `fs.watch`
- **Lifecycle:** instantiated in `index.ts` once; `startWatching()`
  called after construction; `stopWatching()` called from
  `shutdown()`; re-init safe (the watcher is guarded)
- **Migration source:** replaces the module-level `cache` +
  `watcher` + `ensureWatching` + `getOverrides` +
  `getEffectiveSettingValue` + `setOverride` + `__test_handleWatchEvent`
  + `reloadOverridesForTest` cluster in `settings-store.ts`

### A12. `ChannelProviderRegistry`

- **Source files:** `channel-provider.ts` (interface at
  `channel-provider.ts:11`; `ChannelProviderType` at
  `channel-provider.ts:9`; 5 provider objects at
  `channel-provider.ts:53, 134, 243, 324, 364`; decorator at
  `channel-provider.ts:490`)
- **Public method surface:**
  - `register(type: ChannelProviderType, provider: ChannelProvider): void`
  - `get(type: ChannelProviderType): ChannelProvider`
  - `getType(): ChannelProviderType`
  - `getToken(): string`
  - `getChatId(): string`
  - `stateDir(): string`
  - `readToken(): Promise<string | null>`
- **Constructor:** `constructor(providers: Map<ChannelProviderType, ChannelProvider>, opts: { testRunMarking?: boolean })`
- **Generics:** none
- **Dependencies:** the 5 concrete `ChannelProvider` implementations
  (`TelegramChannelProvider`, `SlackChannelProvider`,
  `DiscordChannelProvider`, `GoogleChatChannelProvider`,
  `TeamsChannelProvider`) and the `TestRunMarkingDecorator`
- **Lifecycle:** instantiated in `index.ts` once at boot; held in
  `App`; the registry's `providers` map is immutable after
  construction (mutation through `register` is dev/test only)
- **Migration source:** replaces the `providers` and `markedProviders`
  records at `channel-provider.ts:477` and `channel-provider.ts:500`,
  plus the `getProvider` / `getProviderType` / `getChannelToken` /
  `getChannelChatId` / `channelStateDir` / `readChannelToken` /
  `withTestRunMarking` free functions

### A13. `TelegramChannelProvider`, `SlackChannelProvider`,
`DiscordChannelProvider`, `GoogleChatChannelProvider`,
`TeamsChannelProvider`

- **Source files:** `channel-provider.ts:53, 134, 243, 324, 364`
- **Public method surface (shared via base class):**
  - `readonly type: ChannelProviderType`
  - `getToken(): string`
  - `getChatId(): string`
  - `stateDir(): string`
  - `readToken(): Promise<string | null>`
  - `sendMessage(text: string, opts?: SendOpts): Promise<SendResult>`
  - `splitMessage(text: string, max: number): string[]` (shared default
    delegates to `format.ts:splitMessage`)
- **Constructor (each):** `constructor(opts: { token: string; chatId: string; stateDir: string })` — same shape, per-provider-specific optional fields (e.g. `SlackChannelProvider` adds `appToken: string`)
- **Generics:** none
- **Dependencies:** `format.ts` (`splitMessage`), provider-specific
  SDK / HTTP client
- **Lifecycle:** instantiated by `ChannelProviderRegistry.register`
  at boot; held by the registry for the process lifetime
- **Migration source:** replaces the 5 provider objects at
  `channel-provider.ts:53, 134, 243, 324, 364`

### A14. `TestRunMarkingDecorator`

- **Source files:** `channel-provider.ts:490`
- **Public method surface:** same as `ChannelProvider` (delegates
  to `inner`); constructor takes a `ChannelProvider`
- **Constructor:** `constructor(inner: ChannelProvider, marker: TestRunMarker)`
- **Generics:** none
- **Dependencies:** a `ChannelProvider` (the wrapped instance)
- **Lifecycle:** wraps the inner provider at registry construction;
  disposed when the registry is disposed (never in prod; tests
  construct fresh per-test)
- **Migration source:** replaces the `withTestRunMarking` wrapper
  function at `channel-provider.ts:490`

---

## Part B — Runner classes (Phase 4 + Phase 5)

### B1. `HeartbeatScheduler`

- **Source files:** `heartbeat.ts` (`initHeartbeat` at
  `heartbeat.ts:584`; `stopHeartbeat` at `heartbeat.ts:594`;
  module-level `heartbeatTimeout` and `stopped` at
  `heartbeat.ts:565-566`)
- **Public method surface:**
  - `start(): void` (replaces `initHeartbeat`)
  - `stop(): void` (replaces `stopHeartbeat`)
  - `triggerNow(): Promise<HeartbeatOutcome>` (replaces
    `executeHeartbeat`)
  - `scheduleNext(delayMs: number): void`
  - `cancel(): void`
- **Constructor:** `constructor(opts: { db: Database; intervalMs: number; logger: Logger; memoryStore: MemoryStore })`
- **Generics:** none
- **Dependencies:** `Database`, `Logger`, `MemoryStore`, `Scheduler`
  (for the `restartDue` decision)
- **Lifecycle:** instantiated in `index.ts`; `start()` called at
  boot; `stop()` called in `shutdown()` before the digest timer
  disposal
- **Migration source:** replaces the module-level
  `heartbeatTimeout` + `stopped` + `scheduleNext` +
  `initHeartbeat` + `stopHeartbeat` + `executeHeartbeat` cluster
  in `heartbeat.ts`

### B2. `StoreWatcher`

- **Source files:** `store-watcher.ts` (`startStoreWatcher` at
  `store-watcher.ts:88`; module-level `watcher`, `knownFiles`,
  `recentEvents`, `currentWriteActor`)
- **Public method surface:**
  - `start(): void` (replaces `startStoreWatcher`)
  - `stop(): void` (replaces `stopStoreWatcher`)
  - `setWriteActor(actor: string): void` (replaces
    `setStoreWriteActor`)
  - `clearWriteActor(): void` (replaces `clearStoreWriteActor`)
  - `handleFsEvent(event: fs.WatchEventType, filename: string): void`
    (test-only)
  - `getRecentEvents(): WatchEvent[]` (test-only)
- **Constructor:** `constructor(opts: { watchDir: string; logger: Logger; onChange: (event: WatchEvent) => void })`
- **Generics:** none
- **Dependencies:** `fs.watch`, `Logger`
- **Lifecycle:** instantiated in `index.ts` once; `start()` called
  at boot; `stop()` called in `shutdown()`
- **Migration source:** replaces the module-level
  `watcher` + `knownFiles` + `recentEvents` + `currentWriteActor`
  + `setStoreWriteActor` + `clearStoreWriteActor` +
  `startStoreWatcher` + `stopStoreWatcher` cluster in
  `store-watcher.ts`

### B3. `BasePaneWatcher<TState, TThresholds>`

- **Source files:** `pane-state.ts` (the three decision functions
  `decidePaneErrorAlert`, `decideStuckInputRecovery`,
  `decideStuckToolCallRecovery`; entity types `StuckInputState` /
  `PaneState` / `StuckToolCallState`)
- **Public method surface:**
  - `abstract readonly NO_STATE: TState`
  - `abstract step(observation: unknown, prev: TState, now: number, thresholds: TThresholds): { act: boolean; next: TState }`
  - `protected spellStartGate(now: number, lastSpellStart: number, thresholdMs: number): boolean`
  - `protected clockSkewGuard(now: number, prevNow: number): boolean`
  - `protected retryBudgetGuard(attempts: number, maxAttempts: number): boolean`
  - `protected confirmDedup(seen: boolean, cooldownMs: number, now: number, lastFire: number): boolean`
- **Constructor:** `protected constructor(logger: Logger)`
- **Generics:** `TState`, `TThresholds` (both constrained per-subclass
  via the abstract `NO_STATE` field type; see `04-generic-interfaces.md`
  G1)
- **Dependencies:** `Logger`
- **Lifecycle:** instantiated per-watcher at boot; held by the
  watcher runner in `web/`
- **Migration source:** replaces the duplicated spell-start /
  clock-skew / retry-budget / confirm-dedup gates in the three
  decision functions in `pane-state.ts`

### B4. `PaneErrorAlertWatcher`, `StuckInputRecoveryWatcher`,
`StuckToolCallRecoveryWatcher`

- **Source files:** `pane-state.ts` (each decision function);
  consumers `web/stuck-input-watcher.ts`, `web/stuck-tool-call-watcher.ts`,
  `web/agent-process.ts`, `web/schedule-runner.ts`
- **Public method surface (each):**
  - extends `BasePaneWatcher<TState, TThresholds>`
  - implements `step(observation, prev, now, thresholds)` with the
    state-specific transition
  - exposes the specific `TState` / `TThresholds` types as generic
    params
- **Constructor:** `constructor(logger: Logger)`
- **Generics:** each subclasses `BasePaneWatcher` with its own
  concrete `TState` / `TThresholds` (e.g.,
  `StuckInputRecoveryWatcher extends BasePaneWatcher<StuckInputState, StuckInputThresholds>`)
- **Dependencies:** `Logger`
- **Lifecycle:** instantiated once at boot; held by the runner
- **Migration source:** replaces the three free `decide*` functions
  in `pane-state.ts`

### B5. `web/MessageRouter`, `web/ScheduleRunner`,
`web/ChannelMonitor`, `web/InboundProber`,
`web/ChannelHealthMonitor`, `web/StuckInputWatcher`,
`web/InboxNudgeWatcher`, `web/StuckToolCallWatcher`,
`web/ReauthHealer`, `web/AutoRestartRunner`,
`web/ModelFallbackRunner`, `web/ContextGuardRunner`,
`web/UpdateChecker`, `web/FederationPoller`,
`web/CapabilitySummaryRunner`, `web/InviteMonitor`,
`web/ChannelRequestWatcher`, `web/CostsSyncTask`,
`web/ApprovalTimeoutSweeper`

- **Source files:** one each in `src/web/`. Per `01-module-state-analysis.md`
  Section 6.4, ~20 `start*()` functions follow the same shape
- **Public method surface (shared via `BaseRunner<T>` interface, see
  G6 in `04-generic-interfaces.md`):**
  - `start(): void`
  - `stop(): void`
  - `protected tick(): Promise<void>` (or `sync`)
- **Constructor (each):** `constructor(opts: { db: Database; logger: Logger; ...runner-specific })`
- **Generics:** see G6 — `BaseRunner<TFacts, TDecision>` is the
  shared shape
- **Dependencies:** `Database`, `Logger`, runner-specific (e.g.,
  `MessageRouter` needs `MessageBus` + `AgentWorker`; `ScheduleRunner`
  needs `Scheduler` + `MemoryStore`)
- **Lifecycle:** instantiated in `App` after stores; `start()`
  called at boot; `stop()` called in `shutdown()` (order matters:
  see `01-module-state-analysis.md` Section 8)
- **Migration source:** replaces each `startXxxRunner()` /
  `stopXxxRunner()` free function pair

[ASSUMPTION: The exact count of `start*()` functions in `web/` is
approximately 20 based on `01-module-state-analysis.md` Section 6.4,
which listed the dominant patterns; a precise enumeration was not
done in the source files analyzed.]

### B6. `DashboardServer`

- **Source files:** `web.ts` (`startWebServer` at `web.ts:88`; the
  `auth.kind === 'token' ? { kind: 'token' as const } : ...` chain
  at `web.ts:155-159`)
- **Public method surface:**
  - `start(): Promise<http.Server>`
  - `stop(): Promise<void>`
  - `use(middleware: Middleware): void`
  - `registerRoute(method: string, path: string, handler: RouteHandler): void`
  - `getToken(): string`
  - `getAllowedOrigins(): string[]`
  - `authContext(req: IncomingMessage): AuthContext` (the sealed-class
    return type; replaces `ctxAuth` ternary chain)
- **Constructor:** `constructor(opts: { port: number; host: string; token: string; allowedOrigins: string[]; routeContext: RouteContext })`
- **Generics:** none
- **Dependencies:** `RouteContext` (DI bag for route handlers; the
  type lives in `web/routes/types.ts`), `AuthContext` sealed
  hierarchy (see `04-generic-interfaces.md` D1)
- **Lifecycle:** instantiated in `App`; `start()` awaited at boot;
  `stop()` called in `shutdown()` last
- **Migration source:** replaces `startWebServer` at `web.ts:88` and
  the file-local `DASHBOARD_TOKEN` + `allowedOrigins` closures

---

## Part C — Lazy-cache singletons (Phase 3)

### C1. `ClaudeCodeBinResolver`

- **Source files:** `agent.ts` (the `cachedClaudeCodeBin` cache at
  `agent.ts:81` + `resolveClaudeCodeBin` at `agent.ts:82`)
- **Public method surface:**
  - `resolve(): string | undefined`
  - `invalidate(): void`
- **Constructor:** `constructor(opts: { envVar?: string; probeDirs?: string[]; existsSync?: (p: string) => boolean })`
- **Generics:** none
- **Dependencies:** `node:fs` (`existsSync`), `process.env`
- **Lifecycle:** instantiated in `App`; per-call memoized; cleared on
  `invalidate()`
- **Migration source:** replaces the module-level
  `cachedClaudeCodeBin` + `resolveClaudeCodeBin`

### C2. `GoogleTokenCache` + `GoogleCalendarClient`

- **Source files:** `google-api.ts` (`cachedTokens` + `cachedClient`
  at `google-api.ts:51-52`; `refreshInFlight` single-flight at
  `google-api.ts:108`)
- **Public method surface (`GoogleTokenCache`):**
  - `getTokens(): Promise<TokenData>`
  - `saveTokens(tokens: TokenData): Promise<void>`
  - `getClient(opts: { tokens: TokenData }): GoogleClient`
  - `refresh(): Promise<string>` (the single-flight wrapper)
- **Public method surface (`GoogleCalendarClient`):**
  - `getCalendarEvents(query: ListQuery): Promise<CalendarEvent[]>`
- **Constructor (`GoogleTokenCache`):** `constructor(opts: { tokenPath: string; credentials: ClientCredentials; logger: Logger })`
- **Constructor (`GoogleCalendarClient`):** `constructor(cache: GoogleTokenCache)`
- **Generics:** none
- **Dependencies:** `node:fs`, `Logger`
- **Lifecycle:** instantiated in `App`; the cache mtime-invalidates
  on each `getTokens()` call
- **Migration source:** replaces the `cachedTokens` + `cachedClient` +
  `refreshInFlight` + `getCalendarEvents` cluster in `google-api.ts`

### C3. `GraphMailCredentialsCache` + `GraphMailTokenCache` +
`GraphMailClient`

- **Source files:** `graph-mail.ts` (`cachedCreds` at `graph-mail.ts:68`;
  `cachedToken` at `graph-mail.ts:132`; `parseCredentials` is pure
  and stays as-is)
- **Public method surface (`GraphMailCredentialsCache`):**
  - `loadCredentials(): Promise<MailCredentials>` (mtime-invalidated)
- **Public method surface (`GraphMailTokenCache`):**
  - `getToken(): Promise<string>` (expiry-checked)
  - `refresh(creds: MailCredentials): Promise<string>`
- **Public method surface (`GraphMailClient`):**
  - `verifyAccess(): Promise<boolean>`
  - `listMessages(opts: ListMessagesOptions): Promise<GraphMessage[]>`
  - `sendMail(opts: SendMailOptions): Promise<SendResult>`
- **Constructor (each):** `constructor(opts: { credPath: string; logger: Logger; cacheDir: string })`
- **Generics:** none
- **Dependencies:** `node:fs`, `Logger`
- **Lifecycle:** instantiated in `App`; the credentials cache is
  mtime-invalidated, the token cache is expiry-checked
- **Migration source:** replaces the `cachedCreds` + `cachedToken`
  + the exported `listMessages` + `sendMail` + `verifyAccess` in
  `graph-mail.ts`

### C4. `LazyBin<TName>`

- **Source files:** `platform.ts` (`makeLazyBinResolver` at
  `platform.ts:74`)
- **Public method surface:**
  - `resolve(): string | null`
  - `invalidate(): void`
- **Constructor:** `constructor(name: TName, opts: { resolver?: (n: TName) => string | null } = {})`
- **Generics:** `TName extends string` (constrained to a string
  literal; see `04-generic-interfaces.md` G7)
- **Dependencies:** `process.env.PATH`, the optional custom
  `resolver`
- **Lifecycle:** instantiated in `App` for each binary name; held
  in a registry map on `App`
- **Migration source:** replaces `makeLazyBinResolver` and the
  module-level `PLATFORM` singleton at `platform.ts:74`

---

## Part D — Keystone conversions (Phase 7)

### D1. `Config` (replaces `config.ts` module singleton)

- **Source files:** `config.ts` (~40 frozen `const` exports + the
  `cfg()` layered override reader)
- **Public method surface:**
  - `get(key: string): string | undefined` (the override-aware read)
  - `requireString(key: string): string`
  - `requireInt(key: string): number`
  - `requireBool(key: string): boolean`
  - `getNumber(key: string, fallback: number): number`
  - `getBrandName(): string`
  - `getAppTz(): string`
  - `isAppTzConfigured(): boolean`
  - `getChannelProvider(): ChannelProviderType`
  - `getChannelToken(): string`
  - `getChannelChatId(): string`
  - `getWebPort(): number`
  - `getWebHost(): string`
  - `getMainAgentId(): string`
  - `getProjectRoot(): string`
  - `getStoreDir(): string`
  - `getDbFilename(): string`
  - `getPidFilename(): string`
- **Constructor:** `constructor(opts: { env: NodeJS.ProcessEnv; overridesPath?: string; logger?: Logger })`
- **Generics:** none
- **Dependencies:** `node:fs` (the overrides reader), `Logger`
- **Lifecycle:** instantiated first in `App`; held in `App`;
  frozen on construction (the override file is read once);
  re-instantiation only happens in tests via `new Config({...})`
- **Migration source:** replaces the ~40 frozen `const` exports
  at `config.ts:12` through `config.ts:158`, plus the `cfg()`
  function; the ~23 importing files are updated to take `Config`
  via DI

### D2. `DbClient` (replaces `db.ts` module singleton)

- **Source files:** `db.ts` (`let db` at `db.ts:10`; `initDatabase`
  at `db.ts:42`; `getDb` at `db.ts:978`; the ~200 free functions
  that close over `db`)
- **Public method surface:** the per-entity store constructors
  (A1–A9) plus:
  - `raw(): Database` (escape hatch for tests / one-off queries)
  - `close(): void`
  - `runScript(sql: string): void`
- **Constructor:** `constructor(opts: { filename: string; pragmas?: string[]; readonly?: boolean })`
- **Generics:** none (the entity stores carry their own generic
  parameters; see `04-generic-interfaces.md` G4 for a future
  `DbClient<TOverrides>`)
- **Dependencies:** `bun:sqlite` (`Database`); the entity stores
  are constructed with the `DbClient` and held by `App`
- **Lifecycle:** instantiated in `App` after `Config`; entity
  stores constructed immediately after; `close()` called in
  `shutdown()` last
- **Migration source:** replaces the module-level `let db` and
  the ~200 free functions in `db.ts`

[ASSUMPTION: The exact count `~200` free functions in `db.ts` is
based on the textual claim in `01-module-state-analysis.md`
Section 1, which says "hundreds"; a precise line-count of exported
functions was not done.]

### D3. `App` (replaces `index.ts` orchestrator)

- **Source files:** `index.ts` (70+ imports; module-level
  `webServer`, `decayInterval`, `digestTimer`, `digestInterval`,
  `shuttingDown`, `exitCode`; 2 regexes `PID_FILE`,
  `DASHBOARD_BINARY_PATTERN`; the `BANNER` constant; 4 helper
  closures; `buildProcessLockContext`; `buildPidfileLockContext`;
  `shutdown()`; `main()`; `acquireLock()`; `releaseLock()`)
- **Public method surface:**
  - `start(): Promise<void>` (replaces `main()`)
  - `shutdown(signal?: Signal): Promise<void>` (replaces
    `shutdown()`)
  - `acquireLock(): Promise<void>` (replaces top-level
    `acquireLock()`)
  - `releaseLock(): Promise<void>` (replaces top-level
    `releaseLock()`)
  - `getStore(name: K): StoreFor<K>` (typed accessor for
    entity stores; see G8 in `04-generic-interfaces.md`)
- **Constructor:** `constructor(opts: { config: Config; db: DbClient; logger: Logger; argv: string[]; env: NodeJS.ProcessEnv })`
- **Generics:** `K extends string` for `getStore<K>` (a string
  literal union of store names; see G8)
- **Dependencies:** every other class in this document;
  `Config`, `DbClient`, `Logger`, all entity stores
  (`MemoryStore`, `KanbanCards`, `MessageBus`, `Scheduler`,
  `BackgroundTaskPool`, `ApprovalStore`, `SpanStore`,
  `IdeaStore`, `SshVault`), `SettingsRegistry`,
  `SettingsStore`, `ChannelProviderRegistry`, all `web/*Runner`
  instances, `DashboardServer`, `HeartbeatScheduler`,
  `StoreWatcher`, the `LazyBin` registry
- **Lifecycle:** top-level construction is the only one
  (`new App({...}).start()`); `shutdown()` is called from the
  SIGTERM/SIGINT handlers; disposed in the order: digest timer
  → decay interval → heartbeat → store watcher → settings store
  → runners → web server → process lock → db
- **Migration source:** replaces the 6 module-level `let`
  bindings + 4 closures + `shutdown` + `main` + `acquireLock` +
  `releaseLock` in `index.ts`

### D4. `AuthContext` sealed hierarchy (used inside `DashboardServer`)

- **Source files:** `web/auth-gate.ts` (the union source);
  `web.ts:155-159` (the consumer)
- **Public method surface (abstract):**
  - `abstract readonly kind: 'token' | 'device' | 'session' | 'federation'`
- **Subclasses:** `TokenAuth`, `DeviceAuth`, `SessionAuth`,
  `FederationAuth` (each is a sealed subclass carrying the
  per-kind payload)
- **Constructor (each subclass):** `constructor(payload)` — e.g.,
  `DeviceAuth` takes `device: DeviceRow`; `SessionAuth` takes
  `user: DashboardUserPublic`; `FederationAuth` takes
  `peer: string`
- **Generics:** none
- **Dependencies:** `DeviceRow`, `DashboardUserPublic`
- **Lifecycle:** created by `DashboardServer.authContext(req)`
  per request; never held
- **Migration source:** replaces the `auth.kind === 'token' ? {
  kind: 'token' as const } : ...` ternary chain at
  `web.ts:155-159`; the source union in `web/auth-gate.ts` stays
  as the auth-gate's *return type* until `web/auth-gate.ts` is
  itself rewritten (out of scope; see `00-summary.md`)

---

## Part E — Process lock classes (Phase 2)

### E1. `PortLockAcquirer`

- **Source files:** `process-lock.ts` (`acquirePortLock` at
  `process-lock.ts:169`; `ProcessLockContext` interface at
  `process-lock.ts:26`; `findOwnNodeHolders` and
  `terminateProcesses` helpers)
- **Public method surface:**
  - `acquire(port: number, opts?: AcquirePortLockOptions): Promise<PortLockResult>`
  - `release(): Promise<void>`
  - `protected listPortHolders(port: number): Promise<PidHolder[]>`
  - `protected sendSignal(pid: number, signal: NodeJS.Signals): Promise<SignalOutcome>`
- **Constructor:** `constructor(ctx: ProcessLockContext)`
- **Generics:** none
- **Dependencies:** the injected `ProcessLockContext` (in tests,
  a mock; in prod, `DefaultProcessLockContext`)
- **Lifecycle:** instantiated in `App`; `acquire()` awaited at
  boot before `start()`; `release()` awaited in `shutdown()`
- **Migration source:** replaces `acquirePortLock(port, ctx, opts)`
  at `process-lock.ts:169`

### E2. `PidfileLockAcquirer`

- **Source files:** `process-lock.ts` (`acquirePidfileLock` at
  `process-lock.ts:289`; `PidfileLockContext` at
  `process-lock.ts:226`)
- **Public method surface:**
  - `acquire(path: string, selfPid: number, opts?: AcquirePidfileLockOptions): Promise<PidfileResult>`
  - `release(): Promise<void>`
- **Constructor:** `constructor(ctx: PidfileLockContext)`
- **Generics:** none
- **Dependencies:** the injected `PidfileLockContext`
- **Lifecycle:** instantiated in `App`; `acquire()` awaited at
  boot; `release()` awaited in `shutdown()`
- **Migration source:** replaces `acquirePidfileLock(path, selfPid,
  ctx, opts)` at `process-lock.ts:289`

---

## Part F — Out-of-scope (mentioned for context)

The following are flagged in the prior analyses but explicitly
deferred (see `00-summary.md`):

- `CostOpsLedger` (entity cluster in `costops/ledger.ts`)
- `BackfillCoordinator` (state machine in
  `src/channel-coordinator/index.ts` per Section 6.1)
- `McpListCache` (the cache wrapper in `web/mcp-list.ts`; the
  pure `applyRefreshOutcome` stays a free function)
- `RemoteEnrollment` (the lifecycle encapsulation of
  `enrollAuthorizedKey` / `removeEnrolledKey`; merged into
  `SshVault` per A9 above)
- `TelegramApiError` (already a class in
  `src/channel-coordinator/telegram-client.ts`; no migration
  needed)
- `DeferToPeerError` (already a class at
  `process-lock.ts:272`; no migration needed)
- `RemoteEnrollError` (already a class at
  `remote-enroll-core.ts:30`; no migration needed)
