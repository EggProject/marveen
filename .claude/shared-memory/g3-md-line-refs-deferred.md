# G.3 LivenessTracker docs sweep — file:line references deferred

## Context

The G.3 LivenessTracker refactor landed at `refactor/classbase` HEAD `2213cb2`
on 2026-09-13. The workflow produced 4 commits:

- `1265fd0` — `docs(refactor-to-classbase): mark G.3 LivenessTracker LANDED`
- `5f466b8` — `refactor(channel-coordinator): extract LivenessTracker class with module-singleton shim (G.3)`
- `8392729` — `fix(test): remove stale L109-111 line reference from liveness-tracker test`
- `2213cb2` — `fix(liveness-tracker): clean up post-refactor review findings` (from `/code-review max --fix`)

## Skipped finding from `/code-review max --fix`

The `/code-review max --fix` skill flagged HIGH severity and SKIPPED:

> **64 L<n> line refs added across 9 MD files** in
> `docs/refactor-to-classbase/g-channel-coordinator/`. The diff is a
> comprehensive G.3 LANDED doc rewrite that uses line refs everywhere
> (e.g., `L323+L324`, `L27-91`, `L312`).

Per CLAUDE.md §7, file:line references are BANNED in MDs:

> "**Fájl sorszám-hivatkozások TILOSAK MD-kben**, tervekben, refactor-tervekben,
> commit message-ekben és kód kommentekben."

The G.3 docs commit added 64 new line refs and removed 74 pre-existing ones
(net -10). The total ban makes the 64 additions a violation regardless of
the net count.

The skill skipped the finding because the fix scope (94 total line refs to
rewrite across 9 files) exceeded the `--fix` auto-apply threshold and was
deemed "out-of-diff range" per CLAUDE.md §3 ("Touch only what you must.
Clean up only your own mess.").

## Deferred range

`1265fd0..2213cb2` — covers the docs LANDED commit plus the post-review
code commit. A subsequent sweep commit should cover this range.

## Remediation plan (next session / next commit)

A dedicated docs sweep commit should:

1. Identify all line refs in the 9 MD files: `L\d+`, `\d+-\d+` patterns,
   `<file>:<line>` patterns. Expected count: ~94 total (64 new + ~30
   pre-existing).
2. For each, replace with one of:
   - Section heading reference (e.g., `§G3`, `§GR2`, `§§runLoop`)
   - Function or symbol name (e.g., `LivenessTracker.setStopping`,
     `LivenessTracker.yieldToIdle`, `installSignalHandlers`)
   - Comment-section heading inside the source file (e.g.,
     `// --- main loop (IDLE <-> BACKFILLING state machine) ---`)
   - Symbolic reference (e.g., "the four mutable lets",
     "the downStreak read in the runLoop idle-detection branch")
3. Verify with: `grep -nE 'L[0-9]+|:[0-9]+` docs/refactor-to-classbase/g-channel-coordinator/`
   must return zero matches.
4. Preserve any line refs that appear in UNTOUCHED context (e.g., pre-existing
   refs from the original spec) — per CLAUDE.md §3 surgical-changes rule.
   The sweep applies only to line refs INTRODUCED by the G.3 docs commit.
5. Single commit: `docs(refactor-to-classbase): remove file:line references
   from G.3 LANDED MDs`.
6. Author preserved (EggProjectTeams).

## Memory dual-write

This file is the local-file half of the dual-write per CLAUDE.md §7
"Memory dual-write szabály". The Honcho half is the
`create_conclusion` invocation from the G.3 session that flagged this
finding. If Honcho retrieval fails in a future session, this file is
the persistent project-local record.

## Related work

- The G.3 plan file: `.claude/plans/tranquil-coalescing-spring.md` — also
  contains the corrected structural regex pattern (the GNU-format regex
  was BSD-broken, deferred for a future MD-revision sweep).
- The G.2 IngestWorker (`fda697d`) docs were already drifting before G.3 —
  the cumulative drift makes a docs-wide cleanup valuable beyond just
  the G.3 scope.