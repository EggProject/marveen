# keychain.ts: `keychainStore` passes `-A`, the flag `security(1)` itself labels "insecure, not recommended", for the vault master key

## Location

`src/web/keychain.ts`, lines 12-21 (`keychainStore`):

```ts
export function keychainStore(value: string): void {
  execFileSync(SECURITY, [
    'add-generic-password',
    '-U',
    '-s', SERVICE,
    '-a', ACCOUNT,
    '-w', value,
    '-A',
  ], { stdio: ['ignore', 'ignore', 'ignore'] })
}
```

## Excerpt

`-A` sets an empty trusted-application list on the item's ACL. From the
macOS `security(1)` man page, verbatim:

```
-A		Allow any application to access this item without
		warning (insecure, not recommended!)
```

The item being written is the vault master key: the single AES-256-GCM key
that `src/web/vault.ts` derives every stored secret from
(`vault.ts:65-91`). It is the highest-value item the product owns.

**Severity is low, not high, and the reason matters.** Dropping `-A` does not
close the exposure. An item created by `/usr/bin/security` without `-A` gets
`/usr/bin/security` itself as its sole ACL entry, and *any* local process can
invoke `/usr/bin/security find-generic-password` -- so the credential is
readable with no prompt either way. This is the exact weakness Silverfort
published against the Claude Code CLI keychain item (see Sources), and that
item carries no `-A` at all.

What `-A` adds on top is narrower but real:

- The key becomes readable through the `SecKeychain` C API directly, not only
  by way of an `exec` of `/usr/bin/security`. That matters wherever exec is
  the constrained resource: a sandboxed app, or a host where an EDR/execution
  policy flags or blocks `security` invocations. `-A` removes the one
  observable chokepoint a defender could monitor.
- It contradicts an explicit vendor warning in the tool's own documentation,
  which is the kind of thing a security review or a compliance audit flags on
  sight.
- It is very likely redundant. `-A` was presumably added to suppress an
  access prompt, but since reads go back through `/usr/bin/security` -- the
  binary already in the default ACL -- the prompt should not occur without it.
  This is stated as a hypothesis: it was not verified empirically, because
  doing so requires writing to the operator's real login keychain, and a
  wrong guess pops a GUI dialog.

## Failure scenario

1. Marveen runs on a shared or multi-profile macOS host, or the operator runs
   any untrusted code as their own uid (an `npm install` postinstall script, a
   VS Code extension, a downloaded binary).
2. That code links `Security.framework` and issues a
   `SecItemCopyMatching` for service `com.marveen.vault`, account
   `master-key`. It never execs anything.
3. With `-A` the ACL is empty, so the copy succeeds with no prompt and no
   user interaction.
4. The attacker now holds the master key. Combined with `store/vault.json`
   (mode `0600`, but same-uid, so readable by the same process) every secret
   in the vault decrypts offline: `scryptSync(master, salt)` then
   AES-256-GCM, all parameters carried in the ciphertext blob
   (`vault.ts:80-91`).

Without `-A` step 3 requires spawning `/usr/bin/security`, which still
succeeds -- hence "low". The delta is purely the loss of the exec chokepoint
and the vendor-flagged ACL.

## Attempted fix in Cycle 16 and reason for revert

The fix in commit `0c81522` (2026-08-16) removed `-A` from the args array and
inverted the pinning test (asserted `not.toContain('-A')`). Local vitest passed
because the test mocks `execFileSync` -- it does not exercise real keychain
behavior.

In a headless install (Marveen runs as a background daemon; the operator
authorised it once and it has no UI), removing `-A` causes the macOS keychain
to **prompt for access** the first time the app reads the master key. The
prompt is invisible in headless mode. `keychainRetrieve` swallows the
resulting error as `null` (`src/web/keychain.ts:32-34`), which `vault.ts:44-49`
reads as "no key yet" and answers by minting + storing a **replacement master
key** (with `-U`). The vault is effectively re-keyed, and every previously
stored secret becomes undecryptable.

This is exactly the cascade the MD's own "Suggested direction" calls out:
> "Note the interaction with `keychain-retrieve-swallows-locked-keychain`:
> until that is fixed, a prompt introduced here would be silently swallowed
> as null and would trigger a vault re-key. **Fix that one first.**"

The MD's hypothesis was that `-A` is redundant -- that the prompt should not
occur without it because `/usr/bin/security` is already in the default ACL.
In this install the hypothesis does not hold: a real prompt is raised on
first access, and `-A` is the only thing suppressing it.

The fix was reverted in `725b1a1`. The pinning test was restored to its
original `toContain('-A')` assertion, and the low.md row was re-marked as
unresolved in `974f46a`.

## Second attempted fix (2026-08-26, `b28e951`) and reason for revert (`94650ef`)

After the Cycle 16 revert, the unblocking prerequisite identified in the
MD's own "Path to a real fix" step 1 was implemented in commit `6e5bdd7`
(2026-08-17): `keychainRetrieve` now discriminates exit 44 (genuine absence
-> `null`) from any other exit / ENOENT / non-Error throw, and raises a new
`KeychainUnavailableError` in the latter case. With that fix in place, a
prompt cascade from a missing `-A` could no longer trigger a vault re-key.

Building on the cleared prerequisite, commit `b28e951` (2026-08-26 11:54)
attempted the MD's "Suggested direction" step 1 and replaced `-A` with
`-T, SECURITY` at `src/web/keychain.ts:32`:

```diff
-    '-A',
+    '-T', SECURITY,
```

`security(1)` is in the trusted-app list by default, so the replacement
should have been a no-op semantically -- no prompt should have been
raised. On this headless macOS install the hypothesis did not hold. The
empirical observation (Honcho HOT memory, 2026-08-26):
`add-generic-password -U -s com.marveen.vault -a master-key -T /usr/bin/security -w ...`
exited with status **45** ("User canceled.") on the first call over an
SSH session because the login keychain was locked and the daemon could
not satisfy the keychain-unlock prompt invisibly. `keychainRetrieve` did
the right thing on the first iteration (returned `null` for exit 44, the
genuine "no key yet" case), so `vault.getMasterKey` minted a new key and
called `keychainStore`; the `-T SECURITY` write then hit the same locked
keychain prompt and `execFileSync` threw exit 45. `vault.ts:74-80`
caught the throw and wrote a file-based master key to `store/.vault-key`
(mode `0600`). That file is readable by any same-uid process on the host
-- a security **downgrade** relative to the `-A` keychain ACL, which at
least keeps the `SecKeychain` C-API direct-read vector blocked. (Same-uid
readers still need to exec `/usr/bin/security find-generic-password` or
call the `SecKeychain` C API directly; both are observable chokepoints a
defender can monitor.)

The fix was reverted in `94650ef` (2026-08-26 13:08). This second revert
restored `src/web/keychain.ts:32` to `-A`, restored the pin test's
`toContain('-A')` assertion, and re-marked the low.md row as Deferred.
The unblocking prerequisite from cycle 47
(`keychain-retrieve-swallows-locked-keychain.md`, `6e5bdd7`) is
**preserved** -- a prompt cascade over SSH still cannot re-key the vault.
The blocker is no longer the missing throw: it is the file-based
fallback that the throw cascades into.

Refs: `b28e951`, `94650ef`, HOT memory "-T SECURITY + -U exit-45
reproduction (2026-08-26)".

## Path to a real fix

The MD's "Suggested direction" step 1 was applied **only after**
`docs/needs-to-be-fix/keychain-retrieve-swallows-locked-keychain.md` was
fixed:

1. Fix `keychainRetrieve` to surface prompts as actionable errors (exit 36 →
   specific error class) instead of returning `null`. After this fix, a
   missing key and a locked keychain are distinguishable.
   -- **Done (2026-08-17, commit `6e5bdd7`).** `keychainRetrieve` now
   discriminates exit 44 (genuine absence → `null`) from any other exit /
   ENOENT / non-Error throw, and raises a new `KeychainUnavailableError`
   in the latter case. `vault.getMasterKey` catches the throw, marks the
   call as failed, and refuses to mint a replacement whenever the vault
     already holds secrets. First-run (vault empty + unreachable keychain)
     still mints, per the MD's "worth pairing with" note. The
   `keychain-retrieve-swallows-locked-keychain.md` row is closed.
2. Replace `-A` with `-T, SECURITY` (explicit trusted application list
   limited to `/usr/bin/security` itself).
   -- **Empirically tested (2026-08-26, commit `b28e951`) and reverted
   (`94650ef`).** On this host the replacement still surfaces a
   keychain-unlock prompt the daemon cannot satisfy silently over SSH.
   `keychainRetrieve` correctly returns `null` on the first call (genuine
   absence, exit 44), so `vault.getMasterKey` mints a new key, then
   `keychainStore` hits the same prompt and throws; the catch at
   `vault.ts:74-80` falls through to its file-based-key fallback (writes
   `store/.vault-key` mode `0600`), which is a security **downgrade**
   relative to the `-A` keychain ACL (the file is same-uid-readable;
   `-A` at least blocks the `SecKeychain` C-API direct-read vector for
   sandboxed / EDR-monitored callers). Step 2 is therefore **not viable
   on this host** in its current form -- see "Second attempted fix"
   above for details.
3. **The only remaining viable path** is to wrap `keychainStore` in
   `try/catch` and surface the prompt as a user-facing error the operator
   can interactively resolve (unlock the keychain, then retry), OR arrange
   for the daemon to start **after** the login keychain is unlocked in the
   launchd session bootstrap. Both are larger changes and are separate
   decisions. The `SecAccessControl` / native-binding option (the original
   step 3) also remains viable but is a much larger change of a different
   shape.

Until one of the options in step 3 lands, `-A` must stay and the row
remains Deferred.

## Resolution (Option A cascade prevention, this commit)

As of `c54317e` (see the `fix(keychain+vault)` commit on `test/baseline`), the
file-fallback cascade described in the "Second attempted fix" section above is
**eliminated**:

- `src/web/keychain.ts` `keychainStore` now wraps its `execFileSync` call in
  `try`/`catch`, throwing `KeychainUnavailableError` with a descriptive message
  that preserves `err.status` (so the operator can distinguish a locked-keychain
  prompt at exit 45 from an ENOENT / spawn failure).
- `src/web/vault.ts` mint branch (lines 77-84) now **propagates**
  `KeychainUnavailableError` instead of falling back to writing
  `store/.vault-key` mode 0600. The migration branch (lines 30-42) is unchanged
  because the file is the source of truth there — the keychain push is
  best-effort, and the existing `logger.warn` already surfaces the prompt in
  the logs.
- The regression pin in `src/__tests__/vault.test.ts` (test 5 + new test 6)
  exercises the new invariant: a `keychainStore` throw on first mint
  propagates and does **not** write the file.

**`-A` removal remains deferred.** This resolution eliminates the file-fallback
cascade but does NOT close the `SecKeychain` C API direct-read vector; `-A`
stays in argv at `src/web/keychain.ts:33` because the operator-side prompt
behavior on headless macOS still requires `-A` to suppress the prompt cascade
that the daemon cannot satisfy silently over SSH. Removing `-A` is a separate
decision that requires operator-side validation per the MD's "Path to a real
fix" step 3.

The `low.md` row for `keychain-store-insecure-acl` is updated to
`Partial — Option A cascade prevention (`c54317e`); -A removal still deferred`,
preserving self-consistency with the test that asserts `toContain('-A')`.

## Pinning test

`src/__tests__/keychain.test.ts`, describe block
`keychain.ts - known deviations (pinning)`:

- `passes -A, the flag security(1) itself calls insecure`

```ts
mocks.execFileSync.mockReturnValue('')
keychainStore('master')
expect(onlyCall().args).toContain('-A')
```

This MUST fail once the flag is removed; delete the assertion (or invert
it to `not.toContain('-A')`) as part of any fix that successfully
replaces `-A`. Note: the test's inline comment (lines 303-320 of the test
file) was rewritten in `a5e2318` (2026-08-26) to remove stale claims from
the Cycle 16 era. The OLD comment falsely claimed (a) "a prompt would be
silently swallowed as null by keychainRetrieve, triggering vault re-key"
(false since `6e5bdd7` makes keychainRetrieve throw
`KeychainUnavailableError` instead) and (b) "Until
keychain-retrieve-swallows-locked-keychain is fixed first, -A must stay"
(the prerequisite is already satisfied). The NEW comment describes the
actual blocker -- the prompt cascades into `vault.getMasterKey`'s
file-based-key fallback writing `store/.vault-key` mode `0600`, a
security DOWNGRADE relative to the `-A` ACL -- without citing specific
`vault.ts:` line ranges. The MD's "Pinning test" excerpt above matches
the assertion; it does not transcribe the comment block.

## Suggested direction (post-Resolution update)

Step 1 below was implemented as part of the Option A cascade-prevention
fix (see "Resolution (Option A cascade prevention, this commit)" above).
`-T, SECURITY` is no longer the next thing to try; instead, it would now
be the OPTION B continuation (separate decision, see "Path to a real fix"
step 3 above). The text below is preserved for historical context.

---

The MD's original step 1 (`-T, SECURITY`) has been **empirically tested
on this host** and shown to fail (see "Second attempted fix" above). The
viable paths are now two larger changes:

1. **Wrap `keychainStore` in `try/catch` and surface the prompt as a
   user-facing error.** (Implemented as Option A in `c54317e` —
   see the "Resolution (Option A cascade prevention, this commit)"
   section above.) The current implementation previously had no
   `try/catch` (`keychain.ts:25-34`; now implemented at `keychain.ts:25-48`
   per the Resolution section); `execFileSync` throws on a prompt, the throw
   propagates up through `vault.getMasterKey`, and the file-based-key
   fallback at `vault.ts:73-81` writes `store/.vault-key` mode `0600`. The
   operator then has no signal that anything went wrong. A `try/catch`
   that converts the throw into a recoverable, user-facing error (e.g.
   "Login keychain is locked; please unlock it and retry") lets the
   operator satisfy the prompt interactively and retry, eliminating the
   file-fallback cascade. This is the smallest viable fix on this host.

2. **If the master key genuinely needs to resist same-uid reads**, the CLI
   wrapper is the wrong primitive entirely -- `security(1)` cannot express
   `kSecAccessControlUserPresence`, and as the `b28e951`/`94650ef` cycle
   showed, the prompt-cascade into a file-based fallback is a security
   downgrade rather than an improvement. That requires the
   `SecAccessControl` API via a native binding, which is a much larger
   change and should be its own decision. Alternatively, **launch the
   daemon after the login keychain is unlocked** in the launchd session
   bootstrap, so the prompt never fires in production; this is also a
   separate decision and out of scope for a code-only fix.

Per the task rule "NEVER modify src/web/keychain.ts" this was not applied
during the original survey (Cycle 16). Outside the baseline closure
cycle (see the "Scope note" at the bottom of this MD) source edits are
permitted when the fix is justified.

## Sources

- `man 1 security` on macOS (local, Darwin 24.3.0), `add-generic-password`
  section: `-A  Allow any application to access this item without warning
  (insecure, not recommended!)`.
- <https://github.com/yo-yo-yo-jbo/macos_key_redefinition/> -- "Note the `-A`
  flag which sets up an empty ACL for the item, making all applications
  accessible to this [item]".
- <https://www.silverfort.com/blog/skipping-the-lock-a-claude-code-cli-weakness-lets-any-macos-process-read-stored-credentials/>
  -- "`security` is the only entry in the ACL, so a single query with no
  prompts lets any user-mode process read the [credentials]". This is the
  source for the "removing `-A` is not sufficient" caveat above.
- <https://objectivebythesea.org/v5/talks/OBTS_v5_cThomas.pdf> ("Lock Picking
  the macOS Keychain") -- '"No application" means "without prompting for user
  consent"'.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
