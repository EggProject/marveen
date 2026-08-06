# channel-plugin-unlock.ts: `raw ?? ''` nullish fallback is structurally unreachable

## Location

`src/web/channel-plugin-unlock.ts:108`

```ts
function getSessionClaudePid(session: string): number | null {
  try {
    const raw = execFileSync(TMUX, ['list-panes', '-t', session, '-F', '#{pane_pid}'], {
      timeout: 3000,
      encoding: 'utf-8',
    }).trim().split('\n')[0]
    const pid = parseInt(raw ?? '', 10)   // <-- line 108
    return Number.isFinite(pid) && pid > 1 ? pid : null
  } catch (err) {
    logger.warn({ err, session }, 'channel-plugin-unlock: failed to read session claude pid')
    return null
  }
}
```

## Excerpt

The `raw ?? ''` defensive fallback is meant to guard against a nullish
`raw`. But `raw` is the result of `execFileSync(...).trim().split('\n')[0]`:

- `execFileSync(...).trim()` is always a string (the `encoding: 'utf-8'`
  option guarantees a string return; any non-string would throw
  TypeError on `.trim()` and be caught by the outer try/catch).
- `String.prototype.split('\n')` is documented to always return an array
  with at least one element, so `[0]` is always a string.
- Therefore `raw` is provably never null or undefined at runtime. The
  right-hand side of `??` is dead code.

v8 branch coverage cannot see the false branch of `??` as covered by any
real-world execFileSync output. To reach the false branch the test had
to fabricate an execFileSync return shape whose `.trim().split('\n')[0]`
yields `undefined` -- an object literal
`{ trim: () => ({ split: () => [] }) }`. That is a synthetic input that
no real tmux invocation can produce.

## Failure scenario

1. A test runner that enforces 100% branch coverage (this repo's vitest
   config) cannot reach 100% on `src/web/channel-plugin-unlock.ts`
   without either:
   a. Fabricating a structurally impossible execFileSync return shape
      (current approach in `channel-plugin-unlock.test.ts`); or
   b. Removing the `?? ''` fallback.
2. If a future refactor removes the `?? ''` defensively, no real-world
   regression is caught -- the change is invisible to any test that uses
   real tmux output.
3. The defensive code creates the false impression that `raw` can be
   nullish, which a future reader may rely on (e.g. writing
   `if (!raw) ...` elsewhere, expecting `raw` to potentially be
   `undefined`).

## Pinning test

`src/__tests__/channel-plugin-unlock.test.ts` -- the
`'treats a list-panes payload that yields an undefined raw as NaN (falls back to "")'`
test currently exercises the `??` false branch via a hand-crafted
mock. The test passes today; it pins the (unreachable) behaviour.

If the bug is fixed (the `?? ''` is removed because `raw` is provably a
string), the test should be updated / removed -- the
"treats a list-panes payload that yields an undefined raw" test becomes
moot because the parseInt will receive `undefined` (parseInt coerces to
NaN anyway).

## Suggested direction

Two acceptable resolutions:

1. **Drop the defensive fallback.** `raw` is provably a string by
   construction (`execFileSync(...).trim().split('\n')[0]`), so the
   fallback can never fire. Replace `raw ?? ''` with `raw`:

   ```ts
   const pid = parseInt(raw, 10)
   ```

   The `parseInt` already coerces an empty string to NaN, which
   `Number.isFinite(pid) && pid > 1` correctly rejects. This is the
   simplest fix and removes the dead branch.

2. **Keep the fallback but acknowledge it is unreachable.** Add a
   `/* istanbul ignore next */` (or equivalent) comment above the
   fallback to tell coverage tooling it is structural. v8 has no
   equivalent comment directive, so this is less clean than option 1.

Recommended: option 1. The `??` is genuinely dead code, and removing
it makes the code more honest about its invariants.
