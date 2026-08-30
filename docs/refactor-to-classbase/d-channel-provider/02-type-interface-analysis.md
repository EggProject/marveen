# D subsystem -- Type & Interface Analysis (`src/channel-provider.ts`)

Scope: `src/channel-provider.ts` (552 lines, read in full on 2026-08-30).
Planning only -- **no source files were modified**.

Reference inputs (cited, not modified):
`h-cross-cutting/04-generic-interfaces.md` (§L `LoggerLike`),
`h-cross-cutting/03-class-boundaries.md`,
`h-cross-cutting/review-correctness.md` (HR4),
`e-process-lock/02-type-interface-analysis.md` (OE-6 precedent),
`review-correctness.md` (C1, C2).

---

## Brief summary

The D subsystem's type surface is small and unusually clean: **two exported
type declarations total** (`ChannelProviderType:9`, `ChannelProvider:11`),
zero `any`, zero `as unknown as`, zero `as const`, and six `as` casts that
are all `await resp.json() as {…}` response-shape assertions -- the ordinary
unavoidable kind. All five provider implementations are **stateless object
literals**: they hold no mutable fields, no captured connection handles, no
caches; every one of the six `readonly` fields is a compile-time constant
string or string array, and token/chatId arrive as **per-call parameters**,
exactly as framework C1 established. The four top-level helpers
(`getChannelToken:459`, `getChannelChatId:467`, `channelStateDir:520`,
`readChannelToken:533`) are pure functions over a `ChannelProviderType`
discriminator, and three of them contain the *same* 5-branch dispatch chain
keyed on that discriminator -- the single largest consolidation opportunity in
the file, worth a `Record<ChannelProviderType, …>` lookup table rather than a
generic. The D subsystem has **zero logger call sites**: the
`import { logger } from './logger.js'` at line 5 is dead, so D needs no
`log: LoggerLike` constructor field at all, which makes it the cheapest
consumer of the H migration. The one genuine migration hazard is
`withTestRunMarking:490`, whose `{ ...provider }` spread silently drops
prototype methods the moment the five providers become classes.

---

## §1. `ChannelProvider` interface audit (`channel-provider.ts:11-23`)

Verbatim from source, lines 11-23:

```ts
export interface ChannelProvider {
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
}
```

### Readonly fields (6)

| Line | Field | Type | Mutability | Production consumers |
|---:|---|---|---|---|
| 12 | `type` | `ChannelProviderType` | `readonly` | none directly (the registry key carries it) |
| 13 | `pluginId` | `string` | `readonly` | `web/agent-process.ts:1269`, `web/channel-monitor.ts:642, 712, 925` |
| 14 | `pluginPaneId` | `string` | `readonly` | `web/channel-mcp-reconnect.ts:82`, `web/channel-health-monitor.ts:117` |
| 15 | `envKeys` | `string[]` | `readonly` *reference*, **mutable array** | **zero** -- test-only (`__tests__/channel-provider.test.ts:55, 65`) |
| 16 | `stateDir` | `string` | `readonly` | **zero** -- test-only (`__tests__/channel-provider.test.ts:56, 66`) |
| 17 | `chatIdFormat` | `string` | `readonly` | **zero** -- test-only (`__tests__/channel-provider.test.ts:57`) |

Two notes that matter for the class conversion:

1. **`readonly envKeys: string[]` is shallow-readonly.** The reference cannot
   be reassigned; the array contents can (`p.envKeys.push('X')` compiles
   today). If the conversion touches this field at all, `readonly envKeys:
   readonly string[]` is the strict form. This is a *tightening*, not a
   behaviour change: no production caller mutates it because no production
   caller reads it.
2. **`stateDir` name collision.** The interface's `readonly stateDir: string`
   is a bare subdirectory *name* (`'telegram'`, `'slack'`, …), while the
   `channelStateDir()` helper at `:520` returns an absolute *path*
   (`~/.claude/channels/telegram`). They are different things wearing the same
   noun. Any `ChannelEnv.getStateDir()` method must not be confused with
   `provider.stateDir` -- see §9.

### Method signatures (5)

| Line | Signature (verbatim) | Return |
|---:|---|---|
| 18 | `sendMessage(token: string, chatId: string, text: string, parseMode?: string): Promise<void>` | `Promise<void>` |
| 19 | `sendPhoto(token: string, chatId: string, photoPath: string, caption: string): Promise<void>` | `Promise<void>` |
| 20 | `validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>` | anonymous inline object |
| 21 | `formatMessage(text: string): string` | `string` |
| 22 | `splitMessage(text: string): string[]` | `string[]` |

Confirmations against framework **C1** (`review-correctness.md:28-67`), all
verified line-by-line against the live source:

- `sendMessage` takes **four** parameters starting with `token`, not
  `(text, opts?)`. Return is `Promise<void>`, **not** `Promise<SendResult>`.
- `splitMessage` takes **only `text`**. There is no `max` parameter on the
  interface. Per-provider limits are baked into each implementation's
  closure (`:227`, `:310`, `:349`, `:390`) rather than passed by the caller.
- `stateDir` is a readonly **property**, not a method.
- There is **no** `getToken`, `getChatId`, `readToken` method on the
  interface. Those names exist only as the top-level helpers in §5.
- `parseMode?: string` is the only optional parameter anywhere in the
  interface. It is a loose `string`, not a union of the Telegram-legal values
  (`'HTML' | 'Markdown' | 'MarkdownV2'`); only `notify.ts:22` supplies it and
  only telegram reads it (`:63`).

---

## §2. `ChannelProviderType` union (`channel-provider.ts:9`)

```ts
export type ChannelProviderType = 'telegram' | 'slack' | 'discord' | 'googlechat' | 'teams'
```

Exact member list, in declaration order:

1. `'telegram'`
2. `'slack'`
3. `'discord'`
4. `'googlechat'`
5. `'teams'`

The union is the file's discriminator and appears in every helper signature.
It is closed and exhaustive; `getProviderType:512` is the narrowing entry
point from untrusted `string | undefined` and defaults to `'telegram'` on any
unrecognised value (`:517`) rather than throwing -- i.e. it is a *total*
coercion, not a validator. It is used as a `Record` key type at two sites
(`:477`, `:500`), which is what makes the registry exhaustiveness-checked by
the compiler today.

Cross-file consumers importing the type: `config.ts:8`,
`channel-coordinator/liveness.ts:16`, `web/channel-request-watcher.ts:5`,
`web/agent-process.ts:40`, `web/channel-invites.ts:30`,
`web/channel-monitor.ts:44`.

---

## §3. Five provider implementations -- instance-state audit

| Provider | Line | Instance state? | Mutable fields | Captured closures |
|---|---:|---|---|---|
| `telegramProvider` | 53 | **No -- stateless** | none | `formatForTelegram` (import), `splitMessage` (import), `telegramHttpPost:27` (module fn) |
| `slackProvider` | 134 | **No -- stateless** | none | `formatForSlackMrkdwn:114`, `SLACK_MAX_MESSAGE_LENGTH:112` (module const) |
| `discordProvider` | 243 | **No -- stateless** | none | `formatForDiscord:234`, `DISCORD_MAX_MESSAGE_LENGTH:232` |
| `googlechatProvider` | 324 | **No -- stateless** | none | `GOOGLECHAT_MAX_MESSAGE_LENGTH:322` |
| `teamsProvider` | 364 | **No -- stateless** | none | `TEAMS_MAX_MESSAGE_LENGTH:362` |

**Every provider is a frozen-by-convention singleton object literal.** No
provider holds a token, a chat id, a socket, an HTTP agent, a rate-limit
counter, or a cache. The only per-provider "state" is the module-level
`*_MAX_MESSAGE_LENGTH` const captured by each `splitMessage` arrow, which is
a compile-time constant, not runtime state. This directly confirms C1's
"Token/chatId are *parameters*, not instance state" and refutes A13's
proposed `constructor(opts: { token, chatId, stateDir })`
(`03-class-boundaries.md:357`) -- there is nothing for such a constructor to
hold.

### Divergent vs similar

Behaviourally the five split into **three clusters**, not five equals:

| Axis | telegram | slack | discord | googlechat | teams |
|---|---|---|---|---|---|
| `sendMessage` transport | `node:https` (`telegramHttpPost:27`) | `fetch` | `fetch` | **throws** (`:335`) | **throws** (`:376`) |
| `sendPhoto` transport | `fetch` multipart | `fetch` 3-step upload API | `fetch` multipart | **throws** (`:339`) | **throws** (`:380`) |
| `validateToken` | live `getMe` | live `auth.test` | live `users/@me` | **hardcoded `{ ok: true }`** (`:345`) | **hardcoded `{ ok: true }`** (`:386`) |
| `formatMessage` | `formatForTelegram` | `formatForSlackMrkdwn` | `formatForDiscord` | identity `(text) => text` | identity `(text) => text` |
| `splitMessage` limit | *default* (no arg) | `4000` | `2000` | `4096` | `28000` |

- **Cluster 1 (real transports):** telegram, slack, discord. Each has a
  genuinely different HTTP shape -- telegram uses raw `node:https` for
  `sendMessage` but `fetch` for `sendPhoto` (an inconsistency inside a single
  object); slack needs three sequential round-trips for a file upload
  (`:170`, `:183`, `:189`); discord uses a single multipart POST.
  **No shared body survives abstraction.**
- **Cluster 2 (unsupported-direct-send stubs):** googlechat and teams are
  *near-identical*. Both throw from `sendMessage` and `sendPhoto` with the
  same message template (`'<name>: direct dashboard send not supported
  (delivery via plugin MCP tools)'`, `:335/:339` vs `:376/:380`), both return
  a hardcoded `{ ok: true, botName: … }` from `validateToken`, and both use
  the identity `formatMessage`. **Four of the five members differ only in a
  literal string.** This is the one place real dedup exists -- see §8.
- **Telegram is the odd one out on `splitMessage`:** it alone calls
  `splitMessage(text)` with no limit (`:103`), inheriting
  `format.ts:50`'s `limit = MAX_MESSAGE_LENGTH` default. The other four pass
  an explicit constant. The wrapper arrow `(text) => splitMessage(text)` at
  `:103` is therefore a pure identity forward and could be
  `splitMessage` directly; it is written as an arrow only for symmetry with
  its four siblings.

---

## §4. `SendOpts` / `SendResult` / `ValidateTokenResult`

**None of these three types exist.** Verified:

```
grep -rn "SendOpts\|SendResult\|ValidateTokenResult" src/
```
returns exactly two unrelated hits, both in a different subsystem:
`src/web/federation/bridge.ts:43` (`export type BridgeSendResult`) and
`:98` (its use as a return type). Neither is imported by
`channel-provider.ts`.

| Name | Exists in `src/`? | Exported? | Where the plan claims it |
|---|---|---|---|
| `SendOpts` | **No** | n/a | `03-class-boundaries.md:345` (A13), refuted by C1 |
| `SendResult` | **No** | n/a | `03-class-boundaries.md:345` (A13), refuted by C1 |
| `ValidateTokenResult` | **No** | n/a | not claimed; would be the natural name for the `:20` inline type |

### Helper types actually present in the file

There are **none**. `channel-provider.ts` exports exactly two type
declarations -- `ChannelProviderType:9` and `ChannelProvider:11` -- and
declares zero non-exported local type aliases or interfaces (verified:
`grep -nE 'interface |^type |export type' src/channel-provider.ts` returns
only lines 9 and 11).

Consequences for the class conversion:

- **`validateToken`'s return type is anonymous and structurally duplicated
  five times.** The literal `{ ok: boolean; botName?: string; error?: string }`
  appears once in the interface (`:20`) and is re-inferred at each of the five
  implementations. Two production consumers destructure it
  (`web/routes/agents.ts:968`, `:1046`, plus `:1435`). Naming it
  `export interface ValidateTokenResult { ok: boolean; botName?: string;
  error?: string }` is a **safe, zero-behaviour-change extraction** and the
  only new type D needs. It is not a generic and not a discriminated union;
  do *not* "improve" it into `{ ok: true; botName } | { ok: false; error }`
  as part of this refactor -- `:218` returns `{ ok: true, botName: data.user
  || data.bot_id }` where `botName` can be `undefined`, and `:345`/`:386`
  return `ok: true` with no `error`, so the discriminated form would compile
  but silently change what callers may assume.
- **Do not introduce `SendOpts`/`SendResult`.** Per C1, `sendMessage` returns
  `Promise<void>` and signals failure by throwing (`:43`, `:85`, `:157`,
  `:161`, `:262`, `:290`). Every caller (`notify.ts:22`, `:31`) relies on the
  throw. Adding a `SendResult` return would be a behaviour change disguised
  as a type change.

---

## §5. Top-level helpers -- typed audit (4)

All four are `export function`, all pure, all keyed on the
`ChannelProviderType` discriminator.

### 5.1 `getChannelToken` (`:459`)

```ts
export function getChannelToken(provider: ChannelProviderType, env: Record<string, string>): string
```

- Both parameters required. Returns `string`, never `null`/`undefined` --
  missing keys collapse to `''` via `?? ''` at `:460-464`.
- Key map: `slack -> SLACK_BOT_TOKEN`, `discord -> DISCORD_BOT_TOKEN`,
  `googlechat -> GOOGLECHAT_PROJECT_ID`, `teams -> TEAMS_BOT_APP_ID`,
  fallthrough (telegram) `-> TELEGRAM_BOT_TOKEN`.
- Note the fallthrough at `:464` is not `provider === 'telegram'`; any
  unreached value would also land there. Safe today because the union is
  closed, but it means the compiler gives **no exhaustiveness check**.
- Sole production caller: `config.ts:325`.

### 5.2 `getChannelChatId` (`:467`)

```ts
export function getChannelChatId(provider: ChannelProviderType, env: Record<string, string>): string
```

- Identical shape to 5.1, different key map: `slack -> SLACK_CHANNEL_ID`,
  `discord -> DISCORD_CHANNEL_ID`, `googlechat -> GOOGLECHAT_SPACE_ID`,
  `teams -> TEAMS_ALLOWED_CONVERSATION_ID`, fallthrough
  `-> ALLOWED_CHAT_ID`. Note the telegram key breaks the naming convention
  (`ALLOWED_CHAT_ID`, not `TELEGRAM_CHAT_ID`).
- Sole production caller: `config.ts:326`.

### 5.3 `channelStateDir` (`:520`)

```ts
export function channelStateDir(provider: ChannelProviderType, agentDir?: string): string
```

- **Second parameter is optional** and is an agent directory path, *not* an
  env record. Absent -> `join(homedir(), '.claude', 'channels')`;
  present -> `join(agentDir, '.claude', 'channels')` (`:521-523`).
- The subdir ternary chain (`:525-529`) produces exactly the same five
  strings as the providers' `readonly stateDir` fields (`:58`, `:139`,
  `:248`, `:329`, `:369`). **This is a duplicated source of truth.**
- The most-called helper in D: 14 production call sites across
  `channel-coordinator/liveness.ts:193, 194`,
  `web/channel-request-watcher.ts:77, 109`, `web/agent-process.ts:838, 956`,
  `web/discord-group-bootstrap.ts:39`, `web/schedule-runner.ts:409, 410`,
  `web/channel-poller-reap.ts:199, 225`, `web/agent-scaffold.ts:721`,
  `web/channel-invites.ts:60, 201, 207`, `web/channel-monitor.ts:1286, 1704`,
  `web/routes/agents.ts:336, 337`.

### 5.4 `readChannelToken` (`:533`)

```ts
export function readChannelToken(provider: ChannelProviderType, envFilePath: string): string | null
```

- **Second parameter is `envFilePath: string` -- a filesystem path, not an
  env record.** Every caller composes it as
  `join(channelStateDir(provider, …), '.env')`
  (`web/channel-request-watcher.ts:78`, `web/agent-process.ts:839, 957`,
  `web/channel-monitor.ts:1287, 1705`).
- **Only helper returning `string | null`**, with three distinct null paths:
  file missing (`:534`), read throws (`:539`), regex miss (`:550`).
- Key map at `:543-548` is **byte-identical to `getChannelToken`'s** key map
  (5.1). Two copies of the same table, 84 lines apart.
- The regex `new RegExp(\`${key}=(.+)\`)` at `:549` is unanchored, so a line
  such as `OLD_TELEGRAM_BOT_TOKEN=x` matches the telegram key. Pre-existing;
  noted, not in refactor scope.

### Bonus: `getProviderType` (`:512`) and `getProvider` (`:508`)

Not in the "4 helpers" list but part of the same dispatch family:

```ts
export function getProvider(type: ChannelProviderType): ChannelProvider
export function getProviderType(envValue: string | undefined): ChannelProviderType
```

`getProviderType` is D's only narrowing boundary from untyped input. It is a
total coercion (unknown -> `'telegram'`), never throws, and has no
"invalid" signal -- callers cannot distinguish "explicitly telegram" from
"unset/garbage". Callers: `config.ts:324`, `web/agent-process.ts:338`.

---

## §6. `withTestRunMarking` decorator (`:490-498`)

```ts
function withTestRunMarking(provider: ChannelProvider): ChannelProvider {
  return {
    ...provider,
    sendMessage: (token, chatId, text, parseMode) =>
      provider.sendMessage(token, chatId, markIfTestRun(text), parseMode),
    sendPhoto: (token, chatId, photoPath, caption) =>
      provider.sendPhoto(token, chatId, photoPath, markIfTestRun(caption)),
  }
}
```

| Property | Finding |
|---|---|
| Signature | `(provider: ChannelProvider) => ChannelProvider` |
| Exported? | **No** -- module-private, applied once at `:500-506` |
| Changes the return type? | **No.** Input and output are both `ChannelProvider`. It is an *endomorphism*, not a widening/narrowing wrapper. |
| Changes any method signature? | **No.** Both overridden methods keep their exact parameter lists and `Promise<void>` returns. |
| What it actually changes | The `text` argument of `sendMessage` and the `caption` argument of `sendPhoto` are passed through `markIfTestRun(text: string): string` (`test-run-marker.ts:24`), which prefixes a marker when `isTestRun()` and is idempotent (`:25`). |
| Parameter typing | The arrow parameters are **contextually typed** by the `ChannelProvider` return annotation -- no explicit annotations, no casts. Removing the return-type annotation would silently widen them to `any` under a non-strict config. |

### Migration hazard (important)

`{ ...provider }` is an **own-enumerable-property spread**. Today all five
providers are object literals, so every member is an own property and the
spread copies all of them. **The moment A13 turns them into
`class TelegramChannelProvider implements ChannelProvider`, `formatMessage`,
`splitMessage` and `validateToken` become prototype methods and the spread
silently drops them** -- producing an object that satisfies neither the
interface at runtime nor `notify.ts:16-17`
(`provider.formatMessage(...)`, `provider.splitMessage(...)` would throw
`TypeError: … is not a function`). TypeScript would **not** catch this:
`{ ...instance, sendMessage, sendPhoto }` is inferred as a type lacking those
members and would fail the `ChannelProvider` return annotation, so in fact
the compiler *does* flag it -- but only if the annotation is kept, and the
tempting "fix" is to loosen the annotation. The correct conversion is A14's
`class TestRunMarkingDecorator implements ChannelProvider`
(`03-class-boundaries.md:365-370`) with explicit delegation of all 11
members, **not** a spread.

---

## §7. Unsafe casts audit

Command: `grep -nE ' as | as any|: any|as unknown as|as const' src/channel-provider.ts`

| Pattern | Count | Verdict |
|---|---:|---|
| `as any` | **0** | clean |
| `: any` | **0** | clean |
| `as unknown as` | **0** | clean |
| `as const` | **0** | clean (none present, none needed -- the union at `:9` is a declared type alias, not an inferred literal) |
| `<T>` angle-bracket assertion | **0** | clean |
| `!` non-null assertion | **0** in this file | clean |
| plain `as` | **6** | all `await resp.json() as {…}` |

The six `as` sites, verbatim:

| Line | Cast |
|---:|---|
| 92 | `await resp.json() as { ok: boolean; result?: { username: string; id: number } }` |
| 159 | `await resp.json() as { ok: boolean; error?: string }` |
| 178 | `await urlResp.json() as { ok: boolean; upload_url?: string; file_id?: string; error?: string }` |
| 201 | `await completeResp.json() as { ok: boolean; error?: string }` |
| 216 | `await resp.json() as { ok: boolean; bot_id?: string; user?: string; error?: string }` |
| 299 | `await resp.json() as { id?: string; username?: string }` |

**Assessment:** these are `unknown -> shape` assertions on external HTTP JSON.
`Response.json()` returns `Promise<any>` in the DOM lib, so the assertion is
in fact *narrowing* `any` to a declared shape -- it makes the code safer, not
less safe. Each is defensively consumed (`if (data.ok && data.result)` at
`:93`, `if (!urlData.ok || !urlData.upload_url || !urlData.file_id)` at
`:179`, `if (resp.ok && data.username)` at `:300`), so a shape mismatch
degrades to the error branch rather than a crash. Replacing them with
project typeguards (per CLAUDE.md §7 "kötelező a typeguardokat használni")
is a defensible follow-up but is **behaviour-preserving churn** and should be
a separate commit from the class conversion, not bundled into it. Note that
`:159` and `:201` assert the *same* shape 42 lines apart -- a named
`SlackApiAck` interface would remove one duplicate.

**Related non-type lint note (out of scope, flagged not fixed):** `:70` and
`:269` use string concatenation (`'----FormBoundary' + Date.now()`), which
CLAUDE.md §7 forbids in favour of template strings. Pre-existing; mentioned
because a class conversion will touch those lines.

---

## §8. Generic opportunities

### Verdict: **no `Provider<TConfig>` generic base class.** Rejected.

A hypothetical `abstract class Provider<TConfig>` would have to parameterise
over "the per-provider configuration". Working out what `TConfig` would be:

| Provider | `TConfig` would be |
|---|---|
| telegram | `{}` (no limit const, no extra fields) |
| slack | `{ maxLength: 4000 }` |
| discord | `{ maxLength: 2000 }` |
| googlechat | `{ maxLength: 4096 }` |
| teams | `{ maxLength: 28000 }` |

`TConfig` collapses to a single optional `number`. A type parameter whose
only inhabitant is `{ maxLength?: number }` is a parameter with **one
consumer and no second caller** -- precisely the pattern
`review-completeness.md` **OE-6** rejects, applied in
`e-process-lock/02-type-interface-analysis.md:303-305` to kill
`LockContext<T>` and again at `:504-506` to kill
`DeferToPeerError<TPid = number>`. The same verdict applies here, for the
same reason and with the same evidence shape: no call site would benefit
from the parameter, and variance over `TConfig` would be forced to invariant
(it appears in constructor parameter position and in a read position inside
`splitMessage`), matching `review-correctness.md` R5's default-invariance
rule.

Further: the three real transports (§3 cluster 1) share **zero** method
bodies. `sendMessage` is `node:https` for telegram, single-`fetch` for
discord, single-`fetch`-with-`data.ok`-recheck for slack. `sendPhoto` is
hand-rolled multipart for telegram and discord (with *different* field names
and a different JSON envelope) and a three-round-trip upload protocol for
slack. A shared base could host no implementation, only `abstract` members --
i.e. the interface we already have.

### What *is* justified: two non-generic consolidations

**(a) A `UnsupportedDirectSendProvider` abstract base for googlechat +
teams.** These two differ in five literal strings and nothing else
(`:332-346` vs `:372-387`). A base holding

- `sendMessage()` / `sendPhoto()` that throw
  `` `${this.type}: direct dashboard send not supported (delivery via plugin MCP tools)` ``
- `validateToken()` returning `{ ok: true, botName: this.displayName }`
- `formatMessage(text) { return text }`

removes ~30 duplicated lines and leaves each subclass declaring only its six
readonly constants plus `maxLength`. **Non-generic**, two concrete
subclasses, real dedup. This is the single strongest structural win in D.

**(b) A single dispatch table replacing four 5-branch chains.** The file
contains the *same* five-way `ChannelProviderType` dispatch four times:
`getChannelToken:460-464`, `getChannelChatId:468-472`,
`channelStateDir:525-529`, `readChannelToken:543-548`. Two of them
(`getChannelToken` and `readChannelToken`) resolve to **identical** key sets,
and `channelStateDir`'s branch duplicates the providers' `readonly stateDir`
values. One table:

```
Record<ChannelProviderType, { tokenKey: string; chatIdKey: string; subdir: string }>
```

collapses all four to `TABLE[provider].tokenKey` etc., makes the mapping a
single source of truth, and -- unlike the current fallthrough `return`s --
gives the compiler a genuine exhaustiveness check when a sixth provider is
added. **Non-generic, a plain mapped constant.**

**(c) Name the `validateToken` return shape** (see §4). One `export
interface ValidateTokenResult`. Not a generic.

---

## §9. `ChannelEnv` class sketch

Per C1's concrete fix (`review-correctness.md:58-63`): move
`getChannelToken` / `getChannelChatId` / `channelStateDir` /
`readChannelToken` into a `ChannelEnv` helper, leaving the five providers
stateless and per-call-parameterised.

### Correction to the assignment's proposed method list

The task brief sketches `getToken(provider, env?)`, `getChatId(provider,
env?)`, `getStateDir(provider)`, `readToken(provider, env?)`. Two of these do
not match the source and must be corrected before use:

| Brief's sketch | Source reality | Correction |
|---|---|---|
| `getStateDir(provider)` | `channelStateDir(provider, agentDir?: string)` -- 14 of the 19 call sites pass the second argument | `getStateDir(provider, agentDir?: string)` |
| `readToken(provider, env?)` | `readChannelToken(provider, envFilePath: string)` -- the second arg is a **file path**, never an env record | `readToken(provider, envFilePath: string)` |

Dropping `agentDir` would break `channel-coordinator/liveness.ts:193`,
`web/agent-process.ts:838, 956`, `web/channel-invites.ts:61, 207`,
`web/schedule-runner.ts:410`, `web/routes/agents.ts:337`,
`web/channel-poller-reap.ts:199, 225`, `web/agent-scaffold.ts:721`,
`web/channel-request-watcher.ts:77, 109`, `web/channel-monitor.ts:1704`.
Conflating `envFilePath` with an env record would break all five
`readChannelToken` call sites.

### Shape

```
class ChannelEnv
  constructor(
    env: Record<string, string>,      // NOT process.env -- see note below
    home: string = homedir(),         // injected for testability
  )

  getToken(provider: ChannelProviderType): string
  getChatId(provider: ChannelProviderType): string
  getStateDir(provider: ChannelProviderType, agentDir?: string): string
  readToken(provider: ChannelProviderType, envFilePath: string): string | null
```

Return types are carried over verbatim from §5: `string`, `string`,
`string`, `string | null`.

### Constructor source -- **not `process.env`**

The brief says "constructor (process.env source)". The source disagrees and
the source wins. `getChannelToken`/`getChannelChatId`'s only production
caller is `config.ts:325-326`, which passes `env` from
`const env = readEnvFile()` (`config.ts:17`), i.e.
`readEnvFile(keys?: string[]): Record<string, string>` at `src/env.ts:13` --
a parser over `${PROJECT_ROOT}/.env`, **not** `process.env`. Constructing
`ChannelEnv` from `process.env` would change which values `CHANNEL_TOKEN` and
`CHANNEL_CHAT_ID` resolve to. The constructor must take the record as a
parameter; whether the *caller* sources it from `readEnvFile()` or
`process.env` stays the caller's decision, and today the answer is
`readEnvFile()`.

`homedir()` is injected as a second constructor parameter because
`channelStateDir:523` calls it directly today, which is the file's only
non-deterministic dependency and the reason its tests must stub `node:os`.

### Notes

- `env` is only consumed by `getToken`/`getChatId`; `getStateDir` and
  `readToken` do not touch it. That asymmetry is fine -- one class, two
  fields, four methods -- but it is worth recording so a reviewer does not
  "helpfully" thread `env` into the other two.
- The `readToken` file-read (`existsSync`/`readFileSync`, `:534`/`:537`)
  is the class's only I/O and the only member needing a filesystem stub.
- The dispatch table from §8(b) becomes a `static readonly` field on
  `ChannelEnv`, which is exactly where it wants to live.
- **`getProviderType` should not move into `ChannelEnv`.** It takes no env
  record and no path; it is a pure `string | undefined -> ChannelProviderType`
  coercion and belongs on the registry (A12) or as a standalone.

---

## §10. LoggerLike integration points

### Finding: **zero.**

```
grep -n "logger" src/channel-provider.ts
5:import { logger } from './logger.js'
```

One hit, and it is the import statement. There is **no** `logger.info(`,
`logger.warn(`, `logger.error(`, or `logger.debug(` anywhere in the file's
552 lines. The import at line 5 is **dead code** -- present, unused,
pre-existing.

### Consequences for the H migration

| Question | Answer |
|---|---|
| Does any provider method call logger? | **No.** All five providers signal failure by `throw new Error(...)` (`:43`, `:85`, `:157`, `:161`, `:180`, `:203`, `:262`, `:290`, `:335`, `:339`, `:376`, `:380`) or by returning `{ ok: false, error }` (`:96`, `:98`, `:220`, `:222`, `:303`, `:305`). |
| Would a provider class need a `log: LoggerLike` field? | **No.** Adding one would be a field with zero readers -- the OE-6 pattern in the dependency-injection register. |
| Would `ChannelEnv` need one? | **No.** Its three failure paths (`:534`, `:539`, `:550`) all return `null` silently by design; the callers log. |
| Does D block on H.1? | **No.** D is the only subsystem in the plan that is fully **decoupled** from the `LoggerLike` decision -- it can convert before, after, or in parallel with H.1. |

This corrects the framing in `h-cross-cutting/04-generic-interfaces.md:15-17`
("Give every class in Parts A, B, C, **D** and E a constructor-parameter type
for a logger"): D needs no such parameter. The H design (the two-form
`LogFn` overload set at `04-generic-interfaces.md:59-69`, and HR4's
correction of the string-first count from 76 to 73 at
`h-cross-cutting/review-correctness.md:156-169`) is sound but has **no D-side
consumer**.

### Recommended handling of the dead import

Removing `import { logger } from './logger.js'` at `:5` is a one-line
deletion with no behavioural effect. Per CLAUDE.md §3 ("If you notice
unrelated dead code, mention it -- don't delete it"), it is **flagged here,
not removed**. If the class conversion rewrites the import block anyway, the
line becomes an orphan created by that change and may then be dropped under
the same rule's second clause.

---

## Verifiability

Every claim above was checked against the working tree on 2026-08-30
(branch `test/baseline`, HEAD `f58fe4c`):

- `src/channel-provider.ts` read in full (552 lines).
- `grep -nE ' as | as any|: any|as unknown as|as const|interface |^type |export type' src/channel-provider.ts` -- basis for §1, §2, §7.
- `grep -n "logger" src/channel-provider.ts` -- single hit at `:5`, basis for §10.
- `grep -rn "SendOpts\|SendResult\|ValidateTokenResult" src/ docs/` -- basis for §4.
- `grep -rn "getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken\|getProviderType\|getProvider(" src/ --include='*.ts' | grep -v __tests__` -- basis for the call-site tables in §5.
- `grep -rn "chatIdFormat\|envKeys\|\.stateDir\b" src/ --include='*.ts'` -- basis for the "zero production consumers" rows in §1.
- `src/format.ts:3, 50` (`formatForTelegram`, `splitMessage(text, limit = MAX_MESSAGE_LENGTH)`), `src/test-run-marker.ts:24-27` (`markIfTestRun`), `src/env.ts:13` (`readEnvFile`), `src/config.ts:17, 324-326` -- read directly.
- `review-correctness.md:28-67` (C1), `:68-92` (C2), `03-class-boundaries.md:330-370` (A13, A14), `h-cross-cutting/04-generic-interfaces.md:11-70` (§L), `h-cross-cutting/review-correctness.md:155-169` (HR4), `e-process-lock/02-type-interface-analysis.md:303-318, 502-517` (OE-6) -- read directly.
