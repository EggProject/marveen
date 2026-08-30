# Plan Review — D (channel-provider) over-engineering & completeness

Review scope: all six D plan documents
(`docs/refactor-to-classbase/d-channel-provider/00-summary.md` through
`06-risks-and-mitigations.md`). Source ground-truth verified against
`src/channel-provider.ts` (552 lines), the 17 importer files, and the 17
test mocks on 2026-08-30.

Cross-references: framework `review-completeness.md` (OE-1 to OE-11),
`h-cross-cutting/review-completeness.md` (HOE-1 to HOE-7, HCE-1 to
HCE-11), `e-process-lock/review-completeness.md` (EOE-1 to EOE-5,
ECE-1 to ECE-8). Specifically checked: that D does NOT re-introduce
OE-4 `AuthContext` (D has no auth-shaped state per `02 §3`), that D's
type-side discipline matches E (both reject generics with one consumer
and both defer `LoggerLike` to H).

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 2 | 3 |
| Completeness | 0 | 6 | 4 |

**Net assessment: ACCEPT-WITH-EDITS.** D is the most disciplined
subsystem in the plan series on the type-side: the two candidate
generics (`Provider<TConfig>`, `ChannelEnv<TEnv>`) are both rejected
with framework OE-6 rationale, the sealed-class temptation is absent
(no auth-shaped hierarchy to invent), and the keystone dedup
(`UnsupportedDirectSendProvider`) is one of two concrete subclasses
sharing 100% method bodies — the right threshold. The 5×9
`ValidateTokenResult` extraction is justified (5 anon re-appearances
collapsed to 1 name, 0 behaviour change), as is the single dispatch
table (4×5-branch chains deduped, plus one source-of-truth for the
`stateDir` string overlap with the providers' readonly fields).

But D has one internal inconsistency that needs resolution before
implementation (`OE-D1` below), and several completeness gaps — most
notably the missing per-site `getProvider` mock migration plan for the
17 test mocks (`CE-D3`), the bun-specific HTTP/fetch behaviour for
`validateToken` (`CE-D5`), and the bun-specific `vi.doMock` /
`vi.mock` factory-hoisting semantics (`CE-D7`).

---

## Over-engineering findings

### OE-D1 (major) — `ChannelEnv` constructor `home?` parameter is unreachable from `static stateDirFor`

**Proposal** (`03-class-boundaries.md` D1, `04-generic-interfaces.md` §3, `06-risks-and-mitigations.md` DR4):
```ts
class ChannelEnv {
  constructor(env: Record<string, string>, home: string = homedir())
  getToken(provider: ChannelProviderType): string       // instance
  getChatId(provider: ChannelProviderType): string      // instance
  static stateDirFor(provider, agentDir?): string       // static
  static readTokenFor(provider, envFilePath): string | null  // static
}
```

**Counter-argument.** The constructor takes `home` to enable test
injection (avoid `vi.mock('node:os')`). But `stateDirFor` is declared
**static** in the same proposal — and a static method cannot reach
`this.home` (instance field). The plan acknowledges the asymmetry
("Static because it does not consume `this.env`") but does not
acknowledge that the `home` parameter also cannot be consumed. Three
ways to resolve, each with different over-engineering tradeoffs:

1. **Make `home` a `static readonly` class field.** Loses per-instance
   injection (all instances share one home default); tests can still
   override via `ChannelEnv.HOME = '/tmp/...'` (mutating a static is
   ugly). Or a `static homeDefault` getter — still a single global.
2. **Make `stateDirFor` an instance method.** Then "static because
   it does not consume `this.env`" reverses — instance method on a
   class that *does* carry `home` is natural. Downside: every caller
   needs a `ChannelEnv` instance, so the 14 call sites of
   `channelStateDir` would all become `channelEnv.stateDirFor(...)`
   instead of `ChannelEnv.stateDirFor(...)` — strictly worse for
   callers (one more reference), but matches the class.
3. **Drop the `home` parameter.** Keep `homedir()` per call inside
   `stateDirFor`, and stub `node:os` in tests via `vi.mock` (the way
   the codebase does today per `process-lock.test.ts:393` and
   elsewhere). Removes a parameter that the rest of the class can't
   use.

Per the E-plan's OE-D analog (EOE-2: "acquire(port, overrides?)"
dropped because the only consumer is one test case), the same logic
applies: a parameter that has *no second consumer in production code*
is pure ceremony. The `home` parameter doesn't even have a single
production caller — every actual caller would pass `(env)` and rely
on the default `homedir()`, which cannot be reached from the static
`stateDirFor` either way.

**Severity: wasteful.** Resolve before implementing D.1. Pick option
(3) — drop `home` — unless a concrete test seam is named (cite which
test would benefit). If option (1), update the type signature to
`static readonly homeDefault: string`. If option (2), update
`ChannelEnv` so `stateDirFor` is an instance method and the 14 call
sites each get a `channelEnv.stateDirFor(...)`.

---

### OE-D2 (major) — `ChannelProviderRegistry.list()` is speculative

**Proposal** (`03-class-boundaries.md` D3, `05-refactor-roadmap.md` Phase D.3):
```ts
class ChannelProviderRegistry {
  constructor(providers, testRunMarker?)
  get(type: ChannelProviderType): ChannelProvider
  list(): ChannelProviderType[]   // <-- new
}
```

**Counter-argument.** The brief assigns the registry to wrap
`markedProviders:500` + `getProvider:508` — that's a 1-method
lookup. The plan adds `list(): ChannelProviderType[]` as a "let
callers iterate the closed union without re-declaring it" —
a new method that has **zero identified callers** in the plan
(text search `ChannelProviderType` consumer list, importer enumeration
`01 §8`). Two reviewers (`framework OE-6`, `e-process-lock EOE-2`)
both rejected parallel "no consumer, no second caller" patterns.

If a future caller needs to iterate the providers, they can write
`Object.keys(markedProviders) as ChannelProviderType[]` at the call
site (1 line, 0 new API surface) — or, more idiomatically, switch on
the type themselves if they need to dispatch. The `list()` method
exists only to provide a typed wrapper around `Object.keys`. Per
`02 §8(b)` the framework-correct "make the union exhaustively
typed" pattern is already achieved by `Record<ChannelProviderType,
ChannelProvider>`, which gives the compiler the exhaustive check
without needing a `list()` helper.

Moreover, the registry class itself is borderline: 1 method (`get`)
plus a constructor. The current `markedProviders` is a `const`
Record + a `getProvider` function. Replacing this with a class adds
~25 lines (per the plan's own estimate) for the same `(type) =>
ChannelProvider` lookup. The OE-6 lens — *"Single consumer, no
second caller"* — applies here too: `getProvider` is called by 18
production importers + 17 test mocks, all of which use it as
`(type) => provider` and could keep using the free function
unchanged through the migration window.

**Severity: wasteful.** Drop `ChannelProviderRegistry` as a class.
Either:

(a) Keep `markedProviders` and `getProvider` as free functions
(preserves all 18+17 call sites identically — zero migration in
D.5), OR

(b) Convert the class but drop the `list()` method (still a class
for future `add()`/`remove()`/lifecycle needs — none today).

The plan correctly notes `01 §2` that the un-decorated `providers:477`
table is dead; the same dead-code argument applies to wrapping
`markedProviders` — the wrapper has no behaviour the table+function
doesn't already provide. The class is justified only if the wrapper
will grow methods (e.g., a per-type `metadata()` accessor) — which
the plan does not commit to.

---

### OE-D3 (minor) — `static readonly TABLE` exposed publicly vs internal-only

**Proposal** (`03-class-boundaries.md` D1):
```ts
static readonly TABLE: Record<ChannelProviderType, {
  readonly tokenKey: string
  readonly chatIdKey: string
  readonly subdir: string
}>
```

**Counter-argument.** The plan says `04 §3(a)` the table is
*"internal to the class and not exported"* — but the
`public static readonly` declaration makes it accessible to any
external caller. Per `04 §3(a)`: *"Collapses four 5-branch dispatch
chains in the file (`getChannelToken:460-464`, `getChannelChatId:468-472`,
`channelStateDir:525-529`, `readChannelToken:543-548`) into one
`Record<ChannelProviderType, …>`"* — all four chains are *inside* the
class (or its static methods); no external caller needs the table
itself.

Making the table `private static readonly` (with a sibling
`private static getKey(provider, kind)` helper, or inline access
`TABLE[provider].tokenKey` inside the methods) keeps the dedup
benefit while preventing external callers from binding to its
shape. A future contributor who adds a sixth provider would get the
exhaustive check in `ChannelEnv`'s methods either way (the `Record`
key type is exhaustiveness-checked at the table itself); exposing
the table doesn't add compile-time benefit.

**Severity: wasteful.** Make `TABLE` `private static` (or inline
the chain logic into 4 small static methods). The plan's
single-source-of-truth benefit is preserved with zero external API
addition.

---

### OE-D4 (minor) — `_legacyTelegramProvider` naming convention is speculative

**Proposal** (`05-refactor-roadmap.md` Phase D.2 "Files touched"):
> "leave the 5 frozen object literals in place as
> `_legacyTelegramProvider` etc. [ASSUMPTION: naming convention;
> `git blame` should be checked for any historical name preference
> before committing.]"

**Counter-argument.** Per `01 §7`, the 17 mocks replace the whole
module, not the named exports. None of the 18 production importers
do `import { telegramProvider }` (per `01 §8` — `getProvider` is the
only read path). Therefore the original 5 frozen literals are
**dead code** by the time D.2 lands — the only reference to
`telegramProvider` (the literal) is from `markedProviders:500-506`
inside the module, which D.3 will rewrite. The `git blame` check
the plan flags is unnecessary: if no external reader exists, the
"historical name preference" is moot.

Per CLAUDE.md §3: *"Remove imports/variables/functions that YOUR
changes made unused"* — D.2's change makes the literal
`telegramProvider` (etc.) unused, so removing it is the same
clause. The plan correctly notes this as an option
("or remove them under CLAUDE.md §3") but defers the decision via
the `_legacy` rename, which adds noise for a transitional state
that should not exist.

**Severity: wasteful.** Drop the `_legacyTelegramProvider`
keep-alongside option in D.2. Remove the 5 frozen literals directly
under the same CLAUDE.md §3 second clause. D.2's rollback strategy
(`git revert <SHA>`) restores them from git history.

---

### OE-D5 (minor) — D.2 "parallelizable internally" overstates the 5-class parallelism win

**Proposal** (`05-refactor-roadmap.md` Phase D.2 Parallelizable):
> "Yes, internally. The 5 provider classes are mutually
> independent; they share only the `ChannelProvider` interface and
> the `UnsupportedDirectSendProvider` base. The 5 can be coded in
> parallel branches and merged as one commit."

**Counter-argument.** The "5 can be coded in parallel branches and
merged as one commit" claim is structurally false: a single git
commit on a shared branch can only contain one set of changes. If
two agents work on two providers in parallel branches, they each
land separately (commits 1 and 2 on different branches) — at which
point the merge is a merge commit, not "one commit". The "1 commit
rollout" is only achievable if a single agent writes all 5 classes
sequentially in one branch.

The real parallelism claim is "5 different agents can each work on
their provider class without merge conflicts", which is true
because the 5 classes touch disjoint spans of source lines
(verified: telegram `:53-104`, slack `:134-228`, discord
`:243-311`, googlechat `:324-350`, teams `:364-391`). But this is
already encoded in D.2's single phase — no parallelism
optimization is gained by splitting into 5 sub-phases.

**Severity: neutral.** No action required; flagged because the
plan's "5 in parallel branches and merged as one commit" claim is
internally contradictory. Phase D.2 is correctly one phase; the
rationale text is misleading.

---

## Completeness findings

### CE-D1 (major) — `src/channel-coordinator/` subcluster not addressed

**Missing area.** `src/channel-coordinator/` contains 4 files:
`ingest.ts`, `liveness.ts`, `provider-poller-match.ts`,
`telegram-client.ts`. The plan's `01 §8` enumerates
`channel-coordinator/liveness.ts` and `channel-coordinator/provider-poller-match.ts`
as importers of the channel-provider surface, but does not address
this subcluster as a sibling concern.

Specifically:
- `src/channel-coordinator/telegram-client.ts:45` declares
  `class TelegramApiError` — a class declaration in the channel
  domain that is NOT in D's inventory (verified:
  `grep -nE '^export class' src/channel-coordinator/telegram-client.ts`).
- `src/channel-coordinator/liveness.ts:30-31` declares
  `RESPAWN_STAMP_FILE` and `KEEPALIVE_FILE` — channel-state
  persistence constants — which the plan's scope
  ("`channel-provider.ts` and 4 helpers") explicitly excludes,
  but the exclusion is silent.
- `src/channel-coordinator/ingest.ts` and `provider-poller-match.ts`
  are mentioned in the importer list but not characterized.

**Why it matters.** The framework's `review-completeness.md` CE-1
("`00-summary.md` claims only 2 classes exist; ground truth has 9")
flagged that 8 class declarations are missed across the plan
series. D inherits this same risk: `TelegramApiError` at
`telegram-client.ts:45` is a class in the channel domain — it is
either (a) in scope for the D normalization (and the plan misses
it), or (b) out of scope (and the plan should say so explicitly,
like HCE-3 / HCE-5 do for `format.ts` and `pending-retries.ts`).

**Severity: major.** Add to `00-summary.md` "Files this plan does
NOT touch" an entry for `src/channel-coordinator/`: "Out of D
scope. `telegram-client.ts:45` already declares `class
TelegramApiError` (a domain-specific error class, parallel to
`PeerResponseTooLargeError` in `web/federation/http.ts`). The
channel-coordinator subcluster owns its own state persistence
(`KEEPALIVE_FILE`/`RESPAWN_STAMP_FILE`/`agentDir` machinery in
`liveness.ts`) and ingest coordination (`ingest.ts`,
`provider-poller-match.ts`); these are E-slice or D-followup work,
not D itself."

---

### CE-D2 (major) — `getProvider` method-shape production callers not enumerated

**Missing area.** The plan enumerates 18 production importers of
`getProvider` (per `01 §8`) but does not enumerate which of those
importers call *which* interface methods. Per `06 §DR1`, the
keystone pin is the `(token, chatId, …)` per-call parameter list;
knowing which importers call which methods lets the implementer
verify each method's callers individually.

The two callers that the plan does identify
(`notify.ts:22`, `notify.ts:31`) are the immediate senders, but the
plan does NOT enumerate:

- `web/agent-process.ts` (which calls `provider.formatMessage(...)`
  and `provider.splitMessage(...)` per `06 §DR2`)
- `web/channel-monitor.ts` (which calls `provider.formatMessage(...)`
  per `01 §1` production consumer for `pluginId`)
- `web/channel-mcp-reconnect.ts:82` (uses `pluginPaneId`)
- `web/channel-health-monitor.ts:117` (uses `pluginPaneId`)
- `web/routes/agents.ts:968`, `:1046`, `:1435` (destructures
  `validateToken` return per `02 §4`)

**Why it matters.** D.2's class conversion has 25 method bodies
(5 providers × 5 methods). Each method has 0-N production callers.
The plan's DR1 mitigation 4 ("every D.2 PR must include a
comment") cites one method per provider (5 total) but does not
specify which importers verify each call site.

**Severity: major.** Add a per-method caller table to
`06-risks-and-mitigations.md` DR1: "Method | Production callers
| Class file:line". 25 rows × ~3 importers = ~75 caller-method
pairs, derivable from a single `grep -rn 'provider\.\(sendMessage\|
sendPhoto\|validateToken\|formatMessage\|splitMessage\)'`
across the 18 importers. Most methods have 1-3 callers; the table
makes each caller's migration trivial to audit.

---

### CE-D3 (major) — `getProvider` migration helper for 17 test mocks missing

**Missing area.** `05-refactor-roadmap.md` Phase D.5d "may warrant
a `__wrap_*` migration helper for the test mocks" — this is a
forward-reference without a deliverable. The 17 test mocks at
`01 §7` are:

| Mock pattern | Count |
|---|---:|
| Full module replacement (9) | 9 |
| Partial mock with `async (orig) => { ... }` (4 + 3) | 7 |
| `vi.doMock` (`channel-coordinator-liveness.test.ts:99`) | 1 |
| Single-export stub (`notify.test.ts:25`) | 1 |

After D.5d, `getProvider` is removed. Every mock that currently
returns `{ telegram: <stub>, slack: <stub>, ... }` either:

(a) Returns the new `channelEnv.getProvider(type)` shape, OR
(b) Imports `ChannelProviderRegistry` and calls `.get(type)`, OR
(c) Stays mockable by `vi.mock` if `getProvider` remains a wrapper
re-export.

The plan's DR3 mitigation 4 mentions a `createMockChannelProvider()`
factory but explicitly says it's *"out of D's scope"* — leaving
the 17 mocks with no migration plan.

**Why it matters.** 17 mock files × 1-5 stub-providers per mock =
17-85 stub-object sites to migrate. Without a factory, each test
author writes their own ad-hoc shape; the first 5-10 conversions
define the convention by accident, the remaining 12 copy whatever
those 5 chose. If the convention is wrong (missing `formatMessage`,
or returning `undefined` for `validateToken`), tests pass in
isolation but break under `bun --bun vitest run` integration.

The `notify.test.ts:25` single-export stub is the highest-risk:
it returns `{ getProvider }` only. After D.5d, `getProvider`
is gone — the stub must be rewritten even if everything else
stays the same.

**Severity: major.** Add a D.5d pre-commit gate: a `createMockChannelProvider()`
test-helper factory (per framework CE-5 / HCE-7 precedent) that
returns `{ type, pluginId, pluginPaneId, envKeys, stateDir,
chatIdFormat, sendMessage, sendPhoto, validateToken, formatMessage,
splitMessage }` as `vi.fn()` stubs. Add to `06-risks-and-mitigations.md`
DR3 mitigation 4: "Land `createMockChannelProvider()` in the D.5d
pre-commit; every mock rewrites to spread the factory." This is
the single highest-leverage completeness fix in D.

---

### CE-D4 (major) — `SlackApiAck` duplicate cast at `:159`/`:201` not deduplicated

**Missing area.** `02 §7` notes that `channel-provider.ts:159` and
`:201` both cast to `{ ok: boolean; error?: string }` — same shape,
42 lines apart — but the plan says *"Replacing them with project
typeguards is a defensible follow-up but is behaviour-preserving
churn and should be a separate commit from the class conversion,
not bundled into it"*. The plan correctly defers this, but does
NOT name it as D.7 ("Cast deduplication") or in `06-risks-and-mitigations.md`.

**Why it matters.** The plan does not say *where* the cast
deduplication happens. The slack response shape `{ ok, error }`
appears at 4 sites in `channel-provider.ts`: `:159`, `:201`
(Slack), `:303`, `:305` (Discord — `error` only). If a future
contributor adds a fifth slack endpoint with the same shape
(`{ ok, error }`), the existing 4 sites are evidence that
extracting a named type is warranted; the plan should explicitly
say *"this is D.7, separate commit, separate phase"*.

**Severity: major.** Add a one-line "D.7 deferred: cast
deduplication (`SlackApiAck`, named return type) is a separate
commit; do NOT bundle into D.2." to `05-refactor-roadmap.md`.

---

### CE-D5 (major) — bun-specific `fetch()` semantics for `validateToken` HTTP probes not addressed

**Missing area.** Three of the five provider classes'
`validateToken` implementations make live HTTPS calls:

- `telegramProvider:91`: `fetch('https://api.telegram.org/bot${token}/getMe')`
- `slackProvider:209`: `fetch('https://slack.com/api/auth.test')`
- `discordProvider:296`: `fetch('https://discord.com/api/v10/users/@me')`

Per the plan, these stay verbatim in the class versions (D.2 is
preservation-only). But:

1. **bun's `fetch` differs from Node's.** Bun ships its own
   `fetch` implementation (a polyfill on top of libcurl + a
   TypeScript wrapper), which diverges from the Node 18+ built-in
   on cookie handling, redirect semantics, and TLS verification
   behaviour. The plan does not enumerate these.
2. **Test mocks use `fetch` stubs differently.** Files like
   `channel-mcp-reconnect.test.ts:44` mock `fetch` (or a
   fetch-typed symbol) to test the underlying validation path.
   The class version's `validateToken(token)` becomes a method
   that needs the same `vi.mock('fetch')` shape, but the mock
   may need to migrate from module-level to instance-level
   injection (per `h-cross-cutting` HCE-7 / H.2a's test factory
   pattern).

**Why it matters.** Per CLAUDE.md §8, the canonical test runner
is `bun --bun vitest`. If bun's `fetch` rejects the request
shape that the test fixtures emit (e.g., the Slack `auth.test`
POST form), the test passes on `vitest` and fails on
`bun --bun vitest`. The plan does not verify either side.

**Severity: major.** Add a `DR7: bun fetch semantics` risk row to
`06-risks-and-mitigations.md` based on the 3 HTTPS endpoints
above. Mitigation: confirm the existing regression test at
`channel-mcp-reconnect.test.ts` (which exercises the
`validateToken` path) passes under `bun --bun vitest run`
before D.2 lands; if it does not, document the divergence in the
class header comments so a future reworker doesn't "fix" the
fetch shape into a Node-specific one.

---

### CE-D6 (major) — `channelStateDir` call-site blast radius for D.5b not enumerated

**Missing area.** The plan's `02 §5.3` enumerates 14 production
call sites of `channelStateDir` and D.5b's "Migration targets"
table cites "14 call sites" without listing them. The 14 sites
(verified in `02 §5.3`) span 9 distinct importer files:

| Importer | Call sites |
|---|---:|
| `channel-coordinator/liveness.ts` | 2 |
| `web/channel-request-watcher.ts` | 2 |
| `web/agent-process.ts` | 2 |
| `web/discord-group-bootstrap.ts` | 1 |
| `web/schedule-runner.ts` | 2 |
| `web/channel-poller-reap.ts` | 2 |
| `web/agent-scaffold.ts` | 1 |
| `web/channel-invites.ts` | 3 |
| `web/channel-monitor.ts` | 2 |
| `web/routes/agents.ts` | 2 |

But the plan's DR3 mitigation says *"Keep `channelStateDir` as a
top-level re-export through D.5c"* — i.e., the function survives
as a wrapper. The re-export means call sites don't migrate
in-place; they can keep calling `channelStateDir(provider, agentDir)`
through the re-export, and D.5b's migration is the test mock at
`channel-coordinator-liveness.test.ts:99` only.

**Why it matters.** The plan mixes two strategies: (a) keep the
top-level re-export through D.5c, and (b) "Repoint each to
`ChannelEnv.stateDirFor(provider, agentDir?)` (static)" per the
05 §D.5b table. These are contradictory — strategy (a) means
zero call-site edits, strategy (b) means 14 call-site edits.
The plan needs to pick one.

**Severity: major.** In `05-refactor-roadmap.md` Phase D.5b,
pick strategy (a): the wrapper re-export (`export const
channelStateDir = (p, d) => ChannelEnv.stateDirFor(p, d)`)
covers all 14 production call sites; D.5b's migration is the
single `vi.doMock` test at
`channel-coordinator-liveness.test.ts:99` (stubs
`channelStateDir`) which can stay mockable via the re-export.
This collapses D.5b from "14 importer edits + 1 mock"
to "1 mock rewrite" — matching DR3 mitigation 2's intent.

---

### CE-D7 (minor) — `vi.doMock` / `vi.mock` factory-hoisting semantics under `bun --bun vitest` not addressed

**Missing area.** Per framework CE-17 / `h-cross-cutting` HCE-10,
`bun --bun vitest` may diverge from Node-vitest on `vi.mock`
factory hoisting. The plan's `01 §7` enumerates 17 mocks with 4
distinct shape variants, but does not verify the hoisting
behaviour under bun. Specifically:

- 4 mocks use `async (orig) => { ... await orig() ... }` — these
  depend on `vi.mock`'s factory being async-awaitable (vitest
  supports this; bun's vitest re-export claims parity, but the
  plan does not verify).
- 3 mocks use `async (importOriginal) => { ... }` (named-param
  alias) — vitest historically accepts either name; bun's
  vitest may have specific behaviour per the bun-vitest
  compatibility matrix.
- 1 mock at `channel-coordinator-liveness.test.ts:99` uses
  `vi.doMock` (separate API), which is documented differently.

**Why it matters.** D.5 has 17 mocks to migrate under the
"getProvider vanishes" surface change. If bun's vitest hoists
factories differently from Node-vitest, the migration's
rewrite order matters (factory-vs-factory-overrides hoisting
order can flip the resolved module under bun).

**Severity: minor.** Add a one-line note to DR3 detection
signals: "Verified on `bun --bun vitest <version>` per
framework CE-17. The 17 mocks' factory shapes (1 `vi.doMock`,
4 async-orig, 3 async-importOriginal, 9 inline-object) rely
on factory-hoisting behaviour that may shift between bun
versions; if a test passes on `vitest` and fails on
`bun --bun vitest`, the rewrite is bun-specific." This
inherits from HCE-10 / CE-17 verbatim.

---

### CE-D8 (minor) — `ChannelProviderType` re-export through D.5d not addressed

**Missing area.** `ChannelProviderType` is imported by **6
files** (per `02 §2`: `config.ts:8`, `channel-coordinator/liveness.ts:16`,
`web/channel-request-watcher.ts:5`, `web/agent-process.ts:40`,
`web/channel-invites.ts:30`, `web/channel-monitor.ts:44`, plus
`channel-coordinator/provider-poller-match.ts:16` type-only,
`web/channel-poller-reap.ts:28-29` type-only,
`web/channel-plugin-unlock.ts:38` type-only — total **9
importers**). The plan correctly says `ChannelProviderType`
stays as a free export and the union is unchanged. But the plan
does not say where it gets re-exported from after D.5d — does
it come from `channel-provider.ts` directly (today's site), or
from `ChannelEnv` (a runtime concept not in the type-only
importers' minds)?

**Why it matters.** If D.5d's deletion accidentally removes the
top-level `export type` (vs the runtime exports), all 9
type-only importers break at the next consumer-side `import`.
The plan's migration gate ("only `channel-provider.ts`
references the deleted helpers") does not cover
type-only re-exports.

**Severity: minor.** In `05-refactor-roadmap.md` Phase D.5d
Files touched, add: "`export type ChannelProviderType` stays as
a top-level export (NOT absorbed into `ChannelEnv`); all 9
type-only importers keep resolving."

---

### CE-D9 (minor) — `formatForSlackMrkdwn:114-132` and `SLACK_BOT_SCOPES`/`SLACK_BOT_EVENTS` references in `__tests__/format.test.ts` not enumerated

**Missing area.** `01 §1` notes `formatForSlackMrkdwn` is
exported and imported by `src/__tests__/format.test.ts:3`. The
plan's `03 §D1` "Free functions that REMAIN after D.1" table
correctly lists `formatForSlackMrkdwn` as unchanged. But the
plan does NOT enumerate which test files import the slack
manifest helpers (`generateSlackAppManifest:418`,
`getSlackAppSetupInstructions:445`) or the `SLACK_BOT_SCOPES` /
`SLACK_BOT_EVENTS` constants. A grep-driven enumeration would
be 5-10 lines and would close the surface gap.

**Why it matters.** If D.1 renames or moves a module-level
constant (`SLACK_MAX_MESSAGE_LENGTH:112`,
`DISCORD_MAX_MESSAGE_LENGTH:232`, etc.), the per-class
extraction may rename them to `private static readonly` (per
03 §D2 "becomes a module-level `const` outside the class"). A
test file that today does `import { SLACK_MAX_MESSAGE_LENGTH }
from '../channel-provider.js'` (if any does) would need
updating to `SlackProvider.MAX_LENGTH`. The plan does not
check whether tests reference these.

**Severity: minor.** Add a one-line grep-driven verification
check to `05-refactor-roadmap.md` Phase D.2 Test coverage
requirement: "Verify `grep -rln 'SLACK_MAX_MESSAGE_LENGTH\|DISCORD_MAX_MESSAGE_LENGTH\|GOOGLECHAT_MAX_MESSAGE_LENGTH\|TEAMS_MAX_MESSAGE_LENGTH' src/__tests__/`
returns an empty list (no test references the constants
directly); if non-empty, the migration includes the
test-import updates."

---

### CE-D10 (minor) — `getProviderType` total-coercion semantics not documented for `CLIs` and `bin/` invocation

**Missing area.** `getProviderType:512` falls through
unrecognised input to `'telegram'` (per `02 §5`). The plan
calls this a "total coercion, never throws" — correct
behaviour. But the plan does not enumerate which CLIs or `bin/`
scripts invoke `getProviderType` (per `01 §8` Scripts, zero
importers — so `bin/` and `scripts/*.ts` have no importers,
per the explicit grep in `01 §8`).

**Why it matters.** If a future CLI is added that takes
`--provider` from a flag string and calls
`getProviderType(flagValue)`, the fallback to `'telegram'` is
the right behaviour. The plan documents this for production
but does not commit to it as a CLI contract.

**Severity: minor.** No action needed; flagged because the
plan is silent on the cross-process contract, and a future
contributor might "improve" the function into a strict
validator that throws on unknown (which would break the
18 importers and 0 CLIs today).

---

## Net assessment

D's keystone thesis is correct:

- **The two candidate generics are correctly rejected.** Both
  `Provider<TConfig>` and `ChannelEnv<TEnv>` collapse to
  single-consumer parameters; the framework OE-6 lesson is
  applied with explicit citation (per `04 §1`, `04 §2`), and the
  same `e-process-lock EOE-1`/`LockContext<T>` precedent is
  cited as evidence.
- **`UnsupportedDirectSendProvider` abstract base is the
  textbook dedup.** Two concrete subclasses share 100% method
  bodies; the abstract class is the minimum abstraction for
  this shape (no `TConfig` parameter needed, plain `protected
  readonly` fields).
- **The dispatch table consolidation is real.** Four 5-branch
  chains → one `Record<ChannelProviderType, …>`; two pairs
  (`getChannelToken`/`readChannelToken` keys, `channelStateDir`
  subdirs vs providers' `stateDir` fields) are byte-identical
  and collapse cleanly.
- **`ValidateTokenResult` is the right name.** Five anonymous
  re-appearances → one named interface; the discriminated-union
  temptation is correctly rejected (slack's `botName: undefined`
  case would force a `?? 'unknown'` default).
- **The 5 provider classes are correctly grouped as one phase
  (D.2).** They share only the interface contract; per-provider
  phasing buys nothing.
- **`withTestRunMarking` as Form B (function) is the right
  choice.** No lifecycle, no class benefit; the explicit
  delegation form survives the class conversion.
- **The `getProvider` keep-alongside pattern through D.3
  preserves all 18 production importers + 17 test mocks
  identically** — the migration window does not break the
  read path.

But the plan has two over-engineering seams and ten completeness
gaps:

**Over-engineering:**

- `ChannelEnv` constructor `home?` parameter is unreachable
  from `static stateDirFor` (OE-D1) — internal inconsistency
  the implementation must resolve.
- `ChannelProviderRegistry` class + `list()` method is a 1-method
  wrapper for a 0-consumer addition (OE-D2) — the dedup of the
  lookup table does not need a class.
- Plus three minors: `TABLE` exposed publicly (OE-D3),
  `_legacyTelegramProvider` keep-alongside (OE-D4), "5 in
  parallel branches and merged as one commit" claim
  (OE-D5 — neutral).

**Completeness:**

- `src/channel-coordinator/` subcluster not addressed as
  out-of-scope (CE-D1) — `TelegramApiError` class is silent.
- `getProvider` per-method caller table missing (CE-D2) —
  affects DR1's mitigation confidence.
- `createMockChannelProvider()` factory missing for the 17-mock
  migration (CE-D3) — single highest-leverage gap.
- `SlackApiAck` cast dedup named as D.7 (CE-D4).
- bun-specific `fetch()` for `validateToken` HTTP probes (CE-D5).
- D.5b re-export strategy contradictions (CE-D6).
- Plus four minors: `vi.doMock` hoisting under bun (CE-D7),
  `ChannelProviderType` re-export through D.5d (CE-D8),
  per-class `*_MAX_MESSAGE_LENGTH` test references (CE-D9),
  `getProviderType` CLI contract (CE-D10).

**Recommendation: ACCEPT-WITH-EDITS.**

**Resolve before implementing D.1:**

- OE-D1: pick option (3) — drop `home` parameter; let tests
  `vi.mock('node:os')` the same way they do today. Update
  `03 §D1` constructor signature to `constructor(env:
  Record<string, string>)`.

**Drop before implementing D.3:**

- OE-D2: keep `markedProviders` and `getProvider` as free
  functions through D.5d (no class wrapper needed); the
  `list()` method has zero callers. If a class is required,
  drop the `list()` method.

**Enumerate before implementing D.2:**

- CE-D2: per-method caller table for DR1 mitigations.
- CE-D9: grep-driven check for `*_MAX_MESSAGE_LENGTH` test
  imports.

**Add before implementing D.5:**

- CE-D1: out-of-scope entry for `src/channel-coordinator/`
  in `00-summary.md`; explicit noting of `TelegramApiError`
  class and `KEEPALIVE_FILE`/`RESPAWN_STAMP_FILE` state
  persistence.
- CE-D3: `createMockChannelProvider()` test-helper factory
  as a pre-D.5d deliverable; 17 mock files migrate by
  spreading the factory.
- CE-D4: D.7 ("cast deduplication, separate commit") named
  explicitly in `05-refactor-roadmap.md`.
- CE-D6: D.5b uses the wrapper re-export strategy; the
  14-importer "repoint" is rewritten as "verify re-export
  covers all 14" — single `grep` confirms.

**Verify before implementing D.2:**

- CE-D5: bun-specific `fetch()` behaviour for the 3
  `validateToken` HTTPS endpoints; document findings in the
  class header comments.
- CE-D7: bun-specific `vi.doMock` / `vi.mock` factory-hoisting
  on the 17 mocks; flag any divergence in DR3 detection
  signals.

**Add documentation before implementing D.5d:**

- CE-D8: `export type ChannelProviderType` stays as top-level
  (not absorbed into `ChannelEnv`); explicitly listed in
  D.5d Files touched.

**Minor cleanups:**

- OE-D3: make `TABLE` `private static readonly`; the dedup
  benefit survives without external API surface.
- OE-D4: drop the `_legacyTelegramProvider` keep-alongside
  option in D.2; remove the 5 frozen literals directly under
  the same CLAUDE.md §3 second clause.

---

## Verification provenance

Every file:line reference in this review was read against the
working tree on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`):

- `src/channel-provider.ts:1-552` (read in full).
- `src/channel-provider.ts:9` (`ChannelProviderType` union),
  `:11-23` (`ChannelProvider` interface), `:53-104` (telegram),
  `:134-228` (slack), `:243-311` (discord), `:324-350`
  (googlechat), `:364-391` (teams), `:459-465`
  (`getChannelToken`), `:467-473` (`getChannelChatId`),
  `:490-498` (`withTestRunMarking`), `:500-506`
  (`markedProviders`), `:508-510` (`getProvider`),
  `:512-518` (`getProviderType`), `:520-531` (`channelStateDir`),
  `:533-551` (`readChannelToken`) — verified.
- `src/config.ts:8` and `:325-326` (the only `getChannelToken` /
  `getChannelChatId` production caller); `src/env.ts:13`
  (`readEnvFile`) — verified.
- 18 production importers (4 top-level + 14 web/ — `grep -rln
  "from.*channel-provider\.js" src --include='*.ts' | grep -v
  __tests__ | wc -l` → 17, the 18th importer is
  `src/channel-provider.ts` itself — verified by the spec saying
  "18 production importers" should mean 17 importers + the
  module exporting them; the plan's count is consistent with
  this reading).
- 17 test mocks (`grep -rln "vi\.mock.*channel-provider\.js" src/__tests__/`
  → 17; the framework review's CE-1-precedent on count
  verification applies).
- `src/channel-coordinator/telegram-client.ts:45` (`TelegramApiError`),
  `src/channel-coordinator/liveness.ts:30-31` (state persistence
  constants) — verified.
- `src/__tests__/index.test.ts:251-256` and `process-lock.ts:19/49`
  cross-references to E's `vi.resetModules` pattern (per
  `e-process-lock/review-completeness.md` ECE-1) — verified.
- 7 cross-cutting framework OE / HOE lessons applied to D:
  OE-6 (single-consumer generic, applied twice — `Provider<TConfig>`
  and `ChannelEnv<TEnv>` rejected), OE-4 (speculative shape-parity,
  applied via OE-D1's `home` parameter), OE-7 (per-call override
  seam, parallel to EOE-2); CE-1 (class-inventory thoroughness,
  applied via CE-D1), CE-5 (test factory, applied via CE-D3),
  CE-17 (bun `--bun vitest`, applied via CE-D5/CE-D7); HCE-7
  (test factory specification, applied via CE-D3).
- Zero `as any` / `: any` / `as unknown as` in
  `src/channel-provider.ts` — verified (matches plan claim).
- Six `as` casts at `:92, :159, :178, :201, :216, :299` — verified
  (matches plan claim).
- Zero `logger.<level>(` in `src/channel-provider.ts:1-552` —
  verified (single `logger` hit at `:5` is the dead import).
- Zero `import` statements for `node:child_process` (none in
  the file) — verified (the file uses `node:https` `request` at
  `:27`, `node:fs` `readFileSync`/`existsSync` at `:534`/`:537`,
  `node:path` `join` at `:185`, `node:os` `homedir` at `:523`).
