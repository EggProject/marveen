# G (channel-coordinator) — Class boundaries

Concrete class candidates for the G subsystem. **Signatures only; no
implementation.** Every claim below cites a file:line verified against
the 4 G source files (`src/channel-coordinator.ts` 442 LOC,
`src/channel-coordinator/telegram-client.ts` 227 LOC,
`src/channel-coordinator/ingest.ts` 231 LOC,
`src/channel-coordinator/liveness.ts` 288 LOC) read in full on
2026-08-30, plus the cross-references in the precedent reviews
(`h-cross-cutting/`, `d-channel-provider/`, `a-db/`, `b-config/`,
`e-process-lock/`, `f-agent-subsystem/`, `review-correctness.md`,
`review-completeness.md`).

**Reading note.** G produces **four** new classes — `TelegramClient`,
`IngestWorker`, `LivenessTracker`, `ChannelCoordinator` — plus the
existing `TelegramApiError` class that survives unchanged. The four
new classes follow the `B.1 Config` / `D.1 ChannelEnv` /
`E.1 PortLockAcquirer` / `F.1 HeartbeatScheduler` precedent of
"introduce alongside free functions; do NOT remove free functions
until G.8".

---

## Class candidate inventory

| Class | New? | Migration source | Phase |
|---|---|---|---|
| `TelegramClient` | new | the 4 free functions in `telegram-client.ts` (`mapUpdate` L98, `getUpdates` L143, `probeHighWater` L201, plus `validateToken`/`formatMessage`/`splitMessage` shape helpers — note: the latter 3 are not currently in `telegram-client.ts`; they live in `src/format.ts:3`/`50` and are forwarded by `TelegramProvider` per `d-channel-provider/03-class-boundaries.md:218-220`); the 2 frozen consts `API_BASE` L15 and `ALLOWED_UPDATES` L21 become private static fields | G.1 |
| `IngestWorker` | new | the 1 module singleton `let db: Database \| null = null` at `ingest.ts:25` + the 8 free functions (`initIngestDb` L27, `insertIncomingEvent` L126, `createHandoffMessage` L160, `markEventDelivered` L168, `markEventFailed` L175, `getEventsNeedingHandoff` L190, `getOffset` L206, `setOffset` L216, `closeIngestDb` L225`); the const `COORDINATOR_AGENT_ID` at `ingest.ts:23` survives as a static field | G.2 |
| `LivenessTracker` | new | the 4 mutable bindings at `channel-coordinator.ts:101-106` (`state`, `downStreak`, `stopping`, `nativeConfirmedUpUntil`) — the *streak* state — NOT the 9 free functions in `liveness.ts` (those stay free per the precedent in `01 §10`) | G.3 |
| `ChannelCoordinator` | new (orchestrator) | the entry-point file `channel-coordinator.ts:1-442`; the constructor takes the 3 other G classes as injected dependencies | G.4 |
| `TelegramApiError` | **NOT BUILT** (already a class at `telegram-client.ts:45`) | preserved verbatim per `h-cross-cutting/03-class-boundaries.md:305-311` and `review-completeness.md` OE-1/OE-2 | n/a |

**Four new classes total** (one already-existing class preserved). The
free functions stay as thin pass-through wrappers during the migration
window; removed only after every consumer migrates (G.8 gate).

---

## G1. `TelegramClient`

### Source and migration

- **Source file:** `src/channel-coordinator/telegram-client.ts` (same
  file, alongside the free functions).
- **Migration source:** the 3 free functions at
  `telegram-client.ts:98` (`mapUpdate`), `:143` (`getUpdates`), `:201`
  (`probeHighWater`). The 2 frozen consts `API_BASE` at L15 and
  `ALLOWED_UPDATES` at L21 become private static fields. The internal
  helpers `displayName` (L88), `RawUpdate`/`RawMessage`/`RawUser`
  interfaces (L56-86) become private types.

### Public surface (signatures only)

```ts
class TelegramClient {
  constructor(env: ChannelEnv, db: DbClient, log: LoggerLike)

  // -- poll / probe --
  getUpdates(token: string, offset: number, timeout: number, limit: number): Promise<RawUpdate[]>
  probeHighWater(token: string): Promise<number | null>

  // -- normalize --
  mapUpdate(u: RawUpdate): NormalizedEvent | null

  // -- format / split (forwarded to format.ts per D.2 pattern) --
  formatMessage(text: string): string      // forwards to formatForTelegram (format.ts:3)
  splitMessage(text: string): string[]     // forwards to splitMessage(text) (format.ts:50)
  validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `getUpdates(token, offset, timeout, limit)` | `getUpdates(token, offset, timeout, limit)` | `telegram-client.ts:143-190` | Long-poll via `fetch` + `AbortController`; reads `ALLOWED_UPDATES` from private static field. The `AbortController` is per-call (created in L149, cleared in `finally` at L163); no timer leak across re-init. |
| `probeHighWater(token)` | `probeHighWater(token)` | `telegram-client.ts:201-226` | Seed probe; deliberately omits `allowed_updates` per the L193-200 invariant. Returns the highest pending `update_id` or `null`. |
| `mapUpdate(u)` | `mapUpdate(u)` | `telegram-client.ts:98-137` | Pure normalization; returns `null` for unhandled update kinds. |
| `formatMessage(text)` | `formatForTelegram(text)` | `format.ts:3` (forwarded) | Currently NOT in `telegram-client.ts` — the brief adds it as a public method to make the class surface complete (paralleling `ChannelProvider.formatMessage` at `channel-provider.ts:19`). |
| `splitMessage(text)` | `splitMessage(text)` | `format.ts:50` (forwarded) | Same as above. |
| `validateToken(token)` | (none) | n/a | New method per D.2 surface (`channel-provider.ts:18`). Calls `getMe` (a Telegram Bot API endpoint not yet used in G). [ASSUMPTION: per the brief, but no current production caller — verify before adding to the G.1 commit.] |

### Constructor

- `(env, db, log)`. The `env` is the D.1 `ChannelEnv` instance
  (provides `getToken(provider)` and `stateDirFor(provider, agentDir?)`).
  The `db` is the A.1 `DbClient` instance — used by no method today but
  reserved for future telemetry (per-call latency log into the
  `incoming_events` table). The `log` is H.1 `LoggerLike` for the
  per-call debug logging (e.g. `logger.debug({ update_id }, 'telegram: getUpdates returned N updates')`).
- **No I/O in the constructor.** All HTTP happens in `getUpdates` and
  `probeHighWater`; the `AbortController` is created per-call.
- **No TelegramApiError dependency** — the class throws
  `TelegramApiError` (from `telegram-client.ts:45`) but does not own
  it; `TelegramApiError` is the existing class at the top of the same
  file.

### Generic params

**None.** Per `04-generic-interfaces.md §1` (this folder), no
`TelegramClient<TMessage>` parameter is justified — the 4 `kind` values
of `UpdateKind` are exhaustively handled by `mapUpdate` and the
incoming pipeline consumes `NormalizedEvent` regardless of source.
Rejected per `review-completeness.md` OE-6 (single consumer).

### Dependencies

- `ChannelEnv` (D.1) — for `env.getToken('telegram')`.
- `DbClient` (A.1) — for future telemetry writes (optional in the
  constructor signature; can be `undefined` until used).
- `LoggerLike` (H.1) — for the per-call debug log.
- `format.ts` — `formatForTelegram`, `splitMessage`.
- `fetch` (global, Node 18+) — the only network primitive.
- **No `node:https`** — the bot uses `fetch` exclusively
  (`telegram-client.ts:153, 206`).

### Lifecycle

- **One instance per process** — constructed once by `ChannelCoordinator`'s
  constructor (G.4) and held as a private field.
- **Stateless** — every method takes `token` as a parameter; no
  per-instance token or chatId state. This is the same invariant
  `TelegramProvider` follows per `d-channel-provider/00-summary.md`
  ("all five providers are stateless: token and chatId are per-call
  parameters, never instance state").
- **No `close()` method** — the `AbortController` is per-call and
  `setTimeout` is cleared in `finally` (L163, L215). No long-lived
  handles to release.

### `TelegramApiError` is the existing class — not a new build

Per `h-cross-cutting/03-class-boundaries.md:305-311` and
`review-completeness.md` OE-1/OE-2, `TelegramApiError` is preserved
verbatim. The 5 `instanceof TelegramApiError` discrimination sites at
`channel-coordinator.ts:335, 338, 366, 372, 378` (where the `kind`
discriminator drives control flow) keep working unchanged.

### Free functions that REMAIN after G.1

| Symbol | Location | Why it stays |
|---|---|---|
| `getUpdates(token, offset, timeout, limit)` | `telegram-client.ts:143` | Thin wrapper: `(t, o, t2, l) => client.getUpdates(t, o, t2, l)`. Removed in G.8. |
| `probeHighWater(token)` | `telegram-client.ts:201` | Same wrapper shape. |
| `mapUpdate(u)` | `telegram-client.ts:98` | Same. |
| `TelegramApiError` class | `telegram-client.ts:45-54` | **Survives unchanged.** Not wrapped, not migrated. The class form IS the form. |
| `TelegramErrorKind` type alias | `telegram-client.ts:43` | Survives as a top-level type export. |
| `UpdateKind`, `NormalizedEvent`, `RawUpdate`, `RawMessage`, `RawUser` | `telegram-client.ts:23-86` | Type-only exports; survive. The `Raw*` types become `private` inside the class if and only if no external consumer imports them. [ASSUMPTION: zero external consumers — verified by `grep -rn "RawUpdate\|RawMessage" src/ --include='*.ts' \| grep -v __tests__` would be needed before G.1 lands.] |
| `ALLOWED_UPDATES` const | `telegram-client.ts:21` | Becomes a `private static readonly` field on the class. The free export survives for tests. |

---

## G2. `IngestWorker`

### Source and migration

- **Source file:** `src/channel-coordinator/ingest.ts` (same file,
  alongside the free functions).
- **Migration source:** the 1 module singleton `let db: Database | null
  = null` at `ingest.ts:25` + the 8 free functions enumerated above.
  The `Database` handle is opened in `initIngestDb` (L27-91) — the
  class form takes either an injected handle or opens its own.

### Public surface (signatures only)

```ts
class IngestWorker {
  // -- static identity re-exported for backward compat --
  static readonly COORDINATOR_AGENT_ID = 'telegram-coordinator'

  constructor(opts: { dbPath?: string } = {})   // opens its own handle; not shared with A.1 DbClient

  // -- lifecycle --
  init(): IngestWorker         // runs CREATE TABLE IF NOT EXISTS, returns this for chaining
  close(): void                // closes the Database handle

  // -- incoming_events CRUD --
  insertIncomingEvent(source: string, ev: NormalizedEvent): InsertResult
  createHandoffMessage(content: string): number
  markEventDelivered(eventId: number, agentMessageId: number): void
  markEventFailed(eventId: number, error: string): void
  getEventsNeedingHandoff(source: string, limit?: number): IncomingEventRow[]
  getOffset(source: string): number
  setOffset(source: string, lastUpdateId: number): void
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `init()` | `initIngestDb(dbPath?)` | `ingest.ts:27-91` | Idempotent: if the handle is already open, returns `this`. Replaces the module-level `if (db) return db` guard at L28. |
| `close()` | `closeIngestDb()` | `ingest.ts:225-230` | Sets the handle to null after closing (preserves the L226-229 behavior). |
| `insertIncomingEvent(source, ev)` | `insertIncomingEvent(source, ev)` | `ingest.ts:126-150` | INSERT OR IGNORE on `(source, update_id)` unique index; returns `{ inserted, eventId }`. |
| `createHandoffMessage(content)` | `createHandoffMessage(content)` | `ingest.ts:160-166` | INSERT INTO `agent_messages` with `from_agent = IngestWorker.COORDINATOR_AGENT_ID`. |
| `markEventDelivered(eventId, agentMessageId)` | `markEventDelivered(eventId, agentMessageId)` | `ingest.ts:168-173` | UPDATE incoming_events SET status='delivered'. |
| `markEventFailed(eventId, error)` | `markEventFailed(eventId, error)` | `ingest.ts:175-177` | UPDATE incoming_events SET status='failed'. |
| `getEventsNeedingHandoff(source, limit=50)` | `getEventsNeedingHandoff(source, limit=50)` | `ingest.ts:190-204` | The reconcile/replay query. |
| `getOffset(source)` | `getOffset(source)` | `ingest.ts:206-211` | SELECT last_update_id FROM poll_offset. |
| `setOffset(source, lastUpdateId)` | `setOffset(source, lastUpdateId)` | `ingest.ts:216-223` | UPSERT poll_offset. |

### Constructor

- `(opts?)`. The optional `opts.dbPath` defaults to
  `join(STORE_DIR, DB_FILENAME)` per the existing L27 default.
- **The class opens its own `Database` handle** — it does NOT take a
  `DbClient` from A.1. Per `01 §10`: the coordinator is a SEPARATE
  process from the dashboard, so it cannot share the dashboard's
  sqlite singleton. This is a load-bearing constraint: even after A.7
  removes the `let db: Database` singleton in `src/db.ts:10`, the
  coordinator continues to open its own handle via
  `new Database(dbPath, { strict: true })`.
- **No logger** — the existing free functions in `ingest.ts` have zero
  logger call sites (verified by inspection of the 231 lines).

### Generic params

**None.** Per `04-generic-interfaces.md §2` (this folder), no
`IngestWorker<TSource>` parameter is justified — the `source` column is
a plain `TEXT` defaulted to `'telegram'` (per `ingest.ts:38`), and the
schema supports multiple `source` values but no second implementation
exists today. Rejected per `review-completeness.md` OE-6.

### Dependencies

- `Database, pragma, runScript` from `src/db/sqlite.ts`.
- `join` from `node:path`.
- `STORE_DIR, DB_FILENAME, MAIN_AGENT_ID` from `src/config.ts` (the 3
  consts are read inside the class via direct field access — no
  `Config` injection needed because `Config` already exposes these as
  re-export shims per `b-config/00-summary.md §Free functions that
  REMAIN`).
- **No `LoggerLike`** — zero logger call sites in `ingest.ts`.

### Lifecycle

- **One instance per process**, constructed by `ChannelCoordinator`'s
  constructor (G.4) and held as a private field.
- `init()` is called once at boot (replaces `initIngestDb()` from
  `main()` at `channel-coordinator.ts:425`).
- `close()` is called from the shutdown path (replaces `closeIngestDb()`
  at `channel-coordinator.ts:430` and inside the SIGTERM 3-second drain
  at `channel-coordinator.ts:414`).

### `COORDINATOR_AGENT_ID` re-export constraint

Per `01 §11`, 3 external consumers import only the `COORDINATOR_AGENT_ID`
constant:

| File | Line | Import |
|---|---:|---|
| `web/agent-message-wrap.ts` | 21 | `import { COORDINATOR_AGENT_ID } from '.../ingest.js'` |
| `web/federation/local-catalog.ts` | 8 | same |
| `web/routes/messages.ts` | 11 | same |

The class form preserves this via `static readonly COORDINATOR_AGENT_ID`
on `IngestWorker`, plus the free-function export `export const
COORDINATOR_AGENT_ID = IngestWorker.COORDINATOR_AGENT_ID` shim that
survives until G.8.

The free function survives the G.2 phase as a thin wrapper
(e.g. `export function createHandoffMessage(content: string) { return ingest.createHandoffMessage(content) }`),
but the const is re-exported by value, not by reference, so the
3 consumers keep their `from '.../ingest.js'` import path working
verbatim.

### Free functions that REMAIN after G.2

| Symbol | Location | Why it stays |
|---|---|---|
| `COORDINATOR_AGENT_ID` const | `ingest.ts:23` | Re-exported value of `IngestWorker.COORDINATOR_AGENT_ID`; the 3 external consumers resolve through this. Removed in G.8. |
| `initIngestDb(dbPath?)` | `ingest.ts:27-91` | Thin wrapper: `if (worker) return worker.db; else worker = new IngestWorker({ dbPath }).init(); return worker.db`. Removed in G.8. |
| `insertIncomingEvent`, `createHandoffMessage`, `markEventDelivered`, `markEventFailed`, `getEventsNeedingHandoff`, `getOffset`, `setOffset` | `ingest.ts:126-223` | Thin pass-through wrappers. Removed in G.8. |
| `closeIngestDb()` | `ingest.ts:225-230` | Thin wrapper: `worker.close()`. Removed in G.8. |
| `InsertResult`, `IncomingEventRow` interfaces | `ingest.ts:98-122` | Type-only exports; survive. |

---

## G3. `LivenessTracker`

### Source and migration

- **Source file:** `src/channel-coordinator.ts` (the streak state lives
  in the entry file, NOT in `liveness.ts`).
- **Migration source:** the 4 mutable lets at
  `channel-coordinator.ts:101-106` — `state: State = 'idle'`,
  `downStreak = 0`, `stopping = false`, `nativeConfirmedUpUntil = 0`.
  Plus the `inNative409Cooldown(confirmedUpUntilMs, nowMs)` helper at
  L109-111 (becomes a method).
- **NOT migrated from `liveness.ts`** — the 9 free functions in
  `liveness.ts` (`getClaudePidForSession`, `decideHasPluginAlive`,
  `snapshotProcsWithRetry`, `probeChannelPluginLiveness`,
  `hasChannelPluginAlive`, `readRespawnStampMs`,
  `readKeepaliveAgeMs`, `decideNativeChannelDown`,
  `probeNativeChannelDown`) stay free because they are consumed by 2
  external web/ files (`web/channel-monitor.ts:50`,
  `web/schedule-mcp-precheck.ts:22`) per `01 §11`. Per
  `01 §Per-file inventory`, the `LivenessProbe` class form would require
  re-writing 4 `vi.mock('../channel-coordinator/liveness.js', …)` sites
  (per the `01 §11.4` audit) and provides no production-consumer win.

### Public surface (signatures only)

```ts
class LivenessTracker {
  // -- 4 private fields (the 4 lets at channel-coordinator.ts:101-106) --
  private state: 'idle' | 'backfilling' = 'idle'
  private downStreak = 0
  private stopping = false
  private nativeConfirmedUpUntil = 0

  // -- streak transitions --
  getState(): 'idle' | 'backfilling'
  setState(state: 'idle' | 'backfilling'): void

  incrementDownStreak(): number     // returns the new value
  resetDownStreak(): void

  // -- 409 cooldown --
  setNativeConfirmedUpUntil(epochMs: number): void
  getNativeConfirmedUpUntil(): number
  inNative409Cooldown(nowMs: number): boolean   // was the free function at L109-111

  // -- shutdown latch --
  setStopping(): boolean            // returns true if first setter (idempotent guard)
  isStopping(): boolean
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `getState()` | (read of `state` at L317, L351) | n/a (new) | Returns the current `state` value. Used in `runLoop`'s `if (state === 'idle')` branch (L317). |
| `setState(state)` | (write of `state` at L331, L356, L375, L395) | n/a (new) | Transitions the state machine. |
| `incrementDownStreak()` | `downStreak = downStreak + 1` at L323 | n/a (new) | Returns the new value so the caller can check `>= DOWN_DEBOUNCE` in one expression. |
| `resetDownStreak()` | `downStreak = 0` at L323, L341, L356, L375, L395 | n/a (new) | Resets to 0 on UP probe or 409 cooldown. |
| `setNativeConfirmedUpUntil(epochMs)` | `nativeConfirmedUpUntil = Date.now() + …` at L339, L373 | n/a (new) | Sets the 409-cooldown expiry. |
| `getNativeConfirmedUpUntil()` | (read at L322) | n/a (new) | Returns the expiry epoch-ms. |
| `inNative409Cooldown(nowMs)` | `inNative409Cooldown(confirmedUpUntilMs, nowMs)` at L109-111 | n/a (new) | Pure boolean; wraps the existing helper. The free function stays for test compatibility (per `01 §11.3`, `channel-coordinator.test.ts` exercises it directly). |
| `setStopping()` | `stopping = true` at L410 | n/a (new) | Idempotent: returns `true` only on the first set, so the signal handler can `if (liveness.setStopping()) { /* first signal */ }`. Replaces the L409 `if (stopping) return` guard with a method-level atomic check. |
| `isStopping()` | (read of `stopping` at L313) | n/a (new) | Used in `runLoop`'s `while (!stopping)` condition. |

### Constructor

- **No constructor parameters.** The 4 fields are initialized to
  defaults in the class declarations. This matches the source behavior
  — the 4 lets start at their zero values and only `runLoop` / the
  signal handler mutate them.
- **No I/O in the constructor.**

### Generic params

**None.** Per `04-generic-interfaces.md §3` (this folder), no
`LivenessTracker<TState>` parameter is justified — the state machine
is `idle | backfilling` (a 2-element literal union) and exists in only
one place in the codebase. Rejected per `review-completeness.md` OE-6.

### Dependencies

- **None.** The class is a pure state holder; all I/O happens in the
  free `liveness.ts` probe functions that the orchestrator calls into.

### Lifecycle

- **One instance per process**, held as a private field on
  `ChannelCoordinator` (G.4).
- **No `close()` method** — the class is passive; `stopping = true` is
  the only termination signal, set by the SIGTERM handler.

### Critical caveat for G.4

These 4 fields MUST move together into the same class instance,
because `runLoop` (L311-403) reads AND writes all 4 within its single
`while (!stopping)` body (L322 reads `nativeConfirmedUpUntil`; L323
writes `downStreak`; L331 writes `state`; L339 writes
`nativeConfirmedUpUntil`; L356, L375, L395 write `state` and
`downStreak`). Splitting them across 4 separate classes introduces
ordering hazards; collapsing them into `LivenessTracker` is the only
safe move. Per `01 §1.2`: "the simplest design that solves the
problem is the right one."

### Free functions that REMAIN after G.3

| Symbol | Location | Why it stays |
|---|---|---|
| `inNative409Cooldown(confirmedUpUntilMs, nowMs)` | `channel-coordinator.ts:109-111` | **Preserved as a free export.** The `channel-coordinator.test.ts` test file exercises it directly per `01 §11.3`. The class form is additive; the free function becomes a thin wrapper `export const inNative409Cooldown = (a, b) => a > b`. |
| All 9 free functions in `liveness.ts` (`getClaudePidForSession`, `decideHasPluginAlive`, `snapshotProcsWithRetry`, `probeChannelPluginLiveness`, `hasChannelPluginAlive`, `readRespawnStampMs`, `readKeepaliveAgeMs`, `decideNativeChannelDown`, `probeNativeChannelDown`) | `liveness.ts:34-287` | Untouched. The 4 `vi.mock('../channel-coordinator/liveness.js', …)` sites in `channel-monitor.test.ts:259`, `channel-monitor-baseline.test.ts:222`, `channel-monitor-coverage.test.ts:243`, `schedule-mcp-precheck-full.test.ts:80` keep working unchanged. |
| The `tmuxBin` lazy resolver | `liveness.ts:20` | Stays module-level per the `LazyBin` precedent (`h-cross-cutting/03-class-boundaries.md §C2`); an H.3 `new LazyBin('tmux')` migration can run in parallel. |

---

## G4. `ChannelCoordinator`

### Source and migration

- **Source file:** `src/channel-coordinator.ts` (same file, alongside
  the free functions).
- **Migration source:** the orchestrator itself. The constructor takes
  the 3 other G classes plus the channel-provider registry and the
  logger.

### Public surface (signatures only)

```ts
class ChannelCoordinator {
  constructor(opts: {
    session: string                 // was the const SESSION at L56
    provider: ChannelProviderType   // was the const PROVIDER at L57
    stateDir: string                // was STATE_DIR at L97
    token: string                   // was the return of readToken() at L423
    pidFile: string                 // was PID_FILE at L98
    notifyScript: string            // was join(PROJECT_ROOT, 'scripts', 'notify.sh') at L171
    telegram: TelegramClient
    ingest: IngestWorker
    liveness: LivenessTracker
    registry: ChannelProviderRegistry   // D.3 — for getProvider(type).sendMessage etc.
    log: LoggerLike
  })

  // -- public lifecycle --
  start(): Promise<void>     // replaces main() at L422-431
  stop(): Promise<void>      // replaces releaseLock() + closeIngestDb() at L429-430 + the SIGTERM 3-second drain at L412-415

  // -- pure exports preserved as instance methods (test seam) --
  runLoop(): Promise<void>                            // was the free function at L311-403
  inNative409Cooldown(confirmedUpUntilMs: number, nowMs: number): boolean  // was L109-111; delegates to this.liveness
  transientBackoffMs(attempt: number): number         // was L221-224; pure math, stays a static or instance method
  buildHandoffContent(ev: ChannelHandoffEvent): string  // was L189-215
  neutralizeChannelTags(text: string): string           // was L182-184

  // -- accessors --
  getLiveness(): LivenessTracker
  getProvider(): ChannelProvider
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `start()` | `main()` | `channel-coordinator.ts:422-431` | Acquires PID lock, calls `this.ingest.init()`, calls `this.runLoop()`. The entry-point guard at L435 stays free (not on the class). |
| `stop()` | (the SIGTERM 3-second drain at L412-415) | `channel-coordinator.ts:407-420` | Sets `this.liveness.setStopping()`, schedules a 3-second timer that calls `this.ingest.close()` + exits the process. Returns the Promise that the timer fulfills (test seam). |
| `runLoop()` | `runLoop(token)` | `channel-coordinator.ts:311-403` | Reads + writes `this.liveness.*` 8 times; reads `this.token` from constructor. Returns when `this.liveness.isStopping()`. |
| `inNative409Cooldown(a, b)` | `inNative409Cooldown(a, b)` | `channel-coordinator.ts:109-111` | Delegates to `this.liveness.inNative409Cooldown(b)`. Pure math, no state. |
| `transientBackoffMs(attempt)` | `transientBackoffMs(attempt)` | `channel-coordinator.ts:221-224` | Pure math (`Math.random() * Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** attempt)`); instance method or static. |
| `buildHandoffContent(ev)` | `buildHandoffContent(ev)` | `channel-coordinator.ts:189-215` | Pure function over the event fields; instance method because it calls `neutralizeChannelTags` (also on `this`). |
| `neutralizeChannelTags(text)` | `neutralizeChannelTags(text)` | `channel-coordinator.ts:182-184` | Pure regex replace; preserved as instance method. |
| `getLiveness()` | (new) | n/a | Returns the private `this.liveness` field. Used by tests (the `channel-coordinator-liveness.test.ts` pattern). |
| `getProvider()` | (new) | n/a | Returns `this.registry.get(this.provider)` for downstream callers (e.g. test mocks that want to verify which provider is being polled). |

### Constructor

- `(opts)`. The `opts` parameter is a single object (per the
  `b-config/00-summary.md` "config-bundle" precedent and `e-process-lock`
  `PortLockAcquirer` `(ctx, opts?)` precedent at
  `e-process-lock/03-class-boundaries.md:42`) so the signature is
  robust to additions (e.g. `tickMs`, `backoffMs`, `native409CooldownMs`,
  all of which are module-level constants today and could become
  constructor opts in a test scenario).
- The `telegram`, `ingest`, `liveness`, `registry`, `log` parameters are
  the 5 dependencies. The first 3 are G classes; `registry` is D.3;
  `log` is H.1.
- **No I/O in the constructor.** All file I/O happens in `start()`
  (PID lock, `ingest.init()`) and in `runLoop()` (HTTP via
  `telegram.getUpdates`).

### Generic params

**None.** Per `04-generic-interfaces.md §1` (this folder), no
`ChannelCoordinator<TConfig>` parameter is justified — the 4-tuple
state machine is single-instance per process, and the dependency
graph is fixed. Rejected per `review-completeness.md` OE-6.

However, the brief asks for "ChannelCoordinator parameterized over
TConfig sketch OR OE-6 rejection" — see `04-generic-interfaces.md §1`
for the rejection argument.

### Dependencies

- `TelegramClient` (G.1) — the HTTP wrapper.
- `IngestWorker` (G.2) — the persistence layer.
- `LivenessTracker` (G.3) — the streak state.
- `ChannelProviderRegistry` (D.3) — the provider lookup. The
  coordinator only calls `registry.get(provider)` once (in
  `getProvider()`); the actual `sendMessage` path is owned by D, not G.
  Per `01 §10` and `d-channel-provider/03-class-boundaries.md §D3`,
  `ChannelProviderRegistry` exposes `get(type): ChannelProvider`.
- `LoggerLike` (H.1) — the 17 logger call sites in
  `channel-coordinator.ts` (L150, L173, L244, L252, L254, L275, L293,
  L295, L303, L333, L340, L343, L355, L374, L411, L427, L437) all
  route through `this.log`.
- `node:fs` — `readFileSync`, `writeFileSync`, `existsSync`,
  `unlinkSync`, `mkdirSync` for the PID-lock dance in `start()`.
- `node:path` — `join` for the `pidFile` derivation (already provided
  in `opts.pidFile`).
- `node:os` — `homedir` for the `stateDir` default (already in
  `opts.stateDir`).
- `node:child_process` — `execFile('/bin/bash', [notifyScript, msg])`
  for `sendAlert` (preserved as a private method).

### Lifecycle

- **One instance per process**, constructed inside `main()` (which
  itself runs only when the entry-point guard at L435 passes).
- `start()` acquires the PID lock and begins the run loop.
- `stop()` is called from the SIGTERM 3-second drain (L412-415) and
  also exposed for test cleanup.
- **No `close()` method** — the SIGTERM handler calls `process.exit(0)`
  after the 3-second drain, so the process lifecycle is what releases
  resources.

### `installSignalHandlers` ownership (G.5)

The signal-handler installation can be either:

(a) **A method on `ChannelCoordinator`** — `start()` calls
`this.installSignalHandlers()` which calls
`process.on('SIGTERM', () => onSignal('SIGTERM'))` etc. Risk: if
`start()` is called twice (test re-entry, HMR), the handlers
double-register.

(b) **A free function kept at module level** — `installSignalHandlers()`
stays at `channel-coordinator.ts` and is called once from `main()`
(L426). The class instance is held in a module-scope singleton so
`onSignal` can call `singleton.liveness.setStopping()` etc.

**Recommendation: (b).** Per `06-risks-and-mitigations.md` GR1, the
free-function form has a `process.listenerCount` guard at module-init
time that is simpler than a class-method-side guard, and the
re-entrancy hazard is naturally bounded by the L435 entry-point guard
(which only fires once per process). The const `stopping` becomes
`singleton.liveness.setStopping()`; the SIGTERM handler captures the
singleton via a closure.

### Free functions that REMAIN after G.4

| Symbol | Location | Why it stays |
|---|---|---|
| `installSignalHandlers()` | `channel-coordinator.ts:407-420` | Kept as a free function (G.5 recommendation). The class captures the singleton via closure. Removed in G.8. |
| `acquireSingleInstanceLock()` | `channel-coordinator.ts:142-157` | Thin wrapper: `() => coordinator.acquireLock()` if moved into class; OR kept free if `installSignalHandlers` is free. Per the G.5 recommendation, kept free for symmetry. |
| `releaseLock()` | `channel-coordinator.ts:159-163` | Same. |
| `sendAlert(message)` | `channel-coordinator.ts:170-175` | Pure side-effect; kept free OR moved to a private method on the class. The free form is simpler. |
| `readToken()` | `channel-coordinator.ts:117-136` | Pure helper that reads from `process.env` or `${stateDir}/.env`. Becomes a private method on the class (consumed only by `main()`). |
| `processBatch(updates)` | `channel-coordinator.ts:233-258` | Pure helper (no state); becomes a private method on the class. |
| `reconcilePending()` | `channel-coordinator.ts:270-298` | Pure helper (no state); becomes a private method on the class. |
| `fatalExit(err)` | `channel-coordinator.ts:302-307` | Pure side-effect (notify.sh + exit); becomes a private method on the class. |
| `sleep(ms)` | `channel-coordinator.ts:226` | Local const; private module helper. |
| `main()` | `channel-coordinator.ts:422-431` | Renamed to a thin `startCoordinator(coordinator)` bootstrap OR stays free if `installSignalHandlers` is free. The L435 entry-point guard stays verbatim. |
| The L435 entry-point guard | `channel-coordinator.ts:435` | **Survives verbatim.** Load-bearing for test isolation per `01 §10`. |
| The module-level constants `SOURCE` (L50), `LONGPOLL_TIMEOUT_SEC` (L51), `POLL_LIMIT` (L52), `TICK_MS` (L60), `DOWN_DEBOUNCE` (L64), `BACKOFF_BASE_MS` (L67), `BACKOFF_CAP_MS` (L68), `NATIVE_409_COOLDOWN_MS` (L92), `STATE_DIR` (L97), `PID_FILE` (L98) | various | Per the `d-channel-provider/00-summary.md` "const stays module-level for simplicity" precedent — kept free OR moved into the constructor `opts`. The recommended default is **kept free** for `TICK_MS`, `DOWN_DEBOUNCE`, `BACKOFF_BASE_MS`, `BACKOFF_CAP_MS`, `NATIVE_409_COOLDOWN_MS` (test tuning), and **moved into `opts`** for `LONGPOLL_TIMEOUT_SEC`, `POLL_LIMIT` (per-deployment tuning). |

---

## Summary of free functions vs class surface after G.1–G.4

| Symbol | After G.1–G.4 | Notes |
|---|---|---|
| `TelegramClient` class | **new** | G.1 deliverable |
| `IngestWorker` class | **new** | G.2 deliverable |
| `LivenessTracker` class | **new** | G.3 deliverable |
| `ChannelCoordinator` class | **new** | G.4 deliverable |
| `TelegramApiError` class | **unchanged** | Already a class at `telegram-client.ts:45-54`; survives verbatim per `h-cross-cutting/03-class-boundaries.md:305-311` |
| `getUpdates`, `probeHighWater`, `mapUpdate` | free wrappers | Removed in G.8 |
| `COORDINATOR_AGENT_ID` | re-export shim | Removed in G.8 |
| `initIngestDb`, `insertIncomingEvent`, `createHandoffMessage`, `markEventDelivered`, `markEventFailed`, `getEventsNeedingHandoff`, `getOffset`, `setOffset`, `closeIngestDb` | free wrappers | Removed in G.8 |
| `inNative409Cooldown`, `transientBackoffMs`, `buildHandoffContent`, `neutralizeChannelTags` | free wrappers | Removed in G.8 |
| All 9 free functions in `liveness.ts` | **unchanged** | Untouched by G; per `01 §10`, the 4 external vi.mock sites keep working |
| The L435 entry-point guard | **unchanged** | Load-bearing |
| The `installSignalHandlers` decision (G.5) | **free function** (recommended) | Per GR1 |

---

**End of G class-boundaries plan. No source files modified.**
