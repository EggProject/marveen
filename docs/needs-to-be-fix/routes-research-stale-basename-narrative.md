# routes/research.ts + research-routes.test.ts: stale basename-checked comments after basename removal

## Location

`src/web/routes/research.ts`, lines 8-11 (module preamble comment):

```ts
// Read-only viewer for each agent's research/ folder (agents/<name>/research/,
// or the project root for the main agent). Mirrors routes/docs.ts: everything
// sits under /api/* (bearer-token gated), nothing is writable, and filenames
// are allowlisted + basename-checked to block path traversal.
```

`src/__tests__/research-routes.test.ts`, lines 8-12 (test-suite preamble):

```ts
// Everything is gated through the bearer-token middleware upstream
// (auth-gate.ts), so this module only reads the filesystem. Nothing is
// writable; filenames are allowlisted and basename-checked against path
// traversal.
```

## Excerpt

The two comment blocks both advertise that `tryHandleResearch`
"basename-checks" filenames to block path traversal. After the
cycle 30 diff (commit `e62eb87` on `test/baseline`), the basename
import and the `basename(name) !== name` disjunct were removed from
`src/web/routes/research.ts` — the only line-numbered check left is
`NAME_RE.test(name)` at line 63, whose character class
`[A-Za-z0-9._-]+` excludes the path-separator characters that
`basename()` would split on. There is no `basename` import anywhere
in the file.

The current `research.ts` defence model is:

- `NAME_RE = /^[A-Za-z0-9._-]+\.md$/` rejects any string with a `/`,
  `\`, or other out-of-class character (including `%`, `?`, `#`, etc.).
- The agent segment is allowlisted against `[MAIN_AGENT_ID, ...listAgentNames()]`,
  so the `researchDir()` root is fixed before any filesystem call.
- `readFileSync` is called only on `join(researchDir(agent), name)`
  with `agent` allowlisted and `name` regex-validated.

There is no `basename` runtime check.

## Failure scenario

A reviewer or future maintainer reads the module preamble, sees
"allowlisted + basename-checked", and:

- Hunts the codebase for a `basename(name) !== name` guard,
  finds nothing in `research.ts`, and either (a) re-adds the guard
  as a duplicate of `NAME_RE`'s protection, or (b) trusts the
  comment over the code and argues downstream that the protection
  is still in place.

Both outcomes waste review cycles and risk a duplicate defensive
guard being merged into the next cycle's diff, mirroring the
`routes-docs-basename-redundant` cycle 30 cleanup that the current
diff was meant to repeat.

The test-file preamble repeats the same claim about
`tryHandleResearch` — same drift, same downstream confusion risk for
test readers.

## Pinning test

None — this is a comment drift, not a behavioural defect. No test
fails; no 500 / 400 / 404 path is wrong.

## Suggested direction

Rewrite both comment blocks to reflect the current defence model.

For `research.ts:8-11`:

```ts
// Read-only viewer for each agent's research/ folder (agents/<name>/research/,
// or the project root for the main agent). Mirrors routes/docs.ts: everything
// sits under /api/* (bearer-token gated), nothing is writable. Filenames
// pass NAME_RE (a character-class allowlist that excludes path separators)
// and readFileSync is called only on join(researchDir(agent), name) with
// the agent segment allowlisted upstream.
```

For `research-routes.test.ts:8-12`:

```ts
// Everything is gated through the bearer-token middleware upstream
// (auth-gate.ts), so this module only reads the filesystem. Nothing is
// writable; filenames pass NAME_RE (a character-class allowlist that
// excludes path separators) and the agent segment is allowlisted
// against [MAIN_AGENT_ID, ...listAgentNames()] before any filesystem call.
```

Both edits are doc-only and ship with no runtime change.

## Resolution

Basename was removed in `e62eb87` (cycle 30 fix); the actual defense is `NAME_RE`'s character class allowlist `[A-Za-z0-9._-]+`, which excludes path separators. The module and test preamble comments still described the now-deleted basename check until this cycle 31 doc-only diff replaced both blocks with the `NAME_RE`-based narrative.
