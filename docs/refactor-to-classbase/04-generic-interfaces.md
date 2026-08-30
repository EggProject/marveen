# Generic Interfaces

For each new generic interface to introduce: name, type parameters +
constraints, variance notes, signature-level usage example, and the
files that would adopt it (with a brief reason each).

Variance convention used below: **covariant** = output position only,
**contravariant** = input position only, **invariant** = both. TypeScript
uses `out` and `in` annotations for `strictFunctionTypes` mode; the
constraints here describe the *intended* variance regardless of whether
the compiler can prove it.

---

## G1. `BasePaneWatcher<TState, TThresholds>`

The shared abstract base for the three pane-recovery watchers
(`PaneErrorAlertWatcher`, `StuckInputRecoveryWatcher`,
`StuckToolCallRecoveryWatcher`).

### Definition (signature only)

```ts
abstract class BasePaneWatcher<TState, TThresholds> {
  abstract readonly NO_STATE: TState
  abstract step(
    observation: unknown,
    prev: TState,
    now: number,
    thresholds: TThresholds,
  ): { act: boolean; next: TState }
  protected spellStartGate(now: number, lastSpellStart: number, thresholdMs: number): boolean
  protected clockSkewGuard(now: number, prevNow: number): boolean
  protected retryBudgetGuard(attempts: number, maxAttempts: number): boolean
  protected confirmDedup(seen: boolean, cooldownMs: number, now: number, lastFire: number): boolean
}
```

### Type parameters

- `TState` — invariant. Subclass `NO_STATE` (a literal default value
  used as the initial accumulator) and the `next: TState` return
  position form a use-site where the type flows both ways; making it
  covariant would break the `NO_STATE` field initialization in
  subclasses, making it contravariant would break the return type
  in `step`.
- `TThresholds` — invariant. Read-only at the `step` call site but
  shared with the runner that decides whether to call `step` again,
  so the type must be identical across the call boundary.

### Variance notes

The `step` method's `TState` parameter (`prev: TState`) is
contravariant by position, and the `next: TState` return is covariant;
because the same type parameter is used in both positions, `TState` is
**invariant**. Same logic applies to `TThresholds` (read at the call
site, mutated externally by the runner's threshold-updating logic).

### Usage example (signature only)

```ts
class StuckInputRecoveryWatcher extends BasePaneWatcher<StuckInputState, StuckInputThresholds> {
  readonly NO_STATE: StuckInputState = { /* initial accumulator */ }
  step(observation, prev, now, thresholds): { act: boolean; next: StuckInputState } { /* ... */ }
}
```

### Adopters

- `src/pane-state.ts` — consolidates the duplicated spell-start /
  clock-skew / retry-budget / confirm-dedup gates across the three
  `decide*` functions. Reason: ~120 lines of pure-logic duplication
  per `02-type-interface-analysis.md` Section G1.
- `src/web/stuck-input-watcher.ts` — instantiates
  `StuckInputRecoveryWatcher`. Reason: currently calls
  `decideStuckInputRecovery` as a free function with the threshold
  bag passed positionally.
- `src/web/stuck-tool-call-watcher.ts` — instantiates
  `StuckToolCallRecoveryWatcher`. Reason: same as above.
- `src/web/agent-process.ts` — instantiates `PaneErrorAlertWatcher`.
  Reason: same as above (consumed via the `web/agent-process.ts`
  pane-state polling).
- `src/web/schedule-runner.ts` — uses `PaneState` (read-only) for
  scheduling decisions. Reason: the generic parameter on the base
  class makes the runner's threshold reads type-safe.

---

## G2. `TtlCache<K, V>`

Typed TTL cache extracted from `db.ts:1238-1274`. The current shape is
a `Map<string, MemoryCacheEntry>` plus three helper functions
(`memoryCacheGet`, `memoryCacheSet`, `memoryCacheInvalidate`).

### Definition (signature only)

```ts
class TtlCache<K extends string, V> {
  constructor(private ttlMs: number, private clock: () => number = Date.now) {}
  get(key: K): V | null
  set(key: K, value: V): void
  invalidatePrefix(prefix: K): number
  clear(): void
  size(): number
}
```

### Type parameters

- `K extends string` — the cache key must be a string (the existing
  `memoryCache` keys are `"<agentId>:<memoryKey>"` shape; the prefix
  invalidation idiom is the dominant access pattern). Making the
  bound `string` enables the `invalidatePrefix(prefix: K)` method to
  type-check at call sites.
- `V` — invariant. Stored in the map, returned from `get`, passed
  into `set`. No variance.

### Variance notes

`K` is covariant only insofar as `string` is a wider type — but the
class treats keys as opaque (no `+` or output positions), so `K` is
effectively **invariant** in practice. `V` is invariant (storage +
return).

### Usage example (signature only)

```ts
type MemoryCacheEntry = { value: Memory; expiresAt: number }
const memoryCache = new TtlCache<string, MemoryCacheEntry>(60_000)
memoryCache.invalidatePrefix(`${agentId}:`)
```

### Adopters

- `src/db.ts` (becomes `MemoryStore`) — replaces the module-level
  `memoryCache` Map + the three helpers + `MEMORY_CACHE_TTL_MS`
  constant. Reason: the cache's "invalidate all keys starting with
  `<agentId>:`" idiom at `db.ts:1274` is the only consumer today
  but a typed container is more discoverable than a `Map`.
- `src/__tests__/db.test.ts` (and any test that touches
  `getMemoryCacheSize` / `clearMemoryCache`) — the `size()` and
  `clear()` methods replace the test-only exports.
- (Future, not in scope) any cache for `vault-key-cache` if the
  SSH vault gains one — explicitly listed as the motivation in
  `02-type-interface-analysis.md` Section G2.

---

## G3. `RetryQueue<TRow>`

Typed retry-queue with alert policy, extracted from `pending-retries.ts`
+ `db.ts:2339-2423`.

### Definition (signature only)

```ts
class RetryQueue<TRow extends { first_attempt: number; alert_sent_at: number | null }> {
  shouldAlert(row: TRow, now: number, thresholdMs: number): boolean
  markAlerted(row: TRow, ts: number): { first_attempt: number; alert_sent_at: number | null }
  classifyFailure(errMessage: string): 'transient' | 'permanent'
}
```

### Type parameters

- `TRow` — constrained to the minimal shape needed by
  `shouldAlert` and `markAlerted`. Invariant: the same row type is
  read (`shouldAlert`) and constructed (`markAlerted` returns the
  updated row).

### Variance notes

`TRow` is invariant — used in both input and output positions.

### Usage example (signature only)

```ts
const queue = new RetryQueue<PendingTaskRetryRow>()
if (queue.shouldAlert(row, Date.now(), 5 * 60_000)) {
  await db.updateRetryRow(queue.markAlerted(row, Date.now()))
}
```

### Adopters

- `src/db.ts` (becomes `Scheduler`) — the `alertIfDue` and
  `markAlerted` methods (see A4 above) own this logic; the class
  is the typed wrapper that `Scheduler` delegates to. Reason:
  `shouldSendAlert` + `classifyTelegramSendError` in
  `pending-retries.ts` are currently free functions; the typed
  container makes the threshold parameter part of the type
  signature.
- `src/web/schedule-runner.ts` — calls `queue.shouldAlert` per
  tick. Reason: type-safe row shape (no `as` cast at the boundary).
- `src/pending-retries.ts` (kept as utility) — `classifyFailure`
  is promoted to a method on the class; the existing exports
  become thin re-exports for backward compatibility during
  migration.

---

## G4. `SettingsStore` (current scope, non-generic) and future
`SettingsStore<TOverrides>` (deferred)

The current conversion is non-generic (`SettingsStore` per A11); a
future generic version is sketched in `02-type-interface-analysis.md`
Section G4 but explicitly deferred.

### Current (in-scope)

`SettingsStore` is non-generic; the `Record<string, string | number>`
type lives on a private field and the public methods are typed
against `string` keys. See A11 in `03-class-boundaries.md`.

### Future (out of scope, sketched)

```ts
class SettingsStore<TOverrides extends Record<string, string | number | boolean>> {
  constructor(private registry: SettingDefinition[]) {}
  get<K extends keyof TOverrides & string>(key: K): TOverrides[K] | undefined
  set<K extends keyof TOverrides & string>(key: K, raw: TOverrides[K]): SetOverrideResult
  invalidate(): void
}
```

The deferred version eliminates the `Record<string, string | number>`
untyped cache and makes the override shape a compile-time parameter.
Reason for deferral: the existing `SETTINGS_REGISTRY` covers ~35 keys
and adding a generic parameter to the store touches every consumer
without functional benefit at the current call sites.

---

## G5. `LoggerLike` (interface, not class)

A unifying interface alias for the per-module `LogFn` re-definitions.
The `LogFn` type appears at `src/process-lock.ts:19` and is
duplicated as `{ info(obj, msg?), warn, error }` shape in
`ProcessLockContext` and `PidfileLockContext`.

### Definition (signature only)

```ts
import type { Logger } from 'pino'
type LoggerLike = Logger
```

### Type parameters

None — this is a re-alias of the pino `Logger` interface.

### Variance notes

N/A — alias only.

### Usage example (signature only)

```ts
import type { LoggerLike } from './logger.js'
class PortLockAcquirer {
  constructor(private ctx: { log: LoggerLike; /* ... */ }) {}
}
```

### Adopters

- `src/process-lock.ts` — replaces the `LogFn` type alias at line 19
  and the `{ info, warn, error }` shape on `ProcessLockContext`
  (line 26) and `PidfileLockContext` (line 226). Reason: the
  duplicated shape blocks constructor injection of a real pino
  logger.
- `src/logger.ts` — already exports `logger: Logger`; the alias is
  a no-op for this file.
- Every new class in `03-class-boundaries.md` that takes a logger
  in its constructor (A1, A3, A4, A6, A8, A10, A11, A12, B1, B2,
  B3, B5, C2, C3, D1, E1, E2). Reason: eliminates the per-class
  `LogFn` re-definition.

---

## G6. `BaseRunner<TFacts, TDecision>`

Shared shape for the ~20 `start*()` runner functions in `web/`. The
current shape is duplicated: each runner sets up a timer / interval
/ `fs.watch` handle and exposes a `tick()` method implicitly.

### Definition (signature only)

```ts
abstract class BaseRunner<TFacts, TDecision> {
  protected abstract readonly intervalMs: number
  protected abstract tick(facts: TFacts): Promise<TDecision>
  protected apply(decision: TDecision): Promise<void>
  start(): void
  stop(): void
}
```

### Type parameters

- `TFacts` — covariant. Subclass `tick()` returns `TDecision`; the
  runner only reads the facts inside `tick`, never returns them, so
  `TFacts` is in input position only (contravariant) — but
  TypeScript's default variance for class type parameters is
  invariant; the `out` annotation is not needed for the abstract
  class shape because the parameter is only used in method input
  positions.
- `TDecision` — covariant. The decision flows from `tick` to
  `apply`; it's only in output position.

### Variance notes

Per `strictFunctionTypes`, `TFacts` should be annotated `in` if used
in input position only; `TDecision` should be `out` if used in output
position only. In practice, marking either with variance annotations
forces the abstract `tick` signature into a particular shape that may
not match the subclass's natural typing; the conservative choice is
to leave both invariant.

### Usage example (signature only)

```ts
class MessageRouter extends BaseRunner<MessageFacts, MessageDecision> {
  protected readonly intervalMs = 1000
  protected async tick(facts: MessageFacts): Promise<MessageDecision> { /* ... */ }
  protected async apply(decision: MessageDecision): Promise<void> { /* ... */ }
}
```

### Adopters

All `web/*Runner` classes listed in B5 of `03-class-boundaries.md`:
- `src/web/message-router.ts` — current `startMessageRouter()` is a
  free function; the runner becomes a class. Reason: per
  `01-module-state-analysis.md` Section 6.4, this is the dominant
  pattern in `web/`.
- `src/web/schedule-runner.ts` — same shape.
- `src/web/channel-monitor.ts` — same.
- `src/web/inbound-prober.ts` — same.
- `src/web/channel-health-monitor.ts` — same.
- `src/web/stuck-input-watcher.ts` — same; *also* uses
  `StuckInputRecoveryWatcher` from G1.
- `src/web/inbox-nudge-watcher.ts` — same.
- `src/web/stuck-tool-call-watcher.ts` — same; *also* uses
  `StuckToolCallRecoveryWatcher` from G1.
- `src/web/reauth-healer.ts` — same.
- `src/web/auto-restart-runner.ts` — same; depends on `Scheduler`.
- `src/web/model-fallback-runner.ts` — same.
- `src/web/context-guard-runner.ts` — same; depends on
  `context-guard.ts` decision functions.
- `src/web/update-checker.ts` — same; depends on `update-preflight.ts`.
- `src/web/federation-poller.ts` — same.
- `src/web/capability-summary-runner.ts` — same.
- `src/web/invite-monitor.ts` — same.
- `src/web/channel-request-watcher.ts` — same.
- `src/web/costs-sync-task.ts` — same.
- `src/web/approval-timeout-sweeper.ts` — same; depends on
  `ApprovalStore`.

---

## G7. `LazyBin<TName>`

Generic version of `makeLazyBinResolver` at `platform.ts:74`.

### Definition (signature only)

```ts
class LazyBin<TName extends string> {
  constructor(private name: TName, private opts: { resolver?: (n: TName) => string | null } = {}) {}
  resolve(): string | null
  invalidate(): void
}
```

### Type parameters

- `TName extends string` — the binary name; constrained to `string`
  to ensure `name` is a sensible map key.

### Variance notes

`TName` is invariant — used in constructor (input) and as a key for
internal storage (output via `resolve()` indirectly via `process.env`).

### Usage example (signature only)

```ts
const claudeBin = new LazyBin('claude')
const codeBin = new LazyBin('code')
claudeBin.resolve() // -> string | null
```

### Adopters

- `src/agent.ts` — the `ClaudeCodeBinResolver` (C1) is a more
  specialized version that probes filesystem paths; `LazyBin` is
  the underlying shape. Reason: the `makeLazyBinResolver` factory
  returns a closure; the class form is a literal translation.
- `src/platform.ts` — replaces `PLATFORM` singleton at line 74
  plus the `tryResolveFromPath` / `resolveFromPath` pure helpers.
  Reason: the closure factory pattern is the smallest classbase
  refactor in the codebase (per `01-module-state-analysis.md`
  Section 4.3).
- (Future, not in scope) `src/web/agent-process.ts` if it gains
  its own binary probing.

---

## G8. `App.getStore<K>` (typed store accessor)

The `App` class exposes entity stores via a typed accessor map.

### Definition (signature only)

```ts
type StoreName =
  | 'memoryStore'
  | 'kanbanCards'
  | 'messageBus'
  | 'scheduler'
  | 'backgroundTaskPool'
  | 'approvalStore'
  | 'spanStore'
  | 'ideaStore'
  | 'sshVault'
  | 'settingsStore'
  | 'channelProviderRegistry'

type StoreFor<K extends StoreName> =
  K extends 'memoryStore' ? MemoryStore :
  K extends 'kanbanCards' ? KanbanCards :
  K extends 'messageBus' ? MessageBus :
  K extends 'scheduler' ? Scheduler :
  K extends 'backgroundTaskPool' ? BackgroundTaskPool :
  K extends 'approvalStore' ? ApprovalStore :
  K extends 'spanStore' ? SpanStore :
  K extends 'ideaStore' ? IdeaStore :
  K extends 'sshVault' ? SshVault :
  K extends 'settingsStore' ? SettingsStore :
  K extends 'channelProviderRegistry' ? ChannelProviderRegistry :
  never

class App {
  getStore<K extends StoreName>(name: K): StoreFor<K>
}
```

### Type parameters

- `K extends StoreName` — the store name as a string literal; the
  `StoreFor<K>` mapped type ties the literal to the concrete class.
  Invariant.

### Variance notes

`K` is invariant (string literal union used as both the input key and
the discriminator in the mapped type return). `StoreFor<K>` is a
compile-time conditional; runtime is a plain map lookup.

### Usage example (signature only)

```ts
const memoryStore = app.getStore('memoryStore') // -> MemoryStore
const kanbanCards = app.getStore('kanbanCards') // -> KanbanCards
```

### Adopters

- `src/index.ts` (becomes `App`) — the only owner of the
  constructor. Reason: replaces the ~10 module-level `let` bindings
  with typed instance fields.
- `src/web/*` — every route handler and runner that needs an entity
  store takes it via the `App` instance passed in `RouteContext`
  (or via direct injection in the runner constructors per B5).
  Reason: type-safe accessor at the call site; no `as` cast needed.
- `src/__tests__/integration/*` — test scaffolding constructs a
  test `App` and calls `getStore` to retrieve per-test instances.

---

## D1. `AuthContext` sealed hierarchy (discriminated-union replacement)

Replaces the `auth.kind === 'token' ? { kind: 'token' as const } : ...`
ternary chain at `web.ts:155-159`.

### Definition (signature only)

```ts
abstract class AuthContext {
  abstract readonly kind: 'token' | 'device' | 'session' | 'federation'
}
class TokenAuth extends AuthContext {
  readonly kind = 'token' as const
}
class DeviceAuth extends AuthContext {
  readonly kind = 'device' as const
  constructor(public readonly device: DeviceRow) { super() }
}
class SessionAuth extends AuthContext {
  readonly kind = 'session' as const
  constructor(public readonly user: DashboardUserPublic) { super() }
}
class FederationAuth extends AuthContext {
  readonly kind = 'federation' as const
  constructor(public readonly peer: string) { super() }
}
```

### Type parameters

None.

### Variance notes

N/A — no generic parameters.

### Usage example (signature only)

```ts
function projectAuth(auth: AuthContext): RouteAuth {
  switch (auth.kind) {
    case 'token': return new TokenAuth()
    case 'device': return new DeviceAuth(auth.device)
    case 'session': return new SessionAuth(auth.user)
    case 'federation': return new FederationAuth(auth.peer)
  }
}
```

### Adopters

- `src/web.ts` (becomes `DashboardServer`) — the consumer of the
  union; the `authContext` method (B6) returns an `AuthContext`
  instance. Reason: eliminates the `as const` chain in
  `web.ts:155-159`.
- `src/web/auth-gate.ts` — the source union lives here; the gate
  function returns an `AuthContext` directly (the existing
  `AuthResult` union becomes a thin re-export during migration).
  Reason: the gate is the natural factory for the sealed hierarchy.
- `src/web/routes/*` — every gated route receives a
  `ctx.auth: AuthContext`; the per-kind payload is accessed via the
  subclass property (`auth.user`, `auth.device`, etc.). Reason:
  type-safe access without `as` casts.
- `src/__tests__/web/*.test.ts` — tests that mock `auth-gate.js`
  switch to constructing `AuthContext` subclasses directly.

---

## D2. `ModelAction` sealed hierarchy (discriminated-union replacement)

Replaces `type ModelAction` at `model-fallback.ts:115`.

### Definition (signature only)

```ts
abstract class ModelAction { abstract readonly kind: string }
class NoAction extends ModelAction { readonly kind = 'none' as const }
class DowngradeAction extends ModelAction {
  readonly kind = 'downgrade' as const
  constructor(public readonly model: string) { super() }
}
class RevertAction extends ModelAction {
  readonly kind = 'revert' as const
  constructor(public readonly model: string) { super() }
}
```

### Type parameters

None.

### Variance notes

N/A.

### Usage example (signature only)

```ts
const action = decideModelAction(facts)
switch (action.kind) {
  case 'none': break
  case 'downgrade': applyDowngrade(action.model); break
  case 'revert': applyRevert(action.model); break
}
```

### Adopters

- `src/model-fallback.ts` — `decideModelAction` returns a
  `ModelAction` instance. Reason: matches the codebase's
  `{ kind, ...payload }` idiom (see `PaneErrorAlertDecision`,
  `StuckInputDecision`).
- `src/web/model-fallback-runner.ts` — `switch (action.kind)`
  consumes the instance. Reason: no functional change at runtime;
  the sealed class makes adding a new action kind a compile-time
  check.

---

## D3. `SubmitFollowupAction` / `StuckInputAction` sealed hierarchies

Replaces `type SubmitFollowupAction` at `pane-state.ts:900` and
`type StuckInputAction` at `pane-state.ts:1373`.

### Definition (signature only)

```ts
abstract class PaneAction { abstract readonly kind: string }
class NoPaneAction extends PaneAction { readonly kind = 'none' as const }
class InjectResumePaneAction extends PaneAction {
  readonly kind = 'inject-resume' as const
  constructor(public readonly text: string) { super() }
}
class RestartPaneAction extends PaneAction {
  readonly kind = 'restart' as const
  constructor(public readonly reason: string) { super() }
}
class AlertPaneAction extends PaneAction {
  readonly kind = 'alert' as const
  constructor(public readonly message: string) { super() }
}
```

### Type parameters

None.

### Variance notes

N/A.

### Usage example (signature only)

```ts
const action = decideSubmitFollowup(facts)
if (action instanceof AlertPaneAction) { await notify(action.message) }
```

### Adopters

- `src/pane-state.ts` — `decideSubmitFollowup` (`pane-state.ts:940`)
  and `decideStuckInputAction` (`pane-state.ts:1417`) return sealed
  instances. Reason: consistent with D2 and D4; future-proofs
  adding new recovery actions.
- `src/web/agent-process.ts` — consumer; the existing `switch`
  on the union's `kind` tag becomes a `switch` on the sealed
  class's `kind` field with the same semantics.

---

## D4. `SpanStatus` sealed hierarchy (discriminated-union replacement)

Replaces `OtelSpan['status']` at `db.ts:3247`.

### Definition (signature only)

```ts
abstract class SpanStatus { abstract readonly value: 'ok' | 'error' | 'timeout' | 'running' }
class OkSpan extends SpanStatus { readonly value = 'ok' as const }
class ErrorSpan extends SpanStatus {
  readonly value = 'error' as const
  constructor(public readonly message: string) { super() }
}
class TimeoutSpan extends SpanStatus {
  readonly value = 'timeout' as const
  constructor(public readonly deadlineMs: number) { super() }
}
class RunningSpan extends SpanStatus { readonly value = 'running' as const }
```

### Type parameters

None.

### Variance notes

N/A.

### Usage example (signature only)

```ts
const status = new ErrorSpan(err.message)
spanStore.closeSpan(traceId, spanId, status)
```

### Adopters

- `src/db.ts` (becomes `SpanStore`) — the `closeSpan` method takes
  a `SpanStatus` instance. Reason: makes the "running → ok/error/
  timeout" transition explicit at the call site.
- `src/web/routes/spans.ts` — the waterfall UI joins + groups
  spans by status. Reason: no `as` cast at the SQL-to-status
  boundary.

---

## D5 / D6 / D7. Lower-priority sealed hierarchies (deferred)

Per `02-type-interface-analysis.md` Section D5–D7, the following are
**kept as type aliases** (the sealed-class route is reserved for
entities that own behavior):

- `PreflightResult` / `ConcurrencyResult` (`update-preflight.ts:46-50`)
- `ModelProfileMapState` (`model-profiles.ts:38`)
- `MergeAction` (`remote-enroll-core.ts:170`)

Reason for deferral: each is consumed at exactly one call site; the
sealed-class route adds ceremony without behavior change.

---

## Summary table

| ID | Name | Generics | Status |
|---|---|---|---|
| G1 | `BasePaneWatcher<TState, TThresholds>` | 2 invariant | In scope (Phase 4) |
| G2 | `TtlCache<K, V>` | 1 invariant + 1 string-bound | In scope (Phase 6) |
| G3 | `RetryQueue<TRow>` | 1 constrained invariant | In scope (Phase 6) |
| G4 | `SettingsStore<TOverrides>` | 1 mapped | Deferred (future) |
| G5 | `LoggerLike` | alias only | In scope (Phase 1) |
| G6 | `BaseRunner<TFacts, TDecision>` | 2 invariant | In scope (Phase 5) |
| G7 | `LazyBin<TName>` | 1 string-bound | In scope (Phase 3) |
| G8 | `App.getStore<K>` | 1 string-literal union + mapped | In scope (Phase 7) |
| D1 | `AuthContext` sealed | none | In scope (Phase 7) |
| D2 | `ModelAction` sealed | none | In scope (Phase 4) |
| D3 | `PaneAction` sealed | none | In scope (Phase 4) |
| D4 | `SpanStatus` sealed | none | In scope (Phase 6) |
| D5 | `PreflightResult` | n/a | Deferred |
| D6 | `ModelProfileMapState` | n/a | Deferred |
| D7 | `MergeAction` | n/a | Deferred |
