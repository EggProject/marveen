# profiles placeholder substitution expands `$` replacement patterns

## Location

`src/web/profiles.ts:51-56` — `resolveProfilePlaceholders(value, ctx)`

## Excerpt

```ts
export function resolveProfilePlaceholders(value: string, ctx: { HOME: string; AGENT_DIR: string }): string {
  return value
    .replace(/\$\{HOME\}/g, ctx.HOME)
    .replace(/\$\{AGENT_DIR\}/g, ctx.AGENT_DIR)
    .replace(/\$\{WORKDIR\}/g, ctx.AGENT_DIR)
}
```

When `String.prototype.replace` is given a **string** replacement (not a
function), `$` in that string is a metacharacter. `$&` inserts the matched
substring, `` $` `` inserts everything before the match, `$'` inserts
everything after it, and `$1`..`$9` insert capture groups. The `ctx`
values are interpolated raw, so any of those sequences occurring in a
filesystem path is interpreted as a directive instead of literal text.

## Failure scenario

Input: `value = '${HOME}/x'`, `ctx.HOME = '/home/a$&b'`

1. `/\$\{HOME\}/g` matches `${HOME}`.
2. The replacement string `/home/a$&b` is scanned for patterns; `$&`
   expands to the matched text, i.e. the literal `${HOME}`.
3. Result: `'/home/a${HOME}b/x'`

Expected: `'/home/a$&b/x'`. Actual: `'/home/a${HOME}b/x'` — and the output
now contains an *unresolved* `${HOME}` placeholder that no later pass will
substitute.

Second case, input `value = '${AGENT_DIR}/x'`, ``ctx.AGENT_DIR = '/a$`z'``:

- `` $` `` expands to the text preceding the match, which is empty here.
- Result: `'/az/x'` — the `` $` `` **and** the following character are
  silently swallowed.

Expected: ``'/a$`z/x'``. Actual: `'/az/x'`.

Both verified empirically against Node's `String.prototype.replace`.

Impact is bounded by where `ctx` comes from. The two call sites both feed
it machine-derived paths:

- `src/web/agent-scaffold.ts:341` — `{ HOME: homedir(), AGENT_DIR: agentRoot }`
- `src/web/routes/agents.ts:1219` — `{ HOME: homedir(), AGENT_DIR: agentDir(name) }`

`agentDir(name)` is built from a `sanitizeAgentName`-filtered name, and
`homedir()` on a normal install contains no `$`. So this is **not**
currently a practical injection vector — it is a latent correctness bug
that fires on a home directory or agent root containing `$&`, `` $` ``,
`$'`, or `$1`-`$9`. Such paths are legal on both macOS and Linux.

The consequence when it does fire is not cosmetic: the corrupted string is
written into an agent's `.claude/settings.json` permissions
`allow`/`deny` list (`agent-scaffold.ts:349-352`). A deny rule such as
`Read(${HOME}/.ssh/**)` that expands to a wrong path no longer matches the
directory it was written to protect — the rule silently stops denying.

## Pinning test

`src/__tests__/profiles.test.ts` → `describe('resolveProfilePlaceholders')`:

- `'PINS BUG: `$&` in a context value re-inserts the matched placeholder'`
- `'PINS BUG: a backtick pattern in a context value drops characters'`

Both assert the **actual** (buggy) output so the suite stays green. Update
them to the expected literal values when the fix lands.

## Suggested direction

Use a replacer **function** — function replacements receive the match and
return the string verbatim, with no `$` pattern scanning:

```ts
export function resolveProfilePlaceholders(value: string, ctx: { HOME: string; AGENT_DIR: string }): string {
  return value.replace(/\$\{(HOME|AGENT_DIR|WORKDIR)\}/g, (_m, key: string) =>
    key === 'HOME' ? ctx.HOME : ctx.AGENT_DIR,
  )
}
```

This also fixes a second, subtler ordering issue in the current
implementation: because the three `replace` calls run in sequence, a
`ctx.HOME` value that itself contains the literal `${AGENT_DIR}` is
re-substituted by the next pass. The single-pass regex above cannot
re-enter its own output.

## Resolution

Replaced the three sequential `String.prototype.replace` calls with a
single pass over `/\$\{(HOME|AGENT_DIR|WORKDIR)\}/g` whose replacer is a
function. Function replacements receive the match and the captured group
and return a string verbatim — `$&`, `` $` ``, `$'` and `$n` sequences
in `ctx.HOME` / `ctx.AGENT_DIR` are now literal text, not metacharacters.

New block at `src/web/profiles.ts:51-54`:

```ts
export function resolveProfilePlaceholders(value: string, ctx: { HOME: string; AGENT_DIR: string }): string {
  return value.replace(/\$\{(HOME|AGENT_DIR|WORKDIR)\}/g, (_m, key: string) =>
    key === 'HOME' ? ctx.HOME : ctx.AGENT_DIR,
  )
}
```

Side benefits (called out in the suggested direction):
- The previously-pinned `'PINS BUG: `$&` in a context value re-inserts
  the matched placeholder'` and `'PINS BUG: a backtick pattern in a
  context value drops characters'` cases in
  `src/__tests__/profiles.test.ts` flip to the expected literal-text
  output (`'/home/a$&b/x'` and `` '/a$`z/x' ``).
- The single-pass regex cannot re-enter its own output, so a `ctx.HOME`
  value that itself contains the literal `${AGENT_DIR}` is no longer
  re-substituted by a follow-up pass (this secondary ordering bug was
  unreachable on real inputs because `homedir()` contains no `$`, but
  the symmetric case where `agentDir(name)` did could surface once one
  user-path literal started nesting another).
- The `${WORKDIR}` alias for `AGENT_DIR` is preserved by collapsing
  the alternation to `key === 'HOME' ? ctx.HOME : ctx.AGENT_DIR`.
