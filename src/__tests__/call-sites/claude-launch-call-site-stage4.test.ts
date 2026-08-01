// Call-site coverage test: src/web/channel-monitor.ts (stage 4).
//
// Stage 4 = `respawnMarveenSessionFresh` (private function on line 849).
// The migrated path uses the SYNC `runTmuxInvocation(spec)` (not
// respawnClaudePane) so the hard-restart fallback can keep its synchronous
// "did the respawn succeed" contract.
//
// The function itself is not exported, but it is reached on Linux via the
// exported `hardRestartMarveenChannels()`. We force Linux + an absent
// launchd plist so the function under test is the one that runs.

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
    mcpBatch: input.mcpBatch,
    promptSuggestionGuard: input.promptSuggestionGuard,
    scrubChannelTokens: input.scrubChannelTokens,
    detectSandbox: input.detectSandbox,
    detectAvxLess: input.detectAvxLess,
    pathPreset: input.pathPreset ?? 'macos',
    pathTrailingInherit: input.pathTrailingInherit ?? false,
    followups: input.followups ?? {},
  })),
  respawnClaudePane: vi.fn(() => Promise.resolve({ ok: true })),
  runTmuxInvocation: vi.fn(() => ({ ok: true })),
  launchClaudeNewSession: vi.fn(),
  buildClaudeLaunchCmd: vi.fn(() => ({ args: ['mocked'], cmd: '<mocked-cmd>', followupPlan: { continueSession: false, hasChannel: true }, warnings: [] })),
  applyPostLaunchFollowups: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '') }
})

vi.mock('node:child_process', () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
  spawn: vi.fn(() => ({ unref: vi.fn() })),
}))

vi.mock('../../platform.js', () => ({
  resolveFromPath: vi.fn(() => '/usr/local/bin/tmux'),
  tryResolveFromPath: vi.fn(() => '/usr/local/bin/tmux'),
}))

vi.mock('../../web/agent-process.js', () => ({
  ensureMainAgentIsolatedConfigDir: vi.fn(() => null),
  hasFleetOauthToken: vi.fn(() => false),
  ensureSharedClaudeOnboarded: vi.fn(() => true),
  scheduleIdentitySetup: vi.fn(),
  FLEET_OAUTH_TOKEN_PATH: '/tmp/mock-fleet-oauth-token',
  stampFableOverageConsentSharedRoots: vi.fn(),
}))

vi.mock('../../web/channel-plugin-unlock.js', () => ({
  schedulePluginUnlockAfterRespawn: vi.fn(),
  wasPluginConfirmedAbsent: vi.fn(() => false),
  clearPluginAbsent: vi.fn(),
}))

vi.mock('../../web/channel-provider.js', () => ({
  getProvider: vi.fn(() => ({ type: 'telegram', pluginId: 'telegram@claude-plugins-official' })),
  channelStateDir: vi.fn(() => '/tmp/mock-state-dir'),
  readChannelToken: vi.fn(() => null),
}))

vi.mock('../../web/agent-config.js', () => ({
  agentDir: vi.fn(() => '/tmp/mock-agent-dir'),
  listAgentNames: vi.fn(() => []),
  readAgentChannelProvider: vi.fn(() => null),
}))

vi.mock('../../web/channel-poller-reap.js', () => ({
  reapChannelOrphans: vi.fn(),
  reapDetachedChannelClaudes: vi.fn(() => []),
  collectPollerEvidence: vi.fn(() => ({})),
}))

vi.mock('../../notify.js', () => ({
  notifyChannel: vi.fn(() => Promise.resolve()),
}))

// Force process.platform to 'linux' so the launchctl branch is skipped entirely
// and the test reaches respawnMarveenSessionFresh via the export
// hardRestartMarveenChannels().
const originalPlatform = process.platform
beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})
afterEachRestore()

function afterEachRestore() {
  // nothing — the helper exists only to keep the call site near beforeEach
  // reading cleanly.
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true })
}

import { buildClaudeLaunchSpec, respawnClaudePane, runTmuxInvocation, launchClaudeNewSession } from '../../web/claude-launch.js'
import { hardRestartMarveenChannels } from '../../web/channel-monitor.js'

beforeEach(() => {
  vi.clearAllMocks()
  Object.defineProperty(process, 'platform', { value: 'linux', configurable: true })
})

describe('call-site: channel-monitor stage4 respawnMarveenSessionFresh (site-4-stage4)', () => {
  it('builds the spec with continueSession=false and routes through runTmuxInvocation (sync)', () => {
    ;(buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mockImplementation((input: any) => ({
      site: input.site, session: input.session, claudePath: input.claudePath, cwd: input.cwd,
      host: input.host, tmuxSubcommand: input.tmuxSubcommand, model: input.model,
      continueSession: input.continueSession, pluginId: input.pluginId,
      extraPluginIds: input.extraPluginIds ?? [], isolatedConfigDir: input.isolatedConfigDir,
      fleetOauthToken: input.fleetOauthToken, cwdAsCd: input.cwdAsCd ?? true,
      mcpBatch: input.mcpBatch, promptSuggestionGuard: input.promptSuggestionGuard,
      scrubChannelTokens: input.scrubChannelTokens, detectSandbox: input.detectSandbox,
      detectAvxLess: input.detectAvxLess, pathPreset: input.pathPreset ?? 'macos',
      pathTrailingInherit: input.pathTrailingInherit ?? false, followups: input.followups ?? {},
    }))
    ;(runTmuxInvocation as ReturnType<typeof vi.fn>).mockReturnValue({ ok: true })

    const r = hardRestartMarveenChannels()
    expect(r.ok).toBe(true)

    expect(buildClaudeLaunchSpec).toHaveBeenCalledTimes(1)
    const spec = (buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mock.calls[0][0]

    expect(spec.site).toBe('site-4-stage4')
    expect(spec.tmuxSubcommand).toBe('respawnPane')
    expect(spec.continueSession).toBe(false) // hard-restart NEVER --continues
    expect(spec.cwdAsCd).toBe(false)
    expect(spec.mcpBatch).toBe('always')
    expect(spec.promptSuggestionGuard).toBe(true)
    expect(spec.pathPreset).toBe('linux')
    expect(spec.pathTrailingInherit).toBe(true)
    expect(typeof spec.pluginId).toBe('string')

    // Followup bag: stage-4 is the hard-restart fallback. The followups chain
    // already covers the side-effects (writeRespawnStamp, identity, pluginUnlock)
    // inline; spec.followups flags must match (NONE of the resume-only side
    // effects: no postResumePluginGuard, no dismissResumeSummaryModal, no reSeed).
    expect(spec.followups.writeRespawnStamp).toBe(true)
    expect(spec.followups.pluginUnlock).toBe(true)
    expect(spec.followups.postResumePluginGuard).toBe(false)
    expect(spec.followups.dismissResumeSummaryModal).toBe(false)
    expect(spec.followups.reapOrphans).toBe('none')
    expect(spec.followups.reSeedOnboarding).toBe(false)
    expect(spec.followups.onFailureLog).toContain('hard restart failed')

    // runTmuxInvocation invoked EXACTLY ONCE with that spec.
    expect(runTmuxInvocation).toHaveBeenCalledTimes(1)
    const passedSpec = (runTmuxInvocation as ReturnType<typeof vi.fn>).mock.calls[0][0]
    // The mock passthrough returns a NEW spec for buildClaudeLaunchSpec, but
    // runTmuxInvocation receives the same object that was passed in. Confirm
    // by structural field equality on the site discriminator.
    expect(passedSpec.site).toBe(spec.site)
    expect(passedSpec.tmuxSubcommand).toBe(spec.tmuxSubcommand)
    expect(passedSpec.continueSession).toBe(spec.continueSession)
  })

  it('returns { ok: false } when runTmuxInvocation fails (failure path)', () => {
    ;(buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mockImplementation((input: any) => ({
      site: input.site, session: input.session, claudePath: input.claudePath, cwd: input.cwd,
      host: input.host, tmuxSubcommand: input.tmuxSubcommand, model: input.model,
      continueSession: input.continueSession, pluginId: input.pluginId,
      extraPluginIds: input.extraPluginIds ?? [], isolatedConfigDir: input.isolatedConfigDir,
      fleetOauthToken: input.fleetOauthToken, cwdAsCd: input.cwdAsCd ?? true,
      mcpBatch: input.mcpBatch, promptSuggestionGuard: input.promptSuggestionGuard,
      scrubChannelTokens: input.scrubChannelTokens, detectSandbox: input.detectSandbox,
      detectAvxLess: input.detectAvxLess, pathPreset: input.pathPreset ?? 'macos',
      pathTrailingInherit: input.pathTrailingInherit ?? false, followups: input.followups ?? {},
    }))
    ;(runTmuxInvocation as ReturnType<typeof vi.fn>).mockReturnValueOnce({ ok: false, error: 'tmux respawn-pane failed' })

    const r = hardRestartMarveenChannels()
    expect(r.ok).toBe(false)
    expect(r.error).toContain('tmux respawn-pane failed')
  })

  it('DOES NOT use respawnClaudePane / launchClaudeNewSession (stage-4 uses the sync runTmuxInvocation contract)', () => {
    ;(buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mockImplementation((input: any) => ({
      site: input.site, session: input.session, claudePath: input.claudePath, cwd: input.cwd,
      host: input.host, tmuxSubcommand: input.tmuxSubcommand, model: input.model,
      continueSession: input.continueSession, pluginId: input.pluginId,
      extraPluginIds: input.extraPluginIds ?? [], isolatedConfigDir: input.isolatedConfigDir,
      fleetOauthToken: input.fleetOauthToken, cwdAsCd: input.cwdAsCd ?? true,
      mcpBatch: input.mcpBatch, promptSuggestionGuard: input.promptSuggestionGuard,
      scrubChannelTokens: input.scrubChannelTokens, detectSandbox: input.detectSandbox,
      detectAvxLess: input.detectAvxLess, pathPreset: input.pathPreset ?? 'macos',
      pathTrailingInherit: input.pathTrailingInherit ?? false, followups: input.followups ?? {},
    }))
    hardRestartMarveenChannels()

    expect(runTmuxInvocation).toHaveBeenCalled()
    expect(respawnClaudePane).not.toHaveBeenCalled()
    expect(launchClaudeNewSession).not.toHaveBeenCalled()
  })
})
