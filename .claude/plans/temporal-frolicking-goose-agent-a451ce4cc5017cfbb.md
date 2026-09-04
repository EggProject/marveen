# Plan: Next-smallest needs-fix candidates (read-only scan)

## Summary

Scanned the 20 candidate MDs the user asked about. None of them is a pure
"drop dead branch" like the recent commits (3bec823, 5a2a3a7, 9aa71e5,
9173b54, c1ee774, 410ca16, 1a9d0d5, 3e1dd3f). They are all behavior fixes
of varying degrees.

Two of the user's listed candidates are already resolved or duplicate of
something resolved:

* `web-command-task-persist-nullish-coalesce` — DUPLICATE. The actual fix
  landed in af4c087 ("drop dead `healthMap ?? {}` arm in
  command-task.ts:34"); the MD file is a leftover orphan from the
  reconcile pass. HEAD already uses `JSON.stringify(load(), null, 2)` on
  line 34 — the `?? {}` arm is gone.
* `agent-process-runtmux-host-truthy-cond-unreachable` — RESOLVED in
  a71cc75 (drop dead truthy arm of `runTmux` timeout + add explicit
  `opts.timeout` at line 978). INDEX has not been updated to reflect
  this; the orphan table at the bottom of INDEX.md also misses it.

Three "TS-strict-blocks-delete" items in the user's list are explicitly
not droppable:

* `channel-invites-108-ts-strict-blocks-delete` — TS2769 on `Object.values(undefined)`.
* `channel-invites-236-ts-strict-blocks-delete` — TS18048 on `delete access.pending[pCode]`.
* `agent-terminal-218-ts-strict-blocks-delete` — TS18047 on `literalKeys.slice(...)`.

`federation-routes-fedpeer-required-type-narrow-deferred` requires
~10+ test literal edits and would push the typecheck budget +71 over the
+5 tolerance; explicitly deferred, not small.

## Per-candidate assessment

| # | Candidate | File:line | Fix shape | Lines | Pin test | Dead-branch or behavior fix | Notes |
|---|---|---|---|---|---|---|---|
| 1 | `web-command-task-persist-nullish-coalesce` | `src/web/command-task.ts:34` | dead-branch drop | 1 | `src/__tests__/web-command-task.test.ts` | dead-branch drop | **ALREADY DONE** via af4c087. Skip. |
| 2 | `routes-ideas-breakdown-nonerror` | `src/web/routes/ideas.ts:186-189` | behavior fix (500 body) | 1 | `src/__tests__/ideas-routes.test.ts` | behavior fix | `(err as Error).message` → safe extraction. 500 stays, body becomes meaningful. Smallest behavior change in the list. |
| 3 | `stuck-tool-call-watcher-skew-defer` | `src/web/stuck-tool-call-watcher.ts:141` | behavior fix (fail-open) | 1 | `src/__tests__/stuck-tool-call-watcher.test.ts` | behavior fix | Add `age >= 0` clamp. Matches the module's stated "fail-open" posture (sibling logic in `decideStuckToolCallRecovery` does the same). |
| 4 | `vault-readvault-missing-entries-fatal` | `src/web/vault.ts:93-96` | behavior fix (silent default) | 5 | `src/__tests__/vault.test.ts` | behavior fix | `entries ?? []`. Currently throws; would silently default. Risk: hides future schema drift. |
| 5 | `routes-ideas-body-parse-500` | `src/web/routes/ideas.ts:43,86,138,152,201` | behavior fix (400 vs 500) | ~5 + helper | `src/__tests__/ideas-routes.test.ts` | behavior fix | Five call sites need a `parseBody` helper. 400 instead of 500 affects clients. |
| 6 | `memory-digest-empty-trim` | `src/memory.ts:200-206` | behavior fix (suppress) | 5 | `src/__tests__/memory.test.ts` | behavior fix | Suppresses whitespace-only digest saves. |
| 7 | `routes-ideas-title-validation` | `src/web/routes/ideas.ts:51` | behavior fix (validation) | ~6 | `src/__tests__/ideas-routes.test.ts` | behavior fix | Add trim + type check; mirrors comment endpoint. |
| 8 | `routes-memories-nan-limit` | `src/web/routes/memories.ts:72` | behavior fix (validation) | 4 | `src/__tests__/memories-routes.test.ts` | behavior fix | Clamp NaN/negative limit. |
| 9 | `routes-memories-put-tier-precedence` | `src/web/routes/memories.ts:242` | behavior fix (semantics) | 4 | `src/__tests__/memories-routes.test.ts` | behavior fix | Invert `tier \|\| category` to `category \|\| tier`. |
| 10 | `kanban-dispatch-owner-case` | `src/kanban-dispatch.ts:34` | behavior fix (case-sensitivity) | 4 | `src/__tests__/kanban-dispatch.test.ts` | behavior fix | `===` → `===` lowercased on both sides. |
| 11 | `notify-fallback-hardcodes-telegram-limit` | `src/notify.ts:25` | behavior fix (provider-aware) | 1 | `src/__tests__/notify.test.ts` | behavior fix | `4096` → `provider.maxMessageLength`. |
| 12 | `keychain-store-insecure-acl` | `src/web/keychain.ts:19` | behavior fix (ACL) | 2 | `src/__tests__/keychain.test.ts` | behavior fix | `-A` → `-T SECURITY`. MD warns: until `keychain-retrieve-swallows-locked-keychain` is fixed, prompts would be silently swallowed as null and trigger vault re-key. |
| 13 | `keychain-retrieve-swallows-locked-keychain` | `src/web/keychain.ts:32-34` | behavior fix (signature change) | ~10 | `src/__tests__/keychain.test.ts` | HIGH SEVERITY behavior fix | Changes return type to `string \| null \| KeychainUnavailableError`. **HIGH severity** data-loss path. NOT small. |
| 14 | `model-fallback-runner-writemainmodel-nonobject` | `src/web/model-fallback-runner.ts:56-61` | behavior fix (settings.json) | ~10 | `src/__tests__/model-fallback-runner.test.ts` | behavior fix | Mirror reader's `cfg && typeof cfg.model === 'string'` guard. Multi-line; changes how malformed settings.json gets handled. |
| 15 | `notify-fallback-repeats-head` | `src/notify.ts:19-28` | behavior fix (fallback semantics) | ~6 | `src/__tests__/notify.test.ts` | behavior fix | Re-send failed chunk, not full outbound head. |
| 16 | `recall-dayofweek-noon-utc-far-east-skew` | `src/web/routes/recall.ts:21-31` | behavior fix (TZ anchor) | ~10 | `src/__tests__/recall.test.ts` | behavior fix | Anchor noon in install zone rather than UTC. |
| 17 | `channel-invites-108-ts-strict-blocks-delete` | `src/web/channel-invites.ts:108` | NOT a drop | n/a | synthetic test in place | blocked | TS2769 blocks `Object.values(store.invites)` after drop. |
| 18 | `channel-invites-236-ts-strict-blocks-delete` | `src/web/channel-invites.ts:236` | NOT a drop | n/a | synthetic test in place | blocked | TS18048 blocks `delete access.pending[pCode]` after drop. |
| 19 | `agent-terminal-218-ts-strict-blocks-delete` | `src/web/routes/agent-terminal.ts:218` | NOT a drop | n/a | synthetic test in place | blocked | TS18047 blocks non-null access on `string \| null` after drop. |
| 20 | `federation-routes-fedpeer-required-type-narrow-deferred` | `src/web/routes/federation.ts:298,329` | NOT a small fix | ~30+ | `src/__tests__/types.test.ts` | structural | Touches 10+ test files; typecheck budget +71 vs +5 tolerance. Explicitly deferred. |

## Risk ranking (smallest first)

1. `routes-ideas-breakdown-nonerror` — 1 line, 500 status code unchanged,
   body just gets a proper message. Lowest risk behavior fix on the list.
2. `stuck-tool-call-watcher-skew-defer` — 1 line, fail-open matches the
   module's stated posture and the sibling `decideStuckToolCallRecovery`
   logic. Low risk.
3. `vault-readvault-missing-entries-fatal` — 5 lines, `entries` defaults
   to `[]`. Risk: hides schema drift in future migrations; mitigated by
   the explicit shape check in the suggested fix.
4. `routes-ideas-body-parse-500` — ~5 lines + helper, 400 instead of 500.
   Affects all five body-reading endpoints on this file. Mid risk.
5. `memory-digest-empty-trim` — 5 lines, post-trim guard. Behavior change
   (suppresses whitespace-only digest saves), but contract stays.
6. `routes-ideas-title-validation` — ~6 lines, validation tightening.
   Same risk profile as #4 (consistency with sibling endpoint).

## Recommendation

The user asked for items matching the recent "drop dead branch" pattern.
**None of the 20 listed candidates is a pure dead-branch drop** like the
recent commits. The three TS-strict items and the federation-routes
narrowing are explicitly not droppable. The other 16 are all behavior
fixes.

The single closest match on the user's list was
`web-command-task-persist-nullish-coalesce`, but it's already been
resolved via af4c087 (orphan MD leftover).

If "drop dead branch, zero behavior change" is the hard requirement,
the next candidates NOT on the user's list that match the pattern are:

* `agent-process-answerfirstrungates-acted-unchanged-unreachable` —
  `src/web/agent-process.ts:1512`. The `?:` ternary's `: 'unchanged'`
  arm is unreachable: every for-loop iteration that reaches natural exit
  has set `acted = true`. Suggested fix: `return 'cleared'`. 1-line,
  zero behavior change on reachable inputs. Index shows it OPEN (not
  in resolved column of orphan table).
* `agent-process-restartagentprocess-stop-error-default-unreachable` —
  `src/web/agent-process.ts:1384`. `||` default
  `'Failed to stop running agent before restart'` is dead: both
  `ok: false` paths in `stopAgentProcess` carry truthy errors. Fix:
  `stopResult.error!`. 1-line, zero behavior change.

(These two are not on the user's list but are the closest match to the
recent drops pattern within the open needs-fix set.)

## Files inspected

* `docs/needs-to-be-fix/INDEX.md` (full)
* `docs/needs-to-be-fix/routes-memories-nan-limit.md`
* `docs/needs-to-be-fix/kanban-dispatch-owner-case.md`
* `docs/needs-to-be-fix/routes-memories-put-tier-precedence.md`
* `docs/needs-to-be-fix/keychain-store-insecure-acl.md`
* `docs/needs-to-be-fix/keychain-retrieve-swallows-locked-keychain.md`
* `docs/needs-to-be-fix/memory-digest-empty-trim.md`
* `docs/needs-to-be-fix/model-fallback-runner-writemainmodel-nonobject.md`
* `docs/needs-to-be-fix/stuck-tool-call-watcher-skew-defer.md`
* `docs/needs-to-be-fix/routes-ideas-title-validation.md`
* `docs/needs-to-be-fix/routes-ideas-breakdown-nonerror.md`
* `docs/needs-to-be-fix/routes-ideas-body-parse-500.md`
* `docs/needs-to-be-fix/channel-invites-108-ts-strict-blocks-delete.md`
* `docs/needs-to-be-fix/channel-invites-236-ts-strict-blocks-delete.md`
* `docs/needs-to-be-fix/agent-terminal-218-ts-strict-blocks-delete.md`
* `docs/needs-to-be-fix/federation-routes-fedpeer-required-type-narrow-deferred.md`
* `docs/needs-to-be-fix/recall-dayofweek-noon-utc-far-east-skew.md`
* `docs/needs-to-be-fix/vault-readvault-missing-entries-fatal.md`
* `docs/needs-to-be-fix/notify-fallback-hardcodes-telegram-limit.md`
* `docs/needs-to-be-fix/notify-fallback-repeats-head.md`
* `docs/needs-to-be-fix/web-command-task-persist-nullish-coalesce.md`
* `docs/needs-to-be-fix/agent-process-answerfirstrungates-acted-unchanged-unreachable.md`
* `docs/needs-to-be-fix/agent-process-restartagentprocess-stop-error-default-unreachable.md`
* `docs/needs-to-be-fix/agent-process-runtmux-host-truthy-cond-unreachable.md`
* `docs/needs-to-be-fix/agent-team-trustfrom-nullish-coalesce.md`
* `docs/needs-to-be-fix/agent-team-trustfrom-required-type-narrow-deferred.md`
* `src/web/command-task.ts:25-37` (verify duplicate is already fixed)
* Recent commit logs: 3bec823, 5a2a3a7, 9aa71e5, 9173b54, c1ee774,
  410ca16, 1a9d0d5, 3e1dd3f, a71cc75, af4c087
