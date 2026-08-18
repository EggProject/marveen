# routes/research.ts:72: TOCTOU + symlink-follow serves arbitrary files from the single-doc branch

## Location

`src/web/routes/research.ts`, line 72 (the single-doc branch of
`tryHandleResearch`, after the `NAME_RE` and agent-allowlist guards):

```ts
const file = join(researchDir(agent), name)
if (!existsSync(file) || !statSync(file).isFile()) {
  json(res, { error: 'Not found' }, 404)
  return true
}
const content = readFileSync(file, 'utf-8')
json(res, { agent, name, title: titleOf(content, name), content })
return true
```

## Excerpt

```ts
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
```

`existsSync` and `statSync` both follow symlinks by default
(`fs.statSync`, not `fs.lstatSync`). `statSync(file).isFile()` therefore
returns `true` for a symlink whose target is a regular file, and
`readFileSync(file, 'utf-8')` then reads through the link.

The same pattern appears on the listing branch (line 32-34), where
`statSync(join(dir, f)).isFile()` follows symlinks during the filter.

## Failure scenario

Bearer-authenticated `GET /api/research/<agent>/leak.md` where the
attacker has planted `agents/<agent>/research/leak.md` as a symlink to
`/etc/passwd` (or any other readable file on the host's filesystem):

- `existsSync(file)` follows the symlink and returns `true`.
- `statSync(file).isFile()` follows the symlink and returns `true`.
- `readFileSync(file, 'utf-8')` follows the symlink and returns the
  target's contents verbatim.
- The response body is the symlink target — `/etc/passwd` in this case.

`NAME_RE = /^[A-Za-z0-9._-]+\.md$/` does not exclude symlinks; it only
excludes characters. A symlink named `leak.md` passes the regex.

Additionally, there is a TOCTOU window between `existsSync` /
`statSync` and `readFileSync`. If the file is deleted, replaced, or
has its read permission revoked between the two syscalls, the
`readFileSync` call throws `ENOENT`, `EISDIR`, or `EACCES`. These
errors escape the route handler, the outer `try/catch` in `web.ts`
(lines 219-221) catches them, logs them, and converts them to a
generic 500 `Szerver hiba` response — instead of the 404 the endpoint
means to emit for "file disappeared between check and read".

## Pinning test

None. `src/__tests__/research-routes.test.ts` covers the 400 and 404
paths via `NAME_RE` and missing-file fixtures, but does not plant a
symlink under the research directory and does not race a deletion
between the existence check and the read.

## Suggested direction

For the single-doc branch:

1. Resolve the path with `fs.realpathSync` and verify the resolved
   path is still under `researchDir(agent)` after resolution. A
   symlink that escapes the research directory fails the prefix
   check and gets a 404.
2. Use `fs.lstatSync` (or `fs.statSync(file, { bigint: false })`
   with an explicit `throwIfNoEntry: true`) instead of `existsSync`,
   and inspect the result to distinguish file / directory /
   symlink / missing. A symlink (lstat `isSymbolicLink() === true`)
   returns 404 without ever opening the file.
3. Drop the redundant `existsSync` + `statSync` pair: one
   `statSync(file, { throwIfNoEntry: false })` followed by a check
   on `err?.code === 'ENOENT'` returns 404 for missing files,
   symlinks, and directories alike, and removes the TOCTOU window
   by reading the resolved file in the same logical step.

For the listing branch, the symmetric fix is to switch to
`readdirSync(dir, { withFileTypes: true })` and inspect the returned
`Dirent` objects (`entry.isFile() && !entry.isSymbolicLink()`) plus a
single `lstatSync` for `mtimeMs` — see
`routes-research-double-stat-inefficiency` for the full listing-side
refactor.
