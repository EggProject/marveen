# D (channel-provider) — Module state analysis

Planning only — no source files were modified. Verified against
`src/channel-provider.ts` (552 lines, measured 2026-08-30) and the rest of
`src/` on the same date.

---

## Summary

The D subsystem is the five-implementation plugin pattern that backs every
channel send path in the application: one `ChannelProvider` interface,
five provider objects (`telegram`, `slack`, `discord`, `googlechat`,
`teams`) declared as frozen module-level `const` literals, plus a registry
plus a `withTestRunMarking` decorator that wraps every provider with the
`[TESZT]` prefix from `src/test-run-marker.ts`. State is split across three
places: (1) five provider literals holding nothing but readonly metadata
+ bound methods, (2) `markedProviders` (`channel-provider.ts:500`) — the
post-decorator table the runtime actually consumes via `getProvider`, and
(3) four top-level helpers (`getChannelToken` `channel-provider.ts:459`,
`getChannelChatId` `:467`, `channelStateDir` `:520`, `readChannelToken`
`:533`) that take `(provider, env)` or `(provider, envFilePath)` per call
and do not hold module-level state. There is **no** token-or-chatId
instance state on provider objects — every send carries token + chatId as
parameters, matching `review-correctness.md` C1's verdict. The class
refactor therefore converts five frozen objects into `class XxxProvider
implements ChannelProvider` whose method signatures are byte-identical
to today, plus one new `ChannelEnv` helper class that absorbs the four
top-level helpers. `withTestRunMarking` becomes a thin free function or
constructor parameter; `markedProviders` and `getProvider` survive as a
registry with the same shape.

---

## 1. channel-provider.ts inventory

### Current shape (top to bottom)

| Section | Line range | What's there |
|---|---|---|
| Imports | `:1-7` | `node:https`, `node:fs` (`readFileSync`, `existsSync`), `node:path` (`join`), `node:os` (`homedir`), `./logger.js`, `./format.js` (`formatForTelegram`, `splitMessage`), `./test-run-marker.js` (`markIfTestRun`) |
| `ChannelProviderType` alias | `:9` | `'telegram' \| 'slack' \| 'discord' \| 'googlechat' \| 'teams'` |
| `ChannelProvider` interface | `:11-23` | 6 readonly metadata fields + 5 methods (`sendMessage`, `sendPhoto`, `validateToken`, `formatMessage`, `splitMessage`) |
| Telegram impl + helper | `:25-104` | `telegramHttpPost` helper at `:27-51`, `telegramProvider` at `:53-104` |
| Slack impl + helpers | `:106-228` | `formatForSlackMrkdwn` at `:114-132`, `SLACK_MAX_MESSAGE_LENGTH` at `:112`, `slackProvider` at `:134-228` |
| Discord impl + helpers | `:230-311` | `formatForDiscord` at `:234-241`, `DISCORD_MAX_MESSAGE_LENGTH` at `:232`, `discordProvider` at `:243-311` |
| Google Chat impl | `:313-350` | `GOOGLECHAT_MAX_MESSAGE_LENGTH` at `:322`, `googlechatProvider` at `:324-350` |
| Teams impl | `:352-391` | `TEAMS_MAX_MESSAGE_LENGTH` at `:362`, `teamsProvider` at `:364-391` |
| Slack manifest helpers | `:393-455` | `SLACK_BOT_SCOPES` `:395-409`, `SLACK_BOT_EVENTS` `:411-416`, `generateSlackAppManifest` `:418-443`, `getSlackAppSetupInstructions` `:445-455` |
| Token resolution | `:457-473` | `getChannelToken` `:459`, `getChannelChatId` `:467` |
| Provider registry + decorator | `:475-518` | `providers` `:477-483`, `withTestRunMarking` `:490-498`, `markedProviders` `:500-506`, `getProvider` `:508-510`, `getProviderType` `:512-518` |
| State + env helpers | `:520-551` | `channelStateDir` `:520-531`, `readChannelToken` `:533-551` |

### Five provider instance locations

| Provider | Line | Identifier |
|---|---|---|
| Telegram | `:53` | `const telegramProvider: ChannelProvider` |
| Slack | `:134` | `const slackProvider: ChannelProvider` |
| Discord | `:243` | `const discordProvider: ChannelProvider` |
| Google Chat | `:324` | `const googlechatProvider: ChannelProvider` |
| Teams | `:364` | `const teamsProvider: ChannelProvider` |

### Registry + decorator locations

- `providers: Record<ChannelProviderType, ChannelProvider>` at `:477-483` — the **un-decorated** lookup table; nothing in `src/` reads from it (verified by `grep -rn '\bproviders\b' src/channel-provider.ts` and broader greps below).
- `withTestRunMarking(provider: ChannelProvider): ChannelProvider` at `:490-498` — wraps `sendMessage` + `sendPhoto` to inject `markIfTestRun(text)` / `markIfTestRun(caption)`. Spread-copies the rest of the provider (`...provider`), so `type`, `pluginId`, `envKeys`, `stateDir`, `chatIdFormat`, `formatMessage`, `splitMessage`, `validateToken` pass through.
- `markedProviders: Record<ChannelProviderType, ChannelProvider>` at `:500-506` — the **decorated** registry that `getProvider` returns from.
- `getProvider(type: ChannelProviderType): ChannelProvider` at `:508-510` — the single read path; returns `markedProviders[type]`.
- `getProviderType(envValue: string | undefined): ChannelProviderType` at `:512-518` — env-string → typed provider discriminator. Default branch falls through to `'telegram'`.

---

## 2. `ChannelProviderType` + `providers` object audit

```ts
// channel-provider.ts:9
export type ChannelProviderType = 'telegram' | 'slack' | 'discord' | 'googlechat' | 'teams'

// channel-provider.ts:477-483
const providers: Record<ChannelProviderType, ChannelProvider> = {
  telegram: telegramProvider,
  slack: slackProvider,
  discord: discordProvider,
  googlechat: googlechatProvider,
  teams: teamsProvider,
}
```

- `providers` is **never read** outside the module — `grep -rn "\bproviders\b" src/ --include='*.ts' | grep -v __tests__` finds only the literal declaration at `:477` and the decorator invocation that wraps each entry at `:501-505`. Verified per-file: no `import { providers }` exists anywhere in `src/`. It is dead — preserved (presumably) for symmetry with `markedProviders`, but unused at runtime.
- `getProviderType` (`:512`) reads `process.env` indirectly via the caller (`config.ts:325-326` passes `CHANNEL_PROVIDER` derived from `env`). It is a pure 1:1 mapping; safe to lift into `ChannelProviderType` static helpers or keep as a free function.
- The five provider keys in `providers` and `markedProviders` are exhaustive against the union — adding a sixth provider would force a compile error (verified by `Record<ChannelProviderType, …>`).

---

## 3. `withTestRunMarking` decorator analysis

### Signature (`channel-provider.ts:490-498`)

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

### What it wraps

- The original provider is spread (`...provider`), so all six readonly metadata fields and three of the five methods (`validateToken`, `formatMessage`, `splitMessage`) come through unchanged.
- `sendMessage` and `sendPhoto` are **re-bound** to forward through `markIfTestRun` on the message text / caption before the wrapped call. The function signature shape is preserved (same `(token, chatId, text/caption, parseMode?)` argument shape), so callers cannot tell whether they're holding a wrapped or unwrapped provider.
- `validateToken` is **not** wrapped. Token validation is a network probe and does not need the test marker. (Confirmed: the marker is for the *outbound message* body, never for the token-validation response.)

### What state it adds

**None.** The decorator is a pure transform — it produces a new object on every call. The state it relies on lives in `markIfTestRun` (`src/test-run-marker.ts`), which reads `process.env['VITEST']` and `process.env['NODE_ENV']` at the time of each call (not at module init). The decorator does **not** snapshot `isTestRun()` at module load, so a test that mutates `process.env` after import time still gets the right behaviour. The `markedProviders` table is built once at module init (`:501-505`), but the marking decision is per-call.

### `markedProviders` shape (`channel-provider.ts:500-506`)

```ts
const markedProviders: Record<ChannelProviderType, ChannelProvider> = {
  telegram: withTestRunMarking(telegramProvider),
  slack: withTestRunMarking(slackProvider),
  discord: withTestRunMarking(discordProvider),
  googlechat: withTestRunMarking(googlechatProvider),
  teams: withTestRunMarking(teamsProvider),
}
```

- Same `Record<ChannelProviderType, ChannelProvider>` shape as `providers`. The whole point is that `getProvider(type)` returns from this table, never the un-decorated one.
- Google Chat and Teams are also wrapped, even though their `sendMessage`/`sendPhoto` throw (`channel-provider.ts:335` / `:339` / `:376` / `:380`). Wrapping still works because the wrapper is a thin forwarder — the wrapped method is never reached.

---

## 4. Top-level helpers audit (4)

### 4.1 `getChannelToken` — `channel-provider.ts:459-465`

```ts
export function getChannelToken(provider: ChannelProviderType, env: Record<string, string>): string {
  if (provider === 'slack') return env['SLACK_BOT_TOKEN'] ?? ''
  if (provider === 'discord') return env['DISCORD_BOT_TOKEN'] ?? ''
  if (provider === 'googlechat') return env['GOOGLECHAT_PROJECT_ID'] ?? ''
  if (provider === 'teams') return env['TEAMS_BOT_APP_ID'] ?? ''
  return env['TELEGRAM_BOT_TOKEN'] ?? ''
}
```

- Reads `process.env` only **indirectly**: the function takes `env` as a parameter. The only production caller is `config.ts:325` which passes `env` from `buildEnv()`.
- Pure function — no I/O. Maps provider type to one of five env keys (slack, discord, googlechat, teams, telegram default branch).
- Per-type env keys: `SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `GOOGLECHAT_PROJECT_ID`, `TEAMS_BOT_APP_ID`, `TELEGRAM_BOT_TOKEN`.
- Returns empty string on missing key (note: not `undefined`).

### 4.2 `getChannelChatId` — `channel-provider.ts:467-473`

```ts
export function getChannelChatId(provider: ChannelProviderType, env: Record<string, string>): string {
  if (provider === 'slack') return env['SLACK_CHANNEL_ID'] ?? ''
  if (provider === 'discord') return env['DISCORD_CHANNEL_ID'] ?? ''
  if (provider === 'googlechat') return env['GOOGLECHAT_SPACE_ID'] ?? ''
  if (provider === 'teams') return env['TEAMS_ALLOWED_CONVERSATION_ID'] ?? ''
  return env['ALLOWED_CHAT_ID'] ?? ''
}
```

- Same shape as `getChannelToken`. Per-type env keys: `SLACK_CHANNEL_ID`, `DISCORD_CHANNEL_ID`, `GOOGLECHAT_SPACE_ID`, `TEAMS_ALLOWED_CONVERSATION_ID`, `ALLOWED_CHAT_ID` (telegram default).
- Pure function. One production caller (`config.ts:326`).

### 4.3 `channelStateDir` — `channel-provider.ts:520-531`

```ts
export function channelStateDir(provider: ChannelProviderType, agentDir?: string): string {
  const base = agentDir
    ? join(agentDir, '.claude', 'channels')
    : join(homedir(), '.claude', 'channels')
  const subdir =
    provider === 'slack' ? 'slack'
    : provider === 'discord' ? 'discord'
    : provider === 'googlechat' ? 'googlechat'
    : provider === 'teams' ? 'teams'
    : 'telegram'
  return join(base, subdir)
}
```

- No `env` parameter. Reads `homedir()` (from `node:os`) **per call** — there is no module-level caching of the home directory, so HMR or env-mutating tests that change `HOME` / `USERPROFILE` get fresh values.
- Two-step join: base is either `<agentDir>/.claude/channels` or `~/.claude/channels`; subdir is one of five literal strings.
- 14 production call sites (see §7 below). The provider-type-to-subdir string mapping is duplicated against the same mapping baked into the five provider literals' `stateDir` field (`channel-provider.ts:58/139/248/329/369`).
- Pure function (no I/O beyond `homedir()`).

### 4.4 `readChannelToken` — `channel-provider.ts:533-551`

```ts
export function readChannelToken(provider: ChannelProviderType, envFilePath: string): string | null {
  if (!existsSync(envFilePath)) return null
  let content: string
  try {
    content = readFileSync(envFilePath, 'utf-8')
  } catch {
    return null
  }
  const key =
    provider === 'slack' ? 'SLACK_BOT_TOKEN'
    : provider === 'discord' ? 'DISCORD_BOT_TOKEN'
    : provider === 'googlechat' ? 'GOOGLECHAT_PROJECT_ID'
    : provider === 'teams' ? 'TEAMS_BOT_APP_ID'
    : 'TELEGRAM_BOT_TOKEN'
  const match = content.match(new RegExp(`${key}=(.+)`))
  return match ? match[1].trim() : null
}
```

- Reads the file at `envFilePath` synchronously (`readFileSync` from `node:fs`). The file is a per-channel `.env` file (the comment at `:319-320` and `:359-360` calls out that for Google Chat and Teams the "token" key actually stands in for a project-id / app-id presence check).
- 7 production call sites (see §7 below).
- Per-type key strings: `SLACK_BOT_TOKEN`, `DISCORD_BOT_TOKEN`, `GOOGLECHAT_PROJECT_ID`, `TEAMS_BOT_APP_ID`, `TELEGRAM_BOT_TOKEN` — **identical** to the keys used by `getChannelToken` (`:459-465`). This duplication is a known shape-level redundancy: both functions enumerate the same five-key mapping.
- Returns `null` on missing file, read error, or absent key.

---

## 5. Module-level state

`grep -n "^let \|^const " /Users/eggp/marveen-develop/test-baseline/src/channel-provider.ts` returns:

| Line | Binding | Mutable? | Notes |
|---|---|---|---|
| `:53` | `telegramProvider` | const (frozen literal) | readonly object literal |
| `:112` | `SLACK_MAX_MESSAGE_LENGTH` | const | number |
| `:134` | `slackProvider` | const (frozen literal) | readonly object literal |
| `:232` | `DISCORD_MAX_MESSAGE_LENGTH` | const | number |
| `:243` | `discordProvider` | const (frozen literal) | readonly object literal |
| `:322` | `GOOGLECHAT_MAX_MESSAGE_LENGTH` | const | number |
| `:324` | `googlechatProvider` | const (frozen literal) | readonly object literal |
| `:362` | `TEAMS_MAX_MESSAGE_LENGTH` | const | number |
| `:364` | `teamsProvider` | const (frozen literal) | readonly object literal |
| `:395` | `SLACK_BOT_SCOPES` | const | string array |
| `:411` | `SLACK_BOT_EVENTS` | const | string array |
| `:477` | `providers` | const | `Record<…>` of the 5 unwrapped providers (dead) |
| `:500` | `markedProviders` | const | `Record<…>` of the 5 wrapped providers (live) |

**Zero `let` bindings.** No module-level mutable state. No env cache. The two `Record`s are computed once at module init and never reassigned. The five provider literals are also computed once and the closures they hold (`async sendMessage`, etc.) close over nothing — they receive everything as parameters.

### Provider lookup tables

- `providers` (`:477`) — dead (see §2).
- `markedProviders` (`:500`) — the only live lookup. Five entries, keyed exhaustively against the `ChannelProviderType` union.

### Env caches

None. `getChannelToken` and `getChannelChatId` take `env` per call; `channelStateDir` calls `homedir()` per call; `readChannelToken` does file I/O per call. None of the four helpers memoize anything.

---

## 6. Re-init hazards (HMR scenario)

If `channel-provider.ts` is imported twice (HMR or duplicate-import), each evaluation:

1. Re-creates the five `const provider` object literals (five new closures per import).
2. Re-creates the four `SLACK_MAX_MESSAGE_LENGTH` / `DISCORD_MAX_MESSAGE_LENGTH` / `GOOGLECHAT_MAX_MESSAGE_LENGTH` / `TEAMS_MAX_MESSAGE_LENGTH` numbers.
3. Re-creates `SLACK_BOT_SCOPES` / `SLACK_BOT_EVENTS`.
4. Re-creates the `providers` and `markedProviders` `Record`s.
5. Re-imports `markIfTestRun` (which has its own `TEST_RUN_PREFIX` const + `isTestRun` function).

**Consequence.** Callers that hold a reference to the **first** module's `markedProviders[type]` see the first module's wrappers; callers holding the **second** module's reference see the second. Both work in isolation, but the wrappers are NOT `===` across imports. Test isolation depends on `vi.mock` + `vi.resetModules` resetting the binding, which the existing suite already relies on (see `test-run-marker.test.ts:33-34` and `test-run-marker.test.ts:102` / `:114` calling `vi.importActual`). The class refactor preserves this property — `new TelegramProvider(env)` is cheap and idempotent — but the `markedProviders` table must be constructed inside the class file at module scope OR rebuilt per-test if the test wants fresh wrappers.

**One real hazard:** `markedProviders` is currently constructed at module init (`channel-provider.ts:501-505`). If a test mutates `process.env.VITEST` *after* import but before the test calls `getProvider('telegram').sendMessage(...)`, the wrapping is already done — but `markIfTestRun` reads `VITEST` per call (`test-run-marker.ts:21`), so the behaviour is still correct. The class refactor must preserve this per-call `isTestRun()` check.

**Filesystem re-read hazard:** none. `channelStateDir` calls `homedir()` per call (`:522` / `:523`); `readChannelToken` re-reads the file per call. No path is cached at module init.

**No env mutation hazard:** `getChannelToken` / `getChannelChatId` take `env` as a parameter, so changing `process.env` between calls has no effect on these helpers' behaviour — callers must pass a fresh `env` if they want fresh values (only `config.ts:325-326` does this today).

---

## 7. Test mock patterns

`grep -rh "vi.mock('../channel-provider.js'" src/__tests__/ | sort | uniq -c | sort -rn`:

| Mock shape | Count | Files |
|---|---:|---|
| `vi.mock('../channel-provider.js', () => ({ … }))` — full module replacement, inline object literal | **9** | `channel-mcp-reconnect.test.ts:44`, `agent-scaffold-baseline.test.ts:68`, `channel-request-watcher.test.ts:87`, `channel-health-monitor.test.ts:64`, `agent-scaffold-full.test.ts:65`, `channel-mcp-reconnect-full.test.ts:63`, `discord-group-bootstrap.test.ts:61`, `agent-process.test.ts:200`, `agent-scaffold-scheduled-tasks-catch.test.ts:46` |
| `vi.mock('../channel-provider.js', async (orig) => { … })` — async factory, spreads `await orig()`, overrides one or more names | **4** | `channel-monitor-coverage.test.ts:254`, `channel-monitor-baseline.test.ts:233`, `channel-monitor.test.ts:270`, `schedule-runner-full.test.ts:269` |
| `vi.mock('../channel-provider.js', async (importOriginal) => { … })` — same shape, named-param alias | **3** | `onboarding-routes.test.ts:74`, `test-run-marker.test.ts:33`, `agents-routes.test.ts:427` |
| `vi.mock('../channel-provider.js', () => ({ getProvider }))` — single-export stub | **1** | `notify.test.ts:25` |

**Total:** 17 files mock `channel-provider.js`. All use `'../channel-provider.js'` (relative from `src/__tests__/`); zero use the absolute-from-`SRC_DIR` shape (`vi.doMock(join(SRC_DIR, '..', 'channel-provider.js'), …)`) — except `channel-coordinator-liveness.test.ts:99`, which uses `vi.doMock` (not `vi.mock`) and only stubs `channelStateDir`. The full enumeration of mock patterns is consistent across the suite: 9 full-replacement mocks, 7 partial mocks (4 + 3, both `async orig`/`async importOriginal` shapes), and 1 single-export stub.

**Coverage concern.** None of the 17 mocks stub `withTestRunMarking` (correct — it's not exported). None stub `markedProviders` directly; they either mock `getProvider` (the only public read path) or mock `channelStateDir` / `readChannelToken` in isolation. The refactor must preserve `getProvider` as a top-level named export and the per-type signature `ChannelProviderType -> ChannelProvider`, or all 17 mocks break.

---

## 8. Integration consumers

`grep -rn "from ['\"]\.\./channel-provider\.js['\"]\|from ['\"]\.\./\.\./channel-provider\.js['\"]\|from ['\"]\./channel-provider\.js['\"]" src/ | grep -v __tests__ | grep -v "^src/channel-provider.ts"`:

### Top-level src/ (4 files)

| File:line | Imports |
|---|---|
| `src/notify.ts:2` | `getProvider` |
| `src/config.ts:8` | `getProviderType`, `getChannelToken`, `getChannelChatId`, `type ChannelProviderType` |
| `src/channel-coordinator/liveness.ts:16` | `channelStateDir`, `type ChannelProviderType` |
| `src/channel-coordinator/provider-poller-match.ts:16` | `type ChannelProviderType` (type-only) |

### src/web/ (14 files)

| File:line | Imports |
|---|---|
| `src/web/agent-process.ts:40` | `getProvider`, `getProviderType`, `channelStateDir`, `readChannelToken`, `type ChannelProviderType` |
| `src/web/channel-mcp-reconnect.ts:8` | `getProvider`, `type ChannelProviderType` |
| `src/web/channel-request-watcher.ts:5` | `channelStateDir`, `readChannelToken`, `type ChannelProviderType` |
| `src/web/discord-group-bootstrap.ts:24` | `channelStateDir` |
| `src/web/schedule-runner.ts:37` | `channelStateDir` |
| `src/web/channel-health-monitor.ts:11` | `getProvider` |
| `src/web/channel-poller-reap.ts:28-29` | `type ChannelProviderType` + `channelStateDir` |
| `src/web/channel-plugin-unlock.ts:38` | `type ChannelProviderType` (type-only) |
| `src/web/agent-scaffold.ts:5` | `channelStateDir` |
| `src/web/channel-invites.ts:30` | `channelStateDir`, `type ChannelProviderType` |
| `src/web/channel-monitor.ts:44` | `getProvider`, `channelStateDir`, `readChannelToken`, `type ChannelProviderType` |
| `src/web/telegram.ts` | (comment-only references at `:30` and `:40` to `readChannelToken`) |
| `src/web/routes/agents.ts:79-85` | `getProvider`, `channelStateDir`, `readChannelToken` |
| `src/web/routes/onboarding.ts:9` | `channelStateDir`, `readChannelToken` |

### scripts/ (1 file, comment-only)

| File | Notes |
|---|---|
| `scripts/channels.sh:64` | Comment references `pluginPaneId` in `src/channel-provider.ts` |
| `scripts/channels.sh:742` | Comment references `channelStateDir()` |
| `scripts/__tests__/channels-mcp-unlock.test.sh:91` | Comment says "Keep in sync with pluginPaneId in src/channel-provider.ts" |

The shell-script comments do not import anything; they are doc-anchors that have to stay accurate. No `bin/` importers exist (`grep -rn "channel-provider" bin/` returns nothing).

### Total importers: 18 production files (4 top-level + 14 web/) + 3 comment references in shell scripts. `bin/` and `scripts/*.ts` have no importers.

---

## 9. ChannelEnv migration map

### Which of the 4 helpers move into `ChannelEnv`

| Helper | Moves into `ChannelEnv`? | Rationale |
|---|---|---|
| `getChannelToken` (`:459`) | **Yes** | Pure env→string per provider type. `ChannelEnv` is constructed once from `process.env` and exposes `env.tokenFor(type)` (or similar). Eliminates the per-call `env` parameter at `config.ts:325`. |
| `getChannelChatId` (`:467`) | **Yes** | Same shape as `getChannelToken`. Exposes `env.chatIdFor(type)`. Same consumer (`config.ts:326`). |
| `channelStateDir` (`:520`) | **No** (stays free function) | Does not read `env`; reads `homedir()` + the per-type subdir. A `ChannelEnv` instance adds nothing here. Keep as a free function, or attach as a static helper on `ChannelEnv` (`ChannelEnv.stateDirFor(type, agentDir?)`). |
| `readChannelToken` (`:533`) | **Yes** (with caveat) | Reads a per-channel `.env` file (a different file from `process.env`). `ChannelEnv` does **not** know about that file, so `readChannelToken` cannot become an instance method on a process-env-derived `ChannelEnv`. Two viable shapes: (a) keep `readChannelToken` free, (b) introduce a sibling `ChannelDotEnv` class constructed from an env-file path. |

### `ChannelEnv` shape (proposal — for the next-doc discussion, not this one)

```ts
class ChannelEnv {
  constructor(env: Record<string, string>)        // process.env-derived
  tokenFor(provider: ChannelProviderType): string  // was getChannelToken
  chatIdFor(provider: ChannelProviderType): string // was getChannelChatId
}
```

- One instance is built at app boot (`src/index.ts` or wherever `process.env` first touches `channel-provider`), passed into anything that today calls `getChannelToken` / `getChannelChatId`.
- `config.ts:325-326` collapses from `getChannelToken(CHANNEL_PROVIDER, env)` to `channelEnv.tokenFor(CHANNEL_PROVIDER)`.
- `channelStateDir` stays as a free function — `ChannelEnv` does not own filesystem state. Optionally becomes a `static` on `ChannelEnv` for namespace symmetry.
- `readChannelToken` stays as a free function — the per-channel `.env` is **not** `process.env`. If a class is desired for testability, it belongs to a separate `ChannelDotEnv` family (a separate refactor, out of scope here).

### What stays untouched

- `getProvider` (`:508`) — top-level function returning a `ChannelProvider`. Becomes the constructor of a `ChannelProviderRegistry` class (a 1-method wrapper), or stays a function. The 18 importer files (see §8) call `getProvider(type)` and pass the result through unchanged.
- `getProviderType` (`:512`) — pure string→type mapping; stays free function.
- The five provider classes — `sendMessage(token, chatId, text, parseMode?)` / `sendPhoto(token, chatId, photoPath, caption)` / `validateToken(token)` / `formatMessage(text)` / `splitMessage(text)` keep their exact parameter signatures, per `review-correctness.md` C1.
- `generateSlackAppManifest` (`:418`) and `getSlackAppSetupInstructions` (`:445`) — pure functions, stay free.
- `formatForSlackMrkdwn` (`:114`) — exported helper, stays free. `src/__tests__/format.test.ts:3` imports it directly.

---

## 10. Brief on state and migration shape

`channel-provider.ts` carries **zero** module-level mutable state. Every behaviour is a function call over the (immutable) provider literal + per-call parameters. The class refactor therefore preserves the public API exactly: five `class XxxProvider implements ChannelProvider` (one per provider type), each constructor takes `log: LoggerLike` (per H.1) and an optional env / config bundle, each method takes the same `(token, chatId, …)` it takes today. The 4 top-level helpers split into two groups: `getChannelToken` + `getChannelChatId` move into `ChannelEnv` (env-derived instance); `channelStateDir` stays free (filesystem-only, no env dependency); `readChannelToken` stays free (per-channel `.env` is a different file from `process.env`). The `withTestRunMarking` decorator survives either as a free function wrapping the class instance or as an opt-in flag passed to the class constructor. The `markedProviders` `Record` becomes `ChannelProviderRegistry.marked()` or stays as a module-level `const` produced by an internal `wrap` helper. `getProvider(type)` keeps its `(ChannelProviderType) -> ChannelProvider` signature so all 18 importers and 17 test mocks continue resolving.
