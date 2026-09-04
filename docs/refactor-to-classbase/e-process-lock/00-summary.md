# E (process-lock) — Executive summary

> **Status: E.1 and E.2 LANDED in `57c78d0`, E.3 LANDED in `(this commit)`,
> E.4 LANDED in `30509d4`, E.5 LANDED in `d4f2d71` + `8f33a22`** (branch
> `refactor/classbase`).
> `PortLockAcquirer` and `PidfileLockAcquirer` now exist in
> `src/process-lock.ts` (389 lines post-refactor); the five formerly-free
> functions (`findOwnNodeHolders`, `findOwnBinaryMatches`,
> `terminateProcesses`, `acquirePortLock`, `acquirePidfileLock`) are gone
> as exports and survive as public methods on the two classes, and the
> sixth (`writeBufferFully`) is the lone remaining free function in the
> module. E.3 migrated the sole production consumer of `acquirePortLock`
> (`src/index.ts:341`) to the class form; E.4 migrated the
> `acquirePidfileLock` consumer and absorbed the `releaseLock()` body
> into `PidfileLockAcquirer.release()`; E.5 deleted the five free-function
> wrappers (E.5a: four `PortLockAcquirer`-related; E.5b:
> `acquirePidfileLock`) and migrated 44 test call sites in
> `src/__tests__/process-lock.test.ts` to the class form. E.6 remains
> open. See `05-refactor-roadmap.md` for the three deliberate deviations
> from the E.1/E.2 spec below.

Synthesis of `01-module-state-analysis.md` (module/state lens) and
`02-type-interface-analysis.md` (types/interfaces lens), cross-checked
against `src/process-lock.ts` (389 lines post-E.5, measured 2026-09-04)
and `src/index.ts` on the same date. **Planning only — no source files
were modified by this reconciliation pass.**

---

## Thesis

`src/process-lock.ts` is a pure-function module with zero module-level
mutable state and a clean dependency-injection seam already on every
public method. After E.5 the module exposes two classes
(`PortLockAcquirer`, `PidfileLockAcquirer`) whose `acquire(port,
…)` / `acquire(path, selfPid, …)` methods take a context object that
holds every I/O primitive (`signal`, `tryCreateExclusive`,
`probeAlive`, …); the five free-function wrappers
(`findOwnNodeHolders`, `findOwnBinaryMatches`, `terminateProcesses`,
`acquirePortLock`, `acquirePidfileLock`) that pre-existed are gone,
with their bodies surviving as public methods on the classes. The
`ctx` becomes `this`, the per-call arguments become method
arguments, and the existing test fixtures pass against the class API.
The two non-trivial concerns are (1) a single hand-rolled `LogFn`
type alias (`src/process-lock.ts:19`) that the H subsystem's
`LoggerLike` interface must replace before any class lands, and (2)
the test files (`src/__tests__/process-lock.test.ts`,
`src/__tests__/index.test.ts`) whose `vi.mock` factory and
`withReal*` helpers had to be rewritten in lockstep with E.5 to
construct the class instead of calling a free function. Net result:
two classes, a single error class (`DeferToPeerError`) that survives
the conversion untouched, and `writeBufferFully` as the lone
remaining free function.

## Scope

### Files this plan TOUCHES

| File | Why | Phase |
|---|---|---|
| `src/process-lock.ts` (364 lines pre-E.1/E.2, 389 after E.5, 9 sections) | extract `PortLockAcquirer` and `PidfileLockAcquirer` classes; E.5 deleted the five free-function wrappers (their bodies are now public methods on the classes); E.6 still pending for the `LogFn` → `LoggerLike` migration | E.1, E.2, E.5, E.6 |
| `src/index.ts` | the sole production consumer (now constructs `new PortLockAcquirer(procCtx).acquire(WEB_PORT, { binaryPattern: ... })` at `:350` and `new PidfileLockAcquirer(buildPidfileLockContext(procCtx)).acquire(PID_FILE, process.pid, { onLiveLegitimate: 'defer' })` at `:357-358`; `DeferToPeerError` re-export at `:31`, throw at `:333`, `instanceof` discriminant at `:564`) | E.3, E.4 |
| `src/__tests__/process-lock.test.ts` | 50 `it()` call sites plus 2 `it.each` blocks (`:798` with 5 entries, `:808` with 6) = 61 executed cases over the class methods; E.5 rewrote 44 call sites to use `new PortLockAcquirer(ctx).X(...)` / `new PidfileLockAcquirer(ctx).acquire(...)` form | E.3, E.4, E.5 |
| `src/__tests__/index.test.ts` | the single `vi.mock('../process-lock.js', …)` factory at `:173` was updated in E.5 to provide `PortLockAcquirer`, `PidfileLockAcquirer`, `writeBufferFully`, and `DeferToPeerError` (the `mockAcquirePortLock` / `mockAcquirePidfileLock` `vi.fn()`s are retained as the mock-class delegation targets); the `withRealAcquirePortLock` / `withRealAcquirePidfileLock` helpers at `:1365` and `:1317` were rewritten to construct real instances via `vi.importActual` | E.3, E.4, E.5 |

### Files this plan does NOT touch

- **`src/__tests__/process-lock.test.ts:81` and `:515`** test fixtures
  that build `log: { info, warn, error }` literals. They are touched
  only if H.1 lands first (the `LoggerLike` migration requires adding
  a `debug` stub to satisfy the wider interface); otherwise they stay
  as-is because the class conversion does not change the field type
  on the `ctx` interface (it only moves the `ctx` from a function
  argument to `this`). [ASSUMPTION: H.1 ordering; if H.1 lands first
  the two test fixtures need a `debug` stub.]
- **The 5 internal helpers that became public class methods**
  (`findOwnNodeHolders` `:86`, `findOwnBinaryMatches` `:97`,
  `terminateProcesses` `:136`, plus `writeBufferFully` `:209`,
  `filterOwnNodeCandidates` `:93`). E.5 deleted the free-function
  wrappers for `findOwnNodeHolders`, `findOwnBinaryMatches`, and
  `terminateProcesses`; their bodies survive as **public methods
  on `PortLockAcquirer`** so `process-lock.test.ts` can exercise
  them via `new PortLockAcquirer(ctx).findOwnNodeHolders(port)` etc.
  `writeBufferFully` is unchanged (still a free function used by
  `index.ts`'s `tryCreateExclusive`).
- **`DeferToPeerError` (`process-lock.ts:274`).** Survives the class
  refactor unchanged. Its hand-set `this.name = 'DeferToPeerError'`
  pattern would be replaced by `new.target.name` under the H.4
  `AppError` base, but E does not own that decision; H.4 first-pair
  picks `RequestBodyTooLargeError` and `PeerResponseTooLargeError`
  per `h-cross-cutting/03-class-boundaries.md:289-303`.
- **`src/web/*` and `src/scripts/*`.** `grep -rEn
  "acquirePortLock|acquirePidfileLock" --include='*.ts' src/web/
  scripts/` returns zero hits. The web layer consumes the running
  server, never the lock primitives; E has no migration work in the
  web tree.

## Dependency: what E blocks and what blocks E

| Direction | Counterparty | What |
|---|---|---|
| **E ← H** | `LoggerLike` interface from `src/logger.ts` (H.1) | `ProcessLockContext.log` (`:49`) and `PidfileLockContext.log` (`:253`) are typed as `{ info: LogFn; warn: LogFn; error: LogFn }` where `LogFn` is the local alias at `:19`. E's class conversion does not change this surface (interfaces stay), but the `LogFn` deletion is H.1 work. **Phase ordering:** E.1–E.5 all landed without H.1; E.6 is still gated on H.1 because deleting `LogFn` requires `LoggerLike` to exist. |
| **E → all consumers** | `src/index.ts` was the only production consumer; `src/__tests__/index.test.ts` and `src/__tests__/process-lock.test.ts` were the only test consumers | All call sites were migrated (E.3, E.4) before E.5 removed the free-function wrappers. |
| **A, B, C, D, F, G → E (reverse: blocked by E?)** | none | `process-lock.ts` is consumed only by `index.ts`; no entity store, runner, lazy cache, keystone, out-of-scope item, or generic surface reads the class methods directly. Verified by the empty `src/web/` and `src/scripts/` greps. |
| **D → E** | `class App` (D3, framework `05-refactor-roadmap.md` Phase 7) | The orchestrator will need to construct `PortLockAcquirer` and `PidfileLockAcquirer` (replacing the current `procCtx = buildProcessLockContext()` factory pattern at `index.ts:97-177`). This is downstream of E.5, not parallel to it. |

In short: **E is unblocked (E.1–E.5 all landed), E.6 is gated on H.1,
E blocks D.3 / Phase 7, and E is parallel to A, B, C, F, G** (those
subsystems do not consume process-lock).

## Top 3 risks specific to E

1. **`vi.mock('../process-lock.js')` factory at `index.test.ts:173` keeps
   returning symbols that `index.ts` imports.** Post-E.5 the factory
   must return `PortLockAcquirer`, `PidfileLockAcquirer`,
   `writeBufferFully`, and `DeferToPeerError` (the legacy
   `mockAcquirePortLock` / `mockAcquirePidfileLock` `vi.fn()`s are
   retained as the inner implementations the mock classes delegate to).
   `index.ts` no longer imports any free function from `process-lock.js`;
   it imports the two classes and `DeferToPeerError` only. The factory
   shape was updated in lockstep with E.5 and the 13+ test groups that
   route through the `withReal*` helpers continue to pass. Detail in
   `06-risks-and-mitigations.md` ER5.

2. **The pidfile write path is synchronous (`openSync` + `writeSync`
   inside `writeBufferFully`), not `fs.writeFile`.** Verified at
   `src/index.ts:212-232`: `tryCreateExclusive` opens with
   `openSync(path, 'wx')`, writes via the synchronous
   `writeBufferFully((b, off, len) => writeSync(fd, b, off, len), …)`,
   and closes with `closeSync(fd)`. The class version preserves the
   sync path: any temptation to "modernize" to `fs.writeFile` would
   break the O_EXCL atomicity guarantee (the file would be visible
   before the PID was written, opening a window for a competing
   acquirer to read a truncated pidfile). Detail in
   `06-risks-and-mitigations.md` ER3.

3. **`DeferToPeerError` is thrown from TWO sites, not one.** The H
   subsystem plan cites `process-lock.ts:347` (inside
   `acquirePidfileLock`); the module-state analysis adds
   `index.ts:333` (inside `checkFreshStartupRace`). After E.5, the
   class version of `PidfileLockAcquirer.acquire()` still throws at
   `process-lock.ts:350` (the throw moves by 3 lines because the
   class body adds the `this.ctx.*` prefix and the method signature)
   — the throw is inside the class body. The import-and-rethrow at
   `index.ts:333` must keep working, and `DeferToPeerError` must
   remain a top-level export of `process-lock.ts` so both
   `index.ts:31` and `index.test.ts:876` / `:1545` / `:1910` /
   `:1949` keep resolving it. Detail in `06-risks-and-mitigations.md`
   ER4.

## Migration order inside E

```
E.1  PortLockAcquirer class extraction    [LANDED 57c78d0]
  |
  +-----> E.3  PortLock consumer migration  [LANDED (this commit)]
  |
E.2  PidfileLockAcquirer class extraction [LANDED 57c78d0]
  |
  +-----> E.4  PidfileLock consumer migration [LANDED 30509d4]
  |
E.5  Free function removal                [LANDED d4f2d71 + 8f33a22]
  |
E.6  LogFn removal                        (depends on H.1 + H.2 per-class logger)
```

Rationale:

- **E.1 first** because the port-lock path is the lower-risk of the two
  (no error class thrown, no `onLiveLegitimate` discriminator, no
  `vi.importActual` indirection — `index.test.ts:173`'s mock factory
  already substitutes `mockAcquirePortLock` as a faithful
  re-implementation).
- **E.2 second** because the pidfile path has the `DeferToPeerError`
  throw that `instanceof DeferToPeerError` at `index.ts:564` catches,
  and `index.test.ts:1545` / `:1910` / `:1949` pin the class-boundary
  behaviour. Migrating it second lets the E.1 proof consumer inform
  any constructor-shape adjustments.
- **E.3 / E.4 in parallel after their respective class lands** —
  each is small (1-2 call sites) and the call sites are in the same
  `acquireLock()` block at `index.ts:327-358`.
- **E.5 last inside E.** The free-function removal is irreversible;
  the gate is `grep -rln "acquirePortLock\|acquirePidfileLock"
  src/ --include='*.ts' | grep -v __tests__` returning **zero**
  matches — confirmed after `d4f2d71` + `8f33a22`.
- **E.6 deferred.** `LogFn` removal is H.1's deliverable (delete the
  alias at `:19`, widen the two `log:` fields to `LoggerLike`); the
  per-class logger injection (H.2) decides whether `PortLockAcquirer`
  takes the logger directly via constructor (option) or continues to
  receive it via the injected `ctx` (current shape, more likely per
  the principle of least surface change). E.6 is the "do nothing
  extra" placeholder; the actual surface is set by H.1 + H.2.