# Plan: Cycle 37 - smallest needs-fix items with possible failure risk

## Context

Branch `test/baseline`, HEAD `537b374`, working tree clean, local only (no push).
Recent work: cycle 35 (context-guard-runner dead code + 3 critical runtime bugs
caught by code-review skill), cycle 36 (codebase comment cleanup, 18 residual
card references audited).

**Measured state (Pattern 112):**
- `git rev-parse HEAD`: `537b374282a0d48ed03243b7ff227f3796655d2e`
- `bun --bun tsc --noEmit | wc -l`: 2254 errors (baseline)
- 178 MD files in `docs/needs-to-be-fix/`; INDEX has 177 rows
- Cycle 36 left 7 MDs unresolved (excluding "Documented only" and "Deferred"):

## Candidate Analysis

Read each MD and source excerpt to confirm scope and risk. Categorized as:

### BLOCKED (task rule "NEVER modify X")
These are blocked by the explicit task rule and require user override per
the MD itself. Not the smallest-with-risk set:
- `web-watchdog-survives-close` (web.ts) - blocked
- `web-worker-warmup-ignores-close` (web.ts) - blocked
- `web-port-reclaim-failure-leaves-unbound` (web.ts) - blocked
- `keychain-store-insecure-acl` (keychain.ts) - blocked + already attempted in cycle 16, reverted
- `federation-inbox-fedPeer-null-fallback` (federation.ts) - blocked
- `agent-team-trustfrom-nullish-coalesce` (agent-team.ts) - blocked
- `index-unreachable-coverage` (index.ts) - blocked; line 283 has TS+test pin

### DEFERRED (out of budget per the MD itself)
- `agent-team-trustfrom-required-type-narrow-deferred` - +13 type errors, 12 test literal edits
- `federation-routes-fedpeer-required-type-narrow-deferred` - +71 type errors, too costly

### ACTIONABLE - Smallest with real risk

**A) `env-update-duplicate-key-lost`** (`src/env.ts:68-80`)
- Severity: Medium (silent config value loss in `.env`)
- Scope: ~10-line change in `updateEnvFile` (writer-dedups so all duplicate
  occurrences get rewritten, or last-wins; suggested option 1: writer
  dedup + warn log)
- Pinning test: `src/__tests__/env.test.ts:197` -- currently asserts the
  buggy behaviour; must be inverted (read returns `'UJ'`, file has no
  duplicate)
- Risk: medium (writes to .env, but test sandbox via `CLAUDECLAW_ENV_DIR`
  is already in place per line 11)
- Size: **smallest** (single function, single test inversion)

**B) `recall-dayofweek-noon-utc-far-east-skew`** (`src/web/routes/recall.ts:21-31`)
- Severity: Medium (timezone off-by-one for UTC+12+ installs)
- Scope: refactor 3 small functions (`dayOfWeekBudapest`, `addDays`,
  `budapestDate`) so they anchor at LOCAL noon, not UTC noon
- Pinning test: `src/__tests__/recall.test.ts` "first week of all 12 months
  starts on the same weekday"; currently holds only for UTC and Europe zones
- Risk: medium (timezone math; wrong anchor = still buggy)
- Size: **small** (single file, well-defined fix per MD's suggested direction)

**C) `channel-poller-reap-botpid-killed-without-identity-check`**
(`src/web/channel-poller-reap.ts:76-88,202-230`)
- Severity: Medium (silent kill of wrong process on pid-reuse)
- Scope: 1-line semantic change at reap call site -- only trust `bot.pid`
  if the env scan corroborates it (both pieces already exist)
- Pinning test: `src/__tests__/channel-poller-reap.test.ts` -- currently
  asserts the buggy behaviour; must be inverted (`reaped: []`)
- Risk: medium (correctness fix; could regress actual orphan reaping if
  the env-scan check is too strict -- but the MD argues env-scan is a
  superset)
- Size: **small** (3-line change)

**D) `web-inbound-probe-respawn-grace`** (`src/web/inbound-probe.ts`)
- Severity: Defect with coverage impact (4 tests fail to drive respawn paths)
- Scope: dynamic vs static import refactor; 3 possible approaches
- Pinning test: 4 tests currently fail-by-design (NOTE comments)
- Risk: medium-high (vitest mock resolution is fragile; the dynamic import
  is documented as avoiding a circular dep)
- Size: small-medium, but riskier

### ACTIONABLE - Higher risk (not "smallest")

**E) `profiles-traversal-id`** - HIGH severity security
**F) `routes-memories-put-skips-validation`** - HIGH severity security
**G) `google-api-refresh-race`** - HIGH severity concurrency

These are higher risk / scope; not the "smallest" set per the user's request.

## Recommendation

Three truly-small items with real risk and clear fix paths:
**A (env-update-duplicate-key-lost), B (recall-dayofweek), C (channel-poller-reap)**.

Each is in a different file with different root cause -- no fix can interact
with another. Can be sequenced as 3 atomic commits in 1 workflow.

**Why not combine all three in one commit:** the established convention
(cycles 34/35) is one-bug-per-commit. Combining would obscure which fix
regressed if something breaks. The workflow pattern catches per-commit
failures better.

**Why not include D:** the web-inbound-probe-respawn-grace refactor
(3 options, dynamic import is fragile, vitest mock resolution keys on
path string) carries the most risk per MD's own analysis. Keep it for
the next cycle when its fix path is settled.

## Plan

User confirmed: A+B+C scope, **3 separate workflows** (one per bug), each
self-contained with its own verify gate. After all 3 complete, run
`/code-review max --fix 537b374..HEAD`.

### Workflow A - env-update-duplicate-key-lost

```
Phase 1: Baseline
  - Confirm HEAD = 537b374, working tree clean
  - Read src/env.ts:1-89 in full
  - Read src/__tests__/env.test.ts:197 region in full (the PINNED BUG test)

Phase 2: Double-verify (2 Explore agents, per user's standing rule)
  - Agent 1: verify the bug is still as the MD describes; grep for any
    callers of updateEnvFile / readEnvFile that might rely on the
    current "first-wins writer" semantics
  - Agent 2: cross-check Agent 1's claim + grep for any test that
    constructs a duplicate-key .env and expects the bug behaviour to
    stay
  - Reconcile both reports before any commit

Phase 3: Apply fix
  - src/env.ts:68-80 -- writer-dedup (rewrite ALL occurrences of the
    matching key, not just first); warn log on duplicate
  - src/__tests__/env.test.ts:197 -- invert assertion:
    * `readEnvFile().TOKEN === 'UJ'`
    * the second `TOKEN=regi` row either removed or rewritten to 'UJ'
  - Confirm: bun --bun vitest run src/__tests__/env.test.ts (green)

Phase 4: docs + commit + verify
  - docs/needs-to-be-fix/INDEX.md -- mark row `Resolved: <date> <sha>`
  - git commit, no push
  - bun --bun tsc --noEmit | wc -l -- must equal 2254 (no new errors)
```

### Workflow B - recall-dayofweek-noon-utc-far-east-skew

```
Phase 1: Baseline
  - Read src/web/routes/recall.ts:1-50 in full
  - Read src/__tests__/recall.test.ts in full

Phase 2: Double-verify (2 Explore agents)
  - Agent 1: confirm the bug reproduces per the MD's TZ table;
    verify APP_TZ is configurable (env SCHEDULER_TZ + fallback) so
    the fix must use the runtime zone, not a hardcoded one
  - Agent 2: identify any caller of dayOfWeekBudapest / addDays /
    budapestDate that may pass a dateStr in a non-ISO form
  - Reconcile both reports before any commit

Phase 3: Apply fix
  - src/web/routes/recall.ts:21-31 -- introduce `zonedNoon(dateStr)`
    helper (instant 12:00 IN TZ); use it in both dayOfWeekBudapest
    AND addDays so they share the anchor
  - src/__tests__/recall.test.ts -- strengthen the TZ sweep:
    add Pacific/Auckland and Pacific/Kiritimati to the existing
    "first week of all 12 months" loop
  - Confirm: bun --bun vitest run src/__tests__/recall.test.ts (green)

Phase 4: docs + commit + verify
  - docs/needs-to-be-fix/INDEX.md -- mark row `Resolved: <date> <sha>`
  - git commit, no push
  - bun --bun tsc --noEmit | wc -l -- must equal 2254 (no new errors)
```

### Workflow C - channel-poller-reap-botpid-killed-without-identity-check

```
Phase 1: Baseline
  - Read src/web/channel-poller-reap.ts:76-88 + 202-230 in full
  - Read src/__tests__/channel-poller-reap.test.ts in full

Phase 2: Double-verify (2 Explore agents)
  - Agent 1: confirm both `readBotPid` and `listPollerPidsByStateDir`
    exist and the env-scan is a superset of bot.pid per the MD's claim;
    identify any production caller of reapChannelOrphans that relies
    on the uncorroborated kill
  - Agent 2: cross-check Agent 1 + grep for any test that asserts the
    current "uncorroborated bot.pid is killed" behaviour aside from
    the pinning one
  - Reconcile both reports before any commit

Phase 3: Apply fix
  - src/web/channel-poller-reap.ts -- `fromBotPid = botPid != null &&
    fromEnvScan.includes(botPid) ? botPid : null` at the call site
  - src/__tests__/channel-poller-reap.test.ts -- invert the PINNING
    test: expected `reaped` becomes `[]` when env scan has no row
  - Confirm: bun --bun vitest run src/__tests__/channel-poller-reap.test.ts
    (green)

Phase 4: docs + commit + verify
  - docs/needs-to-be-fix/INDEX.md -- mark row `Resolved: <date> <sha>`
  - git commit, no push
  - bun --bun tsc --noEmit | wc -l -- must equal 2254 (no new errors)
```

### After all 3 workflows

```
- git log --oneline 537b374..HEAD -- expect 3 commits + INDEX.md docs
  updates (may be co-located with the fix commits)
- /code-review max --fix 537b374..HEAD (mandatory per user's standing rule)
- Address any findings the skill raises; commit + re-verify
- No git push (per CLAUDE.md rule)
```

### Files to be modified (paths only)

- `src/env.ts` (Phase 3)
- `src/__tests__/env.test.ts` (Phase 3)
- `src/web/routes/recall.ts` (Phase 4)
- `src/__tests__/recall.test.ts` (Phase 4 -- strengthen TZ sweep)
- `src/web/channel-poller-reap.ts` (Phase 5)
- `src/__tests__/channel-poller-reap.test.ts` (Phase 5)
- `docs/needs-to-be-fix/INDEX.md` (Phase 6)
- No changes to `src/web.ts`, `src/web/keychain.ts`,
  `src/web/routes/federation.ts`, `src/web/agent-team.ts`, `src/index.ts`
  (those are blocked by task rule)

### Verification end-to-end

After all phases, before declaring done:
1. `git diff 537b374..HEAD --stat` -- see the 3-commit footprint
2. `bun --bun tsc --noEmit 2>&1 | wc -l` -- 2254 (no regression)
3. `bun --bun vitest run` -- all green
4. Final workflow: `/code-review max --fix 537b374..HEAD` per user's
   standing instruction

## User decisions

- Scope: **A + B + C** (env + recall + channel-poller-reap)
- Execution: **3 separate workflows**, one per bug
- Skip D (web-inbound-probe-respawn-grace) until next cycle

## Risks to verify in each workflow's Phase 2

- **A:** writer-dedup changes file content (MD's option 1 caveat);
  ensure CLAUDECLAW_ENV_DIR sandbox already covers the test path
- **B:** `dayOfWeekBudapest` and `addDays` MUST share the new anchor
  (zonedNoon) -- otherwise the two skews still don't cancel
- **C:** the env-scan is a superset by construction per the MD; verify
  no production caller relies on uncorroborated bot.pid kill
