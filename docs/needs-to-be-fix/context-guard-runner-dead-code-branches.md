# context-guard-runner.ts: four branches in the restart/request-handoff switch are unreachable

## Location

`src/web/context-guard-runner.ts`, lines 263, 274, 275, and 290.

```ts
// line 263 (inside `case 'request-handoff'`)
await sendPromptToSession(session, handoffPrompt(pctRound ?? 0, handoffPathFor(name)))

// line 274 (inside `case 'restart'`)
const finalPane = pane ?? capturePane(session)
// line 275
if (finalPane) {
  snapshotPath = join(PROJECT_ROOT, 'store', `context-guard-last-pane-${name}.txt`)
  writeFileSync(snapshotPath, finalPane)
}

// line 290 (inside the createAgentMessage call for the restart notice)
(snapshotPath ? ` Pane-snapshot a restart elotti allapotrol: ${snapshotPath}` : '')
```

## Excerpt

All four branches are unreachable defensive fallbacks that can never be
taken given the runner's own control flow:

1. **Line 263 (`pctRound ?? 0`)** -- `pctRound` is computed inside the
   SUT as `inputs.pct !== null ? Math.round(inputs.pct * 100) : null`.
   `inputs.pct` is non-null exactly when the proactive tiers ran
   (`running && needPct && cfg.enabled`), which is the SAME condition
   that lets `decideGuard` return `request-handoff` (the `idle` case
   checks `cfg.enabled` and `inputs.pct !== null` before reaching the
   actPct band). So whenever `request-handoff` fires, `pctRound` is
   non-null. The `?? 0` fallback never runs.

2. **Line 274 (`pane ?? capturePane(session)`)** -- `pane` is computed
   as `running && needPct ? capturePane(session) : null`. Both
   `restart`-returning paths in `decideGuard` (`idle` and `await-handoff`)
   require `running=true` and a phase in `{idle, await-handoff}` (both
   in the `needPct` set). So whenever `restart` fires, `pane` is the
   captured output of `capturePane(session)` and is non-null. The
   `capturePane(session)` fallback never runs.

3. **Line 275 (`if (finalPane)` else)** -- `finalPane = pane ?? capturePane(session)`.
   Given (2), `pane` is non-null whenever `restart` fires, so
   `finalPane` is non-null. The `else` branch never runs.

4. **Line 290 (`: ''` else)** -- `snapshotPath` is assigned only inside
   the `if (finalPane)` block. Given (3), `finalPane` is always
   truthy, so `snapshotPath` is always the file path string and never
   `null`. The `''` fallback never runs.

## Failure scenario

The defect is a coverage-only defect -- no runtime misbehaviour is
reachable through public input.

1. A caller drives a sweep where the agent is at or above `hardPct`
   (`cfg.enabled=true`, `running=true`, `needPct=true`).
2. `decideGuard` returns `action: 'restart'` from the `idle` phase.
3. The SUT enters the `case 'restart'` body. `pane` is the captured
   pane (non-null). The runner writes the snapshot and the
   `createAgentMessage` call always sees the snapshot path string.

None of the four fallbacks can ever produce a different string than
the truthy branch would have produced.

## Suggested fix (do NOT apply per the rule)

Either:

- **Tighten the types / guards**: change `pctRound ?? 0` to
  `pctRound!`, drop the `pane ?? capturePane(session)` re-fetch (use
  `pane` directly), drop the `if (finalPane)` guard (the assertion
  `finalPane !== null` is provable at the call site), and inline the
  non-empty `Pane-snapshot ...` template literal into the message.

- **OR keep the defensive code as documentation**: leave it as-is and
  add a comment at each call site explaining why the fallback is
  unreachable, so future readers do not delete it as "dead code"
  without understanding the invariant.

## Test coverage

`src/__tests__/context-guard-runner.test.ts` exercises all four
fallbacks via `mockDecideGuard.mockImplementationOnce(...)` (see
`describe('dead-code branches via mock-controlled decideGuard')`).
That makes the coverage tool happy, but the tests assert ONLY on the
runner side-effects (the `sendPromptToSession` prompt content, the
`hardRestartMarveenChannels` call, and the absence of `Pane-snapshot`
in the message) -- not on the synthetic decision. This is the
minimum invasive way to satisfy the 100% branch-coverage threshold
without modifying the source.

Resolved: 2026-08-19 40980b4
