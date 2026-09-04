# C (web) — Module state analysis

Planning only — no source files modified. Verified against
`src/web.ts` (576 LOC), `src/web/auth-gate.ts` (121 LOC),
`src/web/main-agent.ts` (49 LOC), the 44 route files in
`src/web/routes/`, the 9 federation files in `src/web/federation/`,
and the importer / mock landscape on 2026-08-30 (branch
`test/baseline`, HEAD `f58fe4c`).

---

## Brief summary

The C subsystem is **the LARGEST of the eight subsystems** in the
refactor framework: a single 576-LOC closure (`startWebServer` at
`src/web.ts:88`) that opens a listener, registers 43 `tryHandle*`
route handlers from `src/web/routes/` (44 files including the
non-handler `types.ts`), and starts 19 background "runner"
intervals plus 2 inline `setInterval` calls (20 `clearInterval` + 1
`clearTimeout(startupWatchdogGrace)` = **21 cleanup calls** in the
hand-rolled close handler at `web.ts:548-573`). Total **221 logger
call sites** (50 in `web.ts` + 159 across `routes/` + 12 in
`federation/`) all reach the module-level `pino` singleton via
`import { logger }`. The subsystem is FUNCTION-SHAPED: three
classes already exist (`PeerResponseTooLargeError` at
`federation/http.ts:7`, `FederationPollInternalError` at
`federation/poller.ts:68`, `RequestBodyTooLargeError` at
`web/http-helpers.ts:25`) plus the existing `RemoteStatusCache<T>`
generic at `web/remote-status-cache.ts:19`. The auth gate produces
a 5-arm `AuthResult` union (`auth-gate.ts:29-34`) which the
`ctxAuth` ternary at `web.ts:154-159` projects onto a 4-arm
`RouteContext['auth']` (the `'none'` arm collapses to `undefined`).
**Only 2 of the 44 route files** actively consume `ctxAuth`
(`routes/auth.ts` and `routes/security.ts`) — the 4-arm shape is
defensive infrastructure, not active discrimination. The
`web/federation/` sub-cluster (9 files, ~1835 LOC) is a tightly
coupled unit that requires refactoring as a whole (per CE-2 and
C3-corrected paths).

---

## §1. `src/web.ts` inventory (576 LOC)

### §1.1 Current shape

| Section | Line range | What's there |
|---|---|---|
| Imports | `:1-31` | `node:http`, `node:net` (Socket), `node:os` (`homedir`), `node:path` (`join`, `relative`), `./config.js` (5 fields), `./logger.js`, `./web/dashboard-auth.js` (loadOrCreateDashboardToken), `./web/auth-gate.js` (resolveAuth, requiresAuth, isFederationWireEndpoint), `./web/auth-sessions.js` (sweepExpiredSessions), `./web/auth-device-keys.js` (sweepExpiredDeviceKeys), `./web/csrf-origin.js`, `./web/http-helpers.js` (json, readBody), `./web/network-info.js` (detectLanIp), `./web/agent-config.js` (AGENTS_BASE_DIR, listAgentNames), `./web/agent-scaffold.js` (6 helpers), `./web/hook-registration-guard.js`, `./web/telegram.js` (refreshMarveenBotUsername), and 19 background service runners |
| Helper exports | `:47-58` | `channelsSessionName`, `channelsLaunchdLabel`, `channelsPlistPath`, `MAIN_CHANNELS_SESSION`, `MAIN_CHANNELS_PLIST`, `isMainChannelsAgent` (re-exported from `web/main-agent.ts`) |
| `startWebServer` | `:88-547` | The single 460-LOC closure that opens the listener, runs CORS + auth gate, registers routes, starts 19 runners, returns `http.Server` |
| Shutdown handler override | `:548-573` | Hand-rolled `server.close` override that clears 21 cleanup calls (20 `clearInterval` + 1 `clearTimeout`) and sets `workerStartupCancelled = true` |
| Closing brace | `:574-576` | |

**Zero exports** from `web.ts` outside the `main-agent.ts` re-exports
at `:47-58`. Type-exporting is fully delegated to
`web/routes/types.ts` (`RouteContext` + `RouteHandler`) and
`web/auth-gate.ts` (`AuthResult`).

### §1.2 The 21 cleanup calls (corrected per C-MR1)

Per `web.ts:548-573` line-by-line (verified 2026-08-30):

| Line | Call | Type |
|---:|---|---|
| 550 | `clearInterval(routerInterval)` | setInterval |
| 551 | `clearInterval(scheduleInterval)` | setInterval |
| 552 | `if (pluginMonitorInterval) clearInterval(pluginMonitorInterval)` | setInterval (guarded) |
| 554 | `if (workerLivenessInterval) clearInterval(workerLivenessInterval)` | setInterval (guarded) |
| 555 | **`clearTimeout(startupWatchdogGrace)`** | **setTimeout** |
| 556 | `clearInterval(startupWatchdogPoll)` | setInterval |
| 557 | `clearInterval(channelHealthInterval)` | setInterval |
| 558 | `if (costsSyncInterval) clearInterval(costsSyncInterval)` | setInterval (guarded) |
| 559 | `clearInterval(stuckInputInterval)` | setInterval |
| 560 | `clearInterval(stuckToolCallInterval)` | setInterval |
| 561 | `if (inboxNudgeInterval) clearInterval(inboxNudgeInterval)` | setInterval (guarded) |
| 562 | `if (reauthHealerInterval) clearInterval(reauthHealerInterval)` | setInterval (guarded) |
| 563 | `clearInterval(autoRestartInterval)` | setInterval |
| 564 | `clearInterval(modelFallbackInterval)` | setInterval |
| 565 | `clearInterval(contextGuardInterval)` | setInterval |
| 566 | `clearInterval(approvalTimeoutInterval)` | setInterval |
| 567 | `clearInterval(authSessionSweepInterval)` | setInterval (inline, 1h) |
| 568 | `clearInterval(updateCheckerInterval)` | setInterval |
| 569 | `if (federationPollerInterval) clearInterval(federationPollerInterval)` | setInterval (guarded) |
| 570 | `if (capabilityRunnerInterval) clearInterval(capabilityRunnerInterval)` | setInterval (guarded) |
| 571 | `clearInterval(tokenCollectInterval)` | setInterval (inline, 1h) |

**Total: 20 `clearInterval` + 1 `clearTimeout` = 21 cleanup calls.**
The earlier plan estimate (C-B §1.6 "22 `clearInterval` calls") was
off by one — the 22nd is the `clearTimeout(startupWatchdogGrace)`
that has been miscounted as `clearInterval`. The consolidation into
`DashboardServer.intervals: NodeJS.Timeout[]` (per C.2 §C2) needs
**20 entries for the setInterval handles**; the `startupWatchdogGrace`
timeout handle lives in a separate `private graceTimeout: NodeJS.Timeout
| undefined` field — OR the array holds all 21 (Timeout is the same
TypeScript type, but the field name would be misleading).

### §1.3 The `ctxAuth` ternary — `src/web.ts:154-159` (corrected per m2)

```ts
// src/web.ts:154-159
const ctxAuth =
  auth.kind === 'token' ? { kind: 'token' as const }
  : auth.kind === 'device' ? { kind: 'device' as const, device: auth.device }
  : auth.kind === 'session' ? { kind: 'session' as const, user: auth.user }
  : auth.kind === 'federation' ? { kind: 'federation' as const, peer: auth.peer }
  : undefined
```

**Five-arm source, four-arm destination.** Source: `AuthResult` at
`auth-gate.ts:29-34` has 5 kinds (`token | device | federation |
session | none`). The `'none'` arm collapses to `undefined`. Each
surviving arm becomes a `{ kind: 'X' as const, ...payload }`
literal — the `as const` annotations convert the string literal to a
literal type, preserving the 4-arm discriminated union at compile
time.

**Consumption.** Only 2 of the 44 route files reference `ctx.auth`
/`auth.kind` / `auth?.kind`:
- `src/web/routes/auth.ts` — 14 references (statusPayload, kind
  discrimination for user/device-key admin)
- `src/web/routes/security.ts` — 2 references (audit log + enroll
  kind check)

The other 42 route files ignore `auth` entirely. The 4-arm
`ctxAuth` union is therefore defensive infrastructure — it exists so
a future code path COULD branch on `kind`, but the only consumer
that branches on it today is `routes/auth.ts` (which uses `session`,
`token`, `device`).

### §1.4 Module-level mutable state

`web.ts` carries zero module-level `let` bindings. All state is
**closure-scoped to `startWebServer`**:

| Local in `startWebServer` | Line | Type | Purpose |
|---|---:|---|---|
| `port` | `:88` | `number` (parameter, default 3420) | Bound port |
| `origClose` | `:548` | `(cb?: ...) => void` | Saved reference to the unmodified `server.close` |
| 21 timeout/interval handles | various | `NodeJS.Timeout \| undefined` | Tracked individually for the shutdown override |

The 19 `*Interval` locals plus `tokenCollectInterval` and the
inline `authSessionSweepInterval` are individually tracked so the
hand-rolled close handler can clear them. Each is `NodeJS.Timeout
| undefined` (gated by `webOnly`). This is the strongest case for
the `DashboardServer` class refactor — `private intervals: NodeJS.Timeout[]`
plus a private `clearAllIntervals()` method eliminates the hand-typed
21-line shutdown block.

### §1.5 Side effects (in order during `startWebServer`)

1. **Filesystem mkdir**: `ensureDirs()` at `:84-86` (per C-B §1.1)
   creates `AGENTS_BASE_DIR` if missing.
2. **Token load**: `loadOrCreateDashboardToken()` at `:94` (per C-B
   §1.1) — reads or generates the bearer token from disk.
3. **CORS / origin allowlist**: set on the request listener (`:99-120`).
4. **Port probe + reclaim**: tries to bind `port`; if EADDRINUSE,
   runs a port-reclaim path (formerly `acquirePortLock`-style reclaim
   via `/proc`-based pid scan; now invoked via `new PortLockAcquirer(procCtx).acquire(WEB_PORT, ...)` at `index.ts:350`)
   (`:230-279`).
5. **`http.Server` listen**: opens the listener at `:280-285`.
6. **Route registration**: 43 `tryHandle*` calls in the dispatch
   chain at `:173-215`.
7. **19 runner starts**: at `:334-447`, in the order documented in
   `c-web/02 §1.5` and `c-web/03 §C3`. The order matters for
   cross-runner dependencies (e.g. message router needs the agent
   process monitor running first).
8. **Return**: returns `http.Server` synchronously.

### §1.6 Logger call sites

`grep -nE "logger\.(info|warn|error|debug)" src/web.ts | wc -l` →
**50** (verified 2026-08-30). The C-B §10 claim of "50 in `web.ts`"
is correct.

### §1.7 Unsafe casts

| Line | Cast | Pattern |
|---|---|---|
| 117 | `req.headers['x-forwarded-host'] as string \| undefined` | Node headers union to string. Repeated 3× in this file (L117, L129, L130). |
| 155-158 | `{ kind: 'token' as const }` etc. (4 occurrences) | NOT a cast — `as const` literal-type narrow. SAFE. |

**Zero `as any` / `as unknown as`.** The header union-narrow is the
only unsafe cast in `web.ts`; it is canonical Node IncomingMessage
idiom (CLAUDE.md §7 allows with a typeguard; the cast is necessary
until a wrapper function lands).

### §1.8 HMR hazards

If `web.ts` is re-imported (HMR or duplicate import):

1. The `startWebServer` closure re-binds — a new port listener is
   created if `startWebServer()` is called twice.
2. The 21 cleanup calls re-bind — but the original interval handles
   are no longer reachable via the new closure; the OLD server's
   `server.close` override is the only way to clear them.
3. **Concrete hazard**: if test code does `vi.resetModules()` +
   re-import + `new startWebServer(port)`, the original intervals
   continue running under the OLD closure; the new server's
   `close` only clears the NEW closure's handles. This is the
   canonical "interval accumulation" risk.

The class refactor (`DashboardServer.intervals: NodeJS.Timeout[]`
field) makes this hazard visible — `stop()` clears the array as
one operation, but the array is only valid for the CURRENT class
instance. HMR safety is not improved by the class form; it is
preserved at best.

---

## §2. `src/web/auth-gate.ts` inventory (121 LOC)

### §2.1 AuthResult — 5-arm discriminated union (verified `auth-gate.ts:29-34`)

```ts
export type AuthResult =
  | { kind: 'token' }
  | { kind: 'device'; device: string; deviceId: number }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string }
  | { kind: 'none' }
```

| Kind | Discriminator | Payload | Source function |
|---|---|---|---|
| `token` | `kind` only | — | `checkBearerToken` at `:84` (internal) |
| `device` | `kind` + `device: string` + `deviceId: number` | device key name + row id | `resolveDeviceKey` at `:92-94` (imported from `auth-device-keys.js`) |
| `federation` | `kind` + `peer: string` | authenticated peer system id (lowercased) | `identifyFederationCaller` at `:108-111` (imported from `federation/config.js`) |
| `session` | `kind` + `user: string` | dashboard user username | `resolveSession` at `:114-118` (imported from `auth-sessions.js`) |
| `none` | `kind` only | — | fallthrough at `:120` |

**Note** (per M9): `device: string` is the device key's `name`
column, NOT the full `DeviceRow`. `deviceId: number` is a separate
field carrying the row id for callers that need it. `peer: string`
is the peer's system id (already lowercased by
`identifyFederationCaller`). The 4-arm `ctxAuth` projection at
`web.ts:154-159` uses only `device` and `peer` — `deviceId` is
dropped at the route boundary (per M9 finding).

### §2.2 `resolveAuth` signature — `src/web/auth-gate.ts:76-121`

```ts
export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
): AuthResult
```

5 parameters. Pure-ish: the only "state" closed-over is
`loadOrCreateDashboardToken` (NOT used here — it is only the input
token) and `getFederationConfig` (called inside
`identifyFederationCaller`). All 5 params are required (no defaults).
`AuthResult` return type is exact (not narrowed).

### §2.3 Other types and exports

| Symbol | Kind | Line | Notes |
|---|---|---:|---|
| `AuthResult` | DU union | 29-34 | 5-arm |
| `SESSION_COOKIE_NAME` | const string | 36 | `'mv_session'` |
| `parseCookies(header)` | function | 40-52 | returns `Record<string, string>` |
| `isSsePaneStream(path, method)` | function | 54-56 | internal |
| `isFederationWireEndpoint(path, method)` | function | 58-63 | exported |
| `requiresAuth(path, method)` | function | 68-74 | exported |
| `resolveAuth(req, url, path, method, dashboardToken)` | function | 76-121 | exported, returns `AuthResult` |

**No interfaces, no generics, no classes.** The file is a 121-LOC
module of 5 functions + 1 type alias + 1 const. The "sealed class
hierarchy" route would balloon it to ~250 LOC for no behavioral
gain — per OE-4, the AuthResult union stays as-is.

### §2.4 `instanceof` check sites in `web/` for AuthResult-derived errors

| File | Line | Class | Purpose |
|---|---:|---|---|
| `web/routes/federation.ts` | 319 | `RequestBodyTooLargeError` | catch and translate to 413 |
| `web/http-helpers.ts` | 25 | `RequestBodyTooLargeError` | throws from `readBody` |
| `web/federation/http.ts` | 7 | `PeerResponseTooLargeError` | throws from `readBoundedBody` |
| `web/federation/poller.ts` | 68 | `FederationPollInternalError` | throws from `pollPeerManifests` belt-catch |
| `web/password-hash.ts` | 40 | `PasswordPolicyError` | throws from `assertPasswordPolicy` (consumed in `routes/auth.ts:271`, `routes/auth.ts:327`) |
| `web/bridge-enroll.ts` | 30 | `RemoteEnrollError` | consumed in `routes/security.ts:95` |

**No `instanceof AuthResult`** — AuthResult is a type, not a class
(per OE-4). The framework's C2 finding stands: zero sites need
narrowing by class because there are no classes.

---

## §3. `src/web/main-agent.ts` inventory (49 LOC)

```ts
// web/main-agent.ts (49 lines)
import { join } from 'node:path'
import { homedir } from 'node:os'
import { MAIN_AGENT_ID, SERVICE_ID } from '../config.js'

export function channelsSessionName(mainAgentId: string): string { ... }
export function channelsLaunchdLabel(serviceId: string): string { ... }
export function channelsPlistPath(serviceId: string): string { ... }
export const MAIN_CHANNELS_SESSION = channelsSessionName(MAIN_AGENT_ID)
export const MAIN_CHANNELS_PLIST = channelsPlistPath(SERVICE_ID)
export function isMainChannelsAgent(name: string): boolean { ... }
```

**Imports.** `MAIN_AGENT_ID, SERVICE_ID` from `'../config.js'` (B-tier
config exports). The file is a 49-LOC pure utility (no `logger`, no
I/O, no state) that derives four canonical strings from the brand
and service id. Every function is `string → string` (deterministic,
side-effect-free).

**No types exported.** No interfaces, no unions, no generics, no
classes. All exports are runtime values (3 functions + 2 constants
+ 1 predicate).

**CE-7 cross-reference.** Per CE-7 (`web/heartbeat-agent-scaffold.ts`
is a prompt-builder, NOT a runner), `main-agent.ts` is a pure
utility too. The `buildHeartbeatAgentPrompt` and `ensureHeartbeatAgent`
calls mentioned in the prompt live in `web/heartbeat-agent-scaffold.ts`,
NOT in `web/main-agent.ts`. Per C-mr3 confirmation, this file is
correctly excluded from C scope.

**Verdict.** `web/main-agent.ts` is too small to refactor — no
class-conversion candidate, no generic opportunity, no unsafe cast.
It would inherit a `LoggerLike` only transitively (currently it
doesn't import `logger` at all).

---

## §4. `src/web/routes/` inventory (44 files)

`ls src/web/routes/ | wc -l` → **44** files (verified 2026-08-30).
Includes:
- 43 route files exporting `tryHandle*`
- `types.ts` — exports `RouteContext` (L7-25) and `RouteHandler`
  (L27); NO `tryHandle*` export

`grep -c "if (await tryHandle" src/web.ts` → **43** calls in the
dispatch chain at `web.ts:173-215`. The 43-file vs 44-file
discrepancy is `types.ts` (which has no `tryHandle`).

### §4.1 Common patterns

Every route file imports the same type:
```ts
import type { RouteContext } from './types.js'
```

The 43 `tryHandle*` signatures are uniform:
```ts
export async function tryHandleXxx(ctx: RouteContext): Promise<boolean>
```

Two carry a second parameter (file path injection for the static-served
web SPA):
- `tryHandleAgents(ctx: RouteContext, webDir: string)` — `routes/agents.ts:541`
- `tryHandleMarveen(ctx: RouteContext, webDir: string)` — `routes/marveen.ts:48`
- `tryHandleStatic(ctx: RouteContext, webDir: string)` — `routes/static.ts:91`

Three additional runners live in route files (out-of-pattern):
- `startApprovalTimeoutSweeper(): NodeJS.Timeout` — `routes/approvals.ts:54`
- `startCostsSyncTask(intervalMs = SYNC_INTERVAL_MS): NodeJS.Timeout` — `routes/costs.ts:22`
- `sweepOrphanedBackgroundTasks(): void` — `routes/background-tasks.ts:126` (corrected per C-mr1)

### §4.2 RouteContext — defined in `src/web/routes/types.ts:7-25`

```ts
export interface RouteContext {
  req: http.IncomingMessage
  res: http.ServerResponse
  path: string
  method: string
  url: URL
  /** Federation caller identity (gate sets this; null for dashboard tokens) */
  fedPeer: string | null
  /** Resolved principal for this request. Absent = no credential (public paths only) */
  auth?: { kind: 'token' | 'session' | 'federation' | 'device'; user?: string; peer?: string; device?: string }
}
export type RouteHandler = (ctx: RouteContext) => Promise<boolean>
```

**`auth?:`** is OPTIONAL (the route runs on public paths without a
principal) AND its `kind` is a 4-string union, not the 5-arm
`AuthResult` from `auth-gate.ts:29-34`. The `none` arm never reaches
the route — `web.ts:143-152` short-circuits with 401 when
`auth.kind === 'none'` on a gated path. The 4-kind `RouteContext.auth`
type is therefore deliberately NARROWER than `AuthResult` (no
`none`).

### §4.3 The 4-armed ctxAuth consumption audit

| File | References | What it does |
|---|---:|---|
| `routes/auth.ts` | 14 | `statusPayload(auth)`, `auth?.kind !== 'session'`, `kindAllowed(auth, USER_ADMIN_KINDS)`, `kindAllowed(auth, DEVICE_KEY_ADMIN_KINDS)` |
| `routes/security.ts` | 2 | `ENROLL_KINDS.includes(auth.kind as ...)`, `logConfigChange(..., auth.kind)` |

**All other 42 route files ignore `ctx.auth` entirely.** The 4-arm
`ctxAuth` union is consumed by `auth.ts` (which uses `session`/
`token`/`device`/`auth.user`/`auth.device`) and `security.ts` (which
uses `auth.kind` for audit). Neither file branches on `federation`
— the federation kind never reaches these endpoints (the gate's
federation whitelist is `/api/federation/manifest` +
`/api/federation/inbox` only, and these are NOT auth-admin endpoints).

**Implication.** The `federation` arm of `RouteContext.auth` is
**DEAD TYPE** — it exists for symmetry with `AuthResult` and for
`federation.ts:329` (`ctx.fedPeer` is read directly, not
`ctx.auth.peer`). The `device` arm is alive but only in `auth.ts:122-135`
(status payload).

### §4.4 Response patterns

Every route handler writes JSON via the shared `json()` helper at
`web/http-helpers.ts:56-65`:

```ts
export function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  })
  res.end(JSON.stringify(data))
}
```

`data: unknown` — `json()` does NOT verify the payload is
JSON-serializable. Routes that emit typed payloads construct them
inline; some helpers return explicit `unknown` (e.g.
`buildManifest(cfg, callerPeerId): unknown` at `routes/federation.ts:203`,
`peerView(p): unknown` at `:244`, `peersView(cfg): unknown` at `:256`).

### §4.5 Discriminated-union opportunities in route responses

No route returns a DU of response bodies. The closest pattern is the
`JSON_PARSE_ERROR` sentinel at `routes/federation.ts:268` — a
non-serializable `Symbol` used to distinguish "parse failed" from
"parsed as `{__error:true}`". The `InboxAccept | { status: number;
error: string }` DU at `routes/federation.ts:115,125-181` is the
ONLY honest DU in a route response; the caller uses `'status' in
verdict` (L331) to discriminate. No `instanceof` opportunities
exist.

### §4.6 Unsafe casts in routes

**`: any` typed locals** (counted via `grep -nE ": any|: any\[|let .*: any" src/web/routes/*.ts`):

| File | Lines with `any` |
|---|---|
| `routes/agents.ts` | 1 (L1568 `let access: any = ...`) |
| `routes/memories.ts` | 1 (L140 `(d: any)`) |
| `routes/recall.ts` | 1 (L239 `formatRecallResult(result: { logs: any[]; ... })`) |
| `routes/overview.ts` | 2 (L38 `let e: any`, L48 `(b: any)`) |
| `routes/status.ts` | 1 (L13 `const items: any[]`) |
| `routes/vault-ssh.ts` | 1 (L194 `catch (err: any)`) |
| `routes/connectors.ts` | 9 (L35, L48, L91, L417, L463, L530, L565, L688, L713, L822) |
| `routes/fleet.ts` | 3 (L28, L52, L65 `catch (err: any)`) |
| `routes/vault-ssh-keys.ts` | 3 (L99, L132, L153 `catch (err: any)`) |

Total: ~22 sites. The `catch (err: any)` idiom is the dominant
pattern (10+ sites). CLAUDE.md §7 bans `any` — these should all
become `catch (err: unknown)` followed by an `instanceof Error`
check.

**`as` casts on `Record<string, unknown>` body fields** (the
`federation/config.ts` validator pattern, repeated in
`routes/federation.ts`):

| File | Count | Pattern |
|---|---:|---|
| `web/federation/config.ts` | 5 | `(rawSystemId as string).toLowerCase()` after the validator's `isValidIdSegment` check |
| `web/routes/federation.ts` | 3 | `(p.id as string)`, `(p.baseUrl as string)` after manual narrowing in the PATCH/POST handlers |
| `web/routes/agent-taskstate.ts` | 5 | `(fields.doneSteps as string[] \| undefined)` etc. — Record-to-typed coercion |
| `web/routes/auth.ts` | 1 | `ENROLL_KINDS.includes(auth.kind as ...)` — narrowing cast |

Per CLAUDE.md §7 the `Record<string, unknown>` access pattern would
benefit from a `validated<T>(body, key, guard)` typeguard helper —
but that's H-tier cross-cutting work, not C-local.

---

## §5. `src/web/federation/` inventory (9 files)

`ls src/web/federation/ | wc -l` → **9** (verified 2026-08-30):
`address.ts`, `bridge.ts`, `capabilities.ts`, `capability-runner.ts`,
`config.ts`, `http.ts`, `local-catalog.ts`, `onboarding.ts`,
`poller.ts`. Total ~1835 LOC per CE-2.

### §5.1 Per-file inventory

| File | LOC | Module-level lets | Classes | Side effects |
|---|---:|---|---|---|
| `address.ts` | 51 | 0 | 0 | pure functions on string parsing |
| `bridge.ts` | 179 | 1 (`federationCache` at L54 — Map) | 0 | outbound HTTP POST (federated message); file reads |
| `capabilities.ts` | 343 (largest) | 1 (`capabilityCache` at L62 — Map per CE-10) | 0 | cache reads/writes; capability summary builder |
| `capability-runner.ts` | 89 | 0 | 0 | `startCapabilitySummaryRunner()` at L80 — interval |
| `config.ts` | 393 (tied largest) | 2 (`cachedConfig` at L215; `watcher` at L217 — per CE-C10/F CE-F1) | 0 | fs.watch + lazy cache + env reads |
| `http.ts` | 40 | 0 | **1 (`PeerResponseTooLargeError` at L7)** | `readBoundedBody` + `postJson` helpers (pure) |
| `local-catalog.ts` | 60 | 0 | 0 | pure catalog queries |
| `onboarding.ts` | 393 (tied largest) | 0 | 0 | onboarding flow (write to CLAUDE.md) |
| `poller.ts` | 287 | 1 (`statusCache` at L59 — plain `Map<string, PeerStatus>()` per C3 / CE-C10) | **1 (`FederationPollInternalError` at L68)** | `startFederationPoller()` at L276 — interval; outbound HTTP GET for peer manifests |

### §5.2 Existing classes (per CE-1)

**`PeerResponseTooLargeError`** at `web/federation/http.ts:7`:

```ts
export class PeerResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Peer response exceeded ${limit} bytes`)
    this.name = 'PeerResponseTooLargeError'
  }
}
```

- Inherits `message`, `name`, `stack` from `Error`. No additional
  fields (the `limit` argument is consumed by the message only —
  not stored).
- Consumers: `web/federation/poller.ts:199` (`err instanceof
  PeerResponseTooLargeError ? 'manifest too large' : truncate(...)`).
- No test seam (`_resetXForTest` not needed — class is stateless).
- Survives unchanged per CE-1.

**`FederationPollInternalError`** at `web/federation/poller.ts:68`:

```ts
export class FederationPollInternalError extends Error {
  constructor(public readonly peerId: string, public readonly cause: unknown) {
    super(`federation poller: internal error for peer ${peerId}`)
    this.name = 'FederationPollInternalError'
  }
}
```

- Fields: `peerId: string`, `cause: unknown`. The parameter-property
  form (`public readonly` in the constructor signature) is a TS
  shorthand that declares + initializes in one step — equivalent to
  a private field + assignment in the body (E-B finding).
- Consumers: `web/federation/poller.ts:237` (thrown as
  `throw new FederationPollInternalError(peer.id, err)`). Only 1
  throw site; the `instanceof` check is NOT used to narrow — `cause:
  unknown` is logged via `logger.warn({ err, peer: peer.id }, ...)`.
- The typed wrapper exists purely so the interval timer's `.catch`
  at L278-280 / L282-286 gets a typed name to log.
- Survives unchanged per CE-1.

### §5.3 Interface / type inventory (federation + routes + auth-gate)

| Symbol | Kind | File | Line | Notes |
|---|---|---|---:|---|
| `AuthResult` | DU union | `web/auth-gate.ts` | 29 | cited above |
| `BridgeSendResult` | DU union | `web/federation/bridge.ts` | 43 | `{ kind: 'delivered'; remoteId } \| { kind: 'failed'; error } \| { kind: 'retry'; error } \| { kind: 'skipped' }` — 4-arm result of `sendFederatedMessage` |
| `QualifiedId` | interface | `web/federation/address.ts` | 11 | `{ system: string; agent: string }` |
| `FederationRoutingMode` | string literal union | `web/federation/config.ts` | 55 | `'strong' \| 'catalog-first' \| 'advisory'` |
| `FederationPeer` | interface | `web/federation/config.ts` | 59 | 7 fields (id, baseUrl, outboundToken, inboundToken, trust, abandonWindowMinutes?, shareCapabilitySummaries?) |
| `FederationConfig` | interface | `web/federation/config.ts` | 73 | `{ enabled, systemId, routingMode?, peers }` |
| `PeerPollState` | string literal union | `web/federation/poller.ts` | 39 | `'ok' \| 'auth-or-disabled' \| 'error' \| 'unreachable' \| 'unpaired' \| 'unknown'` — 6 values |
| `PeerManifest` | interface | `web/federation/poller.ts` | 41 | `{ system, marveenVersion, federationVersion, agents, skills }` |
| `PeerStatus` | interface | `web/federation/poller.ts` | 49 | 7 fields (id, baseUrl, state, lastChecked, lastOkAt, error?, manifest?) |
| `InboxAccept` | interface | `web/routes/federation.ts` | 115 | `{ from, to, content, ref: string \| null }` |
| `MarveenIdentityCore` | interface | `web/routes/marveen.ts` | 27 | 5 fields, includes `role: 'main'` |
| `RouteContext` | interface | `web/routes/types.ts` | 7 | cited above |
| `RouteHandler` | type alias | `web/routes/types.ts` | 27 | `(ctx) => Promise<boolean>` |
| `OnboardingIdentity` | interface | `web/federation/onboarding.ts` | 44 | `{ botName, mainAgentId, webPort, lang }` |
| `CapabilityCacheEntry` | interface | `web/federation/capabilities.ts` | 46 | `{ summary?, sourceHash, generatedAt?, lastAttemptAt?, consecutiveFailures?, rejected? }` |
| `CapabilityCache` | type alias | `web/federation/capabilities.ts` | 57 | `Record<string, CapabilityCacheEntry>` |
| `SummarySource` | interface | `web/federation/capabilities.ts` | 117 | `{ displayName, model, roleHead, skills }` |
| `JSON_PARSE_ERROR` | symbol const | `web/routes/federation.ts` | 268 | `Symbol('json-parse-error')` — sentinel for body parse failure |

**Total.** 9 interfaces + 5 type aliases + 2 literal unions + 2 classes + 1 symbol = **19 type definitions** across `federation/` + `routes/` + `auth-gate.ts` + `http-helpers.ts`. None generic.

### §5.4 Cross-section grep — `Record<string, unknown>` casts in federation/

| File | Lines with `as string` |
|---|---:|
| `federation/config.ts` | 5 (L125 `rawSystemId as string`, L136 `p.id as string`, L145 `p.inboundToken as string`, L153 `p.outboundToken as string`, L176 `p.baseUrl as string`) |
| `federation/bridge.ts` | 0 |
| `federation/poller.ts` | 0 |
| `federation/http.ts` | 0 |
| `federation/address.ts` | 0 |
| `federation/capabilities.ts` | 0 |
| `federation/onboarding.ts` | 0 |
| `federation/local-catalog.ts` | 0 |
| `federation/capability-runner.ts` | 0 |

All 5 federation/config.ts casts happen AFTER the validator's type
narrowing (`isValidIdSegment(rawSystemId)` returns `true` so
`rawSystemId as string` is sound — TS doesn't always propagate the
narrowing through the surrounding expression). Zero `as any`, zero
`as unknown as`. A `validated(raw): string` helper would eliminate
all 5.

### §5.5 Cross-section grep — logger call sites in federation/

`grep -nE "logger\.(info|warn|error|debug)" src/web/federation/*.ts | wc -l` → **12** (verified 2026-08-30). Concentrated in `config.ts` (3 at L226, L235, L374), `poller.ts` (3 at L236, L279, L284), `capability-runner.ts` (2 at L68, L76), `onboarding.ts` (3 at L349, L387, L390), `bridge.ts` (1 at L178).

---

## §6. Cross-file state sharing — auth-gate → web.ts → 44 routes

State flows in three layers:

| Layer | File | State | Consumer |
|---|---|---|---|
| **Input** | `web/auth-gate.ts` | `dashboardToken` (passed in), `loadOrCreateDashboardToken` output (boot-time) | `resolveAuth` reads `dashboardToken` parameter |
| **Coordination** | `src/web.ts:88-547` | `port`, `server`, 21 interval/timeout handles, `workerStartupCancelled = true` flag (per CE-C16) | The 43 dispatch calls + the 19 runner starts |
| **Output** | `src/web/routes/types.ts:7-25` | `RouteContext` (per-request) | 43 `tryHandle*` handlers |

**Specifics:**
- `resolveAuth(req, url, path, method, dashboardToken)` returns
  `AuthResult` (5-arm). The caller (`web.ts:154-159`) projects to
  `ctxAuth` (4-arm or `undefined`).
- `web.ts:171` builds `routeCtx: RouteContext` with `auth: ctxAuth`
  and dispatches to `tryHandleAuth(routeCtx)` first (per
  `web.ts:173`).
- 42 of 43 routes ignore `auth`. Only `routes/auth.ts` and
  `routes/security.ts` discriminate on it.

**No class instances carry state across files.** Every state piece
is either module-level (`logger` singleton), closure-scoped
(`startWebServer`'s locals), or per-request (`RouteContext`).
The class refactor preserves this — `DashboardServer` carries
the 21 handles; `AuthGate` carries `dashboardToken`; routes still
get per-request `RouteContext`.

---

## §7. ChannelPairingStore integration (per G-A / CE-C11 finding)

**`ChannelPairingStore` DOES NOT EXIST in the current code.**
`grep -rn "ChannelPairingStore" src/` returns nothing (verified
2026-08-30).

What exists instead:
- `web/routes/auth.ts` references `auth.user` / `auth.device` only.
- `web/routes/messages.ts:11` imports `COORDINATOR_AGENT_ID` from
  `channel-coordinator/ingest.ts` to filter `agent_messages.from_agent`.
- `web/federation/local-catalog.ts:8` imports `COORDINATOR_AGENT_ID`
  for the same purpose.
- `web/agent-message-wrap.ts:21` imports `COORDINATOR_AGENT_ID`.

**Implication for C.** Routes consume `agent_messages` rows via
`db.ts` functions (per A-tier's `MessageBus` after A.3). The
"pairing" semantics (implicit chat_id → agent mapping) live in
the dashboard's `channel-pairing.ts` (NOT in C scope) and are
read by the message-router, not by route handlers.

Per CE-C11 (parallel to GCE-6): the boundary between subsystems
is explicit — `ChannelPairingStore` (proposed in A's plan) is not
a C dependency. The pairing lookup happens in the message-router
runner (C.3), not in route handlers. If A's plan eventually
defines `ChannelPairingStore`, C does NOT need to depend on it.

---

## §8. Test mock patterns

### §8.1 `vi.mock('../web.js')` count

`grep -rn "vi\.mock.*'\.\./web\.js" src/__tests__/ 2>/dev/null | wc -l`
→ **1** (per C-mr6 + CE-C2):
`src/__tests__/index.test.ts:142` — `vi.mock('../web.js', () => ({...}))`.

**The plan's claim of "144+" was a 50× overcount.** The actual
migration surface for `vi.mock('../web.js')` is 1 file, not 144+.

### §8.2 `vi.mock('../web/routes/')` per-route count

`grep -rn "vi\.mock.*['\"]\\.\\./web/routes" src/__tests__/ | wc -l`
→ **3** files. The plan's "high" claim is also an overcount — the
actual count is 3 (per CE-C2). The 3 files are not enumerated in
the plan; a future reworker must re-measure.

### §8.3 `vi.mock('../web/atomic-write.js')` count (per C-MR4)

`grep -rn "vi\.mock.*web/atomic-write" src/__tests__/ | wc -l` →
**17** (verified 2026-08-30). The earlier plan estimate of 14 was
off by 3. Per CE-C6, `atomic-write.ts` stays a free-function module
(17 mock sites, 32 importers in `src/` including 6 routes).

### §8.4 `vi.doMock` outlier

Per the D-RC precedent, `channel-coordinator-liveness.test.ts:99`
uses `vi.doMock` (not `vi.mock`) and only stubs `channelStateDir`.
The full C scope has 1 `vi.doMock('../channel-coordinator/liveness.js')`
site in the D precedent — but no `vi.doMock('../web/...')` sites
exist in C (per `grep -rn "vi\.doMock.*['\"]\\.\\./web" src/__tests__/`
returns 0).

### §8.5 atomic-write importers (per CE-C3)

32 importers in `src/` total (excluding tests) — verified
2026-08-30. The 6 importers cited in CE-C3 are those INSIDE
`src/web/`:

| Importer | Use |
|---|---|
| `src/web/agent-taskstate.ts:4` | `atomicWriteFileSync` for record persistence |
| `src/web/agent-process.ts:26` | `atomicWriteFileSync` for `dotClaudePath` writes |
| `src/web/scheduled-tasks-io.ts:5` | `atomicWriteFileSync` for skill + config writes |
| `src/web/dashboard-auth.ts:5` | `atomicWriteFileSync` for `DASHBOARD_TOKEN_PATH` |
| `src/web/vault.ts:5` | `atomicWriteFileSync` for `VAULT_KEY_PATH` + `VAULT_PATH` |
| `src/web/fleet-transfer.ts:19` | `atomicWriteFileSync` for `overridesPath` |

The 6 in `src/web/` are correct; the additional 26 live in
`src/web/*.ts` (model-fallback-store, hook-registration-guard,
agent-bundle, dashboard-settings, agent-config, vault-bindings,
auto-restart-store, terminal-input-store, agent-team,
context-guard-store, model-fallback-runner, channel-invites,
agent-scaffold, schedule-runner, discord-group-bootstrap) +
2 in `src/web/routes/` (schedules, connectors, skills,
agents-skills, agents, onboarding — 6 routes total) + 4 cross-cutting
(`src/settings-store.ts:5`, `src/env.ts:4`, `src/web/federation/
onboarding.ts:30`, `src/web/federation/config.ts:34`,
`src/web/command-task.ts:5`).

**The CE-C3 "6 importers" is correct for src/web/, but the FULL
importer list is 32.** This matters for the per-route migration:
after C.4–C.6 migrate the routes to `RouteContext.{log, stores,
auth}`, the route files STILL call `atomicWriteFileSync` directly
— the plan's "stays free" decision means the call sites don't change.

---

## §9. Integration consumers

### §9.1 `startWebServer` (the entry point)

**1 production importer:**
- `src/index.ts:20` — `import { startWebServer } from './web.js'`
  (the only consumer; called at boot).

### §9.2 `src/web/auth-gate.ts` exports

| Export | Production importers |
|---|---|
| `resolveAuth` | `src/web.ts:7` |
| `requiresAuth` | `src/web.ts:8` |
| `isFederationWireEndpoint` | `src/web.ts:8` |
| `parseCookies` | `src/web/auth-gate.ts:40` (internal use only — exported for tests) |
| `AuthResult` (type) | `src/web.ts:7` + `src/web/routes/auth.ts` + `src/web/routes/security.ts` |

The 4 functions + 1 type have **0 production consumers outside
`web.ts`** (the gate is internal). Routes import only the `AuthResult`
type for narrowing.

### §9.3 `startInviteMonitor` — NOT a web runner (per C-CR1)

`src/index.ts:539` calls
`startInviteMonitor(MAIN_AGENT_ID, AGENTS_BASE_DIR)` (the only
production call site). `src/web.ts:455` documents what is NOT called:
*"NOTE: startMcpListChecker() is intentionally NOT called here."* —
`web.ts` never references `startInviteMonitor`. The conversion
owner is F (agent subsystem), not C (dashboard server). The
`InviteMonitor` lifecycle is owned by `index.ts`'s `shutdown()` at
`src/index.ts:378-410`, which already calls `stopInviteMonitor()` at L384.

### §9.4 Per-route imports of `db.ts` (per CE-C13)

`grep -rln "from ['\"].*db\.js['\"]" src/web/routes/ | wc -l` → **23** files.
The C.5 + C.6 phase plan adds `ctx.stores` to `RouteContext`; the 23
routes that read `db.ts` migrate their imports to `ctx.stores.X`
methods.

### §9.5 `web/main-agent.ts` exports

Re-exported via `web.ts:47-58` (5 symbols + 1 predicate). Zero
production importers outside `web.ts`.

---

## §10. Brief summary at top — recap

C is **the LARGEST subsystem** in the refactor framework:
- 576 + 121 + 49 = 746 LOC across 3 files (without routes/ and
  federation/)
- + 44 route files + 9 federation files (9 of which contain the
  `web/federation/` sub-cluster at ~1835 LOC)
- 50 + 159 + 12 = **221 logger call sites**
- 20 `clearInterval` + 1 `clearTimeout` = **21 cleanup calls** in
  the hand-rolled close handler
- 4-arm `ctxAuth` literal union, consumed by **only 2 of 44 routes**
- 3 existing classes (`PeerResponseTooLargeError`,
  `FederationPollInternalError`, `RequestBodyTooLargeError`) + 1
  existing generic class (`RemoteStatusCache<T>`)
- The class refactor produces **26-31 new classes** (3 core +
  19 runners + 4-9 federation cluster classes)
- 1 `vi.mock('../web.js')` site + 3 `vi.mock('../web/routes/')`
  sites + 17 `vi.mock('../web/atomic-write.js')` sites
- 32 importers of `web/atomic-write.ts` (6 in `src/web/` only
  per CE-C3; 26 in other locations)
- 23 of 44 routes read `db.ts` functions (per CE-C13)
- ZERO `ChannelPairingStore` exists in the current code (per
  G-A / CE-C11)

---

## §11. Cross-references (verified file:line on 2026-08-30)

### Source files

- `src/web.ts:88` — `startWebServer(port = 3420): http.Server`
- `src/web.ts:154-159` — the 4-arm `ctxAuth` ternary (corrected
  per m2; the `const ctxAuth =` line is at 154)
- `src/web.ts:171` — `routeCtx: RouteContext = { req, res, path, method, url, fedPeer: fedPeerForCtx, auth: ctxAuth }`
- `src/web.ts:173-215` — 43 `tryHandle*` calls in the dispatch chain
- `src/web.ts:230-279` — port probe + reclaim
- `src/web.ts:334-447` — 19 runner starts + 2 inline `setInterval`s
- `src/web.ts:548-573` — hand-rolled `server.close` override that
  clears 21 cleanup calls (20 `clearInterval` + 1 `clearTimeout`)

- `src/web/auth-gate.ts:25` — `identifyFederationCaller` import
- `src/web/auth-gate.ts:29-34` — `AuthResult` 5-arm union
- `src/web/auth-gate.ts:36` — `SESSION_COOKIE_NAME`
- `src/web/auth-gate.ts:40-52` — `parseCookies`
- `src/web/auth-gate.ts:54-56` — `isSsePaneStream` (private)
- `src/web/auth-gate.ts:58-63` — `isFederationWireEndpoint`
- `src/web/auth-gate.ts:68-74` — `requiresAuth`
- `src/web/auth-gate.ts:76-121` — `resolveAuth`

- `src/web/routes/types.ts:7-25` — `RouteContext` (4-arm `auth?` at L24)
- `src/web/routes/types.ts:27` — `RouteHandler`

- `src/web/main-agent.ts:1-49` — pure utility (3 functions + 2
  constants + 1 predicate; no state, no logger, no class candidate)

- `src/web/federation/address.ts:11` — `QualifiedId` interface
- `src/web/federation/bridge.ts:43` — `BridgeSendResult` 4-arm union
- `src/web/federation/capabilities.ts:46` — `CapabilityCacheEntry`
- `src/web/federation/capabilities.ts:57` — `CapabilityCache`
- `src/web/federation/capabilities.ts:62` — `capabilityCache` Map
- `src/web/federation/capabilities.ts:117` — `SummarySource`
- `src/web/federation/capability-runner.ts:80` — `startCapabilitySummaryRunner`
- `src/web/federation/config.ts:55` — `FederationRoutingMode`
- `src/web/federation/config.ts:59` — `FederationPeer`
- `src/web/federation/config.ts:73` — `FederationConfig`
- `src/web/federation/config.ts:215` — `let cachedConfig`
- `src/web/federation/config.ts:217` — `let watcher`
- `src/web/federation/http.ts:7` — `class PeerResponseTooLargeError`
- `src/web/federation/onboarding.ts:44` — `OnboardingIdentity`
- `src/web/federation/poller.ts:39` — `PeerPollState`
- `src/web/federation/poller.ts:41` — `PeerManifest`
- `src/web/federation/poller.ts:49` — `PeerStatus`
- `src/web/federation/poller.ts:59` — `statusCache` plain Map
- `src/web/federation/poller.ts:68` — `class FederationPollInternalError`
- `src/web/federation/poller.ts:276` — `startFederationPoller()`

- `src/web/http-helpers.ts:25` — `class RequestBodyTooLargeError`
- `src/web/remote-status-cache.ts:19` — `class RemoteStatusCache<T>`
  (existing per CE-1)
- `src/web/atomic-write.ts:8` — `atomicWriteFileSync` (17 vi.mock
  sites per C-MR4; 32 importers in `src/`)

### Integration consumers

- `src/index.ts:20` — `import { startWebServer } from './web.js'`
- `src/index.ts:539` — `startInviteMonitor(MAIN_AGENT_ID, AGENTS_BASE_DIR)`
  (NOT a web runner per C-CR1; owned by F)
- `src/index.ts:378-410` — `shutdown()` sequence (per M11)
- `src/index.ts:384` — `stopInviteMonitor()`

### Sibling plan documents (reference, not modified)

- `docs/refactor-to-classbase/c-web/00-summary.md` (C-Plan)
- `docs/refactor-to-classbase/c-web/02-type-interface-analysis.md` (C-B)
- `docs/refactor-to-classbase/c-web/03-class-boundaries.md` (C-3)
- `docs/refactor-to-classbase/c-web/review-correctness.md` (C-RC)
- `docs/refactor-to-classbase/c-web/review-completeness.md` (C-RCo)
- `docs/refactor-to-classbase/review-correctness.md` (framework C2/C3/CE-2/CE-3/CE-7/M9/M11/M4)
- `docs/refactor-to-classbase/review-completeness.md` (framework OE-4/CE-9/CE-7)
- `docs/refactor-to-classbase/d-channel-provider/01-module-state-analysis.md` (D precedent)
- `docs/refactor-to-classbase/a-db/01-module-state-analysis.md` (A precedent)
- `docs/refactor-to-classbase/g-channel-coordinator/01-module-state-analysis.md` (G precedent — for `ChannelPairingStore` cross-ref)

---

## §12. [ASSUMPTION] markers

- [ASSUMPTION: the `web/federation/config.ts:215` `cachedConfig` and
  `:217` `watcher` references are the file-watcher + lazy-cache pattern
  matching `settings-store.ts` per F's CE-F1 critical miss. The plan's
  CE-C10 (major) flags this as a boundary that needs explicit
  documentation in `00-summary.md` "Files this plan does NOT touch".]
- [ASSUMPTION: the `web/heartbeat-agent-scaffold.ts` file is excluded
  from C scope per F's CE-7 + this plan's C-mr3 confirmation. It is a
  prompt-builder, NOT a runner.]
- [ASSUMPTION: per C-MR1, the `DashboardServer.intervals[]` field holds
  20 entries (the `setInterval` returns); the `startupWatchdogGrace`
  timeout handle lives in a separate `graceTimeout: NodeJS.Timeout
  | undefined` field — OR the array holds all 21 (Timeout is the same
  TypeScript type).]
- [ASSUMPTION: per CE-C7, C.3 (the 19 runner classes) lands BEFORE C.7
  (the federation cluster) for the 2 federation runners
  (`FederationPollerRunner`, `CapabilitySummaryRunner`). C.7 then wraps
  these runner classes with the cluster classes (`FederationPoller`,
  `FederationCapabilityRunner`) that add the cache state.]
- [ASSUMPTION: per CE-C12, the 4 actual `vi.mock('../web.js')` + 3
  per-route mock sites must pass `bun --bun vitest run` — factory-
  hoisting under bun may diverge from Node-vitest.]
- [ASSUMPTION: per CE-C9, 23 routes that read `db.ts` functions are
  not fully enumerated in `03 §C4` — only 9 are listed; the remaining
  14 are not in the per-store blast-radius table. The 23 count is
  correct (per `grep -rln "from ['\"].*db\.js['\"]" src/web/routes/`
  returns 23); the per-route mapping needs the C.5 rollout to
  enumerate.]

---

**End of C (web) module/state analysis. No source files modified.**