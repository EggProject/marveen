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

## Resolution

Edit reverted. The defensive coalesce is left in place. Synthetic test
that pinned the non-string-keys branch (`ignores a non-string keys
(sanitizeLiteralKeys is bypassed -> null literalKeys -> 400)`) stays
in place alongside the source.

## See also

`docs/needs-to-be-fix/agent-terminal-keys-preview-literalKeys-fallback.md`
documents the dead-branch analysis.
