# hook-path-guard.test.ts: 7 pre-existing drift (mock works, tests diverge)

## Location

`src/__tests__/hook-path-guard.test.ts`, lines 56, 61 (a-block), 130, 175 (c-block), 243, 280, 317 (e-block).

## Failure scenario

These seven tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). The `2a28a54` commit (which added `vi.importActual<typeof import('node:child_process')>('node:child_process')` at line 33-35) was claimed to fix 6 of these, but empirical re-measurement on `4ed3519` shows all 7 still fail. The BETA verifier on the 2026-08-27 cycle found that NONE of the 7 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`, meaning the vi.importActual mock IS effective and the failures are not blanket-driven.

## Three distinct root causes

### Block (a) at lines 56:62, 61:38 — `isUnsafeHookCommand` path resolution

The tests use `existsSync(STALENESS_HOOK)` where `STALENESS_HOOK` is resolved via `fileURLToPath(import.meta.url)` (test file line 13-14). Under vitest's module loader, the resolved path differs from the test author's expectation at write-time, so `existsSync` returns false and the assertion fails.

### Block (c) at lines 130:76, 175:49 — `boot-hook-prune.py` python3 invocation

The tests use `execFileSync('python3', [STALENESS_HOOK])` to run real `scripts/boot-hook-prune.py`. Real `python3` is required on the test host's PATH, AND the script's output must match the assertion. Either `python3` is missing or the fixture script's output diverged from the test expectation.

### Block (e) at lines 243:21, 280:21, 317:73 — `upgradeLegacyHookCommands` mutations

These are pure in-memory `upgradeLegacyHookCommands` calls + `isUnsafeHookCommand` checks. No subprocess. The implementation's behaviour diverged from the test expectations.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/hook-path-guard.test.ts
 Test Files  1 failed (1)
      Tests  7 failed | 11 passed (18)
```

7 fails pre-existed on `a330462` (pre-forbid).

```
$ git -C /tmp/claw-test-baseline bun --bun vitest run src/__tests__/hook-path-guard.test.ts
 Test Files  1 failed (1)
      Tests  7 failed | 11 passed (18)
```

7 fails STILL present at HEAD after the 16 per-file opt-in commits (the mock is in place but does not affect these failures).

## Phase-1 re-measurement (2026-08-28)

Re-measured at HEAD `f48ef7d` in two non-`/tmp/` locations and one
`/tmp/` worktree:

| Setup | Result |
| --- | --- |
| `/Users/eggp/marveen-develop/test-baseline` (main checkout, `PROJECT_ROOT` not under `/tmp/`) | 18 passed, 0 failed |
| `/Users/eggp/claw-test-58-notmp` (worktree under `/Users/eggp/`, not under `/tmp/`) | 18 passed, 0 failed |
| `/private/tmp/claw-test-58-baseline` (worktree under `/tmp/`) at `4ed3519` baseline | 7 failed, 11 passed (matches the 7 fails cited below) |

Root cause of all 7 fails in the `/tmp/` worktree:
`src/web/agent-scaffold.ts:144` `isUnsafeHookCommand` checks
`_TMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']`
(`src/web/agent-scaffold.ts:129`). When the test runs in a worktree
under `/tmp/`, `PROJECT_ROOT = join(__dirname, '..')`
(`src/config.ts:10-12`) resolves to that worktree path, so
`hookCommand(join(PROJECT_ROOT, 'scripts', '<gate>.mjs'))` and
`hookCommand(join(PROJECT_ROOT, 'scripts', 'boot-hook-prune.py'))`
both produce commands containing `/private/tmp/...`, which
`isUnsafeHookCommand` correctly refuses to register (per its stated
purpose: "volatile tmpfs prefixes", see `agent-scaffold.ts:134-141`).

This explains why all three blocks (a: lines 56, 61 --
`isUnsafeHookCommand` registration guard; c: lines 130, 175 --
`boot-hook-prune.py` invocation that depends on a registered hook;
e: lines 243, 280, 317 -- `upgradeLegacyHookCommands` mutations that
consult `isUnsafeHookCommand`) fail uniformly in the `/tmp/` worktree:
each one depends on a registered hook command whose path includes
`/private/tmp/`. The three-block "three distinct root causes" claim
in the original MD was based on the assumption that the failures were
not blanket-driven, which is true at the `forbid-system-calls.ts:67:5`
stack-frame level but not at the `isUnsafeHookCommand`
registration-guard level. The guard fires before any test body runs,
so the per-block analysis loses resolution.

The MD's claim "the `2a28a54` commit's '6 tests went from fail to
pass' is not reproducible" is correct as written: in a `/tmp/`
worktree the `vi.importActual` mock is in place but the registration
guard still fires before the test body, so the 6-test fix does not
survive the worktree location. In a non-`/tmp/` worktree (this cycle
58 measurement) the 6 tests pass without further change, which is the
intended outcome of `2a28a54` when run from a non-`/tmp/` checkout.

The original empirical evidence (7 fail at
`/tmp/claw-test-baseline-a330462`) was correct ONLY for that worktree
location. In a standard non-`/tmp/` checkout the bug does not exist.
The original "no source edit attempted" stance stands: there is no
production bug to fix.

## Pinning test

`src/__tests__/hook-path-guard.test.ts`, describe blocks `isUnsafeHookCommand (registration guard)` (a), `boot-hook-prune.py` (c), `upgradeLegacyHookCommands (automatic migration)` (e).

## Suggested direction

Block (a): fix `STALENESS_HOOK` path resolution to be vitest-loader-agnostic (e.g., use `path.resolve(__dirname, ...)` instead of `fileURLToPath(import.meta.url)`).
Block (c): verify `python3` is available on the test host's PATH, AND verify the boot-hook-prune.py output matches the assertion (run it manually and compare).
Block (e): read `src/web/agent-scaffold.ts:upgradeLegacyHookCommands` and the test expectations; update one to match the other.

## Resolution

Closed by re-measurement (cycle 58, 2026-08-28). The 7 fails cited in
this MD were a `/tmp/` worktree artifact, not pre-existing drift in
the production code or the test expectations. In a standard
non-`/tmp/` checkout the test passes cleanly (18 passed, 0 failed at
HEAD `f48ef7d` in both the main checkout and a non-`/tmp/` worktree).
See `## Phase-1 re-measurement (2026-08-28)` above for the empirical
table and the `isUnsafeHookCommand` registration-guard root cause.

## Scope

Pre-existing on `a330462` baseline when measured in `/tmp/` worktrees;
absent on the same baseline when measured in non-`/tmp/` checkouts.
NOT introduced by `53a9f6c`. The `vi.importActual` mock at
`src/__tests__/hook-path-guard.test.ts:33-35` is effective; it is the
`isUnsafeHookCommand` registration guard (not the
`forbid-system-calls` blanket) that produces the 7 fails in the
`/tmp/` worktree. Original filing as a separate needs-fix item
stands; the re-measurement closes it without a source edit.
