# routes/agents.ts: parseChannelProvider's `return null` branch is unreachable through the public API

## Location

`src/web/routes/agents.ts`, line 232, inside `parseChannelProvider`:

```ts
function parseChannelProvider(raw: string): ChannelProviderType | null {
  if (VALID_PROVIDERS.has(raw as ChannelProviderType)) return raw as ChannelProviderType
  return null  // <-- line 232
}
```

## Excerpt

The function is only called from `matchChannelRoute` line 241, after a regex
match against `^/api/agents/([^/]+)/channels/(telegram|slack|discord|googlechat|teams)${suffix}$`.
The regex restricts `newMatch[2]` to the exact same five values that
`VALID_PROVIDERS` checks, so `VALID_PROVIDERS.has(raw as ChannelProviderType)`
is always truthy at the call site. The `return null` branch therefore can
never fire from the public route dispatch surface -- it is defensive
dead code.

## Failure scenario

The defect is a coverage-only defect -- no runtime misbehaviour is
reachable through public input. The line shows up in the v8 coverage
report as uncovered because the `return null` branch never executes
in the test suite (and indeed never can, since the regex gates every
upstream caller).

1. A caller sends a request like `POST /api/agents/a/channels/unknown/test`.
2. `matchChannelRoute` runs the new pattern; `unknown` does not match
   the regex, so the function falls through to the legacy pattern
   (which hardcodes 'telegram'). `parseChannelProvider` is never called.
3. `parseChannelProvider` is only called inside the `if (newMatch)` arm,
   which only fires when the regex matches; that arm only fires for
   one of the five valid provider ids.

To exercise line 232 directly the SUT would need to invoke
`parseChannelProvider('foo')` from somewhere else, but the function is
local to the module (not exported) and has no other call sites.

## Suggested fix (do NOT apply per the rule)

Either:

- **Remove the dead branch.** Replace the body with
  `return raw as ChannelProviderType` and remove the `VALID_PROVIDERS`
  import + set. The regex already gates the only call site, so the
  filter duplicates a check that lives in the regex. A defensive future
  caller that does NOT pre-check would surface a `ChannelProviderType`
  value the downstream code (channelStateDir, getProvider) wouldn't know
  how to handle, which is a louder failure mode than a silent null.

- **OR keep the branch and document its unreachability** with a comment
  at the top of the function noting that the only caller is gated by the
  regex and the filter is intentional belt-and-braces for future call
  sites.

## Pinning test

`src/__tests__/agents-routes.test.ts`:

- `does not match an unknown provider on the channels/<provider> URL`
  exercises the regex-no-match path, which falls through to the legacy
  handler; `parseChannelProvider` is never reached.

The dead branch can be reached only by direct invocation from inside the
module (or by adding a new public caller), neither of which is feasible
without modifying the source. Coverage is satisfied via the test
`validateDiscordChannelId` block (covers the related `isModelProfileId`
defensive pattern in `model-profiles.ts`) and the channel-route dispatch
tests; the gap remains a 1-line coverage hole.

Per task rule "NEVER modify src/web/routes/agents.ts" the source edit
is blocked until the user overrides; this doc records the gap.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
