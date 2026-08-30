# G (channel-coordinator) — Generic interfaces

This document evaluates the three generic-interface proposals that the
task brief asks about for the G subsystem: `ChannelCoordinator<TConfig>`,
`TelegramClient<TProvider>`, and `IngestWorker<TMessage>`. For each,
the framework `review-completeness.md` OE-6 criterion is applied:

> "Reject generics that have a single consumer."

The three proposals are **all rejected** on OE-6 grounds. The
specific reasoning, the speculative sketches considered, and the
single-load-bearing `LoggerLike` dependency (which is non-generic per
`h-cross-cutting/04-generic-interfaces.md §L`) are documented below.
Cross-checked against `src/channel-coordinator.ts` (442 LOC) and the
3 submodules on 2026-08-30. Planning only — no source files modified.

---

## Reading note

The framework's `04-generic-interfaces.md` at
`docs/refactor-to-classbase/04-generic-interfaces.md` (the framework
folder, not this one) introduced a batch of generic sketches across
all subsystems. The G-relevant subset is:

- **G1** (framework): `BasePaneWatcher<TState, TThresholds>` — NOT in G
  scope (G has no `pane-state.ts` consumer; rejected for G in
  `review-completeness.md` OE-7).
- **G2** (framework): `TtlCache<K, V>` — NOT in G scope (G has no
  TTL cache; rejected for the framework in
  `review-completeness.md` OE-6 + CE-9).
- **G3** (framework): `RetryQueue<TRow>` — NOT in G scope.
- **G4** (framework): `AuthContext` sealed hierarchy — NOT in G scope
  (G does not own web auth; rejected in `review-completeness.md` OE-4).
- **G5** (framework): `LoggerLike` interface — **INDIRECTLY in G
  scope** (the G.4 `ChannelCoordinator` constructor takes `log:
  LoggerLike`, per `h-cross-cutting/03-class-boundaries.md §C1`).
- **G6** (framework): `BaseRunner<TFacts, TDecision>` — NOT in G
  scope (`ChannelCoordinator` is not a "facts → decision" runner; it
  is an orchestrator with a state machine, rejected for the framework
  in `review-completeness.md` OE-5).
- **G7** (framework): `LazyBin<TName, TResolved>` — NOT in G scope
  (per `h-cross-cutting/03-class-boundaries.md §C2`, the `tmuxBin`
  resolver at `liveness.ts:20` stays as a `makeLazyBinResolver` call
  until H.3 migrates it).
- **G8** (framework): `App.getStore<K>` typed accessor — NOT in G
  scope (G has no `App` keystone dependency).

The three task-brief-specific proposals (`ChannelCoordinator<TConfig>`,
`TelegramClient<TProvider>`, `IngestWorker<TMessage>`) are evaluated
below. All three are rejected on OE-6 grounds; the `LoggerLike` seam
that G.4 / G.7 depends on is **not** generic per
`h-cross-cutting/04-generic-interfaces.md §L` (verified, 2026-08-30).

---

## §1. `ChannelCoordinator<TConfig>` — REJECTED (OE-6)

### Speculative sketch

```ts
class ChannelCoordinator<TConfig extends CoordinatorConfig = CoordinatorConfig> {
  constructor(opts: TConfig & {
    telegram: TelegramClient
    ingest: IngestWorker
    liveness: LivenessTracker
    registry: ChannelProviderRegistry
    log: LoggerLike
  })

  start(): Promise<void>
  stop(): Promise<void>
  runLoop(): Promise<void>
  // ...
}

interface CoordinatorConfig {
  session: string
  provider: ChannelProviderType
  stateDir: string
  token: string
  pidFile: string
  notifyScript: string
  // ...the 10 module-level constants at channel-coordinator.ts:50-92
  tickMs: number
  downDebounce: number
  backoffBaseMs: number
  backoffCapMs: number
  native409CooldownMs: number
  longpollTimeoutSec: number
  pollLimit: number
}
```

### Why rejected

1. **Single consumer.** Per `01 §11`, the G.4 `ChannelCoordinator` has
   exactly **one production caller** — the `main()` function at
   `channel-coordinator.ts:422-431`, which itself runs only via the
   L435 entry-point guard. The dashboard's `App` (D.3) does NOT import
   or instantiate `ChannelCoordinator` because the coordinator is a
   SEPARATE PROCESS per `01 §10`. There is no second consumer that
   would benefit from a parameterized config.
2. **No test factory needs it.** The 11 dedicated
   `channel-coordinator-*.test.ts` files exercise the free functions
   directly today (`01 §11.3`); the class form would be tested by
   constructing a `ChannelCoordinator` once per test with hard-coded
   values, not by parameterizing the config type. The 4-test pattern
   of `vi.mock('../channel-coordinator/liveness.js', …)` does not
   touch `ChannelCoordinator` at all.
3. **Type-bag explosion.** The 8 module-level constants at L50-92
   (`SOURCE`, `LONGPOLL_TIMEOUT_SEC`, `POLL_LIMIT`, `TICK_MS`,
   `DOWN_DEBOUNCE`, `BACKOFF_BASE_MS`, `BACKOFF_CAP_MS`,
   `NATIVE_409_COOLDOWN_MS`) are tuning knobs. Moving them into a
   `CoordinatorConfig` interface gains compile-time exhaustiveness
   but adds 8 fields to the constructor's `opts` argument. The
   `b-config/03-class-boundaries.md:170-191` "Config" precedent shows
   this pattern (58 readonly fields + `fromEnv()` factory); G does
   not need it because the coordinator's defaults are stable and
   well-tested.
4. **OE-6 verbatim.** Per `review-completeness.md` OE-6: *"Reject
   generics that have a single consumer."* `ChannelCoordinator<TConfig>`
   has exactly one consumer (`main()` at L422). The generic provides
   zero compile-time benefit that the unparameterized form lacks:
   every test that constructs a `ChannelCoordinator` passes the same
   shape, and the per-test overrides can use partial-typing via
   `Partial<CoordinatorConfig>` without a generic parameter.

### Verdict: **REJECTED.** Use the unparameterized form per
`03-class-boundaries.md §G4`.

---

## §2. `TelegramClient<TProvider>` — REJECTED (OE-6)

### Speculative sketch

```ts
class TelegramClient<TProvider extends ChannelProviderType = 'telegram'> {
  constructor(env: ChannelEnv, db: DbClient, log: LoggerLike, provider: TProvider)

  getUpdates(token: string, offset: number, timeout: number, limit: number): Promise<RawUpdate[]>
  probeHighWater(token: string): Promise<number | null>
  formatMessage(text: string): string      // dispatched on TProvider
  validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
  // ...
}
```

### Why rejected

1. **Single producer.** The G.1 `TelegramClient` is the
   Telegram-only HTTP wrapper. It is constructed once by
   `ChannelCoordinator`'s constructor (G.4) with
   `provider: 'telegram'` (the only supported value). The 5-implementation
   provider pattern lives in **D** (`d-channel-provider/03-class-boundaries.md
   §D2`: `TelegramProvider`, `SlackProvider`, `DiscordProvider`,
   `GooglechatProvider`, `TeamsProvider`), not in G. G's
   `TelegramClient` is a thin HTTP wrapper for getUpdates only — it
   does NOT mirror `ChannelProvider.sendMessage`.
2. **No Slack/Discord alternative for the coordinator.** Per
   `telegram-client.ts:1-13` ("This client never sends ... the
   coordinator backfills only the Telegram channel"), there is no
   second `TelegramClient<TProvider = 'slack'>` implementation, and
   none is planned. The `source` column in `incoming_events` (per
   `ingest.ts:38` default `'telegram'`) supports a multi-source
   schema, but no second producer exists today.
3. **`ChannelProviderType` is the wrong type to parameterize on.** The
   Telegram-only HTTP wrapper does not vary by `ChannelProviderType`
   in any way that requires static dispatch — the `formatMessage` /
   `splitMessage` helpers forward to `format.ts:3, 50` regardless of
   `TProvider`. A `TelegramClient<'slack'>` would be a meaningless
   type because none of the methods are provider-specific.
4. **OE-6 verbatim.** Per `review-completeness.md` OE-6: *"Reject
   generics that have a single consumer."* `TelegramClient<TProvider>`
   has one producer (the coordinator) and one supported `TProvider`
   value (`'telegram'`).

### Verdict: **REJECTED.** Use the unparameterized form per
`03-class-boundaries.md §G1`.

---

## §3. `IngestWorker<TMessage>` — REJECTED (OE-6)

### Speculative sketch

```ts
class IngestWorker<TMessage extends NormalizedEvent = NormalizedEvent> {
  constructor(opts: { dbPath?: string } = {})

  insertIncomingEvent(source: string, ev: TMessage): InsertResult
  getEventsNeedingHandoff(source: string, limit?: number): IncomingEventRow[]
  // ...
}
```

### Why rejected

1. **Single source.** The G.2 `IngestWorker` ingests events from one
   source today: `telegram-client.ts:mapUpdate(u): NormalizedEvent | null`
   (per `telegram-client.ts:98-137`). The `source` column on
   `incoming_events` is a plain `TEXT` defaulted to `'telegram'` (per
   `ingest.ts:38`), and the schema supports multi-source values, but
   no second producer (`SlackChannelMapUpdate`, `DiscordChannelMessage`,
   etc.) exists.
2. **`TMessage = NormalizedEvent` is the only inhabitant.** The
   parameterization would force every test to write
   `IngestWorker<NormalizedEvent>()` — which collapses to
   `IngestWorker()`. The generic provides zero inference benefit.
3. **`IncomingEventRow` is the SQL-row type, not a polymorphic payload.**
   The `getEventsNeedingHandoff(source)` query at `ingest.ts:190-204`
   returns `IncomingEventRow[]`; the `INSERT OR IGNORE` at
   `ingest.ts:126-150` takes the `NormalizedEvent` shape. There is no
   intermediate polymorphism — the ingest layer is fully Telegram-shaped.
4. **OE-6 verbatim.** Per `review-completeness.md` OE-6: *"Reject
   generics that have a single consumer."* `IngestWorker<TMessage>`
   has one consumer (`ChannelCoordinator`'s `processBatch` /
   `reconcilePending` methods), and `TMessage = NormalizedEvent` is
   the only supported value.

### Verdict: **REJECTED.** Use the unparameterized form per
`03-class-boundaries.md §G2`.

---

## §4. The one G-relevant non-generic interface: `LoggerLike`

### Why `LoggerLike` is in G's dependency graph but is NOT a G generic

Per `h-cross-cutting/04-generic-interfaces.md §L` (verified
2026-08-30), `LoggerLike` is **not generic**. The interface is:

```ts
type LogFn = (record: Record<string, unknown>, msg?: string) => void
interface LoggerLike {
  info: LogFn
  warn: LogFn
  error: LogFn
  debug: LogFn
}
```

The `L` parameter that the framework's draft floated (a typed-log
generic over `L extends Record<string, unknown>`) was rejected
because the `pino` package's own `LogFn` (`node_modules/pino/pino.d.ts:345-352`)
uses **three overloads** to handle the 3 call shapes (`logger.info(obj)`,
`logger.info(msg)`, `logger.info(obj, msg)`). Per
`h-cross-cutting/00-summary.md` risk #1: 626 of the 744 production
`logger.<level>(` calls are object-first, 76 are string-first; a
record-first-only `LogFn` fails to type-check ~118 sites. The
non-generic overload form preserves all three call shapes.

### How G consumes `LoggerLike`

| G class | Constructor field | File:line evidence (logger call sites) |
|---|---|---|
| `TelegramClient` | `log: LoggerLike` | `telegram-client.ts` has zero logger call sites today (verified by `grep -nE "logger\.<level>\(" src/channel-coordinator/telegram-client.ts` → 0 matches); the field is reserved for future per-call debug logging. |
| `IngestWorker` | (no logger) | `ingest.ts` has zero logger call sites; per `01 §Per-file inventory`, `ingest.ts` has 0 logger call sites. |
| `LivenessTracker` | (no logger) | The class is passive state; no logger needed. |
| `ChannelCoordinator` | `log: LoggerLike` | 17 logger call sites at `channel-coordinator.ts:150, 173, 244, 252, 254, 275, 293, 295, 303, 333, 340, 343, 355, 374, 411, 427, 437`. |

### Cross-cutting dependency

`LoggerLike` is **not** introduced by G. It is exported by H (per
`h-cross-cutting/00-summary.md §Migration order`: H.1 first, then
G.7 — "LoggerLike adoption across G classes"). G.4 takes
`LoggerLike` as a constructor parameter type only after H.1 lands;
before H.1, G.4 would take `logger` (the concrete pino singleton at
`logger.ts:3`).

### Verdict: **No new generic interface introduced.** The
`LoggerLike` dependency is satisfied by H.1's non-generic interface.

---

## §5. Why no `LivenessTracker<TState>` either

The state machine is `'idle' | 'backfilling'` (per
`channel-coordinator.ts:100`: `type State = 'idle' | 'backfilling'`).
A `LivenessTracker<TState extends State>` parameterization would have:

- One inhabitant: `TState = 'idle' | 'backfilling'` (the literal union).
- One consumer: `ChannelCoordinator`'s `runLoop` (G.4).
- Zero tests that parameterize the state.

This is rejected on OE-6 grounds (single consumer) and on
`CLAUDE.md §2` ("Simplicity First") grounds (the literal-union type
IS the most specific type — there is no wider type to parameterize
on without dropping to `string`, which loses the exhaustiveness check).

---

## §6. Summary

| Proposal | Rejected? | Reason |
|---|---|---|
| `ChannelCoordinator<TConfig>` | **REJECTED** | OE-6 (single consumer); no test factory needs it; type-bag explosion |
| `TelegramClient<TProvider>` | **REJECTED** | OE-6 (single producer); no Slack/Discord alternative planned; `TProvider = 'telegram'` is the only inhabitant |
| `IngestWorker<TMessage>` | **REJECTED** | OE-6 (single source); `TMessage = NormalizedEvent` is the only inhabitant |
| `LivenessTracker<TState>` | **REJECTED** (added by this doc, not in the brief) | OE-6 + CLAUDE.md §2 (literal-union is already the most specific type) |
| `LoggerLike` (H.1, NOT a G generic) | **USED, not introduced** | Per `h-cross-cutting/04-generic-interfaces.md §L`: non-generic overload form. G.7 consumes it; H.1 introduces it. |

**Net effect: zero new generic interfaces introduced by G.** The G
classes use concrete types (`NormalizedEvent`, `InsertResult`,
`IncomingEventRow`, `ChannelProviderType`, `LoggerLike`) throughout.
This matches the framework `review-completeness.md` OE-6 verdict:
generics with single consumers are rejected, and every G class has a
single production consumer.

---

## Cross-references

- `review-completeness.md` OE-6 — *"Reject generics that have a single consumer."*
- `review-completeness.md` OE-1/OE-2 — sealed-class discimination proposals rejected
- `review-completeness.md` OE-7 — `BasePaneWatcher<TState, TThresholds>` rejected on `unknown`-defeats-type-safety grounds
- `h-cross-cutting/00-summary.md §Top 3 risks` — `LoggerLike` call signature risk
- `h-cross-cutting/04-generic-interfaces.md §L` — `LoggerLike` is not generic (pino overload form)
- `d-channel-provider/03-class-boundaries.md:139-142` — `ChannelEnv<TEnv>` rejected for B.1
- `b-config/03-class-boundaries.md:233-238` — `Config<TEnv>` rejected on hand-maintained-key drift

---

**End of G generic-interfaces plan. No source files modified.**
