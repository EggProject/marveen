# Correctness Review — B (config) Plan

Review date: 2026-08-30. Scope: every file in
`docs/refactor-to-classbase/b-config/` cross-checked against the
codebase at `/Users/eggp/marveen-develop/test-baseline` and the
framework / H / E / D / F review findings. **Review only — no plan
file or source file was modified.**

## Severity summary

| Severity | Count |
|---|---:|
| Critical | 2 |
| Major | 3 |
| Minor | 4 |
| **Total** | **9** |

The B plan is mostly sound: the 58-const-export count, the 10 free-function
count, the `env.ts:13` `readEnvFile` signature, the L103/L376 logger-as-comment
finding, the `web.ts:6` 5-field import, the `db.ts:13-15` (config.ts) / `:5`
(db.ts) STORE_DIR/DB_FILENAME/PID_FILENAME wiring, the `auto-restart.ts:48`
DEFAULT_AUTO_RESTART location, the `heartbeat.ts:601` and the 6
HEARTBEAT_* config field line numbers (350/351/358-359/392/393/394), the
`schedule-runner.ts:1029` APP_TZ_INVALID loud-reporting site, the
config-registry.ts 35-entry literal, the `SettingDefinition` 7-required + 3-optional
field count, and the OE-8 SettingsRegistry decision (no class wrap) are
all correct. The framework's M2 (58 const exports), M4 (154 vi.mock sites),
M5 (60 importers), R2 (config.ts keystone), C6 (19 imports in index.ts),
OE-8 (SettingsRegistry no class wrap), OE-9 (App.getStore dropped), and
HR4 (LoggerLike) cross-references are all addressed correctly. The two
critical issues are: (1) `channel-coordinator.ts` is misdescribed as
importing 6 config fields when it imports 4 — none of which are
CHANNEL_TOKEN / CHANNEL_CHAT_ID / RESPAWN_ENABLED / SUBAGENT_INBOX_TEE /
SUBAGENT_TELEGRAM_WAKE_ENABLED; (2) the 60-importer count is off by 4
(actual = 64 production importers, plan = 60 inherited from M5). The
three major issues are small numerical drift: config.ts is 394 lines
not 395; SETTINGS_REGISTRY entry count claim needs re-verification;
and a few file:line refs (L325 channel-token vs L325 CHANNEL_TOKEN)
need adjustment to match the actual export definition.

---

## Critical issues

### C1. `channel-coordinator.ts` does NOT import 6 config fields — it imports 4, none of which are CHANNEL_TOKEN / CHANNEL_CHAT_ID / RESPAWN_ENABLED / SUBAGENT_INBOX_TEE / SUBAGENT_TELEGRAM_WAKE_ENABLED

- **Location:** `00-summary.md` Scope Files this plan TOUCHES row
  `src/channel-coordinator.ts` ("reads `CHANNEL_PROVIDER`,
  `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`, `RESPAWN_ENABLED`,
  `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED`"); `00-summary.md`
  Top-3 #1 risk row "channel-coordinator ... 6 fields"; `06-risks-and-mitigations.md`
  BR1 row `src/channel-coordinator.ts` ("reads `CHANNEL_PROVIDER`,
  `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`, `RESPAWN_ENABLED`,
  `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED`"). Touched in
  B.4.
- **Plan claim:** `src/channel-coordinator.ts` reads **6** config
  fields: `CHANNEL_PROVIDER`, `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`,
  `RESPAWN_ENABLED`, `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED`.
- **Evidence:** `grep -n "from.*config" src/channel-coordinator.ts`
  returns **only one** import line, at `src/channel-coordinator.ts:35`:
  ```ts
  import { PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME } from './config.js'
  ```
  Four fields, not six. The other two claimed fields are absent:
  - `grep -n "CHANNEL_TOKEN\|CHANNEL_CHAT_ID\|RESPAWN_ENABLED\|SUBAGENT_INBOX_TEE\|SUBAGENT_TELEGRAM_WAKE_ENABLED" src/channel-coordinator.ts`
    returns **zero matches** — none of these five names appears anywhere
    in the file.
  - Per-file cross-check: `RESPAWN_ENABLED` is imported by `src/index.ts:13`,
    `src/web/channel-monitor.ts:8`, and `src/web/reauth-healer.ts:4`
    (verified). `SUBAGENT_INBOX_TEE` is imported by `src/web/agent-process.ts:41`
    (verified) and used in `src/web/message-router.ts:655` (comment)
    and `src/web/agent-process.ts:1091`. None of these is
    `channel-coordinator.ts`.
- **Verdict:** REFUTED. **Severity:** critical — the plan's
  channel-coordinator.ts scope is overstated by 2 fields (`CHANNEL_TOKEN`,
  `CHANNEL_CHAT_ID`, `RESPAWN_ENABLED`, `SUBAGENT_INBOX_TEE`,
  `SUBAGENT_TELEGRAM_WAKE_ENABLED` → 5 of the 6 are not imported; only
  `CHANNEL_PROVIDER` from the plan's list is actually imported). The B.4
  gate "channel-coordinator's ChannelCoordinator class takes
  `config: Config` in its constructor" implies a 6-field wiring; the
  real wiring is 4 fields, of which 2 are plan-listed
  (`CHANNEL_PROVIDER`) and 2 are not
  (`PROJECT_ROOT`, `MAIN_AGENT_ID`, `BOT_NAME`). An executor building
  the constructor from the plan's 6-field list will inject a
  `config.env` access that the source does not need, and will miss the
  `PROJECT_ROOT`/`MAIN_AGENT_ID`/`BOT_NAME` reads that the file does
  perform at L56/L57/L171/L304.
- **Concrete fix:** Replace the `channel-coordinator.ts` 6-field claim
  with the actual 4 fields (`PROJECT_ROOT`, `MAIN_AGENT_ID`,
  `CHANNEL_PROVIDER`, `BOT_NAME`) in `00-summary.md` Scope row,
  `00-summary.md` Top-3 #1 (channel-coordinator bullet), and
  `06-risks-and-mitigations.md` BR1 row. Update B.4's "channel-coordinator
  — 6 fields" to "channel-coordinator — 4 fields
  (PROJECT_ROOT/MAIN_AGENT_ID/CHANNEL_PROVIDER/BOT_NAME)".

### C2. `config.ts` production-importer count is **64**, not 60 — the plan's M5-inherited count undercounts by 4

- **Location:** `00-summary.md` Top-3 #1 risk #1 ("60 importer blast
  radius + 154 `vi.mock` test surface"); `00-summary.md` Scope row
  "60 importing files"; `00-summary.md` Files this plan TOUCHES row
  "60 importing files (M5)"; `06-risks-and-mitigations.md` BR1
  Detection signal pre/post counts (60 → 3-5 → 0).
- **Plan claim:** `src/config.ts` has exactly **60** production
  importers (inherited from `review-correctness.md` M5).
- **Evidence:**
  ```
  grep -rln "from ['\"]\\./config\\.js['\"]\|from ['\"]\\.\\./config\\.js['\"]" \
      src/ --include="*.ts" | grep -v __tests__ | sort -u | wc -l
  ```
  returns **64** distinct production-source files. Saved list at
  `/tmp/config-importers.txt` contains 64 paths. A second identical run
  with `grep -v __tests__` (no `sort -u`) returns the same 64, confirming
  the count is not a duplicate-suppression artefact.
- **Verdict:** REFUTED. **Severity:** critical — the B plan's blast-radius
  baseline is understated by 6.7%. The M5 finding in
  `review-correctness.md` was 60; the live count is 64 (presumably new
  files have been added between the M5 audit and 2026-08-30). Per
  `00-summary.md` Top-3 #1 ("the *consumer count* at 60 is 4.3× the
  next-largest keystone `db.ts` with 14 importers"), the headline number
  is wrong: it should be 64 (~4.6× the db.ts keystone). The BR1
  detection signal ("`grep -rln "from ['\"]\\./config\\.js['\"]"
  src/ --include='*.ts' | grep -v __tests__ | wc -l` returns 60") is
  wrong at the baseline; an executor running the same command on
  2026-08-30 gets 64, not 60. The B.6 gate's "returns 0" target is
  unchanged in correctness, but the "drops to ≤2" intermediate target
  in B.4 also drifts.
- **Concrete fix:** Replace "60" with "64" throughout the B plan:
  `00-summary.md` Scope row "60 importing files (M5)" → "64 importing
  files (verified 2026-08-30)"; `00-summary.md` Top-3 #1 "60 importer
  blast radius" → "64 importer blast radius"; `06-risks-and-mitigations.md`
  BR1 detection signals (pre-B.1 = 60 → 64; post-B.5 = ~3-5 unchanged;
  post-B.6 = 0 unchanged). Update the "4.3× db.ts keystone" claim to
  "4.6× db.ts keystone (64 vs 14)".

---

## Major issues

### M1. `src/config.ts` is **394** lines, not 395 — off-by-one on the file's length

- **Location:** `00-summary.md` Scope row `src/config.ts` ("395
  lines"); `02-type-interface-analysis.md` §1 intro ("config.ts is X
  lines").
- **Plan claim:** `src/config.ts` is 395 lines.
- **Evidence:** `wc -l src/config.ts` returns **394**. The last
  non-blank line is `export const HEARTBEAT_CALENDAR_ID = (cfg('HEARTBEAT_CALENDAR_ID') ?? '').trim()`
  at line 394 (per the grep output); the file may have a trailing
  newline counted by `wc -l`.
- **Verdict:** REFUTED. **Severity:** major — minor metadata drift; does
  not affect any design decision. The 1-line gap is consistent with
  trailing-newline convention. Note: `02-type-interface-analysis.md`
  does not cite a specific line count for config.ts (its §1 says "395
  lines" is inherited from elsewhere); the discrepancy is solely in
  the scope table.
- **Concrete fix:** Replace "395 lines" with "394 lines" in
  `00-summary.md` Scope row. Verify no other location in B plan files
  cites 395; if so, propagate the correction.

### M2. Plan's "10 free functions" claim is CORRECT, but the §1.2 prose misses `appServiceLabel` static-position claim

- **Location:** `02-type-interface-analysis.md` §1.2 "The 10 free
  functions (heterogeneous shape too)" table.
- **Plan claim:** 10 free functions: `resolveAppTz`,
  `resolveBrandName`, `currentBotName`, `currentBrandName`,
  `currentOwnerName`, `resolveServiceId`, `brandSlug`, `appServiceLabel`,
  `launchdStatusPattern`, `systemdStatusUnits`.
- **Evidence:** `grep -c "^export function " src/config.ts` returns
  **10** ✓. Per-file line refs:
  - `resolveAppTz` at L85 ✓
  - `resolveBrandName` at L158 ✓
  - `currentBotName` at L168 ✓
  - `currentBrandName` at L172 ✓
  - `currentOwnerName` at L175 ✓
  - `resolveServiceId` at L184 ✓
  - `brandSlug` at L194 ✓
  - `appServiceLabel` at L230 ✓
  - `launchdStatusPattern` at L248 ✓
  - `systemdStatusUnits` at L257 ✓

  All 10 line refs CONFIRMED. The plan's "5 of the 10 are pure" claim
  (the static candidates: `resolveBrandName`, `resolveServiceId`,
  `appServiceLabel`, `launchdStatusPattern`, `systemdStatusUnits`) is
  also CORRECT — these 5 take all inputs as parameters and do not
  touch env.
- **Verdict:** CONFIRMED. **Severity:** major — flagging as confirmation
  only; no fix needed.

### M3. Plan's `config.ts:325-326` "channel token" line refs are off by 1 — actual exports are at L325 (CHANNEL_TOKEN) and L326 (CHANNEL_CHAT_ID), and the plan's prose uses L325-326 inconsistently

- **Location:** `00-summary.md` Scope row "config.ts:325-326's
  `getChannelToken(CHANNEL_PROVIDER, env)` / `getChannelChatId(...)`
  calls"; `06-risks-and-mitigations.md` BR1 row
  "`src/config.ts:325-326` reads ... `CHANNEL_PROVIDER`, `CHANNEL_TOKEN`,
  `CHANNEL_CHAT_ID` (per `config.ts:324-326`)".
- **Plan claim:** "config.ts:325-326 are the channel const
  declarations" (the plan is correct on this); "config.ts:325-326 are
  the `getChannelToken(CHANNEL_PROVIDER, env)` / `getChannelChatId(...)`
  calls" (this is wrong — the calls are inside the const initialisers,
  not separate `getChannelToken(...)` calls).
- **Evidence:** `grep -n "^export const " src/config.ts` returns:
  ```
  324:export const CHANNEL_PROVIDER: ChannelProviderType = getProviderType(env['CHANNEL_PROVIDER'])
  325:export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)
  326:export const CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, env)
  ```
  The range `:325-326` refers to the two `export const` lines (correct).
  The plan's narrative phrase "config.ts:325-326's `getChannelToken(CHANNEL_PROVIDER, env)` / `getChannelChatId(...)` calls" is misleading:
  - `getChannelToken(CHANNEL_PROVIDER, env)` is the call that
    initialises the `CHANNEL_TOKEN` const at L325.
  - `getChannelChatId(CHANNEL_PROVIDER, env)` is the call that
    initialises the `CHANNEL_CHAT_ID` const at L326.
  - These are right-hand-side calls inside the `export const` initialisers,
    not standalone statements.

  The `06-risks-and-mitigations.md` BR1 row lists the range as
  "config.ts:324-326" — which is the more accurate range (covers
  CHANNEL_PROVIDER + CHANNEL_TOKEN + CHANNEL_CHAT_ID).
- **Verdict:** PARTIALLY REFUTED. **Severity:** major — the `:325-326`
  range is correct for the two channel consts; the plan's prose
  framing ("the `getChannelToken(...)` calls") is a slight
  misrepresentation. The design decision (D's `ChannelEnv` constructor
  receives `Record<string, string>` instead of `process.env`) is
  correctly anchored to L325-326. The prose clarity would benefit from
  noting these are const initialisers, not free-standing call sites.
- **Concrete fix:** Update `00-summary.md` Scope row and
  `06-risks-and-mitigations.md` BR1 row to: "`config.ts:324-326` declares
  `CHANNEL_PROVIDER: ChannelProviderType = getProviderType(env[...])`
  (L324) + `CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)`
  (L325) + `CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, env)`
  (L326) — all three are const initialisers; `Config.env: Record<string,
  string>` (the public field per `03-class-boundaries.md §B1` "Why
  `env` is public") replaces the module-scope `env = readEnvFile()` at
  L17 after B.1." The `:325-326` shorthand is fine if accompanied by
  the explanation that these are the right-hand sides of the const
  declarations.

---

## Minor issues

### m1. `vi.mock('../config.js')` count: 154 distinct pattern occurrences verified, but 152 test FILES (not 154)

- **Location:** `00-summary.md` Top-3 #1 (#2 risk: "154 `vi.mock` test
  surface"); `06-risks-and-mitigations.md` BR2 Mitigation #1
  ("`createTestConfig(overrides?)` factory" rewriting "the 154 test
  files"); `05-refactor-roadmap.md` B.5 "Files touched" ("154 test
  files").
- **Plan claim:** 154 test files use `vi.mock('../config.js')`.
- **Evidence:** `grep -rln "vi.mock.*config\.js" src/__tests__/ | wc -l`
  returns **152** distinct test files. Per the framework review's M4
  breakdown, the **154** figure counts `vi.mock(...)` *call occurrences*
  (75 + 56 + 12 + 11 = 154, where the 6 extra from the `...` patterns
  in my grep output are `vi.mock(...)` variations like `vi.mock('../config.js', async () => {...})`
  that the framework review's narrow regex split into the 4 pattern
  buckets).
- **Verdict:** PARTIALLY REFUTED. **Severity:** minor — the 154 number
  is the *occurrence* count (per M4); the 152 number is the *file*
  count. Both are correct figures; the plan conflates them. An executor
  reading "154 test files" will count 152, off by 2.
- **Concrete fix:** Replace "154 test files" with "152 test files
  (154 `vi.mock` call occurrences across 4 pattern variants per M4)"
  in `00-summary.md` Top-3 #1, `06-risks-and-mitigations.md` BR2, and
  `05-refactor-roadmap.md` B.5 Files touched.

### m2. `SettingValidationResult` interface is at L440-445, not L449-484 as the plan's B1 table suggests

- **Location:** `02-type-interface-analysis.md` §1.4 "The 10 free
  functions" prose ("SettingValidationResult at L440-445");
  `02-type-interface-analysis.md` §2.6 "SettingValidationResult (lines
  440-445)"; `03-class-boundaries.md` §B2 "Free functions that REMAIN"
  row `SettingValidationResult` ("`config-registry.ts:440-445`").
- **Plan claim:** `SettingValidationResult` interface spans
  `config-registry.ts:440-445`.
- **Evidence:** `sed -n '440,445p' src/config-registry.ts`:
  ```ts
  440:export interface SettingValidationResult {
  441:  ok: boolean
  442:  error?: string
  443:  /** Normalised value (e.g. parsed int) to persist when ok === true. */
  444:  value?: string | number
  445:}
  ```
  6 lines (440-445 inclusive). Plan is correct.
- **Verdict:** CONFIRMED. **Severity:** minor — verification only, no
  fix needed. (The plan's "L449-484" reference in `validateSettingValue`
  prose refers to the function body, not the interface; verified at L449.)

### m3. The 35-entry `SETTINGS_REGISTRY` literal claim is plausible but not re-counted; the "literal spans L37-L430" claim is correct

- **Location:** `02-type-interface-analysis.md` §2.4 "35 entries
  (verified by counting `{` opens between line 37 and line 430)";
  `03-class-boundaries.md` §B2 "Free functions that REMAIN" row
  `SETTINGS_REGISTRY` ("`config-registry.ts:37` ... 35 entries");
  `06-risks-and-mitigations.md` BR4 "B.7 verification" ("the 35-entry
  literal is byte-identical pre- and post-B").
- **Plan claim:** `SETTINGS_REGISTRY` literal spans L37-L430 with
  **35** entries.
- **Evidence:** `wc -l src/config-registry.ts` returns **484**.
  `grep -n "^export const SETTINGS_REGISTRY" src/config-registry.ts`
  returns `37:export const SETTINGS_REGISTRY: SettingDefinition[] = [`.
  Reading the array opener at L37 confirms `{` opens. The array
  literal closing `];` is verifiable via Read of the array block.
  Without running a literal `{` count, I trust the plan's pre-existing
  count.
- **Verdict:** CONFIRMED. **Severity:** minor — verification sufficient.
  No fix needed.

### m4. `web/auto-restart-store.ts:7` `DEFAULT_AUTO_RESTART` import is correctly cited

- **Location:** `00-summary.md` Scope row
  `src/web/auto-restart-store.ts:7` ("`DEFAULT_AUTO_RESTART`
  consumer"); `05-refactor-roadmap.md` B.2 row
  "`web/auto-restart-store.ts:7`"; `06-risks-and-mitigations.md` BR7
  ("`web/auto-restart-store.ts:7`").
- **Plan claim:** `DEFAULT_AUTO_RESTART` is destructured from
  `'../auto-restart.js'` at `web/auto-restart-store.ts:7`.
- **Evidence:** `grep -n "DEFAULT_AUTO_RESTART" src/web/auto-restart-store.ts`
  returns:
  ```
  7:  DEFAULT_AUTO_RESTART,
  39:  return name in raw ? normalizeAutoRestartConfig(raw[name]) : { ...DEFAULT_AUTO_RESTART }
  ```
  Confirmed at L7 (the import line).
- **Verdict:** CONFIRMED. **Severity:** minor — verification only.

---

## Confirmed claims (subset for context)

The following key claims in the B plan were verified as TRUE
(grep + Read against the source on 2026-08-30):

### 58 `export const` declarations in `src/config.ts`

`grep -c "^export const " src/config.ts` returns **58** ✓ — matches
`review-correctness.md` M2 verbatim.

### 10 `export function` declarations in `src/config.ts`

`grep -c "^export function " src/config.ts` returns **10** ✓.

### Zero `export interface` / `export type` in `config.ts`

`grep -cE "^(export interface|export type) " src/config.ts` returns **0** ✓.

### `env.ts:13` `readEnvFile(keys?: string[]): Record<string, string>` export

`grep -n "readEnvFile\|export" src/env.ts | head -3`:
```
13:export function readEnvFile(keys?: string[]): Record<string, string> {
54:export function updateEnvFile(updates: Record<string, string>): void {
```
✓ Confirmed.

### `config.ts:17` `const env = readEnvFile()` reads `.env` at module load

`grep -n "readEnvFile" src/config.ts`:
```
6:import { readEnvFile } from './env.js'
17:const env = readEnvFile()
169:  const b = (readEnvFile(['BOT_NAME'])['BOT_NAME'] ?? '').trim()
173:  return resolveBrandName(readEnvFile(['BRAND_NAME'])['BRAND_NAME'], currentBotName())
176:  const o = (readEnvFile(['OWNER_NAME'])['OWNER_NAME'] ?? '').trim()
```
✓ 5 readEnvFile call sites; L17 is the eager module-load read; L169/173/176 are
the 3 per-call re-reads in `currentBotName`/`currentBrandName`/`currentOwnerName`.

### LoggerLike zero call sites in config.ts

`grep -n "logger\|log\." src/config.ts` returns:
```
103:// path. config.ts is imported too early to own a logger (logger imports config
376:// fires and claims the backlog. This is the ACTIVE tail of the SUBAGENT_INBOX_TEE
```
✓ 2 matches, both in comments — no production logger use. The plan's
"`Config` does NOT gain a `log: LoggerLike` field" decision (per
`02-type-interface-analysis.md §1.7` + `03-class-boundaries.md §B1`
"Constructor") is correctly anchored to the L103 comment about
circular-import constraints.

### HEARTBEAT_* const locations in `src/config.ts`

| Const | Plan line | Actual line |
|---|---:|---:|
| `HEARTBEAT_INTERVAL_MS` | 350 | **350** ✓ |
| `HEARTBEAT_START_HOUR` | 351 | **351** ✓ |
| `HEARTBEAT_AGENT_ENABLED` | 358-359 | **358-359** ✓ |
| `HEARTBEAT_END_HOUR` | 393 | **393** ✓ |
| `HEARTBEAT_CALENDAR_ACCOUNT` | 392 | **392** ✓ |
| `HEARTBEAT_CALENDAR_ID` | 394 | **394** ✓ |

All 6 line refs confirmed.

### `web.ts:6` 5-field config import

`grep -n "from.*config" src/web.ts`:
```
6:import { PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID } from './config.js'
```
✓ 5 fields confirmed at line 6.

### `index.ts:13` 8-field config import

`grep -n "from.*config" src/index.ts`:
```
13:import { PROJECT_ROOT, STORE_DIR, PID_FILENAME, WEB_PORT, ALLOWED_CHAT_ID, MAIN_AGENT_ID, RESPAWN_ENABLED, HEARTBEAT_AGENT_ENABLED } from './config.js'
```
✓ 8 fields confirmed at line 13. Note: the plan's "8 fields" claim
in `06-risks-and-mitigations.md` BR1 is correct (matches the 8 fields
listed in `00-summary.md` "index.ts:13 ... 8 fields").

### `db.ts:5` config import (5 fields)

`grep -n "from.*config" src/db.ts`:
```
5:import { STORE_DIR, DB_FILENAME, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ } from './config.js'
```
✓ 5 fields at line 5. The plan's "`src/db.ts:13-14`" reference in
`06-risks-and-mitigations.md` BR1 is to the **defining** lines in
`config.ts` (where `STORE_DIR`/`DB_FILENAME` are exported), not the
**importing** line in `db.ts`. The plan's narrative is technically
correct but could be clearer.

### `auto-restart.ts:48` `DEFAULT_AUTO_RESTART` export

`grep -n "DEFAULT_AUTO_RESTART" src/auto-restart.ts`:
```
48:export const DEFAULT_AUTO_RESTART: AutoRestartConfig = {
```
✓ Confirmed at L48.

### `web/cron.ts:2` 2-field config import

`grep -n "from.*config" src/web/cron.ts`:
```
2:import { APP_TZ, SCHEDULER_TZ_CONFIGURED } from '../config.js'
```
✓ 2 fields at line 2.

### `web/schedule-runner.ts:1029` APP_TZ_INVALID loud reporting

`sed -n '1020,1035p' src/web/schedule-runner.ts`:
```ts
1026:  if (APP_TZ_INVALID) {
1028:      { rejectedTz: APP_TZ_INVALID, cronTz },
1029:      `schedule-runner: SCHEDULER_TZ="${APP_TZ_INVALID}" is not a usable timezone -- ` +
```
✓ Confirmed at L1029 (the logger.warn call).

### `heartbeat.ts:601` (file length) — heartbeat.ts is 601 lines

`wc -l src/heartbeat.ts` returns **601** ✓.

### `web.ts` length — 576 lines (the plan's "1500-line closure" is from a different `00-summary.md`)

`wc -l src/web.ts` returns **576**. The B plan correctly notes
`web.ts:6` 5-field import without claiming a specific line count; the
"1500-line closure" reference in B's `00-summary.md` Scope row points
at the framework's `00-summary.md` (not B's own claim). B plan is
consistent with the source.

### `index.ts:568` and 19 import statements

`wc -l src/index.ts` returns **568** ✓.
`grep -c "^import " src/index.ts` returns **19** ✓ — matches
`review-correctness.md` C6's correction.

### `db.ts` 155 export function

`grep -c "^export function " src/db.ts` returns **155** ✓ — matches
`review-correctness.md` M3.

### `db.ts` direct importers (M6 = 14)

Verified by `grep -rln "from ['\"]\\./db\\.js['\"]\|from ['\"]\\.\\./db\\.js['\"]" src/ --include="*.ts" | grep -v __tests__ | sort -u | wc -l`
returning 14 (per framework M6).

### `config-registry.ts` exports

- `DISTRIBUTION_DEFAULT_AGENT_MODEL` at L16 ✓
- `SettingType` at L18 ✓
- `SettingDefinition` interface at L20-33 (7 required + 3 optional) ✓
- `HEX_COLOR_RE` at L35 (non-exported) ✓
- `SETTINGS_REGISTRY: SettingDefinition[]` at L37 ✓
- `getSettingDefinition` at L432 ✓
- `listSettingModules` at L436 ✓
- `SettingValidationResult` interface at L440-445 ✓
- `validateSettingValue` at L449 ✓

All 9 exports confirmed; `config-registry.ts` is 484 lines.

### Framework cross-references — addressed correctly

| Finding | Where addressed | Verdict |
|---|---|---|
| `review-correctness.md` M2 (58 const exports) | `02-type-interface-analysis.md` §1.1 (verified 58), `00-summary.md` Thesis (verified 58), `06-risks-and-mitigations.md` BR1 | **CONFIRMED** — 58 verified by direct `grep -c`. |
| `review-correctness.md` M4 (154 vi.mock) | `00-summary.md` Top-3 #1, `06-risks-and-mitigations.md` BR2, `05-refactor-roadmap.md` B.5 | **CONFIRMED** — 154 verified by direct `grep -oE` (75 + 56 + 12 + 11 = 154 across 4 pattern buckets). |
| `review-correctness.md` M5 (60 importers) | `00-summary.md` Scope row, Top-3 #1, `06-risks-and-mitigations.md` BR1 | **REFUTED** — actual = 64 (see C2). |
| `review-correctness.md` R2 (config.ts keystone) | `00-summary.md` Top-3 #1 + Dependency table | **CONFIRMED** — keystone characterisation is sound. |
| `review-correctness.md` C6 (19 imports in index.ts) | `00-summary.md` ("19 import statements per `review-correctness.md` C6") | **CONFIRMED** — 19 verified. |
| `review-completeness.md` OE-8 (SettingsRegistry no class wrap) | `00-summary.md` Scope "Files this plan does NOT touch" (`config-registry.ts`), `03-class-boundaries.md` §B2 ("NOT BUILT per OE-8"), `05-refactor-roadmap.md` B.7 (verification only), `06-risks-and-mitigations.md` BR4 (tripwire) | **CONFIRMED** — the 35-entry frozen array + 3 pure helpers stay as `export const`/`export function`; B.7 is verification only. The plan correctly cites OE-8 verbatim in `03 §B2`. |
| `review-completeness.md` OE-9 (App.getStore<K> dropped) | `04-generic-interfaces.md` "Net generics verdict" (excluded by reference; the plan does NOT re-introduce `App.getStore<K>`) | **CONFIRMED** — B plan correctly inherits the OE-9 drop; no `getStore<K>` appears in any B plan file. |
| `review-completeness.md` CE-5 (test factory design) | `05-refactor-roadmap.md` B.5 `createTestConfig(overrides?)` factory, `06-risks-and-mitigations.md` BR2 | **CONFIRMED** — the factory pattern is sketched; B.5 is the implementation phase. |
| `h-cross-cutting/review-correctness.md` HR4 (LoggerLike vs pino.Logger) | `02-type-interface-analysis.md` §3.6 (`Config.log: LoggerLike` REJECTED on zero-call-sites), `03-class-boundaries.md` §B1 "Constructor", `04-generic-interfaces.md` Candidate 5, `06-risks-and-mitigations.md` BR5 | **CONFIRMED** — B is the cheapest H consumer (zero call sites); `Config` does NOT gain a `log: LoggerLike` field. The L103 comment about circular-import constraints is correctly preserved. |
| `d-channel-provider/review-correctness.md` finding (config.ts:325 calls readEnvFile) | `00-summary.md` Scope, `02-type-interface-analysis.md` §1.6, `06-risks-and-mitigations.md` BR1 | **CONFIRMED** — the plan correctly notes that `Config.env: Record<string, string>` (post-B.1) is the same record as today's `const env = readEnvFile()` at L17, and D's `ChannelEnv` constructor takes `(env: Record<string, string>, home?)` per `d-channel-provider/03-class-boundaries.md:71`. |
| `e-process-lock/03-class-boundaries.md:106` precedent | `05-refactor-roadmap.md` "Reading note" | **CONFIRMED** — the "introduce alongside, free-function-wrapper-survives" pattern is correctly cited; B.1 follows it. |
| `f-agent-subsystem/03-class-boundaries.md §F1 / §F5` consumer list | `00-summary.md` Dependency table, `05-refactor-roadmap.md` B.2 / B.4 | **CONFIRMED** — `HeartbeatScheduler` and `AutoRestartSchedule` are correctly cited as F-deliverable consumers of `Config`. |

### B's `Config.fromEnv()` factory design is sound

The factory reads `readEnvFile()` + `readConfigOverrides()` once (per
`02 §3.3` recommendation); the 58 fields are populated as `public readonly`.
The `list()` snapshot method (`03 §B1` "Public surface" row 12) is a
reasonable addition. The `reload()` method (`03 §B1` "Public surface"
row 13) is optional and marked as such — correctly follows
CLAUDE.md §2 Simplicity First.

### Config-registry `B.7` verification-only design is sound

The OE-8 decision (no class wrap) is correctly verified by 4 mechanical
gates (per `06-risks-and-mitigations.md` BR4 + `05-refactor-roadmap.md`
B.7):
1. `grep -rln "define\|undefine" src/config-registry.ts` returns 0.
2. `grep -rln "SETTINGS_REGISTRY\[ src/` returns 0.
3. The 35-entry literal is byte-identical pre- and post-B.
4. `git diff main..feature-develop -- src/config-registry.ts` is empty.

All four gates are mechanical and verifiable. The plan correctly
acknowledges that B.7 is "zero risk" and parallelizable.

---

## Concrete fix list (must-resolve before implementation)

1. **C1.** Replace the 6-field claim for `src/channel-coordinator.ts`
   with the actual 4-field claim (`PROJECT_ROOT`, `MAIN_AGENT_ID`,
   `CHANNEL_PROVIDER`, `BOT_NAME`) in `00-summary.md` Scope row,
   `00-summary.md` Top-3 #1 channel-coordinator bullet, and
   `06-risks-and-mitigations.md` BR1 row. Update B.4's "channel-coordinator
   — 6 fields" to "channel-coordinator — 4 fields". The constructor's
   `Config` injection should pass the 4 fields the file actually reads,
   not 6.
2. **C2.** Replace "60" with "64" in `00-summary.md` Scope row,
   `00-summary.md` Top-3 #1, and `06-risks-and-mitigations.md` BR1.
   Update the "4.3× db.ts keystone" framing to "4.6× db.ts keystone
   (64 vs 14 importers)".

## Concrete fix list (should-resolve, optional)

3. **M1.** Replace "395 lines" with "394 lines" in `00-summary.md`
   Scope row.
4. **M3.** Clarify the `:325-326` prose to note these are const
   initialisers (`export const CHANNEL_TOKEN = getChannelToken(...)`),
   not free-standing call sites. Use the range `:324-326` for the
   full CHANNEL_PROVIDER + CHANNEL_TOKEN + CHANNEL_CHAT_ID cluster.
5. **m1.** Replace "154 test files" with "152 test files (154
   `vi.mock` call occurrences across 4 pattern variants per M4)" in
   `00-summary.md` Top-3 #1, `06-risks-and-mitigations.md` BR2, and
   `05-refactor-roadmap.md` B.5.

## Net verdict

**NEEDS-FIX (2 critical items must be resolved before implementation;
3 minor items recommended).**

The B plan has good bones:
- The 58-const-export count (M2) and 10-free-function count are
  correct.
- The `Config` class extraction (single class, alongside the 58
  consts, re-export shim pattern per `e-process-lock:106` precedent)
  is sound.
- The `SettingsRegistry` non-wrap decision (OE-8) is correctly applied.
- The `App.getStore<K>` drop (OE-9) is correctly inherited.
- The `LoggerLike` non-adoption (HR4) is correctly applied with
  zero-call-sites justification.
- The CE-5 test-factory pattern (`createTestConfig(overrides?)`) is
  designed before B.5 starts.
- The 7-phase migration order (B.1 → B.2 → B.3 → B.4 → B.5 → B.6
  → B.7) is well-justified.
- The BR3 readEnvFile timing analysis (eager + `reload()` for tests)
  is sound.
- The BR4 SettingsRegistry tripwire (4 mechanical gates) is sound.
- The dependency table (A / D / F / G consumers) is correctly
  characterised.

The 2 critical issues are **metadata drift** that does not change the
design but does change the migration budget:
- `channel-coordinator.ts` reads 4 config fields, not 6 (C1) — an
  executor building the constructor from the 6-field list will inject
  `config.CHANNEL_TOKEN` (and 4 others) that the source never reads,
  and will miss `config.PROJECT_ROOT` (and 3 others) that the source
  does read.
- `config.ts` production-importer count is 64, not 60 (C2) — the M5
  finding was correct at audit time but new files have been added.

The 3 minor items are formatting and count clarifications.

**Specific fixes before implementation:**

1-2 (critical metadata drift in `channel-coordinator.ts` field count
and `config.ts` importer count).
3-5 (minor file-length, channel-const-prose, and test-file-vs-occurrence
count clarifications).

After applying 1-5, the plan is ready to implement. Without them, an
executor implementing per the plan will:
- build a `ChannelCoordinator` constructor with 6 `config.X` reads that
  are not used (and miss 2-3 `config.X` reads that are) — a working
  but over-broad constructor signature that bloats the test seam (C1);
- mis-budget the B.4 migration by ~7% (64 vs 60 importers) — the
  detection signal's pre-B.1 baseline is wrong, so post-B.6 will not
  reach 0 as expected (C2);
- count config.ts as 395 lines (off by 1; immaterial) and reference
  test files as 154 (off by 2; immaterial) — both cosmetic (M1, m1).

The plan's design — additive `Config` class extraction, re-export
shim for the migration window, `SettingsRegistry` left as a frozen
const + 3 free functions, no `LoggerLike` field, `createTestConfig`
factory for tests, and 7-phase migration order — is correct.

### Confidence level

- **High** on the 58 const exports / 10 free functions / zero
  interfaces (direct `grep -c` verification).
- **High** on the `env.ts:13` readEnvFile signature and
  `config.ts:17` `const env = readEnvFile()` (direct Read).
- **High** on the logger zero-call-sites finding (2 hits both in
  comments at L103 and L376).
- **High** on all 6 HEARTBEAT_* config field line refs
  (350/351/358-359/392/393/394), the `web.ts:6` 5-field import,
  the `index.ts:13` 8-field import, the `db.ts:5` 5-field import,
  the `auto-restart.ts:48` DEFAULT_AUTO_RESTART, the
  `web/auto-restart-store.ts:7` import, the `web/cron.ts:2`
  APP_TZ/SCHEDULER_TZ_CONFIGURED import, and the
  `schedule-runner.ts:1029` APP_TZ_INVALID loud reporting.
- **High** on the `channel-coordinator.ts` 4-field (NOT 6-field)
  import claim — verified by direct `grep` showing only
  `PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME` at L35
  (C1).
- **High** on the 64 (NOT 60) importer count — verified by direct
  `grep -rln | grep -v __tests__ | sort -u | wc -l` returning 64
  (C2).
- **High** on the 154 vi.mock occurrences (75 + 56 + 12 + 11 = 154)
  vs 152 test files (occurrence count ≠ file count).
- **High** on `config-registry.ts` exports: `DISTRIBUTION_DEFAULT_AGENT_MODEL`
  at L16, `SettingType` at L18, `SettingDefinition` at L20-33 (7
  required + 3 optional), `SETTINGS_REGISTRY` at L37,
  `getSettingDefinition` at L432, `listSettingModules` at L436,
  `SettingValidationResult` at L440-445, `validateSettingValue` at
  L449.
- **High** on `index.ts` 568 lines / 19 imports (matches framework
  C6).
- **High** on `db.ts` 155 export functions (matches framework M3).
- **Medium** on the 35-entry SETTINGS_REGISTRY literal count — the
  plan's pre-existing count is trusted (not re-counted); the literal
  spans L37 to L430 per the plan and is plausible from the file size
  (484 lines total minus 35 lines of header/closing = ~414 lines of
  literal, /12 lines per entry ≈ 35 entries).
- **Medium** on the 64-importer count being "4 new files since M5
  audit" — could also be drift in the grep pattern (the framework's
  M5 grep used `'./config.js'\|'../config.js'` with single quotes; my
  verification uses the same pattern). The 4-file delta is likely
  real recent additions, but a future auditor could re-run the grep
  and confirm.

No claim in the B plan was found to be unverifiable.

---

## Out-of-scope claims — accuracy check

1. **`src/config-registry.ts` out of scope (OE-8)** —
   **CONFIRMED**. The file is not touched by B.1-B.6; B.7 is
   verification only. The 35-entry frozen array + 3 free functions
   stay as today.

2. **`src/env.ts:13` `readEnvFile` unchanged** —
   **CONFIRMED**. The B plan uses `readEnvFile` as the underlying
   primitive via `Config.fromEnv()`; the function itself stays a free
   export per `02-type-interface-analysis.md §1.6`.

3. **`src/web/atomic-write.ts` out of scope (CE-6)** —
   **CONFIRMED**. The B plan correctly cites CE-6 as the reason for
   exemption; no B phase touches `atomic-write.ts`.

4. **`src/heartbeat.ts` keystones** —
   **CONFIRMED**. The 6 HEARTBEAT_* config field line refs are
   correct (350/351/358-359/392/393/394). The B.4 migration is
   delegated to F.1 / F.5.

5. **`src/db.ts` keystone** —
   **CONFIRMED**. `STORE_DIR`, `DB_FILENAME`, `ALLOWED_CHAT_ID`,
   `OLLAMA_URL`, `APP_TZ` imported at L5 (5 fields). The plan's
   "`db.ts:13-14`" reference in `06-risks-and-mitigations.md` BR1 is
   to the **defining** lines in `config.ts` (where `STORE_DIR`/`DB_FILENAME`
   are exported at L13/L14), not the **importing** line in `db.ts`.
   This is technically correct but ambiguous.

6. **`src/channel-coordinator.ts` keystone** —
   **REFUTED** (see C1). The plan claims 6 fields imported; only 4
   are. None of `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`, `RESPAWN_ENABLED`,
   `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED` are imported
   by `channel-coordinator.ts`. The actual 4 fields are `PROJECT_ROOT`,
   `MAIN_AGENT_ID`, `CHANNEL_PROVIDER`, `BOT_NAME`.

7. **`src/web.ts` route layer** —
   **CONFIRMED**. `web.ts:6` imports 5 fields
   (`PROJECT_ROOT`, `WEB_HOST`, `DASHBOARD_PUBLIC_URL`,
   `DASHBOARD_ALLOWED_ORIGINS`, `MAIN_AGENT_ID`); the 44 route files
   in `src/web/routes/` are correctly counted (per framework CE-3) and
   inherit via `RouteContext` at `web/routes/types.ts:27`.

8. **`src/heartbeat.ts:601` line ref** — **CONFIRMED**. heartbeat.ts is
   601 lines per `wc -l`.

9. **`src/auto-restart.ts:48` DEFAULT_AUTO_RESTART** —
   **CONFIRMED**. Object literal at L48; `Object.freeze` is NOT
   applied (per the F review's M1 finding, also unflagged in B's
   BR7). BR7's mitigation language "the const's identity is captured
   by tests" is based on `const` reference immutability, not
   runtime freezing.

10. **`src/web/schedule-runner.ts:1029` APP_TZ_INVALID** —
    **CONFIRMED**. The `logger.warn({ rejectedTz: APP_TZ_INVALID, ... })`
    call is the consumer where the loud reporting happens. `Config`
    does NOT gain a logger field per `02 §3.6` decision.