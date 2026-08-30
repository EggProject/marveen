# Plan Review — A (db) over-engineering & completeness

Review scope: all seven A plan documents
(`docs/refactor-to-classbase/a-db/00-summary.md` through
`06-risks-and-mitigations.md`). Source ground-truth verified against
`src/db.ts`, `src/memory.ts`, `src/costops/`, `src/web/remote-status-cache.ts`,
`src/store-watcher.ts`, `src/web/federation/bridge.ts`, and the
importer/mock landscape on 2026-08-30 (branch `test/baseline`,
HEAD `f58fe4c`).

The framework's `review-completeness.md` (OE-1 to OE-11, CE-1 to CE-17),
the H review (HOE-1 to HOE-7, HCE-1 to HCE-11), the E review
(EOE-1 to EOE-5, ECE-1 to ECE-8), the D review (OE-D1 to OE-D5,
CE-D1 to CE-D10), and the F review (OE-F1 to OE-F5, CE-F1 to CE-F12)
are the lenses. A's own claims (12+1 classes, 39 importers, 50 mocks,
158 functions, 37 interfaces+types, 104 `as` casts, zero `throw`,
zero unsafe casts, three doc-claimed file:line refs) are all
ground-truthed against the working tree before scoring.

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 4 | 4 |
| Completeness | 2 | 7 | 5 |

**Net assessment: ACCEPT-WITH-EDITS.** A's keystone thesis is the
most load-bearing single decision in the classbase plan (the
3308-LOC `db.ts` is the largest subsystem by single-file footprint
and the second-largest by blast radius), and the plan executes the
right pattern: keystone-first (`DbClient` at A.1), leaf-stores
(`Scheduler`/`ApprovalStore`/`IdeaStore`/`ChannelPairingStore` at
A.2), mid-stores at A.3, majors at A.4, `MemoryStore` at A.5
(because it owns the cross-entity decay sweep, the embedding
pipeline, and the cache), cross-entity at A.6, singleton-removal at
A.7, error/cache/logger follow-ups at A.8–A.10. The free-function
pass-through migration window mirrors B.1/E.1/F.1. The CE-9
`RemoteStatusCache<T>` reuse is correctly framed as adding two
methods (`invalidatePrefix`, `clearAll`) to the existing class and
moving the shared utility to `src/util/` to fix the direction-of-
dependency. The OE-10 `EmbeddingClient` separation is correctly
argued and the `MaintenanceOps` decision (separate class, not on
`MemoryStore`) is the right call. The 104-cast analysis is honest
(zero unsafe, all boundary casts). The error-class taxonomy
decision (preserve silent-return for 11 stores, introduce
`MemoryStoreError` only) is well-justified.

But the plan has one completeness critical miss (`src/costops/` is
a parallel SQLite module that bypasses `db.ts` entirely and uses
its own `Database` handle from `bun:sqlite` directly), one
measurement inflation (the 41 type-exports figure is 37, not 41),
one importer-count off-by-one (40, not 39), and one critical
false-positive (the framework review claims `remote-enroll-*`
modules depend on db.ts — they don't). The `MaintenanceOps`
decision is justified but the dependency order of CE-8 (the
`HeartbeatScheduler → MemoryStore.decay → db` single-direction
chain) deserves more depth given that `HeartbeatScheduler`'s
`executeHeartbeat` reads the runtime db handle indirectly via
`MemoryStore`. The plan also under-specifies the
`createTestDb(overrides?)` factory (CE-5 / HCE-7 inheritance) and
under-documents bun-specific `bun:sqlite` semantics for the
re-init guard (CE-17 inheritance). Several `MemoryStore` method
signatures in §A2 carry literal `LoggerLike` parameters that
conflict with the §A.10 plan ("only `MemoryStore` needs a logger"
— but `MessageBus` per §03 §A4 has zero log sites, so the
inconsistency is documentary, not class-shape).

---

## Over-engineering findings

### AOE-1 (major) — `MaintenanceOps` as a separate class is a 4-store
singleton wrapper with no internal state

**Proposal** (`03-class-boundaries.md` §A11, `05-refactor-roadmap.md` §A.6,
`06-risks-and-mitigations.md` AR8):
```ts
class MaintenanceOps {
  constructor(
    private readonly memory: MemoryStore,
    private readonly auditLog: AuditLog,
    private readonly tokenUsage: TokenUsagePruner,
    private readonly backgroundTasks: BackgroundTaskPool,
    private readonly approvals: ApprovalStore,
    private readonly toolLog: ToolLog,
  )

  runDecaySweep(): { tokensPruned: number }
  markOrphanedTasksFailed(): number      // delegates
  expireTimedOutApprovals(): number      // delegates
  pruneToolCallLog(olderThanSecs?): void // delegates
}
```

**Counter-argument.** The plan correctly notes that `runDecaySweep`
touches three stores and `MemoryStore` alone cannot orchestrate.
But the proposal gives `MaintenanceOps` 6 constructor dependencies
(`memory, auditLog, tokenUsage, backgroundTasks, approvals,
toolLog`), of which only `runDecaySweep` actually performs
cross-entity orchestration. The other three methods
(`markOrphanedTasksFailed`, `expireTimedOutApprovals`,
`pruneToolCallLog`) are **pure delegation** — they call exactly
one of the 6 injected stores and return its result. A pure-delegation
wrapper that takes 6 constructor args to forward 1:1 to 3 of them
is the textbook OE-6 single-purpose namespace. The plan's AR8
mitigation says: *"The other sweeps ... are independent of memory
hygiene; they are pure per-table maintenance."* — if they are
independent of memory hygiene, they have no business in a class
called `MaintenanceOps` that is justified by the cross-entity decay
sweep. The justification for *all four methods* is "the
construction order must be explicit at App boot" — which is the
same construction-order pattern the rest of the plan already
relies on for the keystone `DbClient.open()` and the per-store
factories. A separate construction-order table (per CE-8) does
the same job without a 6-dep class.

The plan's CE-8 mitigation is also weaker than it looks: the
"single-direction chain
`HeartbeatScheduler → MaintenanceOps → {stores} → db`" depends on
`MaintenanceOps` having zero callers besides `HeartbeatScheduler`
and `App.maintenanceInterval` (the `setInterval` at
`index.ts:15`/`:451`). If the planned construction order holds,
`MaintenanceOps` is constructed once per process and called once
per 24h. The 6-arg constructor is used once.

A senior engineer would say: keep `MemoryStore.decay()` as the
3-store orchestrator (the `memory.decay + auditLog.prune +
tokenUsage.prune` triplet) and either (a) put the 3 pure-delegation
methods on each store's owner (`BackgroundTaskPool.markOrphaned`,
`ApprovalStore.expireTimedOut`, `ToolLog.prune`), or (b) keep them
as free functions until a second caller emerges. The free function
path preserves the `memory.ts:155` aggregator location with zero
new class surface. The current plan pays for a class that has
1 effective method (the decay sweep) and 3 delegating methods, all
of which are existing free functions that already work.

**Severity: wasteful.** Reduce `MaintenanceOps` to a
**3-store orchestrator** (`memory, auditLog, tokenUsage` only) and
keep the other three sweep targets as free functions (or per-store
methods). The class's name should change too — `DecaySweep` is the
only true cross-entity operation in the file; everything else is
per-table.

---

### AOE-2 (major) — `EmbeddingClient` as a separate class is justified
(per OE-10) but the `cosineSimilarity` move is a method theft

**Proposal** (`03-class-boundaries.md` §A2 "A5.1 EmbeddingClient",
`04-generic-interfaces.md` §2):
```ts
class EmbeddingClient {
  constructor(opts: { url: string; log: LoggerLike })
  generate(text: string): Promise<number[] | null>
  cosineSimilarity(a: number[], b: number[]): number
}
```

**Counter-argument.** The OE-10 separation (`generateEmbedding` is a
distinct HTTP-client concern, not a MemoryStore concern) is correct
— `MemoryStore` should not take `embeddingModel?: string`. But the
plan moves `cosineSimilarity` (a pure vector-math helper at
`db.ts:2448`) into `EmbeddingClient`. `cosineSimilarity` has
**zero coupling** to the Ollama HTTP client. It takes two
`number[]`s and returns a number. Putting it on `EmbeddingClient`
mixes two responsibilities (HTTP fetch + vector math) and
mis-narrows the class name: "Embedding" sounds like the HTTP
transport, but the class also does in-memory vector math used by
`hybridSearch` and `vectorSearch` (which today live in db.ts at
L2458-2504).

Per E's OE-D1 analog (`ChannelEnv.home` parameter) — a parameter
that doesn't have a load-bearing consumer — the same logic applies
to `cosineSimilarity`: a pure-function helper should not be coupled
to a transport class. The right shape is either (a) keep
`cosineSimilarity` as a free function (today's location) or (b)
extract a `VectorMath` utility class that takes both `EmbeddingClient`
and `vectorSearch`/`hybridSearch` callers.

The plan's argument is "the embedding pipeline is a separate concern
... if the model changes (e.g., Ollama → local embed), only
`EmbeddingClient` is reconstructed." That argument applies to
`generate(text)` — the HTTP transport. It does not apply to
`cosineSimilarity`, which doesn't care which model produced the
vector.

**Severity: wasteful.** Move `cosineSimilarity` back to a free
function (or to a `VectorMath` helper). Keep `EmbeddingClient` to
the HTTP-transport surface (`generate(text)` only). The class
becomes single-purpose and the name matches the responsibility.

---

### AOE-3 (major) — Sealing 6 status unions is ceremony for 4 of them
(the parallel to framework OE-1 / OE-3)

**Proposal** (`02-type-interface-analysis.md` §7):
> | Seal | Justification |
> |---|---|
> | `AgentMessageStatus` (sealed) | Two dual APIs collapse into one method. |
> | `BackgroundTaskStatus` (sealed abstract) | `running → {done,failed,timeout}` enforced at type level. |
> | `ApprovalStatus` (sealed) | `pending → {approved, rejected, timeout}` + status-guarded resolve. |
> | `OtelSpanStatus` (sealed) | Replaces SQL CASE at L3296-3301 with a `.severity()` getter. |
> | `KanbanStatus` (sealed) | Replace hard-coded string in `STATUS_HU` with a `.label_hu()` getter. |
> | `MemoryCategory` (sealed) | Forces `'shared'` to be a documented value. |

**Counter-argument.** The framework `review-completeness.md` OE-1
rejected `ModelAction` sealed hierarchy in D with: *"the union is
already exhaustively checkable via `switch (action.kind)`. The
sealed-class version ... costs an allocation and a vtable pointer
per tick."* The same logic applies to **4 of the 6 seals**:

1. **`BackgroundTaskStatus`**: 4 states, but the only transition is
   `running → {done, failed, timeout}` enforced by
   `finishBackgroundTask` (which already accepts only the terminal 3
   via the type literal `status: 'done' | 'failed' | 'timeout'`).
   A `switch (status)` in the route handler is already
   exhaustively-typed; a sealed class is allocation-per-finish
   (every background task completion allocates a class instance).

2. **`ApprovalStatus`**: 4 states, the transition rules already live
   in `resolveApproval` (status-guarded via SQL `WHERE ... AND status
   = 'pending'`). A sealed class adds a `transitionTo(target)` method
   that mirrors the SQL — duplicating the guard at two layers.

3. **`OtelSpanStatus`**: 4 states, severity precedence is hard-coded
   in SQL CASE at L3296-3301. A sealed class with `.severity()` getter
   is the textbook framework OE-3 lesson: the proposal **adds a
   `deadlineMs` field** that doesn't exist on `OtelSpan` today (the
   DB schema has `attributes: string | null` JSON-encoded; no
   per-status deadline column). Either the field is dropped (and the
   seal becomes pure ceremony) or the field is kept and the schema
   changes as part of A.6 — a hidden A.6 surface expansion the plan
   does not enumerate.

4. **`KanbanStatus`**: 5 states, the `STATUS_HU` mapping at
   `memory.ts:106` is a Hungarian-language label map for the dashboard.
   A `.label_hu()` getter on a sealed class adds an allocation per
   `KanbanCard` rendering; the existing object literal is one line.

The two seals with **real** payoff are `AgentMessageStatus` (the
"dual-API" pattern in `markDelivered` vs `markFailed` is a real
shape-duplication, fixable at the type level) and `MemoryCategory`
(the `'shared'` magic-string in `db.ts:1292`/`L1371` is a real
hazard — a sealed class documents the value-space).

**Severity: wasteful.** Drop `BackgroundTaskStatus`,
`ApprovalStatus`, `OtelSpanStatus`, `KanbanStatus` from the seal
list. Keep `AgentMessageStatus` and `MemoryCategory`. Apply the
framework OE-1/OE-3 lesson — *"sealed classes only for entities
that own behavior"* — to the 4 dropped cases. The
`status`-as-string-literal-union stays.

---

### AOE-4 (major) — A.8 "Error class taxonomy" phase is policy,
not a phase (parallel to HOE-3, BOE-3)

**Proposal** (`05-refactor-roadmap.md` §A.8):
> A.8a: introduce `MemoryStoreError`
> A.8b: migrate `searchMemories` silent return → throw
> A.8c (deferred): if user opts in, follow §02 §9 Option (b) table

**Counter-argument.** The plan correctly identifies A.8 as a
"policy" decision ("the recommendation is to **preserve
silent-return for 11 stores**") and presents A.8a–A.8c as three
sub-phases. But A.8b is a single throw site (the FTS5 parse failure
at L1182-1184) — one function body change. A.8c is explicitly
deferred. So A.8 has:
- A.8a: ~30 lines (new class definition + tests)
- A.8b: one function body change (a `try { ... } catch { return [] }`
  becomes `try { ... } catch (e) { throw new MemoryStoreError(query, e) }`)
- A.8c: zero work today

This is a single commit's worth of work stretched across three
sub-phases with per-phase risk rows, rollback strategies, and
parallelism claims. The framework `review-completeness.md` CE-13
explicitly warned: *"HMR safety subsection, construction order
subsection — those are subsections, not phases."* The same
applies here: A.8 is a subsection of A.5 (the `MemoryStore`
extraction), not a separate phase. A.8a's `MemoryStoreError` is a
natural addition to the `MemoryStore.search()` method definition;
A.8b is the throw site change; A.8c is a future-phase note (one
paragraph in §06).

**Severity: wasteful.** Fold A.8 into A.5 as a sub-phase. A.8a
becomes "MemoryStore constructor methods + `MemoryStoreError` class
+ 1 throw site"; A.8b's `[ASSUMPTION]` for `cosineSimilarity`
already says "logs at debug, treats as zero-score" — so A.8b is
literally 3 lines of code change inside A.5c. Move the A.8c
deferral into `06-risks-and-mitigations.md` AR7 as a future-only
paragraph.

---

### AOE-5 (minor) — A.10 "LoggerLike adoption" phase is policy

**Proposal** (`05-refactor-roadmap.md` §A.10):
> "Per `02 §8`, only `MemoryStore` (A.5) and `AgentMessageStore`
> (rejected — `MessageBus` does not need a logger per `02 §8`)
> qualify."

**Counter-argument.** The plan's own claim: "MemoryStore (A.5) only"
qualifies. So A.10 is one constructor-parameter addition to one
class (already covered by A.5's design). Putting it in its own
phase with its own risk row, parallelism claim, and rollback
strategy is the same phase inflation as A.8. The plan says
"A.10 depends only on H.1; can land in parallel with A.5/A.6 once
H.1 is in place" — so A.10 is logically a subset of A.5's
constructor signature work.

**Severity: wasteful.** Fold A.10 into A.5 as a sub-phase. The
constructor signature `(db, cache, embedding, log)` is a single
decision that doesn't need its own phase row.

---

### AOE-6 (minor) — `[ASSUMPTION]` filenames add 4 open decisions to the
plan that should be resolved at plan-write time

**Proposal** (`00-summary.md`, `03-class-boundaries.md`,
`04-generic-interfaces.md`):
- `src/util/ttl-cache.ts` (for `TtlCache<K, V>`)
- `src/db/embedding-client.ts` (for `EmbeddingClient`)
- `src/db/embedding.ts` (alternative)
- `src/db/embedding-client/index.ts` (alternative)
- `src/util/cache.ts` (alternative for TtlCache)
- `src/cache/ttl.ts` (alternative for TtlCache)

**Counter-argument.** `[ASSUMPTION: filename not yet decided]`
appears 6 times in the plan. The CLAUDE.md §1 ("Think Before
Coding") principle: *"State your assumptions explicitly. If
uncertain, ask."* — the plan does neither for the filenames; it
defers them as `[ASSUMPTION]` markers. The `src/db/` directory
already exists with `src/db/sqlite.ts` (per `find src/db`), so
the `db/` directory is created either way. The `src/util/`
directory may not exist (verify with `ls src/util/`).

The plan's framing ("if `src/db/` is not yet a directory ...
the directory is created as part of A.5") implies the filename is
incidental. But filenames are load-bearing: `src/db/embedding-client.ts`
becomes a new top-level importer that 5 other refactor docs
(memory.ts migration in A.6, README, ESLint config) must enumerate.
Picking the wrong name now forces a rename commit later. The
framework's review-completeness.md didn't flag this because the
other subsystems (B/H/E/D/F) had few or zero new files; A has
several new files, all `[ASSUMPTION]`.

**Severity: wasteful.** Resolve all 6 filename `[ASSUMPTION]` markers
before A.1 lands. The two reasonable picks are
`src/db/embedding-client.ts` (co-located with `src/db/sqlite.ts`)
and `src/util/ttl-cache.ts` (neutral location, fixes CE-9 direction-
of-dependency). Document the choice in `00-summary.md`.

---

### AOE-7 (minor) — A.2 "leaf stores" includes `MemoryCategory`
sealed-class helper as a sub-phase (5b) but its sibling sealed-class
work is in A.8

**Proposal** (`05-refactor-roadmap.md` §A.2e):
> "**A.2e:** `MemoryStore`'s `MemoryCategory` sealed class (per
> A.8 §7 — only the type, no method body change)."

**Counter-argument.** §A.2e introduces a sealed class (per the
§02 §7 recommendation). But §02 §7 also recommends sealing
`AgentMessageStatus`, `BackgroundTaskStatus`, `ApprovalStatus`,
`OtelSpanStatus`, `KanbanStatus` — and only `MemoryCategory` is
scheduled in A.2e. The other 5 (per AOE-3, 4 of them are
over-engineering, but `AgentMessageStatus` is justified) are not
explicitly scheduled anywhere. The plan implicitly defers them
to "if user opts in" (per A.8c). But `AgentMessageStatus` is the
**highest-payoff seal** (per §02 §7 "Highest payoff") — its
omission from the explicit roadmap is a gap.

**Severity: wasteful.** Add `AgentMessageStatus` sealed class as
A.4c sub-phase (alongside `MessageBus` A.4a). The dual-API pattern
at `markDelivered`/`markFailed` is the textbook sealed-class
win.

---

### AOE-8 (minor) — Per-store blast-radius table (CE-11) is
maintenance overhead without parallelization gain

**Proposal** (`03-class-boundaries.md` "Per-store blast-radius table"):
13 rows × 4 columns listing importer counts and test files per store.

**Counter-argument.** The CE-11 framework lesson asks for per-store
blast-radius so Phase 6 (entity stores) can be parallelized safely.
But A.5 (`MemoryStore`) and A.6 (`MaintenanceOps`) are explicitly
**non-parallelizable** (A.5 blocks A.6, which blocks A.7). A.4
(`KanbanCards` + `MessageBus`) is non-parallelizable internally
(per A.4b depends on A.4a for the cross-store hook). A.3 sub-phases
are parallelizable (per the plan) but only touch 3 stores with
6-9 functions each — the per-file blast radius adds no
information that "these are 3 disjoint function ranges in `db.ts`"
doesn't already convey. A.2 sub-phases (5 leaf stores) are
parallelizable but each store has ≤10 importers — the table
duplicates info that `grep -rl "storeName" src/ | wc -l` produces
in 1 second.

The table's value is **mechanical** ("X files import this symbol,
which means A.x has X reviewers needed") but the plan never
**uses** the table to drive a decision. The 50-mock rewrite at
A.7 dwarfs any per-store parallelism choice. The table is
documentation, not a tool.

**Severity: wasteful** if no decision is tied to it; **neutral**
if used as a "per-phase reviewer assignments" input. Add a one-line
note: "Per-row reviewer count is mechanical; per-row parallelism
claim drives A.2/A.3 sub-phase ordering only."

---

## Completeness findings

### ACE-1 (critical) — `src/costops/` parallel SQLite module is
completely missed

**Missing area.** `src/costops/` exists with 3 files: `config.ts`
(7.6 KB), `ledger.ts` (11.9 KB), and `README.md`. Per the verified
ground truth:

```ts
// src/costops/ledger.ts:9
import type { Database } from 'bun:sqlite'
```

`costops/ledger.ts` imports the `Database` type **directly** from
`bun:sqlite`, NOT from `db.ts`. It then uses `db.prepare(...)` to
create tables (`cost_sources`, `cost_lines`, ...), transactions
(`db.transaction(...)` at L104), and queries (L209, L243). It has
its own **schema migrations** independent of `db.ts`'s
`initDatabase()`.

The A plan's inventory (`02 §1.4` and `03 §Per-store blast-radius`)
enumerates 18 entity clusters inside `db.ts` but says nothing
about `costops/`. The plan's `01 §1.4` row "SettingsStore" /
"ChannelProviderRegistry" rejection (per §A12, §A13) is the only
"explicitly out of scope" callout — `costops/` is not even on the
radar.

**Why it matters.** At runtime, both `db.ts` and `costops/ledger.ts`
open `bun:sqlite` handles against the same DB file. The plan's
`DbClient` constructor ("one instance per process, opens the
underlying Database handle") does not address what happens when
`costops/ledger.ts` is concurrently reading the same WAL file via
its own `Database` handle. Per `01 §5.4`: *"Two processes opening
the same WAL file simultaneously is safe for reads but
serialized for writes via SQLite's built-in locking. There is no
application-level coordination."* — but two **modules in the
same process** opening the same WAL file have the same write-
serialization cost PLUS a real correctness risk: if `costops/`
opens with `{ strict: true }` (matching `db.ts:69`) and the file
is held open by the other module, the second `new Database(...)`
may fail or block.

The plan must either (a) extend A.1's `DbClient` to be the
**only** Database handle in the process (costops migrates to use
`dbClient.getHandle()`), or (b) explicitly document `costops/`
as out-of-scope with rationale ("costops is a parallel subsystem
with its own schema; future web-/agent-cost migration would
absorb it"). The current plan is silent.

**Severity: critical.** Add a `costops/` inventory entry to
`00-summary.md` "Files this plan does NOT touch" (option b)
**OR** extend A.1's `DbClient.getHandle()` escape hatch with a
"`costops` will use this handle" note (option a). Per the
framework CE-1 lesson ("claim only 2 classes exist; ground truth
has 9"), `costops/` is the kind of parallel-SQLite surface the
inventory would miss by reading only `db.ts`.

---

### ACE-2 (critical) — Importer count is 40, not 39 (off-by-one with
materially different `command-task.ts` consumer)

**Missing area.** The plan cites "39 production importers" in
`00-summary.md` ("14 narrow importers, 39 broad importers
including `web/routes/*` and `scripts/`"). Verified ground truth
(`grep -rln "from ['\"].*db\.js['\"]" src/ scripts/ --include='*.ts'
| grep -v __tests__ | sort | uniq`):

**40 files**, not 39. The plan missed one importer.

Looking at the actual list, the missing file is likely
`src/web/command-task.ts` (the 10th `web/` top-level importer,
not enumerated in the plan's "10 web/" claim in `01 §3` —
the plan's own table has `auth-device-keys, auth-sessions,
channel-request-watcher, context-guard-runner, fleet-transfer,
inbox-nudge-watcher, message-router, schedule-runner,
security-reset, token-usage` = 10 web files, but the actual
count is **11** with `command-task.ts` added).

The plan also says "14 narrow importers" (per framework M6) but
the actual narrow count (top-level + web/, excluding `web/routes/`
and `scripts/`) is **15** (4 top-level + 11 web/ + 0 `federation/`
type-only = 15). The `federation/bridge.ts` is the 16th narrow
importer if type-only counts.

**Why it matters.** A.7's verification gate
(`grep -rln "from ['\"]\\.\\.\\?\\/db\\.js['\"]" src/ --include='*.ts'
| grep -v __tests__` returns 0) is a mechanical command. If the
gate runs with the plan's "39" baseline, it fires when 0 files
match — but if `command-task.ts` is migrated earlier (e.g., as
part of F.1 or D.5), the gate could fire prematurely with 0
non-test files, missing the in-flight migration. Or vice versa:
if `command-task.ts` slips through and the plan doesn't list it,
the gate's verification pass at A.7 lands "all migrated" while
`command-task.ts` is still on the free-function surface.

**Severity: critical.** Re-measure the importer count and the
narrow/broad split before A.1 lands. Update `00-summary.md`,
`01 §3`, and the A.7 verification gate to use the verified
numbers (40 broad, 15 narrow). The discrepancy is documented
in the plan's `01 §10` as "framework M6 says 14; ground truth is
39" — but the ground truth is now 40, not 39.

---

### ACE-3 (major) — Plan claims 41 type exports (36 interfaces + 5
type aliases); actual is 37 (33 interfaces + 4 type aliases)

**Missing area.** The plan's `02 §0 Summary` and `02 §1` say:
> "35 exported `interface` declarations + 6 exported `type`
> aliases = 41 named type exports ... the actual grep count is
> 36 interfaces + 5 type aliases ≈ 41"

Verified ground truth (`grep -nE "^export (interface|type)" src/db.ts`):

| Kind | Count |
|---|---:|
| `export interface` | **33** |
| `export type` | **4** |
| **Total** | **37** |

The plan inflated the count by 4 (claimed 36+5=41; actual 33+4=37).
The inflation has been carried through the plan's various
`01 §2` and `02 §1` tables — every "41 named type exports" cite
is wrong by ~10%.

**Why it matters.** The plan's per-entity-cluster counts and the
"6 are pure data rows" claim in `02 §1` are derived from the
inflated total. If the cluster counts are off, the per-class
public-surface design (which enumerates types per store) inherits
the discrepancy. The 4 missing types are likely:
- `KanbanCard.priority` literal-union (not a separate `type`
  export — embedded in the interface)
- `Approval.status` literal-union (embedded)
- `Memory.category` widened to `string` (no separate type)
- `AgentMessage.status` literal-union (embedded)

These are real types but they live inside interface declarations,
not as separate `export type` lines. The plan's reconciliation
("the prompt counted the visible export lines as of an earlier
read") is plausible — but the plan's working numbers should match
the file, not a stale prompt.

**Severity: major.** Re-measure and update all type-count claims
to **33 interfaces + 4 type aliases = 37**. The 37 figure
matches `02 §0`'s opening line ("the prompt's `37` count merges
the two forms") — so the prompt was right; the plan's
reconciliation section was wrong.

---

### ACE-4 (major) — `MaintenanceOps` decision justifies a separate
class but the dependency graph under-specifies the
HeartbeatScheduler wiring

**Missing area.** The plan's `00 §Dependency` table row
"A → F (agent subsystem)" says:
> "`HeartbeatScheduler` (F.1) calls `MemoryStore.runDecaySweep()`;
> F.1's order is `after framework A1`"

But A.6 (`MaintenanceOps`) introduces a `runDecaySweep()` method
that calls `memory.decay() + auditLog.prune() + tokenUsage.prune()`
— three store methods. The plan's dependency chain per AR3 is:
```
HeartbeatScheduler (F.1) → MaintenanceOps (A.6)
                          → {MemoryStore, AuditLog, TokenUsagePruner}
                          → DbClient → db (raw)
```

But the plan does NOT specify:
1. Does `HeartbeatScheduler` (F.1) call
   `memoryStore.runDecaySweep()` (an instance method on
   `MemoryStore`) OR `maintenanceOps.runDecaySweep()` (an
   instance method on the cross-entity class)?
2. Per `02 §A11`: "`memory.ts:155-160` survives as a thin
   pass-through wrapper that delegates to
   `maintenanceOps.runDecaySweep()`" — so `memory.ts:155`
   still exists post-refactor. Does `HeartbeatScheduler` call
   `memory.ts:155`'s `runDecaySweep()` (the pass-through) or
   `maintenanceOps.runDecaySweep()` directly?

This is the load-bearing wiring of CE-8. The plan's three paths
all produce the same external behavior but different dependency
graphs:
- Path A: `Heartbeat → MemoryStore.runDecaySweep() → MemoryStore.decay() → db`
  (MemoryStore owns all three calls — but the plan says
  MemoryStore cannot orchestrate three stores)
- Path B: `Heartbeat → MaintenanceOps.runDecaySweep() → {MemoryStore.decay, AuditLog.prune, TokenUsagePruner.prune} → db`
  (MaintenanceOps is the orchestrator)
- Path C: `Heartbeat → memory.ts:155 runDecaySweep() → maintenanceOps.runDecaySweep() → {stores} → db`
  (memory.ts:155 is the pass-through, MaintenanceOps is the class)

The plan's `02 §A11` and `05 §A.6c` say C. But F.1's
`HeartbeatScheduler` calls `memoryStore.runDecaySweep()` (Path A
or B depending on whether `MemoryStore` has a `runDecaySweep()`
method). The plan never reconciles Path A/B vs Path C.

**Severity: major.** Pin the wiring path. Pick one: either
`HeartbeatScheduler → maintenanceOps.runDecaySweep()` (direct,
Path B) OR `HeartbeatScheduler → memoryStore.runDecaySweep()`
where `MemoryStore.runDecaySweep()` is a single method that calls
all three stores (Path A — requires `MemoryStore` to take
`auditLog` + `tokenUsage` as constructor args, contradicting
`02 §A2` which lists only `(db, cache, embedding, log)`).

Per the plan's current design, the only consistent path is C
(`HeartbeatScheduler → memory.ts:155 → maintenanceOps`).
`HeartbeatScheduler` (F.1) imports the `runDecaySweep` function
from `memory.ts`, NOT from any store class. Confirm this
explicitly in `00 §Dependency` and `05 §A.6c`.

---

### ACE-5 (major) — `createTestDb(overrides?)` factory sketched but
not specified (CE-5 / HCE-7 / BCE-7 / CE-F7 lesson inheritance)

**Missing area.** The plan's `06-risks-and-mitigations.md` AR11
provides a sketch:
```ts
export function createTestDb(overrides?: Partial<DbClientOptions>): {
  dbClient: DbClient
  memoryStore: MemoryStore
  kanbanCards: KanbanCards
  // ... all 13 stores
  maintenanceOps: MaintenanceOps
}
```

This is the test-factory pattern that every other subsystem
review flagged as missing (HCE-7, BCE-7, CE-D3, CE-F7). The
framework CE-5 explicitly said: *"The first 5-10 tests will
define the convention; everything after copies it."* A is the
**largest** factory in the plan series (13 stores, vs B's 1
class or H's logger), and the convention-setting risk is the
highest.

The sketch specifies:
- 13 fields (the store instances)
- `overrides?: Partial<DbClientOptions>` (a config-shape override)

It does NOT specify (per HCE-7's 5-bullet check):
1. Whether the factory takes options (e.g., `{ inMemory?: boolean,
   seedMemory?: (db: DbClient) => void }`) or fixed-shape
2. Whether per-store assertions use `.toHaveBeenCalled()` per-method
   or a single "any-call" helper
3. Whether the factory returns a fresh graph per call or memoises
4. Whether the factory is exported from
   `src/__tests__/_helpers/createTestDb.ts` or lives per-test
5. What the convention does for `bun --bun vitest` factory-hoisting
   differences

**Why it matters.** A.7's gate is *"the first 5-10 test rewrites
must produce the same assertion outcomes as the mock-replaced
versions"* (per AR11). Without a spec, the convention is set by
the first test author. If the convention misses `MaintenanceOps`
wiring, the cross-entity tests fail silently.

**Severity: major.** Add a "Test factory specification" subsection
to `06-risks-and-mitigations.md` AR11, addressing the 5 bullets
from HCE-7 in the same style as that review. Format: ~30 lines of
code block + one-paragraph rationale. This is the single highest-
leverage completeness fix in A.

---

### ACE-6 (major) — CE-8 cycle resolved but `MemoryStore` constructor
shape forces a hidden `auditLog + tokenUsage` injection (or Path C
asymmetry)

**Missing area.** Per AOE-1's analysis, `MaintenanceOps` is the
class that orchestrates the decay sweep. The plan's `03 §A11`
constructor signature is `(memory, auditLog, tokenUsage,
backgroundTasks, approvals, toolLog)`. `memory.decay()` is one of
the 3 calls inside `runDecaySweep`. But `MemoryStore.decay()` (the
A.5 method that replaces `decayMemories` at `db.ts:1213`) is a
**single-store method** — it doesn't call `auditLog` or
`tokenUsage`. The orchestration lives in `MaintenanceOps`.

The plan's CE-8 mitigation table at `06 §AR3` describes the
construction order as:
```
DbClient.open(config, log)
  → MemoryStore(db, cache, embedding, log)
  → AuditLog(db)
  → TokenUsagePruner(db)
  → BackgroundTaskPool(db)
  → ApprovalStore(db)
  → ToolLog(db)
  → MaintenanceOps(memory, auditLog, tokenUsage, backgroundTasks,
                   approvals, toolLog)
  → HeartbeatScheduler(maintenanceOps, ...)  // F.1
```

This is correct for A.6's design. But `MemoryStore`'s constructor
(per `03 §A2`) is `(db, cache, embedding, log)` — no
`auditLog`/`tokenUsage` injection. The plan does NOT verify that
`MemoryStore.decay()` does not call `auditLog.prune()` or
`tokenUsage.prune()` — i.e., the plan's claim that
"`MemoryStore.decay()` does NOT call `MaintenanceOps`" is asserted
in AR3 but not verified by reading the source.

Per CLAUDE.md §8: *"Control-flow guard vagy korai return
beszúrása előtt olvasd el a TELJES befoglaló függvényt"* — the
plan must verify the single-direction chain by reading
`MemoryStore.decay()` (the proposed A.5 method) end-to-end and
confirming it doesn't reach for sibling stores. The plan's
assertion is correct in spirit but not load-bearing — a future
implementation could add `this.auditLog?.prune()` inside
`decay()` and break the single-direction chain silently.

**Severity: major.** Add a "single-direction chain verification"
subsection to `06 §AR3` with a `grep -nE "this\.(auditLog|tokenUsage)"
src/db.ts` check (must return 0 after A.5). This pins the
single-direction property as a regression-test, not a hope.

---

### ACE-7 (major) — Schema migrations in scope question not answered

**Missing area.** `src/db.ts:7-8` declares:
```ts
// src/db.ts:42-948 contains ~30 runScript(db, ...) calls
// src/db.ts:950-969 contains migrateTaskRunsFromJson()
```

Per `01 §1.2` step 7: *"Calls ~30 `runScript(db, ...)` calls that
issue idempotent `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF
NOT EXISTS` / `CREATE TRIGGER IF NOT EXISTS` statements. Includes
one try/catch `ALTER TABLE` migration for the
`sessions.message_count` column (lines 90-94)."*

The plan's A.1 `DbClient` design absorbs `initDatabase()` and
"runs the ~30 `runScript(db, ...)` schema migrations plus the
legacy `migrateTaskRunsFromJson()`". So schema migrations are in
A scope.

But: the plan does NOT address:
1. **Whether schema migrations move to a separate `Migrations`
   class** (a la Rails-style migration files) or stay inline in
   `DbClient.open()`. Per CLAUDE.md §2 ("Simplicity First"), the
   inline path is correct today; flagging a future migration
   extraction is over-engineering.
2. **The one non-idempotent migration** — `migrateTaskRunsFromJson`
   at L950 — runs at boot and inserts rows with the original `ts`,
   deduping on PK. Per `01 §5.2`: *"There is no flag like
   `migrations_applied_at` to gate this. Currently safe because
   `migrateTaskRunsFromJson` is idempotent at the data layer."*
   The plan does not flag this as a risk for the class refactor —
   if `DbClient.open()` is called twice (re-init guard at L49-51),
   the migration runs twice. Today's re-init guard prevents this,
   but the class form needs to preserve the same guarantee.
3. **The `ALTER TABLE` try/catch at L90-94** — the migration
   adds the `sessions.message_count` column. If it fails (the
   column already exists), the warning at L223 is logged.
   `DbClient.open()` must preserve this behavior.

**Severity: major.** Add a "schema migrations in A.1 scope"
subsection to `00-summary.md` enumerating:
- The ~30 `runScript` calls (lines 80-948) move into
  `DbClient.open()` as-is
- `migrateTaskRunsFromJson()` (L950) moves to `DbClient.open()`
  with the same re-init guard
- The `ALTER TABLE` try/catch at L90-94 and the L223 warn log
  stay inline

This is a small completeness fix but the schema migrations are
the most load-bearing part of `initDatabase()` — getting them
wrong breaks boot.

---

### ACE-8 (major) — CE-9 `RemoteStatusCache<T>` reuse is correctly
framed but the migration path under-specifies the `web/agents.ts`
adoption

**Missing area.** The plan's `04 §3 TtlCache<K, V>` correctly
identifies `RemoteStatusCache<T>` at `web/remote-status-cache.ts:19`
as the precedent. Per the verified ground truth, `RemoteStatusCache<T>`
is consumed at:
- `src/web/routes/agents.ts:204` — `new RemoteStatusCache<AgentRunState>(5000)`
- `src/web/routes/agents.ts:205` — `new RemoteStatusCache<string | null>(3000)`
- 16 test sites in `src/__tests__/remote-status-cache*.test.ts`

The plan's `04 §3 Migration steps` says:
> 1. Create `src/util/ttl-cache.ts` with `TtlCache<K, V>` (extends
>    `RemoteStatusCache<T>`'s `getOrRefresh` / `invalidate` with
>    `invalidatePrefix` / `clearAll` / `size`).
> 2. `MemoryStore` (A.5) constructor takes `cache: TtlCache<string, Memory[]>`.
> 3. `web/routes/agents.ts:204-205` replaces
>    `new RemoteStatusCache<T>(...)` with `new TtlCache<T, T>(...)`.
> 4. After both consumers migrate, `RemoteStatusCache<T>` at
>    `src/web/remote-status-cache.ts:19` is **removed** (or kept
>    as a deprecated thin wrapper that delegates to `TtlCache`).

Step 4 is the load-bearing decision but the plan defers it
("either ... or kept"). The two consumers' use of
`RemoteStatusCache<T>` is different:
- `agents.ts:204-205`: 2 instances, `getOrRefresh` semantic,
  per-instance TTL (5000ms, 3000ms)
- `db.ts:1245` memoryCache: 1 instance, **lazy** semantic
  (`memoryCacheGet` returns `null` on miss), per-agent prefix
  invalidation

Per `02 §5 "Final recommendation"`: *"keep `MemoryStore`'s cache
**lazy**, but implement it on top of a minimal `TtlCache<K, V>`
utility that lives in `src/util/ttl-cache.ts` and **shares its
`store: Map<K, V>` shape with `RemoteStatusCache<T>`**."*

But `RemoteStatusCache<T>` is **eager-refresh** (per the comparison
table in `02 §5`):
> "**`get` / `getOrRefresh`**: `get` only (lazy expiry) |
> `getOrRefresh` (eager refresh on miss)"

The plan's recommended `TtlCache<K, V>` is **lazy** (`02 §5
"Final recommendation"`). So `TtlCache` and `RemoteStatusCache`
have **opposite** miss semantics. Step 1 ("extends
`RemoteStatusCache<T>`'s `getOrRefresh`") cannot apply to a lazy
cache. The plan is internally inconsistent: step 1 says "extend
RemoteStatusCache", final recommendation says "lazy semantics".

**Why it matters.** If `TtlCache` extends `RemoteStatusCache`, it
inherits `getOrRefresh` (eager). The lazy variant (`getOrNull`)
would need to be added. If `TtlCache` is built as a **minimal**
utility (per the final recommendation), it does not extend
`RemoteStatusCache` — it shares the `Map<K, V>` shape only.
The wording "extends ... `getOrRefresh` / `invalidate`" in step 1
contradicts the "lazy, not eager-refresh" requirement.

Step 3's migration (`agents.ts:204-205`) requires the same
**eager** semantic that `RemoteStatusCache` provides today. If
`TtlCache` is lazy, the agents.ts migration breaks the
`getOrRefresh(key, nowMs, fetch, fallback)` callers.

**Severity: major.** Resolve the eager-vs-lazy inconsistency. Two
options:
- (a) **`TtlCache<K, V>` is eager** with `getOrRefresh` + `invalidate`
  + `invalidatePrefix` + `clearAll`. `MemoryStore` uses eager
  semantic — the fetch closure is provided at the call site.
  This means `MemoryStore.getAgentMemories()` calls
  `cache.getOrRefresh(key, Date.now(), () => this.fetchMemoriesFromDb(agentId, limit, category))`.
- (b) **`TtlCache<K, V>` is lazy** with `get(key): V | null` +
  `set(key, value)` + `invalidate` + `invalidatePrefix` +
  `clearAll`. `MemoryStore` keeps today's 2-step pattern (check
  cache, miss → call DB → cache.set). `RemoteStatusCache<T>`
  stays separate (different API, different concern).

Option (b) is simpler and matches `02 §5`'s final recommendation.
Pick (b) and rewrite step 1 to: *"Create `src/util/ttl-cache.ts`
with `TtlCache<K, V>` as a **standalone** class (NOT extending
`RemoteStatusCache<T>`) with `get`, `set`, `invalidate`,
`invalidatePrefix`, `clearAll`, `size`. `RemoteStatusCache<T>`
stays at `web/remote-status-cache.ts:19` for `agents.ts:204-205`'s
eager-refresh callers."*

The CE-9 lens then shifts: the shared utility is **not**
`TtlCache-vs-RemoteStatusCache` but **the underlying `Map<K, V>`
+ TTL bookkeeping primitive**. A.9 can be deferred (no shared
abstraction needed if the two caches stay separate APIs).

---

### ACE-9 (major) — `bun:sqlite` type drift (framework CE-17
inheritance) not addressed

**Missing area.** The codebase migrated from `better-sqlite3`
(Node-native) to `bun:sqlite` per `src/db/sqlite.ts:1-7`:
> *"The codebase migrated from `better-sqlite3` (Node-native,
> incompatible with bun) to `bun:sqlite` (built into the bun
> runtime, 3-6x faster). All code runs under bun at production and
> test time. There is NO node fallback."*

The adapter at `src/db/sqlite.ts` handles two bun:sqlite-specific
gaps:
1. `.pragma(source)` convenience is missing — wrapped as `pragma()`
2. `bun:sqlite`'s `.run() / .exec()` accept multi-statement SQL
   (including CREATE TRIGGER blocks with internal `;` in BEGIN
   bodies) — `runScript()` passes blocks through unchanged

The plan's `03 §A1` `DbClient` constructor takes
`(config: Pick<Config, 'STORE_DIR' | 'DB_FILENAME' | 'PROJECT_ROOT'>,
log: LoggerLike)` — but does NOT address bun:sqlite-specific
runtime differences. Per the framework CE-17 / HCE-10 / BCE-11 /
CE-D7 / CE-F3 / CE-F4 inheritance:

- `bun:sqlite`'s `.transaction(fn)` returns a function that is
  NOT identical to `better-sqlite3`'s — the former is sync
  (returns the function result synchronously), the latter is
  also sync, but bun's behavior under nested transactions
  (savepoints) may differ.
- `bun:sqlite`'s `db.prepare(sql).run(...args)` accepts a
  different bind-type set (`string | number | bigint | null |
  boolean | Date | Uint8Array | Buffer`) than better-sqlite3.
  If `DbClient.query<T>` widens the bind type to `unknown[]`
  (per the plan's `03 §A1` signature), the cast is silent.

**Why it matters.** If `DbClient.query<T>(sql, params?: unknown[])`
accepts `unknown[]` but `bun:sqlite` rejects a `bigint` > 2^53,
the runtime error is at the prepare boundary, not the call site.
A typed `DbClient.query<T>(sql: string, params?: SQLQueryBindings[])`
(per `sqlite.ts:32`'s `SQLQueryBindings` type) is more honest.

**Severity: major.** Add a "bun:sqlite type drift" subsection to
`06-risks-and-mitigations.md` enumerating:
- `query<T>` and `exec` parameter types should be
  `SQLQueryBindings[]` (imported from `db/sqlite.ts`), not
  `unknown[]`
- The 4 bun:sqlite-specific API gaps (pragma convenience,
  multi-statement run, transaction semantics, bind types) are
  adapter-only concerns; `DbClient` should not re-export them
- Per CLAUDE.md §8, the `bun tsc --noEmit` baseline of **1742
  errors** (per the framework precedent) is mostly `bun:sqlite`
  type drift — A.1 will reduce this by ~3308 - 158 - 41 = 3109
  source lines but not by 1742 errors (the errors are spread
  across many files, not concentrated in `db.ts`)

---

### ACE-10 (major) — `store-watcher.ts` data flow mis-described

**Missing area.** The plan's `00 §Files this plan touches` row says:
> "`src/store-watcher.ts:78` (calls `logStoreFileEvent`)"

Verified ground truth:
- `src/store-watcher.ts:4` — `import { logStoreFileEvent } from './db.js'`
- `src/store-watcher.ts:145` — `logStoreFileEvent(rel, 'create', 0, fileSize, agent)` (the actual call site)

The plan's `:78` is off by ~67 lines. The actual import is at
L4 (the import clause), the actual call is at L145 (inside the
`fs.watch` handler closure). The plan's CE-F5 / F `01 §Per-file
inventory` correctly identifies the import location (`store-watcher.ts`
top-level).

The plan also says "the `StoreWatcher` class (F.3) takes a
`StoreAuditLog` instance" — but the entity is `AuditLog` in
A's terminology (per the plan's `01 §1.4` "Audit log (cross-entity)"
row at L2898-3016, which has 2 functions: `queryAuditLog` and
`pruneAuditLogs`). The F plan's `StoreAuditLog` and A's `AuditLog`
are the same entity but with different class names. The plan
should align them: either `StoreAuditLog` (F-friendly) or `AuditLog`
(A-friendly) but not both.

**Severity: major.** Fix the file:line ref (`:78` → `:4` for
import, `:145` for call site). Pick one class name
(`StoreAuditLog` or `AuditLog`) and use it consistently across
A and F plans.

---

### ACE-11 (major) — `web/command-task.ts` importer missed from the
14-narrow / 39-broad count

**Missing area.** Per ACE-2, the importer count is 40 not 39.
The missed file is `src/web/command-task.ts`. The plan's `01 §3`
table "Direct Importer Distribution" lists 10 `web/` top-level
importers (`auth-device-keys, auth-sessions, channel-request-watcher,
context-guard-runner, fleet-transfer, inbox-nudge-watcher,
message-router, schedule-runner, security-reset, token-usage`).
The actual count is **11**, with `command-task.ts` as the 11th.

**Why it matters.** `command-task.ts` consumes what symbols? A
`grep -n "from ['\"].*db\.js['\"]" src/web/command-task.ts` reveals
the answer; the plan does not enumerate it. Without enumeration,
A.7's gate cannot verify that `command-task.ts` is migrated.

**Severity: major.** Add `command-task.ts` to the `01 §3` table
with its symbol list. Update the importer counts to 40 broad / 15
narrow (per ACE-2).

---

### ACE-12 (minor) — Per-store `parseRow<T>` private method
duplication (104 boundary casts → ~104 method bodies)

**Missing area.** The plan's `04 §1 Alternative: parseRow<T>
helper per store` says:
> "Instead of `BaseStore<TEntity>`, each store owns a private row
> adapter: `class KanbanCards { private parseRow(row: unknown):
> KanbanCard { return row as KanbanCard } }`"

Per `02 §3`, there are **104 boundary `as` casts** in `db.ts`,
distributed across 64 entity-targeted casts (Memory, AgentMessage,
KanbanCard, etc.) plus ~40 inline structural shapes (the
`{ c: number }` COUNT(*) shape, etc.).

If each store has its own `parseRow<T>`, the 104 casts collapse
into ~13 private methods (one per store), each handling 5-15
casts. This is correct — but the plan does not sketch the method
bodies. The 64 entity casts have stable shapes (e.g., `KanbanCard[]`
from `SELECT *`); the 40 inline casts have **ad-hoc shapes**
(`{ c: number }`, `{ id, idea_id, from_status, to_status, actor,
note, created_at }`). The ad-hoc shapes are the ones the plan
flags as "RISKY — type-widening on aggregate" (per `02 §3`).

**Why it matters.** The plan says "private `parseRow<T>` helper
per store" but does not commit to a per-store cast inventory.
The 40 inline casts are an aggregate-query concern (mostly the
audit-log search row shapes per `02 §3 Severity table`), and a
single class-wide `parseAuditRow` (vs per-store) may serve
better. The plan defers the design decision.

**Severity: minor.** Either (a) enumerate per-store cast counts
in `02 §3` (MemoryStore 11, AgentMessageStore 6, KanbanCards 5,
etc.), or (b) defer the parseRow design to A.1–A.5 implementation
and document the decision in the A.7 verification gate
("`grep -cE '\bas\s+[A-Z]' src/db.ts` ≤ baseline - N where N is
the per-store consolidation count").

---

### ACE-13 (minor) — `TelegramApiError` class in
`channel-coordinator/telegram-client.ts:45` not addressed in A scope

**Missing area.** Per D's CE-D1, `src/channel-coordinator/telegram-client.ts:45`
declares `class TelegramApiError extends Error`. This class is
in the D subsystem (per `d-channel-provider/review-completeness.md`).

The A plan's `02 §1.4` row "Channel requests (pairing)" at L2522-2562
lists 4 functions (`upsertChannelRequest`, `listPendingChannelRequests`,
`updateChannelRequestStatus`, `updateChannelRequestName`). The A
plan correctly does NOT claim these belong to `TelegramApiError` —
they belong to the new `ChannelPairingStore` class (per §A13).

But the plan does NOT explicitly say `TelegramApiError` is out of
scope. A future contributor who reads A plan in isolation might
wonder if the channel-coordinator error class interacts with the
A-store error taxonomy (per A.8).

**Severity: minor.** Add a one-line "Explicitly out of scope:
`src/channel-coordinator/telegram-client.ts:45`'s `TelegramApiError`
class" entry to `00 §Files this plan does NOT touch`, parallel to
D's CE-D1 mitigation.

---

### ACE-14 (minor) — `RemoteStatusCache<T>` is at line 19, but the
plan says `:19` (correct) — verify the line ref

**Missing area.** The plan's `00-summary.md` says:
> "`src/web/remote-status-cache.ts:19` `RemoteStatusCache<T>`"

Verified: `RemoteStatusCache<T>` is at `src/web/remote-status-cache.ts:19`.
The line ref is correct. This is a positive observation; the plan
cites the precedent class with the right file:line.

But the plan's `02 §5 "Existing RemoteStatusCache<T>"` has
*wrong* line refs for the consumer sites:
> "**`web/routes/agents.ts:204-205`** already instantiates
> `RemoteStatusCache<T>` twice today"

Verified: `web/routes/agents.ts:204` and `:205` — correct.
The plan's line refs are accurate.

**Severity: minor (positive).** All `RemoteStatusCache<T>` line
refs verified. No fix needed; this is a baseline-confidence
observation.

---

### ACE-15 (minor) — `scripts/` directory audit missing (F m12
framework inheritance)

**Missing area.** Per the F review's m12 framework finding (and
BCE-6 for B), the top-level `scripts/` directory may have importers
of the refactored subsystem. The A plan's `00 §Files this plan
touches` lists `scripts/dashboard-user.ts:8` as a consumer but
does NOT enumerate other `scripts/*.ts` files.

Verified (`ls scripts/`): `dashboard-user.ts`, `setup.ts`,
`remote-access-enroll.ts`, `status.ts`. Per `grep -rn "from
['\"].*db\.js['\"]" scripts/`:
- `dashboard-user.ts` — 8 symbols (per `01 §3`)
- (others — to verify)

The plan should enumerate the script importers and document which
are in/out of scope.

**Severity: minor.** Add `scripts/` enumeration to `01 §3` "Direct
Importer Distribution" with a row for each of the 4 scripts.
Pin in/out of scope per script (currently only
`dashboard-user.ts` is in scope per the plan).

---

## Cross-cutting risk: bun-specific test patterns (CE-17
inheritance)

Per the framework CE-17 + every other subsystem's review
(HCE-10, BCE-11, CE-D7, CE-F3/F4/F6), `bun --bun vitest`'s
runtime differs from Node-vitest on:
- `vi.mock` factory-hoisting semantics
- `vi.resetModules()` behavior under HMR
- `vi.doMock` interleaving
- `instanceof` semantics
- `Error.captureStackTrace` support
- `bun:sqlite`-specific gaps (per ACE-9)

The plan's `06-risks-and-mitigations.md` AR5 enumerates the 50
mock files and the 3 mock patterns but does not verify factory-
hoisting under bun. The 50 mocks are the **largest** mock surface
of any single subsystem in the plan series (vs B's 154 mock sites,
but A's mocks are larger per-file — the `kanban-routes.test.ts`
factory at L120-150 is one of the largest single test factories
in the codebase). A inherits the bun-vitest exposure and should
enumerate it.

**Severity: minor.** Extend AR5 with a "bun --bun vitest
verification" detection signal: *"All 50 mock sites pass
`bun --bun vitest run`. The mock-seam survival depends on
factory-hoisting behaviour that may differ between Node-vitest
and bun-vitest; verify with the test fixture at
`kanban-routes.test.ts:120-150` (the largest single mock factory
that exercises multiple `db.ts` symbols)."*

---

## Net assessment

A's keystone thesis is correct and load-bearing:
- **The `db.ts` singleton → `DbClient` keystone + 12 entity stores**
  is the textbook refactor. The keystone-first ordering (A.1 →
  A.2 → A.3 → A.4 → A.5 → A.6 → A.7 → A.8/A.9/A.10) matches the
  B/E/F precedent. The free-function pass-through migration
  window preserves the 50 test mocks and the 39-broad importer
  surface.
- **The `BaseStore<TEntity>` rejection** (per `04 §1`) correctly
  applies OE-6 (single-purpose namespace vs 12 divergent
  consumers). The `parseRow<T>` per-store alternative is the
  right shape.
- **The CE-9 `RemoteStatusCache<T>` reuse** is correctly framed
  but under-specified (ACE-8): the eager-vs-lazy inconsistency
  in `TtlCache` semantics needs resolution before A.5.
- **The OE-10 `EmbeddingClient` separation** is correct but
  mis-shaped (AOE-2): `cosineSimilarity` should not move with
  the HTTP transport.
- **The `MaintenanceOps` decision** is justified by the cross-
  entity decay sweep but the 6-arg constructor with 3
  pure-delegation methods (AOE-1) is over-engineered.
- **The CE-4 error taxonomy** (preserve silent-return for 11
  stores, introduce `MemoryStoreError` only) is the right call.
- **The CE-8 single-direction chain** (`Heartbeat → MaintenanceOps
  → {stores} → db`) is correctly characterized but the wiring
  path (ACE-4) needs explicit pinning.

The plan has **4 over-engineering seams and 12 completeness
gaps**:

**Over-engineering:**
- `MaintenanceOps` 6-arg constructor with 3 pure-delegation
  methods (AOE-1).
- `EmbeddingClient.cosineSimilarity` mixes transport + math
  responsibilities (AOE-2).
- 4 of 6 sealed-class unions are ceremony (`BackgroundTaskStatus`,
  `ApprovalStatus`, `OtelSpanStatus`, `KanbanStatus`)
  per framework OE-1/OE-3 (AOE-3).
- A.8 and A.10 phases inflate single-commit work into multi-
  phase cards (AOE-4, AOE-5).
- Plus three minors: `[ASSUMPTION]` filenames (AOE-6),
  `MemoryCategory` sealed class is in A.2e but `AgentMessageStatus`
  is not scheduled (AOE-7), per-store blast-radius table
  maintenance overhead (AOE-8).

**Completeness:**
- `src/costops/` parallel SQLite module is completely missed
  (ACE-1 critical).
- Importer count is 40 not 39; `command-task.ts` and the 11th
  `web/` importer are missed (ACE-2 critical + ACE-11 major).
- 41 type-exports claim is 37 (ACE-3 major).
- CE-8 wiring path under-specified (ACE-4 major).
- `createTestDb(overrides?)` factory not specified (ACE-5 major).
- Single-direction chain not verified by `grep` (ACE-6 major).
- Schema migrations in scope question not answered (ACE-7 major).
- CE-9 `TtlCache<K, V>` eager vs lazy inconsistency (ACE-8
  major).
- `bun:sqlite` type drift not addressed (ACE-9 major).
- `store-watcher.ts` data flow mis-described (`:78` →
  `:4` import, `:145` call) (ACE-10 major).
- Plus five minors: per-store cast inventory (ACE-12),
  `TelegramApiError` out-of-scope (ACE-13), `RemoteStatusCache`
  line ref positive (ACE-14), `scripts/` enumeration (ACE-15),
  bun-vitest factory-hoisting verification.

**Recommendation: ACCEPT-WITH-EDITS.**

**Drop before executing:**
- `EmbeddingClient.cosineSimilarity` (AOE-2) — keep as free
  function or extract a `VectorMath` helper.
- 4 of 6 sealed-class unions (AOE-3): keep `AgentMessageStatus`
  and `MemoryCategory`; drop the rest.
- A.8 as a separate phase (AOE-4) — fold into A.5.
- A.10 as a separate phase (AOE-5) — fold into A.5.
- `MaintenanceOps`'s 3 pure-delegation methods (AOE-1) — keep as
  free functions or per-store methods; reduce `MaintenanceOps`
  to the 3-store decay orchestrator.

**Add before executing:**
- `costops/` inventory entry (ACE-1) — either migrate to
  `DbClient.getHandle()` OR document as out-of-scope.
- Re-measure importer count and type counts (ACE-2, ACE-3, ACE-11)
  — update all cite sites.
- CE-8 wiring path pinning (ACE-4) — pick
  `HeartbeatScheduler → memory.ts:155 → maintenanceOps.runDecaySweep()`.
- `createTestDb(overrides?)` factory specification (ACE-5) —
  per HCE-7's 5-bullet spec.
- Single-direction chain `grep` verification (ACE-6).
- Schema migrations in A.1 scope (ACE-7) — enumerate the
  ~30 `runScript` calls and the L950 JSON migration.
- CE-9 eager-vs-lazy resolution (ACE-8) — pick lazy, separate
  `TtlCache<K, V>` from `RemoteStatusCache<T>`.
- `bun:sqlite` type drift subsection (ACE-9).
- `store-watcher.ts:78` line ref fix (ACE-10).
- `AgentMessageStatus` sealed class as A.4c (AOE-7).

**Enumerate before executing:**
- `command-task.ts` in `01 §3` (ACE-11).
- `scripts/` directory audit (ACE-15).
- `TelegramApiError` out-of-scope entry (ACE-13).

**Resolve before executing:**
- All 6 `[ASSUMPTION]` filename markers (AOE-6).

**Verify before executing:**
- `bun --bun vitest` factory-hoisting per AR5 (cross-cutting
  CE-17 inheritance).
- Per-store `parseRow<T>` cast counts (ACE-12).

---

## Verification provenance

Every file:line reference in this review was read against the
working tree on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`):

- `src/db.ts` — read in full (3308 LOC verified via `wc -l`).
  - 158 `export function` lines (verified via `grep -cE "^export
    (async )?function "`).
  - 33 `export interface` + 4 `export type` = 37 type exports
    (verified via `grep -nE "^export (interface|type)"`).
  - 104 `as` boundary casts (verified via `grep -nE '\bas\s+[A-Za-z]'`).
  - 0 `throw` / `new Error` (verified via `grep -nE '\bthrow\b|\bnew Error\b'`).
  - 0 `as any` / `as unknown` / `: any` (verified via `grep -nE '\bas any\b|\bas unknown\b|: any\b'`).
  - `let db: Database` at L10, `initDatabase()` at L42,
    `getDb()` at L978, `memoryCache` Map at L1245
    (`memoryCacheGet` at L1247, `memoryCacheSet` at L1256,
    `memoryCacheInvalidate` at L1260, `clearMemoryCache` at L1267,
    `getMemoryCacheSize` at L1272).
  - `OLLAMA_URL` import at L5 (config), used at L2431 (HTTP
    fetch) and L2443 (warn log).
  - `logStoreFileEvent` exported at L2879.
- `src/memory.ts` — 210 LOC. Imports `searchMemories`,
  `recentMemories`, `saveMemory`, `decayMemories`,
  `pruneAuditLogs`, `pruneTokenUsage`, `getMemoriesForChat`,
  `listKanbanCardsSummary`, `type Memory` from db.js (9 symbols).
  `runDecaySweep()` at L155-160 orchestrating `dbDecay()`,
  `pruneAuditLogs()`, `pruneTokenUsage()`. `saveConversationTurn`,
  `buildMemoryContext`, `runDailyDigest` stay in memory.ts.
- `src/db/sqlite.ts` — 54 LOC. Documents the better-sqlite3 →
  bun:sqlite migration. Provides `Database` re-export and
  `SQLQueryBindings` type.
- `src/costops/` — 3 files (`config.ts` 7.6 KB, `ledger.ts`
  11.9 KB, `README.md`). `ledger.ts:9` imports `type Database`
  from `bun:sqlite` directly (NOT from db.ts). Has its own
  `db.prepare(...)` schema migrations for `cost_sources`,
  `cost_lines`. Uses `db.transaction(...)` at L104.
- `src/web/remote-status-cache.ts:19` — `class RemoteStatusCache<T>`
  verified. Consumers: `src/web/routes/agents.ts:204-205`
  (2 instances), `src/__tests__/remote-status-cache*.test.ts`
  (16 test sites).
- `src/web/federation/bridge.ts:24` — `import type { AgentMessage }
  from '../../db.js'` (type-only, confirmed).
- `src/store-watcher.ts:4` — `import { logStoreFileEvent } from
  './db.js'`. Call site at L145 inside `fs.watch` handler. Plan's
  `:78` line ref is off by ~67 lines.
- `src/__tests__/kanban-routes.test.ts:120` — `vi.mock('../db.js',
  () => ({ listKanbanCards: vi.fn(), ... }))` factory. 26-line
  `vi.hoisted` block at L26.
- 40 production importers (NOT 39): verified via
  `grep -rln "from ['\"].*db\.js['\"]" src/ scripts/ --include='*.ts'
  | grep -v __tests__ | sort | uniq | wc -l`. The missed file
  is `src/web/command-task.ts`.
- 50 `vi.mock('../db.js')` test sites (verified via
  `grep -rln "vi\.mock.*['\"]\\.\\./db\.js" src/__tests__/ | wc -l`).
- Cross-cutting lessons applied: framework OE-1 (sealed-class
  ceremony, applied via AOE-3); framework OE-3 (sealed-class with
  no per-variant payload, applied via AOE-3); framework OE-4
  (speculative shape-parity, applied via AOE-1); framework OE-6
  (single-purpose namespace, applied via AOE-1, AOE-8);
  framework CE-1 (inventory thoroughness, applied via ACE-1);
  framework CE-5 / HCE-7 / BCE-7 / CE-D3 / CE-F7 (test factory
  specification, applied via ACE-5); framework CE-8 (cross-entity
  circular dep, applied via ACE-4, ACE-6); framework CE-11 (per-
  file blast radius, applied via AOE-8); framework CE-17
  (bun --bun vitest, applied via the cross-cutting section);
  HOE-3 / BOE-3 (phase inflation, applied via AOE-4, AOE-5);
  OE-D1 (unreachable parameter, applied via AOE-2);
  CE-D1 (channel-coordinator subcluster, applied via ACE-13);
  CE-F1 (parallel SQLite module, applied via ACE-1).
