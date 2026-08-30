# H (cross-cutting) — Class boundaries

Concrete class candidates for the H subsystem. Signatures only; no
implementation. Every claim below cites a file:line verified against `src/`
on 2026-08-30.

**Reading note.** Two of the three candidates below are recommended in a
*narrower* form than the brief asked for. The narrowing is argued from
measured source, not preference, and is called out explicitly under
"Deviation from brief" in each section. `review-completeness.md` OE-1 through
OE-9 rejected six framework proposals for exactly the failure mode these
narrowings avoid — a class surface with no production consumer.

---

## C1. `PinoLogger` (implements `LoggerLike`)

### Deviation from brief

The brief asks for `child`, `info/warn/error/debug`, **and a redaction
config**. Measured state:

| Requested member | Production callers in `src/` | Evidence |
|---|---:|---|
| `info` / `warn` / `error` | ubiquitous | 744 total `logger.<level>(` calls, of which 626 object-first, 76 string-first |
| `debug` | 40+ | `heartbeat.ts:488`, `memory.ts:150`, `db.ts:2443`, `channel-coordinator/liveness.ts:152`, `web/channel-monitor.ts` (10 sites), `web/reauth-healer.ts` (5 sites), `web/schedule-mcp-precheck.ts` (4 sites), … |
| `child(bindings)` | **0** | `grep -rn "logger\.child(" src/ --include='*.ts' \| grep -v __tests__` → no matches |
| `redact` | **0** | absent from `logger.ts:3-9`; no caller sets it |
| `level` (read or write) | **0** | `grep -rn "logger\.level" src/` → no matches; the only level reads are the white-box `logger._level` at `logger.test.ts:33` and `:42` |
| `trace` / `fatal` / `flush` / `silent` | **0** | `grep -rnE "logger\.(trace\|fatal)\(" src/ \| grep -v __tests__` → 0 |

**Recommendation: do not build this class in H.** Ship `LoggerLike`
(the interface, see `04-generic-interfaces.md` §L) and keep the pino instance
at `logger.ts:3` as the production implementation. A `PinoLogger` wrapper
class adds a forwarding method per level (four methods, each a pass-through)
plus a `child` that no production code calls plus a redaction config that no
production code configures — new surface with zero consumers, which is the
`review-completeness.md` OE-6/OE-8 failure pattern.

The section below is retained as the **contingency shape**, to be built only
if H.2's proof consumer (see `05-refactor-roadmap.md`) demonstrates a real
need for per-class bindings — i.e. if a converted class actually wants
`this.log = parentLog.child({ module: 'channel-monitor' })`.

### Contingency shape

- **Name:** `PinoLogger`
- **Source file (new):** `src/logger.ts` (alongside, not replacing, the
  existing `export const logger` at `logger.ts:3`)
- **Migration source:** `src/logger.ts:3-9` (the `pino({...})` call) — the
  options object moves into the constructor; the four level methods forward.

```ts
class PinoLogger implements LoggerLike {
  constructor(destination: pino.Logger)
  static fromEnv(env: NodeJS.ProcessEnv): PinoLogger

  info: LogFn
  warn: LogFn
  error: LogFn
  debug: LogFn
  child(bindings: Record<string, unknown>): PinoLogger
}
```

- **Constructor:** takes an already-constructed `pino.Logger` as the
  destination. It does **not** take pino options, because option assembly is
  the env-reading side effect currently at `logger.ts:4-8` and moving it into
  a constructor would make every `new PinoLogger()` re-read
  `process.env.LOG_LEVEL` / `process.env.NODE_ENV` and, in non-production,
  spawn a second `pino-pretty` worker thread (`logger.ts:6-7`). `fromEnv` is
  the single factory that does that once.
- **Generic params:** none. See `04-generic-interfaces.md` §L "Why
  `LoggerLike` is not generic".
- **Dependencies:** `pino` (already a direct dep, `package.json:33`,
  resolved version 9.14.0).
- **Lifecycle:** process-lifetime. No `close()` / `flush()` — nothing in
  `src/` calls either today, and `index.ts`'s shutdown at `index.ts:554-560`
  does not drain the logger.
- **Redaction:** **not** in the constructor. If redaction is ever needed it
  belongs in the `fromEnv` options object, where pino applies it once, not
  as a per-instance config that would diverge between the singleton and
  injected instances.

### Free functions / call shapes that REMAIN unchanged

- All 744 `logger.<level>(...)` call sites in production. Their argument
  shapes (`logger.info({ field }, 'msg')` and `logger.info('msg')`) must both
  keep compiling — see `06-risks-and-mitigations.md` HR4.
- `logger.test.ts:33` / `:42` read `logger._level`, a pino internal. These
  stay on the concrete pino type and must **not** be added to `LoggerLike`
  (see `02-type-interface-analysis.md` "What this does NOT solve").
- The two hand-rolled adapter literals at `index.ts:171-175` and
  `index.ts:280-287`:
  ```ts
  log: {
    info: (obj, msg) => logger.info(obj, msg),
    warn: (obj, msg) => logger.warn(obj, msg),
    error: (obj, msg) => logger.error(obj, msg),
  },
  ```
  These exist only because `ProcessLockContext.log` (`process-lock.ts:49`) is
  typed as the narrow `{ info: LogFn; warn: LogFn; error: LogFn }` triple.
  Once `LoggerLike` types that field, both literals collapse to
  `log: logger`. Note the comment at `index.ts:281-283` documents that
  `PidfileLockContext.log.error` is forwarder-only and is pinned by a test it
  cites as `index.test.ts:1382`; the test
  (`it('forwards pidfile context errors to logger.error', ...)`) actually
  starts at `index.test.ts:1383` — the source comment is off by one. The
  collapse must not drop that pin.

---

## C2. `LazyBin<TName, TResolved>`

- **Name:** `LazyBin`
- **Source file:** `src/platform.ts` (currently `makeLazyBinResolver` at
  `platform.ts:74-80`)
- **Migration source:** the closure at `platform.ts:74-80` verbatim:
  ```ts
  export function makeLazyBinResolver(name: string): () => string {
    let cached: string | null = null
    return () => {
      if (cached === null) cached = resolveFromPath(name)
      return cached
    }
  }
  ```
  The `cached` cell becomes a private field; the closure body becomes
  `resolve()`.

### Public surface (signatures only)

```ts
class LazyBin<TName extends string = string, TResolved extends string = string> {
  constructor(name: TName, resolver?: (name: TName) => TResolved)
  readonly name: TName
  resolve(): TResolved          // throws if unresolvable — see below
  invalidate(): void            // drops the memoised value
}
```

- **Constructor:** `(name, resolver?)`. The optional `resolver` defaults to
  `resolveFromPath` (`platform.ts:61`). It exists so
  `web/claude-credentials-guard.ts:142` / `:327` and `web/agent-worker.ts:547`
  — which today call `resolveFromPath('claude')` eagerly and bypass the cache
  entirely — can share one resolver instance instead of re-resolving.
  **The constructor must perform no I/O.** This is pinned by
  `src/__tests__/platform-bin-resolve.test.ts:88-92` ("does not resolve at
  construction time (safe during a boot-time PATH gap)").
- **Generic params:** two, per brief. `TName extends string` is load-bearing —
  it lets `new LazyBin('tmux')` be typed `LazyBin<'tmux'>`, narrower than
  `LazyBin<string>`. `TResolved extends string = string` is **not** load-bearing
  today: `resolveFromPath` returns `string` (`platform.ts:61`) with no narrower
  inhabitant anywhere in `src/`. It is included because the brief asked for it,
  defaulted to `string` so no call site must supply it. See
  `04-generic-interfaces.md` §Z for the argument that it should be dropped.
- **Dependencies:** `resolveFromPath` (`platform.ts:61`), which depends on
  `tryResolveFromPath` (`platform.ts:48`), which depends on
  `execSync` (`node:child_process`) and `existsSync` (`node:fs`), plus the
  `KNOWN_BIN_DIRS` const at `platform.ts:36-43`.
- **Lifecycle:** constructed at module scope by consumers (the current
  pattern — `const tmuxBin = makeLazyBinResolver('tmux')`), lives for the
  process. `invalidate()` is the only state transition after the first
  successful `resolve()`.

### `resolve()` return type — correction to `04-generic-interfaces.md` G7

The framework's G7 sketch (`04-generic-interfaces.md:369-373`) declares
`resolve(): string | null`. **This is wrong.** `makeLazyBinResolver` returns
`() => string` (`platform.ts:74`) and its body calls `resolveFromPath`
(`platform.ts:61`), which throws `Error('Required binary not found on PATH: ...')`
at `platform.ts:63` rather than returning null. Changing the return type to
`string | null` would silently convert 14 throwing call sites into sites that
pass `null` into `execSync`/`spawn` argument lists. G7 must be corrected to
`resolve(): TResolved` (throwing) before any executor reads it.

### Free functions that REMAIN

- `PLATFORM` (`platform.ts:24`) — stays a module const. One production
  consumer (`web/claude-credentials-guard.ts:6`, branched at `:322`).
- `tryResolveFromPath` (`platform.ts:48`) — stays. External caller:
  `web/agent-worker.ts:502` (`tryResolveFromPath('claude') ?? 'claude'`).
- `resolveFromPath` (`platform.ts:61`) — stays. External callers:
  `web/claude-credentials-guard.ts:142`, `:327`, `web/agent-worker.ts:547`.
- `makeLazyBinResolver` (`platform.ts:74`) — **stays**, reimplemented as
  `(name) => { const b = new LazyBin(name); return () => b.resolve() }` or
  similar. All 14 existing invocations across 11 files keep working
  unchanged; see `00-summary.md` Scope for the list.

### Structural test guard that constrains this class

`src/__tests__/platform-no-import-time-bin-resolve.test.ts:44` defines:
```ts
const TOP_LEVEL_RESOLVE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*resolveFromPath\(/
```
and asserts zero matches across `src/` (excluding `__tests__`). The regex
matches only the literal text `= resolveFromPath(`. `const tmuxBin = new
LazyBin('tmux')` does not match — so the LazyBin refactor passes the guard,
but the guard goes **blind** to the failure it was written to catch (the CI
incident documented in that file's header, 2026-08-13, where import-time
resolution killed 11 unrelated suites). H.3 must extend the regex to also
reject module-scope `= new LazyBin(...).resolve()`. See
`06-risks-and-mitigations.md` HR5.

---

## C3. `AppError` base + first two concrete subclasses

### Inventory (verified, 2026-08-30)

`grep -rn "^export class" src/ --include='*.ts' | grep -v __tests__` returns
10 classes — 9 errors plus `RemoteStatusCache<T>`:

| Class | File:line | Stored fields | `name` set? | `cause`? |
|---|---|---|---|---|
| `DeferToPeerError` | `process-lock.ts:272` | `readonly peerPid: number` | yes | no |
| `RemoteEnrollError` | `remote-enroll-core.ts:30` | — | yes | no |
| `TelegramApiError` | `channel-coordinator/telegram-client.ts:45` | `public readonly kind: TelegramErrorKind`, `public readonly retryAfterSec?: number` | yes | no |
| `PeerResponseTooLargeError` | `web/federation/http.ts:7` | — (limit only in message) | yes | no |
| `UserFacingError` | `web/fleet-transfer.ts:36` | — | yes | no |
| `PasswordPolicyError` | `web/password-hash.ts:40` | — | yes | no |
| `FederationPollInternalError` | `web/federation/poller.ts:68` | `public readonly peerId: string`, `public readonly cause: unknown` | yes | see correction below |
| `RequestBodyTooLargeError` | `web/http-helpers.ts:25` | `readonly limit: number` | yes | no |
| `KeychainUnavailableError` | `web/keychain.ts:19` | — (bare `extends Error {}`) | **no** | no |
| `RemoteStatusCache<T>` | `web/remote-status-cache.ts:19` | not an error | n/a | n/a |

### Correction to `02-type-interface-analysis.md` §Per-class findings 3

That document states `FederationPollInternalError` "does NOT pass `cause` to
`super(...)`, so the ES2022 `Error.cause` chain is silently lost: stack traces
in tooling that reads `err.cause` will see `undefined` here."

**Refuted.** `poller.ts:69` declares `public readonly cause: unknown` as a
constructor parameter property, which assigns an own property named `cause`.
Verified empirically on this machine's Node build: reading `.cause` on such an
instance returns the passed value (`a.cause === root` → `true`). The only
observable difference from `super(message, { cause })` is the property
descriptor — parameter-property assignment produces `enumerable: true`, the
ES2022 options form produces `enumerable: false`. That difference matters for
`JSON.stringify` and for pino's serializers (an enumerable `cause` will be
walked), but `err.cause` is **not** `undefined`. The taxonomy convention in
H.4 should still standardise on `super(message, { cause })` — for the
non-enumerable descriptor and consistency — but it must not be sold as
"fixing a lost cause chain", because that repair does not exist.

### `AppError` shape

```ts
abstract class AppError extends Error {
  constructor(message: string, options?: { cause?: unknown })
  // this.name = new.target.name  — replaces 8 hand-written `this.name = '...'`
}
```

- **Constructor:** `(message, options?)`. Forwards `options` to
  `super(message, options)` so `cause` lands non-enumerably.
- **`name`:** set from `new.target.name` rather than a hand-written literal.
  Eight of nine classes hand-set `this.name` to their own class name today
  (`process-lock.ts:276`, `remote-enroll-core.ts:33`,
  `telegram-client.ts:52`, `federation/http.ts:10`, `fleet-transfer.ts:39`,
  `password-hash.ts:43`, `federation/poller.ts:71`, `http-helpers.ts:29`);
  `KeychainUnavailableError` (`web/keychain.ts:19`) does not, so it reports
  `name === 'Error'` today. Adopting `new.target.name` **changes**
  `KeychainUnavailableError`'s `.name` from `'Error'` to
  `'KeychainUnavailableError'` — a behaviour change that must be checked
  against any test asserting on it before H.4 lands.
- **No `code` field.** Deliberate. `grep -rn "code === '" src/ --include='*.ts' | grep -v __tests__`
  returns 10 hits and **all 10 are Node `ErrnoException` codes** —
  `'EEXIST'` (`index.ts:229`), `'ENOENT'` (`index.ts:250`,
  `web/claude-credentials-guard.ts:154`), `'EADDRINUSE'` (`web.ts:226`),
  `'EPERM'` (`web/routes/updates.ts:149`). Zero project error classes carry
  or are discriminated by a `code`. Adding one creates a second, unused
  discrimination axis alongside the 15 existing `instanceof` sites, and
  invites collision with the errno namespace in shared catch blocks. See
  `06-risks-and-mitigations.md` HR6.
- **Generic params:** none. `02-type-interface-analysis.md` floats
  `TypedError<TPayload>`; there is no consumer — the payload fields
  (`peerPid`, `kind`, `retryAfterSec`, `limit`, `peerId`) are read positionally
  by name at specific catch sites (`index.ts:556` reads `err.peerPid`;
  `channel-coordinator.ts:335/338/366/372/378` read `err.kind`), never
  generically.
- **Lifecycle:** per-throw. No shared state.

### First two concrete subclasses (H.4 scope)

Selection criteria: (a) already carries a structured field, so the base class
is exercised rather than trivially inherited; (b) small, contained throw-site
count; (c) an existing `instanceof` consumer, so the regression is observable.

1. **`RequestBodyTooLargeError`** (`web/http-helpers.ts:25`) —
   `constructor(limit: number)`, stores `readonly limit: number`
   (`http-helpers.ts:26`), one throw site (`http-helpers.ts:46`), three
   `instanceof` consumers (`web/routes/federation.ts:319`,
   `web/routes/schedules.ts:134`, `web/routes/schedules.ts:185`).
2. **`PeerResponseTooLargeError`** (`web/federation/http.ts:7`) — its
   structural mirror: `constructor(limit: number)`, but does **not** store the
   limit (only embeds it in the message at `federation/http.ts:9`). Two throw
   sites (`federation/http.ts:21`, `:34`), one `instanceof` consumer
   (`web/federation/poller.ts:199`). Converting it alongside its mirror is the
   natural place to add the missing `readonly limit` field, which is the one
   concrete win in the whole taxonomy — programmatic introspection at the
   `poller.ts:199` site instead of message parsing.

The other seven classes are **explicitly deferred**. `TelegramApiError`
(`telegram-client.ts:45`) is deferred longest: its `kind` discriminator is
read at five sites in `channel-coordinator.ts` and it is the only class whose
payload drives control flow, so its conversion carries the most risk for the
least gain. `review-completeness.md` OE-1/OE-2 rejected converting behaviour-free
tag unions to class hierarchies; the same reasoning says do not split
`TelegramApiError` into a subclass per `kind`.

### Free functions / patterns that REMAIN

- All 15 `instanceof` discrimination sites keep working unchanged, because
  `AppError` is inserted *above* the concrete classes, not in place of them:
  `channel-coordinator.ts:335/338/366/372/378`, `index.ts:555`,
  `web/vault.ts:49`, `web/federation/poller.ts:199`,
  `web/routes/federation.ts:319`, `web/routes/schedules.ts:134/185`,
  `web/routes/security.ts:95`, `web/routes/fleet.ts:29`,
  `web/routes/auth.ts:271/327`.
- The 10 errno `code ===` checks listed above are untouched.
- Test-side shadow classes remain a hazard, not a deliverable:
  `vault.test.ts:132` declares a **local** `class KeychainUnavailableError
  extends Error {}` inside a `vi.mock('../web/keychain.js', ...)` factory.
  `web/vault.ts:49` (`if (!(err instanceof KeychainUnavailableError)) throw err`)
  only passes because the mock replaces the whole module. If H.4 makes
  `KeychainUnavailableError extends AppError`, that shadow must be updated in
  lockstep or the `instanceof` silently inverts. See
  `06-risks-and-mitigations.md` HR6.
