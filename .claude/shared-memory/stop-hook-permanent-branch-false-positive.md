# Stop hook false-positive — flags `develop` branch as leftover

## Symptom

The Stop hook (`$CLAUDE_PROJECT_DIR/.claude/hooks/stop-guard/hook.ts`) fires
with the message:

> "Leftover session-created worktrees or branches detected:
>   - branch: develop"

…even when no worktree was created by the session and the `develop` branch
is untouched at the same commit it was on at session start.

## Why it's a false positive

The `.claude/rules/worktree-cleanup.md` rule explicitly lists `develop`
as permanent:

1. The "Permanent set (soha ne töröld)" section names it directly:
   > "Bármilyen más branch, ami NEM mergelt a `refactor/classbase`-ba
   > (production branchek, mint `main`, `develop`, stb.)"

2. The `PERMANENT_PRODUCTION_BRANCHES` constant lists it:
   > `PERMANENT_PRODUCTION_BRANCHES = {develop, feature/develop, test/baseline, main}`

3. The Stop hook implementation note says:
   > "A SessionStart és Stop hook a `refactor/classbase`-ot kihagyja a
   > branch-listából (mint permanent anchor), a többi permanent branch
   > szintén a fehérlistán van."

But the actual hook filter logic only excludes `refactor/classbase`:

> "Branch filter: `git branch --merged refactor/classbase` minus
> `PERMANENT_PRODUCTION_BRANCHES = {develop, feature/develop, test/baseline, main}`"

(quoted from the rule — the filter SHOULD subtract the permanent set but
the actual hook code may not do so.)

## Why this matters

The hook is a mechanical enforcement gate (CLAUDE.md §8 "structural fix"
from the 2026-09-09 deep retrospective). When it fires spuriously, the
session mainloop has three choices:

1. **Honor the hook**: delete the flagged branch. **WRONG** if the branch
   is permanent (would destroy user-protected state).
2. **Override the hook**: ignore the flag. **RISKY** if a real leak is
   actually present (the hook exists for a reason — see
   `worktree-cleanup-rule.md` for the precedent chain).
3. **Investigate**: distinguish true positive from false positive.

The investigation pattern:

```sh
git worktree list           # any session-created worktrees?
git branch --merged refactor/classbase
                            # which merged branches are flagged?
git log <branch> --oneline -3
                            # is the branch at the same commit as
                            # session start? (yes = permanent, no = leak)
```

If the branch is at the same commit as session start AND it's named in
the rule's permanent set (`develop`, `feature-develop`, `main`, etc.),
it's a false positive. Skip the deletion.

If the branch tip moved during the session OR it's not in the permanent
set, it's a true positive. Delete it.

## Observed in the wild

The `develop` branch and `feature-develop` branch point to the SAME
commit (`f5402ca` in the 2026-09-12 cycle). `develop` is merged into
`refactor/classbase` (an ancestor of f5e231c..96d90c7). The branch was
untouched at session start and end. The hook fired anyway.

The Stop hook's `git branch --merged refactor/classbase` lists:
```
  develop
+ feature-develop
* refactor/classbase
  test/baseline
```

The `+` prefix on `feature-develop` means it's checked out in another
worktree (the `marveen` checkout). The hook may be excluding checked-out
branches but not excluding the permanent set.

## Recommended fix (separate task)

The hook implementation in
`.claude/hooks/stop-guard/core.ts` needs the `PERMANENT_PRODUCTION_BRANCHES`
filter applied to `git branch --merged refactor/classbase` output before
flagging. The constant exists in the rule file but apparently isn't
imported by the hook code.

This is NOT a session-blocking fix — sessions can continue with the
manual "skip the false-positive flag" pattern. But it's a real hook
correctness issue that should be addressed in a future session.

## Related precedents

- The 2026-09-09 deep retrospective (wf_4afcc1d7-0c6) added the Stop
  hook worktree-leftover guard as a mechanical gate. The intent was
  sound; the implementation has gaps.
- The `worktree-cleanup-rule.md` always-loaded rule file documents the
  cleanup protocol but doesn't mention the hook's false-positive on
  `develop`. This entry fills that gap.