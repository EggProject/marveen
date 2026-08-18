# routes/research.ts: the `basename(name) !== name` check in /api/research/<agent>/<name> is unreachable

## Sibling

Same pattern as `routes-docs-basename-redundant` (resolved 2026-08-18 e4ec60b in commit e4ec60b). The check is provably redundant because `NAME_RE = /^[A-Za-z0-9._-]+\.md$/` excludes the path-separator characters `/` and `\` that `basename()` would split on.

## Location

`src/web/routes/research.ts`, line 2 (import) and line 63 (the disjunct):

```ts
import { join, basename } from 'node:path'
```

```ts
const match = path.match(/^\/api\/research\/([^/]+)\/([^/]+)$/)
if (match && method === 'GET') {
  const agent = decodeURIComponent(match[1])
  const name = decodeURIComponent(match[2])
  if (!NAME_RE.test(name) || basename(name) !== name) {
    json(res, { error: 'Invalid file name' }, 400)
    return true
  }
  ...
}
```

with the module-scope `NAME_RE`:

```ts
const NAME_RE = /^[A-Za-z0-9._-]+\.md$/
```

## Excerpt

`NAME_RE` is a character-class allowlist: it only accepts letters,
digits, `.`, `_`, `-`, and `.md` at the end. `node:path.basename` on
POSIX uses `/` as its only path separator; on Windows it accepts both
`/` and `\`. Neither separator character is in NAME_RE's class, so any
string that passes `NAME_RE.test(name)` cannot contain a path separator
and therefore `basename(name)` must equal `name`. The `basename(name)
!== name` disjunct can never fire on real input.

## Failure scenario

The defect is a coverage-only defect. No runtime misbehaviour is
reachable through public input: every request the endpoint can
legitimately receive either fails `NAME_RE.test` (covered by the
existing 400 tests) or has `basename(name) === name` by construction.
The check is dead code.

To reach 100% branch coverage without modifying the source, the test
suite would need to wrap `node:path.basename` with a `vi.mock` override
that claims a valid-looking name has a different basename; with the
override armed, the second disjunct of the `||` evaluates true and the
400 branch fires. The current `research-routes.test.ts` suite does NOT
mount such an override -- every 400 path is exercised through NAME_RE's
character class, so the basename disjunct is the only uncovered branch
in the file.

## Pinning test

None. `src/__tests__/research-routes.test.ts` does not import
`node:path` mocks and does not override `basename`; the 400 tests
(`rejects encoded path traversal in the file name`, `rejects traversal
aimed at dotfiles outside research/`, `rejects non-.md file names`)
all trigger the 400 branch via `NAME_RE.test(name) === false`. The
basename disjunct is uncovered but no test pins it.

## Suggested direction

Either of two equally valid fixes; the first is preferred because it
removes the dead code AND the second disjunct of the `||`, leaving a
single, well-defined check.

(a) Drop the `basename(name) !== name` disjunct:

```ts
if (!NAME_RE.test(name)) {
  json(res, { error: 'Invalid file name' }, 400)
  return true
}
```

The `basename` import becomes unused; remove it from the
`import { join, basename } from 'node:path'` line as well. No test
scaffolding needs to be deleted because none of the existing tests
mount a `vi.mock('node:path')` override.

(b) Leave the check as defensive and add a comment noting why it is
unreachable on real input. This documents the invariant for future
readers but does NOT remove the coverage gap, so the basename-mocking
test stays in place (we don't have one today, so this is the no-op).

## Why this stays

basename(name) !== name is a defence-in-depth check against path
traversal. While the open bug `profiles-traversal-id` (High severity) of
the same class is unfixed, removing this guard would delete a layer
for stylistic reasons. NAME_RE excludes slashes/backslashes by
construction, so the check is provably redundant at runtime today, but
the project prefers belt-and-braces on a route that resolves files
under the agent's research directory. Revisit after `profiles-traversal-id`
is resolved.
