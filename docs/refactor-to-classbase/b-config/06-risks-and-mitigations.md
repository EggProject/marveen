# B (config) — Risks and mitigations

Risks specific to the B subsystem, ordered by severity (highest first).
Each risk: name, where-it-bites, mitigation, detection signal. Every
claim cites a specific file path or line; unverifiable claims are
marked `[ASSUMPTION]`.

**Reading note.** B is the type-cleanest subsystem in `src/`
(`02-type-interface-analysis.md §6` — zero unsafe casts in either file)
but the largest by blast radius (60 importers per `review-correctness.md`
M5; 154 `vi.mock` sites per M4). The risks below are dominated by
**migration ergonomics**, not type safety.

---

## BR1 — 60 importer blast radius on a keystone

### Where it bites

`src/config.ts` is imported by 60 files across `src/`, `src/web/`, and
the `channel-coordinator/`, `costops/`, `db/` subdirectories (per
`review-correctness.md` M5; `grep -rln "from ['\"]\\./config\\.js['\"]\|from
['\"]\\.\\./config\\.js['\"]" src/ --include='*.ts' | grep -v __tests__ | wc -l`
returns 60). The class extraction must be **phased** (B.1 additive →
B.2/B.3/B.4 consumer migration in low/mid/high-risk batches → B.5 mock
rewrite → B.6 re-export shim removal) because a single-commit refactor
would touch every consumer simultaneously.

High-risk importers (per `00-summary.md` "Top 3 risks" + direct grep):

- **`src/index.ts:13`** — imports 8 fields:
  `PROJECT_ROOT`, `STORE_DIR`, `PID_FILENAME`, `WEB_PORT`, `ALLOWED_CHAT_ID`,
  `MAIN_AGENT_ID`, `RESPAWN_ENABLED`, `HEARTBEAT_AGENT_ENABLED`.
  Touched in B.4 (class App construction).
- **`src/db.ts`** — reads `STORE_DIR`, `DB_FILENAME`, `PID_FILENAME`
  (`config.ts:13-15`). Touched in B.4 (DbClient constructor).
- **`src/web.ts:6`** — imports 5 fields: `PROJECT_ROOT`, `WEB_HOST`,
  `DASHBOARD_PUBLIC_URL`, `DASHBOARD_ALLOWED_ORIGINS`, `MAIN_AGENT_ID`.
  Touched in B.3 (DashboardServer constructor).
- **`src/heartbeat.ts`** — reads 6 fields:
  `HEARTBEAT_AGENT_ENABLED`, `HEARTBEAT_INTERVAL_MS`, `HEARTBEAT_START_HOUR`,
  `HEARTBEAT_END_HOUR`, `HEARTBEAT_CALENDAR_ACCOUNT`, `HEARTBEAT_CALENDAR_ID`.
  Touched in B.4 (HeartbeatScheduler constructor).
- **`src/auto-restart.ts`** — `DEFAULT_AUTO_RESTART` (L48).
  Touched in B.2 (AutoRestartSchedule).
- **`src/channel-coordinator.ts`** — reads `CHANNEL_PROVIDER`,
  `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`, `RESPAWN_ENABLED`,
  `SUBAGENT_INBOX_TEE`, `SUBAGENT_TELEGRAM_WAKE_ENABLED`.
  Touched in B.4.
- **`src/web/cron.ts:2`** — imports `APP_TZ`, `SCHEDULER_TZ_CONFIGURED`.
  Touched in B.3.
- **`src/web/schedule-runner.ts`** — reads `APP_TZ`, `APP_TZ_INVALID`
  (per L1029). Touched in B.3 / B.4.

### Mitigation

1. **B.1 is purely additive** — the 58 `export const` declarations
   become re-exports of `instance.<field>`, so every importer keeps
   working verbatim until its per-phase migration lands. Per
   `e-process-lock/03-class-boundaries.md:106` precedent (introduce
   alongside, free function survives).
2. **B.6's gate** (`grep -rln "from ['\"]\\./config\\.js['\"]" src/
   --include='*.ts' | grep -v __tests__` returns only `config.ts` itself
   plus `config-registry.ts`'s sibling import) is **mechanical** — easy
   to verify before the irreversible step.
3. **Per-phase rollback granularity** — each B.2/B.3/B.4 keystone
   migrates in its own commit; reverting one does not require
   reverting the others.
4. **The 60 importers do not change simultaneously** — the migration
   window (B.1 → B.6) is multiple weeks, not a single landing.

### Detection signal

- **Pre-B.1**: `grep -rln "from ['\"]\\./config\\.js['\"]" src/
  --include='*.ts' | grep -v __tests__ | wc -l` returns 60.
- **Post-B.5**: same command returns ~3-5 (the surviving free-wrapper
  imports + the `_helpers/createTestConfig.ts` test helper).
- **Post-B.6**: same command returns 0 (only `src/config-registry.ts`'s
  sibling import for `DISTRIBUTION_DEFAULT_AGENT_MODEL` survives, and
  that's a separate module path).

If at any point during B.2-B.5 the count drops by more than 5 in a
single commit, an importer was missed — investigate before proceeding.

---

## BR2 — 154 `vi.mock('../config.js')` test sites must be rewritten

### Where it bites

Per `review-correctness.md` M4 (verified by
`grep -rh "vi\.mock(" src/__tests__/ | grep -oE "vi\.mock\([^)]*config[^)]*\)" | wc -l`
returning 221 raw occurrences across 4 patterns: 75 `async (orig)` +
56 `()` + 12 unparenthesised + 11 `async (importOriginal)` for the
unique-pattern total of 154), this is the dominant test-rewrite cost
in the whole refactor. The migration is from
**module-replacement** (`vi.mock('../config.js', () => ({ WEB_PORT: 4000 }))`)
to **constructor-injection** (`new Config({ WEB_PORT: 4000 })`).

The pattern variations matter: the 4 patterns differ in how they
access the original module (`async (orig)` vs `() =>` vs bare path),
and the rewrite needs to handle each one.

### Mitigation

1. **`createTestConfig(overrides?)` factory** (per
   `review-completeness.md` CE-5) — designed **before** B.5 starts;
   the first 5-10 tests set the convention; everything after copies
   it. Per F.2 (`review-completeness.md` CE-5 cross-reference), the
   factory must be the **single source of truth** for test config.
2. **Batched rewrites** — 5-10 tests per batch with a verification
   run between batches. A factory bug caught early is a 5-test fix;
   caught late is a 154-test fix.
3. **B.5 lands after B.4** — the consumer-side migration must be far
   enough along that tests don't double-rewrite (mock the module →
   use instance → mock the factory).

### Detection signal

- **Pre-B.5**: `grep -rh "vi\.mock.*config\.js" src/__tests__/ | wc -l`
  returns ≥154.
- **Post-B.5**: same command returns 0.
- **`createTestConfig.test.ts`** asserts every field defaults correctly
  and overrides are applied — a factory regression is caught
  immediately.

---

## BR3 — `readEnvFile()` timing: when does `Config` re-read?

### Where it bites

Today `config.ts:17` reads `.env` at module-load:
`const env = readEnvFile()`. The 58 const exports are frozen at this
point — the only per-call re-reads are the 3 free functions
`currentBotName` (L168), `currentBrandName` (L172), `currentOwnerName`
(L175), each calling `readEnvFile(['KEY_NAME'])` for a single key.

After the class extraction, three options for env-read timing:

| Option | Reads from .env at boot? | Per-call re-read? | Test ergonomics |
|---|---|---|---|
| **(a) Eager (drop-in)** — `Config.fromEnv()` reads at construction | Yes | Only via instance methods (`currentBotName` etc.) | Tests do `new Config({ ... })` directly |
| **(b) Lazy** — `Config.fromEnv()` does not read; reads happen on first field access | No | Yes, on every field access | Tests do `new Config({ ... })` directly |
| **(c) Hybrid** — `Config.fromEnv()` reads, then `reload()` re-reads | Yes | Only via `reload()` | Tests do `new Config()` + `reload()` between cases |

### Recommended shape

**(a) Eager + `reload()` for tests.** Per
`02-type-interface-analysis.md §3.4`, the existing consts are frozen at
module load — the only consumer that re-reads is the 3 free functions.
The class form preserves this invariant: `Config.fromEnv()` reads once,
and the 3 instance methods (`currentBotName` etc.) provide per-field
re-reads (matching today's free-function behavior).

The `reload()` method (added per `02 §3.4`) is for **tests** that swap
`.env` between cases. In production, the 3 instance methods cover the
"operator renamed the bot" case (per the `currentBotName` comment at
L163-167 — "Per-call reads of the two display names, so a wizard rename
shows up on the dashboard without a process restart").

### Mitigation

- B.1's `Config.fromEnv()` is the **only** env-read site; the
  re-export shim's `export const WEB_PORT = config.WEB_PORT` reads the
  singleton's already-populated field, not `.env` again.
- `reload()` is the explicit re-read API; not called in production
  today but available for future HMR use.

### Detection signal

- **Post-B.1**: `grep -rn "readEnvFile" src/config.ts` returns 3 hits
  (the constructor + the 3 instance methods, in that order).
- **Behaviour parity test**: a test that mutates a fixture `.env`
  between cases and asserts the next call sees the new value (for the
  3 instance methods) vs. the old value (for all other fields).
- **No silent change**: `config.WEB_PORT` must equal
  `parseInt(process.env.WEB_PORT ?? '3420', 10)` in production;
  a test asserts this parity.

[ASSUMPTION: the 3 instance methods' per-call re-reads are intentional,
not a bug — verified by the L163-167 comment "Per-call reads of the
two display names, so a wizard rename shows up on the dashboard
without a process restart". This is the documented behaviour.]

---

## BR4 — `SettingsRegistry` decision (OE-8) is the single sharpest design tension

### Where it bites

The framework brief (per `review-completeness.md` OE-8) proposed
`SettingsRegistry.define`/`undefine` methods. The source argues
against: the array is frozen at module load (`config-registry.ts:37`,
35 entries), the 3 helpers are pure functions
(`getSettingDefinition`/`listSettingModules`/`validateSettingValue`),
and `define`/`undefine` would exist only for `vi.mock` test overrides
(which today mock the whole module).

The risk is **not** the source change (none — OE-8 = no change). The
risk is that an executor who hasn't read OE-8 might **re-introduce** the
class wrap as part of B.7 and silently ship a regression.

### Mitigation

1. **B.7 is verification only** — no code change, just a one-paragraph
   note in `00-summary.md` stating "OE-8 verified: registry stays as
   `const` + 3 free functions".
2. **The tripwire** — B.7 runs `git diff main..feature-develop --
   src/config-registry.ts` and asserts the diff is empty. Any
   unexpected change to the registry file fails B.7.
3. **The verification gate**:
   - `grep -rln "define\|undefine" src/config-registry.ts` returns 0.
   - `grep -rln "SETTINGS_REGISTRY\[" src/` returns 0.
   - The 35-entry literal is byte-identical pre- and post-B.

### Detection signal

- **`git diff main..feature/develop -- src/config-registry.ts`** is
  empty at B.7 completion.
- **`00-summary.md`** contains the OE-8 verification note.

If any of the three verification gates fails, OE-8 has been violated
and the violation must be reverted before B.7 closes.

---

## BR5 — `LoggerLike` integration with B (HR4 from H applies)

### Where it bites

Per `02-type-interface-analysis.md §1.7` (and re-verified in
`03-class-boundaries.md §B1`), `config.ts` has **2** `grep -nE
"logger\|log\." src/config.ts` hits — both in **comments** at L103 and
L376. The L103 comment explicitly explains the circular-import
constraint: `logger.ts` imports `config.ts` for the `APP_TZ_INVALID`
value, the logger uses in the boot banner.

A `Config` class **breaks this constraint** — an instance `Config` is
constructed *after* `logger.ts` has been imported (because classes are
constructed by their consumer, not at module-eval). So `Config` *could*
take a `LoggerLike` in its constructor.

Per `02 §3.6`, this is **rejected**: the loud `APP_TZ_INVALID`
reporting already works (it lives in `startScheduleRunner` per
`web/schedule-runner.ts:1029`); moving it into `Config.constructor()`
saves zero lines, adds a constructor dependency, and makes tests
noisier.

The risk is that an executor who hasn't read `02 §3.6` adds the
`log: LoggerLike` field, then every test that constructs `new Config()`
has to pass a logger — even tests that don't care about `APP_TZ_INVALID`.

### Mitigation

1. **`Config` does not have a `log: LoggerLike` field.** This is the
   `02 §3.6` decision, re-affirmed in `03-class-boundaries.md §B1`
   "Constructor" section.
2. **The L103 comment is preserved verbatim** in the class form — the
   circular-import explanation is still accurate (the *module* is
   still imported early; only the *class instance* is constructed
   late).
3. **The loud reporting stays in `startScheduleRunner`** — the consumer
   already has a logger via the framework's H.1 decision.

### Detection signal

- **Post-B.1**: `grep -rn "log: LoggerLike" src/config.ts` returns 0
  (the `Config` constructor takes no logger).
- **Behaviour parity test**: a test that sets `APP_TZ_INVALID` via a
  fixture `.env` and asserts `startScheduleRunner` (not `Config`) emits
  the warning.

---

## BR6 — HMR hazards: `Config` singleton double-instantiation

### Where it bites

If `src/config.ts` is imported twice under HMR (`tsx --watch`,
`vi.resetModules()`, a forked worker), the module-eval runs twice. The
existing `const env = readEnvFile()` at L17 runs twice (two reads of
the same `.env`, same result — no behavioural change). But after B.1,
`Config.fromEnv()` is called twice — **two `Config` instances** with
the same field values, but distinct identity.

If a test holds a reference to the first `Config` instance via the
`config` singleton and the HMR triggers a re-import, the second
instance becomes the new module-scope singleton. Code that captured
the first instance keeps reading the first instance; code that reads
`config.WEB_PORT` after HMR sees the second instance. **Two truths**.

This is the same pattern as `store-watcher.ts`'s double `fs.watch`
handle hazard (`f-agent-subsystem/00-summary.md` risk #2); B has a
similar shape.

### Mitigation

1. **`vi.resetModules()` is a known test hazard** — per
   `h-cross-cutting/06-risks-and-mitigations.md HR3`, the rule is
   "don't call `vi.resetModules()` in tests that hold a `config`
   reference". The `logger.test.ts:15` violation is flagged; B does
   not introduce a new violation.
2. **`reload()` is the explicit re-read API** — for tests that need
   to swap `.env`, `config.reload()` mutates the singleton's fields
   in place; no second instance.
3. **No module-scope mutation outside `Config`** — the 58 fields are
   `public readonly` on the instance; the instance is the only place
   they live. A second instance would not "merge" with the first.

### Detection signal

- **`bun --bun vitest run src/__tests__/config-class.test.ts`** with
  the HMR simulation (`vi.resetModules()` between cases) — if two
  `Config` instances have different field values for the same `.env`,
  the test fails.
- **`config.test.ts`** asserts that `config === Config.fromEnv()` (the
  singleton identity is preserved across calls in the same module).

[ASSUMPTION: HMR is not exercised by the production CI; the test
hazard is a known limitation per `f-agent-subsystem/00-summary.md
risk #2`, not a B-specific concern.]

---

## BR7 — `DEFAULT_AUTO_RESTART` frozen-const identity preservation

### Where it bites

`auto-restart.ts:48` exports `DEFAULT_AUTO_RESTART: AutoRestartConfig`
as a frozen const. Today it's imported by:

- `web/auto-restart-store.ts:7` — destructures
  `DEFAULT_AUTO_RESTART` for use as a fallback (`raw[name] ||
  DEFAULT_AUTO_RESTART`).
- `web/auto-restart-runner.ts` — uses for restart-schedule defaults.

Per `f-agent-subsystem/03-class-boundaries.md §F8`, F.5 extracts
`class AutoRestartSchedule` where `DEFAULT` is a `readonly` instance
field. The class form **also exposes `DEFAULT_AUTO_RESTART`** as a
module-level const (test-identity pin per `02 §AutoRestart deep-dive`).

After B.2, the const lives as a re-export of `config.DEFAULT_AUTO_RESTART`
on the singleton. The risk is that the const's **identity** changes
(if `config.DEFAULT_AUTO_RESTART` is a fresh object per
`Config.fromEnv()` call, the const identity is unstable across module
re-evaluations).

### Mitigation

1. **`DEFAULT_AUTO_RESTART` is built once** in `Config.fromEnv()`
   from `auto-restart.ts:48`'s `DEFAULT_AUTO_RESTART` literal — the
   re-export `export const DEFAULT_AUTO_RESTART = config.DEFAULT_AUTO_RESTART`
   preserves the singleton's instance identity (which is stable across
   module re-evaluations because `Config.fromEnv()` returns the same
   instance per `vi.mock` factory).
2. **Test compat**: per `02 §AutoRestart deep-dive` "the const's
   identity is captured by tests; mutating it would corrupt in-flight
   tests" — `Object.freeze(DEFAULT_AUTO_RESTART)` is the existing
   protection; B.1 preserves it by reference (not by copy).
3. **F.5's class form** (per `f-agent-subsystem/03-class-boundaries.md §F8`)
   reads `config.DEFAULT_AUTO_RESTART` once in its constructor; the
   readonly field is stable for the process lifetime.

### Detection signal

- **`auto-restart-store.test.ts`** and
  **`auto-restart-runner.test.ts`** pass post-B.2.
- **`config.test.ts`** asserts `config.DEFAULT_AUTO_RESTART ===
  DEFAULT_AUTO_RESTART` (identity preservation).
- **`Object.isFrozen(DEFAULT_AUTO_RESTART)` returns `true`** (the
  existing freeze is preserved).

---

## Summary risk table

| Risk | Severity | Detection signal |
|---|---:|---|
| BR1 — 60 importer blast radius | High | `grep -rln "from ['\"]\\./config\\.js['\"]"` count drops |
| BR2 — 154 `vi.mock` test rewrites | High | `grep -rh "vi\.mock.*config\.js" src/__tests__/ | wc -l` returns 0 |
| BR3 — `readEnvFile()` timing | Medium | `grep -rn "readEnvFile" src/config.ts` returns 3 |
| BR4 — `SettingsRegistry` OE-8 tripwire | Medium (latent) | `git diff main..feature/develop -- src/config-registry.ts` empty |
| BR5 — `LoggerLike` integration | Low (latent) | `grep -rn "log: LoggerLike" src/config.ts` returns 0 |
| BR6 — HMR double-instantiation | Low | `vi.resetModules()` test parity |
| BR7 — `DEFAULT_AUTO_RESTART` identity | Low | `Object.isFrozen(DEFAULT_AUTO_RESTART)` true |

---

## Cross-references

- **`00-summary.md`** — Top-3 risks; dependency table.
- **`03-class-boundaries.md`** — class shape; `Config` no-logger
  decision.
- **`05-refactor-roadmap.md`** — phased migration order; B.6's
  mechanical gate.
- **`02-type-interface-analysis.md §3.6`** — `Config.log: LoggerLike`
  rejection (BR5 mitigation source).
- **`02-type-interface-analysis.md §3.4`** — `reload()` rationale (BR6
  mitigation source).
- **`review-correctness.md`** — M2 (58 consts); M4 (154 vi.mock); M5
  (60 importers); R2 (config.ts keystone).
- **`review-completeness.md`** — OE-8 (SettingsRegistry); CE-5 (test
  factory); CE-15 (logger singleton vs constructor-injected).
- **`f-agent-subsystem/00-summary.md`** — precedent for risk #2 (HMR
  double-init).
- **`h-cross-cutting/06-risks-and-mitigations.md`** — HR3 (vi.resetModules
  rule); HR4 (LoggerLike 626 object-first vs 76 string-first split).
- **`e-process-lock/03-class-boundaries.md:106`** — "introduce
  alongside, free-function-wrapper-survives" pattern (BR1 mitigation).
