# Cycle 58: docs-only partial close of `test-suite-forbid-incomplete-coverage`

## Context

The 16 per-file `forbid-system-calls` opt-in commits landed 2026-08-27 (committed by user / agent across the previous cycle), reducing the vitest `forbid-system-calls`-driven fail count from 93 (across 20 files) to 19 (across 4 pre-existing-drift files). The remaining 19 fails are documented as 4 separate CAT-D MDs (`email-send-gate-pre-existing-drift`, `governance-gates-pre-existing-drift`, `hook-command-quoting-pre-existing-drift`, `hook-path-guard-pre-existing-drift`), all filed in `c9840e5` together with the test-suite-forbid Partial close.

`docs/needs-to-be-fix/test-suite-forbid-incomplete-coverage.md` does NOT yet reflect this state:
- The `## Resolution` section at line 159-163 still says `Open. The full per-file opt-in or the test-scope split is deferred to the next cycle.`
- The 16 opt-in commit SHAs are referenced as "see 16 SHAs in the MD" but the SHAs are NOT listed in the body.
- The `## Empirical record` section (line 137-158) does NOT have an entry for the 2026-08-27 batch.

The low.md row (low.md:26) is already correct: `Open — partial: 74 of 93 fails fixed via 16 per-file opt-in commits; remaining 19 pre-existing fails filed as separate items`. The README filter recipe and total count (`183`) are already correct.

The user picked the **Pure docs sync** option from the cycle-planning AskUserQuestion (no source code edits, no vitest re-runs beyond a single verification pass). The goal is to bring the MD body in line with reality, list the 16 SHAs, and make the partial close auditable without needing to re-derive it from git log.

## Goals

1. Update `test-suite-forbid-incomplete-coverage.md` so it accurately documents the 2026-08-27 partial close:
   - Add a `## Resolution (Partial, 2026-08-27)` section with the 16 SHAs in a compact bullet list, the fail delta (93 → 19 across 4 files, 74 net removed), and a cross-reference to the 4 CAT-D MDs.
   - Update the existing `## Resolution` section at line 159-163 from "Open" to a one-line cross-reference to the new Resolution section (so the historical context is preserved at the bottom, but the "live" status is at the top per the cycle-49 onward convention).
   - Add a 2026-08-27 entry to the `## Empirical record` section.
   - Update the `low.md` row text ONLY if needed (the row text already says "Partial" correctly; no edit expected — re-verify).
   - Do NOT modify the §3 table (the 20-row table is the canonical source of per-file fail counts at the pre-fix baseline and remains accurate).

2. Verify the docs-only cycle has zero source-code impact:
   - `bunx tsc --noEmit | wc -l` unchanged (2281 lines).
   - No source files modified.
   - All 16 opt-in files still pass `bun --bun vitest run <file>` (smoke check).
   - All 4 CAT-D files still fail with their documented counts (3+3+6+7=19).

3. Document the verification evidence in a new `## Verification (cycle 58)` section inside the MD.

## Files to modify

- `docs/needs-to-be-fix/test-suite-forbid-incomplete-coverage.md` — add Resolution (Partial) section + Empirical record entry + Verification section. ~3 commits worth of content.
- `docs/needs-to-be-fix/low.md` — only if the row text for `test-suite-forbid-incomplete-coverage` does not already say "Partial". Re-verify before editing; expected no-op.

No other docs/needs-to-be-fix files require changes. The 4 CAT-D MDs (`email-send-gate-pre-existing-drift.md`, `governance-gates-pre-existing-drift.md`, `hook-command-quoting-pre-existing-drift.md`, `hook-path-guard-pre-existing-drift.md`) already have correct `## Resolution` sections pointing to "Open, deferred to the next cycle" — leaving them open is correct since they are still failing tests.

## The 16 opt-in SHAs (verified via `git log --grep="opt out of forbid-system-calls"`)

| File | SHA | Pattern |
| --- | --- | --- |
| `agent-bundle.test.ts` | `64385ab` | `vi.importActual('node:child_process')` |
| `bridge-enroll.test.ts` | `6d5f7e7` | `vi.importActual('node:child_process')` |
| `channel-coordinator-liveness.test.ts` | `1c45480` | `vi.spyOn(process, 'kill').mockImplementation(...)` |
| `channel-inbound-tee.test.ts` | `a022de5` | `vi.importActual('node:child_process')` |
| `channels-reap-scope.test.ts` | `aa833eb` | `vi.importActual('node:child_process')` |
| `installer-apt-lock-set-e.test.ts` | `c295a7c` | `vi.importActual('node:child_process')` |
| `installer-service-auth-gate.test.ts` | `26d2ee1` | `vi.importActual('node:child_process')` |
| `installer-start-and-fallback.test.ts` | `16f77e2` | `vi.importActual('node:child_process')` |
| `managed-settings.test.ts` | `cbc7d14` | `vi.importActual('node:child_process')` |
| `memory-boundary.test.ts` | `a28c544` | `vi.importActual('node:child_process')` |
| `package-syntax-check.test.ts` | `70cb8b4` | `vi.importActual('node:child_process')` |
| `port-chain-no-hardcode.test.ts` | `a691f10` | `vi.importActual('node:child_process')` |
| `routes-updates.test.ts` | `a16d054` | `vi.spyOn(process, 'kill').mockImplementation(...)` |
| `skill-index.test.ts` | `58fc51d` | `vi.importActual('node:child_process')` |
| `staleness-guard.test.ts` | `8856374` | `vi.importActual('node:child_process')` |
| `update-checker-branch.test.ts` | `af5cb7d` | `vi.importActual('node:child_process')` |

**Sum of pre-fix fail counts** for these 16 files (from the MD §3 table): `7+1+1+1+4+3+9+13+4+4+3+8+2+10+2+2 = 74`. Matches the "74 removed" delta exactly. **Pre-existing CAT-D 4 files**: `email-send-gate 3 + governance-gates 3 + hook-command-quoting 6 + hook-path-guard 7 = 19`. Total 93.

Note: `hook-path-guard.test.ts` ALSO has an opt-in commit (`2a28a54`, 2026-08-24 15:14), but the empirical measurement at `4ed3519` shows 7 tests still fail — the `vi.importActual` mock at L33-35 does NOT restore the runtime shape the tests need (real `python3` script exec + spawn). `2a28a54` is therefore counted among the 16 above but is also flagged in the `hook-path-guard-pre-existing-drift.md` MD as the relevant commit for the residual failures.

## Plan structure (use Workflow tool, 5 phases)

### Phase 1: Explore / measure (1 Explore agent + manual Bash)

Single Explore agent (medium breadth, see cycle-53 retrospective for plan-mode restrictions):
- Read `docs/needs-to-be-fix/test-suite-forbid-incomplete-coverage.md` end-to-end and list the §3 table fail counts.
- Read `docs/needs-to-be-fix/low.md` line 26 row text and confirm "Partial" wording.
- Verify the 16 SHAs above by running `git log --format='%H %s' -1 <sha>` and confirming each SHA maps to its test file.

Manual Bash (in plan mode only — restricted to read-only):
- `bun --bun vitest run <each of the 16 opt-in files>` — confirm 0 fails per file.
- `bun --bun vitest run <each of the 4 CAT-D files>` — confirm fail counts: 3, 3, 6, 7.
- Total fails: 19 across 4 files (matches MD claim).
- Total tests across the gate: confirm vitest summary reports the 16 pass + 4 fail distribution.

**Worktree prep** (per CLAUDE.md §8 worktree rule): if `ls store/` shows `store/claudeclaw.db` or any live-install marker, the `assert-not-live-install.ts` guard will block the suite. If blocked, create a clean worktree via `git worktree add --detach /tmp/claw-test-58 test/baseline` and `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-test-58/node_modules`, then run vitest from there.

### Phase 2: Plan agent (1 agent)

Single Plan agent (general-purpose, NOT worktree-isolated — plan agent reads only):
- Inputs: 16 SHAs from Phase 1, fail-count delta, low.md row text.
- Output: a per-edit specification:
  - Where to insert `## Resolution (Partial, 2026-08-27)` section (suggested: between line 137 `## Empirical record` end and the existing `## Resolution` section at line 159).
  - Exact 16-SHA bullet list (single-column, compact).
  - Exact text for the cross-reference in the existing `## Resolution` section: "Superseded by `## Resolution (Partial, 2026-08-27)` above — 16 of 20 opt-in commits landed; remaining 4 are pre-existing drift, filed as separate CAT-D MDs."
  - Exact `## Empirical record` 2026-08-27 entry: bullets matching the 16 commits + the 4 CAT-D filings.
  - Exact `## Verification (cycle 58)` section content (verifier outputs from Phase 1).

### Phase 3: Implementer (worktree-isolated)

Single general-purpose agent with `isolation: 'worktree'`. The agent applies the Plan agent's per-edit specification to `test-suite-forbid-incomplete-coverage.md` (and `low.md` if needed). After edits:
- `git diff --stat` to confirm only `*.md` files changed, no source files.
- Em-dash sweep via `python3 -c "import pathlib; print(sum(pathlib.Path('docs/needs-to-be-fix/test-suite-forbid-incomplete-coverage.md').read_text().count(chr(0x2014))))"` (must print `0`).
- Commit with `docs(test-suite-forbid-incomplete-coverage): partial close — list 16 opt-in SHAs + cycle 58 verification`.
- Push: NOT ALLOWED. Print the commit SHA at end.

### Phase 4: Two verifiers (Agent tool, per CLAUDE.md §8 dispatch rule)

**ALPHA verifier** (checklist angle, Agent tool, sequential — do NOT use Workflow `parallel()` since the worktree-isolation case is sensitive):
- Prompt: "Read `docs/needs-to-be-fix/test-suite-forbid-incomplete-coverage.md` end-to-end. Verify the following 7 facts against the actual file content + git log. Output PASS/FAIL per fact with line numbers + quoted evidence."
  1. The 16 SHAs in the new Resolution section are real commits (each verifiable via `git show --no-patch --format='%H %s' <sha>`).
  2. Each SHA maps to the test file claimed in the table.
  3. The sum 7+1+1+1+4+3+9+13+4+4+3+8+2+10+2+2 = 74 is asserted in the MD and matches the §3 table.
  4. The cross-reference "remaining 4 are pre-existing drift, filed as separate CAT-D MDs" points to the 4 correct file names.
  5. The new `## Verification (cycle 58)` section asserts 0 em-dash.
  6. `low.md` line 26 row text already says "Partial" — no edit was made (or was made correctly).
  7. `git diff` shows ONLY `docs/needs-to-be-fix/*.md` changes, no source files.

**BETA verifier** (adversarial falsification angle, Agent tool, sequential):
- Prompt: "You are an adversarial verifier. Your job is to FALSIFY the cycle 58 docs-only partial close. Try to break it. Specifically: (a) invent any way the docs could be wrong even if the checklist passes (e.g., a SHA that looks right but maps to a different test file); (b) read the vitest output from Phase 1 and check whether the fail counts actually match the MD claim (3+3+6+7=19) — invent your own subset to verify; (c) cross-check that the 4 CAT-D MDs each have their own correct Resolution section pointing to 'pre-existing, deferred'; (d) check whether ANY other docs file (medium.md, high.md, baseline-unreachable.md, orphan.md, README.md) needs an update that this cycle missed. Default to FALSIFIED if uncertain. Report PASS only when no falsification found."

**Re-measure rule** (per CLAUDE.md §8 MD age rule): test-suite-forbid MD was last modified in `98bf20b` (2026-08-27 11:10). Phase 1's vitest runs are newer than the MD, so re-measurement is already part of the cycle.

### Phase 5: Merge back + /code-review

Per CLAUDE.md §8: implementer is worktree-isolated on a detached HEAD, so the parent context (this main session) must merge the commit back. Procedure:
- Verify working tree clean: `git status` (no output).
- Verify fast-forward: `git merge-base test/baseline <sha>` must equal `git rev-parse test/baseline` (the SHA is a descendant).
- `git merge --ff-only <sha>`.
- Cleanup: `git worktree remove /tmp/claw-test-58 --force` (if used in Phase 1).
- Run `git status` and `git log --oneline -3` to confirm.

After the docs-only commits are on `test/baseline`:
- **Document for the user** that `/code-review max --fix` must be invoked manually (per CLAUDE.md §8: skill is `disable-model-invocation`, only user can invoke).
- After user's `/code-review max --fix`, immediately check `git status` per cycle-56 retrospective rule. If code-review applied uncommitted edits, commit them with `fix(docs): /code-review follow-ups on <sha>` format.

## Verification (success criteria)

The cycle is successful when ALL of the following hold:

1. `test-suite-forbid-incomplete-coverage.md` has:
   - A `## Resolution (Partial, 2026-08-27)` section listing all 16 SHAs with per-file mapping.
   - A `## Empirical record` entry for 2026-08-27 matching the §3 sums (74 from 16, 19 from 4 CAT-D, total 93).
   - A `## Verification (cycle 58)` section with vitest output evidence.
   - 0 em-dash characters.
2. `low.md` row 26 text unchanged (already correct "Partial" wording).
3. `git diff test/baseline..HEAD` shows only `docs/needs-to-be-fix/*.md` changes (and possibly the `*.output` worktree metadata, but no source files).
4. `bunx tsc --noEmit | wc -l` still reports 2281 (unchanged from baseline measurement taken at plan start).
5. Both verifier subagents output PASS / SHIP.
6. `/code-review max --fix` (user-invoked) finds 0 actionable findings OR all findings are addressed.

## Risks and mitigations

- **Risk**: Verifier A finds the wrong SHA-test-file mapping for one or more of the 16 commits. **Mitigation**: Phase 1 explicitly maps each SHA to its test file; Plan agent must re-verify before commit.
- **Risk**: Phase 1 vitest measurement disagrees with the MD's pre-fix counts. **Mitigation**: re-read the §3 table against actual vitest output; if mismatch, file a separate docs drift item rather than silently fixing it (cycle-52 retrospective rule).
- **Risk**: A source file accidentally modified by the implementer. **Mitigation**: Phase 3 ends with `git diff --stat` enforcing only `*.md` changes; if any source file appears, the commit is rejected before merge.
- **Risk**: User finds the "Partial" wording insufficient and wants "Closed". **Mitigation**: the cycle is explicitly partial-close; the 4 CAT-D MDs document the residual failures. If user wants Closed, that's a separate cycle.

## Out of scope

- Fixing the 4 CAT-D source-code drift items (3+3+6+7=19 failing tests). These are deferred per the user's AskUserQuestion selection of "Pure docs sync (ajánlott)".
- Closing the 4 CAT-D MDs. They remain Open with their existing Resolution sections until a future cycle addresses them.
- Updating the `routes-agents-br-baseline-partial-coverage` and `routes-updates-release-lock-unreachable-defensive-branch` MDs — both are already Resolved in `baseline-unreachable.md` with correct Resolution sections, nothing to do.
- Updating `web-agent-worker-runviaworker-coverage.md` and `web-inbound-probe-respawn-grace.md` — both have Resolution sections and are already marked Resolved in `baseline-unreachable.md`.
- Closing `keychain-store-insecure-acl.md` further — it's already Closed by design (`596d2e2`); `-A` removal is an operator-side decision per the existing Resolution section.