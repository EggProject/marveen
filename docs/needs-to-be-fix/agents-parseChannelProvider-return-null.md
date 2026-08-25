# agents.ts:231 -- parseChannelProvider's null return is unreachable

## Location

`src/web/routes/agents.ts`, lines 230-233 (`parseChannelProvider`) and
237-249 (`matchChannelRoute`):

```ts
function parseChannelProvider(raw: string): ChannelProviderType | null {
  if (VALID_PROVIDERS.has(raw as ChannelProviderType)) return raw as ChannelProviderType
  return null
}

// Match both new /channels/:provider/ and legacy /telegram/ URL patterns.
// Returns [agentName, provider] or null. Legacy routes always resolve to 'telegram'.
function matchChannelRoute(path: string, suffix: string): [string, ChannelProviderType] | null {
  const newPattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`)
  const newMatch = path.match(newPattern)
  if (newMatch) {
    const provider = parseChannelProvider(newMatch[2])
    if (provider) return [decodeURIComponent(newMatch[1]), provider]
  }
  ...
}
```

## Excerpt

The `return null` branch of `parseChannelProvider` (and the corresponding
`if (provider)` falsy arm at line 242 inside `matchChannelRoute`) are
**structurally unreachable**. `parseChannelProvider` is only called from
`matchChannelRoute`, and the regex `newPattern` captures only members of
`VALID_PROVIDERS` -- `(telegram|slack|discord|googlechat|teams)`. By the
time `parseChannelProvider(newMatch[2])` runs, `newMatch[2]` is
guaranteed to be one of those five strings, which is exactly the
`VALID_PROVIDERS` set.

The `if (provider)` check at line 242 is also unreachable for the same
reason: if the regex matched, the captured group IS a valid provider.

The `VALID_PROVIDERS.has` guard inside `parseChannelProvider` is
belt-and-braces against an out-of-band call -- but `parseChannelProvider`
is private (no `export`), so the only caller is `matchChannelRoute`.

## Failure scenario

v8 reports `branch 3 line=231 type=if counts=[73, 0]` -- the
`VALID_PROVIDERS.has` truthy arm hit 73 times (every time
`matchChannelRoute` reaches the new pattern), falsy arm (the `return
null` path) hit 0 times. The 100% branch coverage gate fails on
`src/web/routes/agents.ts` because of this dead branch (plus the
`if (provider)` at line 242 with the same counts).

A reviewer has three options:

1. Remove the `VALID_PROVIDERS.has` guard (the regex is the
   authoritative validator). One source change, the function becomes a
   single cast.
2. Inline the `parseChannelProvider` call into `matchChannelRoute` so
   the captured value is used directly.
3. Leave the dead branch in place (current state) and add a pinning
   test that calls `parseChannelProvider` via a private-symbol hack --
   but the function is module-private and the existing 330-test
   `agents-routes.test.ts` suite already exhaustively covers the
   public surface.

Option (1) is the cleanest fix.

## Pinning test

None. The branch is genuinely unreachable through any public API of
`agents.ts`. The existing `agents-routes.test.ts` suite has 330 tests
covering every documented path under `/api/agents/.../channels/...`
and the `/api/agents/.../telegram` legacy route; all of them flow
through `matchChannelRoute` and reach `parseChannelProvider` with a
regex-validated string. No test surface exercises the `return null`
branch.

## Suggested direction

Collapse `parseChannelProvider` to a typed cast:

```ts
function parseChannelProvider(raw: string): ChannelProviderType {
  return raw as ChannelProviderType
}
```

and remove the `if (provider)` check inside `matchChannelRoute` (or
repurpose it as a `TypeScript`-only `assertNever` style exhaustiveness
check if `ChannelProviderType` ever grows new variants).

Per task rule "NEVER modify src/web/routes/agents.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
