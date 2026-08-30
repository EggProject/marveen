# C (web) — Class boundaries

Concrete class candidates for the C subsystem. **Signatures only; no
implementation.** Every claim below cites a file:line verified against
`src/web.ts` (576 LOC), `src/web/auth-gate.ts` (121 LOC),
`src/web/routes/types.ts` (27 LOC), the 44 route files in
`src/web/routes/`, and the 9 federation files in `src/web/federation/`
read on 2026-08-30, plus the precedent reviews
(`h-cross-cutting/`, `b-config/`, `d-channel-provider/`, `e-process-lock/`,
`a-db/`, `f-agent-subsystem/`, `g-channel-coordinator/`,
`review-correctness.md`, `review-completeness.md`).

**Reading note.** C produces **3 new core classes** (`AuthGate`,
`DashboardServer`, `DashboardServerDeps`) plus **19 new runner classes**
(one per `start*()` function) plus **4 federation sub-cluster classes**
(`FederationAddress`, `FederationBridge`, `FederationCapabilities`,
`FederationCapabilityRunner`) plus the 3 existing error classes that
survive unchanged (`PeerResponseTooLargeError`,
`FederationPollInternalError`, `RequestBodyTooLargeError`) plus the
existing `RemoteStatusCache<T>` (CE-9 precedent). Routes (44) stay as
free functions per `review-completeness.md` CE-7. The
introduce-alongside-free-function pattern follows the `B.1 Config` /
`D.1 ChannelEnv` / `E.1 PortLockAcquirer` / `F.1 HeartbeatScheduler`
precedent.

---

## Class candidate inventory

| Class | New? | Migration source | Phase |
|---|---|---|---|
| `AuthGate` | new | `resolveAuth:76-121` + `requiresAuth:68-74` + `isFederationWireEndpoint:58-63` + `parseCookies:40-52` (instance method) | C.1 |
| `DashboardServer` | new | `startWebServer:88-547` (the closure body) + the 19 `start*()` calls + the `server.close` override at `:548-573` | C.2 |
| `DashboardServerDeps` | new (interface) | the bundle opts for `DashboardServer` constructor | C.2 |
| `AuthGateDeps` | new (interface) | the bundle opts for `AuthGate` constructor | C.1 |
| 19 `XxxRunner` classes | new | one per `start*()` function (see §3 below for the corrected paths) | C.3 |
| `FederationAddress` | new | `address.ts` (51 LOC) — `parseQualifiedId` + `QualifiedId` interface | C.7 |
| `FederationBridge` | new | `bridge.ts` (179 LOC) — `sendFederatedMessage` + `BridgeSendResult` | C.7 |
| `FederationCapabilities` | new | `capabilities.ts` (343 LOC) — the capability cache + summary builder | C.7 |
| `FederationCapabilityRunner` | new | `capability-runner.ts:80` — `startCapabilitySummaryRunner` | C.7 |
| `FederationConfig` (class) | new | `federation/config.ts` (393 LOC) — wraps the 4 env-derived helpers + the dispatch table | C.7 |
| `FederationPoller` | new | `federation/poller.ts:276` — `startFederationPoller` | C.7 |
| `FederationOnboarding` | new | `federation/onboarding.ts` (393 LOC) | C.7 |
| `FederationLocalCatalog` | new | `federation/local-catalog.ts` (60 LOC) | C.7 |
| `FederationHttp` | new (or kept free) | `federation/http.ts:7` `PeerResponseTooLargeError` survives; the helpers `readBoundedBody` + `postJson` may class-extract | C.7 |
| `RemoteStatusCache<T>` | **NOT BUILT** (already a class at `web/remote-status-cache.ts:19`) | preserved verbatim per `review-completeness.md CE-1` | n/a |
| `PeerResponseTooLargeError` | **NOT BUILT** (already a class at `web/federation/http.ts:7`) | preserved verbatim per `review-completeness.md CE-1` | n/a |
| `FederationPollInternalError` | **NOT BUILT** (already a class at `web/federation/poller.ts:68`) | preserved verbatim per `review-completeness.md CE-1` | n/a |
| `RequestBodyTooLargeError` | **NOT BUILT** (already a class at `web/http-helpers.ts:25`) | preserved verbatim per `review-completeness.md CE-1` | n/a |

**Total new classes: 3 core + 19 runners + 4-9 federation = 26-31 new
classes, plus 4 existing classes preserved.**

---

## §C1. `AuthGate`

### Source and migration

- **Source file:** `src/web/auth-gate.ts` (121 LOC, same file,
  alongside the free functions).
- **Migration source:** the 4 exported functions
  (`resolveAuth:76-121`, `requiresAuth:68-74`,
  `isFederationWireEndpoint:58-63`, `parseCookies:40-52`) + the
  `AuthResult` type at `:29-34` + the `SESSION_COOKIE_NAME` const
  at `:36`. The 1 internal function `isSsePaneStream:54-56` becomes a
  private method.

### Public surface (signatures only)

```ts
class AuthGate {
  constructor(deps: AuthGateDeps)

  // -- the core gate --
  resolveAuth(req: http.IncomingMessage, url: URL, path: string, method: string): AuthResult

  // -- the path predicates --
  requiresAuth(path: string, method: string): boolean
  isFederationWireEndpoint(path: string, method: string): boolean

  // -- the projection helper (per OE-4: NO sealed class) --
  getRouteContextAuth(auth: AuthResult): RouteContext['auth']

  // -- cookie parsing (used inside resolveAuth) --
  parseCookies(header: string | undefined): Record<string, string>

  // -- accessors --
  readonly cookieName: string  // = SESSION_COOKIE_NAME
}

interface AuthGateDeps {
  config: Config                  // B-tier: needs DASHBOARD_TOKEN, PROJECT_ROOT for token load
  env: ChannelEnv                 // D-tier: identifyFederationCaller path
  log: LoggerLike                 // H-tier: structured warn/error on auth failures
  dashboardToken: string          // injected to avoid re-reading from disk per-request
}
```

### Constructor

- `(deps)`. The `deps` bundle pattern follows the `Config` precedent
  (`b-config/00-summary.md`), the `ChannelEnv` precedent
  (`d-channel-provider/03-class-boundaries.md:71`), and the
  `PortLockAcquirer` precedent
  (`e-process-lock/03-class-boundaries.md:42`). The `dashboardToken`
  is injected so `resolveAuth` does not need to re-read
  `loadOrCreateDashboardToken()` per request.
- **No I/O in the constructor.** Token load happens at boot time in
  `index.ts` (per `web.ts:94`) and is passed in.

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `resolveAuth(req, url, path, method)` | `resolveAuth(req, url, path, method, dashboardToken)` | `auth-gate.ts:76-121` | The 5-arm `AuthResult` return type is preserved verbatim (per `review-correctness.md C2`, the `'none'` arm is NOT dropped). `dashboardToken` is read from `this.deps.dashboardToken`. |
| `requiresAuth(path, method)` | `requiresAuth(path, method)` | `auth-gate.ts:68-74` | Pure function; reads `path`/`method` only. |
| `isFederationWireEndpoint(path, method)` | `isFederationWireEndpoint(path, method)` | `auth-gate.ts:58-63` | Pure function; no state. |
| `getRouteContextAuth(auth)` | (the `ctxAuth` ternary at `web.ts:154-159`) | new | The 5-arm → 4-arm projection. The `'none'` arm collapses to `undefined`. Per `review-completeness.md OE-4`: returns `RouteContext['auth']`, NOT a sealed class. |
| `parseCookies(header)` | `parseCookies(header)` | `auth-gate.ts:40-52` | Pure function; stays as a public method for tests that exercise it directly. |
| `cookieName` (getter) | `SESSION_COOKIE_NAME` const | `auth-gate.ts:36` | Exposed as a readonly getter so route consumers don't need a separate import. |

### Dependencies

- `Config` (B.1) — for `DASHBOARD_TOKEN`, `PROJECT_ROOT`, and the
  channel-env key passthrough.
- `ChannelEnv` (D.1) — for `getToken(provider)` in
  `identifyFederationCaller` (currently inlined in
  `web/auth-gate.ts:25`'s `import`).
- `LoggerLike` (H.1) — for the warn-level logs on auth failures.
- `AuthResult` type (preserved as a free export).
- `RouteContext['auth']` type (read from `routes/types.ts:24`).

### Lifecycle

- **One instance per process**, constructed at boot by `DashboardServer`
  (C.2) and held as a private field.
- **No `close()` method** — stateless after construction.

### Free functions that REMAIN after C.1

| Symbol | Location | Why it stays |
|---|---|---|
| `resolveAuth(req, url, path, method, dashboardToken)` | `auth-gate.ts:76` | Thin wrapper: `(r, u, p, m, t) => gate.resolveAuth(r, u, p, m)`. Removed in C.10. |
| `requiresAuth(path, method)` | `auth-gate.ts:68` | Thin wrapper. Removed in C.10. |
| `isFederationWireEndpoint(path, method)` | `auth-gate.ts:58` | Thin wrapper. Removed in C.10. |
| `parseCookies(header)` | `auth-gate.ts:40` | Thin wrapper. Removed in C.10. |
| `AuthResult` type | `auth-gate.ts:29-34` | **Stays as a free type export.** Per `review-completeness.md OE-4`: NO sealed class. |
| `SESSION_COOKIE_NAME` const | `auth-gate.ts:36` | Thin wrapper: `export const SESSION_COOKIE_NAME = gate.cookieName`. Removed in C.10. |
| `isSsePaneStream(path, method)` | `auth-gate.ts:54` | Becomes a `private` method; not exported. The free function (if any exists) is removed in C.1. |

### Critical decision: AuthContext is NOT sealed

Per `review-completeness.md OE-4` (DROP) and `review-correctness.md C2`
(the `'none'` case), the `getRouteContextAuth(auth)` method returns
`RouteContext['auth']` — the existing 4-arm literal-union object at
`routes/types.ts:24`, NOT a sealed class hierarchy. The `'none'` arm
of `AuthResult` collapses to `undefined`. This is the same shape
produced today by the ternary at `web.ts:154-159`.

**Rationale** (from OE-4):

1. The 5-arm `AuthResult` is preserved at the gate boundary; the
   4-arm `RouteContext.auth` is preserved at the route boundary.
   Sealing would add per-request allocation cost with zero
   compile-time benefit.
2. The 4-arm `RouteContext.auth` is consumed by only 2 route files
   (`auth.ts:9`, `security.ts:2`) per `02-type-interface-analysis.md
   §3.2`. The other 42 routes ignore `auth` entirely.
3. The migration window would need dual representation (per OE-4 §D4);
   that is a regression, not a refactor.

---

## §C2. `DashboardServer`

### Source and migration

- **Source file:** `src/web.ts` (576 LOC, same file, alongside the
  free function).
- **Migration source:** `startWebServer(port = 3420): http.Server`
  closure body at `:88-547`, plus the `server.close` override at
  `:548-573` (the 22-interval cleanup), plus the 19 `start*()` calls
  at `:334-447`.

### Public surface (signatures only)

```ts
class DashboardServer {
  constructor(deps: DashboardServerDeps)
  start(): http.Server
  stop(): Promise<void>                                // awaits server.close + all intervals cleared
  registerRoute(path: string, handler: RouteHandler): void   // extension seam
  getAuthContext(req: http.IncomingMessage, url: URL, path: string, method: string): RouteContext['auth']
  runServer(): http.Server                             // legacy alias for start(); for index.ts:451 back-compat
}

interface DashboardServerDeps {
  config: Config                  // B-tier
  env: ChannelEnv                 // D-tier
  auth: AuthGate                  // C.1 deliverable
  stores: RouteStores             // A-tier (per-store accessor; see §C5 below)
  log: LoggerLike                 // H-tier
  port?: number                   // default 3420
  webDir: string                  // PROJECT_ROOT/web
}

interface RouteStores {
  memory: MemoryStore              // A.5
  kanban: KanbanCards              // A.3
  messages: MessageBus             // A.3
  // ... per the A-tier surface; only the stores a route file needs
}
```

### Constructor

- `(deps)`. The `deps` bundle follows the `Config` / `ChannelEnv` /
  `AuthGate` precedent.
- **One I/O call**: `ensureDirs()` (mkdir for `AGENTS_BASE_DIR`,
  `web.ts:84-86`). May be moved to `start()` per the B.1 `Config`
  factory pattern, but the current code calls it eagerly.
- **No logger call in constructor** — all logging happens in `start()`.

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `start()` | `startWebServer(port)` body | `web.ts:88-547` | Runs the closure: load token, set CORS origins, register routes, start the 19 runners, open the listener, return `http.Server`. |
| `stop()` | (the `server.close` override at `web.ts:548-573`) | `web.ts:548-573` | Clears all 22 intervals (consolidated from the hand-rolled close handler), awaits `server.close()`, awaits `sweepExpiredSessions()` + `sweepExpiredDeviceKeys()`. |
| `registerRoute(path, handler)` | (the dispatch chain at `web.ts:173-215`) | new | Optional extension seam; the default chain is preserved. |
| `getAuthContext(req, url, path, method)` | (the `ctxAuth` ternary at `web.ts:154-159`) | new | Delegates to `this.auth.getRouteContextAuth(...)`. |
| `runServer()` | (the legacy free function) | new | Thin alias for `start()`; kept as a method for any code path that imports `dashboardServer.runServer()` directly. |

### Dependencies

- `Config` (B.1) — `WEB_HOST`, `WEB_PORT`, `DASHBOARD_PUBLIC_URL`,
  `DASHBOARD_ALLOWED_ORIGINS`, `MAIN_AGENT_ID`.
- `ChannelEnv` (D.1) — for the env-derived helpers.
- `AuthGate` (C.1) — for `resolveAuth` + `getRouteContextAuth`.
- `RouteStores` (A.1+) — the per-store accessor. See §C5 below.
- `LoggerLike` (H.1) — for the 50 `logger.<level>(` calls in `web.ts`.
- 19 `XxxRunner` instances (C.3) — each held as a private field;
  `start()` calls each runner's `start()`; `stop()` calls each
  runner's `stop()` (or clears the intervals directly).

### Lifecycle

- **One instance per process**, constructed in `index.ts` between
  lock acquisition (E) and channel-monitor runner registration (F).
- `start()` returns the `http.Server` synchronously (matching the
  current `startWebServer` return).
- `stop()` is async — awaits drain (per `review-completeness.md M11`
  the actual shutdown order in `index.ts:378-410` is heartbeat →
  inviteMonitor → channelRequestWatcher → storeWatcher →
  decayInterval → digestTimer → digestInterval → webServer →
  releaseLock; after refactor, `dashboardServer.stop()` replaces
  the manual `server.close` call).

### Free functions that REMAIN after C.2

| Symbol | Location | Why it stays |
|---|---|---|
| `startWebServer(port?)` | `web.ts:88` | Thin wrapper: `(port) => new DashboardServer({...}).start()`. Removed in C.10. |
| `channelsSessionName`, `channelsLaunchdLabel`, `channelsPlistPath`, `isMainChannelsAgent`, `MAIN_CHANNELS_SESSION`, `MAIN_CHANNELS_PLIST` | `web/main-agent.ts` | **Untouched.** The 49-LOC pure utility stays as today. |
| The 19 `start*()` free functions | various | Replaced by `XxxRunner` class methods; the free functions become thin wrappers in C.3, removed in C.10. |

### Route registration seam (C.2 design choice)

The brief asks for `registerRoute(path, handler)`. **Decision: keep the
hard-coded dispatch chain at `web.ts:173-215` for now.** Today's chain
is a linear `if`-cascade; introducing a registry adds an indirection
that the existing 144+ `vi.mock('../web.js')` test mocks do not need.
The method is added for FUTURE extension but defaults to no-op when
called with a path already in the chain.

---

## §C3. 19 web runner classes (one per `start*()`)

Per `review-correctness.md C3`, the 4 framework-literal paths are
wrong. The corrected paths and runner class names:

| # | Symbol | Source file:line | Class name | 1-line purpose |
|---|---|---|---|---|
| 1 | `startMessageRouter` | `src/web/message-router.ts:277` | `MessageRouterRunner` | Routes inbound messages to the agent process |
| 2 | `startScheduleRunner` | `src/web/schedule-runner.ts:1000` | `ScheduleRunner` | Ticks scheduled tasks |
| 3 | `startWorkerLivenessMonitor` | `src/web/worker-liveness.ts:197` | `WorkerLivenessMonitorRunner` | Probes worker liveness |
| 4 | `startChannelPluginMonitor` | `src/web/channel-monitor.ts:1390` | `ChannelPluginMonitorRunner` | Monitors channel plugin health |
| 5 | `startInboundProber` | `src/web/inbound-probe.ts:371` | `InboundProberRunner` | Probes inbound channel readiness |
| 6 | `startChannelHealthMonitor` | `src/web/channel-health-monitor.ts:149` | `ChannelHealthMonitorRunner` | Aggregates channel health signals |
| 7 | `startCostsSyncTask` | `src/web/routes/costs.ts:22` | `CostsSyncRunner` | Syncs costs ledger hourly |
| 8 | `startStuckInputWatcher` | `src/web/stuck-input-watcher.ts:227` | `StuckInputWatcherRunner` | Detects stuck input panes |
| 9 | `startStuckToolCallWatcher` | `src/web/stuck-tool-call-watcher.ts:241` | `StuckToolCallWatcherRunner` | Detects stuck tool calls |
| 10 | `startInboxNudgeWatcher` | `src/web/inbox-nudge-watcher.ts:276` | `InboxNudgeWatcherRunner` | Nudges stale inbox entries |
| 11 | `startReauthHealer` | `src/web/reauth-healer.ts:357` | `ReauthHealerRunner` | Heals expired credentials |
| 12 | `startAutoRestartRunner` | `src/web/auto-restart-runner.ts:149` | `AutoRestartRunner` | Triggers scheduled restarts |
| 13 | `startModelFallbackRunner` | `src/web/model-fallback-runner.ts:143` | `ModelFallbackRunner` | Decides model fallback |
| 14 | `startContextGuardRunner` | `src/web/context-guard-runner.ts:336` | `ContextGuardRunner` | Enforces context-window guard |
| 15 | `startUpdateChecker` | `src/web/update-checker.ts:253` | `UpdateCheckerRunner` | Checks for agent updates |
| 16 | `startFederationPoller` | `src/web/federation/poller.ts:276` | `FederationPollerRunner` | Polls federation peer manifests |
| 17 | `startCapabilitySummaryRunner` | `src/web/federation/capability-runner.ts:80` | `CapabilitySummaryRunner` | Refreshes peer capability summaries |
| 18 | `startApprovalTimeoutSweeper` | `src/web/routes/approvals.ts:54` | `ApprovalTimeoutSweeperRunner` | Sweeps expired approvals |
| 19 | `startInviteMonitor` | `src/web/channel-invites.ts:271` | `InviteMonitorRunner` | Monitors channel invites |

[ASSUMPTION: 19 confirmed via `grep -rn "^export function start"
src/web/ src/web/federation/ | grep -v __tests__ | wc -l` = 19; the
brief and `02-type-interface-analysis.md §1.5` agree.]

**Common shape (signatures only):**

```ts
class XxxRunner {
  constructor(deps: { config: Config; env: ChannelEnv; log: LoggerLike; /* per-runner opts */ })
  start(): NodeJS.Timeout | null | void         // returns the interval handle (or null if not started)
  stop(): Promise<void> | void                  // clears the interval
}
```

The 19 runner classes share a common `start()`/`stop()` shape but
diverge in: (a) the interval cadence (60s for approval-timeout, 1h
for token-collect, etc.); (b) the dependencies (some need
`MemoryStore`, some need `ChannelCoordinator`, etc.); (c) whether
they return a handle or void. **There is NO `BaseRunner<TFacts,
TDecision>` base class** — per `review-completeness.md OE-5`, the
abstract-base proposal was rejected because most runners do not have
a `facts → decision` shape.

**Lifecycle.** All 19 runners are constructed once at boot by
`DashboardServer` (C.2) and held as private fields. `start()` is
called in the order matching `web.ts:334-447` (preserved verbatim —
order matters for cross-runner dependencies). `stop()` is called by
`dashboardServer.stop()` in REVERSE order (LIFO drain).

**Free functions that REMAIN after C.3** — one thin wrapper per
runner (e.g. `startMessageRouter = () => new
MessageRouterRunner(deps).start()`), removed in C.10.

---

## §C4. 44 route handlers — phased refactor

Per `review-correctness.md CE-3` and `review-completeness.md CR3`
below, the 44 route handlers in `src/web/routes/` are phased by
risk:

### Phase 1 (C.4) — Low-risk, read-only public routes

| File | Path(s) | Auth level |
|---|---|---|
| `routes/status.ts` | `GET /api/status` | public |
| `routes/daily-log.ts` | `GET /api/daily-log` | public |
| `routes/docs.ts` | `GET /api/docs` | public |
| `routes/marveen.ts` | `GET /api/marveen/...` | public |
| `routes/static.ts` | static SPA | public |
| `routes/agents-skills.ts` | `GET /api/agents/:id/skills` | auth |
| `routes/skills.ts` | `GET /api/skills` | auth |
| `routes/profiles.ts` | `GET /api/profiles` | auth |
| `routes/overview.ts` | `GET /api/overview` | auth |
| `routes/recall.ts` | `GET /api/recall` | auth |
| `routes/audit-log.ts` | `GET /api/audit-log` | auth |
| `routes/token-usage.ts` | `GET /api/token-usage` | auth |

**Signature change:** `tryHandleXxx(ctx: RouteContext)` → unchanged
externally. `RouteContext` adds optional `log: LoggerLike` field (no
removal of existing fields). The 12 files read `logger` from a
module import today; after C.4 they read `ctx.log` instead.

### Phase 2 (C.5) — Mid-risk, authenticated read routes

| File | Path(s) | Auth level |
|---|---|---|
| `routes/agents.ts` | `GET /api/agents/...` | auth |
| `routes/agent-conversation.ts` | `GET /api/agents/:id/conversation` | auth |
| `routes/agent-terminal.ts` | `GET /api/agents/:id/terminal/...` | auth |
| `routes/memories.ts` | `GET /api/memories` | auth |
| `routes/kanban.ts` | `GET /api/kanban` | auth |
| `routes/messages.ts` | `GET /api/messages` | auth |
| `routes/ideas.ts` | `GET /api/ideas` | auth |
| `routes/schedules.ts` | `GET /api/schedules` | auth |
| `routes/background-tasks.ts` | `GET /api/background-tasks` | auth |
| `routes/costs.ts` | `GET /api/costs` | auth |
| `routes/spans.ts` | `GET /api/spans` | auth |
| `routes/tool-log.ts` | `GET /api/tool-log` | auth |
| `routes/skill-usage.ts` | `GET /api/skill-usage` | auth |
| `routes/research.ts` | `GET /api/research` | auth |
| `routes/connectors.ts` | `GET /api/connectors` | auth |
| `routes/connectors-hu.ts` | `GET /api/connectors-hu` | auth |
| `routes/vault-ssh.ts` | `GET /api/vault-ssh` | auth |
| `routes/vault-ssh-keys.ts` | `GET /api/vault-ssh-keys` | auth |
| `routes/fleet.ts` | `GET /api/fleet` | auth |
| `routes/fleet-q.ts` | `GET /.well-known/fleetq` | auth |
| `routes/voice.ts` | `GET /api/voice` | auth |

**Signature change:** `tryHandleXxx(ctx: RouteContext)` → unchanged
externally. `RouteContext` adds optional `stores: RouteStores` field.
The 21 files that read `db.js` functions today reach those via
`ctx.stores.memory.find(...)` etc. — but only AFTER A.1–A.5 land.
Phase 2 is staged: only the `ctx.log` migration in C.4 is mandatory;
the `ctx.stores` migration is gated on A.5.

### Phase 3 (C.6) — High-risk, write/auth/admin routes

| File | Path(s) | Auth level |
|---|---|---|
| `routes/auth.ts` | `POST /api/auth/login`, `GET /api/auth/status`, user/device-key admin | auth-admin |
| `routes/security.ts` | enrollment + audit + config changes | auth-admin |
| `routes/settings.ts` | `POST /api/settings` | auth-admin |
| `routes/agent-taskstate.ts` | `POST /api/agents/:id/taskstate` | auth |
| `routes/autonomy.ts` | `POST /api/autonomy` | auth |
| `routes/approvals.ts` | `POST /api/approvals/...` | auth |
| `routes/updates.ts` | `POST /api/updates` | auth |
| `routes/onboarding.ts` | `POST /api/onboarding` | auth |
| `routes/migrate.ts` | `POST /api/migrate` | auth |
| `routes/federation.ts` | inbound POST `/api/federation/inbox`, PATCH peers | federation |
| `routes/kanban.ts` | `POST/PUT/DELETE /api/kanban/...` (write paths only) | auth |

**Signature change:** same as C.5, plus `ctx.auth` becomes load-bearing
for write paths (the 4-arm literal union is consumed by `auth.ts:9`
and `security.ts:2` per `02-type-interface-analysis.md §3.2`). Per
OE-4: NO sealed class — `ctx.auth` remains the 4-arm literal-union
object.

**Per-store blast radius table (per `review-completeness.md CE-11`):**

For each route, which stores + auth level are required (after A +
C land):

| Route file | `memory` | `kanban` | `messages` | `scheduler` | `approvals` | `vault-ssh` | `auth` | `federation` |
|---|:---:|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| `routes/memories.ts` | YES | | | | | | | |
| `routes/kanban.ts` | | YES | | | | | | |
| `routes/messages.ts` | | | YES | | | | | |
| `routes/schedules.ts` | | | | YES | | | | |
| `routes/approvals.ts` | | | | | YES | | | |
| `routes/vault-ssh.ts` | | | | | | YES | | |
| `routes/vault-ssh-keys.ts` | | | | | | YES | | |
| `routes/auth.ts` | | | | | | | YES | |
| `routes/federation.ts` | | | | | | | | YES |
| (other 35 routes) | (none direct — read through `db.ts`) |

[ASSUMPTION: this is a per-route summary; the per-symbol mapping is
enumerated in `02-type-interface-analysis.md §3.1`. The above is the
high-level audit. The detailed per-symbol mapping will be produced as
part of C.5's rollout — each route file's PR includes a "stores used"
diff.]

---

## §C5. `RouteStores` interface (per-store accessor)

The brief asks for a per-store accessor. Per `review-completeness.md
OE-9`, the `App.getStore<K>` mapped-type proposal is DROPPED — stores
are exposed as `public readonly` fields on `App`. C follows the same
pattern: `RouteStores` is a plain interface with typed fields, NOT a
mapped type.

```ts
interface RouteStores {
  memory: MemoryStore        // A.5
  kanban: KanbanCards        // A.3
  messages: MessageBus       // A.3
  scheduler: Scheduler       // A.2
  approvals: ApprovalStore   // A.2
  vaultSsh: SshVault         // A.2 (merged VaultSshKey + VaultSshServer)
  spans: SpanStore           // A.2
  backgroundTasks: BackgroundTaskPool  // A.2
  ideas: IdeaStore           // A.2
}
```

This interface is built by `DashboardServer` (C.2) at boot by reading
the per-store fields from `App` (the framework's D3 keystone). Routes
that don't need a store simply ignore `ctx.stores`.

---

## §C6. web/federation/ sub-cluster (9 files)

Per `review-correctness.md CE-2`, the federation sub-cluster is
refactored as a unit. Per file:

| File | LOC | Class? | Why |
|---|---:|---|---|
| `federation/address.ts` | 51 | `FederationAddress` (new) | `QualifiedId` interface + `parseQualifiedId` function; tiny but class-extractable per the `ChannelEnv` precedent. |
| `federation/bridge.ts` | 179 | `FederationBridge` (new) | `sendFederatedMessage` + `BridgeSendResult` (4-arm union, NO sealed class per OE-1). |
| `federation/capabilities.ts` | 343 | `FederationCapabilities` (new) | `CapabilityCacheEntry` + `SummarySource` + the cache + summary builder. |
| `federation/capability-runner.ts` | 89 | `FederationCapabilityRunner` (new) | wraps `startCapabilitySummaryRunner` at `:80`. |
| `federation/config.ts` | 393 | `FederationConfig` class (new) | wraps `FederationRoutingMode` + `FederationPeer` + `FederationConfig` interfaces + the 4 env-derived helpers. |
| `federation/http.ts` | 40 | KEPT FREE (helpers) + class (existing `PeerResponseTooLargeError`) | The helpers `readBoundedBody` + `postJson` are pure; the error class survives unchanged per CE-1. |
| `federation/local-catalog.ts` | 60 | `FederationLocalCatalog` (new) | small pure module. |
| `federation/onboarding.ts` | 393 | `FederationOnboarding` (new) | `OnboardingIdentity` + the onboarding flow. |
| `federation/poller.ts` | 287 | `FederationPoller` (new) | wraps `startFederationPoller` at `:276`; `FederationPollInternalError` (existing) survives unchanged per CE-1. |

### Free functions that REMAIN after C.7

- `FederationRoutingMode` / `FederationPeer` / `FederationConfig`
  type exports (re-exported by the class as type aliases).
- `QualifiedId` interface (re-exported).
- `BridgeSendResult` union (re-exported; NO sealed class).
- `PeerPollState` union (re-exported).
- `PeerManifest` / `PeerStatus` interfaces (re-exported).
- `InboxAccept` interface (re-exported from `routes/federation.ts`).
- `CapabilityCacheEntry` / `CapabilityCache` / `SummarySource`
  (re-exported).
- `OnboardingIdentity` interface (re-exported).
- `PeerResponseTooLargeError` class (preserved).
- `FederationPollInternalError` class (preserved).
- `JSON_PARSE_ERROR` symbol const (re-exported).
- The free functions in `federation/http.ts` (`readBoundedBody`,
  `postJson`).
- The `inNative409Cooldown` and 9 free functions in
  `channel-coordinator/liveness.ts` (out of C scope; per G.3 they
  stay free).

---

## §C7. `AuthGate` + `DashboardServer` error-class design

Per `review-completeness.md CE-4`, C does NOT introduce new
error-class taxonomies beyond the 3 existing error classes
(`PeerResponseTooLargeError`, `FederationPollInternalError`,
`RequestBodyTooLargeError`). The 22 `catch (err: any)` clauses in
routes (per `02-type-interface-analysis.md §3.5`) become `catch (err:
unknown)` followed by `instanceof Error` checks, but no new error
class is added.

[ASSUMPTION: per `review-completeness.md CE-4` recommendation (a)
rather than (b): the H.4 `AppError` base taxonomy is the
project-wide convention; C contributes `RequestBodyTooLargeError` to
the first pair (per `h-cross-cutting/03-class-boundaries.md:289-296`)
and waits for the broader convention to settle before introducing
additional error classes.]

---

## Summary of free functions vs class surface after C.1–C.7

| Symbol | After C.1–C.7 | Notes |
|---|---|---|
| `AuthGate` class | **new** | C.1 deliverable |
| `DashboardServer` class | **new** | C.2 deliverable |
| `AuthGateDeps`, `DashboardServerDeps`, `RouteStores` interfaces | **new** | C.1, C.2, C.5 deliverables |
| 19 `XxxRunner` classes | **new** | C.3 deliverable |
| 9 federation cluster classes | **new** | C.7 deliverable |
| `startWebServer` | free wrapper | Removed in C.10 |
| 19 `start*()` functions | free wrappers | Removed in C.10 |
| `resolveAuth`, `requiresAuth`, `isFederationWireEndpoint`, `parseCookies` | free wrappers | Removed in C.10 |
| `AuthResult`, `RouteContext`, `RouteHandler`, `BridgeSendResult`, `FederationRoutingMode`, `FederationPeer`, `FederationConfig`, `QualifiedId`, `InboxAccept`, `OnboardingIdentity`, `CapabilityCacheEntry`, `CapabilityCache`, `SummarySource`, `PeerPollState`, `PeerManifest`, `PeerStatus`, `MarveenIdentityCore` types | free exports | unchanged |
| `PeerResponseTooLargeError`, `FederationPollInternalError`, `RequestBodyTooLargeError`, `RemoteStatusCache<T>`, `KeychainUnavailableError`, `TelegramApiError`, `DeferToPeerError`, `RemoteEnrollError`, `UserFacingError`, `PasswordPolicyError` | free exports / classes | unchanged (per CE-1, CE-4) |
| `SESSION_COOKIE_NAME` const | wrapper | Removed in C.10 |
| All 44 `tryHandle*` route handlers | **free functions** | unchanged across all phases (per CE-7) |
| `web/main-agent.ts` exports | **unchanged** | 49-LOC pure utility, untouched |
| `vi.mock('../web.js', …)` and per-route `vi.mock` sites | **rewritten** | C.8 phase |

---

**End of C class-boundaries plan. No source files modified.**
