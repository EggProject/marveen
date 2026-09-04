# Cycle 36 plan verification — `web-inbound-probe-cache-sticky` (Option 3)

Verifier: independent second look. Different lens than the other verifier.
Mode: read-only verification. No edits to source/tests/INDEX.

---

## TL;DR

The plan is **mostly sound**, but has **3 issues** that should be addressed before the atomic commit lands:

1. **Critical**: The proposed comment contains a cycle-reference token (`(W4)`) that is being systematically stripped project-wide (see `b0585e5`, `b49e8c1`, `af7021a`, `51ad135`, `0f07588`). The new comment should not add another one.
2. **Nice-to-have**: Add a forward-compat-style tripwire comment that explains WHY the reset was removed and what would be needed to re-introduce it (matches the pattern at `src/web/channel-health-monitor.ts:24`).
3. **Minor**: The proposed "delete the now-dead `_warnedChatIdAbsent` module-scoped variable" step is correct but worth verifying AFTER grepping the rest of the file/suite to confirm no other reference (the reset on line 246 is the only `= false` write in the source); the variable is read in two places (line 237, 239) — both inside `spawnProber` — both go away with the no-reset refactor.

The other 5 angles confirm the plan works.

---

## 1. Coverage tool mechanics — CONFIRMED

`vitest.config.ts:41-47` pins `lines: 100, functions: 100, branches: 100, statements: 100` with `perFile: true`.

`src/web/inbound-probe.ts` currently has the dead branch on line 246 (`_warnedChatIdAbsent = false`). The MD at `docs/needs-to-be-fix/web-inbound-probe-cache-sticky.md:8-12` states the reset is unreachable because the cache is sticky. That means the file is currently failing the 100% branch gate.

The MD's Option 3 (delete the dead branch) is the only fix that satisfies the gate without changing the W4 contract. Options 1 and 2 (re-read env / watch .env mtime) would also work but change semantics. Option 3 is the minimum code that solves the problem — matches project CLAUDE.md principle 2 (Simplicity First).

Verdict: Plan correctly identifies the gate problem and the minimum fix.

---

## 2. Test interaction with `vi.resetModules()` — CONFIRMED SAFE

`src/__tests__/inbound-probe-full.test.ts:146` calls `vi.resetModules()` inside `loadInboundProbeFresh()`. Every test in the lifecycle/suite goes through this helper, so each test gets a fresh module instance with `_warnedChatIdAbsent = false` re-initialized.

Within a single test instance (no `vi.resetModules()` between calls), the flag IS shared across ticks. The test on line 546 ("emits debug on subsequent ticks when ALLOWED_CHAT_ID stays absent") relies on tick #1 setting `_warnedChatIdAbsent = true` (line 239) and tick #2 hitting the `else` debug branch (line 240-242). The proposed change only removes the reset on line 246 — which never fires on this path because `allowedChatId` is `null` (the `if (!allowedChatId)` early-return on line 243 bails before reaching line 246). So the test passes unchanged.

The second `vi.resetModules()` usage (line 1013, in the "logs an error when the dynamic import rejects" test) is followed by a fresh `import('../web/inbound-probe.js')`, so the flag is re-initialized to `false` on the new module instance. Unaffected.

Verdict: Removing the reset does not break any test that uses `vi.resetModules()`.

---

## 3. Behavior parity assertion — CONFIRMED

The two tests at lines 535 and 546 still pass:

- **Line 535 test** ("returns early when ALLOWED_CHAT_ID is absent (warn path)"): Only the first warn path fires. Module is fresh. `_warnedChatIdAbsent = false` → `if (!_warnedChatIdAbsent)` → `logger.warn(...)` → `_warnedChatIdAbsent = true`. Unchanged after the edit.

- **Line 546 test** ("emits debug on subsequent ticks when ALLOWED_CHAT_ID stays absent"): Tick 1 sets flag to `true`. Tick 2 sees `true` → `else` branch → `logger.debug('...still absent...')`. The reset at line 246 NEVER fires in this test (the early-return on line 243 bails first). Unchanged after the edit.

The W4 contract test on line 941 ("uses cached ALLOWED_CHAT_ID across ticks") mutates `envFile` to `''` after the first spawn. With the cache, the second tick still sees the cached `'12345'` and spawns. This passes regardless of `_warnedChatIdAbsent` because the cached value is truthy.

Verdict: All three tests pass after the removal.

---

## 4. W4 comment invariant — CONFIRMED (no violation)

The W4 comments at `src/web/inbound-probe.ts:53`, `:193`, `:210` declare the cache invariant. The dead branch on line 246 violates the spirit of W4 (it claims to "reset" a flag when the value reappears, but the cache means the value never reappears in a way that would change the flag from set to unset). Removing the dead branch RESTORES the W4 invariant: the cache is faithfully read-once, and the flag machinery is internal to the warn-then-debug pattern only.

The remove does NOT violate any other documented invariant. There is no test or MD that depends on the reset firing.

Verdict: Removal is consistent with W4.

---

## 5. The other reset line (line 231) — NOT REMOVABLE, but for a different reason

Line 231 (`_warnedSessionMissing = false`) appears to have the same shape as the dead line 246, but the underlying check is different:

- **`_warnedChatIdAbsent` reset** (line 246): The flag would fire if the env-derived `readAllowedChatId()` returned a truthy value on a later tick. BUT the cache (`_cachedAllowedChatId`) is sticky — once read, it never re-reads. So the value can never "now be present" if it was absent before. **Dead.**

- **`_warnedSessionMissing` reset** (line 231): The flag would fire if `existsSync(SESSION_FILE)` returned true on a later tick. The session file check is NOT cached — `existsSync` is called on every tick. So the file can appear between ticks (operator runs the watchdog-userbot login for the first time after dashboard startup). **Alive.**

The MD on `web-inbound-probe-cache-sticky` is specifically about the chat ID cache breaking the reset. The session file reset is a separate, valid one-shot warn-then-debug pattern. The plan correctly does NOT touch line 231.

Verdict: Leaving line 231 alone is correct.

---

## 6. MD heading consistency — CONFIRMED FORMAT

The existing `Resolved:` format in `INDEX.md` is `<YYYY-MM-DD> <sha>` (or `<YYYY-MM-DD> <sha-prefix>`). Examples from the file:

- `Resolved: 2026-08-19 0b61592`
- `Resolved: 2026-08-20 c8ce4a4`
- `Resolved: 2026-08-17 6e5bdd7`

The plan proposes `Resolved: 2026-08-20 <sha>`. This matches the established format.

The current row in `INDEX.md` (line 193) for this bug is:
```
| `web-inbound-probe-cache-sticky` | Defect: ALLOWED_CHAT_ID cache never invalidated, breaking the "reset" branch | — |
```
This is the baseline unreachable addenda format (Bug ID | Title | Resolved). After the fix, the `—` cell becomes `Resolved: 2026-08-20 <sha>`.

Verdict: Format is correct.

---

## 7. Tripwire comment policy — ISSUE FOUND

The proposed new comment is:

> "ALLOWED_CHAT_ID is cached at first read (W4). To pick up a runtime change to .env, restart the dashboard."

Two problems:

**(a) Cycle-reference token**: The `(W4)` is a cycle reference. The project has been systematically stripping cycle/MD/SHA/card/date references from comments in recent chore commits:
- `b0585e5 chore(tests): strip cycle/MD/SHA/card/date references from tests/`
- `b49e8c1 chore(scripts): strip cycle/MD/SHA/card/date references from scripts/`
- `af7021a chore(web): strip cycle/MD/SHA/card/date references from web/app.js`
- `51ad135 chore(tests): strip cycle/MD/SHA references from comments in src/__tests__/`
- `0f07588 chore(web): strip cycle/MD/SHA references from comments in src/web/`

While the existing W4 comments at lines 53, 193, 210 were not stripped (they're code-adjacent documentation of the W4 cache decision), ADDING a NEW W4 reference in a fresh comment is the wrong direction. The new comment should be self-contained.

**(b) Missing forward-compat framing**: The deletion removes a reset that a future cache invalidation path would need to re-introduce. The codebase has a pattern for this: `src/web/channel-health-monitor.ts:24` says "Forward-compat tripwire: spawnDetachedReconnect used to guard on..." — explaining WHY the code was removed and what would resurrect it.

**Recommended wording** (replaces the proposed comment):

```ts
// ALLOWED_CHAT_ID is read once at the first spawn; subsequent ticks use the
// cached value. To pick up a runtime change to .env, restart the dashboard.
// If a future change invalidates the cache (e.g. an .env mtime watcher), the
// warn-then-debug flag below must be re-added.
```

This satisfies the tripwire policy (explains the invariant + the resurrection condition), avoids cycle references, and matches the project's existing tripwire style.

---

## 8. Plan risk: what if the cache IS ever invalidated? — MITIGATED BY ABOVE

**Argument for the current plan (remove the reset, no forward-compat comment)**: The reset is dead today; removing it satisfies the coverage gate; resurrecting it later is trivial and would be caught in code review.

**Argument against (and why forward-compat wins)**: The cycle-36 commit is the LAST commit that "fixes" the chat ID cache behavior. If a future project phase adds a cache invalidation path (option 2 from the MD), that future developer MUST remember to re-add the flag reset or the warn-then-debug pattern will silently desync (the warn will fire once, the debug will fire forever after — even after the cache recovers). Forward-compat tripwire comments are the project's documented hedge against this exact pattern (see `channel-health-monitor.ts:24`).

Adding the second sentence of the recommended wording above (`If a future change invalidates the cache...`) is the smallest change that mitigates this risk without bloating the comment.

---

## Additional check: `_warnedChatIdAbsent` removal safety

The plan also proposes deleting the module-scoped variable on line 60 if no other code references it. Confirmed via `grep -n "_warnedChatIdAbsent" src/web/inbound-probe.ts`:

- Line 60: declaration (`let _warnedChatIdAbsent = false`)
- Line 237: read (`if (!_warnedChatIdAbsent)`)
- Line 239: write (`_warnedChatIdAbsent = true`)

All three are inside `spawnProber`. After the reset on line 246 is removed, the declaration is no longer needed for the cache-invalidation path. The flag is still needed for the warn-then-debug pattern (line 237 / 239). Wait — the line 237 read and line 239 write are BOTH still in the source. The plan only removes the line 246 reset. So the flag is still used by the warn-then-debug pattern. The declaration on line 60 is still needed.

**Re-read the plan**: "Delete the now-dead `_warnedChatIdAbsent` module-scoped variable on line 60 if no other code references it."

This is conditional (`if no other code references it`). After the refactor, the variable IS still referenced (lines 237, 239). So the deletion is NOT done. The plan correctly gates this on a no-other-references check.

Verdict: Conditional step is correctly worded; the variable is NOT deleted in this commit.

---

## Summary of recommended changes to the plan

1. **Replace the proposed comment** with the cycle-free, forward-compat version above.
2. **Keep the conditional variable deletion** (it correctly resolves to "no deletion" after the refactor).
3. **Keep the atomic commit shape** (source + test + INDEX in one commit on `test/baseline`).
4. **Run /code-review xhigh --fix HEAD~1..HEAD after the commit** as planned.

No other changes needed. The plan is structurally sound; the tripwire wording is the only material fix.
