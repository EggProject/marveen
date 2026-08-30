# D (channel-provider) — Risks and mitigations

Risks specific to the D subsystem. Each entry: name, where-it-bites,
mitigation, detection signal. Subsystem-level risks for the H migration
(`h-cross-cutting/06-risks-and-mitigations.md` HR1–HR6) are referenced
where they apply to D.

---

## DR1. CRITICAL — preserving per-call `(token, chatId)` signature after class extraction

### Where it bites

The five provider classes' methods **must** keep `(token, chatId, …)`
as per-call parameters, identical to the object-literal signatures at
`channel-provider.ts:18-22`. `review-correctness.md` **C1** established
this: the plan's earlier `03-class-boundaries.md` A13 sketch proposed
moving token/chatId to instance state (`sendMessage(text: string, opts?:
SendOpts): Promise<SendResult>`), and the refutation cited the source
verbatim — there is no instance state on the providers today, and adding
it would silently break `notify.ts:22` / `:31` which call
`provider.sendMessage(token, chatId, text, parseMode)` directly.

Three concrete failure modes:

1. **Constructor takes `(token, chatId)`.** A constructor accepting a
   token would store it on `this`, requiring every test that constructs
   a `TelegramProvider` to pass a token (and giving a future contributor
   a path to leak a token via instance introspection).
2. **Method loses a parameter.** A `sendMessage(text, parseMode?)`
   signature would compile (the interface only constrains the
   `ChannelProvider` shape, and `token`/`chatId` would become
   `this.token` / `this.chatId`) but every call site that supplies them
   positionally fails compilation.
3. **`SendResult` return type introduced.** `sendMessage`'s return is
   `Promise<void>` per the interface (`:18`); adding `Promise<SendResult>`
   would force every caller to await and destructure a value that
   doesn't exist today. The current callers (`notify.ts:22, 31`,
   `web/agent-process.ts` indirectly via `notify.ts`) rely on the throw.

### Affected line numbers

| Provider | sendMessage | sendPhoto | validateToken | formatMessage | splitMessage |
|---|---|---|---|---|---|
| telegram | `:61` | `:68` | `:89` | `:102` | `:103` |
| slack | `:142` | `:165` | `:207` | `:226` | `:227` |
| discord | `:251` | `:266` | `:294` | `:309` | `:310` |
| googlechat | `:332` (throws) | `:338` (throws) | `:342` (returns `{ok:true}`) | `:348` | `:349` |
| teams | `:372` (throws) | `:379` (throws) | `:383` (returns `{ok:true}`) | `:389` | `:390` |

Every one of those 25 method bodies takes `token` as the first parameter
and (for `sendMessage`/`sendPhoto`) `chatId` as the second. Every one
must keep that parameter order in the class version.

### Mitigation

1. **Pinned in `03-class-boundaries.md` D2 "Common contract".** The
   signatures are copy-pasted from the interface verbatim. The class
   declarations are written against the interface, not against the
   literal — `class TelegramProvider implements ChannelProvider` —
   which makes the parameter list a compile-time check.
2. **Compile-time guard.** Add a structural test in
   `__tests__/channel-provider-classes.test.ts` that asserts:
   ```ts
   // Compile-time: assigning a class instance to the interface proves
   // method signatures are compatible.
   const _t: ChannelProvider = new TelegramProvider()
   const _s: ChannelProvider = new SlackProvider()
   // ... and same for the other three.
   ```
   If a future change drops `token`/`chatId`, the assignment fails.
3. **Test-side smoke check.** Add a per-class test that calls
   `provider.sendMessage('test-token', 'test-chat', 'hello')` and asserts
   the underlying HTTP call (or, for googlechat/teams, the thrown error)
   carries the token — proving the parameter flow works end-to-end.
4. **Code review pin.** Every D.2 PR must include a comment that
   references `review-correctness.md` C1 in the class declaration
   header: `// Per review-correctness.md C1: token/chatId are per-call
   // parameters, NOT instance state. Do NOT add a token/chatId
   // constructor parameter.`

### Detection signal

- A `bun tsc --noEmit` error of the form `Expected N arguments, but got
  M` in any file that calls `provider.sendMessage(...)` /
  `provider.sendPhoto(...)` after D.2 lands — the new class lost a
  parameter.
- A diff that adds `constructor(token, chatId)` to any provider class —
  visible immediately on review.
- A test asserting on a `SendResult`-shaped value (note: `SendResult` does
  not exist in the source per `02 §4`).

---

## DR2. `withTestRunMarking` decorator — spread drops prototype methods after class conversion

### Where it bites

`channel-provider.ts:490-498`:
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

`{ ...provider }` is an **own-enumerable-property spread**. Today all
five providers are object literals, so every interface member
(`formatMessage`, `splitMessage`, `validateToken` + the 6 readonly
fields) is an own property and the spread copies them. The moment
`telegramProvider` becomes `class TelegramProvider implements
ChannelProvider`, `formatMessage` / `splitMessage` / `validateToken`
move from own properties to **prototype methods**, and `{ ...instance,
sendMessage, sendPhoto }` produces an object that has:

- The 6 readonly fields (own properties → copied)
- `sendMessage` and `sendPhoto` (re-bound by the spread)
- **Missing** `formatMessage`, `splitMessage`, `validateToken`

TypeScript would catch the structural gap **only if the return-type
annotation `ChannelProvider` is kept**. The temptation under review is
to "loosen" the annotation to `Omit<ChannelProvider, 'formatMessage' |
'splitMessage' | 'validateToken'>` — that compiles, but at runtime
`notify.ts:16-17`'s `provider.formatMessage(...)` and
`provider.splitMessage(...)` throw `TypeError: … is not a function`.

### Affected test files

The decorator is applied to **all 5 providers** at `:500-506`, and the
result is consumed by:

- **18 production importers** of `getProvider` (the only public read
  path), enumerated in `01 §8`. Of those, `notify.ts:2` and
  `web/agent-process.ts:40` directly call `provider.formatMessage` /
  `provider.splitMessage`.
- **17 test files** that mock `'../channel-provider.js'`. None of them
  reference `withTestRunMarking` directly (it's not exported); they
  either mock `getProvider` (16 files) or `channelStateDir` (1 file,
  `channel-coordinator-liveness.test.ts:99`). Per `01 §7`, none of the
  17 mocks break under a D.4 rewrite because they don't reach into the
  decorator.

The blast radius is therefore the **production callers of
`getProvider`** that exercise `formatMessage` / `splitMessage`, plus
any future test that does the same.

### Mitigation

1. **Rewrite the decorator to enumerate every interface member
   explicitly.** Per `03-class-boundaries.md` §D4, Form B (recommended)
   or Form A both work; both enumerate all 11 members.
2. **Compile-time pin.** `function withTestRunMarking(provider:
   ChannelProvider): ChannelProvider` — the explicit return-type
   annotation is the gate. A spread that drops members fails this
   gate.
3. **`implements ChannelProvider` if Form A is chosen.** This is the
   same gate at the class level.
4. **Regression test in `__tests__/channel-provider-classes.test.ts`.**
   Construct `new TelegramProvider()`, wrap with
   `withTestRunMarking(new TelegramProvider())`, and assert every
   interface member is reachable through the wrapper:
   ```ts
   const inner = new TelegramProvider()
   const marked = withTestRunMarking(inner)
   expect(typeof marked.sendMessage).toBe('function')
   expect(typeof marked.sendPhoto).toBe('function')
   expect(typeof marked.validateToken).toBe('function')
   expect(typeof marked.formatMessage).toBe('function')
   expect(typeof marked.splitMessage).toBe('function')
   expect(marked.formatMessage('hello')).toBe(inner.formatMessage('hello'))
   ```
5. **Commit ordering.** D.4 must land **before** D.2 in commit order
   (per `05-refactor-roadmap.md` Phase D.2 Risk level #1). Otherwise,
   between the D.2 commit and the D.4 commit, every `getProvider()`
   call returns a wrapper with three missing methods.

### Detection signal

- `bun tsc --noEmit` error
  `Property 'formatMessage' is missing in type '{ sendMessage: …;
  sendPhoto: …; type: …; ... }'` in `channel-provider.ts:490` — the
  compiler catches the spread form if the return-type annotation is
  kept.
- A test that calls `marked.formatMessage('hello')` and gets
  `TypeError: marked.formatMessage is not a function` — runtime
  evidence that the spread dropped prototype methods.
- A diff that loosens the return-type annotation from `ChannelProvider`
  to anything less specific — review-time signal.

---

## DR3. `vi.mock('../channel-provider.js')` mock seam across 17 test files

### Where it bites

`01 §7` enumerates 17 test files that mock
`'../channel-provider.js'` (full enumeration below). The dominant pattern
is **inline object literal replacing the module**:

| Pattern | Count |
|---|---:|
| Full module replacement (inline object) | 9 |
| Partial mock with `async (orig) => { ... await orig() ... }` | 4 |
| Partial mock with `async (importOriginal) => { ... }` (named-param alias) | 3 |
| Single-export stub (`{ getProvider }`) | 1 |
| **`vi.doMock` (separate API)** | 1 (`channel-coordinator-liveness.test.ts:99`, stubs `channelStateDir`) |
| **Total** | **17** |

None of these mocks reference the class surface — they replace the
module's exports, so the class-vs-object-literal distinction is
invisible to them. The class conversion (D.2) therefore does not break
the mocks directly, but two derived concerns need to be addressed:

1. **The mocks today stub `getProvider`, which after D.3 returns from a
   `ChannelProviderRegistry.get` call.** If a test's stub uses an object
   literal that the test code then calls `formatMessage` on, the stub
   must enumerate all 11 interface members. Today the stub-object
   typically only sets `sendMessage`/`sendPhoto` (the two methods the
   test exercises). After D.2, if a test's code path gains
   `provider.formatMessage(...)` coverage, the stub will silently throw
   at runtime — unless the stub enumerates the full surface.
2. **`vi.mock('../channel-provider.js')` and `vi.doMock(...)` are
   distinct APIs.** The single `vi.doMock` file
   (`channel-coordinator-liveness.test.ts:99`) stubs `channelStateDir`,
   which after D.5a/b/c becomes `ChannelEnv.stateDirFor(...)` — a
   static method on a class. `vi.doMock` cannot replace a static method
   on a class (because static methods are not module exports in the same
   way). The mock factory will need to either keep `channelStateDir` as
   a re-export from `channel-provider.ts` (a thin wrapper that calls
   `ChannelEnv.stateDirFor`), OR the test must be rewritten to stub the
   class directly.

### Mitigation

1. **Audit each of the 17 mocks** for which interface members the
   stub-object exposes. Any stub that omits `formatMessage`,
   `splitMessage`, or `validateToken` is a latent bug — it works today
   because the test code never reaches those methods, but a future
   coverage expansion would break it. Fix the stub during D.2's test
   audit, not after.
2. **Keep `channelStateDir` as a top-level re-export** through D.5c.
   The re-export is `export const channelStateDir = (p, d) =>
   ChannelEnv.stateDirFor(p, d)` — a function, mockable through the
   usual `vi.mock` mechanism. Removing it is a D.5c concern; the test
   rewrite is the same shape as today.
3. **`ChannelProviderRegistry.get` is the only read path.** Every mock
   factory that today sets `getProvider: ...` becomes
   `getProvider: (t) => ...` returning a stub `ChannelProvider`. The
   stub's interface membership must be complete.
4. **Add a `createMockChannelProvider()` factory** in the test
   utilities (per `review-completeness.md` CE-5 precedent) so the 17
   mocks can `vi.mock('../channel-provider.js', () => ({
   ...createMockChannelProvider(), ... }))` instead of ad-hoc inline
   objects. This is **out of D's scope** (it's a test-helper concern)
   but D's plan should mention it so it lands in a sibling commit.

### Detection signal

- A test that passes in isolation but fails when the suite runs a
  new code path that calls `provider.formatMessage` — the stub omits
  the method.
- A `vi.doMock` of `channelStateDir` that returns `undefined` after the
  helper is removed — the static method is not mockable through the same
  path.
- A test that does `vi.mock('../channel-provider.js', () => ({
  sendMessage: ... }))` and then asserts on `mocked.formatMessage` —
  the mock factory doesn't conform to `ChannelProvider`.

### Enumerated mock sites (for review)

The 17 files in `01 §7` are: `channel-mcp-reconnect.test.ts:44`,
`agent-scaffold-baseline.test.ts:68`, `channel-request-watcher.test.ts:87`,
`channel-health-monitor.test.ts:64`, `agent-scaffold-full.test.ts:65`,
`channel-mcp-reconnect-full.test.ts:63`, `discord-group-bootstrap.test.ts:61`,
`agent-process.test.ts:200`, `agent-scaffold-scheduled-tasks-catch.test.ts:46`,
`channel-monitor-coverage.test.ts:254`, `channel-monitor-baseline.test.ts:233`,
`channel-monitor.test.ts:270`, `schedule-runner-full.test.ts:269`,
`onboarding-routes.test.ts:74`, `test-run-marker.test.ts:33`,
`agents-routes.test.ts:427`, `notify.test.ts:25`, plus
`channel-coordinator-liveness.test.ts:99` (the `vi.doMock` outlier).

---

## DR4. `ChannelEnv` constructor parameter shape (`process.env` vs `readEnvFile()`)

### Where it bites

The brief sketches `ChannelEnv` constructed from `process.env` (or an
`EnvSource`). The source disagrees:

- `getChannelToken:459` and `getChannelChatId:467` take `env:
  Record<string, string>` as a **per-call parameter** — they do not
  read `process.env` directly.
- The only production caller is `config.ts:325-326`, which passes
  `env` from `const env = readEnvFile()` (`src/env.ts:13`).
- `readEnvFile` parses `${PROJECT_ROOT}/.env` — it is **not**
  `process.env`. Production keys like `TELEGRAM_BOT_TOKEN` resolve from
  the `.env` file, not from the OS environment.

If `ChannelEnv` is constructed from `process.env` instead of from the
parser output, every value the two helpers return changes:

- `process.env['TELEGRAM_BOT_TOKEN']` would return `undefined` in any
  normal shell run that doesn't `export` the value.
- `readEnvFile()['TELEGRAM_BOT_TOKEN']` returns the parsed value from
  `.env`.

The constructors' callers would silently observe empty strings for
every token and chat id — every outbound notification would fail
authentication.

### Affected sites

| Site | File:line | Today |
|---|---|---|
| `getChannelToken` caller | `src/config.ts:325` | `getChannelToken(CHANNEL_PROVIDER, env)` where `env = readEnvFile()` |
| `getChannelChatId` caller | `src/config.ts:326` | `getChannelChatId(CHANNEL_PROVIDER, env)` same `env` |
| `channelStateDir` home source | `src/channel-provider.ts:523` | `homedir()` directly — no env |
| `readChannelToken` file source | `src/channel-provider.ts:533` | `envFilePath` parameter — different file from `.env` |

### Mitigation

1. **Constructor signature:** `constructor(env: Record<string, string>,
   home: string = homedir())` per `03-class-boundaries.md` D1. The
   caller passes the `env` they want the helpers to see; today the
   caller is `config.ts:17 + :325-326`.
2. **Inject `home` as a second constructor parameter.** `channelStateDir`
   is the only consumer of `homedir()` today (`:523`); making it
   constructor-injectable removes the test-time `vi.mock('node:os')`
   requirement.
3. **Constructor does no I/O.** No `process.env` reads, no file reads.
   Pure field assignment.
4. **Compile-time pin.** A test that constructs
   `new ChannelEnv({})` and calls `.getToken('telegram')` should return
   `''` (the empty-string fallback), not `undefined` and not throw.
   This proves the constructor's `env` is the source, not `process.env`.
5. **Production boot pin.** In `config.ts`, the construction site is
   `const channelEnv = new ChannelEnv(readEnvFile())` — explicitly
   taking the parsed `.env` record, not `process.env`. Documented in a
   comment so a future reader doesn't "helpfully" switch to `process.env`.

### Detection signal

- A test that calls `new ChannelEnv({}).getToken('telegram')` and gets
  `undefined` (or a non-empty string from `process.env`) — the
  constructor is reading from the wrong source.
- A production run where every Telegram/Discord/etc. send returns
  `undefined` for the token — the migration switched the source.
- A diff that adds `process.env[...]` access inside the `ChannelEnv`
  class body — review-time signal.

---

## DR5. `validateToken` return type — optional fields must remain optional

### Where it bites

`channel-provider.ts:20` declares:
```ts
validateToken(token: string): Promise<{ ok: boolean; botName?: string; error?: string }>
```

The named return type (`ValidateTokenResult` per `04 §3(b)`) preserves
this exactly: `botName?` and `error?` are optional. The current return
shapes from each provider are:

| Provider | File:line | Return shape |
|---|---|---|
| telegram | `:94` | `{ ok: true, botName: data.result.username }` |
| telegram | `:96` | `{ ok: false, error: 'Invalid bot token' }` |
| telegram | `:98` | `{ ok: false, error: 'Failed to connect to Telegram API' }` |
| slack | `:218` | `{ ok: true, botName: data.user \|\| data.bot_id }` (botName can be `undefined`) |
| slack | `:220` | `{ ok: false, error: data.error \|\| 'Invalid token' }` |
| slack | `:222` | `{ ok: false, error: 'Failed to connect to Slack API' }` |
| discord | `:301` | `{ ok: true, botName: data.username }` |
| discord | `:303` | `{ ok: false, error: 'Invalid bot token' }` |
| discord | `:305` | `{ ok: false, error: 'Failed to connect to Discord API' }` |
| googlechat | `:345` | `{ ok: true, botName: 'Google Chat' }` |
| teams | `:386` | `{ ok: true, botName: 'Microsoft Teams' }` |

Two consumers destructure these returns:

- `src/web/routes/agents.ts:968`
- `src/web/routes/agents.ts:1046`
- `src/web/routes/agents.ts:1435`

The temptation under refactor is to **tighten** the return shape into a
discriminated union `{ ok: true; botName: string } | { ok: false; error:
string }` — this compiles (each branch has its own `botName`/`error`
slot) but breaks:

1. **Slack's `{ ok: true, botName: data.user || data.bot_id }`** at
   `:218` — `data.user` is `string | undefined` and `data.bot_id` is
   also optional per the Slack API response (`:216`). The expression
   `data.user || data.bot_id` can be `undefined`. A discriminated
   `{ ok: true; botName: string }` would force a non-`string` default
   (e.g., `?? 'unknown'`) which changes observable behaviour.
2. **googlechat / teams return `{ ok: true }` with no `error`.** A
   discriminated `{ ok: false; error: string }` branch would not see
   these calls, but the type would still claim every `ok: true` case
   carries `botName`. Compilation passes; runtime is unchanged. But
   the three destructuring consumers would have to add `if (result.ok)
   result.botName` (with `botName: string | undefined`), defeating the
   discriminated-union win.

### Mitigation

1. **Keep the anonymous return type verbatim.** The named interface
   `export interface ValidateTokenResult { readonly ok: boolean;
   readonly botName?: string; readonly error?: string }` is structurally
   identical to the anonymous type today.
2. **Add `readonly` to the named interface** — tighter than today but
   matches the existing `readonly` modifier convention. Today the
   anonymous type is implicitly mutable; tightening to `readonly` is a
   **safe upgrade** because no caller assigns to the returned object's
   properties.
3. **Document the slack quirk.** A comment in `03-class-boundaries.md`
   §3(b) records why a discriminated union is rejected. The comment is
   the pin; a future contributor who suggests the discriminated form
   reads the comment first.
4. **Compile-time test.** A type-only assertion in the test suite:
   ```ts
   const _check: ValidateTokenResult = await new TelegramProvider().validateToken('test-token')
   ```
   If the future "discriminated union" change lands, this still
   compiles (the union is assignable to the wider interface), but a
   smoke test that asserts `result.botName === undefined` for the
   slack-with-empty-body case (where `data.user` and `data.bot_id` are
   both absent) catches the regression.

### Detection signal

- A test that calls `new SlackProvider().validateToken('')` (where Slack
  returns `{ ok: false, error: ... }`) and asserts `result.botName`
  exists — the discriminated form would have a type error here.
- A diff that adds `readonly code?: string` (errno-style) to the return
  type — veers into HR6 territory, not this DR.

---

## DR6. H subsystem HR4 (LoggerLike vs pino.Logger) applies to D

### Where it bites

D is **not blocked** by HR4 because `02 §10` confirms zero logger call
sites in `channel-provider.ts`. But if H.1 lands first and the
framework's policy is "every converted class takes `log: LoggerLike`",
the 5 provider classes and `ChannelEnv` get an optional
`log?: LoggerLike` constructor parameter in D.6. Two derived risks:

1. **Test code that constructs a class instance must supply a
   `LoggerLike` (or rely on the optional).** Today the 17 mocks at
   `01 §7` replace the module, so they don't construct class instances
   directly. But future tests (e.g., direct class-instantiation tests
   in `__tests__/channel-provider-classes.test.ts`) would need a
   `LoggerLike` mock. Per `h-cross-cutting/04 §L`, the minimum
   `LoggerLike` is
   ```ts
   { info: (msg) => void; info: (obj, msg?) => void; warn: ...; error: ...; debug: ... }
   ```
   A test that supplies `{ info: () => {}, warn: () => {}, error: () => {} }`
   (missing `debug`) is a latent runtime bug — any D method that ever
   reaches `log.debug` would throw.
2. **The class constructor parameter is currently unused.** Per `02 §10`
   the file has zero `logger.<level>(` calls. The parameter is
   underscore-prefixed (`_log?: LoggerLike`) to silence
   `noUnusedParameters`. A future contributor adding a `log.debug(...)`
   call inside a provider method would suddenly have a live logger.

### Affected sites (post-D.6)

| Class | File:line (after D.2) | Constructor signature |
|---|---|---|
| `TelegramProvider` | `channel-provider.ts:~60` (D.2) | `constructor(_log?: LoggerLike)` |
| `SlackProvider` | `~140` | same |
| `DiscordProvider` | `~250` | same |
| `UnsupportedDirectSendProvider` | `~310` | same |
| `GooglechatProvider` | `~340` | same |
| `TeamsProvider` | `~380` | same |
| `ChannelEnv` | `~450` (D.1) | `constructor(env, home?, _log?: LoggerLike)` |

### Mitigation

1. **D.6 is conditional on H.1.** If H.1 lands after D.5, D.6 is a
   no-op for D. If H.1 lands first, add the underscore-prefixed
   optional parameter in D.6 — strictly additive, no migration cost.
2. **Test factory conformance.** Per HR4 mitigation 1
   (`h-cross-cutting/06-risks-and-mitigations.md:104-109`), the
   recommended minimum-surface `LoggerLike` accepts 64 of 91 existing
   mocks unchanged. For D's new class-instantiation tests, the same
   factory applies: a `{ info, warn, error, debug }` literal with two
   overloads each.
3. **Latent-bug pin (per HR2).** The ~12 existing mocks that omit
   `debug` are pre-existing runtime bugs. If H.1 lands before D.6, the
   H.1 commit fixes those mocks; if H.1 lands after D.6, the fix is
   part of D.6's audit.
4. **No `child()` requirement.** Per `h-cross-cutting/06 HR1`, the
   `LoggerLike` interface does not include `child()`. Adding a
   `log.child(...)` call inside any D class would silently fail —
   either compile-time (if the interface is strict) or runtime
   (`TypeError: log.child is not a function`). Documented as a
   forbidden pattern in the class header comments.

### Detection signal

- A `bun tsc --noEmit` error
  `Property 'debug' is missing in type '{ info: …; warn: …; error: … }'`
  in any test that constructs a D class — the mock factory doesn't
  conform to `LoggerLike`.
- A diff adding `log.child(...)` in any D class — review-time signal.
- A test that asserts `mockLog.info` sees zero calls while the same
  code path in a different test (where the mock is correctly
  injected) sees the call — the dual-destination problem from
  `h-cross-cutting/06 HR3`.

---

## Cross-reference: H risks that affect D

| H risk | Affects D? | Why |
|---|---|---|
| HR1 (`child()` rebinding) | **Yes (latent)** | If a future contributor adds `log.child(...)` to any D class, the rebinding loss would silently bypass test-injected loggers. Pin: structural test asserting zero `\.child\(` in `src/channel-provider.ts`. |
| HR2 (partial mocks) | **Yes** | The 17 mocks at `01 §7` don't construct class instances (they replace the module), so HR2 doesn't bite D directly. But the new direct-instantiation tests must conform. |
| HR3 (dual destination) | **No (today)** | D has no logger call sites today. HR3 becomes live only after D.6 lands and a future contributor adds a `log.info(...)` line. |
| HR4 (LoggerLike signature) | **Yes** | D.6 is conditional on H.1. When H.1 lands, D.6 adopts the two-overload `LogFn`. |
| HR5 (LazyBin cache) | **No** | D does not use `makeLazyBinResolver` and does not call `resolveFromPath`. |
| HR6 (error taxonomy) | **No** | D throws plain `Error` only (`channel-provider.ts:43, 85, 157, 161, 180, 203, 262, 290, 335, 339, 376, 380`); no project error classes. The new `ValidateTokenResult` interface is for a different reason (named shape, not `AppError` taxonomy). |

---

## Summary table

| ID | Risk | Severity | Mitigation summary |
|---|---|---|---|
| DR1 | Per-call `(token, chatId)` signature preserved | **Critical** | Pinned by `implements ChannelProvider`; `review-correctness.md` C1 referenced in class header; compile-time guard `const _: ChannelProvider = new XxxProvider()`; smoke test for each provider |
| DR2 | Decorator spread drops prototype methods | High | D.4 explicit-delegation rewrite (must precede D.2 in commit order); `__tests__/channel-provider-classes.test.ts` reaches every interface member through the wrapper |
| DR3 | 17 mocks + `vi.doMock` outlier | Medium | Audit each mock for interface membership completeness; keep `channelStateDir` as a top-level re-export through D.5c; consider a `createMockChannelProvider()` factory (test-helper concern, out of D scope) |
| DR4 | `ChannelEnv` constructor takes `process.env` | **Critical** | Constructor signature `(env: Record<string, string>, home: string = homedir())`; explicit `const channelEnv = new ChannelEnv(readEnvFile())` in `config.ts` boot |
| DR5 | `validateToken` return shape — `botName`/`error` stay optional | Medium | Named `ValidateTokenResult` with `readonly` modifiers; documented slack quirk that defeats discriminated-union temptation |
| DR6 | HR4 / LoggerLike conformance | Low | D.6 conditional on H.1; underscore-prefix `_log?` parameter; forbidden `log.child(...)` pattern |
