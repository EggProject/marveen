# B (config) — Executive summary

Synthesis of `b-config/02-type-interface-analysis.md` (types/interfaces lens).
The `01-module-state-analysis.md` input referenced in the task brief does
**not exist** in this directory as of 2026-08-30 — the directory contains
only `02-type-interface-analysis.md` plus this plan. The module/state
claims used below (58 const exports, 60 importers, 154 vi.mock hits,
LoggerLike zero-call-sites) are taken from `02-type-interface-analysis.md`
and cross-checked against `review-correctness.md` (M2, M4, M5) and direct
`grep` on `src/`. Planning only — no source file was modified.

---

## Thesis

B is the **type-cleanest** subsystem in `src/` and the **largest** by blast
radius: 58 frozen `export const` declarations in `src/config.ts` (verified
`grep -c "^export const " src/config.ts` = 58, matches `review-correctness.md`
M2), 60 importing files (`review-correctness.md` M5), and **154**
`vi.mock('../config.js', …)` sites across `src/__tests__/` (`review-correctness.md`
M4 — the dominant test-rewrite cost in the whole refactor). The refactor
produces exactly **one** new class (`Config`) that absorbs the 58 const
exports as `public readonly` fields; `config-registry.ts` stays
**unchanged** per `review-completeness.md` OE-8 (the registry helpers are
pure functions over a frozen array, and a class wrapper would add
ceremony for zero production behaviour change). The single biggest risk
is the 154-file test-mock surface; the single biggest decision is whether
the `Config` constructor takes the parsed env record as a parameter (the
correct shape — matches `ChannelEnv` precedent per `d-channel-provider/03-class-boundaries.md:71`)
or `process.env` (would silently change which values the channel
helpers resolve to, per `d-channel-provider/00-summary.md` risk #2).

## Scope

### Files this plan TOUCHES

| File | Why | Phase |
|---|---|---|
| `src/config.ts` (395 lines) | introduce `class Config` alongside the 58 const exports; keep all const exports as named exports during the migration window; convert `currentBotName`/`currentBrandName`/`currentOwnerName` to instance methods that re-read `.env`; pure helpers (`resolveBrandName`/`resolveServiceId`/`brandSlug`/`appServiceLabel`/`launchdStatusPattern`/`systemdStatusUnits`) become static methods on the class; `Config.fromEnv(logger?)` static factory reads `.env` + `config-overrides.json` and returns an instance | B.1, B.2, B.6 |
| `src/config-registry.ts` | **unchanged** per `review-completeness.md` OE-8 — `SETTINGS_REGISTRY: SettingDefinition[]` and the 3 pure helpers stay as today; B.7 verifies the OE-8 decision | B.7 (verification only) |
| `src/index.ts` (568 lines, 19 import statements per `review-correctness.md` C6) | the orchestrator; constructs the single `Config` instance at boot and passes it to every consumer via a `RouteContext`-style seam (or direct field on `class App` per `review-completeness.md` OE-9) | B.2–B.4 |
| `src/heartbeat.ts` (601 lines) | reads `HEARTBEAT_AGENT_ENABLED` (L358-359), `HEARTBEAT_INTERVAL_MS` (L350), `HEARTBEAT_START_HOUR` (L351), `HEARTBEAT_END_HOUR` (L393), `HEARTBEAT_CALENDAR_ACCOUNT` (L392), `HEARTBEAT_CALENDAR_ID` (L394); 6 `cfg()`-routed keys via F's `HeartbeatScheduler` constructor | B.4 |
| `src/web.ts` (1500-line closure per `00-summary.md`) | reads `PROJECT_ROOT`, `WEB_HOST`, `DASHBOARD_PUBLIC_URL`, `DASHBOARD_ALLOWED_ORIGINS`, `MAIN_AGENT_ID` (per `web.ts:6`); `class DashboardServer` takes `config: Config` via constructor | B.3 |
| `src/db.ts` (155 exported functions, 14 direct importers per `review-correctness.md` M6) | reads `STORE_DIR`, `DB_FILENAME` (per L13-14); `class DbClient` (entity-store keystone per `00-summary.md`) takes `config: Config` via constructor | B.4 |
| `src/auto-restart.ts` (122 lines) | reads `DEFAULT_AUTO_RESTART` (L48) — frozen const, 1 production importer `web/auto-restart-store.ts:7`; the F brief extracts `class AutoRestartSchedule` per `f-agent-subsystem/03-class-boundaries.md §F8` | B.2 |
| `src/channel-coordinator/liveness.ts` + 13 other D consumers | reads `CHANNEL_PROVIDER`, `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID` (per `config.ts:324-326`); D's `class ChannelEnv` absorbs these via its own constructor | B.2 (delegated to D.5) |
| 60 importing files (M5) total | the keystones (`web.ts`, `index.ts`, `db.ts`, `heartbeat.ts`) plus 56 other consumers in `src/` and `src/web/` and the subdirs (`channel-coordinator/`, `costops/`, etc.) — each migrates `import { X } from './config.js'` → `import { config } from './config.js'` OR `import { X } from './config.js'` (the wrapper re-exports the consts from the class instance during B.2–B.5; removed in B.6) | B.2–B.5 |
| `src/__tests__/` (154 files per `review-correctness.md` M4) | rewrite `vi.mock('../config.js', …)` → constructor injection via a `createTestConfig(overrides?)` factory (per `review-completeness.md` CE-5) | B.5 |

### Files this plan does NOT touch

- **`src/config-registry.ts`** (per `review-completeness.md` OE-8) — the
  helpers `getSettingDefinition` (L432-434), `listSettingModules` (L436-438),
  `validateSettingValue` (L449-484) are pure functions over a frozen
  array; `SETTINGS_REGISTRY: SettingDefinition[]` is built once from a
  literal at L37 and never mutated (`02-type-interface-analysis.md §2.4`).
  `DISTRIBUTION_DEFAULT_AGENT_MODEL` at L16 is a single source of truth
  for `config.ts:114`'s `cfg('DEFAULT_AGENT_MODEL') || DISTRIBUTION_DEFAULT_AGENT_MODEL`
  fallback. B.7 is verification only — no source change.
- **`src/env.ts:13` `readEnvFile(keys?: string[]): Record<string, string>`** —
  `Config.fromEnv` (B.1) calls this; the function itself stays a free
  export (it's the underlying primitive and is correct as-is per
  `02-type-interface-analysis.md §1.6`).
- **The 58 const exports as named exports** — kept as `export const`
  during the migration window (B.1 → B.5). The new `Config` instance
  exposes them as `public readonly` fields, and the named exports are
  re-exports of the instance fields (e.g.
  `export const WEB_PORT = config.WEB_PORT`). This lets the 60 importers
  migrate one at a time without a synchronized rewrite. B.6 removes the
  re-export shim once `grep -rln "from ['\"]\\./config\\.js['\"]" src/
  --include='*.ts' | grep -v __tests__` returns zero direct imports.
- **`src/web/atomic-write.ts`** — out of scope per
  `review-completeness.md` CE-6; the plan converts 20+ modules to
  classes for testability but explicitly exempts atomic-write. B does
  not touch atomic-write.
- **All test files outside the 154 B-mock rewrites** — tests get
  *updated* to match new class APIs but their layout, runner
  (`bun --bun vitest`), and coverage targets are not in scope
  (consistent with `00-summary.md` "Explicitly OUT OF SCOPE").

## Dependency: what other subsystems expect from B

| Consumer | B deliverable it needs | What it expects | Blocking? |
|---|---|---|---|
| **A** (entity stores A1–A12) | `Config` instance with `STORE_DIR`, `DB_FILENAME`, `PROJECT_ROOT` fields | Constructor takes `(env, overrides)` and reads `.env` + `config-overrides.json` once; `App` (D.3 keystone) wires the instance into every store. The `db.ts` keystone reads `STORE_DIR` (`config.ts:13`) to locate `claudeclaw.db`. | **Yes.** Without B.1, A1 (`MemoryStore`) cannot take `config: Config` in its constructor. |
| **D** (channel-provider) | `Config.env` field exposing the parsed env record | D1 (`ChannelEnv`) at `d-channel-provider/03-class-boundaries.md:71` takes `(env: Record<string, string>, home?)`. The `config.ts:325-326` `getChannelToken(CHANNEL_PROVIDER, env)` / `getChannelChatId(CHANNEL_PROVIDER, env)` calls today pass `env` from `readEnvFile()` at `config.ts:17` — after B.1, `Config.env` is the same record. | **Yes.** D.1 requires B.1's `env` field to exist. |
| **F** (agent subsystem) | `Config` fields for `HEARTBEAT_AGENT_ENABLED`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_START_HOUR`, `HEARTBEAT_END_HOUR`, `HEARTBEAT_CALENDAR_ACCOUNT`, `HEARTBEAT_CALENDAR_ID` | F1 `HeartbeatScheduler` takes `config: Config` in its constructor (per `f-agent-subsystem/03-class-boundaries.md §F1` Dependencies); 6 fields are read inside `executeHeartbeat`. `DEFAULT_AUTO_RESTART` from `auto-restart.ts:48` is also exposed as `config.DEFAULT_AUTO_RESTART` per the F5 `AutoRestartSchedule` brief. | **Yes.** F.1, F.5 cannot land before B.1. |
| **G** (channel-coordinator) | `Config` fields for `CHANNEL_PROVIDER`, `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`, `RESPAWN_ENABLED`, `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED` | `channel-coordinator.ts` reads `CHANNEL_PROVIDER` for `getProvider(type)` and the respawn-gate booleans; per `00-summary.md` B is a keystone that lands last — but the *class form* lands in B.1 alongside the const exports; the *consumer migration* lands in B.4 (high-risk phase). | **Yes** for B.1 (class form); **No** for consumer migration (can land in parallel with F.3 / F.4 after B.1). |
| **C** (web/ routes) | `Config` instance with `WEB_PORT`, `WEB_HOST`, `DASHBOARD_PUBLIC_URL`, `DASHBOARD_ALLOWED_ORIGINS`, `MAIN_AGENT_ID` | `web.ts:6` imports 5 fields; the 44 route files in `src/web/routes/` read `WEB_HOST` / `DASHBOARD_ALLOWED_ORIGINS` / `MAIN_AGENT_ID` indirectly via `RouteContext`. Per `00-summary.md` B is a keystone; consumer migration is B.3. | **No** for B.1; **Yes** for B.3. |
| **H (logger migration)** | `LoggerLike` interface (H.1) | `Config` has zero logger call sites today (`02-type-interface-analysis.md §1.7` — the 2 `grep -nE "logger\|log\." src/config.ts` hits are both in comments at L103 and L376, and the L103 comment explicitly explains the circular-import constraint). Per `02 §3.6`, `Config` does NOT gain a `log: LoggerLike` field — the loud APP_TZ_INVALID reporting stays in `startScheduleRunner`. | **No.** B does not depend on H.1; B is the cheapest H consumer (zero call sites) and lands in parallel with H.1. |
| **Test mocks (154 sites per M4)** | `createTestConfig(overrides?)` factory | Per `review-completeness.md` CE-5, every test that today uses `vi.mock('../config.js', () => ({ WEB_PORT: 4000, ... }))` rewrites to `new Config({ WEB_PORT: 4000, ... })` via a shared factory. B.5 owns this. | **Yes** for the factory design; the per-file rewrites follow B.5. |

**What B does NOT owe anyone.** No other subsystem reads `Config`'s
internal `env`/`overrides` bags directly — those are private to the class.
No other subsystem mutates the 58 const values at runtime (the const
identity is captured by tests, per `02 §3.4`).

## Top 3 risks specific to B

1. **60 importer blast radius + 154 `vi.mock` test surface.** B is the
   single broadest keystone in `src/` (the framework's `00-summary.md`
   places `config.ts` in the deferred-keystone bucket, but the
   *consumer count* at 60 is 4.3× the next-largest keystone `db.ts`
   with 14 importers per `review-correctness.md` M6). The class
   extraction must be **phased** (B.1 introduce alongside → B.2/B.3/B.4
   consumer migration in low/mid/high-risk batches → B.5 mock rewrite
   → B.6 re-export shim removal) with rollback granularity per phase.
   A single-commit refactor would touch every consumer simultaneously
   and would be unrevertable if any one consumer has a hidden dependency
   on the const-vs-class identity. The migration window preserves
   `export const WEB_PORT = config.WEB_PORT` etc. so importers keep
   working verbatim until their per-phase migration lands.
   `06-risks-and-mitigations.md BR1`.

2. **Test-mock seam shift: 154 `vi.mock('../config.js', …)` rewrites.**
   Per `review-correctness.md` M4 (verified 154 occurrences across 4
   pattern variants: 75 `async (orig)` + 56 `()` + 12 unparenthesised +
   11 `async (importOriginal)`), this is the dominant test-rewrite cost
   in the whole refactor. Per `review-completeness.md` CE-5, the first
   5–10 tests will set the convention; everything after copies it. The
   `createTestConfig(overrides?)` factory must be designed before B.5
   starts. Per F.2's test-factory design (`review-completeness.md` CE-5
   cross-reference), every test needs the same shape; ad-hoc
   `new Config({...})` calls would lead to 154 different mock styles.
   `06-risks-and-mitigations.md BR2`.

3. **`SettingsRegistry` decision (OE-8) is the single sharpest
   design-vs-default tension.** The framework brief proposes
   `SettingsRegistry.define`/`undefine` (per `review-completeness.md
   OE-8`); the source argues against it: the array is frozen at module
   load (L37), the 3 helpers (`getSettingDefinition`, `listSettingModules`,
   `validateSettingValue`) are pure functions, and `define`/`undefine`
   would exist only for `vi.mock('../config-registry.js')` test
   overrides (which today mock the whole module — they don't call
   `define`/`undefine`). Promoting to a class adds boilerplate
   (`getDefinition`, `listModules`, `listKeys`, `validate`) for
   production-zero behaviour change. **Verdict: keep as-is.** The risk
   here is **not** the source change (none) but the **documented
   rationale**: an executor who hasn't read OE-8 might re-introduce the
   class wrap as part of B.7 and silently ship a regression. B.7 exists
   *specifically* to verify that OE-8 holds and to fail loudly if the
   decision is reversed. `06-risks-and-mitigations.md BR4`.

## Migration order inside B

```
B.1  Config class extraction              (introduce alongside 58 const exports; do NOT remove them)
   |
   +---> B.2  Config consumer migration phase 1   (low-risk: D readEnvFile consumer, F DEFAULT_AUTO_RESTART consumer)
   |
   +---> B.3  Config consumer migration phase 2   (mid-risk: web/ routes; 5 fields in web.ts:6)
   |
   +---> B.4  Config consumer migration phase 3   (high-risk: heartbeat, db, channel-coordinator)
   |
   +---> B.5  vi.mock('../config.js') migration   (154 test files; per createTestConfig factory)
   |
   +---> B.6  Re-export shim removal              (gated on zero direct const-imports + zero vi.mock)
   |
   B.7  SettingsRegistry verification              (OE-8 decision: no class wrap; document & verify)
```

Rationale for the order:

- **B.1 first** because every subsequent phase assumes the `Config`
  class exists. The new class is **additive**: the 58 `export const`
  declarations stay, but become re-exports of `instance.<field>` on a
  module-scope singleton constructed at the bottom of `config.ts` (after
  the existing const initialisers). This lets all 60 importers keep
  working verbatim until their per-phase migration lands.
- **B.2 second** because D's `ChannelEnv` (D.1) and F's
  `AutoRestartSchedule` (F.5) are the lowest-risk consumers — both take
  the values as constructor args and have no test mocks for `config.ts`
  beyond `config.ts` itself. Migrating them first proves the class
  surface without touching any other test.
- **B.3 / B.4 next** because the route layer (`web.ts` + 44 routes) and
  the heartbeat/db/channel-coordinator keystones have the largest blast
  radii. B.3 migrates `web.ts:6` (5 fields) and lets the route handlers
  pick up `config` via `RouteContext` (per the existing DI seam at
  `web/routes/types.ts:27`); B.4 migrates the three subsystem keystones
  that read the most fields each.
- **B.5 parallel-after-B.4** because the `vi.mock` rewrites need the
  consumer-side migration to be far enough along that tests don't
  double-rewrite (mock the module → use instance). Per
  `review-completeness.md` CE-5, the factory design is the load-bearing
  piece; B.5 must land the factory first, then the 154 rewrites.
- **B.6 last inside B.** Gated on (a) every importer of the 58 const
  exports migrated to the `Config` instance (`grep -rln "from ['\"]\\./config\\.js['\"]"
  src/ --include='*.ts' | grep -v __tests__` returns zero direct
  re-export consumers outside `config.ts` itself), (b) the 154
  `vi.mock('../config.js')` sites rewritten to `createTestConfig()`,
  (c) test suite green. The re-export shim removal is irreversible.
- **B.7 anywhere**, but late is fine: it changes nothing observable
  (OE-8 = no change) and its only deliverable is a one-paragraph
  verification that the registry stays as a `const` + free functions.

## Cross-references

- **`02-type-interface-analysis.md`** — types/interfaces lens; the only
  existing input file. Every count, line ref, and unsafe-cast claim in
  this summary is sourced from there unless explicitly cited otherwise.
- **`review-completeness.md`** — OE-8 (`SettingsRegistry` no class wrap);
  OE-9 (`App.getStore<K>` dropped); CE-5 (test factory design); CE-7
  (heartbeat prompt-builder separation); CE-15 (logger singleton vs
  constructor-injected ambiguity).
- **`review-correctness.md`** — M2 (58 const exports); M4 (154
  `vi.mock('../config.js')` sites); M5 (60 importers); C6 (19 import
  statements in `index.ts`, not 70+); R2 (config.ts keystone blast
  radius).
- **`d-channel-provider/03-class-boundaries.md:71`** — `ChannelEnv`
  constructor `(env: Record<string, string>, home?)` precedent;
  informs B.1's constructor shape.
- **`e-process-lock/03-class-boundaries.md:42`** — `PortLockAcquirer`
  constructor `(ctx, opts?)` precedent for the **introduce-alongside,
  free-function-wrapper-survives** pattern that B.1 follows.
- **`f-agent-subsystem/03-class-boundaries.md §F1 / §F5`** — `HeartbeatScheduler`
  and `AutoRestartSchedule` consumers of `Config`; both land after B.1.
- **`h-cross-cutting/00-summary.md`** — H.1 `LoggerLike` interface
  decision; B has zero logger call sites today
  (`02-type-interface-analysis.md §1.7`) and does not gain a logger
  field in `Config`.

## [ASSUMPTION] markers

- [ASSUMPTION: `01-module-state-analysis.md` referenced in the task
  brief is absent; the module/state claims used here are taken from
  `02-type-interface-analysis.md` and cross-checked against
  `review-correctness.md`. If `01-module-state-analysis.md` is
  produced later, the cross-check should be repeated.]
- [ASSUMPTION: the 60 importer count (M5) and 154 `vi.mock` count
  (M4) are canonical; direct `grep` on 2026-08-30 returns 145 importer
  files and 221 `vi.mock` occurrences — the higher numbers reflect
  broader patterns that include paths other than `'./config.js'`
  exactly; M5/M4 use the narrow `'./config.js'`/`'../config.js'`
  pattern which is the correct scope for the class-extraction risk.]
- [ASSUMPTION: the 5 importer files that go through D's `ChannelEnv`
  (per `d-channel-provider/00-summary.md` Scope) are counted in the 60
  total, not separately — they migrate as part of D.5, not B.2.]
