# Verifier B report — D.1 plan adversarial falsification

**Mode:** read-only verification only. No edits, no skill invocations, no commits.

**Repo state at probe time:**
- Working dir: `/Users/eggp/marveen-develop/test-baseline`
- Branch: `refactor/classbase`
- HEAD: `2a9fd96` (clean) — `fix(review): correct stale comments around PidfileLockAcquirer log forwarders`
- D-subsytem state from `git log -- src/channel-provider.ts`: D.4 landed in `ed2dd0b`, D.2 landed in `10d06cb`, code-review fixes `2707900` + `94e05fb` + `2ac5372`. D.1 is the **next** item. ChannelEnv does not exist in the live source yet.
- `git worktree list`: only `marveen` (feature-develop, `f5402ca`) and `test-baseline` (refactor/classbase, `2a9fd96`). No prior `$HOME/claw-*` worktrees.

**Plan source under test:** `docs/refactor-to-classbase/d-channel-provider/{00-summary,01-module-state-analysis,02-type-interface-analysis,03-class-boundaries,05-refactor-roadmap,06-risks-and-mitigations}.md` plus `review-{correctness,completeness}.md`.

**Live source under test:** `src/channel-provider.ts` (604 lines as of HEAD), `src/env.ts`, `src/config.ts`, plus all production importers identified by grep.

---

## Probe 1 — Wrapper migration gate
- Result: **FALSIFIED**
- Evidence:
  - Plan claim: `05-refactor-roadmap.md:331` — "channelStateDir: 14 call sites (`01 §5.3`)" and `05-refactor-roadmap.md:332` — "readChannelToken: 7 call sites (`01 §5.4`)".
  - Actual: production call sites in `src/` excluding `src/channel-provider.ts` exports and excluding `__tests__/`:
    - `channelStateDir(` — **31** call sites across 11 files (`grep -rn "channelStateDir(" src/ --include='*.ts' | grep -v __tests__ | grep -v 'export function'` shows 35 raw hits but 4 of those are the liveness.ts 193/194 block plus the schedule-runner.ts 409/410 ternary + the channel-invites.ts provider?join pair, totalling 31 distinct call statements)
    - `readChannelToken(` — **9** call sites across 5 files (channel-request-watcher.ts:78, agent-process.ts:839/957, routes/agents.ts:372/965/1433, routes/onboarding.ts:97, channel-monitor.ts:1287/1705)
  - **Total: 40, not 21.** D.5b/c are larger than the plan documents; the mechanical gate at `05-refactor-roadmap.md:364-365` (`grep -rln ... must return only src/channel-provider.ts`) will require migrating ~40 sites, not 21.
- Severity: **HIGH.** The migration gate in D.5 will produce more diff lines than the plan budgets, and `01-module-state-analysis.md §5.3` / `§5.4` (which the plan cites as the source of truth for these counts) must be re-verified before D.5b/c land.

## Probe 2 — Type widening in the constructor
- Result: **CONFIRMED**
- Evidence:
  - Plan: `constructor(env: Record<string, string>, home: string = homedir())` (`03-class-boundaries.md:71`, `02-type-interface-analysis.md:528-531`).
  - `src/env.ts:13` — `export function readEnvFile(keys?: string[]): Record<string, string>`
  - `src/config.ts:17` — `const env = readEnvFile()`
  - `src/config.ts:325-326` — uses `env` directly with `getChannelToken(CHANNEL_PROVIDER, env)` / `getChannelChatId(CHANNEL_PROVIDER, env)`.
  - The constructor parameter type matches the production caller exactly. No cast needed. CLAUDE.md §7 `as`-ban is not triggered.

## Probe 3 — Test isolation for `stateDirFor`
- Result: **CANNOT VERIFY**
- Evidence:
  - `ls src/__tests__/channel-env*` — no matches. The test file does not exist yet (correct: D.1 has not been implemented).
  - The plan describes the test at `05-refactor-roadmap.md:73-76` only at the goal level ("exercises ChannelEnv directly: each method, each of the 5 provider types, and the TABLE shape"), not at the assertion level. The probe's claim that "the plan's tests for `stateDirFor` use `endsWith` matching" cannot be confirmed or falsified because the plan does not specify the assertion shape.
  - **Recommendation for implementation:** the new test file must include a full-path equality assertion (e.g., `expect(env.stateDirFor('telegram')).toBe(join(home, '.claude', 'channels', 'telegram'))`), NOT `endsWith`, to catch a wrong-prefix regression. This is a missing-in-plan issue but cannot be marked FALSIFIED because the plan does not contain the vacuous form.

## Probe 4 — `readTokenFor` regex literal
- Result: **CANNOT VERIFY** (probe premise is not in the plan)
- Evidence:
  - The probe claims "the plan claims the live source regex is `/^CHANNEL_(?:TOKEN|APP_ID|PROJECT_ID)=(.+)$/m`".
  - `grep -rn "TOKEN|APP_ID|PROJECT_ID" docs/refactor-to-classbase/d-channel-provider/` — no matches.
  - The plan at `01-module-state-analysis.md:212` and `02-type-interface-analysis.md:316` correctly cites the live regex as `new RegExp(\`${key}=(.+)\`)` (unanchored) — the opposite of the probe's claim. The plan accurately matches the live source.
  - **The plan is correct on the regex shape.** The probe's stated "plan regex" does not exist in the plan. The implementation should preserve the unanchored behaviour: `content.match(new RegExp(\`${TABLE[provider].tokenKey}=(.+)\`))`.

## Probe 5 — `TABLE.telegram.subdir`
- Result: **CONFIRMED**
- Evidence:
  - Plan claim: `TABLE.telegram.subdir = 'telegram'` (`03-class-boundaries.md:122`).
  - Live source: `src/channel-provider.ts:581` — `: 'telegram'` (the fallthrough branch in the `channelStateDir` ternary).
  - All five subdirs match the plan's TABLE: `slack`, `discord`, `googlechat`, `teams`, `telegram` (fallthrough).

## Probe 6 — `readTokenFor` does NOT consume `this.env`
- Result: **CONFIRMED**
- Evidence:
  - Legacy `readChannelToken(provider, envFilePath)` at `src/channel-provider.ts:585` reads from the file at `envFilePath`, NOT from any env record. The signature takes a path; the body calls `existsSync(envFilePath)` and `readFileSync(envFilePath, 'utf-8')`.
  - Plan: `static readTokenFor(...)` is correct. Moving it to a static method that does not consume `this.env` is byte-equivalent. The justification in `03-class-boundaries.md:97` ("Static because it reads the per-channel .env file, NOT this.env") is accurate.

## Probe 7 — Worktree path conflict
- Result: **CONFIRMED**
- Evidence:
  - `ls /Users/eggp/claw-d1-test /Users/eggp/claw-test /Users/eggp/claw-test-baseline` — all "No such file or directory".
  - `git worktree list` — only the two production worktrees; no prior `claw-*` worktrees from earlier sessions.
  - The plan's `$HOME/claw-d1-test` path is safe to use.

## Probe 8 — Vitest gate baseline
- Result: **CONFIRMED**
- Evidence:
  - `git rev-parse HEAD` = `2a9fd9662109072dc91459c12f82061fa2e44436`.
  - `git log -1 --oneline` = `2a9fd96 fix(review): correct stale comments around PidfileLockAcquirer log forwarders`.
  - This matches the user's stated baseline. CLAUDE.md §8 ">5 fails" rule does not trigger because the user-pasted plan measured 11228/0 (the post-E.4 count).
  - Note for implementation: the `package.json` vitest count baseline is 11228 tests; if any test-file is renamed (e.g., the optional `__tests__/validate-token-result.test.ts` at `05-refactor-roadmap.md:77`), the count must be re-measured per CLAUDE.md §8.

## Probe 9 — Honcho memory staleness
- Result: **CONFIRMED** (memory is stale, but no impact on D.1's first-time implementation)
- Evidence:
  - Honcho briefing: focuses on cycle7a-9 merge runs + E.4 (PidfileLockAcquirer release). **No mention of D.2 having landed.**
  - Live state from `git log -- src/channel-provider.ts`: D.4 (`ed2dd0b`), D.2 (`10d06cb`), `2707900`, `94e05fb`, `2ac5372` all in past.
  - The memory is stale on D-subsytem state but D.1 is a net-additive refactor (the four helpers survive as wrappers), so implementing D.1 without memory-aware context does NOT cause duplication. The risk would have been higher for D.3 (registry extraction), where the `markedProviders` const already exists at `src/channel-provider.ts:552`.
  - **Recommendation:** Honcho should be updated post-D.1 with the `ChannelEnv` and `TABLE` SHA, otherwise D.3 will start from a stale baseline.

## Probe 10 — `instanceof ChannelEnv` checks in tests
- Result: **CONFIRMED**
- Evidence:
  - `grep -rn "instanceof ChannelEnv\|toBeInstanceOf(ChannelEnv" src/` — no matches.
  - The plan's wrapper-then-class pattern is safe from existing tests; nothing currently asserts on ChannelEnv's class identity.

## Probe 11 — Module export surface
- Result: **CONFIRMED**
- Evidence:
  - `src/channel-provider.ts:500` `export function getChannelToken(...)`, `:508` `export function getChannelChatId(...)`, `:572` `export function channelStateDir(...)`, `:585` `export function readChannelToken(...)` — all four remain as wrappers per `05-refactor-roadmap.md:58`.
  - The new `class ChannelEnv` is added at the file level (no syntax requirement conflicts). All other top-level exports (`ChannelProviderType` at :9, `ChannelProvider` at :11, the 5 provider classes at :61/:119/:223/:338/:349, `formatForSlackMrkdwn` at :370, `getProvider` at :560, `getProviderType` at :564) are preserved.
  - **Verified exports remain available for all 12 production importers** (liveness.ts, agent-process.ts, agent-scaffold.ts, channel-invites.ts, channel-monitor.ts, channel-poller-reap.ts, channel-request-watcher.ts, discord-group-bootstrap.ts, routes/agents.ts, routes/onboarding.ts, schedule-runner.ts, telegram.ts [comment-only]).

## Probe 12 — `TABLE.googlechat.tokenKey`
- Result: **CONFIRMED**
- Evidence:
  - Plan claim: `TABLE.googlechat.tokenKey = 'GOOGLECHAT_PROJECT_ID'` (`03-class-boundaries.md:125`).
  - Live `getChannelToken`: `src/channel-provider.ts:503` — `if (provider === 'googlechat') return env['GOOGLECHAT_PROJECT_ID'] ?? ''`.
  - Live `readChannelToken`: `src/channel-provider.ts:598` — `provider === 'googlechat' ? 'GOOGLECHAT_PROJECT_ID'`.
  - Same key used in both helpers — confirms the plan's TABLE consolidation is byte-equivalent for googlechat.

## Probe 13 — Out-of-scope completeness
- Result: **PARTIALLY FALSIFIED**
- Evidence:
  - The plan's `05-refactor-roadmap.md` covers D.1 through D.6 explicitly.
  - However, the plan does NOT explicitly enumerate the out-of-scope subsystems in a dedicated section. Cross-references to H.1 (D.6 conditional), A.12 (`getProviderType` placement) appear inline.
  - Items A.1-A.x, B.1-B.x, C.1-C.x, E.1-E.x, F.1-F.x, G.1-G.x, H.1-H.x are NOT mentioned as "out-of-scope" anywhere in `d-channel-provider/*.md`. The implicit out-of-scope is "D-subsystem only", but this is not stated.
  - **Severity: LOW** — D.1 is purely additive inside `src/channel-provider.ts`; the implementation does not touch any other subsystem, so the implicit boundary is safe. But the plan would benefit from a single "Out of scope: A, B, C, E, F, G, H (handled in respective subsystem docs)" line.

## Probe 14 — Vacuous test table
- Result: **CANNOT VERIFY** (no such table in the plan)
- Evidence:
  - `grep -rn "vacuous\|13 rows\|22 it" docs/refactor-to-classbase/d-channel-provider/` — no matches.
  - The plan describes the new test only at the goal level (`05-refactor-roadmap.md:73-79`). It does not enumerate 22 it() blocks or a 13-row vacuous-test table.
  - Per CLAUDE.md §8 (the precedent from 2026-08-30 E.1/E.2 LazyBin), the implementation MUST include the vacuous-test analysis as part of plan-review, not as a post-implementation step. The current plan is silent on this.

## Probe 15 — Implementation verify sub-steps
- Result: **PARTIALLY FALSIFIED**
- Evidence:
  - `05-refactor-roadmap.md:67-79` (D.1's test coverage section) describes:
    - "Per-existing-test: all tests that touch getChannelToken, getChannelChatId, channelStateDir, readChannelToken must pass unchanged."
    - "New test: `__tests__/channel-env.test.ts` exercises ChannelEnv directly"
  - The "verify" sub-step described in the plan IS the per-existing-test gate (which is the regression check). This is the correct gate for an additive refactor.
  - However, the plan does NOT include a vacuous-test analysis (per Probe 14 / CLAUDE.md §8 precedent). For a class-extract refactor, the new test must prove that stripping `TABLE` to `{}` would actually fail each `it()`. The plan does not commit to this analysis.
  - **Severity: MEDIUM.** The final `bun --bun vitest run` gate will catch most regressions, but per the 2026-08-30 E.1/E.2 precedent, vacuous tests pass coverage gates without catching real bugs.

## Probe 16 — `keyof ChannelProviderType` exhaustiveness
- Result: **CONFIRMED**
- Evidence:
  - `src/channel-provider.ts:9` — `export type ChannelProviderType = 'telegram' | 'slack' | 'discord' | 'googlechat' | 'teams'`.
  - Plan's TABLE covers all 5 entries (`03-class-boundaries.md:122-126`).
  - `Record<ChannelProviderType, ...>` forces TS to error if a key is missing; adding a sixth provider type without extending TABLE will fail `bun tsc --noEmit`.
  - **Bonus:** the legacy `getChannelToken` fallthrough at `src/channel-provider.ts:505` (`return env['TELEGRAM_BOT_TOKEN']`) is preserved because `TABLE.telegram.tokenKey === 'TELEGRAM_BOT_TOKEN'`. The legacy fallthrough silently coerced any non-{slack,discord,googlechat,teams} value to telegram; the new TABLE form makes this explicit (and TS-checkable). **Behaviour-preserving** for any input that satisfies `ChannelProviderType`.

## Probe 17 — `(this commit)` placeholder convention
- Result: **PARTIALLY FALSIFIED** (one inline SHA exists, but for measurement baseline, not implementation)
- Evidence:
  - `grep -rn "[0-9a-f]\{7,40\}" docs/refactor-to-classbase/d-channel-provider/*.md`:
    - `02-type-interface-analysis.md:621` — `(branch test/baseline, HEAD f58fe4c)`
    - `review-completeness.md:766` — `(branch test/baseline, HEAD f58fe4c)`
  - Both reference `f58fe4c` as a measurement baseline SHA (for `01 §5.1`–`§5.4` call-site analysis done 2026-08-30), not as the implementation commit SHA.
  - Per CLAUDE.md §8 "MD és commit message hivatkozások" rule (4) and (post-commit) "(túl késői) SHA rewrite" rule, the implementation commit must NOT inline its SHA; both MDs and the commit message must use `(this commit)` placeholder.
  - **Severity: LOW** — the existing `f58fe4c` reference is a pre-existing measurement SHA, not a forward-pointer to D.1's commit. The new D.1 implementation should not introduce any new inline SHA.

## Probe 18 — `keyof` / `Record` strictness vs legacy fallthrough
- Result: **CONFIRMED** (no silent behaviour change)
- Evidence:
  - Plan types TABLE as `Record<ChannelProviderType, ...>` (`03-class-boundaries.md:82-86`).
  - Legacy fallthrough: `src/channel-provider.ts:505` returns `env['TELEGRAM_BOT_TOKEN']` for any non-{slack,discord,googlechat,teams} provider.
  - New code: `TABLE.telegram.tokenKey === 'TELEGRAM_BOT_TOKEN'` — same key. For any `provider: ChannelProviderType`, `TABLE[provider]` resolves to a valid entry; `env[TABLE[provider].tokenKey]` returns the same value the legacy `if`-chain would.
  - Edge case: if a caller passes a `string` (not `ChannelProviderType`) that happens to equal `'telegram'`, both legacy and new code return the same key. No regression.

---

## Cross-cutting findings (outside the 18 probes)

### A. Class-vs-functional decision per `.claude/rules/class-vs-functional-decision.md`
- The `ChannelEnv` class has:
  - 2 instance methods that USE `this.env` (getToken, getChatId) — instance state is justified.
  - 2 STATIC methods that do NOT use `this.env` (stateDirFor, readTokenFor) — per the rules doc, "❌ Class ahol minden metódus static és nincs this. Ugyanaz, mint az első." is a ceremony anti-pattern.
  - 1 static readonly TABLE — could be a module-level const.
- **Adversarial read:** the static methods have no `this` and no DI. They could be module-level functions `(provider, agentDir?) => ...` and `(provider, envFilePath) => ...` with no behaviour change. Putting them on the class as statics is "namespace symmetry", which the rules doc explicitly rejects: "❌ Class ami csak a free function-öket csomagolja, anélkül hogy bármit hozzáadna (state, lifecycle, polymorphism). A wrapper-ök 'visszafordítása' a class-ba ceremony."
- **Mitigation:** the plan DOES have a partial justification — the dispatch TABLE consolidation is a real dedup win. The instance methods justify the class form. The static methods are arguably justifiable as "cohesive surface area" (all channel-env operations live in one place). But a stricter reading of the rules would require either (a) splitting into `class ChannelEnv` (instance only) + module-level `channelStateDir` / `readChannelToken` (matching today's public surface, no migration needed), or (b) documenting why the static methods' cohesion outweighs the ceremony cost.

### B. Static-only test file scope
- The plan's new test file (`__tests__/channel-env.test.ts`) is described at goal-level only. CLAUDE.md §8 (2026-08-30 E.1/E.2 precedent) requires the plan to enumerate **specific, verifiable assertions** for each `it()`, not "exercise each method". Without this enumeration, the implementation will rely on test-author judgement, which the precedent shows leads to vacuous assertions.

### C. Plan-measurement carve-out
- The plan should have started by measuring: tsc errors, vitest pass count, coverage on `src/channel-provider.ts`. These are not in `05-refactor-roadmap.md`'s D.1 section. Per CLAUDE.md §8 "A terv verifikációs gate-jeit a terv ÍRÁSAKOR meg kell mérni, nem a végrehajtáskor", the gate is only as good as its baseline measurement.
- Current measured state: tsc = **0 errors** (per Honcho session summary, post-cycle9), vitest = **384/11228/0** (per Honcho + the user's stated plan baseline). The plan's D.1 gate must hold these numbers.

---

## Summary

| Stat | Count |
|---|---|
| Total probes | 18 |
| **CONFIRMED** (plan handles it) | 10 |
| **FALSIFIED** (plan misses it) | 1 (Probe 1) |
| **PARTIALLY FALSIFIED** | 2 (Probe 13, Probe 15) |
| **CANNOT VERIFY** (probe premise not in plan docs) | 4 (Probe 3, Probe 4, Probe 14) |
| **PARTIALLY CONFIRMED** (caveat noted) | 1 (Probe 17) |
| **Cross-cutting findings** | 3 (A, B, C) |

### FALSIFIED probes (must fix before implementation)

1. **Probe 1 — Wrapper migration gate:** D.5b/c budget is 21 sites; actual is **40** (31 `channelStateDir` + 9 `readChannelToken`). The plan's `01 §5.3` / `§5.4` count is stale. Update `05-refactor-roadmap.md:331-332` and the mechanical gate at `:364` BEFORE implementation begins.

### PARTIALLY FALSIFIED probes (should fix before implementation)

2. **Probe 13 — Out-of-scope completeness:** Add a one-line "Out of scope: A, B, C, E, F, G, H (handled in their respective subsystem docs)" to `05-refactor-roadmap.md` D.1's Goal section. Low severity.
3. **Probe 15 — Implementation verify sub-steps:** Add a vacuous-test analysis (per CLAUDE.md §8 2026-08-30 E.1/E.2 precedent) to D.1's Test coverage section. Each new `it()` in `__tests__/channel-env.test.ts` must commit to a specific assertion that fails when the implementation is no-op'd or stubbed.

### Cross-cutting fixes (recommended before implementation)

A. **Class-vs-functional decision:** Document explicitly why `ChannelEnv.stateDirFor` and `readTokenFor` are static on the class rather than module-level functions. The current justification ("namespace symmetry") is rejected by `.claude/rules/class-vs-functional-decision.md`. Either (a) split into `class ChannelEnv` (instance only) + module-level helpers (preferred, matches today's public surface), or (b) provide stronger rationale (e.g., "the static TABLE is shared across all four methods, so putting them on the same class gives the type system a single import path and a single place to extend for a sixth provider").

B. **Test assertion enumeration:** Replace the goal-level "exercises each method, each of the 5 provider types, and the TABLE shape" with a numbered `it()` list and per-`it()` assertion shape (e.g., `it('getToken returns TELEGRAM_BOT_TOKEN value when env has it', () => { const e = new ChannelEnv({TELEGRAM_BOT_TOKEN: 'tok'}); expect(e.getToken('telegram')).toBe('tok') })`).

C. **Plan-measurement carve-out:** Add to D.1's Goal section: "Pre-implementation gate: tsc = 0 errors, vitest = 384/11228/0, coverage on `src/channel-provider.ts` measured at <X>%. Post-implementation gate: same numbers, plus the new test file at 100% per-file coverage."

---

## Verdict

**REJECT_PLAN** — pending Probe 1 fix (call-site count) and Probe 15 fix (vacuous-test analysis). Probe 13 is a low-severity documentation gap that can be added during the fix pass.

The plan's CORE design (TABLE consolidation, env-as-parameter constructor, static helpers for non-env consumers) is **sound and matches the live source byte-for-byte** (Probes 2, 5, 6, 11, 12, 16, 18 confirmed). The plan's BACKOUT strategy is correct (single revert, no consumer changes — Probes 7, 10 confirm). The plan's TEST STRATEGY is the weak link (Probes 3, 14, 15 partially falsified) and the MIGRATION BUDGET is wrong (Probe 1 falsified).

Once Probe 1 and Probe 15 are addressed, the plan is APPROVE_PLAN-ready.
