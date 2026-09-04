# stuck-input-watcher regression fix — per-spell alert gate

## Context

A cycle 32 commit `1e58ebd` törölte a `prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts` inner guardot a `src/web/stuck-input-watcher.ts:201`-ben (`checkLocalSession`), és az `f1877ea`/`b23bccb` commitokkal együtt a `sendAlert` hívás most **minden 15 másodperces tick-en tüzel**, amíg egy stuck spell tart — ahelyett, hogy spell-enként egyszer tüzelne.

A user (eggp) ezt a `prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts` törlésről kérdező kérdéssel szúrta ki 2026-08-19-én. A verification agent megerősítette: a törlés funkcionális regresszió, nem pusztán dead-code eltávolítás.

### Root cause

Az MD (`stuck-input-watcher-give-up-inner-if-unreachable.md`) helyesen azonosította, hogy az inner guard dead code (`decideStuckInputRecovery` budget-spent branch-e `{ ...prev }`-et ad vissza, tehát `next.attempts >= max` ⇒ `prev.attempts >= max`). DE az MD összemosott két dolgot:

- "inner guard dead" = TRUE (technikailag helyes)
- "else-if body unreachable" = FALSE (az outer condition minden budget-spent tick-en tüzel, a spell végéig)

A törléssel a `sendAlert` "silent dead code" állapotból "user-facing 15s-onkénti Telegram/Slack alert" állapotba került. A `sendAlert` a `channel-monitor.ts:1259-1261`-ben `notifyChannel`-t hív, ami valódi kimenő üzenetet küld (Telegram/Slack/Discord/GoogleChat/Teams — `notify.ts:14-20`). `INTERVAL_MS = 15_000`.

A regression teszt (`b23bccb`) crafted mock state-et használ (`NO_STATE → stuck(5) → NO_STATE → stuck(5)`), ami két külön spell-t szimulál — nem egy spell-t 30+ percen át. A teszt tautológia: azt állítja, amit az új törött kód csinál.

Tripwire comment (Pattern 105) nem maradt a törölt sorok közelében — a `channel-health-monitor.ts:24` mintával ellentétben.

### Intended outcome

A `sendAlert` (és a két `logger.warn` a `recoverParkedPaste` / `bareEnterRecovery` site-okon) **egyszer tüzeljen spell-enként**, a spell "give-up" határ átlépésének pillanatában, és ne ismétlődjön a következő tick-eken. A spell végét (parkedSig → null) követő új spell tiszta lappal induljon.

## Fix design — minimal state-shape change

**Field:** `giveUpAlerted?: boolean` (opcionális, hogy a meglévő 15+ teszt mock object literal ne legyen köteles frissíteni)

**Lifecycle:**
- `NO_STUCK_INPUT` (`src/pane-state.ts:1271`) és `NO_STATE` (`src/web/stuck-input-watcher.ts:78`) tartalmazza: `giveUpAlerted: false`
- `decideStuckInputRecovery` 6 branch-e közül 4 (`{ ...prev }` a budget-spent, confirm-window, dedup-window ágakon) automatikusan megőrzi a flaget — ezekhez nem kell nyúlni
- Branch 1 (`{ ...NO_STUCK_INPUT }`), branch 2 (new spell), branch 3 (clock skew) mind a `NO_STUCK_INPUT`-ból vagy teljes literalból építkeznek — ezekhez sem kell külön hozzányúlni, mert az `attempts: 0` miatt az alert condition nem teljesül, a flag értéke irreleváns
- Branch 7 (actual recover, line 1341): full literal — de a watcher `prev`-et olvas, nem `next`-et, így itt sem kell változtatni
- A watcher (`checkLocalSession`) a flaget a `prev` watchState bejegyzésből olvassa, alert után re-store-olja `{ ...next, giveUpAlerted: true }`-val

**A gate:**
```ts
const prev = watchState.get(session) ?? NO_STATE  // már line 189-en megvan
const next = await recoverStuckInputForSession(...)

if (next.parkedSig === null) {
  watchState.delete(session)
} else {
  watchState.set(session, next)
  if (
    alertOnGiveUp &&
    next.attempts >= LOCAL_FAST_THRESHOLDS.maxAttempts &&
    !prev.giveUpAlerted   // NEW: per-spell gate
  ) {
    logger.warn(...)
    sendAlert(...)
    watchState.set(session, { ...next, giveUpAlerted: true })  // NEW: re-store with flag
  }
}
```

**Miért NEM érint channel-monitor.ts:** A `recoverStuckInputForSession` (`channel-monitor.ts:301-335`) változatlanul adja vissza `decision.next`-et (line 334). A flag transzparensen folyik át. A `mainStuckInput` és `agentStuckInput` state-ek csak `.parkedSig` / `.attempts` mezőket olvassák logolásra — nem használják a `giveUpAlerted` flaget, így init-jük nem igényel változtatást. A másik `sendAlert` hívás (`channel-monitor.ts:1082`, "stuck main input give-up") saját rate-limitinggel rendelkezik (`stuckRestartCount++`) — nem érintett.

## Decomposition — 5 atomic phases with per-phase verification

A user direktívája (2026-08-19): "decompose on your own initiative, and during execution verify the task too". Minden fázis:
1. Egyetlen fázis commitolódik
2. Közvetlenül a commit után: typecheck delta ≤ 0, érintett suite zöld
3. Csak az ellenőrzés után lépünk a következő fázisba

### Phase 1 — Type + NO_STATE constants (foundation, no behavior change)

**Commit:** `chore(pane-state,stuck-input-watcher): add optional giveUpAlerted flag to StuckInputState and NO_STATE constants`

**Diff:**
- `src/pane-state.ts:1240` — `StuckInputState` interface: add `giveUpAlerted?: boolean` (opcionális!)
- `src/pane-state.ts:1271` — `NO_STUCK_INPUT` const: add `giveUpAlerted: false`
- `src/web/stuck-input-watcher.ts:78` — `NO_STATE` const: add `giveUpAlerted: false`

**Verify:**
- `bun --bun tsc --noEmit` — delta 0
- `bun --bun vitest run src/__tests__/pane-state.test.ts src/__tests__/stuck-input-watcher.test.ts src/__tests__/stuck-input-fast-recovery.test.ts` — all green

**Risk:** Új required mező lenne TS hiba a 15+ teszt mock object literal-ban. Ezért opcionális `?:`.

### Phase 2 — checkLocalSession per-spell gate (THE critical fix)

**Commit:** `fix(stuck-input-watcher): gate sub-agent give-up alert on per-spell giveUpAlerted flag (cycle 32 regression fix)`

**Diff in `src/web/stuck-input-watcher.ts:188-204`:**
- Capture `prev = watchState.get(session) ?? NO_STATE` (already at line 189) — used for gate
- Add `!prev.giveUpAlerted` to the alert condition (third conjunct)
- After `sendAlert(...)`, re-store: `watchState.set(session, { ...next, giveUpAlerted: true })`
- Add tripwire comment (Pattern 105) above the gate explaining intent + regression history

**Verify:**
- `bun --bun tsc --noEmit` — delta 0
- `bun --bun vitest run src/__tests__/stuck-input-watcher.test.ts` — existing tests still pass (the "alerts on every tick" test at line 523-550 crafts 2 separate spells via NO_STATE separators, so 2 alerts still happen — semantic preserved)

**Tripwire comment content:**
```
// TRIPWIRE (cycle 32 regression, 2026-08-19): giveUpAlerted gates the alert
// to once per spell. The previous inner guard
// (`prev.attempts < LOCAL_FAST_THRESHOLDS.maxAttempts`) was dead code that
// silently swallowed the alert — but deleting it caused sendAlert to fire
// every 15s for the duration of a stuck spell (user-facing notification
// spam). Removing this gate restores that regression. The
// "alerts exactly once across multiple ticks" test in
// stuck-input-watcher.test.ts fails if the gate is dropped.
```

### Phase 3 — Apply same gate to warn-only sites (recoverParkedPaste, bareEnterRecovery)

**Commit:** `fix(stuck-input-watcher): gate recoverParkedPaste + bareEnterRecovery give-up warn on per-spell flag`

**Diff in `src/web/stuck-input-watcher.ts`:**
- `recoverParkedPaste` (line 124): add `&& !prev.giveUpAlerted` to warn condition; re-store with `{ ...next, giveUpAlerted: true }` after warn; tripwire comment
- `bareEnterRecovery` (line 160-167): same pattern (the outer condition already uses `prev` from line 145)

**Verify:**
- `bun --bun tsc --noEmit` — delta 0
- `bun --bun vitest run src/__tests__/stuck-input-watcher.test.ts` — green

**Risk:** A `bareEnterRecovery` line 160 az outer condition-t `next.parkedSig !== null && next.attempts >= THRESHOLDS.maxAttempts` formában használja. Az inner `prev.attempts < THRESHOLDS.maxAttempts` guardot töröltük cycle 32-ben (commit `1e58ebd`). Ugyanaz a log spam regresszió itt is fennáll — logger.warn szinten, de nem user-facing. A per-spell gate itt is szükséges a konzisztens viselkedéshez.

### Phase 4 — Regression test exercising real state machine

**Commit:** `test(stuck-input-watcher): regression test for per-spell alert gate using real decideStuckInputRecovery`

**Diff in `src/__tests__/stuck-input-watcher.test.ts`:**
- Add new test: "sub-agent give-up alert fires exactly once across multiple ticks of the same spell"
  - Mock `captureParkedInputView` to return parked text (NOT mock `recoverStuckInputForSession` — let real `decideStuckInputRecovery` run)
  - Drive ticks via `vi.advanceTimersByTimeAsync` for `INITIAL_DELAY_MS + 6 * INTERVAL_MS` (initial + 6 intervals)
  - Assert `mockSendAlert.toHaveBeenCalledTimes(1)` after 6 budget-spent ticks
- Update existing "alerts on every tick" test (line 523-550): either delete (it asserts tautology) OR update to assert that crafted separate-spell sequence still fires once per spell

**Verify:**
- `bun --bun tsc --noEmit` — delta 0
- `bun --bun vitest run src/__tests__/stuck-input-watcher.test.ts` — green
- Sanity check: revert Phase 2 commit, run the new test → it should FAIL (proves the test catches the regression)
- Re-apply Phase 2, run → PASS

### Phase 5 — MD resolution + INDEX update

**Commit:** `docs(needs-to-be-fix): mark stuck-input-watcher-give-up-inner-if-unreachable resolved with per-spell gate fix`

**Diff:**
- `docs/needs-to-be-fix/stuck-input-watcher-give-up-inner-if-unreachable.md` — add Resolution section pointing at Phase 2 commit SHA, explain why the original "drop guard" approach was unsafe, document the per-spell gate design
- `docs/needs-to-be-fix/INDEX.md` — update Resolved column for `stuck-input-watcher-give-up-inner-if-unreachable` to `Resolved: 2026-08-19 <phase-2-sha>`

**Verify:**
- INDEX.md total count assertion stays consistent (177 → 177, no new MDs, no retirements)

### Phase 6 — Code review

**Run:** `/code-review xhigh --fix <cycle-32-base-sha>..HEAD`

Apply any findings. If code-review skill surfaces issues with the per-spell gate, address them with surgical edits + tripwire comments.

## Files touched

```
src/pane-state.ts (type + NO_STUCK_INPUT)
src/web/stuck-input-watcher.ts (NO_STATE + 3 gate sites + tripwire comments)
src/__tests__/stuck-input-watcher.test.ts (regression test)
docs/needs-to-be-fix/stuck-input-watcher-give-up-inner-if-unreachable.md (resolution)
docs/needs-to-be-fix/INDEX.md (Resolved column)
```

`src/web/channel-monitor.ts` NOT touched — `recoverStuckInputForSession` returns `decision.next` verbatim, the new field flows through transparently.

## Verification end-to-end

After all 6 phases complete:
1. `bun --bun tsc --noEmit` — delta 0 vs 1701 baseline
2. `bun --bun vitest run` — all 11133+ tests green
3. `git log --oneline <cycle-32-base-sha>..HEAD` — 5-6 commits, all with descriptive conventional-commit messages
4. `git diff --stat <cycle-32-base-sha>..HEAD` — expected: ~10 source lines, ~30 test lines, ~10 doc lines
5. `/code-review xhigh --fix <range>` — clean

## Risks and mitigations

| Risk | Mitigation |
|---|---|
| Required field breaks 15+ test mocks | Phase 1 uses optional `?:` |
| Branch 7 in decideStuckInputRecovery loses flag | Watcher reads `prev` (not `next`), so branch 7 is irrelevant; re-store after alert fixes any drift |
| Existing "alerts every tick" test breaks | The test crafts separate spells via NO_STATE separators — 2 alerts still happen, test passes |
| Regression test is tautological (like the old one) | Phase 4 explicitly uses real `decideStuckInputRecovery` (not vi.doMock) and asserts once across multiple ticks |
| Tripwire comment forgotten on one of 3 sites | Phase 2 + Phase 3 each include tripwire comments explicitly in their diffs |
| User pushes during workflow | Workflow starts from current HEAD, aborts if divergence appears |

## Execution

Single `Workflow` tool invocation from `test/baseline` HEAD, 5 agents:

1. **Agent 1** — Phase 1 (type + constants), 1 commit, verifies
2. **Agent 2** — Phase 2 (checkLocalSession gate — the critical fix), 1 commit, verifies
3. **Agent 3** — Phase 3 (warn-only sites), 1 commit, verifies
4. **Agent 4** — Phase 4 (regression test), 1 commit, verifies with revert-and-replay sanity check
5. **Agent 5** — Phase 5 (docs) + Phase 6 (code-review skill invocation)

Push is the user's exclusive right. No `git push` from the workflow.
