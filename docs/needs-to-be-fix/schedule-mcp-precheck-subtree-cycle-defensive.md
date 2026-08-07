# schedule-mcp-precheck.ts: collectSubtreeCmdlines cycle guard is only reachable through malformed ps output

## Location

`src/web/schedule-mcp-precheck.ts`, line 95 (inside `collectSubtreeCmdlines`).

```ts
while (stack.length) {
  const pid = stack.pop()!
  if (seen.has(pid)) continue
  seen.add(pid)
  ...
```

## Excerpt

The `if (seen.has(pid)) continue` branch is a defensive guard against
back-edges or duplicate `ps` rows: if the same pid is pushed onto the
walk stack from two different parents, the second pop must short-circuit
instead of re-recording the cmdline (or, worse, looping forever if the
tree is a real cycle).

This branch is unreachable on a healthy `ps` snapshot. Real `ps` output
from `/bin/ps -axo pid,ppid,command` does not produce a row whose
`ppid` field references a pid that has not yet been declared; even if
it did, the `ppid -> [pid]` index is a Map keyed by ppid, so two rows
with the same ppid+pid would simply add the same pid twice to one
parent's child array and the second push would short-circuit on the
`seen` check. The branch only fires when (a) the same pid is reachable
through two different parents -- a malformed snapshot -- or (b) the
snapshot contains a back-edge (parent's pid appears in the children of
its own descendant), which only happens with a synthetic / corrupted
ps buffer.

## Failure scenario

The defect is a coverage-only defect -- the branch is correct, and a
real `ps` snapshot cannot trigger it. The risk is that future code
maintenance breaks the guard and the branch stops short-circuiting,
making the walk O(infinite) on any cycle.

1. A future refactor moves the `seen.add(pid)` call to the end of the
   loop body (e.g. after `cmdlines.push(cmd)`), or replaces `seen.has`
   with a different check that misses the duplicate. The branch then
   never fires.
2. A live `/bin/ps` produces a row with a duplicated pid (e.g. a
   permission-denied process whose pid is reused). The walk enters an
   infinite loop.

To reach 100% branch coverage without modifying the source, the test
suite uses a synthetic PS snapshot with a back-edge: `200` (the root)
is also declared as a child of `201`, so the walk pops `200`, then
pops `201`, pushes `200` and `202`, pops `202`, then pops the queued
`200` -- which `seen.has` short-circuits. See the "terminates without
double-counting a pid that is reachable from two parents" test in
`src/__tests__/schedule-mcp-precheck-full.test.ts`.

## Pinning test

`src/__tests__/schedule-mcp-precheck-full.test.ts`, the
"collectSubtreeCmdlines -- defensive duplicate-pid branch" describe
block, constructs a PS snapshot with a back-edge and asserts that the
walk terminates with the expected cmdline list (no double-counted
200, no infinite loop).

## Suggested direction

The defensive guard is correct. The fix is to leave the source
unchanged and keep the test as a regression sentinel for the cycle
guard. No source modification is needed.

Per task rule "NEVER modify src/web/schedule-mcp-precheck.ts" the
source edit is blocked until the user overrides; the test suite
documents the gap and the test that exercises the cycle stays in
place alongside the (no-op) fix.
