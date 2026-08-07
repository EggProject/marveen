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