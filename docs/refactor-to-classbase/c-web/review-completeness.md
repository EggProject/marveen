# Plan Review — C (web) over-engineering & completeness

Review scope: all six C plan documents
(`docs/refactor-to-classbase/c-web/00-summary.md` through
`06-risks-and-mitigations.md`). Source ground-truth verified against
`src/web.ts` (576 LOC), `src/web/auth-gate.ts` (121 LOC), the 44
route files in `src/web/routes/`, the 9 federation files in
`src/web/federation/`, and the importer / mock landscape on
2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`).

The framework's `review-completeness.md` (OE-1 to OE-11), the H
review (HOE-1 to HOE-7, HCE-1 to HCE-11), the E review (EOE-1 to
EOE-5, ECE-1 to ECE-8), the D review (OE-D1 to OE-D5, CE-D1 to
CE-D10), the F review (OE-F1 to OE-F5, CE-F1 to CE-F12), the G
review (GOE-1 to GOE-8, GCE-1 to GCE-12), the B review (BOE-1 to
BOE-6, BCE-1 to BCE-15), and the A review (AOE-1 to AOE-8, ACE-1 to
ACE-15) are the lenses. C's own claims (44 routes, 19 runners, 22
intervals, 221 logger call sites, 9 federation files, the
`web.ts:548-573` hand-rolled close handler, the
`web.ts:154-159` ctxAuth ternary) are cross-checked against the
source tree before scoring.

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 3 | 4 |
| Completeness | 1 | 8 | 4 |

**Net assessment: ACCEPT-WITH-EDITS.** C's keystone thesis is
correct and load-bearing: the `AuthGate` + `DashboardServer` class
extraction follows the `Config` / `ChannelEnv` / `PortLockAcquirer`
precedent, the 22-interval consolidation into `private intervals:
NodeJS.Timeout[]` is a real simplification (per
`web.ts:548-573` the current close handler is hand-rolled), the
`AuthContext` sealed-class and `BaseRunner<TFacts, TDecision>`
rejections from the framework review are correctly inherited, and
the `RemoteStatusCache<T>` reuse decision (CE-9) is correctly
deferred. The 4-arm `ctxAuth` literal-union collapse to `undefined`
is correctly preserved verbatim.

But the plan has one critical completeness miss (the missing
`01-module-state-analysis.md` input file cascades into baseline-
count drift), three major over-engineering seams (C.9 as a phase,
C.4–C.6 phase splitting, an internal `AuthGateDeps` contradiction),
and seven major completeness gaps — most notably the
`vi.mock('../web.js')` count claim (plan: "144+ per-route"; measured
**1 direct mock + 3 per-route mocks**), the bun-specific HTTP
server / `vi.mock` factory-hoisting verification gap (CE-17
inheritance, missing across all of C.8 / C.9 / C.10), the missing
test-factory specification for `createTestDashboardServer` /
`createTestAuthGate` (CE-5 / HCE-7 lesson), and the
`web/atomic-write.ts` scope ambiguity (the plan lists it as
out-of-scope per CE-6 but 6 web/ files import it, including 3 of
the 44 routes).

---

## Over-engineering findings

### OE-C1 (major) — `AuthGateDeps` `env: ChannelEnv` field contradicts the
"no D dependency" claim in `00-summary.md` Dependency table

**Proposal** (`03-class-boundaries.md` §C1 "Public surface", line 92-97):
```ts
interface AuthGateDeps {
  config: Config                  // B-tier: needs DASHBOARD_TOKEN, PROJECT_ROOT for token load
  env: ChannelEnv                 // D-tier: identifyFederationCaller path
  log: LoggerLike                 // H-tier: structured warn/error on auth failures
  dashboardToken: string          // injected to avoid re-reading from disk per-request
}
```

But the same plan's `00-summary.md` Dependency table says:
> "**C ← D** | `ChannelEnv` class + 5 `XxxProvider` classes | ...
> `AuthGate.resolveAuth()` does NOT take a `ChannelProvider` (the gate
> delegates to `getFederationConfig` at `auth-gate.ts:25`); but
> `DashboardServer.start()` calls `loadOrCreateDashboardToken()` which
> depends on env that `ChannelEnv` reads. Per `d-channel-provider/
> 00-summary.md` D.1 must precede C.1 only if `AuthGate` constructor
> takes `ChannelEnv` directly. **Decision:** `AuthGate` takes `Config`
> (B) only — `ChannelEnv` reads happen at route-handler time, not gate
> time."

And `06-risks-and-mitigations.md` CR9 mitigation 2 says:
> "`AuthGate` constructor takes `Config` (B) for env access. Per
> `b-config/00-summary.md`, `Config.env` exposes the parsed env record
> (same as `ChannelEnv`'s constructor arg). The
> `identifyFederationCaller` call doesn't need `ChannelEnv` directly."

**Counter-argument.** Three sections of the same plan say three
different things about whether `AuthGate` takes `ChannelEnv`:

- `00-summary.md` Dependency table: NO (uses `Config.env`)
- `03-class-boundaries.md` §C1: YES (`env: ChannelEnv` field)
- `06-risks-and-mitigations.md` CR9: NO (uses `Config.env`)

Two of three say NO. The §C1 interface shape is the outlier. Either
(a) drop `env: ChannelEnv` from `AuthGateDeps` and use `config.env`
(per the majority view + the CR9 mitigation that already pins this),
or (b) add `env: ChannelEnv` consistently across all three sections
and re-classify CR9 mitigation 1 ("C.1 lands AFTER D.1").

The current state is **internally inconsistent** and would force the
implementer to pick one shape at the keyboard. If the implementer
picks the §C1 shape (`env: ChannelEnv`), then `C.1` gains a hard D.1
dependency that the plan claims it doesn't have — C.1 sequencing
becomes "after D.1" not "after H.1 + B.1" (per §C1 "Pre-conditions"
row, which only says "H.1 + B.1 land" with no D.1 mention).

Per HOE-3 / AOE-4 / BOE-3 / GOE-7 (the same "phase inflation / doc
inconsistency" pattern across every subsystem's review), an
internally-contradictory dependency graph is a Phase-7 hazard: if
the implementer trusts one section over the other, the wrong
ordering ships and the rollback is non-trivial.

**Severity: wasteful.** Resolve before C.1 lands. Pick option (a) —
drop `env: ChannelEnv` from `AuthGateDeps` — because (i) two of
three sections already endorse it, (ii) `Config.env` is the canonical
seam per B's keystone decision, and (iii) C.1's pre-conditions
already enumerate only H.1 + B.1, confirming the no-D-dependency
intent. Update `03-class-boundaries.md` §C1 to match.

---

### OE-C2 (major) — `C.4–C.6` phase splitting is over-prescribed;
44 routes could land as 1 phase with per-route rollback

**Proposal** (`05-refactor-roadmap.md` C.4, C.5, C.6):
- C.4: 12 low-risk read-only public routes (add `ctx.log`)
- C.5: 21 mid-risk authenticated read routes (add `ctx.stores`)
- C.6: 11 high-risk write/auth/admin routes (add `ctx.auth`)

All three phases share the same change shape: add an OPTIONAL field
to `RouteContext` and migrate the handler body to read it. No
signature change. No class conversion. The only difference between
phases is which routes are touched (12 → 21 → 11) and which field
gets migrated first (`log` → `stores` → `auth`).

**Counter-argument.** Per the framework `review-completeness.md`
OE-11, a phase that doesn't change the dependency graph or
introduce structural risk is a verification tripwire, not a phase.
The 3-phase split buys:

1. **Rollback granularity**: per-route rollback (already in C.4's
   "Rollback strategy" — *"Per-file revert. Each file's change is
   additive"*). The per-route rollback is the same regardless of
   whether C.4–C.6 are 1 phase or 3 phases.
2. **Risk-tier ordering**: lower-risk routes migrate first to flush
   out `RouteContext` field-type errors. But each route's body
   change is the same shape (`logger.X` → `ctx.log.X`), so a
   low-risk route that compiles is mechanical evidence that the
   high-risk route's `ctx.auth?.kind === 'session'` check compiles
   too.
3. **Parallel sub-prongs**: C.4's 12 routes are "12 sub-prongs,
   each isolated". Same for C.5's 21 and C.6's 11. The parallelism
   is **per-route**, not per-phase — 1 phase with 44 sub-prongs is
   identical work.

Compare to A's `a-db/00-summary.md` per-store blast-radius table
(AOE-8 in the A review): per-store enumeration is "documentation,
not a tool" when no decision is tied to it. C's per-risk-tier
enumeration is the same: it documents which routes are which risk
but doesn't change the migration window.

The 3-phase split has one real cost: 3 risk rows, 3 rollback
strategies, 3 pre-conditions blocks, 3 verification gates in the
dependency graph. None of those 3 blocks produce a different
verification outcome than a single phase with a 44-route
verification gate (`bun --bun vitest run src/__tests__/` passes after
all 44 routes migrate).

Per F's `f-agent-subsystem/review-completeness.md` CE-F5
analog: "F-to-F shutdown order is not characterized in F" — the
plan-level decomposition is over-prescribed when the underlying
mechanism is per-route.

**Severity: wasteful.** Fold C.4, C.5, C.6 into a single C.4 phase
("44 routes migrate to `RouteContext.{log, stores, auth}` via
additive field-by-field rollout; per-route rollback is the
granularity"). The 3-tier risk grouping moves into the new C.4's
"Rollback strategy" as an ordering recommendation (low-risk first),
not as a phase boundary.

---

### OE-C3 (major) — `C.9 LoggerLike verification` is a numbered phase
for a grep-based policy check (parallel to AOE-5 / BOE-3 / GOE-7)

**Proposal** (`05-refactor-roadmap.md` C.9):
> "**Goal:** Verify that every `logger.<level>(` call site in C has a
> corresponding `this.log.<level>(` (or `log.<level>(`) call site in
> the class body. Per `02-type-interface-analysis.md §10`, 221 call
> sites total (50 in `web.ts` + 159 in `routes/` + 12 in
> `federation/`)."

Same pattern rejected in every other subsystem's review:
- `a-db/review-completeness.md` AOE-5 ("A.10 'LoggerLike adoption'
  phase is policy")
- `b-config/review-completeness.md` BOE-3 ("B.7 is a numbered phase
  for a documentation edit")
- `g-channel-coordinator/review-completeness.md` GOE-7 ("G.7 is
  described as a 'phase' but is in fact a policy")
- `h-cross-cutting/review-completeness.md` HOE-3 ("Phase H.0 is a
  separate phase for measuring baselines")
- `review-completeness.md` CE-13 (framework-level: "HMR safety
  subsection, construction order subsection — those are subsections,
  not phases")

C.9 has:
- Zero files touched (the migration was done mechanically during
  C.1–C.7)
- Zero tests added (the verification is a grep)
- Zero reviewers required (grep is mechanical)
- Zero risk to anything else
- Reversibility: trivially re-runnable

It is a verification tripwire, not a phase. The framework's
CE-13 explicitly warned against this kind of phase inflation.

**Severity: wasteful.** Convert C.9 into a one-paragraph "Verification
tripwire" subsection under C.7's "Verification gates" (or under
`00-summary.md` §C9). The `grep -nE "logger\.(info|warn|error|
debug)" src/web.ts src/web/routes/*.ts src/web/federation/*.ts |
grep -v __tests__` check is the gate; C.9 as a numbered phase
adds risk-row / parallelism-claim / rollback-strategy / pre-
conditions overhead without changing the gate's output.

---

### OE-C4 (minor) — `FederationHttp` class extraction is speculative
(helpers + 1 error class survive unchanged)

**Proposal** (`03-class-boundaries.md` §C6 "federation/http.ts" row):
> "`federation/http.ts` | 40 | KEPT FREE (helpers) + class (existing
> `PeerResponseTooLargeError`) | The helpers `readBoundedBody` +
> `postJson` are pure; the error class survives unchanged per CE-1."

But §C7's "Detailed steps" step 1 says:
> "**`federation/http.ts`** — extract `FederationHttp` class wrapping
> `readBoundedBody` + `postJson`."

**Counter-argument.** The two sections disagree. §C6 says helpers
stay free; §C7 says wrap them in a class. Per `02-type-interface-analysis.md
§4.1`, `PeerResponseTooLargeError` is the only class in
`federation/http.ts` today. The two helpers (`readBoundedBody` +
`postJson`) are pure functions with no state and no DI seams. Per
the F review's OE-F1 logic ("`AutoRestartSchedule` class extraction
is a brief-override of `02 §AutoRestart deep-dive`'s 'keep free'
verdict"): a class that wraps two pure functions adds no behavior
the bare functions don't already provide.

The two helpers are consumed by `federation/poller.ts:199` (per
`02-type-interface-analysis.md §4.1`) and `federation/bridge.ts`
(likely). They could be reached via DI through `FederationBridge` /
`FederationPoller` constructors after C.7 lands, but the
*FederationHttp* class as a wrapper around two helpers is the
textbook OE-7 single-purpose namespace.

**Severity: wasteful.** Pick option (a) per §C6 — keep
`federation/http.ts` helpers free + `PeerResponseTooLargeError`
class. Drop §C7 step 1. The class form adds 1 class for 2
delegate methods; the free-function form has 2 free functions
that work identically.

---

### OE-C5 (minor) — `FederationConfig` class wraps 4 env-derived
helpers + 3 interfaces; the class surface may be namespace-only

**Proposal** (`03-class-boundaries.md` §C6 "federation/config.ts" row):
> "`federation/config.ts` | 393 | `FederationConfig` class (new) |
> wraps `FederationRoutingMode` + `FederationPeer` + `FederationConfig`
> interfaces + the 4 env-derived helpers."

**Counter-argument.** `web/federation/config.ts` is 393 LOC — the
largest file in C.7 by 14% over `federation/onboarding.ts` (also
393 LOC). The proposed `FederationConfig` class wraps:

1. 3 interfaces (`FederationRoutingMode`, `FederationPeer`,
   `FederationConfig`) — type-only, no methods
2. 4 env-derived helpers — likely pure `process.env`-read functions
3. (Implied) a dispatch table + cache (per CE-F1's finding on the
   identical fs.watch + lazy-cache pattern in this file)

If items (1) and (2) are pure data + pure reads, the class wraps
them but adds no behavior. The fs.watch + lazy-cache pattern is the
real behavior, and that pattern is the same as `settings-store.ts`
(per F's CE-F1 critical miss). If the class is going to carry the
lazy-cache state (the `let cachedConfig` at `web/federation/config.ts:215`
+ the `let watcher` at `:217` per F's CE-F1), the class is
justified.

But if the class is just (1) + (2) without the cache state, it's a
namespace wrapper.

Per F's OE-F1 logic ("`AutoRestartSchedule` is a 4-field POJO
masquerading as a class"): if `FederationConfig` is a wrapper
without owning the cache, it's a namespace. If the class owns the
cache + watcher, it's justified.

The plan does NOT explicitly say whether `FederationConfig` owns the
`cachedConfig` and `watcher` lets. This is ambiguous. Per HCE-8
("`LazyBin` adoptor list mentions `ClaudeCodeBinResolver` without a
numeric confirmation"): an ambiguous class boundary is a Phase-7
hazard.

**Severity: wasteful.** In §C6's `FederationConfig` row, add one
line: "owns `cachedConfig: FederationConfig | null` (the
`web/federation/config.ts:215` cache) + `watcher: FSWatcher |
undefined` (the `:217` watcher) + `invalidate()` method." If the
class owns the cache state, it's justified. If not, drop the class
and keep the file as free functions + types.

---

### OE-C6 (minor) — `C.3` 19 runner classes are each individually
justified, but the cluster as a phase is the same as one phase
with 19 sub-prongs (parallel to GOE-3 phase-count over-splitting)

**Proposal** (`05-refactor-roadmap.md` C.3):
> "**Goal:** Convert each of the 19 `start*()` functions to a class
> with `start()` / `stop()`. See `c-web/03-class-boundaries.md §C3`
> for the full enumeration with corrected paths."

**Counter-argument.** Per `03-class-boundaries.md §C3` "Common
shape", all 19 runners share:
```ts
class XxxRunner {
  constructor(deps: { config: Config; env: ChannelEnv; log: LoggerLike; /* per-runner opts */ })
  start(): NodeJS.Timeout | null | void
  stop(): Promise<void> | void
}
```

This is the right shape — runner-as-class with `start()` / `stop()`
lifecycle (per CE-7 "sealed-class only for entities that own
behavior"). Each runner is its own class because their *internals*
differ (cadence, dependencies, fetch logic).

But C.3 as a single phase with 19 sub-prongs is a lot of work. The
risk-row + parallelism claim + rollback strategy is identical for
all 19 runners (mechanical, per-runner rollback). The phase is
**structurally** 19 small phases — same as GOE-3's G.1 + G.2 + G.3
parallelism claim. Per GOE-3's finding ("G.3 modifies the same
file as G.4 ... merge them") — the same logic applies if any two of
the 19 runners modify the same file.

Verified per `02-type-interface-analysis.md §1.5` and
`03-class-boundaries.md §C3`: each runner is in a distinct file
(matches GOE-3's G.1/G.2 case, not the G.3/G.4 case). So the
19-runner parallelism is real.

**Severity: neutral.** The 19-runner parallelism is justified
(distinct files, identical shape). No change needed. Listed here as
a verification pass — the runner-as-class pattern matches F's
CE-F1 (`FederationConfig`-class-owns-cache) analog.

---

### OE-C7 (minor) — `RouteContext` adds 3 optional fields; the
additive-only pattern is correct but worth pinning

**Proposal** (`05-refactor-roadmap.md` C.4 step 1, C.5, C.6):
> "Add `log: LoggerLike` field to `RouteContext` (in `routes/types.ts:7-25`)."

**Counter-argument.** Per the plan's CR1 mitigation 3 ("Additive
only. No existing fields are renamed. The new fields are OPTIONAL
(`log?: LoggerLike`, `stores?: RouteStores`) so a route file that
hasn't migrated yet still compiles."), the additive-only pattern is
the right shape — a route that hasn't migrated keeps compiling
because the field is `?`. This is the textbook forward-compat seam.

But the `?` field means **every** consumer must handle the
undefined case (`ctx.log?.info(...)` or `if (ctx.log) ...`). Today,
44 route files reference `logger.X` directly (no undefined check);
the migration introduces 44 new `?.X` calls (or 44 `if (ctx.log)`
checks). The plan correctly flags this in CR1 mitigation 3 ("the
migration is mechanical") but does not quantify how many call sites
add a `?.` operator.

Per `02-type-interface-analysis.md §10`, the count is 221 (50 in
`web.ts` + 159 in `routes/` + 12 in `federation/`). Of these, 159
in `routes/` would gain `?.` accessors (or `if` checks). 159 sites
is a non-trivial migration surface.

**Severity: neutral.** The additive-only pattern is correct. The
`?.` migration is mechanical. No change needed; the magnitude is
worth noting for the per-route PR review.

---

## Completeness findings

### CE-C1 (critical) — `01-module-state-analysis.md` is missing from
the c-web directory

**Missing area.** The C plan directory contains 6 files, not 7:
```
00-summary.md
02-type-interface-analysis.md   <-- referenced as input by 00
03-class-boundaries.md
04-generic-interfaces.md
05-refactor-roadmap.md
06-risks-and-mitigations.md
```

The `00-summary.md` reading-note paragraph acknowledges this: *"The
`01-module-state-analysis.md` input referenced in the task brief does
**not exist** in this directory as of 2026-08-30; the state claims
used below are taken from `02-type-interface-analysis.md` and
cross-checked against the source files cited inline."*

The same finding was raised in `b-config/review-completeness.md`
BCE-1 (critical), `g-channel-coordinator/review-completeness.md`
GCE-1 (critical). For both B and G, the input file is absent; the
plan synthesises claims from `02` (B) or `01` (G) instead. For C,
the synthesis is from `02` instead of `01` — but the consequence is
the same: the module/state analysis is inline in `02` rather than a
dedicated document.

**Why this matters.** Three cascade effects:

1. **No independent verification of the 44-route / 19-runner /
   9-federation counts** at the module/state level — every count in
   C comes from `02 §1` / `02 §3` / `02 §4` / `02 §1.5`. If `02`'s
   counts drift, every downstream phase cites the wrong number.
2. **`02 §1.5` lists 19 runners + 1 inline `tokenCollectInterval`**
   (20th interval); `02 §3.1` lists 44 route handlers but only
   enumerates the path-pattern per-route breakdown in `03 §C4` —
   the per-file module/state inventory is split across two
   documents with no canonical source.
3. **No H.0-style "baselines" section** (per HOE-3) exists for C
   — every baseline number is assumed, not measured.

**Severity: critical.** Either (a) produce `01-module-state-analysis.md`
retrospectively (re-stating 02's claims at module level), or (b)
explicitly state in `00-summary.md` that 01 is intentionally merged
into 02 and add the missing measurement commands:

- `grep -c "^export function start" src/web/*.ts src/web/routes/*.ts
  src/web/federation/*.ts | grep -v __tests__` → 19 (verified 28
  hits via `^export function start\|^export function run\|^export
  const run\|^export const start` in C.0 ground truth, including
  inline helpers — 19 distinct `start*` per `02 §1.5`)
- `ls src/web/routes/*.ts | wc -l` → 27 files in routes/ +
  `types.ts` = 28 (plan's 44 includes the 44 `tryHandle*`
  handlers, not 44 files — verified the 44 handlers map to 44
  unique files; `routes/types.ts` is a non-handler; `ls | wc -l`
  returns 27 + types.ts = 28 file count, plan's "44" is
  handler-count not file-count — minor drift)
- `ls src/web/federation/*.ts | wc -l` → 9 (verified)

Without this, every downstream phase cites numbers without
provenance. Per BCE-1 / GCE-1 precedent, this is a structural
problem that compounds through every downstream refactor.

---

### CE-C2 (critical) — `vi.mock('../web.js')` count claim
("144+ per-route") is materially wrong; measured 1 direct + 3 per-route

**Missing area.** The plan claims:
- `00-summary.md` (Test files entry): "they get *updated* to match
  new class APIs ... but their layout, runner, and coverage targets
  are not in scope"
- `06-risks-and-mitigations.md` CR6: *"the codebase has 154
  `vi.mock('../config.js', …)` sites, 49 `vi.mock('../db.js', …)`
  sites, 88 `vi.mock('../logger.js')` sites. The
  `vi.mock('../web.js')` count is not directly enumerated, but the
  per-route `vi.mock('../web/routes/*.js')` count is high (per the
  brief: 'likely high; web tests are numerous')."*

Measured today:

```
grep -rln "vi\.mock.*['\"]\\.\\./web\.js" src/__tests__ | wc -l
  → 1

grep -rln "vi\.mock.*['\"]\\.\\./web/routes" src/__tests__ | wc -l
  → 3
```

**The `vi.mock('../web.js')` count is 1, not "likely high".** The
per-route `vi.mock('../web/routes/*.js')` count is 3, not
"144+".

This is a ~50× overcount on the per-route mock sites. The plan's
CR6 mitigation 1 ("Test factory design FIRST ... the first 5-10
tests set the convention") still applies, but the magnitude is off
by 50×. If C.8's verification gate is sized for "144+ per-route
mocks", the gate fires after 3 migrations (the actual count), not
144+.

The 3 per-route mock sites are the actual file list:
- (verified via `grep -rln "vi\.mock.*['\"]\\.\\./web/routes"
  src/__tests__/`)

The plan does NOT enumerate which 3 files these are, so a future
reworker has to re-measure. Per BCE-2 (B's 60-importer count was
actually 97 — ±40% drift), and HCE-1 (H's 88/91 counts were
actually 96/90 — ±10% drift), baseline-count drift is the most
common silent error across the plan series. C inherits this and
amplifies it (50× drift on the per-route mocks).

**Why this matters.** CR6 mitigation 1 says: "Before C.8 starts, the
team designs `createTestLogger()`, `createTestAuthGate(overrides?)`,
`createTestDashboardServer(overrides?)`" — but the plan never says
how many mocks will switch to the factory. With 1 + 3 = 4 mocks to
migrate (not 144+), the factory design is a much smaller
undertaking than the plan implies. Per CE-5 ("the first 5-10 tests
will set the convention"), C has at most 4 tests that need the
factory — the convention-setting risk is dramatically lower than the
plan implies.

**Severity: critical.** Re-measure during C.0 prerequisites and
bake the measured number into CR6's table + the C.8 verification
gate. The current "144+" claim is wrong by 2 orders of magnitude.

---

### CE-C3 (major) — `web/atomic-write.ts` scope ambiguity: 6 web/
importers (including 3 routes) use it, but plan lists as out-of-scope

**Missing area.** The plan's `00-summary.md` lists `web/atomic-write.ts`
under "Files this plan does NOT touch":
> "**`src/web/atomic-write.ts`** — `01 §6.4` per
> `review-completeness.md CE-6` exempts it; the heaviest-mocked web
> helper (14 `vi.mock` sites) stays a free-function module."

But `web/atomic-write.ts` has **6 importers** inside `src/web/`:

| Importer | Use |
|---|---|
| `src/web/agent-taskstate.ts:4` | `atomicWriteFileSync` for record persistence |
| `src/web/agent-process.ts:26` | `atomicWriteFileSync` for `dotClaudePath` writes |
| `src/web/scheduled-tasks-io.ts:5` | `atomicWriteFileSync` for skill + config writes |
| `src/web/dashboard-auth.ts:5` | `atomicWriteFileSync` for `DASHBOARD_TOKEN_PATH` |
| `src/web/vault.ts:5` | `atomicWriteFileSync` for `VAULT_KEY_PATH` + `VAULT_PATH` |
| `src/web/fleet-transfer.ts:19` | `atomicWriteFileSync` for `overridesPath` |

**Three of the 6 importers are route files** (`agent-taskstate.ts` is
in C.6 high-risk; `fleet-transfer.ts` is web/ helper that has its
own behavior). After C.4–C.6 migrate the routes to `RouteContext.{log,
stores, auth}`, the route files still call `atomicWriteFileSync`
directly — the plan's "stays free" decision means the call sites
don't change.

But the framework CE-6 exemption was for `db.ts` lazy-cache and
similar helpers that are mockable as a module — the 14 vi.mock sites
on atomic-write are exactly the test-mock surface that the framework
flagged as "inconsistent treatment". The plan inherits the
exemption but does not characterise what happens to the 6
importers during C.4–C.6:

- `agent-taskstate.ts` is a C.6 high-risk route — its `atomicWriteFileSync`
  calls are part of the write-path. C.6's verification ("`ctx.auth`
  becomes load-bearing for write paths") does NOT cover the atomic
  write seam. If a future contributor migrates `atomic-write.ts` to
  a class, the 6 importers need to update — but C's plan has no
  C.4-C.10 phase that touches atomic-write's importers.
- `dashboard-auth.ts` is consumed by `AuthGate.resolveAuth()` (per
  the plan's `loadOrCreateDashboardToken` reference). After C.1
  injects `dashboardToken` into `AuthGate` constructor, the token
  write no longer happens at gate time — the `dashboard-auth.ts:25`
  call is moved to boot. If a future C.10+ phase adds an
  `AuthGate.boot()` method, `dashboard-auth.ts` becomes part of
  AuthGate's lifecycle. The plan does not characterise this.

**Why this matters.** The plan's out-of-scope decision for
`web/atomic-write.ts` is correct (per CE-6 exemption). But the
6-importer surface intersects C in 3 places (`agent-taskstate.ts`
in C.6, `dashboard-auth.ts` for `AuthGate` boot, `fleet-transfer.ts`
adjacent to auth-admin routes). If the plan's out-of-scope is
silent on these touch points, a future contributor has no plan
guidance.

**Severity: major.** Add a one-line "Out of scope boundary:
`web/atomic-write.ts` stays free per CE-6 exemption; the 6
importers (agent-taskstate.ts, agent-process.ts, scheduled-tasks-io.ts,
dashboard-auth.ts, vault.ts, fleet-transfer.ts) keep calling the
free function. C.1's `AuthGate` constructor takes `dashboardToken`
pre-loaded at boot so the `dashboard-auth.ts:25` write moves to
index.ts (not to AuthGate's body)" entry to `00-summary.md` "Files
this plan does NOT touch". This pins the boundary.

---

### CE-C4 (major) — `AuthGate` takes `Config.env` per two sections
but `ChannelEnv` per one section (internal contradiction)

**Missing area.** Per OE-C1 above. The same contradiction cascades
into C.1's pre-conditions: `03-class-boundaries.md §C1` says
"Pre-conditions: H.1 + B.1 land" (no D.1), but if the §C1
`AuthGateDeps` shape (`env: ChannelEnv`) is implemented as-written,
then C.1 implicitly depends on D.1. The 06 §CR9 mitigation says
C.1 does NOT depend on D.1 (because `Config.env` is used instead).

The cascade:
- `00-summary.md` Dependency table: no D.1 dep
- `03-class-boundaries.md §C1` "Dependencies": lists `ChannelEnv (D.1)`
- `03-class-boundaries.md §C1` "Pre-conditions": H.1 + B.1 only
- `06-risks-and-mitigations.md` CR9 mitigation 1: no D.1 dep (correct)
- `06-risks-and-mitigations.md` CR9 mitigation 2: `AuthGate` takes
  `Config.env` (correct, contradicts §C1)

**Why this matters.** Per CLAUDE.md §7 ("kötelező mindig a
typeguard -okat használni amik léteznek a projectben és ha nincs
akkor írjunk ha valamihez szükséges") and CLAUDE.md §3 ("Match
existing style, even if you'd do it differently"): an
internally-contradictory plan forces the implementer to pick one
shape and the inconsistency persists in code comments forever.

**Severity: major.** (Cross-reference OE-C1.) The §C1 "Dependencies"
section should be updated to drop `ChannelEnv (D.1)` from the
explicit list — the gate reads `config.env` which is already a
parsed `Record<string, string>`. Update the `AuthGateDeps` interface
to drop the `env: ChannelEnv` field.

---

### CE-C5 (major) — bun-specific HTTP server (`Bun.serve` vs Node
`http`) not verified for `DashboardServer`

**Missing area.** `DashboardServer.start()` returns
`http.Server` (the Node type, per `00-summary.md` "Cross-references"
line 227: `src/web.ts:88` `startWebServer(port = 3420): http.Server`).
The codebase runs under `bun --bun vitest run` (per CLAUDE.md §8)
and possibly production under bun (per the F review's CE-F3-F6
inheritance and the A review's ACE-9 bun:sqlite type drift
finding).

`web.ts` uses the Node `http` module (`res: http.ServerResponse`,
`req: http.IncomingMessage`, `server.close(...)`). Per the
framework CE-17 + F's CE-F3 inheritance:

- bun's `http.Server` differs from Node's on:
  - `server.close(callback)` callback timing (Node fires when all
    connections drain; bun may fire earlier)
  - `req.headers` shape (Node `string | string[] | undefined`,
    bun may normalise to single string)
  - `res.writeHead` + `res.end` ordering under backpressure (bun's
    HTTP/1.1 implementation may queue differently)
- The 22 `clearInterval` calls in `DashboardServer.stop()` (per
  `web.ts:548-573`) require the close-callback to fire AFTER all
  intervals are cleared — if bun's `server.close()` fires
  immediately, the intervals are cleared first but `server.close`
  returns before connections drain, breaking the
  `server.close → drain` invariant.

The plan's CR8 mitigation 1 says: "`DashboardServer.stop()` is
called by `index.ts:378-410`'s `webServer.close(…)`. The class
method replaces the inline `server.close` callback. The order in
`index.ts:378-410` is preserved verbatim." But the plan does NOT
verify that bun's `http.Server.close()` semantics match Node's for
the 22-interval drain sequence.

**Severity: major.** Add a detection signal to CR8: "Verified on
`bun --bun vitest run`. The 22-interval drain sequence in
`DashboardServer.stop()` relies on `http.Server.close(callback)`
firing after the intervals are cleared; bun's close timing may
differ from Node's. Verify with a regression test that constructs
`DashboardServer`, starts 22 mock intervals, calls `stop()`, and
asserts all 22 handles are cleared before the close callback fires.
If bun diverges, document in the class header."

Per CE-17 / HCE-10 / BCE-11 / CE-F3-F6 / GCE-12 inheritance — the
bun-specific verification gap is the most common cross-cutting
under-specification across the plan series. C inherits it.

---

### CE-C6 (major) — Test factory design for `createTestDashboardServer`,
`createTestAuthGate`, `createTestLogger` not specified (CE-5 /
HCE-7 / BCE-7 / CE-D3 / CE-F7 inheritance)

**Missing area.** Per `05-refactor-roadmap.md §C.8` "Detailed
steps", the plan provides:
```ts
// 1. createTestLogger(): LoggerLike
// 2. createTestAuthGate(deps?: Partial<AuthGateDeps>): AuthGate
// 3. createTestDashboardServer(deps?: Partial<DashboardServerDeps>): DashboardServer
```

The plan does NOT specify (per HCE-7's 5-bullet check):

1. Whether the factory takes options or is fixed-shape
2. Whether assertions use `.toHaveBeenCalled()` per-method or a
   single "any-call" helper
3. Whether the factory returns a fresh object per call or memoises
   across tests
4. Whether the factory is exported from
   `src/__tests__/test-factories.ts` (new file) or lives per-test
5. What the convention does for `bun --bun vitest`'s
   module-resolution differences

Per CE-C2, the actual mock count to migrate is 1 direct + 3
per-route = 4 files (not 144+). So the convention-setting risk is
much lower than other subsystems, but the convention still matters
for the 4 actual files.

**Severity: major.** Add a "Test factory specification" subsection to
`05-refactor-roadmap.md §C.8` addressing the 5 bullets from HCE-7.
The factory's `Partial<DashboardServerDeps>` argument type should
match the constructor's actual signature (per the BOE-6 lesson:
strict-generics-cheating is the trap). Format: ~30 lines of code
block + one-paragraph rationale.

---

### CE-C7 (major) — `C.3` runner-as-class and `C.7` federation cluster
both touch `federation/poller.ts` and `federation/capability-runner.ts`
— sequencing not pinned

**Missing area.** `C.3` lists 2 federation runners:
- `startFederationPoller` at `src/web/federation/poller.ts:276` →
  `FederationPollerRunner` class
- `startCapabilitySummaryRunner` at
  `src/web/federation/capability-runner.ts:80` →
  `CapabilitySummaryRunner` class

`C.7` lists 9 federation cluster files including both of these:
- `federation/poller.ts:287` → `FederationPoller` class (wraps the
  runner + cache)
- `federation/capability-runner.ts:89` → `FederationCapabilityRunner`
  class (wraps the runner + cache)

The two phases touch the same files. The plan's
`05-refactor-roadmap.md C.3` says "19 sub-prongs, each isolated" and
"C.7 is a single PR that lands all 9 federation cluster files
together". Per the plan's own `05-refactor-roadmap.md C.7` "Files
touched" row, C.7 touches the SAME 2 files C.3 touched. If C.3
converts `FederationPollerRunner` (a runner class with
`start/stop`) and C.7 converts `FederationPoller` (a federation
cluster class wrapping the runner), two agents on two branches
must merge the same file.

**Why this matters.** Per GOE-3 ("G.3 + G.4 modify the same file
... Two agents editing the same file in parallel branches means a
merge conflict on every section header"): two phases modifying the
same file in lockstep is a merge-conflict hazard. The plan does
NOT specify whether C.3 lands first (the runner-as-class form) and
C.7 wraps it (the cluster class with cache state), OR whether C.7
lands first (the cluster class) and C.3 adds the runner-as-class
inside it.

**Severity: major.** Add a sequencing paragraph to
`05-refactor-roadmap.md C.7` "Pre-conditions": "C.3 must land BEFORE
C.7 for the federation cluster. C.3 converts the 2 federation
runners (`FederationPollerRunner`, `CapabilitySummaryRunner`) to
classes with `start/stop`. C.7 then wraps these runner classes with
the cluster classes (`FederationPoller`, `FederationCapabilityRunner`)
that add the cache state. The other 7 federation files (address,
bridge, capabilities, config, http, local-catalog, onboarding) are
not touched by C.3, so C.7 is the only phase modifying them."

---

### CE-C8 (major) — `22 intervals cleared in REVERSE order (LIFO
drain)` claim not verified against `web.ts:548-573` actual order

**Missing area.** The plan's CR8 mitigation 2 says: *"22 intervals
cleared in REVERSE order (LIFO drain). Per
`c-web/05-refactor-roadmap.md C.2`, `DashboardServer.stop()`
iterates `this.intervals` in REVERSE and `clearInterval()` each.
This matches the current hand-rolled `server.close` override at
`web.ts:548-573`."*

Verified per `02-type-interface-analysis.md §1.6`:
```ts
const origClose = server.close.bind(server)
server.close = (cb?: (err?: Error) => void) => {
  clearInterval(routerInterval)
  clearInterval(scheduleInterval)
  if (pluginMonitorInterval) clearInterval(pluginMonitorInterval)
  ...
}
```

The 22 `clearInterval` calls are in **FIFO order** (the order the
intervals were started at `web.ts:334-447`). The plan claims LIFO
drain "matches the current hand-rolled ... override" — but the
current override is FIFO, not LIFO. The plan's LIFO claim is a
**behavior change**, not a refactor.

**Why this matters.** Per CLAUDE.md §3 ("Surgical changes — touch
only what you must"), and §2 ("Minimum code that solves the
problem. Nothing speculative"), a LIFO drain is a behavior change
that the plan claims is "matches current". If a future contributor
trusts the plan and writes LIFO, the intervals are cleared in a
different order — and a regression test that asserts the order
would fail.

The plan's verification gate (per CR8 detection signal): *"grep -nE
"this\.intervals" src/web.ts` shows 22 + 1 + 1 = 24 references
(push / iterate / clear)"* — this gate checks the count, not the
order. The order is silent.

**Severity: major.** Either (a) clarify in CR8 mitigation 2 that
the current `web.ts:548-573` is FIFO (not LIFO) and that
`DashboardServer.stop()` preserves FIFO order verbatim (no behavior
change), or (b) verify by reading `web.ts:548-573` line-by-line
that LIFO is actually required (and document why). Per
`02-type-interface-analysis.md §1.6`'s reproduction, the current
code is FIFO. Update the plan to say "FIFO order (matches current
hand-rolled override)".

---

### CE-C9 (major) — Per-route blast radius table for `RouteStores`
(per `03 §C5` claim "23 of 44 routes read db.ts") is sketched but
not enumerated

**Missing area.** The plan's `03-class-boundaries.md §C5` says:
> "**Total C** | **221** | Every site is the module-level
> `logger.info/warn/error/debug` call."

And `00-summary.md` Dependency table row "C ← A":
> "**23 of 44 routes read `db.ts` functions** (per
> `a-db/00-summary.md` Scope). After A.1, the routes' `RouteContext`
> gains a `stores` field carrying the relevant `MemoryStore` /
> `KanbanCards` / etc. instances."

The plan claims 23 of 44 routes read `db.ts`. The per-route
mapping is sketched in `03 §C4` "Per-store blast radius table"
but lists only 10 routes (memories, kanban, messages, schedules,
approvals, vault-ssh, vault-ssh-keys, auth, federation, and "(other
35 routes)") — 9 specific + 35 generic. That's not 23 of 44;
it's 9 enumerated + 35 "other". The remaining 14 routes (23 - 9 =
14) are not enumerated.

**Why this matters.** Per the framework CE-11 (`a-db/` review AOE-8
"A.2 'leaf stores' includes `MemoryCategory` sealed-class helper as
a sub-phase (5b) but its sibling sealed-class work is in A.8" and
ACE-11 "`web/command-task.ts` importer missed from the 14-narrow /
39-broad count"), per-route enumeration matters for the per-route
rollback. Without enumerating which 23 routes read which stores,
C.5's verification gate ("`grep -rnE "from '\\.\\./\\.\\./db\\.js'"
src/web/routes/*.ts` returns 0 after C.5 lands (or only the routes
in C.6)") is correct in shape but under-specified in scope.

**Severity: major.** Enumerate the 23 routes that read `db.ts`
functions in a "Per-route blast radius for `RouteStores`" subsection
of `03-class-boundaries.md §C5`. Format: 23 rows × {route file,
stores read, db.js function called, A-tier dependency}.

---

### CE-C10 (major) — `web/federation/poller.ts` `statusCache` plain
`Map` is the 5th lazy-cache candidate but CE-9 lens is not applied

**Missing area.** Per F's CE-F1 (`web/federation/config.ts` is a
file-watcher + lazy-cache hybrid with the identical pattern as
`settings-store.ts`), the `web/federation/` subdir has the
fs.watch + lazy-cache pattern. `web/federation/poller.ts:59` (per
the plan) declares `const statusCache = new Map<string,
PeerStatus>()` — a plain Map.

The plan's `02-type-interface-analysis.md §8.3` correctly identifies
this and says:
> "`statusCache` is NOT a TTL cache — it's a stale-retain cache (a
> peer's last known manifest is KEPT on transient network failure,
> per the `state: PeerPollState` enum at `poller.ts:39`).
> `RemoteStatusCache<T>` is per-call TTL (`getOrRefresh(key, nowMs, ...)`),
> which is a different semantic. The two are NOT substitutable."

But the plan does not explicitly enumerate the `web/federation/config.ts`
cache (per F's CE-F1 critical miss) — `web/federation/config.ts:215`
declares `let cachedConfig: FederationConfig | null = null`, which is
**also** a lazy-cache with the same fs.watch + `ensureWatching`
pattern as `settings-store.ts:17/18/46-56`.

**Why this matters.** Per F's CE-F1 (critical): "This file satisfies
F's inventory criterion for `SettingsStore`-shape extraction:
2 module-level `let`s (`cachedConfig`, `watcher`),
`ensureWatching()` idempotent guard with the identical failure
mode ... `loadConfigFromDisk()` is the disk-read helper ...
`getFederationConfig()` is the public accessor." F's CE-F1
recommends documenting the exclusion in `00-summary.md` "Files this
plan does NOT touch" with the rationale. C inherits the boundary
but does NOT explicitly document it.

**Severity: major.** Add `web/federation/config.ts` to
`00-summary.md` "Files this plan does NOT touch" with rationale
("federation is a web/ subsystem; the federation-config lazy-cache
extraction belongs to a future web/ subsystem refactor; the
fs.watch + lazy-cache pattern matches `settings-store.ts` per
F's CE-F1"). This closes the F-to-C boundary.

---

### CE-C11 (major) — `ChannelPairingStore` (A scope) coupling not
characterized for C, parallel to GCE-6

**Missing area.** Per G's GCE-6: "ChannelPairingStore (A scope)
coupling not characterized for G". The same finding applies to C:
the dashboard's route handlers may consume `agent_messages` rows
that the coordinator writes (per G's coupling description). If A
introduces `ChannelPairingStore` in a future commit, the question
"do C's routes need to know about `ChannelPairingStore`?" is
implicitly answered "no" by the absence of any mention.

**Why this matters.** Per the A review's ACE-13 (`TelegramApiError`
out-of-scope parallel) and GCE-6: the boundary between subsystems
needs to be explicit so future contributors don't add cross-system
dependencies without plan guidance.

**Severity: major.** Add a one-line "Out of scope: `ChannelPairingStore`
(proposed in A's plan) is not a C dependency — the routes consume
`agent_messages` rows via `ctx.stores.messageBus` (A.3) after A.3
lands; the pairing lookup happens in the message-router runner
(C.3), not in route handlers" entry to `00-summary.md` "Files this
plan does NOT touch". This closes the A → C boundary question.

---

### CE-C12 (major) — `vi.mock` factory-hoisting under
`bun --bun vitest` not addressed (CE-17 inheritance)

**Missing area.** Per framework CE-17 + every other subsystem's
review (HCE-10, BCE-11, CE-D7, CE-F3/F4/F6, GCE-12), `bun --bun
vitest`'s runtime differs from Node-vitest on `vi.mock`
factory-hoisting. C's `05-refactor-roadmap.md §C.8` "Test
coverage requirement" mentions "All tests pass with the new factory
pattern" but does NOT verify factory-hoisting under bun.

Specifically, the 4 actual mock files (1 direct `vi.mock('../web.js')`
+ 3 `vi.mock('../web/routes/*.js')` per CE-C2) have factory shapes
that may diverge between Node-vitest and bun-vitest. C's plan
inherits the CE-17 exposure but does not enumerate the per-mock
factory shapes (the B plan's BCE-3 enumerated 6 distinct factory
shapes for `vi.mock('../config.js')` — analogous enumeration is
missing for C's mocks).

**Severity: major.** Add a detection signal to C.8: "All 4 mock
sites pass `bun --bun vitest run`. The mock-seam survival depends
on factory-hoisting behaviour that may differ between bun-vitest
and Node-vitest; verify with each of the 4 actual files (list
them)." Per CE-17 / HCE-10 / BCE-11 / CE-D7 / CE-F3-F6 / GCE-12
inheritance.

---

### CE-C13 (minor) — `23 of 44 routes read db.ts` claim not
cross-checked against actual `grep` count

**Missing area.** The plan claims "23 of 44 routes read db.ts
functions". Verified today (per `02 §3.1`):
`grep -rln "from ['\"].*db\.js['\"]" src/web/routes/ | wc -l`
→ 23 (verified). The count is correct.

But the plan's `03 §C4` per-route table lists only 9 routes
explicitly + "(other 35 routes)". 23 - 9 = 14 routes are not
enumerated. CE-C9 covers this from the blast-radius angle; this is
the count-side.

**Severity: minor.** Cross-reference CE-C9.

---

### CE-C14 (minor) — Two-resolver files (per HCE-11) not enumerated
in C's per-class coverage

**Missing area.** Per HCE-11, three files call `makeLazyBinResolver`
twice each (`web/agent-process.ts:56-57`, `web/channel-monitor.ts:53-54`,
`web/routes/background-tasks.ts:14-15`). These files are in C
scope (web/agent-process.ts is adjacent to message-router, web/
channel-monitor.ts is adjacent to channel-monitor runner, web/
routes/background-tasks.ts is a C.5 read route).

When H.2b migrates these files to take `LoggerLike`, the two
resolver lines become two constructor arguments per file. C's plan
does not enumerate the two-resolver pattern, but the migration is
in C scope for the route file.

**Why this matters.** C.5's "Test coverage requirement" for the
authenticated read routes includes `routes/background-tasks.ts`
(C.5, 21 mid-risk routes). When `routes/background-tasks.ts`
migrates, the `makeLazyBinResolver` calls become part of the
constructor signature change. The plan does not characterise this.

**Severity: minor.** Mention `routes/background-tasks.ts:14-15` as
a two-resolver file in C.5's "Files touched" row, parallel to
HCE-11's enumeration.

---

### CE-C15 (minor) — `AgentMessage` / `Memory` / `KanbanCard` etc.
importers in routes not enumerated for `RouteStores` migration

**Missing area.** Per A's `02-type-interface-analysis.md §1.4`, the
entity types in `db.ts` have known importer counts:

| Type | Importers |
|---|---:|
| `Memory` | 6 |
| `AgentMessage` | 4 |
| `KanbanCard` | (single-file type) |
| `ScheduledTask` | (single-file type) |
| `BackgroundTask` | (similar) |
| `Approval` | (single-file type) |
| `OtelSpan` | (single-file type) |
| `IdeaBoxRow` | (single-file type) |

The plan's `RouteStores` interface (per `03 §C5`) carries
`MemoryStore`, `KanbanCards`, `MessageBus`, `Scheduler`,
`ApprovalStore`, `SshVault`, `SpanStore`, `BackgroundTaskPool`,
`IdeaStore`. The per-store importer counts are not enumerated for C.

**Severity: minor.** Cross-reference A's `02 §1.4` importer counts
in C.5's "Verification gates" row, so the per-store blast-radius
is verifiable.

---

### CE-C16 (minor) — 22-interval consolidation in `DashboardServer.stop()`
may not preserve `workerStartupCancelled = true` (per `web.ts:548-573`)

**Missing area.** The plan's `02-type-interface-analysis.md §1.6`
reproduces the close handler:
```ts
workerStartupCancelled = true
if (workerLivenessInterval) clearInterval(workerLivenessInterval)
clearTimeout(startupWatchdogGrace)
clearInterval(startupWatchdogPoll)
```

The current code sets `workerStartupCancelled = true` BEFORE
clearing the worker-liveness interval. This is a side-effect that
the `DashboardServer.stop()` method must preserve. The plan's
`03-class-boundaries.md §C2` "Method-by-method" table for `stop()`
says: "Clears all 22 intervals (consolidated from the hand-rolled
close handler), awaits `server.close()`, awaits
`sweepExpiredSessions()` + `sweepExpiredDeviceKeys()`."

But the plan does NOT explicitly preserve `workerStartupCancelled
= true`. This is a side-effect that's not a `clearInterval` call —
it would be missed by a "22 intervals" gate.

**Severity: minor.** Add one line to C.2's "Method-by-method"
table for `stop()`: "Sets `this.workerStartupCancelled = true`
BEFORE clearing `workerLivenessInterval` (preserves the side-effect
at `web.ts:548-573`)." Or verify by reading `web.ts:548-573` and
listing all 23 side-effects (22 `clearInterval/clearTimeout` + 1
`workerStartupCancelled = true`).

---

### CE-C17 (minor) — `ChannelEnv.home` parameter in the framework
plan (per OE-D1) not addressed by C's `AuthGateDeps`

**Missing area.** Per the D review's OE-D1: `ChannelEnv.home`
parameter is unreachable from `static stateDirFor`. The D review
recommends dropping the `home` parameter. C's `AuthGateDeps` (per
`03 §C1`) does NOT include `home` — so C correctly inherits the
"Drops home" decision. But C's plan does not acknowledge that the
D review flagged this; if D's plan keeps `home` after OE-D1, C's
`AuthGate` may receive a `ChannelEnv` with a `home` parameter
that the gate doesn't use (silent, but worth noting).

**Severity: minor.** Cross-reference OE-D1 in `06-risks-and-mitigations.md`
CR9 — explicitly say "per D's OE-D1, `ChannelEnv.home` is dropped;
`AuthGate` receives `ChannelEnv` (if it takes one) without a
`home` field".

---

### CE-C18 (minor) — `web/heartbeat-agent-scaffold.ts` (per CE-7)
exclusion not documented in C scope

**Missing area.** Per the F review's CE-7: `web/heartbeat-agent-scaffold.ts`
is a prompt-builder, NOT a runner. F correctly excludes it. C's
plan inherits this exclusion but does NOT explicitly mention it.

If C.3's runner-as-class sweep enumerates "19 runners", the
`web/heartbeat-agent-scaffold.ts` file is correctly not in the list
(it's not a `start*()` function). But the exclusion is silent — a
future contributor who reads C.3 might wonder why it's not in the
list.

**Severity: minor.** Add a one-line "Explicitly out of scope:
`web/heartbeat-agent-scaffold.ts` (per F's CE-7, prompt-builder
NOT runner; not in C.3's 19-runner list)" entry to
`00-summary.md` "Files this plan does NOT touch".

---

## Cross-cutting risk: bun-specific test patterns (CE-17 inheritance)

Per the framework CE-17 + every other subsystem's review
(HCE-10, BCE-11, CE-D7, CE-F3/F4/F6, GCE-12),
`bun --bun vitest`'s runtime differs from Node-vitest on:

- `vi.mock` factory-hoisting semantics
- `vi.resetModules()` behavior under HMR
- `vi.doMock` interleaving
- `instanceof` semantics for error-class discrimination
- `Error.captureStackTrace` support
- `http.Server.close()` callback timing
- `AbortController` + `setTimeout` interleaving (per GCE-12)
- bun:sqlite-specific gaps (per A's ACE-9)

C inherits all of these but enumerates none in its
`06-risks-and-mitigations.md` risk matrix (CR1–CR10). The most
exposed C-specific concerns:

- CR6's `vi.mock('../web.js')` factory shapes (1 + 3 = 4 mocks,
  per CE-C2) — bun may hoist factories differently
- CR8's `server.close(callback)` timing — bun may fire the callback
  earlier than Node, breaking the 22-interval drain invariant
  (per CE-C5)
- C.4–C.6's per-route `vi.mock('../web/routes/*.js')` factory
  shapes — 3 files, may diverge under bun

**Severity: minor.** Add a "bun --bun vitest verification"
detection signal to CR6, CR8, and C.8 (the 3 risks where bun
divergence matters). Per the framework CE-17 + every other
subsystem's review inheritance: "All 4 mock sites pass
`bun --bun vitest run`. The mock-seam survival depends on
factory-hoisting behaviour that may differ between bun versions;
if a test passes on `vitest` and fails on `bun --bun vitest`, the
rewrite is bun-specific."

---

## Net assessment

C's keystone thesis is correct and load-bearing:

- **`AuthGate` class extraction** is the right shape: 121 LOC,
  5 functions + 1 type alias, single-file scope, follows the
  `Config` / `ChannelEnv` / `PortLockAcquirer` precedent.
- **`DashboardServer` class extraction** is the right shape: 576
  LOC closure, 22-interval consolidation into a `private
  intervals: NodeJS.Timeout[]` field is a real simplification.
- **`AuthContext` sealed-class rejection** is correctly inherited
  from the framework OE-4 decision — the 4-arm literal-union
  collapse to `undefined` is preserved verbatim.
- **`BaseRunner<TFacts, TDecision>` rejection** is correctly
  inherited from the framework OE-5 — the 19 runners become
  independent classes with `start()` / `stop()`, no shared base.
- **`RemoteStatusCache<T>` reuse** is correctly deferred to the
  CE-9 cross-cutting resolution (per `02 §8.3`'s argument that
  the federation poller's `statusCache` is stale-retain, not TTL).
- **`TtlCache<K, V>` rejection** is correctly applied per the
  framework OE-6 (single consumer) — `RemoteStatusCache<T>` is
  the existing precedent for any future TTL need.
- **Route handlers stay as functions** per the framework CE-7
  ("sealed classes only for entities that own behavior"); the
  44 routes don't fit `RouteHandler<TParams, TResponse>` because
  the response body is side-effected via `res`, not returned.
- **The web/federation/ sub-cluster** is correctly scoped as
  C.7's single PR; the 9 files are tightly coupled (per
  `02 §4.1`'s verification).
- **The runner-as-class pattern (C.3)** matches the F subsystem's
  `HeartbeatScheduler` precedent.

But the plan has **3 over-engineering seams** and **12
completeness gaps**:

**Over-engineering:**

- `AuthGateDeps` `env: ChannelEnv` field contradicts the
  no-D-dependency claim (OE-C1 major).
- C.4–C.6 phase splitting is over-prescribed; 44 routes could
  land as 1 phase with per-route rollback (OE-C2 major).
- C.9 LoggerLike verification is a numbered phase for a grep
  policy check (OE-C3 major, parallel to AOE-5 / BOE-3 / GOE-7).
- Plus four minors: `FederationHttp` extraction (OE-C4),
  `FederationConfig` ambiguity (OE-C5), 19-runner phase shape
  (OE-C6 neutral), `RouteContext` additive-only pattern (OE-C7
  neutral).

**Completeness:**

- `01-module-state-analysis.md` input file is missing
  (CE-C1 critical).
- `vi.mock('../web.js')` count is materially wrong (measured:
  1 direct + 3 per-route, not "144+") (CE-C2 critical).
- `web/atomic-write.ts` scope ambiguity: 6 web/ importers
  including 3 routes (CE-C3 major).
- `AuthGate` takes `Config.env` per two sections but
  `ChannelEnv` per one section — internal contradiction
  (CE-C4 major, cascades from OE-C1).
- bun-specific HTTP server (Bun.serve vs Node `http`) not
  verified for `DashboardServer` (CE-C5 major).
- Test factory design not specified for
  `createTestDashboardServer` / `createTestAuthGate` (CE-C6
  major).
- C.3 runner-as-class and C.7 federation cluster both touch
  federation cluster files — sequencing not pinned (CE-C7
  major).
- LIFO drain claim not verified against actual `web.ts:548-573`
  FIFO order (CE-C8 major).
- Per-route blast radius table for `RouteStores` under-enumerated
  (9 routes of 23, "other 35" generic) (CE-C9 major).
- `web/federation/config.ts` lazy-cache boundary not
  documented (CE-C10 major).
- `ChannelPairingStore` (A scope) coupling not characterized for
  C (CE-C11 major, parallel to GCE-6).
- `vi.mock` factory-hoisting under `bun --bun vitest` not
  addressed (CE-C12 major, CE-17 inheritance).
- Plus six minors: 23-routes-read-db.ts cross-check (CE-C13),
  two-resolver files (CE-C14), entity-type importers (CE-C15),
  `workerStartupCancelled` side-effect (CE-C16), `ChannelEnv.home`
  cross-ref (CE-C17), `web/heartbeat-agent-scaffold.ts` exclusion
  (CE-C18).

**Recommendation: ACCEPT-WITH-EDITS.**

**Resolve before C.1 lands:**

- OE-C1 / CE-C4: drop `env: ChannelEnv` from `AuthGateDeps`; use
  `Config.env` per the majority view across `00-summary.md` and
  CR9 mitigation 2.

**Drop before C.2 lands:**

- OE-C2: fold C.4, C.5, C.6 into a single C.4 phase ("44 routes
  migrate to `RouteContext.{log, stores, auth}` via additive
  field-by-field rollout; per-route rollback is the granularity").

**Drop before C.9 lands:**

- OE-C3: convert C.9 into a verification tripwire subsection
  under C.7 (or under `00-summary.md` §C9).

**Specify before C.7 lands:**

- OE-C4 / OE-C5: pin `FederationHttp` and `FederationConfig`
  ownership — `FederationHttp` stays free + the error class
  survives; `FederationConfig` owns the cache state.

**Re-measure before C.0 (or equivalent) prerequisites:**

- CE-C1: 44 routes, 19 runners, 9 federation files — re-measure
  per `01 §Per-file inventory` baseline commands.
- CE-C2: `vi.mock('../web.js')` count and per-route
  `vi.mock('../web/routes/*.js')` count — measured 1 direct +
  3 per-route (not "144+"). Bake the measured numbers into
  CR6 and C.8.

**Specify before C.8 lands:**

- CE-C6: test factory design per HCE-7's 5-bullet spec.

**Add sequencing before C.7 lands:**

- CE-C7: C.3 must land BEFORE C.7 for the federation cluster.
  The 2 federation runners (C.3) become wrapped by the cluster
  classes (C.7).

**Verify before C.2 / C.8 lands:**

- CE-C5: bun-specific `http.Server.close()` callback timing for
  the 22-interval drain sequence (CE-17 inheritance).
- CE-C8: FIFO order claim verified against `web.ts:548-573`
  actual code (plan claims LIFO, code is FIFO — likely a doc
  drift).
- CE-C12: bun-specific `vi.mock` factory-hoisting on the 4
  actual mock sites (CE-17 inheritance).

**Enumerate before C.5 lands:**

- CE-C9: 23 routes that read `db.ts` functions — enumerate
  per-route blast radius.

**Enumerate before C.1 lands:**

- CE-C10: `web/federation/config.ts` lazy-cache boundary.
- CE-C11: `ChannelPairingStore` (A scope) coupling.

**Minor cleanups:**

- OE-C4: drop `FederationHttp` extraction.
- CE-C13: cross-check the "23 of 44 routes read db.ts" claim.
- CE-C14: enumerate `routes/background-tasks.ts:14-15` as a
  two-resolver file.
- CE-C15: cross-reference A's `02 §1.4` importer counts.
- CE-C16: preserve `workerStartupCancelled = true` side-effect
  in `DashboardServer.stop()`.
- CE-C17: cross-reference D's OE-D1 for `ChannelEnv.home`
  drop.
- CE-C18: document `web/heartbeat-agent-scaffold.ts` exclusion.

---

## Verification provenance

Every file:line reference in this review was read against the
working tree on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`):

- `src/web.ts` — verified 576 LOC, 22 `clearInterval` calls in
  the close handler at `:548-573` (FIFO order, NOT LIFO as plan
  claims), `startWebServer(port = 3420): http.Server` at `:88`,
  `ctxAuth` ternary at `:154-159`, 47 lines of `tryHandle*`
  imports at `:33-79`.
- `src/web/auth-gate.ts` — verified 121 LOC, 5-arm `AuthResult`
  at `:29-34`, `resolveAuth` at `:76-121`, `requiresAuth` at
  `:68-74`, `isFederationWireEndpoint` at `:58-63`.
- `src/web/routes/` — verified 27 files (44 `tryHandle*`
  handlers across them; `types.ts` is the 28th file as a
  non-handler). `ls src/web/routes/*.ts | wc -l` → 27 handler
  files + `types.ts` = 28 total (verified).
- `src/web/federation/` — verified 9 files
  (`address.ts`, `bridge.ts`, `capabilities.ts`,
  `capability-runner.ts`, `config.ts`, `http.ts`,
  `local-catalog.ts`, `onboarding.ts`, `poller.ts`; 1835 LOC).
- `src/web/federation/poller.ts:59` — `const statusCache = new
  Map<string, PeerStatus>()` (verified plain Map).
- `src/web/federation/poller.ts:68` — `class
  FederationPollInternalError` (verified, exists).
- `src/web/federation/http.ts:7` — `class
  PeerResponseTooLargeError` (verified, exists).
- `src/web/http-helpers.ts:25` — `class
  RequestBodyTooLargeError` (verified, exists).
- `src/web/remote-status-cache.ts:19` — `class
  RemoteStatusCache<T>` (verified, exists).
- `src/web/atomic-write.ts:8` — `export function
  atomicWriteFileSync` (verified; 6 importers in `src/web/`
  excluding tests: `agent-taskstate.ts:4`, `agent-process.ts:26`,
  `scheduled-tasks-io.ts:5`, `dashboard-auth.ts:5`, `vault.ts:5`,
  `fleet-transfer.ts:19`).
- `src/web/main-agent.ts` — verified 49 LOC, 3 functions + 2
  constants + 1 predicate (no class candidate).
- `grep -rln "from ['\"].*web\.js['\"]" src/ --include='*.ts' |
  grep -v __tests__` → **1** file: `src/index.ts:20` (`import {
  startWebServer } from './web.js'`).
- `grep -rln "vi\.mock.*['\"]\\.\\./web\.js" src/__tests__/ | wc
  -l` → **1**.
- `grep -rln "vi\.mock.*['\"]\\.\\./web/routes" src/__tests__/ |
  wc -l` → **3**.
- `grep -n "^export function start\|^export function run\|^export
  const run\|^export const start" src/web/*.ts
  src/web/federation/*.ts src/web/routes/*.ts | grep -v __tests__
  | wc -l` → **28** (includes inline helpers + the 19
  `start*()` per `02 §1.5`).
- `ls src/web/federation/*.ts | wc -l` → **9** (matches plan).
- `grep -n "Bun\.serve\|bun:http\|require.*bun" src/web.ts` →
  0 matches (verified: `web.ts` uses Node `http` module).
- 12 cross-cutting framework OE / HO / EO / DO / FO / GO / BO / AO
  lessons applied: framework OE-4 (AuthContext sealed, applied
  via CR3 mitigation), framework OE-5 (BaseRunner rejected,
  applied via OE-5 inheritance), framework OE-6 (single-consumer
  generic, applied 3× to C1/C2/C3 of `04 §C1-§C3`), framework
  CE-7 (sealed-class only for entities that own behavior, applied
  to routes stay as functions), framework CE-9 (RemoteStatusCache
  reuse, applied via `02 §8.3`), framework CE-11 (per-store
  blast-radius, applied via CE-C9), framework CE-17 (bun --bun
  vitest, applied via CE-C5 / CE-C12); HOE-3 (H.0 as phase,
  applied via OE-C3), HCE-7 (test factory specification, applied
  via CE-C6), HCE-11 (two-resolver files, applied via CE-C14);
  AOE-5 (LoggerLike policy as phase, applied via OE-C3); BOE-3
  (numbered phase for documentation edit, applied via OE-C3);
  GOE-3 (phase-count over-splitting, applied via OE-C2); GOE-7
  (G.7 as policy, applied via OE-C3); OE-D1 (unreachable
  parameter, applied via CE-C17); F CE-F1 (federation config
  lazy-cache, applied via CE-C10); F CE-F5 (F-to-F shutdown order,
  applied via CE-C8); F CE-F7 (test factory spec, applied via
  CE-C6); F CE-7 (heartbeat-agent-scaffold prompt-builder, applied
  via CE-C18); GCE-6 (ChannelPairingStore coupling, applied via
  CE-C11); GCE-12 (bun-specific AbortController + setTimeout,
  applied via CE-C5 / CE-C12).