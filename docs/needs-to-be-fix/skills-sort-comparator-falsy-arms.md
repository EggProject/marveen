# skills.ts:157 -- `label || name` nullish fallback is unreachable

## Location

`src/web/routes/skills.ts`, lines 155-158 (the skill sort comparator):

```ts
skills.sort((a, b) => {
  if (a.source !== b.source) return a.source === 'user' ? -1 : 1
  return (a.label || a.name).localeCompare(b.label || b.name)
})
```

## Excerpt

The `a.label || a.name` and `b.label || b.name` expressions at line 157
have a `||` fallback to `name` when `label` is falsy. Both `label` and
`name` are populated from non-empty directory names by the code that
pushes skills into the array:

- User skills (line 87-96): `name: dir, label: dir` where `dir` comes
  from `readdirSync(USER_SKILLS_DIR).filter(...)` -- `dir` is a
  directory name from the filesystem, never empty (after filter+statSync).
- Plugin skills (line 129-139): `name: ...${sd}, label: ...${sd}` where
  `sd` comes from `readdirSync(skillsDir)` -- same constraint, never
  empty after the `.startsWith('.')` skip and `statSync().isDirectory()`
  check.

So `label` is always a non-empty string when the comparator runs. The
`|| name` fallback cannot fire.

## Failure scenario

v8 reports both branches at line 157 as `binary-expr counts=[N, 0]` --
the truthy arm (`label` defined, short-circuit returns `label`) hit N
times, the falsy arm (`label` falsy, falls through to `name`) hit 0
times. The 100% branch coverage gate fails on
`src/web/routes/skills.ts` because of these two dead branches.

Options:

1. Drop the `|| a.name` and `|| b.name` fallbacks. The `name` field is
   always a non-empty string, so `label` (also non-empty) is the only
   meaningful comparator input.
2. Leave the fallbacks (current state) as insurance against a future
   code path that pushes a skill with an empty label -- but every
   existing push site derives `label` from a non-empty filesystem
   entry, so no such code path can exist without restructuring the
   `push()` calls.

Option (1) is the cleanest fix.

The same applies to the `a.source === 'user' ? -1 : 1` falsy arm at
line 156: V8's TimSort always invokes the comparator with `a=user`
when comparing cross-source pairs (never `a=plugin, b=user`), so the
`return 1` arm has `counts=[0, N]` and cannot be exercised through the
public API.

## Pinning test

None. The falsy arms cannot be reached through any public surface of
`/api/skills`. V8's TimSort is implementation-defined (Node.js 18+),
and on every observed version it calls the comparator with the smaller
source group on the left side.

The existing `skills-routes.test.ts` "sorts user skills before plugin
skills, then by label" + the new "exercises the sort comparator
a.source === 'user' branch" test cover the truthy arms at 100%. The
falsy arms are documented dead.

A pinning test that exercises the falsy arm would need to:

- Replace the comparator via `vi.spyOn(skillsMod, 'sort')` -- but the
  comparator is local to the route handler, not exposed.
- Mutate V8's TimSort internals (impossible from JavaScript).

Neither is viable.

## Suggested direction

Drop the `||` fallbacks:

```ts
skills.sort((a, b) => {
  if (a.source !== b.source) return a.source === 'user' ? -1 : 1
  return a.label.localeCompare(b.label)
})
```

The `a.source === 'user' ? -1 : 1` ternary becomes effectively
one-sided by V8's sort algorithm, but the source change is to drop the
`||` only; the `=== 'user'` ternary is left intact because removing it
changes the comparator's behavior (returns `undefined` instead of `1`,
which V8 treats differently).

Per task rule "NEVER modify src/web/routes/skills.ts" this requires
an explicit override from the user.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
