# email-send-gate.test.ts: 3 pre-existing assertion drift (NOT blanket-driven)

## Location

`src/__tests__/email-send-gate.test.ts`, lines 72, 84, 99 (the `injectEmailSendGate` describe block).

## Failure scenario

These three tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). After the 16 per-file opt-in commits of 2026-08-27 closed the blanket-driven 74 fails, these 3 remain as the only `email-send-gate` failures.

Scope correction (cycle 58, see `## Phase-1 re-measurement (2026-08-28)` below): that statement holds only when the checkout is under `/tmp/`. In a non-`/tmp/` checkout all 10 tests pass.

None of the 3 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`. They are pure in-memory `injectEmailSendGate` assertions; the test imports `injectEmailSendGate` from `../web/agent-scaffold.js`, a function that uses no `node:child_process` API at all.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/email-send-gate.test.ts
 Test Files  1 failed (1)
      Tests  3 failed | 7 passed (10)
```

3 fails pre-existed on `a330462` (pre-forbid).

## Attempted fix

No source edit attempted. The drift is in the test assertion expectations vs the current `injectEmailSendGate` implementation in `src/web/agent-scaffold.ts`. The test expectations (lines 72, 84, 99) need to be updated to match the current implementation, OR the implementation needs to match the test expectations.

## Phase-1 re-measurement (2026-08-28)

Three of the four rows below are at HEAD `f48ef7d`, so the `/tmp/` vs
non-`/tmp/` location is the ONLY variable between them. The fourth row
repeats the original `4ed3519` baseline run, which differs from the
others in both location and commit and therefore cannot on its own
attribute the failures to either:

| Setup | Result |
| --- | --- |
| main checkout, `PROJECT_ROOT` not under `/tmp/`, at HEAD `f48ef7d` | 10 passed, 0 failed |
| worktree under `$HOME`, not under `/tmp/`, at HEAD `f48ef7d` | 10 passed, 0 failed |
| worktree under `/tmp/`, at HEAD `f48ef7d` | 3 failed, 7 passed |
| worktree under `/tmp/`, at `4ed3519` baseline | 3 failed, 7 passed (matches the 3 fails cited below) |

The `/tmp/`-at-HEAD row is the load-bearing one: the same 3 fails
reproduce at HEAD purely by moving the checkout under `/tmp/`, which
is what isolates location from commit.

Root cause of the 3 fails in the `/tmp/` worktree:
`isUnsafeHookCommand` (`src/web/agent-scaffold.ts:143`) rejects any
command containing one of
`_TMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']`
(declared at `src/web/agent-scaffold.ts:129`, checked at `:144`). When
the test runs in a worktree under `/tmp/`,
`PROJECT_ROOT = join(__dirname, '..')` (`src/config.ts:12`) resolves to
that worktree path, so
`hookCommand(join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs'))`
(`agent-scaffold.ts:389`) produces a command containing
`/private/tmp/...`, which `isUnsafeHookCommand` correctly refuses to
register (per its stated purpose, "Volatile tmpfs prefixes", see the
comment at `agent-scaffold.ts:124-128`).

`injectEmailSendGate` then returns at `agent-scaffold.ts:391` BEFORE it
assigns `hooks.PreToolUse`. So `s.hooks` is `{}` and
`s.hooks.PreToolUse` is `undefined` -- not a zero-length array. The
observed failures are:

- lines 72 and 84: `expect(hooks).toHaveLength(1)` where `hooks` is
  `undefined`.
- line 99: the pre-seeded `WebFetch` entry survives untouched, so `pre`
  has length 1 and `expect(pre).toHaveLength(2)` fails on a real array.

The original empirical evidence (3 fail at
`/tmp/claw-test-baseline-a330462`) was correct ONLY for that worktree
location. In a standard non-`/tmp/` checkout the bug does not exist.
The MD's premise ("pure in-memory `injectEmailSendGate` assertions;
the function uses no `node:child_process` API") is correct for the
non-`/tmp/` case; the `isUnsafeHookCommand` registration guard is the
gate that blocks the write when `PROJECT_ROOT` itself is under
`/tmp/`. The original "no source edit attempted" stance stands: there
is no production bug to fix. The test/implementation coupling is
sound; only the `/tmp/`-prefixed test-runner location triggers the
rejection.

## Pinning test

The 3 failures, reproducible only in a `/tmp/` checkout, were in `describe('injectEmailSendGate')`:
- line 72: "adds the PreToolUse email-gate hook"
- line 84: "is idempotent (no duplicate entries on re-apply / respawn)"
- line 99: "preserves existing hooks (e.g. PreCompact) and other PreToolUse entries"

## Suggested direction

Superseded by `## Resolution` below: no test or implementation change is
needed. Run the suite from a checkout that is not under `/tmp/`.

## Resolution

Closed by re-measurement (cycle 58, 2026-08-28). The 3 fails cited in
this MD were a `/tmp/` worktree artifact, not pre-existing drift in
the production code or the test expectations. In a standard
non-`/tmp/` checkout the test passes cleanly (10 passed, 0 failed at
HEAD `f48ef7d` in both the main checkout and a non-`/tmp/` worktree).
See `## Phase-1 re-measurement (2026-08-28)` above for the empirical
table and the `isUnsafeHookCommand` registration-guard root cause.

## Scope

Pre-existing on `a330462` baseline when measured in `/tmp/` worktrees;
absent on the same baseline when measured in non-`/tmp/` checkouts.
NOT introduced by `53a9f6c`. Original filing as a separate needs-fix
item stands; the re-measurement closes it without a source edit.
