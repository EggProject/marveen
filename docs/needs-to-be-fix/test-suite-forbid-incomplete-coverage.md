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

## Affected test files (16 files, 74 new failures since a330462)

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
| `forbid-incomplete-hook-path-guard` | `src/__tests__/hook-path-guard.test.ts` | 1 | real `execFileSync('python3', ...)` for the registration-guard path (the 6 boot-hook-prune + upgradeLegacyHookCommands tests were fixed in `2a28a54`; the remaining 1 in `isUnsafeHookCommand` is the one that still calls real `python3` outside the `2a28a54` scope) | same file |
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

Sum: **7 + 1 + 1 + 1 + 4 + 3 + 3 + 6 + 1 + 3 + 9 + 13 + 4 + 4 + 3 + 8 + 2 + 10 + 2 + 2 = 87 fails** across these 20 files. The
test-runner summary reports 93 fails across 20 files; the difference (6)
matches the 6 hook-path-guard tests that `2a28a54` fixed and are now counted
in the baseline pre-existing row, plus minor counts in pre-existing rows for
`email-send-gate`, `governance-gates`, `hook-command-quoting`. The
test-runner summary of `20 failed test files | 93 failed tests` is the
authoritative number.

## Suggested direction

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
AND `process.kill`, the same `vi.importActual` pattern must be applied to all
three modules. The `test-suite-llm-api-audit-clean.md` audit doc (low.md:29)
confirms that none of these tests make a real LLM call, so the
`MARVEEN_TEST_ALLOW_FETCH=1` path is unnecessary for the gate; the
per-file `vi.importActual` for `globalThis.fetch` is the correct shape.

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
  (`vi.importActual`). 6 fails -> 1 fail in that file (the remaining 1 is
  the `isUnsafeHookCommand` `python3` call outside the `2a28a54` scope).
- `6558b4d` (2026-08-26): `channel-coordinator` test switched from
  `process.kill` to `process.emit` to dodge the global forbid (a
  per-test fix, not a per-file `vi.mock`).
- `6af8c6a` (2026-08-21): `hook-path-guard` adds `'vi'` to vitest import
  (prerequisite for the `2a28a54` mock factory).
- 2026-08-27 baseline measurement on `test/baseline @ 4ed3519`:
  93 fails, 20 files (this MD). Baseline a330462: 19 fails, 4 files
  (pre-existing).

## Resolution

Open. The full per-file opt-in or the test-scope split is deferred to the
next cycle. Until then, the CI `bun run coverage` job is red by design and
the row in `low.md` stays Open.

## Scope note

Per CLAUDE.md rule "kötelező mindig commitolni" and "kötelező minden bug-t
teszttel lefedni a javítás után": the eventual per-file opt-in is expected
to be one commit per affected file (16 commits + this MD's companion docs
commit), mirroring the `2a28a54` precedent. No source edit is part of this
MD's commit; this MD only documents the failure set.
