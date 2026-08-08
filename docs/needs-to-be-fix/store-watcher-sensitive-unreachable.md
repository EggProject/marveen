# store-watcher: isSensitive=1 branch unreachable (SENSITIVE_NAMES ⊆ SYSTEM_FILES)

## Where
`src/store-watcher.ts:142`

```ts
const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0
```

## What
The watcher has two parallel denylist sets:

```ts
const SYSTEM_FILES = new Set([
  // Auth and secrets
  '.dashboard-token', '.vault-key', 'vault.json', '.claude-oauth-token',
  // Federation config + inbound peer token (written by /api/federation/peers)
  'federation.json', '.federation-token',
  // ...operational files (sqlite, logs, settings, etc.)
])

const SENSITIVE_NAMES = new Set([
  '.dashboard-token', 'vault.json', '.vault-key',
  '.claude-oauth-token', '.federation-token', 'federation.json',
])
```

The watch callback runs `if (isSystemFile(rel)) return` (line 113) BEFORE
reaching the `isSensitive` ternary on line 142. Because every entry in
`SENSITIVE_NAMES` is also a member of `SYSTEM_FILES`, the watch callback
filters these filenames out before the isSensitive flag can ever be set to 1.

## Coverage impact
`branches = 96.55% (28/29)`. The unreachable branch is the
`SENSITIVE_NAMES.has(basename(rel))` true branch.

## How to fix
Two options, pick one based on intent:

1. **If the intent is "never log secret-named files"** (current behaviour):
   drop the `isSensitive` flag entirely -- it can never fire -- and remove
   the `SENSITIVE_NAMES` constant. The `SYSTEM_FILES` denylist already
   suppresses these. The audit table can drop the `is_sensitive` column if
   nothing else uses it.

2. **If the intent is "log secret-named files but flag them sensitive so the
   UI can redact"**: remove those entries from `SYSTEM_FILES` and let them
   reach the `isSensitive` ternary. The audit row will then carry the
   sensitive flag, but a renamed `.dashboard-token` will land in the audit
   log -- the file CONTENT is the secret, not the name, so a leak-by-name is
   still safer than today's silent loss of audit visibility.

Pinning test:
`src/__tests__/store-watcher.test.ts` — "the isSensitive=1 branch is
unreachable today: every SENSITIVE_NAMES entry is also in SYSTEM_FILES"
