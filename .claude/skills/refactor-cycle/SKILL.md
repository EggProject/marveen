---
name: refactor-cycle
description: Execute one item from docs/refactor-to-classbase (or a similarly pre-planned refactor backlog) end to end, from picking the lowest-risk item through implementation, double verification, code review and docs reconciliation. Use when the user asks to work through a documented refactor backlog item, or says "csináljuk meg a legkisebb kockázatú átalakítást". Trigger on "/refactor-cycle".
---

# Refactor cycle

One documented backlog item, landed with the gates intact and the docs left true.
This skill is the sequence and the cycle-specific traps only. The general rules live
in `.claude/CLAUDE.md` and are not repeated here; §7 and §8 still bind.

## When to use

- The user points at a refactor backlog (`docs/refactor-to-classbase/`, a needs-to-be-fix MD set)
  and asks for the next item, or for the lowest-risk one.
- Applies to `E.3`-`E.6` and the `A`/`B`/`C`/`F`/`G` subsystems of the classbase migration.

## When NOT to use

- Ad-hoc refactors with no planning document. There is no doc to reconcile and no
  risk ranking to read, so most of this skill is dead weight.
- Bug fixes. Use the ordinary write-a-failing-test-first flow.

## Procedure

### 1. Pick the item, and distrust the doc that ranks them

The backlog's own summary usually names its lowest-risk items. Verify each candidate
before trusting the ranking:

- Is it already done? `git log --oneline <main>..HEAD` and grep the target file for
  the classes/symbols the doc says are missing.
- Does the doc contradict itself? Check whether the same item appears on a
  "no conversion" list elsewhere in the same file.
- Do the named symbols exist? `grep -n '<symbol>' <file>` for every function the doc
  says will be converted.

Precedent 2026-08-30: of the three "lowest-risk wins" in `00-summary.md`, #1 was already
landed, and #3 named a function (`dailyPhaseAtMs`) that does not exist (real name
`dailyDueAtMs`). Only #2 was actionable.

### 2. Measure every gate BEFORE writing the plan

Non-negotiable (CLAUDE.md §8). Record the exact numbers; the plan says "hold at N",
never "keep it clean":

```bash
ls store/                                    # must not exist / be empty, else make a $HOME worktree
bun --bun vitest run                         # test file count + test count
bun run coverage                             # exit code; this is the CI gate
bun tsc --noEmit 2>&1 | grep -cE '^[^ ].*\(([0-9]+),([0-9]+)\): error TS'
bun run lint                                 # total problem count
```

The tsc and lint numbers are typically large and pre-existing. They are differential
gates: the number must not grow.

### 3. Discuss the choice with the user before planning

Use AskUserQuestion. Two decisions are almost always live:

- **which item**, with the measured risk of each, and
- **how far to go**: class + delegation wrappers only (blast radius stays inside one
  file), or also migrate the call sites (pulls in the consumer's test file).

The wrapper-only form is what makes these cycles cheap. Say so.

### 4. Write the plan, then have two forks attack it

The plan must contain, for each new test, the **concrete assertion with its expected
value**, not the intent. "Covers the default branch" is unreviewable;
`expect(sleptFor[0]).toBe(1500)` is. See the vacuous-test bullet in CLAUDE.md §8.

Two plan reviewers, different angles (CLAUDE.md §8): one structured fact-checker that
re-derives every file:line and every number, one adversarial reviewer that hunts for
what will surprise you during execution. Fix what they find before presenting.

Know the limit: plan review catches authoring-time defects. It is structurally unable
to catch defects in the eventual output, because the output does not exist yet.

### 5. Implement via Workflow

One implementer working directly in the current worktree on the current branch, so the
commit lands where it belongs and no merge-back is needed. Then two verifiers in
prepared worktrees.

Have the implementer create both verifier worktrees as its last step, from the commit
SHA it just made. Doing it in one place avoids a git index race between two agents:

```bash
git worktree add --detach $HOME/claw-verify-a <SHA>
ln -sf <repo>/node_modules $HOME/claw-verify-a/node_modules
```

`$HOME`, never `/tmp` (CLAUDE.md §8). Separate worktrees also stop two concurrent
vitest runs from tripping each other's `store/` guard.

### 6. Check the commit author

`git log -1 --format='%an <%ae> | %cn <%ce>'` against `git config user.email`.
Subagents override git identity. Stop and ask the user if it differs; the fix is a
history rewrite and needs explicit permission.

### 7. Hand off to /code-review

`/code-review max --fix` cannot be invoked from the model side. Tell the user to run it,
with the range: `/code-review max --fix <base>..HEAD`.

Expect it to find things the verifiers did not, especially in new tests. Commit its
fixes immediately, without asking again.

### 8. Reconcile the docs LAST, in one commit

Doing this before the review guarantees rework: the review changes test counts, which
changes the numbers you just wrote. Batch it:

- mark the item landed, with the SHA
- record every deliberate deviation from the spec and why
- re-measure and correct any number the doc states about the code
- correct measured errors you found in step 1

Re-measure at write time. Do not copy numbers from your own plan.

## Traps this cycle keeps hitting

| Trap | Guard |
|---|---|
| Two files with the same basename (`00-summary.md` at the root and per-subsystem) | Always write the full path in the plan |
| A doc line count that the refactor itself invalidates | Qualify it: "364 lines (pre-E.1/E.2)" |
| Inline SHAs going dangling after any later rewrite | Track how many you wrote; `grep -rn '<old-sha>' docs/` after a rewrite |
| Default `= {}` on both wrapper and method | Default on the method only; wrapper takes `opts?:` |
| A new method keeping a `ctx` parameter it could read from `this` | Drop the parameter |
| New tests whose fixtures make the assertion unfalsifiable | Step 4's concrete-assertion rule |

## Verification

The cycle is done when, measured flag-free at HEAD:

- `bun run coverage` exits 0 and the target file is at 100% on all four metrics
- test and file counts equal the baseline plus exactly the tests you added
- tsc and lint have not grown
- `git diff <SHA>~1 <SHA> -- <files the plan promised not to touch>` is empty
- both verifiers PASS and `/code-review` findings are fixed and committed
- no doc states a number that a re-measurement contradicts
