# H (cross-cutting) — Refactor roadmap

Ordered phases for the H subsystem only. Phases in other subsystems
(framework `05-refactor-roadmap.md` Phases 0-8) are referenced where they
gate or are gated by H.

**Gate baselines must be measured before this plan executes.** Per CLAUDE.md
§8, a gate expressed as "no new errors" against an unmeasured baseline is
unusable. The framework's own execution history (`dc1965a` cycle) recorded
`bun tsc --noEmit` at 1742 pre-existing errors and `bun run lint` at 10084
pre-existing problems. **No baseline was re-measured for this document** —
running the suite requires the clean-worktree procedure in CLAUDE.md §8 and
is out of scope for a planning pass. Phase H.0 below exists solely to capture
those numbers; every later phase's gate is expressed as a delta against them.

---

## Phase H.0 — Measure the gates

- **Goal:** produce the three baseline numbers every later gate is expressed
  against.
- **Files touched:** none.
- **Work:** in a clean worktree under `$HOME` (per CLAUDE.md §8 — **not**
  `/tmp/`, which triggers the `_TMP_PREFIXES` registration guard at
  `src/web/agent-scaffold.ts:144` and produces 19 spurious failures), record:
  1. `bun tsc --noEmit` error count
  2. `bun run lint` problem count
  3. `bun --bun vitest run` pass/fail counts
- **Risk level:** none.
- **Test coverage requirement:** n/a.
- **Rollback:** n/a.
- **Parallelizable:** n/a — blocks every other phase.

---

## Phase H.1 — `LoggerLike` introduction (additive)

- **Goal:** export a `LoggerLike` interface from `src/logger.ts` and adopt it
  in the one module that already hand-rolls the same shape. **The
  `export const logger` singleton at `logger.ts:3` is not touched.** No
  consumer changes behaviour; no log line moves.
- **Files touched (3):**
  - `src/logger.ts` — add `export interface LogFn` and
    `export interface LoggerLike` (shape in
    `04-generic-interfaces.md` §L). The existing 9 lines are unchanged.
  - `src/process-lock.ts` — delete the local `type LogFn` at `:19`; change
    `ProcessLockContext.log` (`:49`) and `PidfileLockContext.log` (`:253`)
    from `{ info: LogFn; warn: LogFn; error: LogFn }` to `LoggerLike`.
  - `src/index.ts` — the two adapter literals at `:171-175` and `:280-287`
    collapse to `log: logger`.
  - (plus `src/__tests__/process-lock.test.ts`, per the trap below)
- **Risk level:** **Low**, with one live trap. Widening
  `ProcessLockContext.log` from a 3-method to a 4-method shape breaks every
  *test* that supplies a hand-built `ctx.log` object. Two such sites exist and
  both are in one file:
  `src/__tests__/process-lock.test.ts:81` and `:515`, each
  `log: { info: log('info'), warn: log('warn'), error: log('error') }`. Both
  need a `debug` stub. Re-run
  `grep -rn "log: {" src/__tests__/ src/**/__tests__/` before editing to
  confirm the count is still 2.
- **Test coverage requirement:**
  1. A compile-time assignability pin: a test (or a `// @ts-expect-error`-free
     type-only file) asserting `const _: LoggerLike = logger` compiles. This
     is the guard for `06-risks-and-mitigations.md` HR4 and must land in the
     same commit as the interface.
  2. A negative pin: `// @ts-expect-error` on an object literal missing
     `debug`, proving the interface actually requires all four members.
  3. `src/__tests__/logger.test.ts` (4 tests, all on pino option assembly)
     must pass unchanged — H.1 changes no option.
  4. `src/__tests__/index.test.ts` `'forwards pidfile context errors to
     logger.error'` (at `index.test.ts:1383`, cited by the source comment at
     `index.ts:281-283` as 1382) must pass unchanged: it is the only pin on
     the forwarder-only `PidfileLockContext.log.error` path, and the adapter
     collapse is what could break it.
- **Rollback:** single commit, revertible in isolation. The interface is
  additive; reverting it restores `type LogFn` at `process-lock.ts:19` and
  the two adapter literals. No data, no schema, no persisted state.
- **Parallelizable:** **No.** This is the gate for framework Phase 2
  (process-lock classes) and for every constructor signature in Parts A, B,
  C2/C3, D1, E. `review-completeness.md` OE-11 already noted the framework
  marks its Phase 1 and Phase 2 as parallel when they are not; H.1 → H.2 and
  H.1 → framework-Phase-2 are hard arrows.

---

## Phase H.2 — Per-class logger injection

- **Goal:** prove the constructor-injection pattern on exactly one consumer,
  fix the test-factory convention there, then roll out only as each owning
  subsystem converts. H.2 never converts a consumer ahead of its subsystem.

### H.2a — Proof consumer

- **Files touched (3):** `src/process-lock.ts`, `src/index.ts`, and
  `src/__tests__/index.test.ts` (plus `process-lock`'s own test file if one
  exists separately).
- **Why process-lock:** it is the only module that already has the DI seam.
  `acquirePortLock` (`process-lock.ts:169`) and `acquirePidfileLock`
  (`process-lock.ts:289`) already take a context bag containing `log`
  (`:49`, `:253`), and `index.ts` already constructs that bag
  (`:171-175`, `:280-287`). Converting it to `class PortLockAcquirer` /
  `class PidfileLockAcquirer` (framework `03 §E1`/`§E2`) moves the bag onto
  `this` — that is the smallest possible instance of the pattern, with one
  production call site each.
- **Deliverable beyond the code:** the **test factory**. This is the item
  `review-completeness.md` CE-5 and CE-15 both flag as missing, and it is
  what makes or breaks the other ~90 conversions. Minimum:
  ```ts
  function createTestLogger(): LoggerLike & { /* vi.fn handles */ }
  ```
  returning a four-method `vi.fn()` object typed as `LoggerLike`, so it is
  passed by constructor and never by `vi.mock`. The convention must be
  written down in the same commit, because the first 5-10 conversions define
  what the remaining 80 copy.
- **Risk level:** **Medium.** The dual-destination hazard
  (`06-risks-and-mitigations.md` HR3) first becomes reachable here.
- **Test coverage requirement:** every assertion that today reads
  `mockLogger.info.mock.calls` for a process-lock code path must still pass,
  now against the constructor-injected instance rather than the mocked
  module. If any such assertion silently drops to zero calls, HR3 has bitten
  and the phase does not land.
- **Rollback:** one commit; the free functions are kept as thin wrappers over
  the classes during the window, so reverting the class does not orphan a
  caller.
- **Parallelizable:** No — it defines the convention the rest depends on.

### H.2b — Roll-out

- **Files touched:** none directly. H.2b is a **policy**, not a patch: each
  Part A / B / C / D class, at the moment its own subsystem converts it,
  takes `log: LoggerLike` as a constructor parameter and stops importing the
  singleton. The framework's G5 adopter list (A1, A3, A4, A6, A8, A10, A11,
  A12, B1, B2, B3, B5, C2, C3, D1, E1, E2) is the checklist.
- **Risk level:** **Medium**, and it is *cumulative*: the migration window
  where both destinations are live lasts from H.2a until H.5, and every
  half-migrated file widens it.
- **Test coverage requirement:** per converted class, one assertion proving
  the injected logger receives the call — this is the only detection signal
  for HR3 that does not require reading the diff.
- **Rollback:** per-class, per-commit.
- **Parallelizable:** **Yes**, across subsystems, once H.2a's convention is
  merged. The 88 importing files have no shared state; the only coordination
  point is the convention document.

---

## Phase H.3 — `LazyBin` extraction

- **Goal:** turn the `makeLazyBinResolver` closure (`platform.ts:74-80`) into
  a class with an `invalidate()` hook, keeping the exported factory signature
  byte-compatible so none of the 14 existing invocations change.
- **Files touched (2):**
  - `src/platform.ts` — add `class LazyBin`; reimplement
    `makeLazyBinResolver` over it. `PLATFORM` (`:24`),
    `tryResolveFromPath` (`:48`), `resolveFromPath` (`:61`) and
    `KNOWN_BIN_DIRS` (`:36-43`) are unchanged.
  - `src/__tests__/platform-no-import-time-bin-resolve.test.ts` — extend the
    `TOP_LEVEL_RESOLVE` regex at `:44` so the structural guard also rejects
    module-scope eager resolution through the new class. See
    `06-risks-and-mitigations.md` HR5.
- **Risk level:** **Low.** No consumer changes; the class is a mechanical
  translation of an 7-line closure.
- **Test coverage requirement:**
  1. `src/__tests__/platform-bin-resolve.test.ts` passes unchanged — in
     particular `'does not resolve at construction time (safe during a
     boot-time PATH gap)'` (`:88-92`), which pins the constructor as
     side-effect-free, and `'resolves on first call and memoises the result'`
     (`:94-100`), which pins `mockExecSync` at exactly 1 call.
  2. New: `invalidate()` drops the cache — assert `execSync` is called a
     second time after `invalidate()`. This is the only genuinely new
     behaviour in H.3 and per CLAUDE.md §7 it needs its own test.
  3. New: the extended structural guard is non-vacuous — mirror the existing
     self-test pattern at `platform-no-import-time-bin-resolve.test.ts:69-76`
     ("detects an offending line (proves the matcher is not vacuous)").
  4. `resolve()` still throws (not returns null) on an unresolvable binary —
     pins the correction to `04-generic-interfaces.md:371`.
- **Rollback:** single commit. Nothing outside `platform.ts` depends on the
  class existing.
- **Parallelizable:** **Yes** — fully independent of H.1/H.2/H.4.
  `platform.ts` imports neither `logger.ts` nor any error class, and no error
  class imports `platform.ts`.

---

## Phase H.4 — Error taxonomy introduction

- **Goal:** add an `AppError` base and convert exactly two concrete
  subclasses, establishing a convention. Observable behaviour is unchanged:
  every `instanceof` answer, every `.message`, every `.name` on the two
  converted classes stays identical.
- **Files touched (3):**
  - new `src/errors.ts` — `abstract class AppError extends Error` plus the
    written convention. Verified free: `ls src/errors.ts` → no such file.
  - `src/web/http-helpers.ts` — `RequestBodyTooLargeError` (`:25`) extends
    `AppError`; the hand-set `this.name` at `:29` is dropped.
  - `src/web/federation/http.ts` — `PeerResponseTooLargeError` (`:7`) extends
    `AppError`; hand-set `this.name` at `:10` dropped; **add the missing
    `readonly limit: number`** so it matches its mirror.

  CLAUDE.md §7 requires a `CLAUDE.md` per directory. Note that `src/` has
  none today — the only two in the repo are `.claude/CLAUDE.md` and
  `.github/workflows/CLAUDE.md` (`find . -name CLAUDE.md -not -path
  "./node_modules/*"`). Creating `src/CLAUDE.md` to document the new error
  convention is therefore a new precedent, not an update; decide with the
  user rather than assuming.
- **Explicitly NOT converted in H.4:** the other seven classes, and above all
  `TelegramApiError` (`channel-coordinator/telegram-client.ts:45`) — its
  `kind` field drives backoff control flow at five sites
  (`channel-coordinator.ts:335`, `:338`, `:366`, `:372`, `:378`), the highest
  risk-to-gain ratio in the set.
- **Risk level:** **Low-Medium.** Low for the two converted classes. The
  Medium comes from the convention: once `AppError` sets `name` from
  `new.target.name`, converting `KeychainUnavailableError`
  (`web/keychain.ts:19`, a bare `extends Error {}` with no `this.name`) later
  will change its `.name` from `'Error'` to `'KeychainUnavailableError'`.
  That is a real behaviour change and must be flagged in the convention doc
  so a later converter does not ship it unnoticed.
- **Test coverage requirement:**
  1. Per CLAUDE.md §7 ("kötelező minden bug-t teszttel lefedni"), the newly
     added `PeerResponseTooLargeError.limit` field gets a test asserting the
     value survives the throw at `federation/http.ts:21` and `:34`.
  2. `instanceof` regression pins for all four existing consumers of the two
     converted classes: `web/routes/federation.ts:319`,
     `web/routes/schedules.ts:134`, `web/routes/schedules.ts:185`,
     `web/federation/poller.ts:199`. A test that throws the error and asserts
     the route/poller branch still fires.
  3. `.name` and `.message` equality pins for both converted classes —
     `'RequestBodyTooLargeError'` / `` `Request body exceeded ${n} bytes` ``
     (`http-helpers.ts:26-29`) and `'PeerResponseTooLargeError'` /
     `` `Peer response exceeded ${n} bytes` `` (`federation/http.ts:8-10`).
  4. A `cause` descriptor pin: asserting `super(message, { cause })` yields
     `enumerable: false`, which is the only actual delta from the current
     parameter-property idiom at `federation/poller.ts:69` (verified: both
     forms make `err.cause` readable; only enumerability differs).
- **Rollback:** single commit per class. The base is additive — reverting a
  subclass restores `extends Error` and its `this.name` line.
- **Parallelizable:** **Yes** — independent of H.1/H.2/H.3. No error class
  imports the logger or `platform.ts`; the nine error constructors take only
  domain data.

---

## Phase H.5 — Singleton removal

- **Goal:** delete `export const logger` from `src/logger.ts:3` and replace
  it with a factory the composition root calls once.
- **Files touched:** `src/logger.ts`, plus whatever remains of the 88
  importers (target: zero) and the composition root (`src/index.ts` or the
  `App` class from framework `03 §D3`).
- **Hard gate — do not start until this returns only `logger.ts` itself:**
  ```
  grep -rln "from '.*logger\.js'" src/ --include='*.ts' | grep -v __tests__
  ```
  Baseline today: **88 files**.
- **Second gate:** `grep -rln "vi\.mock('.*logger\.js'" src/ --include='*.ts'`
  must be near zero. Baseline today: **91 files**. Any remaining
  `vi.mock('../logger.js')` after the singleton is deleted is a test mocking
  an export that no longer exists — under Vitest this fails at mock-factory
  time, not at the assertion, so it surfaces as an opaque module error.
- **Risk level:** **High**, and it is the only irreversible step in H. Every
  other phase is additive.
- **Test coverage requirement:**
  1. The full suite green at the H.0 baseline delta.
  2. `src/__tests__/logger.test.ts` rewritten: all four of its tests
     (`:28`, `:36`, `:45`, `:58`) import `../logger.js` and read the module
     binding, and `:15` calls `vi.resetModules()` in `beforeEach`. Against a
     factory export these become direct factory calls, and the
     `vi.resetModules()` can be deleted — resolving the standing conflict
     with `06-risks-and-mitigations.md` R10 mitigation 1, which today tells
     everyone not to do the thing the logger's own test does.
  3. A boot smoke test: exactly one `pino-pretty` transport worker is spawned
     in non-production. `logger.ts:5-8` spawns one per `pino()` call, and the
     whole point of a single factory call at the composition root is that the
     count stays 1.
- **Rollback:** re-export the singleton from `logger.ts` as a compatibility
  shim. Keep that shim available for at least one full release cycle before
  the deletion commit is considered final.
- **Parallelizable:** **No.** It is a single coordinated commit gated on
  everything else.

---

## Dependency graph

```
H.0 (measure)
 └─► H.1 (LoggerLike)  ──► H.2a (proof + test factory) ──► H.2b (roll-out) ──► H.5 (removal)
 │        └──────────────► framework Phase 2 (process-lock classes)
 │        └──────────────► constructor signatures in Parts A, B, C2/C3, D1, E
 ├─► H.3 (LazyBin)      ──► framework §C1 ClaudeCodeBinResolver
 └─► H.4 (AppError)     ──► (advisory: framework out-of-scope list)
```

H.3 and H.4 hang off H.0 only (they need the gate baselines, nothing else)
and can run concurrently with the entire H.1→H.5 chain.

## Risk-level summary

| Phase | Files | Risk | Parallelizable | Reversible |
|---|---:|---|---|---|
| H.0 | 0 | none | n/a | n/a |
| H.1 | 3 + 1 test | Low | No (gates others) | Yes |
| H.2a | 3 | Medium | No (defines convention) | Yes |
| H.2b | per-class | Medium (cumulative) | Yes | Yes, per class |
| H.3 | 2 | Low | Yes | Yes |
| H.4 | 3 | Low-Medium | Yes | Yes, per class |
| H.5 | 1 + remainder | **High** | No | Only via a shim |
