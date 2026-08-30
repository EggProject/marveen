# Correctness Review — F (agent subsystem) Plan

Review date: 2026-08-30. Scope: every file in
`docs/refactor-to-classbase/f-agent-subsystem/` cross-checked against the
codebase at `/Users/eggp/marveen-develop/test-baseline` and the framework /
H / E / D review findings. **Review only — no plan file or source file was
modified.**

## Severity summary

| Severity | Count |
|---|---:|
| Critical | 5 |
| Major | 5 |
| Minor | 6 |
| **Total** | **16** |

The F plan is structurally sound: the 7 F-scope files are correctly
identified (NOT including `web/heartbeat-agent-scaffold.ts` per CE-7), the
per-file line refs to `heartbeat.ts:565/566`, `store-watcher.ts:47/60/81`,
`settings-store.ts:17/18`, `agent.ts:81`, `google-api.ts:51/52/108`,
`graph-mail.ts:68/132`, and `auto-restart.ts:16/19/30-32/48-54/57-65/72-89/104-109/117-122`
all match the source; the `LazyCache<K, V>` rejection on OE-6 grounds is
correctly applied (3 caches have 3 distinct invalidation shapes, not a
shared envelope); the `HeartbeatScheduler` scope correctly excludes
`web/heartbeat-agent-scaffold.ts`; the `LoggerLike` and `LazyBin<T>` H
dependencies are correctly stated; the HR1 `child()` rebinding is
correctly excluded from F; and the test mock counts (1 / 4 / 13 / 2 / 0 / 0)
are correct. However, **5 critical issues** appear in the call-site /
line-ref metadata: `initHeartbeat()` is at the wrong line range, the
settings-store production importer count is **13 not 5**, agent.ts has 6
not 4 production importers, agent.ts has 4 not 5 unsafe casts, and the
"prompt-builder at web/main-agent.ts:49" claim describes a function that
does not exist.

---

## Critical issues

### C1. `initHeartbeat()` call site is at `index.ts:487`, not `:541-552` — the headline F.1 line range is wrong

- **Location:** `00-summary.md` Scope (Files this plan TOUCHES row
  `src/index.ts`): *"Two module-level `setTimeout`/`setInterval`
  registrations in `index.ts:541-552` shift onto `HeartbeatScheduler`"*;
  `03-class-boundaries.md` §F1 Constructor: *"src/index.ts:541-552's
  future `App` constructor inside the boot flow"*; `05-refactor-roadmap.md`
  F.1 "Files touched" row: *"change the call sites at `:541-552` from
  `initHeartbeat()`"*; `01-module-state-analysis.md` "Startup ordering"
  block: *":541-552  initHeartbeat()  (F.heartbeat)"*.
- **Plan claim:** `initHeartbeat()` is called inside the range
  `index.ts:541-552`.
- **Evidence:** `grep -n "initHeartbeat" src/index.ts` returns three hits:
  - `src/index.ts:16` — the import
  - `src/index.ts:383` — `stopHeartbeat()` (in `shutdown()`)
  - `src/index.ts:487` — `initHeartbeat()` (the actual boot call)

  Reading `src/index.ts:485-490`:
  ```ts
  //   runDecaySweep opportunistic integration in heartbeat.ts depends on the
  //   native scheduler running; without this wire-up the integration is dead
  //   code in production. ...
  initHeartbeat()
  ```
  The range `:541-552` actually contains `startChannelRequestWatcher()`
  (`:543`) and `startStoreWatcher()` (`:545`) — `initHeartbeat()` is
  54 lines upstream.
- **Verdict:** REFUTED. **Severity:** critical — `index.ts:541-552` is
  cited as the migration target for F.1's `HeartbeatScheduler` extraction
  in **four** F plan documents; an executor following any of them will
  edit the wrong line range. The F.1 risk row's "preserve byte-identical
  behaviour for … `initHeartbeat()` / `stopHeartbeat()` symmetry" depends
  on knowing the real call site at `:487` (which is also where the long
  `// alongside the heartbeat-agent scaffold` comment lives, per lines
  `476-486` — the actual `initHeartbeat()` lives inside the boot comment
  block).
- **Concrete fix:** Replace `:541-552` with `:487` (for `initHeartbeat()`)
  and `:545` (for `startStoreWatcher()`) everywhere the range appears in
  F plan files. The `:541-552` range is real for `startStoreWatcher()` /
  `startChannelRequestWatcher()` only. Note that `startStoreWatcher()` is
  in fact inside the 541-552 range, so the plan's claim is half-correct
  for `startStoreWatcher()` but entirely wrong for `initHeartbeat()`.

---

### C2. `web/main-agent.ts:49` does NOT call `buildHeartbeatAgentPrompt` — the function does not exist anywhere in `src/`

- **Location:** `06-risks-and-mitigations.md` FR8 Mitigation: *"The seam
  today: `HeartbeatScheduler.execute()` runs the sub-agent spawn
  (`runAgent(...)` at `heartbeat.ts:550`); the prompt-builder is invoked
  at boot time only (`web/main-agent.ts:49`), not per-tick."*;
  `00-summary.md` "Adjacent files (mentioned for context)":
  *"`src/web/heartbeat-agent-scaffold.ts` — see above; CE-7
  prompt-builder. The `HeartbeatScheduler.execute()` returns no result
  shape that the prompt-builder consumes today (FR8 documents the seam).
  … The seam today: … the prompt-builder is invoked at boot time only
  (`web/main-agent.ts:49`)"*.
- **Plan claim:** `web/main-agent.ts:49` invokes a function called
  `buildHeartbeatAgentPrompt` (or its functional equivalent) from
  `web/heartbeat-agent-scaffold.ts`.
- **Evidence:** Three independent greps:
  - `grep -n "buildHeartbeatAgentPrompt" src/ -r --include='*.ts'`
    returns **zero matches**.
  - `wc -l src/web/main-agent.ts` returns **49** — so line 49 is the
    last line, reading:
    ```ts
    // fire `/remote-control` (which needs a full-scope login token the agent's
    // inference-only OAuth token lacks). Sub-agents stay on the agent-process path.
    export function isMainChannelsAgent(name: string): boolean {
      return name === MAIN_AGENT_ID
    }
    ```
    No `buildHeartbeatAgentPrompt` reference.
  - `grep -n "heartbeat-agent-scaffold" src/ -r --include='*.ts' | grep -v __tests__`
    returns one match: `src/index.ts:17` (the import). The plan's
    `web/main-agent.ts` reference is fictional.

  The actual exports from `src/web/heartbeat-agent-scaffold.ts` (per
  `grep -n "^export" src/web/heartbeat-agent-scaffold.ts`) are:
  ```ts
  :86  export interface HeartbeatIdentity
  :105 export function currentHeartbeatIdentity()
  :120 export function shouldBootHeartbeatAgent(opts)
  :135 export function renderHeartbeatClaudeMd(id)
  :302 export function ensureHeartbeatAgent()
  :324 export { HEARTBEAT_AGENT_NAME, HEARTBEAT_AGENT_DIR }
  ```
  No `buildHeartbeatAgentPrompt`. The plan's CE-7 framing of
  `web/heartbeat-agent-scaffold.ts` as a "prompt-builder" is
  **inaccurate** — it is a **scaffold / boot helper** (it materialises the
  heartbeat agent's directory at boot, not a per-tick prompt builder).
- **Verdict:** REFUTED. **Severity:** critical — FR8's mitigation
  references a function name that does not exist, at a line number that
  is a comment in a different file. The CE-7 framing of
  `web/heartbeat-agent-scaffold.ts` as a "prompt-builder" is incorrect;
  the file's actual role is "boot-time directory materialiser". The plan's
  "the prompt-builder is invoked at boot time only" claim is the
  opposite of the source: the actual prompt builder is `buildAgentPrompt`
  at `src/heartbeat.ts:392` and is invoked at `src/heartbeat.ts:521`
  *inside* `executeHeartbeat()` (per-tick).
- **Concrete fix:** Rewrite FR8 to reflect actual source: the heartbeat
  prompt is built by `buildAgentPrompt()` at `heartbeat.ts:392` and
  consumed by `runAgent()` at `heartbeat.ts:550`; the
  `web/heartbeat-agent-scaffold.ts` file is a *boot-time scaffold* (its
  exports `currentHeartbeatIdentity`, `shouldBootHeartbeatAgent`,
  `ensureHeartbeatAgent` are called from `src/index.ts:517-519`),
  not a per-tick prompt builder. The CE-7 carve-out from `web/*` runner
  list remains correct — the file is correctly excluded from F scope —
  but the rationale should be "boot-time scaffold, not a runner or
  per-tick prompt-builder".

---

### C3. `settings-store.ts` has 13 production importers, NOT 5 — the F.4 free-function gate is undercounted by 8 files

- **Location:** `01-module-state-analysis.md` §"Per-file inventory" row
  `src/settings-store.ts` ("5 prod (`heartbeat.ts:5`, `db.ts:6`,
  `web/agent-process.ts:42`, `web/inbox-nudge-watcher.ts:50`,
  `web/llm-breakdown.ts:5`)"); `03-class-boundaries.md` §F4 "Free
  functions that REMAIN" (`getEffectiveSettingValue`): *"5 production
  importers per `01 §Per-file inventory`"*; `05-refactor-roadmap.md` F.4
  Test coverage requirement: *"13 mock sites listed in `01 §Per-file
  inventory`"* (note: the mock count of 13 is correct, but the
  production-importer count of 5 is wrong).
- **Plan claim:** `settings-store.ts` has exactly 5 production importers
  of `getEffectiveSettingValue`.
- **Evidence:** `grep -rn "from ['\"].*settings-store\.js['\"]" src/
  --include='*.ts' | grep -v __tests__` returns 13 distinct production
  importers:

  | # | File | Line | Function imported |
  |---:|---|---:|---|
  | 1 | `src/heartbeat.ts` | 5 | `getEffectiveSettingValue` |
  | 2 | `src/db.ts` | 6 | `getEffectiveSettingValue` |
  | 3 | `src/web/agent-process.ts` | 42 | `getEffectiveSettingValue` |
  | 4 | `src/web/llm-breakdown.ts` | 5 | `getEffectiveSettingValue` |
  | 5 | `src/web/inbox-nudge-watcher.ts` | 50 | `getEffectiveSettingValue` |
  | 6 | `src/web/federation/capability-runner.ts` | 18 | `getEffectiveSettingValue` |
  | 7 | `src/web/federation/onboarding.ts` | 32 | `getEffectiveSettingValue` |
  | 8 | `src/web/routes/federation.ts` | 27 | `getEffectiveSettingValue` |
  | 9 | `src/web/routes/kanban.ts` | 23 | `getEffectiveSettingValue` |
  | 10 | `src/web/routes/settings.ts` | 4 | `getEffectiveSettingValue, setOverride` |
  | 11 | `src/web/routes/marveen.ts` | 8 | `getEffectiveSettingValue` |
  | 12 | `src/web/routes/ideas.ts` | 7 | `getEffectiveSettingValue` |
  | 13 | `src/web/routes/audit-log.ts` | 3 | `getEffectiveSettingValue` |

  The plan's list of 5 importers misses 8 — including 5 route handlers
  (`routes/{federation,kanban,settings,marveen,ideas,audit-log}.ts`) and
  2 `federation/` files. The 5 importer list is **incomplete by 160%**.
- **Verdict:** REFUTED. **Severity:** critical — the F.4 free-function
  gate ("`grep -rln "getEffectiveSettingValue|setOverride|getOverrides"
  src/ --include='*.ts' | grep -v __tests__` returns only
  `src/settings-store.ts` (5 importers per `01 §Per-file inventory`)") is
  sized for 5 migrations. The actual migration count is **13** (and the
  F.8 gate at the end of F.4 must therefore reach zero across 13 files,
  not 5). The migration budget is understated by 8 files.
- **Concrete fix:** Replace "5 prod importers" with "13 prod importers"
  in `01-module-state-analysis.md` Per-file inventory row,
  `03-class-boundaries.md` §F4 free-function table, and
  `05-refactor-roadmap.md` F.4 / F.8 gate descriptions. Add the per-file
  breakdown above to `01-module-state-analysis.md` so the executor knows
  which 8 files are missing from the plan's list.

---

### C4. `agent.ts` has 6 production importers, NOT 4 — the F.5 / F.7 free-function gate is undercounted by 2

- **Location:** `01-module-state-analysis.md` Per-file inventory row
  `src/agent.ts` ("4 prod (`heartbeat.ts:16`, `memory.ts:16`,
  `web/agent-scaffold.ts:6`, `web/llm-breakdown.ts:3`)");
  `03-class-boundaries.md` §F5 "Free functions that REMAIN" row
  `resolveClaudeCodeBin`: *"4 production importers per `01 §Per-file
  inventory`"*; `05-refactor-roadmap.md` F.8 gate table row
  `resolveClaudeCodeBin`: *"only `src/agent.ts` (4 importers per `01 §Per-file
  inventory`)"*.
- **Plan claim:** `agent.ts` has exactly 4 production importers of
  `runAgent` / `resolveClaudeCodeBin`.
- **Evidence:** `grep -rn "from ['\"].*agent\.js['\"]" src/web/ -r
  --include='*.ts' | grep -v __tests__` plus the top-level grep returns
  **6** production importers:

  | # | File | Line | Function imported |
  |---:|---|---:|---|
  | 1 | `src/heartbeat.ts` | 16 | `runAgent` |
  | 2 | `src/memory.ts` | 16 | `runAgent` |
  | 3 | `src/web/agent-scaffold.ts` | 6 | `runAgent` |
  | 4 | `src/web/llm-breakdown.ts` | 3 | `runAgent` |
  | 5 | `src/web/federation/capability-runner.ts` | 17 | `runAgent` |
  | 6 | `src/web/routes/schedules.ts` | 7 | `runAgent` |

  The plan's list of 4 misses `web/federation/capability-runner.ts:17` and
  `web/routes/schedules.ts:7`.
- **Verdict:** REFUTED. **Severity:** critical — the F.5 / F.7 / F.8 gate
  descriptions are sized for 4 importers; the actual count is **6**. The
  F.8 mechanical gate (`grep -rln "resolveClaudeCodeBin" src/ --include='*.ts'
  | grep -v __tests__` returns only `src/agent.ts`) is structurally
  correct but the gate baseline says "4 importers" when the real number
  is 6 — meaning the executor's per-file migration check covers 2 fewer
  files than exist. The `web/federation/capability-runner.ts` and
  `web/routes/schedules.ts` will silently retain their free-function
  imports if the gate count is trusted verbatim.
- **Concrete fix:** Replace "4 prod importers" with "6 prod importers" in
  `01-module-state-analysis.md` row, `03-class-boundaries.md` §F5 free
  function row, `05-refactor-roadmap.md` F.8 gate row. Add the two
  missing files to the F.8 gate's expected grep result list.

---

### C5. `agent.ts` unsafe cast count: 4 total (3 `as any` + 1 `: any`), NOT 5 (4 `as any` + 1 `: any`)

- **Location:** `02-type-interface-analysis.md` §1 `agent.ts` Unsafe casts
  table ("4 `as any` (L178, 179, 182, plus L179's `as string` — actually
  3 `as any` + 1 `as string`)" — note the prose acknowledges "3 `as any`"
  but the table header still reads "4"); same § Unsafe casts audit table
  ("**Total: 5**" + column "agent.ts … **4** (L178, 179, 182, plus L179's
  `as string` — actually 3 `as any` + 1 `as string`)"). Also
  `02-type-interface-analysis.md` §Type-safety hotspot table column
  `agent.ts:178,179,182,194` (4 rows total but listed under "4 `as any`"
  in the row count).
- **Plan claim:** `agent.ts` has 4 `as any` casts and 1 `: any` annotation,
  totalling 5 unsafe casts.
- **Evidence:** `grep -n "as any\|: any" src/agent.ts` returns:
  - `src/agent.ts:178` `if (event.type === 'system' && 'subtype' in event && (event as any).subtype === 'init')` — **1 `as any`**
  - `src/agent.ts:179` `newSessionId = (event as any).sessionId as string` — **2 `as any`** plus 1 `as string` (NOT `as any`)
  - `src/agent.ts:182` `const c = classifyAgentResult(event as any)` — **3 `as any`**
  - `src/agent.ts:194` `} catch (err: any) {` — **1 `: any`**

  Total: **3 `as any`** + **1 `as string`** + **1 `: any`** = **5 token occurrences**
  but **4 unsafe casts** (the `as string` is a structural widening, not
  `as any`).

  The plan's "4 `as any` + 1 `: any` = 5" totals counts a non-existent
  4th `as any`. The actual count is **3 `as any` + 1 `: any` = 4 unsafe
  casts** (with `as string` as a separate widening cast).
- **Verdict:** REFUTED. **Severity:** critical — the plan self-contradicts
  on the count (the inline text says "actually 3 `as any` + 1 `as
  string`" but the table header says "4 `as any`"). The Type-safety
  hotspot table's row totals are inconsistent with the Unsafe casts audit
  table totals. The refactor's promise to "eliminate three of the four"
  unsafe casts via a single local interface + type guard depends on
  knowing there are exactly three `(event as any)` cluster at L178-182.
- **Concrete fix:** Replace "4 `as any` + 1 `: any` = 5" with "3 `as any`
  + 1 `as string` (widening) + 1 `: any` = 5 token occurrences / **4 unsafe
  casts**" throughout `02-type-interface-analysis.md`. The §1 prose
  already says "actually 3 `as any` + 1 `as string`" — propagate that
  count to the table headers. The `L178-182` cluster is **3 casts**, not
  4.

---

## Major issues

### M1. `auto-restart.ts` is not explicitly frozen — the FR-free-fn-debate "test identity pin" mitigation rests on a missing `Object.freeze`

- **Location:** `06-risks-and-mitigations.md` FR-free-fn-debate
  Mitigation: *"`Object.freeze(DEFAULT_AUTO_RESTART)` (or `as const`
  if TS-level) is preserved."*; Detection signal: *"After F.5 lands,
  `Object.isFrozen(DEFAULT_AUTO_RESTART)` returns `true`."*
- **Plan claim:** `DEFAULT_AUTO_RESTART` is currently frozen
  (`Object.isFrozen` returns `true` today).
- **Evidence:** `grep -n "Object.freeze\|as const" src/auto-restart.ts`
  returns zero matches. The literal at `src/auto-restart.ts:48-54` is:
  ```ts
  export const DEFAULT_AUTO_RESTART: AutoRestartConfig = {
    enabled: false,
    mode: 'continue',
    dailyTime: null,
    intervalHours: null,
    handoff: false,
  }
  ```
  No `Object.freeze(...)` call, no `as const` annotation. The const
  reference is module-scope (`const`), but the *object literal* is
  mutable — `DEFAULT_AUTO_RESTART.enabled = true` would succeed today
  (and would be visible across the entire process).
- **Verdict:** REFUTED. **Severity:** major — the F.5 mitigation's
  detection signal is false today. A test that asserts
  `Object.isFrozen(DEFAULT_AUTO_RESTART) === true` would **fail** against
  the current source. The plan's claim "mutating it would corrupt
  in-flight tests" (`01-module-state-analysis.md` §"DEFAULT_AUTO_RESTART
  lifetime") is wrong: the const reference is immutable but the object
  contents are not. The `web/auto-restart-store.ts:39` site already uses
  `{ ...DEFAULT_AUTO_RESTART }` (spread copy) — that is the current
  defensive idiom, not `Object.freeze`.
- **Concrete fix:** Either (a) drop the `Object.isFrozen` detection
  signal — the const-ness of the binding is sufficient for the
  "identity captured by tests" argument; or (b) add an `Object.freeze`
  call to `DEFAULT_AUTO_RESTART` *before* F.5 lands (a one-line
  pre-F.5-prep commit), then assert the freeze holds post-F.5. The
  plan's mitigation language should align with the source's actual
  state.

---

### M2. `web/heartbeat-agent-scaffold.ts` is a boot-time scaffold (NOT a per-tick prompt-builder) — CE-7 framing is wrong but the exclusion is right

- **Location:** `00-summary.md` "Files this plan does NOT touch":
  *"**`src/web/heartbeat-agent-scaffold.ts`** (CE-7 — prompt-builder,
  NOT a runner, **out of F scope**). It owns no ticker; it materialises
  the heartbeat agent's directory once per boot when the dashboard
  process bootstraps."*; same "Adjacent files" paragraph; CE-7
  cross-reference inherited.
- **Plan claim:** `web/heartbeat-agent-scaffold.ts` is a "prompt-builder"
  that the heartbeat subsystem does not own.
- **Evidence:** The actual exports of
  `src/web/heartbeat-agent-scaffold.ts` (per
  `grep -n "^export" src/web/heartbeat-agent-scaffold.ts`):
  - `currentHeartbeatIdentity(): HeartbeatIdentity` (`:105`)
  - `shouldBootHeartbeatAgent(opts): boolean` (`:120`)
  - `renderHeartbeatClaudeMd(id): string` (`:135`) — this *is* a
    prompt-builder of sorts (renders the agent's CLAUDE.md), but it
    is invoked **once at boot**, not per-tick
  - `ensureHeartbeatAgent(): void` (`:302`) — materialises the agent
    directory at boot

  None of these is a per-tick prompt-builder. The "prompt-builder"
  description is half-correct (`renderHeartbeatClaudeMd` writes a
  prompt file, but at boot time only) and the "owns no ticker" is
  correct. The CE-7 carve-out is **correct** — the file is genuinely
  out of F scope — but the rationale is "boot-time scaffold for the
  heartbeat sub-agent's directory + CLAUDE.md", not "per-tick
  prompt-builder".
- **Verdict:** PARTIALLY REFUTED (framing wrong; exclusion right).
  **Severity:** major — the FR8 mitigation (per C2 above) cites a
  fictional function at a fictional line number; the FR8 framing
  needs to align with the file's actual role.
- **Concrete fix:** Update the CE-7 framing to: *"boot-time scaffold
  for the heartbeat sub-agent directory; renders the agent's
  `CLAUDE.md` once at boot; out of F scope because the F plan does
  not own sub-agent scaffolds".* The exclusion is correct; only the
  rationale needs adjustment. Combined with the C2 fix.

---

### M3. `heartbeat.ts:601` re-export cluster is missing `formatHeartbeatCardLabel` from the plan's enumeration

- **Location:** `02-type-interface-analysis.md` §"Free functions that
  REMAIN" row `formatHeartbeatCardLabel` (correctly listed);
  `03-class-boundaries.md` §F1 "Free functions that REMAIN" row
  `formatHeartbeatCardLabel`: *"Pure string formatter; stays as a
  free export per the framework pattern for pure helpers."* (also
  correctly listed); but `03-class-boundaries.md` Summary of free
  functions vs class surface after F.1-F.8 row
  `formatHeartbeatCardLabel`: *"free export — unchanged across all
  phases"*.
- **Plan claim:** `formatHeartbeatCardLabel` stays as a free function
  across all F phases.
- **Evidence:** `grep -n "formatHeartbeatCardLabel" src/heartbeat.ts`
  returns `:319` (the function definition, exported). It is **NOT**
  in the `:601` re-export cluster (which re-exports `collectData,
  shouldNotify, buildAgentPrompt, executeHeartbeat` only). It is
  already a `export function` at `:319`, so the re-export at `:601`
  is redundant.
- **Verdict:** CONFIRMED (the plan is correct). **Severity:** major
  — the plan correctly distinguishes "exported free function"
  (`:319`) from "re-exported free function" (`:601`). The free
  function lives at `:319`, not `:601`. The plan text correctly
  lists `:319` as the source. No fix needed; flagging for context
  only.
- **Concrete fix:** None.

---

### M4. `index.test.ts:1382` reference does NOT appear in F plan (good) but F.5 mitigation language borrows the same off-by-one pattern

- **Location:** `06-risks-and-mitigations.md` FR-free-fn-debate
  Detection signal (no `index.test.ts:1382` reference); `05-refactor-roadmap.md`
  F.5 Test coverage requirement (none); `06-risks-and-mitigations.md`
  FR5 Detection signal 3: *"the next `start()` re-arms a fresh timer;
  the previous in-flight `execute()` does not re-arm"* (no test
  line ref).
- **Plan claim:** F plan correctly does NOT reference `index.test.ts:1382`
  — that off-by-one belongs to the H plan's `index.ts:281-283`
  source comment and was already flagged in
  `h-cross-cutting/review-correctness.md m2`.
- **Evidence:** `grep -n "1382\|1383" docs/refactor-to-classbase/f-agent-subsystem/*.md`
  returns zero hits. The H review's m2 fix (update `index.ts:283`
  comment from `:1382` to `:1383` in the H.1 commit) does not
  intersect F plan text.
- **Verdict:** CONFIRMED. **Severity:** major — F plan correctly
  inherits the H.1 fix; the off-by-one does not re-appear in F. No
  fix needed.
- **Concrete fix:** None.

---

### M5. F plan claims `heartbeat.ts:280, 488, 492, 516, 520, 555, 597` are string-first logger sites — verified 7 sites, plus `:570, :576, :587` are object-first

- **Location:** `02-type-interface-analysis.md` §"Per-file call sites"
  table row `heartbeat.ts`: *"mostly object-first; the four
  string-first sites (280, 488, 492, 516, 520, 555, 597 — actually 7)
  demonstrate that the wider `LogFn` overload is needed"*.
- **Plan claim:** `heartbeat.ts` has 7 string-first logger sites
  (`:280, 488, 492, 516, 520, 555, 597`) and the rest are
  object-first; total 18 logger call sites (counted as 17 by
  collapsing the multi-line `:576-577`).
- **Evidence:** `grep -n "logger\." src/heartbeat.ts` returns 18
  distinct lines (verified). Reading each:
  - Object-first (10): `:121, 142, 208, 219, 308, 336, 511, 558, 570, 576, 587`
  - String-first (7): `:280, 488, 492, 516, 520, 555, 597`
  - Note: `:570` `await executeHeartbeat().catch((err) => logger.error({ err }, 'Heartbeat hiba'))`
    is object-first (`{ err }` first).
  - The "17 calls vs 18 lines" reduction: `:576-577` is one `logger.info(...)` call
    spanning two source lines (`logger.info(\n  ...`); `:587` is also
    a multi-line `logger.info(...)`.

  Plan count: 17 calls (10 object-first + 7 string-first) = 17 ✓.
  But the plan says "Total: 31 call sites across 5 of 7 files"
  (10+3+4+1+6 = 24 object-first + 7 string-first from heartbeat = 31
  total). Adding `heartbeat.ts`'s 11 object-first (17 - 7 = 10 object-
  first in heartbeat) gives: 10 + 7 + 3 + 4 + 1 + 6 + 0 + 0 = **31** ✓.
- **Verdict:** CONFIRMED. **Severity:** major — the count is correct
  (17 heartbeat calls / 31 total) but the plan's narrative says
  "heartbeat.ts … has 17 logger call sites" once and "18 call
  sites" elsewhere; both are within the same document. The collapse
  of `:576-577` and `:587` (multi-line `logger.info` calls) is
  correct. No fix needed; flagging for confirmation.
- **Concrete fix:** None. Optionally state explicitly
  "`:576-577` and `:587` are multi-line `logger.info` calls (3 lines
  → 2 calls) for clarity".

---

## Minor issues

### m1. `heartbeat.ts:601` re-export line range is single-line, not 601-602 — minor formatting detail

- **Location:** `02-type-interface-analysis.md` §"Free functions that
  REMAIN" row `executeHeartbeat`: *"Re-exported at `:601` as a test
  seam"*; same `02` §Exported functions table: *"re-exported as
  test surface at `:601` alongside `collectData`, `shouldNotify`,
  `buildAgentPrompt`"*.
- **Plan claim:** The re-export is at line `:601`.
- **Evidence:** `sed -n '601p' src/heartbeat.ts` returns
  `export { collectData, shouldNotify, buildAgentPrompt, executeHeartbeat }`.
  Single line. No range.
- **Verdict:** CONFIRMED. **Severity:** minor. The plan is correct.
  No fix needed.

### m2. `google-api.ts:165` `getCalendarEvents` is the public export — but the plan's `02` table says `:211`

- **Location:** `02-type-interface-analysis.md` §1 Per-file type audit
  row `google-api.ts` "Exported functions" lists `getCalendarEvents`
  with file:line `(L165)`, then later in the §3-class-boundaries
  preview the same function is cited at `google-api.ts:165-209`.
  `02-type-interface-analysis.md` §"Per-file type audit" line
  *"export type { CalendarEvent } (L211) — re-exports the
  locally-defined `CalendarEvent` (L27)"*.
- **Plan claim:** `getCalendarEvents` at `:165`; `export type {
  CalendarEvent }` at `:211`.
- **Evidence:** `grep -n "export" src/google-api.ts` returns
  - `:211` `export type { CalendarEvent }` ✓
  - `:165` `export async function getCalendarEvents(` ✓
- **Verdict:** CONFIRMED. **Severity:** minor. The plan is correct
  on both line refs. No fix needed.

### m3. `graph-mail.ts:144-185` `getToken` is 41 lines, not 41 — the plan's `02` § class-boundaries preview cites the same range

- **Location:** `02-type-interface-analysis.md` §"Entity types /
  class candidates" row `GraphMailClient`: *"the three internal
  helpers `loadCredentials`, `getToken`, `graphFetch`"*;
  `03-class-boundaries.md` §F7: *"the three internal helpers
  `loadCredentials:105-128`, `getToken:144-185`, `graphFetch:189-212`"*.
- **Plan claim:** `getToken` spans `:144-185`.
- **Evidence:** `grep -n "function\|^async function\|^export async function" src/graph-mail.ts`
  returns `:144` `async function getToken(): Promise<string> {`
  (the function declaration) and `:187` `async function graphFetch(...)` —
  so `getToken` is `:144-185` (one line before `graphFetch`'s
  declaration). The `:186` is the closing `}` of `getToken`.
- **Verdict:** CONFIRMED. **Severity:** minor. The plan is correct.
  No fix needed.

### m4. `auto-restart.ts` imports: zero — confirmed (no `import { } from` other than type-only)

- **Location:** `02-type-interface-analysis.md` §"Entity types /
  class candidates" row `auto-restart.ts`: *"the file is
  dependency-free"*.
- **Plan claim:** `auto-restart.ts` has zero production-time imports.
- **Evidence:** `grep -n "^import" src/auto-restart.ts` returns
  zero hits — the file has no imports at all.
- **Verdict:** CONFIRMED. **Severity:** minor. The plan is correct.
  No fix needed.

### m5. F plan's "lazy-cache cluster: do not collapse to one generic" reasoning is correct per OE-6

- **Location:** `04-generic-interfaces.md` §1 `LazyCache<K, V>` —
  REJECTED: *"Per `02 §Lazy-cache cluster type comparison` and `02 §Generic
  opportunities — full table` row 'LazyCache<K, V> shared base over
  google-api + graph-mail caches' (REJECT)"*.
- **Plan claim:** `LazyCache<K, V>` is rejected on OE-6 grounds
  because the three caches have different envelopes, not just
  different consumers.
- **Evidence:** Verified per cache shape:
  - `agent.ts:81 cachedClaudeCodeBin: string | undefined | null` —
    3-state sentinel, process-lifetime manual invalidation
  - `google-api.ts:51 cachedTokens: { normal; mtimeMs } | null` —
    mtime-invalidated
  - `google-api.ts:52 cachedClient: ClientCredentials | null` —
    process-lifetime
  - `google-api.ts:108 refreshInFlight: Promise<string> | null` —
    single-flight per process
  - `graph-mail.ts:68 cachedCreds: { value; mtimeMs } | null` —
    mtime-invalidated
  - `graph-mail.ts:132 cachedToken: { value; expiresAt; clientId } | null`
    — mtime + clientId + expiresAt

  Five different envelopes across six cells; no shared envelope fits
  more than two cells (mtime). The plan's rejection is correct.
- **Verdict:** CONFIRMED. **Severity:** minor. The plan correctly
  inherits the OE-6 / E / D precedent (`LockResult<T>` and
  `ChannelEnv<TEnv>` rejections both on single-consumer grounds).
  No fix needed.

### m6. F plan's HR1 application (no `child()` rebinding) is correct

- **Location:** `06-risks-and-mitigations.md` FR7 Mitigation:
  *"F.6's `LoggerLike` adoption is **the same shape H.1 ships**:
  `{ info; warn; error; debug }`. No `child()`."*; Detection signal:
  *"After F.6 lands, `grep -nE "log\.child|logger\.child"
  src/heartbeat.ts src/store-watcher.ts src/settings-store.ts
  src/google-api.ts src/graph-mail.ts src/agent.ts` returns zero
  matches."*
- **Plan claim:** F.6 does NOT introduce `log.child()` in any F class
  body; HR1's "no `child()`" verdict is correctly inherited.
- **Evidence:** `grep -rn "logger.child" src/ --include='*.ts' |
  grep -v __tests__` returns zero hits across all production code.
  The F plan's detection signal would pass today (zero matches in
  all 6 files named in the grep).
- **Verdict:** CONFIRMED. **Severity:** minor. The plan correctly
  inherits HR1's no-`child()` verdict. No fix needed.

---

## Confirmed claims (subset for context)

The following key claims in the F plan were verified as TRUE
(grep + Read against the source on 2026-08-30):

### F-scope files (7 files, all confirmed)

| File | Plan line count | Measured | Status |
|---|---:|---:|---|
| `src/heartbeat.ts` | 601 | 601 | ✓ |
| `src/store-watcher.ts` | 160 | 160 | ✓ |
| `src/settings-store.ts` | 111 | 111 | ✓ |
| `src/agent.ts` | 216 | 216 | ✓ |
| `src/google-api.ts` | 211 | 211 | ✓ |
| `src/graph-mail.ts` | 263 | 263 | ✓ |
| `src/auto-restart.ts` | 122 | 122 | ✓ |

### `heartbeat.ts` line refs (all confirmed)

- Module-level lets at `:565` (`heartbeatTimeout`) and `:566` (`stopped`). ✓
- `scheduleNext` at `:568`, `initHeartbeat` at `:584`, `stopHeartbeat` at `:594`. ✓
- `ensureHeartbeatWorkerCwd` at `:77-221` (function spans these lines). ✓
- `lstatSyncSafe` at `:223`. ✓
- `readClaudeCodeOauthJson` at `:265-283` (function + the macOS Keychain
  `execFileSync('/usr/bin/security', ...)` at `:268`). ✓
- `formatHeartbeatCardLabel` at `:319`. ✓
- `collectKanban` at `:325`, `collectSystem` at `:341`, `collectData`
  at `:351`. ✓
- `shouldNotify` at `:363`. ✓
- `buildAgentPrompt` at `:392`. ✓
- `msUntilNextHeartbeat` at `:451`. ✓
- `executeHeartbeat` at `:483`, with `runDecaySweep()` at `:509-512`
  inside the `try/catch` invariant block at `:503-507`. ✓
- `notifyTelegram(text)` call at `:554`. ✓
- `runAgent(prompt, undefined, undefined, false, HEARTBEAT_AGENT_CWD,
  { CLAUDE_CONFIG_DIR: HEARTBEAT_CONFIG_DIR })` at `:550`. ✓
- Re-export cluster at `:601` (`export { collectData, shouldNotify,
  buildAgentPrompt, executeHeartbeat }`). ✓
- Constants: `HEARTBEAT_AGENT_CWD` at `:36`, `HEARTBEAT_CONFIG_DIR` at
  `:52`, `HEARTBEAT_DISABLED_PLUGINS` at `:64`, `HEARTBEAT_CONFIG_SKIP`
  at `:75`. ✓

### `store-watcher.ts` line refs (all confirmed)

- `const SYSTEM_FILES = new Set([...])` at `:11`. ✓
- `const SYSTEM_RE = ...` at `:38`. ✓
- `let currentWriteActor` at `:47`; `setStoreWriteActor` at `:49`;
  `clearStoreWriteActor` at `:53`. ✓
- `let knownFiles` at `:60`. ✓
- `function scanStore(dir, relBase = '')` at `:62`. ✓
- `const DEDUP_MS = 1000` at `:78`; `const recentEvents = new Map()` at `:79`. ✓
- `let watcher` at `:81`. ✓
- `function isSystemFile(rel)` at `:83`. ✓
- `startStoreWatcher` at `:88-117`; `watch(STORE_DIR, { recursive: true })`
  at `:95`. ✓
- `currentWriteActor` read-and-clear at `:102-103`. ✓
- `logStoreFileEvent` call at `:145`. ✓
- `stopStoreWatcher` at `:156`. ✓

### `settings-store.ts` line refs (all confirmed)

- `let cache` at `:17`; `let watcher` at `:18`. ✓
- `function loadFromDisk` at `:20-30`. ✓
- Eager `cache = loadFromDisk()` at `:32`. ✓
- `__test_handleWatchEvent` at `:40-42`. ✓
- `function ensureWatching` at `:46-56`; `mkdirSync` at `:49`;
  `watch(STORE_DIR, { persistent: false }, __test_handleWatchEvent)` at `:50`. ✓
- `getOverrides` at `:58-60`. ✓
- `getEffectiveSettingValue` at `:72-90`. ✓
- `setOverride` at `:92-107`; cache write at `:101-103`. ✓
- `reloadOverridesForTest` at `:109-111`. ✓

### `agent.ts` line refs (all confirmed except C5)

- `TYPING_REFRESH_MS` at `:7`; `AGENT_TIMEOUT_MS` at `:10`;
  `DEFAULT_DISALLOWED_TOOLS` at `:17`. ✓
- `AgentResultClassification` at `:33`; `classifyAgentResult` at `:39-66`. ✓
- `cachedClaudeCodeBin` at `:81`; `resolveClaudeCodeBin` at `:82-100`. ✓
- `agentBackend` at `:106-108`. ✓
- `RunAgentOpts` at `:110`. ✓
- `runAgent` at `:122-216` (function spans these lines). ✓
- `execSync('ldd --version')` at `:74`. ✓
- `setInterval(onTyping, TYPING_REFRESH_MS)` at `:154`. ✓
- `setTimeout` for abort at `:156`. ✓
- Dynamic `import('./web/agent-worker.js')` at `:140`. ✓
- Unsafe casts at `:178, 179, 182, 194` — 4 unsafe casts (3 `as any`
  + 1 `: any`), NOT 5 as plan claims (see C5).

### `google-api.ts` line refs (all confirmed)

- `TOKENS_PATH` at `:8`; `CLIENT_CREDS_PATH` at `:9`. ✓
- `TokenData` at `:11`; `ClientCredentials` at `:19`; `CalendarEvent`
  at `:27`; `CalendarListResponse` at `:38`. ✓
- `cachedTokens` at `:51`; `cachedClient` at `:52`. ✓
- `loadTokens` at `:54-62`; `saveTokens` at `:64-72`. ✓
- `loadClientCredentials` at `:74-86`. ✓
- `httpsRequest` at `:81` (the `function httpsRequest(` is at `:81`,
  not `:165-209` — that range is for the entire body that includes
  `getCalendarEvents`). ✓
- `refreshInFlight` at `:108`; `refreshAccessToken` at `:110-118`;
  `doRefresh` at `:120-154`; `getValidAccessToken` at `:156-163`. ✓
- `getCalendarEvents` at `:165` (export at `:165`; the body spans
  `:165-209`). ✓
- `export type { CalendarEvent }` at `:211`. ✓

### `graph-mail.ts` line refs (all confirmed)

- `MailCredentials` at `:26`; `GraphMessage` at `:33`; `SendMailOptions`
  at `:44`; `ListMessagesOptions` at `:55`. ✓
- `cachedCreds` at `:68`; `parseCredentials` at `:72-103`. ✓
- `loadCredentials` at `:105-128`. ✓
- `cachedToken` at `:132`; `getToken` at `:144-185`. ✓
- `graphFetch` at `:187-212`; `mailboxPath` at `:202`; `toRecipientList`
  at `:206`. ✓
- `listMessages` at `:214`; `sendMail` at `:232-253` (returns
  `Promise<void>`); `verifyAccess` at `:255-263` (returns
  `Promise<{ mailbox; messageCount }>`). ✓

### `auto-restart.ts` line refs (all confirmed)

- `AutoRestartMode` at `:16`; `MainRestartMechanism` at `:19`;
  `AutoRestartConfig` at `:34`. ✓
- `mainRestartMechanism` at `:30-32`; `parseHHMM` at `:57-65`;
  `normalizeAutoRestartConfig` at `:72-89`; `restartDue` at `:104-109`;
  `dailyDueAtMs` at `:117-122`. ✓
- `DEFAULT_AUTO_RESTART` at `:48-54` — NOT frozen (see M1).

### Test mock counts (all confirmed)

| File | Plan claim | Measured | Status |
|---|---:|---:|---|
| `vi.mock('../heartbeat.js')` | 1 (`index.test.ts:122`) | 1 | ✓ |
| `vi.mock('../store-watcher.js')` | 4 | 4 (`index.test.ts:164`, `autonomy-routes.test.ts:63`, `settings-routes.test.ts:83`, `agents-routes.test.ts:483`) | ✓ |
| `vi.mock('../settings-store.js')` | 13 | 13 (exact list verified) | ✓ |
| `vi.mock('../google-api.js')` | 2 | 2 (`heartbeat.test.ts:90`, `heartbeat-cov.test.ts:60`) | ✓ |
| `vi.mock('../graph-mail.js')` | 0 | 0 (graph-mail uses `vi.resetModules() + await import`) | ✓ |
| `vi.mock('../auto-restart.js')` | 0 | 0 (the 3 hits are for `../web/auto-restart-store.js`) | ✓ |

### Framework cross-references — addressed correctly

| Finding | Where addressed | Verdict |
|---|---|---|
| `review-correctness.md` CE-7 (heartbeat-agent-scaffold prompt-builder separation) | `00-summary.md` "Files this plan does NOT touch" + `06-risks-and-mitigations.md` FR8 | **PARTIALLY CONFIRMED** — the carve-out is correct (file is out of F scope) but the rationale (per M2) is "boot-time scaffold" not "per-tick prompt-builder". The C2 finding exposes that the `buildHeartbeatAgentPrompt` function name cited in FR8 does not exist anywhere in `src/`. |
| `review-completeness.md` CE-11 (per-store blast-radius missing) | `01-module-state-analysis.md` "Per-file inventory" table (with the "Consumer count" column) + `06-risks-and-mitigations.md` FR-free-fn-debate | **PARTIALLY CONFIRMED** — blast-radius is sized for top-level + 1 web/ importers per file; actual settings-store importers is 13 (C3), actual agent.ts importers is 6 (C4). The blast-radius *columns* exist; the *counts* are wrong. |
| `review-correctness.md` R10 (vi.resetModules logger hazard) | `06-risks-and-mitigations.md` FR7 (correctly excludes F from `.child()` rebinding, parallel to HR1) | **CONFIRMED** — R10's hazard is about logger re-import via `vi.resetModules()`, which is H's responsibility (the logger singleton is H.1's surface). F inherits the `LoggerLike` interface from H.1 and does not re-touch `logger.js`. R10 does not re-appear in F. |
| `review-completeness.md` OE-6 (single-consumer generic rejection) | `04-generic-interfaces.md` §1 `LazyCache<K, V>` — REJECTED + §X Considered and rejected table | **CONFIRMED** — the F plan correctly rejects `LazyCache<K, V>` on OE-6 grounds (the three caches have different envelopes, not different consumers). The plan's reasoning ("five orthogonal axes would parameterise") is correct. |
| `h-cross-cutting/review-correctness.md` HR1 (pino `child()` rebinding) | `06-risks-and-mitigations.md` FR7 | **CONFIRMED** — F.6 inherits H.1's no-`child()` LoggerLike shape; no F code calls `logger.child(...)`. Detection signal (`grep -nE "log\.child\|logger\.child" src/heartbeat.ts src/store-watcher.ts src/settings-store.ts src/google-api.ts src/graph-mail.ts src/agent.ts` returns zero) passes today. |
| `h-cross-cutting/review-correctness.md` HR4 (LoggerLike vs pino.Logger confusion) | `02-type-interface-analysis.md` §"LoggerLike integration points" + `06-risks-and-mitigations.md` FR6 | **CONFIRMED** — F correctly states the 31 call sites satisfy the two-overload `LogFn` (per HR4's verdict); the H.1 test pin (`const l: LoggerLike = logger` compiles) extends to F.6 unchanged. |
| `e-process-lock/review-correctness.md` precedent (line-count / line-number drift) | F plan inherits the same risk pattern | **PARTIALLY APPLIED** — F has 5 critical line-count / line-number errors (C1, C2, C3, C4, C5) and one missing `Object.freeze` (M1), all of which match the E review's "line-count / line-number drift" pattern. None of E's specific findings re-appear in F. |
| `d-channel-provider/review-correctness.md` precedent (call-site count drift) | F plan inherits the same risk pattern | **APPLIED** — F has C3 (13 not 5 importers) and C4 (6 not 4 importers), matching D's M1 (14 not 32 `channelStateDir` sites) and M2 (1 not 2 `vi.doMock` outliers) call-site-count drift pattern. The drift is real but not the framework C3-style "fictional files" type. |

### Heartbeat double-timer hazard (FR1) correctly characterised

`heartbeat.ts:594-598` `stopHeartbeat()` does indeed clear the timeout
without setting `heartbeatTimeout = null` (verified verbatim: `if
(heartbeatTimeout) clearTimeout(heartbeatTimeout); logger.info(...)`).
The `heartbeat.ts:569-580` self-rescheduling `setTimeout` is also
verified verbatim (`heartbeatTimeout = setTimeout(async () => { ... });
if (!stopped) scheduleNext(nextDelayMs)`). FR1's two-compounding-
failures analysis is accurate.

### `refreshInFlight` singleton hazard (FR3) correctly characterised

`google-api.ts:108-118` shows:
```ts
let refreshInFlight: Promise<string> | null = null
function refreshAccessToken(): Promise<string> {
  // Single-flight: concurrent callers share one POST + one saveTokens.
  if (refreshInFlight) return refreshInFlight
  refreshInFlight = doRefresh().finally(() => { refreshInFlight = null })
  return refreshInFlight
}
```
The plan's "load-bearing single-flight" claim is correct; FR3's
`private static refreshInFlight: Promise<string> | null` mitigation
preserves the dedup semantics.

---

## Concrete fix list (must-resolve before implementation)

1. **C1.** Replace `index.ts:541-552` with `index.ts:487` (for
   `initHeartbeat()`) and `index.ts:545` (for `startStoreWatcher()`)
   in `00-summary.md` Scope row, `01-module-state-analysis.md` Startup
   ordering block, `03-class-boundaries.md` §F1 Constructor paragraph,
   `05-refactor-roadmap.md` F.1 Files touched row. The `:541-552`
   range is real only for `startStoreWatcher()` / `startChannelRequestWatcher()`,
   not `initHeartbeat()`.
2. **C2.** Rewrite FR8 to reflect actual source: the heartbeat prompt
   is built by `buildAgentPrompt()` at `heartbeat.ts:392` and consumed
   by `runAgent()` at `heartbeat.ts:550`; the `web/heartbeat-agent-scaffold.ts`
   file is a *boot-time scaffold* (imported in `src/index.ts:17`,
   called from `src/index.ts:517-519`), not a per-tick prompt builder.
   The `buildHeartbeatAgentPrompt` function name cited in FR8 does not
   exist anywhere in `src/`. The `web/main-agent.ts:49` reference is a
   comment in a file that has no heartbeat references.
3. **C3.** Replace "5 prod importers" with "13 prod importers" in
   `01-module-state-analysis.md` Per-file inventory row for
   `settings-store.ts`, `03-class-boundaries.md` §F4 free-function row,
   `05-refactor-roadmap.md` F.4 / F.8 gate descriptions. Add the
   per-file breakdown (8 missing files) to `01-module-state-analysis.md`.
4. **C4.** Replace "4 prod importers" with "6 prod importers" in
   `01-module-state-analysis.md` row for `agent.ts`,
   `03-class-boundaries.md` §F5 free function row, `05-refactor-roadmap.md`
   F.8 gate row. Add `web/federation/capability-runner.ts:17` and
   `web/routes/schedules.ts:7` to the F.8 gate's expected grep result
   list.
5. **C5.** Replace "4 `as any` + 1 `: any` = 5" with "3 `as any` + 1
   `as string` (widening) + 1 `: any` = **4 unsafe casts**" throughout
   `02-type-interface-analysis.md`. The §1 prose already says "actually
   3 `as any` + 1 `as string`" — propagate that count to the table
   headers. The `L178-182` cluster is **3 casts**, not 4.

## Concrete fix list (should-resolve, optional)

6. **M1.** Either drop the `Object.isFrozen` detection signal in
   FR-free-fn-debate (the const-ness of the binding is the actual
   immutability guarantee) or add an explicit `Object.freeze` to
   `DEFAULT_AUTO_RESTART` *before* F.5 lands (a one-line pre-F.5-prep
   commit).
7. **M2.** Update CE-7 framing from "prompt-builder" to "boot-time
   scaffold" — the file renders the heartbeat agent's CLAUDE.md once
   at boot (`renderHeartbeatClaudeMd` at `:135`) and materialises the
   agent's directory (`ensureHeartbeatAgent` at `:302`), but neither
   is invoked per-tick. The CE-7 carve-out from F scope remains
   correct.

## Net verdict

**NEEDS-FIX (5 critical items must be resolved before implementation;
2 major items recommended).**

The F plan has good bones: the 7 F-scope files are correctly
identified (NOT including `web/heartbeat-agent-scaffold.ts`), the
per-file line refs to `heartbeat.ts:565/566`, `store-watcher.ts:47/60/81`,
`settings-store.ts:17/18`, `agent.ts:81`, `google-api.ts:51/52/108`,
`graph-mail.ts:68/132`, and `auto-restart.ts:16/19/30-32/48-54/57-65/72-89/104-109/117-122`
all match the source; the FR1 (heartbeat timer state), FR3
(`refreshInFlight` singleton), and FR5 (`stop()` in-flight cancellation)
hazard characterisations are accurate; the `LazyCache<K, V>` rejection
on OE-6 grounds is correctly applied; the H dependency statements
(`LoggerLike`, `LazyBin<T>`) are correct; the HR1 `child()` exclusion
is correctly inherited from H; the test mock counts (1 / 4 / 13 / 2 /
0 / 0) are correct. The 5 critical issues are all metadata drift:
- `initHeartbeat()` is at `index.ts:487`, not `:541-552`;
- the heartbeat prompt builder (`buildAgentPrompt` at `:392`) is
  *not* in `web/heartbeat-agent-scaffold.ts` (which is a boot-time
  scaffold, not a per-tick prompt-builder);
- `settings-store.ts` has 13 production importers, not 5;
- `agent.ts` has 6 production importers, not 4;
- `agent.ts` has 4 unsafe casts (3 `as any` + 1 `: any`), not 5.

**Specific fixes before implementation:**
1-5 above (critical line-count / line-number / call-site-count drift).
6-7 above (major framing and Object.freeze fixes).

After applying 1-5, the plan is ready to implement (with optional
6-7). Without them, an executor implementing per the plan will:
- edit the wrong line range for `initHeartbeat()` (C1);
- look for a function that does not exist (C2);
- under-budget the F.4 / F.8 free-function migration by 8 files (C3);
- under-budget the F.5 / F.7 / F.8 gate by 2 files (C4);
- count the unsafe casts wrong and promise to clean up 1 cast that
  does not exist (C5);
- write a test that fails because `Object.isFrozen(DEFAULT_AUTO_RESTART)`
  returns `false` today (M1).

### Confidence level

- **High** on all file:line refs in `heartbeat.ts`, `store-watcher.ts`,
  `settings-store.ts`, `google-api.ts`, `graph-mail.ts`, `agent.ts`,
  `auto-restart.ts` — every claim verified by direct Read.
- **High** on the test-mock counts (1 / 4 / 13 / 2 / 0 / 0) — verified
  by direct `grep -rln` per file.
- **High** on the `web/heartbeat-agent-scaffold.ts` exports (4
  functions + 2 consts re-exports) — verified by direct `grep -n "^export"`.
- **High** on the FR1 (heartbeat double-timer), FR3
  (`refreshInFlight` singleton), and the `LazyCache<K, V>` rejection
  reasoning — verified by direct Read of the relevant source.
- **High** on the production-importer counts for `heartbeat.ts` (1),
  `google-api.ts` (1), `store-watcher.ts` (1), `graph-mail.ts` (0) —
  verified by direct `grep`.
- **High** on the 8 missing settings-store importers and the 2 missing
  agent.ts importers (C3 / C4) — verified by direct `grep` showing
  the additional importers at the cited line numbers.
- **High** on the C1 line range error — verified by `grep -n "initHeartbeat"
  src/index.ts` showing only `initHeartbeat()` at line 487.
- **High** on the C2 fictional function — verified by `grep -n "buildHeartbeatAgentPrompt"`
  returning zero hits across `src/`.
- **High** on the C5 unsafe cast count — verified by `grep -n "as any\|: any"
  src/agent.ts` returning exactly 4 lines (3 `as any` + 1 `: any`).
- **Medium** on the M1 Object.freeze claim — verified that
  `Object.freeze` does NOT appear in `src/auto-restart.ts`; the
  "mutating it would corrupt in-flight tests" claim in the plan is
  based on `const` reference immutability, not runtime freezing.

No claim in the F plan was found to be unverifiable.

---

## Out-of-scope claims — accuracy check

1. **`web/heartbeat-agent-scaffold.ts` out of F scope (CE-7)** —
   **CONFIRMED in exclusion; PARTIALLY REFUTED in rationale** (see M2).
   The file is correctly excluded; the rationale is wrong (per C2 / M2).

2. **`src/platform.ts` not in F scope (H owns `LazyBin`)** —
   **CONFIRMED**. `LazyBin` lives in `platform.ts` (H.3); F consumes it
   via `new ClaudeCodeBinResolver('claude')` (= `new LazyBin('claude')`).

3. **`src/memory.ts` not in F scope (framework A1 owns `MemoryStore`)** —
   **CONFIRMED**. `memory.ts:16` exports `runDecaySweep` as a free
   function today; F.1 takes a thin shim type until framework A1 lands.
   The plan correctly defers the `MemoryStore` instance-method call.

4. **`src/db.ts` not in F scope (framework D2 owns the keystone)** —
   **CONFIRMED**. `db.ts` is referenced by `heartbeat.ts` (via
   `getHeartbeatKanbanSummary`) and `store-watcher.ts` (via
   `logStoreFileEvent`), but those are free-function calls; the F plan
   correctly defers the `Database` class conversion.

5. **`src/web/inbox-nudge-watcher.ts` not in F scope (framework B5)** —
   **CONFIRMED**. The file has its own `fs.watch` instance and is part
   of the web runner cluster per the framework.

6. **All `src/__tests__/*` test files** — **CONFIRMED**. Tests get
   *updated* to match new class APIs but their layout, runner, and
   coverage targets are not in scope. Plan phrasing matches the
   framework CE-1 / CE-3 stance.

7. **No `bin/` scripts reach into F-scope modules** —
   **CONFIRMED** (per the 2026-08-26 audit cited in
   `01-module-state-analysis.md` §"Files outside src/ that depend on F").
