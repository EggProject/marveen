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