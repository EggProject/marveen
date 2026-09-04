# Tight Batch Cycle 39 -- 2 runtime bug + 6 channel-monitor branch + 1 message-router inversion + 6 MD cleanup

## Context

`test/baseline` HEAD = `48739c9`. After cycle 38, 18 items remained in `docs/needs-to-be-fix/INDEX.md` with `Resolved: --`. Exploration found:
- 5 of the 18 are already fixed at HEAD (only docs/MD cleanup missing)
- 1 is doc-only
- 12 are real unresolved items, of which 4 are safe-and-small in the current scope.

User picked the **tight batch** (2 runtime bug + 6 unreachable branch + 1 stylistic inversion + 6 MD cleanup). User override granted for editing `src/web.ts` and `src/web/agent-worker.ts` for **this cycle only**.

Two independent Plan agents designed the scope; their outputs agreed except that BOTH flagged line 1060 as **unsafe** (the MD's "no production path produces the ordering" is empirical, not structural). The current plan excludes line 1060.

## Scope (8 source/test changes + 6 MD file changes + INDEX update)

### A1. `web-port-reclaim-failure-leaves-unbound` (Medium, real runtime bug)

**`src/web.ts:274-276`** -- the outer `catch` of the `EADDRINUSE` reclaim. Currently:
```ts
} catch (e) {
  logger.error({ err: e }, 'Port-reclaim failed')
}
```
Change to:
```ts
} catch (e) {
  logger.error({ err: e }, 'Port-reclaim failed -- kilepes')
  process.exit(1)
}
```
Precedent: the sibling zero-victims branch at `src/web.ts:270-272` already uses `process.exit(1)`. The `-- kilepes` suffix matches the sibling convention.

**`src/__tests__/web-server.test.ts:921-931`** -- rename test to "logs and exits(1) when the reclaim itself throws", add `expect(exitCalls).toEqual([1])`. The `exitCalls` array is reset in `beforeEach` at `web-server.test.ts:359`, populated at line 401, and asserted on at lines 733, 858, 869, 883, 918 (existing convention).

### A2. `agent-worker-settings-symlink-preserve` (Medium-High, real data-loss bug)

**`src/web/agent-worker.ts:2`** -- add `readlinkSync` to the existing `node:fs` import.

**`src/web/agent-worker.ts:378-381`** -- currently:
```ts
if (sst?.isSymbolicLink()) {
  rmSync(settingsPath, { force: true })
} else if (existsSync(settingsPath)) {
```
Change to:
```ts
if (sst?.isSymbolicLink()) {
  try {
    const target = readlinkSync(settingsPath)
    const parsed = JSON.parse(readFileSync(target, 'utf-8'))
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) current = parsed as WorkerSettings
  } catch { /* rewrite */ }
  rmSync(settingsPath, { force: true })
} else if (existsSync(settingsPath)) {
```
The `try/catch` mirrors the existing else-branch pattern at lines 382-385 (malformed JSON falls back to `{}`).

**`src/__tests__/agent-worker-full.test.ts:520-532`** -- current test "replaces a symlinked settings.json (the shared copy) with an owned file" PINS the buggy behavior with a comment. Rename to "preserves the shared settings.json content (hooks) when replacing a symlink with an owned file", and replace the buggy-behavior comment with `expect(s.hooks).toEqual({ Stop: [] })`. The companion test at `agent-worker-full.test.ts:492-508` ("removes a symlinked settings.json then writes an owned file") is unaffected (only asserts symlink state, not content).

### B1. `channel-monitor-unreachable-defensive-branches` (Low, 6 of 7 lines; line 1060 EXCLUDED)

**`src/web/channel-monitor.ts`** -- six surgical changes (line 1060 excluded; see "Risks"):

- **Line 405**: `const landed = prevSig != null ? submitLanded(prevSig, captureParkedInputView(session)) : false` -> `const landed = submitLanded(prevSig, captureParkedInputView(session))`. **Keep `prevSig: string | null` signature; use `!` at line 405 only** (signature change could ripple).

- **Line 1248**: `const ageMin = Math.round((ageMs ?? 0) / 60000)` -> `const ageMin = Math.round(ageMs! / 60000)`. Keep `ageMs: number | null` local type (the `catch { ageMs = null }` is still needed for the early-return path at line 1222).

- **Line 1285**: drop `&& !marveenDownState.conflictProbed` from the IF predicate, leaving the body unconditional. The predicate was structurally always-true because `marveenDownState` is null before this block (line 1277 `if (!marveenDownState)`), so `conflictProbed` is always `undefined` -> `!undefined = true`. **BEHAVIOR CHANGE**: the probe now fires on every fresh cascade entry (instead of once per session). The MD comment about "don't spam the upstream API every poll while recovery is running" still holds within a single cascade tick. Telegram tolerates this.

- **Line 1326**: `const saveStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince` -> `const saveStartedAt = marveenDownState.stageStartedAt!`. Verified: stageStartedAt is unconditionally written at line 1319 before any read in the `if (marveenDownState.stage === 'save')` block.

- **Line 1327**: out of scope (the MD's note about SAVE_WINDOW_MS matching the cascade interval is a separate defect, defer).

- **Line 1336**: `const resumeStartedAt = marveenDownState.stageStartedAt ?? marveenDownState.downSince` -> `const resumeStartedAt = marveenDownState.stageStartedAt!`. Same guarantee as line 1326 (unconditional write at line 1329).

**`src/__tests__/channel-monitor-baseline.test.ts:560-595`** ("baseline: handleMarveenDown telegram conflict-probe else (line 1285)") -- update the `toHaveBeenCalledTimes(1)` assertion to `toHaveBeenCalledTimes(2)` for the re-down cycle. The test's first cascade entry still fires the probe once; the second fresh cascade entry fires it again under the fixed behavior.

### B2. `message-router-dead-defensive-branches` (Low, stylistic inversion)

**`src/web/message-router.ts:179-184`** -- invert the conditional:
```ts
const stamped = stampMessageTrace(msg.id, trace_id, span_id, parent_span_id)
if (!stamped) return { trace_id, span_id, parent_span_id }
const operation = `${msg.from_agent}->${msg.to_agent}`
upsertOtelSpan({ trace_id, span_id, parent_span_id, agent_id: msg.from_agent, operation, start_ms: nowMs, attributes: null })
return { trace_id, span_id, parent_span_id }
```
Pure-mechanical per `ba6faf8` precedent. **No test change needed** -- `message-router-full.test.ts:848` exercises the existing-trace path (unaffected); `message-router-full.test.ts:1540-1575` exercises both true and false return values via `mockReturnValueOnce`.

### C1-C6. MD cleanup (docs only, 6 files + INDEX.md)

| # | MD file | Action | Resolved ref |
|---|---------|--------|--------------|
| C1 | `docs/needs-to-be-fix/channel-monitor-agentDownSince-fallback.md` | delete (fix already at HEAD; line 1647 uses `!`) | `c2b4ea2` (2026-08-14) |
| C2 | `docs/needs-to-be-fix/channel-monitor-agentName-fallbacks.md` | delete (fix already at HEAD) | `08d7508` (2026-08-14) |
| C3 | `docs/needs-to-be-fix/channel-monitor-test-holes.md` | delete (un-skipped tests at HEAD) | `1522111` (2026-08-08) |
| C4 | `docs/needs-to-be-fix/test-suite-guard-marker-only-blind.md` | delete (whole-store detection shipped 2026-08-06) | `393b3b6` (2026-08-06) |
| C5 | `docs/needs-to-be-fix/test-suite-macos-only-portability.md` | delete (MD opens with `**Status:** fixed`) | `69244f0` (2026-08-14) |
| C6 | `docs/needs-to-be-fix/federation-routes-fedpeer-required-type-narrow-deferred.md` | keep, prepend `**Status:** RESOLVED (documented only)` | n/a |

**`docs/needs-to-be-fix/INDEX.md`** -- update these rows in the same docs commit:
- Row 31 (`test-suite-guard-marker-only-blind`): `Resolved: 2026-08-06 393b3b6`
- Row 54 (`test-suite-macos-only-portability`): `Resolved: 2026-08-14 69244f0`
- Row 38 (`web-port-reclaim-failure-leaves-unbound`): `Resolved: <pending>` (filled by follow-up commit per CLAUDE.md convention)
- Row 117 (`channel-monitor-test-holes`): `Resolved: <pending>`
- Row 118 (`channel-monitor-unreachable-defensive-branches`): `Resolved: <pending>`
- Row 218 (`federation-routes-fedpeer-required-type-narrow-deferred`): `Resolved: <pending> (documented only)`
- Rows 214, 215 (`channel-monitor-agentDownSince-fallback`, `channel-monitor-agentName-fallbacks`): already show `Resolved` -- no edit, just verify.

Then a follow-up `docs(needs-to-be-fix): fill Resolved SHAs` commit replaces the four `<pending>` placeholders with the real SHAs from commits 1-3.

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/src/web.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/web-server.test.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/web/agent-worker.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/agent-worker-full.test.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/web/channel-monitor.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/channel-monitor-baseline.test.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/web/message-router.ts`
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md`
- 6 MD files under `docs/needs-to-be-fix/` (C1-C6)

## Commit sequence

Per CLAUDE.md convention (single-purpose commits, builds cleanly, no SHA in docs commit):

1. **`fix(web): exit(1) when port-reclaim throws`** -- A1 (src/web.ts + test)
2. **`fix(agent-worker): preserve shared settings.json when replacing a symlink`** -- A2 (src/web/agent-worker.ts + test)
3. **`refactor(channel-monitor): drop 6 unreachable defensive branches`** -- B1 (src/web/channel-monitor.ts + 1 test update)
4. **`refactor(message-router): invert stampTraceOnMessage if-stamped`** -- B2 (src/web/message-router.ts, no test change)
5. **`docs(needs-to-be-fix): mark 6 MDs Resolved and update 6 INDEX rows`** -- C1-C6 + INDEX.md
6. **Follow-up: `docs(needs-to-be-fix): fill Resolved SHAs`** -- replace 4 `<pending>` placeholders with real SHAs from commits 1-3

Local only. **NO push.** Push is user-only.

## Verification

After commit N, before commit N+1:

1. **Targeted test runs** in an isolated worktree (per CLAUDE.md / store pollution guard):
   - `git worktree add --detach /tmp/claw-test-cycle39 test/baseline`
   - `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-test-cycle39/node_modules`
   - Commit N is replayed into the worktree (or fast-forwarded), then:
     - `cd /tmp/claw-test-cycle39 && bun --bun vitest run src/__tests__/web-server.test.ts` (A1)
     - `bun --bun vitest run src/__tests__/agent-worker-full.test.ts` (A2)
     - `bun --bun vitest run src/__tests__/channel-monitor-baseline.test.ts` (B1)
     - `bun --bun vitest run src/__tests__/message-router-full.test.ts` (B2)
2. **Full suite** at the end: `bun --bun vitest run` -- report pass count.
3. **TypeScript check** on modified files only: `bunx tsc --noEmit -p tsconfig.json 2>&1 | grep -E 'src/(web\.ts|web/(agent-worker|channel-monitor|message-router)\.ts)'`. Compare delta against baseline (`48739c9`).
4. **No push, no CI invocation.**

After cycle 39 completes, the user invokes `/code-review max --fix` (the skill has `disable-model-invocation`; **I cannot invoke it via the Skill tool** -- the user must run it in their terminal).

## Workflow execution

Per user instruction, the cycle is executed via the Workflow tool with a script that:
- Starts from current branch (`test/baseline`, HEAD `48739c9`)
- Returns to current branch
- Runs sequentially: A1, A2, B1, B2, C1-C6, follow-up docs
- Uses isolated worktree per CLAUDE.md / store pollution rules

## Risks / constraints

1. **B1 line 1060 EXCLUDED**: both Plan agents independently verified the optional chain at `src/web/channel-monitor.ts:1060` is structurally needed because `capturePane` and `captureParkedInputView` are independent functions, both returning `string | null`, and the MD's "no production path produces the ordering" is empirical, not structural. Existing test at `channel-monitor-baseline.test.ts:652-682` drives the `: null` arm via `capturePane.mockReturnValue(null)`. **Do not touch.**
2. **B1 line 1285 behavior change**: probe now fires on every fresh cascade entry (was: once per session). This is a behavior change visible to Telegram. Telegram tolerates it; flagging for awareness. The test update from `toHaveBeenCalledTimes(1)` to `toHaveBeenCalledTimes(2)` documents the new behavior.
3. **B1 line 405 signature**: keep `prevSig: string | null` signature to avoid call-site ripple; use `!` at the read site.
4. **B1 line 1248**: keep `ageMs: number | null` local type; use `!` at the read site (the catch block at line 1222 is still needed).
5. **TypeScript error budget**: each `!` assertion avoids the +1 per call-site error that strict narrowing would add. Net cycle 39 delta should be ~0.
6. **C1-C6 SHAs must be verified** before the docs commit lands (the Plan agents verified; if any SHA is wrong, fix it in the same docs commit).
7. **User override scope**: `src/web.ts` and `src/web/agent-worker.ts` modifications are approved for this cycle only. The standing `NEVER modify src/web/keychain.ts` rule is unchanged.
8. **No push.** No CI. The user invokes `/code-review max --fix` themselves.

## Out of scope (deferred)

- B1 line 1060 (capturePane optional chain -- structurally needed)
- B1 line 1327 (SAVE_WINDOW_MS == cascade interval -- separate defect)
- `web-agent-scaffold-defensive-coverage` (18 branches, all with dedicated pinning tests)
- `message-router-cache-fallback-unreachable` (prior fix made coverage worse; needs refactor)
- `federation-inbox-fedPeer-null-fallback` (blocked by type narrowing)
- `channel-request-watcher-unreachable-provider-check` (token leak risk)
- `test-suite-store-pollution-store-dir-frozen` (architectural, ~50 files)
- `web-inbound-probe-respawn-grace`, `web-agent-worker-runviaworker-coverage`, `federation-v8-coverage-quirks`, `channel-coordinator-internals-untestable`, `index-unreachable-coverage` (coverage gaps, not dead code)
- `routes-agents-br-baseline-partial-coverage` (67 branches, mixed safe/unsafe)