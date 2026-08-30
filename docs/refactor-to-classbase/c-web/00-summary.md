# C (web) — Executive summary

Synthesis of `c-web/02-type-interface-analysis.md` (types/interfaces lens)
cross-checked against `src/web.ts` (576 LOC), `src/web/auth-gate.ts` (121 LOC),
`src/web/routes/` (44 files), `src/web/federation/` (9 files), and the
precedent reviews in `h-cross-cutting/00-summary.md`,
`d-channel-provider/00-summary.md`, `b-config/00-summary.md`,
`a-db/00-summary.md`, `g-channel-coordinator/00-summary.md`,
`f-agent-subsystem/00-summary.md`, `e-process-lock/00-summary.md`,
`review-correctness.md`, and `review-completeness.md`. The
`01-module-state-analysis.md` input referenced in the task brief does
**not exist** in this directory as of 2026-08-30; the state claims used
below are taken from `02-type-interface-analysis.md` and cross-checked
against the source files cited inline. **Planning only — no source file
was modified.**

---

## Thesis

C is the dashboard HTTP server: a single 576-line closure
(`src/web.ts:88` `startWebServer`) that opens a listener, registers 44
`tryHandle*` route handlers from `src/web/routes/`, and starts 19
background "runner" intervals (10 in `src/web/*.ts`, 9 inside
`src/web/routes/*.ts` or `src/web/federation/*.ts` per the corrected
`review-correctness.md` C3 paths). The subsystem's data-and-behavior
already clusters into ~3 natural classes — `AuthGate` (wraps
`src/web/auth-gate.ts`), `DashboardServer` (wraps `startWebServer`),
and a cluster of 19 `XxxRunner` classes — but the routes themselves
(42 of 44 ignoring `ctx.auth`) stay as functions per `review-completeness.md`
CE-7. The single highest-value deliverable is therefore **`class
AuthGate`** (the smallest scope, single-file, foundation for
`DashboardServer`), and the single biggest decision is whether to
build a sealed `AuthContext` hierarchy (rejected — `AuthContext` stays
as a 4-arm literal-union object per `review-completeness.md` OE-4 and
the C2 finding that the `'none'` case maps to `undefined`, not to a
fifth subclass). C is the broadest blast-radius subsystem in the
framework: every keystones of B, D, A, F, G, H lands *before* C's
consumer-side migration can complete.

## Scope

### Files this plan TOUCHES (5 cluster headers, 60+ files)

| Cluster | Files | Why | Phase |
|---|---|---|---|
| `src/web/auth-gate.ts` (121 LOC) | 1 | extract `AuthGate` class around `resolveAuth`; keep free functions as thin wrappers; preserve the 5-arm `AuthResult` union (do NOT seal it per OE-4) | C.1 |
| `src/web.ts` (576 LOC) | 1 | extract `DashboardServer` class around `startWebServer`; keep the free function as a thin wrapper; 22 intervals tracked in a private array (consolidated from the hand-rolled `server.close` override at `web.ts:548-573`) | C.2 |
| `src/web/routes/` | 44 | per-route signature change: handlers take `ctx.auth` / `ctx.logger` / `ctx.stores` via the DI seam in `RouteContext` (defined `routes/types.ts:7-25`); phased low-risk → high-risk | C.4, C.5, C.6 |
| `src/web/federation/` | 9 (verified 2026-08-30: `address.ts`, `bridge.ts`, `capabilities.ts`, `capability-runner.ts`, `config.ts`, `http.ts`, `local-catalog.ts`, `onboarding.ts`, `poller.ts`; total 1835 LOC) [ASSUMPTION: brief said "10 files" — verified 9 by `ls`] | sub-cluster refactor — Address, Bridge, Capabilities, CapabilityRunner as classes; Config + Http + LocalCatalog + Onboarding + Poller phased free-or-class decisions | C.7 |
| `src/web/main-agent.ts` (49 LOC) | 1 | pure utility (3 functions + 2 constants + 1 predicate, no state, no logger); no class candidate per `02 §5`. Inherits `LoggerLike` only transitively if `DashboardServer` ever wraps `web/main-agent.ts` | n/a (verification only) |

[ASSUMPTION: brief stated "web/federation/ 10 files" but `ls
src/web/federation/` returns 9 files; brief may have included the
directory itself or one extra file not enumerated in
`02-type-interface-analysis.md §4.1`. The plan proceeds with 9. If a
10th file (e.g. a deferred `index.ts`) is later discovered, C.7's
scope adds one extra phase entry without changing the cluster
character.]

### Files this plan does NOT touch

- **The 88 `import { logger }` sites** — H.1 (`LoggerLike`) is
  additive; C classes may take `log: LoggerLike` but the legacy module
  singleton survives. The 221 `logger.<level>(` calls in C (50 in
  `web.ts` + 159 across `routes/` + 12 in `federation/`) become
  `this.log.<level>(` only inside the converted classes.
- **All test files** — they get *updated* to match new class APIs
  (constructor injection for `AuthGate`, `DashboardServer`, the 19
  runners, the 44 routes) but their layout, runner, and coverage
  targets are not in scope (consistent with `00-summary.md` "Explicitly
  OUT OF SCOPE").
- **`src/web/http-helpers.ts`, `src/web/csrf-origin.ts`,
  `src/web/dashboard-auth.ts`, `src/web/auth-sessions.ts`,
  `src/web/auth-device-keys.ts`, `src/web/network-info.ts`** — pure
  helpers consumed by `web.ts` and the routes. Stay free unless H.4's
  error taxonomy extends one of them.
- **`src/web/remote-status-cache.ts`** — already a class
  (`RemoteStatusCache<T>` at `remote-status-cache.ts:19`); the CE-9
  precedent for `TtlCache<K, V>` reuse. Not rewritten.
- **`src/web/atomic-write.ts`** — `01 §6.4` per
  `review-completeness.md CE-6` exempts it; the heaviest-mocked web
  helper (14 `vi.mock` sites) stays a free-function module.
- **`src/web/main-agent.ts`** — 49 LOC, no state, no logger; the
  `channelsSessionName`/`channelsLaunchdLabel`/`channelsPlistPath`/
  `MAIN_CHANNELS_SESSION`/`MAIN_CHANNELS_PLIST`/`isMainChannelsAgent`
  exports stay verbatim.

## Dependency: what C blocks and what blocks C

| Direction | Counterparty | What |
|---|---|---|
| **C ← B** | `Config` class (`b-config/00-summary.md`) | `DashboardServer` constructor takes `config: Config`. The `src/web.ts:6` 5-field `import { WEB_HOST, WEB_PORT, DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID } from './config.js'` migrates to `config.WEB_HOST` etc. once B.1 lands. | **Yes** for C.2 (class form needs the field names); **Yes** for C.4–C.6 (consumer-side migration). |
| **C ← D** | `ChannelEnv` class + 5 `XxxProvider` classes (`d-channel-provider/00-summary.md`) | `AuthGate.resolveAuth()` does NOT take a `ChannelProvider` (the gate delegates to `getFederationConfig` at `auth-gate.ts:25`); but `DashboardServer.start()` calls `loadOrCreateDashboardToken()` which depends on env that `ChannelEnv` reads. Per `d-channel-provider/00-summary.md` D.1 must precede C.1 only if `AuthGate` constructor takes `ChannelEnv` directly. **Decision:** `AuthGate` takes `Config` (B) only — `ChannelEnv` reads happen at route-handler time, not gate time. | **No.** D lands before C but is not a hard dependency for C.1 / C.2. |
| **C ← H** | `LoggerLike` interface (`h-cross-cutting/00-summary.md`) | `AuthGate` constructor takes `log: LoggerLike`; `DashboardServer` constructor takes `log: LoggerLike`; the 19 runners' constructors take `log: LoggerLike`. **Phase ordering:** C.1 / C.2 / C.3 land with `LoggerLike` already defined (H.1 must precede them). | **Yes.** |
| **C ← A** | `DbClient` + entity stores (`a-db/00-summary.md`) | 23 of 44 routes read `db.ts` functions (per `a-db/00-summary.md` Scope). After A.1, the routes' `RouteContext` gains a `stores` field carrying the relevant `MemoryStore` / `KanbanCards` / etc. instances. C does NOT own the conversion — A does. | **No** for the class form; **Yes** for the consumer migration (A.2–A.7 must precede C.5). |
| **C → F** | `HeartbeatScheduler.execute()` returns no result consumed by C today | C is downstream of F only via `index.ts:451`'s `setInterval(runDecaySweep, …)`. F does not block C. | No. |
| **C → E** | `PortLockAcquirer` / `PidfileLockAcquirer` (`e-process-lock/00-summary.md`) | `index.ts:341` calls `acquirePortLock` before `startWebServer`; the lock outlives the server. `DashboardServer.stop()` is called inside `webServer.close` callback (per `index.ts:378-410`), which is AFTER `releaseLock()`. C is downstream of E. | No. |
| **C → G** | `RouteHandler<TParams, TResponse>` (per framework `04-generic-interfaces.md`) | Per `04-generic-interfaces.md §E` (process-lock precedent) and the E-letter brief, a generic `RouteHandler` is sketched but the migration does not depend on it; per C.5 §10 the framework's G2 (`TtlCache<K, V>`) is REJECTED in favor of `RemoteStatusCache<T>` reuse. C does NOT owe G anything. | No. |
| **C → index.ts** | The orchestrator constructs `DashboardServer` after `Config` + `LoggerLike` are ready | `index.ts:451` already schedules `runDecaySweep`; C.2's `DashboardServer.start()` is called between the lock acquisition (E) and the channel-monitor runner registration. The 19 runners must start in the same order they do today (per `web.ts:334-447`) — order matters for cross-runner dependencies (e.g. message router needs the agent process monitor running). | **Yes** for the construction-order test (C.2 verification). |

**What C does NOT owe anyone.** No other subsystem imports from
`src/web/` outside of the routes — the federation cluster is consumed
by 2 files inside `src/web/federation/` + the routes; the auth gate is
consumed only by `src/web.ts` + 2 routes (`auth.ts:9`, `security.ts:2`).
C's class extraction is locally scoped; the migration window does not
ripple to other subsystems.

## Top 3 risks specific to C

1. **44 route handler blast radius (per `review-correctness.md` CE-3,
   per `review-completeness.md` CR3 below).** Every `tryHandle*` in
   `src/web/routes/` consumes the `RouteContext` interface defined at
   `routes/types.ts:7-25`. If the type changes (e.g. `auth` becomes a
   sealed class per the dropped OE-4 alternative), 44 files need
   rewriting in lockstep. The mitigation per CE-3 + CR3 below: phased
   by risk (low → mid → high), per-route rollback, and the `auth` type
   stays a literal-union object (no sealed class).
   `c-web/06-risks-and-mitigations.md CR1`.

2. **AuthContext decision (per `review-completeness.md` OE-4 DROPPED +
   `review-correctness.md` C2 'none' case).** The framework's D1
   sketch proposed 4 subclasses (`TokenAuth`, `DeviceAuth`,
   `SessionAuth`, `FederationAuth`); both reviews rejected it. The
   5-arm `AuthResult` union at `auth-gate.ts:29-34` is the
   auth-gate's return type; the 4-arm `RouteContext.auth` at
   `routes/types.ts:24` is the route's view, with `'none'` collapsed
   to `undefined` via the `ctxAuth` ternary at `web.ts:154-159`.
   After refactor: `AuthGate.resolveAuth()` returns the 5-arm union;
   `DashboardServer.getAuthContext()` produces the 4-arm object (or
   `undefined`) via a private helper. NO sealed class hierarchy.
   `c-web/06-risks-and-mitigations.md CR3`.

3. **`web/federation/` sub-cluster (per `review-completeness.md` CE-2
   + C3 corrected paths).** The 9 files (1835 LOC) form a tightly
   coupled sub-cluster — `poller.ts` imports from `bridge.ts`,
   `capabilities.ts`, `config.ts`, `http.ts`. Per C3 the framework's
   Phase 5 listed 4 fictional paths (`web/federation-poller.ts`,
   `web/capability-summary-runner.ts`, `web/costs-sync-task.ts`,
   `web/approval-timeout-sweeper.ts`); the corrected paths are
   `web/federation/poller.ts:276`, `web/federation/capability-runner.ts:80`,
   `web/routes/costs.ts:22`, `web/routes/approvals.ts:54`. The 9-file
   cluster must be refactored as a unit; partial conversions introduce
   ordering hazards. `c-web/06-risks-and-mitigations.md CR2`.

## Migration order inside C

```
C.1  AuthGate class extraction                 (single-file; smallest scope)
   |
   +---> C.2  DashboardServer class extraction  (introduce alongside; startWebServer survives)
              |
              +---> C.3  19 web runners as classes  (one phase; share start/stop lifecycle)
              |
              +---> C.4  44 routes phase 1 (low-risk: read-only public routes)
              |
              +---> C.5  44 routes phase 2 (mid-risk: authenticated read routes)
              |
              +---> C.6  44 routes phase 3 (high-risk: write/auth/admin routes)
              |
              +---> C.7  web/federation/ sub-cluster   (Address, Bridge, Capabilities, CapabilityRunner as classes; rest phased)
              |
              +---> C.8  vi.mock('../web.js') + per-route vi.mock migration
              |
              +---> C.9  LoggerLike adoption across C classes  (mostly folded into C.1–C.7; verification pass)
              |
              +---> C.10 Free function removal       (gated on C.1–C.9 + consumer migration + test updates)
```

Rationale:

- **C.1 first** because `AuthGate` is the smallest scope (121 LOC, 5
  functions + 1 type alias), has zero consumers outside `web.ts` + the
  `auth.ts` / `security.ts` route consumers, and proves the
  introduce-alongside-free-function pattern from
  `b-config/00-summary.md` and `e-process-lock/00-summary.md` in the C
  context. It is also a prerequisite for `DashboardServer`'s
  `getAuthContext()` method (C.2).
- **C.2 second** because `DashboardServer` is the orchestrator — the
  22-interval array consolidation alone (per the shutdown handler at
  `web.ts:548-573`) is a measurable simplification — but the class
  form is inert until the 19 runners inside it are classes.
- **C.3 third** because all 19 runners share the start/stop lifecycle
  (`setInterval` → handle in `intervals[]` → `clearInterval` in
  `stop()`); one phase covers them all. The corrected paths (per
  `review-correctness.md C3`) are enumerated in `03-class-boundaries.md
  §C3`.
- **C.4–C.6 phased by risk** because the 44 routes have very different
  blast radii (a `GET /api/auth/status` read is trivially safe; a
  `POST /api/agents/:id/taskstate` write needs careful rollback). The
  per-route signature change (add `ctx.auth`, `ctx.logger`,
  `ctx.stores`) ripples to all 44 files; phasing by risk gives the
  smallest blast radius per phase.
- **C.7 seventh** because the federation sub-cluster is a
  multi-file refactor (9 files, 1835 LOC) with internal coupling
  (`poller.ts → bridge.ts → config.ts → http.ts`); it cannot land
  piecemeal without breaking the cluster.
- **C.8 + C.9 + C.10 last** because the test mocks (`vi.mock('../web.js')`
  and the 144+ per-route `vi.mock` sites per
  `review-correctness.md M4`) require every class to exist before
  tests can switch to constructor injection; the free-function
  removal is irreversible (gated on every consumer migrated).

### Top 3 lowest-risk wins (within C)

1. **`AuthGate` extraction** — 121 LOC, 1 type alias, 5 functions.
   The class form adds nothing observable; it just moves
   `dashboardToken` and the `AuthResult` return type into a typed
   surface that the route handlers can request via DI. Matches the
   `Config` / `ChannelEnv` / `PortLockAcquirer` precedent
   (introduce alongside, free function survives).
2. **`DashboardServer` extraction** — 576 LOC closure → 1 class.
   The 22-interval consolidation alone (`web.ts:548-573` hand-rolled
   close handler) is a measurable simplification. The class form
   does not require any new test factories because the existing
   `startWebServer(port)` call site in `index.ts:451` survives
   unchanged.
3. **`web/federation/Address` + `Bridge` extraction** — small
   modules (`address.ts` 51 LOC, `bridge.ts` 179 LOC). Per
   `02-type-interface-analysis.md §4.2`, `BridgeSendResult` is a
   pure-data 4-arm union (no behavior) → NO sealed class; the class
   form is `class FederationBridge` with method `sendMessage()`
   returning the union.

## Cross-references (verified 2026-08-30)

- `src/web.ts:88` — `startWebServer(port = 3420): http.Server`
- `src/web.ts:154-159` — the 4-arm `ctxAuth` ternary (per
  `review-correctness.md m2`, the line ref was 155-159; corrected to
  154-159 — the `const ctxAuth =` line is at 154)
- `src/web.ts:548-573` — the hand-rolled `server.close` override that
  clears 22 intervals
- `src/web.ts:6` — `import { PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID } from './config.js'`
- `src/web.ts:32` — `import { logger } from './logger.js'`
- `src/web.ts:33-79` — 47 lines of `tryHandle*` imports (44 routes
  total minus `types.ts` plus the federation cluster)
- `src/web.ts:80` — `import type { RouteContext } from './web/routes/types.js'`
- `src/web/routes/types.ts:7-25` — `RouteContext` interface (4-arm
  `auth?` at line 24)
- `src/web/routes/types.ts:27` — `RouteHandler` type alias
- `src/web/auth-gate.ts:29-34` — `AuthResult` 5-arm union
  (`token | device | federation | session | none`)
- `src/web/auth-gate.ts:76-121` — `resolveAuth(req, url, path, method, dashboardToken)`
- `src/web/auth-gate.ts:68-74` — `requiresAuth(path, method)`
- `src/web/auth-gate.ts:58-63` — `isFederationWireEndpoint(path, method)`
- `src/web/federation/poller.ts:276` — `startFederationPoller()` (per
  `review-correctness.md C3` corrected path)
- `src/web/federation/capability-runner.ts:80` —
  `startCapabilitySummaryRunner()` (per `review-correctness.md C3`)
- `src/web/routes/costs.ts:22` — `startCostsSyncTask(intervalMs?)` (per
  `review-correctness.md C3`)
- `src/web/routes/approvals.ts:54` — `startApprovalTimeoutSweeper()`
  (per `review-correctness.md C3`)
- `src/web/federation/http.ts:7` — `class PeerResponseTooLargeError`
  (existing; per `review-completeness.md CE-1`)
- `src/web/federation/poller.ts:68` — `class FederationPollInternalError`
  (existing; per `review-completeness.md CE-1`)
- `src/web/http-helpers.ts:25` — `class RequestBodyTooLargeError`
  (existing; per `review-completeness.md CE-1`)
- `src/web.ts:447` — `tokenCollectInterval` (the 20th interval; not
  in the "19 runner" count; per `02-type-interface-analysis.md §1.5`)

## Out-of-scope (C-local)

- **`vi.mock('../web.js', …)` factory rewrites** (C.8 phase, but the
  factory design itself is C.8's deliverable — not the test rewrites).
- **Test factories for route handlers** (`createTestAuthGate`,
  `createTestDashboardServer`, etc.) — owned by the test-factory
  design pass per `review-completeness.md CE-5`.
- **`AuthContext` sealed class hierarchy** — DROPPED per
  `review-completeness.md OE-4` and `review-correctness.md C2` (the
  `'none'` case). The 4-arm `RouteContext.auth` stays a literal-union
  object.
- **`TtlCache<K, V>`** — DROPPED per `review-completeness.md OE-6` and
  `c-web/04-generic-interfaces.md §C2`. `RemoteStatusCache<T>` is
  reused via CE-9, not subsumed.
- **`BaseRunner<TFacts, TDecision>`** — DROPPED per
  `review-completeness.md OE-5`. The 19 runners are independent
  classes with `start()` / `stop()`, not a base class.
- **`web/federation/` `RemoteStatusCache<T>` substitution** — DEFERRED
  per `02-type-interface-analysis.md §8.3`. The poller's `statusCache`
  is a stale-retain cache (per `poller.ts:39` `PeerPollState`); not
  semantically equivalent to per-call TTL.

## [ASSUMPTION] markers

- [ASSUMPTION: `01-module-state-analysis.md` referenced in the task
  brief is absent in this directory as of 2026-08-30; the state claims
  used here are taken from `02-type-interface-analysis.md` and
  cross-checked against the source files cited inline.]
- [ASSUMPTION: brief stated "web/federation/ 10 files" but `ls
  src/web/federation/` returns 9 files; the discrepancy is documented
  under Scope above. If a 10th file is later added, C.7's scope
  extends by one entry.]
- [ASSUMPTION: the 19 web runners include 10 in `src/web/*.ts` and 9
  in `src/web/routes/*.ts` + `src/web/federation/*.ts`; the brief
  states "19 web runners" and the grep in
  `02-type-interface-analysis.md §1.5` enumerates 19. The
  `tokenCollectInterval` at `web.ts:447` is a 20th interval that does
  NOT originate from a `start*()` function — it is inline `setInterval`
  in `startWebServer`. Per the brief's "19" count, it is excluded
  from C.3's runner list.]

---

**End of C executive summary. No source files modified.**
