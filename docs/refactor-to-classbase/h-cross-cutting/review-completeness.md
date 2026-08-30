# Plan Review — H (cross-cutting) over-engineering & completeness

Review scope: all six H plan documents
(`docs/refactor-to-classbase/h-cross-cutting/00-summary.md` through
`06-risks-and-mitigations.md`). Source ground-truth verified against
`src/` on 2026-08-30 (logger importers, vi.mock counts, pending-retries
exports, format.ts/env.ts surface, process-lock.ts:19 LogFn shape).

The framework's `review-completeness.md` (OE-1 to OE-11) is the lens. H's
own claims are cross-checked: the plan's `05-refactor-roadmap.md` risks
(HR1-HR6), dependency graph, and class boundaries (C1-C3) are read for
internal consistency, not just against the framework.

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 3 | 4 |
| Completeness | 1 | 6 | 3 |

**Net assessment: ACCEPT-WITH-EDITS.** H is the smallest subsystem by
line count and the largest by blast radius. The plan gets the two
keystone decisions right (minimum-surface `LoggerLike` over pino
re-alias; `LazyBin` over `TtlCache<K,V>`-style generic). But four
over-engineering seams and seven completeness gaps remain. None of them
require a rewrite; all are localized to specific sections.

---

## Over-engineering findings

### HOE-1 (major) — `LazyBin<TName, TResolved>` has `TResolved` with no consumer

**Proposal** (`h-cross-cutting/04-generic-interfaces.md` §Z):
```ts
export class LazyBin<TName extends string = string, TResolved extends string = string> {
  constructor(name: TName, resolver?: (name: TName) => TResolved)
  readonly name: TName
  resolve(): TResolved
  invalidate(): void
}
```

**Counter-argument.** `TResolved` is exactly the
`review-completeness.md` OE-6 "generic with one consumer" pattern the
plan cites to justify itself. `resolveFromPath` returns `string`
(`src/platform.ts:61`) with no narrower inhabitant anywhere in `src/`.
`TName` is load-bearing (`new LazyBin('tmux')` infers `LazyBin<'tmux'>`);
`TResolved` is not. The plan itself flags this in `04-generic-interfaces.md`
§Z "Type parameters and constraints" and §X Considered and rejected. It
then keeps the parameter anyway because "the brief asked for it" — that
is not a technical reason. The default-to-`string` workaround makes the
parameter silent: no call site supplies it, so it can never be wrong,
and so it can never be useful.

**Severity: wasteful.** Drop `TResolved` before H.3 lands. The
one-parameter form `LazyBin<TName extends string = string>` covers
`resolve(): string` (the actual return type) and keeps the
`name`-narrowing benefit intact. Match the plan's own §X rejection
criterion.

---

### HOE-2 (major) — `LoggerLike` surface includes `obj: object` (wider than pino accepts in practice)

**Proposal** (`h-cross-cutting/04-generic-interfaces.md` §L):
```ts
export interface LogFn {
  (msg: string): void
  (obj: object, msg?: string): void
}
```

**Counter-argument.** The plan argues `obj: object` is correct because
"`Record<string, unknown>` rejects an interface-typed argument"
(`04-generic-interfaces.md` §L Variance). The argument is right about
the *current* alias at `process-lock.ts:19` (which is being deleted in
H.1 anyway), but wrong about *pino's* own behaviour. Pino's
`LogFn` (`node_modules/pino/pino.d.ts:345-352`, version 9.14.0)
accepts `Record<string, any>` — i.e., interfaces widen automatically
via TypeScript's structural rules. The plan's interface will pass *more*
arguments than pino itself does at runtime. The 626 object-first call
sites use object literals (`{ a: 1, b: 'foo' }`) which pino will happily
serialise; the risk is that an interface-typed row whose fields are
*all optional* (`interface Foo { a?: string }`) reaches pino and pino
tries to serialise undefined fields. In practice pino tolerates this,
but the plan widens without measuring what pino narrows.

A narrower, measured shape:
```ts
export interface LogFn {
  (msg: string): void
  (obj: Record<string, unknown>, msg?: string): void
}
```
rejects exactly the same interface-typed arguments the current
`process-lock.ts:19` alias rejects, forcing any interface-typed log
record to widen at the boundary (one explicit cast at the call site,
not 91). That is the correct trade: keep the surface tight, force the
boundary to widen.

**Severity: wasteful.** Tighten the `obj` type to `Record<string, unknown>`
to match pino's actual contract. The current `obj: object` widens beyond
what pino accepts and gives up the one compile-time signal the existing
alias was providing.

---

### HOE-3 (major) — Phase H.0 is a separate phase for measuring baselines

**Proposal** (`h-cross-cutting/05-refactor-roadmap.md` Phase H.0):
"in a clean worktree under `$HOME` (per CLAUDE.md §8 — **not** `/tmp/`),
record `bun tsc --noEmit` error count, `bun run lint` problem count,
`bun --bun vitest run` pass/fail counts."

**Counter-argument.** The work itself is necessary (every later gate is
a delta against it), but as a *phase* it has:
- Zero files touched.
- Zero tests added.
- Zero reviewers required.
- Zero risk to anything else.
- Reversibility: trivially re-measurable.

It is a precondition, not a phase. Calling it Phase H.0 implies a
commit (and a PR review) for what is literally three shell commands.
The framework's `review-completeness.md` CE-13 explicitly warns against
this kind of phase inflation: "HMR safety" subsection, "construction
order" subsection — those are subsections, not phases, for the same
reason.

**Severity: wasteful** as a numbered phase; **neutral** as a documented
prerequisite. Merge H.0 into the front matter of `05-refactor-roadmap.md`
as "Prerequisites — run before any phase starts", not as a phase with a
risk row and a "Parallelizable: n/a" line. This removes a zero-work
artifact from the dependency graph.

---

### HOE-4 (minor) — `PinoLogger` "contingency shape" kept verbatim in `03-class-boundaries.md` C1

**Proposal** (`h-cross-cutting/03-class-boundaries.md` C1):
> "The section below is retained as the **contingency shape**, to be built
> only if H.2's proof consumer demonstrates a real need for per-class
> bindings."

**Counter-argument.** `03-class-boundaries.md` recommends *not* building
`PinoLogger` in H. The contingency shape is ~40 lines of code (class +
constructor + `fromEnv` + four `LogFn` fields + `child`). It is
"retained" in the planning document, which is a planning repo, where
*every* line is intended to be either a build-now or a build-later
contract. A "retained as contingency" block has no reader: H.2's proof
consumer either needs it (and the contingency block goes stale against
the eventual build) or doesn't (and the contingency block is dead
copy). `review-completeness.md` OE-6 rejected a parallel
"speculative generic" pattern for exactly this reason.

**Severity: wasteful.** Move the contingency shape into a code comment
inside `src/logger.ts` *if* H.2a's proof consumer surfaces the need, or
drop it. Do not keep a 40-line signature sketch in a planning doc that
explicitly recommends against building it.

---

### HOE-5 (minor) — `06-risks-and-mitigations.md` HR2 enumerates 7 mock shapes verbatim from `04-generic-interfaces.md`

**Proposal** (`h-cross-cutting/06-risks-and-mitigations.md` HR2):
> | Shape | Files |
> |---|---:|
> | `{info, warn, error, debug}` | 64 |
> | `{info, warn, error, debug, level}` | 7 |
> | … |

**Counter-argument.** The same table appears verbatim in
`04-generic-interfaces.md` §L "Which pino members MAY be omitted".
Duplication invites drift: a future re-measurement of the mocks updates
one table but not the other, and the two diverge silently. The HR2
table adds nothing (no new shape, no new count) that the §L table does
not already say.

**Severity: wasteful.** Replace HR2's table with `("shape distribution
matches 04-generic-interfaces.md §L; re-measure there")`. One table,
one source of truth. Drift-elimination is the kind of
`review-completeness.md` OE-7/OE-8 hygiene that does not show up in
the diff but compounds over many planning docs.

---

### HOE-6 (minor) — H.2b is described as a "phase" but is in fact a policy

**Proposal** (`h-cross-cutting/05-refactor-roadmap.md` H.2b):
> "**Files touched:** none directly. H.2b is a **policy**, not a patch:
> each Part A / B / C / D class, at the moment its own subsystem converts
> it, takes `log: LoggerLike` as a constructor parameter..."

**Counter-argument.** The plan correctly identifies H.2b as a policy,
then formats it as a phase with its own risk row ("Medium, cumulative"),
its own test coverage requirement ("per converted class, one
assertion…"), its own parallelism claim ("Yes, across subsystems"), and
its own rollback ("per-class, per-commit"). All five rows are
redundant: the policy *is* "do what H.2a proves works, one class at a
time". Putting it in the dependency graph (H.2a → H.5) is correct;
putting it in the risk summary table makes the graph noisier without
adding any constraint.

**Severity: wasteful.** Keep H.2b as the policy paragraph it is, drop
its row from the summary table, and let "the convention document lives
at `docs/conventions/logger-injection.md`" do the enforcement work that
the phase card claims to do.

---

### HOE-7 (minor) — H.1 includes a "compile-time assignability pin" as a test requirement

**Proposal** (`h-cross-cutting/05-refactor-roadmap.md` H.1 test
coverage requirement 1):
> "A compile-time assignability pin: a test (or a
> `// @ts-expect-error`-free type-only file) asserting
> `const _: LoggerLike = logger` compiles."

**Counter-argument.** `bun tsc --noEmit` against the codebase is the
pin. A separate test file asserting `const _: LoggerLike = logger`
compiles is `bun tsc --noEmit` minus the rest of the codebase. If
`logger` ever stops satisfying `LoggerLike`, every consumer of
`LoggerLike` breaks at the same time, which is what the test file
would also detect — but with much higher signal (88 importers, the
H.0 baseline count) than one `const _ =` line. The "negative pin"
(`@ts-expect-error` on a missing `debug` member) is the only one of the
three that adds information not already present in the suite, and it
belongs in a structural-guard style test
(`platform-no-import-time-bin-resolve.test.ts` is the precedent), not
as a dedicated "LoggerLike assignability" file.

**Severity: wasteful.** Drop requirement 1. Keep requirement 2 (the
negative pin) as the only new test in H.1, merged into the same
structural-guard file. Keep requirement 3 (logger.test.ts unchanged)
and requirement 4 (index.test.ts pidfile-forwarder pin).

---

## Completeness findings

### HCE-1 (critical) — Baseline counts in H plan disagree with ground truth

**Missing area.** The H plan cites two baseline numbers that
`grep`-verified measurements disagree with:

| Claim | Source | Measured |
|---|---|---:|
| "88 non-test files import `logger`" | `h-cross-cutting/00-summary.md` | **96** |
| "91 test files replace the module with `vi.mock`" | `h-cross-cutting/00-summary.md` and HR2 | **90** |

`grep -rln "from '.*logger\.js'" src --include='*.ts' | grep -v __tests__ | wc -l` →
96. `grep -rln "vi\.mock.*logger\.js" src --include='*.ts' | wc -l` →
90. H.5's gate ("grep returns only `logger.ts` itself") uses the 88
figure. If the H.0 measurement lands at 96, the H.5 gate fires
prematurely (12 importers remaining at "done") or never (8 importers
exempted from H.5 by an unwritten exception list). Either way the
mechanical gate is wrong against the measured baseline.

The same is true for the framework-level numbers (`db.ts` ~200 free
functions, per CE-16) — H plan inherits them but doesn't re-measure
because H.0 is a separate phase. Round-tripping the baseline numbers
through H.0 is the fix.

**Why it matters.** H.5's gate is a single grep command. The plan's
correctness depends on the command's input number matching the
post-migration ground truth. With 8 importers unmeasured, the
"88 → 0" migration is at best 8/96 short at landing.

**Severity: critical.** Re-measure both counts on a clean worktree
during H.0 and bake the measured number into H.5's gate description
and the dependency graph. Until H.0 runs, every number in the plan is
an estimate; the plan does not flag which numbers are estimates vs.
measured (only "no baseline was re-measured for this document" at the
top of `05-refactor-roadmap.md`).

---

### HCE-2 (major) — `src/process-lock.ts:19` `LogFn` shape, the H.1 consumer, is misquoted

**Missing area.** The plan repeatedly says `process-lock.ts:19` defines
a "narrow `{info, warn, error}` triple":

- `00-summary.md` Dependency table: *"the type it can put on
  `ProcessLockContext.log` (`process-lock.ts:49`) that both a real pino
  instance and the existing `{info,warn,error}` object literals at
  `index.ts:171-175` / `:280-287` satisfy. This is exactly the `LogFn`
  triple at `process-lock.ts:19`."*
- `01-module-state-analysis.md`: *"the narrower `{ info, warn, error }`
  triple defined as `LogFn` in `process-lock.ts:19/49/253`"*
- `02-type-interface-analysis.md`: *"the `LogFn` triple in `process-lock.ts`"*

**Measured** (`src/process-lock.ts:19`):
```ts
type LogFn = (obj: Record<string, unknown>, msg?: string) => void
```

`LogFn` is **the per-method type alias**, not the triple. The triple
`{info: LogFn; warn: LogFn; error: LogFn}` is inlined at
`process-lock.ts:49` (`ProcessLockContext.log`) and `:253`
(`PidfileLockContext.log`), not at `:19`. The plan calls `:19` the
"triple" three times. Worse, `:19` is *not* what makes the
`process-lock.ts` aliases incompatible with `LoggerLike`: `:19` is a
function type; the incompatibility is the field-name mismatch (`debug`
missing on the triple, present on `LoggerLike`). Misattributing the
mismatch to `:19` makes the test-factory requirement (H.2a, 91 mocks
need `debug`) harder to follow than it is.

**Why it matters.** The H.1 test coverage requirement ("two sites at
`src/__tests__/process-lock.test.ts:81` and `:515`, each `log: { info:
log('info'), warn: log('warn'), error: log('error') }`") is exactly
the kind of site that needs `debug` added. The plan correctly
identifies the two sites but does not explain *why* the addition is
needed (because `ProcessLockContext.log` is now `LoggerLike`, which
requires `debug`). Reading the three `:19` references as the source
of the requirement would lead a reworker to edit `:19` itself.

**Severity: major.** Replace "the `LogFn` triple at
`process-lock.ts:19`" with "the `{info, warn, error}` object shape
inlined at `process-lock.ts:49` and `:253`, typed via the `LogFn`
alias at `:19`". Re-verify line numbers via `grep -n` on the actual
file before commit (per CLAUDE.md §8 "MD or commit message file:line
hivatkozásai: mielőtt committolsz, Read-eld a forrást a hivatkozott
sorokon").

---

### HCE-3 (major) — `format.ts` and `env.ts` not enumerated as cross-cutting candidates

**Missing area.** `src/format.ts` (75 LOC) and `src/env.ts` (100 LOC)
are cross-cutting helpers used throughout `src/`:

| Module | LOC | Imports (non-test) | Imports (test) |
|---|---:|---:|---:|
| `src/format.ts` | 75 | **4** | 1 |
| `src/env.ts` | 100 | **1** | 0 |
| `src/logger.ts` | 9 | 96 | 90 |
| `src/platform.ts` | 81 | 14 | 2 |

`format.ts` is a pure formatting module (HTML escape, markdown-to-HTML,
Telegram-safe code-block handling). `env.ts` is a `.env` reader/writer
guarded by `CLAUDECLAW_ENV_DIR`. Neither has a class form; neither is in
H's scope per `00-summary.md`.

**Why it matters.** H's scope is "logger + platform + errors". The
brief asked the reviewer to check whether "format.ts formatting helpers
(used everywhere)" and "env.ts environment variable access pattern"
should be H scope. Measured: `format.ts` has only 4 importers — not
"everywhere". `env.ts` has 1 importer (the tests are listed under
framework's `tests.ts` block). Neither is cross-cutting in the sense H
cares about (singleton-shaped, mockable per test, 88+ importers). H is
right to exclude them. **The completeness gap is that the exclusion is
not documented** — `00-summary.md` Scope lists the 9 error classes and
"the 88 files that `import { logger }`" but does not mention `format.ts`
or `env.ts` at all, so a future contributor assumes they were missed.

**Severity: major.** Add a one-paragraph "Explicitly out of scope:
`src/format.ts` (4 importers, pure functions, no class candidate),
`src/env.ts` (1 importer, test-only escape hatch via
`CLAUDECLAW_ENV_DIR`)" entry under `00-summary.md` Scope. This makes
the boundary H sets intentional, not silent.

---

### HCE-4 (major) — `process-lock.ts` `LogFn → LoggerLike` migration flagged as H but is a C/E migration

**Missing area.** The plan handles `process-lock.ts:19` and `:49` /
`:253` as **H.1** work (`05-refactor-roadmap.md` H.1 "Files touched
(3)"). But:

- The migration is a *consumer* of `LoggerLike`; it does not introduce
  it.
- The class conversion of `PortLockAcquirer` /
  `PidfileLockAcquirer` (framework `03 §E1`/`§E2`) is the work that
  *requires* `LoggerLike` on `ProcessLockContext.log`. The class
  conversion belongs to Part E (process lock), not Part H.

The plan conflates the two: H.1 widens the field type (purely
additive, no class needed); Part E's classes then *use* the widened
type. This is correct sequencing, but it makes H.1's "Files touched
(3)" line read as if H is doing Part E's work. H.1 is doing only the
additive widening — no class shape moves.

**Why it matters.** The plan's risk assessment says H.1 is "Low, with
one live trap" — true for the widening. If the widening is mistakenly
read as also class-converting `PortLockAcquirer`, the risk assessment
understates the work by a class conversion's worth. Conversely, if
H.1 lands and Part E's class conversion runs ahead, the migration
window (HR3 "dual log destination") opens before the test factory
(H.2a) is in place. The dependency graph marks
"framework Phase 2 (process-lock classes)" as downstream of H.1, which
is correct, but the risk row for H.1 does not say "do not also convert
the classes in this commit".

**Severity: major.** Add a one-line guard at the end of H.1's risk
row: "H.1 widens only — `PortLockAcquirer` / `PidfileLockAcquirer`
class conversion belongs to Part E Phase 2 and runs after the H.2a
test factory lands." This is the same `review-completeness.md` OE-11
splitting concern in miniature.

---

### HCE-5 (major) — `pending-retries.ts` module-level state claim not re-verified

**Missing area.** The framework's `review-completeness.md` OE-6 names
`pending-retries.ts` as a `RetryQueue<TRow>` candidate — a generic over
the row shape with three free functions (`shouldSendAlert`,
`classifyTelegramSendError`, `toPendingRetryView`) and one constant
(`ALERT_THRESHOLD_MS`). H plan does not address `pending-retries.ts`
either way.

**Measured** (`src/pending-retries.ts`, 132 LOC):
```ts
export const ALERT_THRESHOLD_MS = 60 * 60 * 1000
export function shouldSendAlert(...)
export function classifyTelegramSendError(...): 'transient' | 'permanent'
export function toPendingRetryView(...)
```

No module-level mutable state (no `let`, no `WeakMap`, no singleton).
The module is a pure-functions file — it has no cache, no DI seam, no
class candidate. The framework's "RetryQueue<TRow>" was speculative;
H is right to ignore it.

**Why it matters.** A second look at the file shows it is **already
covered by H.4's "structured fields vs flat" rule** (`02-type-interface-analysis.md`
Taxonomy recommendation): the row shape (`first_attempt`,
`alert_sent_at`, etc.) is read positionally by name at specific call
sites, not generically. Wrapping the three functions in a class adds
nothing. **But this reasoning is implicit, not in H's docs.** A reader
who sees H skip `pending-retries.ts` while the framework flagged it as
a candidate will assume H missed it.

**Severity: major.** Add a one-paragraph "Explicitly out of scope:
`src/pending-retries.ts` (132 LOC, pure functions, no module-level
state — the `RetryQueue<TRow>` proposal was framework-rejected per
`review-completeness.md` OE-6 and is not reopened here)" entry to
`00-summary.md` Scope, alongside HCE-3's `format.ts` /
`env.ts` exclusion.

---

### HCE-6 (major) — `vi.mock('../logger.js')` count not re-measured at the 91 sites used as the "conformance" denominator

**Missing area.** HR2's mitigation 1 says "64 of 91 mocks then conform
*by construction*, with no edit." The 91 number drives both the
conformance claim and the test-factory impact estimate. Ground-truth
today: **90**, not 91 (one file likely dropped between writing and
measuring). The 64-of-91 ratio becomes 64-of-90 (71% instead of 70%);
the 12-mock `debug`-missing subset is unchanged at 12 (90 - 78 mocks
that include `debug` = 12).

**Why it matters.** H.2a's `createTestLogger()` is sized for 26-27
mocks that need a factory replacement (the 26 that lack `debug` minus
the 14 that already use a shared fixture plus the ~3-5 that have
no method literals at all). With a 90 vs 91 difference the estimate
is off by one file. With a stale count, the estimate compounds.

**Severity: major.** Re-measure during H.0 (the same shell pipeline
that gets `bun tsc --noEmit`'s baseline count gets the mock-count
baseline). Bake the number into HR2's mitigation 1 verbatim.

---

### HCE-7 (major) — H.2a's "test factory" convention is mentioned in three places but not specified

**Missing area.** H.2a's "Deliverable beyond the code" gives a sketch:
```ts
function createTestLogger(): LoggerLike & { /* vi.fn handles */ }
```
and notes "the first 5-10 conversions define what the remaining 80
copy." `06-risks-and-mitigations.md` HR3 mitigation 2 adds "One
injection style per test file." HR2 mitigation 2 repeats the
factory-signature sketch. None of the three specifies:

1. Whether the factory takes options (`{ level?: string, silent?: boolean }`)
   or is fixed-shape.
2. Whether assertions use `.toHaveBeenCalled()` per-method or a single
   "any-call" helper.
3. Whether the factory returns a fresh object per call or memoises
   across tests in the same file.
4. Whether the factory is exported from `src/__tests__/test-helpers.ts`
   (new file) or lives in each test file.
5. What the convention does for `bun --bun vitest`'s module-resolution
   differences (CE-17).

**Why it matters.** The plan says "the convention must be written down
in the same commit" — five times in two documents. The plan itself
does not write it down. The first 5-10 conversions will write it down
by accident; the remaining 80-85 will copy whatever the first 5-10
chose. If the convention is missing the five details above, the
convention is 5 things, not 1, and "convention" becomes
"5 micro-conventions, one per detail".

**Severity: major.** Add a "Test factory specification" subsection to
H.2a's deliverable, addressing the five bullets above. Format the
spec as a code block (~30 lines) plus a one-paragraph rationale, in
the same style as `04-generic-interfaces.md` §L Sketch. This is the
single highest-leverage completeness fix in H; the framework's
`review-completeness.md` CE-5 flagged the missing factory as
Phase-7-critical and H inherits the same exposure.

---

### HCE-8 (major) — `LazyBin` adoptor list mentions `ClaudeCodeBinResolver` (framework §C1) without a numeric confirmation

**Missing area.** `04-generic-interfaces.md` §Z "Adopters" lists two
consumers:
1. `src/platform.ts` (reimplementation over the class).
2. `src/agent.ts` `ClaudeCodeBinResolver` (framework `03 §C1`) — the
   "more specialized version" the framework already describes.

The plan treats the second as the "second consumer that justifies the
class existing at all". **But the framework's `03 §C1` is a plan-stage
proposal; the class does not exist yet.** H.3 cannot land before
`ClaudeCodeBinResolver` is built (which is Part C work), and Part C
cannot land before H.3 (per C1: "needs `LazyBin`'s shape settled
first"). This is a **circular dependency in the plan's own terms**.

**Why it matters.** Either:
(a) `LazyBin`'s second consumer is *eventually* `ClaudeCodeBinResolver`,
in which case H.3 is being built for a future consumer and is currently
a single-consumer abstraction (the framework-rejected pattern), OR
(b) `ClaudeCodeBinResolver` is being justified by `LazyBin`'s
existence, in which case H.3 is the second-consumer-after-itself
chicken-and-egg.

**Severity: major.** Either:
- Land H.3 with a documented "second consumer coming in Part C" caveat
  (so future readers know the abstraction is not paying for itself yet),
  or
- Land H.3 after Part C's `ClaudeCodeBinResolver` (so `LazyBin` has
  two consumers at introduction).

The first is consistent with H being "smallest subsystem by line count,
largest by blast radius" — adding the `LazyBin` shape as the keystone
is reasonable before C1's consumer needs it. The plan should say so.

---

### HCE-9 (minor) — H.2b's "88 importers" needs the same re-measurement as H.5's gate

**Missing area.** H.2b cites "The 88 importing files have no shared
state" (`05-refactor-roadmap.md` H.2b Parallelizable). The 88 number is
the same stale baseline from HCE-1 (ground truth: 96). H.2b's
parallelism claim ("Yes, across subsystems") does not depend on the
exact number — it depends on whether the 88 (or 96) importers share
state, which they do not — but the count cited is wrong.

**Why it matters.** Smaller than HCE-1 (no gate depends on this
number) but the same hygiene issue. The plan should pick a single
source of truth for the count.

**Severity: minor.** Re-measure during H.0; replace 88 with the
measured number in H.2b's text, H.1's "88 importers", H.5's gate,
HR2's "91 mocks", and HR3's "88 importers".

---

### HCE-10 (minor) — `bun --bun vitest` differences (CE-17) not enumerated in HR3's `vi.resetModules()` carve-out

**Missing area.** HR3 mitigation 1 carves out `logger.test.ts:15`
("`vi.resetModules()` in `beforeEach`") as the only legitimate
`vi.resetModules()` call against the logger. The carve-out is correct
for `vitest` under Node; under `bun --bun vitest`, the loader handles
ESM resolution differently and the factory-hoisting behaviour of
`vi.mock` may diverge. The plan does not verify the carve-out holds
under bun.

**Why it matters.** CE-17 in the framework review flagged this as
minor but real. HR3's entire mitigation set ("one injection style per
test file", "assert non-emptiness, not just content") depends on the
hoisting behaviour being deterministic. If bun hoists differently, the
mitigation works on `vitest` and breaks on `bun --bun vitest` (which is
the CI runner per CLAUDE.md §8).

**Severity: minor.** Add to HR3 mitigation 1: *"verified on
`bun --bun vitest` <version>; the carve-out relies on
factory-hoisting-order semantics that may shift between bun versions."*

---

### HCE-11 (minor) — `web/routes/background-tasks.ts:14-15` and other "two-resolver" files are not enumerated in H.2b's per-class coverage

**Missing area.** H.2b says "per converted class, one assertion
proving the injected logger receives the call." Three files
(`web/agent-process.ts:56-57`, `web/channel-monitor.ts:53-54`,
`web/routes/background-tasks.ts:14-15`) call `makeLazyBinResolver`
*twice each* (`tmuxBin` and `claudeBin`). When those modules convert
to take `LoggerLike`, the two `makeLazyBinResolver` lines become two
constructor arguments, not one. H.2b's "per converted class" unit
undercounts by a factor of 2 for those three files.

**Why it matters.** Migration-time estimate: 88 importers become
~91-92 conversion sites, not 88. Two-resolver files add to HR2's
"~12 mocks lacking `debug`" list because the same file's test
fixture has to instantiate two `LoggerLike` objects, not one.

**Severity: minor.** Mention the three two-resolver files explicitly in
H.2b's "files touched" row, even as a no-op (H.2b is a policy, not a
patch — the three files are touched only when their owning subsystem
converts).

---

## Net assessment

H's keystone thesis is correct:

- **Minimum-surface `LoggerLike`** (over pino re-alias or generic-with-log-record)
  is the right shape. HR4's two-overload `LogFn` correctly handles the
  76 string-first call sites that `02-type-interface-analysis.md`'s
  first sketch rejected.
- **`LazyBin` as closure-to-class** with no caller migration in H.3 is
  the right scoping. The `invalidate()` test (HR5) and the
  `TOP_LEVEL_RESOLVE` extension are the right guards.
- **Additive `AppError` base** with `new.target.name` is the right
  shape; the `KeychainUnavailableError` name-change risk (HR6) is the
  right thing to flag explicitly.
- **`TelegramApiError` last** is the right call.
- **Mirror-pair conversion** (`RequestBodyTooLargeError` +
  `PeerResponseTooLargeError`) is the right starting set, including the
  added `readonly limit` on the latter (HR6 mitigation 4).

But the plan is over-prescribed on:

- `TResolved` generic parameter (HOE-1).
- `obj: object` widening beyond pino's contract (HOE-2).
- Phase H.0 as a numbered phase (HOE-3).
- `PinoLogger` contingency shape kept verbatim (HOE-4).
- Mock-shape table duplicated (HOE-5).
- H.2b as a phase row (HOE-6).
- Compile-time assignability pin as a separate test (HOE-7).

And under-prescribed on:

- Stale baseline counts (HCE-1 — 88/91 → 96/90 measured).
- `LogFn` at `:19` misattributed as the triple (HCE-2).
- `format.ts` / `env.ts` exclusion undocumented (HCE-3).
- H.1 vs Part E class conversion scope ambiguity (HCE-4).
- `pending-retries.ts` exclusion undocumented (HCE-5).
- Mock count stale (HCE-6).
- Test factory specification missing (HCE-7).
- `LazyBin` second-consumer circularity (HCE-8).

**Recommendation: ACCEPT-WITH-EDITS.**

**Drop before executing:**
- `LazyBin<TName, TResolved>` → `LazyBin<TName>` (HOE-1).
- `obj: object` → `obj: Record<string, unknown>` (HOE-2).
- `PinoLogger` contingency shape from `03-class-boundaries.md` C1
  (HOE-4).
- H.2b from the summary table (HOE-6).
- H.1 test coverage requirement 1 (HOE-7).

**Reformat before executing:**
- Phase H.0 → front-matter prerequisite (HOE-3).
- HR2 mock-shape table → cross-reference to `04 §L` (HOE-5).

**Re-measure before executing:**
- 88 → measured (HCE-1, HCE-9).
- 91 → measured (HCE-6).

**Specify before executing:**
- H.2a `createTestLogger()` factory (HCE-7).
- `LogFn` at `process-lock.ts:19` is the alias, not the triple
  (HCE-2).
- `format.ts` / `env.ts` / `pending-retries.ts` exclusions
  (HCE-3, HCE-5).
- `LazyBin` second-consumer documentation (HCE-8).
- `bun --bun vitest` carve-out verification (HCE-10).
- H.1 ≠ Part E class conversion (HCE-4).
- H.2b's two-resolver files (HCE-11).