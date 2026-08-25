# src/web/vault-bindings.ts: two branches are unreachable from any caller

## Location

`src/web/vault-bindings.ts`:

1. **Line 163** — `maskValue` short-mask branch: `if (val.length <= 6) return '***'`
2. **Line 236** — `serverHasVaultRefs` undefined-env branch: `if (!env) return false`

## Excerpt

```ts
// maskValue (line 162-165)
function maskValue(val: string): string {
  if (val.length <= 6) return '***'           // <-- line 163
  return val.slice(0, 3) + '...' + val.slice(-3)
}

// serverHasVaultRefs (line 235-238)
function serverHasVaultRefs(env: Record<string, string> | undefined): boolean {
  if (!env) return false                      // <-- line 236
  return Object.values(env).some(v => typeof v === 'string' && v.startsWith('vault:'))
}
```

## Failure scenario

Coverage: 98.99% statements, 98.19% branches, 100% functions, 100% lines.
The CI gate (`vitest.config.ts` thresholds lines/functions/branches/statements at 100% for every `src/*.ts`) reports this file as under-covered even though every reachable behaviour is tested.

1. **maskValue short branch (line 163)** — `maskValue` is the only consumer of `looksLikeSensitiveValue`, which rejects every value shorter than 8 characters (`looksLikeSensitiveValue` at line 168: `if (!val || val.length < 8) return false`). Anything that reaches `maskValue` has therefore already cleared that 8-char gate, so `val.length <= 6` can never be true at the call site. The `'***'` fallback exists only to defend against an internal invariant break; it is unreachable from the public surface.

2. **serverHasVaultRefs undefined-env branch (line 236)** — both internal call sites guard with `if (!serverCfg.env) continue` BEFORE invoking `serverHasVaultRefs`:
   - `removeBindingsForSecret` (line 122): `if (!serverCfg.env) continue`
   - `unsyncBinding` (line 336): `if (!serverCfg.env) continue`

   The function's signature (`Record<string, string> | undefined`) suggests `undefined` is a legitimate input, but every caller filters undefined out first. The branch is dead code from any reachable call.

## Pinning test

`src/__tests__/vault-bindings.test.ts` already exercises every reachable branch:
- `maskValue` is invoked from `scanMcpConfigs` with values >= 8 chars (every sensitive-looking env var the suite emits is 8+ chars; the 8-char gate in `looksLikeSensitiveValue` blocks anything shorter).
- `serverHasVaultRefs` is called from `removeBindingsForSecret` / `unsyncBinding` only after the `if (!serverCfg.env) continue` early return, so every `serverHasVaultRefs` invocation sees a defined env.

```ts
// Pinning assertion (the short-mask branch at line 163 is never reached):
it('flags a sensitive env var/value pair as a finding', () => {
  // maskedValue is always "first3...last3" because looksLikeSensitiveValue
  // requires val.length >= 8 before maskValue is called.
  expect(findings[0].maskedValue).toBe('rea...ere') // 12 chars in, 9 chars out
})
```

```ts
// Pinning assertion (the undefined-env branch at line 236 is never reached):
it('does nothing on env branch when serverCfg.env is undefined', () => {
  // The SUT's `if (!serverCfg.env) continue` skips the target BEFORE
  // serverHasVaultRefs is called, so the undefined input is never observed
  // by the function.
  unsyncBinding('t', 'TOKEN')
  // No crash, no call to serverHasVaultRefs(undefined).
})
```

## Suggested direction

Either:

1. **Remove the dead code**:
   - `maskValue`'s `if (val.length <= 6) return '***'` branch (line 163) is unreachable from any caller. Removing it (or replacing `maskValue` with a single `val.slice(0, 3) + '...' + val.slice(-3)` expression) brings `src/web/vault-bindings.ts` to 100% statement coverage without any test changes.
   - `serverHasVaultRefs`'s `if (!env) return false` branch (line 236) is unreachable from any caller. Tightening the parameter type to `Record<string, string>` (non-undefined) — or letting TypeScript's control-flow analysis confirm it — would let the branch be deleted.

2. **Reach the branches via a new caller**:
   - Add a top-level utility (e.g. `hasVaultEnv(serverCfg: { env?: Record<string, string> }): boolean`) that wraps `serverHasVaultRefs` and DOES permit undefined input. The current `serverHasVaultRefs` is already written defensively for that signature; the missing piece is a caller that exercises it.
   - Lower the `looksLikeSensitiveValue` length gate from 8 to 6, and shorten `maskValue`'s cutoff to match. That makes the `<= 6` branch reachable from `scanMcpConfigs`. The wider consequence is that mask outputs shorter than 8 chars would lose the truncation property — probably undesirable, which is why this path is not taken.

3. **Export the helpers for unit testing** — `maskValue` and `serverHasVaultRefs` are not exported. Exporting them would let a unit test construct inputs that bypass the internal guards (a 6-char string for `maskValue`, an explicit `undefined` for `serverHasVaultRefs`) and reach 100% without depending on the internal `looksLikeSensitiveValue` / `removeBindingsForSecret` flow.

Per task rule "NEVER modify src/web/vault-bindings.ts" all three are blocked until the user overrides; the test suite documents the gap and the pinning cases above should be added alongside the fix.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
