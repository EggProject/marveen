# H (cross-cutting) — Generic interfaces

New interfaces H introduces. Deliberately short: `review-completeness.md`
OE-1 through OE-9 rejected six of the framework's eight generic proposals for
having no second consumer, and this document is written to avoid being the
seventh. Two interfaces are proposed. A third section explains what was
considered and rejected.

---

## §L. `LoggerLike`

### Purpose

Give every class in Parts A, B, C, D and E a constructor-parameter type for a
logger, without forcing them to import `pino`'s concrete `Logger` type and
without forcing 91 test files to construct a full pino instance.

### Correction to `04-generic-interfaces.md` G5 (required before use)

The framework's G5 (`04-generic-interfaces.md:243-246`) defines:
```ts
import type { Logger } from 'pino'
type LoggerLike = Logger
```

A bare re-alias of `pino.Logger` **defeats the entire purpose**. Measured:
91 test files mock `logger.js`, and the mock-object shapes are:

| Shape | Files |
|---|---:|
| `{info, warn, error, debug}` | 64 |
| `{info, warn, error, debug, level}` | 7 |
| (mock factory with no method literals — delegates to a shared fixture) | 6 |
| `{info, warn, error}` | 4 |
| `{info, warn, error, debug, trace, fatal}` | 3 |
| `{child, info, warn, error, debug}` | 2 |
| `{info, error}` | 1 |
| `{info, warn, debug}` | 1 |

`pino.Logger` carries ~20 members (`trace`, `fatal`, `silent`, `flush`,
`bindings`, `setBindings`, `isLevelEnabled`, `levels`, `version`, `on`/`off`
from `EventEmitter`, …). **Not one** of the 91 mocks satisfies it. Aliasing
`LoggerLike = Logger` means every constructor-injection test must build a
full pino instance or reach for `as unknown as Logger` — the exact cast that
`02-type-interface-analysis.md` identifies as the codebase's lone
logger-related unsafe cast (`src/__tests__/vault.test.ts:120`). G5 as written
multiplies that cast by 91 instead of deleting it. It must be replaced with
the structural minimum below.

### Sketch

```ts
// src/logger.ts

/** The call shape every logger method must accept. Mirrors pino's own
 *  overload set (node_modules/pino/pino.d.ts:345-352) narrowed to the two
 *  forms this codebase actually uses. */
export interface LogFn {
  (msg: string): void
  (obj: object, msg?: string): void
}

export interface LoggerLike {
  readonly info: LogFn
  readonly warn: LogFn
  readonly error: LogFn
  readonly debug: LogFn
}
```

### Which pino members MUST be present

| Member | Required? | Evidence |
|---|---|---|
| `info` | **MUST** | present in 84 of 91 test mocks; hundreds of prod call sites |
| `warn` | **MUST** | 83 of 91 mocks |
| `error` | **MUST** | 84 of 91 mocks |
| `debug` | **MUST** | 79 of 91 mocks; 40+ prod call sites incl. `heartbeat.ts:488`, `db.ts:2443`, `web/channel-monitor.ts:1415`, `web/schedule-runner.ts:1064` |

Adding `debug` forces updates in the ~12 test files whose mock omits it. That
is the correct trade: a mock without `debug` is already latently broken —
any SUT reaching a `logger.debug` line under such a mock throws
`TypeError: logger.debug is not a function` today. Making the interface
require it converts a runtime failure into a compile-time one.

### Which pino members MAY be omitted

| Member | Omit? | Evidence |
|---|---|---|
| `child(bindings)` | **OMIT** | zero production callers (`grep -rn "logger\.child(" src/ \| grep -v __tests__` → none); present in only 3 of 91 mocks (`vault.test.ts:120`, `auth.test.ts:183`, one other). Requiring it invalidates 88 mocks to serve zero consumers. |
| `trace`, `fatal` | **OMIT** | zero production callers; present in 4 mocks (e.g. `auth.test.ts:181-182`) |
| `level` (read/write) | **OMIT** | zero production reads (`grep -rn "logger\.level" src/` → none). Present in 8 mocks (`auth.test.ts:184` sets `level: 'silent'`) — harmless extra members, structurally compatible. |
| `_level` | **MUST OMIT** | pino internal, read white-box at `logger.test.ts:33` and `:42`. Those two assertions must stay on the concrete pino type. |
| `flush`, `silent`, `bindings`, `isLevelEnabled`, `levels` | **OMIT** | zero callers anywhere |

### Variance

`LoggerLike` is **non-generic**, so variance is not a question — this is
deliberate. `02-type-interface-analysis.md` proposes
`LoggerLike<L extends LogRecord>` with `LogFn<L> = (record: L, msg?: string) => void`.
Two problems, both fatal:

1. **The record-first-only signature does not compile against the source.**
   Of 744 production `logger.<level>(` calls, 76 are string-first —
   `logger.debug('Heartbeat: outside active window, skipping')`
   (`heartbeat.ts:488`), `logger.info('Heartbeat ellenorzes indul...')`
   (`heartbeat.ts:492`), `logger.info('channel-coordinator: native channel
   back UP, yielding to native (-> idle)')` (`channel-coordinator.ts:355`),
   `logger.debug('schedule-runner: previous tick still running, skipping this
   tick')` (`schedule-runner.ts:1064`), `logger.debug('inbound-prober:
   ALLOWED_CHAT_ID still absent -- skipping')` (`inbound-probe.ts:246`).
   Plus ~42 further sites that are neither `({`-first nor quote-first
   (variable-first / multi-line). The two-overload `LogFn` above accepts all
   of them; `(record: L, msg?: string) => void` accepts none of the 76.
2. **The parameterisation has no consumer.** Nothing in `src/` declares a
   per-module log-record type. `02`'s own conclusion — "the conservative path
   is to keep `L` invariant and require every consumer to declare its own
   log-record type at the context boundary" — describes work that would have
   to be *created* to justify the parameter. That is
   `review-completeness.md` OE-6's pattern verbatim.

`obj: object` (rather than `Record<string, unknown>`) is chosen so that
`logger.error({ err }, 'msg')` and `logger.info(someTypedRow, 'msg')` both
pass without a cast. The narrower `Record<string, unknown>` used by the
existing `LogFn` at `process-lock.ts:19` is *stricter* than pino and would
reject an interface-typed argument (interfaces have no implicit index
signature in TypeScript). Since `process-lock.ts:19`'s alias is being deleted
by H.1 anyway, widening to `object` is the compatible direction.

### Compatibility with the production type

`pino.Logger` structurally satisfies `LoggerLike`: it has `info`, `warn`,
`error`, `debug`, each typed as pino's `LogFn`
(`node_modules/pino/pino.d.ts:345-352`), whose overload set is a superset of
the two forms above. So `const l: LoggerLike = logger` compiles with no cast.
This one-directional assignability is what makes H.1 purely additive. It must
be pinned by a compile-time test — see `06-risks-and-mitigations.md` HR4.

### Usage examples (signatures only)

```ts
// src/process-lock.ts — replaces `type LogFn` at :19 and the triple at :49 / :253
export interface ProcessLockContext {
  // ...
  log: LoggerLike
}

// A converted consumer in Part A / B / C / D / E
class SomeStore {
  constructor(private readonly log: LoggerLike, /* ... */) {}
}
```

### Adopters

Supersedes `04-generic-interfaces.md` G5's adopter list, which is otherwise
correct: `src/process-lock.ts` (`:19`, `:49`, `:253`), `src/index.ts`
(`:171-175`, `:280-287`), and every class in `03-class-boundaries.md` that
takes a logger — A1, A3, A4, A6, A8, A10, A11, A12, B1, B2, B3, B5, C2, C3,
D1, E1, E2.

---

## §Z. `LazyBin<TName, TResolved>`

### Sketch

```ts
// src/platform.ts

export class LazyBin<TName extends string = string, TResolved extends string = string> {
  constructor(name: TName, resolver?: (name: TName) => TResolved)
  readonly name: TName
  resolve(): TResolved
  invalidate(): void
}
```

### Type parameters and constraints

| Param | Constraint | Justified today? |
|---|---|---|
| `TName` | `extends string` | **Yes.** Makes `new LazyBin('tmux')` infer `LazyBin<'tmux'>`, distinct from `LazyBin<'claude'>`. Prevents passing a `tmux` resolver where a `claude` resolver is expected — a real confusion in files that hold both, e.g. `web/agent-process.ts:56-57`, `web/channel-monitor.ts:53-54`, `web/routes/background-tasks.ts:14-15`. |
| `TResolved` | `extends string`, defaults to `string` | **No.** `resolveFromPath` returns `string` (`platform.ts:61`) and no narrower inhabitant exists anywhere in `src/`. Included because the brief specified two parameters; defaulted so no call site must supply it, and so `LazyBin<'tmux'>` remains a legal one-argument instantiation. **Recommendation: drop `TResolved` before implementation** unless a second resolver with a narrower return type appears. Keeping it is `review-completeness.md` OE-6's "generic with one consumer" pattern in miniature. |

### Variance

Both parameters are **invariant**. `TName` appears in the constructor
(contravariant position) and as a `readonly` field (covariant position), which
forces invariance. `TResolved` appears only in `resolve()`'s return
(covariant) and in the optional `resolver` callback's return (also
covariant), so it *could* be declared `out TResolved` — but TypeScript's
variance annotations are inference hints only and, with `TResolved` defaulted
to `string`, there is no call site that would benefit. Leave it unannotated.

`review-correctness.md` R5's guidance ("default invariance + no `as` at the
boundary") applies directly: neither parameter needs a cast at any boundary
because both are inferred from the constructor argument.

### `resolve()` throws — it does not return null

Restated here because `04-generic-interfaces.md:371` gets it wrong:
`resolve(): TResolved`, throwing `Error('Required binary not found on PATH:
<name>')` when unresolvable, matching `resolveFromPath` at `platform.ts:61-65`
and the existing closure return type `() => string` at `platform.ts:74`. A
`string | null` return would convert 14 throwing call sites into sites that
pass `null` into a shell command line.

### Usage examples (signatures only)

```ts
// Current shape (11 files, 14 invocations) — unchanged by H.3
const tmuxBin = makeLazyBinResolver('tmux')   // platform.ts:74 factory kept
tmuxBin()                                      // -> string, throws if absent

// New shape, available to any consumer that wants invalidate()
const claudeBin = new LazyBin('claude')        // LazyBin<'claude'>
claudeBin.resolve()                            // -> string
claudeBin.invalidate()                         // drop the memoised path
```

### Adopters

- `src/platform.ts` — `makeLazyBinResolver` (`:74`) is reimplemented over
  `LazyBin`; its exported signature is unchanged.
- `src/agent.ts` `ClaudeCodeBinResolver` (framework `03 §C1`) — the framework
  already describes it as "a more specialized version" of `LazyBin`. This is
  the second consumer that justifies the class existing at all.
- (Deferred, not H.3) `web/claude-credentials-guard.ts:142` / `:327` and
  `web/agent-worker.ts:547`, which today call `resolveFromPath('claude')`
  eagerly and thereby bypass memoisation entirely.

---

## §X. Considered and rejected

| Candidate | Source of the idea | Why rejected |
|---|---|---|
| `LoggerLike<L extends LogRecord>` (generic over log-record shape) | `h-cross-cutting/02-type-interface-analysis.md` §LoggerLike | Rejected on evidence: breaks 76 string-first call sites; no module in `src/` declares a log-record type, so the parameter has zero consumers. See §L Variance. |
| `TypedError<TPayload>` replacing 8 of 9 error classes | `h-cross-cutting/01-module-state-analysis.md` §5 | Rejected. All 15 production discrimination sites use `instanceof` on the concrete class (`channel-coordinator.ts:335`, `index.ts:555`, `web/vault.ts:49`, `web/routes/schedules.ts:134`, …). Collapsing nine nominal types into one generic destroys exactly the discriminator those sites depend on. `03-class-boundaries.md` §C3 proposes an additive `AppError` base instead. |
| `BoundedSizeError` shared parent for `RequestBodyTooLargeError` + `PeerResponseTooLargeError` | `h-cross-cutting/01-module-state-analysis.md` §3 taxonomy observations | Rejected. The two are structurally identical (`http-helpers.ts:25`, `federation/http.ts:7`) but semantically opposite — one guards *inbound* request bodies, the other guards *outbound* peer responses. Their four `instanceof` consumers must stay able to tell them apart. `AppError` already supplies everything a shared parent would. |
| `AppError.code: string` discriminator slot | `h-cross-cutting/02-type-interface-analysis.md` §Taxonomy recommendation | Rejected. Zero project error classes carry a `code` today; all 10 `code === '...'` checks in production are Node errno codes (`index.ts:229`, `:250`, `web.ts:226`, `web/claude-credentials-guard.ts:154`, `web/routes/updates.ts:149`). Adding a second discrimination axis with no consumer, in a namespace that already collides with errno, is net-negative. See `06-risks-and-mitigations.md` HR6. |
| A `TtlCache<K, V>` for the logger or platform layer | framework `04 §G2` | Out of H's scope entirely, and already rejected by `review-completeness.md` OE-6 / CE-9 in favour of the existing `RemoteStatusCache<T>` at `web/remote-status-cache.ts:19`. Noted here only so H is not read as re-opening it. |
