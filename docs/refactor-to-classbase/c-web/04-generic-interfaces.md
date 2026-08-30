# C (web) — Generic interfaces

New generic interfaces proposed for the C subsystem. Each section:
(1) sketch, (2) consumer-count justification, (3) verdict (introduce
or drop). Cross-references:
`review-completeness.md OE-5` (BaseRunner rejected), `OE-6`
(single-consumer generics rejected), `OE-9` (App.getStore<K> rejected),
`CE-9` (RemoteStatusCache<T> reuse), plus the
`e-process-lock/00-summary.md` precedent (E's class candidates are
non-generic).

**Reading note.** C proposes **3 generics sketches** below
(`DashboardServer<TConfig>`, `AuthGate<TContext>`,
`RouteHandler<TParams, TResponse>`) — **all 3 are REJECTED** per
`review-completeness.md OE-6` (single-consumer rejection). The
existing `RemoteStatusCache<T>` (per `review-completeness.md CE-9`)
is reused as-is. `BaseRunner<TFacts, TDecision>` is REJECTED per
`review-completeness.md OE-5`. The C subsystem does NOT introduce any
new generic interface.

---

## §C1. `DashboardServer<TConfig>` — REJECTED (OE-6 pattern)

### Proposed sketch (DO NOT IMPLEMENT)

```ts
class DashboardServer<TConfig extends Config = Config> {
  constructor(private readonly deps: { config: TConfig; log: LoggerLike; port?: number })
  start(): http.Server
  stop(): Promise<void>
}
```

### Consumer count

**1** — `index.ts:451` (the only production caller). `index.ts` will
construct `new DashboardServer({ config: defaultConfig, log: logger })`
exactly once.

### Verdict: **DROP.**

Per `review-completeness.md OE-6`: "a generic with one consumer is
ceremony." The `TConfig` parameter adds:
- A covariant constructor type parameter (TConfig is consumed in
  readonly field position).
- A type assertion site at the consumer (`defaultConfig: Config`
  satisfies `TConfig = Config` — verbose for zero benefit).
- ZERO compile-time benefit.

The `Config` class (B.1) is the single source of truth for
configuration. `DashboardServer` reads from it via the `deps.config`
field; parameterising the class adds nothing.

### Source reference

- `src/web.ts:6` — the 5-field `import { WEB_HOST, WEB_PORT,
  DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID }
  from './config.js'`. After B.1 + C.2: `deps.config.WEB_HOST` etc.
- `index.ts:451` — the only `startWebServer(port)` call site.

---

## §C2. `AuthGate<TContext>` — REJECTED (OE-6 pattern)

### Proposed sketch (DO NOT IMPLEMENT)

```ts
class AuthGate<TContext extends RouteContext = RouteContext> {
  constructor(private readonly deps: { config: Config; env: ChannelEnv; log: LoggerLike })
  resolveAuth(req: http.IncomingMessage, url: URL, path: string, method: string): AuthResult
  getRouteContextAuth(auth: AuthResult): TContext['auth']  // would be RouteContext['auth']
}
```

### Consumer count

**1** — `DashboardServer` (C.2) holds the single `AuthGate`
instance. No route file imports `AuthGate` directly (per
`02-type-interface-analysis.md §3.2`, only `auth.ts:9` and
`security.ts:2` consume `ctx.auth`, and they receive it via
`RouteContext` not `AuthGate`).

### Verdict: **DROP.**

Per `review-completeness.md OE-6`: single consumer. The
`getRouteContextAuth` return type is structurally pinned to
`RouteContext['auth']` (the 4-arm literal-union at
`routes/types.ts:24`); parameterising over `TContext` would let
callers substitute a different `auth` shape, but no caller does.

### Source reference

- `src/web/auth-gate.ts:29-34` — the 5-arm `AuthResult` union.
- `src/web/auth-gate.ts:76-121` — `resolveAuth`.
- `src/web.ts:154-159` — the `ctxAuth` ternary (4-arm projection).
- `src/web/routes/types.ts:24` — `RouteContext['auth']`.

---

## §C3. `RouteHandler<TParams, TResponse>` — REJECTED (OE-6 pattern + E precedent)

### Proposed sketch (DO NOT IMPLEMENT)

```ts
type RouteHandler<TParams = unknown, TResponse = unknown> =
  (ctx: RouteContext & { params: TParams }) => Promise<{ handled: true; body: TResponse } | { handled: false }>
```

### Consumer count

**44** — every route handler in `src/web/routes/` would adopt this
shape. BUT: the 44 handlers today all return `Promise<boolean>` (the
`handled: true` semantics), and the response body is written inline
via `json(res, body, status)` from `http-helpers.ts:56-65`. The
`TResponse` parameter would require routing the response body through
the return type instead of side-effecting on `res`, which is a
behavior change — not a refactor.

### Verdict: **DROP.**

Per `e-process-lock/00-summary.md` precedent (the E subsystem
considered similar generics and rejected them), AND per
`review-completeness.md OE-6`: the generic adds ceremony for zero
benefit. The current `RouteHandler = (ctx) => Promise<boolean>` shape
at `routes/types.ts:27` is correct: handlers write to `res` directly
and return whether they handled the request.

If a future refactor wants typed request params (e.g. via path-pattern
parsing), it should land as a SEPARATE `RouteParams<T>` extractor,
not a `RouteHandler<TParams, TResponse>` shape change.

### Source reference

- `src/web/routes/types.ts:27` — `export type RouteHandler = (ctx:
  RouteContext) => Promise<boolean>`.
- `src/web/http-helpers.ts:56-65` — `json(res, data, status)`.

---

## §C4. `BaseRunner<TFacts, TDecision>` — REJECTED (OE-5, framework DROPPED)

### Framework proposal (from `04-generic-interfaces.md` G6)

```ts
abstract class BaseRunner<TFacts, TDecision> {
  protected abstract readonly intervalMs: number
  protected abstract tick(facts: TFacts): Promise<TDecision>
  protected apply(decision: TDecision): Promise<void>
  start(): void
  stop(): void
}
```

### Verdict: **DO NOT REINTRODUCE.**

Per `review-completeness.md OE-5`: "most runners don't have facts→
decision shape. They're `tick → side effects` shaped (read fs, read
db, emit a notification, schedule a sweep). The `apply(decision)`
method has no semantic content for runners that have no decision."

The 19 web runners enumerated in
`c-web/03-class-boundaries.md §C3` are heterogeneous:
- `MessageRouterRunner`: tick reads inbound queue, side-effects on
  agent process. No `facts → decision` shape.
- `StuckInputWatcherRunner`: tick reads pane state, side-effects a
  restart. No `TDecision`.
- `FederationPollerRunner`: tick fetches peer manifest, updates
  `statusCache`. No `TDecision`.
- `ApprovalTimeoutSweeperRunner`: tick calls
  `approvalStore.sweepExpired(now)`. No `TFacts` or `TDecision`.

Forcing `BaseRunner<F, D>` on these requires picking arbitrary types
like `BaseRunner<number, void>` — pure ceremony.

### Per-reviewer count

Per `review-completeness.md OE-5`: at most 3-4 of the 19 runners
could plausibly use a `facts → decision` shape (`MessageRouter`,
`AutoRestartRunner`, `ModelFallbackRunner`, `ContextGuardRunner`),
but the others (15) don't fit. The abstraction cost (an interface
that 80% of runners don't use) outweighs the dedup gain.

### Verdict: **DROP. Keep the 19 runners as independent classes with
`start()` / `stop()` methods, no shared base.**

### Source reference

- `src/web/message-router.ts:277` — `startMessageRouter()`.
- `src/web/auto-restart-runner.ts:149` —
  `startAutoRestartRunner()`.
- `src/web/model-fallback-runner.ts:143` —
  `startModelFallbackRunner()`.
- `src/web/context-guard-runner.ts:336` —
  `startContextGuardRunner()`.
- `src/web/stuck-input-watcher.ts:227` — `startStuckInputWatcher()`.
- (15 others — see
  `c-web/03-class-boundaries.md §C3` for the full list).

---

## §C5. `RemoteStatusCache<T>` reuse — DEFERRED (CE-9 cross-cutting)

Per `review-completeness.md CE-9`, the existing
`web/remote-status-cache.ts:19` `RemoteStatusCache<T>` class is the
precedent for a generic TTL cache. CE-9 asks whether `MemoryCache` (in
`db.ts:1238-1274`) could subsume the federation poller cache
(`poller.ts:59`).

### C verdict: **NOT IN SCOPE.**

Per `02-type-interface-analysis.md §8.3`: "`statusCache` is NOT a TTL
cache — it's a stale-retain cache (a peer's last known manifest is
KEPT on transient network failure, per the `state: PeerPollState`
enum at `poller.ts:39`). `RemoteStatusCache<T>` is per-call TTL
(`getOrRefresh(key, nowMs, ...)`), which is a different semantic. The
two are NOT substitutable."

CE-9 is a cross-cutting C+E question that belongs in the H-tier
resolution, not in C-local planning.

### Source reference

- `src/web/remote-status-cache.ts:19` — `class RemoteStatusCache<T>`.
- `src/web/federation/poller.ts:59` — `const statusCache = new
  Map<string, PeerStatus>()`.
- `src/web/federation/poller.ts:39` — `type PeerPollState = 'ok' |
  'auth-or-disabled' | 'error' | 'unreachable' | 'unpaired' |
  'unknown'` (6 values, indicating stale-retain semantics).

---

## §C6. `TtlCache<K, V>` — REJECTED (CE-9 + OE-6)

Per `review-completeness.md CE-9` and `OE-6`, the proposed
`TtlCache<K, V>` for the federation poller cache is REJECTED:

1. **Single consumer**: only `poller.ts:59` would adopt it (CE-9
   verdict: NOT substitutable for the stale-retain cache).
2. **Existing alternative**: `RemoteStatusCache<T>` already exists
   with the right shape for the 2 known use cases
   (`web/routes/agents.ts:204-205` and possibly the memory cache in
   `db.ts:1238`).
3. **Generic constraint noise**: `TtlCache<K extends string, V>`
   adds the `K extends string` constraint that the
   `MemoryCache`/`RemoteStatusCache` use cases don't need.

### Verdict: **DROP. Reuse `RemoteStatusCache<T>` if a future need
arises; do not introduce a parallel `TtlCache<K, V>` abstraction.**

### Source reference

- `src/web/remote-status-cache.ts:19` — existing class.
- `src/db.ts:1238-1274` — the memory cache (per
  `a-db/00-summary.md` A.9, this is the cross-cutting reuse candidate,
  not the federation poller cache).

---

## §C7. `LoggerLike` (H-tier) — apply line-by-line across C

H.1 (`docs/refactor-to-classbase/h-cross-cutting/04-generic-interfaces.md`
§L) is non-generic and applies to every logger reference. After
H.1 lands, C's `logger` import sites become constructor-injected
`LoggerLike`.

### Per-file line counts (per `02-type-interface-analysis.md §10`)

| File bucket | `logger.X` calls | Notes |
|---|---:|---|
| `src/web.ts` | 50 | All inside `startWebServer` closure. After class: `this.log.X`. |
| `src/web/routes/*.ts` | 159 | Spread across 44 files; some have 0 (e.g. `daily-log.ts`), some have 10+ (e.g. `approvals.ts`, `agents.ts`). |
| `src/web/federation/*.ts` | 12 | Concentrated in `config.ts` (8), `poller.ts` (3), `capability-runner.ts` (1). |
| **Total C** | **221** | Every site is the module-level `logger.info/warn/error/debug` call. |

### Conversion mechanism (additive)

- **Phase 1 (H.1)**: add `LoggerLike` to `src/logger.ts`.
- **Phase C.1–C.7**: `AuthGate`, `DashboardServer`, the 19 runners,
  the 9 federation cluster classes take `log: LoggerLike` in their
  constructor.
- **Phase C.8 (test rewrite)**: test code provides a `LoggerLike`
  via a `createTestLogger()` factory (per
  `review-completeness.md CE-5`).
- **No source-code replacement**: the 221 `logger.<level>(` calls
  stay as `this.log.<level>(` (or `log.<level>(`) — the rename
  happens mechanically in the class body.

### Verdict: **ADOPT.** No new interface — `LoggerLike` is the H-tier
interface; C is a consumer.

### Source reference

- `src/logger.ts:3-9` — the pino singleton (H.1 keeps it, adds
  `LoggerLike` alongside).
- `src/web.ts:32` — `import { logger } from './logger.js'`.
- `src/web/routes/*.ts` — 159 `logger.<level>(` call sites.

---

## §C8. Per-class generic interface summary

| Proposed interface | Verdict | Reason |
|---|---|---|
| `DashboardServer<TConfig>` | DROP | OE-6: single consumer (`index.ts:451`). |
| `AuthGate<TContext>` | DROP | OE-6: single consumer (`DashboardServer`). |
| `RouteHandler<TParams, TResponse>` | DROP | OE-6 + E precedent: 44 consumers but the response body is side-effected via `res`, not returned. |
| `BaseRunner<TFacts, TDecision>` | DROP | OE-5: 15 of 19 runners don't have facts→decision shape. |
| `RemoteStatusCache<T>` reuse | DEFERRED | CE-9 cross-cutting; not in C-local scope. |
| `TtlCache<K, V>` | DROP | CE-9 + OE-6: single consumer + existing `RemoteStatusCache<T>` alternative. |
| `LoggerLike` | ADOPT | H-tier; C is a consumer, not an author. |

**No new generic interfaces are introduced for the C subsystem.**

---

## Cross-references

- `review-completeness.md OE-5` — `BaseRunner<TFacts, TDecision>`
  rejection. Per-OE-5: "most runners don't have facts → decision
  shape. The `apply(decision)` method has no semantic content for
  runners that have no decision."
- `review-completeness.md OE-6` — single-consumer generic rejection.
  Per-OE-6: "a generic with one consumer is ceremony."
- `review-completeness.md OE-9` — `App.getStore<K>` rejection. Per-OE-9:
  "the direct field is shorter and more idiomatic."
- `review-completeness.md CE-9` — `RemoteStatusCache<T>` reuse
  precedent. Per-CE-9: "Two parallel generic cache classes is a
  maintenance burden."
- `review-completeness.md CE-4` — error-class taxonomy convention.
  Per-CE-4: C does NOT introduce new error-class taxonomies.
- `e-process-lock/00-summary.md` — process-lock class candidates are
  all non-generic (precedent for C's non-generic outcome).
- `h-cross-cutting/04-generic-interfaces.md §L` — `LoggerLike`
  interface (H.1 deliverable; C is a consumer).

## [ASSUMPTION] markers

- [ASSUMPTION: the rejection verdicts are based on the framework's
  existing rejections (OE-5, OE-6, OE-9, CE-9). If the framework's
  verdicts are later reversed, C's `DashboardServer<TConfig>` and
  `BaseRunner<TFacts, TDecision>` may become viable — but per
  CLAUDE.md §2 ("minimum code that solves the problem"), the
  rejections stand unless a real second consumer materializes.]
- [ASSUMPTION: `RemoteStatusCache<T>` is the only viable generic in
  the C subsystem today. The CE-9 cross-cutting analysis is
  authoritative; if the federation poller cache is later identified
  as substitutable, the migration lands as part of CE-9, not C-local.]

---

**End of C generic-interfaces plan. No source files modified.**
