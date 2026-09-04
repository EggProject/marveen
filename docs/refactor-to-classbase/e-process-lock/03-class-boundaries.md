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

- **Source file:** `src/process-lock.ts` (same file).
- **Migration source:** the body of `acquirePortLock` (formerly at
  `src/process-lock.ts:169-197`, deleted in E.5a), plus the helpers it
  calls (`findOwnNodeHolders` formerly `:77`, `findOwnBinaryMatches`
  formerly `:88`, `filterOwnNodeCandidates` `:93`, `terminateProcesses`
  formerly `:127`). The class is a literal translation: the `ctx`
  argument becomes `this`, the `opts` argument becomes a
  constructor-injected option, and the `port` argument becomes the
  method argument. Post-E.5 these are all public methods on the class.

### Public surface (signatures only)

```ts
class PortLockAcquirer {
  constructor(
    private readonly ctx: ProcessLockContext,
  )

  acquire(port: number, opts: AcquirePortLockOptions = {}): Promise<void>
  findOwnNodeHolders(port: number): number[]
  findOwnBinaryMatches(pattern: RegExp): number[]
  terminateProcesses(pids: number[], opts: { graceMs: number }): Promise<void>
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `acquire(port, opts?)` | free `acquirePortLock(port, ctx, opts)` (deleted in E.5a) | method body inside `process-lock.ts:77` | Per-call options preserve the original per-call default evaluation. Production callers always pass the constructor-supplied opts once and omit them per call. |
| `findOwnNodeHolders(port)` | free `findOwnNodeHolders(port, ctx)` (deleted in E.5a) | method body inside `process-lock.ts:77` | Exposed as a public method so `process-lock.test.ts:83-160` can exercise it directly via `new PortLockAcquirer(ctx).findOwnNodeHolders(port)`. |
| `findOwnBinaryMatches(pattern)` | free `findOwnBinaryMatches(pattern, ctx)` (deleted in E.5a) | method body inside `process-lock.ts:77` | Same — exposed as a public method for direct test exercise. |
| `terminateProcesses(pids, opts)` | free `terminateProcesses(pids, ctx, opts)` (deleted in E.5a) | method body inside `process-lock.ts:77` | Same — exposed as a public method for the `terminateProcesses` describe block in `process-lock.test.ts:191-326`. |
| `release()` | n/a | n/a | Was REJECTED per EOE-1 (no-op "for shape parity") and dropped from the public surface. `App.shutdown()` calls `await pidfileLockAcquirer.release()` and skips the port lock. |

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

### Free functions that REMAIN after E.1 (and after E.5)

| Symbol | Location | Why it stays |
|---|---|---|
| `acquirePortLock(port, ctx, opts)` | was `process-lock.ts:169-197` | DELETED in E.5a (`d4f2d71`); body survives as `PortLockAcquirer.acquire()` method |
| `findOwnNodeHolders(port, ctx)` | was `process-lock.ts:77-80` | DELETED in E.5a (`d4f2d71`) as a free export; body survives as `PortLockAcquirer.findOwnNodeHolders(port)` public method (called by `process-lock.test.ts:86-160` via `new PortLockAcquirer(ctx).findOwnNodeHolders(port)`) |
| `findOwnBinaryMatches(pattern, ctx)` | was `process-lock.ts:88-91` | DELETED in E.5a; body survives as `PortLockAcquirer.findOwnBinaryMatches(pattern)` public method |
| `terminateProcesses(pids, ctx, opts)` | was `process-lock.ts:127-161` | DELETED in E.5a; body survives as `PortLockAcquirer.terminateProcesses(pids, opts)` public method |
| `writeBufferFully(writer, buf)` | `process-lock.ts:209-222` | Used by `index.ts:220-223` (the production `tryCreateExclusive` implementation), not by `PortLockAcquirer.acquire`. Stays as a free export untouched by E.1 / E.5. |
| `SignalOutcome` type alias | `process-lock.ts:24` | Type-only export; survives all phases. |

### Free functions that DO NOT exist on the class

- **Throw helpers.** `PortLockAcquirer.acquire()` does not throw
  project-specific errors. It only logs warnings and lets
  `ctx.signal`'s thrown errors bubble. The class does not
  introduce any throw site that needs a separate helper.

---

## E2. `PidfileLockAcquirer`

### Source and migration

- **Source file:** `src/process-lock.ts` (same file).
- **Migration source:** the body of `acquirePidfileLock` (formerly at
  `src/process-lock.ts:289-364`, deleted in E.5b), plus the
  `DeferToPeerError` throw site (now at `:350` inside the class method
  body) and the final-attempts-exhausted throw (now at `:366`). As
  with E1, the `ctx` becomes `this` and `selfPid` + `path` are passed
  per call.

### Public surface (signatures only — landed)

```ts
class PidfileLockAcquirer {
  constructor(private readonly ctx: PidfileLockContext)

  acquire(path: string, selfPid: number, opts: AcquirePidfileLockOptions = {}): Promise<void>
  release(path: string, selfPid: number): void
}
```

Note: the constructor takes **only** `ctx`; both `selfPid` and `path`
are per-call method arguments (matching the free function's argument
order, and matching what `index.ts:358` /
`index.ts:367` pass). The `release()` method takes
`(path, selfPid)` for the same reason — it must operate on the same
path / PID pair that `acquire()` was called with.

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `acquire(path, selfPid, opts?)` | free `acquirePidfileLock(path, selfPid, ctx, opts)` (deleted in E.5b) | method body inside `process-lock.ts:294` | `selfPid` and `path` are per-call because the caller (production or test) may want to acquire against multiple paths or PIDs in sequence. Per-call options preserve the original per-call default evaluation. |
| `release(path, selfPid)` | `releaseLock()` body in `src/index.ts:364-371` (which now wraps `pidfileLockAcquirer.release(PID_FILE, process.pid)`) | `process-lock.ts:383-388` | The current `releaseLock()` reads the pidfile and unlinks it only if `recorded === selfPid`. The class version absorbed the same logic. Sync (`void`) because the underlying `readFileSync` + `unlinkSync` I/O is sync; shutdown callers in `process.on('SIGTERM')` and the hardKill timer cannot `await`. |

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

### Free functions that REMAIN after E.2 (and after E.5)

| Symbol | Location | Why it stays |
|---|---|---|
| `acquirePidfileLock(path, selfPid, ctx, opts)` | was `process-lock.ts:289-364` | DELETED in E.5b (`8f33a22`); body survives as `PidfileLockAcquirer.acquire(path, selfPid, opts)` method. |
| `DeferToPeerError` class | `process-lock.ts:274-281` | Exported for two reasons: (a) `src/index.ts:31` re-exports it; (b) `src/index.ts:333` instantiates it inside `checkFreshStartupRace` (the pre-acquire early-exit). The class version of `acquire()` throws it from inside the class method, but `index.ts:333` still throws it directly. **Either way the class must remain a top-level export** so both call sites resolve. |
| `ExclusiveCreateOutcome` type alias | `process-lock.ts:226` | Type-only export; survives. |

### Free functions that DO NOT exist on the class

- **Throw helpers.** `PidfileLockAcquirer.acquire()` throws
  `DeferToPeerError` (now at `:350` inside the class method body)
  and a generic `Error(...)` on max-attempts exhaustion (now at
  `:366`). Both throws stay inside `process-lock.ts`; the throw
  site moved by 3 lines because the class body adds the
  `this.ctx.*` prefix and the method signature, but the throw site
  itself did not move out of `process-lock.ts`.

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

## Summary of free functions vs class surface after E.5

| Symbol | After E.5 | Notes |
|---|---|---|
| `PortLockAcquirer` class | **landed** | E.1 deliverable; `acquire(port, opts)`, `findOwnNodeHolders(port)`, `findOwnBinaryMatches(pattern)`, `terminateProcesses(pids, opts)` methods |
| `PidfileLockAcquirer` class | **landed** | E.2 deliverable; `acquire(path, selfPid, opts)` and `release(path, selfPid)` methods |
| `acquirePortLock(port, ctx, opts)` | DELETED (E.5a) | body survives as `PortLockAcquirer.acquire()` method |
| `acquirePidfileLock(path, selfPid, ctx, opts)` | DELETED (E.5b) | body survives as `PidfileLockAcquirer.acquire()` method |
| `releaseLock()` at `index.ts:364-371` | thin caller of `pidfileLockAcquirer.release(PID_FILE, process.pid)` | E.4 absorbed the body; E.5 left the local wrapper in `index.ts` |
| `findOwnNodeHolders` | DELETED as free export (E.5a) | body survives as `PortLockAcquirer.findOwnNodeHolders(port)` method |
| `findOwnBinaryMatches` | DELETED as free export (E.5a) | body survives as `PortLockAcquirer.findOwnBinaryMatches(pattern)` method |
| `terminateProcesses` | DELETED as free export (E.5a) | body survives as `PortLockAcquirer.terminateProcesses(pids, opts)` method |
| `writeBufferFully` | free export | used by production `tryCreateExclusive` only |
| `DeferToPeerError` | free export | unchanged |
| `ProcessLockContext`, `PidfileLockContext` | free exports | unchanged |
| `AcquirePortLockOptions`, `AcquirePidfileLockOptions` | free exports | unchanged |
| `SignalOutcome`, `ExclusiveCreateOutcome` | free exports | unchanged |