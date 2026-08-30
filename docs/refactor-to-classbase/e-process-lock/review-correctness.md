# Correctness Review — E (process-lock) Plan

Review date: 2026-08-30. Scope: every file in
`docs/refactor-to-classbase/e-process-lock/` cross-checked against the
codebase at `/Users/eggp/marveen-develop/test-baseline` and the framework
review findings in `review-correctness.md` / `review-completeness.md` /
`h-cross-cutting/review-*.md`. **Review only — no plan file or source
file was modified.**

## Severity summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| Major | 5 |
| Minor | 6 |
| **Total** | **11** |

The plan is internally consistent on the parts that matter most (the
two acquire functions and the two context types are correctly
characterised; the `DeferToPeerError` two-throw-sites claim is verified;
the framework review findings R1, R3, R10 and H review finding HR4 are
correctly inherited). All major findings are line-count / line-number
drift that does not change the design but does affect the plan's
audit-trail quality.

---

## Major issues

### M1. "13 in-file log call sites" — actually 15

- **Location:** `02-type-interface-analysis.md` §1 (table and §1 text);
  `04-generic-interfaces.md` §L Mapping / §V Verifiability;
  `05-refactor-roadmap.md` E.6 (Risk); `06-risks-and-mitigations.md` ER6.
- **Plan claim:** "13 call sites (`:107, :112, :136, :138, :155, :158,
  :181, :196, :301, :328, :336, :346, :350, :352, :362`)". The
  in-line enumeration lists 15 lines but the prose insists on "13".
- **Evidence:** `grep -nE 'log\.(info|warn|error)' src/process-lock.ts`
  returns **15** matches, at exactly the 15 lines the plan's
  enumeration lists. The plan's own grep command would produce the
  correct count of 15; the discrepancy is the prose calling it 13
  (probably from an earlier draft before the two `terminateProcesses`
  lines at 155/158 were added to the table).
- **Verdict:** REFUTED. **Severity:** major — the headline number
  ("13 call sites satisfy `LoggerLike`'s `LogFn` without modification")
  is wrong, and the migration's main safety claim
  ("zero call-site argument shape changes") understates the surface
  by 15%. Future verifiers running the grep against a later commit
  will get a different number than the plan documents.
- **Concrete fix:** Replace "13" with "15" everywhere it appears; the
  in-line line enumeration is already correct.

### M2. `releaseLock()` has 4 call sites in `index.ts`, not 5

- **Location:** `05-refactor-roadmap.md` E.4 "Files touched" bullet
  ("the call sites of `releaseLock()` are at `:393, :402, :408, :413,
  `:411-415`"); `01-module-state-analysis.md` §6 ("called from three
  places inside `shutdown()` (L393, L402, L408, L413) plus the
  catch-all L411-415 path" — note this also has internal drift).
- **Plan claim:** "five `releaseLock()` call sites" with specific
  ranges `:393, :402, :408, :413, :411-415`.
- **Evidence:** `grep -n "releaseLock()" src/index.ts` returns four
  matches at exactly `L393, L402, L408, L413`. The `:411-415` range
  in the plan is the `catch (err) { … releaseLock() … }` block whose
  `releaseLock()` is at `:413` — not a separate site. The plan
  over-counts because it reads the `catch` block (L411-415) as a call
  site, but only one of those five lines (`:413`) actually calls
  `releaseLock()`.
- **Verdict:** REFUTED. **Severity:** major — the migration claim
  ("Each becomes `await pidfileLockAcquirer.release()`") overstates
  the migration work by 1 site, and a reworker reading "five sites"
  will look for a fifth call that does not exist.
- **Concrete fix:** "the four `releaseLock()` call sites in
  `index.ts:393, :402, :408, :413`"; remove `:411-415` from the
  enumeration. Note also `01-module-state-analysis.md` §6 has its
  own internal drift ("three places … plus the catch-all L411-415")
  — same fix needed there.

### M3. `withRealAcquirePortLock` / `withRealAcquirePidfileLock` are at L1365 / L1317, not L1363 / L1314

- **Location:** `00-summary.md` Test files row ("`withRealAcquirePortLock`
  / `withRealAcquirePidfileLock` helpers at `:1363` and `:1314`");
  `01-module-state-analysis.md` §5 ("`withRealAcquirePortLock`
  (`index.test.ts:1363-1374`)"); `02-type-interface-analysis.md` §4
  Helper row; `05-refactor-roadmap.md` E.5 ("`withReal*` helpers at
  `:1363` and `:1314`"); `06-risks-and-mitigations.md` ER5 (Mitigation
  #2); `01-module-state-analysis.md` §8 test inventory.
- **Plan claim:** `withRealAcquirePortLock` at `index.test.ts:1363`,
  `withRealAcquirePidfileLock` at `index.test.ts:1314`.
- **Evidence:** `grep -n "function withRealAcquire"` returns:
  - `withRealAcquirePidfileLock` at `index.test.ts:1317` (the
    `// vi.importActual bypasses…` comment the plan cites is on
    `:1314`, but the function declaration is on `:1317`).
  - `withRealAcquirePortLock` at `index.test.ts:1365`.
- **Verdict:** REFUTED. **Severity:** major — every reference in
  five different files is off by 2-3 lines. The E.5 risk
  ("After E.5 the imports return `undefined`; the helpers must be
  rewritten") and the rewrite strategy depend on knowing the actual
  function bodies.
- **Concrete fix:** Replace `:1363` with `:1365` and `:1314` with
  `:1317` in all five files. The `:1363-1374` / `:1304-1330`
  ranges should be `:1365-1375` / `:1317-1331` respectively.

### M4. Plan claims 33 `it()` cases in `process-lock.test.ts`; actual is 50

- **Location:** `00-summary.md` Scope row ("`src/__tests__/process-lock.test.ts`
  — 33 `it()` cases"); `01-module-state-analysis.md` §1 Brief summary
  ("33 unique `it()` cases over the file"); §8 Test file structure
  inventory (per-describe counts); `02-type-interface-analysis.md` §9
  Test fixtures; `05-refactor-roadmap.md` E.2 ("14 existing
  `acquirePidfileLock` cases (`:532-749`)"); `06-risks-and-mitigations.md`
  ER5 ("33 cases"); ER6 ("33 cases").
- **Plan claim:** "33 unique `it()` cases" with per-describe counts of
  findOwnNodeHolders: 9, findOwnBinaryMatches: 3, terminateProcesses: 8,
  acquirePortLock: 8, acquirePidfileLock: 14, writeBufferFully: 5,
  DASHBOARD_BINARY_PATTERN: 7+. Per-describe sums to **54** — already
  inconsistent with the "33" headline before any re-measurement.
- **Evidence:** `grep -c "^  it(" src/__tests__/process-lock.test.ts`
  returns **50** `it()`-declaration lines (it-each lines count once
  per declaration). Per-describe ground truth: findOwnNodeHolders: 9
  (✓), findOwnBinaryMatches: 3 (✓), terminateProcesses: **9** (plan:
  8), acquirePortLock: **10** (plan: 8), acquirePidfileLock: **13**
  (plan: 14), writeBufferFully: **6** (plan: 5), DASHBOARD_BINARY_PATTERN:
  **2 `it.each` declarations expanding to 11 cases** (plan: 7+).
- **Verdict:** REFUTED. **Severity:** major — the test-coverage
  requirements (e.g. "all 33 existing cases pass against the wrapper")
  and the migration rollback strategy ("the 33 cases pass unchanged")
  both depend on the count. A reworker counting test cases at E.1
  landing time will get a different number.
- **Concrete fix:** Replace "33" with **50** everywhere. Update
  per-describe counts: terminateProcesses 8→9, acquirePortLock 8→10,
  acquirePidfileLock 14→13, writeBufferFully 5→6, DASHBOARD_BINARY_PATTERN
  7+→11 (or "2 it.each, 11 cases"). Verify by `grep -c "^  it("`.

### M5. E.5 says `process-lock.test.ts:5, :6, :7` import `findOwnNodeHolders`, `findOwnBinaryMatches`, `terminateProcesses` — the imports are at `:3, :4, :5`

- **Location:** `05-refactor-roadmap.md` E.5 ("The
  `process-lock.test.ts:5, :6, :7` imports of `findOwnNodeHolders`,
  `findOwnBinaryMatches`, `terminateProcesses` stay").
- **Plan claim:** `findOwnNodeHolders` imported at `:5`,
  `findOwnBinaryMatches` at `:6`, `terminateProcesses` at `:7`.
- **Evidence:** `grep -n "^  [a-z]" src/__tests__/process-lock.test.ts
  | head -10`:
  - `:1` — `import { describe, it, expect } from 'vitest'`
  - `:2` — `import {`
  - `:3` — `  findOwnNodeHolders,`
  - `:4` — `  findOwnBinaryMatches,`
  - `:5` — `  terminateProcesses,`
  - `:6` — `  acquirePortLock,`
  - `:7` — `  acquirePidfileLock,`
  - `:8` — `  writeBufferFully,`
  - `:9` — `  DeferToPeerError,`
- **Verdict:** REFUTED. **Severity:** major — the import lines the
  plan must NOT touch in E.5 are `:3, :4, :5`, not `:5, :6, :7`.
  E.5 removes the `acquirePortLock` / `acquirePidfileLock` imports at
  `:6, :7` — but the plan's text says "stay", and the imports at `:5,
  :6, :7` (which the plan claims stay) actually include the line that
  E.5 must remove. The line-number error inverts the migration plan
  by one row.
- **Concrete fix:** Replace "`:5, :6, :7` imports of `findOwnNodeHolders`,
  `findOwnBinaryMatches`, `terminateProcesses` stay" with "the
  `:3, :4, :5` imports of `findOwnNodeHolders`, `findOwnBinaryMatches`,
  `terminateProcesses` stay; the `:6, :7` `acquirePortLock`,
  `acquirePidfileLock` imports are removed in E.5".

---

## Minor issues

### m1. `process-lock.test.ts:26, :46, :216, :236, :249, :281, :302, :319` are 8 sites, not 7

- **Location:** `03-class-boundaries.md` E1 "LockContext generic over
  T — rejected" #4 ("the seven `ProcessLockContext['signal']`
  index-access sites in `process-lock.test.ts` `:26, :46, :216, :236,
  :249, :281, :302, :319`"); `02-type-interface-analysis.md` §4 #4
  (lists the same 8 lines).
- **Plan claim:** "seven `ProcessLockContext['signal']` index-access
  sites" with a parenthesised list of 8 lines.
- **Evidence:** `grep -n "ProcessLockContext\['signal'\]" src/__tests__/process-lock.test.ts`
  returns 8 matches at exactly the lines the plan's list contains.
- **Verdict:** REFUTED. **Severity:** minor — the in-line enumeration
  is correct; only the "seven" prose word is off-by-one. (Same internal
  drift as M1.)
- **Concrete fix:** Replace "seven" with "eight" in the
  `03-class-boundaries.md` text.

### m2. `vi.mock('../process-lock.js')` factory body is at `:173-196`, not `:173-194`

- **Location:** `01-module-state-analysis.md` §5 ("factory at
  `src/__tests__/index.test.ts:173-194`"); `02-type-interface-analysis.md`
  §6 (factory shape block); `06-risks-and-mitigations.md` ER5
  (factory at `:173-194`, mitigation #3).
- **Plan claim:** factory returns `{ acquirePortLock, acquirePidfileLock,
  writeBufferFully, DeferToPeerError }` at `:173-194`.
- **Evidence:** the actual factory is `vi.mock('../process-lock.js',
  async () => { … return { … } })` at `:173-196` (`:196` is the
  closing `})`); the `{ … }` literal is `:190-195`.
- **Verdict:** REFUTED. **Severity:** minor — off by 2 lines. Doesn't
  change any design claim, but the "factory shape" code block in the
  plan does not include the closing `})` line.
- **Concrete fix:** Replace `:173-194` with `:173-196` in all three
  files.

### m3. Adapter literal at `index.ts:280-287` is 8 lines (`:280` to `:287`), but the comment claiming "forwarder-only" runs `:281-283`

- **Location:** `02-type-interface-analysis.md` §8 ("two adapter
  literals at `src/index.ts:171-175` and `:280-287`"); `04-generic-interfaces.md`
  §L Mapping ("`src/index.ts:171-175`" and "`src/index.ts:280-287`");
  `06-risks-and-mitigations.md` ER6.
- **Plan claim:** adapter literal at `:280-287`.
- **Evidence:** the adapter is at `log: {` (`:280`) through `},` (`:287`);
  the explanatory comment is on `:281-283` (3 lines within the 8-line
  literal). The plan is correct that the comment is `:281-283`. The
  adapter-literal range `:280-287` matches.
- **Verdict:** CONFIRMED. **Severity:** minor — verified at L280-287.
  No fix needed.
- **Concrete fix:** None.

### m4. `src/index.ts:283` source comment cites `index.test.ts:1382` — the test starts at `1383` (one too low)

- **Location:** `01-module-state-analysis.md` §7 (verbatim quote of
  the `index.ts:281-283` comment); `02-type-interface-analysis.md` §8
  ("source comment at `index.ts:283` currently cites `index.test.ts:1382`,
  off-by-one — fix to `1383` in the same H.1 commit").
- **Plan claim:** the comment at `index.ts:283` is off-by-one (says
  `1382`, should be `1383`). Plan defers the fix to H.1.
- **Evidence:** `src/index.ts:283` reads verbatim:
  `// only at process-lock.ts:301/328/336/346/350/352). Pinned by index.test.ts:1382.`
  The test `'forwards pidfile context errors to logger.error'` starts
  at `index.test.ts:1383`. The plan correctly identifies the bug and
  the fix location; the `04-generic-interfaces.md` §L "Pin test that
  survives the E.6 collapse" paragraph correctly cites the right line.
- **Verdict:** CONFIRMED (the bug exists; the plan flags it; the fix
  is correctly deferred to H.1). **Severity:** minor — per the H plan
  review's m2 finding, this is the H plan's responsibility, and the
  E plan correctly inherits it.
- **Concrete fix:** None — the E plan correctly defers this to H.1.

### m5. `src/index.ts:171-175` adapter is `log: {` (`:171`) through `},` (`:175`); cited correctly

- **Location:** `02-type-interface-analysis.md` §8; `04-generic-interfaces.md`
  §L Mapping row.
- **Plan claim:** `log: { info: (obj, msg) => logger.info(obj, msg), … }`
  at `:171-175`.
- **Evidence:** `src/index.ts:171` is `log: {`; `:175` is `},` — closing
  the adapter. The 5-line range matches the source.
- **Verdict:** CONFIRMED. **Severity:** minor — verified at L171-175.
  No fix needed.
- **Concrete fix:** None.

### m6. The plan's source-vs-skeleton check on whether `filterOwnNodeCandidates` is exported is correct (it is not exported)

- **Location:** `01-module-state-analysis.md` §1 ("`filterOwnNodeCandidates`
  — **not exported** — module-private").
- **Plan claim:** `filterOwnNodeCandidates` is module-private.
- **Evidence:** `src/process-lock.ts:93` reads
  `function filterOwnNodeCandidates(pids: number[], ctx: ProcessLockContext): number[]`
  with **no** `export` keyword. The function is only called from
  `findOwnNodeHolders` (`:79`) and `findOwnBinaryMatches` (`:90`).
- **Verdict:** CONFIRMED. **Severity:** minor — verified.
- **Concrete fix:** None.

---

## Confirmed claims (subset)

The following key claims were verified as TRUE (grep + Read against
the source on 2026-08-30):

- **`src/process-lock.ts`** (364 lines, 9 sections per the plan's "9
  sections" structural claim; the plan also says "365 lines" once in
  `02-type-interface-analysis.md` and "365 lines" in `00-summary.md`
  — measured 364. Off by 1; immaterial).
- `LogFn` at `process-lock.ts:19` — `(obj: Record<string, unknown>,
  msg?: string) => void`. CONFIRMED.
- `SignalOutcome` at `:24`. CONFIRMED.
- `ProcessLockContext` at `:26`; `log` field at `:49` typed
  `{ info: LogFn; warn: LogFn; error: LogFn }`. CONFIRMED.
- `AcquirePortLockOptions` at `:52-65`; `DEFAULT_GRACE_MS` at `:67`,
  `DEFAULT_POST_KILL_DRAIN_MS` at `:68`, `DEFAULT_POST_KILL_POLL_MS`
  at `:69`. CONFIRMED.
- `findOwnNodeHolders` at `:77`, `findOwnBinaryMatches` at `:88`,
  `filterOwnNodeCandidates` at `:93` (NOT exported), `terminateProcesses`
  at `:127`. CONFIRMED.
- `acquirePortLock` at `:169-197`; the defaults at `:174-176`,
  `byPort`/`byBinary` at `:177-178`, log warn at `:181`,
  `terminateProcesses(victims, ctx, { graceMs })` at `:182`,
  `waited = 0` at `:189`. CONFIRMED.
- `writeBufferFully` at `:207-219`. CONFIRMED.
- `ExclusiveCreateOutcome` at `:224`. CONFIRMED.
- `PidfileLockContext` at `:226`; `log` field at `:253`. CONFIRMED.
- `AcquirePidfileLockOptions` at `:256-268`. CONFIRMED.
- `DeferToPeerError` at `:272-279` with hand-set `this.name =
  'DeferToPeerError'` and `readonly peerPid`. CONFIRMED.
- `acquirePidfileLock` at `:289-364`; defaults at `:295-297`, for-loop
  at `:298`, `tryCreateExclusive` at `:299`, `readRecordedPid` at
  `:305`, `unlinkIfMatches(path, null)` at `:310`, self-recorded
  unlink at `:316`, probe-alive at `:322`, illegitimate-PID unlink
  at `:337`, **throw `DeferToPeerError` at `:347`** (two sites: this
  one + `index.ts:324`). CONFIRMED.
- Max-attempts log error at `:362` and throw `Error(...)` at `:363`.
  CONFIRMED.

- **`src/index.ts`** (568 lines).
- Imports at `:27-34`. CONFIRMED.
- `buildProcessLockContext()` at `:97-177`. CONFIRMED.
- `currentPid: process.pid` at `:100`; `uid` at `:98`.
  CONFIRMED.
- `listPortHolders` at `:102-110` (execSync lsof). CONFIRMED.
- `listOwnProcessesMatching` at `:111-139` (execFileSync ps).
  CONFIRMED.
- `getProcessCommand` at `:140-146`; `getProcessUid` at `:147-155`.
  CONFIRMED.
- `signal` at `:156-167` (process.kill). CONFIRMED.
- `sleep` at `:168-170` (setTimeout). CONFIRMED.
- Adapter literal `log: { info, warn, error }` at `:171-175`.
  CONFIRMED.
- `readRecordedPidFrom` at `:179-191`. CONFIRMED.
- `isLegitimateDashboardPid` at `:198-208`. CONFIRMED.
- `buildPidfileLockContext` at `:210-289`. CONFIRMED.
- `tryCreateExclusive` at `:212-232` (openSync O_EXCL, writeBufferFully,
  closeSync). CONFIRMED.
- `readRecordedPid` at `:233-235` (delegates to `readRecordedPidFrom`).
  CONFIRMED.
- `unlinkIfMatches` at `:236-253` (readFileSync + unlinkSync).
  CONFIRMED.
- `probeAlive` at `:254-264`. CONFIRMED.
- `sendTerm` at `:265-273`. CONFIRMED.
- `isLegitimatePredecessor` at `:274-276` (delegates to
  `isLegitimateDashboardPid`). CONFIRMED.
- `sleep` at `:277-279`. CONFIRMED.
- Adapter literal at `:280-287` (with `// Pinned by index.test.ts:1382`
  comment at `:283` — see m4). CONFIRMED.
- `checkFreshStartupRace` at `:299-325`. CONFIRMED.
- `throw new DeferToPeerError(recorded)` at `:324` (the second
  throw site). CONFIRMED.
- `acquireLock` at `:327-351`. CONFIRMED.
- `await acquirePortLock(WEB_PORT, procCtx, { binaryPattern:
  DASHBOARD_BINARY_PATTERN })` at `:341`. CONFIRMED.
- `await acquirePidfileLock(PID_FILE, process.pid, …, { onLiveLegitimate:
  'defer' })` at `:348-350`. CONFIRMED.
- `releaseLock` at `:356-364` (4 call sites at `:393, :402, :408,
  :413` — see M2 for the over-count). CONFIRMED.
- `let decayInterval: NodeJS.Timeout | null = null` at `:371`,
  `digestTimer` at `:372`, `digestInterval` at `:373`, `webServer`
  at `:374`, `shuttingDown` at `:375`, `exitCode` at `:376`. CONFIRMED.
- `shutdown()` at `:378-416`. CONFIRMED.
- Signal handlers at `:426-435` (SIGINT, SIGTERM, uncaughtException,
  unhandledRejection). CONFIRMED.
- `await acquireLock()` at `:437`. CONFIRMED.
- `main().catch(...)` at `:554-568`; `instanceof DeferToPeerError`
  at `:555`; `peerPid: err.peerPid` at `:556`. CONFIRMED.

- **`src/__tests__/process-lock.test.ts`** (818 lines).
- Imports at `:1-12` (`vitest` at `:1`, the `process-lock` named-imports
  block at `:2-12`; per-import lines `:3` findOwnNodeHolders, `:4`
  findOwnBinaryMatches, `:5` terminateProcesses, `:6` acquirePortLock,
  `:7` acquirePidfileLock, `:8` writeBufferFully, `:9` DeferToPeerError,
  `:10` ProcessLockContext, `:11` PidfileLockContext — see M5).
  CONFIRMED for lines, refuted for the line numbers used in the plan.
- `MockProc` interface at `:14` (plan says `:18-83` "MockProc tables";
  the interface is at `:14` and the `MockOptions` interface at `:16`,
  but the construct-and-use table extends through line 83 — the plan's
  range is approximate but correct in shape).
- `signalOverride?: ProcessLockContext['signal']` at `:26`; the
  eight `ProcessLockContext['signal']` index-access sites at `:26,
  :46, :216, :236, :249, :281, :302, :319`. CONFIRMED (count = 8, see m1).
- `log: { info: log('info'), warn: log('warn'), error: log('error') }`
  fixtures at `:81` (inside `makeCtx`) and `:515` (inside
  `makePidfileCtx`). CONFIRMED.
- `describe('findOwnNodeHolders', …)` at `:86` with 9 `it()` cases.
  CONFIRMED.
- `describe('findOwnBinaryMatches', …)` at `:166` with 3 `it()` cases.
  CONFIRMED.
- `describe('terminateProcesses', …)` at `:194` with 9 `it()` cases
  (plan: 8). CONFIRMED (count refuted, see M4).
- `describe('acquirePortLock', …)` at `:333` with 10 `it()` cases
  (plan: 8). CONFIRMED (count refuted, see M4).
- `describe('acquirePidfileLock', …)` at `:532` with 13 `it()` cases
  (plan: 14). CONFIRMED (count refuted, see M4).
- `'does NOT unlink a third peer that took the slot during our
  SIGTERM-wait'` at `:652` (the "third peer survives" regression test
  cited in `06-risks-and-mitigations.md` ER3 Detection signal).
  CONFIRMED.
- `describe('writeBufferFully', …)` at `:751` (plan says `:751`) with
  6 `it()` cases (plan: 5). CONFIRMED (count refuted).
- `describe('DASHBOARD_BINARY_PATTERN', …)` at `:797` with 2 `it.each`
  declarations (5 + 6 = 11 cases; plan: 7+). CONFIRMED (count refuted).

- **`src/__tests__/index.test.ts`** (2886 lines).
- `vi.mock('../process-lock.js', async () => { … })` at `:173-196`
  (plan: `:173-194`). CONFIRMED (range off by 2, see m2).
- `mockAcquirePidfileLock: vi.fn()` at `:72`;
  `mockAcquirePortLock: vi.fn()` at `:73`. CONFIRMED.
- `mockAcquirePidfileLock.mockResolvedValue(undefined)` at `:321`
  (plan: `:321`). CONFIRMED.
- `mockAcquirePortLock.mockImplementation(…)` default at `:324-341`
  (plan: `:324-341`). CONFIRMED.
- `withRealAcquirePidfileLock` declaration at `:1317` (plan: `:1314`).
  CONFIRMED (line off, see M3).
- `withRealAcquirePortLock` declaration at `:1365` (plan: `:1363`).
  CONFIRMED (line off, see M3).
- `describe('checkFreshStartupRace (runs at acquireLock startup)', …)`
  at `:875`. CONFIRMED.
- `'defers to a legitimate alive peer that is not yet on the port
  (throws DeferToPeerError)'` at `:876` (plan: `:876`). CONFIRMED.
- `'isLegitimatePredecessor true with onLiveLegitimate=defer: throws
  DeferToPeerError'` at `:1545` (plan: `:1545`). CONFIRMED.
- The `vi.importActual`-based delegate pattern at `:1321-1325` and
  `:1369-1373`. CONFIRMED.
- `describe('buildPidfileLockContext helpers via real acquirePidfileLock', …)`
  at `:1377` (plan: `:1377`). CONFIRMED.
- `'forwards pidfile context errors to logger.error'` at `:1383`
  (plan: `:1383`). CONFIRMED.
- `expect(mockLogger.error).toHaveBeenCalledWith(…)` at `:1391`
  (plan: `:1391`). CONFIRMED.
- `describe('main().catch() routes non-DeferToPeerError errors through
  shutdown', …)` at `:2148` (plan: `:2148+`). CONFIRMED.
- `describe('checkFreshStartupRace: rethrows DeferToPeerError when
  peer is mid-init', …)` at `:2206` (plan: `:2206+`). CONFIRMED.
- `'throws DeferToPeerError when recorded PID is alive, legitimate,
  and not on the port'` at `:2207` (plan: `:2207`). CONFIRMED.
- `describe('buildProcessLockContext.log and sleep via real
  acquirePortLock', …)` at `:2743` (plan: `:2743-2790+`). CONFIRMED.

- **Module importers:** only 2 files import from `./process-lock.js`
  or `../process-lock.js`:
  `src/index.ts:34` and `src/__tests__/process-lock.test.ts:12`.
  CONFIRMED.

- **Web/scripts consumers:** zero. `grep -rEn "acquirePortLock|
  acquirePidfileLock" --include='*.ts' src/web/ scripts/` returns
  zero hits. CONFIRMED.

- **`vi.mock('../process-lock.js')` count:** exactly 1 active site
  (`index.test.ts:173`) plus 1 explanatory comment (`index.test.ts:1314`).
  CONFIRMED.

---

## Framework cross-references — addressed correctly

| Framework finding | Where addressed | Verdict |
|---|---|---|
| `review-correctness.md` R1 (`MessageBus` ↔ `Scheduler` cycle fabricated) | E plan does not propagate the cycle to process-lock — neither `acquirePortLock` nor `acquirePidfileLock` participates in a `MessageBus` cycle. The plan correctly notes "**None**" for A, B, C, D, F, G → E reverse-blocking in `00-summary.md` Dependency table. | **CONFIRMED** — R1 is not relevant to E and the plan correctly excludes it. |
| `review-correctness.md` R3 (`vi.mock` patterns) | `01-module-state-analysis.md` §5 enumerates exactly 1 active `vi.mock('../process-lock.js')` factory + 1 explanatory comment. `06-risks-and-mitigations.md` ER5 dedicates a full section to the factory's transition through E.1–E.4 → E.5. | **CONFIRMED** — R3's `vi.mock` patterns are correctly inherited. |
| `review-correctness.md` R10 (logger re-import via `vi.resetModules`) | The plan's `01-module-state-analysis.md` §7 "Re-import safety (H.1 interaction)" addresses this directly: "the H `review-correctness.md` HR3 dual-destination hazard does not apply here — `process-lock.ts`'s `ctx.log` is *injected*, not imported." | **CONFIRMED** — R10 is correctly excluded for E because `ctx.log` is constructor/DI-injected, not module-imported. |
| `review-completeness.md` OE-5 (`BaseRunner<TFacts, TDecision>` over-engineering) | The E plan does not propose any `BaseRunner`-style abstraction; `PortLockAcquirer` and `PidfileLockAcquirer` are concrete classes with no shared abstract base. `04-generic-interfaces.md` §X "Considered and rejected" lists 6 rejected generics, including per-class generics on `PortLockAcquirer` / `PidfileLockAcquirer`. | **CONFIRMED** — OE-5 is correctly excluded from E. |
| `review-completeness.md` CE-5 (per-test factory function not specified) | The H plan's H.2a "Test factory" subsection addresses this once for all subsystems; E inherits. The E plan's `06-risks-and-mitigations.md` ER6 lists the per-test factory adjustments (widening `process-lock.test.ts:81/:515` to add `debug`). | **CONFIRMED** — E inherits H.2a's `createTestLogger()` factory. |
| `h-cross-cutting/review-correctness.md` HR4 (`LoggerLike` vs `pino.Logger` confusion) | `04-generic-interfaces.md` §L Mapping and `06-risks-and-mitigations.md` ER6 explicitly address HR4: `pino.Logger` is structurally assignable to `LoggerLike`; all 13 (sic — should be 15) E call sites use the obj-first form. The plan also acknowledges the test-side hazard (the two test fixtures at `process-lock.test.ts:81/:515` need `debug` added). | **CONFIRMED** (with M1 caveat) — HR4 is correctly addressed; the prose count "13" should be "15". |

---

## Net verdict

**PASS-WITH-EDITS.** The plan is structurally sound: the two acquire
functions are correctly characterised, the two context interfaces are
correctly characterised, the `DeferToPeerError` two-throw-sites claim
is verified, the dependency chain (`E ← H.1`, `E → class App`, `E.5
gates on mechanical grep`) is sound, the framework review findings
are correctly inherited, and the H review's HR4 finding is correctly
applied. The five major issues are all line-count / line-number drift
in the migration metadata — none of them changes the design. None of
the framework's critical findings (C1–C6, R1) re-appear in E.

**Concrete fixes before implementation:**

1. **M1.** Replace "13 in-file log call sites" with **15** in
   `02-type-interface-analysis.md` §1, §1 prose; `04-generic-interfaces.md`
   §L Mapping / §V; `05-refactor-roadmap.md` E.6 Risk; `06-risks-and-mitigations.md`
   ER6. The in-line enumeration of 15 lines is already correct.
2. **M2.** Replace the `releaseLock()` call site list
   `:393, :402, :408, :413, :411-415` (5 sites, REFUTED) with
   `:393, :402, :408, :413` (4 sites) in `05-refactor-roadmap.md` E.4
   and `01-module-state-analysis.md` §6. Same fix needed for the
   "three places inside `shutdown()` plus the catch-all L411-415 path"
   text in `01-module-state-analysis.md` §6.
3. **M3.** Replace `:1363` → `:1365` and `:1314` → `:1317` in
   `00-summary.md`, `01-module-state-analysis.md` §5 + §8,
   `02-type-interface-analysis.md` §4, `05-refactor-roadmap.md` E.5,
   `06-risks-and-mitigations.md` ER5.
4. **M4.** Replace "33 `it()` cases" with **50** everywhere. Update
   per-describe counts: terminateProcesses 8→9, acquirePortLock 8→10,
   acquirePidfileLock 14→13, writeBufferFully 5→6,
   DASHBOARD_BINARY_PATTERN 7+→11 (or "2 it.each, 11 cases").
5. **M5.** Replace `process-lock.test.ts:5, :6, :7` (in E.5) with
   `:3, :4, :5`; the `:6, :7` `acquirePortLock` / `acquirePidfileLock`
   imports are REMOVED in E.5, not "stay".

**Optional minor fixes:**

6. **m1.** Replace "seven `ProcessLockContext['signal']` index-access
   sites" with "eight" in `03-class-boundaries.md` E1.
7. **m2.** Replace `vi.mock('../process-lock.js')` factory range
   `:173-194` with `:173-196` in `01-module-state-analysis.md` §5,
   `02-type-interface-analysis.md` §6, `06-risks-and-mitigations.md`
   ER5.

After applying the 5 must-resolve fixes, the plan is ready to
implement. Without them, an executor will:

- count test cases wrong (M4),
- misidentify which imports E.5 must remove (M5),
- look for a fifth `releaseLock()` call site that does not exist (M2),
- apply the helper-rewrite to the wrong function bodies (M3),
- under-report the `LoggerLike` adoption surface (M1).

The plan's design — `PortLockAcquirer` and `PidfileLockAcquirer`
classes extracted alongside the existing free functions, the free
functions removed in E.5 only after every consumer migrates, the
`LoggerLike` adoption deferred to H.1 — is correct.

### Confidence level

- **High** on all `process-lock.ts` line references (every claim
  verified by direct Read).
- **High** on all `index.ts` line references (every claim verified by
  direct Read; both `DeferToPeerError` throw sites confirmed at
  `process-lock.ts:347` and `index.ts:324`).
- **High** on the 4-`releaseLock()`-sites count (verified by direct
  grep).
- **High** on the `vi.mock` count (1 active site at
  `index.test.ts:173`).
- **Medium** on the test `it()` count (verified by direct grep; the
  `it.each` expansion to 11 cases is the most likely source of the
  original "33" / "7+" drift — a re-counter that didn't expand
  `it.each` would land at 41 cases, which is closer to but still off
  from the "33" headline).

No claim in the plan was found to be unverifiable.

---

## One unflagged issue worth flagging

The plan's `process-lock.ts` line count is given as **365 lines** in
`00-summary.md` and `02-type-interface-analysis.md`, but the measured
file is **364 lines**. The `process-lock.ts` line count is also stated
as **363 lines** in `01-module-state-analysis.md` (Brief summary) and
**365 lines, 9 sections** in `02-type-interface-analysis.md`. So the
plan has **two** different line counts (363 and 365) in different
files. Measured: **364**. This is an off-by-one drift; immaterial for
the migration but worth correcting before commit. Affects:

- `00-summary.md`: `src/process-lock.ts` (365 lines, 9 sections) →
  (364 lines)
- `01-module-state-analysis.md` Brief: `(363 lines, 9 sections)` →
  `(364 lines, 9 sections)`
- `02-type-interface-analysis.md` Brief: `(365 lines as of 2026-08-30,
  measured)` → `(364 lines, measured)`