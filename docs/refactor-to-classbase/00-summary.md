# Refactor Plan — Summary

Synthesis of `01-module-state-analysis.md` and `02-type-interface-analysis.md`.
Planning only; no source files were modified.

## Executive summary

The codebase is function-shaped at the top level (44 top-level `src/` files,
only two true `class` declarations exist today: `DeferToPeerError` at
`src/process-lock.ts:272` and `RemoteEnrollError` at
`src/remote-enroll-core.ts:30`), but the data and behavior already cluster
into ~15 natural entities whose `*.find` / `*.get` / `*.upsert` /
`*.transition` free-function surface is begging for owner instances. The
refactor thesis is **convert three layers, leave two alone**: convert the
runner-as-start-fn layer (`web/`, `heartbeat.ts`, `store-watcher.ts`,
`settings-store.ts`, `channel-coordinator.ts`), the per-entity DB surface
(`Memory`, `KanbanCard`, `AgentMessage`, `ScheduledTask`, `BackgroundTask`,
`Approval`, `OtelSpan`, `IdeaBoxRow`, `VaultSshKey/Server`, `SettingDefinition`,
`ChannelProvider`), and the lazy-cache singletons (`agent.ts`,
`google-api.ts`, `graph-mail.ts`, `platform.ts`); leave the 18 pure utility
modules (`format.ts`, `auto-restrict.ts`, `pending-retries.ts`,
`mcp-list-parser.ts`, `prompt-safety.ts` constants, `config-registry.ts`,
`tool-timeouts.ts`, etc.) as namespaces; and treat `config.ts`, `db.ts`,
`web.ts`, and `index.ts` as the keystone conversions that land last because
every other module depends on at least one of them. Net effect: roughly
**~22 files become classes** (with another ~10 inside `web/` adopting a
generic `*Runner<T>` shape), **~18 stay as utility modules**, and the
single biggest behavioral change is that ~126 `vi.mock('../config.js', ...)`
plus ~35 `vi.mock('../db.js', ...)` sites in `src/__tests__/` get rewritten
to constructor injection.

## Scope estimate

| Category | Files | Disposition |
|---|---:|---|
| Per-entity stores (new classes) | ~12 | `MemoryStore` (replaces ~17 free fns in `db.ts` + `memory.ts`), `KanbanCards` (~18), `MessageBus` (~13), `Scheduler` (~10), `BackgroundTaskPool` (~7), `ApprovalStore` (~5), `SpanStore` (~4), `IdeaStore` (~9), `SshVault` (~9), `SettingsRegistry` (~3), `SettingsStore` (replaces `settings-store.ts`), `ChannelProviderRegistry` (~5 implementations + decorator) |
| Runner-as-class (new classes) | ~10 | `heartbeat.ts`, `store-watcher.ts`, `settings-store.ts`, `web/heartbeat-agent-scaffold.ts`, `web/agent-process.ts`, `web/agent-scaffold.ts`, plus 7 named runners in `web/` (`message-router`, `schedule-runner`, `channel-monitor`, `inbound-prober`, `channel-health-monitor`, `stuck-input-watcher`, `inbox-nudge-watcher`, `stuck-tool-call-watcher`, `reauth-healer`, `auto-restart-runner`, `model-fallback-runner`, `context-guard-runner`, `update-checker`, `federation-poller`, `capability-summary-runner`, `invite-monitor`, `channel-request-watcher`, `costs-sync-task`, `approval-timeout-sweeper`) |
| Lazy-cache singletons (new classes) | 4 | `agent.ts` (`ClaudeCodeBinResolver`), `google-api.ts` (`GoogleTokenCache`), `graph-mail.ts` (`GraphMailCredentialsCache` + `GraphMailTokenCache`), `platform.ts` (`LazyBin`) |
| Utility modules (no conversion) | ~18 | `auto-restart.ts` constants, `format.ts`, `mcp-list-parser.ts`, `pending-retries.ts`, `prompt-safety.ts` (constants stay), `config-registry.ts` data, `tool-timeouts.ts`, `team-trust.ts`, `test-run-marker.ts`, `update-agent-capability.ts`, `update-preflight.ts`, `env.ts`, `kanban-dispatch.ts`, `model-fallback.ts` (decide fns), `model-profiles.ts`, `context-guard.ts` (decide fn), `costops/*` (both files), `db/sqlite.ts` |
| Keystone (deferred to final phase) | 4 | `config.ts`, `db.ts`, `web.ts`, `index.ts` |

**Total: ~22 files become classes, ~18 stay as utility modules, 4 are
keystones deferred to the final coordinated patch.**

The 4 keystones are NOT counted in the 22 because their conversion is not
"add a class wrapper" but "rewrite to per-entity store classes inside the
file" (see Phase 7 below).

## Top 3 highest-risk conversions

1. **`src/db.ts` → per-entity store classes** — touches ~30 importing
   modules (`memory.ts`, `heartbeat.ts`, `agent.ts`, `costops/ledger.ts`,
   `index.ts`, and ~25 `web/*.ts` files). The current `let db: Database`
   singleton at `src/db.ts:10` plus the ~200 free functions that close over
   it make this the single broadest blast radius in the codebase. Risk
   surface: every test that currently calls `initDatabase(':memory:')`
   has to switch to constructor injection, plus ~25 `web/` route files
   have to acquire a `DbClient` instance instead of importing free
   functions. Mitigated by landing in entity-by-entity slices behind
   parallel-running legacy + class exports (see Phase 7).

2. **`src/index.ts` → `class App`** — the orchestrator owns 6 module-level
   `let` bindings (`webServer`, `decayInterval`, `digestTimer`,
   `digestInterval`, `shuttingDown`, `exitCode`), 2 module-level regexes
   (`PID_FILE`, `DASHBOARD_BINARY_PATTERN`, `BANNER`), the `acquireLock()`
   / `releaseLock()` / `shutdown()` / `main()` lifecycle, plus 70+
   imports. Converting it forces every cross-module wiring (config, db,
   web, heartbeat, store-watcher, settings-store, decay sweep, process
   lock) to become constructor args on `new App({config, db, web, ...})`,
   which is the natural seam for swapping real vs. test instances. Risk
   surface: the shutdown sequence is order-sensitive (digest timer before
   decay before web before channel); one missed disposal causes double
   shutdown or hanging handles.

3. **`src/web.ts` → `class DashboardServer`** — the 1500-line closure
   that handles every HTTP route. The current shape captures
   `DASHBOARD_TOKEN` and `allowedOrigins` at startup and inlines all
   route handlers; a class refactor moves each route handler to a method
   on the server class, and the auth kind projection (the
   `auth.kind === 'token' ? { kind: 'token' as const } : ...` ternary
   chain at `src/web.ts:155-159`) becomes the `AuthContext` sealed class
   hierarchy (see `04-generic-interfaces.md` D1). Risk surface: routes
   are 40+ `tryHandle*` functions in `src/web/routes/`; the refactor
   must not break the `RouteContext` DI seam that handlers depend on.

## Top 3 lowest-risk wins — LANDED STATUS

The three entries previously listed have all reached terminal status
(D.2 LANDED, E.1–E.4 LANDED, I.1 WITHDRAWN). This section is preserved
here as a status log; no new "lowest-risk win" exists in the queue at
this time. The D.1 entry (ChannelEnv class extraction) is the most
recent lowest-risk landing; see the post-D.1 paragraph below.

1. ~~**`src/channel-provider.ts` → `class TelegramChannelProvider` etc.**~~
   LANDED — D.2 (5 provider classes + `UnsupportedDirectSendProvider`
   base) + D.3 (`ChannelProviderRegistry`) + D.4 (`withTestRunMarking`
   Form B explicit-delegation function). See
   `d-channel-provider/05-refactor-roadmap.md` for phase detail.

2. ~~**`src/process-lock.ts` → `class PortLockAcquirer` + `class
   PidfileLockAcquirer`**~~ LANDED — E.1 + E.2 (class introduction
   alongside free-function wrappers) + E.3 (port-lock consumer
   migration in `index.ts`) + E.4 (pidfile consumer migration). E.5
   (free-function removal) + E.6 (`LogFn` removal, gated on H.1 + H.2)
   remain OPEN. See `e-process-lock/` for phase detail.

3. ~~**`src/auto-restart.ts` → `class AutoRestartSchedule`**~~ WITHDRAWN
   (2026-08-31). Superseded by commit 8f1906c; the class form
   violated `.claude/rules/class-vs-functional-decision.md` (0/5 IGEN
   on the decision tree). See `i-auto-restart/code-review-handoff.md`
   for the full verifier trail.

### Post-D.1 landing note (2026-09-04)

**D.1 `ChannelEnv` class extraction + full migration — LANDED** (this
commit). `class ChannelEnv` introduced at `src/channel-provider.ts:507`
with 4 methods (`getToken`, `getChatId` as instance methods;
`stateDirFor`, `readTokenFor` as statics) plus one `static readonly
TABLE` dispatch table. 42 production call sites migrated across 12
production files; 7 of 17 test mocks updated. **No legacy wrappers**
— the 4 legacy free functions (`getChannelToken`, `getChannelChatId`,
`channelStateDir`, `readChannelToken`) were deleted outright in the
same commit as the class introduction, not survived as thin wrappers.

This is the **first lowest-risk-win item that includes its own
helper-removal sweep**, because the consumer-migration was a single
coordinated change with the class extraction. The "D.5 helper removal"
phase was merged into D.1; no D.5 commits exist. The plan-vs-actual
delta is documented in
`d-channel-provider/05-refactor-roadmap.md` Phase D.1 "Design-intent
reference (NOT as shipped)".

**Why this counts as a lowest-risk win** (in retrospect):

- The 5-branch dispatch family is genuinely deduplicative (4 parallel
  switch statements collapse to 1 `TABLE` lookup).
- The class boundary matches the natural mental model ("the channel
  env owns the parsed env record + token/chatId resolution").
- No cross-module API changes for the 5 `ChannelProvider` consumers
  (signatures preserved byte-for-byte per `review-correctness.md` C1).
- Test suite green pre- and post-commit.

## Explicitly OUT OF SCOPE

- **All test files** (`src/__tests__/`, `src/**/__tests__/`). Tests get
  *updated* to match new class APIs but their coverage requirements,
  layout, and the test runner (`bun --bun vitest`) are not in scope.
- **`vitest.config.ts`, `tsconfig.json`, `bun.lockb`, package
  metadata**, build scripts, and CI workflows (`.github/workflows/`).
- **All markdown documentation outside `docs/refactor-to-classbase/`**
  (the existing MDs in `docs/` may need cross-reference updates when
  line numbers shift, but that is Phase 8 territory).
- **Subdirectory-specific refactors inside `src/channel-coordinator/`,
  `src/costops/`, `src/db/`, `src/web/`** that are not initiated by the
  top-level class conversions listed in scope. (Examples: the
  `telegram-client.ts` `TelegramApiError` class, the `costops/ledger.ts`
  report-generation, and `web/atomic-write.ts` are flagged but deferred.)
- **The existing `DeferToPeerError` (`src/process-lock.ts:272`) and
  `RemoteEnrollError` (`src/remote-enroll-core.ts:30`) classes** —
  these already follow the `XxxError extends Error` convention; new
  exceptions follow the same pattern, no migration needed.
- **Generic variance tuning beyond what is needed for the new
  `*Store<T>` / `*Runner<T>` shapes** listed in
  `04-generic-interfaces.md`. Per-file variance audit is not in scope.
- **Public API of any package that consumes `src/`** — there are no
  published packages; the only external consumers are internal scripts.
  The CLI scripts in `bin/` will be updated but their shape is not
  redesigned.

[ASSUMPTION: The test count `~126` for `vi.mock('../config.js', ...)`
includes the 3 patterns listed (`../config.js`, `../config`, `../config.ts`);
the test count `~35` for `vi.mock('../db.js', ...)` is from the grep in
`01-module-state-analysis.md` Section 7 and not re-verified here.]
