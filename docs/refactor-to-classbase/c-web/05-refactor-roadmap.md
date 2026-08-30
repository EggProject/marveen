# C (web) — Refactor roadmap

Ordered phases for the C subsystem. Each phase: goal, files touched,
risk level, test coverage requirement, rollback strategy,
parallelizable. Cross-references:
`c-web/00-summary.md`, `c-web/03-class-boundaries.md`,
`c-web/04-generic-interfaces.md`, `c-web/06-risks-and-mitigations.md`,
plus the framework `05-refactor-roadmap.md` for cross-cutting
ordering.

**Reading note.** The 10 phases below cover the C subsystem ONLY. The
framework's `05-refactor-roadmap.md` covers the cross-cutting order
(H first, then A/B/D/E/F/G, then the keystones including C.10). C's
internal order is mostly sequential (C.1 → C.10) with one
parallelizable window (C.4–C.6 can run in 3 sub-prongs once C.3
lands).

---

## Phase C.1 — AuthGate class extraction

| Field | Value |
|---|---|
| **Goal** | Introduce `class AuthGate` alongside the free functions in `src/web/auth-gate.ts`. Preserve the 5-arm `AuthResult` union (NO sealed class per `review-completeness.md OE-4`). Add the `getRouteContextAuth()` projection helper. |
| **Files touched** | `src/web/auth-gate.ts` (only). |
| **Risk level** | **Low.** Single file, 121 LOC, 5 functions + 1 type alias. Zero production callers outside `src/web.ts:154-159`. |
| **Test coverage requirement** | Existing `auth-gate.test.ts` passes unchanged. Add 1-2 unit tests for `AuthGate.getRouteContextAuth()` (the projection helper) that cover all 5 input arms → 4-arm output + `undefined`. |
| **Rollback strategy** | Revert the single commit. Free functions survive; `AuthGate` class is additive. |
| **Parallelizable** | **Yes.** No dependency on D.1 (per `c-web/00-summary.md` Dependency table) — `AuthGate` reads `Config` (B) not `ChannelEnv` (D) directly. **But** `AuthGate` constructor takes `LoggerLike`, so H.1 must precede C.1. |
| **Pre-conditions** | H.1 (`LoggerLike`) lands; B.1 (`Config` class) lands (or `AuthGate` constructor takes `Config` lazily via a getter — but B.1 first is cleaner). |
| **Post-conditions** | `class AuthGate` is exported from `auth-gate.ts`. Free functions `resolveAuth` / `requiresAuth` / `isFederationWireEndpoint` / `parseCookies` survive as thin wrappers. `AuthResult` and `SESSION_COOKIE_NAME` survive as free exports. |

### Detailed steps

1. Add `LoggerLike` import.
2. Add `import type { RouteContext } from './routes/types.js'`.
3. Define `interface AuthGateDeps { config: Config; env: ChannelEnv; log: LoggerLike; dashboardToken: string }`.
4. Define `class AuthGate` with constructor `(deps)` and the 4 public methods (see `c-web/03-class-boundaries.md §C1`).
5. Make `isSsePaneStream` a private method.
6. Add the free-function wrappers as `export const X = (a, b) => new AuthGate(...).X(a, b)` ... actually no, the wrappers take the deps bundle, so they are not simple inline forwarders. Instead, the wrappers are `export function resolveAuth(req, url, path, method, dashboardToken) { return defaultGate.resolveAuth(req, url, path, method) }` where `defaultGate` is constructed at module init.
7. Add unit tests for `AuthGate.getRouteContextAuth`.

### Verification gates

- `bun tsc --noEmit` clean (with H.1 + B.1 lands).
- `bun --bun vitest run src/__tests__/auth-gate.test.ts` passes.
- `grep -n "from '\\./web/auth-gate.js'" src/` returns the existing importers (no breakage).

---

## Phase C.2 — DashboardServer class extraction

| Field | Value |
|---|---|
| **Goal** | Introduce `class DashboardServer` alongside `startWebServer` in `src/web.ts`. Consolidate the 22 intervals into a `private intervals: NodeJS.Timeout[]` field. Keep `startWebServer` as a thin wrapper. |
| **Files touched** | `src/web.ts` (only). |
| **Risk level** | **Medium.** Single file but 576 LOC; the hand-rolled `server.close` override at `:548-573` is the load-bearing piece (22 `clearInterval` calls). |
| **Test coverage requirement** | `bun --bun vitest run src/__tests__/web.test.ts` passes (if it exists). Verify the shutdown sequence clears ALL 22 intervals in the right order (LIFO). |
| **Rollback strategy** | Revert the single commit. `startWebServer` is the same wrapper; `DashboardServer` is additive. |
| **Parallelizable** | **No.** C.2 depends on C.1 (`AuthGate` is a constructor arg). |
| **Pre-conditions** | H.1 + B.1 + C.1 land. |
| **Post-conditions** | `class DashboardServer` is exported from `web.ts`. `startWebServer` survives as `() => new DashboardServer({...}).start()`. The `intervals[]` field replaces the hand-rolled close handler. |

### Detailed steps

1. Add the 19 runner-class imports (currently `start*()` function imports; after C.3 they'll be class imports).
2. Add `interface DashboardServerDeps` with the 7 fields (per `c-web/03-class-boundaries.md §C2`).
3. Define `class DashboardServer` with `start()`, `stop()`, `registerRoute()`, `getAuthContext()`, `runServer()`.
4. Inside `start()`, build the 22 intervals: each runner's `start()` returns a handle (or null); non-null handles go into `this.intervals[]`.
5. Inside `stop()`, iterate `this.intervals` in REVERSE and `clearInterval()` each. Then call `server.close(cb)`.
6. Replace the existing `server.close` override at `web.ts:548-573` with the `stop()` method.
7. Wrap `startWebServer` as the legacy free function.

### Verification gates

- `bun --bun vitest run src/__tests__/` passes (full test suite, since `web.ts` is the orchestrator's web boot).
- `grep -n "clearInterval" src/web.ts` returns only the ones inside `stop()`.
- `grep -n "this.intervals" src/web.ts` shows 22 + 1 + 1 = 24 references (push / iterate / clear).

---

## Phase C.3 — 19 web runners as classes

| Field | Value |
|---|---|
| **Goal** | Convert each of the 19 `start*()` functions to a class with `start()` / `stop()`. See `c-web/03-class-boundaries.md §C3` for the full enumeration with corrected paths. |
| **Files touched** | 19 files: `src/web/message-router.ts`, `src/web/schedule-runner.ts`, `src/web/worker-liveness.ts`, `src/web/channel-monitor.ts`, `src/web/inbound-probe.ts`, `src/web/channel-health-monitor.ts`, `src/web/routes/costs.ts`, `src/web/stuck-input-watcher.ts`, `src/web/stuck-tool-call-watcher.ts`, `src/web/inbox-nudge-watcher.ts`, `src/web/reauth-healer.ts`, `src/web/auto-restart-runner.ts`, `src/web/model-fallback-runner.ts`, `src/web/context-guard-runner.ts`, `src/web/update-checker.ts`, `src/web/federation/poller.ts`, `src/web/federation/capability-runner.ts`, `src/web/routes/approvals.ts`, `src/web/channel-invites.ts`. |
| **Risk level** | **Medium-High.** 19 files, but each is mechanical (constructor + start + stop). The risk is cross-runner dependencies (some runners may write to the same DB row or read from the same file). |
| **Test coverage requirement** | Each runner's existing test file (if any) passes. Order preservation in `DashboardServer.start()` is verified by integration test. |
| **Rollback strategy** | Per-runner revert. Each runner's class form is additive (the `start*()` function survives as a thin wrapper). |
| **Parallelizable** | **Yes** within the phase. 19 sub-prongs, each isolated. **But** the order MUST be preserved in `DashboardServer.start()` — runners that depend on other runners (e.g. `MessageRouterRunner` depends on the agent process monitor) start AFTER the dependency. |
| **Pre-conditions** | H.1 + B.1 + C.1 + C.2 land. |
| **Post-conditions** | 19 `XxxRunner` classes are exported. `start*()` functions survive as thin wrappers. `DashboardServer.start()` constructs each runner in order and calls `start()`. |

### Detailed steps (per runner)

1. Add `class XxxRunner` with constructor `(deps)` taking `Config` / `ChannelEnv` / `LoggerLike` / per-runner opts.
2. Add `start()` method that contains the original `startXxx()` body, returning the interval handle.
3. Add `stop()` method that clears the interval.
4. Wrap the original `start*()` as `() => new XxxRunner(defaultDeps).start()`.
5. Update `DashboardServer.start()` to instantiate the class and call `start()`.
6. Update `DashboardServer.stop()` to call `stop()` on each runner in REVERSE order.

### Verification gates

- `bun --bun vitest run` passes.
- `grep -nE "^export function start" src/web/*.ts src/web/routes/*.ts src/web/federation/*.ts | grep -v __tests__` returns 19 (the wrappers).
- `grep -nE "^export class" src/web/*.ts src/web/routes/*.ts src/web/federation/*.ts | grep -v __tests__` returns 19 + 9 federation cluster classes = 28 (after C.7 lands).

---

## Phase C.4 — 44 routes phase 1: low-risk read-only public routes

| Field | Value |
|---|---|
| **Goal** | Migrate the 12 read-only public routes to read `ctx.log` instead of the module-level `logger`. No signature change, no `auth` migration, no `stores` migration. |
| **Files touched** | 12 files: `routes/status.ts`, `routes/daily-log.ts`, `routes/docs.ts`, `routes/marveen.ts`, `routes/static.ts`, `routes/agents-skills.ts`, `routes/skills.ts`, `routes/profiles.ts`, `routes/overview.ts`, `routes/recall.ts`, `routes/audit-log.ts`, `routes/token-usage.ts`. |
| **Risk level** | **Low.** Each file is read-only; the change is mechanical (`logger.info` → `ctx.log.info`). |
| **Test coverage requirement** | Each route's existing test passes. New integration test verifies `ctx.log` is wired correctly. |
| **Rollback strategy** | Per-file revert. Each file's change is additive (a single `import { logger }` is removed). |
| **Parallelizable** | **Yes.** 12 sub-prongs, each isolated. |
| **Pre-conditions** | H.1 + C.1 + C.2 land. |
| **Post-conditions** | 12 routes read `ctx.log` instead of the module-level `logger`. `RouteContext` interface gains an optional `log: LoggerLike` field. |

### Detailed steps

1. Add `log: LoggerLike` field to `RouteContext` (in `routes/types.ts:7-25`).
2. Update `DashboardServer.getAuthContext()` (or a new method) to populate `log` in the `RouteContext` it builds.
3. For each of the 12 routes, replace `import { logger } from '../../logger.js'` with `logger.info` → `ctx.log.info`.
4. Run `bun tsc --noEmit` and `bun --bun vitest run src/__tests__/`.

### Verification gates

- `bun --bun vitest run src/__tests__/web-routes-status.test.ts` (and 11 others) passes.
- `grep -nE "import.*logger.*logger\\.js" src/web/routes/status.ts` returns 0 (the migration is complete).

---

## Phase C.5 — 44 routes phase 2: mid-risk authenticated read routes

| Field | Value |
|---|---|
| **Goal** | Migrate the 21 authenticated read routes to read `ctx.stores` instead of `db.js` functions. ONLY applies AFTER A.1–A.5 land. Until then, the migration is `ctx.log` only (already done in C.4). |
| **Files touched** | 21 files (per `c-web/03-class-boundaries.md §C4 Phase 2`): `routes/agents.ts`, `routes/agent-conversation.ts`, `routes/agent-terminal.ts`, `routes/memories.ts`, `routes/kanban.ts`, `routes/messages.ts`, `routes/ideas.ts`, `routes/schedules.ts`, `routes/background-tasks.ts`, `routes/costs.ts`, `routes/spans.ts`, `routes/tool-log.ts`, `routes/skill-usage.ts`, `routes/research.ts`, `routes/connectors.ts`, `routes/connectors-hu.ts`, `routes/vault-ssh.ts`, `routes/vault-ssh-keys.ts`, `routes/fleet.ts`, `routes/fleet-q.ts`, `routes/voice.ts`. |
| **Risk level** | **Medium.** The `ctx.stores` migration is gated on A.1–A.5; if A is delayed, C.5 can land with `ctx.log` only. |
| **Test coverage requirement** | Each route's existing test passes. New integration test verifies `ctx.stores` is wired correctly (per-store access pattern). |
| **Rollback strategy** | Per-file revert. The `ctx.stores` access pattern is additive (the `db.js` imports survive). |
| **Parallelizable** | **Yes** within the phase. 21 sub-prongs, each isolated. **But** the `RouteStores` interface must be defined first (single interface change in `routes/types.ts`). |
| **Pre-conditions** | H.1 + C.1–C.4 land. **A.1–A.5** must land before the `ctx.stores` portion of C.5. |
| **Post-conditions** | 21 routes read `ctx.stores.<store>.<method>` instead of `db.ts` functions. `RouteContext` interface gains an optional `stores: RouteStores` field. |

### Detailed steps

1. Define `interface RouteStores` (per `c-web/03-class-boundaries.md §C5`).
2. Update `DashboardServer.start()` to populate `stores` in `RouteContext`.
3. For each of the 21 routes:
   a. Replace `import { db } from '../../db.js'` with `ctx.stores.<store>` access.
   b. If the route uses multiple stores, replace each per the per-route blast-radius table.
4. Run integration tests + per-store unit tests.

### Verification gates

- `bun --bun vitest run` passes (full suite).
- `grep -rnE "from '\\.\\./\\.\\./db\\.js'" src/web/routes/*.ts` returns 0 after C.5 lands (or only the routes in C.6).

---

## Phase C.6 — 44 routes phase 3: high-risk write/auth/admin routes

| Field | Value |
|---|---|
| **Goal** | Migrate the 11 write/auth/admin routes. These consume `ctx.auth` (per `02-type-interface-analysis.md §3.2`: `auth.ts:9` has 9 references, `security.ts:2`). Per OE-4: NO sealed class — `ctx.auth` stays a 4-arm literal-union object. |
| **Files touched** | 11 files (per `c-web/03-class-boundaries.md §C4 Phase 3`): `routes/auth.ts`, `routes/security.ts`, `routes/settings.ts`, `routes/agent-taskstate.ts`, `routes/autonomy.ts`, `routes/approvals.ts`, `routes/updates.ts`, `routes/onboarding.ts`, `routes/migrate.ts`, `routes/federation.ts`, `routes/kanban.ts` (write paths only). |
| **Risk level** | **High.** These routes have side effects (POST / PATCH / DELETE). The `auth` migration touches `auth.ts:9` and `security.ts:2` (the only 2 consumers per §3.2). The `federation.ts` write path touches the federation cluster (per C.7). |
| **Test coverage requirement** | Each route's existing test passes. New integration tests verify `ctx.auth` narrowing for each of the 4 arms. |
| **Rollback strategy** | Per-file revert. The `ctx.auth` access pattern is additive (the `requiresAuth` call survives). |
| **Parallelizable** | **Yes** within the phase. 11 sub-prongs, but `auth.ts` and `security.ts` must land FIRST (they're the load-bearing `ctx.auth` consumers). |
| **Pre-conditions** | H.1 + C.1–C.5 + A.1–A.7 land. C.7 (federation cluster) must precede `routes/federation.ts`. |
| **Post-conditions** | 11 routes consume `ctx.auth` directly. The 4-arm literal-union narrowing is preserved. `routes/auth.ts` becomes the canonical consumer for `auth.kind === 'session'`, `routes/security.ts` for audit logging. |

### Detailed steps

1. For each route, replace `requiresAuth(path, method)` call with `ctx.auth` access (the gate result is already on the context).
2. For `routes/auth.ts`: replace `auth?.kind !== 'session'` checks with `ctx.auth?.kind === 'session'`.
3. For `routes/security.ts`: replace `ENROLL_KINDS.includes(auth.kind as ...)` with `ENROLL_KINDS.includes(ctx.auth?.kind as ...)`.
4. For `routes/federation.ts`: replace inline `validateInboxPayload` calls with the class-extracted `FederationBridge` (from C.7).
5. Run integration tests + auth-specific tests.

### Verification gates

- `bun --bun vitest run src/__tests__/auth.test.ts` (and others) passes.
- `grep -nE "auth\\?\\.kind|auth\\.kind" src/web/routes/auth.ts src/web/routes/security.ts` shows narrowing logic preserved verbatim.

---

## Phase C.7 — web/federation/ sub-cluster refactor

| Field | Value |
|---|---|
| **Goal** | Refactor the 9 federation cluster files as a unit. 4 files become classes (`FederationAddress`, `FederationBridge`, `FederationCapabilities`, `FederationCapabilityRunner`); the remaining 5 are phased (Config + Http + LocalCatalog + Onboarding + Poller). |
| **Files touched** | 9 files: `federation/address.ts`, `federation/bridge.ts`, `federation/capabilities.ts`, `federation/capability-runner.ts`, `federation/config.ts`, `federation/http.ts`, `federation/local-catalog.ts`, `federation/onboarding.ts`, `federation/poller.ts`. Plus `routes/federation.ts` (the route consumer). |
| **Risk level** | **Medium-High.** The 9 files are tightly coupled (`poller.ts` imports from `bridge.ts`, `capabilities.ts`, `config.ts`, `http.ts`). Per `review-correctness.md CE-2`, the cluster must be refactored as a unit. |
| **Test coverage requirement** | Each federation test file passes. New integration test verifies the poller → bridge → config → http chain still wires correctly. |
| **Rollback strategy** | Cluster-wide revert (the 9 files land as a single PR). The free functions survive as thin wrappers. |
| **Parallelizable** | **No.** The cluster must land as one PR due to internal coupling. |
| **Pre-conditions** | H.1 + C.1–C.6 + D.1 (`ChannelEnv`) + G.1–G.4 land. |
| **Post-conditions** | 9 federation cluster classes are exported. Free functions survive as thin wrappers. `FederationPollerRunner` (C.3) is replaced by `FederationPoller` class form. |

### Detailed steps (per file, in order)

1. **`federation/http.ts`** — extract `FederationHttp` class wrapping `readBoundedBody` + `postJson`. `PeerResponseTooLargeError` survives unchanged.
2. **`federation/address.ts`** — extract `FederationAddress` class with `parseQualifiedId(qualifiedId)` + `QualifiedId` interface.
3. **`federation/config.ts`** — extract `FederationConfig` class wrapping `FederationRoutingMode` + `FederationPeer` + `FederationConfig` interfaces + the 4 env-derived helpers.
4. **`federation/bridge.ts`** — extract `FederationBridge` class with `sendFederatedMessage(...)` returning `BridgeSendResult` (4-arm union, NO sealed class per OE-1).
5. **`federation/capabilities.ts`** — extract `FederationCapabilities` class wrapping the cache + summary builder.
6. **`federation/local-catalog.ts`** — extract `FederationLocalCatalog` class (60 LOC).
7. **`federation/onboarding.ts`** — extract `FederationOnboarding` class (393 LOC).
8. **`federation/capability-runner.ts`** — extract `FederationCapabilityRunner` class (89 LOC, replaces `startCapabilitySummaryRunner` at `:80`).
9. **`federation/poller.ts`** — extract `FederationPoller` class (287 LOC, replaces `startFederationPoller` at `:276`). `FederationPollInternalError` survives unchanged.
10. **`routes/federation.ts`** — update to consume the new class instances via DI.

### Verification gates

- `bun --bun vitest run src/__tests__/federation-*.test.ts` passes.
- `grep -nE "^export function" src/web/federation/*.ts | grep -v __tests__` returns the wrapper functions (the originals survive as wrappers).
- `grep -nE "^export class" src/web/federation/*.ts | grep -v __tests__` returns 9 + 3 existing = 12.

---

## Phase C.8 — vi.mock('../web.js') and per-route vi.mock migration

| Field | Value |
|---|---|
| **Goal** | Rewrite the `vi.mock('../web.js', …)` test factories to use constructor injection via `createTestDashboardServer()`, `createTestAuthGate()`, `createTestLogger()`. |
| **Files touched** | All `src/__tests__/*.test.ts` files that mock `../web.js` or per-route modules. The exact count per `review-correctness.md M4` is 154 `vi.mock('../config.js')` sites (not `vi.mock('../web.js')` specifically, but the same migration pattern). |
| **Risk level** | **Medium.** Mechanical rewrite, but high count. The factory design (`createTestDashboardServer`, etc.) is the load-bearing piece — the first 5-10 tests set the convention per `review-completeness.md CE-5`. |
| **Test coverage requirement** | All tests pass with the new factory pattern. |
| **Rollback strategy** | Per-test-file revert (each test file is independent). |
| **Parallelizable** | **Yes.** Each test file is independent. **But** the factory design MUST be settled first (single PR that introduces the 3-4 factories). |
| **Pre-conditions** | C.1–C.7 + the test factory design (per `review-completeness.md CE-5`). |
| **Post-conditions** | All `vi.mock('../web.js', …)` and per-route `vi.mock` sites are replaced by constructor injection. The factory conventions are documented. |

### Detailed steps

1. Introduce `createTestLogger(): LoggerLike` in `src/__tests__/test-factories.ts` (per `h-cross-cutting/03-class-boundaries.md` H.3 precedent).
2. Introduce `createTestAuthGate(deps?: Partial<AuthGateDeps>): AuthGate` in the same file.
3. Introduce `createTestDashboardServer(deps?: Partial<DashboardServerDeps>): DashboardServer` in the same file.
4. For each test file:
   a. Replace `vi.mock('../web.js', …)` with `vi.mock('../logger.js', …)` (H.1 mock) + explicit construction.
   b. Replace per-route `vi.mock('../web/routes/foo.js', …)` with explicit `createTestXxx(...)` calls.
5. Run the full test suite.

### Verification gates

- `bun --bun vitest run` passes.
- `grep -rnE "vi\\.mock\\(['\"]\\.\\./web\\.js" src/__tests__/` returns 0.
- `grep -rnE "vi\\.mock\\(['\"]\\.\\./web/routes" src/__tests__/` returns 0 (or only the still-pending routes).

---

## Phase C.9 — LoggerLike adoption verification

| Field | Value |
|---|---|
| **Goal** | Verify that every `logger.<level>(` call site in C has a corresponding `this.log.<level>(` (or `log.<level>(`) call site in the class body. Per `02-type-interface-analysis.md §10`, 221 call sites total (50 in `web.ts` + 159 in `routes/` + 12 in `federation/`). |
| **Files touched** | All C source files. Verification only — no code changes (the migration was done mechanically during C.1–C.7). |
| **Risk level** | **Low.** Verification only. |
| **Test coverage requirement** | Grep-based verification; no new tests. |
| **Rollback strategy** | N/A. |
| **Parallelizable** | **Yes.** Pure verification. |
| **Pre-conditions** | C.1–C.7 land. |
| **Post-conditions** | `grep -nE "logger\\.(info\|warn\|error\|debug)" src/web.ts src/web/routes/*.ts src/web/federation/*.ts` returns ONLY the class-body `this.log.X` calls and the C.10 free-function-wrapper remnants. |

### Detailed steps

1. Run `grep -nE "logger\\.(info\|warn\|error\|debug)" src/web.ts src/web/routes/*.ts src/web/federation/*.ts | grep -v __tests__`.
2. Verify each hit is inside a class body (`this.log.X`) or inside a free-function wrapper (allowed until C.10).
3. Run `bun tsc --noEmit` to verify no broken references.

### Verification gates

- `grep -nE "^import.*logger.*logger\\.js" src/web.ts src/web/routes/*.ts src/web/federation/*.ts` returns 0 (or only the C.10 wrappers).
- `bun tsc --noEmit` clean.

---

## Phase C.10 — Free function removal

| Field | Value |
|---|---|
| **Goal** | Remove all free-function wrappers from `src/web.ts`, `src/web/auth-gate.ts`, the 19 runner files, and the 9 federation cluster files. Every consumer must use the class API. |
| **Files touched** | ~30 files (1 `web.ts` + 1 `auth-gate.ts` + 19 runner files + 9 federation files). |
| **Risk level** | **High.** This is the irreversible phase. Per CLAUDE.md §3, "If you notice unrelated dead code, mention it — don't delete it" — but the wrappers ARE dead after every consumer migrates, so this phase is the legitimate cleanup. |
| **Test coverage requirement** | All tests pass with the class API. |
| **Rollback strategy** | Revert the cluster revert (the wrappers survive as dead code if the migration stalls). |
| **Parallelizable** | **No.** Single cluster-wide cleanup PR. |
| **Pre-conditions** | C.1–C.9 land + every consumer migrated. The gate is `grep -rnE "from ['\"]\\.\\./web(auth-gate)?\\.js['\"]" src/ --include='*.ts' | grep -v __tests__` returning only the class file itself (no free-function callers). |
| **Post-conditions** | All C free-function wrappers are removed. Only class APIs remain. `web.ts`, `auth-gate.ts`, the runner files, and the federation files export ONLY classes + types (no functions). |

### Detailed steps (per file)

1. **`web.ts`**: remove `startWebServer`. Keep `DashboardServer` class + `RouteContext` type re-export.
2. **`web/auth-gate.ts`**: remove `resolveAuth`, `requiresAuth`, `isFederationWireEndpoint`, `parseCookies`, `SESSION_COOKIE_NAME`. Keep `AuthGate` class + `AuthResult` type.
3. **19 runner files**: remove the `start*()` function. Keep the `XxxRunner` class.
4. **9 federation files**: remove the free functions. Keep the federation classes.
5. Update every consumer (`index.ts`, the 44 routes, the federation route consumer, the test files) to use the class API.

### Verification gates

- `grep -rnE "^export function start" src/web/*.ts src/web/routes/*.ts src/web/federation/*.ts | grep -v __tests__` returns 0.
- `grep -rnE "^export function (resolveAuth|requiresAuth|isFederationWireEndpoint|parseCookies)" src/web/auth-gate.ts` returns 0.
- `bun tsc --noEmit` clean.
- `bun --bun vitest run` passes (full suite).

---

## Cross-references

- `c-web/00-summary.md` — Executive summary, scope, dependencies, top 3 risks, migration order.
- `c-web/03-class-boundaries.md` — Concrete class candidates (signatures only).
- `c-web/04-generic-interfaces.md` — Generic interface analysis (all 3 sketches REJECTED).
- `c-web/06-risks-and-mitigations.md` — Risk-specific mitigations (CR1–CR10).
- `h-cross-cutting/00-summary.md` — H dependency (LoggerLike, AppError base).
- `b-config/00-summary.md` — B dependency (Config class).
- `d-channel-provider/00-summary.md` — D dependency (ChannelEnv class).
- `a-db/00-summary.md` — A dependency (DbClient + entity stores for C.5's `ctx.stores`).
- `g-channel-coordinator/00-summary.md` — G dependency (4 classes for the federation cluster's HMR isolation).
- `e-process-lock/00-summary.md` — E dependency (PortLockAcquirer / PidfileLockAcquirer precede C.2's boot).
- `f-agent-subsystem/00-summary.md` — F dependency (HeartbeatScheduler, StoreWatcher precede C.6's index.ts shutdown sequence).
- `review-correctness.md` — C1 (ChannelProvider interface methods), C2 (AuthContext 'none' case), C3 (4 fictional runner paths), C6 (index.ts import count).
- `review-completeness.md` — OE-4 (AuthContext sealed class DROPPED), OE-5 (BaseRunner DROPPED), OE-6 (single-consumer generics REJECTED), CE-3 (44 route blast radius), CE-9 (RemoteStatusCache<T> reuse), M11 (shutdown sequence).

---

**End of C refactor roadmap. No source files modified.**
