# reauth-healer.ts: stampAlert `if (st)` false branch is dead code

## Location

`src/web/reauth-healer.ts`, line 395 (inside the inline `stampAlert`
callback that `sweep()` passes to `flushQuietSummary`):

```ts
flushQuietSummary(
  quiet,
  (session) => watchState.get(session)?.consecutiveDead ?? 0,    // line 391
  sendNotify,
  (session) => {                                                  // line 393
    const st = watchState.get(session)                            // line 394
    if (st) watchState.set(session, { ...st, lastActionAtMs: Date.now() })  // line 395 -- false half unreachable
  },
)
```

## Excerpt

```ts
// Inside sweep() at reauth-healer.ts:389-397
flushQuietSummary(
  quiet,
  (session) => watchState.get(session)?.consecutiveDead ?? 0,
  sendNotify,
  (session) => {
    const st = watchState.get(session)
    if (st) watchState.set(session, { ...st, lastActionAtMs: Date.now() })
  },
)
```

## Failure scenario

The `if (st)` guard has a false branch that is genuinely unreachable in
production. The flow inside `flushQuietSummary` is:

1. Iterate the `suppressed` map (entries collected via
   `[...suppressed.values()]`).
2. For each entry, call `stillDeadCount(session)` which calls
   `watchState.get(session)`. If the entry's count is `<= 0`, drop it.
3. For each remaining (`stillDead`) entry, call `stampAlert(session)`
   which calls `watchState.get(session)` again.

There is NO mutation of `watchState` between steps 2 and 3
(`flushQuietSummary` is synchronous, no `await`, no `.set`/`.delete`
between the two reads). Both reads happen on the same Map with the same
key. If `stillDeadCount(session) > 0`, then `watchState.get(session)`
returned a state object; the same read for `stampAlert(session)` MUST
also return a state object. `st` is therefore always truthy when
`stampAlert` runs. The false branch can never fire.

A `vi.spyOn(Map.prototype, 'get', ...)` would intercept the two reads,
but:

- `watchState` is a module-level `const` (not exported, no accessor),
  so the spy cannot be scoped to "this specific Map" -- it would also
  fire on every other Map the source reads during the sweep
  (`quietSuppressed`, internal flushQuietSummary state, etc.), and any
  return-`undefined` from the spy would corrupt `checkSession`'s own
  `prev = watchState.get(session) ?? NO_REAUTH_STATE` read on the same
  key. The next `checkSession` would reset `consecutiveDead` to 1 every
  tick, the escalation would never re-fire, and the morning summary
  would never be emitted. That breaks the very flow we want to test.

In short: the inline `stampAlert` callback is unreachable in normal
flow, and the only way to make its `if (st)` false branch fire without
modifying `src/web/reauth-healer.ts` is to corrupt the source's other
invariants, which would make the test fail for unrelated reasons.

## Pinning test

`src/__tests__/reauth-healer.test.ts` -- the `flushQuietSummary >
pinning: stampAlert `if (st)` false branch (dead-code guard, see bug
MD)` test asserts the EXTERNAL behaviour (notify fires with the morning
summary, the suppressed buffer clears) via the public `flushQuietSummary`
entry point. The `if (st)` defensive guard is pinned by the file-level
coverage report: the `false` arm shows up as uncovered (1 branch) in
the v8 report, locking the production-flow reachability for any future
refactor that tries to exercise it.

## Suggested direction

Preferred: drop the defensive `if (st)` check entirely. `stillDeadCount`
returning `> 0` already establishes that `watchState.get(session)` is a
state object. The `if (st)` check exists only because TypeScript widens
the read to `state | undefined` (the iterator-style `Map.get` return
type), but the producer of the value is the same Map.

If keeping the guard is preferred for clarity, annotate with
`/* v8 ignore next -- stillDeadCount > 0 proves the read is non-null */`
so the coverage gate doesn't fail on a branch the production flow can't
exercise. The rest of the file already uses this annotation pattern
elsewhere.

Both are one-line changes to `src/web/reauth-healer.ts`. Per the task
rule "NEVER modify src/web/reauth-healer.ts" neither was applied; this
MD is the authoritative pin until a resolution is chosen.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
