# B (config) — Refactor roadmap

Ordered phases B.1 through B.7. Each phase: goal, files touched, risk
level, test coverage requirement, rollback strategy, parallelizable
flag, and pre-conditions. Source verified against `src/config.ts` and
`src/config-registry.ts` on 2026-08-30.

**Reading note.** B.1 is **additive** — the `Config` class lands
alongside the existing 58 const exports and 10 free functions, which
become re-exports of `instance.<field>`. This is the textbook "introduce
alongside, free-function-wrapper-survives" pattern from
`e-process-lock/03-class-boundaries.md:106` and
`d-channel-provider/03-class-boundaries.md:166`. B.6 removes the re-export
shim only when the 60 importers + 154 `vi.mock` rewrites have all
migrated.

---

## B.1 — `Config` class extraction (additive)

### Goal

Introduce `class Config` in `src/config.ts` that wraps the 58 frozen
const exports as `public readonly` fields plus 3 instance methods
(`currentBotName`/`currentBrandName`/`currentOwnerName`) and 7 static
methods (`resolveAppTz`/`resolveBrandName`/`resolveServiceId`/`brandSlug`/`appServiceLabel`/`launchdStatusPattern`/`systemdStatusUnits`).
The existing 58 `export const` declarations + 10 `export function`
declarations become **re-exports** of `instance.<field>` and
`Config.<static>` respectively, so the 60 importers keep working
verbatim. The module-scope singleton `config = Config.fromEnv()` is the
one instance the re-exports point at.

### Files touched

- `src/config.ts` — add the `Config` class (~120 lines new) at the
  bottom of the file (after the existing const initialisers); add
  `export const config = Config.fromEnv()`; replace each `export const X`
  with `export const X = config.X`; replace each `export function f(...)`
  with `export const f = Config.f.bind(Config)` (for static methods) or
  `export const f = (...args) => config.f(...args)` (for instance
  methods). Net diff: ~+150 lines / ~-10 lines.

### Risk level

**Low.** The class is purely additive. Every existing import path
(`import { WEB_PORT } from './config.js'`) keeps resolving to the same
value (the singleton's field), so the 60 importers and 154 `vi.mock`
sites don't change in this phase. The only behavioural risk is if
`Config.fromEnv()` reads `.env` differently than the current
`const env = readEnvFile()` at L17 — verified identical (both call
`readEnvFile()` with no args per `env.ts:13`'s signature).

### Test coverage requirement

- **New tests**: a single `__tests__/config-class.test.ts` exercising
  `Config.fromEnv()` against a fixture `.env` and asserting every
  field's value matches the current module-level const. ~50 cases
  (one per field).
- **Existing tests**: must remain green. `bun --bun vitest run` on the
  pre-B.1 baseline must pass before B.1 lands.

### Rollback strategy

Single-commit revert. The 58 const exports are preserved as re-exports,
so reverting B.1 is a `git revert <B.1 SHA>` — no consumer-side change
to roll back.

### Parallelizable

**Yes**, with:
- H.1 (`LoggerLike` interface) — independent; B.1 doesn't take a logger.
- D.1 (`ChannelEnv` class) — *depends on B.1*: D.1's constructor takes
  `(env: Record<string, string>, home?)` and `config.env` provides it.
  D.1 should land **after** B.1, not in parallel.
- F.5 (`AutoRestartSchedule` class) — *depends on B.1* for
  `config.DEFAULT_AUTO_RESTART` consumption.
- E.1/E.2 (process-lock classes) — independent; no `config` dependency.

### Pre-conditions

- None. B.1 is the first phase and has no upstream blockers.

### Verification gate (measured at plan-writing time, 2026-08-30)

- `bun tsc --noEmit` returns 0 errors (the existing `config.ts` is
  type-clean; the new class adds 58 typed fields plus 10 method
  signatures, all derivable from existing literal types).
- `bun --bun vitest run src/__tests__/config-class.test.ts` is green.
- `grep -rln "from ['\"]\\./config\\.js['\"]" src/ --include='*.ts'
  | grep -v __tests__` returns ≥60 files (unchanged from baseline).
- `grep -rh "vi\\.mock.*config\\.js" src/__tests__/ | wc -l` returns
  ≥154 (unchanged from baseline per `review-correctness.md` M4).

[ASSUMPTION: the existing `bun tsc --noEmit` baseline has ~1742 errors
per the framework §8 baseline note (pre-existing `bun:sqlite` drift);
the "0 new errors" gate is the right one to use. Re-measure at
plan-execution time.]

---

## B.2 — Config consumer migration phase 1 (low-risk)

### Goal

Migrate the two lowest-risk consumers of `Config` to take the instance
via constructor injection:

1. **D's `ChannelEnv`** (delegated to `d-channel-provider/03-class-boundaries.md`
   D.5 phase) — `config.ts:325-326` becomes
   `new ChannelEnv(config.env)` (D.1's constructor takes
   `Record<string, string>` per `d-channel-provider/03-class-boundaries.md:71`).
2. **F's `AutoRestartSchedule`** (delegated to `f-agent-subsystem/03-class-boundaries.md`
   F.5) — `web/auto-restart-store.ts:7`'s
   `import { DEFAULT_AUTO_RESTART } from '../config.js'` becomes
   `import { config } from '../config.js'` + `const { DEFAULT_AUTO_RESTART }
   = config` (or direct field access).

### Files touched

- `src/config.ts:325-326` — no change (the `export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, env)` line stays as a re-export of the singleton; D.5 deletes it).
- `src/channel-provider.ts:325-326` consumer migration (per D.5).
- `src/web/auto-restart-store.ts:7` — change one import line.
- `src/auto-restart.ts:48` — `DEFAULT_AUTO_RESTART` continues to be
  the re-export of `config.DEFAULT_AUTO_RESTART` (no change to
  `auto-restart.ts` itself; the F.5 class extracts this field).

### Risk level

**Low.** D's `ChannelEnv` migration is the smallest possible touch
(one line at `config.ts:325-326` becomes one line at construction).
F's `AutoRestartSchedule` migration touches one import path.
Neither touches the route layer, neither touches the test layer
(both modules have zero `vi.mock('../config.js')` sites that mock
these specific paths per `01 §7`-equivalent inventory).

### Test coverage requirement

- D.5's gate: `grep -rln "getChannelToken\|getChannelChatId" src/
  --include='*.ts' | grep -v __tests__` returns only `src/channel-provider.ts`
  (the surviving free wrapper).
- F.5's gate: `web/auto-restart-store.test.ts` and
  `web/auto-restart-runner.test.ts` pass with the new
  `AutoRestartSchedule` class.

### Rollback strategy

Per-consumer revert. D.5 rollback: restore the `config.ts:325-326`
re-export shim (it survives in B.2 as a thin wrapper). F.5 rollback:
revert `web/auto-restart-store.ts:7` to the const import.

### Parallelizable

**Yes** — D.5 and F.5 are in different files; both are downstream of
B.1 and can land in any order. **However**: D.5 cannot land before
D.1 (`ChannelEnv` class extraction); F.5 cannot land before B.1 (the
singleton must exist). Per `d-channel-provider/00-summary.md`, D.1
should land after B.1.

### Pre-conditions

- B.1 landed (the `Config` singleton exists at `config.env`).
- D.1 landed (the `ChannelEnv` class exists).
- F.5 class extraction is ready to land (per
  `f-agent-subsystem/03-class-boundaries.md §F8`).

### Verification gate

- D.5 gate: `grep -rln "getChannelToken\|getChannelChatId" src/`
  returns only `src/channel-provider.ts` outside `__tests__`.
- F.5 gate: `bun --bun vitest run src/web/auto-restart-store.test.ts
  src/web/auto-restart-runner.test.ts` is green.

---

## B.3 — Config consumer migration phase 2 (mid-risk)

### Goal

Migrate the web-layer route handlers to take `config: Config` via
constructor injection (per `web.ts:6`'s 5 fields:
`PROJECT_ROOT`, `WEB_HOST`, `DASHBOARD_PUBLIC_URL`, `DASHBOARD_ALLOWED_ORIGINS`,
`MAIN_AGENT_ID`). The route handlers in `src/web/routes/` (44 files
per `review-completeness.md` CE-3) pick up `config` via
`RouteContext` (the existing DI seam at `web/routes/types.ts:27`).

### Files touched

- `src/web.ts:6` — change one import to `import { config } from './config.js'`;
  construct `DashboardServer({ config, ... })`.
- `src/web/routes/types.ts:27` — add `config: Config` to `RouteContext`
  (or expose as a separate field on `DashboardServer`).
- 44 route files in `src/web/routes/` — each file uses
  `ctx.config.PROJECT_ROOT` etc. instead of importing from `../config.js`.
- `src/web.ts` route-handler method bodies — internal references to the
  5 fields become `this.config.WEB_HOST` etc.

### Risk level

**Medium.** The blast radius is 44 route files (per CE-3) plus
`web.ts` (~1500 lines). Per `00-summary.md` Top-3 #3, the web layer is
one of the three highest-risk keystone conversions. The risk here is
**smaller** than the full `class DashboardServer` refactor because B.3
only changes *how* the config is passed (constructor injection vs free
import), not the route-handler shapes themselves.

### Test coverage requirement

- All 44 route files' tests pass.
- `bun --bun vitest run src/__tests__/web*.test.ts` is green.
- The `RouteContext.config` field is asserted by at least one test
  per route file (smoke test: `expect(ctx.config).toBeInstanceOf(Config)`).

### Rollback strategy

Per-route-file revert. The 44 route files can be reverted in groups
(kanban routes, federation routes, etc.). The `web.ts:6` import change
is the single load-bearing edit; reverting it cascades the re-export
shim back to the route handlers.

### Parallelizable

**Yes** — the 44 route files can be migrated in parallel by separate
agents, each touching a different subdirectory of `src/web/routes/`.
The shared edit (`RouteContext.config` addition in `types.ts:27`) must
land first; after that, each route file is independent.

### Pre-conditions

- B.1 landed.
- B.2's gate that `Config` singleton exists with `WEB_HOST`,
  `DASHBOARD_PUBLIC_URL`, `DASHBOARD_ALLOWED_ORIGINS`, `MAIN_AGENT_ID`,
  `PROJECT_ROOT` populated.

### Verification gate

- `grep -rln "from ['\"]\\.\\./config\\.js['\"]" src/web/routes/`
  returns 0 (every route handler now uses `ctx.config.X` instead of
  importing).
- `bun --bun vitest run src/__tests__/web*.test.ts` is green.
- `bun --bun vitest run src/__tests__/dashboard*.test.ts` is green.

---

## B.4 — Config consumer migration phase 3 (high-risk)

### Goal

Migrate the three subsystem keystones that read the most fields each:
**heartbeat**, **db**, and **channel-coordinator**. Each takes
`config: Config` in its constructor:

- `class HeartbeatScheduler` (F.1) — 6 fields:
  `HEARTBEAT_AGENT_ENABLED`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_START_HOUR`,
  `HEARTBEAT_END_HOUR`, `HEARTBEAT_CALENDAR_ACCOUNT`, `HEARTBEAT_CALENDAR_ID`.
- `class DbClient` (the db keystone per `00-summary.md`) — 3 fields:
  `STORE_DIR`, `DB_FILENAME`, `PID_FILENAME`.
- `channel-coordinator.ts` (the G keystone per
  `00-summary.md` Top-3 #1) — 6 fields: `CHANNEL_PROVIDER`,
  `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`, `RESPAWN_ENABLED`,
  `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED`.

### Files touched

- `src/heartbeat.ts:6`-ish import block + `HeartbeatScheduler` class
  takes `config: Config` in constructor (per
  `f-agent-subsystem/03-class-boundaries.md §F1`).
- `src/db.ts` top-of-file — `DbClient` class takes `config: Config`
  in constructor.
- `src/channel-coordinator.ts` — main `ChannelCoordinator` class takes
  `config: Config` in constructor.
- 14 direct importers of `db.ts` (per `review-correctness.md` M6) +
  heartbeat consumers + channel-coordinator consumers — each takes
  `config` (or `db`) via constructor.

### Risk level

**High.** This is the highest-risk B phase. The three keystones
together touch the bulk of the runtime path. Per
`review-correctness.md` M5, the 60 importer count includes all three
keystones plus their downstream consumers. A regression in any one
keystone breaks the entire boot path.

Mitigations:
- Each keystone migrates **independently** (heartbeat, db,
  channel-coordinator in separate commits).
- The re-export shim survives; the legacy `export const WEB_PORT = config.WEB_PORT`
  pattern keeps working.
- The `class App` (`index.ts`) constructor wires each keystone with
  the singleton `config` — same instance, every keystone.

### Test coverage requirement

- `heartbeat.test.ts`, `heartbeat-cov.test.ts`, `db.test.ts`,
  `channel-coordinator.test.ts`, `liveness.test.ts` all pass.
- The 14 direct `db.ts` importers' tests pass.
- Boot path test: `index.test.ts` (per
  `e-process-lock/03-class-boundaries.md:39` — "the 5000+ line
  `index.test.ts` test surface") passes.
- Memory decay sweep test (cross-call wiring per
  `review-completeness.md` CE-8): `memoryStore.runDecaySweep()` is
  callable after `App` constructs `MemoryStore`.

### Rollback strategy

Per-keystone revert. `heartbeat.ts`, `db.ts`, `channel-coordinator.ts`
each land as a separate commit; each can be reverted independently.
The `class App` constructor (`index.ts`) is the load-bearing wiring;
if any one keystone is reverted, the corresponding constructor arg
must be removed from `App` too.

### Parallelizable

**Yes** — heartbeat, db, channel-coordinator are independent files
with no cross-dependencies (per `00-summary.md §3.3` "cross-call wiring"
analysis: `heartbeat.ts` calls `memory.ts` which calls `db.ts`, but
this is a downstream-of-A1 concern, not a B.4 concern). Each keystone
migrates in a separate commit; the `class App` wiring lands last as
the integration commit.

### Pre-conditions

- B.1 landed.
- B.3 landed (the route layer is on the class-instance pattern; the
  `class App` constructor can safely wire `config` to all keystones).
- F.1 (`HeartbeatScheduler` class), the `DbClient` class extraction
  (per framework A1/A2), and the channel-coordinator class extraction
  have landed — B.4 is the consumer-migration step, not the
  class-extraction step.

### Verification gate

- `bun --bun vitest run src/__tests__/heartbeat.test.ts
  src/__tests__/heartbeat-cov.test.ts src/__tests__/db.test.ts
  src/__tests__/channel-coordinator.test.ts
  src/__tests__/liveness.test.ts src/__tests__/index.test.ts` is green.
- `grep -rln "from ['\"]\\./db\\.js['\"]" src/ --include='*.ts' | grep -v __tests__`
  (per `review-correctness.md` M6) drops from 14 to ≤2 (just `db.ts`
  itself + the surviving free wrapper).

---

## B.5 — `vi.mock('../config.js')` migration (154 test files)

### Goal

Rewrite the **154** `vi.mock('../config.js', …)` test sites (per
`review-correctness.md` M4) to use a shared `createTestConfig(overrides?)`
factory per `review-completeness.md` CE-5. The factory pattern:

```ts
// src/__tests__/_helpers/createTestConfig.ts (new file)
export function createTestConfig(overrides?: Partial<ConfigFields>): Config {
  return new Config({
    PROJECT_ROOT: '/test/project',
    STORE_DIR: '/test/project/store',
    DB_FILENAME: 'claudeclaw.db',
    PID_FILENAME: 'claudeclaw.pid',
    WEB_PORT: 3420,
    WEB_HOST: '127.0.0.1',
    // ... the 58 fields, default-valued
    ...overrides,
  })
}
```

Each test rewrites:

```ts
// before
vi.mock('../config.js', () => ({ WEB_PORT: 4000 }))

// after
import { createTestConfig } from './_helpers/createTestConfig.js'
const config = createTestConfig({ WEB_PORT: 4000 })
// pass `config` into the SUT via constructor injection
```

### Files touched

- 1 new file: `src/__tests__/_helpers/createTestConfig.ts`.
- 154 test files — each rewrites its `vi.mock('../config.js', …)` site
  to use the factory. Per the M4 breakdown: 75 `async (orig)` + 56 `()`
  + 12 unparenthesised + 11 `async (importOriginal)` patterns.

### Risk level

**Medium-High.** 154 files is a large surface; the risk is
*inconsistency* (each test author picks a different pattern), not
*correctness* (the factory itself is simple). Per
`review-completeness.md` CE-5, the first 5-10 tests set the convention;
everything after copies it. The factory design must be **final**
before B.5 starts in earnest.

### Test coverage requirement

- The factory itself has a dedicated test (`createTestConfig.test.ts`)
  asserting that every field defaults correctly and that overrides are
  applied.
- Each rewritten test must pass.
- The end state: `grep -rh "vi\\.mock.*config\\.js" src/__tests__/ | wc -l`
  returns 0.

### Rollback strategy

Per-test-file revert. The factory is additive; reverting a single test
file restores its `vi.mock` site. The factory design is the load-bearing
piece; if the factory itself is wrong, all 154 rewrites need to be
re-done, which is why B.5 should land in **batches** (5-10 tests per
batch, with a verification run between batches).

### Parallelizable

**Yes** — the 154 test files can be rewritten in parallel by separate
agents, each handling ~10-15 files. The shared `createTestConfig.ts`
helper must land first; after that, each test is independent. The
factory design is the coordination point.

### Pre-conditions

- B.1 landed (the `Config` class exists with the 58 typed fields).
- B.2-B.4 consumer migrations far enough along that the tests'
  constructor-injection target is stable. Per `review-completeness.md`
  CE-5, B.5 should land **after** the bulk of the consumer migration
  to avoid double-rewrites (mock the module → use instance → mock the
  factory).

### Verification gate

- `grep -rh "vi\\.mock.*config\\.js" src/__tests__/ | wc -l` returns 0.
- `bun --bun vitest run` is green across the full suite.

---

## B.6 — Re-export shim removal (gated)

### Goal

Remove the `export const WEB_PORT = config.WEB_PORT` re-export shim
from `src/config.ts`. After B.6, the only way to read a config field
is `import { config } from './config.js'` (or via the
constructor-injected `config` parameter on the SUT).

### Files touched

- `src/config.ts` — delete all 58 `export const X = config.X`
  re-exports. Delete all 10 `export const f = Config.f` /
  `export const f = (...args) => config.f(...args)` shims.
- `src/config-registry.ts` — **no change** (B.7 territory).

### Risk level

**High.** This is irreversible. A direct const import that survived
to this point means a consumer was missed; reverting requires
restoring the shim, which means the shim must be **reversible** (kept
in git history) — easy enough since git preserves it.

### Test coverage requirement

- `grep -rln "from ['\"]\\./config\\.js['\"]" src/ --include='*.ts'`
  returns only `src/config-registry.ts` (the sibling import for
  `DISTRIBUTION_DEFAULT_AGENT_MODEL`) and `src/__tests__/_helpers/createTestConfig.ts`.
- `grep -rh "vi\\.mock.*config\\.js" src/__tests__/ | wc -l` returns 0.
- `bun --bun vitest run` is green across the full suite.

### Rollback strategy

`git revert <B.6 SHA>`. The shim is restored; B.6 is the only
irreversible B phase.

### Parallelizable

**No** — this is the last phase and must land in a single commit.

### Pre-conditions

- B.1-B.5 all landed and verified.
- The verification gate above is met.

### Verification gate

- All three preconditions met (zero direct const imports, zero
  `vi.mock`, full test suite green).
- Boot path test (`index.test.ts`) passes (proves the singleton is
  constructable and the keystones receive it).

---

## B.7 — `SettingsRegistry` verification (OE-8)

### Goal

Verify that `src/config-registry.ts` is unchanged (per
`review-completeness.md` OE-8) and add a one-paragraph note to
`docs/refactor-to-classbase/b-config/00-summary.md` documenting the
decision. **No source change.**

### Files touched

- `docs/refactor-to-classbase/b-config/00-summary.md` — add
  verification note (one paragraph).
- `src/config-registry.ts` — verified unchanged (no edits).

### Risk level

**Zero.** This is verification only.

### Test coverage requirement

- `grep -rln "define\|undefine" src/config-registry.ts` returns 0.
- `grep -rln "SETTINGS_REGISTRY\[" src/` returns 0.
- The 35-entry literal is byte-identical pre- and post-B.

### Rollback strategy

N/A (no source change).

### Parallelizable

**Yes** — runs concurrently with B.1-B.6; the only deliverable is a
documentation note.

### Pre-conditions

- None (OE-8 was a review finding; verification is independent of the
  B.1-B.6 phases).

### Verification gate

- `git diff main..feature-develop -- src/config-registry.ts` is empty.
- The verification note is added to `00-summary.md`.
- `bun --bun vitest run src/__tests__/settings-registry.test.ts`
  (if it exists) or `src/__tests__/settings-store.test.ts` is green.

---

## Cross-references

- **`00-summary.md`** — Top-3 risks, dependency table, migration order.
- **`03-class-boundaries.md`** — `Config` class public surface;
  `SettingsRegistry` rejection rationale.
- **`04-generic-interfaces.md`** — generics rejections (none survive
  OE-6).
- **`06-risks-and-mitigations.md`** — BR1 (60 importer blast radius);
  BR2 (154 vi.mock test surface); BR3 (env-read timing); BR4
  (SettingsRegistry OE-8 tripwire); BR5 (LoggerLike interaction with
  B); BR6 (HMR double-instantiation); BR7 (DEFAULT_AUTO_RESTART
  preservation).
- **`e-process-lock/03-class-boundaries.md:42 / :106`** — "introduce
  alongside, free-function-wrapper-survives" pattern precedent;
  informs B.1's additive shape and B.6's irreversible removal.
- **`d-channel-provider/03-class-boundaries.md:71 / :166`** —
  `ChannelEnv` constructor shape and free-function-removal precedent.
- **`f-agent-subsystem/03-class-boundaries.md §F1 / §F5`** —
  `HeartbeatScheduler` and `AutoRestartSchedule` consumers of `Config`;
  B.2 and B.4 dependencies.
- **`review-correctness.md`** — M2 (58 const exports); M4 (154
  vi.mock); M5 (60 importers); C6 (19 imports in index.ts, not 70+).
- **`review-completeness.md`** — OE-8 (SettingsRegistry); CE-5 (test
  factory design); CE-7 (heartbeat prompt-builder separation); CE-8
  (memory � db cross-call wiring).
