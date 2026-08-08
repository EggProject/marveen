# routes/agents.ts: parseChannelProvider / matchChannelProvider else branches are dead code

## Location
- `src/web/routes/agents.ts:230-233` (`parseChannelProvider`)
- `src/web/routes/agents.ts:240-242` (`if (provider)` inside `matchChannelRoute`)

## Excerpt
```ts
function parseChannelProvider(raw: string): ChannelProviderType | null {
  if (VALID_PROVIDERS.has(raw as ChannelProviderType)) return raw as ChannelProviderType
  return null                                                                                // <-- line 232
}

function matchChannelRoute(path: string, suffix: string): [string, ChannelProviderType] | null {
  const newPattern = new RegExp(`^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`)
  const newMatch = path.match(newPattern)
  if (newMatch) {
    const provider = parseChannelProvider(newMatch[2])
    if (provider) return [decodeURIComponent(newMatch[1]), provider]                        // <-- line 242
  }
  ...
}
```

## Why it is dead code
The regex `^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`
restricts the captured provider group to one of the 5 strings `VALID_PROVIDERS` already
contains. So when `parseChannelProvider(newMatch[2])` is called from `matchChannelRoute`,
the input is always a member of `VALID_PROVIDERS`, the `if` body always returns
`raw as ChannelProviderType`, and the trailing `return null` never fires.

By the same argument, the `if (provider)` guard on line 242 inside `matchChannelRoute` is
also always true: the function called in the line above is guaranteed to return a
non-null `ChannelProviderType` here, so the else branch is unreachable.

The only way the `return null` arm of `parseChannelProvider` could fire is if the
function is called with a string that is NOT in `VALID_PROVIDERS`. There is exactly
one such call site (line 241 in `matchChannelRoute`), and that site is preceded by a
regex that filters out anything not in the set. `parseChannelProvider` is not
exported, so external callers cannot reach the else branch.

## Failure scenario
A change that relaxes the regex (e.g. lets the provider group accept arbitrary names)
without also touching `parseChannelProvider` would make the `return null` arm
live again — and because `matchChannelRoute` does not pass the provider through any
type system at that point, a bad provider would silently fall through to `null` and
the route would 404. A type annotation tightening (or an explicit `if (provider)`
removal) would force the compiler to surface the breakage.

## Pinning test
N/A — the branch is structurally unreachable through the public SUT surface. The
imported `tryHandleAgents` function is the only entry point, and the route table
exercises it through the regex-restricted path. There is no test-only way to make
`parseChannelProvider` return null without monkey-patching the SUT, which the test
harness does not permit.

## Suggested direction
- Either drop the `return null` from `parseChannelProvider` and make the return
  type non-nullable, or
- Loosen the `matchChannelRoute` regex to accept arbitrary provider names AND
  rely on `parseChannelProvider` for the validation. The current arrangement
  does the same filtering twice (regex + `VALID_PROVIDERS.has`), which is the
  structural reason the else branch is dead.
