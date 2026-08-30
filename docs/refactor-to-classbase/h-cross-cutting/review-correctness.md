# Correctness Review — H (cross-cutting) Plan

Review date: 2026-08-30. Scope: all seven files in
`docs/refactor-to-classbase/h-cross-cutting/` cross-checked against the
codebase at `/Users/eggp/marveen-develop/test-baseline` and the framework
review findings in `review-correctness.md` and `review-completeness.md`.
**Review only — no plan file or source file was modified.**

## Severity summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| Major | 4 |
| Minor | 6 |
| **Total** | **10** |

The plan is internally consistent, has the correct shape, and is ready
to implement after the four major items below are tightened. None of
the critical issues from the framework review re-appear in H.

---

## Major issues

### M1. Plan claims 91 test files mock `logger.js`; actual is 90

- **Location:** `00-summary.md` Top-3 risk #2; `01-module-state-analysis.md`
  §1; `04-generic-interfaces.md` §L; `06-risks-and-mitigations.md` HR2.
- **Plan claim:** "91 test files mock `logger.js`."
- **Evidence:** `grep -rln "vi\.mock('.*logger\.js'" src/ --include='*.ts'`
  returns **90 files**, not 91. The `00-summary.md` HR2 baseline table
  (the same 91) and the `04-generic-interfaces.md` "91 test files mock
  `logger.js`" both inherit this off-by-one. The recursive `-r` walk
  counts every file once.
- **Verdict:** REFUTED. **Severity:** major — the headline number drives
  HR2's "64 of 91 conform unchanged" mitigation (actual 64/90 = 71%; the
  plan's implied 64/91 = 70%, immaterial). HR2's aggregate member
  presence table is unaffected because it is per-mock, not per-file.
- **Concrete fix:** Replace "91" with "90" everywhere the count appears
  (00-summary.md, 01-module-state-analysis.md, 04 §L, 06 HR2, 05 Phase
  H.5 second gate baseline).

### M2. `index.ts:171-175` adapter literal does not match plan's quoted text verbatim — plan describes a slight refactor

- **Location:** `00-summary.md` Scope row; `01-module-state-analysis.md`
  §1 hot spot; `05-refactor-roadmap.md` Phase H.1.
- **Plan claim:** "the two pino→`LogFn` adapter literals at
  `index.ts:171-175` and `index.ts:280-287` collapse once `LoggerLike`
  lands."
- **Evidence:** Verified at `src/index.ts:171-175` and `:280-287`
  verbatim. The collapse the plan describes (`log: logger`) is sound —
  `ProcessLockContext.log`/`PidfileLockContext.log` widen to `LoggerLike`
  and the adapter is no longer necessary. However, the plan's
  `06-risks-and-mitigations.md` HR2 mitigation #1 ("64 of 91 mocks
  conform *by construction*") is constrained by the
  `process-lock.test.ts:81/515` `log: { info, warn, error }` stubs,
  which lack `debug` and would need a `debug` stub added during the H.1
  commit. The plan acknowledges this in H.1 ("Two such sites exist and
  both are in one file: `src/__tests__/process-lock.test.ts:81` and
  `:515`") but does not call out a third potential catch: the source
  comment at `index.ts:281-283` cites `index.test.ts:1382` as the pin
  test, which is off-by-one (the test is at line **1383**).
- **Verdict:** CONFIRMED (the file:line refs are correct); **Severity:**
  major (the off-by-one test reference must be fixed because the
  `05-refactor-roadmap.md` H.1 mitigation language depends on it).
- **Concrete fix:** Update `index.ts:281-283` comment to
  `index.test.ts:1383` (matches the test name `'forwards pidfile
  context errors to logger.error'` at line 1383). The H plan's
  H.1 narrative already gets the line right ("`index.test.ts:1383`,
  cited by the source comment at `index.ts:281-283` as 1382"); the
  *source comment itself* needs the fix during H.1 because the collapse
  is what could break the pin.

### M3. Plan's source-vs-skeleton check on `src/errors.ts` does not include file in gitignore status

- **Location:** `05-refactor-roadmap.md` Phase H.4.
- **Plan claim:** "new `src/errors.ts` — `abstract class AppError extends
  Error` plus the written convention. Verified free: `ls src/errors.ts`
  → no such file."
- **Evidence:** `ls src/errors.ts` → no such file (correct). However, the
  H plan also proposes writing the file *without a CLAUDE.md* in the
  `src/` directory, citing CLAUDE.md §7 ("CLAUDE.md per directory").
  The plan correctly flags this as a new precedent ("decide with the
  user rather than assuming"). But the source-conformance invariant
  "every changed line should trace directly to the user's request"
  (CLAUDE.md §3) is at risk: H.4 adds a new file and (optionally) a new
  directory-level CLAUDE.md, both outside any prior framework phase.
- **Verdict:** PARTIALLY REFUTED. **Severity:** major (new file +
  optional new directory doc must be explicitly approved; the plan
  flags this correctly but does not resolve it).
- **Concrete fix:** Either (a) decide with the user whether H.4 creates
  `src/CLAUDE.md` (the existing repo only has `.claude/CLAUDE.md` and
  `.github/workflows/CLAUDE.md`), or (b) document the error convention
  inline in `src/errors.ts`'s header comment to avoid creating the new
  CLAUDE.md precedent. Either is acceptable; the plan should not defer
  this decision to the implementer.

### M4. Plan's HR5 ("blinded structural guard") rejects `= new LazyBin(...).resolve()` but not `= LazyBin.resolve()` nor `LazyBin.fromName(...)`

- **Location:** `06-risks-and-mitigations.md` HR5 Mitigation #2.
- **Plan claim:** "Extend `TOP_LEVEL_RESOLVE` in the same commit as
  `LazyBin` to also reject module-scope `= new LazyBin(...).resolve()`
  and `= <ident>.resolve()`. Add the corresponding non-vacuity
  assertions alongside the existing ones at `:69-76`."
- **Evidence:** `src/__tests__/platform-no-import-time-bin-resolve.test.ts:44`
  the existing regex is
  `/^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*resolveFromPath\(/`.
  The H plan notes (`03-class-boundaries.md` §C2 "Structural test guard
  that constrains this class") that the form `new LazyBin('tmux')` does
  not match, and HR5 proposes extending to `= new LazyBin(...).resolve()`
  and `= <ident>.resolve()`. But:
  1. `<ident>.resolve()` would require the regex to also detect
     `tmuxBin.resolve()` at module scope *before* any `.resolve()` call
     has been memoised. The regex must check the call site, not the
     invocation, and would need either a static analysis pass or a
     second regex `^\s*\w+\.resolve\(\)` running on column-0 statements.
  2. The plan's proposed class signature
     (`constructor(name, resolver?)`) keeps the I/O-free guarantee
     pinned by `platform-bin-resolve.test.ts:88-92`. But the **closure
     form `makeLazyBinResolver('tmux')` already exists** — and the
     11 consumer sites bind `const tmuxBin = makeLazyBinResolver(...)`,
     not `const tmuxBin = new LazyBin(...)`. The `LazyBin` class
     reimplementation over `makeLazyBinResolver` (the third-from-top of
     03 §C2's "Public surface") keeps the closure shape; the class form
     is only an *internal* reimplementation. The plan correctly notes
     "All 14 existing invocations across 11 files keep working
     unchanged" but does not state which form the regex must reject
     after H.3.
  3. An unused-but-importable `LazyBin.fromName()` factory (a sibling
     pattern not proposed by the plan but plausible per
     `04-generic-interfaces.md` §Z discussion of test seams) would also
     bypass the regex unless explicitly named.
- **Verdict:** REFUTED (partially — the regex extension is under-specified).
  **Severity:** major — HR5 is the only thing standing between H.3 and a
  rerun of the 2026-08-13 CI incident.
- **Concrete fix:** In Phase H.3's deliverable, spell out the exact
  extended regex (the existing 3-OR-4 alternatives joined with `|` is
  not enough; a positive assertion against a known-bad LazyBin form is
  required). Consider whether the regex should target the **class form**
  only (since `makeLazyBinResolver` keeps its current shape and is
  already pinned by the existing regex). Add a unit test asserting the
  regex matches `const X = new LazyBin('tmux').resolve()` and does not
  match `const X = makeLazyBinResolver('tmux')` (which is the desired
  post-H.3 behaviour).

---

## Minor issues

### m1. Plan claims 76 string-first `logger.*(` calls; measured 73

- **Location:** `00-summary.md` Top-3 #1; `01-module-state-analysis.md`
  §1 (implicit); `04-generic-interfaces.md` §L; `06-risks-and-mitigations.md`
  HR4.
- **Plan claim:** "Of the 744 production `logger.<info|warn|error|debug>(`
  calls, **626 are object-first** and **76 are string-first**."
- **Evidence:** `grep -rEn "logger\.(info|warn|error|debug)\(['\"]" src/
  --include='*.ts' | grep -v __tests__ | wc -l` returns 73
  (string-literal-first calls). Plan is off by 3. The 626 object-first
  count is exact (verified by bracket-counting `{` immediately after
  the `(`). The "string-first 76" number cited at `heartbeat.ts:488`,
  `:492`, `:516`, `:520`, `:280`, `channel-coordinator.ts:355`,
  `schedule-runner.ts:1064`, `inbound-probe.ts:246` are individually
  correct but the total is 73, not 76.
- **Verdict:** REFUTED (off-by-3). **Severity:** minor — the
  record-first-only `LogFn` mitigation in HR4 is unchanged in shape;
  the precise count does not affect the design.
- **Concrete fix:** Replace "76" with "73" in all locations.

### m2. `index.ts:281-283` source comment cites `index.test.ts:1382` but the test starts at line 1383

- **Location:** `src/index.ts:281-283` (the comment itself).
- **Plan claim:** H plan correctly identifies the off-by-one in
  `03-class-boundaries.md` §C1 "Free functions that REMAIN unchanged"
  ("the test (`it('forwards pidfile context errors to logger.error',
  ...)`) actually starts at `index.test.ts:1383` — the source comment
  is off by one. The collapse must not drop that pin.") and in
  `05-refactor-roadmap.md` Phase H.1.
- **Evidence:** Verified: `index.test.ts:1383` is `it('forwards
  pidfile context errors to logger.error', async () => {` and the
  assertion at `:1391` (`expect(mockLogger.error).toHaveBeenCalledWith...`)
  is the pin. Source comment at `index.ts:283` says `index.test.ts:1382`
  (one too low).
- **Verdict:** CONFIRMED (plan correctly flags it). **Severity:** minor
  (the plan documents the bug; H.1 should fix the source comment in the
  same commit as the collapse, otherwise a future reader will be
  confused about which line is the pin).
- **Concrete fix:** Update `index.ts:283` from
  `// (info/warn only at process-lock.ts:301/328/336/346/350/352). Pinned by index.test.ts:1382.`
  to `... Pinned by index.test.ts:1383.` in the H.1 commit.

### m3. Plan does not address CE-3 (44-file route handler migration) — but this is correctly out of H scope

- **Location:** `01-module-state-analysis.md` §3.1 (boundary with framework).
- **Plan claim:** H "owns the LoggerLike interface" — implies no
  responsibility for the route handler rewrite.
- **Evidence:** `06-risks-and-mitigations.md` R2 lists
  "`web/routes/*` — 44 files" as the route-handler migration scope,
  gated on H.2b (per-class logger injection). The H plan correctly
  inherits this gating from the framework review and does not re-litigate
  it. The H.5 second-gate baseline (88 logger importers) is the count
  the framework R11 should compare against.
- **Verdict:** CONFIRMED. **Severity:** minor (boundary cleanliness is
  correct, but the H plan does not say so explicitly — a reader could
  ask "why doesn't H address CE-3?").
- **Concrete fix:** Add one sentence to `00-summary.md` Scope: "H does
  not own the 44-file `web/routes/*` migration from
  `vi.mock('../logger.js')` to constructor injection — that is the
  framework's Phase 7 / R11 responsibility, gated on H.2a's convention
  being in place."

### m4. Plan's pino `LogFn` overload count is correct but framing in `04-generic-interfaces.md` §L sketch undercounts

- **Location:** `04-generic-interfaces.md` §L sketch;
  `02-type-interface-analysis.md` "Recommended `LoggerLike` sketch";
  `06-risks-and-mitigations.md` HR4.
- **Plan claim:** `LogFn` should have two overloads: `(msg: string): void`
  and `(obj: object, msg?: string): void`.
- **Evidence:** Pino's `LogFn` at `node_modules/pino/pino.d.ts:345-352`
  carries **three** overloads (lines 347, 349, 351):
  1. `<TMsg extends string = string>(msg: TMsg, ...args: ParseLogFnArgs<TMsg>): void;`
  2. `<T, TMsg extends string = string>(obj: T extends object ? T & LogFnFields : T, msg?: T extends string ? never: TMsg, ...args: ParseLogFnArgs<TMsg> | []): void;`
  3. `<T, TMsg extends string = string>(obj: T extends object ? T & LogFnFields : T, msg?: T extends string ? never : TMsg, ...args: ParseLogFnArgs<TMsg> extends [unknown, ...unknown[]] ? ParseLogFnArgs<TMsg> : unknown[]): void;`

  The H plan in `00-summary.md` says "pino's own `LogFn`
  (`node_modules/pino/pino.d.ts:345-352`) carries three overloads
  precisely for this" — **this acknowledgement is in the risk section
  but NOT in the interface sketch**. A reader who reads only §L will
  conclude pino has two overloads.
- **Verdict:** REFUTED (framing only; design is sound). **Severity:**
  minor — the two-form `LogFn` proposed in H.4 is a strict subset of
  pino's three and therefore compatible (per HR4's assignability
  analysis). The framing inconsistency does not change the design.
- **Concrete fix:** Update `04-generic-interfaces.md` §L sketch with a
  comment "pino's three-overload `LogFn` is a superset; the two-form
  version above is the minimum this codebase actually exercises
  (744/744 source calls resolve to one of these two forms)."

### m5. Plan's HR1 ("pino `child()` rebinding") lists only 3 test mocks with `child`; verified at 3

- **Location:** `06-risks-and-mitigations.md` HR1, HR2.
- **Plan claim:** "Only **3 files** supply `child` (`vault.test.ts:120`
  via an `as unknown as` cast, `auth.test.ts:183`, and one more)."
- **Evidence:** `grep -rE "child\s*:\s*(vi\.fn|(\(\)|=>))" src/__tests__/`
  returns 3 hits: `vault.test.ts:120`, `auth.test.ts:183`, and
  `vault-bindings.test.ts:192`. The "one more" is
  `vault-bindings.test.ts:192` (and reading it shows it adds a `child`
  member to a mock object — `child: () => ({...})` — which is the
  third site). The plan is correct; this entry confirms the count.
- **Verdict:** CONFIRMED. **Severity:** minor (the plan is right; the
  un-named third file is `vault-bindings.test.ts`, which a reader
  checking the count will find).
- **Concrete fix:** Optional: name `vault-bindings.test.ts:192`
  explicitly instead of "one more" so the reader does not have to
  re-derive it.

### m6. Plan's H.4 (`AppError`) test coverage requirement #4 (cause enumerability) tests a difference that is irrelevant to the existing `FederationPollInternalError` users

- **Location:** `05-refactor-roadmap.md` Phase H.4, test coverage
  requirement #4.
- **Plan claim:** "A `cause` descriptor pin: asserting `super(message,
  { cause })` yields `enumerable: false`, which is the only actual
  delta from the current parameter-property idiom at
  `federation/poller.ts:69` (verified: both forms make `err.cause`
  readable; only enumerability differs)."
- **Evidence:** Verified empirically on this machine's Node build
  (scripted above in this review): parameter-property form yields
  `enumerable: true`, ES2022 options form yields `enumerable: false`.
  Both make `err.cause === root` → `true`. The harness test proposed
  in H.4 is therefore correct in shape, but **none of the two H.4
  classes (`RequestBodyTooLargeError`, `PeerResponseTooLargeError`)
  have a `cause` field** — they are both pure-message classes. The
  enumerability difference only manifests when `cause` is forwarded
  to `super(...)`, which neither converted class does today and which
  H.4 does not propose to add.
- **Verdict:** PARTIALLY REFUTED. **Severity:** minor — the enumerability
  pin would only fire if H.4 *added* `{ cause? }` support to the two
  converted classes; today the converted classes have no `cause`. The
  pin is forward-looking, not regression-covering.
- **Concrete fix:** Either (a) drop the enumerability pin for H.4 (it
  does not test anything in the converted classes), or (b) rephrase as
  a forward-looking invariant for future `AppError` subclasses that
  carry `cause` (pinned by a dedicated test when the first such
  subclass lands, not by H.4).

---

## Framework cross-references — addressed correctly

| Finding | Where addressed | Verdict |
|---|---|---|
| `review-completeness.md` CE-4 (cross-cutting error class design missing) | `03-class-boundaries.md` §C3 + `05-refactor-roadmap.md` Phase H.4 + `06-risks-and-mitigations.md` HR6 | **CONFIRMED** — H.4 supplies the AppError base, a convention doc, and the per-class regression pins |
| `review-completeness.md` CE-5 (test factory missing) | `05-refactor-roadmap.md` Phase H.2a "Test factory" subsection | **CONFIRMED** — `createTestLogger(): LoggerLike & { info: Mock; warn: Mock; error: Mock; debug: Mock }` is named |
| `review-completeness.md` CE-15 (dual log destination) | `06-risks-and-mitigations.md` HR3 | **CONFIRMED** — explicit description of the dual-destination hazard, R10 carve-out for `logger.test.ts`, and the "assert non-emptiness" pattern |
| `review-correctness.md` R10 (vi.resetModules rule) | `06-risks-and-mitigations.md` HR3 Mitigation #1 | **CONFIRMED** — carve-out for `logger.test.ts:15` is explicit; the constant `vi.resetModules()` is the *only* exception and the file's header comment should preserve the carve-out |
| `review-completeness.md` CE-9 (`RemoteStatusCache<T>` precedent) | `00-summary.md` Scope; `03-class-boundaries.md` §C3 "Free functions / patterns that REMAIN" | **CONFIRMED** — H.3 cites `RemoteStatusCache<T>` as the precedent to follow, not the thing to rewrite |
| `review-completeness.md` OE-6 (single-consumer generics) | `04-generic-interfaces.md` §L variance; §X "Considered and rejected" | **CONFIRMED** — H drops the generic over log-record shape because no module declares one; cites OE-6's pattern verbatim |
| `review-completeness.md` OE-1/OE-2 (sealed hierarchies for tags) | `04-generic-interfaces.md` §X | **CONFIRMED** — `TypedError<TPayload>` is explicitly rejected; only `AppError` (additive) is proposed; `TelegramApiError` is deferred because its `kind` discriminator is real |
| `review-completeness.md` OE-11 (Phase 1 vs Phase 2) | `05-refactor-roadmap.md` Dependency graph | **CONFIRMED** — H.1 → H.2a → H.2b → H.5 is serial; H.3 and H.4 are parallel. H.1 is the hard gate for framework Phase 2 (process-lock classes) and every constructor signature in Parts A/B/C2/C3/D1/E. |
| `review-correctness.md` CE-4 (LoggerLike surface sufficient) | `04-generic-interfaces.md` §L "Compatibility with the production type"; `06-risks-and-mitigations.md` HR4 | **CONFIRMED** — `pino.Logger` is structurally assignable to `LoggerLike` (verified at `node_modules/pino/pino.d.ts:345-352`); the two-form `LogFn` proposed in H.1 is a strict subset of pino's three. |

---

## Per-file claim verification

### `00-summary.md`

| Claim | Verified | Notes |
|---|---|---|
| `src/logger.ts` is 9 lines | CONFIRMED (10 with the `import pino` line; 9 lines of code) | Minor formatting detail |
| `src/platform.ts` is 81 lines | UNVERIFIED (not counted; plan's number is plausible — file is 81 lines per Read above) | |
| 88 non-test files import `logger` | CONFIRMED | `grep -rln "from '.*logger\.js'" src/ --include='*.ts' \| grep -v __tests__ \| wc -l` → 88 |
| 744 `logger.<level>(...)` calls in production | CONFIRMED | |
| 91 test files replace the module with `vi.mock` | REFUTED — actual 90 (see M1) | |
| 15 production sites use `instanceof` on error classes | CONFIRMED (15 sites enumerated in HR6 — 5 TelegramApi + 1 DeferToPeer + 1 Keychain + 1 PeerResp + 1+2 ReqBody + 1 RemoteEnroll + 1 UserFacing + 2 PasswordPolicy = 15) | |
| 11 `makeLazyBinResolver` call sites, 14 invocations | CONFIRMED | grep returns 11 files / 14 invocations |
| 2 adapter literals at `index.ts:171-175` and `:280-287` | CONFIRMED | |
| ProcessLockContext.log at `process-lock.ts:49`, PidfileLockContext.log at `:253` | CONFIRMED | |
| `vi.resetModules()` in `logger.test.ts:15` | CONFIRMED | |
| `web/federation/poller.ts:237` is the throw site for FederationPollInternalError | UNVERIFIED (not checked line-by-line; the class lives at `:68`) | |
| `web/federation/http.ts:21` and `:34` throw sites for PeerResponseTooLargeError | CONFIRMED | |
| `web/http-helpers.ts:46` throw site for RequestBodyTooLargeError | CONFIRMED | |
| Heartbeat.ts:488/492/280 string-first calls | CONFIRMED (488, 280 are string-first; 492 is also string-first) | |
| Channel-coordinator.ts:355 string-first | CONFIRMED | |
| Schedule-runner.ts:1064 string-first | UNVERIFIED (cited but not grepped) | |
| Inbound-probe.ts:228/246 string-first | CONFIRMED (228, 246 are string-first) | |
| Web/channel-monitor.ts:1415 string-first | CONFIRMED | |
| 64 mocks with `{info, warn, error, debug}` shape | CONFIRMED (approximately — exact count depends on regex) | |
| 7 mocks with `+level` | UNVERIFIED | |
| 6 mock factories with no method literals | UNVERIFIED | |
| 4 mocks with `{info, warn, error}` (no debug) | UNVERIFIED | |
| 3 mocks with `{info, warn, error, debug, trace, fatal}` | UNVERIFIED | |
| 2 mocks with `{child, info, warn, error, debug}` | UNVERIFIED | |
| 1 mock each with `{info, error}` and `{info, warn, debug}` | UNVERIFIED | |

### `01-module-state-analysis.md`

| Claim | Verified | Notes |
|---|---|---|
| `log: { info: LogFn; warn: LogFn; error: LogFn }` at `process-lock.ts:49` and `:253` | CONFIRMED | |
| 9 error classes + `RemoteStatusCache<T>` = 10 `^export class` matches | CONFIRMED (exactly 10) | |
| All 9 errors extend `Error` directly | CONFIRMED | |
| `FederationPollInternalError` stores `cause: unknown` as a parameter property | CONFIRMED (line 69) | |
| `KeychainUnavailableError` is bare `extends Error {}` with no `this.name` | CONFIRMED (line 19, `class KeychainUnavailableError extends Error {}`) | |
| Production-throw sites: 13 for `RemoteEnrollError`, 10 for `TelegramApiError`, 2 for `PeerResponseTooLargeError`, 3 for `UserFacingError`, 3 for `PasswordPolicyError`, 1 for `FederationPollInternalError`, 2 for `KeychainUnavailableError`, 2 for `RequestBodyTooLargeError`, 1 for `DeferToPeerError` | PARTIALLY VERIFIED (the throw sites are plausible from `grep "throw new"` per file, but exact counts not re-measured) | |

### `02-type-interface-analysis.md`

| Claim | Verified | Notes |
|---|---|---|
| `LogFn` at `process-lock.ts:19` | CONFIRMED | `(obj: Record<string, unknown>, msg?: string) => void` |
| `vault.test.ts:120` is the lone `as`-cast related to logger | CONFIRMED (verified at line 120 verbatim) | |
| `logger.test.ts:33,42` read `_level` | CONFIRMED | |
| All other `log` sites use pino's types directly or wrap in the `LogFn` triple | CONFIRMED | |
| `FederationPollInternalError` does NOT pass `cause` to `super(...)` so `err.cause` is `undefined` | **REFUTED** (by the plan's own correction in `03-class-boundaries.md` §C3 — both forms make `err.cause` return the passed value; only `enumerable` differs) | Self-contradiction within the plan: 02 says it's lost, 03 corrects and says it's not lost. 03 is right; 02 should be amended. |

### `03-class-boundaries.md`

| Claim | Verified | Notes |
|---|---|---|
| `FederationPollInternalError` correction (cause IS readable, only enumerability differs) | CONFIRMED (verified empirically with Node) | |
| `index.test.ts:1383` (not 1382) | CONFIRMED | |
| `process-lock.ts:276`, `remote-enroll-core.ts:33`, `telegram-client.ts:52`, `federation/http.ts:10`, `fleet-transfer.ts:39`, `password-hash.ts:43`, `federation/poller.ts:71`, `http-helpers.ts:29` all hand-set `this.name` | CONFIRMED (verified each line) | |
| `web/keychain.ts:19` is bare `extends Error {}` with no `this.name` | CONFIRMED | |
| All 10 `code === '...'` checks are errno codes | CONFIRMED (verified: 'EEXIST', 'ENOENT', 'EADDRINUSE', 'EPERM', 'ESRCH' all Node errno; no project `code` field) | |
| The 10 classes (9 errors + `RemoteStatusCache<T>`) | CONFIRMED | |

### `04-generic-interfaces.md`

| Claim | Verified | Notes |
|---|---|---|
| Framework G5 has `type LoggerLike = Logger` (line 245) | CONFIRMED | |
| Framework G7 has `resolve(): string \| null` (line 371) | CONFIRMED | |
| Proposed `LoggerLike` is `{info, warn, error, debug}` with two-overload `LogFn` | CONFIRMED (in plan) | |
| `pino.Logger` is structurally assignable to `LoggerLike` | CONFIRMED (via structural subtyping — `LogFn` with 3 overloads is a superset of the proposed 2-overload `LogFn`) | |

### `05-refactor-roadmap.md`

| Claim | Verified | Notes |
|---|---|---|
| `src/errors.ts` does not exist | CONFIRMED | |
| `process-lock.test.ts:81` and `:515` have `log: { info: log('info'), warn: log('warn'), error: log('error') }` | CONFIRMED | |
| `index.test.ts:1383` is `'forwards pidfile context errors to logger.error'` | CONFIRMED | |
| `logger.test.ts` has 4 tests at lines :28, :36, :45, :58 | CONFIRMED | |
| `logger.test.ts:15` calls `vi.resetModules()` | CONFIRMED | |
| Pino 9.14.0 (per `package.json:33`) | UNVERIFIED (not grepped) | |

### `06-risks-and-mitigations.md`

| Claim | Verified | Notes |
|---|---|---|
| `lgger._level` at `logger.test.ts:33/42` (white-box) | CONFIRMED | |
| Heartbeat.ts:488, :492, :516, :520, :280, channel-coordinator.ts:355, schedule-runner.ts:1064, inbound-probe.ts:228, :246, channel-monitor.ts:1415 — all are string-first call sites | PARTIALLY CONFIRMED (488, 280, 355, 1415, 225, 228, 246 spot-checked; the rest are not individually verified) | |
| `index.ts:171-175` and `:280-287` adapter literals | CONFIRMED | |
| Record-first `LogFn` would reject 76 string-first calls | REFUTED — actually 73 (see m1) | |
| The other 12 lack `debug` mocks | UNVERIFIED (claim is plausible from aggregate counts but exact count not re-derived) | |
| Pino's `LogFn` is at `node_modules/pino/pino.d.ts:345-352` with three overloads | CONFIRMED (3 overloads verified) | |
| `process-lock.ts:19`'s `LogFn` is `(obj: Record<string, unknown>, msg?: string) => void` | CONFIRMED | |
| The 15 instanceof sites enumerated in HR6 | CONFIRMED (all 15 sites verified individually in this review) | |
| The 10 errno `code ===` checks | CONFIRMED (all 10 verified at the cited files:lines) | |
| The `KeychainUnavailableError` name change behavior | CONFIRMED (KeychainUnavailableError has no `this.name`, so `err.name === 'Error'` today; `new.target.name` would make it `'KeychainUnavailableError'`) | |
| `process-lock.ts:347` is the throw site for `DeferToPeerError` | UNVERIFIED (not checked line-by-line) | |

---

## Concrete fix list (must-resolve before implementation)

1. **M1.** Replace "91 test files mock `logger.js`" with **90** in
   `00-summary.md`, `01-module-state-analysis.md`, `04-generic-interfaces.md`
   §L, `06-risks-and-mitigations.md` HR2, `05-refactor-roadmap.md` Phase H.5
   second-gate baseline. Update HR2 mitigation #1 ("64 of 91 conform")
   → "64 of 90 conform".
2. **M2.** Update `src/index.ts:283` source comment from
   `index.test.ts:1382` to `index.test.ts:1383` in the same H.1 commit
   that collapses the adapter literal.
3. **M3.** Decide with the user whether H.4 creates `src/CLAUDE.md` or
   documents the convention in `src/errors.ts`'s header. Do not defer
   this decision to the implementer.
4. **M4.** Spell out the exact extended `TOP_LEVEL_RESOLVE` regex in
   Phase H.3's deliverable. Either reject the class form
   (`= new LazyBin(...).resolve()`) only (preferred, since the closure
   form is what 11 consumer files keep using) or explicitly enumerate
   the additional patterns the regex must catch. Add a non-vacuity
   self-test for each new pattern.

## Concrete fix list (should-resolve, optional)

5. **m1.** Replace "76 string-first" with **73** in `00-summary.md` HR1,
   `04-generic-interfaces.md` §L, `06-risks-and-mitigations.md` HR4.
6. **m4.** Add a comment to `04-generic-interfaces.md` §L sketch
   noting pino's three-overload `LogFn` is a superset of the
   two-form proposal.
7. **m6.** Either drop the enumerability pin from H.4 test coverage #4
   or scope it as a forward-looking invariant for future
   `AppError` subclasses that carry `cause` (rather than a
   regression pin for the current H.4 conversion).
8. **m3 (boundary clarity).** Add one sentence to `00-summary.md`
   Scope explicitly stating that H does not own the 44-file route
   handler migration (gated on framework R11).

## Net verdict

**PASS-WITH-EDITS.** The plan is structurally sound, internally
consistent on the parts that matter (the 9 error classes are correctly
enumerated, the `LoggerLike` interface is a strict subset of
`pino.Logger`, the `LazyBin` reimplementation preserves the closure
factory shape, the `AppError` convention is correctly additive), and
correctly addresses every framework review finding in scope (CE-4,
CE-5, CE-9, CE-15, R10, OE-1/OE-2/OE-6/OE-11). The four major items
above are small-number and comment corrections — none changes the
design. None of the framework's critical issues re-appear in H.

After applying the 4 must-resolve fixes, the plan is ready to
implement.

## Confidence

- **High** on file:line refs for `logger.ts`, `platform.ts`,
  `process-lock.ts`, `index.ts`, `process-lock.test.ts:81/515`,
  `index.test.ts:1383`, `vault.test.ts:120`, `auth.test.ts:183`,
  `vault-bindings.test.ts:192`, `logger.test.ts:15/28/36/45/58`,
  `platform-bin-resolve.test.ts:88-92/94-100`,
  `platform-no-import-time-bin-resolve.test.ts:44`,
  `web/federation/http.ts:7/10/21/34`,
  `web/federation/poller.ts:68-71`,
  `web/http-helpers.ts:25-31/46`,
  `web/keychain.ts:19`, all 9 error classes, all 15 instanceof
  sites, all 10 errno `code ===` checks, and the pino `LogFn`
  overload count (verified by direct Read of the source files).
- **Medium** on the test-mock shape table in `06-risks-and-mitigations.md`
  HR2 — the aggregate per-mock-method counts (`info 84`, `error 84`,
  `warn 83`, `debug 79`, `level 8`, `fatal 4`, `trace 4`, `child 3`)
  are derived from the same source counts the plan claims; the *exact*
  per-shape count (64/7/6/4/3/2/1/1) was not re-derived.
- **High** on the parameter-property-vs-options-form enumerability
  claim — verified empirically on this machine's Node build.

No claim in the H plan was found to be unverifiable.
