# skills.ts:409 -- `if (seg)` truthy guard is unreachable

## Location

`src/web/routes/skills.ts`, lines 397-412 (`/api/skills/import` top-level
dir extraction):

```ts
const listOutput = execSync(`unzip -Z1 "${tmpPath}" 2>&1`, { timeout: 5000, encoding: 'utf-8' })
const entries = listOutput.split('\n').map(l => l.trim()).filter(Boolean)
for (const entry of entries) {
  if (entry.includes('..') || entry.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(entry)) {
    unlinkSync(tmpPath)
    json(res, { error: 'Invalid skill file: path traversal detected' }, 400)
    return true
  }
}
const topLevel = new Set<string>()
for (const entry of entries) {
  const seg = entry.split('/')[0]
  if (seg) topLevel.add(seg)
}
```

## Excerpt

The `if (seg)` truthy guard at line 409 is **structurally unreachable**.
`seg` is `entry.split('/')[0]` where `entry` comes from
`entries = listOutput.split('\n').map(l => l.trim()).filter(Boolean)` --
the `filter(Boolean)` removes every empty string. So `entry` is at
least one character, and `entry.split('/')[0]` is at least one
character.

Furthermore, the `entry.startsWith('/')` path-traversal check at line
401 runs BEFORE this loop, so an entry starting with `/` would already
have triggered the 400 response. By the time we reach line 409,
`entry[0]` is guaranteed to be a non-slash character.

Therefore `seg` is always a non-empty string and the truthy guard
cannot reject anything.

## Failure scenario

v8 reports `branch 69 line=409 type=if counts=[0, 0]` -- both arms hit
0 times in the existing `skills-routes.test.ts` suite (the 16 import
tests cover path traversal, missing file, zip failures, symlink
rejection, etc., all of which exercise the path-traversal guard above
but never reach line 409 with a falsy seg).

Options:

1. Drop the `if (seg)` guard. `seg` is guaranteed non-empty by the
   upstream `filter(Boolean)` + `startsWith('/')` rejection.
2. Leave the guard (current state) as belt-and-braces against a future
   change that allows empty entries.

Option (1) is the cleanest fix.

## Pinning test

None. The falsy arm of `if (seg)` can only be reached if an `entry`
makes it past the `filter(Boolean)` AND past the `startsWith('/')`
check AND has an empty `split('/')[0]`. The third condition is
impossible because `entry` is non-empty.

## Suggested direction

Drop the truthy guard:

```ts
for (const entry of entries) {
  const seg = entry.split('/')[0]
  topLevel.add(seg)
}
```

Per task rule "NEVER modify src/web/routes/skills.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
