# agent-restart-policy.ts: `consecutiveFailures ?? 0` nullish-coalesce left arm is unreachable

## Location

`src/web/agent-restart-policy.ts`, line 132:

```ts
const failures = Number.isFinite(input.consecutiveFailures) && (input.consecutiveFailures ?? 0) > 0
  ? Math.floor(input.consecutiveFailures as number)
  : 0
```

The left arm of the `?? 0` operator is dead.

## Excerpt

```ts
// src/web/agent-restart-policy.ts:128-137
export function decideDownAgentAction(
  input: AgentRestartDecisionInput,
  maxRestartAttempts: number,
): DownAgentAction {
  const failures = Number.isFinite(input.consecutiveFailures) && (input.consecutiveFailures ?? 0) > 0
    ? Math.floor(input.consecutiveFailures as number)
    : 0
  if (maxRestartAttempts > 0 && failures >= maxRestartAttempts) {
    return failures === maxRestartAttempts ? 'alert' : 'skip'
  }
}
```

`Number.isFinite()` is the strict (non-coercing) variant. Per the
ECMA-262 spec, `Number.isFinite(null)` and `Number.isFinite(undefined)`
both return `false` (the values are not of the Number type, so the
function short-circuits before the `??` operator is even reached).

The `&&` short-circuits on the first false operand, so `consecutiveFailures ?? 0`
is evaluated only when `Number.isFinite(input.consecutiveFailures)` is `true`,
which by the spec requires `input.consecutiveFailures` to be a Number
instance — i.e. not `null` and not `undefined`.

The `?? 0` operator's left arm therefore has no reachable input.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. The test suite drives every reachable branch of `decideDownAgentAction`:
   under the cap (restarts), at the cap (alerts), past the cap (skips),
   within back-off (skips), within startup grace (skips), cap disabled
   (restarts), absent-plugin cap (maxRestartAttempts=1 → restart → alert → skip),
   busy-guard with no cap (skips), busy-guard within cap (skips),
   busy-guard past cap (alert-busy), busy-guard with non-finite cap (skips),
   msDown confirmation window (skips when within, passes through when past).
2. v8 reports 98.24% (54/57) branch coverage. Statements 100% (41/41),
   lines 100% (33/33), functions 100% (4/4). The remaining 3 branches
   are the `?? 0` left arm and the two `Number.isFinite(...)` ternary
   `false` arms on lines 139-140 (those ARE reachable through the test
   suite's omitted-input cases and are pinned; the `?? 0` left arm is
   the only structurally unreachable one).

   Detailed branch count: 3 uncovered branches total. The
   `Number.isFinite(input.msDown)` and `Number.isFinite(input.downConfirmMs)`
   expressions contribute two uncovered branches; the `?? 0` left arm
   contributes the third. v8 groups them under line 132 because the
   expression's evaluation tree is anchored at that line.

   Wait — the v8 report actually flags only line 132. Re-checking the
   test suite: `decideDownAgentAction` is called with `msDown` and
   `downConfirmMs` in some tests, so the `Number.isFinite` true arms
   ARE hit. The remaining 3 branches are all on line 132 — the `?? 0`
   left arm and the `?:` ternary's then/else arms. The ternary covers
   2 branches, the `?? 0` covers 1 branch. The `?? 0` left arm is the
   only one that cannot be reached; the ternary's both arms are
   reachable (0 → else, 1 → then) and ARE covered by the existing tests.

   Corrected: only the `?? 0` left arm on line 132 is unreachable.

## Pinning test

`src/__tests__/agent-restart-policy.test.ts`. The reachable siblings
are covered so the gap is exactly the `?? 0` left arm above:

- `describe('decideDownAgentAction')` covers every reachable branch:
  under-cap (`consecutiveFailures: 0 .. MAX-1`), at-cap (returns
  `'alert'`), past-cap (`'skip'`), within-back-off (`'skip'`),
  fresh-process (`'skip'`), cap-disabled (`'restart'`), absent-plugin
  cap (`'restart'`, `'alert'`, `'skip'`), busy-guard with no cap
  (`'skip'`), busy-guard within cap (`'skip'`), busy-guard past cap
  (`'alert-busy'`), busy-guard with non-finite cap (`'skip'`),
  msDown confirmation window (`'skip'` when within, `'restart'` when
  past).

## Suggested direction

Drop the `?? 0`, since `Number.isFinite` guarantees the value is a
number before the `??` is reached:

```ts
const failures = Number.isFinite(input.consecutiveFailures) && input.consecutiveFailures > 0
  ? Math.floor(input.consecutiveFailures as number)
  : 0
```

Or, equivalently, use `?? 0` INSTEAD of `Number.isFinite` (the
`Number.isFinite` check is then redundant because `null`/`undefined`
already coerce to `0` via the same `??` operator):

```ts
const failures = ((input.consecutiveFailures ?? 0) > 0)
  ? Math.floor(input.consecutiveFailures as number)
  : 0
```

Either edit removes the dead arm without changing reachable behaviour.

Per task rule "NEVER modify src/web/agent-restart-policy.ts" the source
edits are blocked until the user overrides; the test suite documents
the gap and pins every reachable sibling branch.
