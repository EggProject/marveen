# H (cross-cutting) subsystem — module-state analysis

## Summary

The H subsystem has three concerns with very different shapes. `src/logger.ts` is a 9-line keystone: a single named export `logger` that is a `pino()` singleton with no module-level mutable state beyond the instance itself (transport and level are evaluated once at import time). `src/platform.ts` exposes one frozen `PLATFORM` constant plus a `makeLazyBinResolver(name)` factory that returns a memoised closure; the factory is the dominant pattern (12 production callers, all produce `tmuxBin` / `claudeBin` getters). The nine existing error classes are a loose taxonomy — every one extends `Error`, none uses a `code` field, and they diverge on whether they carry a structured payload (`kind`, `peerId`, `cause`, `limit`, `peerPid`). All nine are production-thrown (zero test-only). The lowest-risk wins are: (a) make `logger` a class-typed handle with explicit child logger support, (b) replace the nine bespoke `extends Error` classes with a single `TypedError<TPayload>` base, (c) leave `platform.ts` essentially unchanged — its factory pattern already matches the class-based model cleanly.

---

## 1. `src/logger.ts` inventory

### Current shape

The entire file is 9 lines. It is a **module-level binding** (not a factory, not a class), exporting a single named binding `logger`:

```ts
// src/logger.ts (verbatim)
import pino from 'pino'

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  transport:
    process.env.NODE_ENV !== 'production'
      ? { target: 'pino-pretty', options: { colorize: true } }
      : undefined,
})
```

- **Single named export** (`logger`). No default export, no other exports, no factory function.
- **Singleton, not factory.** All 40+ consumers do `import { logger } from '../logger.js'` and use it directly.

### Module-level mutable state

Effectively zero. The only binding is `logger`, and `pino()` returns an immutable handle. There are no `let` caches, no `WeakMap`s, no module-level mutables. Confirmed via `grep -nE 'export (let|var)' src/logger.ts` — no matches.

### Top-level side effects (at import time)

Three read-only environment accesses happen during module evaluation:

1. `process.env.LOG_LEVEL` — read once, baked into the pino options.
2. `process.env.NODE_ENV` — read once, controls the transport choice.
3. `pino()` itself does I/O: in non-production it spawns the `pino-pretty` worker thread; in production it opens a stdout FD.

This is a one-shot cost; subsequent module loads (if any) re-evaluate but pino deduplicates its transports internally.

### Re-initialization hazards (HMR / double-import)

`logger.ts` is side-effectful at import but **idempotent** under double-import:

- Two imports of `src/logger.ts` produce two separate `pino()` calls. Each creates its own transport (so two `pino-pretty` worker threads would spawn in dev), but they are independent logger objects. **No module-cache singleton** is in play — Node's ESM module cache means a single import path resolves to one evaluation, but the type system offers no guarantee that consumers always go through the same path (relative-path variants exist: `../logger.js`, `../../logger.js`, `./logger.js`).
- `logger.level` is **never reassigned** in production code. Searched: zero call sites for `.setLevel` / `.useLevel`.
- `logger.child(...)` is **not called anywhere in `src/`** production code. The only reference is the `vault.test.ts` mock (L113–127), which mirrors `child` defensively in case a future caller adds it.

### Pino specifics actually used

| Pino feature | Used in `src/logger.ts`? | Used by callers? |
|---|---|---|
| `transport` (pino-pretty worker) | Yes (dev only) | n/a |
| `level` (constructor option) | Yes (`'info'` default, env override) | No |
| `redact` | **No** | No |
| `base` (default fields) | Default (picks up `pid`, `hostname`) | No override |
| `child(bindings)` | No (not pre-created) | No (no caller uses `.child()`) |
| `msgPrefix` / `mixin` | No | No |
| Multi-transport | No | No |

The two methods used in production are `logger.info(...)`, `logger.warn(...)`, `logger.error(...)`, `logger.debug(...)` — the four standard levels. Argument shape is consistently `{ field1, field2, ... }, 'message'`.

### Consumption today

- **40+ files** import `logger` via `import { logger } from '../logger.js'` (or `../../logger.js`, `../logger.js`).
- **Path import**: only the named export `logger`. Consumers never destructure fields, never pass the logger as a parameter.
- **No DI**: there is no logger interface; consumers hard-import the singleton. Refactor to a class-based handle must either preserve the named-import singleton shape or migrate every call site to constructor-injected handles.

---

## 2. `src/platform.ts` inventory

### Current shape

The file is 81 lines, no class, four exports:

- `type PlatformType` — union `'macos' | 'linux-server' | 'linux-gui'`
- `const PLATFORM: PlatformType` — frozen at import time (`detect()` runs once)
- `function tryResolveFromPath(name)` — throws on invalid name, returns `null` if absent
- `function resolveFromPath(name)` — throws if absent
- `function makeLazyBinResolver(name)` — returns a memoised zero-arg resolver closure

### `PLATFORM` resolution

`detect()` (L8–22) reads `process.env['MARVEEN_ENV']` first as an override, then falls back to platform introspection:

- `process.platform === 'darwin'` → `'macos'`
- `process.platform === 'linux'` → `'linux-gui'` if `DISPLAY` / `WAYLAND_DISPLAY` / `XDG_SESSION_TYPE` in `{x11, wayland, mir}` is set, else `'linux-server'`
- Any other platform → `'linux-server'` (safe default)

The value is computed **once at module load** (`export const PLATFORM = detect()`). No re-evaluation, no env mutation.

### Module-level state

- `KNOWN_BIN_DIRS` (L36–43) — `const`, frozen at import. Six entries: `~/.local/bin`, `~/.bun/bin`, `/opt/homebrew/bin`, `/usr/local/bin`, `/usr/bin`, `/bin`.
- **No PATH mutation.** The resolver probes directories directly via `existsSync`. It does **not** prepend anything to `process.env.PATH`.

### `makeLazyBinResolver` factory pattern

```ts
export function makeLazyBinResolver(name: string): () => string {
  let cached: string | null = null
  return () => {
    if (cached === null) cached = resolveFromPath(name)
    return cached
  }
}
```

Closure-over-name and closure-over-`cached`. The closure is the only piece of mutable state. After the first successful resolve the closure's `cached` field is set forever (the `null` sentinel is the "not yet resolved" marker; the empty-string result from `tryResolveFromPath` would mean the binary exists at an empty path, which is impossible).

### How `PLATFORM` / `makeLazyBinResolver` are consumed

`PLATFORM`:
- **One production consumer**: `src/web/claude-credentials-guard.ts:6` imports it; only one branch (L322) actually branches on it (`if (PLATFORM === 'macos') return 'not-linux'`).
- That is the entire production usage of `PLATFORM`. Most cross-platform code paths branch on `process.platform` directly or use `os.platform()`.

`makeLazyBinResolver` (12 production callers):
- `channel-coordinator/liveness.ts:20` → `tmuxBin`
- `web/agent-process.ts:56-57` → `tmuxBin`, `claudeBin`
- `web/channel-mcp-reconnect.ts:11` → `tmuxBin`
- `web/agent-worker.ts:43` → `tmuxBin`
- `web/channel-plugin-unlock.ts:40` → `tmuxBin`
- `web/mcp-list.ts:13` → `claudeBin`
- `web/channel-monitor.ts:53-54` → `tmuxBin`, `claudeBin`
- `web/reauth-healer.ts:32` → `tmuxBin`
- `web/stuck-tool-call-watcher.ts:54` → `tmuxBin`
- `web/routes/agent-terminal.ts:13` → `tmuxBin`
- `web/routes/background-tasks.ts:14-15` → `tmuxBin`, `claudeBin`

`resolveFromPath` (4 callers): `web/agent-worker.ts:6`, `web/claude-credentials-guard.ts:6`, `web/routes/onboarding.ts:7`, and via `makeLazyBinResolver` itself.

`tryResolveFromPath` (2 callers): `web/agent-worker.ts:6`, plus indirect via `resolveFromPath`.

**All callers immediately bind the result to a module-level `const` (`const tmuxBin = makeLazyBinResolver('tmux')`).** No caller passes the resolver as an argument, no test overrides it directly.

### Test-only consumption

- `__tests__/platform-bin-resolve.test.ts` exercises all three functions. Mocking is via `vi.mock('node:child_process')` to stub `execSync`; the resolver factory itself is not replaced.

---

## 3. Error class inventory

All nine classes extend `Error`. There is **no shared base class, no `code` field, no project-wide convention**. Field shapes diverge: some are payload-only (`DeferToPeerError`), some are message-only (`RemoteEnrollError`, `UserFacingError`, `PasswordPolicyError`, `PeerResponseTooLargeError`), some carry a discriminator (`TelegramApiError.kind`), and one explicitly chains a `cause` (`FederationPollInternalError`). All nine are **production-thrown**; zero are test-only.

| Class | File:line | Parent | Fields (besides `message`) | Constructor signature | Production throw sites | Test-only? |
|---|---|---|---|---|---|---|
| `DeferToPeerError` | `src/process-lock.ts:272` | `Error` | `peerPid: number` (readonly) | `(peerPid: number)` | `process-lock.ts:347`; re-thrown by `src/index.ts:324` | No |
| `RemoteEnrollError` | `src/remote-enroll-core.ts:30` | `Error` | none beyond message | `(message: string)` | 13 sites in `remote-enroll-core.ts:69,73,77,82,86,91,94,106,110,113,117,123,127,131`; 1 site in `src/web/bridge-enroll.ts:179` | No |
| `TelegramApiError` | `src/channel-coordinator/telegram-client.ts:45` | `Error` | `kind: TelegramErrorKind` (public readonly); `retryAfterSec?: number` (public readonly) | `(kind: TelegramErrorKind, message: string, retryAfterSec?: number)` | 10 sites in `telegram-client.ts:161,179,180,181,182,184,188,213,218,219,220,223` | No |
| `PeerResponseTooLargeError` | `src/web/federation/http.ts:7` | `Error` | none beyond message | `(limit: number)` (message embeds the limit) | `web/federation/http.ts:21, 34` | No |
| `UserFacingError` | `src/web/fleet-transfer.ts:36` | `Error` | none beyond message | `(message: string)` | `web/fleet-transfer.ts:398, 493, 543` | No |
| `PasswordPolicyError` | `src/web/password-hash.ts:40` | `Error` | none beyond message | `(message: string)` | `web/password-hash.ts:52, 54, 57` | No |
| `FederationPollInternalError` | `src/web/federation/poller.ts:68` | `Error` | `peerId: string` (public readonly); `cause: unknown` (public readonly) | `(peerId: string, cause: unknown)` | `web/federation/poller.ts:237` | No |
| `RequestBodyTooLargeError` | `src/web/http-helpers.ts:25` | `Error` | `limit: number` (readonly) | `(limit: number)` (message embeds the limit) | `web/http-helpers.ts:46` | No |
| `KeychainUnavailableError` | `src/web/keychain.ts:19` | `Error` | none | `(message?: string)` | `web/keychain.ts:39, 64`; `web/vault.ts:66` | No |

### Taxonomy observations

- **No `code` field anywhere.** Consumers branch on `err instanceof X` (`web/routes/federation.ts:319`, `web/routes/schedules.ts:134, 185`) rather than on a string code. Migrating to a `code: string` field would be a semantic change, not a refactor.
- **No `cause` chaining at the Error level** — except `FederationPollInternalError`, which explicitly carries `cause: unknown`. Three other errors carry no cause even when the throw site has an underlying error (e.g. `RequestBodyTooLargeError` is thrown from inside `req.on('data')` where a raw Node error would have been available; the cause is dropped).
- **`name` is set explicitly** on eight of the nine classes (only `KeychainUnavailableError` relies on the default `Error.name === 'Error'`).
- **`readonly` vs constructor `public readonly`** — `DeferToPeerError` uses `readonly peerPid: number` (parameter-property shorthand), `TelegramApiError` and `FederationPollInternalError` use `public readonly kind` in the constructor signature. Same semantics, different syntax — inconsistent within the project.
- **Two errors are size-bounded payloads**: `PeerResponseTooLargeError` and `RequestBodyTooLargeError` both accept a single numeric `limit` and embed it in the message string. They are structurally identical and could share a parent (`BoundedSizeError`).
- **`TelegramApiError` carries a discriminator** (`kind: 'fatal' | 'rate_limit' | 'conflict' | 'transient'`) that drives backoff strategy in the caller. This is the most "domain-typed" error in the set and the closest precedent for a typed-error payload.
- **`UserFacingError` and `RemoteEnrollError` are functionally identical**: both extend `Error` with a message-only constructor. They exist as separate types purely so callers can `instanceof`-distinguish them for routing (e.g. `UserFacingError` maps to HTTP 400 in the fleet transfer route). This pattern — same shape, different name for routing — is the strongest candidate for replacement with a single `TypedError<{ userFacing: true }>` payload.

### Test-mirroring note

Tests in `src/__tests__/` define their own local copies of these errors (e.g. `__tests__/channel-coordinator.test.ts:526`, `__tests__/vault.test.ts:132`). These are **test-mock shadows**, not test-only error classes — the production classes remain the same. If the refactor consolidates to one base class, test mirrors will need updates to extend the new base.

---

## 4. Cross-cutting observations

### Does any error class accept a logger?

**No.** All nine error constructors take only domain data (numbers, strings, `unknown` for cause). No logger parameter, no logger field. Errors are pure data carriers. The logger is invoked **at the call site that catches the error**, not at the throw site. Example pattern (from `web/fleet-transfer.ts:1273`):

```ts
} catch (err) {
  logger.error({ err: err.message }, 'Fleet import failed, tracked writes cleaned up')
}
```

This means the logger/error relationship is **decoupled** today. Refactoring either side does not force changes to the other.

### Does `platform.ts` log anything?

**No.** `platform.ts` does not import the logger. The throw sites (`Error('Invalid binary name: ' + name)`, `Error('Required binary not found on PATH: ' + name)`) raise plain `Error` instances with no logger context. The user-facing message is the throw; logging happens in the caller.

This is a latent gap: a binary-not-found failure on boot would benefit from a structured log line at the throw site (so operators can grep), but the current architecture forces log-at-caller.

### Do consumers of `makeLazyBinResolver` log?

The 12 production callers all do `const tmuxBin = makeLazyBinResolver('tmux')` and call `tmuxBin()` later. Failures (the throw from `resolveFromPath`) propagate up; logging is done at the highest level (`web/agent-process.ts` etc.), not at the resolver itself.

### Interaction summary

```
       ┌──────────────┐
       │ src/logger.ts│ ← imported by ~40 production files
       └──────────────┘
              ↑
              │ used by callers of all 9 error classes
              │
       ┌──────────────┐
       │ src/platform │ ← imported by ~14 production files
       └──────────────┘
              │
              │ not referenced by any error class
              │ not used by logger.ts
```

The three concerns (logger, platform, errors) are **structurally independent** in the current code: no error class imports the logger, no error class imports platform, and `platform.ts` imports neither the logger nor any error class. `logger.ts` is independent of both.

This is the lowest-risk property of the H subsystem: a class-based refactor of any one of the three will not cascade into the others. The only cross-cutting risk is **DI migration** — if the refactor moves `logger` from a named export to a constructor-injected instance, every consumer's import statement changes (mechanical, not semantic).

---

## 5. Refactor-shape implications (informational, not prescriptive)

These are observations about how each concern already maps — or doesn't — to a class-based model. They are recorded here so the implementation-phase plan can pick its battles.

- **`logger.ts` is already class-shaped.** Pino's `Logger` is a class instance with a method per level. The current code just exposes one shared instance. A class-based refactor would wrap `pino.Logger` in a project-specific `Logger` class that exposes `info/warn/error/debug` and adds (currently-unused) `child(bindings)` and (currently-unused) `setLevel`. The win is type-checking, not runtime behavior change.

- **`platform.ts` is partway to a class.** `makeLazyBinResolver` already returns a closure with internal state (`cached`). The class version would be `class BinResolver { private cached: string | null = null; constructor(private name: string) {} resolve(): string { ... } }`. The class form is **longer**, not shorter, than the closure. The win is uniformity with other class-based modules, not locality.

- **Error classes are the strongest candidate for consolidation.** The nine classes share 80% of their shape (extend `Error`, set `name`). A single generic `TypedError<T extends { name: string; ...payload }>` would replace eight of them. The two that resist (`TelegramApiError` with its `kind` discriminator, `FederationPollInternalError` with its `cause`) are the two that already carry typed payloads — they would extend the new base with their specific payload field, not replace it.

- **The biggest surface area is `logger` consumers** (~40 files). Any refactor that changes the import shape cascades there. A refactor that preserves `import { logger } from '../logger.js'` as the only consumer-visible API is essentially free downstream.

---

## Files referenced

- `/Users/eggp/marveen-develop/test-baseline/src/logger.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/platform.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts` (DeferToPeerError, L272; throw site L347)
- `/Users/eggp/marveen-develop/test-baseline/src/remote-enroll-core.ts` (RemoteEnrollError, L30)
- `/Users/eggp/marveen-develop/test-baseline/src/channel-coordinator/telegram-client.ts` (TelegramApiError, L45)
- `/Users/eggp/marveen-develop/test-baseline/src/web/federation/http.ts` (PeerResponseTooLargeError, L7)
- `/Users/eggp/marveen-develop/test-baseline/src/web/fleet-transfer.ts` (UserFacingError, L36)
- `/Users/eggp/marveen-develop/test-baseline/src/web/password-hash.ts` (PasswordPolicyError, L40)
- `/Users/eggp/marveen-develop/test-baseline/src/web/remote-status-cache.ts` (RemoteStatusCache class, L19 — relevant precedent for a generic stateful class)
- `/Users/eggp/marveen-develop/test-baseline/src/web/federation/poller.ts` (FederationPollInternalError, L68)
- `/Users/eggp/marveen-develop/test-baseline/src/web/http-helpers.ts` (RequestBodyTooLargeError, L25)
- `/Users/eggp/marveen-develop/test-baseline/src/web/keychain.ts` (KeychainUnavailableError, L19)
