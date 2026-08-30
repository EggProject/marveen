# H (cross-cutting) — Risks and mitigations

Risks specific to the H subsystem. Each entry: where it bites, mitigation,
detection signal. Framework-level risks (`06-risks-and-mitigations.md` R1-R10)
are referenced where H changes their assessment.

---

## HR1. pino `child()` rebinding through constructor injection

### Where it bites

The stated risk is that a class doing
`this.log = parentLog.child({ module: 'channel-monitor' })` loses its
bindings when the logger arrives via constructor injection.

**Measured, this risk does not exist today and cannot be triggered by the
plan as written.**

- Zero production callers: `grep -rn "logger\.child(" src/ --include='*.ts' | grep -v __tests__`
  returns nothing.
- `src/logger.ts:3-9` never pre-creates a child; it passes `level` and
  `transport` only. No `base`, no `redact`, no `mixin`, no `msgPrefix`.
- Only 3 of 91 test mocks even define `child`, and the comment at
  `vault.test.ts:117-119` states the reason explicitly: "Mirror the real
  logger shape (top-level methods + .child()) so any caller that does
  logger.child(...) doesn't blow up" — defence-in-depth against a caller that
  does not exist.
- `04-generic-interfaces.md` §L omits `child` from `LoggerLike` for exactly
  this reason.

So HR1 is a **latent** risk that becomes live only if someone adds `child()`
to `LoggerLike` later. It is recorded so that decision is made deliberately.

### Mitigation

1. **Keep `child` off `LoggerLike`** (`04-generic-interfaces.md` §L). A class
   that needs bindings takes them as a separate constructor field and puts
   them in each call's record object — `this.log.info({ module: this.name,
   ...fields }, msg)` — which requires no new interface surface and no
   rebinding.
2. **If `child` is ever added**, it must return `LoggerLike` (not
   `pino.Logger`), and the child must be created *inside* the constructor
   from the injected parent, never captured from the module singleton. A
   child created from the singleton and passed in would silently bypass any
   test-injected logger.
3. **Pin the absence.** A structural test asserting zero `\.child\(` matches
   in `src/` outside `__tests__` turns the "latent" status into a checked
   invariant, in the same style as
   `src/__tests__/platform-no-import-time-bin-resolve.test.ts`.

### Detection signal

- A converted class logs with no `module` field where its pre-refactor free
  function had one.
- A test asserting `mockLogger.info` sees zero calls while the same code path
  logs to stdout — the child was made from the wrong parent.

---

## HR2. Partial test mocks stop satisfying `LoggerLike`

### Where it bites

91 test files call `vi.mock('.../logger.js', ...)`. The mock objects are
partial by construction. Measured shapes:

| Shape | Files |
|---|---:|
| `{info, warn, error, debug}` | 64 |
| `{info, warn, error, debug, level}` | 7 |
| (no method literals — shared fixture) | 6 |
| `{info, warn, error}` | 4 |
| `{info, warn, error, debug, trace, fatal}` | 3 |
| `{child, info, warn, error, debug}` | 2 |
| `{info, error}` | 1 |
| `{info, warn, debug}` | 1 |

Aggregate member presence across the 91 files: `info` 84, `error` 84,
`warn` 83, `debug` 79, `level` 8, `fatal` 4, `trace` 4, **`child` 3**.

Two distinct failure modes:

1. **If `LoggerLike` aliases `pino.Logger`** — which is what framework
   `04-generic-interfaces.md:243-246` currently proposes — then **all 91**
   mocks fail to type-check when passed to a constructor. The only escape is
   `as unknown as Logger`, i.e. propagating the exact cast at
   `src/__tests__/vault.test.ts:120` that this refactor was supposed to
   delete, 91 times over. This is `review-correctness.md` CE-5's "382
   different mock styles" outcome, realised.
2. **If `LoggerLike` requires `child`** — 88 of 91 mocks fail. Serving 0
   production consumers.

There is also a live, pre-existing hazard the interface will *expose*: the
~12 mocks lacking `debug`. Under the current untyped `vi.mock`, a SUT that
reaches `logger.debug(...)` — and 40+ production lines do, e.g.
`web/channel-monitor.ts:1415`, `web/schedule-runner.ts:1064`,
`web/reauth-healer.ts:372` — throws `TypeError: logger.debug is not a
function` at runtime, silently passing only because that branch is not
covered.

### Mitigation

1. **Define `LoggerLike` as the measured minimum**: `{info, warn, error,
   debug}`, each with pino's two-form call signature
   (`04-generic-interfaces.md` §L). 64 of 91 mocks then conform *by
   construction*, with no edit.
2. **Ship a `createTestLogger()` factory in H.2a** (`05-refactor-roadmap.md`
   Phase H.2a), typed `(): LoggerLike & { info: Mock; warn: Mock; error: Mock;
   debug: Mock }`, so tests get both the interface conformance and the
   assertion handles. This is the concrete answer to
   `review-completeness.md` CE-5 and CE-15, which both name the missing
   factory as the top test-side risk.
3. **Fix the ~12 `debug`-less mocks in the H.1 commit**, before any
   constructor injection lands. They are latent runtime bugs today; the
   interface just makes them visible.
4. **Never accept a partial mock at a boundary.** The rule for reviewers: an
   `as unknown as LoggerLike` in a test file is a rejected diff. If the mock
   does not conform, the interface is wrong or the mock is incomplete.

### Detection signal

- `bun tsc --noEmit` delta from the H.0 baseline is positive and the new
  errors are `Property 'debug' is missing in type '{ info: ...; warn: ...;
  error: ... }'`.
- A diff introducing `as unknown as` in a `__tests__` file.
- Runtime `TypeError: logger.debug is not a function` in a suite that
  previously passed — a `debug`-less mock reached a newly covered branch.

---

## HR3. Dual log destination during the migration window (framework R10 / CE-15)

### Where it bites

From H.2a until H.5 completes, two logger instances are live: the module
singleton at `logger.ts:3`, imported by however many of the 88 files have not
yet migrated, and the per-class injected instances.

The failure is ordering, not typing. `vi.mock` factories are hoisted and run
at module-import time; a class constructed at app boot captures whatever
`logger` resolved to *at its own import time*. A test that does
`vi.mock('../logger.js', () => ({ logger: mockLogger }))` and then asserts on
`mockLogger.info` sees **zero calls** if the SUT class was constructed from a
composition root that already held the real instance. The assertion does not
error — it reports 0, which reads as "the code path did not run" rather than
"the mock missed".

Framework R10 (`06-risks-and-mitigations.md:473-509`) covers the re-import
half of this and prescribes: *"Don't `vi.resetModules()` the logger."*
**That rule is violated today by the logger's own test:**
`src/__tests__/logger.test.ts:15` calls `vi.resetModules()` in `beforeEach`,
and all four of its tests (`:28`, `:36`, `:45`, `:58`) then
`await import('../logger.js')` against a `vi.doMock`'d pino. The test is
correct — it is the only way to exercise the option-assembly at
`logger.ts:4-8` — so R10's rule needs an explicit carve-out rather than being
quietly false.

Compounding factor: `logger.ts:5-8` spawns a `pino-pretty` transport worker
whenever `NODE_ENV !== 'production'`. Each `vi.resetModules()` + re-import
cycle in a non-production test env is a fresh `pino()` call and therefore a
fresh worker thread.

### Mitigation

1. **Restate R10's rule with its carve-out:** no test may `vi.resetModules()`
   the logger *except* `logger.test.ts`, whose entire subject is
   module-evaluation behaviour. Write the exception into the test file's
   header comment so a later reader does not "fix" it.
2. **One injection style per test file.** A file either mocks the module
   (legacy, for unmigrated consumers) or injects via constructor (new). Never
   both — mixing them is what produces the silent zero-call assertion.
3. **Assert non-emptiness, not just content.** Every test that checks logger
   output asserts at least one call happened before asserting on its
   arguments. `expect(mockLogger.info).toHaveBeenCalled()` before
   `expect(mockLogger.info).toHaveBeenCalledWith(...)`. A bare
   `toHaveBeenCalledWith` on a zero-call mock fails loudly; a
   `not.toHaveBeenCalled()` on a mock that was never wired passes
   vacuously — that is the dangerous direction.
4. **Keep the window short.** H.5's gate is mechanical
   (`grep -rln "from '.*logger\.js'" src/ --include='*.ts' | grep -v __tests__`,
   today 88). Track the number down; it is the window's length in files.

### Detection signal

- A logger assertion that flips from passing to reporting 0 calls after a
  class conversion, with no change to the code path under test.
- More than one `pino-pretty` worker thread alive in a test run — visible as
  Vitest's "open handles" warning after the suite completes.
- A test file containing both `vi.mock('../logger.js')` and a constructor
  that takes `LoggerLike`.

---

## HR4. `LoggerLike` vs `pino.Logger` call-signature incompatibility

### Where it bites

Two directions, and only one of them is the obvious one.

**Direction 1 (easy):** is `pino.Logger` assignable to `LoggerLike`? Yes,
structurally — pino's `info`/`warn`/`error`/`debug` are all typed `LogFn`
(`node_modules/pino/pino.d.ts:345-352`, pino 9.14.0), whose three overloads
are a superset of `LoggerLike`'s two. Extra members on `pino.Logger` do not
block assignability. So `const l: LoggerLike = logger` compiles.

**Direction 2 (the one that bites):** does every existing call site still
compile *through* `LoggerLike`? Only if `LogFn` carries both forms.
Measured across `src/` excluding `__tests__`, 744 `logger.<level>(` calls:

| Form | Count |
|---|---:|
| object-first — `logger.info({ ... }, 'msg')` | 626 |
| string-first — `logger.info('msg')` | 76 |
| other (variable-first, multi-line) | ~42 |

The sketch in `h-cross-cutting/02-type-interface-analysis.md` — `type LogFn<L>
= (record: L, msg?: string) => void` — accepts the 626 and **rejects the 76**.
Concrete casualties: `heartbeat.ts:488`
(`logger.debug('Heartbeat: outside active window, skipping')`),
`heartbeat.ts:492`, `heartbeat.ts:516`, `heartbeat.ts:520`,
`heartbeat.ts:280`, `channel-coordinator.ts:355`,
`web/schedule-runner.ts:1064`, `web/inbound-probe.ts:228`,
`web/inbound-probe.ts:246`, `web/channel-monitor.ts:1415`.

A second, subtler incompatibility: the existing `LogFn` at
`process-lock.ts:19` is `(obj: Record<string, unknown>, msg?: string) => void`.
`Record<string, unknown>` rejects arguments typed by an **interface**, because
TypeScript gives interfaces no implicit index signature. Any call site passing
an interface-typed record through that alias needs `object`, not
`Record<string, unknown>` — which is why `04-generic-interfaces.md` §L widens
it.

### Mitigation

1. **Declare `LogFn` with both overloads**, mirroring pino:
   `(msg: string): void` and `(obj: object, msg?: string): void`. Order
   matters — the string overload must come first so a string literal resolves
   to it rather than to `object`.
2. **Pin assignability at compile time in the H.1 commit.** A type-only
   assertion `const _check: LoggerLike = logger` in a test file. If pino ever
   narrows its `LogFn`, this fails at `tsc` rather than in production.
3. **Pin both call forms.** A test that calls a `LoggerLike`-typed value both
   ways: `l.info('msg')` and `l.info({ a: 1 }, 'msg')`. Without it, a
   later "simplification" to a single overload passes CI on the object-first
   majority and breaks the 76.
4. **Do not add a generic record parameter** — `04-generic-interfaces.md` §L
   Variance sets out why.

### Detection signal

- `bun tsc --noEmit` delta positive with errors of the form
  `Argument of type 'string' is not assignable to parameter of type 'object'`
  concentrated in `heartbeat.ts`, `channel-coordinator.ts`, and
  `web/*-runner.ts`.
- A `LoggerLike`-typed parameter that only compiles when the caller wraps its
  message: `log.info({}, 'msg')` appearing in a diff is the smell.

---

## HR5. `LazyBin` cache invalidation and the blinded structural guard

### Where it bites

**Part A — the cache.** The memoised path lives in the closure at
`platform.ts:75-79` and, in production, in a **module-scope** binding:
`const tmuxBin = makeLazyBinResolver('tmux')` at 14 invocation sites across
11 files (`channel-coordinator/liveness.ts:20`,
`web/channel-mcp-reconnect.ts:11`, `web/agent-process.ts:56-57`,
`web/agent-worker.ts:43`, `web/channel-plugin-unlock.ts:40`,
`web/stuck-tool-call-watcher.ts:54`, `web/mcp-list.ts:13`,
`web/reauth-healer.ts:32`, `web/channel-monitor.ts:53-54`,
`web/routes/background-tasks.ts:14-15`, `web/routes/agent-terminal.ts:13`).

A module-scope cache persists for the lifetime of the module instance, which
under Vitest is the lifetime of the test file. `platform-bin-resolve.test.ts`
avoids the problem entirely by constructing a fresh resolver inside each test
(`:89`, `:96`) — but a test targeting one of the 11 *consumer* modules cannot
do that: it gets whatever the module-scope `const` already cached. A
fail-then-succeed `existsSync` mock will see the first outcome stick.

No such test exists today [unverified — the search was for the mechanism, not
an exhaustive audit of every consumer test]. But `invalidate()` is the only
new capability H.3 adds, and this is the only thing it is for.

**Part B — the blinded guard.** `src/__tests__/platform-no-import-time-bin-resolve.test.ts`
is a structural guard written after a real CI incident (its header documents
2026-08-13: module-scope `resolveFromPath` threw at import time and killed 11
unrelated suites). Its matcher at `:44` is:
```ts
const TOP_LEVEL_RESOLVE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*resolveFromPath\(/
```
It matches the literal text `= resolveFromPath(` only. After H.3,
`const CLAUDE = new LazyBin('claude').resolve()` at module scope reproduces
the exact 2026-08-13 failure and the guard **does not fire**. The guard's own
non-vacuity self-test (`:69-76`) will still pass, so nothing signals the
blindness.

### Mitigation

1. **`LazyBin`'s constructor performs no I/O.** Pinned by the existing test
   `'does not resolve at construction time (safe during a boot-time PATH
   gap)'` (`platform-bin-resolve.test.ts:88-92`), which must be extended to
   cover the class form.
2. **Extend `TOP_LEVEL_RESOLVE` in the same commit as `LazyBin`** to also
   reject module-scope `= new LazyBin(...).resolve()` and
   `= <ident>.resolve()`. Add the corresponding non-vacuity assertions
   alongside the existing ones at `:69-76`. Extending the guard is not
   optional cleanup — it is the only thing standing between this refactor and
   a rerun of the incident.
3. **`invalidate()` gets its own test** (CLAUDE.md §7: every fix needs a
   test): resolve, `invalidate()`, resolve again, assert `execSync` was
   called twice. The existing memoisation test
   (`platform-bin-resolve.test.ts:94-100`) asserts exactly 1 call and is the
   negative half of the same pair.
4. **Do not migrate the 11 consumer files in H.3.** They keep calling
   `makeLazyBinResolver`. Migrating them is what would make Part A reachable;
   defer it until a consumer actually needs `invalidate()`.

### Detection signal

- A consumer test that passes in isolation and fails when run after another
  test in the same file — classic module-scope cache bleed.
- A diff adding a module-scope `.resolve()` call that the extended guard does
  not reject: means the regex extension missed a form.
- `mockExecSync` call count differing between a solo run and a full-file run.

---

## HR6. Error taxonomy breaks discrimination

### Where it bites

The stated risk — "existing `catch(err)` blocks that check `err.code === '...'`
will break if errors become typed subclasses" — **does not apply to this
codebase's own errors.**
`grep -rn "code === '" src/ --include='*.ts' | grep -v __tests__` returns 10
hits and every one is a Node `ErrnoException`:
`'EEXIST'` (`index.ts:229`), `'ENOENT'` (`index.ts:250`,
`web/claude-credentials-guard.ts:154`), `'EADDRINUSE'` (`web.ts:226`),
`'EPERM'` (`web/routes/updates.ts:149`). Zero project error classes carry a
`code` field. So an `AppError` base cannot break a `code` check — there are
none to break.

**The real risk is `instanceof`**, which is the codebase's actual
discriminator at 15 production sites:
`channel-coordinator.ts:335`, `:338`, `:366`, `:372`, `:378` (all
`err instanceof TelegramApiError && err.kind === ...`);
`index.ts:555` (`DeferToPeerError`, reads `err.peerPid` at `:556`);
`web/vault.ts:49` (`KeychainUnavailableError`);
`web/federation/poller.ts:199` (`PeerResponseTooLargeError`);
`web/routes/federation.ts:319`, `web/routes/schedules.ts:134`, `:185`
(`RequestBodyTooLargeError`); `web/routes/security.ts:95`
(`RemoteEnrollError`); `web/routes/fleet.ts:29` (`UserFacingError`);
`web/routes/auth.ts:271`, `:327` (`PasswordPolicyError`).

Three concrete ways H.4 could break these:

1. **Test-side shadow classes.** `src/__tests__/vault.test.ts:132` declares a
   **local** `class KeychainUnavailableError extends Error {}` inside a
   `vi.mock('../web/keychain.js', ...)` factory and returns it as the module's
   export. `web/vault.ts:49` (`if (!(err instanceof KeychainUnavailableError))
   throw err`) passes only because the mock replaces the whole module, so both
   sides see the same shadow. If H.4 makes the production class
   `extends AppError` and the shadow is not updated in lockstep, the shadow
   still satisfies `instanceof` (both resolve to the mocked module) — but any
   test asserting on `AppError`-derived behaviour against the shadow silently
   gets the old semantics. Search for shadows before converting any class:
   `grep -rn "class .*Error extends Error" src/**/__tests__/`.
2. **`.name` change on `KeychainUnavailableError`.** It is the one class with
   no `this.name` assignment (`web/keychain.ts:19`, bare `extends Error {}`),
   so it reports `name === 'Error'` today. An `AppError` base that sets
   `this.name = new.target.name` changes it to
   `'KeychainUnavailableError'`. Any assertion or log filter on that string
   breaks. This is why H.4 converts `RequestBodyTooLargeError` and
   `PeerResponseTooLargeError` first — both already hand-set `name`
   (`http-helpers.ts:29`, `federation/http.ts:10`) to the value
   `new.target.name` produces, so the change is provably a no-op there.
3. **Collapsing nominal types.** `01-module-state-analysis.md` §5 proposes
   replacing eight classes with one `TypedError<TPayload>`. That would delete
   the discriminator all 15 sites use. `04-generic-interfaces.md` §X records
   the rejection.

A fourth, non-breaking correction: `02-type-interface-analysis.md` claims
`FederationPollInternalError` (`web/federation/poller.ts:68`) loses the
`err.cause` chain because it assigns `cause` as a parameter property
(`poller.ts:69`) instead of via `super(message, { cause })`. **Refuted** —
verified empirically: both forms make `err.cause` return the passed value.
The only difference is the property descriptor (`enumerable: true` for the
parameter-property form, `false` for the ES2022 options form). Standardising
on the options form is still right, but it must be justified by enumerability
(pino serialisers and `JSON.stringify` will walk an enumerable `cause`), not
by a repair that is not needed.

### Mitigation

1. **`AppError` is additive.** Inserted above the concrete classes, never in
   place of them. Every `instanceof <ConcreteError>` keeps its exact answer.
2. **No `code` field on `AppError`** (`03-class-boundaries.md` §C3). It would
   introduce a second discrimination axis with zero consumers, in a namespace
   already occupied by errno.
3. **Convert in mirror pairs, starting with the two whose `name` is already
   `new.target.name`.** `RequestBodyTooLargeError` + `PeerResponseTooLargeError`
   (`05-refactor-roadmap.md` Phase H.4).
4. **`TelegramApiError` last, and never split by `kind`.** Its `kind` field
   drives backoff at five call sites; a subclass-per-kind tree is
   `review-completeness.md` OE-1/OE-2's rejected pattern.
5. **Regression pin per converted class:** throw it, catch it at the real
   consumer, assert the branch fires. Four pins for the first two classes
   (`federation.ts:319`, `schedules.ts:134`, `schedules.ts:185`,
   `poller.ts:199`).
6. **Grep for test shadows before touching any class** (see #1 above).

### Detection signal

- An HTTP route that starts returning 500 where it returned 400/413 — the
  `instanceof` arm stopped matching and the error fell to the generic
  handler. Applies to `routes/federation.ts:319`, `routes/schedules.ts:134`,
  `:185`, `routes/fleet.ts:29`, `routes/auth.ts:271`, `:327`.
- `channel-coordinator.ts` stops applying `rate_limit` backoff — the
  `err instanceof TelegramApiError` guard at `:378` failed and the error took
  the generic path.
- A test asserting `err.name === 'Error'` starts failing: the
  `KeychainUnavailableError` name change landed.
- `JSON.stringify(err)` output gains or loses a `cause` key — the descriptor
  enumerability flipped.

---

## Summary table

| ID | Risk | Live today? | Severity | Mitigation summary |
|---|---|---|---|---|
| HR1 | pino `child()` rebinding | **No** — 0 prod callers | Low (latent) | Keep `child` off `LoggerLike`; pin the absence structurally |
| HR2 | Partial mocks vs `LoggerLike` | **Yes** — 91 mock files, ~12 lack `debug` | **High** | Minimum-surface interface (64/91 conform unchanged) + `createTestLogger()` factory in H.2a |
| HR3 | Dual log destination in the migration window | **Yes** — 88 importers, `logger.test.ts:15` already resets modules | **High** | R10 carve-out for `logger.test.ts`; one injection style per file; assert non-emptiness; shrink the window |
| HR4 | `LoggerLike` call-signature mismatch | **Yes** — 76 string-first call sites | **High** | Two-overload `LogFn`; compile-time assignability + both-forms pins |
| HR5 | `LazyBin` cache + blinded structural guard | Guard blindness: **yes, on H.3 landing** | Medium | No-I/O constructor; extend `TOP_LEVEL_RESOLVE` at `:44` in the same commit; `invalidate()` test |
| HR6 | Error taxonomy breaks discrimination | `code` form: **no**. `instanceof` form: **yes** — 15 sites | Medium | Additive `AppError`; no `code` field; mirror-pair conversion; shadow-class grep; per-class regression pins |
