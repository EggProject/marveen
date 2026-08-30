# G (channel-coordinator) — Module and state analysis

Planning only — no source file modified. Cross-checked against
`/Users/eggp/marveen-develop/test-baseline/src/` on 2026-08-30. Every
file:line ref below was Read against source in this session.

## Brief summary (5 sentences)

G is a self-contained **standalone BACKFILL poller** that runs as a
separate launchd unit and only does work while the native Telegram
channel plugin is DOWN — the rest of the time it sits idle. The main
file `channel-coordinator.ts` (442 lines) is a classic hybrid: 4 module
mutable lets + 1 const PID_FILE + entry-point guard + signal handlers +
runLoop state machine; the `telegram-client.ts` module is pure functions
plus one existing `TelegramApiError` class; `ingest.ts` carries a single
`let db: Database` singleton plus free-function wrappers; and
`liveness.ts` is pure functions plus a `tmuxBin` lazy resolver. The G
subsystem is **the smallest blast radius of all eight subsystems** in
the framework plan: zero production importers of the main entry file
(it is invoked only via launchd / `node dist/channel-coordinator.js`),
exactly 1 external producer consumer of `ingest.ts` constants
(`COORDINATOR_AGENT_ID` from 3 web/ files), and 5 vi.mock sites across 4
test files for the liveness module. Two pre-existing decisions
constrain the refactor: `TelegramApiError` is an existing class (per
`review-completeness.md` CE-1, deferred longest under H.4) and the
single-file entry-point guard at `channel-coordinator.ts:435` already
isolates `main()` from import-time execution, so the "no module-level
side effects" rule that bites the heartbeat scheduler does NOT apply
here.

---

## Per-file inventory

| File | LOC | Shape | Module-level lets | Module-level state (non-let) | Side effects | Re-init hazard | vi.mock count | Production consumer count |
|---|---:|---|---|---|---|---|---:|---:|
| `src/channel-coordinator.ts` | 442 | Hybrid: entry-point + module state + free functions | 4 (`state` L101, `downStreak` L102, `stopping` L103, `nativeConfirmedUpUntil` L106) | 1 const `PID_FILE` (L98); transient `transientAttempt` is local to `runLoop` (L312) | PID_FILE write/unlink (L156, L161); `.env` read (L122); `execFile('/bin/bash', notify.sh)` (L172); `setTimeout` for shutdown drain (L412); `process.on('SIGTERM'\|'SIGINT')` (L418-419); `process.exit` (L151, L306, L415, L439); `process.kill(prev, 0)` lock probe (L148) | **High.** `main()` is guarded by `import.meta.url === pathToFileURL(process.argv[1]).href` at L435 (no re-entry in tests), but inside the process there are no idempotency guards on `initIngestDb`/`installSignalHandlers` re-call. Per B-8 / review-completeness.md CE-8 the `acquireSingleInstanceLock` is the only natural re-entry brake (PID_FILE conflict exits at L151). | 0 (the entry file is **never** `vi.mock`'d; tests call into the module directly) | 0 (the file is run as a process, not imported; the L435 entry-point guard is the contract) |
| `src/channel-coordinator/telegram-client.ts` | 227 | Pure utilities + 1 class (`TelegramApiError` L45) | 0 | `API_BASE` const (L15); `ALLOWED_UPDATES` const (L21) — neither mutated | `fetch('https://api.telegram.org/bot.../getUpdates')` (L153, L206); `setTimeout` for `AbortController` abort (L150, L203) | **None.** Pure functions; `TelegramApiError` is a value class. AbortController is created per-call so no timer leak across re-init. | 0 (`telegram-client.ts` is exercised via `channel-coordinator-telegram-client.test.ts` which calls functions, not `vi.mock`s the module) | 1 (`src/channel-coordinator.ts:36` only) |
| `src/channel-coordinator/ingest.ts` | 231 | Hybrid: module singleton + free-function wrappers | 1 (`let db: Database \| null = null` at L25) | none | `new Database(dbPath, { strict: true })` (L29); `pragma(handle, ...)` (L32-33); `runScript(handle, ...)` CREATE TABLE (L35-87); per-call `prepare(...).run(...).get(...).all(...)` SQL | **Low.** `initIngestDb` (L27-91) is idempotent: `if (db) return db` at L28 guards double-init. `closeIngestDb` (L225-230) sets `db = null` after `db.close()`, so a re-init after close works. Per `01 §10` ingest.ts WAL + busy_timeout = 5000ms protects against concurrent dashboard writes (the file-level comment L7-9 calls this out). | 1 (`messages-routes.test.ts:101` mocks `../channel-coordinator/ingest.js` to substitute the const) | 4 (1 internal: `channel-coordinator.ts:38-48`; 3 external const-only: `web/agent-message-wrap.ts:21`, `web/federation/local-catalog.ts:8`, `web/routes/messages.ts:11` — all 3 import `COORDINATOR_AGENT_ID` only) |
| `src/channel-coordinator/liveness.ts` | 288 | Pure utilities + lazy resolver (`tmuxBin` L20) + provider-poller-match consumer | 0 (the only "state" is the `tmuxBin = makeLazyBinResolver('tmux')` lazy cache) | `tmuxBin` lazy resolver (L20); `KEEPALIVE_FILE` / `KEEPALIVE_STALE_MS` / `STARTUP_GRACE_MS` / `RESPAWN_STAMP_FILE` consts (L25-30); `PS_PROBE_TIMEOUT_MS` / `PS_PROBE_RETRY_TIMEOUT_MS` / `PS_PROBE_MAX_BUFFER` consts (L141-143); `SLUG_RX` map (delegated to provider-poller-match.ts) | `execFileSync('tmux', ...)` (L36); `execFileSync('/bin/ps', ...)` (L39, L181); `execFileSync('/usr/bin/pgrep', ...)` (L42); `readFileSync(bot.pid)` (L198); `readFileSync(RESPAWN_STAMP_FILE)` (L231); `statSync(KEEPALIVE_FILE)` (L243); `process.kill(pid, 0)` isPidAlive probe (L208) | **Low for tests.** `snapshotProcsWithRetry` retries the ps probe once before declaring `'unknown'` (L149-154), per the inline comment at L132-140. **Medium for production.** The lazy `tmuxBin` cache survives process restart only via tmux itself, not Node — so a tmux PATH gap on a freshly-spawned coordinator triggers the `Error('Required binary not found on PATH: tmux')` from `platform.ts:63`. This is unchanged by a class refactor. | 4 (`channel-monitor.test.ts:259`, `channel-monitor-baseline.test.ts:222`, `channel-monitor-coverage.test.ts:243`, `schedule-mcp-precheck-full.test.ts:80`) | 3 (1 internal: `channel-coordinator.ts:37`; 2 external: `web/channel-monitor.ts:50`, `web/schedule-mcp-precheck.ts:22`) |
| `src/channel-coordinator/provider-poller-match.ts` (sub-scope of `liveness.ts`) | 92 | Pure utilities + const `SLUG_RX` | 0 | `RUNTIME_TOKEN_RX` (L21); `SLUG_RX: Record<ChannelProviderType, RegExp>` (L49-55); `SLACK_SOCKET_MODE_RX` (L70) | none | **None.** Frozen regex constants + one pure function. | 0 (covered via `provider-poller-match.test.ts` direct exercise; no module mock needed because it has no I/O) | 1 (`src/channel-coordinator/liveness.ts:18`) |

**Test mock totals (G scope, verified 2026-08-30):**

- `vi.mock('../channel-coordinator.js')` (the entry file): **0 sites**
- `vi.mock('../channel-coordinator/telegram-client.js')`: **0 sites**
- `vi.mock('../channel-coordinator/ingest.js')`: **1 site** (`messages-routes.test.ts:101`)
- `vi.mock('../channel-coordinator/liveness.js')`: **4 sites**
- **Total: 5 vi.mock sites across 4 files** (vs framework M3's note of "17 mocks for channel-provider"; channel-coordinator has 70% fewer mocks because it is structurally a single-process runner rather than a per-call provider)
- 10 dedicated `channel-coordinator-*.test.ts` files exercise G directly without `vi.mock`: `channel-coordinator.test.ts`, `channel-coordinator-full.test.ts`, `channel-coordinator-bootstrap-extra.test.ts`, `channel-coordinator-ingest.test.ts`, `channel-coordinator-liveness.test.ts`, `channel-coordinator-lock.test.ts`, `channel-coordinator-lock-live-pid.test.ts`, `channel-coordinator-process-batch.test.ts`, `channel-coordinator-reconcile.test.ts`, `channel-coordinator-runloop-extra.test.ts`, `channel-coordinator-telegram-client.test.ts`

---

## channel-coordinator.ts deep-dive (the entry point)

### The 4 module-level mutable lets

`channel-coordinator.ts:101-106` declares:

```ts
let state: State = 'idle'          // L101 — 'idle' | 'backfilling'
let downStreak = 0                  // L102 — consecutive DOWN probes (debounce)
let stopping = false                // L103 — SIGTERM/SIGINT latch
let nativeConfirmedUpUntil = 0      // L106 — epoch-ms; 409-cooldown expiry
```

These are the **entire** state surface of the G subsystem. The state
machine `state × downStreak × stopping × nativeConfirmedUpUntil` plus the
local `transientAttempt` inside `runLoop` (L312) is the only state the
poller holds between ticks. They are the canonical "4 mutable bindings"
flagged in `review-correctness.md` m9 and the `01 §1` plan claim —
verified verbatim at `channel-coordinator.ts:101-106`.

**Critical caveat for the class refactor:** these 4 lets MUST move
together into the same class instance, because `runLoop` (L311-403)
reads AND writes all 4 from within its single `while (!stopping)` body
(L313 → L322 → L323 → L324 → L331 → L339 → L356 → L373 → L375).
Splitting them across 4 fields of a class is fine; splitting them across
4 classes (e.g. one for the state machine, one for the cooldown timer)
introduces ordering hazards between the 4 reads at L322, L335, L338,
L339, L354, L372-378, L393 — and per `CLAUDE.md §1` the simplest design
that solves the problem is the right one.

### `PID_FILE` const + 4 usage sites

`PID_FILE` is declared at `channel-coordinator.ts:98` as
`join(STATE_DIR, 'coordinator.pid')`. It is a `const` (NOT a mutable
binding — `review-correctness.md` m9 verified this), and is used at:

| Line | Usage | Reads/writes |
|---|---|---|
| L144 | `existsSync(PID_FILE)` in `acquireSingleInstanceLock` | read |
| L145 | `readFileSync(PID_FILE, 'utf-8')` in `acquireSingleInstanceLock` | read |
| L156 | `writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 })` in `acquireSingleInstanceLock` | write |
| L161 | `readFileSync(PID_FILE, 'utf-8')` + `unlinkSync(PID_FILE)` in `releaseLock` | read+delete |

Per `review-correctness.md` m9 the "2 pid-file" wording is wrong — it
counts references, not bindings. The correct characterization is "1 const
PID_FILE referenced at 4 sites, 3 reads + 1 write + 1 unlink + 1
existsSync". The const is **content-immutable** (filesystem-path only)
but the file it points at is mutable state that crosses the process
boundary (a sibling coordinator process holding the lock).

### `installSignalHandlers` (L407-420)

```ts
function installSignalHandlers(): void {
  const onSignal = (sig: string) => {
    if (stopping) return
    stopping = true
    logger.info({ sig }, 'channel-coordinator: shutting down')
    setTimeout(() => {
      releaseLock()
      closeIngestDb()
      process.exit(0)
    }, 3000)
  }
  process.on('SIGTERM', () => onSignal('SIGTERM'))
  process.on('SIGINT', () => onSignal('SIGINT'))
}
```

Two signal handlers, registered ONCE in `main()` at L426. Re-entry
hazard: calling `installSignalHandlers()` twice would double-register
`onSignal`, and the SIGTERM latch would fire twice. Per the per-file
inventory there is no idempotency guard, but `main()` is only called
from the L435 entry-point guard, so production re-init is not an issue;
a class refactor that moves this to a constructor must NOT expose a
public `installSignalHandlers()` method unless it adds `process.listenerCount`
checks.

### `runLoop` state-machine flow (L311-403)

The state machine is **`idle ⇄ backfilling`** with two exits (fatal +
shutdown):

1. **Every tick** (both states): `reconcilePending()` — re-hand-off
   abandoned/stranded events (L315, defined L270-298). This is the
   **no-message-loss invariant**: a frozen main agent delays a message,
   never LOSES it (per the file-level comment L262-269).

2. **`idle` branch (L317-349):**
   - Probe native liveness via `probeNativeChannelDown(SESSION, PROVIDER)`
     (L322) — short-circuited by the 409 cooldown.
   - Increment `downStreak` (L323) or reset to 0 on UP (else-branch).
   - If `downStreak >= DOWN_DEBOUNCE` (L324, constant=2): enter
     `backfilling`. **First** call `probeHighWater(token)` to seed the
     poll_offset (L329-330) so the coordinator never re-delivers
     messages the native already saw (file-level comment L18-25).
   - Sleep `TICK_MS` (L347, constant=5s).

3. **`backfilling` branch (L351-402):**
   - Yield-before-poll: if native is back UP, transition to `idle` and
     `continue` (L354-358).
   - Call `getUpdates(token, getOffset(SOURCE) + 1, ...)` (L362) with
     exponential backoff on transient failures (L383).
   - Handle 409: the **authoritative "native is back" signal** (L372-377).
     Set cooldown + transition to `idle`.
   - Handle 429: sleep `retryAfterSec` then `continue` (L378-381).
   - Handle fatal: `fatalExit` → notify.sh + exit 1 (L366, defined L302-307).
   - **Yield-before-handoff**: after a successful poll but before
     `processBatch`, re-probe liveness; if native is back, DISCARD the
     batch (L393-397) — the native will deliver from its own offset.
   - Persist offset ONLY after `processBatch` returns (L401).

The shape is **two coupled state machines**: the lifecycle state (`state`,
`downStreak`, `stopping`) and the cooldown timer (`nativeConfirmedUpUntil`).
A class refactor produces a single `ChannelCoordinator` with private
fields `state`, `downStreak`, `stopping`, `nativeConfirmedUpUntil`,
plus a `runLoop()` method that operates on `this.*`. The constructor
takes no state; everything is initialized to defaults.

### Entry-point guard (L435)

```ts
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(...)
}
```

This is the **only** mechanism that prevents `main()` from running when
the file is imported (e.g., by tests). It is the G counterpart to
`web.ts`'s "if the file is the entry point, start the server" pattern.
A class refactor **must preserve this guard verbatim** — it is what lets
`vi.mock('../channel-coordinator/...')` substitutes avoid kicking off a
second coordinator process. Per `CLAUDE.md §3` the guard is load-bearing
and must not be "improved" during the refactor.

---

## telegram-client.ts deep-dive

### `TelegramApiError` class (L45-54)

```ts
export class TelegramApiError extends Error {
  constructor(
    public readonly kind: TelegramErrorKind,
    message: string,
    public readonly retryAfterSec?: number,
  ) {
    super(message)
    this.name = 'TelegramApiError'
  }
}
```

This is the **only class in G scope today** (per the framework
`review-completeness.md` CE-1, which missed this class in its "9 existing
classes" inventory — it is one of the 10 classes total). It carries:

- `kind: 'fatal' | 'rate_limit' | 'conflict' | 'transient'` — the
  discriminator that drives the 5 branch sites at
  `channel-coordinator.ts:335, 338, 366, 372, 378` (`err.kind === 'fatal'`,
  `'conflict'`, `'rate_limit'`).
- `retryAfterSec?: number` — the Bot-API `parameters.retry_after` for 429
  responses (read at `channel-coordinator.ts:379`).
- Standard `name = 'TelegramApiError'` literal set in the constructor
  body (L52). Under H.4's `AppError` base this becomes
  `new.target.name`, which is the same string — zero behavioural change.
- No `cause` chain (per `h-cross-cutting/03-class-boundaries.md:219` —
  one of the 8 of 9 classes that doesn't pass `cause` to `super`).

**Refactor implications:**

- `review-completeness.md` OE-1/OE-2 reasoning rejects splitting
  `TelegramApiError` into a subclass per `kind`. The class survives
  verbatim.
- `h-cross-cutting/03-class-boundaries.md:305-311` defers `TelegramApiError`
  conversion **longest**: its `kind` discriminator drives control flow at
  5 sites in `channel-coordinator.ts`, so the conversion carries the
  most risk for the least gain. The H.4 brief picks
  `RequestBodyTooLargeError` + `PeerResponseTooLargeError` first; G
  should not touch this class in the first H.4 wave.
- The `instanceof TelegramApiError` checks at `channel-coordinator.ts:335, 338, 366, 372, 378` keep working unchanged if `TelegramApiError` is moved into a `ChannelCoordinatorError` namespace or kept at the top level of `telegram-client.ts`.

### State held by `telegram-client.ts`

**Zero module-level state.** The two consts `API_BASE` (L15) and
`ALLOWED_UPDATES` (L21) are frozen strings/arrays; the `AbortController`
+ `setTimeout` pair at L149-150 and L202-203 is per-call (cleared in
`finally` at L163 and L215). The class form would have a single
`TelegramClient` class with these as private static fields plus
`getUpdates`/`probeHighWater` as methods.

### Telegram API connection pattern

`getUpdates(token, offset, timeout, limit)` (L143-190) is a long-poll:

- `POST https://api.telegram.org/bot<token>/getUpdates` with body
  `{ offset, timeout, limit, allowed_updates: ALLOWED_UPDATES }` (L156).
- `AbortController` aborts after `(timeout + 10) * 1000` ms (L150) so a
  wedged connection tears down ~10s after Telegram's own long-poll
  deadline.
- Error classification (L166-185) maps HTTP status codes to
  `TelegramErrorKind`:
  - 401 → `'fatal'` (L179)
  - 409 → `'conflict'` (L180)
  - 429 → `'rate_limit'` (L181), carries `retryAfterSec`
  - 5xx → `'transient'` (L182)
  - 400/403/other 4xx → `'fatal'` (L184) — "configuration bugs, not
    transient" per the inline comment.
- Body parse (L168-177) is defensive: a proxy 5xx may not be JSON, so the
  catch falls back to `errorCode = res.status, description = 'HTTP ###'`.

`probeHighWater(token)` (L201-226) is the seed probe used to advance
`poll_offset` to the current high-water mark BEFORE entering BACKFILLING
(channel-coordinator.ts:329). It uses `offset: -1, limit: 1, timeout: 0`
(L209) per Telegram's "negative offset returns the last N updates
without advancing the confirmed pointer" semantics. The inline comment
L193-200 calls out two non-obvious invariants: (a) the call is
non-destructive (no offset advance), and (b) `allowed_updates` is
deliberately **omitted** because Telegram REMEMBERS the last
`allowed_updates` passed, so sending ours would alter what the native
plugin's poll receives — a subtle bug class. Both invariants must
survive the class refactor.

### Error structure (kind-discriminated)

`TelegramApiError` is the **only** class in G that uses a discriminator.
The 4 kind values map to 4 distinct control-flow paths in
`channel-coordinator.ts:runLoop`:

| `kind` | Site in `runLoop` | Action |
|---|---|---|
| `'fatal'` | L335 (idle seed), L366 (backfill poll) | `await fatalExit(err)` → notify.sh + `process.exit(1)` |
| `'conflict'` | L338 (idle seed), L372 (backfill poll) | Set `nativeConfirmedUpUntil = Date.now() + 90s`; transition to `idle` |
| `'rate_limit'` | L378 (backfill poll only) | `await sleep((retryAfterSec ?? 5) * 1000)` |
| `'transient'` | (implicit, falls through to L383) | `await sleep(transientBackoffMs(...))` |

---

## ingest.ts deep-dive

### Module-level state: the `db` singleton (L25)

```ts
let db: Database | null = null
```

This is the only mutable binding in `ingest.ts`. `initIngestDb` (L27-91)
opens the handle, runs CREATE TABLE IF NOT EXISTS for `incoming_events`
(L36-54), the unique index (L58), the status index (L59),
`poll_offset` (L62-66), and defensively `agent_messages` (L76-86) — the
file-level comment L69-74 explains this is a boot-race guard so the
coordinator can hand off messages even if its launchd unit wins the
race to `store/claudeclaw.db` before the dashboard's `initDatabase`
runs.

The singleton has two idempotency mechanisms:

1. `initIngestDb` returns the existing handle if `db` is set (L28).
2. `closeIngestDb` (L225-230) nulls the handle after closing.

A class refactor collapses this to:

```ts
class IngestStore {
  constructor(
    private readonly db: Database,   // injected, not constructed here
  ) {}
  insertIncomingEvent(source, ev): InsertResult { ... }
  createHandoffMessage(content): number { ... }
  markEventDelivered(...): void { ... }
  markEventFailed(...): void { ... }
  getEventsNeedingHandoff(source, limit): IncomingEventRow[] { ... }
  getOffset(source): number { ... }
  setOffset(source, lastUpdateId): void { ... }
  close(): void { this.db.close() }
}
```

The `Database` handle is constructed by `App` (D.3 keystone) once at
boot, then injected. Per A.1's pattern (`a-db/00-summary.md`),
`IngestStore` would be an A-scope entity store that owns the
`incoming_events` + `poll_offset` tables; per the framework plan these
are 2 tables that don't exist in the dashboard schema, so they are G-owned
and A does NOT need to absorb them. **The coordinator owns its own DB
layer** — see `ingest.ts:1-9` ("The coordinator is a SEPARATE process
from the dashboard, so it cannot share the dashboard's sqlite singleton
(`src/db.ts`). It opens its OWN handle to the same
`store/claudeclaw.db` file."). This is a load-bearing constraint: G
cannot delegate to the dashboard's `db.ts` even after A.7 removes the
singleton.

### Message reception: there is no queue or buffer

`ingest.ts` is **not** the message-reception layer — it is the
**persistence layer** for messages received by `telegram-client.ts` and
processed by `channel-coordinator.ts:processBatch`. The reception path
is:

1. `getUpdates(token, offset, timeout, limit)` returns a batch of raw
   updates from the Bot API (telegram-client.ts:143-190).
2. `mapUpdate(raw)` (telegram-client.ts:98-137) normalizes a raw update
   into a `NormalizedEvent` (returns `null` for unhandled update kinds
   so the caller still advances the offset past them).
3. `processBatch(updates)` (channel-coordinator.ts:233-258) loops the
   batch:
   - `insertIncomingEvent(SOURCE, ev)` → INSERT OR IGNORE on the unique
     `(source, update_id)` index; returns `{ inserted, eventId }`
     (ingest.ts:126-150).
   - If newly inserted: `createHandoffMessage(buildHandoffContent(ev))`
     → INSERT INTO `agent_messages` with `from_agent =
     'telegram-coordinator'`, `to_agent = MAIN_AGENT_ID`
     (ingest.ts:160-166).
   - `markEventDelivered(ins.eventId, agentMessageId)` → UPDATE
     `incoming_events` status to 'delivered' (ingest.ts:168-173).

**There is no queue or buffer in G.** The "queue" is the SQLite WAL:
`incoming_events` rows with `status = 'pending'` or
`agent_message_id IS NULL` ARE the queue. The reconciliation loop in
`channel-coordinator.ts:reconcilePending` (L270-298) is the
"queue-flush on crash recovery" mechanism — it picks up rows that
`getEventsNeedingHandoff` returns (ingest.ts:190-204) and re-hands them
off.

### Integration with `channelProvider` (D subsystem)

`ingest.ts` **does not import** `channel-provider.ts`. It is
provider-agnostic: the `source` column on `incoming_events` is a plain
`TEXT` (L38, defaulted to `'telegram'`), and the `COORDINATOR_AGENT_ID`
constant (L23) is `'telegram-coordinator'`. If a second channel
provider ever wants the same backfill behavior, the schema supports it
(distinct `source` values), but no second implementation exists today.
The 3 external consumers of `ingest.ts` (web/agent-message-wrap.ts:21,
web/federation/local-catalog.ts:8, web/routes/messages.ts:11) import
only the `COORDINATOR_AGENT_ID` const to filter the
`agent_messages.from_agent` column on their own queries.

---

## liveness.ts deep-dive

### Liveness tracking: pure functions + lazy tmuxBin

`liveness.ts` exports 9 free functions and no classes. The state surface
is exactly one lazy resolver:

```ts
const tmuxBin = makeLazyBinResolver('tmux')  // L20
```

Per `platform.ts:74` (`makeLazyBinResolver`) this is a closure that
caches the resolved binary path on first call. Re-init hazard: the cache
is module-scope, so under `vi.resetModules()` a new `tmuxBin` resolver
is created and the first call re-runs `resolveFromPath('tmux')`.

### The 9 exported functions

| Function | Line | Pure? | Notes |
|---|---|---|---|
| `getClaudePidForSession(session)` | L34-49 | impure (execFileSync × 2) | tmux `list-panes` + `/bin/ps -p` + `/usr/bin/pgrep -P` |
| `decideHasPluginAlive(ctx)` | L72-130 | **pure** | takes parsed ps snapshot + bot.pid + isPidAlive predicate; provider-specific tree-walk using `matchesProviderPollerCmd` |
| `snapshotProcsWithRetry(run, timeouts?)` | L145-155 | impure (calls `run`) | retry once with a longer deadline; `logger.debug` on first failure (L152) |
| `probeChannelPluginLiveness(claudePid, provider, agentName?)` | L164-217 | impure (execFileSync + readFileSync) | wraps `decideHasPluginAlive`; returns `'alive' \| 'down' \| 'unknown'` (tri-state per the inline comment L160-162) |
| `hasChannelPluginAlive(claudePid, provider, agentName?)` | L223-225 | impure | boolean view: `probeChannelPluginLiveness(...) === 'alive'` |
| `readRespawnStampMs()` | L229-236 | impure (readFileSync) | returns `0` on missing/unreadable |
| `readKeepaliveAgeMs(nowMs)` | L241-247 | impure (statSync) | returns `null` on missing/unreadable |
| `decideNativeChannelDown(f)` | L266-272 | **pure** | conservative: startup-grace → process-gone → keepalive-stale (L267-271) |
| `probeNativeChannelDown(session, provider, agentName?)` | L276-287 | impure | side-effecting wrapper that gathers facts and calls `decideNativeChannelDown` |

The two **pure** deciders (`decideHasPluginAlive`, `decideNativeChannelDown`)
follow the `decideStuckToolCallRecovery` pattern from `pane-state.ts:1607`
(per the inline comment at liveness.ts:54-61). They are the testable
seams.

### Timer / heartbeat pattern

`liveness.ts` itself does **not** run any timers — the tick loop is
`channel-coordinator.ts:runLoop` (L311-403) which calls
`probeNativeChannelDown` every `TICK_MS` (5s, L60 of channel-coordinator.ts).
The "heartbeat" referenced in the file-level comment L22-26 is the
**scheduled keepalive prompt** inside the marveen-channels TUI that
touches `store/.channel-keepalive` every ~6 min. If the TUI is wedged
the keepalive file ages past `KEEPALIVE_STALE_MS = 18 * 60 * 1000` (18
min, L26), and `decideNativeChannelDown` flips the native to "down" via
the `keepaliveAgeMs > KEEPALIVE_STALE_MS` branch (L270). This is the
"alive process but stuck TUI" detection path.

### `downStreak` interaction with channel-coordinator

`downStreak` lives in `channel-coordinator.ts:102`, NOT in
`liveness.ts`. The interaction is:

1. `runLoop` (channel-coordinator.ts:317-349) calls
   `probeNativeChannelDown(SESSION, PROVIDER)` (L322).
2. If DOWN (and not in 409 cooldown, L322), increment `downStreak` (L323);
   else reset to 0.
3. If `downStreak >= DOWN_DEBOUNCE` (L324, constant=2), enter
   BACKFILLING.

`DOWN_DEBOUNCE = 2` (channel-coordinator.ts:64) is the **single-tick
slop tolerance**: a single transient process-tree race or restart blip
must not flip the coordinator into polling (file-level comment L62-64).

---

## Cross-file state sharing

The 4 files share state via **module imports + module-side lets**, not
via class instances (because no class exists today):

| State | Owner | Read by |
|---|---|---|
| `state` (idle/backfilling) | `channel-coordinator.ts:101` | `runLoop` only (single-process) |
| `downStreak` | `channel-coordinator.ts:102` | `runLoop` only |
| `stopping` | `channel-coordinator.ts:103` | `runLoop`, `installSignalHandlers.onSignal` |
| `nativeConfirmedUpUntil` | `channel-coordinator.ts:106` | `runLoop` (read at L322), `runLoop` (write at L339, L373) |
| `db` (ingest singleton) | `ingest.ts:25` | `initIngestDb`, `closeIngestDb`, `requireDb` (L93), every per-call query helper |
| `tmuxBin` lazy cache | `liveness.ts:20` | `getClaudePidForSession` (L36) |
| `PID_FILE` filesystem content | external (other coordinator process) | `acquireSingleInstanceLock` (L144-156), `releaseLock` (L161) |
| `poll_offset` row in SQLite | `ingest.ts` writes via `setOffset` (L216-223), reads via `getOffset` (L206-211) | `channel-coordinator.ts:runLoop` (L330, L362, L401) |
| `incoming_events` rows | `ingest.ts` writes via `insertIncomingEvent` (L126-150), reads via `getEventsNeedingHandoff` (L190-204) | `channel-coordinator.ts:processBatch` (L242), `reconcilePending` (L273) |
| `agent_messages` rows | `ingest.ts` writes via `createHandoffMessage` (L160-166) | external `message-router` in the dashboard process (not in G scope) |

**No state is shared via function arguments across the 4 files.** The
4 module-lets in `channel-coordinator.ts` are all in-process; the
`db` singleton in `ingest.ts` is also in-process; the `tmuxBin` lazy
cache is in-process. The only **cross-process** state is the SQLite WAL
file (`store/claudeclaw.db`) and the PID file at `STATE_DIR/coordinator.pid`.

**Class refactor implication:** all 4 module-lets move to a single
`ChannelCoordinator` class; `db` moves to `IngestStore` (or stays a
module singleton until A.7 deletes it); `tmuxBin` becomes a private
field on a `LivenessProbe` class or stays as the `LazyBin` instance per
H.3. The cross-process state is untouched by the refactor.

---

## ChannelProvider (D subsystem) integration

`channel-coordinator.ts` consumes the D subsystem at exactly **one point**:
the `PROVIDER` constant at `channel-coordinator.ts:57`:

```ts
const PROVIDER = CHANNEL_PROVIDER
```

`CHANNEL_PROVIDER` is imported from `./config.js` (L35) and is the
`ChannelProviderType` for the main agent's channel (typically `'telegram'`).
It is passed as the second argument to `probeNativeChannelDown(SESSION,
PROVIDER)` at `channel-coordinator.ts:322, 354, 393` (3 callsites). The
`SESSION` is `'${MAIN_AGENT_ID}-channels'` (L56), e.g.
`main-agent-channels`.

**`channel-coordinator.ts` does NOT import `ChannelProvider`, `getProvider`,
or any provider method.** It only consumes the `ChannelProviderType` enum
as a discriminator for `probeNativeChannelDown`. This is the lightest
possible coupling to D — the coordinator never SENDS a message (outbound
stays with the native plugin, per `telegram-client.ts:8-13`); it only
needs to know which provider's plugin to monitor for liveness.

After D.5 (`ChannelEnv` migration per `d-channel-provider/00-summary.md`),
the `PROVIDER` value still resolves to the same `ChannelProviderType`
string. The class refactor does NOT need to migrate the import path
unless D moves the `ChannelProviderType` type definition itself.

`liveness.ts:16` imports `channelStateDir, type ChannelProviderType` from
`../channel-provider.js`. Per D.5's plan, `channelStateDir` survives as a
free function (or becomes `ChannelEnv.stateDirFor(provider, agentDir?)`
static method); `type ChannelProviderType` survives unchanged. Both
imports remain valid after D.5.

`ingest.ts` does not import `channel-provider.js` at all.

`telegram-client.ts` does not import `channel-provider.js` at all.

`provider-poller-match.ts:16` imports `type ChannelProviderType` only —
survives unchanged.

---

## ChannelPairingStore (A subsystem) integration

**There is no `ChannelPairingStore` in the current codebase.** The brief
references "ChannelPairingStore (A subsystem)" but a grep for
`ChannelPairingStore` returns no results in `src/`. What exists instead:

- `ingest.ts:23` `COORDINATOR_AGENT_ID = 'telegram-coordinator'` — the
  sender identity on the handoff row.
- `config.ts:MAIN_AGENT_ID` — the recipient of the handoff row.
- `buildHandoffContent` (channel-coordinator.ts:189-215) — the `<channel
  ...>` block that the message-router's `wrapUntrusted` recognizes as a
  channel-inbound message.

The coordinator's hand-off to the main agent uses the existing
`agent_messages` table (ingest.ts:76-86, L160-166). The "pairing" semantics
(implicit chat_id → agent mapping) live in the dashboard's
`channel-pairing.ts` (NOT in G scope) and are read by the message-router,
not by the coordinator.

If A's plan (`a-db/00-summary.md`) eventually defines a `ChannelPairingStore`
class, it does NOT need to be a G dependency: the coordinator only writes
`agent_messages` rows with a fixed `from_agent = 'telegram-coordinator'`,
and the message-router does the pairing lookup. **There is no G → A
ChannelPairingStore edge in the current code.**

---

## Test mock patterns (per-file)

Verified on 2026-08-30 against `src/__tests__/`.

### `channel-coordinator.ts` (the entry file)

**Zero `vi.mock('../channel-coordinator.js')` sites.** The 10 dedicated
test files (`channel-coordinator-*.test.ts`) call into the module
directly:

- `channel-coordinator.test.ts` — entry-point guard + `inNative409Cooldown` + `transientBackoffMs` + `neutralizeChannelTags` + `buildHandoffContent` (exported free functions)
- `channel-coordinator-full.test.ts` — bootstrap integration
- `channel-coordinator-bootstrap-extra.test.ts` — `readToken` + `acquireSingleInstanceLock`
- `channel-coordinator-ingest.test.ts` — processBatch + reconcile via `ingest.ts`
- `channel-coordinator-liveness.test.ts` — provider-poller-match + liveness
- `channel-coordinator-lock.test.ts` — `acquireSingleInstanceLock` edge cases
- `channel-coordinator-lock-live-pid.test.ts` — live-pid reclaim
- `channel-coordinator-process-batch.test.ts` — `processBatch` direct
- `channel-coordinator-reconcile.test.ts` — `reconcilePending` direct
- `channel-coordinator-runloop-extra.test.ts` — `runLoop` 409-cooldown + 401-fatal
- `channel-coordinator-telegram-client.test.ts` — `mapUpdate` + `getUpdates` + `probeHighWater` + `TelegramApiError`

These tests do NOT mock the entry file because the file does nothing at
import time (the L435 entry-point guard prevents `main()` from running
when imported). The class refactor must preserve this property: if
`ChannelCoordinator` exposes a constructor that opens the DB or installs
signal handlers, every test that today calls
`new ChannelCoordinator()` would need to mock the dependencies.

### `telegram-client.ts`

**Zero `vi.mock` sites.** Covered by `channel-coordinator-telegram-client.test.ts`
which exercises `mapUpdate`, `getUpdates`, `probeHighWater`, and
`TelegramApiError` directly. The class form (`TelegramClient`) would be
exercised the same way — no mock infrastructure needed.

### `ingest.ts`

**1 `vi.mock` site:** `messages-routes.test.ts:101` mocks
`../channel-coordinator/ingest.js` to substitute the `COORDINATOR_AGENT_ID`
const for the test's own value. The DB functions are not exercised by
any external test (the 3 external production consumers all import only
the const, not the DB functions).

### `liveness.ts`

**4 `vi.mock` sites:**

| File | Line | Reason |
|---|---:|---|
| `channel-monitor.test.ts` | 259 | The monitor's own tests substitute the liveness helpers to avoid `ps`/`tmux` exec calls in CI |
| `channel-monitor-baseline.test.ts` | 222 | Same — baseline coverage suite |
| `channel-monitor-coverage.test.ts` | 243 | Same — coverage suite |
| `schedule-mcp-precheck-full.test.ts` | 80 | The precheck uses `getClaudePidForSession`; test substitutes it |

The mock shape is consistent across all 4: a `vi.mock(..., () => ({ getClaudePidForSession: vi.fn(), hasChannelPluginAlive: vi.fn(), probeChannelPluginLiveness: vi.fn() }))`.
The class refactor must preserve the function-level mock surface: if
`liveness.ts` becomes a `LivenessProbe` class, the 4 tests will need to
either (a) `vi.mock('../channel-coordinator/liveness.js', () => ({ LivenessProbe: vi.fn().mockImplementation(...) }))`
or (b) accept a `LivenessProbe` instance via DI and provide a
`createTestLivenessProbe()` factory. Option (b) aligns with
`review-completeness.md` CE-5's "createTestX factory" pattern.

### `provider-poller-match.ts` (sub-scope of `liveness.ts`)

**Zero `vi.mock` sites.** Covered by `provider-poller-match.test.ts`
(direct exercise; the file has no I/O so mocking adds nothing).

---

## Integration consumers

The full production-consumer map (excluding `__tests__/` and the G
files themselves):

### `channel-coordinator.ts`

**Zero production importers** — the file is run as a process, not
imported. The `import.meta.url === pathToFileURL(process.argv[1]).href`
guard at L435 is the contract that prevents recursive invocation.

### `telegram-client.ts`

**1 production importer:**

- `src/channel-coordinator.ts:36` — `import { getUpdates, probeHighWater, mapUpdate, TelegramApiError } from './channel-coordinator/telegram-client.js'`

### `ingest.ts`

**4 production importers (1 internal + 3 external const-only):**

- `src/channel-coordinator.ts:38-48` — internal: `initIngestDb, insertIncomingEvent, createHandoffMessage, markEventDelivered, getEventsNeedingHandoff, getOffset, setOffset, closeIngestDb, type InsertResult`
- `src/web/agent-message-wrap.ts:21` — external: `COORDINATOR_AGENT_ID` only
- `src/web/federation/local-catalog.ts:8` — external: `COORDINATOR_AGENT_ID` only
- `src/web/routes/messages.ts:11` — external: `COORDINATOR_AGENT_ID` only

The 3 external consumers import only the `COORDINATOR_AGENT_ID` const
to filter their queries by `from_agent`. A refactor that moves
`COORDINATOR_AGENT_ID` into an `IngestStore` class MUST re-export the
const (or the 3 consumers must migrate to `app.ingestStore.coordinatorAgentId`).

### `liveness.ts`

**3 production importers (1 internal + 2 external):**

- `src/channel-coordinator.ts:37` — internal: `probeNativeChannelDown`
- `src/web/channel-monitor.ts:50` — external:
  `getClaudePidForSession, hasChannelPluginAlive, probeChannelPluginLiveness`
- `src/web/schedule-mcp-precheck.ts:22` — external: `getClaudePidForSession`

The 2 external consumers in `web/` are part of the channel-monitor and
schedule-mcp-precheck subsystems; they share the liveness helpers with
the coordinator per the file-level comment L1-8 ("shared by the
dashboard's channel-monitor and the standalone channel-coordinator").

### `provider-poller-match.ts`

**1 production importer (within G):**

- `src/channel-coordinator/liveness.ts:18` — `matchesProviderPollerCmd`

Plus the test file `provider-poller-match.test.ts`.

---

## Cross-references (verified file:line)

- `src/channel-coordinator.ts:98` — `const PID_FILE = join(STATE_DIR, 'coordinator.pid')`
- `src/channel-coordinator.ts:101-106` — 4 module-level lets
- `src/channel-coordinator.ts:117-136` — `readToken`
- `src/channel-coordinator.ts:142-157` — `acquireSingleInstanceLock` (PID_FILE write at L156)
- `src/channel-coordinator.ts:159-163` — `releaseLock` (PID_FILE unlink at L161)
- `src/channel-coordinator.ts:170-175` — `sendAlert` (notify.sh exec)
- `src/channel-coordinator.ts:182-184` — `neutralizeChannelTags` (exported)
- `src/channel-coordinator.ts:189-215` — `buildHandoffContent` (exported)
- `src/channel-coordinator.ts:221-224` — `transientBackoffMs` (exported)
- `src/channel-coordinator.ts:233-258` — `processBatch`
- `src/channel-coordinator.ts:270-298` — `reconcilePending`
- `src/channel-coordinator.ts:302-307` — `fatalExit`
- `src/channel-coordinator.ts:311-403` — `runLoop` (state machine)
- `src/channel-coordinator.ts:407-420` — `installSignalHandlers`
- `src/channel-coordinator.ts:422-431` — `main`
- `src/channel-coordinator.ts:435` — entry-point guard
- `src/channel-coordinator/telegram-client.ts:45-54` — `class TelegramApiError`
- `src/channel-coordinator/telegram-client.ts:98-137` — `mapUpdate`
- `src/channel-coordinator/telegram-client.ts:143-190` — `getUpdates`
- `src/channel-coordinator/telegram-client.ts:201-226` — `probeHighWater`
- `src/channel-coordinator/ingest.ts:23` — `COORDINATOR_AGENT_ID = 'telegram-coordinator'`
- `src/channel-coordinator/ingest.ts:25` — `let db: Database | null = null`
- `src/channel-coordinator/ingest.ts:27-91` — `initIngestDb`
- `src/channel-coordinator/ingest.ts:93-96` — `requireDb`
- `src/channel-coordinator/ingest.ts:126-150` — `insertIncomingEvent`
- `src/channel-coordinator/ingest.ts:160-166` — `createHandoffMessage`
- `src/channel-coordinator/ingest.ts:168-173` — `markEventDelivered`
- `src/channel-coordinator/ingest.ts:175-177` — `markEventFailed`
- `src/channel-coordinator/ingest.ts:190-204` — `getEventsNeedingHandoff`
- `src/channel-coordinator/ingest.ts:206-211` — `getOffset`
- `src/channel-coordinator/ingest.ts:216-223` — `setOffset`
- `src/channel-coordinator/ingest.ts:225-230` — `closeIngestDb`
- `src/channel-coordinator/liveness.ts:20` — `const tmuxBin = makeLazyBinResolver('tmux')`
- `src/channel-coordinator/liveness.ts:25-30` — keepalive / respawn file paths
- `src/channel-coordinator/liveness.ts:34-49` — `getClaudePidForSession`
- `src/channel-coordinator/liveness.ts:72-130` — `decideHasPluginAlive` (pure)
- `src/channel-coordinator/liveness.ts:141-155` — `snapshotProcsWithRetry`
- `src/channel-coordinator/liveness.ts:164-217` — `probeChannelPluginLiveness`
- `src/channel-coordinator/liveness.ts:223-225` — `hasChannelPluginAlive`
- `src/channel-coordinator/liveness.ts:266-272` — `decideNativeChannelDown` (pure)
- `src/channel-coordinator/liveness.ts:276-287` — `probeNativeChannelDown`
- `src/channel-coordinator/provider-poller-match.ts:21` — `RUNTIME_TOKEN_RX`
- `src/channel-coordinator/provider-poller-match.ts:49-55` — `SLUG_RX`
- `src/channel-coordinator/provider-poller-match.ts:70` — `SLACK_SOCKET_MODE_RX`
- `src/channel-coordinator/provider-poller-match.ts:82-91` — `matchesProviderPollerCmd`

---

## End of G module/state analysis. No source file modified.
