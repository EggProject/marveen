# B (config) — Generic interfaces

Generic interface candidates for the B subsystem. Justifications cite
2+ consumers (per `framework/04-generic-interfaces.md`) or explicitly
mark speculative. The cross-cutting H `LoggerLike` decision is in
`h-cross-cutting/04-generic-interfaces.md` and is cited here only where
it intersects with B. Every claim is verified against
`02-type-interface-analysis.md §3.7 / §2.8 / §2.5` and
`review-completeness.md` (OE-6, OE-8).

**Reading note.** Per `02-type-interface-analysis.md §5` "Generic
opportunities — summary", **none** of the B generics survive OE-6.
This document exists to (a) document the rejections with verified
ground-truth, and (b) sketch the hypothetical generics so a future
contributor can revisit the decision if a second consumer emerges. The
single positive B-class deliverable (`Config`) is concrete-typed, not
generic.

---

## Candidate 1. `Config<TConfig>` over a typed values bag

### Sketch (hypothetical)

```ts
// hypothetical — NOT built
type ConfigValues = {
  WEB_PORT: number
  BOT_NAME: string
  CHANNEL_PROVIDER: ChannelProviderType
  // ... 55 more fields, all hand-maintained
}

class Config<TConfig extends Record<string, unknown> = ConfigValues> {
  constructor(values: Partial<TConfig>)
  get<K extends keyof TConfig>(key: K): TConfig[K]
  // ...
}
```

### Justification

**Rejected (OE-6).** Per `02-type-interface-analysis.md §3.7`:

> "Per OE-6, this is generic-with-one-consumer. The only 'consumer' of
> the typed env is `readEnvFile()` itself, which already returns
> `Record<string, string>` (line 13 of env.ts). Promoting `env` to
> `Record<string, string>` on `Config` would not change behavior.
> Tightening to a literal-union of env-keys would require every env key
> to be enumerated — a hand-maintained type that drifts from `.env` on
> the day someone adds a new key."

### Consumer count

- **`readEnvFile()`** (`env.ts:13`) — the underlying primitive; already
  returns `Record<string, string>`. A tighter type would force
  `readEnvFile` to enumerate every key, defeating its role as a generic
  env reader.
- **D's `ChannelEnv`** (`d-channel-provider/03-class-boundaries.md:71`)
  — the second consumer; takes `Record<string, string>` directly. A
  typed `Config<TConfig>` would force `ChannelEnv` to also be generic
  (`ChannelEnv<TConfig extends Record<string, string>>`) — multiplying
  the type surface for no compile-time guarantee the existing
  `Record<string, string>` doesn't already provide.

**Net consumer count: 2** (`readEnvFile`, `ChannelEnv`), but neither
*benefits* from the generic — both already accept `Record<string, string>`
which is the exact shape `Config.env` exposes. Per `02 §3.7`, the
generic "would have nothing to bind to": the typed env adds a
compile-time guarantee on `env['KEY']` lookups, but every `env[...]` in
`config.ts` is a single-source `env[KEY_NAME] ?? 'fallback'` literal that
is already as typesafe as `Record<string, string>` allows.

### Verdict

**REJECT.** The cost is a 58-field hand-maintained type that drifts
from `.env` on the day someone adds a new key. The benefit is zero
(no consumer does a generic-env lookup today).

---

## Candidate 2. `Config.get<K extends keyof TConfig>(key: K): TConfig[K]` typed accessor

### Sketch (hypothetical)

```ts
// hypothetical — NOT built
class Config {
  get<K extends keyof ConfigFields>(key: K): ConfigFields[K]
}
```

### Justification

**Rejected (per `02-type-interface-analysis.md §3.5`).**

> "A typed `get<K extends keyof ConfigFields>(key: K): ConfigFields[K]`
> would give per-setting type narrowing:
> ```ts
> const port: number = config.WEB_PORT        // typed
> const name: string = config.BOT_NAME        // typed
> ```
> This is the **same as direct field access**, just by a different
> syntax. The TS narrowing is identical to `config.WEB_PORT`'s type —
> a `get` method adds zero compile-time value."

### Consumer count

- **Direct field access** is the dominant consumer (60 importers per
  `review-correctness.md` M5). Each would migrate to
  `config.get('WEB_PORT')` instead of `config.WEB_PORT`.
- **The dashboard chrome** (`/api/settings` and the Settings page)
  hand-rolls a `{ WEB_PORT, KANBAN_*, ... }` snapshot today; the class
  form consolidates to `config.list()` (per `03-class-boundaries.md §B1`).

**Net consumer count: 2**, but both already work with direct field
access, which is the same compile-time guarantee. The `get<K>` adds
indirection for zero gain.

### Verdict

**REJECT.** Direct field access on a `public readonly` field is what
TypeScript already gives you. The `get<K>` would be ceremony.

---

## Candidate 3. `SettingDefinition<TType extends SettingType>` per-type narrowing

### Sketch (hypothetical)

```ts
// hypothetical — NOT built
interface SettingDefinition<TType extends SettingType = SettingType> {
  key: string
  type: TType
  default: TType extends 'int' ? number : string
  valueSet?: TType extends 'string' | 'boolean' ? string[] : never
  min?: TType extends 'int' ? number : never
  max?: TType extends 'int' ? number : never
  // ...
}
```

### Justification

**Rejected (OE-6).** Per `02-type-interface-analysis.md §2.8`:

> "A `SettingDefinition<TType extends SettingType>` generic would let
> `default`, `value`, and `min`/`max` be tied to the literal type …
> The benefit: passing a `SettingDefinition<'int'>` to a function that
> needs `min`/`max` would be typesafe; passing a
> `SettingDefinition<'color'>` would forbid `min`/`max` at the type
> level. Today this is enforced only by convention + the validator's
> runtime `if (def.type === 'int')` guard.
>
> Per OE-6, this is generic-with-one-consumer. The only consumer is
> `validateSettingValue`, which dispatches on `def.type` at runtime —
> the generic would force every dispatch site to also be generic,
> multiplying the type surface for no compile-time guarantee the
> existing `if (def.type === 'int')` doesn't already provide (the union
> is closed). REJECT. The current union + runtime switch is correct."

### Consumer count

- **`validateSettingValue(def, raw)`** (`config-registry.ts:449-484`) —
  the single consumer; dispatches on `def.type` at runtime. A generic
  `SettingDefinition<TType>` would force the dispatcher to be generic
  over `TType`, multiplying the type surface for one consumer.
- **`/api/settings`** (`web/routes/settings.ts`) — reads
  `getSettingDefinition(key)` and forwards to the route handler; does
  not constrain the type at the consumer level.

**Net consumer count: 1** (`validateSettingValue`). OE-6 fails. The
generic would force every dispatch site to also be generic — ceremony.

### Verdict

**REJECT.** The current 4-member union + runtime switch is correct and
typesafe.

---

## Candidate 4. `SettingsRegistry<T extends SettingDefinition>` per-instance typing

### Sketch (hypothetical)

```ts
// hypothetical — NOT built
class SettingsRegistry<T extends SettingDefinition = SettingDefinition> {
  private readonly registry: readonly T[]
  constructor(registry: readonly T[])
  getDefinition<K extends T['key']>(key: K): Extract<T, { key: K }> | undefined
  listModules(): string[]
  validate(def: T, raw: unknown): SettingValidationResult
}
```

### Justification

**Rejected (OE-8, which itself rejects the class wrap).** Per
`review-completeness.md` OE-8 and `02-type-interface-analysis.md §4`:

> "The array is frozen at module load. … The helpers are pure. …
> `define`/`undefine` would exist only for `vi.mock`. … Promoting to a
> class adds boilerplate for production-zero behaviour change."

If a class is rejected, the generic over its registry array is
double-rejected.

### Consumer count (if a class were built)

- **`/api/settings`** — single consumer of the typed
  `getDefinition<K>` lookup (which the generic would enable). The
  existing call site is `getSettingDefinition(key: string)`: takes
  `string`, returns `SettingDefinition | undefined`. A typed
  `getDefinition<K extends SettingKey>` would require deriving
  `SettingKey` from the literal entries — which requires `as const` on
  the array (currently `SettingDefinition[]`). Per `02 §2.5`:

> "A typed accessor (`getDefinition<K extends SettingKey>`) would
> require `as const` on the array + derivation of the key union, and
> only one consumer exists. Not worth it under OE-6."

**Net consumer count: 1** (the `/api/settings` route). OE-6 fails.

### Verdict

**REJECT** — both the class wrap (per OE-8) and the generic over it
(per OE-6 + single consumer).

---

## Candidate 5. `LoggerLike` integration on `Config`

### Sketch

```ts
// hypothetical — NOT built
class Config {
  constructor(
    private readonly env: Record<string, string>,
    private readonly log: LoggerLike,
  )
  // ... methods may call this.log.warn(...)
}
```

### Justification

**Rejected** per `02-type-interface-analysis.md §3.6` (re-verified in
`03-class-boundaries.md §B1`):

> "No. The boot-time reporting already works (it lives in
> `startScheduleRunner`). Moving it into `Config.constructor()`:
> - saves zero lines (the consumer still calls a method to receive the
>   warning)
> - adds a constructor dependency (every `Config` instance needs a
>   logger, even when the tz was valid and there's nothing to log)
> - makes tests noisier (every test that builds `new Config()` for an
>   unrelated reason has to pass a logger)
>
> REJECT `log: LoggerLike` on `Config`. Keep the loud-reporting
> call-site in `startScheduleRunner` (the pattern is correct: `config.ts`
> is the source, `startScheduleRunner` is the consumer that already has
> a logger)."

### Consumer count

- **Zero** log calls in `src/config.ts` (verified by
  `02-type-interface-analysis.md §1.7`: `grep -nE "logger\|log\." src/config.ts`
  returns 2 matches, both in comments at L103 and L376).
- **Zero** log calls in `src/config-registry.ts` (verified by
  `02-type-interface-analysis.md §2.9`).
- **One** indirect consumer: `startScheduleRunner` (`web/schedule-runner.ts:1029`)
  handles the `APP_TZ_INVALID` loud reporting; it already has a logger
  via the framework's H.1 decision.

**Net consumer count: 0** for a `Config.log` field. The loud reporting
is correctly placed in the consumer (`startScheduleRunner`), not in
the source (`config.ts`).

### Verdict

**REJECT.** `Config` does not gain a `log: LoggerLike` field. B is the
cheapest H consumer (zero call sites) and does not depend on H.1.

---

## Net generics verdict

| Candidate | Consumer count | Verdict |
|---|---:|---|
| `Config<TConfig>` over typed values bag | 2 (`readEnvFile`, `ChannelEnv` — neither benefits) | **REJECT** (OE-6) |
| `Config.get<K extends keyof TConfig>` | 2 (direct field access already provides it) | **REJECT** |
| `SettingDefinition<TType>` per-type narrowing | 1 (`validateSettingValue`) | **REJECT** (OE-6) |
| `SettingsRegistry<T extends SettingDefinition>` | 1 (`/api/settings`) | **REJECT** (OE-8 + OE-6) |
| `Config.log: LoggerLike` | 0 (loud reporting lives in `startScheduleRunner`) | **REJECT** |

**Net: zero generics introduced.** Per `02-type-interface-analysis.md §5`:
"None of the generics survive OE-6. The B subsystem's type surface is
already clean; the class-wrap decision is driven by **test ergonomics**
(the 154 `vi.mock('../config.js')` rewrites per M4), not by type safety."

---

## What B does NOT need

- A `ConfigValue<T>` generic — the existing const declarations are
  already typed via inference (per `02 §1.1`). A `as const` annotation
  on individual declarations would tighten the inference but adds zero
  compile-time value.
- A `SettingKey` literal-union derived from `SETTINGS_REGISTRY` —
  per `02 §2.5`, the derivation requires `as const` on the array and
  only one consumer (`/api/settings`) would benefit; not worth the
  drift between literal type and `.env`.
- A `TypedEnv<K extends keyof TConfig>` — same reasoning as Candidate 1.

---

## Cross-references

- **`02-type-interface-analysis.md §3.7`** — primary source for the
  generic rejection of `Config<TEnv>`.
- **`02-type-interface-analysis.md §3.5`** — typed accessor rejection.
- **`02-type-interface-analysis.md §2.8`** — `SettingDefinition<TType>`
  rejection.
- **`02-type-interface-analysis.md §2.5`** — `getDefinition<K extends SettingKey>`
  rejection (single consumer).
- **`02-type-interface-analysis.md §3.6`** — `Config.log: LoggerLike`
  rejection (zero call sites).
- **`02-type-interface-analysis.md §4`** — `SettingsRegistry` class
  rejection (OE-8).
- **`review-completeness.md`** — OE-6 (single-consumer generic rule);
  OE-8 (SettingsRegistry no class wrap); OE-9 (App.getStore<K> dropped).
- **`h-cross-cutting/04-generic-interfaces.md §L`** — `LoggerLike`
  interface decision (B does not consume it; H owns it).
