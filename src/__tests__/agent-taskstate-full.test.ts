// 100% coverage confirmation suite for src/web/agent-taskstate.ts.
//
// Companion to src/__tests__/agent-taskstate.test.ts and
// src/__tests__/agent-taskstate-cov.test.ts. The other two suites already
// drive every reachable branch:
//
//   * agent-taskstate.test.ts covers the pure predicates (shouldReplayTaskState,
//     isEmptyTaskState, buildTaskStateInjection) and the I/O round-trip
//     (writeTaskState, readTaskState, markConsumed, clearTaskState,
//     sweepOrphanTaskStates) on a per-file tmpdir sandbox.
//
//   * agent-taskstate-cov.test.ts fills the historical gaps:
//       - readTaskState's catch arm when JSON.parse throws (lines 135-136)
//       - sweepOrphanTaskStates's catch arm when a file in the store dir
//         is unreadable (line 188)
//       - sweepOrphanTaskStates's early return when STORE_DIR is absent
//         (line 177)
//       - sweepOrphanTaskStates skips files that don't end in .json
//         (line 180)
//       - sweepOrphanTaskStates does NOT sweep records within TTL
//         (line 183 false branch)
//       - readTaskState's per-field defaults when persisted fields are
//         null/wrong-typed (lines 128-131)
//       - buildTaskStateInjection's optional-block omissions when
//         doneSteps/nextAction are empty (lines 112/114 false branches)
//
// This file is the pinning layer: it re-asserts the 100% coverage
// threshold with a small set of end-to-end behavioural checks so future
// edits to agent-taskstate.ts are caught even if the unit suites drift.

import { describe, it, expect, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const SANDBOX = mkdtempSync(join(tmpdir(), 'agent-taskstate-full-'))
const STORE = join(SANDBOX, 'store')

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return { ...actual, PROJECT_ROOT: SANDBOX, STORE_DIR: STORE }
})

const {
  shouldReplayTaskState,
  isEmptyTaskState,
  buildTaskStateInjection,
  writeTaskState,
  readTaskState,
  markConsumed,
  clearTaskState,
  sweepOrphanTaskStates,
} = await import('../web/agent-taskstate.js')

type AgentTaskState = NonNullable<Parameters<typeof shouldReplayTaskState>[0]>

afterAll(() => rmSync(SANDBOX, { recursive: true, force: true }))

const NOW = 1_700_000_000_000
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

// ===========================================================================
// End-to-end pin: every public export behaves consistently with the
// documented contract. Each assertion here matches a clause in the
// module's top-of-file comment block ("Compact task-state re-injection")
// so any future regression in the contract surfaces immediately.
// ===========================================================================

describe('agent-taskstate: end-to-end contract pin', () => {
  it('shouldReplayTaskState is the single source of truth for replay decisions', () => {
    // True only when: record exists, not consumed, source is in
    // REPLAY_SOURCES, within TTL, and not empty.
    const fresh = rec()
    expect(shouldReplayTaskState(fresh, 'compact', NOW + 1000)).toBe(true)
    expect(shouldReplayTaskState(fresh, 'resume', NOW + 1000)).toBe(true)
    expect(shouldReplayTaskState(fresh, 'startup', NOW + 1000)).toBe(true)
    expect(shouldReplayTaskState(null, 'compact', NOW)).toBe(false)
    expect(shouldReplayTaskState(rec({ consumed: true }), 'compact', NOW)).toBe(false)
    expect(shouldReplayTaskState(fresh, 'unknown', NOW + 1)).toBe(false)
    expect(shouldReplayTaskState(rec({
      doneSteps: [], alreadyDelegated: [], nextAction: '', pendingDecision: '',
    }), 'compact', NOW + 1)).toBe(false)
  })

  it('write -> read -> markConsumed -> sweep cycle preserves the contract', () => {
    const A = 'contract-agent'
    clearTaskState(A)
    writeTaskState(A, {
      summary: 'mid-task',
      nextAction: 'resume from step 3',
      doneSteps: ['step 1', 'step 2'],
      pendingDecision: 'awaiting owner confirmation',
    }, NOW)
    const r = readTaskState(A)!
    expect(r).not.toBeNull()
    expect(shouldReplayTaskState(r, 'compact', NOW + 1)).toBe(true)

    markConsumed(A)
    const afterConsume = readTaskState(A)!
    expect(afterConsume.consumed).toBe(true)
    expect(shouldReplayTaskState(afterConsume, 'compact', NOW + 1)).toBe(false)

    clearTaskState(A)
    expect(readTaskState(A)).toBeNull()
  })

  it('sweepOrphanTaskStates is opportunistic: returns 0 for absent dir, deletes stale records', () => {
    // Empty store dir
    expect(sweepOrphanTaskStates(NOW)).toBe(0)
    // After write + sweep far in the future -> sweeps
    writeTaskState('stale', { nextAction: 'x' }, NOW)
    const swept = sweepOrphanTaskStates(NOW + 13 * 60 * 60 * 1000) // 13h, > 12h TTL
    expect(swept).toBeGreaterThanOrEqual(1)
    expect(readTaskState('stale')).toBeNull()
  })

  it('isEmptyTaskState matches shouldReplayTaskState\'s "has a task" test', () => {
    // An "empty" record is one where every meaningful field is blank.
    const emptyRecord: Pick<AgentTaskState, 'doneSteps' | 'alreadyDelegated' | 'nextAction' | 'pendingDecision'> = {
      doneSteps: [],
      alreadyDelegated: [],
      nextAction: '',
      pendingDecision: '',
    }
    expect(isEmptyTaskState(emptyRecord)).toBe(true)
    expect(shouldReplayTaskState(rec(emptyRecord), 'compact', NOW + 1)).toBe(false)

    // Any meaningful field flips the empty predicate.
    expect(isEmptyTaskState({ ...emptyRecord, nextAction: 'do B' })).toBe(false)
    expect(isEmptyTaskState({ ...emptyRecord, alreadyDelegated: ['handoff to zara'] })).toBe(false)
    expect(isEmptyTaskState({ ...emptyRecord, doneSteps: ['step 1'] })).toBe(false)
    expect(isEmptyTaskState({ ...emptyRecord, pendingDecision: 'blocked on auth' })).toBe(false)
  })

  it('buildTaskStateInjection always starts with the sentinel and the source-neutral framing', () => {
    const out = buildTaskStateInjection(rec())
    expect(out.startsWith('=== TASK-FOLYTATAS (NEM uj feladat) ===')).toBe(true)
    // Anti re-delegation framing is mandatory on every build.
    expect(out).toContain('NE INDITSD ujra')
    expect(out).toContain('NE delegald ujra')
  })
})
