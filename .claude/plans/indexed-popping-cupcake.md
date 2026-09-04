# Cycle 36 — `web-inbound-probe-cache-sticky` (dead store removal)

## Context

`docs/needs-to-be-fix/web-inbound-probe-cache-sticky.md` documents that the
"reset chat-id-absent flag if the value is now present" statement at
`src/web/inbound-probe.ts:246` (`_warnedChatIdAbsent = false`) has no
behavioral effect. The flag is `false` when control reaches line 246 (it
is only set to `true` at line 239, inside the early-return branch at line
243), and `_cachedAllowedChatId` is never invalidated, so the transition
the reset was meant to handle cannot occur. The MD proposes three options;
**Option 3** (drop the dead assignment + document the operator-restart
requirement) is the smallest diff and the only one that does not change
runtime behavior.

This is the only candidate among the unresolved needs-fix MDs that is:

- small in scope (a single dead statement + comment swap + INDEX update),
- free of `NEVER modify` rule on the target file (`src/web/inbound-probe.ts`
  has no such rule — verified by `grep -rn "NEVER modify" docs/needs-to-be-fix/`
  on 2026-08-20; no inbound-probe entry matches),
- not pinned by runtime-asserting tests (verified below).

Intended outcome: the redundant assignment disappears, the operator-restart
invariant is documented with a forward-compat tripwire, the two MD rows in
INDEX.md are marked Resolved, the test suite remains green, and coverage
holds.

## Premise correction (from verifier feedback)

The line 246 statement is **reachable and executed** (the test suite covers
it at `src/__tests__/inbound-probe-full.test.ts:569,585,602,616` via the
"ALLOWED_CHAT_ID is present" path). What is dead is its *effect*: it always
writes `false` to a flag that is already `false` on every reachable entry
to the statement.

Therefore the commit message and the INDEX row text must say
**"redundant assignment (dead store)"**, not "unreachable branch". The
latter is factually false and contradicts the coverage report.

## Critical files

- `src/web/inbound-probe.ts` — source change at lines 245-246 (the reset
  statement + its preceding comment).
- `src/web/inbound-probe.ts` — comment swap at lines 53-54 (the `// W4:`
  tripwire comment near the cache declaration).
- `src/web/inbound-probe.ts` — comment add at line 237 (the warn/debug
  latch site).
- `docs/needs-to-be-fix/INDEX.md` — flip the cell at line 193 for
  `web-inbound-probe-cache-sticky` from `—` to
  `Resolved: 2026-08-20 <sha>`.

**NOT TOUCHED:**

- `src/web/inbound-probe.ts:60` — the `let _warnedChatIdAbsent = false`
  declaration is **still in use** at lines 237 (read) and 239 (write) for
  the one-shot warn/debug latch. Deleting it would break TS2304. The
  earlier plan draft's "if no other code references it, delete" escape
  clause was misleading wording; the rule is absolute: **keep line 60.**
- `src/web/inbound-probe.ts:231` — the `_warnedSessionMissing = false`
  reset is **NOT dead** (unlike chat-id, the SESSION_FILE `existsSync` is
  re-evaluated every tick and the session file CAN appear at runtime), so
  this reset is live and stays.

## Changes

### `src/web/inbound-probe.ts` — three small edits

**Edit 1** (lines 245-246, delete):

```ts
  // Reset chat-id-absent flag if the value is now present.
  _warnedChatIdAbsent = false
```

The two lines above are removed entirely.

**Edit 2** (replace lines 53-54, swap tripwire comment). Current:

```ts
// W4: env-derived values cached once at startInboundProber() startup.
// Reading .env from disk every tick is unnecessary and wasteful.
```

New:

```ts
// ALLOWED_CHAT_ID is read once at the first spawn; subsequent ticks use
// the cached value. To pick up a runtime change to .env, restart the
// dashboard. If a future change invalidates the cache (e.g. an .env
// mtime watcher), the warn-then-debug flag below must be re-added.
```

Rationale: cycle-free (the codebase chore commits `b0585e5`, `b49e8c1`,
`af7021a`, `51ad135`, `0f07588` systematically stripped `(W4)`-style
references), explains the invariant, and frames the resurrection
condition (forward-compat tripwire, matching the pattern at
`src/web/channel-health-monitor.ts:24`).

**Edit 3** (insert at line 237, in front of the latch read):

```ts
    // Tripwire: this latch has no reset path (see the cache comment above).
    // If the cache is ever invalidated, the warn-then-debug pattern must be
    // re-bound to that invalidation.
    if (!_warnedChatIdAbsent) {
```

Rationale: the trap for a future reader is at the latch site (237-243),
not at the cache declaration. Without this in-line note, a future maintainer
might re-add the reset and re-introduce the dead-store behavior.

### `docs/needs-to-be-fix/INDEX.md` — flip line 193

Current:

```
| `web-inbound-probe-cache-sticky` | Defect: ALLOWED_CHAT_ID cache never invalidated, breaking the "reset" branch | — |
```

New:

```
| `web-inbound-probe-cache-sticky` | Redundant assignment (dead store): `_warnedChatIdAbsent = false` reset at line 246 is dead | Resolved: 2026-08-20 <sha> |
```

(The SHA is the source-change commit's SHA, not the INDEX-update commit's
SHA. See commit structure below.)

The MD file itself stays in-tree (the `INDEX.md:3-6` invariant requires
every MD to remain on disk; resolved MDs are not deleted, only their INDEX
rows flip).

## Test impact: zero

`grep -rn "_warnedChatIdAbsent\|chat-id-absent\|chatIdAbsent" src/` returns
**only** the five source lines (`:60, :237, :239, :245, :246`). No test
references the flag. The four relevant tests assert on log strings only:

- `inbound-probe-full.test.ts:535` — "returns early when ALLOWED_CHAT_ID is
  absent (warn path)"
- `inbound-probe-full.test.ts:546` — "emits debug on subsequent ticks when
  ALLOWED_CHAT_ID stays absent"
- `inbound-probe-full.test.ts:558` — "returns early when ALLOWED_CHAT_ID is
  whitespace-only"

All three exercise the absent branch where line 246 is unreachable anyway.
Pattern 113 (atomic fix+test commit for runtime-asserting pinning tests)
**does not apply** here — there are no pinning tests, no test deletions.

## MD correction note (not in this commit)

The MD's "Workaround in the suite" section (`web-inbound-probe-cache-sticky.md:35-38`)
cites a non-existent `src/__tests__/web-inbound-probe.test.ts` and a phantom
`H.envMap`. The real mechanism is `mockState.envFile`
(`inbound-probe-full.test.ts:43,218`) + `loadInboundProbeFresh()` →
`vi.resetModules()` (`:146`). The MD also states the file is at 63%
coverage, but it was rewritten to 100% in commit `c333a6f`. Per CLAUDE.md §3,
unrelated dead text in the MD is **not edited** in this cycle — flag it for
a future MD-hygiene pass.

## Two-commit structure (SHA/atomicity resolution)

The INDEX row's `Resolved: <sha>` cannot refer to the commit that contains
the INDEX row itself (a chicken-and-egg). The clean solution is two commits:

1. **Commit A** — source change only (the three `inbound-probe.ts` edits).
   - Body: `Resolves: docs/needs-to-be-fix/web-inbound-probe-cache-sticky.md`
2. **Commit B** — INDEX.md flip with the **real SHA of commit A** filled in.
   - Body: `docs: mark web-inbound-probe-cache-sticky Resolved (<sha of A>)`

Both commits land on `test/baseline`. The atomic-commit concern from
Pattern 113 is vacuous here (no test deletions), so splitting is safe.

## Pre-flight: test runner requires a clean worktree

`src/__tests__/setup/assert-not-live-install.ts:66-76` aborts the suite
when `store/claudeclaw.db` is present in the working tree. The current
checkout has that file (untracked + gitignored, 20 KB, mtime 2026-08-20
00:01) — `git status` reports clean only because gitignored files are
hidden by default. There is no env escape.

The workflow MUST run from a fresh worktree, e.g.:

```
git worktree add /tmp/claw-cycle36 test/baseline
cd /tmp/claw-cycle36
# ... make edits, run vitest, commit, etc.
```

(Do NOT modify or remove `store/claudeclaw.db` in the main checkout — it
is part of the user's local install state.)

## Verification (after commit B)

Run from the worktree root:

1. `bun --bun vitest run src/__tests__/inbound-probe-full.test.ts` — must
   pass with the same test count as the baseline (no test deletions; every
   `mockState.envFile`-driven test still passes).
2. `bun --bun vitest run` — full suite must remain green (cycle 35 baseline:
   382 files / 11129 tests; 0 failed, 0 skipped).
3. `bun tsc --noEmit | wc -l` — must equal the baseline (cycle 35: 2253
   pre-existing errors concentrated in `src/db.ts` SQLite bindings). The
   dead-line removal does not touch types.
4. `bun --bun vitest run --coverage src/web/inbound-probe.ts` — coverage
   on this file holds at the existing numbers (100% on lines/functions/
   statements; the removed branch was a redundant assignment, not a
   branch, so the gate is unaffected).

The verification commands run AFTER commit B, not before (per the
project's standard cycle pattern).

## Post-commit

Invoke `/code-review xhigh --fix HEAD~2..HEAD` (the two-commit stack). The
skill auto-applies safe follow-ups; report findings and apply fixes as a
separate commit on the same branch. No push — `git push` is the user's
decision.

## Risk: 2/10

- Code risk: trivial. A no-op statement + comment swap. No behavior change.
- Test risk: zero (no test references the removed statement).
- Type-check risk: zero (no type changes; line 60 stays declared because
  it's still read at 237 and written at 239).
- Coverage risk: neutral. Removing a redundant assignment cannot flip any
  coverage metric from green to red; it cannot flip any metric from red
  to green either (the line was 100% covered, just inert).
- CI gate risk: none.
- Process risk (the only reason it is not 1/10): the worktree requirement
  is not enforced by tooling and could be skipped, leaving the runner
  pointing at the live install.

## Design note (Option 3 vs Option 1)

Option 3 silently blesses an asymmetry: `_warnedSessionMissing` resets on
line 231 because the SESSION_FILE check is uncached, while
`_warnedChatIdAbsent` never resets because the chat-id check IS cached.
Option 1 (drop the cache for chat-id, re-read every tick) would actually
fix the operator-facing defect and make line 246's reset load-bearing, at
the cost of one extra env-file read per tick (≤1 read / 30s floor).

**This plan sticks with Option 3** because:

1. The user explicitly chose Option 3 in the AskUserQuestion at plan start.
2. Option 3 is the smallest diff and the lowest behavior-change risk.
3. Option 1 can be picked up in a later cycle if the operator-restart
   caveat proves too painful.

## Out of scope (deferred)

- `web-inbound-probe-respawn-grace` — different defect in the same file
  (vitest mock-key issue with `import('./channel-monitor.js')`). Larger
  scope, test-infrastructure change. Reserved for a future cycle.
- All other unresolved MDs — blocked by `NEVER modify` rules, larger scope,
  or have pinning tests that complicate atomic commit. None addressed in
  this cycle.
- MD hygiene (fixing the phantom `web-inbound-probe.test.ts` reference in
  `web-inbound-probe-cache-sticky.md` and `web-inbound-probe-respawn-grace.md`).
  Per CLAUDE.md §3, out of scope for this fix.
