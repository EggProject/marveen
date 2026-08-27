# hook-command-quoting.test.ts: 6 pre-existing assertion drift (NOT blanket-driven)

## Location

`src/__tests__/hook-command-quoting.test.ts`, lines 73, 89, 105, 127 + 2 more (the quoting + migration describe blocks).

## Failure scenario

These six tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). After the 16 per-file opt-in commits of 2026-08-27 closed the blanket-driven 74 fails, these 6 remain as the only `hook-command-quoting` failures.

None of the 6 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`. The test uses `hookCommand`, `hookCommandWired`, `ensureEgressGate`, `ensureGovernanceGateCommands` — none of these call `node:child_process`. The failures are pure in-memory assertion mismatches.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/hook-command-quoting.test.ts
 Test Files  1 failed (1)
      Tests  6 failed | 3 passed (9)
```

6 fails pre-existed on `a330462` (pre-forbid).

## Attempted fix

No source edit attempted. The drift is in the test assertion expectations (the expected hook-command string shape) vs the current implementation of `hookCommand` / `ensureEgressGate` / `ensureGovernanceGateCommands` in `src/web/agent-scaffold.ts`.

## Pinning test

The 6 failures are in three describe blocks:
- `injectors write a quoted absolute interpreter, never a bare node` (lines 73, 89, 105) — three `inject*Gate` tests asserting the interpreter path is absolute
- `hookCommandWired finds a freshly injected command (posix path)` (line 127) — `hookCommandWired` assertion
- `ensure* migrations are idempotent (true, then false)` — `ensureEgressGate` and `ensureGovernanceGateCommands` migration tests

## Suggested direction

Read `src/web/agent-scaffold.ts:hookCommand` and `ensureEgressGate` / `ensureGovernanceGateCommands`. Update the test expectations at lines 60-130 to match the current implementation's emitted hook-command string shape, OR fix the implementation.

## Resolution

Open. Deferred to the next cycle (cycle 54+).

## Scope

Pre-existing on `a330462` baseline. NOT introduced by `53a9f6c`. Filing this as a separate needs-fix item because it is orthogonal to the forbid-system-calls blanket.
