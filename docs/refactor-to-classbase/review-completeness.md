# Plan Review — Over-engineering & Completeness

Review scope: `docs/refactor-to-classbase/00-summary.md` through
`06-risks-and-mitigations.md`. Source ground-truth verified against
`src/` (file inventory, class declarations, line refs to `db.ts`,
`pane-state.ts`, `web.ts`, `process-lock.ts`).

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 6 | 5 |
| Completeness | 3 | 6 | 4 |

**Net assessment: ACCEPT-WITH-EDITS.** The plan's keystone thesis (convert
singleton db to entity stores, convert lazy-cache singletons to classes,
formalize ChannelProvider hierarchy) is sound and net-positive. But the
sealed-class discimination proposals (D2/D3/D4) and three of the generics
(G2/G3/G6) are ceremony for negligible gain, the inventory is materially
incomplete (8 existing classes + the `web/federation/` subdir), and the
test-factory / error-class design is missing from a Phase-7-critical
patch.

---

## Over-engineering findings

### OE-1 (major) — `ModelAction` sealed hierarchy (D2)

**Proposal** (`04-generic-interfaces.md` D2):
```ts
abstract class ModelAction { abstract readonly kind: string }
class NoAction extends ModelAction { readonly kind = 'none' as const }
class DowngradeAction extends ModelAction { readonly kind = 'downgrade' as const; constructor(public readonly model: string) }
class RevertAction extends ModelAction { readonly kind = 'revert' as const; constructor(public readonly model: string) }
```

**Counter-argument.** The source is `type ModelAction = | { kind: 'none' } | { kind: 'downgrade'; model: string } | { kind: 'revert'; model: string }` at `model-fallback.ts:115` — three members, one carries a payload. The runtime cost is one heap allocation per `decideModelAction` call (every model-fallback tick). The compile-time benefit is zero — the union is already exhaustively checkable via `switch (action.kind)`. The sealed-class version also forces `decideModelAction` to instantiate one of three classes per call instead of returning a literal, which costs an allocation and a vtable pointer per tick.

A senior engineer would say: keep the union. The plan's own `02-type-interface-analysis.md` D5/D6/D7 ("Lower-priority sealed hierarchies (deferred)") already establishes the correct criterion — *sealed classes only for entities that own behavior*. `ModelAction` owns no behavior; it is a tag.

**Severity: wasteful.** Drop D2.

---

### OE-2 (major) — `PaneAction` sealed hierarchy (D3)

**Proposal** (`04-generic-interfaces.md` D3):
```ts
abstract class PaneAction { abstract readonly kind: string }
class NoPaneAction extends PaneAction { readonly kind = 'none' as const }
class InjectResumePaneAction extends PaneAction { readonly kind = 'inject-resume' as const; constructor(public readonly text: string) }
class RestartPaneAction extends PaneAction { readonly kind = 'restart' as const; constructor(public readonly reason: string) }
class AlertPaneAction extends PaneAction { readonly kind = 'alert' as const; constructor(public readonly message: string) }
```

**Counter-argument.** Same as OE-1: the union `SubmitFollowupAction` at `pane-state.ts:900` and `StuckInputAction` at `pane-state.ts:1373` are pure-data tags. The plan's own `02-type-interface-analysis.md` D5–D7 says *"sealed-class route is reserved for entities that own behavior"*. The two action unions have no methods. Converting them adds 4-5 classes for each union (≈8-10 subclasses total) for zero compile-time or runtime benefit. Allocation per pane-state tick × per agent process is real cost on a hot path.

**Severity: wasteful.** Drop D3 entirely. The plan already justifies deferring D5–D7 with the same reasoning — apply the same reasoning here.

---

### OE-3 (major) — `SpanStatus` sealed hierarchy (D4)

**Proposal** (`04-generic-interfaces.md` D4):
```ts
class ErrorSpan extends SpanStatus { readonly value = 'error' as const; constructor(public readonly message: string) }
class TimeoutSpan extends SpanStatus { readonly value = 'timeout' as const; constructor(public readonly deadlineMs: number) }
```

**Counter-argument.** The source `OtelSpan['status']` at `db.ts:3247` is `'ok' | 'error' | 'timeout' | 'running'` — a string-literal union with no per-variant payload. The proposal introduces `ErrorSpan.message` and `TimeoutSpan.deadlineMs` fields that don't exist on `OtelSpan` today (the `error_message` column on the span row carries the error string; there's no per-status `deadline_ms`). This means the sealed class introduces a NEW field that the DB schema would need to be reconciled with. Either the field is dropped (and the sealed class is just `OkSpan/ErrorSpan/TimeoutSpan/RunningSpan` with no payload, mirroring the union — at which point D4 is pure ceremony) or the field is kept and the DB schema is changed as part of Phase 6 (a hidden Phase-6 surface expansion the plan does not enumerate).

**Severity: wasteful.** Drop D4, or scope the schema change explicitly as Phase 6 work.

---

### OE-4 (major) — `AuthContext` sealed hierarchy (D1)

**Proposal** (`04-generic-interfaces.md` D1, `03-class-boundaries.md` D4):
```ts
abstract class AuthContext { abstract readonly kind: ... }
class TokenAuth extends AuthContext { readonly kind = 'token' as const }
class DeviceAuth extends AuthContext { ... constructor(public readonly device: DeviceRow) }
class SessionAuth extends AuthContext { ... constructor(public readonly user: DashboardUserPublic) }
class FederationAuth extends AuthContext { ... constructor(public readonly peer: string) }
```

**Counter-argument.** The source at `web.ts:155-159` is a 4-arm ternary that already produces type-safe objects:
```ts
auth.kind === 'token' ? { kind: 'token' as const }
  : auth.kind === 'device' ? { kind: 'device' as const, device: auth.device }
  : auth.kind === 'session' ? { kind: 'session' as const, user: auth.user }
  : { kind: 'federation' as const, peer: auth.peer }
```

The plan proposes this be moved to `DashboardServer.authContext(req)` returning an instance per request. Every authenticated HTTP request (44 route files × N requests) now heap-allocates an `AuthContext` subclass. The compile-time benefit is zero — the existing ternary already exhaustively narrows on `auth.kind`. The runtime cost is 44 route handlers × per-request allocation.

The plan's 03 §D4 even admits: *"the source union in `web/auth-gate.ts` stays as the auth-gate's return type until `web/auth-gate.ts` is itself rewritten (out of scope)"* — so for the migration window both representations coexist, doubling the auth surface.

**Severity: wasteful.** Drop D1. The 4-arm ternary is already typesafe.

---

### OE-5 (major) — `BaseRunner<TFacts, TDecision>` abstract base (G6)

**Proposal** (`04-generic-interfaces.md` G6):
```ts
abstract class BaseRunner<TFacts, TDecision> {
  protected abstract readonly intervalMs: number
  protected abstract tick(facts: TFacts): Promise<TDecision>
  protected apply(decision: TDecision): Promise<void>
  start(): void
  stop(): void
}
```

**Counter-argument.** The plan claims this consolidates "20+ `start*()` runners", but reading the actual list (B5 in `03-class-boundaries.md`): `message-router`, `schedule-runner`, `channel-monitor`, `inbound-prober`, `channel-health-monitor`, `stuck-input-watcher`, `inbox-nudge-watcher`, `stuck-tool-call-watcher`, `reauth-healer`, `auto-restart-runner`, `model-fallback-runner`, `context-guard-runner`, `update-checker`, `federation-poller`, `capability-summary-runner`, `invite-monitor`, `channel-request-watcher`, `costs-sync-task`, `approval-timeout-sweeper` — most are NOT `facts → decision` shaped. They're `tick → side effects` shaped (read fs, read db, emit a notification, schedule a sweep). The `apply(decision)` method has no semantic content for runners that have no decision.

For example `ApprovalTimeoutSweeper` calls `approvalStore.sweepExpired(now)` and logs — there is no `TFacts` or `TDecision`. Forcing it into `BaseRunner<F, D>` requires picking arbitrary types like `BaseRunner<number, void>` — ceremony.

The base class also bakes in `intervalMs` as a protected abstract, but several runners use `fs.watch` (not intervals): `store-watcher`, `settings-store`, `inbound-probe`. Different lifecycle; the base class would need an `EventSource` supertype to handle both, doubling the abstraction surface.

**Severity: wasteful** for the proposed shape. Drop G6, or scope it to the 3-4 runners that genuinely have a `facts → decision` shape (likely `MessageRouter`, `AutoRestartRunner`, `ModelFallbackRunner`, `ContextGuardRunner`). For the rest, keep the runner as a plain class with `start()` / `stop()` and an internal `tick()`.

---

### OE-6 (major) — `TtlCache<K, V>` (G2) and `RetryQueue<TRow>` (G3) for single-consumer use

**Proposal** (`04-generic-interfaces.md` G2 + G3). `TtlCache<K extends string, V>` is proposed to replace `db.ts:1238-1274` (the `memoryCache` Map + 3 helpers + `MEMORY_CACHE_TTL_MS`). `RetryQueue<TRow>` is proposed to replace 3 free functions in `pending-retries.ts`.

**Counter-argument.** `TtlCache<K, V>` has ONE consumer (`MemoryStore`) per `02-type-interface-analysis.md` G2 — *"the only consumer today"*. The existing 30-line implementation (`memoryCache` Map + 3 helpers + the `MEMORY_CACHE_TTL_MS` const at `db.ts:1238`) is dead-simple, has 100% test coverage (it's already exercised by `getMemoryCacheSize` / `clearMemoryCache` per `db.test.ts`), and the only "complex" piece is the prefix-invalidation idiom (`db.ts:1260-1263`):
```ts
for (const key of memoryCache.keys()) {
  if (key.startsWith(`${agentId}:`)) memoryCache.delete(key)
}
```

`TtlCache<K extends string, V>` adds: generic constraint, constructor with `ttlMs` + injectable `clock`, `invalidatePrefix(prefix: K)` method, `size()`, `clear()` — total ~40 lines of new code to wrap ~30 lines of existing code with no new consumer. Per `02-type-interface-analysis.md` G2 *"future, not in scope" the only potential reuse is `vault-key-cache` if added* — speculative.

`RetryQueue<TRow>` is similar — wraps 3 free functions that are 5-10 lines each (`shouldSendAlert`, `classifyTelegramSendError`). The constraint `TRow extends { first_attempt: number; alert_sent_at: number | null }` couples the generic to a single row shape, defeating the "generic" goal.

**Severity: wasteful** — both generics have one consumer and add abstraction without reuse. Drop G2 and G3. Keep `memoryCache` as a private module-level helper inside the new `MemoryStore`; keep `pending-retries.ts` as-is.

---

### OE-7 (minor) — `BasePaneWatcher<TState, TThresholds>` (G1) — generic variance vs. actual function shape

**Proposal** (`04-generic-interfaces.md` G1):
```ts
abstract class BasePaneWatcher<TState, TThresholds> {
  abstract readonly NO_STATE: TState
  abstract step(observation: unknown, prev: TState, now: number, thresholds: TThresholds): { act: boolean; next: TState }
  protected spellStartGate(now, lastSpellStart, thresholdMs): boolean
  protected clockSkewGuard(now, prevNow): boolean
  protected retryBudgetGuard(attempts, maxAttempts): boolean
  protected confirmDedup(seen, cooldownMs, now, lastFire): boolean
}
```

**Counter-argument.** `observation: unknown` defeats type safety — the existing `decideStuckInputRecovery(observation: Observation, ...)` at `pane-state.ts:1319` already takes a typed `Observation` parameter. Forcing `unknown` at the base class level means each subclass must narrow the type again inside `step()`. Either keep the typed input at the base (`step(observation: TFact, ...)` with `TFact` as a third generic) or accept that the base class is only marginally better than three free functions.

Also, the four protected methods (`spellStartGate`, `clockSkewGuard`, `retryBudgetGuard`, `confirmDedup`) are described as duplicated across three watchers, but `02-type-interface-analysis.md` Section G1's *~120 lines of pure-logic duplication* claim is unverified. A line-count of `decidePaneErrorAlert` (1010–1318 ≈ 308 lines), `decideStuckInputRecovery` (1319–1606 ≈ 287 lines), `decideStuckToolCallRecovery` (1607–end ≈ ? lines) suggests the actual logic per function is ~250-300 lines; the shared "gates" are likely a small fraction of each. The plan does not measure the actual duplicate lines, so the win is unquantified.

**Severity: wasteful** if the 120-line figure is unverified; **neutral** if it holds. Either way, do the line-count audit before writing the base class.

---

### OE-8 (minor) — `SettingsRegistry.define`/`undefine` (A10)

**Proposal** (`03-class-boundaries.md` A10):
```ts
define(entry: SettingDefinition): void
undefine(key: string): void
```

**Counter-argument.** `SETTINGS_REGISTRY: SettingDefinition[]` at `config-registry.ts:37` is a static list of 35+ entries built once at module load. There is no production caller of `define` / `undefine` — entries are added by editing the file. The two methods exist only to support test overrides that today use `vi.mock('../config-registry.js')`. Promoting the registry to a class adds boilerplate (`getDefinition`, `listModules`, `listKeys`, `validate`) for production-zero behavior change.

**Severity: wasteful** — `getDefinition`, `listModules`, `validate` are pure functions over the array; they can stay as `export function` in the existing module without an instance. Drop the class wrap; keep the registry as a `const` and the helpers as free functions.

---

### OE-9 (minor) — `App.getStore<K>` typed accessor (G8)

**Proposal** (`04-generic-interfaces.md` G8):
```ts
type StoreName = 'memoryStore' | 'kanbanCards' | 'messageBus' | ...
type StoreFor<K extends StoreName> = K extends 'memoryStore' ? MemoryStore : K extends 'kanbanCards' ? KanbanCards : ...
class App {
  getStore<K extends StoreName>(name: K): StoreFor<K>
}
```

**Counter-argument.** `App` owns the stores as instance fields directly. Any in-package caller (route handler, runner) already has the `App` instance via `RouteContext` (or constructor DI per B5) — it can read `app.memoryStore` directly without going through `getStore('memoryStore')`. The `getStore` indirection only helps out-of-package callers (tests, future external scripts). For tests, the cost of `app.memoryStore` (direct field) vs `app.getStore('memoryStore')` (mapped type) is negligible; for the existing 382 test files, the direct field is shorter and more idiomatic.

**Severity: wasteful.** Drop `getStore<K>`; expose stores as `public readonly` fields on `App`.

---

### OE-10 (minor) — Constructor parameter noise: `embeddingModel?` on `MemoryStore`

**Proposal** (`03-class-boundaries.md` A1):
```ts
constructor(db: Database, opts: { recencyLambda: number; recencyTauSec: number; embeddingModel?: string })
```

**Counter-argument.** The plan lists `generateEmbedding`, `hybridSearch`, `vectorSearch` as methods on `MemoryStore`. The embedding pipeline is a complex subsystem (separate API call, separate SDK client, separate error path) and is consumed by 8+ entities indirectly through `Memory`. Putting the embedding model in `MemoryStore`'s constructor couples an embed call to memory storage. If the model changes (e.g., switch from OpenAI to a local embed), every `MemoryStore` instance has to be reconstructed.

Also `recencyLambda` and `recencyTauSec` are currently constants in `db.ts` (per `02-type-interface-analysis.md` E1 *"the RECENCY_LAMBDA / RECENCY_TAU_SEC constants would become constructor opts"*) — making them constructor opts is a backwards-step (you can't tune them at runtime via env vars anymore).

**Severity: wasteful.** Extract the embedding pipeline to its own `EmbeddingClient` class (mentioned in A1 Dependencies but not formalized) and inject it; keep the recency constants module-level (they're tunable today via constants — making them constructor opts is regression, not improvement).

---

### OE-11 (minor) — Phase merging: Phase 1 + Phase 2 could be one

**Proposal** (`05-refactor-roadmap.md` Phase 1 + Phase 2):
- Phase 1: `LoggerLike` alias in `logger.ts` + `process-lock.ts` (2 files, risk Low)
- Phase 2: `PortLockAcquirer` + `PidfileLockAcquirer` (3 files, risk Low–Medium)

**Counter-argument.** Phase 2's classes (`PortLockAcquirer`, `PidfileLockAcquirer`) take `LoggerLike` in their constructor (`03-class-boundaries.md` E1 / E2 list `ctx: ProcessLockContext` which contains `log: LoggerLike` per R1 mitigation). So Phase 2 depends on Phase 1's `LoggerLike` being in place. The plan marks both as "Parallelizable: yes", but Phase 2 cannot land before Phase 1. Either the plan should say Phase 1 must land first, or the two should merge into a single Phase 1 ("Logger + ProcessLock foundation"). With 3 files total and the same rollback granularity, splitting them adds coordination cost without benefit.

**Severity: neutral** — splitting phases for clarity is fine, but the dependency arrow is missing in the Phase 1 / Phase 2 description (Phase 1 → Phase 2, not parallel).

---

## Completeness findings

### CE-1 (critical) — `00-summary.md` claims only 2 classes exist; ground truth has 9

**Missing area.** The plan's `00-summary.md` Executive Summary states:
> "only two true `class` declarations exist today: `DeferToPeerError` at `src/process-lock.ts:272` and `RemoteEnrollError` at `src/remote-enroll-core.ts:30`"

Ground truth from `grep -nE "^export class" src/**/*.ts | grep -v __tests__`:

| Class | File | Line | Notes |
|---|---|---:|---|
| `DeferToPeerError` | `process-lock.ts` | 272 | cited |
| `RemoteEnrollError` | `remote-enroll-core.ts` | 30 | cited |
| `TelegramApiError` | `channel-coordinator/telegram-client.ts` | 45 | missed |
| `PeerResponseTooLargeError` | `web/federation/http.ts` | 7 | missed |
| `UserFacingError` | `web/fleet-transfer.ts` | 36 | missed |
| `PasswordPolicyError` | `web/password-hash.ts` | 40 | missed |
| `RemoteStatusCache<T>` | `web/remote-status-cache.ts` | 19 | missed — generic class |
| `FederationPollInternalError` | `web/federation/poller.ts` | 68 | missed |
| `RequestBodyTooLargeError` | `web/http-helpers.ts` | 25 | missed |
| `KeychainUnavailableError` | `web/keychain.ts` | 19 | missed |

That's 8 additional class declarations the plan missed. `00-summary.md`'s "out of scope" section says:
> "The existing `DeferToPeerError` (`src/process-lock.ts:272`) and `RemoteEnrollError` (`src/remote-enroll-core.ts:30`) classes — these already follow the `XxxError extends Error` convention; new exceptions follow the same pattern, no migration needed."

The other 6 error classes follow the same `XxxError extends Error` convention and should be in the same out-of-scope bucket. **`RemoteStatusCache<T>` is the most consequential miss** — it's a generic class (`<T>`) already in use at `web/routes/agents.ts:204-205` (two instances). It is direct precedent for `TtlCache<K, V>` (G2) — the plan's proposal is essentially reinventing an existing class without citing it.

**Why it matters.** The plan's entire analysis premise ("the codebase is function-shaped at the top level") is materially wrong at the route-and-deeper level. A reader who trusts the "2 classes" number will underestimate the codebase's existing OOP vocabulary. Also, `RemoteStatusCache<T>` being a generic class already in production means the plan's generic-proposal review (G2) is asking the wrong question — should `MemoryCache` reuse `RemoteStatusCache<T>` rather than introduce `TtlCache<K, V>` as a parallel abstraction?

**Severity: critical.** Fix the inventory count to 9. Add `RemoteStatusCache<T>` to G2's discussion (either as precedent to follow or as a parallel generic that the codebase already has).

---

### CE-2 (critical) — `web/federation/` subdirectory entirely missed

**Missing area.** `src/web/federation/` contains 10 files, 1835 LOC total:

```
web/federation/address.ts          (51 lines)
web/federation/bridge.ts          (179 lines)
web/federation/capabilities.ts    (343 lines)
web/federation/capability-runner.ts (89 lines)
web/federation/config.ts          (393 lines)
web/federation/http.ts             (40 lines, contains class PeerResponseTooLargeError)
web/federation/local-catalog.ts   (60 lines)
web/federation/onboarding.ts      (393 lines)
web/federation/poller.ts          (287 lines, contains class FederationPollInternalError)
                                    ------
                                    1835 total
```

The plan's `01-module-state-analysis.md` Section 6.4 says *"~90 files"* in `src/web/` but only the 84 top-level files. `06-risks-and-mitigations.md` lists `federation-poller` runner as a single web file in `03-class-boundaries.md` B5, but the actual file is `web/federation/poller.ts` — not a top-level web runner. The `01` and `06` documents do not acknowledge the `web/federation/` subdirectory as a sub-cluster.

**Why it matters.** Phase 5 (web/ runners as classes) treats `FederationPoller` as one of ~20 runners, but `web/federation/poller.ts` (287 lines) imports from `web/federation/bridge.ts`, `capabilities.ts`, `config.ts`, `http.ts` — a multi-file module cluster, not a single-file runner. The refactor would have to touch the federation/ subcluster as a unit. The same applies to `capability-runner.ts` and the supporting files. The plan's "ten agents can each convert two runners concurrently with no merge conflicts beyond `src/index.ts` import additions" claim (`05-refactor-roadmap.md` Phase 5) undercounts: the federation/ cluster has 10 interdependent files, not 1-2.

Also, `web/federation/http.ts:7` already has a class — see CE-1.

**Severity: critical.** Add `web/federation/` to the inventory (Section 6.4 of `01`, Section 6.4 of `06`); re-scope Phase 5 to acknowledge the cluster.

---

### CE-3 (critical) — Route handler blast radius not enumerated

**Missing area.** The plan says Phase 7 *"Every `web/routes/*` route handler — updated to take `RouteContext` (already the seam) with `ctx.auth: AuthContext`"*. There are 44 route files in `src/web/routes/`:

```
address.ts, agent-conversation.ts, agent-taskstate.ts, agent-terminal.ts,
agents-skills.ts, agents.ts, approvals.ts, audit-log.ts, auth.ts, autonomy.ts,
background-tasks.ts, connectors-hu.ts, connectors.ts, costs.ts, daily-log.ts,
docs.ts, federation.ts, fleet-q.ts, fleet.ts, ideas.ts, kanban.ts, marveen.ts,
memories.ts, messages.ts, migrate.ts, onboarding.ts, overview.ts, profiles.ts,
recall.ts, research.ts, schedules.ts, security.ts, settings.ts, skill-usage.ts,
skills.ts, spans.ts, static.ts, status.ts, token-usage.ts, tool-log.ts,
updates.ts, vault-ssh-keys.ts, vault-ssh.ts, voice.ts  (44 files)
```

`03-class-boundaries.md` B6 says `DashboardServer` requires *"every gated route receives a `ctx.auth: AuthContext`"*. That means 44 route files each need an edit to switch from `auth.user` / `auth.device` / `auth.peer` (union-typed) to those same fields on the `AuthContext` subclass. Even if D1 is dropped (per OE-4 above), the `RouteContext` type change in `web/routes/types.ts:27` (per the file's length, 27 lines) ripples to all 44 files regardless.

The plan's `01-module-state-analysis.md` Section 1 lists `web.ts:1500-line closure` and the route directory is correctly flagged, but the per-file blast radius is not enumerated. The plan's risk assessment says Phase 7 is *"Critical"* but the mitigation is *"per-sub-phase commits"* — there is no per-route-file mitigation.

**Why it matters.** 44 files is a 4× bigger blast radius than the largest Phase 6 entity (`db.ts` consumers — 30 modules per `01 §5`). If `RouteContext` shape changes, 44 files need editing in one sub-phase (7f). This is the actual single-biggest risk in the plan; it deserves its own risk row in `06-risks-and-mitigations.md`, not a sub-bullet under R2.

**Severity: critical.** Add a dedicated risk (R11: route handler migration) to `06-risks-and-mitigations.md` with the 44-file enumeration and a per-route-file rollback strategy.

---

### CE-4 (major) — Cross-cutting error class design missing

**Missing area.** The plan proposes `class MemoryStoreError extends Error` in R6 (`06-risks-and-mitigations.md` R6) as an example of structured error fields. But it doesn't enumerate which classes need error subclasses and which can throw plain `Error`. With 8 entity-store classes (A1–A9) and 5 channel-provider classes (A13), the plan introduces ~13 potential error surfaces. Without an error-class design:

- `MemoryStore.search` throwing on bad SQL vs. throwing a typed `MemoryStoreError` with `query` / `cause`
- `ChannelProvider.sendMessage` throwing on a Telegram flood-wait vs. wrapping as `TelegramFloodWaitError`
- `SettingsStore.setOverride` throwing on validation failure vs. returning the existing `SetOverrideResult`

The 8 existing error classes (`DeferToPeerError`, `RemoteEnrollError`, `TelegramApiError`, `PeerResponseTooLargeError`, `UserFacingError`, `PasswordPolicyError`, `FederationPollInternalError`, `RequestBodyTooLargeError`, `KeychainUnavailableError`) already form an ad-hoc taxonomy. The plan should either:

(a) Define a new error-class taxonomy for the new stores (e.g., `MemoryStoreError`, `KanbanStateError`, `MessageBusError`, etc.), OR
(b) Document that all store errors are `Error` and the structured-field idiom from R6 applies only when there's a clear cross-cutting consumer.

**Why it matters.** R6 says *"structured error fields"* is a mitigation; without a per-store design, every store developer picks a different convention and the pino log filtering that R6 mentions (`filter by query without parsing the message`) breaks. Existing `TelegramApiError` has no `query` field, while the proposed `MemoryStoreError` does — inconsistent.

**Severity: major.** Add an "Error class design" section to `03-class-boundaries.md` listing which new classes need error subclasses and what fields they carry.

---

### CE-5 (major) — Per-test factory function not specified

**Missing area.** Phase 7 risk R3 (`06-risks-and-mitigations.md` R3) says tests rewrite `vi.mock('../config.js', ...)` to constructor injection. The mitigation shows:
```ts
beforeEach(() => {
  const db = new DbClient({ filename: ':memory:' })
  // seed db, pass to SUT
})
```

But there are 382 test files at `src/__tests__/` (`find` count: 382). For each test that today uses `vi.mock('../config.js', () => ({ WEB_PORT: 4000, ... }))` — per `01 §7` there are 152 such files (126 + 35 overlaps counted) — the test rewrite needs:

- A `createTestConfig(overrides)` factory (or similar) that returns a `Config` instance with the right defaults
- A `createTestDb()` factory that returns a `:memory:` DbClient
- A `createTestApp()` factory that returns a wired `App` for integration tests

Without these factories, each test author writes their own ad-hoc `new Config({...})` boilerplate, leading to 152 different config-mock styles.

**Why it matters.** The plan's "test rewrite" scope is huge (152 files for config + 51 for db + 90 for logger = ~290 files affected) but the factory pattern is not specified. The first 5-10 tests will define the convention; everything after copies it. If the convention is set wrong (e.g., wrong mock seam, missing logger), the rework cost is enormous.

**Severity: major.** Add a "Test factory design" subsection to `06-risks-and-mitigations.md` with the proposed `createTestConfig` / `createTestDb` / `createTestApp` signatures, to be reviewed before Phase 7 starts.

---

### CE-6 (major) — `web/atomic-write.ts` mocked 14× but treated as out-of-scope

**Missing area.** `01-module-state-analysis.md` Section 7 lists `../web/atomic-write.js` as a top-15 mock target with 14 hits. `06-risks-and-mitigations.md` R3 cites the same number. But the plan does not propose a class for `web/atomic-write.ts` — it's listed as a "pure utility (already DI-friendly)" in `01 §6.4`.

If atomic-write.ts stays a free-function module, every test that mocks it must continue to mock the entire module (because the free functions close over `fs`). The plan claims this is "Heavy I/O boundary … class refactor doesn't help directly" (R3 mitigation 1) — but with 14 mocks, this is a noticeable test-churn surface. Either:

(a) Convert `atomicWriteFile` / `atomicWriteBuffer` etc. to a class so tests can mock at the constructor level (consistent with the rest of the plan), OR
(b) Document explicitly why this module is exempt.

**Why it matters.** Inconsistent treatment — the plan converts 20+ modules to classes for testability but exempts the most-mocked one. If a future contributor asks "why not atomic-write?", the answer should be in the plan.

**Severity: major.** Either add atomic-write to A1–A12 OR document the exemption in `00-summary.md` out-of-scope.

---

### CE-7 (major) — Heartbeat duplication: `src/heartbeat.ts` vs `web/heartbeat-agent-scaffold.ts`

**Missing area.** `03-class-boundaries.md` B1 proposes `HeartbeatScheduler` class for `src/heartbeat.ts` (B1, B5). `05-refactor-roadmap.md` Phase 5 also lists `web/heartbeat-agent-scaffold.ts` (324 lines) as a runner to convert (Phase 5 file list). But these are two distinct heartbeat subsystems:

- `src/heartbeat.ts` (26783 bytes, ≈900 LOC) — the main agent's periodic run loop (`initHeartbeat`, `stopHeartbeat`, `executeHeartbeat`)
- `src/web/heartbeat-agent-scaffold.ts` (324 lines) — the heartbeat agent's prompt/context building (`buildHeartbeatAgentPrompt`, etc.) — a totally different subsystem that the `web/main-agent.ts` (49 lines) wires together

The plan lumps `web/heartbeat-agent-scaffold.ts` into the B5 runner list (alongside `message-router.ts`, `inbound-prober.ts`) but it has no `tick()` — it's a prompt-builder. The conversion (runner-as-class) doesn't fit.

**Why it matters.** If Phase 5 tries to convert `heartbeat-agent-scaffold.ts` to a runner class with `start()`/`stop()`/`tick()`, the result is forced and semantically wrong. The plan needs to acknowledge that not every `web/*.ts` file with internal state is a runner.

**Severity: major.** Separate `web/heartbeat-agent-scaffold.ts` from the runner list in B5; treat it as a prompt-builder utility (likely a class but not a runner).

---

### CE-8 (major) — `memory.ts` ↔ `db.ts` circular constructor dependency

**Missing area.** `01-module-state-analysis.md` Section 3.3 says:
> "`heartbeat.ts` ↔ `memory.ts` ↔ `db.ts` cross-call: `heartbeat.ts` calls `runDecaySweep()` from `memory.ts`, which calls `dbDecay()`/`pruneAuditLogs()`/`pruneTokenUsage()` from `db.ts`. Each of those is a free function with no DI — a class-based refactor would need to thread a `Database` instance through three files."

`03-class-boundaries.md` A1 (`MemoryStore`) is proposed to absorb `buildMemoryContext`, `runDecaySweep`, `runDailyDigest`, `saveConversationTurn` from `memory.ts`. But the proposal says `MemoryStore` takes `db: Database` as a constructor arg. If `MemoryStore` owns `runDecaySweep`, the call chain becomes:

`HeartbeatScheduler.triggerNow()` → `memoryStore.runDecaySweep()` → `db.decayMemories()` (via the `db` field on `MemoryStore`)

So `HeartbeatScheduler` needs `MemoryStore`, which needs `Database`. This is fine — single direction. But the plan does not address: **what does `memory.ts` itself become?** Currently `memory.ts` is a separate file; if its functions move into `MemoryStore`, `memory.ts` either disappears or becomes a thin facade (which is what Phase 6 says, but the dependency ordering needs to be spelled out).

Also, `runDecaySweep` is called from `index.ts` (per `01 §3.3` — *"the decay interval"*) — so `App` needs a reference to `MemoryStore.runDecaySweep` for the decay interval. Today the interval is module-level; after refactor it's an instance method. This needs to be in the App constructor + shutdown sequence (which the plan covers in R9).

**Why it matters.** Phase 6 (entity stores) and Phase 7 (keystone) touch the same code path; if either phase misses the cross-call wiring, the decay sweep silently no-ops. The plan's `01 §8` shutdown sequence (digest timer → decay interval → heartbeat → ...) is correct, but the construction order (Phase 7 App constructor) needs the same level of detail.

**Severity: major.** Add the construction-order table to `05-refactor-roadmap.md` Phase 7 (currently only the shutdown order is documented).

---

### CE-9 (major) — `RemoteStatusCache<T>` reuse opportunity missed

**Missing area.** See CE-1: `web/remote-status-cache.ts:19` already defines `class RemoteStatusCache<T>` with `getOrRefresh(key, nowMs, fetch, fallback)` — a generic cache class with a per-call TTL. The plan's G2 (`TtlCache<K, V>`) proposes a parallel abstraction:

```ts
class TtlCache<K extends string, V> {
  get(key: K): V | null
  set(key: K, value: V): void
  invalidatePrefix(prefix: K): number
}
```

`RemoteStatusCache` and `TtlCache` overlap conceptually but have different APIs (`getOrRefresh` vs `get`/`set`). The plan does not consider whether:

(a) `MemoryCache` should be a `RemoteStatusCache<Memory[]>` (different shape — `getOrRefresh(key, nowMs, fetch)` works if `MemoryStore` is the fetcher), OR
(b) `RemoteStatusCache` should be renamed/extended into `TtlCache`, OR
(c) The two should stay separate (different concerns).

**Why it matters.** Two parallel generic cache classes is a maintenance burden. The existing `RemoteStatusCache<T>` has 100% test coverage at `web/routes/agents.ts:204-205`; reusing it for `MemoryStore` would consolidate.

**Severity: major.** Either fold `MemoryCache` into `RemoteStatusCache<T>` or document the deliberate split.

---

### CE-10 (major) — Documentation ripple beyond `docs/refactor-to-classbase/` not enumerated

**Missing area.** Phase 8 (`05-refactor-roadmap.md`) says *"update the existing `docs/` MD files to reflect the new line numbers and class structure"*. The CLAUDE.md guidance says *"MD or commit message file:line hivatkozásai: mielőtt committolsz, Read-eld a forrást a hivatkozott sorokon"* — i.e., every MD line-ref must be re-verified post-refactor.

Per `find docs/ -name '*.md' | wc -l` (implicit): the codebase has many docs/. The plan does not enumerate which MD files will need updating. Examples likely affected:

- `docs/refactor-to-classbase/` (already enumerated in Phase 8)
- Other `docs/*.md` files that reference `db.ts:1061` (Memory type), `pane-state.ts:900` (action unions), `channel-provider.ts:11` (interface), `process-lock.ts:169` (function), `config.ts:21` (cycle comment)

The plan says "Phase 8 territory" but doesn't say how to find these references. A grep for `db.ts:1061` and similar would be required.

**Why it matters.** Per CLAUDE.md §8, MD refs that aren't re-verified cause silent doc rot. Phase 8 should include a grep checklist.

**Severity: major.** Add a "Phase 8 grep checklist" to Phase 8 listing the patterns to grep (`db.ts:\d+`, `pane-state.ts:\d+`, etc.).

---

### CE-11 (major) — Per-file blast radius tables missing for entity stores

**Missing area.** The plan lists entity-store public methods (A1–A9 in `03-class-boundaries.md`) but does not enumerate, for each store, how many files need to change to adopt the class API. From `02-type-interface-analysis.md` Section Shared types inventory:

| Store | Files importing the entity type |
|---|---:|
| `Memory` | 6 |
| `AgentMessage` | 4 |
| `KanbanCard` | (single-file type but behavior in many routes) |
| `ScheduledTask` | (single-file type but behavior in many routes) |
| `BackgroundTask` | (similar) |
| `Approval` | (single-file type) |
| `OtelSpan` | (single-file type) |
| `IdeaBoxRow` | (single-file type) |

But the *behavior* (free functions) is consumed much more widely — e.g., `dbDecay` is called from `memory.ts`, `heartbeat.ts`, and probably `costops/ledger.ts`. The plan doesn't enumerate per-store consumers.

**Why it matters.** Phase 6 risk is *"High. The blast radius is ~30 importing modules"* — but that's the cumulative count, not per-store. Without per-store blast-radius, Phase 6 cannot be parallelized safely (Phase 6 says `MemoryStore` must land first because it touches the most importers, but doesn't quantify "the most").

**Severity: major.** Add a per-store blast-radius table to Phase 6 listing importer files per entity.

---

### CE-12 (minor) — Debug ergonomics coverage is thin

**Missing area.** R6 (stack traces) mentions pino `err.stack` truncation but does not address:

- Source maps in development for `.ts` files (the plan says "ensure `tsconfig.json` has `sourceMap: true`" but doesn't check current state)
- bun's stack frame format (which differs from Node in some cases)
- Whether `Error.captureStackTrace` is used today (the plan says "preserve if used" but doesn't verify)
- Debugger breakpoints in `App` shutdown sequence

**Severity: minor.** Verify current source-map and stack-trace behavior before Phase 7 lands.

---

### CE-13 (minor) — Hot-reload during dev not addressed

**Missing area.** `01 §8` flags `heartbeat.ts` double-timer as a hot-reload hazard. The plan converts `heartbeat.ts` to `HeartbeatScheduler` class with `start()`/`stop()` (B1) — which mitigates the hazard. But other modules with similar hazards are not enumerated:

- `store-watcher.ts` (`01 §8` flags it)
- `settings-store.ts` (same)
- `db.ts` (idempotent init, safe)
- `agent.ts` (cache reset on re-import, safe)

The plan mentions these only in `01 §8`. Phase 6 should explicitly call out which `start()`/`stop()` transitions are HMR-safe.

**Severity: minor.** Add an "HMR safety" subsection to Phase 5 / Phase 6.

---

### CE-14 (minor) — Other store-like web/ modules not in inventory

**Missing area.** The runner list in B5 mentions `auto-restart-runner.ts`, `context-guard-runner.ts`, etc. But several web/ files are store-shaped:

- `web/auto-restart-store.ts` — store for restart configs
- `web/context-guard-store.ts` — store for guard state
- `web/model-fallback-store.ts` — store for fallback chain
- `web/terminal-input-store.ts` — input queue store
- `web/mcp-list.ts` — refresh cache (mentioned as deferred in 03 §F)

These aren't runners (no `start()`) and aren't routes. They're persistence-shaped helpers that match the entity-store pattern but live in `web/`. The plan doesn't address them.

**Severity: minor.** Add to Phase 6 inventory or document why they're exempt.

---

### CE-15 (minor) — Pino logger singleton vs. constructor-injected `Logger` ambiguity

**Missing area.** `06-risks-and-mitigations.md` R10 covers logger re-import but doesn't address the dual-export pattern: the codebase has `logger.ts` exporting a singleton AND every new class has a `log: Logger` constructor field. At boot, `App` constructs the stores with `log: logger` (the singleton). At test time, tests construct stores with `log: mockLogger` (a `vi.fn()`). But the singleton is also still imported everywhere by legacy code that hasn't migrated.

This means the codebase has two log destinations during the migration window: the singleton and per-class instances. If a test mocks `../logger.js`, the per-class instances still hold the singleton (because they're constructed at app boot, before the mock takes effect), so the mock misses all class-method logs.

R10 says "the per-class `LoggerLike` injection means each class holds the *mock* logger as `this.log` — fine, but the test must inject the mock via the constructor, not via module replacement" — but doesn't provide a test factory that does the constructor injection correctly.

**Severity: minor.** Cross-reference with CE-5 (test factory).

---

### CE-16 (minor) — Free function count `~200` in `db.ts` unverified

**Missing area.** The plan claims *"~200 exported free functions in `db.ts`"* (`00-summary.md` §3, `03 §D2`, `05 §Phase 6`). CLAUDE.md says: *"MD '(was L### pre-<commit>)' history line ref ellenőrzése pre-state source-ból"* — the same principle applies to counts. A grep for `^export function` in `db.ts` should be run before any plan document cites the count.

**Severity: minor.** Verify the count at plan-writing time; cite the actual number (or range) in MD.

---

### CE-17 (minor) — `bun` test runner specifics

**Missing area.** `00-summary.md` says *"the test runner (`bun --bun vitest`) is not in scope"* for the test files. But the bun runtime has known differences from Node:

- Module resolution (bun uses its own loader)
- Stack frame format
- `instanceof` semantics
- `Error.captureStackTrace` support

These affect the migration plan (especially R6 stack traces and R3 `vi.mock` patterns). The plan treats bun as a black box.

**Severity: minor.** Document bun-specific test patterns in R3 / R6.

---

## Net assessment

The plan's keystone thesis is correct:
- The `db.ts` singleton is the single biggest refactor target and converting it to entity stores is the right move.
- The lazy-cache singletons (`agent.ts`, `google-api.ts`, `graph-mail.ts`, `platform.ts`) are clean class candidates.
- The `ChannelProvider` sealed hierarchy is the textbook class conversion in the codebase.
- Process lock classes (`PortLockAcquirer`, `PidfileLockAcquirer`) are already 80% class-shaped.

But the plan is over-prescribed on type-side (sealed-class hierarchies for 3-member unions, generics with single consumers) and under-prescribed on inventory (8 missed class declarations, `web/federation/` subdirectory, per-file blast radius).

**Recommendation: ACCEPT-WITH-EDITS.** Specifically:

**Drop before executing:**
- D1, D2, D3, D4 sealed-class hierarchies (OE-1, OE-2, OE-3, OE-4) — pure ceremony
- G2 (`TtlCache<K, V>`) — reuse `RemoteStatusCache<T>` instead (CE-9)
- G3 (`RetryQueue<TRow>`) — single consumer (OE-6)
- G6 (`BaseRunner<TFacts, TDecision>`) — most runners don't have facts→decision shape (OE-5)
- G8 (`App.getStore<K>`) — direct field access is sufficient (OE-9)
- A10 `SettingsRegistry.define`/`undefine` (OE-8)

**Add before executing:**
- Fix inventory: 9 classes (not 2), include `RemoteStatusCache<T>` (CE-1)
- Add `web/federation/` subdirectory inventory (CE-2)
- Add R11 (route handler migration, 44 files) (CE-3)
- Add error class design section (CE-4)
- Add per-test factory design (CE-5 + CE-15)
- Add atomic-write treatment decision (CE-6)
- Separate `web/heartbeat-agent-scaffold.ts` from runner list (CE-7)
- Add Phase 7 construction-order table (CE-8)
- Add Phase 8 grep checklist (CE-10)
- Add per-store blast-radius table to Phase 6 (CE-11)

**Verify before executing:**
- ~200 free functions count in `db.ts` (CE-16)
- `BasePaneWatcher` ~120-line duplication figure (OE-7)
- Source map / `Error.captureStackTrace` current state (CE-12)
