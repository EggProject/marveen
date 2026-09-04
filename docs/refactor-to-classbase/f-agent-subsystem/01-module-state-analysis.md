# F (agent subsystem) — Module & state analysis

Inventory and state-flow map of every F-scope file, intended as input to the
class-boundary document. **Planning only — no source file was modified.**
Every line ref below was verified against `src/` on 2026-08-30.

---

## Summary (3–5 sentences)

F is the agent runtime stack: the SDK entry point (`agent.ts`), the periodic
heartbeat scheduler (`heartbeat.ts`), two file-watching caches (`store-watcher.ts`,
`settings-store.ts`), two mtime-invalidated auth caches (`google-api.ts`,
`graph-mail.ts`), and one pure decision module (`auto-restart.ts`). Six of the
seven files are **singleton-shaped with module-level mutable state**: one
`let` per cache, one per file-watcher handle, one per in-flight token refresh,
plus per-call `setTimeout`/`setInterval` registrations. Three legitimate
class candidates emerge (HeartbeatScheduler, StoreWatcher, SettingsStore —
plus lazy-cache wrappers for the two auth caches), one file is pure decisions
that needs no class wrapper (auto-restart.ts), and `agent.ts` is a hybrid
backend selector + SDK runner that resists class extraction without losing
the `worker↔sdk` rollback seam. Re-initialisation safety is the dominant
hazard: heartbeat's `setTimeout` can be re-armed, store-watcher's `watch()`
can be opened twice, settings-store's watcher can be doubled, and HMR-style
re-imports into a fresh module-graph will reset only the cache cells, not
the OS-level handles.

---

## Per-file inventory

| File | Shape | Module-level `let`s | Side effects | Re-init hazard | Test-mock count | Consumer count |
|---|---|---:|---|---|---:|---:|
| `src/agent.ts` | Hybrid (per-call runner + lazy-cache + backend selector) | 1 (`cachedClaudeCodeBin` at `:81`) | `execSync('ldd --version')` (:74), `setInterval` (:154), `setTimeout` (:156), dynamic `import('./web/agent-worker.js')` (:140) | Triple: cache may go stale on libc-change (no invalidation), backend selector is `process.env` read every call, dynamic import caches per test-runner | 0 (no `vi.mock('../agent.js')`; tested via `web/agent-scaffold`, `web/agent-process`, and 9 integration tests) | 4 prod (`heartbeat.ts:16`, `memory.ts:16`, `web/agent-scaffold.ts:6`, `web/llm-breakdown.ts:3`) |
| `src/heartbeat.ts` | Singleton (init/stop lifecycle + per-tick pure data) | 2 (`heartbeatTimeout` `:565`, `stopped` `:566`) | `setTimeout` (:569), `mkdirSync` / `writeFileSync` / `symlinkSync` / `rmSync` (`ensureHeartbeatWorkerCwd` `:77-221`), `execFileSync('/usr/bin/security', ...)` (`readClaudeCodeOauthJson` `:268`), `fs.statSync` (`collectSystem` `:344`) | **Critical**: `stopHeartbeat()` clears the timeout but `scheduleNext()` re-arms itself async — if `initHeartbeat()` is called twice before `stopHeartbeat()`, you double-schedule | 1 (`vi.mock('../heartbeat.js')` at `index.test.ts:122`) — also touches `web/heartbeat-agent-scaffold.js` mock at `:127` (CE-7: distinct subsystem) | 1 prod (`index.ts:16` for `initHeartbeat` / `stopHeartbeat`) |
| `src/store-watcher.ts` | Singleton (idempotent start/stop) | 3 (`currentWriteActor` `:47`, `knownFiles` `:60`, `watcher` `:81`) + 1 `const` (`recentEvents` `:79`) | `fs.watch` recursive (`:95`), `statSync` (`startStoreWatcher` `:114`), `readdirSync` recursive (`scanStore` `:64`), `logStoreFileEvent` (db call, `:145`) | **Critical**: `startStoreWatcher()` is idempotent on `watcher` only; if the watcher reference is reset (HMR module re-eval) but `fs.watch` handle is leaked, you double-watch | 4 (`vi.mock('../store-watcher.js')` at `index.test.ts:164`, `autonomy-routes.test.ts:63`, `settings-routes.test.ts:83`, `agents-routes.test.ts:483`) | 1 prod (`index.ts:25` for `startStoreWatcher` / `stopStoreWatcher`) |
| `src/settings-store.ts` | Singleton + lazy-watcher-init + boot-time eager load | 2 (`cache` `:17`, `watcher` `:18`) | `readFileSync` (`loadFromDisk` `:23`), `mkdirSync` (`:49` / `:100`), `watch(STORE_DIR)` (`:50`), `atomicWriteFileSync` (`setOverride` `:102`) | **Critical**: `ensureWatching()` only guards on `watcher` — re-importing this module in a watcher-leaking test environment (e.g. across `vi.resetModules()`) can spawn two watches | 13 — most-mocked F-scope file (`main-agent-config-dir.test.ts:17`, `ideas-routes.test.ts:92`, `index.test.ts:164`, `federation-onboarding-cov.test.ts:61`, `kanban-routes.test.ts:164`, `audit-log-routes.test.ts:43`, `autonomy-routes.test.ts:63`, `marveen-routes.test.ts:188`, `inbox-nudge-watcher.test.ts:61`, `main-agent-isolated-config.test.ts:31`, `agent-process.test.ts:187`, `heartbeat-cov.test.ts:63`, `federation-capability-runner.test.ts:72`, `heartbeat.test.ts:98`, `settings-routes.test.ts:87`, `agents-routes.test.ts:483`) | 5 prod (`heartbeat.ts:5`, `db.ts:6`, `web/agent-process.ts:42`, `web/inbox-nudge-watcher.ts:50`, `web/llm-breakdown.ts:5`) |
| `src/google-api.ts` | Lazy-cache (mtime-invalidated) + single-flight token refresh | 3 (`cachedTokens` `:51`, `cachedClient` `:52`, `refreshInFlight` `:108`) | `statSync` (`:56`, `:70`), `readFileSync` (`:58`, `:76`), `writeFileSync` (`:65`), `https.request` (`:88`) | **Low**: cache is mtime-keyed, so out-of-process token rotations invalidate via a fresh `statSync` on next `loadTokens()`; `refreshInFlight` is single-flight pattern — re-import resets only the in-flight cell, not concurrent callers | 2 (at `heartbeat.test.ts:90`, `heartbeat-cov.test.ts:60`) | 1 prod (`heartbeat.ts:15` for `getCalendarEvents` + `CalendarEvent`) |
| `src/graph-mail.ts` | Lazy-cache (mtime + clientId invalidated) | 2 (`cachedCreds` `:68`, `cachedToken` `:132`) | `statSync` (`:108`), `readFileSync` (`:118`), `fetch` (`getToken` `:158`/`graphFetch` `:189`), `setTimeout` abort (`withTimeout` `:136`) | **Low**: every cache cell is keyed off either mtime or `(clientId, expiresAt)` and invalidated naturally on next call; **graph-mail has zero production importers today** — only the 9 sites at `src/__tests__/graph-mail.test.ts` exercise it (every site uses `await import('../graph-mail.js')` in `vi.resetModules()` cycles) | 0 (no `vi.mock` — the `graph-mail.test.ts` driver uses `vi.resetModules()` + direct `await import` instead) | **0 prod importers** — module is wired only into tests |
| `src/auto-restart.ts` | Pure utilities (no module-level state) | 0 | none (pure exports) | None — module evaluation performs no I/O; all exports are deterministic pure functions | 0 (the 3 `vi.mock` hits at `marveen-routes.test.ts:235`, `auto-restart-runner.test.ts:121`, `agents-routes.test.ts:469` are for `../web/auto-restart-store.js`, NOT this file) | 2 prod (`web/auto-restart-runner.ts:16`, `web/auto-restart-store.ts:9`) |

---

## `heartbeat.ts` deep-dive

### Module-level state

Two `let` declarations at module scope (`heartbeat.ts:565-566`):

```ts
let heartbeatTimeout: ReturnType<typeof setTimeout> | null = null
let stopped = false
```

That's it for mutable state at the module scope — every other binding is a
`const` (`HEARTBEAT_AGENT_CWD:36`, `HEARTBEAT_CONFIG_DIR:52`,
`HEARTBEAT_DISABLED_PLUGINS:64`, `HEARTBEAT_CONFIG_SKIP:75`).

### Lifecycle

`initHeartbeat()` at `:584` reads `startH`/`endH` from settings, computes the
delay to the next in-window hour, calls `scheduleNext(delayMs)`. `scheduleNext`
at `:568` arms a single `setTimeout` whose callback runs `executeHeartbeat()`
then — if not `stopped` — recursively calls itself with the next delay. This
**self-rescheduling pattern** means the timer is forever re-armed from inside
its own callback; `stopHeartbeat()` at `:594` clears the in-flight handle and
flips the `stopped` flag so the post-`executeHeartbeat()` re-arm short-circuits.

### `executeHeartbeat` dataflow

`executeHeartbeat:483` is exported and bound for manual-test use. Per call:

1. Window check: `now.getHours()` against `HEARTBEAT_START_HOUR` / `END_HOUR`
   from `getEffectiveSettingValue`. Outside window → log + return.
2. Opportunistic `runDecaySweep()` from `memory.ts` (synchronous wrapper at
   `:509-512` — the `try/catch` only catches sync throws; if the call ever
   becomes async, the catch becomes load-bearing dead code per the inline
   `:503-507` invariant comment).
3. `collectData()` aggregates `getCalendarEvents` + kanban summary + db size +
   scheduled-task count into one `HeartbeatData` object.
4. `shouldNotify(data)` pure function (`heartbeat.ts:363`) gates the sub-agent
   spawn (board-time-of-day rules + `system.dbWarning` short-circuit).
5. `buildAgentPrompt(data)` constructs the prompt, wrapping calendar titles and
   kanban labels as `<untrusted>` data.
6. `ensureHeartbeatWorkerCwd()` (`:77-221`) builds the isolated
   `agents/heartbeat-worker/.claude-config/` tree: symlinks every
   `~/.claude/*` except `settings.json`, writes an override settings.json
   with all `CHANNEL_PLUGIN_IDS` disabled, copies `.claude.json`'s
   `projects[PROJECT_ROOT]` to `projects[HEARTBEAT_AGENT_CWD]`, and on macOS
   reads the OAuth credentials from Keychain via `execFileSync('/usr/bin/security', …)`.
7. `runAgent(prompt, undefined, undefined, false, HEARTBEAT_AGENT_CWD, { CLAUDE_CONFIG_DIR: HEARTBEAT_CONFIG_DIR })` — the worker-backed run.
8. On `text`, `notifyTelegram(text)` (no `await` of `text` aggregation).

### Double-timer hazard

```ts
// heartbeat.ts:594
export function stopHeartbeat(): void {
  stopped = true
  if (heartbeatTimeout) clearTimeout(heartbeatTimeout)
  logger.info('Heartbeat leallitva')
}
```

`stopHeartbeat()` clears the timeout and flips `stopped`, but the `clearTimeout`
runs **synchronously** while the previous timer's callback may already be
**executing** in the event loop. If `initHeartbeat()` is called again between
`stopHeartbeat()` and the in-flight callback finishing (theoretically only
across awaits), there is no interleaving guard beyond the `stopped` flag. The
`scheduleNext` recursion at `:580` only checks `stopped` *after* awaiting
`executeHeartbeat().catch(...)` — so during the await, a second `initHeartbeat`
call sets `stopped = false` and re-arms a fresh timeout alongside the still-in-
flight one. The result is **two parallel heartbeat loops** until the next tick.

A second hazard: `heartbeatTimeout = null` is **not** done in `stopHeartbeat`.
If `initHeartbeat()` is called immediately after `stopHeartbeat()` the new arm
overwrites the handle — fine — but a `stopHeartbeat()` between two `initHeartbeat`s
that are both racing will only clear the **last** handle, leaving the earlier
one armed. The HMR cycle (a tsx `--watch` session re-evaluating `heartbeat.ts`
under `vi.resetModules` or `tsx --watch`) hits exactly this race because the
module-graph re-evaluation does NOT clear the OS-level `setTimeout` handle —
Node holds the captured closure alive.

### Side-effect inventory

| Operation | Where | Reversible? |
|---|---|---|
| `setTimeout` (recursive) | `scheduleNext` `:569` | Yes, `clearTimeout` in `stopHeartbeat` only if no recursion in flight |
| `mkdirSync(recursive)` | `ensureHeartbeatWorkerCwd:80`, `:95` | Idempotent |
| `writeFileSync(.mcp.json)` | `:86` | Overwritten each call |
| `readdirSync` + `symlinkSync` on `~/.claude/` | `:99-124` | Stale-symlink re-link at `:107-123` |
| `rmSync(linkPath, { recursive, force })` | `:113`, `:148` | Destructive — removes pre-existing wrong-target symlink/dir |
| `writeFileSync(settings.json)` (mode 0600) | `:160` | Overwrites every tick — Claude Code state lost |
| `execFileSync('/usr/bin/security', ...)` | `:268` | Read-only Keychain access |
| `writeFileSync(.credentials.json)` (mode 0600) | `:175` | Re-written every tick so rotated tokens propagate |
| `writeFileSync(.claude.json)` (mode 0600) | `:204` | Same — every tick |
| `writeFileSync(.hidden-from-dashboard)` | `:216` | Idempotent sentinel |
| `fs.statSync` (db size) | `collectSystem:344` | Read-only |
| `runAgent` (sub-process spawn via SDK) | `executeHeartbeat:550` | Kills via `AbortController` timeout in `agent.ts:156` |
| `notifyTelegram` | `executeHeartbeat:554` | Awaited but fire-and-broadcast semantics |

---

## `store-watcher.ts` deep-dive

### State (3 lets + 1 const)

| Binding | Line | Purpose |
|---|---:|---|
| `let currentWriteActor` | `:47` | Per-write attribution slot. Set by `setStoreWriteActor(actor)`, read + cleared in the next watch event. Single-threaded Node assumption. |
| `let knownFiles = new Set<string>()` | `:60` | Pre-seeded at `startStoreWatcher` from a recursive `scanStore`, then mutated as rename events are observed. |
| `let watcher = null` | `:81` | `fs.watch` handle; idempotent guard. |
| `const recentEvents = new Map<string, number>()` | `:79` | Dedup window (1s) keyed by relative path; mutated in-place, never reassigned. **`const` per `review-correctness.md` m8 — not a `let`.** |
| `const DEDUP_MS = 1000` | `:78` | Config knob for the dedup window. |

### `startStoreWatcher` / `stopStoreWatcher` lifecycle

```ts
// store-watcher.ts:88
export function startStoreWatcher(): void {
  if (watcher) return  // idempotent on the handle
  knownFiles = new Set<string>()
  scanStore(STORE_DIR)  // synchronous, recursive readdirSync
  try {
    watcher = watch(STORE_DIR, { recursive: true }, (eventType, filename) => {
      // ... rename-only, dedup'd, system-file-filtered ...
      logStoreFileEvent(rel, 'create', 0, fileSize, agent)
    })
  } catch (err) {
    logger.warn({ err }, 'Store file watcher failed to start')
  }
}

// :156
export function stopStoreWatcher(): void {
  if (!watcher) return
  try { watcher.close() } catch { /* best-effort */ }
  watcher = null
}
```

### Double-watcher hazard

The `if (watcher) return` guard at `:89` only protects against back-to-back
calls inside the same module-graph. **If the module is re-evaluated** (HMR,
`vi.resetModules`, a forked worker that imports the file a second time), the
new module's `watcher` is a fresh `null`, but the **old `fs.watch` handle is
still open** — Node keeps the closure alive because the event loop holds a
reference. Result: two `fs.watch` callbacks firing per `rename` event,
duplicated `logStoreFileEvent` writes, and a leak that compounds across re-imports.

The same hazard applies to `currentWriteActor` — under module re-eval, an
actor written before the re-eval is invisible to the new watcher; writes
attributed in the new eval cannot reach the old watch callback (which is
dead anyway). Practically only a problem in dev/test, not production.

### `currentWriteActor` semantics

```ts
// store-watcher.ts:47
let currentWriteActor: string | null = null

export function setStoreWriteActor(actor: string): void { currentWriteActor = actor }
export function clearStoreWriteActor(): void { currentWriteActor = null }
```

Read once in the watch callback at `:102-103` and **cleared unconditionally**,
including on system-file events (`include in the comment at :99-101`). This
is a one-shot slot, not a stack: nested writes lose attribution for the
outer one. Comments at `:42-46` acknowledge the limitation: "For direct
writes (Bash/Write tool from outside the process), this stays null".

### Side effects

- `readdirSync(recursive)` on `STORE_DIR` per start (`:64-73` — wrapped in
  try/catch, non-fatal)
- `fs.watch` recursive on `STORE_DIR` (`:95`)
- `statSync` per event (`:114`) to distinguish create vs delete
- `logStoreFileEvent` (db call) per new-file (`:145`)

---

## `settings-store.ts` deep-dive

### State (2 lets)

```ts
// settings-store.ts:17-18
let cache: Record<string, string | number> = {}
let watcher: FSWatcher | undefined
```

Plus the eager `cache = loadFromDisk()` at `:32` — runs at **module-import
time**, not on first use. This is the only F-scope file that performs I/O
during evaluation. The file system fixture at `src/__tests__/settings-store.test.ts`
needs a real `STORE_DIR` to exist before this line executes.

### `ensureWatching` lifecycle

```ts
// settings-store.ts:46
function ensureWatching(): void {
  if (watcher) return
  try {
    mkdirSync(STORE_DIR, { recursive: true })
    watcher = watch(STORE_DIR, { persistent: false }, __test_handleWatchEvent)
  } catch {
    // Best-effort: ... cache simply stays as of the last read/write from this
    // process -- still correct for the common single-process case.
  }
}
```

`persistent: false` lets the watcher exit when the event loop empties — the
opposite of `heartbeat.ts`'s never-yielding `setTimeout`. This means in test
runs that don't keep the loop alive, the watcher's callbacks may never fire,
which is exactly why `__test_handleWatchEvent` is exposed at `:40`.

### Double-fs.watch hazard

Identical pattern to `store-watcher.ts`: the `if (watcher) return` guard
protects against same-graph re-entry. Module re-evaluation under HMR /
`vi.resetModules` re-creates `watcher = undefined` and re-runs
`ensureWatching()`, opening a second `fs.watch` on `STORE_DIR`. The old
handle still fires; the new handle fires too — and both update the same
`cache` cell, which is now in the **new** module-graph only. The closures
held by the old watcher fire on a freed `cache` and produce no-op reads
(because TS doesn't guard against it). Net observable effect: a single
extra in-process `__test_handleWatchEvent` per stale-fire — invisible in
production but debug-confusing.

### Cache invalidation

Three paths update `cache`:

1. **Watcher callback** (`__test_handleWatchEvent` `:40-42`) — reloads if
   the changed file is exactly `config-overrides.json` (POSIX path).
2. **`setOverride` write path** (`:101-103`) — `cache = next` immediately
   after `atomicWriteFileSync(OVERRIDES_PATH, ...)` so the in-memory state
   is fresh before any watcher event could deliver it.
3. **Manual `reloadOverridesForTest`** (`:109-111`) — exposed escape hatch.

The `getEffectiveSettingValue:72` read path is the resolution order
override → env → registry default; it never touches `cache` because reads
by definition leave the cache coherent.

---

## Lazy-cache cluster: `agent.ts`, `google-api.ts`, `graph-mail.ts`

Three files share a **lazy-cache pattern** but differ in what triggers the
first call, what invalidates the cache, and how the cache refreshes. The
cluster is not a single candidate — each has its own character.

### Side-by-side

| Aspect | `agent.ts` | `google-api.ts` | `graph-mail.ts` |
|---|---|---|---|
| Cache cell | `cachedClaudeCodeBin:81` | `cachedTokens:51`, `cachedClient:52`, `refreshInFlight:108` | `cachedCreds:68`, `cachedToken:132` |
| Cache key | None — first-call memo | `mtimeMs` of `TOKENS_PATH` | `mtimeMs` of `CREDS_PATH` |
| Triggers first call | First `runAgent()` that hits the SDK path | First `getCalendarEvents()` call | First `listMessages` / `sendMail` / `verifyAccess` call |
| Refresh path | Re-read env / `existsSync(bin)` (no file watch) | `saveTokens:64` writes; next `loadTokens:54` checks `mtimeMs != currentMtime` | Next `loadCredentials:105` checks `mtimeMs != currentMtime`; `getToken:144` checks `(cachedToken.clientId === creds.clientId) && expiresAt > now + 60_000` |
| Invalidation trigger | Manual (no API surface; HMR only — module re-eval resets `null → null`) | Auto on file mtime advance; explicit on `saveTokens` | Auto on file mtime advance **or** clientId change |
| Refresh mechanism | Synchronous memo of `existsSync` result | Re-read + parse + mutate | Re-read + parse + mutate |
| In-flight safety | None — single `runAgent` | **Single-flight `refreshInFlight:108`** shared by concurrent `getValidAccessToken` callers (`:156-163`) | None — concurrent `getToken` would issue two parallel `fetch`es |
| Side effects on miss | `execSync('ldd --version')` if Linux x64 | None (parse) | `parseCredentials` (pure on raw text) |
| Production importers | 4 | 1 | **0** |
| Why it matters | Worker-vs-SDK backend selector reads `process.env` every call (line `:107`), so the cache is not just for binary path — the function `resolveClaudeCodeBin` only memoises `existsSync` results, but the surrounding `runAgent:122` is not class-shaped itself | The single-flight pattern is **load-bearing** — concurrent token refresh would let a slower response overwrite a faster one (`google-api.ts:111-114` inline comment) | Test-only reach means the cache's primary reader is `src/__tests__/graph-mail.test.ts`; production code referencing `graph-mail.ts` is absent as of 2026-08-30 |

### Why the cluster is not one refactor

`review-completeness.md` CE-9 already establishes `RemoteStatusCache<T>` as
a precedent. F's lazy-cache cells have **three different invalidation
semantics** (mtime-only, mtime-only, mtime-plus-clientId) and **two different
in-flight patterns** (none, single-flight, none). Wrapping them in a single
generic class (a `TtlCache<K, V>` à la `04-generic-interfaces.md G2`) loses
the `refreshInFlight` semantics and the `clientId` binding. The Precedents
(D's `ChannelProviderRegistry`, E's `PortLockAcquirer`) argue for **one class
per cache**, not a shared generic.

### Recommended class shape per cache

| File | Recommended class | Migration source |
|---|---|---|
| `google-api.ts` | `class GoogleTokenCache` (or two: `GoogleTokens` + `GoogleClientCredentials`) | `loadTokens:54` + `saveTokens:64` + `refreshAccessToken:110` + `getValidAccessToken:156`. **Keeps the single-flight `refreshInFlight` cell on the class** (or a module-level single-flight helper). |
| `graph-mail.ts` | Two classes: `GraphMailCredentialsCache` and `GraphMailTokenCache` | `loadCredentials:105` + `getToken:144`. **The token cache binds to `clientId` so a rotated app registration doesn't reuse a token minted for the old client** — that `clientId` discriminator is what makes this not just a TTL cache. |
| `agent.ts` | `class ClaudeCodeBinResolver extends LazyBin<'claude'>` | `cachedClaudeCodeBin:81` + `resolveClaudeCodeBin:82`. `h-cross-cutting/04-generic-interfaces.md §Z` already names this as `LazyBin`'s second consumer; the C1 sketch in `03 §C1` was deferred for the same reason. |

### `agent.ts` does not collapse to a class

`agent.ts:122-216`'s `runAgent` body holds:

- `agentBackend()` selector (`:106-108`) — `process.env.MARVEEN_AGENT_BACKEND`
  re-read on every call (intentional: allows env override mid-process).
- `runViaWorker` dynamic import (`:140`) — the worker path is intentionally
  deferred off the SDK hot path.
- `classifyAgentResult` (`:39-66`) — exported pure function, classification of
  result events per issue #209.
- `DEFAULT_DISALLOWED_TOOLS` (`:17`) — module constant guarding the model
  from `Write`/`Edit`/etc., critical for the file-corruption bug behind the
  `classifyAgentResult` block guard.
- `TYPING_REFRESH_MS` (`:7`), `AGENT_TIMEOUT_MS` (`:10`) — module constants.
- The `abortController` + `typingInterval` pair (`agent.ts:154-160`) is
  **per-call state**, not module state, and lives exactly the length of one
  `runAgent` invocation. This is the right shape and resists class
  extraction cleanly.

The class-eligible chunk is the cache (see above); the body remains a
free function. `agent.ts` is therefore **partial** — one cache class plus
the unchanged `runAgent` / `classifyAgentResult` free functions.

---

## `auto-restart.ts` deep-dive

### Pure utility module — confirmed

`src/auto-restart.ts` (122 lines) has **zero module-level lets** and **zero
side effects**. Every export is a deterministic pure function:

| Export | Line | Shape | State captured? |
|---|---:|---|---|
| `AutoRestartMode` | `:16` | Type alias only | n/a |
| `MainRestartMechanism` | `:19` | Type alias only | n/a |
| `mainRestartMechanism(launchctlPresent)` | `:30-32` | One-line ternary | Pure |
| `AutoRestartConfig` interface | `:34-46` | Type only | n/a |
| `DEFAULT_AUTO_RESTART` const | `:48-54` | Frozen object literal — never mutated anywhere (grep clean across `src/` and `src/web/`) | n/a |
| `parseHHMM(s)` | `:57-65` | Regex + range check | Pure |
| `normalizeAutoRestartConfig(raw)` | `:72-89` | Object shape coercion | Pure |
| `restartDue(lastRestartAtMs, nowMs, dueAtMs)` | `:104-109` | Three comparisons | Pure — caller passes `nowMs` |
| `dailyDueAtMs(localMidnightMs, minutesSinceMidnight)` | `:117-122` | Arithmetic | Pure |

### No class needed

Per `h-cross-cutting/04-generic-interfaces.md §Z` ("A `LazyBin<TName,
TResolved>`… has no narrower inhabitant anywhere in `src/`") and
`review-completeness.md` OE-6 ("generics with single consumers… pattern"),
an `AutoRestartSchedule` class would wrap a single const + 4 helpers with
zero state of its own. The most defensible class extract is the
`AutoRestartConfig` interface + a constructor `fromNormalized(raw)` that
calls `normalizeAutoRestartConfig`, but the current pattern (parse +
const + JSON re-serialise when writing) is already idiomatic and the
extracted class would have one consumer per subsystem.

### `DEFAULT_AUTO_RESTART` lifetime

```ts
// auto-restart.ts:48-54
export const DEFAULT_AUTO_RESTART: AutoRestartConfig = {
  enabled: false,
  mode: 'continue',
  dailyTime: null,
  intervalHours: null,
  handoff: false,
}
```

Read at boot by `web/auto-restart-store.ts` (per `01-importers`); written
to disk by the dashboard routes' JSON serialise step; read back via
`normalizeAutoRestartConfig` to round-trip and re-coerce. The const's
identity is captured by tests; mutating it would corrupt in-flight tests.
Treat as **frozen**.

### Consumer integration

- `web/auto-restart-store.ts:9` — imports the type + const + 3 helpers for
  config read/write.
- `web/auto-restart-runner.ts:16` — imports `restartDue`, `dailyDueAtMs`,
  `parseHHMM`, `mainRestartMechanism`, and the `AutoRestartConfig` type
  for its tick-loop.

Test side: `auto-restart-store.test.ts` + `auto-restart-main-mechanism.test.ts`
import the module directly. The 3 `vi.mock` hits at
`marveen-routes.test.ts:235`, `auto-restart-runner.test.ts:121`,
`agents-routes.test.ts:469` are for `../web/auto-restart-store.js` (a
different file), not this one — no test mocks `auto-restart.ts`.

---

## Cross-cutting observations

### F dependency on H (cross-cutting)

Per `h-cross-cutting/00-summary.md` F-row, F does NOT directly consume any
H deliverable today. Verification:

- **LoggerLike** — none of the F-scope files constructs a logger or accepts
  one as a parameter. They call `import { logger } from './logger.js'` and
  emit directly. A class-based refactor would inject `log: LoggerLike` into
  each HeartbeatScheduler / StoreWatcher / SettingsStore / cache class —
  same constructor shape that E (process-lock) and D (channel-provider)
  are already following per their respective boundary docs. **F is a
  second-wave consumer of H.1**, after E validates the pattern.
- **LazyBin** — `agent.ts` becomes the second consumer (after E's
  precedent `web/claude-credentials-guard.ts:142/:327`). The `ClaudeCodeBinResolver`
  sketch in `03 §C1` was deferred awaiting LazyBin; F is the trigger.
- **AppError** — none of the F files throws a typed error. `heartbeat.ts:557`
  catches generic err; `agent.ts:194` catches generic err (or aborted);
  `google-api.ts:142` throws plain `Error`; `graph-mail.ts:121/176/225/259`
  throw plain `Error`. F is **advisory** for H.4 — the convention can be
  applied in F without rewriting existing throws.

### F dependency on E (process-lock)

None of F's files imports from `process-lock.ts` and F does not participate
in startup ordering with the port/pidfile lock. `index.ts:337-351` runs the
process lock before any F-scope init is called (per existing shutdown
order at `index.ts:378-410`: process-lock release is the final step). After
E class extraction, the boot sequence becomes
`PortLockAcquirer.acquire()` → `PidfileLockAcquirer.acquire()` →
`HeartbeatScheduler.start()` (today: `initHeartbeat()`). **F is downstream
of E; no cycle.**

### F dependency on config

Five F-scope files import `config.ts`:

- `agent.ts:5` — `PROJECT_ROOT` (cwd default for SDK path)
- `heartbeat.ts:6-13` — `HEARTBEAT_CALENDAR_ID`, `STORE_DIR`, `DB_FILENAME`,
  `PROJECT_ROOT`, `OWNER_NAME`, `APP_TZ`
- `store-watcher.ts:3` — `STORE_DIR`
- `settings-store.ts:3` — `STORE_DIR`
- `google-api.ts:8-9` — uses `homedir()` (no `config.ts` import!) — the
  two paths `~/.config/google-calendar-mcp/tokens.json` and
  `~/.gmail-mcp/gcp-oauth.keys.json` are hard-coded here, a config leak
  flagged per CLAUDE.md §7 ("kötelező mindig commitolni" applies; this should
  be raised but is not in this scope's blast radius).

`index.ts:16/25` imports `initHeartbeat`/`stopHeartbeat` and
`startStoreWatcher`/`stopStoreWatcher`. **Every shutdown is coordinate from
`index.ts`** — F has no internal coordinator. The class extraction does
not change this: each class still has `start()` / `stop()` and the `App`
keystone (per `d-channel-provider/03-class-boundaries.md D3`) wires them
in the existing order.

### Startup ordering in `index.ts` today

```
:337  procCtx = buildProcessLockContext()        (E)
:350  new PortLockAcquirer(procCtx).acquire(WEB_PORT, ...)  (E; post-E.5a)
:357-358  new PidfileLockAcquirer(...).acquire(PID_FILE, ...)  (E; post-E.5b)
:367  releaseLock() / pidfile handling          (E; releaseLock wraps pidfileLockAcquirer.release)
:353  HTTP server etc.
:541-552  initHeartbeat()                        (F.heartbeat)
:386+  stopHeartbeat / stopStoreWatcher       (shutdown order: F first, E last)
```

F starts after E acquires the lock, shuts down before E releases it.
The HeartbeatScheduler `start()` will need a logger dependency (H.1) and
a way to read `HEARTBEAT_START_HOUR`/`END_HOUR` — that read already comes
from `settings-store.getEffectiveSettingValue`, which is already injected
at module scope (a class wrapper will need to read these once at `start()`
or keep the same `getEffectiveSettingValue(key)` call inside the class).

### HMR / re-import hazards summary

| File | Hazard | Class mitigation |
|---|---|---|
| `heartbeat.ts` | `scheduleNext` recursion + `setTimeout` handle leaks across module re-eval | `HeartbeatScheduler.start()` clears any in-flight `Timer` before re-arming; `stop()` symmetrically clears + flips an internal `running` flag the same way |
| `store-watcher.ts` | `fs.watch` handle leaked on `watcher = null` | `StoreWatcher.start()` owns a single readonly `FSWatcher` field, asserts null on construction (`if (handle) throw`) and re-opens only on a logged warning |
| `settings-store.ts` | Same `fs.watch` leak | `SettingsStore` constructor owns the watcher + cache; the lazy `ensureWatching` pattern is replaced by an explicit `start()` with idempotency |
| `agent.ts` cache | Module re-eval re-memoises nothing (always starts `cachedClaudeCodeBin = null`) but the OS-level `ldd` cache may persist, so the first call post-re-import pays `execSync` again | `ClaudeCodeBinResolver.invalidate()` clears the memoised path per H.3's `LazyBin` API |
| `google-api.ts` / `graph-mail.ts` | Caches are keyed off file mtime — natural invalidation; `refreshInFlight` in google-api must be singleton-aware (one single-flight per process, not per class instance) | Move the single-flight to a process-lifetime closure inside the class' `private static` or to a top-level `let` outside the class (preserved semantics; class instance can hold a non-static field but the in-flight `Promise` must still be shared by all callers, so a module-level helper is the only correct shape unless callers use one class instance per process) |

### Files this plan does NOT touch

Per the user's note "PLATFORM... NOT in F scope (H owns it)": `src/platform.ts`
is excluded. The `LazyBin` class lives there per H.3; F consumes it via
`new ClaudeCodeBinResolver('claude')` (= `new LazyBin('claude')` over
`platform.ts`'s `resolveFromPath`) per `03 §C1`.

`src/web/heartbeat-agent-scaffold.ts` is acknowledged (CE-7) as a
prompt-builder, NOT a runner, and out of F scope. It owns no ticker; it
materialises the heartbeat agent's directory once per boot when the
dashboard process bootstraps.

### Files outside src/ that depend on F

No external `bin/` scripts reference F-scope modules (per a 2026-08-26
audit captured in `review-correctness.md m12`, the bin/ scripts don't reach
into heartbeat / agent). Out-of-scope per F.

---

## Notes for the class-boundary doc (Phase F.2 next step)

1. **Six class candidates** emerge from this analysis:
   `HeartbeatScheduler`, `StoreWatcher`, `SettingsStore`,
   `ClaudeCodeBinResolver` (extends `LazyBin`), `GoogleTokenCache` (with
   module-scope single-flight), and a split of `graph-mail.ts` into
   `GraphMailCredentialsCache` + `GraphMailTokenCache`. The class-boundary
   doc should specify one section per candidate with migration source,
   surface, hazard, and dependencies; the structure follows
   `d-channel-provider/03-class-boundaries.md` row-per-class inventory.
2. **No class for `auto-restart.ts`** — pure utilities stay. This matches
   the H.4 (error taxonomy) and E (`writeBufferFully`) precedents for pure
   helpers: they survive a class refactor unchanged.
3. **`agent.ts` is partial**: the cache becomes a class; the `runAgent`
   body stays a free function. Same pattern as
   `channel-provider.ts:459-473` (`getChannelToken`/`getChannelChatId` →
   `ChannelEnv` class, the provider methods stay free).
4. **Lazy-cache cluster: do not collapse to one generic** — three distinct
   invalidation patterns (mtime, mtime+clientId, manual), two distinct
   in-flight guarantees (single-flight, none). Documented per
   `review-completeness.md CE-9`.
5. **Re-init hazards are class-extractable**: every F-scope module with
   OS-level handles (heartbeat timer, store watcher, settings watcher) has
   a `start()`/`stop()` shape today; the class extraction just enforces
   the idempotency the current `if (watcher) return` guard approximates.
6. **No mtime-keyed cache on `STORE_DIR`** — `settings-store.ts` and
   `store-watcher.ts` watch the same directory for different reasons.
   Their watchers are independent today (the settings-store watcher reloads
   `config-overrides.json`; the store watcher logs file creations). F does
   not propose a unified watcher, and the file-system cost of two
   watches on `STORE_DIR` is acceptable per the existing
   `atomicWriteFileSync` + tmp+rename discipline.

---

**Verified references (this run, 2026-08-30):**

- `src/heartbeat.ts:81,82,565,566,584,594` (lets + lifecycle)
- `src/store-watcher.ts:47,60,78,79,81,88,156` (3 lets + 1 const + lifecycle)
- `src/settings-store.ts:17,18,32,40,46,58,72,92,109` (2 lets + lifecycle)
- `src/agent.ts:17,39,72-79,81,82,106-108,122,140,154,156` (cache + runner)
- `src/google-api.ts:51,52,54-72,108-118,156-163,165-209` (3 lets + cache)
- `src/graph-mail.ts:16,17,21,68,105-128,132,144-185,202,214,232,255` (2 lets)
- `src/auto-restart.ts:30-32,48-54,57-65,72-89,104-109,117-122` (all exports)
- Importers verified via `grep -rn "from ['\"]\\./X\\.js['\"]" src/ --include='*.ts' | grep -v __tests__`
- Test-mock counts verified via `grep -rn "vi\\.mock.*['\"]\\./X['\"]\\|vi\\.mock.*X\\.js" src/__tests__/ --include='*.ts'`
