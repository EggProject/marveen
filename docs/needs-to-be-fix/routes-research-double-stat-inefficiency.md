# routes/research.ts:32,44,72-73: 2N+1 statSync pattern per agent on /api/research

## Location

`src/web/routes/research.ts`, three stat sites inside `tryHandleResearch`:

- line 32-34 (listing-branch filter, `readdirSync` + per-entry
  `statSync`):

  ```ts
  files = readdirSync(dir).filter(
    f => NAME_RE.test(f) && statSync(join(dir, f)).isFile(),
  )
  ```

- line 42-45 (listing-branch mtime read, second `statSync` of the
  same file):

  ```ts
  const file = join(dir, name)
  title = titleOf(readFileSync(file, 'utf-8'), name)
  ms = statSync(file).mtimeMs
  ```

- line 72-73 (single-doc branch, redundant `existsSync` +
  `statSync`):

  ```ts
  const file = join(researchDir(agent), name)
  if (!existsSync(file) || !statSync(file).isFile()) {
  ```

## Excerpt

The listing branch calls `statSync` on every `NAME_RE`-matching entry
once for the `isFile()` check, then again on every accepted entry for
`mtimeMs`. For `N` matching files per agent this is `2N` stat syscalls
plus the single `readdirSync`; across `M` agents it scales as
`2N·M + M`. Every file is opened twice by the kernel.

The single-doc branch adds one more `existsSync` per request and one
`statSync`, so a non-listing `GET /api/research/<agent>/<file>` does
two filesystem syscalls before the `readFileSync`.

The pre-existing asymmetry is that the listing branch was the only
caller of `statSync` until cycle 30 added the single-doc branch's
`existsSync` + `statSync` pair as part of the basename-removal
cleanup. The cycle 30 diff explicitly removes dead filesystem calls
in nearby files, so the surviving duplications are visible.

## Failure scenario

`GET /api/research` on an agent with N=50 `.md` research files
performs 100 `statSync` syscalls (50 for the filter, 50 for mtime)
plus 50 `readFileSync` for the titles. Across M=10 agents with
similar volume this is 1000+ stat syscalls per request — purely to
fill the listing's `updated` field.

For the single-doc branch, the `existsSync` + `statSync` pair is
similarly redundant: `statSync` already returns enough information to
distinguish "missing" from "regular file" from "directory" from
"symlink". The extra `existsSync` doubles the I/O without adding
correctness.

## Pinning test

None — this is an efficiency defect, not a behavioural defect. No
test fails; no 500 / 400 / 404 path is wrong.

## Suggested direction

For the listing branch, switch to `readdirSync(dir, { withFileTypes: true })`
and inspect the returned `Dirent` objects in a single pass:

```ts
const dirents = readdirSync(dir, { withFileTypes: true })
const docs: { name: string; title: string; ms: number }[] = []
for (const entry of dirents) {
  if (!entry.isFile() || entry.isSymbolicLink()) continue
  if (!NAME_RE.test(entry.name)) continue
  const file = join(dir, entry.name)
  try {
    const content = readFileSync(file, 'utf-8')
    const ms = statSync(file).mtimeMs
    docs.push({ name: entry.name, title: titleOf(content, entry.name), ms })
  } catch {
    /* keep filename as title */
  }
}
```

This drops `2N` stats to `N` (one per accepted entry, for mtime only)
and uses the `Dirent`'s `isFile()` / `isSymbolicLink()` to replace the
`statSync(...).isFile()` filter. The combined savings are roughly
halved syscall count on the listing branch.

For the single-doc branch, drop `existsSync` and let
`statSync(file, { throwIfNoEntry: false })` (or `lstatSync`) carry
the load:

```ts
let st: import('node:fs').Stats
try {
  st = statSync(file)
} catch (err) {
  if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
    json(res, { error: 'Not found' }, 404)
    return true
  }
  throw err
}
if (!st.isFile() || st.isSymbolicLink()) {
  json(res, { error: 'Not found' }, 404)
  return true
}
```

This collapses the `existsSync` + `statSync` pair into a single
syscall and removes the TOCTOU window between them. See
`routes-research-symlink-traversal` for the security-side motivation
for the same refactor.
