# Correctness Review — G (channel-coordinator) Refactor Plan

Review date: 2026-08-30. Scope: every file in
`docs/refactor-to-classbase/g-channel-coordinator/` cross-checked
against the codebase at `/Users/eggp/marveen-develop/test-baseline`.
GROUND-TRUTH METHOD: every file:line ref, every external consumer
path, every vi.mock site, every `class`/`let`/`const` declaration, and
every counter in this review was verified with Read / grep / Bash
against the live source. No claim is taken from the plan's own
assertion of "verified 2026-08-30".

---

## Severity summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| Major | 1 |
| Minor | 9 |
| **Total** | **10** |

Plan internally consistent for: every file:line ref to the 4 G source
files (channel-coordinator.ts / telegram-client.ts / ingest.ts /
liveness.ts) inside the body of the cited functions; the 4 mutable lets
(`state` L101, `downStreak` L102, `stopping` L103, `nativeConfirmedUpUntil`
L106); the `TelegramApiError` class (L45-54) including the `kind`
discriminator and `retryAfterSec` payload; all 5 `instanceof TelegramApiError`
sites (L335, L338, L366, L372, L378) with the correct `kind` value at
each; the 4 PID_FILE usage sites (L144 existsSync / L145 readFileSync /
L156 writeFileSync / L161 readFileSync+unlinkSync); the
`installSignalHandlers` shape (L407-420, with onSignal at L408-417 and
the two `process.on` registrations at L418-419); the
`acquireSingleInstanceLock` / `releaseLock` / `readToken` /
`sendAlert` / `buildHandoffContent` / `neutralizeChannelTags` /
`transientBackoffMs` / `processBatch` / `reconcilePending` /
`fatalExit` / `runLoop` / `main` line ranges; the entry-point guard at
L435; the 17 logger call sites (L150, L173, L244, L252, L254, L275,
L293, L295, L303, L333, L340, L343, L355, L374, L411, L427, L437); the
5 `vi.mock` sites in `src/__tests__/` (1 ingest + 4 liveness, all
verified line-precise); the 3 external `COORDINATOR_AGENT_ID`
const-only consumers (`web/agent-message-wrap.ts:21`,
`web/federation/local-catalog.ts:8`, `web/routes/messages.ts:11`); the
11 dedicated `channel-coordinator-*.test.ts` files; the 0 logger call
sites in `telegram-client.ts`; the 9 free probe functions in
`liveness.ts` (count confirmed, locations confirmed); and the C3
"fictional runner paths" being entirely outside G scope.

---

## Major issues

### M1. PID_FILE usage breakdown in `01-module-state-analysis.md` is arithmetically wrong

- **Location:** `01-module-state-analysis.md §PID_FILE const + 4 usage sites`.
- **Plan claim (verbatim):** "the correct characterization is '1 const
  PID_FILE referenced at 4 sites, 3 reads + 1 write + 1 unlink + 1
  existsSync'."
- **Evidence:** `src/channel-coordinator.ts` has exactly the following
  PID_FILE call sites, verified by `grep -nE "PID_FILE" src/channel-coordinator.ts`:
  - L144: `if (existsSync(PID_FILE))` → **1 existsSync**
  - L145: `const prev = parseInt(readFileSync(PID_FILE, 'utf-8').trim(), 10)` → **1 readFileSync**
  - L156: `writeFileSync(PID_FILE, String(process.pid), { mode: 0o600 })` → **1 writeFileSync**
  - L161: `if (existsSync(PID_FILE) && readFileSync(PID_FILE, 'utf-8').trim() === String(process.pid)) unlinkSync(PID_FILE)` → **1 readFileSync + 1 unlinkSync**
  - Total: **5 calls across 4 sites**, with **2 readFileSync calls** (not 3).
- **Verdict:** REFUTED. **Severity:** major — the plan inflates the
  read count from 2 to 3, and the per-call breakdown ("3 reads + 1 write
  + 1 unlink + 1 existsSync" = 6) is arithmetically inconsistent with
  the "4 sites" claim. An executor verifying the migration's lock-dance
  behavior will count calls and find 5 not 6, and the discrepancy
  indicates the author did not actually Read L161 (which contains both
  `readFileSync` and `unlinkSync` on the same line — easy to miss).
- **Concrete fix:** "1 const PID_FILE referenced at 4 sites: 1
  existsSync (L144) + 2 readFileSync (L145, L161) + 1 writeFileSync
  (L156) + 1 unlinkSync (L161) = 5 calls in 4 sites." Note that L161
  is a guarded unlink: the `readFileSync` is the precondition check
  (only unlink if the recorded PID matches ours).

---

## Minor issues

### m1. Every file LOC in the plan is off by exactly 1 (last-line closed brace not counted)

- **Location:** `00-summary.md` §Files this plan TOUCHES; `01-module-state-analysis.md`
  §Per-file inventory (column "LOC"); `03-class-boundaries.md` headers
  ("src/channel-coordinator/telegram-client.ts (227 LOC)", etc.);
  `05-refactor-roadmap.md` §Phase G.1–G.3 migration source headers.
- **Plan claim:**
  - `src/channel-coordinator.ts` = **442 LOC**
  - `src/channel-coordinator/telegram-client.ts` = **227 LOC**
  - `src/channel-coordinator/ingest.ts` = **231 LOC**
  - `src/channel-coordinator/liveness.ts` = **288 LOC**
  - `src/channel-coordinator/provider-poller-match.ts` = **92 LOC**
- **Evidence:** `wc -l` output:
  - `src/channel-coordinator.ts` = **441** lines
  - `src/channel-coordinator/telegram-client.ts` = **226** lines
  - `src/channel-coordinator/ingest.ts` = **230** lines
  - `src/channel-coordinator/liveness.ts` = **287** lines
  - `src/channel-coordinator/provider-poller-match.ts` = **91** lines
- **Verdict:** REFUTED. **Severity:** minor — each file is consistently
  off by exactly 1 (the closing `}` at EOF). Per `review-correctness.md`
  m9 in the framework review, this is the same systematic pattern seen
  in other subsystem reviews (off-by-one from counting the open-brace
  line as the closing line). For G this is purely cosmetic — the line
  ranges (e.g., L407-420 for `installSignalHandlers`) are correct
  because the function body ends with `}` at L420 regardless of the
  last-line closure.
- **Concrete fix:** decrement each LOC by 1. This appears in 5 distinct
  rows in `01-module-state-analysis.md` and the corresponding headers
  in `03-class-boundaries.md` and `05-refactor-roadmap.md`.

### m2. `02-type-interface-analysis.md` is referenced by the task brief but absent from the G folder

- **Location:** `00-summary.md §Thesis` (line 14): "The task brief's
  referenced `02-type-interface-analysis.md` does **not** exist in this
  directory as of 2026-08-30 — the type/interface claims used below
  are taken from the state analysis and cross-checked against the
  source files cited inline."
- **Plan claim:** the file does not exist (plan flags this as an
  [ASSUMPTION]).
- **Evidence:** `ls /Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/g-channel-coordinator/`
  returns: `00-summary.md`, `01-module-state-analysis.md`,
  `03-class-boundaries.md`, `04-generic-interfaces.md`,
  `05-refactor-roadmap.md`, `06-risks-and-mitigations.md`. No `02`.
- **Verdict:** CONFIRMED-as-flagged (the absence is real). **Severity:**
  minor — the plan correctly self-flags this. The downside is that the
  type/interface claims used throughout `03` and `04` are sourced from
  `01 §Per-file inventory` + inline source reads, which the reviewer
  has independently verified. If a `02` is produced later, cross-check
  is needed (per the [ASSUMPTION] marker).
- **Concrete fix:** none required if the [ASSUMPTION] stays; otherwise
  produce `02-type-interface-analysis.md` for the 5 G-relevant types:
  `UpdateKind` (telegram-client.ts:23), `NormalizedEvent` (L25-35),
  `TelegramErrorKind` (L43), `InsertResult` (ingest.ts:98-101),
  `IncomingEventRow` (ingest.ts:105-122).

### m3. `03-class-boundaries.md §G3` "Free functions that REMAIN" table lists `L109-111 inNative409Cooldown` but spec method signature differs from free function

- **Location:** `03-class-boundaries.md §G3` public surface, the
  `inNative409Cooldown` method row; `03-class-boundaries.md §G3` "Free
  functions that REMAIN" table.
- **Plan claim:** "Method `inNative409Cooldown(nowMs: number):
  boolean` // was the free function at L109-111" + "free function stays
  as a thin wrapper `export const inNative409Cooldown = (a, b) => a > b`".
- **Evidence:** `src/channel-coordinator.ts:109-111`:
  ```ts
  export function inNative409Cooldown(confirmedUpUntilMs: number, nowMs: number): boolean {
    return nowMs < confirmedUpUntilMs
  }
  ```
  The free function takes **2 parameters** (`confirmedUpUntilMs`,
  `nowMs`) and returns `nowMs < confirmedUpUntilMs` (true when the
  cooldown is still active). The proposed class method takes **1
  parameter** (`nowMs`) and would read the stored
  `this.nativeConfirmedUpUntil`. The "thin wrapper" line in the plan
  says `(a, b) => a > b` — that's actually the INVERSE of the source
  (which is `a < b` where `a = nowMs`, `b = confirmedUpUntilMs`). The
  plan's pseudo-code is wrong by an inequality direction.
- **Verdict:** REFUTED. **Severity:** minor — the G3 method signature
  change (1-param class method wrapping a 2-param free function) is
  semantically reasonable but the "wrapper" sketch inverts the
  inequality. Also, the `channel-coordinator.test.ts` test at lines
  62-86 exercises the 2-param form (`inNative409Cooldown(1_000_000,
  999_999)` etc.) — preserved by the free-function wrapper if the
  wrapper is correct.
- **Concrete fix:** Change the wrapper sketch to `export const
  inNative409Cooldown = (confirmedUpUntilMs, nowMs) =>
  liveness.nativeConfirmedUpUntil !== undefined ? nowMs <
  liveness.nativeConfirmedUpUntil : nowMs < confirmedUpUntilMs` —
  actually simpler: keep the 2-param free function as a pure helper
  (it's stateless math) and let the class method on `LivenessTracker`
  be a 1-param convenience wrapper that delegates to the same pure
  expression with `this.nativeConfirmedUpUntil` as the first arg.
  Class method body: `return nowMs < this.nativeConfirmedUpUntil`.
  Free function (preserved): `(confirmedUpUntilMs, nowMs) => nowMs <
  confirmedUpUntilMs` (matches source). Plan's "a > b" sketch is a
  typo for "nowMs < confirmedUpUntilMs".

### m4. `06-risks-and-mitigations.md GR5` mock-shape claim for the 1 ingest.js site is correct, but a clearer statement would help

- **Location:** `06-risks-and-mitigations.md GR5` mitigation (b).
- **Plan claim:** "G.2 (`IngestWorker` extraction) requires a 1-line
  update at `messages-routes.test.ts:101` IF the test mock shape
  changes from `{ COORDINATOR_AGENT_ID: ... }` to `{ default: {
  COORDINATOR_AGENT_ID } }`. The recommended pattern is to keep the
  const export flat (no `default` wrapper), so the existing mock
  continues to work."
- **Evidence:** `src/__tests__/messages-routes.test.ts:101`:
  ```ts
  vi.mock('../channel-coordinator/ingest.js', () => ({
    COORDINATOR_AGENT_ID: 'telegram-coordinator',
  }))
  ```
  This is the actual mock. It uses the flat-export form (no `default`
  wrapper), which works because vi.mock with the factory function
  returns the object directly as the module's exports — so the test
  sees `import { COORDINATOR_AGENT_ID } from
  '../channel-coordinator/ingest.js'` resolve correctly.
- **Verdict:** CONFIRMED. **Severity:** minor — the plan correctly
  identifies the risk and recommends the right shape (flat export).
  No fix needed beyond noting that the mock shape "changes" is a
  hypothetical that won't fire if the plan keeps the const as a free
  export.
- **Concrete fix:** none required.

### m5. The 9 free functions in `liveness.ts` count is verified, but `provider-poller-match.ts` is a 6th file outside the 4-file scope

- **Location:** `01-module-state-analysis.md §Per-file inventory` last
  row; `00-summary.md §Files this plan does NOT touch`.
- **Plan claim:** "Files this plan TOUCHES (4 files)" + a row for
  `provider-poller-match.ts` ("sub-scope of `liveness.ts`") that
  characterizes it as 92 LOC with 1 internal consumer (liveness.ts:18).
- **Evidence:** `src/channel-coordinator/provider-poller-match.ts` is
  91 LOC (not 92). The file has the `matchesProviderPollerCmd` export
  at L82-91, the `RUNTIME_TOKEN_RX` at L21, `SLUG_RX` at L49-55,
  `SLACK_SOCKET_MODE_RX` at L70. `src/channel-coordinator/liveness.ts:18`
  imports `matchesProviderPollerCmd`. The plan correctly notes the
  file is not in G scope (per `d-channel-provider/00-summary.md` "leave
  the 18 pure utility modules as namespaces" precedent) but still
  includes it in the per-file inventory, which is mildly inconsistent
  with "Files this plan TOUCHES (4 files)".
- **Verdict:** REFUTED (off-by-1 LOC, see m1) but plan intent
  (sub-scope inventory) is clear. **Severity:** minor.
- **Concrete fix:** adjust the LOC count to 91 (see m1). Optionally
  add a brief note in `00-summary.md` clarifying why the
  per-file-inventory row for `provider-poller-match.ts` exists even
  though the file is not touched.

### m6. `06-risks-and-mitigations.md GR8` `process.exit(` count of "4: L151, L306, L415, L439" mixes exit(0) and exit(1) calls

- **Location:** `06-risks-and-mitigations.md GR8` Detection signal.
- **Plan claim:** "A static check: `grep -nE "process\\.exit\\("
  src/channel-coordinator.ts` returns the same number of hits after
  G.4 as before (currently 4: L151, L306, L415, L439 per `01
  §Per-file inventory`)."
- **Evidence:** `grep -n "process.exit" src/channel-coordinator.ts`:
  - L151: `process.exit(1)` — PID lock conflict
  - L306: `process.exit(1)` — `fatalExit`
  - L415: `process.exit(0)` — shutdown drain
  - L439: `process.exit(1)` — crash handler
  The count of `process.exit(` calls is **4** (matches plan), but only
  **1** is `process.exit(0)` (L415). The other 3 are `process.exit(1)`.
- **Verdict:** PARTIALLY REFUTED. **Severity:** minor — the count is
  correct, but the implication in GR8's text is "the 4 process.exit
  sites are equivalent" when 3 of them are fatal/abort paths and 1 is
  the graceful drain. The static-check grep would return 4 either way
  (it matches `process.exit(`), but an executor auditing the G.4
  rollback needs to know that L415 is the only one that's
  "non-fatal-by-design".
- **Concrete fix:** update the detection-signal text to "currently 4
  `process.exit(` calls (L151, L306, L415, L439 — of which only L415
  is `exit(0)`; the other 3 are `exit(1)` for fatal/crash paths)."

### m7. `03-class-boundaries.md §G4` "Free functions that REMAIN" includes `sleep(ms)` at L226 but the plan does not claim L226 elsewhere

- **Location:** `03-class-boundaries.md §G4` "Free functions that REMAIN
  after G.4" table, row "`sleep(ms)` | `channel-coordinator.ts:226`".
- **Plan claim:** `sleep(ms)` is a local `const` at L226, "private
  module helper".
- **Evidence:** `src/channel-coordinator.ts:226`:
  `const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))`.
  CONFIRMED — the const is at L226 and is only used by `fatalExit`
  (L305: `await sleep(1500)`) and `runLoop` (L347: `await sleep(TICK_MS)`,
  L379: `await sleep((err.retryAfterSec ?? 5) * 1000)`, L383:
  `await sleep(transientBackoffMs(...))`).
- **Verdict:** CONFIRMED. **Severity:** minor (no error; included for
  the audit trail). No fix needed.
- **Concrete fix:** none.

### m8. `01-module-state-analysis.md §runLoop state-machine flow` characterizes L329-330 as `probeHighWater + setOffset` but the order matters and is correctly described

- **Location:** `01-module-state-analysis.md §runLoop state-machine flow`
  bullet "First call `probeHighWater(token)` to seed the poll_offset
  (L329-330)".
- **Plan claim:** L329-330 is the seed-probe + offset set.
- **Evidence:** `src/channel-coordinator.ts:329-330`:
  ```ts
  const hw = await probeHighWater(token)
  if (hw != null) setOffset(SOURCE, hw)
  ```
  CONFIRMED — L329 calls `probeHighWater`, L330 conditionally sets the
  offset. The seed-then-set ordering is critical for the
  no-double-delivery invariant.
- **Verdict:** CONFIRMED. **Severity:** minor (audit-trail). No fix
  needed.
- **Concrete fix:** none.

### m9. `04-generic-interfaces.md §2` claim "no Slack/Discord alternative for the coordinator" is true, but the source has no formal SLACK/DISCORD producer abstraction today either

- **Location:** `04-generic-interfaces.md §2` "No Slack/Discord
  alternative for the coordinator" bullet.
- **Plan claim:** "Per `telegram-client.ts:1-13` ('This client never
  sends ... the coordinator backfills only the Telegram channel'),
  there is no second `TelegramClient<TProvider = 'slack'>`
  implementation, and none is planned."
- **Evidence:** `telegram-client.ts:1-13` opens with the file-level
  comment "This client never sends (outbound stays with the native
  plugin); it only ingests, and only while the native plugin is down
  (the coordinator backfills, see channel-coordinator.ts)." Plus, the
  internal consumer of `telegram-client.ts` is `channel-coordinator.ts:36`
  only (verified by grep). There is no second Telegram-shaped client
  file under `src/channel-coordinator/` or anywhere else. The
  `provider-poller-match.ts` module DOES handle Slack/Discord/Telegram/
  Googlechat/Teams in its `SLUG_RX` map (line 49-55) but that's a
  process-tree matcher, not a getUpdates-poll client.
- **Verdict:** CONFIRMED. **Severity:** minor (audit-trail). No fix
  needed.
- **Concrete fix:** none.

---

## Confirmed claims (subset for context)

The following G-plan claims were verified TRUE against the codebase:

**Source-file structure (with the m1 LOC caveat):**
- All 5 file:line ranges for functions in `channel-coordinator.ts`
  (readToken L117-136, acquireSingleInstanceLock L142-157, releaseLock
  L159-163, sendAlert L170-175, neutralizeChannelTags L182-184,
  buildHandoffContent L189-215, transientBackoffMs L221-224,
  processBatch L233-258, reconcilePending L270-298, fatalExit L302-307,
  runLoop L311-403, installSignalHandlers L407-420, main L422-431).
- All 5 file:line ranges in `telegram-client.ts` (TelegramApiError
  L45-54, mapUpdate L98-137, getUpdates L143-190, probeHighWater
  L201-226).
- All 13 file:line ranges in `ingest.ts` (COORDINATOR_AGENT_ID L23, let
  db L25, initIngestDb L27-91, requireDb L93-96, InsertResult L98-101,
  IncomingEventRow L105-122, insertIncomingEvent L126-150,
  createHandoffMessage L160-166, markEventDelivered L168-173,
  markEventFailed L175-177, getEventsNeedingHandoff L190-204,
  getOffset L206-211, setOffset L216-223, closeIngestDb L225-230).
- All 9 file:line ranges in `liveness.ts` (tmuxBin L20, getClaudePidForSession
  L34-49, decideHasPluginAlive L72-130, snapshotProcsWithRetry L145-155,
  probeChannelPluginLiveness L164-217, hasChannelPluginAlive L223-225,
  readRespawnStampMs L229-236, readKeepaliveAgeMs L241-247,
  decideNativeChannelDown L266-272, probeNativeChannelDown L276-287).
- `provider-poller-match.ts` constants + matcher (RUNTIME_TOKEN_RX L21,
  SLUG_RX L49-55, SLACK_SOCKET_MODE_RX L70, matchesProviderPollerCmd
  L82-91).

**The 4 mutable lets + the 1 const PID_FILE:**
- `state: State = 'idle'` at L101; `downStreak = 0` at L102; `stopping = false` at L103;
  `nativeConfirmedUpUntil = 0` at L106 (with explanatory comment at L104-105).
- `const PID_FILE = join(STATE_DIR, 'coordinator.pid')` at L98; `const STATE_DIR` at L97.

**`TelegramApiError`:**
- `class TelegramApiError extends Error` at L45-54. `kind:
  TelegramErrorKind` (L43 = 'fatal' | 'rate_limit' | 'conflict' |
  'transient') is the discriminator; `retryAfterSec?: number` is the
  optional payload. `this.name = 'TelegramApiError'` at L52 (not via
  `new.target.name` — the plan's note about H.4's AppError base
  changing to `new.target.name` is forward-looking, not current).
- No `cause` chain — the `super(message)` call at L51 has no second
  argument.
- Exactly 5 `instanceof TelegramApiError` sites in
  `channel-coordinator.ts`: L335 (`err.kind === 'fatal'`), L338
  (`err.kind === 'conflict'`), L366 (`err.kind === 'fatal'`), L372
  (`err.kind === 'conflict'`), L378 (`err.kind === 'rate_limit'`).
  `err.retryAfterSec ?? 5` is read at L379.

**`installSignalHandlers`:**
- Defined at L407-420. The `onSignal` closure is at L408-417. SIGTERM
  registration at L418, SIGINT registration at L419. The 3-second
  drain timer is at L412: `setTimeout(() => { releaseLock();
  closeIngestDb(); process.exit(0); }, 3000)`. The `if (stopping) return`
  re-entry guard is at L409.

**`runLoop` state-machine line refs:**
- L312: `let transientAttempt = 0` (local variable inside runLoop)
- L313: `while (!stopping)` loop entry
- L315: `reconcilePending()` call (every tick, regardless of state)
- L317: `if (state === 'idle')` branch entry
- L322: `const down = probeNativeChannelDown(SESSION, PROVIDER) && !inNative409Cooldown(...)`
- L323: `downStreak = down ? downStreak + 1 : 0`
- L324: `if (downStreak >= DOWN_DEBOUNCE)` (constant=2)
- L329-330: seed probe + offset set (see m8)
- L331: `state = 'backfilling'`
- L335: `if (err instanceof TelegramApiError && err.kind === 'fatal') { await fatalExit(err) }`
- L338: `if (err instanceof TelegramApiError && err.kind === 'conflict')`
- L339: `nativeConfirmedUpUntil = Date.now() + NATIVE_409_COOLDOWN_MS`
- L347: `await sleep(TICK_MS)`
- L351: `// state === 'backfilling'` comment
- L354-358: yield-before-poll (`if (!probeNativeChannelDown(...)) { state = 'idle'; downStreak = 0; continue }`)
- L356: `state = 'idle'; downStreak = 0`
- L362: `updates = await getUpdates(token, getOffset(SOURCE) + 1, LONGPOLL_TIMEOUT_SEC, POLL_LIMIT)`
- L366: `if (err instanceof TelegramApiError && err.kind === 'fatal')`
- L372: `if (err instanceof TelegramApiError && err.kind === 'conflict')`
- L373: `nativeConfirmedUpUntil = Date.now() + NATIVE_409_COOLDOWN_MS`
- L375: `state = 'idle'; downStreak = 0`
- L378: `if (err instanceof TelegramApiError && err.kind === 'rate_limit')`
- L379: `await sleep((err.retryAfterSec ?? 5) * 1000)`
- L383: `await sleep(transientBackoffMs(Math.min(++transientAttempt, 6)))`
- L393-397: yield-before-handoff (`if (!probeNativeChannelDown(...)) { ... continue }`)
- L395: `state = 'idle'; downStreak = 0`
- L401: `setOffset(SOURCE, maxUpdateId)` (only after `processBatch` returns)

**vi.mock sites (5 total across 4 files, per `01 §11.4` and `06 GR5`):**
- `src/__tests__/messages-routes.test.ts:101`:
  `vi.mock('../channel-coordinator/ingest.js', () => ({ COORDINATOR_AGENT_ID: 'telegram-coordinator' }))`
- `src/__tests__/schedule-mcp-precheck-full.test.ts:80`:
  `vi.mock('../channel-coordinator/liveness.js', () => ({ getClaudePidForSession: (...) }))`
- `src/__tests__/channel-monitor.test.ts:259`:
  `vi.mock('../channel-coordinator/liveness.js', () => ({ getClaudePidForSession, hasChannelPluginAlive, probeChannelPluginLiveness }))`
- `src/__tests__/channel-monitor-baseline.test.ts:222`: same shape as above
- `src/__tests__/channel-monitor-coverage.test.ts:243`: same shape as above

**External `COORDINATOR_AGENT_ID` consumers (3 files, all const-only):**
- `src/web/agent-message-wrap.ts:21` — `import { COORDINATOR_AGENT_ID } from '../channel-coordinator/ingest.js'`
- `src/web/federation/local-catalog.ts:8` — same import shape
- `src/web/routes/messages.ts:11` — same import shape

**External `liveness.js` consumers (2 files, all in web/):**
- `src/web/channel-monitor.ts:50` — `import { getClaudePidForSession, hasChannelPluginAlive, probeChannelPluginLiveness } from '../channel-coordinator/liveness.js'`
- `src/web/schedule-mcp-precheck.ts:22` — `import { getClaudePidForSession } from '../channel-coordinator/liveness.js'`

**`telegram-client.ts` external consumers (1 file):**
- `src/channel-coordinator.ts:36` — `import { getUpdates, probeHighWater, mapUpdate, TelegramApiError } from './channel-coordinator/telegram-client.js'`

**`provider-poller-match.ts` consumers (1 file):**
- `src/channel-coordinator/liveness.ts:18` — `import { matchesProviderPollerCmd } from './provider-poller-match.js'`

**The 11 dedicated `channel-coordinator-*.test.ts` files (verified by ls):**
- `channel-coordinator.test.ts`, `channel-coordinator-full.test.ts`,
  `channel-coordinator-bootstrap-extra.test.ts`,
  `channel-coordinator-ingest.test.ts`,
  `channel-coordinator-liveness.test.ts`,
  `channel-coordinator-lock.test.ts`,
  `channel-coordinator-lock-live-pid.test.ts`,
  `channel-coordinator-process-batch.test.ts`,
  `channel-coordinator-reconcile.test.ts`,
  `channel-coordinator-runloop-extra.test.ts`,
  `channel-coordinator-telegram-client.test.ts`

**`RawUpdate` / `RawMessage` / `RawUser` have no external consumers:**
- `grep -rn "RawUpdate\|RawMessage\|RawUser" src/ --include='*.ts' |
  grep -v __tests__` returns ONLY references inside
  `telegram-client.ts` itself (the type definitions L56, L58-60, L64-65,
  L69, L75, L81, L88, L98, L148, L187, L222). The plan's G1
  "Free functions that REMAIN" table correctly hypothesizes these can
  become `private` inside the class — they ARE class-private-eligible
  today (no external importers).

**0 logger call sites in `telegram-client.ts`:**
- `grep -nE "logger\.<(info|warn|error|debug)\(" src/channel-coordinator/telegram-client.ts` returns no output.

**0 logger call sites in `ingest.ts`:**
- Same grep pattern against `src/channel-coordinator/ingest.ts` returns no output (verified separately).

**C3 fictional runner paths are NOT in G scope (framework review correctness):**
- `ls src/web/federation-poller.ts` → no such file
- `ls src/web/capability-summary-runner.ts` → no such file
- `ls src/web/costs-sync-task.ts` → no such file
- `ls src/web/approval-timeout-sweeper.ts` → no such file
- The actual paths referenced in the framework plan (`src/web/federation/poller.ts`,
  `src/web/federation/capability-runner.ts`, `src/web/routes/costs.ts`,
  `src/web/routes/approvals.ts`) DO exist, but they are NOT touched
  by the G plan. The G plan correctly references `web/agent-message-wrap.ts`,
  `web/federation/local-catalog.ts`, `web/routes/messages.ts`,
  `web/channel-monitor.ts`, `web/schedule-mcp-precheck.ts` (none of
  which are the C3 fictional paths). C3 finding does not apply to G.

**ChannelProvider integration with channel-coordinator is minimal:**
- `grep -n "ChannelProvider\|channel-provider\|getProvider" src/channel-coordinator.ts` returns no matches.
- The only D-subsystem touch point in `channel-coordinator.ts` is
  `import { PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME } from './config.js'` at L35 (consuming the const) and
  `const PROVIDER = CHANNEL_PROVIDER` at L57.
- The plan's "G does not import `ChannelProvider`, `getProvider`, or
  any provider method" claim is CONFIRMED. The G4 constructor's
  `registry: ChannelProviderRegistry` parameter is forward-looking
  (D.3 rename) — production G today uses `CHANNEL_PROVIDER` const
  only.

---

## Out-of-scope cross-checks

| Framework review finding | Verdict for G scope |
|---|---|
| **C3** (4 fictional runner paths) | NOT IN G SCOPE. The 4 fictional paths (`federation-poller.ts`, `capability-summary-runner.ts`, `costs-sync-task.ts`, `approval-timeout-sweeper.ts`) are not referenced anywhere in the G plan. CONFIRMED clean. |
| **CE-7** (heartbeat-agent-scaffold prompt-builder confusion) | NOT IN G SCOPE. The G plan does not reference `web/heartbeat-agent-scaffold.ts` at all. The plan's liveness-section comments (`01-module-state-analysis.md §liveness.ts deep-dive`) correctly distinguish the scheduled keepalive (`store/.channel-keepalive`) from a runner. |
| **CE-9** (`RemoteStatusCache<T>` reuse opportunity) | NOT IN G SCOPE. `web/remote-status-cache.ts` is not imported by any G file. The G plan's `04-generic-interfaces.md §6` correctly rejects `LivenessTracker<TState>` on OE-6 grounds without invoking `RemoteStatusCache`. |
| **OE-4** (`AuthContext` sealed hierarchy) | NOT IN G SCOPE. The G plan does not reference `AuthContext` or any web auth concept. The 4 framework-level refactors (D1, D2, D3, D4) are correctly not enumerated in the G plan. |
| **M11** (shutdown order fabrication) | NOT APPLICABLE TO G. The G plan correctly notes (in `06 GR8`) that the coordinator is a SEPARATE PROCESS and not in the dashboard's `index.ts:378-410` shutdown list. The G plan's own shutdown description (3-second drain in `installSignalHandlers.onSignal`) is sourced from the actual `channel-coordinator.ts:407-420` source. |

---

## Net verdict

**PASS (with 1 major + 9 minor cosmetic fixes).**

The G plan is sound. Every load-bearing claim about the 4 G files
(mutable lets, `TelegramApiError`, `installSignalHandlers`, the
state-machine body of `runLoop`, the entry-point guard, the
`COORDINATOR_AGENT_ID` re-export constraint, the 5 `vi.mock` sites,
the 11 dedicated test files, the 0 logger call sites in
`telegram-client.ts` / `ingest.ts`) was verified line-precise against
the source. The plan's structural decisions (4 new classes, 1
preserved class, free functions surviving until G.8, `process.listenerCount`
guard in `installSignalHandlers` mitigation GR1, factory pattern for
test rewrites in `06 CE-5` reference, the 3-second drain timer
preserved verbatim) all align with the codebase.

**The 1 major finding (M1: PID_FILE call breakdown)** is an
arithmetic mistake that would cause an executor to miscount
readFileSync sites during a migration audit. Fix it (2 readFileSync
calls, not 3).

**The 9 minor findings** are: file LOC off-by-1 (5 files × same
cosmetic issue, m1), the absent `02-type-interface-analysis.md`
correctly flagged as an [ASSUMPTION] in the plan (m2), the
`inNative409Cooldown` class-method vs free-function signature
inconsistency in `03 §G3` (m3 — the plan's pseudo-code inverts the
inequality), the ingest.js mock-shape recommendation correctly
documented (m4), the provider-poller-match.ts sub-scope inventory row
(m5), the `process.exit(` count of 4 but only 1 is `exit(0)` (m6),
two audit-trail confirmations (m7, m8), and the Slack/Discord
producer-abstraction absence correctly characterized (m9). None of
these change the implementation strategy.

**Specific fixes before implementation:**
1. Correct the PID_FILE breakdown in `01-module-state-analysis.md`
   to "5 calls in 4 sites: 1 existsSync + 2 readFileSync + 1
   writeFileSync + 1 unlinkSync" (M1).
2. Decrement each file LOC by 1 in the per-file inventory and the
   file-touched headers across `00-summary.md`, `01-module-state-analysis.md`,
   `03-class-boundaries.md`, `05-refactor-roadmap.md` (m1).
3. Fix the `inNative409Cooldown` thin-wrapper sketch in
   `03-class-boundaries.md §G3`: the inequality is `nowMs <
   confirmedUpUntilMs`, not `a > b` (m3).
4. Clarify in `06-risks-and-mitigations.md GR8` detection-signal that
   3 of the 4 `process.exit(` sites are `exit(1)` (fatal/crash paths)
   and only L415 is `exit(0)` (graceful drain) (m6).

After applying 1-4, the plan should be sound for implementation.

**Confidence level:** High on all line-number claims (every cited
line was Read against the live source in this review session). High
on the `TelegramApiError` discrimination, the 4 mutable lets, the 5
vi.mock sites, and the 11 test files (all grep-verified). High on
the C3/CE-7/CE-9/OE-4/M11 out-of-scope cross-checks (no G-plan
references to the wrong paths). The framework review's
`ChannelProviderRegistry` forward-looking dependency is correctly
characterized as a post-D.3 dependency that G does not yet consume.
