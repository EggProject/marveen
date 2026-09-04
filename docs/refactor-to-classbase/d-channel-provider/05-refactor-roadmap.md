# D (channel-provider) — Refactor roadmap

Ordered phases for the D subsystem. Each phase: goal, files touched, risk
level, test coverage requirement, rollback strategy, parallelizable.
Cross-references `03-class-boundaries.md` (class shapes) and
`06-risks-and-mitigations.md` (DR1–DR6 risks).

The roadmap is intentionally narrower than the framework's
`00-summary.md` — D is the smallest subsystem by class count, so the
phases are tight and the rollback is per-phase not per-class.

---

## Dependency arrow

**As planned (pre-D.1):**
```
D.1  ChannelEnv class                  (additive; helpers survive as wrappers)
  |
  +---> D.2  5 XxxProvider classes     (additive; const literals survive)
  |       |
  |       +---> D.3  ChannelProviderRegistry  (additive; markedProviders survives)
  |
  +---> D.5  Helper removal             (gated on D.1 + consumer migration)
  |
  +---> D.4  withTestRunMarking migration  (depends on D.2 for class-form safety)
  |
  D.6  LoggerLike adoption              (depends on H.1; off the critical path)
```

**As landed (post-D.1, this commit):**
```
D.4  withTestRunMarking Form B         (LANDED — pre-D.1)
  |
  +---> D.2  5 XxxProvider classes     (LANDED — pre-D.1)
  |       |
  |       +---> D.3  ChannelProviderRegistry  (LANDED — pre-D.1)
  |
  D.1  ChannelEnv class + consumer migration + helper removal
       (LANDED — this commit; D.5 absorbed into D.1)
  |
  D.6  LoggerLike adoption              (DEFERRED — depends on H.1)
```

`D.6` is **off D's critical path** because `02 §10` confirms zero logger
call sites in `channel-provider.ts:1-622` (re-measured post-D.1).
D.6 only runs if H.1 forces the constructor-parameter shape on every
converted class; if H.1 lands after D.1, D.6 is a no-op for D.

**Phase D.5 status:** **REMOVED** — merged into D.1 (the helper removal
was a precondition for the clean class surface, so the consumer
migration and the helper deletion shipped together). The original D.5
plan (per-helper sub-phases D.5a–D.5d for blast-radius control) is
preserved below as historical planning reference; no D.5 commits exist.

---

## Phase D.1 — `ChannelEnv` class extraction

### Status

**LANDED (this commit).** `class ChannelEnv` introduced at
`src/channel-provider.ts:507`; 4 legacy free functions
(`getChannelToken`, `getChannelChatId`, `channelStateDir`,
`readChannelToken`) **deleted outright** (no thin-wrapper intermediates
shipped — the consumer-migration sweep over 42 call sites was a single
coordinated change, so wrappers would have been dead-on-arrival).
42 production call sites migrated across 12 files; 7 of 17 mock factories
updated to expose `ChannelEnv` as `vi.fn()`.

The original "thin-wrapper survival" plan is preserved below as the
design-intent reference; what actually shipped was the clean break
described above. `06-risks-and-mitigations.md` DR4 documents the
constructor-parameter decision (no `home?: string` in the landed form;
default `new ChannelEnv()` is sufficient because `stateDirFor` /
`readTokenFor` don't consume `this.env`).

### Goal (as landed)

Introduce `class ChannelEnv` in `src/channel-provider.ts` (line 507),
absorb the four top-level helpers (`ChannelEnv.getToken:522`,
`ChannelEnv.getChatId:526`, `ChannelEnv.stateDirFor:530`,
`ChannelEnv.readTokenFor:543`), and migrate all 42 production call
sites across 12 files. Convert the four 5-branch dispatch chains to a
single `static readonly TABLE` (`channel-provider.ts:508-517`).
**Delete** the four legacy helpers (no thin wrappers).

### Files touched (as landed)

| File | Change |
|---|---|
| `src/channel-provider.ts` | Add `class ChannelEnv` (~50 lines); add `static readonly TABLE`; **delete** the 4 legacy free functions and their bodies (~60 lines net); add 4 explanatory comment lines documenting the migration. |
| `src/config.ts:324-326` | Replace `getChannelToken` / `getChannelChatId` calls with `new ChannelEnv(env).getToken(p)` / `.getChatId(p)`. |
| `src/channel-coordinator/liveness.ts:193-194` + 11 other production importers | Replace `channelStateDir(...)` calls with `ChannelEnv.stateDirFor(...)`. |
| `src/web/agent-process.ts:839` + 4 other production importers | Replace `readChannelToken(...)` calls with `ChannelEnv.readTokenFor(...)`. |
| 7 of 17 test mocks | Update to expose `ChannelEnv` as `vi.fn()` (others unchanged because they only mock `getProvider`). |

### Public surface changes (as landed)

- New: `class ChannelEnv` with constructor `(env: Record<string, string> = {})`, instance methods `getToken(provider)`, `getChatId(provider)`, static methods `stateDirFor(provider, agentDir?)`, `readTokenFor(provider, envFilePath)`, `static readonly TABLE`.
- **Removed:** `getChannelToken`, `getChannelChatId`, `channelStateDir`, `readChannelToken` (4 legacy free exports; no wrappers).
- Unchanged: `ChannelProviderType`, `ChannelProvider`, `getProvider`, `getProviderType`, the 5 `XxxProvider` classes, the `ChannelProviderRegistry` class.

### Risk level (actual)

**Low.** The migration was coordinated and verified by 42 production
call sites + 7 mock factories. The `ChannelEnv` constructor defaults
`env = {}` so callers of the two statics (which don't consume `env`)
can use `new ChannelEnv()` without arguments; this preserves byte
compatibility with the legacy `channelStateDir(provider, agentDir?)` /
`readChannelToken(provider, envFilePath)` signatures.

### Test coverage requirement (as landed)

- **Per-existing-test:** all tests that previously exercised the 4
  legacy helpers now exercise the equivalent `ChannelEnv` methods.
- **New test:** `src/__tests__/channel-env.test.ts` exercises
  `ChannelEnv` directly: each method, each of the 5 provider types, the
  `TABLE` shape, and the `vacuous-test table` per the post-D.1
  review-finding format.
- **Mock factory updates:** 7 of 17 mocks rewritten to expose
  `ChannelEnv` as `vi.fn()`; 10 unchanged (they only mock `getProvider`,
  whose signature is preserved).

### Rollback strategy (as landed)

Single commit; `git revert <this commit>` restores the 4 free-function
bodies and removes `ChannelEnv`. The 42 production call-site edits and
7 mock updates are reverted alongside, leaving a working tree
byte-equivalent to pre-D.1.

### Parallelizable (as landed)

**Yes.** D.1 shares no source files with A, B, C, E, F (D's only
sibling is `src/process-lock.ts` for E, and they touch different
modules). D.1 can land in parallel with any other subsystem phase that
does not write to `src/channel-provider.ts`.

### Design-intent reference (NOT as shipped)

The original D.1 plan was "introduce `class ChannelEnv` **alongside**
the four top-level helpers, **keep** the four helpers as thin
wrappers so callers see no change." This was rejected at implementation
time because:

1. **Wrappers would be dead-on-arrival.** The consumer-migration sweep
   touched every importer; if the sweep ships in the same commit as the
   class extraction, the wrappers have zero callers on day one.
2. **Two-step coordination cost.** Splitting into "introduce class +
   wrappers, then migrate + delete wrappers" forces an intermediate
   commit where the codebase has both shapes simultaneously — a
   non-trivial review burden for what is mechanically one change.
3. **CLAUDE.md §2 (Simplicity First).** "No abstractions for single-use
   code" — a thin wrapper exists for exactly one intermediate commit.

What shipped instead: `class ChannelEnv` introduced, 4 helpers deleted,
42 callers + 7 mocks migrated, all in one commit. The
"single coordinated change" property is preserved by the test suite
(`bun --bun vitest run` green pre- and post-commit, per
`06-risks-and-mitigations.md` DR5).

---

## Phase D.2 — 5 provider class extractions

### Status

**LANDED** (preceding refactor, post-D.2 line shift +52 lines). The
line citations below use the **post-D.2 actual** numbers (re-measured
2026-09-04); the pre-D.2 numbers are preserved in parentheses where
useful for cross-referencing `01-module-state-analysis.md` and
`02-type-interface-analysis.md`, both of which still cite pre-D.2 lines.

### Goal

Convert the five frozen object literals (pre-D.2: `telegramProvider:53`,
`slackProvider:134`, `discordProvider:243`, `googlechatProvider:324`,
`teamsProvider:364`) into 5 classes (`TelegramProvider`, `SlackProvider`,
`DiscordProvider`, `GooglechatProvider`, `TeamsProvider`) plus the
`UnsupportedDirectSendProvider` abstract base for the googlechat/teams
pair. Per `review-correctness.md` C1, **method signatures are preserved
byte-for-byte**: `sendMessage(token, chatId, text, parseMode?)`,
`sendPhoto(token, chatId, photoPath, caption)`, `validateToken(token)`,
`formatMessage(text)`, `splitMessage(text)`. Token and chatId remain
per-call parameters.

**Post-D.2 actual line citations (2026-09-04 re-measurement):**
`telegramProvider:360`, `slackProvider:390`, `discordProvider:405`,
`googlechatProvider:418`, `teamsProvider:432` (each is now
`const xProvider: ChannelProvider = new XxxProvider()`).

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Added 6 new class declarations (`TelegramProvider`, `SlackProvider`, `DiscordProvider`, `UnsupportedDirectSendProvider`, `GooglechatProvider`, `TeamsProvider`); replaced the 5 frozen object literals with `new XxxProvider()` constructions. The old literals were removed (CLAUDE.md §3 — no external reader per `02 §1` zero production consumers). |
| `src/__tests__/channel-provider.test.ts:55-57` (read-only audit) | No changes required — no test reads `telegramProvider.envKeys` / `.stateDir` / `.chatIdFormat` directly on the instance; verified `02 §1` zero production consumers. |

### Public surface changes

- New: `class TelegramProvider`, `class SlackProvider`,
  `class DiscordProvider`, `class UnsupportedDirectSendProvider`,
  `class GooglechatProvider`, `class TeamsProvider`.
- Unchanged: `ChannelProvider` interface; the 5 readonly metadata
  fields; the 5 method signatures.

### Risk level (actual post-D.2)

**Medium → resolved by ordering.** Two structural concerns were
identified pre-D.2:

1. **The `withTestRunMarking` decorator spread drops prototype methods
   once providers become classes.** Pre-D.2 the spread at `:492` was
   safe because every member was an own property; post-D.2 it's not.
   **Resolution:** D.4 landed first (Form B explicit-delegation
   function at `channel-provider.ts:586`, was `:490` pre-D.2), so the
   decorator was already safe when D.2 swapped object literals for
   classes. See Phase D.4 below for the recommended ordering.
2. **The `validateToken` return shape** — the inline anonymous type
   `{ ok: boolean; botName?: string; error?: string }` is preserved
   verbatim across D.2; no named `ValidateTokenResult` was introduced
   (deferred to a future refactor if generics require it).

### Test coverage requirement

- **Per-existing-test:** every test that calls
  `provider.sendMessage(...)`, `provider.sendPhoto(...)`,
  `provider.validateToken(...)`, `provider.formatMessage(...)`,
  `provider.splitMessage(...)` on the object literals must continue to
  pass on the class instances. The 17 mocks at `01 §7` do not construct
  the literals directly — they replace `getProvider` — so this is
  effectively a no-op for the test suite.
- **New test:** `__tests__/channel-provider-classes.test.ts` constructs
  each of the 5 classes and asserts (a) `instanceof ChannelProvider` per
  `implements ChannelProvider`; (b) `provider.type` matches the literal;
  (c) `validateToken` returns a `ValidateTokenResult`-shaped value;
  (d) for telegram/slack/discord, `splitMessage` returns a non-empty
  array of strings ≤ max length; (e) for googlechat/teams,
  `sendMessage` throws the exact template
  `'<type>: direct dashboard send not supported (delivery via plugin MCP tools)'`
  (stringified `this.type`).
- **New test for `UnsupportedDirectSendProvider`:** assert that
  `GooglechatProvider` and `TeamsProvider` inherit `sendMessage` /
  `sendPhoto` from the base and only override the readonly metadata.

### Rollback strategy

Single commit; `git revert <SHA>` restores the 5 frozen object literals
and removes the 6 class declarations. **Pre-D.4 ordering caveat:** if
D.4 lands first, the rollback must be coordinated (D.4's explicit
delegation is robust against object-literal providers, so reverting
D.2 leaves a consistent codebase). If D.4 lands after D.2 in commit
order, the intermediate state is broken — see Risk level #1.

### Parallelizable

**Yes, internally.** The 5 provider classes are mutually independent;
they share only the `ChannelProvider` interface and the
`UnsupportedDirectSendProvider` base. The 5 can be coded in parallel
branches and merged as one commit. The base class + 2 subclasses are
mutually dependent and must land together.

**Yes, externally.** D.2 shares no consumer code with A, B, C, E, F.
D.2 can land in parallel with any other subsystem phase that does not
write to `src/channel-provider.ts`.

---

## Phase D.3 — `ChannelProviderRegistry` class extraction

### Status

**LANDED** (preceding refactor; post-D.2 line shift +52 lines).

### Goal

Wrap `markedProviders:600` (was `:500` pre-D.2) and `getProvider:608`
(was `:508`) in `class ChannelProviderRegistry` with
`get(type): ChannelProvider` and `list(): ChannelProviderType[]`.
Optionally remove the dead `providers:566` table (was `:477` pre-D.2; per
`01 §2` audit — no reader outside the module).

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Added `class ChannelProviderRegistry` (~25 lines); `markedProviders` initialization constructs the registry; `getProvider:608-610` is now a thin wrapper `() => markedProviders[type]` (registry indirection is optional — see tradeoffs); `providers:566-572` retained for symmetry (allowed by CLAUDE.md §3 — not removed since flagged here, not removed). |

### Public surface changes

- New: `class ChannelProviderRegistry`.
- Unchanged: `getProvider(type)` (wrapper), `getProviderType(envValue)`,
  the 5 provider classes, the helpers (now `ChannelEnv` methods after D.1).

### Risk level (actual post-D.3)

**Low.** `getProvider` signature preserved verbatim.

### Test coverage requirement (actual post-D.3)

- **Per-existing-test:** every consumer of `getProvider` keeps working
  unchanged. 18 production importers + 17 test mocks resolve through
  the signature `(ChannelProviderType) -> ChannelProvider`; the wrapper
  preserves that signature exactly.
- **New test:** `src/__tests__/channel-provider-registry.test.ts` exercises
  the registry's `get` for each of the 5 provider types and `list()`.

### Rollback strategy

Single commit; `git revert <SHA>` removes the class and restores the
`markedProviders` table + `getProvider` function.

### Parallelizable

**Yes.** D.3 touches only `src/channel-provider.ts`. Can land in
parallel with any other subsystem phase.

---

## Phase D.4 — `withTestRunMarking` decorator migration

### Status

**LANDED** (preceding refactor; **landed first**, before D.2, to
guarantee the decorator is robust against class-form providers).

### Goal

Replace `{ ...provider, sendMessage, sendPhoto }` at pre-D.2
`channel-provider.ts:490-498` with **explicit delegation of every
interface member** — same correctness, but survives the D.2 class
conversion. Per `03-class-boundaries.md` §D4, the chosen form is **Form B
(explicit-delegation function)** because the decorator has no lifecycle.

**Post-D.2 actual line citation (2026-09-04 re-measurement):**
`withTestRunMarking:586` (was `:490` pre-D.2; +96 line delta).

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Rewrote `withTestRunMarking:586-598` (post-D.2) to enumerate all 11 interface members explicitly. Same free-function shape; signature unchanged. |

### Public surface changes

None. `withTestRunMarking` is module-private (not exported); only the
`markedProviders:600` initialization calls it.

### Risk level (actual post-D.4)

**Low** (Form B landed). The decorator is applied once per provider at
module init, against object literals today. After D.2 lands, the same
function applied to class instances produces a working wrapper (because
all 11 members are explicitly forwarded).

### Test coverage requirement (actual post-D.4)

- **Per-existing-test:** `src/__tests__/channel-provider.test.ts`
  exercises the readonly fields through `provider.envKeys`,
  `.stateDir`, `.chatIdFormat`; with Form B these fields pass through
  unchanged via the explicit field copy.
- **New test:** `src/__tests__/test-run-marking-decorator.test.ts`
  exercises wrapping `new TelegramProvider()` and asserting every
  interface member is reachable through the wrapper.

### Rollback strategy

**No longer a true rollback** post-D.2 — the spread form would silently
drop prototype methods. The decorator rewrite is **required** for
correctness after D.2.

### Parallelizable

**Yes** (with ordering caveat). D.4 can land in parallel with any other
phase that does not write to `src/channel-provider.ts`. D.4 must
**precede D.2** in commit order — see Phase D.2 Risk level #1. **This
was the actual landed order.**

---

## Phase D.5 — Helper function removal

### Status

**REMOVED — merged into D.1** (this commit). No D.5 commits exist.
The consumer-migration sweep over 42 call sites was a single
coordinated change with the `ChannelEnv` class extraction, so the
helper removal shipped together with D.1 instead of as a separate
phase. The original D.5 plan is preserved below as historical
planning reference.

### Goal (original plan, NOT as shipped)

Remove the four wrapper helpers (`getChannelToken:459`,
`getChannelChatId:467`, `channelStateDir:520`, `readChannelToken:533`)
and the registry wrapper (`getProvider:508`) once every consumer
migrates to the new class surfaces.

**Post-D.2 actual line citations (2026-09-04 re-measurement):**
`ChannelEnv.getToken:522`, `ChannelEnv.getChatId:526`,
`ChannelEnv.stateDirFor:530`, `ChannelEnv.readTokenFor:543`
(were `:459/467/520/533` pre-D.2; +52 line delta).

### Migration targets (original plan)

| Helper | Production callers | Migration site |
|---|---|---|
| `getChannelToken(provider, env)` | `config.ts:325` | `const env = readEnvFile(); const channelEnv = new ChannelEnv(env); const token = channelEnv.getToken(CHANNEL_PROVIDER)` |
| `getChannelChatId(provider, env)` | `config.ts:326` | `const chatId = channelEnv.getChatId(CHANNEL_PROVIDER)` |
| `channelStateDir(provider, agentDir?)` | 14 call sites (`01 §5.3`) | Repoint each to `ChannelEnv.stateDirFor(provider, agentDir?)` (static) |
| `readChannelToken(provider, envFilePath)` | 7 call sites (`01 §5.4`) | Repoint each to `ChannelEnv.readTokenFor(provider, envFilePath)` (static) |
| `getProvider(type)` | 18 production + 17 test mocks | Repoint each to `ChannelProviderRegistry.get(type)` or `getProvider` becomes the registry's exported instance method |

### What shipped instead (D.1, this commit)

The migration happened **inside D.1**, not as a separate phase:

- 42 production call sites migrated across 12 files (matches the
  per-helper breakdown above).
- 7 of 17 test mocks updated (the 4 that mocked `channelStateDir` or
  `readChannelToken`, plus 3 that needed `ChannelEnv` shape exposure).
- The 4 legacy helpers deleted outright — no thin-wrapper intermediates
  shipped (see Phase D.1 "Design-intent reference (NOT as shipped)"
  above for the rejection rationale).

### Mechanical gates (post-D.1 verification)

- **Production gate:** `grep -rln "getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken" src/ --include='*.ts' | grep -v __tests__` returns zero matches in production code (only 3 stale comment references remain in `src/web/telegram.ts:30,40` and `src/web/routes/onboarding.ts:95` — flagged, not removed per CLAUDE.md §3).
- **Test gate:** `grep -rln "getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken" src/__tests__/` returns zero (all 7 affected mocks rewritten to expose `ChannelEnv`).

### Sub-phase split (original plan, NOT as shipped)

D.5 was originally planned to split into per-helper commits for
blast-radius control:

- D.5a: `getChannelToken` + `getChannelChatId` removal (only `config.ts`
  is the importer; smallest blast radius).
- D.5b: `channelStateDir` removal (14 importers; larger).
- D.5c: `readChannelToken` removal (7 importers; medium).
- D.5d: `getProvider` removal (18 production + 17 test mocks; largest,
  and may warrant a `__wrap_*` migration helper for the test mocks).

Each sub-phase was independently revertible. **None of these commits
exist** — the migration landed as a single coordinated D.1 commit.

### Parallelizable (original plan)

**No.** D.5 was a sequence of dependent commits — each sub-phase
depended on the prior one having migrated its importers.

---

## Phase D.6 — `LoggerLike` adoption

### Status

**DEFERRED.** D.6 only lands if H.1 forces the constructor-parameter
shape on every converted class. As of 2026-09-04, no D method calls
the logger (verified `grep -n "logger" src/channel-provider.ts` returns
only the dead import at `:5`), so D.6 is a no-op for D today and
becomes a real refactor only if/when H.1 changes the framework policy.

### Goal

If H.1 lands first and the framework's policy is "every converted class
takes `log: LoggerLike` in its constructor", add the parameter to the 5
provider classes and to `ChannelEnv`. If H.1 lands after D.1, D.6 is a
no-op for D because no D method calls the logger.

### Files touched (when D.6 lands)

| File | Change |
|---|---|
| `src/channel-provider.ts` | Add `private readonly log?: LoggerLike` to each of the 6 classes (5 providers + `ChannelEnv`). The parameter is unused — underscore prefix to silence noUnusedParameters. |
| `src/logger.ts` | No change (H.1's deliverable). |

### Public surface changes (when D.6 lands)

- Constructor signature change: `(log?: LoggerLike)` is added.
- No method signature changes.

### Risk level

**Low.** Purely additive parameter; no method behaviour changes; no
importer call-site changes (existing `new TelegramProvider()` calls
still work — the parameter is optional).

### Test coverage requirement

- **Per-existing-test:** unchanged.
- **New test (if Form A chosen for the decorator):** assert that the
  decorator's constructor accepts a `LoggerLike`-typed mock without a
  cast.

### Rollback strategy

Single commit; `git revert <SHA>` removes the optional parameter.

### Parallelizable

**Yes, with H.1.** D.6 can land in parallel with H.2 (the migration of
consumers that actually use the logger).

---

## Summary table

| Phase | Goal | Risk | Rollback unit | Parallelizable | Depends on | Status |
|---|---|---|---|---|---|---|
| D.1 | `ChannelEnv` class + dispatch table | Low | Single commit | Yes | Nothing | **LANDED** (this commit) |
| D.2 | 5 provider classes + base | Medium | Single commit | Yes (internally) | D.4 must precede (commit order) | **LANDED** (preceding) |
| D.3 | `ChannelProviderRegistry` | Low | Single commit | Yes | D.2 (registry wraps marked providers) | **LANDED** (preceding) |
| D.4 | Decorator explicit-delegation rewrite | Low | Single commit | Yes | None (but commit before D.2) | **LANDED** (preceding, landed first) |
| D.5 | Helper removal (4 sub-phases) | High | Per sub-phase | No | D.1 + D.3 + consumer migration | **REMOVED** (merged into D.1) |
| D.6 | `LoggerLike` adoption | Low | Single commit | Yes | H.1 (optional) | **DEFERRED** |

**Recommended commit order:** D.4 → D.2 → D.3 → D.1 → (D.5 merged into D.1) → D.6.

**Actual landed order:** D.4 → D.2 → D.3 → D.1 → (D.6 deferred).

**Critical path outside D:** none. D's only upstream dependency is
H.1 for D.6, and D.6 is conditional.
