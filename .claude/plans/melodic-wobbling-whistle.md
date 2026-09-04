# Plan: `keychain-store-insecure-acl` Option A + INDEX.md split (Strategy B)

## Context

A `test/baseline` branch-en 178 db `docs/needs-to-be-fix/*.md` halmozódott fel. Közülük egyetlen MD van explicit "Deferred to next cycle" státuszban: a `keychain-store-insecure-acl` (INDEX.md:76). Ez a MD két revertet élt meg (Cycle 16: `0c81522` → `725b1a1`; Cycle 47: `b28e951` → `94650ef`), és az MD "Path to a real fix" szakasza két remaining opciót azonosít:

- **Option A** (smallest viable): `keychainStore` try/catch + user-facing error propagálás. Nem zárja le a `SecKeychain` C API vector-t, de megszünteti a `vault.getMasterKey` mint-branch file-fallback kaszkádot (security downgrade amit a MD azonosít).
- **Option B** (`-A` eltávolítás): headless macOS-en a keychain-unlock prompt továbbra is megjelenik és a daemon nem tudja csendben feloldani. A korábbi két revert tanulsága szerint magas kockázat.

A user az Option A-t választotta.

Emellett az INDEX.md 229 sorra duzzadt és a legutóbbi 5 commit (`330b36d`, `abcf621`, `b8b8844`, `6707483`, `3d6a476`) csupa 1-3 soros SHA-correction a 5 tábla egyikében. A user utasítása: "az indexet kisebb fájlokra kell törni". Az Explore agent Strategy B-t javasolt: 6 files (README + 5 severity) + a 10+ cross-reference MD áthidalása.

A drift-check felfedezett egy további reconciliation itemet: `syntax-check-executes-web-bundle.md:5` "Status: open"-t ír, de `45bb024` (2026-08-17) commit tényleg javította; az MD sosem volt back-annotálva. Ez is beépül a docs-only fázisba.

A két komponens (keychain code fix + INDEX split + drift reconciliation) összevonható, mert:
- A drift reconciliation tisztán docs-only, nulla kockázat.
- Az INDEX split docs-only (kivéve a 10+ MD cross-reference rewrite-ot, ami szintén docs-only).
- A keychain fix Option A tartalmazza az összes adversarial+checklist által azonosított test-bleed kezelést (lásd lent).

A `vault.ts` migration branch (lines 30-42) külön szempont: ott a `VAULT_KEY_PATH` már létezik, így a file a source of truth; a `keychainStore` throw-ot a meglévő warn-nyel elnyelni HIBÁS lenne (a prompt jele elveszne), de a jelenlegi kód MÁR tartalmazza a `logger.warn`-t. Tehát: a migration branch-en hagyjuk a silent-swallow + warn viselkedést (file-alapú visszatérés), ÉS a teszt kommentben dokumentáljuk, hogy a migration best-effort, a keychain push csak opportunisztikus. Ezt az adversarial agent TARGET-1 és TARGET-7 is azonosította; a döntés: NE nyúljunk a migration branchhez, csak a teszt kommentet frissítjük.

## Files to modify (final list)

### Source (Option A keychain fix)
- `src/web/keychain.ts` — wrap `keychainStore` execFileSync in try/catch, throw `KeychainUnavailableError` preserving `err.status`
- `src/web/vault.ts:73-81` — mint branch: propagate `KeychainUnavailableError`, no file-write (migration branch 30-42 unchanged)
- `src/__tests__/keychain.test.ts:171-174` — update `.toThrow('boom')` → `.toThrow(KeychainUnavailableError)` (preserve `err.status` regex)
- `src/__tests__/keychain.test.ts:176-182` — update `.toThrow(/ENOENT/)` → `.toThrow(KeychainUnavailableError)` with message containing "ENOENT"
- `src/__tests__/keychain.test.ts:302-324` — update pinning test comment block (the `-A` pin remains; the cascade rationale is updated)
- `src/__tests__/keychain.test.ts:327-344` — UNCHANGED (keychainRetrieve path unaffected)
- `src/__tests__/vault.test.ts:131-134` — update mock: throw `KeychainUnavailableError` instead of plain `Error`
- `src/__tests__/vault.test.ts:257-271` (test 2, migration) — UNCHANGED (file is source of truth, warn already surfaces the prompt)
- `src/__tests__/vault.test.ts:306-320` (test 5, mint) — INVERT: rename to "propagates KeychainUnavailableError when keychainStore throws on first mint", assert `.toThrow(KeychainUnavailableError)` and `existsSync(VAULT_KEY_PATH)` is FALSE
- `src/__tests__/vault.test.ts` — ADD new test (around line 320, after test 5): "keychainStore throws on first mint (vault empty + retrieve null + store throws) → error propagates, no file written" (already covered by inverted test 5, but explicit test makes the invariant clear)

### Docs (Strategy B INDEX split + drift + MD updates)
- `docs/needs-to-be-fix/INDEX.md` — DELETE after split lands
- `docs/needs-to-be-fix/README.md` — NEW: preamble, corrected counts (55/123, total 178), filter recipe `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' ! -name 'README.md' | wc -l`, links to 5 severity files
- `docs/needs-to-be-fix/high.md` — NEW: 11 rows from INDEX.md:21-31
- `docs/needs-to-be-fix/medium.md` — NEW: 19 rows from INDEX.md:37-55
- `docs/needs-to-be-fix/low.md` — NEW: 25 rows from INDEX.md:61-85 (keychain-store-insecure-acl row will be updated to "Partial — cascade prevention (this commit); -A removal still deferred")
- `docs/needs-to-be-fix/baseline-unreachable.md` — NEW: 99 rows from INDEX.md:96-194
- `docs/needs-to-be-fix/orphan.md` — NEW: 24 rows from INDEX.md:206-229
- `docs/needs-to-be-fix/syntax-check-executes-web-bundle.md:5` — update "Status: open" → "Status: resolved (commit 45bb024, 2026-08-17)"
- `docs/needs-to-be-fix/keychain-store-insecure-acl.md` — ADD new section "Resolution (Option A cascade prevention, this commit)" between current "Path to a real fix" and "Pinning test" sections; replace INDEX.md references at lines 106, 149 with low.md (per CLAUDE.md SHA-placeholder rule: use `(this commit)` placeholder, not inline SHA)
- 10+ MDs referencing `INDEX.md` by name (per TARGET-5):
  - `web-agent-worker-runviaworker-coverage.md:107`
  - `index-283-test-pins-error-wiring.md:92` (the literal `git checkout` command — needs specific file name like `low.md` based on context)
  - `channel-poller-reap-botpid-killed-without-identity-check.md:3`
  - `index-unreachable-coverage.md:6`
  - `openrouter-models-tier1-auto-empty-fallback.md:88`
  - `routes-research-basename-redundant.md:94`
  - `overview-routes-yesterday-timestamp-flake.md:101`
  - `keychain-store-insecure-acl.md:106,149` (the very MD being edited)
  - `multipart-latin1-fields.md:112`
  - `multipart-boundary-greedy.md:111`
  - `index-stopHeartbeat-throw.md:125`
  - Rewrite each `INDEX.md` reference to `README.md` (general) or the specific severity file (when context permits — e.g. `keychain-store-insecure-acl` references → `low.md`)

## Key design decisions

1. **keychainStore wrap preserves err.status**: `new KeychainUnavailableError(`keychain add-generic-password failed (status ${err.status ?? 'unknown'}): ${err.stderr?.toString().trim() ?? 'see launchd logs'} — please unlock the login keychain and retry`)`. The empirical failure case is exit 45 (MD lines 128-145); preserving `err.status` lets the operator distinguish prompt-vs-other failures without consulting launchd.

2. **Migration branch (vault.ts:30-42) unchanged**: file already exists; keychain push is best-effort. The warn at vault.ts:38-40 already surfaces the prompt signal in logs. Test 2 (vault.test.ts:257-271) keeps its current "swallowed + file kept" assertion. Documentation comment in the test is updated to make the "best-effort" semantics explicit.

3. **INDEX split deletes INDEX.md**: Strategy B explicitly. The 10+ MD cross-references are rewritten in the same commit as the deletion (otherwise the deletion lands dangling pointers). Use `low.md` where context permits, `README.md` for general references.

4. **`low.md` row wording for keychain-store-insecure-acl**: NOT a flat `Resolved: <date> <sha>`. The `-A` flag remains in argv (verified `keychain.test.ts:323`). Wording: `Partial — Option A cascade prevention (this commit); -A removal still deferred`. This preserves self-consistency with the test that asserts `toContain('-A')`.

5. **SHA-placeholder rule**: per CLAUDE.md "MD vagy commit message SHA referenciái", all SHA references in commit messages and MD updates use `(this commit)` placeholder. Follow-up commits replace placeholders with actual SHAs. This applies to: keychain-store-insecure-acl.md "Resolution" section, low.md row.

6. **Test atomicity**: source change + test change ship in the same commit. Otherwise the suite goes red in CI between commits (the existing tests at keychain.test.ts:171-182, vault.test.ts:306-320 would fail before the corresponding assertions are updated).

## Verification

### Pre-flight (before any commit)
- Read the cited file:line for every claim above.
- Verify `git rev-parse --abbrev-ref HEAD` returns `test/baseline`.
- Verify `ls store/` is empty (or use worktree per CLAUDE.md rule).
- Verify `vitest.config.ts` coverage gate unchanged.

### Per-phase verify
1. **Phase 1 (drift + INDEX split + cross-references)**: `find docs/needs-to-be-fix -name '*.md' | wc -l` returns 184 (178 MDs + README + 5 new files = 184). `find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' ! -name 'README.md' | wc -l` returns 178 (matches old count). `grep -rn 'INDEX.md' docs/` returns 0 hits outside `needs-to-be-fix/` and the new README. Per-row counts match the explore agent's analysis (11/19/25/99/24 = 178).
2. **Phase 2 (keychain fix + tests)**: `bun --bun vitest run src/__tests__/keychain.test.ts src/__tests__/vault.test.ts` in a clean worktree (`git worktree add --detach /tmp/claw-test test/baseline` + `ln -sf node_modules`) per CLAUDE.md temp-worktree rule. All target tests pass; no new failure elsewhere in the suite.
3. **Phase 3 (MD updates)**: low.md row count unchanged (25); keychain-store-insecure-acl.md has the new "Resolution" section. Both use `(this commit)` placeholder.

### Double verification (Phase 4)
Per CLAUDE.md "Dupla ellenőrzésnél a két verifier kapjon ELTÉRŐ szöget":
- **Verifier A** (checklist, PASS/FAIL with file:line evidence): verify each of the 19 specific test/source/doc changes above landed correctly, with the right comment updates.
- **Verifier B** (adversarial falsification): independently attempt to break the fix. Specifically:
  - Does `keychainStore` still throw `KeychainUnavailableError` on non-prompt failures (ENOENT)?
  - Does the mint branch in vault.ts still write `VAULT_KEY_PATH` if `keychainStore` succeeds? (regression check)
  - Does the migration branch still work end-to-end? (regression check)
  - Is the README.md filter recipe correct?
  - Does the cross-reference rewrite preserve "see also" semantics?
- Each verifier runs in a separate `git worktree add --detach` worktree (Agent tool, not Workflow tool, per CLAUDE.md dispatch rule).
- SHAs from verifier-detached commits are merged back via `git merge --ff-only <SHA>` after `git worktree remove --force`, per CLAUDE.md worktree-isolation rule.

### Final
- `bun run typecheck` zöld.
- `git status` clean on `test/baseline`.
- User-triggered `/code-review max --fix` skill (manual invocation, per CLAUDE.md — Skill tool refuses `disable-model-invocation`).

## Workflow

A user kérésére workflow-val végrehajtva. Script: `.claude/plans/apply-keychain-and-index-split.js`. Phases:

1. **Phase 1 — Drift + INDEX split** (docs-only, single workflow agent)
   - 1 commit: `docs(needs-to-be-fix): split INDEX.md into 5 severity files + README, fix syntax-check-executes-web-bundle drift, rewrite 10+ cross-references`
   - Verify: row counts (11+19+25+99+24=178), filter recipe, zero `INDEX.md` references remain outside the new README.
2. **Phase 2 — Keychain fix + tests** (code change)
   - 1 commit: `fix(keychain+vault): surface keychainStore prompt as user-facing KeychainUnavailableError instead of silent file-fallback cascade (Option A)`
   - Test atomicity: source + test changes in same commit.
   - Verify: targeted test suite green in clean worktree; no coverage gate fails.
3. **Phase 3 — MD updates**
   - 1 commit: `docs(needs-to-be-fix): add Resolution section to keychain-store-insecure-acl.md + update low.md row (this commit placeholder per CLAUDE.md)`
   - Verify: MD sections present, placeholder used, low.md row wording self-consistent.
4. **Phase 4 — Double verification**
   - Agent A (checklist, worktree-isolated): PASS/FAIL on each of the 19 changes.
   - Agent B (adversarial, worktree-isolated): try to break the fix.
   - Merge verified commits via `git merge --ff-only` (per CLAUDE.md).
5. **Phase 5 — User-triggered /code-review max --fix**
   - The CLAUDE.md notes the skill has `disable-model-invocation`; the user must invoke it manually in the terminal. Document this in the workflow script's final log line.

NO push. Commits stay local.

## Critical files reference

- /Users/eggp/marveen-develop/test-baseline/src/web/keychain.ts (71 lines)
- /Users/eggp/marveen-develop/test-baseline/src/web/vault.ts (189 lines)
- /Users/eggp/marveen-develop/test-baseline/src/__tests__/keychain.test.ts (358 lines)
- /Users/eggp/marveen-develop/test-baseline/src/__tests__/vault.test.ts (675 lines)
- /Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/INDEX.md (229 lines, DELETE)
- /Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/keychain-store-insecure-acl.md (283 lines, ADD section + UPDATE cross-refs)
- /Users/eggp/marveen-develop/test-baseline/docs/needs-to-be-fix/syntax-check-executes-web-bundle.md (drift fix at line 5)
- 10+ MDs with INDEX.md cross-references (TARGET-5 list)