# agent-process.ts: three unreachable defensive branches block 100% branch coverage

## Location

`src/web/agent-process.ts`, lines 777, 1384 and 1512.

```ts
// line 777, inside runTmux
execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? (host ? 8000 : 3000), stdio: ['ignore', 'ignore', 'pipe'] })

// line 1384, inside restartAgentProcess
if (!stopResult.ok) return { ok: false, error: stopResult.error || 'Failed to stop running agent before restart' }

// line 1512, the fall-out-of-loop return of answerFirstRunGates
return acted ? 'cleared' : 'unchanged'
```

## Excerpt

All three are defensive fallbacks that no caller inside the module can
reach. Each is dead for a different structural reason.

**1. `runTmux`'s remote default timeout (line 777, the `host ? 8000` arm).**

The `8000` arm is only evaluated when `opts.timeout` is `undefined` AND
`host` is non-null. There is exactly one `runTmux` call in the whole file
that omits `opts`:

```ts
// line 978, inside startAgentProcess
runTmux(null, ['kill-session', '-t', session])
```

and it hard-codes `host = null`, so it takes the `3000` arm. Every one of
the other 24 `runTmux` call sites passes an explicit `{ timeout: ... }`
(5000, 10000), which short-circuits the `??` before the ternary is
evaluated. The remote default is therefore unreachable.

Note the sibling `captureTmux` (line 785) has the identical expression and
IS reachable on both arms: `agentRunState` / `sessionExistsOnHost` /
`getAgentRunningSince` all call it without `opts`, for both local and
remote hosts. Only the `runTmux` copy is dead.

**2. `restartAgentProcess`'s error fallback (line 1384, the `||` right arm).**

`restartAgentProcess` only calls `stopAgentProcess` after
`isAgentRunning(name)` returned true, and `stopAgentProcess` has exactly two
`ok: false` returns:

```ts
if (!isAgentRunning(name)) return { ok: false, error: 'Agent is not running' }
// ...
return { ok: false, error: 'Failed to stop tmux session' }
```

Both carry a non-empty string, so `stopResult.error` is never falsy when
`!stopResult.ok` holds, and `'Failed to stop running agent before restart'`
can never be produced. (The race where the agent stops between
`restartAgentProcess`'s check and `stopAgentProcess`'s own re-check IS
reachable, but it yields `'Agent is not running'` -- still truthy.)

**3. `answerFirstRunGates`'s loop-exhaustion return (line 1512, the
`'unchanged'` arm).**

Control reaches line 1512 only by running all `FIRST_RUN_ANSWER_MAX_STEPS`
(6) iterations without an early `return`. Every path that survives an
iteration passes through `acted = true` (line 1508) -- the two early exits
before it (`gate == null`, `gate === 'login'`) and the keystroke-failure
`catch` all `return` from inside the loop. So `acted` is necessarily `true`
at line 1512 and only `'cleared'` can be returned.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

1. A caller drives every reachable path of `runTmux`, `restartAgentProcess`
   and `answerFirstRunGates` -- including the remote (ssh) variants, a
   failed stop, and a 6-deep first-run dialog chain.
2. `runTmux` is never invoked with a non-null host and no explicit timeout,
   so v8 records the `8000` arm as untaken.
3. `stopResult.error` is always a non-empty string, so v8 records the `||`
   right arm as untaken.
4. `acted` is always `true` at line 1512, so v8 records the `'unchanged'`
   arm as untaken.
5. Branch coverage caps at 99.38% (481/484) while statements, lines and
   functions all reach 100%.

Unlike the `auto-restart-runner` `??` fallbacks (which were reachable by
patching `Map.prototype.get`), these three have no test-side lever: they are
gated on literal arguments at the call sites inside the module, not on any
mockable collaborator. Reaching them requires editing the source.

## Pinning test

`src/__tests__/agent-process.test.ts`. The reachable siblings are covered so
the gap is exactly the three arms above:

- `describe('agentRunState')` -- "routes through ssh for a remote agent and
  sets the longer timeout" asserts `captureTmux`'s remote 8000 default, the
  live twin of the dead `runTmux` one.
- `describe('restartAgentProcess')` -- "aborts when the stop fails" asserts
  the propagated `'Failed to stop tmux session'`, proving `stopResult.error`
  is populated.
- `describe('answerFirstRunGates')` -- "stops after the bounded number of
  steps when gates keep reappearing" drives all 6 iterations and asserts the
  `'cleared'` result.

## Suggested direction

Three independent one-line edits; each removes the dead arm without changing
behaviour.

(a) Line 777 -- drop the remote arm and name the local default, since
    `runTmux` is only ever called with an explicit timeout when remote:

    ```ts
    execFileSync(inv.file, inv.args, { timeout: opts.timeout ?? 3000, stdio: ['ignore', 'ignore', 'pipe'] })
    ```

    If the intent is genuinely "a remote call should default to 8000", the
    better fix is the opposite direction: delete the explicit
    `{ timeout: 5000 }` from the remote `kill-session` (line 1349) and the
    send-keys sites so the default actually governs. That is a behaviour
    change and should be a deliberate decision, not a silent one.

(b) Line 1384 -- drop the `||`, since the type already guarantees the field
    is set on the failure path:

    ```ts
    if (!stopResult.ok) return { ok: false, error: stopResult.error }
    ```

    Tightening `stopAgentProcess`'s return type to
    `{ ok: true } | { ok: false; error: string }` would make this provable
    to the compiler rather than by inspection.

(c) Line 1512 -- return the constant, and let the comment carry the
    invariant:

    ```ts
    // Reaching here means all FIRST_RUN_ANSWER_MAX_STEPS iterations answered
    // a dialog (every earlier exit returns from inside the loop), so acted
    // is necessarily true.
    return 'cleared'
    ```

Per task rule "NEVER modify src/web/agent-process.ts" the source edits are
blocked until the user overrides; the test suite documents the gap and pins
every reachable sibling branch.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
