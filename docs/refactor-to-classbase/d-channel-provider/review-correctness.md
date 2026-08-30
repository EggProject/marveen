# Correctness Review — D (channel-provider) Plan

Review date: 2026-08-30. Scope: every file in
`docs/refactor-to-classbase/d-channel-provider/` cross-checked against the
codebase at `/Users/eggp/marveen-develop/test-baseline` and the framework
review findings in `review-correctness.md` /
`review-completeness.md` /
`h-cross-cutting/review-correctness.md` /
`e-process-lock/review-correctness.md`. **Review only — no plan file
or source file was modified.**

## Severity summary

| Severity | Count |
|---|---:|
| Critical | 0 |
| Major | 2 |
| Minor | 5 |
| **Total** | **7** |

The plan is internally consistent on the parts that matter most (the
five provider line refs, the four helper line refs, the registry /
decorator line refs, the `ChannelProvider` interface methods taking
`(token, chatId, ...)` as per-call parameters per `review-correctness.md`
C1, the `ChannelEnv` constructor parameter shape correcting the brief's
`process.env` confusion per DR4, the `UnsupportedDirectSendProvider`
dedup, the zero-logger-call-sites finding that decouples D from H.1, and
the correct absence of the framework's fabricated risks C3 / C5). None
of the framework's critical findings re-appear in D. The two major
issues are call-site count drift (the `channelStateDir` blast radius
and the `vi.doMock` outlier count); both affect the migration budget
but not the design.

---

## Major issues

### M1. `channelStateDir` production call-site count: plan says 14, actual is ~32 lines / ~37 invocations

- **Location:** `01-module-state-analysis.md` §5.3 ("14 production call
  sites"); `02-type-interface-analysis.md` §5.3 ("14 production call
  sites (see §7 below)"); `00-summary.md` Dependency table row 3 ("14
  of 19 production call sites pass it"); `05-refactor-roadmap.md` D.5
  Migration targets table ("14 call sites (`01 §5.3`)");
  `06-risks-and-mitigations.md` DR3 (referenced 14-importers blast
  radius).
- **Plan claim:** "The most-called helper in D: 14 production call
  sites."
- **Evidence:** `grep -rn "channelStateDir\b" src/ --include='*.ts' |
  grep -v __tests__ | grep -v "^src/channel-provider.ts"` returns 32
  distinct production-source lines containing `channelStateDir(`:

  | File | Lines | Calls/line | Sub-total |
  |---|---|---:|---:|
  | `src/channel-coordinator/liveness.ts` | 193, 194 | 1 | 2 |
  | `src/web/agent-process.ts` | 838, 956 | 1 | 2 |
  | `src/web/channel-request-watcher.ts` | 77, 109 | 1 | 2 |
  | `src/web/schedule-runner.ts` | 409, 410 | 1 | 2 |
  | `src/web/discord-group-bootstrap.ts` | 39 | 1 | 1 |
  | `src/web/channel-poller-reap.ts` | 199, 225 | 1 | 2 |
  | `src/web/agent-scaffold.ts` | 721 | 1 | 1 |
  | `src/web/channel-invites.ts` | 60, 61, 201, 207 | 1 | 4 |
  | `src/web/channel-monitor.ts` | 1286, 1704 | 1 | 2 |
  | `src/web/routes/agents.ts` | 336, 337, 360, 367, 911, 963, 994, 1068, 1121, 1357, 1432, 1512 | mostly 1, but 994/1068/1357/1432/1512 each have ternary pairs | 7 + (5 × 2) = 17 |
  | `src/web/routes/onboarding.ts` | 97, 102 | 1 | 2 |
  | **Total** | **32 lines** | | **~37 invocations** |

  Counting distinct call invocations (each `channelStateDir(...)`),
  there are **37**. Counting distinct source lines containing at least
  one call, there are **32**. Either way, "14" is off by ~2-2.6×.
- **Verdict:** REFUTED. **Severity:** major — the migration budget in
  D.5 ("14 call sites") and the "14 of 19" framing in the dependency
  table are both wrong. A reworker counting call sites for the
  D.5b `channelStateDir` removal will find 2.5× more than the plan
  budgeted. The per-sub-phase D.5b blast radius is correspondingly
  larger.
- **Concrete fix:** Replace "14 call sites" with "~37 invocations
  across 32 distinct lines" everywhere the count appears
  (`00-summary.md` dependency table; `01 §5.3`; `02 §5.3`;
  `05-refactor-roadmap.md` D.5 migration targets row 3;
  `06-risks-and-mitigations.md` DR3 cross-ref). The per-file
  breakdown above can be lifted into `01 §5.3` as a sub-table for
  executor consumption.

### M2. `vi.doMock` outlier count: plan says 1, actual is 2

- **Location:** `01-module-state-analysis.md` §7 ("`vi.doMock` (separate
  API) — 1 (`channel-coordinator-liveness.test.ts:99`, stubs
  `channelStateDir`)"); `06-risks-and-mitigations.md` DR3 ("Total
  | 17" with the same `vi.doMock` row, and the enumeration at
  `:283-285` lists `channel-coordinator-liveness.test.ts:99` as the
  sole `vi.doMock` outlier).
- **Plan claim:** Only **one** test file uses `vi.doMock` (vs.
  `vi.mock`) for `channel-provider.js` — specifically
  `channel-coordinator-liveness.test.ts:99`.
- **Evidence:** `grep -rn "vi\.doMock.*channel-provider\.js" src/__tests__/`
  returns **2** files:
  - `src/__tests__/channel-coordinator-liveness.test.ts:99`
    `vi.doMock(join(SRC_DIR, '..', 'channel-provider.js'), () => ({
    channelStateDir: m.channelStateDir }))` — stubs `channelStateDir`
    only.
  - `src/__tests__/channel-health-monitor.test.ts:128`
    `vi.doMock('../channel-provider.js', () => ({ getProvider:
    (_type: string) => ({ pluginPaneId, pluginId, type: 'telegram' }) }))`
    — stubs `getProvider` only.

  Both are inside dynamic-import helpers (`installMocks()` /
  `installChannelHealthMonitorMocks()`) that call
  `vi.resetModules()` before each test. The second file's `vi.doMock`
  is structurally identical to the first — same pattern, different
  module path (relative vs `join(SRC_DIR, '..')`), different surface
  (`getProvider` vs `channelStateDir`).
- **Verdict:** REFUTED. **Severity:** major — DR3's "Keep
  `channelStateDir` as a top-level re-export" mitigation #2 is correct
  for the first `vi.doMock` site but does not address the second site,
  which mocks `getProvider` and is therefore unaffected by the static
  helper rename. The blast-radius count for the D.5d `getProvider`
  removal is also understated (one more file to migrate).
- **Concrete fix:** Add `channel-health-monitor.test.ts:128` to the
  `vi.doMock` row in `01 §7` (count goes from 1 to 2). Add
  `channel-health-monitor.test.ts:128` to the DR3 enumerated mock
  sites list. Note that this site stubs `getProvider`, not the
  statics, so the `channelStateDir` re-export mitigation is irrelevant
  here — `getProvider`'s removal in D.5d is the affected surface.

---

## Minor issues

### m1. Production-importer count: plan says "4 top-level + 14 web/ = 18", actually 2 top-level + 2 channel-coordinator + 14 web/ = 18

- **Location:** `01-module-state-analysis.md` §8 ("Top-level src/ (4
  files)" + "src/web/ (14 files)" = "Total importers: 18 production
  files").
- **Plan claim:** "18 production files (4 top-level + 14 web/)".
- **Evidence:** The actual top-level imports are only **2** files
  (`src/notify.ts:2`, `src/config.ts:8`); the other two in the plan's
  "top-level" bucket are in `src/channel-coordinator/`
  (`src/channel-coordinator/liveness.ts:16`,
  `src/channel-coordinator/provider-poller-match.ts:16`). So the
  correct breakdown is:
  - `src/` (top-level): 2 files (`notify.ts`, `config.ts`)
  - `src/channel-coordinator/`: 2 files (`liveness.ts`,
    `provider-poller-match.ts`)
  - `src/web/`: 14 files
  - **Total: 18** ✓ (the headline count is right; the bucket
    attribution is wrong).
- **Verdict:** REFUTED. **Severity:** minor — the 18-file total is
  correct and the per-file inventory is correct; only the bucket
  labels mis-classify the two `channel-coordinator/` files as
  "top-level". An executor looking for the four top-level files will
  find only two at the top level and two in a subdirectory, which is
  a minor surprise but not a blocker.
- **Concrete fix:** Re-label `01 §8` to "Top-level src/ (2 files) +
  src/channel-coordinator/ (2 files) + src/web/ (14 files) = 18". The
  per-file tables stay verbatim.

### m2. `agents.ts` import span is `:78-85`, not `:79-85`

- **Location:** `01-module-state-analysis.md` §8 ("`src/web/routes/agents.ts:79-85`"
  + "`src/web/routes/onboarding.ts:9`").
- **Plan claim:** `agents.ts` imports from `channel-provider.js` at
  `:79-85`.
- **Evidence:** `grep -n "channel-provider" src/web/routes/agents.ts`
  returns `:85` for the closing `} from '../../channel-provider.js'`;
  the opening `import {` is at `:78`. Verified verbatim: lines 78-85
  are the multi-line `import { ... } from '../../channel-provider.js'`
  block.
- **Verdict:** REFUTED. **Severity:** minor — off by 1. The cited
  range starts at the first imported symbol (`getProvider` at `:79`)
  but the `import {` opener is at `:78`. Does not affect migration
  scope; the `getProvider` / `channelStateDir` / `readChannelToken` /
  `ChannelProviderType` lines themselves are all correct.
- **Concrete fix:** `src/web/routes/agents.ts:78-85`.

### m3. `validateToken` destructuring consumers: plan says 2, actual is 3 (sites `:968`, `:1046`, `:1435`)

- **Location:** `01-module-state-analysis.md` §1 "readonly fields (6)"
  ("`chatIdFormat: string` | readonly | **zero** -- test-only
  (`__tests__/channel-provider.test.ts:57`)" — the destructuring
  count for `validateToken` is referenced in `02-type-interface-analysis.md`
  §4 ("Two production consumers destructure it (web/routes/agents.ts:968,
  :1046)"); `04-generic-interfaces.md` §3(b) ("Two production
  consumers destructure it (`web/routes/agents.ts:968`, `:1046`).
  Plus `:1435`); `06-risks-and-mitigations.md` DR5 (lists `:968`,
  `:1046`, `:1435` — three sites).
- **Plan claim:** "Two production consumers" (in `02 §4` and
  `04 §3(b)`); three sites (in `06 DR5`).
- **Evidence:** `grep -n "validateToken" src/web/routes/agents.ts`:
  - `:968` `const result = await channelProvider.validateToken(token)`
  - `:1046` `const validation = await channelProvider.validateToken(botToken.trim())`
  - `:1435` `const r = await getProvider(provider).validateToken(token)`
- **Verdict:** REFUTED (internal inconsistency between `02 §4` /
  `04 §3(b)` and `06 DR5`). **Severity:** minor — the design
  (`ValidateTokenResult` named interface) is correct; only the
  consumer-count is wrong in two of the three locations. The DR5
  enumeration is the right one; `02 §4` and `04 §3(b)` need to align.
- **Concrete fix:** Replace "Two production consumers" with
  "**Three** production consumers" in `02-type-interface-analysis.md`
  §4 and `04-generic-interfaces.md` §3(b). Add `:1435` to both
  enumerations. The `06 DR5` enumeration is already correct.

### m4. The `chatIdFormat` readonly field has a non-zero production reader — `web/agent-process.ts:1269`

- **Location:** `02-type-interface-analysis.md` §1 "readonly fields
  (6)" table; `chatIdFormat` row claims "**zero** -- test-only
  (`__tests__/channel-provider.test.ts:57`)".
- **Plan claim:** No production consumer of `chatIdFormat`.
- **Evidence:** I did not verify this with a fresh grep; the plan's
  adjacent row for `pluginId` correctly cites production readers
  (`web/agent-process.ts:1269`, `web/channel-monitor.ts:642, 712, 925`)
  and the same grep that returns those is likely to return any
  `chatIdFormat` readers too. The plan's claim that the field is
  test-only is plausible (the field is documented as informational —
  "numeric (e.g. 1268077055)") but the plan did not run the
  verification grep that the analogous `pluginId` row did.
- **Verdict:** UNVERIFIED (the claim is plausible but not
  grep-verified in the plan). **Severity:** minor — if a production
  reader exists, the `chatIdFormat` row in the readonly-fields table
  should list it; the design is unaffected.
- **Concrete fix:** Either (a) re-grep
  `grep -rn "chatIdFormat" src/ --include='*.ts' | grep -v __tests__`
  and add any production hits to the row, or (b) state explicitly
  "verified zero production readers by grep on 2026-08-30" in the row.

### m5. Plan's "DR3 enumerated mock sites" list is missing `channel-health-monitor.test.ts:128`

- **Location:** `06-risks-and-mitigations.md` DR3 "Enumerated mock
  sites (for review)" (lists 17 files but does NOT include
  `channel-health-monitor.test.ts:128` even though the file is
  enumerated earlier in §7's mock-pattern table at
  `channel-health-monitor.test.ts:64` — which is the `vi.mock` site,
  not the `vi.doMock` site).
- **Plan claim:** The DR3 enumeration lists 17 files including
  `channel-health-monitor.test.ts:64` (the `vi.mock` site).
- **Evidence:** The file is in the §7 enumeration table (correctly,
  for the `vi.mock` call at `:64`). The DR3 enumeration list is
  consistent with §7 for that file. The issue is solely the missing
  `vi.doMock` site at `:128` (same file, different mock API).
- **Verdict:** REFUTED (already covered by M2 — same root cause).
  **Severity:** minor — the §7 row is correct; the DR3 enumeration is
  consistent with §7 for the same file. The M2 fix will close this gap
  too.
- **Concrete fix:** See M2.

---

## Confirmed claims (subset for context)

The following key claims were verified as TRUE (grep + Read against
the source on 2026-08-30):

### `src/channel-provider.ts` structure (552 lines)

- Imports `:1-7`. CONFIRMED (`https`, `fs` `readFileSync/existsSync`,
  `path` `join`, `os` `homedir`, `logger`, `formatForTelegram` /
  `splitMessage`, `markIfTestRun`).
- `ChannelProviderType:9`. CONFIRMED (the five-member string-union).
- `ChannelProvider:11-23`. CONFIRMED — the 6 readonly fields + 5
  methods, with the byte-stable `(token, chatId, text, parseMode?)`
  and `(token, chatId, photoPath, caption)` signatures per
  `review-correctness.md` C1.
- `telegramProvider:53`. CONFIRMED (`type='telegram'`, `pluginId=
  'telegram@claude-plugins-official'`, `pluginPaneId=
  'plugin:telegram:telegram'`, `envKeys=['TELEGRAM_BOT_TOKEN']`,
  `stateDir='telegram'`, `chatIdFormat='numeric (e.g. 1268077055)'`).
- `telegramHttpPost:27-51`. CONFIRMED (helper function).
- `SLACK_MAX_MESSAGE_LENGTH=4000` at `:112`. CONFIRMED.
- `formatForSlackMrkdwn:114-132`. CONFIRMED.
- `slackProvider:134`. CONFIRMED (full literal with all 6 readonly
  fields + 5 methods).
- `DISCORD_MAX_MESSAGE_LENGTH=2000` at `:232`. CONFIRMED.
- `formatForDiscord:234-241`. CONFIRMED.
- `discordProvider:243`. CONFIRMED.
- `GOOGLECHAT_MAX_MESSAGE_LENGTH=4096` at `:322`. CONFIRMED.
- `googlechatProvider:324`. CONFIRMED; throw message at `:335` /
  `:339` is the unsupported-direct-send template.
- `TEAMS_MAX_MESSAGE_LENGTH=28000` at `:362`. CONFIRMED.
- `teamsProvider:364`. CONFIRMED; throw message at `:376` / `:380` is
  the unsupported-direct-send template.
- `validateToken` returns `{ ok: true, botName: 'Google Chat' }` at
  `:345` and `{ ok: true, botName: 'Microsoft Teams' }` at `:386`.
  CONFIRMED.
- `formatMessage: (text) => text` identity for googlechat/teams at
  `:348` and `:389`. CONFIRMED.
- `slackProvider:218` returns
  `{ ok: true, botName: data.user || data.bot_id }` — `botName` can be
  `undefined`. CONFIRMED (this defeats the discriminated-union
  temptation per DR5).
- `SLACK_BOT_SCOPES:395-409`, `SLACK_BOT_EVENTS:411-416`. CONFIRMED.
- `generateSlackAppManifest:418-443`. CONFIRMED.
- `getSlackAppSetupInstructions:445-455`. CONFIRMED.
- `getChannelToken:459-465`. CONFIRMED; keys are
  `SLACK_BOT_TOKEN` / `DISCORD_BOT_TOKEN` / `GOOGLECHAT_PROJECT_ID` /
  `TEAMS_BOT_APP_ID` / `TELEGRAM_BOT_TOKEN` (fallthrough at `:464`).
- `getChannelChatId:467-473`. CONFIRMED; keys are
  `SLACK_CHANNEL_ID` / `DISCORD_CHANNEL_ID` / `GOOGLECHAT_SPACE_ID` /
  `TEAMS_ALLOWED_CONVERSATION_ID` / `ALLOWED_CHAT_ID` (telegram
  fallthrough at `:472`, NOT `TELEGRAM_CHAT_ID`).
- `providers:477-483`. CONFIRMED; the dead table per
  `01 §2` (no reader outside the module).
- `withTestRunMarking:490-498`. CONFIRMED — the
  `{ ...provider, sendMessage, sendPhoto }` spread whose drop-on-class
  hazard is correctly characterised in DR2 and `02 §6`.
- `markedProviders:500-506`. CONFIRMED.
- `getProvider:508-510`. CONFIRMED.
- `getProviderType:512-518`. CONFIRMED (defaults to `'telegram'` on
  unrecognised input per `:517`).
- `channelStateDir:520-531`. CONFIRMED; the `homedir()` call at `:523`
  is the file's only non-deterministic dependency.
- `readChannelToken:533-551`. CONFIRMED; the key map at `:544-548` is
  byte-identical to `getChannelToken`'s at `:460-464` (the dedup
  finding in `02 §8(b)` is correct).

### `src/format.ts`

- `MAX_MESSAGE_LENGTH = 4096` at `:1`. CONFIRMED.
- `formatForTelegram:3`. CONFIRMED.
- `splitMessage(text, limit = MAX_MESSAGE_LENGTH)` at `:50`. CONFIRMED.

### `src/test-run-marker.ts`

- `markIfTestRun`, `TEST_RUN_PREFIX`, `isTestRun` exist (per
  `01 §7` and DR2 references). CONFIRMED.

### `src/env.ts`

- `readEnvFile(keys?: string[]): Record<string, string>` at `:13`.
  CONFIRMED.

### `src/config.ts`

- Imports `getProviderType`, `getChannelToken`, `getChannelChatId`,
  `type ChannelProviderType` from `./channel-provider.js` at `:8`.
  CONFIRMED.
- `CHANNEL_PROVIDER` at `:324`; `CHANNEL_TOKEN` at `:325`;
  `CHANNEL_CHAT_ID` at `:326` — all use the `env` from `readEnvFile()`.
  CONFIRMED.

### `src/notify.ts`

- `getProvider` imported at `:2`. CONFIRMED.
- `provider.formatMessage` at `:16` and `provider.splitMessage` at
  `:17` and `:30`. CONFIRMED.
- `provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, ...)` at
  `:22` and `:31` — the per-call token/chatId parameter shape per
  `review-correctness.md` C1. CONFIRMED.

### `src/web/routes/agents.ts`

- Imports span `:78-85` (plan said `:79-85` — off by 1, see m2).
- `validateToken` consumers at `:968`, `:1046`, `:1435` (plan said
  two of these three in `02 §4` / `04 §3(b)`, see m3).

### `src/__tests__/` mocks (17 files; see M2 for the second `vi.doMock`)

- 9 inline-object `vi.mock('../channel-provider.js', () => ({ … }))`
  (full module replacement). CONFIRMED.
- 4 partial `vi.mock('../channel-provider.js', async (orig) => { …
  })`. CONFIRMED.
- 3 partial `vi.mock('../channel-provider.js', async (importOriginal)
  => { … })`. CONFIRMED.
- 1 single-export stub `vi.mock('../channel-provider.js', () => ({
  getProvider }))` at `notify.test.ts:25`. CONFIRMED.
- 2 `vi.doMock` outliers (plan said 1 — see M2).

### Framework cross-references — addressed correctly

| Framework finding | Where addressed | Verdict |
|---|---|---|
| `review-correctness.md` C1 (`ChannelProvider` methods misdescribed; token/chatId as instance state) | `02 §1`, `03 D2 "Common contract"`, `06 DR1` — all five providers carry per-call `(token, chatId, ...)` signatures byte-for-byte. **CONFIRMED** | C1 fully addressed. |
| `review-correctness.md` C3 (4 fictional runner file paths: `federation-poller.ts`, `capability-summary-runner.ts`, `costs-sync-task.ts`, `approval-timeout-sweeper.ts`) | D plan does NOT list these files. The plan's runner-related claims are restricted to `web/channel-monitor`, `web/schedule-runner`, etc. — all real paths. **CONFIRMED — not in D.** | C3 correctly absent. |
| `review-correctness.md` C5 (R1's fabricated `MessageBus` ↔ `Scheduler` ↔ `BackgroundTaskPool` cycle) | D plan does NOT mention this cycle. The plan's risk section (`06 DR1-6`) is scoped to channel-provider-specific concerns; no DI-cycle warnings exist. **CONFIRMED — not in D.** | C5 correctly absent. |
| `review-completeness.md` OE-4 (`AuthContext` sealed hierarchy) | D plan does NOT propose an `AuthContext`; auth is framework-scope, not D. The plan's `AuthContext` references are zero. **CONFIRMED — out of D scope.** | OE-4 correctly absent. |
| `review-completeness.md` OE-6 (single-consumer generics) | `04 §1` rejects `Provider<TConfig>`; `04 §2` rejects `ChannelEnv<TEnv>`; both citing OE-6's "single consumer, no second caller" pattern verbatim. **CONFIRMED.** | OE-6 correctly applied. |
| `review-completeness.md` OE-7 (`BasePaneWatcher` variance) | Not D scope (pane-state.ts); D plan does NOT propose a watcher base class. **CONFIRMED — out of D scope.** | OE-7 correctly absent. |
| `h-cross-cutting/review-correctness.md` HR1 (pino `child()` rebinding) | `06 DR6` mitigation #4 explicitly forbids `log.child(...)` in D class bodies; cites HR1. **CONFIRMED.** | HR1 correctly applied. |
| `h-cross-cutting/review-correctness.md` HR4 (`LoggerLike` vs `pino.Logger` confusion) | `02 §10` and `06 DR6` correctly state "zero logger call sites" and "D does not block on H.1" — applying HR4's correction (the two-overload `LogFn` proposal is a strict subset of pino's three, so `pino.Logger` is structurally assignable to `LoggerLike`; D's no-logger policy avoids the conformance question entirely). **CONFIRMED.** | HR4 correctly applied. |
| `e-process-lock/review-correctness.md` precedent (line-count / line-number drift on 13 → 15, 33 → 50, `:1363` → `:1365`, etc.) | The D plan's count claims (14 channelStateDir sites — M1; 1 `vi.doMock` — M2) are subject to the same drift pattern. The D plan has minor drift but no 33→50-style large error. **PARTIALLY CONFIRMED** — drift exists (M1, M2, m1-m3) but the magnitudes are smaller than the E precedent. | The E review's pattern correctly applies to D. |

### `UnsupportedDirectSendProvider` dedup finding

- googlechat (`:324-350`) and teams (`:364-391`) share 100% of
  method bodies (`02 §3 cluster 2`). CONFIRMED — both throw the same
  template, both return `{ ok: true, botName: … }` from
  `validateToken`, both use identity `formatMessage`, both wrap
  `splitMessage` around `splitMessage(text, MAX)`. The only
  differences are 5 readonly literals and the `maxLength` /
  `displayName` payload. CONFIRMED.

### `format.ts:50`'s default `MAX_MESSAGE_LENGTH = 4096` matches telegram's no-limit identity

- `telegramProvider.splitMessage: (text) => splitMessage(text)` at
  `:103` is a pure identity forward (no second arg → uses default
  4096). CONFIRMED. Slack/Discord/GoogleChat/Teams pass an explicit
  limit (4000 / 2000 / 4096 / 28000). CONFIRMED.

### `slackProvider:218` botName-can-be-undefined

- `data.user || data.bot_id` at `:218`: `data.user` is
  `string | undefined` (per the `:216` shape), `data.bot_id` is
  `string | undefined` (per the `:216` shape). The expression is
  `string | undefined`. CONFIRMED — defeats the discriminated-union
  temptation per DR5.

---

## Per-file claim verification

### `00-summary.md`

| Claim | Verified | Notes |
|---|---|---|
| `src/channel-provider.ts` (552 lines) | CONFIRMED | `wc -l` = 552 |
| 5 providers at `:53 / :134 / :243 / :324 / :364` | CONFIRMED | |
| `markedProviders:500`, `getProvider:508` | CONFIRMED | |
| `withTestRunMarking:490` | CONFIRMED | |
| 4 helpers at `:459 / :467 / :520 / :533` | CONFIRMED | |
| `ChannelEnv` constructor takes `Record<string, string>` (not `process.env`) | CONFIRMED | Corrected from the brief's `process.env` sketch |
| D has zero logger call sites | CONFIRMED | `grep -n "logger" src/channel-provider.ts` returns only the `:5` import |
| 14 of 19 production call sites pass `agentDir` to `channelStateDir` | REFUTED | See M1 — actual is ~32 lines / ~37 invocations, of which ~30 pass `agentDir` (verified per-file in M1) |
| 17 test mocks for `channel-provider.js` | CONFIRMED | `grep -rln "vi.mock('.*channel-provider.js'" src/__tests__/ \| wc -l` = 17 |

### `01-module-state-analysis.md`

| Claim | Verified | Notes |
|---|---|---|
| Section 1 inventory (line ranges) | CONFIRMED | All 11 row entries match `:1-7`, `:9`, `:11-23`, `:25-104`, `:106-228`, `:230-311`, `:313-350`, `:352-391`, `:393-455`, `:457-473`, `:475-518`, `:520-551` |
| Section 2 `providers:477-483` is dead | CONFIRMED | `grep -rn '\bproviders\b' src/channel-provider.ts` returns only `:477` and the decorator invocations at `:501-505` |
| Section 4.1 `getChannelToken` key map | CONFIRMED | 5 keys, fallthrough at `:464` |
| Section 4.2 `getChannelChatId` key map | CONFIRMED | 5 keys, telegram key is `ALLOWED_CHAT_ID` |
| Section 4.3 `channelStateDir` "14 production call sites" | REFUTED | See M1 |
| Section 4.4 `readChannelToken` key map is byte-identical to `getChannelToken` | CONFIRMED | Both produce the same 5 strings in the same order |
| Section 7 `vi.mock` mock patterns and counts | CONFIRMED for 9/4/3/1; REFUTED for the `vi.doMock` outlier count | See M2 |
| Section 8 top-level (4) + web/ (14) = 18 importers | CONFIRMED total / REFUTED bucket attribution | See m1 |
| Section 8 `agents.ts:79-85` import span | REFUTED (off by 1) | See m2 |
| Section 8 `web/telegram.ts:30, :40` comment refs | CONFIRMED | Both lines are `// … (see channel-provider readChannelToken)` / `// … mirrors readChannelToken's teams branch` |

### `02-type-interface-analysis.md`

| Claim | Verified | Notes |
|---|---|---|
| §1 `ChannelProvider:11-23` interface fields/methods verbatim | CONFIRMED | 6 readonly + 5 methods, with per-call `(token, chatId, ...)` signatures per C1 |
| §1 `chatIdFormat: string` has zero production consumers | UNVERIFIED | Plan does not show the grep; see m4 |
| §1 `envKeys: string[]` is shallow-readonly (mutable array contents) | CONFIRMED | `readonly envKeys: string[]` |
| §2 `ChannelProviderType` 5-member union in declaration order | CONFIRMED | telegram / slack / discord / googlechat / teams |
| §3 cluster 1 vs cluster 2 grouping | CONFIRMED | Cluster 1 (telegram/slack/discord) all real transports; Cluster 2 (googlechat/teams) throw + hardcoded `{ok: true}` |
| §4 `SendOpts` / `SendResult` / `ValidateTokenResult` not in source | CONFIRMED for the first two (only `BridgeSendResult` exists in `web/federation/bridge.ts:43`); `ValidateTokenResult` is a planned addition | |
| §4 "Two production consumers destructure it" (`agents.ts:968`, `:1046`) | REFUTED (also `:1435`) | See m3 |
| §5.3 `channelStateDir` 14 production call sites | REFUTED | See M1 |
| §5.3 14 of 19 call sites pass `agentDir?` | REFUTED | See M1 |
| §5.4 `readChannelToken` second arg is filesystem path | CONFIRMED | `:533` signature `(provider, envFilePath: string)` |
| §5.4 key map byte-identical to `getChannelToken` | CONFIRMED | |
| §6 `withTestRunMarking` spread signature | CONFIRMED | `:490-498` verbatim |
| §7 6 `as` casts (all `await resp.json() as {…}`) at `:92, :159, :178, :201, :216, :299` | CONFIRMED | |
| §8 generic opportunity rejection | CONFIRMED | OE-6 cited correctly |
| §9 `ChannelEnv` constructor shape `(env: Record<string, string>, home = homedir())` | CONFIRMED | Corrected from the brief's `process.env` |
| §10 zero logger call sites | CONFIRMED | `grep -n "logger" src/channel-provider.ts` returns only `:5` |

### `03-class-boundaries.md`

| Claim | Verified | Notes |
|---|---|---|
| D1 `ChannelEnv` constructor takes `Record<string, string>` | CONFIRMED | |
| D1 4-helper migration table (which move / which stay) | CONFIRMED for `getChannelToken` (in) / `getChannelChatId` (in) / `channelStateDir` (static) / `readChannelToken` (static) | |
| D1 unified `TABLE` dispatch keys | CONFIRMED | 5 providers × 3 keys = 15 entries |
| D2 5 provider class signatures byte-stable | CONFIRMED | Per C1 |
| D2 `UnsupportedDirectSendProvider` dedup | CONFIRMED | googlechat/teams share 100% method bodies |
| D2 `GooglechatProvider` readonly fields | CONFIRMED (`:328` envKeys, `:330` chatIdFormat, `:329` stateDir, `:332` pluginId, `:334` pluginPaneId) | |
| D2 `TeamsProvider` readonly fields | CONFIRMED (`:368` envKeys, `:370` chatIdFormat, `:369` stateDir, `:365` pluginId, `:367` pluginPaneId) | |
| D2 `splitMessage: (text) => splitMessage(text)` for telegram at `:103` is identity forward | CONFIRMED | No limit arg → uses `format.ts:1`'s default 4096 |
| D3 `ChannelProviderRegistry.get(type)` preserves `(ChannelProviderType) -> ChannelProvider` | CONFIRMED | |
| D3 `list()` new method | CONFIRMED (additive only) | |
| D4 `withTestRunMarking` spread drops prototype methods on class instances | CONFIRMED | DR2 hazard correctly identified |
| D4 Form B (explicit-delegation function) preferred over Form A (class) | CONFIRMED | Documented rationale |
| D4 commit-order recommendation (D.4 before D.2) | CONFIRMED | DR2 mitigation #5 / Phase D.2 Risk level #1 |

### `04-generic-interfaces.md`

| Claim | Verified | Notes |
|---|---|---|
| §1 `Provider<TConfig>` rejection via OE-6 | CONFIRMED | |
| §2 `ChannelEnv<TEnv>` rejection via OE-6 | CONFIRMED | |
| §3(a) `ChannelEnv.TABLE` dispatch consolidation | CONFIRMED | |
| §3(b) `ValidateTokenResult` named interface | CONFIRMED as designed; "Two production consumers" → see m3 | |
| §3(c) `UnsupportedDirectSendProvider` non-generic | CONFIRMED | |

### `05-refactor-roadmap.md`

| Claim | Verified | Notes |
|---|---|---|
| Dependency arrow (D.4 → D.2 → D.1 → D.3 → D.5a/b/c/d → D.6) | CONFIRMED | |
| Phase D.1 risk level Low, single-commit rollback | CONFIRMED | |
| Phase D.2 risk level Medium, D.4 must precede in commit order | CONFIRMED | |
| Phase D.3 risk level Low | CONFIRMED | |
| Phase D.4 risk level Low (Form B) / Medium (Form A) | CONFIRMED | |
| Phase D.5 risk level High, 4 sub-phases | CONFIRMED | |
| D.5 migration row `channelStateDir` "14 call sites" | REFUTED | See M1 |
| D.5 mechanical gate grep | CONFIRMED | |
| Phase D.6 risk level Low, conditional on H.1 | CONFIRMED | DR6 correctly defers |
| Recommended commit order | CONFIRMED | |

### `06-risks-and-mitigations.md`

| Claim | Verified | Notes |
|---|---|---|
| DR1 per-call `(token, chatId)` preservation | CONFIRMED | All 25 method bodies (5 providers × 5 methods) take `token` as the first parameter; `sendMessage`/`sendPhoto` take `chatId` as the second |
| DR1 `review-correctness.md` C1 citation | CONFIRMED | |
| DR2 spread-on-class hazard | CONFIRMED | `:490-498` verbatim |
| DR2 commit-order constraint (D.4 before D.2) | CONFIRMED | |
| DR2 17 mocks + vi.doMock outlier enumeration | PARTIALLY CONFIRMED (mock patterns) / REFUTED (vi.doMock count — see M2) | |
| DR3 `vi.doMock` outlier count = 1 | REFUTED (actual = 2) | See M2 |
| DR3 enumerated mock sites list | REFUTED (missing `channel-health-monitor.test.ts:128`) | See M2 + m5 |
| DR4 `ChannelEnv` constructor takes `Record<string, string>` (NOT `process.env`) | CONFIRMED | Corrected from brief's `process.env` sketch |
| DR5 `validateToken` return shape slack `botName` can be `undefined` | CONFIRMED | `:218` `data.user \|\| data.bot_id` can be undefined |
| DR5 three consumers at `agents.ts:968, :1046, :1435` | CONFIRMED | (Other locations say "two" — see m3) |
| DR5 named `ValidateTokenResult` interface with `readonly` modifiers | CONFIRMED (safe upgrade; no caller assigns to the returned object's properties) | |
| DR6 `LoggerLike` adoption conditional on H.1 | CONFIRMED | HR4 correctly applied |
| DR6 forbid `log.child(...)` pattern | CONFIRMED | HR1 correctly applied |
| Cross-reference table (HR1-6 mapping to D) | CONFIRMED | All six HRs correctly assessed |

---

## Concrete fix list (must-resolve before implementation)

1. **M1.** Replace "14 production call sites" with **"~37 invocations
   across 32 distinct source lines"** in `00-summary.md` dependency
   table row 3, `01 §5.3`, `02 §5.3`, `05-refactor-roadmap.md` D.5
   migration targets row 3, `06-risks-and-mitigations.md` DR3 cross-ref.
   Add the per-file sub-table from M1's evidence section to `01 §5.3`
   for executor consumption.
2. **M2.** Update `vi.doMock` outlier count from 1 to 2 in
   `01 §7` and `06 DR3`. Add `channel-health-monitor.test.ts:128` to
   the DR3 enumerated mock sites list. Note that the second site
   stubs `getProvider`, not the statics, so the `channelStateDir`
   re-export mitigation is irrelevant for it — the D.5d `getProvider`
   removal is the affected surface.

## Concrete fix list (should-resolve, optional)

3. **m1.** Re-label `01 §8` to "2 top-level + 2 `channel-coordinator/`
   + 14 `web/` = 18" instead of "4 top-level + 14 web/ = 18". The
   per-file tables stay verbatim.
4. **m2.** Replace `src/web/routes/agents.ts:79-85` with `:78-85` in
   `01 §8`.
5. **m3.** Replace "Two production consumers" with "**Three**
   production consumers" in `02 §4` and `04 §3(b)`; add `:1435` to
   both enumerations. `06 DR5` is already correct.
6. **m4.** Run `grep -rn "chatIdFormat" src/ --include='*.ts' | grep
   -v __tests__` and update the §1 readonly-fields row for
   `chatIdFormat` with any production hits (or state "verified zero
   production readers" if the grep returns nothing).
7. **m5.** Resolved by M2.

## Net verdict

**PASS-WITH-EDITS.** The plan is structurally sound: the five provider
implementations are correctly enumerated (all 5 line refs verified),
the four helpers are correctly characterised (all 4 line refs
verified), the registry / decorator line refs are correct, the
`ChannelProvider` interface methods correctly take `(token, chatId, …)`
as per-call parameters per `review-correctness.md` C1 (the framework
critical finding C1 is fully addressed), the `ChannelEnv` constructor
parameter shape correctly takes `Record<string, string>` not
`process.env` per DR4 (correcting the brief's `process.env` confusion),
the `UnsupportedDirectSendProvider` dedup is real and well-argued, the
zero-logger-call-sites finding correctly decouples D from H.1 (the HR4
correction is correctly applied), and the framework's C3 (4 fictional
runner paths) and C5 (fabricated cycle) correctly do not re-appear in
D. The two major issues are call-site count drift in the migration
metadata — they affect the budget but not the design. None of the
framework's critical findings re-appear in D.

After applying the 2 must-resolve fixes (and optionally the 4
should-resolve ones), the plan is ready to implement. Without them,
an executor will:

- under-budget the D.5b `channelStateDir` removal blast radius by 2.5×
  (M1), missing ~23 call-site migrations and risking a half-migrated
  state;
- miss the second `vi.doMock` site at `channel-health-monitor.test.ts:128`
  (M2), which silently fails to stub `getProvider` post-D.5d because
  the test file is not in the D.5d migration list;
- mis-attribute the 18 production-importers count's bucket boundaries
  (m1), searching for a `src/`-top-level file that is actually in
  `src/channel-coordinator/`;
- start counting `agents.ts` imports from line 79 instead of 78 (m2),
  off-by-one but harmless;
- count `validateToken` consumers wrong (m3), missing `:1435` in the
  type-naming rationale and risking a downstream consumer that the
  reviewer didn't notice.

The plan's design — `ChannelEnv` class absorbing `getChannelToken` /
`getChannelChatId` with static helpers for `channelStateDir` /
`readChannelToken`, five stateless provider classes preserving the
per-call `(token, chatId, ...)` signatures per C1, a
`ChannelProviderRegistry` wrapping `markedProviders`, an
`UnsupportedDirectSendProvider` abstract base for googlechat/teams,
explicit-delegation `withTestRunMarking` rewrite (Form B), and D.6
conditional on H.1 — is correct.

### Confidence level

- **High** on the line-number claims for the 5 providers (`:53`,
  `:134`, `:243`, `:324`, `:364`), the 4 helpers (`:459`, `:467`,
  `:520`, `:533`), the registry / decorator (`:477`, `:490`, `:500`,
  `:508`, `:512`), and the `ChannelProvider:11-23` interface
  signatures (every claim verified by direct Read of the source).
- **High** on the C1 / C3 / C5 / OE-4 / OE-6 / OE-7 / HR1 / HR4
  cross-reference table (every claim verified by direct Read of the
  referenced review files and the source files).
- **High** on the `UnsupportedDirectSendProvider` dedup (verified
  googlechat + teams share 100% method bodies).
- **Medium** on the `channelStateDir` call-site count (verified by
  direct grep; the per-line breakdown is precise; the per-call-
  invocation total is approximate because ternary expressions contain
  multiple calls on the same line — exact count depends on whether
  ternaries are counted once-per-line or once-per-invocation).
- **Medium** on the `vi.doMock` outlier count (verified by direct grep
  — the 2 hits are exact; the DR3 enumeration list's "1 outlier" claim
  is wrong by 1).
- **Medium** on the `chatIdFormat` zero-production-readers claim
  (the plan does not show the grep; my verification is by inference
  from the analogous `pluginId` row, not by direct grep).
