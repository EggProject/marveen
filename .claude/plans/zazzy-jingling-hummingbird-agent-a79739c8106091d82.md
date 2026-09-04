# Cycle 37 verification report

Verdict: FAIL. One REFUTED claim in fix B's test inversion. One CONCERN in CLAUDE.md §7 compliance. All other claims verified.

## REFUTED claims

### R1 — Fix B's test inversion `expect(dot.projects).toEqual({})` is factually wrong

**Plan claim** (lines 210-211):
```
expect(dot).toMatchObject({ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 99 })
expect(dot.projects).toEqual({})
```

**Reality**: After fix B coerces the array `[]` to `{}`, the downstream code at `src/web/agent-worker.ts:410-418` STILL populates `projects[ctxSlow.home]` with the trusted object. So `dot.projects` is NOT `{}` — it is `{ [ctxSlow.home]: { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 } }` (possibly with a second entry from the `realpathSync` branch at line 416).

Trace:
1. Fix B coerces `homeClaudeRaw = []` to `homeClaudeObj = {}`.
2. `parsed = homeClaudeObj = {}` (declared at line 407-408 post-fix).
3. `stampWorkerFirstRun(parsed)` sets `parsed.hasCompletedOnboarding = true`, `parsed.fullscreenUpsellSeenCount = 99` (since `Number(undefined) = NaN`, `Number.isFinite(NaN) = false`, falls into the `: 99` branch — that part of the claim IS correct).
4. `projects = (parsed.projects && typeof parsed.projects === 'object') ? parsed.projects : {}` — parsed.projects is `undefined`, so `projects = {}`.
5. `base = (projects[PROJECT_ROOT] && typeof projects[PROJECT_ROOT] === 'object') ? projects[PROJECT_ROOT] : {}` — undefined, so `base = {}`.
6. `trusted = { ...base, hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 1 }`.
7. `keys = new Set([ctx.home])` — `ctx.home = ctxSlow.home = ${H.root}/home/.marveen-worker` (per `workerHomeFor('marveen', 'slow')` at line 101-103 and `homedir()` mocked to `H.home` at test line 49-52).
8. `try { keys.add(realpathSync(ctx.home)) } catch {}` — `ctx.home` exists (recreated in beforeEach at line 194 of the test), so realpath resolves and adds a second entry; even if it didn't, `keys` still has `ctx.home`.
9. `for (const k of keys) projects[k] = { ...trusted }` — projects now has at least one non-empty key.
10. `parsed.projects = projects` — written to disk.
11. `JSON.stringify(parsed, null, 2) + '\n'` serialises `{ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 99, projects: { ... } }`.

So the inverted assertion `expect(dot.projects).toEqual({})` will FAIL because `dot.projects` is a non-empty object.

**Note**: `expect(dot).toMatchObject({ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 99 })` IS correct and will pass (those keys are present). The `dot.projects === {}` assertion is the broken one.

**Fix**: Either drop the `expect(dot.projects).toEqual({})` assertion, or replace it with `expect(dot.projects[ctxSlow.home]).toMatchObject({ hasTrustDialogAccepted: true })` (or similar).

## CONCERNs

### C1 — CLAUDE.md §7 forbids `as`; plan's cast violates the rule

CLAUDE.md §7 verbatim: "tilos az `as` használata helyette `satisfies` -t kell használni" (forbidden to use `as`; use `satisfies` instead).

The plan's fix B introduces `as Record<string, unknown>` at the cast in the array-coerce.

The plan's defense calls this a "narrowing assertion (TS has already structurally verified the value through `typeof` + `Array.isArray`)". This defense is FACTUALLY WRONG: the cast goes from `object` (the narrowed type from `typeof === 'object' && !Array.isArray`) to `Record<string, unknown>`. `Record<string, unknown>` is structurally LARGER than `object` (it permits any string key with unknown value), so this is a WIDENING cast, not a narrowing one. The defense contradicts itself.

In practice, the codebase already uses `as` in many places (agent-taskstate.ts, auth-sessions.ts, hook-registration-guard.ts, agent-scaffold.ts, profiles.ts, vault-bindings.ts). So `bun tsc --noEmit` will accept the cast. But the project rule is unambiguous; the plan should either:
- Replace `as Record<string, unknown>` with a `satisfies` clause (CLAUDE.md-compliant), or
- Use a type guard function that returns `Record<string, unknown>` (matches the project's existing `pane-state.ts` and `channel-monitor.ts` pattern that the plan references — those patterns use type guards, not `as` casts).

### C2 — Fix A's auth-recovery flow result is `authFailed: true`, not the plan's stated `error: 'worker session not ready'`

The plan claims (line 128-129):
> Returning `false` lets `ensureWorkerReady`'s caller (`runWorkerAttempt`) fall through to its `'fail'` branch with `error: 'worker session not ready'`, which `runViaWorker` (lines 727-739) converts to `{ text: null, error: '...' }`.

Trace:
- ensureWorkerReady on attempt 1 returns false (caught throw).
- runWorkerAttempt at line 651-656: `if (!ready) { if (workerPaneHasAuthFailure(ctx)) return { kind: 'auth' }; return { kind: 'fail', error: 'worker session not ready' } }`.
- The test mocks `capturePane` to return a 35-line string containing `'Please run /login'` at line 34 (test line 1300-1302). `WORKER_AUTH_FAILURE_RX` at line 171 matches `Please run /login`. So `workerPaneHasAuthFailure(ctx)` returns TRUE.
- Therefore runWorkerAttempt returns `{ kind: 'auth' }`, NOT `{ kind: 'fail', error: 'worker session not ready' }`.
- runViaWorker at line 740-748: `if (attempt === 0) { ... continue }` else `return { text: null, error: 'worker auth failed (401/login) after recovery', authFailed: true }`. On attempt 1, attempt !== 0, so it returns `{ text: null, error: 'worker auth failed (401/login) after recovery', authFailed: true }`.

So the actual `error` string after fix A is `'worker auth failed (401/login) after recovery'`, not `'worker session not ready'`.

The test inversion uses `out.toMatchObject({ text: null })` + `expect(out.error).toBeDefined()` which both PASS regardless of which error string it is. So the test assertion inversion is correct in PRACTICE — but the plan's narrative about the propagation path is inaccurate.

This isn't a fatal flaw (the test will pass), but the plan's reasoning about WHY it passes is partially wrong.

## VERIFIED claims

### V1 — Fix A source-side structure (agent-worker.ts:587-622)

**File**: `src/web/agent-worker.ts:587-622`.

Line 595 reads exactly `startWorkerSessionFor(ctx)` with no try/catch. Confirmed at line 595.

Line 621 reads exactly:
```
try { startWorkerSessionFor(ctx) } catch (err) { logger.warn({ err, session: ctx.session }, 'agent-worker: restart failed') }
```
Confirmed at line 621.

The two patterns are identical modulo the warn log message ('agent-worker: restart failed' vs the plan's proposed 'agent-worker: startWorkerSessionFor failed; treating as not-ready'). Same function name in `logger.warn`, same `{ err, session: ctx.session }` log fields. PASS.

### V2 — Fix B source-side structure (agent-worker.ts:405-422)

**File**: `src/web/agent-worker.ts:405-422`.

Line 407-408 reads exactly the `parsed` declaration as quoted. Confirmed.

Inner `projects` guard at 410-413 is unchanged. Confirmed — the plan explicitly says "unchanged" and the source confirms.

`stampWorkerFirstRun(parsed)` at line 409 mutates parsed in place. Confirmed — function signature at line 438 is `(...): void` and it directly assigns to `parsed.hasCompletedOnboarding` and `parsed.fullscreenUpsellSeenCount`.

### V3 — runViaWorker return type and 'worker session not ready' path

**File**: `src/web/agent-worker.ts:716-720`.

Return type at line 720 reads exactly `Promise<{ text: string | null; error?: string; authFailed?: boolean }>`. Confirmed.

'worker session not ready' fail path at lines 727-738 confirmed. Specifically, line 733-737 reads:
```
if (r.error === 'worker session not ready' && attempt === 0) {
  logger.warn(...)
  restartWorkerSession(ctx)
  continue
}
return { text: null, error: r.error }
```

PASS.

### V4 — Fix A's test inversion shape

**File**: `src/__tests__/agent-worker-full.test.ts:1292-1320`.

Line 1318 reads `await expect(AW.runViaWorker('hi', 100)).rejects.toThrow('tmux gone')`. Confirmed.

Trace through CURRENT code:
1. `AW.runViaWorker('hi', 100)` enters the for loop, attempt=0.
2. `runWorkerAttempt(ctx, 'hi', 100)`:
   - `ensureWorkerReady(ctx)`: `startWorkerSessionFor(ctx)` → execFileSync tmux new-session → n=1, returns '' (success). `isSessionReadyForPrompt` returns true. Returns true.
   - ready=true. Continues.
   - `sendPromptToSession` (mocked to 'sent') returns.
   - Enters while loop. First iteration: `decidePoll({doneExists: false, sessionAlive: false, elapsedMs: 0, timeoutMs: 100})` → 'dead'.
   - BUT before the 'dead' branch, `workerPaneHasAuthFailure(ctx)` is checked at line 683. `capturePane` is mocked to a string containing 'Please run /login' (line 1300-1302), and `WORKER_AUTH_FAILURE_RX` at line 171 matches it. So `workerPaneHasAuthFailure` returns true.
   - runWorkerAttempt returns `{ kind: 'auth' }`.
3. runViaWorker attempt=0, `r.kind === 'auth'`:
   - `seedWorkerCredentials(ctx)` (mocked, no-op).
   - `restartWorkerSession(ctx)`:
     - `execFileSync(tmuxBin, ['kill-session', ...])` → mock returns '' (no 'new-session' in argv).
     - `try { startWorkerSessionFor(ctx) } catch (err) { logger.warn(..., 'agent-worker: restart failed') }` → execFileSync tmux new-session → n=2 → throws 'tmux gone' → caught → logs 'restart failed'.
   - `continue` → attempt=1.
4. runWorkerAttempt (attempt=1):
   - `ensureWorkerReady(ctx)`:
     - `startWorkerSessionFor(ctx)` → execFileSync tmux new-session → n=3 → throws 'tmux gone'.
     - CURRENT code: no try/catch → throw propagates out of `ensureWorkerReady`.
5. The throw propagates out of `runWorkerAttempt` and out of `runViaWorker` (because the for loop's body doesn't catch).
6. `await expect(AW.runViaWorker('hi', 100)).rejects.toThrow('tmux gone')` PASSES.

So the CURRENT test passes. The plan's claim about CURRENT is correct.

Trace through AFTER fix A:
1. Same as above through restartWorkerSession at attempt 0 (no change in the recovery path).
2. attempt=1, runWorkerAttempt → ensureWorkerReady → startWorkerSessionFor throws 'tmux gone' → CAUGHT by new try/catch → logs 'agent-worker: startWorkerSessionFor failed; treating as not-ready' → returns false.
3. runWorkerAttempt: ready=false, workerPaneHasAuthFailure=true → returns `{ kind: 'auth' }`.
4. runViaWorker attempt=1, `r.kind === 'auth'`, attempt !== 0 → `return { text: null, error: 'worker auth failed (401/login) after recovery', authFailed: true }`.

The test inversion:
```
const out = await AW.runViaWorker('hi', 100)
expect(out).toMatchObject({ text: null })  // PASS (out.text === null)
expect(out.error).toBeDefined()  // PASS (out.error defined)
expect(H.logs.some((l) => String(l.msg).includes('restart failed'))).toBe(true)  // PASS (logged at attempt 0 recovery)
```

So the inversion passes. The `n === 1` allow-once + `n > 1` throw mock shape is preserved by fix A (no changes to restartWorkerSession or the mock itself).

PASS.

### V5 — Fix B's `stampWorkerFirstRun` effect on fresh `{}`

**File**: `src/web/agent-worker.ts:438-442`.

On fresh `{}`:
- Line 439: `parsed.hasCompletedOnboarding = true`.
- Line 440: `const seen = Number(parsed.fullscreenUpsellSeenCount)` = `Number(undefined)` = `NaN`.
- Line 441: `Number.isFinite(NaN)` = false → `parsed.fullscreenUpsellSeenCount = 99`.

So `parsed` becomes `{ hasCompletedOnboarding: true, fullscreenUpsellSeenCount: 99 }`. The plan's claim about the values is correct.

PASS — but see R1 for the downstream `dot.projects` issue.

### V6 — Fix B leaves the projects-array test untouched

**File**: `src/__tests__/agent-worker-full.test.ts:644-653`.

The test is LEFT untouched. The plan's edit (edit 4) only touches the test at line 618.

The test asserts `expect(Array.isArray(dot.projects)).toBe(true)`. After fix B, this remains true because the inner `projects` guard at line 410-413 is unchanged. The host file `{ projects: ['bad'] }` is an object (typeof === 'object', !Array.isArray), so fix B's coercion passes it through. `stampWorkerFirstRun` mutates it in place. `parsed.projects = ['bad']` (an array). `projects = parsed.projects && typeof parsed.projects === 'object' → projects = ['bad']`. `for (const k of keys) projects[k] = trusted` — this assigns a property on the array (non-indexed). `parsed.projects = projects`. JSON.stringify on an array serialises only indexed elements, so `dot.projects = ['bad']`. `Array.isArray(dot.projects)` is true. Test still passes.

PASS.

### V7 — INDEX.md rows at `—`

**File**: `docs/needs-to-be-fix/INDEX.md:103, 105`.

Line 103: `agent-worker-array-claude-json` → `—`. Confirmed.
Line 105: `agent-worker-ensure-ready-throw` → `—`. Confirmed.

PASS.

### V8 — Live-install guard requires worktree workflow

**File**: `src/__tests__/setup/assert-not-live-install.ts:26-76`.

LIVE_MARKERS list at line 26-30 includes `store/claudeclaw.db`. Throw at line 71-75 aborts the suite when any marker exists or any file lives under `store/`.

Verified: `/Users/eggp/marveen-develop/test-baseline/store/claudeclaw.db` exists. `gitignore` lists `store/`. Worktree workflow is necessary.

PASS.

### V9 — ensureWorkerReady return-false handling trace

**File**: `src/web/agent-worker.ts:587-610, 649-700`.

ensureWorkerReady callers:
1. `runWorkerAttempt` at line 650 — handles `!ready` at line 651-657. Returns either `{ kind: 'auth' }` (if workerPaneHasAuthFailure) or `{ kind: 'fail', error: 'worker session not ready' }`. Both handled cleanly by `runViaWorker`.
2. `startWorkerSession` at line 509-512 — this is the server-startup pre-start path. Calls `startWorkerSessionFor(ctxSlow)` and `startWorkerSessionFor(ctxFast)` directly. Does NOT call `ensureWorkerReady`. So no propagation concern.

runViaWorker at line 727-738 handles both `{ kind: 'fail' }` shapes:
- `r.error === 'worker session not ready'` + attempt=0: restart + retry.
- Otherwise: return `{ text: null, error: r.error }`.

No callers mishandle `false`.

PASS.

### V10 — Type-check feasibility

The `as Record<string, unknown>` cast on a value TS has narrowed to `typeof === 'object' && !Array.isArray`:
- Legal in TypeScript: yes. `object` to `Record<string, unknown>` is widening, which TS allows.
- Will `bun tsc --noEmit` accept this: yes. The codebase has many existing `as` casts (see CONCERN C1).
- CLAUDE.md §7 forbids `as` outright — see C1 for the rule violation.

The narrowing happens correctly: after `homeClaudeRaw && typeof homeClaudeRaw === 'object' && !Array.isArray(homeClaudeRaw)`, the `as Record<string, unknown>` cast widens to the structurally-larger type. The result is used to populate a `parsed` variable typed as `{ projects?: Record<string, unknown>; hasCompletedOnboarding?: boolean; [k: string]: unknown }`, which is a compatible target.

PASS for compile-time feasibility. FAIL on CLAUDE.md §7 compliance (see C1).

### V11 — Fix A's mock flow ordering

Detailed trace in V4. Summary:
- attempt=0: ensureWorkerReady succeeds (n=1) → runWorkerAttempt's auth check triggers → runViaWorker's auth-recovery retry path → restartWorkerSession's startWorkerSessionFor throws at n=2 (caught, logged) → continue.
- attempt=1: ensureWorkerReady's startWorkerSessionFor throws at n=3 → fix A catches and returns false → runWorkerAttempt returns `{ kind: 'auth' }` → runViaWorker's auth-fail terminal branch returns `{ text: null, error: 'worker auth failed (401/login) after recovery', authFailed: true }`.

The plan correctly identifies that the FIRST new-session (n=1) is from `ensureWorkerReady` in attempt 0, and the SECOND new-session (n=2) is from `restartWorkerSession`'s recovery path, and the THIRD (n=3) is from `ensureWorkerReady` in attempt 1.

Wait — the test comment (lines 1310-1312) says the FIRST new-session is from "the recovery's restartWorkerSession". That comment is factually wrong: n=1 is from ensureWorkerReady (attempt 0), not from the recovery. The recovery only happens if attempt 0 fails with 'worker session not ready', which doesn't happen here because the auth path is taken instead.

But this is a test comment issue, not a plan issue. The plan correctly traces the call order in V4 above.

PASS for the plan's claim.

### V12 — Risk checks

- `try { realpathSync(ctx.home) } catch {}` at line 416: this is inside the same try block at line 405-422. After fix B, parsed starts as `{}` (when raw was an array). The realpathSync call is unaffected. The for loop runs against the `keys` Set. No interaction with the array-coerce change. PASS.

- `parsed.projects = projects` at line 418: works correctly when parsed is the fresh `{}` (the `Record<string, unknown>` from the cast is compatible with the optional `Record<string, unknown>` field). The assignment is well-typed. PASS.

- The `as Record<string, unknown>` cast doesn't accidentally widen the type beyond what downstream needs. The cast widens to `Record<string, unknown>`, which is exactly what the downstream code uses (the `parsed` type annotation is `{ projects?: Record<string, unknown>; ... }`, and `parsed.projects = projects` assigns a `Record<string, unknown>` value to an optional `Record<string, unknown>` field). PASS for type compat.

- `stampWorkerFirstRun`'s `parsed.fullscreenUpsellSeenCount = ...` line mutates through the Record cast correctly. After fix B, parsed is `Record<string, unknown>` (from the cast), then re-assigned to the local `parsed` variable typed as `{ projects?: Record<string, unknown>; hasCompletedOnboarding?: boolean; [k: string]: unknown }`. stampWorkerFirstRun accepts the same type. Mutation works. PASS.

## Summary

- 11 of 12 claims VERIFIED.
- 1 REFUTED claim: fix B's `expect(dot.projects).toEqual({})` is wrong — projects has at least one entry (ctx.home). Test inversion will fail.
- 2 CONCERNs: CLAUDE.md §7 forbids `as`; the plan's narrative about which `error` string flows back from fix A's auth-recovery retry is inaccurate (test inversion still passes, but reasoning is off).

The plan needs ONE fix before execution: replace `expect(dot.projects).toEqual({})` with an assertion that matches the actual post-fix shape (e.g., remove the projects assertion entirely, or assert `expect(dot.projects[ctxSlow.home]).toMatchObject({ hasTrustDialogAccepted: true })`).

The `as` use is a soft concern — codebase convention allows it, but the strict project rule doesn't. Acceptable in practice; flag if the user wants strict compliance.