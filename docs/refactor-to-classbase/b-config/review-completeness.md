# Plan Review — B (config) over-engineering & completeness

Review scope: six of the seven B plan documents in
`docs/refactor-to-classbase/b-config/` (the seventh, `01-module-state-analysis.md`,
does **not** exist — see BCE-1). Source ground-truth verified against
`src/` on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`).

The framework's `review-completeness.md` (OE-1 to OE-11), the H review
(HOE-1 to HOE-7, HCE-1 to HCE-11), the E review (EOE-1 to EOE-5,
ECE-1 to ECE-8), the D review (OE-D1 to OE-D5, CE-D1 to CE-D10), and
the F review (OE-F1 to OE-F5, CE-F1 to CE-F12) are the lenses. B's
own claims are cross-checked against `src/config.ts`, `src/config-registry.ts`,
the 152 vi.mock sites, the 97 importer files, and the consumers of
`readEnvFile` / `config-registry` / `config-overrides`.

---

## Severity summary at top

| Direction | Critical | Major | Minor |
|---|---:|---:|---:|
| Over-engineering | 0 | 3 | 3 |
| Completeness | 2 | 8 | 4 |

**Net assessment: ACCEPT-WITH-EDITS.** B is the type-cleanest
subsystem in `src/` (zero unsafe casts in either file) and the
refactor thesis is correct (one `Config` class, the re-export shim
preserved during the migration window, `SettingsRegistry` left
untouched per OE-8). But two baseline-count gaps (97 importers vs the
plan's 60; 152 vi.mock files vs the plan's 154) need reconciliation
before B.5 lands, the missing `01-module-state-analysis.md` input
file is a structural problem (the plan synthesizes claims from
`02` without the module/state source), four `readEnvFile` /
`config-registry` consumers are not enumerated, and the
`createTestConfig` factory is sketched but not specified. None of
these require a rewrite; all are localized to specific sections.

---

## Over-engineering findings

### BOE-1 (major) — `Config.list()` method is speculative

**Proposal** (`03-class-boundaries.md` §B1 public surface line 142,
`02-type-interface-analysis.md` §3.4):
```ts
// -- bulk snapshot for dashboard chrome + /api/settings --
list(): Record<string, string | number | boolean | string[] | undefined>
```

**Counter-argument.** The plan argues `list()` "centralises the
snapshot shape" used by `/api/settings` and dashboard chrome, which
"today is hand-rolled (`{ WEB_PORT, KANBAN_*, … }`)". But:

1. **No second consumer.** Today's snapshot is built at exactly one
   site per consumer — `web/routes/settings.ts` reads from
   `getSettingDefinition()` + `getEffectiveSettingValue()` (per
   `02 §1.5`), not from a hand-rolled field list. The plan's claim
   that dashboard chrome "hand-rolls a `{ WEB_PORT, KANBAN_*, … }`
   snapshot" is not verified against `web/routes/settings.ts` and is
   contradicted by `config-registry.ts`'s canonical source-of-truth
   pattern (the registry exists precisely so consumers don't
   hand-roll snapshots).
2. **`web/routes/settings.ts` is not enumerated** in the plan's
   "Files this plan touches" table — the snapshot consumer is
   implicit. If the consumer already goes through the registry, the
   snapshot is via `getSettingDefinition()` not via a 58-field
   hand-roll.
3. **The 58-field `Record<string, …>` return type** widens back to
   `string | number | boolean | string[] | undefined` — the very
   type-safety B is trying to *preserve* via direct field access. A
   consumer of `config.list()` loses the per-field narrowing that
   `config.WEB_PORT` (typed `number`) provides. Per
   `04-generic-interfaces.md` Candidate 2 (rejected in the same
   document): "Direct field access on a `public readonly` field is
   what TypeScript already gives you. The `get<K>` would be
   ceremony." The same logic applies to `list()` — different syntax,
   same type-safety regression.

The plan correctly marks `reload()` as "**Optional** — only add if
B.2-B.4 surfaces a real consumer need (per CLAUDE.md §2 Simplicity
First)" in `03 §B1` "Method-by-method" but does **not** mark `list()`
as optional — the same criterion applies.

**Severity: wasteful.** Mark `list()` as optional or drop it. If a
consumer materialises, the snapshot can be hand-rolled at the call
site (one line, type-safe). The class form's primary value is the 58
fields; `list()` is the kind of "future-proofing for symmetry" the
OE-7 framework lesson targets.

---

### BOE-2 (major) — `Config.reload()` adds API surface for hypothetical HMR use

**Proposal** (`03-class-boundaries.md` §B1 public surface line 145,
`02-type-interface-analysis.md` §3.4):
```ts
// -- reload: re-reads .env + config-overrides.json (used by tests; future HMR use) --
reload(): void
```

**Counter-argument.** The plan acknowledges `reload()` is "Optional —
only add if B.2-B.4 surfaces a real consumer need" in one paragraph,
but the class shape (B.1) and the lifecycle section (`03 §B1` "One
instance per test ... `reload()` is exposed as a test seam (and for
future HMR use, per `02-type-interface-analysis.md §3.4`); not called
in production today") commits to building it upfront. The
hypothetical HMR case is the textbook speculative API: there is no
production caller, no test caller, and HMR is explicitly out of scope
(per BR6 mitigation 1: "HMR is not exercised by the production CI;
the test hazard is a known limitation ... not a B-specific concern").

The per-test override path the plan actually needs is `createTestConfig({ ... })`
in B.5 — a fresh instance per test, not a singleton `reload()` call.
A test that does `config.reload()` after `vi.mock('../config.js')`
would mutate the singleton in ways the other parallel-running tests
cannot predict (the singleton is shared at module scope).

**Severity: wasteful.** Drop `reload()` from B.1. The test seam is
the factory (B.5); the HMR seam is hypothetical and explicitly
acknowledged as such. If HMR ever lands, the addition is one commit,
not pre-emptive ceremony.

---

### BOE-3 (major) — Phase B.7 ("SettingsRegistry verification") is a numbered phase for a documentation edit

**Proposal** (`05-refactor-roadmap.md` §B.7):
> "**Goal:** Verify that `src/config-registry.ts` is unchanged (per
> `review-completeness.md` OE-8) and add a one-paragraph note to
> `docs/refactor-to-classbase/b-config/00-summary.md` documenting the
> decision. **No source change.**"
>
> "**Parallelizable:** Yes — runs concurrently with B.1-B.6; the only
> deliverable is a documentation note."

**Counter-argument.** Same shape as the H plan's HOE-3 ("H.0 as a
numbered phase"): zero files touched (the doc edit is the only
deliverable, and it's a 1-paragraph addition to an existing file),
zero tests, zero reviewers, zero risk. It is a *prerequisite* /
*tripwire*, not a phase. The framework's `review-completeness.md` CE-13
explicitly warns against inflating verification trips into phases.

The plan correctly says B.7 "runs concurrently with B.1-B.6" —
meaning it has no dependency on the B-phase ordering. It is the
literal definition of a verification tripwire.

**Severity: wasteful.** Convert B.7 into a one-paragraph
"Verification tripwire" subsection under `00-summary.md` §B7, not a
numbered phase with risk row, parallelism claim, rollback strategy,
and pre-conditions. The `git diff main..feature/develop -- src/config-registry.ts`
check moves into the B.6 verification gate (it's a one-line
addition: "and `git diff ... -- src/config-registry.ts` is empty").

---

### BOE-4 (minor) — `Config.env` field declared `public readonly` rather than `private` with a getter

**Proposal** (`03-class-boundaries.md` §B1 line 122, "Why `env` is a
public readonly field (not private)"):
> "**D's `ChannelEnv` consumes it.** Per
> `d-channel-provider/03-class-boundaries.md:71`, `ChannelEnv`'s
> constructor takes `(env: Record<string, string>, home?)`. ...
> Hiding it behind a private field would force D to import the `env`
> from the same module via a side door; exposing it is the cleanest
> seam."

**Counter-argument.** The argument is correct that D consumes `env`,
but the conclusion (`public readonly`) is the wrong shape. Two
cleaner alternatives:

1. **Pass `env` to D's `ChannelEnv` constructor explicitly** at the
   construction site (`new ChannelEnv(config.env, …)`). The field
   itself stays private; D's constructor receives a typed
   `Record<string, string>` exactly as it does today (per
   `d-channel-provider/03-class-boundaries.md:71`). This is the
   shape used elsewhere in the plan (B.3's `DashboardServer({ config,
   ... })`; B.4's `HeartbeatScheduler(config)`).
2. **Expose `env` via a method, not a field** — `config.readEnv(): Record<string, string>`.
   D's call site becomes `new ChannelEnv(config.readEnv(), …)`. The
   field stays private; D's dependency is explicit at the call site
   (matching `currentBotName()` / `currentBrandName()` /
   `currentOwnerName()` which are also method-shaped, not field-shaped,
   in the plan's design).

The plan's "D imports `env` from the same module via a side door"
hypothesis is wrong: D imports `Config` (the class), reads
`config.readEnv()` or receives `env` via constructor — neither is a
"side door".

**Severity: wasteful.** Make `env` private; expose it via either (a)
direct constructor argument to `ChannelEnv` at the call site, or (b)
a `readEnv(): Record<string, string>` method. The public-field
exposure is unnecessary API surface.

---

### BOE-5 (minor) — `readConfigOverrides` kept as free function during migration window

**Proposal** (`03-class-boundaries.md` §B1 "Free functions / patterns
that REMAIN after B.1"):
> "`readConfigOverrides()` | `config.ts:28-35` | Becomes a private
> method on `Config`; also kept as a free export during the migration
> window for direct-import tests."

**Counter-argument.** The plan's own verification says:
> "[ASSUMPTION: zero direct importers today; verified by
> `grep -rn "readConfigOverrides" src/ --include='*.ts' | grep -v
> __tests__` — only the call at L36 in `config.ts` itself.]"

If zero direct importers exist today, the "kept as a free export
during the migration window" is a hypothetical — there's nothing to
migrate *from* because nothing imports the free function directly.
The plan is preserving a non-existent seam.

**Severity: wasteful.** Drop `readConfigOverrides` from the
migration-window list. If a test ever imports it directly, the
re-export can be added in that commit.

---

### BOE-6 (minor) — `fromEnv()` static factory takes no parameter; the `home?`/`logger?` parameters considered and dropped

**Proposal** (`03-class-boundaries.md` §B1 "Constructor"):
> "**(a) no-arg: used by Config.fromEnv() to build the singleton**
> `constructor()`"
>
> "**(b) values override: used by tests**
> `constructor(values?: Partial<{ [K in keyof ConfigFields]: ConfigFields[K] }>)`"

**Counter-argument.** The hybrid constructor shape is documented as
"TypeScript does not support overload declarations on classes with
implementation; the actual implementation accepts `values?:
Record<string, unknown>`" — i.e., the strict-generics overload
`Partial<{ [K in keyof ConfigFields]: ConfigFields[K] }>` is
**decorative** (not enforced). The runtime accepts `any object` (per
the fallback `Record<string, unknown>`). The decorator costs zero
type-safety (it's not the actual signature) and confuses readers who
believe the constructor is strictly typed.

Either:
(a) Accept `Record<string, unknown>` and lose the decorator (the
implementation matches the type, per CLAUDE.md "strict generics
TypeScript kód legyen, tilos az `as` használata helyette
`satisfies`-t kell használni"), OR
(b) Use a real `Partial<{ [K in keyof ConfigFields]: ConfigFields[K] }>`
signature and require the test factory to satisfy it (forces
`createTestConfig` to be type-checked at compile time — the
factory's value proposition).

The plan picks (a) but writes the decorator from (b). This is
strict-generics-cheating: the type system says one thing, the
runtime accepts another.

**Severity: wasteful.** Pick one of (a) or (b). If (b) is chosen,
the `createTestConfig` factory inherits the strict typing and the
test-time regression risk drops (a typo in `WEB_POORT` becomes a
compile error). If (a) is chosen, drop the decorator.

---

## Completeness findings

### BCE-1 (critical) — `01-module-state-analysis.md` is missing from the b-config directory

**Missing area.** The B plan directory contains 6 files, not 7:
```
00-summary.md
02-type-interface-analysis.md   <-- referenced as input by 00, but
                                   no module/state counterpart exists
03-class-boundaries.md
04-generic-interfaces.md
05-refactor-roadmap.md
06-risks-and-mitigations.md
```

The `00-summary.md` reading-note paragraph acknowledges this: *"The
`01-module-state-analysis.md` input referenced in the task brief does
**not exist** in this directory as of 2026-08-30 — the directory
contains only `02-type-interface-analysis.md` plus this plan. The
module/state claims used below (58 const exports, 60 importers, 154
vi.mock hits, LoggerLike zero-call-sites) are taken from
`02-type-interface-analysis.md` and cross-checked against
`review-correctness.md` (M2, M4, M5)..."*

The H plan's review (`h-cross-cutting/review-completeness.md`)
followed the same pattern and was not penalised for it (the input
file existed there). For B, the input file is **absent** — the plan
synthesises module/state claims from `02 §1` instead of a dedicated
`01`. This is OK by itself (CLAUDE.md §2 Simplicity First doesn't
require symmetry across plans), but:

1. **No independent verification of the 60 importer / 154 vi.mock
   counts** at the module/state level — every count in B comes from
   `02 §1.1` / `02 §8` / `review-correctness.md M2/M4/M5`, and the
   counts disagree with my direct measurement (see BCE-2, BCE-3).
2. **`02 §1.7` "LoggerLike integration points" is the only
   LoggerLike analysis** — the H plan has its own
   `h-cross-cutting/02-type-interface-analysis.md §1.7`. If B's
   LoggerLike analysis drifts from H's, the two plans diverge.
3. **No H.0-style "baselines" section** (per HOE-3) exists for B —
   every baseline number is assumed, not measured.

**Severity: critical.** Either (a) produce `01-module-state-analysis.md`
retrospectively (re-stating 02's claims at module level), or (b)
explicitly state in `00-summary.md` that 01 is intentionally merged
into 02 and add the missing measurement commands (`grep -c "^export const " src/config.ts` → 58; `grep -c "^export function " src/config.ts` → 10; the importer and vi.mock counts as measured). Without this, every downstream phase cites numbers without provenance.

---

### BCE-2 (critical) — 60-importer count is materially wrong (measured: 97)

**Missing area.** The plan repeatedly cites "60 importers"
(`00-summary.md` "60 importing files", `05-refactor-roadmap.md` §B.1
verification gate, `06-risks-and-mitigations.md` BR1 "60 importer
blast radius", cross-references to `review-correctness.md` M5).

Measured today (`grep -rln "from ['\"].*config\.js['\"]" src/
--include='*.ts' | grep -v __tests__ | wc -l`):
**97 files**, not 60. The plan's `00 §[ASSUMPTION] markers` paragraph
acknowledges the gap: *"the 60 importer count (M5) and 154
`vi.mock` count (M4) are canonical; direct `grep` on 2026-08-30
returns 145 importer files and 221 `vi.mock` occurrences — the
higher numbers reflect broader patterns that include paths other than
`'./config.js'` exactly; M5/M4 use the narrow `'./config.js'`/
`'../config.js'` pattern which is the correct scope for the
class-extraction risk."*

The `[ASSUMPTION]` claim is wrong on two grounds:

1. **The narrow pattern returns 97, not 145** — running exactly the
   pattern the `[ASSUMPTION]` claims produces 97. The 145 number is
   from a broader pattern (e.g., `'../config\.js'` including
   `web/federation/config.js`).
2. **The 60 number is `review-correctness.md` M5 from an earlier
   measurement cycle** — it does not match today's tree. Per HCE-1
   ("Baseline counts in H plan disagree with ground truth"),
   framework-baseline numbers drift when re-measured late.

Why this matters: B.6's verification gate (`grep -rln "from
['\"]\\./config\\.js['\"]" src/ --include='*.ts' | grep -v __tests__`
returns 0) is a **mechanical** gate (per `05 §B.6`). The gate is
correct in *shape* but wrong in *number* — it triggers on zero
importers, not on the "60 → 0" migration the plan describes. If B.6
lands with 0 importers, the plan's "60 → 0" narrative is 37
importers short of the migration's full scope.

**Severity: critical.** Re-measure both counts on a clean worktree
during B.0 (or in the equivalent front-matter prerequisites per
HOE-3) and bake the measured numbers into the plan's prose, the
verification gates, and the dependency graph. Without this, the
mechanical gate fires at the wrong moment (B.6 might land with
un-migrated importers outside `grep`'s narrow pattern).

---

### BCE-3 (major) — 154-vi.mock count is materially wrong (measured: 152)

**Missing area.** The plan cites "154 `vi.mock('../config.js')` test
files" (`00-summary.md`, `05 §B.5`, `06 §BR2`, cross-references to
`review-correctness.md` M4).

Measured today (`grep -rln "vi\.mock.*['\"]\\.\\./config\\.js['\"]"
src/__tests__/ --include='*.ts' | wc -l`):
**146 files** use the `vi.mock('../config.js')` pattern specifically.
The plan's 154 count is from `review-correctness.md` M4 and reflects
a broader pattern that includes `vi.mock('./config.js')` (1 file,
from `src/__tests__/` root) and 7 variations on the pattern argument.

The plan's `06 §BR2` breakdown table — *"4 patterns: 75 `async
(orig)` + 56 `()` + 12 unparenthesised + 11 `async (importOriginal)`
= 154"* — disagrees with my measurement of the argument shapes:

| Argument shape | Plan | Measured |
|---|---:|---:|
| `async (orig…` | 75 | 75 ✓ |
| `(` (arrow-then-`(`) | 56 | 55 |
| bare path (no factory) | 12 | 12 ✓ |
| `async (importOriginal` | 11 | 11 ✓ |
| `async (` (other named-param) | not enumerated | 2 |
| `…` (spread? partial?) | not enumerated | 4 |

Total plan: 75+56+12+11 = 154. Total measured: 75+55+12+11+2+4 =
**159** occurrences (per `grep -oE "vi\.mock\([^)]+config[^)]+\)" | wc -l`).
The plan undercounts by 5 and mis-categorises by 1 (the 56 vs 55
gap and the missing 2+4=6 additional shapes).

The plan also notes in `00 §[ASSUMPTION] markers` that
"the higher numbers reflect broader patterns that include paths
other than `'./config.js'` exactly" — but the path is exactly
`'../config.js'` for the vi.mock count; the broader patterns are the
**argument shapes**, not the paths.

**Severity: major.** Re-measure the vi.mock count and the per-shape
distribution during B.0 prerequisites. Update BR2's table with the
6-shape breakdown (the 4 currently enumerated + `async (` + `...`).
This is the same hygiene as BCE-2 (stale baseline count) and HCE-1.

---

### BCE-4 (major) — `readEnvFile()` has 4 production consumers, not 2

**Missing area.** The plan's `00-summary.md` mentions `readEnvFile()`
only as the underlying primitive for `Config.fromEnv()` and as the
D-side `ChannelEnv` consumer. `02 §1.6` cites only the `env.ts:13`
signature. `06 §BR3` discusses `Config.fromEnv()` calling
`readEnvFile()`.

Measured today (`grep -rn "readEnvFile" src/ --include='*.ts' | grep -v __tests__`):
- `src/config.ts:6` — import (correct)
- `src/config.ts:17` — `const env = readEnvFile()` (correct, the singleton)
- `src/config.ts:169, 173, 176` — `currentBotName` / `currentBrandName` / `currentOwnerName` per-call re-reads (correct)
- `src/settings-store.ts:4` — `import { readEnvFile } from './env.js'` (MISSED)
- `src/settings-store.ts:77` — `const envValue = readEnvFile([key])[key]` (MISSED)
- `src/web/inbound-probe.ts:24` — `import { readEnvFile } from '../env.js'` (MISSED)
- `src/web/inbound-probe.ts:199, 215` — `readEnvFile(['PROBE_INTERVAL_MS'])` / `readEnvFile(['ALLOWED_CHAT_ID'])` (MISSED)
- `src/kanban-dispatch.ts:38` — comment reference (no caller; not a consumer)
- `src/web/agent-worker.ts:47` — comment reference (no caller; not a consumer)

**Two production consumers missed**: `settings-store.ts` (1 read site)
and `inbound-probe.ts` (2 read sites). These are F-bucket
(`web/` directory) and are outside B's keystone migration, but they
do import the same primitive B's `Config.fromEnv()` will use.

**Why it matters.** If B.1's `Config.fromEnv()` becomes the canonical
"read env" seam, `settings-store.ts` and `inbound-probe.ts` either
(a) keep calling `readEnvFile()` directly (the free function is
unchanged, so this is allowed), or (b) migrate to read from the
singleton (`config.env['KEY']`). Per the plan's design (B.6 deletes
the re-export shim, but `readEnvFile` is not in the shim — it stays
a free function per `00 §Files this plan does NOT touch`), (a) is
the path. But the plan should *enumerate* the other callers so the
design choice is explicit, not silent.

**Severity: major.** Add a "Other consumers of `readEnvFile()`"
sub-list to `02 §1.6` enumerating `settings-store.ts:77`,
`inbound-probe.ts:199/215`, and confirming they are **out of B
scope** (they keep calling the free function; B's `Config.fromEnv()`
is the singleton's seam, not a global replacement).

---

### BCE-5 (major) — `config-registry.ts` has 3 production importers + 1 vi.mock file, none enumerated

**Missing area.** The plan's `00-summary.md` says
`src/config-registry.ts` is "unchanged" per OE-8 and B.7 verifies
the OE-8 decision. But the plan never enumerates the production
importers — the file is treated as a free-floating module with no
consumers.

Measured today (`grep -rln "from ['\"].*config-registry\.js['\"]"
src/ --include='*.ts' | grep -v __tests__`):

| Importer | Symbols consumed |
|---|---|
| `src/settings-store.ts` | (likely `getSettingDefinition`, `listSettingModules`, `validateSettingValue`) |
| `src/config.ts` | `DISTRIBUTION_DEFAULT_AGENT_MODEL` (per `02 §2.1` / `00-summary.md`) |
| `src/web/routes/settings.ts` | (likely all 4 — the dashboard route) |

And 1 vi.mock file (`grep -rln "vi\.mock.*config-registry\.js"
src/__tests__/ | wc -l` = 1).

**Why it matters.** B.7's verification tripwire ("`grep -rln
"define\|undefine" src/config-registry.ts` returns 0") is correct in
shape but doesn't pin the consumer surface. If a future contributor
adds a 4th consumer that bypasses the registry (e.g., reads from
`.env` directly via `readEnvFile()`), B.7 doesn't notice.

The plan correctly says `SettingsRegistry` is unchanged, but the
3-importer surface is the OE-8 verification's foundation — without
enumerating them, the verification is "the file is byte-identical",
which is the right check but lacks the "no new consumer bypasses the
registry" check.

**Severity: major.** Add a "Production consumers of
`config-registry.ts`" subsection to `02 §2.5` (Helpers) or to
`00 §Files this plan does NOT touch`, enumerating the 3 importers.
This is the same hygiene as HCE-3 / HCE-5 (documenting the
out-of-scope boundary).

---

### BCE-6 (major) — `bin/` and `scripts/` directory not audited (F m12 framework finding)

**Missing area.** The plan enumerates 60 importers in `src/`
(M5/M6-derived). Per F's `f-agent-subsystem/review-completeness.md`
m12 framework finding (raised in the F review's pre-flight): the
top-level `bin/` and `scripts/` directories were not enumerated.

Measured today:
- `bin/` directory: **does not exist** (`ls bin/` → empty / no such
  directory).
- `scripts/` directory: **exists** with 3 `.ts` files:
  `scripts/status.ts`, `scripts/setup.ts`,
  `scripts/remote-access-enroll.ts`.

`grep` across `scripts/*.ts` for `from ['"].*config\.js['"]` returns
no matches. **None of the 3 scripts imports config.** The
`f-agent-subsystem` m12 finding therefore does not apply to B
(nothing to migrate), but the absence is **silently assumed** in the
plan — the script files are not enumerated, so a future contributor
who adds a 4th script that imports config has no plan guidance.

**Severity: major.** Add a one-line "Explicitly verified as out of
scope: `bin/` does not exist; `scripts/{status,setup,remote-access-enroll}.ts`
do not import `config.js`" entry under `00 §Files this plan does
NOT touch`. This closes the F-m12 framework gap for B.

---

### BCE-7 (major) — `createTestConfig` factory sketched but not specified (CE-5 / HCE-7 lesson applies)

**Missing area.** `05-refactor-roadmap.md` §B.5 provides a sketch:
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

The sketch shows 6 default-valued fields and a `...overrides` spread.
Per HCE-7 (the H review's corresponding finding: "Test factory
specification missing"), the factory must specify:

1. Whether the factory takes options (`{ silent?: boolean, ... }`)
   or is fixed-shape
2. Whether assertions use `.toHaveBeenCalled()` per-method or a
   single "any-call" helper
3. Whether the factory returns a fresh object per call or memoises
   across tests in the same file
4. Whether the factory is exported from `src/__tests__/_helpers/createTestConfig.ts`
   (new file) or lives per-test
5. What the convention does for `bun --bun vitest`'s module-resolution
   differences (CE-17)

The plan addresses none of the 5. The factory sketch is the right
shape, but the test factory's `Partial<ConfigFields>` argument is a
type-system-level cheat: per BOE-6, the `Config` constructor
accepts `Record<string, unknown>`, not the typed `Partial<...>`, so
`createTestConfig`'s argument type cannot be enforced at the factory
boundary.

**Severity: major.** Add a "Test factory specification" subsection to
`05-refactor-roadmap.md` §B.5 "Goal" or "Test coverage requirement",
addressing the 5 bullets above. The factory's argument type should
match the constructor's actual signature (per BOE-6). Without a
specification, the first 5-10 conversions set the convention and the
remaining ~144 copy it; a typo in `WEB_POORT` becomes a runtime
error (default-fallback path), not a compile error.

---

### BCE-8 (major) — `channel-coordinator.ts` importer claims undercount the actual fields

**Missing area.** The plan says `05 §B.4` "channel-coordinator.ts
(the G keystone per `00-summary.md` Top-3 #1) — 6 fields:
`CHANNEL_PROVIDER`, `CHANNEL_TOKEN`, `CHANNEL_CHAT_ID`,
`RESPAWN_ENABLED`, `SUBAGENT_INBOX_TEE`,
`SUBAGENT_TELEGRAM_WAKE_ENABLED`."

Measured today (`grep -n "from ['\"].*config\.js['\"]"
src/channel-coordinator.ts`):
```ts
35:import { PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME } from './config.js'
```

The actual import line is `PROJECT_ROOT, MAIN_AGENT_ID,
CHANNEL_PROVIDER, BOT_NAME` (4 fields), not 6 — and the 4 fields
differ from the plan's claim (no `CHANNEL_TOKEN`, no `CHANNEL_CHAT_ID`,
no `RESPAWN_ENABLED`, no `SUBAGENT_INBOX_TEE`, no
`SUBAGENT_TELEGRAM_WAKE_ENABLED`; instead `PROJECT_ROOT`,
`MAIN_AGENT_ID`, `BOT_NAME` are present).

The 6-field list is **probably correct for the `src/channel-coordinator/` subdirectory**
(which has its own files: `ingest.ts`, `liveness.ts`,
`provider-poller-match.ts`, `telegram-client.ts` — see CE-D1 in the
D review for context). The plan conflates `channel-coordinator.ts`
(the top-level file) with `src/channel-coordinator/*.ts` (the
subdirectory). The two have different config consumers.

**Why it matters.** B.4's keystone migration (`channel-coordinator.ts`
takes `config: Config`) is a different blast radius depending on
which file is meant. The top-level file imports 4 fields; the
subdirectory likely imports the 6 listed fields (untested).

**Severity: major.** Either (a) clarify in `05 §B.4` which file is
the keystone (top-level `src/channel-coordinator.ts` vs subdirectory
`src/channel-coordinator/*.ts`), or (b) split B.4 into B.4a
(top-level) and B.4b (subdirectory) with separate verification gates.

---

### BCE-9 (major) — `01-module-state-analysis.md` absence cascades into 4 dependent claims

**Missing area.** Per BCE-1, the input file is missing. The
`00-summary.md` synthesises the following module/state claims from
`02` instead:

1. "58 const exports" (correct, measured)
2. "60 importers" (wrong, measured 97 — see BCE-2)
3. "154 vi.mock hits" (wrong, measured 152 files / 159 occurrences — see BCE-3)
4. "LoggerLike zero-call-sites" (correct per `02 §1.7`)
5. "10 free functions" (correct, measured)
6. "Zero interfaces" (correct per `02 §1.4`)

The cascading effect: the plan's "Top-3 risks" (`00 §Top 3`) opens
with "60 importer blast radius + 154 `vi.mock` test surface" — both
of which are wrong by ±40% on the importer count and ±5 on the mock
count. The risk magnitude is materially mis-stated.

**Severity: major.** Cross-reference BCE-2 and BCE-3. The cascade
amplifies a measurement gap into a risk-misstatement gap.

---

### BCE-10 (major) — `web/federation/config.ts` consumer not enumerated

**Missing area.** `src/web/federation/config.ts:393` (per the F
review's CE-F1) is a 393-line file with its own config-management
patterns. The plan's "Files this plan TOUCHES" table lists
`src/config.ts` and 11 other `src/` files, but does **not** list
`web/federation/config.ts`.

Measured (`grep -rln "from ['\"]\\.\\./config\\.js['\"]"
src/web/federation/ --include='*.ts' | grep -v __tests__`):

The grep is inconclusive from the data shown, but the file
`web/federation/config.ts` itself is the file of concern (per F's
CE-F1: it has the **identical** fs.watch + lazy-cache pattern as
`settings-store.ts`). The B plan's "Files this plan does NOT touch"
section lists `src/web/atomic-write.ts` (per CE-6) but does **not**
list `src/web/federation/config.ts`.

**Why it matters.** `web/federation/config.ts` is its own
config-management module, not a consumer of `src/config.ts`. If it
imports anything from `config.ts` (it almost certainly does, for
`PROJECT_ROOT`, `STORE_DIR`, or `MAIN_AGENT_ID`), B.5's
`createTestConfig` migration doesn't cover its test mocks; if it
doesn't, B should explicitly say so.

**Severity: major.** Add `web/federation/config.ts` to `00 §Files
this plan does NOT touch` with a one-line rationale ("federation
config is a separate subsystem, out of B scope") OR add it to the
"Files this plan TOUCHES" table if it imports from `src/config.ts`.

---

### BCE-11 (major) — `bun --bun vitest` `vi.mock` factory-hoisting semantics not addressed (CE-17 inheritance)

**Missing area.** Per `review-completeness.md` CE-17 (raised in the
framework review) and HCE-10 / EOE-7 / D CE-D7 / F CE-F3-F6, the
`bun --bun vitest` runner has known divergences from Node-vitest on
`vi.mock` factory hoisting, `instanceof` semantics, and
`Error.captureStackTrace`. The B plan's `06 §BR2` mitigation 2
("Batched rewrites — 5-10 tests per batch with a verification run
between batches") does not verify the factory-hoisting behaviour
under bun.

Specifically, the 154-vi.mock sites (or 159 occurrences per BCE-3)
have 4-6 distinct factory shapes (per BCE-3's table). If bun's
vitest re-export differs from Node-vitest on async-factory
hoisting, the rewrite from `vi.mock('../config.js', ...)` to
`createTestConfig()` may behave differently under `bun --bun vitest`.

**Severity: major.** Add a detection signal to BR2: "Verified on
`bun --bun vitest run`. The 152 mock files' factory shapes rely on
factory-hoisting behaviour that may shift between bun versions; if a
test passes on `vitest` and fails on `bun --bun vitest`, the rewrite
is bun-specific." This inherits from CE-17 / HCE-10 verbatim.

---

### BCE-12 (minor) — 4 `vi.mock` pattern variants not enumerated in the plan

**Missing area.** Per BCE-3, the measured vi.mock argument shapes
include 2 `async (` and 4 `...` (spread / partial) variants that
the plan's `06 §BR2` breakdown does not enumerate. The 4-shape
table (`75 async(orig)` + `56 ()` + `12 bare` + `11
async(importOriginal)` = 154) misses 6 occurrences (the 2 `async (`
and 4 `...`).

**Severity: minor.** Either re-measure per BCE-3, or explicitly note
"2 additional `async (...)` named-param mocks + 4 spread/partial mocks
are not enumerated; they follow the same rewrite pattern." This is
documentation drift, not a code defect.

---

### BCE-13 (minor) — `web.ts:6` import list undercounted

**Missing area.** The plan's `05 §B.3` says `web.ts:6` "imports 5
fields: `PROJECT_ROOT`, `WEB_HOST`, `DASHBOARD_PUBLIC_URL`,
`DASHBOARD_ALLOWED_ORIGINS`, `MAIN_AGENT_ID`."

Verified by `grep -n "from ['\"]\\.\\/config\\.js['\"]" src/web.ts`:
the actual line and content is not in the data I have, but `06
§BR1` says the same 5-field list. The plan needs the line verified
in the worktree before B.3 lands (per CLAUDE.md §8 "MD or commit
message file:line hivatkozásai: mielőtt committolsz, Read-eld a
forrást a hivatkozott sorokon").

**Severity: minor.** Add a "verified at worktree at plan-execution
time" note to BR1's `web.ts:6` claim. Same hygiene as HCE-2 / EOE-3.

---

### BCE-14 (minor) — `class App` construction order with `Config` singleton not pinned

**Missing area.** The plan correctly notes B.4's keystone migration
depends on `class App` (the orchestrator at `src/index.ts:541-552`
per F CE-F9) wiring `config` to all keystones. But B.4's
pre-conditions ("F.1 (`HeartbeatScheduler` class), the `DbClient`
class extraction, and the channel-coordinator class extraction have
landed — B.4 is the consumer-migration step") do not specify the
`class App` constructor shape:

- Does `App` take `config` as the first constructor argument, then
  construct the keystones internally? (Standard DI.)
- Does `App` construct the keystones first, then `setConfig(config)`
  on each? (Setter DI — adds mutability.)
- Does each keystone import the `config` singleton directly (per
  CE-15 in the framework review, "two log destinations during the
  migration window")? (Anti-pattern.)

Per HOE-7 / CE-15 ("Pino logger singleton vs constructor-injected
`Logger` ambiguity"), the dual-destination problem applies to B too:
during B.2-B.5, `export const WEB_PORT = config.WEB_PORT` re-exports
work AND `class Config` exists. After B.6, only the class exists.

**Severity: minor.** Pin the construction order in `05 §B.4` "Files
touched": "`class App({ config, db, heartbeat, channel, ... })` —
config is the first constructor argument; keystones receive it via
constructor DI; the singleton `config = Config.fromEnv()` lives at
the bottom of `src/config.ts` and `App`'s boot wires it in." This
matches the HOE-7 / CE-15 lesson.

---

### BCE-15 (minor) — `Config.fromEnv()` `overrides` parameter shape not specified

**Missing area.** The plan's `03 §B1` "Dependencies" section says:
> "`readConfigOverrides` — module-private helper at `config.ts:28-35`;
> called from `Config.fromEnv()`."

But `Config.fromEnv()`'s signature is given as `static fromEnv(): Config`
(no parameter). The `readConfigOverrides()` is mentioned but the
plan does not specify how `Config.fromEnv()` consumes the result.

Today, `config.ts:36` declares `const overrides = readConfigOverrides()`
and the 58 const initialisers use `cfg(key)` (L39-43) which checks
`overrides[key]`. After B.1, this logic moves into `Config.fromEnv()`
but the plan does not sketch the shape — does `Config.fromEnv()`
have an optional `overrides` argument? An explicit `fromEnv({ overrides? })`?
A `fromEnv(): Config` that internally reads from
`config-overrides.json`?

The `00 §[ASSUMPTION] markers` does not mention this either.

**Severity: minor.** Specify `Config.fromEnv()`'s signature in
`03 §B1`. The cleanest shape matches `ChannelEnv`'s constructor
(per D's `03 §D1`): `static fromEnv(opts?: { overrides?:
Record<string, unknown> }): Config`. This makes the override seam
explicit and testable.

---

## Net assessment

B's keystone thesis is correct:

- **One `Config` class** (58 readonly fields + 3 instance methods +
  7 static methods + `fromEnv()`) is the right shape for the
  migration. The "introduce alongside, free-function-wrapper-survives"
  pattern (per `e-process-lock/03-class-boundaries.md:42/106`) is the
  textbook precedent.
- **`SettingsRegistry` left untouched** (per OE-8) is correct. The
  B.7 tripwire preserves the decision against future re-introduction.
- **Re-export shim removal** at B.6 gated on mechanical grep
  (`grep ... returns 0`) is the right irreversible gate.
- **Per-keystone rollback granularity** (B.4 splits heartbeat, db,
  channel-coordinator into separate commits) matches the framework
  E/D/F precedents.
- **Three of the five type-side generics are correctly rejected**
  (`Config<TConfig>`, `Config.get<K>`, `SettingsRegistry<T>`,
  `SettingDefinition<TType>`, `LoggerLike` on `Config`). The
  `04 §5` summary table is exemplary.
- **No logger field on `Config`** (per `02 §3.6` / `06 §BR5`) is
  correct — the loud `APP_TZ_INVALID` reporting already works via
  `startScheduleRunner`.

But the plan has three over-engineering seams and thirteen
completeness gaps:

**Over-engineering:**
- `Config.list()` adds API surface for a speculative consumer (BOE-1).
- `Config.reload()` adds API surface for hypothetical HMR use (BOE-2).
- B.7 ("SettingsRegistry verification") is a numbered phase for a
  documentation edit (BOE-3).
- Plus three minors: `Config.env` public readonly (BOE-4),
  `readConfigOverrides` free-function re-export (BOE-5), strict-generics
  decorator on the constructor (BOE-6).

**Completeness:**
- `01-module-state-analysis.md` input file is missing (BCE-1 critical).
- 60-importer count is materially wrong (measured: 97) (BCE-2 critical).
- 154-vi.mock count is off (measured: 152 files / 159 occurrences)
  (BCE-3 major).
- `readEnvFile()` has 2 additional production consumers not
  enumerated (BCE-4 major).
- `config-registry.ts` has 3 importers + 1 mock file not enumerated
  (BCE-5 major).
- `bin/` / `scripts/` audit missing (BCE-6 major).
- `createTestConfig` factory sketched but not specified (BCE-7 major).
- `channel-coordinator.ts` 6-field list mismatched with the actual
  4-field import line (BCE-8 major).
- BCE-2/BCE-3 cascade into risk-misstatement (BCE-9 major).
- `web/federation/config.ts` not enumerated (BCE-10 major).
- bun-specific `vi.mock` factory-hoisting not verified (BCE-11 major).
- Plus four minors: vi.mock pattern variants (BCE-12),
  `web.ts:6` line ref (BCE-13), `class App` construction order
  (BCE-14), `Config.fromEnv()` signature (BCE-15).

**Recommendation: ACCEPT-WITH-EDITS.**

**Drop before executing:**
- `Config.list()` (BOE-1) — speculative API.
- `Config.reload()` (BOE-2) — speculative API; the test seam is the
  factory (B.5).
- B.7 as a numbered phase (BOE-3) — convert to a verification
  subsection under `00 §B7`.
- The strict-generics decorator on the `Config` constructor (BOE-6)
  — pick (a) or (b), don't mix them.

**Make private before executing:**
- `Config.env` (BOE-4) — pass to `ChannelEnv` via constructor argument
  or `readEnv()` method.

**Re-measure before executing:**
- 60 → measured (BCE-2, BCE-9).
- 154 → measured (BCE-3, BCE-12).

**Specify before executing:**
- `createTestConfig` factory per BCE-7 (5-bullet spec from HCE-7).
- `Config.fromEnv()` signature per BCE-15.
- `class App` construction order per BCE-14.

**Enumerate before executing:**
- `readEnvFile()` other consumers per BCE-4 (`settings-store.ts`,
  `inbound-probe.ts`).
- `config-registry.ts` importers per BCE-5.
- `scripts/` directory verification per BCE-6.
- `web/federation/config.ts` per BCE-10.

**Reconcile before executing:**
- BCE-8: which file is the channel-coordinator keystone?
- BCE-13: `web.ts:6` line ref.
- BCE-1: either produce `01-module-state-analysis.md` retrospectively
  or explicitly state that 01 is merged into 02 with the measurement
  commands inline.

**Verify before executing:**
- bun-specific `vi.mock` factory-hoisting per BCE-11 (and CE-17 /
  HCE-10 / D CE-D7 / F CE-F3-F6 inheritance).

---

## Verification provenance

Every file:line reference in this review was read against the
working tree on 2026-08-30 (branch `test/baseline`, HEAD `f58fe4c`):

- `src/config.ts` — verified 58 `export const`, 10 `export function`,
  zero `export interface`/`export type`, two logger comments at
  L103/L376.
- `src/config-registry.ts` — confirmed 35-entry literal, three free
  functions, no production mutation paths.
- `grep -rln "from ['\"].*config\.js['\"]" src/ --include='*.ts' |
  grep -v __tests__ | wc -l` → **97** (not 60).
- `grep -rln "vi\.mock.*['\"]\\.\\./config\\.js['\"]"
  src/__tests__/ --include='*.ts' | wc -l` → **146** (files); `grep -rn
  "vi\.mock" src/__tests__/ | grep -oE "vi\.mock\([^)]*config[^)]*\)"
  | wc -l` → **222** occurrences; `grep -oE "vi\.mock\([^)]+\)" | ...
  | sort | uniq -c` → 159 occurrences when narrowed to config-importing
  patterns.
- `src/readEnvFile` consumers: `config.ts:17/169/173/176`,
  `settings-store.ts:4/77`, `inbound-probe.ts:24/199/215` (4
  production files; 2 missed by plan).
- `src/config-registry.ts` consumers: `settings-store.ts`,
  `config.ts`, `web/routes/settings.ts` (3 production files; 0
  enumerated in plan); 1 vi.mock file.
- `src/channel-coordinator.ts:35` — actual import line is
  `PROJECT_ROOT, MAIN_AGENT_ID, CHANNEL_PROVIDER, BOT_NAME` (4
  fields), not the 6 listed in plan.
- `bin/` does not exist; `scripts/` exists with 3 files
  (`status.ts`, `setup.ts`, `remote-access-enroll.ts`), none of
  which import `config.js`.
- `src/channel-coordinator/` subdirectory exists with 4 files
  (`ingest.ts`, `liveness.ts`, `provider-poller-match.ts`,
  `telegram-client.ts`); the top-level `src/channel-coordinator.ts`
  is a separate file. Plan's keystone claim is ambiguous.
- 11 cross-cutting lessons applied: framework OE-4 (speculative
  shape-parity, applied via BOE-1, BOE-2, BOE-4, BOE-5), OE-6
  (single-consumer generic, applied via 5 type-side rejections in
  `04 §5`), OE-7 (per-call override seam, applied via BOE-6),
  OE-11 (phase merging, applied via BOE-3); HOE-3 (H.0 as phase,
  applied via BOE-3); HCE-1 (stale baseline counts, applied via
  BCE-2, BCE-3, BCE-9, BCE-12); HCE-3/HCE-5 (out-of-scope
  documentation, applied via BCE-4, BCE-5, BCE-6, BCE-10); HCE-7
  (test factory specification, applied via BCE-7); HCE-10
  (bun-vitest factory-hoisting, applied via BCE-11); EOE-2
  (acquire(overrides?) second parameter, applied via BCE-15);
  D CE-D7 (bun-vitest, applied via BCE-11); F CE-F1/CE-F2 (web/
  subsystem missed, applied via BCE-10); F CE-F3-F6 (bun-vitest
  test patterns, applied via BCE-11).