# hook-path-guard.test.ts: 7 pre-existing drift (mock works, tests diverge)

## Location

`src/__tests__/hook-path-guard.test.ts`, lines 56, 61 (a-block), 130, 175 (c-block), 243, 280, 317 (e-block).

## Failure scenario

These seven tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). The `2a28a54` commit (which added `vi.importActual<typeof import('node:child_process')>('node:child_process')` at line 33-35) was claimed to fix 6 of these, but empirical re-measurement on `4ed3519` shows all 7 still fail. The BETA verifier on the 2026-08-27 cycle found that NONE of the 7 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`, meaning the vi.importActual mock IS effective and the failures are not blanket-driven.

Scope correction (cycle 58, see `## Phase-1 re-measurement (2026-08-28)` below): every measurement quoted in this section was taken in a `/tmp/` worktree. In a non-`/tmp/` checkout all 18 tests pass, and the `2a28a54` fix does hold.

## Three distinct root causes (superseded, kept as the original hypothesis)

The three hypotheses below were written before the cycle-58
re-measurement and are retained only as history. Blocks (a) and (e) are
correctly located but misdiagnosed, and block (c) is wrong outright.
The verified analysis is in `## Phase-1 re-measurement (2026-08-28)`.

### Block (a) at lines 56:62, 61:38 -- `isUnsafeHookCommand` path resolution

The tests use `existsSync(STALENESS_HOOK)` where `STALENESS_HOOK` is resolved via `fileURLToPath(import.meta.url)` (test file line 13-14). Under vitest's module loader, the resolved path differs from the test author's expectation at write-time, so `existsSync` returns false and the assertion fails.

### Block (c) at lines 130:76, 175:49 -- `boot-hook-prune.py` python3 invocation

The tests use `execFileSync('python3', [STALENESS_HOOK])` to run real `scripts/boot-hook-prune.py`. Real `python3` is required on the test host's PATH, AND the script's output must match the assertion. Either `python3` is missing or the fixture script's output diverged from the test expectation.

### Block (e) at lines 243:21, 280:21, 317:73 -- `upgradeLegacyHookCommands` mutations

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

Three of the four rows below are at HEAD `f48ef7d`, so the `/tmp/` vs
non-`/tmp/` location is the ONLY variable between them. The fourth row
repeats the original `4ed3519` baseline run, which differs from the
others in both location and commit and therefore cannot on its own
attribute the failures to either:

| Setup | Result |
| --- | --- |
| main checkout, not under `/tmp/`, at HEAD `f48ef7d` | 18 passed, 0 failed |
| worktree under `$HOME`, not under `/tmp/`, at HEAD `f48ef7d` | 18 passed, 0 failed |
| worktree under `/tmp/`, at HEAD `f48ef7d` | 7 failed, 11 passed |
| worktree under `/tmp/`, at `4ed3519` baseline | 7 failed, 11 passed (matches the 7 fails cited below) |

The `/tmp/`-at-HEAD row is the load-bearing one: the same 7 fails
reproduce at HEAD purely by moving the checkout under `/tmp/`, which
is what isolates location from commit.

The shared trigger is the path this test file computes for itself. It
does NOT import `PROJECT_ROOT` from `src/config.ts`; it derives its own
root at test file lines 19-22:

```ts
const ROOT = join(__dirname, '..', '..')
const PRUNE_SCRIPT = join(ROOT, 'scripts', 'boot-hook-prune.py')
const STALENESS_HOOK = join(ROOT, 'scripts', 'hooks', 'staleness-guard.py')
```

In a worktree under `/tmp/`, `STALENESS_HOOK` resolves to
`/private/tmp/.../scripts/hooks/staleness-guard.py`. Two SEPARATE
implementations then reject that path, both keyed on the same
`['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']` prefix list:

1. `isUnsafeHookCommand` in TypeScript
   (`src/web/agent-scaffold.ts:143`, `_TMP_PREFIXES` declared at `:129`
   and checked at `:144`; stated purpose "Volatile tmpfs prefixes" in
   the comment at `agent-scaffold.ts:124-128`).
2. `_is_stale_command` in Python
   (`scripts/boot-hook-prune.py:30`, its own `_TMP_PREFIXES` tuple at
   `scripts/boot-hook-prune.py:27`, applied at `:33`).

Per-block attribution:

- Block (a), lines 56 and 61: these assert the guard ACCEPTS a valid
  existing script, i.e. `isUnsafeHookCommand` applied to a
  `python3 <STALENESS_HOOK>` command is expected to be `false`.
  Under `/tmp/` the guard returns `true` on the tmpfs arm, so both
  assertions fail. Mechanism (1).
- Block (c), lines 130 and 175: these do NOT go through
  `isUnsafeHookCommand` and do not register anything. The tests write a
  synthetic `settings.json` into a `mkdtempSync` HOME and then run
  `execFileSync('python3', [PRUNE_SCRIPT], ...)` (test file lines 120,
  149, 171). The real `scripts/boot-hook-prune.py` prunes the
  `STALENESS_HOOK` entry because its own `_is_stale_command` matches
  `/private/tmp/`, so line 130's
  `expect(commands.some((c) => c.includes('staleness-guard.py'))).toBe(true)`
  and line 175's "file left unchanged" assertion both fail.
  Mechanism (2).
- Block (e), lines 243, 280 and 317: `upgradeLegacyHookCommands`
  consults `isUnsafeHookCommand` before rewriting an entry, so under
  `/tmp/` the upgrade is skipped and `expect(changed).toBe(true)` (and
  the follow-on command/timeout assertions) fail. Mechanism (1).

This supersedes the "Three distinct root causes" section above: the
three blocks share ONE environmental trigger (the checkout living under
a volatile tmpfs prefix), but they reach it through two different
implementations of the same prefix check, not one. In particular the
original block (c) hypothesis (missing `python3`, or a drifted script
fixture) is wrong -- `python3` runs fine and the script behaves exactly
as designed.

The MD's claim "the `2a28a54` commit's '6 tests went from fail to
pass' is not reproducible" is correct as written, but only because
every measurement behind it was taken in a `/tmp/` worktree: there the
`vi.importActual` mock is in place and effective, yet the tmpfs prefix
checks reject the paths regardless, so the 6-test fix is masked. In a
non-`/tmp/` worktree (this cycle 58 measurement) the 6 tests pass
without further change, which is the intended outcome of `2a28a54`.

The original empirical evidence (7 fail at
`/tmp/claw-test-baseline-a330462`) was correct ONLY for that worktree
location. In a standard non-`/tmp/` checkout the bug does not exist.
The original "no source edit attempted" stance stands: there is no
production bug to fix.

## Pinning test

The 7 failures, reproducible only in a `/tmp/` checkout, were in `src/__tests__/hook-path-guard.test.ts`, describe blocks `isUnsafeHookCommand (registration guard)` (a), `boot-hook-prune.py` (c), `upgradeLegacyHookCommands (automatic migration)` (e).

## Suggested direction

Superseded by `## Resolution` below: no test or implementation change is
needed for any of the three blocks. Run the suite from a checkout that
is not under `/tmp/`. (The per-block advice previously given here -- fix
`STALENESS_HOOK` resolution, check `python3` on PATH, reconcile
`upgradeLegacyHookCommands` -- all followed from the superseded
hypotheses and would have been wasted work.)

## Resolution

Closed by re-measurement (cycle 58, 2026-08-28). The 7 fails cited in
this MD were a `/tmp/` worktree artifact, not pre-existing drift in
the production code or the test expectations. In a standard
non-`/tmp/` checkout the test passes cleanly (18 passed, 0 failed at
HEAD `f48ef7d` in both the main checkout and a non-`/tmp/` worktree);
the same 7 fails reproduce at that same HEAD once the checkout is moved
under `/tmp/`, which is what isolates location from commit.
See `## Phase-1 re-measurement (2026-08-28)` above for the empirical
table and the two-mechanism root cause.

## Scope

Pre-existing on `a330462` baseline when measured in `/tmp/` worktrees;
absent on the same baseline when measured in non-`/tmp/` checkouts.
NOT introduced by `53a9f6c`. The `vi.importActual` mock at
`src/__tests__/hook-path-guard.test.ts:33-35` is effective; the 7 fails
in the `/tmp/` worktree come from the tmpfs prefix checks in
`src/web/agent-scaffold.ts` (blocks a, e) and
`scripts/boot-hook-prune.py` (block c), not from the
`forbid-system-calls` blanket. Original filing as a separate needs-fix
item stands; the re-measurement closes it without a source edit.
