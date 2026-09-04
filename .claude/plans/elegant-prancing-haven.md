# Plan: Forgotten needs-to-be-fix close-outs + stale TODO cleanup

## Context

`docs/needs-to-be-fix/INDEX.md` tracks 177 bug MDs with the invariant
`find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l == row count`.
Two open rows have source fixes already on `test/baseline`, but INDEX row
cells and the corresponding MD `## Status` banners were never added. They
are "forgotten close-outs" — pure docs work to restore the invariant.

A third item, a stale in-code TODO at `src/web/routes/voice.ts:169-170`,
contradicts the handler below it (the handler is implemented and tested;
the TODO says "currently unused"). It is the smallest possible source
cleanup with zero behavioral risk.

The combined batch:
- 2 docs-only close-outs (zero source risk, both fixes already in HEAD)
- 1 cosmetic comment removal (zero behavioral risk, zero test risk)

All three items have been verified by two independent subagents
(`a40a976cb040e0b2a` and `a8368a3d0fb053a4d`). Every claim below is
backed by their verification output.

## Items

### A. `config-empty-env-blanks-identity` (INDEX row 22, HIGH)

- Fix commit (already on `test/baseline`): `0df13db067af4b7cc53d4360838cb11735890be5` (2026-08-19).
  Title: `fix(config): route identity constants through envOr empty-string guard (config-empty-env-blanks-identity)`.
  Files: `src/config.ts` (+20/-12), `src/__tests__/config.test.ts` (+12/-20).
- INDEX.md row 22 Resolved cell: change `—` to `Resolved: 2026-08-19 0df13db067af4b7cc53d4360838cb11735890be5`.
- MD file `docs/needs-to-be-fix/config-empty-env-blanks-identity.md`:
  insert `**Status:** RESOLVED ...` banner after the `#` title, matching
  the inline-banner template at `docs/needs-to-be-fix/multipart-boundary-greedy.md:3`.

### B. `routes-updates-release-lock-unreachable-defensive-branch` (INDEX row 177, LOW / orphan)

- Fix commit (already on `test/baseline`): `c2b4ea20f52bd8ed2efeb43c298b8b9668d1d6c3` (2026-08-14).
  Title: `refactor: drop 21 unreachable defensive branches and 6 synthetic tests`.
  The single-line `if (!lockHeld) return` deletion in `src/web/routes/updates.ts` is part of this sweep.
- INDEX.md row 177 Resolved cell: change `2026-08-14 c2b4ea2`
  to `Resolved: 2026-08-14 c2b4ea20f52bd8ed2efeb43c298b8b9668d1d6c3`
  (restyle to the `Resolved:` form used by newer rows; same semantic content).
- MD file `docs/needs-to-be-fix/routes-updates-release-lock-unreachable-defensive-branch.md`:
  insert the same inline `**Status:** RESOLVED ...` banner after the `#` title.

### C. Stale TODO cleanup in `src/web/routes/voice.ts:169-170`

The handler at lines 171-184 IS implemented and IS tested by 8 cases in
`src/__tests__/voice-routes.test.ts:814-888` — including
`persists a valid voice modality` (line 845), which asserts
`setLastInboundModality` is called. The TODO is factually stale.

- File: `src/web/routes/voice.ts`.
- Remove only lines 169-170 (the `// TODO: ...` and `// Kept for future use ...` lines).
- Keep the `// POST /api/voice/modality/set` and `// Body: ...` lines (167-168) — they are valid route docstrings.
- Zero behavioral risk: comments are stripped at parse time.
- Zero test risk: no test pins the comment text; tests assert behaviorally on the handler that survives untouched.
- Zero governance risk: no `NEVER modify src/web/routes/voice.ts` rule exists under `.claude/`.
- Out-of-scope adjacent stale comment flagged for awareness (line 8 file-header says "future plugin hook use"): NOT modified in this batch.

## Combined batch rationale

A and B are independent docs-only close-outs (different files, different bug IDs). C is an independent comment removal (a different file, no semantic overlap). Combining is safe because:
- No source file is touched by A or B.
- C touches a source file that has no `NEVER modify` rule.
- No test references any of the text being changed.
- INDEX.md invariant preserved (row count stays at 177).

## Critical files to modify

- `docs/needs-to-be-fix/INDEX.md` (2 cell-value edits on rows 22 and 177).
- `docs/needs-to-be-fix/config-empty-env-blanks-identity.md` (banner insertion after `#` title).
- `docs/needs-to-be-fix/routes-updates-release-lock-unreachable-defensive-branch.md` (banner insertion after `#` title).
- `src/web/routes/voice.ts` (delete 2 comment lines at 169-170).

No other files touched. No test changes. No `package.json`, `tsconfig.json`, or `vitest.config.ts` changes.

## Banner template

The inline `**Status:** RESOLVED ...` banner, matching
`docs/needs-to-be-fix/multipart-boundary-greedy.md:3`:

```
**Status:** RESOLVED (<one-line summary>, see commit <short-SHA> on `test/baseline`). The narrative below is kept as a historical record of the bug, not as an open task.
```

Concrete values:
- For `config-empty-env-blanks-identity.md`:
  `**Status:** RESOLVED (envOr empty-string guard routes identity constants, see commit \`0df13db\` on \`test/baseline\`). The narrative below is kept as a historical record of the bug, not as an open task.`
- For `routes-updates-release-lock-unreachable-defensive-branch.md`:
  `**Status:** RESOLVED (the \`if (!lockHeld) return\` defensive guard was deleted in the 2026-08-14 unreachable-branches sweep, see commit \`c2b4ea2\` on \`test/baseline\`). The narrative below is kept as a historical record of the bug, not as an open task.`

## Commits (matching repo convention)

Two commits, in this order, both on `test/baseline`:

1. `docs(needs-to-be-fix): mark config-empty-env-blanks-identity + routes-updates-release-lock-unreachable-defensive-branch Resolved`
   - Touches only the 3 docs files (INDEX.md + 2 MDs).
2. `chore(voice): drop stale TODO at src/web/routes/voice.ts:169-170`
   - Touches only `src/web/routes/voice.ts` (-2 lines).

The first commit message matches the precedent at `88da4fc docs(needs-to-be-fix): mark multipart-boundary-greedy + multipart-latin1-fields Resolved` (multiple bug IDs in one docs commit).

The second commit message matches the recent `chore(...)` cleanup wave observed in the history.

Both commits stay local — no push (per `.claude/CLAUDE.md` "Tilos pusholni").

## Failure points (what could go wrong, mitigated)

| Failure point | Mitigation |
| --- | --- |
| Wrong SHA in INDEX row | Both SHAs re-verified via `git rev-parse 0df13db` and `git rev-parse c2b4ea2` (full SHAs match the plan). |
| INDEX.md row count drifts | No row added/removed; only cell values and banner lines change. Re-verify with `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' \| wc -l` post-edit (must remain 177). |
| Banner format drift | Use the canonical inline form from `multipart-boundary-greedy.md:3` verbatim. |
| Test breakage from `voice.ts` edit | No test references the TODO text (`grep -rn "currently unused" /Users/eggp/marveen-develop/test-baseline/` returns 1 hit — the TODO itself). Tests assert behaviorally. |
| `NEVER modify` rule on `voice.ts` | None exists (verified). |
| Forgetting a `git add` | `git status` + `git diff --stat` after each edit to confirm only the expected files are staged. |

## Execution

Use a `Workflow` (orchestrator) on the current branch `test/baseline`, no new branch. The workflow runs locally and produces the two commits above; nothing is pushed. The workflow then invokes `/code-review max --fix` as the final step.

## Verification

After the two commits land:

1. `git diff --stat HEAD~2 HEAD` shows exactly 4 files:
   - `docs/needs-to-be-fix/INDEX.md`
   - `docs/needs-to-be-fix/config-empty-env-blanks-identity.md`
   - `docs/needs-to-be-fix/routes-updates-release-lock-unreachable-defensive-branch.md`
   - `src/web/routes/voice.ts`
2. `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' \| wc -l` → 177 (unchanged).
3. `grep -c "if (!lockHeld) return" src/web/routes/updates.ts` → 0 (unchanged; guard already absent from `c2b4ea2`).
4. `grep -n "envOr" src/config.ts` → unchanged from HEAD (helper already in place from `0df13db`).
5. `grep -n "TODO\|currently unused" src/web/routes/voice.ts` → no hits on the deleted lines.
6. `git log --oneline HEAD~2..HEAD` shows the two new commits with the agreed messages.
7. Run the test suite (e.g. `bun --bun vitest run src/__tests__/config.test.ts src/__tests__/routes-updates.test.ts src/__tests__/voice-routes.test.ts`) — must pass.

Then invoke the `/code-review max --fix` skill on the two-commit range.
