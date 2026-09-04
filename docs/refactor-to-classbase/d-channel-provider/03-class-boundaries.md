# D (channel-provider) — Class boundaries

Concrete class candidates for the D subsystem. Signatures only; no
implementation. Every claim below cites a file:line verified against
`src/channel-provider.ts` read in full on 2026-08-30 (552 lines pre-D.2,
622 lines post-D.2 + post-D.1, re-measured 2026-09-04).

**Status (2026-09-04):**

- **D.1 (`ChannelEnv`) — LANDED (this commit).** Class introduced at
  `src/channel-provider.ts:507`. Migrated **42 call sites across 12
  production files**; updated **7 of 17 mock factories**. **No legacy
  wrappers** — the 4 legacy free functions (`getChannelToken`,
  `getChannelChatId`, `channelStateDir`, `readChannelToken`) were
  deleted outright in the same commit as the class introduction.
- **D.2 (5 provider classes + `UnsupportedDirectSendProvider` base) —
  LANDED** (preceding refactor). Line numbers below use post-D.2 actuals
  (re-measured 2026-09-04); pre-D.2 numbers shown in parentheses where
  useful.
- **D.3 (`ChannelProviderRegistry`) — LANDED** (preceding refactor).
- **D.4 (`withTestRunMarking` Form B explicit-delegation function) —
  LANDED** (preceding refactor, landed first to guarantee decorator
  robustness against class-form providers).
- **D.5 — REMOVED** (merged into D.1).
- **D.6 — DEFERRED** (depends on H.1; no logger call sites today).

**Reading note.** Two of the seven candidates below deviate from the brief
on points where the source disagrees with the brief's sketch. The
deviations are argued from measured source and called out under "Deviation
from brief". `review-correctness.md` C1 / C2 established the per-call
parameter rule; `review-completeness.md` OE-6 rejected generics with
single consumers; `02-type-interface-analysis.md` §8 documented the one
real dedup opportunity (the `UnsupportedDirectSendProvider` base).

---

## Class candidate inventory

| Class | New? | Migration source | Phase |
|---|---|---|---|
| `ChannelEnv` | new | `getChannelToken:459` + `getChannelChatId:467` (instance methods); `channelStateDir:520` + `readChannelToken:533` (static helpers) | D.1 |
| `TelegramProvider` | new | `telegramProvider:53` (object literal → class); helper `telegramHttpPost:27` becomes private method | D.2 |
| `SlackProvider` | new | `slackProvider:134`; helper `formatForSlackMrkdwn:114` becomes private method | D.2 |
| `DiscordProvider` | new | `discordProvider:243`; helper `formatForDiscord:234` becomes private method | D.2 |
| `UnsupportedDirectSendProvider` (abstract base) | new | shared body of `googlechatProvider:324` and `teamsProvider:364` minus per-provider metadata | D.2 |
| `GooglechatProvider` | new (extends base) | `googlechatProvider:324` minus shared body | D.2 |
| `TeamsProvider` | new (extends base) | `teamsProvider:364` minus shared body | D.2 |
| `ChannelProviderRegistry` | new (wraps `markedProviders`) | `markedProviders:500` + `getProvider:508` | D.3 |
| `TestRunMarkingDecorator` | new (replaces `withTestRunMarking:490`) | the function at `channel-provider.ts:490-498` | D.4 |

Nine classes total. Two of them (`UnsupportedDirectSendProvider`,
`TestRunMarkingDecorator`) consolidate duplication; the rest are 1:1
conversions of the existing object literals and helpers.

---

## D1. `ChannelEnv`

### Status

**LANDED (this commit).** Class declared at `src/channel-provider.ts:507`.
The 4 legacy free functions (`getChannelToken`, `getChannelChatId`,
`channelStateDir`, `readChannelToken`) are **deleted outright** — there
are no thin-wrapper survivors (per the "Design-intent reference (NOT as
shipped)" in `05-refactor-roadmap.md` Phase D.1).

**Migration scope:**

- **42 production call sites** migrated across **12 production files**.
- **7 of 17 test mocks** updated to expose `ChannelEnv` as `vi.fn()`.
- **0 legacy wrappers** remain (the deletion committed in the same
  change as the class introduction; no intermediate state shipped).

The signatures below are the **landed** signatures (re-measured
post-D.2 + post-D.1 on 2026-09-04); pre-D.2 numbers shown in parentheses
for cross-reference. Pre-D.1 line numbers shown in parentheses where the
line shifts are non-trivial.

### Deviation from brief

The brief sketches `getToken(provider)`, `getChatId(provider)`,
`getStateDir(provider)`, `readToken(provider)` as instance methods, all
returning `Promise<...>`. The source disagrees on three points:

| Brief sketch | Source reality | Correction |
|---|---|---|
| Constructor takes `process.env` (or `EnvSource`) | `getChannelToken:459` (now `ChannelEnv.getToken:522`) and `getChannelChatId:467` (now `ChannelEnv.getChatId:526`) take `env: Record<string, string>` as a per-call parameter; the only production caller is `config.ts:324-326` which passes `env` from `readEnvFile()` (`src/env.ts:13`), NOT `process.env` | Constructor takes `env: Record<string, string>` as the **first** parameter; whether the caller sources it from `process.env` or `readEnvFile()` is the caller's decision and today the answer is `readEnvFile()` |
| `getToken(provider): Promise<string>` | `getChannelToken:459` is **synchronous** and returns `string` (never `null`/`undefined`; missing keys collapse to `''`) | `getToken(provider): string` |
| `readToken(provider): Promise<string \| null>` | `readChannelToken:533` (now `ChannelEnv.readTokenFor:543`) takes a `envFilePath: string` (a filesystem path, not an env record); it is **synchronous** and returns `string \| null` | `readTokenFor(provider, envFilePath: string): string \| null` (static) |
| `getStateDir(provider): string` | `channelStateDir:520` (now `ChannelEnv.stateDirFor:530`) is **synchronous**, returns `string`, takes optional `agentDir?: string`; 14 of 19 production call sites pass the second argument | `stateDirFor(provider, agentDir?: string): string` (static) |

The source wins. Constructing `ChannelEnv` from `process.env` would
silently change which values the helpers resolve to in production (since
`config.ts:17` reads from `${PROJECT_ROOT}/.env`, not `process.env`).
Conflating `envFilePath` with an env record would break all 5
`readChannelToken` call sites. Dropping `agentDir` would break 14
production call sites.

### Source and migration (as shipped)

- **Source file:** `src/channel-provider.ts` (same file; class lives at
  `:507`).
- **Migration source (deleted):** the four top-level helpers were at
  pre-D.2 `:459-473` (token/chatId) and `:520-551` (stateDir/readToken).
  All four bodies **deleted** in D.1 (this commit); their bodies are
  preserved in git history at pre-D.1 commits.
- **Dispatch table:** consolidated to `ChannelEnv.TABLE`
  (`channel-provider.ts:508-517`), collapsing 4 duplicated 5-branch
  chains.

### Public surface (as shipped)

```ts
class ChannelEnv {
  static readonly TABLE: Record<ChannelProviderType, {
    readonly tokenKey: string
    readonly chatIdKey: string
    readonly subdir: string
  }>

  constructor(private readonly env: Record<string, string> = {})

  // -- instance methods: env-derived (was getChannelToken / getChannelChatId) --
  getToken(provider: ChannelProviderType): string
  getChatId(provider: ChannelProviderType): string

  // -- static methods: env-independent, file/homedir only --
  static stateDirFor(provider: ChannelProviderType, agentDir?: string): string
  static readTokenFor(provider: ChannelProviderType, envFilePath: string): string | null
}
```

The constructor **defaults `env = {}`** so callers of the two statics
(which don't consume `env`) can use `new ChannelEnv()` without
arguments. The original spec listed `home?: string` as a second
parameter but the implementation deferred it; `homedir()` is read
directly inside `stateDirFor` (per-call, since the helper is stateless).
Detail: `06-risks-and-mitigations.md` DR4.

### Method-by-method

| Method | Replaces | File:line (post-D.2 / post-D.1) | Notes |
|---|---|---|---|
| `getToken(provider)` | `getChannelToken(provider, env)` | `channel-provider.ts:522` | Returns `this.env[TABLE[provider].tokenKey] ?? ''`. Missing keys collapse to `''` (preserved verbatim). |
| `getChatId(provider)` | `getChannelChatId(provider, env)` | `channel-provider.ts:526` | Returns `this.env[TABLE[provider].chatIdKey] ?? ''`. Note: telegram key is `ALLOWED_CHAT_ID`, NOT `TELEGRAM_CHAT_ID` — preserved verbatim; not a bug to fix in this refactor. |
| `stateDirFor(provider, agentDir?)` | `channelStateDir(provider, agentDir?)` | `channel-provider.ts:530` | `agentDir?` is optional; 14 of 19 production call sites pass it (verified `02 §5.3`). **Static** because it does not consume `this.env`. |
| `readTokenFor(provider, envFilePath)` | `readChannelToken(provider, envFilePath)` | `channel-provider.ts:543` | Second arg is a **filesystem path**, never an env record. Three `null` paths (file missing, read throws, regex miss) preserved verbatim. **Static** because it reads the per-channel `.env` file, NOT `this.env`. |

### Constructor (as shipped)

- `(env: Record<string, string> = {})`. The `env` is the parsed record
  from `src/env.ts:13`'s `readEnvFile()` (or from `process.env` at the
  caller's option — today `config.ts:324` uses `readEnvFile()`).
- Default `env = {}` enables `new ChannelEnv()` for statics-only
  callers (preserves byte-compatibility with the legacy
  `channelStateDir(provider, agentDir?)` / `readChannelToken(provider,
  envFilePath)` signatures).
- **No I/O in the constructor.** The class does not read `process.env`
  (the `env` parameter is the parsed result, already loaded). No
  `home` parameter — `homedir()` is read directly in `stateDirFor`.
- **No logger.** Per `02 §10` the file has zero logger call sites.

### Static dispatch table (as shipped)

```ts
// Source of truth for the 5-branch dispatch family; replaces 4 duplicated
// 5-branch chains (pre-D.2: :460-464, :468-472, :525-529, :543-548).
static readonly TABLE: Record<ChannelProviderType, {
  readonly tokenKey: string
  readonly chatIdKey: string
  readonly subdir: string
}> = {
  telegram:   { tokenKey: 'TELEGRAM_BOT_TOKEN',          chatIdKey: 'ALLOWED_CHAT_ID',                subdir: 'telegram'   },
  slack:      { tokenKey: 'SLACK_BOT_TOKEN',             chatIdKey: 'SLACK_CHANNEL_ID',               subdir: 'slack'      },
  discord:    { tokenKey: 'DISCORD_BOT_TOKEN',           chatIdKey: 'DISCORD_CHANNEL_ID',             subdir: 'discord'    },
  googlechat: { tokenKey: 'GOOGLECHAT_PROJECT_ID',       chatIdKey: 'GOOGLECHAT_SPACE_ID',            subdir: 'googlechat' },
  teams:      { tokenKey: 'TEAMS_BOT_APP_ID',            chatIdKey: 'TEAMS_ALLOWED_CONVERSATION_ID',  subdir: 'teams'      },
}
```

`getChannelToken`'s key map and `readChannelToken`'s key map were
**byte-identical** pre-D.1 (the same 5 keys in the same order).
`channelStateDir`'s subdir chain duplicated the providers'
`readonly stateDir` fields (pre-D.2: `:58/139/248/329/369`; post-D.2:
`:365/395/410/423/437`). Consolidating to a single `static readonly`
table removes the duplication and gives the compiler a genuine
exhaustiveness check when a sixth provider is added (today the
`switch (provider)` in `stateDirFor:530-540` enforces 5 cases
exhaustively).

### Generic params

None. The `env: Record<string, string>` is concrete. See
`04-generic-interfaces.md` §1 for the rejected generic sketch.

### Dependencies

- `ChannelProviderType` (type-only import, already in file).
- `node:os` `homedir` (read inside `stateDirFor` per call).
- `node:fs` `readFileSync`, `existsSync` (used by `readTokenFor` static).
- `node:path` `join` (used by `stateDirFor` static).
- **No new imports introduced.**

### Lifecycle (as shipped)

- **Constructed at app boot** by `src/config.ts` (or wherever the parsed
  env first touches `channel-provider`). Today this is `config.ts:324`
  via `readEnvFile()`. Pre-D.1 plan said the D.5 migration would move
  construction to `config.ts` boot sequence; D.5 was merged into D.1,
  so construction is already at boot (no separate migration needed).
- One instance per process (unless a test wants isolation).
- `static stateDirFor` and `readTokenFor` are pure functions and can be
  called without an instance (via `new ChannelEnv()` for default env).

### Free functions that REMAIN after D.1

| Symbol | Status |
|---|---|
| `getChannelToken(provider, env)` | **DELETED** (D.1, this commit) |
| `getChannelChatId(provider, env)` | **DELETED** (D.1, this commit) |
| `channelStateDir(provider, agentDir?)` | **DELETED** (D.1, this commit) |
| `readChannelToken(provider, envFilePath)` | **DELETED** (D.1, this commit) |
| `generateSlackAppManifest(appName)` | Free export — unchanged |
| `getSlackAppSetupInstructions()` | Free export — unchanged |
| `formatForSlackMrkdwn(text)` | Free export — unchanged (imported by `src/__tests__/format.test.ts`) |

---

## D2. Provider classes (5 concrete + 1 abstract base)

### Common contract

All 5 concrete providers `implements ChannelProvider`
(`channel-provider.ts:11-23`). The interface is **byte-stable** per
`review-correctness.md` C1:

```ts
readonly type: ChannelProviderType
readonly pluginId: string
readonly pluginPaneId: string
readonly envKeys: string[]
readonly stateDir: string
readonly chatIdFormat: string

sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>
sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
formatMessage(text: string): string
splitMessage(text: string): string[]
```

**No instance state.** All 5 providers today are frozen object literals
with **zero mutable fields** (`02 §3`). The constructor for the class
versions takes no arguments (or an optional `log: LoggerLike` if H.1
landed first); per-call token and chatId are method parameters exactly
as they are today.

### `TelegramProvider`

```ts
class TelegramProvider implements ChannelProvider {
  readonly type = 'telegram' as const
  readonly pluginId = 'telegram@claude-plugins-official'
  readonly pluginPaneId = 'plugin:telegram:telegram'
  readonly envKeys: readonly string[] = ['TELEGRAM_BOT_TOKEN']
  readonly stateDir = 'telegram'
  readonly chatIdFormat = 'numeric (e.g. 1268077055)'

  async sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>
  async sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
  async validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
  formatMessage(text: string): string   // forwards to formatForTelegram
  splitMessage(text: string): string[]   // forwards to splitMessage(text)

  private async telegramHttpPost(token: string, method: string, body: string, contentType: string): Promise<void>
}
```

- **Migration source:** `telegramProvider:53-104` (the literal) +
  `telegramHttpPost:27-51` (the helper). The helper becomes a `private`
  method.
- **Note:** `splitMessage: (text) => splitMessage(text)` at `:103` is a
  pure identity forward (no limit argument) — could be `splitMessage`
  directly per `02 §3` "Telegram is the odd one out". Written as an arrow
  today for symmetry; preserved verbatim.
- **No logger calls** (verified: zero `logger.<level>(` in 552 lines per
  `02 §10`).

### `SlackProvider`

```ts
class SlackProvider implements ChannelProvider {
  readonly type = 'slack' as const
  readonly pluginId = 'slack-channel@marveen-marketplace'
  readonly pluginPaneId = 'plugin:slack-channel:marveen-marketplace'
  readonly envKeys: readonly string[] = ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN']
  readonly stateDir = 'slack'
  readonly chatIdFormat = 'Slack channel/DM ID (e.g. C01234ABCDE)'

  async sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>
  async sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
  async validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
  formatMessage(text: string): string   // forwards to formatForSlackMrkdwn
  splitMessage(text: string): string[]   // splitMessage(text, SLACK_MAX_MESSAGE_LENGTH)

  private formatForSlackMrkdwn(text: string): string
}
```

- **Migration source:** `slackProvider:134-228` + `formatForSlackMrkdwn:114-132`.
- **`SLACK_MAX_MESSAGE_LENGTH = 4000`** at `:112` becomes a module-level
  `const` outside the class (preserved).
- **Three-round-trip upload for `sendPhoto`** at `:170, :183, :189` —
  preserved verbatim.

### `DiscordProvider`

```ts
class DiscordProvider implements ChannelProvider {
  readonly type = 'discord' as const
  readonly pluginId = 'discord@claude-plugins-official'
  readonly pluginPaneId = 'plugin:discord:discord'
  readonly envKeys: readonly string[] = ['DISCORD_BOT_TOKEN']
  readonly stateDir = 'discord'
  readonly chatIdFormat = 'Discord channel ID (e.g. 1234567890123456789)'

  async sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>
  async sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>
  async validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
  formatMessage(text: string): string   // forwards to formatForDiscord
  splitMessage(text: string): string[]   // splitMessage(text, DISCORD_MAX_MESSAGE_LENGTH)

  private formatForDiscord(text: string): string
}
```

- **Migration source:** `discordProvider:243-311` + `formatForDiscord:234-241`.
- **`DISCORD_MAX_MESSAGE_LENGTH = 2000`** at `:232` becomes module-level
  `const`.

### `UnsupportedDirectSendProvider` (abstract base)

**This is the only real dedup in the file.** `googlechatProvider:324-350`
and `teamsProvider:364-391` differ in five literal strings and nothing
else (`02 §3` cluster 2 + §8(a)). A base class removes ~30 duplicated
lines.

```ts
abstract class UnsupportedDirectSendProvider implements ChannelProvider {
  abstract readonly type: ChannelProviderType
  abstract readonly pluginId: string
  abstract readonly pluginPaneId: string
  abstract readonly envKeys: readonly string[]
  abstract readonly stateDir: string
  abstract readonly chatIdFormat: string

  async sendMessage(): Promise<void> {
    throw new Error(`${this.type}: direct dashboard send not supported (delivery via plugin MCP tools)`)
  }
  async sendPhoto(): Promise<void> {
    throw new Error(`${this.type}: direct dashboard send not supported (delivery via plugin MCP tools)`)
  }
  validateToken(): Promise<{ ok: boolean; botName?: string; error?: string }> {
    return Promise.resolve({ ok: true, botName: this.displayName })
  }
  formatMessage(text: string): string { return text }
  splitMessage(text: string): string[] { return splitMessage(text, this.maxLength) }

  protected abstract readonly displayName: string
  protected abstract readonly maxLength: number
}
```

- **Constructor:** none (or `protected` no-op if H.1 needs `log`).
- **Generic params:** none — the two subclasses are the only inhabitants
  of this base. A `TConfig` parameter would have `maxLength: number` and
  `displayName: string` payload, but `review-completeness.md` OE-6
  rejects generics with single consumers — and `02 §8` documents that a
  `TConfig` would collapse to `{ maxLength?: number }` with one caller.

### `GooglechatProvider`

```ts
class GooglechatProvider extends UnsupportedDirectSendProvider {
  readonly type = 'googlechat' as const
  readonly pluginId = 'googlechat@claude-channel-googlechat'
  readonly pluginPaneId = 'plugin:googlechat:googlechat'
  readonly envKeys: readonly string[] = ['GOOGLE_APPLICATION_CREDENTIALS', 'GOOGLECHAT_PROJECT_ID', 'GOOGLECHAT_SUBSCRIPTION']
  readonly stateDir = 'googlechat'
  readonly chatIdFormat = 'space resource name (e.g. spaces/AAAA)'

  protected readonly displayName = 'Google Chat'
  protected readonly maxLength = 4096   // was GOOGLECHAT_MAX_MESSAGE_LENGTH :322
}
```

- **Migration source:** `googlechatProvider:324-350`.
- **Net dedup:** the 27-line object literal collapses to 8 lines (six
  readonly fields + two protected fields). The throw bodies, the
  hardcoded `{ ok: true, botName: 'Google Chat' }`, and the identity
  `formatMessage` are inherited.

### `TeamsProvider`

```ts
class TeamsProvider extends UnsupportedDirectSendProvider {
  readonly type = 'teams' as const
  readonly pluginId = 'teams@marveen-marketplace'
  readonly pluginPaneId = 'plugin:teams:marveen-marketplace'
  readonly envKeys: readonly string[] = ['TEAMS_BOT_APP_ID', 'TEAMS_BOT_APP_PASSWORD', 'TEAMS_BOT_TENANT_ID']
  readonly stateDir = 'teams'
  readonly chatIdFormat = 'Teams conversation id (managed by the plugin per pairing)'

  protected readonly displayName = 'Microsoft Teams'
  protected readonly maxLength = 28000  // was TEAMS_MAX_MESSAGE_LENGTH :362
}
```

- **Migration source:** `teamsProvider:364-391`.
- **Why this base exists:** googlechat and teams differ in **5 literal
  strings** and the maxLength constant. The dedup is real (`02 §8(a)`).

### Common — generic params

None. Per `02 §8`, no `Provider<TConfig>` generic base is justified. The
3-cluster breakdown (telegram/slack/discord share nothing; googlechat/teams
are near-identical) does not produce a parameterisation with a second
consumer. See `04-generic-interfaces.md` §1.

### Common — constructor

The brief and `02 §10` agree: **D provider classes do not need a logger
in the constructor today** because no provider method calls
`logger.<level>(`. The class signatures above are argument-less
constructors.

If H.1 lands first and `04-generic-interfaces.md` §L's policy is "every
class takes `log: LoggerLike`", the constructor becomes:

```ts
constructor(_log?: LoggerLike)  // accepted for interface conformance; unused
```

with the param underscored to mark it unused. D is the cheapest consumer
of the H migration — see D.6 in `00-summary.md`.

### Common — dependencies

- `node:https` (telegram only): `request` for `telegramHttpPost`.
- `node:fs` `readFileSync` (telegram, slack, discord sendPhoto paths).
- `fetch` (global, available in Node 18+): slack, discord, telegram sendPhoto.
- `format.ts:3` `formatForTelegram`, `format.ts:50` `splitMessage(text, limit?)`.
- **No `test-run-marker` import** — the marker is applied by
  `TestRunMarkingDecorator` at D.4, not by the providers themselves.

### Common — lifecycle

- **One instance per provider type**, constructed once at module init
  (today: the 5 frozen object literals at `:53/134/243/324/364`). After
  refactor: either 5 frozen instances (`new TelegramProvider()` etc. at
  module init) or lazy construction inside `ChannelProviderRegistry`
  (D.3).
- **Stateless** — no `release()`, no `close()`, no cleanup. The class
  version of a telegram fetch handles its own connection cleanup.

---

## D3. `ChannelProviderRegistry`

### Source and migration

- **Source file:** `src/channel-provider.ts`.
- **Migration source:** `markedProviders:500-506` + `getProvider:508-510`.

### Public surface (signatures only)

```ts
class ChannelProviderRegistry {
  constructor(
    providers: Record<ChannelProviderType, ChannelProvider>,
    testRunMarker?: (text: string) => string  // optional decorator injection
  )

  get(type: ChannelProviderType): ChannelProvider
  list(): ChannelProviderType[]                // exposes the closed union for runtime use
}
```

### Method-by-method

| Method | Replaces | File:line | Notes |
|---|---|---|---|
| `get(type)` | `getProvider(type)` | `:508-510` | Preserves the exact `(ChannelProviderType) -> ChannelProvider` signature so all 18 importers and 17 test mocks continue resolving (`01 §7`). Default to `TelegramProvider` for unrecognized input would be wrong; the type system prevents it. |
| `list()` | n/a | n/a | New. Returns `Object.keys(this.providers) as ChannelProviderType[]`. Lets callers iterate the closed union without re-declaring it. |

### Constructor

- `(providers, testRunMarker?)`. The `providers` parameter is the
  resolved `Record<ChannelProviderType, ChannelProvider>` — typically the
  marked version (decorated by `TestRunMarkingDecorator` per D.4) but the
  registry itself does not apply marking. The optional `testRunMarker`
  exists so the registry can decorate on construction; defaulting to no
  decoration matches today's `providers:477` (the un-decorated table).
- **No I/O in the constructor.** Pure field assignment.

### Why wrapping `markedProviders` at all

The brief's intent is to absorb the lookup-table shape. The
`providers:477` (un-decorated) and `markedProviders:500` (decorated)
both have identical keys; both are exhaustively typed
`Record<ChannelProviderType, ChannelProvider>`. The un-decorated
`providers` table is **dead** today (`01 §2` — no reader outside the
module). The class conversion either:

(a) Keeps both tables and exposes two constructors, or
(b) Drops the un-decorated table entirely (since nothing reads it), or
(c) Keeps both for symmetry but registers only the decorated one in the
    default `getProvider` flow.

**Recommendation:** (b). `providers:477` is dead code preserved
presumably for symmetry; per CLAUDE.md §3 ("If you notice unrelated dead
code, mention it — don't delete it") this is **flagged here, not
removed**. After D.3 lands the registry, the dead table can be removed
under the same rule's second clause ("Remove imports/variables/functions
that YOUR changes made unused").

### Generic params

None. The keys are `ChannelProviderType` (a closed string-union) and the
values are `ChannelProvider` (a closed interface). No parameterisation is
load-bearing.

### Dependencies

- `ChannelProviderType` (type-only).
- `ChannelProvider` (type-only).
- `test-run-marker.ts:24` `markIfTestRun` (only if `testRunMarker?` is
  used; default is no decoration).

### Lifecycle

- **One instance per process**, constructed at module init.
- Holds a `readonly` reference to the providers record; no `add`/`remove`
  methods. The registry is the read path, not the write path.

### Free functions that REMAIN after D.3

| Symbol | Location | Why it stays |
|---|---|---|
| `getProvider(type)` | `channel-provider.ts:508-510` | Thin wrapper: `(t) => registry.get(t)`. Removed in D.5 after every importer migrates. |
| `getProviderType(envValue)` | `channel-provider.ts:512-518` | Pure function; does NOT move into the registry (it takes no provider, only an env string). Stays free. |
| `providers` | `channel-provider.ts:477-483` | Dead today; removed in D.3 as dead-code-cleanup OR kept for symmetry per CLAUDE.md §3. |

---

## D4. `TestRunMarkingDecorator`

### Source and migration

- **Source file:** `src/channel-provider.ts`.
- **Migration source:** `withTestRunMarking(provider): ChannelProvider`
  at `channel-provider.ts:490-498`.

### Critical migration hazard

The current function uses `{ ...provider, sendMessage, sendPhoto }` —
an **own-enumerable-property spread**. Today this works because every
member of every provider literal is an own property. The moment any
provider becomes a `class` (D.2), `formatMessage`, `splitMessage`,
`validateToken` move to the prototype and the spread **silently drops
them**. TypeScript catches the structural gap if the return-type
annotation `ChannelProvider` is kept (the spread result must satisfy the
interface), but the obvious "fix" — looser annotation — produces an
object that satisfies neither the interface nor `notify.ts:16-17`. The
correct conversion is **class form with explicit delegation of all 11
interface members**, not a spread.

### Two viable forms

**Form A (recommended): explicit-delegation class**

```ts
class TestRunMarkingDecorator implements ChannelProvider {
  constructor(
    private readonly inner: ChannelProvider,
    private readonly mark: (text: string) => string = markIfTestRun,
  ) {}

  readonly type: ChannelProviderType
  readonly pluginId: string
  readonly pluginPaneId: string
  readonly envKeys: readonly string[]
  readonly stateDir: string
  readonly chatIdFormat: string

  sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void> {
    return this.inner.sendMessage(token, chatId, this.mark(text), parseMode)
  }
  sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void> {
    return this.inner.sendPhoto(token, chatId, photoPath, this.mark(caption))
  }
  validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }> {
    return this.inner.validateToken(token)
  }
  formatMessage(text: string): string { return this.inner.formatMessage(text) }
  splitMessage(text: string): string[] { return this.inner.splitMessage(text) }
}
```

Tradeoffs:

- (+) Survives the class-conversion in D.2 — no spread, no dropped
  prototype methods.
- (+) The `mark` parameter is injectable, enabling tests to substitute a
  no-op marker without stubbing `markIfTestRun`.
- (+) Compile-time `implements ChannelProvider` enforces explicit
  delegation of every member — the compiler catches a missing delegation
  immediately rather than at runtime.
- (-) 11 method delegations + 6 readonly pass-throughs is verbose
  compared to a spread; mitigated by the fact that a future interface
  addition fails loudly here and silently in the spread form.

**Form B: explicit-delegation function (no class)**

```ts
function withTestRunMarking(
  provider: ChannelProvider,
  mark: (text: string) => string = markIfTestRun,
): ChannelProvider {
  return {
    type: provider.type,
    pluginId: provider.pluginId,
    pluginPaneId: provider.pluginPaneId,
    envKeys: provider.envKeys,
    stateDir: provider.stateDir,
    chatIdFormat: provider.chatIdFormat,
    sendMessage: (token, chatId, text, parseMode) =>
      provider.sendMessage(token, chatId, mark(text), parseMode),
    sendPhoto: (token, chatId, photoPath, caption) =>
      provider.sendPhoto(token, chatId, photoPath, mark(caption)),
    validateToken: (token) => provider.validateToken(token),
    formatMessage: (text) => provider.formatMessage(text),
    splitMessage: (text) => provider.splitMessage(text),
  }
}
```

Tradeoffs:

- (+) Same correctness as Form A — every member is explicitly enumerated.
- (+) No class surface; matches the existing free-function idiom of the
  file.
- (-) Test injection of the `mark` function works the same way.
- (-) If a future commit adds a 12th interface member, Form B fails
  silently (TypeScript flags it via the return-type annotation only if
  `strict` is on; the spread form fails noisily today).

### Decision: **Form B (explicit-delegation function)**

**Rationale.** Both forms are correct under D.2's class conversion. The
choice is aesthetic. Form B is preferred because:

1. **Module locality.** `markIfTestRun` lives in `test-run-marker.ts`.
   Keeping the decorator as a function (not a class) keeps the decorator
   file-local and avoids importing the decorator class from anywhere
   outside the module that builds `markedProviders`. Class form is
   useful only if the decorator needs lifecycle (`release()`, `close()`)
   — it doesn't.
2. **Test injection parity.** Both forms take the `mark` parameter
   equally.
3. **Migration size.** Form B is ~20 lines, Form A is ~30 lines + the
   `class` keyword + a `private readonly inner` field. CLAUDE.md §2
   ("minimum code that solves the problem") biases toward Form B.
4. **TypeScript catch parity.** With `return type: ChannelProvider`
   annotation on the function (preserved from today), Form B catches a
   missing member at compile time, equivalent to `implements` in Form A.

The **migration step** in both forms is the same: replace `{ ...provider,
sendMessage, sendPhoto }` with explicit enumeration of every interface
member. The form difference is class-vs-function.

### Lifecycle (Form A) / Module init (Form B)

- **(A)** One instance per wrapped provider, constructed at module init
  inside `ChannelProviderRegistry`'s constructor.
- **(B)** Called once per provider at module init, inside the
  `markedProviders` initialiser; no retained identity.

---

## Summary of free functions vs class surface after D.1–D.4

| Symbol | After D.1–D.4 | Notes |
|---|---|---|
| `ChannelEnv` class | **new** | D.1 deliverable |
| `TelegramProvider` class | **new** | D.2 deliverable |
| `SlackProvider` class | **new** | D.2 deliverable |
| `DiscordProvider` class | **new** | D.2 deliverable |
| `UnsupportedDirectSendProvider` abstract base | **new** | D.2 deliverable |
| `GooglechatProvider` class | **new** | D.2 deliverable |
| `TeamsProvider` class | **new** | D.2 deliverable |
| `ChannelProviderRegistry` class | **new** | D.3 deliverable |
| `TestRunMarkingDecorator` (Form B: function) | **new shape, same name** | D.4 deliverable |
| `getChannelToken(provider, env)` | wrapper | removed in D.5 |
| `getChannelChatId(provider, env)` | wrapper | removed in D.5 |
| `channelStateDir(provider, agentDir?)` | wrapper | removed in D.5 |
| `readChannelToken(provider, envFilePath)` | wrapper | removed in D.5 |
| `getProvider(type)` | wrapper | removed in D.5 |
| `getProviderType(envValue)` | free export | unchanged across all phases |
| `providers` table (`:477`) | dead-code-cleanup | removed in D.3 (allowed by CLAUDE.md §3 since the table is unused) |
| `markedProviders` table (`:500`) | internal initialiser | retained as `ChannelProviderRegistry` constructor's `providers` argument |
| `generateSlackAppManifest` / `getSlackAppSetupInstructions` | free exports | unchanged |
| `formatForSlackMrkdwn` | free export | unchanged |
| `ChannelProviderType` / `ChannelProvider` | free exports | unchanged (interface) |
