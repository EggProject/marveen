// Call-site coverage test: src/web/routes/background-tasks.ts (site 1).
//
// Background tasks are spawned with `execFileSync(TMUX, buildClaudeLaunchCmd(spec).args)`.
// That means the migrated call site invokes `buildClaudeLaunchSpec` directly,
// then `buildClaudeLaunchCmd(spec).args` for the tmux argv. This test:
//
//   1. Mocks the claude-launch module so buildClaudeLaunchCmd returns a
//      controlled canned response, and execFileSync so we don't actually call tmux.
//   2. Mocks the DB helpers that spawnBackgroundTask calls (createBackgroundTaskAtomic,
//      finishBackgroundTask, getBackgroundTask, getRunningBackgroundTasks).
//   3. Invokes spawnBackgroundTask('agent-1', 'test prompt').
//   4. Asserts that buildClaudeLaunchSpec was called with the EXACT expected spec
//      (site-1-background fields) and that execFileSync received the canned args.
//   5. Asserts that no legacy code paths were executed (no runTmux, etc.).

import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the claude-launch module BEFORE importing the call site. The module is
// imported via relative path '../web/claude-launch.js' from routes/background-tasks.ts,
// so the mock key must match the path the importer uses for the resolved module.
vi.mock('../../web/claude-launch.js', () => ({
  buildClaudeLaunchSpec: vi.fn((input) => ({
    site: 'site-1-background',
    session: input.session,
    claudePath: input.claudePath,
    cwd: input.cwd,
    host: input.host,
    tmuxSubcommand: input.tmuxSubcommand,
    paneGeometry: input.paneGeometry,
    pathPreset: input.pathPreset ?? 'macos',
    cwdAsCd: input.cwdAsCd ?? true,
    mcpBatch: input.mcpBatch ?? 'none',
    promptSuggestionGuard: input.promptSuggestionGuard ?? false,
    scrubChannelTokens: input.scrubChannelTokens ?? false,
    detectSandbox: input.detectSandbox ?? false,
    detectAvxLess: input.detectAvxLess ?? false,
    pathTrailingInherit: input.pathTrailingInherit ?? false,
    followups: input.followups ?? {},
    extraPluginIds: [],
  })),
  buildClaudeLaunchCmd: vi.fn(() => ({
    args: ['new-session', '-d', '-s', 'bg-MOCKED01', '-x', '200', '-y', '50', '<mocked-cmd>'],
    cmd: '<mocked-cmd>',
    followupPlan: {
      writeRespawnStamp: false,
      pluginUnlock: false,
      postResumePluginGuard: false,
      dismissResumeSummaryModal: false,
      reapOrphans: 'none',
      reSeedOnboarding: false,
      startChannelsStartupGuard: false,
      keepaliveTouch: false,
      telegramBotMenu: false,
      channelsFailureLog: false,
      logClaudeVersion: false,
      continueSession: false,
      hasChannel: false,
    },
    warnings: [],
  })),
  launchClaudeNewSession: vi.fn(),
  respawnClaudePane: vi.fn(),
  runTmuxInvocation: vi.fn(),
  applyPostLaunchFollowups: vi.fn(),
}))

// Mock the DB module that spawnBackgroundTask talks to (concurrency check +
// task atomic insert). The live DB code path is irrelevant to the call-site
// contract: we just need a non-null task returned and the polling helpers to
// return controlled shapes.
vi.mock('../../db.js', () => ({
  createBackgroundTaskAtomic: vi.fn(() => ({
    id: 'MOCKED01',
    agent_id: 'agent-1',
    prompt: 'test prompt',
    status: 'running',
    tmux_session: 'bg-MOCKED01',
    started_at: Math.floor(Date.now() / 1000),
    finished_at: null,
    output: null,
  })),
  finishBackgroundTask: vi.fn(),
  getBackgroundTasks: vi.fn(() => []),
  getBackgroundTask: vi.fn(() => null),
  getRunningBackgroundTasks: vi.fn(() => []),
  markOrphanedTasksFailed: vi.fn(),
}))

// Mock child_process so execSync / execFileSync do not actually call tmux.
vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

import { execFileSync } from 'node:child_process'
import {
  buildClaudeLaunchSpec,
  buildClaudeLaunchCmd,
  launchClaudeNewSession,
  respawnClaudePane,
  runTmuxInvocation,
} from '../../web/claude-launch.js'
import { createBackgroundTaskAtomic, finishBackgroundTask } from '../../db.js'
import { spawnBackgroundTask } from '../../web/routes/background-tasks.js'

beforeEach(() => {
  vi.clearAllMocks()
  // Re-stub the atomic-create AFTER clearAllMocks (it cleared it) so the function
  // returns a non-null task and the function under test proceeds to the launch step.
  ;(createBackgroundTaskAtomic as ReturnType<typeof vi.fn>).mockReturnValue({
    id: 'MOCKED01',
    agent_id: 'agent-1',
    prompt: 'test prompt',
    status: 'running',
    tmux_session: 'bg-MOCKED01',
    started_at: Math.floor(Date.now() / 1000),
    finished_at: null,
    output: null,
  })
  ;(buildClaudeLaunchCmd as ReturnType<typeof vi.fn>).mockReturnValue({
    args: ['new-session', '-d', '-s', 'bg-MOCKED01', '-x', '200', '-y', '50', '<mocked-cmd>'],
    cmd: '<mocked-cmd>',
    followupPlan: {
      writeRespawnStamp: false,
      pluginUnlock: false,
      postResumePluginGuard: false,
      dismissResumeSummaryModal: false,
      reapOrphans: 'none',
      reSeedOnboarding: false,
      startChannelsStartupGuard: false,
      keepaliveTouch: false,
      telegramBotMenu: false,
      channelsFailureLog: false,
      logClaudeVersion: false,
      continueSession: false,
      hasChannel: false,
    },
    warnings: [],
  })
})

function setSpecStub(): void {
  // Configure the buildClaudeLaunchSpec passthrough stub freshly after
  // vi.clearAllMocks() so the call-site function under test still receives a
  // meaningful spec-like object.
  ;(buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mockImplementation((input: any) => ({
    site: input.site,
    session: input.session,
    claudePath: input.claudePath,
    cwd: input.cwd,
    host: input.host,
    tmuxSubcommand: input.tmuxSubcommand,
    paneGeometry: input.paneGeometry,
    pathPreset: input.pathPreset ?? 'macos',
    cwdAsCd: input.cwdAsCd ?? true,
    mcpBatch: input.mcpBatch ?? 'none',
    promptSuggestionGuard: input.promptSuggestionGuard ?? false,
    scrubChannelTokens: input.scrubChannelTokens ?? false,
    detectSandbox: input.detectSandbox ?? false,
    detectAvxLess: input.detectAvxLess ?? false,
    pathTrailingInherit: input.pathTrailingInherit ?? false,
    followups: input.followups ?? {},
    extraPluginIds: [],
  }))
}

describe('call-site: background-tasks (site-1-background)', () => {
  it('builds the spec via buildClaudeLaunchSpec with the exact expected fields', () => {
    setSpecStub()
    const result = spawnBackgroundTask('agent-1', 'test prompt')
    expect(result).not.toHaveProperty('error')

    expect(buildClaudeLaunchSpec).toHaveBeenCalledTimes(1)
    const specInput = (buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mock.calls[0][0]

    // Field-by-field assertions (toEqual does not run nested expect.* matchers).
    expect(specInput.site).toBe('site-1-background')
    expect(specInput.session).toMatch(/^bg-[A-F0-9]{8}$/)
    expect(typeof specInput.claudePath).toBe('string')
    expect(specInput.claudePath.length).toBeGreaterThan(0)
    expect(typeof specInput.cwd).toBe('string')
    expect(specInput.cwd.length).toBeGreaterThan(0)
    expect(specInput.host).toEqual({ kind: 'local' })
    expect(specInput.tmuxSubcommand).toBe('newSession')
    expect(specInput.paneGeometry).toEqual({ cols: 200, rows: 50 })
    expect(specInput.pathPreset).toBe('macos')
    expect(specInput.cwdAsCd).toBe(false) // background-task inherits pane cwd
    expect(specInput.mcpBatch).toBe('none')
    expect(specInput.promptSuggestionGuard).toBe(false)
    expect(specInput.scrubChannelTokens).toBe(false)
    expect(specInput.detectSandbox).toBe(false)
    expect(specInput.detectAvxLess).toBe(false)
    expect(specInput.pathTrailingInherit).toBe(false)
    expect(specInput.followups.extraFlags).toBe('-p "$BG_PROMPT" --output-format text 2>&1')
    expect(specInput.followups.appendCmdSuffix).toContain('___BG_DONE___')
  })

  it('invokes execFileSync with the canned args from buildClaudeLaunchCmd(spec).args', () => {
    setSpecStub()
    spawnBackgroundTask('agent-1', 'test prompt')

    // buildClaudeLaunchCmd is called by the migrated site to derive .args
    expect(buildClaudeLaunchCmd).toHaveBeenCalledTimes(1)
    // execFileSync is the call that passes those args to tmux
    expect(execFileSync).toHaveBeenCalled()
    // The first .mock.calls entry to execFileSync corresponds to the tmux call;
    // its argument shape is (file: string, args: string[], opts: object).
    const tmuxCall = (execFileSync as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => Array.isArray(c[1]) && c[1][0] === 'new-session',
    )
    expect(tmuxCall, 'execFileSync was never called with tmux new-session args').toBeDefined()
    const args = tmuxCall![1] as string[]
    expect(args[0]).toBe('new-session')
    expect(args).toContain('-d')
    // BG_PROMPT env was passed through
    const opts = tmuxCall![2] as { env?: Record<string, string> }
    expect(opts.env).toBeDefined()
    expect(opts.env!.BG_PROMPT).toBe('test prompt')
  })

  it('DOES NOT use the legacy launchClaudeNewSession / respawnClaudePane / runTmuxInvocation helpers', () => {
    setSpecStub()
    spawnBackgroundTask('agent-1', 'test prompt')

    // The migrated site uses execFileSync directly with buildClaudeLaunchCmd(spec).args
    // and has NO wrapper invocation helper. The remaining three launch entrypoints
    // from claude-launch.js MUST stay untouched by this site.
    expect(launchClaudeNewSession).not.toHaveBeenCalled()
    expect(respawnClaudePane).not.toHaveBeenCalled()
    expect(runTmuxInvocation).not.toHaveBeenCalled()
  })

  it('records the task as failed when execFileSync throws (failure path)', () => {
    setSpecStub()
    ;(execFileSync as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('tmux: no server')
    })
    const result = spawnBackgroundTask('agent-1', 'test prompt')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toMatch(/háttérfeladat/)
    }
    expect(finishBackgroundTask).toHaveBeenCalled()
  })
})
