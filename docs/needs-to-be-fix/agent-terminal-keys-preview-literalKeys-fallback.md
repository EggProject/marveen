# agent-terminal.ts:218 -- literalKeys ?? '' fallback is unreachable

## Location

`src/web/routes/agent-terminal.ts`, lines 204-218 (`/api/agents/:name/keys`
preview):

```ts
const literalKeys = typeof parsed.keys === 'string' ? sanitizeLiteralKeys(parsed.keys) : null
const args = parsed.special
  ? specialKeyArgs(session, parsed.special)
  : (literalKeys ? literalKeyArgs(session, literalKeys) : null)
if (!args) {
  json(res, { error: 'Provide {keys:string} or an allow-listed {special}' }, 400)
  return true
}
// AUDIT every accepted injection. Preview reflects the SANITIZED payload
// actually sent (truncated so a long paste does not bloat the log, but
// present so a forged prompt is traceable).
const preview = parsed.special
  ? `special:${parsed.special}`
  : `keys:${JSON.stringify((literalKeys ?? '').slice(0, 120))}${(literalKeys ?? '').length > 120 ? '…' : ''}`
```

## Excerpt

The two `literalKeys ?? ''` expressions at line 218 are
**structurally unreachable**. The `if (!args)` early-return at line 210
guards the audit log: it fires when `parsed.special` is falsy AND
`literalKeys` is null/empty. Any of those three states means `literalKeys`
is either null or an empty string, which would have caused the `?? ''`
fallback to trigger -- but the audit log line is never reached in any of
those cases because the early-return short-circuits first.

Concretely, when the audit log runs:

| `parsed.special` | `literalKeys` | `args` | Branch reached? |
|------------------|---------------|--------|-----------------|
| string           | (any)         | truthy | yes (preview = `special:${...}`) -- literalKeys never read |
| undefined/null   | string (non-empty) | truthy | yes (preview = `keys:"..."`) -- literalKeys is a non-empty string |
| undefined/null   | null / empty string | null | NO -- early-return at `if (!args)` fires |

So `literalKeys` is only read in the row where it is a non-empty string.
The `?? ''` fallback can only fire when `literalKeys` is null/undefined,
which never co-occurs with the audit log line being reached.

## Failure scenario

The v8 branch counter for both `?? ''` expressions at line 218 reports
`counts=[4, 0]` -- truthy side (literalKeys defined, real string) hit
4 times, falsy side (fallback) hit 0 times. The 100% branch coverage
gate fails on this file because of these two unreachable defensive
branches.

A reviewer noticing the dead branches has three options:

1. Remove the `?? ''` as dead code (cleanest fix; one source change).
2. Leave the defensive nullish in place (current state) and add a
   pinning test (see below) that exercises the audit line while
   forcing literalKeys to a non-string value -- requires mocking the
   `if (!args)` guard so the audit log runs anyway.
3. Reorder the code so the preview is computed BEFORE the
   `if (!args)` guard -- this changes the audit semantics (today
   only accepted injections are logged; a preview for rejected ones
   would be a leak).

Option (1) is the correct fix. The `if (!args)` guard is the
authoritative validator; the `?? ''` is a no-op insurance policy that
cannot fire.

## Pinning test

None. The fallback cannot be reached through any public API of
`/api/agents/:name/keys`. The existing 53-test suite
`src/__tests__/agent-terminal-routes.test.ts` exercises every path that
does reach the audit log (literal keys, special keys, multi-char paste,
truncation, etc.) and never sees the `?? ''` fire.

To artificially hit the branch, a test would have to either:

- Mock the `if (!args)` guard via a `vi.spyOn` on the route's logic
  (intrusive -- the `args` variable is a local, not exposed).
- Mutate `sanitizeLiteralKeys` to return `undefined` for non-empty input
  (breaks the existing single-char passthrough contract).

Neither is worth maintaining.

## Suggested direction

Remove the `?? ''` fallbacks. The audit preview should be:

```ts
const preview = parsed.special
  ? `special:${parsed.special}`
  : `keys:${JSON.stringify(literalKeys.slice(0, 120))}${literalKeys.length > 120 ? '…' : ''}`
```

`literalKeys` is guaranteed to be a non-empty string here by the
upstream `if (!args)` guard. The `?? ''` is unreachable.

Per task rule "NEVER modify src/web/routes/agent-terminal.ts" this
requires an explicit override from the user.

## Resolved

Resolved: 2026-08-20 e325b0c --
dead `?? ''` arms removed at agent-terminal.ts:218; see Item 1 of the
curious-doodling-dawn plan.