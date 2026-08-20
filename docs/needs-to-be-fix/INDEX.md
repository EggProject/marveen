# needs-to-be-fix index

Every bug MD filed in this session. Total count: 177
(`find docs/needs-to-be-fix -name '*.md' ! -name 'INDEX.md' | wc -l`;
the unfiltered command returns 178 because it counts this index too).
The index has one table row per MD, so the two counts must stay equal.

The original 50 entries below were filed during the first coverage pass.
The 115 additional entries were filed during the unreachable/branches closure
pass (2026-08-09 to 2026-08-13) and are listed in the **Baseline unreachable
addenda** section at the bottom.

Sorted by severity: high (security / data loss / silent corruption),
medium (functional defect with workaround), low (test-coverage gap,
dead code, doc issue).

## High

| Bug ID | File:Line | Title | Pinning test path | Resolved |
| --- | --- | --- | --- | --- |
| `env-update-mode-downgrade` | `src/env.ts:87` | `updateEnvFile` rewrites `.env` from 0600 to 0644 (silent secret leak) | `src/__tests__/env.test.ts` | Resolved: 2026-08-17 d9fb8beb8d1a2e0f6a1a6ee358135f3b3c9ffe6e |
| `config-empty-env-blanks-identity` | `src/config.ts:129,135,143,200,209` | an empty `.env` line blanks the whole install identity | `src/__tests__/config.test.ts` | — |
| `db-missing-telegram-history-table` | `src/db.ts:2563,2588` (no `CREATE TABLE` in `initDatabase`) | `telegram_history` table is referenced but never created (silent data loss) | `src/__tests__/db.test.ts` | Resolved: 2026-08-19 0b61592 (functions deleted as dead code per the MD's option 2) |
| `google-api-refresh-race` | `src/google-api.ts:108-142` | `refreshAccessToken` has no in-flight de-duplication (race overwrites tokens) | `src/__tests__/google-api.test.ts` | — |
| `multipart-boundary-greedy` | `src/web/multipart.ts:9-12` | greedy `boundary=(.+)` keeps quotes and trailing params, silently corrupting every field | `src/__tests__/multipart.test.ts` | — |
| `multipart-latin1-fields` | `src/web/multipart.ts:31,36` | text fields and filenames are latin1-decoded, so every non-ASCII value is mojibake | `src/__tests__/multipart.test.ts` | — |
| `profiles-traversal-id` | `src/web/profiles.ts:42-49` | `loadProfileTemplate` never validates `id`, so `../` escapes `PROFILES_DIR` (arbitrary JSON read + security-profile bypass via unguarded `POST /api/agents`) | `src/__tests__/profiles.test.ts` | — |
| `keychain-retrieve-swallows-locked-keychain` | `src/web/keychain.ts:32-34` | a locked keychain returns `null` like a missing item, so `vault.ts:44-49` overwrites the master key with `-U` and every stored secret becomes undecryptable | `src/__tests__/keychain.test.ts` | Resolved: 2026-08-17 6e5bdd7 |
| `routes-memories-put-skips-validation` | `src/web/routes/memories.ts:237-245` | `PUT /api/memories/:id` skips the POST content/category checks, so `containsSuspiciousContent` (a prompt-injection control) is fully bypassable by editing an existing memory | `src/__tests__/memories-routes.test.ts` | — |
| `test-suite-store-pollution-store-dir-frozen` | `src/__tests__/db-100.test.ts:1655-1717` + `src/config.ts:12-13` | `STORE_DIR` is frozen at module load (`__dirname/../store`); `db-100.test.ts:migrateTaskRunsFromJson` writes the live `./store/task-run-history.json`, renames it to `.migrated`, and the cleanup block fails to restore it -- production state mutated by the test suite | `src/__tests__/db-100.test.ts` | — |
| `test-suite-guard-marker-only-blind` | `src/__tests__/setup/assert-not-live-install.ts:26-30` (pre-2026-08-06) | the live-install guard checked only 3 marker files (`.dashboard-token`, `claudeclaw.db`, `.claude-oauth-token`); the `task-run-history.json.migrated`, `agent-taskstate/`, `costops-config.json.example` artifacts all slipped through and the suite happily mutated production state | `src/__tests__/setup/assert-not-live-install.ts` | — |

## Medium

| Bug ID | File:Line | Title | Pinning test path | Resolved |
| --- | --- | --- | --- | --- |
| `web-watchdog-survives-close` | `src/web.ts:310-319` (arm) vs `539-562` (close override) | the not-listening watchdog survives `server.close()` and `exit(1)` afterwards | `src/__tests__/web-server.test.ts` | — |
| `web-port-reclaim-failure-leaves-unbound` | `src/web.ts:225-280` | a failing port-reclaim leaves the process alive with no listener and no retry | `src/__tests__/web-server.test.ts` | — |
| `env-update-duplicate-key-lost` | `src/env.ts:68-80` | duplicate-key update of `updateEnvFile` is silently lost (reader uses last-occurrence) | `src/__tests__/env.test.ts` | — |
| `kanban-dispatch-owner-case` | `src/kanban-dispatch.ts:34` | owner-guard is the only case-sensitive comparison (mismatched casing misroutes cards) | `src/__tests__/kanban-dispatch.test.ts` | Resolved: 2026-08-16 92612c5 |
| `notify-fallback-hardcodes-telegram-limit` | `src/notify.ts:25` | fallback hardcodes Telegram 4096 limit for every provider | `src/__tests__/notify.test.ts` | Resolved: 2026-08-17 c49c793 |
| `notify-fallback-repeats-head` | `src/notify.ts:19-28` | per-chunk fallback re-sends the same first 4096 chars, dropping the tail | `src/__tests__/notify.test.ts` | Resolved: 2026-08-17 ff22286 |
| `memory-digest-empty-trim` | `src/memory.ts:200-206` | `runDailyDigest` saves an empty digest when `runAgent` returns whitespace-only text | `src/__tests__/memory.test.ts` | Resolved: 2026-08-18 6595106 |
| `multipart-case-sensitive-disposition` | `src/web/multipart.ts:17` | case-sensitive `Content-Disposition` filter silently drops conforming parts | `src/__tests__/multipart.test.ts` | Resolved: 2026-08-16 b5baca3 |
| `profiles-replace-dollar-pattern` | `src/web/profiles.ts:51-56` | `resolveProfilePlaceholders` interpolates ctx values as `String.replace` patterns, so `$&` / `` $` `` in a path corrupts the emitted permission rule | `src/__tests__/profiles.test.ts` | Resolved: 2026-08-18 3b6bb3a |
| `stuck-tool-call-watcher-skew-defer` | `src/web/stuck-tool-call-watcher.ts:141` | a future-dated respawn stamp makes `shouldDeferForRecentRespawn` suppress wedge recovery for the whole skew, not just the grace window | `src/__tests__/stuck-tool-call-watcher.test.ts` | Resolved: 2026-08-16 d634f48 |
| `model-fallback-runner-writemainmodel-nonobject` | `src/web/model-fallback-runner.ts:56-61` | `writeMainModel` guards only a JSON *parse* failure, so a `null` body throws (swap abandoned) and an array body silently drops the model while logging success | `src/__tests__/model-fallback-runner.test.ts` | Resolved: 2026-08-18 39b2a3c |
| `routes-ideas-comment-orphan` | `src/web/routes/ideas.ts:135-144` | `POST /api/ideas/:id/comments` never checks that the idea exists, so the comment is written to an unreachable `idea_id` and returns 200 | `src/__tests__/ideas-routes.test.ts` | Resolved: 2026-08-17 c7c974ff74bd27d0d1f789d474aaaea1a7b6f3e1 |
| `routes-ideas-promote-double` | `src/web/routes/ideas.ts:149-172` | re-promoting a `kanban` idea creates a second card and overwrites `kanban_id`, orphaning the first card and breaking `revertIdeaFromKanban` | `src/__tests__/ideas-routes.test.ts` | Resolved: 2026-08-17 943dba8 |
| `routes-memories-nan-limit` | `src/web/routes/memories.ts:72` | `limit` is clamped only from above, so `?limit=abc` binds `NaN` (SqliteError -> 500) and `?limit=-1` returns every row (SQLite treats a negative LIMIT as unlimited) | `src/__tests__/memories-routes.test.ts` | Resolved: 2026-08-17 22f68f8 |
| `routes-memories-put-tier-precedence` | `src/web/routes/memories.ts:242` | `PUT` resolves `tier \|\| category` while `POST` resolves `category \|\| tier`, so the deprecated field wins on edit and a round-trip silently reclassifies the row | `src/__tests__/memories-routes.test.ts` | Resolved: 2026-08-16 c4b4b9a |
| `channel-poller-reap-botpid-killed-without-identity-check` | `src/web/channel-poller-reap.ts:76-88,202-230` | `reapChannelOrphans` SIGTERM+SIGKILLs the `bot.pid` pid with no identity check (only `> 1`); nothing ever deletes `bot.pid`, so a stale file plus pid reuse kills an unrelated process while logging "orphans killed" | `src/__tests__/channel-poller-reap.test.ts` | — |
| `syntax-check-executes-web-bundle` | `package.json:18` | `bun --check` is not a Bun flag, so `syntax-check` executes `web/app.js` in a server runtime and always exits 1 on `window is not defined`; the gate has never checked syntax (added as a CI gate in `a61ff74`) | none yet -- add one asserting exit 0 on clean files, non-zero on a syntax error | Resolved: 2026-08-17 45bb024 |
| `test-suite-macos-only-portability` | 7 causes across `src/web/agent-scaffold.ts:129`, `src/web/ssh-tmux.ts:32`, `src/web/routes/docs.ts:53`, `src/web/reauth-healer.ts:142`, `src/web/federation/local-catalog.ts:47`, 10 module-level `resolveFromPath` call sites | the baseline suite passed only on macOS: 22 files / 50 tests failed on the first Linux CI run, because the tests inherited tmpdir, XDG_RUNTIME_DIR, birthtime, readdir order, bash version and installed binaries from the host instead of controlling them (**fixed**) | `src/__tests__/platform-no-import-time-bin-resolve.test.ts` + `federation-local-catalog.test.ts` | — |

## Low

| Bug ID | File:Line | Title | Pinning test path | Resolved |
| --- | --- | --- | --- | --- |
| `ci-eslint-typecheck-baseline` | `eslint.config.js`, `tsconfig.json` | strict ESLint landed with 9933 pre-existing violations, plus 1703 pre-existing `tsc --noEmit` errors; CI `lint` job is red by design | n/a (tooling debt, no runtime defect) | — |
| `vault-readvault-missing-entries-fatal` | `src/web/vault.ts:93-96` | `readVault` returns parsed JSON as-is, so any shape that lacks `entries` is fatal on every public call | `src/__tests__/vault.test.ts` | Resolved: 2026-08-17 07f326738f0de0d047ede1ecd178c747e711cbd9 |
| `graph-mail-stat-not-isdir` | `src/graph-mail.ts:105-119` | stat-successful / read-failing `CREDS_PATH` produces an opaque error | `src/__tests__/graph-mail.test.ts` | Resolved: 2026-08-17 482585f |
| `prompt-safety-origin-note-tab-strip` | `src/prompt-safety.ts:96-103` | `sanitizeOriginNote` strips tab/newline/NBSP instead of collapsing them | `src/__tests__/prompt-safety.test.ts` | Resolved: 2026-08-17 cdb771f |
| `pane-state-defensive-branches` | `src/pane-state.ts:1065,1068,1107,1140,1166,1171,1504` | unreachable defensive branches block 100% branch coverage | `src/__tests__/pane-state.test.ts` | Resolved: 2026-08-19 84efdfe |
| `store-watcher-sensitive-names-unreachable` | `src/store-watcher.ts:142` | `SENSITIVE_NAMES` branch is dead code (`is_sensitive` can never be 1) | `src/__tests__/store-watcher.test.ts` | Resolved: 2026-08-18 d79b787 |
| `index-unreachable-coverage` | `src/index.ts:174,283` (was `174,283,382`) | two functions are unreachable from the test harness; the third site (382, the `heartbeatStarted` shutdown guard) was deleted as dead code in 221d5c8 | `src/__tests__/index.test.ts` | — |
| `channel-invites-unreachable-defensive-branches` | `src/web/channel-invites.ts:108,236` | two defensive `if` guards are unreachable through public API; callers gate on the same property | `src/__tests__/channel-invites.test.ts` | Resolved: 2026-08-19 d48256c |
| `web-worker-warmup-ignores-close` | `src/web.ts:339-364` (warm-up) vs `544` (close override) | agent-worker warm-up import has no `close()` cancel flag, unlike the liveness monitor | `src/__tests__/web-server.test.ts` | — |
| `auto-restart-parsehhmm-integer-guard` | `src/auto-restart.ts:63` | `parseHHMM`'s `Number.isInteger` guard is dead code | `src/__tests__/auto-restart.test.ts` | 2026-08-14 014f1de |
| `agent-detect-linux-libc-redundant-guard` | `src/agent.ts:72-80` (line 73) | `detectLinuxLibc`'s platform check is unreachable in production | `src/__tests__/agent-run-paths.test.ts` | 2026-08-14 014f1de |
| `channel-coordinator-internals-untestable` | `src/channel-coordinator.ts:117-441` | internal state-machine functions are not unit-testable | `src/__tests__/channel-coordinator.test.ts` | — |
| `heartbeat-brief-rundiceaysweep-not-applicable` | `src/heartbeat.ts` (no symbol) | task brief mentions `runDecaySweep` integration but the integration does not exist | `src/__tests__/heartbeat-cov.test.ts` | — |
| `http-helpers-gzip-memo-evict-guard` | `src/web/http-helpers.ts:122` | gzip memo eviction guard is dead code (`oldest` can never be `undefined`) | `src/__tests__/http-helpers.test.ts` | Resolved: 2026-08-16 5a2a3a7 |
| `stuck-tool-call-watcher-dead-ternary` | `src/web/stuck-tool-call-watcher.ts:192` | `sinceRespawnMs` ternary has a dead `null` arm (blocks 100% branch coverage) | `src/__tests__/stuck-tool-call-watcher.test.ts` | 2026-08-14 014f1de |
| `keychain-store-insecure-acl` | `src/web/keychain.ts:19` | the master key is written with `-A`, the flag `security(1)` labels "insecure, not recommended" (empty ACL); low because the key is readable without `-A` too | `src/__tests__/keychain.test.ts` | — |
| `vault-bindings-unreachable-coverage` | `src/web/vault-bindings.ts:163,236` | `maskValue`'s `<= 6` branch and `serverHasVaultRefs`'s `!env` branch are unreachable from any caller (`looksLikeSensitiveValue`'s 8-char gate and the `if (!serverCfg.env) continue` guard filter both inputs) | `src/__tests__/vault-bindings.test.ts` | Resolved: 2026-08-18 fa933c4 |
| `agent-process-unreachable-defensive-branches` | `src/web/agent-process.ts:777,1384,1512` | three unreachable defensive branches (`runTmux` remote default timeout, `restartAgentProcess` `||` error fallback, `answerFirstRunGates` loop-exhaustion `'unchanged'` arm) cap branch coverage at 99.38% | `src/__tests__/agent-process.test.ts` | 2026-08-14 08d7508 |
| `routes-ideas-body-parse-500` | `src/web/routes/ideas.ts:43,86,138,152,201` | unguarded `JSON.parse` + destructuring throws out of the handler, so a malformed or `null` body returns 500 "Szerver hiba" instead of 400 | `src/__tests__/ideas-routes.test.ts` | Resolved: 2026-08-17 943dba8 |
| `routes-ideas-breakdown-nonerror` | `src/web/routes/ideas.ts:186-189` | `(err as Error).message` is undefined for a non-Error throw, so the 500 response body is `{}` | `src/__tests__/ideas-routes.test.ts` | Resolved: 2026-08-16 8bdb2cd |
| `routes-ideas-title-validation` | `src/web/routes/ideas.ts:51` | `title` is neither trimmed nor type-checked (unlike the sibling comment endpoint), so a whitespace-only title is stored and an object title 500s in the driver | `src/__tests__/ideas-routes.test.ts` | Resolved: 2026-08-17 cfb72db |
| `fleet-transfer-assertsafename-dead` | `src/web/fleet-transfer.ts:48-52` | `assertSafeName` is defined but never called from anywhere (validateNames inlines `SAFE_NAME_RE.test`); caps line coverage at 99.35% on fleet-transfer.ts | `src/__tests__/fleet-transfer-routes.test.ts` | Resolved: 2026-08-14 08d7508 |
| `test-suite-llm-api-audit-clean` | audit doc (not a bug) | the suite never makes a real LLM call, never reaches a real HTTP endpoint, and never spawns a real child process; every layer is mocked (`globalThis.fetch = vi.fn`, `vi.mock('../agent.js')`, `vi.mock('@anthropic-ai/claude-agent-sdk')`, `vi.mock('node:child_process')`). The user's "LLM call during tests" concern is unfounded; only side effect is the `./store/` pollution | n/a (audit record) | — |
| `overview-routes-yesterday-timestamp-flake` | `src/__tests__/overview-routes.test.ts:534` (was `now - 25h`) | the "yesterday" timestamp is computed as `now - 25 * 60 * 60 * 1000`, which only falls in the `[yesterday, startTs)` bin when `now >= 01:00 LOCAL`. Tests run just past midnight (00:00-01:00) flake-fail because the line lands in the day-before-yesterday bin | `src/__tests__/overview-routes.test.ts` | Resolved: 2026-08-17 9be7a59 |
| `channel-poller-reap-isclaudebinary-unreachable-fallbacks` | `src/web/channel-poller-reap.ts:267,268` | `isClaudeBinary`'s two `?? ''` arms are unreachable (`split(sep, 1)` always yields >= 1 element, `pop()` on it never returns `undefined`); reached in the suite only by patching `String.prototype.split` | `src/__tests__/channel-poller-reap.test.ts` | 2026-08-14 c2b4ea2 |

## Baseline unreachable addenda (2026-08-09 to 2026-08-13)

Additional coverage gaps filed during the unreachable/branches closure pass. Most are
defensive `?? null`/`?? []`/`?? 0` fallback arms that are guarded by upstream checks
and are therefore structurally unreachable. Source-code modifications are out of scope
for the baseline phase; these MDs are handoffs to the future-fix phase.

| Bug ID | Title | Resolved |
| --- | --- | --- |
| `agent-conversation-fractional-limit` | Fractional conversation limits can exceed the requested page size | Resolved: 2026-08-17 7e64fa8 |
| `agent-conversation-malformed-name-uri` | Malformed encoded agent names escape conversation route handling | Resolved: 2026-08-17 aa2650b |
| `agent-process-answerfirstrungates-acted-unchanged-unreachable` | agent-process.ts: `answerFirstRunGates` final-return `'unchanged'` arm is unreachable | Resolved: 2026-08-14 08d7508 |
| `agent-process-restartagentprocess-stop-error-default-unreachable` | agent-process.ts: `restartAgentProcess` `||` default error string is unreachable | Resolved: 2026-08-14 08d7508 |
| `agent-process-runtmux-host-truthy-cond-unreachable` | agent-process.ts: `runTmux` `(host ? 8000 : 3000)` truthy arm is unreachable | Resolved: 2026-08-18 e5cfea6 |
| `agent-restart-policy-consecutivefailures-nullish-coalesce` | agent-restart-policy.ts: `consecutiveFailures ?? 0` nullish-coalesce left arm is unreachable | Resolved: 2026-08-16 410ca1655 |
| `agent-scaffold-unreachable-defensive-branches` | agent-scaffold.ts: four unreachable defensive branches block 100% branch coverage | 2026-08-14 c2b4ea2 |
| `agent-team-trustfrom-nullish-coalesce` | agent-team.ts: `team.trustFrom ?? []` nullish-coalesce right-arm is unreachable | Resolved: 2026-08-19 7e1277c |
| `agent-worker-array-claude-json` | agent-worker.ts: array-valued host .claude.json silently drops the worker's trust flags | — |
| `agent-worker-blank-line-v8-quirk` | agent-worker.ts: a 20. sor (üres sor) v8 coverage quirk miatt 1 line uncoverable | Resolved: 2026-08-17 461b2b4 |
| `agent-worker-ensure-ready-throw` | agent-worker.ts: ensureWorkerReady does not catch startWorkerSessionFor throws | — |
| `agent-worker-runviaworker-afterloop` | agent-worker.ts: runViaWorker's after-loop `return` is dead code | Resolved: 2026-08-17 911de24 |
| `agent-worker-seedworkercredentials-unreachable` | agent-worker.ts: seedWorkerCredentials mkdirSync arm is unreachable | Resolved: 2026-08-17 a58a811 |
| `agent-worker-selfheal-catch-unreachable` | agent-worker.ts: ensureWorkerReady's self-heal catch arm is unreachable | Resolved: 2026-08-17 2e9ab6f |
| `agent-worker-settings-symlink-preserve` | agent-worker.ts: ensureWorkerCwd drops the shared settings.json content when the link is replaced | — |
| `agent-worker-symlink-catch` | agent-worker.ts: ensureWorkerCwd's symlinkSync catch is unreachable from tests | Resolved: 2026-08-17 e16bc34 |
| `approvals-raw-resolved-by-in-log` | approvals PATCH logger receives untrimmed resolved_by | Resolved: 2026-08-16 9173b54 |
| `auto-restart-runner-unreachable-defensive-fallbacks` | auto-restart-runner.ts: two `??` fallbacks are unreachable defensive code | 2026-08-14 c2b4ea2 |
| `channel-coordinator-coverage-limits` | channel-coordinator.ts: unreachable branches block 100% branch coverage | Resolved: 2026-08-18 e5cfea6 |
| `channel-health-monitor-spawndetach-inflight-redundant-guard` | channel-health-monitor.ts: spawnDetachedReconnect's in-flight guard is unreachable through public API | Resolved: 2026-08-18 8046287 |
| `channel-monitor-agentdownsince-nullish-coalesce` | channel-monitor.ts: agentDownSince.get(t.session) ?? Date.now() at line 1647 is structurally dead | 2026-08-14 c2b4ea2 |
| `channel-monitor-t-agentname-nullish-coalesce` | channel-monitor.ts: t.agentName ?? t.session at lines 1455 and 1494 is structurally dead | 2026-08-14 08d7508 |
| `channel-monitor-test-holes` | channel-monitor.ts: pinned test holes in handleMarveenDown cascade + post-resume guard | — |
| `channel-monitor-unreachable-defensive-branches` | channel-monitor.ts: seven unreachable defensive branches block 100% branch coverage | — |
| `channel-plugin-unlock-unreachable-raw-nullish-fallback` | channel-plugin-unlock.ts: `raw ?? ''` nullish fallback is structurally unreachable | 2026-08-14 c2b4ea2 |
| `channel-request-watcher-unreachable-provider-check` | channel-request-watcher.ts: lookupChannelName's `if (provider !== 'slack') return` is unreachable | — |
| `claude-credentials-guard-line-224-dead-code` | claude-credentials-guard.ts: line 224 `?? ''` fallback is dead code | 2026-08-15 cd1bc00 |
| `command-task-persist-healthmap-empty-fallback-unreachable` | command-task.ts: `persist()` `healthMap ?? {}` empty-fallback arm is unreachable | 2026-08-15 af4c087 |
| `context-guard-runner-dead-code-branches` | context-guard-runner.ts: four branches in the restart/request-handoff switch are unreachable | Resolved: 2026-08-19 40980b4 |
| `federation-capability-runner-unreachable-promise-resolve` | federation/capability-runner.ts: the `?? Promise.resolve()` right branch is structurally unreachable defensive code | 2026-08-14 08d7508 |
| `federation-poller-defensive-coverage` | federation/poller.ts: belt catch and startFederationPoller swallow require contrived test setups | Resolved: 2026-08-19 5c7dbe0 |
| `federation-v8-coverage-quirks` | v8 coverage reports unreachable binary-expr branches in federation.ts | — |
| `federation-validator-refusal-paths` | federation.ts validator-refusal 400 paths are unreachable in practice | 2026-08-14 08d7508 |
| `fleet-transfer-agents-nullish-coalesce-dead-code` | fleet-transfer.ts: `fleet.agents ?? []` nullish-coalesce right arm is unreachable | 2026-08-14 014f1de |
| `fleet-transfer-fleet-agents-nullish-unreachable` | fleet-transfer.ts: `fleet.agents ?? []` nullish-coalesce right-arms are unreachable (7 sites) | 2026-08-14 014f1de |
| `message-router-cache-fallback-unreachable` | message-router.ts: cached session-lookup `??` fallback arms are unreachable | — |
| `message-router-dead-defensive-branches` | message-router.ts: three dead defensive branches block 100% branch coverage | Partially resolved: 2026-08-19 ba6faf8 |
| `message-router-unreachable-defensive-branches` | message-router.ts: four unreachable defensive branches block 100% branch coverage | Partially resolved: 2026-08-19 ba6faf8 |
| `model-suggest-buildreason-preapplied-fallbacks-unreachable` | model-suggest.ts: `buildReason` `signals` and field-specific `?? 0` fallbacks are unreachable | 2026-08-14 c2b4ea2 |
| `model-suggest-buildreason-unreachable-fallbacks` | model-suggest.ts: three unreachable `?? X` fallbacks in buildReason block 100% branch coverage | 2026-08-14 c2b4ea2 |
| `openrouter-models-tier1-auto-empty-fallback` | openrouter-models.ts: `??` misses the empty-string tier1.auto fallback | Resolved: 2026-08-18 63d62da |
| `password-hash-defensive-branches` | password-hash.ts: two defensive branches unreachable through real inputs | 2026-08-14 c2b4ea2 |
| `platform-xdg-session-type-tty-bug` | platform.ts: XDG_SESSION_TYPE=tty is misclassified as `linux-gui` | Resolved: 2026-08-18 cb68aad |
| `reauth-healer-stampalert-if-st-dead-code` | reauth-healer.ts: stampAlert `if (st)` false branch is dead code | 2026-08-14 c2b4ea2 |
| `reauth-healer-sweep-callsite-dead-arms` | reauth-healer.ts: two structurally unreachable arms at lines 391 and 395 | 2026-08-14 c2b4ea2 |
| `recall-dayofweek-noon-utc-far-east-skew` | routes/recall.ts: dayOfWeekBudapest anchors at noon UTC but reads the weekday in APP_TZ, so every week-range is off by a day for install zones at UTC+12 and beyond | — |
| `recall-unreachable-defensive-fallbacks` | recall.ts: two unreachable defensive `?? 0` fallbacks block 100% branch coverage | Resolved: 2026-08-16 3bec823 |
| `remote-enroll-core-merge-trailing-newline-skip` | `mergeAuthorizedKeys` trailing-newline guard (description corrected; no code change needed) | Documented only — source unchanged |
| `remote-enroll-fs-lock-vanish-spin` | `acquireLock` spins forever when statSync throws but the lock file is still there | Resolved: 2026-08-19 7d76d14 |
| `remote-enroll-fs-rename-failure-cleanup-untestable` | `writeAtomic` rename-failure cleanup is unreachable in the type system | Documented only — source unchanged |
| `route-token-usage-nan-params` | NaN-via-parseInt: numeric query params silently default to NaN | Resolved: 2026-08-17 46e97a9ba973c094bd7f5c67cbd65a19254b66a3 |
| `routes-agent-team-unreachable-branches` | routes/agent-team.ts: file path does not exist; coverage pin moved to web/agent-team.ts | Resolved: 2026-08-18 e5cfea6 |
| `routes-agent-terminal-literalkeys-nullish` | agent-terminal.ts: unreachable `literalKeys ?? ''` on the audit-preview line blocks 100% branch coverage | 2026-08-14 c2b4ea2 |
| `routes-agents-br-baseline-partial-coverage` | routes/agents.ts: remaining uncovered branches after baseline regression tests | — |
| `routes-agents-parse-channel-provider-dead-branches` | routes/agents.ts: parseChannelProvider / matchChannelProvider else branches are dead code | Resolved: 2026-08-16 3e1dd3f |
| `routes-agents-parsechannelprovider-dead-branch` | routes/agents.ts: parseChannelProvider's `return null` branch is unreachable through the public API | Resolved: 2026-08-16 3e1dd3f |
| `routes-agents-skills-unreachable-stat-throw` | agents-skills.ts: unreachable `catch { return false }` on the extracted-skills filter | 2026-08-14 c2b4ea2 |
| `routes-background-tasks-delete-clobber` | routes/background-tasks.ts: DELETE clobbers an already finished task | Resolved: 2026-08-17 231eb21a4c5852a1a7fe5f1f450b5cef6a93881e |
| `routes-background-tasks-post-invalid-json` | routes/background-tasks.ts: malformed POST body returns 500 instead of 400 | Resolved: 2026-08-17 780f126a0a433a8c68bc6297b54edfee8cb7094b |
| `routes-background-tasks-session-ended-status` | routes/background-tasks.ts: a dead session is `done` in the poller but `failed` in the sweeper | Resolved: 2026-08-19 19d7991 |
| `routes-background-tasks-sweep-timeout-reset` | routes/background-tasks.ts: restart grants every surviving task a fresh 30 minutes | Resolved: 2026-08-19 19d7991 |
| `routes-background-tasks-unused-imports` | routes/background-tasks.ts: unused imports (`execSync`, `markOrphanedTasksFailed`) | 2026-08-14 68b94fe |
| `routes-connectors-hu-config-nostring-token` | routes-connectors-hu-config-nostring-token | Resolved: 2026-08-17 5a348eadbfd7d4a9ef65e6d22e783a4e9473ff4b |
| `routes-dashboard-auth-nonexistent-sut` | routes/dashboard-auth.ts does not exist; task brief references the wrong path | Resolved: 2026-08-18 e5cfea6 |
| `routes-docs-basename-redundant` | routes/docs.ts: the `basename(name) !== name` check in /api/docs/<name> is unreachable | Resolved: 2026-08-18 e4ec60b |
| `routes-docs-inner-catch-no-title-reset` | routes/docs.ts: inner per-file catch does not reset `title` despite the comment | Resolved: 2026-08-17 16949d9 |
| `routes-fleet-q-404-leaks-roster` | fleet-q.ts: PUT /api/agents/:name/capabilities -- 404 message leaks internal agent identity | Resolved: 2026-08-18 b7cd64c |
| `routes-fleet-q-body-parse-uncaught` | fleet-q.ts: PUT /api/agents/:name/capabilities -- unguarded readBody + JSON.parse crash | Resolved: 2026-08-18 b7cd64c |
| `routes-reauth-detect-missing-source-path` | routes/reauth-detect: task target path does not exist on disk | Resolved: 2026-08-18 e5cfea6 |
| `routes-reauth-healer-missing-file` | src/web/routes/reauth-healer.ts does not exist; the actual file lives at src/web/reauth-healer.ts | Resolved: 2026-08-18 e5cfea6 |
| `routes-remote-status-cache-path-mismatch` | routes/remote-status-cache: task path does not exist on disk | Resolved: 2026-08-18 e5cfea6 |
| `routes-research-basename-redundant` | research.ts: `basename(name) !== name` check unreachable (mirrors routes-docs-basename-redundant) | Resolved: 2026-08-18 e62eb87 |
| `routes-research-double-stat-inefficiency` | research.ts:32,44,72-73 -- listing branch performs 2N+1 statSync per agent; could halve syscalls with readdirSync({withFileTypes: true}) + lstat | Resolved: 2026-08-19 68d19c6 |
| `routes-research-malformed-uri-500` | research.ts:61 -- decodeURIComponent on regex path throws URIError → web.ts 500 instead of 400 | Resolved: 2026-08-18 7aa9551 |
| `routes-research-stale-basename-narrative` | research.ts:8-11 + research-routes.test.ts:8-11 -- stale basename-checked comments after basename removal (cycle 30) | Resolved: 2026-08-18 a0d981d |
| `routes-research-symlink-traversal` | research.ts:72 -- existsSync + statSync follow symlinks; leak.md symlink serves arbitrary file content via /api/research/<agent>/leak.md | Resolved: 2026-08-19 68d19c6 |
| `routes-skill-usage-jsonparse-throws` | skill-usage.ts: POST /api/skill-usage lets malformed JSON throw | Resolved: 2026-08-17 08a64603de2ef2f069fce05a44d0652815ef2070 |
| `routes-skills-dead-branches` | routes/skills.ts: defensive dead branches in sort, walker, and importer | 2026-08-14 c2b4ea2 |
| `routes-spans-nan-limit` | routes/spans -- NaN limit on GET /api/traces passed straight to listOtelTraces | Resolved: 2026-08-17 f11aee27c1710eae7f056d91ab11c0c8809ed71f |
| `routes-tool-log-uncaught-json-parse` | routes-tool-log-uncaught-json-parse | Resolved: 2026-08-17 0d23278 |
| `routes-update-checker-dead-catch-handlers` | Dead `.catch(() => {})` handlers in startUpdateChecker | — | Resolved: 2026-08-18 38a3189 |
| `routes-update-checker-path-mismatch` | Task prompt referenced a path that does not exist | Resolved: 2026-08-18 e5cfea6 |
| `routes-updates-release-lock-unreachable-defensive-branch` | routes/updates.ts: releaseLock's `if (!lockHeld) return` is structurally unreachable | 2026-08-14 c2b4ea2 |
| `routes-voice-runproc-stdin-dead` | src/web/routes/voice.ts: runProc has two unreachable defensive branches | Resolved: 2026-08-18 e5cfea6 |
| `schedule-mcp-precheck-subtree-cycle-defensive` | schedule-mcp-precheck.ts: collectSubtreeCmdlines cycle guard is only reachable through malformed ps output | Documented only — source unchanged |
| `schedule-runner-mcpmissingreason-cache-miss-unreachable` | schedule-runner: `mcpMissingReason` cache-miss branch is unreachable | Resolved: 2026-08-18 2c36e37 |
| `schedules-expand-prompt-missing-answers` | Expand-prompt crashes when answers is omitted | Resolved: 2026-08-17 d99f171 |
| `skills-import-seg-truthy-guard` | skills.ts:409 -- `if (seg)` truthy guard is unreachable | 2026-08-14 c2b4ea2 |
| `skills-sort-comparator-falsy-arms` | skills.ts:157 -- `label || name` nullish fallback is unreachable | 2026-08-14 c2b4ea2 |
| `stuck-input-watcher-give-up-inner-if-unreachable` | stuck-input-watcher.ts: the give-up `prev.attempts < maxAttempts` inner-if is unreachable | Resolved: 2026-08-19 edae3f1 |
| `stuck-tool-call-watcher-respawn-ternary-null-unreachable` | stuck-tool-call-watcher: sinceRespawnMs ternary `:null` arm is unreachable | 2026-08-14 014f1de |
| `telegram-client-probehighwater-ignores-okfalse` | telegram-client.ts: `probeHighWater` ignores `ok: false` in the body and returns a fake `update_id` | Resolved: 2026-08-18 1672bf5 |
| `updates-release-lock-unreachable` | updates.ts:198 -- releaseLock's `if (!lockHeld) return` early-exit is unreachable | 2026-08-14 c2b4ea2 |
| `vault-ssh-keys-import-newline-trim-bug` | vault-ssh-keys.ts: the import handler's `endsWith('\n')` branch is unreachable | Resolved: 2026-08-16 9aa71e5 |
| `voice-directive-json-quote-escape` | src/web/voice-directive.ts: only single quotes are escaped, so `"` / `\` in the state dir emits invalid JSON | Resolved: 2026-08-19 be2cfee |
| `web-agent-bundle-single-line-trycatch` | agent-bundle.ts: single-line try-catch and defensive-guard branches block 100% branch coverage | 2026-08-14 68b94fe |
| `web-agent-scaffold-defensive-coverage` | web/agent-scaffold.ts: 18 defensive nullish-coalesce / guard branches cap branch coverage at 93.61% | — |
| `web-agent-worker-runviaworker-coverage` | agent-worker: runViaWorker / runWorkerAttempt / ensureWorkerReady integration paths lack 100% unit-test coverage | — |
| `web-inbound-probe-cache-sticky` | Redundant assignment (dead store): `_warnedChatIdAbsent = false` reset at line 246 has no behavioral effect | Resolved: 2026-08-20 3926df6 |
| `web-inbound-probe-respawn-grace` | Defect: stuck mod-scope cache blocks coverage of `shouldTriggerDeafnessRespawn` respawn branches | — |

## Orphan addenda (2026-08-15 reconcile v3)

MD files filed during the closure pass that were never added to the index. Each row
is the MD heading's File:Line and title; pinning test path is `-` where the MD does
not document one. File:Line points at the line where the bug code actually lives at
HEAD (corrected from the MD heading if off-by-one). Resolved is `<YYYY-MM-DD> <sha>`
when a commit on `test/baseline` already deleted the buggy defensive guard, `-` otherwise.

| Bug ID | File:Line | Title | Pinning test path | Resolved |
| --- | --- | --- | --- | --- |
| `agent-process-777-ts-strict-blocks-delete` | `src/web/agent-process.ts:777` | runTmux timeout required-delete blocked | - | Resolved: 2026-08-16 a71cc759 |
| `agent-team-trustfrom-required-type-narrow-deferred` | `src/web/agent-team.ts:191,192` | trustFrom type-narrow deferred | - | Resolved: 2026-08-19 7e1277c |
| `agent-terminal-218-ts-strict-blocks-delete` | `src/web/routes/agent-terminal.ts:218` | TS strict blocks the safe-delete | - | Resolved: 2026-08-20 c8ce4a4 |
| `agent-terminal-keys-preview-literalKeys-fallback` | `src/web/routes/agent-terminal.ts:218` | literalKeys ?? '' fallback is unreachable | - | Resolved: 2026-08-20 c8ce4a4 |
| `agents-parseChannelProvider-return-null` | `src/web/routes/agents.ts:231` | parseChannelProvider's null return is unreachable | - | Resolved: 2026-08-16 3e1dd3f |
| `channel-coordinator-setOffset-null-maxUpdateId` | `src/channel-coordinator.ts:401` | maxUpdateId != null setOffset FALSE branch is unreachable | `src/__tests__/channel-coordinator-process-batch.test.ts` | Resolved: 2026-08-16 1a9d0d5a |
| `channel-invites-108-ts-strict-blocks-delete` | `src/web/channel-invites.ts:108` | TS strict blocks the safe-delete | - | Resolved: 2026-08-19 d48256c |
| `channel-invites-236-ts-strict-blocks-delete` | `src/web/channel-invites.ts:236` | TS strict blocks the safe-delete | - | Resolved: 2026-08-19 d48256c |
| `channel-monitor-agentDownSince-fallback` | `src/web/channel-monitor.ts:1647` | agentDownSince.get() ?? Date.now() fallback is unreachable | - | 2026-08-14 c2b4ea2 |
| `channel-monitor-agentName-fallbacks` | `src/web/channel-monitor.ts:1455,1494` | t.agentName ?? t.session fallback is unreachable | - | 2026-08-14 08d7508 |
| `federation-inbox-fedPeer-null-fallback` | `src/web/routes/federation.ts:329` | ctx.fedPeer ?? null fallback is unreachable (MD heading off-by-one: line 330 in MD, actual code at line 329) | - | - |
| `federation-rememberRef-oldest-undefined` | `src/web/routes/federation.ts:93` | rememberRef's if (oldest !== undefined) falsy arm is unreachable | - | 2026-08-14 08d7508 |
| `federation-routes-fedpeer-required-type-narrow-deferred` | `src/web/routes/federation.ts:298,329` | fedPeer type-narrow deferred | - | - |
| `index-283-test-pins-error-wiring` | `src/index.ts:283` | buildPidfileLockContext.log.error is pinned by TS strict (process-lock.ts:253 requires it) and a positive test (index.test.ts:1382 'forwards pidfile context errors to logger.error') | `src/__tests__/index.test.ts:1382` | - |
| `index-stopHeartbeat-throw` | `src/index.ts:382` | stopHeartbeat-throws-during-shutdown catch is unreachable | `src/__tests__/index.test.ts` | Resolved: 2026-08-16 221d5c8 |
| `mcp-list-warn-execError-dead-branch` | `src/web/mcp-list.ts:135` | warn() payload's execError ? truthy arm is unreachable | `src/__tests__/mcp-list.test.ts` | Resolved: 2026-08-16 c1ee774 |
| `recall-dayOfWeekBudapest-fallback` | `src/web/routes/recall.ts:25` | dayOfWeekBudapest's weekday-map fallback is unreachable | - | Resolved: 2026-08-16 3bec823 |
| `recall-weekIdx-fallback` | `src/web/routes/recall.ts:153` | weekIdx ?? 0 fallback is unreachable | - | Resolved: 2026-08-16 3bec823 |
| `routes-agents-parseChannelProvider-dead-code` | `src/web/routes/agents.ts:232` | parseChannelProvider `return null` branch is unreachable | `src/__tests__/agents-routes.test.ts` | Resolved: 2026-08-16 3e1dd3f |
| `routes-recall-153-ts-strict-blocks-delete` | `src/web/routes/recall.ts:153` | TS strict blocks the safe-delete | - | Resolved: 2026-08-16 3bec823 |
| `routes-recall-25-ts-strict-blocks-delete` | `src/web/routes/recall.ts:25` | TS strict blocks the safe-delete | - | Resolved: 2026-08-16 3bec823 |
| `vault-ssh-keys-endsWith-newline` | `src/web/routes/vault-ssh-keys.ts:126` | privateKey.endsWith('\n') IF branch is unreachable | `src/__tests__/routes-vault-ssh-keys.test.ts` | Resolved: 2026-08-16 9aa71e5 |
| `voice-timer-stdinData-fallbacks` | `src/web/routes/voice.ts:74,79` | runProc timer and stdinData fallbacks are unreachable | - | 2026-08-14 c2b4ea2 |
