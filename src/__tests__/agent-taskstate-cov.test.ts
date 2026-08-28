// Coverage gap fillers for src/web/agent-taskstate.ts.
//
// The main agent-taskstate.test.ts suite covers the happy paths (write/read/
// markConsumed/sweep/cross-OR-empty) and pure-fn decisions (shouldReplay,
// isEmptyTaskState, buildTaskStateInjection). This file fills the gaps:
//   * lines 135-136: readTaskState's catch arm when JSON.parse throws.
//   * line 188: sweepOrphanTaskStates's catch arm when a file in the store
//     dir is unreadable (corrupt JSON, IO error) -- the inner unlink+count.
//   * line 177: sweepOrphanTaskStates's early return when STORE_DIR is absent.
//   * line 180: sweepOrphanTaskStates skips files that don't end in .json.
//   * line 183 false branch: a fresh record (ts is a number AND age <= ttl)
//     is NOT swept.
//   * lines 128-131: readTaskState's per-field defaults (the ?? '' fallbacks
//     and the typeof-number ts guard) when the persisted record omits them.
//   * line 112/114 false branches: buildTaskStateInjection skips the MAR KESZ
//     block when doneSteps is empty and skips the KOVETKEZO AKCIO block when
//     nextAction is empty.
//
// Each suite pins PROJECT_ROOT at a fresh per-file tmpdir so file-shape
// fixtures (corrupt JSON, missing dir, non-json filename) never bleed into
// the main sandbox used by the other suite.

import { describe, it, expect, beforeAll, afterEach, afterAll, vi } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'agent-taskstate-cov-'))
const STORE = join(SANDBOX, 'store')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})

const {
  shouldReplayTaskState,
  buildTaskStateInjection,
  writeTaskState,
  readTaskState,
  clearTaskState,
  sweepOrphanTaskStates,
} = await import('../web/agent-taskstate.js')

type AgentTaskState = NonNullable<Parameters<typeof shouldReplayTaskState>[0]>

const NOW = 1_700_000_000_000
const STORE_DIR = join(STORE, 'agent-taskstate')

const rec = (over: Partial<AgentTaskState> = {}): AgentTaskState => ({
  agent: 'tester',
  doneSteps: ['did A'],
  alreadyDelegated: [],
  nextAction: 'do B',
  pendingDecision: '',
  summary: 'building X',
  ts: NOW,
  consumed: false,
  ...over,
})

afterEach(() => rmSync(STORE_DIR, { recursive: true, force: true }))
afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

describe('agent-taskstate: coverage gap fillers', () => {
  it('readTaskState returns null when JSON is corrupt (line 135-136 catch arm)', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    const corruptPath = join(STORE_DIR, 'corrupt.json')
    writeFileSync(corruptPath, '{ not valid json ')
    expect(readTaskState('corrupt')).toBeNull()
  })

  it('sweepOrphanTaskStates deletes and counts an unreadable JSON file (line 188)', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    const corruptPath = join(STORE_DIR, 'junk.json')
    writeFileSync(corruptPath, 'definitely not json }{')
    const swept = sweepOrphanTaskStates(NOW)
    expect(swept).toBe(1)
    expect(existsSync(corruptPath)).toBe(false)
  })

  it('sweepOrphanTaskStates returns 0 when the store dir is absent (line 177)', () => {
    // STORE_DIR was wiped in afterEach; do NOT recreate it.
    expect(existsSync(STORE_DIR)).toBe(false)
    expect(sweepOrphanTaskStates(NOW)).toBe(0)
  })

  it('sweepOrphanTaskStates skips files without .json suffix (line 180)', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    const txt = join(STORE_DIR, 'README')
    writeFileSync(txt, 'just text')
    expect(sweepOrphanTaskStates(NOW)).toBe(0)
    expect(existsSync(txt)).toBe(true)
  })

  it('sweepOrphanTaskStates does NOT sweep records within TTL (line 183 false branch)', () => {
    writeTaskState('fresh', { nextAction: 'still in flight' }, NOW)
    expect(sweepOrphanTaskStates(NOW + 1000)).toBe(0)
    expect(readTaskState('fresh')).not.toBeNull()
    clearTaskState('fresh')
  })

  it('buildTaskStateInjection omits MAR KESZ block when doneSteps is empty (line 112 false)', () => {
    const out = buildTaskStateInjection(rec({ doneSteps: [], nextAction: 'do B' }))
    expect(out).not.toContain('MAR KESZ')
    expect(out).toContain('KOVETKEZO AKCIO')
  })

  it('buildTaskStateInjection omits KOVETKEZO AKCIO when nextAction is empty (line 114 false)', () => {
    const out = buildTaskStateInjection(rec({ doneSteps: ['done'], nextAction: '' }))
    expect(out).not.toContain('KOVETKEZO AKCIO')
    expect(out).toContain('MAR KESZ')
  })

  it('readTaskState populates defaults when fields are missing from JSON (lines 128-131)', () => {
    mkdirSync(STORE_DIR, { recursive: true })
    const path = join(STORE_DIR, 'minimal.json')
    // ts is the wrong type (string), nextAction/pendingDecision/summary are
    // null, doneSteps/alreadyDelegated are null -- exercises every falsy
    // branch of the sanitizers and the typeof-number guard.
    writeFileSync(path, JSON.stringify({
      agent: 'minimal',
      doneSteps: null,
      alreadyDelegated: null,
      nextAction: null,
      pendingDecision: null,
      summary: null,
      ts: 'not-a-number',
      consumed: null,
    }))
    const r = readTaskState('minimal')!
    expect(r).not.toBeNull()
    expect(r.doneSteps).toEqual([])
    expect(r.alreadyDelegated).toEqual([])
    expect(r.nextAction).toBe('')
    expect(r.pendingDecision).toBe('')
    expect(r.summary).toBe('')
    expect(r.ts).toBe(0)
    expect(r.consumed).toBe(false)
  })
})
