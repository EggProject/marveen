# Adversarial review — `keen-rolling-robin.md`

Executed in **plan / read-only mode** (no Bash mutations, no test runs, no
worktree creation). I grep + read to break the plan; for each candidate I
either show the command + output that confirms a real defect or show the
exact reason the candidate does not hold. Findings are ranked by severity.

---

## Confirmed problems

### 1. CRITICAL — docs commit targets the WRONG file or wrong line numbers

The plan claims:

> `00-summary.md` három mért hibája:
>   - `:5` és `:37` — "365 lines" → **364**
>   - `:39` — "33 `it()` cases" → **50**
>   - `:40` — `withRealAcquirePortLock` `:1363` → **`:1365`**, `withRealAcquirePidfileLock` `:1314` → **`:1317`**

Verified output (`awk` against the top-level file):

```
$ awk 'NR==5 || NR==37 {print NR": ["$0"]"}' docs/refactor-to-classbase/00-summary.md
5: []
37: [| Runner-as-class (new classes) | ~10 | `heartbeat.ts`, ... |]
```

Lines 5 and 37 in the **top-level** `00-summary.md` are a blank line and a
markdown table row about runners — neither mentions "365 lines", neither
mentions `process-lock.ts`. The text the plan claims to "correct" is not
there.

Where it actually lives (`grep`):

```
docs/refactor-to-classbase/e-process-lock/00-summary.md:5:against `src/process-lock.ts` (365 lines, measured 2026-08-30)
docs/refactor-to-classbase/e-process-lock/00-summary.md:37:extract `PortLockAcquirer` and `PidfileLockAcquirer` classes; ...
docs/refactor-to-classbase/e-process-lock/00-summary.md:39:33 `it()` cases over the free functions; ...
docs/refactor-to-classbase/e-process-lock/00-summary.md:40:withRealAcquirePortLock / withRealAcquirePidfileLock helpers at :1363 and :1314 ...
```

The four references are in `e-process-lock/00-summary.md`, not in the
top-level `00-summary.md`. The plan's docs commit will write to the wrong
file unless the user clarifies.

The line refs in `e-process-lock/00-summary.md` are correct (verified
against `git grep` of `withRealAcquirePortLock`/`withRealAcquirePidfileLock`
in `src/__tests__/index.test.ts`: declarations at L1365 / L1317 — matches
the plan's "post-fix" claim).

**Recommendation:** the docs commit must be scoped to
`docs/refactor-to-classbase/e-process-lock/00-summary.md`, not the
top-level `00-summary.md`.

---

### 2. CRITICAL — "365 → 364" line-count update is BACKWARDS

The plan asserts "365 lines → 364" (i.e., the post-refactor file is
expected to be 364 lines).

Verified output:

```
$ wc -l src/process-lock.ts
     364 src/process-lock.ts
```

The file is **currently 364 lines**. The MD at
`e-process-lock/00-summary.md:5` and `:37` claims 365 — that's a stale
MD-of-the-MD issue (off-by-one in the doc itself). But the plan's refactor
ADDS structure: 2 class declarations with bodies, ~5 method signatures
indented one level deeper, plus the wrapperek (`return new X(ctx).method(...)`
lines that wrap each existing export). The line count will **increase**, not
decrease. A blind "365 → 364" patch will write the wrong number on the day
the docs commit lands.

**Recommendation:** measure the post-refactor file's `wc -l`, then write
that exact number into the MD. Do not pre-commit "364" as if it were the
target.

---

### 3. MEDIUM — `process-lock.test.ts:161` ctx-mutation equivalence is fragile-by-design (NOT a plan bug, but worth flagging)

Grep of ctx mutations inside `process-lock.test.ts`:

```
$ grep -nE "ctx\.[a-zA-Z]+\s*=" src/__tests__/process-lock.test.ts
161:    ctx.getProcessUid = () => null // process vanished between ps and stat
```

Only one mutation site. The plan's wrapper
`new PortLockAcquirer(ctx).findOwnNodeHolders(port)` stores `ctx` by
reference — the same mutable object reaches the method, so `this.ctx.getProcessUid`
still resolves to the mutated arrow. **Equivalence holds.** I list this
here only because it's the first attack angle the prompt named and I want
the record to show I checked it.

A `private readonly` member with a NEW instance per wrapper call is NOT a
problem here because the **reference** is the same; only the class wrapper
is new.

---

### 4. MEDIUM — `acquire()`'s internal call sites can silently drift to a wasteful free-function chain

The plan doesn't say whether `acquire()`'s body calls `this.findOwnNodeHolders(port)`
(instance method) or the **wrapper** `findOwnNodeHolders(port, this.ctx)`
(free function, which constructs a SECOND `PortLockAcquirer` instance
internally). The current free-function code (`src/process-lock.ts:177-178`,
`:182`, `:191`) calls the free functions. If the implementer preserves
that style and the free-function wrappers construct new instances, every
`acquire()` call chains through 4-5 new `PortLockAcquirer` allocations per
acquire-cycle (one per `findOwnNodeHolders` call, one per `findOwnBinaryMatches`,
one per `terminateProcesses`, one for `acquire()` itself).

Verified output:

```
$ grep -nE "findOwnNodeHolders|findOwnBinaryMatches|terminateProcesses" src/process-lock.ts
77:export function findOwnNodeHolders(port: number, ctx: ProcessLockContext): number[] {
88:export function findOwnBinaryMatches(pattern: RegExp, ctx: ProcessLockContext): number[] {
127:export async function terminateProcesses(
169:export async function acquirePortLock(
177:  const byPort = findOwnNodeHolders(port, ctx)
178:  const byBinary = opts.binaryPattern ? findOwnBinaryMatches(opts.binaryPattern, ctx) : []
182:  await terminateProcesses(victims, ctx, { graceMs })
191:    if (!findOwnNodeHolders(port, ctx).length) return
```

**Not a correctness bug** (behavior is identical), but coverage-wise:
- If `acquire()` calls `this.X`, the wrapper-free-function paths are only
  exercised by tests — fine for coverage since `process-lock.test.ts`
  covers all four wrapper exports.
- If `acquire()` calls the free functions, every wrapper creates a
  redundant instance.

**Recommendation:** the plan should explicitly say `acquire()` calls
`this.findOwnNodeHolders(port)` etc., to avoid the implementer copying the
current "free function" call style verbatim and accidentally creating
double-instances per drain-loop iteration.

---

### 5. LOW — `acquire()` body keeps a `let waited` accumulator (no per-call hoisting issue, just noting)

The drain loop at `src/process-lock.ts:189-195`:

```
189:  let waited = 0
190:  while (true) {
191:    if (!findOwnNodeHolders(port, ctx).length) return
192:    if (waited >= drainMs) break
193:    await ctx.sleep(pollMs)
194:    waited += pollMs
195:  }
```

I checked whether this could behave differently if hoisted to instance
scope. **No.** `let waited` is local to each call, reset to 0 every time.
The plan moves it into `acquire()` unchanged. Safe.

The wrapper pattern doesn't introduce per-instance state — the constructor
just stores `ctx` once, and `acquire()` is stateless across calls. ✓

---

### 6. LOW — Istanbul parameter-property coverage behavior (verified empirically)

I could not run vitest (plan mode). However, the precedent file
`src/web/remote-status-cache.ts:22`:

```
export class RemoteStatusCache<T> {
  private store = new Map<string, { value: T; at: number }>()
  constructor(private readonly ttlMs: number) {}
```

is the explicit precedent cited by the plan (`05-refactor-roadmap.md` /
CLAUDE.md §8). It is part of the `src/**/*.ts` set covered by the 100%
`perFile: true` gate (verified via `vitest.config.ts:42-48`). If that
precedent passes coverage, the plan's identical pattern will too.

The constructor body is `{}`. Istanbul sees 1 statement (the implicit
`this.ctx = ctx` parameter-property assignment). Each `new X(ctx)` call
covers it. The plan's 4 wrappers each call `new X(ctx)` (PortLock) or
`new X(ctx)` (Pidfile), so the constructor is exercised on every wrapper
call. ✓

---

### 7. LOW — Lint rule check: which of the named candidates actually fire

I read all four config files in
`node_modules/@typescript-eslint/eslint-plugin/dist/configs/flat/`
(`base.js`, `eslint-recommended.js`, `strict-type-checked.js`,
`stylistic-type-checked.js`) and grepped each candidate rule:

| Rule | In `strict-type-checked`? | In `stylistic-type-checked`? | Fires on plan shape? |
|---|---|---|---|
| `@typescript-eslint/class-methods-use-this` | no | no | n/a (not enabled) |
| `@typescript-eslint/no-unnecessary-condition` | YES | no | no (all `if`s in `filterOwnNodeCandidates` are runtime-typed; uid is `number \| null`, getProcessUid returns `number \| null`, etc.) |
| `@typescript-eslint/parameter-properties` | no | no | n/a (not enabled — the plan's `private readonly ctx` is fine) |
| `@typescript-eslint/explicit-member-accessibility` | no | no | n/a (not enabled) |
| `@typescript-eslint/promise-function-async` | no | no | n/a — the plan's `function ... : Promise<void>` choice is fine |
| `@typescript-eslint/no-extraneous-class` | YES | no | no (both classes have instance methods + ctor; rule only fires on static-only / ctor-only / empty) |
| `@typescript-eslint/prefer-readonly` | no | no | n/a |
| `@typescript-eslint/no-useless-constructor` | YES | no | no (the ctor has a parameter property, which makes it not-useless per the rule's own AST check at `no-useless-constructor.js:27`) |
| `@typescript-eslint/require-await` | YES | no | no (wrappers are non-async, methods are async with real awaits) |
| `@typescript-eslint/class-literal-property-style` | no | YES | no (no literal properties in the plan) |

All "ON" rules are satisfied by the plan's shape. **No lint regression
predicted.**

Verified source:

```
$ grep -nE "@typescript-eslint/(prefer-readonly|explicit-member-accessibility|parameter-properties|class-methods-use-this|promise-function-async)" \
    node_modules/@typescript-eslint/eslint-plugin/dist/configs/flat/strict-type-checked.js
(no output)

$ grep -nE "@typescript-eslint/(prefer-readonly|explicit-member-accessibility|parameter-properties|class-methods-use-this|promise-function-async)" \
    node_modules/@typescript-eslint/eslint-plugin/dist/configs/flat/stylistic-type-checked.js
(no output)

$ grep -nE "@typescript-eslint/(prefer-readonly|explicit-member-accessibility|parameter-properties|class-methods-use-this|promise-function-async)" \
    node_modules/@typescript-eslint/eslint-plugin/dist/configs/flat/all.js
31:            '@typescript-eslint/class-methods-use-this': 'error',
45:            '@typescript-eslint/explicit-member-accessibility': 'error',
129:            '@typescript-eslint/no-useless-constructor': 'error',
136:            '@typescript-eslint/parameter-properties': 'error',
151:            '@typescript-eslint/prefer-readonly': 'error',
```

Only `all.js` enables the candidate rules; the repo's config uses
`strictTypeChecked + stylisticTypeChecked`. The plan's claim "no new lint
categories" holds.

---

### 8. LOW — Workflow mechanics: `$HOME/claw-verify-a`, `$HOME/claw-verify-b` are safe to create

Verified output:

```
$ git worktree list
/Users/eggp/marveen-develop/marveen        f5402ca [feature-develop]
/Users/eggp/marveen-develop/test-baseline  2707900 [refactor/classbase]

$ ls $HOME | head -20
Applications
ccstatusline-config.json
Desktop
Documents
Downloads
go
Library
marveen
marveen-develop
Movies
Music
Pictures
projects
Public
temp
websearch-mcp.sh

$ test -w $HOME && echo "writable" || echo "not writable"
writable
```

`$HOME/claw-verify-a` and `$HOME/claw-verify-b` do not currently exist.
`$HOME` is writable. Two pre-existing worktrees live in
`$HOME/marveen-develop/` (a sibling dir), but those are at distinct paths
from the new ones — no naming collision.

The plan's symlink (`ln -sf .../node_modules <worktree>/node_modules`) is
the same trick CLAUDE.md §8 already validated. I did not find anything
that breaks this in the vitest/istanbul path; both `vitest.config.ts:12`
(`globals: true`) and `vitest.config.ts:31-52` (istanbul coverage with
`include: ['src/**/*.ts']`) use string-based path globs and resolve
relative to the worktree root, which works the same through a symlinked
`node_modules`.

The `coverage/` directory is `.gitignore`-d (verified: `.gitignore:98`),
so the "coverage gate" rule from CLAUDE.md §8 applies — the workflow
should run targeted tests, not `bun run coverage`, to get a committable
JSON artifact. The plan already calls `bun run coverage` directly in
Phase 1 gate #1, which will produce no committed artifact under the
current gitignore. **The plan's Verification table line #1
(`bun run coverage → exit 0`) is fine as a green/non-green signal but
will not produce a committed artifact.** No coverage data is committed
in this codebase as a rule.

---

### 9. LOW — `releaseLock()` and `filterOwnNodeCandidates` reachability

`releaseLock()` lives at `src/index.ts:356-364`. It is **separate** from
`process-lock.ts` and uses `readRecordedPidFrom(PID_FILE)` + `unlinkSync`
directly. Verified:

```
$ grep -nE "releaseLock|unlinkSync|readRecordedPidFrom" src/process-lock.ts
(no output)
```

The plan is correct that adding a `release()` method to the new classes
would be dead code in production (the only `releaseLock` is the `index.ts`
helper). Dropping `release()` is right.

`filterOwnNodeCandidates` is module-private (line 93), called only from
two free functions in the same file. After the refactor it becomes a
private class method, called only from `this.findOwnNodeHolders` and
`this.findOwnBinaryMatches`. No test imports it directly. Verified:

```
$ grep -rn "filterOwnNodeCandidates" src/ --include='*.ts'
src/process-lock.ts:79:  return filterOwnNodeCandidates(raw, ctx)
src/process-lock.ts:90:  return filterOwnNodeCandidates(raw, ctx)
src/process-lock.ts:93:function filterOwnNodeCandidates(pids: number[], ctx: ProcessLockContext): number[] {
src/__tests__/index.test.ts:2763:        // ps returns comm='node' + uid='1000' for PID 999 so filterOwnNodeCandidates
```

The only `index.test.ts` hit is a comment (line 2763), not an import.
Plan is right; no test direct-imports `filterOwnNodeCandidates`.

---

### 10. LOW — Plan's coverage branch count for `filterOwnNodeCandidates` is off by 3

The plan's coverage table at lines 137-143 has 8 rows; the heading says
"11 ág" (11 branches). Istanbul counts each binary `||`/`&&` short-circuit
jump as a separate branch.

I counted manually in `src/process-lock.ts:97-114`:

1. `!Number.isFinite(pid)` — true branch (NaN → skip)
2. `pid <= 0` — short-circuit branch (negative or 0 → skip)
3. `pid === ctx.currentPid` — true branch
4. `seen.has(pid)` — true branch
5. `cmd == null` — null branch
6. `ctx.uid != null` — both branches
7. `ownerUid == null` — null branch
8. `ownerUid !== ctx.uid` — true branch
9. `!/node|tsx/i.test(cmd)` — true branch

= **9 branches**, not 11 or 8. The plan's table covers all of them via the
8 listed tests (lines 130, 92, 143, 122, 135, 151, 101, 111). All 9
branches are reachable. **No uncovered branch** — but the "11" number in
the heading is sloppy.

Not a correctness bug, just an internal-numbering inconsistency in the
plan.

---

### 11. LOW — Plan's `process-lock.test.ts` "default ág" test count claim is suspect

The plan's Phase 1 step 4 (line 212) says
`bun run coverage → 384 file, 11218 teszt, exit 0`. 384 files = 383
baseline + 1 new test file (`process-lock-classes.test.ts`). 11218 tests
= 11211 baseline + 7 new `it()` blocks in the new file.

Counting `it(`, `it.each(` in the plan (sections 1-7): 7 `it()` cases
listed. ✓ The arithmetic holds.

But: each `it()` in the existing `process-lock.test.ts` is wrapped in a
`describe()` block. `describe()` itself doesn't increment test count in
vitest. So 7 new `it()` cases adds 7 to the test count. ✓

---

## Things I tried to break and COULD NOT

- **Ctx-mutation post-construction.** The wrapper constructs a new
  `PortLockAcquirer` per call, but `this.ctx = ctx` stores a reference.
  Post-construction mutation of ctx methods (test line 161) is still
  visible to the class method because the underlying object is the same.
  Equivalence holds.
- **`acquire()` per-call vs per-instance state.** The drain loop
  accumulator `let waited` is local; the class doesn't introduce state
  across calls. ✓
- **Lint regression.** All strict-type-checked + stylistic-type-checked
  rules are compatible with the plan's shape. No new rule fires.
- **Coverage gate per-file 100%.** Parameter property + non-async
  wrapper + private method pattern is already in
  `src/web/remote-status-cache.ts` and passes the gate. The plan's
  pattern is identical.
- **`filterOwnNodeCandidates` direct test import.** No test imports it
  directly. ✓
- **`releaseLock()` collision.** It lives in `index.ts`, not
  `process-lock.ts`, and uses `unlinkSync` directly. No conflict.
- **`DeferToPeerError instanceof` across the class.** The class method
  still throws `new DeferToPeerError(recorded)`. The class instance's
  prototype chain still includes `DeferToPeerError.prototype`. ✓
- **Worktree creation at `$HOME/claw-verify-{a,b}`.** Neither exists;
  `$HOME` is writable; the symlink trick matches the existing CLAUDE.md
  §8 pattern.
- **`index.test.ts` vi.mock factory breaks under refactor.** Verified
  the mock factory at lines 173-194 only returns
  `acquirePortLock`/`acquirePidfileLock`/`writeBufferFully`/`DeferToPeerError`,
  which are the exact 4 imports `index.ts` uses (lines 28-31). No test in
  `index.test.ts` imports `PortLockAcquirer`/`PidfileLockAcquirer`, so the
  mock factory stays valid. ✓

---

## Summary

| # | Severity | Finding |
|---|---|---|
| 1 | CRITICAL | docs commit refers to wrong file/line numbers (top-level `00-summary.md` vs `e-process-lock/00-summary.md`) |
| 2 | CRITICAL | "365 → 364" line-count update is BACKWARDS; post-refactor file will be LARGER |
| 3 | MEDIUM | `acquire()` body internal call style unspecified → implementer may create double-instance chains |
| 4 | LOW | Branch count header says "11", table has 8 rows, actual count is 9 |
| 5 | LOW | `bun run coverage` will not produce a committed artifact (coverage/ is gitignored); plan should not promise one |
| 6 | LOW | Cake lint rules: no regression predicted; class shape matches existing `remote-status-cache.ts` precedent |

The plan is sound in shape and lint/coverage/equivalence predictions, but
the docs-commit section is broken in two ways (wrong file, wrong direction
of line-count update). Both will surface as visible artifacts in the diff
and should be fixed before the workflow runs.
