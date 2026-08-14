// 100% (or "documented gap") coverage suite for src/web/fleet-transfer.ts.
//
// Companion to src/__tests__/fleet-transfer.test.ts and
// src/__tests__/fleet-transfer-routes.test.ts. The other two suites cover
// the entire reachable surface -- encrypted round-trip, import error paths,
// DiffReport shape, identity takeover, name traversal guards, channel .env
// re-pair model, and DB insert happy paths.
//
// All describe blocks in this file previously tested coverage of dead code
// (`assertSafeName` at lines 48-53 of src/web/fleet-transfer.ts). With that
// helper deleted by the safe-delete pass, every describe block here is gone
// too. The file is kept as a placeholder so the test runner can still
// resolve `vi.mock` chains if anything else ever needs them.

import { describe, it, expect, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Module mocks. Reuse the pattern from fleet-transfer.test.ts: stub
// node:fs / db.js / config.js / etc. so importFleet runs against a
// predictable sandbox and never touches the live store.
// ---------------------------------------------------------------------------

vi.mock('../db.js', () => ({
  getDb: () => ({
    prepare: () => ({
      all: () => [],
      get: () => null,
      run: () => ({ changes: 0 }),
    }),
    transaction: (fn: Function) => fn,
  }),
  backfillEmbeddings: () => Promise.resolve(),
  initDatabase: () => {},
}))

vi.mock('../web/agent-config.js', () => ({
  AGENTS_BASE_DIR: '/mock/agents',
  listAgentNames: () => [],
}))

vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>()
  return {
    ...real,
    existsSync: () => false,
    mkdirSync: () => undefined,
    unlinkSync: () => undefined,
    rmSync: () => undefined,
    readdirSync: () => [],
  }
})

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: vi.fn(),
}))

vi.mock('../web/scheduled-tasks-io.js', () => ({
  SCHEDULED_TASKS_DIR: '/mock/tasks',
}))

vi.mock('../config.js', () => ({
  PROJECT_ROOT: '/mock/project',
  STORE_DIR: '/mock/store',
  MAIN_AGENT_ID: 'marveen',
  BOT_NAME: 'Marveen',
  BRAND_NAME: 'Marveen',
  OWNER_NAME: 'Szabolcs',
  CHANNEL_PROVIDER: 'telegram',
}))

vi.mock('../web/vault-bindings.js', () => ({
  getBindings: () => [],
}))

vi.mock('../env.js', () => ({
  updateEnvFile: vi.fn(),
}))

vi.mock('../logger.js', () => ({
  logger: { info: () => {}, warn: () => {}, error: () => {} },
}))

const MINIMAL_FLEET = JSON.stringify({
  schemaVersion: 1,
  exportedAt: '2026-01-01T00:00:00.000Z',
  sourceHost: 'test-host',
  agents: [],
  skills: [],
  scheduledTasks: [],
  memories: [],
  dailyLogs: [],
  kanban: { cards: [], comments: [], cardEvents: [], labels: [], cardLabels: [] },
  ideaBox: { ideas: [], comments: [], statusLog: [] },
  dashboardSettings: { autonomy: {}, autoRestart: {}, agentsDesired: {}, norbertPersonal: {} },
})

// No describe blocks remain -- the only test in this file was the
// coverage-of-dead-code suite for `assertSafeName`, which was removed
// alongside the helper at src/web/fleet-transfer.ts:48-53.
describe.skip('fleet-transfer-full: legacy coverage-of-dead-code suite (intentionally empty)', () => {
  it.skip('placeholder so vitest finds at least one suite', () => {
    expect(MINIMAL_FLEET).toContain('"schemaVersion":1')
  })
})