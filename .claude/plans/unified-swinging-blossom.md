# E.5 — `process-lock` free-function removal

> Plan branch: `refactor/classbase`
> Plan file location: `.claude/plans/unified-swinging-blossom.md`
> Date drafted: 2026-09-04
> Drafter: Claude (Opus-class) + 2 Plan-agent verifiers (checklist + falsification)

---

## Context

`docs/refactor-to-classbase/e-process-lock/` describes a 6-step migration that turns
the free-function `acquirePortLock` / `acquirePidfileLock` surface into class-based
acquirers. E.1–E.4 are already landed:

- `57c78d0` — E.1+E.2 introduced `PortLockAcquirer` and `PidfileLockAcquirer` alongside the
  5 free-function wrappers.
- `22684fd` — E.3 migrated `src/index.ts:341` (`acquirePortLock`) to `new PortLockAcquirer(procCtx).acquire(WEB_PORT, …)`.
- `30509d4` — E.4 migrated `src/index.ts:348` (`acquirePidfileLock` + `releaseLock`) to `new PidfileLockAcquirer(...)`.

Production is fully migrated. What remains is **E.5**: delete the 5 free-function wrappers
and migrate the test files. After E.5, the only public surface for these functions is
the two classes (`PortLockAcquirer`, `PidfileLockAcquirer`).

**Why now:** per `class-vs-functional-decision.md` the classes are justified (instance
state via `this.ctx` + constructor DI). The free-function wrappers are the textbook
"class-without-added-value" anti-pattern (rule L50, L57). E.5 closes that ceremony.
The risk surface is small — the production caller is already migrated, and the only
remaining changes are inside `process-lock.test.ts` (mechanical rewrite of 44 call sites)
and 3 surgical sites inside `index.test.ts` (factory entry + two `withReal*` helpers).

---

## Goals and non-goals

**Goal:** after this plan lands, `src/process-lock.ts` exports only the two classes,
the two interfaces, `DeferToPeerError`, `writeBufferFully`, and the 5 type aliases.
No `export function acquirePortLock` / `acquirePidfileLock` / `findOwnNodeHolders` /
`findOwnBinaryMatches` / `terminateProcesses` survives.

**Non-goal:** E.6 (LogFn removal — gated on H.1+H.2). E.6 is its own plan, requires
LoggerLike interface work that is not on the table yet.

**Non-goal:** changing the class API surface (`Method args`, return types, etc.).
E.5 is a pure deletion; no behavior change.

---

## Files in scope

| File | Change |
|---|---|
| `src/process-lock.ts` (413 lines → ~390) | Delete 5 wrappers + the L201–203 wrapper comment |
| `src/__tests__/process-lock.test.ts` (818 lines) | Rewrite import block + 44 free-function call sites to class form |
| `src/__tests__/index.test.ts` (2920 lines) | Delete L223 factory entry; rewrite `withRealAcquirePidfileLock` (L1348–1362) + `withRealAcquirePortLock` (L1396–1406) |
| `docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md` | Mark E.5 LANDED; fix the L285–286 wording about `releaseLock()` (see Falsifier F7.5) |

## Files explicitly NOT touched

- `src/index.ts` (already migrated at L350 + L357)
- `src/__tests__/process-lock-classes.test.ts` (already class-form; the `findOwnNodeHolders.length === 1` pin at L105 is preserved)
- `src/logger.ts` (no LoggerLike yet — H.1 work, not needed for E.5)

---

## Execution strategy — subagent roster

Per CLAUDE.md §8, vitest must run in `$HOME/claw-*` worktree (NOT `/tmp/`) because
`_TMP_PREFIXES` rejects `/tmp/` paths in `src/web/agent-scaffold.ts:144`. Per Honcho
memory, the `Agent({isolation: 'worktree'})` option drops worktrees in
`.claude/worktrees/`, which fails the same guard — so **every subagent gets its worktree
via bash**: `git worktree add --detach $HOME/<name> <branch>`.

The plan runs as a 6-phase Workflow (`/workflows`):

| Phase | Subagent type | Isolation | Output | Verifier |
|---|---|---|---|---|
| 0. Baseline measurement | (none — direct Bash) | n/a | baseline commit SHA + test/tsc numbers | n/a |
| 1. Pre-flight | (none — direct Bash + Read) | n/a | precondition PASS/FAIL | n/a |
| 2. E.5a implementation | `coder` | bash worktree `$HOME/claw-e5a` | E.5a commit on `refactor/classbase` | 2 verifiers (phase 3) |
| 3. E.5a double verification | `reviewer` × 2 | bash worktree `$HOME/claw-e5a-verify-{a,b}` | 2 PASS/FAIL reports | barrier before phase 4 |
| 4. E.5b implementation | `coder` | bash worktree `$HOME/claw-e5b` | E.5b commit on `refactor/classbase` | 2 verifiers (phase 5) |
| 5. E.5b double verification | `reviewer` × 2 | bash worktree `$HOME/claw-e5b-verify-{a,b}` | 2 PASS/FAIL reports | barrier before phase 6 |
| 6. Docs reconciliation | `instructions` | bash worktree `$HOME/claw-e5-docs` | 1 docs commit on `refactor/classbase` | (handled by phase 7 gate) |
| 7. Final gate + cleanup | (none — direct Bash) | n/a | cleaned-up `node_modules` symlinks, worktrees removed | `/code-review max --fix` (user-triggered) |

**Why 2 verifiers per implementation phase:** per CLAUDE.md §8, two identical
checklists would miss the same thing. The verifier split is **checklist (PASS/FAIL
per claim, with file:line evidence)** vs **falsification (adversarial search for
hidden breakage)** — the two angles complement, not duplicate, each other.

**Why the docs phase is its own subagent (`instructions`):** docs reconciliation
is not code — the `instructions` agent type owns CLAUDE.md / SKILL.md / MD updates
per its tier definition.

**Why no `engineer`:** the change is spec-driven (every call-site rewrite is
mechanical, every helper rewrite is line-cited), not inventive. `coder` is the right
tier per its definition ("Spec-driven coding where the change is already described:
known files, known approach, plus the tests that cover it").

**Why no `Plan` agent in the execution phase:** planning is done in this document.
Re-entering Plan would be ceremony.

**Worktree-isolation rule (every subagent prompt):** "Create your worktree with
`git worktree add --detach $HOME/<path> <branch>` (NOT `/tmp/`). Symlink node_modules
from the main checkout: `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules
$HOME/<path>/node_modules`. Run vitest from there. Do NOT commit inside the worktree;
the orchestrator merges via `git merge --ff-only` after the verifier barrier."

---

## Phase 0 — Baseline measurement (orchestrator only)

**Subagent:** none. Direct Bash from the main session.

```
1. `git rev-parse HEAD` → record as BASELINE_SHA
2. `bun tsc --noEmit` → record exit code + error count (must be 0)
3. `cd $HOME/claw-baseline && git worktree add --detach $HOME/claw-baseline BASELINE_SHA`
   `ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-baseline/node_modules`
   `cd $HOME/claw-baseline && bun --bun vitest run --reporter=basic 2>&1 | tail -5`
   → record pass/fail counts
4. `grep -rln 'acquirePortLock\|acquirePidfileLock\|findOwnNodeHolders\|findOwnBinaryMatches\|terminateProcesses' src/ --include='*.ts' | grep -v __tests__`
   → must return exactly: `src/process-lock.ts`
5. `git config user.email` → record for post-commit identity check (per CLAUDE.md §8 rule "verify author")
```

**Gate to pass:** all 5 measurements return numbers (no errors). Record them in the
E.5a commit message as "(was N before this commit)".

---

## Phase 1 — Pre-flight (orchestrator only)

**Subagent:** none.

**Preconditions** (from `05-refactor-roadmap.md` L424–433 + Falsifier F5):

| # | Precondition | How to verify | Status |
|---|---|---|---|
| 1 | E.1, E.2, E.3, E.4 landed on `refactor/classbase` | `git log --oneline -10 --grep="E\."` shows `57c78d0`, `22684fd`, `30509d4` | expected ✅ |
| 2 | `src/index.ts` uses class form at the two call sites | `grep -nE 'new PortLockAcquirer\|new PidfileLockAcquirer' src/index.ts` returns L350 + L357 | expected ✅ |
| 3 | `src/__tests__/process-lock-classes.test.ts` covers the class API | `grep -cE 'new PortLockAcquirer\|new PidfileLockAcquirer' src/__tests__/process-lock-classes.test.ts` ≥ 6 | expected ✅ |
| 4 | Mechanical gate holds (only `process-lock.ts` matches the free-function grep) | from Phase 0 step 4 | expected ✅ |
| 5 | Full suite green before E.5 starts | from Phase 0 step 3 | expected ✅ (re-measure; previous baseline may be stale) |

**Gate to pass:** all 5 rows ✅. If any fails, STOP and surface to the user.

---

## Phase 2 — E.5a implementation (subagent: `coder`)

**Subagent prompt (verbatim, NO backticks — use single quotes per Honcho memory):**

```
You are implementing E.5a of the refactor-to-classbase backlog. Your task is the
DELETION of the 4 port-lock free-function wrappers from src/process-lock.ts and the
mechanical rewrite of all port-lock call sites in the test files.

WORKTREE: Create with 'git worktree add --detach $HOME/claw-e5a refactor/classbase'.
Then 'ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-e5a/node_modules'.
Run all commands from $HOME/claw-e5a. Do NOT push, do NOT commit anywhere except
your own detached HEAD.

DO NOT TOUCH:
- src/process-lock.ts lines 411-413 (acquirePidfileLock wrapper — that's E.5b)
- src/__tests__/process-lock.test.ts imports or call sites that reference acquirePidfileLock
- src/__tests__/index.test.ts L1348-1362 (withRealAcquirePidfileLock — that's E.5b)
- src/index.ts (already migrated)

CHANGES TO MAKE (all on detached HEAD, single commit):

1. src/process-lock.ts — DELETE these ranges:
   - L201-203 (the 3-line 'Free-function wrappers:' comment)
   - L205-207 (findOwnNodeHolders)
   - L209-211 (findOwnBinaryMatches)
   - L213-215 (terminateProcesses)
   - L217-219 (acquirePortLock)
   DO NOT TOUCH L411-413.

2. src/__tests__/process-lock.test.ts — REWRITE imports at L2-12:
   - REMOVE imports for findOwnNodeHolders, findOwnBinaryMatches, terminateProcesses,
     acquirePortLock (but KEEP acquirePidfileLock — that's E.5b)
   - ADD PortLockAcquirer
   Then REWRITE the 31 call sites that are NOT acquirePidfileLock:
   - 9 findOwnNodeHolders sites at L89, 98, 107, 118, 127, 132, 140, 148, 162
     -> 'new PortLockAcquirer(ctx).findOwnNodeHolders(port)'
   - 3 findOwnBinaryMatches sites at L173, 182, 190
     -> 'new PortLockAcquirer(ctx).findOwnBinaryMatches(re)'
   - 9 terminateProcesses sites at L197, 206, 224, 244, 255, 266, 289, 310, 325
     -> 'new PortLockAcquirer(ctx).terminateProcesses(pids, opts)'
   - 10 acquirePortLock sites at L336, 345, 354, 363, 372, 383, 393, 415, 431, 452
     -> 'new PortLockAcquirer(<ctx-or-liveOnly-or-stickyPort>).acquire(port, opts)'

3. src/__tests__/index.test.ts — REWRITE the withRealAcquirePortLock helper at
   L1396-1406. Today the body delegates to 'actual.acquirePortLock(port, ctx, opts)'.
   After E.5a, change to:
     'const { PortLockAcquirer } = await vi.importActual(...)'
     'return new PortLockAcquirer(ctx as never).acquire(port, mergedOpts as never)'
   KEEP all other index.test.ts code unchanged (the withRealAcquirePidfileLock
   helper at L1348-1362 and the L223 factory entry are E.5b).

VERIFICATION YOU MUST RUN BEFORE COMMITTING:
- 'bun tsc --noEmit' from $HOME/claw-e5a — must exit 0
- 'bun --bun vitest run' from $HOME/claw-e5a — must be green; capture pass/fail count
- 'grep -rln "acquirePortLock\|findOwnNodeHolders\|findOwnBinaryMatches\|terminateProcesses" src/ --include="*.ts" | grep -v __tests__' — must return ZERO lines (post-deletion)
- 'grep -nE "\b(acquirePortLock|findOwnNodeHolders|findOwnBinaryMatches|terminateProcesses)\b" src/__tests__/process-lock.test.ts' — must return ZERO lines
- 'grep -nE "\bacquirePortLock\b" src/__tests__/index.test.ts' — must return ZERO lines (L1403 was inside the rewritten helper)

OUTPUT:
- 1 commit on your detached HEAD
- report the commit SHA, the test pass count, and confirm all 5 verification greps return zero where expected
- DO NOT merge to refactor/classbase — the orchestrator handles that

RULES:
- Strict generics: no 'as' (use 'satisfies'), no 'any' (use 'unknown')
- No string concatenation — use template literals
- No em-dash in commit messages or comments
- Do NOT push; the orchestrator handles local-only workflow
- Match existing style: the per-call inline 'new PortLockAcquirer(ctx).acquire(...)' style; do not hoist a 'const acquirer = ...' unless matching an existing pattern in the file
```

---

## Phase 3 — E.5a double verification (subagents: `reviewer` × 2)

**Two parallel reviewers with DIFFERENT angles.** Both read-only.

**Verifier A — checklist angle** (prompt):

```
You are the CHECKLIST VERIFIER for E.5a. Read-only.

Set up a fresh worktree:
  'git worktree add --detach $HOME/claw-e5a-verify-a refactor/classbase'
  'ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-e5a-verify-a/node_modules'

Verify each claim below against the actual code; cite file:line evidence.
Mark each as PASS / FAIL / NOT-APPLICABLE.

CLAIMS:
1. src/process-lock.ts L201-219 (4 wrappers + comment) are deleted.
2. src/process-lock.ts L411-413 (acquirePidfileLock) is INTACT (untouched).
3. src/__tests__/process-lock.test.ts imports no longer reference findOwnNodeHolders,
   findOwnBinaryMatches, terminateProcesses, acquirePortLock.
4. src/__tests__/process-lock.test.ts now imports PortLockAcquirer.
5. Each of the 31 port-lock call sites listed in the plan was rewritten to
   'new PortLockAcquirer(ctx-or-liveOnly-or-stickyPort).<method>(...)' form.
6. src/__tests__/process-lock.test.ts still imports and calls acquirePidfileLock
   (E.5b work is deferred).
7. src/__tests__/index.test.ts L1396-1406 (withRealAcquirePortLock) now constructs
   'new PortLockAcquirer(ctx)' instead of calling 'actual.acquirePortLock(...)'.
8. src/__tests__/index.test.ts L1348-1362 (withRealAcquirePidfileLock) is INTACT.
9. src/__tests__/index.test.ts L223 factory entry 'acquirePidfileLock: mockAcquirePidfileLock'
   is INTACT (E.5b work).
10. src/index.ts is INTACT (no changes in this commit).
11. Run 'bun tsc --noEmit' from $HOME/claw-e5a-verify-a — must exit 0.
12. Run 'bun --bun vitest run' from $HOME/claw-e5a-verify-a — capture pass count;
    compare against the pre-E.5 baseline from Phase 0. Delta must be 0.
13. 'grep -rln "acquirePortLock\|findOwnNodeHolders\|findOwnBinaryMatches\|terminateProcesses"
    src/ --include="*.ts" | grep -v __tests__' returns ZERO lines.
14. 'grep -nE "\b(acquirePortLock|findOwnNodeHolders|findOwnBinaryMatches|terminateProcesses)\b"
    src/__tests__/process-lock.test.ts' returns ZERO lines.
15. Commit message format: starts with 'refactor(process-lock):' or similar, no
    em-dash, mentions E.5a, no force-push intent.

Output a Markdown report with one row per claim. End with OVERALL: PASS or FAIL.
```

**Verifier B — falsification angle** (prompt):

```
You are the ADVERSARIAL FALSIFIER for E.5a. Read-only. Try to BREAK the claim
that E.5a is correct.

Set up a fresh worktree:
  'git worktree add --detach $HOME/claw-e5a-verify-b refactor/classbase'
  'ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-e5a-verify-b/node_modules'

Your job: surface ANY defect. Try to find:

F1. HIDDEN CONSUMERS:
  - grep for each deleted function name across the ENTIRE repo (not just src/)
  - check for dynamic imports, vi.doMock/vi.spyOn, string-identifier plugin loading
  - check that no 'export * from './process-lock.js'' re-export exists that would
    propagate the deletion

F2. SEMANTIC SHIFT:
  - Pick one of the 31 rewritten call sites and verify the new 'new PortLockAcquirer(ctx).acquire(port)'
    is behaviorally IDENTICAL to the old 'acquirePortLock(port, ctx)'. Check:
    * does the class acquire() handle the same opts (graceMs, postKillDrainMs,
      postKillPollMs, binaryPattern)?
    * does the withRealAcquirePortLock helper now miss any opts that the old
      free function accepted?
  - Check the comment at src/process-lock.ts L309-312 (which says 'Mirrors the
      releaseLock() body at src/index.ts:359-366') — is it still accurate post-E.5a?

F3. SIDED EFFECTS:
  - Is there any test that depends on the FREE FUNCTION NAME existing as an
    importable symbol (e.g. 'expect(acquirePortLock).toBeDefined()')?
  - Is there any test that uses 'vi.mocked(acquirePortLock)' (which would dangle)?
  - Are there ANY error-message string assertions that pin to log messages
    emitted only by the free-function code path?

F4. COMMIT IDENTITY:
  - 'git log -1 --format="%an <%ae>"' for the E.5a commit — compare against the
    main git config user.email. If they differ, FLAG IT (the orchestrator must
    decide whether to rewrite or revert).

F5. DOCUMENTATION DRIFT:
  - 'docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md' does NOT
    need to be updated in this phase (that's Phase 6). But flag any reference
    that would become actively misleading the moment the commit lands (e.g.
    comments saying 'the wrappers are still here for legacy callers').

For each finding, give: file:line, what breaks, severity (BLOCKER / DOC / NIT).
If you find nothing, say VERIFIED CLEAN and explain what grep/read you ran.
```

**Barrier:** both verifiers must return OVERALL: PASS (verifier A) and
no BLOCKER finding (verifier B) before Phase 4 can start. If either fails,
the orchestrator surfaces the report to the user; no auto-retry.

**Post-verifier merge:** if both pass, orchestrator runs `git merge --ff-only <E.5a-SHA>`
from the main checkout. The detached HEAD commit becomes the new
`refactor/classbase` tip. Then `git worktree remove $HOME/claw-e5a --force`.

---

## Phase 4 — E.5b implementation (subagent: `coder`)

**Subagent prompt structure:** identical to Phase 2, but with the pidfile scope:

```
WORKTREE: 'git worktree add --detach $HOME/claw-e5b refactor/classbase'
          'ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules $HOME/claw-e5b/node_modules'

DO NOT TOUCH:
- src/process-lock.ts lines 201-219 (already deleted by E.5a)
- src/__tests__/process-lock.test.ts imports or call sites that reference
  the 4 port-lock names (already rewritten by E.5a)

CHANGES:
1. src/process-lock.ts — DELETE L411-413 (acquirePidfileLock wrapper).

2. src/__tests__/process-lock.test.ts — REMOVE acquirePidfileLock from imports
   at L7; ADD PidfileLockAcquirer to imports. REWRITE 13 call sites at
   L536, 546, 558, 573, 583, 609, 624, 638, 648, 679, 690, 715, 731:
     'acquirePidfileLock(path, selfPid, ctx, opts)' -> 'new PidfileLockAcquirer(ctx).acquire(path, selfPid, opts)'
   (Note: L609 and L679 use 'await expect(acquirePidfileLock(...)).rejects.toThrow(...)';
    the wrapper goes inside expect(...) — rewrite the inner call.)

3. src/__tests__/index.test.ts — TWO surgical fixes:
   a. DELETE L223 'acquirePidfileLock: mockAcquirePidfileLock' from the factory
      return shape.
   b. REWRITE withRealAcquirePidfileLock at L1348-1362. Today delegates to
      'actual.acquirePidfileLock(path, selfPid, ctx, opts)'. After E.5b:
        'const { PidfileLockAcquirer } = await vi.importActual(...)'
        'return new PidfileLockAcquirer(ctx as never).acquire(path, selfPid, mergedOpts as never)'
   ALSO update the comment at L1388-1395 (it talks about 'real acquirePortLock'
   and the post-E.5a file structure has changed).

VERIFICATION BEFORE COMMIT:
- 'bun tsc --noEmit' from $HOME/claw-e5b — exit 0
- 'bun --bun vitest run' from $HOME/claw-e5b — green, capture pass count
- 'grep -rln "acquirePidfileLock" src/ --include="*.ts" | grep -v __tests__' — ZERO lines
- 'grep -nE "\bacquirePidfileLock\b" src/__tests__/index.test.ts' — ZERO lines
- 'grep -nE "\bacquirePidfileLock\b" src/__tests__/process-lock.test.ts' — ZERO lines

OUTPUT: 1 commit on detached HEAD, report SHA + pass count + grep results.
```

---

## Phase 5 — E.5b double verification (subagents: `reviewer` × 2)

Same structure as Phase 3 but targeting E.5b. Verifier A checks 15 claims
(parallel to Phase 3 list); Verifier B runs the 5-section falsification
adversarially. Barrier identical: both PASS + no BLOCKER before Phase 6.

---

## Phase 6 — Docs reconciliation (subagent: `instructions`)

**Subagent prompt:**

```
You are reconciling docs after E.5a + E.5b land on refactor/classbase.

WORKTREE: 'git worktree add --detach $HOME/claw-e5-docs refactor/classbase'

The two E.5 commits have:
- Removed 5 free-function wrappers (findOwnNodeHolders, findOwnBinaryMatches,
  terminateProcesses, acquirePortLock, acquirePidfileLock) from src/process-lock.ts
- Migrated 44 test call sites to class form in src/__tests__/process-lock.test.ts
- Updated the vi.mock factory and two withReal* helpers in src/__tests__/index.test.ts

YOUR TASK: update the following docs files (read-only first to verify each claim
is now stale, then write the correction):

1. docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md:
   - Mark E.5 as LANDED (analogous to how E.1/E.2/E.3/E.4 were marked).
   - Fix the L285-286 wording — per Falsifier F7.5, the 'legacy releaseLock() at
     src/index.ts:356-364' was already deleted by E.4, NOT by E.5. Rewrite to
     'E.5 removes the 5 free-function wrappers'.
   - Add the E.5a + E.5b commit SHAs (NOT inline, use a '(this commit)' placeholder
     per CLAUDE.md §8 'SHA doksi szabály'; the orchestrator adds SHAs in a follow-up).

2. docs/refactor-to-classbase/e-process-lock/00-summary.md:
   - Update the 'Status:' block to add E.5 LANDED.
   - The reference list at L7 about 'five of the six exported free functions ...
     survive as thin delegation wrappers' must be reworded: only writeBufferFully
     survives as a free function; the other 5 are deleted.

3. docs/refactor-to-classbase/e-process-lock/01-module-state-analysis.md,
   02-type-interface-analysis.md, 03-class-boundaries.md,
   review-completeness.md, review-correctness.md:
   - Any sentence that says 'the free function acquirePortLock is still exported
     as a wrapper' or 'call acquirePortLock(port, ctx) at ...' becomes stale.
     Rewrite each in past tense ('was', 'used to') or rephrase to the class form
     ('new PortLockAcquirer(ctx).acquire(port)').

4. The cross-subsystem docs that mention the deleted names:
   - docs/refactor-to-classbase/c-web/00-summary.md
   - docs/refactor-to-classbase/c-web/01-module-state-analysis.md
   - docs/refactor-to-classbase/g-channel-coordinator/review-completeness.md
   - docs/refactor-to-classbase/h-cross-cutting/05-refactor-roadmap.md
   - docs/refactor-to-classbase/f-agent-subsystem/01-module-state-analysis.md
   - docs/refactor-to-classbase/a-db/00-summary.md
   - docs/refactor-to-classbase/01-module-state-analysis.md
   - docs/refactor-to-classbase/03-class-boundaries.md
   - docs/refactor-to-classbase/06-risks-and-mitigations.md (L293 cites
     'at acquirePortLock (src/process-lock.ts:169:11)' — stale diagnostic path)
   - docs/refactor-to-classbase/review-correctness.md
   - docs/refactor-to-classbase/05-refactor-roadmap.md
   For each, replace the free-function reference with the class-form equivalent
   (or remove it if no longer relevant).

5. The 4 stale comments inside src/process-lock.ts itself (L73-76, L174, L309-312,
   L391) — rewrite or remove the 'free functions below are thin wrappers' /
   'Mirrors the releaseLock() body at src/index.ts:359-366' style sentences that
   describe the now-deleted wrappers.

VERIFICATION BEFORE COMMIT:
- 'grep -rn "free.function.*wrapper\|legacy.*acquirePortLock\|legacy.*acquirePidfileLock\|findOwnNodeHolders.*free.function" docs/ src/' — should return ZERO matches (or only the new LANDED marker text)
- No em-dash in any new comment or MD line (CLAUDE.md §6 rule)
- No new file/line citations without backing — quote each file:line you reference

OUTPUT: 1 docs commit on detached HEAD. Report SHA + verification grep results.
```

---

## Phase 7 — Final gate + cleanup (orchestrator only)

After Phase 6 lands:

```
1. Re-measure: 'bun tsc --noEmit' (clean) + 'bun --bun vitest run' (green, capture count)
2. Confirm all 5 gate greps from Phase 0 + Phase 2 + Phase 4 still hold
3. 'git worktree remove $HOME/claw-e5a $HOME/claw-e5b $HOME/claw-e5-docs
   $HOME/claw-e5a-verify-{a,b} $HOME/claw-e5b-verify-{a,b} --force'
4. Report final state to user with: 2 implementation commits + 1 docs commit
   on refactor/classbase, all tsc/vitest green, all gate greps zero.
5. HANDOFF: user runs '/code-review max --fix' (Skill tool refuses — user must
   invoke in terminal per CLAUDE.md §8).
```

---

## Verification gates (compiled)

| Gate | Command | Expected after E.5a | Expected after E.5b |
|---|---|---|---|
| TypeScript clean | `bun tsc --noEmit` | exit 0 | exit 0 |
| Vitest green | `bun --bun vitest run` | baseline count | baseline count |
| No production free-fn imports | `grep -rln 'acquirePortLock\|findOwnNodeHolders\|findOwnBinaryMatches\|terminateProcesses' src/ --include='*.ts' \| grep -v __tests__` | 0 | 0 |
| No `acquirePidfileLock` in production | `grep -rln 'acquirePidfileLock' src/ --include='*.ts' \| grep -v __tests__` | 1 (process-lock.ts) | 0 |
| No free-fn names in `process-lock.test.ts` | `grep -nE '\b(acquirePortLock\|acquirePidfileLock\|findOwnNodeHolders\|findOwnBinaryMatches\|terminateProcesses)\b' src/__tests__/process-lock.test.ts` | 0 (the 4 port-lock names) | 0 (all 5 names) |
| No free-fn names in `index.test.ts` | `grep -nE '\b(acquirePortLock\|acquirePidfileLock)\b' src/__tests__/index.test.ts` | 0 (after E.5a rewrites withRealAcquirePortLock) | 0 |
| `process-lock.ts` line count | `wc -l src/process-lock.ts` | 413 → ~394 | 394 → ~391 |
| Author identity per commit | `git log -1 --format='%an <%ae>'` | matches git config | matches git config |

---

## Risks and mitigations (from Falsifier + Checklist)

### TRUE BLOCKERS (already in the verifier prompts)
- F2.1: `process-lock.test.ts` direct calls — rewritten in Phase 2 / Phase 4
- F3.1: `withRealAcquirePidfileLock` helper — rewritten in Phase 4
- F3.2: `withRealAcquirePortLock` helper — rewritten in Phase 2

### Documented but mitigated
- **ER5** (vi.mock factory): mitigated because the factory ALREADY mocks class constructors (verified Phase 1 pre-flight). Only L223 needs deletion in E.5b.
- **ER4** (DeferToPeerError): not in E.5 scope — class survives untouched.
- **F7.5** (releaseLock roadmap wording): fixed in Phase 6.

### Class-vs-functional-decision compliance
The two classes are justified per the rule's positive-examples table (per-instance state via `this.ctx`, constructor DI). E.5 does NOT touch the class shape — only removes the wrappers. Rule check: ✅ (state + DI = 2 IGEN ≥ minimum 2).

---

## Resolved decisions (no user input required)

The Checklist-verifier surfaced 5 open questions. All are resolved below:

1. **`withRealAcquirePortLock` keep or delete?** — falsifier showed it has 3 real call sites (L2790, L2849, L2888). **Keep as rewrite** (Phase 2).
2. **`process-lock.test.ts:105` cite typo** — confirmed typo. The pin lives at `process-lock-classes.test.ts:105`. No action; the L105 in `process-lock.test.ts` is a procs-table entry, not a test pin.
3. **Inline `new PortLockAcquirer(ctx).acquire(...)` per call vs hoisted `const acquirer = ...` style?** — inline. Matches the existing `ctx` extraction pattern from `makeCtx(...)`/`makePidfileCtx(...)`; minimal diff.
4. **L223 deletion bundle (E.5a vs E.5b)?** — E.5b. Semantic alignment: L223 is the pidfile mock entry, L1348–1362 is the pidfile helper — both pidfile, both E.5b.
5. **Section E.0 baseline numbers** — re-measured in Phase 0 before each implementation commit; recorded as "(was N before this commit)" in the commit message.

---

## Critical files referenced

- `/Users/eggp/marveen-develop/test-baseline/src/process-lock.ts` (413 lines, post-E.5 target: 391)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/process-lock.test.ts` (818 lines)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/index.test.ts` (2920 lines)
- `/Users/eggp/marveen-develop/test-baseline/src/index.ts` (read-only in E.5)
- `/Users/eggp/marveen-develop/test-baseline/src/__tests__/process-lock-classes.test.ts` (read-only in E.5)
- `/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/e-process-lock/05-refactor-roadmap.md` (Phase 6 target)
- `/Users/eggp/marveen-develop/test-baseline/docs/refactor-to-classbase/e-process-lock/00-summary.md` (Phase 6 target)
- `/Users/eggp/marveen-develop/test-baseline/.claude/rules/class-vs-functional-decision.md` (rule check)
- `/Users/eggp/marveen-develop/test-baseline/.claude/CLAUDE.md` §8 (worktree path, gate measurement, author check)

---

## Open item (out of plan scope)

Per the user's CLAUDE.md §8 rule, vitest may currently fail in the local environment
with a `vite module-runner` error (observed during baseline measurement). That is NOT
introduced by E.5 — it is an environment issue (vite/tsx/bun integration). The
re-measurement in Phase 0 will reveal whether it persists. If it does, surface to
the user as a pre-existing issue and decide whether to proceed anyway (the vitest
suite can still be run via the project's CI which uses different setup) or to fix
the environment first. Decision deferred to user.