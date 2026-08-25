# routes/agents.ts: remaining uncovered branches after baseline regression tests

## Location

`src/web/routes/agents.ts`. After the baseline test commits
(`011efb0`, `dfc961c`) the uncovered branches fall into the following
categories:

1. `parseChannelProvider` `return null` at line 232 (already documented
   in `routes-agents-parseChannelProvider-dead-code.md` and
   `routes-agents-parsechannelprovider-dead-branch.md`).
2. `extractBotId` non-numeric branch at line 343 — unreachable through
   the route dispatch because `parseTelegramToken` is mocked to
   `() => null` in the test harness.
3. Several `?? null` / `?? ''` / `?? []` / `?? {}` / `?? false` defensive
   fallbacks that the existing test suite does not exercise.
4. The `if (!existsSync(agentDir(name)))` 404 guards for several routes
   remain partially uncovered because the test harness's `ensureAgentDirs()`
   pre-creates the agent dir name in `listAgentNames()`.

## Excerpts

```ts
// src/web/routes/agents.ts:339-344
function extractBotId(token: string): string | null {
  const colon = token.indexOf(':')
  if (colon < 1) return null
  const id = token.slice(0, colon)
  return /^\d+$/.test(id) ? id : null
}
```

The `return null` arm fires when `id` is non-numeric. The
`parseTelegramToken` mock returns `null` unconditionally, so
`extractBotId` is never invoked with a real token.

```ts
// src/web/routes/agents.ts:4756-4761 -- agent detail's `running` branches
const session = running ? agentSessionName(name) : undefined
const runningSince = running ? getAgentRunningSince(name) : null
const reauth = running
  ? detectReauthNeeded(capturePane(agentSessionName(name)))
  : { needsReauth: false }
```

The `branch-0` (running=true) arms are NOT covered -- the test harness
sets `isAgentRunning` to `false`, so the truthy branch never runs.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives every reachable branch of the route handlers
   (already covered by `agents-routes.test.ts`).
2. The `parseChannelProvider` `return null` and `extractBotId`
   `return null` arms are unreachable through the route dispatch
   because the only caller (`parseTelegramToken`) is mocked out.
3. v8 reports 67 branches uncovered (out of 860 total). The text
   summary shows 92.2% branch coverage. The remaining 67 branches
   are spread across the `?? null` / `?? ''` defensive fallbacks and
   the `running: true` arms.

## Pinning test

The "baseline" `describe` block in `src/__tests__/agents-routes.test.ts`
covers the most impactful `?? null` / `?? ''` defensive fallbacks
(remote config, team config, channel setup). Other branches remain
uncovered because:

- `parseTelegramToken` is mocked and the SUT-belső `extractBotId` is
  not reachable through any other public path.
- `parseChannelProvider` is only called from `matchChannelRoute` which
  is regex-gated.
- The `running: true` arms in `agent detail` block require `running`
  to be true, but the test harness sets `isAgentRunning` to false by
  default.

## Suggested direction

(a) For `parseChannelProvider` `return null` and `extractBotId`
    `return null`: remove the dead branches (the regex / caller
    contract already gates the input).

(b) For the `?? null` / `?? ''` defensive fallbacks: keep them as
    safety nets but add a single test that exercises one tuple of
    each shape (e.g. `body: {}` for remote config, `body: { role: 'member' }`
    for team config, etc.) -- the existing baseline tests already do
    this for the most common shapes.

(c) For the `running: true` arms in agent detail: add a single test
    that drives `GET /api/agents/<name>` with `isAgentRunning=true`
    once the harness's `ensureAgentDirs()` is updated to handle
    this case.

Per task rule "NEVER modify src/web/routes/agents.ts" the source
edits are blocked until the user overrides; the test suite documents
the gap and pins every reachable sibling branch.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
