# Docs-Only Reconciliation Cycle: 3 stale needs-to-be-fix MDs + optional CLAUDE.md rule + 3 optional new MDs

## Context

The needs-to-be-fix backlog is 99.4% resolved (177 of 178 MDs closed). The single genuinely-open MD is `keychain-store-insecure-acl.md`, whose recommended fix (`-T SECURITY`) was empirically tested in `b28e951` and reverted in `94650ef` (2026-08-26) — but the MD text still recommends it, contradicting post-revert reality.

A drift audit of the 6 most-recently-closed MDs surfaced **2 additional stale docs**:
- `web-agent-scaffold-defensive-coverage.md` (HIGH severity) — claims L602 has a defensive ternary capping coverage at 99.63%, but `642b883` replaced it with `(settings.hooks ?? {})` on the same day the MD was closed; branch coverage is 100% per `642b883` commit message
- `index-unreachable-coverage.md` (MEDIUM severity) — no `## Resolution` section in body despite INDEX marking Resolved; line refs (L283, L382) drifted after `642b883` follow-up

A separate `__test_*` export safety audit found 9 `__test_*` exports (6 from `f75caf6`, 1 from `cf85135`, 2 in `recall.ts`) — all YELLOW/GREEN, no production cross-module imports, but 3 candidates (`workerPaneHasAuthFailure`, `seedWorkerCredentials`, `matchChannelRoute`) could become new `__test_*` rename MDs.

**Goal:** a single docs-only commit that brings 3 stale MDs into sync with current source, leaving the codebase behaviorally unchanged. Optional 2nd commit adds CLAUDE.md §8 rule + 3 new MDs filing.

**Intended outcome:** every MD cited in this cycle's commit points to source that still exists at the cited line; every "100%" or "Resolved" claim is honest; the test pin text matches what the test file actually says.

---

## Recommended approach

### Single batch commit

**Commit A** (mandatory): `docs(needs-to-be-fix): reconcile 3 docs-only drift items`

Three MD edits in one commit, following the `5986d9d` precedent (batch MD drift reconciliation pattern).

| File | Edit | Source of truth |
|---|---|---|
| `docs/needs-to-be-fix/keychain-store-insecure-acl.md` | (4A) Insert new "Second attempted fix and reason for revert" section between current line 107 and `## Path to a real fix`; (4B) Refresh "Path to a real fix" — mark step 2 as "empirically tested and reverted", promote step 3 to "only viable path"; (4C) Rewrite "Suggested direction" — remove `-T SECURITY` recommendation, re-cast as larger architectural decisions (try/catch + user-facing error, OR launchd bootstrap-after-keychain-unlock, OR SecAccessControl native binding); (4D) Update "Pinning test" to post-`a5e2318` test name (`passes -A, the flag security(1) itself calls insecure`) + trailing note | `b28e951`, `94650ef`, `a5e2318`, `6e5bdd7` |
| `docs/needs-to-be-fix/web-agent-scaffold-defensive-coverage.md` | Back-annotate `## Resolution (2026-08-26, 642b883)`; replace L602 excerpt from the old ternary shape to `(settings.hooks ?? {}) as Record<string, unknown>`; replace 99.63% / 1-branch figures with 100% / 0-branch (verbatim from `642b883` commit message — NO `bun run coverage` re-run because `.gitignore:98-99` blocks it per CLAUDE.md §8); collapse "Suggested direction" because option 1 was applied | `642b883` |
| `docs/needs-to-be-fix/index-unreachable-coverage.md` | Back-annotate `## Resolution (2026-08-21, a330462)` with INDEX row 21's "line 174 already covered by index.test.ts:2739-2796" verbatim; record the `642b883` follow-up which wired `stopHeartbeat()` into `shutdown()` (L383); refresh line refs L283→L286, L382→L383; mark the third site from "structurally unreachable" to "reachable; pinned by index.test.ts:1116-1135, 1142-1148, 2592-2609" | `a330462`, `642b883` |

**Optional refinement inside Commit A**: `INDEX.md` row 76 (`keychain-store-insecure-acl`) — append ` — second attempt reverted (94650ef)` after `Deferred to next cycle`. No SHA self-reference, no `(this commit)` placeholder needed.

**Out of scope (separate docs/index follow-up per precedent)**: INDEX.md row 76 file:line drift (`src/web/keychain.ts:19` → `:32`).

### Optional Commit B (only if user signals go)

**Commit B**: `docs(CLAUDE.md + 3 new MDs): document __test_* convention and 3 rename candidates`

- `docs(CLAUDE.md §8)`: insert new bullet "`__test_*` exports are test-only by convention. Production code MUST NOT import them across module boundaries; same-module calls are accepted only when the helper is gated and the call sites are enumerated in the commit message." Precedent: `cf85135` ("Production caller count: 1"), `f75caf6`.
- 3 new MDs (filing only, no implementation):
  - `docs/needs-to-be-fix/web-agent-worker-auth-recovery-helpers-untestable.md` — covers `src/web/agent-worker.ts:216` (`workerPaneHasAuthFailure`) and `:207` (`seedWorkerCredentials`)
  - `docs/needs-to-be-fix/routes-agents-matchChannelRoute-untestable.md` — covers `src/web/routes/agents.ts:239` (`matchChannelRoute`, 3-branch regex dispatch with 6 same-module callers)

Channel-coordinator `processBatch` / `runLoop` candidates are **excluded** — coverage is already 100%, MD would be zero-gain churn.

### Why single batch over separate commits

`5986d9d` (the previous batch MD reconciliation) established the project's pattern: 3 docs-only MDs in one commit, single search finds the cycle, single revert drops all three. Splitting over-fragments without review benefit.

---

## Execution: 5-phase Workflow tool

Per user request: "Végrehajtáshoz workflow -t használj!". Workflow tool `script` parameter orchestrates the 5 phases. Within Phase 3, the 2 verifiers run as parallel `agent()` calls inside the script (the script is ≤100 lines so parser brittleness from 2026-08-24 won't recur).

### Phase 1: baseline check (sequential, blocking)

1. `git status --short` → must be empty
2. `ls store/` → must be empty (else route to `/tmp/claw-test` worktree per CLAUDE.md §8)
3. `ls coverage/ coverage-temp/` → must be empty (delete if not, `.gitignore`d)
4. `bun --bun vitest run src/__tests__/keychain.test.ts src/__tests__/agent-scaffold-full.test.ts src/__tests__/index.test.ts src/__tests__/agent-worker.test.ts --reporter=basic 2>&1 | tee coverage-temp/baseline-<date>.log | tail -30` — capture pass/fail counts. If >5 fails: halt, surface comparison to `a330462` baseline worktree per CLAUDE.md §8.

### Phase 2: implement (sequential, blocking)

One commit with the 3 MD edits in this order (largest first, for human-readable attribution):
1. `docs/needs-to-be-fix/keychain-store-insecure-acl.md` — 4 edits (4A insert, 4B refresh, 4C rewrite, 4D update)
2. `docs/needs-to-be-fix/web-agent-scaffold-defensive-coverage.md` — back-annotate Resolution
3. `docs/needs-to-be-fix/index-unreachable-coverage.md` — back-annotate Resolution

Each edit uses the EXACT diff text from Phase-1 Explore agents (see Critical files). No source/test edits.

Commit message draft (mimics `5986d9d`):

```
docs(needs-to-be-fix): reconcile 3 docs-only drift items

- keychain-store-insecure-acl.md: record the second -T SECURITY attempt
  (b28e951) and its revert (94650ef), rewrite Path-to-a-real-fix step 2
  and Suggested direction step 1 accordingly, refresh Pinning test text
  to the post-a5e2318 test name and trailing note. -A must stay until
  keychainStore surfaces the prompt as a user-facing error or the
  daemon launches after login keychain is unlocked.

- web-agent-scaffold-defensive-coverage.md: back-annotate Resolution
  (2026-08-26, 642b883) -- line 602 defensive ternary was replaced with
  (settings.hooks ?? {}) as Record<string, unknown>; branch coverage
  reached 100%. Refresh the L602 excerpt and collapse Suggested direction
  (option 1 applied). Coverage numbers preserved verbatim from the
  642b883 commit message per CLAUDE.md §8 (no bun run coverage re-run).

- index-unreachable-coverage.md: back-annotate Resolution (2026-08-21,
  a330462) -- line 174 is covered by index.test.ts:2739-2796 (per
  closure commit). Record the 642b883 follow-up which wired
  stopHeartbeat() into shutdown() and turned the third site from
  "structurally unreachable" to "reachable; pinned by
  index.test.ts:1116-1135, 1142-1148, 2592-2609". Refresh line refs:
  L283 -> L286, L382 -> L383.

No src/ changes. No new files. Zero em-dash.

Refs: b28e951, 94650ef, a5e2318, 642b883, a330462, 6e5bdd7.
```

**No `(this commit)` placeholder** — every cited SHA is historical, not self-referential.

### Phase 3: dual verify (parallel)

Workflow script: `parallel([alpha_check, beta_falsify])`.

**ALPHA — structural PASS/FAIL checklist verifier**

Per-MD checklist with concrete assertions:
1. keychain MD: contains `## Second attempted fix and reason for revert` section, references `b28e951`, `94650ef`, `a5e2318` (or post-`a5e2318` test text); "Path to a real fix" no longer names `-T SECURITY` as recommended step 1; "Suggested direction" no longer contains `-T SECURITY` code block as recommendation; "Pinning test" uses post-`a5e2318` test name
2. scaffold MD: contains `## Resolution (2026-08-26, 642b883)`; L602 excerpt matches current source `?? {}` form (NOT old ternary); coverage numbers reflect 100% (verbatim from `642b883`); "Suggested direction" collapsed
3. index-unreachable MD: contains `## Resolution (2026-08-21, a330462)`; L283→L286, L382→L383 line refs refreshed; `642b883` follow-up recorded
4. Cross-MD: no MD cites a non-existent SHA; no MD claims a line number `Read` of the cited file contradicts; no em-dash anywhere in the 3 MDs or commit message (`rg -n '\xE2\x80\x94'` returns no results); INDEX.md count line invariant

ALPHA returns: PASS/FAIL per assertion + file:line evidence.

**BETA — adversarial falsifier**

Active attacks to break each claim:
1. keychain MD: `Read src/web/keychain.ts:25-34` and `git show b28e951:src/web/keychain.ts`. Confirm the "previous state" claim is genuinely the prior state, not paraphrasing. Re-Read `src/__tests__/keychain.test.ts:295-324` independently. `git log --all -- src/web/keychain.ts | grep -E '\-T'` to confirm no third attempt was missed
2. scaffold MD: `Read src/web/agent-scaffold.ts:602` independently. `git log -- src/web/agent-scaffold.ts | head -20` to confirm no post-`642b883` follow-up reverted that edit
3. index-unreachable MD: `Read src/index.ts` (L170-180, L280-290, L378-390). `git log --oneline 642b883..HEAD -- src/index.ts` for any post-`642b883` source edits that invalidate the narrative
4. Cross-cutting: `git grep -nF 'passes -A' src/__tests__/`; `git grep -nF '(settings.hooks ?? {})' src/web/agent-scaffold.ts`; `git grep -nF 'stopHeartbeat()' src/index.ts`. Run targeted vitest subset in BETA's isolated worktree: `bun --bun vitest run src/__tests__/keychain.test.ts src/__tests__/agent-scaffold-full.test.ts src/__tests__/index.test.ts src/__tests__/agent-worker.test.ts --reporter=basic`
5. **BETA's unique angle**: re-Read the full keychain MD file end-to-end to confirm the Scope note (2026-08-25) and Sources block are still intact after the edits (Honcho #38 precedent: a single verifier would never have caught a deleted option enumeration leaving orphan references)

BETA returns: PASS/DRIFT per attack + vitest pass count. If vitest >5 fails, BETA halts and falls into the `a330462` baseline-comparison branch per CLAUDE.md §8.

### Phase 4: docs sync / wrap (sequential)

If ALPHA or BETA flagged drift in INDEX.md (e.g. the optional keychain `— second attempt reverted` refinement caused an INDEX row mismatch): do a `docs(index): correct SHA reference for the 3 reconciled MDs` follow-up commit. If verifiers clean, no follow-up.

Capture final SHA: `git log -1 --format='%H %s'` on `test/baseline`.

### Phase 5: code-review hand-off (terminal, user-invoked)

Workflow does NOT call `/code-review` itself — `disable-model-invocation` per CLAUDE.md §8. Workflow ends with message: "Cycle complete on `test/baseline` at `<new SHA>`. Per CLAUDE.md §8, `/code-review max --fix` is user-invoked; please run it in your terminal to apply any final corrections."

---

## Critical files

- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/keychain-store-insecure-acl.md` (198 lines, 4 edits)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/web-agent-scaffold-defensive-coverage.md` (back-annotate)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/index-unreachable-coverage.md` (back-annotate)
- `/Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md` (row 76 optional refinement)
- `/Users/eggp/marveen-develop/test-baseline/src/web/keychain.ts` (read-only verification, lines 25-34)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/keychain.test.ts` (read-only verification, lines 295-324)
- `/Users/eggp/marveen-develop/test-baseline/src/web/agent-scaffold.ts` (read-only verification, line 602)
- `/Users/eggp/marveen-develop/test-baseline/src/index.ts` (read-only verification, lines 174, 286, 383)
- `/Users/eggp/marveen-develop/test-baseline/.claude/CLAUDE.md` (optional Commit B insertion)

The Phase-1 Explore agents pre-specified the EXACT diff text for each edit — the executor should copy-paste those diffs, not re-derive.

---

## Verification

**End-to-end test:** after Commit A lands, the cycle is complete if and only if:
- `git status` clean, single new commit on `test/baseline`
- `git log -1` shows the commit message verbatim (no em-dash, all SHAs verbatim)
- `git cat-file -t b28e951 94650ef a5e2318 642b883 a330462 6e5bdd7` returns `commit` for each
- `rg -n '\xE2\x80\x94' docs/needs-to-be-fix/keychain-store-insecure-acl.md docs/needs-to-be-fix/web-agent-scaffold-defensive-coverage.md docs/needs-to-be-fix/index-unreachable-coverage.md` returns no results
- `Read src/web/keychain.ts:25-34` still shows `-A` (post-`94650ef` state preserved)
- `Read src/web/agent-scaffold.ts:602` shows `(settings.hooks ?? {}) as Record<string, unknown>` (post-`642b883` state preserved)
- `Read src/index.ts:286` shows `error:` log call (matches MD L283→L286 refresh)
- `Read src/index.ts:383` shows `try { stopHeartbeat() } catch (err) { logger.warn(...) }` (matches MD L382→L383 refresh)
- ALPHA verifier returned PASS for all assertions
- BETA verifier returned PASS for all attacks, vitest subset reports baseline pass count (no new failures)
- User confirms cycle complete and runs `/code-review max --fix`

**Pre-release gate:** NONE of the 3 MDs claims a coverage number that can be re-verified (`.gitignore` blocks `bun run coverage` artifacts per CLAUDE.md §8). The cycle is docs-only; coverage gate is not in scope.

**Code-review (user-invoked):** after Workflow Phase 5, user runs `/code-review max --fix` in their terminal. Code-review may surface additional drift (e.g. INDEX.md file:line cells, off-by-N in MD excerpts) which becomes a follow-up commit.

---

## Risk + reversibility

| Commit | Files | Lines | Risk | Reversibility |
|---|---|---|---|---|
| Commit A | 3 MD files + optional 1 INDEX.md cell | ~80 lines added across 3 MDs | **NONE** — docs-only | `git revert <SHA>` on `test/baseline`. Single-commit revert drops all 3 edits cleanly. |
| Commit B (optional) | 1 CLAUDE.md bullet + 3 new MD files | ~8 + ~150 lines | **NONE** — docs-only | `git revert <SHA>`, then `rm` the 3 MD files. |

**Zero source/test risk.** No runtime behavior changes. No test pin moves. No coverage gate impact.

**Documentation drift risk: LOW.** Both verifiers empirically check cited SHAs and line numbers. If any SHA fails `git cat-file -t`, ALPHA flags DRIFT.

**Em-dash risk: LOW but explicit.** The commit message uses ASCII hyphens. The MD rewrites avoid em-dash (the existing 3 MDs have 0 em-dashes — preserved as-is).

---

## Branch handling

- All work on `test/baseline` (current HEAD `3d6a476`)
- No worktree creation for the main executor (`/Users/eggp/marveen-develop/test-baseline` is on `test/baseline` and is clean)
- Verifier isolation: `git worktree add --detach /tmp/claw-verify-alpha test/baseline` and `/tmp/claw-verify-beta` for the 2 verifiers. After both finish, `git worktree remove /tmp/claw-verify-{alpha,beta} --force`
- **No `git push`** anywhere (CLAUDE.md §6)
