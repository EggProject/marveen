# Correctness Review — C (web) Subsystem Refactor Plan

Review date: 2026-08-30. Scope: every file in
`/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/c-web/`
cross-checked against the live source at
`/Users/eggp/marveen-develop/test-baseline/src/`.

Cross-references applied:
- `review-correctness.md` (C2 AuthContext 'none' case; C3 4 fictional
  runner paths CORRECTED; C6 index.ts 19 imports; CE-2 web/federation/
  missed; CE-3 44 route blast radius; M11 shutdown sequence)
- `review-completeness.md` (OE-4 AuthContext DROPPED; CE-9
  RemoteStatusCache<T> reuse; CE-7 sealed-class lens)
- `h-cross-cutting/review-correctness.md` (HR1 pino child() rebinding;
  HR4 LoggerLike vs pino.Logger)
- Precedent reviews for `a-db`, `g-channel-coordinator`, `b-config`,
  `d-channel-provider`, `f-agent-subsystem`.

---

## Severity summary at top

| Severity | Count |
|---|---:|
| Critical | 1 |
| Major | 4 |
| Minor | 6 |

Total verified findings: 11. Plan is internally consistent on the
majority of file/line references (44 route files, 9 federation files,
web.ts:154-159 ternary, AuthResult 5 kinds, error class line refs,
logger call counts, RouteContext shape, AuthGate shape). The Critical
finding is a **scope misclassification**: `startInviteMonitor` is
listed as one of the 19 "web runners" but it is called from
`src/index.ts:539`, not `src/web.ts` — meaning the plan's C/F/G
boundary is mis-stated, and either C.3 or F (or G) needs to own the
InviteMonitorRunner conversion.

---

## Critical issues

### C-CR1. `startInviteMonitor` is an index.ts runner, not a web runner — the 19-runner list has a scope error

- **Location:** `c-web/00-summary.md` L24 (10 in `src/web/*.ts`),
  L298-302 ([ASSUMPTION] marker); `c-web/02-type-interface-analysis.md`
  §1.5 table (NOT listed; only 18 `start*` functions + 1 inline
  `setInterval`); `c-web/03-class-boundaries.md` §C3 row #19
  (`startInviteMonitor` → `src/web/channel-invites.ts:271`); cross-ref
  `c-web/06-risks-and-mitigations.md` CR5, CR2.
- **Claim:** The plan claims "19 web runners" including
  `startInviteMonitor` at `src/web/channel-invites.ts:271` as #19.
- **Evidence:**
  - `src/index.ts:22` imports `startInviteMonitor` from
    `./web/channel-invites.js`.
  - `src/index.ts:539` calls `startInviteMonitor(MAIN_AGENT_ID,
    AGENTS_BASE_DIR)` (the only production call site).
  - `src/web.ts:455` says *"NOTE: startMcpListChecker() is
    intentionally NOT called here."* — web.ts only documents what's
    NOT called; it never references `startInviteMonitor`.
  - The plan's own `02-type-interface-analysis.md §1.5` table lists 19
    intervals: 18 distinct `start*` calls + 1 inline
    `authSessionSweepInterval` setInterval at `web.ts:436`. The 19th
    in that table is **NOT** `startInviteMonitor` — it's the inline
    `setInterval(() => { sweepExpiredSessions();
    sweepExpiredDeviceKeys() }, 60*60*1000)`.
  - The `c-web/03-class-boundaries.md §C3` table contradicts §1.5: it
    substitutes `startInviteMonitor` for the inline authSessionSweep.
- **Verdict:** REFUTED. **Severity:** critical.
- **Impact:**
  - C.3's runner inventory claims ownership of the conversion of
    `channel-invites.ts` to `InviteMonitorRunner` class. But the
    InviteMonitor is invoked from `index.ts`, not from
    `DashboardServer.start()`.
  - The plan's `c-web/00-summary.md L98` correctly notes that the
    dependency table has "**C → F** HeartbeatScheduler.execute()
    returns no result consumed by C today" — but the plan places
    InviteMonitorRunner inside C.3 anyway.
  - The InviteMonitor's lifecycle is owned by `index.ts`'s
    `shutdown()` at `src/index.ts:378-410`, which already calls
    `stopInviteMonitor()` at L384. Refactoring it as a C class
    without involving `index.ts` would leave the shutdown hook
    calling a free function while the class instance lives
    elsewhere.
- **Concrete fix:**
  1. **Resolve the scope ambiguity.** Decide which subsystem owns
     the conversion: C (dashboard server) or F (process-wide
     orchestration in `index.ts`). Given that `startInviteMonitor` is
     called from `index.ts` and stopped from `index.ts`'s shutdown
     sequence, the natural owner is **F (agent subsystem)** — it
     matches the `HeartbeatScheduler` / `StoreWatcher` precedent.
  2. **Replace `startInviteMonitor` in C.3 with the correct 19th
     web runner.** Per `02 §1.5`, the 19th is the inline
     `authSessionSweepInterval` (`web.ts:436`). Either add a
     `SweepExpiredSessionsRunner` class to C.3 (with no `start*`
     function — it wraps the inline `setInterval`), or
     explicitly drop the 19th and call the count "18 distinct
     `start*` + 2 inline intervals" — the count itself is a
     naming question, the substance is "what C.3 owns".
  3. **Update `c-web/06-risks-and-mitigations.md CR5**. The risk
     "executor looking for `src/web/costs-sync-task.ts`" should
     add: "or `src/web/invite-monitor.ts` (the correct file is
     `src/web/channel-invites.ts`, called from `index.ts`, NOT a
     web runner)."
  4. **Update the [ASSUMPTION] marker** in `c-web/00-summary.md
     L298-302` so it doesn't assert the 19-runner count as
     verified.

---

## Major issues

### C-MR1. The "22 `clearInterval` calls" claim is off by one — there are 20 `clearInterval` + 1 `clearTimeout`

- **Location:** `c-web/02-type-interface-analysis.md §1.6` line 116:
  *"22 `clearInterval` calls in the close handler"*; `c-web/03-class-boundaries.md
  §C2` L230: *"22 intervals cleared in REVERSE order"*; `c-web/05-refactor-roadmap.md
  C.2` L78: *"22 + 1 + 1 = 24 references (push, iterate, clear)"*.
- **Claim:** The hand-rolled `server.close` override at `web.ts:548-573`
  contains 22 `clearInterval` calls.
- **Evidence:** Reading `src/web.ts:548-573` line-by-line:
  - L550: `clearInterval(routerInterval)`
  - L551: `clearInterval(scheduleInterval)`
  - L552: `clearInterval(pluginMonitorInterval)` (guarded by `if`)
  - L554: `clearInterval(workerLivenessInterval)` (guarded by `if`)
  - L555: **`clearTimeout(startupWatchdogGrace)`** (NOT clearInterval)
  - L556: `clearInterval(startupWatchdogPoll)`
  - L557-571: 15 more `clearInterval` calls

  Total: **20 `clearInterval`** + 1 `clearTimeout` = **21 cleanup calls**.
- **Verdict:** REFUTED. **Severity:** major.
- **Impact:** Off-by-one in three places (`02 §1.6`, `03 §C2`,
  `05 §C.2`). The plan's `DashboardServer.intervals[]` field would
  need to hold 20 interval handles, not 22. The startup watchdogs
  (`startupWatchdogGrace` and `startupWatchdogPoll`) are
  Timer-as-Timeout / Timer-as-Interval but both go through
  `clearTimeout`/`clearInterval` — they are NOT the same type as
  `NodeJS.Timeout` from `setInterval`. The plan's `intervals: NodeJS.Timeout[]`
  field cannot hold the timeout handle without a separate
  `private timeouts: NodeJS.Timeout[]` field, OR using a union
  type `Array<NodeJS.Timeout | NodeJS.Timeout>` — but `Timeout`
  and `Timeout` are the same TypeScript type (the `Timeout` class
  represents both). So the plan's `intervals[]` field works as-is
  BUT the consolidation needs to account for 21, not 22, cleanup
  calls.
- **Concrete fix:**
  1. Replace "22 `clearInterval` calls" with "20 `clearInterval` +
     1 `clearTimeout(startupWatchdogGrace)` = 21 cleanup calls" in
     all three places.
  2. Note in `03-class-boundaries.md §C2` that the
     `private intervals: NodeJS.Timeout[]` field holds **20 entries**
     (the `setInterval` returns) and the `startupWatchdogGrace`
     timeout handle lives in a separate `private graceTimeout:
     NodeJS.Timeout | undefined` field — or that the array holds all
     21 (Timeout class can hold both, but the field name is
     misleading).

### C-MR2. The "44 tryHandle* calls" / "44 route handlers" claim is off by one — 44 files but 43 tryHandle exports

- **Location:** `c-web/00-summary.md` L49 ("44 routes" in
  scope table); `c-web/03-class-boundaries.md §C3 §3.1`
  ("Three additional runners live in route files" — implies a 44-route
  body but doesn't restate the 44 count); `c-web/05-refactor-roadmap.md
  C.4-C.6` (12 + 21 + 11 = 44 phase tables); cross-ref to
  `web.ts:173-215` dispatch chain.
- **Claim:** "44 route handlers" in `src/web/routes/`, with the
  dispatch chain at `web.ts:173-215` containing "44 calls".
- **Evidence:**
  - `ls src/web/routes/ | wc -l` returns 44 files. ✓
  - `grep -l "^export.*function tryHandle" src/web/routes/*.ts | wc
    -l` returns **43** — `types.ts` does NOT have a tryHandle
    export (it exports only `RouteContext` and `RouteHandler`).
  - `grep -c "if (await tryHandle" src/web.ts` returns **43** —
    the dispatch chain calls 43 tryHandle* functions
    (`web.ts:173-215`, one call per line).
  - The plan's C.4+C.5+C.6 phase file enumeration sums to **44**
    (12 + 21 + 11) but `kanban.ts` is listed in BOTH Phase 2
    (`routes/kanban.ts: GET /api/kanban`) and Phase 3 (`routes/kanban.ts:
    POST/PUT/DELETE /api/kanban/... (write paths only)`) — the
    unique route count is **43**.
- **Verdict:** REFUTED. **Severity:** major.
- **Impact:**
  - The "44 route handler blast radius" (per CE-3 / CR1) is
    actually **43**. The off-by-one doesn't change the
    qualitative risk ("every route file's migration is its own
    PR"), but the count matters for budget planning and progress
    tracking.
  - The CR1 mitigation in `06-risks-and-mitigations.md` says
    *"12 C.4 commits in parallel without merge conflicts"* — that
    holds because the routes are independent files. But the plan's
    table treats `kanban.ts` as two separate route phases; the
    C.5+C.6 ordering needs to clarify that `kanban.ts` migrates
    ONCE (after A.5 lands), with the read path first then the
    write path.
- **Concrete fix:**
  1. Replace "44 route handlers" with "43 tryHandle* exports + 1
     types.ts (44 total files in `src/web/routes/`)" in
     `00-summary.md`, `03-class-boundaries.md`, and
     `05-refactor-roadmap.md`.
  2. Update the dispatch chain claim from "44 calls at `web.ts:173-215`"
     to "43 calls at `web.ts:173-215`".
  3. Re-tabulate C.4+C.5+C.6 as "11 + 21 + 11 = 43" (move
     `kanban.ts` from Phase 2 to Phase 3 entirely, since the
     per-store blast-radius table in `03 §C4` already shows
     `kanban.ts: kanban` is a Phase-3 migration gated on A.3).
  4. CR1's "44 files in a single commit" worst case becomes "43
     files in a single commit" — a quantitative nit, but a real
     one for budget claims.

### C-MR3. `c-web/03-class-boundaries.md` reads `startInviteMonitor` as the 19th runner while `02-type-interface-analysis.md §1.5` lists the inline `authSessionSweepInterval` — internal inconsistency

- **Location:** `c-web/02-type-interface-analysis.md §1.5` table row
  19; `c-web/03-class-boundaries.md §C3` table row 19.
- **Claim:** Both documents list 19 web runners, but they list
  DIFFERENT 19th runners.
  - `02 §1.5` row 19: `authSessionSweepInterval` —
    `setInterval(() => { sweepExpiredSessions(); sweepExpiredDeviceKeys() }, 60*60*1000)`,
    `web.ts:436`.
  - `03 §C3` row 19: `startInviteMonitor` —
    `src/web/channel-invites.ts:271`.
- **Evidence:** See C-CR1 above — `startInviteMonitor` is called
  from `index.ts:539`, NOT from `web.ts`. The `02 §1.5` table is
  accurate; the `03 §C3` table is wrong.
- **Verdict:** REFUTED. **Severity:** major (duplicate of C-CR1
  but the internal-inconsistency angle is a separate finding —
  this would cause confusion even if C-CR1's scope question is
  resolved).
- **Concrete fix:** Same as C-CR1. Additionally, ensure
  `02 §1.5` and `03 §C3` agree on what the 19th web runner is.
  If the 19th is the inline `authSessionSweepInterval` (no
  `start*()` source function), the C.3 row should describe a
  class that wraps the inline interval (e.g.
  `AuthSessionSweeperRunner` with `start()` calling
  `setInterval(...)` and `stop()` clearing the handle).

### C-MR4. `web/atomic-write.ts` vi.mock count is 17, not 14 — plan undercounts

- **Location:** `c-web/00-summary.md` L82: *"the heaviest-mocked web
  helper (14 `vi.mock` sites)"*; cross-ref to
  `review-correctness.md M4` and `review-completeness.md CE-6`.
- **Claim:** `web/atomic-write.ts` has 14 `vi.mock` sites.
- **Evidence:**
  - `grep -rn "vi\.mock.*web/atomic-write" src/__tests__/ | wc -l`
    returns 17.
  - `grep -rn "vi\.mock.*'\.\./web/atomic-write\.js" src/__tests__/
    | wc -l` — same 17 hits.
- **Verdict:** REFUTED. **Severity:** major.
- **Impact:** The CE-6 exemption ("heaviest-mocked web helper, stays
  a free-function module") is still defensible, but the count
  matters for budget. The exemption should be revisited given the
  count is HIGHER than the plan claimed.
- **Concrete fix:** Update the 14 → 17 in `c-web/00-summary.md`. Add
  a note that the count grew from 14 → 17 (the plan's snapshot
  may pre-date some recent test additions).

---

## Minor issues

### C-mr1. `sweepOrphanedBackgroundTasks` line ref is wrong: plan says 146, actual is 126

- **Location:** `c-web/02-type-interface-analysis.md §3.1`:
  "*`sweepOrphanedBackgroundTasks(): void` — `routes/background-tasks.ts:146`*".
- **Claim:** `sweepOrphanedBackgroundTasks` is at
  `routes/background-tasks.ts:146`.
- **Evidence:** `src/web/routes/background-tasks.ts:126` —
  `export function sweepOrphanedBackgroundTasks(): void {`. Line 146
  is `export async function tryHandleBackgroundTasks` (the tryHandle
  for this file, NOT the runner).
- **Verdict:** REFUTED. **Severity:** minor (off-by-20 lines; the
  function name is distinctive enough that a grep would locate
  it, but the cited line ref is wrong).
- **Concrete fix:** Change `routes/background-tasks.ts:146` to
  `routes/background-tasks.ts:126` in `02 §3.1`.

### C-mr2. Plan's `[ASSUMPTION]` marker at `00-summary.md L298-302` claims the 19-runner count is verified — it isn't (per C-CR1, the count and the membership are both wrong)

- **Location:** `c-web/00-summary.md L298-302`.
- **Claim:** "[ASSUMPTION: the 19 web runners include 10 in
  `src/web/*.ts` and 9 in `src/web/routes/*.ts` +
  `src/web/federation/*.ts`; the brief states '19 web runners' and
  the grep in `02-type-interface-analysis.md §1.5` enumerates 19."
- **Evidence:** See C-CR1. The grep returns 18 distinct `start*`
  functions in web/ + federation/, NOT 19. The 19th in
  `02 §1.5` is an inline `setInterval`. The 19th in `03 §C3` is
  the misclassified `startInviteMonitor`. The `[ASSUMPTION]` is
  wrong.
- **Verdict:** REFUTED. **Severity:** minor (markers don't change
  the plan's substance, but they should be accurate).
- **Concrete fix:** Replace the [ASSUMPTION] with the correct
  breakdown: "18 distinct `start*` functions in web/ + federation/
  + 1 inline `authSessionSweepInterval` setInterval at
  `web.ts:436`. The runner-list table in `03 §C3` substitutes
  `startInviteMonitor` (called from `index.ts:539`, NOT a web
  runner) — this is being re-resolved per C-CR1."

### C-mr3. `c-web/02-type-interface-analysis.md §5` claims `web/main-agent.ts` is "the file the `buildHeartbeatAgentPrompt` and `ensureHeartbeatAgent` calls mentioned in the prompt" — but those symbols live in `web/heartbeat-agent-scaffold.ts`

- **Location:** `c-web/02-type-interface-analysis.md §5` CE-7
  cross-reference.
- **Claim:** The plan notes that `web/main-agent.ts` is unrelated to
  `buildHeartbeatAgentPrompt` / `ensureHeartbeatAgent`, and the
  prompt's question applies to `web/heartbeat-agent-scaffold.ts`,
  NOT to `web/main-agent.ts`.
- **Evidence:**
  - `src/web/main-agent.ts` exports `channelsSessionName`,
    `channelsLaunchdLabel`, `channelsPlistPath`,
    `MAIN_CHANNELS_SESSION`, `MAIN_CHANNELS_PLIST`,
    `isMainChannelsAgent` — none of these are `buildHeartbeatAgentPrompt`
    or `ensureHeartbeatAgent`. ✓
  - `src/web/heartbeat-agent-scaffold.ts` exists and is NOT in the
    C plan's 19-runner list (per CE-7). ✓
- **Verdict:** CONFIRMED. **Severity:** minor (correct exclusion,
  but the cross-reference could be clearer — the plan correctly
  excludes heartbeat-agent-scaffold.ts from C scope; this is just a
  documentation confirmation).
- **Concrete fix:** None needed. The plan correctly excludes
  `web/heartbeat-agent-scaffold.ts` from C scope.

### C-mr4. `c-web/03-class-boundaries.md §C1` `AuthGateDeps.env` field assumes `ChannelEnv` is a class — but the C plan's own 00-summary.md says `AuthGate` takes `Config` (B) only

- **Location:** `c-web/03-class-boundaries.md §C1` `AuthGateDeps`
  interface (L92-98): `env: ChannelEnv // D-tier:
  identifyFederationCaller path`; vs. `c-web/00-summary.md L94`
  ("`AuthGate` takes `Config` (B) only — `ChannelEnv` reads
  happen at route-handler time, not gate time").
- **Claim:** The plan has an internal inconsistency — `03 §C1`
  says `AuthGate` constructor takes `env: ChannelEnv`, but
  `00-summary.md` L94 says it doesn't.
- **Evidence:** Reading `src/web/auth-gate.ts:25`, the
  `identifyFederationCaller` is imported from
  `./federation/config.js` as a FREE FUNCTION, not as a
  `ChannelEnv` method. The `AuthGate` doesn't actually need a
  `ChannelEnv` instance — it just needs the env-derived helpers
  (token/chatId) which `ChannelEnv` provides as static methods or
  constructor-time reads.
- **Verdict:** REFUTED. **Severity:** minor (the inconsistency is
  resolved by reading `00-summary.md`, but `03 §C1`'s interface
  definition contradicts it).
- **Concrete fix:** Either:
  1. Drop `env: ChannelEnv` from `AuthGateDeps` (per `00-summary.md`),
     and note that `AuthGate` reaches env via `Config.env` instead,
     OR
  2. Keep `env: ChannelEnv` and update `00-summary.md` L94 to
     match (acknowledging the D-tier dependency).

### C-mr5. `c-web/00-summary.md` says "10 in `src/web/*.ts`" — actual is 11 (message-router, schedule-runner, worker-liveness, channel-monitor, inbound-probe, channel-health-monitor, stuck-input-watcher, stuck-tool-call-watcher, inbox-nudge-watcher, reauth-healer, auto-restart-runner, model-fallback-runner, context-guard-runner, update-checker = 14; minus the index.ts callers = ...)

- **Location:** `c-web/00-summary.md` L24: *"10 in `src/web/*.ts`,
  9 inside `src/web/routes/*.ts` or `src/web/federation/*.ts`"*.
- **Claim:** 10 web runner `start*` functions are in `src/web/*.ts`
  (top-level), 9 are in `routes/*.ts` + `federation/*.ts`.
- **Evidence:** Counting top-level `src/web/*.ts` (excluding routes/
  and federation/):
  - message-router.ts, schedule-runner.ts, worker-liveness.ts,
    channel-monitor.ts, inbound-probe.ts, channel-health-monitor.ts,
    stuck-input-watcher.ts, stuck-tool-call-watcher.ts,
    inbox-nudge-watcher.ts, reauth-healer.ts, auto-restart-runner.ts,
    model-fallback-runner.ts, context-guard-runner.ts,
    update-checker.ts = **14 distinct `start*` functions** at the
    top level of `src/web/`.
  - But the ones actually called from `web.ts` are 14: all 14 of
    the above are called (via direct `start*()` calls, not via
    index.ts). Plus 1 inline `setInterval` (authSessionSweep) +
    1 inline `setInterval` (tokenCollect) = 16 distinct
    non-federation web runners.
  - federation/poller.ts and federation/capability-runner.ts = 2
    in federation/.
  - routes/costs.ts and routes/approvals.ts = 2 in routes/.
  - Plus the misclassified `startInviteMonitor` at
    channel-invites.ts:271 (called from index.ts, not web.ts).
- **Verdict:** REFUTED. **Severity:** minor (the breakdown is
  wrong, but it doesn't affect C.3's scope).
- **Concrete fix:** Update `00-summary.md L24` to: "14 `start*`
  functions in `src/web/*.ts` + 2 inline `setInterval` at web.ts:436
  and :447 + 2 in `federation/*.ts` + 2 in `routes/*.ts` = 18
  start* + 2 inline = 20 distinct runners + the
  `startupWatchdogGrace` setTimeout + `startupWatchdogPoll`
  setInterval. The '19' count in the brief includes
  `authSessionSweepInterval` and excludes `tokenCollectInterval`
  (which the plan notes as the '20th interval')."

### C-mr6. The 23 vi.mock('../web.js') count claim — the plan flags it as "not directly enumerated", but the actual count is 1 (single test file mocks `../web.js`)

- **Location:** `c-web/06-risks-and-mitigations.md CR6` (L266-275).
- **Claim:** The plan states *"the per-route `vi.mock('../web.js')`
  count is not directly enumerated, but the per-route
  `vi.mock('../web/routes/*.js')` count is high"*.
- **Evidence:** `grep -rn "vi\.mock.*'\.\./web\.js" src/__tests__/`
  returns exactly **1** hit: `src/__tests__/index.test.ts:142` —
  `vi.mock('../web.js', () => ({...}))`.
- **Verdict:** CONFIRMED but precise count is 1 (not "high"). The
  plan's hedge is accurate but the magnitude is much smaller than
  implied. **Severity:** minor.
- **Impact:** C.8's "vi.mock('../web.js') factory rewrites" is a
  single-file change, not a multi-file migration. The 49
  `vi.mock('../db.js')` and 154 `vi.mock('../config.js')` sites
  (per M4) are the load-bearing counts; the `../web.js` count is
  negligible.
- **Concrete fix:** Update CR6 to note: "The `vi.mock('../web.js')`
  count is 1 (`src/__tests__/index.test.ts:142`). The 154
  `vi.mock('../config.js')` and 49 `vi.mock('../db.js')` sites
  (per M4) are the real migration burden, but those are
  H/A/B-tier concerns, not C-local."

---

## Confirmed claims (subset for context)

The following key claims were verified as TRUE:

### File and inventory claims

- **`src/web/routes/`** has **44 files** (`ls` returns 44).
  - `types.ts` has only `RouteContext` and `RouteHandler` — no
    `tryHandle` export.
  - **43 route files** have `tryHandle*` exports.
  - **43 `tryHandle*` calls** in the dispatch chain at
    `web.ts:173-215`.
- **`src/web/federation/`** has **9 files** (per `ls`): `address.ts`,
  `bridge.ts`, `capabilities.ts`, `capability-runner.ts`, `config.ts`,
  `http.ts`, `local-catalog.ts`, `onboarding.ts`, `poller.ts`. Total
  **1835 LOC**.
- **`src/web.ts`** is 576 LOC, with `startWebServer` at L88,
  `ensureDirs` at L84-86, `loadOrCreateDashboardToken` at L94,
  `import { logger }` at L32, `import type { RouteContext }` at L80,
  the `ctxAuth` ternary at **L154-159** (corrected per m2), the
  dispatch chain at L173-215 (43 calls), and the `server.close`
  override at L548-573.
- **`src/web/auth-gate.ts`** is 121 LOC. Key line refs confirmed:
  - `identifyFederationCaller` import at L25
  - `AuthResult` 5-arm union at L29-34
  - `SESSION_COOKIE_NAME` at L36
  - `parseCookies` at L40-52
  - `isSsePaneStream` (private) at L54-56
  - `isFederationWireEndpoint` at L58-63
  - `requiresAuth` at L68-74
  - `resolveAuth` at L76-121
- **`src/web/routes/types.ts`** has `RouteContext` at L7-25 and
  `RouteHandler` at L27.

### 18 web-runner start* functions (verified by grep)

All 18 of the following line refs in `c-web/03-class-boundaries.md
§C3` are correct:

| # | Symbol | Actual line | Class name (plan) |
|---|---|---:|---|
| 1 | `startMessageRouter` | `message-router.ts:277` | `MessageRouterRunner` ✓ |
| 2 | `startScheduleRunner` | `schedule-runner.ts:1000` | `ScheduleRunner` ✓ |
| 3 | `startWorkerLivenessMonitor` | `worker-liveness.ts:197` | `WorkerLivenessMonitorRunner` ✓ |
| 4 | `startChannelPluginMonitor` | `channel-monitor.ts:1390` | `ChannelPluginMonitorRunner` ✓ |
| 5 | `startInboundProber` | `inbound-probe.ts:371` | `InboundProberRunner` ✓ |
| 6 | `startChannelHealthMonitor` | `channel-health-monitor.ts:149` | `ChannelHealthMonitorRunner` ✓ |
| 7 | `startCostsSyncTask` | `routes/costs.ts:22` | `CostsSyncRunner` ✓ |
| 8 | `startStuckInputWatcher` | `stuck-input-watcher.ts:227` | `StuckInputWatcherRunner` ✓ |
| 9 | `startStuckToolCallWatcher` | `stuck-tool-call-watcher.ts:241` | `StuckToolCallWatcherRunner` ✓ |
| 10 | `startInboxNudgeWatcher` | `inbox-nudge-watcher.ts:276` | `InboxNudgeWatcherRunner` ✓ |
| 11 | `startReauthHealer` | `reauth-healer.ts:357` | `ReauthHealerRunner` ✓ |
| 12 | `startAutoRestartRunner` | `auto-restart-runner.ts:149` | `AutoRestartRunner` ✓ |
| 13 | `startModelFallbackRunner` | `model-fallback-runner.ts:143` | `ModelFallbackRunner` ✓ |
| 14 | `startContextGuardRunner` | `context-guard-runner.ts:336` | `ContextGuardRunner` ✓ |
| 15 | `startUpdateChecker` | `update-checker.ts:253` | `UpdateCheckerRunner` ✓ |
| 16 | `startFederationPoller` | `federation/poller.ts:276` | `FederationPollerRunner` ✓ |
| 17 | `startCapabilitySummaryRunner` | `federation/capability-runner.ts:80` | `CapabilitySummaryRunner` ✓ |
| 18 | `startApprovalTimeoutSweeper` | `routes/approvals.ts:54` | `ApprovalTimeoutSweeperRunner` ✓ |
| (19) | `startInviteMonitor` (NOT web.ts) | `channel-invites.ts:271` | **MISCLASSIFIED** (per C-CR1) |

### Type and interface claims

- `AuthResult` has 5 kinds (`token | device | federation | session |
  none`) at `auth-gate.ts:29-34`. The `device` field is `string`
  (not `DeviceRow`); `deviceId: number` is a separate field.
- `RouteContext.auth` is a 4-arm literal-union object at
  `routes/types.ts:24`. The `'none'` arm collapses to `undefined`
  in the `ctxAuth` ternary.
- `BridgeSendResult` is a 4-arm union (per the plan's `02 §4.2`)
  and is correctly NOT being sealed.
- `FederationPollInternalError` is at `federation/poller.ts:68`.
- `PeerResponseTooLargeError` is at `federation/http.ts:7`.
- `RequestBodyTooLargeError` is at `http-helpers.ts:25`.
- `RemoteStatusCache<T>` is at `web/remote-status-cache.ts:19`,
  used at `web/routes/agents.ts:204-205`.
- `json()` is at `web/http-helpers.ts:56-65`.
- The `InboxAccept` interface is at `routes/federation.ts:115`,
  `validateInboxPayload` at L125-130, `JSON_PARSE_ERROR` at L268,
  `buildManifest` at L203, `peerView` at L244, `peersView` at L256,
  `isErr` at L275-276, `ctx.fedPeer` read at L329.

### Logger call counts

- 50 `logger.<level>` calls in `src/web.ts` ✓
- 159 `logger.<level>` calls across `src/web/routes/*.ts` ✓
- 12 `logger.<level>` calls across `src/web/federation/*.ts` ✓
- **Total C: 221** ✓

### Sealed-class rejections

- `AuthContext` sealed class hierarchy is DROPPED per OE-4 (the
  plan explicitly notes the rejection throughout: `00-summary.md`,
  `02-type-interface-analysis.md §2.3 + §7`, `03-class-boundaries.md
  §C1 "Critical decision"`, `04-generic-interfaces.md §C2`).
- `BaseRunner<TFacts, TDecision>` is DROPPED per OE-5.
- `DashboardServer<TConfig>`, `AuthGate<TContext>`,
  `RouteHandler<TParams, TResponse>`, `TtlCache<K, V>` are all
  REJECTED per OE-6.

### Out-of-scope claims

- `web/heartbeat-agent-scaffold.ts` is correctly excluded from C
  scope (per CE-7). The plan acknowledges this in
  `02 §5` and elsewhere.
- `ChannelPairingStore` does NOT exist in code
  (`grep -rn "ChannelPairingStore" src/` returns nothing) — the
  plan does not assume it exists.
- `web/main-agent.ts` is correctly classified as a 49-LOC pure
  utility with no class-conversion candidate.

---

## Net verdict

**NEEDS-FIX (1 critical, 4 major, 6 minor = 11 findings).**

The C plan is in good shape on the majority of its claims. Every
key file/line reference verified (44 route files, 9 federation
files, web.ts:154-159 ternary, AuthResult 5 kinds, error class line
refs, RouteContext shape, 18 of 19 start* function line refs,
logger call counts, sealed-class rejections, out-of-scope
exclusions) is accurate. The plan correctly applies the cross-cutting
precedents: AuthContext sealed class DROPPED per OE-4 (with the
correct 'none' case mapping to `undefined`), BaseRunner DROPPED per
OE-5, generics rejected per OE-6, RemoteStatusCache<T> reused per
CE-9, LoggerLike applied per H.1.

The Critical finding (C-CR1) is a scope ambiguity, not a
correctness error: `startInviteMonitor` is listed as one of the 19
"web runners" but is called from `index.ts:539`, not `web.ts`. This
means either C.3 must drop it (and the 19th becomes the inline
`authSessionSweepInterval`) or the conversion must move to F
(agent subsystem). Either resolution is straightforward but the
plan must explicitly choose.

The Major findings are off-by-one errors and a count drift that
affect budget/blast-radius claims but not the substance of the
plan: the dispatch chain has 43 tryHandle* calls (not 44), the
cleanup has 20 clearInterval + 1 clearTimeout (not 22), the
phase-table sum overcounts because `kanban.ts` is in both Phase 2
and Phase 3, and `web/atomic-write.ts` has 17 (not 14) vi.mock
sites. All are line/count corrections.

The Minor findings are documentation accuracy (sweepOrphanedBackgroundTasks
line ref, AuthGateDeps.env field inconsistency, the runner-count
breakdown claim in `00-summary.md`).

### Specific fixes before implementation:

1. **Resolve C-CR1**: Reassign `startInviteMonitor` (call site
   `index.ts:539`) to F (agent subsystem), and replace it with the
   inline `authSessionSweepInterval` (`web.ts:436`) in C.3's runner
   table. Update the [ASSUMPTION] marker in
   `00-summary.md L298-302`.
2. **C-MR1**: Replace "22 `clearInterval` calls" with "20
   `clearInterval` + 1 `clearTimeout(startupWatchdogGrace)` = 21
   cleanup calls" in `02 §1.6`, `03 §C2`, `05 §C.2`.
3. **C-MR2**: Replace "44 route handlers / 44 tryHandle* calls"
   with "43 tryHandle* exports + 1 types.ts = 44 route files" and
   "43 calls at `web.ts:173-215`". Re-tabulate C.4+C.5+C.6 as 11
   + 21 + 11 = 43.
4. **C-MR3**: Ensure `02 §1.5` and `03 §C3` agree on what the 19th
   web runner is (after C-CR1's fix).
5. **C-MR4**: Update `vi.mock('../web/atomic-write.js')` count
   from 14 → 17.
6. **C-mr1**: Fix `sweepOrphanedBackgroundTasks` line ref from 146
   → 126.
7. **C-mr4**: Reconcile `AuthGateDeps.env: ChannelEnv` (in
   `03 §C1`) with `00-summary.md L94`'s claim that `AuthGate`
   takes `Config` (B) only.
8. **C-mr5**: Update `00-summary.md L24` to give the correct
   breakdown of the 18 web-runner start* functions + 2 inline
   intervals.
9. **C-mr6**: Update `06-risks-and-mitigations.md CR6` to note
   the actual `vi.mock('../web.js')` count is 1, not "high".

After applying 1-9, the plan should be sound for implementation.
Without them:
- C.3 may be handed off to a F-tier owner without explicit
  agreement (C-CR1),
- The `DashboardServer.intervals[]` field would be sized wrong
  (C-MR1),
- The phase table claims "44 routes" but the migration is 43
  (C-MR2),
- The `kanban.ts` migration order is ambiguous (C-MR2),
- The atomic-write exemption rationale cites the wrong mock count
  (C-MR4).

### Confidence level

High confidence on every confirmed line ref (each was grep-verified
or read-verified against the live source). High confidence on the
C-CR1 scope error (call site is unambiguous — `index.ts:539`, not
`web.ts`). High confidence on C-MR1 (counting the `clearInterval`
calls line-by-line is mechanical). High confidence on C-MR2 (44
files vs 43 tryHandle exports — the off-by-one is `types.ts` which
has no tryHandle). Medium confidence on the internal consistency
checks (the plan has multiple tables that need to agree; a
mismatch in one table doesn't necessarily invalidate the others).

---

**End of C (web) correctness review. No source files modified.**