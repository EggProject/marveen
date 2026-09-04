# needs-fix batch: message-router MD reconciliation + hook-path-guard test fix

## Context

Two UNRESOLVED needs-fix items, both tiny, both disjoint file sets, both safe to combine into one workflow:

**Item A — message-router MD inconsistency.** Commit `29c5103` reverted a broken per-glob threshold override AND explicitly deferred the following cleanup as "out of scope":
1. `message-router-unreachable-defensive-branches.md:115` footer reads "Partially resolved... lines 478-480 remain open due to TS strict blocking" — but the `??` arms are actually at **lines 481-483** (verified by `awk 'NR>=470'`; `vitest.config.ts` NOTE already uses the corrected 481-483)
2. `message-router-dead-defensive-branches.md:185` footer omits the file-level coverage reality (97.82%, unchanged since `29c5103`)
3. `INDEX.md:131` says "Deferred to next cycle" while the MD banner says "UNRESOLVED" — terminology drift
4. `message-router-cache-fallback-unreachable.md:82-89` "Pinning test" section still claims a rename (`8209fb3`) happened — but that rename was reverted in `f67efca` after the source-side change it documented (`eb9b951`) was itself reverted in `2ec1c99`. All four commits verified by `git log --all`.

**Item B — hook-path-guard test failures.** 6 tests in `src/__tests__/hook-path-guard.test.ts` (lines 94, 124, 147, 173, 182, 198) fail under `bun run test` because the new `src/__tests__/setup/forbid-system-calls.ts` setupFile (commit `53a9f6c`) blanket-forbids `node:child_process`, and these tests legitimately need real `execFileSync('python3', PRUNE_SCRIPT)` and real `spawnSync('bash', ['-c', ...])`. Prior session memory's "19 failures" claim was incorrect (verified: 4 other named files all green). All 6 failures are at the same call pattern; one `vi.mock` block fixes all six.

Intended outcome: `bun run test` and `bun run test:integration` both pass 18/18 in `hook-path-guard.test.ts` (was 12/18 under default deny-list), and the message-router MD trio reads consistently.

## Recommended approach

TWO commits, disjoint file sets, both cherry-pickable onto `test/baseline`. Workflow-driven execution in a fresh detached worktree at `/tmp/claw-batch-next`.

### Commit 1 — `docs(message-router): reconcile post-revert MDs`

Four doc-only edits. Zero source change. Zero risk.

**1.1** `docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md:115`

```
old:
Partially resolved: 2026-08-19 ba6faf8 (lines 81, 317 deleted; lines 478-480 remain open due to TS strict blocking)

new:
Partially resolved: 2026-08-19 ba6faf8 (lines 81, 317 deleted); UNRESOLVED on lines 481-483 -- see message-router-cache-fallback-unreachable.md
```

**1.2** `docs/needs-to-be-fix/message-router-dead-defensive-branches.md:185` (append one sentence)

```
old:
Partially resolved: 2026-08-19 ba6faf8 (lines 81, 317 deleted; line 180 deferred as stylistic inversion, not dead code)

new:
Partially resolved: 2026-08-19 ba6faf8 (lines 81, 317 deleted; line 180 deferred as stylistic inversion, not dead code). File-level branch coverage still at 97.82% (3 uncovered `??` arms at lines 481-483); see message-router-cache-fallback-unreachable.md.
```

**1.3** `docs/needs-to-be-fix/INDEX.md:131`

```
old:
| `message-router-cache-fallback-unreachable` | message-router.ts: cached session-lookup `??` fallback arms are unreachable | Deferred to next cycle |

new:
| `message-router-cache-fallback-unreachable` | message-router.ts: cached session-lookup `??` fallback arms are unreachable | UNRESOLVED -- deferred to next cycle |
```

**1.4** `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md:82-89` (replace 8-line paragraph)

```
old:
src/__tests__/message-router-full.test.ts` test in the
`describe('runMessageRouterTick')` block renamed to
`'reads session existence directly from the pre-pass cache (no ?? fallback)'`
on 2026-08-18 (commit 8209fb3). It now asserts
`expect(H.sessionExistsOnHost).toHaveBeenCalledTimes(1)` -- correct
pinning of the cache-only path, but does NOT cover the new
`if (!cached)` warn branch.

new:
`src/__tests__/message-router-full.test.ts:1191` is the
`describe('runMessageRouterTick')` pinning test whose label still reads
`'falls back to a direct sessionExistsOnHost when the receiver is not
in the cache'`. The label was renamed once (2026-08-18, 8209fb3) to
`'reads session existence directly from the pre-pass cache (no ?? fallback)'`
but the rename was reverted in `f67efca` after the source-side option (a)
it documented (`eb9b951`) was itself reverted in `2ec1c99`. The test BODY
(lines 1192-1219) remains the canonical pinning test for the cache-wins
path: the mock makes `sessionExistsOnHost` return absent on the first
call and present on subsequent calls, then the assertion that
`sendPromptToSession` is NOT called and `logWarn` fires with the "target
session not running, will retry" payload confirms the cache always wins.
The body is correct under either label; the gap between label intent and
actual source state is preserved here as the historical record.
```

### Commit 2 — `test(hook-path-guard): opt out of forbid-system-calls via vi.importActual`

ONE test file edit. Per-file `vi.mock` overrides the setupFile's global forbid (verified: same pattern is used in 8+ existing test files; `forbid-system-calls.ts:43-46` explicitly documents this escape hatch).

**2.1** `src/__tests__/hook-path-guard.test.ts` — insert after current line 24 (the `agent-scaffold` import), before the `// ---...` separator on current line 26

```ts
// Global forbid-system-calls setupFile (vitest.config.ts) blanket-forbids
// node:child_process across the suite. This file's pinning tests in
// describe blocks (c) and (d) actually run real `python3 scripts/boot-hook-prune.py`
// and real `spawnSync('bash', ['-c', ...])` -- the test logic depends on
// observing real exit codes. The simplest zero-behavior-change opt-out is
// `vi.importActual`, which restores the real child_process module for this
// file only. Per-test-file mock wins over the global forbid.
vi.mock('node:child_process', async () =&gt; {
  return await vi.importActual&lt;typeof import('node:child_process')&gt;('node:child_process')
})
```

Insertion-point note: current line 23 is blank; the agent-scaffold import is on line 24. The Plan agent's reference of "line 23" is off-by-1 but the insertion point itself is correct. Vitest 4.1.10 hoists `vi.mock` to top regardless.

## Files modified

| File | Edit type | Commit |
|---|---|---|
| `docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md` | 1 line footer (line 115) | 1 |
| `docs/needs-to-be-fix/message-router-dead-defensive-branches.md` | 1 sentence append (line 185) | 1 |
| `docs/needs-to-be-fix/INDEX.md` | 1 phrase in row 131 | 1 |
| `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` | 8-line paragraph rewrite (lines 82-89) | 1 |
| `src/__tests__/hook-path-guard.test.ts` | 1 block insert (after line 24) | 2 |

## Explicitly skipped

- **New `docs/needs-to-be-fix/forbid-system-calls-setup.md`** — `src/__tests__/setup/forbid-system-calls.ts:1-52` already has a comprehensive header documenting env-vars, script-wiring, and the real-world warning (added in `ee0b974`). Adding a separate MD duplicates the info; per Honcho memory "Phase 1 defaults to ONE MD, not minimum 2" and "Surgical changes — leave pre-existing style issues untouched."
- **INDEX.md Total-count bump (177→178→179)** — pre-existing drift in this repo, not introduced by this batch. Per "clean up only your own mess" rule, leave alone. If the next batch edits INDEX.md anyway, the fixer can include the drift fix then.
- **`src/__tests__/message-router-full.test.ts:1191` label rename** — body is correct under either label; the new pinning-test paragraph (1.4) documents the gap as historical record. Zero behavior change either way.

## Verification

Run after both commits land, in order:

1. **Pre-flight** (in detached worktree `/tmp/claw-batch-next`, with `node_modules` symlinked from main checkout):
   - `git worktree add --detach /tmp/claw-batch-next test/baseline`
   - `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-batch-next/node_modules`

2. **Sanity check the failing tests now pass:**
   - `cd /tmp/claw-batch-next && bun --bun vitest run src/__tests__/hook-path-guard.test.ts --reporter=verbose 2>&1 | tail -25`
   - Expect: 18/18 PASS (was 12/18 under default deny-list, with 6 failures citing `node:child_process.execFileSync/spawnSync forbidden...`)

3. **Default deny-list run** (forbid-system-calls still ON):
   - `bun run test -- src/__tests__/hook-path-guard.test.ts`
   - Expect: same 18/18 PASS (per-file vi.mock survives under global forbid)

4. **Integration run** (forbid-system-calls CHILD_PROCESS permitted):
   - `bun run test:integration -- src/__tests__/hook-path-guard.test.ts`
   - Expect: same 18/18 PASS

5. **MD diff sanity:**
   - `git diff test/baseline^..test/baseline -- docs/needs-to-be-fix/`
   - Verify: 4 files changed, all line counts match plan above, no accidental edits elsewhere

6. **Code review** (user runs in terminal — agent cannot invoke `/code-review`):
   - `/code-review max --fix b0c6eb6c..HEAD` (or whatever the post-batch range is)
   - If findings: fix and amend-allowed (no, forbidden per Honcho — commit fix separately)

## Execution plan (workflow-driven)

Single workflow script, dispatched after this plan is approved:

```text
Phase 1: Setup
  - Create detached worktree at /tmp/claw-batch-next from test/baseline
  - Symlink node_modules
  - Capture SHA of HEAD as starting ref

Phase 2: Commit 1 (docs only -- zero risk, single agent)
  - Read each MD file at the exact line cited above
  - Apply 4 edits via Edit tool (old_string / new_string as above)
  - git diff check (must show only 4 files)
  - git add + commit with message "docs(message-router): reconcile post-revert MDs -- 4 edits"

Phase 3: Commit 2 (test fix -- one agent with isolation:worktree for safety)
  - Apply edit 2.1 (vi.mock insertion in hook-path-guard.test.ts)
  - bun --bun vitest run src/__tests__/hook-path-guard.test.ts --reporter=verbose
  - If PASS: git add + commit "test(hook-path-guard): opt out of forbid-system-calls via vi.importActual"
  - If FAIL: stop, surface the failure to user, do not commit

Phase 4: Cherry-pick to test/baseline (NOT git reset --hard -- Honcho memory rule)
  - From /Users/eggp/marveen-develop/test-baseline, cherry-pick both commits
  - git log --oneline -5 to verify

Phase 5: Report
  - Output: commit SHAs, vitest summary, /code-review reminder
```

## What could still go wrong

1. **vi.importActual hoist compatibility.** Vitest 4.1.10 + bun 1.3.14 support `async () =&gt; await vi.importActual(...)` inside `vi.mock` factories (used 8+ times in codebase: `web-command-task.test.ts:90`, `web-agent-bundle.test.ts:91`, `parked-input-escalation.test.ts:30`, `schedule-runner-full.test.ts:381`). If the runtime version differs, the fix would fail at module-load time. Pre-flight check: `cat package.json | jq '.devDependencies.vitest'` and `bun --version`.
2. **python3 / bash missing on the runner.** Confirmed present on macOS (host) at `/usr/bin/python3` and `/bin/bash`. CI on Alpine might lack `python3` — pre-existing, not introduced.
3. **INDEX.md row 131 drift if another commit lands between plan approval and execution.** Mitigated: read INDEX.md immediately before edit; if separator has moved, recompute insertion point.
4. **MD line-number drift if another commit lands between plan approval and execution.** Mitigated: read each MD line 115/185/82-89 immediately before edit; if line has shifted, search by content + apply edit.
5. **`/code-review max --fix` finds an unexpected finding.** Honcho memory: amend is forbidden, commit the fix separately. The MD-only commit 1 has zero risk surface; the test-fix commit 2 has the test surface (18 tests already verify it).

## Critical files referenced

- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-unreachable-defensive-branches.md`
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-dead-defensive-branches.md`
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md`
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md`
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/hook-path-guard.test.ts`
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/setup/forbid-system-calls.ts` (read-only reference)
- `/Users/eggp/marveen-develop/test-baseline/src/web/message-router.ts` (lines 481-483 read-only reference)
