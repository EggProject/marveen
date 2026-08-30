# H.3 `LazyBin<TName>` — `/code-review max --fix` handoff

## Status

H.3 LANDED. Commit SHA: `f3e9ad6` (`refactor(classbase): extract LazyBin class
(H.3)`). Author: `EggProjectTeams <eggprojectteams@gmail.com>` (matches
`git config user.email`). Date: 2026-08-30. Branch `refactor/classbase`
fast-forwarded from `40a7b55` to `f3e9ad6`.

## What shipped

Four design decisions landed, all per plan
(`.claude/plans/jolly-enchanting-hearth.md:65-153`):

- **Single generic on `LazyBin`.** `class LazyBin<TName extends string =
  string>` at `src/platform.ts:76`. `TResolved` was dropped: `resolveFromPath`
  returns `string`, the `= string` default is silent, and the narrowed `TName`
  on `new LazyBin('tmux')` is the only generic that earns its keep.
- **`resolve(): string`, throws.** `src/platform.ts:82-85`. Signature is
  `string`, not `string | null`. Errors propagate via `resolver()` — the
  default `resolver` is `resolveFromPath` (`src/platform.ts:79`), which
  already throws on missing binaries (`src/platform.ts:63`). All 14
  `makeLazyBinResolver` call sites keep passing the result directly to
  `execSync` / `execFileSync` / template literals.
- **`makeLazyBinResolver` is a thin factory.** `src/platform.ts:91-94`. Body
  is `const bin = new LazyBin(name); return () => bin.resolve()`. The
  `() => string` return type is byte-compatible with the pre-state. Zero
  consumer files modified: `git diff HEAD~1 HEAD -- 'src/!platform.ts'
  'src/!__tests__'` is empty.
- **`TOP_LEVEL_RESOLVE` regex extended in the same commit.**
  `src/__tests__/platform-no-import-time-bin-resolve.test.ts:44` now
  alternates `resolveFromPath\(` with `new\s+LazyBin\(.*?\)\.resolve\(\)`.
  The HR5 regression path (`const X = new LazyBin('tmux').resolve()` at
  module scope, mimicking the 2026-08-13 CI incident) is now caught. Six
  new non-vacuity assertions added to the existing
  `'detects an offending line'` block at `:69-86` (3 positive covering
  with/without `export`/type-annotation, 3 negative covering
  factory-call-allowed, plain-constructor-no-resolve, indented-function-body).

`invalidate()` is the one new behaviour: `src/platform.ts:86-88`, sets
`cached = null`, lets tests force a fresh lookup without constructing a new
resolver.

## Verification gates passed

### Implementer's measured gates

| Gate | Observed | Threshold |
|---|---|---|
| `bun --bun vitest run` (2 platform test files) | **2 files / 18 tests passed** | 14 pre-state + 4 new = 18, all green |
| `bun --bun vitest run` (full suite) | **384 files / 11224 tests passed**, 0 fail | 11220 pre-state + 4 new = 11224, 0 fail |
| `bun tsc --noEmit` | **1729 errors** | ≤ 1730 (plan baseline); re-measured in main checkout post-merge — also 1729, confirming zero new errors attributable to the diff |

The tsc count is one below the plan baseline of 1730. Both worktree and
post-merge main checkout measured 1729, which is a benign measurement
difference (not diff-attributable). The plan's actual invariant
("≤ baseline, no new errors attributable to the diff") holds.

The vitest full-suite log contained `[WARN] capabilities: summary
generation failed` lines from the `ghost-agent` capability test fixture.
Those are intentional error-path test outputs captured by the suite
itself, not suite failures; the authoritative line is `Tests 11224 passed`.

### Verify-A (structural checklist) — PASS

10 items, all PASS with concrete `file:line` evidence. Highlights:

- **B — Class shape.** `src/platform.ts:76-89`: single generic, `readonly
  name`, `private cached`, `resolve(): string`, `invalidate(): void`. All
  present.
- **C — Factory.** `src/platform.ts:91-94`: signature unchanged; body
  delegates to the class.
- **D — `tryResolveFromPath` / `resolveFromPath` byte-identical.** The
  pre-state L48-59 (`tryResolveFromPath`) and L61-65 (`resolveFromPath`)
  appear unchanged in the post-state; `git diff` confirms only the L70-area
  comment extension, the LazyBin insertion, and the factory body swap.
- **E — Extended regex.** `src/__tests__/platform-no-import-time-bin-resolve.test.ts:44`
  contains both `resolveFromPath\(` AND `new\s+LazyBin\(.*?\)\.resolve\(\)`.
  5 LazyBin-specific assertions present (3 positive, 2 negative), meeting
  the AT LEAST 5 threshold.
- **F — `invalidate()` test.** `src/__tests__/platform-bin-resolve.test.ts:123-132`
  asserts `toHaveBeenCalledTimes(2)` — the specific count is the load-bearing
  assertion.
- **G — Extended no-I/O test.** `src/__tests__/platform-bin-resolve.test.ts:88-96`
  exercises both `makeLazyBinResolver('claude')` and `new LazyBin('claude')`.
- **H — Consumer zero-touch.** `git diff HEAD~1 HEAD -- 'src/!platform.ts'
  'src/!__tests__'` is empty. 14 call sites in 12 files, same as pre-state.
- **J — Vacuous-test probe.** Stubbing `invalidate()` to a no-op would
  leave `cached` populated, so the second `resolve()` would not call
  `execSync`, and `toHaveBeenCalledTimes(2)` would FAIL at actual 1. The
  test is not vacuous.

### Verify-B (adversarial falsification) — PASS

10 probes, all PASS. Highlights:

- **1 — Closure behaviour preservation.** Live-import probe
  (`/Users/eggp/claw-verify-b-h3/probe.ts`): `makeLazyBinResolver` factory
  still returns a `function`; `.call()` returns `string` when binary
  exists; throws `Required binary not found` when missing.
- **2 — LazyBin class direct usage.** `new LazyBin('tmux').resolve()`
  returns the binary path; missing binary throws; `invalidate()` causes
  re-resolution (resolver called 2x post-invalidate, value flips);
  injected `resolver` arg routes through; `bin.name` field accessible.
- **3 — Independent caches.** Two `new LazyBin(..., distinct_resolver)`
  instances each call their own resolver exactly once; invalidating `a`
  does not re-call `b`'s resolver.
- **6 — `TResolved` absence.** `grep -n "TResolved" src/platform.ts`
  returns zero matches.
- **7 — Author identity.** `git log -1 --format='%an <%ae>' f3e9ad6`
  returns `EggProjectTeams <eggprojectteams@gmail.com>`, matching
  `git config user.email`. No Claude/anthro commit.
- **9 — No production migration.** `grep -rn "new LazyBin" src/ --include='*.ts'
  | grep -v __tests__/ | grep -v src/platform.ts:` returns zero matches.
  All production consumers continue calling `makeLazyBinResolver`.

No FAILs from either verifier. The non-vacuity boundary (CLAUDE.md §7
precedent) is satisfied for both the `invalidate()` test and the
extended regex self-test.

## User action required

The plan reserves a fourth phase — `Review` — for the
`/code-review max --fix` skill. That skill carries the
`disable-model-invocation` flag (CLAUDE.md §8: "CSAK a user hívhatja
manuálisan a terminálban. NE próbálkozz a Skill tool-lal"). The Skill tool
would refuse the invocation; this doc does not attempt it.

**Run in the terminal:**

```
/code-review max --fix
```

What to expect:

- The skill operates on the current working diff (i.e. H.3 against the
  current branch HEAD `f3e9ad6`).
- Findings are graded by effort level: `max` is the broadest sweep and
  may include uncertain findings. Each finding carries a
  `file:line:summary` shape and a failure scenario.
- If the review produces actionable findings, the `--fix` flag applies
  them as one or more follow-up commits on top of `f3e9ad6`. Do NOT
  re-invoke `/code-review max --fix` from this session — the skill
  itself is the only thing that creates the follow-up commit(s).
- If the review returns zero findings, no commit is produced; `refactor/classbase`
  stays at `f3e9ad6` and H.3 is closed.

This handoff is the bridge between the in-session verifiers (A and B
both PASS) and the user-invoked review. The Skill tool refuses; this
doc refuses-by-design.

## If review finds issues

A follow-up commit will be created by the user invoking the skill. Expected
scope per CLAUDE.md §8 and the plan rollback section
(`.claude/plans/jolly-enchanting-hearth.md:286-291`):

- **Single commit, fast-forward-able.** H.3 is one commit on `refactor/classbase`.
  Any fix lands on top; rollback is `git revert <fix-sha>` (no history
  rewrite).
- **No consumer migrations.** Review findings that would touch one of the
  11 `makeLazyBinResolver` consumer files are out of scope for H.3 —
  those belong to F.7 (`ClaudeCodeBinResolver extends LazyBin<'claude'>`),
  which is gated on H.3 and lands in a later cycle.
- **No test-suite churn.** The two existing platform test files
  (`platform-bin-resolve.test.ts`, `platform-no-import-time-bin-resolve.test.ts`)
  are the only test files in scope; new tests in other files are
  out of scope.
- **No production wiring changes.** `LazyBin` is production-isolated by
  design #4: zero production migration in H.3. The skill may flag this
  as documentation-fraud-style findings if it sees the test file but
  no production caller — that is the correct shape, not a defect.

If a finding proposes expanding H.3's scope, document the request as a
separate backlog item rather than expanding the diff in the review
follow-up commit. Plan-deferred items are listed in the next section.

## What was NOT in scope

Per plan (`.claude/plans/jolly-enchanting-hearth.md:295-306`):

- **`F.7 ClaudeCodeBinResolver extends LazyBin<'claude'>`.** Gated on H.3,
  lands in a later cycle. `f-agent-subsystem/05-refactor-roadmap.md:330`.
- **Migrating the 11 `makeLazyBinResolver` consumer files** to
  `new LazyBin(...).resolve()` form. HR5 Mitigation 4 explicitly defers
  this; it is not part of H.3. Per `00-summary.md:48-55`, the 14 call
  sites in 11 files keep calling the factory.
- **`index.ts:283` off-by-one comment.** Belongs to H.1 (`LoggerLike`)
  scope; the comment annotates the pino→`LogFn` adapter path. H.3 does
  not touch the adapter. Deferred to H.1.
- **`F.5 AutoRestartSchedule`.** Parallel candidate
  (`f-agent-subsystem/05-refactor-roadmap.md:227`), can run alongside or
  after H.3 in a future cycle. User picked H.3 because it has the
  smallest blast radius.
- **H.1 (`LoggerLike`), H.2 (per-class injection), H.4 (`AppError`),
  H.5 (singleton removal).** Independent phases, not gated on H.3.
  H.1 and H.2 touch different files (`src/logger.ts`, `src/process-lock.ts`,
  `src/index.ts`); H.4 introduces a new `src/errors.ts`.
- **`PLATFORM` constant at `src/platform.ts:24`.** Single production
  consumer (`web/claude-credentials-guard.ts:6`). Converting it is churn,
  deferred per `00-summary.md:58-61`.
- **Refactor of `tryResolveFromPath` / `resolveFromPath`** as free
  functions. They are pure and stay free; `LazyBin` composes over them.
  Per `00-summary.md:62-66`.

H.3 is closed at the in-session verification level (Implement + Verify-A +
Verify-B all PASS). Closure at the project level is the user's terminal
invocation of `/code-review max --fix`.
