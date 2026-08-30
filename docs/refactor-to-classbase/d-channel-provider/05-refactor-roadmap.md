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

`D.6` is **off D's critical path** because `02 §10` confirms zero logger
call sites in `channel-provider.ts:1-552`. D.6 only runs if H.1 forces
the constructor-parameter shape on every converted class; if H.1 lands
after D.5, D.6 is a no-op for D.

---

## Phase D.1 — `ChannelEnv` class extraction

### Goal

Introduce `class ChannelEnv` in `src/channel-provider.ts` alongside the
four top-level helpers (`getChannelToken:459`, `getChannelChatId:467`,
`channelStateDir:520`, `readChannelToken:533`). Convert the four
5-branch dispatch chains to a single `static readonly TABLE`. Add the
named return type `ValidateTokenResult`. **Keep** the four helpers as
thin wrappers so callers see no change.

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Add `class ChannelEnv` (~50 lines); add `interface ValidateTokenResult` (~5 lines); convert `:459-465` and `:467-473` to thin wrappers; convert `:520-531` and `:533-551` to static wrappers. **No consumer call site changes.** |

### Public surface changes

- New: `class ChannelEnv` with constructor `(env: Record<string, string>, home?: string)`, instance methods `getToken(provider)`, `getChatId(provider)`, static methods `stateDirFor(provider, agentDir?)`, `readTokenFor(provider, envFilePath)`, `static readonly TABLE`.
- New: `interface ValidateTokenResult`.
- Unchanged: `getChannelToken`, `getChannelChatId`, `channelStateDir`, `readChannelToken` (now wrappers).
- Unchanged: `ChannelProviderType`, `ChannelProvider`.

### Risk level

**Low.** Pure addition + thin wrappers. The four helpers' signatures are
byte-identical to today; the wrappers preserve the per-call `env`
parameter that the source uses.

### Test coverage requirement

- **Per-existing-test:** all tests that touch `getChannelToken`,
  `getChannelChatId`, `channelStateDir`, `readChannelToken` must pass
  unchanged. The wrappers' byte-equivalence with the original bodies is
  the regression check.
- **New test:** `__tests__/channel-env.test.ts` (new) exercises
  `ChannelEnv` directly: each method, each of the 5 provider types, and
  the `TABLE` shape. Pinned to `02 §5.1`–`§5.4` call-site analysis
  (which env keys resolve for which provider type).
- **New test:** `__tests__/validate-token-result.test.ts` (optional,
  inline in `channel-provider.test.ts` is fine) — asserts the named
  return type is structurally equivalent to the anonymous shape.

### Rollback strategy

Single commit; `git revert <SHA>` removes the class and restores the
four free-function bodies from the wrapper bodies. No consumer call site
changes means no migration to roll back.

### Parallelizable

**Yes.** D.1 shares no source files with A, B, C, E, F (D's only
sibling is `src/process-lock.ts` for E, and they touch different
modules). D.1 can land in parallel with any other subsystem phase that
does not write to `src/channel-provider.ts`.

---

## Phase D.2 — 5 provider class extractions

### Goal

Convert the five frozen object literals (`telegramProvider:53`,
`slackProvider:134`, `discordProvider:243`, `googlechatProvider:324`,
`teamsProvider:364`) into 5 classes (`TelegramProvider`, `SlackProvider`,
`DiscordProvider`, `GooglechatProvider`, `TeamsProvider`) plus the
`UnsupportedDirectSendProvider` abstract base for the googlechat/teams
pair. Per `review-correctness.md` C1, **method signatures are preserved
byte-for-byte**: `sendMessage(token, chatId, text, parseMode?)`,
`sendPhoto(token, chatId, photoPath, caption)`, `validateToken(token)`,
`formatMessage(text)`, `splitMessage(text)`. Token and chatId remain
per-call parameters.

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Add 6 new class declarations (~150 lines net); leave the 5 frozen object literals in place as `_legacyTelegramProvider` etc. [ASSUMPTION: naming convention; `git blame` should be checked for any historical name preference before committing.] so callers that imported them by name continue to resolve; or remove them under CLAUDE.md §3 ("Remove imports/variables/functions that YOUR changes made unused") if no caller exists outside the module. |
| `src/__tests__/channel-provider.test.ts:55-57` (read-only audit) | If this test reads `telegramProvider.envKeys` / `.stateDir` / `.chatIdFormat` directly, update to read from `new TelegramProvider()` — but no production code reads those readonly fields (per `02 §1` zero production consumers). |

### Public surface changes

- New: `class TelegramProvider`, `class SlackProvider`,
  `class DiscordProvider`, `class UnsupportedDirectSendProvider`,
  `class GooglechatProvider`, `class TeamsProvider`.
- Unchanged: `ChannelProvider` interface; the 5 readonly metadata
  fields; the 5 method signatures; the 5 frozen object literals (or
  removed if confirmed dead outside the module).

### Risk level

**Medium.** Two structural concerns:

1. **The `withTestRunMarking` decorator spread drops prototype methods
   once providers become classes.** Today the spread at `:492` is safe
   because every member is an own property; tomorrow it's not. This is
   **resolved in D.4**, but D.2 lands before D.4. **Mitigation:** D.2
   introduces the classes; D.4 immediately rewrites the decorator
   function. Between the two commits, if anything calls
   `withTestRunMarking(classInstance)`, the result is broken. Therefore
   **D.2 must land in the same release train as D.4**, OR D.4 must
   precede D.2 in commit order. Recommendation: **D.4 first** (rewrite
   the decorator function to explicit delegation of all 11 members),
   then D.2 (introduce the classes). The decorator rewrite is
   behaviour-preserving when run against object literals (it produces
   the same wrapper shape).
2. **The `validateToken` return shape is the inline anonymous type**
   `{ ok: boolean; botName?: string; error?: string }`. Once the 5
   provider classes exist, switching them to use the named
   `ValidateTokenResult` from D.1 is a separate, additive change — but
   it should land in D.2's commit so the 5 implementations share the
   same return type from the start.

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

### Goal

Wrap `markedProviders:500` and `getProvider:508` in
`class ChannelProviderRegistry` with `get(type): ChannelProvider` and
`list(): ChannelProviderType[]`. Optionally remove the dead
`providers:477` table (per `01 §2` audit — no reader outside the
module).

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Add `class ChannelProviderRegistry` (~25 lines); convert `markedProviders` initialization to construct a registry; convert `getProvider:508-510` to a thin wrapper `() => registry.get(type)`; remove `providers:477-483` (dead, allowed by CLAUDE.md §3). |

### Public surface changes

- New: `class ChannelProviderRegistry`.
- Unchanged: `getProvider(type)` (now wrapper), `getProviderType(envValue)`,
  the 5 provider classes, the helpers.

### Risk level

**Low.** `getProvider` signature is preserved verbatim. The
`ChannelProviderRegistry.get` method is a 1:1 wrapper over
`markedProviders[type]`. The `list()` method is new (additive only).

### Test coverage requirement

- **Per-existing-test:** every consumer of `getProvider` keeps working
  unchanged. This is the **single largest test surface in D**: 18
  production importers + 17 test mocks. All of them resolve through the
  signature `(ChannelProviderType) -> ChannelProvider`; the wrapper
  preserves that signature exactly.
- **New test:** `__tests__/channel-provider-registry.test.ts` exercises
  (a) `new ChannelProviderRegistry(providers).get(type)` for each of the
  5 provider types; (b) `list()` returns the exact 5-element tuple in
  declaration order; (c) the optional `testRunMarker` decoration
  parameter produces marked output for `sendMessage` text and
  `sendPhoto` caption.

### Rollback strategy

Single commit; `git revert <SHA>` removes the class and restores the
`markedProviders` table + `getProvider` function.

### Parallelizable

**Yes.** D.3 touches only `src/channel-provider.ts`. Can land in
parallel with any other subsystem phase.

---

## Phase D.4 — `withTestRunMarking` decorator migration

### Goal

Replace `{ ...provider, sendMessage, sendPhoto }` at `channel-provider.ts:490-498`
with **explicit delegation of every interface member** — same
correctness, but survives the D.2 class conversion. Per `03-class-boundaries.md`
§D4, the recommended form is **Form B (explicit-delegation function)**
because the decorator has no lifecycle.

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Rewrite `withTestRunMarking:490-498` to enumerate all 11 interface members explicitly. Same free-function shape; signature unchanged. |

### Public surface changes

None. `withTestRunMarking` is module-private (not exported); only the
`markedProviders:500` initialization calls it.

### Risk level

**Low** if Form B (recommended). **Medium** if Form A (class) chosen —
see `03-class-boundaries.md` §D4 tradeoffs.

The decorator is applied once per provider at module init, against object
literals today. The rewrite is a behaviour-preserving transformation
when applied to literals (every member is still enumerated explicitly,
and the spread semantics on object literals is the same as the
explicit-delegation semantics). After D.2 lands, the same function
applied to class instances produces a working wrapper (because all 11
members are explicitly forwarded).

### Test coverage requirement

- **Per-existing-test:** `__tests__/channel-provider.test.ts:55, 65`
  (which exercises the readonly fields through `provider.envKeys`,
  `.stateDir`, `.chatIdFormat`) must continue to pass. With Form B,
  these fields pass through unchanged via the explicit field copy.
- **New test:** `__tests__/test-run-marking-decorator.test.ts`
  exercises (a) wrapping a `new TelegramProvider()` and asserting every
  interface member is reachable through the wrapper; (b) wrapping with
  a no-op marker and asserting `sendMessage` is called with the
  original text (not modified); (c) wrapping with a marker that prepends
  `X:` and asserting `sendMessage` is called with the prefixed text.
- **Regression pin:** verify that calling
  `withTestRunMarking(new TelegramProvider()).formatMessage('hello')`
  returns the same value as `new TelegramProvider().formatMessage('hello')`
  — the explicit-delegation form must not regress format/split.

### Rollback strategy

Single commit; `git revert <SHA>` restores the spread form. **Note:**
once D.2 lands, the rollback is no longer a true rollback — the spread
form would silently drop prototype methods. Rollback only valid before
D.2; after D.2 the decorator rewrite is **required** for correctness.

### Parallelizable

**Yes** (with ordering caveat). D.4 can land in parallel with any other
phase that does not write to `src/channel-provider.ts`. But D.4 must
**precede D.2** in commit order — see Phase D.2 Risk level #1.

---

## Phase D.5 — Helper function removal

### Goal

Remove the four wrapper helpers (`getChannelToken:459`,
`getChannelChatId:467`, `channelStateDir:520`, `readChannelToken:533`)
and the registry wrapper (`getProvider:508`) once every consumer
migrates to the new class surfaces.

### Migration targets

| Helper | Production callers | Migration site |
|---|---|---|
| `getChannelToken(provider, env)` | `config.ts:325` | `const env = readEnvFile(); const channelEnv = new ChannelEnv(env); const token = channelEnv.getToken(CHANNEL_PROVIDER)` |
| `getChannelChatId(provider, env)` | `config.ts:326` | `const chatId = channelEnv.getChatId(CHANNEL_PROVIDER)` |
| `channelStateDir(provider, agentDir?)` | 14 call sites (`01 §5.3`) | Repoint each to `ChannelEnv.stateDirFor(provider, agentDir?)` (static) |
| `readChannelToken(provider, envFilePath)` | 7 call sites (`01 §5.4`) | Repoint each to `ChannelEnv.readTokenFor(provider, envFilePath)` (static) |
| `getProvider(type)` | 18 production + 17 test mocks | Repoint each to `ChannelProviderRegistry.get(type)` or `getProvider` becomes the registry's exported instance method |

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Delete the 5 wrapper exports and their thin function bodies. The registry initialiser becomes the new getProvider-shaped function (or it returns the registry directly). |
| `src/config.ts` | Replace `getChannelToken` / `getChannelChatId` calls with `ChannelEnv` instance methods. Construct `ChannelEnv` from `readEnvFile()`. |
| `src/channel-coordinator/liveness.ts:193-194` | Replace `channelStateDir(...)` with `ChannelEnv.stateDirFor(...)`. |
| 13 other production importers (enumerated in `01 §8`) | Replace helper calls with the appropriate `ChannelEnv` static methods. |
| 4 mock factory sites that mock `channelStateDir` or `readChannelToken` | Update to mock the static methods or to mock the free function on the module (the static methods remain accessible via the same import path). |

### Public surface changes

- Removed: `getChannelToken`, `getChannelChatId`, `channelStateDir`,
  `readChannelToken`, `getProvider` (the 4 helpers + 1 registry
  wrapper).
- Added: `ChannelEnv.getToken`, `ChannelEnv.getChatId`,
  `ChannelEnv.stateDirFor`, `ChannelEnv.readTokenFor`,
  `ChannelProviderRegistry.get`.

### Risk level

**High.** This is the only phase that removes exported symbols. Every
importer (18 production + 17 test mocks) must be migrated in lockstep.

### Test coverage requirement

- **Per-existing-test:** every consumer of the removed helpers must
  pass on the new class surfaces. The grep gate below is the migration
  signal.
- **Mechanical gate:** `grep -rln "getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken\|getProvider(" src/ --include='*.ts' | grep -v __tests__` must return only `src/channel-provider.ts` (where the class declarations live).
- **Test-only gate:** `grep -rln "getChannelToken\|getChannelChatId\|channelStateDir\|readChannelToken" src/__tests__/` must return zero (or only tests that explicitly test the wrapper shapes for backwards compat — which is the migration's wrong direction).

### Rollback strategy

Restore the wrappers from a backup commit; the migration commit's
importer edits are the durable part and must be reverted alongside.

D.5 should be split into **per-helper commits** for blast-radius
control:

- D.5a: `getChannelToken` + `getChannelChatId` removal (only `config.ts`
  is the importer; smallest blast radius).
- D.5b: `channelStateDir` removal (14 importers; larger).
- D.5c: `readChannelToken` removal (7 importers; medium).
- D.5d: `getProvider` removal (18 production + 17 test mocks; largest,
  and may warrant a `__wrap_*` migration helper for the test mocks).

Each sub-phase is independently revertible.

### Parallelizable

**No.** D.5 is a sequence of dependent commits — each sub-phase depends
on the prior one having migrated its importers.

---

## Phase D.6 — `LoggerLike` adoption

### Goal

If H.1 lands first and the framework's policy is "every converted class
takes `log: LoggerLike` in its constructor", add the parameter to the 5
provider classes and to `ChannelEnv`. If H.1 lands after D.5, D.6 is a
no-op for D because no D method calls the logger.

### Files touched

| File | Change |
|---|---|
| `src/channel-provider.ts` | Add `private readonly log?: LoggerLike` to each of the 6 classes (5 providers + `ChannelEnv`). The parameter is unused — underscore prefix to silence noUnusedParameters. |
| `src/logger.ts` | No change (H.1's deliverable). |

### Public surface changes

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

| Phase | Goal | Risk | Rollback unit | Parallelizable | Depends on |
|---|---|---|---|---|---|
| D.1 | `ChannelEnv` class + dispatch table | Low | Single commit | Yes | Nothing |
| D.2 | 5 provider classes + base | Medium | Single commit | Yes (internally) | D.4 must precede (commit order) |
| D.3 | `ChannelProviderRegistry` | Low | Single commit | Yes | D.2 (registry wraps marked providers) |
| D.4 | Decorator explicit-delegation rewrite | Low | Single commit | Yes | None (but commit before D.2) |
| D.5 | Helper removal (4 sub-phases) | High | Per sub-phase | No | D.1 + D.3 + consumer migration |
| D.6 | `LoggerLike` adoption | Low | Single commit | Yes | H.1 (optional) |

**Recommended commit order:** D.4 → D.2 → D.1 → D.3 → D.5a → D.5b →
D.5c → D.5d → D.6.

**Critical path outside D:** none. D's only upstream dependency is
H.1 for D.6, and D.6 is conditional.
