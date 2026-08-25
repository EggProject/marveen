# pane-state.ts: unreachable defensive branches block 100% branch coverage

## Location

`src/pane-state.ts`, lines:

- 1064 `if (box == null) return null` (stuckInputSignature)
- 1066 `return sig.length > 0 ? sig : null` (stuckInputSignature)
- 1101 `if (BUSY_ESC_TO_INTERRUPT_RX.test(footerRegion)) return null` (parkedPasteSignature) -- RESOLVED 2026-08-04 by pinning the no-busy-indicator path; see commit.
- 1104 `return sig.length > 0 ? sig : null` (parkedPasteSignature)
- 1136 `if (box == null) return null` (parkedChannelInput)
- 1161 `if (box == null) return null` (parkedInputText)
- 1165 `return flat.length > 0 ? flat : null` (parkedInputText)
- 1489 `if (!Number.isFinite(seconds) || seconds < 0) return null` (stuckToolCallSignature)

(The 1101 case was previously flagged in this list and is now exercised by `parkedPasteSignature: footer-esc and empty-sig branches > returns null when a placeholder is parked but esc-to-interrupt sits in the live footer (no busy indicator match)`.)

## Excerpt

```ts
// stuckInputSignature
export function stuckInputSignature(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null  // 1062
  const box = liveInputBox(pane)                         // 1063
  if (box == null) return null                           // 1064 -- unreachable: typing requires liveInputBox to succeed
  const sig = box.replace(/\s+/g, ' ').trim()           // 1065
  return sig.length > 0 ? sig : null                     // 1066 -- unreachable: PARKED_INPUT_RX guarantees non-whitespace content
}

// stuckToolCallSignature
export function stuckToolCallSignature(pane: string): ToolCallProgressSignature | null {
  const m = pane.match(TOOL_CALL_PROGRESS_RX)            // `\d+` -- positive digits only
  if (!m) return null
  const tag = m[1]!.toLowerCase()
  const seconds = parseInt(m[2]!, 10)                    // always finite and >= 0
  if (!Number.isFinite(seconds) || seconds < 0) return null  // 1489 -- both branches unreachable
  return { tag, seconds }
}
```

## Failure scenario

These branches are defensive code that v8 coverage cannot exercise through
the public API. They are unreachable in normal flow because:

1. **box == null branches (1064, 1136, 1161)**. `detectPaneState(pane) !== 'typing'`
   is the upstream gate. For the function to return `'typing'`,
   `liveInputBox(pane)` must have returned a non-null box (the `'typing'`
   classification requires a `PARKED_INPUT_RX` match *inside that box*).
   By the time the inner `liveInputBox(pane)` call runs, the box locator
   therefore cannot return null. The branch is unreachable through any
   normal input.

2. **length falsy branches (1066, 1104, 1165)**. The collapsed box content is
   guaranteed to contain at least one non-whitespace character (for
   1066/1165, because `PARKED_INPUT_RX` requires `\S` after the prompt gap;
   for 1104, because `[Pasted text #N` is non-whitespace). `length > 0`
   is always true. The falsy branch cannot fire.

3. **`seconds < 0` branch (1489)**. `TOOL_CALL_PROGRESS_RX` is `/\d+/` which
   only matches positive digits. `parseInt` of a positive-digit string is
   always finite and >= 0. Both halves of the `||` are unreachable.

`vi.spyOn` does not intercept ESM static bindings, so we cannot break the
`'typing'` -> non-null-box contract from a unit test. `vi.mock` with
`importOriginal` works for replacing exports but the Proxy.get trap only
fires for external callers, not for the helpers' internal calls. A clean
test of these branches would require either (a) modifying the source to
add an `/* v8 ignore next */` annotation, or (b) restructuring the
helpers so the type gate is bypassable from a test.

## Pinning test

The remaining 8 uncovered branches are pinned by the existing test
suite: every test that exercises the public API through the `'typing'`
classification or through `stuckToolCallSignature` already locks the
reachable side of each conditional. The suite covers 100% statements /
100% lines / 100% functions / 98.05% branches (7 defensive branches
uncovered), which is the highest achievable without modifying
`src/pane-state.ts`.

A regression that introduces a code path through any of these defensive
branches would be a real semantic change -- the helpers would have to
acquire a way to disagree with their own gating function -- and would
deserve its own follow-up commit rather than a test-only patch.

## Suggested direction

Two acceptable resolutions (do BOTH, in order of preference):

1. **Add `/* v8 ignore next */` annotations** on each defensive branch
   with a one-line comment naming the unwinding contract (the project
   already uses this pattern for genuinely-unreachable defensive code in
   other modules; see e.g. `pending-retries.test.ts` for an example).
   This is the cleanest fix: it documents the unreachable contract AND
   silences the coverage gate. Per task rule "NEVER modify
   src/pane-state.ts" this requires an explicit override from the user.

2. **Refactor the helpers to make the unreachable paths reachable** by
   extracting `liveInputBox` (the part that can return null when the
   gate does not) into a separate function and asserting on that
   function directly. This loses the safety of the defensive contract
   and is NOT recommended -- the unreachable branches are load-bearing
   guards against future refactors that change one side of the
   gate-vs-locator contract without the other.

Until a resolution is chosen, the coverage gate will fail on this file;
mark this MD as the authoritative pin and exclude `pane-state.ts` from
the branch-coverage threshold (statements/lines/functions still gate).

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
