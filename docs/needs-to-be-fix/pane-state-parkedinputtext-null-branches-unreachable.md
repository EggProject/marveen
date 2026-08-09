# pane-state.ts: `parkedInputText` null-coalesce branches are unreachable

## Location

`src/pane-state.ts`, lines 1161-1165:

```ts
export function parkedInputText(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null                       // line 1161
  const flat = box.replace(/\s+/g, ' ').trim().replace(/^❯\s*/, '').trim()
  return flat.length > 0 ? flat : null              // line 1165
}
```

Both fallback `return null` arms are dead.

## Excerpt

```ts
// src/pane-state.ts:1158-1166
export function parkedInputText(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane)
  if (box == null) return null
  // Collapse terminal wrap, then strip the leading ❯ prompt marker so the
  // re-injected text is the message itself, not the prompt glyph.
  const flat = box.replace(/\s+/g, ' ').trim().replace(/^❯\s*/, '').trim()
  return flat.length > 0 ? flat : null
}
```

## Failure scenario

Coverage-only. No runtime misbehaviour is reachable through public input.

The 'typing' return path inside `detectPaneState` is the ONLY path that
reaches line 1161. Looking at the source:

```ts
// src/pane-state.ts:609-643
if (!IDLE_FOOTER_RX.test(pane)) {
  // Footer-less fresh-session / welcome-screen: ...
  const box = liveInputBox(pane)
  if (box != null && box.split('\n').some(l => PARKED_INPUT_RX.test(l))) {
    return opts.mergeTypingAsBusy ? 'busy' : 'typing'   // path A: liveInputBox != null
  }
  return 'unknown'
}
...
// path B (line 640-643):
if (topSep >= 0 && bottomSep > topSep) {
  const inputLines = lines.slice(topSep + 1, bottomSep)
  if (inputLines.some(l => PARKED_INPUT_RX.test(l))) {
    return opts.mergeTypingAsBusy ? 'busy' : 'typing'
  }
}
```

Path A explicitly requires `liveInputBox(pane) != null` AND a
PARKED_INPUT_RX match. Path B requires `topSep >= 0 && bottomSep > topSep`
AND a PARKED_INPUT_RX match — exactly the conditions under which
`liveInputBox(pane)` (which uses the same separator-pair algorithm)
returns non-null.

Therefore, by the time `parkedInputText` reaches line 1161 with
`detectPaneState(pane) === 'typing'`, `liveInputBox(pane)` is
guaranteed non-null, and the `if (box == null) return null` arm is
unreachable.

For line 1165, `flat.length > 0` is unconditionally true: PARKED_INPUT_RX
is `/❯[^\S\r\n]+\S/`, requiring at least one non-whitespace char after
the prompt glyph. After `replace(/\s+/g, ' ').trim().replace(/^❯\s*/, '').trim()`
the resulting `flat` string still contains that non-whitespace content,
so its length is >= 1.

v8 coverage:
- line 1161 if: `counts=[0, 25]` (falsy arm hit 25 times, truthy 0)
- line 1165 cond-expr: `counts=[25, 0]` (truthy arm hit 25 times, falsy 0)

## Pinning test

`src/__tests__/pane-state.test.ts` — `describe('parkedInputText')` at
line 1649 exercises every reachable branch. The line 1161 / 1165
unreachable arms have no reachable input and are documented here
without test-side assertions.

## Suggested direction

Drop the `if (box == null)` guard and the `flat.length > 0` ternary:

```ts
export function parkedInputText(pane: string): string | null {
  if (detectPaneState(pane) !== 'typing') return null
  const box = liveInputBox(pane) as string  // narrowed by the typing gate
  const flat = box.replace(/\s+/g, ' ').trim().replace(/^❯\s*/, '').trim()
  return flat
}
```

The non-null assertion on `box` is sound because the 'typing' return
path of `detectPaneState` requires `liveInputBox(pane) != null` (or
equivalently, `topSep >= 0 && bottomSep > topSep` in the footer-anchored
scan, which is exactly the precondition for `liveInputBox` to return
non-null). The `flat.length > 0` is similarly guaranteed by
PARKED_INPUT_RX requiring a non-whitespace char after `❯`.

Per task rule "NEVER modify src/pane-state.ts" the source edits are
blocked until the user overrides; the test suite documents the gap and
pins every reachable sibling branch.
