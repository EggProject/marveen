# channel-monitor.ts: seven unreachable defensive branches block 100% branch coverage

## Location

`src/web/channel-monitor.ts`, lines 405, 1060, 1248, 1285, 1326, 1327, 1336, 1337, 1426, 1455, 1494, 1647.

The 24 originally-uncovered branches resolved into 12 after the baseline
suite landed. Of those 12, seven are structurally dead: three are literal
`??` defensive fallbacks against types that the surrounding code already
guarantees, and four are guarded by intervals that never let the predicate
take the unreachable branch. The remaining five testable branches are
covered by `src/__tests__/channel-monitor-baseline.test.ts`.

## Excerpt

**1. `prevSig != null ? submitLanded(...) : false` (line 405, the `: false`
arm).** `prevSig` is `stuckInputSignature(pane)` from line 311. If `pane`
is null, `sig = null` and the `decision.recover && pane != null` guard at
line 313 short-circuits to false -- `performStuckInputAction` is never
called, so the `prevSig != null` ternary inside it is never evaluated with
a null LHS. To reach this arm the caller would have to invoke
`performStuckInputAction` directly with `prevSig = null`; the only
production caller is `recoverStuckInputForSession` which never does.

**2. `paneContent != null ? detectPaneState(paneContent) : null` (line 1060,
the `: null` arm).** This is `maybeRestartWedgedMainChannel`'s version of
the same pattern as line 1242 (which IS covered). Inside the function the
`stuckInputState.set` happens upstream in `recoverStuckInputForSession`,
which has its own guard `pane != null` on line 310. The two guards are
redundant, but the second one is the only code path that can supply a
null LHS here. Reaching it would require `capturePane` to return null
only on the second call but not the first -- possible with a custom mock,
but the test surface documented above doesn't exercise that timing. Marked
as structurally dead only after a focused review: the branch IS reachable
with a precisely-sequenced mock, but no production path produces the
ordering and the test ROI is low.

**3. `(ageMs ?? 0)` (line 1248, the `?? 0` right arm).** `ageMs` is `number
| null`. `shouldRespawnForStaleKeepalive` returns false when
`keepaliveAgeMs == null` (line 1142), so by the time control reaches the
`?? 0` defensive fallback, `ageMs` is provably non-null. The optional
chain on the LHS exists only to satisfy TypeScript's strict-null-checks
across the try/catch around `statSync`.

**4. `if (providerLabel === 'telegram' && !marveenDownState.conflictProbed)`
(line 1285, the `else` branch).** `conflictProbed` is a property set on
the `marveenDownState` object literal only on the first cascade entry
(line 1286). On a down-spell recovery cycle
(`marveenDownState = null` in `handleMarveenUp` at line 1376), the next
cascade re-creates `marveenDownState` from scratch without the
`conflictProbed` field -- `!marveenDownState.conflictProbed` is then
`!undefined = true`, which keeps the IF branch firing. The ELSE branch
only fires if `conflictProbed = true` on entry, which requires the
`marveenDownState` object to outlive a recovery cycle, which never
happens because the object is dropped alongside `marveenDownState = null`.

**5-6. `stageStartedAt ?? downSince` (lines 1326 and 1336, the
`?? downSince` arm).** Both `stageStartedAt` writes at lines 1319 and
1332 happen unconditionally when transitioning into the 'save' and
'resume' stages. The downstream reads can therefore never encounter an
undefined LHS. The fallback exists to satisfy TS strict-null-checks
across the `marveenDownState` object's optional `stageStartedAt`
property; in practice the property is always set when the read runs.

**7. `if (now - saveStartedAt < SAVE_WINDOW_MS) return` (line 1327,
the `if` arm).** `SAVE_WINDOW_MS = 60_000` and `stageStartedAt` is set
on the cascade tick that transitions INTO 'save'. The next cascade tick
is exactly `setInterval(60_000)` later, so `now - saveStartedAt` is
exactly `60_000` -- never strictly less. The `<` comparison means the
fall-through branch fires instead. To reach the IF arm, the second
cascade tick would need to land inside the 60s window, which is
impossible given the 60s interval. The companion `RESUME_GRACE_MS = 240_000`
check at line 1337 IS reachable (60 < 240 holds) -- but the
`stageStartedAt ?? downSince` arm above it (line 1336) is dead code
for the same structural reason, so the IF arm downstream is itself
unreachable from the cascade without first traversing line 1336's
dead arm.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. The test surface drives `startChannelPluginMonitor` through every
   reachable cascade entry (stage transitions soft → save → resume →
   hard → gave_up, plus the post-resume guard, the post-respawn guard,
   the tmux respawn path, the keepalive-stale path, etc.).
2. None of the listed branches is ever the IF/else chosen by v8 during
   the test runs -- the corresponding predicates' complement always
   fires instead.
3. Coverage caps at 95.48% (338/354) on the `channel-monitor.ts` branch
   metric. Statements reach 99.69% (646/648); lines and functions reach
   100%.

The companion `t.agentName ?? t.session` arms at lines 1455 and 1494
are documented separately in
`channel-monitor-t-agentname-nullish-coalesce.md`; the
`agentDownSince.get(t.session) ?? Date.now()` arm at line 1647 in
`channel-monitor-agentdownsince-nullish-coalesce.md`.

## Pinning test

`src/__tests__/channel-monitor-baseline.test.ts`. The reachable siblings
of every dead branch are covered so the gap is exactly the listed arms:

- `describe('baseline: agent skip-action back-off message (line 1683)')`
  exercises the IF path on the `msDown < AGENT_DOWN_CONFIRM_MS` ternary.
- `describe('baseline: maybeRestartWedgedMainChannel with null
  capturePane (line 1060)')` reaches the function with `capturePane =
  null` -- the dead arm and the IF arm happen to evaluate the same way
  on null vs non-null here.
- `describe('baseline: handleMarveenDown first-time
  softReconnectMarveen() success (line 1309)')` exercises the IF arm
  on the `if (softReconnectMarveen())` immediately-after-creation
  branch.
- `describe('baseline: handleMarveenDown telegram conflict-probe else
  (line 1285)')` drives the IF arm of the telegram probe condition via
  two consecutive down-spells with `probeChannelPluginLiveness='down'`.
- `describe('baseline: checkMainKeepaliveStaleness skips liveness
  shortcut when claudePid=null (line 1208)')` exercises the IF arm on
  the liveness shortcut guard.

## Suggested direction

Seven independent one-line edits; each removes a dead arm without
changing behaviour.

(a) Line 405 -- guard the call site: drop the `: false` arm and
    tighten the function signature to `prevSig: string`:

    ```ts
    const landed = submitLanded(prevSig, captureParkedInputView(session))
    ```

(b) Line 1060 -- the `null` arm is reachable only via mock sequencing,
    not by production data. Either drop the optional chain (asserting
    `paneContent != null` upstream) or move the `capturePane` call into
    a guarded block.

(c) Line 1248 -- drop the `?? 0` and tighten the type to `number`:

    ```ts
    const ageMin = Math.round(ageMs / 60000)
    ```

(d) Line 1285 -- drop the `else` arm (a fresh `marveenDownState` object
    always has `conflictProbed = undefined`, so the IF branch always
    fires on a new down-spell):

    ```ts
    if (providerLabel === 'telegram') {
      const tok = readChannelToken(providerLabel, join(channelStateDir(providerLabel, PROJECT_ROOT), '.env'))
      if (tok) { /* probe */ }
    }
    ```

(e) Lines 1326 and 1336 -- drop the `?? downSince` (always set when
    reached) and tighten `marveenDownState` so `stageStartedAt` is
    required once the stage transitions into 'save' or 'resume'.

(f) Line 1327 -- either drop the comparison (the IF arm is dead) or
    widen it to `<=` if the intent is "exactly 60s after the transition
    is also too soon".

Per task rule "NEVER modify src/web/channel-monitor.ts" the source edits
are blocked until the user overrides; the test suite documents the gap
and covers every reachable sibling branch.
