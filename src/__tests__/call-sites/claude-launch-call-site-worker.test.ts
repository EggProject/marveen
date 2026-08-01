// Call-site coverage test: src/web/agent-worker.ts (site 5).
//
// Site 5 = `startWorkerSessionFor` (private, called from the exported
// `startWorkerSession`). The migrated function calls `launchClaudeNewSession(
// spec, { agentDir: ctx.home } )` after building the worker spec with
// pathPreset='login-shell', cwdAsTmuxC=true, and no channel plugin.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../../web/claude-launch.js', () => ({
  buildClaudeLaunchSpec: vi.fn((input) => ({
    site: input.site,
    session: input.session,
    claudePath: input.claudePath,
    cwd: input.cwd,
    host: input.host,
    tmuxSubcommand: input.tmuxSubcommand,
    model: input.model,
    continueSession: input.continueSession,
    pluginId: input.pluginId,
    extraPluginIds: input.extraPluginIds ?? [],
    isolatedConfigDir: input.isolatedConfigDir,
    fleetOauthToken: input.fleetOauthToken,
    cwdAsCd: input.cwdAsCd ?? true,
    cwdAsTmuxC: input.cwdAsTmuxC ?? false,
    mcpBatch: input.mcpBatch,
    promptSuggestionGuard: input.promptSuggestionGuard,
    scrubChannelTokens: input.scrubChannelTokens,
    detectSandbox: input.detectSandbox,
    detectAvxLess: input.detectAvxLess,
    pathPreset: input.pathPreset ?? 'macos',
    pathTrailingInherit: input.pathTrailingInherit ?? false,
    followups: input.followups ?? {},
  })),
  launchClaudeNewSession: vi.fn(() => Promise.resolve({ ok: true })),
  runTmuxInvocation: vi.fn(() => ({ ok: true })),
  respawnClaudePane: vi.fn(() => Promise.resolve({ ok: true })),
  buildClaudeLaunchCmd: vi.fn(() => ({ args: ['mocked'], cmd: '<mocked-cmd>', followupPlan: { continueSession: false, hasChannel: false }, warnings: [] })),
  applyPostLaunchFollowups: vi.fn(),
}))

vi.mock('../../platform.js', () => ({
  resolveFromPath: vi.fn(() => '/usr/local/bin/claude'),
  tryResolveFromPath: vi.fn((name: string) => `/usr/local/bin/${name}`),
}))

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}))

vi.mock('../../web/agent-process.js', () => ({
  hasFleetOauthToken: vi.fn(() => false),
  FLEET_OAUTH_TOKEN_PATH: '/tmp/mock-fleet-oauth-token',
  capturePane: vi.fn(() => null),
  isSessionReadyForPrompt: vi.fn(() => false),
  sendPromptToSession: vi.fn(),
  sessionExistsOnHost: vi.fn(() => false),
}))

vi.mock('../../web/claude-credentials.js', () => ({
  readClaudeCodeOauthJson: vi.fn(() => null),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn(() => false), mkdirSync: vi.fn(), writeFileSync: vi.fn(), readFileSync: vi.fn(() => '') }
})

vi.mock('../../notify.js', () => ({
  notifyChannel: vi.fn(() => Promise.resolve()),
}))

import { buildClaudeLaunchSpec, launchClaudeNewSession, respawnClaudePane, runTmuxInvocation } from '../../web/claude-launch.js'
import { startWorkerSession } from '../../web/agent-worker.js'

beforeEach(() => {
  vi.clearAllMocks()
})

function setSpecStub(): void {
  ;(buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mockImplementation((input: any) => ({
    site: input.site,
    session: input.session,
    claudePath: input.claudePath,
    cwd: input.cwd,
    host: input.host,
    tmuxSubcommand: input.tmuxSubcommand,
    model: input.model,
    continueSession: input.continueSession,
    pluginId: input.pluginId,
    extraPluginIds: input.extraPluginIds ?? [],
    isolatedConfigDir: input.isolatedConfigDir,
    fleetOauthToken: input.fleetOauthToken,
    cwdAsCd: input.cwdAsCd ?? true,
    cwdAsTmuxC: input.cwdAsTmuxC ?? false,
    mcpBatch: input.mcpBatch,
    promptSuggestionGuard: input.promptSuggestionGuard,
    scrubChannelTokens: input.scrubChannelTokens,
    detectSandbox: input.detectSandbox,
    detectAvxLess: input.detectAvxLess,
    pathPreset: input.pathPreset ?? 'macos',
    pathTrailingInherit: input.pathTrailingInherit ?? false,
    followups: input.followups ?? {},
  }))
}

describe('call-site: agent-worker startWorkerSessionFor (site-5-worker)', () => {
  it('builds the spec with pathPreset=login-shell, cwdAsTmuxC=true and no channel plugin', () => {
    setSpecStub()
    // startWorkerSession() invokes the private startWorkerSessionFor for both
    // slow + fast contexts (workerStartAllowed gates on env.WEB_ONLY; the
    // default value is 'true' which means we must explicitly set undefined).
    delete process.env.WEB_ONLY
    startWorkerSession()

    // Two worker sessions: slow + fast → buildClaudeLaunchSpec invoked twice
    expect(buildClaudeLaunchSpec).toHaveBeenCalledTimes(2)
    const calls = (buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const spec = call[0]
      expect(spec.site).toBe('site-5-worker')
      expect(spec.tmuxSubcommand).toBe('newSession')
      expect(typeof spec.claudePath).toBe('string')
      expect(spec.claudePath.length).toBeGreaterThan(0)
      expect(spec.host).toEqual({ kind: 'local' })
      expect(spec.cwdAsCd).toBe(false) // login-shell handles cd via bash -lc
      expect(spec.cwdAsTmuxC).toBe(true) // -c <cwd> on the new-session flag
      expect(spec.pathPreset).toBe('login-shell')
      expect(spec.pathTrailingInherit).toBe(false)
      expect(spec.mcpBatch).toBe('none')
      expect(spec.promptSuggestionGuard).toBe(false)
      expect(spec.scrubChannelTokens).toBe(false)
      expect(spec.detectSandbox).toBe(false)
      expect(spec.detectAvxLess).toBe(false)
      // No channel plugin on the worker — isolated CLAUDE_CONFIG_DIR is the
      // auth boundary, not --channels.
      expect(spec.pluginId).toBeUndefined()
      // extraPluginIds may be undefined in the raw input; the builder defaults
      // it to []. We assert the underlying contract: NO plugin ids passed.
      expect(spec.extraPluginIds ?? []).toEqual([])
      expect(typeof spec.session).toBe('string')
      expect(spec.session.endsWith('-worker') || spec.session.endsWith('-worker-fast')).toBe(true)
      expect(typeof spec.model).toBe('string')
      // isolated config dir is set (worker uses an isolated config root)
      expect(typeof spec.isolatedConfigDir).toBe('string')
      expect(spec.isolatedConfigDir.length).toBeGreaterThan(0)
      // Followup bag
      expect(spec.followups.logClaudeVersion).toBe(true)
      expect(spec.followups.identitySetup).toBeDefined()
      expect(typeof spec.followups.identitySetup!.displayName).toBe('string')
    }
  })

  it('invokes launchClaudeNewSession EXACTLY ONCE per worker with the canned spec', () => {
    setSpecStub()
    delete process.env.WEB_ONLY
    startWorkerSession()

    // Both slow + fast worker sessions → 2 launches
    expect(launchClaudeNewSession).toHaveBeenCalledTimes(2)
    const calls = (launchClaudeNewSession as ReturnType<typeof vi.fn>).mock.calls
    for (const call of calls) {
      const passedSpec = call[0]
      const passedCtx = call[1]
      expect(passedSpec.site).toBe('site-5-worker')
      expect(passedCtx).toBeDefined()
      expect(typeof passedCtx.agentDir).toBe('string')
      expect(passedCtx.agentDir.length).toBeGreaterThan(0)
    }
  })

  it('DOES NOT use the sync runTmuxInvocation / respawnClaudePane helpers (worker uses the launchClaudeNewSession contract)', () => {
    setSpecStub()
    delete process.env.WEB_ONLY
    startWorkerSession()

    expect(launchClaudeNewSession).toHaveBeenCalled()
    expect(runTmuxInvocation).not.toHaveBeenCalled()
    expect(respawnClaudePane).not.toHaveBeenCalled()
  })

  it('confirms the spec feeds through the builder with the exact field shape recorded by the fixture site-5-worker', () => {
    setSpecStub()
    delete process.env.WEB_ONLY
    startWorkerSession()

    const calls = (buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mock.calls
    expect(calls.length).toBeGreaterThanOrEqual(1)
    // Every spec passed to buildClaudeLaunchSpec has site=site-5-worker and
    // uses the model getter, so the value lands in the input object that the
    // builder would compile into a `--model` flag.
    for (const call of calls) {
      const spec = call[0]
      expect(spec.site).toBe('site-5-worker')
      // The makeWorkerCtx assigns configDir = join(homeDir, '.claude-config').
      // Verify that isolatedConfigDir passed to the spec matches the
      // WorkerCtx's derived configDir (the worker uses an isolated CLAUDE_CONFIG_DIR).
      const expectedConfigDir = `${spec.cwd}/.claude-config`
      expect(spec.isolatedConfigDir).toBe(expectedConfigDir)
    }
  })
})
