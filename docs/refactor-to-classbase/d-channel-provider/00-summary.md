# D (channel-provider) — Executive summary

Synthesis of `01-module-state-analysis.md` (module/state lens) and
`02-type-interface-analysis.md` (types/interfaces lens), cross-checked
against `src/channel-provider.ts` (622 lines, read in full on 2026-08-30
pre-D.1, re-measured post-D.1 on 2026-09-04) and the rest of `src/` on
the same date. Originally **planning only**; the planning thesis
below became the implementation roadmap and D.1 (this commit)
shipped the `ChannelEnv` extraction plus the full consumer migration
(D.5 helper removal was merged into D.1; no legacy wrappers remain).

**Status (2026-09-04):**

- **D.1 `ChannelEnv` class extraction + full migration — LANDED** (this
  commit). 42 production call sites migrated across 12 files; 7 mock
  factories updated; 4 legacy free functions (`getChannelToken`,
  `getChannelChatId`, `channelStateDir`, `readChannelToken`) deleted.
- **D.2 5 provider classes + `UnsupportedDirectSendProvider` base —
  LANDED** (preceding refactor). Provider literals are now
  `new TelegramProvider()` etc. (line numbers shifted post-D.2;
  re-measured for this doc update).
- **D.3 `ChannelProviderRegistry` class + D.4 `withTestRunMarking`
  Form B explicit-delegation function — LANDED**. The free-function
  shape for the decorator survives per `03-class-boundaries.md` §D4
  Form B rationale.
- **D.5 REMOVED** — merged into D.1 (the helper removal was a
  precondition for the clean class surface, so the consumer migration
  and the helper deletion shipped together).
- **D.6 LoggerLike adoption — DEFERRED**. No D method calls the logger
  today; D.6 only runs if H.1 forces the constructor-parameter shape.

---

## Thesis

The D subsystem is the five-implementation plugin pattern that backs every
channel send path: one `ChannelProvider` interface
(`src/channel-provider.ts:11`), five provider class instances
(`telegramProvider:360`, `slackProvider:390`, `discordProvider:405`,
`googlechatProvider:418`, `teamsProvider:432` — each `new XxxProvider()`
constructed at module init), a registry (`markedProviders:600`,
`getProvider:608`) plus a `withTestRunMarking:586` decorator, and one
`ChannelEnv` class (`channel-provider.ts:507`) consolidating token /
chatId / state-dir / per-channel-env-file lookup behind a single
dispatch table (`ChannelEnv.TABLE`). The four legacy free helpers
(`getChannelToken:459`, `getChannelChatId:467`, `channelStateDir:520`,
`readChannelToken:533`) were **deleted in D.1**; their callers now use
`new ChannelEnv(env).getToken(provider)` / `.getChatId(provider)` and the
static `.stateDirFor(provider, agentDir?)` / `.readTokenFor(provider,
envFilePath)`. All five providers remain **stateless**: token and chatId
are per-call parameters, never instance state — this is the framework
`review-correctness.md` C1 verdict and the class extraction preserves
the `(token, chatId, …)` signature byte-for-byte. The refactor produced
one `ChannelEnv` class, five stateless `XxxProvider` classes with
argument-less constructors (no logger in scope per D.6 deferred), one
`ChannelProviderRegistry` class wrapping `markedProviders`, one
`UnsupportedDirectSendProvider` abstract base for the googlechat/teams
pair (the only place real dedup exists), and the Form B explicit-delegation
rewrite of `withTestRunMarking`. D has **zero logger call sites** today
(verified: `grep -n "logger" src/channel-provider.ts` returns the dead
import at `:5` only), so it is the cheapest consumer of the H migration
and does not block on H.1.

---

## Scope

### Files this plan TOUCHES (post-D.1 status)

| File | Why | Phase | Status |
|---|---|---|---|
| `src/channel-provider.ts` (622 lines) | extract `ChannelEnv` class, 5 `XxxProvider` classes, `ChannelProviderRegistry` class, `UnsupportedDirectSendProvider` base, dispatch table; convert `withTestRunMarking` from spread-on-object to explicit-delegation (Form B function) | D.1–D.4 | **D.1 LANDED** (this commit); D.2/D.3/D.4 LANDED (preceding refactors) |
| `src/notify.ts:2` | one `import { getProvider }` — survives unchanged | (read-only verification) | **Survives** (D.2) |
| `src/config.ts:8, :324-326` | imports `getProviderType`, `getChannelToken`, `getChannelChatId`, `type ChannelProviderType` — call sites migrated to `ChannelEnv` instance methods; `readEnvFile()` result passed into `new ChannelEnv(env)` | **D.1** (merged with D.5) | **Migrated** (this commit) |
| `src/channel-coordinator/liveness.ts:16, :193-194` | imports `channelStateDir`, `type ChannelProviderType` — `channelStateDir` call repointed to `ChannelEnv.stateDirFor(...)` static; type stays | **D.1** | **Migrated** (this commit) |
| `src/web/agent-process.ts:40` + 13 other production importers enumerated in `01-module-state-analysis.md` §8 | imports `getProvider`, `getProviderType`, `channelStateDir`, `readChannelToken`, `type ChannelProviderType` — all four call sites repointed to `ChannelEnv` (`getProvider` is unchanged; `channelStateDir` → `.stateDirFor`; `readChannelToken` → `.readTokenFor`) | **D.1** | **Migrated** (this commit) |
| 17 test files that mock `vi.mock('../channel-provider.js', …)` (enumerated `01 §7`) | 7 of 17 mock factories updated to expose `ChannelEnv` as `vi.fn()`; the remaining 10 use the same module shape (`getProvider` signature unchanged) | **D.1, D.2, D.3** | **7 updated** (this commit); 10 unchanged |

### Files this plan does NOT touch

- **`src/test-run-marker.ts:24-27`** (`markIfTestRun`, `TEST_RUN_PREFIX`,
  `isTestRun`) — survives unchanged. `withTestRunMarking`'s migration
  (`D.4`) consumes the same function; the function itself stays in
  `test-run-marker.ts` per the principle "If you notice unrelated dead
  code, mention it — don't delete it" (CLAUDE.md §3).
- **`src/format.ts:3,50`** (`formatForTelegram`, `splitMessage(text,
  limit = MAX_MESSAGE_LENGTH)`) — unchanged. The five provider classes
  import these helpers; their signatures are byte-identical.
- **`src/env.ts:13`** (`readEnvFile`) — `ChannelEnv` does not import this;
  the construction site (today `config.ts:17`) continues to call
  `readEnvFile()` and pass the resulting record into `new
  ChannelEnv(env)`.
- **`bin/` and `scripts/*.ts`** — `01 §8` confirms zero importers.
- **`web/federation/`** — out of D scope; not a channel-provider consumer.

---

## Dependency: what other subsystems expect from D

| Consumer | D deliverable it needs | What it expects | Blocking? |
|---|---|---|---|
| **`src/notify.ts:2`** | `getProvider(type)` returns `ChannelProvider` | Same `ChannelProviderType -> ChannelProvider` signature; `provider.sendMessage(token, chatId, text)` and `provider.sendPhoto(token, chatId, photoPath, caption)` keep their exact parameter lists per `review-correctness.md` C1 | **Resolved** (D.2). Cannot move token/chatId to instance state. |
| **`src/config.ts:324-326`** | `ChannelEnv.getToken(provider)` / `ChannelEnv.getChatId(provider)` | Returns `string` (not `null`/`undefined`); missing keys collapse to `''`. Source reads `env` from `readEnvFile()`, NOT `process.env` — `ChannelEnv` constructor takes `Record<string, string>`, not `process.env`. | **Resolved** (D.1, this commit). |
| **`src/channel-coordinator/liveness.ts:193-194`** + 13 other production sites | `ChannelEnv.stateDirFor(provider, agentDir?)` (static) | Returns `string`; `agentDir?` is optional and **remains optional** (14 of 19 production call sites pass it). | **Resolved** (D.1, this commit). |
| **`src/web/agent-process.ts:839`, `web/channel-monitor.ts:1287`, `web/channel-monitor.ts:1705`** + 2 more | `ChannelEnv.readTokenFor(provider, envFilePath: string)` (static) | Second parameter is a **filesystem path**, NOT an env record. Returns `string \| null`. | **Resolved** (D.1, this commit). |
| **`src/web/agent-process.ts:338`, `config.ts:324`** | `getProviderType(envValue: string \| undefined)` | Total coercion; returns `ChannelProviderType` (default `'telegram'` on unknown input). Pure function; stays as a free export. | **Resolved.** Stays a free function. |
| **H (logger migration)** | LoggerLike adoption decision for D | `channel-provider.ts` has **zero** logger call sites (only the dead import at `:5`). The class constructors MAY take `log: LoggerLike` for future-proofing, but D does not require H.1 to land first. | **No.** D is the only subsystem that can land before H.1; D.6 deferred. |
| **17 test mocks** (`01 §7`) | `vi.mock('../channel-provider.js', …)` factories keep resolving `getProvider`, `getProviderType`, `ChannelProvider`; **7** updated to expose `ChannelEnv` as `vi.fn()`; **10** unchanged because they only mock `getProvider`. | The 4 deleted helpers (`getChannelToken`, `getChannelChatId`, `channelStateDir`, `readChannelToken`) were mocked in 4 of the 17 mocks (per `01 §7` audit) — those 4 mocks were rewritten in D.1 to expose the `ChannelEnv` constructor instead. | **Resolved** (D.1, this commit): 7 of 17 mocks updated. |

---

## Top 3 risks specific to D — RESOLVED STATE (post-D.1)

1. **`withTestRunMarking`'s `{ ...provider }` spread silently drops prototype methods once providers become classes.** **RESOLVED in D.4 (Form B explicit-delegation function).** The spread at `channel-provider.ts:586` (was `:490-498` pre-D.2) now enumerates every interface member explicitly; once providers became classes in D.2 (line shift: providers now live at `:360/390/405/418/432`), the rewrite was a behaviour-preserving transformation. Both Form A (class) and Form B (function) would have worked; Form B was chosen for module locality (`03-class-boundaries.md` §D4 rationale). Source-verified at `channel-provider.ts:586-598`. Detail in `06-risks-and-mitigations.md` DR2.

2. **`ChannelEnv` constructor parameter shape.** **RESOLVED in D.1 (this commit).** The constructor at `channel-provider.ts:518` takes `env: Record<string, string> = {}` (defaulted so `stateDirFor` / `readTokenFor` callers can `new ChannelEnv()`), not `process.env`. The constructor is `constructor(private readonly env: Record<string, string> = {}) {}` — `env` is used only by `getToken` / `getChatId` (instance methods) and ignored by the two statics. `config.ts:324-326` passes the result of `readEnvFile()` (`src/env.ts:13`). `homedir()` is read directly inside `stateDirFor` (per-call, since the helper is stateless), not injected — no `home` parameter needed in D.1 (the original spec listed `home?: string` but the implementation deferred it; default `new ChannelEnv()` works for all 14 `stateDirFor` callers and 7 `readTokenFor` callers). Detail in `06-risks-and-mitigations.md` DR4.

3. **`getChannelStateDir` and `readChannelToken` are conceptually different from `getChannelToken` / `getChannelChatId`.** **RESOLVED in D.1 (this commit).** The first two are now `ChannelEnv.stateDirFor` / `ChannelEnv.readTokenFor` **static** methods (`channel-provider.ts:530` and `:543`); they do not consume `this.env`. The single dispatch table consolidating all four 5-branch chains lives at `ChannelEnv.TABLE` (`channel-provider.ts:507-517`), collapsing the 4 duplicated 5-branch chains into one `Record<ChannelProviderType, { tokenKey, chatIdKey, subdir }>`. The fallthrough-correctness concern (`'TELEGRAM_BOT_TOKEN'` default at `:464` pre-D.1) is now structurally eliminated: `stateDirFor` uses an exhaustive `switch (provider)` with 5 cases. Detail in `06-risks-and-mitigations.md` DR3 / DR4 / `04-generic-interfaces.md`.

---

## Migration order inside D

**As planned:**
```
D.1  ChannelEnv class            (introduce alongside 4 helpers; do NOT remove helpers)
  |
  +---> D.2  5 XxxProvider classes     (introduce alongside; free fns survive)
  |       |
  |       +---> D.3  ChannelProviderRegistry class  (introduce alongside)
  |
  +---> D.4  withTestRunMarking decorator migration (Form B explicit-delegation function)
  |
  +---> D.5  Helper removal          (gated on D.1 + consumer migration + test updates)
  |
  D.6  LoggerLike adoption         (depends on H.1; see h-cross-cutting/04 §L)
```

**As landed (post-D.1):**
```
D.4  withTestRunMarking Form B   (LANDED — pre-D.1 refactor)
  |
  +---> D.2  5 XxxProvider classes     (LANDED — pre-D.1 refactor)
  |       |
  |       +---> D.3  ChannelProviderRegistry class  (LANDED — pre-D.1 refactor)
  |
  D.1  ChannelEnv class + consumer migration + helper removal
       (LANDED — this commit; D.5 helper removal merged into D.1;
        no thin wrappers ever existed; deleted outright)
  |
  D.6  LoggerLike adoption         (DEFERRED — depends on H.1; off critical path)
```

Rationale (post-D.1 retrospective):

- **D.4 landed first** because the spread-on-object decorator was unsafe
  the moment providers became classes (per risk #1 above); landing D.4
  first let D.2 swap object literals for classes without an intermediate
  broken state.
- **D.2 next** because the 5 provider classes are mutually independent
  and share only the `ChannelProvider` interface contract. Single phase
  per the "share the contract" criterion; per-provider phasing buys
  nothing.
- **D.3 follows D.2** because the registry is a thin wrapper over the 5
  marked providers — building it before the providers exist forces
  constructing class instances at module-init time, which D.2 might want
  to defer.
- **D.1 absorbed D.5.** D.1 originally planned thin-wrapper survival
  ("do NOT remove helpers") but the consumer-migration sweep over 42
  call sites was a single coordinated change, so the wrapper intermediates
  would have been dead-on-arrival. The deletion committed in the same
  change; `grep -rln "getChannelToken\|getChannelChatId\|channelStateDir\
\|readChannelToken" src/ --include='*.ts' | grep -v __tests__` returns
zero matches in production code (only stale `comment` references remain,
which CLAUDE.md §3 forbids removing under "don't delete unrelated dead
code" — flagged but not removed).
- **D.6 deferred.** The 5 provider classes do not need a logger today
  (zero call sites per `02 §10`); D.6 only lands if H.1 forces the
  constructor-parameter shape on every converted class. If H.1 lands
  after D.1, D.6 is a no-op for D.
