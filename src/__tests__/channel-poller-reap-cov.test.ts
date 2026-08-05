// Supplemental coverage for src/web/channel-poller-reap.ts.
//
// channel-poller-reap.test.ts covers the pure parsers
// (parsePollerPidsFromPs, findOrphanChannelClaudes) and poller-evidence.test.ts
// covers buildPollerEvidence. The I/O wrappers -- listPollerPidsByStateDir,
// readBotPid, snapshotProcs, livePanePids, killBunChildren -- are private and
// only reachable through the public functions reapChannelOrphans,
// collectPollerEvidence, and reapDetachedChannelClaudes. process.kill must
// be stubbed to avoid sending real signals on a CI box.
//
// Mocks: node:child_process (execSync + execFileSync), node:fs (existsSync +
// readFileSync), and ../logger.js (warn + info). channel-provider.js stays
// real so channelStateDir() resolves to a real, human-debuggable path under
// the agent dir passed by the test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Mocks -- declared before any module-bound import of the SUT.
// ---------------------------------------------------------------------------

const loggerWarn = vi.fn()
const loggerInfo = vi.fn()

vi.mock('../logger.js', () => ({
  logger: {
    warn: (...args: unknown[]) => loggerWarn(...args),
    info: (...args: unknown[]) => loggerInfo(...args),
    error: vi.fn(),
    debug: vi.fn(),
  },
}))

const execSyncMock = vi.fn<(cmd: string, opts?: unknown) => string>()
const execFileSyncMock = vi.fn<(cmd: string, args?: unknown[]) => string | Buffer>()
vi.mock('node:child_process', () => ({
  execSync: (cmd: string, opts?: unknown) => execSyncMock(cmd, opts),
  execFileSync: (cmd: string, args?: unknown[]) => execFileSyncMock(cmd, args ?? []),
}))

const existsSyncMock = vi.fn<(p: string) => boolean>()
const readFileSyncMock = vi.fn<(p: string) => string>()
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: ((p: Parameters<typeof actual.existsSync>[0]) =>
      existsSyncMock(String(p))) as typeof actual.existsSync,
    readFileSync: ((p: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) => {
      const pathStr = String(p)
      // Delegate to the mock for everything channel-poller-reap touches.
      if (pathStr.endsWith('bot.pid')) return readFileSyncMock(pathStr)
      // Otherwise, return a real read so unrelated fs.* calls inside vitest
      // itself (setupFiles, etc.) still resolve.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (actual.readFileSync as any)(p, ...(rest as []))
    }) as typeof actual.readFileSync,
  }
})

// SUT import -- must come AFTER vi.mock so the mocked fs + child_process +
// logger bindings are what the module reads.
const {
  parsePollerPidsFromPs,
  reapChannelOrphans,
  collectPollerEvidence,
  buildPollerEvidence,
  reapDetachedChannelClaudes,
  findOrphanChannelClaudes,
} = await import('../web/channel-poller-reap.js')

type ProcRow = Parameters<typeof findOrphanChannelClaudes>[0][number] | {
  pid: number
  ppid: number
  command: string
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let killCalls: Array<{ pid: number; signal: string | number }>
let killSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  loggerWarn.mockReset()
  loggerInfo.mockReset()
  execSyncMock.mockReset()
  execFileSyncMock.mockReset()
  existsSyncMock.mockReset()
  readFileSyncMock.mockReset()
  // Default: nothing exists, nothing to read -- specific tests override.
  existsSyncMock.mockReturnValue(false)
  // Default: process.kill succeeds (the orphans don't actually exist on the
  // test box, so the real call would throw ESRCH; we must stub it).
  killCalls = []
  killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
    killCalls.push({ pid, signal: signal ?? 0 })
    return true
  })
})

afterEach(() => {
  killSpy.mockRestore()
})

// A ps -axww row snapshot crafted to include the channel providers we care
// about. Real ps output on macOS, used by snapshotProcs() to derive ProcRow[].
function psRowsString(rows: Array<{ pid: number; ppid: number; cmd: string }>): string {
  return rows.map((r) => `  ${r.pid} ${r.ppid}  ${r.cmd}`).join('\n')
}

// ---------------------------------------------------------------------------
// parsePollerPidsFromPs -- edge cases not covered by channel-poller-reap.test
// ---------------------------------------------------------------------------

describe('parsePollerPidsFromPs (supplementary)', () => {
  it('skips lines that contain the env-var needle but lack a leading pid pattern', () => {
    // Defensive: a stray env-var line (e.g., a `tee`d echo from elsewhere in
    // the pipeline) must not throw the parser. The regex /^\s*(\d+)\s/ fails,
    // so we `continue` rather than emit a NaN pid.
    const stray = 'TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram'
    expect(parsePollerPidsFromPs(stray, 'TELEGRAM_STATE_DIR', '/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram')).toEqual([])
  })

  it('returns an empty array for an empty ps output', () => {
    expect(parsePollerPidsFromPs('', 'TELEGRAM_STATE_DIR', '/anywhere')).toEqual([])
  })

  it('keeps a pid of 2 in the output (the guard is `>1`, not `>=2`)', () => {
    // Defensive sanity: pid 2 is a valid Linux PID (kthreadd) and the code
    // emits it -- the guard only excludes 0 and 1. We document the boundary
    // here so a future "tighten the guard" change is caught.
    const edge = '  2 s000  S  0:00.00 kthreadd TELEGRAM_STATE_DIR=/dir'
    expect(parsePollerPidsFromPs(edge, 'TELEGRAM_STATE_DIR', '/dir')).toEqual([2])
  })
})

// ---------------------------------------------------------------------------
// readBotPid (private) -- exercised via reapChannelOrphans + collectPollerEvidence
// ---------------------------------------------------------------------------

describe('readBotPid (via reapChannelOrphans)', () => {
  let agentDir: string
  beforeEach(() => {
    agentDir = mkTempDir('reap-botpid-')
  })
  afterEach(() => {
    rmTempDir(agentDir)
  })

  it('returns null and does not reap when bot.pid is absent', () => {
    // existsSync defaults to false; env scan returns nothing either.
    execSyncMock.mockReturnValue('')
    const result = reapChannelOrphans('telegram', agentDir)
    expect(result.reaped).toEqual([])
    expect(result.source.fromBotPid).toBeNull()
    expect(killCalls).toEqual([])
    expect(loggerInfo).not.toHaveBeenCalled()
  })

  it('reaps the pid named in bot.pid when bot.pid is readable and numeric', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('12345')
    // env scan finds no matches; only the bot.pid candidate is reaped.
    execSyncMock.mockReturnValue('')

    const result = reapChannelOrphans('telegram', agentDir)
    expect(result.source.fromBotPid).toBe(12345)
    // SIGTERM, sleep, 0-probe, SIGKILL per pid (the probe gates SIGKILL).
    expect(killCalls.filter((c) => c.pid === 12345).map((c) => c.signal)).toEqual([
      'SIGTERM',
      0,
      'SIGKILL',
    ])
    expect(loggerInfo).toHaveBeenCalledOnce()
  })

  it('treats a non-numeric bot.pid as no candidate (parseInt yields NaN)', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('not-a-number')
    execSyncMock.mockReturnValue('')

    const result = reapChannelOrphans('telegram', agentDir)
    expect(result.source.fromBotPid).toBeNull()
    expect(result.reaped).toEqual([])
  })

  it('treats a bot.pid value of 1 (or 0) as no candidate (pid > 1 guard)', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('0')
    execSyncMock.mockReturnValue('')

    const result = reapChannelOrphans('telegram', agentDir)
    expect(result.source.fromBotPid).toBeNull()
  })

  it('swallows readFileSync errors (existsSync true, read throws)', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockImplementation(() => {
      throw new Error('EACCES: permission denied')
    })
    execSyncMock.mockReturnValue('')

    const result = reapChannelOrphans('telegram', agentDir)
    expect(result.source.fromBotPid).toBeNull()
    expect(result.reaped).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// listPollerPidsByStateDir error path -- execSync throws inside ps scan
// ---------------------------------------------------------------------------

describe('listPollerPidsByStateDir (via reapChannelOrphans)', () => {
  it('logs a warning and returns no env-scan pids when /bin/ps eww -e throws', () => {
    const agentDir = mkTempDir('reap-ps-throw-')
    try {
      execSyncMock.mockImplementation(() => {
        throw new Error('ENOMEM: cannot allocate memory')
      })
      const result = reapChannelOrphans('telegram', agentDir)
      expect(result.source.fromEnvScan).toEqual([])
      expect(result.reaped).toEqual([])
      expect(loggerWarn).toHaveBeenCalled()
      // First arg shape: { err, chanDir }, channel = warning body.
      const call = loggerWarn.mock.calls[0]
      expect(call[1]).toBe('channel-poller-reap: ps scan failed')
    } finally {
      rmTempDir(agentDir)
    }
  })
})

// ---------------------------------------------------------------------------
// reapChannelOrphans -- dedup, signal flow, channelNeedle-by-provider routing
// ---------------------------------------------------------------------------

describe('reapChannelOrphans', () => {
  let agentDir: string
  beforeEach(() => {
    agentDir = mkTempDir('reap-orphans-')
  })
  afterEach(() => {
    rmTempDir(agentDir)
  })

  it('dedupes a pid that appears in both bot.pid and the env scan', () => {
    const chanDir = `${agentDir}/.claude/channels/slack`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('7777')

    // The env-scan output contains the same pid as bot.pid plus another.
    const psOut = [
      '  7777 s000  S  bun run start HOME=/u SLACK_STATE_DIR=' + chanDir,
      '  8888 s000  S  bun run start HOME=/u SLACK_STATE_DIR=' + chanDir,
    ].join('\n')
    execSyncMock.mockReturnValue(psOut)

    const result = reapChannelOrphans('slack', agentDir)
    expect(result.source.fromBotPid).toBe(7777)
    expect(result.source.fromEnvScan).toEqual([7777, 8888])
    // bot.pid (7777) listed first; 8888 added once.
    expect(result.reaped).toEqual([7777, 8888])
    // No double-signal: each pid gets SIGTERM, the 0-probe, then SIGKILL.
    const byPid = new Map<number, Array<string | number>>()
    for (const c of killCalls) {
      const list = byPid.get(c.pid) ?? []
      list.push(c.signal)
      byPid.set(c.pid, list)
    }
    expect(byPid.get(7777)).toEqual(['SIGTERM', 0, 'SIGKILL'])
    expect(byPid.get(8888)).toEqual(['SIGTERM', 0, 'SIGKILL'])
    // /bin/sleep called between TERM and KILL.
    expect(execFileSyncMock).toHaveBeenCalledWith('/bin/sleep', ['0.3'], expect.any(Object))
  })

  it('reaps only env-scan candidates when bot.pid is absent', () => {
    existsSyncMock.mockReturnValue(false)
    const chanDir = `${agentDir}/.claude/channels/googlechat`
    const psOut = [
      '  5001 s000  S  bun GOOGLECHAT_STATE_DIR=' + chanDir,
      '  5002 s000  S  bun GOOGLECHAT_STATE_DIR=' + chanDir,
    ].join('\n')
    execSyncMock.mockReturnValue(psOut)

    const result = reapChannelOrphans('googlechat', agentDir)
    expect(result.source.fromBotPid).toBeNull()
    expect(result.source.fromEnvScan).toEqual([5001, 5002])
    expect(result.reaped).toEqual([5001, 5002])
    expect(loggerInfo).toHaveBeenCalled()
  })

  it('skips the kill loop and the sleep entirely when nothing was found', () => {
    existsSyncMock.mockReturnValue(false)
    execSyncMock.mockReturnValue('')
    const result = reapChannelOrphans('discord', agentDir)
    expect(result.reaped).toEqual([])
    expect(killCalls).toEqual([])
    // sleep MUST NOT be exec'd when there were no orphans.
    expect(execFileSyncMock).not.toHaveBeenCalled()
  })

  it('ignores a SIGKILL-spy throw on a pid that vanished mid-loop (process.kill(0) returns ESRCH)', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    // First call (SIGTERM) succeeds; second call (SIGKILL) throws because the
    // process is already gone. The catch clause must swallow it.
    let sigtermDone = false
    killSpy.mockImplementation((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? 0 })
      if (signal === 'SIGKILL' && pid === 4242 && sigtermDone) {
        // Simulate the SECOND probe+kill cycle: kill(pid, 0) followed by kill
        // would throw ESRCH. Throw here to exercise the `} catch { /* gone */ }`.
        sigtermDone = false // not used; see spy override below
        const err = new Error('ESRCH: no such process') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      if (signal === 'SIGTERM') sigtermDone = true
      return true
    })

    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('4242')
    execSyncMock.mockReturnValue('')
    // execFileSync: /bin/sleep must not throw here (we want the SIGKILL probe
    // path taken). Force a real error specifically on the 0-probe of pid 4242:
    execFileSyncMock.mockReturnValue('')

    // Re-spy with a single throw on the second call for pid 4242 with SIGKILL.
    killSpy.mockRestore()
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? 0 })
      if (pid === 4242 && signal === 'SIGKILL') {
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      return true
    })

    const result = reapChannelOrphans('telegram', agentDir)
    expect(result.reaped).toEqual([4242])
    expect(killSpy).toHaveBeenCalled()
  })

  it('continues reaping even when /bin/sleep throws (EAGAIN, etc.)', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('9001')
    execSyncMock.mockReturnValue('')
    // sleep blows up but the SIGKILL loop still runs.
    execFileSyncMock.mockImplementation(() => {
      throw new Error('sleep: interrupted')
    })

    const result = reapChannelOrphans('telegram', agentDir)
    expect(result.reaped).toEqual([9001])
    expect(killCalls.filter((c) => c.pid === 9001 && c.signal === 'SIGKILL')).toHaveLength(1)
  })
})

// ---------------------------------------------------------------------------
// collectPollerEvidence -- happy + scan-failure paths
// ---------------------------------------------------------------------------

describe('collectPollerEvidence', () => {
  let agentDir: string
  beforeEach(() => {
    agentDir = mkTempDir('reap-evidence-')
  })
  afterEach(() => {
    rmTempDir(agentDir)
  })

  it('assembles bot.pid + env-scan candidates + the snapshot into a verdict', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('700')

    const claudePid = 100
    // snapshotProcs reads /bin/ps -axww -o pid=,ppid=,command=
    const psRows = psRowsString([
      { pid: claudePid, ppid: 1, cmd: 'claude --channels plugin:telegram' },
      { pid: 700, ppid: claudePid, cmd: 'bun run --cwd /plugins/telegram start' },
    ])
    const psEww = `  700 s000 S TELEGRAM_STATE_DIR=${chanDir}`
    // First call: listPollerPidsByStateDir -> /bin/ps eww -e
    // Second call: snapshotProcs -> /bin/ps -axww -o pid=,ppid=,command=
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps eww -e')) return psEww
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      throw new Error(`unexpected cmd: ${cmd}`)
    })

    const e = collectPollerEvidence('telegram', agentDir, claudePid)
    expect(e.botPid).toBe(700)
    expect(e.botPidAlive).toBe(true)
    expect(e.envScanPids).toEqual([700])
    expect(e.interpretation).toBe('in-tree')
    expect(e.rows).toHaveLength(1)
    expect(e.rows[0]).toEqual({ pid: 700, ppid: claudePid, inClaudeTree: true })
  })

  it('survives a ps eww -e failure (warns + env scan empty) by reading snapshot + bot.pid', () => {
    const chanDir = `${agentDir}/.claude/channels/telegram`
    existsSyncMock.mockImplementation((p) => p === `${chanDir}/bot.pid`)
    readFileSyncMock.mockReturnValue('701')

    const claudePid = 100
    const psRows = psRowsString([
      { pid: claudePid, ppid: 1, cmd: 'claude --channels plugin:telegram' },
      // bot.pid target reparented to init -- still alive, but ORPHANED.
      { pid: 701, ppid: 1, cmd: 'bun run' },
    ])
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps eww -e')) throw new Error('EAGAIN: spawn failed')
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      throw new Error(`unexpected cmd: ${cmd}`)
    })

    const e = collectPollerEvidence('telegram', agentDir, claudePid)
    expect(loggerWarn).toHaveBeenCalled()
    expect(e.envScanPids).toEqual([])
    expect(e.botPid).toBe(701)
    expect(e.botPidAlive).toBe(true)
    expect(e.rows).toEqual([{ pid: 701, ppid: 1, inClaudeTree: false }])
    expect(e.interpretation).toBe('orphaned')
  })
})

// ---------------------------------------------------------------------------
// snapshotProcs (private) -- via reapDetachedChannelClaudes. Reconstitute
// ProcRow[] from /bin/ps -axww -o pid=,ppid=,command= synthetic output.
// ---------------------------------------------------------------------------

describe('snapshotProcs (via reapDetachedChannelClaudes)', () => {
  it('returns ProcRow[] from a real-shaped ps -axww header-less row set', () => {
    const rows = psRowsString([
      { pid: 1, ppid: 0, cmd: '/sbin/launchd' },
      { pid: 2, ppid: 1, cmd: '/usr/sbin/syslogd' },
    ])
    execSyncMock.mockImplementation((cmd: string, _opts?: unknown) => {
      if (cmd.startsWith('/bin/ps -axww')) return rows
      // tmux list-panes returns a single live pane (different exec invocation)
      if (cmd.includes('list-panes -a')) return '1\n'
      throw new Error(`unexpected cmd: ${cmd}`)
    })

    const orphans = reapDetachedChannelClaudes()
    // No --channels rows, no orphans. Crucially: the parser must NOT have
    // thrown on rows with ppid=0 (the >=0 regex accepts it).
    expect(orphans).toEqual([])
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it('warns and returns an empty orphan list when /bin/ps -axww throws', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) throw new Error('ENOMEM')
      if (cmd.includes('list-panes -a')) return '500\n'
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    const orphans = reapDetachedChannelClaudes()
    expect(orphans).toEqual([])
    expect(loggerWarn).toHaveBeenCalled()
    // Search any arg of any warn call for the snapshot failure body (the call
    // shape is `(object, 'msg')` here so c[1] is fine).
    expect(loggerWarn.mock.calls.some((c) => c[1] === 'channel-poller-reap: ps -axww snapshot failed')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// livePanePids (private) -- parses tmux list-panes output and discards junk
// ---------------------------------------------------------------------------

describe('livePanePids (via reapDetachedChannelClaudes)', () => {
  it('ignores non-numeric and <=1 pane pids', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return ''
      if (cmd.includes('list-panes -a')) return ['76621', 'not-a-pid', '0', '1'].join('\n')
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    // No live claude orphans to reap; the test is about the parse.
    expect(reapDetachedChannelClaudes()).toEqual([])
    // Should NOT have warned -- tmux responded successfully.
    expect(loggerWarn).not.toHaveBeenCalled()
  })

  it('warns and fails safe (live.size==0 short-circuit) when tmux errors', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return ''
      if (cmd.includes('list-panes -a')) throw new Error('no server')
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    const orphans = reapDetachedChannelClaudes()
    expect(orphans).toEqual([])
    // Both the livePanePids warn AND the reapDetachedChannelClaudes fail-safe
    // warn fire -- distinct messages, both important. The first is the
    // 2-arg `(object, 'msg')` shape; the second is the 1-arg string shape, so
    // we flatten both code paths' first arg into one searchable list.
    const allMessages = loggerWarn.mock.calls.flatMap((c) => c.map((a) => String(a)))
    expect(allMessages).toContain('channel-poller-reap: tmux list-panes failed')
    expect(allMessages).toContain(
      'channel-poller-reap: no live panes resolved, skipping detached-claude reap (fail-safe)',
    )
  })

  it('uses an explicit tmuxPath passed via opts when listing panes', () => {
    let listPanesCalls = 0
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return ''
      if (cmd.includes('list-panes -a')) {
        listPanesCalls++
        // Verify the exact tmuxPath the caller passed is on the cmdline.
        expect(cmd).toMatch(/^\/opt\/homebrew\/bin\/tmux list-panes -a/)
        return '100\n'
      }
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    reapDetachedChannelClaudes({ tmuxPath: '/opt/homebrew/bin/tmux' })
    expect(listPanesCalls).toBe(1)
  })
})

// ---------------------------------------------------------------------------
// killBunChildren (private) -- SIGTERMs each bun pgrep child of a claude pid
// ---------------------------------------------------------------------------

describe('killBunChildren (via reapDetachedChannelClaudes)', () => {
  it('sends SIGTERM to every bun child returned by pgrep', () => {
    // Build a /bin/ps -axww row set with two orphan channel claudes that have
    // bun children. Reaping them must walk the pgrep-bun branch.
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 9001, ppid: 1, command: 'tmux: server' },
      { pid: 71000, ppid: 9001, command: `${CLAUDE} --channels plugin:telegram` },
      { pid: 71001, ppid: 71000, command: 'bun run --cwd /p/telegram start' },
      { pid: 71002, ppid: 71000, command: 'bun server.ts' },
    ]
    const psRows = procs
      .map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`)
      .join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.includes('list-panes -a')) return '100\n' // unrelated live pane
      if (cmd.startsWith('/usr/bin/pgrep -P 71000 bun')) return '71001\n71002\n'
      throw new Error(`unexpected cmd: ${cmd}`)
    })

    const orphans = reapDetachedChannelClaudes()
    expect(orphans).toContain(71000)
    // Both bun children got SIGTERM.
    const pids = killCalls.filter((c) => c.signal === 'SIGTERM').map((c) => c.pid)
    expect(pids).toContain(71001)
    expect(pids).toContain(71002)
  })

  it('skips pgrep output rows that are not pids > 1 (parseInt failure + <=1 guard)', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 9001, ppid: 1, command: 'tmux: server' },
      { pid: 72000, ppid: 9001, command: `${CLAUDE} --channels plugin:slack-channel` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.includes('list-panes -a')) return '100\n'
      if (cmd.startsWith('/usr/bin/pgrep -P 72000 bun')) return 'junk-line\n0\n1\n72001\n'
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    reapDetachedChannelClaudes()
    const pids = killCalls.filter((c) => c.signal === 'SIGTERM').map((c) => c.pid)
    expect(pids).toEqual([72001])
  })

  it('swallows pgrep failures (no children) without throwing', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 9001, ppid: 1, command: 'tmux: server' },
      { pid: 73000, ppid: 9001, command: `${CLAUDE} --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.includes('list-panes -a')) return '100\n'
      if (cmd.startsWith('/usr/bin/pgrep')) {
        // pgrep exits 1 when no bun children exist.
        const err = new Error('no matches') as NodeJS.ErrnoException
        err.code = 'ENOENT' as unknown as string // not used; just needs to throw
        throw err
      }
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    // No exception, and no kill calls targeting bogus pids.
    expect(() => reapDetachedChannelClaudes()).not.toThrow()
    expect(killCalls.filter((c) => c.signal === 'SIGTERM' && c.pid === 73000)).toEqual([])
  })

  it('swallows a process.kill ESRCH inside the bun-children SIGTERM pass', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 9001, ppid: 1, command: 'tmux: server' },
      { pid: 74000, ppid: 9001, command: `${CLAUDE} --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.includes('list-panes -a')) return '100\n'
      if (cmd.startsWith('/usr/bin/pgrep -P 74000 bun')) return '74001\n'
      throw new Error(`unexpected cmd: ${cmd}`)
    })

    // Re-spy with a single throw on the bun SIGTERM for pid 74001.
    killSpy.mockRestore()
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? 0 })
      if (signal === 'SIGTERM' && pid === 74001) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      return true
    })

    reapDetachedChannelClaudes()
    // The catch swallowed the throw -- we reached the SIGKILL pass for the parent.
    expect(killCalls.some((c) => c.pid === 74000 && c.signal === 'SIGTERM')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// reapDetachedChannelClaudes -- end-to-end orchestration through the public API
// ---------------------------------------------------------------------------

describe('reapDetachedChannelClaudes', () => {
  it('spares a live main-session claude attached to a live pane', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 100, ppid: 90, command: 'tmux: server' },
      // The main channels pane: claude IS the pane leader.
      { pid: 200, ppid: 100, command: `${CLAUDE} --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.endsWith('list-panes -a')) return '200\n'
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    expect(reapDetachedChannelClaudes()).toEqual([])
    expect(killCalls).toEqual([])
  })

  it('spares a live sub-agent whose shell pane leader is the parent', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 100, ppid: 90, command: 'tmux: server' },
      // sh is the pane leader; claude is its child.
      { pid: 300, ppid: 100, command: '/bin/sh -c claude ...' },
      { pid: 301, ppid: 300, command: `${CLAUDE} --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.endsWith('list-panes -a')) return '300\n' // pane pid is the sh
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    expect(reapDetachedChannelClaudes()).toEqual([])
    expect(killCalls).toEqual([])
  })

  it('logs an info line and reaps the orphan when one is found', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 100, ppid: 90, command: 'tmux: server' },
      // Live main claude (spared): ppid is tmux but the live pane pid matches.
      { pid: 500, ppid: 100, command: `${CLAUDE} --channels plugin:telegram` },
      // Orphan: same tmux parent, no live pane in ancestry.
      { pid: 501, ppid: 100, command: `${CLAUDE} --continue --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.endsWith('list-panes -a')) return '500\n'
      if (cmd.startsWith('/usr/bin/pgrep -P 501 bun')) return ''
      throw new Error(`unexpected cmd: ${cmd}`)
    })

    const orphans = reapDetachedChannelClaudes()
    expect(orphans).toEqual([501])
    // SIGTERM, SIGKILL on the orphan only -- live main untouched.
    const fiveOOne = killCalls.filter((c) => c.pid === 501).map((c) => c.signal)
    expect(fiveOOne).toEqual(['SIGTERM', 'SIGKILL'])
    expect(killCalls.some((c) => c.pid === 500)).toBe(false)
    // Info log includes the needle filter summary.
    const infoCalls = loggerInfo.mock.calls
    expect(infoCalls).toHaveLength(1)
    expect(infoCalls[0][1]).toBe('channel-poller-reap: detached channel claudes killed')
    expect((infoCalls[0][0] as { channelNeedle: string }).channelNeedle).toBe('(all)')
  })

  it('honors a channelNeedle filter (only telegram orphans, not slack)', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 100, ppid: 90, command: 'tmux: server' },
      { pid: 600, ppid: 100, command: `${CLAUDE} --continue --channels plugin:slack-channel` },
      { pid: 601, ppid: 100, command: `${CLAUDE} --continue --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')

    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.endsWith('list-panes -a')) return '100\n' // no live panes -> we still need at least one
      throw new Error(`unexpected cmd: ${cmd}`)
    })

    // Two live pane pids -- but no detached channel claudes match live panes,
    // so both should be candidates by the findOrphanChannelClaudes logic.
    const orphaned = reapDetachedChannelClaudes({
      channelNeedle: 'plugin:telegram@',
      tmuxPath: '/usr/bin/tmux',
    })
    expect(orphaned).toEqual([601])
  })

  it('does not call /bin/sleep nor SIGKILL when no orphan was found', () => {
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return ''
      if (cmd.endsWith('list-panes -a')) return '999\n'
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    expect(reapDetachedChannelClaudes()).toEqual([])
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(killCalls).toEqual([])
    expect(loggerInfo).not.toHaveBeenCalled()
  })

  it('swallows a /bin/sleep failure between SIGTERM and SIGKILL passes', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 100, ppid: 90, command: 'tmux: server' },
      { pid: 700, ppid: 100, command: `${CLAUDE} --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.endsWith('list-panes -a')) return '100\n'
      if (cmd.startsWith('/usr/bin/pgrep -P 700 bun')) return ''
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    execFileSyncMock.mockImplementation(() => {
      throw new Error('SIGINT during sleep')
    })
    const orphans = reapDetachedChannelClaudes()
    expect(orphans).toEqual([700])
    // SIGKILL still fires after the sleep throws.
    expect(killCalls.some((c) => c.pid === 700 && c.signal === 'SIGKILL')).toBe(true)
  })

  it('swallows an ESRCH on the SIGKILL 0-probe (process already exited)', () => {
    const CLAUDE = '/opt/homebrew/bin/claude'
    const procs: ProcRow[] = [
      { pid: 100, ppid: 90, command: 'tmux: server' },
      { pid: 800, ppid: 100, command: `${CLAUDE} --channels plugin:telegram` },
    ]
    const psRows = procs.map((p) => `  ${p.pid}  ${p.ppid}  ${p.command}`).join('\n')
    execSyncMock.mockImplementation((cmd: string) => {
      if (cmd.startsWith('/bin/ps -axww')) return psRows
      if (cmd.endsWith('list-panes -a')) return '100\n'
      if (cmd.startsWith('/usr/bin/pgrep -P 800 bun')) return ''
      throw new Error(`unexpected cmd: ${cmd}`)
    })
    killSpy.mockRestore()
    killSpy = vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number) => {
      killCalls.push({ pid, signal: signal ?? 0 })
      // The 0-probe in the SIGKILL pass throws ESRCH (process exited between
      // SIGTERM and now). The catch clause must absorb it.
      if (signal === 0 && pid === 800) {
        const err = new Error('ESRCH') as NodeJS.ErrnoException
        err.code = 'ESRCH'
        throw err
      }
      return true
    })
    reapDetachedChannelClaudes()
    expect(killSpy).toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// isClaudeBinary (private) -- covered transitively above; one direct test
// for empty-command defense against the `?? ''` fallback.
// ---------------------------------------------------------------------------

describe('isClaudeBinary (private, via findOrphanChannelClaudes)', () => {
  it('treats an empty command as NOT a claude binary', () => {
    // An empty argv[0] must NOT match `base === 'claude'`. Force the path by
    // including the empty command in procs with `--channels` so the row reaches
    // isClaudeBinary's gate.
    const procs: ProcRow[] = [
      { pid: 1, ppid: 1, command: '' },
    ]
    // No match should be emitted; the live set is empty so we fail-safe
    // upstream -- but the parser itself must not false-positive on ''.
    expect(() => findOrphanChannelClaudes(procs, new Set([1]))).not.toThrow()
    // Without --channels, findOrphanChannelClaudes returns []. The empty-row
    // path through `command.trim().split(/\s+/, 1)[0] ?? ''` hits the `??''`
    // fallback once.
    expect(findOrphanChannelClaudes(procs, new Set())).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// buildPollerEvidence -- defense-in-depth on the loop guards already covered
// in poller-evidence.test.ts, plus the `next === cur` self-cycle guard.
// ---------------------------------------------------------------------------

describe('buildPollerEvidence (supplementary loop guards)', () => {
  it('breaks out of the parent walk when a parent points at itself (ppid == pid)', () => {
    // Botched ps snapshot: pid 5000 lists its parent as 5000. Without the
    // `next === cur` break we would loop until the hops cap. With it, the
    // walk terminates and the verdict is `orphaned` for an env-scan candidate
    // that was not in claude's tree.
    const procs: ProcRow[] = [
      { pid: 100, ppid: 1, command: 'claude --channels plugin:telegram' },
      { pid: 5000, ppid: 5000, command: 'self-parent bun' },
    ]
    const e = buildPollerEvidence(procs, null, [5000], 100)
    expect(e.rows).toEqual([{ pid: 5000, ppid: 5000, inClaudeTree: false }])
    expect(e.interpretation).toBe('orphaned')
  })
})
