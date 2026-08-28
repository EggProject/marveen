# needs-to-be-fix — baseline unreachable addenda (2026-08-09 to 2026-08-13)

Additional coverage gaps filed during the unreachable/branches closure pass. Most are
defensive `?? null`/`?? []`/`?? 0` fallback arms that are guarded by upstream checks
and are therefore structurally unreachable. Source-code modifications are out of scope
for the baseline phase; these MDs are handoffs to the future-fix phase.

99 rows.

| Bug ID | Title | Resolved |
| --- | --- | --- |
| `agent-conversation-fractional-limit` | Fractional conversation limits can exceed the requested page size | Resolved: 2026-08-17 7e64fa8 |
| `agent-conversation-malformed-name-uri` | Malformed encoded agent names escape conversation route handling | Resolved: 2026-08-17 aa2650b |
| `agent-process-answerfirstrungates-acted-unchanged-unreachable` | agent-process.ts: `answerFirstRunGates` final-return `'unchanged'` arm is unreachable | Resolved: 2026-08-14 08d7508 |
| `agent-process-restartagentprocess-stop-error-default-unreachable` | agent-process.ts: `restartAgentProcess` `\|\|` default error string is unreachable | Resolved: 2026-08-14 08d7508 |
| `agent-process-runtmux-host-truthy-cond-unreachable` | agent-process.ts: `runTmux` `(host ? 8000 : 3000)` truthy arm is unreachable | Resolved: 2026-08-18 e5cfea6 |
| `agent-restart-policy-consecutivefailures-nullish-coalesce` | agent-restart-policy.ts: `consecutiveFailures ?? 0` nullish-coalesce left arm is unreachable | Resolved: 2026-08-16 410ca1655 |
| `agent-scaffold-unreachable-defensive-branches` | agent-scaffold.ts: four unreachable defensive branches block 100% branch coverage | 2026-08-14 c2b4ea2 |
| `agent-team-trustfrom-nullish-coalesce` | agent-team.ts: `team.trustFrom ?? []` nullish-coalesce right-arm is unreachable | Resolved: 2026-08-19 7e1277c |
| `agent-worker-array-claude-json` | agent-worker.ts: array-valued host .claude.json silently drops the worker's trust flags | Resolved: 2026-08-20 776bd02de7b0b7ef8cda5568d3041f2bb64e534b |
| `agent-worker-blank-line-v8-quirk` | agent-worker.ts: a 20. sor (üres sor) v8 coverage quirk miatt 1 line uncoverable | Resolved: 2026-08-17 461b2b4 |
| `agent-worker-ensure-ready-throw` | agent-worker.ts: ensureWorkerReady does not catch startWorkerSessionFor throws | Resolved: 2026-08-20 e65ca08b7cc9cb670f2955efb7ba5d71dda1a924 |
| `agent-worker-runviaworker-afterloop` | agent-worker.ts: runViaWorker's after-loop `return` is dead code | Resolved: 2026-08-17 911de24 |
| `agent-worker-seedworkercredentials-unreachable` | agent-worker.ts: seedWorkerCredentials mkdirSync arm is unreachable | Resolved: 2026-08-17 a58a811 |
| `agent-worker-selfheal-catch-unreachable` | agent-worker.ts: ensureWorkerReady's self-heal catch arm is unreachable | Resolved: 2026-08-17 2e9ab6f |
| `agent-worker-settings-symlink-preserve` | agent-worker.ts: ensureWorkerCwd drops the shared settings.json content when the link is replaced | Resolved: 2026-08-21 e40c7f0 (with b70a1f7; regression test in 24bea87) |
| `agent-worker-symlink-catch` | agent-worker.ts: ensureWorkerCwd's symlinkSync catch is unreachable from tests | Resolved: 2026-08-17 e16bc34 |
| `approvals-raw-resolved-by-in-log` | approvals PATCH logger receives untrimmed resolved_by | Resolved: 2026-08-16 9173b54 |
| `auto-restart-runner-unreachable-defensive-fallbacks` | auto-restart-runner.ts: two `??` fallbacks are unreachable defensive code | 2026-08-14 c2b4ea2 |
| `channel-coordinator-coverage-limits` | channel-coordinator.ts: unreachable branches block 100% branch coverage | Resolved: 2026-08-18 e5cfea6 |
| `channel-health-monitor-spawndetach-inflight-redundant-guard` | channel-health-monitor.ts: spawnDetachedReconnect's in-flight guard is unreachable through public API | Resolved: 2026-08-18 8046287 |
| `channel-monitor-agentdownsince-nullish-coalesce` | channel-monitor.ts: agentDownSince.get(t.session) ?? Date.now() at line 1647 is structurally dead | 2026-08-14 c2b4ea2 |
| `channel-monitor-t-agentname-nullish-coalesce` | channel-monitor.ts: t.agentName ?? t.session at lines 1455 and 1494 is structurally dead | 2026-08-14 08d7508 |
| `channel-monitor-test-holes` | channel-monitor.ts: pinned test holes in handleMarveenDown cascade + post-resume guard | Resolved: 2026-08-21 28b37d9 |
| `channel-monitor-unreachable-defensive-branches` | channel-monitor.ts: seven unreachable defensive branches block 100% branch coverage | Resolved: 2026-08-21 0ccf795 |
| `channel-plugin-unlock-unreachable-raw-nullish-fallback` | channel-plugin-unlock.ts: `raw ?? ''` nullish fallback is structurally unreachable | 2026-08-14 c2b4ea2 |
| `channel-request-watcher-unreachable-provider-check` | channel-request-watcher.ts: lookupChannelName's `if (provider !== 'slack') return` is unreachable | Resolved: 3c43926394d2e82caf01c38cd25aee074117acff, documented only; tripwire comment at src/web/channel-request-watcher.ts:67-76 (guard at line 77). Guard kept as token-leak defense per MD DO NOT RAW-DELETE (commit 1b105fd TOKEN LEAK invariant). |
| `claude-credentials-guard-line-224-dead-code` | claude-credentials-guard.ts: line 224 `?? ''` fallback is dead code | 2026-08-15 cd1bc00 |
| `command-task-persist-healthmap-empty-fallback-unreachable` | command-task.ts: `persist()` `healthMap ?? {}` empty-fallback arm is unreachable | 2026-08-15 af4c087 |
| `context-guard-runner-dead-code-branches` | context-guard-runner.ts: four branches in the restart/request-handoff switch are unreachable | Resolved: 2026-08-19 40980b4 |
| `federation-capability-runner-unreachable-promise-resolve` | federation/capability-runner.ts: the `?? Promise.resolve()` right branch is structurally unreachable defensive code | 2026-08-14 08d7508 |
| `federation-poller-defensive-coverage` | federation/poller.ts: belt catch and startFederationPoller swallow require contrived test setups | Resolved: 2026-08-19 5c7dbe0 |
| `federation-v8-coverage-quirks` | v8 coverage reports unreachable binary-expr branches in federation.ts | Resolved: 2026-08-13 1496c00 (provider switch to istanbul, v8 inspector unsupported in bun) |
| `federation-validator-refusal-paths` | federation.ts validator-refusal 400 paths are unreachable in practice | 2026-08-14 08d7508 |
| `fleet-transfer-agents-nullish-coalesce-dead-code` | fleet-transfer.ts: `fleet.agents ?? []` nullish-coalesce right arm is unreachable | 2026-08-14 014f1de |
| `fleet-transfer-fleet-agents-nullish-unreachable` | fleet-transfer.ts: `fleet.agents ?? []` nullish-coalesce right-arms are unreachable (7 sites) | 2026-08-14 014f1de |
| `message-router-cache-fallback-unreachable` | message-router.ts: cached session-lookup `??` fallback arms are unreachable | Resolved: 2026-08-25 232fac7 (isMainAgent ternary at line 483 deleted via `const host = cached.host`; combined with 900cdb6; file-level branch coverage 99.24% -> 100%) -- see message-router-cache-fallback-unreachable.md |
| `message-router-dead-defensive-branches` | message-router.ts: three dead defensive branches block 100% branch coverage | Resolved: 2026-08-25 232fac7 (line 483 isMainAgent ternary deleted; combined with prior ba6faf8 + 900cdb6 cleanup; file-level branch coverage reaches 100%) |
| `message-router-unreachable-defensive-branches` | message-router.ts: five unreachable defensive branches block 100% branch coverage | Resolved: 2026-08-25 232fac7 (line 483 isMainAgent ternary deleted; combined with prior ba6faf8 + 900cdb6 cleanup; file-level branch coverage reaches 100%) |
| `model-suggest-buildreason-preapplied-fallbacks-unreachable` | model-suggest.ts: `buildReason` `signals` and field-specific `?? 0` fallbacks are unreachable | 2026-08-14 c2b4ea2 |
| `model-suggest-buildreason-unreachable-fallbacks` | model-suggest.ts: three unreachable `?? X` fallbacks in buildReason block 100% branch coverage | 2026-08-14 c2b4ea2 |
| `password-hash-defensive-branches` | password-hash.ts: two defensive branches unreachable through real inputs | 2026-08-14 c2b4ea2 |
| `platform-xdg-session-type-tty-bug` | platform.ts: XDG_SESSION_TYPE=tty is misclassified as `linux-gui` | Resolved: 2026-08-18 cb68aad |
| `reauth-healer-stampalert-if-st-dead-code` | reauth-healer.ts: stampAlert `if (st)` false branch is dead code | 2026-08-14 c2b4ea2 |
| `reauth-healer-sweep-callsite-dead-arms` | reauth-healer.ts: two structurally unreachable arms at lines 391 and 395 | 2026-08-14 c2b4ea2 |
| `recall-dayofweek-noon-utc-far-east-skew` | routes/recall.ts: dayOfWeekBudapest anchors at noon UTC but reads the weekday in APP_TZ, so every week-range is off by a day for install zones at UTC+12 and beyond | Resolved: 2026-08-20 482a9ea |
| `recall-unreachable-defensive-fallbacks` | recall.ts: two unreachable defensive `?? 0` fallbacks block 100% branch coverage | Resolved: 2026-08-16 3bec823 |
| `remote-enroll-core-merge-trailing-newline-skip` | `mergeAuthorizedKeys` trailing-newline guard (description corrected; no code change needed) | MD retired -- original framing wrong; no code change needed |
| `remote-enroll-fs-lock-vanish-spin` | `acquireLock` spins forever when statSync throws but the lock file is still there | Resolved: 2026-08-19 7d76d14 |
| `remote-enroll-fs-rename-failure-cleanup-untestable` | `writeAtomic` rename-failure cleanup is unreachable in the type system | MD retired -- original framing wrong; no code change needed |
| `route-token-usage-nan-params` | NaN-via-parseInt: numeric query params silently default to NaN | Resolved: 2026-08-17 46e97a9ba973c094bd7f5c67cbd65a19254b66a3 |
| `routes-agent-team-unreachable-branches` | routes/agent-team.ts: file path does not exist; coverage pin moved to web/agent-team.ts | Resolved: 2026-08-18 e5cfea6 |
| `routes-agent-terminal-literalkeys-nullish` | agent-terminal.ts: unreachable `literalKeys ?? ''` on the audit-preview line blocks 100% branch coverage | 2026-08-14 c2b4ea2 |
| `routes-agents-br-baseline-partial-coverage` | routes/agents.ts: remaining uncovered branches after baseline regression tests | Resolved: 2026-08-26 cf85135 (deletion-based fix 81ef7f6 reversed: VALID_PROVIDERS const + parseChannelProvider throw arm restored; function renamed to `__test_parseChannelProvider` (exported with `__test_` test-only prefix per cycle 47-48 channel-coordinator-internals-untestable.md pattern); new test at agents-routes.test.ts:3951 exercises the throw arm via direct call; file-level branch coverage maintained at 100%) |
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
| `routes-updates-release-lock-unreachable-defensive-branch` | routes/updates.ts: releaseLock's `if (!lockHeld) return` is structurally unreachable | Resolved: 2026-08-14 c2b4ea20f52bd8ed2efeb43c298b8b9668d1d6c3 |
| `routes-voice-runproc-stdin-dead` | src/web/routes/voice.ts: runProc has two unreachable defensive branches | Resolved: 2026-08-18 e5cfea6 |
| `schedule-runner-mcpmissingreason-cache-miss-unreachable` | schedule-runner: `mcpMissingReason` cache-miss branch is unreachable | Resolved: 2026-08-18 2c36e37 |
| `schedules-expand-prompt-missing-answers` | Expand-prompt crashes when answers is omitted | Resolved: 2026-08-17 d99f171 |
| `skills-import-seg-truthy-guard` | skills.ts:409 -- `if (seg)` truthy guard is unreachable | 2026-08-14 c2b4ea2 |
| `skills-sort-comparator-falsy-arms` | skills.ts:157 -- `label \|\| name` nullish fallback is unreachable | 2026-08-14 c2b4ea2 |
| `stuck-input-watcher-give-up-inner-if-unreachable` | stuck-input-watcher.ts: the give-up `prev.attempts < maxAttempts` inner-if is unreachable | Resolved: 2026-08-19 edae3f1 |
| `stuck-tool-call-watcher-respawn-ternary-null-unreachable` | stuck-tool-call-watcher: sinceRespawnMs ternary `:null` arm is unreachable | 2026-08-14 014f1de |
| `telegram-client-probehighwater-ignores-okfalse` | telegram-client.ts: `probeHighWater` ignores `ok: false` in the body and returns a fake `update_id` | Resolved: 2026-08-18 1672bf5 |
| `updates-release-lock-unreachable` | updates.ts:198 -- releaseLock's `if (!lockHeld) return` early-exit is unreachable | 2026-08-14 c2b4ea2 |
| `vault-ssh-keys-import-newline-trim-bug` | vault-ssh-keys.ts: the import handler's `endsWith('\n')` branch is unreachable | Resolved: 2026-08-16 9aa71e5 |
| `voice-directive-json-quote-escape` | src/web/voice-directive.ts: only single quotes are escaped, so `"` / `\` in the state dir emits invalid JSON | Resolved: 2026-08-19 be2cfee |
| `web-agent-bundle-single-line-trycatch` | agent-bundle.ts: single-line try-catch and defensive-guard branches block 100% branch coverage | 2026-08-14 68b94fe |
| `web-agent-scaffold-defensive-coverage` | web/agent-scaffold.ts: 18 defensive nullish-coalesce / guard branches cap branch coverage at 93.61% | Resolved: 2026-08-26 642b883 (line 602 defensive ternary dropped; branch coverage 99.63% -> 100%; 17 sibling sites resolved in c2b4ea2, the line 602 site was the only survivor) |
| `web-agent-worker-runviaworker-coverage` | agent-worker: runViaWorker / runWorkerAttempt / ensureWorkerReady integration paths lack 100% unit-test coverage | Resolved: 2026-08-26 f75caf6 |
| `web-inbound-probe-cache-sticky` | Redundant assignment (dead store): `_warnedChatIdAbsent = false` reset at line 246 has no behavioral effect | Resolved: 2026-08-20 3926df6 |
| `web-inbound-probe-respawn-grace` | Defect: stuck mod-scope cache blocks coverage of `shouldTriggerDeafnessRespawn` respawn branches | Resolved: 2026-08-26 dbc25ab -- NO-OP, coverage already at 100% (145/145) lines / 100% (74/74) branches; MD fix option 3 was applied in c333a6f (2026-08-08) but never back-annotated |