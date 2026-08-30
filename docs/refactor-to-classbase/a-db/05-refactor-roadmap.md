# A (db) — Refactor roadmap

Ordered phases for the A subsystem only. Each phase: goal, files
touched, risk level, test coverage requirement, rollback strategy,
parallelizable.

**Reading note.** Phases are ordered to minimize blast radius: the
keystone first (so the constructor signature exists), then leaves
(smallest blast radius), then mids, then majors, then the
largest/cross-entity, then singleton removal, then error taxonomy,
then cache consolidation, then logger adoption. The order mirrors
the dependency graph from `03-class-boundaries.md §A11`:
`MaintenanceOps → {Memory, AuditLog, TokenUsage, ...} → db` is
single-direction (no cycles), and every phase's output is required
input for the next.

**Verifiability gate (per CLAUDE.md §8):** every phase below assumes
the current worktree's `bun tsc --noEmit`, `bun run lint`, and
`bun --bun vitest run` baselines are measured and recorded BEFORE
phase execution. The "Test coverage requirement" column cites the
target subset, not the full suite (running 382 tests per phase is
overhead). Per `b-config/05-refactor-roadmap.md` precedent, the
verifiability gate is "tartsd N-en" (preserve the current count),
not "should be green" (which is unverifiable without a baseline).

---

## A.1 — `DbClient` keystone extraction

**Goal:** Introduce `class DbClient` alongside `let db: Database` at
`src/db.ts:10`. The class wraps the `bun:sqlite` handle, exposes a
narrow SQL facade (`query`, `exec`, `transaction`, `getHandle`),
and a `static open()` factory equivalent to `initDatabase()`. The
`let db` singleton and `getDb()` escape hatch both survive as
thin pass-throughs.

**Files touched:**
- `src/db.ts` — add `class DbClient` definition (new ~80 lines),
  refactor `initDatabase` to delegate to `DbClient.open(...)`,
  keep `let db: Database` at L10.
- One new test file: `src/__tests__/db-client.test.ts` — covers the
  constructor, `query`, `exec`, `transaction`, `getHandle`, `close`.

**Risk level:** **Low.** The class is purely additive; no consumer
changes behavior. The 9 production `getDb()` callers (per `01 §1.3`)
keep working unchanged.

**Test coverage requirement:**
- `bun tsc --noEmit`: must remain at the current baseline (1742 errors
  per CLAUDE.md §8 precedent; the new class adds ~5-10 lines of type
  surface, no new errors).
- `bun --bun vitest run src/__tests__/db-client.test.ts`: must be 100%
  green; new file.
- `bun --bun vitest run src/__tests__/db.test.ts`: must remain at the
  current baseline (the existing `db.ts` tests do not exercise
  `DbClient` yet, but they do exercise `initDatabase` + `getDb` which
  now delegate).

**Rollback strategy:** `git revert` the single A.1 commit. The
`DbClient` class is added at the bottom of `db.ts`; reverting
restores the original `let db` + `initDatabase` + `getDb` shape
with zero behavioral change.

**Parallelizable:** **No.** A.1 is the keystone; every subsequent
phase depends on `DbClient` existing. A.1 must land first.

**Verification gate (measurable before phase execution):**
- `grep -c "^export function " src/db.ts` = **158** (unchanged after A.1).
- `grep -c "^export (interface|type) " src/db.ts` = **41** (unchanged).
- `bun tsc --noEmit 2>&1 | grep -c "error TS"` = current baseline TBD.

---

## A.2 — Leaf stores (5 small clusters)

**Goal:** Introduce 5 leaf-store classes alongside their free
functions. Each class is purely additive; free functions stay as
thin pass-throughs.

**Files touched:**
- `src/db.ts` — add 5 class definitions (`Scheduler` A.5, `IdeaStore`
  A.9, `ApprovalStore` A.7, `ChannelPairingStore` A.13, plus the
  `MemoryStore`'s `MemoryCategory` sealed-class helper from A.8 §7).
- One new test file per store:
  - `src/__tests__/scheduler-store.test.ts`
  - `src/__tests__/idea-store.test.ts`
  - `src/__tests__/approval-store.test.ts`
  - `src/__tests__/channel-pairing-store.test.ts`

**Risk level:** **Low–Medium.** Each leaf has 4–10 functions and a
small blast radius (per `03-class-boundaries.md Per-store blast-radius
table`). The cross-store hook in `IdeaStore.revertFromKanban` requires
a `KanbanCards` constructor argument (or late-binding via `App`).

**Sub-phases (sequential, each with its own commit):**
- **A.2a:** `ChannelPairingStore` (4 functions, lowest blast radius).
- **A.2b:** `Scheduler` (8 functions; cross-store hook to
  `BackgroundTaskPool` is wired by `App` post-A.3).
- **A.2c:** `IdeaStore` (8 functions; cross-store hook to `KanbanCards`
  wired by `App` post-A.4).
- **A.2d:** `ApprovalStore` (5 functions).
- **A.2e:** `MemoryStore`'s `MemoryCategory` sealed class (per A.8
  §7 — only the type, no method body change).

**Test coverage requirement:**
- Each new test file: 100% green.
- Existing tests for the migrated clusters: must remain at baseline
  (e.g., `routes-schedules.test.ts`, `ideas-routes.test.ts`,
  `routes-approvals-full.test.ts`, `channel-request-watcher.test.ts`).

**Rollback strategy:** Per-sub-phase `git revert`. Each sub-phase is
a single commit; reverting restores the pre-A.2 shape.

**Parallelizable:** **Yes** (across sub-phases A.2a–A.2e). Different
sub-phases touch disjoint functions; no merge conflicts beyond the
single `db.ts` file.

**Verification gate (measurable before phase execution):**
- `grep -c "^export function " src/db.ts` = **158** (unchanged after
  A.2; classes are added without removing free functions).
- `bun --bun vitest run src/__tests__/{scheduler,idea,approval,channel-pairing}-*.test.ts`
  = 100% green (new files).

---

## A.3 — Mid stores (3)

**Goal:** Introduce 3 mid-size store classes alongside their free
functions.

**Files touched:**
- `src/db.ts` — add 3 class definitions (`BackgroundTaskPool` A.6,
  `SpanStore` A.8, `SshVault` A.10).
- New test files: `src/__tests__/background-task-pool.test.ts`,
  `src/__tests__/span-store.test.ts`, `src/__tests__/ssh-vault.test.ts`.

**Sub-phases (sequential):**
- **A.3a:** `BackgroundTaskPool` (6 functions; transactional `createAtomic`
  has the strictest invariant — L1503-1514).
- **A.3b:** `SpanStore` (4 functions; `upsert` uses `ON CONFLICT DO
  UPDATE` per `02 §2`).
- **A.3c:** `SshVault` (9 functions; `deleteKey` has transactional
  unassign-server side effect at L3061).

**Risk level:** **Medium.** The mid stores have transactional
behaviors and cross-table invariants. The `BackgroundTaskPool.createAtomic`
concurrent-cap guard (L1503-1514) is the load-bearing invariant.

**Test coverage requirement:**
- Each new test file: 100% green; the transactional cases
  (`createAtomic` cap, `deleteKey` unassign) must be covered.
- Existing tests (`background-tasks-routes.test.ts`, `spans-routes.test.ts`,
  `routes-vault-ssh.test.ts`): must remain at baseline.

**Rollback strategy:** Per-sub-phase `git revert`.

**Parallelizable:** **Yes** (A.3a–A.3c touch disjoint function ranges
in `db.ts`).

---

## A.4 — Major stores (2)

**Goal:** Introduce `KanbanCards` and `MessageBus` classes alongside
their free functions.

**Files touched:**
- `src/db.ts` — add `KanbanCards` (A.3 in 03-class-boundaries; 26
  functions including Labels per `01 §4`) + `MessageBus` (A.4 in
  03-class-boundaries; 17 functions per M7-corrected signatures).
- New test files: `src/__tests__/kanban-cards.test.ts`,
  `src/__tests__/message-bus.test.ts`.

**Sub-phases:**
- **A.4a:** `MessageBus` (17 functions; status-guarded transitions
  are the load-bearing part — `markDelivered`, `markDone`,
  `markFailed`).
- **A.4b:** `KanbanCards` (26 functions including Labels; the
  `markScheduledTaskWaiting` cross-store hook is wired by `App`
  post-A.4).

**Risk level:** **High.** These are the largest single-cluster
migrations. The M7-corrected `MessageBus` signatures must be
byte-identical to the source functions (per `review-correctness.md
M7`). The `KanbanCard.seq?` soft-bug (per `02 §2`) must be
documented in the class but not fixed in this phase (out of scope).

**Test coverage requirement:**
- Each new test file: 100% green.
- Existing tests (`kanban-routes.test.ts`, `agents-routes.test.ts`,
  `message-router-tick-cap.test.ts`, `message-router-full.test.ts`,
  `context-guard-runner.test.ts`): must remain at baseline.

**Rollback strategy:** Per-sub-phase `git revert`.

**Parallelizable:** **No** (A.4b depends on A.4a's class being in
place to avoid the `markScheduledTaskWaiting` cross-store hook
resolving to a free function before the class exists).

---

## A.5 — `MemoryStore`

**Goal:** Introduce `MemoryStore` alongside its 26 free functions +
the embedding pipeline. Also extract `EmbeddingClient` (per OE-10).

**Files touched:**
- `src/db.ts` — add `MemoryStore` class (26 functions) + private
  `EmbeddingClient` consumer (the embedding functions move to the
  new client).
- One new file: `src/db/embedding-client.ts` [ASSUMPTION] —
  `class EmbeddingClient` extracted per OE-10.
- One new file: `src/util/ttl-cache.ts` [ASSUMPTION] — `TtlCache<K, V>`
  utility (per CE-9 / A.9 below; created here so MemoryStore takes
  it as a constructor arg).
- New test files: `src/__tests__/memory-store.test.ts`,
  `src/__tests__/embedding-client.test.ts`.

**Sub-phases:**
- **A.5a:** Create `src/util/ttl-cache.ts` with `TtlCache<K, V>`.
  **Independent** of MemoryStore; can land in parallel with A.2/A.3.
- **A.5b:** Extract `EmbeddingClient` to `src/db/embedding-client.ts`.
  Refactor `generateEmbedding`, `hybridSearch`, `backfillEmbeddings`
  to delegate.
- **A.5c:** Introduce `MemoryStore` class alongside the 26 free
  functions. Wire the cache via constructor injection.
- **A.5d:** Replace `memoryCache` Map at `db.ts:1245` with
  `TtlCache<string, Memory[]>` instance on `MemoryStore`.

**Risk level:** **High.** This is the largest single-cluster
migration; touches `memory.ts:14`, `heartbeat.ts:504-511`, all
14 narrow importers via the decay sweep chain.

**Test coverage requirement:**
- New test files: 100% green.
- Existing tests (`memory.test.ts`, `routes-recall.test.ts`,
  `routes-daily-log.test.ts`, `memories-routes.test.ts`,
  `heartbeat.test.ts`): must remain at baseline.

**Rollback strategy:** Per-sub-phase `git revert`. A.5d is the
highest-risk rollback (the cache key shape must stay stable per
`01 §8` constraint).

**Parallelizable:** A.5a can land in parallel with A.2/A.3 (no
dependency). A.5b–A.5d are sequential.

---

## A.6 — Cross-entity migrations (`MaintenanceOps`)

**Goal:** Introduce `MaintenanceOps` class wrapping the cross-entity
sweeps: `runDecaySweep`, `pruneAuditLogs`, `pruneTokenUsage`,
`markOrphanedTasksFailed`, `expireTimedOutApprovals`,
`pruneToolCallLog`.

**Files touched:**
- `src/db.ts` — add `MaintenanceOps` class + sibling helper classes
  (`AuditLog`, `TokenUsagePruner`, `ToolLog`).
- `src/memory.ts` — refactor `runDecaySweep()` at L155-160 to
  delegate to `maintenanceOps.runDecaySweep()` (the aggregator
  location stays per AR8 below).
- `src/index.ts:15`, `:451` — the `setInterval(runDecaySweep, ...)`
  scheduling becomes `setInterval(() => app.maintenanceOps.runDecaySweep(), ...)`.
- `src/heartbeat.ts:509-512` — the opportunistic `runDecaySweep()`
  call in `executeHeartbeat` becomes
  `this.memoryStore.runDecaySweep()` (via F.1's `MemoryStore` instance
  reference) OR `this.maintenanceOps.runDecaySweep()` (if F.1 wires
  MaintenanceOps).
- New test file: `src/__tests__/maintenance-ops.test.ts`.

**Sub-phases:**
- **A.6a:** Introduce sibling helpers (`AuditLog`, `TokenUsagePruner`,
  `ToolLog`) as standalone classes wrapping their free functions.
- **A.6b:** Introduce `MaintenanceOps` class; wire
  `runDecaySweep` to `memory.decay + auditLog.prune + tokenUsage.prune`.
- **A.6c:** Migrate `src/memory.ts:155-160` to delegate to
  `maintenanceOps.runDecaySweep()`.
- **A.6d:** Migrate `src/index.ts:15`, `:451` to use the App-level
  MaintenanceOps instance.
- **A.6e:** Migrate `src/heartbeat.ts:509-512` to use the
  MaintenanceOps or MemoryStore instance (decision deferred to F.1).

**Risk level:** **High.** The CE-8 circular-dependency concern
(per `01 §7`) is the load-bearing risk. The single-direction chain
must be verified:
```
HeartbeatScheduler → MaintenanceOps → {MemoryStore, AuditLog, TokenUsagePruner}
                  → {MemoryStore.decay(), AuditLog.prune(), TokenUsagePruner.prune()}
                  → DbClient → db (raw)
```
No cycle. The `MemoryStore.decay()` method is the `db.ts:1213`
`decayMemories()` (per AR3 below); it does NOT call `MaintenanceOps`.

**Test coverage requirement:**
- `src/__tests__/maintenance-ops.test.ts`: 100% green; covers
  `runDecaySweep` end-to-end (verifies all 3 sub-sweeps fire).
- Existing tests (`memory.test.ts`, `heartbeat.test.ts`,
  `heartbeat-cov.test.ts`, `index.test.ts`, `tool-log-routes.test.ts`,
  `routes-approvals-full.test.ts`): must remain at baseline.

**Rollback strategy:** Per-sub-phase `git revert`. A.6c is the
highest-risk rollback (the `memory.ts:155` aggregator change
affects every `runDecaySweep` caller).

**Parallelizable:** **No** (A.6b depends on A.6a; A.6c depends on
A.6b; A.6d/A.6e depend on A.6c).

---

## A.7 — Singleton removal

**Goal:** Remove `let db: Database` at `db.ts:10`, `initDatabase()`
at L42, `getDb()` at L978, and all 158 free functions (the
pass-through wrappers). The 14 narrow importers + 25 routes + 1
script must have migrated to `DbClient` + the entity-store classes.

**Files touched:**
- `src/db.ts` — delete `let db`, `initDatabase`, `getDb`, all 158
  free functions. Keep only the type exports (41 interface/type)
  + the 13 class definitions.
- All 39 production importers — must be already migrated (the gate
  below enforces this).
- 50 `vi.mock('../db.js', …)` test files — rewritten to
  `createTestDb(overrides?)` factory (per `review-correctness.md CE-5`).
- New test file: `src/__tests__/create-test-db.test.ts` — covers the
  factory itself.

**Risk level:** **Critical.** This is the irreversible phase. The
gate is:
```
grep -rln "from ['\"]\\.\\.\\?\\/db\\.js['\"]" src/ --include='*.ts' \
  | grep -v __tests__ \
  | grep -v '^src/db\.ts$'
```
must return **zero** results. If any production file still imports
from `db.js`, the removal breaks the build.

**Test coverage requirement:**
- `bun --bun vitest run`: full suite must remain at baseline + new
  green (the 50 `vi.mock('../db.js')` rewrites must produce the
  same assertion outcomes).
- The 9 production `getDb()` callers must have migrated to
  `dbClient.getHandle()` OR received a `DbClient` instance via
  constructor injection.

**Rollback strategy:** `git revert` the A.7 commit. Restores
`let db`, `initDatabase`, `getDb`, and the 158 free functions as
thin pass-throughs (the classes survive; the wrappers restore).
This is a one-commit revert; nothing else needs to change.

**Parallelizable:** **No.** A.7 is the terminal phase of A.

**Verification gate (measurable before phase execution):**
- `grep -rln "from ['\"]\\.\\.\\?\\/db\\.js['\"]" src/ --include='*.ts' | grep -v __tests__`
  = 0 files outside `src/db.ts`.
- `grep -rln "vi\.mock.*['\"]\\.\\.\\/db\\.js" src/__tests__/`
  = 0 files (all 50 rewritten to `createTestDb`).
- `bun tsc --noEmit 2>&1 | grep -c "error TS"` ≤ baseline + 0.

---

## A.8 — Error class taxonomy (per CE-4)

**Goal:** Introduce typed error subclasses for the A stores where
they add value. Per `02 §9`, db.ts has zero `throw` statements
today (silent return is the deliberate design); the recommendation
is to **preserve silent-return for 11 stores** and introduce
`MemoryStoreError` only (the FTS5 parse failure at L1182-1184 and
the cosineSimilarity failure at L2464-2469).

**Files touched:**
- `src/db.ts` — add `MemoryStoreError` class definition (extends
  Error with structured `{ query, cause }` fields per R6).
- New test file: `src/__tests__/memory-store-error.test.ts` —
  covers the structured-field shape and the throw-site coverage.

**Sub-phases:**
- **A.8a:** Introduce `MemoryStoreError` with structured fields
  `{ query: string; cause: unknown }` (per R6).
- **A.8b:** Migrate `searchMemories` (L1168-1184) from
  `try { ... } catch { return [] }` to `throw new MemoryStoreError(query, cause)`.
- **A.8c (deferred):** If the user opts in to typed errors for other
  stores, follow the `02 §9 Option (b)` table:
  - `MessageBusError` for status-guarded update failures (L2060, L2169, L2189)
  - `KanbanStateError` for illegal transitions (none today, future-proofing)
  - `ApprovalError` for non-pending resolve (L3193 when `changes === 0`)
  - `OtelSpanError` for unknown trace/span close (L3269 when `changes === 0`)

**Risk level:** **Low** for A.8a–A.8b (one error class, one throw
site). **Medium** for A.8c (breaking change for catch sites that
today assert `=== false` for not-found; per CE-4 ~400+ call sites
affected across the 4 stores).

**Test coverage requirement:**
- `src/__tests__/memory-store-error.test.ts`: 100% green.
- Existing `memory.test.ts` tests that assert `[]` on FTS5 parse
  failure must be updated to assert `throw MemoryStoreError`.

**Rollback strategy:** Per-sub-phase `git revert`. A.8a–A.8b are
single-commit reverts; A.8c would need per-store reverts if the
user opts in.

**Parallelizable:** **Yes** (A.8 can land in parallel with A.5–A.6
because it touches only `MemoryStore`'s `search` method, which is
not on the A.6 cross-entity path).

---

## A.9 — `RemoteStatusCache<T>` consolidation (per CE-9)

**Goal:** Replace `db.ts:1238-1274` `memoryCache` with the shared
`TtlCache<K, V>` utility (per `04-generic-interfaces.md §3`). Also
migrate `web/routes/agents.ts:204-205` from
`RemoteStatusCache<T>` to `TtlCache<T, T>`.

**Files touched:**
- `src/util/ttl-cache.ts` (created in A.5a) — gains `invalidatePrefix`
  and `clearAll` methods.
- `src/db.ts` — `memoryCache` Map removed; `MemoryStore` takes
  `cache: TtlCache<string, Memory[]>` via constructor.
- `src/web/remote-status-cache.ts` — either deleted (if no other
  consumers) OR kept as a deprecated thin wrapper that delegates to
  `TtlCache`.
- `src/web/routes/agents.ts:204-205` — `RemoteStatusCache<T>` instances
  replaced with `TtlCache<T, T>`.
- New test file: `src/__tests__/ttl-cache.test.ts` — covers the
  utility's `getOrRefresh`, `invalidate`, `invalidatePrefix`, `clearAll`,
  `size`.

**Risk level:** **Medium.** The cache key shape and TTL must stay
stable (per `01 §8` constraint). The `invalidatePrefix` semantic
must match `db.ts:1260-1263`'s prefix-iteration exactly.

**Test coverage requirement:**
- `src/__tests__/ttl-cache.test.ts`: 100% green.
- Existing `memory.test.ts` cache tests: must remain at baseline.
- Existing `web/routes/agents.ts` tests (if any): must remain at
  baseline.

**Rollback strategy:** Single-commit `git revert`. The `TtlCache`
utility is additive; reverting restores `RemoteStatusCache<T>` +
`db.ts:1245` `memoryCache` with no behavioral change.

**Parallelizable:** **No** (depends on A.5d — the `memoryCache`
removal requires `MemoryStore.cacheSize` + `MemoryStore.clearCache`
to exist).

---

## A.10 — `LoggerLike` adoption across A classes

**Goal:** Add `log: LoggerLike` constructor parameter to the A
classes that need it. Per `02 §8`, only `MemoryStore` (A.5) and
`AgentMessageStore` (rejected — `MessageBus` does not need a
logger per `02 §8`) qualify.

**Files touched:**
- `src/db.ts` — `MemoryStore` constructor signature gains
  `log: LoggerLike` parameter (already present per `03 §A2`
  sketch).
- Test code: the `createTestDb` factory (from A.7) provides a
  default `LoggerLike` for tests that don't care about logging.

**Risk level:** **Low.** Per `02 §8`, only `MemoryStore` and
`AgentMessageStore` qualify; `MessageBus` does not need a logger
(the brief asked for it but `02 §8` argued against). The logger
injection is additive; existing code keeps working if the
parameter is optional.

**Test coverage requirement:**
- Existing tests: must remain at baseline; the default `LoggerLike`
  in `createTestDb` is a no-op `{ info, warn, error, debug }` literal.

**Rollback strategy:** Single-commit `git revert`.

**Parallelizable:** **Yes** (depends only on H.1; can land in
parallel with A.5/A.6 once H.1 is in place).

---

## Phase dependency summary

```
B.1, H.1 ──► A.1 ──► A.2a-d, A.3a-c, A.4a-b, A.5a (TtlCache utility)
                          │      │       │       │
                          └──────┴───────┴───────┴──► A.5b-c (MemoryStore + EmbeddingClient)
                                                          │
                                                          ▼
                                                        A.5d (cache replacement)
                                                          │
                                                          ▼
                                                        A.6a-b (MaintenanceOps + siblings)
                                                          │
                                                          ▼
                                                        A.6c-e (memory.ts + index.ts + heartbeat.ts migration)
                                                          │
                                                          ▼
                                                        A.7 (singleton removal; gated on every importer + 50 vi.mock rewrites)
                                                          │
                                                          ▼
                                                        A.8 (error taxonomy)
                                                          │
                                                          ▼
                                                        A.9 (RemoteStatusCache consolidation; depends on A.5d)
                                                          │
                                                          ▼
                                                        A.10 (LoggerLike adoption; depends on H.1)
```

**Critical path:** B.1 → A.1 → A.5b → A.5d → A.6b → A.6c → A.7.
The A.7 gate (zero direct importers + 50 vi.mock rewrites) is the
terminal phase; everything before it is preparation, everything
after it (A.8, A.9, A.10) is parallelizable post-hoc cleanup.

---

**End of A refactor roadmap. No source files modified.**
