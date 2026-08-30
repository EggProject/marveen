# D (channel-provider) — Generic interfaces

Generic opportunities considered for the D subsystem. Two candidates
considered; both rejected on OE-6 grounds (generic with a single
consumer, no second caller that would benefit). One targeted
non-generic consolidation documented instead.

---

## §1. `Provider<TConfig>` abstract base class — rejected

### Sketch that was considered

```ts
abstract class Provider<TConfig extends { maxLength?: number } = {}> {
  abstract readonly type: ChannelProviderType
  abstract readonly pluginId: string
  // ...
  protected readonly config: TConfig
  constructor(config: TConfig) { this.config = config }
  abstract formatMessage(text: string): string
  abstract splitMessage(text: string): string[]
}
```

### Why rejected

`02-type-interface-analysis.md` §8 works through what `TConfig` would be:

| Provider | `TConfig` would be |
|---|---|
| telegram | `{}` |
| slack | `{ maxLength: 4000 }` |
| discord | `{ maxLength: 2000 }` |
| googlechat | `{ maxLength: 4096 }` |
| teams | `{ maxLength: 28000 }` |

`TConfig` collapses to a single optional `number`. A type parameter whose
only inhabitant is `{ maxLength?: number }` is a parameter with **one
consumer and no second caller** — the exact pattern `review-completeness.md`
**OE-6** rejects, applied in `e-process-lock/02-type-interface-analysis.md:303-305`
to kill `LockContext<T>` and again at `:504-506` to kill
`DeferToPeerError<TPid = number>`. The same verdict applies here, for the
same reason and with the same evidence shape:

1. **No call site would benefit.** `telegramProvider` has no `maxLength`
   field at all; the other four have one. A `TConfig` parameter cannot
   express "the config is optional, and the absent case differs from
   the present case" — that's a tagged union, not a generic.
2. **Variance would be forced to invariant.** `TConfig` appears in
   constructor parameter position (contravariant) and in `splitMessage`'s
   `config.maxLength` read (covariant). Per `review-correctness.md` R5
   ("default invariance + no `as` at the boundary"), it ends up
   invariant.
3. **The three real transports share zero method bodies.** Telegram's
   `sendMessage` is `node:https` raw (`telegramHttpPost:27`); slack's is
   `fetch`; discord's is `fetch` with a `data.ok` re-check; googlechat's
   and teams' throw. A shared base could host no implementation, only
   `abstract` members — i.e. the interface we already have.
4. **The one real dedup is in a separate axis.** googlechat + teams are
   near-identical (5 literal strings differ), and that's the only place
   a base class would share code. That base — `UnsupportedDirectSendProvider`
   at `03-class-boundaries.md` D2 — does NOT need a generic because the
   two subclasses carry their per-type data in plain `readonly` fields
   (`displayName: string`, `maxLength: number`), not in a `TConfig`
   parameter.

### Citation for the precedent

- `review-completeness.md` **OE-6** (Over-engineering findings): "Single
  consumer, no second caller".
- `e-process-lock/02-type-interface-analysis.md:303-318` — `LockContext<T>`
  rejected because port and path are passed per-call, not as instance
  state.
- `e-process-lock/02-type-interface-analysis.md:502-517` — `DeferToPeerError<TPid>`
  rejected because no caller needs a non-`number` PID type.

Same reasoning, same verdict. **Drop.**

---

## §2. `ChannelEnv<TEnv = Record<string, string>>` — rejected

### Sketch that was considered

```ts
class ChannelEnv<TEnv extends Record<string, string> = Record<string, string>> {
  constructor(env: TEnv, home: string = homedir())
  getToken(provider: ChannelProviderType): string
  getChatId(provider: ChannelProviderType): string
  // ...
}
```

The motivating use case: a test (or hypothetical new caller) wants to
pass an env record whose keys are typed narrowly (e.g., `TELEGRAM_BOT_TOKEN`
required, others optional) so the compiler catches typos and missing
keys.

### Why rejected

Same OE-6 test, same verdict:

1. **One production caller.** `config.ts:325-326` is the only consumer
   today (`01 §8`). It passes `env = readEnvFile()` (`src/env.ts:13`),
   which returns `Record<string, string>`. There is no call site that
   would benefit from `TEnv` being narrower.
2. **Tests use the same shape.** Test files (e.g.,
   `src/__tests__/config.test.ts` if it exists; `01 §7` lists
   `vi.mock('../config.js', …)` mocks that override individual keys).
   Tests today use `Record<string, string>` because that's what
   `readEnvFile` and `process.env` both return. A narrower `TEnv` would
   require test fixtures to declare `TEnv` explicitly, and the narrowness
   provides no compile-time value when the test fixture is itself the
   ground truth.
3. **Variance forced to invariant.** `TEnv` appears in the constructor
   (contravariant) and in `getToken`'s `env[TABLE[provider].tokenKey]`
   read (covariant). Invariant — per `review-correctness.md` R5.
4. **No reusable shape exists.** The keys touched by the two methods are
   listed in `03-class-boundaries.md` D1's `TABLE` (`tokenKey` and
   `chatIdKey` per provider type). A "narrower" `TEnv` would be:
   ```ts
   type ChannelEnvRecord = Partial<{
     TELEGRAM_BOT_TOKEN: string
     ALLOWED_CHAT_ID: string
     SLACK_BOT_TOKEN: string
     SLACK_CHANNEL_ID: string
     DISCORD_BOT_TOKEN: string
     DISCORD_CHANNEL_ID: string
     GOOGLECHAT_PROJECT_ID: string
     GOOGLECHAT_SPACE_ID: string
     TEAMS_BOT_APP_ID: string
     TEAMS_ALLOWED_CONVERSATION_ID: string
   }>
   ```
   This is `Partial<...>`, which is the same as
   `Record<string, string | undefined>` at the read site
   (`env[TABLE[provider].tokenKey]` would be `string | undefined` even
   on a narrower `TEnv`). Adding the parameter does not improve
   type-safety — the `?? ''` fallback is required regardless.
5. **Cost is concrete, benefit is speculative.** Each new class instance
   at boot would carry a `TEnv` parameter; tests that build fake envs
   today already use `Record<string, string>`. Per `review-completeness.md`
   OE-6: "Single consumer, no second caller" → drop.

### Citation for the precedent

- `e-process-lock/02-type-interface-analysis.md:303-318` — `LockContext<T>`
  similarly rejected because port/path are per-call arguments, not
  config-bound.
- `h-cross-cutting/04-generic-interfaces.md` §L — `LoggerLike<L extends LogRecord>`
  rejected for the same "no second consumer" reason.

### What we keep instead

Plain `class ChannelEnv` with concrete `env: Record<string, string>`.
The 5-key dispatch table lives as `static readonly TABLE`. **Non-generic.**

---

## §3. Justified consolidation: dispatch table + named return type

These are NOT generics — they are *non-generic* shape improvements that
the type analysis surfaced. They live in `ChannelEnv` and the
`ChannelProvider` interface respectively, and they have measurable
benefit (dedup, exhaustiveness, named return shape).

### (a) Single dispatch table — `ChannelEnv.TABLE`

Documented in `03-class-boundaries.md` D1. Collapses four 5-branch
dispatch chains in the file (`getChannelToken:460-464`,
`getChannelChatId:468-472`, `channelStateDir:525-529`,
`readChannelToken:543-548`) into one `Record<ChannelProviderType, …>`.
**Non-generic, a plain mapped constant.**

Justified:

- (a) **Two of the four chains have byte-identical key sets.**
  `getChannelToken:460-464` and `readChannelToken:543-548` produce the
  same 5 strings in the same order. Consolidating them removes ~6
  duplicated lines and ensures they cannot drift apart.
- (b) **`channelStateDir`'s subdir chain (`:525-529`) duplicates the
  providers' `readonly stateDir` fields (`:58/139/248/329/369`).** The
  five subdir strings (`'telegram'`, `'slack'`, `'discord'`,
  `'googlechat'`, `'teams'`) are computed in two places. Consolidating
  them removes ~5 duplicated lines.
- (c) **The fallthrough `return env['TELEGRAM_BOT_TOKEN']` at `:464`
  does not enforce exhaustiveness.** A sixth provider added later would
  silently return the telegram key. The `Record<ChannelProviderType, …>`
  index access would fail at compile time.

### (b) Named `ValidateTokenResult` interface — `src/channel-provider.ts`

Documented in `02-type-interface-analysis.md` §4 and the only new type
D adds. The literal `{ ok: boolean; botName?: string; error?: string }`
appears once in the interface (`:20`) and is re-inferred at each of the
5 implementations. Two production consumers destructure it
(`web/routes/agents.ts:968`, `:1046`, `:1435`).

```ts
export interface ValidateTokenResult {
  readonly ok: boolean
  readonly botName?: string
  readonly error?: string
}
```

Justified:

- (a) The shape appears 5 times (once in interface + 4 implementations;
  the 5th, slack's `:218`, returns the same shape inline). One name
  eliminates 5 anonymous re-appearances.
- (b) Two production destructuring sites (`web/routes/agents.ts`) gain
  explicit type-checking when they import the interface.
- (c) **Non-generic, non-discriminated.** The brief temptation to turn
  this into `{ ok: true; botName } | { ok: false; error }` is rejected:
  `slackProvider:218` returns `{ ok: true, botName: data.user ||
  data.bot_id }` where `botName` can be `undefined` (both `data.user`
  and `data.bot_id` are themselves optional in the API response), and
  googlechat/teams return `{ ok: true }` with no `error`. A
  discriminated union would compile but silently change what callers
  may assume. The shape stays exactly as today.

### (c) The `UnsupportedDirectSendProvider` base — non-generic

Documented in `03-class-boundaries.md` D2. Two subclasses
(`GooglechatProvider`, `TeamsProvider`); no `TConfig` parameter needed
because the per-type data lives in plain `readonly` fields
(`displayName: string`, `maxLength: number`), not in a config record.

Justified:

- (a) **Two subclasses exist** (googlechat, teams). The OE-6 threshold
  for a base class is "two concrete subclasses share ≥80% of their body";
  googlechat + teams share 100% of their method bodies (`02 §8(a)`,
  cluster 2).
- (b) **The shared bodies are real implementations, not declarations.**
  The throw template (`<name>: direct dashboard send not supported
  (delivery via plugin MCP tools)`) interpolates `this.type`; the
  `formatMessage` identity forwards; `validateToken` returns
  `{ ok: true, botName: this.displayName }`. The base holds the
  implementations and reads subclass data via `protected readonly`.
- (c) **No `TConfig` parameter is needed** — see §1 above.

---

## §4. Considered and rejected (full table)

| Candidate | Source of the idea | Why rejected |
|---|---|---|
| `Provider<TConfig>` abstract base | brief sketch | Single consumer (maxLength), invariance, no shared body across the 3 real transports. Same OE-6 verdict. See §1. |
| `ChannelEnv<TEnv>` | brief sketch | One production caller (`config.ts:325-326`), invariance, narrower `TEnv` cannot help at the read site (always `?? ''`). Same OE-6 verdict. See §2. |
| `TestRunMarkingDecorator` as a class | brief alternate | The decorator has no lifecycle (`release()`, `close()`); class form adds field-storage overhead for one delegating method per interface member. Function form (Form B in `03 §D4`) is half the code and equal in correctness. |
| A discriminated union for `ValidateTokenResult` | temptation during refactor | Slack's `:218` returns `{ ok: true, botName: undefined | string }`; googlechat/teams return `{ ok: true }` with no `error`. Discriminated union would force consumers to handle cases that don't exist. Preserves `ok: boolean; botName?: string; error?: string` verbatim. |
| A `TokenResolver` interface for `getToken`/`getChatId` | speculative | `getToken(provider): string` is a one-method dispatch over a 5-row table. Extracting an interface adds ceremony for a single consumer (`ChannelEnv`). |
| A `StateDirResolver` interface for `getStateDir`/`readToken` | speculative | Same shape argument; only `ChannelEnv` is the consumer. |
| A `Provider<TConfig, TTransport>` two-parameter generic | speculative | Same OE-6 verdict + variance complication. |

---

## §5. Adopters (one-paragraph summary)

D introduces exactly one new type — `ValidateTokenResult` — and zero new
generics. The `ChannelEnv.TABLE` constant is internal to the class and
not exported. The five provider classes are parameterless (`new
TelegramProvider()`) with optional `log?: LoggerLike` per H.1 (D.6
gating).

Net new type surface: **+1 named interface, +0 generics**. Compared to
`e-process-lock/03-class-boundaries.md` (which adds `ProcessLockContext`,
`PidfileLockContext`, etc., no generics either), D is the smallest
type-surface expansion of any subsystem in the plan.
