# F.4 SettingsStore — /code-review max --fix Skipped findings (2026-09-08)

The /code-review skill returned 5 Skipped findings for the F.4 cycle (commits ac13503 + bd0e1aa + da5f86b on `refactor/classbase`). All 5 are NOT bugs — they are documented test-design tradeoffs or acknowledged anti-patterns. NONE require in-session fix; all go to Honcho per CLAUDE.md §6 Skipped rule.

## 1. T5 per-instance isolation: only holds under mocked fs.watch

In production, two SettingsStore instances watching the same STORE_DIR would cross-pollute via real OS watch events. This is a documented test-design tradeoff: the mock provides deterministic isolation, matching F.3 `store-watcher.test.ts` precedent. Not a code bug.

## 2. `__test_handleWatchEvent` event-coercion ternary

`src/settings-store.ts:70` `typeof event === 'string' ? event : 'rename'` — Looks like dead forwarding because `onFsEvent` ignores its first arg, but the ternary provides type narrowing from `unknown` to `string` for the arrow-property call. Removing it would force an `as string` cast that is uglier than the current form. Keep as-is.

## 3. Redundant `mkdirSync(STORE_DIR, { recursive: true })` in `setOverride` after `ensureWatching()`

Pre-existing in the original free-fn form (`src/settings-store.ts:100` in pre-F.4), NOT introduced by the class-extract refactor. Out of scope per the plan ("Class + thin re-export shim" — minimal change scope).

## 4. Free-fn shim wrappers without production consumer

Anti-pattern per `.claude/rules/class-vs-functional-decision.md` line 30 ("Class ami singleton-ként használatos lenne, de App constructor-on át sem kapja meg"). SettingsStore meets 3/5 conditions (instance state + lifecycle + DI + testability), so the class is JUSTIFIED per the rule's 2/5 threshold. The migration cost (import surface preservation for 13 vi.mock sites) requires the shims. Follows the F.3 StoreWatcher precedent exactly.

## 5. `as unknown as LoggerLike` casts in test

The test reaches across TS-private boundaries (necessary for DI verification). Same pattern as `src/__tests__/store-watcher.test.ts:754` (which the project already accepts). Keep as-is.

## Cycle status

The F.4 cycle is COMPLETE:
- 3 commits landed on `refactor/classbase`:
  - `ac13503` — `refactor(settings-store): extract SettingsStore class with thin re-export shim (F.4)`
  - `bd0e1aa` — `fix(test): make T6 spread assertion load-bearing (Fork B HIGH)` (workflow verifier feedback, in-session)
  - `da5f86b` — `fix(test): clarify T3e comment (full-filename match, not basename)` (`/code-review max --fix` Applied, post-fix commit)
- All gates HOLD (vitest 11446 PASS, tsc 0 errors, lint 10530 — NET -88 vs parent commit 224172e:10618)
- 1 Applied /code-review fix auto-committed (da5f86b)
- 5 Skipped documented in this entry (dual-write Honcho + shared-memory per CLAUDE.md §7)
- No `git push` performed (CLAUDE.md §6 push-tiltás)
