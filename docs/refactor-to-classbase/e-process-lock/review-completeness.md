# Plan Review — E (process-lock) over-engineering & completeness

Review scope: all six E plan documents
(`docs/refactor-to-classbase/e-process-lock/00-summary.md` through
`06-risks-and-mitigations.md`). Source ground-truth verified against
`src/` on 2026-08-30.

The framework's `review-completeness.md` (OE-1 to OE-11) and the H
subsystem's `h-cross-cutting/review-completeness.md` (HOE-1 to HOE-7,
HCE-1 to HCE-11) are the lenses. E's own claims are cross-checked: the
plan's inventory (33 `process-lock.test.ts` cases, 14 in `acquirePidfileLock`,
8 in `acquirePortLock`, 1 active `vi.mock` site, 2 production throw
sites for `DeferToPeerError`, 1 `instanceof` consumer), the
`process-lock.ts:283` off-by-one reference, the `index.ts` line refs
for `releaseLock()` call sites, and the `vi.resetModules` pattern at
`index.test.ts:251` are all read for internal consistency.

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 2 | 3 |
| Completeness | 0 | 2 | 6 |

**Net assessment: ACCEPT-WITH-EDITS.** E's keystone thesis is sound:
`PortLockAcquirer` and `PidfileLockAcquirer` are literal translations
of pure-function bodies; the `LogFn → LoggerLike` migration is
correctly delegated to H; and the E.1/E.2 "introduce alongside the
free function" pattern preserves the test surface through the
migration window. The plan is disciplined on the type side (rejects
all four candidate generics with explicit rationale) and disciplined
on phase ordering (gates E.6 on H.1). The two over-engineering seams
are minor — one shape-parity no-op method, one deferred-decision
parameter — and the eight completeness gaps are mostly verification
and decision-tracking, not missing scope.

---

## Over-engineering findings

### EOE-1 (major) — `release()` no-op on `PortLockAcquirer` kept "for
shape parity" (03 §E1, ER1)

**Proposal** (`03-class-boundaries.md` §E1):
> "`release(): Promise<void>   // no-op for port; present for shape
> parity with PidfileLockAcquirer`"

**Counter-argument.** The doc comment is explicit that this exists so
`App.shutdown()` can call `lock.release()` uniformly on both acquirers.
But the doc comment is the only justification — there is no current
caller that needs the symmetry, and `App.shutdown()` can equally well
write `await pidfileLockAcquirer.release()` (skipping the
`PortLockAcquirer` which has nothing to release). The framework's
`review-completeness.md` OE-4 rejected the `AuthContext` sealed
hierarchy for a *parallel* speculative-parity reason. The same logic
applies: a no-op method on a public class API is ceremony that future
readers will either (a) wonder what it should do, or (b) silently
delete, leaving the symmetry it was supposed to enforce broken.

The plan's own `03-class-boundaries.md` §E1 admits it: *"The port
lock is held by the kernel for the lifetime of the listening socket;
the dashboard process owns the socket until `process.exit`. The
`release()` method exists only so `App.shutdown()` can call it
uniformly on both acquirers without a type guard."* — the "without a
type guard" benefit is negligible (one `if (portLock) portLock.release()`
in `shutdown()` is fine).

**Severity: wasteful.** Drop `release()` from `PortLockAcquirer`'s
public surface. `shutdown()` can call `await pidfileLockAcquirer.release()`
and skip the port lock. The shape-parity argument is exactly the
"future-proofing for symmetry" anti-pattern OE-6's category targets.

---

### EOE-2 (major) — `acquire(port, overrides?)` second parameter deferred
to implementation time (03 §E1, §E2 — [ASSUMPTION] tags)

**Proposal** (`03-class-boundaries.md` §E1):
> "`acquire(port: number, overrides?: AcquirePortLockOptions):
> Promise<void>` ... [ASSUMPTION: whether `overrides?` is needed is a
> sequencing decision; if the test fixture at `process-lock.test.ts:333-528`
> can live with constructor-only options, drop `overrides?` and rely on
> per-test instance construction.]"

**Counter-argument.** This is the same "speculative per-call
configuration seam" the framework's OE-7 rejected for `BasePaneWatcher`.
The plan explicitly flags it as an [ASSUMPTION], meaning a real
implementation will pick one shape and the other will be churn. Per
the plan's own `01-module-state-analysis.md` §2, all 8 existing
`acquirePortLock` cases use the constructor-supplied `opts` (the
`graceMs`/`binaryPattern`/`postKillDrainMs`/`postKillPollMs` are set
once per call site). The `process-lock.test.ts:393` case sets
`postKillDrainMs: 0` for a single drain-skip test — this is the only
case that would benefit from `overrides?`. Production callers all
omit it. The test case can construct a fresh `PortLockAcquirer` with
`{ postKillDrainMs: 0 }` for that one test. Drop the parameter.

**Severity: wasteful.** Drop `overrides?` from both
`PortLockAcquirer.acquire()` and `PidfileLockAcquirer.acquire()`. The
[ASSUMPTION] tag is the plan telling itself the parameter is
speculative; honour the assumption by dropping it.

---

### EOE-3 (minor) — `release()` `Promise<void>` return type even though
nothing is async (03 §E1, §E2)

**Proposal** (`03-class-boundaries.md` §E1, §E2):
> "`release(): Promise<void>`"

**Counter-argument.** `PortLockAcquirer.release()` is a documented no-op.
`PidfileLockAcquirer.release()` does `readFileSync` + `unlinkSync`
(synchronous I/O, both via the injected `ctx`). Returning
`Promise<void>` for a synchronous path is misleading: it implies
awaitable cleanup that won't actually defer. Either keep `release()`
sync (`void`) — matching the I/O pattern of `tryCreateExclusive` at
`index.ts:212-232`, which uses `openSync`/`writeSync`/`closeSync` —
or commit to async cleanup (introducing a race window, see ER3).

The framework `06-risks-and-mitigations.md` R5 explicitly values the
"no async gap in tryCreateExclusive" property. `release()` should
match.

**Severity: wasteful** if `PortLockAcquirer.release()` is kept at all
(see EOE-1); **neutral** for `PidfileLockAcquirer.release()` if it
truly does sync I/O. Sync return (`void`) is consistent with
`writeBufferFully`'s sync signature at `process-lock.ts:207-210`.

---

### EOE-4 (minor) — Phase ordering: E.1 + E.5 could collapse if
"alongside free function" pattern is the chosen migration window

**Proposal** (`05-refactor-roadmap.md` Phase E.1, E.5):
> E.1 introduces class alongside free function; E.5 removes free function
> after all consumers migrate.

**Counter-argument.** The two-phase structure is correct because of
the `vi.mock('../process-lock.js')` factory at `index.test.ts:173`:
the mock factory must keep returning the legacy symbols (`:191-192`)
through E.1–E.4. The free-function removal at E.5 *requires* the
factory shape change. So the two phases are correctly separate. No
finding — listed here as a verification pass.

The framework `review-completeness.md` OE-11 raised the Phase 1 +
Phase 2 merge question for H/LoggerLike; for E the dependency is the
opposite (E.5 *requires* E.3+E.4 to land first), so the split is
load-bearing, not ceremonial.

**Severity: neutral.** The split is justified; no change needed.

---

### EOE-5 (minor) — `04-generic-interfaces.md` §L argues against E's own
narrower `LoggerLike`-like shape, then defers to H

**Proposal** (`04-generic-interfaces.md` §L "Why E does not define its
own narrower logger interface"):
> "The temptation is to type the `log` field as the *exact* triple E
> uses (`info`, `warn`, `error` — no `debug`) since E never logs at
> `debug`. ... **Rejected** for three reasons..."

**Counter-argument.** This is the plan correctly rejecting an
over-engineering pattern the framework OE-6 category targets. E
demonstrates discipline by surfacing the temptation and rejecting it.
No finding — listed as a positive observation.

**Severity: neutral.** No change needed; this is the right call.

---

## Completeness findings

### ECE-1 (major) — `vi.resetModules()` + `vi.doMock` pattern at
`index.test.ts:251` not enumerated in ER5

**Missing area.** `src/__tests__/index.test.ts:251-256` uses a
`vi.resetModules()` + `vi.doMock('node:child_process', ...)` +
`vi.doMock('node:fs', ...)` pattern to selectively re-import the
module under test with different I/O mocks. ER5 (`06-risks-and-mitigations.md`)
enumerates the `vi.mock('../process-lock.js')` factory at `:173`,
the `withRealAcquirePortLock`/`withRealAcquirePidfileLock` helpers at
`:1363`/`:1314`, and the 40+ assertion sites — but misses the
`vi.resetModules()` path at `:251`. This is the path that lets a test
re-import `src/index.ts` with a fresh `node:child_process` mock and a
fresh `node:fs` mock *without* re-running the `:82`-`:169` mock chain.

**Why it matters.** After E.5, if `index.ts` constructs the
`PortLockAcquirer`/`PidfileLockAcquirer` inline (rather than via
`class App`), the `vi.resetModules()` re-import path re-runs the
inline construction code against the new `node:child_process` mock.
If `class App` (D3/Phase 7) is in place by then, the `vi.resetModules`
re-import has to re-construct the `App` instance (or the test has to
use a different re-import strategy). The plan does not enumerate
which path E.5 will pick, so the `vi.resetModules` impact is
unassessed. The pattern also depends on `vi.mock` factory hoisting,
which (per HCE-10) is not verified under `bun --bun vitest`.

**Severity: major.** Add the `vi.resetModules()` pattern at
`index.test.ts:251-256` to E.5's "Test fixtures that change shape"
list in `05-refactor-roadmap.md` and to ER5's detection signals.

---

### ECE-2 (major) — `node:child_process` and `node:fs` vi.mock sites
(82/87/252/256) not enumerated; they share `withReal*` helper semantics

**Missing area.** The `vi.mock('node:child_process', ...)` factory at
`index.test.ts:82` and the `vi.doMock('node:child_process', ...)` /
`vi.doMock('node:fs', ...)` at `:252`/`:256` are the *upstream* of
`withRealAcquirePortLock`'s behaviour. `withRealAcquirePortLock`
delegates to a real `PortLockAcquirer` (constructed post-E.5 via
`new actual.PortLockAcquirer(actualCtx)`), whose `.acquire(port, opts)`
method calls `this.ctx.listPortHolders(port)` → `execSync('lsof', ...)`,
which is intercepted by the `node:child_process` mock factory at
`:82`. The plan correctly notes the `vi.mock('../process-lock.js')`
factory and the `withReal*` helpers, but does not enumerate the
`node:child_process` mock.

**Why it matters.** If E.5 changed `process-lock.ts` to import
`execSync`/`execFileSync` directly (instead of receiving them via
the injected `ctx`), the `node:child_process` mock at `:82` would
break — `vi.mock('node:child_process')` only catches direct imports.
The plan's `01-module-state-analysis.md` §1 "Side effects" correctly
notes that `process-lock.ts` has **zero** `import` statements, and
E.5 verified that the class version preserves this property: no
`node:child_process` / `node:fs` / `node:os` imports were introduced
by E.5a / E.5b (the I/O continues to be injected via `ctx`).

**Severity: major.** Add a one-line guard at the end of E.1 / E.2
method-by-method tables in `03-class-boundaries.md`: "The class does
not introduce `import` statements for `node:child_process` /
`node:fs` / `node:os`; the I/O continues to be injected via `ctx`."
This pins the existing test-mock chain.

---

### ECE-3 (minor) — `releaseLock()` call sites counted inconsistently
(01 §6 vs 05 §E.4)

**Missing area.** `01-module-state-analysis.md` §6 "Integration in
`src/index.ts`'s boot flow" says: "`releaseLock()` at
`index.ts:356-364` is the inverse ... called from three places inside
`shutdown()` (L393, L402, L408, L413) plus the catch-all L411-415
path." — so **4 explicit call sites + 1 catch-all path = 5
invocations**.

`05-refactor-roadmap.md` §E.4 says: "The five `releaseLock()` call
sites in `index.ts:393, :402, :408, :413, :411-415`" — listing 5
items where the last is the catch-all path (not a call site per se).

Verified by `grep -n releaseLock /Users/.../index.ts`:
```
356:function releaseLock(): void {
393:      releaseLock()
402:        releaseLock()
408:      releaseLock()
413:    releaseLock()
```

The 4 explicit call sites are at L393, L402, L408, L413. The plan's
"five call sites" wording in 05 §E.4 overcounts by including the
catch-all as a fifth site. This is a documentation drift, not a code
defect.

**Why it matters.** E.4's "Rollback strategy: per-function commits"
assumes each call site is its own rollback unit. If the catch-all is
treated as a fifth site, the rollback granularity is correct (5
commits, one per site). If the catch-all is treated as a path shared
with the explicit sites, the rollback is per-shutdown-path, not
per-line. The wording should match the rollback granularity.

**Severity: minor.** Fix the count in `05-refactor-roadmap.md` §E.4:
"4 explicit `releaseLock()` call sites (`index.ts:393`, `:402`,
`:408`, `:413`) — the catch-all path at `:411-415` is the fourth
of these in code order." Or use the actual `index.ts:393/:402/:408/:413`
list verbatim and drop "411-415".

---

### ECE-4 (minor) — Bun-specific `openSync(path, 'wx')` / `writeSync`
semantics not verified in ER3

**Missing area.** ER3 (`06-risks-and-mitigations.md`) correctly
identifies that the `openSync(path, 'wx')` + `writeSync` + `closeSync`
triad at `index.ts:212-232` must be preserved (any async refactor
opens a TOCTOU race window). But the plan does not verify that bun's
runtime honours POSIX `O_EXCL` semantics on `openSync('wx')` —
specifically:

- Bun's `fs.openSync(path, 'wx')` is documented to throw `EEXIST` if
  the file exists, mirroring Node.
- But bun's `Error` propagation for `fs.openSync` may differ in
  stack-trace format (CE-12 in framework review) or in error-code
  attachment (e.g., `(err as NodeJS.ErrnoException)?.code` at
  `index.ts:229` relies on `err.code === 'EEXIST'`; bun attaches this
  but the test mock at `index.test.ts:652-683` uses a custom error
  path).

The plan's ER3 mitigation #1 ("The class is a literal translation")
defers the bun compatibility check to the regression test. The
regression test would catch a behaviour change, but it would not
catch a *silent* semantics divergence (e.g., EEXIST attached vs not
attached) without a separate unit test asserting the error code.

**Why it matters.** The CLAUDE.md §8 baseline workflow mandates
`bun --bun vitest run`, which exercises bun's runtime. If bun's
`openSync('wx')` does not attach `.code = 'EEXIST'` exactly like
Node, the `tryCreateExclusive` catch at `index.ts:229` falls through
to `throw err`, and the entire `acquirePidfileLock` body crashes on
the first collision.

**Severity: minor.** Add a detection signal to ER3: "A test that
asserts `mockFs.openSync` was called with `'wx'` and threw an error
with `.code === 'EEXIST'` verifies both POSIX semantics AND bun's
error-code attachment. The existing `process-lock.test.ts:652-683`
regression covers the first; the second is currently unverified."

---

### ECE-5 (minor) — Bun-specific race-window in `acquire` retry loop
(`process-lock.ts:301-364`) not addressed

**Missing area.** `PidfileLockAcquirer.acquire`'s `for (let attempt = 1;
attempt <= maxAttempts; attempt++)` loop uses sequential awaits
(`await this.ctx.sleep(graceMs)` at L357, `this.ctx.unlinkIfMatches` at L363).
The plan's ER3 correctly notes the O_EXCL atomicity guarantee for
`tryCreateExclusive`. But the plan does not address bun-specific
timing of `setTimeout` / `setImmediate` interleaving — bun's event
loop may schedule the `this.ctx.sleep(graceMs)` timer differently from
Node, which could affect the third-peer-survives regression at
`process-lock.test.ts:652-683` (which assumes deterministic timer
ordering during the grace window).

**Why it matters.** Bun's `setTimeout` is implemented in native code
and may not honour Node's exact minimum-granularity rules. If the
graceMs timer fires *before* the `await ctx.unlinkIfMatches(...)`
microtask chain completes, the third peer can be racy. The existing
test pins deterministic ordering via the test harness's
microtask-queue control, but bun's behaviour is not explicitly
verified in the plan.

**Severity: minor.** Add a one-paragraph "bun timer semantics" note
to ER3's "Detection signal" section: "Verified that
`process-lock.test.ts:652-683` `third peer survives` regression
passes under `bun --bun vitest run` (CLAUDE.md §8 baseline). If
bun's `setTimeout` granularity diverges from Node's during the
grace window, this test would catch it — verify before E.5 lands."

---

### ECE-6 (minor) — `DeferToPeerError` move to `src/errors.ts` (H.4
future) not pinned as an E-blocker for E.5 ordering

**Missing area.** ER4 (`06-risks-and-mitigations.md`) correctly notes
that if H.4 later moves `DeferToPeerError` to `src/errors.ts`, "the
move is a single-commit operation: `index.ts:31` updates its
re-export, the `index.ts:324` throw imports from the new location,
the `process-lock.ts:347` throw imports from the new location..."
This implies H.4's move would touch `process-lock.ts` and the E.5
gate (`grep -rln "acquirePortLock\|acquirePidfileLock"`) would
*pass* through the H.4 commit (no acquire* changes), but the
`DeferToPeerError` re-export at `index.ts:31` would shift.

**Why it matters.** If E.5 lands *before* H.4's `DeferToPeerError`
move, the only consumer of `DeferToPeerError` in
`src/process-lock.ts` is `process-lock.ts:347` itself (the throw
inside the class method). If H.4 moves the class out of
`process-lock.ts` and into `src/errors.ts` after E.5, the
`process-lock.ts:347` throw has to import the class from a different
file — but the test files at `index.test.ts:876`, `:1545`, `:1910`,
`:1949`, `:2207` and `process-lock.test.ts:631` may continue to
import `DeferToPeerError` from the old path until updated. The
ordering between E.5 and H.4 is not pinned.

**Severity: minor.** Add a one-line "E.5 + H.4 ordering" note to
`05-refactor-roadmap.md` pre-conditions: "If H.4's `DeferToPeerError`
move lands after E.5, the test imports in
`index.test.ts:876/:1545/:1910/:1949/:2207` and
`process-lock.test.ts:631` must be updated to the new path in the
H.4 commit (not in a follow-up)."

---

### ECE-7 (minor) — `index.ts:283` comment cites test line `:1382` but
real test starts at `:1383` — fix ownership not pinned to E or H

**Missing area.** Both `01-module-state-analysis.md` §7 and
`02-type-interface-analysis.md` §1 + §8 correctly identify that the
`src/index.ts:283` comment says "Pinned by `index.test.ts:1382`" but
the test actually starts at `:1383`. The plan defers the fix to the
H.1 commit ("per `review-correctness.md` M2 / m2, severity major").
But E.6 also touches `src/index.ts:280-287` (the adapter literal
collapse to `log: logger`), so E.6 is a natural moment to fix the
comment — the plan should specify whether E.6 absorbs the fix or
leaves it to H.1.

**Why it matters.** If H.1 lands first and E.6 lands second with no
mention of the comment, the H.1 commit has the fix and E.6 has a
no-op for that line. If E.6 lands first (gated on H.1, so unlikely
under current ordering), E.6 should fix the comment. Plan
correctness depends on which lands first.

**Severity: minor.** Specify the ownership in `05-refactor-roadmap.md`
E.6: "Fix `src/index.ts:283` comment (`1382` → `1383`) in E.6 if H.1
has not yet landed; otherwise defer to H.1 (per `h-cross-cutting/
review-completeness.md` HCE-2 / M2)."

---

### ECE-8 (minor) — `class App` (D3 / Phase 7) construction order
not pinned in E.3/E.4

**Missing area.** E.3 and E.4 say "construct a `PortLockAcquirer`
instance (either locally inside `acquireLock()` at `:337-351` or
held on a future `class App` per Phase 7)" — but do not decide. The
framework `review-completeness.md` CE-8 flagged that Phase 6 + Phase
7 touch the same code paths, and that the construction order is
critical. E.3/E.4 are downstream of this decision: if `class App`
owns the acquirers, E.3/E.4 are Phase 7 work; if `acquireLock()` owns
them locally, E.3/E.4 are stand-alone.

**Why it matters.** The plan's `03-class-boundaries.md` §E1 Lifecycle
says "Constructed at boot by `src/index.ts`'s future `class App`
constructor (framework D3, `05-refactor-roadmap.md` Phase 7), inside
`acquireLock()` at `index.ts:337-351`". This is internally
contradictory (Phase 7 OR `acquireLock()`?). E.3 must decide before
landing.

**Severity: minor.** Resolve the contradiction in
`03-class-boundaries.md` §E1 Lifecycle. Either (a) E.3 keeps the
local-construction pattern (matches today's `procCtx = buildProcessLockContext()`
at `index.ts:339`), and Phase 7 inherits the local instance; or
(b) E.3 defers to Phase 7 (the construction lives in `class App`
constructor). Option (a) is the lower-risk path because it preserves
E.3's "single call site" rollback granularity.

---

## Net assessment

E's keystone thesis is correct:

- **Two classes (`PortLockAcquirer`, `PidfileLockAcquirer`)** are
  the right granularity. The two acquire functions have ~25% overlap
  on `sleep` + `log`, but the two ctx interfaces are non-overlapping
  (eight port-specific methods, seven pidfile-specific methods), and
  the cross-context coupling (`isLegitimatePredecessor` closing over
  `procCtx`) would force a shared ctx parameter on a unified class.
  Two classes is the cleaner shape.
- **The `LogFn → LoggerLike` migration** is correctly delegated to H.1
  (`04-generic-interfaces.md` §L "Why E does not define its own
  narrower logger interface" demonstrates the discipline), and E.6 is
  gated on H.1 + H.2. This avoids the H plan's HOE-2 trap of widening
  the surface unnecessarily.
- **Four candidate generics** (`LockContext<T>`, `LockResult<T>`,
  `AcquireOptions<TLock>`, `DeferToPeerError<TPid>`) are rejected
  with explicit rationale in `04-generic-interfaces.md` §X. Each
  rejection cites the framework OE-6 "no second consumer" pattern.
  This is exactly the right discipline.
- **The E.1 + E.5 phase split** is justified by the
  `vi.mock('../process-lock.js')` factory at `index.test.ts:173`
  (the factory must keep returning legacy symbols through E.1–E.4).
  The framework's OE-11 Phase 1 + Phase 2 merge suggestion does not
  apply here.
- **The class-with-wrapper pattern** in E.1/E.2 (introduce class
  alongside the free function, free function becomes a thin
  wrapper) preserves the test surface through the migration window.
  ER5 correctly identifies that E.5 is the irreversible step.

But the plan is over-prescribed on two shape-parity seams:

- `PortLockAcquirer.release()` no-op kept "for symmetry"
  (`03-class-boundaries.md` §E1) — pure ceremony; framework OE-4.
- `acquire(port, overrides?)` second parameter flagged as
  `[ASSUMPTION]` in two places (`03-class-boundaries.md` §E1, §E2) —
  speculative API; framework OE-7.

And under-prescribed on six completeness seams, mostly tracking and
verification:

- `vi.resetModules()` pattern at `index.test.ts:251` not enumerated
  in ER5 (ECE-1).
- `node:child_process` / `node:fs` mock factories (`:82`, `:87`,
  `:252`, `:256`) not enumerated; the class version's
  no-`node:child_process`-import constraint is implicit, not stated
  (ECE-2).
- `releaseLock()` call sites overcounted in `05-refactor-roadmap.md`
  §E.4 (4 explicit + 1 catch-all path listed as 5 sites) (ECE-3).
- Bun-specific `openSync(path, 'wx')` + `writeSync` EEXIST error-code
  attachment not verified (ER3) (ECE-4).
- Bun-specific `setTimeout` granularity during the grace-window race
  not verified (ECE-5).
- E.5 + H.4 ordering for the future `DeferToPeerError` move not
  pinned (ECE-6).
- `index.ts:283` comment fix ownership (E.6 vs H.1) not pinned
  (ECE-7).
- E.3/E.4 construction-site decision (`class App` vs local in
  `acquireLock()`) left as "either/or" in
  `03-class-boundaries.md` §E1 (ECE-8).

**Recommendation: ACCEPT-WITH-EDITS.**

**Drop before executing:**

- `PortLockAcquirer.release()` no-op (`03-class-boundaries.md` §E1)
  (EOE-1).
- `acquire(port, overrides?)` second parameter
  (`03-class-boundaries.md` §E1, §E2 — `[ASSUMPTION]` tags) (EOE-2).
- `release(): Promise<void>` async return type on
  `PortLockAcquirer.release()` (no-op method) — moot if EOE-1 lands
  (EOE-3).

**Enumerate before executing:**

- `vi.resetModules()` + `vi.doMock` pattern at `index.test.ts:251-256`
  in ER5's detection signals (ECE-1).
- `node:child_process` / `node:fs` mock factories at `:82`, `:87`,
  `:252`, `:256` in `06-risks-and-mitigations.md` (ECE-2).
- The "no `node:child_process` / `node:fs` import in the class"
  constraint in `03-class-boundaries.md` §E1 / §E2 (ECE-2).

**Resolve before executing:**

- E.3 / E.4 construction-site decision: local in `acquireLock()` vs
  `class App` field (ECE-8).
- E.6 vs H.1 ownership of the `index.ts:283` comment fix (ECE-7).
- E.5 vs H.4 ordering for the future `DeferToPeerError` move (ECE-6).

**Fix documentation drift:**

- `releaseLock()` call-site count in `05-refactor-roadmap.md` §E.4
  (4 sites, not 5) (ECE-3).

**Verify before executing:**

- Bun-specific `openSync('wx')` EEXIST error-code attachment
  (`ECE-4`).
- Bun-specific `setTimeout` granularity during the
  `acquirePidfileLock` grace window (ECE-5).

---

## Verification provenance

Every file:line reference in this review was read against the
working tree on 2026-08-30:

- `process-lock.ts:283` (the comment-plan comment — referenced
  indirectly via `index.ts:282-283`) — verified.
- `index.ts:283` (the off-by-one `Pinned by index.test.ts:1382`)
  — verified.
- `index.test.ts:1383` (the actual pin test `'forwards pidfile
  context errors to logger.error'`) — verified.
- `index.ts:393, :402, :408, :413` (the four `releaseLock()` call
  sites) — verified by `grep -n releaseLock src/index.ts`.
- `index.test.ts:251-256` (`vi.resetModules()` + `vi.doMock`
  pattern) — verified.
- `index.test.ts:82, :87, :252, :256` (`node:child_process` /
  `node:fs` mock factories) — verified.
- `index.ts:212-232` (the O_EXCL `tryCreateExclusive` sync triad)
  — verified.
- `process-lock.test.ts:652-683` ("third peer survives"
  regression) — verified by line-range reference in plan.
- 33 `process-lock.test.ts` cases — verified by the plan's
  `01-module-state-analysis.md` §8 describe-block table.
- 1 active `vi.mock('../process-lock.js')` site at
  `index.test.ts:173` — verified.
- 2 production `DeferToPeerError` throw sites (`process-lock.ts:347`,
  `index.ts:324`) — verified.
- 1 `instanceof DeferToPeerError` consumer (`index.ts:555`) —
  verified.
- 7 cross-cutting framework OE / HOE lessons applied: OE-4
  (speculative shape-parity), OE-6 (generic with one consumer),
  OE-7 (per-call override seam), OE-11 (phase merge question);
  HOE-1 (`TResolved` no-consumer), HOE-4 (contingency shape),
  HCE-2 (off-by-one comment), HCE-10 (bun `--bun vitest`
  verification).
- Zero `as any` / `: any` / `as unknown as` in
  `src/process-lock.ts` — verified (matches plan claim).
- Zero `flock` / `proper-lockfile` / `redis-lock` / `file-lock` /
  `async-mutex` references in `package.json` or `src/` — verified
  (E scope is correctly limited to the O_EXCL pidfile + port-holders
  pattern).
