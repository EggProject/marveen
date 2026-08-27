# hook-command-quoting.test.ts: 6 pre-existing assertion drift (NOT blanket-driven)

## Location

`src/__tests__/hook-command-quoting.test.ts`, lines 73, 89, 105, 127 + 2 more (the quoting + migration describe blocks).

## Failure scenario

These six tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). After the 16 per-file opt-in commits of 2026-08-27 closed the blanket-driven 74 fails, these 6 remain as the only `hook-command-quoting` failures.

None of the 6 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`. The test uses `hookCommand`, `hookCommandWired`, `ensureEgressGate`, `ensureGovernanceGateCommands` — none of these call `node:child_process`. The failures are pure in-memory assertion mismatches.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/hook-command-quoting.test.ts
 Test Files  1 failed (1)
      Tests  6 failed | 3 passed (9)
```

6 fails pre-existed on `a330462` (pre-forbid).

## Attempted fix

No source edit attempted. The drift is in the test assertion expectations (the expected hook-command string shape) vs the current implementation of `hookCommand` / `ensureEgressGate` / `ensureGovernanceGateCommands` in `src/web/agent-scaffold.ts`.

## Phase-1 re-measurement (2026-08-28)

Re-measured at HEAD `f48ef7d` in two non-`/tmp/` locations and one
`/tmp/` worktree:

| Setup | Result |
| --- | --- |
| `/Users/eggp/marveen-develop/test-baseline` (main checkout, `PROJECT_ROOT` not under `/tmp/`) | 9 passed, 0 failed |
| `/Users/eggp/claw-test-58-notmp` (worktree under `/Users/eggp/`, not under `/tmp/`) | 9 passed, 0 failed |
| `/private/tmp/claw-test-58-baseline` (worktree under `/tmp/`) at `4ed3519` baseline | 6 failed, 3 passed (matches the 6 fails cited below) |

Root cause of the 6 fails in the `/tmp/` worktree:
`src/web/agent-scaffold.ts:144` `isUnsafeHookCommand` checks
`_TMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']`
(`src/web/agent-scaffold.ts:129`). When the test runs in a worktree
under `/tmp/`, `PROJECT_ROOT = join(__dirname, '..')`
(`src/config.ts:10-12`) resolves to that worktree path, so
`hookCommand(join(PROJECT_ROOT, 'scripts', '<gate>.mjs'))` produces a
command containing `/private/tmp/...`, which `isUnsafeHookCommand`
correctly refuses to register (per its stated purpose: "volatile
tmpfs prefixes", see `agent-scaffold.ts:134-141`). All five entry
points covered by this test file (`injectEmailSendGate`,
`injectSelfPaceGate`, `injectEgressGate`, `ensureEgressGate`,
`ensureGovernanceGateCommands`) hit the same `_TMP_PREFIXES` gate,
so all 6 fails trace to the same root cause.

The original empirical evidence (6 fail at
`/tmp/claw-test-baseline-a330462`) was correct ONLY for that worktree
location. In a standard non-`/tmp/` checkout the bug does not exist.
The MD's premise ("pure in-memory assertion mismatches; none of these
call `node:child_process`") is correct for the non-`/tmp/` case; the
`isUnsafeHookCommand` registration guard is the gate that blocks the
write when `PROJECT_ROOT` itself is under `/tmp/`. The original "no
source edit attempted" stance stands: there is no production bug to
fix. The test/implementation coupling is sound; only the
`/tmp/`-prefixed test-runner location triggers the rejection.

## Pinning test

The 6 failures are in three describe blocks:
- `injectors write a quoted absolute interpreter, never a bare node` (lines 73, 89, 105) — three `inject*Gate` tests asserting the interpreter path is absolute
- `hookCommandWired finds a freshly injected command (posix path)` (line 127) — `hookCommandWired` assertion
- `ensure* migrations are idempotent (true, then false)` — `ensureEgressGate` and `ensureGovernanceGateCommands` migration tests

## Suggested direction

Read `src/web/agent-scaffold.ts:hookCommand` and `ensureEgressGate` / `ensureGovernanceGateCommands`. Update the test expectations at lines 60-130 to match the current implementation's emitted hook-command string shape, OR fix the implementation.

## Resolution

Closed by re-measurement (cycle 58, 2026-08-28). The 6 fails cited in
this MD were a `/tmp/` worktree artifact, not pre-existing drift in
the production code or the test expectations. In a standard
non-`/tmp/` checkout the test passes cleanly (9 passed, 0 failed at
HEAD `f48ef7d` in both the main checkout and a non-`/tmp/` worktree).
See `## Phase-1 re-measurement (2026-08-28)` above for the empirical
table and the `isUnsafeHookCommand` registration-guard root cause.

## Scope

Pre-existing on `a330462` baseline when measured in `/tmp/` worktrees;
absent on the same baseline when measured in non-`/tmp/` checkouts.
NOT introduced by `53a9f6c`. Original filing as a separate needs-fix
item stands; the re-measurement closes it without a source edit.
