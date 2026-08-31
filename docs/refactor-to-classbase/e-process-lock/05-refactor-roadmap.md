# E (process-lock) — Refactor roadmap

Ordered phases for the E subsystem only. Each phase is
**independently shippable**: mergeable, revertable, and gated on its
own test coverage. The framework's Phase 2
(`05-refactor-roadmap.md:50-75`) is the coarse-grained counterpart;
this document decomposes Phase 2 into E.1 through E.6 and pins the
gates per phase.

The "parallelizable" marker means the phase can be executed by two
agents concurrently on disjoint file sets with no merge conflicts
beyond trivial import-line additions.

**Pre-condition (CLAUDE.md §8):** before any phase runs vitest, the
worktree must be on a `$HOME/claw-test` clean detached HEAD (not
`/tmp/`). The framework's `PROJECT_ROOT = join(__dirname, '..')`
(`src/config.ts:12`) picks up the worktree path, and the
`_TMP_PREFIXES` guard at `src/web/agent-scaffold.ts:144` rejects
`/tmp/` hook registrations — 19 spurious test fails in 4 CAT-D files.

---

## Phase E.1 — `PortLockAcquirer` class extraction

> **LANDED in `57c78d0`**, together with E.2 (one commit, same file). Three
> items below were deliberately NOT implemented; see "Deviations from the
> E.1/E.2 spec as landed" after E.2.

- **Goal:** introduce the `PortLockAcquirer` class in
  `src/process-lock.ts` alongside the existing `acquirePortLock`
  free function. The class is a literal translation of the function
  body; the free function becomes a thin wrapper that constructs a
  one-shot instance and calls `.acquire(port)`. The two surfaces
  share the body via a private implementation method.
- **Files touched:**
  - `src/process-lock.ts` — add `class PortLockAcquirer`; keep
    `acquirePortLock` as `export function acquirePortLock(port, ctx,
    opts) { return new PortLockAcquirer(ctx, opts).acquire(port) }`;
    keep `findOwnNodeHolders`, `findOwnBinaryMatches`,
    `terminateProcesses`, `writeBufferFully`, `SignalOutcome`,
    `ProcessLockContext`, `AcquirePortLockOptions` unchanged.
  - **None else.** `src/index.ts` is untouched in E.1; the
    `acquirePortLock` call site at `index.ts:341` keeps working
    against the wrapper.
  - `src/__tests__/process-lock.test.ts` — add a small new test file
    or `describe` block that exercises `new PortLockAcquirer(ctx,
    opts).acquire(port)` directly. The 8 existing `acquirePortLock`
    cases (`:333-528`) keep passing unchanged.
- **Risk:** **Low.** The class is a pure translation. The only
  behaviour-affecting risk is that the wrapper inadvertently
  re-evaluates defaults (`process-lock.ts:174-176`) on every call
  instead of once at construction — but the current behaviour
  re-evaluates defaults per call too, so a per-call wrapper
  preserves the exact semantics.
- **Test coverage requirement:**
  - All 33 existing `process-lock.test.ts` cases pass against the
    wrapper (no behaviour change).
  - New tests cover the class API:
    - Construction with `opts` resolves defaults at `acquire()` time
      (verified: pass `{}`, assert `graceMs === 1500` via log spy or
      via observed `ctx.sleep` calls).
    - `release()` is a no-op (verified: no `ctx.*` calls).
    - `acquire(port, overrides)` per-call override semantics
      [ASSUMPTION: only if E.1 lands with the `overrides?`
      parameter; otherwise drop this case].
  - `index.test.ts:876` ('defers to a legitimate alive peer that is
    not yet on the port') continues to pass — exercises the mock
    factory at `:173` against the wrapper, not the class.
- **Rollback strategy:** single commit. Revert is `git revert <sha>`;
  the wrapper signature is identical to the pre-E.1 function
  signature, so no downstream files need adjustment on rollback.
- **Parallelizable:** **no** — touches `src/process-lock.ts`, which
  is the same file E.2 will modify. E.1 must land before E.2.

---

## Phase E.2 — `PidfileLockAcquirer` class extraction

> **LANDED in `57c78d0`** (same commit as E.1).

- **Goal:** introduce the `PidfileLockAcquirer` class alongside
  `acquirePidfileLock`. Same shape as E.1: literal translation of
  the function body, free function becomes a wrapper, shared body
  via private implementation method.
- **Files touched:**
  - `src/process-lock.ts` — add `class PidfileLockAcquirer`; keep
    `acquirePidfileLock`, `DeferToPeerError`, `ExclusiveCreateOutcome`,
    `PidfileLockContext`, `AcquirePidfileLockOptions` unchanged.
  - **None else.** `src/index.ts` is untouched; the
    `acquirePidfileLock` call site at `index.ts:348` keeps working
    against the wrapper.
  - `src/__tests__/process-lock.test.ts` — add new tests that
    exercise the class API directly (atomic-create, stale-unlink,
    defer-throws-DeferToPeerError, maxAttempts-give-up).
- **Risk:** **Low–Medium.** Higher than E.1 because of
  `DeferToPeerError`. The throw site at `process-lock.ts:347` moves
  from a free function body to a method body, but the throw
  *itself* is byte-identical (`throw new DeferToPeerError(recorded)`
  with the same `recorded` value). The `instanceof DeferToPeerError`
  consumer at `index.ts:555` continues to discriminate correctly.
  Detail in `06-risks-and-mitigations.md` ER4.
- **Test coverage requirement:**
  - All 14 existing `acquirePidfileLock` cases (`:532-749`) pass
    against the wrapper.
  - New tests cover the class API:
    - `acquire(path)` constructs, calls the right sequence of `ctx`
      methods.
    - `release()` reads pidfile and unlinks iff `recorded === selfPid`
      (replaces the free `releaseLock()` at `index.ts:356-364` once
      E.4 migrates — the E.2 test covers the *behaviour*, E.4 covers
      the *call site*).
    - `DeferToPeerError` thrown from `acquire()` with
      `onLiveLegitimate: 'defer'` carries `peerPid === recorded`.
  - `index.test.ts:1545`, `:1910`, `:1949`, `:2207` continue to pass
    — they exercise the mock factory at `:173` against the wrapper.
- **Rollback strategy:** single commit. Revert restores the
  pre-E.2 function.
- **Parallelizable:** **no** — same file as E.1. E.2 must follow E.1.

---

## Deviations from the E.1/E.2 spec as landed (`57c78d0`)

E.1 and E.2 shipped as ONE commit touching two files: `src/process-lock.ts`
and the new `src/__tests__/process-lock-classes.test.ts` (9 `it()` cases;
landed with 7, raised to 9 by the `/code-review max --fix` pass in `bf5eb9d`).
Three items specified above were deliberately NOT implemented:

| Spec above | What landed instead | Why |
|---|---|---|
| `new PortLockAcquirer(ctx, opts).acquire(port)` — options in the **constructor** (E.1, "Files touched") | The constructor takes only `ctx`; options are a per-call method parameter: `acquire(port, opts = {})`. | The pre-refactor code re-evaluates the `??` defaults on every call. Per-call options preserve that exactly, which E.1's own "Risk: Low" note already argued for. It also makes one acquirer reusable across ports. |
| `release()` method (E.1 "Test coverage requirement", E.2 same) | Not added. | No such method exists today; `releaseLock()` lives at `src/index.ts:356-364` and is unrelated to the acquirer. A new method with no production caller is dead code, which `/code-review` flags as CRITICAL. Belongs to E.4, not here. |
| `acquire(port, overrides)` per-call override semantics (E.1) | Not added. | Already marked `[ASSUMPTION]` in the spec, and no caller asks for it. |

Two further design points that the spec did not pin down:

- **Where the `= {}` default lives.** Only on the class methods. The free
  function wrappers declare `opts?: Type` with no default and forward it
  unconditionally. A default on both layers would leave the method-side
  default branch unreachable via the wrapper path and break the
  `perFile: true` 100% coverage gate (`vitest.config.ts:42-48`).
- **Wrapper declaration form.** `export function name(...): Promise<void>`
  without `async`, matching `src/web/agent-process.ts:63` and
  `src/web/mcp-list.ts:78`. Behaviour is identical because the wrapper body
  cannot throw synchronously.

Measured after landing, flag-free: 384 test files / 11220 tests passing,
`src/process-lock.ts` at 100% lines (115/115), functions (15/15), statements
(129/129) and branches (66/66); `bun tsc --noEmit` unchanged at 1729 errors
and `bun run lint` unchanged at 10048 problems (both pre-existing baselines).

A caveat on that per-file number: it was already 100% before this refactor,
because the 61 cases in `process-lock.test.ts` exercise every line through
the wrappers. It therefore says nothing about whether the class-API tests in
`process-lock-classes.test.ts` are meaningful. Two of the original seven were
not: they built a ctx whose `getProcessCommand` returned `null`, so
`filterOwnNodeCandidates` discarded every candidate (`process-lock.ts:102`)
and the assertions held vacuously. `bf5eb9d` rewrote them against inline
fixtures that return real commands and assert the filtered result, and added
two cases for the `binaryPattern` ternary and the post-kill drain loop, which
until then were reached only via the wrappers and would have been left
uncovered once E.5 removes them.

---

## Phase E.3 — PortLock consumer migration (proof)

> **LANDED in `(this commit)`**. Single commit touching `src/index.ts`
> (one call site migrated from `acquirePortLock(WEB_PORT, procCtx, { binaryPattern: … })`
> to `new PortLockAcquirer(procCtx).acquire(WEB_PORT, { binaryPattern: … })`)
> and `src/__tests__/index.test.ts` (six new assertions verifying the
> class form is exercised). Free function `acquirePortLock` remains as
> the thin wrapper from E.1; E.5 is gated on E.3 + E.4.

- **Goal:** migrate the single production consumer of `acquirePortLock`
  from `acquirePortLock(WEB_PORT, procCtx, { binaryPattern: … })`
  (`src/index.ts:341`) to the class form. This is the proof consumer
  for E.1; once it passes, E.1 is validated end-to-end.
- **Files touched (as landed in `(this commit)`):**
  - `src/index.ts` — constructed `new PortLockAcquirer(procCtx)` locally
    inside `acquireLock()` at `:337-351` and called
    `await portLockAcquirer.acquire(WEB_PORT, { binaryPattern: … })`,
    replacing the prior `acquirePortLock(WEB_PORT, procCtx, { binaryPattern: … })`
    call site. `acquirePortLock` is dropped from the import at `:28` because
    `index.ts` was its only production importer (verified: zero other call
    sites exist). The free function wrapper survives from E.1 for the test
    consumers in `process-lock.test.ts`.
  - `src/__tests__/index.test.ts` — extended the
    `vi.mock('../process-lock.js')` factory at `:173` with a `PortLockAcquirer`
    mock class that forwards `.acquire(port, opts)` to
    `mockAcquirePortLock(port, this.ctx, opts)` so the class form resolves
    to the same `mockAcquirePortLock` vi.fn the suite already configures via
    `withRealAcquirePortLock` and the suite-level `mockImplementation`. The
    factory's `acquirePortLock` and `PidfileLockAcquirer` exports were
    dropped (no remaining consumer: `index.ts` no longer imports
    `acquirePortLock`, and `acquirePidfileLock` stays mocked via
    `mockAcquirePidfileLock` so `PidfileLockAcquirer` is unreachable). The
    `withRealAcquirePortLock` helper at `:1363` keeps routing through
    `vi.importActual` and the real wrapper; no change.
  - `src/__tests__/process-lock.test.ts` — untouched. The 8
    `acquirePortLock` cases (`:333-528`) keep exercising the wrapper
    unchanged (they were already class-equivalent post-E.1).
- **Risk:** **Low.** Single call site; the change is a
  constructor + method-call rewrite with byte-identical semantics.
- **Test coverage requirement:**
  - The full `bun --bun vitest run` suite passes (target: same
    total/passing count as the Phase 0 baseline).
  - `index.test.ts:876` ('defers to a legitimate alive peer that is
    not yet on the port') continues to pass.
  - The 33 `process-lock.test.ts` cases pass unchanged.
- **Rollback strategy:** single commit. Revert restores
  `acquirePortLock(WEB_PORT, procCtx, { binaryPattern: … })`.
- **Parallelizable:** **yes** — E.3 and E.4 can run concurrently
  once E.1 and E.2 have both landed, because `src/index.ts:341` and
  `:348` are independent call sites and the test updates touch
  disjoint describe blocks.

---

## Phase E.4 — PidfileLock consumer migration (proof)

- **Goal:** migrate the single production consumer of
  `acquirePidfileLock` at `src/index.ts:348` to the class form,
  and migrate the `releaseLock()` body at `:356-364` to
  `pidfileLockAcquirer.release()`.
- **Files touched:**
  - `src/index.ts` — construct a `PidfileLockAcquirer` (either
    locally in `acquireLock()` or held on a future `class App`),
    pass `process.pid` via the constructor (so `selfPid` is
    captured once), call `.acquire(PID_FILE, { onLiveLegitimate:
    'defer' })`. Replace `releaseLock()` at `:356-364` with
    `await pidfileLockAcquirer.release()`. The call sites of
    `releaseLock()` are at `:393, :402, :408, :413, :411-415`
    (per `01-module-state-analysis.md` §6 "Integration in
    `src/index.ts`'s boot flow") — each becomes
    `await pidfileLockAcquirer.release()`.
  - `src/__tests__/index.test.ts` — the `vi.mock` factory at
    `:173` substitutes `mockAcquirePidfileLock` (default
    `mockResolvedValue(undefined)` at `:321`); the
    `mockAcquirePidfileLock.mockResolvedValueOnce(…)` overrides at
    `:1545`, `:1910`, `:1949`, `:2207` etc. continue to work
    because the production code never directly calls the legacy
    free function anymore — but the mock factory still returns
    it. If E.5 (free function removal) runs first, the mock factory
    must change shape; if not, it stays as-is.
- **Risk:** **Low–Medium.** Same shape as E.3 but for the path
  that carries `DeferToPeerError`. The `instanceof DeferToPeerError`
  consumer at `index.ts:555` continues to work because the class
  is still the top-level export. Detail in `06-risks-and-mitigations.md`
  ER4.
- **Test coverage requirement:**
  - Full vitest suite passes.
  - The 14 `acquirePidfileLock` cases in `process-lock.test.ts`
    continue to pass against the wrapper OR against the class
    (whichever the test file ends up exercising after E.5).
  - The five `releaseLock()` call sites in `index.ts:393, :402,
    :408, :413, :411-415` are exercised by the integration
    shutdown test added in Phase 7 (per framework R9 mitigation
    "Test exercises the full shutdown").
- **Rollback strategy:** single commit. Revert restores the
  free-function call sites.
- **Parallelizable:** **yes** — disjoint from E.3.

---

## Phase E.5 — Free function removal

- **Goal:** remove the `acquirePortLock` and `acquirePidfileLock`
  free functions from `src/process-lock.ts` once every consumer has
  migrated to the class form. Remove the legacy `releaseLock()`
  free function at `src/index.ts:356-364` (absorbed by
  `PidfileLockAcquirer.release()` in E.4).
- **Files touched:**
  - `src/process-lock.ts` — delete the two wrapper `export function
    acquirePortLock` / `acquirePidfileLock` declarations. Keep
    `findOwnNodeHolders`, `findOwnBinaryMatches`, `terminateProcesses`,
    `writeBufferFully`, `SignalOutcome`, `ExclusiveCreateOutcome`,
    `DeferToPeerError`, `ProcessLockContext`, `PidfileLockContext`,
    `AcquirePortLockOptions`, `AcquirePidfileLockOptions`.
  - `src/__tests__/process-lock.test.ts` — update imports and any
    direct-exercise cases that call the removed free functions. The
    `process-lock.test.ts:5, :6, :7` imports of `findOwnNodeHolders`,
    `findOwnBinaryMatches`, `terminateProcesses` stay. The
    `acquirePortLock` / `acquirePidfileLock` import lines (`:8, :9`)
    are removed and the cases rewritten to use `new
    PortLockAcquirer(ctx).acquire(port)` etc.
  - `src/__tests__/index.test.ts` — the `vi.mock('../process-lock.js')`
    factory at `:173` must change shape: it no longer mocks the
    free functions (they don't exist) but still mocks the
    *constructors* OR — more likely — `index.ts:341` no longer
    imports anything from `process-lock.js` (it constructs the
    class locally), so the `vi.mock` factory is removed entirely
    OR reduced to mocking only `writeBufferFully` / `DeferToPeerError`.
    [ASSUMPTION: the exact factory shape depends on whether
    `index.ts` constructs the acquirers inline or via a `class
    App` factory. If inline, the factory may disappear. If via
    `class App`, the factory mocks the constructor.]
  - `src/__tests__/index.test.ts:1363` (`withRealAcquirePortLock`)
    and `:1314` (`withRealAcquirePidfileLock`) — these helpers
    delegate to `actual.acquirePortLock` /
    `actual.acquirePidfileLock` via `vi.importActual`. After E.5
    the imports return `undefined`; the helpers must be rewritten
    to construct a real instance OR removed entirely. The 13+ test
    groups that use these helpers (`:1377-1481`, `:2743-2790+`,
    `:2206+`, `:2148+`, `:876+` per `01-module-state-analysis.md`
    §8 "Test groups that depend on the real acquire functions")
    must be updated or deleted.
- **Risk:** **Medium.** E.5 is the irreversible step. The gate is
  mechanical: `grep -rln "acquirePortLock\|acquirePidfileLock" src/
  --include='*.ts' | grep -v __tests__` must return only the
  internal references inside `src/process-lock.ts` (the class
  definitions themselves) and `src/index.ts` (the class instantiation
  sites). If any test file outside `__tests__` imports the free
  function, E.5 must not run.
- **Test coverage requirement:**
  - Full vitest suite passes.
  - No `import { acquirePortLock, acquirePidfileLock }` exists
    outside `src/process-lock.ts` and `src/__tests__/*`.
  - The `vi.mock('../process-lock.js')` factory is updated and
    continues to provide whatever `index.ts` now imports from that
    module (the classes, plus `writeBufferFully` and
    `DeferToPeerError` if they are still imported).
  - The `withReal*` helpers at `index.test.ts:1363` and `:1314`
    are removed or rewritten; the 13+ dependent test groups pass.
- **Rollback strategy:** per-function commits. E.5a removes
  `acquirePortLock` after its consumer at `index.ts:341` migrates;
  E.5b removes `acquirePidfileLock` after `:348`. Each is
  independently revertable.
- **Parallelizable:** **no** — touches the same file as every prior
  E phase and modifies the `vi.mock` factory that
  `index.test.ts:173` already pins. E.5 must follow E.3 + E.4
  sequentially.

---

## Phase E.6 — `LogFn` removal (H.1 + H.2 dependency)

- **Goal:** delete the local `type LogFn` alias at
  `src/process-lock.ts:19`; replace the two `log: { info: LogFn;
  warn: LogFn; error: LogFn }` fields at `:49` and `:253` with
  `log: LoggerLike` (imported from `src/logger.ts`); collapse the
  two adapter literals at `src/index.ts:171-175` and `:280-287` to
  `log: logger`; fix the off-by-one comment at `index.ts:283`
  (`1382` → `1383`).
- **Files touched:**
  - `src/process-lock.ts` — delete `type LogFn` at `:19`; add
    `import type { LoggerLike } from './logger.js'`; replace the
    two `log: { info: LogFn; warn: LogFn; error: LogFn }` fields
    with `log: LoggerLike`.
  - `src/index.ts` — collapse `log: { info: (obj, msg) =>
    logger.info(obj, msg), warn: …, error: … }` to
    `log: logger` at both sites; fix the `1382` → `1383` comment.
  - `src/__tests__/process-lock.test.ts:81` and `:515` — add
    `debug: log('debug')` stub to satisfy `LoggerLike` conformance.
- **Risk:** **Low.** Pure type-side change. All 13 in-file call
  sites (`:107, :112, :136, :138, :155, :158, :181, :196, :301,
  :328, :336, :346, :350, :352, :362`) use the obj-first form
  and satisfy `LoggerLike.LogFn` without modification. The
  widening from `Record<string, unknown>` to `object` is a
  superset direction.
- **Test coverage requirement:**
  - All `process-lock.test.ts` cases pass.
  - The pin test at `index.test.ts:1383` ('forwards pidfile
    context errors to logger.error') continues to pass.
  - `bun tsc --noEmit` delta from the baseline is **zero** (this
    phase should produce no type errors).
- **Rollback strategy:** single commit. Revert restores the
  `LogFn` alias.
- **Parallelizable:** **yes** — `src/process-lock.ts` is shared
  with prior E phases but the changes are local (delete one line,
  modify two fields, add one import). E.6 can run in parallel
  with E.5 if the file has been refactored to be just-class
  (no free-function wrappers); otherwise E.6 follows E.5.

---

## Summary dependency graph (E only)

```
H.1 (LoggerLike) ──────────┐
                           │
                           v
                E.1 (PortLockAcquirer class) ─── E.3 (consumer migrate)
                           │                            │
                           │                            │
                E.2 (PidfileLockAcquirer class) ── E.4 (consumer migrate)
                           │                            │
                           │                            v
                           └──────────► E.5 (free fn removal) ◄──┘
                                                  │
                                                  v
                                       E.6 (LogFn removal, gated on H.1 + H.2)
```

## Risk-level summary

| Phase | Risk | Files touched | Rollback granularity |
|---|---|---|---|
| E.1 | Low | 1 | commit (landed `57c78d0`) |
| E.2 | Low–Medium | 1 | commit (landed `57c78d0`) |
| E.3 | Low | 2 | commit |
| E.4 | Low–Medium | 2 | commit |
| E.5 | Medium | 3 | per-function commit |
| E.6 | Low | 3 | commit |

## Pre-conditions for E.5 (free function removal)

E.5 must not run until:

1. E.1, E.2, E.3, E.4 have all merged to `feature-develop`.
2. The full test suite passes on the merged branch.
3. The mechanical gate holds:
   `grep -rln "acquirePortLock\|acquirePidfileLock" src/ --include='*.ts'
   | grep -v __tests__` returns only `src/index.ts` (or empty if
   `index.ts` also migrated to inline construction) and the
   internal references inside `src/process-lock.ts`.
4. The `vi.mock('../process-lock.js')` factory at
   `index.test.ts:173` has been updated for the new export shape
   (the helpers at `:1363` and `:1314` too).

## Pre-conditions for E.6 (`LogFn` removal)

E.6 must not run until:

1. H.1 has landed: `src/logger.ts` exports `LoggerLike`.
2. H.2 has shipped a proof consumer (per the framework roadmap
   `05-refactor-roadmap.md` Phase 1.5 / 2 boundary) so the
   constructor-injection pattern is verified to work before E
   adopts it.
3. E.5 has either landed OR is in flight — E.6 and E.5 can
   parallelise only if they touch disjoint lines (E.5 removes
   free functions; E.6 modifies field types). Verify with a
   `git diff` against the E.5 baseline.