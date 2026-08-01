// Call-site coverage test: src/web/channel-monitor.ts (stage 1).
//
// Stage 1 = `respawnMainSessionFresh` (fresh respawn-pane without --continue),
// driven from `auto-restart-runner.ts` on a maintenance timer. The migrated
// function calls `buildClaudeLaunchSpec({...})` and then
// `respawnClaudePane(spec, {...})`. This test mocks both and asserts the
// exact spec shape passed through.

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
  buildClaudeLaunchCmd: vi.fn(() => ({ args: ['mocked'], cmd: '<mocked-cmd>', followupPlan: { continueSession: false, hasChannel: false }, warnings: [] })),
  applyPostLaunchFollowups: vi.fn(),
}))

// Read extra-plugin IDs from .env -- treat as empty by default
vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
  return { ...actual, existsSync: vi.fn(() => false), readFileSync: vi.fn(() => '') }
})

// Channel-monitor.ts imports a large graph from agent-process / channel-* / etc.
// We mock just the symbols the respawn path actually touches (everything the
// spec-input reads + the post-respawn followups chain).
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
import { respawnMainSessionFresh } from '../../web/channel-monitor.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('call-site: channel-monitor stage1 respawnMainSessionFresh (site-2-stage1)', () => {
  it('builds the spec via buildClaudeLaunchSpec with exact site-2-stage1 fields', () => {
    // Re-stub the passthrough after clearAllMocks erased it
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
      mcpBatch: input.mcpBatch,
      promptSuggestionGuard: input.promptSuggestionGuard,
      scrubChannelTokens: input.scrubChannelTokens,
      detectSandbox: input.detectSandbox,
      detectAvxLess: input.detectAvxLess,
      pathPreset: input.pathPreset ?? 'macos',
      pathTrailingInherit: input.pathTrailingInherit ?? false,
      followups: input.followups ?? {},
    }))

    respawnMainSessionFresh()

    expect(buildClaudeLaunchSpec).toHaveBeenCalledTimes(1)
    const spec = (buildClaudeLaunchSpec as ReturnType<typeof vi.fn>).mock.calls[0][0]

    // Field-by-field assertions.
    expect(spec.site).toBe('site-2-stage1')
    expect(typeof spec.session).toBe('string')
    expect(spec.session.length).toBeGreaterThan(0)
    expect(spec.session.endsWith('-channels')).toBe(true)
    expect(typeof spec.claudePath).toBe('string')
    expect(spec.claudePath.length).toBeGreaterThan(0)
    expect(spec.cwd).toBe(process.cwd())
    expect(spec.host).toEqual({ kind: 'local' })
    expect(spec.tmuxSubcommand).toBe('respawnPane')
    expect(spec.continueSession).toBe(false)
    expect(typeof spec.pluginId).toBe('string')
    expect(spec.pluginId).toBe('telegram@claude-plugins-official')
    expect(Array.isArray(spec.extraPluginIds)).toBe(true)
    // main path-isolated config: none in this unit since the mock returned null
    // (the source uses `ensureMainAgentIsolatedConfigDir() ?? undefined` only in
    // site-3 + site-4; site-2 forwards the value verbatim, so a mocked null
    // arrives here as `null`. Tolerate either null OR undefined for parity with
    // the source's per-site behavior.)
    expect([null, undefined]).toContain(spec.isolatedConfigDir)
    expect(spec.fleetOauthToken).toBeUndefined()
    expect(spec.cwdAsCd).toBe(false) // respawn-pane inherits pane cwd
    expect(spec.mcpBatch).toBe('always')
    expect(spec.promptSuggestionGuard).toBe(true)
    expect(spec.scrubChannelTokens).toBe(false)
    expect(spec.detectSandbox).toBe(false)
    expect(spec.detectAvxLess).toBe(false)
    expect(spec.pathPreset).toBe('linux')
    expect(spec.pathTrailingInherit).toBe(true)

    // Followup bag
    expect(spec.followups.writeRespawnStamp).toBe(true)
    expect(spec.followups.identitySetup).toBeDefined()
    expect(typeof spec.followups.identitySetup!.displayName).toBe('string')
    expect(spec.followups.pluginUnlock).toBe(true)
    expect(spec.followups.postResumePluginGuard).toBe(false)
    expect(spec.followups.dismissResumeSummaryModal).toBe(false)
    expect(spec.followups.reapOrphans).toBe('channel-both')
    expect(spec.followups.reSeedOnboarding).toBe(true)
    expect(spec.followups.onFailureLog).toContain('tmux respawn-pane failed')
  })

  it('invokes respawnClaudePane(spec, { provider, agentDir }) with the canned spec', () => {
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
    respawnMainSessionFresh()

    expect(respawnClaudePane).toHaveBeenCalledTimes(1)
    const callArgs = (respawnClaudePane as ReturnType<typeof vi.fn>).mock.calls[0]
    const passedSpec = callArgs[0]
    const passedCtx = callArgs[1]
    expect(passedSpec.site).toBe('site-2-stage1')
    expect(passedCtx).toBeDefined()
    expect(passedCtx.provider).toBe('telegram')
    expect(passedCtx.agentDir).toBe(process.cwd())
  })

  it('DOES NOT use the legacy runTmuxInvocation / launchClaudeNewSession helpers (stage-1 uses respawnClaudePane)', () => {
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
    respawnMainSessionFresh()

    expect(respawnClaudePane).toHaveBeenCalled()
    expect(runTmuxInvocation).not.toHaveBeenCalled()
    expect(launchClaudeNewSession).not.toHaveBeenCalled()
  })
})
