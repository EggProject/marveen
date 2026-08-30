# B (config) — Module state analysis

Date: 2026-08-30. Scope: `src/config.ts` (394 lines) and
`src/config-registry.ts` (484 lines). Verified against `src/` on the
same date by direct `Read` + `grep`. Cross-references:
`b-config/02-type-interface-analysis.md` (B-B's type audit),
`b-config/review-correctness.md` (B-RC's findings C1/C2/m1/M3), and the
framework `review-correctness.md` (M2 / M4 / M5 / R2) plus
`review-completeness.md` (OE-8 / OE-9). Planning only — no source files
were modified.

---

## Brief summary

The B subsystem is the **type-cleanest** and **largest-blast-radius**
file pair in `src/`: `config.ts` carries **58 frozen `export const`
declarations** + **10 free functions** + zero `export interface` /
`export type` declarations; `config-registry.ts` carries **2 `const` + 3
free functions + 1 type alias + 2 interfaces**, all with a **35-entry
frozen** `SETTINGS_REGISTRY` array. State at module level is **zero**
(no `let` bindings in either file — verified by
`grep -nE "^let " src/config.ts` returns nothing, and the same grep on
`config-registry.ts`). Side effects are minimal: one eager `readEnvFile()`
at `config.ts:17` (the module-load baseline) plus three per-call re-reads
at `config.ts:169` / `173` / `176` (the `currentBotName` /
`currentBrandName` / `currentOwnerName` helpers that capture wizard
renames without a process restart). The **structural lockout** of B is
the circular-import constraint (`logger.ts` → `config.ts`, not the
reverse, per the comment at `config.ts:103`), which keeps B at zero
`LoggerLike` call sites today and excludes `log: LoggerLike` from a
future `Config` class field. The **64 production importers** (verified
2026-08-30, the B-RC C2 correction from M5's audit-time count of 60)
combined with **154 `vi.mock('../config.js')` occurrences** across **152
distinct test files** make B the dominant test-rewrite cost in the
classbase refactor — by a factor of ~4.6× the next-largest keystone
(`db.ts` at 14 importers).

---

## 1. `config.ts` inventory

### 1.1 Export shape (verified 2026-08-30)

`grep -c "^export const " src/config.ts` = **58** (matches review-correctness
M2). `grep -c "^export function " src/config.ts` = **10**.
`grep -cE "^(export interface|export type) " src/config.ts` = **0**.

**Total `^(export …)` lines = 68** (58 const + 10 function + 0 interface +
0 type). The file is **values-only** — there are no project-local
interfaces or type aliases to bind a class to. All structural types
config *uses* come from elsewhere: `ChannelProviderType` from
`channel-provider.ts:9` (type-only import at `config.ts:8`).

### 1.2 The 58 `const` exports — heterogeneity

B-B's `02-type-interface-analysis.md §1.1` verified shape — confirmed
here by Read of the full file (394 lines):

| TS runtime type | Count | Examples |
|---|---:|---|
| `string` | ~38 | `TELEGRAM_BOT_TOKEN` (L116), `KANBAN_WIP_OK_COLOR` (L289), `OLLAMA_URL` (L302), `MAIN_AGENT_ID` (L208), `BRAND_NAME` (L151), `DASHBOARD_PUBLIC_URL` (L295), `APP_TZ` (L101), `SERVICE_ID` (L217), `HEARTBEAT_CALENDAR_ACCOUNT` (L392), `CHANNEL_TOKEN` (L325), `WEB_HOST` (L263), etc. |
| `number` | 13 | `WEB_PORT` (L261, parseInt), `KANBAN_AGING_WARN_H` (L267), `KANBAN_WIP_PLANNED` (L281), `KANBAN_WIP_WARN_PCT` (L287), `HEARTBEAT_INTERVAL_MS` (L350, `60 * 60 * 1000`), `HEARTBEAT_START_HOUR` (L351), `HEARTBEAT_END_HOUR` (L393), etc. |
| `boolean` | 4 | `RESPAWN_ENABLED` (L340), `HEARTBEAT_AGENT_ENABLED` (L358), `SUBAGENT_INBOX_TEE` (L370), `SUBAGENT_TELEGRAM_WAKE_ENABLED` (L382) |
| `ChannelProviderType` enum-literal-union | 1 | `CHANNEL_PROVIDER` (L324, explicit `: ChannelProviderType` annotation) |
| `string[]` | 1 | `KANBAN_LABEL_COLORS` (L322) |
| Path strings (subset of `string`) | 4 | `PROJECT_ROOT` (L12), `STORE_DIR` (L13), `DB_FILENAME` (L14), `PID_FILENAME` (L15) |
| `string \| undefined` (boot-time only) | 1 | `SCHEDULER_TZ_CONFIGURED` (L100) |

Sums: 38+13+4+1+1+1 ≈ 58 (the path strings are also strings; counted
separately in B-B §1.1 because they are path constructions). The
heterogeneity is exactly the **design tension** the framework cites for
proposing a class form — a single `Config` class with 58 `public
readonly` fields of mixed type. B-B's §3.1 / §3.2 explores three class
shapes (flat / grouped / bag-with-accessors); none is unambiguously
better than today's consts.

### 1.3 The 10 free functions — shape

| Function | Line | Signature | Reads env? |
|---|---:|---|---|
| `resolveAppTz` | 85 | `(configured: string\|undefined, systemTz?: string) => { tz: string; configured?: string; invalid?: string }` | indirectly (via boot-time `appTz` at L94) |
| `resolveBrandName` | 158 | `(brandEnv: string\|undefined, botName: string) => string` | no — pure |
| `currentBotName` | 168 | `() => string` | yes — `readEnvFile(['BOT_NAME'])` at L169 |
| `currentBrandName` | 172 | `() => string` | yes — `readEnvFile(['BRAND_NAME'])` at L173 |
| `currentOwnerName` | 175 | `() => string` | yes — `readEnvFile(['OWNER_NAME'])` at L176 |
| `resolveServiceId` | 184 | `(brandSlug: string, mainAgentId: string) => string` | no — pure |
| `brandSlug` | 194 | `(raw: string) => string` | no — pure |
| `appServiceLabel` | 230 | `(serviceId: string) => string` | no — pure |
| `launchdStatusPattern` | 248 | `(serviceId: string) => string` | no — pure |
| `systemdStatusUnits` | 257 | `(serviceId: string) => string[]` | no — pure |

5 of the 10 (`resolveBrandName`, `resolveServiceId`, `appServiceLabel`,
`launchdStatusPattern`, `systemdStatusUnits`) are **pure** — they take
inputs as parameters and do not touch the env. The other 5
(`resolveAppTz`, `currentBotName`, `currentBrandName`, `currentOwnerName`)
read from `.env` either at boot (`resolveAppTz` via `const appTz =
resolveAppTz(cfg('SCHEDULER_TZ'))` at L94) or per call.

### 1.4 Module-level state — zero

`grep -nE "^let " src/config.ts` returns **no matches**.
Verified 2026-08-30. Every module-level binding in `config.ts` is a
`const`. Of those, the ones that *look* mutable but are not:

- `const env = readEnvFile()` (L17) — the eager module-load read. The
  `env` variable is `const`, so the binding does not change; the values
  inside the `Record<string, string>` are strings, which are immutable.
  A test that wants to swap env values must re-`vi.mock` the module
  (the dominant pattern — see §4) or call the per-call re-read helpers
  (`currentBotName` etc.) which bypass this binding.
- `const overrides = readConfigOverrides()` (L36) — the
  `config-overrides.json` read; same const-bag shape, same analysis.
- `const __dirname` (L10) — `path.dirname(fileURLToPath(import.meta.url))`.
  Frozen for the module's lifetime.
- `const appTz = resolveAppTz(cfg('SCHEDULER_TZ'))` (L94) — boot-time
  frozen value. The `SCHEDULER_TZ_CONFIGURED` (L100), `APP_TZ` (L101),
  `APP_TZ_INVALID` (L105) exports derive from this binding.

The non-`export` closures (`envOr` at L133, `isUsableCronTz` at L69,
`readConfigOverrides` at L28, `cfg` at L39) are all function
declarations / arrow expressions; they do not introduce state. The
const initialiser expressions (`rawKanbanSwimlaneDefaultGroup` at L307,
`rawKanbanLabelColors` at L318, `RESPAWN_HOST` at L338,
`RESPAWN_OVERRIDE` at L339) are local `const`s whose values are consumed
once by an `export const` and discarded.

**Net:** zero module-level mutable state today. Re-running the same
`grep` after the class extraction lands must also return zero — see §6
for the HMR/double-import hazard analysis.

### 1.5 Side effects — env re-reads

| Site | What it reads | Why per-call? |
|---|---|---|
| L17 (`const env = readEnvFile()`) | full env map (L13) | The module-load baseline. Every export-const that reads `env[X]` snapshots the value at this point. |
| L169 (`currentBotName`) | `readEnvFile(['BOT_NAME'])` filtered | "Per-call reads of the two display names, so a wizard rename shows up on the dashboard without a process restart. BOT_NAME/BRAND_NAME above are frozen at module load; the identity/label routes read these instead." (comment at L163-167) |
| L173 (`currentBrandName`) | `readEnvFile(['BRAND_NAME'])` filtered | same rationale; also calls `currentBotName()` (cascading re-read) |
| L176 (`currentOwnerName`) | `readEnvFile(['OWNER_NAME'])` filtered | same rationale |

These 3 per-call re-reads are the **only** mutability-adjacent
behaviour in `config.ts`. They trade off: a wizard that writes the new
brand name to `.env` (via the dashboard Settings page or directly) and
the per-call `currentBrandName()` is called for the next dashboard
request — the new name shows up without a process restart, where the
`BRAND_NAME` const (L151) is still frozen at the boot value.

A side-effect-adjacent site: `readConfigOverrides()` at L28-35 reads
`store/config-overrides.json` synchronously via `readFileSync` from
`node:fs` (L3 import). Called once at L36; not per-call. The function
catches all errors (`try / catch {}` at L29-34) and returns `{}` on
failure.

A second side-effect-adjacent site: `RESPAWN_ENABLED` (L340-347) calls
`hostname()` (L2 import from `node:os`) per evaluation. The hostname
is checked against `RESPAWN_HOST` (L338, lowercased). This is not a
per-call helper — it runs once at module init when `RESPAWN_ENABLED`'s
initializer is evaluated.

### 1.6 Channel-const re-reads at L324-326 (per D-CRITICAL finding)

Verified by `Read` of `src/config.ts:324-326`:

```ts
324:export const CHANNEL_PROVIDER: ChannelProviderType = getProviderType(env['CHANNEL_PROVIDER'])
325:export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)
326:export const CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, env)
```

These are three const initialisers. Each call to `getChannelToken` /
`getChannelChatId` passes the eager-loaded `env` (`const env =
readEnvFile()` at L17) by reference, NOT a fresh `readEnvFile()` call.
The "re-read" terminology in the framework brief is slightly imprecise:
the *binding* `CHANNEL_TOKEN` is computed once, but its value is
*derived from* an env lookup that itself does not re-execute at runtime
— the helpers take `env` per call as a parameter (per `channel-provider.ts:459` /
`:467` signatures), and `config.ts` passes the module-load `env` to
them once.

The implication for D.1 (`ChannelEnv` constructor): D's `ChannelEnv(env:
Record<string, string>, home?)` (per `d-channel-provider/03-class-boundaries.md:71`)
takes the same `env` parameter that `config.ts:325-326` reads. After
B.1 (the `Config` class extraction), `Config.env: Record<string, string>`
becomes the public field that holds this same record — D.1's
`ChannelEnv` constructor argument and `Config.env` are the *same*
object. No silent semantic shift between B.1 and D.1.

### 1.7 HMR hazards today — none

If `config.ts` is imported twice (HMR or duplicate-import), each
evaluation:

1. Re-imports `readEnvFile` from `./env.js` (L6). `env.ts` itself has
   the eager-loaded `PROJECT_ROOT` (L11) frozen at its own module
   init; HMR of `env.ts` would reset that.
2. Re-runs `__dirname = dirname(fileURLToPath(import.meta.url))` (L10) —
   same `__dirname` for the same source URL.
3. Re-creates `const env = readEnvFile()` (L17). The `env` binding is
   fresh, but the **values** inside the read are derived from the same
   `.env` file (modulo HMR-of-`env.ts` resetting `PROJECT_ROOT`).
4. Re-creates every `export const` (L12-L394). Each constant computes
   its value from `env[X] ?? <default>` at the new module's init time.
   This means a configuration *change* between two module re-evals is
   visible to the second eval's exports — `vi.resetModules()` then
   re-import then `expect(CONFIG.WEB_PORT).toBe(4000)` works.

**Consequence.** Callers holding a reference to the *first* module's
`WEB_PORT` see the first module's value; callers holding the *second*
module's reference see the second. Both work in isolation; the const
expressions are NOT `===` across imports. Tests rely on this — see
§4. The class extraction must preserve this property: `new Config()`
constructed at app boot captures the boot-time env; a test that does
`vi.resetModules()` then `new Config()` after a mock sees the mock's
env. Per `02-type-interface-analysis.md §3.3`, the recommended class
shape is `new Config()` (drop-in replacement) or
`new Config(values: Record<string, string | number | boolean>)`
(explicit). The lazy-instance approach (singular `Config.fromEnv()`
returning one instance) plus a `reload()` method would couple callers
to a single shared instance and break the per-test re-init pattern —
**not recommended**.

---

## 2. `config-registry.ts` inventory

### 2.1 Export shape (verified 2026-08-30)

`grep -c "^export const " src/config-registry.ts` = **2**.
`grep -c "^export function " src/config-registry.ts` = **3**.
`grep -nE "^export interface|^export type" src/config-registry.ts`
returns 3 lines (1 type alias + 2 interfaces):

| Export | Line | Shape |
|---|---:|---|
| `DISTRIBUTION_DEFAULT_AGENT_MODEL` (const) | 16 | `string` = `'claude-opus-4-8[1m]'` (the distribution default — single source of truth for `config.ts:114`'s `cfg('DEFAULT_AGENT_MODEL') || DISTRIBUTION_DEFAULT_AGENT_MODEL` fallback) |
| `SettingType` (type alias) | 18 | `'int' \| 'string' \| 'color' \| 'boolean'` — 4-member literal union |
| `SettingDefinition` (interface) | 20-33 | 7 required fields (`key`, `type`, `default`, `description`, `module`, `secret`, `requiresRestart`) + 3 optional (`valueSet`, `min`, `max`) |
| `HEX_COLOR_RE` (module-private const) | 35 | `/^#[0-9a-fA-F]{6}$/` regex literal |
| `SETTINGS_REGISTRY` (const) | 37-430 | `SettingDefinition[]` — **35 entries**, built once from a literal |
| `getSettingDefinition` (function) | 432 | `(key: string) => SettingDefinition \| undefined` |
| `listSettingModules` (function) | 436 | `() => string[]` — `[...new Set(SETTINGS_REGISTRY.map(...))]` |
| `SettingValidationResult` (interface) | 440-445 | `{ ok, error?, value? }` |
| `validateSettingValue` (function) | 449 | `(def: SettingDefinition, raw: unknown) => SettingValidationResult` |

`grep -nE " as any| as unknown| as const|: any\b|: unknown\b" src/config-registry.ts`
returns **0 matches** (per `02 §2.7`). The only `unknown` is the
correct usage of `raw: unknown` on `validateSettingValue` (L449) — the
untrusted-input boundary at `/api/settings`.

### 2.2 `SETTINGS_REGISTRY` mutation pattern — never mutated

`grep -rn "SETTINGS_REGISTRY\.push\|SETTINGS_REGISTRY\[" src/ --include='*.ts'`
returns **0 matches**. Verified by direct grep on 2026-08-30. The
array is mutable in principle (`SettingDefinition[]` does not carry
`readonly[]`) but no production code writes to it. The two consumers
today are read-only:

- `src/web/routes/settings.ts:3` — `import { SETTINGS_REGISTRY,
  validateSettingValue } from '../../config-registry.js'` (routes
  reads the array to render the dashboard Settings page; never writes).
- `src/settings-store.ts:6` — `import { getSettingDefinition,
  validateSettingValue, type SettingDefinition } from
  './config-registry.js'` (persists user-edited values to
  `config-overrides.json`; calls the helpers but does not mutate the
  array).

Per `review-completeness.md OE-8`: the array is frozen at module load,
the helpers (`getSettingDefinition`, `listSettingModules`,
`validateSettingValue`) are pure functions, and promoting to a class
would add `define` / `undefine` methods that exist only for `vi.mock`
test overrides (which today mock the whole module, not call
`define`/`undefine`). The framework brief proposes the class wrap; the
source argues against it; the verdict in `02 §4` is to **keep as-is**.

### 2.3 `HEX_COLOR_RE` at L35 — module-private regex

```ts
35:const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
```

Non-exported. Used only at L478 inside `validateSettingValue` for the
`'color'` branch:

```ts
476:  if (def.type === 'color') {
477:    const str = String(raw)
478:    if (!HEX_COLOR_RE.test(str)) return { ok: false, error: '...' }
479:    return { ok: true, value: str }
480:  }
```

No other consumer in `src/`. The regex is co-located with its single
caller, which is the correct boundary — exporting it would be
premature (OE-6). Promoting it to a function or class would add zero
behavioural value.

### 2.4 HMR hazards — none (frozen at module load)

Same analysis as §1.7 applies. `SETTINGS_REGISTRY` is built once from
the literal at L37-L430; on a re-import, the array is freshly
constructed but with the same entries (the literal is source-level, so
`git diff`-equivalent across HMR). `HEX_COLOR_RE` is rebuilt but
matches the same shape. The two helper functions are re-declared but
behave identically. No state hazard.

---

## 3. 64 importer distribution (verified 2026-08-30)

`grep -rln "from ['\"]\\./config\.js['\"]\|from ['\"]\\.\\./config\.js['\"]"
src/ --include="*.ts" | grep -v __tests__ | sort -u | wc -l` returns
**64**. (B-RC C2 corrected the framework M5 audit-time count of 60;
the B plan must use 64 as the baseline.) The full list:

### 3.1 `src/` top-level (12 files)

| File | Line | Fields imported |
|---|---:|---|
| `src/index.ts` | 13 | `PROJECT_ROOT, STORE_DIR, PID_FILENAME, WEB_PORT, ALLOWED_CHAT_ID, MAIN_AGENT_ID, RESPAWN_ENABLED, HEARTBEAT_AGENT_ENABLED` (8 fields) |
| `src/db.ts` | 5 | `STORE_DIR, DB_FILENAME, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ` (5 fields) |
| `src/web.ts` | 6 | `PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID` (5 fields) |
| `src/heartbeat.ts` | 13 | (multi-line destructuring — 6 HEARTBEAT_* fields per `02 §1.2`) |
| `src/agent.ts` | (n/a) | (verified by importer list; specific field-line refs `[ASSUMPTION]` — not individually audited for §3 inventory) |
| `src/channel-coordinator.ts` | 35 | `PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME` (**4 fields**, NOT 6 — per B-RC C1; the original 00-summary plan overstated by 2 fields including `CHANNEL_TOKEN` and `CHANNEL_CHAT_ID` and 3 others that the file never reads) |
| `src/costops/config.ts` | (n/a) | sub-imports for the costops sub-app `[ASSUMPTION]` |
| `src/costops/ledger.ts` | (n/a) | `[ASSUMPTION]` |
| `src/notify.ts` | (n/a) | `[ASSUMPTION]` |
| `src/settings-store.ts` | (n/a) | (the dashboard-side override layer; uses config-registry rather than config directly — see §5) |
| `src/store-watcher.ts` | (n/a) | `[ASSUMPTION]` |

(Some line refs marked `[ASSUMPTION]` because the task brief asks for
counts in §3 and §4, not exhaustive per-file field enumeration.)

### 3.2 `src/web/` and subdirs (51 files)

Selected (per B-B verified):

| File | Line | Fields imported |
|---|---:|---|
| `src/web/cron.ts` | 2 | `APP_TZ, SCHEDULER_TZ_CONFIGURED` (2 fields — the schedule-timezone keys) |
| `src/web/auto-restart-store.ts` | 3 | `PROJECT_ROOT` (1 field — but B-RC m4 confirmed `DEFAULT_AUTO_RESTART` is imported from `../auto-restart.js`, NOT `../config.js`, at L7) |
| `src/web/schedule-runner.ts` | (n/a) | (the loud APP_TZ_INVALID reporting site at L1029 per B-RC "confirmed claims") |
| `src/web/heartbeat-agent-scaffold.ts` | (n/a) | `[ASSUMPTION]` |
| `src/web/agent-config.ts`, `agent-desired-state.ts`, `agent-message-wrap.ts`, `agent-process.ts`, `agent-scaffold.ts`, `agent-taskstate.ts`, `agent-team.ts`, `agent-worker.ts` | (n/a) | `[ASSUMPTION]` |
| `src/web/auto-restart-runner.ts`, `bridge-enroll.ts`, `channel-health-monitor.ts`, `channel-mcp-reconnect.ts`, `channel-monitor.ts`, `channel-request-watcher.ts`, `claude-credentials-guard.ts`, `claude-plans.ts`, `command-task.ts`, `context-guard-runner.ts`, `context-guard-store.ts` | (n/a) | `[ASSUMPTION]` |
| `src/web/dashboard-auth.ts`, `dashboard-settings.ts`, `discord-group-bootstrap.ts` | (n/a) | `[ASSUMPTION]` |
| `src/web/federation/bridge.ts`, `capability-runner.ts`, `onboarding.ts`, `poller.ts` | (n/a) | `[ASSUMPTION]` |
| `src/web/fleet-transfer.ts`, `heartbeat-agent-scaffold.ts`, `inbound-probe.ts`, `inbox-nudge-watcher.ts`, `llm-breakdown.ts`, `main-agent.ts`, `message-router.ts`, `model-fallback-runner.ts`, `model-fallback-store.ts`, `profiles.ts`, `reauth-healer.ts`, `schedule-mcp-precheck.ts`, `schedule-runner.ts`, `scheduled-tasks-io.ts`, `stuck-input-watcher.ts`, `telegram-inbox-wake.ts`, `telegram.ts`, `terminal-input-store.ts`, `token-usage.ts`, `update-checker.ts`, `vault-bindings.ts`, `vault.ts`, `voice-directive.ts` | (n/a) | `[ASSUMPTION]` |
| `src/channel-coordinator/ingest.ts`, `liveness.ts` | (n/a) | `[ASSUMPTION]` |

(Per-file field enumeration is out of scope for §3 — the B plan's
00-summary has a representative subset; the full enumeration belongs
in `05-refactor-roadmap.md` Phase B.4.)

### 3.3 Cross-section totals

| Bucket | Count | Note |
|---|---:|---|
| Top-level `src/` | 12 | index / db / web / heartbeat / agent / notify / settings-store / store-watcher / channel-coordinator / costops/config / costops/ledger / (one more `[ASSUMPTION]`) |
| `src/web/` + subdirs | 51 | route handlers, channel monitors, federation, vault, etc. |
| `src/__tests__/` | (not counted toward 64 — `grep -v __tests__` filter) | 152 test files mock `'../config.js'` (see §4) |
| `bin/` | **0** | `[ASSUMPTION]` — flagged as not-yet-audited per framework m12 (review-correctness.md:556-567 noted "No audit of `bin/` was performed in the plan"). The B plan should include a Phase-0 audit: `grep -rln "src/" bin/` and explicit `ls bin/`. |
| `scripts/*.ts` | **0** | `[ASSUMPTION]` — `grep -rln "from ['\"]\\./config\.js['\"]" scripts/*.ts` returns nothing (verified 2026-08-30). The shell scripts (`scripts/channels.sh`, etc.) read `.env` directly with `cut -d= -f2-` (per `env.ts:49-50` comment) and do not import the JS module. |
| **Total** | **64** | matches the B-RC C2 verified count |

[ASSUMPTION] The exact per-file field-import count for the 51 web/
files was not individually audited for §3 — the task brief asks for
counts and blast radius, not full field enumeration. The B.4 phase
should produce a per-file field-import table before any consumer
migration lands.

---

## 4. 152 test files with 154 `vi.mock('../config.js')` occurrences

`grep -rh "vi\.mock(" src/__tests__/ | grep -oE "vi\.mock\([^)]+\)" | sort
| uniq -c | sort -rn | grep "config\.js"` per framework M4:

| Pattern | Count |
|---|---:|
| `vi.mock('../config.js', async (orig)` | 75 |
| `vi.mock('../config.js', ()` | 56 |
| `vi.mock('../config.js')` (single-arg, bare) | 12 |
| `vi.mock('../config.js', async (importOriginal)` | 11 |
| **Total occurrences** | **154** |

These 154 occurrences span **152 distinct test files** (per B-RC m1
correction — some files have two `vi.mock('../config.js')` calls).
`grep -rln "vi\.mock.*config\.js" src/__tests__/ | wc -l` returns 152.

**Pattern interpretation:**

- 75 + 11 = 86 use the `async (orig)` / `async (importOriginal)` shape,
  which calls `await orig()` or `await importOriginal()` to inherit the
  real module then overrides specific exports. This is the "spread
  the actual, then patch a few keys" pattern — closest in shape to
  the proposed `createTestConfig(overrides?)` factory per
  `review-completeness.md CE-5`.
- 56 use the inline-object shape `() => ({ KEY: val, … })` — the
  "full-replacement" pattern. Migration: tests that today fully
  replace the module would convert to `new Config({ KEY: val, … })`,
  a constructor call rather than a `vi.mock`.
- 12 use the single-arg bare form `vi.mock('../config.js')` — likely
  for the side effect of resetting the module-cache (no actual export
  overrides, just nudges `vi` to re-evaluate on next import).

**Per-pattern rewrites (planned for B.5):**

| Pattern today | After B.5 |
|---|---|
| `vi.mock('../config.js', () => ({ WEB_PORT: 4000 }))` (56 sites) | `new Config({ WEB_PORT: 4000 })` via `createTestConfig({ WEB_PORT: 4000 })` factory |
| `vi.mock('../config.js', async (orig) => { const a = await orig(); return { ...a, WEB_PORT: 4000 } })` (86 sites) | Either drop the spread (use the factory with only the overrides) or keep the spread idiom against the factory |
| `vi.mock('../config.js')` (12 sites) | `vi.resetModules()` + `await import('../config.js')` — preserved as-is, doesn't need to migrate |

The exact 86-vs-12-vs-56 split matters for B.5's test-factory design:
the 56 inline-object sites are the lowest-friction rewrite (one
factory call replaces the factory). The 86 async-orig sites are the
highest-friction (the factory must support a "spread with overrides"
mode). The 12 bare-form sites are lowest-cost (no rewrite needed).

---

## 5. `readEnvFile` integration

### 5.1 Signature (verified)

`src/env.ts:13`:
```ts
export function readEnvFile(keys?: string[]): Record<string, string>
```

Returns `Record<string, string>`; never `undefined` (returns `{}` on
missing/unreadable `.env` per L18-20). The `keys?` parameter is an
optional *filter* — when present, only listed keys end up in the result
map.

### 5.2 Call sites in `config.ts` (5 total)

| Line | Caller | Form |
|---:|---|---|
| 17 | `const env = readEnvFile()` | full map (module-load baseline) |
| 169 | `readEnvFile(['BOT_NAME'])` | filtered, inside `currentBotName` |
| 173 | `readEnvFile(['BRAND_NAME'])` | filtered, inside `currentBrandName` |
| 176 | `readEnvFile(['OWNER_NAME'])` | filtered, inside `currentOwnerName` |

The line refs are the **exact** ones verified by `Read` of the full
file (B-RC "confirmed claims" matches these exactly). The earlier
framework numbers ("L169 / L173 / L176" in B-B's analysis) are the same.

### 5.3 Channel-const re-reads (NOT `readEnvFile` re-reads)

Per §1.6 above, `config.ts:325-326` calls
`getChannelToken(CHANNEL_PROVIDER, env)` /
`getChannelChatId(CHANNEL_PROVIDER, env)` — these take the module-load
`env` as a **parameter**, not a fresh `readEnvFile()`. They re-call the
env-helpers, not the env-reader.

### 5.4 `readEnvFile` consumer outside B

D's `ChannelEnv` (per `d-channel-provider/03-class-boundaries.md:71`)
has `constructor(env: Record<string, string>, home?)`. The `env`
parameter is the same record as `Config.env` after B.1 — D's
`ChannelEnv` does NOT call `readEnvFile()` itself; it consumes the
pre-parsed record. The D-CRITICAL finding (`d-channel-provider` review)
is that D.1 must take `Record<string, string>`, NOT `process.env` —
otherwise the channel helpers resolve to different values than the
boot-time `CHANNEL_TOKEN` const.

### 5.5 `env.ts` post-B.1 status

Per `02-type-interface-analysis.md §1.6`: `readEnvFile` stays a free
export; it is the underlying primitive that `Config.fromEnv()` (B.1)
calls. `env.ts` itself is **not touched** by B.1-B.6 — it is out of
scope (the read/write primitives are correct as-is; the Settings
page's `updateEnvFile` already exists at `env.ts:54`).

---

## 6. HMR hazards — Config singleton double-instantiate risk (BR6)

Today: zero (no `let` bindings in either file; re-imports are
correct-by-construction). Verified by `grep -nE "^let " src/config.ts`
returns nothing and the same on `config-registry.ts`.

**After class extraction (B.1-B.6):**

The naive class form `export const CONFIG = new Config()` constructed
at module-scope, then a test does `vi.resetModules()` then
`await import('../config.js')` — the test sees a *fresh* `CONFIG`
instance that did not see the `vi.mock`'d module. Vitest's `vi.mock`
hoists the factory and runs it at import time, so a typical test like:

```ts
beforeEach(() => {
  vi.resetModules()
})
test('WEB_PORT override', async () => {
  vi.doMock('../config.js', () => ({ WEB_PORT: 9999 }))
  const { WEB_PORT } = await import('../config.js')
  expect(WEB_PORT).toBe(9999)
})
```

works against the const-export pattern (L17 `const env =
readEnvFile()`, then `export const WEB_PORT = parseInt(env[…] ?? …)`)
because every const is re-evaluated on each module re-import. With a
**class with eager construction**, `new Config()` runs the constructor
inside the factory closure, picking up the vi.mock'd values — works.

The hazard is the **opposite** — a class that captures an instance at
module load (`const CONFIG = new Config()` at the bottom of
`config.ts`) on the *first* import, then on a `vi.resetModules()` the
second import creates a second instance that the test never sees. To
defend:

1. Either export a *factory* `export function makeConfig(): Config { … }`
   that the test calls after the reset.
2. Or export the class and have `index.ts` (the composition root, per
   `02 §3.1`) construct exactly one instance at boot via
   `const CONFIG = Config.fromEnv()` and pass it down — tests that want
   overrides construct their own `new Config({...})` via the factory.

The B.6 detection signal (`grep -rln "from ['\"]\\./config\.js['\"]"
src/ --include='*.ts' | grep -v __tests__` returns 0 direct imports)
is the trigger for removing the re-export shim — at that point every
consumer reads `import { CONFIG } from './config.js'` (or holds an
injected instance), and the singleton hazard disappears because there
is exactly one canonical instance.

**Recommendation for B.1:** do not export a module-scope `const CONFIG`
singleton. Export the class (`export class Config { … }`); let `index.ts`
(and the test factory) construct. Today the const bag already avoids
the singleton hazard by per-import re-evaluation; the class form must
match that property.

---

## 7. Cross-cutting observations

### 7.1 Depends on H (LoggerLike) — zero

`grep -nE "logger|log\." src/config.ts` returns **2 matches, both in
comments**:

```
103:// path. config.ts is imported too early to own a logger (logger imports config
376:// fires and claims the backlog. This is the ACTIVE tail of the SUBAGENT_INBOX_TEE
```

The line-103 comment explicitly documents the **circular-import
constraint**:

> "config.ts is imported too early to own a logger (logger imports config → circular)"

`config.ts` is imported very early in the boot sequence (it sets
`APP_TZ` for the logger's startup banner at `logger.ts`-the-consumer).
For the logger to import config (which it does, today, for `APP_TZ`
and `APP_TZ_INVALID`), config cannot import logger. Therefore
config.ts has **zero logger call sites** in production today.

`config-registry.ts` similarly: `grep -nE "logger|log\.`
src/config-registry.ts` returns **0 matches**. No I/O, no async, no
logger use.

**For a `Config` class:**

Per `02-type-interface-analysis.md §3.6` (LoggerLike integration):
"Three sub-questions: (i) Does `Config` need a `log: LoggerLike`
field? ... (iii) Is it worth it? **REJECT** `log: LoggerLike` on
`Config`." The reasoning: the loud `APP_TZ_INVALID` reporting already
works via `startScheduleRunner` at `web/schedule-runner.ts:1029` (where
the logger is available); moving it to `Config.constructor()` saves
zero lines and adds a constructor dependency on every `new Config()`.

**Structural lockout:** `logger.ts` imports `config.ts` (not the
reverse) for the `APP_TZ` / `APP_TZ_INVALID` boot values. A
`Config` class that adds `log: LoggerLike` to its constructor would
NOT break this constraint — classes are constructed by their consumer,
which happens after `logger.ts` has finished loading. But adding
`log: LoggerLike` is **rejected for behavioural reasons** (zero log
call sites; logger.reporting lives in `startScheduleRunner`), not
structural reasons. The framing in B-B §3.6 and `h-cross-cutting/06-risks-and-mitigations.md`
HR4 (which addresses pino.LogFn overload compatibility, not circular
constraints) cross-cite this decision.

### 7.2 Depends on D (readEnvFile consumer)

D's `ChannelEnv` constructor takes `(env: Record<string, string>,
home?)` per `d-channel-provider/03-class-boundaries.md:71` — the same
`Record<string, string>` shape that `readEnvFile` returns. B.1's
`Config.env: Record<string, string>` (B-B §3.2) becomes the public
field that D.1's `ChannelEnv` reads from.

The dependency direction is: B exposes env → D consumes env. B does
NOT import D for the env-record shape; D's `ChannelProviderType` is a
type-only import at `config.ts:8`. After B.1, D.1 reads
`config.env` (a record), and `ChannelEnv`'s constructor signature is
unchanged.

### 7.3 Provides config to A / D / F / G / C

| Consumer | Fields read | Construct seam |
|---|---|---|
| **A** (db — `src/db.ts:5`, 5 fields: `STORE_DIR, DB_FILENAME, ALLOWED_CHAT_ID, OLLAMA_URL, APP_TZ`) | `db` builds `DbClient` (entity-store keystone per `00-summary.md`); the 5 fields are stored on the instance and read by every store method. | `DbClient` takes `config: Config` in its constructor per `00-summary.md` Scope row; A is constructed at `index.ts` after B.1's `Config.fromEnv()`. |
| **D** (channel-provider) | `CHANNEL_PROVIDER, CHANNEL_TOKEN, CHANNEL_CHAT_ID` per `config.ts:324-326` (const initialisers that call `getProviderType`, `getChannelToken`, `getChannelChatId`). | D.1 `ChannelEnv(env: Record<string, string>, home?)` per `d-channel-provider/03-class-boundaries.md:71`. After B.1, `channelEnv = new ChannelEnv(config.env, home)`. |
| **F** (`src/heartbeat.ts:13` 6 fields + `DEFAULT_AUTO_RESTART` from `auto-restart.ts:48`, NOT from config.ts) | The 6 `HEARTBEAT_*` fields (`HEARTBEAT_INTERVAL_MS` L350, `HEARTBEAT_START_HOUR` L351, `HEARTBEAT_AGENT_ENABLED` L358-359, `HEARTBEAT_END_HOUR` L393, `HEARTBEAT_CALENDAR_ACCOUNT` L392, `HEARTBEAT_CALENDAR_ID` L394); `DEFAULT_AUTO_RESTART` is a separate frozen const on `auto-restart.ts` not on `config.ts`. | F.1 `HeartbeatScheduler` takes `config: Config` per `f-agent-subsystem/03-class-boundaries.md §F1`; F.5 `AutoRestartSchedule` takes the frozen const unchanged. |
| **G** (`src/channel-coordinator.ts:35`, 4 fields: `PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME` per B-RC C1 correction — NOT 6) | These 4 fields. The 5 other fields the original 00-summary plan cited (`CHANNEL_TOKEN, CHANNEL_CHAT_ID, RESPAWN_ENABLED, SUBAGENT_INBOX_TEE, SUBAGENT_TELEGRAM_WAKE_ENABLED`) are NOT imported by `channel-coordinator.ts` and must NOT be in the `Config` constructor signature. | `ChannelCoordinator` takes `config: Config` in its constructor; `Config` injection reads `config.PROJECT_ROOT` etc. |
| **C** (`src/web.ts:6`, 5 fields: `PROJECT_ROOT, WEB_HOST, DASHBOARD_PUBLIC_URL, DASHBOARD_ALLOWED_ORIGINS, MAIN_AGENT_ID`) | `class DashboardServer` per `00-summary.md` Scope row; the 44 route files in `src/web/routes/` inherit via `RouteContext`. | `DashboardServer(config: Config)` constructor; routes pick up `config` from `RouteContext`. |

### 7.4 Reads from config-registry (not from config.ts)

`src/settings-store.ts:6` and `src/web/routes/settings.ts:3` import from
`./config-registry.js` (NOT from `./config.js`):
- `settings-store.ts` imports `getSettingDefinition, validateSettingValue,
  type SettingDefinition` — the runtime helpers + type alias.
- `web/routes/settings.ts` imports `SETTINGS_REGISTRY, validateSettingValue`
  — the array + the validator.

Both read the registry as the **settings-store's source of truth for
defaults**, not from `config.ts`. The B plan's "config.ts:113
DEFAULT_AGENT_MODEL = cfg('DEFAULT_AGENT_MODEL') || DISTRIBUTION_DEFAULT_AGENT_MODEL"
is the only cross-file coupling — the const export at L113 falls back
to the registry's `DISTRIBUTION_DEFAULT_AGENT_MODEL` (L16) so the two
defaults cannot drift apart.

---

## 8. Cross-section check: `Config` field count vs consumer reads

| Bucket | Count |
|---|---:|
| Total `export const` in `config.ts` | 58 |
| Fields read by `index.ts:13` | 8 of 58 |
| Fields read by `web.ts:6` | 5 of 58 (subset of the 44 route-file reads via `RouteContext`) |
| Fields read by `db.ts:5` | 5 of 58 |
| Fields read by `heartbeat.ts:13` | 6 of 58 |
| Fields read by `channel-coordinator.ts:35` | 4 of 58 (per B-RC C1) |
| Fields read by `web/cron.ts:2` | 2 of 58 |
| Sum of fields read by the 5 keystones | 30 of 58 (with overlaps — e.g. `MAIN_AGENT_ID` is in `index.ts`/`web.ts`/`channel-coordinator.ts`; `APP_TZ` is in `db.ts`/`web/cron.ts`) |
| Fields read nowhere by direct `import` (the "orphan" 28) | `[ASSUMPTION]` — would need per-58 grep; not done for §3 |

The "orphan 28" `[ASSUMPTION]` is the headline for B.4: it implies
roughly half the 58 consts are consumed *only* through transitive paths
(ChainProvider registry reads them, sub-module helpers consume them
via wrapper re-exports). A consumer-migration budget that misses one
of these transitive reads would silently break a feature. B.4's gate
should include a "field-read coverage" sweep — every one of the 58
consts should appear in at least one importer of the new
`config.<FIELD>` reads or be marked unused.

---

## 9. Brief verification table (file-and-line)

| Claim | Verified location |
|---|---|
| `config.ts` is 394 lines | `wc -l src/config.ts` = 394 |
| `config-registry.ts` is 484 lines | `wc -l src/config-registry.ts` = 484 |
| `env.ts` is 100 lines | `wc -l src/env.ts` = 100 |
| 58 `export const` in `config.ts` | `grep -c "^export const " src/config.ts` = 58 |
| 10 `export function` in `config.ts` | `grep -c "^export function " src/config.ts` = 10 |
| 0 `export interface` / `export type` in `config.ts` | `grep -cE "^(export interface\|export type) " src/config.ts` = 0 |
| 0 `let` bindings in `config.ts` | `grep -nE "^let " src/config.ts` returns 0 |
| 2 `export const` in `config-registry.ts` | `grep -c "^export const " src/config-registry.ts` = 2 (DISTRIBUTION_DEFAULT_AGENT_MODEL L16, SETTINGS_REGISTRY L37) |
| 3 `export function` in `config-registry.ts` | `grep -c "^export function " src/config-registry.ts` = 3 (getSettingDefinition L432, listSettingModules L436, validateSettingValue L449) |
| 1 `export type` in `config-registry.ts` | `grep -nE "^export type" src/config-registry.ts` = L18 (`SettingType`) |
| 2 `export interface` in `config-registry.ts` | `grep -nE "^export interface" src/config-registry.ts` = L20 (`SettingDefinition`), L440 (`SettingValidationResult`) |
| `HEX_COLOR_RE` at `config-registry.ts:35` | `grep -n "HEX_COLOR_RE" src/config-registry.ts` returns 35 (decl) and 478 (use) |
| `SETTINGS_REGISTRY` 35 entries at L37-430 | `Read` of the array literal (35 `{ key:` opens verified by Read) |
| `SETTING_REGISTRY` mutation count | `grep -rn "SETTINGS_REGISTRY\.push\|SETTINGS_REGISTRY\[" src/ --include='*.ts'` = 0 |
| `readEnvFile` at `env.ts:13` | `grep -n "readEnvFile" src/env.ts` returns 13 (decl) |
| `config.ts` 5 `readEnvFile` call sites | L17, L169, L173, L176, plus the L6 import. Per B-RC "confirmed claims" — exact line refs match. |
| `CHANNEL_PROVIDER` / `CHANNEL_TOKEN` / `CHANNEL_CHAT_ID` at L324-326 | `Read` of `config.ts:324-326` confirms all three lines |
| LoggerLike references in `config.ts` = 2 (both comments) | `grep -nE "logger\|log\." src/config.ts` returns L103 and L376 (both comments) |
| LoggerLike references in `config-registry.ts` = 0 | `grep -nE "logger\|log\." src/config-registry.ts` returns 0 |
| 64 production importers of `config.ts` | `grep -rln "from ['\"]\\./config\.js['\"]\|from ['\"]\\.\\./config\.js['\"]" src/ --include="*.ts" \| grep -v __tests__ \| sort -u \| wc -l` = 64 (per B-RC C2 correction) |
| 152 distinct test files with `vi.mock` for `config.js` | `grep -rln "vi\.mock.*config\.js" src/__tests__/ \| wc -l` = 152 (per B-RC m1) |
| 154 `vi.mock('../config.js')` occurrences | framework M4 grep: 75 + 56 + 12 + 11 = 154 |
| `bin/` config importers | `[ASSUMPTION]` — flagged as not-yet-audited per framework m12 |
| `scripts/*.ts` config importers | `grep -rln "from ['\"]\\./config\.js['\"]" scripts/*.ts` = 0 (verified) |
| `index.ts:13` 8-field config import | `grep -n "from.*config" src/index.ts` = L13, 8 fields |
| `web.ts:6` 5-field config import | `grep -n "from.*config" src/web.ts` = L6, 5 fields |
| `db.ts:5` 5-field config import | `grep -n "from.*config" src/db.ts` = L5, 5 fields |
| `channel-coordinator.ts:35` **4-field** config import (NOT 6) | `grep -n "from.*config" src/channel-coordinator.ts` = L35, 4 fields (per B-RC C1 critical correction) |
| `web/cron.ts:2` 2-field config import (`APP_TZ, SCHEDULER_TZ_CONFIGURED`) | `grep -n "from.*config" src/web/cron.ts` = L2, 2 fields |
| `web/auto-restart-store.ts:3` 1-field config import (`PROJECT_ROOT`) | `grep -n "from.*config" src/web/auto-restart-store.ts` = L3, 1 field (`DEFAULT_AUTO_RESTART` is from `../auto-restart.js` L7, NOT from config.js) |
| `web/schedule-runner.ts:1029` APP_TZ_INVALID loud reporting | `sed -n '1020,1035p' src/web/schedule-runner.ts` confirms `logger.warn({...})` at L1029 |

---

## 10. [ASSUMPTION] markers

- [ASSUMPTION: per-file field-import enumeration for the 51 web/ importers
  is not done for §3 — the task brief asks for counts and blast radius,
  not full field enumeration. B.4's phase should produce a per-file
  field-import table.]
- [ASSUMPTION: the "orphan 28" of the 58 consts (fields not read by
  any of the 5 keystones) is not counted individually — the §8 cross-section
  would need per-58 grep that is out of scope for this analysis. A
  B.4-gated sweep should verify every one of the 58 is consumed.]
- [ASSUMPTION: `bin/` config importers — flagged as not-yet-audited per
  framework review-correctness.md:556 (m12). The B plan should include
  a Phase-0 audit: `grep -rln "src/" bin/` and explicit `ls bin/`.]
- [ASSUMPTION: the 35-entry `SETTINGS_REGISTRY` count is taken from
  B-B's pre-existing audit; verified by Read of the array block span
  (L37-L430) but not re-counted literally.]
- [ASSUMPTION: `Config.fromEnv()` factory design follows
  `e-process-lock/03-class-boundaries.md:42` (`PortLockAcquirer`
  constructor `(ctx, opts?)` precedent) — the factory pattern is
  sketched in B-B §3.3 but the full design belongs in
  `03-class-boundaries.md` §B1.]

## 11. Cross-references

- **B-B** (`02-type-interface-analysis.md`) — type/interface lens; every
  count and line ref in this analysis is sourced there unless
  explicitly verified here.
- **B-RC** (`review-correctness.md`) — C1 (4 fields in
  channel-coordinator.ts, NOT 6); C2 (64 importers, NOT 60); m1
  (152 test FILES, 154 vi.mock OCCURRENCES); M3 (L325-326 const
  initialisers).
- **Framework `review-correctness.md`** — M2 (58 const exports); M4
  (154 vi.mock sites; pattern breakdown 75+56+12+11); M5 (60
  importers — C2 corrected to 64); R2 (config.ts keystone); C6 (19
  imports in index.ts); m12 (bin/ scripts audit deferred).
- **Framework `review-completeness.md`** — OE-8 (SettingsRegistry no
  class wrap; config-registry.ts stays frozen array + 3 pure
  helpers); OE-9 (App.getStore<K> dropped); CE-5 (test factory design).
- **`d-channel-provider/03-class-boundaries.md:71`** — `ChannelEnv`
  constructor `(env: Record<string, string>, home?)` precedent;
  informs B.1's `Config.env` public field.
- **`e-process-lock/03-class-boundaries.md:42`** — `PortLockAcquirer`
  constructor `(ctx, opts?)` precedent for the **introduce-alongside,
  free-function-wrapper-survives** pattern that B.1 follows.
- **`f-agent-subsystem/03-class-boundaries.md §F1 / §F5`** —
  `HeartbeatScheduler` and `AutoRestartSchedule` consumers of
  `Config`; both land after B.1.
- **`h-cross-cutting/06-risks-and-mitigations.md` HR4** — `LoggerLike`
  vs `pino.Logger` call-signature incompatibility. B has zero
  logger call sites today; `Config` does NOT gain a `log: LoggerLike`
  field per `02 §3.6`.
