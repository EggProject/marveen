# routes/recall.ts:153 - TS strict blocks the safe-delete

## Reason

Attempted to drop `?? 0` from `const weekIdx = weekMap[weekMatch[1]] ?? 0`
in the HU_MONTHS week-of-month loop. After removal, `weekMap[weekMatch[1]]`
returns `number | undefined`, which propagates through `weekIdx * 7` and
breaks the arithmetic assignment to `from` (TS errors compound by 12).

## Resolution

Edit reverted. `?? 0` fallback restored. Although `utolso` early-returns
at line 148-152 and only `elso|masodik|harmadik|negyedik` reach line 153,
TS cannot prove this from Record index access; a type guard or explicit
cast would be required to satisfy strict mode.

## See also

`docs/needs-to-be-fix/routes-recall-25-ts-strict-blocks-delete.md` for
the identical pattern that blocks `dayOfWeekBudapest`.
