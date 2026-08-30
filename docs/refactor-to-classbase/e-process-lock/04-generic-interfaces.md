# E (process-lock) — Generic interfaces

New generic interfaces for the E subsystem. Deliberately short:
`02-type-interface-analysis.md` §7 rejected four candidate generics
("per-class generics on the new `PortLockAcquirer` /
`PidfileLockAcquirer`" being the last) for the same reason the H plan
rejected six (`review-completeness.md` OE-1 through OE-9) — a
parameter with no second consumer. This document records what E
introduces (almost nothing), what it inherits from H
(`LoggerLike`), and what it explicitly rejects.

---

## §L. `LoggerLike` adoption (inherited from H)

### Why E must adopt, not define

`process-lock.ts` is the **only** module in the project that
hand-rolls a local `LogFn` type alias (`process-lock.ts:19`) and
threads it through two context interfaces (`:49` and `:253`). The H
subsystem's `LoggerLike` interface (defined at `src/logger.ts` per
`h-cross-cutting/04-generic-interfaces.md:54-69`) is the canonical
replacement. E inherits it — E does not propose its own logger
interface.

### Mapping

| Site | Current shape | After H.1 + E.6 |
|---|---|---|
| `process-lock.ts:19` | `type LogFn = (obj: Record<string, unknown>, msg?: string) => void` | **deleted**; replaced by the wider `LoggerLike.LogFn` import |
| `process-lock.ts:49` (`ProcessLockContext.log`) | `log: { info: LogFn; warn: LogFn; error: LogFn }` | `log: LoggerLike` |
| `process-lock.ts:253` (`PidfileLockContext.log`) | `log: { info: LogFn; warn: LogFn; error: LogFn }` | `log: LoggerLike` |
| `src/index.ts:171-175` (production `ProcessLockContext` factory) | `log: { info: (obj, msg) => logger.info(obj, msg), warn: …, error: … }` (adapter literal) | `log: logger` (one identifier, three pino methods) |
| `src/index.ts:280-287` (production `PidfileLockContext` factory) | same adapter literal | `log: logger` |
| `src/__tests__/process-lock.test.ts:81` | `log: { info: log('info'), warn: log('warn'), error: log('error') }` | add `debug: log('debug')` stub for `LoggerLike` conformance |
| `src/__tests__/process-lock.test.ts:515` | same | add `debug: log('debug')` |

All 13 in-file call sites (`:107, :112, :136, :138, :155, :158, :181,
:196, :301, :328, :336, :346, :350, :352, :362` — enumerated in
`02-type-interface-analysis.md` §1 "Call sites") use the obj-first form
and satisfy `LoggerLike.LogFn` without modification. The string-first
overload of `LoggerLike.LogFn` is unused in process-lock but required
by HR4 (the codebase has 76 string-first `logger.<level>('msg')`
callers elsewhere per `h-cross-cutting/00-summary.md` "Top 3 risks"
risk #1).

### Why E does not define its own narrower logger interface

The temptation is to type the `log` field as the *exact* triple E
uses (`info`, `warn`, `error` — no `debug`) since E never logs at
`debug`. This would be narrower than `LoggerLike` and would let the
existing test fixtures (`process-lock.test.ts:81`, `:515`) survive
unchanged. **Rejected** for three reasons:

1. **Two E call sites log at `.error`** (`:158`, `:362`) — these are
   already in `LoggerLike`, so nothing is gained by narrowing.
2. **Future-proofing.** If a future bug-fix adds a `log.debug`
   call, the narrower interface forces a regression in two places
   (interface widening + test fixture update) instead of one (test
   fixture update). The wider interface converts a runtime hazard
   into a compile-time one.
3. **HR2 hazard.** Of the 91 test files that mock `logger.js`
   (`h-cross-cutting/06-risks-and-mitigations.md` HR2), 4 files
   ship the `{info, warn, error}` triple without `debug`. A
   project-wide `LoggerLike` adoption forces those 4 files to add
   `debug` — exactly the latent-bug-conversion-into-compile-error
   mechanism H is designed for. E piggy-backs on that benefit.

### Pin test that survives the E.6 collapse

`src/__tests__/index.test.ts:1383` —
`'forwards pidfile context errors to logger.error'` — must continue
to pass. The collapse of the adapter literal at `index.ts:280-287`
to `log: logger` makes this even simpler (one less forwarder in the
call chain). The assertion `expect(mockLogger.error).toHaveBeenCalledWith(...)`
at `:1391` remains valid because `mockLogger.error` IS `logger.error`
once the adapter goes away. The off-by-one in the source comment at
`index.ts:283` (`Pinned by index.test.ts:1382`) is fixed to `1383` in
the same H.1 commit per `h-cross-cutting/03-class-boundaries.md:109`
and `review-correctness.md` M2 / m2 — this is H.1's responsibility,
not E's.

---

## §Z. `LockResult`, `ReleaseFn`, `AcquireOptions` — generic
opportunities REJECTED

### What exists today

`process-lock.ts` defines **no** `LockResult` or `ReleaseFn` type.
Both acquire functions return `Promise<void>`:

- `acquirePortLock(port, ctx, opts): Promise<void>`
  (`process-lock.ts:169-173`)
- `acquirePidfileLock(path, selfPid, ctx, opts): Promise<void>`
  (`process-lock.ts:289-294`)

`writeBufferFully(writer, buf): void` (`process-lock.ts:207-210`) is
synchronous and also void. There is **no release path** in the
interface — the kernel releases the port on process death and the
pidfile is removed by the *next* acquirer's `unlinkIfMatches` chain.
The doc-comments at `:163-168` and `:281-288` make this explicit.

### Hypothetical `LockResult<T>` — rejected

A reader could imagine a `LockResult<T>` parameterised over the
"thing held":

```ts
// Hypothetical (NOT recommended):
interface LockResult<THeld> {
  readonly held: THeld
  readonly acquiredAt: Date
  release(): Promise<void>
}
```

This is rejected for three reasons:

1. **No consumer.** Nothing in `src/` outside `process-lock.ts`
   needs to know "what was acquired" beyond the call succeeding.
   The port number is `WEB_PORT` (`config.ts:33`, a frozen const)
   and the pidfile path is `PID_FILE` (`config.ts:40`, a frozen
   const) — both are project-global constants known to the caller.
2. **The throw path carries the actionable signal.** The acquire
   functions return `Promise<void>` on success; on failure they
   throw (`DeferToPeerError` at `:347`, generic `Error('Failed to
   acquire pidfile lock …')` at `:363`). The single `instanceof
   DeferToPeerError` consumer at `index.ts:555` reads
   `err.peerPid` (`:556`); no result-type inspection is needed.
3. **`OE-6` pattern.** Per `review-completeness.md` OE-6, a generic
   with one consumer (here, the E subsystem itself) and no second
   caller is the exact pattern the framework rejected for
   `TypedError<TPayload>` (`h-cross-cutting/04-generic-interfaces.md:241`).

The E class conversion keeps the void return. `acquire(): Promise<void>`
is correct: the caller either gets a clean return (lock acquired) or
a thrown error (the actionable signal).

### Hypothetical `AcquireOptions<T>` — rejected

A reader could imagine a single `AcquireOptions<TLock>` interface
covering both lock strategies:

```ts
// Hypothetical (NOT recommended):
interface AcquireOptions<TLock> {
  graceMs?: number
  binaryPattern?: RegExp
  maxAttempts?: number
  onLiveLegitimate?: 'sigterm' | 'defer'
}
```

This is rejected for two reasons:

1. **The four field-set do not compose.** Port-lock options are
   `{ graceMs, binaryPattern, postKillDrainMs, postKillPollMs }`
   (`process-lock.ts:52-65`); pidfile options are `{ maxAttempts,
   graceMs, onLiveLegitimate }` (`process-lock.ts:256-268`). Only
   `graceMs` is shared. A union type that makes
   `binaryPattern`/`onLiveLegitimate` mutually exclusive at the
   *type* level adds machinery for zero gain — neither field is
   ever conditionally present in practice; the caller always picks
   one lock strategy and passes its full option set.
2. **Forcing two separate option types matches the two class
   candidates.** E1 (`PortLockAcquirer`) takes
   `AcquirePortLockOptions`; E2 (`PidfileLockAcquirer`) takes
   `AcquirePidfileLockOptions`. A shared `AcquireOptions<TLock>`
   would force `new PortLockAcquirer(ctx, opts as
   AcquireOptions<PortLock>)` casts at the boundaries, which is
   the `as`-at-boundary hazard `review-correctness.md` R5
   prescribes against.

The two options interfaces stay separate, each non-generic, each
immutable in shape.

---

## §X. Considered and rejected

| Candidate | Source of the idea | Why rejected |
|---|---|---|
| `LockContext<T>` shared base over `sleep` + `log` | `01-module-state-analysis.md` §7 "One class or two?" | `ProcessLockContext` and `PidfileLockContext` share two fields (`:48, :252` for `sleep`; `:49, :253` for `log`) and diverge on every other field (seven port-specific methods, seven pidfile-specific methods). A `BaseLockContext` parent would add one interface for two trivial fields and force test mocks to construct a base before extending. Full argument in `02-type-interface-analysis.md` §4 and `03-class-boundaries.md` "LockContext generic over T — rejected" above. |
| `LockResult<T>` parameterised over the held thing | this document §Z | No consumer. The port and path are caller-known constants; the throw carries the actionable signal. |
| `AcquireOptions<TLock>` shared by both lock strategies | this document §Z | The four fields are not composable; only `graceMs` is shared. Two options interfaces match the two class candidates one-to-one. |
| `ExclusiveCreateOutcome<T = 'created' \| 'exists'>` generic | `02-type-interface-analysis.md` §7 "ExclusiveCreateOutcome as a generic sealed set" | The two-string-literal union is already exhaustive; adding a generic adds a parameter with zero callers. The same logic that rejected `TypedError<TPayload>` (`h-cross-cutting/04-generic-interfaces.md:241`). |
| `DeferToPeerError<TPid = number>` generic over the PID type | `02-type-interface-analysis.md` §7 "DeferToPeerError<TPayload = number> generic over the PID type" | `peerPid` is read positionally at `index.ts:556` (`err.peerPid`); no other PID type exists in the file; no caller benefits from the parameter. Rejected as the `OE-6` pattern. |
| `signal<P extends Pid>(pid: P, sig: SignalFor<P>)` generic over the PID and signal space | `02-type-interface-analysis.md` §7 "ProcessLockContext generic over the signal discriminator" | Two signals used (`SIGTERM`, `SIGKILL`) plus `0`; the string-literal union is exhaustive; adding `SignalFor<P>` would force every test mock to thread a phantom `P` parameter. The seven `ProcessLockContext['signal']` index-access sites in `process-lock.test.ts:26, :46, :216, :236, :249, :281, :302, :319` would all need updating for no behaviour change. |
| Per-class generics on `PortLockAcquirer` / `PidfileLockAcquirer` | `02-type-interface-analysis.md` §7 "Per-class generics on the new `PortLockAcquirer` / `PidfileLockAcquirer`" | No type parameter has a second consumer; the ctx and options types are concrete. If a future feature needs genericisation, the parameter would live on the *method* that uses it, not on the class. |

---

## §V. Verifiability

Every claim in this document was verified against the working tree on
2026-08-30:

- `process-lock.ts:19` (the `LogFn` alias) — read directly.
- `process-lock.ts:49` and `:253` (the two `log: { info; warn; error }` fields) — read directly.
- `process-lock.ts:169-173` and `:289-294` (the void return types) — read directly.
- `index.ts:171-175` and `:280-287` (the adapter literals) — read directly.
- `index.ts:556` (`err.peerPid`) — verified.
- `process-lock.test.ts:81` and `:515` (the two test fixtures) — verified by `grep -n "log:" process-lock.test.ts`.
- `index.test.ts:1383` (the pin test) — verified.
- The 13 in-file call sites — enumerated by `grep -nE 'log\.(info|warn|error)' src/process-lock.ts` and cross-checked with `02-type-interface-analysis.md` §1 "Call sites".

The "no second consumer" verdict on each rejected generic is the
same verdict that drove the H plan's six rejections
(`h-cross-cutting/04-generic-interfaces.md:240-244`). E inherits the
framework's discipline.