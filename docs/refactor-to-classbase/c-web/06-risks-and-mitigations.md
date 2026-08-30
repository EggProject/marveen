# C (web) — Risks and mitigations

Risks specific to the C subsystem. Each risk: name, where-it-bites,
mitigation, detection signal. Cross-references:
`review-completeness.md` (OE-4, OE-5, OE-6, OE-9, CE-3, CE-9, CE-11, M11),
`review-correctness.md` (C1, C2, C3, C6),
`c-web/00-summary.md`, `c-web/03-class-boundaries.md`,
`c-web/05-refactor-roadmap.md`.

**Reading note.** The 10 risks below are ranked by severity (CR1–CR3
are Critical, CR4–CR7 are High, CR8–CR10 are Medium). The
`h-cross-cutting/06-risks-and-mitigations.md` HR1–HR6 cross-cutting
risks ALSO apply to C but are documented in H, not here; this document
covers C-LOCAL risks only.

---

## CR1. 44 route handler blast radius (per `review-correctness.md CE-3`)

**Severity:** Critical.

**Where it bites:** The `RouteContext` interface at
`src/web/routes/types.ts:7-25` is consumed by 44 route files in
`src/web/routes/`. Any change to the interface (adding a field,
changing a field type, renaming) ripples to all 44 files.

The C.4–C.6 phases add 2 new fields to `RouteContext`:
- `log: LoggerLike` (C.4 — 12 low-risk routes).
- `stores: RouteStores` (C.5 — 21 mid-risk routes, gated on A.1–A.5).
- `auth` projection (C.6 — 11 high-risk routes, `auth.ts:9` and
  `security.ts:2`).

**Worst case:** A `RouteContext` field rename breaks 44 files in a
single commit, and the test suite goes red across hundreds of test
files. Per CLAUDE.md §3 ("surgical changes — touch only what you
must"), the migration must NOT rename existing fields.

**Mitigation (per `c-web/05-refactor-roadmap.md` C.4–C.6):**

1. **Phased by risk.** C.4 (low-risk public routes) → C.5 (mid-risk
   authenticated read) → C.6 (high-risk write/auth/admin). Each
   phase is its own commit and its own rollback boundary.
2. **Per-route rollback.** Each route file's change is additive —
   the `import { logger } from '../../logger.js'` is removed AFTER
   the new `ctx.log.X` access is added. Revert the commit, the
   route goes back to the module-level logger.
3. **Additive only.** No existing fields are renamed. The new fields
   are OPTIONAL (`log?: LoggerLike`, `stores?: RouteStores`) so a
   route file that hasn't migrated yet still compiles.
4. **Per-sub-phase commits.** Each route file's migration is its
   own PR; the team can ship 12 C.4 commits in parallel without
   merge conflicts (the routes touch different files).

**Detection signal:**
- `bun tsc --noEmit` red on `src/web/routes/*.ts` (any field
  rename breaks immediately).
- `bun --bun vitest run` red on the 144+ per-route tests.
- `grep -nE "RouteContext\\['(auth|stores|log)'\\]" src/web/routes/*.ts`
  showing inconsistent access patterns (some routes use the new
  field, some still use the old).

**Pre-existing precedent:** The `federation/poller.ts` cluster
refactor (per `review-completeness.md CE-2`) is the model — cluster
refactors land as single PRs because the internal coupling forbids
piecemeal commits. C.4–C.6 are the opposite: routes are
INDEPENDENT (no internal coupling), so piecemeal commits are safe.

---

## CR2. web/federation/ sub-cluster (per `review-correctness.md CE-2`)

**Severity:** Critical.

**Where it bites:** The 9 files in `src/web/federation/` (1835 LOC
per `review-correctness.md CE-2`, verified 9 files by `ls` on
2026-08-30) form a tightly coupled sub-cluster:
- `poller.ts` imports from `bridge.ts`, `capabilities.ts`,
  `config.ts`, `http.ts`.
- `bridge.ts` imports from `config.ts`, `http.ts`.
- `capabilities.ts` imports from `config.ts`.
- `capability-runner.ts` imports from `capabilities.ts`,
  `config.ts`.

Partial conversions introduce ordering hazards: e.g. extracting
`FederationBridge` while leaving `FederationPoller` as free
functions forces the poller to import the class form, but the class
form isn't fully wired (the bridge's `ChannelEnv` dependency
isn't injected yet).

**Worst case:** Piecemeal refactor of the federation cluster breaks
3-4 of the 9 files in subtle ways (the `import.meta.url ===
pathToFileURL(process.argv[1]).href` guard at
`channel-coordinator.ts:435` — not in C scope, but the same
pattern applies). The integration test fails late, after the team
has spent a sprint on the refactor.

**Mitigation (per `c-web/05-refactor-roadmap.md` C.7):**

1. **Cluster-wide PR.** C.7 is a single PR that lands all 9
   federation cluster files together. No piecemeal commits.
2. **Free functions survive as wrappers.** Per `c-web/03-class-boundaries.md
   §C6`, the existing free functions (e.g. `readBoundedBody`,
   `parseQualifiedId`) become thin wrappers of the new class
   methods. This lets `routes/federation.ts` migrate incrementally
   without a flag-day.
3. **Order preservation.** The 9 files are converted in dependency
   order: `http.ts` → `address.ts` → `config.ts` → `bridge.ts` →
   `capabilities.ts` → `local-catalog.ts` → `onboarding.ts` →
   `capability-runner.ts` → `poller.ts`. The poller is LAST
   because it consumes all the others.
4. **Pre-existing precedent:** Per `review-completeness.md CE-2`,
   the framework's Phase 5 listed 4 fictional paths for the
   federation runners; the corrected paths (per
   `review-correctness.md C3`) are documented in
   `c-web/03-class-boundaries.md §C3`. The runner-class conversion
   for the federation poller is part of C.3 (MessageRouterRunner
   etc.), NOT C.7; C.7 is the class extraction for the 9
   federation cluster files.

**Detection signal:**
- `bun tsc --noEmit` red on `src/web/federation/*.ts`.
- `bun --bun vitest run src/__tests__/federation-*.test.ts` red.
- `grep -nE "from '\\./bridge" src/web/federation/poller.ts` —
  if this returns a class import, the bridge was converted before
  the poller, which is the wrong order.

---

## CR3. AuthContext decision (per `review-completeness.md OE-4` + `review-correctness.md C2`)

**Severity:** Critical.

**Where it bites:** The framework `04-generic-interfaces.md D1`
proposed a sealed `AuthContext` hierarchy with 4 subclasses
(`TokenAuth`, `DeviceAuth`, `SessionAuth`, `FederationAuth`). The
`review-completeness.md OE-4` rejected this AND
`review-correctness.md C2` flagged that the proposal forgot the
`'none'` arm (the 5-arm `AuthResult` union at `auth-gate.ts:29-34`
has `token | device | federation | session | none`; the proposal
had 4 subclasses).

**Worst case:** A future contributor who hasn't read OE-4 + C2
re-introduces the sealed-class hierarchy, adding 4 (or 5) classes
with zero behavioral change. Per-request heap allocation multiplied
by 44 routes × N requests. Worse: the migration window needs dual
representation (per OE-4 §D4) — that's a regression, not a refactor.

**Mitigation:**

1. **EXPLICIT decision recorded:** `c-web/00-summary.md` and
   `c-web/03-class-boundaries.md §C1 "Critical decision: AuthContext
   is NOT sealed"` document the rejection. The C.1 phase does NOT
   introduce any sealed class; `AuthGate.getRouteContextAuth()`
   returns `RouteContext['auth']` (the existing 4-arm literal-union
   object at `routes/types.ts:24`).
2. **The `'none'` case maps to `undefined`.** Per
   `review-correctness.md C2`: the 5-arm source collapses to
   `undefined` in the 4-arm destination via the `ctxAuth` ternary
   at `web.ts:154-159`. The ternary is preserved verbatim — only
   extracted into a private method.
3. **No `instanceof AuthResult`** — there is no `instanceof` check
   anywhere in C today (per `02-type-interface-analysis.md §2.3`).
   Sealing would force `instanceof TokenAuth` etc. — adding 4 new
   `instanceof` discrimination sites for zero benefit.
4. **Cross-reference in code comments.** After C.1 lands, add a
   comment in `auth-gate.ts:29-34` explaining why `AuthResult` is a
   union, NOT a sealed hierarchy.

**Detection signal:**
- A new commit introduces `class TokenAuth extends AuthContext`
  (or similar) — the test suite won't catch this directly, but a
  `grep -nE "extends AuthContext" src/web/auth-gate.ts` after the
  commit would.
- `bun --bun vitest run src/__tests__/auth-gate.test.ts` shows
  the existing 5-arm assertions failing (if anyone changes
  `AuthResult` to a sealed class without updating tests).

---

## CR4. DashboardServer lifecycle — singleton vs per-request (per B.Config + G.ChannelCoordinator precedent)

**Severity:** High.

**Where it bites:** `DashboardServer` is constructed once at boot
(`index.ts:451` is the only production call site for
`startWebServer(port)`). The class form preserves this singleton
shape: one instance per process, constructed in `index.ts`,
lives for the process lifetime.

**Worst case:** A future contributor decides to construct
`DashboardServer` per-request (e.g. for testing or HMR), which
breaks the lifecycle invariant — the server's intervals would
restart on every construction, causing runaway timers.

**Mitigation (per `c-web/05-refactor-roadmap.md` C.2):**

1. **Singleton pattern enforced via constructor semantics.** The
   `DashboardServer` constructor is NOT marked `private` (so
   `index.ts` can construct it), but the docs explicitly state
   "one instance per process". A `static instance: DashboardServer
   | null` is NOT used (would couple the class to process state).
2. **`start()` is idempotent.** If called twice, the second call
   throws (or returns the existing `http.Server`). Per the
   `PortLockAcquirer` precedent (per
   `e-process-lock/03-class-boundaries.md`), the class form
   documents the idempotency expectation.
3. **Pre-existing precedent:** `Config` (B.1) is a singleton per
   process; `ChannelCoordinator` (G.4) is a singleton per
   coordinator process; `DashboardServer` follows the same
   pattern.
4. **Test factory convention.** Per
   `review-completeness.md CE-5`, `createTestDashboardServer()`
   constructs a fresh instance per test, but the test's `afterEach`
   calls `await server.stop()` to clean up intervals. This
   prevents test-bleed.

**Detection signal:**
- The test suite hangs after running (intervals not cleaned up).
- `grep -nE "new DashboardServer" src/` returns >1 (multiple
  construction sites).
- `bun --bun vitest run src/__tests__/dashboard-server.test.ts`
  fails the idempotency assertion.

---

## CR5. 19 web runner file paths (per `review-correctness.md C3`)

**Severity:** High.

**Where it bites:** The framework `00-summary.md` and
`05-refactor-roadmap.md` Phase 5 listed 4 fictional paths for the
federation runners: `src/web/federation-poller.ts`,
`src/web/capability-summary-runner.ts`, `src/web/costs-sync-task.ts`,
`src/web/approval-timeout-sweeper.ts`. Per `review-correctness.md
C3`, these paths DO NOT EXIST. The corrected paths are:
- `src/web/federation/poller.ts:276` (`startFederationPoller`)
- `src/web/federation/capability-runner.ts:80`
  (`startCapabilitySummaryRunner`)
- `src/web/routes/costs.ts:22` (`startCostsSyncTask`)
- `src/web/routes/approvals.ts:54` (`startApprovalTimeoutSweeper`)

**Worst case:** An executor looking for `src/web/costs-sync-task.ts`
gets "No such file or directory", wastes an hour finding the real
path, and lands the conversion on the wrong code path.

**Mitigation:**

1. **Corrected paths in `c-web/03-class-boundaries.md §C3`.** The
   full table lists all 19 runners with verified file:line.
2. **Verified on 2026-08-30** via
   `grep -rnE "^export function start" src/web/ src/web/federation/
   | grep -v __tests__` returning 19 (with one duplicate: the
   poller and capability-runner appear twice in the grep because
   they're exported; the actual distinct count is 19).
3. **README cross-check** — the README in `docs/refactor-to-classbase/`
   (if it exists) must be updated to reflect the corrected paths.

**Detection signal:**
- `ls src/web/costs-sync-task.ts` returns "No such file or
  directory".
- `grep -nE "src/web/costs-sync-task" docs/refactor-to-classbase/`
  returns any hits (would indicate the bad path is still cited).

---

## CR6. vi.mock('../web.js') patterns (per `review-completeness.md CE-5`)

**Severity:** High.

**Where it bites:** Per `review-correctness.md M4`, the codebase has
154 `vi.mock('../config.js', …)` sites, 49 `vi.mock('../db.js', …)`
sites, 88 `vi.mock('../logger.js')` sites. The
`vi.mock('../web.js')` count is not directly enumerated, but the
per-route `vi.mock('../web/routes/*.js')` count is high (per the
brief: "likely high; web tests are numerous").

**Worst case:** The C.8 phase rewrites `vi.mock` sites to
constructor injection, but the test factory design is missing.
Each test author writes their own ad-hoc `new DashboardServer({...})`
boilerplate, leading to N different mock styles.

**Mitigation (per `review-completeness.md CE-5`):**

1. **Test factory design FIRST.** Before C.8 starts, the team
   designs `createTestLogger()`, `createTestAuthGate(overrides?)`,
   `createTestDashboardServer(overrides?)` in
   `src/__tests__/test-factories.ts`. Per
   `review-completeness.md CE-5`: "the first 5-10 tests will set
   the convention; everything after copies it. If the convention
   is set wrong (e.g. wrong mock seam, missing logger), the rework
   cost is enormous."
2. **Migration in lockstep with C.1–C.7.** Each C.1–C.7 commit
   updates the corresponding test file. This avoids a 154-file
   rewrite at the end.
3. **Per-file rewrite in C.8.** C.8 is the verification phase —
   any remaining `vi.mock` sites are rewrites, not new
   conventions.

**Detection signal:**
- `bun --bun vitest run src/__tests__/` shows
  inconsistent mock patterns (some tests use `createTestXxx`, some
  use raw `vi.mock`).
- `grep -rnE "vi\\.mock\\(['\"]\\.\\./web" src/__tests__/` returns
  >0 after C.8 (would indicate incomplete migration).

---

## CR7. H subsystem HR4 (LoggerLike vs pino.Logger) applies to C

**Severity:** High.

**Where it bites:** Per `h-cross-cutting/06-risks-and-mitigations.md
HR4` (forthcoming), the `LoggerLike` interface MUST accept both
object-first and string-first call shapes:
- `log.info({ field }, 'msg')` (626 of 744 production calls)
- `log.info('msg')` (76 of 744 production calls)

If the `LoggerLike` interface is too narrow (e.g. only
object-first), C's 221 `logger.<level>(` call sites fail
type-check.

**Worst case:** C.1 lands with the wrong `LoggerLike` shape, and
221 sites fail `bun tsc --noEmit`. The fix is to widen
`LoggerLike` in H, but that's a cross-cutting change requiring
H.1 to be redone.

**Mitigation:**

1. **H.1 lands BEFORE C.1.** Per `c-web/05-refactor-roadmap.md
   C.1`, the pre-condition is "H.1 (`LoggerLike`) lands".
2. **`LoggerLike` is wider than pino's `LogFn`.** Per
   `h-cross-cutting/00-summary.md`, the `LoggerLike` interface
   carries the union of all call shapes (object-first, string-first,
   variable-first). C's 221 call sites don't change textually —
   only the receiver changes (`logger.X` → `this.log.X`).
3. **Verification per `c-web/05-refactor-roadmap.md` C.9.** The
   verification phase grep-checks every call site.

**Detection signal:**
- `bun tsc --noEmit` red on `src/web.ts`,
  `src/web/routes/*.ts`, `src/web/federation/*.ts`.
- `grep -nE "logger\\.\\(info\\|warn\\|error\\|debug\\)" src/web/`
  returns >0 after C.9.

---

## CR8. Shutdown sequence (per `review-completeness.md M11`)

**Severity:** High.

**Where it bites:** Per `review-completeness.md M11`, the
documented shutdown order in `index.ts:378-410` is:
```
stopHeartbeat → stopInviteMonitor → stopChannelRequestWatcher →
stopStoreWatcher → clearInterval(decayInterval) → clearTimeout(digestTimer) →
clearInterval(digestInterval) → webServer.close(…) → releaseLock()
```
NOT the invented order in the framework plan ("digest timer in
memory.ts, decay interval in index.ts, heartbeat scheduler, store
watcher, settings store, runners, web server, process lock, db").
The actual order has 9 steps, NOT the framework's 9 (which included
3 that don't exist: `SettingsStore.stopWatching()`,
`BackgroundTaskPool.finishAll()`, `DbClient.close()`).

**Worst case:** The C.2 phase's `DashboardServer.stop()` is
inserted in the WRONG position in the shutdown chain, causing
double-shutdown or hanging handles.

**Mitigation:**

1. **`DashboardServer.stop()` is called by `index.ts:378-410`'s
   `webServer.close(…)`.** The class method replaces the inline
   `server.close(…)` callback. The order in `index.ts:378-410` is
   preserved verbatim.
2. **22 intervals cleared in REVERSE order (LIFO drain).** Per
   `c-web/05-refactor-roadmap.md C.2`, `DashboardServer.stop()`
   iterates `this.intervals` in REVERSE and `clearInterval()` each.
   This matches the current hand-rolled `server.close` override at
   `web.ts:548-573`.
3. **No new shutdown steps introduced.** C.2's `stop()` is a
   literal translation of the existing close handler. C.10's free
   function removal does NOT add new steps.
4. **Pre-existing precedent:** Per `review-completeness.md M11`,
   "either (a) document the *current* shutdown order with the
   steps that actually exist, OR (b) explicitly mark the order as
   'target post-refactor' and list which steps are *new*". C
   chooses (a) — the order is preserved verbatim.

**Detection signal:**
- `bun --bun vitest run src/__tests__/shutdown.test.ts` (if it
  exists) fails.
- The dashboard hangs on SIGTERM (intervals not cleared).
- `grep -nE "this\\.intervals" src/web.ts` shows <22 references.

---

## CR9. AuthGate + ChannelEnv integration

**Severity:** High.

**Where it bites:** `AuthGate.resolveAuth` (at `auth-gate.ts:76-121`)
calls `identifyFederationCaller(req.headers.authorization,
checkBearerToken)` (imported from `federation/config.ts:25`). This
is the only D-tier dependency in `AuthGate`.

**Worst case:** The D.1 phase (`ChannelEnv` class extraction)
changes `identifyFederationCaller`'s signature (e.g. to take
`ChannelEnv` instead of `env`), and `AuthGate`'s constructor
needs to inject `ChannelEnv`. If C.1 lands BEFORE D.1, the
dependency breaks.

**Mitigation:**

1. **C.1 lands AFTER D.1.** Per `c-web/00-summary.md` Dependency
   table: "Per `d-channel-provider/00-summary.md` D.1 must
   precede C.1 only if `AuthGate` constructor takes `ChannelEnv`
   directly. **Decision:** `AuthGate` takes `Config` (B) only —
   `ChannelEnv` reads happen at route-handler time, not gate
   time." So C.1 does NOT depend on D.1.
2. **`AuthGate` constructor takes `Config` (B) for env access.**
   Per `b-config/00-summary.md`, `Config.env` exposes the parsed
   env record (same as `ChannelEnv`'s constructor arg). The
   `identifyFederationCaller` call doesn't need `ChannelEnv`
   directly.
3. **D.5 (`ChannelEnv` helper removal) is gated on the D-tier
   consumers migrating.** Per `d-channel-provider/00-summary.md
   D.5`, the free helpers `getChannelToken` / `getChannelChatId`
   survive as thin wrappers until every consumer migrates. C.1
   uses `Config.env`, NOT `getChannelToken`, so D.5 is orthogonal
   to C.1.

**Detection signal:**
- `bun tsc --noEmit` red on `src/web/auth-gate.ts`.
- `grep -nE "ChannelEnv" src/web/auth-gate.ts` returns >0 (would
  indicate a missing D.1 dependency).

---

## CR10. Route handler pattern consistency (per C5 + C6 design)

**Severity:** Medium.

**Where it bites:** The 44 route handlers today have a uniform
shape: `tryHandleXxx(ctx: RouteContext): Promise<boolean>`. After
C.4–C.6, the handlers should STILL have this shape — the changes
are inside the handler body (use `ctx.log`, `ctx.stores`,
`ctx.auth`), not the signature.

**Worst case:** The C.5 phase introduces a new handler shape (e.g.
`tryHandleXxx(ctx: RouteContext, opts: { stores: RouteStores })`)
that breaks the existing dispatcher chain at `web.ts:173-215`.

**Mitigation:**

1. **Signature preservation.** Per `c-web/03-class-boundaries.md
   §C4` and `§C5`, the handler signature is preserved verbatim.
   The new fields (`log`, `stores`) are OPTIONAL on
   `RouteContext`, so a handler that hasn't migrated still
   compiles.
2. **`RouteHandler` type alias unchanged.** Per
   `src/web/routes/types.ts:27`: `export type RouteHandler = (ctx:
   RouteContext) => Promise<boolean>`. This is preserved.
3. **Dispatcher chain unchanged.** The `web.ts:173-215` chain (44
   `tryHandle*` calls) is preserved verbatim. Each handler returns
   `true` (handled) or `false` (next handler).
4. **Pre-existing precedent:** Per
   `review-completeness.md CE-7`, "Route handlers... stay as
   functions (Phase 8+)." The C.4–C.6 phases do NOT introduce new
   classes for routes.

**Detection signal:**
- `bun tsc --noEmit` red on `src/web.ts` (the dispatcher).
- `grep -nE "tryHandle.*\\(ctx.*opts" src/web/routes/*.ts` returns
  >0 (would indicate a signature change).
- `bun --bun vitest run src/__tests__/web-dispatcher.test.ts`
  fails.

---

## Cross-references

- `c-web/00-summary.md` — Executive summary, top 3 risks.
- `c-web/03-class-boundaries.md` — Concrete class candidates.
- `c-web/05-refactor-roadmap.md` — Phased mitigation (10 phases).
- `review-completeness.md`:
  - OE-4: AuthContext sealed class DROPPED.
  - OE-5: BaseRunner DROPPED.
  - OE-6: single-consumer generics REJECTED.
  - OE-9: App.getStore<K> DROPPED.
  - CE-3: 44 route blast radius.
  - CE-4: error-class taxonomy.
  - CE-5: test factory design.
  - CE-9: RemoteStatusCache<T> reuse.
  - CE-11: per-store blast-radius tables.
  - M11: shutdown sequence.
- `review-correctness.md`:
  - C1: ChannelProvider interface methods.
  - C2: AuthContext 'none' case.
  - C3: 4 fictional runner paths.
  - C6: index.ts import count.
- `h-cross-cutting/06-risks-and-mitigations.md` — HR1–HR6 (cross-cutting).
- `b-config/06-risks-and-mitigations.md` — BR1–BR4.
- `d-channel-provider/06-risks-and-mitigations.md` — DR1–DR4.
- `a-db/06-risks-and-mitigations.md` — AR1–AR4.
- `e-process-lock/06-risks-and-mitigations.md` — ER1–ER5.
- `f-agent-subsystem/06-risks-and-mitigations.md` — FR1–FR8.
- `g-channel-coordinator/06-risks-and-mitigations.md` — GR1–GR3.

## [ASSUMPTION] markers

- [ASSUMPTION: the `vi.mock('../web.js')` count is not directly
  enumerated in the framework plans; the "144+ per-route
  vi.mock" count is a brief estimate. The actual count must be
  measured via
  `grep -rnE "vi\\.mock\\(['\"]\\.\\./web" src/__tests__/ | wc -l`
  before C.8 starts.]
- [ASSUMPTION: the 22 intervals in `web.ts:548-573` is the exact
  count; verified by reading the source on 2026-08-30. If a 23rd
  interval is added during the refactor, the `DashboardServer.stop()`
  method must extend accordingly.]
- [ASSUMPTION: the 221 `logger.<level>(` call sites in C is the
  exact count; per `02-type-interface-analysis.md §10`, this is
  the measured number (50 + 159 + 12).]
- [ASSUMPTION: the `RouteContext` interface changes in C.4–C.6 are
  purely additive (no field renames). If a future contributor
  renames `auth` to `principal` (for example), the CR1 mitigation
  fails — but that rename would be a behavior change, not a
  refactor.]

---

**End of C risks-and-mitigations plan. No source files modified.**
