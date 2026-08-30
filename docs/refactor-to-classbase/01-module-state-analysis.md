# Module State Analysis — Top-level `src/`

Planning-only audit of every TypeScript file at the top level of `src/` (excluding `__tests__/` and the four subdirectories `channel-coordinator/`, `costops/`, `db/`, `web/`). Focus is **MODULE STRUCTURE and STATE patterns** to inform a class-based refactor.

The three large files — `db.ts`, `web.ts`, `index.ts` — are covered structurally via grep, not full reads (their bodies are 100k+ lines and the patterns below are visible from headers).

---

## 1. Brief summary

- **44 top-level TypeScript files** (excluding `__tests__/`).
- **Distribution by shape:**
  - **Pure utility / constants module** (no state, no singletons): 18 files
  - **Factory / pure-function module** (functions accept state as args): 11 files
  - **Module-level singleton** (cached state at top of file): 9 files
  - **Hybrid** (exported functions + module-level mutable state): 6 files
- **Class declarations at top level:** `process-lock.ts` exposes a single `class DeferToPeerError`. Everything else uses function-shaped APIs.
- **Top 3 hardest conversions to class-based shape:**
  1. `db.ts` — `Database` instance stored in a module-level `let db: Database`, hundreds of exported free functions that close over it; this is the textbook singleton-to-class case.
  2. `web.ts` — giant `startWebServer()` factory that builds closures over `DASHBOARD_TOKEN`, `allowedOrigins`, and an `http.Server`. No `let` server handle, but everything is wired at function-call time.
  3. `index.ts` — the orchestrator that imports ~70 modules, runs `acquireLock()`, owns the `webServer`, `decayInterval`, `digestTimer`, `digestInterval`, `shuttingDown`, `exitCode` handles, and then calls `shutdown()`. Hardest because it touches every other module.

---

## 2. Inventory table

| File | Current shape | Module state | Conversion difficulty (1=trivial, 5=hard) |
|---|---|---|---|
| `agent.ts` | Hybrid: pure classifier `classifyAgentResult` + `runAgent` factory that reads module-level cache `cachedClaudeCodeBin` | Yes — `cachedClaudeCodeBin` (lazy-init cache) | 2 |
| `auto-restart.ts` | Pure utilities (`parseHHMM`, `restartDue`, `dailyPhaseAtMs`) + `DEFAULT_AUTO_RESTART` constant | No | 1 |
| `channel-coordinator.ts` | Hybrid: pure helpers (`neutralizeChannelTags`, `buildHandoffContent`, `transientBackoffMs`, `inNative409Cooldown`) + runnable main loop with state machine (`state`, `downStreak`, `stopping`, `nativeConfirmedUpUntil`) and `process.on(SIGTERM/SIGINT)` | Yes — 4 mutable bindings + 2 pid-file + `installSignalHandlers` | 4 |
| `channel-provider.ts` | Hybrid: pure provider-registry + 5 module-level `const XProvider: ChannelProvider = {...}` singletons + `withTestRunMarking()` wrapping layer + module-level `providers` and `markedProviders` Maps | Yes — 2 module-level registry records + the wrapping factory | 3 |
| `config-registry.ts` | Pure: `SETTINGS_REGISTRY: SettingDefinition[]` constant + `validateSettingValue()` | No (data only) | 1 |
| `config.ts` | **Heavy module singleton**: every export is a `const` derived from `.env` at import time, then frozen. ~40 module-level `const`s. Mutates `process.exit` reachable code via `cfg()`. Imports `readEnvFile()` at module scope. | Yes — every named export is a frozen boot-time singleton; `cfg()` reads `config-overrides.json` at import time and caches result | 3 |
| `context-guard.ts` | Pure: `decideGuard(state, inputs, cfg)` reducer + `INITIAL_GUARD_STATE` const + `DEFAULT_CONTEXT_GUARD` const | No (data only) | 1 |
| `costops/*` | Pure utilities (`getCostSummary`, `loadCostopsConfig`, `validateConfig`) | No (data only) | 1 |
| `db.ts` | **Heavy module singleton**: `let db: Database` + `initDatabase()` + ~200 exported free functions that close over `db` | Yes — `let db: Database` is the entire module's hot state | 5 |
| `db/sqlite.ts` | Thin re-export shim around `bun:sqlite` (`Database`, `pragma`, `runScript`, `getPragma`, type `SQLQueryBindings`) | No | 1 |
| `env.ts` | Pure functions (`readEnvFile`, `updateEnvFile`) over a frozen `PROJECT_ROOT` const | No (data only) | 1 |
| `format.ts` | Pure: `formatForTelegram`, `escapeHtml`, `splitMessage`, `formatForSlackMrkdwn` etc. | No | 1 |
| `google-api.ts` | Hybrid: module-level token cache `cachedTokens`, `cachedClient`, single-flight `refreshInFlight` + exported `getCalendarEvents()` | Yes — 3 module-level let bindings | 3 |
| `graph-mail.ts` | Hybrid: module-level `cachedCreds`, `cachedToken` + exported `parseCredentials` (pure), `listMessages`, `sendMail`, `verifyAccess` | Yes — 2 module-level caches | 3 |
| `heartbeat.ts` | Hybrid: pure `formatHeartbeatCardLabel`, `buildAgentPrompt` (data) + module-level `heartbeatTimeout`, `stopped`, `scheduleNext` + exported `initHeartbeat`, `stopHeartbeat`, `executeHeartbeat` | Yes — 2 module-level lets (`heartbeatTimeout`, `stopped`) | 4 |
| `index.ts` | Heavy singleton orchestrator: 70+ imports, module-level `webServer`, `decayInterval`, `digestTimer`, `digestInterval`, `shuttingDown`, `exitCode`, `PID_FILE`, `BANNER`, `DASHBOARD_BINARY_PATTERN`, `buildProcessLockContext`, `buildPidfileLockContext`, `shutdown()`, `main()`, `acquireLock()`, `releaseLock()` | Yes — 6 module-level lets + 2 module-level regexes + 4 helper closures | 5 |
| `kanban-dispatch.ts` | Pure: `resolveKanbanDispatchTarget` | No | 1 |
| `logger.ts` | Singleton: `export const logger = pino({...})` — runs once at import | Yes — single exported singleton (importable everywhere) | 1 (already class-shaped if you treat pino as a class instance) |
| `mcp-list-parser.ts` | Pure: `parseMcpListLine`, `parseMcpList`, `applyRefreshOutcome`, `scrubPaths`, `slugify`, `catalogMatchesConfigured` | No | 1 |
| `memory.ts` | Hybrid: pure `buildMemoryContext`, `buildKanbanContext`, `runDecaySweep` + `ensureDigestCwd`, `ensureDigestConfigDir` (lazy mkdir) + async `runDailyDigest`, `saveConversationTurn` | No (no mutable state, only fs side effects) | 1 |
| `model-fallback.ts` | Pure: `DEFAULT_MODEL_CHAIN`, `decideModelAction`, `nextFallbackModel`, `detectsUsageLimit`, `normalizeModelFallbackConfig` | No | 1 |
| `model-profiles.ts` | Pure: `MODEL_PROFILE_IDS`, `isModelProfileId`, `validateModelProfileMap`, `resolveAgentModelFromConfig` | No | 1 |
| `notify.ts` | Hybrid: `notifyChannel` factory + module-level import of `CHANNEL_PROVIDER`/`CHANNEL_TOKEN`/`CHANNEL_CHAT_ID` from `config.ts` (those are themselves module singletons) | No new state, but reads 3 config singletons | 2 |
| `pending-retries.ts` | Pure: `shouldSendAlert`, `classifyTelegramSendError`, `toPendingRetryView` | No | 1 |
| `platform.ts` | Hybrid: pure `tryResolveFromPath`, `resolveFromPath`, `makeLazyBinResolver` + module-level `PLATFORM` const computed at import via `detect()` | Yes — `PLATFORM` singleton + closure factory | 2 |
| `process-lock.ts` | Hybrid: pure `acquirePortLock`, `acquirePidfileLock`, `findOwnNodeHolders`, `terminateProcesses`, `writeBufferFully`, plus `class DeferToPeerError` (the only true class at top level) | No (data only — `ctx` is injected) | 2 |
| `prompt-safety.ts` | Pure: `wrapUntrusted`, `wrapTrustedPeer`, `wrapScheduledTask`, `wrapChannelInbound`, `scrubSecurityTags`, `sanitizeCapabilityTag`, `sanitizeOriginNote`, `sanitizeAgentIdent`, `sanitizeAgentSource`, `generateFetchNonce`, plus `UNTRUSTED_PREAMBLE`, `TRUSTED_PEER_PREAMBLE`, `SCHEDULED_TASK_PREAMBLE`, `CHANNEL_INBOUND_PREAMBLE`, `STRIPPED_SENTINEL` (computed at import via `randomBytes`) | Yes — `STRIPPED_SENTINEL` is per-process random, generated once | 1 |
| `remote-enroll-core.ts` | Pure: `validatePublicKeyLine`, `restrictOptions`, `buildRestrictedLine`, `mergeAuthorizedKeys`, `removeAuthorizedKey`, `parseHostKeyPub`, `parseKeyscanEd25519`, `resolveHostKey`, `buildBundle`, `encodeBundle`, `decodeBundle`, plus `class RemoteEnrollError` and constants `REMOTE_PORT`, `ACCEPTED_KEY_TYPE`, `COMMENT_PREFIX`, `BUNDLE_FORMAT` | No (data only) | 1 |
| `remote-enroll-fs.ts` | Hybrid: `acquireLock`, `releaseLock`, `writeAtomic`, `ensureSshDir` (fs side effects) + `enrollAuthorizedKey`, `removeEnrolledKey` (orchestrating) + constants | No | 1 |
| `settings-store.ts` | **Singleton with watcher**: module-level `cache: Record<...>`, `watcher: FSWatcher`, `loadFromDisk()` reads at import; `ensureWatching()` lazily starts `fs.watch`; `getOverrides`, `getEffectiveSettingValue`, `setOverride`, `reloadOverridesForTest`, `__test_handleWatchEvent` | Yes — 3 module-level lets (cache, watcher, the `recentEvents` Map referenced indirectly); an `fs.watch` registration runs on first call | 4 |
| `store-watcher.ts` | Singleton with watcher: module-level `currentWriteActor`, `knownFiles`, `recentEvents`, `watcher`, plus `setStoreWriteActor`, `clearStoreWriteActor`, `startStoreWatcher`, `stopStoreWatcher` | Yes — 4 module-level lets, including an `fs.watch` registration | 4 |
| `team-trust.ts` | Pure: `isTrustedPeer` taking a `TrustContext` (injected) | No | 1 |
| `test-run-marker.ts` | Pure: `isTestRun`, `markIfTestRun`, `TEST_RUN_PREFIX` constant | No | 1 |
| `tool-timeouts.ts` | Data only: `TOOL_TIMEOUTS` const record | No | 1 |
| `update-agent-capability.ts` | Pure: `claudeAgentRunnable`, `cpuinfoHasAvx` (over injected `readCpuinfo`) | No | 1 |
| `update-preflight.ts` | Pure: `checkNoConcurrentUpdate`, `checkUpdatePreflight`, `classifyLockWriteError` over injected `GitRunner` / `PidfileRunner` | No | 1 |
| `web.ts` | **Heavy factory**: `startWebServer(port = 3420): http.Server` builds closures over `DASHBOARD_TOKEN`, `allowedOrigins`; no module-level `let` server handle, but the request handler is a 1500-line closure that captures every route handler by import | Yes — local `DASHBOARD_TOKEN`, `allowedOrigins` captured at startup | 5 |
| `web/*` | Mostly runners/starters with internal state — see §6 | Various | 3–5 |

---

## 3. Patterns section

### 3.1 Common factory patterns

Three flavours recur:

1. **Pure-function-with-state-as-first-arg** (textbook "stateless decision"):
   - `decideGuard(state: GuardState, inputs: GuardInputs, cfg: ContextGuardConfig): GuardDecision` (`context-guard.ts:276`)
   - `decideModelAction(f: ModelFallbackFacts): ModelAction` (`model-fallback.ts:129`)
   - `resolveKanbanDispatchTarget(assignee, opts: DispatchResolveOpts)` (`kanban-dispatch.ts:25`)
   - `isTrustedPeer(from, to, ctx: TrustContext)` (`team-trust.ts:55`)
   - `resolveAgentModelFromConfig(config, mapState, defaultModel, aliasResolver)` (`model-profiles.ts:97`)
   - `applyRefreshOutcome(input: RefreshInput): RefreshOutcome` (`mcp-list-parser.ts:256`)

   These are the easiest class conversions: each function is a method that becomes `class GuardDecider { decide(state, inputs, cfg) {...} }`. No state migration required; the class can be a namespace of statics or a per-instance stateless object.

2. **Context-injected factory** (DI via injected interface to avoid `import './web.js'`):
   - `acquirePortLock(port, ctx: ProcessLockContext, opts)` (`process-lock.ts:169`)
   - `acquirePidfileLock(path, selfPid, ctx: PidfileLockContext, opts)` (`process-lock.ts:289`)
   - `resolveHostKey(sources: HostKeySources, candidates)` (`remote-enroll-core.ts:302`)
   - `checkUpdatePreflight(git: GitRunner)` (`update-preflight.ts:130`)
   - `claudeAgentRunnable(plat, readCpuinfo)` (`update-agent-capability.ts:30`)

   These are already "class-shaped" — the `ctx` argument is essentially `this`. A class refactor turns each `ctx.listPortHolders(port)` call into `this.listPortHolders(port)` and the test mocks `vi.mock('./process-lock.js')` work unchanged. This is the strongest argument for going class-based: every test that currently has to build a `ProcessLockContext` object becomes a single `new PortLockAcquirer(mockFs).acquire(port)` call.

3. **Runner-as-closure factory** (one-shot state machine returned from a `start…()` call):
   - `startStoreWatcher()` (`store-watcher.ts:88`) — captures `watcher`, `knownFiles`, `recentEvents`, `currentWriteActor` in module scope, no return value
   - `initHeartbeat()` / `stopHeartbeat()` (`heartbeat.ts:584`/`594`) — captures `heartbeatTimeout`, `stopped`
   - `channel-coordinator.ts:runLoop()` (`channel-coordinator.ts:311`) — state machine `state`/`downStreak`/`stopping`/`nativeConfirmedUpUntil`
   - `web.ts:startWebServer()` — captures `DASHBOARD_TOKEN`, `allowedOrigins`, route handler closures

   These are the hardest conversions. The current code uses module-level lets because the runner's tick callback needs to mutate them; turning them into instance fields requires either (i) a `class HeartbeatScheduler { private timeout; private stopped; ... }` plus passing the instance around (significant surface change at call sites), or (ii) keeping them module-level but extracting the pure decision into a class method.

### 3.2 Common singleton patterns

Three flavours:

1. **Exported-instance singleton** (the class instance IS the export):
   - `logger.ts:3` — `export const logger = pino({...})`. Already class-shaped (pino is a class).
   - `prompt-safety.ts:49` — `STRIPPED_SENTINEL` is computed once per process via `randomBytes(4).toString('hex')`. Not class-shaped, but the comment explains the intent (grep-ability, randomness).

2. **Module-level cache via lazy let** (the canonical singleton):
   - `agent.ts:81` — `let cachedClaudeCodeBin: string | undefined | null = null` + `resolveClaudeCodeBin()` memoizes on first call.
   - `google-api.ts:51-52` — `cachedTokens`, `cachedClient` (with `mtimeMs` invalidation).
   - `google-api.ts:108` — `refreshInFlight: Promise<string> | null` (single-flight).
   - `graph-mail.ts:68` — `cachedCreds: { value, mtimeMs }` (same mtime-invalidation pattern).
   - `graph-mail.ts:132` — `cachedToken: { value, expiresAt, clientId }`.
   - `platform.ts:74` — `makeLazyBinResolver(name)` returns a closure that caches its `resolveFromPath` result.

   These translate trivially: each cache becomes a `private` instance field on a `class XClient { private cache; private inflight; ... }`. The mtime-invalidation pairs are the most class-like (cache + invalidation rule are co-located), so this is the lowest-friction conversion.

3. **Module-level collections populated at import** (registry pattern):
   - `channel-provider.ts:477` — `const providers: Record<ChannelProviderType, ChannelProvider> = { telegram: ..., slack: ..., discord: ..., googlechat: ..., teams: ... }`.
   - `channel-provider.ts:500` — `markedProviders` is built by wrapping each provider through `withTestRunMarking()`.
   - `config-registry.ts:37` — `SETTINGS_REGISTRY: SettingDefinition[]` (data, not state — easy).
   - `costops/config.ts:66/75` — `EMPTY_CONFIG`, `EXAMPLE_CONFIG` (data).

   The registry is technically mutable (overwritten by `cache = next` in `settings-store.ts:103`) but the registry itself is data. The conversion path here is: turn `providers` into a `class ChannelProviderRegistry` whose constructor accepts the per-provider implementations, with `getProvider(type)` as a method. This unblocks per-test overrides (currently `vi.mock('../channel-provider.js')` is the only way to swap providers — see §7).

### 3.3 Module-coupling observations

- **`config.ts` is the keystone.** 23 top-level files import it (`grep -l "from './config.js'" src/`). Every other module either reads one of the ~40 frozen `const`s (e.g. `CHANNEL_PROVIDER`, `MAIN_AGENT_ID`, `WEB_PORT`) or the layered `cfg()` for boot-time override-aware reads. Because the file is so widely imported, converting it to a class would require touching every dependent in the same patch — this is the reason `config.ts` is the second-hardest in the table.
- **`logger.ts` is imported by ~25 modules**. Already a singleton; conversion is a no-op.
- **`db.ts` is imported by ~30 modules**. Hardest single refactor because every import is `function foo()` (free function) that closes over the module-level `db`; turning `db` into an instance requires every caller to obtain the instance (DI or a getter on a class instance). The current `getDb()` export at `db.ts:978` is the natural accessor for the class-based version.
- **`heartbeat.ts` ↔ `memory.ts` ↔ `db.ts` cross-call**: `heartbeat.ts` calls `runDecaySweep()` from `memory.ts`, which calls `dbDecay()`/`pruneAuditLogs()`/`pruneTokenUsage()` from `db.ts`. Each of those is a free function with no DI — a class-based refactor would need to thread a `Database` instance through three files.
- **The runner files import from each other in a non-trivial DAG**: `web/agent-process.ts` imports from `web/agent-config.ts`, `web/agent-scaffold.ts`, `web/main-agent.ts`, etc. The web/ subdirectory has a circular-import dance (per the comments in `config.ts:21` — `settings-store.ts` imports `config.ts` and vice-versa). A class refactor that introduces constructor DI would break those cycles by replacing the module import with a getter on a shared `Context` instance.

---

## 4. Anti-patterns section — things that look class-like but aren't

These are the most interesting refactor opportunities, because the file's *shape* already implies a class but it is expressed as module-level closures:

### 4.1 Functions taking state as the first arg

- `decideGuard(state, inputs, cfg)` — three pieces of "this" passed positionally. A `class GuardDecider` with `decide(inputs, cfg)` and `private state` would be a strict readability win.
- `decideModelAction(facts)` — same shape.
- `resolveKanbanDispatchTarget(assignee, opts)` — same shape; `opts` is essentially `this.config`.
- `isTrustedPeer(from, to, ctx)` — `ctx` is essentially `this.peerLookup` and `this.mainAgentId`.
- `applyRefreshOutcome(input)` — `input` carries the entire world.
- `validateSettingValue(def, raw)` — pure but the registry `def` is the implicit context.

These are the lowest-risk conversions. They keep their pure-function property (still unit-testable with fake args), and the class version is `static` methods or a namespace with no state — purely cosmetic.

### 4.2 Namespace-style modules

- `format.ts` exports 10 small pure functions. Already namespace-shaped; an `export namespace Format {...}` (or a `class Format { static ... }`) makes the namespace explicit.
- `mcp-list-parser.ts` — same shape, 7 exports.
- `prompt-safety.ts` — 13 exports plus 4 preamble constants. Same shape.
- `remote-enroll-core.ts` — 13 exports plus `RemoteEnrollError`. Same shape.
- `config-registry.ts` — registry + 2 helpers + the validator. Could become `class SettingRegistry { entries: SettingDefinition[]; get(key); listModules(); validate(def, raw); }`.

### 4.3 Closures-as-class

These are the genuinely class-shaped patterns that aren't yet classes:

- `platform.ts:74 makeLazyBinResolver(name)` returns `() => { if (cached === null) cached = resolveFromPath(name); return cached }`. This IS a class — `class LazyBin { constructor(name) { this.name = name; } resolve() { ... } }` is a literal translation.
- `agent.ts:82 resolveClaudeCodeBin()` — same pattern, closure that lazily resolves and caches.
- `google-api.ts:54 loadTokens()` / `saveTokens()` — operates on module-level `cachedTokens`. The mtime-invalidation rule + the cache + the file IO are co-located; a `class TokenCache { get(); save(); }` is the natural shape.
- `graph-mail.ts:105 loadCredentials()` — same pattern as above.
- `settings-store.ts:46 ensureWatching()` + `cache: Record` + `watcher: FSWatcher` — the cache, the watcher handle, and the `__test_handleWatchEvent` callback are a class. The class version exposes `getOverrides()`, `setOverride()`, and the watcher lifecycle as methods.

### 4.4 Singleton-with-init-flag

- `db.ts:10 let db: Database` + `db.ts:42 initDatabase()` — the canonical "lazy singleton". `initDatabase()` is the `constructor`; `getDb()` is the accessor; the ~200 free functions become methods that take the instance implicitly through `this`.
- `store-watcher.ts:81 let watcher: ReturnType<typeof watch> | null` + `startStoreWatcher()`/`stopStoreWatcher()` — same shape but with a non-DB resource (an fs.watch handle).
- `heartbeat.ts:565-566 let heartbeatTimeout; let stopped` + `initHeartbeat()`/`stopHeartbeat()` — same shape with a timer handle.
- `web.ts` is the inverse: no module-level handle, but `startWebServer()` returns the `http.Server` and the file-local `DASHBOARD_TOKEN` / `allowedOrigins` are closures. This is closer to a class than the others — a `class DashboardServer { constructor(port, token, origins); start(); }` is a direct translation.

### 4.5 Singleton-with-multiple-instances-is-impossible

A handful of modules hold module-level state that *cannot* have two instances:

- `config.ts` exports are frozen at import; you cannot get a "second config". This is the strongest argument for *not* converting config.ts — it's intentionally a singleton. A class-based version would still be a single instance, so the user-visible change is purely cosmetic.
- `prompt-safety.ts` `STRIPPED_SENTINEL` is random per process. Could be a `class SecurityWrapping { private sentinel = randomBytes(4); wrap(...); }` instance, but the singleton property is intentional (so `grep '[[SECURITY_TAG_REMOVED_' ...` finds every occurrence).

---

## 5. Cross-file shared state

These are the state pieces that span more than one module. Listing the access points matters for the refactor because each shared state piece either stays at module scope (simplest) or moves into a class instance (and then every reader needs an instance).

| Shared state | Owner | Readers (top-level) | Refactor risk |
|---|---|---|---|
| `db: Database` singleton | `db.ts` (`let db`, `initDatabase`) | `memory.ts`, `heartbeat.ts`, `agent.ts`, `costops/ledger.ts`, `index.ts`, and ~25 web/ files | Highest — see §3.3 |
| Logger | `logger.ts` (`export const logger`) | ~25 modules | Trivial — already singleton |
| `PROJECT_ROOT`, `STORE_DIR`, `DB_FILENAME`, `PID_FILENAME`, `MAIN_AGENT_ID`, `APP_TZ`, `CHANNEL_PROVIDER`, `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`, `WEB_PORT`, `WEB_HOST`, `OLLAMA_URL` | `config.ts` (frozen at import) | `notify.ts`, `heartbeat.ts`, `memory.ts`, `db.ts`, `web.ts`, `index.ts`, `store-watcher.ts`, `settings-store.ts`, `env.ts`, `remote-enroll-fs.ts`, `agent.ts`, `remote-enroll-core.ts`, `costops/config.ts`, `costops/ledger.ts` | High — converting config.ts touches every dependent |
| `OVERRIDES_PATH` and the cache `Record<string, string \| number>` | `settings-store.ts` | `heartbeat.ts` (via `getEffectiveSettingValue`) | Medium — only one consumer at top level |
| `currentWriteActor: string \| null` | `store-watcher.ts` | Set/cleared by route handlers in `web/routes/*.ts`; read by the watch callback | Medium — the actor slot is a tiny per-process mutable cell |
| `PROCESS.env.MARVEEN_*` overrides | `process` | `agent.ts`, `google-api.ts`, `index.ts` | Low — already global |
| `process.platform`, `os.homedir()`, `os.userInfo()` | Node | `graph-mail.ts`, `google-api.ts`, `heartbeat.ts`, `platform.ts`, `index.ts`, `costops/*`, `remote-enroll-fs.ts` | Low |
| `pendingTaskRetries` table (DB, not a module singleton) | `db.ts` | `web/routes/*`, `pending-retries.ts` (just types) | Already DB-backed, not a singleton risk |
| Kanban cards / scheduled tasks / memories | `db.ts` (DB rows) | all routes | Same as DB singleton |
| `RESPAWN_ENABLED`, `HEARTBEAT_AGENT_ENABLED` | `config.ts` | `index.ts`, `web/heartbeat-agent-scaffold.ts` | Already via config singleton |
| `CHANNEL_PROVIDER` per-call `getProvider(type)` lookup | `channel-provider.ts` | `notify.ts`, `web/channel-monitor.ts`, `web/agent-scaffold.ts`, `web/routes/*` | Low — already a registry pattern |
| `modelProfileMap` (settings file content) | `settings-store.ts` + a `web/agent-config.ts` reader | `web/agent-config.ts` | Already DB/settings-backed |
| Heartbeat timer handle | `heartbeat.ts` | `index.ts` (calls `initHeartbeat()`/`stopHeartbeat()`) | Medium |
| Channel coordinator state machine | `channel-coordinator.ts` | None (single-process loop) | High — see `web.ts` style |
| Process lock file handles | `index.ts` | None | Medium — `index.ts` owns them |
| `webServer: http.Server` | `index.ts` | None — `index.ts` owns it | Medium — see `index.ts` analysis |

The standout shared state piece is the `db` singleton. Converting it touches the most files and is the highest-risk single refactor in this codebase.

---

## 6. Brief subdirectory scan

(Per the brief: 1–2 paragraphs per subdir, no exhaustive enumeration.)

### 6.1 `src/channel-coordinator/`

Four small files: `ingest.ts`, `liveness.ts`, `provider-poller-match.ts`, `telegram-client.ts`. Pure-helper style — `ingest.ts` exposes `initIngestDb()`, `insertIncomingEvent()`, `getEventsNeedingHandoff()`, etc., each closing over its own module-level `Database` handle. `telegram-client.ts` is a thin wrapper around `fetch()` with a typed `TelegramApiError` class. `liveness.ts` is `probeNativeChannelDown(session, provider)` — pure. `provider-poller-match.ts` is a string-matching helper. **Pattern:** same `db: Database` module-singleton pattern as `db.ts`, but scoped to the coordinator's own schema. Conversion path is the same as `db.ts` (extract a `CoordinatorDb` class with the table-specific methods as instance methods).

### 6.2 `src/costops/`

Two files: `config.ts` and `ledger.ts`. Pure utilities — `loadCostopsConfig()`, `validateConfig()`, `getCostSummary()`, `hashRef()`, `monthWindow()`. No mutable module state. Already class-shaped (a `class CostOpsLedger` with the report-generation methods would be cosmetic). Data-only.

### 6.3 `src/db/`

One file: `sqlite.ts`. A thin re-export shim around `bun:sqlite` exposing `Database`, `pragma()`, `runScript()`, `getPragma()`, plus the `SQLQueryBindings` type. Pure (functions take the `Database` as the first arg). Already DI-style — converting `Database` itself to a class wrapper is unnecessary.

### 6.4 `src/web/`

~90 files. The dominant pattern here is **runner-as-start-fn**: `startStoreWatcher()`, `startMessageRouter()`, `startScheduleRunner()`, `startChannelMonitor()`, `startInboundProber()`, `startChannelHealthMonitor()`, `startStuckInputWatcher()`, `startInboxNudgeWatcher()`, `startStuckToolCallWatcher()`, `startReauthHealer()`, `startAutoRestartRunner()`, `startModelFallbackRunner()`, `startContextGuardRunner()`, `startUpdateChecker()`, `startFederationPoller()`, `startCapabilitySummaryRunner()`, `startScheduleRunner()`, `startInviteMonitor()`, `startChannelRequestWatcher()`, `startCostsSyncTask()`, `startApprovalTimeoutSweeper()`, `startAgentProcess()`. Each of these sets up timers, fs.watch handles, polling intervals, and other module-level mutable state. The "convert to class" path here is straightforward: each `startX()` becomes `new XRunner(opts).start()`, with the runner's `private watcher`, `private interval`, etc., as instance fields. The current shape forces `vi.mock('../web/X.js')` for testability — class refactor enables `vi.spyOn(runner, 'tick')` etc. instead.

A few outliers in `web/`:

- `web/atomic-write.ts`, `web/keychain.ts`, `web/password-hash.ts`, `web/http-helpers.ts`, `web/remote-status-cache.ts`, `web/fleet-transfer.ts` are pure utilities (already DI-friendly).
- `web/agent-scaffold.ts`, `web/agent-config.ts`, `web/agent-team.ts`, `web/agent-bundle.ts` are factory-heavy with their own mutable per-agent state.
- `web/routes/` is the request-handler layer (40+ `tryHandle*` functions); the `RouteContext` type is the DI seam that the refactor would formalize.

---

## 7. Test-mock hotspots

From `grep -rh "vi.mock(" src/__tests__/ | sort | uniq -c | sort -rn` (top 20):

| Mock target | Hit count | Notes |
|---|---|---|
| `../logger.js` | 78 | The most-mocked module — confirms the singleton concern; a class refactor that exposes `logger.info` as a method instead of a module import would let tests swap it via constructor injection instead of vi.mock |
| `../config.js` | 69 + 47 + 10 = 126 across three patterns | By far the most-mocked top-level file. Every test that touches a feature with config-driven behavior mocks `config.ts`. A class-based refactor with `new Config(env)` and DI into consumers would collapse most of these mocks |
| `node:child_process` | 48 + 16 | Mocked wherever a test exercises a code path that shells out (heartbeat, kanban-dispatch, model-fallback, etc.). Not affected by a class refactor |
| `../web/agent-config.js` | 42 + 9 | Mocked wherever a test needs to control agent config. The `web/agent-config.ts` factory pattern is a natural class candidate |
| `../db.js` | 35 | The DB singleton — every test that needs isolated DB state mocks it or uses `initDatabase(':memory:')`. Class refactor lets `new DbClient(':memory:')` be passed to consumers |
| `node:os` | 27 | `homedir`, `userInfo`, `platform` mocking. Not affected |
| `../web/agent-process.js` | 25 | Same pattern as agent-config |
| `../web/main-agent.js` | 22 | Same |
| `../web/auth-gate.js` | 22 | Auth context per-test |
| `node:fs` | 19 + 17 | Where the file watcher tests live |
| `../web/auth-sessions.js` | 18 | Auth |
| `../web/channel-monitor.js` | 14 | Channel monitor tests |
| `../web/atomic-write.js` | 14 | Where disk-write tests want a fake |
| `../platform.js` | 12 | PLATFORM + binary resolver |
| `../web/channel-mcp-reconnect.js` | 10 | |
| `../web/agent-config.js` | 9 (overlap above) | |

The hot mocks cluster around three patterns:

1. **Config injection** (`../config.js`, `../platform.js`, `../logger.js`) — currently requires `vi.mock` because these are module-level singletons. Class refactor with constructor DI replaces each `vi.mock` with a constructor argument.
2. **DB injection** (`../db.js`) — same pattern; class refactor enables `:memory:` per-test cleanly.
3. **Heavy I/O boundary** (`node:fs`, `node:child_process`, `../web/atomic-write.js`) — class refactor doesn't help directly; these stay mocked.

The implication: a class-based refactor would reduce vi.mock surface area in tests (good), but the test files that currently do `vi.mock('../config.js', () => ({ WEB_PORT: 4000, CHANNEL_PROVIDER: 'slack' }))` would need to be rewritten to construct a config instance. That's churn — every test that mocks config gets touched.

---

## 8. Re-initialization hazards

For each module-level singleton, what happens if the module is imported twice (e.g. via two different paths in a test, or via HMR):

- `db.ts` — `initDatabase()` is idempotent (closes the previous handle first). Safe to re-init; tests rely on this via `initDatabase(':memory:')`. If converted to a class with `new DbClient(path)`, two instances pointing at different paths would be the natural per-test isolation — even cleaner.
- `logger.ts` — pino is constructed once; re-import is a no-op. Safe.
- `channel-provider.ts` `providers` / `markedProviders` records — built once at import; no re-init logic. Two imports → two records, but `getProvider(type)` returns the same shape. Safe.
- `settings-store.ts` — `cache` is initialized at import via `cache = loadFromDisk()`. If the module is re-imported (which ESM prevents, but `vi.resetModules()` simulates), the cache resets. The watcher's `cache` and the `fs.watch` are both at module scope; re-import would re-read disk and re-register the watch. The `__test_handleWatchEvent` callback references the module-level `cache` closure, so two test instances would each have their own cache — safe in test, but a footgun in prod (a hot-reload would create a second watcher on the same dir).
- `store-watcher.ts` — `currentWriteActor` and `knownFiles` reset on re-import. The watcher registration is idempotent (checked via `if (watcher) return`). Safe but worth a guard.
- `agent.ts` `cachedClaudeCodeBin` — resets to `null` on re-import. First call after re-import re-probes. Safe.
- `google-api.ts` and `graph-mail.ts` caches — reset on re-import; first call re-reads from disk. Safe; could cause a flurry of token refreshes in a hot-reload scenario.
- `heartbeat.ts` `heartbeatTimeout`, `stopped` — reset on re-import; `initHeartbeat()` re-schedules. If the previous timer is still running, you get two timers. **This is a real hazard** — converting to a class with a `private timeout` would make the singleton property explicit.
- `process-lock.ts` — no module-level state; pure. Safe.

The two real re-init hazards are `heartbeat.ts` (double timer) and `settings-store.ts` (double watcher). Both would be eliminated by a class refactor that encapsulates the timer/watcher as a private instance field with a guarded `start()`/`stop()`.

---

## 9. Notes for the refactor plan

1. **Start with the pure-function-with-state-as-first-arg modules** (§4.1) — zero-risk, mechanical, improves readability. List: `context-guard.ts`, `model-fallback.ts`, `kanban-dispatch.ts`, `team-trust.ts`, `model-profiles.ts`, `mcp-list-parser.ts`, `auto-restart.ts`, `pending-retries.ts`, `update-preflight.ts`, `update-agent-capability.ts`, `remote-enroll-core.ts`.
2. **Then the lazy-cache singletons** (§3.2.2) — class with private cache field. List: `agent.ts`, `google-api.ts`, `graph-mail.ts`, `platform.ts`.
3. **Then the runner-with-start-fn patterns** (§3.1.3) — class with `start()`/`stop()` and private handles. List: `heartbeat.ts`, `store-watcher.ts`, `settings-store.ts`. These three eliminate the re-init hazards.
4. **Last, the keystone conversions**: `config.ts`, `db.ts`, `web.ts`, `index.ts`. These have the broadest blast radius — every other module imports at least one of them — and need to land in a single coordinated patch (or behind a feature flag) to avoid breaking the rest of the codebase.
5. **Skip entirely**: pure data-only modules (`tool-timeouts.ts`, `format.ts`, `mcp-list-parser.ts`'s constants, `config-registry.ts`, `pending-retries.ts`'s types) — converting them is cosmetic with no functional change.
6. **The single existing class `DeferToPeerError`** in `process-lock.ts` is a good template for how the codebase already names exceptions — keep the same convention (`XxxError extends Error`) for any new exceptions.
7. **The existing `ChannelProvider` interface** in `channel-provider.ts` is already a class-shaped contract — a `class TelegramChannelProvider implements ChannelProvider` would slot in cleanly without changing the interface or the registry.