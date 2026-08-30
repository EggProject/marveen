# A (db) — Generic interfaces

Generics and abstractions specific to the A subsystem. Every candidate
is argued against the OE-6 threshold (2+ consumers with a true shared
shape, or one consumer + a documented future-proofing argument).
`02-type-interface-analysis.md §6` is the input lens; `review-completeness.md
OE-6` / `OE-8` / `OE-10` and `f-agent-subsystem/02-type-interface-analysis.md
§LazyCache` are the precedents.

**Reading note.** Three generics are examined: `BaseStore<TEntity>`
(rejected on OE-6), `EmbeddingClient` (accepted — separate class to
avoid coupling embedding pipeline to `MemoryStore`), `TtlCache<K, V>`
(accepted — supersedes `RemoteStatusCache<T>` per CE-9). All other
candidate generics are either rejected on OE-6 grounds or never
proposed.

---

## 1. `BaseStore<TEntity>` — REJECTED on OE-6

### Sketch (rejected)

```ts
abstract class BaseStore<TEntity extends { id: ID }> {
  protected abstract table: string
  protected abstract columns: readonly (keyof TEntity)[]
  protected abstract toRow(entity: TEntity): Record<string, SQLQueryBindings>
  protected abstract fromRow(row: unknown): TEntity
  abstract list(...): TEntity[]
  abstract get(id: TEntity['id']): TEntity | undefined
  abstract create(input: Omit<TEntity, 'id' | 'created_at'>): TEntity
}
```

### Consumer count (OE-6 lens)

The 12 A stores (per `03-class-boundaries.md` Class candidate inventory)
are the candidate concrete consumers. Of these:

| Store | Has shared-method footprint? |
|---|---|
| `MemoryStore` | No — 26 functions, embedding pipeline, cache |
| `KanbanCards` | Partially — `list`, `get`, `create` are SQL-custom |
| `MessageBus` | No — 17 functions with status-guarded transitions |
| `Scheduler` | Partially — `list`, `get`, `create`, `delete`, `pause`, `resume` |
| `BackgroundTaskPool` | No — `createAtomic` has transactional guard |
| `ApprovalStore` | Partially — `list`, `get`, `create`, `resolve` |
| `SpanStore` | No — `upsert` uses `ON CONFLICT DO UPDATE` (L3251) |
| `IdeaStore` | Partially — `list`, `get`, `create`, `update`, `delete` |
| `SshVault` | Partially — `list`, `get`, `create`, `delete` |
| `ChannelPairingStore` | Partially — `upsert`, `list`, `update` |
| `MaintenanceOps` | No — cross-entity orchestrator |

**5 of 10 stores have a partially-shared footprint; 5 have divergent
shapes that would require ~80% overrides.** Even the 5 partially-shared
stores diverge significantly in:
- `KanbanCard.seq?` derived via `rowid AS seq` (per `02 §2`)
- `Memory.embedding` JSON encoding (per `02 §2`)
- `OtelSpan` `ON CONFLICT DO UPDATE` semantics (per `02 §2`)
- `AgentMessage` status-guarded transitions (per `02 §2`)
- `BackgroundTask` concurrent-cap invariant (per `02 §2`)

### OE-6 verdict

**Reject.** Following the precedent in:
- `f-agent-subsystem/02-type-interface-analysis.md §LazyCache` —
  rejects 5 lazy-cache generics on OE-6 grounds (12 consumers but
  divergent invalidation-shape patterns).
- `e-process-lock/04-generic-interfaces.md:121-130` — rejects
  `LockResult<T>` on the same OE-6 test.
- `d-channel-provider/04-generic-interfaces.md:127-144` — rejects
  `ChannelEnv<TEnv>`.

A `BaseStore<TEntity>` would force the divergent bits into the base
class (bloated base) or push them back into overrides (~50-70% of
the public API per store becomes overrides). The cost > benefit.

### Alternative: `parseRow<T>` helper per store

Instead of `BaseStore<TEntity>`, each store owns a **private** row
adapter:

```ts
class KanbanCards {
  private parseRow(row: unknown): KanbanCard {
    return row as KanbanCard   // the boundary cast lives here
  }
}
```

This contains the 104 boundary `as` casts (per `02 §3`) inside the
entity store where they belong, without imposing a generic shape on
the class surface.

---

## 2. `EmbeddingClient` — ACCEPTED

### Source and rationale

- **Source:** `src/db.ts:2429-2504` (`generateEmbedding`, `hybridSearch`,
  `backfillEmbeddings`) + `src/db.ts:5` (`OLLAMA_URL` config import) +
  the inner HTTP fetch at `db.ts:2437-2469`.
- **Precedent:** `review-completeness.md OE-10` argues that
  `MemoryStore` should NOT take `embeddingModel` in its constructor
  because the embedding pipeline is a separate concern.

### Sketch

```ts
// src/db/embedding-client.ts [ASSUMPTION: new file]
class EmbeddingClient {
  constructor(
    private readonly opts: { url: string; log: LoggerLike },
  )

  generate(text: string): Promise<number[] | null>
  cosineSimilarity(a: number[], b: number[]): number
}
```

### Consumer count

- **Direct:** `MemoryStore` only (via constructor injection).
- **Indirect:** 8+ entities indirectly through `Memory` (recall search,
  hybrid search, vector search) — but those consumers go through
  `MemoryStore`, not `EmbeddingClient` directly.

### OE-6 verdict

**Accept as a non-generic class** (no `<T>` parameter on `EmbeddingClient`).
The separation is justified by:

1. The 3 embedding functions (`generateEmbedding`, `hybridSearch`,
   `backfillEmbeddings`) close over `OLLAMA_URL` (L5) which is a
   config-bound dependency. Putting this on `MemoryStore`'s
   constructor couples memory storage to the HTTP client.

2. The error path at `db.ts:2443-2444` (embedding failure) is
   distinct from the SQL error paths — a separate class lets the
   caller route the embedding failure to its own logger without
   polluting the SQL logs.

3. If the embedding model changes (e.g., Ollama → local embed),
   only `EmbeddingClient` is reconstructed; `MemoryStore` is
   unaffected.

### Generic params

**None.** The output type is `Promise<number[] | null>` (concrete);
the input is `string` (concrete). No parameterisation is load-bearing.

### Where it lives

`src/db/embedding-client.ts` [ASSUMPTION: filename]. The placement
under `src/db/` keeps it co-located with `DbClient` (A.1) and the
entity stores. If `src/db/` is not yet a directory (per `01 §10`,
the file inventory shows `src/db.ts` + `src/db/sqlite.ts` only),
the directory is created as part of A.5.

### Dependencies

- `LoggerLike` (H.1) for the failure warning at `db.ts:2443`.
- `fetch` (global, available in Node 18+) for the Ollama HTTP call.

---

## 3. `TtlCache<K, V>` — ACCEPTED (supersedes `RemoteStatusCache<T>`)

### Source and rationale

- **Source:** `src/db.ts:1238-1274` (`memoryCache` Map + 3 helpers +
  `MemoryCacheEntry` interface at L1240 + `MEMORY_CACHE_TTL_MS` const).
- **Precedent class:** `src/web/remote-status-cache.ts:19`
  `RemoteStatusCache<T>` with API `getOrRefresh(key, nowMs, fetch,
  fallback?)`.
- **Precedent finding:** `review-completeness.md CE-9` (and `02 §5`)
  flag that `RemoteStatusCache<T>` may supersede `memoryCache` after
  adding an `invalidatePrefix` method.

### Comparison

| Capability | `MemoryCacheEntry` (today) | `RemoteStatusCache<T>` |
|---|---|---|
| TTL expiry | Yes (60 s, single TTL) | Yes (per-construction `ttlMs`) |
| `get` / `getOrRefresh` | `get` only (lazy expiry) | `getOrRefresh` (eager refresh on miss) |
| **Prefix-based invalidation** | Yes (L1260 — iterates keys starting with `${agentId}:`) | **No.** Only single-key `invalidate(key)`. |
| **Bulk invalidation on shared-category write** | Yes (`clearMemoryCache()` at L1292, L1374 — invalidates ALL entries when a `'shared'`-category memory is written) | **No.** Generic `invalidate(key)` only. |
| Empty-cache observability | `getMemoryCacheSize()` exported for tests | No size getter |
| `fetch + fallback` for stale-on-error | No (no `fetch` API; miss returns `null`) | Yes (`fallback?: T`) |

### Recommendation (per `02 §5` final recommendation)

Create a minimal `TtlCache<K, V>` utility in `src/util/ttl-cache.ts`
that:
1. Reuses the `RemoteStatusCache<T>` shape (`getOrRefresh`, `invalidate`)
   but adds the **two missing methods** (`invalidatePrefix`,
   `clearAll`).
2. Lives in `src/util/` (neutral location, NOT `src/web/`) so both
   `MemoryStore` and `web/agents.ts` can import from a sibling
   utility without `db.ts → web/` backward dependency.
3. Is **lazy**, not eager-refresh: `MemoryCacheEntry`'s lazy design
   has zero indirection on miss; preserving that is recommended.

### Sketch

```ts
// src/util/ttl-cache.ts [ASSUMPTION: new file]
export class TtlCache<K extends string, V> {
  constructor(private readonly opts: {
    ttlMs: number
    clock?: () => number   // injectable for tests; defaults to Date.now
  })

  getOrRefresh(key: K, nowMs: number, fetch: () => V): V
  invalidate(key: K): void
  invalidatePrefix(prefix: K): number   // returns count of evicted entries
  clearAll(): void
  size(): number
}
```

### Consumer count

After the consolidation:
- `MemoryStore` (A.5) — the primary consumer; uses `getOrRefresh`,
  `invalidate`, `invalidatePrefix`, `clearAll`.
- `web/routes/agents.ts:204-205` — already instantiates
  `RemoteStatusCache<T>` twice today (per `02 §5`); after the
  consolidation, those instances become `TtlCache<T>` instances.

**2 consumers with a true shared shape** (lazy TTL + prefix
invalidation + clearAll) — meets the OE-6 threshold.

### OE-6 verdict

**Accept.** The shared shape is genuine:
- Lazy expiry semantics (both consumers want `getOrRefresh` lazy).
- Prefix-based invalidation (`MemoryStore` via `agentId:`; `web/agents.ts`
  via `peerId:` — same pattern, different prefix).
- Bulk-clear (`MemoryStore` on `'shared'`-category writes;
  `web/agents.ts` on session reset — same pattern).

The two consumers together justify the abstraction; a single-consumer
`TtlCache` would be rejected on OE-6 grounds (per `02 §6.2 MemoryCache`
analysis), but the dual-consumer reality makes it load-bearing.

### Generic params

Two, matching the `RemoteStatusCache<T>` precedent:
- `K extends string` — load-bearing; lets `new TtlCache<'agentId:limit:category', Memory[]>`
  be typed narrower than `TtlCache<string, Memory[]>`.
- `V` — the cache value type; concrete (no constraint).

### Where it lives

`src/util/ttl-cache.ts` [ASSUMPTION: filename not yet decided;
alternatives: `src/util/cache.ts`, `src/cache/ttl.ts`].

The placement in `src/util/` is the **direction-of-dependency fix**
flagged in `02 §5`: `db.ts → web/` is backward (db.ts is depended on
by `web/`, not the other way around). Moving the utility to `src/util/`
breaks the cycle.

### Dependencies

- None beyond `Date.now` (or an injected `clock` for tests).

### Migration steps

1. Create `src/util/ttl-cache.ts` with the `TtlCache<K, V>` class
   (extending `RemoteStatusCache<T>`'s `getOrRefresh` / `invalidate`
   with `invalidatePrefix` / `clearAll` / `size`).
2. `MemoryStore` (A.5) constructor takes `cache: TtlCache<string, Memory[]>`.
3. `web/routes/agents.ts:204-205` replaces
   `new RemoteStatusCache<T>(...)` with `new TtlCache<T, T>(...)`.
4. After both consumers migrate, `RemoteStatusCache<T>` at
   `src/web/remote-status-cache.ts:19` is **removed** (or kept as a
   deprecated thin wrapper that delegates to `TtlCache`).

---

## 4. Other generics — REJECTED

### 4.1 `MemoryCache<M extends Memory>` (per `02 §6.2`)

**Rejected.** A `MemoryCache<M>` typed as `M extends Memory` provides
no extra type safety over `TtlCache<string, Memory[]>` — the value is
always `Memory[]` in this codebase. The 1 consumer (memory only) is
folded into the shared `TtlCache<K, V>` utility above.

### 4.2 `LoggerLike` injected per-store

**Accepted (cross-cutting, not A-specific).** Per `02 §8`, only
`MemoryStore` and `AgentMessageStore` need a `log: LoggerLike`
constructor parameter among the A stores. The other 10 stores can
omit it. The `LoggerLike` shape itself is owned by H (per
`h-cross-cutting/03-class-boundaries.md §C1`), not A.

### 4.3 `ListOptions<TFilter>` for paginated queries

**Rejected.** Per `02 §6.3`, the 4 stores with `list-with-opts` shapes
(`KanbanCard`, `Memory`, `Approval`, `IdeaBox`) have divergent `opts`
shapes:
- `KanbanCard`: `{ project?: string; limit?: number; offset?: number }`
- `Memory`: `{ limit?: number; category?: string }`
- `Approval`: `{ status?: Approval['status']; agentId?: string; limit?: number; offset?: number }`
- `IdeaBox`: `{ status?: string; category?: string }`

The shared methods (`limit`, `offset`) are too thin to justify a
generic. Each store's `list(opts)` keeps its own shape.

### 4.4 `StatusUnion<T extends string>` sealed-class helper

**MAYBE — applied per-store.** Per `02 §7`, the 6 stores with status
unions worth sealing are:
- `AgentMessage` (4 states, transitions via 4 mutation functions)
- `BackgroundTask` (4 states, strict `running → terminal` invariant)
- `Approval` (4 states, status-guarded resolve)
- `OtelSpan` (4 states, severity precedence in SQL CASE)
- `KanbanCard` (5 states, no-skip transitions)
- `MemoryCategory` (string-widened; should be sealed to make `'shared'`
  a documented value)

Each is sealed as a **non-generic** class specific to the store (e.g.,
`AgentMessageStatus`), not as a `StatusUnion<T>` generic. The OE-6
precedent (per `02 §6.3`) says: seal only when there's a clear
compile-time benefit (e.g., the `severity()` getter on `OtelSpanStatus`
replacing the SQL CASE at L3296-3301).

### 4.5 `RowMapper<T>` (per `02 §6.1` footnote)

**Rejected.** A row mapper `RowMapper<T> = (row: unknown) => T` would
have 12 consumers (the 12 stores) but the shared surface is one
method — `(row: unknown) => T`. The cost > benefit; each store keeps
its own `parseRow<T>` private method.

---

## 5. Generics inherited from G

The cross-cutting generics catalogue (`h-cross-cutting/04-generic-interfaces.md`)
defines:
- `LoggerLike` (H.1) — used by `MemoryStore` (A.5) only.
- `LazyBin<TName, TResolved>` (H.3) — not used by A.
- `RemoteStatusCache<T>` (existing) — superseded by `TtlCache<K, V>`
  (per §3 above).

A does NOT introduce new cross-cutting generics; A consumes
`LoggerLike` and produces `TtlCache<K, V>` (which becomes a
shared utility, not A-specific).

---

## 6. [ASSUMPTION] markers

- [ASSUMPTION: filename `src/db/embedding-client.ts` for `EmbeddingClient` —
  not yet decided; alternatives: `src/db/embedding.ts`,
  `src/db/embedding-client/index.ts`].
- [ASSUMPTION: filename `src/util/ttl-cache.ts` for `TtlCache<K, V>` —
  not yet decided; alternatives: `src/util/cache.ts`,
  `src/cache/ttl.ts`].
- [ASSUMPTION: `EmbeddingClient` is a non-generic class — `Promise<number[] | null>`
  return is concrete, no `<T>` parameter needed].
- [ASSUMPTION: `TtlCache` is lazy, not eager-refresh — preserves the
  current `memoryCache` semantics; the eager `getOrRefresh` variant
  from `RemoteStatusCache<T>` is dropped in favor of the lazy shape].

---

**End of A generic-interfaces plan. No source files modified.**
