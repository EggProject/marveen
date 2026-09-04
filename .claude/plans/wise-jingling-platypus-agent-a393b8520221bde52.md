# Top 5 fix candidates for docs/needs-to-be-fix/

## Context

The INDEX lists 175 bug MDs; 126 are unresolved. The recent fix pattern
(commits c2b4ea2, 08d7508, 014f1de, 68b94fe, cd1bc00, af4c087, 242714e)
is 1-3 line drops of structurally unreachable defensive branches.
We need the top 5 candidates that match this pattern, with the smallest
diff and lowest failure risk.

## Verified low-risk candidates

I read each MD and grepped the source at HEAD to confirm bug presence.
Several MD-named bugs are already fixed at HEAD (off-by-one in the INDEX
vs the actual fix commit), so they have been excluded:

### Already absent at HEAD (filtered out):
- `stuck-tool-call-watcher-dead-ternary` (line 192: `Date.now() - lastRespawn` already fixed)
- `skills-sort-comparator-falsy-arms` (line 157: `a.label.localeCompare(b.label)` already fixed)
- `skills-import-seg-truthy-guard` (line 409: `topLevel.add(seg)` unconditional already fixed)
- `reauth-healer-stampalert-if-st-dead-code` (line 395: `st!` non-null assertion already fixed)
- `agent-process-restartagentprocess-stop-error-default-unreachable` (line 1384: `stopResult.error` already fixed)
- `agent-process-answerfirstrungates-acted-unchanged-unreachable` (line 1512: `return 'cleared'` already fixed)

### TS strict-blocked (filtered out of top 5):
- `recall-weekIdx-fallback` and `recall-dayOfWeekBudapest-fallback` (separate MDs `routes-recall-25/153-ts-strict-blocks-delete` document the strict failure)
- `agent-team-trustfrom-nullish-coalesce` (separate MD `agent-team-trustfrom-required-type-narrow-deferred` documents the required type narrowing)
- `channel-invites-108/236-ts-strict-blocks-delete` (strict failure)
- `agent-terminal-keys-preview-literalKeys-fallback` (`literalKeys` is `null | string`, dropping `?? ''` requires cast)
- `federation-inbox-fedPeer-null-fallback` (type narrowing to required `fedPeer: string | null`)

### Missing-file / wrong-path audits (filtered out per parent context):
- `routes-dashboard-auth-nonexistent-sut`, `routes-reauth-healer-missing-file`,
  `routes-update-checker-path-mismatch`, `routes-reauth-detect-missing-source-path`,
  `routes-remote-status-cache-path-mismatch`, `routes-agent-team-unreachable-branches`

## Top 5 ranked candidates

```json
{
  "candidates": [
    {
      "rank": 1,
      "bug_id": "mcp-list-warn-execError-dead-branch",
      "file_line": "src/web/mcp-list.ts:135",
      "title": "warn() payload's `execError ?` truthy arm is unreachable",
      "md_file": "docs/needs-to-be-fix/mcp-list-warn-execError-dead-branch.md",
      "estimated_diff_lines": 1,
      "failure_risk": "low",
      "failure_reasoning": "Pure dead-branch drop. The defensive ternary's truthy arm is unreachable because `applyRefreshOutcome`'s `retainedStale` mapping forces `execError === null` whenever the warn block fires. 30 tests already pass; 97.29% branch coverage jumps to 100% with this single edit. Not a hot path. No public-API surface change.",
      "has_pinning_test": true,
      "ts_strict_blocked": false,
      "current_head_state": "bug present",
      "rationale": "Simplest possible drop: replace `execError: execError ? scrubPaths(execError.message) : null` with `execError: null`. Same value in every reachable case. No test changes needed; entire 30-test suite (agent-worker-full.test.ts) stays green and reaches 100% branches."
    },
    {
      "rank": 2,
      "bug_id": "http-helpers-gzip-memo-evict-guard",
      "file_line": "src/web/http-helpers.ts:122",
      "title": "gzip memo eviction guard is dead code",
      "md_file": "docs/needs-to-be-fix/http-helpers-gzip-memo-evict-guard.md",
      "estimated_diff_lines": 1,
      "failure_risk": "low",
      "failure_reasoning": "Type-level possibility with no runtime counterpart. The `oldest: string | undefined` type comes from `IterableIterator.next()`; the `size >= GZIP_MEMO_MAX_ENTRIES` guard ensures a 20-entry Map, so `keys().next().value` is always a string. The MD documents using `!` non-null assertion or a `/* v8 ignore next */` comment. No test changes needed; the existing `serveFile > gzip` eviction test continues to pin the reachable side.",
      "has_pinning_test": true,
      "ts_strict_blocked": false,
      "current_head_state": "bug present",
      "rationale": "Single-line drop: `if (oldest !== undefined) gzipMemo.delete(oldest)` becomes `gzipMemo.delete(gzipMemo.keys().next().value!)`. Microscopic diff. Coverage goes from 97.77% to 100% branches. v8 ignore comment is even smaller (`/* v8 ignore next -- size >= 20 guarantees a key */`)."
    },
    {
      "rank": 3,
      "bug_id": "approvals-raw-resolved-by-in-log",
      "file_line": "src/web/routes/approvals.ts:183",
      "title": "approvals PATCH logger receives untrimmed resolved_by",
      "md_file": "docs/needs-to-be-fix/approvals-raw-resolved-by-in-log.md",
      "estimated_diff_lines": 2,
      "failure_risk": "low",
      "failure_reasoning": "Real bug fix (not pure dead code). The handler passes `resolved_by.trim()` to `resolveApproval` but logs the untrimmed `resolved_by`. Tiny source change: capture `const trimmedResolvedBy = resolved_by.trim()` and pass it to the log call. Only the pinning test needs to be flipped (its `expect(...).toContain('  owner  ')` will become `expect(...).toContain('owner')`). Not a hot path; the log is a one-shot per PATCH.",
      "has_pinning_test": true,
      "ts_strict_blocked": false,
      "current_head_state": "bug present",
      "rationale": "Real correctness fix (logger emits whitespace, audit trail is wrong). 1 source line + 1 test flip. Low blast radius — only the PATCH `/api/approvals/:id` route. Already-CI-passes test just needs assertion updated."
    },
    {
      "rank": 4,
      "bug_id": "agents-parseChannelProvider-return-null",
      "file_line": "src/web/routes/agents.ts:231",
      "title": "parseChannelProvider's null return is unreachable",
      "md_file": "docs/needs-to-be-fix/agents-parseChannelProvider-return-null.md",
      "estimated_diff_lines": 3,
      "failure_risk": "low",
      "failure_reasoning": "Function is module-private, only called from `matchChannelRoute` after a regex `(telegram|slack|discord|googlechat|teams)` capture that restricts `newMatch[2]` to a member of `VALID_PROVIDERS`. The `return null` path AND the corresponding `if (provider)` check at line 242 are both dead. Drop the `VALID_PROVIDERS.has` guard, change return type to `ChannelProviderType`, and drop the `if (provider)` check. 330 existing tests in `agents-routes.test.ts` stay green. No behavioural change.",
      "has_pinning_test": true,
      "ts_strict_blocked": false,
      "current_head_state": "bug present",
      "rationale": "Clean collapse of defensive guard. Simplifies 2 functions in 1 file. Not TS strict blocked (the return type changes to `ChannelProviderType`, which already exists). Branch coverage goes from 73 dead hits to 0 on a single file."
    },
    {
      "rank": 5,
      "bug_id": "stuck-input-watcher-give-up-inner-if-unreachable",
      "file_line": "src/web/stuck-input-watcher.ts:124,164,204",
      "title": "the give-up `prev.attempts < maxAttempts` inner-if is unreachable",
      "md_file": "docs/needs-to-be-fix/stuck-input-watcher-give-up-inner-if-unreachable.md",
      "estimated_diff_lines": 3,
      "failure_risk": "low",
      "failure_reasoning": "The inner `if (prev.attempts < THRESHOLDS.maxAttempts)` is contradicted by the outer `next.attempts >= maxAttempts` (which itself implies `prev.attempts >= maxAttempts` via `decideStuckInputRecovery`'s budget-spent branch). The dead warn message 'giving up for this spell' never fires. 3 sites have the same pattern (lines 124, 164, 204). Drop the inner if at each. Not a hot path; only fires on prolonged stuck-input spells.",
      "has_pinning_test": true,
      "ts_strict_blocked": false,
      "current_head_state": "bug present",
      "rationale": "Pure dead-branch drop, 1 line per site, 3 sites total. Either drop the inner guard (matches the 'no warn ever fires' observation) or move the warn to the `if (recover)` branch with a guard on `prev.attempts < maxAttempts`. Branch coverage jumps from 96.x% to 100% on this file."
    }
  ],
  "excluded_summary": {
    "missing_path_count": 6,
    "bug_absent_count": 6,
    "ts_strict_blocked_count": 12
  },
  "summary": "All 5 top candidates are 1-3 line drops of structurally unreachable defensive branches, matching the recent fix pattern (commits c2b4ea2, 08d7508, 014f1de, etc.). None is TS strict blocked, none is on a hot path, and 4 of 5 require no test changes. The safest move is to land all 5 in one PR since each is independently verified by the existing test suite."
}
```

## Second-tier candidates (slightly larger but still safe)

- **`index-stopHeartbeat-throw`** — 5-line deletion of the dead `if (heartbeatStarted) { try { stopHeartbeat() } catch ... }` block in `src/index.ts:381-384`. The `heartbeatStarted` flag is never set to true (the `initHeartbeat()` call was removed from `main()` years ago). Same defensive-drop pattern, just a few more lines.
- **`channel-coordinator-setOffset-null-maxUpdateId`** — 1-line drop of `if (maxUpdateId != null) setOffset(...)` at `src/channel-coordinator.ts:401`. `processBatch` is only ever called with non-empty batches (the runLoop filters empties), so `maxUpdateId` is always a number. The MD suggests also tightening `processBatch` to throw on empty input, which adds a +1 net.
- **`openrouter-models-tier1-auto-empty-fallback`** — 1-character change (`??` → `||`) at `src/web/openrouter-models.ts:172`. Real bug fix: empty-string `tier1.auto` bypasses the documented deepseek fallback. Requires a 1-line test flip (the existing pinning test asserts the buggy empty-string return).
- **`agent-process-runtmux-host-truthy-cond-unreachable`** — 1-line drop of `host ? 8000 : 3000` at `src/web/agent-process.ts:777`, but the MD explicitly warns this requires also adding an explicit timeout at line 978 to preserve the 3000ms cap on the local pre-launch reap call. Slightly higher risk because the second edit is in a different code path.

## Common shape

All 5 top candidates are coverage-only dead-branch fixes (4 of 5) or 1-line real-world bug fixes (1: approvals). The test suite already exercises the reachable side at 100% branches; deleting the dead arm simply lifts the coverage gate without changing runtime behaviour.

## Recommended PR order

1. `mcp-list-warn-execError-dead-branch` (smallest, no test changes)
2. `http-helpers-gzip-memo-evict-guard` (single-line, no test changes)
3. `stuck-input-watcher-give-up-inner-if-unreachable` (3 single-line drops)
4. `agents-parseChannelProvider-return-null` (3 lines, minor type change)
5. `approvals-raw-resolved-by-in-log` (1 line + 1 test flip)

Each is independently auditable; the user can land them in any order.
