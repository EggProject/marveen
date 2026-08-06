# reauth-healer.ts: two structurally unreachable arms at lines 391 and 395

## Location

`src/web/reauth-healer.ts`, lines 391 and 395.

```ts
// line 391, the stillDeadCount lambda passed to flushQuietSummary at the
// sweep() callsite
(session) => watchState.get(session)?.consecutiveDead ?? 0,

// line 395, the stampAlert lambda's conditional body (inside sweep)
if (st) watchState.set(session, { ...st, lastActionAtMs: Date.now() })
```

## Excerpt

Both arms are the unreachable side of an invariant the surrounding code
preserves. The two module-level Maps `watchState` and `quietSuppressed`
are mutated by the same three sites (every checkSession pass, the
sub-agent loop's `isAgentRunning(name) === false` branch, and the same
spot in main-agent checkSession). All three sites update `watchState`
and `quietSuppressed` together:

- `if (decision.next.consecutiveDead === 0) { watchState.delete(...); quietSuppressed.delete(...) }`
- `else { watchState.set(session, decision.next) }` (quietSuppressed untouched, but it was already set when escalate+quiet fired earlier -- same session)

So any session that lands in `quietSuppressed` is also in `watchState`
with `consecutiveDead > 0` (or will be on the next sweep). The two maps
are kept in sync at every mutation site; there is NO test-side lever
to desync them short of editing the source.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public
input.

1. `startReauthHealer()` schedules a sweep every 3 minutes. Each sweep
   drives each listed agent through `checkSession` (or skips it on
   `isAgentRunning(name) === false`, which clears BOTH maps).
2. After all checkSession calls return, `sweep()` calls
   `flushQuietSummary(quiet, stillDeadCount, sendNotify, stampAlert)`
   with the lambdas at lines 391 and 395 as `stillDeadCount` and
   `stampAlert` respectively.
3. `flushQuietSummary` calls `stillDeadCount(e.session)` for each entry
   in `quietSuppressed`. The entry survives the `> 0` filter only when
   `stillDeadCount` returns a positive number, which requires
   `watchState.get(session)` to be non-null with `consecutiveDead > 0`.
   So `stampAlert` is only ever invoked for a session that IS in
   `watchState` -- `if (st)` is necessarily true.
4. Therefore the `??` RIGHT arm (line 391, LHS nullish) and the
   `if (st)` FALSE arm (line 395) cannot be exercised through any
   sequence of public sweep calls. v8 records them as uncovered.

## Pinning test

`src/__tests__/routes-reauth-healer.test.ts` (the `describe('Pinning:
sweep callsite lambdas (lines 391, 395)')` block). Two assertions:

- `flushQuietSummary stamps all stillDead agents whose session IS in
  watchState (line 395 if-true arm)` -- drives 2 sub-agents through
  quiet hours, asserts the morning summary lists both, and pins the
  reachable arm as covered.
- `stillDeadCount lambda always sees watchState for sessions in
  quietSuppressed (line 391 ?? reachable arm proof)` -- drives
  4 agents (main + 3 sub), asserts every suppressed entry has a
  watchState partner, pinning the LEFT arm of `??` as the only one
  reachable.

The pinning tests pass today (the reachable arms ARE hit) and document
the structural reason the dead arms cannot fire. If the source were
restructured to expose either arm, these tests would need a rewrite --
but the dead arms WOULD start being covered.

## Suggested direction

Three reasonable fix-ups. Any one is fine; together they would bring
the file to 100% coverage without changing behaviour.

(a) **Drop the `?? 0` and replace with a non-null assertion.** The map
    is kept in sync structurally (see above); replacing the conditional
    with `(watchState.get(session)?.consecutiveDead ?? 0)` AND a
    documented invariant comment lets the v8 understand the false arm
    is dead. Better: pass the watchState lookups directly as a tuple
    `(consecutiveDeadFor: (s: string) => number) => number` prepared
    ONCE before the loop, so the null-check only fires for entries
    outside the known set.

(b) **Move the stampAlert into `flushQuietSummary`'s source.** The
    `if (st)` was added at the sweep callsite but the `st ? set : skip`
    policy is a property of `flushQuietSummary` itself (it already
    filters by `consecutiveDead > 0`). Lifting the stamp into
    `flushQuietSummary` and dropping the callsite branch removes the
    dead arm without behaviour change.

(c) **Annotate with `/* v8 ignore next */` if the file-level pattern
    permits.** v8 supports per-line ignore comments and the dead arms
    could be marked. This codebase does not currently use the pattern
    elsewhere -- prefer (a) or (b) instead.

Per task rule "NEVER modify src/web/reauth-healer.ts" the source edits
are blocked until the user overrides; the new suite documents the gap
and pins every reachable sibling branch.
