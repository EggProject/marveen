# H.3 — `LazyBin<TName>` class extraction (lowest-risk remaining item)

## Context

`docs/refactor-to-classbase/` catalogs the post-D.2/D.4/E.1/E.2 refactor
backlog. Three items tie for the lowest risk rating (Low) in the existing
plan set: **H.3 `LazyBin`** (`h-cross-cutting/05-refactor-roadmap.md:147`),
**F.5 `AutoRestartSchedule`** (`f-agent-subsystem/05-refactor-roadmap.md:227`),
**F.7 `ClaudeCodeBinResolver`** (`f-agent-subsystem/05-refactor-roadmap.md:330`,
gated on H.3). The user picked H.3 because it has the smallest blast radius:
**zero consumer changes** (the `makeLazyBinResolver` factory at
`src/platform.ts:74-80` is preserved verbatim, reimplemented over the class),
only `src/platform.ts` + one structural-guard test file change, and a single
new behaviour (`invalidate()`) tested directly. F.5 wins on file count but
forces a rewrite of 2 existing test files; F.7 cannot ship without H.3. The
intended outcome is a `LazyBin` class that (a) preserves the closure's
"resolve on first use, memoize, throw on missing" contract, (b) adds
`invalidate()` for test-time cache resets, (c) keeps all 14 existing
`makeLazyBinResolver` call sites working unchanged across 11 consumer files
(`channel-coordinator/liveness.ts:13`, `web/agent-process.ts:6`,
`web/agent-worker.ts:6`, `web/channel-mcp-reconnect.ts:2`,
`web/channel-monitor.ts:5`, `web/channel-plugin-unlock.ts:36`,
`web/mcp-list.ts:5`, `web/reauth-healer.ts:5`,
`web/routes/agent-terminal.ts:3`, `web/routes/background-tasks.ts:8`,
`web/stuck-tool-call-watcher.ts:42`), and (d) extends the structural guard at
`src/__tests__/platform-no-import-time-bin-resolve.test.ts:44` to remain
non-blind to `LazyBin`-shaped module-scope resolution (the HR5 regression).

Pre-flight gates measured on `refactor/classbase` @ `40a7b55` (HEAD), clean
worktree, in the current session at `/Users/eggp/marveen-develop/test-baseline`:

| Gate | Baseline (2026-08-30 23:26) | Plan target |
|---|---|---|
| `bun --bun vitest run` | **11220 tests / 384 files / all pass** | delta = 0 fails, +N passes where N = new tests added |
| `bun --bun vitest run src/__tests__/platform-bin-resolve.test.ts src/__tests__/platform-no-import-time-bin-resolve.test.ts` | **14/14 pass** | all green + new tests |
| `bun tsc --noEmit` | **1730 errors** (pre-existing `bun:sqlite` drift) | ≤ 1730 (no new errors) |
| `bun run lint` | not re-measured (run during execution gate) | no new violations on changed lines |

`store/` is empty in the current worktree (CLAUDE.md §8 guard not triggered).

---

## Files touched

**Source (1):** `src/platform.ts` — add `class LazyBin`, reimplement
`makeLazyBinResolver` over it. `PLATFORM` (`:24`), `KNOWN_BIN_DIRS` (`:36-43`),
`tryResolveFromPath` (`:48`), `resolveFromPath` (`:61`) unchanged.

**Test (2):**
- `src/__tests__/platform-no-import-time-bin-resolve.test.ts` — extend
  `TOP_LEVEL_RESOLVE` regex at `:44`; add positive + negative non-vacuity
  assertions mirroring `:69-76`.
- `src/__tests__/platform-bin-resolve.test.ts` — add `invalidate()` test,
  extend the constructor-no-I/O test (`:88-92`) and the memoisation test
  (`:94-100`) to exercise both `makeLazyBinResolver(...)` and
  `new LazyBin(...)` forms.

**Zero consumer changes** — the 11 files listed above keep calling
`makeLazyBinResolver`; no import path changes.

---

## Design decisions (locked at plan-writing time, no execution-time discovery)

### 1. `class LazyBin<TName extends string = string>` — single generic param

Per `h-cross-cutting/review-completeness.md:58` (`HOE-1`) and
`h-cross-cutting/review-correctness.md:CE-LB-2`: drop `TResolved` because
`resolveFromPath` returns `string` with no narrower inhabitant anywhere in
`src/`, and the default `= string` is silent — it can never be wrong, so it
can never be useful. `TName` stays because `new LazyBin('tmux')` infers
`LazyBin<'tmux'>`, narrowing the instance type. `name: TName` field is
documentation-grade (no caller reads `bin.name` today, verified by grep —
no production reads).

```ts
// src/platform.ts (additive, ~30 LOC net)
export class LazyBin<TName extends string = string> {
  readonly name: TName
  private cached: string | null = null
  constructor(name: TName, private readonly resolver: (name: TName) => string = resolveFromPath) {
    this.name = name
  }
  resolve(): string {
    if (this.cached === null) this.cached = this.resolver(this.name)
    return this.cached
  }
  invalidate(): void {
    this.cached = null
  }
}
```

### 2. `resolve()` throws, does NOT return `string | null`

Per `h-cross-cutting/03-class-boundaries.md:169-176` and
`h-cross-cutting/review-correctness.md:C-LB-1`: the closure form throws via
`resolveFromPath` (`:63`); converting to `string | null` would silently push
null-handling onto 14 call sites that today pass the result to `execSync` /
`execFileSync` / template literals. `resolve(): string`, throwing.

### 3. Constructor performs no I/O

Pinned by existing test at `platform-bin-resolve.test.ts:88-92` ("does not
resolve at construction time (safe during a boot-time PATH gap)"). The new
test at the same site extends coverage to `new LazyBin('claude')` form
explicitly.

### 4. `makeLazyBinResolver` becomes a thin factory

```ts
export function makeLazyBinResolver(name: string): () => string {
  const bin = new LazyBin(name)
  return () => bin.resolve()
}
```

Byte-compatible with the existing `() => string` return type. The 14
existing call sites keep working without edit. Per HR5 Mitigation 4
(`h-cross-cutting/06-risks-and-mitigations.md`): **do not migrate the 11
consumer files in H.3** — that belongs to F.7 in a later cycle.

### 5. `TOP_LEVEL_RESOLVE` regex extension (mandatory, same commit)

Current regex at `platform-no-import-time-bin-resolve.test.ts:44`:
```ts
/^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*resolveFromPath\(/
```
matches only the literal text `= resolveFromPath(`. After H.3,
`const CLAUDE = new LazyBin('claude').resolve()` reproduces the 2026-08-13
CI incident and the guard does not fire (HR5 Part B). Extension per HR5
Mitigation 2 and `h-cross-cutting/03-class-boundaries.md:202-204`:

```ts
const TOP_LEVEL_RESOLVE = /^(?:export\s+)?(?:const|let|var)\s+\w+\s*(?::[^=]+)?=\s*(?:resolveFromPath\(|new\s+LazyBin\(.*?\)\.resolve\(\))/
```

The existing `new LazyBin(...)` without `.resolve()` is **not** rejected
(constructor is no-I/O — same rule as the existing regex, which catches the
throwing call, not a binding to the function itself).

Non-vacuity self-test additions (mirror `:69-76`):
```ts
// positive — must match
expect(TOP_LEVEL_RESOLVE.test("const X = new LazyBin('tmux').resolve()")).toBe(true)
expect(TOP_LEVEL_RESOLVE.test("export const X = new LazyBin('tmux').resolve()")).toBe(true)
expect(TOP_LEVEL_RESOLVE.test("const X: string = new LazyBin('tmux').resolve()")).toBe(true)
// negative — must NOT match (factory is allowed; constructor without .resolve is harmless)
expect(TOP_LEVEL_RESOLVE.test("const X = makeLazyBinResolver('tmux')")).toBe(false)
expect(TOP_LEVEL_RESOLVE.test("const X = new LazyBin('tmux')")).toBe(false)
// indented = inside a function body = already lazy
expect(TOP_LEVEL_RESOLVE.test("    const bin = new LazyBin('claude').resolve()")).toBe(false)
```

### 6. `index.ts:283` off-by-one comment is NOT in scope

Per `h-cross-cutting/review-correctness.md:C-LB-3`: the source comment
"cites `index.test.ts:1382`; the actual `it(...)` test starts at `:1383`"
belongs to the H.1 `LoggerLike` collapse (the pin is on the
`PidfileLockContext.log.error` forwarder path). H.3 does not touch the
forwarder. Deferred to H.1.

### 7. `ClaudeCodeBinResolver` circular dependency is NOT in scope

Per `h-cross-cutting/review-correctness.md:CE-LB-1`: H.3 lands before F.7
(`ClaudeCodeBinResolver extends LazyBin<'claude'>`). The plan accepts this
sequencing — H.3 ships the class; F.7 adopts it later. `review-correctness.md`
calls this out; this plan documents the ordering as a known
intentional dependency, not a defect.

---

## Implementation steps (executed by Worktree-isolated Implementer subagent)

1. **Pre-flight (subagent `bash` only, no edits):**
   ```bash
   cd /Users/eggp/marveen-develop/test-baseline
   git status --short    # must be clean
   git rev-parse HEAD    # record starting SHA
   ```
2. **Worktree setup** (per CLAUDE.md §8 worktree precedent in
   `e-process-lock/05-refactor-roadmap.md` and the established pattern in
   `57c78d0`, `10d06cb`):
   ```bash
   WT=$HOME/claw-h3-$(date +%s)
   git worktree add --detach "$WT" refactor/classbase
   ln -sf /Users/eggp/marveen-develop/test-baseline/node_modules "$WT/node_modules"
   cd "$WT"
   ```
   Worktree must be under `$HOME`, not `/tmp/` — `/tmp/` triggers the
   `_TMP_PREFIXES` guard at `src/web/agent-scaffold.ts:144`.
3. **Edit `src/platform.ts`** (single commit, all changes together):
   - Insert `class LazyBin<TName extends string = string>` block.
   - Reimplement `makeLazyBinResolver` body as the thin factory.
   - Leave `PLATFORM`, `KNOWN_BIN_DIRS`, `tryResolveFromPath`,
     `resolveFromPath` untouched.
4. **Edit `src/__tests__/platform-no-import-time-bin-resolve.test.ts`:**
   - Extend `TOP_LEVEL_RESOLVE` regex per design #5.
   - Add the 5 non-vacuity assertions per design #5 to the existing
     `it('detects an offending line...')` block at `:69-76`.
5. **Edit `src/__tests__/platform-bin-resolve.test.ts`:**
   - Add `it('invalidate() drops the memoised value (execSync called again)',
     ...)` — resolve, `invalidate()`, resolve again, assert `mockExecSync`
     called exactly twice.
   - Extend `it('does not resolve at construction time (safe during a
     boot-time PATH gap)', ...)` at `:88-92` to also exercise
     `new LazyBin('claude')`.
   - Extend the memoisation test at `:94-100` (or add a sibling) to cover
     the class form `const bin = new LazyBin('tmux'); bin(); bin()` →
     `mockExecSync` called exactly once.
   - Keep all existing tests passing byte-identically.
6. **Run gates in worktree:**
   ```bash
   bun --bun vitest run src/__tests__/platform-bin-resolve.test.ts src/__tests__/platform-no-import-time-bin-resolve.test.ts
   # Expect: previous 14 + new ones, all green
   bun --bun vitest run   # full suite; expect delta = 0 fails
   bun tsc --noEmit       # expect ≤ 1730
   ```
7. **Commit** with git identity from `git config user.email` (NOT
   `Claude <claude@anthropic.com>` — CLAUDE.md §8 subagent-author rule;
   verify with `git log -1 --format='%an <%ae>'` after committing).
8. **Verify author** matches repo git identity; if mismatch, **STOP and ask
   user** — per CLAUDE.md §8 precedent (2026-08-30 E.1/E.2 author-rebase
   cost 3 follow-up commits).
9. **Merge back to `refactor/classbase`** via `git merge --ff-only <sha>`
   (CLAUDE.md §8 worktree-merge rule — `--ff-only`, NOT `git reset --hard`).
10. **Cleanup worktree:** `git worktree remove "$WT" --force`.

---

## Verification (workflow-organized, 4 phases)

The execution will be orchestrated by the **Workflow tool** (per user
instruction: "Végrehajtáshoz workflow-t használj"). The script will be:

```
export const meta = {
  name: 'h3-lazybin',
  description: 'Extract LazyBin<TName> class; preserve makeLazyBinResolver factory; extend structural guard',
  phases: [{ title: 'Implement' }, { title: 'Verify-A' }, { title: 'Verify-B' }, { title: 'Review' }],
}
```

Phases:
- **Implement** — single worktree-isolated agent (the established
  pattern from `57c78d0`, `10d06cb`). Runs steps 1–7 above; reports the
  commit SHA and the full-suite vitest output.
- **Verify-A (structural, checklist)** — second subagent runs a PASS/FAIL
  checklist over the diff: every assertion in the design above present in
  source; tsc delta = 0; existing tests byte-identical; new tests fail
  when `invalidate()` is stubbed to a no-op (proves the test isn't
  vacuous — CLAUDE.md §7 vacuous-test precedent).
- **Verify-B (adversarial, falsification)** — third subagent tries to
  break the diff: imports the new `LazyBin` and constructs it without I/O,
  asserts the regex catches a hand-built `const BAD = new
  LazyBin('tmux').resolve()` line in a synthetic file; confirms that
  stubbing the class's `resolver` arg routes through correctly; confirms
  that the existing 14 `makeLazyBinResolver` callers do not bind to a
  shared cache (constructing two factories and resolving each returns
  independent caches).
- **Review** — invoke `/code-review max --fix` per user instruction (the
  skill is `disable-model-invocation`-flagged — only the user can invoke
  it; per CLAUDE.md §8, **document this as user-actionable**, do NOT try
  the Skill tool). Plan reserves a follow-up commit for whatever the
  review produces.

Verification-A and B run in parallel (`parallel()` in the Workflow
script). Per CLAUDE.md §8 "Dupla ellenőrzés", the two verifiers must take
**different angles** — checklist vs. falsification.

### Verification gates (concrete, measurable)

| Gate | Pass criterion | Fail signal |
|---|---|---|
| Existing platform tests | `platform-bin-resolve.test.ts` + `platform-no-import-time-bin-resolve.test.ts` = 14 + new, all pass | any red |
| Full vitest delta | `11220 + N` pass (N = new tests), 0 fail | any red in the run |
| tsc delta | `bun tsc --noEmit` errors ≤ 1730 | new error attributable to the diff (cite file:line) |
| `invalidate()` non-vacuous | stub `invalidate()` to `() => {}`; new test must FAIL (not pass by accident — CLAUDE.md §7 vacuous-test precedent) | test passes after stub |
| Extended regex non-vacuous | remove the 5 new non-vacuity assertions; an `expect(TOP_LEVEL_RESOLVE.test('const X = new LazyBin(\'tmux\').resolve()')).toBe(true)` must still pass (asserting the regex itself, not the assertions, is meaningful) | assertions would be vacuous |
| Consumer zero-touch | `grep -rn "makeLazyBinResolver" src/ --include='*.ts' \| grep -v __tests__` returns the same 14 lines as the pre-state; `git diff refactor/classbase..HEAD -- 'src/!platform.ts' 'src/!__tests__'` is empty | any unexpected diff outside `platform.ts` |
| Author identity | `git log -1 --format='%an <%ae>'` matches `git config user.email` | stop and ask user |
| Closure byte-compat | `resolveFromPath` and `tryResolveFromPath` line counts and contents unchanged in the diff | any change |

---

## Rollback

Single commit (`refactor(classbase): extract LazyBin class (H.3)`). Revert
is `git revert <sha>` (no history rewrite). The class lives alongside
`makeLazyBinResolver`; reverting the class definition restores the closure.
`makeLazyBinResolver` is byte-compatible both ways.

---

## Out of scope (deferred)

- `ClaudeCodeBinResolver extends LazyBin<'claude'>` (F.7 in
  `f-agent-subsystem/05-refactor-roadmap.md:330`) — depends on H.3, lands
  in a later cycle.
- Migrating the 11 consumer files from `makeLazyBinResolver(...)` to
  `new LazyBin(...).resolve()` — per HR5 Mitigation 4, deferred.
- `index.ts:283` off-by-one comment — H.1 scope.
- H.1 (`LoggerLike`), H.2 (per-class injection), H.4 (`AppError`),
  H.5 (singleton removal) — independent phases, not gated on H.3.
- F.5 (`AutoRestartSchedule`) — parallel candidate, can run alongside or
  after; user picked H.3.