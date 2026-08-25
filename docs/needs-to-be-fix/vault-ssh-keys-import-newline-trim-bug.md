# vault-ssh-keys.ts: the import handler's `endsWith('\n')` branch is unreachable

## Location

`src/web/routes/vault-ssh-keys.ts`, lines 112-126 (the `POST /api/vault/ssh-keys/import` handler).

## Excerpt

```ts
const label      = typeof data.label      === 'string' ? data.label.trim()      : ''
const username   = typeof data.username   === 'string' ? data.username.trim()   : ''
const privateKey = typeof data.privateKey === 'string' ? data.privateKey.trim() : ''   // <-- trim strips trailing '\n'

if (!label || !username || !privateKey) {
  json(res, { error: 'label, username and privateKey are required' }, 400)
  return true
}

// Validate key and extract public key via ssh-keygen -y (same pattern as extractPublicKeyFromVault)
const tmpDir = mkdtempSync(join(tmpdir(), 'marveen-ssh-'))
const keyPath = join(tmpDir, 'key')
let publicKey: string
try {
  const keyContent = privateKey.endsWith('\n') ? privateKey : privateKey + '\n'    // <-- IF branch is unreachable
  writeFileSync(keyPath, keyContent, { mode: 0o600 })
  chmodSync(keyPath, 0o600)
  publicKey = execFileSync('ssh-keygen', ['-y', '-f', keyPath], { stdio: 'pipe' }).toString().trim()
```

## Failure scenario

The intent of the ternary on line 126 is clearly "if the user's private
key already ends in a newline, don't add another one; otherwise
normalise by adding one". But the `privateKey` variable on the left
side of the ternary was `.trim()`-ed two lines earlier, and `\n` is
classified as whitespace by `String.prototype.trim()`. So after the trim
call there is no string left on which `.endsWith('\n')` can return
`true` -- the IF branch can never be reached.

Concrete reproducer (no test setup needed; pure runtime observation):

```js
'key\n'.trim()           // -> 'key'         (newline IS whitespace, trim removes it)
'key\n'.trim().endsWith('\n')   // -> false
```

Effects of the bug:
  1. The IF branch (no-appending) is dead code; branch coverage on this
     line will report one of the two outcomes as never-hit no matter
     how exhaustively the import handler is tested.
  2. A user pasting an SSH key whose final non-whitespace line is not
     newline-terminated (the more common form when keys are joined
     programmatically rather than copied from `ssh-keygen`) still gets a
     single newline appended, which is the *intended* outcome.
  3. A user pasting an SSH key with multiple trailing newlines (or any
     non-trailing-newline whitespace at the end -- the latter is what
     `trim()` already strips) loses that trailing newline forever.
     `ssh-keygen -y -f` tolerates this so the key still imports, but
     the on-disk representation diverges from the user's input.

The right fix is to either:
  (a) Capture the un-trimmed private key for the newline check:

  ```ts
  const rawPrivateKey = typeof data.privateKey === 'string' ? data.privateKey : ''
  const privateKey = rawPrivateKey.trim()
  ...
  const keyContent = rawPrivateKey.endsWith('\n') ? privateKey : privateKey + '\n'
  ```

  (b) Or move the trim after the newline decision so the check sees the
      original input. The validation chain (the `!privateKey` falsy
      check on line 116) doesn't care whether `\n` is part of the value
      or not, so re-ordering is safe.

## Pinning test

`src/__tests__/routes-vault-ssh-keys.test.ts` includes a test titled
"PIN: preserves multiple trailing newlines on the imported private
key (currently fails)". It posts `privateKey: 'one\n\n'` and asserts
that the on-disk temp key file ends up with `'one\n\n'`. On the
current source this assertion FAILS -- the buggy ELSE branch always
runs, `.trim()` strips both newlines, and the file ends up with
`'one\n'`. Once the source is fixed per (a) or (b) above, the
assertion passes.

This is the only branch on `vault-ssh-keys.ts` that 100% line+branch
coverage cannot reach without a source change. The coverage report
will show `100% lines / 100% statements / 100% functions / 98.48%
branches` with the uncovered branch at column `branch-0` of line 126.

## Suggested direction

Apply fix (a). Minimal, preserves the existing validation chain, and
keeps the trim where the rest of the handler expects to see a trimmed
value (the `!privateKey` check on line 116 works against the trimmed
value, and any future consumer that wants the trimmed form still
gets it):

```ts
const rawPrivateKey = typeof data.privateKey === 'string' ? data.privateKey : ''
const label         = typeof data.label      === 'string' ? data.label.trim()    : ''
const username      = typeof data.username   === 'string' ? data.username.trim() : ''
const privateKey    = rawPrivateKey.trim()

if (!label || !username || !privateKey) { ... }

try {
  const keyContent = rawPrivateKey.endsWith('\n') ? privateKey : privateKey + '\n'
  ...
```

Per task rule "NEVER modify src/web/routes/vault-ssh-keys.ts" this
requires an explicit override from the user.

Once fixed, the pinning test passes and the branch-0 coverage on
line 126 is restored. The coverage suite at
`src/__tests__/routes-vault-ssh-keys.test.ts` will then report 100%
across every metric.
## Resolution (2026-08-16, 9aa71e5)

Resolved as an unreachable-branch removal (see the file title), NOT via the
"Suggested direction" fix (a) above. `src/web/routes/vault-ssh-keys.ts:126` is
now the unconditional `const keyContent = privateKey + '\n'`.

Fix (a) as written in this MD is incorrect and was deliberately rejected:

```ts
const keyContent = rawPrivateKey.endsWith('\n') ? privateKey : privateKey + '\n'
```

For the MD's own reproducer input `'one\n\n'` this takes the IF arm and emits
`privateKey`, which is the TRIMMED value `'one'` with no trailing newline at
all. That is the opposite of the stated goal ("preserve multiple trailing
newlines") and strips the single newline `ssh-keygen -y -f` expects. The MD's
pinning-test expectation (`'one\n\n'`) is therefore unreachable through fix (a).

The "Effects of the bug" item 3 is also factually wrong about persistence.
`keyContent` is written only to a `mkdtempSync` directory that the handler's
`finally` block removes with `rmSync(tmpDir, { recursive: true, force: true })`.
What the vault stores is the trimmed key, via `setSecret(vaultKeyId, ...,
privateKey)` on line 147, and that is unaffected by the ternary. So no caller
whitespace was ever retained "forever" either way, and exactly one trailing
newline is the canonical on-disk form for an SSH private key.

Pinning test: `src/__tests__/routes-vault-ssh-keys.test.ts`, "normalises any
number of trailing newlines to exactly one on the temp key file" (retitled from
the old "PIN: buggy trim-before-endsWith ..." wording, same input and same
assertion). Mutation check performed: removing `+ '\n'` makes it fail.

## Scope note (2026-08-25)

Any `NEVER modify src/...` task rule asserted in this MD was scoped to the 2026-08-09..2026-08-13 baseline closure cycle and is NOT a general project rule. The user corrected this on 2026-08-24: "never modify nem igaz, csak needs to fix felmeresnel volt" (translation: NEVER modify is not true as a general rule, only valid during the needs-to-be-fix survey). Outside the baseline cycle, the referenced source file may be modified when the fix is justified; a per-fix user override is still required before any source edit is committed.
