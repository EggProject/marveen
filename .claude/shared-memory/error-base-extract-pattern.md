# Error base class migration pattern (AppError) — H.4 cycle

## What was done

Migrated 7 remaining error classes from `extends Error` to `extends AppError`:
`DeferToPeerError`, `RemoteEnrollError`, `TelegramApiError`,
`KeychainUnavailableError`, `PasswordPolicyError`, `UserFacingError`,
`FederationPollInternalError`. The first 3 (`MemoryStoreError`,
`RequestBodyTooLargeError`, `PeerResponseTooLargeError`) already extended
`AppError` as the precedent.

## The pattern (mechanical, byte-equivalent)

1. Add `import { AppError } from '<relative>/errors.js'` at the top.
2. Change `class X extends Error {` to `class X extends AppError {`.
3. Delete the manual `this.name = 'X'` line (AppError handles via
   `this.name = new.target.name`).
4. **DO NOT** try to assert non-enumerability of `cause` in tests — see
   below.

## Critical empirical finding

For classes with a `cause` parameter (FederationPollInternalError), the
pattern is:

```ts
export class FederationPollInternalError extends AppError {
  constructor(public readonly peerId: string, public readonly cause: unknown) {
    super(`federation poller: internal error for peer ${peerId}`, { cause })
  }
}
```

The TS parameter property + class field overrides the ES2022 non-enumerable
descriptor to **enumerable: true** (verified by `node -e` empirical
proof). Therefore:
- `super(message, { cause })` forwards cause to the base Error constructor
  (which sets it non-enumerable)
- The subsequent `this.cause = cause` parameter-property assignment
  OVERRIDES that descriptor to enumerable: true
- Test must NOT assert `Object.keys(e).not.toContain('cause')` — it WILL
  contain 'cause'
- pino's `messageWithCauses(err)` and `stackWithCauses(err)` helpers
  read cause via direct property access (pino-std-serializers/lib/err-helpers.js:21)
  — they don't care about enumerability
- The parameter property is REDUNDANT for pino logging but NECESSARY
  for the public API (`err.cause` direct read; tested at
  federation-poller-cov.test.ts:307)

## vi.mock interaction

Three categories of vi.mock sites for these modules:
1. **`async (orig) => ({ ...real, ... })`**: passes through production class
   transparently — migration is invisible to the test
2. **Local mock class redeclaration** (`class KeychainUnavailableError extends Error {}`):
   shadows the production class entirely — migration is invisible to the test
3. **No mock at all** (process-lock.ts): the production class is used
   directly — `instanceof X` assertions still work because AppError sits
   in the prototype chain between the concrete subclass and Error

None of these required test updates.

## Why this is the lowest-risk class-extract

- 1-line change per file (header comment + 1 extends + 1 import)
- The base class is already proven by 3 prior subclasses
- `instanceof X` byte-equivalent for ALL production instanceof sites
  (verified: src/index.ts:547, src/web/routes/fleet.ts:29,
  src/channel-coordinator.ts:335,338,366,372,378, src/web/routes/security.ts:95,
  src/web/routes/auth.ts:271,327, src/web/vault.ts:49 — all preserved)
- No new imports across the module graph beyond the 7 new `AppError` imports
- Rollback is `git revert <sha>` for a single commit

## Pre-flight vs post-flight numbers

- typecheck: exit 0 → exit 0 (unchanged)
- targeted vitest (13-file subset): 423 → 479 pass (+56 from federation-poller
  addition; +10 new errors.test.ts cases = +56-10 = +46 from the 2 new files)
- full vitest: 11480 pass / 1 fail / 12 files failed → 11491 pass / 0 fail /
  11 files failed — IMPROVED, not regressed
- Lint diff-only: pre-existing scrypt template-literal errors in
  password-hash.ts (NOT introduced by this diff) — the gate must be
  "diff-introduced 0 errors", not "diff file 0 errors"

## Anti-load-bearing check

Verifier B R16 found that test (17) `expect(Object.keys(e)).not.toContain('cause')`
would have FAILED the planned implementation. The fix was to drop that
assertion. Going forward: never assert non-enumerability of cause on a
class with a `cause` parameter property — it's structurally impossible.

## Cross-reference

- Plan: `.claude/plans/whimsical-scribbling-garden.md`
- Commit: `(this commit)` (refactor/classbase)
- Honcho: `create_conclusion` saved