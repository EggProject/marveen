# routes/docs.ts: inner per-file catch does not reset `title` despite the comment

## Location

`src/web/routes/docs.ts`, the per-file `.map` body, lines 33-50:

```ts
files
  .map(name => {
    let title = name
    let created: string | null = null
    let ms = 0
    try {
      const file = join(DOCS_DIR, name)
      title = titleOf(readFileSync(file, 'utf-8'), name)
      const s = statSync(file)
      ms = s.birthtimeMs && s.birthtimeMs > 0 ? s.birthtimeMs : s.mtimeMs
      created = new Date(ms).toISOString().slice(0, 10)
    } catch {
      /* keep filename as title, created stays null */
    }
    return { name, title, created, ms }
  })
```

## Excerpt

The catch comment claims "keep filename as title", but the catch block is
empty. The `title` variable was already overwritten by `titleOf(...)` on
the line BEFORE the throw site (`statSync(file)`), so when the catch
fires:

- if `readFileSync` threw first: `title` keeps its initial value (`name`),
  which happens to match the comment's intent by accident;
- if `readFileSync` succeeded and `statSync` threw (or `new Date(...)`
  threw): `title` is the value returned by `titleOf`, which may be the
  extracted `# heading` text or the filename (whichever `titleOf`
  produced). The catch comment is wrong: the title is NOT reset.

`created` does stay `null` in the catch branch (the assignment is on the
same line as the throw site), so the second half of the comment is
correct.

## Failure scenario

1. A `.md` file in `docs/` has a `# Real Title` heading.
2. The OS or filesystem rejects `statSync` for the file (permission
   denied on a chmod-000 file, transient EIO on a network mount,
   sandbox / AppArmor profile blocking stat, etc.).
3. `readFileSync` succeeds and `titleOf` returns `'Real Title'`, overwriting
   the initial `title = name` value.
4. `statSync` throws. The catch fires but does nothing.
5. The endpoint returns the doc with `title: 'Real Title'` instead of
   `title: <filename>.md`, contradicting the comment AND the behaviour
   operators would expect when they hand-fix a half-broken doc.

The user-visible impact is small (the row still appears in the list),
but the response shape is internally inconsistent: a doc whose stat
fails is reported with a *different* title than a doc whose read
fails, even though the comment promises the same fallback. Operators
debugging "why is the title wrong?" have to read the catch to find
out the comment lies.

## Pinning test

`src/__tests__/routes-docs.test.ts`:

- `GET /api/docs > falls back to filename + null created when statSync
  throws for the file (inner catch)` -- pins the actual behaviour (title
  is whatever titleOf returned before the throw).
- `GET /api/docs > PINNING: inner catch should reset title to filename
  when statSync throws after readFileSync (broken)` -- asserts the
  documented behaviour (`title = name`) and is annotated `.fails`, so the
  suite stays green while the bug is present. The test will start
  failing the moment the bug is fixed, which is the signal to delete
  this MD alongside the pinning test.

Both tests arm a `vi.mock('node:fs')` override for `statSync` so the
first call (inside `readdirSync().filter(...)`) succeeds and the second
call (inside the `.map`) throws -- driving the inner per-file catch
without tripping the OUTER catch.

## Suggested direction

Pick one of two equally valid fixes; the first is preferred because it
makes the documented behaviour match the code and lets the `it.fails`
pinning test be removed in lockstep with the fix.

(a) Make the catch actually reset the title:

```ts
} catch {
  title = name
}
```

This makes the comment truthful. The `created = null` half of the
comment is already correct (the assignment never runs on the throw
path) and needs no change.

(b) Drop the misleading half of the comment:

```ts
} catch {
  /* created stays null */
}
```

Documents the actual behaviour without changing it. The pinning test
must then be deleted (or re-targeted at a different bug) since the
"keep filename as title" guarantee no longer exists.

Per task rule "NEVER modify src/web/routes/docs.ts" the source edit is
blocked until the user overrides; the test suite documents the gap
and the `it.fails` pinning test stays in place alongside whichever fix
is chosen.
## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
