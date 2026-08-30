# F (agent subsystem) — Generic interfaces

New interfaces F introduces (or rejects). Deliberately short: per
`review-completeness.md` OE-6, a generic parameter must have a second
consumer or a future-proofing argument stronger than "might be useful".
The `02-type-interface-analysis.md §Generic opportunities — full table`
already evaluates every F candidate and **rejects all 13** of them
(verified by direct read on 2026-08-30). This document reconciles that
verdict with the brief's three explicit candidates, accepting the
brief's counter-arguments where they survive scrutiny and rejecting
them where they do not.

---

## §1. `LazyCache<K, V>` — REJECTED

### Brief asks for

The brief (`f-agent-subsystem` task description) asks for a
`LazyCache<K, V>` base sketch consolidating the three lazy-cache classes
(`ClaudeCodeBinResolver`, `GoogleApiClient`, `GraphMailClient`),
explicitly citing 3 consumers as justification (vs H's `TtlCache` which
had 1).

### Source reality

The three caches share the concept "memoised on-disk state" but **diverge
in every detail of shape and invalidation**:

| Cache | File:line | Invalidation | Refresh pattern |
|---|---|---|---|
| `cachedClaudeCodeBin` | `agent.ts:81` | process-lifetime manual | re-resolve is unconditional on next call |
| `cachedTokens` + `cachedClient` | `google-api.ts:51-52` | mtime-invalidated + process-lifetime | re-read + parse + mutate; `refreshInFlight` single-flight |
| `cachedCreds` + `cachedToken` | `graph-mail.ts:68, 132` | mtime-invalidated + clientId-bound + expiresAt | re-read + parse + mutate; no single-flight |

A `LazyCache<K extends string, V>` base that fits all three would need:
- (a) a `loader: () => V` for the first-call memo pattern (claude)
- (b) a `mtimeSource: () => number` for mtime-invalidation (google creds, graph creds)
- (c) an `expiresAtSource: () => number` for TTL-invalidation (graph token)
- (d) a `clientIdBinding: (loaded: V) => string` for clientId-invalidation (graph token)
- (e) a `refreshInFlight: Promise<V> | null` cell shared at module scope (google)

That's five orthogonal axes; a class that parameterises on all five is
not a "consolidating base" — it's a confused protocol with one
inhabitant per axis.

### What the brief's "3 consumers" argument actually buys

The brief argues: "H's `TtlCache` was rejected for single consumer —
these 3 are 3 consumers". **The OE-6 test is not "how many consumers"
but "does the shared envelope have a load-bearing shape that all
consumers use".** H's `TtlCache<K, V>` was rejected not because it had
one consumer, but because the shared envelope `{ value: V; mtimeMs: number }`
did not represent the actual shape of any consumer
(`review-completeness.md OE-6` and `h-cross-cutting/04-generic-interfaces.md §X`
both cite this). The same logic applies here: the three F caches have
*different* envelopes.

### Verdict: REJECTED

Per `02 §Lazy-cache cluster type comparison` and `02 §Generic
opportunities — full table` row "LazyCache<K, V> shared base over
google-api + graph-mail caches" (REJECT). The three caches become three
independent concrete classes (`ClaudeCodeBinResolver extends LazyBin`,
`GoogleApiClient`, `GraphMailClient`). The `refreshInFlight` singleton
hazard in `GoogleApiClient` is preserved as a `private static` field per
FR3, not factored into a shared base.

### What to keep instead

Three module-level cells per file, captured as private fields when each
file becomes a class. The cluster's structural similarity is documented
in `03-class-boundaries.md §Lazy-cache cluster notes` but does not
produce a shared base class. The `RemoteStatusCache<T>` precedent at
`web/remote-status-cache.ts:19` (per `review-completeness.md CE-9`) is
the right reference for "how do you write a generic cache", but it is
not load-bearing on any F cache shape.

---

## §2. `HeartbeatObserver<TDecision>` — REJECTED (speculative)

### Brief asks for

"IF the heartbeat emits events to subscribers, sketch the observer
generic".

### Source reality

The heartbeat subsystem **does NOT emit events that other modules
subscribe to today**. The internal flow is `executeHeartbeat` →
`notifyTelegram` (line 554) directly. There is no `EventEmitter`, no
`onNotify` / `onSkip` callback registration, no observer pattern in
the file (verified by `grep -rn "EventEmitter\|onNotify\|onSkip"
src/heartbeat.ts` — zero matches).

The single callback registration in the F subsystem is
`StoreWatcher`'s watch event (per `03-class-boundaries.md §F3` method
`onChange(handler: WatchHandler)`), and `StoreWatcher`'s callback
signature is **fixed** (`WatchHandler`), not generic — there is no
parameter for the observer to specialise on.

### Speculative sketch

```ts
interface HeartbeatObserver<TDecision> {
  onTickStart(tickId: string): void
  onDecision(tickId: string, decision: TDecision): void
  onTickEnd(tickId: string, durationMs: number): void
}

class HeartbeatScheduler {
  subscribe(observer: HeartbeatObserver<HeartbeatDecision>): void
}
```

### Verdict: REJECTED (speculative per OE-6)

The `02 §Heartbeat decision types — The hook/observer pattern` verdict:
"If a future feature wanted 'let other modules observe heartbeat ticks',
the natural class form would expose a `private listeners:
Array<(tick: HeartbeatTickResult) => void>` field with `on(cb)` /
`off(cb)` methods. **Not in scope today** — flagged only because the
brief asked about it."

This sketch has **zero consumers**. Adding it would create a class
surface with no production reader — the exact failure mode OE-6 names.
The `TDecision` parameter is doubly unjustified: there is no observer,
and there is no decision type to specialise on (the three heartbeat
decisions all return `boolean` or `'launchd' | 'tmux-respawn'`, not a
discriminated union per `02 §Heartbeat decision types — Should they
become discriminated unions?` — rejected).

If a future feature wants observer semantics, the sketch above can be
added as part of that feature, not pre-emptively here.

---

## §3. `AutoRestartSchedule<TDecision>` — REJECTED

### Brief asks for

"IF the decision types diverge enough to warrant generic, sketch the
generic".

### Source reality

Per `02 §AutoRestart deep-dive` and `02 §Generic opportunities` row
"`AutoRestartDecision<TRestart extends AutoRestartMode>`" (REJECT):

> "The mode is a string-literal union read by the runner, not a class
> type parameter. Rejected (matches D §4's 'discriminated union
> temptation' rejection)."

The single consumer pattern (`web/auto-restart-runner.ts:16`,
`web/auto-restart-store.ts:9`) reads the mode and the config
positionally. The `TDecision` parameter would have to bind to a
discriminated union that does not exist today (per the brief's
`AutoRestartDecision = { kind: 'due' } | { kind: 'not-due' }` shape,
which is a new type introduced *as part of* the F.5 migration).

### Verdict: REJECTED

The `TDecision` parameter has one consumer. Adding it threads through
the new shape (`decideShouldRestart`'s return type) without compile-time
benefit. Per OE-6, dropped.

### What to keep instead

`AutoRestartSchedule.decideShouldRestart(facts: RestartFacts):
AutoRestartDecision` returns a concrete tagged-union type (introduced
in `03-class-boundaries.md §F8`). The class itself is not generic.
This mirrors the framework-wide verdict on `02 §Heartbeat decision
types`: "Three existing logger.info / logger.warn / logger.error
messages already encode the outcome at the log level; a structured
return would duplicate the signal."

---

## §4. Considered and rejected (full table)

| Candidate | Source of the idea | Why rejected |
|---|---|---|
| `LazyCache<K, V>` over 3 F caches | F brief §"LazyCache base sketch" | Different envelopes (process-lifetime / mtime / mtime+clientId+expiresAt). 5 orthogonal axes would parameterise. Rejected per OE-6 and per `02 §Lazy-cache cluster type comparison` verdict. |
| `HeartbeatObserver<TDecision>` | F brief §"HeartbeatObserver" | No observer pattern today (verified `grep` returns 0). `TDecision` parameter has zero consumers. Speculative per OE-6. |
| `AutoRestartSchedule<TDecision>` | F brief §"AutoRestartSchedule<TDecision>" | Mode is string-literal union read positionally by the runner. Single consumer. Rejected per OE-6 and per `02 §Generic opportunities` row. |
| `HeartbeatScheduler<TContext>` over the settings source | `02 §Generic opportunities` | One consumer (`settings-store.getEffectiveSettingValue`). Rejected. |
| `HeartbeatScheduler<TNotifier>` over `notifyTelegram` | `02 §Generic opportunities` | One consumer, one impl. Rejected. |
| `HeartbeatData<TKanban>` over the kanban shape | `02 §Generic opportunities` | Shape dictated by `db.ts:getHeartbeatKanbanSummary`. Rejected. |
| `ClaudeSettings<TPlugins>` over the plugin map | `02 §Generic opportunities` | Runtime shape is `Record<string, boolean>`; merge-with-anything requires the wide form. Rejected. |
| `StoreWatcher<TActor extends string>` | `02 §Generic opportunities` | Every caller passes a `string`. Rejected. |
| `SettingsStore<TKey>` / `<TValue>` | `02 §Generic opportunities` | Value type fixed by `SettingDefinition`; key narrowing forces every test to declare `TKey`. Rejected. |
| `GoogleCalendarClient<TTokens>` | `02 §Generic opportunities` | Shape dictated by on-disk `tokens.json`. Rejected. |
| `GraphMailClient<TCreds>` / `<TMessage>` | `02 §Generic opportunities` | Same. Rejected. |
| `AgentRunner<TEnv>` | `02 §Generic opportunities` | One consumer, concrete shape. Rejected. |
| `AgentResultClassification<TBlocked extends boolean>` | `02 §Generic opportunities` | Consumers read `text` positionally; blocked flag is logging-only. Rejected. |
| `AutoRestartConfig` as discriminated union | `02 §Options/config patterns` | Invariant enforced at coercion boundary; consumers read both fields with `??` fallback. Rejected. |

**Net conclusion: F has zero generics worth introducing.** All F
classes are concrete-typed, mirroring E's verdict
(`e-process-lock/04-generic-interfaces.md:189`) and D's verdict
(`d-channel-provider/04-generic-interfaces.md:248-257`).

---

## §5. The `Notifier` interface — a small surface the brief implies

### What it is

The `HeartbeatScheduler` constructor takes a `notifier: Notifier`
parameter. The brief is silent on what `Notifier` looks like, but
`02 §Entity types / class candidates` row "`HeartbeatScheduler`"
notes "`notifyTelegram` (line 554)" as the single notifier consumer.

### Sketch

```ts
type Notifier = (text: string) => Promise<void>
```

Or, if the brief's intent is a more structured surface:

```ts
interface Notifier {
  notify(text: string): Promise<void>
}
```

### Verdict: SPE — speculative type alias, not a new interface

The `Notifier` shape is a one-line type alias with one consumer
(`heartbeat.ts:554`'s `notifyTelegram`). Adding an interface adds a
named type with no benefit over the alias. The class form uses the
alias; if a second consumer materialises, the alias is replaced by a
named interface then.

---

## §6. The `WatchHandler` callback type — already concrete

### What it is

The `StoreWatcher.onChange(handler: WatchHandler)` callback takes a
single concrete shape:

```ts
type WatchHandler = (event: {
  rel: string
  kind: 'create' | 'delete' | 'update'
  fileSize: number | null
  actor: string | null
}) => void
```

This is per the brief and per `03-class-boundaries.md §F3`. There is
no parameter — the handler signature is fixed by the rename-dedup
pipeline.

### Verdict: NO new generic interface

The `WatchHandler` type is the concrete event shape; no
parameterisation is needed. The event shape is dictated by the
`store-watcher.ts` filter chain (`isSystemFile`, `recentEvents`
dedup, `logStoreFileEvent` consumer) and is not load-bearing on
subscriber type.

---

## Net verdict

**F introduces zero new generic interfaces.** The three candidates the
brief asked about (`LazyCache<K, V>`, `HeartbeatObserver<TDecision>`,
`AutoRestartSchedule<TDecision>`) all fall to OE-6:

- `LazyCache<K, V>` because the three caches have different envelopes,
  not just different consumers.
- `HeartbeatObserver<TDecision>` because there is no observer pattern
  today (zero `onNotify` / `onSkip` / `EventEmitter` matches).
- `AutoRestartSchedule<TDecision>` because the mode is a string-literal
  union read positionally, not a class type parameter.

The F classes are concrete-typed, with two non-generic named types
introduced as part of the migration:

- `type Notifier = (text: string) => Promise<void>` — a type alias
  with one consumer; replaceable if a second consumer materialises.
- `type WatchHandler = (event: { rel; kind; fileSize; actor }) => void` —
  the concrete event shape for `StoreWatcher.onChange`.

This mirrors the framework-wide verdict: zero generics worth introducing
across the 8 F class candidates.
