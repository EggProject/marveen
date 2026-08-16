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
because the test mocks `execFileSync` — it does not exercise real keychain
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

The MD's hypothesis was that `-A` is redundant — that the prompt should not
occur without it because `/usr/bin/security` is already in the default ACL.
In this install the hypothesis does not hold: a real prompt is raised on
first access, and `-A` is the only thing suppressing it.

The fix was reverted in `725b1a1`. The pinning test was restored to its
original `toContain('-A')` assertion, and the INDEX row was re-marked as
unresolved in `974f46a`.

## Path to a real fix

The MD's "Suggested direction" step 1 can be applied **only after**
`docs/needs-to-be-fix/keychain-retrieve-swallows-locked-keychain.md` is fixed:

1. Fix `keychainRetrieve` to surface prompts as actionable errors (exit 36 →
   specific error class) instead of returning `null`. After this fix, a
   missing key and a locked keychain are distinguishable.
2. Then replace `-A` with `-T, SECURITY` (explicit trusted application list
   limited to `/usr/bin/security` itself). Verify on a real host that reads
   still complete without a prompt in a non-interactive session. A prompt at
   this stage must surface as a real error, not as a vault re-key.
3. Optionally tighten further with `SecAccessControl` / native binding, but
   that is a much larger change and a separate decision.

Until step 1 lands, `-A` must stay and the row remains open.

## Pinning test

`src/__tests__/keychain.test.ts`, describe block
`keychain.ts - known deviations (pinning)`:

- `passes -A, granting every process on the box read access`

```ts
mocks.execFileSync.mockReturnValue('')
keychainStore('master')
expect(onlyCall().args).toContain('-A')
```

This MUST fail once the flag is removed; delete the assertion (or invert it to
`not.toContain('-A')`) as part of the fix.

## Suggested direction

Two steps, in order:

1. Replace `-A` with an explicit trusted application:

   ```ts
   '-T', SECURITY,
   ```

   Verify on a real host first that reads still complete without a prompt --
   over SSH a prompt manifests as exit 36, so
   `keychainStore` + `keychainRetrieve` in one non-interactive session is a
   sufficient check. Note the interaction with
   `keychain-retrieve-swallows-locked-keychain`: until that is fixed, a
   prompt introduced here would be silently swallowed as `null` and would
   trigger a vault re-key. **Fix that one first.**

2. If the master key genuinely needs to resist same-uid reads, the CLI
   wrapper is the wrong primitive entirely -- `security(1)` cannot express
   `kSecAccessControlUserPresence`. That requires the `SecAccessControl` API
   via a native binding, which is a much larger change and should be its own
   decision.

Per the task rule "NEVER modify src/web/keychain.ts" this was not applied.

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
