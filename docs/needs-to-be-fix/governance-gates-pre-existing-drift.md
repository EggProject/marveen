# governance-gates.test.ts: 3 pre-existing assertion drift (NOT blanket-driven)

## Location

`src/__tests__/governance-gates.test.ts`, lines 283, 293, 305 (the `governance gate scaffold wiring > injectSelfPaceGate` describe block).

## Failure scenario

These three tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). After the 16 per-file opt-in commits of 2026-08-27 closed the blanket-driven 74 fails, these 3 remain as the only `governance-gates` failures.

None of the 3 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`. They are pure in-memory `injectSelfPaceGate` assertions; the test imports `injectSelfPaceGate` from `../web/agent-scaffold.js`, a function that uses no `node:child_process` API.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/governance-gates.test.ts
 Test Files  1 failed (1)
      Tests  3 failed | 65 passed (68)
```

3 fails pre-existed on `a330462` (pre-forbid).

## Attempted fix

No source edit attempted. The drift is in the test assertion expectations vs the current `injectSelfPaceGate` implementation in `src/web/agent-scaffold.ts`.

## Phase-1 re-measurement (2026-08-28)

Re-measured at HEAD `f48ef7d` in two non-`/tmp/` locations and one
`/tmp/` worktree:

| Setup | Result |
| --- | --- |
| `/Users/eggp/marveen-develop/test-baseline` (main checkout, `PROJECT_ROOT` not under `/tmp/`) | 68 passed, 0 failed |
| `/Users/eggp/claw-test-58-notmp` (worktree under `/Users/eggp/`, not under `/tmp/`) | 68 passed, 0 failed |
| `/private/tmp/claw-test-58-baseline` (worktree under `/tmp/`) at `4ed3519` baseline | 3 failed, 65 passed (matches the 3 fails cited below) |

Root cause of the 3 fails in the `/tmp/` worktree:
`src/web/agent-scaffold.ts:144` `isUnsafeHookCommand` checks
`_TMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']`
(`src/web/agent-scaffold.ts:129`). When the test runs in a worktree
under `/tmp/`, `PROJECT_ROOT = join(__dirname, '..')`
(`src/config.ts:10-12`) resolves to that worktree path, so
`hookCommand(join(PROJECT_ROOT, 'scripts', 'self-pace-gate.mjs'))`
produces a command containing `/private/tmp/...`, which
`isUnsafeHookCommand` correctly refuses to register (per its stated
purpose: "volatile tmpfs prefixes", see `agent-scaffold.ts:134-141`).
The `injectSelfPaceGate` function then returns without adding the
entry, so `hooks.PreToolUse.length` is 0 (or contains only the
original WebFetch entry), and the test's `toHaveLength(1)` /
`toHaveLength(2)` assertion fails.

The original empirical evidence (3 fail at
`/tmp/claw-test-baseline-a330462`) was correct ONLY for that worktree
location. In a standard non-`/tmp/` checkout the bug does not exist.
The MD's premise ("pure in-memory `injectSelfPaceGate` assertions; the
function uses no `node:child_process` API") is correct for the
non-`/tmp/` case; the `isUnsafeHookCommand` registration guard is the
gate that blocks the write when `PROJECT_ROOT` itself is under
`/tmp/`. The original "no source edit attempted" stance stands: there
is no production bug to fix. The test/implementation coupling is
sound; only the `/tmp/`-prefixed test-runner location triggers the
rejection.

## Pinning test

The 3 failures in `describe('governance gate scaffold wiring') > injectSelfPaceGate`:
- line 283: "is idempotent (no duplicate on respawn)"
- line 293: "the hook MATCHER fires on native file tools too (not just Bash)"
- line 305: "survives a respawn re-run, and NO operator-gate is wired"

## Suggested direction

Read `src/web/agent-scaffold.ts:injectSelfPaceGate` and the test expectations at lines 280-310. Update the test expectations to match the current implementation, OR fix the implementation to match the test expectations.

## Resolution

Closed by re-measurement (cycle 58, 2026-08-28). The 3 fails cited in
this MD were a `/tmp/` worktree artifact, not pre-existing drift in
the production code or the test expectations. In a standard
non-`/tmp/` checkout the test passes cleanly (68 passed, 0 failed at
HEAD `f48ef7d` in both the main checkout and a non-`/tmp/` worktree).
See `## Phase-1 re-measurement (2026-08-28)` above for the empirical
table and the `isUnsafeHookCommand` registration-guard root cause.

## Scope

Pre-existing on `a330462` baseline when measured in `/tmp/` worktrees;
absent on the same baseline when measured in non-`/tmp/` checkouts.
NOT introduced by `53a9f6c`. Original filing as a separate needs-fix
item stands; the re-measurement closes it without a source edit.
