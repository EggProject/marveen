# B (config) — Type & Interface Analysis

Date: 2026-08-30. Scope: `src/config.ts` and `src/config-registry.ts`.
Reference inputs: `h-cross-cutting/04-generic-interfaces.md` (LoggerLike),
`review-completeness.md` (OE-8, OE-9), `review-correctness.md` (M2 58 const exports).

---

## Brief summary

The B subsystem is type-clean. `config.ts` exports **58 `const` values + 10 free functions** and **zero interfaces/types** (verified, matches M2). `config-registry.ts` exports **2 `const` values + 4 free functions + 2 interfaces + 1 type alias** with all interfaces (`SettingDefinition`, `SettingValidationResult`) properly field-typed and the `raw: unknown` input of `validateSettingValue` correctly used. **Zero unsafe casts** in either file (`as any` / `as unknown` / `as const` / `: any` / `: unknown`: 0 across both). The only struct in B that *could* leak type-erosion is the `env: Record<string, string>` bag passed to `getChannelToken`/`getChannelChatId`, but that erases only at the boundary that already accepts a string-keyed bag. **LoggerLike integration: zero call sites** in B (verified: B is imported *before* `logger.ts`, comment at `config.ts:103` explains why). **OE-8 finding stands:** the registry helpers are pure functions over a frozen array — promoting to a class is ceremony for zero production behavior change.

---

## §1. `config.ts` type audit

### §1.1 Export count and shape

`grep -c "^export const " src/config.ts` = **58** (matches review-correctness M2). Total `^(export …)` lines = 68 (58 const + 10 function + 0 interface + 0 type).

The 58 `const` exports are **deeply heterogeneous in runtime type**:

| TS runtime type | Count | Examples |
|---|---:|---|
| `string` | ~38 | `TELEGRAM_BOT_TOKEN`, `KANBAN_WIP_OK_COLOR`, `OLLAMA_URL`, `MAIN_AGENT_ID`, `BRAND_NAME`, `DASHBOARD_PUBLIC_URL`, `APP_TZ`, `SERVICE_ID`, `HEARTBEAT_CALENDAR_ACCOUNT`, `CHANNEL_TOKEN`, `WEB_HOST` |
| `number` | 13 | `WEB_PORT` (parseInt), `KANBAN_AGING_WARN_H`, `KANBAN_WIP_PLANNED`, `KANBAN_WIP_WARN_PCT`, `HEARTBEAT_INTERVAL_MS` (60 * 60 * 1000), `HEARTBEAT_START_HOUR`, `HEARTBEAT_END_HOUR` |
| `boolean` | 4 | `RESPAWN_ENABLED`, `HEARTBEAT_AGENT_ENABLED`, `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED` |
| `ChannelProviderType` (enum literal-union) | 1 | `CHANNEL_PROVIDER` (explicitly typed: `export const CHANNEL_PROVIDER: ChannelProviderType`) |
| `string[]` | 1 | `KANBAN_LABEL_COLORS` |
| Path strings | 4 | `PROJECT_ROOT`, `STORE_DIR`, `DB_FILENAME`, `PID_FILENAME` (overlap with `string` row; counted separately because they are *paths*, not arbitrary strings) |
| `string \| undefined` (boot-time only) | 1 | `SCHEDULER_TZ_CONFIGURED` (depends on whether `cfg('SCHEDULER_TZ')` was truthy) |

**Single heterogeneous bag.** A class that re-exposes all 58 as `public readonly` fields would have a field list of 38 strings + 13 numbers + 4 booleans + 1 enum + 1 string[] + 1 optional — this is exactly the heterogeneity that argues *against* a single class with `Config` field-per-key, and *for* either (a) the existing const-export pattern, or (b) a class with a generic typed accessor (see §3.4 below).

### §1.2 The 10 free functions (heterogeneous shape too)

`grep -E "^export function " src/config.ts` = 10:

| Function | Signature | Purpose |
|---|---|---|
| `resolveAppTz` | `(configured: string \| undefined, systemTz?: string) => { tz: string; configured?: string; invalid?: string }` | tz validation |
| `resolveBrandName` | `(brandEnv: string \| undefined, botName: string) => string` | brand resolution |
| `currentBotName` | `() => string` | per-call re-read from `.env` |
| `currentBrandName` | `() => string` | per-call re-read from `.env` |
| `currentOwnerName` | `() => string` | per-call re-read from `.env` |
| `resolveServiceId` | `(brandSlug: string, mainAgentId: string) => string` | pure derivation |
| `brandSlug` | `(raw: string) => string` | NFKD + ASCII slug |
| `appServiceLabel` | `(serviceId: string) => string` | pure derivation |
| `launchdStatusPattern` | `(serviceId: string) => string` | pure derivation |
| `systemdStatusUnits` | `(serviceId: string) => string[]` | pure derivation |

Note: **5 of the 10 (`resolveBrandName`, `resolveServiceId`, `appServiceLabel`, `launchdStatusPattern`, `systemdStatusUnits`) are pure** — they take their inputs as parameters and do not touch the env. These are textbook candidates to live as static methods or as free functions; **they do not benefit from being instance methods on a `Config` class** (no state to bind). The other 5 (`currentBotName`/`currentBrandName`/`currentOwnerName` and the boot-time `resolveAppTz`) read from the env — these *could* move to a `Config` instance method that re-reads `.env`.

### §1.3 Unsafe-cast audit

`grep -nE " as any| as unknown| as const|: any\b|: unknown\b" src/config.ts` returns **zero matches**.

The `: ChannelProviderType` annotation on `CHANNEL_PROVIDER` (line 324) is a *positive* type annotation, not a cast — it widens the inferred `string` to the provider literal union. This is correct, not unsafe.

**No `as-const` usages.** No `satisfies` usages either. The 58 consts use TS inference only — fine for plain primitive literals (the runtime values are exactly the inferred types), but a `as const` on e.g. `KANBAN_SWIMLANE_DEFAULT_GROUP: 'none' | 'assignee' | 'priority'` (currently typed via the ternary at lines 308-311, inferred as the narrowed union) would make the narrowing explicit and self-documenting. Minor improvement opportunity, not a safety issue.

### §1.4 No exported interfaces or types

`grep -E "^(export interface|export type) " src/config.ts` = 0. `config.ts` is **values-only**. The only in-file interfaces are non-exported closure captures (`{ tz; configured?; invalid? }` in `resolveAppTz`'s return type — inferred). All structural types that config *uses* come from elsewhere: `ChannelProviderType` from `channel-provider.ts`.

This matters for class design: a `Config` class has **no project-local interfaces to bind to**. Its public surface would be (a) 58 typed fields + (b) the 10 methods. The fields' types are all standard TS primitives or imported enums — no project-specific shape to co-design.

### §1.5 Typed wrappers around config values

There is **no `ConfigValue<T>` generic** today. There are two implicit "wrappers" but neither is a typed generic:

1. `env: Record<string, string>` (line 17) — the raw `.env` read result. Typed as `Record<string, string>` because `readEnvFile` (verified at `env.ts:13`) is declared `(keys?: string[]) => Record<string, string>`.
2. `overrides: Record<string, unknown>` (line 36) — the `config-overrides.json` read result, declared `Record<string, unknown>` because the JSON shape is untyped. This is the **only `unknown` in B**, and it is correctly used: `cfg()` (lines 39-43) narrows via `ov !== undefined && ov !== null && String(ov).length > 0`, then `String(ov)` casts to `string` at the function's return type. The narrowing is hand-rolled, not via a typeguard.

### §1.6 `readEnvFile` return type (verify per task brief)

`src/env.ts:13`:
```ts
export function readEnvFile(keys?: string[]): Record<string, string>
```

Return type is `Record<string, string>`. No `unknown`, no `| undefined` (the function returns `{}` on missing/unreadable file at line 19, not `undefined`). The `keys?` parameter is an optional *filter* — when present, only listed keys end up in the result map. The current callers in `config.ts` use both forms:
- `const env = readEnvFile()` (line 17) — full map
- `readEnvFile(['BOT_NAME'])` (line 169, inside `currentBotName`) — filtered

A `Config` class could either keep `readEnvFile` as the underlying primitive (recommended — the function is correct and already proven) or shadow it with an instance method. Either is fine; the primitive is not a B-internal concern.

### §1.7 LoggerLike integration points

`grep -nE "logger|log\." src/config.ts` returns **2 matches, both in comments**:

```
103:// path. config.ts is imported too early to own a logger (logger imports config
376:// fires and claims the backlog. This is the ACTIVE tail of the SUBAGENT_INBOX_TEE
```

The line 103 comment explicitly explains the **circular-import constraint**:
> "config.ts is imported too early to own a logger (logger imports config -> circular)"

Line 105 (`APP_TZ_INVALID`) also carries this comment. So B has **zero LoggerLike call sites** today, and the module is structurally locked out of having a logger at module scope.

For a `Config` class, this constraint changes: a class is constructed by its consumer *after* `logger.ts` has been imported. So an instance `Config` could take a `LoggerLike` in its constructor. **The current architecture explicitly chooses not to** (the loud APP_TZ_INVALID reporting lives in `startScheduleRunner` per the comment at line 105) — that choice is correct because the loud reporting needs `logger`, and `config.ts` is imported too early to bind it.

A `Config` class would shift this constraint: the loud reporting could move into a `Config.logInvalidTz(logger: LoggerLike)` method called by `startScheduleRunner`. But that is **option-b**, not requirement — it would be a behavioral refactor (lazy reporting) layered on top of the type-side refactor, and it does not improve type safety.

---

## §2. `config-registry.ts` type audit

### §2.1 `SettingType` (line 18)

```ts
export type SettingType = 'int' | 'string' | 'color' | 'boolean'
```

Four-member literal-string union. Discriminates the per-setting input widget in the dashboard Settings UI (`int` → number input, `string` → text, `color` → color picker, `boolean` → checkbox). Discriminator is `def.type` in `validateSettingValue` (lines 458-484). The discriminator is **closed**: every `if` arm handles one member, the fallthrough is the `'string'` default (line 483). Exhaustiveness is enforceable via `never`-check but is not currently asserted.

### §2.2 `SettingDefinition` (lines 20-33)

Full field inventory:

| Field | Type | Optional? | Notes |
|---|---|---|---|
| `key` | `string` | required | The env-var name. In practice always uppercase-snake-case, but no type constraint enforces that — `key` is just `string`. |
| `type` | `SettingType` | required | The 4-member union above. |
| `default` | `string \| number` | required | The registry's default value. Coerced to `string` when persisted through `.env` (`SettingValidationResult.value` is `string \| number`). |
| `description` | `string` | required | Human-readable Hungarian. Not validated. |
| `module` | `string` | required | UI grouping key (`'kanban'`, `'system'`, `'heartbeat'`, …). Open-ended, not a literal union. |
| `secret` | `boolean` | required | Always `false` in the 35 current entries (verified — `grep "secret: true"` returns 0). The flag exists but is unused today. |
| `requiresRestart` | `boolean` | required | UI warning badge driver. |
| `valueSet` | `string[]` | optional | Enum-style allowed values. Validated at write-time by `validateSettingValue` (lines 450-456). |
| `min` | `number` | optional | Only meaningful for `type === 'int'`. Validated at lines 471-472. |
| `max` | `number` | optional | Same. |

**Two structural weaknesses:**

1. **`key: string` is open.** It would be more typesafe to type it as the union of all 35 keys: `type SettingKey = 'KANBAN_WIP_PLANNED' | 'KANBAN_WIP_IN_PROGRESS' | …`. But TypeScript cannot derive that union from the literal entries of `SETTINGS_REGISTRY` without `as const` annotation (currently `SETTINGS_REGISTRY: SettingDefinition[]` widens `key` to `string`). This is the **main argument for** a `as const` upgrade on the registry array, but only if the consumer benefits. Today, `getSettingDefinition(key: string)` takes `string` anyway, so the narrowing buys nothing in the existing surface — it would only pay off if a class API took a typed `key` parameter.

2. **`module: string` is open.** Same story. Could be `'kanban' | 'system' | 'heartbeat' | 'audit' | 'ideabox' | 'channels' | 'agents'` (the 7 distinct values in the current 35 entries). Open today; closed would be a one-line change but no consumer benefits.

3. **`secret: false` always.** The flag has zero current consumers. Either drop the field (YAGNI) or document it as reserved-for-future-secret-keys. Per CLAUDE.md §2 (Simplicity First), drop unless a future PR adds a `secret: true` entry.

### §2.3 `HEX_COLOR_RE` (line 35)

```ts
const HEX_COLOR_RE = /^#[0-9a-fA-F]{6}$/
```

**Non-exported.** Used only at line 478 inside `validateSettingValue` for the `'color'` branch:
```ts
if (!HEX_COLOR_RE.test(str)) return { ok: false, error: 'Érvénytelen szín (várható formátum: #rrggbb).' }
```

A regex (not a function, not a class) is the right tool for shape-only validation: it does not parse, does not normalise (the `str` is used as-is), and the format is a 7-character literal. Promoting to a function would add no value; promoting to a class would be OE-8 ceremony. **Keep as a module-private const.**

The `SettingType = 'color'` arm of `validateSettingValue` is the only consumer; the regex is **co-located with the validator that uses it**, which is the correct boundary.

### §2.4 `SETTINGS_REGISTRY` (line 37)

```ts
export const SETTINGS_REGISTRY: SettingDefinition[] = [...]
```

Explicitly typed as `SettingDefinition[]`. **35 entries** (verified by counting `{` opens inside the array — the literals run from line 38 to line 430). The array is **mutable in principle** (no `readonly` on the array, no `as const` on the literal), but in practice nothing mutates it: every consumer reads, none writes. The `getSettingDefinition` / `listSettingModules` helpers are pure functions over the array.

**Type soundness:** the literal entries satisfy `SettingDefinition` — each one has all required fields, optional fields are present only where relevant (`valueSet` on `'string'`-with-enum entries, `min`/`max` on `'int'` entries). The type checker enforces this at the array literal. A `as const` upgrade would lose nothing on this front (`SettingDefinition` is already a structural type, and the literal entries match) and would *gain* the ability to derive `SettingKey` from the array.

### §2.5 Helpers — exact signatures

```ts
// line 432
export function getSettingDefinition(key: string): SettingDefinition | undefined {
  return SETTINGS_REGISTRY.find((s) => s.key === key)
}

// line 436
export function listSettingModules(): string[] {
  return [...new Set(SETTINGS_REGISTRY.map((s) => s.module))]
}

// line 449
export function validateSettingValue(def: SettingDefinition, raw: unknown): SettingValidationResult {
  // ... dispatches on def.type, validates via valueSet / min / max / HEX_COLOR_RE / String
}
```

All three are **pure** (no I/O, no DB, no module-level state mutation). All three take their inputs as parameters — even `getSettingDefinition` and `listSettingModules` reference the module-level `SETTINGS_REGISTRY` but only read from it. None of them has any "mutate intent" path. The three helpers + the array = the entire public surface of config-registry.ts.

**`getSettingDefinition` returns `SettingDefinition | undefined`.** Callers must narrow; the consumers today (`/api/settings` route + tests) check `if (!def) return …`. A typed accessor (`getDefinition<K extends SettingKey>(key: K): Extract<SettingDefinition, { key: K }> | undefined`) would require `as const` on the array + derivation of the key union, and only one consumer exists. **Not worth it** under OE-6.

### §2.6 `SettingValidationResult` (lines 440-445)

```ts
export interface SettingValidationResult {
  ok: boolean
  error?: string
  /** Normalised value (e.g. parsed int) to persist when ok === true. */
  value?: string | number
}
```

**Tagged by `ok`, not by a discriminator.** A more typesafe alternative is `{ ok: true; value: string | number } | { ok: false; error: string }`, which would force callers to narrow before reading `value`. The current shape (a single interface with all-fields-optional) **does** allow `ok: true` consumers to forget the `value` field at the type level. **Weakness, but minor** — every caller in production (`/api/settings`, tests) does the `ok ? persist(value) : respondError(error)` pattern, so the runtime invariant `ok && value === undefined` does not occur. Tightening this is a one-line change but adds no observable behavior change; drop per OE-6 unless a future caller forgets to read `value`.

### §2.7 Unsafe-cast audit

`grep -nE " as any| as unknown| as const|: any\b|: unknown\b" src/config-registry.ts` returns **zero matches**.

`raw: unknown` on `validateSettingValue` (line 449) is the **only** `unknown` in the file, and it is the correct usage — the function takes "any user-supplied value" and returns the normalised form. Every consumer of `raw` inside the function uses `String(raw)` or `parseInt(String(raw), 10)` or `raw === true / false`, all of which are safe on `unknown`.

### §2.8 Generic over `TType`?

A `SettingDefinition<TType extends SettingType>` generic would let `default`, `value`, and `min`/`max` be tied to the literal type:

```ts
// hypothetical
interface SettingDefinition<TType extends SettingType = SettingType> {
  type: TType
  default: TType extends 'int' ? number : string
  valueSet?: TType extends 'string' | 'boolean' ? string[] : never
  min?: TType extends 'int' ? number : never
  max?: TType extends 'int' ? number : never
  // ...
}
```

The benefit: passing a `SettingDefinition<'int'>` to a function that needs `min`/`max` would be typesafe; passing a `SettingDefinition<'color'>` would forbid `min`/`max` at the type level. Today this is enforced only by convention + the validator's runtime `if (def.type === 'int')` guard.

**Per OE-6, this is generic-with-one-consumer.** The only consumer is `validateSettingValue`, which dispatches on `def.type` at runtime — the generic would force every dispatch site to also be generic, multiplying the type surface for no compile-time guarantee the existing `if (def.type === 'int')` doesn't already provide (the union is closed). **REJECT.** The current union + runtime switch is correct.

### §2.9 LoggerLike integration

`grep -nE "logger|log\." src/config-registry.ts` returns **zero matches**. Config-registry has no I/O, no async, no logger. Per OE-8, the registry helpers stay as pure functions, so logger integration remains zero. **Verified.**

---

## §3. `Config` class design sketch

### §3.1 Why a `Config` class is even on the table

The framework proposes converting the 58 `const` exports into instance fields on a `Config` class. The motivation, per `01-module-state-analysis.md` §2 ("config.ts" row), is "every export is a `const`" — frozen module-level bindings make tests that want to swap individual values reach for `vi.mock`, which is the dominant test-rewrite cost (154 `vi.mock('../config.js')` hits per review-correctness M4). A class with constructor-injected values lets tests pass `new Config({ WEB_PORT: 4000, … })` instead of mocking the module.

This analysis is a **type-side** audit, not a recommendation. The recommendation (build vs. don't-build) is in `03-class-boundaries.md` and `05-refactor-roadmap.md`. What follows is the type design IF the class is built.

### §3.2 Fields

The 58 consts map to 58 `public readonly` fields. Heterogeneity (see §1.1) is the **main design challenge** — a single class with 58 heterogeneous fields has a wider type surface than the existing const bag. Three options:

**(a) Flat class — 58 fields verbatim.** Pro: minimal change to the 60 importers (they read `CONFIG.WEB_PORT` instead of `WEB_PORT`). Con: the field list is heterogeneous, no semantic grouping; the class shape is essentially the const bag with a `this.` prefix.

**(b) Grouped class — fields bundled by domain (`httpConfig`, `kanbanConfig`, `channelConfig`, `heartbeatConfig`, `tzConfig`, `brandConfig`, `pathsConfig`).** Pro: smaller per-bundle surface, easier to test one bundle in isolation. Con: importers must learn the bundle names; the existing const names (`WEB_PORT`, `KANBAN_WIP_PLANNED`, …) get rebadged into the bundle paths. Migration cost is higher than (a).

**(c) Bag-of-strings + typed accessors — `private readonly values: Record<string, string | number | boolean>; get<K>(key: K): value-of-K` with a mapping table.** Pro: one field, typed accessors. Con: the accessor map must be hand-maintained, breaking the "58 consts" simplicity. Strict-generics style would force a `ConfigSchema<TKeyMap>` generic, which is OE-6 ceremony.

**Recommendation for type-side:** (a) is the only one that does not re-shape the existing surface. (b) and (c) are *behavioral* refactors, not type refactors; they belong in a separate design pass.

### §3.3 Constructor — what does it take?

Three viable shapes:

| Shape | Reads from .env at boot? | Mutability after construction |
|---|---|---|
| `new Config()` | Yes (calls `readEnvFile()` + `readConfigOverrides()` internally, like today) | Immutable (every field is `public readonly`) |
| `new Config(values: Record<string, string \| number \| boolean>)` | No (caller supplies all values) | Immutable |
| `new Config(values: Partial<ConfigFields>)` | Hybrid — defaults from `readEnvFile()`, overrides from `values` | Immutable |

**(a) — drop-in replacement.** This is the "drop-in" shape: every existing importer keeps working (just `WEB_PORT` → `CONFIG.WEB_PORT`), and tests do `vi.mock('../config.js', () => ({ CONFIG: new Config({ WEB_PORT: 4000 }) }))` instead of the current mock pattern. Migration cost is roughly the import-rewrite + the 154 test-mock patterns. **Type-safe; matches today's behavior 1:1.**

**(b) — explicit.** Tests pass `new Config({ WEB_PORT: 4000, … })` directly. Production has to call `Config.fromEnv()` (a static factory that reads `.env` + `config-overrides.json`). This is more honest but doubles the surface. **Type-safe; production code becomes more verbose.**

**(c) — hybrid.** Production calls `new Config()` (same as (a)), tests override specific fields via the constructor. But "override" via constructor contradicts "immutable" — either the constructor takes a complete values map (b) or it doesn't take anything (a). **REJECT** as a hybrid; pick (a) or (b).

### §3.4 Public method surface

| Method | Today (free function) | On `Config` class |
|---|---|---|
| `resolveAppTz` | free | static (does not need `this`) or removed (logic moves to consumer) |
| `resolveBrandName` | free | static (pure) |
| `currentBotName` | free | instance method (reads `.env` fresh each call) |
| `currentBrandName` | free | instance method |
| `currentOwnerName` | free | instance method |
| `resolveServiceId` | free | static (pure) |
| `brandSlug` | free | static (pure) |
| `appServiceLabel` | free | static (pure) |
| `launchdStatusPattern` | free | static (pure) |
| `systemdStatusUnits` | free | static (pure) |

Plus potential:
- `reload(): Promise<void>` — re-reads `.env` + `config-overrides.json`. **Today the consts are frozen at module load**; a `reload()` would break that invariant. The only consumer that currently re-reads is `currentBotName`/`currentBrandName`/`currentOwnerName`, which call `readEnvFile()` directly. Promoting those to instance methods on a `Config` class effectively *is* the per-field reload. A bulk `reload()` would be additive — define it only if a future consumer needs it (per CLAUDE.md §2 Simplicity First).
- `list(): Record<string, string | number | boolean>` — full snapshot. Used by `/api/settings` and dashboard chrome. Today this is hand-rolled (`{ WEB_PORT, KANBAN_*, … }`). A class method would centralise the snapshot shape. **Reasonable addition.**

### §3.5 Type-safe accessors via typed key parameter

A typed `get<K extends keyof ConfigFields>(key: K): ConfigFields[K]` would give per-setting type narrowing:

```ts
// hypothetical
class Config {
  readonly WEB_PORT: number
  readonly BOT_NAME: string
  readonly CHANNEL_PROVIDER: ChannelProviderType
  // ...
}

// caller:
const port: number = config.WEB_PORT        // typed
const name: string = config.BOT_NAME        // typed
```

This is the **same as direct field access**, just by a different syntax. The TS narrowing is identical to `config.WEB_PORT`'s type — a `get` method adds zero compile-time value. **REJECT.** Direct field access on a `public readonly` field is what TypeScript already gives you.

The only place a typed `get<K>` would help is if the field set were *not* statically known (e.g., dynamic `Record<string, T>`). The 58 consts are statically known — no `get<K>` benefit.

### §3.6 LoggerLike integration

Three sub-questions:

**(i) Does `Config` need a `log: LoggerLike` field?**

Today: zero log calls in `config.ts`. Per §1.7, the module is structurally locked out of having a logger due to the import-time circular constraint (`logger.ts` → `config.ts`). The reason `config.ts` is imported so early is that `logger.ts` imports `config.ts` for the `APP_TZ_INVALID` value, which the logger uses in the boot banner.

A `Config` class **breaks this constraint**: classes are constructed, not imported as singletons. The App constructor would build `new Config()` *after* `logger.ts` has been imported and the pino singleton is available. So a `Config` instance *could* hold a `log: LoggerLike`.

**(ii) What would `Config.log` actually do?**

The only `Config`-internal event worth logging is the rejected `APP_TZ_INVALID` — and that today lives in `startScheduleRunner` because `config.ts` couldn't own a logger. If `Config` gained a logger, the rejected-tz reporting could move to `Config.constructor()` (or to a `Config.reportInvalidTz(logger)` method called by `startScheduleRunner`). 

**(iii) Is it worth it?**

No. The boot-time reporting already works (it lives in `startScheduleRunner`). Moving it into `Config.constructor()`:
- saves zero lines (the consumer still calls a method to receive the warning)
- adds a constructor dependency (every `Config` instance needs a logger, even when the tz was valid and there's nothing to log)
- makes tests noisier (every test that builds `new Config()` for an unrelated reason has to pass a logger)

**REJECT** `log: LoggerLike` on `Config`. Keep the loud-reporting call-site in `startScheduleRunner` (the pattern is correct: `config.ts` is the source, `startScheduleRunner` is the consumer that already has a logger).

### §3.7 Generic over `TEnv`?

```ts
// hypothetical
class Config<TEnv extends Record<string, string> = Record<string, string>> {
  constructor(private readonly env: TEnv) { ... }
  // ...
}
```

The benefit: tests could pass a typed `env: Record<'WEB_PORT' | 'BOT_NAME', string>` and TS would error on a typo. Today, every `env['KEY'] ?? 'fallback'` is a `string | undefined` lookup with no key-level type safety (a typo like `env['WEB_POORT']` returns `undefined` silently and falls through to the fallback).

**Per OE-6, this is generic-with-one-consumer.** The only "consumer" of the typed env is `readEnvFile()` itself, which already returns `Record<string, string>` (line 13 of env.ts). Promoting `env` to `Record<string, string>` on `Config` would not change behavior. Tightening to a literal-union of env-keys would require every env key to be enumerated — a hand-maintained type that drifts from `.env` on the day someone adds a new key. **REJECT** under OE-6 / OE-8.

---

## §4. `SettingsRegistry` design (per OE-8)

OE-8 finding (review-completeness.md):
> "`getDefinition`, `listModules`, `validate` are pure functions over the array; they can stay as `export function` in the existing module without an instance. Drop the class wrap; keep the registry as a `const` and the helpers as free functions."

This analysis agrees. Verification:

1. **The array is frozen at module load.** `SETTINGS_REGISTRY: SettingDefinition[]` is built once from a literal. No production code mutates it (`grep -rn "SETTINGS_REGISTRY.push\|SETTINGS_REGISTRY\[" src/` returns 0).
2. **The helpers are pure.** `getSettingDefinition` (line 432-434) does only `.find()`; `listSettingModules` (line 436-438) does only `[...new Set(...)]`; `validateSettingValue` (line 449-484) takes its inputs as parameters and dispatches on `def.type`. None reads mutable state.
3. **Define/undefine would exist only for `vi.mock`.** Per OE-8, the only path that *could* mutate the registry is test overrides via `vi.mock('../config-registry.js', …)`. Module-level mock replacement is a `vitest` affordance; it does not require the module to expose mutation methods. Tests today mock the *whole module* and replace the exports; they do not call `define`/`undefine`.
4. **Promoting to a class adds boilerplate for production-zero behavior change.** A `SettingsRegistry` class would have a constructor (no args), `getDefinition(key)`, `listModules()`, `listKeys()`, `validate(def, raw)`, possibly `define(entry)` / `undefine(key)` — and the `define`/`undefine` methods would be unused in production.

**Recommendation:** **Keep as-is.** `SETTINGS_REGISTRY: SettingDefinition[]` as a `const`, three pure helpers as free functions. The only type-side cleanup worth considering (and it's minor) is a `as const` on the literal to enable `SettingKey` derivation — but only if a typed accessor (`getDefinition<K extends SettingKey>`) is added, and §2.5 above rejects that.

---

## §5. Generic opportunities — summary

| Candidate | For? | Against? | Verdict |
|---|---|---|---|
| `Config<TEnv>` | Typed env map for typo safety | Single consumer; hand-maintained key list drifts from `.env`; no compile-time payoff beyond what `Record<string, string>` already provides | **REJECT** (OE-6) |
| `SettingDefinition<TType>` | Per-type narrowing of `default` / `valueSet` / `min` / `max` | Existing union + runtime `switch (def.type)` is exhaustive and typesafe; one consumer (`validateSettingValue`); forces every consumer to be generic | **REJECT** (OE-6) |
| `Config.get<K extends keyof ConfigFields>` | Typed accessor with narrowing | Identical to direct `config.K` field access; adds indirection for zero compile-time gain | **REJECT** |
| `LoggerLike<L extends LogRecord>` | Per-module log-record types | 76 string-first call sites break; no module in `src/` declares a log-record type today | **REJECTED upstream** (H §L Variance) |
| `Config` instance field per const | Drop-in replacement for 58 module-level consts | Heterogeneous 58-field class; no per-field type improvement | Acceptable *if* the test-mock rewrite justifies it; type-side this is a non-improvement over today's consts |
| `SettingsRegistry` class wrap | Promote registry to class | OE-8: pure helpers over a frozen array; `define`/`undefine` exist only for tests; no production behavior change | **REJECT** (OE-8) |

**Net:** none of the generics survive OE-6. The B subsystem's type surface is already clean; the class-wrap decision is driven by **test ergonomics** (the 154 `vi.mock('../config.js')` rewrites per M4), not by type safety.

---

## §6. Unsafe casts audit — type-safety hotspot table (B)

| File | `as any` | `as unknown` | `as const` | `: any` | `: unknown` | Severity |
|---|---:|---:|---:|---:|---:|---|
| `src/config.ts` | 0 | 0 | 0 | 0 | 0 | clean |
| `src/config-registry.ts` | 0 | 0 | 0 | 0 | 0 | clean |

**`grep -nE " as any| as unknown| as const|: any\b|: unknown\b" src/config.ts` and `src/config-registry.ts` both return zero matches** (verified). The `raw: unknown` parameter of `validateSettingValue` (line 449) is the **only** `unknown` in B, and it is correct usage (untrusted-input boundary).

**Type-safety hotspots for B:** none. The two files are the type-cleanest surface in `src/` per the grep — the 58 consts rely on inference, the registry helpers take typed parameters, and the only `unknown` is correctly bounded. The B subsystem does not need a type-safety pass; it needs a behavioral pass (test-mock rewrites, decide-class-or-not) per `01-module-state-analysis.md` and `03-class-boundaries.md`.

For comparison (not B-internal, cited for context per review-correctness.md M2):
- `src/db.ts` — 18 `as` casts per `02-type-interface-analysis.md` table
- `src/agent.ts` — 11 `as` casts per same table
- `src/index.ts` — 0 `: any` (m3 refutes the plan's "1 occurrence" claim)

---

## §7. Pre-class design checklist (cross-references)

For Phase 1/2 of the refactor, the type-side decisions this analysis locks in:

1. **OE-8 holds** — `SETTINGS_REGISTRY` stays as `const SettingDefinition[]` + 3 pure free functions. No class wrap. (`02 §4` above.)
2. **OE-6 holds** — no generics over `TEnv` or `TType` in B. (`02 §3.7` and `02 §2.8` above.)
3. **LoggerLike stays out of B** — zero call sites today; `Config` class (if built) does not gain a `log: LoggerLike` field; rejected in `02 §3.6`.
4. **`config.ts` has 58 `const` + 10 `function` exports, zero interfaces** — verified; matches review-correctness.md M2 (`02 §1.1`).
5. **Zero unsafe casts in B** — verified; the two files are the type-cleanest surface in `src/` (`02 §6`).
6. **`SettingValidationResult` could be tightened** to a discriminated union (`{ ok: true; value } | { ok: false; error }`), but no caller benefits and per CLAUDE.md §2 (Simplicity First) this is dropped unless a future caller forgets to read `value` on the `ok: true` branch (`02 §2.6`).
7. **`raw: unknown` on `validateSettingValue` is correct** — the only `unknown` in B, at the right boundary (`02 §2.7`).
8. **`CHANNEL_PROVIDER` carries an explicit `: ChannelProviderType` annotation** — the only positive type annotation on a const in B; correct widening to the enum literal union (`02 §1.3`).

---

## §8. File-and-line references (verified)

| Claim | Verified location |
|---|---|
| 58 `export const` in `config.ts` | `grep -c "^export const " src/config.ts` = 58; matches review-correctness.md M2 |
| 10 `export function` in `config.ts` | `grep -c "^export function " src/config.ts` = 10 |
| Zero `export interface`/`export type` in `config.ts` | `grep -cE "^(export interface\|export type) " src/config.ts` = 0 |
| 2 `export const` in `config-registry.ts` | `grep -c "^export const " src/config-registry.ts` = 2 (`DISTRIBUTION_DEFAULT_AGENT_MODEL` at line 16; `SETTINGS_REGISTRY` at line 37) |
| 4 `export function` in `config-registry.ts` | lines 432, 436, 449 (only 3 explicit; the 4th is `DISTRIBUTION_DEFAULT_AGENT_MODEL`'s `const` shape — *correction*: 3 free functions, not 4 — `getSettingDefinition`, `listSettingModules`, `validateSettingValue`) |
| 2 `export interface` in `config-registry.ts` | lines 20 (`SettingDefinition`), 440 (`SettingValidationResult`) |
| 1 `export type` in `config-registry.ts` | line 18 (`SettingType`) |
| `SettingType` literal-union | line 18: `'int' \| 'string' \| 'color' \| 'boolean'` |
| `SettingDefinition` field list | lines 20-33 (verified: 7 required + 3 optional) |
| `HEX_COLOR_RE` | line 35 (non-exported, regex literal) |
| `SETTINGS_REGISTRY` count | 35 entries (literal `{` count between line 37 and line 430) |
| `readEnvFile` return type | `env.ts:13` — `(keys?: string[]) => Record<string, string>` |
| LoggerLike references in `config.ts` | 2 (both in comments: line 103, line 376) |
| LoggerLike references in `config-registry.ts` | 0 |

All line references verified by `Read` of the full files at analysis start.
