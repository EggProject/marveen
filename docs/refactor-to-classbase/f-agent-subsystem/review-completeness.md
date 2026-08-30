# Plan Review — F (agent subsystem) over-engineering & completeness

Review scope: all six F plan documents
(`docs/refactor-to-classbase/f-agent-subsystem/00-summary.md` through
`06-risks-and-mitigations.md`). Source ground-truth verified against
`src/` on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`).

Cross-references applied: framework `review-completeness.md`
(OE-1 to OE-11); `h-cross-cutting/review-completeness.md`
(HOE-1 to HOE-7, HCE-1 to HCE-11); `e-process-lock/review-completeness.md`
(EOE-1 to EOE-5, ECE-1 to ECE-8); `d-channel-provider/review-completeness.md`
(OE-D1 to OE-D5, CE-D1 to CE-D10). Specifically checked: that F does
not re-introduce the single-consumer-namespace-wrapper pattern F.5
brief-override defends, that F's file-watcher inventory is complete,
and that the bun-specific test/timer/fetch differences are surfaced
where they affect the F scheduler classes.

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 2 | 3 |
| Completeness | 1 | 5 | 4 |

**Net assessment: ACCEPT-WITH-EDITS.** F's keystone thesis is sound:
the eight class candidates align with the framework's "singleton-shaped
with module-level mutable state" diagnosis, and the type-side
discipline (LazyCache rejected, HeartbeatObserver rejected,
AutoRestartSchedule<T> rejected) mirrors the E/D verdicts. But the
inventory has one critical miss (`web/federation/config.ts` is a
file-watcher + lazy-cache hybrid with the **identical** fs.watch
pattern as `settings-store.ts`), two major lazy-cache misses
(`web/agent-config.ts` and the in-scope-but-uncoupled
`web/federation/config.ts`), and the `AutoRestartSchedule` class
extraction is a brief-override of `02 §AutoRestart deep-dive` that
does not survive OE-6 scrutiny. Bun-specific fs.watch / setTimeout /
fetch semantics — the dominant runtime differences from
`bun --bun vitest` — are entirely absent from the risk matrix.
F.8's free-function removal gate does not pin a per-class rollback
granularity, and the test-factory design (CE-5 / HCE-7 precedent) is
sketched but not specified.

---

## Over-engineering findings

### OE-F1 (major) — `AutoRestartSchedule` class extraction is a brief-override of `02 §AutoRestart deep-dive`'s "keep free" verdict

**Proposal** (`03-class-boundaries.md` §F8, deviation paragraph):
> "The F brief **overrides** this [it: `02 §AutoRestart deep-dive`'s recommendation]: it asks for `class AutoRestartSchedule` ... The override is defensible because: 1. The framework's `00-summary.md §Top-3 lowest-risk wins` #3 explicitly lists `class AutoRestartSchedule` as a win; F inherits this decision. 2. The two consumers (`web/auto-restart-store.ts:9`, `web/auto-restart-runner.ts:16`) can share one instance via constructor DI in `class App` ... 3. `DEFAULT_AUTO_RESTART` becomes a `readonly` instance field ..."

**Counter-argument.** The override's only technical argument is (2) "the two consumers can share one instance" — but constructor DI in `class App` requires `App` to construct *every* dependency for *every* class, including the pure-function namespace-wrappers. The framework's `review-completeness.md` OE-6 explicitly names "single consumer / no second caller" as the rejection pattern; "two consumers that pass-through free functions" is the same pattern dressed up. The override's argument (1) chains authority ("framework says so") rather than addressing the underlying technical question. Argument (3) is a downside, not an upside — `DEFAULT_AUTO_RESTART` as a module-level `const` is the simplest possible shape; promoting it to a class field is ceremony.

Per `01 §Per-file inventory` row `auto-restart.ts`: "Pure utility module — confirmed". Per `02 §AutoRestart deep-dive`: "the module is dependency-free so the due-decision is unit-testable without a clock, tmux, or the filesystem". The 122-line file has **zero** module-level `let`s, **zero** logger call sites, **zero** unsafe casts. A class extraction adds an instance for zero behavioural change.

The brief override also introduces **new** methods that don't exist today (`decideShouldRestart(facts): AutoRestartDecision`, `decideInterval(state): number`, `getConfig()` — see `03 §F8` method-by-method). These are speculative additions: no consumer today reads them, no test exercises them. The new `AutoRestartDecision` discriminated union (`{ kind: 'due' } | { kind: 'not-due' }`) is invented as part of F.5, three years into the codebase's life, with zero identified consumers. This is the textbook OE-6 speculative-addition pattern.

**Severity: wasteful.** Drop F.5. Keep `auto-restart.ts` as free functions (per `02 §AutoRestart deep-dive`). If the framework's `00-summary.md §Top-3 lowest-risk wins` #3 insists on a class, that list is wrong — the framework's own OE-6 lesson contradicts it.

---

### OE-F2 (major) — `HeartbeatWorkerCwdBuilder` as a separate class from `HeartbeatScheduler` doubles DI surface for 145 lines

**Proposal** (`03-class-boundaries.md` §F2):
> "The 145-line `ensureHeartbeatWorkerCwd` body has nothing to do with scheduling; it's pure file-system plumbing with one macOS-Keychain side effect. The split: makes the scheduler testable without a real `~/.claude/` tree (the cwd builder can be a mock). Makes the cwd builder testable without a real scheduler (it has no timer state). Surfaces the macOS-Keychain dependency at a class boundary instead of buried inside a 600-line file."

**Counter-argument.** The 145-line `ensureHeartbeatWorkerCwd` is invoked exactly once per `executeHeartbeat()` call (at `heartbeat.ts:530-545` per the dataflow). The "independently testable" benefit requires a real `~/.claude/` tree mock anyway (per the F.1 test coverage requirement: *"HeartbeatWorkerCwdBuilder with a stubbed `execFileSync` does not touch Keychain"*) — which is the same setup a mock on the free function provides. The "scheduler testable without cwd builder" benefit is one constructor parameter.

The 145-line figure includes 41 lines of `lstatSyncSafe` (`:223-263`) and 19 lines of `readClaudeCodeOauthJson` (`:265-281`) — both genuinely independent utilities. The remaining 85 lines of `ensureHeartbeatWorkerCwd` body is pure plumbing that doesn't have its own state. The class adds 6 constructor parameters (log + cwd path constants + 4 OS paths) for ~85 lines of pure plumbing.

The "macOS-Keychain dependency" surfacing argument is the strongest, but it's already surfaced: the comment at `heartbeat.ts:265-281` documents the platform check explicitly, and `readClaudeCodeOauthJson` is already a free function with a private `logger.warn` call. The class doesn't add information.

**Severity: wasteful.** Keep `HeartbeatWorkerCwdBuilder` and `HeartbeatScheduler` as **one class** — `HeartbeatScheduler` with the cwd-construction plumbing as a `private ensureCwd()` method. The macOS-Keychain surface stays the same (still a private helper called from `ensureCwd`). The DI surface drops from 6 parameters (cwdBuilder + memory + notifier + calendar + log + settings) to 5 (memory + notifier + calendar + log + settings). Testability is preserved: a mock of `HeartbeatScheduler` still substitutes the whole body.

If the planner insists on the split, accept OE-1's `HeartbeatWorkerCwdBuilder` design — but it should be justified by "the cwd builder is reused by something else" (which today it isn't, but maybe a future heartbeat variant will), not by "it's natural".

---

### OE-F3 (minor) — `decideShouldRestart` / `decideInterval` / `getConfig` new methods on `AutoRestartSchedule` are speculative

**Proposal** (`03-class-boundaries.md` §F8 method-by-method):
> "| `decideShouldRestart(facts)` | n/a (new) | n/a | Brief override: composes `restartDue` into a tagged-union decision ... |"
> "| `decideInterval(state)` | n/a (new) | n/a | Same: composes `dailyDueAtMs`. |"
> "| `getConfig()` | n/a (new) | n/a | Returns the frozen `DEFAULT`. |"

**Counter-argument.** These three methods don't exist today and have zero identified consumers. `decideShouldRestart(facts: RestartFacts): AutoRestartDecision` composes `restartDue` (which already exists) — composition that the caller can do itself in 3 lines. `decideInterval(state)` composes `dailyDueAtMs` — same. `getConfig()` returns the frozen `DEFAULT` — the runner reads `DEFAULT_AUTO_RESTART` directly today (per `web/auto-restart-runner.ts:16`).

If F.5 lands (per OE-F1's analysis it shouldn't), these three methods should be dropped — they are pure additions with no consumer. The brief override's "composability" justification is not load-bearing; the runner can compose on its own.

**Severity: wasteful.** Drop `decideShouldRestart`, `decideInterval`, and `getConfig` from F.5's class surface. The class is a namespace-wrapper for the existing five pure functions; no new methods.

---

### OE-F4 (minor) — `Notifier` interface added for single consumer (`notifyTelegram`)

**Proposal** (`04-generic-interfaces.md` §5):
> ```ts
> type Notifier = (text: string) => Promise<void>
> ```
> "The `Notifier` shape is a one-line type alias with one consumer (`heartbeat.ts:554`'s `notifyTelegram`). Adding an interface adds a named type with no benefit over the alias."

**Counter-argument.** The plan correctly diagnoses this as a one-line alias with one consumer and **proposes the alias** (`type Notifier = (text: string) => Promise<void>`). The verdict is "SPE — speculative type alias, not a new interface." This is the right call. The alias survives as long as the one consumer reads it positionally; if a second consumer materialises, the alias becomes a named interface then. Same pattern as D's `Notifier` (which is also a type alias).

The plan does flag this as speculative and correctly rejects the interface form. Listing here only because the alias introduction itself is at the OE-6 boundary — keep the alias until a second consumer materialises.

**Severity: neutral.** No change; flagged because the alias is at OE-6's threshold and should be revisited if no second consumer emerges by F.8.

---

### OE-F5 (minor) — `Watcher` callback signature `WatchHandler` introduced as named type for single-store consumer

**Proposal** (`04-generic-interfaces.md` §6):
> ```ts
> type WatchHandler = (event: { rel: string; kind: 'create' | 'delete' | 'update'; fileSize: number | null; actor: string | null }) => void
> ```

**Counter-argument.** `03 §F3` introduces `StoreWatcher.onChange(handler: WatchHandler)` as a new public method. Today the watch callback is a private closure at `store-watcher.ts:95-145` that calls `logStoreFileEvent` directly. The new surface exposes the dedup'd event to external consumers — but `03 §F3` itself notes *"consumers (none today)"*. So `WatchHandler` is a 4-field named type with **zero current consumers**.

The `onChange(handler)` API is speculative per OE-6: a new public method with no caller. Same pattern rejected for `RemoteStatusCache<T>`'s `list()` (per framework OE-6) and `ChannelProviderRegistry.list()` (per OE-D2).

**Severity: wasteful.** Drop `onChange(handler)` from `StoreWatcher`'s public surface. Keep the watch callback as a private closure inside the class. If a future consumer materialises, the `onChange` API is added in that commit, not pre-emptively.

---

## Completeness findings

### CE-F1 (critical) — `web/federation/config.ts` is a fs.watch + lazy-cache hybrid with the IDENTICAL pattern as `settings-store.ts`, but F plan does not mention it

**Missing area.** `src/web/federation/config.ts:215` declares `let cachedConfig: FederationConfig | null = null`, `:217` declares `let watcher: FSWatcher | undefined`, and `:241-252` defines `ensureWatching()` — the **exact** same pattern as `settings-store.ts:17/18/46-56`. The inline comment at `:209-214` even names the precedent: *"settings-store pattern: lazy watch on the store DIRECTORY ({persistent: false} so vitest workers are not held open; mkdir first because fs.watch throws on a missing dir) ..."*

**Why it matters.** This file satisfies F's inventory criterion for `SettingsStore`-shape extraction:
- 2 module-level `let`s (`cachedConfig`, `watcher`)
- `ensureWatching()` idempotent guard with the identical failure mode (HMR / `vi.resetModules` re-import would leak the fs.watch handle)
- `loadConfigFromDisk()` is the disk-read helper, parallel to `settings-store.ts:loadFromDisk()`
- `getFederationConfig()` is the public accessor, parallel to `settings-store.ts:getEffectiveSettingValue`

The federation/ subdirectory was flagged as CE-D1's critical miss in `d-channel-provider/review-completeness.md`. F inherits the same gap (CE-D1 mentioned "federation/poller.ts" but not the config.ts lazy-cache). The plan's `01 §Per-file inventory` lists only `store-watcher.ts` and `settings-store.ts` as fs.watch concerns; `web/federation/config.ts` is missed.

The plan does say at `01 §Startup ordering in index.ts today` that F is downstream of E and "every shutdown is coordinate from `index.ts`". The federation config watcher is wired into the same boot/shutdown sequence at `web.ts` — touching it during a class refactor is exactly the kind of cross-cutting concern F needs to enumerate (even if it ends up "explicitly out of scope, see web/federation/").

**Severity: critical.** Add `web/federation/config.ts` to F's inventory explicitly: either (a) extend F.3/F.4 to cover the federation config watcher (with the same `private readonly FSWatcher` + singleton assertion pattern), OR (b) document the exclusion in `00-summary.md` "Files this plan does NOT touch" with the rationale ("federation is a web/ subsystem; the federation-config class extraction belongs to a future web/ subsystem refactor"). Option (b) is the lower-risk path because (a) touches a file outside F's primary file list.

---

### CE-F2 (major) — `web/agent-config.ts:79` `cachedProfileMap` is a mtime-invalidated lazy-cache that F's lazy-cache cluster misses

**Missing area.** `src/web/agent-config.ts:79` declares `let cachedProfileMap: { state: ModelProfileMapState; mtimeMs: number } | null = null`. The `readModelProfileMap()` function at `:81-97` follows the **exact** invalidation pattern as `google-api.ts:cachedTokens` and `graph-mail.ts:cachedCreds`: `if (cached && cached.mtimeMs === currentMtime) return cached.state; else re-read + parse + mutate`. There is also an `invalidateModelProfileMapCache()` function (`:line 99+`) parallel to F's proposed `GoogleApiClient.invalidate()`.

**Why it matters.** F's `04 §1 LazyCache<K, V> REJECTED` analysis correctly enumerates the three lazy-cache consumers: `agent.ts:cachedClaudeCodeBin` (process-lifetime), `google-api.ts:cachedTokens` (mtime-invalidated), `graph-mail.ts:cachedCreds` (mtime-invalidated + clientId). But `web/agent-config.ts:cachedProfileMap` is a **fourth** lazy-cache that was not enumerated. The plan's "3 cache consumers → `LazyCache<K, V>`" argument (per the brief) was incomplete; there are 4.

If `LazyCache<K, V>` were the goal (it was rejected), the rejection rationale now has a stronger case (4 caches with even more divergence). If the rejection is correct, `web/agent-config.ts` is still a class candidate that F missed.

**Severity: major.** Add `web/agent-config.ts` to F's inventory: (a) extend F.2 to cover `cachedProfileMap` (and its `invalidateModelProfileMapCache()` API), OR (b) document the exclusion with the rationale ("web/agent-config.ts is a web/ subsystem; the cache extraction belongs to a future web/ refactor"). The file has 4 production importers (`web/agent-scaffold.ts`, `web/agent-process.ts`, etc.) so the class extraction is non-trivial if pursued.

---

### CE-F3 (major) — Bun-specific `fs.watch` semantics differences not addressed in FR2's mitigation

**Missing area.** FR2 (`06-risks-and-mitigations.md`) correctly identifies the double-`fs.watch` hazard under HMR / `vi.resetModules` and proposes a class form with a `private readonly FSWatcher` field. The mitigation is sound. But the plan does **not** enumerate bun-specific `fs.watch` behaviour:

- `settings-store.ts:50` uses `watch(STORE_DIR, { persistent: false })` — bun's `fs.watch` may interpret `persistent: false` differently from Node (per bun docs, `persistent: false` lets the process exit when the event loop empties, but bun's event-loop semantics differ).
- `store-watcher.ts:95` uses `watch(STORE_DIR, { recursive: true })` — bun's `fs.watch` `recursive: true` is **not** supported on Linux as of bun 1.x (it returns `ENOSYS`); the plan doesn't verify what bun does.
- `web/federation/config.ts:245` uses `watch(storeDir, { persistent: false })` — same `persistent: false` concern as settings-store.

Per CLAUDE.md §8 the canonical test runner is `bun --bun vitest run`, which means the watchers are exercised under bun, not Node. If bun's `fs.watch` returns `ENOSYS` on `recursive: true` (per Node's behaviour), `store-watcher.ts` silently fails to watch anything on a Linux CI machine.

**Why it matters.** CE-D7 (`d-channel-provider/review-completeness.md`) and HCE-10 (`h-cross-cutting/review-completeness.md`) both flag the bun-vitest factory-hoisting concern. F inherits the same exposure but does not enumerate it. The `recursive: true` concern is **specifically F's domain** because two of the three watchers use it.

**Severity: major.** Add an "FR2.b" risk row to `06-risks-and-mitigations.md`: "Bun's `fs.watch(STORE_DIR, { recursive: true })` may diverge from Node's on Linux; verify the existing `store-watcher.test.ts` regression passes under `bun --bun vitest run` before F.3 lands. The `persistent: false` flag in `settings-store.ts:50` and `web/federation/config.ts:245` may also diverge."

---

### CE-F4 (major) — Bun-specific `setTimeout`/`setInterval` semantics for `HeartbeatScheduler` not addressed

**Missing area.** `heartbeat.ts:569` uses `setTimeout(async () => { await executeHeartbeat(); ...; scheduleNext(nextDelayMs) }, delayMs)` — a self-rescheduling timer. `index.ts:371-373` declares `decayInterval`, `digestTimer`, `digestInterval` as `NodeJS.Timeout | null`. All four timer registrations interact with bun's event loop on `bun --bun vitest run` and on production if the heartbeat ever runs under bun (currently it runs under Node per the package.json scripts).

The plan correctly notes (per `01 §heartbeat.ts deep-dive`) that `scheduleNext` re-arms from inside the callback. But the plan does not enumerate:

- Bun's `setTimeout(fn, 0)` minimum granularity (Node's is 1ms; bun's is implementation-defined)
- Bun's `unref()` / `ref()` semantics for the heartbeat timer (heartbeat.ts does NOT call `unref()`, so the timer holds the event loop open — correct)
- Bun's `setImmediate` interleaving with `setTimeout` (the plan's `scheduleNext` relies on `await executeHeartbeat()` finishing before the recursion — under bun, microtask ordering may differ)

The framework `review-completeness.md` CE-17 flags bun-runtime differences. The `e-process-lock/review-completeness.md` ECE-5 (minor) flags the same concern for `process-lock.ts:298-361`. F's heartbeat timer is the most critical F-state and has the highest exposure.

**Why it matters.** If bun's `setTimeout` granularity diverges from Node's during the heartbeat's window-check (`msUntilNextHeartbeat`), the timer fires at a different cadence. The existing `heartbeat.test.ts` regressions assume Node's granularity. The plan does not verify behaviour under bun.

**Severity: major.** Add a detection signal to FR1: "A test that constructs `HeartbeatScheduler` and asserts the next-tick delay after `msUntilNextHeartbeat()` is honoured to within 1ms verifies both the math AND the timer cadence. The existing `heartbeat.test.ts` regressions cover the math; the cadence is currently unverified under bun." This is the same hygiene as ECE-5 but for F's specific timer shape.

---

### CE-F5 (major) — F-to-F shutdown order in `index.ts:378-410` not characterized in the plan

**Missing area.** The plan correctly notes (per `01 §Startup ordering in index.ts today`) that F is downstream of E and "every shutdown is coordinate from `index.ts`". But the plan does **not** enumerate the F-to-F shutdown order, which is a constraint the class extraction must preserve. The actual shutdown sequence at `index.ts:383-389`:

```ts
try { stopHeartbeat() } catch ...
try { stopInviteMonitor() } catch ...
try { stopChannelRequestWatcher() } catch ...
try { stopStoreWatcher() } catch ...
if (decayInterval) clearInterval(decayInterval)
if (digestTimer) clearTimeout(digestTimer)
if (digestInterval) clearInterval(digestInterval)
```

The user's prompt characterized this as "heartbeat → inviteMonitor → storeWatcher → decayInterval → digestTimer → digestInterval" — but the actual sequence includes `stopChannelRequestWatcher` between `stopInviteMonitor` and `stopStoreWatcher` (F missed one element). The plan's `06 §FR1` mentions `heartbeat.ts:594` for `stopHeartbeat()` and `01 §heartbeat.ts deep-dive` mentions the self-rescheduling pattern, but no F plan document characterizes the shutdown ordering between `HeartbeatScheduler` and `StoreWatcher`.

**Why it matters.** F's class extraction introduces `heartbeatScheduler.stop()` and `storeWatcher.stop()` methods that must be called in the same order. If the App keystone (D3 / Phase 7) calls `heartbeatScheduler.stop()` after `storeWatcher.stop()` (reversed), the in-flight heartbeat tick may still be writing to the store while the store watcher is closed — a race condition that does not exist today because the free functions preserve the order.

The plan does not say which subsystem's stop() depends on which. Today the free functions have no such dependency (each is independent), but the class form introduces a new dependency: `HeartbeatScheduler` (per `01 §heartbeat.ts deep-dive`) reads `getEffectiveSettingValue` (via `SettingsStore`) at every `msUntilNextHeartbeat()` call. If `SettingsStore.stop()` is called before `HeartbeatScheduler.stop()`, the heartbeat's next-schedule window-check fails silently.

**Severity: major.** Add a "F-to-F shutdown ordering" subsection to `01 §Startup ordering in index.ts today` documenting the actual sequence (`stopHeartbeat → stopInviteMonitor → stopChannelRequestWatcher → stopStoreWatcher → decayInterval → digestTimer → digestInterval`), with a one-line constraint: "`HeartbeatScheduler.stop()` must fire before `SettingsStore` is destroyed (or `SettingsStore.getEffectiveSettingValue` must remain available during heartbeat's next-schedule check)." This is the framework M11 constraint the user noted; the plan should pin it.

---

### CE-F6 (major) — F.6 + F.7's LoggerLike/LazyBin migrations depend on `bun --bun vitest` `vi.mock` factory hoisting; not verified

**Missing area.** F.6 introduces LoggerLike into 6 of the 7 F classes (`HeartbeatScheduler`, `HeartbeatWorkerCwdBuilder`, `StoreWatcher`, `SettingsStore`, `GoogleApiClient`, `GraphMailClient` — `ClaudeCodeBinResolver` doesn't take a logger). F.7 introduces `LazyBin<'claude'>` for `ClaudeCodeBinResolver`. Together, F.6 + F.7 touch **20+ test mocks** (`vi.mock` for `heartbeat.js`, `store-watcher.js`, `settings-store.js`, `google-api.js`, plus the `vi.resetModules()` cycle for `graph-mail.js`).

Per `h-cross-cutting/review-completeness.md` HCE-10 and CE-17, `bun --bun vitest`'s `vi.mock` factory-hoisting semantics may differ from Node-vitest. F inherits this exposure but does not enumerate it. The 20+ mock sites are the largest single mock-churn surface in any one subsystem.

**Why it matters.** F.6's `HeartbeatScheduler` constructor takes `log: LoggerLike`. Today, tests mock `vi.mock('../heartbeat.js', ...)` to substitute the entire module. After F.6, tests need to either (a) continue substituting the module (the free wrapper survives through F.8), or (b) construct `new HeartbeatScheduler(mockLog, ...)` directly. The factory-hoisting behaviour determines whether option (a) keeps working — if bun hoists the `vi.mock('../logger.js', ...)` AFTER the `HeartbeatScheduler` import in the test file, the constructor-injected logger is the real pino, not the mock.

The plan's FR6 mitigation correctly enumerates the mock counts (1 + 4 + 13 + 2 + 0 + 0 = 20 sites) but does not verify factory-hoisting under bun.

**Severity: major.** Add a detection signal to FR6: "All 20+ mock sites pass `bun --bun vitest run`. The mock-seam survival depends on factory-hoisting behaviour that may differ between Node-vitest and bun-vitest; verify with the test fixture at `src/__tests__/heartbeat.test.ts:90` (the only `vi.mock` for `google-api.js` from a non-`index.test.ts` context)."

---

### CE-F7 (major) — Test factory design for `HeartbeatScheduler` is sketched but not specified (CE-5 / HCE-7 lesson applies)

**Missing area.** `06-risks-and-mitigations.md §Test factory design` shows:

```ts
function makeHeartbeatScheduler(opts?: Partial<HeartbeatOpts>): HeartbeatScheduler {
  return new HeartbeatScheduler(
    new HeartbeatWorkerCwdBuilder(mockLog),
    new MemoryStore(':memory:'),
    mockNotifier,
    new GoogleApiClient(mockLog, mockHomedir),
    mockLog,
    new SettingsStore(mockLog),
  )
}
```

The factory has **6 constructor parameters**, three of which are themselves constructed classes. Per the framework `review-completeness.md` CE-5 and HCE-7, the factory must specify:

1. Whether the factory takes options or is fixed-shape
2. Whether assertions use `.toHaveBeenCalled()` per-method or a single "any-call" helper
3. Whether the factory returns a fresh object per call or memoises
4. Whether the factory is exported from `src/__tests__/_factories.ts` (new file) or lives per-test
5. What the convention does for `bun --bun vitest`'s module-resolution differences

The plan addresses none of the five. The factory sketch is the right shape, but without a specification document, the first 5-10 tests define the convention by accident and the remaining 10-15 copy it.

**Why it matters.** Per HCE-7, *"the plan itself does not write it down. The first 5-10 conversions will write it down by accident; the remaining 80-85 will copy whatever the first 5-10 chose. If the convention is missing the five details above, the convention is 5 things, not 1."* The same applies to F's test factory.

**Severity: major.** Add a "Test factory specification" subsection to `06-risks-and-mitigations.md` addressing the five bullets above, in the same style as `04-generic-interfaces.md §L Sketch`. Format: ~30 lines of code block plus a one-paragraph rationale. F inherits the CE-5 / HCE-7 lesson.

---

### CE-F8 (minor) — `graph-mail.ts` has 0 production importers; F.2 still proposes a class

**Missing area.** Per `01 §Per-file inventory` row `graph-mail.ts`: "**Zero prod importers** — module is wired only into tests." F.2 still proposes `class GraphMailClient` for it. The plan's `03 §F7 Lifecycle` justifies the class extraction: *"The class is constructed only by tests ... Production wiring is absent as of 2026-08-30. The class form does not change this — it just makes the test seam cleaner."*

**Why it matters.** A class with zero production consumers is exactly the OE-6 single-consumer pattern. F.2's justification ("just makes the test seam cleaner") is the test-side-only rationale that EOE-1 (in `e-process-lock/review-completeness.md`) rejected for `release()` no-ops: a no-second-consumer in production is pure ceremony. If F.2 lands, every `await import('../graph-mail.js')` cycle in `graph-mail.test.ts` becomes `new GraphMailClient(mockLog)` — 9 sites per `01 §Per-file inventory`. The class adds zero behaviour change and zero new consumer; the test seam was the free function's free-function form.

**Severity: minor.** Drop F.2's `GraphMailClient` class extraction. Keep `graph-mail.ts` as free functions. If a future consumer materialises, the class can be added in that commit. The framework's own OE-6 lesson applies.

---

### CE-F9 (minor) — `index.ts:541-552` reference is approximate; the actual heartbeat init is at `:541-552` and the timers are at `:371-376`

**Missing area.** The plan references `index.ts:541-552` as the boot-time heartbeat init location (per `00 §Dependency` table). Verified: `index.ts:541-552` is the actual region where `initHeartbeat()` and the boot-time store-watcher init happens.

The user's prompt also references `index.ts:371-376` for the timers. Verified: `index.ts:371-373` declares `decayInterval`, `digestTimer`, `digestInterval`; `:374-376` is `webServer`, `shuttingDown`, `exitCode`. The plan's `00 §Dependency` table does not characterise the timer block precisely.

**Why it matters.** Per CLAUDE.md §8, file:line references must be re-verified before commit. The plan has 80+ file:line references across the six documents; the existing references are mostly accurate (verified), but `:541-552` and `:371-376` are approximate ranges that include surrounding lines.

**Severity: minor.** No code change needed. Flagged so that when F.8 / Phase 8 reconciliation runs, the line refs are pinned to exact lines.

---

### CE-F10 (minor) — Heartbeat logger call count: plan claims 17, actual is 18 lines (or 17 calls if multi-line is one call)

**Missing area.** `02 §Per-file type audit` claims "**18** (counted: 17 — 576-577 is one call spanning two source lines)" for `heartbeat.ts`. Verified `grep -nE "logger\.(info|warn|error|debug)" heartbeat.ts | wc -l` = 18 lines. The discrepancy is whether multi-line calls count as 1 or 2:

- L576-579 is a 4-line `logger.info(...)` call (one call, four source lines)
- L587-590 is a 4-line `logger.info(...)` call (one call, four source lines)

If multi-line calls count as 1, the count is 17 (correct). If lines count, the count is 18 (plan's "counted" annotation is wrong by 1).

**Why it matters.** The F.6 migration's logger-call-site count drives the test-factory estimate and the per-class rollup. A 1-site drift is negligible for execution but visible in audits.

**Severity: minor.** No code change needed. Re-verify the count via `grep -cE` (which counts lines) vs `grep -nE | wc -l` (also counts lines) vs the call-level count (which counts calls). Pick one and document it in `02 §Per-file type audit`.

---

### CE-F11 (minor) — `AutoRestartConfig` consumers cross-cut web/agent-process.ts and web/agent-scaffold.ts; the runner is the only dual-importer

**Missing area.** The plan's `01 §Per-file inventory` row `auto-restart.ts` cites 2 production importers: `web/auto-restart-runner.ts:16` and `web/auto-restart-store.ts:9`. The actual import chain (verified) is:

- `web/auto-restart-runner.ts:16` imports `restartDue, dailyDueAtMs, parseHHMM, mainRestartMechanism, type AutoRestartConfig` from `../auto-restart.js`
- `web/auto-restart-store.ts:8-9` imports `normalizeAutoRestartConfig, type AutoRestartConfig` from `../auto-restart.js`

The plan's count (2) is correct. But `web/routes/marveen.ts` and `web/routes/agents.ts` import `readAutoRestartConfig` and `writeAutoRestartConfig` from `web/auto-restart-store.js` (not from `auto-restart.js` directly) — they are *indirect* consumers via the store. F.5's class surface (`AutoRestartSchedule`) is consumed only by the two direct importers.

**Why it matters.** If F.5 lands, the class wrapper has exactly 2 direct production consumers. The "two consumers share one instance via constructor DI" argument (per OE-F1) is the upper-bound justification. Below 2, OE-6 fires.

**Severity: minor.** No code change needed. Flagged to pin the 2-consumer threshold: if `web/auto-restart-store.ts` or `web/auto-restart-runner.ts` migrate to a different config source, F.5's class collapses to a single consumer.

---

### CE-F12 (minor) — `heartbeat.ts:601` re-export seam `export { collectData, shouldNotify, buildAgentPrompt, executeHeartbeat }` is the test seam, but F.1's class surface keeps them as `public readonly` methods via singleton wrapper

**Missing area.** Per `03 §F1` "Free functions that REMAIN after F.1": *"Re-exported at `:601` for tests. The class version makes them `public readonly` methods so the same test import path works through the singleton wrapper."* The singleton wrapper shape is `() => singleton.execute()`. But the free-function re-export at `:601` re-exports `collectData`, `shouldNotify`, `buildAgentPrompt`, `executeHeartbeat` — not `initHeartbeat` or `stopHeartbeat`. The class surface maps `executeHeartbeat` → `singleton.execute()` cleanly; for `collectData`, `shouldNotify`, `buildAgentPrompt` (which are public readonly methods on the class), the singleton wrapper has to expose them too — but the plan does not specify the wrapper shape for these three.

**Why it matters.** If a test imports `collectData` from `../heartbeat.js` and the free-function wrapper does not exist for it, the test breaks. The plan correctly identifies the re-export at `:601` but does not say which methods the singleton wrapper exposes beyond `execute()`.

**Severity: minor.** Add to `03 §F1` "Free functions that REMAIN after F.1" a note: *"The singleton wrapper exposes `singleton.collectData`, `singleton.shouldNotify`, `singleton.buildAgentPrompt`, `singleton.execute` as free-function exports — all four re-exported at `:601`. `init` / `stop` are not re-exported (today's `initHeartbeat` / `stopHeartbeat` are NOT in the `:601` re-export block, so the wrapper shape for these is new)."* This pins the singleton wrapper surface.

---

## Cross-cutting risk: bun-specific test patterns (CE-17 inheritance)

Per `review-completeness.md` CE-17, bun's runtime differs from Node in:
- Module resolution (bun uses its own loader)
- Stack frame format
- `instanceof` semantics
- `Error.captureStackTrace` support

F inherits this exposure across FR2 (fs.watch), FR4 (timer cadence), and FR6 (vi.mock factory hoisting). The plan's `06 §Bun-specific test patterns` section acknowledges CE-17 but only addresses `instanceof` and `Error.captureStackTrace` — it does not address fs.watch or setTimeout/setInterval differences, which are the dominant F concerns.

**Severity: minor.** Extend `06 §Bun-specific test patterns` to enumerate:
- bun's `fs.watch(STORE_DIR, { recursive: true })` behaviour on Linux (returns `ENOSYS` in Node; bun's status not verified)
- bun's `setTimeout(fn, 0)` minimum granularity
- bun's `vi.mock` factory-hoisting order

---

## Net assessment

F's keystone thesis is correct:
- **The 8 class candidates** are appropriate. `HeartbeatScheduler`, `HeartbeatWorkerCwdBuilder`, `StoreWatcher`, `SettingsStore`, `ClaudeCodeBinResolver`, `GoogleApiClient`, `GraphMailClient` are all singleton-shaped with module-level mutable state, and the class extraction is mechanical.
- **The lazy-cache cluster analysis** correctly identifies 3 invalidation patterns (mtime, mtime+clientId, manual) and rejects the `LazyCache<K, V>` shared base on OE-6 grounds. The 3 concrete classes land independently.
- **The type-side discipline** is exemplary: 13 candidate generics are evaluated and rejected with explicit rationale, mirroring the E and D verdicts. The `HeartbeatObserver<TDecision>` speculative observer pattern is correctly rejected.
- **The F-to-H dependency** is correctly characterized (F.6 cannot land before H.1, F.7 cannot land before H.3).
- **The CE-7 adjacent prompt-builder** (`web/heartbeat-agent-scaffold.ts`) is correctly excluded from F scope.
- **The test-mock seam preservation** through F.1-F.8 (FR6) is the right migration pattern.

But the plan has two over-engineering seams and seven completeness gaps:

**Over-engineering:**

- `AutoRestartSchedule` class extraction is a brief-override of `02 §AutoRestart deep-dive` that does not survive OE-6 scrutiny (OE-F1).
- `HeartbeatWorkerCwdBuilder` as a separate class doubles DI surface for 85 lines of pure plumbing that has no consumer beyond `HeartbeatScheduler` itself (OE-F2).
- `decideShouldRestart` / `decideInterval` / `getConfig` are speculative additions introduced AS PART OF F.5 (OE-F3).
- `Notifier` type alias and `Watcher` callback signature are at OE-6's threshold (OE-F4 neutral, OE-F5 wasteful).

**Completeness:**

- **`web/federation/config.ts`** has the IDENTICAL fs.watch + lazy-cache pattern as `settings-store.ts` and is completely missed (CE-F1 critical).
- **`web/agent-config.ts:79`** `cachedProfileMap` is a 4th lazy-cache missed (CE-F2 major).
- Bun-specific `fs.watch` / `setTimeout` / `vi.mock` factory-hoisting semantics are absent from the risk matrix (CE-F3, CE-F4, CE-F6 major).
- F-to-F shutdown order at `index.ts:383-389` is not characterized (CE-F5 major).
- Test factory design (CE-5 / HCE-7 lesson) is sketched but not specified (CE-F7 major).
- `graph-mail.ts` class extraction has zero production consumers (CE-F8 minor).
- Various minor: line refs approximate (CE-F9), logger count (CE-F10), consumer count (CE-F11), re-export wrapper shape (CE-F12).

**Recommendation: ACCEPT-WITH-EDITS.**

**Drop before executing:**
- F.5 `AutoRestartSchedule` class extraction (OE-F1) — keep `auto-restart.ts` as free functions per `02 §AutoRestart deep-dive`.
- F.5's `decideShouldRestart` / `decideInterval` / `getConfig` (OE-F3) — moot if F.5 lands.
- `StoreWatcher.onChange(handler: WatchHandler)` from F.3 public surface (OE-F5).
- F.2's `GraphMailClient` class extraction (CE-F8) — keep `graph-mail.ts` as free functions.

**Fold before executing:**
- `HeartbeatWorkerCwdBuilder` into `HeartbeatScheduler` as a `private ensureCwd()` method (OE-F2).

**Enumerate before executing:**
- `web/federation/config.ts` in `00-summary.md` "Files this plan does NOT touch" with rationale (CE-F1 critical).
- `web/agent-config.ts:cachedProfileMap` similarly (CE-F2).
- Bun-specific `fs.watch` / `setTimeout` / `vi.mock` factory-hoisting in `06-risks-and-mitigations.md` (CE-F3, CE-F4, CE-F6).
- F-to-F shutdown order in `01 §Startup ordering in index.ts today` (CE-F5).
- Per-class rollback granularity for F.8's free-function removal (the gate `grep -rln "..." src/` returns only the wrapper file is the only specification).

**Specify before executing:**
- Test factory specification per CE-5 / HCE-7 (CE-F7).
- Singleton wrapper surface for `collectData` / `shouldNotify` / `buildAgentPrompt` (CE-F12).

**Re-verify before executing:**
- Logger call-site count (CE-F10): pin to 17 calls (multi-line counted as 1) or 18 lines, document the convention.
- 2-consumer threshold for `AutoRestartSchedule` if F.5 lands (CE-F11).
- Line refs at `index.ts:541-552` (boot), `:371-373` (timer declarations), `:383-389` (shutdown order) (CE-F9).

---

## Verification provenance

Every file:line reference in this review was read against the
working tree on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`):

- `src/heartbeat.ts:1-601` (read in full; 17 logger calls across 18
  source lines, 2 module-level `let`s at L565-566, recursive
  `setTimeout` at L569, macOS Keychain `execFileSync` at L268,
  re-export seam at L601).
- `src/store-watcher.ts:1-160` (read in full; 3 module-level `let`s
  at L47/60/81, `watch(STORE_DIR, { recursive: true })` at L95).
- `src/settings-store.ts:1-111` (read in full; 2 module-level `let`s
  at L17-18, `watch(STORE_DIR, { persistent: false })` at L50).
- `src/auto-restart.ts:1-122` (read in full; zero module-level
  `let`s, 5 pure functions, `DEFAULT_AUTO_RESTART` at L48-54).
- `src/agent.ts:1-216` (read in full; 1 module-level `let` at L81,
  5 unsafe casts at L178-179/182/194).
- `src/google-api.ts:1-211` (read in full; 3 module-level `let`s at
  L51/52/108, single-flight `refreshInFlight` at L108-118).
- `src/graph-mail.ts:1-263` (read in full; 2 module-level `let`s at
  L68/132, zero production importers).
- `src/web/federation/config.ts:1-393` (read in full; module-level
  `let cachedConfig` at L215, `let watcher` at L217, `ensureWatching`
  at L241-252 — the file F missed).
- `src/web/agent-config.ts:60-105` (read; `cachedProfileMap` at L79,
  `readModelProfileMap` at L81-97 — the 4th lazy-cache F missed).
- `src/index.ts:365-416` (read; shutdown sequence at L383-389,
  timer declarations at L371-373).
- `src/platform.ts:75` (`cached: string | null = null` — H's
  `LazyBin` consumer, not in F scope).
- 6 cross-cutting lessons applied: framework OE-6 (single-consumer
  generic, applied via OE-F1, CE-F8); framework OE-4 (speculative
  shape-parity, applied via OE-F2, OE-F5); framework CE-1 (class
  inventory, applied via CE-F1, CE-F2); framework CE-5 + HCE-7 (test
  factory, applied via CE-F7); framework CE-17 (bun-vitest, applied
  via CE-F3, CE-F4, CE-F6); D CE-D1 (federation subdir, applied via
  CE-F1).
- 20+ test mocks counted (1 `heartbeat.js` + 4 `store-watcher.js`
  + 13 `settings-store.js` + 2 `google-api.js` + 0 `graph-mail.js`
  + 0 direct `auto-restart.js`) — verified.