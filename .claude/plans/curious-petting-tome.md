# Plan: Next Batch of Smallest needs-fix Items

## Context

After cycle 38/39 the `docs/needs-to-be-fix/` directory holds 177 MDs, of which 21
are still officially open or "Deferred to next cycle" in `INDEX.md`. The user
selected the four smallest, lowest-risk items for the next batch. Three are docs
or coverage-gate only; one adds a security-rationale comment to source. All four
share the property: zero runtime behaviour change, isolated to one or two files,
and gated by an existing test that already pins the current behaviour.

Coverage data (`coverage/coverage-summary.json`, last full run) was used to verify
that no proposed fix is dead-on-arrival: federation.ts is already at 100% branches
under istanbul, so what looked like a v8-phantom is in fact already resolved.

## Items in this batch

### 1. `channel-request-watcher-unreachable-provider-check` : code comment (TOKEN LEAK invariant)

- **File**: `src/web/channel-request-watcher.ts`, line 67
- **Defect**: `lookupChannelName`'s `if (provider !== 'slack') return` is
  structurally unreachable through public callers (line 99 outer guard, line 105
  inner call site), but the MD explicitly warns it CANNOT be deleted. A mid-tick
  flip to telegram between the outer guard and the inner read would cause the
  inner path to call `readChannelToken('telegram', ...)` and ship the
  TELEGRAM_BOT_TOKEN as a Bearer header to `slack.com/api/conversations.info`
  (real cross-vendor token leak). The guard is load-bearing, not defensive. The
  current 1-line source does not explain this; a future "dead code" sweep could
  remove it.
- **Fix**: add a 3 to 5 line comment above line 67 documenting the invariant and
  the failure mode. No behaviour change. Existing test
  `channel-request-watcher.test.ts`'s synthetic provider-flip case stays as-is.
- **Risk**: zero source-behaviour change; the worst failure is a typo in the
  comment, which is trivially reviewable.

### 2. `federation-v8-coverage-quirks` : docs only (already Resolved)

- **Files**: `docs/needs-to-be-fix/INDEX.md`, `docs/needs-to-be-fix/federation-v8-coverage-quirks.md`
- **Status**: `src/web/routes/federation.ts` is at **100% branches (327/327)**
  under the istanbul provider in `vitest.config.ts:31`. The v8 to istanbul switch
  (commit landing the `provider: 'istanbul'` line) already fixed all four entries
  the MD flagged (lines 93, 261, 330, 419 in the MD's references, off by one from
  the current line numbers 92, 260, 329, 418). Lines 93 and 330 (current 92 and
  329) were also independently resolved (commits `08d7508` and `858660f`);
  lines 261 and 419 (current 260 and 418) are now covered by tests that exercise
  the RHS (e.g. `routes-federation-full.test.ts:391` with 30 agents truncated to
  25).
- **Fix**: update the MD and INDEX row to `Resolved: <date> <coverage-istanbul-switch sha>`.
- **Risk**: zero. Docs-only update.

### 3. `agent-worker-settings-symlink-preserve` : docs only (fix already in)

- **Files**: `docs/needs-to-be-fix/INDEX.md`, `docs/needs-to-be-fix/agent-worker-settings-symlink-preserve.md`
- **Status**: the source fix is in commits `e40c7f0` (read symlink content via
  `realpathSync` before deleting) and `b70a1f7` (realpathSync preserves relative
  symlinks). Current code at `src/web/agent-worker.ts:379-389` correctly preserves
  the shared `~/.claude/settings.json` content. The `agent-worker-full.test.ts`
  test was updated in `24bea87` to assert the relative-symlink round trip. The MD
  was filed before the fix and was kept on the INDEX in `fbb47fb` as "Deferred to
  next cycle" only because no one had marked it Resolved yet, not because the
  source needed more work.
- **Fix**: update MD + INDEX to `Resolved: 2026-08-21 e40c7f0 (+ b70a1f7)` with a
  one-line note that `realpathSync` was preferred over `readlinkSync` for
  relative-symlink safety.
- **Risk**: zero. Docs-only update.

### 4. `message-router-cache-fallback-unreachable` : vitest glob-pattern threshold override

- **File**: `vitest.config.ts`
- **Defect (history)**: commit `eb9b951` replaced three unreachable `??` arms in
  `runMessageRouterTick` with an `if (!cached) { warn; continue }` block. That
  made the file strictly worse: same number of unreachable branches, new
  uncovered STATEMENTS / LINES (97.79% branch, 98.57% statement, 99.25% line), and
  a silent-drop regression risk (the new `continue` skips the abandon-window
  bookkeeping). Commit `2ec1c99` reverted `eb9b951`, restoring the three `??`
  arms. The current code at `src/web/message-router.ts:480-483` is:
  ```ts
  const cached = agentSessionCache.get(msg.to_agent)
  const session = cached?.session ?? agentSessionName(msg.to_agent)
  const host   = isMainAgent ? null : cached?.host ?? readAgentRemoteHost(msg.to_agent)
  const sessionExists = cached?.exists ?? sessionExistsOnHost(host, session)
  ```
  Three `??` RHS arms remain structurally unreachable through public input but
  now match the pre-`eb9b951` shape (option (b) from the MD).
- **Coverage data confirms**: `message-router.ts` is at 97.82% branches
  (135/138, 3 uncovered). Under istanbul, the constant RHS is reported as a
  branch that cannot be hit, just like the MD describes.
- **Fix**: add a glob-pattern key directly inside the `thresholds` object
  overriding the global `branches: 100` for `src/web/message-router.ts`.
  Per the vitest docs (`https://vitest.dev/config/coverage.html`), `perFile` is a
  boolean toggle for the GLOBAL thresholds. Per-file overrides go inside
  `thresholds` keyed by glob pattern. The new threshold block becomes:
  ```ts
  thresholds: {
    lines: 100,
    functions: 100,
    branches: 100,
    statements: 100,
    perFile: true,
    'src/web/message-router.ts': { branches: 97 },
  },
  ```
  The `perFile: true` boolean is KEPT so every other file continues to be
  checked against its own `branches: 100` (and `lines`/`statements`/`functions`
  per-file). The glob-pattern override is an additive per-file entry; for the
  one matching file the override's `branches: 97` wins, for all other files the
  global `branches: 100` still applies per file.
  97 (not 97.83) is the documented unreachable count; rounding down keeps the
  gate green if the uncovered count drifts to 4. `lines`/`statements`/`functions`
  for this file remain at 100% per the actual coverage numbers (267/267,
  276/276, 19/19).
- **Caveat (vitest docs)**: "Vitest counts all files, including those covered by
  glob-patterns, into the global coverage thresholds." So `branches: 100` global
  stays enforced for the other 90+ files; only `message-router.ts` gets the 97
  floor. This matches the MD's intent: file-specific documented gap, not a
  blanket relaxation.
- **Risk**: low. The change is local to one file. Worst case the threshold is set
  slightly too high and the CI gate fails; the test run still tells us the exact
  missing-branch count and we can re-tune. Zero source code change. The MD's
  recommendation explicitly endorses option (b).

## Files Touched

| File | Change |
|---|---|
| `src/web/channel-request-watcher.ts` | + 3 to 5 line comment above line 67 |
| `vitest.config.ts` | + 1 glob-pattern key inside `thresholds` |
| `docs/needs-to-be-fix/INDEX.md` | mark 3 rows Resolved (Items 2, 3, 4) |
| `docs/needs-to-be-fix/federation-v8-coverage-quirks.md` | add Resolved banner |
| `docs/needs-to-be-fix/agent-worker-settings-symlink-preserve.md` | add Resolved banner |
| `docs/needs-to-be-fix/message-router-cache-fallback-unreachable.md` | add Resolved banner |

No test files are modified. No existing pinning tests are touched. No test file is
deleted.

Note: Items 2, 3, 4 all share `docs/needs-to-be-fix/INDEX.md`. The merge is safe
because they land in the SAME commit (the second commit below), so there is no
cross-commit conflict to resolve.

## Critical Files To Read Before Execution

- `src/web/channel-request-watcher.ts:55-93` : confirm the guard is line 67 and
  that no comment exists above it.
- `vitest.config.ts:30-47` : confirm the threshold block currently has
  `perFile: true` boolean and that adding a glob-pattern key inside `thresholds`
  is additive (no other config change required).
- `docs/needs-to-be-fix/INDEX.md` : confirm the row text and ordering before
  editing, to avoid breaking the alphabetical sort the maintainer uses.
- `coverage/coverage-summary.json` (rows for `routes/federation.ts`,
  `web/agent-worker.ts`, `web/message-router.ts`) : confirm pre-edit numbers; the
  coverage run should not regress after this batch.

## Reused Functions / Patterns

- `vitest.config.ts` already uses `provider: 'istanbul'` and `perFile: true`.
  The glob-pattern-keyed override (`'src/web/message-router.ts': { branches: 97 }`)
  is the documented vitest pattern; no new helper is needed.
- `/* v8 ignore next */` pattern exists in `src/pane-state.ts:1064-1503` but is
  not used here. We are on istanbul, and option (b) drops the requirement instead
  of silencing individual branches, which is cleaner and survives future
  refactors of the file.

## Verification

Run after the batch lands, in this order:

1. `bun --bun vitest run src/__tests__/channel-request-watcher.test.ts` : must
   pass; the comment-only change cannot break the synthetic provider-flip test
   but the run confirms.
2. `bun --bun vitest run --coverage src/web/message-router.ts src/web/channel-request-watcher.ts src/web/routes/federation.ts src/web/agent-worker.ts` :
   must show:
   - `channel-request-watcher.ts`: 100/100/100/100
   - `message-router.ts`: 100/100/97/100 (lines/functions/statements 100, branches 97)
   - `federation.ts`: 100/100/100/100 (unchanged from baseline)
   - `agent-worker.ts`: 100/100/100/100 (unchanged from baseline)
3. Full gate: `bun --bun vitest run --coverage` end-to-end. Must pass. If the
   vitest run reports MORE than 5 failures anywhere, branch to the `a330462`
   baseline per CLAUDE.md §8:
   ```sh
   git worktree add --detach /tmp/claw-test-baseline a330462
   cd /tmp/claw-test-baseline && ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules node_modules
   bun --bun vitest run --coverage
   ```
   If the baseline also fails the same set, the regression is pre-existing, not
   caused by this batch. Capture both outputs and report to the user; do not
   debug further without confirmation.
4. CI gate: the JSON summary must show the four files above unchanged except
   the `message-router.ts` branches row.
5. **Mandatory** post-batch `/code-review max --fix` skill (per CLAUDE.md "End
   of batch" rule). The user runs this manually; Claude does not invoke the
   Skill tool (`disable-model-invocation` flag).

## Worktree / Branch Discipline

- All work starts on `test/baseline`, stays on `test/baseline`, ends on
  `test/baseline`. No new branches, no rebases onto `feature-develop`, no push
  (CLAUDE.md §6: "Tilos pusholni").
- No `TaskStop` on any running agent or CI workflow. If a tool call appears to
  hang, wait it out per CLAUDE.md §6. A long transcript or repeated tool calls
  is not evidence of a stuck agent; only the user can authorize a stop.
- The batch lands as 2 commits so the bug-ID trailers
  (`#channel-request-watcher-unreachable-provider-check`, etc.) are greppable
  from `git log --grep`.
- Worktree guard: before the test run, verify `ls store/` is empty. If
  `store/claudeclaw.db` or any other artifact exists, create the temp worktree
  per CLAUDE.md §8:
  ```sh
  git worktree add --detach /tmp/claw-test test/baseline
  ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules /tmp/claw-test/node_modules
  ```
  Only then run `bun --bun vitest run`. The `assert-not-live-install.ts` guard
  hard-fails the suite if the worktree is not isolated, so skipping this step
  produces an "expected" refusal that is not actually expected.

## Execution Model

The execution uses the project's `Workflow` tool (the dynamic-orchestration
script host defined in `.claude/plans/_wf-impl-prompt.md`). Two phases:

- **Phase 1**: `src/web/channel-request-watcher.ts` comment edit, plus the
  channel-request-watcher.test.ts targeted run to confirm the synthetic
  provider-flip case still passes.
- **Phase 2**: `vitest.config.ts` threshold edit, the three MD `Resolved`
  banners, the INDEX.md row updates, then the full coverage run.

Each phases uses `pipeline()` (default), not `parallel()` between phases. Within
phase 2 the docs banners are written serially (each is one Edit on a different
file, no shared state). No adversarial verify is needed for this batch: the
changes are documentation + a threshold number + one comment, all of which the
full vitest run already exercises.

The commit messages use the `safe-commit-message` PROTOCOL (not a Skill; the
available-skills list does not include it; the protocol is documented in
`.claude/plans/_wf-impl-prompt.md` lines 3, 7, 47). The protocol writes the
message to `/tmp/commit-N-msg.txt` and runs `git commit -F /tmp/commit-N-msg.txt`.

## Commit Plan

Two commits, in this order:

1. `docs(channel-request-watcher): add TOKEN LEAK invariant comment (#channel-request-watcher-unreachable-provider-check)`
   - single source change: 3 to 5 line comment above line 67.
2. `chore(vitest+docs): lower branches threshold for message-router + mark 3 MDs Resolved (#federation-v8-coverage-quirks #agent-worker-settings-symlink-preserve #message-router-cache-fallback-unreachable)`
   - combined because the docs updates are pure maintenance and the vitest
     threshold is a one-line addition; no behavioural coupling. All three MDs
     land in the same commit to keep INDEX.md edits in a single diff.

Use `safe-commit-message` skill for both (CLAUDE.md §6: no em dash, project
commit-message conventions).

## Out of Scope (Explicitly Deferred)

The following items were considered and dropped from this run because they are NOT
small or have known architectural impact:
- `test-suite-store-pollution-store-dir-frozen` (HIGH, multi-file architectural
  refactor of `config.ts` / `db.ts` / `env.ts` + every test file using
  `STORE_DIR`).
- `keychain-store-insecure-acl` (requires real macOS host verification per the
  MD's revert trail; commit `8c3f9ac` already reverted one attempt).
- `channel-coordinator-internals-untestable` (the MD is OUTDATED, file is at
  100% coverage; pure docs cleanup, not part of this batch).
- `routes-agents-br-baseline-partial-coverage`,
  `web-agent-scaffold-defensive-coverage`,
  `web-agent-worker-runviaworker-coverage`,
  `web-inbound-probe-respawn-grace` (each is a multi-file refactor or
  test-infrastructure redesign, out of scope for a "smallest modifications"
  batch).

These remain in `INDEX.md` as "Deferred to next cycle" and can be re-tackled
when the user asks for a bigger batch.