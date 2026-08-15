# claude-credentials-guard.ts: line 224 `?? ''` fallback is dead code

## Location

`src/web/claude-credentials-guard.ts`, line 224, inside
`syncFleetTokenFromSharedCredentials`.

```ts
if (!isPromotableSetupCredential(cred, Date.now())) return 'not-setup-token'
const accessToken = (cred.accessToken ?? '').trim()         // <-- line 224
```

## Excerpt

`isPromotableSetupCredential` (line 185) already enforces the same
default-fallback two lines earlier:

```ts
export function isPromotableSetupCredential(
  cred: { accessToken?: string; expiresAt?: number },
  nowMs: number,
): boolean {
  if (!looksLikeSetupToken((cred.accessToken ?? '').trim())) return false
  if (typeof cred.expiresAt !== 'number') return false
  return cred.expiresAt - nowMs >= MIN_PROMOTABLE_LIFETIME_MS
}
```

`looksLikeSetupToken('')` is `false` (the regex `/^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/`
rejects the empty string). So:

- `cred.accessToken === undefined`  ->  `(undefined ?? '').trim() === ''`  ->  `looksLikeSetupToken('') === false`  ->  `isPromotableSetupCredential` returns `false`  ->  `syncFleetTokenFromSharedCredentials` returns `'not-setup-token'` on line 223.
- `cred.accessToken === null`       ->  same path.
- `cred.accessToken === ''`         ->  same path.

Every possible input where the `?? ''` fallback on line 224 would actually
fire short-circuits at the earlier `isPromotableSetupCredential` check.
The `?? ''` on line 224 is unreachable.

## Failure scenario

None in production. The branch is a redundant defensive guard. It only
shows up as "branch not covered" in v8 coverage because the branch
exists at the source level even though no input can ever exercise it.

This blocks the 100% branch-coverage threshold in `vitest.config.ts`.

## Pinning test

`src/__tests__/claude-credentials-guard.test.ts`, two tests in the
`branch coverage -- default-value fallbacks` describe block:

> `syncFleetTokenFromSharedCredentials: pinning -- the (cred.accessToken ?? "") fallback is unreachable in the current SUT`

Pins the early-return behaviour: a credentials.json with no `accessToken`
field under `claudeAiOauth` (and a valid long-lived `expiresAt`) returns
`'not-setup-token'`, NOT `'synced'`.

> `does NOT propagate the isPromotableSetupCredential override into syncFleetTokenFromSharedCredentials`

Documents that even with `vi.doMock('../web/claude-credentials-guard.js', ...)`
replacing the export, the SUT's `syncFleetTokenFromSharedCredentials`
keeps returning `'not-setup-token'` -- the internal binding to
`isPromotableSetupCredential` is captured at module-eval time and cannot
be patched through the mock factory. This proves the `?? ''` on line 224
is unreachable: not just in production, but in every possible test
configuration.

## Suggested direction

Remove the `?? ''` from line 224. The accessToken is guaranteed to be a
non-empty setup-token string by the time control reaches that line, so
the fallback is provably dead.

```diff
-    const accessToken = (cred.accessToken ?? '').trim()
+    const accessToken = cred.accessToken.trim()
```

After the fix, the v8 branch counter drops by one and coverage reaches
100% without any test gymnastics. The pinning test should be kept (it
documents the early-return contract); the "does NOT propagate" test
should be deleted once the source change is in (it documents a workaround
that no longer applies).

## Resolution (2026-08-15, commit cd1bc00)

Closed in `refactor: drop dead \`?? ''\` arm in claude-credentials-guard.ts:224`
(cd1bc00).

What changed:

- `src/web/claude-credentials-guard.ts:185` -- `isPromotableSetupCredential`
  now returns `cred is { accessToken: string; expiresAt: number }` (a real
  TypeScript type predicate). The function already enforced both
  invariants inline; the predicate just surfaces them to the caller.
- `src/web/claude-credentials-guard.ts:224` -- `accessToken` is now read
  as `cred.accessToken.trim()` with no `?? ''` fallback. The type
  predicate proves `accessToken` is a non-empty `string` by the time
  control reaches that line, and the `.trim()` is still there to strip
  surrounding whitespace from terminal-pasted setup-tokens.

Upstream-validation argument:

The original bug MD observed that `isPromotableSetupCredential` already
runs `(cred.accessToken ?? '').trim()` through `looksLikeSetupToken` two
lines earlier, and `looksLikeSetupToken('')` returns `false`. The
refactor commits to that argument by making it part of the function's
type contract: the function's return type now proves both `accessToken`
and `expiresAt` are present and well-typed at every successful exit, so
no defensive fallback is needed at the call site.

Pinning test (`pins: trims surrounding whitespace from accessToken before
writing the fleet token file`): a credentials.json with a
whitespace-padded `oat` token asserts the fleet token file ends up
holding the clean `oat`. A mutation check confirmed the assertion fails
when `.trim()` is dropped from line 224 (the padded token slips through
to the fleet file as a malformed `--bearer-token`).

The synthetic test at `src/__tests__/claude-credentials-guard.test.ts`
lines 1085-1125 (`line 224 unreachable branch investigation` describe
block, `does NOT propagate the isPromotableSetupCredential override into
syncFleetTokenFromSharedCredentials`) was deliberately KEPT -- it still
passes against the new code (the `vi.doMock` override still does not
propagate into the SUT's internal binding) and it documents a
non-obvious test-harness invariant that future contributors would
otherwise have to rediscover the hard way.