# governance-gates.test.ts: 3 pre-existing assertion drift (NOT blanket-driven)

## Location

`src/__tests__/governance-gates.test.ts`, lines 283, 293, 305 (the `governance gate scaffold wiring > injectSelfPaceGate` describe block).

## Failure scenario

These three tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). After the 16 per-file opt-in commits of 2026-08-27 closed the blanket-driven 74 fails, these 3 remain as the only `governance-gates` failures.

None of the 3 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`. They are pure in-memory `injectSelfPaceGate` assertions; the test imports `injectSelfPaceGate` from `../web/agent-scaffold.js`, a function that uses no `node:child_process` API.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/governance-gates.test.ts
 Test Files  1 failed (1)
      Tests  3 failed | 65 passed (68)
```

3 fails pre-existed on `a330462` (pre-forbid).

## Attempted fix

No source edit attempted. The drift is in the test assertion expectations vs the current `injectSelfPaceGate` implementation in `src/web/agent-scaffold.ts`.

## Pinning test

The 3 failures in `describe('governance gate scaffold wiring') > injectSelfPaceGate`:
- line 283: "is idempotent (no duplicate on respawn)"
- line 293: "the hook MATCHER fires on native file tools too (not just Bash)"
- line 305: "survives a respawn re-run, and NO operator-gate is wired"

## Suggested direction

Read `src/web/agent-scaffold.ts:injectSelfPaceGate` and the test expectations at lines 280-310. Update the test expectations to match the current implementation, OR fix the implementation to match the test expectations.

## Resolution

Open. Deferred to the next cycle (cycle 54+).

## Scope

Pre-existing on `a330462` baseline. NOT introduced by `53a9f6c`. Filing this as a separate needs-fix item because it is orthogonal to the forbid-system-calls blanket.
