# `mergeAuthorizedKeys` trailing-newline guard

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

## Resolution

The original MD description was factually wrong. The guard
`if (!content.endsWith('\n')) content += '\n'` at line 206 is **reachable with
any input that does not end with a trailing newline** -- which is the common
case. After the pop on line 193 removes the trailing empty element, the
`out.push(restrictedLine)` on line 204 appends `restrictedLine` as the last
element of `out`. Unless `restrictedLine` itself ends with `\n`, the join
produces a `content` that does not end with a newline, and the guard
executes.

Concrete trace for `existing = 'a\nb\n'`, `restrictedLine = 'marveen-remote:xyz'`:
- `lines = ['a', 'b', '']`
- pop -> `lines = ['a', 'b']`
- map (no match) -> `out = ['a', 'b']`
- push -> `out = ['a', 'b', 'marveen-remote:xyz']`
- `content = 'a\nb\nmarveen-remote:xyz'` (no trailing newline)
- guard executes, appends `\n` -> `content = 'a\nb\nmarveen-remote:xyz\n'`

The guard is also reachable for empty input (`existing = ''`), input with no
trailing newline (`existing = 'a'`), and input with multiple trailing
newlines (`existing = 'a\n\n'`) -- in the last case the leftover empty entry
after the pop is no longer the last element of `out` once `restrictedLine` is
pushed, so the join still does not end with `\n` and the guard executes.

The only path that skips the guard is a `restrictedLine` that itself ends with
`\n` joined with a trailing empty in `out`, which is not a real input shape.

**No code change required.** The guard is doing exactly what its comment
claims: ensuring the output ends with exactly one newline. The original MD
incorrectly characterized the guard as unreachable; the pinning test
`src/__tests__/remote-enroll-core-full.test.ts` (`skips the trailing-newline
append when a leftover empty entry already provides one`) still pins the
multi-trailing-newline case correctly.

## Pinning test
`src/__tests__/remote-enroll-core-full.test.ts`, test `skips the trailing-newline append when a leftover empty entry already provides one`. The test pins the multi-trailing-newline case and asserts the result is exactly one trailing newline (not two).

## Note
This MD is documented only. `src/remote-enroll-core.ts` is unchanged.
