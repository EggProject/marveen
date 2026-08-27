# needs-to-be-fix — orphan addenda (2026-08-15 reconcile v3)

MD files filed during the closure pass that were never added to the index. Each row
is the MD heading's File:Line and title; pinning test path is `-` where the MD does
not document one. File:Line points at the line where the bug code actually lives at
HEAD (corrected from the MD heading if off-by-one). Resolved is `<YYYY-MM-DD> <sha>`
when a commit on `test/baseline` already deleted the buggy defensive guard, `-` otherwise.

24 rows.

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
| `federation-inbox-fedPeer-null-fallback` | `src/web/routes/federation.ts:329` | ctx.fedPeer ?? null fallback is unreachable (MD heading off-by-one: line 330 in MD, actual code at line 329) | - | Resolved: 2026-08-21 8e11043 |
| `federation-rememberRef-oldest-undefined` | `src/web/routes/federation.ts:93` | rememberRef's if (oldest !== undefined) falsy arm is unreachable | - | 2026-08-14 08d7508 |
| `federation-routes-fedpeer-required-type-narrow-deferred` | `src/web/routes/federation.ts:298,329` | fedPeer type-narrow deferred | - | Resolved: 2026-08-21 8e11043 — narrowing now succeeds |
| `index-283-test-pins-error-wiring` | `src/index.ts:283` | buildPidfileLockContext.log.error is pinned by TS strict (process-lock.ts:253 requires it) and a positive test (index.test.ts:1382 'forwards pidfile context errors to logger.error') | `src/__tests__/index.test.ts:1382` | Resolved: 2026-08-21 87cd76f21f5b -- contract documented via code comment in src/index.ts:282 |
| `index-stopHeartbeat-throw` | `src/index.ts:382` | stopHeartbeat-throws-during-shutdown catch is unreachable | `src/__tests__/index.test.ts` | Resolved: 2026-08-16 221d5c8 |
| `mcp-list-warn-execError-dead-branch` | `src/web/mcp-list.ts:135` | warn() payload's execError ? truthy arm is unreachable | `src/__tests__/mcp-list.test.ts` | Resolved: 2026-08-16 c1ee774 |
| `recall-dayOfWeekBudapest-fallback` | `src/web/routes/recall.ts:25` | dayOfWeekBudapest's weekday-map fallback is unreachable | - | Resolved: 2026-08-16 3bec823 |
| `recall-weekIdx-fallback` | `src/web/routes/recall.ts:153` | weekIdx ?? 0 fallback is unreachable | - | Resolved: 2026-08-16 3bec823 |
| `routes-agents-parseChannelProvider-dead-code` | `src/web/routes/agents.ts:232` | parseChannelProvider `return null` branch is unreachable | `src/__tests__/agents-routes.test.ts` | Resolved: 2026-08-16 3e1dd3f |
| `routes-recall-153-ts-strict-blocks-delete` | `src/web/routes/recall.ts:153` | TS strict blocks the safe-delete | - | Resolved: 2026-08-16 3bec823 |
| `routes-recall-25-ts-strict-blocks-delete` | `src/web/routes/recall.ts:25` | TS strict blocks the safe-delete | - | Resolved: 2026-08-16 3bec823 |
| `vault-ssh-keys-endsWith-newline` | `src/web/routes/vault-ssh-keys.ts:126` | privateKey.endsWith('\n') IF branch is unreachable | `src/__tests__/routes-vault-ssh-keys.test.ts` | Resolved: 2026-08-16 9aa71e5 |
| `voice-timer-stdinData-fallbacks` | `src/web/routes/voice.ts:74,79` | runProc timer and stdinData fallbacks are unreachable | - | 2026-08-14 c2b4ea2 |
| `index-stopheartbeat-dangling-import` | `src/index.ts:16,380-415` | stopHeartbeat imported but never wired into shutdown() after commit 2e33344 wired initHeartbeat into main() | `src/__tests__/index.test.ts` (positive pin :1142-1148, throw pin :2592-2609, extended throws :1116-1135) | Resolved: 2026-08-26 642b883 |