# fleet-transfer.ts: assertSafeName is dead code (lines 49-52)

## Location

`src/web/fleet-transfer.ts`, lines 48-53.

```ts
function assertSafeName(value: unknown, field: string): string {
  if (typeof value !== 'string' || !SAFE_NAME_RE.test(value)) {
    throw new Error(`Érvénytelen ${field} érték: "${String(value).slice(0, 60)}" -- csak [a-z0-9_-] megengedett.`)
  }
  return value
}
```

## Excerpt

`assertSafeName` is a module-private (non-exported) helper declared at line
48. A whole-repo search (`grep -rn assertSafeName src/`) returns only the
declaration itself; nothing in the source tree calls it. The name-validation
path that actually runs during an import is `validateNames` (lines 746-787),
which uses `SAFE_NAME_RE.test(...)` inline -- never `assertSafeName`.

```ts
// validateNames (line 750-754) -- the actual user
for (const provider of Object.keys(fleet.mainAgent?.channelsAccess ?? {})) {
  if (!SAFE_NAME_RE.test(provider)) {
    errors.push(`Érvénytelen mainAgent channel provider: "${provider.slice(0, 60)}"`)
  }
}
```

`validateNames` produces error strings instead of throwing, so the helper
never gets a chance to run even if it were wired in.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives every reachable path of `importFleet` -- including dry-run,
   apply, encrypted round-trip, schema errors, name errors, channel takeover,
   avatar traversal guard, identity takeover.
2. `assertSafeName` is never invoked from any reachable branch.
3. v8 records the four body lines as untaken.
4. Line coverage caps at 99.35% (460/463) and function coverage at 95.55%.

`assertSafeName` is not exported, so it cannot be reached through the public
API. A test would need to either (a) export it (a source edit) or (b) call
it via some indirect lever -- but no such lever exists because the function
is structurally disconnected from every other symbol in the module.

## Pinning test

`src/__tests__/fleet-transfer.test.ts` and the broader
`fleet-transfer-routes.test.ts` already exhaust every reachable branch of
the import path. The gap is exactly the four body lines of
`assertSafeName`.

- `'importFleet: avatarExt traversal rejected'` proves `validateNames` is the
  active name-validator and uses `SAFE_NAME_RE` directly.
- `'assertSafeName via validateNames'` (in `fleet-transfer-routes.test.ts`)
  drives the SAFE_NAME_RE branches through `validateNames` and confirms
  uppercase / spaces / dots get rejected with `Érvénytelen` errors.
- Neither suite can poke `assertSafeName` because it is module-private.

## Suggested direction

Two options, both one-line edits:

(a) Delete the dead helper. It is unreferenced, never reachable, and the
    inline `SAFE_NAME_RE.test(...)` checks in `validateNames` cover every
    safety property the helper was meant to enforce.

(b) Wire it into `validateNames` so the helper's contract is actually
    exercised. Today every `validateNames` branch pushes a hand-written
    error string; swapping in `assertSafeName(value, field)` would centralise
    the `Érvénytelen ${field} érték:` message and make the helper live.

Per task rule "NEVER modify src/web/fleet-transfer.ts" the source edits are
blocked until the user overrides; the test suite documents the gap and pins
every reachable sibling branch.
