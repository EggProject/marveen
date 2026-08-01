import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the helpers BEFORE importing the module under test.
vi.mock('../web/agent-process.js', async () => {
  const actual = await vi.importActual<typeof import('../web/agent-process.js')>('../web/agent-process.js')
  return {
    ...actual,
    ensureSharedClaudeOnboarded: vi.fn(() => true),
    scheduleIdentitySetup: vi.fn(async () => undefined),
    dismissResumeSummaryModalIfPresent: vi.fn(async () => undefined),
  }
})

vi.mock('../web/channel-plugin-unlock.js', () => ({
  schedulePluginUnlockAfterRespawn: vi.fn(),
}))

vi.mock('../web/channel-monitor.js', () => ({
  writeRespawnStamp: vi.fn(),
  schedulePostResumePluginGuard: vi.fn(),
}))

vi.mock('../web/agent-worker.js', () => ({
  logWorkerClaudeVersion: vi.fn(),
}))

import {
  applyPostLaunchFollowups,
  buildClaudeLaunchSpec,
  buildClaudeLaunchCmd,
  type ClaudeLaunchSpec,
  type ClaudeLaunchFollowupPlan,
} from '../web/claude-launch.js'
import * as agentProcess from '../web/agent-process.js'
import * as channelPluginUnlock from '../web/channel-plugin-unlock.js'
import * as channelMonitor from '../web/channel-monitor.js'
import * as agentWorker from '../web/agent-worker.js'

beforeEach(() => {
  vi.clearAllMocks()
})

const baseSpec = (): ClaudeLaunchSpec => buildClaudeLaunchSpec({
  site: 'site-2-stage1',
  session: 'marveen-channels',
  claudePath: '/opt/homebrew/bin/claude',
  cwd: '/Users/eggp/marveen',
  host: { kind: 'local' },
  tmuxSubcommand: 'respawnPane',
  model: 'MiniMax-M3[1m]',
  pluginId: 'telegram@claude-plugins-official',
})

function planFromSpec(spec: ClaudeLaunchSpec): ClaudeLaunchFollowupPlan {
  return buildClaudeLaunchCmd(spec).followupPlan
}

describe('applyPostLaunchFollowups runtime paired-guard', () => {
  it('throws when continueSession=true && hasChannel && postResumePluginGuard=false', () => {
    const base = baseSpec()
    const spec = { ...base, continueSession: true, followups: { postResumePluginGuard: false, dismissResumeSummaryModal: true } }
    const plan = planFromSpec(spec)
    expect(() => applyPostLaunchFollowups(plan, { provider: 'telegram', session: 's' })).toThrow(/continueSession.*hasChannel/)
  })

  it('does NOT throw when postResumePluginGuard=true', () => {
    const base = baseSpec()
    const spec = { ...base, continueSession: true, followups: { postResumePluginGuard: true } }
    const plan = planFromSpec(spec)
    expect(() => applyPostLaunchFollowups(plan, { provider: 'telegram', session: 's' })).not.toThrow()
  })

  it('does NOT throw when there is no channel', () => {
    const base = baseSpec()
    const spec = { ...base, pluginId: undefined, continueSession: true, followups: { postResumePluginGuard: false } }
    const plan = planFromSpec(spec)
    expect(() => applyPostLaunchFollowups(plan, { session: 's' })).not.toThrow()
  })

  it('does NOT throw when continueSession=false', () => {
    const base = baseSpec()
    const spec = { ...base, continueSession: false, followups: { postResumePluginGuard: false } }
    const plan = planFromSpec(spec)
    expect(() => applyPostLaunchFollowups(plan, { provider: 'telegram', session: 's' })).not.toThrow()
  })
})

describe('applyPostLaunchFollowups dispatches each helper', () => {
  it('writeRespawnStamp → channelMonitor.writeRespawnStamp', async () => {
    const plan: ClaudeLaunchFollowupPlan = { ...planFromSpec(baseSpec()), writeRespawnStamp: true }
    applyPostLaunchFollowups(plan, {})
    await new Promise((r) => setImmediate(r))
    expect(channelMonitor.writeRespawnStamp).toHaveBeenCalledTimes(1)
  })

  it('identitySetup → agentProcess.scheduleIdentitySetup with displayName + session', async () => {
    const base = baseSpec()
    const spec = { ...base, followups: { identitySetup: { displayName: 'EggProjectTeams', host: 'laptop' } } }
    applyPostLaunchFollowups(planFromSpec(spec), { session: 's' })
    await new Promise((r) => setImmediate(r))
    expect(agentProcess.scheduleIdentitySetup).toHaveBeenCalledWith('s', 'EggProjectTeams', 'laptop')
  })

  it('identitySetup falls back to ctx.host when identitySetup.host is undefined', async () => {
    const base = baseSpec()
    const spec = { ...base, followups: { identitySetup: { displayName: 'EggProjectTeams' } } }
    applyPostLaunchFollowups(planFromSpec(spec), { session: 's', host: 'from-ctx' })
    await new Promise((r) => setImmediate(r))
    expect(agentProcess.scheduleIdentitySetup).toHaveBeenCalledWith('s', 'EggProjectTeams', 'from-ctx')
  })

  it('identitySetup.host undefined AND ctx.host undefined → scheduleIdentitySetup called with null', async () => {
    const base = baseSpec()
    const spec = { ...base, followups: { identitySetup: { displayName: 'EggProjectTeams' } } }
    applyPostLaunchFollowups(planFromSpec(spec), { session: 's' })
    await new Promise((r) => setImmediate(r))
    expect(agentProcess.scheduleIdentitySetup).toHaveBeenCalledWith('s', 'EggProjectTeams', null)
  })

  it('pluginUnlock → channelPluginUnlock.schedulePluginUnlockAfterRespawn', async () => {
    const base = baseSpec()
    const spec = { ...base, followups: { pluginUnlock: true } }
    applyPostLaunchFollowups(planFromSpec(spec), { provider: 'telegram', session: 's' })
    await new Promise((r) => setImmediate(r))
    expect(channelPluginUnlock.schedulePluginUnlockAfterRespawn).toHaveBeenCalledWith('s', 'telegram')
  })

  it('postResumePluginGuard → channelMonitor.schedulePostResumePluginGuard', async () => {
    const base = baseSpec()
    const spec = { ...base, followups: { postResumePluginGuard: true } }
    applyPostLaunchFollowups(planFromSpec(spec), { provider: 'slack', session: 's' })
    await new Promise((r) => setImmediate(r))
    expect(channelMonitor.schedulePostResumePluginGuard).toHaveBeenCalledWith('slack')
  })

  it('dismissResumeSummaryModal + continueSession → agentProcess.dismissResumeSummaryModalIfPresent', async () => {
    const base = baseSpec()
    const spec = { ...base, continueSession: true, followups: { dismissResumeSummaryModal: true, postResumePluginGuard: true } }
    applyPostLaunchFollowups(planFromSpec(spec), { session: 's', host: null })
    await new Promise((r) => setImmediate(r))
    expect(agentProcess.dismissResumeSummaryModalIfPresent).toHaveBeenCalledWith('s', null)
  })

  it('dismissResumeSummaryModal without continueSession → does NOT dismiss', async () => {
    const base = baseSpec()
    const spec = { ...base, continueSession: false, followups: { dismissResumeSummaryModal: true } }
    applyPostLaunchFollowups(planFromSpec(spec), { session: 's' })
    await new Promise((r) => setImmediate(r))
    expect(agentProcess.dismissResumeSummaryModalIfPresent).not.toHaveBeenCalled()
  })

  it('logClaudeVersion + agentDir → agentWorker.logWorkerClaudeVersion', async () => {
    const base = baseSpec()
    const spec = { ...base, followups: { logClaudeVersion: true } }
    applyPostLaunchFollowups(planFromSpec(spec), { agentDir: '/Users/eggp/marveen/agents/boni' })
    await new Promise((r) => setImmediate(r))
    expect(agentWorker.logWorkerClaudeVersion).toHaveBeenCalledTimes(1)
    const callArg = (agentWorker.logWorkerClaudeVersion as ReturnType<typeof vi.fn>).mock.calls[0][0]
    expect(callArg.home).toBe('/Users/eggp/marveen/agents/boni')
  })

  it('helper throws are caught (logged, not re-thrown)', async () => {
    ;(channelMonitor.writeRespawnStamp as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('disk full')
    })
    const plan: ClaudeLaunchFollowupPlan = { ...planFromSpec(baseSpec()), writeRespawnStamp: true }
    applyPostLaunchFollowups(plan, {})
    await new Promise((r) => setImmediate(r))
    // No re-throw; the call just gets logged.
    expect(channelMonitor.writeRespawnStamp).toHaveBeenCalledTimes(1)
  })
})

describe('applyPostLaunchFollowups: empty plan does nothing', () => {
  it('default plan invokes zero helpers', async () => {
    const plan = planFromSpec(baseSpec())
    applyPostLaunchFollowups(plan, { provider: 'telegram', session: 's' })
    await new Promise((r) => setImmediate(r))
    expect(channelMonitor.writeRespawnStamp).not.toHaveBeenCalled()
    expect(agentProcess.scheduleIdentitySetup).not.toHaveBeenCalled()
    expect(channelPluginUnlock.schedulePluginUnlockAfterRespawn).not.toHaveBeenCalled()
    expect(channelMonitor.schedulePostResumePluginGuard).not.toHaveBeenCalled()
    expect(agentProcess.dismissResumeSummaryModalIfPresent).not.toHaveBeenCalled()
    expect(agentWorker.logWorkerClaudeVersion).not.toHaveBeenCalled()
  })
})

describe('buildClaudeLaunchCmd emits missing-post-resume-plugin-guard warning', () => {
  it('warns on continueSession+pluginId without guard', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-3-stage3',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'respawnPane',
      model: 'MiniMax-M3[1m]',
      pluginId: 'telegram@claude-plugins-official',
      continueSession: true,
      followups: { postResumePluginGuard: false },
    })
    expect(buildClaudeLaunchCmd(spec).warnings).toContain('missing-post-resume-plugin-guard')
  })
})