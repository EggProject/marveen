# Error base class migration pattern (AppError), H.4 cycle

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

## Critical empirical finding (cause enumerability)

For classes with a `cause` parameter, the pattern must AVOID a
`public readonly cause` parameter property. Under
`useDefineForClassFields` semantics (TS target ES2022), the parameter
property emits a class-field `defineProperty` that runs AFTER
`super(message, { cause })` and overrides the ErrorOptions descriptor to
`enumerable: true`. Verified via `bun -e`:

- `class B extends A { constructor(public readonly cause) { super('m', { cause }) } }`
  -> `Object.keys(new B(new Error('y')))` is `['cause', 'name']`,
  `cause` descriptor `enumerable: true`.
- `class C extends A { constructor(cause) { super('m', { cause }) } }`
  -> `Object.keys(new C(new Error('y')))` is `['name']`,
  `cause` descriptor `enumerable: false`.

So the correct pattern for a class with cause is:

```ts
export class FederationPollInternalError extends AppError {
  constructor(public readonly peerId: string, cause: unknown) {
    super(`federation poller: internal error for peer ${peerId}`, { cause })
  }
}
```

The `cause` parameter is NOT a `public readonly` parameter property; it
is just a positional argument. `e.cause` is still readable on the
resulting instance (via `Error.prototype.cause` per ES2022 semantics).
The peerId field stays a parameter property because production callers
read `err.peerId`.

pino's `messageWithCauses(err)` and `stackWithCauses(err)` helpers
read cause via direct property access
(`pino-std-serializers/lib/err-helpers.js:21`); they don't care about
enumerability, so dropping the parameter property does NOT break pino
logging. The reverse claim in the original H.4 commit message
("parameter property is required for pino serialization") was
empirically wrong.

The MemoryStoreError pattern (`db.ts:3707`) was the precedent: a
constructor that forwards `options?: ErrorOptions` to super WITHOUT a
parameter property.

## vi.mock interaction

Three categories of vi.mock sites for these modules:

1. **`async (orig) => ({ ...real, ... })`**: passes through production class
   transparently, migration is invisible to the test.
2. **Local mock class redeclaration** (`class KeychainUnavailableError extends Error {}`):
   shadows the production class entirely, migration is invisible to the test.
3. **No mock at all** (process-lock.ts): the production class is used
   directly, `instanceof X` assertions still work because AppError sits
   in the prototype chain between the concrete subclass and Error.

None of these required test updates.

## Why this is the lowest-risk class-extract

- 1-line change per file (header comment + 1 extends + 1 import)
- The base class is already proven by 3 prior subclasses
- `instanceof X` byte-equivalent for ALL production callers sites
  (verified: src/index.ts:547, src/web/routes/fleet.ts:29,
  src/channel-coordinator.ts:335,338,366,372,378, src/web/routes/security.ts:95,
  src/web/routes/auth.ts:271,327, src/web/vault.ts:49, all preserved)
- No new imports across the module graph beyond the 7 new `AppError` imports
- Rollback is `git revert <sha>` for a single commit

## Pre-flight vs post-flight numbers

- typecheck: exit 0 to exit 0 (unchanged)
- targeted vitest (13-file subset): 423 to 479 pass (+56 from federation-poller
  addition; +10 new errors.test.ts cases = +56-10 = +46 from the 2 new files)
- full vitest: 11480 pass / 1 fail / 12 files failed to 11491 pass / 0 fail /
  11 files failed, IMPROVED, not regressed
- Lint diff-only: pre-existing scrypt template-literal errors in
  password-hash.ts (NOT introduced by this diff); the gate must be
  "diff-introduced 0 errors", not "diff file 0 errors"

## Anti-load-bearing check (corrected after code-review)

A follow-up code-review (`/code-review max`) caught that the original
implementation kept `public readonly cause: unknown` on
`FederationPollInternalError`, defeating the non-enumerability
invariant. The fix was to drop the parameter modifier. After the fix:
`expect(Object.keys(e)).not.toContain('cause')` PASSES on
FederationPollInternalError (matching the test (8) invariant for
`_ConcreteAppError`).

Going forward: for AppError subclasses with a `cause` field, the
constructor signature is `(..., cause: unknown)` (no `public readonly`
modifier on cause). The `cause` field is read via `e.cause` from
`Error.prototype`, not from a parameter property. The original claim
"never assert non-enumerability of cause on a class with a cause
parameter property, it's structurally impossible" was wrong; the
non-enumerability is achievable by not using a parameter property.

## Cross-reference

- Plan: `.claude/plans/whimsical-scribbling-garden.md`
- Commit: `(this commit)` (refactor/classbase)
- Honcho: `create_conclusion` saved