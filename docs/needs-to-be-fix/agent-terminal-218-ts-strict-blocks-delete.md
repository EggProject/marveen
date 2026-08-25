# agent-terminal.ts:218 - TS strict blocks the safe-delete

## Reason

Attempted to drop `(literalKeys ?? '')` (used twice) inside the preview
construction. After the removal, `literalKeys.slice(...)` and
`literalKeys.length` trip TS18047 because `literalKeys` is typed
`string | null` and the strict TS settings reject non-null access on a
possibly-null value.

The upstream `if (!args)` early-return only guarantees `args` is
non-null, not `literalKeys` -- `literalKeys` could still be null when
`special` is truthy (the `parsed.special ? ... : ...` ternary uses
`literalKeys` only on the literal branch, so TypeScript cannot narrow
it across the ternary).

## See also

`docs/needs-to-be-fix/agent-terminal-keys-preview-literalKeys-fallback.md`
documents the dead-branch analysis.

## Resolved

Resolved: 2026-08-20 c8ce4a4 -- agent-terminal.ts:218 `?? ''` replaced
with nested-ternary narrowing (`literalKeys ? ... : ''`) so TS narrows
`literalKeys` to `string` and the `?? ''` arms become unreachable in
the type system too. Branch count: 2 dead `??` arms -> 1 dead ternary
arm (net -1 dead branch). The fix landed.
