# Plan: USE `PidfileLockContext.log.error` at the no-observability throw

## Context

User pushback on the prior plan ("miert torlod a log error-t? miert nem hasznaljuk sehol?") revealed the correct intent: the `log.error` forwarder at `src/index.ts:285` was not dead code waiting to be deleted -- it was an unused seam waiting to be wired. A targeted audit of `acquirePidfileLock` (process-lock.ts:289-363) found **exactly one place where `ctx.log.error` should be called but is currently absent**: the final `throw` at line 362 (`Failed to acquire pidfile lock at ${path} after ${maxAttempts} attempts`). This throw happens after the retry loop is exhausted. Today it bubbles up uncaught with **zero observability** -- operators see only the uncaught exception, no record of which path, which PID, or how many attempts.

The fix is to ADD a `ctx.log.error` call immediately before the throw. The forwarder, the type contract, and the existing synthetic pinning test all stay as-is. The only changes are: one line added in `src/process-lock.ts`, one assertion added to the existing test that already triggers this code path, and the MD marked Resolved.

This is strictly smaller than the prior plan (which would have deleted 14 lines and weakened a type contract): one source line added, one test assertion added, zero lines deleted.

## Approach (single commit)

### Change 1: `src/process-lock.ts` line 362

Add `ctx.log.error(...)` immediately before the throw. Cite the variables already in scope at that point (`path`, `maxAttempts`, `selfPid`).

OLD (line 360-363):
```ts
    if (attempts >= maxAttempts) {
      throw new Error(`Failed to acquire pidfile lock at ${path} after ${maxAttempts} attempts`)
    }
```

NEW (line 360-364):
```ts
    if (attempts >= maxAttempts) {
      ctx.log.error({ path, maxAttempts, selfPid }, 'Failed to acquire pidfile lock after maxAttempts')
      throw new Error(`Failed to acquire pidfile lock at ${path} after ${maxAttempts} attempts`)
    }
```

No other production change to `acquirePidfileLock`. The forwarder at `index.ts:285` is now exercised by this call. The `error: LogFn` type at `process-lock.ts:253` stays required (no loosening needed).

### Change 2: `src/__tests__/process-lock.test.ts` line 592 (existing test)

The existing test already triggers the throw path (it asserts `.rejects.toThrow(/Failed to acquire pidfile lock/)`). After Change 1, that test now also triggers the `ctx.log.error` call. Add an `expect(ctx.log.error).toHaveBeenCalledWith({ path, maxAttempts, selfPid }, 'Failed to acquire pidfile lock after maxAttempts')` assertion to the same `it(...)` block. The test must construct a `PidfileLockContext` whose `log.error` is a `vi.fn()` (or use the same mock object that the test already passes into `acquirePidfileLock`).

The exact shape of the assertion depends on how the test currently mocks `ctx.log`. Plan agent must verify by reading the test and propose the precise diff (do not assume).

### Change 3 (docs): `docs/needs-to-be-fix/index-283-test-pins-error-wiring.md`

Mark Resolved. Cite:
- The commit SHA (from the cherry-pick back to test/baseline)
- The actual usage: `ctx.log.error` now called at `process-lock.ts:362`
- The synthetic pinning test at `index.test.ts:1382-1394` stays as a forwarder-contract test (the test still validates that any `ctx.log.error` call is forwarded to `logger.error`, but it is no longer the ONLY exerciser of the forwarder)

### Change 4 (docs): `docs/needs-to-be-fix/INDEX.md`

Update the row for `index-283-test-pins-error-wiring`: Resolved column gets the commit SHA.

### Commit shape

Single commit. The 4 changes are one logical unit. Suggested message:

```
fix(process-lock): log error before throwing on pidfile acquisition failure
```

Body should cite:
- `acquirePidfileLock` had 6 log calls, all info/warn, plus a final unobserved throw
- The throw at line 362 now has a `ctx.log.error` call immediately before it
- The forwarder at `index.ts:285` is no longer dead code
- The synthetic pinning test at `index.test.ts:1382-1394` stays (still validates the forwarder contract for any `ctx.log.error` call)
- The existing test at `process-lock.test.ts:592` is extended with one assertion (no new test file, no new `it` block)

## Critical files

- `src/process-lock.ts` (line 362 area)
- `src/__tests__/process-lock.test.ts` (line 592 area)
- `docs/needs-to-be-fix/index-283-test-pins-error-wiring.md` (status)
- `docs/needs-to-be-fix/INDEX.md` (row)

## Out of scope (separately considered, NOT included)

The Explore agent identified two additional candidate improvements that are deliberately NOT included in this batch:

- **`process-lock.ts:352` SIGTERM-to-predecessor-failed `warn` -> `error` escalation.** Defensible to leave as `warn`: the retry mechanism plus the line-362 throw are the real escalation, and individual SIGTERM denials are recoverable within the retry loop. Changing it would require updating the existing test at `process-lock.test.ts:709` that explicitly pins the `warn` level. A separate "escalate-warning-levels" cycle can address this if the user wants.

- **`process-lock.ts:321-326` swallowed `probeAlive` catch.** Currently `catch { alive = true }` with no log. A `ctx.log.warn({ recorded, err }, 'probeAlive threw, assuming alive')` would document real system-level probe failures (EPERM etc.) that today leave no trace. Non-breaking (no test pins). A separate "observability-of-swallowed-errors" cycle can address this if the user wants.

Both candidates can be added later as separate cycles. Keeping this batch to ONE focused change (line 362) preserves the "smallest modification" intent.

## Workflow execution

All work on `test/baseline` branch.

Phases:

1. **Worktree setup + edit** -- create `/tmp/claw-test-fix` from `test/baseline`, apply Changes 1-4, link node_modules from main checkout.
2. **Self-verify** -- run `bun test src/__tests__/process-lock.test.ts` in worktree. Expect the existing 60/60 (or whatever the baseline is) to remain green; the extended test now also asserts the new `ctx.log.error` call.
3. **Double-verify (2 parallel Agent tool subagents, isolation: worktree)**:
   - Agent A (correctness lens): independently re-grep for any `acquirePidfileLock` callsite that would now also need a new `ctx.log.error` (e.g. another throw). Run `bun run tsc --noEmit`. Confirm the 4 changes match the expected diff.
   - Agent B (regression lens): run the full vitest suite (`bun --bun vitest run`) in the worktree. Confirm no other test relies on line 362 NOT logging. Check coverage on `src/process-lock.ts` and `src/index.ts` to confirm line 362 is now covered (and the forwarder at index.ts:285 is covered by a REAL call, not just the synthetic test).
4. **Commit + cherry-pick** -- commit in worktree, cherry-pick to `test/baseline`.
5. **Code-review** -- user invokes `/code-review max --fix <SHA>..HEAD` manually (skill has `disable-model-invocation`; cannot be invoked from Skill tool per Honcho memory).
6. **Apply review findings** -- if any, commit them as a separate commit (no amend, no commit deletion per Honcho memory).

## Verification

### Pre-edit baseline (run in `/tmp/claw-test-fix` BEFORE Changes 1-4)

- `bun test src/__tests__/process-lock.test.ts 2>&1 | tail -5` -- record pass count P1
- `bun test src/__tests__/index.test.ts 2>&1 | tail -5` -- record pass count I1
- `bun run tsc --noEmit 2>&1 | tail -5` -- record typecheck error count T1
- `ls store/` -- must be empty (else `assert-not-live-install.ts` blocks the suite)

### Post-edit expected (run AFTER Changes 1-4 in same worktree)

- `bun test src/__tests__/process-lock.test.ts` -- expect P1 (same count; the extended test still passes, no new test)
- `bun test src/__tests__/index.test.ts` -- expect I1 (the synthetic pinning test at 1382-1394 still passes; the forwarder is unchanged)
- `bun run tsc --noEmit` -- expect T1 (unchanged)
- `bun --bun vitest run` -- full suite remains green
- `coverage/coverage-summary.json` re-check: `src/index.ts:285` is now covered by a REAL call (line 362) on top of the synthetic test, so the line is doubly covered. `src/process-lock.ts:362` (the new `ctx.log.error` line) is covered by the extended existing test.

### Code-review pass

User runs `/code-review max --fix <commit-SHA>..HEAD` manually. Possible findings:
- The log message string is duplicated (also appears in the `throw` Error message). Reviewer may flag this -- acceptable, since the log is structured (`{ path, maxAttempts, selfPid }`) and the Error string is for callers.
- The `{ path, maxAttempts, selfPid }` object includes `selfPid` which may not be in scope at line 362 (depends on exact code structure). Plan agent must verify scope; if `selfPid` is not in scope, the object must be reconstructed from `selfPid` parameter at the top of the function.
- Test at `process-lock.test.ts:592` may have a specific mock shape that requires careful assertion syntax. Plan agent must propose the exact diff.

## Out of scope this cycle (unchanged from prior plan)

- `message-router-cache-fallback-unreachable` -- blocked
- `keychain-store-insecure-acl` -- blocked
- `test-suite-store-pollution-store-dir-frozen` -- L blast radius
- `channel-coordinator-internals-untestable` -- L blast radius
- `web-agent-scaffold-defensive-coverage` -- multi-shape refactor
- `web-agent-worker-runviaworker-coverage` -- clock+fs injection
- `web-inbound-probe-respawn-grace` -- mock-resolution config
- `routes-agents-br-baseline-partial-coverage` -- 67 branches
- `channel-request-watcher-unreachable-provider-check` -- MD warns DO NOT RAW-DELETE
- `process-lock.ts:352` warn-to-error escalation -- separate cycle
- `process-lock.ts:321-326` swallowed-catch observability -- separate cycle
- 2 message-router MD "Partially resolved" footers -- docs-only, separate cycle
- `src/__tests__/message-router-full.test.ts:1191` rename -- needs separate investigation
- "19 hook/security test failures" -- confirmed NOT failing in current state
