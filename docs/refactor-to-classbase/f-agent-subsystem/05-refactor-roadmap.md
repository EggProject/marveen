# F (agent subsystem) — Refactor roadmap

Ordered phases for F. Each phase: goal, files touched, risk level,
test coverage requirement, rollback strategy, parallelizable. Plan-only
document; no source files modified.

**Reading note.** The phases are ordered to minimise cross-phase
re-work. F.1 lands first because `heartbeat.ts` is the largest F file
and the most critical (timer state has the strongest re-init hazard).
F.2 lands second because the three lazy-cache classes share an
invalidation-shape pattern. F.3 + F.4 land next (both are fs.watch
singletons with identical double-init hazard). F.5 is last because
`auto-restart.ts` is the simplest file. F.6 (LoggerLike) and F.7
(LazyBin) are cross-cutting and depend on H.1 / H.3. F.8 is the
free-function removal phase, gated on every consumer migration and
test update.

---

## F.1 — `HeartbeatScheduler` + `HeartbeatWorkerCwdBuilder` extraction

### Goal

Extract `class HeartbeatScheduler` (covering `initHeartbeat`,
`stopHeartbeat`, `executeHeartbeat`, `scheduleNext`, the four
`collectX` methods, `shouldNotify`, `buildAgentPrompt`,
`msUntilNextHeartbeat`) and `class HeartbeatWorkerCwdBuilder`
(covering `ensureHeartbeatWorkerCwd`, `lstatSyncSafe`,
`readClaudeCodeOauthJson`).

### Files touched

- `src/heartbeat.ts` (601 lines) — add the two classes alongside the
  free functions; the free-function wrappers `initHeartbeat`,
  `stopHeartbeat`, `executeHeartbeat` survive and forward to a
  module-level singleton instance.
- `src/index.ts` — change the call sites at `:541-552` from
  `initHeartbeat()` to a singleton-style call (the free wrapper
  already provides this; no signature change at the call site until
  F.8). [ASSUMPTION: if `index.ts` adopts `class App` first (framework
  D.3), the call site becomes `app.heartbeatScheduler.start()`; the
  module-level singleton path survives in the interim.]

### Risk level

**High.** `heartbeat.ts` is the largest F file (601 lines), has the
strongest re-init hazard (FR1), and is the only F file with 17 logger
call sites (`02 §Per-file type audit`). The class extraction must
preserve byte-identical behaviour for:
- `scheduleNext`'s self-rescheduling pattern (`heartbeat.ts:569-580`).
- The `initHeartbeat()` / `stopHeartbeat()` symmetry with the
  `stopped` flag.
- The `readClaudeCodeOauthJson` macOS-Keychain side effect
  (`:265-281`).
- The `HeartbeatAgentCwd` symlink dance (`:99-148`).

### Test coverage requirement

- `src/__tests__/heartbeat.test.ts` — the existing re-export of
  `executeHeartbeat` (`heartbeat.ts:601`) must keep working through
  the free-function wrapper.
- `src/__tests__/heartbeat-cov.test.ts:60` — same.
- `src/__tests__/index.test.ts:122` — the `vi.mock('../heartbeat.js', ...)`
  factory must keep returning assignable symbols.
- New tests to add: (a) `init()` twice without intervening `stop()`
  does NOT double-schedule (FR1); (b) `stop()` mid-`execute()`
  cancels the in-flight promise (FR5); (c) `HeartbeatWorkerCwdBuilder`
  with a stubbed `execFileSync` does not touch Keychain.

### Rollback strategy

Single-commit rollback. The classes live alongside the free functions;
reverting the class definitions and the singleton construction line
restores the prior shape. No test file is renamed or moved during F.1.

### Parallelizable

**No.** F.1 is the first F phase. F.2 (lazy-cache) and F.3 (store
watcher) can run in parallel with F.1 *only* if they touch disjoint
files (which they do). The recommendation is serial within F, but
multiple agents can implement F.1 + F.2 + F.3 concurrently in separate
worktrees, merging after each phase lands.

---

## F.2 — Lazy-cache classes (`GoogleApiClient` + `GraphMailClient`)

### Goal

Extract `class GoogleApiClient` from `google-api.ts` and
`class GraphMailClient` from `graph-mail.ts`. Each class wraps its
module-level cache cells as private fields, keeps the
free-function wrapper for the migration window, and preserves the
`refreshInFlight` single-flight semantics in `GoogleApiClient` via
a `private static` field (per FR3).

### Files touched

- `src/google-api.ts` (211 lines) — add `class GoogleApiClient`;
  free wrapper `getCalendarEvents(calendarId, timeMin, timeMax)`
  survives.
- `src/graph-mail.ts` (263 lines) — add `class GraphMailClient`;
  free wrappers `listMessages`, `sendMail`, `verifyAccess` survive.
  `parseCredentials` stays free (pure parser for testability).

### Risk level

**Medium.** The `refreshInFlight` single-flight must remain
process-singleton (FR3). The `GraphMailClient` has zero production
importers (per `01 §Per-file inventory`); only tests touch it, so
the test rewrite is contained.

### Test coverage requirement

- `src/__tests__/heartbeat.test.ts:90` and
  `src/__tests__/heartbeat-cov.test.ts:60` — mock
  `getCalendarEvents` to inject test fixtures; the free wrapper keeps
  the import path working.
- `src/__tests__/graph-mail.test.ts` — all 9 sites use
  `await import('../graph-mail.js')` per `01 §Per-file inventory`.
  Update to construct `new GraphMailClient(mockLog)` per site.
- New tests to add: (a) two concurrent `getValidAccessToken()` calls
  share one in-flight Promise (FR3); (b) `invalidate()` drops the
  cache and the next call re-reads.

### Rollback strategy

Single-commit rollback per file. Each class lives alongside its free
wrapper; reverting the class definition restores the prior shape.

### Parallelizable

**Yes.** F.2 is disjoint from F.1 (`heartbeat.ts` vs `google-api.ts`
+ `graph-mail.ts`). Can run in parallel with F.1 if the test file
migrations are kept disjoint (they are: `heartbeat.test.ts` vs
`graph-mail.test.ts`).

---

## F.3 — `StoreWatcher` class extraction

### Goal

Extract `class StoreWatcher` from `store-watcher.ts`. The class owns
the three `let` cells (`currentWriteActor`, `knownFiles`, `watcher`),
the `recentEvents` `const`, and the four exports
(`setStoreWriteActor`, `clearStoreWriteActor`, `startStoreWatcher`,
`stopStoreWatcher`).

### Files touched

- `src/store-watcher.ts` (160 lines) — add `class StoreWatcher`;
  free wrappers survive.

### Risk level

**Medium.** The double-`fs.watch` hazard (FR2) is the dominant concern.
The class form owns a single readonly `FSWatcher` field with a clear
constructor assertion (`if (this.watcher) throw`); the free-function
form's `if (watcher) return` idempotency is preserved at the class
level.

### Test coverage requirement

- `src/__tests__/index.test.ts:164`,
  `src/__tests__/autonomy-routes.test.ts:63`,
  `src/__tests__/settings-routes.test.ts:83`,
  `src/__tests__/agents-routes.test.ts:483` — 4 mocks of
  `../store-watcher.js` (per `01 §Per-file inventory`). Update each
  to mock the free wrappers OR the class module.
- New tests to add: (a) `start()` twice does NOT open two `fs.watch`
  handles (FR2); (b) `setActor()` + a watch event clears the actor
  slot; (c) `stop()` closes the watcher and clears the field.

### Rollback strategy

Single-commit rollback. Class lives alongside free functions; revert
the class definition restores the prior shape.

### Parallelizable

**Yes** (with F.4 — both touch the same `STORE_DIR` but write to
different files).

---

## F.4 — `SettingsStore` class extraction

### Goal

Extract `class SettingsStore` from `settings-store.ts`. The class owns
the two `let` cells (`cache`, `watcher`), the eager `loadFromDisk()`,
and the five exports (`__test_handleWatchEvent`, `getOverrides`,
`getEffectiveSettingValue`, `setOverride`, `reloadOverridesForTest`).

### Files touched

- `src/settings-store.ts` (111 lines) — add `class SettingsStore`;
  free wrappers survive.

### Risk level

**Medium.** The `ensureWatching()` idempotency guard (FR2) is the
dominant concern; same shape as `StoreWatcher`. The 13
`vi.mock('../settings-store.js', …)` test mocks (per `01 §Per-file
inventory`) must keep working.

### Test coverage requirement

- 13 mock sites listed in `01 §Per-file inventory`.
- New tests to add: (a) `ensureWatching()` twice does NOT open two
  `fs.watch` handles (FR2); (b) `setOverride()` updates the cache
  synchronously (today's behaviour at `settings-store.ts:101-103`);
  (c) `onFsWatchEvent('rename', 'config-overrides.json')` reloads
  the cache (FR-free-fn-debate).

### Rollback strategy

Single-commit rollback. Same as F.3.

### Parallelizable

**Yes** (with F.3).

---

## F.5 — `AutoRestartSchedule` class extraction

### Goal

Extract `class AutoRestartSchedule` from `auto-restart.ts` per the
brief override of the `02 §AutoRestart deep-dive` recommendation.
The class is a namespace-wrapper around `DEFAULT_AUTO_RESTART` and the
five pure functions; no state, no I/O, no lifecycle.

### Files touched

- `src/auto-restart.ts` (122 lines) — add `class AutoRestartSchedule`;
  free wrappers survive.

### Risk level

**Low.** The module is dependency-free today (no imports beyond type
aliases). The class form is mechanical: move the const to a
`readonly` instance field, the five functions to methods, the two
type aliases to `readonly` exports on the class. Test identity
preservation requires `DEFAULT_AUTO_RESTART` to remain a
module-level const (per `03-class-boundaries.md §F8 — free functions
that REMAIN`).

### Test coverage requirement

- `src/__tests__/auto-restart-store.test.ts` +
  `src/__tests__/auto-restart-main-mechanism.test.ts` — the existing
  tests import the module directly. Update to construct
  `new AutoRestartSchedule()` per test.
- 3 vi.mock hits at `marveen-routes.test.ts:235`,
  `auto-restart-runner.test.ts:121`, `agents-routes.test.ts:469` are
  for `../web/auto-restart-store.js`, NOT `../auto-restart.js` — no
  update needed for these (per `01 §Per-file inventory`).
- New tests to add: (a) `instance.DEFAULT` and `DEFAULT_AUTO_RESTART`
  are the same frozen reference (test identity pin); (b) all five
  methods are pure (no observable state changes across calls).

### Rollback strategy

Single-commit rollback. Class lives alongside free functions; revert
the class definition restores the prior shape.

### Parallelizable

**Yes** (independent of F.1-F.4).

---

## F.6 — `LoggerLike` adoption across F classes

### Goal

Adopt `LoggerLike` (from H.1) in the constructors of `HeartbeatScheduler`,
`HeartbeatWorkerCwdBuilder`, `StoreWatcher`, `SettingsStore`,
`GoogleApiClient`, `GraphMailClient`. The 31 logger call sites across
5 of 7 F files (per `02 §Per-file type audit`) migrate from
`import { logger } from './logger.js'` + direct calls to
`this.log.warn(...)` etc.

### Files touched

- `src/heartbeat.ts` — 17 call sites (per `02 §Per-file type audit`)
- `src/store-watcher.ts` — 3 call sites
- `src/google-api.ts` — 4 call sites
- `src/graph-mail.ts` — 1 call site
- `src/agent.ts` — 6 call sites (in `runAgent` body; `ClaudeCodeBinResolver`
  does not need a logger)
- `src/settings-store.ts` — 0 call sites today; the constructor takes
  `log?: LoggerLike` for future-proofing
- `src/auto-restart.ts` — 0 call sites; no change

### Risk level

**Medium.** The 91 test mocks of `vi.mock('../logger.js', ...)` (per
`h-cross-cutting/04-generic-interfaces.md:24-49`) all satisfy the
4-method `LoggerLike` shape (info, warn, error, debug). Per
`h-cross-cutting/04-generic-interfaces.md §L "Which pino members MUST
be present"`, all 4 are required; the ~12 mocks that omit `debug`
must be updated.

### Test coverage requirement

- All 91 test mocks passing `bun --bun vitest run` (the
  `h-cross-cutting/06-risks-and-mitigations.md HR4` compile-time test
  pin: `const l: LoggerLike = logger` compiles with no cast).
- Constructor injection in production: `App` constructor (framework
  D.3) wires `log: logger` (the pino singleton) into each F class.
- Test injection: each F test constructs the class with
  `log: mockLogger` (the `vi.fn()` triple/quadruple).

### Rollback strategy

Per-class rollback. Each class's constructor change is one diff hunk;
revert that hunk to restore the module-import shape.

### Parallelizable

**Yes** (independent of F.1-F.5 if those land first; depends on H.1).
F.6 cannot land before H.1.

---

## F.7 — `LazyBin<T>` adoption (`ClaudeCodeBinResolver`)

### Goal

Replace the closure-based `cachedClaudeCodeBin` + `resolveClaudeCodeBin`
pattern in `agent.ts:81-100` with `class ClaudeCodeBinResolver extends
LazyBin<'claude'>` (per H.3 and `03-class-boundaries.md §F5`). The
class form adds the `invalidate()` method that the closure form lacks.

### Files touched

- `src/agent.ts` (216 lines) — add `class ClaudeCodeBinResolver extends
  LazyBin<'claude'>`; the free wrapper `resolveClaudeCodeBin()`
  survives.
- `src/platform.ts` — H.3 adds `class LazyBin` here (H-owned).

### Risk level

**Low.** `LazyBin`'s no-I/O-constructor invariant is pinned by
`src/__tests__/platform-no-import-time-bin-resolve.test.ts:44`. The
`resolve()` method is inherited from `LazyBin`; the `invalidate()`
method is new.

### Test coverage requirement

- `src/__tests__/platform-no-import-time-bin-resolve.test.ts:44` —
  the structural test guard that asserts zero module-scope
  `= resolveFromPath(` matches across `src/`.
- `src/__tests__/platform-bin-resolve.test.ts:96` — the existing test
  that constructs `new LazyBin(name)` and calls `.resolve()`.
- New tests: (a) `invalidate()` drops the memoised path; (b)
  `new LazyBin('claude')` is typed `LazyBin<'claude'>` (distinct
  from `LazyBin<'tmux'>`).

### Rollback strategy

Single-commit rollback per file.

### Parallelizable

**Yes** (independent of F.1-F.6; depends on H.3).

---

## F.8 — Free-function removal (gated close-out)

### Goal

Remove the free-function wrappers that survived F.1-F.7 once every
consumer and test file has migrated to the class API. The gates are
mechanical:

| Gate | Pattern | Expected result after F.8 |
|---|---|---|
| `initHeartbeat` / `stopHeartbeat` | `grep -rln "initHeartbeat\|stopHeartbeat" src/ --include='*.ts' \| grep -v __tests__` | only `src/heartbeat.ts` (the wrappers, before F.8 close-out) |
| `startStoreWatcher` / `stopStoreWatcher` | `grep -rln "startStoreWatcher\|stopStoreWatcher" src/ --include='*.ts' \| grep -v __tests__` | only `src/store-watcher.ts` |
| `getEffectiveSettingValue` / `setOverride` / `getOverrides` | `grep -rln "getEffectiveSettingValue\|setOverride\|getOverrides" src/ --include='*.ts' \| grep -v __tests__` | only `src/settings-store.ts` (5 importers per `01 §Per-file inventory`) |
| `resolveClaudeCodeBin` | `grep -rln "resolveClaudeCodeBin" src/ --include='*.ts' \| grep -v __tests__` | only `src/agent.ts` (4 importers per `01 §Per-file inventory`) |
| `getCalendarEvents` | `grep -rln "getCalendarEvents" src/ --include='*.ts' \| grep -v __tests__` | only `src/google-api.ts` (1 importer: `heartbeat.ts`) |
| `listMessages` / `sendMail` / `verifyAccess` | `grep -rln "listMessages\|sendMail\|verifyAccess" src/ --include='*.ts' \| grep -v __tests__` | zero (no production importers) |
| `mainRestartMechanism` / `parseHHMM` / `normalizeAutoRestartConfig` / `restartDue` / `dailyDueAtMs` | `grep -rln "mainRestartMechanism\|parseHHMM\|normalizeAutoRestartConfig\|restartDue\|dailyDueAtMs" src/ --include='*.ts' \| grep -v __tests__` | only `src/auto-restart.ts` (2 importers per `01 §Per-file inventory`) |
| `ensureHeartbeatWorkerCwd` / `readClaudeCodeOauthJson` / `lstatSyncSafe` | `grep -rln "ensureHeartbeatWorkerCwd\|readClaudeCodeOauthJson\|lstatSyncSafe" src/ --include='*.ts' \| grep -v __tests__` | only `src/heartbeat.ts` |

### Files touched

- All 7 F files (the free wrappers removed).
- 9 test files (per `01 §Per-file inventory` mock counts): 1 mock of
  `heartbeat.js` (`index.test.ts:122`) + 4 mocks of `store-watcher.js`
  + 13 mocks of `settings-store.js` + 2 mocks of `google-api.js` +
  0 mocks of `graph-mail.js` + 0 mocks of `auto-restart.js`.

### Risk level

**Critical.** This is the irreversible step. Once the free wrappers
are deleted, every consumer (production + test) must already be
migrated. The gate is mechanical — every grep above must return zero
or only the wrapper file itself.

### Test coverage requirement

- All F tests passing (`bun --bun vitest run`).
- The 91 logger mocks still satisfy `LoggerLike` (per FR-F.6).
- The `index.test.ts` mock factories at `:122` / `:127` / `:164` no
  longer substitute the module — they substitute the singleton's
  methods directly (or construct a fresh class instance per test).

### Rollback strategy

**No rollback.** F.8 is gated on the migration being complete; the
free-function removal is the final commit. If the migration is not
complete, F.8 is blocked.

### Parallelizable

**No.** F.8 is the close-out phase; it must run last.

---

## Summary: phase dependency graph

```
H.1 (LoggerLike) ─────────────────────────┐
                                          │
H.3 (LazyBin) ──────────┐                 │
                        │                 │
framework A1 (MemoryStore) ──┐            │
                            │             │
F.1 ── F.2 ── F.3 ── F.4 ── F.5 ── F.6 ── F.7 ── F.8
                                │             │
                                │             │
                                └──────┬──────┘
                                       │
                              (both depend on H)
```

- F.1: independent (blocked on framework A1 only if MemoryStore lands
  first; otherwise takes the `runDecaySweep` free function via shim).
- F.2: independent (parallel to F.1).
- F.3: independent (parallel to F.1, F.2).
- F.4: independent (parallel to F.1, F.2, F.3).
- F.5: independent (parallel to F.1-F.4).
- F.6: blocked on H.1; parallel to F.7.
- F.7: blocked on H.3; parallel to F.6.
- F.8: blocked on F.1-F.7 (gated on all migrations complete).

**Total parallelizable surface:** F.1, F.2, F.3, F.4, F.5 can run in
parallel from day one (5-way parallelism). F.6 + F.7 can run in parallel
with each other once H.1 + H.3 land. F.8 runs last.

---

## Coordination with framework phases

| Framework phase | F interaction |
|---|---|
| Phase 1 (H.1 — LoggerLike) | F.6 depends on this. F.1-F.5 land without LoggerLike (free-function `import { logger }` survives). |
| Phase 2 (H.2 — per-class logger injection) | F.6 is the F-side consumer. |
| Phase 3 (H.3 — LazyBin) | F.7 depends on this. |
| Phase 5 (entity stores A1-A12) | F.1's `memory: MemoryStore` parameter depends on A1 if it lands first; otherwise F.1 takes a shim type. |
| Phase 5 (channel providers A13) | None. |
| Phase 5 (lazy-cache singletons C1-C3) | F.2 + F.7 are the F-side implementation of C1 (claude), C2 (google), C3 (graph-mail). The framework's C candidates were deferred to F to formalise. |
| Phase 5 (runners B1-B5) | None for F (B5 covers `web/*-runner.ts`; F's heartbeat is not in B5). |
| Phase 6 (entity stores refactor) | F.1's `memory` parameter updates to the new `MemoryStore` shape if not done in Phase 5. |
| Phase 7 (keystone: `index.ts` → `class App`) | F.8 lands in lockstep with `App` construction. `App.start()` calls `heartbeatScheduler.start()`, `storeWatcher.start()`, `settingsStore.ensureWatching()`. |
| Phase 8 (MD reconciliation) | F's MD refs (`heartbeat.ts:565/566`, `store-watcher.ts:47/60/81`, etc.) must be re-verified post-refactor. |

---

## Risk-adjusted phase recommendation

For a single agent working serially, the recommended order is:

```
1. F.3 (low-medium risk, smallest test-mock surface)
2. F.4 (low-medium risk, largest test-mock surface but mechanical)
3. F.5 (low risk, simplest file)
4. F.2 (medium risk, 2-file change)
5. F.1 (high risk, largest file, most critical)
6. F.6 (medium risk, depends on H.1)
7. F.7 (low risk, depends on H.3)
8. F.8 (gated close-out)
```

For multiple agents working in parallel, the recommended grouping is:

```
Group A: F.1 (heartbeat — serial within)
Group B: F.2 + F.3 + F.4 + F.5 (lazy-cache + watchers + decision — 4-way parallel)
Group C: F.6 (LoggerLike — depends on H.1)
Group D: F.7 (LazyBin — depends on H.3)
Group E: F.8 (close-out — depends on everything)
```

Groups A, B can run concurrently. Group C, D land after H.1, H.3
respectively. Group E runs last.
