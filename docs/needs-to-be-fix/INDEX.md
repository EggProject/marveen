# needs-to-be-fix index

Every bug MD filed in this session. Total count: 50
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
| `keychain-retrieve-swallows-locked-keychain` | `src/web/keychain.ts:32-34` | a locked keychain returns `null` like a missing item, so `vault.ts:44-49` overwrites the master key with `-U` and every stored secret becomes undecryptable | `src/__tests__/keychain.test.ts` |
| `routes-memories-put-skips-validation` | `src/web/routes/memories.ts:237-245` | `PUT /api/memories/:id` skips the POST content/category checks, so `containsSuspiciousContent` (a prompt-injection control) is fully bypassable by editing an existing memory | `src/__tests__/memories-routes.test.ts` |
| `test-suite-store-pollution-store-dir-frozen` | `src/__tests__/db-100.test.ts:1655-1717` + `src/config.ts:12-13` | `STORE_DIR` is frozen at module load (`__dirname/../store`); `db-100.test.ts:migrateTaskRunsFromJson` writes the live `./store/task-run-history.json`, renames it to `.migrated`, and the cleanup block fails to restore it -- production state mutated by the test suite | `src/__tests__/db-100.test.ts` |
| `test-suite-guard-marker-only-blind` | `src/__tests__/setup/assert-not-live-install.ts:26-30` (pre-2026-08-06) | the live-install guard checked only 3 marker files (`.dashboard-token`, `claudeclaw.db`, `.claude-oauth-token`); the `task-run-history.json.migrated`, `agent-taskstate/`, `costops-config.json.example` artifacts all slipped through and the suite happily mutated production state | `src/__tests__/setup/assert-not-live-install.ts` |

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
| `stuck-tool-call-watcher-skew-defer` | `src/web/stuck-tool-call-watcher.ts:141` | a future-dated respawn stamp makes `shouldDeferForRecentRespawn` suppress wedge recovery for the whole skew, not just the grace window | `src/__tests__/stuck-tool-call-watcher.test.ts` |
| `model-fallback-runner-writemainmodel-nonobject` | `src/web/model-fallback-runner.ts:56-61` | `writeMainModel` guards only a JSON *parse* failure, so a `null` body throws (swap abandoned) and an array body silently drops the model while logging success | `src/__tests__/model-fallback-runner.test.ts` |
| `routes-ideas-comment-orphan` | `src/web/routes/ideas.ts:135-144` | `POST /api/ideas/:id/comments` never checks that the idea exists, so the comment is written to an unreachable `idea_id` and returns 200 | `src/__tests__/ideas-routes.test.ts` |
| `routes-ideas-promote-double` | `src/web/routes/ideas.ts:149-172` | re-promoting a `kanban` idea creates a second card and overwrites `kanban_id`, orphaning the first card and breaking `revertIdeaFromKanban` | `src/__tests__/ideas-routes.test.ts` |
| `routes-memories-nan-limit` | `src/web/routes/memories.ts:72` | `limit` is clamped only from above, so `?limit=abc` binds `NaN` (SqliteError -> 500) and `?limit=-1` returns every row (SQLite treats a negative LIMIT as unlimited) | `src/__tests__/memories-routes.test.ts` |
| `routes-memories-put-tier-precedence` | `src/web/routes/memories.ts:242` | `PUT` resolves `tier \|\| category` while `POST` resolves `category \|\| tier`, so the deprecated field wins on edit and a round-trip silently reclassifies the row | `src/__tests__/memories-routes.test.ts` |
| `channel-poller-reap-botpid-killed-without-identity-check` | `src/web/channel-poller-reap.ts:76-88,202-230` | `reapChannelOrphans` SIGTERM+SIGKILLs the `bot.pid` pid with no identity check (only `> 1`); nothing ever deletes `bot.pid`, so a stale file plus pid reuse kills an unrelated process while logging "orphans killed" | `src/__tests__/channel-poller-reap.test.ts` |

## Low

| Bug ID | File:Line | Title | Pinning test path |
| --- | --- | --- | --- |
| `vault-readvault-missing-entries-fatal` | `src/web/vault.ts:93-96` | `readVault` returns parsed JSON as-is, so any shape that lacks `entries` is fatal on every public call | `src/__tests__/vault.test.ts` |
| `graph-mail-stat-not-isdir` | `src/graph-mail.ts:105-119` | stat-successful / read-failing `CREDS_PATH` produces an opaque error | `src/__tests__/graph-mail.test.ts` |
| `prompt-safety-origin-note-tab-strip` | `src/prompt-safety.ts:96-103` | `sanitizeOriginNote` strips tab/newline/NBSP instead of collapsing them | `src/__tests__/prompt-safety.test.ts` |
| `pane-state-defensive-branches` | `src/pane-state.ts:1064,1066,1104,1136,1161,1165,1489` | unreachable defensive branches block 100% branch coverage | `src/__tests__/pane-state.test.ts` |
| `store-watcher-sensitive-names-unreachable` | `src/store-watcher.ts:142` | `SENSITIVE_NAMES` branch is dead code (`is_sensitive` can never be 1) | `src/__tests__/store-watcher.test.ts` |
| `index-unreachable-coverage` | `src/index.ts:174,283,382` | three functions are unreachable from the test harness | `src/__tests__/index.test.ts` |
| `channel-invites-unreachable-defensive-branches` | `src/web/channel-invites.ts:108,236` | two defensive `if` guards are unreachable through public API; callers gate on the same property | `src/__tests__/channel-invites.test.ts` |
| `web-worker-warmup-ignores-close` | `src/web.ts:339-364` (warm-up) vs `544` (close override) | agent-worker warm-up import has no `close()` cancel flag, unlike the liveness monitor | `src/__tests__/web-server.test.ts` |
| `auto-restart-parsehhmm-integer-guard` | `src/auto-restart.ts:63` | `parseHHMM`'s `Number.isInteger` guard is dead code | `src/__tests__/auto-restart.test.ts` |
| `agent-detect-linux-libc-redundant-guard` | `src/agent.ts:72-80` (line 73) | `detectLinuxLibc`'s platform check is unreachable in production | `src/__tests__/agent-run-paths.test.ts` |
| `channel-coordinator-internals-untestable` | `src/channel-coordinator.ts:117-441` | internal state-machine functions are not unit-testable | `src/__tests__/channel-coordinator.test.ts` |
| `heartbeat-brief-rundiceaysweep-not-applicable` | `src/heartbeat.ts` (no symbol) | task brief mentions `runDecaySweep` integration but the integration does not exist | `src/__tests__/heartbeat-cov.test.ts` |
| `http-helpers-gzip-memo-evict-guard` | `src/web/http-helpers.ts:122` | gzip memo eviction guard is dead code (`oldest` can never be `undefined`) | `src/__tests__/http-helpers.test.ts` |
| `stuck-tool-call-watcher-dead-ternary` | `src/web/stuck-tool-call-watcher.ts:192` | `sinceRespawnMs` ternary has a dead `null` arm (blocks 100% branch coverage) | `src/__tests__/stuck-tool-call-watcher.test.ts` |
| `keychain-store-insecure-acl` | `src/web/keychain.ts:19` | the master key is written with `-A`, the flag `security(1)` labels "insecure, not recommended" (empty ACL); low because the key is readable without `-A` too | `src/__tests__/keychain.test.ts` |
| `vault-bindings-unreachable-coverage` | `src/web/vault-bindings.ts:163,236` | `maskValue`'s `<= 6` branch and `serverHasVaultRefs`'s `!env` branch are unreachable from any caller (`looksLikeSensitiveValue`'s 8-char gate and the `if (!serverCfg.env) continue` guard filter both inputs) | `src/__tests__/vault-bindings.test.ts` |
| `agent-process-unreachable-defensive-branches` | `src/web/agent-process.ts:777,1384,1512` | three unreachable defensive branches (`runTmux` remote default timeout, `restartAgentProcess` `||` error fallback, `answerFirstRunGates` loop-exhaustion `'unchanged'` arm) cap branch coverage at 99.38% | `src/__tests__/agent-process.test.ts` |
| `routes-ideas-body-parse-500` | `src/web/routes/ideas.ts:43,86,138,152,201` | unguarded `JSON.parse` + destructuring throws out of the handler, so a malformed or `null` body returns 500 "Szerver hiba" instead of 400 | `src/__tests__/ideas-routes.test.ts` |
| `routes-ideas-breakdown-nonerror` | `src/web/routes/ideas.ts:186-189` | `(err as Error).message` is undefined for a non-Error throw, so the 500 response body is `{}` | `src/__tests__/ideas-routes.test.ts` |
| `routes-ideas-title-validation` | `src/web/routes/ideas.ts:51` | `title` is neither trimmed nor type-checked (unlike the sibling comment endpoint), so a whitespace-only title is stored and an object title 500s in the driver | `src/__tests__/ideas-routes.test.ts` |
| `fleet-transfer-assertsafename-dead` | `src/web/fleet-transfer.ts:48-52` | `assertSafeName` is defined but never called from anywhere (validateNames inlines `SAFE_NAME_RE.test`); caps line coverage at 99.35% on fleet-transfer.ts | `src/__tests__/fleet-transfer-routes.test.ts` |
| `test-suite-llm-api-audit-clean` | audit doc (not a bug) | the suite never makes a real LLM call, never reaches a real HTTP endpoint, and never spawns a real child process; every layer is mocked (`globalThis.fetch = vi.fn`, `vi.mock('../agent.js')`, `vi.mock('@anthropic-ai/claude-agent-sdk')`, `vi.mock('node:child_process')`). The user's "LLM call during tests" concern is unfounded; only side effect is the `./store/` pollution | n/a (audit record) |
| `overview-routes-yesterday-timestamp-flake` | `src/__tests__/overview-routes.test.ts:534` (was `now - 25h`) | the "yesterday" timestamp is computed as `now - 25 * 60 * 60 * 1000`, which only falls in the `[yesterday, startTs)` bin when `now >= 01:00 LOCAL`. Tests run just past midnight (00:00-01:00) flake-fail because the line lands in the day-before-yesterday bin | `src/__tests__/overview-routes.test.ts` |
| `channel-monitor-importwith-existsoverride-leaks-live-store` | `src/__tests__/channel-monitor.test.ts:739` `importWithExistsOverride` | `vi.resetModules()` drops the suite-level `vi.mock('../config.js', ...)`; the function only re-mocks `node:fs`, so the re-imported SUT computes `RESPAWN_STAMP_FILE` against the live `PROJECT_ROOT`. `writeRespawnStamp()` during these tests lands in the live `./store/.channel-last-respawn`, tripping the live-install guard on parallel suite runs | `src/__tests__/channel-monitor.test.ts` |
| `channel-poller-reap-isclaudebinary-unreachable-fallbacks` | `src/web/channel-poller-reap.ts:267,268` | `isClaudeBinary`'s two `?? ''` arms are unreachable (`split(sep, 1)` always yields >= 1 element, `pop()` on it never returns `undefined`); reached in the suite only by patching `String.prototype.split` | `src/__tests__/channel-poller-reap.test.ts` |
