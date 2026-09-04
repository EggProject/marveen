# Plan: docs-only closure of 12 partially-resolved MDs + INDEX.md count/SHA drift

## Context

The `docs/needs-to-be-fix/` directory currently has 178 MDs (per `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l`). Of those, ~12 have a resolution footer that contradicts the body prose — the fix landed, but the narrative text below the resolution was never updated to match. Examples:

- `agent-terminal-218-ts-strict-blocks-delete.md` body says "Edit reverted" but the footer says `c8ce4a4` landed the delete.
- `openrouter-models-tier1-auto-empty-fallback.md` body says "test should be flipped once fix lands" but the test was flipped in `63d62da`.
- `stuck-input-watcher-give-up-inner-if-unreachable.md` has two `## Resolution` sections, first marked "DO NOT RELY ON" but no banner.
- `federation-routes-fedpeer-required-type-narrow-deferred.md` cites commit `858660f` which is **dangling** (not on `test/baseline`); the actual branch commit is `8e11043` (same content).

INDEX.md preamble (line 3) claims `177 open` MDs — off by one. INDEX.md rows 217 and 219 both cite `858660f` — same dangling SHA.

Outcome: the 12 MDs become unambiguous historical records; the dangling-SHA discrepancy is corrected; the count drift is fixed. **Zero source-code or test changes.** Smallest possible modification surface (no `src/`, no `tests/`, no `package.json`, no lockfile).

## Scope

- 12 MD files in `docs/needs-to-be-fix/` — stale prose rewritten or banner-annotated
- 3 lines in `docs/needs-to-be-fix/INDEX.md` — preamble count + two SHA corrections

Total: 13 file edits. All `*.md` only. All in one commit.

## Per-MD edits

Edits grouped by pattern. Exact `old_string` / `new_string` pairs verified by Plan agent against current file contents.

### Pattern A: delete the contradictory `## Resolution` section

These 3 MDs have a body-section literally named `## Resolution` whose prose contradicts the resolution footer at the bottom of the file. Delete the body section so the reader sees only the truthful footer.

#### A1. `agent-terminal-218-ts-strict-blocks-delete.md`

old_string:
```
## Resolution

Edit reverted. The defensive coalesce is left in place. Synthetic test
that pinned the non-string-keys branch (`ignores a non-string keys
(sanitizeLiteralKeys is bypassed -> null literalKeys -> 400)`) stays
in place alongside the source.

## See also
```

new_string:
```
## See also
```

#### A2. `channel-invites-108-ts-strict-blocks-delete.md`

old_string:
```
## Resolution

Edit reverted. Source branch left intact. Synthetic test that pinned this
branch stays in place alongside the source.

## See also
```

new_string:
```
## See also
```

#### A3. `channel-invites-236-ts-strict-blocks-delete.md`

old_string:
```
## Resolution

Edit reverted. The defensive guard is left in place. Synthetic test that
pinned the falsy branch (`drives the defensive if (access.pending) falsy
branch inside the approve path`) stays in place alongside the source.

## See also
```

new_string:
```
## See also
```

### Pattern A (rephrase): rephrase the stale prose to acknowledge the fix

#### A4. `openrouter-models-tier1-auto-empty-fallback.md`

Two text edits. Both flip "should be flipped once the fix lands" / "Once the fix lands, the assertion must be updated" to past-tense acknowledgement.

Edit 4a (lines 53-56):
- old: ``that test should be flipped to expect `'deepseek/deepseek-chat-v3.1'` once the fix lands.``
- new: ``the test was flipped to expect `'deepseek/deepseek-chat-v3.1'` when the fix landed.``

Edit 4b (lines 58-66, the `## Pinning test` section body):
- Replace "Currently asserts the current empty-string return value. Once the fix lands, the assertion must be updated to `'deepseek/deepseek-chat-v3.1'`..." with: "Asserts `'deepseek/deepseek-chat-v3.1'` -- the corrected post-fix behaviour. The case was renamed and re-asserted when `63d62da` landed."

#### A5. `telegram-client-probehighwater-ignores-okfalse.md`

One text edit (lines 100-109, the "currently passes" paragraph). Replace "The test currently **passes** by documenting the buggy behaviour... Once the fix lands, swap the final `expect(result).toBe(99999)` for `expect(result).toBeInstanceOf(TelegramApiError)`" with: "The original pinning test asserted the buggy shape (`expect(result).toBe(99999)`). When `1672bf5` landed, the assertion was flipped to `expect(result).toBeInstanceOf(TelegramApiError)` and a second test was added to cover the no-description branch."

#### A12. `federation-routes-fedpeer-required-type-narrow-deferred.md`

Full-rewrite of stale narrative. Replace line 1 status banner from `**Status:** RESOLVED (documented only)` to `**Status:** RESOLVED -- narrowing succeeded (commit \`8e11043\` on \`test/baseline\`). The narrative below describes the original "deferred" state and is preserved for historical context only. **The \`?? null\` fallbacks at \`federation.ts:298,329\` are gone.** Do not act on the "Forward path" section below.`

Also fix line 7: change `federation.ts:299,330` to `federation.ts:298,329` (post-`8e11043` line numbers).

### Pattern B: drop trailing "NEVER modify" paragraphs

These 3 MDs have a RESOLVED status banner (or footer) but a trailing paragraph that still says "NEVER modify ... requires explicit user override." Drop the trailing paragraph; the existing resolution already supersedes it.

#### B1. `agent-worker-settings-symlink-preserve.md`

old_string (lines 109-111):
```
Per task rule "NEVER modify src/web/agent-worker.ts" the source edits
are blocked until the user overrides; the test suite pins the current
behaviour and documents the direction.
```

new_string:
```
## Resolution

The fix described above landed in three commits: `e40c7f0` applied
option (a) verbatim using `readlinkSync` + `readFileSync`; `b70a1f7`
replaced `readlinkSync` with `realpathSync` after the relative-symlink
failure (`../.claude/settings.json`) was observed; `24bea87` corrected
the regression test's relative path to `../../.claude/settings.json`.
The "NEVER modify src/web/agent-worker.ts" guard from the original
task rule no longer applies.
```

#### B2. `channel-health-monitor-spawndetach-inflight-redundant-guard.md`

old_string (lines 133-135 + blank + `## Resolution`):
```
Per task rule "NEVER modify src/" the source edit is blocked until the
user overrides; the test suite documents the gap and pins every reachable
sibling branch.

## Resolution
```

new_string:
```
## Resolution
```

#### B3. `memory-digest-empty-trim.md`

old_string (lines 74-76 + blank + `## Resolution`):
```
Per task rule "NEVER modify src/memory.ts" this requires an explicit
override from the user; the test suite documents the gap and the pinning
case above should be added when the fix is applied.

## Resolution
```

new_string:
```
## Resolution
```

### Pattern B (recall MDs): prepend blockquote banner to the superseded section

#### B4. `routes-recall-153-ts-strict-blocks-delete.md`

old_string (lines 11-16, first 6 lines):
```
## Resolution (superseded, see below)

Edit reverted. `?? 0` fallback restored. Although `utolso` early-returns
at line 148-152 and only `elso|masodik|harmadik|negyedik` reach line 153,
TS cannot prove this from Record index access; a type guard or explicit
cast would be required to satisfy strict mode.
```

new_string (prepend a blockquote between header and prose):
```
## Resolution (superseded by `## Resolution (2026-08-16, 3bec823)` below)

> The premise in this section was wrong -- see the bottom-of-file note
> "The premise recorded in this MD was wrong" for details. The fix
> landed in commit `3bec823` and removed both `?? 0` fallbacks. The
> "Edit reverted" prose below is kept for historical record only.

Edit reverted. `?? 0` fallback restored. Although `utolso` early-returns
at line 148-152 and only `elso|masodik|harmadik|negyedik` reach line 153,
TS cannot prove this from Record index access; a type guard or explicit
cast would be required to satisfy strict mode.
```

#### B5. `routes-recall-25-ts-strict-blocks-delete.md`

Same edit pattern as B4 — prepend a blockquote banner to the first `## Resolution` section. The blockquote text mirrors B4 but mentions the `Intl.DateTimeFormat` original prose context.

### Pattern C: tighten supersession marker on the duplicate Resolution

#### C1. `stuck-input-watcher-give-up-inner-if-unreachable.md`

The MD has two `## Resolution` sections. First (lines 112-124) header reads `## Resolution (cycle 32, superseded -- DO NOT RELY ON)`. Strengthen by changing header to `## Resolution (cycle 32, **DEPRECATED** -- do not apply)` and prepending a blockquote warning immediately after the header:

old_string (lines 112-124):
```
## Resolution (cycle 32, superseded -- DO NOT RELY ON)

This MD was originally resolved by cycle 32 commit `1e58ebd` (test/baseline,
"fix(stuck-input-watcher): drop dead prev-attempts guards in three recovery
branches") which simply removed the inner `prev.attempts < X.maxAttempts`
clause at all three sites. The MD correctly identified the inner guard as
structurally dead, but it failed to flag a critical side effect: once the
inner guard is removed, the outer `else-if` body becomes a regression
vector. The dead-guard removal alone caused `sendAlert` (the sub-agent
escalation path) to fire on EVERY tick of a stuck spell, at roughly 15s
intervals, for the full duration of the spell. That is user-facing
Telegram/Slack notification spam. The cycle 32 fix was therefore unsafe.
It is superseded by the per-spell gate resolution below.
```

new_string:
```
## Resolution (cycle 32, **DEPRECATED** -- do not apply)

> **WARNING -- DO NOT REVERT TO THIS APPROACH.**
>
> The cycle 32 commit `1e58ebd` is **superseded** by the per-spell gate
> resolution below (`## Resolution`, commit `edae3f1` + `53490cd` +
> `f47a60f`). The cycle 32 fix removed only the inner guard without
> adding a per-spell gate, which caused `sendAlert` (the sub-agent
> escalation path) to fire on **every tick** of a stuck spell, at
> roughly 15s intervals, for the full duration of the spell -- that is
> user-facing Telegram/Slack notification spam. Reverting to this
> resolution re-introduces the spam regression.
>
> **Use the `## Resolution` (per-spell gate) approach below.**

This MD was originally resolved by cycle 32 commit `1e58ebd` (test/baseline,
"fix(stuck-input-watcher): drop dead prev-attempts guards in three recovery
branches") which simply removed the inner `prev.attempts < X.maxAttempts`
clause at all three sites. The MD correctly identified the inner guard as
structurally dead, but it failed to flag a critical side effect: once the
inner guard is removed, the outer `else-if` body becomes a regression
vector. The dead-guard removal alone caused `sendAlert` (the sub-agent
escalation path) to fire on EVERY tick of a stuck spell, at roughly 15s
intervals, for the full duration of the spell. That is user-facing
Telegram/Slack notification spam. The cycle 32 fix was therefore unsafe.
It is superseded by the per-spell gate resolution below.
```

## INDEX.md edits

Three line-level changes:

### INDEX.md line 3 (preamble count)

old_string: ``Every bug MD filed in this session. Total count: 177``
new_string: ``Every bug MD filed in this session. Total count: 178``

### INDEX.md line 217 (`federation-inbox-fedPeer-null-fallback`)

old_string: ``Resolved: 2026-08-21 858660f``
new_string: ``Resolved: 2026-08-21 8e11043``

### INDEX.md line 219 (`federation-routes-fedpeer-required-type-narrow-deferred`)

old_string: ``Resolved: 2026-08-21 858660f — narrowing now succeeds``
new_string: ``Resolved: 2026-08-21 8e11043 — narrowing now succeeds``

(Inline grep before commit: `grep -rn '858660f' docs/` should return zero hits.)

## Critical files to modify

- `docs/needs-to-be-fix/INDEX.md` (3 lines)
- `docs/needs-to-be-fix/agent-terminal-218-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/channel-invites-108-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/channel-invites-236-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/routes-recall-153-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/routes-recall-25-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/openrouter-models-tier1-auto-empty-fallback.md`
- `docs/needs-to-be-fix/telegram-client-probehighwater-ignores-okfalse.md`
- `docs/needs-to-be-fix/agent-worker-settings-symlink-preserve.md`
- `docs/needs-to-be-fix/channel-health-monitor-spawndetach-inflight-redundant-guard.md`
- `docs/needs-to-be-fix/memory-digest-empty-trim.md`
- `docs/needs-to-be-fix/federation-routes-fedpeer-required-type-narrow-deferred.md`
- `docs/needs-to-be-fix/stuck-input-watcher-give-up-inner-if-unreachable.md`

13 files total. No `src/`, no `tests/`, no `package.json`.

## Execution workflow

User-mandated 2-subagent verification + Agent tool with worktree isolation per CLAUDE.md §8.

### Step 1 — Implement in worktree

Use the **Agent tool** with `isolation: worktree` (no Workflow tool — CLAUDE.md §8 prohibits it for parallel verification, and this is a single linear edit). Agent prompt:

1. `git worktree add --detach /Users/eggp/marveen-develop/test-baseline-worktree-batch 0469551`
2. Apply all 13 edits listed above in order:
   1. INDEX.md (3 lines)
   2. A12 federation-routes (full rewrite)
   3. B1-B3 (drop trailing NEVER modify paragraphs)
   4. B4-B5 (recall MD blockquote banners)
   5. A1-A3 (delete `## Resolution` sections)
   6. A4-A5 (rephrase stale prose)
   7. C1 (stuck-input-watcher blockquote banner)
3. After each edit, immediately Read the file to verify the result matches the spec.
4. Run inline verification: `git diff --stat` (expect 13 files, all `.md`), `grep -rn '858660f' docs/` (expect zero hits), `git diff --stat | grep -v '\.md'` (expect no output).
5. Stage and commit: `git add docs/needs-to-be-fix/ && git commit -m 'docs(needs-to-be-fix): resolve stale prose in 12 partially-closed MDs'`
6. Report commit SHA back. Do NOT push.
7. Do NOT merge to `test/baseline` yet — leave worktree intact.

### Step 2 — Double-check via 2 parallel subagents

Launch **2 Agent tool subagents** (no isolation, read-only) in parallel via a single message. Each independently validates the worktree commit.

**Subagent A — Edit correctness:**
- `git -C /Users/eggp/marveen-develop/test-baseline-worktree-batch diff HEAD~1`
- For each of the 13 files: verify the diff matches the spec exactly. Flag any text that is NOT in the spec (added or removed).
- Verify the 3 INDEX.md lines have the new strings.
- Verify no `src/`, `tests/`, or `package.json` files are modified.

**Subagent B — Risk + integrity check:**
- `git -C /Users/eggp/marveen-develop/test-baseline-worktree-batch grep -rn '858660f' docs/` → expect zero hits.
- `git -C /Users/eggp/marveen-develop/test-baseline-worktree-batch grep -rn 'NEVER modify' docs/needs-to-be-fix/agent-worker-settings-symlink-preserve.md docs/needs-to-be-fix/channel-health-monitor-spawndetach-inflight-redundant-guard.md docs/needs-to-be-fix/memory-digest-empty-trim.md` → expect zero hits in body (the word may still appear in the file's title block or example context, but NOT in the resolution footer block).
- `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l` → expect 178.
- `git -C /Users/eggp/marveen-develop/test-baseline-worktree-batch log -1 --format='%H %s'` → confirm commit exists with the expected message.
- `git -C /Users/eggp/marveen-develop/test-baseline-worktree-batch diff HEAD~1 --stat` → confirm 13 files, all `.md`.

If either subagent reports a mismatch, abort and surface the discrepancy. Otherwise:

### Step 3 — Bring commit back to `test/baseline`

Per CLAUDE.md §8: `git merge --ff-only <commit-SHA>` (NOT `git reset --hard`).

```
cd /Users/eggp/marveen-develop/test-baseline
git merge --ff-only <commit-SHA>
git worktree remove /Users/eggp/marveen-develop/test-baseline-worktree-batch --force
git log --oneline -3
```

Verify working tree clean, HEAD advanced by one commit.

### Step 4 — User runs `/code-review max --fix`

Per CLAUDE.md §8: the `/code-review` skill has `disable-model-invocation` and is user-only. **The user must invoke it manually.** Document in the post-implementation summary: "Next step: run `/code-review max --fix` to catch any remaining prose oddity."

## Verification protocol (per-step)

Docs-only minimum — no `bun run typecheck`, no `bun test`, no `bun run lint`. Just text inspection.

- **Pre-edit:** `git status` clean on `test/baseline`; HEAD = `0469551`; `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l` = 178.
- **Post-edit (worktree):** `git diff --stat` = 13 `.md` files; no other paths; `grep -rn '858660f' docs/` = 0; per-MD Read confirms body no longer contradicts footer.
- **Post-merge (branch):** `git log --oneline -3` shows the new commit on top of `0469551`; `git status` clean; HEAD diff vs `0469551` matches the worktree commit.
- **Final:** User invokes `/code-review max --fix` from terminal.

## Risks (pre-surfaced, not implementation-time discoveries)

1. **`858660f` is dangling on `test/baseline`.** Mitigated by replacing all 3 citations with `8e11043` (the actual branch commit, verified via `git log --oneline | grep 8e11043`). Plan covers INDEX.md rows 217 and 219, plus the MD body (A12).
2. **`stuck-input-watcher.test.ts:304`** mentions the MD filename in a comment. Not a load-bearing dependency, but kept filename unchanged so the comment doesn't rot.
3. **`federation-routes-fedpeer-required-type-narrow-deferred.md` line numbers in body** (299, 330) are pre-fix; post-`8e11043` they are 298 and 329. A12 fixes line 7. Lines 74-77 (`## Files inspected` list) also need a pre-commit scan — implementer should re-grep the body for any remaining `299` / `330` references and update to `298` / `329` if present.
4. **Two `## Resolution` headers in some MDs** (recall MDs after edit, agent-worker after edit). Acceptable — both sections are valid historical record. The blockquote banner on the first one makes the supersession unmissable.
5. **No automated test catches docs regressions.** Verification is purely by read-through and `git diff` inspection. `/code-review max --fix` is the catch-net.

## Out of scope (deferred to future cycles)

- The 4 truly-deferred source code items (`message-router-cache-fallback-unreachable`, `routes-agents-br-baseline-partial-coverage`, `web-agent-scaffold-defensive-coverage`, `web-agent-worker-runviaworker-coverage`) — none of them have docs-only stale prose to clean up; they all need source-level decisions.
- The 19 hook/security test failures — independent test-infrastructure workstream.
- `keychain-store-insecure-acl` — explicitly blocked by task rule, low severity.
- `routes-fleet-q-404-leaks-roster` — explicitly blocked by "NEVER modify" rule.
- `message-router-dead-defensive-branches.md` / `message-router-unreachable-defensive-branches.md` Partially-resolved footer text — couples with the dangling cache-fallback MD; left for the next cycle that addresses the source-side decision.