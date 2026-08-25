# message-router.ts: cached session-lookup `??` fallback arms are unreachable

**Status:** UNRESOLVED. The 2026-08-24 attempt (commit `6e08cf4`) to apply option (b) via a vitest per-glob threshold override (`'src/web/message-router.ts': { branches: 97 }`) was verified empirically to be a structural no-op: with `perFile: true`, vitest still checks every file against the global 100% threshold regardless of glob membership (vitest source `node_modules/vitest/dist/chunks/coverage.DM_a_rWm.js:837`: "Global threshold is for all files, even if they are included by glob patterns"), so message-router.ts at 97.82% branches still fails the 100% global check and `bun run coverage` exits non-zero. The per-glob entry only ADDS a second, looser check; it never relaxes the global one. `eb9b951` reverted in `2ec1c99` so the file is back to the pre-fix `cached?.X ?? Y` shape, but neither option (a) nor option (b) has actually been made to work. The narrative below is preserved as the historical record of option (a).

## Status: PARTIAL -- 2026-08-18

eb9b951 applied option (a) (drop the `??` arms, warn on invariant
violation), but the claim "Branch coverage reaches 100% with no test
changes" is FALSE. Coverage run on 2026-08-18 against the post-fix code:

```
message-router.ts | 98.57 stmts | 97.79 branch | 100 func | 99.25 line | 479-480 uncovered
```

The new `if (!cached) { warn; continue }` branch is exactly as
structurally unreachable as the three `??` arms it replaced. The fix
relocated the uncovered branch instead of removing it, AND it converted
three uncovered branches (defensive arms) into uncovered STATEMENTS
and LINES (lines 479-480 are never executed). The 100% thresholds in
`vitest.config.ts` now fail harder than before:

- statements: 100% target -> 98.57% (regression, was 100% before fix)
- lines: 100% target -> 99.25% (regression, was 100% before fix)
- branches: 100% target -> 97.79% (no change in shape, still uncovered)

Worse: the new silent `continue` at line 480 drops the message without
any of the bookkeeping the old fallback performed (abandon-window
check, `markMessageFailed`, `notifyOrchestratorOfFailedHandoff`,
`routerLoggedMisses.delete`, `routerInjectFailures.delete`). The
docstring invariant at lines 70-76 -- "never-silent handoff-failure
signal" -- would be silently broken if the cache ever missed. The
unreachable branch is now actively dangerous in addition to uncovered.

## Location

`src/web/message-router.ts`, lines 477-482 (inside `runMessageRouterTick`).

```ts
const cached = agentSessionCache.get(msg.to_agent)
if (!cached) {
  logger.warn({ to: msg.to_agent }, 'message-router: receiver not in cache (should never happen)')
  continue
}
const { session, host, exists: sessionExists } = cached
```

(Pre-fix shape: three `??` arms at the same spot, arms never fired.)

## Excerpt

The `if (!cached)` arm is the fallback when `agentSessionCache.get(...)`
returns `undefined`. It is dead code through the public path: the cache
is populated for every receiver in `receiversInTick` on the same tick
the loop body iterates, and `receiversInTick` is built from the same
`pending` slice the loop walks. The cache lookup always wins.

## Failure scenario

Coverage-only at runtime, since cache miss is unreachable through
public input. The reachable consequences are the CI threshold failures
and the silent-drop behavior described above if the invariant ever
breaks.

1. A caller drives `runMessageRouterTick` with a non-empty `pending`
   slice.
2. The pre-pass walks `pending`, extracts every `to_agent` (other than
   `MAIN_AGENT_ID`) into `receiversInTick`, and calls
   `sessionExistsOnHost` once per unique receiver to populate
   `agentSessionCache`.
3. The loop body iterates over `pending`. For each message it does
   `agentSessionCache.get(msg.to_agent)`, which always finds the entry
   written two phases earlier. Lines 478-481 never execute.

The only way to flip the guard is to make `receiversInTick` empty while
`pending` is non-empty. That requires the loop body's message to have a
`to_agent` that the pre-pass skipped. The pre-pass skips exactly one
value: `MAIN_AGENT_ID`. And the main-agent path is short-circuited on
the wakeup path long before the cache lookup. There is no remaining
input.

## Pinning test

`src/__tests__/message-router-full.test.ts:1191` is the
`describe('runMessageRouterTick')` pinning test whose label was renamed
on 2026-08-24 (this batch) to
`'does NOT send when the cached sessionExists is false'`. The previous
label, `'falls back to a direct sessionExistsOnHost when the receiver is
not in the cache'`, described the intent of the unreachable `??` fallback
arms and the test BODY's first assertion is the opposite; the new label
describes the actual behavior. An earlier rename (2026-08-18, 8209fb3)
to `'reads session existence directly from the pre-pass cache (no ?? fallback)'`
was reverted in `f67efca` after the source-side option (a) it documented
(`eb9b951`) was itself reverted in `2ec1c99`. The test BODY
(lines 1192-1219) remains the canonical pinning test for the cache-wins
path: the mock makes `sessionExistsOnHost` return absent on the first
call and present on subsequent calls, then the assertion that
`sendPromptToSession` is NOT called and `logWarn` fires with the "target
session not running, will retry" payload confirms the cache always wins.

## Suggested direction

To actually hit 100% coverage, the unreachable branch has to disappear
from the source. Two real options:

(a) Refactor the cache type to make the invariant compile-time: a
    helper `lookupAgentSession(agentName): {host, session, exists}` that
    throws on miss, plus the loop body just calls it. Removes the
    optional chain entirely. The throw would be unreachable but it
    would be a single statement without an `if`/branch pair, so
    istanbul's line/branch coverage wouldn't have anything to skip.
    Caveat: the throw arm itself is a line, so the throw must be
    eliminated too -- e.g. by computing host/session/exists inline and
    inlining the helper's body into the loop. Net: the cache becomes a
    plain object, not a Map.

(b) Revert eb9b951 and accept that this file cannot reach 100% branch
    coverage without changing the data structure. Lower the threshold
    for `message-router.ts` to the documented unreachable count. This
    is what the file actually wants; the `??` arms being uncovered was
    a known trade-off, not a bug.

Either way, the current state -- three uncovered branches replaced by
an uncovered `if` with worse statement/line coverage and a silent-drop
regression risk -- is strictly worse than the pre-fix state.

Per task rule "NEVER modify src/web/message-router.ts" the deeper
refactor is blocked until the user overrides.

## Resolution (2026-08-25, commit 900cdb6)

Three of the four cache-fallback unreachable branches were removed at
lines 481-483: the `?? agentSessionName(...)`, `?? readAgentRemoteHost(...)`,
and `?? sessionExistsOnHost(...)` RHS arms were dropped, and a non-null
assertion (`!`) was added to the `agentSessionCache.get(msg.to_agent)`
result (a TS type assertion, not a branch). The source comment at lines
477-480 was reworded to describe the cache-wins invariant without
referencing the removed fallback.

Post-edit measurement on the worktree (full suite, istanbul coverage):

```
src/web/message-router.ts | branches 97.82% -> 99.24%
```

72 of 72 targeted tests in `src/__tests__/message-router-full.test.ts`
pass; no new failures introduced. Pre-existing failures on `bb879a8`
(75 across 18 files from the global `forbid-system-calls` setup, plus
TS errors in the test file at lines 151/179/366/etc.) are unchanged.

The 0.76% residual is a single uncovered branch: the `isMainAgent ===
true` arm of the `isMainAgent ? null : cached.host` ternary at line
483. This arm is structurally unreachable through the public SUT --
main-agent messages short-circuit at lines 464-475 with `continue`
before reaching line 483 -- but removing it would either drop the
defensive `null` (risky: a future caller that bypasses the short-
circuit would crash on `cached!`) or shift the unreachable path into
a comment (out of scope for this batch).

The deeper refactor (option (a) in this MD's "Suggested direction"
section) was applied in the minimal form: drop the `??` arms, accept
the `isMainAgent` ternary as a load-bearing defensive guard, leave the
per-glob override absent (it is a structural no-op with `perFile:
true` per `vitest.config.ts:48-65`).

Status: **Partially resolved** (3 of 4 cache-fallback unreachable
branches removed; 1 `isMainAgent` ternary branch deferred; file-level
branch coverage 97.82% -> 99.24%). Full closure of the 100% branch-
coverage gate requires a separate edit to address the `isMainAgent`
ternary.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
