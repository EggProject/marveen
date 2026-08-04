# openrouter-models.ts: `??` misses the empty-string tier1.auto fallback

## Location

`src/web/openrouter-models.ts`, line 172, inside `resolveOpenRouterModel`:

```ts
const tier = cat.tiers.find(t => t.key === tierKey)
if (tier?.auto) return tier.auto
logger.warn({ model, tierKey }, 'openrouter-auto tier not found; falling back to tier1/deepseek')
return cat.tiers.find(t => t.key === 'tier1')?.auto ?? 'deepseek/deepseek-chat-v3.1'
```

## Excerpt

The intent of the final line is a three-tier fallback for an unknown
`openrouter-auto:<tierKey>`:

1. the requested tier's `auto` (already handled above),
2. the `tier1.auto` if present,
3. the hardcoded literal `'deepseek/deepseek-chat-v3.1'` if even `tier1`
   is absent or its `auto` is empty.

The implementation uses `??` for the second/third transition. `??` only
catches `null` and `undefined` — not the empty string. So when an operator
defines `tier1` with `auto: ""` (a deliberately empty current pick,
waiting for the weekly task to fill it in), the launcher receives the
literal empty string and Anthropic SDK rejects the request with an opaque
upstream error instead of falling back to the documented deepseek default.

## Failure scenario

1. Operator writes `store/openrouter-models.json` with only `tier1`
   present and `auto: ""` (or any catalog without a `tier1` whose `auto`
   is set).
2. An agent whose stored model is `openrouter-auto:does-not-exist`
   (typo, renamed tier, weekly research has not yet run, etc.) is
   launched.
3. `resolveOpenRouterModel` walks through:
   - `tier = cat.tiers.find(t => t.key === 'does-not-exist')` → `undefined`,
   - `tier?.auto` → `undefined` (falsy), warn fires,
   - `cat.tiers.find(t => t.key === 'tier1')?.auto` → `''`,
   - `'' ?? 'deepseek/...'` → `''` (the empty string is neither `null`
     nor `undefined`).
4. The launcher receives `model = ''`, the Anthropic SDK rejects the
   empty model id at the upstream HTTP layer with a generic 4xx, and the
   agent never starts. The dashboard log shows the empty model without
   explaining why the documented fallback to deepseek was not used.

The fix is to change `??` to `||` (or `!tier?.auto ? 'deepseek/...' :
tier.auto`) so an empty / falsy `tier1.auto` triggers the hardcoded
fallback. The accompanying branch inventory in
`src/__tests__/openrouter-models.test.ts` already documents the
currently-buggy behaviour with a TODO comment in the "ervenytelen
tierKey es tier1.auto ures" case; that test should be flipped to expect
`'deepseek/deepseek-chat-v3.1'` once the fix lands.

## Pinning test

`src/__tests__/openrouter-models.test.ts`, `resolveOpenRouterModel`
suite, the case tagged "jelenleg ures stringet ad (defect: a ?? nem
kapja el az ures stringet)". The case writes a catalog with only an
empty-`auto` `tier1`, resolves an unknown tier, and asserts the current
empty-string return value. Once the fix lands, the assertion must be
updated to `'deepseek/deepseek-chat-v3.1'` to lock the corrected
behaviour in.

## Suggested direction

Replace `??` with `||` so falsy values (including `''`) trigger the
fallback:

```ts
return cat.tiers.find(t => t.key === 'tier1')?.auto || 'deepseek/deepseek-chat-v3.1'
```

This keeps the documented behaviour (any unknown tier resolves to the
deepseek default) consistent with the surrounding `if (tier?.auto)`
guard, which already treats `''` as "no auto". After the fix, update the
pinning test to expect `'deepseek/deepseek-chat-v3.1'` and remove the
defect comment.

Per task rule "NEVER modify src/web/openrouter-models.ts" the source
edit is blocked until the user overrides; the test suite documents the
gap and the regression case above should be updated alongside the fix.
