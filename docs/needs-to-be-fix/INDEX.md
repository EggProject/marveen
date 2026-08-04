# needs-to-be-fix index

Every bug MD filed in this session. Total count: 25
(`find docs/needs-to-be-fix -name '*.md' | wc -l`).

Sorted by severity: high (security / data loss / silent corruption),
medium (functional defect with workaround), low (test-coverage gap,
dead code, doc issue).

## High

| Bug ID | File:Line | Title | Pinning test path |
| --- | --- | --- | --- |
| `env-update-mode-downgrade` | `src/env.ts:87` | `updateEnvFile` rewrites `.env` from 0600 to 0644 (silent secret leak) | `src/__tests__/env.test.ts` |
| `config-empty-env-blanks-identity` | `src/config.ts:129,135,143,200,209` | an empty `.env` line blanks the whole install identity | `src/__tests__/config.test.ts` |
| `db-missing-telegram-history-table` | `src/db.ts:2563,2588` (no `CREATE TABLE` in `initDatabase`) | `telegram_history` table is referenced but never created (silent data loss) | `src/__tests__/db.test.ts` |
| `google-api-refresh-race` | `src/google-api.ts:108-142` | `refreshAccessToken` has no in-flight de-duplication (race overwrites tokens) | `src/__tests__/google-api.test.ts` |
| `multipart-boundary-greedy` | `src/web/multipart.ts:9-12` | greedy `boundary=(.+)` keeps quotes and trailing params, silently corrupting every field | `src/__tests__/multipart.test.ts` |
| `multipart-latin1-fields` | `src/web/multipart.ts:31,36` | text fields and filenames are latin1-decoded, so every non-ASCII value is mojibake | `src/__tests__/multipart.test.ts` |
| `profiles-traversal-id` | `src/web/profiles.ts:42-49` | `loadProfileTemplate` never validates `id`, so `../` escapes `PROFILES_DIR` (arbitrary JSON read + security-profile bypass via unguarded `POST /api/agents`) | `src/__tests__/profiles.test.ts` |

## Medium

| Bug ID | File:Line | Title | Pinning test path |
| --- | --- | --- | --- |
| `web-watchdog-survives-close` | `src/web.ts:310-319` (arm) vs `539-562` (close override) | the not-listening watchdog survives `server.close()` and `exit(1)` afterwards | `src/__tests__/web-server.test.ts` |
| `web-port-reclaim-failure-leaves-unbound` | `src/web.ts:225-280` | a failing port-reclaim leaves the process alive with no listener and no retry | `src/__tests__/web-server.test.ts` |
| `env-update-duplicate-key-lost` | `src/env.ts:68-80` | duplicate-key update of `updateEnvFile` is silently lost (reader uses last-occurrence) | `src/__tests__/env.test.ts` |
| `kanban-dispatch-owner-case` | `src/kanban-dispatch.ts:34` | owner-guard is the only case-sensitive comparison (mismatched casing misroutes cards) | `src/__tests__/kanban-dispatch.test.ts` |
| `notify-fallback-hardcodes-telegram-limit` | `src/notify.ts:25` | fallback hardcodes Telegram 4096 limit for every provider | `src/__tests__/notify.test.ts` |
| `notify-fallback-repeats-head` | `src/notify.ts:19-28` | per-chunk fallback re-sends the same first 4096 chars, dropping the tail | `src/__tests__/notify.test.ts` |
| `memory-digest-empty-trim` | `src/memory.ts:200-206` | `runDailyDigest` saves an empty digest when `runAgent` returns whitespace-only text | `src/__tests__/memory.test.ts` |
| `multipart-case-sensitive-disposition` | `src/web/multipart.ts:17` | case-sensitive `Content-Disposition` filter silently drops conforming parts | `src/__tests__/multipart.test.ts` |
| `profiles-replace-dollar-pattern` | `src/web/profiles.ts:51-56` | `resolveProfilePlaceholders` interpolates ctx values as `String.replace` patterns, so `$&` / `` $` `` in a path corrupts the emitted permission rule | `src/__tests__/profiles.test.ts` |

## Low

| Bug ID | File:Line | Title | Pinning test path |
| --- | --- | --- | --- |
| `graph-mail-stat-not-isdir` | `src/graph-mail.ts:105-119` | stat-successful / read-failing `CREDS_PATH` produces an opaque error | `src/__tests__/graph-mail.test.ts` |
| `prompt-safety-origin-note-tab-strip` | `src/prompt-safety.ts:96-103` | `sanitizeOriginNote` strips tab/newline/NBSP instead of collapsing them | `src/__tests__/prompt-safety.test.ts` |
| `pane-state-defensive-branches` | `src/pane-state.ts:1064,1066,1104,1136,1161,1165,1489` | unreachable defensive branches block 100% branch coverage | `src/__tests__/pane-state.test.ts` |
| `store-watcher-sensitive-names-unreachable` | `src/store-watcher.ts:142` | `SENSITIVE_NAMES` branch is dead code (`is_sensitive` can never be 1) | `src/__tests__/store-watcher.test.ts` |
| `index-unreachable-coverage` | `src/index.ts:174,283,382` | three functions are unreachable from the test harness | `src/__tests__/index.test.ts` |
| `web-worker-warmup-ignores-close` | `src/web.ts:339-364` (warm-up) vs `544` (close override) | agent-worker warm-up import has no `close()` cancel flag, unlike the liveness monitor | `src/__tests__/web-server.test.ts` |
| `auto-restart-parsehhmm-integer-guard` | `src/auto-restart.ts:63` | `parseHHMM`'s `Number.isInteger` guard is dead code | `src/__tests__/auto-restart.test.ts` |
| `agent-detect-linux-libc-redundant-guard` | `src/agent.ts:72-80` (line 73) | `detectLinuxLibc`'s platform check is unreachable in production | `src/__tests__/agent-run-paths.test.ts` |
| `channel-coordinator-internals-untestable` | `src/channel-coordinator.ts:117-441` | internal state-machine functions are not unit-testable | `src/__tests__/channel-coordinator.test.ts` |
| `heartbeat-brief-rundiceaysweep-not-applicable` | `src/heartbeat.ts` (no symbol) | task brief mentions `runDecaySweep` integration but the integration does not exist | `src/__tests__/heartbeat-cov.test.ts` |
| `http-helpers-gzip-memo-evict-guard` | `src/web/http-helpers.ts:122` | gzip memo eviction guard is dead code (`oldest` can never be `undefined`) | `src/__tests__/http-helpers.test.ts` |