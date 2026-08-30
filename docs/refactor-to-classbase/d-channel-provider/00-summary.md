# D (channel-provider) — Executive summary

Synthesis of `01-module-state-analysis.md` (module/state lens) and
`02-type-interface-analysis.md` (types/interfaces lens), cross-checked
against `src/channel-provider.ts` (552 lines, read in full on 2026-08-30)
and the rest of `src/` on the same date. **Planning only — no source files
were modified.**

---

## Thesis

The D subsystem is the five-implementation plugin pattern that backs every
channel send path: one `ChannelProvider` interface
(`src/channel-provider.ts:11`), five frozen-object provider literals
(`telegram:53`, `slack:134`, `discord:243`, `googlechat:324`, `teams:364`),
a registry (`markedProviders:500`, `getProvider:508`) plus a
`withTestRunMarking:490` decorator, and four top-level helpers
(`getChannelToken:459`, `getChannelChatId:467`, `channelStateDir:520`,
`readChannelToken:533`). All five providers are **stateless**: token and
chatId are per-call parameters, never instance state — this is the
framework `review-correctness.md` C1 verdict and any class extraction must
preserve the `(token, chatId, …)` signature byte-for-byte. The refactor
therefore produces one `ChannelEnv` class (absorbing `getChannelToken` and
`getChannelChatId`), five stateless `XxxProvider` classes with constructor
`(log?: LoggerLike)` per H.1, one `ChannelProviderRegistry` class wrapping
`markedProviders`, one `UnsupportedDirectSendProvider` abstract base for
the googlechat/teams pair (the only place real dedup exists), and a
decorator migration for `withTestRunMarking`. D has **zero logger call
sites** today (verified: `grep -n "logger" src/channel-provider.ts`
returns the dead import at `:5` only), so it is the cheapest consumer of
the H migration and does not block on H.1.

---

## Scope

### Files this plan TOUCHES

| File | Why | Phase |
|---|---|---|
| `src/channel-provider.ts` (552 lines) | extract `ChannelEnv` class, 5 `XxxProvider` classes, `ChannelProviderRegistry` class, `UnsupportedDirectSendProvider` base, dispatch table; convert `withTestRunMarking` from spread-on-object to explicit-delegation class decorator | D.1–D.5 |
| `src/notify.ts:2` | one `import { getProvider }` — survives unchanged | (read-only verification) |
| `src/config.ts:8` | imports `getProviderType`, `getChannelToken`, `getChannelChatId`, `type ChannelProviderType` — call sites migrate to `ChannelEnv` instance methods | D.5 (helper removal gates this) |
| `src/channel-coordinator/liveness.ts:16` | imports `channelStateDir`, `type ChannelProviderType` — type stays; `channelStateDir` stays as a free function or becomes `ChannelEnv.stateDirFor(...)` static | D.1, D.5 |
| `src/web/agent-process.ts:40` | imports `getProvider`, `getProviderType`, `channelStateDir`, `readChannelToken`, `type ChannelProviderType` — all four survive (free functions for `ChannelStateDir` / `readChannelToken`; class instance for `ChannelEnv`; registry unchanged) | D.5 |
| 13 other production importers enumerated in `01-module-state-analysis.md` §8 | read-only verification only — the public surface (`getProvider`, `ChannelProviderType`, `channelStateDir`, `readChannelToken`, `getProviderType`, `ChannelProvider`) is preserved verbatim, so the only edits are call-site adjustments for the two helpers that move into `ChannelEnv` | D.5 |
| 17 test files that mock `vi.mock('../channel-provider.js', …)` (enumerated `01 §7`) | update mock factories only if class-instance construction replaces module-level `const`; the dominant mock pattern (inline object replacing the module) survives because `getProvider` keeps the same signature | D.2, D.3 |

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
| **`src/notify.ts:2`** | `getProvider(type)` returns `ChannelProvider` | Same `ChannelProviderType -> ChannelProvider` signature; `provider.sendMessage(token, chatId, text)` and `provider.sendPhoto(token, chatId, photoPath, caption)` keep their exact parameter lists per `review-correctness.md` C1 | **Yes.** Cannot move token/chatId to instance state. |
| **`src/config.ts:325-326`** | `getChannelToken(provider, env)` / `getChannelChatId(provider, env)` | Returns `string` (not `null`/`undefined`); missing keys collapse to `''`. Source reads `env` from `readEnvFile()`, NOT `process.env` — `ChannelEnv` constructor must take `Record<string, string>`, not `process.env`. | **Yes.** |
| **`src/channel-coordinator/liveness.ts:193-194`** + 13 other production sites | `channelStateDir(provider, agentDir?)` | Returns `string`; `agentDir?` is optional and **must remain optional** (14 of 19 production call sites pass it). | **Yes.** |
| **`src/web/agent-process.ts:839`, `web/channel-monitor.ts:1287`, `web/channel-monitor.ts:1705`** + 2 more | `readChannelToken(provider, envFilePath: string)` | Second parameter is a **filesystem path**, NOT an env record. Returns `string \| null`. | **Yes.** |
| **`src/web/agent-process.ts:338`, `config.ts:324`** | `getProviderType(envValue: string \| undefined)` | Total coercion; returns `ChannelProviderType` (default `'telegram'` on unknown input). Pure function; not classified as one of the "4 helpers". | **Yes.** Stays a free function. |
| **H (logger migration)** | LoggerLike adoption decision for D | `channel-provider.ts` has **zero** logger call sites (only the dead import at `:5`). The class constructors MAY take `log: LoggerLike` for future-proofing, but D does not require H.1 to land first. | **No.** D is the only subsystem that can land before H.1. |
| **17 test mocks** (`01 §7`) | `vi.mock('../channel-provider.js', …)` factories keep resolving `getProvider`, `channelStateDir`, `readChannelToken`, `getProviderType`, `getChannelToken`, `getChannelChatId` | The two helpers that move into `ChannelEnv` (`getChannelToken`, `getChannelChatId`) are mocked in **zero** of the 17 mocks (per `01 §7` audit). `channelStateDir` and `readChannelToken` are the mocked helpers; both stay as top-level exports. | **Yes.** Keeping the surface intact means zero mock rewrites for the helper migration. |

---

## Top 3 risks specific to D

1. **`withTestRunMarking`'s `{ ...provider }` spread silently drops prototype methods once providers become classes.** Today all five providers are object literals, so every member is an own property and the spread copies them. The moment `telegramProvider` becomes `class TelegramChannelProvider implements ChannelProvider`, `formatMessage` / `splitMessage` / `validateToken` move from own properties to prototype methods, and `{ ...instance, sendMessage, sendPhoto }` produces an object with three missing members. TypeScript would flag it (the return-type annotation `ChannelProvider` forces the spread result to satisfy the interface) but the obvious "fix" is to loosen the annotation, which silently breaks `notify.ts:16-17` (`provider.formatMessage(...)` becomes `TypeError: … is not a function`). The correct conversion is a `TestRunMarkingDecorator` class with explicit delegation of all 11 interface members, not a spread. Source-verified at `channel-provider.ts:490-498`. Detail in `06-risks-and-mitigations.md` DR2.

2. **`ChannelEnv` constructor parameter shape.** The brief suggests `constructor(process.env)`; the source disagrees. `getChannelToken:459` and `getChannelChatId:467` take `env: Record<string, string>` as a **parameter**, and the only production caller is `config.ts:325-326` which passes the result of `readEnvFile()` (`src/env.ts:13`), NOT `process.env`. Constructing `ChannelEnv` from `process.env` would change which values `CHANNEL_TOKEN` and `CHANNEL_CHAT_ID` resolve to in production — a silent behaviour change. The constructor must take the parsed env record as a parameter and an injected `home: string` (since `channelStateDir:523` calls `homedir()` directly today, the only non-deterministic dependency in the file's 4 helpers). Detail in `06-risks-and-mitigations.md` DR4.

3. **`getChannelStateDir` and `readChannelToken` are conceptually different from `getChannelToken` / `getChannelChatId`.** The first two don't read `process.env`: `channelStateDir:520` reads `homedir()` (per call) and a per-type subdir string; `readChannelToken:533` reads a per-channel `.env` file (different file from `process.env`). The brief's sketch `readToken(provider, env?)` conflates these — `readChannelToken`'s second argument is a path, not an env record. Moving these into `ChannelEnv` as instance methods with `env` injected is wrong (they don't use it). Keeping them as free functions is correct. The single dispatch table consolidating all four 5-branch chains (the second-largest dedup win in the file after the `UnsupportedDirectSendProvider` base) belongs as a `static readonly` on `ChannelEnv` for namespace symmetry, not as 5 instance fields. Detail in `06-risks-and-mitigations.md` DR3 / DR4 / `04-generic-interfaces.md`.

---

## Migration order inside D

```
D.1  ChannelEnv class            (introduce alongside 4 helpers; do NOT remove helpers)
  |
  +---> D.2  5 XxxProvider classes     (introduce alongside; free fns survive)
  |       |
  |       +---> D.3  ChannelProviderRegistry class  (introduce alongside)
  |
  +---> D.4  withTestRunMarking decorator migration (TestRunMarkingDecorator class)
  |
  +---> D.5  Helper removal          (gated on D.1 + consumer migration + test updates)
  |
  D.6  LoggerLike adoption         (depends on H.1; see h-cross-cutting/04 §L)
```

Rationale:

- **D.1 first** because every helper-migration call site (`config.ts:325-326`)
  needs an instance to call methods on; the helper functions survive in
  parallel as thin wrappers so the sink consumers don't break on the same
  commit.
- **D.2 next** because the 5 provider classes are mutually independent and
  share only the `ChannelProvider` interface contract. Single phase per the
  "share the contract" criterion; per-provider phasing buys nothing.
- **D.3 follows D.2** because the registry is a thin wrapper over the 5
  marked providers — building it before the providers exist forces
  constructing class instances at module-init time, which D.2 might want
  to defer.
- **D.4 follows D.2/D.3** because `TestRunMarkingDecorator` is a
  `ChannelProvider` consumer; building it against object-literal providers
  first lets the decorator signature stabilize, then the providers convert.
  (Reversed order is possible but requires the decorator to know the class
  shape before the class exists — higher coordination cost.)
- **D.5 last inside D.** Gated on: (a) every importer of the 4 helpers
  migrated to `ChannelEnv` instance methods (`config.ts:325-326` is the
  only `getChannelToken` / `getChannelChatId` production caller); (b) test
  suite green. The gate is `grep -rln "getChannelToken\|getChannelChatId"
  src/ --include='*.ts' | grep -v __tests__` returning only
  `src/channel-provider.ts` (the surviving free wrapper).
- **D.6 deferred.** The 5 provider classes do not need a logger today
  (zero call sites per `02 §10`); D.6 only lands if H.1 forces the
  constructor-parameter shape on every converted class. If H.1 lands
  after D.5, D.6 is a no-op for D.
