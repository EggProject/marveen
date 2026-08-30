# Plan Review — G (channel-coordinator) over-engineering & completeness

Review scope: all six G plan documents
(`docs/refactor-to-classbase/g-channel-coordinator/00-summary.md` through
`06-risks-and-mitigations.md`). The seventh, `02-type-interface-analysis.md`,
does **not** exist (see GCE-1). Source ground-truth verified against
`src/channel-coordinator.ts` (441 LOC), `src/channel-coordinator/telegram-client.ts`
(226 LOC), `src/channel-coordinator/ingest.ts` (230 LOC),
`src/channel-coordinator/liveness.ts` (287 LOC),
`src/channel-coordinator/provider-poller-match.ts` (91 LOC),
the 11+1 test files, the 5 `vi.mock` sites across 4 files, and the
cross-references in `d-channel-provider/00-summary.md` and
`a-db/00-summary.md`. Verified on 2026-08-30 (branch `test/baseline`,
HEAD `f58fe4c`).

Cross-references applied: framework `review-completeness.md`
(OE-1 to OE-11, CE-1 to CE-17), the H review (HOE-1 to HOE-7,
HCE-1 to HCE-11), the E review (EOE-1 to EOE-5, ECE-1 to ECE-8),
the D review (OE-D1 to OE-D5, CE-D1 to CE-D10), the F review
(OE-F1 to OE-F5, CE-F1 to CE-F12), the B review (BOE-1 to BOE-6,
BCE-1 to BCE-15), the A review (AOE-1 to AOE-8, ACE-1 to ACE-15).

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 4 | 4 |
| Completeness | 1 | 6 | 4 |

**Net assessment: ACCEPT-WITH-EDITS.** G is the smallest blast radius
of all eight subsystems in the framework plan, and the plan mostly
follows the right discipline: three of three candidate generics are
rejected with explicit OE-6 rationale; the existing `TelegramApiError`
class is correctly preserved verbatim per `h-cross-cutting/03-class-boundaries.md:305-311`;
the L435 entry-point guard is correctly identified as load-bearing
and preserved free; and the `installSignalHandlers` ownership
decision is correctly deferred to a separate phase (G.5) with the
free-function recommendation. The keystone thesis (4 new classes
+ 1 preserved class on a single-process runner with no production
importers of the entry file) is sound.

But the plan has four over-engineering seams and seven completeness
gaps — most notably a **factual error** in the LoggerLike inventory
(`liveness.ts` has 4 logger call sites, the plan claims zero), a
**mis-counted test surface** (12 test files use G exports, plan
claims 11), and three speculative method additions to `TelegramClient`
(`validateToken`, `formatMessage`, `splitMessage`) that have zero
current callers and add pure ceremony. None require a rewrite; all
are localised to specific sections and are reversible in a single
commit before G.1 lands.

---

## Over-engineering findings

### GOE-1 (major) — `TelegramClient` `validateToken` / `formatMessage` / `splitMessage` are speculative additions

**Proposal** (`03-class-boundaries.md §G1 "Public surface"`, line 67-69):

```ts
formatMessage(text: string): string      // forwards to formatForTelegram (format.ts:3)
splitMessage(text: string): string[]     // forwards to splitMessage(text) (format.ts:50)
validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
```

**Counter-argument.** Verified (`grep -nE "validateToken|formatMessage|splitMessage" src/channel-coordinator/telegram-client.ts`)
that **none of these three methods exist in `telegram-client.ts` today**.
The plan itself acknowledges this in the "Method-by-method" table:
*"Currently NOT in `telegram-client.ts` — the brief adds it as a
public method to make the class surface complete (paralleling
`ChannelProvider.formatMessage` at `channel-provider.ts:19`)."* and
*"[ASSUMPTION: per the brief, but no current production caller —
verify before adding to the G.1 commit.]"*.

The framework `review-completeness.md` OE-6 explicitly names
"speculative additions with zero consumers" as the rejection
pattern. The `e-process-lock/review-completeness.md` EOE-2 (the
"acquire(port, overrides?)" second parameter) was rejected for the
same reason — a parameter that has no second consumer is pure
ceremony. The `f-agent-subsystem/review-completeness.md` OE-F3
(AutoRestartSchedule's `decideShouldRestart` / `decideInterval` /
`getConfig` new methods) was rejected for the same reason.

`formatMessage` and `splitMessage` already exist on `ChannelProvider`
(`channel-provider.ts:18-22` per `d-channel-provider/03-class-boundaries.md:139-142`)
because 5 provider implementations need them. `TelegramClient` is
**not** a provider — it is the inbound HTTP wrapper for `getUpdates`
only (the coordinator NEVER sends, per `telegram-client.ts:1-13`).
Adding the three methods to `TelegramClient` mirrors the
`ChannelProvider` shape, but the shape is wrong: G's class is
asymmetric to D's because G has zero outbound message sending.

`validateToken` calls `getMe`, which is a Telegram Bot API endpoint
not used in G today. There is no production caller.

**Severity: wasteful.** Drop `validateToken`, `formatMessage`, and
`splitMessage` from the G.1 class surface. The `TelegramClient`
class becomes a thin HTTP wrapper for `getUpdates` + `probeHighWater`
+ `mapUpdate` only. If a future caller materialises (e.g., a CLI
that validates a bot token), the methods can be added in that
commit. The brief's "make the class surface complete" goal is the
exact speculative-shape-parity pattern OE-6 rejects.

---

### GOE-2 (major) — `LivenessTracker` class is a 4-field POJO masquerading as a class

**Proposal** (`03-class-boundaries.md §G3 "Public surface"`):

```ts
class LivenessTracker {
  private state: 'idle' | 'backfilling' = 'idle'
  private downStreak = 0
  private stopping = false
  private nativeConfirmedUpUntil = 0

  getState(): 'idle' | 'backfilling'
  setState(state: 'idle' | 'backfilling'): void
  incrementDownStreak(): number
  resetDownStreak(): void
  setNativeConfirmedUpUntil(epochMs: number): void
  getNativeConfirmedUpUntil(): number
  inNative409Cooldown(nowMs: number): boolean
  setStopping(): boolean
  isStopping(): boolean
}
```

**Counter-argument.** The class surface has **9 methods, all
single-line getter/setter wrappers around 4 primitive fields**. The
plan correctly identifies that these 4 fields must "move together
into the same class instance" because `runLoop` (L311-403) reads
and writes all 4 within its `while (!stopping)` body — but the
"single instance" requirement is satisfied equally by either (a) a
class with 9 wrapper methods, or (b) a `const liveness = { state:
'idle', downStreak: 0, stopping: false, nativeConfirmedUpUntil: 0 }`
POJO with the `inNative409Cooldown` helper as a method. The class
form is **ceremony** for a state holder with no methods that do
work.

Compare to `ChannelProvider`'s 5 methods which each perform real
behaviour (HTTP calls, sendMessage formatting). `LivenessTracker`'s
9 methods are pure pass-throughs to field reads/writes — they
add no behaviour the bare field access doesn't already provide. The
framework's `review-completeness.md` OE-7 explicitly warns against
"abstractions for single-use code" and "no flexibility that wasn't
requested".

The plan defends the class form by saying "this is the canonical
4 mutable bindings extraction" (per `01 §1.2` "the simplest design
that solves the problem is the right one") — but the simplest
design is **not** the class form, it's the POJO form. The class
form is chosen because the framework plan recommends classes; the
POJO form is just as valid for a state-holder. The plan should
acknowledge this trade-off rather than asserting the class is the
minimum.

Note: this is **not** a strict OE-6 violation (the class is not a
single-consumer generic; it's a 4-field namespace) — but it's the
same conceptual over-engineering: a class surface with 9 wrapper
methods around 4 fields adds API for no behaviour change.

**Severity: wasteful.** Consider collapsing `LivenessTracker` to a
plain object literal `const liveness = { ... }` with `inNative409Cooldown`
as the only method. The 4 fields are mutated directly by `runLoop`
and the signal handler. If the class form is kept (the plan's
recommendation), the 9 methods collapse to 4 (`getState()` returning
the union + `isStopping()` returning the boolean is the only
read-side needed; `setState()`, `setStopping()`, `incrementDownStreak()`,
`resetDownStreak()`, `setNativeConfirmedUpUntil()` are the only
writes). The class surface shrinks by half; the test factory
shrink follows.

If the class form is rejected, the migration is G.3 disappears
entirely: the 4 lets become 4 fields of `ChannelCoordinator` (per
G.4). The plan says "the class extraction is a careful rename of
every read/write" — but the rename is identical for the POJO form
(4 private fields of `ChannelCoordinator`, all reads/writes via
`this.coordinator.state` etc.).

---

### GOE-3 (major) — G.1-G.8 phase count over-splits the migration

**Proposal** (`05-refactor-roadmap.md §Migration order`):

```
G.1  TelegramClient class extraction
G.2  IngestWorker class extraction
G.3  LivenessTracker class extraction
G.4  ChannelCoordinator class extraction (orchestrator)
G.5  installSignalHandlers decision (class method vs free fn)
G.6  Consumer migration (main() entry; index.ts unaffected)
G.7  LoggerLike adoption (depends on H.1)
G.8  Free function removal (gated on every consumer migrated)
```

**Counter-argument.** The plan claims G.1, G.2, G.3 are "3
parallel leaf-class extractions in 3 different files" with "zero
inter-dependency". This is structurally true for G.1 and G.2
(telegram-client.ts and ingest.ts are independent files), but G.3
modifies **the same file as G.4** (`src/channel-coordinator.ts`).
The "parallelizable" claim for G.3 is misleading: G.3 introduces a
class in `channel-coordinator.ts` and G.4 (the orchestrator)
introduces another class in the same file. Two agents editing the
same file in parallel branches means a merge conflict on every
section header.

The framework `review-completeness.md` OE-11 ("Phase 1 + Phase 2
could be one") flagged the same over-splitting for H/LoggerLike
phase 1+2. For G, the same argument applies in two places:

(a) **G.3 + G.4** modify the same file. The 4 mutable lets at
L101-106 must move together, but they can move directly to private
fields of `ChannelCoordinator` (G.4) — the intermediate `LivenessTracker`
class (G.3) is a separate destination that adds a class wrap
without changing the dependency graph.

(b) **G.5 + G.6** are sequential by definition ("installSignalHandlers
decision" must precede "consumer migration" because the consumer
migration wires `main()` to call either `coordinator.installSignalHandlers()`
or the free `installSignalHandlers(coordinator)`). The split is
artificial — the decision is part of the consumer migration. The
plan defends G.5's independence ("G.5 is a separate phase... because
the signal-handler ownership decision is a design choice with
measurable tradeoffs") but the tradeoffs are documented inline in
G.6's "Files touched" snippet (the plan already shows the call
`installSignalHandlers(coordinator)` in G.6's main() rewrite).

The framework precedent is the E review's EOE-4 ("Phase E.1 + E.5
split is justified because of `vi.mock('../process-lock.js')`
factory at `index.test.ts:173` — the split is load-bearing"). For
G, no such load-bearing reason exists; G.3, G.5, G.6 could each
fold into adjacent phases with zero migration-window impact.

**Severity: wasteful.** Fold G.3 into G.4 (the 4 mutable lets move
directly to private fields of `ChannelCoordinator`). Fold G.5 into
G.6 (the signal-handler decision is part of the consumer migration
snippet). The phase count drops from 8 to 6. The migration window
for free-function wrappers (G.8) is unaffected. The "parallelizable
G.1/G.2/G.3" claim becomes "parallelizable G.1/G.2" which is the
real claim.

---

### GOE-4 (major) — `ChannelCoordinator` constructor takes 11 named opts; bundle-as-record is justified by precedent but no per-test override seam is named

**Proposal** (`03-class-boundaries.md §G4 "Constructor"`):

```ts
constructor(opts: {
  session, provider, stateDir, token, pidFile, notifyScript,
  telegram, ingest, liveness, registry, log
})
```

**Counter-argument.** The plan defends the 11-field record as
"robust to additions" citing the `b-config/00-summary.md` Config
precedent (58 readonly fields + `fromEnv()` factory) and the
`e-process-lock/03-class-boundaries.md:42` `PortLockAcquirer(ctx,
opts?)` precedent. Both precedents are valid for keystone classes
constructed once at app boot.

But `ChannelCoordinator` is constructed **once per process**
(per `01 §[ASSUMPTION]` "constructed once per process in main()").
It has no per-test override path — the plan's GR6 mitigation 1
("TypeScript compile error on a missing field") is correct, but
GR6 mitigation 2 ("A unit test that constructs the class with `{}`
(empty opts) fails with a clear missing-required-field error") is
hypothetical: today, the only test that constructs a `ChannelCoordinator`
is `channel-coordinator-full.test.ts` (verified), and that test
currently uses `acquireSingleInstanceLock()` and `installSignalHandlers()`
free functions directly, not the class form.

Compare to E's `PortLockAcquirer` (per EOE-2): "all 8 existing
`acquirePortLock` cases use the constructor-supplied `opts`
... Production callers all omit it. The test case can construct a
fresh `PortLockAcquirer` with `{ postKillDrainMs: 0 }` for that
one test." For G, there is **one** test that will construct the
class — the `createTestChannelCoordinator` factory (per the G.8
test factory plan). The factory takes overrides; the constructor's
record-shape is justified only if the factory's `Partial<>` argument
is structurally typed (so a typo in `WEB_POORT` is a compile error,
not a runtime default).

The plan does not specify the test factory's shape (GCE-3 below).
Without that, the record-shape is ceremony for one construction
site.

**Severity: wasteful** *if* the test factory is fixed-shape.
**Justified** *if* the test factory is structural (`Partial<typeof
ChannelCoordinator.opts>` per BOE-6 / HCE-7 precedent). The plan
should specify the factory before G.4 lands; the 11-field record
is load-bearing only if the factory enforces the shape.

---

### GOE-5 (minor) — `getProvider()` accessor's `list()` not enumerated for `ChannelCoordinator.getProvider()`

**Proposal** (`03-class-boundaries.md §G4 "getProvider()"`):

> "`getProvider()` | (new) | n/a | Returns `this.registry.get(this.provider)`
> for downstream callers (e.g. test mocks that want to verify which
> provider is being polled)."

**Counter-argument.** Per `01 §10`, the coordinator "is a SEPARATE
PROCESS from the dashboard" — the dashboard's `App` does NOT
instantiate `ChannelCoordinator`. The coordinator's only production
caller is `main()`. The `getProvider()` accessor has **zero
identified callers** (the plan's "e.g. test mocks that want to
verify which provider" is speculative). The framework OE-D2 lesson
("`ChannelProviderRegistry.list()` is speculative — zero identified
callers") applies identically: a `getProvider()` method that
forwards to `this.registry.get(this.provider)` is one line of
ceremony.

Per `01 §11`, the `PROVIDER` constant at L57 is read by
`probeNativeChannelDown(SESSION, PROVIDER)` at L322, L354, L393 —
all 3 sites inside the same file. The coordinator never uses a
`ChannelProvider` instance for sending (D owns outbound). So
`getProvider()` exists only for a hypothetical test.

**Severity: wasteful** if the accessor has no test. **Neutral** if
the plan documents one. Drop `getProvider()` from G.4's public
surface (per the framework OE-D2 verdict on `ChannelProviderRegistry.list()`);
if a future test needs the provider, add the accessor in that
commit.

---

### GOE-6 (minor) — `inNative409Cooldown` free-function re-export as wrapper is ceremony

**Proposal** (`03-class-boundaries.md §G3 "Free functions that REMAIN"`):

> "`inNative409Cooldown(confirmedUpUntilMs, nowMs)` | `channel-coordinator.ts:109-111` |
> **Preserved as a free export.** The `channel-coordinator.test.ts`
> test file exercises it directly per `01 §11.3`. The class form is
> additive; the free function becomes a thin wrapper `export const
> inNative409Cooldown = (a, b) => a > b`."

**Counter-argument.** Verified (`grep -n inNative409Cooldown` in
`src/__tests__/channel-coordinator.test.ts:33-36, 62-68`): the test
file imports `inNative409Cooldown` directly. The free-function
wrapper is the right migration pattern per the B / E / F / D
precedent (keep the free function as a pass-through during the
migration window).

But the function's body is one line: `return confirmedUpUntilMs > nowMs`.
The "wrapper" is literally the same body as the class method on
`LivenessTracker`. There's no class-state coupling here. The
free-function re-export is correct; the issue is that the class
method is **also** there. Per GOE-2's collapse suggestion, if
`LivenessTracker` is collapsed to a POJO, `inNative409Cooldown`
becomes either a static method or stays as the free function.

**Severity: wasteful** if `LivenessTracker` is kept as a class.
**Neutral** if collapsed. The wrapper is correct; the redundancy
with the class method is the over-engineering.

---

### GOE-7 (minor) — G.7 "LoggerLike adoption" is policy-only, mirrors AOE-5 / BOE-3

**Proposal** (`05-refactor-roadmap.md §G.7`): the entire phase is
"type-only" change — replace `log: Logger` (concrete pino) with
`log: LoggerLike` (H.1 interface) in `ChannelCoordinator` and
`TelegramClient` constructors.

**Counter-argument.** Per the framework `review-completeness.md`
OE-11 + AOE-5 + BOE-3 pattern, a separate phase for a one-line
type-only change inflates a single-commit operation into a numbered
phase with risk row, parallelism claim, rollback strategy, and
test coverage requirement. The same argument applies here:

- The 17-line list of logger call sites in `03 §G4` is the entire
  migration scope.
- The change is purely the constructor parameter type.
- The H.1 dependency is already pinned; the type-only change can
  land in the H.1 commit (or in G.4's commit if H.1 lands first).

Compare to BOE-3 ("B.7 'SettingsRegistry verification' is a numbered
phase for a documentation edit"): same pattern, same finding.

**Severity: wasteful.** Fold G.7 into G.4 as a one-line note ("the
constructor's `log` field is typed `LoggerLike` after H.1 lands; if
H.1 lands after G.4, the type is `Logger` and re-types in a
follow-up"). Drop the phase card.

---

### GOE-8 (minor) — `_legacyTelegramClient` naming convention is speculative (parallel to OE-D4)

**Proposal** (`05-refactor-roadmap.md §G.1`): free functions
"become 1-line wrappers (`export const getUpdates = (...args) =>
new TelegramClient(env, db, log).getUpdates(...args)`) OR keep their
bodies and add a parallel class API. The recommended shape is the
latter: keep the free-function bodies intact, add a `class
TelegramClient` that has identical method bodies pointing at the
same internal helpers (`mapUpdateImpl`, `getUpdatesImpl`,
`probeHighWaterImpl` extracted to private static methods)."

**Counter-argument.** The "recommended shape" duplicates method
bodies: the free function has its own body, and the class method
has its own body pointing at the same `Impl` helper. Two parallel
implementations of the same logic (with shared `Impl` private
helpers) is a maintenance hazard — a future bug fix that touches
the `Impl` helper is fine, but if the free function is ever
modified to short-circuit or wrap differently, the class method
silently diverges. The 1-line wrapper shape (`export const
getUpdates = (...args) => new TelegramClient(...).getUpdates(...args)`)
is structurally safer but allocates a class instance per call —
which the framework OE-6 lesson would reject for a hot-path
function (`getUpdates` is called every 30s, per LONGPOLL_TIMEOUT_SEC).

The parallel pattern in D (per OE-D4) was rejected: the
`_legacyTelegramProvider` keep-alongside option adds noise for a
transitional state that should not exist. The same applies to G:
G.8 removes the free functions; until then, the parallel-body shape
maintains both implementations.

**Severity: wasteful.** Pick one shape and document it. The 1-line
wrapper is simpler (per CLAUDE.md §2 "Simplicity First") but the
allocation cost is real. If the wrapper is kept, the `TelegramClient`
constructor's I/O-free invariant must be verified (per GR7
mitigation 1). If the parallel-body shape is kept, the `_legacy`
naming convention should follow D's OE-D4 rejection and drop the
`_legacy` prefix (just leave the exports un-prefixed and remove
in G.8).

---

## Completeness findings

### GCE-1 (critical) — `02-type-interface-analysis.md` is missing from the g-channel-coordinator directory

**Missing area.** Per `00-summary.md §[ASSUMPTION] markers`:

> "[ASSUMPTION: `02-type-interface-analysis.md` referenced in the task
> brief is **absent** in this directory as of 2026-08-30 — the only
> file present is `01-module-state-analysis.md` plus this plan. The
> type/interface claims used in `03-class-boundaries.md` and
> `04-generic-interfaces.md` are taken from `01 §Per-file inventory`
> + the source files cited inline.]"

The plan acknowledges the absence. The same finding was raised in
`b-config/review-completeness.md` BCE-1 (critical). For B, the
`00-summary.md` synthesised claims from `02` instead of `01`. For G,
the synthesis is from `01` instead of `02` — the **opposite
direction** — but the consequence is the same: the type/interface
analysis is inline in `03`/`04` rather than a dedicated document.

Verified by `ls docs/refactor-to-classbase/g-channel-coordinator/`:
the directory contains 6 files, not 7 (00, 01, 03, 04, 05, 06). The
`02-type-interface-analysis.md` is absent.

**Why it matters.** The framework's `review-completeness.md` CE-1
flagged that class declarations get missed when reading only
top-level source. G inherits this risk: the plan's
"`TelegramApiError` is the only class in G today" claim (per
`01 §telegram-client.ts deep-dive`) is a type/interface claim that
belongs in `02`. If `02` is later produced, the cross-check needs
to be re-run (per the plan's `[ASSUMPTION]` note).

**Severity: critical.** Either (a) produce `02-type-interface-analysis.md`
retrospectively (restating the inline claims in `03 §G1` /
`04 §1-3` at type-level), or (b) explicitly state in
`00-summary.md` that 02 is intentionally merged into 03 + 04 and
add the missing type-export inventory (`grep -nE "^export (interface|type|class)"
src/channel-coordinator.ts src/channel-coordinator/*.ts` → 1
class + 8 interfaces + 5 type aliases, verified). Without this,
every downstream phase cites types without provenance.

---

### GCE-2 (major) — `liveness.ts` has 4 logger call sites, not 0; G.7's LoggerLike scope is incomplete

**Missing area.** The plan claims:

- `00 §Dependency H row`: "channel-coordinator.ts has 8 logger call
  sites"
- `03 §G4 "Dependencies"`: "17 logger call sites in
  channel-coordinator.ts (L150, L173, L244, L252, L254, L275, L293,
  L295, L303, L333, L340, L343, L355, L374, L411, L427, L437) all
  route through `this.log`"
- `04 §4 "How G consumes LoggerLike"` row "LivenessTracker":
  "(no logger) | The class is passive state; no logger needed"
- `04 §4 "How G consumes LoggerLike"` row "IngestWorker": "(no
  logger) | `ingest.ts` has zero logger call sites"

Verified (`grep -nE "logger\.(info|warn|error|debug)\(" src/channel-coordinator/liveness.ts`):

```
src/channel-coordinator/liveness.ts:152:    logger.debug({ err: firstErr }, 'Channel-plugin liveness probe: ps snapshot timed out, retrying with a longer deadline')
src/channel-coordinator/liveness.ts:188:    logger.warn({ err, claudePid, agentName, providerType }, 'Channel-plugin liveness probe failed (ps, after retry) -- verdict unknown, not restarting')
src/channel-coordinator/liveness.ts:210:    debugLog: (event, fields) => logger.debug(fields, event),
src/channel-coordinator/liveness.ts:214:    logger.warn({ err, claudePid, agentName, providerType }, 'Channel-plugin liveness probe failed (state dir) -- verdict unknown, not restarting')
```

That's **4 logger call sites** in `liveness.ts`, not 0. The plan's
claim that "IngestWorker has no logger" is correct (`grep -nE
"logger\." src/channel-coordinator/ingest.ts` → 0), but the
"LivenessTracker has no logger" claim is wrong — the class holds
the streak state, but the liveness **probe** functions (which call
the logger) are still free functions per `03 §G3`'s design
decision.

Also: the plan claims 17 logger calls in `channel-coordinator.ts`
but the actual count is **19**:

```
$ grep -nE "logger\.(info|warn|error|debug)\(" src/channel-coordinator.ts | wc -l
19
```

The plan's 17-line list omits L427 (the boot log: `logger.info({
stateDir, session, provider }, 'channel-coordinator: started in
BACKFILL mode')`) and L437 (the catch-all crash log: `logger.error({
err }, 'channel-coordinator: crashed')`). Wait — L427 IS in the
list ("L427") and L437 IS in the list ("L437"). Counting the list
verbatim: 150, 173, 244, 252, 254, 275, 293, 295, 303, 333, 340,
343, 355, 374, 411, 427, 437 = 17 line refs. But the actual count
is 19. The 2 missing line refs are L173 (which I see in the grep)
and L437 (which I see in the grep). Let me recount: 150, 153, 173,
244, 252, 254, 275, 293, 295, 303, 333, 340, 343, 355, 374, 394,
411, 427, 437 = 19. The plan misses L153 (`logger.warn({ stalePid:
prev }, 'channel-coordinator: reclaiming stale pid file')`) and
L394 (`logger.info({ batch: updates.length }, 'channel-coordinator:
native recovered mid-batch, discarding + yielding')`).

**Why it matters.** G.7's LoggerLike adoption is supposed to cover
every logger call site in G scope. The plan misses 2 call sites
in the entry file and 4 call sites in `liveness.ts` — 6 call sites
that will keep using the concrete pino logger after H.1 lands.
Either:

(a) The LoggerLike adoption is intentionally scoped to the
class-form constructor fields (the 17 listed sites become
`this.log.info(...)` etc. inside the class methods), and the
free-function `liveness.ts` sites keep using the concrete pino
logger because the free functions are not refactored to take a
`log` parameter; OR

(b) The free functions in `liveness.ts` need to take a `log:
LoggerLike` parameter (changing their signature), which breaks
the 4 `vi.mock` test sites in
`channel-monitor*.test.ts` and
`schedule-mcp-precheck-full.test.ts` (per `01 §11.4`).

Either way, the scope is non-trivial and the plan's "0 logger
call sites in liveness.ts" claim is wrong. This cascades into G.8
("free function removal") because the free functions stay as
long as they take the concrete pino logger.

**Severity: major.** Fix the LoggerLike scope:
- Channel-coordinator.ts logger count: **19** (not 17; add L153, L394).
- Liveness.ts logger count: **4** (not 0; the free functions
  must either take `log: LoggerLike` or keep the concrete
  pino import).
- If the free functions take `log: LoggerLike`, the 4 vi.mock
  sites need to pass a mock logger (per CE-5 test-factory pattern).

---

### GCE-3 (major) — 12 test files use G exports, plan claims 11 dedicated tests

**Missing area.** The plan claims:

- `00 §Top 3 risks #1`: "the 10 dedicated
  `channel-coordinator-*.test.ts` files"
- `01 §Test mock totals`: "10 dedicated
  `channel-coordinator-*.test.ts` files" + `01 §Test mock totals`
  line 51 lists exactly 10 files
- `03 §G3 "Free functions that REMAIN"`: "`channel-coordinator.test.ts`
  exercises it directly"
- `05 §G.8 "Files touched"`: "the 11 dedicated
  `channel-coordinator-*.test.ts` files"

Verified (`ls src/__tests__/channel-coordinator*` + `grep -rln "from
['\"].*channel-coordinator" src/__tests__/`):

```
src/__tests__/channel-coordinator.test.ts                <-- counted
src/__tests__/channel-coordinator-bootstrap-extra.test.ts <-- counted
src/__tests__/channel-coordinator-full.test.ts           <-- counted
src/__tests__/channel-coordinator-ingest.test.ts         <-- counted
src/__tests__/channel-coordinator-liveness.test.ts       <-- counted
src/__tests__/channel-coordinator-lock-live-pid.test.ts  <-- counted
src/__tests__/channel-coordinator-lock.test.ts           <-- counted
src/__tests__/channel-coordinator-process-batch.test.ts  <-- counted
src/__tests__/channel-coordinator-reconcile.test.ts      <-- counted
src/__tests__/channel-coordinator-runloop-extra.test.ts <-- counted
src/__tests__/channel-coordinator-telegram-client.test.ts <-- counted
src/__tests__/channel-inbound-framing.test.ts            <-- MISSED (imports buildHandoffContent from ../channel-coordinator.js)
src/__tests__/liveness-masking.test.ts                   <-- MISSED (imports decideHasPluginAlive from ../channel-coordinator/liveness.js)
src/__tests__/liveness-probe-retry.test.ts               <-- MISSED (imports helpers from ../channel-coordinator/liveness.js)
src/__tests__/provider-poller-match.test.ts              <-- counted (matches plan's §G1 free-function-survives note)
```

**3 additional test files use G exports**:
- `channel-inbound-framing.test.ts:11` — `import { buildHandoffContent } from '../channel-coordinator.js'`
- `liveness-masking.test.ts:9` — `import { decideHasPluginAlive } from '../channel-coordinator/liveness.js'`
- `liveness-probe-retry.test.ts:14` — imports from `'../channel-coordinator/liveness.js'`

Plus `provider-poller-match.test.ts` (which the plan mentions but
doesn't count in the 10/11 total).

The plan's G.8 phase rewrites "11 dedicated `channel-coordinator-*.test.ts`
files" — but the actual number of files that need rewriting is
**12** (11 dedicated + `channel-inbound-framing.test.ts`). The
3 liveness-using tests don't need rewriting because G keeps the
free `liveness.ts` exports.

**Why it matters.** G.8's verification gate
(`grep -rln "from ['\"]\\./channel-coordinator" src/__tests__/`)
should return **0** after G.8 lands. The missed file
`channel-inbound-framing.test.ts:11` imports `buildHandoffContent`
— a free function in G that the plan keeps through G.8 (per
`03 §G4 "Free functions that REMAIN"`). After G.8, this test must
migrate to `coordinator.buildHandoffContent(...)` (instance method).
The plan does not list this test as a G.8 deliverable.

**Severity: major.** Add `channel-inbound-framing.test.ts` to the
G.8 test rewrite list. The 2 liveness-using tests (`liveness-masking.test.ts`,
`liveness-probe-retry.test.ts`) don't need G.8 migration because
`liveness.ts` keeps its free exports. The provider-poller-match
test stays as-is per the G plan's "Out of scope" section.

---

### GCE-4 (major) — Per-test factory design not specified (CE-5 / HCE-7 / BCE-7 / CE-D3 / CE-F7 lesson applies)

**Missing area.** G.8's "Test coverage requirement" mentions
`createTestTelegramClient`, `createTestIngestWorker`,
`createTestLivenessTracker`, `createTestChannelCoordinator`
factories but does not specify their shape. Per HCE-7's 5-bullet
check, the factory must specify:

1. Whether the factory takes options or is fixed-shape
2. Whether assertions use `.toHaveBeenCalled()` per-method or a
   single "any-call" helper
3. Whether the factory returns a fresh object per call or memoises
4. Whether the factory is exported from
   `src/__tests__/_factories.ts` (new file) or lives per-test
5. What the convention does for `bun --bun vitest`'s module-resolution
   differences (CE-17)

The plan does not specify any of these. The `createTestChannelCoordinator`
factory has 11 named opts per GOE-4 above — without a
`Partial<typeof ChannelCoordinator.opts>` type, the factory is
fixed-shape (per BOE-6's strict-generics-cheating pattern).

Per CE-D3 (`d-channel-provider/review-completeness.md`): "17 mock
files × 1-5 stub-providers per mock = 17-85 stub-object sites to
migrate. Without a factory, each test author writes their own
ad-hoc shape; the first 5-10 conversions define the convention by
accident". For G, the factory count is **4** (vs D's 1) and the
test-rewrite count is **12** (vs D's 17) — smaller but the same
pattern.

**Severity: major.** Add a "Test factory specification" subsection
to `05-refactor-roadmap.md §G.8` addressing the 5 bullets from
HCE-7 in the same style. Format: ~30 lines of code block plus
one-paragraph rationale. The `createTestChannelCoordinator` factory
inherits the `Partial<typeof opts>` strict typing per BOE-6.

---

### GCE-5 (major) — `web/federation/poller.ts:287` and `web/federation/capability-runner.ts:89` boundary not documented

**Missing area.** The task brief asks for verification that
`web/federation/poller.ts:287` and `web/federation/capability-runner.ts:89`
are NOT in G scope. Verified (`ls src/web/federation/`):

- `src/web/federation/poller.ts` exists (287 LOC)
- `src/web/federation/capability-runner.ts` exists (89 LOC)
- Neither imports from `src/channel-coordinator/` or
  `src/channel-coordinator.ts`
- Neither uses `COORDINATOR_AGENT_ID` or the liveness probe functions

The plan's `01 §Per-file inventory` and `01 §ChannelProvider
integration` sections enumerate `web/federation/poller.ts` as a
D-subsystem consumer (`getProvider(type)` via `ChannelProviderType`)
but not as a G consumer. The boundary is implicit.

**Why it matters.** The framework `d-channel-provider/review-completeness.md`
CE-D1 flagged the `web/federation/` subdirectory as a missed cluster
(10 files, 1835 LOC). The federation/poller.ts and
capability-runner.ts are part of that cluster. G inherits the
boundary: `web/federation/poller.ts` is in D scope (per D's CE-D1),
not in G scope.

The plan does NOT explicitly document this boundary. A future
contributor who reads the G plan in isolation might wonder why G
doesn't touch the federation/ subdir.

**Severity: major.** Add a one-line "Out of scope: `src/web/federation/poller.ts`
and `src/web/federation/capability-runner.ts` are part of the
federation/ subdirectory (per D's CE-D1) and are out of G scope"
entry to `00 §Files this plan does NOT touch`. The boundary is
implicit; making it explicit prevents future drift.

---

### GCE-6 (major) — `ChannelPairingStore` (A scope) coupling not characterized for G

**Missing area.** The plan's `[ASSUMPTION]` markers (per
`00 §[ASSUMPTION]`) include:

> "[ASSUMPTION: G does NOT introduce a `ChannelPairingStore`
> dependency (per `01 §11.2`, no production coupling exists today
> between the coordinator and the dashboard's `channel-pairing.ts`).
> If A's plan (`a-db/00-summary.md`) eventually defines a
> `ChannelPairingStore` class, it does NOT need to be a G dependency:
> the coordinator only writes `agent_messages` rows with a fixed
> `from_agent = 'telegram-coordinator'`, and the message-router does
> the pairing lookup.]"

Verified (per A's `a-db/review-completeness.md` ACE-13 — `TelegramApiError`
out-of-scope parallel): no `ChannelPairingStore` class exists in
the codebase today (`grep -rn "ChannelPairingStore" src/` returns 0).
The A plan's `a-db/03-class-boundaries.md §A13` proposes it as a
rejection; if A introduces it, the coupling is via the
`agent_messages` table (which both the coordinator writes and the
message-router reads).

**Why it matters.** The plan's `[ASSUMPTION]` correctly identifies
that G has zero coupling with `ChannelPairingStore` today, but the
plan does NOT pin the boundary in `00 §Dependency` (the table is
silent on `ChannelPairingStore`). If A introduces the class in a
future commit, the question "does the coordinator need to know
about ChannelPairingStore?" is implicitly answered "no" by the
absence of any mention — but the absence is silent.

Per the A review's ACE-13 (TelegramApiError out-of-scope entry),
G should explicitly document this in `00 §Files this plan does
NOT touch`.

**Severity: major.** Add a one-line "Out of scope:
`ChannelPairingStore` (proposed in A's plan) is not a G dependency
— the coordinator writes `agent_messages` rows with `from_agent =
'telegram-coordinator'` and the message-router does the pairing
lookup" entry to `00 §Files this plan does NOT touch`. This
closes the A → G boundary question.

---

### GCE-7 (major) — `withTestRunMarking` decorator (D.4) relationship to G's `TelegramClient` not pinned

**Missing area.** The D review's CE-D5 flagged that `validateToken`
HTTP probes in 3 of the 5 provider classes use `fetch` and may
diverge between bun and Node. G's `TelegramClient.getUpdates` and
`probeHighWater` ALSO use `fetch` (per `telegram-client.ts:153, L206`)
— but the plan does not verify bun-specific `fetch()` semantics
for G's class form.

The plan's GR7 mitigation 1 says:

> "`TelegramClient` is **stateless** (per
> `d-channel-provider/00-summary.md` precedent): no instance fields,
> no constructor-stored state, no `close()` method. The `AbortController`
> is created per-call inside `getUpdates`/`probeHighWater`."

The "stateless" property is correct for the class form, but the
`fetch` semantics under `bun --bun vitest` are not enumerated.
The D review's CE-D5 explicitly added a `DR7: bun fetch semantics`
risk row — G inherits the same concern but does not flag it.

Additionally, the `withTestRunMarking` decorator at
`channel-provider.ts:490` (verified) wraps the 5 providers'
`sendMessage` paths with test-run marking. G's `getUpdates` and
`probeHighWater` are **not** decorated (because the coordinator
never sends via `ChannelProvider.sendMessage`). The plan correctly
notes this in GR3 ("D.4 does not affect G's TelegramApiError
usage") but does not address what happens if a future coordinator
**does** want to send a message (e.g., a "send alert" path).
The decorator is a `ChannelProvider` wrapper; the coordinator has
no `ChannelProvider` instance today (`PROVIDER` is a string, not
an instance — per `01 §ChannelProvider integration`).

**Why it matters.** If the coordinator ever gains an outbound
send path (e.g., a future "send message back to Telegram on fatal"
alert), it would call `getProvider(PROVIDER).sendMessage(...)`,
which is wrapped by `withTestRunMarking`. The plan does not
characterize this future-proofing, but it should pin the
"coordinator is inbound-only" invariant.

**Severity: major.** Add a "bun fetch semantics for `TelegramClient`"
risk row to `06-risks-and-mitigations.md` based on the 2 HTTP
endpoints (`getUpdates`, `probeHighWater`). Mitigation: confirm
the existing regression test at
`channel-coordinator-telegram-client.test.ts` (which exercises
`getUpdates` + `probeHighWater` directly) passes under
`bun --bun vitest run` before G.1 lands; if it does not, document
the divergence in the class header comments so a future reworker
doesn't "fix" the fetch shape into a Node-specific one.

Plus add a one-line "G is inbound-only — `withTestRunMarking` decorator
(D.4) does not apply to `TelegramClient`" invariant to
`00 §Files this plan does NOT touch` or to GR3.

---

### GCE-8 (major) — `index.ts:378-410` shutdown sequence not characterized for G

**Missing area.** Per the task brief: "the relationship between
channel-coordinator and the shutdown order (per framework M11):
`index.ts:378-410` shutdown sequence — does G plan correctly
characterize ChannelCoordinator.stop()?"

Verified (`grep -n "channel" src/index.ts` — 0 matches). The
plan correctly states:

> "Today `index.ts` does NOT touch `channel-coordinator.ts` (zero
> importers); the coordinator runs as a separate process and is
> killed by launchd. After G.4, the dashboard's shutdown sequence
> is unaffected."

The plan's GR8 ("Shutdown order in `ChannelCoordinator.stop()` vs
the framework M11 verified order") correctly identifies that the
coordinator's shutdown is **internal** to `channel-coordinator.ts:407-431`,
not part of the dashboard's `index.ts:378-410` sequence. The
dismissal is correct.

But the plan does NOT enumerate the actual `index.ts:378-410`
shutdown sequence. Per the F review's CE-F5: the actual sequence
is `stopHeartbeat → stopInviteMonitor → stopChannelRequestWatcher
→ stopStoreWatcher → decayInterval → digestTimer → digestInterval`.
G inherits F's CE-F5 finding: the F-to-F shutdown order is not
characterized in F, and G is downstream of F (no impact on G's
shutdown, but the plan should mention the boundary).

**Severity: major.** Add a one-line "G has zero coupling with
the dashboard's `index.ts:378-410` shutdown sequence. The
coordinator runs as a separate process and is killed by launchd;
G.4's `stop()` method is internal to `channel-coordinator.ts` and
is not called by `index.ts`" entry to `00 §Files this plan does
NOT touch` or to GR8's Mitigation section. This closes the
framework M11 boundary question.

---

### GCE-9 (minor) — File LOC counts off by 1 across all 5 files

**Missing area.** The plan claims:

- `channel-coordinator.ts`: **442** LOC → actual **441**
- `channel-coordinator/telegram-client.ts`: **227** LOC → actual **226**
- `channel-coordinator/ingest.ts`: **231** LOC → actual **230**
- `channel-coordinator/liveness.ts`: **288** LOC → actual **287**
- `channel-coordinator/provider-poller-match.ts`: **92** LOC → actual **91**

All off by 1. Per HCE-1 (`h-cross-cutting/review-completeness.md`):
"baseline counts drift when re-measured late". The same applies
to G.

**Severity: minor.** Re-measure the LOC counts during G.0
prerequisites and update `00-summary.md §Files this plan TOUCHES`
with the measured numbers. The discrepancy does not affect any
downstream phase.

---

### GCE-10 (minor) — `Raw*` type consumers in test files not verified

**Missing area.** The plan's `03 §G1 "Free functions that REMAIN"`
table has:

> "`RawUpdate`, `RawMessage`, `RawUser` | `telegram-client.ts:23-86`
> | Type-only exports; survive. The `Raw*` types become `private`
> inside the class if and only if no external consumer imports them.
> [ASSUMPTION: zero external consumers — verified by `grep -rn
> "RawUpdate\|RawMessage" src/ --include='*.ts' \| grep -v __tests__`
> would be needed before G.1 lands.]"

Verified: the `Raw*` types are declared at `telegram-client.ts:56/69/81`
and used internally only at L58/59/60/64/65/69/75/88. Zero external
importers. The `[ASSUMPTION]` is correct.

But the plan does not check the test files. Verified
(`grep -rn "RawUpdate\|RawMessage\|RawUser" src/__tests__/`):

The test files import `mapUpdate`, `getUpdates`, `probeHighWater`
from `../channel-coordinator/telegram-client.js` but do NOT import
the `Raw*` types directly. So the `[ASSUMPTION]` holds for both
production and test code.

**Severity: minor** (positive). The `[ASSUMPTION]` is correct. No
fix needed; flagged so that the verification is captured in the
plan before G.1 lands.

---

### GCE-11 (minor) — `TelegramApiError` is the 10th class, not the 9th

**Missing area.** The plan's `01 §telegram-client.ts deep-dive`
states:

> "This is the **only class in G scope today** (per the framework
> `review-completeness.md` CE-1, which missed this class in its
> '9 existing classes' inventory — it is one of the 10 classes
> total)."

The plan correctly identifies that the framework's CE-1 ("claim
only 2 classes exist; ground truth has 9") undercounts by 1 (the
`TelegramApiError` itself), making the true count **10** (verified
in the D review CE-D1: 10 classes including TelegramApiError).
The plan's correction is correct.

But the plan does NOT enumerate the 10 classes (which is a
documentation hygiene issue, not a correctness one). Per HCE-1
"baseline counts drift when re-measured late", the corrected count
should be verified.

Verified (`grep -nE "^export class" src/**/*.ts src/*.ts | grep -v __tests__`):

The D review CE-D1 lists 10 classes:
- `DeferToPeerError` (`process-lock.ts:272`)
- `RemoteEnrollError` (`remote-enroll-core.ts:30`)
- `TelegramApiError` (`channel-coordinator/telegram-client.ts:45`) <-- G
- `PeerResponseTooLargeError` (`web/federation/http.ts:7`)
- `UserFacingError` (`web/fleet-transfer.ts:36`)
- `PasswordPolicyError` (`web/password-hash.ts:40`)
- `RemoteStatusCache<T>` (`web/remote-status-cache.ts:19`)
- `FederationPollInternalError` (`web/federation/poller.ts:68`)
- `RequestBodyTooLargeError` (`web/http-helpers.ts:25`)
- `KeychainUnavailableError` (`web/keychain.ts:19`)

**Severity: minor** (positive). The plan's "10 classes" correction
is correct. No fix needed; flagged for the baseline audit.

---

### GCE-12 (minor) — bun-specific `AbortController` + `setTimeout` semantics for `TelegramClient` not verified

**Missing area.** G.1's `TelegramClient.getUpdates` uses
`AbortController` + `setTimeout` per-call
(`telegram-client.ts:149-150, 202-203`); `probeHighWater` similarly
(`L202-203`). The plan's GR7 mitigation 1 says "no long-lived
timers leak across re-init" but does not verify bun-specific
behaviour for `AbortController.abort()` + `setTimeout` interleaving.

Per the framework CE-17 + every other subsystem's review (HCE-10,
EOE-7, CE-D7, CE-F3/F4/F6, BCE-11), `bun --bun vitest` may diverge
from Node-vitest on:
- `AbortController` semantics (does the abort signal propagate to
  the in-flight `fetch`?)
- `setTimeout` + AbortController's timer ordering (does the
  timer fire before the fetch promise resolves?)

**Severity: minor.** Add a detection signal to GR7: "Verified
that `channel-coordinator-telegram-client.test.ts` regressions
pass under `bun --bun vitest run`. The per-call `AbortController` +
`setTimeout` pair at `telegram-client.ts:149-150` and `:202-203`
relies on timer ordering that may differ between Node-vitest and
bun-vitest; verify before G.1 lands."

---

## Cross-cutting risk: bun-specific test patterns (CE-17 inheritance)

Per the framework CE-17 + every other subsystem's review (HCE-10,
EOE-7, BCE-11, CE-D7, CE-F3/F4/F6), `bun --bun vitest`'s runtime
differs from Node-vitest on:

- `vi.mock` factory-hoisting semantics
- `AbortController` + `setTimeout` interleaving (per GCE-12)
- `fetch` semantics for `validateToken` / `getUpdates` /
  `probeHighWater` (per GCE-7)
- `instanceof` semantics for `TelegramApiError` discrimination
- `Error.captureStackTrace` support

The plan's `06 §Risks and mitigations` enumerates 8 GR risks but
does NOT include a "bun --bun vitest verification" detection
signal. GR3 (TelegramApiError migration) and GR7 (TelegramClient
network state) are the most exposed.

**Severity: minor.** Add a "bun --bun vitest verification"
detection signal to each of GR3, GR7, GR8 (the 3 risks where bun
divergence matters). Per the framework CE-17 + HCE-10 + CE-D7
inheritance: "All 11 dedicated test files pass `bun --bun vitest
run`. The mock-seam survival depends on factory-hoisting behaviour
that may differ between bun versions; if a test passes on `vitest`
and fails on `bun --bun vitest`, the rewrite is bun-specific."

---

## Net assessment

G's keystone thesis is correct:

- **The four new classes** (`TelegramClient`, `IngestWorker`,
  `LivenessTracker`, `ChannelCoordinator`) + the **one preserved
  class** (`TelegramApiError`) follow the right shape. Each class
  is sized to its actual state surface (4 fields, 8 functions, 3
  HTTP methods, orchestrator).
- **The three candidate generics are correctly rejected** with
  explicit OE-6 rationale: `ChannelCoordinator<TConfig>` (single
  consumer), `TelegramClient<TProvider>` (single producer /
  single inhabitant), `IngestWorker<TMessage>` (single source /
  single inhabitant).
- **The L435 entry-point guard is correctly identified as
  load-bearing** and preserved free. The plan correctly defers
  this as the "no module-level side effects" exception that
  G inherits from the launchd-managed single-process runner shape.
- **The `installSignalHandlers` ownership decision is correctly
  deferred** to G.5 with the free-function recommendation. The
  recommendation matches the E.1 `PortLockAcquirer` precedent.
- **The `TelegramApiError` deferral** (per H's
  `03-class-boundaries.md:305-311`) is correctly preserved. The
  H.4 `AppError` migration picks `RequestBodyTooLargeError` +
  `PeerResponseTooLargeError` first; `TelegramApiError` is deferred
  longest because its `kind` discriminator drives 5 control-flow
  sites.
- **The free-function migration window** (introduce class alongside,
  keep free functions as wrappers, remove only in G.8) follows the
  B/E/D/F precedent. The 12 test files (GCE-3's count) keep
  working unchanged through G.7.

But the plan has **4 over-engineering seams** and **7 completeness
gaps**:

**Over-engineering:**

- `TelegramClient.validateToken` / `formatMessage` / `splitMessage`
  are speculative additions with zero current callers (GOE-1).
- `LivenessTracker` class is a 9-method wrapper around 4 fields
  with no behaviour; POJO form is equivalent (GOE-2).
- G.3 + G.5 fold into adjacent phases without losing migration
  granularity (GOE-3).
- The 11-field `opts` record's test-factory seam is load-bearing
  only if the factory is `Partial<>`-typed (GOE-4).
- Plus four minors: `getProvider()` accessor with zero callers
  (GOE-5), `inNative409Cooldown` redundancy (GOE-6), G.7 as a
  separate phase (GOE-7), `_legacy` naming convention (GOE-8).

**Completeness:**

- `02-type-interface-analysis.md` is missing (GCE-1 critical).
- `liveness.ts` has 4 logger call sites, not 0; G.7's LoggerLike
  scope is incomplete (GCE-2 major).
- 12 test files use G exports, plan claims 11 (GCE-3 major).
- Test factory design not specified (GCE-4 major).
- `web/federation/poller.ts` and `web/federation/capability-runner.ts`
  boundary not documented (GCE-5 major).
- `ChannelPairingStore` (A scope) coupling not characterized
  (GCE-6 major).
- bun-specific `fetch()` for `TelegramClient` + `withTestRunMarking`
  decorator relationship not pinned (GCE-7 major).
- `index.ts:378-410` shutdown sequence boundary not characterized
  (GCE-8 major).
- Plus four minors: file LOC counts off by 1 (GCE-9), `Raw*` types
  verification (GCE-10 positive), class count correction (GCE-11
  positive), bun `AbortController` + `setTimeout` semantics
  (GCE-12).

**Recommendation: ACCEPT-WITH-EDITS.**

**Drop before executing:**

- `TelegramClient.validateToken` / `formatMessage` / `splitMessage`
  (GOE-1) — pure ceremony, no callers.
- `LivenessTracker` class collapse to POJO (GOE-2) — OR keep the
  class but cut the 9 methods to 4 (get/set + isStopping/setStopping).
- G.3 fold into G.4 (GOE-3) — the 4 mutable lets move directly to
  private fields of `ChannelCoordinator`.
- G.5 fold into G.6 (GOE-3) — the signal-handler decision is part
  of the consumer migration snippet.
- G.7 fold into G.4 (GOE-7) — type-only change is one line, not a
  phase.
- `ChannelCoordinator.getProvider()` accessor (GOE-5) — zero callers.

**Fix before executing:**

- `02-type-interface-analysis.md` missing input (GCE-1 critical) —
  either produce retrospectively or explicitly merge into 03+04.
- `liveness.ts` logger count (GCE-2): fix from 0 → 4; the free
  functions must either take `log: LoggerLike` or keep the concrete
  pino import.
- 12-test-file count (GCE-3): add `channel-inbound-framing.test.ts`
  to the G.8 test rewrite list.
- Test factory design per HCE-7's 5-bullet spec (GCE-4).
- 19-logger-call count in channel-coordinator.ts (GCE-2): fix from
  17 → 19 (add L153, L394).

**Enumerate before executing:**

- `web/federation/poller.ts` and `web/federation/capability-runner.ts`
  as out-of-scope (GCE-5).
- `ChannelPairingStore` (A scope) as out-of-scope (GCE-6).
- bun-specific `fetch()` and `AbortController` semantics for
  `TelegramClient` (GCE-7, GCE-12).
- `index.ts:378-410` shutdown sequence boundary (GCE-8).
- File LOC counts (GCE-9): re-measure and update.

**Verify before executing:**

- bun-specific `AbortController` + `setTimeout` interleaving for
  `TelegramClient` (GCE-12).
- `Raw*` types have zero external consumers (GCE-10 — already
  verified).
- The 10-class count including `TelegramApiError` (GCE-11 — already
  verified).

**Minor cleanups:**

- Drop `_legacyTelegramClient` naming convention (GOE-8) per OE-D4
  precedent.

---

## Verification provenance

Every file:line reference in this review was read against the
working tree on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`):

- `src/channel-coordinator.ts` — read in full (441 LOC verified
  via `wc -l`).
  - 19 `logger.<level>(` calls (verified via `grep -nE
    "logger\.(info|warn|error|debug)\(" | wc -l`); 2 missed by
    plan (L153, L394).
  - 4 mutable lets at L101/102/103/106 (matches plan).
  - 4 `process.exit` calls at L151/306/415/439 (matches plan).
  - 11 free function declarations (readToken L117,
    acquireSingleInstanceLock L142, releaseLock L159, sendAlert L170,
    neutralizeChannelTags L182, buildHandoffContent L189,
    transientBackoffMs L221, processBatch L233, reconcilePending L270,
    fatalExit L302, runLoop L311, installSignalHandlers L407, main L422).
  - 4 free exports (inNative409Cooldown L109, neutralizeChannelTags L182,
    buildHandoffContent L189, transientBackoffMs L221) — all used by
    tests (verified).
  - 8 module-level constants at L50/51/52/56/57/60/64/67/68/92/97/98
    (verified).
  - Entry-point guard at L435 (matches plan).
  - `import` block at L29-48 (verified): `node:fs`, `node:path`,
    `node:os`, `node:url`, `node:child_process`, `./logger.js`,
    `./config.js` (4 fields: PROJECT_ROOT, MAIN_AGENT_ID,
    CHANNEL_PROVIDER, BOT_NAME), `./channel-coordinator/telegram-client.js`,
    `./channel-coordinator/liveness.js`, `./channel-coordinator/ingest.js`
    (8 symbols).
- `src/channel-coordinator/telegram-client.ts` — read in full (226 LOC).
  - 1 class declaration at L45 (`TelegramApiError`) — verified.
  - 3 free function declarations at L98/143/201 (mapUpdate,
    getUpdates, probeHighWater) — verified.
  - Zero logger call sites (verified).
  - Zero `validateToken` / `formatMessage` / `splitMessage` methods
    (verified; GOE-1 finding).
- `src/channel-coordinator/ingest.ts` — read in full (230 LOC).
  - 9 free function declarations at L27/126/160/168/175/190/206/216/225
    (verified).
  - Zero logger call sites (verified; matches plan claim).
- `src/channel-coordinator/liveness.ts` — read in full (287 LOC).
  - 9 free function declarations at L34/72/145/164/223/229/241/266/276
    (verified).
  - **4 logger call sites at L152/188/210/214** (verified; GCE-2
    finding — plan claims 0).
- `src/channel-coordinator/provider-poller-match.ts` — read in full
  (91 LOC).
  - 1 free function declaration at L82 (matchesProviderPollerCmd).
  - 0 logger call sites (verified).
- 5 `vi.mock('../channel-coordinator/...')` sites across 4 files:
  - `vi.mock('../channel-coordinator/ingest.js')`: 1 site
    (`messages-routes.test.ts:101`, verified — substitutes
    COORDINATOR_AGENT_ID).
  - `vi.mock('../channel-coordinator/liveness.js')`: 4 sites
    (`channel-monitor.test.ts:259`,
    `channel-monitor-baseline.test.ts:222`,
    `channel-monitor-coverage.test.ts:243`,
    `schedule-mcp-precheck-full.test.ts:80` — verified).
- 12 test files use G exports (verified — GCE-3 finding):
  - 11 dedicated `channel-coordinator-*.test.ts` files (matches plan).
  - `channel-inbound-framing.test.ts:11` (uses `buildHandoffContent`,
    MISSED by plan).
- 4 production importers of `channel-coordinator/` subdirectory
  (verified):
  - `src/web/agent-message-wrap.ts:21` (COORDINATOR_AGENT_ID).
  - `src/web/schedule-mcp-precheck.ts:22` (getClaudePidForSession).
  - `src/web/channel-monitor.ts:50` (3 liveness helpers).
  - `src/web/federation/local-catalog.ts:8` (COORDINATOR_AGENT_ID).
  - `src/web/routes/messages.ts:11` (COORDINATOR_AGENT_ID).
  - Plus the internal `channel-coordinator.ts:36/37/38-48` (5 imports).
- Zero production importers of `src/channel-coordinator.ts` entry
  file (verified via `grep -n channel-coordinator src/index.ts` —
  0 matches; matches plan).
- 5 `instanceof TelegramApiError` sites at
  `channel-coordinator.ts:335/338/366/372/378` (verified — matches
  plan exactly).
- 1 `vi.doMock` site in the 11 dedicated tests: verified `vi.mock`
  usage in `channel-coordinator-ingest.test.ts:35` and
  `channel-coordinator-telegram-client.test.ts:8` (both mock
  `../config.js`, not the entry file).
- Cross-cutting lessons applied: framework OE-6 (single-consumer
  generic, applied 3 times to G1/G2/G4 in `04 §1-3`); framework
  OE-7 (speculative additions, applied to GOE-1); framework OE-11
  (phase inflation, applied to GOE-3, GOE-7); framework CE-1
  (inventory thoroughness, applied to GCE-1); framework CE-5 /
  HCE-7 / BCE-7 / CE-D3 / CE-F7 (test factory, applied to GCE-4);
  framework CE-17 (bun --bun vitest, applied to GCE-7, GCE-12,
  cross-cutting section); HCE-1 (stale baseline counts, applied to
  GCE-2, GCE-9, GCE-11); HCE-3 / HCE-5 (out-of-scope documentation,
  applied to GCE-5, GCE-6, GCE-8); OE-D1 (unreachable parameter,
  applied to GOE-4); OE-D2 (speculative list(), applied to GOE-5);
  OE-D4 (`_legacy` naming convention, applied to GOE-8); EOE-2
  (speculative `overrides?`, applied to GOE-4); BOE-3 (numbered
  phase for a single change, applied to GOE-7); AOE-5 (logger
  policy as phase, applied to GOE-7); CE-D1 (channel-coordinator
  subdirectory boundary, applied to GCE-5, GCE-6).
