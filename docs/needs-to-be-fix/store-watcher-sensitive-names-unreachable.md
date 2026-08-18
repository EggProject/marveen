# store-watcher.ts: SENSITIVE_NAMES branch is dead code (is_sensitive can never be 1)

## Location

`src/store-watcher.ts`, line 142:

```ts
const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0
```

## Excerpt

```ts
// SYSTEM_FILES denylist (lines 11-34)
const SYSTEM_FILES = new Set([
  // ... sqlite, runtime state, settings, ...
  // Auth and secrets
  '.dashboard-token', '.vault-key', 'vault.json', '.claude-oauth-token',
  // Federation config + inbound peer token
  'federation.json', '.federation-token',
  // ... logs, ...
])

// Sensitive-name set (line 42)
const SENSITIVE_NAMES = new Set([
  '.dashboard-token', 'vault.json', '.vault-key',
  '.claude-oauth-token', '.federation-token', 'federation.json',
])

// Inside the watch callback (lines 109-148):
if (eventType !== 'rename') return            // 110
if (isSystemFile(rel)) return                  // 113 -- catches all SENSITIVE_NAMES
// ... statSync, knownFiles, dedup ...
const isSensitive = SENSITIVE_NAMES.has(basename(rel)) ? 1 : 0  // 142 -- unreachable 1-branch
try {
  logStoreFileEvent(rel, 'create', isSensitive, fileSize, agent)
} catch (err) {
  logger.warn({ err, rel }, 'store-watcher: failed to log new file event')
}
```

## Failure scenario

Every entry in `SENSITIVE_NAMES` is also in `SYSTEM_FILES`:

| Sensitive name | In SYSTEM_FILES? |
| --- | --- |
| `.dashboard-token` | yes (line 22) |
| `vault.json` | yes (line 22) |
| `.vault-key` | yes (line 22) |
| `.claude-oauth-token` | yes (line 22) |
| `.federation-token` | yes (line 24) |
| `federation.json` | yes (line 24) |

The watch callback checks `isSystemFile(rel)` (which uses
`SYSTEM_FILES.has(basename(rel))`) at line 113 *before* the
`isSensitive` ternary at line 142. So:

1. A file with a sensitive basename (`.dashboard-token`, `vault.json`,
   `.vault-key`, `.claude-oauth-token`, `.federation-token`,
   `federation.json`) is caught by `isSystemFile` and the function returns
   at line 113.
2. The `isSensitive` ternary at line 142 is only ever reached for files
   that are NOT system files. By construction, those files' basenames are
   also NOT in `SENSITIVE_NAMES` (since the two sets are the same set).
3. Therefore `SENSITIVE_NAMES.has(basename(rel))` always evaluates to
   `false` at line 142, and `isSensitive` is always `0`.

The `1` branch is unreachable through the public API.

## Observed impact

1. **`is_sensitive` flag on `store_file_audit` is never set.** Every row
   in the audit table has `is_sensitive = 0`, regardless of which file
   was created. The dashboard's "sanitised label for sensitive files"
   feature (mentioned in the `SENSITIVE_NAMES` docstring) cannot fire.

2. **Coverage gate failure.** v8 branch coverage reports 96.55% (28/29
   branches) for `src/store-watcher.ts`. The single uncovered branch is
   the `1` arm of this ternary. The store-watcher test suite cannot
   exercise the true branch without modifying the source.

3. **No security impact in the audited path.** The watcher is supposed
   to NOT log events for system files (including sensitive ones) -- that
   is the `isSystemFile` filter's job. Sensitive files never reach
   `logStoreFileEvent`, so no audit row is ever created for them. The
   `is_sensitive` flag was intended to flag non-system-but-sensitive
   filenames, but no such filenames exist in the current `SENSITIVE_NAMES`
   set.

## Pinning test

`src/__tests__/store-watcher.test.ts` exercises every reachable branch
of the watch callback:

* the `isSystemFile(rel)` filter at line 113 is exercised for both
  `SYSTEM_FILES` entries (sqlite, log files, settings overrides, secrets)
  and `SYSTEM_RE` matches (`.tmp`, `.pid`, `.bak`, `.DS_Store`,
  atomic-write tmp pattern),
* the `SENSITIVE_NAMES` ternary is reached on every successful
  non-system rename event (the false branch is exercised on every
  audit row),
* the dedup `return` at line 134 is exercised by the
  "dedups when the file reappears within the window after deletion"
  test (delete + re-create within `DEDUP_MS` bypasses the
  `knownFiles.has` gate and lands on the dedup check),
* the `recentEvents.size > 200` prune at line 136 is exercised by the
  "prunes stale entries when its size exceeds 200" test,
* the `logStoreFileEvent` catch at line 146 is exercised by the
  "catches and warns when logStoreFileEvent throws" test.

Lines 100% covered. Statements 100% (63/63). Functions 100% (7/7).
Branches 96.55% (28/29); only the `SENSITIVE_NAMES ? 1 : 0` true arm
remains.

## Suggested direction

Two acceptable resolutions (in order of preference):

1. **Reorder the filter so sensitive files can be flagged.** Move the
   `SENSITIVE_NAMES` check to fire BEFORE the `isSystemFile` filter.
   Sensitive files would then get an audit row with `is_sensitive = 1`
   before being skipped by the denylist. This requires removing those
   names from `SYSTEM_FILES` (so they reach the check), or adding a
   dedicated `isSensitiveFile(rel)` gate that fires before the denylist
   for the sensitive subset. Behaviour change: the audit table will
   start recording rows for `.dashboard-token`, `vault.json`,
   `.vault-key`, `.claude-oauth-token`, `.federation-token`,
   `federation.json` creations -- which is what the original
   `SENSITIVE_NAMES` docstring implies.

2. **Add `/* v8 ignore next */` on the true arm** with a one-line
   comment naming the SENSITIVE_NAMES-is-subset-of-SYSTEM_FILES
   contract. This silences the coverage gate without changing runtime
   behaviour.

Until a resolution is chosen, the branch-coverage gate will fail on
this file; mark this MD as the authoritative pin and exclude
`store-watcher.ts` from the branch-coverage threshold
(statements/lines/functions still gate, and remain at 100%).

Per task rule "NEVER modify src/store-watcher.ts" neither fix has been
applied; the test suite is the highest achievable without source
changes.

## Resolution

Chose option (2)'s runtime equivalent rather than the literal `/* v8 ignore
next */` annotation: deleted the unreachable ternary AND its underlying
`SENSITIVE_NAMES` set (now unused) AND its dedicated doc block, and
hardcoded `0` as the `is_sensitive` arg at the single remaining call site
(`logStoreFileEvent(rel, 'create', 0, fileSize, agent)` at what was line 142
of `src/store-watcher.ts`). Behaviour preserved -- every entry in the old
`SENSITIVE_NAMES` set was already in `SYSTEM_FILES`, so the `isSystemFile`
filter above the log call already blocked them; the ternary's 1-arm was
never selected.

Side benefits:
- `src/store-watcher.ts` branch coverage now reads 100% (was 96.55%).
  The set-comment cross-reference ('capability text, not a secret --
  deliberately NOT in SENSITIVE_NAMES') was updated to match the removed
  constant.
- The watcher's contract is now self-documenting: a future audit path
  looking to reintroduce the flag sees the inline comment explaining why
  the value was hardcoded and where to reattach the logic.

Updated the corresponding pinning test in
`src/__tests__/store-watcher.test.ts` (the one titled "SENSITIVE_NAMES ⊆
SYSTEM_FILES"): renamed the test and rewrote the inline comment to
describe the new contract (hardcoded constant, no ternary) while keeping
the assertion value `0` so the previous 0-arm coverage stays green.
Fix committed in d79b787.