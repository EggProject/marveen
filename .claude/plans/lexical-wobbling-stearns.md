# Cycle 21 — Revert + replace `notify-fallback-hardcodes-telegram-limit` fix

## Context

The first iteration of the cycle-21 batch (commit `be8f505`) closed
`notify-fallback-hardcodes-telegram-limit` by adding a new `maxMessageLength: number`
field to the `ChannelProvider` interface and 5 implementor literals, then
changing `chunk.slice(0, 4096)` to `chunk.slice(0, provider.maxMessageLength)` in
`src/notify.ts:25`. The user pushback: this expansion was unnecessary ("erőszakos
bevezetés") because (a) the bug MD itself recommended using the provider's
existing `splitMessage` instead, and (b) two of the constants the new field
copied into the type system were already wrong against official API docs:

| Provider | Code constant | API reality | Source |
|---|---|---|---|
| telegram | 4096 | 4096 ✓ | core.telegram.org (official) |
| slack | 4000 (best-practice) | **40,000** hard limit | docs.slack.dev + 2018 changelog |
| discord | 2000 | 2000 ✓ | docs.discord.com (official) |
| googlechat | 4096 (chars) | **32,000 bytes** (~8k-32k chars) | developers.google.com (official) |
| teams | 28000 (chat) | 28KB chat, **40KB bot** | learn.microsoft.com |

So `be8f505` perpetuated the wrong slack and googlechat limits at the type level.
We should not have shipped it.

**This plan**: undo `be8f505` and replace it with the smaller, MD-recommended
fix that uses `provider.splitMessage(chunk)[0]` instead. Each provider's
`splitMessage` already invokes the (still-imperfect, but no-worse-than-today)
provider-specific constant via `splitMessage: (text) => splitMessage(text, X_MAX)`,
so we get provider-aware splitting without expanding the interface.

The other two cycle-21 commits (`45bb024` syntax-check, `16949d9` routes-docs)
are unrelated and stay.

## Approach (3 new commits, all on `test/baseline`, no push)

### Commit 1 — `revert: notify-fallback-hardcodes-telegram-limit (interface expansion)`

```
git revert be8f505 --no-edit
```

This produces a commit that undoes the interface field, the 5 implementor
literals, the `notify.ts:25` change, AND the pinning test header/assertion flip
back to "captures the bug" state. Working tree is back to the pre-`be8f505`
shape.

After this commit, the bug is **back** (hardcoded `chunk.slice(0, 4096)` again)
and the pinning test asserts the bug. Transient state — fixed immediately by
commit 2.

### Commit 2 — `fix(notify): use provider.splitMessage for fallback chunk (closes notify-fallback-hardcodes-telegram-limit)`

**Source change** — `src/notify.ts:25`:

```diff
-        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, chunk.slice(0, 4096))
+        // Fallback: re-split the failing chunk through the provider's own
+        // splitMessage. Each provider's splitMessage uses its own limit
+        // constant, so this respects the provider's actual API limit
+        // without expanding the ChannelProvider interface.
+        const [fallback] = provider.splitMessage(chunk)
+        await provider.sendMessage(CHANNEL_TOKEN, CHANNEL_CHAT_ID, fallback)
```

Behavior:
- `provider.splitMessage(chunk)` always returns `string[]` with at least one
  element (confirmed at `src/format.ts:splitMessage`).
- `[0]` is the largest sub-chunk that fits in the provider's limit.
- For chunks already <= provider limit (the common case, since chunks come from
  `provider.splitMessage(formatted)` at line 17), `[0]` is the chunk unchanged.
- For chunks slightly over the limit (e.g. `formatMessage` added prefix), `[0]`
  is properly truncated at a word boundary.
- Does **not** reintroduce `notify-fallback-repeats-head` (closed in `ff22286`)
  because we split the **current chunk**, not `outbound`.

**Test change** — `src/__tests__/notify.test.ts`:

The pinning test around lines 140-154 stays structurally the same. Mock's
`splitMessage` already encodes the discord 2000-char limit. Assertion
`expect(providerMock.sendMessage.mock.calls[1]?.[2]).toHaveLength(2000)`
remains valid (a 3000-char chunk → mock's splitMessage returns `[2000-char]` →
the fallback sends that 2000-char piece).

Test header comment and name may be lightly updated:

```diff
-  // PINNING (resolved 2026-08-17) -- notify-fallback-hardcodes-telegram-limit
-  it('respects the provider limit when truncating the fallback (resolved 2026-08-17)', async () => {
+  // PINNING (resolved 2026-08-17) -- notify-fallback-hardcodes-telegram-limit
+  it('uses provider splitMessage for the fallback chunk (resolved 2026-08-17)', async () => {
```

The `maxMessageLength` field setup on the mock (added in `be8f505`, will be
removed in commit 1's revert) goes away — mock no longer needs it. The `beforeEach`
resets that defaulted to 4096 in the revert can be dropped entirely.

**Verification**:

```sh
bun --bun vitest run src/__tests__/notify.test.ts     # must pass
bun --bun vitest run src/__tests__/channel-provider.test.ts   # must pass (no interface field to break)
bun run typecheck                                    # no new errors
```

### Commit 3 — `docs(needs-to-be-fix): update notify-fallback SHA reference`

In `docs/needs-to-be-fix/INDEX.md`, update ONLY the row for
`notify-fallback-hardcodes-telegram-limit`. Leave the other two rows
(`syntax-check-executes-web-bundle`, `routes-docs-inner-catch-no-title-reset`)
untouched — their SHAs (`45bb024`, `16949d9`) are still correct.

```diff
-| `notify-fallback-hardcodes-telegram-limit` | ... | ... | ... | Resolved: 2026-08-17 be8f505 |
+| `notify-fallback-hardcodes-telegram-limit` | ... | ... | ... | Resolved: 2026-08-17 <commit-2-sha> |
```

## Critical files

| File | Action |
|---|---|
| `src/notify.ts` | 1-line change at line 25 (use `provider.splitMessage(chunk)[0]`) |
| `src/__tests__/notify.test.ts` | Light header + name + drop `maxMessageLength` mock setup |
| `docs/needs-to-be-fix/INDEX.md` | Update one row's SHA reference |
| `src/channel-provider.ts` | (only via revert) remove `maxMessageLength` from interface + 5 literals |

## Commit shape (3 commits on `test/baseline`)

```
docs(needs-to-be-fix): update notify-fallback SHA reference
fix(notify): use provider.splitMessage for fallback chunk (closes notify-fallback-hardcodes-telegram-limit)
revert: notify-fallback-hardcodes-telegram-limit (interface expansion)
317bd82 docs(needs-to-be-fix): mark 3 cycle-21 items resolved
16949d9 fix(routes-docs): reset title to filename in inner catch (closes routes-docs-inner-catch-no-title-reset)
45bb024 fix(build): switch syntax-check to node --check (closes syntax-check-executes-web-bundle)
be8f505 fix(notify): respect provider limit when truncating the fallback (closes notify-fallback-hardcodes-telegram-limit)  [orphaned — not reachable from HEAD]
bb547fb docs(needs-to-be-fix): mark 3 cycle-21 items resolved
```

`be8f505` becomes unreachable from `HEAD` (a "dangling" commit). That's fine —
local history is allowed to have these, and we don't push.

## Workflow phases (sequential)

1. **Phase A — Revert `be8f505`**
   - `git revert be8f505 --no-edit` — produces the revert commit.
   - `git status` — verify clean.
   - Report: revert commit SHA.

2. **Phase B — New fix with `provider.splitMessage(chunk)[0]`**
   - Edit `src/notify.ts:25` (1-line change + comment).
   - Edit `src/__tests__/notify.test.ts` (header + name + drop mock field).
   - `bun --bun vitest run src/__tests__/notify.test.ts` — must pass.
   - `bun run typecheck` — must stay at baseline (1701 errors, no new).
   - `git commit` with the fix message.
   - Report: fix commit SHA.

3. **Phase C — Update INDEX.md SHA reference**
   - Edit only the `notify-fallback-hardcodes-telegram-limit` row in INDEX.md.
   - `git diff docs/needs-to-be-fix/INDEX.md` — verify exactly 1 row changed.
   - `git commit` with the docs message.
   - Report: docs commit SHA + final `git log --oneline -7`.

Phases A→B→C run sequentially; each MUST complete before the next.

## Verification

After all 3 phases:

```sh
# Branch + unpushed state
git branch --show-current                              # test/baseline
git log origin/test/baseline..HEAD --oneline          # 7 unpushed commits (4 prior + 3 new)
git log --oneline -8                                   # see the 3-commit sequence at the top

# Final state of the affected files
git show HEAD~2 -- src/notify.ts                       # 1-line change visible
grep "maxMessageLength" src/channel-provider.ts        # should be empty (interface + 5 literals removed)

# Tests + typecheck
bun --bun vitest run src/__tests__/notify.test.ts                          # pass
bun --bun vitest run src/__tests__/channel-provider.test.ts                # pass (no maxMessageLength in interface)
bun --bun vitest run src/__tests__/syntax-check && bun run syntax-check    # unrelated, must still pass
bun --bun vitest run src/__tests__/routes-docs.test.ts                     # unrelated, must still pass
bun run typecheck                                                          # no new errors

# INDEX.md diff
git show HEAD -- docs/needs-to-be-fix/INDEX.md | head -30
# Expected: exactly 1 row SHA updated (notify-fallback-hardcodes-telegram-limit),
# the other 2 rows untouched.

# End-state semantics
bun -e "const {getProvider} = await import('./src/channel-provider.js'); \
        const d = getProvider('discord'); \
        console.log(d.splitMessage('x'.repeat(3000)).map(s => s.length))"
# Expected: [2000, 1000] — proves the provider-aware split works without
# any maxMessageLength field on the interface.
```

## Risks (mitigated)

- **Revert commit conflicts with `317bd82` docs commit**: 317bd82 only touches
  INDEX.md, not source. No conflict.
- **Revert removes `maxMessageLength` mock field from test**: commit 2's test
  edit drops it before reverting would otherwise leave a stale reference.
  Pin the mock change in commit 2, not commit 1.
- **No reintroduction of `notify-fallback-repeats-head`** (closed in ff22286):
  the fallback now calls `provider.splitMessage(chunk)`, not
  `provider.splitMessage(outbound)`. The `chunk` is the current chunk being
  processed, so each fallback is sized to one chunk, not the full outbound.
- **`splitMessage` returns empty array**: confirmed in `src/format.ts:splitMessage`
  that the function always returns ≥ 1 element. The `[0]` destructure is safe.
- **The `provider.splitMessage.length` field doesn't exist** (a previous
  comment in the chat mistakenly mentioned it as a safety fallback). The plan
  uses only the actual `[0]` destructure, no `.length` fallback. Safety
  guaranteed by the format.ts contract.
