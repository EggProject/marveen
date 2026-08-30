# E (process-lock) — Executive summary

> **Status: E.1 and E.2 LANDED in `57c78d0`** (branch `refactor/classbase`).
> `PortLockAcquirer` and `PidfileLockAcquirer` now exist in
> `src/process-lock.ts` (392 lines post-refactor); five of the six exported
> free functions (`findOwnNodeHolders`, `findOwnBinaryMatches`,
> `terminateProcesses`, `acquirePortLock`, `acquirePidfileLock`) survive as
> thin delegation wrappers and the sixth (`writeBufferFully`) is untouched,
> so `src/index.ts`,
> `src/__tests__/index.test.ts` and `src/__tests__/process-lock.test.ts` were
> not touched. E.3–E.6 remain open. See `05-refactor-roadmap.md` for the three
> deliberate deviations from the E.1/E.2 spec below.

Synthesis of `01-module-state-analysis.md` (module/state lens) and
`02-type-interface-analysis.md` (types/interfaces lens), cross-checked
against `src/process-lock.ts` (364 lines pre-E.1/E.2, measured 2026-08-30) and
`src/index.ts` on the same date. **Planning only — no source files were
modified.**

---

## Thesis

`src/process-lock.ts` is a pure-function module with zero module-level
mutable state and a clean dependency-injection seam already on every
public function: `acquirePortLock(port, ctx, opts)` and
`acquirePidfileLock(path, selfPid, ctx, opts)` both take a context object
that holds every I/O primitive (`signal`, `tryCreateExclusive`,
`probeAlive`, …). The class refactor is therefore a literal translation
— the `ctx` becomes `this`, the per-call arguments become method
arguments, and the existing test fixtures pass unchanged. The two
non-trivial concerns are (1) a single hand-rolled `LogFn` type alias
(`src/process-lock.ts:19`) that the H subsystem's `LoggerLike` interface
must replace before any class lands, and (2) one consumer
(`src/index.ts:341`, `:348`) plus two test files that import or
`vi.mock` the module and must keep working through a free-function
fallback during the migration window. Net result: two classes
(`PortLockAcquirer`, `PidfileLockAcquirer`), zero changes to the
public type surface, and a single error class (`DeferToPeerError`)
that survives the conversion untouched.

## Scope

### Files this plan TOUCHES

| File | Why | Phase |
|---|---|---|
| `src/process-lock.ts` (364 lines pre-E.1/E.2, 392 after, 9 sections) | extract `PortLockAcquirer` and `PidfileLockAcquirer` classes; keep free functions as thin wrappers until every consumer migrates | E.1, E.2, E.5, E.6 |
| `src/index.ts` | the sole production consumer (`acquirePortLock` at `:341`, `acquirePidfileLock` at `:348`, `DeferToPeerError` re-export at `:31`, throw at `:324`, `instanceof` discriminant at `:555`); construct the two acquirers and pass them into `acquireLock()` | E.3, E.4 |
| `src/__tests__/process-lock.test.ts` | 50 `it()` call sites plus 2 `it.each` blocks (`:798` with 5 entries, `:808` with 6) = 61 executed cases over the free functions; update import + per-case construction to the class API in lockstep with each consumer migration | E.3, E.4, E.5 |
| `src/__tests__/index.test.ts` | the single `vi.mock('../process-lock.js', …)` factory at `:173` must keep returning assignable symbols for the legacy call sites; the `withRealAcquirePortLock` / `withRealAcquirePidfileLock` helpers at `:1365` and `:1317` route through `vi.importActual` and must keep working | E.3, E.4, E.5 |

### Files this plan does NOT touch

- **`src/__tests__/process-lock.test.ts:81` and `:515`** test fixtures
  that build `log: { info, warn, error }` literals. They are touched
  only if H.1 lands first (the `LoggerLike` migration requires adding
  a `debug` stub to satisfy the wider interface); otherwise they stay
  as-is because the class conversion does not change the field type
  on the `ctx` interface (it only moves the `ctx` from a function
  argument to `this`). [ASSUMPTION: H.1 ordering; if H.1 lands first
  the two test fixtures need a `debug` stub.]
- **The 7 internal helpers** (`findOwnNodeHolders` `:77`,
  `findOwnBinaryMatches` `:88`, `filterOwnNodeCandidates` `:93`,
  `terminateProcesses` `:127`, `writeBufferFully` `:207`,
  `SignalOutcome` type `:24`, `ExclusiveCreateOutcome` type `:224`).
  They become private methods on the relevant class, but they keep
  their existing signatures and remain importable as free functions
  for `process-lock.test.ts` direct-exercise patterns.
- **`DeferToPeerError` (`process-lock.ts:272`).** Survives the class
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
| **E ← H** | `LoggerLike` interface from `src/logger.ts` (H.1) | `ProcessLockContext.log` (`:49`) and `PidfileLockContext.log` (`:253`) are typed as `{ info: LogFn; warn: LogFn; error: LogFn }` where `LogFn` is the local alias at `:19`. E's class conversion does not change this surface (interfaces stay), but the `LogFn` deletion is H.1 work. **Phase ordering:** E.1 cannot land before H.1, because the new `PortLockAcquirer` constructor's parameter type still references `LoggerLike` indirectly (via `ProcessLockContext.log`). |
| **E → all consumers** | `src/index.ts` is the only production consumer; `src/__tests__/index.test.ts` and `src/__tests__/process-lock.test.ts` are the only test consumers | All four call sites above must be migrated before E.5 can remove the free-function fallback. |
| **A, B, C, D, F, G → E (reverse: blocked by E?)** | none | `process-lock.ts` is consumed only by `index.ts`; no entity store, runner, lazy cache, keystone, out-of-scope item, or generic surface reads `acquirePortLock` / `acquirePidfileLock` directly. Verified by the empty `src/web/` and `src/scripts/` greps. |
| **D → E** | `class App` (D3, framework `05-refactor-roadmap.md` Phase 7) | The orchestrator must construct `PortLockAcquirer` and `PidfileLockAcquirer` (replacing the current `procCtx = buildProcessLockContext()` factory pattern at `index.ts:97-177`). This is downstream of E.5, not parallel to it. |

In short: **E is blocked on H.1, blocks D.3 / Phase 7, and is parallel
to A, B, C, F, G** (those subsystems do not consume process-lock).

## Top 3 risks specific to E

1. **`vi.mock('../process-lock.js')` factory at `index.test.ts:173` keeps
   returning symbols that `index.ts` imports.** With the current code,
   `index.ts:28-29` imports `acquirePortLock` and `acquirePidfileLock`
   as named exports and the `vi.mock` factory replaces them with
   `mockAcquirePortLock` / `mockAcquirePidfileLock` (defined at `:324`
   and `:321`). After E.1/E.2 land the classes alongside the free
   functions, the `vi.mock` factory must keep returning the same
   `acquirePortLock` / `acquirePidfileLock` names so legacy call sites
   in `index.ts` keep resolving. If E.5 (free-function removal) runs
   before the `index.ts` call sites are migrated to `new
   PortLockAcquirer(ctx).acquire(port)`, the mock factory breaks and
   the entire 5000+ line `index.test.ts` test surface goes red.
   Detail in `06-risks-and-mitigations.md` ER5.

2. **The pidfile write path is synchronous (`openSync` + `writeSync`
   inside `writeBufferFully`), not `fs.writeFile`.** Verified at
   `src/index.ts:212-232`: `tryCreateExclusive` opens with
   `openSync(path, 'wx')`, writes via the synchronous
   `writeBufferFully((b, off, len) => writeSync(fd, b, off, len), …)`,
   and closes with `closeSync(fd)`. The class version must preserve
   the sync path: any temptation to "modernize" to `fs.writeFile` would
   break the O_EXCL atomicity guarantee (the file would be visible
   before the PID was written, opening a window for a competing
   acquirer to read a truncated pidfile). Detail in
   `06-risks-and-mitigations.md` ER3.

3. **`DeferToPeerError` is thrown from TWO sites, not one.** The H
   subsystem plan cites `process-lock.ts:347` (inside
   `acquirePidfileLock`); the module-state analysis adds
   `index.ts:324` (inside `checkFreshStartupRace`). After E.2, the
   class version of `PidfileLockAcquirer.acquire()` still throws at
   `process-lock.ts:347` because the throw is inside the function body
   — the throw site does not move. But the import-and-rethrow at
   `index.ts:324` must keep working, and `DeferToPeerError` must
   remain a top-level export of `process-lock.ts` (or wherever it
   moves) so both `index.ts:31` and `index.test.ts:876` / `:1545` /
   `:1910` / `:1949` keep resolving it. Detail in
   `06-risks-and-mitigations.md` ER4.

## Migration order inside E

```
E.1  PortLockAcquirer class extraction    (introduce alongside; free fn survives)
  |
  +-----> E.3  PortLock consumer migration  (1-2 sites as proof; index.ts:341)
  |
E.2  PidfileLockAcquirer class extraction (introduce alongside; free fn survives)
  |
  +-----> E.4  PidfileLock consumer migration (1-2 sites; index.ts:348)
  |
E.5  Free function removal                (gated on E.3 + E.4 + test updates)
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
  throw that `instanceof DeferToPeerError` at `index.ts:555` catches,
  and `index.test.ts:1545` / `:1910` / `:1949` pin the class-boundary
  behaviour. Migrating it second lets the E.1 proof consumer inform
  any constructor-shape adjustments.
- **E.3 / E.4 in parallel after their respective class lands** —
  each is small (1-2 call sites) and the call sites are in the same
  `acquireLock()` block at `index.ts:337-351`.
- **E.5 last inside E.** The free-function removal is irreversible;
  the gate is `grep -rln "acquirePortLock\|acquirePidfileLock"
  src/ --include='*.ts' | grep -v __tests__` returning only
  `src/index.ts`'s class-instantiation sites (i.e. zero direct free
  function imports outside the class file itself).
- **E.6 deferred.** `LogFn` removal is H.1's deliverable (delete the
  alias at `:19`, widen the two `log:` fields to `LoggerLike`); the
  per-class logger injection (H.2) decides whether `PortLockAcquirer`
  takes the logger directly via constructor (option) or continues to
  receive it via the injected `ctx` (current shape, more likely per
  the principle of least surface change). E.6 is the "do nothing
  extra" placeholder; the actual surface is set by H.1 + H.2.