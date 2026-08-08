// 100% (or "documented gap") coverage suite for src/web/fleet-transfer.ts.
//
// Companion to src/__tests__/fleet-transfer.test.ts and
// src/__tests__/fleet-transfer-routes.test.ts. The other two suites cover
// the entire reachable surface -- encrypted round-trip, import error paths,
// DiffReport shape, identity takeover, name traversal guards, channel .env
// re-pair model, and DB insert happy paths. This file adds the remaining
// coverage:
//
//   * assertSafeName dead code (lines 48-53). The function is module-
//     private and never called by any reachable branch. The pinning test
//     here documents the current behaviour (dead code is dead) by exercising
//     every other name-validation path and asserting the dead helper's
//     error string is NOT produced by any caller. The bug MD under
//     docs/needs-to-be-fix/fleet-transfer-assertsafename-dead-code.md
//     captures why the function is unreachable and proposes a one-line
//     fix (delete the helper or wire it into validateNames).
//
// Pinning tests MUST assert CURRENT behaviour and PASS; this is one such
// test.

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

// ===========================================================================
// assertSafeName (module-private) is dead code.
// ---------------------------------------------------------------------------
// assertSafeName is declared at line 48 of src/web/fleet-transfer.ts and
// never called anywhere in the module. validateNames (lines 746-787) is the
// active name-validator and uses SAFE_NAME_RE.test(...) inline. The bug MD
// at docs/needs-to-be-fix/fleet-transfer-assertsafename-dead-code.md
// proposes deleting the helper or wiring it in.
// ===========================================================================

describe('fleet-transfer: assertSafeName dead code (lines 48-53)', () => {
  it('assertSafeName is declared in the source file but not exported and not referenced anywhere', () => {
    const src = readFileSync(
      join(process.cwd(), 'src/web/fleet-transfer.ts'),
      'utf-8',
    )

    // Sanity: the helper exists at line 48 (function declaration).
    expect(src).toMatch(/function assertSafeName\(value: unknown, field: string\): string \{/)
    // Pinning: the helper is NOT exported. We grep for `export` followed
    // by `assertSafeName` on the same logical chunk -- if someone ever
    // exports it the test breaks loudly so they re-evaluate coverage.
    expect(src).not.toMatch(/export\s+function\s+assertSafeName/)
    // Pinning: the helper's signature does NOT appear anywhere outside
    // its own declaration. The "function assertSafeName" line is the only
    // place it shows up; any other occurrence means someone wired it in
    // and we should re-run coverage.
    const occurrences = src.match(/assertSafeName/g) ?? []
    // 1 occurrence: the declaration itself.
    expect(occurrences.length).toBe(1)
  })

  it('importFleet never produces an "Érvénytelen ... érték" string via the dead helper', async () => {
    // The dead helper's error message format is:
    //   `Érvénytelen ${field} érték: "${value.slice(0,60)}" -- csak [a-z0-9_-] megengedett.`
    // The active validateNames uses a DIFFERENT format (no "érték" word
    // and no "csak [a-z0-9_-] megengedett." suffix). This pinning test
    // proves that no reachable importFleet path produces the dead
    // helper's distinctive signature -- i.e. the helper genuinely is
    // dead through the public API.
    const { importFleet } = await import('../web/fleet-transfer.js')

    const badNames = ['UPPER', 'has space', 'has.dot', '../../../etc/passwd', '!@#$']
    const errorsCollected: string[] = []
    for (const bad of badNames) {
      for (const field of ['skills', 'agents', 'scheduledTasks'] as const) {
        const body = JSON.stringify({
          ...JSON.parse(MINIMAL_FLEET),
          [field]: field === 'scheduledTasks'
            ? [{ dirName: bad, skillMd: '', config: {} }]
            : [{ name: bad, skillMd: field === 'skills' ? '' : undefined, config: field === 'agents' ? {} : undefined }],
        })
        const result = importFleet(body, { apply: false })
        if ('errors' in result) errorsCollected.push(...(result.errors as string[]))
      }
    }

    // Every collected error uses the validateNames format (no "érték:"/
    // "csak [a-z0-9_-] megengedett" suffix that the dead helper emits).
    expect(errorsCollected.length).toBeGreaterThan(0)
    for (const err of errorsCollected) {
      expect(err).not.toMatch(/csak \[a-z0-9_-\] megengedett\./)
      expect(err).not.toMatch(/érték:/)
    }
  })
})
