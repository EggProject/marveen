# E (process-lock) — Class boundaries

Concrete class candidates for the E subsystem. Signatures only; no
implementation. Every claim below cites a file:line verified against
`src/` on 2026-08-30.

**Reading note.** Both candidates below are recommended in the
*narrower* form that the type/state analyses argued for: two classes,
not one, and a constructor-injected `ctx` rather than per-method
primitive injection. The argument is summarised inline and the full
case is in `01-module-state-analysis.md` §1 and
`02-type-interface-analysis.md` §2-§4. Both candidates keep the
existing context interfaces (`ProcessLockContext`, `PidfileLockContext`)
intact; the class is a *consumer* of the interfaces, not a replacement.

---

## E1. `PortLockAcquirer`

### Source and migration

- **Source file:** `src/process-lock.ts` (same file, alongside the
  free functions).
- **Migration source:** the body of `acquirePortLock` at
  `src/process-lock.ts:169-197`, plus the helpers it calls
  (`findOwnNodeHolders` `:77`, `findOwnBinaryMatches` `:88`,
  `filterOwnNodeCandidates` `:93`, `terminateProcesses` `:127`). The
  class is a literal translation: the `ctx` argument becomes `this`,
  the `opts` argument becomes a constructor-injected option, and the
  `port` argument becomes the method argument. Verified to have
  zero captured state (see `01-module-state-analysis.md` §1 "State
  captured in closures" — only `waited` is local to one call).

### Public surface (signatures only)

```ts
class PortLockAcquirer {
  constructor(
    private readonly ctx: ProcessLockContext,
    private readonly opts: AcquirePortLockOptions = {},
  )

  acquire(port: number, overrides?: AcquirePortLockOptions): Promise<void>
  release(): Promise<void>   // no-op for port; present for shape parity with PidfileLockAcquirer
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `acquire(port, overrides?)` | `acquirePortLock(port, ctx, opts)` | `process-lock.ts:169-173` | The `overrides?` parameter lets a test override the constructor `opts` for one call (e.g. set `drainMs: 0` to skip the post-kill poll). Production callers always omit it. [ASSUMPTION: whether `overrides?` is needed is a sequencing decision; if the test fixture at `process-lock.test.ts:333-528` can live with constructor-only options, drop `overrides?` and rely on per-test instance construction.] |
| `release()` | n/a | n/a | The kernel releases the port on process death; today `releaseLock()` at `src/index.ts:356-364` only unlinks the pidfile, never touches the port. `release()` is a no-op kept for shape parity so `App.shutdown()` can call `lock.release()` uniformly on both acquirers. Per framework R9 the shutdown sequence ends with "process lock (`PortLockAcquirer` + `PidfileLockAcquirer`)" at step 8 of 9. |

### Constructor

- `(ctx, opts?)`. The `ctx` is required and is exactly the
  `ProcessLockContext` interface at `process-lock.ts:26-50`. The
  `opts` is the existing `AcquirePortLockOptions` at
  `process-lock.ts:52-65`. Defaults resolve at `acquire()` time
  (`:174-176`) — preserved unchanged.
- **No I/O in the constructor.** The class is a pure translation of
  `acquirePortLock`, which performs no work outside the `acquire()`
  call. This mirrors `LazyBin`'s no-I/O-constructor pin
  (`h-cross-cutting/03-class-boundaries.md:147-150`) — verified by
  reading the function body line-by-line; there is no
  module-evaluation side effect.

### Generic params

None. The ctx and options are concrete types. `02-type-interface-analysis.md`
§7 ("Per-class generics on the new `PortLockAcquirer` /
`PidfileLockAcquirer`") argues that no type parameter has a second
consumer; the brief accepts the same conclusion.

### Dependencies

- `ProcessLockContext` interface (stays as a pure type-only export).
- `AcquirePortLockOptions` interface (stays).
- `SignalOutcome` type alias at `process-lock.ts:24` (stays).
- No new imports introduced; the class compiles in the existing
  pure-logic island that has zero `import` statements today
  (`01-module-state-analysis.md` §1 "Side effects" — verified).

### Lifecycle

- **Constructed at boot** by `src/index.ts`'s future `class App`
  constructor (framework D3, `05-refactor-roadmap.md` Phase 7),
  inside `acquireLock()` at `index.ts:337-351` — specifically after
  `procCtx = buildProcessLockContext()` (`:339`) and before
  `await acquirePortLock(...)` (`:341`).
- **One instance per process.** The class holds no mutable state
  itself; the per-call `waited` local at `process-lock.ts:189` is
  scoped to one `acquire()` invocation. Re-using the same instance
  for the post-restart acquire (after `release()`) is fine.
- **`release()` is a no-op.** The port lock is held by the kernel
  for the lifetime of the listening socket; the dashboard process
  owns the socket until `process.exit`. The `release()` method
  exists only so `App.shutdown()` can call it uniformly on both
  acquirers without a type guard.

### Free functions that REMAIN after E.1

| Symbol | Location | Why it stays |
|---|---|---|
| `acquirePortLock(port, ctx, opts)` | `process-lock.ts:169-197` | Kept as a thin wrapper that constructs a one-shot `PortLockAcquirer(ctx, opts)` and calls `.acquire(port)`. Required by E.5's gate (zero direct importers outside the class file). Removed in E.5 after every consumer migrates. |
| `findOwnNodeHolders(port, ctx)` | `process-lock.ts:77-80` | Imported directly by `process-lock.test.ts:6` (per `01-module-state-analysis.md` §5). Stays as a free export so the test file's direct-exercise pattern survives. |
| `findOwnBinaryMatches(pattern, ctx)` | `process-lock.ts:88-91` | Same — imported by `process-lock.test.ts:7`. |
| `terminateProcesses(pids, ctx, opts)` | `process-lock.ts:127-161` | Imported by `process-lock.test.ts:5` for the 8 dedicated `terminateProcesses` cases (`:194-330`). Becomes a private method on `PortLockAcquirer` *and* a free export so the direct-exercise tests keep compiling. The two surfaces share the body. |
| `writeBufferFully(writer, buf)` | `process-lock.ts:207-219` | Used by `index.ts:220-223` (the production `tryCreateExclusive` implementation), not by `acquirePortLock`. Stays as a free export untouched by E.1. |
| `SignalOutcome` type alias | `process-lock.ts:24` | Type-only export; survives all phases. |

### Free functions that DO NOT exist on the class

- **Throw helpers.** `acquirePortLock` does not throw project-specific
  errors. It only logs warnings (`process-lock.ts:181`, `:196`) and
  lets `ctx.signal`'s thrown errors bubble. The class does not
  introduce any throw site that needs a separate helper.

---

## E2. `PidfileLockAcquirer`

### Source and migration

- **Source file:** `src/process-lock.ts` (same file).
- **Migration source:** the body of `acquirePidfileLock` at
  `src/process-lock.ts:289-364`, plus the `DeferToPeerError` throw
  site at `:347` and the final-attempts-exhausted throw at `:363`.
  As with E1, the `ctx` becomes `this` and `selfPid` + `path` are
  bound at construction or passed per-call.

### Public surface (signatures only)

```ts
class PidfileLockAcquirer {
  constructor(
    private readonly ctx: PidfileLockContext,
    private readonly selfPid: number,
    private readonly opts: AcquirePidfileLockOptions = {},
  )

  acquire(path: string, overrides?: AcquirePidfileLockOptions): Promise<void>
  release(): Promise<void>
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `acquire(path, overrides?)` | `acquirePidfileLock(path, selfPid, ctx, opts)` | `process-lock.ts:289-294` | `selfPid` moves into the constructor (it is process-lifetime; passed once at boot from `process.pid`). `path` stays a method argument because it varies per acquire (in production it is always `PID_FILE` at `index.ts:348`, but a test may want to acquire two separate pidfiles in sequence). [ASSUMPTION: if tests always use the same `path`, the constructor could take it instead. Decision deferred to E.4 when the test-file migration is examined.] |
| `release()` | `releaseLock()` in `src/index.ts:356-364` | `index.ts:356-364` | The current `releaseLock()` reads the pidfile and unlinks it only if `recorded === process.pid`. The class version either absorbs the same logic (so `index.ts:356-364` becomes `await lockAcquirer.release()`) or leaves `releaseLock()` as a free helper. Recommendation: **absorb** — the class owns its lifecycle. |

### Constructor

- `(ctx, selfPid, opts?)`. The `ctx` is the existing
  `PidfileLockContext` interface at `process-lock.ts:226-254`.
  `selfPid` is the process's own PID (`process.pid`, captured once
  at boot, not re-read). `opts` is the existing
  `AcquirePidfileLockOptions` at `process-lock.ts:256-268`.
- **No I/O in the constructor.** `acquirePidfileLock` only does I/O
  inside `acquire()`; the body opens / reads / unlinks the pidfile
  file via the injected `ctx` methods. The constructor is a pure
  field-assignment.

### Cross-context coupling

`PidfileLockContext.isLegitimatePredecessor(pid)` at
`process-lock.ts:251` closes over the parent `procCtx` at
`src/index.ts:274-276`. This cross-context coupling is
*implementation-detail* (see `02-type-interface-analysis.md` §3
"Captured state" — the interface does not expose the closure). The
class version preserves the coupling by accepting the
already-constructed `PidfileLockContext` from the caller; the class
itself does not reach into `procCtx`. If E1 and E2 land in separate
files, the caller (`src/index.ts`) constructs both `procCtx` and
`pidfileCtx` and passes them to their respective acquirers. No new
constructor parameter on E2 is needed for the coupling — it is
embedded in the `pidfileCtx` instance.

### Generic params

None. Same reasoning as E1.

### Dependencies

- `PidfileLockContext` interface (stays).
- `AcquirePidfileLockOptions` interface (stays).
- `ExclusiveCreateOutcome` type alias at `process-lock.ts:224`
  (stays).
- `DeferToPeerError` class at `process-lock.ts:272-279` (stays).
- No new imports.

### Lifecycle

- **Constructed at boot** by `src/index.ts`'s `class App` after
  `procCtx = buildProcessLockContext()` and after E1's `PortLockAcquirer`
  has already acquired the port lock (the order is documented in
  the boot flow at `01-module-state-analysis.md` §6 "Integration in
  `src/index.ts`'s boot flow").
- **One instance per process.**
- **`release()` is real** (unlike E1): it reads the pidfile,
  compares against `selfPid`, and unlinks if matching — verbatim of
  the current `releaseLock()` body at `src/index.ts:356-364`. This
  unlinks the file from the *current* process's slot; if a third
  party has O_EXCL'd a new pidfile in the meantime, `release()`
  does not touch it.

### Free functions that REMAIN after E.2

| Symbol | Location | Why it stays |
|---|---|---|
| `acquirePidfileLock(path, selfPid, ctx, opts)` | `process-lock.ts:289-364` | Same wrapper shape as E1's free function. Required until E.5. |
| `DeferToPeerError` class | `process-lock.ts:272-279` | Exported for two reasons: (a) `src/index.ts:31` re-exports it; (b) `src/index.ts:324` instantiates it inside `checkFreshStartupRace` (the pre-acquire early-exit). The class version of `acquire()` throws it from inside the class method, but `index.ts:324` still throws it directly. **Either way the class must remain a top-level export** so both call sites resolve. |
| `ExclusiveCreateOutcome` type alias | `process-lock.ts:224` | Type-only export; survives. |

### Free functions that DO NOT exist on the class

- **Throw helpers.** `acquirePidfileLock` throws `DeferToPeerError`
  (`:347`) and a generic `Error(...)` on max-attempts exhaustion
  (`:363`). Both throws stay where they are: the class body's throw
  sites move from a free function body to a method body, but the
  *line* does not change (`:347` and `:363` are inside the
  `acquirePidfileLock` body, which becomes `acquire()`'s body). The
  throw site does not move out of `process-lock.ts`.

---

## LockContext generic over T — rejected

`02-type-interface-analysis.md` §4 walks through the candidate
`LockContext<T>` where `T` would be the "snapshot" (port number,
pidfile path). The conclusion holds:

1. **Neither ctx captures snapshot state.** Port and path are passed
   as separate function arguments to `acquirePortLock(port, …)` and
   `acquirePidfileLock(path, selfPid, …)`. The interfaces are
   *capability bags* ("what the system can do"), not
   *configuration records* ("what we're trying to do").
2. **`T` would have nothing to bind to.** A `LockContext<number>`
   carries no useful invariant over `T`; the per-call argument is
   where the port/path actually lives.
3. **Forcing a shared base interface (`sleep` + `log`)** would add
   one interface (`BaseLockContext`) that exists for two trivial
   fields, and would break the seven `ProcessLockContext['signal']`
   index-access sites in `process-lock.test.ts`
   (`:26, :46, :216, :236, :249, :281, :302, :319` per the type
   analysis).
4. **The two contexts stay separate.** The class conversion does not
   change this. `PortLockAcquirer`'s constructor takes
   `ProcessLockContext`; `PidfileLockAcquirer`'s constructor takes
   `PidfileLockContext`. There is no shared `LockContext<T>` parent.

## Summary of free functions vs class surface after E.1 + E.2

| Symbol | After E.1/E.2 | Notes |
|---|---|---|
| `PortLockAcquirer` class | **new** | E.1 deliverable |
| `PidfileLockAcquirer` class | **new** | E.2 deliverable |
| `acquirePortLock(port, ctx, opts)` | wrapper | `new PortLockAcquirer(ctx, opts).acquire(port)` |
| `acquirePidfileLock(path, selfPid, ctx, opts)` | wrapper | `new PidfileLockAcquirer(ctx, selfPid, opts).acquire(path)` |
| `releaseLock()` at `index.ts:356-364` | moved to `PidfileLockAcquirer.release()` | E.4 |
| `findOwnNodeHolders` | free export | test direct-import |
| `findOwnBinaryMatches` | free export | test direct-import |
| `terminateProcesses` | free export + private method | shared body |
| `writeBufferFully` | free export | used by production `tryCreateExclusive` only |
| `DeferToPeerError` | free export | unchanged |
| `ProcessLockContext`, `PidfileLockContext` | free exports | unchanged |
| `AcquirePortLockOptions`, `AcquirePidfileLockOptions` | free exports | unchanged |
| `SignalOutcome`, `ExclusiveCreateOutcome` | free exports | unchanged |