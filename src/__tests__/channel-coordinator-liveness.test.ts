// Tests for src/channel-coordinator/liveness.ts.
//
// Coverage scope: every export + every branch of the liveness module:
//   - getClaudePidForSession (tmux + ps + pgrep + catch branches)
//   - decideHasPluginAlive (tree walk, bot.pid fallback, slack/discord cross-tree)
//   - snapshotProcsWithRetry (fast path, retry, double failure)
//   - probeChannelPluginLiveness (ps probe, state-dir read, unknown verdict paths)
//   - hasChannelPluginAlive (boolean wrapper)
//   - readRespawnStampMs (valid stamp, missing/unreadable, NaN/zero/negative)
//   - readKeepaliveAgeMs (present, missing/unreadable)
//   - decideNativeChannelDown (startup grace, plugin alive, keepalive stale)
//   - probeNativeChannelDown (full integration of all readers)
//
// Strategy: mock the heavy side-effecting imports (node:child_process,
// node:fs, node:os, platform, logger, config, channel-provider, web/agent-config,
// the sibling provider-poller-match) via `vi.doMock` with absolute paths
// (vitest resolves relative paths from the test file, which would not match
// the source's import resolution). Each test calls importFresh() to re-load
// the module against the freshly-mutated mocks.

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { join } from 'node:path'

const SRC_DIR = join(process.cwd(), 'src', 'channel-coordinator')
const SRC = join(SRC_DIR, 'liveness.ts')

// ---------------------------------------------------------------------------
// Mock registry -- one vi.fn per heavy dependency, mutated per test.
// ---------------------------------------------------------------------------

const m = {
  execFileSync: vi.fn(),
  existsSync: vi.fn(() => false),
  readFileSync: vi.fn(() => ''),
  statSync: vi.fn(() => ({ mtimeMs: 0 })),
  homedir: vi.fn(() => '/home/test'),
  loggerDebug: vi.fn(),
  loggerWarn: vi.fn(),
  loggerInfo: vi.fn(),
  loggerError: vi.fn(),
  resolveFromPath: vi.fn(() => '/usr/bin/tmux'),
  PROJECT_ROOT: '/project/root',
  channelStateDir: vi.fn(),
  agentDir: vi.fn(),
  matchesProviderPollerCmd: vi.fn(),
}

async function installMocks(): Promise<void> {
  vi.doMock('node:child_process', () => ({ execFileSync: m.execFileSync }))
  // Partial mock of node:fs: keep every real export, but replace the three
  // functions the liveness module reads. The on-disk sandbox tests below
  // use `mkdirSync` / `writeFileSync` from this module.
  vi.doMock('node:fs', async () => {
    const actual = await vi.importActual<typeof import('node:fs')>('node:fs')
    return {
      ...actual,
      existsSync: m.existsSync,
      readFileSync: m.readFileSync,
      statSync: m.statSync,
    }
  })
  vi.doMock('node:os', () => ({ homedir: m.homedir }))
  vi.doMock(join(SRC_DIR, '..', 'platform.js'), () => ({ resolveFromPath: m.resolveFromPath }))
  vi.doMock(join(SRC_DIR, '..', 'logger.js'), () => ({
    logger: {
      debug: m.loggerDebug,
      warn: m.loggerWarn,
      info: m.loggerInfo,
      error: m.loggerError,
    },
  }))
  vi.doMock(join(SRC_DIR, '..', 'config.js'), () => ({ PROJECT_ROOT: m.PROJECT_ROOT }))
  vi.doMock(join(SRC_DIR, '..', 'channel-provider.js'), () => ({ channelStateDir: m.channelStateDir }))
  vi.doMock(join(SRC_DIR, '..', 'web', 'agent-config.js'), () => ({ agentDir: m.agentDir }))
  vi.doMock(join(SRC_DIR, 'provider-poller-match.js'), () => ({ matchesProviderPollerCmd: m.matchesProviderPollerCmd }))
}

const importFresh = async () => {
  vi.resetModules()
  await installMocks()
  return import(SRC)
}

beforeEach(() => {
  vi.clearAllMocks()
  // Default matcher: real path-boundary matching against the standard slugs.
  m.matchesProviderPollerCmd.mockImplementation((cmd: string, provider: string) => {
    if (!cmd) return false
    if (!/\b(bun|node)\b/.test(cmd)) return false
    const slugRx: Record<string, RegExp> = {
      telegram: /\/telegram(?:\/|\s|$)/,
      slack: /\/slack(?:-channel)?(?:\/|\s|$)/,
      discord: /\/discord(?:\/|\s|$)/,
      googlechat: /\/googlechat(?:\/|\s|$)/,
      teams: /\/teams(?:\/|\s|$)/,
    }
    const rx = slugRx[provider]
    if (rx && rx.test(cmd)) return true
    if (provider === 'slack' && /\bsocket-mode\b/.test(cmd)) return true
    return false
  })
  m.channelStateDir.mockImplementation((provider: string, agentDir?: string) => {
    const base = agentDir ?? '/home/test/.claude/channels'
    return join(base, provider)
  })
  m.agentDir.mockImplementation((name: string) => `/project/root/agents/${name}`)
  m.existsSync.mockReturnValue(false)
  m.readFileSync.mockReturnValue('')
  m.statSync.mockReturnValue({ mtimeMs: 0 })
  m.execFileSync.mockReturnValue('')
})

// ---------------------------------------------------------------------------
// Synthetic `ps -axo pid,ppid,command` snapshots. The decider slices off the
// header line, so we always include one for fidelity with the live path.
// ---------------------------------------------------------------------------

const PS_HEADER = '  PID  PPID COMMAND'
function ps(rows: Array<{ pid: number; ppid: number; command: string }>): string {
  const body = rows.map(r => `${String(r.pid).padStart(5)} ${String(r.ppid).padStart(5)} ${r.command}`).join('\n')
  return PS_HEADER + '\n' + body
}

const CLAUDE_PID = 1000
const TELEGRAM_CMD =
  'bun run --cwd /home/test/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --shell=bun --silent start'
const SLACK_CMD =
  'node /home/test/.claude/plugins/marketplaces/marveen-marketplace/slack-channel/0.1.0/server.js'
const DISCORD_CMD =
  'bun run --cwd /home/test/.claude/plugins/cache/claude-plugins-official/discord/0.0.4 --silent start'

const ALL_PIDS_ALIVE = () => true
const NO_PIDS_ALIVE = () => false

// =========================================================================
// getClaudePidForSession
// =========================================================================

describe('getClaudePidForSession', () => {
  it('returns the pane_pid when ps -o comm matches "claude" (bare-name branch)', async () => {
    const { getClaudePidForSession } = await importFresh()
    m.execFileSync
      .mockReturnValueOnce(`${CLAUDE_PID}\n`)
      .mockReturnValueOnce('claude\n')
    expect(getClaudePidForSession('main')).toBe(CLAUDE_PID)
    expect(m.execFileSync).toHaveBeenCalledWith('/usr/bin/tmux', ['list-panes', '-t', 'main', '-F', '#{pane_pid}'], expect.objectContaining({ timeout: 3000 }))
    expect(m.execFileSync).toHaveBeenCalledWith('/bin/ps', ['-p', String(CLAUDE_PID), '-o', 'comm='], expect.objectContaining({ timeout: 3000 }))
  })

  it('returns the pane_pid when ps -o comm is "/claude" (absolute-path branch)', async () => {
    const { getClaudePidForSession } = await importFresh()
    m.execFileSync
      .mockReturnValueOnce(`${CLAUDE_PID}\n`)
      .mockReturnValueOnce('/opt/homebrew/bin/claude\n')
    expect(getClaudePidForSession('main')).toBe(CLAUDE_PID)
  })

  it('returns the grandchild pid via pgrep when pane_pid is not claude itself', async () => {
    const { getClaudePidForSession } = await importFresh()
    const CHILD = 2000
    m.execFileSync
      .mockReturnValueOnce(`${CHILD}\n`)
      .mockReturnValueOnce('bash\n')
      .mockReturnValueOnce(`${CLAUDE_PID}\n`)
    expect(getClaudePidForSession('main')).toBe(CLAUDE_PID)
    expect(m.execFileSync).toHaveBeenCalledWith('/usr/bin/pgrep', ['-P', String(CHILD), '-x', 'claude'], expect.objectContaining({ timeout: 3000 }))
  })

  it('returns null when pgrep finds nothing (the inner empty catch branch)', async () => {
    const { getClaudePidForSession } = await importFresh()
    m.execFileSync
      .mockReturnValueOnce(`${CLAUDE_PID}\n`)
      .mockReturnValueOnce('bash\n')
      .mockImplementationOnce(() => { throw new Error('nothing') })
    expect(getClaudePidForSession('main')).toBeNull()
  })

  it('returns null when the pane_pid is non-numeric (parseInt branch)', async () => {
    const { getClaudePidForSession } = await importFresh()
    m.execFileSync.mockReturnValueOnce('garbage\n')
    expect(getClaudePidForSession('main')).toBeNull()
  })

  it('returns null when tmux list-panes throws entirely (outer catch branch)', async () => {
    const { getClaudePidForSession } = await importFresh()
    m.execFileSync.mockImplementationOnce(() => { throw new Error('no session') })
    expect(getClaudePidForSession('main')).toBeNull()
  })
})

// =========================================================================
// decideHasPluginAlive -- the pure decider
// =========================================================================

describe('decideHasPluginAlive', () => {
  it('returns true when a direct child of claude matches the provider matcher', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 2000, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('descends through intermediate wrapper processes (grandchild match)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 1500, ppid: CLAUDE_PID, command: 'bun' },
      { pid: 2000, ppid: 1500, command: TELEGRAM_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('returns false when the claudePid is absent from ps', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const out = ps([{ pid: 2000, ppid: 1, command: TELEGRAM_CMD }])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('skips ps lines that do not match the pid/ppid/command regex (malformed row)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const out = PS_HEADER + '\n' +
      'garbage\n' +
      `${CLAUDE_PID} 1 claude\n` +
      `${2000} ${CLAUDE_PID} ${TELEGRAM_CMD}\n` +
      '   \n'
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('uses bot.pid fallback when the reparented orphan matches (alive path)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const ORPHAN = 4000
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: ORPHAN, ppid: 1, command: TELEGRAM_CMD },
    ])
    const events: Array<[string, Record<string, unknown>]> = []
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: ORPHAN, isPidAlive: ALL_PIDS_ALIVE,
      agentName: 'alpha',
      debugLog: (e, f) => events.push([e, f]),
    })).toBe(true)
    expect(events).toEqual([['plugin alive via bot.pid (reparented)', { claudePid: CLAUDE_PID, orphanPid: ORPHAN, agentName: 'alpha', providerType: 'telegram' }]])
  })

  it('skips bot.pid fallback when botPid is null', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const out = ps([{ pid: CLAUDE_PID, ppid: 1, command: 'claude' }])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('skips bot.pid fallback when botPid <= 1 (sentinel guard)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const out = ps([{ pid: CLAUDE_PID, ppid: 1, command: 'claude' }])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: 0, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('skips bot.pid fallback when isPidAlive says the orphan is dead', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const DEAD = 4001
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: DEAD, ppid: 1, command: TELEGRAM_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: DEAD, isPidAlive: NO_PIDS_ALIVE,
    })).toBe(false)
  })

  it('skips bot.pid fallback when the orphan cmdline does not match the provider', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const RECYCLED = 4002
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: RECYCLED, ppid: 1, command: 'node /srv/other/server.js' },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: RECYCLED, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('performs slack cross-tree scan when slack poller is not under claude', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const SLACK_NODE = 5000
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: SLACK_NODE, ppid: 1, command: SLACK_CMD },
    ])
    const events: Array<[string, Record<string, unknown>]> = []
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'slack',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
      agentName: 'beta',
      debugLog: (e, f) => events.push([e, f]),
    })).toBe(true)
    expect(events).toEqual([['slack plugin alive via process scan', { claudePid: CLAUDE_PID, slackPid: SLACK_NODE, agentName: 'beta' }]])
  })

  it('performs slack cross-tree scan but skips dead slack pids', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const DEAD = 5001
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: DEAD, ppid: 1, command: SLACK_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'slack',
      botPid: null, isPidAlive: NO_PIDS_ALIVE,
    })).toBe(false)
  })

  it('does NOT run the cross-tree scan for non-slack providers (e.g. telegram)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const SLACK_NODE = 5002
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: SLACK_NODE, ppid: 1, command: SLACK_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('performs discord cross-tree scan when discord poller is not under claude', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const DISCORD = 6000
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: DISCORD, ppid: 1, command: DISCORD_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'discord',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(true)
  })

  it('performs discord cross-tree scan but skips dead discord pids', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const DEAD = 6001
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: DEAD, ppid: 1, command: DISCORD_CMD },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'discord',
      botPid: null, isPidAlive: NO_PIDS_ALIVE,
    })).toBe(false)
  })

  it('skips already-seen pids in the tree walk (duplicate-row revisit guard)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    // The regex parses each ps line independently. If the same (pid, ppid)
    // pair appears twice (or more), the childrenOf map contains duplicate
    // entries and the walk pushes the same child twice. The seen Set must
    // short-circuit the revisit, otherwise the walk loops forever. The
    // plugin is not under claude here -> not alive.
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 100, ppid: CLAUDE_PID, command: 'wrapper' },
      { pid: 100, ppid: CLAUDE_PID, command: 'wrapper' }, // duplicate row
      { pid: 100, ppid: CLAUDE_PID, command: 'wrapper' }, // duplicate row
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('does NOT cross-tree-scan for googlechat (cross-tree is slack/discord only)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const NODE = 6001
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: NODE, ppid: 1, command: 'node /home/test/.claude/plugins/googlechat/0.0.1/server.js' },
    ])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'googlechat',
      botPid: null, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })

  it('returns false when nothing matches (dead plugin)', async () => {
    const { decideHasPluginAlive } = await importFresh()
    const out = ps([{ pid: CLAUDE_PID, ppid: 1, command: 'claude' }])
    expect(decideHasPluginAlive({
      psOutput: out, claudePid: CLAUDE_PID, providerType: 'telegram',
      botPid: 999, isPidAlive: ALL_PIDS_ALIVE,
    })).toBe(false)
  })
})

// =========================================================================
// snapshotProcsWithRetry
// =========================================================================

describe('snapshotProcsWithRetry', () => {
  it('returns first-attempt result without retrying', async () => {
    const { snapshotProcsWithRetry } = await importFresh()
    const run = vi.fn(() => 'OUT')
    expect(snapshotProcsWithRetry(run)).toBe('OUT')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('retries with the longer deadline when the fast path throws and logs a debug line', async () => {
    const { snapshotProcsWithRetry } = await importFresh()
    const run = vi.fn(((t: number) => {
      if (t === 5000) throw new Error('ETIMEDOUT')
      return 'OUT-RETRY'
    }) as (t: number) => string)
    expect(snapshotProcsWithRetry(run)).toBe('OUT-RETRY')
    expect(run).toHaveBeenCalledTimes(2)
    expect(m.loggerDebug).toHaveBeenCalled()
  })

  it('propagates the error after both attempts throw (no swallow)', async () => {
    const { snapshotProcsWithRetry } = await importFresh()
    const run = vi.fn(() => { throw new Error('DEAD') })
    expect(() => snapshotProcsWithRetry(run)).toThrow('DEAD')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('uses the timeouts tuple argument when provided', async () => {
    const { snapshotProcsWithRetry } = await importFresh()
    const run = vi.fn(((t: number) => {
      if (t === 10) throw new Error('first')
      return 'X'
    }) as (t: number) => string)
    expect(snapshotProcsWithRetry(run, [10, 20])).toBe('X')
    expect(run).toHaveBeenNthCalledWith(1, 10)
    expect(run).toHaveBeenNthCalledWith(2, 20)
  })
})

// =========================================================================
// probeChannelPluginLiveness -- side-effecting wrapper
// =========================================================================

describe('probeChannelPluginLiveness', () => {
  it('returns "alive" when the ps snapshot shows a matching plugin and state dir is readable', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 2000, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
    ])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(true)
    m.readFileSync.mockReturnValue('2000\n')
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram', 'alpha')).toBe('alive')
    expect(m.execFileSync).toHaveBeenCalledWith('/bin/ps', ['-axww', '-o', 'pid,ppid,command'], expect.objectContaining({ timeout: 5000, maxBuffer: 8 * 1024 * 1024 }))
    expect(m.channelStateDir).toHaveBeenCalledWith('telegram', '/project/root/agents/alpha')
  })

  it('returns "alive" when no agentName is supplied (state dir = global home channels)', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 2000, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
    ])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(false)
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram')).toBe('alive')
    expect(m.channelStateDir).toHaveBeenCalledWith('telegram')
    expect(m.agentDir).not.toHaveBeenCalled()
  })

  it('returns "down" when ps is healthy but no matching plugin is found', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    const out = ps([{ pid: CLAUDE_PID, ppid: 1, command: 'claude' }])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(false)
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram', 'alpha')).toBe('down')
  })

  it('returns "unknown" when snapshotProcsWithRetry throws twice (ps timed out on a loaded box)', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    m.execFileSync.mockImplementation(() => { throw new Error('ETIMEDOUT') })
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram', 'alpha')).toBe('unknown')
    expect(m.loggerWarn).toHaveBeenCalled()
    expect(m.execFileSync).toHaveBeenCalledTimes(2)
  })

  it('returns "unknown" when the state-dir read throws (e.g. bot.pid exists but readFileSync throws)', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    const out = ps([{ pid: CLAUDE_PID, ppid: 1, command: 'claude' }])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(true)
    m.readFileSync.mockImplementationOnce(() => { throw new Error('EACCES') })
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram', 'alpha')).toBe('unknown')
    expect(m.loggerWarn).toHaveBeenCalled()
  })

  it('treats a non-numeric bot.pid as botPid=null (Number.isFinite guard)', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    const out = ps([{ pid: CLAUDE_PID, ppid: 1, command: 'claude' }])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(true)
    m.readFileSync.mockReturnValueOnce('not-a-pid\n')
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram', 'alpha')).toBe('down')
  })

  it('debug-logs via the logger when the decider calls debugLog (reparented orphan)', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    // The wrapper's isPidAlive uses process.kill(pid, 0), so the orphan must
    // be a real, signal-able pid. process.pid is always signal-able to itself.
    const ORPHAN = process.pid
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: ORPHAN, ppid: 1, command: TELEGRAM_CMD },
    ])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(true)
    m.readFileSync.mockReturnValueOnce(String(ORPHAN))
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram', 'alpha')).toBe('alive')
    expect(m.loggerDebug).toHaveBeenCalled()
  })

  it('bot.pid points to a non-signalable pid -> the inline process.kill catch branch fires', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    // Use a pid that is guaranteed not to exist (PID_MAX_LIMIT + 1). The inline
    // isPidAlive wraps process.kill(pid, 0); that syscall throws ESRCH for a
    // dead pid and the catch returns false. The reparented orphan then fails
    // the bot.pid aliveness gate -> down.
    const ORPHAN = 2_000_000_000
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: ORPHAN, ppid: 1, command: TELEGRAM_CMD },
    ])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(true)
    m.readFileSync.mockReturnValueOnce(String(ORPHAN))
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram', 'alpha')).toBe('down')
  })

  it('retries the ps snapshot with the longer deadline before giving up', async () => {
    const { probeChannelPluginLiveness } = await importFresh()
    let call = 0
    m.execFileSync.mockImplementation(() => {
      call++
      if (call === 1) throw new Error('first-timeout')
      return ps([
        { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
        { pid: 2000, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
      ])
    })
    m.existsSync.mockReturnValue(false)
    expect(probeChannelPluginLiveness(CLAUDE_PID, 'telegram')).toBe('alive')
    expect(m.execFileSync).toHaveBeenCalledTimes(2)
    expect(m.execFileSync.mock.calls[0][1]).toEqual(['-axww', '-o', 'pid,ppid,command'])
    expect((m.execFileSync.mock.calls[0][2] as { timeout: number }).timeout).toBe(5000)
    expect((m.execFileSync.mock.calls[1][2] as { timeout: number }).timeout).toBe(12000)
  })
})

// =========================================================================
// hasChannelPluginAlive -- boolean wrapper
// =========================================================================

describe('hasChannelPluginAlive', () => {
  it('returns true only when probeChannelPluginLiveness returns "alive"', async () => {
    const { hasChannelPluginAlive } = await importFresh()
    const out = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 2000, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
    ])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(false)
    expect(hasChannelPluginAlive(CLAUDE_PID, 'telegram', 'alpha')).toBe(true)
  })

  it('returns false for "down" verdict (plugin missing)', async () => {
    const { hasChannelPluginAlive } = await importFresh()
    const out = ps([{ pid: CLAUDE_PID, ppid: 1, command: 'claude' }])
    m.execFileSync.mockReturnValueOnce(out)
    m.existsSync.mockReturnValue(false)
    expect(hasChannelPluginAlive(CLAUDE_PID, 'telegram', 'alpha')).toBe(false)
  })

  it('returns false for "unknown" verdict (probe failed) -- boolean view collapses unknown into not-alive', async () => {
    const { hasChannelPluginAlive } = await importFresh()
    m.execFileSync.mockImplementation(() => { throw new Error('ps-dead') })
    expect(hasChannelPluginAlive(CLAUDE_PID, 'telegram', 'alpha')).toBe(false)
  })
})

// =========================================================================
// readRespawnStampMs
// =========================================================================

describe('readRespawnStampMs', () => {
  it('returns seconds*1000 when the stamp file parses to a finite positive integer', async () => {
    const { readRespawnStampMs } = await importFresh()
    m.readFileSync.mockReturnValueOnce('1700000000\n')
    expect(readRespawnStampMs()).toBe(1_700_000_000_000)
  })

  it('returns 0 when the stamp file is missing/unreadable (catch branch)', async () => {
    const { readRespawnStampMs } = await importFresh()
    m.readFileSync.mockImplementationOnce(() => { throw new Error('ENOENT') })
    expect(readRespawnStampMs()).toBe(0)
  })

  it('returns 0 when the stamp parses to NaN (Number.isFinite guard)', async () => {
    const { readRespawnStampMs } = await importFresh()
    m.readFileSync.mockReturnValueOnce('garbage\n')
    expect(readRespawnStampMs()).toBe(0)
  })

  it('returns 0 when the stamp is zero (s>0 guard)', async () => {
    const { readRespawnStampMs } = await importFresh()
    m.readFileSync.mockReturnValueOnce('0\n')
    expect(readRespawnStampMs()).toBe(0)
  })

  it('returns 0 when the stamp is negative (s>0 guard)', async () => {
    const { readRespawnStampMs } = await importFresh()
    m.readFileSync.mockReturnValueOnce('-100\n')
    expect(readRespawnStampMs()).toBe(0)
  })
})

// =========================================================================
// readKeepaliveAgeMs
// =========================================================================

describe('readKeepaliveAgeMs', () => {
  it('returns nowMs - mtimeMs when statSync succeeds', async () => {
    const { readKeepaliveAgeMs } = await importFresh()
    m.statSync.mockReturnValueOnce({ mtimeMs: 1_700_000_000_000 })
    expect(readKeepaliveAgeMs(1_700_000_060_000)).toBe(60_000)
  })

  it('returns null when the keepalive file is missing/unreadable (catch branch)', async () => {
    const { readKeepaliveAgeMs } = await importFresh()
    m.statSync.mockImplementationOnce(() => { throw new Error('ENOENT') })
    expect(readKeepaliveAgeMs(1_700_000_000_000)).toBeNull()
  })
})

// =========================================================================
// decideNativeChannelDown -- pure decision
// =========================================================================

describe('decideNativeChannelDown', () => {
  it('returns false during the startup grace window even if everything else looks dead', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: null,
      pluginAlive: false,
      keepaliveAgeMs: 10 * 60 * 1000,
      msSinceLastRespawn: 60_000, // inside STARTUP_GRACE_MS (360_000)
    })).toBe(false)
  })

  it('returns true when claudePid is null AND we are past the grace window', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: null,
      pluginAlive: false,
      keepaliveAgeMs: null,
      msSinceLastRespawn: 500_000,
    })).toBe(true)
  })

  it('returns true when claudePid is set but no plugin grandchild is alive', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: CLAUDE_PID,
      pluginAlive: false,
      keepaliveAgeMs: 0,
      msSinceLastRespawn: 500_000,
    })).toBe(true)
  })

  it('returns true when plugin is alive but the keepalive file is stale (TUI wedged)', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: CLAUDE_PID,
      pluginAlive: true,
      keepaliveAgeMs: 19 * 60 * 1000, // > 18*60*1000 KEEPALIVE_STALE_MS
      msSinceLastRespawn: 500_000,
    })).toBe(true)
  })

  it('keeps keepaliveAgeMs=null as a non-stale signal (null != > stale)', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: CLAUDE_PID,
      pluginAlive: true,
      keepaliveAgeMs: null,
      msSinceLastRespawn: 500_000,
    })).toBe(false)
  })

  it('returns false when everything looks healthy', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: CLAUDE_PID,
      pluginAlive: true,
      keepaliveAgeMs: 60_000,
      msSinceLastRespawn: 500_000,
    })).toBe(false)
  })

  it('returns false when msSinceLastRespawn is null (no stamp on disk -> no grace applied)', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: CLAUDE_PID,
      pluginAlive: true,
      keepaliveAgeMs: 60_000,
      msSinceLastRespawn: null,
    })).toBe(false)
  })

  it('startup grace is exactly STARTUP_GRACE_MS exclusive (==360_000 -> not in grace)', async () => {
    const { decideNativeChannelDown } = await importFresh()
    expect(decideNativeChannelDown({
      claudePid: null,
      pluginAlive: false,
      keepaliveAgeMs: null,
      msSinceLastRespawn: 360_000,
    })).toBe(true)
  })
})

// =========================================================================
// probeNativeChannelDown -- integration of all readers
// =========================================================================

describe('probeNativeChannelDown', () => {
  it('returns true when getClaudePidForSession is null and no respawn stamp is present', async () => {
    const { probeNativeChannelDown } = await importFresh()
    m.execFileSync.mockImplementation(() => { throw new Error('no tmux') })
    m.statSync.mockImplementation(() => { throw new Error('no keepalive') })
    m.readFileSync.mockImplementation(() => { throw new Error('no stamp') })
    expect(probeNativeChannelDown('marveen-channels', 'telegram', 'alpha')).toBe(true)
  })

  it('returns false during startup grace even when no claude pid can be found', async () => {
    const { probeNativeChannelDown } = await importFresh()
    m.execFileSync.mockImplementation(() => { throw new Error('no tmux') })
    const nowSec = Math.floor(Date.now() / 1000)
    m.readFileSync.mockReturnValue(String(nowSec))
    m.statSync.mockImplementation(() => { throw new Error('no keepalive') })
    expect(probeNativeChannelDown('marveen-channels', 'telegram', 'alpha')).toBe(false)
  })

  it('returns false when the plugin is alive and the keepalive is fresh', async () => {
    const { probeNativeChannelDown } = await importFresh()
    const psOut = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 2000, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
    ])
    m.execFileSync
      .mockReturnValueOnce(`${CLAUDE_PID}\n`)
      .mockReturnValueOnce('claude\n')
      .mockReturnValueOnce(psOut)
    m.existsSync.mockReturnValue(false)
    m.statSync.mockReturnValue({ mtimeMs: Date.now() - 60_000 })
    m.readFileSync.mockImplementation(() => { throw new Error('no stamp') })
    expect(probeNativeChannelDown('marveen-channels', 'telegram', 'alpha')).toBe(false)
  })

  it('returns true when plugin is alive but keepalive is stale past KEEPALIVE_STALE_MS', async () => {
    const { probeNativeChannelDown } = await importFresh()
    const psOut = ps([
      { pid: CLAUDE_PID, ppid: 1, command: 'claude' },
      { pid: 2000, ppid: CLAUDE_PID, command: TELEGRAM_CMD },
    ])
    m.execFileSync
      .mockReturnValueOnce(`${CLAUDE_PID}\n`)
      .mockReturnValueOnce('claude\n')
      .mockReturnValueOnce(psOut)
    m.existsSync.mockReturnValue(false)
    m.statSync.mockReturnValue({ mtimeMs: Date.now() - 19 * 60 * 1000 })
    m.readFileSync.mockImplementation(() => { throw new Error('no stamp') })
    expect(probeNativeChannelDown('marveen-channels', 'telegram', 'alpha')).toBe(true)
  })

  it('returns true when getClaudePidForSession is null AND keepalive read fails', async () => {
    const { probeNativeChannelDown } = await importFresh()
    m.execFileSync.mockImplementation(() => { throw new Error('no tmux') })
    m.statSync.mockImplementation(() => { throw new Error('no keepalive') })
    m.readFileSync.mockImplementation(() => { throw new Error('no stamp') })
    expect(probeNativeChannelDown('marveen-channels', 'telegram', 'alpha')).toBe(true)
  })
})

// =========================================================================
// Constant exports
// =========================================================================

describe('constants', () => {
  it('exposes the documented keepalive / grace / stamp paths and timeouts', async () => {
    const mod = await importFresh()
    expect(mod.KEEPALIVE_FILE.endsWith('store/.channel-keepalive')).toBe(true)
    expect(mod.RESPAWN_STAMP_FILE.endsWith('store/.channel-last-respawn')).toBe(true)
    expect(mod.KEEPALIVE_STALE_MS).toBe(18 * 60 * 1000)
    expect(mod.STARTUP_GRACE_MS).toBe(360_000)
    expect(mod.PS_PROBE_TIMEOUT_MS).toBe(5000)
    expect(mod.PS_PROBE_RETRY_TIMEOUT_MS).toBe(12000)
  })
})

// =========================================================================
// Path-wiring sanity: confirm KEEPALIVE_FILE / RESPAWN_STAMP_FILE actually
// point at <PROJECT_ROOT>/store/... -- a regression here would silently break
// every reader.
// =========================================================================

describe('path wiring', () => {
  it('KEEPALIVE_FILE resolves to <PROJECT_ROOT>/store/.channel-keepalive', async () => {
    const mod = await importFresh()
    expect(mod.KEEPALIVE_FILE).toBe(join(m.PROJECT_ROOT, 'store', '.channel-keepalive'))
  })

  it('RESPAWN_STAMP_FILE resolves to <PROJECT_ROOT>/store/.channel-last-respawn', async () => {
    const mod = await importFresh()
    expect(mod.RESPAWN_STAMP_FILE).toBe(join(m.PROJECT_ROOT, 'store', '.channel-last-respawn'))
  })
})
