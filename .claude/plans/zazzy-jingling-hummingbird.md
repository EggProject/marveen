# Cycle 37 — agent-worker: try/catch wrap + array coerce (combined)

## Context

`docs/needs-to-be-fix/INDEX.md` lists ~32 still-open MDs. The two
candidate items for this cycle both touch `src/web/agent-worker.ts` and
share the same pinning-test file, so they can be combined into one
audit-bounded commit batch with no risk of cross-fix interaction:

- **`agent-worker-ensure-ready-throw`** (orphan-addenda row 105, `—`) —
  `ensureWorkerReady` calls `startWorkerSessionFor(ctx)` at line **595**
  with no try/catch wrap; the sibling call inside `restartWorkerSession`
  at line **621** IS wrapped identically. Real bug: a tmux outage
  during a boot poll kills the caller's `await runAgent(...)` with a
  raw `execFileSync` rejection instead of returning
  `{ text: null, error: '...' }`.

- **`agent-worker-array-claude-json`** (orphan-addenda row 103, `—`) —
  `ensureWorkerCwd`'s `.claude.json` materialise block (lines 405-422)
  coerces a non-existent host file to `{}` but accepts an array-valued
  host file as-is. `JSON.stringify` on an array returns `'[]'`, silently
  dropping every property `stampWorkerFirstRun` sets. Real bug: worker
  boots, parks on first-run modal, no error reported.

Both follow the same gold-standard pattern the project has used for
~30 cycles (most recent: `537b374` web-inbound-probe-cache-sticky,
`8d7f612` channel-poller-reap, `99f56c1` recall-dayofweek). Both have
pinning tests already in the suite that document CURRENT (buggy)
behaviour; the fix is the source change + test-assertion inversion,
with no new test infrastructure.

Intended outcome: both defects disappear, both pinning tests assert
the new behaviour, both INDEX rows flip to `Resolved: <date> <sha>`,
full suite green, typecheck unchanged. `git push` is not invoked —
user pushes.

## Head state verified at start of plan

`git status` clean; HEAD `99f56c1 refactor(recall): replace hand-rolled
zonedNoon with luxon DateTime (#recall-dayofweek-noon-utc-far-east-skew)`
on `test/baseline`.

Direct source reads (cited for the verifier):

- `src/web/agent-worker.ts:587-610` — `ensureWorkerReady` body.
  **Line 595** reads `startWorkerSessionFor(ctx)` with no wrapper.
  (MD heading says `:596`; the actual unwrapped call is at 595.)
- `src/web/agent-worker.ts:612-622` — `restartWorkerSession` body.
  **Line 621** reads
  `try { startWorkerSessionFor(ctx) } catch (err) { logger.warn({ err, session: ctx.session }, 'agent-worker: restart failed') }`
  — the exact pattern fix A mirrors. (MD heading says `:622`; actual is 621.)
- `src/web/agent-worker.ts:405-422` — `.claude.json` materialise block.
  **Line 407-408** reads the `parsed` declaration with no coercion
  of array-valued raw.
- `src/web/agent-worker.ts:438` — `stampWorkerFirstRun` signature;
  mutates parsed in place, no return.
- `src/web/agent-worker.ts:716-720` — `runViaWorker` return type
  `Promise<{ text: string | null; error?: string; authFailed?: boolean }>`.

Direct test reads:

- `src/__tests__/agent-worker-full.test.ts:608-619` —
  "handles an array-valued host .claude.json (current behaviour:
  silently no-op the trust stamp)". Asserts
  `readFileSync(join(cfg, '.claude.json'), 'utf-8')).toBe('[]\n')` —
  the current buggy output.
- `src/__tests__/agent-worker-full.test.ts:644-653` —
  "handles a host .claude.json whose projects field is an array".
  Asserts `Array.isArray(dot.projects)).toBe(true)` — left untouched
  by fix B (we are not touching the inner projects guard).
- `src/__tests__/agent-worker-full.test.ts:1292-1320` —
  "warns and continues when the restart start throws (current
  behaviour: error propagates)". Asserts
  `await expect(AW.runViaWorker('hi', 100)).rejects.toThrow('tmux gone')`
  and `logs.some(...includes('restart failed'))`.

Direct INDEX verification:

- Line 103: `agent-worker-array-claude-json` → `Resolved` column `—`.
- Line 105: `agent-worker-ensure-ready-throw` → `Resolved` column `—`.

## Critical files

- `src/web/agent-worker.ts` — two surgical edits (one per fix).
- `src/__tests__/agent-worker-full.test.ts` — two pinning-test
  assertion inversions (one per fix).
- `docs/needs-to-be-fix/INDEX.md` — flip both rows in the Orphan
  addenda table.

NOT TOUCHED:

- `src/web/agent-worker.ts:438` — `stampWorkerFirstRun` is unchanged.
- `src/web/agent-worker.ts:410-413` — the inner `projects` guard is
  unchanged (fix B addresses only the top-level shape; the
  projects-array case requires option (c) and is reserved for a
  future cycle).
- `src/__tests__/agent-worker-full.test.ts:644-653` — pinning test for
  the projects-array case is left as-is (its behaviour is unchanged).
- `src/web/agent-worker.ts:621` — the existing pattern we mirror stays
  exactly as written.

## Changes

### Edit 1 — fix B source (array coerce, applied FIRST)

**Why B first:** fix B is strictly more isolated (one function, one
file-content assertion). Fix A touches the `runViaWorker` integration
path and benefits from running on top of a stable tree.

Replace `src/web/agent-worker.ts:407-408`:

```ts
    const parsed: { projects?: Record<string, unknown>; hasCompletedOnboarding?: boolean; [k: string]: unknown } =
      existsSync(homeClaudeJson) ? JSON.parse(readFileSync(homeClaudeJson, 'utf-8')) : {}
```

with:

```ts
    // Coerce a non-object host .claude.json (array, null, bare scalar) to {}:
    // JSON.stringify on an array serialises only numeric indices, so every flag
    // stamped below would be dropped silently and the worker would park on a
    // first-run modal with nothing logged.
    const raw = existsSync(homeClaudeJson) ? JSON.parse(readFileSync(homeClaudeJson, 'utf-8')) : {}
    const parsed: { projects?: Record<string, unknown>; hasCompletedOnboarding?: boolean; [k: string]: unknown } =
      (raw && typeof raw === 'object' && !Array.isArray(raw)) ? raw : {}
```

Rationale: option (a) from the MD — coerce non-object values to `{}`.
`Array.isArray` is the only structural check needed because every
plain-object value (and `null`) is filtered out by `typeof ===
'object' && !Array.isArray`. The intermediate `raw` variable MUST
stay **unannotated** so it remains `any`; annotating it `: unknown`
breaks the build (TS does not narrow `unknown` through
`Array.isArray` into a type with an index signature — verified by
precedent at `src/web/model-fallback-runner.ts:58-60` and
`src/web/heartbeat.ts:139`, both of which use cast forms that this
project's CLAUDE.md §7 forbids). The unannotated form is the same
shape used at `src/settings-store.ts:22-25` and typechecks cleanly.

Behavior change beyond arrays: a `null` host file (e.g. `JSON.parse
('null')`) currently throws inside `stampWorkerFirstRun(null)` and is
swallowed by the catch at `:420` — no worker `.claude.json` is
written. After the fix a correct file IS written. This is strictly
better; no existing test pins the old "null → silent skip" behaviour
(the only such test, `agent-process.test.ts:839`, targets
`agent-process.ts`, a different module). Worth stating in the commit
body.

### Edit 2 — fix B's test inversion (IN THE SAME COMMIT as edit 1)

The pinning test at `src/__tests__/agent-worker-full.test.ts:608-619`
goes RED when fix B is applied (the `'[]\n'` output disappears).
Invert it as part of the fix commit, NOT in a follow-up — the commit
must be green or it is rejected.

Replace `src/__tests__/agent-worker-full.test.ts:608-619`:

```ts
  it('handles an array-valued host .claude.json (current behaviour: silently no-op the trust stamp)', () => {
    writeFileSync(join(H.home, '.claude.json'), '[]')
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    // Pin the CURRENT (buggy) behaviour: JSON.stringify on an array only
    // serialises numeric-indexed elements, so any properties added by
    // stampWorkerFirstRun are dropped. The worker ends up with an empty
    // .claude.json and the first-run modal will reappear. See bug MD for
    // the direction (replace the JSON round-trip with a structuredClone of
    // the parsed object, or pre-coerce non-object parsed values to {}).
    expect(readFileSync(join(cfg, '.claude.json'), 'utf-8')).toBe('[]\n')
  })
```

with:

```ts
  it('coerces an array-valued host .claude.json to an object so the trust stamp survives', () => {
    writeFileSync(join(H.home, '.claude.json'), '[]')
    AW.ensureWorkerCwd()
    const cfg = join(H.home, '.marveen-worker', '.claude-config')
    // A non-object host file is coerced to {} before stamping. Without that,
    // JSON.stringify on the array serialises only numeric indices and every
    // flag is dropped, parking the worker on a first-run modal with no error.
    const dot = JSON.parse(readFileSync(join(cfg, '.claude.json'), 'utf-8'))
    expect(dot.hasCompletedOnboarding).toBe(true)
    expect(dot.projects[join(H.home, '.marveen-worker')].hasTrustDialogAccepted).toBe(true)
  })
```

Critical detail: the assertion checks
`dot.projects[join(H.home, '.marveen-worker')]`, NOT `dot.projects ===
{}`. After the fix, the `projects` map is populated by the loop at
`agent-worker.ts:415-417` (`for (const k of keys) projects[k] = {
...trusted }`) with `keys = new Set([ctx.home])` plus possibly
`realpathSync(ctx.home)`. The default `ctx.home` for the test suite
is `join(H.home, '.marveen-worker')` per
`__tests__/setup/agent-worker-harness.ts`. The trust-stamped object
has `{ hasTrustDialogAccepted: true, hasCompletedProjectOnboarding:
true, projectOnboardingSeenCount: 1 }`, so
`.hasTrustDialogAccepted === true` is the cheapest stable assertion.

Note: CLAUDE.md §7 mandates every bug be covered by a test after
fixing ("hogy újra ne fordulhasson elő"). The inverted test name
retains the regression coverage; deleting the assertion would drop
the pin. Inversion is correct, not deletion.

### Edit 3 — fix A source (try/catch wrap)

Replace `src/web/agent-worker.ts:595`:

```ts
  startWorkerSessionFor(ctx)
```

with:

```ts
  // Mirrors the restartWorkerSession guard below: a tmux outage during the boot
  // poll must degrade to a not-ready result, not reject the caller's await with
  // a raw tmux error. runWorkerAttempt turns false into a structured
  // 'worker session not ready' that runViaWorker retries once.
  try {
    startWorkerSessionFor(ctx)
  } catch (err) {
    logger.warn({ err, session: ctx.session }, 'agent-worker: startWorkerSessionFor failed; treating as not-ready')
    return false
  }
```

Rationale: identical to the existing wrap at line 621 (same function
name in the warn log, same `ctx.session` field, same `logger.warn`
sink). The warn message matches the suggestion at
`agent-worker-ensure-ready-throw.md:76` so doc and code agree.
Returning `false` lets `ensureWorkerReady`'s caller
(`runWorkerAttempt` at `:650`) fall through to its `!ready` branch
(`:651-657`), which calls `workerPaneHasAuthFailure` → `{kind:
'fail', error: 'worker session not ready'}` (or `{kind: 'auth'}` if
the pane contains the auth-failure chrome — see the test trace
below). `runViaWorker`'s retry-once branch (`:727-738`) then calls
`restartWorkerSession` (whose own `try/catch` swallows the throw at
`:621`); on attempt 1 the new catch returns `false` again and the
loop exits with `{text: null, error: '...'}` — the structured-failure
shape the original throw was bypassing.

Sub-risk addressed: `!ready` calls `workerPaneHasAuthFailure` →
`capturePane`, both of which catch all errors and return
null/false. The fix cannot leak a second throw.

### Edit 4 — fix A's test inversion (IN THE SAME COMMIT as edit 3)

The pinning test at `src/__tests__/agent-worker-full.test.ts:1292-1320`
goes RED when fix A is applied (the `'tmux gone'` rejection
disappears). Invert it as part of the fix commit.

Replace `src/__tests__/agent-worker-full.test.ts:1292-1320` (rename
the `it` to drop the `(current behaviour: error propagates)` suffix,
rewrite the stale block comment, replace the assertion at line 1318):

```ts
  it('warns and continues when the restart start throws', async () => {
    // After fix: ensureWorkerReady catches startWorkerSessionFor's throw,
    // logs "treating as not-ready", and returns false. runWorkerAttempt
    // sees false and returns {kind:'auth'} because the captured pane still
    // matches the auth-failure chrome; runViaWorker's attempt 1 terminal
    // returns {text: null, error: 'worker auth failed (401/login) after
    // recovery', authFailed: true} (agent-worker.ts:747-749). The mock's
    // n === 1 succeeds (consumed by ensureWorkerReady on attempt 0),
    // n === 2 throws (consumed by restartWorkerSession's catch, logged as
    // "restart failed"), n === 3 throws (consumed by ensureWorkerReady's
    // new catch on attempt 1, logged as "treating as not-ready").
    H.isSessionReadyForPrompt.mockResolvedValue(true)
    H.capturePane.mockReturnValue(
      Array.from({ length: 35 }, (_, i) => i === 34 ? 'Please run /login' : 'x').join('\n'),
    )
    H.sessionExistsOnHost.mockReturnValue(false)
    let n = 0
    H.execFileSync.mockImplementation((file: string, args: string[]) => {
      const argv = [String(file), ...(args as string[])].join(' ')
      if (argv.includes('new-session')) {
        n++
        if (n === 1) return ''
        throw new Error('tmux gone')
      }
      return ''
    })
    const out = await AW.runViaWorker('hi', 100)
    expect(out.authFailed).toBe(true)
    expect(out.text).toBeNull()
    expect(H.logs.some((l) => String(l.msg).includes('restart failed'))).toBe(true)
    expect(H.logs.some((l) => String(l.msg).includes('treating as not-ready'))).toBe(true)
  })
```

The block comment also corrects the existing test's misattribution of
which call consumes `n === 1` — that comment in the source today
claims `n === 1` is the recovery's restart; in fact it is the
`ensureWorkerReady` call on attempt 0. The fix's correct trace is in
the new comment.

## Commit structure (3 commits, in this order)

Per cycle 36 pattern (2 commits per fix: source change + INDEX flip),
collapsed to 3 commits because the two source commits land in
immediate sequence on the same file. Branch precedent: every prior
agent-worker resolution on `test/baseline` (`911de24`, `2e9ab6f`,
`a58a811`) is one source commit per bug ID; the INDEX flip must
follow because the row records the source-commit SHA which does not
exist until the source commit is made.

1. **Commit 1** — `fix(agent-worker): coerce a non-object host .claude.json to {} before stamping (#agent-worker-array-claude-json)`
   - Body: `Resolves: docs/needs-to-be-fix/agent-worker-array-claude-json.md`
   - Touches: `src/web/agent-worker.ts` (edit 1), `src/__tests__/agent-worker-full.test.ts` (edit 2).

2. **Commit 2** — `fix(agent-worker): catch startWorkerSessionFor throws in ensureWorkerReady (#agent-worker-ensure-ready-throw)`
   - Body: `Resolves: docs/needs-to-be-fix/agent-worker-ensure-ready-throw.md`
   - Touches: `src/web/agent-worker.ts` (edit 3), `src/__tests__/agent-worker-full.test.ts` (edit 4).

3. **Commit 3** — `docs(needs-to-be-fix): mark agent-worker-array-claude-json + agent-worker-ensure-ready-throw Resolved`
   - Touches: `docs/needs-to-be-fix/INDEX.md` — flip the `Resolved`
     column for both rows from `—` to
     `Resolved: 2026-08-20 <sha-of-commit-1>` and
     `Resolved: 2026-08-20 <sha-of-commit-2>`. Precedent for a single
     INDEX flip commit covering multiple rows: `8847812 docs(INDEX):
     add 'Resolved:' prefix to 4 orphan addenda rows`.
   - Do NOT amend the source commits afterward — INDEX SHAs become
     stale (this is why `8d7f612` and `0391bd6` exist as
     "fix Resolved SHA reference after amend" commits).

## Branch workflow

**MUST use a git worktree** — `src/__tests__/setup/assert-not-live-install.ts:66-76`
aborts every test run when `store/claudeclaw.db` exists in the worktree
the suite is launched from. The current checkout has that file
(20 KB, mtime 2026-08-20; sqlite3 confirms 0 rows in `conversation_log`,
no process holds it, `store/` is gitignored per `.gitignore:11`).
Cycle 36 used a worktree for the same reason; cycle 37 follows the
same pattern.

```bash
git worktree add /tmp/claw-cycle37 test/baseline
cd /tmp/claw-cycle37
```

All edits, the pinning-test runs, and the full-suite verification
execute in `/tmp/claw-cycle37`. The commits land on `test/baseline`
in the shared repo's branch state (worktree commits are first-class
git commits on the branch they were checked out from). When the work
is done, return to the original checkout — `git worktree remove
/tmp/claw-cycle37` (or `--force` if dirty) cleans up.

- 3 commits in sequence (1, 2, 3), authored in the worktree.
- Return to `test/baseline` in the original checkout. The new SHAs
  are visible via `git log --oneline -5` in either checkout. No
  branch switch. No `git push`.
- After `git worktree remove /tmp/claw-cycle37`, the worktree is
  gone but the commits remain on `test/baseline`.

## Reused utilities / patterns

- Try/catch wrap pattern: verbatim copy of `agent-worker.ts:621`.
- Array coerce pattern: same shape as
  `src/web/kanban-dispatch.ts:34` and `src/web/agent-scaffold.ts:129`
  (both use `Array.isArray` to gate object-typed branches).
- Test inversion shape: rename `it`, rewrite block comment to state
  the new contract, replace the assertion.
- Commit message style: `fix(agent-worker):` prefix matching recent
  commits `99f56c1`, `537b374`, `8d7f612`, `911de24`, `2e9ab6f`,
  `a58a811`.

## Verification

Run from the repo root, in order. Steps 1, 2 happen in the original
checkout (read-only). Steps 3-12 happen in `/tmp/claw-cycle37`.

1. `git worktree list` — confirm only the two existing worktrees
   (`marveen` on `feature-develop`, `test-baseline` on `test/baseline`).
2. `ls store/claudeclaw.db` — confirm the file is present in the
   original checkout's `store/`. (It is, per the cycle-36 baseline;
   this step is just a sanity print.)
3. `git worktree add /tmp/claw-cycle37 test/baseline` — create the
   fresh worktree from `test/baseline`. The new worktree has NO
   `store/` directory, so the live-install guard will NOT abort.
4. `cd /tmp/claw-cycle37 && bun --bun vitest run src/__tests__/agent-worker-full.test.ts`
   — must be green at HEAD before any edit (baseline check).
5. Record baseline typecheck counts:
   - `bun run typecheck 2>&1 | grep -c "error TS"` = **1699** (cycle
     36/37 baseline; concentrated in test files). Use `grep -c
     "error TS"` not `wc -l` — `wc -l` counts multi-line error
     elaborations too and inflates the number.
   - `bun run typecheck 2>&1 | grep -c "^src/web/agent-worker.ts"` =
     **0** (this file is at 0 errors today; any non-zero delta after
     the fix is a regression).
   - `bun run typecheck 2>&1 | grep -c
     "^src/__tests__/agent-worker-full.test.ts"` = **0** (same).
6. Apply edit 1 + edit 2 (fix B source + test inversion TOGETHER —
   pinning test goes RED without the inversion). Run pinning test
   (`bun --bun vitest run src/__tests__/agent-worker-full.test.ts`),
   confirm `agent-worker-full.test.ts:608` ("coerces an array-valued
   host .claude.json...") now passes with the new assertion. Run
   typecheck, all three counts unchanged. **Commit 1.**
7. Apply edit 3 + edit 4 (fix A source + test inversion TOGETHER —
   pinning test goes RED without the inversion). Run pinning test
   (same file), confirm `agent-worker-full.test.ts:1292` ("warns and
   continues when the restart start throws") now passes. Run
   typecheck, all three counts unchanged. **Commit 2.**
8. Run the neighbours explicitly to catch any cross-test fallout:
   - `agent-worker.test.ts`
   - `agent-worker-symlink-catch.test.ts`
   - `worker-firstrun-cc202.test.ts`
   - `agent-run-paths.test.ts`
   - `worker-selfheal.test.ts`
   - `dual-worker.test.ts`
   - `worker-liveness*.test.ts`
9. Flip `INDEX.md:103` and `:105` to `Resolved: 2026-08-20 <sha>`
   using the two real SHAs from commits 1 and 2. Do NOT amend the
   source commits. **Commit 3.**
10. `bun --bun vitest run` — full suite must remain green (cycle 36
    baseline: 382 files / 11129 tests; 0 failed, 0 skipped).
11. `bun run typecheck 2>&1 | grep -c "error TS"` — must equal step
    5's count of 1699. The two per-file counts must still be 0.
12. `git log --oneline -5` — three new commits on top of `99f56c1`,
    all with `fix(agent-worker):` or `docs(needs-to-be-fix):` prefix.
13. `/code-review max --fix HEAD~3..HEAD` — apply skill; report
    findings; any follow-up commits land on the same branch.
14. `cd <original-checkout> && git worktree remove /tmp/claw-cycle37`
    — clean up the worktree. The commits remain on `test/baseline`.
15. Branch stays on `test/baseline`; `git status` clean; no `git push`.

## Risk: 2/10

- Code risk: trivial. Two surgical edits in two distinct functions
  of the same file. Fix A mirrors an existing pattern verbatim; fix
  B is option (a) from the MD (the most-conservative of the three
  suggested directions).
- Test risk: low — pinning-test assertions invert to assert the
  new (correct) behaviour. The test commit and the source commit
  are coupled (a fix without the inversion leaves the tree red).
- Type-check risk: zero — fix B's `raw` is unannotated (so `any` is
  inferred, the same shape as `src/settings-store.ts:22-25`); fix
  A's `return false` matches the existing return contract.
- Coverage risk: neutral — neither fix creates or removes a branch
  the suite was previously missing; both arms of the affected
  conditionals are now reached on existing test inputs.
- CI gate risk: none — both fixes are within `src/web/agent-worker.ts`
  whose 100% gate is the most-exercised in the suite.
- Process risk (the only reason it is not 1/10): the
  `store/claudeclaw.db` gitignore assumption must be re-verified at
  execution start (cycle 36's worktree-requirement caveat).

## Out of scope (deferred)

- `agent-worker-settings-symlink-preserve` — different defect in the
  same file (5-line fix, requires real-symlink test setup; reserved
  for cycle 38).
- `web-agent-worker-runviaworker-coverage` — coverage-only;
  addressed indirectly by this cycle (the array-coerce test now
  exercises a previously-untested arm).
- All other unresolved MDs (High / Medium severity) — larger scope,
  pinning-test infrastructure, or real-host verification needed.
  Reserved for explicit per-MD planning cycles.
- MD hygiene (the `agent-worker-array-claude-json.md:88` reference
  to `src/__tests__/web-inbound-probe.test.ts` does not exist;
  the test file is `src/__tests__/agent-worker-full.test.ts`; the
  MD line numbers are one stale everywhere) — per CLAUDE.md §3,
  not edited in this fix.

## Post-commit

After commit 3 lands on `test/baseline`, run:

```
/code-review max --fix HEAD~3..HEAD
```

The skill auto-applies safe follow-ups. Findings and any follow-up
commits land on the same branch. No push — `git push` is the user's
decision.

After `/code-review max --fix` returns, surface the next cycle's
candidates (`agent-worker-settings-symlink-preserve`,
`index-unreachable-coverage`,
`heartbeat-brief-rundiceaysweep-not-applicable`, etc.) for user
selection via `AskUserQuestion` per the Honcho standing rule
("what's next is identification, not apply").
