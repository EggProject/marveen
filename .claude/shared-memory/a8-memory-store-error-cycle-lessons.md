# A.8a + A.8b cycle lessons (2026-09-07)

Cycle owner: session that landed commits `2c4669f` + `283fd82` on `refactor/classbase`.

Scope: introduced `class MemoryStoreError extends AppError` and migrated `searchMemories` FTS-fallback catch from silent `return []` to typed throw, with `instanceof MemoryStoreError` narrowing in both production callers (`src/memory.ts:84-94`, `src/web/routes/memories.ts:89-99`). Final state: 7 files, +209/-49 lines. Gates: TSC 0, vitest 329/329 PASS. `/code-review max --fix 135e948..283fd82` returned 0 findings.

## Reusable patterns (ranked by load-bearing impact)

### 1. `git merge-base --is-ancestor` actual semantics — CLAUDE.md §8 doc is WRONG

The flag reads `--is-ancestor A B` and answers: **"is A an ancestor of B?"** — A is the older commit, B is the newer. The CLAUDE.md §8 doc claims the opposite direction (`<SHA> <branch>` for "SHA is descendant of branch"); this is wrong. The session hit this directly:

- `--is-ancestor 2c4669f refactor/classbase` → exit 1 (NOT descendant)
- `--is-ancestor refactor/classbase 2c4669f` → exit 0 (IS descendant — branch IS ancestor of SHA)

**Correct invocation** to verify "SHA is a descendant of branch": `git merge-base --is-ancestor <branch> <SHA>` (branch first as first argument).

Precedent in corpus: ca9d811f session also hit this confusion. The CLAUDE.md §8 doc should be corrected — not in this cycle (out of scope per user "surgical changes" rule), but as a future Honcho/shared-memory note.

### 2. Scope expansion via production caller check (NOT catch-site check)

Before throwing from a previously-silent function, the plan's step 1 was `grep -rn '<func>' src/ --include='*.ts' | grep -v __tests__ | grep -v '<file>'` framed as a "catch site" check, but this grep finds ALL callers, not just catch sites. If any caller has no try/catch wrapper, the throw becomes uncaught and breaks the rare-error path that the silent catch had previously hidden.

**Pattern**: when migrating a `} catch { return <fallback> }` to `throw new XxxError(...)`, treat the grep output as a CALLER list, not a CATCH list. For each caller, decide:
- If the caller has its own try/catch around the call → throw is compatible, scope unchanged.
- If the caller relies on the fallback return value → either add a try/catch wrapper in the caller (scope expand) OR keep the silent return (no-op).

In this cycle, the 2 callers (`src/memory.ts:83`, `src/web/routes/memories.ts:89`) had no try/catch. The session surfaced the conflict BEFORE implementation began (during planning, with a concrete fallback test for `buildMemoryContext` and the LIKE-fallback branch in the route handler). User approved the scope expansion (3 extra files, ~25 extra lines), and the throw migration landed cleanly with graceful degradation instead of uncaught errors.

**Failure mode this prevents**: silent-catch removal causing HTTP 500s or process crashes in production on the rare error path. The silent catch was load-bearing even when "unused".

### 3. Phase 2.5 follow-up fix pattern (Verifier HIGH findings fixed in-session)

After the 2 reviewer subagents ran (structural PASS/FAIL checklist + adversarial falsification, per CLAUDE.md §8 different-angle rule), the adversarial verifier flagged 2 HIGH findings:

- `as unknown as new (msg: string) => Error` cast in `memory-store-error.test.ts:46` violates CLAUDE.md §7; H.4 `errors.test.ts:18-22` precedent uses `@ts-expect-error` for the same abstract-guard check.
- Gate output file anomaly (`/tmp/a8-gates/grep-class.txt` recorded `0` but actual was `2`; `tsc-count.txt` recorded `2` but actual was `0`).

The session opened a SECOND worktree (`$HOME/claw-a8-fix`, branch `refactor/a8-followup-fix`), applied 3 surgical fixes:
1. Replaced the `as unknown as` cast with the cleaner pattern (matching H.4 precedent); removed the AppError abstract-guard Test7 that duplicated H.4 `errors.test.ts:18-22`.
2. Strengthened Test6 (missing cause) with an additional assertion verifying empty options object does not propagate `cause: undefined`.
3. Refreshed `db-100.test.ts:2020` description from `'returns [] when FTS query throws'` (stale from silent-catch implementation) to `'throws MemoryStoreError when FTS query fails'`.

Then re-ran gates, fast-forward merged as `283fd82`, cleaned up both worktrees, and only THEN asked the user to run `/code-review max --fix`.

**Why in-session, not deferred**: CLAUDE.md §7 "Skipped → fix or memory" rule applies by analogy to verifier findings: high-severity bugs discovered by reviewers in this cycle are fixed in this session, not parked for "release later" (which the user has explicitly said "el lesz felejtve" / will be forgotten).

## Auxiliary observation

`git -C <path> <command>` does NOT run `<command>`. `git -C` only sets the working directory for the subsequent git subcommand. To run `bun tsc --noEmit` or `bun --bun vitest run` from a specific path, use `cd <path> && <command>` instead. The session hit this when `git -C /path tsc --noEmit` returned 4 (the `git tsc: command not found` help text) instead of the actual TS error count.

## Verification commands (post-merge, main checkout)

```bash
cd /Users/eggp/marveen-develop/test-baseline
bun tsc --noEmit 2>&1 | wc -l                    # → 0
bun --bun vitest run \
  src/__tests__/db.test.ts \
  src/__tests__/db-100.test.ts \
  src/__tests__/db-client.test.ts \
  src/__tests__/memory-store-error.test.ts \
  src/__tests__/memory.test.ts \
  src/__tests__/memories-routes.test.ts        # → 6 passed (6) / 329 tests passed
grep -c "^export function " src/db.ts          # → 155 (unchanged)
grep -c "^export class " src/db.ts             # → 2 (baseline 1 + MemoryStoreError)
git log -1 --format='%an <%ae>'                # → EggProjectTeams <eggprojectteams@gmail.com>
```

## Stable class forms (do not modify without careful review)

- `src/errors.ts`: abstract `AppError` base class (extends Error, centralizes `this.name = new.target.name` plumbing + abstract guard at runtime)
- `src/platform.ts`: `LazyBin<TName, TResolved>` with `makeLazyBinResolver` factory
- `src/db.ts`: `MemoryStoreError` extends `AppError`, `readonly query: string`, `constructor(query, options?: ErrorOptions)`
- `src/db.ts`: `DbClient` class (A.1 keystone) — `getHandle()` escape hatch for the 155 free-function callers

## Out of scope (deferred for A.8c or later cycles)

- `generateEmbedding` (`src/db.ts:1500-1517`) try/catch migration
- `searchAgentMemories` (`src/db.ts:396+`) try/catch migration
- `MessageBusError` / `KanbanStateError` / `ApprovalError` / `OtelSpanError` concrete subclasses
- Info-disclosure risk: `MemoryStoreError.message` contains the raw user-controlled `terms` FTS expression (H.4 precedent also does this with `limit`, so the risk is pre-existing, not introduced by this cycle)
