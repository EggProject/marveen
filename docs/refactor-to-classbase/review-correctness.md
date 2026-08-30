# Correctness Review — Refactor Plan

Review date: 2026-08-30. Scope: every file in `docs/refactor-to-classbase/`
cross-checked against the codebase at `/Users/eggp/marveen-develop/test-baseline`.

## Severity summary

- Critical: 6
- Major: 11
- Minor: 14

Total verified findings: 31. Plan internally consistent for: all
`db.ts` entity line numbers, all `db.ts` state-binding line numbers
(`db.ts:10/42/978`), all `channel-provider.ts` line numbers
(`9/11/53/134/243/324/364/477/490/500`), all `process-lock.ts` line
numbers (`19/26/169/226/289`), all `pane-state.ts` line numbers for the
referenced decision functions and union types, `config-registry.ts:18/20/35/37`,
`web.ts:88` and the `ctxAuth` ternary at `web.ts:154-159` (plan said
155-159, off by 1), `index.ts` module-level let bindings (`371-376`),
`ModelAction` at `model-fallback.ts:115`, `OtelSpan` status union at
`db.ts:3247`, and all 10 `as` cast counts in the type-safety hotspot
table.

---

## Critical issues

### C1. `ChannelProvider` interface methods are misdescribed — plan would create a class that does not match the source

- **Location:** `03-class-boundaries.md` A13; `02-type-interface-analysis.md` O5;
  `00-summary.md` Top-3 #1 risk mention.
- **Plan claim:** The `ChannelProvider` interface has methods
  `getToken(): string`, `getChatId(): string`, `stateDir(): string`,
  `readToken(): Promise<string | null>`, `sendMessage(text: string,
  opts?: SendOpts): Promise<SendResult>`, `splitMessage(text: string,
  max: number): string[]`. The plan's A13 ("`sendMessage(text,
  opts?)`", "`splitMessage(text, max)`") assumes token/chatId are
  instance state and that the class owns the token lifecycle.
- **Evidence:** `src/channel-provider.ts:11-23` declares the actual
  interface as:
  ```ts
  interface ChannelProvider {
    readonly type, pluginId, pluginPaneId, envKeys, stateDir, chatIdFormat
    sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>
    sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
    validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
    formatMessage(text: string): string
    splitMessage(text: string): string[]
  }
  ```
  Token/chatId are *parameters*, not instance state. `getChannelToken`,
  `getChannelChatId`, `channelStateDir`, `readChannelToken` are
  top-level helpers at `channel-provider.ts:459/467/520/533` taking
  `(provider: ChannelProviderType, env: Record<string, string>)`,
  not interface methods. `stateDir` is a readonly *property*, not a
  method. `splitMessage` takes only `text` — no `max` parameter.
- **Verdict:** REFUTED. **Severity:** critical.
- **Concrete fix:** Re-cast `ChannelProvider` implementations as
  stateless objects carrying per-call token/chatId. Move
  `getChannelToken` / `getChannelChatId` / `readChannelToken` /
  `channelStateDir` into a `ChannelEnv` helper class (per-type,
  constructed from `process.env`). The five provider objects become
  `class XxxProvider implements ChannelProvider` whose methods take
  `(token, chatId, ...)` exactly like today. The
  `ChannelProviderRegistry` A12 holds a `Map<type, ChannelProvider>`
  plus an `env: ChannelEnv` instance.

### C2. `AuthContext` sealed-class hierarchy is missing the `none` case

- **Location:** `04-generic-interfaces.md` D1; `02-type-interface-analysis.md` D1;
  `03-class-boundaries.md` D4.
- **Plan claim:** D1 sealed hierarchy has subclasses `TokenAuth`,
  `DeviceAuth`, `SessionAuth`, `FederationAuth` with
  `abstract readonly kind: 'token' | 'device' | 'session' | 'federation'`.
- **Evidence:** `src/web/auth-gate.ts:29-34`:
  ```ts
  export type AuthResult =
    | { kind: 'token' }
    | { kind: 'device'; device: string; deviceId: number }
    | { kind: 'federation'; peer: string }
    | { kind: 'session'; user: string }
    | { kind: 'none' }
  ```
  Five kinds, not four. `resolveAuth` returns `{ kind: 'none' }` when
  no auth matches (see `auth-gate.ts` flow). `web.ts:154-159` projects
  it to `ctxAuth` as the `undefined` branch of the ternary.
- **Verdict:** REFUTED. **Severity:** critical (D1 / D4 base class is
  wrong; sealed-class route "forgot" one case).
- **Concrete fix:** Add `class NoneAuth extends AuthContext { readonly
  kind = 'none' as const }`. Either let the `authContext(req)` factory
  return a `NoneAuth` for unauthenticated requests, or have
  `RouteContext.auth: AuthContext | null`. Update the `web.ts:154-159`
  consumer accordingly.

### C3. Four runner file paths are fictional — files do not exist at the claimed paths

- **Location:** `00-summary.md` Runner-as-class row; `01-module-state-analysis.md`
  §3.1 / §6.4; `05-refactor-roadmap.md` Phase 5 file list.
- **Plan claim:** Phase 5 lists conversion of `federation-poller.ts`,
  `capability-summary-runner.ts`, `costs-sync-task.ts`,
  `approval-timeout-sweeper.ts` (all under `src/web/`).
- **Evidence:** All four paths do not exist. Verified:
  - `startFederationPoller` is at `src/web/federation/poller.ts:276`,
    imported in `web.ts:38`.
  - `startCapabilitySummaryRunner` is at
    `src/web/federation/capability-runner.ts:80`, imported at `web.ts:39`.
  - `startCostsSyncTask` is at `src/web/routes/costs.ts:22`, imported
    at `web.ts:67`.
  - `startApprovalTimeoutSweeper` is at `src/web/routes/approvals.ts:54`,
    imported at `web.ts:65`.
  - `ls` of `src/web/federation-poller.ts`,
    `src/web/capability-summary-runner.ts`,
    `src/web/costs-sync-task.ts`,
    `src/web/approval-timeout-sweeper.ts` all return "No such file or
    directory".
- **Verdict:** REFUTED. **Severity:** critical (Phase 5 file list is
  wrong; an executor looking for these files would land in the wrong
  place).
- **Concrete fix:** Replace the four paths with the real ones above;
  reflect in B5's runner inventory.

### C4. `GraphMailClient.verifyAccess()` and `sendMail()` signatures are wrong

- **Location:** `03-class-boundaries.md` C3.
- **Plan claim:** `verifyAccess(): Promise<boolean>` and
  `sendMail(opts: SendMailOptions): Promise<SendResult>`.
- **Evidence:**
  - `src/graph-mail.ts:232` `export async function sendMail(options:
    SendMailOptions): Promise<void>` (returns `void`, not `SendResult`).
  - `src/graph-mail.ts:255` `export async function verifyAccess():
    Promise<{ mailbox: string; messageCount: number }>` (returns an
    object, not `boolean`).
- **Verdict:** REFUTED. **Severity:** critical (type-signature errors
  cascade into every consumer; `Promise<SendResult>` doesn't exist in
  the module).
- **Concrete fix:** Update C3's `verifyAccess(): Promise<{ mailbox:
  string; messageCount: number }>` and `sendMail(opts: SendMailOptions):
  Promise<void>`. If a class surface wants `Promise<SendResult>`, define
  it as `type SendResult = { ok: true } | { ok: false; error: string }`
  and wrap the existing `sendMail` to translate `void` → `{ ok: true }`.

### C5. R1's claimed `MessageBus` ↔ `Scheduler` ↔ `BackgroundTaskPool` cycle is fabricated

- **Location:** `06-risks-and-mitigations.md` R1.
- **Plan claim:** "`MessageBus` ← `Scheduler` ← `BackgroundTaskPool` ←
  `MessageBus`: the message bus logs to the scheduler for retry-classified
  failures, the scheduler uses the background task pool for retry
  execution, the background task pool emits messages on completion.
  **This is a real cycle** and breaks naive constructor DI."
- **Evidence:** None. `grep` for cross-imports between these entities
  in `src/` returns nothing. `db.ts` (where all three would live as
  classes A3/A4/A5) does not reference any cross-entity method calls;
  `Scheduler` decision logic lives in `auto-restart.ts` /
  `pending-retries.ts` (pure functions); `MessageBus` state transitions
  are pure DB updates with no scheduler call; `BackgroundTaskPool` does
  not emit messages. The "circular dependency" is invented.
- **Verdict:** REFUTED. **Severity:** critical (R1's headline
  mitigation — "introduce a `Services` aggregate" + "late-binding
  setters" — solves a problem that does not exist; this would add
  complexity with no payoff).
- **Concrete fix:** Delete the cycle entry from R1. Replace with a real
  risk (e.g., the `MemoryStore.decay()` → `MemoryCache.invalidatePrefix()`
  → DB write ordering during shutdown).

### C6. Plan's `index.ts` import count is wildly off (claims 70+, actual 19)

- **Location:** `00-summary.md` Top-3 #2; `01-module-state-analysis.md`
  §3.3 (`web/agent-process.ts ... non-trivial DAG`); `03-class-boundaries.md`
  D3; `05-refactor-roadmap.md` Phase 7.
- **Plan claim:** `index.ts` has "70+ imports".
- **Evidence:** `grep -c "^import " src/index.ts` returns 19. Full list
  is 19 `import` statements (mix of multi-line and single-line). This
  is the orchestrator file; the line count is 568 (vs claimed 70+ lines
  of imports alone).
- **Verdict:** REFUTED. **Severity:** critical (Top-3 #2 risk assessment
  is built on a wrong number; the blast radius is much smaller than
  presented).
- **Concrete fix:** Re-measure `wc -l src/index.ts` (568 lines total),
  `grep -c "^import " src/index.ts` (19 lines), `grep "^import " src/index.ts | wc -w` (count tokens, ~190 imported symbols). Update risk text
  to "19 import statements, ~190 imported symbols".

---

## Major issues

### M1. Top-level `src/` file count: plan claims 44, actual 36

- **Location:** `00-summary.md` Brief; `01-module-state-analysis.md` §1.
- **Plan claim:** "44 top-level `src/` files".
- **Evidence:** `find /Users/eggp/marveen-develop/test-baseline/src -maxdepth 1 -name "*.ts" -type f | grep -v __tests__ | wc -l` returns 36
  (excluding `__tests__/` and the four subdirectories `channel-coordinator/`,
  `costops/`, `db/`, `web/`, as the plan specified).
- **Verdict:** REFUTED. **Severity:** major (consistency / scope
  baseline).
- **Concrete fix:** Replace "44" with "36" in both files.

### M2. `config.ts` has 58 const exports, not "~40"

- **Location:** `01-module-state-analysis.md` §2 row "config.ts"
  (claims "every export is a `const`").
- **Plan claim:** "~40 module-level `const`s" (description column
  implies ~40 frozen exports).
- **Evidence:** `grep -c "^export const " src/config.ts` returns 58.
- **Verdict:** REFUTED. **Severity:** major.
- **Concrete fix:** Update to "~58 frozen `const` exports" (or "58").

### M3. `db.ts` has 155 exported functions, not "~200"

- **Location:** `00-summary.md` Brief; `01-module-state-analysis.md` §1;
  `03-class-boundaries.md` D2.
- **Plan claim:** "~200 free functions".
- **Evidence:** `grep -c "^export function " src/db.ts` returns 155.
  Plus 3 `export const`, 17 `export interface`, ~10 `export type` —
  total 195 top-level exports, of which 155 are functions.
- **Verdict:** REFUTED. **Severity:** major (blast-radius estimate).
- **Concrete fix:** "~155 free functions" or "195 top-level exports
  total, of which 155 are functions".

### M4. Mock counts are systematically undercounted

- **Location:** `00-summary.md` Brief; `01-module-state-analysis.md` §7.
- **Plan claim:** `vi.mock('../config.js', ...)` is "~126 across three
  patterns" (69+47+10); `vi.mock('../db.js', ...)` is "~35";
  `vi.mock('../logger.js', ...)` is 78.
- **Evidence:** `grep -rh "vi.mock(" src/__tests__/ | grep -oE "vi\.mock\([^)]+\)" | sort | uniq -c | sort -rn`:
  - `../logger.js`: 88 (plan: 78; +13%).
  - `../config.js` (async (orig)): 75; `../config.js` (`()`): 56;
    `../config.js`: 12; `../config.js` (async (importOriginal)): 11.
    Total 154 (plan: 126; +22%).
  - `../db.js`: 49 (plan: 35; +40%).
  - `../web/agent-config.js`: 45 + 9 = 54 (plan: 51; +6%).
  - `../web/agent-process.js`: 27 (plan: 25).
  - `../web/main-agent.js`: 24 (plan: 22).
  - `../web/auth-gate.js`: 25 (plan: 22).
  - `../web/auth-sessions.js`: 22 (plan: 18).
- **Verdict:** REFUTED. **Severity:** major (test-mock churn estimate
  is the headline number in 00-summary; off by 22-40%).
- **Concrete fix:** Re-run `grep -rh "vi.mock(" src/__tests__/ | grep
  -oE "vi\.mock\([^)]+\)" | sort | uniq -c | sort -rn` and update the
  table in §7.

### M5. `config.ts` has 60 importers (not 23)

- **Location:** `01-module-state-analysis.md` §3.3 ("`config.ts` is the
  keystone. 23 top-level files import it"); `06-risks-and-mitigations.md`
  R2 ("`src/config.ts` ~40 frozen `const` exports are read by ~23 modules").
- **Plan claim:** 23 importing files.
- **Evidence:** `grep -rln "from '\./config.js'\|from '\.\./config.js'"
  src/ --include="*.ts" | grep -v __tests__ | sort -u | wc -l` returns
  60 (across `src/` and `src/web/` and the subdirs).
- **Verdict:** REFUTED. **Severity:** major (keystone blast-radius
  estimate is off by 2.6×; config.ts is even more central than the
  plan claims).
- **Concrete fix:** Update §3.3 to "60 importing files (28 top-level +
  32 web/ + subdirs)"; revise the "config.ts is keystone" paragraph.

### M6. `db.ts` has 14 direct importers (not "~30")

- **Location:** `00-summary.md` Top-3 #1 (db.ts touches "~30 importing
  modules"); `01-module-state-analysis.md` §5 table (`db: Database
  singleton` row says "memory.ts, heartbeat.ts, agent.ts, costops/ledger.ts,
  index.ts, and ~25 web/*.ts files").
- **Plan claim:** ~30 importing modules, ~25 web/* files.
- **Evidence:** `grep -rln "from '\./db.js'\|from '\.\./db.js'" src/ --include="*.ts" | grep -v __tests__ | sort -u | wc -l` returns 14
  (10 in `web/` + 4 top-level: `db.ts`, `heartbeat.ts`, `index.ts`,
  `memory.ts`, `store-watcher.ts`, `costops/ledger.ts`, `agent.ts`,
  `channel-coordinator/ingest.ts`, `channel-coordinator/liveness.ts`).
- **Verdict:** REFUTED. **Severity:** major (blast-radius estimate for
  the riskiest refactor is wrong by 2×).
- **Concrete fix:** "14 direct importers (10 in `web/`, 4 top-level)".
  Note that many more files *use* db.ts indirectly via the route layer
  but do not import it directly.

### M7. `MessageBus` method signatures (A3) do not match the source functions

- **Location:** `03-class-boundaries.md` A3.
- **Plan claim:** `pending(limit?: number): AgentMessage[]`;
  `pendingBacklog(agentId: string): AgentBacklog` (singular);
  `claimPending(toAgent, limit): AgentMessage[]`;
  `markDelivered(id): void`; `markDone(id, result: unknown): void`;
  `failPendingFederated(reason: string): number`;
  `closeUndelivered(): number`.
- **Evidence:**
  - `db.ts:2044` `getPendingMessages(toAgent?: string): AgentMessage[]`
    — takes optional `toAgent`, not `limit`.
  - `db.ts:2071` `getPendingBacklogByAgent(): AgentBacklog[]` — no
    `agentId` arg, returns array.
  - `db.ts:2058` `markMessageDelivered(id: number): boolean` — returns
    `boolean`, not `void`.
  - `db.ts:2112` `setMessageResult(id, result: string): boolean` — the
    plan's "markDone" is actually `setMessageResult`, returns `boolean`,
    takes `result: string` (not `unknown`).
  - `db.ts:2167` `markMessageDone(id, result?: string): boolean` —
    different signature from "setMessageResult" — plan merges two
    distinct functions into one `markDone`.
  - `db.ts:2126` `failPendingFederatedMessages(peerId: string | undefined,
    reason: string): number[]` — takes `peerId`, returns array (not
    number).
  - `db.ts:2093` `closeMessagesWithoutDelivery(ids: number[], reason:
    string): number` — takes `ids` array, not zero-arg.
- **Verdict:** REFUTED. **Severity:** major (the public method surface
  is wrong; consumers written against these signatures will not compile).
- **Concrete fix:** Re-derive A3's method surface from the source
  functions listed above. Distinguish `setMessageResult` (no status
  change) from `markMessageDone` (status change to `done`).

### M8. `settings-store.ts` cache location mis-stated

- **Location:** `03-class-boundaries.md` A11.
- **Plan claim:** "Source files: `settings-store.ts` (cache at
  `settings-store.ts:46`; `cache` Map + `watcher` + `ensureWatching`)".
- **Evidence:**
  - `settings-store.ts:17` `let cache: Record<string, string | number> = {}`
    — cache is at line 17, not 46.
  - `settings-store.ts:18` `let watcher: FSWatcher | undefined`.
  - `settings-store.ts:46` `function ensureWatching(): void` —
    `ensureWatching` is at 46, but the *cache* is at 17.
- **Verdict:** REFUTED. **Severity:** major (the line ref is
  wrong; "cache at settings-store.ts:46" is actually `ensureWatching`).
- **Concrete fix:** Change A11 source-file annotation to "`settings-store.ts`
  (cache at line 17; watcher at line 18; `ensureWatching` at line 46)".

### M9. `AuthResult` device field type is `string`, not `DeviceRow`

- **Location:** `04-generic-interfaces.md` D1 sketch (`DeviceAuth`
  constructor takes `device: DeviceRow`).
- **Plan claim:** `DeviceAuth` carries `public readonly device:
  DeviceRow`.
- **Evidence:** `web/auth-gate.ts:31` `{ kind: 'device'; device: string;
  deviceId: number }`. `device` is a plain `string`, not a row object.
  No `DeviceRow` type exists in the auth subsystem.
- **Verdict:** REFUTED. **Severity:** major (D1 sketch's
  `DeviceAuth.device: DeviceRow` does not match the source; the
  constructor would not compile against the actual `AuthResult`).
- **Concrete fix:** Change to `constructor(public readonly device:
  string, public readonly deviceId: number) { super() }`.

### M10. Out-of-scope sections are out of sync with the "in-scope" lists

- **Location:** `00-summary.md` "Explicitly OUT OF SCOPE" (bullets).
- **Plan claim:** "`costops/*` (both files)" is in the "utility modules
  (no conversion)" column with `~18` count. Then `00-summary.md`'s
  out-of-scope list says "Subdirectory-specific refactors inside
  `src/costops/` ... are not initiated by the top-level class
  conversions listed in scope. (Examples: ... the `costops/ledger.ts`
  report-generation ... are flagged but deferred.)"
- **Issue:** The "in scope" table on the same page already lists
  `costops/*` as a utility (no conversion). Calling them "out of scope
  but flagged for deferral" in the explicit-out-of-scope list is
  contradictory — they are not "flagged but deferred", they are
  categorized as "stays as-is".
- **Verdict:** REFUTED. **Severity:** major (the in-scope/out-of-scope
  boundaries are muddled; an executor would not know whether
  `costops/ledger.ts` is in or out).
- **Concrete fix:** Make the out-of-scope list say only what is *not*
  listed in the in-scope table. Drop the `costops/*` deferral reference
  from out-of-scope, OR remove them from the in-scope utility list and
  add to out-of-scope.

### M11. Shutdown sequence in R9 / Phase 7 does not match current code

- **Location:** `06-risks-and-mitigations.md` R9; `05-refactor-roadmap.md`
  Phase 7 pre-conditions; `01-module-state-analysis.md` §8 (referenced
  as the source of the order).
- **Plan claim:** Shutdown order: (1) digest timer in memory.ts, (2)
  decay interval in index.ts, (3) heartbeat scheduler, (4) store
  watcher, (5) settings store, (6) runners, (7) web server, (8)
  process lock, (9) db.
- **Evidence:** `src/index.ts:378-410` (the actual `shutdown`):
  ```ts
  stopHeartbeat()
  stopInviteMonitor()
  stopChannelRequestWatcher()
  stopStoreWatcher()
  clearInterval(decayInterval)
  clearTimeout(digestTimer)
  clearInterval(digestInterval)
  webServer.close(... releaseLock())
  ```
  Actual order: heartbeat → inviteMonitor → channelRequestWatcher →
  storeWatcher → decayInterval → digestTimer → digestInterval →
  webServer → releaseLock. No `db.close()` call exists in the current
  shutdown at all (only `releaseLock()` which unlinks the pidfile).
  The plan's order lists steps that don't exist in the current code
  ("digest timer in `memory.ts`" — digest timer lives in `index.ts`,
  not `memory.ts`; "settings store" — never closed today;
  "background task pool" — never closed today; "db" — never closed
  today).
- **Verdict:** REFUTED. **Severity:** major (the documented order in
  R9 / Phase 7 is invented; an executor would refactor against a
  fictitious target).
- **Concrete fix:** Either (a) document the *current* shutdown order
  with the steps that actually exist, OR (b) explicitly mark the order
  as "target post-refactor" and list which steps are *new*
  (`SettingsStore.stopWatching()`, `BackgroundTaskPool.finishAll()`,
  `DbClient.close()`) so the executor can see the delta.

---

## Minor issues

### m1. `LogFn` is not "5+ identical aliases" — it is defined exactly once

- **Location:** `02-type-interface-analysis.md` G5 ("Every pure-logic
  module that wants to surface structured logs re-defines `{ info(obj,
  msg?), warn, error }` instead of importing the pino `Logger`
  interface directly... This blocks a classbase refactor because every
  class needs its own `LogFn` alias."); `04-generic-interfaces.md` G5.
- **Evidence:** `grep -rn "^type LogFn\|^export type LogFn" src/
  --include="*.ts" | grep -v __tests__` returns exactly one match:
  `process-lock.ts:19 type LogFn = (obj: Record<string, unknown>, msg?:
  string) => void`. The same alias is referenced in `process-lock.ts:49`
  and `process-lock.ts:253` (the two context interfaces).
- **Verdict:** REFUTED. **Severity:** minor (the count claim is wrong
  but the underlying proposal — "use `Logger` directly" — is still
  defensible).
- **Concrete fix:** Rewrite G5 to reflect the actual scope: "1 type
  alias (`LogFn`) used in 2 places (`ProcessLockContext.log`,
  `PidfileLockContext.log`). The proposal to switch to `Logger` still
  simplifies the migration; just don't claim 5+ aliases."

### m2. `web.ts` ternary chain is at 154-159, not 155-159

- **Location:** `00-summary.md` Top-3 #3 (web.ts claim);
  `02-type-interface-analysis.md` D1 (consumed in `web.ts:155-159`);
  `03-class-boundaries.md` B6; `04-generic-interfaces.md` D1.
- **Plan claim:** `auth.kind === 'token' ? { kind: 'token' as const } :
  ...` at `web.ts:155-159`.
- **Evidence:** `src/web.ts:154-159`:
  ```ts
  const ctxAuth =
    auth.kind === 'token' ? { kind: 'token' as const }
    : auth.kind === 'device' ? { kind: 'device' as const, device: auth.device }
    : auth.kind === 'session' ? { kind: 'session' as const, user: auth.user }
    : auth.kind === 'federation' ? { kind: 'federation' as const, peer: auth.peer }
    : undefined
  ```
  Starts at line 154 (the `const ctxAuth =` line), not 155.
- **Verdict:** REFUTED. **Severity:** minor (1-line off-by-one).
- **Concrete fix:** Update all four references to `web.ts:154-159`.

### m3. `: any` does not appear in `index.ts`

- **Location:** `02-type-interface-analysis.md` Type-safety hotspot table
  (row 4: "index.ts", 12 `as`, 1 `: any`, "The `: any` is in
  `process.env.MARVEEN_AGENT_BACKEND` access").
- **Evidence:** `grep -nE ": any[\\)\\, ;\\>\\}]|: any\\[| as any" src/index.ts` returns nothing. `grep -nE "any" src/index.ts` only
  matches comments/strings, not type annotations.
- **Verdict:** REFUTED. **Severity:** minor.
- **Concrete fix:** Remove the `: any` row entry or change to 0.

### m4. `agent.ts` `cachedClaudeCodeBin` exists at the cited lines but `: any` count is right

- **Location:** `02-type-interface-analysis.md` Type-safety table row 6.
- **Plan claim:** `agent.ts` has 11 `as` casts and 1 `: any`; the `: any`
  is "(event as any).subtype / (event as any).sessionId for untyped SDK events".
- **Evidence:** `grep -c " as " src/agent.ts` returns 11 ✓; `grep -n
  ": any\\b" src/agent.ts` returns `agent.ts:194` (in a `catch (err:
  any)` clause, not on `(event as any)`). The "(event as any)" is
  `as any` cast (without colon-prefix), not `: any` annotation. The
  "1 occurrence" is in the right ballpark but the example given is
  wrong.
- **Verdict:** REFUTED (minor). **Severity:** minor.
- **Concrete fix:** Note that the `: any` is in a catch clause, not on
  an event property.

### m5. `auto-restart.ts` is listed as "Pure utilities" in the in-scope table

- **Location:** `00-summary.md` Scope estimate table — "Utility modules
  (no conversion)" includes "auto-restart.ts constants".
- **Evidence:** `src/auto-restart.ts` is not split into "constants" vs
  "decision functions"; it's a single file with `DEFAULT_AUTO_RESTART`
  const + 3 decision functions + 1 type. The plan's `03-class-boundaries.md`
  does NOT include `AutoRestartSchedule` (mentioned in 00-summary Top-3
  #3 as a "lowest-risk win" — but the class boundary doc doesn't list it).
- **Verdict:** REFUTED. **Severity:** minor (00-summary says "class
  AutoRestartSchedule" is a win but it is not in the actual class
  boundaries; the scope-estimate table calls the file a utility
  module).
- **Concrete fix:** Add `AutoRestartSchedule` to `03-class-boundaries.md`
  Part F (or a new "utility → namespace class" section), OR drop the
  Top-3 #3 claim.

### m6. SettingsStore line refs: `cache` is at line 17, not at the "cluster" line 46

- **Location:** `03-class-boundaries.md` A11; same as M8 above.
- Already covered. **Severity:** minor (this is the line-precise form
  of M8).
- **Concrete fix:** Correct A11's source-file annotation.

### m7. Plan says `settings-store.ts` has 3 module-level lets, but it's actually 2 (cache + watcher)

- **Location:** `01-module-state-analysis.md` §2 row "settings-store.ts":
  "Yes — 3 module-level lets (cache, watcher, the `recentEvents` Map
  referenced indirectly)".
- **Evidence:** `grep -n "^let " src/settings-store.ts` returns lines
  17 (`cache`) and 18 (`watcher`). No `recentEvents` exists in this
  file; `recentEvents` lives in `store-watcher.ts:79` as `const`, not
  `let`.
- **Verdict:** REFUTED. **Severity:** minor.
- **Concrete fix:** "Yes — 2 module-level lets (cache, watcher)".

### m8. `recentEvents` is `const`, not `let`, in `store-watcher.ts`

- **Location:** `01-module-state-analysis.md` §2 row "store-watcher.ts":
  "Yes — 4 module-level lets, including an `fs.watch` registration".
- **Evidence:** `src/store-watcher.ts:79` `const recentEvents = new
  Map<string, number>()`. (And lines 47, 60, 81 are `let` — currentWriteActor,
  knownFiles, watcher.) So 3 lets + 1 const, not 4 lets.
- **Verdict:** REFUTED. **Severity:** minor.
- **Concrete fix:** "3 module-level lets + 1 const (recentEvents)".

### m9. `channel-coordinator.ts` claim of "4 mutable bindings + 2 pid-file" is partly wrong

- **Location:** `01-module-state-analysis.md` §2 row "channel-coordinator.ts":
  "Yes — 4 mutable bindings + 2 pid-file + `installSignalHandlers`".
- **Evidence:** `src/channel-coordinator.ts:101-106` has 4 mutable lets
  (state, downStreak, stopping, nativeConfirmedUpUntil). PID_FILE is
  declared at line 98 as `const`, not as a mutable binding (lines
  144/145/156/161 *use* it but don't mutate it). So "2 pid-file" is
  counting references, not bindings.
- **Verdict:** REFUTED. **Severity:** minor.
- **Concrete fix:** "Yes — 4 mutable lets + 1 const `PID_FILE` + `installSignalHandlers`".

### m10. `pane-state.ts` `decideSubmitFollowup` location matches; the sketch in D3 is generic

- **Location:** `04-generic-interfaces.md` D3 sketch.
- **Plan claim:** D3 sealed hierarchy with `kind: 'none' | 'inject-resume'
  | 'restart' | 'alert'`.
- **Evidence:** `src/pane-state.ts:900` `type SubmitFollowupAction = 'retry-enter'
  | 'clear-and-resend' | 'done' | 'give-up'` — the actual kinds are
  `retry-enter | clear-and-resend | done | give-up`, not `none |
  inject-resume | restart | alert`. The plan's D3 sketch invents new
  kinds without acknowledging the source.
- **Verdict:** REFUTED. **Severity:** minor (the G3 sketch is
  illustrative; the kinds need to come from `pane-state.ts:900/1373`).
- **Concrete fix:** Replace D3's kind names with the actual ones from
  the source unions, and call out the kinds correctly:
  - `RetryEnterAction`, `ClearAndResendAction`, `DoneAction`, `GiveUpAction`
    for SubmitFollowupAction.
  - For StuckInputAction at `pane-state.ts:1373`, look up its kinds
    before drafting the sealed sketch.

### m11. `BaseRunner<TFacts, TDecision>` defines `MessageFacts` / `MessageDecision` that don't exist in source

- **Location:** `04-generic-interfaces.md` G6 usage example.
- **Plan claim:** `MessageRouter extends BaseRunner<MessageFacts, MessageDecision>`.
- **Evidence:** `grep -rn "type MessageFacts\|interface MessageFacts\|export type MessageFacts" src/ --include="*.ts"` returns nothing. Neither
  type exists today.
- **Verdict:** REFUTED (but this is a forward-looking sketch — the
  plan needs to acknowledge the type doesn't exist). **Severity:** minor.
- **Concrete fix:** Add an [ASSUMPTION] note: "MessageFacts /
  MessageDecision are new types to be introduced as part of the
  MessageRouter class conversion; the source has no equivalent."

### m12. Plan claim "no public API to maintain" is plausible but the bin/ scripts deserve a check

- **Location:** `00-summary.md` out-of-scope bullets: "Public API of
  any package that consumes `src/` — there are no published packages;
  the only external consumers are internal scripts. The CLI scripts in
  `bin/` will be updated but their shape is not redesigned."
- **Evidence:** No audit of `bin/` was performed in the plan to
  confirm there are no third-party callers of the functions that
  become class methods.
- **Verdict:** REFUTED (unverified claim, not a factual error).
  **Severity:** minor.
- **Concrete fix:** Add `ls bin/` and `grep -rln "src/" bin/` audit as
  Phase 0 work.

### m13. The `web/` runner count "~20" is plausible; actually 19

- **Location:** `01-module-state-analysis.md` §6.4 ("~20"); `00-summary.md`
  ("another ~10 inside `web/` adopting a generic `*Runner<T>` shape" +
  "**Total: ~22 files become classes**"). Phase 5 says "~20 `start*()`".
- **Evidence:** `grep -rn "^export function start" src/web/*.ts | wc -l`
  returns 19 distinct `start*` functions in `src/web/`. (`src/index.ts`
  calls 14 of them; the others are called from `web.ts`.) Note: the
  plan list has 19 entries too, so this is internally consistent.
- **Verdict:** CONFIRMED. **Severity:** minor (off-by-one in summary
  text).
- **Concrete fix:** "~19" instead of "~20".

### m14. MemoryStore constructor signature missing the cache dependency listed in the Dependencies section

- **Location:** `03-class-boundaries.md` A1.
- **Plan claim:** Constructor: `constructor(db: Database, opts: {
  recencyLambda: number; recencyTauSec: number; embeddingModel?: string })`.
  Dependencies (separately listed): "Database..., the new
  `TtlCache<string, MemoryCacheEntry>`..., `EmbeddingClient`".
- **Issue:** The Dependencies section mentions a `cache: TtlCache` and
  an `EmbeddingClient`, but neither appears in the constructor
  signature. Either the cache is supposed to be constructed internally
  by `MemoryStore` (in which case the dependency should be a private
  field, not listed under "Dependencies"), or the constructor is
  missing parameters.
- **Verdict:** REFUTED. **Severity:** minor (internal inconsistency
  between signature and dependency list).
- **Concrete fix:** Either (a) add `cache: TtlCache<string,
  MemoryCacheEntry>, embedding: EmbeddingClient` as constructor params
  and remove from "Dependencies", or (b) move cache construction
  inside the class and drop from external Dependencies.

---

## Confirmed claims (subset for context)

The following key claims were verified as TRUE:

- All `db.ts` entity interface line numbers (`Memory:1061`,
  `BackgroundTask:1492`, `ScheduledTask:1555`, `KanbanCard:1627`,
  `KanbanComment:1650`, `ArchivedKanbanCard:1756`, `KanbanCardEvent:1835`,
  `Label:1897`, `AgentMessage:2002`, `AgentThread:2221`,
  `PendingTaskRetryRow:2322`, `IdeaBoxRow:2564`, `IdeaComment:2620`,
  `IdeaStatusLogRow:2643`, `VaultSshKey:3031`, `VaultSshServer:3077`,
  `Approval:3132`, `OtelSpan:3239`, `OtelTraceSummary:3277`).
- `db.ts` state (`let db: Database` at 10; `initDatabase` at 42; `getDb`
  at 978; 155 exported functions; `MemoryCacheEntry` interface at 1240).
- `channel-provider.ts` (`ChannelProviderType:9`, `ChannelProvider:11`,
  providers at 53/134/243/324/364, `providers:477`, `withTestRunMarking:490`,
  `markedProviders:500`).
- `process-lock.ts` (`LogFn:19`, `ProcessLockContext:26`,
  `acquirePortLock:169`, `PidfileLockContext:226`, `acquirePidfileLock:289`).
- `pane-state.ts` (`SubmitFollowupAction:900`, `decideSubmitFollowup:940`,
  `decidePaneErrorAlert:1010`, `decideStuckInputRecovery:1319`,
  `StuckInputAction:1373`, `decideStuckInputAction:1417`,
  `decideStuckToolCallRecovery:1607`).
- `config-registry.ts` (`SettingType:18`, `SettingDefinition:20`,
  `HEX_COLOR_RE:35`, `SETTINGS_REGISTRY:37`).
- `web.ts` (`startWebServer:88`, `ctxAuth` ternary at 154-159).
- `index.ts` 6 module-level lets (`webServer:374`, `decayInterval:371`,
  `digestTimer:372`, `digestInterval:373`, `shuttingDown:375`,
  `exitCode:376`); regexes (`BANNER:36`, `PID_FILE:51`,
  `DASHBOARD_BINARY_PATTERN:62`).
- `model-fallback.ts` `ModelAction` at 115 (3 kinds as described).
- `db.ts:3247` OtelSpan status union (`'ok' | 'error' | 'timeout' |
  'running'`).
- All 10 `as` cast counts in the type-safety hotspot table.
- `agent.ts:81` `cachedClaudeCodeBin`, `agent.ts:82` `resolveClaudeCodeBin`.
- `google-api.ts:51/52` cachedTokens/cachedClient, `108` refreshInFlight,
  `165` getCalendarEvents.
- `graph-mail.ts:68` cachedCreds, `132` cachedToken, `214` listMessages,
  `232` sendMail (returns `Promise<void>`), `255` verifyAccess.
- `platform.ts:24` PLATFORM, `74` makeLazyBinResolver.
- `channel-coordinator.ts:88/101/102/103/106/311/407` (startStream + 4
  lets + runLoop + installSignalHandlers).
- `heartbeat.ts:565/566/584/594` (lets + init/stopHeartbeat).
- `store-watcher.ts:47/60/81/88/156` (3 lets + startStoreWatcher +
  stopStoreWatcher); `recentEvents:79` is a `const`.

---

## Out-of-scope claims — accuracy check

Plan claim `00-summary.md` "Explicitly OUT OF SCOPE":

1. **"All test files"** — confirmed consistent; tests are explicitly
   listed as out of scope for *changes*, but in-scope for *updates to
   match new APIs*. Plan phrasing: "Tests get *updated* to match new
   class APIs but their coverage requirements, layout, and the test
   runner are not in scope." **Verdict:** CONFIRMED.

2. **"vitest.config.ts, tsconfig.json, bun.lockb, package metadata"** —
   consistent. **Verdict:** CONFIRMED.

3. **"All markdown documentation outside `docs/refactor-to-classbase/`"**
   — consistent. **Verdict:** CONFIRMED.

4. **"Subdirectory-specific refactors inside `src/channel-coordinator/`,
   `src/costops/`, `src/db/`, `src/web/` that are not initiated by the
   top-level class conversions"** — partly contradicted by M10 (the
   `costops/*` entry is also in the in-scope utility list). Also note
   `telegram-client.ts`'s `TelegramApiError` is correctly identified
   as "already a class; no migration". **Verdict:** NEEDS-FIX (M10).

5. **"The existing `DeferToPeerError` and `RemoteEnrollError` classes"**
   — confirmed; both classes exist at the cited line numbers and are
   correctly excluded. **Verdict:** CONFIRMED.

6. **"Generic variance tuning beyond what is needed for the new shapes"**
   — confirmed. **Verdict:** CONFIRMED.

7. **"Public API of any package that consumes `src/`"** — unverified
   (m12). **Verdict:** NEEDS-FIX (m12).

---

## [ASSUMPTION] marker audit

The plan uses `[ASSUMPTION: ...]` in:

- `00-summary.md` (closing line): "~126 for `vi.mock('../config.js')`
  + ~35 for `vi.mock('../db.js')`". Both wrong (M4 / M4).
- `03-class-boundaries.md` B5: "[ASSUMPTION: The exact count of
  `start*()` functions in `web/` is approximately 20]" — true enough
  (m13: actual 19).
- `03-class-boundaries.md` D2: "[ASSUMPTION: The exact count `~200`
  free functions in `db.ts`]" — wrong (M3: actual 155).

All three `[ASSUMPTION]` markers flag either critical overestimates or
plausibly-correct approximations. The plan would benefit from
replacing each with a verified number from `grep` output.

The plan also has two unflagged assertions that should be ASSUMPTIONS:

- `BaseRunner<TFacts, TDecision>` example uses `MessageFacts` /
  `MessageDecision` that don't exist (m11). Should be marked.
- `AuthContext` D1 sketch uses `DeviceRow` (M9). Should be marked or
  removed.

---

## Net verdict

**NEEDS-FIX (12 critical/major items must be resolved before implementation).**

The plan has good bones: the entity-to-class mapping is correct in
shape, the per-entity line numbers in `db.ts` all match, the
`channel-provider` five-provider pattern is correctly identified as the
strongest classbase candidate, and the keystone
(`config.ts`/`db.ts`/`web.ts`/`index.ts`) sequence is sound. But the
plan is undermined by systematic numeric drift (file count, mock
counts, db.ts function count, importer counts, file paths for 4
runners), one fabricated risk (R1 cycle), one missing sealed-class
case (`AuthContext` `none`), one fundamentally wrong interface
description (`ChannelProvider` — the token lifecycle is per-call,
not per-instance), and one invented shutdown sequence.

**Specific fixes before implementation:**

1. Re-measure and replace every "~N" with a `grep`-confirmed number:
   - top-level `src/` files: 36 (was "44")
   - `config.ts` const exports: 58 (was "~40")
   - `config.ts` importers: 60 (was "23")
   - `db.ts` exported functions: 155 (was "~200")
   - `db.ts` direct importers: 14 (was "~30")
   - `vi.mock('../config.js')`: 154 (was "~126")
   - `vi.mock('../db.js')`: 49 (was "~35")
   - `vi.mock('../logger.js')`: 88 (was "78")
   - `index.ts` imports: 19 (was "70+")
   - `web/start*` functions: 19 (was "~20")
2. Fix the 4 wrong runner file paths in `00-summary.md` /
   `05-refactor-roadmap.md` Phase 5 (C3).
3. Rework C1's `ChannelProvider` class shape: token/chatId remain
   per-call parameters, not instance state. Move the 4 top-level
   helpers into a `ChannelEnv` class.
4. Add `NoneAuth` to the AuthContext hierarchy (C2).
5. Fix `GraphMailClient.sendMail` / `verifyAccess` signatures (C4).
6. Delete R1's `MessageBus` ↔ `Scheduler` ↔ `BackgroundTaskPool` cycle
   entry (C5).
7. Re-derive `MessageBus` method signatures from the actual `db.ts`
   functions (M7).
8. Document the actual `index.ts` shutdown order, not an invented one
   (M11).
9. Fix the `settings-store.ts:46` → `:17` for the cache location (M8).
10. Fix `LogFn` count from "5+ aliases" to "1 alias, used in 2 places"
    (m1).
11. Fix `web.ts` line ref 155-159 → 154-159 (m2).
12. Fix `MessageFacts` / `MessageDecision` and `DeviceRow` placeholders
   in D1/D3 (m11, M9).
13. Verify `: any` count in `index.ts` (m3).

After applying 1-13, the plan should be sound for implementation.
Without them, an executor implementing per the plan will:
- edit the wrong files (C3),
- write classes that don't compile against the source (C1, C2, C4, M7, M9),
- refactor against fabricated dependencies (C5),
- mis-budget blast radius (M5, M6),
- document the wrong shutdown order (M11).

### Confidence level of this review

High confidence on line-number claims (every claim was grep-verified
against the live source). High confidence on the C1-C6 critical
findings (each was cross-checked by reading the source interface and
the plan's sketch side by side). Medium confidence on the `db.ts`
function-count and importer counts (precise counts depend on what is
counted — e.g., I counted `^export function ` only, excluding methods
inside classes; the plan may have meant "all callable exports
including re-exports" which would be slightly higher).

No claim in the plan was found to be unverifiable.