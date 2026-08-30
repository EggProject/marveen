# Refactor Roadmap

Ordered phases. Each phase is **independently shippable**: mergeable,
revertable, and gated on its own test coverage. Foundation (config,
logger, db, env) lands before leaves (channel handlers, web hooks).

The "parallelizable" marker means the phase can be executed by two
agents concurrently on disjoint file sets with no merge conflicts
beyond trivial import-line additions.

---

## Phase 0 — Pre-flight

- **Goal:** snapshot the baseline test + lint + typecheck numbers so
  every subsequent phase can gate on a measurable delta (per the
  CLAUDE.md rule about concrete gates measured at plan-writing time).
- **Files touched:** none (read-only)
- **Risk:** none
- **Test coverage requirement:** record current counts:
  - `bun --bun vitest run` total tests / passing
  - `bun tsc --noEmit` error count
  - `bun run lint` warning count
  - `bun run coverage` per-file percentage for the files listed in
    Phases 1–7 below
- **Rollback strategy:** none (no changes)
- **Parallelizable:** N/A

---

## Phase 1 — Logger unification (foundation)

- **Goal:** introduce the `LoggerLike` alias (G5) and migrate the
  ~5 duplicated `LogFn` re-definitions to use it.
- **Files touched:**
  - `src/logger.ts` (re-export the alias)
  - `src/process-lock.ts` (replace `LogFn` at line 19; replace the
    `{ info, warn, error }` shape on `ProcessLockContext` at line 26
    and `PidfileLockContext` at line 226 with `log: LoggerLike`)
- **Risk:** **Low.** No behavior change; the alias is a no-op at
  runtime.
- **Test coverage requirement:** existing `process-lock.test.ts` and
  any test that constructs a `ProcessLockContext` mock continues to
  pass; new unit test that asserts `LoggerLike` is assignable from
  the pino `Logger` type.
- **Rollback strategy:** single commit; revert is `git revert <sha>`.
- **Parallelizable:** yes — touches only `process-lock.ts` plus a
  re-export in `logger.ts`.

---

## Phase 2 — Process lock classes

- **Goal:** convert `acquirePortLock` + `acquirePidfileLock` into
  `PortLockAcquirer` + `PidfileLockAcquirer` (E1, E2 in
  `03-class-boundaries.md`).
- **Files touched:**
  - `src/process-lock.ts` — add classes; keep free functions as thin
    wrappers that delegate to a singleton instance for backward
    compatibility during migration
  - `src/index.ts` — construct the acquirers; pass them to
    `acquireLock()` / `releaseLock()` (Phase 7 will refactor this
    further)
  - `src/__tests__/process-lock.test.ts` — add new tests that
    exercise the class API
- **Risk:** **Low–Medium.** The class is a literal translation of
  the existing free functions; the `ctx` argument becomes `this`.
  Tests that mock `process-lock.js` keep working because the
  singleton wrappers preserve the free-function API.
- **Test coverage requirement:** all existing `process-lock` tests
  pass; new tests cover the class API (acquire/release, mock ctx
  injection).
- **Rollback strategy:** single commit; revert is `git revert <sha>`.
- **Parallelizable:** yes — touches only `process-lock.ts` +
  `index.ts` import lines.

---

## Phase 3 — Lazy-cache singletons

- **Goal:** convert the four lazy-cache singletons into classes
  (C1–C4 in `03-class-boundaries.md`).
- **Files touched:**
  - `src/agent.ts` — `ClaudeCodeBinResolver` (C1)
  - `src/google-api.ts` — `GoogleTokenCache` + `GoogleCalendarClient`
    (C2)
  - `src/graph-mail.ts` — `GraphMailCredentialsCache` +
    `GraphMailTokenCache` + `GraphMailClient` (C3)
  - `src/platform.ts` — `LazyBin<TName>` (C4 / G7)
  - `src/index.ts` — construct the singletons; pass to consumers
    (full refactor in Phase 7)
- **Risk:** **Medium.** The mtime-invalidation logic in `google-api.ts`
  and `graph-mail.ts` is non-trivial; a mis-translation can cause
  the cache to never invalidate (stale tokens) or to invalidate on
  every call (token refresh storm). The `LazyBin` is straightforward.
- **Test coverage requirement:** existing tests for the four files
  pass; new tests cover the cache invalidation paths (mtime bump,
  forced expiry, single-flight `refreshInFlight`).
- **Rollback strategy:** single commit per file (or one combined
  commit if the four are reviewed together).
- **Parallelizable:** yes — four files with disjoint dependency
  graphs; two agents can split work (`agent.ts` + `platform.ts`
  on one side, `google-api.ts` + `graph-mail.ts` on the other).

---

## Phase 4 — Pane-state watcher generic + sealed action types

- **Goal:** consolidate the three duplicated decision functions in
  `pane-state.ts` behind `BasePaneWatcher<TState, TThresholds>` (G1
  / B3 / B4 in `03-class-boundaries.md` and `04-generic-interfaces.md`),
  and convert the `ModelAction` / `PaneAction` discriminated unions
  into sealed classes (D2 / D3).
- **Files touched:**
  - `src/pane-state.ts` — add the abstract base + three subclasses;
    convert `decidePaneErrorAlert`, `decideStuckInputRecovery`,
    `decideStuckToolCallRecovery` to thin facades that delegate to
    the subclasses; convert `SubmitFollowupAction` / `StuckInputAction`
    unions to sealed hierarchies (D3)
  - `src/model-fallback.ts` — convert `ModelAction` to sealed
    hierarchy (D2)
  - `src/web/agent-process.ts` — update consumers
  - `src/web/schedule-runner.ts` — update consumers
  - `src/web/model-fallback-runner.ts` — update consumers
  - `src/web/stuck-input-watcher.ts` — instantiate
    `StuckInputRecoveryWatcher`
  - `src/web/stuck-tool-call-watcher.ts` — instantiate
    `StuckToolCallRecoveryWatcher`
  - `src/__tests__/pane-state.test.ts` — add tests for the abstract
    base + subclasses; the existing decision-function tests keep
    passing through the facade
- **Risk:** **Medium.** The decision logic is the safety net for the
  recovery loops; a wrong gate consolidation can cause false-positive
  restarts or missed stuck-input detections.
- **Test coverage requirement:** all existing `pane-state` tests
  pass; new tests cover the base-class gate helpers
  (`spellStartGate`, `clockSkewGuard`, `retryBudgetGuard`,
  `confirmDedup`) in isolation.
- **Rollback strategy:** single commit per file; revert restores the
  free functions.
- **Parallelizable:** partially — `pane-state.ts` + its consumers
  form one bundle; `model-fallback.ts` + its consumer form another
  bundle. The two bundles are disjoint.

---

## Phase 5 — web/ runners as classes

- **Goal:** convert the ~20 `start*()` runner functions in `web/`
  into classes extending `BaseRunner<TFacts, TDecision>` (G6 / B5).
- **Files touched:**
  - All `src/web/*-runner.ts` and equivalent (`message-router.ts`,
    `schedule-runner.ts`, `channel-monitor.ts`, `inbound-prober.ts`,
    `channel-health-monitor.ts`, `stuck-input-watcher.ts`,
    `inbox-nudge-watcher.ts`, `stuck-tool-call-watcher.ts`,
    `reauth-healer.ts`, `auto-restart-runner.ts`,
    `model-fallback-runner.ts`, `context-guard-runner.ts`,
    `update-checker.ts`, `federation-poller.ts`,
    `capability-summary-runner.ts`, `invite-monitor.ts`,
    `channel-request-watcher.ts`, `costs-sync-task.ts`,
    `approval-timeout-sweeper.ts`)
  - `src/web/agent-process.ts` — the `startAgentProcess` runner
  - `src/web/heartbeat-agent-scaffold.ts` — the heartbeat-agent
    runner
  - `src/web/agent-scaffold.ts` — the agent scaffold runner
  - `src/index.ts` — construct the runners; pass to the boot
    sequence (full refactor in Phase 7)
  - `src/__tests__/web/*.test.ts` — tests that mock the runner
    modules switch to constructor injection where possible
- **Risk:** **High** for the runner conversion as a whole (the
  number of files; the order-dependent shutdown sequence). Each
  individual runner is **Low–Medium** risk.
- **Test coverage requirement:** all existing `web/*` tests pass;
  the runner tests that today rely on `vi.mock('../web/X.js')`
  continue to work because the legacy `startX()` function is kept
  as a thin wrapper.
- **Rollback strategy:** per-runner commit. A bad runner conversion
  is reverted without touching the other 19.
- **Parallelizable:** yes — runners are disjoint; ten agents can
  each convert two runners concurrently with no merge conflicts
  beyond `src/index.ts` import additions.

---

## Phase 6 — Per-entity stores in `db.ts`

- **Goal:** convert the ~200 free functions in `db.ts` into per-
  entity store classes (A1–A9 in `03-class-boundaries.md`), plus
  the cache + retry-queue generics (G2 / G3).
- **Files touched:**
  - `src/db.ts` — major rewrite; introduce entity stores as classes
    *alongside* the legacy free functions (the legacy functions
    become thin wrappers that delegate to a singleton instance)
  - `src/memory.ts` — `MemoryStore` (A1) absorbs `buildMemoryContext`,
    `runDecaySweep`, `runDailyDigest`, `saveConversationTurn`
  - `src/db/sqlite.ts` — unchanged (already DI-style)
  - `src/heartbeat.ts` — consumes `MemoryStore` for the decay call
  - `src/agent.ts` — consumes `MemoryStore` for memory search
  - `src/kanban-dispatch.ts` — consumes `KanbanCards` for dispatch
  - `src/costops/ledger.ts` — consumes the entity stores it needs
  - `src/web/heartbeat-agent-scaffold.ts` — consumes `MemoryStore`
    + `Scheduler`
  - `src/web/channel-monitor.ts` — consumes `MemoryStore`
  - `src/web/routes/memories.ts` — consumes `MemoryStore`
  - `src/web/routes/migrate.ts` — consumes `MemoryStore`
  - `src/web/routes/kanban.ts` — consumes `KanbanCards`
  - `src/web/routes/messages.ts` — consumes `MessageBus`
  - `src/web/message-router.ts` — consumes `MessageBus`
  - `src/web/agent-worker.ts` — consumes `MessageBus`
  - `src/web/routes/approvals.ts` — consumes `ApprovalStore`
  - `src/web/routes/spans.ts` — consumes `SpanStore`
  - `src/web/routes/ideas.ts` (or equivalent) — consumes `IdeaStore`
  - `src/web/remote-enroll*.ts` — consumes `SshVault`
  - `src/remote-enroll-fs.ts` — its `enrollAuthorizedKey` /
    `removeEnrolledKey` move into `SshVault`
  - `src/__tests__/db.test.ts` — new tests for each store class
- **Risk:** **High.** The blast radius is ~30 importing modules;
  the legacy free-function wrappers are the safety net. The
  `MemoryStore` (A1) is the most-trafficked; the others can be
  converted in smaller slices.
- **Test coverage requirement:**
  - All existing `db.test.ts` tests pass
  - All existing per-entity tests pass (the `web/routes/messages.test.ts`,
    `web/routes/kanban.test.ts`, etc.)
  - New unit tests for each store class (covering the entity-specific
    behaviors listed in A1–A9)
- **Rollback strategy:** per-entity commit (one entity per commit).
  A bad `MessageBus` conversion is reverted without touching
  `MemoryStore`.
- **Parallelizable:** partially — `MemoryStore` (touches the most
  importers) must land first; the other eight stores can be split
  into two parallel bundles (`KanbanCards` + `Scheduler` +
  `BackgroundTaskPool` on one side; `MessageBus` + `ApprovalStore` +
  `SpanStore` + `IdeaStore` + `SshVault` on the other).

---

## Phase 7 — Keystone conversions (config, db wrapper, settings,
channel-provider, web server, app orchestrator)

- **Goal:** the coordinated final patch — convert `config.ts`,
  `db.ts`'s top-level singleton, `settings-store.ts`, the channel
  provider registry, `web.ts`, and `index.ts` (D1–D4 in
  `03-class-boundaries.md`).
- **Files touched:**
  - `src/config.ts` — `Config` class (D1); ~23 importing files
    take `Config` via DI
  - `src/db.ts` — `DbClient` class wrapper (D2) at the top level
    (per-entity stores from Phase 6 are already in place; this
    phase wraps the `let db` singleton)
  - `src/settings-store.ts` — `SettingsStore` class (A11); the
    `SettingsRegistry` (A10) is in `config-registry.ts`
  - `src/config-registry.ts` — `SettingsRegistry` class (A10)
  - `src/channel-provider.ts` — `ChannelProviderRegistry` +
    `TestRunMarkingDecorator` + the 5 provider classes (A12–A14)
  - `src/web.ts` — `DashboardServer` class (B6); `AuthContext`
    sealed hierarchy (D1)
  - `src/web/auth-gate.ts` — emits `AuthContext` instances
    (currently emits the `AuthResult` union)
  - `src/web/routes/types.ts` — `RouteContext` updated to carry
    `AuthContext` instead of `AuthResult`
  - `src/index.ts` — `App` class (D3); all 70+ imports become
    constructor args
  - `src/notify.ts` — consumes `ChannelProviderRegistry` instead
    of the module-level `CHANNEL_PROVIDER` / `CHANNEL_TOKEN` /
    `CHANNEL_CHAT_ID` singletons (it currently reads them from
    `config.ts`)
  - Every `web/routes/*` route handler — updated to take
    `RouteContext` (already the seam) with `ctx.auth: AuthContext`
  - `src/__tests__/*` — the ~126 `vi.mock('../config.js', ...)`
    plus ~35 `vi.mock('../db.js', ...)` sites get rewritten to
    constructor injection
- **Risk:** **Critical.** This is the broadest blast radius; a
  missed import or wrong singleton handoff can break the entire
  boot sequence.
- **Test coverage requirement:**
  - Full test suite passes (`bun --bun vitest run`)
  - Boot smoke test (the `bin/start` script) starts a fresh process
    and shuts it down cleanly
  - Existing integration tests (`src/__tests__/integration/*`) pass
  - New `App` constructor + `shutdown()` test that exercises the
    disposal order
- **Rollback strategy:** per-sub-phase commits
  (`config` → `db wrapper` → `settings-store` → `channel-provider`
  → `web server` → `App`). Each is independently revertable; the
  `App` conversion is the last and has its own rollback.
- **Parallelizable:** **no** — the phases inside Phase 7 are
  order-dependent (`App` needs every other class first).

### Phase 7 internal ordering

7a. `SettingsRegistry` (A10) — pure data; no consumers yet
7b. `Config` (D1) — needed by every other class
7c. `DbClient` (D2) — needed by every entity store
7d. `ChannelProviderRegistry` + 5 providers + decorator (A12–A14)
7e. `SettingsStore` (A11) — depends on `SettingsRegistry` + `Config`
7f. `DashboardServer` (B6) + `AuthContext` sealed (D1) — depends on
    `Config` + every route handler update
7g. `App` (D3) — depends on every preceding class

---

## Phase 8 — Documentation reconciliation

- **Goal:** update the existing `docs/` MD files to reflect the
  new line numbers and class structure; remove or rewrite MD
  references to deleted module-level singletons.
- **Files touched:**
  - `docs/**/*.md` — cross-reference updates
  - `docs/refactor-to-classbase/00-summary.md` (this file's
    successor) — final scope summary post-refactor
- **Risk:** **Low.** Documentation only.
- **Test coverage requirement:** N/A (no code).
- **Rollback strategy:** single commit; revert is `git revert <sha>`.
- **Parallelizable:** yes — multiple agents can each own a docs
  subdirectory.

---

## Summary dependency graph

```
Phase 1 (Logger)
   |
   v
Phase 2 (ProcessLock) ----+
                          |
Phase 3 (LazyCache) ------+--> Phase 4 (PaneWatcher) --> Phase 5 (web/Runners) --> Phase 6 (EntityStores) --> Phase 7 (Keystones) --> Phase 8 (Docs)
                          |
                          +--> Phase 6 (EntityStores)
```

`Phase 0` precedes everything; `Phase 8` follows everything.

---

## Risk-level summary

| Phase | Risk | Files touched | Rollback granularity |
|---|---|---:|---|
| 0 | None | 0 | n/a |
| 1 | Low | 2 | commit |
| 2 | Low–Medium | 3 | commit |
| 3 | Medium | 5 | commit |
| 4 | Medium | 8 | commit |
| 5 | High (per-runner Low–Medium) | ~25 | per-runner commit |
| 6 | High (per-entity Low–High) | ~25 | per-entity commit |
| 7 | Critical (per-sub-phase High) | ~75 | per-sub-phase commit |
| 8 | Low | many | commit |

---

## Pre-conditions for Phase 7

Phase 7 must not start until:

1. Phases 1–6 are merged to `feature-develop`
2. The full test suite passes on the merged branch
3. The `App` design (D3) is reviewed by the user (per
   `00-summary.md` top-3 highest-risk list, `App` is the
   orchestrator that touches every other class)
4. The shutdown disposal order is documented (per
   `01-module-state-analysis.md` Section 8: digest timer → decay →
   heartbeat → store watcher → settings store → runners → web
   server → process lock → db)
