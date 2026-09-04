# Plan: next smallest "needs fix" batch (revised after subagent verification)

## Context

The repo carries a large backlog of bug MDs in `docs/needs-to-be-fix/`
(177 entries). The recent commit history on `test/baseline` shows the
cleanup phase steadily knocking out small dead-defensive-branch items
(`40980b4`, `ba6faf8`, `0b61592`, etc.). The user asked: **what are the
next smallest "needs fix" items that can be modified, with some
failure risk, and that can be merged if safe?**

After the dual-subagent verification round, the original plan was
reduced: the `channel-invites` Item 2 turns out to be moot because
commit `d48256c` (2026-08-19) already resolved the parent MD
`channel-invites-unreachable-defensive-branches.md`. The child MDs
that claim the safe-delete is blocked are stale; the edit actually
landed.

## Recommended next batch (1 PR, 1 source file + 4 MD docs)

### Item 1: `agent-terminal.ts:218` - drop 2 dead `?? ''` fallbacks

**Merges MDs:**
- `agent-terminal-218-ts-strict-blocks-delete`
- `agent-terminal-keys-preview-literalKeys-fallback`

(both describe the same two unreachable fallbacks at the same line.)

**File:** `src/web/routes/agent-terminal.ts`, lines 216-218.

**Current code:**
```ts
const preview = parsed.special
  ? `special:${parsed.special}`
  : `keys:${JSON.stringify((literalKeys ?? '').slice(0, 120))}${(literalKeys ?? '').length > 120 ? '…' : ''}`
```

**Why dead:** The upstream `if (!args) return` at line 209 fires whenever
`parsed.special` is falsy AND `literalKeys` is null/empty, so by the
time we reach the preview line, either `parsed.special` is truthy
(literalKeys not read) or `literalKeys` is a non-empty string.

**Proposed fix:** nested ternary with `literalKeys ?` narrowing so the
`?? ''` becomes unnecessary and TS narrows `literalKeys` to `string`:

```ts
const preview = parsed.special
  ? `special:${parsed.special}`
  : literalKeys
    ? `keys:${JSON.stringify(literalKeys.slice(0, 120))}${literalKeys.length > 120 ? '…' : ''}`
    : '' // unreachable: if (!args) already returned
```

The subagent verification confirmed:
- TS narrows `literalKeys` from `string | null` to `string` inside the
  inner ternary truthy branch (`? ... : ''` discriminates on truthiness,
  `null` is excluded).
- No test in `agent-terminal-routes.test.ts` reaches the `?? ''` falsy
  arm. All audit-log tests pass a non-null `literalKeys`; the 400-path
  tests return before the audit log.
- The new `: ''` arm IS still structurally unreachable for the same
  reason the old `?? ''` was, so branch count goes 2 -> 1 (net -1
  dead branch, NOT 100% coverage on this file).

**Coverage impact (corrected):**
- Before: 2 dead `?? ''` branches at line 218.
- After: 1 dead ternary arm in the new `: ''`.
- Net: -1 dead branch (improvement, not 100%).

The commit message and MD `Resolved` lines will NOT claim "100%
branch coverage". They will claim "removed 2 dead `?? ''` arms;
introduced 1 unreachable ternary arm; net -1 dead branch".

**Files changed:**
- `src/web/routes/agent-terminal.ts` (one ternary, ~4 lines net change)
- `docs/needs-to-be-fix/agent-terminal-218-ts-strict-blocks-delete.md`
  (add Resolved line + commit SHA; existing "Edit reverted" prose is
  now stale)
- `docs/needs-to-be-fix/agent-terminal-keys-preview-literalKeys-fallback.md`
  (add Resolved line + commit SHA)
- `docs/needs-to-be-fix/INDEX.md` (update both rows in the orphan
  addenda section: Resolved `YYYY-MM-DD <sha>`)

**Test impact:** No pinning test exists for the `?? ''` arms. The
existing `agent-terminal-routes.test.ts` covers `preview =
'special:Enter'` (line 672), `preview = 'keys:"hello"'` (line 646),
and `'truncates the preview and adds an ellipsis when > 120 chars'`
(line 649) - all pass with the new ternary because `literalKeys`
remains non-null in those cases. The verifier subagent traced each
of the 7 audit-log test paths and confirmed none reaches the
`?? ''` falsy arm.

**Failure mode:** if TS refuses to narrow across the nested ternary,
fall back to "option (b)" - add invariant comment, leave code as is,
mark MDs as `option (b) documented: <new-sha>`.

**Verification:**
```
bun test src/__tests__/agent-terminal-routes.test.ts
bun run typecheck
```

### Item 2 (NEW, post-verification): doc-only resolution of 2 stale channel-invites child MDs

After the verification round, this item is **doc-only** - no source
changes. It closes out the bookkeeping that Item 2 would have done.

**MDs:**
- `docs/needs-to-be-fix/channel-invites-108-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/channel-invites-236-ts-strict-blocks-delete.md`

**Why doc-only:** Commit `d48256c` (2026-08-19, "fix(channel-invites):
drop 2 dead defensive guards (lines 108, 236)") landed the safe-delete
both child MDs claimed was TS-strict-blocked. The `?? {}` belt-and-braces
in the current source (lines 109 and 235) is structurally unreachable
but kept as documentation of the invariant. The child MDs' "Edit
reverted. Source branch left intact." prose is factually wrong - the
edit landed, the source branch is NOT intact.

**Proposed action:**
1. Append a `Resolved` section to each child MD citing
   `2026-08-19 d48256c` (the actual commit that resolved the parent
   and superseded the children's complaint).
2. Update the `INDEX.md` orphan addenda rows for both MDs to read
   `Resolved: 2026-08-19 d48256c` (currently they read `—` unresolved).
3. The INDEX.md High/Medium severity rows already cite `d48256c` for
   the parent; the orphan addenda need the same update.

**Test impact:** None (doc-only).

**Files changed:**
- `docs/needs-to-be-fix/channel-invites-108-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/channel-invites-236-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/INDEX.md`

## Why the original Item 2 was rejected

The dual verification surfaced three concrete errors that would have
broken the build:

1. **`d48256c` already dropped the guards at lines 108 and 236.** The
   plan's reference to those lines as if they still have `if` guards
   was stale - `git show d48256c` confirms the diff.

2. **Tests at lines 373, 464, 638 of `channel-invites.test.ts` write
   raw `'{}'` to disk** and exercise the surviving `if (!store.invites)`
   guards at lines 96, 164, 177, 209. Dropping those guards would
   cause `Object.entries(store.invites)` to throw `TypeError`, breaking
   3 tests.

3. **`access.pending` is a KNOWN plugin field**, not unknown. The
   source comment lines 42-50 enumerates `pending` as one of three
   fields the plugin and this module share. The proposed new guard
   `if (!access.pending) continue` would have been unreachable
   (regression, not improvement).

The revised plan removes all three error sources by collapsing Item 2
to docs-only bookkeeping.

## Execution approach (per user's request)

Per the user's instructions:
- **Workflow** drives the work, not a direct edit pass.
- **Start from `test/baseline`** (current branch) and merge back.
- **`/code-review xhigh --fix`** at the end.
- **2 subagents** independently verify the plan (already done - the
  verification surfaced the Item 2 errors above; the plan is the
  corrected outcome).

### Workflow script shape (drafted, not yet executed)

```js
export const meta = {
  name: 'next-smallest-needs-fix-batch',
  description: 'Drop dead ?? defensive fallbacks in agent-terminal; resolve 4 stale MDs',
  phases: [
    { title: 'Plan verify' },     // already done - 2 subagents independently
    { title: 'Fix agent-terminal.ts:218' },
    { title: 'Update 4 MDs + INDEX' },
    { title: 'Verify (tests + typecheck + coverage)' },
    { title: 'Code review' },     // /code-review xhigh --fix
  ],
}
```

## Critical files

- `src/web/routes/agent-terminal.ts` (lines 200-218, the preview
  construction)
- `src/__tests__/agent-terminal-routes.test.ts` (lines 629-728, the
  7 audit-log tests; verifier confirmed none hits `?? ''` falsy arm)
- `docs/needs-to-be-fix/agent-terminal-218-ts-strict-blocks-delete.md`
- `docs/needs-to-be-fix/agent-terminal-keys-preview-literalKeys-fallback.md`
- `docs/needs-to-be-fix/channel-invites-108-ts-strict-blocks-delete.md`
  (doc-only)
- `docs/needs-to-be-fix/channel-invites-236-ts-strict-blocks-delete.md`
  (doc-only)
- `docs/needs-to-be-fix/INDEX.md` (4 rows updated)

## Risks & mitigations

| Risk | Likelihood | Mitigation |
| --- | --- | --- |
| TS refuses nested-ternary narrowing on `literalKeys` | Low | Fall back to `?? ''` with invariant comment; mark MDs as `option (b) documented` |
| Coverage regresses in unrelated file | Low | Run coverage report after the change; message-router.ts untouched (no edit there) |
| Other tests construct `RouteContext` literal missing `fedPeer` | n/a (out of scope) | Federation type narrowing deferred to a separate plan (7 test files touched) |
| `d48256c` SHA cited in MD is wrong | Very low | `git rev-parse d48256c` will be run at execution time; if the commit is not on `test/baseline` branch, switch to the actual HEAD sha |

## End-to-end verification

After the change lands:

```
bun test src/__tests__/agent-terminal-routes.test.ts
bun run typecheck
git grep -n "literalKeys ?? ''" src/web/routes/agent-terminal.ts   # should be empty
git grep -n "Object.values(store.invites ?? {})" src/web/channel-invites.ts   # still present (correct belt-and-braces)
```

After commit (CLAUDE.md bans `git push`), the user runs
`/code-review xhigh --fix` which:
- Re-reads the diff,
- Checks the new ternary shape against the suite,
- Validates the MD `Resolved` lines cite the real commit SHAs.

## Out of scope (deferred)

- `message-router-unreachable-defensive-branches` lines 478-480 (eb9b951
  was reverted on 2ec1c99 because the fix made coverage worse - needs a
  separate plan that proposes the `Map -> plain object` refactor).
- `federation-inbox-fedPeer-null-fallback` + `federation-routes-fedpeer-required-type-narrow-deferred`
  (the type tightening touches 7 test files; not "smallest").
- `recall-dayofweek-noon-utc-far-east-skew` (real bug, deserves its
  own plan with full TZ sweep).
- All "NEVER modify src/web/X.ts" MDs (the rule blocks edits until
  the user explicitly overrides per task).
- `channel-invites` source-level work beyond doc-only resolution
  (the d48256c fix is the right shape; further changes would break
  the 3 `'{}'`-file tests).