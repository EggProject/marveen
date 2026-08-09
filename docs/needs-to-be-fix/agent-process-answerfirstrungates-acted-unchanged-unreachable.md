# agent-process.ts: `answerFirstRunGates` final-return `'unchanged'` arm is unreachable

## Location

`src/web/agent-process.ts`, line 1512:

```ts
return acted ? 'cleared' : 'unchanged'
```

The right arm (`'unchanged'`) of the ternary at the function's tail is dead.

## Excerpt

```ts
// src/web/agent-process.ts:1481-1513
export async function answerFirstRunGates(
  session: string,
  host: string | null = null,
): Promise<'cleared' | 'login' | 'unchanged'> {
  let acted = false
  for (let i = 0; i < FIRST_RUN_ANSWER_MAX_STEPS; i++) {
    const pane = capturePane(session, host)
    const gate: FirstRunGateKind | null = pane != null ? detectsFirstRunGate(pane) : null
    if (gate == null) return acted ? 'cleared' : 'unchanged'
    if (gate === 'login') return 'login'
    try {
      ... keystroke answer ...
    } catch (err) {
      logger.warn({ err, session, gate }, 'first-run gate: answer keystroke failed')
      return acted ? 'cleared' : 'unchanged'
    }
    acted = true
    logger.info({ session, gate, step: i }, 'first-run gate: answered dialog')
    await delay(FIRST_RUN_ANSWER_SETTLE_MS)
  }
  return acted ? 'cleared' : 'unchanged'
}
```

For the for-loop's natural exit (after `FIRST_RUN_ANSWER_MAX_STEPS`
iterations) to run, every iteration must have:
1. `gate !== null` (otherwise the line 1489 early return fires),
2. `gate !== 'login'` (otherwise the line 1490 early return fires), and
3. the try-block must complete without throwing (otherwise the
   line 1506 catch fires).

Under those three constraints, `acted = true` is set on line 1508
every iteration, so on natural exit `acted === true` and the
`acted ? 'cleared' : 'unchanged'` ternary returns `'cleared'`.

The `: 'unchanged'` arm at line 1512 is reachable only when `acted`
is false at the natural exit. That requires a code path where the
loop completes without setting `acted = true`. No such path exists.

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

The existing suite (`describe('answerFirstRunGates')` in
`src/__tests__/agent-process.test.ts`) covers every reachable branch:

- line 1489 early-return with `acted === false` → 'unchanged' (test at 2258)
- line 1489 early-return with `acted === true` (after a successful answer) → 'cleared' (test at 2286)
- line 1490 'login' return (test at 2272)
- line 1506 catch-return with `acted === false` → 'unchanged' (test at 2306)
- line 1506 catch-return with `acted === true` → 'cleared' (test at 2313)
- line 1512 natural-exit with `acted === true` → 'cleared' (test at 2325)

The line 1512 `acted ? 'cleared' : 'unchanged'` ternary's `: 'unchanged'`
arm has 0 hits in v8 coverage (cond-expr counts `[1, 0]`).

## Pinning test

`src/__tests__/agent-process.test.ts` — `'stops after the bounded number
of steps when gates keep reappearing'` (line 2313-2318) pins the
reachable 'cleared' arm:

```ts
it('stops after the bounded number of steps when gates keep reappearing', async () => {
  paneSequence(['gate'])
  H.detectsFirstRunGate.mockReturnValue('theme')
  expect(await AP.answerFirstRunGates('agent-zara')).toBe('cleared')
  expect(sentKeys()).toHaveLength(6)
})
```

The right arm of the ternary at line 1512 has no reachable input; the
test documents this without an explicit assertion that would require a
mock impossible to construct.

## Suggested direction

The defensive `?:` at line 1512 mirrors the same pattern at line 1489
and 1506, where `acted ? 'cleared' : 'unchanged'` IS reachable with
both arms (line 1489/1506 early-return path can leave `acted` false).
Keeping the symmetric ternary at line 1512 is the lower-cost option
even though the right arm is dead; collapsing it to `'cleared'` would
match the actual reachable behaviour:

```ts
return 'cleared'
```

Per task rule "NEVER modify src/web/agent-process.ts" the source edit
is blocked until the user overrides; the test suite documents the
gap and pins the reachable sibling branches.
