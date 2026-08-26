# routes/agents.ts: remaining uncovered branches after baseline regression tests

**Resolved: 2026-08-26 cf85135** (`fix(routes-agents): restore parseChannelProvider throw arm via __test_* export pattern`)

## Location

`src/web/routes/agents.ts`. After the baseline test commits
(`011efb0`, `dfc961c`) the uncovered branches fall into the following
categories. **All four are now covered** (see "Pinning test" and
"Suggested direction" below for evidence).

1. `parseChannelProvider` `throw new Error` arm (the `return null`
   arm was deleted by `3e1dd3f`; see
   `routes-agents-parse-channel-provider-dead-branches.md` and
   `routes-agents-parsechannelprovider-dead-branch.md`). **First
   attempted in 81ef7f6** (throw arm + `VALID_PROVIDERS` const
   deleted, function reduced to 1-line cast). **Reversed and
   refined in cf85135** at the user's request ("vedve legyen"):
   the function is now `export function __test_parseChannelProvider`
   (with cycle 47-48 `__test_` test-only prefix convention),
   `VALID_PROVIDERS` const restored at line 228, throw arm restored
   at lines 231-233. Only production call site is
   `__test_parseChannelProvider(newMatch[2])` at line 244 inside
   `matchChannelRoute`, where `newMatch[2]` is captured by the
   regex literal `(telegram|slack|discord|googlechat|teams)` at
   line 240 -- structurally guaranteed to be a valid provider. The
   throw arm is unreachable through the public API but functions
   as a tripwire for future API extensions that bypass the
   regex-gate.
2. `extractBotId` non-numeric branch at line 341 -- unreachable through
   the route dispatch because `parseTelegramToken` is mocked to
   `() => null` in the test harness. **Covered** by
   `agents-routes.test.ts:4208` (`baseline: extractBotId regex-fail
   branch`) which posts `botToken: 'abc:secret'` and asserts `ok: true`.
3. Several `?? null` / `?? ''` / `?? []` / `?? {}` / `?? false` defensive
   fallbacks that the existing test suite does not exercise. **All
   covered** by the post-`011efb0` baseline regression suite.
4. The `if (!existsSync(agentDir(name)))` 404 guards for several routes
   remain partially uncovered because the test harness's `ensureAgentDirs()`
   pre-creates the agent dir name in `listAgentNames()`. **Covered** by
   `agents-routes.test.ts:4316` (`baseline: PUT /api/agents/:name/security
   404 branch`).

## Excerpts

```ts
// src/web/routes/agents.ts:342-347
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
// src/web/routes/agents.ts:460-475 -- agent detail's `running` branches
const session = running ? agentSessionName(name) : undefined
const runningSince = running ? getAgentRunningSince(name) : null
const reauth = running
  ? detectReauthNeeded(capturePane(agentSessionName(name)))
  : { needsReauth: false }
// ...
activeModel: running ? readActiveModelFromProjectDir(dir, runningSince ?? undefined, resolveAgentConfigDir(name).configDir ?? undefined) : null,
```

The `branch-0` (running=true) arms are covered by the
`baseline: running=true agent summary branches` and
`baseline: getAgentSummary activeModel / contextTokens branches`
tests at `agents-routes.test.ts:3428-3447` and `4015-4029`.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives every reachable branch of the route handlers
   (already covered by `agents-routes.test.ts`).
2. The `parseChannelProvider` `return null` and `extractBotId`
   `return null` arms are unreachable through the route dispatch
   because the only caller (`parseTelegramToken`) is mocked out.
3. (Stale at filing; corrected at resolution 81ef7f6, then refined
   in cf85135.) At the time this MD was filed v8 reported 67
   branches uncovered (out of 860 total) for 92.2% branch coverage.
   By `a5e2318` (the pre-fix HEAD) the baseline regression suites
   collapsed this to 2 branches uncovered (out of 858 total) for
   99.76% branch coverage. After 81ef7f6 both remaining branches
   were covered; `src/web/routes/agents.ts` reached 100% lines
   (979/979), 100% branches (856/856), 100% statements (1177/1177),
   94.11% functions (48/51; the 3 uncovered functions are
   pre-existing `.catch(() => {})` arrow handlers at lines 944,
   953, 1180, unrelated to this fix). cf85135 restored the throw
   arm via the `__test_*` export pattern; coverage is maintained
   at 100% branches / 100% lines via a direct-call test that
   exercises the throw arm.

## Pinning test

The "baseline" `describe` blocks in `src/__tests__/agents-routes.test.ts`
cover every reachable defensive fallback shape, plus the two
branches that survived the baseline pass and required this fix:

- `agents-routes.test.ts:4208` -- `baseline: extractBotId regex-fail
  branch` (covers extractBotId non-numeric arm at line 341)
- `agents-routes.test.ts:4316` -- `baseline: PUT
  /api/agents/:name/security 404 branch` (covers the `existsSync`
  404 guard)
- `agents-routes.test.ts:1090-1106` -- `uses the kanban map for
  open/urgent counts` (extended in 81ef7f6 with a 4th row
  `{ assignee: 'dev', priority: 'low', cnt: 3 }` at line 1100 that
  bypasses `if (!row.assignee) continue` at line 748 and exercises
  the else-arm of `if (row.priority === 'urgent' || row.priority ===
  'high')` at line 751)
- The `running: true` arms at lines 460, 461, 465, 475 of `getAgentSummary`
  are covered by the `baseline: running=true agent summary branches`
  and `baseline: getAgentSummary activeModel / contextTokens branches`
  tests at `agents-routes.test.ts:3428-3447` and `4015-4029`.
- `agents-routes.test.ts:3951-3962` -- `throws on invalid channel
  provider string` (added in cf85135, exercises the restored throw
  arm at `agents.ts:231-233` via direct call to
  `__test_parseChannelProvider('invalid')` and `('foo')`)

Other branches are covered because:

- `parseChannelProvider` (now `__test_parseChannelProvider`) is
  unreachable-through-API for invalid input (the regex-gate at
  `agents.ts:240` captures only the 5 valid providers). The throw
  arm was first deleted in 81ef7f6, then restored in cf85135 with
  the `__test_*` test-only prefix convention; it is now both
  runtime-protected AND testable.

## Suggested direction

(a) For `parseChannelProvider` `return null` and `extractBotId`
    `return null`: remove the dead branches (the regex / caller
    contract already gates the input). **DONE in 81ef7f6 (deletion)
    + REVERSED+RESTORED in cf85135 via `__test_*` test-only export
    pattern**: the function is now `export function
    __test_parseChannelProvider` (line 230), `VALID_PROVIDERS`
    const restored (line 228), throw arm restored (lines 231-233).
    The throw arm is exercised by the new direct-call test at
    `agents-routes.test.ts:3951-3962`.

(b) For the `?? null` / `?? ''` defensive fallbacks: keep them as
    safety nets but add a single test that exercises one tuple of
    each shape (e.g. `body: {}` for remote config, `body: { role: 'member' }`
    for team config, etc.) -- the existing baseline tests already do
    this for the most common shapes. **DONE**: every reachable
    `?? null` / `?? ''` shape is covered by the post-`011efb0`
    baseline regression suite.

(c) For the `running: true` arms in agent detail: add a single test
    that drives `GET /api/agents/<name>` with `isAgentRunning=true`
    once the harness's `ensureAgentDirs()` is updated to handle
    this case. **DONE**: covered by the activity-list tests at
    `agents-routes.test.ts:3428-3447` and `4002-4016`; no harness
    change was needed.

The source edits were blocked under the 2026-08-09..2026-08-13
baseline closure cycle. That scope was lifted on 2026-08-24 (per
`ab4dc09 docs(needs-to-be-fix): re-open 2 MDs closed under the now-scoped-out
NEVER-modify rule`). 81ef7f6 landed the deletion-based fix on
2026-08-26; the user then requested the protection back, and
cf85135 landed the restoration via the `__test_*` export pattern
on 2026-08-26.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
