# agent-terminal.ts: unreachable `literalKeys ?? ''` on the audit-preview line blocks 100% branch coverage

## Location

`src/web/routes/agent-terminal.ts`, line 218:

```ts
const preview = parsed.special
  ? `special:${parsed.special}`
  : `keys:${JSON.stringify((literalKeys ?? '').slice(0, 120))}${(literalKeys ?? '').length > 120 ? '…' : ''}`
```

The two `(literalKeys ?? '')` fallbacks (the `??` right arm on each) are
dead code: the only execution path that reaches line 218's `else` branch
also requires `literalKeys` to be a non-empty string.

## Excerpt

The upstream guard makes the fallback structurally unreachable:

```ts
// line 205
const literalKeys = typeof parsed.keys === 'string' ? sanitizeLiteralKeys(parsed.keys) : null
const args = parsed.special
  ? specialKeyArgs(session, parsed.special)
  : (literalKeys ? literalKeyArgs(session, literalKeys) : null)  // line 208
if (!args) {
  json(res, { error: 'Provide {keys:string} or an allow-listed {special}' }, 400)
  return true                                                         // line 211
}
// line 218 is reached ONLY when args is truthy
const preview = parsed.special
  ? `special:${parsed.special}`
  : `keys:${JSON.stringify((literalKeys ?? '').slice(0, 120))}${(literalKeys ?? '').length > 120 ? '…' : ''}`
```

Walking the cases:

1. **`parsed.special` truthy** -- line 218 takes the `special:${parsed.special}`
   branch. The `else` arm (and therefore both `?? ''` fallbacks) is never
   evaluated.
2. **`parsed.special` falsy AND `literalKeys` is a non-empty string** --
   `literalKeys` is truthy, so `literalKeyArgs` is called. Its return is
   `['send-keys', ...]` (non-null) as long as `literalKeys !== ''`, so
   `args` is truthy, line 218 is reached, and `literalKeys ?? ''` resolves
   to `literalKeys` (no fallback).
3. **`parsed.special` falsy AND `literalKeys` is `null`** -- `literalKeys`
   is falsy, so `args` evaluates to `null`, the `if (!args)` guard fires
   the 400 and `return true` BEFORE line 218.
4. **`parsed.special` falsy AND `literalKeys` is `''`** -- `''` is truthy
   in JS, so `literalKeyArgs(session, '')` is called, which itself returns
   `null` for empty text, so `args === null`, the `if (!args)` guard fires
   the 400 BEFORE line 218.

In every reachable execution path, `literalKeys` is a non-empty string by
the time line 218 runs, so the `?? ''` fallback can never resolve to `''`.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A test drives every legitimate request body: literal keys (short and
   long), special keys, invalid JSON, missing fields, toggle-OFF, and
   every other path the route handles.
2. None of these paths can produce a `null`/empty `literalKeys` value at
   line 218; the `if (!args)` guard short-circuits them with a 400.
3. v8 records both `?? ''` right arms as untaken.
4. Branch coverage caps at 97.77% (88/90) while statements, lines and
   functions all reach 100%.

## Pinning test

`src/__tests__/agent-terminal-routes.test.ts`. The reachable sibling
branches are covered so the gap is exactly the two `?? ''` arms:

- `describe('POST /api/agents/:name/keys')` -- "sends literal keys and
  audit-logs the sanitized preview" drives the `keys:"hello"` branch with a
  short payload (length 5, hits the `> 120` `false` arm and the ternary
  `: ''` arm).
- `describe('POST /api/agents/:name/keys')` -- "truncates the preview and
  adds an ellipsis when > 120 chars" drives the `keys:"aaa..."` branch
  with a 150-char payload (hits the `> 120` `true` arm and the ternary
  `? '…'` arm).
- `describe('POST /api/agents/:name/keys')` -- "ignores a non-string keys
  (sanitizeLiteralKeys is bypassed -> null literalKeys -> 400)" pins that
  `null` literalKeys short-circuits at `if (!args)`, so line 218 is never
  reached when `literalKeys` is null.

## Suggested direction

A single-line simplification that removes both dead arms without changing
behaviour:

```ts
: `keys:${JSON.stringify(literalKeys.slice(0, 120))}${literalKeys.length > 120 ? '…' : ''}`
```

Per task rule "NEVER modify src/web/routes/agent-terminal.ts" the source
edit is blocked until the user overrides; the test suite documents the gap
and pins every reachable sibling branch.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
