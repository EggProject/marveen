# E (process-lock) — Type & Interface Analysis

Planning-only analysis for the class-based refactor of `src/process-lock.ts`
(365 lines as of 2026-08-30, measured). Scope: types, interfaces, generic
opportunities, and the H-subsystem `LoggerLike` integration. **No source
files were modified.**

Reference inputs (cited, not modified):

- `docs/refactor-to-classbase/h-cross-cutting/04-generic-interfaces.md`
  (LoggerLike shape, two-form `LogFn` overload set from pino)
- `docs/refactor-to-classbase/h-cross-cutting/03-class-boundaries.md`
  (H subsystem LoggerLike is the input to E)
- `docs/refactor-to-classbase/h-cross-cutting/review-correctness.md` (HR4
  LoggerLike vs `pino.Logger` confusion)

---

## Brief summary

The E subsystem (`src/process-lock.ts`) is a 365-line pure-logic module
that exports two context interfaces (`ProcessLockContext`,
`PidfileLockContext`), three acquire/release function shapes
(`acquirePortLock`, `acquirePidfileLock`, `writeBufferFully`), four
supporting types (`SignalOutcome`, `ExclusiveCreateOutcome`,
`AcquirePortLockOptions`, `AcquirePidfileLockOptions`), one named error
class (`DeferToPeerError`), and one local type alias (`LogFn`). The
type-side state is clean: zero `as any`, zero `: any`, zero
`as unknown as` casts in the file. The only logger-related wart is the
locally-declared `LogFn` at line 19, which is *stricter* than pino's own
two-arg form (it types the obj parameter as `Record<string, unknown>`
rather than `object`), and which appears identically at lines 49 and 253
on the two `log` context fields. The H-subsystem migration plan already
identifies these three sites for deletion and replacement with
`LoggerLike`; the rest of the type surface (interfaces, return types,
error class) survives the migration unchanged. Two structural decisions
deserve attention before class conversion: (a) the two context
interfaces share `sleep` and `log` and differ in every other field, so
they are not unifiable into a single type without a generic, and (b)
they each capture *no* snapshot state (port number and pidfile path are
passed as separate function arguments, not embedded in the ctx), so a
generic over `T` would have nothing to parameterise on. Recommendation:
keep the two interfaces separate, delete `LogFn`, adopt `LoggerLike`.

---

## §1. `LogFn` audit

### Current shape

`src/process-lock.ts:19`:

```ts
type LogFn = (obj: Record<string, unknown>, msg?: string) => void
```

The alias is **module-private** (no `export`). It is *stricter* than
pino's own signature (see `04-generic-interfaces.md:124-129`): pino's
`LogFn` (and the H-plan replacement) widens the object parameter to
`object`, which lets interface-typed arguments (e.g.
`logger.error({ err }, 'msg')`) pass without a cast. Under the current
alias, only `Record<string, unknown>` literals structurally satisfy the
parameter; pino's call sites that pass an interface-typed object would
require an `as Record<string, unknown>` cast at the boundary. There are
no such casts today (the ctx logs use object literals throughout), but
the alias is hostile to future evolution.

### Use sites

The alias is *referenced* at exactly two field declarations:

- `src/process-lock.ts:49` — `ProcessLockContext.log`:
  `log: { info: LogFn; warn: LogFn; error: LogFn }`
- `src/process-lock.ts:253` — `PidfileLockContext.log`:
  `log: { info: LogFn; warn: LogFn; error: LogFn }`

The two `log` fields have *identical shape*. Neither includes `debug`,
matching the **subset** that process-lock actually calls (`grep -nE
'log\.(info|warn|error)' src/process-lock.ts` returns 13 call sites,
all `.info`/`.warn`/`.error`; no `.debug`).

### Call sites (13 total)

Verified by `grep -nE 'log\.(info|warn|error)' src/process-lock.ts`:

| Line | Field | Caller |
|---:|---|---|
| 107 | `.warn` | `filterOwnNodeCandidates` (different UID) |
| 112 | `.warn` | `filterOwnNodeCandidates` (non-node cmd) |
| 136 | `.info` | `terminateProcesses` (SIGTERM sent) |
| 138 | `.warn` | `terminateProcesses` (SIGTERM failed) |
| 155 | `.warn` | `terminateProcesses` (escalating to SIGKILL) |
| 158 | `.error` | `terminateProcesses` (SIGKILL failed) |
| 181 | `.warn` | `acquirePortLock` (taking over) |
| 196 | `.warn` | `acquirePortLock` (port still held) |
| 301 | `.info` | `acquirePidfileLock` (lock acquired) |
| 328 | `.warn` | `acquirePidfileLock` (stale file) |
| 336 | `.warn` | `acquirePidfileLock` (PID recycled) |
| 346 | `.info` | `acquirePidfileLock` (deferring) |
| 350 | `.warn` | `acquirePidfileLock` (sending SIGTERM) |
| 352 | `.warn` | `acquirePidfileLock` (SIGTERM failed) |
| 362 | `.error` | `acquirePidfileLock` (max attempts) |

All 13 call sites use the **obj-first** form (`ctx.log.<level>({ ... },
'msg')`). The string-first form (`ctx.log.<level>('msg')`) is **never
used** in process-lock. This matters for HR4 compatibility: a real
`LoggerLike`-typed field can pass all 13 sites without modification
because every call satisfies the `(obj: object, msg?: string): void`
overload.

### Replace strategy

Per `04-generic-interfaces.md:142-149`, `03-class-boundaries.md:94-110`,
and `review-correctness.md` m2:

1. **Delete** `type LogFn` at `src/process-lock.ts:19`.
2. **Import** `LoggerLike` from `src/logger.ts` (the new module proposed
   in H.1; both 04 and 03 agree `src/logger.ts` is the home).
3. **Replace** the two `log: { info: LogFn; warn: LogFn; error: LogFn }`
   fields at lines 49 and 253 with `log: LoggerLike`.
4. **Collapse** the two adapter literals at `src/index.ts:171-175` and
   `:280-287` from three explicit forwarders to `log: logger` once the
   field type widens. `pino.Logger` is structurally assignable to
   `LoggerLike` (HR4 analysis in `04-generic-interfaces.md:131-138`,
   verified in `review-correctness.md:CE-4 row`).
5. **Pin** the existing test `index.test.ts:1383` (`'forwards pidfile
   context errors to logger.error'`) survives the collapse. The source
   comment at `index.ts:281-283` currently cites `index.test.ts:1382`,
   off-by-one — fix to `1383` in the same H.1 commit (per
   `review-correctness.md` M2 and m2, severity major).

No call site needs to change argument shape. The new `LoggerLike` widens
the parameter from `Record<string, unknown>` to `object`, which is a
superset: every existing call's object literal satisfies `object`.

### Why the alias exists in the first place (history)

The 4-method subset (`info`/`warn`/`error`) plus the obj-first variant
exists because `ProcessLockContext.log` is a *constructor-shaped
interface*, not a concrete pino instance — the test file
(`src/__tests__/process-lock.test.ts:81` and `:515`) builds a
`log: { info, warn, error }` literal as part of the ctx mock. Today,
this 3-method subset is fine because process-lock never logs at `.debug`.
Once H.1 lands and the `log` field is typed as `LoggerLike`, the two
test-file literals need a `debug` stub added (`04-generic-interfaces.md`
"Adding `debug` forces updates in the ~12 test files whose mock omits
it."). Process-lock is one of those files.

---

## §2. `ProcessLockContext` (line 26)

### Field-by-field breakdown

| Field | Type | Optional? | Captured state | Purpose |
|---|---|---|---|---|
| `currentPid` | `number` | required | none — passed in | Excluded from victim lists (L98) |
| `uid` | `number \| null` | required | none — passed in | UID filter for "own UID only" |
| `listPortHolders(port)` | `(port: number) => number[]` | required | none — closure over `execSync` | `lsof -ti :PORT` (live at L102-110) |
| `listOwnProcessesMatching(pattern)` | `(pattern: RegExp) => number[]` | required | none — closure over `execFileSync('/bin/ps', ...)` and `uid` | `ps -Ao pid=,uid=,args=` filtered by `argvBelongsToThisInstall` (live at L111-139) |
| `getProcessCommand(pid)` | `(pid: number) => string \| null` | required | none — closure over `execFileSync('/bin/ps', ...)` | `ps -p <pid> -o comm=` (live at L140-146) |
| `getProcessUid(pid)` | `(pid: number) => number \| null` | required | none — closure over `execFileSync('/bin/ps', ...)` | `ps -p <pid> -o uid=` (live at L147-155) |
| `signal(pid, sig)` | `(pid: number, sig: 'SIGTERM' \| 'SIGKILL' \| 0) => SignalOutcome` | required | none — closure over `process.kill` | liveness probe + send (live at L156-167) |
| `sleep(ms)` | `(ms: number) => Promise<void>` | required | none — closure over `setTimeout` | grace + drain waits |
| `log` | `{ info: LogFn; warn: LogFn; error: LogFn }` | required | closures over pino `logger.{info,warn,error}` (live at L171-175) | structured log forwarding |

### Variance

All fields are invariant or contravariant in their natural position:

- **Data fields** (`currentPid: number`, `uid: number | null`) — read
  position only, **covariant**. Could be `readonly` but currently aren't
  (the interface allows reassignment).
- **Method fields** — read-only method types, naturally
  **contravariant** in parameter / covariant in return. TypeScript
  infers these as method types, which are bivariant in practice but
  structurally subtype-check under strict mode (this codebase enforces
  strict generics per CLAUDE.md §7).
- **`log` field** — the object literal `{ info; warn; error }` is read
  position only; **covariant** in the field type. The fact that
  `pino.Logger` has more members than the current triple does not
  matter: structural subtyping requires the receiver to have at least
  the listed members, not exactly them.

### Captured state

**The interface captures *no* runtime state.** All "context" is held in
closures inside the live implementation at `src/index.ts:97-177`
(`buildProcessLockContext`), not in the interface shape. The interface
is a *pure method-bag*. This is intentional: the doc comment at lines
15-17 says "The logic is split from the I/O so the ctx can be mocked in
tests" — the split is what makes `process-lock.test.ts:46-58` work,
where `defaultSignal` is a mock `(pid, sig) => 'sent'` literal that
short-circuits all real `process.kill` calls.

### Optional vs required

**Every field is required.** There are no `?:` markers in the
interface. The test file constructs the ctx by listing every field
explicitly (see `src/__tests__/process-lock.test.ts:53-86`), which would
break silently if a future field were added without a test update — a
**strictness feature**, not a bug. The class conversion preserves this:
constructor parameters stay required.

### How it changes after class conversion

`ProcessLockContext` is the *dependency-injection* type. The class
conversion does NOT replace it — the class takes one as a constructor
parameter, exactly mirroring the current functional shape. The
interface stays; only the call sites change from
`acquirePortLock(port, ctx, opts)` to `new PortLockAcquirer(ctx,
opts).acquire(port)` or similar.

---

## §3. `PidfileLockContext` (line 226)

### Field-by-field breakdown

| Field | Type | Optional? | Captured state | Purpose |
|---|---|---|---|---|
| `tryCreateExclusive(path, pid)` | `(path: string, pid: number) => ExclusiveCreateOutcome` | required | none — closure over `openSync(path, 'wx')` + `writeSync` + `closeSync` | atomic O_EXCL create (live at L212-232) |
| `readRecordedPid(path)` | `(path: string) => number \| null` | required | none — closure over `readFileSync` | strict digit-only parse (live at L233-235) |
| `unlinkIfMatches(path, expected)` | `(path: string, expected: number \| null) => void` | required | none — closure over `readFileSync` + `unlinkSync` | conditional unlink with re-read (live at L236-253) |
| `probeAlive(pid)` | `(pid: number) => boolean` | required | none — closure over `process.kill(pid, 0)` | signal 0 liveness (live at L254-264) |
| `sendTerm(pid)` | `(pid: number) => void` | required | none — closure over `process.kill(pid, 'SIGTERM')` | SIGTERM (silent on ESRCH) (live at L265-273) |
| `isLegitimatePredecessor(pid)` | `(pid: number) => boolean` | required | closure over `isLegitimateDashboardPid(pid, procCtx)` | UID + node/tsx + argv match (live at L274-276) |
| `sleep(ms)` | `(ms: number) => Promise<void>` | required | none — closure over `setTimeout` | grace waits |
| `log` | `{ info: LogFn; warn: LogFn; error: LogFn }` | required | closures over pino `logger.{info,warn,error}` (live at L280-287) | structured log forwarding |

### Variance

Same shape as `ProcessLockContext`: data fields covariant, methods
contravariant/covariant in normal position, `log` object covariant.

### Captured state

**Also zero runtime state in the interface itself.** The
`isLegitimatePredecessor` method closure holds a reference to the
parent `procCtx: ProcessLockContext` (live at L275) — a *cross-context
coupling* not visible in the interface but present in the live
implementation. This is the single non-trivial relationship between the
two context types: the pidfile ctx delegates "is this PID actually a
peer dashboard?" to the port ctx's `listOwnProcessesMatching`. The
coupling is implementation-detail, not interface contract.

### Optional vs required

Same as `ProcessLockContext`: every field required, every test
construction lists them all explicitly (see
`src/__tests__/process-lock.test.ts:472-?` `makePidfileCtx` factory).

### How it changes after class conversion

Same as `ProcessLockContext`: stays as the dependency-injection type
for `PidfileLockAcquirer` (or whatever the class is named). The
cross-context coupling becomes either a constructor parameter
(`new PidfileLockAcquirer(procCtx, pidfileCtx, opts)`) or a method
delegation, depending on how the class surface settles.

---

## §4. Union vs generic — should the two contexts collapse?

### The natural collapse

```ts
// Hypothetical (NOT recommended):
interface LockContext<TEnv> {
  sleep(ms: number): Promise<void>
  log: LoggerLike
  env: TEnv  // would carry port | path
}
```

This is **not viable** because neither ctx captures port or pidfile
path in its interface — they are passed as separate arguments to the
acquire functions (`acquirePortLock(port, ctx, opts)`,
`acquirePidfileLock(path, selfPid, ctx, opts)`). The ctx is purely a
*capability bag* (a "what the system can do for you"), not a
*configuration record* (a "what we're trying to do"). There is no
shared snapshot field for `T` to bind to.

### The shape that survives generic-isation

Even if we forced a generic, the two ctx types share exactly two
fields: `sleep(ms)` and `log`. A `BaseLockContext` parent with just
those two fields, then `ProcessLockContext extends BaseLockContext`
and `PidfileLockContext extends BaseLockContext`, would *technically*
work but would:

1. Add an interface (`BaseLockContext`) that exists for two trivial
   fields.
2. Add a generic parameter that has nothing to bind to (see above).
3. Force every test mock to construct a `BaseLockContext` shape before
   extending it, which is friction for zero gain.
4. Break `ProcessLockContext['signal']` and
   `PidfileLockContext['tryCreateExclusive']` index access patterns
   the test file uses (`process-lock.test.ts:26, 46, 216, 236, 249,
   281, 302, 319` — all reference `ProcessLockContext['signal']`
   directly).

This is **`review-completeness.md` OE-6's pattern** (generic with one
consumer / no second consumer) in miniature. Per
`review-correctness.md` OE-6 verdict, that pattern is rejected.

### Variance over `T` would also be unforced

If we *did* try `LockContext<T>`, what would `T` be? It would have to
be **invariant** because it would appear in both parameter position
(in the constructor or factory method that builds a "snapshot" ctx) and
in some read position. The default-invariance rule from
`review-correctness.md` R5 applies, and there is no call site that
would benefit from variance annotation.

### Recommendation

**Keep the two interfaces separate.** They share `sleep` and `log`, and
that's where the similarity ends. The structural overlap is exactly
two fields; collapsing into a parent interface + generic adds machinery
for zero measurable win and breaks index-access idioms in the test
file.

### What the class conversion does instead

The class conversion produces two concrete classes (one per lock
strategy), each of which takes the corresponding ctx interface as a
constructor parameter. The shared `sleep` and `log` fields are
**inherited from the ctx interface**, not duplicated. No new interface
is created.

---

## §5. Return types — `LockResult`, `ReleaseFn`, `AcquireOptions`

### What exists

There is **no `LockResult` or `ReleaseFn` type** in `process-lock.ts`.
The acquire functions return `Promise<void>`:

- `acquirePortLock(port, ctx, opts): Promise<void>` (L169-173)
- `acquirePidfileLock(path, selfPid, ctx, opts): Promise<void>` (L289-294)

`writeBufferFully(writer, buf): void` (L207-210) is synchronous and
also void.

There is **no release path**. The lock helpers acquire; cleanup is
implicit (the kernel releases the port on process death; the pidfile
is removed by the *next* acquirer's `unlinkIfMatches` chain). The
doc-comments at L163-168 and L281-288 make this explicit.

### `AcquirePortLockOptions` (L52-65)

| Field | Type | Optional? | Default | Purpose |
|---|---|---|---|---|
| `graceMs` | `number` | yes (`?`) | `DEFAULT_GRACE_MS = 1500` | SIGTERM→SIGKILL window |
| `binaryPattern` | `RegExp` | yes (`?`) | none | zombie match (no port holder) |
| `postKillDrainMs` | `number` | yes (`?`) | `DEFAULT_POST_KILL_DRAIN_MS = 2000` | drain wait after SIGKILL |
| `postKillPollMs` | `number` | yes (`?`) | `DEFAULT_POST_KILL_POLL_MS = 100` | drain poll interval |

Defaults are applied at the call site (L174-176) with `??` — clean
nullish-coalescing, no unsafe casts.

### `AcquirePidfileLockOptions` (L256-268)

| Field | Type | Optional? | Default | Purpose |
|---|---|---|---|---|
| `maxAttempts` | `number` | yes (`?`) | `5` | bounded retry |
| `graceMs` | `number` | yes (`?`) | `DEFAULT_GRACE_MS = 1500` | SIGTERM→retry wait |
| `onLiveLegitimate` | `'sigterm' \| 'defer'` | yes (`?`) | `'sigterm'` | defer throws DeferToPeerError |

Defaults applied at L295-297 with `??`, same pattern. The
`'sigterm' | 'defer'` union is exhaustive and discriminated.

### Unsafe casts audit

`grep -nE 'as any|: any|as unknown as' src/process-lock.ts` returns
**zero matches**. Verified.

`grep -nE ' as ' src/process-lock.ts` returns matches at L156 (live
implementation only) — those are in `src/index.ts`, not
`process-lock.ts`. The two casts at `src/index.ts:158` and `:229` are
`as NodeJS.Signals | 0` and `as NodeJS.ErrnoException` respectively,
both are pino-context casts on err objects, not process-lock concern.

### Are return types well-typed?

Yes. `Promise<void>` is correct for both acquire functions: the caller
either gets a clean return (lock acquired) or a thrown error
(DeferToPeerError or `Error('Failed to acquire pidfile lock ...')`).
No information is lost in the void return because the throw carries
the actionable signal.

The lone subtle case: `acquirePidfileLock` returns `void` on success
*but* can throw `DeferToPeerError` *or* the generic
`Error('Failed to acquire pidfile lock at ${path} after ${maxAttempts} attempts')`
on max-attempts exhaustion (L362-363). The two error types are not
unioned in a return signature — they propagate via `throw`, which is
correct. A consumer wanting to discriminate them uses
`err instanceof DeferToPeerError` (live at `src/index.ts:555`).

---

## §6. `DeferToPeerError` (L272-279)

### Definition

```ts
export class DeferToPeerError extends Error {
  readonly peerPid: number
  constructor(peerPid: number) {
    super(`Pidfile held by legitimate peer PID ${peerPid}`)
    this.name = 'DeferToPeerError'
    this.peerPid = peerPid
  }
}
```

### Fields

| Member | Declared at | Notes |
|---|---|---|
| `peerPid: number` | L273 | `readonly`, parameter property at L274 (assigned via `constructor(peerPid: number)` shorthand) |
| `name` | L276 | hand-written literal `'DeferToPeerError'` |
| `message` | L275 | passed to `super(...)` |
| `cause` | n/a | **not declared, not passed to super** — irrelevant per H-plan (`03-class-boundaries.md:241-245` refutes the "cause is lost" claim; only enumerability differs, and DeferToPeerError has no cause to forward anyway) |

### Throw sites

- **Production:** `src/index.ts:324` (`throw new DeferToPeerError(recorded)`,
  inside `checkFreshStartupRace`, gated by
  `acquirePidfileLock`'s throw at `process-lock.ts:347`)
- **Source-only:** `src/process-lock.ts:347` (the canonical throw inside
  `acquirePidfileLock` when `onLiveLegitimate === 'defer'` and the peer
  is alive-and-legitimate)

### Consumers

`grep -rn 'DeferToPeerError' src/ --include='*.ts' | grep -v
process-lock.ts | grep -v __tests__` returns:

- `src/index.ts:31` — re-export
- `src/index.ts:324` — throw site
- `src/index.ts:555` — `instanceof DeferToPeerError` discrimination in
  the shutdown handler

That's the entire production surface — one throw site and one
discrimination site. The class is **exactly one remove** from being
trivial; the H.4 plan (`03-class-boundaries.md:285-303`) does **not**
propose DeferToPeerError as one of the first two `AppError` subclasses
(it picks `RequestBodyTooLargeError` and `PeerResponseTooLargeError`),
but DeferToPeerError would be a strong third candidate when H.4
expands: it has a structured field (`peerPid`), it has an `instanceof`
consumer, and it hand-sets `this.name` (the exact pattern H.4's
`new.target.name` replacement targets, per
`03-class-boundaries.md:259-261`).

### Class conversion impact

The class survives the process-lock refactor unchanged. The class
*itself* may move to `src/errors.ts` in a later H.4 phase (separate
from the E class conversion); that move is H.4's decision, not E's.

---

## §7. Generic opportunities

### `LockContext<T>` over snapshot — rejected

See §4 above. Both ctx interfaces are capability bags with zero
embedded snapshot state, so `T` would have nothing to bind to.

### `ProcessLockContext` generic over the `signal` discriminator

The `signal` field is typed as:

```ts
signal(pid: number, sig: 'SIGTERM' | 'SIGKILL' | 0): SignalOutcome
```

A reader could imagine genericising this to `signal<P extends Pid>(pid:
P, sig: SignalFor<P>)`. **Not worth doing.** There are exactly two
signals used (`SIGTERM`, `SIGKILL`) plus the liveness probe (`0`). The
string-literal union is already exhaustive, and adding a `SignalFor<P>`
mapped type would force every call site to thread a phantom `P`
parameter. The test file already indexes `signalOverride:
ProcessLockContext['signal']` seven times — genericising would force
those to carry the type parameter too.

### `ExclusiveCreateOutcome` as a generic sealed set

```ts
type ExclusiveCreateOutcome = 'created' | 'exists'
```

This is a closed union of two string literals. Genericising
(`ExclusiveCreateOutcome<T = 'created' | 'exists'>`) adds a parameter
with no consumer; rejected for the same reason as `LockContext<T>`.

### `DeferToPeerError<TPayload = number>` generic over the PID type

The `peerPid` field is `number`. There is no other PID type in
`process-lock.ts`. Genericising to `DeferToPeerError<TPid = number>`
is **the `review-completeness.md` OE-6 pattern** in miniature
(`02-type-interface-analysis.md:§LoggerLike` floats exactly this kind
of generic and rejects it for the same reason). Rejected.

### Per-class generics on the new `PortLockAcquirer` / `PidfileLockAcquirer`

The candidate classes are non-generic. They take:
- `PortLockAcquirer(ctx: ProcessLockContext, opts?: AcquirePortLockOptions)`
- `PidfileLockAcquirer(ctx: PidfileLockContext, opts?: AcquirePidfileLockOptions)`

No type parameter on either class. If a future feature needs
genericisation (e.g. customisable victim-classification), the
parameter would live on the *method* that uses it, not on the class
itself. **No generic needed at the class level.**

---

## §8. `LoggerLike` integration points (line-by-line)

The full mapping from `LogFn` to `LoggerLike` for every `log` field and
call site:

### Field declarations (delete `LogFn`, replace with `LoggerLike`)

| Line | Current | After |
|---:|---|---|
| 19 | `type LogFn = (obj: Record<string, unknown>, msg?: string) => void` | **deleted** |
| 49 | `log: { info: LogFn; warn: LogFn; error: LogFn }` | `log: LoggerLike` (imported from `src/logger.ts`) |
| 253 | `log: { info: LogFn; warn: LogFn; error: LogFn }` | `log: LoggerLike` |

### Call sites (zero changes needed)

All 13 call sites satisfy `LoggerLike`'s `LogFn` (which is a *superset*
of the local `LogFn` because `object` widens `Record<string, unknown>`).
Verified line-by-line above (§1). The string-first overload of
`LoggerLike.LogFn` is unused here but required by HR4 (the codebase has
76 / measured 73 string-first `logger.*(` call sites elsewhere, and
`LoggerLike` must accept them to remain a strict subset of
`pino.Logger`).

### Adapter literals at `src/index.ts` (collapse to `log: logger`)

| Line | Current | After |
|---:|---|---|
| 171-175 | `log: { info: (obj, msg) => logger.info(obj, msg), warn: (obj, msg) => logger.warn(obj, msg), error: (obj, msg) => logger.error(obj, msg) }` | `log: logger` |
| 280-287 | `log: { info: (obj, msg) => logger.info(obj, msg), warn: (obj, msg) => logger.warn(obj, msg), error: (obj, msg) => logger.error(obj, msg) }` | `log: logger` |

Both adapter literals exist *only* because the current `log` field type
is a 3-method subset. Once widened to `LoggerLike`, the literals are
redundant — `pino.Logger` structurally satisfies `LoggerLike` with no
cast (verified in `04-generic-interfaces.md:131-138` and confirmed in
`review-correctness.md:CE-4 row`).

### Test fixtures that need a `debug` stub added

| File:line | Current shape | After |
|---|---|---|
| `src/__tests__/process-lock.test.ts:81` | `log: { info: log('info'), warn: log('warn'), error: log('error') }` (or similar — verify) | add `debug: log('debug')` |
| `src/__tests__/process-lock.test.ts:515` | same pattern | add `debug: log('debug')` |

This is the `04-generic-interfaces.md` "Adding `debug` forces updates
in the ~12 test files" rule applied to process-lock. The test files do
not currently exercise `.debug` on `ctx.log`, but the *interface* will
require it after H.1.

### Pin test that survives the collapse

`src/__tests__/index.test.ts:1383` — `'forwards pidfile context errors
to logger.error'` — must continue to pass. The collapse of the adapter
literal at `src/index.ts:280-287` to `log: logger` makes this even
simpler (one less forwarder in the call chain), but the assertion
`expect(mockLogger.error).toHaveBeenCalledWith(...)` at `:1391`
remains valid because `mockLogger.error` IS `logger.error` once the
adapter goes away.

The off-by-one in the source comment at `src/index.ts:283`
(`Pinned by index.test.ts:1382`) must be corrected to `1383` in the
same H.1 commit. This is `review-correctness.md` M2 / m2.

---

## §9. Type-side recommendation summary

1. **Delete** `type LogFn` at `src/process-lock.ts:19`.
2. **Replace** `log: { info: LogFn; warn: LogFn; error: LogFn }` at
   L49 and L253 with `log: LoggerLike` (imported from `src/logger.ts`,
   the new module H.1 creates).
3. **Collapse** `src/index.ts:171-175` and `:280-287` to `log: logger`.
4. **Fix** the source comment at `src/index.ts:283` from `1382` to
   `1383` in the same H.1 commit.
5. **Add** a `debug` stub to the two test fixtures at
   `src/__tests__/process-lock.test.ts:81` and `:515` in the same H.1
   commit (required for `LoggerLike` conformance).
6. **Keep** `ProcessLockContext` and `PidfileLockContext` as two
   separate interfaces — they share `sleep` and `log` and diverge on
   every other field; a generic `LockContext<T>` has nothing to bind
   to.
7. **Keep** `AcquirePortLockOptions`, `AcquirePidfileLockOptions`,
   `SignalOutcome`, `ExclusiveCreateOutcome` unchanged — all four are
   well-typed with optional fields, defaults applied via `??`, no
   unsafe casts.
8. **Keep** `DeferToPeerError` unchanged for the E phase. When H.4
   expands the `AppError` base, DeferToPeerError is a strong third
   candidate (structured `peerPid`, hand-set `this.name`, one
   `instanceof` consumer).
9. **Verify** zero `as any` / `: any` / `as unknown as` in
   `src/process-lock.ts` (verified: zero matches).
10. **Class conversion** of `acquirePortLock` →
    `PortLockAcquirer` and `acquirePidfileLock` →
    `PidfileLockAcquirer` does not change any of the type surface
    above — interfaces stay, ctx types stay, options stay, error class
    stays, return types stay. The classes are *consumers* of the
    types, not replacements.
