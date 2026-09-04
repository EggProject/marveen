# Plan: close `keychain-store-insecure-acl` (now unblocked)

## Context

Cycle 47 closed `keychain-retrieve-swallows-locked-keychain` (commit `6e5bdd7`,
2026-08-17) by introducing `KeychainUnavailableError`. That fix is the explicit
prerequisite the deferred MD `docs/needs-to-be-fix/keychain-store-insecure-acl.md`
calls out: "removing `-A` after step 1 cannot trigger a vault re-key, because the
keychain prompt (if any) raises `KeychainUnavailableError`, which `getMasterKey`
treats as fatal when the vault is non-empty."

The MD itself documents the exact edit (replace `-A` with `-T SECURITY` in
`src/web/keychain.ts:32`) and the exact pinning-test change
(`src/__tests__/keychain.test.ts:302-316` → invert to `not.toContain('-A')` and
assert `-T SECURITY`). The remaining 4 deferred items have materially larger
scope or different risk profiles (architectural refactors, vitest dynamic-import
workarounds, polling-loop testability), so this is the smallest, most-guarded
needs-fix item in the queue.

## Scope (single fix, no combining)

Combining with `web-inbound-probe-cache-sticky` (the other "small" candidate)
was considered and rejected: they touch different files, different test
patterns, and would balloon a 1-line source edit into a 2-file multi-test
patch. The user constraint "többet összevonhatsz ha tudod garantalni hogy nem
keletkezik bug belőle" requires independent guarantee; with no shared
preconditions, the per-fix risk model is sharper when they are not combined.

## Files touched (3)

1. `src/web/keychain.ts` (line 32 only): replace `-A` with `-T, SECURITY`.
   The literal `SECURITY = '/usr/bin/security'` is already imported on line 4
   of the same file, so no new constant is needed.
2. `src/__tests__/keychain.test.ts` (lines 300-316, the `passes -A` test):
   invert to assert `not.toContain('-A')` AND `toContain('-T')` AND
   `argAfter(args, '-T') === SECURITY`. Update the comment block to reflect
   the unblocking (the previous comment said "until
   `keychain-retrieve-swallows-locked-keychain` is fixed first, `-A` must
   stay"; that gate is now satisfied).
3. `docs/needs-to-be-fix/INDEX.md` (row 76, `keychain-store-insecure-acl`):
   update `Resolved:` column to `Resolved: 2026-08-26 <SHA>`. Use the
   `(this commit)` placeholder pattern + a follow-up SHA-replace commit,
   per CLAUDE.md §8 rule.

No source changes outside `keychain.ts`. No test changes outside
`keychain.test.ts`. No MD content edits; the MD stays as the historical
record. The vault test file (`src/__tests__/vault.test.ts`) is NOT touched —
it already exercises the `KeychainUnavailableError` path independently.

## Pre-flight (mandatory per Honcho memory)

1. `bunx tsc --noEmit | wc -l` → record baseline (current: **2253**)
2. `bun --bun vitest run src/__tests__/keychain.test.ts src/__tests__/vault.test.ts`
   → record pass count before the edit
3. `git grep -nE '"-A"|` -A`'` src/ --include='*.ts' | grep -v __tests__`
   → confirm only one production call site (line 32 of keychain.ts)
4. `grep -n '\.not\.toHaveBeenCalled\|\.toHaveBeenCalled' src/__tests__/keychain.test.ts`
   → confirm no mock pin on `keychainStore` call count that would flip
   (the only relevant pin is the args-shape assertion we are deliberately
   updating)

## Implementation (single commit per Honcho memory "Post-fix commit rule")

**Note on Cycle 16 evidence (Plan-agent finding).** Commit `0c81522`
attempted a different fix: it REMOVED `-A` entirely (no replacement),
which was reverted in `725b1a1` because the resulting access prompt
cascaded into a vault re-key. The current plan is `-T SECURITY`, a
DIFFERENT fix whose premise ("trusted app = the binary itself, so no
prompt") has not been empirically verified. The `KeychainUnavailableError`
cascade catches a wrong premise, but a wrong premise still produces a
silent file-key fallback on first run. The manual smoke test in
"Real-host verification" below is BLOCKING (non-negotiable) before merge
to `test/baseline`.

**Note on line-ref drift (Plan-agent finding).** The MD cites
`vault.ts:44-49` and `vault.ts:65-91`; at HEAD the actual lines are
`vault.ts:46-56` (the catch block) and `vault.ts:65` (the
`vaultHasContent()` guard). Doc-only, out of scope for this fix. The
plan does not require updating the MD body.

**Note on caller line numbers (Plan-agent finding).** Production
`keychainStore` callers are `vault.ts:35` and `vault.ts:75` (not 37/75
as the plan author first wrote). Both inside try/catch with file-key
fallback. Confirmed safe.

Edit `src/web/keychain.ts:25-34`:

```ts
export function keychainStore(value: string): void {
  execFileSync(SECURITY, [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', value,
    '-T', SECURITY,
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
}
```

Edit `src/__tests__/keychain.test.ts:300-316`: invert the assertion and
update the comment to reflect the unblocking. The test still drives
`keychainStore('master')` and checks the argv shape; only the expected
flag changes from `-A` to `-T SECURITY`.

Commit message:
```
fix(keychain): replace insecure -A with explicit -T SECURITY on master-key ACL
```

The commit message MUST document:
- The unblocking precondition (`keychain-retrieve-swallows-locked-keychain`
  resolved in `6e5bdd7`).
- The remaining residual risk: a real macOS host with an
  interactive keychain prompt would surface as `KeychainUnavailableError`,
  which `getMasterKey` now treats as fatal. Document the manual
  verification step the operator must run on a real host:
  `keychainStore` + `keychainRetrieve` in one non-interactive session
  (over SSH this manifests as exit 36, which the new error class surfaces
  to the caller).

## Real-host verification (user-driven, NOT automatable)

The MD states: "Verify on a real host first that reads still complete
without a prompt -- over SSH a prompt manifests as exit 36, so
`keychainStore` + `keychainRetrieve` in one non-interactive session is a
sufficient check."

This is the single operator step that cannot run in CI. The plan's
verification section will list it explicitly; the test suite validates
the argv shape; the manual SSH check validates no-runtime-prompt
behavior. **BLOCKING before merge to `test/baseline`** -- the test
suite cannot verify the no-prompt premise, and a wrong premise produces
a silent file-key fallback (see "Behavior change" below).

## Behavior change (BETA finding S8)

If the `-T SECURITY` premise is wrong (i.e. macOS still prompts because
the prompt is for keychain unlock rather than app authorization, as
Cycle 16 empirically observed in this install), the cascade is:

- Non-empty vault: `vault.ts:65-71` `vaultHasContent()` guard refuses
  to mint a replacement. Operator sees the original error.
- Empty vault (first-run): `vault.ts:73-81` falls back to
  `atomicWriteFileSync(VAULT_KEY_PATH, newKey, { mode: 0o600 })`. The
  master key lives in `store/.vault-key` (mode 0600) instead of macOS
  Keychain. Same encryption, same on-disk secret, no re-key, no data
  loss, but the file-based path is what `vault.readMasterKey` then
  reads on every subsequent run. **Operators hitting this branch must
  know to either unlock the login keychain or accept the file-based
  fallback**; this is not a regression but is a user-visible change
  vs the pre-fix `-A` flow that always stored the key in Keychain.

The plan does not introduce a new code path; the fallback path is
pre-existing (`6e5bdd7` added the `KeychainUnavailableError` cascade
in `vault.ts:31-80`) and is exercised by both `keychainStore` and
`keychainRetrieve` failures.

## Workflow (3 phases, per Honcho memory MiPgcts5 template)

**Phase 1: Implement** — single subagent (general-purpose) performs:
- Edit `src/web/keychain.ts:32` (`-A` → `-T SECURITY`)
- Edit `src/__tests__/keychain.test.ts:300-316` (invert assertion)
- Run `bun --bun vitest run src/__tests__/keychain.test.ts src/__tests__/vault.test.ts`
- Run `bunx tsc --noEmit` and confirm error count is unchanged (2253)
- Run `git diff --stat` to confirm only the 2 expected files
- Commit with the safe-commit-message protocol

**Phase 2: Verify** — 2 subagents in parallel, each launched via the
**Agent tool** with `isolation: worktree` (NOT the Workflow tool; per
CLAUDE.md §8 the Workflow tool's `script` parser is fragile and the
Agent tool first-shot success rate is empirically higher for 2-subagent
parallel verification):

- **ALPHA (correctness lens):** reads the diff, the MD, the test file's
  new assertion, and answers: does the edit do what the MD prescribes?
  Does the test still pin current behavior? Is the index file
  consistent? Did any pre-flight check get skipped?
- **BETA (security/risk lens):** reads the diff, the MD's "Path to a
  real fix" section, the `vault.ts:31-80` migration code, and answers:
  does the edit close the documented ACL vector? Is the residual
  `KeychainUnavailableError` cascade actually safe? Are there other
  production call sites of `keychainStore` that would now see a
  prompt (i.e. is there a non-vault caller)?

Each subagent returns a `verdict` JSON: `{isReal: bool, rationale: string}`.
If either flags `isReal: false`, the workflow stops for the user to
decide the next path (commit partial / refactor / drop — Honcho memory
#28: 3-path divergence).

**Phase 3: Finalize** — single subagent updates `INDEX.md` row 76 with
the commit SHA using the `(this commit)` placeholder pattern. The
predecessor Honcho memory says: never inline SHA in MD before amend
cycle. So:
- Phase 1 commit uses message `fix(keychain): replace insecure -A ...`
  with body referencing `(this commit)` for any future MD link.
- Phase 3 commit: `docs(index): correct SHA reference for
  keychain-store-insecure-acl row`.

The worktree-isolated subagent commits land on detached HEADs; per
CLAUDE.md §8 rule, return to `test/baseline` via `git merge --ff-only
<SHA>` (verify `git merge-base test/baseline <SHA>` matches the branch
HEAD before merging). Working tree must be clean before merge; `git
worktree remove <path> --force` cleans up. DO NOT use
`git reset --hard <SHA>` (triggers Claude Code security warning).

## End: mandatory `/code-review max --fix`

After Phase 3 merge, the user invokes `/code-review max --fix <range>`
per project convention. Per Honcho memory: this skill is `disable-model-invocation`
flagged, so I cannot call it via Skill. Document the exact command for
the user to run manually:

```
/code-review max --fix <new-commit-SHA>..HEAD
```

Where `<new-commit-SHA>` is the SHA produced by Phase 1 (the
`fix(keychain): replace insecure -A ...` commit). Phase 1's commit
output captures this SHA; the user substitutes it at invocation time.
NOTE: `b3068b1` is NOT the current `test/baseline` HEAD (HEAD is
`2d0fcb0`, 3 commits ahead: 5986d9d, a0f52d7, 2d0fcb0); a literal
`b3068b1..HEAD` would scan only 4 commits and miss 3 recent docs
fixes. The user MUST use the SHA from Phase 1 output.

The expected review-level checks: argv shape, vault.ts cascade,
test-pinning correctness, INDEX row correctness, tsc baseline unchanged.

## Critical files

- `src/web/keychain.ts:25-34` (the edit)
- `src/__tests__/keychain.test.ts:300-316` (the test inversion)
- `docs/needs-to-be-fix/INDEX.md:76` (the row update)
- `docs/needs-to-be-fix/keychain-store-insecure-acl.md` (read-only, source
  of truth for the prescribed edit)

## Out of scope

- The other 4 deferred items (`channel-coordinator-internals-untestable`,
  `routes-agents-br-baseline-partial-coverage`,
  `web-agent-worker-runviaworker-coverage`,
  `web-inbound-probe-respawn-grace`, `web-inbound-probe-cache-sticky`)
  stay deferred. Each has independent preconditions, and the user's
  constraint of "smallest first" + "összevonás csak ha garantálható"
  means the next cycle will re-evaluate them.
- No new code path, no new function, no new abstraction. The fix is a
  1-line source edit + 1-line test edit + 1-line index update.

## Verification

End-to-end checks (all must pass before merge to `test/baseline`):

1. `bunx tsc --noEmit | wc -l` → **2253** (no change from baseline)
2. `bun --bun vitest run src/__tests__/keychain.test.ts` → 0 failed
3. `bun --bun vitest run src/__tests__/vault.test.ts` → 0 failed
   (regression: must still pass after the flag swap, since the
   `KeychainUnavailableError` path is independent of `-A` vs `-T`)
4. `git diff test/baseline..HEAD --stat` → 3 files (keychain.ts,
   keychain.test.ts, INDEX.md) with minimal line counts
5. `git grep -nE '"-A"' src/ --include='*.ts'` → empty (no production
   `-A` flag remains in src/)
6. Manual operator step (BLOCKING before merge, not auto-gated): SSH
   into a macOS box, run `keychainStore('x')` then
   `keychainRetrieve()`; both must complete without a UI prompt. Exit
   36 = prompt required = `KeychainUnavailableError` raised (the
   correct behavior). Exit 0 = pass. If exit 36 fires in a real install
   (Cycle 16 empirically observed this), the cascade falls back to a
   file-based master key (see "Behavior change" section above) and
   the operator must either unlock the login keychain or accept the
   file-based path.
7. `/code-review max --fix <new-commit-SHA>..HEAD` (user-invoked) → 0
   CRITICAL findings. The user MUST substitute the Phase 1 commit SHA
   at invocation time. Do NOT use a hardcoded SHA.
