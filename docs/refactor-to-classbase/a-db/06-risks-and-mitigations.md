# A (db) — Risks and mitigations

Risks specific to the A subsystem. Each risk: name, where-it-bites,
mitigation, detection signal. Cross-references to the framework
reviews (`review-correctness.md` C/M, `review-completeness.md` CE/OE)
and the per-store blast-radius table in `03-class-boundaries.md`.

---

## AR1 — 14-narrow / 39-broad importer blast radius

### Where it bites

- **Narrow importers** (`grep -rln "from '\./db\.js'\|from '\.\./db\.js'"`
  per `01 §3`): 4 top-level + 10 `web/` = **14 files**.
- **Broad importers** (any path matching `db.js`, including `web/routes/*`
  + `scripts/`): **39 files** total.
- **50 `vi.mock('../db.js', …)` test sites** (per `01 §6`).
- The largest single importers:
  - `src/memory.ts` (9 symbols at L13-15)
  - `src/web/routes/agents.ts` (5 symbols)
  - `src/web/routes/kanban.ts` (~15 symbols)
  - `src/web/routes/ideas.ts` (11 symbols)
  - `scripts/dashboard-user.ts` (8 symbols)

### Mitigation

1. **Phased migration** per `05-refactor-roadmap.md` — A.1 keystone
   first, A.2 leaf stores, A.3 mid, A.4 major, A.5 MemoryStore,
   A.6 cross-entity, A.7 singleton removal. Each phase is a single
   commit; rollback granularity is per-phase.
2. **Introduce alongside free functions** (per the B.1 / E.1 / F.1
   precedent). The 158 free functions stay as thin pass-throughs
   during the migration window; A.7 removes them only after every
   importer migrates.
3. **Per-phase route handler migration** via `RouteContext` DI seam
   (per B.3's existing `RouteContext` extension). The 25 `web/routes/*`
   files pick up store instances via `RouteContext.db.<store>` —
   one file edit per route handler.

### Detection signal

- `grep -rln "from ['\"]\\.\\.\\?\\/db\\.js['\"]" src/ --include='*.ts' | grep -v __tests__`
  must drop monotonically across phases (14 → 13 → ... → 0).
- `bun --bun vitest run` per phase: the existing test mocks assume
  free-function names; if a phase breaks a mock, the affected test
  count is the regression signal.

### Precedent

`b-config/06-risks-and-mitigations.md BR1` (60 importer blast radius)
uses the same phased-migration mitigation; the A case is smaller
(14 narrow) but higher complexity per importer (more symbols per
file).

---

## AR2 — 132 `as` boundary casts (zero unsafe)

### Where it bites

- 132 `as` occurrences in `src/db.ts` (per `02 §3` — the framework's
  count of 132 includes 28 in `as const`/structural positions; the
  pure boundary-cast count is 104).
- **All 104 boundary casts are SQL-row-to-typed-entity casts** —
  zero `as any`, zero `as unknown as`, zero `throw` statements.
- The class refactor can contain the boundary casts in a private
  `parseRow<T>(row: unknown): T` helper per store — but the migration
  risks **"casting sprawl"** if every store exposes a public method
  that takes `row: unknown`, degrading type safety.

### Mitigation

1. **Each store owns a private `parseRow<T>`** — the boundary cast
   lives at the store boundary (between SQL `unknown` and the
   typed entity). Public methods stay strongly typed (`Memory[]`,
   `KanbanCard[]`, etc.); the `unknown` never leaks out.
2. **Reuse a single `RowAdapter<T>` helper across stores** [ASSUMPTION:
   if the OE-6 rejection in `04-generic-interfaces.md §1` is revisited]
   — or keep the per-store `parseRow` private method if OE-6 holds.
3. **Document the 4 medium-severity type-widening cases** (per
   `02 §3 Severity table`):
   - `KanbanCard.seq?` derivation bug (L1720) — the cast makes the
     optional claim; the SELECT is the lie. Document in the
     `KanbanCards` class but do NOT fix in this phase (out of scope).
   - `ArchivedKanbanCard.status: string` widening (L1756-1759) —
     narrow to `KanbanCard['status']` in a follow-up.
   - `OtelTraceSummary.status: string` widening (L3277) — narrow to
     `OtelSpan['status']` in a follow-up.
   - `KanbanCardEvent.from_status` widening (L1835) — narrow to
     `KanbanCard['status'] | null`.

### Detection signal

- `grep -nE '\bas any\b|\bas unknown\b|: any\b' src/db.ts` must
  remain at **0** hits after every phase.
- `grep -c " as " src/db.ts` should drop across phases (each
  store consolidates ~5-15 boundary casts into its private
  `parseRow`).

### Precedent

`f-agent-subsystem/02-type-interface-analysis.md §LazyCache` §3
documents a similar boundary-cast situation; the mitigation pattern
is the same (private parse helper per entity).

---

## AR3 — `memory.ts` ↔ `db.ts` cross-entity (CE-8)

### Where it bites

- `src/memory.ts:155-160` `runDecaySweep()` orchestrates 3 free
  functions: `dbDecay()` (= `decayMemories` at `db.ts:1213`),
  `pruneAuditLogs()` (at `db.ts:3006`), `pruneTokenUsage()` (at
  `db.ts:3018`).
- Production callers:
  - `src/index.ts:15` + `:451` — `setInterval(runDecaySweep, 24 * 60 * 60 * 1000)`
  - `src/heartbeat.ts:509-512` — opportunistic call inside
    `executeHeartbeat()`
- If `MemoryStore` owns `runDecaySweep` (per the brief), the
  call chain becomes:
  ```
  HeartbeatScheduler → MemoryStore.runDecaySweep()
                    → MemoryStore.decay()  (= decayMemories())
                    → db.decayMemories() (via the db field on MemoryStore)
  ```
  Plus parallel calls to `AuditLog.prune()` and
  `TokenUsagePruner.prune()` (per A.6 — separate classes, NOT
  on MemoryStore).

### Mitigation (no cycle)

1. **Single-direction dependency** (verified per `03-class-boundaries.md
   §A11`):
   ```
   HeartbeatScheduler (F.1) → MaintenanceOps (A.6)
                            → {MemoryStore, AuditLog, TokenUsagePruner}
                            → DbClient → db (raw)
   ```
   `MemoryStore.decay()` does NOT call `MaintenanceOps`. `MaintenanceOps`
   calls `MemoryStore.decay()` (one direction only).
2. **`memory.ts:155` aggregator location is preserved.** The
   function stays at `src/memory.ts:155` and becomes a thin
   pass-through to `maintenanceOps.runDecaySweep()`. The
   `App`-level wiring ensures the dependency direction is
   `MemoryStore → db`, never the reverse.
3. **Construction order at App boot** (per CE-8):
   ```
   DbClient.open(config, log)
     → MemoryStore(db, cache, embedding, log)
     → AuditLog(db)
     → TokenUsagePruner(db)
     → BackgroundTaskPool(db)
     → ApprovalStore(db)
     → ToolLog(db)
     → MaintenanceOps(memory, auditLog, tokenUsage, backgroundTasks, approvals, toolLog)
     → HeartbeatScheduler(maintenanceOps, ...)  // F.1
   ```

### Detection signal

- `grep -rn "MaintenanceOps\|memoryStore\.runDecaySweep" src/` —
  must show only forward references (no circular import).
- `bun --bun vitest run src/__tests__/maintenance-ops.test.ts` —
  must verify the 3 sub-sweeps fire in the correct order.
- `src/__tests__/heartbeat.test.ts` and `heartbeat-cov.test.ts`:
  the opportunistic `runDecaySweep()` call must continue to work
  via the new instance method.

### Precedent

`b-config/06-risks-and-mitigations.md BR1` (dependency-graph concern)
is the closest precedent; the construction-order table at
`05-refactor-roadmap.md §A.6` is the explicit mitigation.

---

## AR4 — `RemoteStatusCache<T>` reuse (CE-9)

### Where it bites

- `src/db.ts:1238-1274` `memoryCache` Map + 3 helpers +
  `MemoryCacheEntry` interface + `MEMORY_CACHE_TTL_MS` const.
- `src/web/remote-status-cache.ts:19` `RemoteStatusCache<T>`
  class with `getOrRefresh(key, nowMs, fetch, fallback?)`.
- The two overlap conceptually but the existing `RemoteStatusCache`
  lacks 2 capabilities the memory cache has:
  1. **Prefix-based invalidation** (L1260 — iterates keys starting
     with `${agentId}:`).
  2. **Bulk invalidation on shared-category write** (L1292, L1374
     — `clearMemoryCache()` on `'shared'`-category writes).
- **Direction-of-dependency problem:** `db.ts → web/` is backward
  (`db.ts` is depended on by `web/`, not the other way around).

### Mitigation

1. **Create `TtlCache<K, V>` in `src/util/ttl-cache.ts`** (neutral
   location, NOT `src/web/`). Adds the 2 missing methods
   (`invalidatePrefix`, `clearAll`).
2. **`MemoryStore` takes `cache: TtlCache<string, Memory[]>` via
   constructor.** The `memoryCache` Map at `db.ts:1245` is removed.
3. **`web/routes/agents.ts:204-205`** replaces
   `new RemoteStatusCache<T>(...)` with `new TtlCache<T, T>(...)`.
4. **`RemoteStatusCache<T>`** is either deleted (if no other
   consumers — verified per `01 §8`) OR kept as a deprecated thin
   wrapper.

### Detection signal

- `grep -rn "memoryCache" src/db.ts` must return 0 hits after
  A.5d.
- `grep -rn "RemoteStatusCache" src/` — should show only the
  deprecated wrapper (if kept) OR zero hits (if deleted).
- `src/__tests__/memory.test.ts` cache tests (the ones that
  exercise `clearMemoryCache` and `getMemoryCacheSize`) must
  pass via the new `MemoryStore.clearCache()` and
  `MemoryStore.cacheSize()` methods.

### Precedent

`02 §5` final recommendation; `review-completeness.md CE-9`. The
direction-of-dependency fix (move to `src/util/`) is unique to A.

---

## AR5 — Test mock seam shift (50 `vi.mock('../db.js')` sites)

### Where it bites

- **50 test files** use `vi.mock('../db.js', …)` per `01 §6`
  (NOT 35 per framework M4, NOT 49 per `review-correctness.md M4`
  — actual ground-truth is 50, verified by `grep -rE
  "vi\.mock.*['\"]\\.\\.\\/db\\.js" src/__tests__/ | wc -l`).
- Three mock patterns (per `01 §6`):
  - **Full-replacement (~36 files):** `vi.mock('../db.js', () => ({ listKanbanCards: vi.fn()..., ... }))`.
  - **Empty-replacement (5 files):** `vi.mock('../db.js', () => ({}))`.
  - **Partial-replacement (~9 files):** `vi.mock('../db.js', () => ({ getDb: vi.fn(), logConfigChange: vi.fn() }))`.
- The class refactor **breaks all 50 mocks** unless the new export
  shape keeps the existing top-level function names (per `01 §6`
  "Important compatibility constraint").

### Mitigation

1. **Free-function pass-through pattern** (per the B.1 / E.1 / F.1
   precedent + `01 §6` constraint). The classes are internal; the
   free functions stay as `export function searchMemories(...)`
   thin wrappers that delegate to a process-wide singleton store
   instance. **Test mocks stay unchanged through A.6.**
2. **A.7 is the rewrite point.** When A.7 removes the free functions,
   every test mock must be rewritten to `createTestDb(overrides?)`
   factory (per `review-correctness.md CE-5`).
3. **`createTestDb` factory design** (the convention-setting piece):
   ```ts
   // src/__tests__/create-test-db.ts
   export function createTestDb(overrides?: Partial<DbClientOptions>): {
     dbClient: DbClient
     memoryStore: MemoryStore
     kanbanCards: KanbanCards
     messageBus: MessageBus
     // ... all 13 stores
   }
   ```
   The factory wires the stores per the construction order from
   `05-refactor-roadmap.md §A.6`. The first 5-10 tests that adopt
   the factory set the convention; everything after copies it.

### Detection signal

- `grep -rln "vi\.mock.*['\"]\\.\\.\\/db\.js" src/__tests__/` must
  drop monotonically across A.7 (50 → 0).
- The first 5-10 test rewrites in A.7 must produce the same
  assertion outcomes as the mock-replaced versions (no test
  regression introduced by the rewrite).

### Precedent

`b-config/06-risks-and-mitigations.md BR2` (154 vi.mock rewrites)
is the larger-scale precedent; A.7's 50-rewrite surface is smaller
but follows the same factory-pattern design.

---

## AR6 — `EmbeddingClient` separation (per OE-10)

### Where it bites

- `src/db.ts:2429-2504` — embedding pipeline (`generateEmbedding`,
  `hybridSearch`, `backfillEmbeddings`).
- `src/db.ts:5` — `OLLAMA_URL` config import.
- `src/db.ts:2437-2469` — inner HTTP fetch + cosine similarity.
- The `db.ts:2443` debug-level warning on embedding failure.

### Mitigation

1. **Extract `EmbeddingClient` to `src/db/embedding-client.ts`**
   [ASSUMPTION: filename] with surface:
   ```ts
   class EmbeddingClient {
     constructor(opts: { url: string; log: LoggerLike })
     generate(text: string): Promise<number[] | null>
     cosineSimilarity(a: number[], b: number[]): number
   }
   ```
2. **`MemoryStore` constructor takes `embedding: EmbeddingClient`**
   — NOT `embeddingModel?: string` (per OE-10 rejection).
3. **`generateEmbedding`, `hybridSearch`, `backfillEmbeddings`**
   become free-function pass-throughs that delegate to the
   `MemoryStore` instance, which delegates to `embedding.<method>`.

### Detection signal

- `grep -rn "OLLAMA_URL" src/db.ts` should drop to 0 after A.5b
  (the config import moves to `EmbeddingClient`).
- `src/__tests__/embedding-client.test.ts`: 100% green.
- The `db.ts:2443` debug log moves to `EmbeddingClient`; tests
  that capture `logger.debug` calls must be updated.

### Precedent

`review-completeness.md OE-10`; the rejection of
`embeddingModel?: string` on `MemoryStore` constructor is the
load-bearing argument.

---

## AR7 — Error class taxonomy (per CE-4)

### Where it bites

- `src/db.ts` has **zero `throw` statements** today (per
  `02 §9` — verified by `grep -nE '\bthrow\b|\bnew Error\b' src/db.ts`
  = 0 hits). Failures are signalled by `undefined`/`false`/`null`
  returns.
- The CE-4 R6 example proposes `MemoryStoreError extends Error`
  with `{ query, cause }` structured fields, but does NOT enumerate
  which other stores need error subclasses.
- 400+ call sites affected if typed errors are introduced across
  all stores (per `02 §9 Option (b)` Cons column).

### Mitigation

1. **Preserve silent-return for 11 of 12 stores** (per `02 §9`
   recommendation). The class refactor inherits db.ts's deliberate
   design.
2. **Introduce `MemoryStoreError` only** (per R6):
   - `MemoryStore.search()` throws `MemoryStoreError` on FTS5
     parse failure (replaces the silent
     `try { ... } catch { return [] }` at L1182-1184).
   - `MemoryStore.cosineSimilarity` failure (L2464-2469) stays
     silent (logs at debug, treats as zero-score).
3. **If the user opts in to typed errors for other stores**
   (deferred per A.8c), follow the `02 §9 Option (b)` table:
   - `MessageBusError` for status-guarded update failures (L2060,
     L2169, L2189)
   - `KanbanStateError` for illegal transitions
   - `ApprovalError` for non-pending resolve (L3193)
   - `OtelSpanError` for unknown trace/span close (L3269)

### Detection signal

- `grep -c "throw new" src/db.ts` should be **0** after A.2–A.7
  (no new throw sites). After A.8a–A.8b: should be **1** (only
  `MemoryStore.search`).
- `grep -c "MemoryStoreError" src/db.ts` should be ≥1 after A.8a.
- Existing tests that assert `=== false` or `=== []` for
  not-found conditions must continue to pass (the silent return
  is preserved).

### Precedent

`h-cross-cutting/03-class-boundaries.md §C3` (AppError + first two
concrete subclasses) is the cross-cutting precedent; A.8 is the
A-specific application.

---

## AR8 — Cross-entity migrations (A.6)

### Where it bites

- `runDecaySweep` at `memory.ts:155` orchestrates 3 entities:
  `decayMemories()` (MemoryStore), `pruneAuditLogs()` (AuditLog),
  `pruneTokenUsage()` (TokenUsagePruner).
- `pruneAuditLogs` at `db.ts:3006` touches `config_change_log`,
  `idea_status_log`, `tool_call_log`, `daily_log` (per
  `02 §2 AuditLog`).
- `pruneTokenUsage` at `db.ts:3018` touches `token_usage`.
- `markOrphanedTasksFailed` at `db.ts:1546` touches `background_tasks`.
- `expireTimedOutApprovals` at `db.ts:3229` touches `approvals`.
- `pruneToolCallLog` at `db.ts:2764` touches `tool_call_log`.

### Decision: separate `MaintenanceOps` class (NOT on MemoryStore)

Per `03-class-boundaries.md §A11`, the cross-entity sweeps live on
a separate `MaintenanceOps` class because:

1. `runDecaySweep` touches **3 stores** — MemoryStore alone cannot
   orchestrate.
2. The other sweeps (`markOrphanedTasksFailed`, `expireTimedOutApprovals`,
   `pruneToolCallLog`) are independent of memory hygiene.
3. A separate class makes the construction order explicit at App
   boot (per CE-8).

### Mitigation

1. **`MaintenanceOps` constructor takes the 6 dependent stores.**
   The single-direction chain is `MaintenanceOps → stores → db`.
   No cycles.
2. **`memory.ts:155` aggregator location is preserved** as a thin
   pass-through to `maintenanceOps.runDecaySweep()`.
3. **Sweeps are independent** — `markOrphanedTasksFailed`,
   `expireTimedOutApprovals`, `pruneToolCallLog` delegate directly
   to their respective stores (no cross-entity orchestration).

### Detection signal

- `grep -rn "MaintenanceOps" src/` must show only forward
  references (no circular import).
- `src/__tests__/maintenance-ops.test.ts`: 100% green; covers
  the 3 sub-sweeps of `runDecaySweep` independently.

### Precedent

`review-completeness.md CE-8` (cross-entity circular dependency
concern); the single-direction chain is the mitigation.

---

## AR9 — H subsystem HR4 (`LoggerLike` vs pino.Logger confusion)

### Where it bites

- `MemoryStore` constructor (per `03 §A2`) takes `log: LoggerLike`
  — the H.1 interface, not `pino.Logger` directly.
- The H.1 interface must be structurally compatible with pino's
  `Logger` (per `h-cross-cutting/03-class-boundaries.md §C1` "no
  cast needed") but the test-side `vi.mock('../logger.js')` factories
  may not provide a structurally-valid `LoggerLike`.

### Mitigation

1. **Per H.1 decision:** `type LoggerLike = Logger` (pino satisfies
   the shape structurally). The `MemoryStore` constructor accepts
   `LoggerLike`; pino's `logger` singleton satisfies it.
2. **Per H.2 decision:** test factories provide a
   `{ info, warn, error, debug }` literal — the existing
   `vi.mock('../logger.js')` pattern already provides this shape
   (per `h-cross-cutting/06-risks-and-mitigations.md HR2`: 64 of
   91 mocks have this shape).
3. **For tests that mock `../db.js` but NOT `../logger.js`:** the
   `createTestDb` factory (per AR5) provides a default `LoggerLike`
   that delegates to the real logger singleton.

### Detection signal

- `bun tsc --noEmit` after A.5 must show zero new `LoggerLike`
  type errors.
- `src/__tests__/memory.test.ts` and `heartbeat.test.ts` must
  continue to pass with the new `MemoryStore(log)` constructor
  signature.

### Precedent

`h-cross-cutting/06-risks-and-mitigations.md HR2 / HR4` (LoggerLike
interface shape + pino structural compatibility).

---

## AR10 — Cache key shape stability (per `01 §8`)

### Where it bites

- `memoryCache` Map at `db.ts:1245` uses key shape
  `${agentId}:${limit}:${category}` (constructed inline in
  `getAgentMemories` at L1310-1321).
- `MemoryStore.cacheSize()` and `MemoryStore.clearCache()` (the
  replacements for `getMemoryCacheSize` and `clearMemoryCache`)
  must preserve the key shape exactly.
- The TTL (`MEMORY_CACHE_TTL_MS = 60_000` at L1238) must stay
  at 60 seconds.

### Mitigation

1. **Cache key shape is a private detail of `MemoryStore` and
   `TtlCache<K, V>`** — the public surface (`getAgentMemories`,
   `saveAgentMemory`, `updateMemory`) does not expose the key.
2. **TTL is a constructor option on `TtlCache`**:
   `{ ttlMs: 60_000 }`. Tests can override via `createTestDb`.
3. **Cache invalidation rules are preserved verbatim:**
   - `saveAgentMemory(category='shared')` → `clearCache()` (every
     agent sees shared).
   - `saveAgentMemory(category != 'shared')` →
     `cache.invalidatePrefix(agentId)` (the author's agent).
   - `updateMemory` → same two branches on `before.agent_id` vs
     `new agent_id`.

### Detection signal

- `src/__tests__/memory.test.ts` cache tests (the ones exercising
  `clearMemoryCache` and `getMemoryCacheSize` directly) must
  continue to assert the same outcomes.
- `src/__tests__/ttl-cache.test.ts`: must cover the
  `invalidatePrefix` semantics with the exact `${agentId}:`
  prefix pattern.

### Precedent

`01 §8 Memory Cache` constraint; `02 §5` final recommendation.

---

## AR11 — Per-test factory design (per CE-5)

### Where it bites

- 50 `vi.mock('../db.js')` test sites need a `createTestDb(overrides?)`
  factory (per AR5 + `review-correctness.md CE-5`).
- Without the factory, each test author writes ad-hoc `new DbClient({...})`
  boilerplate, leading to 50 different mock styles.
- The first 5-10 tests that adopt the factory set the convention;
  everything after copies it. **The factory design is the
  load-bearing piece.**

### Mitigation

1. **`createTestDb` factory in `src/__tests__/create-test-db.ts`**
   (test-only file, not in the production source tree).
2. **Factory returns the wired store graph:**
   ```ts
   export function createTestDb(overrides?: Partial<DbClientOptions>): {
     dbClient: DbClient
     memoryStore: MemoryStore
     kanbanCards: KanbanCards
     messageBus: MessageBus
     scheduler: Scheduler
     backgroundTaskPool: BackgroundTaskPool
     approvalStore: ApprovalStore
     spanStore: SpanStore
     ideaStore: IdeaStore
     sshVault: SshVault
     channelPairingStore: ChannelPairingStore
     maintenanceOps: MaintenanceOps
   }
   ```
3. **Per-store factories** (optional, for tests that need only one
   store):
   ```ts
   export function createTestMemoryStore(overrides?: {...}): MemoryStore
   ```
4. **LoggerLike default** — a no-op `{ info, warn, error, debug }`
   literal for tests that don't care about logging (per AR9).

### Detection signal

- The first 5-10 test rewrites in A.7 produce the same assertion
  outcomes as the mock-replaced versions.
- `grep -rn "new DbClient\|new MemoryStore\|new KanbanCards" src/__tests__/`
  should show consistent patterns (all use the factory).

### Precedent

`b-config/06-risks-and-mitigations.md BR2` (154 vi.mock rewrites);
the factory pattern is the same.

---

## AR12 — `KanbanCard.seq?` soft-bug (per `02 §2`)

### Where it bites

- `KanbanCard.seq?: number` is the **only optional field** in an
  otherwise complete table mirror.
- The `SELECT rowid AS seq` clause adds it for the common-case
  list/get queries; queries that omit `rowid AS seq` (e.g.
  `getChildCards` at L1720) return rows **without** `seq`.
- Consumers that read `card.seq` from `getChildCards` results
  silently get `undefined`.

### Mitigation

1. **Document the bug** in the `KanbanCards` class comment but do
   NOT fix in A.4b (out of scope; CLAUDE.md §3 — surgical changes).
2. **Mark as `[ASSUMPTION: behavior preserved]`** in the A.4b
   rollback strategy.
3. **Fix in a follow-up phase** — change `seq?` to `seq: number`
   on `KanbanCard` (after auditing all `SELECT` clauses that omit
   `rowid AS seq`), or make `seq` a derived getter on a sealed
   `KanbanCard` class (per `02 §7` recommendation).

### Detection signal

- `grep -rn "\.seq" src/web/routes/kanban.ts` — must show no
  reads of `card.seq` from `getChildCards` results (or the fix
  is incomplete).
- `src/__tests__/kanban-cards.test.ts` — must include a regression
  test for the `seq?` behavior (the current tests pass because
  they don't exercise the bug).

### Precedent

`02 §2 KanbanCard` type patterns; `02 §12 Plan-tagged findings`
documents this as a known soft-bug.

---

## Summary table

| Risk | Severity | Mitigation phase | Detection signal |
|---|---|---|---|
| AR1 (blast radius) | High | A.1–A.7 phased | `grep -rln "from ['\"]\\.\\.\\?\\/db\.js['\"]" src/ \| grep -v __tests__` drops to 0 |
| AR2 (132 casts) | Low | Per-store `parseRow<T>` | `grep -nE '\bas any\b\|\bas unknown\b' src/db.ts` = 0 |
| AR3 (CE-8 cycle) | High | Single-direction chain; `MaintenanceOps` separate | `grep -rn "MaintenanceOps" src/` forward-only |
| AR4 (CE-9 reuse) | Medium | `TtlCache<K, V>` in `src/util/` | `grep -rn "memoryCache" src/db.ts` = 0 after A.5d |
| AR5 (50 mocks) | High | Free-function pass-throughs; `createTestDb` factory | `grep -rln "vi\.mock.*['\"]\\.\\.\\/db\.js" src/__tests__/` = 0 after A.7 |
| AR6 (OE-10 split) | Low | `EmbeddingClient` separate class | `grep -rn "OLLAMA_URL" src/db.ts` = 0 after A.5b |
| AR7 (CE-4 errors) | Low | Silent return preserved; `MemoryStoreError` only | `grep -c "throw new" src/db.ts` = 1 after A.8 |
| AR8 (cross-entity) | High | `MaintenanceOps` separate class | `src/__tests__/maintenance-ops.test.ts` green |
| AR9 (HR4 logger) | Low | `LoggerLike` structural compatibility | `bun tsc --noEmit` zero new errors |
| AR10 (cache shape) | Medium | Private key shape; constructor TTL | `src/__tests__/memory.test.ts` cache tests pass |
| AR11 (CE-5 factory) | Medium | `createTestDb` factory + first 5-10 tests | First 5-10 rewrites produce same outcomes |
| AR12 (`seq?` bug) | Low | Document + follow-up phase | `grep -rn "\.seq" src/web/routes/kanban.ts` audited |

---

**End of A risks-and-mitigations plan. No source files modified.**
