export const meta = {
  name: 'cycle35-cleanup-card-refs-final',
  description: 'Strip remaining card refs from comments and test names',
  phases: [{ title: 'Phase 10 final card cleanup' }],
};

phase('Phase 10 final card cleanup')

const phase10 = await agent('Cleanup Phase 10 — strip remaining card refs and temporal markers. EDIT + COMMIT.\n\n' +
'Base: /Users/eggp/marveen-develop/test-baseline\n\n' +
'Files with remaining card refs (17 real matches + 1 false positive to skip):\n\n' +
'src/model-profiles.ts:1 — "// Behaviour-neutral model profiles (card c755f4b2, Phase 1 Block B)." -> SIMPLIFY to "// Behaviour-neutral model profiles."\n\n' +
'src/db.ts:915 — "// --- OTel Distributed Tracing (card def5a189) ---" -> SIMPLIFY to "// --- OTel Distributed Tracing ---"\n\n' +
'src/db.ts:3237 — "// --- OTel Distributed Tracing (card def5a189) ---" -> SIMPLIFY to "// --- OTel Distributed Tracing ---"\n\n' +
'src/web/agent-process.ts:687 — "// Root cause chain (2026-07-23, card b71fc541): a config root without..." -> REWRITE to drop date and card ref, keep invariant: "// A config root without the agent_process block is the root cause of the restart-rebuild loop. See [invariant description]." Be conservative — keep the meaningful WHY content; drop only the date and card ref.\n\n' +
'src/web/message-router.ts:120 — "// ---- session-stuck detection (card 2922e380 thread a) ----..." -> SIMPLIFY to "// ---- session-stuck detection ----"\n' +
'src/web/message-router.ts:129 — "// ---- reconnect-backlog batching (card 2922e380 thread b) ----..." -> SIMPLIFY to "// ---- reconnect-backlog batching ----"\n' +
'src/web/message-router.ts:162 — "// ---- Distributed trace context (card def5a189) ----..." -> SIMPLIFY to "// ---- Distributed trace context ----"\n' +
'src/web/message-router.ts:505 — "// ---- session-stuck detection (card 2922e380 thread a) ----" -> SIMPLIFY to "// ---- session-stuck detection ----"\n' +
'src/web/message-router.ts:548 — "// Trace context (card def5a189): stamp if not yet set..." -> SIMPLIFY to "// Trace context: stamp if not yet set..."\n\n' +
'src/web/agent-config.ts:71 — "// ---- model-profile map (deployment-local, card c755f4b2 Block B) ----" -> SIMPLIFY to "// ---- model-profile map (deployment-local) ----"\n\n' +
'src/__tests__/heartbeat-agent-scaffold.test.ts:102 — it(...(card 776e800a)...) -> rename test to drop card ref: "excludes done cards from the urgent-title kanban query"\n\n' +
'src/__tests__/otel-distributed-tracing.test.ts:1 — "// Tests for OTel distributed tracing (card def5a189)." -> SIMPLIFY to "// Tests for OTel distributed tracing."\n\n' +
'src/__tests__/update-release-grouping.test.ts:5 — "// list into version buckets (card cbe2a240, PR-A). A `chore(release): vX`" -> SIMPLIFY to "// list into version buckets. A `chore(release): vX`"\n\n' +
'src/__tests__/message-router-tick-cap.test.ts:9 — "// Since card 2922e380, sessionExistsOnHost is called once per unique receiver" -> SIMPLIFY to "// sessionExistsOnHost is called once per unique receiver"\n' +
'src/__tests__/message-router-tick-cap.test.ts:43 — "// card def5a189: OTel trace stubs -- no-ops in this test" -> SIMPLIFY to "// OTel trace stubs — no-ops in this test"\n' +
'src/__tests__/message-router-tick-cap.test.ts:106 — "// sessionExistsOnHost is called once per unique receiver (cached since card 2922e380)." -> SIMPLIFY to "// sessionExistsOnHost is called once per unique receiver (cached)."\n\n' +
'src/__tests__/model-profiles.test.ts:1 — "// Block B: behaviour-neutral model profiles (card c755f4b2, spec 5.6)." -> SIMPLIFY to "// Behaviour-neutral model profiles."\n\n' +
'DO NOT TOUCH: web/app.js:3314 — this is `card.className = \'agent-card federated-agent-card\'` (JS code with CSS class names, NOT a comment).\n\n' +
'Rules:\n' +
'- For each file: read first, plan the change, apply, verify.\n' +
'- DO NOT change non-comment code.\n' +
'- For test names: rename if they contain card refs, but check the test still works after rename (no other refs to the old name in the same file).\n' +
'- Keep invariant explanations; drop only the temporal/process content (card refs, dates, PR refs).\n\n' +
'Verify BEFORE commit:\n' +
'- bunx tsc --noEmit 2>&1 | wc -l -> expect 2253 (no delta)\n' +
'- bun --bun vitest run src/__tests__/model-profiles.test.ts src/__tests__/otel-distributed-tracing.test.ts src/__tests__/message-router-tick-cap.test.ts src/__tests__/heartbeat-agent-scaffold.test.ts src/__tests__/update-release-grouping.test.ts 2>&1 | tail -5 -> expect all PASS\n\n' +
'Commit message:\n' +
'  chore: strip remaining card refs from comments and test names\n' +
'  Final pass after cleanup-comments-workflow + cleanup-comments-workflow-2.\n' +
'  Files touched: (list each with line delta)\n\n' +
'Constraints:\n' +
'- DO NOT push\n' +
'- DO NOT change non-comment code (except test names that contain card refs)\n' +
'- DO NOT touch web/app.js:3314 (CSS class names, not a comment)', { label: 'Phase 10 final card cleanup' })

if (!phase10) { log('Phase 10 stopped. Aborting.'); process.exit(1) }

log('Final cleanup complete. Awaiting user push and /code-review xhigh --fix.')
return { phase10 }
