// Call-site coverage test: src/web/channel-monitor.ts (stage 3).
//
// Stage 3 = `resumeMarveenSession` (--continue respawn-pane; preserves the
// conversation context). The migrated function builds a ClaudeLaunchSpec and
// calls `respawnClaudePane(spec, { provider, agentDir })`. This test asserts
// the exact spec shape (site-3-stage3, with continueSession=true) and that
// the legacy code paths are NOT executed.

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
  buildClaudeLaunchCmd: vi.fn(() => ({ args: ['mocked'], cmd: '<mocked-cmd>', followupPlan: { continueSession: true, hasChannel: true }, warnings: [] })),
  applyPostLaunchFollowups: vi.fn(),
}))

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '') }
})

vi.mock('../../web/agent-process.js', () => ({
  ensureMainAgentIsolatedConfigDir: vi.fn(() => null),
  hasFleetOauthToken: vi.fn(() => false),
  ensureSharedClaudeOnboarded: vi.fn(() => true),
  scheduleIdentitySetup: vi.fn(),
  FLEET_OAUTH_TOKEN_PATH: '/tmp/mock-fleet-oauth-token',
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

import { buildClaudeLaunchSpec, respawnClaudePane, runTmuxInvocation, launchClaudeNewSession } from '../../web/claude-launch.js'
import { resumeMarveenSession } from '../../web/channel-monitor.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('call-site: channel-monitor stage3 resumeMarveenSession (site-3-stage3)', () => {
  it('builds the spec with continueSession=true and the followup bag has postResumePluginGuard + dismissResumeSummaryModal', async () => {
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

    const ok = await resumeMarveenSession()
    expect(ok).toBe(true)

    expect(buildClaudeLaunchSpec).toHaveBeenCalledTimes(1)
    const spec = (buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mock.calls[0][0]

    expect(spec.site).toBe('site-3-stage3')
    expect(spec.tmuxSubcommand).toBe('respawnPane')
    expect(spec.continueSession).toBe(true) // <-- THE stage-3 discriminator
    expect(spec.cwdAsCd).toBe(false)
    expect(spec.mcpBatch).toBe('always')
    expect(spec.promptSuggestionGuard).toBe(true)
    expect(spec.pathPreset).toBe('linux')
    expect(spec.pathTrailingInherit).toBe(true)
    expect(typeof spec.pluginId).toBe('string')

    // Followup bag: stage-3 differs from stage-1 on postResumePluginGuard +
    // dismissResumeSummaryModal -- both must be ON for the --continue path.
    expect(spec.followups.writeRespawnStamp).toBe(true)
    expect(spec.followups.pluginUnlock).toBe(true)
    expect(spec.followups.postResumePluginGuard).toBe(true) // <-- stage-3 discriminator
    expect(spec.followups.dismissResumeSummaryModal).toBe(true) // <-- stage-3 discriminator
    expect(spec.followups.reapOrphans).toBe('channel-both')
    expect(spec.followups.reSeedOnboarding).toBe(true)
    expect(spec.followups.onFailureLog).toContain('tmux respawn-pane failed')
  })

  it('invokes respawnClaudePane with the expected context', async () => {
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
    await resumeMarveenSession()

    expect(respawnClaudePane).toHaveBeenCalledTimes(1)
    const callArgs = (respawnClaudePane as ReturnType<typeof vi.fn>).mock.calls[0]
    const passedSpec = callArgs[0]
    const passedCtx = callArgs[1]
    expect(passedSpec.site).toBe('site-3-stage3')
    expect(passedSpec.continueSession).toBe(true)
    expect(passedCtx.provider).toBe('telegram')
    expect(passedCtx.agentDir).toBe(process.cwd())
  })

  it('returns false and logs the failure when respawnClaudePane fails (regression)', async () => {
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
    ;(respawnClaudePane as ReturnType<typeof vi.fn>).mockImplementationOnce(() =>
      Promise.resolve({ ok: false, error: 'tmux respawn-pane failed' }),
    )
    const ok = await resumeMarveenSession()
    expect(ok).toBe(false)
  })

  it('DOES NOT use the legacy runTmuxInvocation / launchClaudeNewSession helpers', async () => {
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
    await resumeMarveenSession()

    expect(respawnClaudePane).toHaveBeenCalled()
    expect(runTmuxInvocation).not.toHaveBeenCalled()
    expect(launchClaudeNewSession).not.toHaveBeenCalled()
  })
})
