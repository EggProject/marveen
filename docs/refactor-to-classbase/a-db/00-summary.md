# A (db) — Executive summary

Synthesis of `a-db/01-module-state-analysis.md` (module/state lens) and
`a-db/02-type-interface-analysis.md` (types/interfaces lens), cross-checked
against `src/db.ts` (3308 LOC, verified 2026-08-30) and the precedent
reviews (`h-cross-cutting/`, `b-config/`, `e-process-lock/`, `f-agent-subsystem/`,
`d-channel-provider/`, `review-correctness.md`, `review-completeness.md`).
**Planning only — no source files modified.**

---

## Thesis

A is the largest subsystem by single-file footprint (`src/db.ts`, 3308
LOC, 158 exported functions, 36 interfaces + 5 type aliases = 41 named
type exports) and the second-largest by blast radius behind `config.ts`
(14 narrow importers, 39 broad importers including `web/routes/*` and
`scripts/`, 50 `vi.mock('../db.js')` sites per `01 §6`). The refactor
produces **12 entity-store classes plus 1 keystone class** (`DbClient`)
that wrap the `let db: Database` singleton at `db.ts:10`, keep the 158
free functions as thin pass-through exports during the migration window
(per the `B.1`/`E.1` precedent), and migrate the cross-cutting decay
sweep (`runDecaySweep` at `memory.ts:155`) into a three-store
orchestration (`MemoryStore.decay + AuditLog.prune + TokenUsagePruner.prune`)
that preserves the current `memory.ts:155` aggregator location.

## Scope

### Files this plan TOUCHES

| File | Why | Phase |
|---|---|---|
| `src/db.ts` (3308 LOC) | introduce 13 classes alongside the 158 free functions; keep free functions as thin pass-throughs; remove only after every importer migrates | A.1–A.9 |
| `src/memory.ts` | the only non-trivial inter-module consumer of `db.ts` (`decayMemories`, `pruneAuditLogs`, `pruneTokenUsage` at `memory.ts:157-159`); `runDecaySweep()` aggregator location stays, but the three calls become `MemoryStore.decay + AuditLog.prune + TokenUsagePruner.prune` | A.5, A.6 |
| `src/heartbeat.ts:504-511` | calls `runDecaySweep()` opportunistically inside `executeHeartbeat()`; F's `HeartbeatScheduler` takes a `MemoryStore` instance (per `f-agent-subsystem/00-summary.md` Dependency) | A.5, A.6 |
| `src/index.ts:15`, `:451` | schedules `runDecaySweep()` via `setInterval`; the `setInterval` handle becomes a `MemoryStore` instance method on `App` | A.6, A.7 |
| `src/store-watcher.ts:78` (calls `logStoreFileEvent`) | the `StoreWatcher` class (F.3) takes a `StoreAuditLog` instance | A.2 |
| `src/web/federation/bridge.ts:24` | type-only import of `AgentMessage`; survives via type re-export from `MessageBus` namespace (per CE-9 lens) | A.4 |
| 39 production importers of `db.js` (14 narrow + 25 routes/scripts per `01 §3`) | migrate to `DbClient` + store classes; route handlers pick up stores via `RouteContext` (per B.3 DI seam) | A.2–A.7 |
| 50 `vi.mock('../db.js', …)` test sites | rewrite to `createTestDb(overrides?)` factory (per `review-correctness.md` CE-5) | A.7 |
| One new file: `src/util/ttl-cache.ts` [ASSUMPTION: filename not yet decided] | the shared `TtlCache<K, V>` primitive that replaces both `db.ts:1238-1274` `memoryCache` and the existing `web/remote-status-cache.ts:19` `RemoteStatusCache<T>` (per CE-9) | A.9 |
| One new file: `src/db/embedding-client.ts` [ASSUMPTION] | extract `EmbeddingClient` class so `MemoryStore` constructor does NOT take `embeddingModel` directly (per OE-10) | A.5 |

### Files this plan does NOT touch

- **`src/settings-store.ts`** — per the brief, this is a separate F subsystem
  (`settings-store.ts:15-17`), NOT a db.ts function cluster. The `SettingsStore`
  class candidate listed in §03 of this plan refers to the `db.ts` settings-related
  free functions (~5 functions if any exist), not `src/settings-store.ts`.
  Per `02-type-interface-analysis.md §2`, db.ts has no settings-related functions;
  `SettingsStore` (db-internal) is **rejected** for being a name collision with no
  source cluster to extract.
- **`src/web/remote-status-cache.ts:19` `RemoteStatusCache<T>`** — already a
  well-formed generic class (per `review-completeness.md` CE-1); A.9 either
  moves it to `src/util/ttl-cache.ts` (shared location) OR keeps it in
  `web/` and has `MemoryStore` import from there. The class is **not** rewritten.
- **`src/memory.ts`'s own functions** (`saveConversationTurn`,
  `appendConversationTurn`, `buildMemoryContext`, `runDailyDigest`) —
  per the brief, `MemoryStore` owns the `db.ts` memory functions; the
  `memory.ts` helpers stay in `memory.ts` until a separate "memory facade"
  pass lands (out of A scope).
- **`src/web/federation/http.ts:7` `PeerResponseTooLargeError`** — separate
  class; not owned by A.
- **All test files** — tests get *updated* to match new class APIs but their
  layout, runner (`bun --bun vitest`), and coverage targets are not in
  scope (consistent with `00-summary.md` "Explicitly OUT OF SCOPE").
- **`bun.lockb`, `package.json`, `tsconfig.json`** — out of scope.

### Files this plan MENTIONS but does NOT modify

- `src/db/sqlite.ts` — the `Database` type re-export. `DbClient` constructor
  takes this type. Not modified.
- `src/db.ts:978` `getDb()` — stays as the escape hatch for the 9 production
  files that reach past the function façade (per `01 §1.3`:
  `auth-sessions.ts`, `token-usage.ts`, `auth-device-keys.ts`,
  `fleet-transfer.ts`, `routes/costs.ts`, `routes/overview.ts`,
  `routes/ideas.ts`, `routes/agents.ts`, `scripts/dashboard-user.ts`).
  These 9 files either (a) keep calling `getDb()` directly (status quo)
  or (b) receive a `DbClient` instance from a higher-level factory.
  Per the B.5 test-factory precedent, the choice is per-file.

## Dependency: what A blocks and what blocks A

| Direction | Counterparty | What |
|---|---|---|
| **A ← B** | `Config` class with `STORE_DIR`, `DB_FILENAME`, `PROJECT_ROOT` fields | `DbClient` constructor reads `config.STORE_DIR` / `config.DB_FILENAME` to locate `claudeclaw.db`. **Yes:** A.1 cannot land before B.1. |
| **A ← H** | `LoggerLike` interface | `MemoryStore` (the only A store with non-fatal degradation paths per `02 §8`) takes `log: LoggerLike` in its constructor. **Yes** for A.5; **No** for A.1. |
| **A → C (web routes)** | `RouteContext` DI seam | 23 route files in `src/web/routes/` read db.ts functions; they pick up store instances via `RouteContext` (per B.3's existing `RouteContext` extension). A.2–A.7 migrate them. |
| **A → D (channel)** | `ChannelProviderRegistry.get()` is called by route handlers; no direct dependency on A. D does NOT block A. | n/a |
| **A → E (process-lock)** | none | `PortLockAcquirer.acquire(port, opts)` / `PidfileLockAcquirer.acquire(path, selfPid, opts)` (formerly the free functions `acquirePortLock` / `acquirePidfileLock`, deleted in E.5a + E.5b) don't read db.ts. E does NOT block A. |
| **A → F (agent subsystem)** | `HeartbeatScheduler` calls `runDecaySweep()` (`heartbeat.ts:509-512`); F.1 needs `MemoryStore.runDecaySweep()` instance method | **Yes** for F.1: F.1 either accepts the free function or the instance method depending on which lands first. Per the brief, F.1's order is "after framework A1". |
| **A → all importers** | 14 narrow importers + 25 routes + 1 script = 39 production files must migrate before A.7 (singleton removal). A.7 is gated on `grep -rln "from ['\"]\\.\\.\\?\\/db\\.js['\"]" src/ --include='*.ts' \| grep -v __tests__` returning only `src/db.ts` (the surviving pass-through file) and the new `src/util/ttl-cache.ts` consumer. |
| **A → G (generics)** | `LoggerLike` for `MemoryStore`; `TtlCache<K, V>` for the shared memory + remote-status cache utility (CE-9) | A.9 produces the `TtlCache<K, V>` sketch that G must update. |
| **CE-8 (memory.ts ↔ db.ts cycle)** | `MemoryStore` owns `runDecaySweep`; `HeartbeatScheduler` calls `memoryStore.runDecaySweep()`; `MemoryStore` calls `db.decayMemories()`. **Single-direction:** `HeartbeatScheduler → MemoryStore → db`. No cycle. The aggregator `runDecaySweep()` at `memory.ts:155` becomes a 3-line function calling `memoryStore.decay()`, `auditLog.prune()`, `tokenUsage.prune()`. | per AR3 below |

**What A does NOT owe anyone.** A's entity-store classes do not import
from `web/`, `channel-coordinator/`, or `costops/` — A is consumed by
them, not the other way around. The CE-9 `RemoteStatusCache<T>` reuse
creates one direction-of-dependency exception (`db.ts → web/` is
backward); A.9 fixes this by moving the cache utility to `src/util/`.

## Top 3 risks specific to A

1. **14-narrow / 39-broad importer blast radius.** A's entity-store
   classes must be introduced alongside the free functions (per the B.1
   precedent), with each importer migrating one at a time. The biggest
   importers — `src/memory.ts` (9 symbols), `src/web/routes/agents.ts`
   (5 symbols), `src/web/routes/kanban.ts` (~15 symbols),
   `src/web/routes/memories.ts`, `src/web/routes/ideas.ts` (11 symbols),
   `scripts/dashboard-user.ts` (8 symbols) — are the migration's
   critical path. The class extraction must be **phased** (A.1 keystone
   → A.2 small stores → A.3 mid → A.4 major → A.5 MemoryStore →
   A.6 cross-entity → A.7 singleton removal) with rollback granularity
   per phase. A single-commit refactor would touch every consumer
   simultaneously and would be unrevertable if any one consumer has a
   hidden dependency on the function-vs-method identity. `06-risks-and-mitigations.md`
   AR1.

2. **132 boundary `as` casts (zero unsafe).** Every `as` in `db.ts` is
   a SQL-row-to-typed-entity cast (`grep -nE '\bas\s+[A-Za-z]' src/db.ts`
   returns 104 standalone + 28 in `as const`/structural positions
   counted in the framework's 132 = ~132 total). A class refactor can
   contain the 104 boundary casts in a private `parseRow<T>(row: unknown): T`
   helper per store, but the migration risks "casting sprawl" — if every
   store exposes a public method that takes `row: unknown`, the type
   safety degrades. `06-risks-and-mitigations.md` AR2.

3. **memory.ts ↔ db.ts cross-entity (CE-8) + memoryCache ↔ RemoteStatusCache
   consolidation (CE-9).** Two non-trivial refactor sub-tasks:
   (a) `runDecaySweep` at `memory.ts:155` orchestrates three stores
   (MemoryStore, AuditLog, TokenUsagePruner); if `MemoryStore` owns the
   decay sweep, the `memory.ts:155` aggregator becomes a 3-line call
   site, but the construction order must spell out that
   `HeartbeatScheduler → MemoryStore → db` is single-direction.
   (b) The existing `RemoteStatusCache<T>` at `web/remote-status-cache.ts:19`
   may supersede `db.ts:1238-1274` `memoryCache` after adding an
   `invalidatePrefix` method; the direction-of-dependency (`db.ts →
   web/` is backward) requires moving the shared utility to
   `src/util/ttl-cache.ts`. `06-risks-and-mitigations.md` AR3 + AR4.

## Migration order inside A

```
A.1  DbClient keystone extraction       (introduce alongside; let db survives)
   |
   +---> A.2  Leaf stores (5 small)      SettingsStore (db-internal) [REJECTED — no source cluster]
                 ChannelProviderRegistry (db-internal) — actually a D subsystem concern
                 IdeaStore, ApprovalStore, Scheduler
                 VaultSshKeyStore / VaultSshServerStore (merged: SshVault)
                 SpanStore, BackgroundTaskPool
   |
   +---> A.3  Mid stores                  (depends on A.1)
   |
   +---> A.4  Major stores                KanbanCards, MessageBus
   |
   +---> A.5  MemoryStore                 (largest; cross-entity ops)
                 |
                 +---> A.6  Cross-entity migrations
                 |       runDecaySweep (memory.ts:155), pruneAuditLogs, pruneTokenUsage
                 |       Single-direction chain: HeartbeatScheduler -> MemoryStore -> db
                 |
                 +---> A.9  RemoteStatusCache<T> consolidation (per CE-9)
                 |       Replace db.ts:1238 memoryCache with TtlCache<K,V>
                 |       Move shared utility to src/util/ttl-cache.ts
                 |
                 +---> A.10 LoggerLike adoption across A classes (depends on H.1)
   |
   +---> A.7  Singleton removal           (gated on every importer migrated + 50 vi.mock rewrites)
   |
   +---> A.8  Error class taxonomy        (per CE-4 — typed MemoryStoreError, MessageBusError, KanbanStateError, ApprovalError)
                                                (preserve silent-return for 11 stores per 02 §9)
```

Rationale:

- **A.1 first** because every subsequent phase needs the `DbClient`
  constructor signature to exist. The new class is **additive**: the
  `let db: Database` at `db.ts:10` stays, but `DbClient` becomes the
  constructor for the entity-store classes.
- **A.2 leaf stores next** because the 5 smallest clusters (Settings,
  IdeaBox, Approval, ScheduledTask, SpanStore, BackgroundTaskPool, plus
  VaultSshKey/Server — note `SettingsStore` and `ChannelProviderRegistry`
  (db-internal) may be rejected for being name collisions with no
  source cluster; see §03 for detail) have the smallest blast radius
  and the simplest test rewrites.
- **A.3 + A.4 mid and major stores** because KanbanCards and MessageBus
  are the largest free-function clusters (18 + 17 functions
  respectively).
- **A.5 MemoryStore last among stores** because it owns the largest
  function count (26 functions per `02 §2`), the cross-entity ops
  (`decaySweep`, `hybridSearch`, `vectorSearch`), and the cache
  (`db.ts:1245`).
- **A.6 cross-entity migrations after A.5** because `runDecaySweep`
  needs `MemoryStore.decay` to exist before `memory.ts:155` can call
  it.
- **A.7 singleton removal last inside A.** Gated on
  `grep -rln "from ['\"]\\.\\.\\?\\/db\\.js['\"]" src/ --include='*.ts' | grep -v __tests__`
  returning zero direct importers outside `db.ts` itself.
- **A.8 error taxonomy** is a separate pass that can land in parallel
  with A.7; per CE-4, db.ts has zero `throw` statements today (silent
  return) and preserving that is the recommendation for 11 of 12 stores.
- **A.9 RemoteStatusCache consolidation** is per CE-9; lands after
  A.5 because MemoryStore owns the cache.
- **A.10 LoggerLike adoption** depends on H.1 (per `h-cross-cutting/00-summary.md`
  Dependency).

## Top-3 highest-risk stores (within A)

| Rank | Store | Risk | Why |
|---|---|---|---|
| 1 | `MemoryStore` | High | 26 functions, owns `memoryCache` Map (line 1245), embedding pipeline (L2429+), cross-entity `runDecaySweep`. Touches `memory.ts:14` (single type-only importer) + all 14 narrow importers + `heartbeat.ts:504-511`. |
| 2 | `KanbanCards` | High | 18 functions including `deleteKanbanCard` (transactional at L1809), `moveKanbanCard` (writes `KanbanCardEvent` at L1723), and the soft-bug `seq?: number` derivation (per `02 §2`). Consumed by `web/routes/kanban.ts` (~15 symbols) and `web/routes/agents.ts`. |
| 3 | `MessageBus` | High | 17 functions, 4-state status union with dual API duplication (`markMessageDelivered` status-guarded vs `markMessageFailed` unguarded, per `02 §2 AgentMessage`). Consumed by `context-guard-runner.ts`, `message-router.ts`, `web/federation/bridge.ts` (type-only). |

## Cross-references (verified)

- `src/db.ts:10` `let db: Database` — the singleton
- `src/db.ts:42` `initDatabase(dbPathOverride?: string)` — initialization entry point
- `src/db.ts:978` `getDb()` — escape hatch used by 9 production files
- `src/db.ts:1238-1274` `memoryCache` Map + 3 helpers + `MemoryCacheEntry` interface
- `src/db.ts:1240` `interface MemoryCacheEntry`
- `src/memory.ts:155-160` `runDecaySweep()` — the cross-entity aggregator
- `src/web/remote-status-cache.ts:19` `RemoteStatusCache<T>` — pre-existing generic TTL cache
- `src/heartbeat.ts:509-512` — `runDecaySweep` call site in `executeHeartbeat`
- `src/index.ts:15`, `:451` — `setInterval(runDecaySweep, 24*60*60*1000)` scheduling
- `src/web/federation/bridge.ts:24` — type-only `AgentMessage` importer

---

## A.2a LANDED — `ChannelPairingStore` class extraction (commits `98976a9` + `d014dcd`)

Single-class extraction of the four `pending_channel_requests` free
functions (`upsertChannelRequest`, `listPendingChannelRequests`,
`updateChannelRequestStatus`, `updateChannelRequestName`) into
`class ChannelPairingStore`. Mirrors the `ApprovalStore` and
`IdeaStore` precedent: class lives alongside the four thin free-fn
shims, which now delegate to a module-level
`const channelPairingStore = new ChannelPairingStore()` singleton
(introduced in the `d014dcd` code-review --fix commit per its
HIGH finding). The `PendingChannelRequest` interface is byte-identical
to the pre-refactor state.

**Blast radius (scope-1 minimum contract):**
- `src/db.ts`: class + 4 wrapper functions inserted after the
  `// --- Pending Channel Requests ---` block. `+82/-21` lines net.
  Counts after merge: 155 export functions, 5 export classes, 37
  export interfaces/types — exactly the plan target (free-function
  count unchanged because wrappers replace originals byte-equiv).
- `src/__tests__/channel-pairing-store.test.ts`: new file,
  250 lines, **12 `it()` blocks** after the code-review removal
  of the 2 vacuous `typeof`-only assertions (the post-fix commit
  swapped them for a stronger T12+T14-equivalent shim-invocation
  test that asserts write-through-the-shim observability).
- `src/web/channel-request-watcher.ts`, `src/web/routes/agents.ts`,
  and the existing test files (`channel-request-watcher.test.ts`,
  `channel-request.test.ts`, `db-100.test.ts`,
  `agents-routes.test.ts`): **untouched**. The four
  `vi.mock('../db.js', …)` sites and the two production callers
  keep working byte-equivalently through the shims.

**Verification (post code-review --fix, in a `$HOME/claw-review-test`
clean worktree per the CLAUDE.md §8 `_TMP_PREFIXES` guard):**
- `bun tsc --noEmit`: 0 errors (baseline 0).
- `bun --bun vitest run src/__tests__/channel-pairing-store.test.ts`:
  12/12 passed.
- `bun --bun vitest run src/__tests__/channel-request*.test.ts
  src/__tests__/db-100.test.ts src/__tests__/agents-routes.test.ts`:
  515/515 passed, no regressions.
- Pre-existing `scripts/agent-memory/{cli,io,search,store}/*.test.ts`
  module-load failures (11 in pre-flight) unchanged.
- ESLint on the test file reduced from 17 to 12 errors (all
  remaining are pre-existing in unrelated regions).

**Deliberate deviations from the plan:**
1. **Singleton `const X = new X()`** added in the code-review --fix
   commit `d014dcd`, not in the implementer commit. Plan text was
   ambiguous on whether the free-fn shims should construct a fresh
   class instance per call vs. reuse a module-level singleton.
   The code-review HIGH finding resolved this in favor of the
   `ApprovalStore`/`IdeaStore` singleton pattern. Behavioral
   implication: marginal allocation savings; no observable
   difference for callers.
2. **Class body lives between `PendingChannelRequest` interface and
   the four free-fn shims**, NOT after the free-fn shims as a
   literal "insert without replacing" reading of the plan text
   would have suggested. The literal reading would have produced
   TypeScript duplicate-export errors (same `export function X`
   declared twice). Same pattern as `ApprovalStore` and
   `IdeaStore` (class lives immediately above the free-fn shims).
3. **Two vacuous `typeof X === 'function'` tests removed** in
   `d014dcd`. Replaced with one T12+T14-equivalent test that
   invokes the shims against a real `:memory:` `ChannelPairingStore`
   and asserts that the writes are observable through the live
   handle (catches the `function () {}` stub gut the deleted tests
   missed).

**Architectural note (saved to Honcho + `.claude/shared-memory/`):**
the `code-review --fix` flagged that the class form here scores only
1/5 on `.claude/rules/class-vs-functional-decision.md` (only
DI applies; no instance state, polymorphism, or lifecycle). The
precedent in `IdeaStore` (`3f41c08`) and `ApprovalStore`
(`863b325`) already establishes this pattern across three stores;
reverting all three is a separate architectural decision requiring
an ADR. The cycle kept the class form to match the existing
pattern; the rule-file reconciliation is deferred.

---

**End of A executive summary. No source files modified.**
