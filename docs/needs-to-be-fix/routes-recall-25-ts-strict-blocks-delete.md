# routes/recall.ts:25 - TS strict blocks the safe-delete

## Reason

Attempted to drop `?? 0` from `return map[weekday] ?? 0` in
`dayOfWeekBudapest`. After removal, `map[weekday]` returns
`number | undefined` (Record index access), and the function's declared
return type `number` trips TS2769 ("Type 'number | undefined' is not
assignable to type 'number'").

## Resolution

Edit reverted. `?? 0` fallback restored. Even though
`Intl.DateTimeFormat('en-US', { weekday: 'short' })` is documented to
return one of the seven keys, TS strict-generics cannot prove this and
the function's public return type is `number`.

## See also

The same pattern blocks the deletion at `routes/recall.ts:153` -
`weekMap[weekMatch[1]] ?? 0` - so do not attempt that edit either
until the return type is widened or a type guard is introduced.
