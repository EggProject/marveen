# B (config) — Class boundaries

Concrete class candidates for the B subsystem. Signatures only; no
implementation. Every claim below cites a file:line verified against
`src/config.ts` and `src/config-registry.ts` on 2026-08-30.

**Reading note.** B produces **one** new class (`Config`) and **explicitly
does not** wrap `SettingsRegistry` as a class — that decision is locked
in by `review-completeness.md` OE-8 and documented in §B2 below. The
`Config` class is the textbook "absorb 58 frozen module-level consts into
an instance" pattern (per `02-type-interface-analysis.md §3.1`), with
the named-const exports kept as re-exports of the instance fields during
the migration window (per `e-process-lock/03-class-boundaries.md:42`
"introduce alongside, free function survives" precedent and
`d-channel-provider/03-class-boundaries.md:166` "thin wrapper" pattern).

---

## Class candidate inventory

| Class | New? | Migration source | Phase |
|---|---|---|---|
| `Config` | new (introduced alongside 58 const exports) | the 58 `export const` declarations at `src/config.ts:12-15/100-101/105/113-114/116-117/119-121/128/137/142/143/151/208/217/223-224/261/263/267-272/281-292/295/301/302/307-311/312/318/322/324-326/340/350/351/358-359/370-371/382-383/392-394` plus 3 instance methods (`currentBotName`/`currentBrandName`/`currentOwnerName` at L168/172/175) | B.1 |
| `SettingsRegistry` | **NOT built** (per OE-8) | n/a | B.7 (verification only) |

One class total. The single `Config` class is the only deliverable; the
58 named-const exports are preserved as re-exports of `instance.<field>`
during the migration window (removed in B.6).

---

## B1. `Config`

### Source and migration

- **Source file:** `src/config.ts` (same file, alongside the existing
  58 const exports and 10 free functions).
- **Migration source:**
  - The 58 `export const` declarations enumerated in `02-type-interface-analysis.md §1.1`
    (verified by `grep -c "^export const " src/config.ts` = 58).
  - The 3 instance methods `currentBotName` (L168-171),
    `currentBrandName` (L172-174), `currentOwnerName` (L175-178) — these
    already call `readEnvFile()` per-call and read fresh `.env` values.
    They become instance methods that re-read `.env` for the per-field
    keys.
  - The 5 pure helpers `resolveBrandName` (L158-161), `resolveServiceId`
    (L184-187), `brandSlug` (L194-202), `appServiceLabel` (L230-232),
    `launchdStatusPattern` (L248-250), `systemdStatusUnits` (L257-259)
    — these become **static methods** on the class (no `this` state to
    bind; preserved as free-function imports via the re-export shim
    during the migration window).
  - The 2 boot-time helpers `resolveAppTz` (L85-92) and
    `isUsableCronTz` (L69-83) — `resolveAppTz` becomes a static method
    (it takes its inputs as parameters); `isUsableCronTz` is module-private
    and stays private.

### Public surface (signatures only)

```ts
class Config {
  // -- 58 readonly fields, one per export const --
  readonly PROJECT_ROOT: string
  readonly STORE_DIR: string
  readonly DB_FILENAME: string
  readonly PID_FILENAME: string
  readonly SCHEDULER_TZ_CONFIGURED: string | undefined
  readonly APP_TZ: string
  readonly APP_TZ_INVALID: string | undefined
  readonly DEFAULT_AGENT_MODEL: string
  readonly TELEGRAM_BOT_TOKEN: string
  readonly ALLOWED_CHAT_ID: string
  readonly SLACK_BOT_TOKEN: string
  readonly SLACK_APP_TOKEN: string
  readonly SLACK_CHANNEL_ID: string
  readonly OWNER_NAME_PLACEHOLDER: string
  readonly OWNER_NAME: string
  readonly OWNER_DRIVE_FOLDER: string
  readonly BOT_NAME: string
  readonly BRAND_NAME: string
  readonly MAIN_AGENT_ID: string
  readonly SERVICE_ID: string
  readonly LEGACY_SERVICE_ID: string
  readonly LEGACY_APP_SERVICE_LABEL: string
  readonly WEB_PORT: number
  readonly WEB_HOST: string
  readonly KANBAN_AGING_WARN_H: number
  readonly KANBAN_AGING_CAUTION_H: number
  readonly KANBAN_AGING_CRITICAL_H: number
  readonly KANBAN_AGING_WARN_COLOR: string
  readonly KANBAN_AGING_CAUTION_COLOR: string
  readonly KANBAN_AGING_CRITICAL_COLOR: string
  readonly KANBAN_WIP_PLANNED: number
  readonly KANBAN_WIP_IN_PROGRESS: number
  readonly KANBAN_WIP_TESTING: number
  readonly KANBAN_WIP_WAITING: number
  readonly KANBAN_WIP_DONE: number
  readonly KANBAN_WIP_WARN_PCT: number
  readonly KANBAN_WIP_OK_COLOR: string
  readonly KANBAN_WIP_WARN_COLOR: string
  readonly KANBAN_WIP_FULL_COLOR: string
  readonly KANBAN_WIP_OVER_COLOR: string
  readonly DASHBOARD_PUBLIC_URL: string
  readonly DASHBOARD_ALLOWED_ORIGINS: string
  readonly OLLAMA_URL: string
  readonly KANBAN_SWIMLANE_DEFAULT_GROUP: 'none' | 'assignee' | 'priority'
  readonly KANBAN_SWIMLANE_SEPARATOR_COLOR: string
  readonly KANBAN_LABEL_COLORS: string[]
  readonly CHANNEL_PROVIDER: ChannelProviderType
  readonly CHANNEL_TOKEN: string
  readonly CHANNEL_CHAT_ID: string
  readonly RESPAWN_ENABLED: boolean
  readonly HEARTBEAT_INTERVAL_MS: number
  readonly HEARTBEAT_START_HOUR: number
  readonly HEARTBEAT_AGENT_ENABLED: boolean
  readonly SUBAGENT_INBOX_TEE: boolean
  readonly SUBAGENT_TELEGRAM_WAKE_ENABLED: boolean
  readonly HEARTBEAT_CALENDAR_ACCOUNT: string
  readonly HEARTBEAT_END_HOUR: number
  readonly HEARTBEAT_CALENDAR_ID: string

  // -- the parsed env record: read by D's ChannelEnv via constructor --
  readonly env: Record<string, string>

  // -- per-call env re-reads (formerly free functions, now instance methods) --
  currentBotName(): string
  currentBrandName(): string
  currentOwnerName(): string

  // -- static helpers: pure functions, no this-state --
  static resolveAppTz(configured: string | undefined, systemTz?: string): { tz: string; configured?: string; invalid?: string }
  static resolveBrandName(brandEnv: string | undefined, botName: string): string
  static resolveServiceId(brandSlug: string, mainAgentId: string): string
  static brandSlug(raw: string): string
  static appServiceLabel(serviceId: string): string
  static launchdStatusPattern(serviceId: string): string
  static systemdStatusUnits(serviceId: string): string[]

  // -- factory: reads .env + config-overrides.json; the singleton construction site --
  static fromEnv(): Config

  // -- bulk snapshot for dashboard chrome + /api/settings --
  list(): Record<string, string | number | boolean | string[] | undefined>

  // -- reload: re-reads .env + config-overrides.json (used by tests; future HMR use) --
  reload(): void
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| (constructor — implicit no-arg) | n/a | n/a | `Config.fromEnv()` is the singleton factory; the constructor itself takes no args because the `env` field is populated by `fromEnv`. Tests pass a partial values map via `new Config({ WEB_PORT: 4000, ... })` (alternative overload — see "Constructor" below). |
| `currentBotName()` | `currentBotName()` | `config.ts:168-171` | Reads `readEnvFile(['BOT_NAME'])['BOT_NAME']`, falls back to `this.BOT_NAME`. Already instance-shaped (closes over module-level `env` and `BOT_NAME`); class form closes over `this.env` and `this.BOT_NAME`. |
| `currentBrandName()` | `currentBrandName()` | `config.ts:172-174` | Reads `readEnvFile(['BRAND_NAME'])['BRAND_NAME']`, delegates to `currentBotName()`. |
| `currentOwnerName()` | `currentOwnerName()` | `config.ts:175-178` | Reads `readEnvFile(['OWNER_NAME'])['OWNER_NAME']`, falls back to `this.OWNER_NAME`. |
| `static resolveAppTz(configured, systemTz?)` | `resolveAppTz(configured, systemTz?)` | `config.ts:85-92` | Pure function; static because no `this` state. Preserved free-function export during migration window. |
| `static resolveBrandName(brandEnv, botName)` | `resolveBrandName(brandEnv, botName)` | `config.ts:158-161` | Pure function; static. |
| `static resolveServiceId(brandSlug, mainAgentId)` | `resolveServiceId(brandSlug, mainAgentId)` | `config.ts:184-187` | Pure function; static. |
| `static brandSlug(raw)` | `brandSlug(raw)` | `config.ts:194-202` | Pure function; static. |
| `static appServiceLabel(serviceId)` | `appServiceLabel(serviceId)` | `config.ts:230-232` | Pure function; static. |
| `static launchdStatusPattern(serviceId)` | `launchdStatusPattern(serviceId)` | `config.ts:248-250` | Pure function; static. |
| `static systemdStatusUnits(serviceId)` | `systemdStatusUnits(serviceId)` | `config.ts:257-259` | Pure function; static. |
| `static fromEnv()` | the module-level `env = readEnvFile()` + `overrides = readConfigOverrides()` at `config.ts:17/36` | n/a | The factory that constructs the singleton; reads `.env` once via `readEnvFile()` and `config-overrides.json` once via `readConfigOverrides()`. Returns `new Config()`. |
| `list()` | n/a (new) | n/a | Returns `{ PROJECT_ROOT, STORE_DIR, DB_FILENAME, …, HEARTBEAT_CALENDAR_ID }` — the 58-field snapshot used by `/api/settings` (today hand-rolled). Reasonable addition per `02-type-interface-analysis.md §3.4`. |
| `reload()` | n/a (new) | n/a | Re-reads `readEnvFile()` + `readConfigOverrides()`, re-initialises the 58 fields. Used by tests that want to swap `.env` between cases; future HMR use. **Optional** — only add if B.2-B.4 surfaces a real consumer need (per CLAUDE.md §2 Simplicity First). |

### Constructor

The constructor shape is **hybrid**:

```ts
class Config {
  // (a) no-arg: used by Config.fromEnv() to build the singleton
  constructor()

  // (b) values override: used by tests
  constructor(values?: Partial<{
    [K in keyof ConfigFields]: ConfigFields[K]
  }>)
}
```

TypeScript does not support overload declarations on classes with
implementation; the actual implementation accepts `values?: Record<string, unknown>`
and merges them over the `fromEnv()` defaults. Per
`02-type-interface-analysis.md §3.3`, the "drop-in replacement" shape
(a) is the recommended one because (i) every existing importer keeps
working — `WEB_PORT` becomes `config.WEB_PORT` via the re-export shim,
not by rewriting every importer; (ii) tests do `new Config({ WEB_PORT: 4000 })`
without `vi.mock('../config.js')`.

- **No I/O in the constructor body.** `fromEnv()` does the I/O and
  calls the constructor with the parsed `env` + `overrides`. The
  constructor itself is pure field assignment.
- **No logger.** Per `02-type-interface-analysis.md §1.7` and §3.6,
  the 2 `grep -nE "logger\|log\." src/config.ts` matches are both in
  comments (L103 and L376). The L103 comment explicitly explains the
  circular-import constraint (`logger.ts` imports `config.ts` for the
  `APP_TZ_INVALID` value, the logger uses in the boot banner). The
  class form does not gain a `log: LoggerLike` field — rejected in
  `02-type-interface-analysis.md §3.6` because (a) the loud APP_TZ_INVALID
  reporting already works (it lives in `startScheduleRunner` per
  `web/schedule-runner.ts:1029`), (b) every `Config` instance would
  need a logger even when the tz was valid, (c) tests would be noisier.
  The constraint changes with the class form (an instance `Config` is
  constructed after `logger.ts` has been imported) but the decision is
  still **no logger field**.

### Why `env` is a public readonly field (not private)

Per `02-type-interface-analysis.md §3.7`, a typed `env: Record<'WEB_PORT' | 'BOT_NAME', string>`
generic is rejected on OE-6 grounds (single consumer; hand-maintained key
list drifts from `.env`). The untyped `env: Record<string, string>` is
**public** because:

1. **D's `ChannelEnv` consumes it.** Per
   `d-channel-provider/03-class-boundaries.md:71`, `ChannelEnv`'s
   constructor takes `(env: Record<string, string>, home?)`. The
   construction site is `config.ts:325-326` today:
   ```ts
   export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)
   export const CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, env)
   ```
   After B.1, this becomes `Config.env` accessed at `ChannelEnv`
   construction time. Hiding it behind a private field would force D
   to import the `env` from the same module via a side door; exposing
   it is the cleanest seam.
2. **The type is the same as today's `const env = readEnvFile()` at L17.**
   `readEnvFile()` returns `Record<string, string>` (`env.ts:13`); the
   field type matches.

### Generic params

**None.** Per `02-type-interface-analysis.md §3.7`, `Config<TEnv extends
Record<string, string>>` is rejected: the only consumer of a typed env
would be the constructor's own default-building logic, and a literal-union
of env-keys would require every env key to be enumerated (a hand-maintained
type that drifts from `.env` the day someone adds a new key).

### Dependencies

- `readEnvFile` (`env.ts:13`) — called from `Config.fromEnv()`.
- `readConfigOverrides` — module-private helper at `config.ts:28-35`;
  called from `Config.fromEnv()`.
- `DISTRIBUTION_DEFAULT_AGENT_MODEL` (`config-registry.ts:16`) — used
  at `config.ts:113-114`'s `cfg('DEFAULT_AGENT_MODEL') || DISTRIBUTION_DEFAULT_AGENT_MODEL`.
- `getProviderType` / `getChannelToken` / `getChannelChatId` /
  `ChannelProviderType` (`channel-provider.ts:512/459/467/9`) — used at
  `config.ts:324-326` for the 3 channel consts.
- `CronExpressionParser` (`cron-parser`, npm) — used by `isUsableCronTz`
  (L69-83) which is private to `resolveAppTz`.
- `hostname` (`node:os`) — used at `config.ts:346` for `RESPAWN_ENABLED`.
- `existsSync` / `readFileSync` (`node:fs`), `dirname` / `join` (`node:path`),
  `fileURLToPath` (`node:url`) — used by the path-derivation helpers
  (`__dirname`/`PROJECT_ROOT`/`STORE_DIR` at L10-13) and by
  `readConfigOverrides` (L30-31).

### Lifecycle

- **One instance per process** — the module-level singleton `config =
  Config.fromEnv()` constructed at the bottom of `config.ts` (after
  the 58 const initialisers). All 60 importers re-export the fields
  off this singleton via the re-export shim (e.g.
  `export const WEB_PORT = config.WEB_PORT`).
- **One instance per test** — tests construct `new Config({ WEB_PORT: 4000, … })`
  for isolation; the singleton is replaced by `createTestConfig(overrides?)`
  per `review-completeness.md` CE-5.
- **`reload()` is exposed** as a test seam (and for future HMR use,
  per `02-type-interface-analysis.md §3.4`); not called in production
  today.

### Free functions / patterns that REMAIN after B.1

| Symbol | Location | Why it stays |
|---|---|---|
| All 58 `export const` declarations | `config.ts` (various lines) | **Re-export shim.** Each `export const WEB_PORT = config.WEB_PORT` keeps the existing import path working until B.6. Removed in B.6 once the 60 importers migrate. |
| `resolveAppTz(configured, systemTz?)` | `config.ts:85-92` | Re-exported as `Config.resolveAppTz`. Same import path. Removed in B.6. |
| `resolveBrandName(brandEnv, botName)` | `config.ts:158-161` | Re-exported as `Config.resolveBrandName`. Removed in B.6. |
| `currentBotName()` | `config.ts:168-171` | Re-exported as `config.currentBotName()` (the **module-scope singleton** must be used, not the class). Removed in B.6. |
| `currentBrandName()` | `config.ts:172-174` | Same. |
| `currentOwnerName()` | `config.ts:175-178` | Same. |
| `resolveServiceId(brandSlug, mainAgentId)` | `config.ts:184-187` | Re-exported as `Config.resolveServiceId`. Removed in B.6. |
| `brandSlug(raw)` | `config.ts:194-202` | Re-exported as `Config.brandSlug`. Removed in B.6. |
| `appServiceLabel(serviceId)` | `config.ts:230-232` | Re-exported as `Config.appServiceLabel`. Removed in B.6. |
| `launchdStatusPattern(serviceId)` | `config.ts:248-250` | Re-exported as `Config.launchdStatusPattern`. Removed in B.6. |
| `systemdStatusUnits(serviceId)` | `config.ts:257-259` | Re-exported as `Config.systemdStatusUnits`. Removed in B.6. |
| `readConfigOverrides()` | `config.ts:28-35` | Becomes a private method on `Config`; also kept as a free export during the migration window for direct-import tests. [ASSUMPTION: zero direct importers today; verified by `grep -rn "readConfigOverrides" src/ --include='*.ts' | grep -v __tests__` — only the call at L36 in `config.ts` itself.] |
| `envOr(key, fallback)` | `config.ts:133-135` | Becomes a private method; used inside `Config.fromEnv()`. Not exported. |
| `isUsableCronTz(tz)` | `config.ts:69-83` | Stays module-private; used by `resolveAppTz`. |
| `cfg(key)` | `config.ts:39-43` | Stays module-private (internal to `config.ts`). Becomes a private method on `Config` (or stays at module scope). |
| The module-scope `config = Config.fromEnv()` | `config.ts` (new line at end) | **The singleton.** All re-exports point at this instance. |

### Free functions that DO NOT exist on the class

- **A `Config.get<K extends keyof ConfigFields>(key: K): ConfigFields[K]`
  accessor.** Rejected per `02-type-interface-analysis.md §3.5`:
  identical to direct field access (`config.WEB_PORT` is already typed
  as `number`), adds indirection for zero compile-time gain.
- **A `log: LoggerLike` field.** Rejected per `02-type-interface-analysis.md §3.6`:
  zero log call sites today; the loud `APP_TZ_INVALID` reporting stays
  in `startScheduleRunner` (`web/schedule-runner.ts:1029`).
- **A `reload(): Promise<void>` async method.** The plan sketches a
  sync `reload()` (above) for test use; an async variant is rejected
  per CLAUDE.md §2 (Simplicity First) — the re-read is synchronous
  (`readFileSync` + `existsSync` at L30-31) and the 58 field
  re-assignments are not awaitable.

---

## B2. `SettingsRegistry` — **NOT BUILT** (per `review-completeness.md` OE-8)

### Decision

**No class wrap.** `SETTINGS_REGISTRY: SettingDefinition[]` at
`config-registry.ts:37` stays as a `const`; the 3 pure helpers
(`getSettingDefinition` at L432-434, `listSettingModules` at L436-438,
`validateSettingValue` at L449-484) stay as `export function`. The
`SettingDefinition` interface (L20-33), `SettingValidationResult`
interface (L440-445), and `SettingType` type alias (L18) stay as today.

### Rationale (OE-8 verbatim from `review-completeness.md`)

> "`getDefinition`, `listModules`, `validate` are pure functions over
> the array; they can stay as `export function` in the existing module
> without an instance. Drop the class wrap; keep the registry as a
> `const` and the helpers as free functions."

This analysis agrees (`02-type-interface-analysis.md §4`):

1. **The array is frozen at module load.** `SETTINGS_REGISTRY: SettingDefinition[]`
   is built once from a literal at L37 (35 entries, verified by counting
   `{` opens between L37 and L430). No production code mutates it
   (`grep -rn "SETTINGS_REGISTRY.push\|SETTINGS_REGISTRY\[" src/` returns 0).
2. **The helpers are pure.** `getSettingDefinition` (L432-434) does only
   `.find()`; `listSettingModules` (L436-438) does only `[...new Set(...)]`;
   `validateSettingValue` (L449-484) takes its inputs as parameters and
   dispatches on `def.type`. None reads mutable state.
3. **`define`/`undefine` would exist only for `vi.mock`.** Per OE-8,
   the only path that *could* mutate the registry is test overrides
   via `vi.mock('../config-registry.js', …)`. Module-level mock
   replacement is a `vitest` affordance; it does not require the module
   to expose mutation methods. Tests today mock the *whole module* and
   replace the exports; they do not call `define`/`undefine`.
4. **Promoting to a class adds boilerplate for production-zero behaviour
   change.** A `SettingsRegistry` class would have a constructor (no
   args), `getDefinition(key)`, `listModules()`, `listKeys()`,
   `validate(def, raw)`, possibly `define(entry)` / `undefine(key)` —
   and the `define`/`undefine` methods would be unused in production.

### What B.7 delivers

A **verification** (not a code change):

1. Run `grep -rln "define\|undefine" src/config-registry.ts` — must
   return 0 (no production mutation path introduced).
2. Run `grep -rln "SETTINGS_REGISTRY\[" src/` — must return 0
   (no array-index assignment introduced).
3. Confirm the 35-entry literal is byte-identical pre- and post-B.
4. Add a one-paragraph note to `docs/refactor-to-classbase/b-config/00-summary.md`
   stating "OE-8 verified: registry stays as `const` + 3 free functions".

If any of (1)-(3) fails, the OE-8 decision has been violated by some
unrelated change and B.7 is the tripwire.

### Free functions that REMAIN (unchanged) after B.7

| Symbol | Location | Notes |
|---|---|---|
| `DISTRIBUTION_DEFAULT_AGENT_MODEL` | `config-registry.ts:16` | Single source of truth for `config.ts:114`'s `cfg('DEFAULT_AGENT_MODEL') \|\| DISTRIBUTION_DEFAULT_AGENT_MODEL` fallback. |
| `SETTINGS_REGISTRY` | `config-registry.ts:37` | The 35-entry literal. `readonly` in practice (no mutations exist); could be tightened to `readonly SettingDefinition[]` but no consumer benefits. |
| `getSettingDefinition(key: string)` | `config-registry.ts:432-434` | Pure `.find()` lookup. |
| `listSettingModules()` | `config-registry.ts:436-438` | Pure `[...new Set(...)]` derivation. |
| `validateSettingValue(def, raw)` | `config-registry.ts:449-484` | Pure validator; dispatches on `def.type`. |
| `SettingType` type alias | `config-registry.ts:18` | The 4-member literal union `'int' \| 'string' \| 'color' \| 'boolean'`. |
| `SettingDefinition` interface | `config-registry.ts:20-33` | 7 required + 3 optional fields. |
| `SettingValidationResult` interface | `config-registry.ts:440-445` | The result of `validateSettingValue`. |
| `HEX_COLOR_RE` | `config-registry.ts:35` | Non-exported regex; used only by `validateSettingValue`'s `'color'` branch. |

---

## Summary of free functions vs class surface after B.1

| Symbol | After B.1 | Notes |
|---|---|---|
| `Config` class | **new** | B.1 deliverable; 58 readonly fields + 3 instance methods + 7 static methods + `fromEnv()` + `list()` + `reload()`. |
| All 58 `export const` declarations | re-export shim | `export const WEB_PORT = config.WEB_PORT` etc.; survives until B.6. |
| All 10 `export function` declarations | re-export shim | `export const resolveAppTz = Config.resolveAppTz` for the static ones; `export const currentBotName = () => config.currentBotName()` for the instance ones; survives until B.6. |
| `SettingsRegistry` class | **not built** | OE-8 verified by B.7. |
| `SETTINGS_REGISTRY` + 3 helpers | free exports | Unchanged. |
| The module-scope `config = Config.fromEnv()` singleton | **new** | B.1 deliverable; the instance the re-export shim points at. |
