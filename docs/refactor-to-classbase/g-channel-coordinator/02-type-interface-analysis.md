# G (channel-coordinator) — Type and interface analysis

Planning only — no source file modified. Every count, line ref, and
type shape below was verified with Read + grep against
`/Users/eggp/marveen-develop/test-baseline/src/` on 2026-08-30. This
file closes `review-correctness.md` m2 (the missing `02` flagged as an
[ASSUMPTION] in `00-summary.md:148`) and adopts the m1-corrected LOC
figures (441 / 226 / 230 / 287 / 91, not 442 / 227 / 231 / 288 / 92).

---

## Brief summary

The G subsystem's type surface is unusually small and unusually clean:
**5 exported interfaces + 3 exported type aliases + 4 non-exported
declarations across 1275 LOC**, with **zero `as any`, zero `: any`,
zero `as unknown as`, and zero `satisfies`** — the "type-safe by
construction" pattern holds across all five files, and the 8 `as` casts
that do exist are all at genuine I/O boundaries (`res.json()`,
`.get()` / `.all()` SQLite rows, `JSON.parse`), mirroring A's
104-boundary-cast pattern at a 13x smaller scale. `TelegramApiError`
(`telegram-client.ts:45-54`) is already a class with a 4-variant `kind`
discriminator, thrown at 12 sites and read at 5 `instanceof` sites, so
G has **no error-class migration to perform** — the class form IS the
current form. The 4 module lets at `channel-coordinator.ts:101-106`
(`state`, `downStreak`, `stopping`, `nativeConfirmedUpUntil`) are the
only mutable type surface and become private fields on `LivenessTracker`
per `03-class-boundaries.md §G3`. **`ChannelCoordinator` is the only G
class that needs `LoggerLike`** (19 logger call sites, not the 17 the
task brief carried — see §7 correction), and per the E/D/F/A/H
precedent **zero generics survive** in G: all four candidate type
parameters are rejected on OE-6 single-consumer grounds.

---

## §1. Per-file type audit

### §1.1 Export counts (verified)

`grep -n "^export interface"` and `grep -n "^export type"` per file:

| File | LOC | `export interface` | `export type` | Non-exported `interface`/`type` | Unsafe casts | Generic opportunities |
|---|---:|---:|---:|---:|---:|---|
| `src/channel-coordinator.ts` | 441 | **0** | **0** | 1 (`type State` L100) | 3 (L200, L237, L281) | none (§5.1) |
| `src/channel-coordinator/telegram-client.ts` | 226 | **1** | **2** | 3 (`RawUpdate` L56, `RawMessage` L69, `RawUser` L81) | 3 (L173, L187, L222) + 1 benign `as const` (L21) | none (§5.2) |
| `src/channel-coordinator/ingest.ts` | 230 | **2** | **0** | 0 | 2 (L203, L207) | none (§5.3) |
| `src/channel-coordinator/liveness.ts` | 287 | **2** | **1** | 0 | **0** | none (§5.4) |
| `src/channel-coordinator/provider-poller-match.ts` | 91 | **0** | **0** | 0 | **0** | none |
| **Total** | **1275** | **5** | **3** | **4** | **8** | **0** |

### §1.2 The 5 exported interfaces (field-by-field)

| Interface | File:line | Fields | Optionality pattern |
|---|---|---:|---|
| `NormalizedEvent` | `telegram-client.ts:25-35` | 9 | Zero optional fields. Nullability is explicit via `\| null` on 5 of 9 (`chat_id`, `user_id`, `username`, `message_id`, `tg_date`); `update_id: number`, `kind: UpdateKind`, `content: string`, `meta: Record<string, unknown>` are total. This is the deliberate "null, not undefined" convention — the row goes straight into SQLite where `NULL` is the storage form. |
| `InsertResult` | `ingest.ts:98-101` | 2 | `inserted: boolean`, `eventId: number \| null`. The correlated-nullability idiom (`eventId` is non-null iff `inserted`) is **not** encoded in the type; the caller re-checks both at `channel-coordinator.ts:247` (`if (!ins.inserted \|\| ins.eventId == null) continue`). A discriminated form `{ inserted: true; eventId: number } \| { inserted: false; eventId: null }` would let the caller narrow with one check — see §6.3 for why it is still rejected. |
| `IncomingEventRow` | `ingest.ts:105-122` | 16 | The full `incoming_events` row. Nullability mirrors the DDL at `ingest.ts:36-54` exactly: 8 of 16 are `\| null` (`chat_id`, `user_id`, `username`, `message_id`, `content`, `meta`, `tg_date`, `agent_message_id`, `error`, `delivered_at` — 10 counting all). `kind: string` and `status: string` are **widened** relative to the DDL `CHECK(status IN ('pending','delivered','done','failed'))` — the type does not carry the CHECK constraint. |
| `PluginAliveContext` | `liveness.ts:62-70` | 7 | The pure-decider input bundle for `decideHasPluginAlive`. 2 optional (`agentName?`, `debugLog?`); `isPidAlive: (pid: number) => boolean` and `debugLog?: (event, fields) => void` are the two injected seams that make the decider testable without `process.kill` or a logger. |
| `NativeStateFacts` | `liveness.ts:249-254` | 4 | The pure-decider input bundle for `decideNativeChannelDown`. All 4 nullable-or-total: `claudePid: number \| null`, `pluginAlive: boolean`, `keepaliveAgeMs: number \| null`, `msSinceLastRespawn: number \| null`. The two `\| null` fields carry "unknown / unreadable" semantics, distinct from a zero value. |

### §1.3 The 3 exported type aliases + 1 non-exported

All four are string-literal unions. There are **no** exported object
type aliases, no mapped types, no conditional types, and no generic type
aliases anywhere in G (verified by `grep -nE "^(export )?type .*=.*\|"`
returning exactly these four lines):

| Alias | File:line | Variants | Exhaustively switched? |
|---|---|---:|---|
| `UpdateKind` | `telegram-client.ts:23` | 4 (`'message' \| 'edited_message' \| 'channel_post' \| 'callback_query'`) | Yes — `mapUpdate` (L98-137) covers `message`/`edited_message`/`channel_post` via the L101-105 nested ternary and `callback_query` via the L122 branch, returning `null` for anything else. Mirrors `ALLOWED_UPDATES` at L21 (same 4 strings, `as const`). |
| `TelegramErrorKind` | `telegram-client.ts:43` | 4 (`'fatal' \| 'rate_limit' \| 'conflict' \| 'transient'`) | Yes at the throw side (12 sites, §2.3); **no** at the read side — `runLoop` explicitly handles 3 of 4 and lets `'transient'` fall through to the L383 backoff (§2.4). |
| `PluginLiveness` | `liveness.ts:162` | 3 (`'alive' \| 'down' \| 'unknown'`) | Yes — `probeChannelPluginLiveness` (L164-217) returns exactly one of the three on every path; `hasChannelPluginAlive` (L223-225) collapses it to `=== 'alive'`. |
| `State` (**not exported**) | `channel-coordinator.ts:100` | 2 (`'idle' \| 'backfilling'`) | Yes — `runLoop` branches `if (state === 'idle')` at L317 and falls through to the `// state === 'backfilling'` comment at L351. |

### §1.4 The 4 non-exported declarations in `telegram-client.ts`

`RawUpdate` (L56-67), `RawMessage` (L69-79), `RawUser` (L81-86) model
the Bot-API wire shape. Per `review-correctness.md` §Confirmed claims,
a grep for these three names across `src/` (excluding `__tests__/`)
returns only references inside `telegram-client.ts` itself — so they are
**class-private-eligible today** with no consumer migration. Note that
`RawUpdate` leaks into the public signature of `getUpdates`
(`Promise<RawUpdate[]>`, L148) and `mapUpdate` (`u: RawUpdate`, L98)
without being exported; `channel-coordinator.ts` works around this at
L237 with `mapUpdate(raw as Parameters<typeof mapUpdate>[0])` — one of
the 3 casts in the entry file (§8.1). **A class refactor that makes
`RawUpdate` a private class type must keep the `Parameters<>` escape
hatch working, or export the type.**

---

## §2. `TelegramApiError` audit (`telegram-client.ts:45-54`)

### §2.1 Full shape (verbatim)

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

| Field | Type | Optional | Readonly | Notes |
|---|---|---|---|---|
| `kind` | `TelegramErrorKind` (L43) | no | **yes** (`public readonly`) | The discriminator. Parameter-property form, so it is both a constructor arg and an instance field. |
| `message` | `string` | no | (inherited from `Error`) | Plain constructor parameter — **not** a parameter property; forwarded to `super(message)` at L51. |
| `retryAfterSec` | `number \| undefined` | **yes** (`?`) | **yes** (`public readonly`) | Carries the Bot-API `parameters.retry_after` for 429s. Set only at L181 (`getUpdates` 429 branch); every other throw site omits it. |

### §2.2 `extends Error` convention

- `super(message)` at L51 with **one argument** — no `cause` chain, no
  `{ cause: err }` options object. Consistent with the
  `h-cross-cutting/03-class-boundaries.md:219` finding that 8 of 9
  existing error classes omit `cause`.
- `this.name = 'TelegramApiError'` at L52 — the string-literal form, not
  `new.target.name`. Under a future H.4 `AppError` base the
  `new.target.name` form yields the identical string, so the swap is a
  zero-behaviour change; the current source is the literal form.
- No `Object.setPrototypeOf(this, TelegramApiError.prototype)` call. The
  project targets a TS/ESM output where `extends Error` prototype
  restoration is not needed, and the 5 `instanceof` sites all work
  today — so no fix is required, and per `CLAUDE.md §3` none should be
  added.
- No static factory methods, no `toJSON`, no custom `stack` handling.

### §2.3 Production throw sites — 12, all in `telegram-client.ts`

`grep -n "throw new TelegramApiError" src/channel-coordinator.ts src/channel-coordinator/*.ts` returns **12 lines, all in
`telegram-client.ts`**. Zero throw sites in `channel-coordinator.ts`,
`ingest.ts`, `liveness.ts`, or `provider-poller-match.ts`:

| Line | Function | `kind` | Trigger | `retryAfterSec` |
|---:|---|---|---|---|
| 161 | `getUpdates` | `'transient'` | fetch threw (network / DNS / our own abort) | — |
| 179 | `getUpdates` | `'fatal'` | `errorCode === 401` | — |
| 180 | `getUpdates` | `'conflict'` | `errorCode === 409` | — |
| 181 | `getUpdates` | `'rate_limit'` | `errorCode === 429` | **yes** (`retryAfter`) |
| 182 | `getUpdates` | `'transient'` | `errorCode >= 500` | — |
| 184 | `getUpdates` | `'fatal'` | any other non-ok status (400 / 403 / other 4xx) | — |
| 188 | `getUpdates` | `'transient'` | HTTP 200 but `json.ok === false` | — |
| 213 | `probeHighWater` | `'transient'` | fetch threw | — |
| 218 | `probeHighWater` | `'fatal'` | `res.status === 401` | — |
| 219 | `probeHighWater` | `'conflict'` | `res.status === 409` | — |
| 220 | `probeHighWater` | `'transient'` | any other non-ok status | — |
| 223 | `probeHighWater` | `'transient'` | HTTP 200 but `json.ok === false` | — |

Split: `getUpdates` 7 sites, `probeHighWater` 5. Distribution by kind:
`'transient'` 6, `'fatal'` 3, `'conflict'` 2, `'rate_limit'` 1.

**Asymmetry worth preserving.** `probeHighWater` classifies on
`res.status` directly (L218-220) while `getUpdates` first parses the
JSON body for `error_code` (L169-177) and classifies on that. The seed
probe deliberately does not do the defensive body parse — a shorter,
simpler path for a call that is expected to succeed or 409. A class
refactor must not "unify" these two classifiers.

### §2.4 Read sites — 5 `instanceof`, all in `channel-coordinator.ts`

| Line | Context | `kind` tested | Action |
|---:|---|---|---|
| 335 | idle-branch high-water seed catch | `'fatal'` | `await fatalExit(err)` → notify.sh + `process.exit(1)` |
| 338 | idle-branch high-water seed catch | `'conflict'` | set `nativeConfirmedUpUntil` (L339), `downStreak = 0` (L341), stay idle |
| 366 | backfill poll catch | `'fatal'` | `await fatalExit(err)` |
| 372 | backfill poll catch | `'conflict'` | set cooldown (L373), `state = 'idle'` (L375) |
| 378 | backfill poll catch | `'rate_limit'` | `await sleep((err.retryAfterSec ?? 5) * 1000)` (L379) — the **only** read of `retryAfterSec` in the codebase |

`'transient'` is never tested by name: it is the implicit fall-through
to the L383 exponential backoff. This means the union is **read
non-exhaustively by design** — a hypothetical 5th `kind` variant would
silently take the transient-backoff path rather than fail to compile.
That is the intended conservative default, but it is the one place where
the discriminator does not give compile-time exhaustiveness.

**Migration verdict.** `TelegramApiError` needs no work in G. Per
`h-cross-cutting/03-class-boundaries.md:305-311` it is deferred longest
under H.4, and per `review-completeness.md` OE-1/OE-2 splitting it into
4 per-`kind` subclasses is rejected — the 5 read sites all test
`instanceof TelegramApiError && err.kind === X`, which subclassing would
turn into 4 separate `instanceof` chains for zero gain.

---

## §3. `ChannelCoordinator` class design sketch — dependency verification

`03-class-boundaries.md §G4` proposes the constructor shape. This
section verifies each proposed dependency against source.

### §3.1 Dependency-by-dependency verdict

| Proposed dep | Subsystem | Verified? | Evidence |
|---|---|---|---|
| `ChannelProvider` / `getProvider` | D | **NOT PRESENT — do not add in G.4** | `grep -n "ChannelProvider\|channel-provider\|getProvider" src/channel-coordinator.ts` returns nothing. The only D touch point is `CHANNEL_PROVIDER` imported from `./config.js` at L35 and bound to `const PROVIDER = CHANNEL_PROVIDER` at L57, then passed as the `ChannelProviderType` second argument to `probeNativeChannelDown` at L322, L354, L393. This is a **type-level discriminator only**, not an interface dependency. The `registry: ChannelProviderRegistry` parameter in `03 §G4` is forward-looking to D.3 and has **zero production caller today**; adding it in G.4 would be dead constructor surface. [ASSUMPTION: it becomes live only if a post-D.3 consumer needs `getProvider()` — none is identified.] |
| `TelegramClient` | G.1 | **yes** | 1 importer: `channel-coordinator.ts:36` imports `getUpdates`, `probeHighWater`, `mapUpdate`, `TelegramApiError`. No other file in `src/` imports `telegram-client.js`. |
| `IngestWorker` | G.2 | **yes, with its OWN handle** | `channel-coordinator.ts:38-48` imports 8 symbols + `type InsertResult`. The handle is opened by `initIngestDb` (`ingest.ts:27-91`) via `new Database(dbPath, { strict: true })` at L29 — **separate process**, per the file-level comment `ingest.ts:1-9`. |
| `DbClient` | A | **NOT needed** | Follows directly from the above: the coordinator cannot share the dashboard's sqlite singleton. `IngestWorker` constructs its own `Database`; injecting an A-owned `DbClient` would be wrong, not merely unnecessary. |
| `liveness` probes | G | **yes, as free functions** | `channel-coordinator.ts:37` imports only `probeNativeChannelDown`. The 2 pure deciders (`decideHasPluginAlive` L72, `decideNativeChannelDown` L266) stay free per `03 §G3`. |
| `ChannelPairingStore` | A | **DOES NOT EXIST** | `grep -rn "ChannelPairingStore" src/ --include='*.ts'` returns **zero hits** — confirming `01 §ChannelPairingStore integration` and matching `a-db/02-type-interface-analysis.md`, whose 41-type audit contains no such entity. The coordinator writes fixed `from_agent = COORDINATOR_AGENT_ID` rows (`ingest.ts:164`); the pairing lookup is the message-router's job, outside G. |
| `Config` | B | **partial** | `channel-coordinator.ts:35` imports 4 consts (`PROJECT_ROOT`, `MAIN_AGENT_ID`, `CHANNEL_PROVIDER`, `BOT_NAME`); `ingest.ts:21` imports 3 (`STORE_DIR`, `DB_FILENAME`, `MAIN_AGENT_ID`); `liveness.ts:15` imports 1 (`PROJECT_ROOT`). Per `b-config/02-type-interface-analysis.md §3.3` the deps-bundle `opts` pattern is the precedent: these 8 const reads become named `opts` fields rather than a `Config` instance injection, so G stays independent of B's phase order. |
| `LoggerLike` | H | **yes, for `ChannelCoordinator` only** | 19 call sites (§7). The other 3 G classes have 0 (`TelegramClient`, `IngestWorker`) or 4-that-stay-free (`liveness.ts`). |

### §3.2 Constructor — deps-bundle `opts` pattern

Per `b-config/02-type-interface-analysis.md §3.3` (single-object
constructor so additions do not churn every call site) and the
`e-process-lock` `(ctx, opts?)` precedent. The **verified** values the
constructor must carry, with their current module-level source:

| `opts` field | Current source | File:line |
|---|---|---|
| `session` | `const SESSION = \`${MAIN_AGENT_ID}-channels\`` | L56 |
| `provider: ChannelProviderType` | `const PROVIDER = CHANNEL_PROVIDER` | L57 |
| `stateDir` | `process.env['COORDINATOR_STATE_DIR'] ?? join(homedir(), …)` | L97 |
| `pidFile` | `join(STATE_DIR, 'coordinator.pid')` | L98 |
| `token` | return value of `readToken()`, called from `main()` | L117-136, L423 |
| `notifyScript` | `join(PROJECT_ROOT, 'scripts', 'notify.sh')` (currently computed inside `sendAlert`) | L171 |
| `telegram` / `ingest` / `liveness` | the 3 G classes | — |
| `log: LoggerLike` | the 19 call sites | §7 |

**No `registry`** — see §3.1. **No `db`** — `IngestWorker` owns it.

### §3.3 Public method surface — verified line ranges

| Method | Source | File:line | Return type |
|---|---|---|---|
| `start()` | `main()` | L422-431 | `Promise<void>` |
| `stop()` | the SIGTERM 3-second drain inside `installSignalHandlers` | L407-420 (timer at L412-416) | `Promise<void>` |
| `runLoop()` | `runLoop(token)` | **L311-403** (confirmed) | `Promise<void>` |
| `getProvider(): ChannelProviderType` | read of `PROVIDER` | L57 | `ChannelProviderType` — **note the return type is the union alias, not a `ChannelProvider` instance** (§3.1) |
| `getLiveness(): LivenessTracker` | new accessor | — | `LivenessTracker` |
| `sendMessage(text)` | **DOES NOT EXIST — reject** | — | The coordinator never sends. `telegram-client.ts:9-13`: "This client never sends (outbound stays with the native plugin)". The only outbound is `sendAlert` (L170-175), which shells out to `notify.sh`, not the Bot API. Adding a `sendMessage` method would be new capability, not a refactor. |

### §3.4 Lifecycle — process-invocation only (verified)

`grep -rn "from.*channel-coordinator\.js"` across `src/` excluding
`__tests__/` returns **zero production importers**. The file is invoked
by launchd / `node dist/channel-coordinator.js` and gated by the
entry-point guard at L435. There is no HTTP route, no `index.ts`
shutdown registration, no `App` wiring. This is why the type surface of
`channel-coordinator.ts` is **0 exported interfaces and 0 exported
types** — the only exports are the 4 pure test-seam functions
(`inNative409Cooldown` L109, `neutralizeChannelTags` L182,
`buildHandoffContent` L189, `transientBackoffMs` L221), and `type State`
at L100 is deliberately module-private.

---

## §4. `ingest.ts`, `liveness.ts`, `provider-poller-match.ts` type audit

### §4.1 `ingest.ts` (230 LOC)

- **`incoming_events` queue table types.** There is no queue type. The
  queue IS the SQLite table: `incoming_events` rows with
  `agent_message_id IS NULL` or a failed join are the pending set,
  selected by `getEventsNeedingHandoff` (L190-204) into
  `IncomingEventRow[]`. The DDL lives inline at L36-54 with the unique
  index at L58 and the status index at L59. **The `IncomingEventRow`
  type is hand-maintained against the DDL** — nothing enforces the
  correspondence, and two fields are deliberately widened: `kind: string`
  and `status: string` do not carry the DDL `CHECK(status IN
  ('pending','delivered','done','failed'))` at L48-49. A class refactor
  could narrow `status` to a 4-variant union at zero runtime cost; that
  is a type improvement, not a refactor requirement, and per
  `CLAUDE.md §3` it should be a separate decision.
- **`COORDINATOR_AGENT_ID` constant type.** `ingest.ts:23`
  `export const COORDINATOR_AGENT_ID = 'telegram-coordinator'` — no type
  annotation, so TypeScript infers the **literal type
  `'telegram-coordinator'`**, not `string`. Preserving this matters:
  `03 §G2` proposes `static readonly COORDINATOR_AGENT_ID =
  'telegram-coordinator'` on `IngestWorker`, which also infers the
  literal (`static readonly` on a string literal narrows). A re-export
  `export const COORDINATOR_AGENT_ID = IngestWorker.COORDINATOR_AGENT_ID`
  preserves the literal type as well. Any of the 3 external consumers
  that relies on literal-type narrowing keeps working. **Verify the
  narrowing survives before the G.2 commit** — if the class field is
  written without `readonly`, TS widens it to `string` and a consumer
  doing a literal comparison could lose narrowing.
- **`initIngestDb` return type.** `initIngestDb(dbPath = join(STORE_DIR,
  DB_FILENAME)): Database` (L27). Returns the shared handle, with the
  idempotency guard `if (db) return db` at L28. The default-parameter
  form means the `STORE_DIR`/`DB_FILENAME` config read happens at **call
  time**, not module-load time — a property the `opts.dbPath` constructor
  in `03 §G2` preserves. Note `requireDb()` (L93-96) returns `Database`
  and throws a plain `Error` (not a typed error class) when uninitialized
  — the only throw in `ingest.ts`.
- **`insertIncomingEvent` parameter type is structural, not
  `NormalizedEvent`.** L126-138 declares an inline 9-field object literal
  type that is field-for-field identical to `NormalizedEvent`
  (`telegram-client.ts:25-35`) except `kind: string` instead of
  `kind: UpdateKind`. This deliberate widening keeps `ingest.ts` free of
  any `telegram-client.js` import (verified: `ingest.ts` imports only
  `../db/sqlite.js`, `node:path`, `../config.js`). **The class refactor
  must not "tidy" this into a shared type** — doing so would create a
  G-internal coupling that does not exist today and would make
  `IngestWorker` provider-aware, contradicting `01 §ingest.ts deep-dive`
  ("it is provider-agnostic").

### §4.2 `liveness.ts` (287 LOC)

- **Tri-state verdict.** `export type PluginLiveness = 'alive' | 'down'
  | 'unknown'` at **L162** (confirmed), documented by the L157-161
  comment: `'unknown'` means the *probe* failed, not that the plugin is
  down. Returned by `probeChannelPluginLiveness` at L189 (`'unknown'`,
  ps failure), L212 (`'alive' : 'down'`), L215 (`'unknown'`, state-dir
  failure). This is the single most safety-critical type in G: collapsing
  it to a boolean previously let a probe hiccup hard-restart a healthy
  agent.
- **`decideHasPluginAlive`** at **L72** (confirmed):
  `(ctx: PluginAliveContext): boolean`. Single-parameter context-bundle
  signature — the same deps-bundle shape §3.2 proposes for the
  constructors, already used here. Pure: all I/O is pre-gathered into
  `ctx` by the caller, with `isPidAlive` and `debugLog` as injected
  function-typed seams.
- **`decideNativeChannelDown`** at **L266** (confirmed):
  `(f: NativeStateFacts): boolean`. Pure, 4 guard lines (L267-271),
  conservative ordering: startup-grace → no-pid → plugin-gone →
  keepalive-stale.
- **`tmuxBin` resolver type.** `const tmuxBin = makeLazyBinResolver('tmux')`
  at **L20** (confirmed). The type is whatever `platform.ts`'s
  `makeLazyBinResolver` returns — a `() => string` closure that caches
  the resolved path. It is **not exported** and has exactly one call site
  (L36, inside `getClaudePidForSession`). Per `03 §G3` it stays
  module-level; an H.3 `LazyBin` class migration is orthogonal to G.
- **`snapshotProcsWithRetry`** (L145-155) has the one non-trivial
  parameter type in G: `timeouts: readonly [number, number] =
  [PS_PROBE_TIMEOUT_MS, PS_PROBE_RETRY_TIMEOUT_MS]` — a readonly tuple
  with a default. This is the correct strict-generics form (fixed arity
  enforced at the type level) and needs no change.
- **Interaction with the 4 `channel-coordinator.ts` state lets.**
  `liveness.ts` holds **none** of them. The coupling is one-directional
  and purely by value: `runLoop` calls `probeNativeChannelDown(SESSION,
  PROVIDER)` at L322 / L354 / L393 and folds the `boolean` result into
  `downStreak` (L323) and the `state` transitions (L331, L356, L375,
  L395). `nativeConfirmedUpUntil` (L106) never reaches `liveness.ts` at
  all — the 409 cooldown is applied on the coordinator side at L322 via
  `&& !inNative409Cooldown(nativeConfirmedUpUntil, Date.now())`. **This
  is why `LivenessTracker` is sourced from `channel-coordinator.ts:101-106`
  and not from `liveness.ts`** (per `03 §G3`): the two files share no
  mutable state, only a boolean return value.

### §4.3 `provider-poller-match.ts` (91 LOC)

- **`SLUG_RX` type.** `const SLUG_RX: Record<ChannelProviderType, RegExp>`
  at **L49-55** (confirmed) — the only explicitly-annotated `Record` in
  G, and the only place where the `ChannelProviderType` union is used as
  a **key domain** rather than a value discriminator. The annotation is
  load-bearing: it forces exhaustiveness, so adding a 6th provider to
  `ChannelProviderType` produces a compile error here. Currently 5 keys
  (`telegram`, `slack`, `discord`, `googlechat`, `teams`). Not exported.
- **The other 2 regexes** — `RUNTIME_TOKEN_RX` (L21) and
  `SLACK_SOCKET_MODE_RX` (L70) — are bare `RegExp` consts, not exported.
  All three are literal regexes with no `g` flag, so there is no
  `lastIndex` statefulness; they are safe module-level constants.
- **Exported surface: exactly one function.**
  `matchesProviderPollerCmd(cmd: string, provider: ChannelProviderType):
  boolean` at L82-91. Zero exported types, zero exported interfaces.
  This is the smallest and cleanest type surface in G and needs no
  refactor.

---

## §5. Generic opportunities — every candidate rejected (OE-6 lens)

`review-completeness.md` OE-6 rejects `TtlCache<K, V>` and
`RetryQueue<TRow>` on the grounds that a generic with **one consumer**
adds abstraction without reuse and that a constraint coupling the
parameter to a single concrete shape "defeats the 'generic' goal." Every
G candidate fails the same test.

### §5.1 `ChannelCoordinator<TConfig>` — REJECT

One coordinator exists, constructed once per process (§3.4), with zero
production importers. The `opts` bundle in §3.2 is a fixed 9-field shape
sourced from 9 module-level consts. A `TConfig` parameter would have
exactly one instantiation, `ChannelCoordinator<CoordinatorOpts>`, which
is the non-generic class spelled longer. **Rejected per OE-6
(single consumer).**

### §5.2 `TelegramClient<TProvider>` — REJECT

The file-level comment `telegram-client.ts:1-13` states the client polls
one token via raw `fetch` and never sends. Confirmed by
`review-correctness.md` m9: no second Telegram-shaped client exists
anywhere in `src/`. A `TProvider` parameter would have to vary the
`API_BASE` (L15), the URL shape (`/bot${token}/getUpdates`, L153/L206),
the `allowed_updates` whitelist (L21), the `RawUpdate` wire shape
(L56-67), and the entire HTTP-status → `TelegramErrorKind` classifier
(L179-184) — i.e. every line of the module. That is a second
implementation, not a type parameter. **Rejected per OE-6.**

### §5.3 `IngestWorker<TMessage>` — REJECT

The `source` column is plain `TEXT DEFAULT 'telegram'` (`ingest.ts:38`),
and `insertIncomingEvent` already accepts a **structural** 9-field shape
rather than a nominal `NormalizedEvent` (§4.1) — so the module is
*already* message-shape-agnostic without a type parameter. A
`TMessage extends { update_id: number; kind: string; … }` constraint
would name the exact current shape, reproducing the OE-6 `RetryQueue<TRow>`
anti-pattern verbatim. **Rejected per OE-6.**

### §5.4 `LivenessTracker<TState>` — REJECT

`type State = 'idle' | 'backfilling'` (`channel-coordinator.ts:100`) is a
2-variant union used in exactly one file, and the tracker's other three
fields (`downStreak: number`, `stopping: boolean`,
`nativeConfirmedUpUntil: number`) are not parameterizable at all. A
`TState` parameter would generalize one of four fields for one consumer.
`review-correctness.md` §Out-of-scope cross-checks separately confirms
that `review-completeness.md` CE-9's `RemoteStatusCache<T>` reuse
opportunity does **not** apply here: `web/remote-status-cache.ts` is
imported by zero G files, and a TTL-keyed status cache is not the shape
of a 4-field state machine. **Rejected per OE-6; CE-9 not applicable.**

### §5.5 Verdict — zero generics in G

| Precedent | Generics surviving |
|---|---|
| A (`a-db/02` §6) | 0 (`BaseStore<TEntity>`, `MemoryCache<M>` both rejected) |
| B (`b-config/02` §5) | 0 |
| D (`d-channel-provider/02` §8) | 0 (`Provider<TConfig>` rejected) |
| E, F | 0 |
| H (`h-cross-cutting/04` §L) | `LoggerLike` — and it is **non-generic**; `LoggerLike<L extends LogRecord>` was itself rejected because no module in `src/` declares a log-record type |
| **G (this file)** | **0** |

The single interface G adopts from H (`LoggerLike`) carries no type
parameter, so G introduces **no type parameters of any kind**.

---

## §6. Discriminated unions → sealed-class candidates (CE-7 lens)

G has 4 string-literal unions (§1.3). Auditing each:

### §6.1 `TelegramErrorKind` — already a class, no migration

`TelegramApiError` (§2) is a class carrying `kind` as a `readonly`
discriminator field. This is the *destination* of a
union-to-sealed-class migration, already reached. Splitting it into 4
subclasses is explicitly rejected by `review-completeness.md` OE-1/OE-2
and `h-cross-cutting/03-class-boundaries.md:305-311`. **No work.**

### §6.2 `PluginLiveness` tri-state — REJECT the sealed-class form

A `LivenessVerdict` hierarchy (`AliveVerdict` / `DownVerdict` /
`UnknownVerdict`) would allocate an object per verdict. The verdict is
produced inside `probeChannelPluginLiveness` (L164-217), reached from
`probeNativeChannelDown` (L276-287), which `runLoop` calls **up to 3
times per tick** (L322, L354, L393) at `TICK_MS = 5000` (L60) — plus the
2 external `web/` consumers (`channel-monitor.ts:50`,
`schedule-mcp-precheck.ts:22`) on their own cadences. The allocation cost
is small but real and permanent, against zero gain: the union is already
exhaustive at every production site (§1.3), and the string form is what
the 4 `vi.mock` factories return (`channel-monitor.test.ts:259`,
`channel-monitor-baseline.test.ts:222`,
`channel-monitor-coverage.test.ts:243`,
`schedule-mcp-precheck-full.test.ts:80`) — a class form would require
rewriting all 4. **Rejected**, on the same runtime-cost-vs-zero-gain
reasoning `review-completeness.md` OE-7 applies to
`BasePaneWatcher<TState, TThresholds>`.

### §6.3 `UpdateKind`, `State`, and `InsertResult` — REJECT

- `UpdateKind` (4 variants) is a **storage** value: it is written
  straight into the `incoming_events.kind` TEXT column
  (`ingest.ts:147`) and read back as a plain `string`
  (`IncomingEventRow.kind`, L113). A sealed class would need
  serialization on both sides of the DB boundary for no gain.
- `State` (2 variants) drives a single `if/else` at L317 / L351 inside
  one function. Two classes for one branch is over-engineering by any
  reading of `CLAUDE.md §2`.
- `InsertResult` (`ingest.ts:98-101`) is the one union-*shaped* type that
  is **not** currently a union: `{ inserted: boolean; eventId: number |
  null }` with correlated nullability the type does not express (§1.2).
  A discriminated form would let the single caller
  (`channel-coordinator.ts:247`) narrow with one check instead of two.
  **Still rejected for G:** one call site, and it would change a public
  exported interface that `channel-coordinator.ts:47` imports as a type.
  Documented here as the only *defensible* candidate in G so a future
  reviewer does not have to re-derive it.

**Net: zero sealed-class migrations in G.**

---

## §7. `LoggerLike` integration — per file

### §7.1 Correction to the inherited count: 19, not 17

`grep -cE "logger\.(info|warn|error|debug)\(" src/channel-coordinator.ts`
returns **19**. The 17-site list carried in the task brief and in
`00-summary.md:74` omits two call sites:

- **L153** `logger.warn({ stalePid: prev }, 'channel-coordinator: reclaiming stale pid file')` — inside `acquireSingleInstanceLock`
- **L394** `logger.info({ batch: updates.length }, 'channel-coordinator: native recovered mid-batch, discarding + yielding (native will deliver)')` — the yield-before-handoff branch in `runLoop`

Both are load-bearing operational signals (stale-lock reclaim and
mid-batch discard). This is a **new finding not in
`review-correctness.md`** — that review's §Severity summary lists the
same 17-item set as "internally consistent", so the omission propagated
through the review unchallenged. Corrected full list (19):

**L150, L153, L173, L244, L252, L254, L275, L293, L295, L303, L333,
L340, L343, L355, L374, L394, L411, L427, L437.**

By level: `error` 6 (L150, L244, L254, L275, L295, L303, L437 — 7
counting L437), `warn` 5 (L153, L173, L293, L333, L343), `info` 6
(L252, L340, L355, L374, L394, L411, L427). Exact split: error 7, warn
5, info 7.

### §7.2 Per-file counts (all verified)

| File | `logger.*` call sites | Import of `logger` | Verdict |
|---|---:|---|---|
| `channel-coordinator.ts` | **19** | L34 | Needs `log: LoggerLike` in the constructor |
| `telegram-client.ts` | **0** | none | No logger dependency — confirms G-A and `review-correctness.md` |
| `ingest.ts` | **0** | none | No logger dependency — confirms G-A |
| `liveness.ts` | **4** (L152, L188, L210, L214) | L14 | See §7.3 |
| `provider-poller-match.ts` | **0** | none | No logger dependency |

The 4 `liveness.ts` sites were **not** verified in the task brief. They
are: L152 `logger.debug` (ps-snapshot retry, inside
`snapshotProcsWithRetry`), L188 `logger.warn` (ps failed after retry →
`'unknown'`), L210 `logger.debug` (the `debugLog` callback passed into
`decideHasPluginAlive`), L214 `logger.warn` (state-dir failure →
`'unknown'`).

### §7.3 Constructor implications

- **`ChannelCoordinator`**: takes `log: LoggerLike`. 19 sites route
  through `this.log`. Non-negotiable, gated on H.1.
- **`TelegramClient`**: **reject the `log` parameter.** Zero call sites.
  `03 §G1` proposes `constructor(env, db, log)` with `log` "for the
  per-call debug logging (e.g. `logger.debug({ update_id }, …)`)" — that
  log line **does not exist in the source**. Per the `b-config`
  precedent (zero call sites → reject) and `CLAUDE.md §2` (no
  speculative surface), the parameter should be dropped from the G.1
  signature. The same applies to the proposed `db: DbClient` parameter,
  described in `03 §G1` as "used by no method today but reserved for
  future telemetry" — that is a self-described unused parameter.
- **`IngestWorker`**: no `log` parameter. Zero call sites; `03 §G2`
  already reaches this conclusion.
- **`LivenessTracker`**: no `log` parameter. The class is sourced from
  the 4 lets at `channel-coordinator.ts:101-106` (§4.2), which have no
  logging of their own. The 4 `liveness.ts` sites stay with the free
  probe functions, which are **not migrated** (`03 §G3`), so they remain
  on the module-level `logger` import until an H-scope sweep touches
  them. **G does not migrate them.**

**Net: 1 of 4 G classes takes `LoggerLike`.**

---

## §8. Unsafe casts audit

### §8.1 Per-file breakdown — 8 casts, all boundary

`grep -nE "\bas\s+any\b|:\s*any\b|as\s+unknown\s+as"` across all five
files returns **zero matches**. `grep -n "satisfies"` returns **zero**
(so the `CLAUDE.md §7` `satisfies`-over-`as` rule has no current
adoption in G, but equally no `as` that a `satisfies` would replace —
all 8 are narrowing casts on `unknown`-typed I/O results, which
`satisfies` cannot express).

| File | Line | Cast | Boundary? | Assessment |
|---|---:|---|---|---|
| `channel-coordinator.ts` | 200 | `ev.meta?.voice as { file_id?: string } \| undefined` | **yes** — `meta` is `Record<string, unknown>` | Sound. Result immediately optional-chained at L201 (`voiceMeta?.file_id ?? ''`), so a wrong shape degrades to `''` rather than throwing. |
| `channel-coordinator.ts` | 237 | `mapUpdate(raw as Parameters<typeof mapUpdate>[0])` | **yes** — `processBatch` types its param as `{ update_id: number }[]` (L233) | Sound but a **symptom**: the cast exists only because `RawUpdate` is not exported (§1.4). `processBatch` deliberately takes the minimal structural type so it does not depend on the wire shape. A class refactor that exports `RawUpdate` (or keeps it private on `TelegramClient`) must keep this working. |
| `channel-coordinator.ts` | 281 | `JSON.parse(ev.meta) as Record<string, unknown>` | **yes** — `JSON.parse` returns `any` | Sound. Wrapped in `try { … } catch {}` at L281, so malformed stored JSON leaves `parsedMeta` at its `{}` initializer (L280). |
| `ingest.ts` | 203 | `.all(source, limit) as IncomingEventRow[]` | **yes** — SQLite row boundary | Sound; the canonical A-pattern cast. Correspondence with the DDL (L36-54) is hand-maintained (§4.1). |
| `ingest.ts` | 207-209 | `.get(source) as \| { last_update_id: number } \| undefined` | **yes** — SQLite row boundary | Sound, and notably **includes `\| undefined`** in the cast target, so the L210 `row?.last_update_id ?? 0` is genuinely typechecked rather than a false-confidence non-null assertion. (Multi-line form: the `as` sits at EOL 207, so a single-line grep misses it.) |
| `telegram-client.ts` | 173 | `await res.json() as { error_code?: number; description?: string; parameters?: { retry_after?: number } }` | **yes** — HTTP body | Sound. All three fields optional and each re-checked at L174-176 (`typeof body.error_code === 'number'`, `if (body.description)`, `body.parameters?.retry_after`); the whole block is in a `try { … } catch { }` (L172-177) so a non-JSON proxy body falls back to the L169-170 status defaults. **This is the best-defended cast in G.** |
| `telegram-client.ts` | 187 | `await res.json() as { ok: boolean; result?: RawUpdate[]; description?: string }` | **yes** — HTTP body | Sound-ish. `json.ok` is checked at L188 and `json.result ?? []` at L189 guards the optional, but `RawUpdate[]` element shapes are **not** validated — a malformed element would surface downstream in `mapUpdate` (which is itself defensive: every field access is optional-chained or `??`-defaulted, L110-134). |
| `telegram-client.ts` | 222 | same shape as L187 | **yes** — HTTP body | Same assessment; guarded at L223-225. |

Plus one **benign non-cast**: `telegram-client.ts:21`
`ALLOWED_UPDATES = [...] as const` — a literal-type assertion that
*narrows* rather than widens. Not an unsafe cast; it is the correct
strict form and must be preserved (it makes the array `readonly` and its
elements literal-typed).

### §8.2 Verdict: the "type-safe by construction" pattern holds

| Metric | G | A (precedent) |
|---|---:|---:|
| LOC | 1275 | 3308 |
| `as` casts | 8 | 104 |
| Casts per 100 LOC | **0.63** | 3.14 |
| `as any` | **0** | 0 |
| `: any` | **0** | 0 |
| `as unknown as` | **0** | 0 |
| Casts at a genuine I/O boundary | **8 of 8 (100%)** | boundary-dominant per `a-db/02` §3 |

Two files (`liveness.ts` 287 LOC, `provider-poller-match.ts` 91 LOC) are
**completely cast-free** — 378 LOC with zero type escapes, including the
two pure deciders that carry the safety-critical logic. **No G file
needs a type-safety remediation before or during the class refactor.**
The 3-line `channel-coordinator.ts` cast set is the only one a refactor
touches at all, and only L237 is structurally coupled to the class
boundary (§8.1).

---

## §9. Cross-references

### §9.1 Within the G folder

- `01-module-state-analysis.md` (G-A) — file inventory, the 4 mutable
  lets, vi.mock audit, external-consumer map. This file adopts its
  consumer counts verbatim and its LOC figures **as corrected by
  `review-correctness.md` m1**.
- `00-summary.md` (G-Plan) — the [ASSUMPTION] at line 148 ("`02` does
  not exist") is **now resolved** by this file. Its logger-count claim
  at line 74 is **corrected** here (§7.1: 19, not 17).
- `03-class-boundaries.md` (G-Plan) — class sketches verified in §3.
  Two proposed constructor parameters are recommended for removal:
  `TelegramClient`'s `log` and `db` (§7.3), and `ChannelCoordinator`'s
  `registry` (§3.1) — all three have zero production consumers today.
- `review-correctness.md` (G-RC) — M1 (PID_FILE breakdown) and m1 (LOC
  off-by-one) are adopted. m2 (missing `02`) is closed by this file.
  §7.1 above records a finding this review did not catch.
- `04-generic-interfaces.md`, `05-refactor-roadmap.md`,
  `06-risks-and-mitigations.md` — consistent with §5 (zero generics)
  and §3 (dependency verdicts).

### §9.2 Framework-level

- `review-completeness.md` **OE-6** — the single-consumer generic
  rejection standard applied to all 4 G candidates (§5).
- `review-completeness.md` **CE-9** (`RemoteStatusCache<T>`) — **not
  applicable to G**: zero G files import `web/remote-status-cache.ts`
  (§5.4), consistent with `review-correctness.md` §Out-of-scope
  cross-checks.
- `review-completeness.md` **CE-7** (sealed-class lens) — applied to all
  4 G unions in §6; zero migrations.
- `review-completeness.md` **OE-7** — the runtime-cost-vs-zero-gain
  reasoning reused to reject the `PluginLiveness` sealed hierarchy
  (§6.2).
- `h-cross-cutting/04-generic-interfaces.md` §L — `LoggerLike`, the only
  surviving interface, and non-generic (`LoggerLike<L extends LogRecord>`
  itself rejected there). Integration mapped per file in §7.
- `d-channel-provider/02-type-interface-analysis.md` — the
  `ChannelProvider` interface precedent (§3.1: G consumes only
  `ChannelProviderType`, never the interface) and the
  `ValidateTokenResult` naming precedent, which motivates §7.3's
  rejection of the speculative `validateToken` method on
  `TelegramClient` (D's `validateToken` has real consumers at
  `web/routes/agents.ts:968`, `:1046`, `:1435`; G's proposed one has
  none).
- `a-db/02-type-interface-analysis.md` — the 104-boundary-cast pattern
  benchmarked in §8.2, and the confirmation that no
  `ChannelPairingStore` entity exists in its 41-type audit (§3.1).
- `b-config/02-type-interface-analysis.md` §3.3 — the deps-bundle
  `opts` constructor precedent (§3.2) and the "zero logger call sites →
  reject the `log` parameter" rule (§7.3).

### §9.3 Verified source refs used in this file

`src/channel-coordinator.ts`: L34 (logger import), L35-48 (imports),
L56-57 (SESSION/PROVIDER), L60 (TICK_MS), L97-98 (STATE_DIR/PID_FILE),
L100 (`type State`), L101-106 (4 lets), L109-111
(`inNative409Cooldown`), L117-136 (`readToken`), L170-175 (`sendAlert`),
L182-184 (`neutralizeChannelTags`), L189-215 (`buildHandoffContent`),
L200 / L237 / L281 (the 3 casts), L221-224 (`transientBackoffMs`),
L233-258 (`processBatch`), L270-298 (`reconcilePending`),
L311-403 (`runLoop`), L322/L354/L393 (`probeNativeChannelDown` calls),
L335/L338/L366/L372/L378 (5 `instanceof`), L379 (`retryAfterSec` read),
L407-420 (`installSignalHandlers`), L422-431 (`main`), L435 (entry
guard).

`src/channel-coordinator/telegram-client.ts`: L15 (`API_BASE`), L21
(`ALLOWED_UPDATES` `as const`), L23 (`UpdateKind`), L25-35
(`NormalizedEvent`), L43 (`TelegramErrorKind`), L45-54
(`TelegramApiError`), L56/L69/L81 (Raw* interfaces), L98-137
(`mapUpdate`), L143-190 (`getUpdates`), L161-188 (7 throws), L173/L187
(2 casts), L201-226 (`probeHighWater`), L213-223 (5 throws), L222 (1
cast).

`src/channel-coordinator/ingest.ts`: L23 (`COORDINATOR_AGENT_ID`), L25
(`let db`), L27-91 (`initIngestDb`), L36-54 (DDL), L93-96
(`requireDb`), L98-101 (`InsertResult`), L105-122 (`IncomingEventRow`),
L126-150 (`insertIncomingEvent`), L160-166 (`createHandoffMessage`),
L190-204 (`getEventsNeedingHandoff`), L203 / L207-209 (2 casts),
L206-211 (`getOffset`), L225-230 (`closeIngestDb`).

`src/channel-coordinator/liveness.ts`: L14 (logger import), L20
(`tmuxBin`), L62-70 (`PluginAliveContext`), L72-130
(`decideHasPluginAlive`), L141-143 (probe timeout consts), L145-155
(`snapshotProcsWithRetry`), L152/L188/L210/L214 (4 logger sites), L162
(`PluginLiveness`), L164-217 (`probeChannelPluginLiveness`), L223-225
(`hasChannelPluginAlive`), L249-254 (`NativeStateFacts`), L266-272
(`decideNativeChannelDown`), L276-287 (`probeNativeChannelDown`).

`src/channel-coordinator/provider-poller-match.ts`: L21
(`RUNTIME_TOKEN_RX`), L49-55 (`SLUG_RX`), L70
(`SLACK_SOCKET_MODE_RX`), L82-91 (`matchesProviderPollerCmd`).

---

## [ASSUMPTION] markers

- [ASSUMPTION: `TelegramClient`'s `registry` / `db` / `log` constructor
  parameters and its `validateToken` / `formatMessage` / `splitMessage`
  methods (proposed in `03 §G1` and `03 §G4`) have **no production
  consumer today** — verified by grep. §3.1 and §7.3 recommend dropping
  them, but this is a plan-level design call the G-Plan owner should
  confirm rather than a source-verifiable fact.]
- [ASSUMPTION: the literal-type inference on `COORDINATOR_AGENT_ID`
  (§4.1) is not currently *depended upon* by any of the 3 external
  consumers — they were confirmed to import the const, but whether any
  relies on literal narrowing (vs treating it as `string`) was not
  traced into their call sites. The `static readonly` form preserves the
  narrowing either way, so the risk is bounded.]
- [ASSUMPTION: narrowing `IncomingEventRow.status` / `.kind` from
  `string` to literal unions (§4.1) is safe, based on the DDL CHECK
  constraint at `ingest.ts:48-49`. Not proposed as G work; recorded only
  so a future reviewer need not re-derive it.]

---

**End of G type/interface analysis. No source files modified.**
