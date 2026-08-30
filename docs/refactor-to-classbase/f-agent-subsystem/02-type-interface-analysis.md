# F (agent subsystem) — Type and interface analysis

Verified against `src/` on 2026-08-30. All file:line refs below were read
directly. Cross-checks against H (`h-cross-cutting/03-class-boundaries.md`,
`04-generic-interfaces.md`), E (`e-process-lock/04-generic-interfaces.md`),
D (`d-channel-provider/04-generic-interfaces.md`).

---

## Brief summary

The F subsystem spans seven files with very different type maturity:
`auto-restart.ts` is fully typed (3 exported types, 0 unsafe casts, 0
module-level state) and reads as the most class-ready of the seven;
`google-api.ts` and `graph-mail.ts` carry small but distinct lazy-cache
shapes that **do not share an envelope**; `agent.ts` is the only file in
F with `as any` / `: any` casts and concentrates them in the SDK event
loop where the upstream type is `unknown`; `heartbeat.ts` is the largest
file by module-level state (timer handle + `stopped` flag) and has
seventeen logger call sites but **no exported decision or result type** —
its decision functions return raw `boolean` and `void`. Across the seven
files there is no discriminated-union opportunity worth taking today
(per D §4 the temptation to narrow `ValidateTokenResult` was rejected,
the same argument applies here), and no per-class `<T>` parameter has a
second consumer — so F's classes should be concrete-typed, mirroring
E/D's verdict.

---

## Per-file type audit

### 1. `src/agent.ts`

**Exported interfaces / types — count: 2**
- `AgentResultClassification` (L33) — `{ text: string | null; blocked: boolean; reason?: string }`. The `text` slot is the single point of failure for the AUP-block bugfix (issue #209): callers' `if (!text) throw` guard fires on `text === null` regardless of `blocked`.
- `RunAgentOpts` (L110) — `{ timeoutMs?: number; timeoutAsError?: boolean }`. Two-field bag.

**Exported functions — count: 2**
- `classifyAgentResult(event): AgentResultClassification` (L39) — pure.
- `runAgent(message, sessionId?, onTyping?, allowTools?, cwd?, env?, opts?): Promise<{ text; newSessionId?; error? }>` (L122) — 7 positional/optional params; the return shape is **anonymous** and re-inferred at every consumer.

**Local types — count: 1**
- The inline event-parameter object at `classifyAgentResult` (L39-46) is a 6-field anonymous structural type; not promoted to a named interface. Could be exported as `AgentSdkEvent` if a second classifier appears; today one consumer.

**Function types that want class methods — none.** `runAgent` is a single 80-line body with no `this`; `resolveClaudeCodeBin` (L82) is closure-style memoisation.

**Entity types / class candidates**
- `AgentRunner` — owns `runAgent` + `classifyAgentResult` + the lazy-cache `cachedClaudeCodeBin` (L81). Has a per-process lifecycle (resolve once, invalidate on path change). Natural class.
- `ClaudeCodeBinResolver` — already called out by H's `04-generic-interfaces.md:227` as the second consumer of `LazyBin<TName>`. The class form is justified.
- No "agent result" entity class: the SDK event loop is consumed inline.

**Generic opportunities — rejected (OE-6).**
- `AgentRunner<TEnv>` — env is `Record<string, string | undefined>` already; one consumer (`runAgent` itself). Rejected.
- `AgentResultClassification<TBlocked extends boolean>` — would type-narrow the `text: string | null` slot based on `blocked`. Today the consumer reads `text` positionally and the `blocked` flag is logging-only. Rejected: adding the parameter threads through 5+ call sites (`generateClaudeMd`, `generateSoulMd`, `categorizeMemory`, …) for no compile-time win.

**Unsafe casts — count: 5 (only file in F)**
| Line | Form | Context | Severity |
|---|---|---|---|
| 178 | `(event as any).subtype` | SDK event iteration, narrowing `event.type === 'system'` then `'subtype' in event` | medium — the upstream SDK event union is `unknown` per `query()`'s return type; the cast is contained |
| 179 | `(event as any).sessionId as string` | same context, double-cast `unknown → any → string` | **high** — double cast to `string`, no runtime check |
| 182 | `event as any` | argument to `classifyAgentResult` | medium — same `unknown → any` shape as L178 |
| 194 | `catch (err: any)` | AbortError discrimination | low — standard `catch (err: any)` idiom in this codebase, present at `index.ts:555`, `process-lock.ts:347`, ~14 other sites |
| (none) | — | — | — |

Total: 4 `as any` + 1 `: any`. The first three cluster at L178-182 in one ~10-line region; they could be replaced with a single local type `interface AgentSdkSystemEvent { type: 'system'; subtype: string; sessionId?: string }` and a type-guard `isAgentSdkSystemEvent`, eliminating three of the four.

**Today: no `as unknown as`, no `as const`.**

---

### 2. `src/heartbeat.ts`

**Exported interfaces / types — count: 0.**
The file is large (601 lines) and has zero exported interfaces or type aliases. The "data types" section at L285-298 is purely local.

**Exported functions — count: 4**
- `formatHeartbeatCardLabel(card): string` (L319) — pure.
- `initHeartbeat(): void` (L584) — start timer.
- `stopHeartbeat(): void` (L594) — cancel timer.
- `executeHeartbeat(): Promise<void>` (L483) — internal tick body (re-exported as test surface at L601 alongside `collectData`, `shouldNotify`, `buildAgentPrompt`).

**Local types — count: 3**
- `ClaudeSettings` (L66) — `{ enabledPlugins?: Record<string, boolean>; hooks?: unknown; [key: string]: unknown }`. The `[key: string]: unknown` index signature is needed because the JSON is "merge with anything Claude Code may have written in a prior tick" (L130).
- `SystemInfo` (L287) — `{ dbSizeMB: number; dbWarning: boolean }`. Trivially small.
- `HeartbeatData` (L292) — `{ timestamp: Date; calendar: CalendarEvent[]; kanban: { urgent, in_progress, waiting, urgentLabels, waitingLabels }; system: SystemInfo; tasks: { count, nextRun } }`. The `kanban` field is an inline 5-field structural type.

**Function types that want class methods — yes.**
- `collectCalendar`, `collectKanban`, `collectSystem`, `collectData`, `shouldNotify`, `buildAgentPrompt`, `executeHeartbeat`, `scheduleNext` all read like instance methods of a `HeartbeatScheduler`. The timer state (`heartbeatTimeout: ReturnType<typeof setTimeout> | null`, L565) and the `stopped` flag (L566) are the canonical "private field" candidates.
- `msUntilNextHeartbeat()` reads `getEffectiveSettingValue` directly — it would become `this.settings.getEffective('HEARTBEAT_START_HOUR')` in a class form.
- The four `__test_handleWatchEvent`-style test escape hatches present in other F files (`settings-store.ts:40`) are absent here — heartbeat has no testable handleWatchEvent, but `executeHeartbeat` IS re-exported for tests (L601).

**Entity types / class candidates**
- `HeartbeatScheduler` — owns `heartbeatTimeout`, `stopped`, the four `collectX` methods, `shouldNotify`, `buildAgentPrompt`, `executeHeartbeat`, `scheduleNext`, `initHeartbeat`, `stopHeartbeat`, `msUntilNextHeartbeat`. Largest class candidate in F.
- `HeartbeatWorkerCwdBuilder` — owns `HEARTBEAT_AGENT_CWD`, `HEARTBEAT_CONFIG_DIR`, `HEARTBEAT_CONFIG_SKIP`, `ensureHeartbeatWorkerCwd` (L77), `lstatSyncSafe` (L223), `readClaudeCodeOauthJson` (L265), and the macOS-Keychain side effect. 145 lines of plumbing that has nothing to do with scheduling. Natural split: today it sits inside heartbeat.ts because the cwd IS the heartbeat worker's cwd, but a class form would isolate it.
- `HeartbeatPromptBuilder` — `buildAgentPrompt` (L392), 56 lines, only depends on `HeartbeatData`.

**Generic opportunities — rejected (OE-6).**
- `HeartbeatScheduler<TContext>` — would parameterise over the settings source. The current dependency is `getEffectiveSettingValue` from `settings-store.ts`; no second consumer wants a different settings source. Rejected.
- `HeartbeatScheduler<TNotifier>` — would parameterise over `notifyTelegram`. One consumer (line 554), one impl. Rejected.
- `HeartbeatData<TKanban>` — would parameterise the `kanban` field shape. The shape is dictated by `getHeartbeatKanbanSummary()` in `db.ts`; one source of truth. Rejected.
- `ClaudeSettings<TPlugins>` — would narrow `enabledPlugins: Record<string, boolean>` to `Record<keyof typeof CHANNEL_PLUGIN_IDS, boolean>`. The merge-with-anything logic at L130 means the runtime shape IS `Record<string, boolean>`; the narrower type would force every `enabledPlugins` write site to declare a wider cast. Rejected.

**Unsafe casts — count: 0.** The file is the cleanest of the F files in this dimension. The two `parsed as ClaudeSettings` / `parsed as { projects?: ... }` at L139 and L199 are `as` to a structurally-compatible interface (not `as any`), and the cast at L199 carries an explicit `if (parsed && typeof parsed === 'object')` guard above it.

---

### 3. `src/store-watcher.ts`

**Exported interfaces / types — count: 0.**

**Exported functions — count: 4**
- `setStoreWriteActor(actor)` (L49), `clearStoreWriteActor()` (L53) — actor-slot setters.
- `startStoreWatcher()` (L88), `stopStoreWatcher()` (L156) — lifecycle.

**Local types — count: 0.** All state is captured in module-level `let`/`const`s.

**Function types that want class methods — yes.**
- The four exports are exactly the shape of a small class: `StoreWatcher` with `start()` / `stop()` / `setActor(name)` / `clearActor()`, plus the private `scanStore(dir, relBase)` (L62) and `isSystemFile(rel)` (L83) helpers. The internal state (`currentWriteActor`, `knownFiles`, `watcher`, `recentEvents`) is a textbook instance-state set.
- `logStoreFileEvent(rel, 'create', 0, fileSize, agent)` (L145) is the only side effect beyond `fs.watch`; the `0` is a hardcoded `is_sensitive` flag (L142-144 documents why).

**Entity types / class candidates**
- `StoreWatcher` — owns all module state; natural class.
- The actor slot (`currentWriteActor`) is a coordination protocol between two subsystems (the route handler sets, the watch callback consumes-and-clears). Class form does not change this; it just moves the slot from module-scope to private field.

**Generic opportunities — rejected (OE-6).**
- `StoreWatcher<TActor extends string>` — would narrow the actor slot's type. Today every caller passes a `string`. No second caller wants a union. Rejected.

**Unsafe casts — count: 0.**

**Other concerns — the file is the simplest type-maturity file in F.** Zero interfaces, zero unsafe casts, three logger call sites, four functions. The class refactor is mechanical here.

---

### 4. `src/settings-store.ts`

**Exported interfaces / types — count: 1**
- `SetOverrideResult` (L82) — `{ ok: boolean; error?: string }`. Single consumer of the shape is `setOverride` itself.

**Exported functions — count: 5**
- `__test_handleWatchEvent(_event, filename)` (L40) — test-only escape hatch, documented as such.
- `getOverrides(): Record<string, string | number>` (L58) — read all overrides.
- `getEffectiveSettingValue(key): string | number` (L72) — read with registry validation.
- `setOverride(key, rawValue): SetOverrideResult` (L92) — validate + persist.
- `reloadOverridesForTest()` (L109) — test-only cache reset.

**Local types — count: 0.**

**Function types that want class methods — yes.**
- The two module-level `let`s (`cache`, `watcher`, L17-18) plus the `ensureWatching()` private helper (L46) plus `loadFromDisk()` (L20) plus `coerce(def, raw)` (L63) form a coherent `SettingsStore` class with `getEffective(key)`, `set(key, raw)`, `getAll()`, `reloadForTest()`.
- The `__test_handleWatchEvent` is the documented pattern for "the watcher callback is the load-bearing test seam". A class form would expose it as a `protected __test_handleWatchEvent` or move the decision into a pure method `onFsWatchEvent(_event, filename)`.

**Entity types / class candidates**
- `SettingsStore` — owns `cache`, `watcher`, `OVERRIDES_PATH` constant; reads + writes via the registry.

**Generic opportunities — rejected (OE-6).**
- `SettingsStore<TKey extends string>` — would narrow the cache key type. The cache is `Record<string, string | number>`; the keys are `SettingDefinition['key']` (string-literal union). Narrowing would force every test to declare `TKey`. Rejected.
- `SettingsStore<TValue extends string | number>` — same argument; the value type is fixed by the `SettingDefinition`.

**Unsafe casts — count: 0.** One type assertion at L25 (`if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed`) — but that's a `return`, not a cast; the runtime guard precedes the return so the caller infers the union-narrowed type.

---

### 5. `src/google-api.ts`

**Exported interfaces / types — count: 1 (re-export).**
- `export type { CalendarEvent }` (L211) — re-exports the locally-defined `CalendarEvent` (L27) so `heartbeat.ts:15` can `import { …, type CalendarEvent }` from a single source.

**Local types — count: 4**
- `TokenData` (L11) — `{ access_token; refresh_token; expiry_date; token_type; scope }`. All snake_case to match Google's tokens.json format.
- `ClientCredentials` (L19) — `{ installed: { client_id; client_secret; token_uri } }`. Mirrors GCP OAuth keys format.
- `CalendarEvent` (L27) — Google's `Event` resource shape, narrowed to the six fields Marveen actually reads.
- `CalendarListResponse` (L38) — `{ items?: CalendarEvent[] }`. Wrapper for the calendar.events.list endpoint.

**Exported functions — count: 1**
- `getCalendarEvents(calendarId, timeMin, timeMax): Promise<CalendarEvent[]>` (L165).

**Function types that want class methods — yes.**
- The three caches (`cachedTokens`, `cachedClient`, `refreshInFlight` — L51, L52, L108) and three internal helpers (`loadTokens`, `saveTokens`, `loadClientCredentials`, `refreshAccessToken`, `doRefresh`, `getValidAccessToken`, `httpsRequest`) plus the one export form a textbook `GoogleCalendarClient` class with `listEvents(calendarId, timeMin, timeMax)` as the public surface.
- `refreshAccessToken` already implements single-flight via the `refreshInFlight` Promise (L110-118) — that pattern belongs on a class, not as a module-level `let`.

**Entity types / class candidates**
- `GoogleCalendarClient` — owns the three caches; one public method (`listEvents`).

**Generic opportunities — rejected (OE-6).**
- `GoogleCalendarClient<TTokens extends TokenData>` — would parameterise over the token shape. The shape is dictated by the on-disk `tokens.json`; one source of truth. Rejected.

**Unsafe casts — count: 0.** The file is the cleanest of the lazy-cache trio in this dimension.

---

### 6. `src/graph-mail.ts`

**Exported interfaces / types — count: 4**
- `MailCredentials` (L26) — `{ tenantId; clientId; clientSecret; mailbox }`.
- `GraphMessage` (L33) — `{ id; subject?; from?; toRecipients?; receivedDateTime?; bodyPreview?; isRead?; webLink? }`. Microsoft's `message` resource narrowed.
- `SendMailOptions` (L44) — `{ to; subject; body; cc?; contentType?; saveToSentItems? }`.
- `ListMessagesOptions` (L55) — `{ top?; folder?; unreadOnly? }`.

**Exported functions — count: 4**
- `parseCredentials(content): MailCredentials` (L72) — pure parser; deliberately exported for testability without the filesystem.
- `listMessages(options?): Promise<GraphMessage[]>` (L214).
- `sendMail(options): Promise<void>` (L232).
- `verifyAccess(): Promise<{ mailbox; messageCount }>` (L255).

**Function types that want class methods — yes.**
- The two caches (`cachedCreds`, `cachedToken` — L68, L132), three internal helpers (`loadCredentials`, `getToken`, `graphFetch`), one path helper (`mailboxPath`), one transform (`toRecipientList`), three public methods form a textbook `GraphMailClient`.
- The two caches have **different invalidation strategies** — `cachedCreds` is mtime-invalidated (like google-api's), `cachedToken` is expiresAt-based with `clientId` binding. See §Lazy-cache cluster below.

**Entity types / class candidates**
- `GraphMailClient` — owns the two caches; public methods map 1:1 to the four exports.
- `MailCredentialsParser` could be a free function (it already is — `parseCredentials` is exported).

**Generic opportunities — rejected (OE-6).**
- `GraphMailClient<TCreds extends MailCredentials>` — same argument as `MailCredentials` itself. Rejected.
- `GraphMailClient<TMessage extends GraphMessage>` — same. Rejected.

**Unsafe casts — count: 0.** One `(err as NodeJS.ErrnoException).code ?? 'unknown'` at L121 — that's a safe widening cast to a standard interface, not `as any`.

---

### 7. `src/auto-restart.ts`

**Exported interfaces / types — count: 3 (the most of any F file).**
- `type AutoRestartMode = 'fresh' | 'continue'` (L16).
- `type MainRestartMechanism = 'launchd' | 'tmux-respawn'` (L19).
- `interface AutoRestartConfig` (L34) — five-field bag, see §Options/config patterns below.

**Exported functions — count: 5**
- `mainRestartMechanism(launchctlPresent): MainRestartMechanism` (L30).
- `parseHHMM(s): number | null` (L57) — pure.
- `normalizeAutoRestartConfig(raw): AutoRestartConfig` (L72) — defensive coercion.
- `restartDue(lastRestartAtMs, nowMs, dueAtMs): boolean` (L104) — pure decision.
- `dailyDueAtMs(localMidnightMs, minutesSinceMidnight): number` (L117) — pure helper.

**Local types — count: 0.**

**Function types that want class methods — partial.**
- All five functions are pure and dependency-free; the file is intentionally "dependency-free so the due-decision is unit-testable without a clock, tmux, or the filesystem" (header comment, L1-14). **A class form would regress testability**: the module is currently the test seam.
- A `RestartDecisionPolicy` class would only be justified if a subclass-per-mode pattern emerged (e.g., `FreshRestartPolicy` vs `ContinueRestartPolicy`); today the `mode` is a string-literal discriminator consumed by the *runner* (`web/auto-restart-runner.ts`, not in F scope), not by these decision functions. **Recommendation: keep this file as free functions.** See §Class-boundaries recommendation below.

**Entity types / class candidates**
- None. The file's design pattern is "pure decision module that the runner imports". Wrapping it in a class adds an instance for zero behavioural change.

**Generic opportunities — rejected (OE-6).**
- `AutoRestartDecision<TRestart extends AutoRestartMode>` — would parameterise the mode. The mode is a string-literal union read by the runner, not a class type parameter. Rejected (matches D §4's "discriminated union temptation" rejection).

**Unsafe casts — count: 0.**

---

## Lazy-cache cluster type comparison

The three lazy-cache files — `agent.ts` (1 cache), `google-api.ts` (2 caches + 1 in-flight Promise), `graph-mail.ts` (2 caches) — share a *concept* (memoised on-disk state) but **diverge in every detail of shape and invalidation**:

| Site | Cache shape | Invalidation | Refresh pattern |
|---|---|---|---|
| `agent.ts:81` `cachedClaudeCodeBin` | `string \| undefined \| null` (3-state sentinel) | process-lifetime; null = "not yet resolved", undefined = "resolved as absent" | none — re-resolve is unconditional on next call (but cached forever after) |
| `google-api.ts:51` `cachedTokens` | `{ normal: TokenData; mtimeMs: number } \| null` | **mtime-invalidated** — re-read whenever file mtime advances | `saveTokens()` (L64) re-stats after write to avoid self-trigger |
| `google-api.ts:52` `cachedClient` | `ClientCredentials \| null` | process-lifetime (read once) | none |
| `google-api.ts:108` `refreshInFlight` | `Promise<string> \| null` | single-flight per process | `finally(() => { refreshInFlight = null })` |
| `graph-mail.ts:68` `cachedCreds` | `{ value: MailCredentials; mtimeMs: number } \| null` | **mtime-invalidated** (same as google-api) | none — `parseCredentials` is pure |
| `graph-mail.ts:132` `cachedToken` | `{ value: string; expiresAt: number; clientId: string } \| null` | **expiresAt-invalidated + clientId binding** | none — synchronous refresh on expiry |

**Convergence points:**
- `cachedTokens` and `cachedCreds` share the mtime-invalidation envelope `{ value: …; mtimeMs: number } | null` — but the inner `value` field name differs (`normal` vs `value`).
- `cachedClient` (google-api) is process-lifetime, no mtime tracking.
- `cachedToken` (graph-mail) is the only one with `expiresAt`; the others have mtime or process-lifetime.

**Divergence points:**
- agent.ts uses a 3-state null/undefined/resolved sentinel; the others use 2-state (null/resolved).
- Only graph-mail has an expiresAt-based cache; the others are mtime-based or process-lifetime.
- Only google-api has a single-flight Promise (`refreshInFlight`).

### Could a generic `LazyCache<K, V>` base consolidate them?

**Sketch (rejected on OE-6 grounds):**

```ts
// Hypothetical (NOT recommended):
class LazyCache<K extends string, V> {
  constructor(private readonly loader: () => { value: V; mtimeMs: number }, private readonly mtime: () => number) {}
  get(): V
  invalidate(): void
}
```

This would consolidate `cachedTokens` and `cachedCreds` (two consumers — still a single class with two instances). It would **not** fit:
- `cachedClaudeCodeBin` (no mtime, no loader)
- `cachedClient` (no mtime)
- `cachedToken` (expiresAt instead of mtime, plus a `clientId` binding that invalidates on credential rotation)
- `refreshInFlight` (Promise, not a value cache)

**Verdict: reject.** Same OE-6 argument that drove E (`e-process-lock/04-generic-interfaces.md:121-130` rejecting `LockResult<T>`) and D (`d-channel-provider/04-generic-interfaces.md:127-144` rejecting `ChannelEnv<TEnv>`): one shared envelope (`{ value, mtimeMs }`) for two consumers is not load-bearing, and a parameterised base that excludes three of the five caches is a worse fit than no base. The pattern that **was** justified at the H level — `LazyBin<TName, TResolved>` for `resolveFromPath` (`h-cross-cutting/04-generic-interfaces.md:172-178`) — works because the underlying `resolveFromPath` is a single function with one return shape (`string`, throwing). No equivalent common denominator exists for the F caches.

**What to keep instead:** three module-level `let`s per file, captured as private fields when each file becomes a class. No shared base class.

---

## Heartbeat decision types

### Today

The heartbeat subsystem has **three decision points**, none of which return a discriminated union:

| Decision | Function | Return type |
|---|---|---|
| Should we notify at all? | `shouldNotify(data: HeartbeatData): boolean` (L363) | `boolean` |
| Should we restart? | `restartDue(lastRestartAtMs, nowMs, dueAtMs): boolean` (auto-restart.ts:104) | `boolean` |
| Which mechanism? | `mainRestartMechanism(launchctlPresent): MainRestartMechanism` (auto-restart.ts:30) | `'launchd' \| 'tmux-respawn'` |

`executeHeartbeat(): Promise<void>` (heartbeat.ts:483) returns void. The "what happened on this tick" is **not** surfaced to the caller; it's observed only via the logger. There is no `HeartbeatResult` type.

### Should they become discriminated unions?

**For `shouldNotify`:** no. The function returns a binary yes/no consumed by a single caller (the `if (!shouldNotify(data)) return` at L515). A `type NotifyDecision = { kind: 'notify'; reason: string } | { kind: 'skip'; reason: NotifySkipReason }` would add a `reason` discriminator slot that has zero consumers today (the existing logging at L516 says only "nincs ertesitendo"). Rejected.

**For `restartDue`:** no. Binary yes/no; the runner (`web/auto-restart-runner.ts`, not F scope) reads the boolean positionally.

**For `mainRestartMechanism`:** already a string-literal union — the maximally informative shape. No change.

**For `executeHeartbeat`:** the brief temptation is to invent a `HeartbeatTickResult` discriminated union (`{ kind: 'skipped'; reason: 'outside-window' | 'no-data' } | { kind: 'notified'; text } | { kind: 'agent-failed'; err }`). Rejected:
1. Three existing logger.info / logger.warn / logger.error messages (L488, L516, L558) already encode the outcome at the log level; a structured return would duplicate the signal.
2. The one caller (`scheduleNext` at L569-582) only checks `stopped` after the await — it does not inspect the result.

### The hook/observer pattern

**Today: heartbeat does NOT emit events that other modules subscribe to.** The internal flow is `executeHeartbeat` → `notifyTelegram` (line 554) directly. There is no `EventEmitter`, no `onNotify` / `onSkip` callback registration, no observer pattern in the file.

If a future feature wanted "let other modules observe heartbeat ticks", the natural class form would expose a `private listeners: Array<(tick: HeartbeatTickResult) => void>` field with `on(cb)` / `off(cb)` methods. **Not in scope today** — flagged only because the brief asked about it.

### Timer state — typed?

`heartbeatTimeout: ReturnType<typeof setTimeout> | null` (L565) — the only typed module-level timer state in F. The `stopped: boolean` flag (L566) is the second. Neither has a richer type (no `state: 'idle' | 'scheduled' | 'executing'`) — both are intentionally narrow. Class form would move them to private fields.

---

## Options/config patterns

### `DEFAULT_AUTO_RESTART` shape (`src/auto-restart.ts:48-54`)

```ts
{
  enabled: boolean                       // master toggle
  mode: 'fresh' | 'continue'             // discriminator for the runner
  dailyTime: string | null               // 'HH:MM' or null
  intervalHours: number | null           // positive N or null; exactly one of dailyTime/intervalHours is meaningful
  handoff: boolean                       // Phase 2: persist context before fresh restart
}
```

**Invariant enforced in code:** `dailyTime !== null` ⇒ `intervalHours === null` (line 81). The invariant is enforced inside `normalizeAutoRestartConfig`, not at the type level — there is no `type DailySchedule = { dailyTime: string; intervalHours: null }` discriminated union.

**Tempting type-level improvement — rejected:**
```ts
type AutoRestartConfig =
  | { enabled: boolean; mode: AutoRestartMode; dailyTime: string; intervalHours: null; handoff: boolean }
  | { enabled: boolean; mode: AutoRestartMode; dailyTime: null; intervalHours: number; handoff: boolean }
```
Rejected: forces every consumer (`web/auto-restart-runner.ts`, the dashboard route, the JSON store reader) to discriminate on the union, and `web/auto-restart-runner.ts` already reads both fields positionally with `dailyTime ?? dailyDueAtMs(...)`. Same argument as `d-channel-provider/04-generic-interfaces.md:212-222` (the `ValidateTokenResult` temptation). Keep the wide form.

### Other config objects in F

| Object | File:line | Shape | Class candidate? |
|---|---|---|---|
| `DEFAULT_AUTO_RESTART` | `auto-restart.ts:48` | 5 fields | no — the file is pure decision logic |
| `HEARTBEAT_DISABLED_PLUGINS` | `heartbeat.ts:64` | `string[]` (`Object.values(CHANNEL_PLUGIN_IDS)`) | no — derived constant |
| `HEARTBEAT_CONFIG_SKIP` | `heartbeat.ts:75` | `Set<string>` | no — derived constant |
| `ClaudeSettings` | `heartbeat.ts:66` | indexed object | yes — becomes part of `HeartbeatWorkerCwdBuilder`'s state |
| `HeartbeatData` | `heartbeat.ts:292` | 4-field composite | yes — becomes the type of `HeartbeatScheduler.collectData()`'s return |
| `SYSTEM_FILES` | `store-watcher.ts:11` | `Set<string>` | no — derived constant |
| `SYSTEM_RE` | `store-watcher.ts:38` | `RegExp` | no — derived constant |
| `OVERRIDES_PATH` | `settings-store.ts:15` | `string` (path) | no — derived constant |

**Pattern:** F has exactly one config object (`DEFAULT_AUTO_RESTART`) and a handful of derived constants. No config-class candidate beyond the existing module-level state.

---

## LoggerLike integration points

H's `LoggerLike` (defined at `h-cross-cutting/04-generic-interfaces.md:54-69`) requires `{ readonly info: LogFn; readonly warn: LogFn; readonly error: LogFn; readonly debug: LogFn }`, where `LogFn` is the two-overload `(msg: string): void | (obj: object, msg?: string): void`. All F files today import `logger` from `./logger.js` (concrete pino instance) and call its methods directly.

### Per-file call sites

| File | Call sites (lines) | Total | Notes |
|---|---|---:|---|
| `agent.ts` | 139, 147, 157, 188, 196, 207 | **6** | mix of string-first (139, 147, 157, 196) and object-first (188, 207); both fit H's `LogFn` overloads |
| `heartbeat.ts` | 121, 142, 208, 219, 280, 308, 336, 488, 492, 511, 516, 520, 555, 558, 570, 576, 587, 597 | **18** (counted: 17 — 576-577 is one call spanning two source lines) | mostly object-first; the four string-first sites (280, 488, 492, 516, 520, 555, 597 — actually 7) demonstrate that the wider `LogFn` overload is needed |
| `store-watcher.ts` | 147, 150, 152 | **3** | all object-first; logger is the only import |
| `settings-store.ts` | (none) | **0** | imports nothing logger-related; would be `log?: LoggerLike` (optional) if adopted |
| `google-api.ts` | 141, 152, 195, 203 | **4** | all object-first |
| `graph-mail.ts` | 246 | **1** | single `logger.info({ to, subject }, 'graph-mail: sent')` |
| `auto-restart.ts` | (none) | **0** | imports nothing logger-related; would be `log?: LoggerLike` (optional) if adopted |

**Total: 31 call sites across 5 of 7 files.** The two logger-free files (`settings-store.ts`, `auto-restart.ts`) need no LoggerLike migration today — a class refactor could pass `logger` to their constructors anyway, but the cost-benefit is "free parameter for zero call sites".

### How H.1's `LoggerLike` field replaces the current `logger` import

For each F class candidate:

| Class candidate | Constructor param | Body uses |
|---|---|---|
| `AgentRunner` | `private readonly log: LoggerLike` | `this.log.warn(...)`, `this.log.error(...)` (6 sites) |
| `ClaudeCodeBinResolver` | none — pure path resolver | n/a |
| `HeartbeatScheduler` | `private readonly log: LoggerLike` | `this.log.warn(...)`, `this.log.info(...)`, `this.log.error(...)`, `this.log.debug(...)` (18 sites) |
| `HeartbeatWorkerCwdBuilder` | `private readonly log: LoggerLike` | `this.log.warn(...)` (5 sites: 121, 142, 208, 219, 280) |
| `HeartbeatPromptBuilder` | none — pure string builder | n/a |
| `StoreWatcher` | `private readonly log: LoggerLike` | `this.log.warn(...)`, `this.log.info(...)` (3 sites) |
| `SettingsStore` | `log?: LoggerLike` (optional) | none today; would only use it if validation failures grew a logger call |
| `GoogleCalendarClient` | `private readonly log: LoggerLike` | `this.log.error(...)`, `this.log.info(...)` (4 sites) |
| `GraphMailClient` | `private readonly log: LoggerLike` | `this.log.info(...)` (1 site) |
| `AutoRestartDecisionPolicy` | n/a — file stays as free functions | n/a |

**Test impact:** all 31 call sites today are reached through the module-scope `import { logger }` from `./logger.js`. After H.1 lands, the test mocks of `logger.js` (the 91-file inventory in `h-cross-cutting/04-generic-interfaces.md:32-39`) keep working unchanged — the F class constructors take `LoggerLike`, but the production wiring still passes `logger` (the pino instance) directly, no cast. This matches H's "purely additive" guarantee.

---

## Generic opportunities — full table

Per the OE-6 test (a generic parameter must have a second consumer or a future-proofing argument stronger than "might be useful"), here is every F candidate considered and rejected:

| Candidate | File | OE-6 verdict |
|---|---|---|
| `HeartbeatScheduler<TContext>` over the settings source | `heartbeat.ts` | **REJECT.** One consumer (`settings-store.ts:getEffectiveSettingValue`); no second caller wants an alternate source. |
| `HeartbeatScheduler<TNotifier>` over `notifyTelegram` | `heartbeat.ts` | **REJECT.** One consumer, one impl. |
| `HeartbeatData<TKanban>` over the kanban shape | `heartbeat.ts` | **REJECT.** Shape is dictated by `db.ts:getHeartbeatKanbanSummary`. |
| `ClaudeSettings<TPlugins>` over the plugin map | `heartbeat.ts` | **REJECT.** Runtime shape is `Record<string, boolean>`; merge-with-anything requires the wide form. |
| `StoreWatcher<TActor extends string>` over the actor slot | `store-watcher.ts` | **REJECT.** Every caller passes a `string`; no second wants a union. |
| `SettingsStore<TKey>` / `SettingsStore<TValue>` | `settings-store.ts` | **REJECT.** Value type is fixed by `SettingDefinition`; key type narrowing forces every test to declare `TKey`. |
| `GoogleCalendarClient<TTokens>` over the token shape | `google-api.ts` | **REJECT.** Shape is dictated by the on-disk `tokens.json`. |
| `GraphMailClient<TCreds>` / `<TMessage>` | `graph-mail.ts` | **REJECT.** Same argument. |
| `LazyCache<K, V>` shared base over google-api + graph-mail caches | both | **REJECT.** Shared envelope is `{ value, mtimeMs }` for two consumers; the other three F caches diverge in shape. Matches E's `LockResult<T>` rejection. |
| `AgentRunner<TEnv>` over the env record | `agent.ts` | **REJECT.** One consumer, concrete shape. |
| `AgentResultClassification<TBlocked extends boolean>` narrowing text by blocked | `agent.ts` | **REJECT.** Consumers read `text` positionally; the blocked flag is logging-only. Matches D §4's `ValidateTokenResult` rejection. |
| `AutoRestartDecision<TRestart extends AutoRestartMode>` | `auto-restart.ts` | **REJECT.** Mode is a string-literal union read by the runner; not a class parameter. |
| `AutoRestartConfig` as a discriminated union (dailyTime vs intervalHours) | `auto-restart.ts` | **REJECT.** Invariant is enforced at the coercion boundary; consumers read both fields with `??` fallback. |

**Conclusion: F has zero generics worth introducing.** All F classes should be concrete-typed, mirroring E's verdict (`e-process-lock/04-generic-interfaces.md:189`) and D's verdict (`d-channel-provider/04-generic-interfaces.md:248-257`).

---

## Unsafe casts audit

### Per-file count

| File | `as any` | `: any` | `as unknown as` | `as const` | Total |
|---|---:|---:|---:|---:|---:|
| `agent.ts` | **4** (L178, 179, 182, plus L179's `as string` — actually 3 `as any` + 1 `as string`) | **1** (L194) | 0 | 0 | **5** |
| `heartbeat.ts` | 0 | 0 | 0 | 0 | **0** |
| `store-watcher.ts` | 0 | 0 | 0 | 0 | **0** |
| `settings-store.ts` | 0 | 0 | 0 | 0 | **0** |
| `google-api.ts` | 0 | 0 | 0 | 0 | **0** |
| `graph-mail.ts` | 0 | 0 | 0 | 0 | **0** |
| `auto-restart.ts` | 0 | 0 | 0 | 0 | **0** |

**Total across F: 5 unsafe casts, all in `agent.ts`.** The other six files have zero.

### Type-safety hotspot table

| File:line | Form | Severity | Why it's here | Refactor |
|---|---|---|---|---|
| `agent.ts:178` | `(event as any).subtype` | medium | The SDK's `query()` returns an async iterable of `unknown` (or a `ResultMessage` union that Marveen's types don't import). The cast narrows after `event.type === 'system'` to read `subtype`. | Introduce a local `interface AgentSdkSystemEvent` and a type guard `isAgentSdkSystemEvent(e): e is AgentSdkSystemEvent`. Eliminates the cast. |
| `agent.ts:179` | `(event as any).sessionId as string` | **high** | Double cast `unknown → any → string` with no runtime check. The `sessionId` is read positionally and used to build the return value. | Same type guard as L178; then `newSessionId = ev.sessionId ?? undefined`. Eliminates both casts and the `as string`. |
| `agent.ts:182` | `event as any` | medium | `classifyAgentResult` expects an object literal; the SDK event is structurally compatible but typed as `unknown`. | Promote the inline event-parameter type at L39-46 to a named `AgentSdkEvent` interface; both `classifyAgentResult`'s parameter and the call site use it. Eliminates the cast. |
| `agent.ts:194` | `catch (err: any)` | low | Standard codebase idiom for `AbortError` discrimination via `err?.name`. Present at `index.ts:555`, `process-lock.ts:347`, ~14 other sites. | Per `h-cross-cutting/04-generic-interfaces.md:113-115`, the codebase already accepts this idiom; no F-local action. |
| (rest of F) | none | — | — | — |

### Why the unsafe casts cluster in agent.ts

`agent.ts` is the only F file that integrates with the `@anthropic-ai/claude-agent-sdk` SDK, whose event union is not imported into Marveen's types. The casts at L178-182 are the boundary between Marveen's typed code and the SDK's `unknown` events. The single catch-all cast at L194 is the codebase-standard error idiom.

**Recommendation:** the L178-182 cluster is a 10-line region that could be cleaned up by a single local interface + type guard; the L194 catch is best left as codebase idiom unless the wider `unknown`-in-catch policy changes.

---

## Class-boundaries recommendation preview

Based on the type audit above, F's likely class candidates (for the next document `03-class-boundaries.md`):

| Class candidate | Source file | Lines | Logger sites | Generics | Casts to clean |
|---|---|---:|---:|---|---|
| `AgentRunner` | `agent.ts` | 122-216 (95) | 6 | none | 3 in L178-182 |
| `ClaudeCodeBinResolver` | `agent.ts` | 81-100 (20) | 0 | none (or `LazyBin<TName>` per H) | 0 |
| `HeartbeatScheduler` | `heartbeat.ts` | 483-598 (116) | 18 | none | 0 |
| `HeartbeatWorkerCwdBuilder` | `heartbeat.ts` | 36-283 (248) | 5 | none | 0 |
| `HeartbeatPromptBuilder` | `heartbeat.ts` | 392-447 (56) | 0 | none | 0 |
| `StoreWatcher` | `store-watcher.ts` | 47-160 (114) | 3 | none | 0 |
| `SettingsStore` | `settings-store.ts` | 17-111 (95) | 0 | none | 0 |
| `GoogleCalendarClient` | `google-api.ts` | 51-209 (159) | 4 | none | 0 |
| `GraphMailClient` | `graph-mail.ts` | 68-263 (196) | 1 | none | 0 |
| (none — keep as free fns) | `auto-restart.ts` | 1-122 (122) | 0 | n/a | 0 |

**Class count target: 9** (1 in `agent.ts` standalone, 1 shared `LazyBin` adoption, 3 in `heartbeat.ts`, 1 in `store-watcher.ts`, 1 in `settings-store.ts`, 1 in `google-api.ts`, 1 in `graph-mail.ts`). `auto-restart.ts` stays as free functions to preserve its dependency-free testability.

---

## Verifiability

Every claim above was verified against the working tree on 2026-08-30:

- All seven F files were read in full (`Read` tool).
- All grep counts (`interface`, `type`, `as any`, `: any`, `as unknown as`, `as const`, `export async function`, `let cached|recent|known|current|watcher|heartbeatTimeout|stopped|refreshInFlight`, `logger.<level>`) were run via `grep -nE`.
- The reference docs at `h-cross-cutting/03-class-boundaries.md`, `h-cross-cutting/04-generic-interfaces.md`, `e-process-lock/04-generic-interfaces.md`, `d-channel-provider/04-generic-interfaces.md` were read in full.
- The cross-references to H's `LoggerLike` shape, E's `OE-6` rejection of `LockResult<T>`, and D's `OE-6` rejection of `Provider<TConfig>` + `ChannelEnv<TEnv>` were read directly from those files (not from memory).
