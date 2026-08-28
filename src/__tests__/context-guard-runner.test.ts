// 100% coverage test for src/web/context-guard-runner.ts.
//
// The runner is a thin I/O wrapper around the pure state machine in
// src/context-guard.ts: it gathers inputs (tmux pane capture, transcript
// tokens, agent config) and delegates the decision to decideGuard(). It then
// executes the returned action (request-handoff / restart / inject-resume), so
// for every decideGuard case we need to drive the runner to the matching return
// of guardStates and the matching action handler.
//
// Branch inventory that must be covered here (see src/web/context-guard-runner.ts
// and the matching decideGuard branches in src/context-guard.ts):
//
//   runner.ts init / scheduled task
//     - startContextGuardRunner returns a NodeJS.Timeout and schedules both the
//       initial sweep and the recurring interval. (Covered via fake timers.)
//   readHighwater()
//     - file missing        -> catch -> {}
//     - JSON.parse throws   -> catch -> {}
//     - parsed === null     -> falsy -> {}
//     - parsed primitive    -> typeof !== 'object' -> {}
//     - parsed truthy []    -> typeof object -> {} (no entries)
//     - parsed object {}    -> empty highwater
//     - parsed object entry -> carries through
//   observedHighwater()
//     - highwater === null      -> lazy read
//     - existing entry, same model -> prior kept
//     - existing entry, different model -> prior ignored (model gate)
//     - new observed > prior -> persists to disk
//     - new observed <= prior -> keeps stored, no write
//     - writeFileSync throws -> caught, warns, still returns Math.max
//   checkAgent() (the core)
//     - cfg.enabled=false && cfg.saturationRestart=false -> disarmed, state cleared
//     - cfg.enabled=false && cfg.saturationRestart=true  -> armed only with net
//     - remote host                                           -> logged ONCE, skipped
//     - remote host (second sweep)                            -> silent skip
//     - running=false (main)                                  -> measurePct short-circuit
//     - running=false (sub)                                   -> agentRunState != running
//     - running=true, needPct=true                            -> capturePane + measurePct
//     - phase=await-ready                                     -> isSessionReadyForPrompt
//     - decision.action='none'                                -> guardStates set, no side effects
//     - decision.action='request-handoff'                     -> sendPromptToSession(handoffPrompt)
//     - decision.action='restart', NOT main                   -> restartAgentProcess(fresh)
//     - decision.action='restart', main, no recent respawn    -> hardRestartMarveenChannels
//     - decision.action='restart', main, within grace         -> DEFER (state NOT advanced)
//     - decision.action='restart', main, post snapshot success -> snapshot written
//     - decision.action='restart', main, post snapshot throwing -> snapshot failure tolerated
//     - decision.action='restart', main, createAgentMessage throws -> warns, still proceeds
//     - decision.action='inject-resume', no handoff           -> resumePrompt(handoff=false)
//     - decision.action='inject-resume', handoff present      -> resumePrompt(handoff=true)
//     - inject-resume with handoffMtime=null AND handoffMtime(name) returning null
//                                                            -> hadHandoff=false
//     - sendPromptToSession throws                            -> warn, do not crash
//     - handoffMtime ms (needPct branch)                      -> mtime returned
//     - handoffMtime null (needPct branch)                    -> null returned
//     - handoffMtime(null) at inject-resume decision          -> hadHandoff=false
//   performRestart()
//     - main, hardRestartMarveenChannels returns ok=false      -> throws Error
//     - main, hardRestartMarveenChannels returns ok=true       -> no throw
//     - sub                                                    -> restartAgentProcess
//   getContextGuardStatus()
//     - no agents                                              -> [main]
//     - main, sub                                              -> both rows
//     - remote host sub                                        -> pct=null
//     - cfg.enabled=false                                      -> pct=null
//     - guardStates map carrying state -> phase reported
//   handoffPrompt / resumePrompt
//     - the exact-injection prompt strings
//
// Sandbox: PROJECT_ROOT is frozen at the SUT's import time (derived from
// import.meta.url inside src/config.ts). The HIGHWATER_PATH reuses
// PROJECT_ROOT+store + 'context-guard-highwater.json', so we route the store
// via a vi.mock('../config.js') override pointing PROJECT_ROOT at a
// mkTempStore() parent so the joined path lands inside our sandbox. The
// snapshot path names a sibling file with the same root, so a single mock
// covers both. vitest isolates module registries per test file, so the hook
// cannot leak across sibling suites.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { mkTempStore, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Mock installation. All hoisted callbacks live in module scope so the
// vi.mock factories can reference them via closure.
// ---------------------------------------------------------------------------

const mockReadContextGuardConfig = vi.fn()
const mockListAgentNames = vi.fn<() => string[]>(() => [])
const mockAgentDir = vi.fn<(name: string) => string>()
const mockReadAgentModel = vi.fn<(name: string) => string | null>()
const mockReadAgentClaudeConfigDir = vi.fn<(name: string) => string | null>()
const mockReadAgentRemoteHost = vi.fn<(name: string) => string | null>()
const mockAgentRunState = vi.fn<(name: string) => 'running' | 'stopped' | 'unreachable'>()
const mockAgentSessionName = vi.fn<(name: string) => string>()
const mockRestartAgentProcess = vi.fn()
const mockCapturePane = vi.fn<(session: string, host?: string | null) => string | null>()
const mockSendPromptToSession = vi.fn()
const mockIsSessionReadyForPrompt = vi.fn()
const mockHardRestartMarveenChannels = vi.fn<() => { ok: boolean; error?: string }>()
const mockLastMainRespawnAt = vi.fn<() => number>()
const mockShouldDeferForRecentRespawn = vi.fn()
const mockDetectPaneState = vi.fn<(pane: string) => 'idle' | 'busy' | 'unknown'>()
const mockPaneShowsContextSaturation = vi.fn<(pane: string) => boolean>()
const mockReadContextTokensFromProjectDir = vi.fn<() => number | null>()
const mockReadActiveModelFromProjectDir = vi.fn<() => string | null>()
const mockCreateAgentMessage = vi.fn()
const mockExecFileSync = vi.fn()
const mockTempSandbox = mkTempStore('context-guard-runner-')
const PROJECT_ROOT_FOR_TEST = dirname(mockTempSandbox)
const STORE_PATH_FOR_TEST = mockTempSandbox
const HIGHWATER_PATH = join(STORE_PATH_FOR_TEST, 'context-guard-highwater.json')
const SNAPSHOT_PATH = join(STORE_PATH_FOR_TEST, 'context-guard-last-pane-marveen.txt')

// Each test file gets a fresh module registry via vi.resetModules (see
// beforeEach below). The mock factories are STATIC across resets -- the
// closure-bound mock functions are reused, never replaced, so the SUT's
// imported bindings stay wired to the same call counters.

vi.mock('../config.js', () => ({
  MAIN_AGENT_ID: 'marveen',
  PROJECT_ROOT: PROJECT_ROOT_FOR_TEST,
  STORE_DIR: STORE_PATH_FOR_TEST,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('../web/agent-config.js', () => ({
  listAgentNames: () => mockListAgentNames(),
  agentDir: (n: string) => mockAgentDir(n),
  readAgentModel: (n: string) => mockReadAgentModel(n),
  readAgentClaudeConfigDir: (n: string) => mockReadAgentClaudeConfigDir(n),
  readAgentRemoteHost: (n: string) => mockReadAgentRemoteHost(n),
}))

vi.mock('../web/agent-process.js', () => ({
  agentRunState: (n: string) => mockAgentRunState(n),
  agentSessionName: (n: string) => mockAgentSessionName(n),
  restartAgentProcess: (...a: unknown[]) => mockRestartAgentProcess(...a),
  capturePane: (s: string, h?: string | null) => mockCapturePane(s, h),
  sendPromptToSession: (...a: unknown[]) => mockSendPromptToSession(...a),
  isSessionReadyForPrompt: (...a: unknown[]) => mockIsSessionReadyForPrompt(...a),
}))

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: 'marveen-channels',
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: () => mockHardRestartMarveenChannels(),
  lastMainRespawnAt: () => mockLastMainRespawnAt(),
  MARVEEN_POST_RESPAWN_GRACE_MS: 360_000,
}))

vi.mock('../web/stuck-tool-call-watcher.js', () => ({
  shouldDeferForRecentRespawn: (...a: unknown[]) => mockShouldDeferForRecentRespawn(...a),
}))

vi.mock('../pane-state.js', () => ({
  detectPaneState: (p: string) => mockDetectPaneState(p),
  paneShowsContextSaturation: (p: string) => mockPaneShowsContextSaturation(p),
}))

vi.mock('../web/active-model.js', () => ({
  readContextTokensFromProjectDir: () => mockReadContextTokensFromProjectDir(),
  readActiveModelFromProjectDir: () => mockReadActiveModelFromProjectDir(),
}))

vi.mock('../web/context-guard-store.js', () => ({
  readContextGuardConfig: (n: string) => mockReadContextGuardConfig(n),
}))

// decideGuard is the pure state machine in src/context-guard.ts. We import
// the real module directly: no test overrides it (the pinning tests for
// unreachable branches were dropped for the
// context-guard-runner-dead-code-branches defect), so the
// earlier `mockDecideGuard` hoisted bridge had become pure dead code with
// two `as any` casts.

vi.mock('../db.js', () => ({
  createAgentMessage: (...a: unknown[]) => mockCreateAgentMessage(...a),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (...a: unknown[]) => mockExecFileSync(...a),
  execSync: vi.fn(),
}))

// ---------------------------------------------------------------------------
// Sandbox lifecycle. We never want a global before/after from the test suite
// to leak between tests -- each test sets up its own mock state and explicitly
// resets the highwater file.
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.resetModules()
  mkdirSync(STORE_PATH_FOR_TEST, { recursive: true })
  if (existsSync(HIGHWATER_PATH)) rmSync(HIGHWATER_PATH)
  if (existsSync(SNAPSHOT_PATH)) rmSync(SNAPSHOT_PATH)

  // Default mock returns: a benign enabled config with the saturation net on,
  // an empty agent list, the main session running, no remote host, no tokens,
  // no model, no handoff, no pct, and the runner-level helpers never defer.
  mockReadContextGuardConfig.mockReset()
  mockReadContextGuardConfig.mockReturnValue({
    enabled: true,
    saturationRestart: true,
    actPct: 0.9,
    hardPct: 0.97,
    limitTokens: null,
    cooldownMinutes: 15,
    handoffTimeoutMinutes: 20,
  })
  mockListAgentNames.mockReset()
  mockListAgentNames.mockReturnValue([])
  mockAgentDir.mockReset()
  mockAgentDir.mockImplementation((n: string) => `/sandbox/agents/${n}`)
  mockReadAgentModel.mockReset()
  mockReadAgentModel.mockReturnValue(null)
  mockReadAgentClaudeConfigDir.mockReset()
  mockReadAgentClaudeConfigDir.mockReturnValue(null)
  mockReadAgentRemoteHost.mockReset()
  mockReadAgentRemoteHost.mockReturnValue(null)
  mockAgentRunState.mockReset()
  mockAgentRunState.mockReturnValue('running')
  mockAgentSessionName.mockReset()
  mockAgentSessionName.mockImplementation((n: string) => `agent-${n}`)
  mockRestartAgentProcess.mockReset()
  mockRestartAgentProcess.mockReturnValue({ ok: true })
  mockCapturePane.mockReset()
  mockCapturePane.mockReturnValue(null)
  mockSendPromptToSession.mockReset()
  mockSendPromptToSession.mockResolvedValue(undefined)
  mockIsSessionReadyForPrompt.mockReset()
  mockIsSessionReadyForPrompt.mockResolvedValue(false)
  mockHardRestartMarveenChannels.mockReset()
  mockHardRestartMarveenChannels.mockReturnValue({ ok: true })
  mockLastMainRespawnAt.mockReset()
  mockLastMainRespawnAt.mockReturnValue(0)
  mockShouldDeferForRecentRespawn.mockReset()
  mockShouldDeferForRecentRespawn.mockReturnValue(false)
  mockDetectPaneState.mockReset()
  mockDetectPaneState.mockReturnValue('unknown')
  mockPaneShowsContextSaturation.mockReset()
  mockPaneShowsContextSaturation.mockReturnValue(false)
  mockReadContextTokensFromProjectDir.mockReset()
  mockReadContextTokensFromProjectDir.mockReturnValue(null)
  mockReadActiveModelFromProjectDir.mockReset()
  mockReadActiveModelFromProjectDir.mockReturnValue(null)
  mockCreateAgentMessage.mockReset()
  mockExecFileSync.mockReset()
  mockExecFileSync.mockReturnValue(Buffer.alloc(0))
})

afterEach(() => {
  rmTempDir(STORE_PATH_FOR_TEST)
  vi.useRealTimers()
})

// ---------------------------------------------------------------------------
// Module re-import. The SUT reads PROJECT_ROOT at module-load time; we rebuild
// it via vi.resetModules + dynamic import so an updated mock can land.
// ---------------------------------------------------------------------------

async function importRunner() {
  return await import('../web/context-guard-runner.js')
}

// Pump a single sweep and wait for the async work to settle. The sweep is
// async (await checkAgent per agent), so synchronous advanceTimersByTime can
// yield before the body finishes; advanceTimersByTimeAsync drains microtasks.
async function pumpOneSweep(): Promise<void> {
  await vi.advanceTimersByTimeAsync(270_000)
}

// ---------------------------------------------------------------------------
// 1. handoffPrompt / resumePrompt -- pure prompt builders.
// ---------------------------------------------------------------------------

describe('handoffPrompt', () => {
  it('embeds the rounded percentage and the handoff path', async () => {
    const { handoffPrompt } = await importRunner()
    const out = handoffPrompt(87, '/tmp/agent/HANDOFF.md')
    expect(out).toContain('~87%')
    expect(out).toContain('/tmp/agent/HANDOFF.md')
    expect(out).toContain('HANDOFF.md')
    expect(out).toContain('NE folytasd')
  })

  it('accepts 0 and 100 without truncation', async () => {
    const { handoffPrompt } = await importRunner()
    expect(handoffPrompt(0, '/a')).toContain('~0%')
    expect(handoffPrompt(100, '/a')).toContain('~100%')
  })
})

describe('resumePrompt', () => {
  it('points at the handoff path when hadHandoff=true', async () => {
    const { resumePrompt } = await importRunner()
    const out = resumePrompt('samu', '/tmp/agent/HANDOFF.md', true)
    expect(out).toContain('/tmp/agent/HANDOFF.md')
    expect(out).toContain('samu')
    expect(out).toContain('HANDOFF.md')
    expect(out).not.toContain('HANDOFF.md nem készült')
  })

  it('omits the handoff path when hadHandoff=false', async () => {
    const { resumePrompt } = await importRunner()
    const out = resumePrompt('samu', '/tmp/agent/HANDOFF.md', false)
    expect(out).toContain('HANDOFF.md nem készült')
    expect(out).toContain('samu')
  })
})

// ---------------------------------------------------------------------------
// 2. readHighwater / observedHighwater -- the persisted high-water map.
// ---------------------------------------------------------------------------

describe('readHighwater / observedHighwater', () => {
  it('returns {} when the file is missing', async () => {
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('returns {} when the file content is malformed JSON', async () => {
    writeFileSync(HIGHWATER_PATH, '{not json')
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('returns {} when the JSON is null', async () => {
    writeFileSync(HIGHWATER_PATH, 'null')
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('returns {} when the JSON is a primitive (number)', async () => {
    writeFileSync(HIGHWATER_PATH, '42')
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('returns {} when the JSON is a primitive (string)', async () => {
    writeFileSync(HIGHWATER_PATH, '"hello"')
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('returns {} when the JSON is a primitive (boolean)', async () => {
    writeFileSync(HIGHWATER_PATH, 'true')
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('handles an empty object highwater (no entries -> no persist)', async () => {
    writeFileSync(HIGHWATER_PATH, '{}')
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('handles a JSON array (truthy object) without crashing', async () => {
    writeFileSync(HIGHWATER_PATH, '[]')
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    expect(getContextGuardStatus()).toBeDefined()
  })

  it('persists a NEW highwater when the observed reading exceeds the prior', async () => {
    writeFileSync(HIGHWATER_PATH, JSON.stringify({ marveen: { model: 'm1', tokens: 1000 } }))
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null, // null => observedHighwater path is taken
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(2000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    expect(getContextGuardStatus()).toBeDefined()
    const onDisk = JSON.parse(readFileSync(HIGHWATER_PATH, 'utf-8'))
    expect(onDisk.marveen).toEqual({ model: 'm1', tokens: 2000 })
  })

  it('ignores the prior entry when the model changed (model gate)', async () => {
    writeFileSync(HIGHWATER_PATH, JSON.stringify({ marveen: { model: 'old-model', tokens: 999_999 } }))
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    mockReadActiveModelFromProjectDir.mockReturnValue('new-model')
    expect(getContextGuardStatus()).toBeDefined()
    const onDisk = JSON.parse(readFileSync(HIGHWATER_PATH, 'utf-8'))
    expect(onDisk.marveen).toEqual({ model: 'new-model', tokens: 1000 })
  })

  it('keeps the stored highwater when observed < prior (no write)', async () => {
    writeFileSync(HIGHWATER_PATH, JSON.stringify({ marveen: { model: 'm1', tokens: 5000 } }))
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    expect(getContextGuardStatus()).toBeDefined()
    const onDisk = JSON.parse(readFileSync(HIGHWATER_PATH, 'utf-8'))
    expect(onDisk.marveen).toEqual({ model: 'm1', tokens: 5000 })
  })

  it('swallows a writeFileSync failure from the highwater persist (warn, keep going)', async () => {
    // Force a writeFileSync failure by replacing the highwater path with a
    // directory: writeFileSync on a directory throws EISDIR. We do this BEFORE
    // the SUT runs.
    rmSync(HIGHWATER_PATH, { force: true })
    mkdirSync(HIGHWATER_PATH)
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null, // null => observedHighwater path is taken
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    expect(() => getContextGuardStatus()).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// 3. startContextGuardRunner -- the scheduled sweep.
// ---------------------------------------------------------------------------

describe('startContextGuardRunner', () => {
  it('returns a NodeJS.Timeout and schedules both an initial sweep and an interval', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: false,
      saturationRestart: false,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    expect(timer).toBeDefined()
    expect(typeof (timer as { unref?: () => void }).unref).toBe('function')
    // Advance past the initial sweep (270s) and the first interval (300s).
    await vi.advanceTimersByTimeAsync(270_000)
    await vi.advanceTimersByTimeAsync(300_000)
    clearInterval(timer as unknown as number)
  })

  it('tolerates a thrown checkAgent on the main path (catches + debug)', async () => {
    mockReadContextGuardConfig.mockImplementation(() => {
      throw new Error('boom')
    })
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await vi.advanceTimersByTimeAsync(270_000)
    await vi.advanceTimersByTimeAsync(300_000)
    clearInterval(timer as unknown as number)
  })

  it('tolerates a thrown checkAgent on the sub-agent path (catches + debug)', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n === 'samu') throw new Error('sub boom')
      return {
        enabled: false,
        saturationRestart: false,
        actPct: 0.9,
        hardPct: 0.97,
        limitTokens: null,
        cooldownMinutes: 15,
        handoffTimeoutMinutes: 20,
      }
    })
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await vi.advanceTimersByTimeAsync(270_000)
    await vi.advanceTimersByTimeAsync(300_000)
    clearInterval(timer as unknown as number)
  })
})

// ---------------------------------------------------------------------------
// 4. getContextGuardStatus -- the public status reader.
// ---------------------------------------------------------------------------

describe('getContextGuardStatus', () => {
  it('includes the main agent and every sub-agent', async () => {
    mockListAgentNames.mockReturnValue(['samu', 'zara'])
    const { getContextGuardStatus } = await importRunner()
    const out = getContextGuardStatus()
    const names = out.map((r) => r.agent)
    expect(names).toContain('marveen')
    expect(names).toContain('samu')
    expect(names).toContain('zara')
  })

  it('reports phase=idle by default (no recorded state)', async () => {
    const { getContextGuardStatus } = await importRunner()
    const out = getContextGuardStatus()
    expect(out[0].phase).toBe('idle')
    expect(out[0].enabled).toBe(true)
    expect(out[0].saturationRestart).toBe(true)
  })

  it('returns null pct when cfg.enabled=false (proactive tiers disabled)', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: false,
      saturationRestart: true,
      actPct: 0.9,
      hardPct: 0.97,
      limitTokens: null,
      cooldownMinutes: 15,
      handoffTimeoutMinutes: 20,
    })
    const { getContextGuardStatus } = await importRunner()
    const out = getContextGuardStatus()
    expect(out[0].pct).toBeNull()
  })

  it('returns null pct for a remote-host sub-agent', async () => {
    mockListAgentNames.mockReturnValue(['remote'])
    mockReadAgentRemoteHost.mockImplementation((n: string) => n === 'remote' ? 'laptop.lan' : null)
    const { getContextGuardStatus } = await importRunner()
    const out = getContextGuardStatus()
    const remote = out.find((r) => r.agent === 'remote')
    expect(remote?.pct).toBeNull()
  })

  it('reports the main agent shape verbatim', async () => {
    const { getContextGuardStatus } = await importRunner()
    const out = getContextGuardStatus()
    expect(out[0]).toMatchObject({
      agent: 'marveen',
      phase: 'idle',
      enabled: true,
      saturationRestart: true,
    })
  })
})

// ---------------------------------------------------------------------------
// 5. checkAgent via startContextGuardRunner -- the main agent, one branch per
// test. We pump a single sweep via fake timers and assert on the mocks the
// branch is supposed to touch.
// ---------------------------------------------------------------------------

describe('checkAgent (main agent) via startContextGuardRunner', () => {
  it('disarms and clears state when both enabled and saturationRestart are false', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: false, saturationRestart: false,
      actPct: 0.9, hardPct: 0.97, limitTokens: null,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    // No probe should be required -- capturePane, sendPromptToSession,
    // restartAgentProcess, hardRestart -- none of them.
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
    expect(mockHardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('skips remote-host sub-agents and logs the skip (only once)', async () => {
    mockListAgentNames.mockReturnValue(['remote'])
    mockReadAgentRemoteHost.mockImplementation((n: string) => n === 'remote' ? 'laptop.lan' : null)
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    await vi.advanceTimersByTimeAsync(300_000)
    clearInterval(timer as unknown as number)
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('does not call capturePane when the sub-agent is not running', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockAgentRunState.mockReturnValue('stopped')
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockCapturePane).not.toHaveBeenCalledWith('agent-samu')
  })

  it('captures the pane and measures pct when the sub-agent is running', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n === 'samu') {
        return {
          enabled: true, saturationRestart: true,
          actPct: 0.9, hardPct: 0.97, limitTokens: 200_000,
          cooldownMinutes: 15, handoffTimeoutMinutes: 20,
        }
      }
      return {
        enabled: false, saturationRestart: false,
        actPct: 0.9, hardPct: 0.97, limitTokens: null,
        cooldownMinutes: 15, handoffTimeoutMinutes: 20,
      }
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(100_000)
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockCapturePane).toHaveBeenCalledWith('agent-samu', undefined)
    expect(mockReadContextTokensFromProjectDir).toHaveBeenCalled()
  })

  it('short-circuits pct when enabled=false (only the saturation net runs)', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: false, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: null,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(50_000)
    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    // pct must be null -- readContextTokensFromProjectDir must NOT be called
    // for the main agent under cfg.enabled=false.
    expect(mockReadContextTokensFromProjectDir).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// 6. checkAgent via the runner, exercising the decision-action branches.
// ---------------------------------------------------------------------------

describe('decision-action branches via the runner', () => {
  it('main restart: hardRestartMarveenChannels() is called and a snapshot is written', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000) // 99% -> >= hardPct
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: true })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)

    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
    expect(mockCreateAgentMessage).toHaveBeenCalled()
  })

  it('main restart: throws when hardRestartMarveenChannels returns ok=false', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'plist missing' })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('main restart: defers when shouldDeferForRecentRespawn returns true', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockShouldDeferForRecentRespawn.mockReturnValue(true)
    mockLastMainRespawnAt.mockReturnValue(Date.now() - 1000)

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    // Defer: hardRestart is NOT called.
    expect(mockHardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('sub-agent restart: restartAgentProcess(name, { fresh: true }) is called', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n !== 'samu') {
        return {
          enabled: false, saturationRestart: false,
          actPct: 0.9, hardPct: 0.97, limitTokens: null,
          cooldownMinutes: 15, handoffTimeoutMinutes: 20,
        }
      }
      return {
        enabled: true, saturationRestart: true,
        actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
        cooldownMinutes: 15, handoffTimeoutMinutes: 20,
      }
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadAgentModel.mockReturnValue('m1')

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)

    expect(mockRestartAgentProcess).toHaveBeenCalledWith('samu', { fresh: true })
  })

  it('sub-agent restart with capturePane returning null exercises L279/L280/L295 fallback branches', async () => {
    // A `(pane ?? capturePane(session))` (L279) retry-ag és a `(finalPane)`
    // (L280) skip-ag, valamint a `(snapshotPath ? ...)` (L295) skip-ag csak
    // akkor nyílik meg, ha a capture MINDKÉT hívásra null-t ad vissza, es
    // a guard megis restart-ot dont (pct >= hardPct, busy=false). A sub-agent
    // ágat használjuk, mert a main-nél running a capturePane-tól függ, és ott
    // a null capture mar `inputs.running=false`-ot jelentene -- a guard
    // 'not running' miatt 'none' action-t adna, es soha nem érnénk el a
    // restart branch-et. Sub-agent-nél running = agentRunState, pane capture
    // fuggetlen.
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n !== 'samu') {
        return {
          enabled: false, saturationRestart: false,
          actPct: 0.9, hardPct: 0.97, limitTokens: null,
          cooldownMinutes: 15, handoffTimeoutMinutes: 20,
        }
      }
      return {
        enabled: true, saturationRestart: true,
        actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
        cooldownMinutes: 15, handoffTimeoutMinutes: 20,
      }
    })
    // Mindkét capturePane hívás null -- L279 ?? retry, L280 finalPane null.
    mockCapturePane.mockReturnValue(null)
    mockDetectPaneState.mockReturnValue('unknown')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadAgentModel.mockReturnValue('m1')

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)

    // A restart megtörtént (sub-agent path), de NEM íródott snapshot fájl.
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('samu', { fresh: true })
    expect(existsSync(SNAPSHOT_PATH)).toBe(false)
    // A createAgentMessage-et is meg kellett hivni -- az L295-ös branch[1]
    // ilyenkor fut le (snapshotPath null, nincs Pane-snapshot megjegyzés).
    expect(mockCreateAgentMessage).toHaveBeenCalled()
    const messageArg = mockCreateAgentMessage.mock.calls[0]?.[3] as string | undefined
    expect(messageArg ?? '').not.toContain('Pane-snapshot')
  })

  it('non-running sub-agent: no probe and no side effects', async () => {
    mockListAgentNames.mockReturnValue(['samu'])
    mockAgentRunState.mockReturnValue('stopped')
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n === 'samu') {
        return {
          enabled: true, saturationRestart: true,
          actPct: 0.9, hardPct: 0.97, limitTokens: null,
          cooldownMinutes: 15, handoffTimeoutMinutes: 20,
        }
      }
      return {
        enabled: false, saturationRestart: false,
        actPct: 0.9, hardPct: 0.97, limitTokens: null,
        cooldownMinutes: 15, handoffTimeoutMinutes: 20,
      }
    })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    // capturePane is still called for the MAIN agent's `running` check but
    // never for samu (because agentRunState('samu') === 'stopped').
    expect(mockCapturePane).not.toHaveBeenCalledWith('agent-samu')
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
  })

  it('main session: capturePane\'s pane === null short-circuits everything', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: null,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue(null)

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockSendPromptToSession).not.toHaveBeenCalled()
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('remote-host sub-agent: logged once, skipped (no side effects)', async () => {
    mockListAgentNames.mockReturnValue(['remote'])
    mockReadAgentRemoteHost.mockImplementation((n: string) => n === 'remote' ? 'laptop.lan' : null)
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n === 'remote') {
        return {
          enabled: true, saturationRestart: true,
          actPct: 0.9, hardPct: 0.97, limitTokens: null,
          cooldownMinutes: 15, handoffTimeoutMinutes: 20,
        }
      }
      return {
        enabled: false, saturationRestart: false,
        actPct: 0.9, hardPct: 0.97, limitTokens: null,
        cooldownMinutes: 15, handoffTimeoutMinutes: 20,
      }
    })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    await vi.advanceTimersByTimeAsync(300_000) // a second sweep
    clearInterval(timer as unknown as number)
    expect(mockCapturePane).not.toHaveBeenCalledWith('agent-remote')
    expect(mockRestartAgentProcess).not.toHaveBeenCalled()
  })

  it('sub-agent restart: snapshot path written for the main agent', async () => {
    // The snapshot file is named for the main agent (the SUT hard-codes
    // 'context-guard-last-pane-${name}' for the main specifically). The
    // sub-agent path does NOT write a snapshot. This case mirrors the main
    // hard restart but inspects the snapshot file.
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)\nLAST-CHANCE-FOOTER')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: true })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)

    expect(existsSync(SNAPSHOT_PATH)).toBe(true)
    expect(readFileSync(SNAPSHOT_PATH, 'utf-8')).toContain('LAST-CHANCE-FOOTER')
  })

  it('main restart: snapshot write failure is tolerated (warn + proceed)', async () => {
    // Pre-create a DIRECTORY at the snapshot path so writeFileSync throws EISDIR.
    rmSync(SNAPSHOT_PATH, { force: true })
    mkdirSync(SNAPSHOT_PATH)
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: true })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    // The hard restart still happens even though the snapshot failed.
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('main restart: createAgentMessage failure is tolerated (warn + proceed)', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: true })
    mockCreateAgentMessage.mockImplementation(() => {
      throw new Error('db locked')
    })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('inject-resume: sendPromptToSession is called with a CONTEXT-GUARD prompt (hadHandoff=true)', async () => {
    // Force the state into await-ready by pre-seeding via the highwater file
    // doesn't work (state is in-memory). We trigger the await-ready path
    // through idle -> restart -> await-ready by a single sweep, then wait
    // for the next sweep to inject the resume prompt.
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: true })
    // First sweep: hard restart -> state = await-ready.
    // Second sweep: isSessionReadyForPrompt -> true -> inject-resume.
    mockIsSessionReadyForPrompt.mockResolvedValue(true)

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep() // first sweep
    await vi.advanceTimersByTimeAsync(300_000) // second sweep
    clearInterval(timer as unknown as number)
    expect(mockSendPromptToSession).toHaveBeenCalled()
    const lastCall = mockSendPromptToSession.mock.calls[mockSendPromptToSession.mock.calls.length - 1]
    expect(lastCall[0]).toBe('marveen-channels')
    expect(lastCall[1]).toContain('CONTEXT-GUARD')
  })

  it('inject-resume: sendPromptToSession throws -> warn + do not crash', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: true })
    mockIsSessionReadyForPrompt.mockResolvedValue(true)
    mockSendPromptToSession.mockRejectedValue(new Error('send failed'))

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep() // first sweep
    await vi.advanceTimersByTimeAsync(300_000) // second sweep
    clearInterval(timer as unknown as number)
    // Sweep catches the throw -- no crash.
    expect(mockSendPromptToSession).toHaveBeenCalled()
  })

  it('request-handoff: sendPromptToSession is called with a CONTEXT-GUARD prompt (pct in act<->hard band)', async () => {
    // Drive the state to request-handoff: state=idle, pct in (actPct, hardPct).
    // First sweep: state=idle -> request-handoff (action). The SUT sends the
    // handoff prompt.
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(92_000) // 92% -> request-handoff
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockSendPromptToSession).toHaveBeenCalled()
    const firstCall = mockSendPromptToSession.mock.calls[0]
    expect(firstCall[0]).toBe('marveen-channels')
    expect(firstCall[1]).toContain('CONTEXT-GUARD')
    expect(firstCall[1]).toContain('HANDOFF.md')
  })

  it('main restart: shouldDeferForRecentRespawn with lastRespawn=0 (falsy branch in log line)', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockShouldDeferForRecentRespawn.mockReturnValue(true)
    mockLastMainRespawnAt.mockReturnValue(0) // falsy lastRespawn -> the sinceRespawnMs=null branch

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockHardRestartMarveenChannels).not.toHaveBeenCalled()
  })

  it('main restart: hardRestartMarveenChannels returns error string (res.error branch)', async () => {
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    mockHardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'explicit error' })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('saturation-net restart: pct=null in the restart message (cfg.enabled=false path)', async () => {
    // Cancel the proactive tiers but keep the saturation net armed so the
    // restart fires off the saturated pane alone, with inputs.pct=null.
    mockReadContextGuardConfig.mockReturnValue({
      enabled: false, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: null,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('100% context used\nbypass permissions on')
    mockDetectPaneState.mockReturnValue('idle')
    mockPaneShowsContextSaturation.mockReturnValue(true)
    mockHardRestartMarveenChannels.mockReturnValue({ ok: true })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    await vi.advanceTimersByTimeAsync(300_000) // confirm streak (2 sweeps)
    clearInterval(timer as unknown as number)
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
    expect(mockCreateAgentMessage).toHaveBeenCalled()
    // The pct-null branch is verified by the absence of "(kontextus ~" in the
    // message when the restart comes from the saturation net with no pct.
    const message = mockCreateAgentMessage.mock.calls[0]?.[2] as string
    expect(message).not.toContain('kontextus ~')
  })

  it('sub-agent restart via saturation net: snapshot file IS written (saturated pane captured)', async () => {
    // Sub-agent, running=true, pane consistently shows saturated text on every
    // capturePane. After two consecutive saturated sweeps the saturation net
    // fires (SATURATION_CONFIRM_SWEEPS=2). Because pane is non-null on the
    // restart sweep, the snapshot file `context-guard-last-pane-${name}.txt`
    // is written and the restart notice message includes the snapshot path.
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n === 'samu') {
        return {
          enabled: false, saturationRestart: true,
          actPct: 0.9, hardPct: 0.97, limitTokens: null,
          cooldownMinutes: 15, handoffTimeoutMinutes: 20,
        }
      }
      return {
        enabled: false, saturationRestart: false,
        actPct: 0.9, hardPct: 0.97, limitTokens: null,
        cooldownMinutes: 15, handoffTimeoutMinutes: 20,
      }
    })
    mockCapturePane.mockReturnValue('100% context used\nbypass permissions on')
    mockDetectPaneState.mockReturnValue('idle')
    mockPaneShowsContextSaturation.mockReturnValue(true)
    mockRestartAgentProcess.mockReturnValue({ ok: true })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    await vi.advanceTimersByTimeAsync(300_000)
    clearInterval(timer as unknown as number)
    expect(mockRestartAgentProcess).toHaveBeenCalledWith('samu', { fresh: true })
    const subSnapshot = join(STORE_PATH_FOR_TEST, 'context-guard-last-pane-samu.txt')
    expect(existsSync(subSnapshot)).toBe(true)
    const message = mockCreateAgentMessage.mock.calls[0]?.[2] as string
    expect(message).toContain('Pane-snapshot')
  })

  it('sub-agent: readAgentModel=null falls back to empty string in measurePct', async () => {
    // Cover the `readAgentModel(name) ?? ''` else branch in measurePct. Need:
    // cfg.enabled=true (so pct IS computed) AND limitTokens=null (so the
    // calibrateLimit path is taken, which reads the model) AND
    // readAgentModel(name) returns null.
    mockListAgentNames.mockReturnValue(['samu'])
    mockReadContextGuardConfig.mockImplementation((n: string) => {
      if (n === 'samu') {
        return {
          enabled: true, saturationRestart: false,
          actPct: 0.9, hardPct: 0.97, limitTokens: null,
          cooldownMinutes: 15, handoffTimeoutMinutes: 20,
        }
      }
      return {
        enabled: false, saturationRestart: false,
        actPct: 0.9, hardPct: 0.97, limitTokens: null,
        cooldownMinutes: 15, handoffTimeoutMinutes: 20,
      }
    })
    mockReadAgentModel.mockReturnValue(null)
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(50_000)

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    await vi.advanceTimersByTimeAsync(300_000)
    clearInterval(timer as unknown as number)
    // measurePct called with model='' -> calibrateLimit(highwater, 200_000).
    expect(mockReadAgentModel).toHaveBeenCalledWith('samu')
  })

  it('main restart: hardRestartMarveenChannels returns ok=false with undefined error -> default message', async () => {
    // Cover the `res.error ?? 'main channels hard restart failed'` else branch:
    // res.ok is false AND res.error is undefined. The SUT throws with the
    // default message; the catch in the outer try swallows it.
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: 100_000,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockCapturePane.mockReturnValue('bypass permissions on (shift+tab to cycle)')
    mockDetectPaneState.mockReturnValue('idle')
    mockReadContextTokensFromProjectDir.mockReturnValue(99_000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    // ok=false with no `error` field at all -> undefined -> hits the ?? default.
    mockHardRestartMarveenChannels.mockReturnValue({ ok: false } as { ok: boolean; error?: string })

    vi.useFakeTimers()
    const { startContextGuardRunner } = await importRunner()
    const timer = startContextGuardRunner()
    await pumpOneSweep()
    clearInterval(timer as unknown as number)
    expect(mockHardRestartMarveenChannels).toHaveBeenCalled()
  })

  it('observedHighwater: highwater cache is non-null on subsequent calls in the same process', async () => {
    // Cover the `if (highwater === null)` else branch. First call sets the
    // cache; second call sees non-null and uses the cache. Triggered by
    // calling getContextGuardStatus twice in one process -- both reads go
    // through observedHighwater (cfg.enabled=true, limitTokens=null path).
    const { getContextGuardStatus } = await importRunner()
    mockReadContextGuardConfig.mockReturnValue({
      enabled: true, saturationRestart: true,
      actPct: 0.9, hardPct: 0.97, limitTokens: null,
      cooldownMinutes: 15, handoffTimeoutMinutes: 20,
    })
    mockReadContextTokensFromProjectDir.mockReturnValue(1000)
    mockReadActiveModelFromProjectDir.mockReturnValue('m1')
    // First read: lazy-load highwater.
    getContextGuardStatus()
    // Second read: cache hit.
    getContextGuardStatus()
    // Both reads called readContextTokensFromProjectDir -> both went through
    // observedHighwater -> the second invocation hits the cached path.
    expect(mockReadContextTokensFromProjectDir).toHaveBeenCalledTimes(2)
  })
})
