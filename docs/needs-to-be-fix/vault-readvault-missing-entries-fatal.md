# src/web/vault.ts: `readVault` returns parsed JSON as-is, so any shape that lacks `entries` is fatal

## Location

`src/web/vault.ts:93-96`

```ts
function readVault(): VaultStore {
  try { return JSON.parse(readFileSync(VAULT_PATH, 'utf-8')) }
  catch { return { entries: [] } }
}
```

## Excerpt

The `try/catch` only protects against `readFileSync` (ENOENT, EACCES) and
`JSON.parse` (SyntaxError) failures. It does NOT validate that the parsed
value is an object with an `entries` array. Anything else (a primitive, an
array, an object without `entries`) flows straight through and is returned
typed as `VaultStore`. The next caller does `store.entries.findIndex(...)`
/ `.find(...)` / `.filter(...)` / `.length` on `undefined`, which throws
`TypeError: Cannot read properties of undefined (reading 'findIndex')` (or
similar). The catch never fires because the failure happens AFTER
`readVault` returns.

## Failure scenario

`VAULT_PATH` is `store/vault.json`. The file is writable by the marveen
process. Realistic ways to land on a JSON document that lacks `entries`:

1. **Hand edit / first install bootstrap**: an operator runs `echo '{}' >
   store/vault.json` (or any other shape) before first start. The first
   `setSecret` call crashes the route handler.
2. **A future schema migration that overwrites `vault.json` with a partial
   document** during a rolling upgrade — older code expects `entries`, newer
   code (transitionally) writes a different shape.
3. **A backup-restore that lands an older shape on disk** (e.g. copying a
   non-`entries` JSON fixture into the live path).
4. **Disk corruption that truncates to a syntactically-valid-but-incomplete
   fragment** like `{`. Truncation to `{` is a SyntaxError, caught. But
   truncation to `{"e` is also a SyntaxError. Truncation to `{"foo":1}` is
   NOT a SyntaxError and IS a fatal: the JSON parses, but `entries` is
   undefined.

The crash is unguarded at every public surface (`listSecrets`, `setSecret`,
`getSecret`, `deleteSecret`) — the `vault.ts` public exports are called from
HTTP routes that catch and translate to 500, so the user sees "Szerver
hiba" instead of the meaningful "vault file is in an unsupported shape".
More dangerously, `getSecret` callsites in the MCP server boot path will
fail mid-startup, leaving the agent unable to retrieve any of its stored
secrets and crashing the channel handler on every inbound message.

## Pinning test

`src/__tests__/vault.test.ts` includes:

```ts
// PIN: a valid JSON document without an `entries` field makes readVault
// return the parsed object as-is, so the next caller crashes on
// `.entries.find/findIndex/filter/length`. The catch around JSON.parse
// does not extend to schema validation. See
// docs/needs-to-be-fix/vault-readvault-missing-entries-fatal.md.
it('PIN: throws on a valid JSON document without an entries field', () => {
  seedVaultFile({ unrelated: 'shape' })
  expect(() => listSecrets()).toThrow()
  expect(() => getSecret('any')).toThrow()
  expect(() => deleteSecret('any')).toThrow()
  expect(() => setSecret('any', 'lbl', 'val')).toThrow()
})
```

This test PASSES on the current source: all four public methods throw
because `store.entries` is undefined at runtime. Once the fix lands, the
test must be updated to assert the recoverable behaviour (return
`{ entries: [] }`, no throw) — that change goes together with the source
fix.

## Suggested direction

Two minimal fixes (either is sufficient):

1. **Default `entries` to `[]` inside `readVault`** when the parsed value
   lacks it. Smallest possible diff:

   ```ts
   function readVault(): VaultStore {
     try {
       const raw = JSON.parse(readFileSync(VAULT_PATH, 'utf-8'))
       if (raw && typeof raw === 'object' && Array.isArray(raw.entries)) {
         return raw as VaultStore
       }
     } catch { /* fall through */ }
     return { entries: [] }
   }
   ```

   This also rejects a top-level non-object (`null`, `42`, `"x"`) and a
   `entries` field that is not an array, so the four public exports never
   see a malformed shape.

2. **Tighten the type** to `VaultStore | null` and force callers to handle
   the `null` arm explicitly. More invasive — every call site would need
   to either default or propagate.

Approach (1) is the right minimum: it keeps the public API stable (every
existing call still returns `VaultStore`), it preserves the malformed-JSON
behaviour (catch stays), and it adds the missing schema check.
