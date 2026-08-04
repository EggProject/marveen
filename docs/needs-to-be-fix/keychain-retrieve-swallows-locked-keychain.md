# keychain.ts: `keychainRetrieve` maps a LOCKED keychain to `null`, and vault.ts answers by minting a replacement master key (permanent data loss)

## Location

`src/web/keychain.ts`, lines 23-35 (`keychainRetrieve`):

```ts
export function keychainRetrieve(): string | null {
  try {
    const out = execFileSync(SECURITY, [
      'find-generic-password',
      '-s', SERVICE,
      '-a', ACCOUNT,
      '-w',
    ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim() || null
  } catch {
    return null
  }
}
```

## Excerpt

The bare `catch { return null }` collapses two states that are not
equivalent:

1. **The item does not exist.** `security` exits 44 with
   `SecKeychainSearchCopyNext: The specified item could not be found in the
   keychain.` `null` is the correct answer: there is no key yet.
2. **The item exists but is unreachable.** The dominant case is
   `errSecInteractionNotAllowed` (`-25308`), which `security(1)` surfaces as
   exit 36 / `User interaction is not allowed.` This is the *normal* state of
   a login keychain in two very common situations: a process launched from a
   non-interactive SSH session, and any background process started before the
   user has logged in to the GUI after a reboot. `null` is a lie here: the
   key exists and is intact, it is merely locked.

Related non-existence failures land in the same arm: `-25307`
(`errSecNoSuchKeychain`), `-25300` (`errSecItemNotFound` raised against a
keychain that failed to open), and `ENOENT` if `/usr/bin/security` is absent
(nothing gates the exec on `isKeychainAvailable()`).

`stderr` is captured with `'pipe'` and then discarded, so the distinguishing
information is fetched and thrown away. `execFileSync` also attaches `status`
to the thrown error, so the exit code is available and unused.

Contrast `keychainDelete` (lines 37-48), which returns a boolean and so at
least tells the caller that *something* failed. `keychainRetrieve` has no
such channel: `null` is both "absent" and "error".

## Failure scenario

The consumer is `getMasterKey` in `src/web/vault.ts:30-63`:

```ts
const existing = keychainRetrieve()
if (existing) return Buffer.from(existing, 'base64')

const newKey = randomBytes(64).toString('base64')
try {
  keychainStore(newKey)          // add-generic-password -U  => OVERWRITES
  logger.info('New vault master key stored in macOS Keychain')
} catch (err: any) { ... }
return Buffer.from(newKey, 'base64')
```

Step by step, on a macOS host whose vault already holds secrets:

1. The machine reboots, or an operator starts the process over
   `ssh host 'npm start'`. The login keychain is locked.
2. `getMasterKey` runs. `existsSync(VAULT_KEY_PATH)` is false (the file key
   was migrated to the Keychain on an earlier run and renamed to
   `.vault-key.migrated`, `vault.ts:36`), so the migration branch is skipped.
3. `keychainRetrieve()` hits exit 36 and returns `null`.
4. `vault.ts:47` mints a fresh 64-byte master key.
5. `keychainStore(newKey)` runs `add-generic-password -U`. `-U` is
   documented as "Update item if it already exists"
   (`security(1)`), so **the surviving original master key is overwritten
   in place**. Note this write can succeed while the read failed: adding an
   item does not require the same ACL evaluation as reading one back.
6. `logger.info('New vault master key stored in macOS Keychain')` is emitted.
   There is no warning and no error anywhere in the sequence.
7. Every pre-existing entry in `store/vault.json` was encrypted under the old
   key. `decrypt` (`vault.ts:80-91`) now derives the wrong AES-256-GCM key,
   and `decipher.final()` throws `Unsupported state or unable to
   authenticate data` for **every** secret.

The loss is unrecoverable once step 5 lands: the only copy of the old key was
the keychain item that `-U` just replaced, and `.vault-key.migrated` is the
*pre-migration* file that no longer exists on any host that installed after
the migration path was retired.

Blast radius is every secret the vault holds; `getSecretsForEnv`
(`vault.ts:136-143`) silently drops each one it cannot decrypt only because
`getSecret` throws first, so the practical symptom is agents starting with
missing credentials and a stack trace, not a clean error.

Two aggravating details:

- Step 5's success is logged at `info` as if it were a healthy first-run,
  which is exactly the message an operator would scroll past.
- The window reopens on every locked-keychain boot, so a host in this state
  re-keys the vault repeatedly.

## Pinning test

`src/__tests__/keychain.test.ts`, describe block
`keychain.ts - known deviations (pinning)`:

- `reports a LOCKED keychain identically to a MISSING item (both null)`

```ts
const locked = Object.assign(new Error('User interaction is not allowed.'), { status: 36 })
mocks.execFileSync.mockImplementation(() => { throw locked })
expect(keychainRetrieve()).toBeNull()
// ... and the exit-44 "item could not be found" case, also null
```

The suite also pins the benign half of the conflation in
`keychainRetrieve - find-generic-password`:

- `returns null when security exits non-zero (item not found)`
- `returns null when /usr/bin/security is missing (non-darwin host)`

Once the signature is widened these MUST fail: the not-found case should stay
`null` while the locked case becomes a throw (or a discriminated result).

## Suggested direction

The fix has to change the return type; there is no way to signal "exists but
unreachable" through `string | null`. Smallest change that preserves the
existing call shape:

```ts
export class KeychainUnavailableError extends Error {}

export function keychainRetrieve(): string | null {
  try {
    const out = execFileSync(SECURITY, [...], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
    return out.trim() || null
  } catch (err) {
    // exit 44 == item genuinely absent; anything else is an access failure
    if (isExecError(err) && err.status === 44) return null
    throw new KeychainUnavailableError(String(err))
  }
}
```

`isExecError` should be a real typeguard in the project style (`unknown` in,
`err is { status?: number }` out) rather than a cast, per the repo's
no-`as`/no-`any` rule.

`getMasterKey` (`vault.ts:44`) then has to treat the throw as fatal and
refuse to mint a replacement: re-keying must only ever happen when the
keychain positively reports the item as absent. Failing loudly at startup is
strictly better than silently destroying the vault.

Worth pairing with a defensive guard in `vault.ts`: if `store/vault.json`
already has entries, a fresh master key should never be generated at all,
whatever the keychain says.

Per the task rule "NEVER modify src/web/keychain.ts" this was not applied.

## Sources

- `man 1 security` on macOS (local, Darwin 24.3.0): `-U  Update item if it
  already exists (if omitted, the item cannot already exist)`.
- <https://georgegarside.com/blog/macos/macos-security-error-codes/> --
  `-25308  User interaction is not allowed.`
- <https://gist.github.com/lukele/1eb821c9d8fa71cc5ec0f18fcbd1bfd4> --
  "User interaction is not allowed" when a password is requested from the
  macOS Keychain via Terminal/SSH.
- <https://forums.docker.com/t/docker-login-fails-with-error-message-error-saving-credentials-error-storing-credentials-err-exit-status-1-out-user-interaction-is-not-allowed/117006>
  -- same error from a CLI keychain write; resolved with
  `security unlock-keychain`.
