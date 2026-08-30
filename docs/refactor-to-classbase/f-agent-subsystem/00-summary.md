# F (agent subsystem) — Executive summary

Synthesis of `01-module-state-analysis.md` (module/state lens) and
`02-type-interface-analysis.md` (types/interfaces lens), cross-checked
against `src/` on 2026-08-30 and against the framework-level patterns
established by H (`h-cross-cutting/00-summary.md` /
`03-class-boundaries.md`), E (`e-process-lock/00-summary.md` /
`03-class-boundaries.md`), and D (`d-channel-provider/00-summary.md` /
`03-class-boundaries.md`). **Planning only — no source file was modified.**

---

## Thesis

F is the agent runtime stack: the SDK entry point (`agent.ts`), the
periodic heartbeat scheduler (`heartbeat.ts`), two file-watching caches
(`store-watcher.ts`, `settings-store.ts`), two mtime-invalidated auth
caches (`google-api.ts`, `graph-mail.ts`), and one pure decision module
(`auto-restart.ts`). Six of the seven files are **singleton-shaped with
module-level mutable state**; the seventh (`auto-restart.ts`) is pure
and stays free. The refactor produces eight class candidates: one
scheduler, two watcher-shaped stores, three lazy-cache wrappers, one
worker-cwd builder isolated from the scheduler, and one schedule-decision
object. Three risks dominate: heartbeat's self-rescheduling `setTimeout`,
double `fs.watch` handles on the same directory, and the `refreshInFlight`
single-flight pattern in `google-api.ts` that must remain singleton-aware
after class extraction.

## Scope

### Files this plan TOUCHES

| File | Why | Phase |
|---|---|---|
| `src/heartbeat.ts` (601 lines) | extract `HeartbeatScheduler` and `HeartbeatWorkerCwdBuilder`; preserve `initHeartbeat` / `stopHeartbeat` / `executeHeartbeat` free-function wrappers until every consumer migrates | F.1, F.6 |
| `src/store-watcher.ts` (160 lines) | extract `StoreWatcher` with `start` / `stop` / `onChange`; keep `startStoreWatcher` / `stopStoreWatcher` free-function wrappers until consumer migrates | F.3 |
| `src/settings-store.ts` (111 lines) | extract `SettingsStore` with `ensureWatching` / `getEffective` / `setOverride`; keep free-function wrappers | F.4 |
| `src/agent.ts` (216 lines) | extract `ClaudeCodeBinResolver extends LazyBin<'claude'>` per H.3; `runAgent` and `classifyAgentResult` stay as free functions | F.7 |
| `src/google-api.ts` (211 lines) | extract `GoogleApiClient` (or `GoogleCalendarClient` per `02 §class-boundaries-recommendation-preview`); keep `getCalendarEvents` free wrapper; preserve `refreshInFlight` single-flight semantics | F.2 |
| `src/graph-mail.ts` (263 lines) | extract `GraphMailClient` (or split into `GraphMailCredentialsCache` + `GraphMailTokenCache` per `02 §class-boundaries-recommendation-preview`); keep `listMessages` / `sendMail` / `verifyAccess` free wrappers | F.2 |
| `src/auto-restart.ts` (122 lines) | extract `AutoRestartSchedule` class per the brief (deviation from `02 §AutoRestart deep-dive` which recommends keeping free functions; the brief overrides — see FR-free-fn-debate below) | F.5 |
| `src/index.ts` | the only production consumer of F (`initHeartbeat` / `stopHeartbeat` / `startStoreWatcher` / `stopStoreWatcher`); construct the four class instances and pass them through. Two module-level `setTimeout`/`setInterval` registrations in `index.ts:541-552` shift onto `HeartbeatScheduler` | F.1, F.3 |
| `src/__tests__/index.test.ts` (one `vi.mock('../heartbeat.js')` factory at `:122`, plus one `vi.mock('../store-watcher.js')` at `:164` per `01 §Per-file inventory`) | update mock factories only if class-instance construction replaces module-level `const`; the dominant pattern (mock-replacing-the-module) survives because `initHeartbeat` / `stopHeartbeat` / `startStoreWatcher` / `stopStoreWatcher` keep the same signatures | F.1, F.3 |

### Files this plan does NOT touch

- **`src/web/heartbeat-agent-scaffold.ts`** (CE-7 — prompt-builder, NOT
  a runner, **out of F scope**). It owns no ticker; it materialises the
  heartbeat agent's directory once per boot when the dashboard process
  bootstraps. The `HeartbeatScheduler` class is the runner; the
  prompt-builder is a separate utility that the scheduler does not own
  per `01 §Files this plan does NOT touch`.
- **`src/platform.ts`** — `LazyBin` lives there per H.3; F consumes it
  via `new ClaudeCodeBinResolver('claude')` (= `new LazyBin('claude')`).
  H owns the `LazyBin` class; F owns only the F-specific subclass that
  extends it.
- **`src/memory.ts`** — `runDecaySweep` is called from
  `executeHeartbeat` (`heartbeat.ts:509-512`). F does not own `memory.ts`
  (it's a per-entity store per the framework's A1 candidate); the
  `HeartbeatScheduler` class takes a `MemoryStore` instance (per the
  framework's A1) and calls `memoryStore.runDecaySweep()`. Cross-file
  coupling documented in FR4 below.
- **`src/db.ts`** — `heartbeat.ts` calls `db` via `logStoreFileEvent`
  indirectly (store-watcher) and via the `getHeartbeatKanbanSummary`
  free function. F does not own `db.ts` (it's a keystone per the
  framework's D2).
- **`src/web/inbox-nudge-watcher.ts`** — not a heartbeat subsystem; it
  has its own fs.watch instance and is part of the web runner cluster
  per the framework's B5.
- **`src/__tests__/{graph-mail.test.ts, heartbeat.test.ts,
  heartbeat-cov.test.ts, settings-store.test.ts, store-watcher*.test.ts,
  agent-*.test.ts, …}`** — tests get *updated* to match new class APIs
  but their layout, runner, and coverage targets are not in scope
  (consistent with `00-summary.md` "Explicitly OUT OF SCOPE").

### Adjacent files (mentioned for context)

- **`src/web/heartbeat-agent-scaffold.ts`** — see above; CE-7
  prompt-builder. The `HeartbeatScheduler.execute()` returns no result
  shape that the prompt-builder consumes today (FR8 documents the
  seam).
- **`src/index.ts:541-552`** — today calls `initHeartbeat()` /
  `stopHeartbeat()`; F.1 converts this to construction of
  `HeartbeatScheduler` + `.start()` / `.stop()` calls.
- **`src/__tests__/index.test.ts:122, :127, :164`** — `vi.mock` factories
  that today substitute the entire `heartbeat.js` /
  `store-watcher.js` module; F.1 / F.3 must keep these working
  unchanged while the free-function wrappers survive.

## Dependency: what F blocks and what blocks F

| Direction | Counterparty | What |
|---|---|---|
| **F ← H** | `LoggerLike` interface (H.1), `LazyBin<TName, TResolved>` (H.3) | `HeartbeatScheduler`, `StoreWatcher`, `SettingsStore`, `GoogleApiClient`, `GraphMailClient` all take `LoggerLike` in their constructor (per H.1). `ClaudeCodeBinResolver` extends `LazyBin<'claude'>` (per H.3). **Phase ordering:** F.6 (LoggerLike adoption) cannot land before H.1. F.7 (LazyBin adoption) cannot land before H.3. |
| **F ← framework A1** | `MemoryStore` class | `HeartbeatScheduler.execute()` calls `runDecaySweep()` (currently `memory.ts:16`); after framework A1 lands, this becomes `memoryStore.runDecaySweep()`. F.1 must accept either the free function or the instance method depending on which lands first. |
| **F → index.ts** | `App` keystone (framework D3) | `App` constructs `HeartbeatScheduler`, `StoreWatcher`, `SettingsStore`, the three lazy-cache wrappers, and `AutoRestartSchedule` at boot. Phase ordering: F is downstream of D's keystone; App.start() in D.3 calls `heartbeatScheduler.start()`, etc. |
| **F → E (process-lock)** | `PortLockAcquirer` + `PidfileLockAcquirer` | F starts after E acquires the lock (per `01 §Startup ordering` and `e-process-lock/00-summary.md §Dependency`); F shuts down before E releases the lock (`index.ts:378-410`). **F is downstream of E; no cycle.** |
| **F ← C (framework Part C — lazy-cache singletons)** | Framework §C1 calls out `ClaudeCodeBinResolver` | The framework already describes `ClaudeCodeBinResolver` as "a more specialized version of `LazyBin`" (`h-cross-cutting/04-generic-interfaces.md:227`). F is the trigger that justifies the class existing. C2 (google-api) and C3 (graph-mail) were deferred in the framework for F to formalise. |

In short: **F is blocked on H.1 (LoggerLike) and H.3 (LazyBin); blocked
on framework A1 (MemoryStore) only if MemoryStore lands first; blocks
D.3 (App keystone); parallel to E (process-lock), B (runners), and G
(generics catalogue).**

## Top 3 risks specific to F

1. **Heartbeat timer double-schedule across HMR / `vi.resetModules()`**
   (`heartbeat.ts:565-580`). The self-rescheduling `setTimeout` at
   `scheduleNext:569` re-arms itself from inside the callback. The
   `stopHeartbeat()` at `:594` clears the timeout and flips `stopped`,
   but **does not set `heartbeatTimeout = null`**, so a racing
   `initHeartbeat()` between `stopHeartbeat()` and the in-flight
   callback finishing can leave the earlier handle armed while the
   newer one schedules a fresh timeout. Class form (`HeartbeatScheduler.stop()`)
   must clear the in-flight handle AND track an in-flight `execute()`
   promise to cancel cleanly. Detail in FR1 / FR5 below.

2. **Double `fs.watch` handle on HMR / module re-evaluation**
   (`store-watcher.ts:88-95`, `settings-store.ts:46-50`). The
   `if (watcher) return` guard at both sites protects against same-graph
   re-entry only. Under `vi.resetModules()`, `tsx --watch`, or a forked
   worker, the new module-graph has `watcher = null` but the old
   `fs.watch` handle is still open (Node holds the closure alive via the
   event loop). Result: two `fs.watch` callbacks firing per rename
   event, duplicated `logStoreFileEvent` writes, and a leak that
   compounds across re-imports. The class form owns a single readonly
   `FSWatcher` field and asserts null on construction. Detail in FR2
   below.

3. **`google-api.ts` `refreshInFlight` single-flight must remain
   singleton-aware after class extraction** (`google-api.ts:108-118`).
   The `refreshInFlight: Promise<string> | null` pattern deduplicates
   concurrent token refreshes — a load-bearing property (a slower
   response overwriting a faster one is the failure mode the inline
   comment at `:111-114` warns against). Class form must keep the
   single-flight at the module level (or a `private static` cell) so
   that all callers across the process share one in-flight Promise,
   not one per class instance. Detail in FR3 below.

## Migration order inside F

```
F.1  HeartbeatScheduler class extraction
      ├─ HeartbeatWorkerCwdBuilder sub-class (extracted from heartbeat.ts:77-221)
      └─ execute / stop / triggerNow methods
                │
                +-----> F.6  LoggerLike adoption across F classes (depends on H.1)
                │
F.2  LazyCache<K, V> base + 3 implementations (or 3 independent classes)
      ├─ ClaudeCodeBinResolver (extends LazyBin, per H.3)
      ├─ GoogleApiClient (preserves refreshInFlight singleton)
      └─ GraphMailClient (clientId binding in token cache)
                │
                +-----> F.7  LazyBin<T> adoption (where F uses makeLazyBinResolver)
                │
F.3  StoreWatcher class extraction
                │
F.4  SettingsStore class extraction
                │
F.5  AutoRestartSchedule class extraction
                │
F.8  Free-function removal (gated on every consumer migration + test updates)
```

Rationale for the order:

- **F.1 first** because `heartbeat.ts` is the largest F file (601 lines,
  17 logger call sites per `02 §Per-file type audit`) and the most
  critical (timer state has the strongest re-init hazard). Extracting
  HeartbeatScheduler + HeartbeatWorkerCwdBuilder splits the 145-line
  cwd-construction plumbing (with the macOS Keychain side effect at
  `heartbeat.ts:268`) from the 116-line scheduling logic, making each
  testable in isolation.
- **F.2 second** because the three lazy-cache classes share an
  invalidation-shape pattern (`mtime` + `clientId` + manual) but
  diverge in detail. Per `02 §Lazy-cache cluster type comparison`, a
  shared `LazyCache<K, V>` base is rejected on OE-6 grounds (the brief's
  counter-argument for 3 consumers is considered and rejected in
  `04-generic-interfaces.md §LazyCache`). The three classes land
  independently.
- **F.3 + F.4 next** because both are fs.watch singletons with
  identical double-init hazard (`if (watcher) return` guards). They
  share the same migration shape (private readonly `FSWatcher` field,
  symmetric `start()` / `stop()` idempotency) but are otherwise
  independent.
- **F.5 next** because `auto-restart.ts` is the simplest file (122
  lines, zero module-level state, zero logger call sites) and the
  class extraction is a one-pass mechanical wrap. This is a brief
  override of the `02 §AutoRestart deep-dive` recommendation (which
  advised keeping it free for testability); the rationale is the
  framework's `00-summary.md §Top-3 lowest-risk wins` #3 lists
  `AutoRestartSchedule` as a class candidate, and the F brief confirms
  it. The override preserves `DEFAULT_AUTO_RESTART` as `readonly` and
  all four helpers as pure methods.
- **F.6 (LoggerLike) and F.7 (LazyBin) are cross-cutting** — they
  touch every F class and depend on H.1 / H.3. They land after the
  class extractions so the constructor signature is the only thing
  that changes (not the body).
- **F.8 last and gated.** Free-function removal is irreversible;
  the gate is `grep -rln "initHeartbeat\|stopHeartbeat\|startStoreWatcher\|stopStoreWatcher" src/ --include='*.ts' | grep -v __tests__`
  returning only `src/heartbeat.ts` / `src/store-watcher.ts` /
  `src/settings-store.ts` (the surviving free wrappers).

---

**Verified references (this run, 2026-08-30):**

- `src/heartbeat.ts:36, 52, 64, 66, 75, 77, 81-86, 95-124, 139, 160, 175,
  199, 204, 216, 223, 265, 268, 285-298, 319, 344, 363, 392, 483, 565,
  566, 568, 569, 580, 584, 594, 601`
- `src/store-watcher.ts:11, 38, 42-46, 47, 49, 53, 60, 62, 78, 79, 81,
  83, 88, 95, 102-103, 114, 142-145, 147, 150, 152, 156`
- `src/settings-store.ts:15, 17, 18, 20, 23, 32, 40, 46, 49, 50, 58,
  63, 72, 82, 92, 101-103, 109`
- `src/agent.ts:5, 7, 10, 17, 33, 39, 72-79, 81, 82, 106-108, 110, 122,
  140, 154, 156, 178-179, 182, 194, 216`
- `src/google-api.ts:11, 19, 27, 38, 51, 52, 54, 56, 58, 64, 70, 76,
  88, 108, 110-118, 156-163, 165, 211`
- `src/graph-mail.ts:16, 17, 21, 26, 33, 44, 55, 68, 72, 105-128, 132,
  136, 144-185, 202, 214, 232, 246, 255, 259, 263`
- `src/auto-restart.ts:1-14, 16, 19, 30-32, 34-46, 48-54, 57-65, 72-89,
  104-109, 117-122`
- Importers verified via
  `grep -rn "from ['\"]\\./X\\.js['\"]" src/ --include='*.ts' | grep -v __tests__`
- Test-mock counts verified via
  `grep -rn "vi\\.mock.*['\"]\\./X['\"]\\|vi\\.mock.*X\\.js" src/__tests__/ --include='*.ts'`
