# H (cross-cutting) — Type & Interface Analysis

**Scope:** `src/logger.ts`, `src/platform.ts`, and 9 error-class sites
across `process-lock`, `remote-enroll-core`, `channel-coordinator/telegram-client`,
`web/federation/http`, `web/fleet-transfer`, `web/password-hash`,
`web/remote-status-cache`, `web/federation/poller`, `web/http-helpers`,
`web/keychain`. Planning only — no source modifications.

---

## Brief summary

The H subsystem is type-clean at the leaf level: `logger.ts` exports a
10-line pino singleton with no abstract surface, `platform.ts` exposes
three small typed functions (`PlatformType` literal union + the
`makeLazyBinResolver(name): () => string` closure) with no unsafe casts,
and the 9 error classes all extend `Error` directly with typed `readonly`
fields where present. The two soft spots are (1) **logger consumption** —
the codebase effectively speaks two dialects (full pino via
`import { logger }`) and the narrower `{ info, warn, error }` triple
defined as `LogFn` in `process-lock.ts:19/49/253`, and (2) **error
metadata** — only `TelegramApiError` carries a `kind` discriminator, the
remaining 8 classes either pass nothing or pass ad-hoc fields, and no
class chains cause via the ES2022 `{ cause }` option. There is no
`as any` / `: any` related to logger or platform in production code; the
sole unsafe cast is in the test factory at `vault.test.ts:120`
(`as unknown as { child: () => typeof stub }`), which would be obviated
by exporting a `LoggerLike` interface from `logger.ts`.

---

## LoggerLike design

### Surface actually consumed (the minimum needed)

Empirically — across 50+ `logger.` call sites in `src/` and 4 test
mocks — the pino surface that the codebase actually exercises is:

| Member | Source callers | Test mocks |
|---|---|---|
| `info(obj?, msg?)` | ubiquitous (`logger.info({ ... }, 'msg')`) | stub |
| `warn(obj?, msg?)` | ubiquitous | stub |
| `error(obj?, msg?)` | ubiquitous | stub |
| `debug(obj?, msg?)` | `heartbeat.ts:488`, `memory.ts:150` | stub |
| `child(bindings)` | **zero** callers in `src/` | `vault.test.ts:118-120` (stub) |
| `trace`, `fatal`, `flush`, `silent`, `setLevel`, `_level` | none in `src/` | only `logger.test.ts:33/42` reads `_level` |

`child()` is therefore only a future-looking concern; today no
production code path uses it, but the test stub preserves it because
the comment at `vault.test.ts:117-119` says "any caller that does
`logger.child(...)` doesn't blow up" — i.e. defence-in-depth, not a
real consumer.

### Recommended `LoggerLike` sketch

A minimum-surface interface, **covariant in T (the log-record payload)**,
looks like (planning sketch only, not committed):

```ts
export interface LogRecord { /* string-keyed, value-type-bounded */ }
export interface LoggerLike<L extends LogRecord = LogRecord> {
  readonly info:  LogFn<L>
  readonly warn:  LogFn<L>
  readonly error: LogFn<L>
  readonly debug: LogFn<L>
  readonly child: (bindings: L) => LoggerLike<L>
}
export type LogFn<L> = (record: L, msg?: string) => void
```

Constraints / variance notes:

- **Covariance of `L`**: pino's `Logger<CustomLevels>` is invariant in
  its generic parameter in practice (because `child()` returns the
  same shape). For a classbase wrapper, declaring `L` covariant
  (`out L`) is sound **only if** we drop `child()` from the interface
  or make the return type a fresh type variable (`out L`) that the
  child pins. The conservative path is to keep `L` invariant and
  require every consumer to declare its own log-record type at the
  context boundary.
- **Why this matters for classbase**: today the codebase has two
  surface widths — full pino for free-form `logger.info({err, rel}, 'msg')`
  calls and the `LogFn` triple in `process-lock.ts`. A `LoggerLike`
  interface parameterizable over the record shape would let
  `ProcessLockContext.log` accept either a `LoggerLike<ProcessLockLog>`
  or the full pino instance (with `unknown` record), without the
  per-call-site `as` workaround that index.ts:171-176 currently uses
  to *manufacture* the narrow triple from the wide logger.
- **Pino binding for production**: the classbase wrapper would be a
  `class PinoLogger implements LoggerLike` whose constructor takes a
  `pino.Logger`; the `_logger.info(record, msg)` method is a thin
  forwarder, no rebinding needed.
- **`child` semantics**: today pino's `child()` produces a new logger
  with merged bindings. In classbase form `child(bindings)` would
  return `new PinoLogger(this._logger.child(bindings))` so callers
  retain the fluent API. The test stub at `vault.test.ts:120` would
  become typed and the unsafe cast removed.
- **`unknown` vs `Record<string, unknown>`**: pino accepts arbitrary
  payloads. `LogFn` in `process-lock.ts:19` uses
  `Record<string, unknown>` which is stricter than necessary but
  adequate; `LoggerLike` should follow the same pattern or use a
  free `unknown` and tighten only at the typed-record layer.

### What this does NOT solve

- `process-lock.ts:19` defines `LogFn` privately to the module. A
  `LoggerLike` exported from `logger.ts` would subsume it and let
  `process-lock.ts` drop its local declaration, but the migration is
  a separate task.
- The pino-typed `logger._level` reads at `logger.test.ts:33/42` are
  white-box and should stay on the concrete `pino.Logger` type — do
  not include `_level` on `LoggerLike`.

---

## LazyBin generic sketch

### Current signature

```ts
// platform.ts:74
export function makeLazyBinResolver(name: string): () => string
```

The closure captures one cell: `let cached: string | null = null` —
typed cleanly, no unsafe cast.

### Generic sketch

A two-parameter generic over (name, resolved-value) shape, with the
name literal-string as the variance-driving parameter:

```ts
export interface LazyBin<N extends string = string, R extends string = string> {
  readonly name: N
  (): R
}

export function makeLazyBinResolver<N extends string>(
  name: N,
  resolve?: (name: N) => string,
): LazyBin<N, string>
```

Constraints:

- `N extends string`: forces the name to be a literal-string subtype at
  the call site so the returned closure's call signature is at least
  parameter-narrowed (`LazyBin<'tmux'>` is a stricter type than
  `LazyBin<string>`).
- `R extends string`: the resolved value is always a filesystem
  absolute path. No need for a wider constraint; if a caller wants a
  non-path resolved value, it should not use `LazyBin`.
- The current code base uses only `string` (no literal narrowing) in
  8 call sites (see grep: `makeLazyBinResolver` callers in
  `channel-coordinator/liveness.ts:20`, `web/channel-mcp-reconnect.ts:11`,
  `web/agent-process.ts:56-57`, `web/agent-worker.ts:43`,
  `web/channel-plugin-unlock.ts:40`, `web/mcp-list.ts:13`,
  `web/stuck-tool-call-watcher.ts:54`, `web/reauth-healer.ts:32`).
  Literal-typing these as `'tmux'` / `'claude'` is a no-op for the
  caller and a small win for downstream type-narrowing.
- The optional second `resolve` parameter would let
  `claude-credentials-guard.ts:142/327` and `agent-worker.ts:502`
  (which today use the eager `resolveFromPath('claude')` directly,
  bypassing the cache) plug into the same shape without an
  ad-hoc factory closure.

### Where it would replace ad-hoc factory closures

- `web/claude-credentials-guard.ts:142/327`: today
  `const bin = claudeBin ?? resolveFromPath('claude')` — the eager
  `resolveFromPath` defeats the lazy/memoised purpose. A typed
  `LazyBin<'claude'>` consumed by the surrounding helper would unify
  the eager and lazy paths under one resolver type.
- `web/agent-worker.ts:502`: `const claudeLaunchBin = tryResolveFromPath('claude') ?? 'claude'` —
  the `?? 'claude'` fallback silently degrades to PATH-resolution
  on a transient PATH gap, the exact failure `makeLazyBinResolver`
  was designed to avoid. Typed `LazyBin<'claude'>` would surface
  the inconsistency.
- `web/agent-worker.ts:547`: `const claudeBin = resolveFromPath('claude')` —
  same eager call inside a hot path; a shared `LazyBin` is the
  natural fit.

### Unsafe casts in PLATFORM resolution

None. `process.env['MARVEEN_ENV']`, `process.env['XDG_SESSION_TYPE']`,
`process.env['DISPLAY']`, `process.env['WAYLAND_DISPLAY']` reads at
`platform.ts:9/13/15-17` use bracket-notation for index-signature
access without `as`. The `detect()` return type `PlatformType` is
narrowed by the literal comparisons and the platform module's `as`
/`any` count is zero.

---

## Error class audit table

| Class | File:Line | Fields (typed) | Accepts `cause`? | Has `code`/`kind`? | Extends | Suggested taxonomy slot |
|---|---|---|---|---|---|---|
| `DeferToPeerError` | `process-lock.ts:272` | `readonly peerPid: number` | no | no | `Error` | **Domain / control-flow**: thrown on a known intentional code path (defer-to-peer) |
| `RemoteEnrollError` | `remote-enroll-core.ts:30` | (none — message only) | no | no | `Error` | **Validation**: input-shape failures from CLI enrollment |
| `TelegramApiError` | `telegram-client.ts:45` | `readonly kind: TelegramErrorKind` (4-value union), `readonly retryAfterSec?: number` | no | **yes — `kind`** | `Error` | **Domain / external-API**: classified by HTTP outcome; candidate for sealed hierarchy or union |
| `PeerResponseTooLargeError` | `web/federation/http.ts:7` | (none — `limit` mentioned in message but not stored) | no | no | `Error` | **Domain / I/O bound**: paired with `RequestBodyTooLargeError` (mirror shape) |
| `UserFacingError` | `web/fleet-transfer.ts:36` | (none) | no | no | `Error` | **Presentation**: route maps to 400 not 500 — orthogonal classification |
| `PasswordPolicyError` | `web/password-hash.ts:40` | (none) | no | no | `Error` | **Validation**: pre-hash guard failure |
| `RemoteStatusCache<T>` *(not an error)* | `web/remote-status-cache.ts:19` | generic class `T` (the cached value) | n/a | n/a | n/a | n/a — already a properly generic class; no refactor needed |
| `FederationPollInternalError` | `web/federation/poller.ts:68` | `readonly peerId: string`, `readonly cause: unknown` | **declared, but NOT passed to `super`** | no | `Error` | **Domain / invariant**: belt-catch for a regression that should be impossible |
| `RequestBodyTooLargeError` | `web/http-helpers.ts:25` | `readonly limit: number` | no | no | `Error` | **Domain / I/O bound**: mirrors `PeerResponseTooLargeError` |
| `KeychainUnavailableError` | `web/keychain.ts:19` | (none — no constructor; uses `extends Error {}` default) | no | no | `Error` | **Domain / environment**: macOS-only resource unavailable |

### Per-class findings

1. **Field strictness** — five classes store no fields at all
   (`RemoteEnrollError`, `UserFacingError`, `PasswordPolicyError`,
   `PeerResponseTooLargeError`, `KeychainUnavailableError`). Of those,
   `PeerResponseTooLargeError` *references* a `limit` in the message
   string but does not store it as a typed field — a small loss for
   programmatic introspection. `RequestBodyTooLargeError` does store
   `readonly limit: number` (mirror shape, lost opportunity on the
   peer-response side).

2. **Constructor signatures** — three positional patterns exist:
   - `(message: string)` — 4 classes (all message-only).
   - `(field, message)` — 2 classes (`DeferToPeerError(peerPid)`,
     `TelegramApiError(kind, message, retryAfterSec?)`).
   - `(field1, field2)` — 2 classes
     (`FederationPollInternalError(peerId, cause)`,
     `RequestBodyTooLargeError`/`PeerResponseTooLargeError` take only
     one field but construct `super('... ' + field + ' ...')`).
   - **(no constructor)** — 1 class (`KeychainUnavailableError`).
   No class takes an options object; all are positional. None accept
   `{ cause }` as a second/third positional.

3. **Cause chaining** — `FederationPollInternalError` is the *only*
   class with a `cause: unknown` field, and it is the *only* one
   that documents a downstream `.cause` access pattern (belt-catch in
   `pollPeerManifests`). It does NOT pass `cause` to `super(...)`,
   so the ES2022 `Error.cause` chain is silently lost: stack
   traces in tooling that reads `err.cause` will see `undefined`
   here. This is the single most common anti-pattern in the table.

4. **Discriminated unions vs class hierarchy** —
   `TelegramApiError` is the only class that carries a `kind`
   discriminator (a 4-value union `'fatal' | 'rate_limit' | 'conflict' | 'transient'`),
   and the consumer (`telegram-client.ts` poll loop) picks backoff
   strategy by `err.kind`. This is the textbook case for either:
   - a discriminated union (`type TelegramPollError =
     { kind: 'rate_limit', retryAfterSec: number, message: string }
     | { kind: 'fatal', message: string } | …`), or
   - a sealed base class with typed subclasses per `kind`.
   The other 8 classes either have no discriminator (message-only)
   or carry exactly one structured field; for those, the class form
   is fine.

5. **Inheritance** — every error class extends `Error` directly.
   No error class extends another error class. There is **no
   internal hierarchy**. This means a classbase refactor has a
   clean starting point: introducing an `AppError` base class
   would be additive, not a rewrite.

---

## Taxonomy recommendation

### Structured fields vs flat

- Keep flat-message + named-field as the *current* convention. Don't
  collapse to a single `data` object — every existing typed field
  (`peerPid`, `kind`, `retryAfterSec`, `limit`, `peerId`, `cause`) is
  a structured value callers may introspect (e.g. `err.peerPid` is
  read by the pidfile-lock caller at `process-lock.ts:301/328`).
- Add the missing field on `PeerResponseTooLargeError(limit)` for
  parity with its mirror `RequestBodyTooLargeError`. Cheap, no
  behavioural change, unlocks programmatic introspection in the
  bounded-body reader's caller.

### Base class vs union

- Introduce an `abstract class AppError extends Error` that:
  - sets `this.name = this.constructor.name` (today every class
    hand-sets `this.name = '<ClassName>'` — 8 sites, all identical
    pattern, zero behavioural reason for hand-set).
  - accepts `{ cause?: unknown }` as a second positional (or
    optional options object) and forwards it via `super(message, {
    cause })` so the ES2022 `err.cause` chain works.
  - accepts optional `readonly code: string` discriminator slot.
- **Do NOT** convert `TelegramApiError` to a union. Its `kind`
  field is an API surface that callers and tests already depend
  on; making the kind an external string-literal union on the
  class is the lowest-friction migration. A subclass-per-kind
  tree would be churn for no observable win.
- The remaining 8 classes are all sufficiently narrow that one
  common `AppError` base + the existing typed fields is enough.

### Cause chaining convention

- All `AppError` subclasses must accept `{ cause?: unknown }` in
  their constructor and forward to `super(message, { cause })`.
  `FederationPollInternalError` is the existing exemplar of why
  this matters — it stores `cause` but doesn't forward it, so
  `err.cause` is `undefined` in Node's standard error chain. Fix
  in the same commit that introduces `AppError`.
- For non-`AppError` consumers, prefer `try { ... } catch (e) {
  logger.warn({ err: e }, '...') }` (the existing pattern, see
  `index.ts:383-386`) over rethrowing a wrapped error without
  cause. Pino's serializer preserves `err.cause` automatically.

---

## Hot spots

### `as any` / `: any` related to logger or platform in production

**None.** Grepping `logger.ts` and `platform.ts` for `as any` / `: any`
returns zero matches. Production callers either:
- import `logger` and call methods that pino's own types allow
  directly, or
- wrap in the `{ info, warn, error }` triple via the typed `LogFn`
  shape at `process-lock.ts:19/49/253`.

### The one unsafe cast in the wider codebase (test-side)

`src/__tests__/vault.test.ts:120`:

```ts
;(stub as unknown as { child: () => typeof stub }).child = () => stub
```

This is the **only** `as`-cast in the logger-related code, and it
exists solely to widen a 4-method stub to admit `child()` for
defence-in-depth. A classbase `LoggerLike` interface with a typed
`child` would let this cast be deleted; the stub would conform by
construction.

### Pino child/rebinding — current state

- No `logger.child(...)` call exists in `src/`. The vault test
  mock comment ("any caller that does `logger.child(...)` doesn't
  blow up") is precautionary.
- There is no `logger.withBindings` / rebinding wrapper in
  production today. If/when one is added, the classbase shape
  `PinoLogger.child(bindings): LoggerLike<L>` would compose
  cleanly without unsafe casts.
- The classbase refactor does not need to *introduce* `child`
  usage; it only needs to keep the door open via the
  `LoggerLike` interface.

### Platform hot spots

- `platform.ts:9`: `process.env['MARVEEN_ENV']` — bracket access
  on `NodeJS.ProcessEnv` (which has a string index signature);
  safe, no cast.
- `platform.ts:13`: `process.env['XDG_SESSION_TYPE'] ?? ''` —
  same.
- `platform.ts:49`: regex `/^[a-zA-Z0-9._-]+$/` validates the
  `name` argument; the function throws on invalid input rather
  than coerce, which is the right call (no `as` workaround
  needed).
- No unsafe casts in `resolveFromPath` /
  `tryResolveFromPath` / `makeLazyBinResolver`.

---

## File-pointers index

- `/Users/eggp/marveen-develop/test-baseline/src/logger.ts` — 10-line pino singleton; no exported surface today.
- `/Users/eggp/marveen-develop/test-baseline/src/platform.ts` — `PlatformType`, `PLATFORM`, `tryResolveFromPath`, `resolveFromPath`, `makeLazyBinResolver`.
- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts:19` — `LogFn` definition.
- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts:49` — `ProcessLockContext.log`.
- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts:253` — `PidfileLockContext.log`.
- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts:272` — `DeferToPeerError`.
- `/Users/eggp/marveen-develop/test-baseline/src/remote-enroll-core.ts:30` — `RemoteEnrollError`.
- `/Users/eggp/marveen-develop/test-baseline/src/channel-coordinator/telegram-client.ts:43-54` — `TelegramErrorKind` + `TelegramApiError`.
- `/Users/eggp/marveen-develop/test-baseline/src/web/federation/http.ts:7` — `PeerResponseTooLargeError`.
- `/Users/eggp/marveen-develop/test-baseline/src/web/fleet-transfer.ts:36` — `UserFacingError`.
- `/Users/eggp/marveen-develop/test-baseline/src/web/password-hash.ts:40` — `PasswordPolicyError`.
- `/Users/eggp/marveen-develop/test-baseline/src/web/remote-status-cache.ts:19` — `RemoteStatusCache<T>` (generic class exemplar).
- `/Users/eggp/marveen-develop/test-baseline/src/web/federation/poller.ts:68` — `FederationPollInternalError` (cause not forwarded).
- `/Users/eggp/marveen-develop/test-baseline/src/web/http-helpers.ts:25` — `RequestBodyTooLargeError`.
- `/Users/eggp/marveen-develop/test-baseline/src/web/keychain.ts:19` — `KeychainUnavailableError`.
- `/Users/eggp/marveen-develop/test-baseline/src/index.ts:171-176, 280-288` — pino→`LogFn` adapters.
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/vault.test.ts:113-127` — the lone unsafe `as` cast.
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/logger.test.ts:33,42` — white-box `_level` reads.
