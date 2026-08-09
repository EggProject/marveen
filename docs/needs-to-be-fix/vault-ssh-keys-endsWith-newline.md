# vault-ssh-keys.ts:126 -- privateKey.endsWith('\n') IF branch is unreachable

## Location

`src/web/routes/vault-ssh-keys.ts`, lines 114-129 (key import):

```ts
const label      = typeof data.label      === 'string' ? data.label.trim()      : ''
const username   = typeof data.username   === 'string' ? data.username.trim()   : ''
const privateKey = typeof data.privateKey === 'string' ? data.privateKey.trim() : ''

if (!label || !username || !privateKey) {
  json(res, { error: 'label, username and privateKey are required' }, 400)
  return true
}

// Validate key and extract public key via ssh-keygen -y (same pattern as extractPublicKeyFromVault)
const tmpDir = mkdtempSync(join(tmpdir(), 'marveen-ssh-'))
const keyPath = join(tmpDir, 'key')
let publicKey: string
try {
  const keyContent = privateKey.endsWith('\n') ? privateKey : privateKey + '\n'
  writeFileSync(keyPath, keyContent, { mode: 0o600 })
  ...
```

## Excerpt

The IF branch of `privateKey.endsWith('\n') ? privateKey : privateKey + '\n'`
at line 126 is **structurally unreachable**. `privateKey` was assigned
`data.privateKey.trim()` at line 117, so any leading or trailing
whitespace -- including trailing newlines -- has been stripped. After
`trim()`, `privateKey` cannot end with `'\n'`. The IF branch (no
append) never fires.

The ELSE branch (append `'\n'`) fires on every call where
`privateKey` is non-empty after `trim()`. The pinning test in
`routes-vault-ssh-keys.test.ts` (titled "appends a newline to the
private key when one is not present") exercises exactly this path.

## Failure scenario

The existing test "appends a newline to the private key when one is not
present" hits the ELSE branch. A second test "PIN: buggy
trim-before-endsWith collapses multiple trailing newlines to one
(defect: should preserve)" pins the CURRENT (buggy) behaviour and
documents the defect.

v8 branch coverage reports the IF branch at line 126 as
`counts=[0, 11]` -- 11 ELSE-branch hits across the existing
`routes-vault-ssh-keys.test.ts` suite, 0 IF-branch hits.

A reviewer noticing the dead IF has three options:

1. Drop the ternary entirely: `const keyContent = privateKey + '\n'`
   -- but this changes the on-disk content from the IF-pass case
   (currently unreachable, but conceptually "no append").
2. Reorder the logic: do the `endsWith('\n')` check BEFORE the
   `trim()`, so a trailing newline in the input is preserved. This is
   the intended behavior per the pinning-test comment.
3. Leave the current code (the bug) and document it (current state).

Option (2) is the correct fix -- it preserves the original intent
("don't strip a trailing newline") while removing the unreachable
branch.

## Pinning test

`src/__tests__/routes-vault-ssh-keys.test.ts` has two relevant tests:

- "appends a newline to the private key when one is not present" --
  pins the ELSE branch (current behaviour with one trailing newline).
- "PIN: buggy trim-before-endsWith collapses multiple trailing
  newlines to one (defect: should preserve)" -- pins the BUGGY
  behaviour where two trailing newlines collapse to one.

Both tests document the current state and what should change once
the fix lands.

## Suggested direction

Reorder the validation to preserve a trailing newline:

```ts
const privateKeyRaw = typeof data.privateKey === 'string' ? data.privateKey : ''
if (!privateKeyRaw.trim()) {
  json(res, { error: 'label, username and privateKey are required' }, 400)
  return true
}
const privateKey = privateKeyRaw.endsWith('\n') ? privateKeyRaw : privateKeyRaw + '\n'
```

The trim moves to the empty-check, the `endsWith` check operates on
the raw input, and the IF branch becomes reachable. The existing
PINNING test for the bug would then assert the corrected behavior
(`expect(writtenKeyContent).toBe('one\n\n')`).

Per task rule "NEVER modify src/web/routes/vault-ssh-keys.ts" this
requires an explicit override from the user.