# F (agent subsystem) — Class boundaries

Concrete class candidates for the F subsystem. Signatures only; no
implementation. Every claim below cites a file:line verified against
`src/` on 2026-08-30.

**Reading note.** Eight class candidates, organised in three clusters:
scheduler + watcher (3 classes), lazy-cache cluster (3 classes),
decision utility (1 class), and a worker-cwd builder split out from
the scheduler (1 class). `auto-restart.ts`'s class extraction is a brief
override of the `02 §AutoRestart deep-dive` recommendation (which
advised keeping it free) — see the F-class cluster notes. Each class
keeps its existing free-function wrappers for the migration window;
the gate for removal is in `05-refactor-roadmap.md §F.8`.

---

## Class candidate inventory

| # | Class | New? | Migration source | Phase |
|---|---|---|---|---|
| 1 | `HeartbeatScheduler` | new | `heartbeat.ts:483-598` (`executeHeartbeat`, `scheduleNext`, `initHeartbeat`, `stopHeartbeat`, `msUntilNextHeartbeat`) | F.1 |
| 2 | `HeartbeatWorkerCwdBuilder` | new | `heartbeat.ts:77-283` (`ensureHeartbeatWorkerCwd`, `lstatSyncSafe`, `readClaudeCodeOauthJson`) — split out from the scheduler | F.1 |
| 3 | `StoreWatcher` | new | `store-watcher.ts:47-160` (3 lets + 4 exports + `scanStore`/`isSystemFile` helpers) | F.3 |
| 4 | `SettingsStore` | new | `settings-store.ts:17-111` (2 lets + 5 exports + `loadFromDisk`/`coerce`/`ensureWatching` helpers) | F.4 |
| 5 | `ClaudeCodeBinResolver` | new (extends `LazyBin`) | `agent.ts:81-100` (`cachedClaudeCodeBin` + `resolveClaudeCodeBin`) | F.7 |
| 6 | `GoogleApiClient` | new | `google-api.ts:51-209` (3 cache cells + 7 helpers + 1 export) | F.2 |
| 7 | `GraphMailClient` | new | `graph-mail.ts:68-263` (2 cache cells + 3 helpers + 4 exports) | F.2 |
| 8 | `AutoRestartSchedule` | new (brief override of `02 §AutoRestart deep-dive`) | `auto-restart.ts:16-122` (3 types + 5 functions + 1 const) | F.5 |

Eight classes total. Zero duplicates across files. The lazy-cache cluster
(5/6/7) shares an invalidation pattern (mtime + manual + clientId) but
each is implemented as an independent concrete class per the
`04-generic-interfaces.md §LazyCache` verdict.

---

## F1. `HeartbeatScheduler`

### Source and migration

- **Source file:** `src/heartbeat.ts` (same file, alongside the free
  functions).
- **Migration source:** the body of `executeHeartbeat` at
  `heartbeat.ts:483-552`, the self-rescheduling `scheduleNext` at
  `:568-580`, the start `initHeartbeat` at `:584-592`, the stop
  `stopHeartbeat` at `:594-598`, and the per-tick collection methods
  `collectCalendar` (`:301-317`), `collectKanban` (`:320-336`),
  `collectSystem` (`:339-355`), `collectData` (`:358-361`), `shouldNotify`
  (`:363-389`), `buildAgentPrompt` (`:392-447`), and the re-exported
  `executeHeartbeat` test seam at `:601`.
- **Cross-class split:** `ensureHeartbeatWorkerCwd` (`:77-221`) and
  the macOS-Keychain side effect at `:265-281` move into the
  `HeartbeatWorkerCwdBuilder` class (F2 below). The scheduler
  constructor takes an instance.

### Public surface (signatures only)

```ts
class HeartbeatScheduler {
  constructor(
    private readonly cwdBuilder: HeartbeatWorkerCwdBuilder,
    private readonly memory: MemoryStore,        // or the free fn via DI shim until A1 lands
    private readonly notifier: Notifier,         // notifyTelegram abstraction; or free fn shim
    private readonly calendar: GoogleApiClient,
    private readonly log: LoggerLike,
    private readonly settings: SettingsStore,    // for getEffectiveSettingValue on HEARTBEAT_START_HOUR / END_HOUR
  )

  init(opts?: HeartbeatOpts): void                // was initHeartbeat
  stop(): void                                    // was stopHeartbeat
  execute(): Promise<void>                        // was executeHeartbeat
  triggerNow(): Promise<void>                     // new: test/manual seam; calls execute() directly
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `init(opts?)` | `initHeartbeat()` | `heartbeat.ts:584-592` | Computes the delay to the next in-window hour via `msUntilNextHeartbeat()` and arms `scheduleNext(delayMs)`. The `opts?` parameter lets a test override the constructor's `SettingsStore` for one call (similar to `PortLockAcquirer.acquire(port, overrides?)` in `e-process-lock/03-class-boundaries.md:42`). Production callers always omit it. |
| `stop()` | `stopHeartbeat()` | `heartbeat.ts:594-598` | Sets an internal `stopped: boolean` flag; clears the in-flight `setTimeout` handle; awaits any in-flight `execute()` promise and cancels it. See FR5 for the cancellation logic. |
| `execute()` | `executeHeartbeat()` | `heartbeat.ts:483-552` | Body unchanged: window check, `memory.runDecaySweep()`, `collectData()`, `shouldNotify()`, `cwdBuilder.ensure()`, `runAgent(...)`, `notifier.notify(text)`. Returns `Promise<void>` — no `HeartbeatTickResult` per the `02 §Heartbeat decision types` verdict. |
| `triggerNow()` | n/a (new) | n/a | Bypasses the window check and runs `execute()` directly. Mirrors today's manual-test re-export of `executeHeartbeat` at `:601`; the class surface gives it a typed name. |

### Constructor

- `(cwdBuilder, memory, notifier, calendar, log, settings)`. Six
  dependencies is high; the free-function shape took them via direct
  imports (`memory.ts:16`, `notifyTelegram`, `getCalendarEvents`,
  `getEffectiveSettingValue`, `logger`). The class form lifts them
  to constructor injection per the framework-wide constructor-DI
  pattern. **Phase ordering:** if framework A1 (`MemoryStore`) lands
  first, `memory` is the instance type; if not, F.1 takes the free
  function via a thin shim type (per `02 §Constructor parameter
  noise` OE-10 critique).
- **No I/O in the constructor.** The class holds the timer handle
  on a private field initialised to `null`. `init()` is the only
  side-effect entry.
- **Logger** is required (per F.6 ordering). The class does NOT
  accept `log: Logger` in its constructor until H.1 lands; before
  H.1, the constructor takes nothing logger-related (the module's
  `import { logger }` keeps working through the migration window).

### Generic params

None. Per `02 §Per-class generics on HeartbeatScheduler`, no type
parameter has a second consumer (`HeartbeatScheduler<TContext>`,
`<TNotifier>` both rejected on OE-6 grounds).

### Dependencies

- `HeartbeatWorkerCwdBuilder` (F2) — constructor-injected.
- `MemoryStore` (or the `runDecaySweep` free function shim until
  framework A1 lands).
- `Notifier` interface — new, wrapping `notifyTelegram(text)`. One
  consumer (heartbeat) today; can also be the free function via a
  `type Notifier = (text: string) => Promise<void>` type alias until
  a second consumer materialises.
- `GoogleApiClient` (F6) — constructor-injected.
- `LoggerLike` (F.6) — constructor-injected.
- `SettingsStore` (F4) — constructor-injected for
  `getEffective('HEARTBEAT_START_HOUR' | 'END_HOUR')` reads.

### Lifecycle

- **Constructed once at app boot** by `class App`
  (`index.ts:541-552`'s future `App` constructor) inside the boot
  flow after `PortLockAcquirer.acquire()` and `PidfileLockAcquirer.acquire()`
  (per `01 §Startup ordering` and `e-process-lock/00-summary.md §Dependency`).
- **One instance per process.** The class holds mutable timer state
  (`heartbeatTimeout: Timer | null` and `stopped: boolean`) as
  private fields; these are process-lifetime, not per-tick.
- **`stop()` clears in-flight handle + awaits in-flight `execute()`
  promise.** See FR5 for the cancellation logic and the
  `index.test.ts:1382`-style test that pins the behaviour.

### Free functions that REMAIN after F.1

| Symbol | Location | Why it stays |
|---|---|---|
| `initHeartbeat()` | `heartbeat.ts:584-592` | Thin wrapper: calls a module-level singleton `singleton.init()`. Required by F.8's gate (zero direct importers outside `index.ts`). Removed in F.8. |
| `stopHeartbeat()` | `heartbeat.ts:594-598` | Same wrapper shape. Removed in F.8. |
| `executeHeartbeat()` | `heartbeat.ts:483-552` | Re-exported at `:601` as a test seam (`src/__tests__/heartbeat.test.ts:90` and `src/__tests__/heartbeat-cov.test.ts:60` per `01 §Per-file inventory` mock count). Stays as a wrapper: `() => singleton.execute()`. |
| `formatHeartbeatCardLabel(card): string` | `heartbeat.ts:319` | Pure string formatter; stays as a free export per the framework pattern for pure helpers. |
| `collectData`, `shouldNotify`, `buildAgentPrompt` | `heartbeat.ts:358/363/392` | Re-exported at `:601` for tests. The class version makes them `public readonly` methods so the same test import path works through the singleton wrapper. |
| `__test_handleWatchEvent` (if added) | n/a | Not present today; if F.1 introduces one it would mirror the `settings-store.ts:40` pattern (`02 §Heartbeat decision types` notes heartbeat has no testable handleWatchEvent today). |

---

## F2. `HeartbeatWorkerCwdBuilder`

### Source and migration

- **Source file:** `src/heartbeat.ts` (same file, alongside the free
  function).
- **Migration source:** `ensureHeartbeatWorkerCwd` at
  `heartbeat.ts:77-221` (145 lines of plumbing — symlinks,
  `mkdirSync` / `writeFileSync` / `symlinkSync` / `rmSync` / etc.),
  `lstatSyncSafe` at `:223-263` (41 lines), `readClaudeCodeOauthJson`
  at `:265-283` (19 lines including the macOS Keychain
  `execFileSync('/usr/bin/security', ...)` call at `:268`).

### Public surface (signatures only)

```ts
class HeartbeatWorkerCwdBuilder {
  constructor(private readonly log: LoggerLike)

  // idempotent: builds the tree on every tick per today; safe to call repeatedly
  ensure(): void
  // test seam for the macOS Keychain path
  protected readClaudeCodeOauthJson(homeDir: string): ClaudeSettings
  // wraps fs.lstatSync errors
  protected lstatSyncSafe(path: string): Stats | null
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `ensure()` | `ensureHeartbeatWorkerCwd()` | `heartbeat.ts:77-221` | Builds the isolated `agents/heartbeat-worker/.claude-config/` tree on every call. The `readClaudeCodeOauthJson` private method is the macOS-only path that reads from Keychain. |
| `readClaudeCodeOauthJson(homeDir)` | `readClaudeCodeOauthJson()` | `heartbeat.ts:265-283` | Today a private function; exposed as `protected` so a test can substitute a fake. Today the function is called only from `ensureHeartbeatWorkerCwd` (`:186`); a test that wants to bypass Keychain needs the visibility bump. |
| `lstatSyncSafe(path)` | `lstatSyncSafe()` | `heartbeat.ts:223-263` | Today a module-private function; exposed as `protected` for the same reason. |

### Constructor

- `(log)`. Takes only the logger — no I/O dependencies of its own.
  The class writes to the filesystem via `node:fs` (already imported
  in `heartbeat.ts`) and reads Keychain via `execFileSync`. None of
  these is constructor-injected today; the class form keeps that
  pattern (no DI for `node:fs` — it's a true module dependency, not
  a swappable seam).

### Why this split

The 145-line `ensureHeartbeatWorkerCwd` body has nothing to do with
scheduling; it's pure file-system plumbing with one macOS-Keychain
side effect. The split:
- Makes the scheduler testable without a real `~/.claude/` tree (the
  cwd builder can be a mock).
- Makes the cwd builder testable without a real scheduler (it has no
  timer state).
- Surfaces the macOS-Keychain dependency at a class boundary instead
  of buried inside a 600-line file.
- Matches the `02 §Entity types / class candidates` row
  "HeartbeatWorkerCwdBuilder — 145 lines of plumbing that has nothing
  to do with scheduling. Natural split".

### Generic params

None. Per `02 §Heartbeat decision types`, no type parameter has a
second consumer.

### Dependencies

- `node:fs` (`mkdirSync`, `writeFileSync`, `readFileSync`,
  `symlinkSync`, `rmSync`, `lstatSync`).
- `node:child_process` (`execFileSync` for `'/usr/bin/security'`).
- `ClaudeSettings` interface (local to `heartbeat.ts:66`).
- `LoggerLike` (F.6).

### Lifecycle

- **One instance per process**, constructed at app boot and held by
  `HeartbeatScheduler` as `cwdBuilder`. The instance is stateless;
  `ensure()` writes to the filesystem but holds no in-memory state.

### Free functions that REMAIN after F.2

- `ensureHeartbeatWorkerCwd()` becomes a thin wrapper
  `() => singleton.ensure()`; removed in F.8.
- `readClaudeCodeOauthJson(homeDir)` becomes a private method on the
  class; if a test imports it directly (none today per
  `02 §Per-file type audit`), it stays as a free export until F.8.
- `lstatSyncSafe(path)` — same.
- The `HEARTBEAT_AGENT_CWD` (`heartbeat.ts:36`), `HEARTBEAT_CONFIG_DIR`
  (`:52`), `HEARTBEAT_DISABLED_PLUGINS` (`:64`), `HEARTBEAT_CONFIG_SKIP`
  (`:75`) constants remain module-level — they are imported by both
  the cwd builder and the prompt builder.

---

## F3. `StoreWatcher`

### Source and migration

- **Source file:** `src/store-watcher.ts` (same file, alongside the
  free functions).
- **Migration source:** the three `let`s at `:47` (`currentWriteActor`),
  `:60` (`knownFiles`), `:81` (`watcher`); the `const` at `:79`
  (`recentEvents`); the four exports `setStoreWriteActor:49`,
  `clearStoreWriteActor:53`, `startStoreWatcher:88`,
  `stopStoreWatcher:156`; the private helpers `scanStore:62-73` and
  `isSystemFile:83-86`; and the watcher callback at `:95-145`.

### Public surface (signatures only)

```ts
class StoreWatcher {
  constructor(private readonly log: LoggerLike)

  start(): void                                    // was startStoreWatcher
  stop(): void                                     // was stopStoreWatcher
  setActor(actor: string): void                    // was setStoreWriteActor
  clearActor(): void                               // was clearStoreWriteActor
  onChange(handler: WatchHandler): void            // new: exposes the rename-dedup pipeline as a callback
}

type WatchHandler = (event: {
  rel: string
  kind: 'create' | 'delete' | 'update'
  fileSize: number | null
  actor: string | null
}) => void
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `start()` | `startStoreWatcher()` | `:88-117` | Idempotent on the internal `watcher` field; pre-seeds `knownFiles` from `scanStore`. Throws if called twice after `stop()`? No — sets `watcher = null` on `stop()` and re-creates on `start()`. The class form asserts `if (this.watcher)` and logs a warning rather than silently doing nothing. |
| `stop()` | `stopStoreWatcher()` | `:156-160` | Closes the `FSWatcher` handle and clears the field. |
| `setActor(actor)` | `setStoreWriteActor(actor)` | `:49` | One-shot slot; cleared by the watch callback. |
| `clearActor()` | `clearStoreWriteActor()` | `:53` | Manual clear (for nested-write attribution edge cases per `:42-46`). |
| `onChange(handler)` | n/a (new) | n/a | Today the watch callback logs via `logStoreFileEvent` directly (`:145`). The class form exposes the dedup'd, system-file-filtered event as a public callback so consumers (none today) can subscribe. The class internally registers the default handler that calls `logStoreFileEvent`. |

### Constructor

- `(log)`. Takes only the logger. **No I/O in the constructor.** The
  `fs.watch` handle is created by `start()`.

### Generic params

None. Per `02 §Generic opportunities`, `StoreWatcher<TActor extends string>`
was rejected on OE-6 (every caller passes a `string`).

### Dependencies

- `node:fs` (`watch`, `readdirSync` recursive, `statSync`).
- `db` (via `logStoreFileEvent` at `:145` — direct import).
- `LoggerLike` (F.6).

### Lifecycle

- **One instance per process**, constructed at app boot and held by
  `class App`. `start()` is called after the settings store watcher
  is up (no ordering dependency; both are independent `fs.watch`
  registrations on the same `STORE_DIR`).
- **Owns a single readonly `FSWatcher` field.** The class asserts
  null on construction; `start()` opens, `stop()` closes. Re-calling
  `start()` after `stop()` is allowed (re-opens a fresh handle).

### Free functions that REMAIN after F.3

| Symbol | Location | Why it stays |
|---|---|---|
| `startStoreWatcher()` | `:88-117` | Thin wrapper: `() => singleton.start()`. Required by F.8's gate. Removed in F.8. |
| `stopStoreWatcher()` | `:156-160` | Same wrapper shape. Removed in F.8. |
| `setStoreWriteActor(actor)` | `:49` | Same. Removed in F.8. |
| `clearStoreWriteActor()` | `:53` | Same. Removed in F.8. |
| `SYSTEM_FILES` (`:11`), `SYSTEM_RE` (`:38`), `DEDUP_MS` (`:78`) | module constants | Stays module-level — derived constants, not class state. |

---

## F4. `SettingsStore`

### Source and migration

- **Source file:** `src/settings-store.ts` (same file).
- **Migration source:** the two `let`s at `:17` (`cache`),
  `:18` (`watcher`); the eager `loadFromDisk` call at `:32`;
  `loadFromDisk:20-30`; the `__test_handleWatchEvent` test seam at
  `:40-42`; `ensureWatching:46-56`; the five exports
  `getOverrides:58-60`, `getEffectiveSettingValue:72-90`,
  `setOverride:92-107`, `reloadOverridesForTest:109-111`, plus
  `__test_handleWatchEvent:40`.

### Public surface (signatures only)

```ts
class SettingsStore {
  constructor(private readonly log?: LoggerLike)   // logger is optional — file has 0 call sites today

  ensureWatching(): void                           // lazy: opens the fs.watch handle on first read
  getOverrides(): Record<string, string | number>
  getSetting(key: string): SettingValue            // was getEffectiveSettingValue
  setOverride(key: string, rawValue: unknown): SetOverrideResult
  reloadForTest(): void                            // was reloadOverridesForTest
  onFsWatchEvent(_event: unknown, filename?: string): void   // was __test_handleWatchEvent
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `ensureWatching()` | `ensureWatching()` | `:46-56` | Same idempotency guard (`if (this.watcher) return`). |
| `getOverrides()` | `getOverrides()` | `:58-60` | Returns the full cache. |
| `getSetting(key)` | `getEffectiveSettingValue(key)` | `:72-90` | Returns `string \| number`; resolves override → env → registry default. |
| `setOverride(key, rawValue)` | `setOverride(key, rawValue)` | `:92-107` | Validates against the registry, `atomicWriteFileSync` to disk, updates cache. |
| `reloadForTest()` | `reloadOverridesForTest()` | `:109-111` | Test escape hatch. |
| `onFsWatchEvent(_, filename)` | `__test_handleWatchEvent(_, filename)` | `:40-42` | Test seam for the watcher callback (reloads if filename is exactly `config-overrides.json`). |

### Constructor

- `(log?)`. The logger is **optional** — `settings-store.ts` has
  zero logger call sites today (`02 §Per-file type audit`), so the
  constructor accepts `log` only as a future-proofing slot. Without
  H.1, the constructor takes nothing logger-related.
- **Eager `loadFromDisk()` at construction.** The current
  `settings-store.ts:32` runs `cache = loadFromDisk()` at module
  evaluation. The class form moves this into the constructor — the
  test seam `reloadForTest()` preserves the test-time re-read
  capability.

### Generic params

None. Per `02 §Generic opportunities`, `SettingsStore<TKey>` and
`SettingsStore<TValue>` were both rejected on OE-6 (the value type is
fixed by `SettingDefinition`; narrowing forces every test to declare
`TKey`).

### Dependencies

- `node:fs` (`readFileSync`, `mkdirSync`, `watch`).
- `node:os` (none directly — `STORE_DIR` from `config.ts`).
- `STORE_DIR`, `OVERRIDES_PATH` (`:15`) — module constants.
- `SETTING_REGISTRY` (from `config-registry.ts`) — via the free
  function `coerce()` at `:63`.
- `atomicWriteFileSync` (from `web/atomic-write.ts:22`).
- `LoggerLike` optional (F.6).

### Lifecycle

- **One instance per process**, constructed at app boot and held by
  `class App`. `ensureWatching()` is called by `App.start()` after
  the `StoreWatcher` is up (no ordering dependency — both watch
  `STORE_DIR` independently).
- **Owns the watcher handle.** Construction-time `loadFromDisk()`
  pre-seeds the cache; the watcher is lazy (`ensureWatching()`).

### Free functions that REMAIN after F.4

| Symbol | Location | Why it stays |
|---|---|---|
| `getEffectiveSettingValue(key)` | `:72-90` | Thin wrapper: `(k) => singleton.getSetting(k)`. Required by F.8's gate (5 production importers per `01 §Per-file inventory`: `heartbeat.ts:5`, `db.ts:6`, `web/agent-process.ts:42`, `web/inbox-nudge-watcher.ts:50`, `web/llm-breakdown.ts:5`). Removed in F.8. |
| `setOverride(key, rawValue)` | `:92-107` | Same. Removed in F.8. |
| `getOverrides()` | `:58-60` | Same. Removed in F.8. |
| `__test_handleWatchEvent(_, filename)` | `:40-42` | Test seam; stays as a wrapper until F.8. |
| `reloadOverridesForTest()` | `:109-111` | Same. Removed in F.8. |

---

## F5. `ClaudeCodeBinResolver`

### Source and migration

- **Source file:** `src/agent.ts` (same file).
- **Migration source:** `cachedClaudeCodeBin:81` + `resolveClaudeCodeBin:82-100`.
  The closure `let cachedClaudeCodeBin: string | undefined | null` is
  the third invalidation pattern in the F lazy-cache cluster: **process-
  lifetime manual invalidation** (no mtime tracking).

### Public surface (signatures only)

```ts
class ClaudeCodeBinResolver extends LazyBin<'claude'> {
  // no constructor override — inherits LazyBin's (name, resolver?)
  // resolve() and invalidate() are inherited

  // F-specific convenience: check that the path is executable
  isExecutable(): boolean
}
```

### Why this is F.7 not its own class

Per `h-cross-cutting/04-generic-interfaces.md §Z` and `02 §Per-file
type audit` row "ClaudeCodeBinResolver", `LazyBin<TName, TResolved>`
is H's class; F consumes it via subclass. The `resolve()` method is
inherited; `invalidate()` is inherited. The F-specific extension is
the executable-check helper used in `agent.ts:78-80` (the
`agentBackend()` selector).

### Constructor

- Inherited from `LazyBin<'claude'>`: `(name?, resolver?)`. Per H.3,
  the constructor performs **no I/O** (pinned by
  `src/__tests__/platform-no-import-time-bin-resolve.test.ts:44`).

### Generic params

`TName = 'claude'` (narrowed from `LazyBin<TName>`). `TResolved` is
defaulted to `string` per H.4 §Z; no narrower inhabitant exists in
F.

### Dependencies

- `resolveFromPath` (`platform.ts:61`) — the default `resolver`.
- `LazyBin` (H.3) — parent class.

### Lifecycle

- **One instance per process**, constructed at `agent.ts` module
  scope (today: `let cachedClaudeCodeBin` is module-scope). The
  class form moves construction into the class, but the instance
  lives at the same module-scope location.

### Free functions that REMAIN after F.5

| Symbol | Location | Why it stays |
|---|---|---|
| `resolveClaudeCodeBin()` | `:82-100` | Thin wrapper: `() => singleton.resolve()`. Required by F.7's gate (4 production importers per `01 §Per-file inventory`: `heartbeat.ts:16`, `memory.ts:16`, `web/agent-scaffold.ts:6`, `web/llm-breakdown.ts:3`). Removed in F.7 close-out. |
| `cachedClaudeCodeBin` | `:81` | Module-level `let` becomes the singleton instance; the variable name survives for test compatibility. |
| `runAgent(...)` | `:122-216` | Free function (per `02 §agent.ts does not collapse to a class`). |
| `classifyAgentResult(event)` | `:39-66` | Pure helper. |
| `AgentResultClassification`, `RunAgentOpts` types | `:33, :110` | Stay free. |
| `DEFAULT_DISALLOWED_TOOLS` (`:17`), `TYPING_REFRESH_MS` (`:7`), `AGENT_TIMEOUT_MS` (`:10`) | module constants | Stay module-level. |

---

## F6. `GoogleApiClient`

### Source and migration

- **Source file:** `src/google-api.ts` (same file).
- **Migration source:** the three cache cells at `:51` (`cachedTokens`),
  `:52` (`cachedClient`), `:108` (`refreshInFlight`); the seven
  internal helpers `loadTokens:54-62`, `saveTokens:64-72`,
  `loadClientCredentials:74-86`, `refreshAccessToken:110-118`,
  `doRefresh:120-154`, `getValidAccessToken:156-163`, `httpsRequest:165-209`;
  the one export `getCalendarEvents:211` (well, `:165` per `02 §Per-file
  type audit`); the four local types `TokenData:11`,
  `ClientCredentials:19`, `CalendarEvent:27`, `CalendarListResponse:38`.

### Public surface (signatures only)

```ts
class GoogleApiClient {
  constructor(
    private readonly log: LoggerLike,
    private readonly homedirFn: () => string = homedir,   // injectable for tests
  )

  getCalendarEvents(
    calendarId: string,
    timeMin: string,
    timeMax: string,
  ): Promise<CalendarEvent[]>

  invalidate(): void   // drops cachedTokens + cachedClient; in-flight refresh survives
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `getCalendarEvents(calendarId, timeMin, timeMax)` | `getCalendarEvents(calendarId, timeMin, timeMax)` | `:165-209` | Reads `loadTokens()` (mtime-checked), `loadClientCredentials()` (cached once), `refreshAccessToken()` (single-flight), `httpsRequest()`. Returns `CalendarEvent[]`. |
| `invalidate()` | n/a (new) | n/a | Drops `cachedTokens` and `cachedClient`; leaves `refreshInFlight` alone (an in-flight refresh will complete and the next call will re-read mtime). The class exposes this for tests and for HMR-style re-imports. |

### Constructor

- `(log, homedirFn?)`. The `homedirFn?` injects `node:os.homedir()`
  for tests; defaulted so production callers pass `(log)` only.
  This mirrors `ChannelEnv`'s `(env, home?)` constructor in
  `d-channel-provider/03-class-boundaries.md:71`.
- **No I/O in the constructor.** All `node:fs` reads are inside
  `loadTokens()` and `loadClientCredentials()`, called only from
  `getCalendarEvents()`.

### The `refreshInFlight` singleton hazard (FR3)

The `refreshInFlight: Promise<string> | null` at `:108` is
**module-level today**, not per-instance. After class extraction, it
must remain **process-singleton** — not per-instance — because two
`GoogleApiClient` instances would otherwise issue two parallel refreshes
and overwrite each other.

**Resolution:** move `refreshInFlight` to a `private static` field on
the class. All instances share one `static refreshInFlight: Promise<string> | null`.
This is the cleanest "one single-flight per process" shape with the
class form. (Alternative: keep `refreshInFlight` at module scope
outside the class. The `static` form is preferred for namespace
symmetry with the class.)

### Generic params

None. Per `02 §Generic opportunities`,
`GoogleCalendarClient<TTokens extends TokenData>` was rejected on OE-6
(token shape is dictated by on-disk `tokens.json`).

### Dependencies

- `node:fs` (`statSync`, `readFileSync`, `writeFileSync`).
- `node:https` (`request` for `httpsRequest:165-209`).
- `node:os` (`homedir`).
- `LoggerLike` (F.6).

### Lifecycle

- **One instance per process**, constructed at app boot and held by
  `class App`. The constructor is cheap; the first `getCalendarEvents()`
  call pays the `statSync` + `readFileSync` + `parse` cost.
- **`invalidate()` is exposed** as a test seam and for HMR. Today
  there is no API to force-re-read; the cache is mtime-keyed, so
  out-of-process token rotations invalidate naturally. The
  `invalidate()` method adds the option to drop the cache
  explicitly (e.g. when a test wants to verify the next call
  re-reads).

### Free functions that REMAIN after F.6

| Symbol | Location | Why it stays |
|---|---|---|
| `getCalendarEvents(calendarId, timeMin, timeMax)` | `:165-209` | Thin wrapper: `(id, min, max) => singleton.getCalendarEvents(id, min, max)`. Required by F.2's gate (1 production importer per `01 §Per-file inventory`: `heartbeat.ts:15`). Removed in F.2 close-out. |
| `CalendarEvent` type (`:27` + re-export at `:211`) | type-only | Stays as a free type export for `heartbeat.ts:15`'s `import { …, type CalendarEvent }` to keep resolving. |
| `TokenData`, `ClientCredentials`, `CalendarListResponse` types | type-only | Stay free (only used inside this file). |

---

## F7. `GraphMailClient`

### Source and migration

- **Source file:** `src/graph-mail.ts` (same file).
- **Migration source:** the two cache cells at `:68` (`cachedCreds`),
  `:132` (`cachedToken`); the three internal helpers
  `loadCredentials:105-128`, `getToken:144-185`, `graphFetch:189-212`;
  the path helper `mailboxPath:189`; the transform `toRecipientList:255`;
  the four exports `parseCredentials:72`, `listMessages:214`,
  `sendMail:232`, `verifyAccess:255`; the four exported types
  `MailCredentials:26`, `GraphMessage:33`, `SendMailOptions:44`,
  `ListMessagesOptions:55`.

### Public surface (signatures only)

```ts
class GraphMailClient {
  constructor(private readonly log: LoggerLike)

  listMessages(options?: ListMessagesOptions): Promise<GraphMessage[]>
  sendMail(options: SendMailOptions): Promise<void>
  verifyAccess(): Promise<{ mailbox: string; messageCount: number }>
  invalidate(): void   // drops cachedCreds + cachedToken

  // parseCredentials is a pure function; stays free for testability
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `listMessages(options?)` | `listMessages(options?)` | `:214-230` | Reads `loadCredentials()` (mtime-checked), `getToken()` (clientId + expiresAt-checked), `graphFetch()`. Returns `GraphMessage[]`. |
| `sendMail(options)` | `sendMail(options)` | `:232-253` | Same credentials + token read path; `fetch('POST', …)`. Returns `void` (per the `02 §Per-file type audit` row "sendMail" + the `review-correctness.md C4` critical-fix that established `Promise<void>`, not `Promise<SendResult>`). |
| `verifyAccess()` | `verifyAccess()` | `:255-263` | Returns `{ mailbox, messageCount }` (per `02 §Per-file type audit` row "verifyAccess" + `review-correctness.md C4`). |
| `invalidate()` | n/a (new) | n/a | Drops `cachedCreds` + `cachedToken`. |

### Constructor

- `(log)`. Takes only the logger. **No I/O in the constructor.**
- **No fetch-based single-flight** like `GoogleApiClient`. Two
  concurrent `getToken()` calls would issue two parallel `fetch`es
  today; per `02 §Lazy-cache cluster type comparison`, this is a
  known gap that the class form does not fix. `02 §GoogleApiClient`
  notes the single-flight as a load-bearing pattern; `GraphMailClient`
  does not have it. This is a documented limitation per the brief,
  not a class-extraction hazard.

### Generic params

None. Per `02 §Generic opportunities`,
`GraphMailClient<TCreds>` and `<TMessage>` were both rejected on OE-6
(creds shape is dictated by the on-disk credentials file; message
shape by Microsoft's `message` resource).

### Dependencies

- `node:fs` (`statSync`, `readFileSync`).
- `fetch` (global, Node 18+).
- `LoggerLike` (F.6).

### Lifecycle

- **Zero production importers today** per `01 §Per-file inventory`:
  `grep -rn "from ['\"]\\./graph-mail.js['\"]" src/ --include='*.ts' | grep -v __tests__`
  returns nothing. The class is constructed only by tests
  (`src/__tests__/graph-mail.test.ts:every site uses await import(...)`).
  Production wiring is absent as of 2026-08-30. The class form does
  not change this — it just makes the test seam cleaner.

### Free functions that REMAIN after F.7

| Symbol | Location | Why it stays |
|---|---|---|
| `parseCredentials(content)` | `:72-103` | Pure parser; deliberately exported for testability per `02 §Per-file type audit` row. Stays free — class consumers import it. |
| `listMessages(options?)` | `:214-230` | Thin wrapper: `(opts) => singleton.listMessages(opts)`. Required by F.2's gate (zero production importers, but 9 test sites). Removed in F.2 close-out. |
| `sendMail(options)` | `:232-253` | Same. |
| `verifyAccess()` | `:255-263` | Same. |
| `MailCredentials`, `GraphMessage`, `SendMailOptions`, `ListMessagesOptions` types | type-only | Stay free. |

---

## F8. `AutoRestartSchedule`

### Source and migration

- **Source file:** `src/auto-restart.ts` (same file).
- **Migration source:** the three type aliases `AutoRestartMode:16`,
  `MainRestartMechanism:19`, `AutoRestartConfig:34`; the four pure
  functions `mainRestartMechanism:30-32`, `parseHHMM:57-65`,
  `normalizeAutoRestartConfig:72-89`, `restartDue:104-109`,
  `dailyDueAtMs:117-122`; the frozen const `DEFAULT_AUTO_RESTART:48-54`.

### Deviation from `02 §AutoRestart deep-dive`

`02 §AutoRestart deep-dive` recommends **keeping the file as free
functions** because (a) every export is deterministic and pure,
(b) the module is dependency-free so the due-decision is unit-testable
without a clock / tmux / filesystem, and (c) a class form adds an
instance for zero behavioural change.

The F brief **overrides** this: it asks for `class AutoRestartSchedule`
in `03-class-boundaries.md` and the framework's `00-summary.md §Top-3
lowest-risk wins` #3 lists it as a class candidate. The override is
defensible because:
1. The framework's `00-summary.md §Top-3 lowest-risk wins` #3
   explicitly lists `class AutoRestartSchedule` as a win; F inherits
   this decision.
2. The two consumers (`web/auto-restart-store.ts:9`,
   `web/auto-restart-runner.ts:16`) can share one instance via
   constructor DI in `class App`, eliminating two module-level imports.
3. `DEFAULT_AUTO_RESTART` becomes a `readonly` instance field,
   preserving its frozen identity for tests (the `02 §No class needed`
   paragraph notes "the const's identity is captured by tests;
   mutating it would corrupt in-flight tests").

The class form is a **namespace-wrapper**, not a state-owning class.
No fields mutate; no I/O; no `start()` / `stop()`.

### Public surface (signatures only)

```ts
class AutoRestartSchedule {
  readonly DEFAULT: AutoRestartConfig = DEFAULT_AUTO_RESTART  // readonly; preserved frozen
  readonly MODES: readonly AutoRestartMode[] = ['fresh', 'continue']  // not present today; new derived constant

  mode(launchctlPresent: boolean): MainRestartMechanism         // was mainRestartMechanism
  parseHHMM(s: string): number | null                            // was parseHHMM
  normalize(raw: unknown): AutoRestartConfig                     // was normalizeAutoRestartConfig
  restartDue(lastRestartAtMs: number, nowMs: number, dueAtMs: number): boolean   // was restartDue
  dailyDueAtMs(localMidnightMs: number, minutesSinceMidnight: number): number   // was dailyDueAtMs

  // The brief asks for these method names; they consolidate the 3 decision functions
  decideShouldRestart(facts: RestartFacts): AutoRestartDecision  // new: composes parseHHMM + restartDue
  decideInterval(state: RestartState): number                   // new: composes dailyDueAtMs
  getConfig(): AutoRestartConfig                                // returns the readonly DEFAULT
}

interface RestartFacts {
  lastRestartAtMs: number
  nowMs: number
  dueAtMs: number
}

interface RestartState {
  localMidnightMs: number
  minutesSinceMidnight: number
}

type AutoRestartDecision =
  | { kind: 'due' }
  | { kind: 'not-due' }
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `mode(launchctlPresent)` | `mainRestartMechanism(launchctlPresent)` | `:30-32` | Pure ternary. |
| `parseHHMM(s)` | `parseHHMM(s)` | `:57-65` | Pure regex + range check. |
| `normalize(raw)` | `normalizeAutoRestartConfig(raw)` | `:72-89` | Object shape coercion. |
| `restartDue(lastRestartAtMs, nowMs, dueAtMs)` | `restartDue(lastRestartAtMs, nowMs, dueAtMs)` | `:104-109` | Pure boolean decision. |
| `dailyDueAtMs(localMidnightMs, minutesSinceMidnight)` | `dailyDueAtMs(localMidnightMs, minutesSinceMidnight)` | `:117-122` | Pure arithmetic. |
| `decideShouldRestart(facts)` | n/a (new) | n/a | Brief override: composes `restartDue` into a tagged-union decision. Per `02 §AutoRestartConfig` rejected as discriminated union, the class form preserves the wide shape. The tagged union is a new shape added by the brief; if it conficts with the existing `02 §AutoRestartConfig` "wide form" verdict, the wide form wins. |
| `decideInterval(state)` | n/a (new) | n/a | Same: composes `dailyDueAtMs`. |
| `getConfig()` | n/a (new) | n/a | Returns the frozen `DEFAULT`. |

### Constructor

- **No constructor declared** — the class uses the default empty
  constructor. `DEFAULT` is a class-field initializer, not a
  constructor argument.

### Generic params

None. Per `02 §Generic opportunities`, `AutoRestartDecision<TRestart
extends AutoRestartMode>` was rejected on OE-6 (the mode is a
string-literal union read by the runner, not a class type parameter).

### Dependencies

- None. The class is dependency-free (same as the free-function
  module today).

### Lifecycle

- **One instance per process**, constructed at app boot and held by
  `class App`. The instance is stateless; all methods are pure.

### Free functions that REMAIN after F.5

| Symbol | Location | Why it stays |
|---|---|---|
| `mainRestartMechanism(launchctlPresent)` | `:30-32` | Thin wrapper: `(p) => singleton.mode(p)`. Required by F.5's gate (2 production importers per `01 §Per-file inventory`: `web/auto-restart-store.ts:9`, `web/auto-restart-runner.ts:16`). Removed in F.5 close-out. |
| `parseHHMM(s)` | `:57-65` | Same. |
| `normalizeAutoRestartConfig(raw)` | `:72-89` | Same. |
| `restartDue(lastRestartAtMs, nowMs, dueAtMs)` | `:104-109` | Same. |
| `dailyDueAtMs(localMidnightMs, minutesSinceMidnight)` | `:117-122` | Same. |
| `DEFAULT_AUTO_RESTART` | `:48-54` | **Stays as a module-level const**, also exposed as `instance.DEFAULT`. Test compat (the const's identity is captured by tests). |
| `AutoRestartMode`, `MainRestartMechanism`, `AutoRestartConfig` types | type-only | Stay free. |

---

## Summary of free functions vs class surface after F.1-F.8

| Symbol | After F.1-F.8 | Notes |
|---|---|---|
| `HeartbeatScheduler` class | **new** | F.1 deliverable |
| `HeartbeatWorkerCwdBuilder` class | **new** | F.1 sub-deliverable |
| `StoreWatcher` class | **new** | F.3 deliverable |
| `SettingsStore` class | **new** | F.4 deliverable |
| `ClaudeCodeBinResolver` class | **new** | F.7 deliverable (extends `LazyBin`) |
| `GoogleApiClient` class | **new** | F.2 deliverable |
| `GraphMailClient` class | **new** | F.2 deliverable |
| `AutoRestartSchedule` class | **new** | F.5 deliverable |
| `initHeartbeat` / `stopHeartbeat` / `executeHeartbeat` | wrappers | removed in F.8 |
| `startStoreWatcher` / `stopStoreWatcher` / `setStoreWriteActor` / `clearStoreWriteActor` | wrappers | removed in F.8 |
| `getEffectiveSettingValue` / `setOverride` / `getOverrides` / `reloadOverridesForTest` / `__test_handleWatchEvent` | wrappers | removed in F.8 |
| `resolveClaudeCodeBin` | wrapper | removed in F.7 close-out |
| `getCalendarEvents` | wrapper | removed in F.2 close-out |
| `listMessages` / `sendMail` / `verifyAccess` | wrappers | removed in F.2 close-out |
| `parseCredentials` (graph-mail) | free export | **kept** — pure parser for testability |
| `ensureHeartbeatWorkerCwd` / `readClaudeCodeOauthJson` / `lstatSyncSafe` | wrappers | removed in F.8 |
| `mainRestartMechanism` / `parseHHMM` / `normalizeAutoRestartConfig` / `restartDue` / `dailyDueAtMs` | wrappers | removed in F.5 close-out |
| `DEFAULT_AUTO_RESTART` | **kept** as module-level const (also `instance.DEFAULT`) | test-identity pin |
| `formatHeartbeatCardLabel` | free export | unchanged across all phases |
| `classifyAgentResult` / `AgentResultClassification` / `RunAgentOpts` | free exports | unchanged |
| `runAgent` | free export | unchanged |
| `CalendarEvent` / `TokenData` / `ClientCredentials` / `CalendarListResponse` | free type-only exports | unchanged |
| `MailCredentials` / `GraphMessage` / `SendMailOptions` / `ListMessagesOptions` | free type-only exports | unchanged |
| `AutoRestartMode` / `MainRestartMechanism` / `AutoRestartConfig` | free type-only exports | unchanged |
| `SYSTEM_FILES` / `SYSTEM_RE` / `DEDUP_MS` / `HEARTBEAT_*` / `OVERRIDES_PATH` | module constants | unchanged |
