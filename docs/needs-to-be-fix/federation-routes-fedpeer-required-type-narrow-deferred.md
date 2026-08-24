**Status:** RESOLVED -- narrowing succeeded (commit `8e11043` on `test/baseline`). The narrative below describes the original "deferred" state and is preserved for historical context only. **The `?? null` fallbacks at `federation.ts:298,329` are gone, and `RouteContext.fedPeer` is now `string | null` (required, not optional).** Do not act on the "Forward path" section below.

# federation routes/federation.ts:330 - fedPeer type-narrow deferred

## Context

Two `ctx.fedPeer ?? null` calls in `src/web/routes/federation.ts:298,329`.
Strategy: tighten `RouteContext.fedPeer: string | null | undefined` to
`string` (required), then drop the `?? null` fallbacks.

The type is defined in `src/web/routes/types.ts:17`:
`fedPeer?: string | null`.

## What was tried

Changed `RouteContext.fedPeer?: string | null` to `fedPeer: string | null`
(removing the optional `?` but keeping the `| null` for non-peer callers).

## Why deferred

`bun run typecheck` error count jumped from 1703 to 1774 (+71). Tolerance
is +5; +71 vastly exceeds the budget.

### Root cause

`fedPeer` is declared optional but is genuinely optional in practice: many
call sites either omit it or pass `undefined`. Even narrowing to
`string | null` (not `string`) breaks them because they would need to be
updated to pass an explicit value.

#### Test files that build RouteContext literals without `fedPeer`

A representative sample (10+ files):

- `src/__tests__/federation-directory.test.ts:46`
- `src/__tests__/federation-inbox.test.ts:45,61`
- `src/__tests__/federation-lifecycle.test.ts:47`
- `src/__tests__/federation-delegation-feedback.test.ts:44`
- `src/__tests__/routes-federation-full.test.ts:255,265,272,1210,1281,1461`
- `src/__tests__/web-server.test.ts:1075` (verifies dispatcher passes fedPeer)

Plus `src/__tests__/types.test.ts` (the type-shape test that explicitly
documents `undefined` semantics).

#### Production call site

`src/web.ts:153,171` already passes `fedPeer: fedPeerForCtx` (where
`fedPeerForCtx: string | null`) -- that one is OK if `| null` is kept.

#### `types.test.ts` semantics test

`src/__tests__/types.test.ts:43-141` is the canonical test that documents
that `fedPeer` may be `undefined` AND `null` AND a string. Dropping the
optional would invalidate the file's purpose.

## Forward path

This narrowing is structural: the type IS optional in practice because the
dispatcher at `src/web.ts:153` accepts three states (peer, dashboard,
unauthenticated public path). A narrowing commit would require:

1. Decide: should the type allow `undefined` (treat as "not peer") or
   should the dispatcher ALWAYS populate it with `null`?
2. Update every test literal that omits `fedPeer` (10+ files, ~30+ call
   sites).
3. Rewrite `src/__tests__/types.test.ts` to match the new shape.
4. Re-run typecheck.

Until step 1 is decided, defer the narrowing and keep the `?? null` in
`federation.ts:298,329`.

## Files inspected

- `src/web/routes/types.ts:7-25`
- `src/web/routes/federation.ts:298,329`
- `src/web.ts:153,171`
- `src/__tests__/types.test.ts`
- 5 other test files listed above