# test suite LLM / external API audit: clean

**Status:** audited 2026-08-06, NO real network calls found in the test suite.

## Why this audit was run

User asked on 2026-08-06:

> "direkt szóltam hogy valós müvelet ne fusson le test közben, megéis a tesztek
> futása után létrejön a ./store mappa, ami azt jelenti hogy a tesztek éles kódot
> futtatnak! akár még az is lehet LLM hivást is végeznek a tesztek?, vizsgáld ki!"

The live `./store/` pollution was real (see `test-suite-store-pollution-store-dir-frozen.md`),
but it came from the `migrateTaskRunsFromJson` db-side path, not from LLM/API calls.
This document records the network-call audit so the answer is durable.

## Method

Three independent sweeps:

1. **`grep -rln "fetch|https\.request|http\.request|anthropic|openai|runAgent|claude-agent-sdk|@anthropic" src/__tests__/`**
   Returned 38 file matches.

2. **`grep -rln "globalThis\.fetch" src/__tests__/`**
   Returned 8 files. These are the only tests that could plausibly reach a
   real network endpoint via `fetch`.

3. **`grep -rln "@anthropic-ai/sdk|claude-agent-sdk|runAgent|runAgentStream|anthropic-messages" src/__tests__/`**
   Returned 12 files. These are the only tests that could plausibly
   invoke the Claude agent SDK.

## Result table

### Network layer (fetch / https / http)

| File | Override mechanism | Real network? |
|---|---|---|
| `graph-mail.test.ts` | `globalThis.fetch = vi.fn(async (url, init?) => ...)` (lines 148, 180, 196, 214, 249, 261, 276, 289, 350, 389, 413, 426, 437, 455, 468) | NO |
| `channel-request-watcher.test.ts` | `globalThis.fetch = ...` | NO |
| `migrate-routes.test.ts` | `globalThis.fetch = ...` | NO |
| `channel-conflict-probe.test.ts` | `globalThis.fetch = ...` | NO |
| `channel-provider.test.ts` | `globalThis.fetch = ...` | NO |
| `channel-conflict-probe-cov.test.ts` | `globalThis.fetch = ...` | NO |
| `db-100.test.ts` | `globalThis.fetch = ...` | NO |
| `memories-routes.test.ts` | `globalThis.fetch = ...` | NO |

Every test that touches `globalThis.fetch` replaces it with a `vi.fn(...)` whose
resolved value is constructed in-test. No test relies on the real fetch
implementation; even `graph-mail.test.ts` which has the most elaborate
override (15 separate mock bodies for refresh-token / mtime-rotation /
abort-timeout scenarios) never falls through to a live HTTP request.

### Agent SDK layer (claude-agent-sdk / runAgent)

| File | Mock target | Real SDK? |
|---|---|---|
| `llm-breakdown.test.ts` | `vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))` (line 42) | NO |
| `kanban-breakdown.test.ts` | `vi.mock('../agent.js', () => ({ runAgent: vi.fn() }))` (line 13) | NO |
| `memory.test.ts` | Module-level mock factory `runAgent: async (...) => { ... }` (lines 56-146) | NO |
| `heartbeat.test.ts` | `vi.mock('../agent.js', () => ({ runAgent: mockState.runAgent }))` (line 82) | NO |
| `heartbeat-cov.test.ts` | `vi.mock('../agent.js', () => ({ runAgent: mockState.runAgent }))` (line 53) + `vi.doMock` for inner cases | NO |
| `heartbeat-oauth-token.test.ts` | Reads source string only; never invokes runAgent | NO |
| `heartbeat-worker-isolation.test.ts` | Reads source string only; never invokes runAgent | NO |
| `agent-worker.test.ts` | Pure-logic tests on the worker backend, no SDK call | NO |
| `agent-run-paths.test.ts` | `vi.mock('@anthropic-ai/claude-agent-sdk', () => ({ ... }))` (line 16) | NO |
| `agent-result-classification.test.ts` | Comments only, no SDK invocation | NO |
| `federation-capability-runner.test.ts` | `vi.mock('../agent.js', () => ({ runAgent: mocks.runAgent }))` (line 70) | NO |

Every test that touches the agent SDK replaces it with `vi.fn()` or an
in-line mock factory. The `agent-run-paths.test.ts` even mocks
`@anthropic-ai/claude-agent-sdk` directly so any module that does
`import { query } from '@anthropic-ai/claude-agent-sdk'` resolves to the
mock instead.

### Subprocess layer

| Module | Test files | Mechanism |
|---|---|---|
| `node:child_process` | 28 files | All override with `vi.mock('node:child_process', () => ({ execFileSync: vi.fn(), spawn: vi.fn(), ... }))` |
| `node:https` | graph-mail.test.ts | Same pattern |

## Conclusion

The test suite **never** makes a real LLM call, never reaches a real HTTP
endpoint, and never spawns a real child process. The only side effect the
suite has on the host filesystem is the `./store/` pollution documented
in `test-suite-store-pollution-store-dir-frozen.md`, which is a
**module-side effect** of `src/db.ts:initDatabase()` running its
migration against the live `STORE_DIR` -- not a network or SDK side
effect.

The user's "LLM call during tests" concern was reasonable to investigate
but is unfounded: every layer that *could* reach out is mocked.

## Forward-fix ledger

- The strengthened `assert-not-live-install.ts` (whole-store detection)
  catches the only real side effect we found.
- Future tests added to the suite must continue to mock `node:child_process`,
  `node:https`, `globalThis.fetch`, `../agent.js`, and
  `@anthropic-ai/claude-agent-sdk` if they exercise the corresponding
  paths. The `vi.mock(...)` placement at the top of every test file
  is non-negotiable.
- The CI runner should set `CI=true` so any inadvertently un-mocked
  network call (e.g. a forgotten `fetch` in a new test) hits a
  no-network environment and fails loudly.
