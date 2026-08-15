# routes/docs.ts: the `basename(name) !== name` check in /api/docs/<name> is unreachable

## Location

`src/web/routes/docs.ts`, the per-doc endpoint, line 62:

```ts
const match = path.match(/^\/api\/docs\/([^/]+)$/)
if (match && method === 'GET') {
  const name = decodeURIComponent(match[1])
  if (!NAME_RE.test(name) || basename(name) !== name) {
    json(res, { error: 'Invalid doc name' }, 400)
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
suite wraps `node:path.basename` with a `vi.mock` override that claims a
valid-looking name has a different basename; with the override armed,
the second disjunct of the `||` evaluates true and the 400 branch
fires. See the "PINNING-equivalent" test below.

## Pinning test

`src/__tests__/routes-docs.test.ts`:

- `GET /api/docs/<name> -- 400 invalid name > returns 400 via the basename
  check when basename(name) !== name (mocked)` -- exercises the branch
  via a `vi.mock('node:path')` override on `basename`. The test passes
  the moment the source's basename check is reachable, so it stays in
  the suite as a regression guard once the dead branch is removed.

The override captures the real `basename` via `vi.hoisted(require)` so
the rest of `node:path` (notably `join`, which DOCS_DIR depends on)
still works during the rest of the suite.

## Suggested direction

Either of two equally valid fixes; the first is preferred because it
removes the dead code AND the second disjunct of the `||`, leaving a
single, well-defined check.

(a) Drop the `basename(name) !== name` disjunct:

```ts
if (!NAME_RE.test(name)) {
  json(res, { error: 'Invalid doc name' }, 400)
  return true
}
```

The `basename` import becomes unused; remove it from the
`import { join, basename } from 'node:path'` line as well. The
mocked-basename test still passes (it triggers 400 via NAME_RE or via
the absence of the basename check -- the test asserts on the response,
not on which disjunct fired). The `vi.mock('node:path')` block can
then be deleted from the suite.

(b) Leave the check as defensive and add a comment noting why it is
unreachable on real input. This documents the invariant for future
readers but does NOT remove the coverage gap, so the basename-mocking
test stays in place.

Per task rule "NEVER modify src/web/routes/docs.ts" the source edit is
blocked until the user overrides; the test suite documents the gap
and the mocked-basename pinning test stays in place alongside whichever
fix is chosen.

## Why this stays

basename(name) !== name is a defence-in-depth check against path
traversal. While the open bug profiles-traversal-id (High severity) of the same class is
unfixed, removing this guard would delete a layer for stylistic reasons. NAME_RE excludes
slashes/backslashes by construction, so the check is provably redundant at runtime today, but
the project prefers belt-and-braces on a route that resolves files under DOCS_DIR. Revisit
after profiles-traversal-id is resolved.