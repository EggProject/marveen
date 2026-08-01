import { describe, it, expect, vi, beforeEach } from 'vitest'

// Mock the helpers BEFORE importing the module under test.
vi.mock('../web/agent-process.js', async () => {
  const actual = await vi.importActual<typeof import('../web/agent-process.js')>('../web/agent-process.js')
  return {
    ...actual,
    runTmux: vi.fn(),
    ensureSharedClaudeOnboarded: vi.fn(() => true),
  }
})

vi.mock('../web/channel-poller-reap.js', () => ({
  reapChannelOrphans: vi.fn(),
  reapDetachedChannelClaudes: vi.fn(() => []),
}))

import {
  buildClaudeLaunchSpec,
  runTmuxInvocation,
  launchClaudeNewSession,
  respawnClaudePane,
  type ClaudeLaunchSpec,
} from '../web/claude-launch.js'
import * as agentProcess from '../web/agent-process.js'
import * as channelPollerReap from '../web/channel-poller-reap.js'

beforeEach(() => {
  vi.clearAllMocks()
})

const baseNewSession = (): ClaudeLaunchSpec => buildClaudeLaunchSpec({
  site: 'site-2-stage1',
  session: 'agent-test',
  claudePath: '/opt/homebrew/bin/claude',
  cwd: '/Users/eggp/marveen',
  host: { kind: 'local' },
  tmuxSubcommand: 'newSession',
  model: 'MiniMax-M3[1m]',
  pluginId: 'telegram@claude-plugins-official',
  followups: { postResumePluginGuard: true },
})

const baseRespawn = (): ClaudeLaunchSpec => buildClaudeLaunchSpec({
  site: 'site-3-stage3',
  session: 'marveen-channels',
  claudePath: '/opt/homebrew/bin/claude',
  cwd: '/Users/eggp/marveen',
  host: { kind: 'local' },
  tmuxSubcommand: 'respawnPane',
  model: 'MiniMax-M3[1m]',
  pluginId: 'telegram@claude-plugins-official',
  followups: { postResumePluginGuard: true },
})

describe('runTmuxInvocation routing', () => {
  it('local host → runTmux called with null host', () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined)
    const spec = baseNewSession()
    const r = runTmuxInvocation(spec)
    expect(r.ok).toBe(true)
    const call = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe(null)
    expect(call[1][0]).toBe('new-session')
    expect(call[1][1]).toBe('-d')
    expect(call[1][2]).toBe('-s')
    expect(call[1][3]).toBe('agent-test')
  })

  it('ssh host → runTmux called with non-null host + longer timeout', () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined)
    const spec = buildClaudeLaunchSpec({
      site: 'site-7-subagent-ssh',
      session: 'agent-ssh',
      claudePath: 'claude',
      cwd: '/home/user/work',
      host: { kind: 'remote-ssh', sshTarget: 'laptop', workdir: '/home/user/work' },
      tmuxSubcommand: 'newSession',
      model: 'MiniMax-M3[1m]',
    })
    runTmuxInvocation(spec)
    const call = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[0]).toBe('laptop')
    expect(call[2].timeout).toBe(8000)
  })

  it('local host → timeout is 10000', () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValueOnce(undefined)
    runTmuxInvocation(baseNewSession())
    const call = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(call[2].timeout).toBe(10000)
  })

  it('runTmux throws → { ok: false, error } returned with .stderr', () => {
    const err = Object.assign(new Error('tmux: no server'), { stderr: 'no server running' })
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw err
    })
    const r = runTmuxInvocation(baseNewSession())
    expect(r.ok).toBe(false)
    expect(r.error).toBe('no server running')
  })

  it('runTmux throws (no stderr) → { ok: false, error: message } returned', () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('boom')
    })
    const r = runTmuxInvocation(baseNewSession())
    expect(r.ok).toBe(false)
    expect(r.error).toBe('boom')
  })

  it('runTmux throws a non-Error object → { ok: false, error: String(err) } returned', () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw 'string-error'
    })
    const r = runTmuxInvocation(baseNewSession())
    expect(r.ok).toBe(false)
    expect(r.error).toBe('string-error')
  })
})

describe('launchClaudeNewSession', () => {
  it('calls runTmux with new-session args', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const r = await launchClaudeNewSession(baseNewSession(), { provider: 'telegram', session: 'agent-test' })
    expect(r.ok).toBe(true)
    const calls = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1][0])
    expect(calls).toContain('new-session')
  })

  it('rejects with error when tmuxSubcommand !== newSession', async () => {
    const spec = baseRespawn()
    const r = await launchClaudeNewSession(spec)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('newSession')
  })

  it('reapOrphans=channel-both → reapChannelOrphans + reapDetachedChannelClaudes called BEFORE main runTmux', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reapOrphans: 'channel-both' as const } }
    await launchClaudeNewSession(spec, { provider: 'telegram', session: 's', agentDir: '/Users/eggp/marveen/agents/boni' })
    expect(channelPollerReap.reapChannelOrphans).toHaveBeenCalledWith('telegram', '/Users/eggp/marveen/agents/boni')
    expect(channelPollerReap.reapDetachedChannelClaudes).toHaveBeenCalled()
  })

  it('reapOrphans not channel-both → reap not invoked', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reapOrphans: 'none' as const } }
    await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(channelPollerReap.reapChannelOrphans).not.toHaveBeenCalled()
  })

  it('launchClaudeNewSession with raw spec (followups undefined) → runPreSteps tolerates missing followups', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    // Raw spec literal: NO buildClaudeLaunchSpec defaulting, followups is
    // literally undefined. Exercises the defensive `spec.followups ?? {}`
    // branch in runPreSteps.
    const spec: ClaudeLaunchSpec = {
      site: 'site-2-stage1',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'newSession',
      // followups intentionally absent (undefined) for the defensive-branch test
    }
    const r = await launchClaudeNewSession(spec, { session: 's' })
    expect(r.ok).toBe(true)
  })

  it('reapChannelOrphans throws → caught (best-effort)', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    ;(channelPollerReap.reapChannelOrphans as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('reap failed')
    })
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reapOrphans: 'channel-both' as const } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's', agentDir: '/Users/eggp/marveen/agents/boni' })
    expect(r.ok).toBe(true)
  })

  it('reapOrphans=channel-both but ctx.agentDir undefined → safeReap falls back to process.cwd()', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reapOrphans: 'channel-both' as const } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(true)
    expect(channelPollerReap.reapChannelOrphans).toHaveBeenCalledWith('telegram', expect.any(String))
  })

  it('reapOrphans=channel-both but no ctx.provider AND no channelEnv.provider → reap skipped', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const spec = buildClaudeLaunchSpec({
      site: 'site-2-stage1',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'newSession',
      followups: { reapOrphans: 'channel-both', postResumePluginGuard: true },
    })
    const r = await launchClaudeNewSession(spec, { session: 's' })
    expect(r.ok).toBe(true)
    expect(channelPollerReap.reapChannelOrphans).not.toHaveBeenCalled()
  })

  it('reapOrphans=channel-both + ctx.provider missing + channelEnv.provider set → resolveProvider falls back to spec', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const spec = buildClaudeLaunchSpec({
      site: 'site-6-subagent-local',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'newSession',
      channelEnv: { provider: 'telegram', stateDirVar: 'TELEGRAM_STATE_DIR', stateDir: '/tmp/x' },
      followups: { reapOrphans: 'channel-both', postResumePluginGuard: true },
    })
    const r = await launchClaudeNewSession(spec, { session: 's', agentDir: '/tmp/agent' })
    expect(r.ok).toBe(true)
    expect(channelPollerReap.reapChannelOrphans).toHaveBeenCalledWith('telegram', '/tmp/agent')
  })

  it('reapDetachedChannelClaudes throws → caught (best-effort)', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    ;(channelPollerReap.reapDetachedChannelClaudes as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('detached reap failed')
    })
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reapOrphans: 'channel-both' as const } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's', agentDir: '/Users/eggp/marveen/agents/boni' })
    expect(r.ok).toBe(true)
  })

  it('reSeedOnboarding=true → ensureSharedClaudeOnboarded called', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reSeedOnboarding: true } }
    await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(agentProcess.ensureSharedClaudeOnboarded).toHaveBeenCalled()
  })

  it('reSeedOnboarding=false (default) → ensureSharedClaudeOnboarded NOT called', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reSeedOnboarding: false } }
    await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(agentProcess.ensureSharedClaudeOnboarded).not.toHaveBeenCalled()
  })

  it('reSeedOnboarding=true + ensureSharedClaudeOnboarded throws → caught (best-effort)', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    ;(agentProcess.ensureSharedClaudeOnboarded as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('onboard failed')
    })
    const base = baseNewSession()
    const spec = { ...base, followups: { ...base.followups, reSeedOnboarding: true } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(true)
  })

  it('newSession → kill-session called BEFORE new-session', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    await launchClaudeNewSession(baseNewSession(), { provider: 'telegram', session: 's' })
    const calls = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const killIdx = calls.findIndex((c) => c[0] === 'kill-session')
    const newIdx = calls.findIndex((c) => c[0] === 'new-session')
    expect(killIdx).toBeGreaterThan(-1)
    expect(newIdx).toBeGreaterThan(-1)
    expect(killIdx).toBeLessThan(newIdx)
  })

  it('runTmux throws → { ok: false, error } returned, no applyPostLaunchFollowups (helper not called)', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementation(() => {
      throw new Error('kill-session failed')
    })
    const r = await launchClaudeNewSession(baseNewSession(), { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(false)
  })

  it('runTmux throws inside kill-session → continue (caller swallows)', async () => {
    let callIdx = 0
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callIdx++
      if (callIdx === 1) throw new Error('no session')
      return undefined
    })
    const r = await launchClaudeNewSession(baseNewSession(), { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(true)
  })

  it('tmuxServerPrep.startServer → start-server is called BEFORE new-session', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseNewSession()
    const spec = { ...base, tmuxServerPrep: { startServer: true, unsetGlobalEnv: ['TELEGRAM_BOT_TOKEN'], setGlobalEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'xxx' } } }
    await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    const calls = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const startIdx = calls.findIndex((c) => c[0] === 'start-server')
    const unsetIdx = calls.findIndex((c) => c[0] === 'set-environment' && c[2] === '-u')
    const setIdx = calls.findIndex((c) => c[0] === 'set-environment' && c[2] === 'CLAUDE_CODE_OAUTH_TOKEN')
    const newIdx = calls.findIndex((c) => c[0] === 'new-session')
    expect(startIdx).toBeGreaterThan(-1)
    expect(unsetIdx).toBeGreaterThan(-1)
    expect(setIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeLessThan(unsetIdx)
    expect(unsetIdx).toBeLessThan(setIdx)
    expect(setIdx).toBeLessThan(newIdx)
  })

  it('tmuxServerPrep with only setGlobalEnv (no startServer) still works', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseNewSession()
    const spec = { ...base, tmuxServerPrep: { setGlobalEnv: { FOO: 'bar' } } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(true)
    const calls = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(calls.some((c) => c[0] === 'set-environment' && c[2] === 'FOO')).toBe(true)
  })

  it('tmuxServerPrep prep call throws → continue (best-effort)', async () => {
    let callIdx = 0
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callIdx++
      if (callIdx === 1) throw new Error('start-server failed')
      return undefined
    })
    const base = baseNewSession()
    const spec = { ...base, tmuxServerPrep: { startServer: true } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(true)
  })

  it('tmuxServerPrep.unsetGlobalEnv call throws → continue (best-effort)', async () => {
    let callIdx = 0
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callIdx++
      // skip start-server (not in this prep), fail the unsetGlobalEnv call
      if (callIdx === 1) throw new Error('unset failed')
      return undefined
    })
    const base = baseNewSession()
    const spec = { ...base, tmuxServerPrep: { unsetGlobalEnv: ['TELEGRAM_BOT_TOKEN'] } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(true)
  })

  it('tmuxServerPrep.setGlobalEnv call throws → continue (best-effort)', async () => {
    let callIdx = 0
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callIdx++
      // skip start-server, fail the setGlobalEnv call
      if (callIdx === 1) throw new Error('set failed')
      return undefined
    })
    const base = baseNewSession()
    const spec = { ...base, tmuxServerPrep: { setGlobalEnv: { FOO: 'bar' } } }
    const r = await launchClaudeNewSession(spec, { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(true)
  })
})

describe('respawnClaudePane', () => {
  it('calls runTmux with respawn-pane args including -k', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const r = await respawnClaudePane(baseRespawn(), { provider: 'telegram', session: 'marveen-channels' })
    expect(r.ok).toBe(true)
    const calls = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const respawn = calls.find((c) => c[0] === 'respawn-pane')
    expect(respawn).toBeDefined()
    expect(respawn![1]).toBe('-k')
    expect(respawn![2]).toBe('-t')
    expect(respawn![3]).toBe('marveen-channels')
  })

  it('rejects with error when tmuxSubcommand !== respawnPane', async () => {
    const spec = baseNewSession()
    const r = await respawnClaudePane(spec)
    expect(r.ok).toBe(false)
    expect(r.error).toContain('respawnPane')
  })

  it('does NOT call kill-session before respawn-pane', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    await respawnClaudePane(baseRespawn(), { provider: 'telegram', session: 's' })
    const calls = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    expect(calls.some((c) => c[0] === 'kill-session')).toBe(false)
  })

  it('still runs tmuxServerPrep BEFORE respawn-pane', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockReturnValue(undefined)
    const base = baseRespawn()
    const spec = { ...base, tmuxServerPrep: { startServer: true, unsetGlobalEnv: ['TELEGRAM_BOT_TOKEN'] } }
    await respawnClaudePane(spec, { provider: 'telegram', session: 's' })
    const calls = (agentProcess.runTmux as ReturnType<typeof vi.fn>).mock.calls.map((c) => c[1])
    const startIdx = calls.findIndex((c) => c[0] === 'start-server')
    const respawnIdx = calls.findIndex((c) => c[0] === 'respawn-pane')
    expect(startIdx).toBeGreaterThan(-1)
    expect(respawnIdx).toBeGreaterThan(-1)
    expect(startIdx).toBeLessThan(respawnIdx)
  })

  it('runTmux throws → { ok: false, error }', async () => {
    ;(agentProcess.runTmux as ReturnType<typeof vi.fn>).mockImplementationOnce(() => {
      throw new Error('respawn-pane failed')
    })
    const r = await respawnClaudePane(baseRespawn(), { provider: 'telegram', session: 's' })
    expect(r.ok).toBe(false)
  })
})