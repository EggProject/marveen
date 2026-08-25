# updates.ts:198 -- releaseLock's `if (!lockHeld) return` early-exit is unreachable

## Location

`src/web/routes/updates.ts`, lines 196-201 (`releaseLock` closure inside
`/api/updates/apply`):

```ts
const releaseLock = () => {
  if (!lockHeld) return
  try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
  lockHeld = false
}
```

## Excerpt

The `if (!lockHeld) return` early-exit at line 198 is **structurally
unreachable** through the route's public API. `releaseLock` is only
ever called from the apply handler after `lockHeld = true` has been
set (around line 145-148 of the apply path). The only writer to
`lockHeld = false` is `releaseLock` itself, so the only way for a
subsequent `releaseLock` call to see `lockHeld === false` is if it was
already called once before -- but the apply handler invokes
`releaseLock` exactly once per request.

The `if (!lockHeld) return` defensive guard exists as belt-and-braces
insurance against a future refactor that introduces a second
`releaseLock()` call site before the first sets `lockHeld = false`.
None exists today.

## Failure scenario

v8 reports `branch 28 line=198 type=if counts=[0, 11]` -- the
condition was evaluated 11 times across the existing
`routes-updates.test.ts` suite, the false side (lockHeld=true,
proceed to unlinkSync) hit 11 times, the true side (early-exit,
lockHeld=false) hit 0 times.

The 100% branch coverage gate fails on this file because of this dead
branch.

The existing pinning test
`src/__tests__/routes-updates.test.ts` "releaseLock: pinning test
documents the structurally unreachable `if (!lockHeld) return` branch"
documents this exact observation in its comment block.

Options:

1. Drop the `if (!lockHeld) return` guard. The `releaseLock` function
   is always called with `lockHeld === true`. Tighten the closure to
   `() => { try { unlinkSync(...) } catch {} lockHeld = false }`.

2. Leave the guard (current state) as belt-and-braces.

Option (1) is the cleanest fix.

## Pinning test

`src/__tests__/routes-updates.test.ts` has a dedicated pinning test
("releaseLock: pinning test documents the structurally unreachable
`if (!lockHeld) return` branch") that drives an outer spawn failure
through the route, verifies the lock IS released (lockHeld flips
true -> false through the false branch), and asserts via the
`expect(existsSync(UPDATE_PIDFILE)).toBe(false)` that the unlink
ran. The test comment block explicitly notes the bug MD that this
branch is unreachable.

## Suggested direction

Per option (1): drop the early-exit guard. The closure becomes:

```ts
const releaseLock = () => {
  try { unlinkSync(UPDATE_PIDFILE) } catch { /* already gone */ }
  lockHeld = false
}
```

Per task rule "NEVER modify src/web/routes/updates.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
