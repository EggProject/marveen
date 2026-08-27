# email-send-gate.test.ts: 3 pre-existing assertion drift (NOT blanket-driven)

## Location

`src/__tests__/email-send-gate.test.ts`, lines 72, 84, 99 (the `injectEmailSendGate` describe block).

## Failure scenario

These three tests were already failing on the `a330462` baseline (which does NOT have the `53a9f6c` global forbid). After the 16 per-file opt-in commits of 2026-08-27 closed the blanket-driven 74 fails, these 3 remain as the only `email-send-gate` failures.

None of the 3 failure stack traces includes `src/__tests__/setup/forbid-system-calls.ts:67:5`. They are pure in-memory `injectEmailSendGate` assertions; the test imports `injectEmailSendGate` from `../web/agent-scaffold.js`, a function that uses no `node:child_process` API at all.

## Empirical baseline evidence

```
$ git -C /tmp/claw-test-baseline-a330462 bun --bun vitest run src/__tests__/email-send-gate.test.ts
 Test Files  1 failed (1)
      Tests  3 failed | 7 passed (10)
```

3 fails pre-existed on `a330462` (pre-forbid).

## Attempted fix

No source edit attempted. The drift is in the test assertion expectations vs the current `injectEmailSendGate` implementation in `src/web/agent-scaffold.ts`. The test expectations (lines 72, 84, 99) need to be updated to match the current implementation, OR the implementation needs to match the test expectations.

## Pinning test

The 3 failures in `describe('injectEmailSendGate')`:
- line 72: "adds the PreToolUse email-gate hook"
- line 84: "is idempotent (no duplicate entries on re-apply / respawn)"
- line 99: "preserves existing hooks (e.g. PreCompact) and other PreToolUse entries"

## Suggested direction

Read the test file lines 60-110 to see the expected hook-command string, and the current `injectEmailSendGate` implementation in `src/web/agent-scaffold.ts` to see what it actually emits. Update one or the other to match.

## Resolution

Open. Deferred to the next cycle (cycle 54+).

## Scope

Pre-existing on `a330462` baseline. NOT introduced by `53a9f6c`. Filing this as a separate needs-fix item because it is orthogonal to the forbid-system-calls blanket and cannot be addressed by per-file `vi.importActual('node:child_process')`.
