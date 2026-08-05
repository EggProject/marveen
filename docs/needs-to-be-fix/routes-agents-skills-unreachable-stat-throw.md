# agents-skills.ts: unreachable `catch { return false }` on the extracted-skills filter

## Location

`src/web/routes/agents-skills.ts`, line 130, inside `tryHandleAgentsSkills`.

```ts
const extracted = after.filter(f => {
  const p = join(skillsDir, f)
  try { return statSync(p).isDirectory() && existsSync(join(p, 'SKILL.md')) } catch { return false }
})
```

## Excerpt

The outer per-entry `tainted` scan (lines 111-119) walks the same
`after` list just before the `extracted` filter runs:

```ts
const tainted: string[] = []
for (const f of after) {
  const p = join(skillsDir, f)
  try {
    if (lstatSync(p).isSymbolicLink() || (statSync(p).isDirectory() && rejectSymlinks(p))) {
      tainted.push(f)
    }
  } catch { /* ignored */ }
}
```

Two facts make the inner `catch { return false }` unreachable on the
filter pass:

1. `lstatSync(p).isSymbolicLink()` returns `true` for any broken symlink
   (lstat does not follow links and never throws on a symlink target
   mismatch). A dangling symlink -- the only kind of entry that would
   throw `statSync(p)` (which follows links) -- gets tainted on line
   115 before the filter reaches it.
2. For a regular file or directory that survived the tainted scan,
   `statSync(p)` cannot throw on a sandbox-host filesystem: the file
   existed at readdir time (line 101), its lstat just succeeded at
   line 115, and nothing the handler does between those two reads
   deletes the entry. The only window for a TOCTOU throw is a
   third-party deletion between the two reads, which is not a
   code-level reach.

So the filter's inner try block always either returns a boolean (never
throws) or, for entries that were just tainted and rejected (line 124),
the request terminates before this filter runs at all.

## Fix

Either drop the inner `try/catch` (the `lstatSync` guard above already
classifies broken symlinks) or hoist the `after.filter(...)` so it
operates on the same entries the `tainted` loop just inspected. Either
choice removes the unreachable `catch` arm without changing observable
behaviour.

Until the fix lands, the suite in
`src/__tests__/agents-skills.test.ts` covers everything around the
defensive catch and pins this branch as documented dead code.
