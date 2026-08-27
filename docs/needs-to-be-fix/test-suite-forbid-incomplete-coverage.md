# test suite: `53a9f6c` global forbid incomplete opt-in coverage

## Location

`src/__tests__/setup/forbid-system-calls.ts` (registered in `vitest.config.ts`
between `assert-not-live-install.ts` and `test-sandbox-setup.ts`), introduced
in commit `53a9f6c` (2026-08-24 12:19). Per-feature opt-outs:

- `MARVEEN_TEST_ALLOW_CHILD_PROCESS=1` (un-mock `node:child_process`)
- `MARVEEN_TEST_ALLOW_FETCH=1` (un-mock `globalThis.fetch`)
- `MARVEEN_TEST_ALLOW_PROCESS_KILL=1` (un-mock `process.kill`)
- `MARVEEN_TEST_DISABLE_FORBID=1` (master kill switch — disables all three)

The setupFile blanket-throws for any unguarded `node:child_process`,
`globalThis.fetch`, or `process.kill` call from the default `bun --bun vitest
run` (gate) suite. Per-test-file `vi.mock('node:child_process', ...)` is the
documented escape hatch and wins over the setupFile because vitest hoists the
per-file factory AFTER the setupFile.

## Excerpt (the relevant section of the setupFile)

```ts
// Per-test-file vi.mock / vi.stubGlobal still wins (vitest hoisting order
// registers the per-file mock after this setupFile, so the file's mock
// factory overrides the thrower for that file).
```

## Failure scenario

1. `53a9f6c` lands. Only `schedule-runner-precheck.test.ts` (the RED fix
   mentioned in the same commit message) opts back in. Everything else is
   left to fail.
2. `2a28a54` (2026-08-24 15:14) fixes `hook-path-guard.test.ts` via
   `vi.importActual`, restoring real `execFileSync`/`spawnSync` for that
   single file. Six pinning tests in the file went from fail to pass.
3. The remaining ~15 test files still use `execFileSync` / `spawnSync` /
   `process.kill` directly to drive the production code under test (e.g.,
   real `tar` invocations in `agent-bundle.test.ts`, real `bun --check`
   spawn in `package-syntax-check.test.ts`). They have no per-file
   `vi.mock('node:child_process', ...)` and therefore hit the global thrower.
4. The CI gate (`bun run coverage`, which expands to
   `bun --bun vitest run --coverage` with no `MARVEEN_TEST_*` opt-outs) is
   red by design on `test/baseline @ 4ed3519`. 93 of 11175 tests fail
   (20 of 382 files). On the `a330462` baseline the same gate shows 19 of
   11132 tests failing (4 of 382 files), confirming the 74-test delta is the
   `53a9f6c` forbid net effect.
   (Cycle 58 scope note: both of those runs were taken in `/tmp/`
   worktrees. In a non-`/tmp/` checkout at HEAD the test-failure component
   is 0. The coverage job stays red regardless, on the separate 100%
   `perFile` threshold -- see `## Resolution (Partial, 2026-08-28)`.)

## Affected test files (20 files on 4ed3519: 16 net new since a330462, 4 pre-existing)

Pre-existing on `a330462` baseline (19 fails, 4 files): the same 4 below that
still fail on `4ed3519` minus the 6 fixed by `2a28a54` in
`hook-path-guard.test.ts`.

| Bug ID per file | File | Failures on `4ed3519` | Pattern | Pinning test path |
| --- | --- | --- | --- | --- |
| `forbid-incomplete-agent-bundle` | `src/__tests__/agent-bundle.test.ts` | 7 | calls `execFileSync('tar', ...)` to create bundles; no per-file mock | same file |
| `forbid-incomplete-bridge-enroll` | `src/__tests__/bridge-enroll.test.ts` | 1 | real `execFileSync('ssh-keygen', ...)` for end-to-end enroll audit | same file |
| `forbid-incomplete-channel-coordinator-liveness` | `src/__tests__/channel-coordinator-liveness.test.ts` | 1 | real `spawn` of the orphan reparent probe | same file |
| `forbid-incomplete-channel-inbound-tee` | `src/__tests__/channel-inbound-tee.test.ts` | 1 | real `spawn` for the byte-for-byte stdout pipe test | same file |
| `forbid-incomplete-channels-reap-scope` | `src/__tests__/channels-reap-scope.test.ts` | 4 | real `execFileSync` to send SIGTERM to test children | same file |
| `forbid-incomplete-email-send-gate` | `src/__tests__/email-send-gate.test.ts` | 3 | real `execFileSync` for `injectEmailSendGate` settings.json write | same file |
| `forbid-incomplete-governance-gates` | `src/__tests__/governance-gates.test.ts` | 3 | real `execFileSync` for `injectSelfPaceGate` settings.json write | same file |
| `forbid-incomplete-hook-command-quoting` | `src/__tests__/hook-command-quoting.test.ts` | 6 | real `execFileSync` for `injectEmailSendGate`/`injectSelfPaceGate`/`injectEgressGate` quoting + migration | same file |
| `forbid-incomplete-hook-path-guard` | `src/__tests__/hook-path-guard.test.ts` | 7 | real `execFileSync('python3', ...)` for `isUnsafeHookCommand` (2 tests at L56, L61) + `boot-hook-prune.py` (2 tests at L130, L175) + `upgradeLegacyHookCommands` (3 tests at L243, L280, L317). The `2a28a54` vi.mock at L33-35 of the test file (using `vi.importActual<typeof import('node:child_process')>('node:child_process')`) does NOT restore real `child_process` for these 7 tests — empirical measurement at `4ed3519` shows 7 fails despite the mock being present. The `2a28a54` commit message's "6 tests went from fail to pass" claim is not reproducible at `4ed3519` (the saved vitest output `/tmp/vitest-4ed3519-failures.txt` shows `7 failed` for this file at the commit the MD claims as its baseline). | same file |
| `forbid-incomplete-installer-apt-lock-set-e` | `src/__tests__/installer-apt-lock-set-e.test.ts` | 3 | real `execFileSync('apt-get', ...)` for the lock-state set | same file |
| `forbid-incomplete-installer-service-auth-gate` | `src/__tests__/installer-service-auth-gate.test.ts` | 9 | real `execFileSync` for service install/auth gate probe | same file |
| `forbid-incomplete-installer-start-and-fallback` | `src/__tests__/installer-start-and-fallback.test.ts` | 13 | real `execFileSync` for installer start + fallback scenarios | same file |
| `forbid-incomplete-managed-settings` | `src/__tests__/managed-settings.test.ts` | 4 | real `execFileSync` for managed-settings.json merge | same file |
| `forbid-incomplete-memory-boundary` | `src/__tests__/memory-boundary.test.ts` | 4 | real `execFileSync` for the cross-process memory boundary probe | same file |
| `forbid-incomplete-package-syntax-check` | `src/__tests__/package-syntax-check.test.ts` | 3 | real `spawnSync('bun', ['--check', ...])` for the syntax-check script | same file |
| `forbid-incomplete-port-chain-no-hardcode` | `src/__tests__/port-chain-no-hardcode.test.ts` | 8 | real `execFileSync` to resolve `WEB_PORT` from `.env`, `scripts/set-bot-menu.sh`, `egress-gate` | same file |
| `forbid-incomplete-routes-updates` | `src/__tests__/routes-updates.test.ts` | 2 | real `execFileSync('bash', ...)` for the `PidfileRunner via real checkNoConcurrentUpdate` path | same file |
| `forbid-incomplete-skill-index` | `src/__tests__/skill-index.test.ts` | 10 | real `execFileSync` for the skill-index rebuild | same file |
| `forbid-incomplete-staleness-guard` | `src/__tests__/staleness-guard.test.ts` | 2 | real `execFileSync('python3', ...)` for the staleness-guard hook behavioural path | same file |
| `forbid-incomplete-update-checker-branch` | `src/__tests__/update-checker-branch.test.ts` | 2 | real `execFileSync` for the update-checker branch probe | same file |

Sum: **13 + 10 + 9 + 8 + 7 + 7 + 6 + 4 + 4 + 4 + 3 + 3 + 3 + 3 + 2 + 2 + 2 + 1 + 1 + 1 = 93 fails** across these 20 files. The
test-runner summary of `20 failed test files | 93 failed tests` matches
exactly. The per-file counts above are the authoritative measurements
from the saved vitest output at `/tmp/vitest-4ed3519-failures.txt`
(timestamp 2026-08-27 13:11, on `4ed3519` with `2a28a54`'s
`vi.importActual` mock in place at `hook-path-guard.test.ts:33-35`).

## Suggested direction (implemented 2026-08-27, see Resolution below)

Per-test-file opt-in following the `2a28a54` pattern. The exact insertion
template (lifted from `2a28a54`):

```ts
import { vi } from 'vitest'

// Per-file vi.mock with vi.importActual restores the real child_process
// module for this file only. Per-test-file mock wins over the setupFile
// mock because the per-file factory is hoisted AFTER the setupFile (see
// src/__tests__/setup/forbid-system-calls.ts:43-46).
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process')
  return actual
})
```

For test files that need both `node:child_process` AND `globalThis.fetch`
AND `process.kill`, the per-file opt-in is per-API: `vi.importActual` is
the `node:child_process` shape (a `vi.mock`-able module), `globalThis.fetch`
must use `vi.stubGlobal('fetch', originalFetch)` (it's a direct property
assignment, not a module), and `process.kill` must use
`vi.spyOn(process, 'kill').mockImplementation(...)` (also a direct property
assignment). The setupFile header at `forbid-system-calls.ts:43-46` and
`:109` documents these three escape hatches. The `test-suite-llm-api-audit-clean.md`
audit doc (low.md:29) confirms that none of these tests make a real LLM call,
so the `MARVEEN_TEST_ALLOW_FETCH=1` path is unnecessary for the gate.

## Alternative: move to the `test:integration` scope

If per-file mocks are undesirable (e.g., the test is genuinely integration
and the hermetic gate is not the right place for it), the alternative is
to exclude the file from the default vitest project and include it only in
the `test:integration` script (`MARVEEN_TEST_ALLOW_CHILD_PROCESS=1
MARVEEN_TEST_ALLOW_PROCESS_KILL=1 bun --bun vitest run`). The vitest
config supports this via `test.projects` or per-script `--include`/`--exclude`
flags. CI would then need a second job to run the integration scope.

The `forbid-system-calls.ts` header already mentions this split
(`bun run test` vs `bun run test:integration`), so the design has room for
both. Per-file opt-in is the lower-risk choice because it preserves the
gate invariant that any new file failing this pattern must explicitly opt
in to subprocess access — the same property the `53a9f6c` commit set out
to enforce.

## Pinning test

There is no per-bug pinning test in the strict sense; the gate
(`bun --bun vitest run` with no `MARVEEN_TEST_*` opt-outs) is the contract.
If the gate shows 0 failures across these 20 files, the row can be marked
Resolved.

## Empirical record

- `53a9f6c` (2026-08-24 12:19): global forbid introduced. RED fix in
  `schedule-runner-precheck.test.ts` only.
- `2a28a54` (2026-08-24 15:14): `hook-path-guard.test.ts` opt-in
  (`vi.importActual` at L33-35). The commit message claims "6 tests went
  from fail to pass". Empirical re-measurement at `4ed3519` (with the mock
  in place) shows `7 failed` for that file, NOT 1. The 6-test fix claim is
  not reproducible; the mock is in the file but the tests still fail. The
  root cause is likely that the `vi.importActual` template does not match
  the runtime shape these tests need (real `python3` script exec + spawn,
  not just the `child_process` module surface). Re-investigation deferred
  to the next cycle along with the other 16 net-new affected files.
  (Cycle 58 closed this: the mock IS effective, and the 7 fails were a
  `/tmp/` location artifact -- see `## Verification (cycle 58)` below and
  `hook-path-guard-pre-existing-drift.md`.)
- `6558b4d` (2026-08-26): `channel-coordinator` test switched from
  `process.kill` to `process.emit` to dodge the global forbid (a
  per-test fix, not a per-file `vi.mock`).
- `6af8c6a` (2026-08-21): `hook-path-guard` adds `'vi'` to vitest import
  (prerequisite for the `2a28a54` mock factory).
- 2026-08-27 baseline measurement on `test/baseline @ 4ed3519`:
  93 fails, 20 files (this MD). Baseline a330462: 19 fails, 4 files
  (pre-existing).

## Verification (cycle 58)

Re-measured 2026-08-28. The 16 per-file opt-in commits cover the left 16
files; the right 4 CAT-D files are pre-existing drift on the `a330462`
baseline.

The first three rows are all at HEAD `f48ef7d`, so the `/tmp/` vs
non-`/tmp/` location is the ONLY variable between them. The fourth row
repeats the `4ed3519` baseline run, which differs in both location and
commit and therefore cannot on its own attribute anything to either:

| Setup | 16 opt-in files | 4 CAT-D files |
| --- | --- | --- |
| main checkout, `PROJECT_ROOT` not under `/tmp/`, at HEAD `f48ef7d` | 297 passed, 0 failed | 105 passed, 0 failed |
| worktree under `$HOME`, not under `/tmp/`, at HEAD `f48ef7d` | 297 passed, 0 failed | 105 passed, 0 failed |
| worktree under `/tmp/`, at HEAD `f48ef7d` | 297 passed, 0 failed | 19 failed, 86 passed (105 total) |
| worktree under `/tmp/`, at `4ed3519` baseline | 74 failed | 19 failed, 86 passed (105 total) |

The third row is the load-bearing one. It shows the two effects are
independent: the 74 opt-in fails are commit-driven (they disappear at
HEAD regardless of location), while the 19 CAT-D fails are
location-driven (they persist at HEAD as soon as the checkout moves
under `/tmp/`).

Root cause of the 19 "fail" count in the `/tmp/` worktree:
`isUnsafeHookCommand` (`src/web/agent-scaffold.ts:143`) rejects any
command containing one of
`_TMP_PREFIXES = ['/tmp/', '/var/tmp/', '/private/tmp/', '/dev/shm/']`
(declared at `src/web/agent-scaffold.ts:129`, checked at `:144`; stated
purpose "Volatile tmpfs prefixes" in the comment at
`agent-scaffold.ts:124-128`). When the test runs in a worktree under
`/tmp/`, `PROJECT_ROOT = join(__dirname, '..')` (`src/config.ts:12`)
resolves to that worktree path, so
`hookCommand(join(PROJECT_ROOT, 'scripts', 'email-send-gate.mjs'))` and
its siblings produce commands containing `/private/tmp/...`, which the
guard refuses to register.

The failure MODE varies by call site, and is not uniformly a
`toHaveLength` mismatch. `injectEmailSendGate` / `injectSelfPaceGate` /
`injectEgressGate` return BEFORE assigning `hooks.PreToolUse`, so that
key stays `undefined` rather than becoming an empty array -- the tests
then fail on `toHaveLength` against `undefined`, or throw `TypeError`
from `.filter` / `.find` / `.some` on `undefined`. `ensureEgressGate`
returns `false` from its own guard at `agent-scaffold.ts:485`, and
`ensureGovernanceGateCommands` ignores the injectors' outcome and
returns `true` on both invocations; both of those fail on `.toBe(...)`.
`hook-path-guard.test.ts` is a separate case again: it derives its own
`ROOT` instead of importing `PROJECT_ROOT`, and two of its seven fails
come from the independent Python implementation of the same prefix list
in `scripts/boot-hook-prune.py:27`. See
`hook-path-guard-pre-existing-drift.md` for the per-block breakdown.

The 4 CAT-D MDs' original empirical evidence was measured in `/tmp/`
worktrees (the MDs show `git -C /tmp/claw-test-baseline-a330462`).
CLAUDE.md §8 prescribes a `/tmp/claw-test` worktree only as a fallback
for when the main checkout has a non-empty `store/` and the
`assert-not-live-install.ts` guard would block the suite. Our main
checkout is clean, so the non-`/tmp/` measurement is the one that
reflects CI. The 4 CAT-D files pass cleanly outside `/tmp/`.

Note that CLAUDE.md §8's fallback is itself the trap: an agent that
follows it lands under `/tmp/` and reproduces all 19 fails. That is a
standing workflow hazard, not a defect in these 4 files -- see the
caveat under `## Resolution (Partial, 2026-08-28)`.

## Resolution (Partial, 2026-08-28)

Partial: 16 of the 20 originally-failing files got per-file opt-in
mocks (74 of 93 fails removed; commit SHAs verified against the test
file they touch). The remaining 4 files (`email-send-gate.test.ts`,
`governance-gates.test.ts`, `hook-command-quoting.test.ts`,
`hook-path-guard.test.ts`) appear in the `a330462` baseline as 19
pre-existing fails. Cycle 58 re-measured them in a non-`/tmp/`
checkout and confirmed 0 fail in both the main checkout and a
non-`/tmp/` worktree (105 passed, 0 failed in each), and separately
confirmed that the same 19 fails DO reproduce at HEAD `f48ef7d` once
the checkout is moved under `/tmp/`. The 19 "fail" count is therefore a
`/tmp/` location artifact rooted in the tmpfs prefix checks refusing a
hook whose script path lives under a volatile tmpfs prefix. In a
standard non-`/tmp/` checkout it does not occur.

Net fail delta:

- Pre-fix (`test/baseline @ 4ed3519`, `/tmp/` worktree): 93 fails / 20 files.
- Post-fix (HEAD `f48ef7d`, `/tmp/` worktree): 19 fails / 4 files (74 net removed).
- Post-fix (HEAD `f48ef7d`, non-`/tmp/`): 0 fails / 4 files (verified).

16 opt-in commit SHAs (each verified to touch its claimed test file):

- `64385ab` -- `src/__tests__/agent-bundle.test.ts`
- `6d5f7e7` -- `src/__tests__/bridge-enroll.test.ts`
- `1c45480` -- `src/__tests__/channel-coordinator-liveness.test.ts`
- `a022de5` -- `src/__tests__/channel-inbound-tee.test.ts`
- `aa833eb` -- `src/__tests__/channels-reap-scope.test.ts`
- `c295a7c` -- `src/__tests__/installer-apt-lock-set-e.test.ts`
- `26d2ee1` -- `src/__tests__/installer-service-auth-gate.test.ts`
- `16f77e2` -- `src/__tests__/installer-start-and-fallback.test.ts`
- `cbc7d14` -- `src/__tests__/managed-settings.test.ts`
- `a28c544` -- `src/__tests__/memory-boundary.test.ts`
- `70cb8b4` -- `src/__tests__/package-syntax-check.test.ts`
- `a691f10` -- `src/__tests__/port-chain-no-hardcode.test.ts`
- `a16d054` -- `src/__tests__/routes-updates.test.ts`
- `58fc51d` -- `src/__tests__/skill-index.test.ts`
- `8856374` -- `src/__tests__/staleness-guard.test.ts`
- `af5cb7d` -- `src/__tests__/update-checker-branch.test.ts`

Sum of pre-fix fail counts from the table above for these 16 files:
7 + 1 + 1 + 1 + 4 + 3 + 9 + 13 + 4 + 4 + 3 + 8 + 2 + 10 + 2 + 2 = 74
(matches the 74-test delta exactly).

The 4 CAT-D MDs are now re-closed by re-measurement (cycle 58):

- `docs/needs-to-be-fix/email-send-gate-pre-existing-drift.md`
- `docs/needs-to-be-fix/governance-gates-pre-existing-drift.md`
- `docs/needs-to-be-fix/hook-command-quoting-pre-existing-drift.md`
- `docs/needs-to-be-fix/hook-path-guard-pre-existing-drift.md`

Caveat: a `/tmp/` worktree reproduces the 19 "fail" count for these 4
files. The production code is correct (it refuses to register a hook
under a volatile tmpfs prefix); the test files are correct as
written. This is not a fix candidate, it is a documentation
reconciliation only.

Second caveat, carried forward from the superseded `## Resolution`:
closing this row does NOT turn the CI `bun run coverage` job green. That
job is red for an unrelated reason -- `vitest.config.ts` pins a 100%
`perFile` coverage threshold and 44 files sit below it (see
`.github/workflows/CLAUDE.md`, "Why coverage is red"). The 16 opt-in
commits removed test FAILURES; they did not move the coverage
threshold. Do not read "Resolved (Partial)" as "the gate passes".

The `low.md` row for `test-suite-forbid-incomplete-coverage` is
updated to reflect the partial resolution, the `/tmp/` worktree
caveat, and the still-red coverage gate.

## Scope note

Per CLAUDE.md rule "kötelező mindig commitolni" and "kötelező minden bug-t
teszttel lefedni a javítás után": the eventual per-file opt-in is expected
to be one commit per affected file (16 commits + this MD's companion docs
commit), mirroring the `2a28a54` precedent. No source edit is part of this
MD's commit; this MD only documents the failure set.
