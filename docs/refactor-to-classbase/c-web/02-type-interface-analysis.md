# C (web) — Type & Interface Analysis

Scope: `src/web.ts`, `src/web/auth-gate.ts`, `src/web/main-agent.ts`, `src/web/routes/` (44 files), `src/web/federation/` (10 files), `src/web/http-helpers.ts`. PLANNING ONLY — no source modifications.

---

## Brief summary

The C subsystem's type-side state is FUNCTION-SHAPED with TWO CLASSES already in place (and a third one-line class in `http-helpers.ts` not in CE-1's inventory). The 19 background service runners live as free `start*()` functions inside `startWebServer` (a single 576-line closure that closes over `port`, `server`, intervals, and side-effect helpers — every interval is tracked in a separate `const` for the manual shutdown hook at L548-573). Route handlers consume a structurally-typed `RouteContext` whose `auth?: { kind: 'token' | 'session' | 'federation' | 'device'; user?: string; peer?: string; device?: string }` is consumed by ONLY 2 of the 44 route files (`auth.ts:9` references, `security.ts:2` references). The 4-arm `ctxAuth` ternary at `web.ts:154-159` is therefore type-correct but functionally orphan — the `device`/`federation` arms are barely exercised. Unsafe casts cluster in two zones: JSON-shaped `Record<string, unknown>` body parsing (no `as` needed) and `(p.baseUrl as string)` style casts on already-validated `Record<string, unknown>` fields inside the federation validator. Logger consumption is uniform — 159 call sites across routes plus 50 in `web.ts` — every one reaches the module-level `pino` singleton via `import { logger } from '../../logger.js'`. There are ZERO `LoggerLike` constructors today (H has not landed); adopting H.1 means converting every site, but the conversion is type-additive (`pino.Logger` structurally satisfies `LoggerLike`).

---

## §1. `src/web.ts` type audit (576 LOC)

### §1.1 RouteContext — defined in `src/web/routes/types.ts:7-25`, consumed in `src/web.ts:80,171`

```ts
// src/web/routes/types.ts:7-25
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

**Observation.** `auth?:` is OPTIONAL (the route runs on public paths without a principal) AND its `kind` is a 4-string union, not the 5-arm `AuthResult` from `auth-gate.ts:29-34` (which has `token | device | federation | session | none`). The `none` arm never reaches the route — `web.ts:143-152` short-circuits with 401 when `auth.kind === 'none'` on a gated path. The 4-kind `RouteContext.auth` type is therefore deliberately NARROWER than `AuthResult` (no `none`), and the 3 per-kind optional fields (`user?`, `peer?`, `device?`) replace the discriminated-union narrowing — that's exactly the type-safety loss OE-4 warned about.

### §1.2 The ctxAuth ternary — `src/web.ts:154-159`

```ts
const ctxAuth =
  auth.kind === 'token' ? { kind: 'token' as const }
  : auth.kind === 'device' ? { kind: 'device' as const, device: auth.device }
  : auth.kind === 'session' ? { kind: 'session' as const, user: auth.user }
  : auth.kind === 'federation' ? { kind: 'federation' as const, peer: auth.peer }
  : undefined
```

**Five-arm source, four-arm destination.** Source: `AuthResult` has 5 kinds (`token | device | federation | session | none`). The `'none'` arm collapses to `undefined`. The 4 surviving arms become 4 object literals, each with a `kind` discriminator and one payload field (matching `RouteContext.auth`'s flat shape). The `as const` per-arm annotations convert the string literals to literal types — without them, `{ kind: 'token' }` would widen to `{ kind: string }` and the route's `auth.kind` discriminated union would NOT narrow downstream.

**Type of `ctxAuth` (inferred).**
```ts
ctxAuth:
  | { kind: 'token'; user?: undefined; peer?: undefined; device?: undefined }
  | { kind: 'device'; device: string; user?: undefined; peer?: undefined }
  | { kind: 'session'; user: string; peer?: undefined; device?: undefined }
  | { kind: 'federation'; peer: string; user?: undefined; device?: undefined }
  | undefined
```
The extra `user?: undefined` / `peer?: undefined` / `device?: undefined` slots appear because the inferred type unifies the optional fields across all four arms — `RouteContext.auth` declares `user?` / `peer?` / `device?` as optional, and each literal inherits that shape even when the field is absent in the source `AuthResult`.

**Consumption.** Only `routes/auth.ts:9` and `routes/security.ts:2` reference `ctx.auth`/`auth`. Every other route (42 of 44) ignores `auth` entirely. The 4-arm union is therefore defensive infrastructure — it exists so a future code path could branch on kind, but no code path does today.

### §1.3 Exported types/interfaces in `src/web.ts`

`web.ts` exports NO types or interfaces. The only exports are:
- `channelsSessionName(mainAgentId: string): string` — L10
- `channelsLaunchdLabel(serviceId: string): string` — L19
- `channelsPlistPath(serviceId: string): string` — L22
- `MAIN_CHANNELS_SESSION` (const) — L30
- `MAIN_CHANNELS_PLIST` (const) — L38
- `isMainChannelsAgent(name: string): boolean` — L47
- `startWebServer(port = 3420): http.Server` — L88

Type-exporting is fully delegated to `web/routes/types.ts` (RouteContext + RouteHandler) and `web/auth-gate.ts` (AuthResult). This is clean separation; `web.ts` is a coordinator, not a type source.

### §1.4 `src/web.ts` unsafe casts

| Line | Cast | Pattern |
|---|---|---|
| 117 | `req.headers['x-forwarded-host'] as string \| undefined` | Node headers union to string. Repeated 5× in this file alone (L117, L129, L130 passes through). |
| 155 | `{ kind: 'token' as const }` (and 3 more) | NOT a cast — `as const` literal-type narrow. Pattern repeated L155-L158. |

The header union-narrow is the ONLY unsafe cast in `web.ts`. It is the canonical Node IncomingMessage idiom (TS types headers as `string | string[] | undefined`). Project-wide per CLAUDE.md §7 there is no canonical typeguard today; the cast is necessary until a wrapper function lands.

### §1.5 The 19 web runner signatures

Counted by name pattern `start*` / `*Interval` declared/returned in `web.ts`:

| # | Symbol | Source call | Returns | Interval | L ref |
|---|---|---|---|---|---|
| 1 | `routerInterval` | `startMessageRouter()` | `NodeJS.Timeout \| undefined` | implicit (module owns) | L334 |
| 2 | `scheduleInterval` | `startScheduleRunner()` | `NodeJS.Timeout \| undefined` | implicit | L337 |
| 3 | `workerLivenessInterval` | dynamic import → `m.startWorkerLivenessMonitor()` | `NodeJS.Timeout \| undefined` | implicit | L369 |
| 4 | `pluginMonitorInterval` | `startChannelPluginMonitor()` | `NodeJS.Timeout \| undefined` | implicit | L375 |
| 5 | `startInboundProber()` | (no interval returned) | `void` | — | L383 |
| 6 | `channelHealthInterval` | `startChannelHealthMonitor()` | `NodeJS.Timeout \| undefined` | implicit | L389 |
| 7 | `costsSyncInterval` | `startCostsSyncTask()` | `NodeJS.Timeout \| undefined` | implicit | L395 |
| 8 | `stuckInputInterval` | `startStuckInputWatcher()` | `NodeJS.Timeout \| undefined` | implicit | L398 |
| 9 | `stuckToolCallInterval` | `startStuckToolCallWatcher()` | `NodeJS.Timeout \| undefined` | implicit | L401 |
| 10 | `inboxNudgeInterval` | `startInboxNudgeWatcher()` | `NodeJS.Timeout \| undefined` | implicit | L404 |
| 11 | `reauthHealerInterval` | `startReauthHealer()` | `NodeJS.Timeout \| undefined` | implicit | L407 |
| 12 | `autoRestartInterval` | `startAutoRestartRunner()` | `NodeJS.Timeout \| undefined` | implicit | L410 |
| 13 | `modelFallbackInterval` | `startModelFallbackRunner()` | `NodeJS.Timeout \| undefined` | implicit | L413 |
| 14 | `contextGuardInterval` | `startContextGuardRunner()` | `NodeJS.Timeout \| undefined` | implicit | L416 |
| 15 | `updateCheckerInterval` | `startUpdateChecker()` | `NodeJS.Timeout \| undefined` | implicit | L419 |
| 16 | `federationPollerInterval` | `startFederationPoller()` | `NodeJS.Timeout \| undefined` | implicit | L422 |
| 17 | `capabilityRunnerInterval` | `startCapabilitySummaryRunner()` | `NodeJS.Timeout \| undefined` | implicit | L425 |
| 18 | `approvalTimeoutInterval` | `startApprovalTimeoutSweeper()` | `NodeJS.Timeout` | 60s | L431 |
| 19 | `authSessionSweepInterval` | `setInterval(() => { sweepExpiredSessions(); sweepExpiredDeviceKeys() }, 60*60*1000)` | `NodeJS.Timeout` | 1h | L436 |
| — | `tokenCollectInterval` | `setInterval(() => collectTokenUsage().catch(...), 60*60*1000)` | `NodeJS.Timeout` | 1h | L447 |

20 interval handle IDs total (the user said "19"; the count is 20 if you include `tokenCollectInterval`, 19 if you don't — `tokenCollectInterval` was added later and shares the 1h cadence). All 20 are individually tracked so the hand-rolled `server.close` override at L548-573 can clear them.

**Type uniformity.** Every `*Interval` local is `NodeJS.Timeout | undefined` (because every `start*()` is gated on `webOnly`). `clearInterval(X)` accepts `undefined` silently, so the manual tracking is type-correct but verbose. This is the strongest case for `BaseRunner<TF, TD>` (the OE-5-rejected generic) — but per OE-5 most runners lack the `facts → decision` shape, and `setInterval(sweep, 3600000)` does not benefit from a class.

### §1.6 The shutdown pattern — `src/web.ts:548-573`

```ts
const origClose = server.close.bind(server)
server.close = (cb?: (err?: Error) => void) => {
  clearInterval(routerInterval)
  clearInterval(scheduleInterval)
  if (pluginMonitorInterval) clearInterval(pluginMonitorInterval)
  workerStartupCancelled = true
  if (workerLivenessInterval) clearInterval(workerLivenessInterval)
  clearTimeout(startupWatchdogGrace)
  clearInterval(startupWatchdogPoll)
  clearInterval(channelHealthInterval)
  if (costsSyncInterval) clearInterval(costsSyncInterval)
  clearInterval(stuckInputInterval)
  clearInterval(stuckToolCallInterval)
  if (inboxNudgeInterval) clearInterval(inboxNudgeInterval)
  if (reauthHealerInterval) clearInterval(reauthHealerInterval)
  clearInterval(autoRestartInterval)
  clearInterval(modelFallbackInterval)
  clearInterval(contextGuardInterval)
  clearInterval(approvalTimeoutInterval)
  clearInterval(authSessionSweepInterval)
  clearInterval(updateCheckerInterval)
  if (federationPollerInterval) clearInterval(federationPollerInterval)
  if (capabilityRunnerInterval) clearInterval(capabilityRunnerInterval)
  clearInterval(tokenCollectInterval)
  return origClose(cb)
}
```

22 `clearInterval` calls in the close handler. Each runner's lifetime is implicit (a `const` in the outer scope); ownership is by-closure-convention. This is exactly the pattern a `DashboardServer` class should own — `private intervals: NodeJS.Timeout[]` plus a `clearAllIntervals()` private method.

---

## §2. `src/web/auth-gate.ts` type audit (121 LOC)

### §2.1 AuthResult — 5-kind discriminated union

```ts
// src/web/auth-gate.ts:29-34
export type AuthResult =
  | { kind: 'token' }
  | { kind: 'device'; device: string; deviceId: number }
  | { kind: 'federation'; peer: string }
  | { kind: 'session'; user: string }
  | { kind: 'none' }
```

| Kind | Discriminator field | Payload | Source function |
|---|---|---|---|
| `token` | `kind` only | — | `checkBearerToken` at L84 |
| `device` | `kind` + `device: string` + `deviceId: number` | device key name + row id | `resolveDeviceKey` at L92-94 |
| `federation` | `kind` + `peer: string` | authenticated peer system id | `identifyFederationCaller` at L108-111 |
| `session` | `kind` + `user: string` | dashboard user username | `resolveSession` at L114-118 |
| `none` | `kind` only | — | fallthrough at L120 |

**M9 finding cross-reference.** `DeviceAuth.device: string` — the device is a STRING (the device key's `name` column), NOT the full `DeviceRow`. `deviceId: number` carries the row id for callers that need it. `PeerAuth.peer: string` is the peer's system id (lowercased). Per M9 the route consumer wants the string, not the row — confirmed at `web.ts:156` `{ kind: 'device' as const, device: auth.device }` (only `device`, not `deviceId`).

**Exhaustiveness.** The `switch (auth.kind)` in `resolveAuth` is exhaustive (TS verifies) but the union is NOT used as a `switch` — `resolveAuth` is a 5-arm `if`-cascade. The framework C2 finding is correct: the `'none'` arm maps to `undefined` in the route context (lossy collapse).

### §2.2 resolveAuth signature — `src/web/auth-gate.ts:76-121`

```ts
export function resolveAuth(
  req: http.IncomingMessage,
  url: URL,
  path: string,
  method: string,
  dashboardToken: string,
): AuthResult
```

5 parameters. Pure-ish (state is closed-over: `loadOrCreateDashboardToken` is only used as the input token, `getFederationConfig` is called inside `identifyFederationCaller`). All 5 params are required (no defaults). `AuthResult` return type is exact (not narrowed).

### §2.3 `instanceof` check sites in `web/` for AuthResult-derived errors

| File | Line | Class | Purpose |
|---|---|---|---|
| `web/routes/federation.ts` | 319 | `RequestBodyTooLargeError` | catch and translate to 413 |
| `web/http-helpers.ts` | 25 | `RequestBodyTooLargeError` | throws from `readBody` |
| `web/federation/http.ts` | 7 | `PeerResponseTooLargeError` | throws from `readBoundedBody` |
| `web/federation/poller.ts` | 68 | `FederationPollInternalError` | throws from `pollPeerManifests` belt-catch |
| `web/password-hash.ts` | 40 | `PasswordPolicyError` | throws from `assertPasswordPolicy` (consumed in `routes/auth.ts:271`, `routes/auth.ts:327`) |
| `web/bridge-enroll.ts` | 30 | `RemoteEnrollError` | consumed in `routes/security.ts:95` |

**No `instanceof AuthResult` exists** — AuthResult is a TYPE, not a class (per OE-4 it's a type alias, not a sealed hierarchy). The framework's C2 finding stands: zero sites need narrowing by class because there are no classes.

### §2.4 Other types in `auth-gate.ts`

| Symbol | Kind | Line | Notes |
|---|---|---:|---|
| `AuthResult` | union | 29-34 | 5-arm |
| `SESSION_COOKIE_NAME` | const string | 36 | `'mv_session'` |
| `parseCookies(header)` | function | 40-52 | returns `Record<string, string>` |
| `isSsePaneStream(path, method)` | function | 54-56 | internal |
| `isFederationWireEndpoint(path, method)` | function | 58-63 | exported |
| `requiresAuth(path, method)` | function | 68-74 | exported, returns boolean |
| `resolveAuth(req, url, path, method, dashboardToken)` | function | 76-121 | exported, returns AuthResult |

**No interfaces, no generics, no classes.** The file is a 121-LOC module of 5 functions + 1 type alias. The "sealed class hierarchy" route would balloon it to ~250 LOC for no behavioral gain.

---

## §3. 44 route handlers — type patterns

### §3.1 RouteContext consumption pattern

Every one of the 44 route files imports the same type:
```ts
import type { RouteContext } from './types.js'
```

The 42 pure `tryHandle*` signatures are uniform:
```ts
export async function tryHandleXxx(ctx: RouteContext): Promise<boolean>
```

Two carry a second parameter (file path injection for the static-served web SPA):
- `tryHandleAgents(ctx: RouteContext, webDir: string)` — `routes/agents.ts:541`
- `tryHandleMarveen(ctx: RouteContext, webDir: string)` — `routes/marveen.ts:48`
- `tryHandleStatic(ctx: RouteContext, webDir: string)` — `routes/static.ts:91`

Three additional runners live in route files (out-of-pattern):
- `startApprovalTimeoutSweeper(): NodeJS.Timeout` — `routes/approvals.ts:54`
- `startCostsSyncTask(intervalMs = SYNC_INTERVAL_MS): NodeJS.Timeout` — `routes/costs.ts:22`
- `sweepOrphanedBackgroundTasks(): void` — `routes/background-tasks.ts:146` (alongside `tryHandleBackgroundTasks`)

### §3.2 The 4-armed ctxAuth consumption audit

Grep for `ctx.auth` / `auth.kind` / `routeCtx.auth` across the 44 route files:

| File | References | What it does |
|---|---:|---|
| `routes/auth.ts` | 9 | `statusPayload(auth)`, `auth?.kind !== 'session'`, `kindAllowed(auth, USER_ADMIN_KINDS)`, `kindAllowed(auth, DEVICE_KEY_ADMIN_KINDS)` |
| `routes/security.ts` | 2 | `ENROLL_KINDS.includes(auth.kind as ...)`, `logConfigChange(..., auth.kind)` |

**All other 42 route files ignore `ctx.auth` entirely.** The 4-arm `ctxAuth` union is consumed by `auth.ts` (which uses `session`/`token`/`device`/`auth.user`/`auth.device`) and `security.ts` (which uses `auth.kind` for audit). Neither file branches on `federation` — the federation kind never reaches these endpoints (the gate's federation whitelist is `/api/federation/manifest` + `/api/federation/inbox` only, and these are NOT auth-admin endpoints).

**Implication for the type-side design.** The `federation` arm of `RouteContext.auth` is DEAD TYPE — it exists for symmetry with `AuthResult` and for `federation.ts:329` (`ctx.fedPeer` is read directly, not `ctx.auth.peer`). The `device` arm is alive but only in `auth.ts:122-135` (status payload).

### §3.3 Typed response patterns

Every route handler writes JSON via the shared `json()` helper at `web/http-helpers.ts:56-65`:

```ts
export function json(res: http.ServerResponse, data: unknown, status = 200): void {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'private, no-store',
  })
  res.end(JSON.stringify(data))
}
```

`data: unknown` — `json()` does NOT verify the payload is JSON-serializable. Routes that emit typed payloads construct them inline:

```ts
// routes/auth.ts:122-135 (return type inferred as the literal object)
function statusPayload(auth: RouteContext['auth']) {
  const authenticated = auth?.kind === 'token' || auth?.kind === 'session' || auth?.kind === 'device'
  // ...
  return { authenticated, method, user, device, login_available, setup_required }
}
```

Some helpers return explicit `unknown`:
- `routes/federation.ts:203` `buildManifest(cfg, callerPeerId): unknown` — returns the manifest as `unknown` (it IS a `PeerManifest` shape but the function bails on hostile inputs and never asserts the shape)
- `routes/federation.ts:244` `peerView(p): unknown`, `:256` `peersView(cfg): unknown` — same pattern
- `routes/federation.ts:275` `isErr(v: unknown): v is typeof JSON_PARSE_ERROR` — typeguard for the sentinel

Some response bodies are untyped (built inline in handlers):
- `routes/auth.ts:298` `json(res, { users: listDashboardUsers() })` — relies on inference of `listDashboardUsers()`
- `routes/messages.ts` (handler bodies, not enumerated line-by-line) — return inferred

### §3.4 Discriminated-union opportunities in route responses

No route returns a DU of response bodies. The closest pattern is the `JSON_PARSE_ERROR` sentinel at `routes/federation.ts:268` — a non-serializable `Symbol` used to distinguish "parse failed" from "parsed as `{__error:true}`". That's a manual sum-type with one constructor being a singleton symbol. It is local to `federation.ts` and doesn't generalize.

**The `InboxAccept | { status: number; error: string }` discriminated union at `routes/federation.ts:115,125-181`** is the ONLY honest DU in a route response. `validateInboxPayload` returns either an `InboxAccept` (4 fields: `from`, `to`, `content`, `ref`) or an error object (2 fields: `status`, `error`). The caller uses `'status' in verdict` (L331) to discriminate — a manual check that works because `InboxAccept` has no `status` field. This is correct as-is and does not need sealed-class conversion.

**Verdict.** No discriminated-union → sealed-class candidates in route responses. The single existing DU (`InboxAccept | error`) is pure-data with no behavior — exactly the case OE-1/2/3 cite against sealing.

### §3.5 Unsafe casts in routes

**`as any` / `any[]` / `any` typed locals** (counted via `grep -nE ": any|: any\[|let .*: any" src/web/routes/*.ts`):

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

Total: ~22 sites. The `catch (err: any)` idiom is the dominant pattern (10+ sites). CLAUDE.md §7 bans `any` — these should all become `catch (err: unknown)` followed by an `instanceof Error` check, or a try/catch that uses the wrapped helper.

**`as` casts on `Record<string, unknown>` body fields** (the `federation/config.ts` validator pattern, repeated in `routes/federation.ts`):

| File | Count | Pattern |
|---|---:|---|
| `web/federation/config.ts` | 5 | `(rawSystemId as string).toLowerCase()` after the validator's `isValidIdSegment` check |
| `web/routes/federation.ts` | 3 | `(p.id as string)`, `(p.baseUrl as string)` after manual narrowing in the PATCH/POST handlers |
| `web/routes/agent-taskstate.ts` | 5 | `(fields.doneSteps as string[] \| undefined)` etc. — Record-to-typed coercion |
| `web/routes/auth.ts` | 1 | `ENROLL_KINDS.includes(auth.kind as ...)` — narrowing cast |

Per CLAUDE.md §7 the `Record<string, unknown>` access pattern would benefit from a `validated<T>(body, key, guard)` typeguard helper — but that's H-tier cross-cutting work, not C-local.

---

## §4. `src/web/federation/` type audit (10 files, ~1835 LOC)

### §4.1 Class declarations

| Class | File | Line | Shape |
|---|---|---:|---|
| `PeerResponseTooLargeError` | `web/federation/http.ts` | 7 | `extends Error`, `constructor(limit: number)`, single param-property |
| `FederationPollInternalError` | `web/federation/poller.ts` | 68 | `extends Error`, `constructor(public readonly peerId: string, public readonly cause: unknown)`, parameter-property form (E-B finding — uses `public readonly` instead of private field + assignment) |

```ts
// web/federation/http.ts:7-12 — PeerResponseTooLargeError
export class PeerResponseTooLargeError extends Error {
  constructor(limit: number) {
    super(`Peer response exceeded ${limit} bytes`)
    this.name = 'PeerResponseTooLargeError'
  }
}
```
- Fields: inherits `message`, `name`, `stack` from Error. No additional fields (the `limit` argument is consumed by the message only — not stored).
- Consumers: `web/federation/poller.ts:199` (`err instanceof PeerResponseTooLargeError ? 'manifest too large' : truncate(...)`).
- Tests: no test seam (`_resetXForTest` not needed — class is stateless).

```ts
// web/federation/poller.ts:68-73 — FederationPollInternalError (parameter-property form)
export class FederationPollInternalError extends Error {
  constructor(public readonly peerId: string, public readonly cause: unknown) {
    super(`federation poller: internal error for peer ${peerId}`)
    this.name = 'FederationPollInternalError'
  }
}
```
- Fields: `peerId: string`, `cause: unknown`. The parameter-property form (`public readonly` in the constructor signature) is a TS shorthand that declares + initializes in one step — equivalent to a private field + assignment in the body.
- Consumers: `web/federation/poller.ts:237` (thrown as `throw new FederationPollInternalError(peer.id, err)`). Only 1 throw site; the `instanceof` check is NOT used to narrow — `cause: unknown` is logged via `logger.warn({ err, peer: peer.id }, ...)`. The cause is already captured in `err`, so the typed wrapper exists purely so the interval timer's `.catch` at L278-280 / L282-286 gets a typed name to log.

**Cross-cutting implication.** Per H-Cross `04-generic-interfaces.md` §X, these two classes are GOOD as-is (semantically distinct: one guards inbound request bodies, the other outbound peer responses). H proposes an `AppError` base — but neither of these would change shape; only the inheritance chain would extend.

### §4.2 Interface / type inventory

| Symbol | Kind | File | Line | Notes |
|---|---|---|---:|---|
| `AuthResult` (auth-gate) | DU union | `web/auth-gate.ts` | 29 | cited above |
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

### §4.3 Unsafe casts in `federation/`

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

All 5 federation/config.ts casts happen AFTER the validator's type narrowing (`isValidIdSegment(rawSystemId)` returns `true` so `rawSystemId as string` is sound — it's a TS limitation: `isValidIdSegment` is `raw is string`, but TS doesn't always propagate the narrowing through the surrounding expression). A `validated(raw): string` helper would eliminate all 5. Zero `as any`, zero `as unknown as`.

### §4.4 Duplicate unsafety with `routes/federation.ts`

`routes/federation.ts` carries 3 identical-style casts (L569 `p.id as string`, L587 `p.baseUrl as string`, L628 `p.baseUrl as string`). These are inside the PATCH/POST handlers after manual narrowing (`if (!isValidIdSegment(p.id)) return false`). Same pattern as config.ts — sound, but verbose.

---

## §5. `src/web/main-agent.ts` (49 LOC)

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

**Imports.** `MAIN_AGENT_ID, SERVICE_ID` from `'../config.js'` — these are `Config` exports (B-type). The file is a 49-LOC pure utility (no `logger`, no I/O, no state) that derives four canonical strings from the brand/service id. Every function is `string → string` (deterministic, side-effect-free).

**No types exported.** No interfaces, no unions, no generics, no classes. All exports are runtime values (3 functions + 2 constants + 1 predicate).

**CE-7 cross-reference.** Per CE-7 (`web/heartbeat-agent-scaffold.ts` is a prompt-builder, NOT a runner), `main-agent.ts` is a pure utility too. The `web/main-agent.ts` is the file the `buildHeartbeatAgentPrompt` and `ensureHeartbeatAgent` calls mentioned in the prompt — but **those symbols live in `web/heartbeat-agent-scaffold.ts`, not `web/main-agent.ts`**. This file has zero references to either; it's only the session-name helpers. The prompt's "buildHeartbeatAgentPrompt call / ensureHeartbeatAgent call — types" question applies to `web/heartbeat-agent-scaffold.ts`, not to this file.

**Verdict.** `web/main-agent.ts` is too small to refactor — it has no class-conversion candidate, no generic opportunity, no unsafe cast. It would inherit a `LoggerLike` if `DashboardServer` takes one, but only as a transitive dependency (currently `web/main-agent.ts` doesn't import `logger` at all).

---

## §6. `DashboardServer` class design sketch

### §6.1 Dependencies

From the dependency analysis above, `startWebServer` (the function `DashboardServer` would wrap) uses:

| Tier | Dependency | Source | Today's import |
|---|---|---|---|
| Config | `WEB_HOST`, `WEB_PORT`, `DASHBOARD_PUBLIC_URL`, `DASHBOARD_ALLOWED_ORIGINS`, `PROJECT_ROOT`, `MAIN_AGENT_ID` | `config.js` (B) | L6 |
| Logging | `logger` | `logger.js` (global singleton) | L32 |
| Auth gate | `loadOrCreateDashboardToken`, `resolveAuth`, `requiresAuth`, `isFederationWireEndpoint`, `AuthResult` | `web/dashboard-auth.js`, `web/auth-gate.js` | L7-8 |
| Sessions | `sweepExpiredSessions`, `sweepExpiredDeviceKeys` | `web/auth-sessions.js`, `web/auth-device-keys.js` | L9-10 |
| CSRF | `isBlockedCrossOriginWrite`, `originMatchesServedHost` | `web/csrf-origin.js` | L11 |
| HTTP | `json`, `readBody` | `web/http-helpers.js` | L12 |
| Network | `detectLanIp` | `web/network-info.js` | L13 |
| Agent config | `AGENTS_BASE_DIR`, `listAgentNames` | `web/agent-config.js` | L14 |
| Scaffold | `ensureAgentHooks`, `ensureAgentStalenessHook`, `ensureEgressGate`, `ensureGovernanceGateCommands`, `ensureQuarantineReader`, `ensureDefaultScheduledTasks`, `agentSettingsPath`, `ensureAutonomySection` | `web/agent-scaffold.js` | L15 |
| Hook guard | `shouldRegisterHooks`, `pruneStaleHooksFromSettingsFile` | `web/hook-registration-guard.js` | L16 |
| Telegram | `refreshMarveenBotUsername` | `web/telegram.js` | L17 |
| Background services | 19 runner modules | `web/*.js` | L18-31, L38-40 |
| Routes | 42 `tryHandle*` | `web/routes/*.js` | L33-79 |

**Cross-part dependencies per the plan framework:**
- **B (Config).** 6 config values consumed. The `Config` class (per B) would expose these as readonly fields — no change to call sites needed.
- **A (entity stores).** ZERO direct imports. Routes do import from A (e.g. `db.js`) but `web.ts` itself doesn't. The C tier does not need to import A directly.
- **D (ChannelProvider).** NOT used in `web.ts`. Routes that need channels reach for them through helpers (`telegram.js` etc.). Per OE-9 / CE-9 the `DashboardServer` does NOT need a `ChannelProvider` parameter — channel work happens in the route layer.
- **H (cross-cutting).** `LoggerLike` is the only H dependency. Today: module-level `logger`. After H lands: pass `LoggerLike` in the constructor.

**Proposed constructor signature (Phase 7 sketch — DO NOT IMPLEMENT):**
```ts
interface DashboardServerDeps {
  config: Config                  // B-tier
  log: LoggerLike                 // H-tier
  port?: number                   // default 3420
  webDir: string                  // PROJECT_ROOT/web — derived from config
}

class DashboardServer {
  constructor(deps: DashboardServerDeps)
  start(): http.Server
  stop(): Promise<void>
  registerRoute(path: string, handler: RouteHandler): void  // extension seam
  getAuthContext(req: http.IncomingMessage, url: URL, path: string, method: string): RouteContext['auth']  // extracted from web.ts:154-159
}
```

### §6.2 Public surface

| Method | Behavior |
|---|---|
| `start(): http.Server` | runs `ensureDirs()`, opens the listener, starts all background services, returns the `http.Server` |
| `stop(): Promise<void>` | clears all 20+ intervals, closes the server, awaits drain |
| `registerRoute(path, handler)` | inserts a handler into the dispatcher chain (today: the chain is hard-coded at L173-215) |
| `getAuthContext(req, url, path, method)` | returns the 4-arm `RouteContext['auth']` (today's `ctxAuth` ternary at L154-159) |

**Lifecycle.** `DashboardServer` is constructed ONCE at boot (`index.ts` equivalent — the `startWebServer()` call is the entry point). `start()` is called immediately by the constructor OR by the consumer (factory-style). `stop()` is called from `process.on('SIGTERM')` / `'SIGINT'` if a shutdown hook is added (today there is none — `server.close` is the manual override at L548-573, never invoked in the current code).

**Deps-bundle opts.** Per B.Config precedent, the deps-bundle opts pattern (one positional `{config, log, port?, webDir?}` arg) avoids the 6+ positional params trap. The `port` default of 3420 stays in the constructor (`port = 3420` becomes `port?: number` in the bundle).

### §6.3 What `DashboardServer` does NOT need

- **No `App.getStore<K>()`** (OE-9 rejected) — routes get stores via their own imports, not through `DashboardServer`.
- **No ChannelProvider** (D-tier) — channels are wired at the route level.
- **No entity stores** (A-tier) — `web.ts` doesn't import from `db.js`; the routes do, and they would import `db.js` directly after A's refactor lands (or reach the new `MemoryStore` etc. through their own constructors).
- **No federation config** — the dispatcher doesn't care about federation state; the gate (`resolveAuth`) does.

---

## §7. AuthContext decision — OE-4 DROPPED, confirm

Per `review-completeness.md` OE-4 (lines 79-102):

> "The source at `web.ts:155-159` is a 4-arm ternary that already produces type-safe objects ... The runtime cost is 44 route handlers × per-request allocation. The compile-time benefit is zero — the existing ternary already exhaustively narrows on `auth.kind`."

**Confirmed: AuthContext sealed class hierarchy is DROPPED.** The current `RouteContext.auth?: { kind: 'token' | 'session' | 'federation' | 'device'; user?; peer?; device? }` is kept as-is. Rationale:

1. **Compilation already exhaustive** — the 4-arm ternary at `web.ts:154-159` exhaustively narrows on `auth.kind`. Sealing adds no compile-time safety.
2. **Per-request heap allocation** — every request that reaches a gated route currently pays ZERO allocations for the auth object (the literal types come from a `const`-narrowed object spread). Sealing would allocate one of 4 subclasses per request, multiplied by 44 routes × N requests.
3. **Migration window** — the `RouteContext` type would need a dual-representation during transition (per OE-4's §D4 admission). That dual representation is a regression, not a refactor.
4. **CE-3 blast radius** — `RouteContext` lives in `web/routes/types.ts:7-25`. If `auth` becomes a sealed class, every `routes/auth.ts` consumer that branches on `auth.kind` (9+ references) would need rewriting to `instanceof TokenAuth` etc. — a 1-to-1 type rewrite with zero behavioral change.

**Alternative kept (the current shape).** `RouteContext.auth` remains a 4-arm literal-union object with optional payload fields. The `as const` annotations at `web.ts:155-158` are the entire mechanism — they cost nothing at runtime and exhaustively narrow at compile time. This is the type-level "minimum code that solves the problem" per CLAUDE.md §2.

**Alternative considered and dropped: DU-only `AuthContext` type alias.** A `type AuthContext = { kind: 'token' } | { kind: 'device'; device: string } | ...` would be equivalent to the current `RouteContext.auth` shape with no payload optionality. There is no behavioral or readability gain over the current shape, so it is also dropped.

**Final decision.** The 4-arm ternary at `web.ts:154-159` survives the class refactor. `DashboardServer.getAuthContext()` (the new method per §6.2) extracts the same ternary into a private method — the call site at `web.ts:171` becomes `const routeCtx: RouteContext = { ... auth: this.getAuthContext(req, url, path, method) }`.

---

## §8. Generic opportunities

### §8.1 `DashboardServer<TConfig>` — REJECTED (OE-6 pattern)

A `class DashboardServer<TConfig extends Config>` parameterization has ONE consumer (the boot factory in `index.ts`). Per OE-6, a generic with one consumer is ceremony:

```ts
// Proposed (DO NOT IMPLEMENT)
class DashboardServer<TConfig extends Config = Config> {
  constructor(private readonly deps: { config: TConfig; log: LoggerLike; port?: number })
}

// Consumer
const server = new DashboardServer({ config: defaultConfig, log: logger })
```

The `TConfig` parameter adds:
- A constructor type parameter (covariant: `TConfig` is consumed in readonly field position)
- A type assertion site at every consumer (none currently — only one)
- ZERO compile-time benefit (`defaultConfig: Config` satisfies `TConfig = Config`)

**Verdict.** Drop. `DashboardServer` is non-generic; `Config` is reached via the bundle opts.

### §8.2 `RouteContext<TStore>` — REJECTED (OE-6 pattern)

A `RouteContext<TStore>` that parameterizes over the entity-store type has the same single-consumer problem. Routes that need stores import them directly (`db.js` etc.); they don't read stores through `RouteContext`. Drop.

### §8.3 Reuse `RemoteStatusCache<T>` for poller cache (CE-9) — DEFERRED

`web/federation/poller.ts:59` defines `const statusCache = new Map<string, PeerStatus>()` — a plain Map. `web/remote-status-cache.ts:19` defines `class RemoteStatusCache<T>` with `getOrRefresh(key, nowMs, fetch, fallback)`. CE-9 asks whether `RemoteStatusCache<T>` could subsume the federation poller cache.

**Answer for C:** `statusCache` is NOT a TTL cache — it's a stale-retain cache (a peer's last known manifest is KEPT on transient network failure, per the `state: PeerPollState` enum at `poller.ts:39`). `RemoteStatusCache<T>` is per-call TTL (`getOrRefresh(key, nowMs, ...)`), which is a different semantic. The two are NOT substitutable. Marked DEFERRED — this is a cross-cutting C+E change that belongs in CE-9's resolution, not C-local.

### §8.4 `LoggerLike` (H-tier) — apply line-by-line

H.1 (`docs/refactor-to-classbase/h-cross-cutting/04-generic-interfaces.md` §L) is non-generic and applies to every logger reference. After H.1 lands, C's `logger` import sites become constructor-injected `LoggerLike`. Mapping today:

| Today | After H.1 |
|---|---|
| `import { logger } from '../../logger.js'` (every route file) | constructor parameter `log: LoggerLike` |
| `logger.info(...)` (159 sites in routes + 50 in web.ts) | `this.log.info(...)` |

The conversion is additive (per H.1: `pino.Logger` structurally satisfies `LoggerLike`, so `const l: LoggerLike = logger` compiles). After conversion, `logger` is a singleton reachable from tests via `vi.mock` until all sites adopt the constructor pattern.

---

## §9. Discriminated unions → sealed class candidates (CE-7 lens)

Apply CE-7's criterion: **"sealed classes only for entities that own behavior"**. Audit the 5 DU / string-literal unions in C:

| Type | File | Members | Owns behavior? | Sealing verdict |
|---|---|---|:---:|:---:|
| `AuthResult` | `auth-gate.ts:29` | 5 | NO (pure data) | DROP (OE-4) |
| `BridgeSendResult` | `federation/bridge.ts:43` | 4 | NO | DROP (OE-1-style) |
| `FederationRoutingMode` | `federation/config.ts:55` | 3 (string literal) | NO | DROP — string literal union is the lightest representation |
| `PeerPollState` | `federation/poller.ts:39` | 6 (string literal) | NO | DROP — same |
| `InboxAccept \| { status; error }` | `routes/federation.ts:125` | 2 | NO | DROP — single-narrowing discrimination, currently correct |

**All five unions are pure-data.** Sealing any of them adds 4-6 classes with zero behavioral change. CE-7's lens confirms OE-1/2/3/4: do not seal.

---

## §10. LoggerLike integration — per-file line counts

H.1 conversion scope (per `grep -nE "logger\.(info\|warn\|error\|debug)"`):

| File bucket | `logger.X` calls | Notes |
|---|---:|---|
| `src/web.ts` | 50 | All inside `startWebServer` closure. After class: `this.log.X`. |
| `src/web/routes/*.ts` | 159 | Spread across 44 files; some files have 0 (e.g. `daily-log.ts`), some have 10+ (e.g. `approvals.ts`, `agents.ts`). |
| `src/web/federation/*.ts` | 12 | Concentrated in `config.ts` (8), `poller.ts` (3), `capability-runner.ts` (1). |
| **Total C** | **221** | Every site is the module-level `logger.info/warn/error/debug` call. |

**Conversion mechanism (additive).** Phase 1 (H): add `LoggerLike` to `src/logger.ts`. Phase 7 (C): `DashboardServer` constructor takes `log: LoggerLike`; routes receive `log` either through `RouteContext` (additive field) or via a new `App`-passed injection. The 221 call sites don't change textually — `logger.info(...)` becomes `this.log.info(...)` only inside the class. Module-level callers (route files) keep `logger.info(...)` until each route is class-converted (per CE-3, the 44-file blast radius).

**Test seam.** Today: `vi.mock('../../logger.js')` works for every route file. After H.1 + Phase 7: tests must construct the route handler with `new XxxHandler({ log: mockLogger, ... })` instead of relying on the module mock. Per CE-5 this requires a test-factory (`createTestLogger()`, `createTestAuth()`, etc.).

---

## §11. Unsafe casts audit (full count)

| Bucket | `as any` | `as unknown as` | `as string \| X` (Node headers) | `as const` (literal narrow — SAFE) | Other `as string` |
|---|---:|---:|---:|---:|---:|
| `src/web.ts` | 0 | 0 | 5 (L117, L129, L130, plus duplicates in the same line) | 4 (L155-158) | 0 |
| `src/web/auth-gate.ts` | 0 | 0 | 0 | 0 | 0 |
| `src/web/routes/*.ts` | 0 explicit, 22 sites of `: any` typed locals | 0 | 2 (fleet.ts L12, vault-ssh-keys.ts n/a) | 3 (auth.ts L108, L113; security.ts L23) | 12+ on `Record<string, unknown>` fields |
| `src/web/federation/*.ts` | 0 | 0 | 0 | 0 | 8 (config.ts L125, L136, L145, L153, L176; routes/federation.ts L569, L587, L628) |
| **Total C** | **0** | **0** | **~7** | **7** | **~20** |

**Key observations.**
- ZERO `as any` or `as unknown as` — CLAUDE.md §7 compliance is maintained at the cast level.
- The ~22 `: any` typed locals in routes are the actual compliance gap (CLAUDE.md §7 also bans `any`).
- The Node-headers `as string \| undefined` cast is canonical and unavoidable without a helper.
- The `as const` literals are SAFE — they narrow literal types, not cast away unsafety.
- The `Record<string, unknown>` → typed field casts (8 in `federation/`, 12+ in `routes/`) are the largest removable class. A `validatedField<T>(body, key, guard: (v: unknown) => v is T): T | undefined` helper would eliminate all of them.

---

## §12. CE-7 lens conclusion — what `DashboardServer` should and should not be

Applying CE-7 (sealed only for entities that own behavior):

**Should be a class:**
- `DashboardServer` — owns 22 interval handles, 1 server, 1 listener. Lifecycle = `start()`/`stop()`.
- The 19 background runners — each owns a `setInterval` handle. Lifecycle = `start()`/`stop()`. (CE-7's runner-as-class proposal, scoped per OE-5.)

**Should stay as functions:**
- Route handlers (`tryHandle*`) — 42 of 44 ignore `auth`; their state is just the module-level logger + module-level config. They are flat transformations: `RouteContext → boolean`. Per OE-5 they don't fit `BaseRunner<TF, TD>`. As classes they'd be 42 classes with one `handle()` method each — ceremony.
- Free functions in `auth-gate.ts`, `federation/config.ts`, `federation/bridge.ts`, `federation/poller.ts` — pure functions with module-level cache (the `Map`-shaped caches are inside `poller.ts:59`, `bridge.ts:54`, `config.ts:215-217`). Cache as `class FederationCache`? Per CE-7 only if the cache owns behavior (TTL refresh, invalidation). `RemoteStatusCache<T>` owns `getOrRefresh`; the poller cache owns `set` only — NO behavior.

**Stays a class already (CE-1 inventory):**
- `PeerResponseTooLargeError` — extends Error, no behavior. Keep as-is (the named-class convention from H §X).
- `FederationPollInternalError` — extends Error, no behavior. Keep as-is.

**Verdict for C.** `DashboardServer` + the 19 background runners become classes (Phase 5 + Phase 7). Routes stay as functions (Phase 8+). Federation/poller/config/bridge stay as modules with their existing classes. The total class count delta for C: +1 (`DashboardServer`) + ~19 (runners) = +20 classes. Three classes already exist (`PeerResponseTooLargeError`, `FederationPollInternalError`, `RequestBodyTooLargeError`); total C-class count after refactor: 23.

---

## §13. Open questions for Phase 3 (class-boundaries)

1. **DashboardServer DI shape.** Is the deps-bundle opts pattern (`{ config, log, port?, webDir? }`) the right surface, or do callers want field-by-field constructor args? Per B.Config precedent the bundle wins.
2. **Route registration seam.** Is `registerRoute(path, handler)` worth adding? Today the dispatcher chain is a hand-rolled `if`-cascade at `web.ts:173-215` (44 calls). A registry would be more flexible but adds an indirection that today's tests don't need.
3. **`ctxAuth` ternary extraction.** Should `getAuthContext()` be a public method (testable in isolation) or a private helper (no test surface)? Public wins for the Phase-7 testability goal.
4. **Shutdown hook.** Today `server.close` is overridden to clear intervals, but no `process.on('SIGTERM')` fires it. Should `DashboardServer.stop()` register the SIGTERM handler, or leave that to the caller? Leave to caller — the `index.ts` equivalent owns process lifecycle.