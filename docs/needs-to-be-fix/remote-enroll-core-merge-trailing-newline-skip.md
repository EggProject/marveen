# `mergeAuthorizedKeys` has a single-input trailing newline guard that is only reachable when the input has multiple trailing newlines

## Location
`src/remote-enroll-core.ts`, `mergeAuthorizedKeys()` at lines 193-206.

## Excerpt
```ts
const lines = existing.length ? existing.split('\n') : []
// A file that ends in a newline yields a trailing '' element; drop it so it
// does not become a spurious blank line, then re-add exactly one newline.
if (lines.length > 0 && lines[lines.length - 1] === '') {
  lines.pop()
}
// ... map with line replacement ...
let content = out.join('\n')
if (!content.endsWith('\n')) content += '\n'
return { content, action: replaced ? 'replaced' : 'added' }
```

## Failure scenario
The trailing-newline guard (`if (!content.endsWith('\n')) content += '\n'`) is mostly unreachable: `out.join('\n')` ends with a newline ONLY when the last entry of `out` is the empty string.

The pop guard on line 193 removes ONE trailing empty. So an input with TWO trailing newlines (e.g. `'a\n\n'`) leaves the trailing empty after the pop, and the join produces a trailing newline -- the append is skipped. The branch is reachable in that narrow case.

The bug is that the defensive `if (!content.endsWith('\n'))` branch is misleading: it suggests the function is defensive about double newlines, but in practice the only entry that survives the pop is what the function does already. If the pop ever stopped removing the trailing empty (e.g. an `else` branch guarding an empty input), the function would silently double-newline its output.

## Pinning test
`src/__tests__/remote-enroll-core-full.test.ts`, test `skips the trailing-newline append when a leftover empty entry already provides one`. The test pins the multi-trailing-newline case and asserts the result is exactly one trailing newline (not two).

## Suggested direction
Either:
- Simplify the function to `let content = out.join('\n') + '\n'` (the trailing-empty pop already guarantees `out` is non-empty when the input was non-empty, and an empty input would have given an empty `lines` array, so push behaves the same).
- OR keep the guard but write a guard that ALSO drops the trailing empty inside the join (e.g. `out.filter(line => line !== '').join('\n') + '\n'`).

The first option is cleaner; the second option preserves the `replaced` vs `added` distinction for the case where the only line in the file is the matching comment.
