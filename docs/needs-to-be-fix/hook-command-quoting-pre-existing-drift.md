# hook-command-quoting.test.ts: 6 pre-existing assertion drift (NOT blanket-driven)

## Location

`src/__tests__/hook-command-quoting.test.ts`, lines 73, 89, 105, 127 + 2 more (the quoting + migration describe blocks).

## Failure scenario

These six tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). After the 16 per-file opt-in commits of 2026-08-27 closed the blanket-driven 74 fails, these 6 remain as the only `hook-command-quoting` failures.

Scope correction (cycle 58, see `## Phase-1 re-measurement (2026-08-28)` below): that statement holds only when the checkout is under `/tmp/`. In a non-`/tmp/` checkout all 9 tests pass.

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

Three of the four rows below are at HEAD `f48ef7d`, so the `/tmp/` vs
non-`/tmp/` location is the ONLY variable between them. The fourth row
repeats the original `4ed3519` baseline run, which differs from the
others in both location and commit and therefore cannot on its own
attribute the failures to either:

| Setup | Result |
| --- | --- |
| main checkout, `PROJECT_ROOT` not under `/tmp/`, at HEAD `f48ef7d` | 9 passed, 0 failed |
| worktree under `$HOME`, not under `/tmp/`, at HEAD `f48ef7d` | 9 passed, 0 failed |
| worktree under `/tmp/`, at HEAD `f48ef7d` | 6 failed, 3 passed |
| worktree under `/tmp/`, at `4ed3519` baseline | 6 failed, 3 passed (matches the 6 fails cited below) |

The `/tmp/`-at-HEAD row is the load-bearing one: the same 6 fails
reproduce at HEAD purely by moving the checkout under `/tmp/`, which
is what isolates location from commit.

Root cause of the 6 fails in the `/tmp/` worktree:
`isUnsafeHookCommand` (`src/web/agent-scaffold.ts:143`) rejects any
command containing one of
`_TMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']`
(declared at `src/web/agent-scaffold.ts:129`, checked at `:144`). This
test file imports `PROJECT_ROOT` directly (test file line 14), and
`PROJECT_ROOT = join(__dirname, '..')` (`src/config.ts:12`) resolves to
the worktree path, so `hookCommand(join(PROJECT_ROOT, 'scripts', ...))`
produces a command containing `/private/tmp/...`, which
`isUnsafeHookCommand` correctly refuses to register (per its stated
purpose, "Volatile tmpfs prefixes", see the comment at
`agent-scaffold.ts:124-128`).

Every code path this file exercises builds its command from
`PROJECT_ROOT`, so all 6 fails share that root cause -- but the
failure MODES differ per block, and none of them is a `toHaveLength`
mismatch:

- line 73 (the `inject*Gate` loop): the injector returns before
  assigning `hooks.PreToolUse`, so `ptuCommands(s)` operates on
  `undefined`.
- line 89 (`hookCommandWired`): `injectEgressGate(s)` is rejected the
  same way, so the serialized `PreToolUse` never contains the command
  and the lookup returns `false`.
- line 105: `ensureEgressGate` returns `false` at
  `agent-scaffold.ts:485` (its own `isUnsafeHookCommand` early exit),
  so the first `expect(...).toBe(true)` fails.
- line 127: `ensureGovernanceGateCommands` never inspects the return of
  the injectors it calls, so it rewrites the file unchanged and returns
  `true` on BOTH invocations; the second `expect(...).toBe(false)`
  fails.

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

The 6 failures, reproducible only in a `/tmp/` checkout, were spread over three describe blocks:
- `injectors write a quoted absolute interpreter, never a bare node` (line 73, reported 3x -- the block is a `for` loop that generates one test each for `injectEmailSendGate`, `injectSelfPaceGate` and `injectEgressGate`, all sharing the same assertion line)
- `hookCommandWired` (line 89) -- the "finds a freshly injected command (posix path)" case; the second test in that block uses a hardcoded Windows path and is unaffected
- `ensure* migrations are idempotent (true, then false)` (lines 105 and 127) -- `ensureEgressGate` and `ensureGovernanceGateCommands`

## Suggested direction

Superseded by `## Resolution` below: no test or implementation change is
needed. Run the suite from a checkout that is not under `/tmp/`.

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
