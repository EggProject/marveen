# C.1 AuthGate code-review Skipped #1 — wrapper removal

The `/code-review max --fix` run on 2026-09-08 identified the wrapper functions `resolveAuth`, `requiresAuth`, `isFederationWireEndpoint` in `src/web/auth-gate.ts` as dead-weight code (~12 lines that exist only to delegate to `defaultGate`). The fix was SKIPPED.

## Why skipped

Removing the wrappers would require refactoring 5 test files to use `createAuthGate` or `defaultGate` directly:
- `auth-gate.test.ts`
- `auth.test.ts`
- `auth-device-keys.test.ts`
- `bridge-enroll.test.ts`
- `auth-routes.test.ts`

The byte-equivalent migration surface is out of scope for the C.1 cycle.

## Anti-pattern context

`.claude/rules/class-vs-functional-decision.md` lists "wrapper-ök mint migration window" as anti-pattern ("ha nincs konkrét consumer aki a class formát használná, a wrapper-ök sosem kerülnek eltávolításra, csak élősködnek a kódon"). However, those wrappers have 5 concrete consumers (the test files above) — so the anti-pattern is partially mitigated. They are NOT parasites; they have active callers.

## Decision

Wrappers stay until a future cycle explicitly migrates the 5 test files. The C.1 commit `ebb7dba` and the fix-commit `3663c3e` keep them; the byte-equivalent call sites at the test layer are preserved.

## To revisit when

- Any test file refactor that touches these imports
- A cycle that needs to switch all 5 test files to factory form anyway
- A `class-vs-functional-decision` audit that flags the wrappers again

## Dual-write status

- Honcho conclusion `c1-authgate-code-review-skipped-wrapper-removal`: saved successfully
- This shared-memory file: created as backup per CLAUDE.md §7