// Coverage tests for src/web/channel-poller-reap.ts.
//
// The module has three layers:
//   1. Pure parsers/derivers: parsePollerPidsFromPs, buildPollerEvidence,
//      findOrphanChannelClaudes -- asserted directly, no I/O.
//   2. Thin shells over `ps`/`tmux`/`pgrep` (listPollerPidsByStateDir,
//      snapshotProcs, livePanePids, killBunChildren) -- reached through the
//      exported collectPollerEvidence / reapChannelOrphans /
//      reapDetachedChannelClaudes with node:child_process mocked. No real
//      subprocess ever runs.
//   3. Signal delivery -- process.kill is spied, so no real pid is ever
//      signalled (the pids in these tests are fabricated 5-digit numbers).
//
// Filesystem: readBotPid reads <agentDir>/.claude/channels/<provider>/bot.pid.
// Every test that needs that file builds it inside an os.tmpdir() sandbox via
// mkTempDir() and removes it in a finally block. The module never imports
// STORE_DIR or PROJECT_ROOT (channelStateDir takes the agent dir as an
// argument), so no config.js redirect is needed -- but nothing may write
// outside the tmpdir either, which the sandbox helper guarantees.

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mkTempDir, rmTempDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Mocks. vi.hoisted so the spies exist before the hoisted vi.mock factories
// run (the subject is imported statically below).
// ---------------------------------------------------------------------------

const { execSyncMock, execFileSyncMock, loggerMock } = vi.hoisted(() => ({
  execSyncMock: vi.fn<(cmd: string, opts?: unknown) => string>(),
  execFileSyncMock: vi.fn<(file: string, args?: readonly string[], opts?: unknown) => string>(),
  loggerMock: {
    info: vi.fn<(...args: unknown[]) => void>(),
    warn: vi.fn<(...args: unknown[]) => void>(),
    error: vi.fn<(...args: unknown[]) => void>(),
    debug: vi.fn<(...args: unknown[]) => void>(),
  },
}))

vi.mock('node:child_process', () => ({
  execSync: execSyncMock,
  execFileSync: execFileSyncMock,
  spawn: vi.fn(),
  spawnSync: vi.fn(),
  exec: vi.fn(),
  execFile: vi.fn(),
}))

vi.mock('../logger.js', () => ({ logger: loggerMock }))

import {
  parsePollerPidsFromPs,
  findOrphanChannelClaudes,
  buildPollerEvidence,
  collectPollerEvidence,
  reapChannelOrphans,
  reapDetachedChannelClaudes,
  type ProcRow,
} from '../web/channel-poller-reap.js'

// ---------------------------------------------------------------------------
// execSync router: each of the four shell-outs the module makes gets its own
// scripted reply (string) or failure (Error) per test.
// ---------------------------------------------------------------------------

interface ExecScript {
  psEnv?: string | Error
  psSnapshot?: string | Error
  tmuxPanes?: string | Error
  pgrep?: string | Error
}

let script: ExecScript = {}

function reply(value: string | Error | undefined): string {
  if (value === undefined) return ''
  if (value instanceof Error) throw value
  return value
}

/** Signals recorded by the process.kill spy, in delivery order. */
let signals: Array<{ pid: number; signal: string | number | undefined }> = []
/** pids for which the spy throws ESRCH (i.e. the process is already gone). */
let deadPids = new Set<number>()

beforeEach(() => {
  script = {}
  signals = []
  deadPids = new Set()
  execSyncMock.mockReset()
  execSyncMock.mockImplementation((cmd: string): string => {
    if (cmd.startsWith('/bin/ps eww')) return reply(script.psEnv)
    if (cmd.startsWith('/bin/ps -axww')) return reply(script.psSnapshot)
    if (cmd.includes('list-panes')) return reply(script.tmuxPanes)
    if (cmd.includes('pgrep')) return reply(script.pgrep)
    throw new Error(`unexpected execSync in test: ${cmd}`)
  })
  execFileSyncMock.mockReset()
  execFileSyncMock.mockReturnValue('')
  loggerMock.info.mockReset()
  loggerMock.warn.mockReset()
  loggerMock.error.mockReset()
  loggerMock.debug.mockReset()
  vi.spyOn(process, 'kill').mockImplementation((pid: number, signal?: string | number): true => {
    signals.push({ pid, signal })
    if (deadPids.has(pid)) throw new Error(`ESRCH ${pid}`)
    return true
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// Sandbox helpers: build <sandbox>/.claude/channels/<sub>/bot.pid and hand the
// agent dir back. The caller removes the sandbox in a finally block.
// ---------------------------------------------------------------------------

function mkAgentDir(): string {
  return mkTempDir('channel-poller-reap-')
}

function chanDirOf(agentDir: string, sub = 'telegram'): string {
  return join(agentDir, '.claude', 'channels', sub)
}

/** Writes bot.pid with `content`; pass null to leave the file absent. */
function seedChanDir(agentDir: string, content: string | null, sub = 'telegram'): string {
  const dir = chanDirOf(agentDir, sub)
  mkdirSync(dir, { recursive: true })
  if (content !== null) writeFileSync(join(dir, 'bot.pid'), content)
  return dir
}

// ===========================================================================
// parsePollerPidsFromPs
// ===========================================================================

// Sample rows captured from a real `ps eww -e` on macOS during the
// 2026-06-01 channel-disconnect incident. The bun poller, the slack
// node server, and a shell - the env-var match must select ONLY the
// bun poller and only when the state dir matches.
const PS_SAMPLE = [
  '  90798 s000  S+     0:00.01 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --silent start HOME=/Users/x PATH=/opt/homebrew/bin TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram CLAUDE_CODE_SESSION_ID=abc',
  '  90799 s000  S+     0:00.15 node /Users/x/.claude/plugins/cache/marveen-marketplace/slack-channel/0.1.0/server.ts HOME=/Users/x SLACK_STATE_DIR=/Users/x/ClaudeClaw/agents/samu/.claude/channels/slack',
  '  90800 s000  S+     0:00.05 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 --silent start HOME=/Users/x TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/agents/boni/.claude/channels/telegram',
  '   1234 s000  Ss     0:00.00 /bin/zsh HOME=/Users/x SHELL=/bin/zsh',
].join('\n')

describe('parsePollerPidsFromPs', () => {
  it('returns the bun poller pid matching the TELEGRAM_STATE_DIR for samu', () => {
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram',
    )
    expect(pids).toEqual([90798])
  })

  it('returns the slack poller pid for the SLACK_STATE_DIR variant', () => {
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'SLACK_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/samu/.claude/channels/slack',
    )
    expect(pids).toEqual([90799])
  })

  it('does NOT match a different agent that uses the same env var', () => {
    // The samu reap must not kill boni's poller, even though both have the
    // TELEGRAM_STATE_DIR env var set; only the full path matches.
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/samu/.claude/channels/telegram',
    )
    expect(pids).not.toContain(90800)
  })

  it('returns empty array when no row matches', () => {
    const pids = parsePollerPidsFromPs(
      PS_SAMPLE,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/agents/nobody/.claude/channels/telegram',
    )
    expect(pids).toEqual([])
  })

  it('returns multiple pids when several rows match (a real orphan scenario)', () => {
    // Two bun pollers against the same channel dir - the bug that triggered
    // this work item. Both must be reaped.
    const orphans = [
      '  29932 ttys001  S+   77:09.33 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 start HOME=/Users/x TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/.claude/channels/telegram',
      '  91234 ttys002  S+    0:00.01 bun run --cwd /Users/x/.claude/plugins/cache/claude-plugins-official/telegram/0.0.6 start HOME=/Users/x TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/.claude/channels/telegram',
    ].join('\n')
    const pids = parsePollerPidsFromPs(
      orphans,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/.claude/channels/telegram',
    )
    expect(pids).toEqual([29932, 91234])
  })

  it('ignores rows where the path appears only in argv (not as an env-var value)', () => {
    // Defensive: a row that *mentions* the state dir in its --cwd argv must
    // not be confused with one that actually has the env var. argv values
    // are not preceded by the literal `TELEGRAM_STATE_DIR=` prefix.
    const argvMention = '  55555 s000  S+   0:00.00 grep TELEGRAM_STATE_DIR /Users/x/ClaudeClaw/.claude/channels/telegram'
    const pids = parsePollerPidsFromPs(
      argvMention,
      'TELEGRAM_STATE_DIR',
      '/Users/x/ClaudeClaw/.claude/channels/telegram',
    )
    // The needle `TELEGRAM_STATE_DIR=/Users/x/ClaudeClaw/.claude/channels/telegram`
    // is NOT present in this row (the argv has space, not `=`), so no match.
    expect(pids).toEqual([])
  })

  it('drops pid 0 and pid 1 even if such a row could be crafted', () => {
    const malformed = '   1 ttys000  S+  0:00.00 fake-init TELEGRAM_STATE_DIR=/x'
    const pids = parsePollerPidsFromPs(malformed, 'TELEGRAM_STATE_DIR', '/x')
    expect(pids).toEqual([])
  })

  it('skips a matching row that has no leading pid column (header / wrapped line)', () => {
    // `ps` wraps very long environments onto continuation lines that carry no
    // pid. Such a line matches the needle but must not yield a pid.
    const wrapped = [
      'PID   TT  STAT  TIME COMMAND',
      '   ...continuation... TELEGRAM_STATE_DIR=/x more=env',
    ].join('\n')
    expect(parsePollerPidsFromPs(wrapped, 'TELEGRAM_STATE_DIR', '/x')).toEqual([])
  })
})

// ===========================================================================
// buildPollerEvidence (pure)
// ===========================================================================

const CLAUDE_PID = 5000

describe('buildPollerEvidence', () => {
  it('reports no-poller when neither bot.pid nor the env scan resolves a live process', () => {
    const ev = buildPollerEvidence([], 4242, [4243], CLAUDE_PID)
    expect(ev).toEqual({
      botPid: 4242,
      botPidAlive: false,
      envScanPids: [4243],
      rows: [],
      interpretation: 'no-poller',
    })
  })

  it('reports in-tree when the bot.pid poller is a direct child of claude (probe was wrong)', () => {
    const procs: ProcRow[] = [
      { pid: 6001, ppid: CLAUDE_PID, command: 'bun run start' },
      { pid: CLAUDE_PID, ppid: 400, command: 'claude --channels' },
    ]
    const ev = buildPollerEvidence(procs, 6001, [], CLAUDE_PID)
    expect(ev.botPidAlive).toBe(true)
    expect(ev.rows).toEqual([{ pid: 6001, ppid: CLAUDE_PID, inClaudeTree: true }])
    expect(ev.interpretation).toBe('in-tree')
  })

  it('treats the claude pid itself as in-tree (first-hop identity match)', () => {
    const procs: ProcRow[] = [{ pid: CLAUDE_PID, ppid: 1, command: 'claude --channels' }]
    const ev = buildPollerEvidence(procs, CLAUDE_PID, [], CLAUDE_PID)
    expect(ev.interpretation).toBe('in-tree')
  })

  it('reports orphaned when a live poller was reparented to init (ppid <= 1)', () => {
    const procs: ProcRow[] = [{ pid: 6002, ppid: 1, command: 'bun run start' }]
    const ev = buildPollerEvidence(procs, null, [6002], CLAUDE_PID)
    expect(ev.botPid).toBeNull()
    expect(ev.botPidAlive).toBe(false)
    expect(ev.rows).toEqual([{ pid: 6002, ppid: 1, inClaudeTree: false }])
    expect(ev.interpretation).toBe('orphaned')
  })

  it('stops the ancestor walk when the parent is missing from the ps snapshot', () => {
    // ppid 9999 is not in `procs` -> byPid.get(9999)?.ppid is undefined.
    const procs: ProcRow[] = [{ pid: 6003, ppid: 9999, command: 'bun run start' }]
    const ev = buildPollerEvidence(procs, null, [6003], CLAUDE_PID)
    expect(ev.rows[0]?.inClaudeTree).toBe(false)
  })

  it('stops the ancestor walk on a self-parenting row (ppid === pid)', () => {
    const procs: ProcRow[] = [{ pid: 6004, ppid: 6004, command: 'bun run start' }]
    const ev = buildPollerEvidence(procs, null, [6004], CLAUDE_PID)
    expect(ev.rows[0]?.inClaudeTree).toBe(false)
    expect(ev.interpretation).toBe('orphaned')
  })

  it('stops the ancestor walk on a ppid cycle instead of looping forever', () => {
    const procs: ProcRow[] = [
      { pid: 6005, ppid: 6006, command: 'bun run start' },
      { pid: 6006, ppid: 6005, command: 'sh -c bun' },
    ]
    const ev = buildPollerEvidence(procs, null, [6005], CLAUDE_PID)
    expect(ev.rows[0]?.inClaudeTree).toBe(false)
  })

  it('gives up after 8 hops even if claude is further up the chain', () => {
    // 6100 -> 6101 -> ... -> 6110 -> CLAUDE_PID: claude sits 11 hops away, so
    // the bounded walk must NOT find it.
    const procs: ProcRow[] = []
    for (let i = 0; i < 10; i++) procs.push({ pid: 6100 + i, ppid: 6101 + i, command: 'sh -c bun' })
    procs.push({ pid: 6110, ppid: CLAUDE_PID, command: 'sh -c bun' })
    procs.push({ pid: CLAUDE_PID, ppid: 1, command: 'claude --channels' })
    const ev = buildPollerEvidence(procs, null, [6100], CLAUDE_PID)
    expect(ev.rows[0]?.inClaudeTree).toBe(false)
    expect(ev.interpretation).toBe('orphaned')
  })

  it('drops dead candidates and keeps live ones, merging bot.pid into the env-scan set', () => {
    const procs: ProcRow[] = [{ pid: 6007, ppid: 1, command: 'bun run start' }]
    // 6008 is in the env scan but not in ps -> dead, dropped. 6007 appears in
    // BOTH the scan and bot.pid -> deduplicated to a single row.
    const ev = buildPollerEvidence(procs, 6007, [6007, 6008], CLAUDE_PID)
    expect(ev.rows.map((r) => r.pid)).toEqual([6007])
    expect(ev.envScanPids).toEqual([6007, 6008])
    expect(ev.botPidAlive).toBe(true)
  })

  it('marks in-tree when ANY row is under claude, even with an orphan alongside', () => {
    const procs: ProcRow[] = [
      { pid: 6009, ppid: 1, command: 'bun run start' },
      { pid: 6010, ppid: CLAUDE_PID, command: 'bun run start' },
      { pid: CLAUDE_PID, ppid: 1, command: 'claude --channels' },
    ]
    const ev = buildPollerEvidence(procs, null, [6009, 6010], CLAUDE_PID)
    expect(ev.interpretation).toBe('in-tree')
  })
})

// ===========================================================================
// collectPollerEvidence (ps + fs shells)
// ===========================================================================

describe('collectPollerEvidence', () => {
  it('combines bot.pid, the env scan and the ps snapshot into one verdict', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, '7001\n')
      script.psEnv = `  7001 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`
      script.psSnapshot = [
        `  7001   ${CLAUDE_PID} bun run start`,
        `  ${CLAUDE_PID}     1 claude --channels`,
      ].join('\n')
      const ev = collectPollerEvidence('telegram', agentDir, CLAUDE_PID)
      expect(ev.botPid).toBe(7001)
      expect(ev.botPidAlive).toBe(true)
      expect(ev.envScanPids).toEqual([7001])
      expect(ev.interpretation).toBe('in-tree')
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('uses the provider-specific env var (slack -> SLACK_STATE_DIR)', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, '7002', 'slack')
      script.psEnv = `  7002 s000 S+ 0:00.01 node server.ts SLACK_STATE_DIR=${chanDir}`
      script.psSnapshot = '  7002     1 node server.ts'
      const ev = collectPollerEvidence('slack', agentDir, CLAUDE_PID)
      expect(ev.envScanPids).toEqual([7002])
      expect(ev.interpretation).toBe('orphaned')
    } finally {
      rmTempDir(agentDir)
    }
  })

  it.each([
    ['discord', 'DISCORD_STATE_DIR'],
    ['googlechat', 'GOOGLECHAT_STATE_DIR'],
    ['teams', 'TEAMS_STATE_DIR'],
  ] as const)('maps provider %s to %s', (provider, envVar) => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, null, provider)
      script.psEnv = `  7100 s000 S+ 0:00.01 node bot.js ${envVar}=${chanDir}`
      script.psSnapshot = '  7100     1 node bot.js'
      const ev = collectPollerEvidence(provider, agentDir, CLAUDE_PID)
      expect(ev.botPid).toBeNull()
      expect(ev.envScanPids).toEqual([7100])
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('returns an empty env scan and warns when `ps eww` fails', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, null)
      script.psEnv = new Error('ps eww: boom')
      script.psSnapshot = ''
      const ev = collectPollerEvidence('telegram', agentDir, CLAUDE_PID)
      expect(ev.envScanPids).toEqual([])
      expect(ev.interpretation).toBe('no-poller')
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ chanDir: chanDirOf(agentDir) }),
        'channel-poller-reap: ps scan failed',
      )
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('returns an empty snapshot and warns when `ps -axww` fails', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, '7003')
      script.psEnv = `  7003 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`
      script.psSnapshot = new Error('ps -axww: boom')
      const ev = collectPollerEvidence('telegram', agentDir, CLAUDE_PID)
      expect(ev.rows).toEqual([])
      expect(ev.botPidAlive).toBe(false)
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ err: expect.anything() }),
        'channel-poller-reap: ps -axww snapshot failed',
      )
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('skips ps snapshot lines that do not parse as `pid ppid command`', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, '7004')
      script.psEnv = ''
      script.psSnapshot = [
        '  PID  PPID COMMAND', // header: no leading digits
        '',                    // blank line
        '  7004     1 bun run start',
      ].join('\n')
      const ev = collectPollerEvidence('telegram', agentDir, CLAUDE_PID)
      expect(ev.rows).toEqual([{ pid: 7004, ppid: 1, inClaudeTree: false }])
    } finally {
      rmTempDir(agentDir)
    }
  })
})

// ===========================================================================
// readBotPid, exercised through reapChannelOrphans().source.fromBotPid
// ===========================================================================

describe('readBotPid (via reapChannelOrphans source)', () => {
  it('returns null when bot.pid does not exist', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, null)
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.source.fromBotPid).toBeNull()
      expect(res.reaped).toEqual([])
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('trims whitespace around a valid pid', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, '  8001\n')
      // Identity check (channel-poller-reap-botpid-killed-without-identity-check)
      // requires the env scan to corroborate bot.pid, so seed the matching row.
      script.psEnv = `  8001 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.source.fromBotPid).toBe(8001)
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('returns null for non-numeric bot.pid content', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, 'not-a-pid')
      expect(reapChannelOrphans('telegram', agentDir).source.fromBotPid).toBeNull()
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('returns null for pid 1 (never signal init)', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, '1')
      expect(reapChannelOrphans('telegram', agentDir).source.fromBotPid).toBeNull()
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('returns null when bot.pid exists but cannot be read (a directory)', () => {
    const agentDir = mkAgentDir()
    try {
      // existsSync passes, readFileSync throws EISDIR -> caught -> null.
      mkdirSync(join(chanDirOf(agentDir), 'bot.pid'), { recursive: true })
      expect(reapChannelOrphans('telegram', agentDir).source.fromBotPid).toBeNull()
    } finally {
      rmTempDir(agentDir)
    }
  })
})

// ===========================================================================
// reapChannelOrphans
// ===========================================================================

describe('reapChannelOrphans', () => {
  it('is a no-op when nothing is found: no sleep, no signals, no info log', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, null)
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res).toEqual({ reaped: [], source: { fromBotPid: null, fromEnvScan: [] } })
      expect(execFileSyncMock).not.toHaveBeenCalled()
      expect(signals).toEqual([])
      expect(loggerMock.info).not.toHaveBeenCalled()
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('reaps bot.pid first, dedupes it against the env scan, and SIGKILLs survivors', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, '8100')
      script.psEnv = [
        `  8100 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`,
        `  8101 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`,
      ].join('\n')
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.reaped).toEqual([8100, 8101])
      expect(res.source).toEqual({ fromBotPid: 8100, fromEnvScan: [8100, 8101] })
      expect(signals).toEqual([
        { pid: 8100, signal: 'SIGTERM' },
        { pid: 8101, signal: 'SIGTERM' },
        { pid: 8100, signal: 0 },
        { pid: 8100, signal: 'SIGKILL' },
        { pid: 8101, signal: 0 },
        { pid: 8101, signal: 'SIGKILL' },
      ])
      expect(execFileSyncMock).toHaveBeenCalledWith('/bin/sleep', ['0.3'], { timeout: 2000 })
      expect(loggerMock.info).toHaveBeenCalledWith(
        expect.objectContaining({ reaped: [8100, 8101], fromBotPid: 8100 }),
        'channel-poller-reap: orphans killed',
      )
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('reaps env-scan-only orphans when bot.pid is absent', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, null)
      script.psEnv = `  8200 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.reaped).toEqual([8200])
      expect(res.source.fromBotPid).toBeNull()
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('swallows ESRCH on SIGTERM and skips SIGKILL for a pid that died in the grace window', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, null)
      script.psEnv = [
        `  8300 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`,
        `  8301 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`,
      ].join('\n')
      deadPids = new Set([8300])
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.reaped).toEqual([8300, 8301])
      // 8300 throws on both the SIGTERM and the `signal 0` probe -> no SIGKILL.
      expect(signals.filter((s) => s.pid === 8300 && s.signal === 'SIGKILL')).toEqual([])
      expect(signals).toContainEqual({ pid: 8301, signal: 'SIGKILL' })
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('still SIGKILLs when the /bin/sleep grace call fails', () => {
    const agentDir = mkAgentDir()
    try {
      const chanDir = seedChanDir(agentDir, null)
      script.psEnv = `  8400 s000 S+ 0:00.01 bun run start TELEGRAM_STATE_DIR=${chanDir}`
      execFileSyncMock.mockImplementation(() => { throw new Error('sleep: not found') })
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.reaped).toEqual([8400])
      expect(signals).toContainEqual({ pid: 8400, signal: 'SIGKILL' })
    } finally {
      rmTempDir(agentDir)
    }
  })

  // channel-poller-reap-botpid-killed-without-identity-check (FIXED):
  // the bot.pid half of the reaper now requires identity corroboration -- a pid
  // that the live env scan does not see is no longer SIGTERMed or SIGKILLed.
  // With a stale bot.pid (nothing ever deletes it) plus pid reuse, the old
  // behaviour killed an unrelated process; the identity check closes that hole
  // by refusing to signal any pid the snapshot cannot confirm is still a poller.
  it('drops a bot.pid pid that the env scan does not corroborate', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, '9101')
      script.psEnv = '' // no process carries TELEGRAM_STATE_DIR=<chanDir>
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.source).toEqual({ fromBotPid: null, fromEnvScan: [] })
      expect(res.reaped).toEqual([])
      expect(signals).toEqual([])
    } finally {
      rmTempDir(agentDir)
    }
  })

  it('returns an empty reap and warns when the ps scan fails and bot.pid is absent', () => {
    const agentDir = mkAgentDir()
    try {
      seedChanDir(agentDir, null)
      script.psEnv = new Error('ps: boom')
      const res = reapChannelOrphans('telegram', agentDir)
      expect(res.reaped).toEqual([])
      expect(loggerMock.warn).toHaveBeenCalledWith(
        expect.objectContaining({ chanDir: chanDirOf(agentDir) }),
        'channel-poller-reap: ps scan failed',
      )
    } finally {
      rmTempDir(agentDir)
    }
  })
})

// ===========================================================================
// findOrphanChannelClaudes (pure)
// ===========================================================================

// Rows modeled on the live 2026-06-03 incident snapshot. The tmux SERVER pid
// is 35874; the live marveen-channels pane leader is the claude at 76621
// (claudePid == panePid for the main session). 57158 + the 70xxx claudes are
// detached --continue leftovers reparented to the tmux server (ppid 35874).
// A live sub-agent is modeled as a pane shell (77189) with a claude child.
const CLAUDE = '/opt/homebrew/bin/claude'
const PROCS: ProcRow[] = [
  // tmux server: argv EMBEDS the claude --channels string -> must NOT match.
  { pid: 35874, ppid: 1, command: '/opt/homebrew/bin/tmux new-session -d -s marveen-channels -c /Users/x/ClaudeClaw /opt/homebrew/bin/claude --dangerously-skip-permissions --channels plugin:telegram@claude-plugins-official' },
  // live main session: claude is the pane leader (pid == panePid 76621).
  { pid: 76621, ppid: 35874, command: `${CLAUDE} --dangerously-skip-permissions --model claude-opus-4-8[1m] --channels plugin:telegram@claude-plugins-official` },
  // live sub-agent: pane leader is the shell (77189), claude is its child.
  { pid: 78001, ppid: 77189, command: `${CLAUDE} --continue --dangerously-skip-permissions --model claude-opus-4-8[1m] --channels plugin:telegram@claude-plugins-official` },
  // detached orphans: reparented to the tmux server, no live pane in ancestry.
  { pid: 57158, ppid: 35874, command: `${CLAUDE} --dangerously-skip-permissions --model claude-opus-4-8[1m] --channels plugin:telegram@claude-plugins-official` },
  { pid: 70459, ppid: 35874, command: `${CLAUDE} --continue --dangerously-skip-permissions --model deepseek-v4-pro --channels plugin:telegram@claude-plugins-official` },
  // unrelated processes that must be ignored.
  { pid: 90000, ppid: 1, command: '/opt/homebrew/bin/node /Users/x/ClaudeClaw/dist/web.js' },
  { pid: 90001, ppid: 1, command: `${CLAUDE} --dangerously-skip-permissions --model claude-opus-4-8[1m]` }, // claude, but no --channels
]
const LIVE_PANES = new Set<number>([76621, 77189, 44349])

describe('findOrphanChannelClaudes', () => {
  it('reaps detached channel claudes, spares live panes and the tmux server', () => {
    const orphans = findOrphanChannelClaudes(PROCS, LIVE_PANES)
    expect(orphans.sort((a, b) => a - b)).toEqual([57158, 70459])
  })

  it('spares the live main-session claude (pid == pane pid)', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(76621)
  })

  it('spares a live sub-agent claude whose parent is the live pane shell', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(78001)
  })

  it('never matches the tmux server even though its argv embeds the claude command', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(35874)
  })

  it('ignores claude processes without --channels', () => {
    expect(findOrphanChannelClaudes(PROCS, LIVE_PANES)).not.toContain(90001)
  })

  it('honors a channelNeedle filter (only telegram orphans, not slack)', () => {
    const withSlack: ProcRow[] = [
      ...PROCS,
      { pid: 71000, ppid: 35874, command: `${CLAUDE} --continue --channels plugin:slack-channel@marveen-marketplace` },
    ]
    const tg = findOrphanChannelClaudes(withSlack, LIVE_PANES, 'plugin:telegram@claude-plugins-official')
    expect(tg).not.toContain(71000)
    expect(tg.sort((a, b) => a - b)).toEqual([57158, 70459])
  })

  it('returns empty when there are no detached channel claudes', () => {
    const allLive: ProcRow[] = [
      { pid: 76621, ppid: 35874, command: `${CLAUDE} --channels plugin:telegram@claude-plugins-official` },
    ]
    expect(findOrphanChannelClaudes(allLive, new Set([76621]))).toEqual([])
  })

  it('ignores a bare `--channels` argv with no binary at argv[0]', () => {
    // argv[0] is the flag itself -> basename is not `claude` -> skipped.
    const rows: ProcRow[] = [{ pid: 72000, ppid: 1, command: '  --channels plugin:telegram@claude-plugins-official' }]
    expect(findOrphanChannelClaudes(rows, LIVE_PANES)).toEqual([])
  })

  it('matches a bare `claude` argv[0] with no directory component', () => {
    const rows: ProcRow[] = [{ pid: 72001, ppid: 1, command: 'claude --channels plugin:telegram@claude-plugins-official' }]
    expect(findOrphanChannelClaudes(rows, LIVE_PANES)).toEqual([72001])
  })

  it('stops the pane walk when an ancestor is missing from the snapshot', () => {
    const rows: ProcRow[] = [{ pid: 72002, ppid: 99999, command: `${CLAUDE} --channels plugin:telegram@x` }]
    expect(findOrphanChannelClaudes(rows, LIVE_PANES)).toEqual([72002])
  })

  it('stops the pane walk on a self-parenting row (ppid === pid)', () => {
    const rows: ProcRow[] = [{ pid: 72003, ppid: 72003, command: `${CLAUDE} --channels plugin:telegram@x` }]
    expect(findOrphanChannelClaudes(rows, LIVE_PANES)).toEqual([72003])
  })

  it('stops the pane walk on a ppid cycle', () => {
    const rows: ProcRow[] = [
      { pid: 72004, ppid: 72005, command: `${CLAUDE} --channels plugin:telegram@x` },
      { pid: 72005, ppid: 72004, command: 'sh -c claude' },
    ]
    expect(findOrphanChannelClaudes(rows, LIVE_PANES)).toEqual([72004])
  })

  it('gives up after 8 hops, so a claude 11 levels below a live pane looks orphaned', () => {
    // Documents the bound, not a wish: the walk is capped at 8 hops.
    const rows: ProcRow[] = [{ pid: 73000, ppid: 73001, command: `${CLAUDE} --channels plugin:telegram@x` }]
    for (let i = 1; i < 10; i++) rows.push({ pid: 73000 + i, ppid: 73001 + i, command: 'sh -c claude' })
    rows.push({ pid: 73010, ppid: 76621, command: 'sh -c claude' })
    expect(findOrphanChannelClaudes(rows, LIVE_PANES)).toContain(73000)
  })
})

// ===========================================================================
// reapDetachedChannelClaudes
// ===========================================================================

const TMUX_CMD = "tmux list-panes -a -F '#{pane_pid}'"

describe('reapDetachedChannelClaudes', () => {
  it('kills bun children then the detached claude, defaulting tmuxPath to bare `tmux`', () => {
    script.psSnapshot = [
      `  35874     1 /opt/homebrew/bin/tmux new-session -d -s marveen-channels ${CLAUDE} --channels plugin:telegram@x`,
      `  76621 35874 ${CLAUDE} --channels plugin:telegram@x`,
      `  57158 35874 ${CLAUDE} --continue --channels plugin:telegram@x`,
    ].join('\n')
    script.tmuxPanes = '76621\n'
    script.pgrep = '58000\n58001\n\nnot-a-pid\n1\n'

    const reaped = reapDetachedChannelClaudes()

    expect(reaped).toEqual([57158])
    expect(execSyncMock).toHaveBeenCalledWith(TMUX_CMD, expect.anything())
    expect(execSyncMock).toHaveBeenCalledWith('/usr/bin/pgrep -P 57158 bun', expect.anything())
    // bun children first (SIGTERM), then the claude, then the SIGKILL sweep.
    expect(signals).toEqual([
      { pid: 58000, signal: 'SIGTERM' },
      { pid: 58001, signal: 'SIGTERM' },
      { pid: 57158, signal: 'SIGTERM' },
      { pid: 57158, signal: 0 },
      { pid: 57158, signal: 'SIGKILL' },
    ])
    expect(execFileSyncMock).toHaveBeenCalledWith('/bin/sleep', ['0.3'], { timeout: 2000 })
    expect(loggerMock.info).toHaveBeenCalledWith(
      { reaped: [57158], channelNeedle: '(all)' },
      'channel-poller-reap: detached channel claudes killed',
    )
  })

  it('honors an explicit tmuxPath and logs the channelNeedle it filtered on', () => {
    script.psSnapshot = [
      `  76621 35874 ${CLAUDE} --channels plugin:telegram@x`,
      `  57158 35874 ${CLAUDE} --channels plugin:telegram@x`,
      `  57159 35874 ${CLAUDE} --channels plugin:slack-channel@y`,
    ].join('\n')
    script.tmuxPanes = '76621'
    script.pgrep = new Error('pgrep: no match') // exit 1 -> swallowed

    const reaped = reapDetachedChannelClaudes({
      channelNeedle: 'plugin:telegram@x',
      tmuxPath: '/opt/homebrew/bin/tmux',
    })

    expect(reaped).toEqual([57158])
    expect(execSyncMock).toHaveBeenCalledWith(
      "/opt/homebrew/bin/tmux list-panes -a -F '#{pane_pid}'",
      expect.anything(),
    )
    expect(loggerMock.info).toHaveBeenCalledWith(
      { reaped: [57158], channelNeedle: 'plugin:telegram@x' },
      'channel-poller-reap: detached channel claudes killed',
    )
  })

  it('swallows ESRCH from a bun child and from the claude itself', () => {
    script.psSnapshot = `  57158 35874 ${CLAUDE} --channels plugin:telegram@x`
    script.tmuxPanes = '76621'
    script.pgrep = '58000'
    deadPids = new Set([58000, 57158])

    expect(reapDetachedChannelClaudes()).toEqual([57158])
    // The `signal 0` probe throws too, so no SIGKILL is attempted.
    expect(signals).toEqual([
      { pid: 58000, signal: 'SIGTERM' },
      { pid: 57158, signal: 'SIGTERM' },
      { pid: 57158, signal: 0 },
    ])
  })

  it('still SIGKILLs when the /bin/sleep grace call fails', () => {
    script.psSnapshot = `  57158 35874 ${CLAUDE} --channels plugin:telegram@x`
    script.tmuxPanes = '76621'
    execFileSyncMock.mockImplementation(() => { throw new Error('sleep: not found') })

    expect(reapDetachedChannelClaudes()).toEqual([57158])
    expect(signals).toContainEqual({ pid: 57158, signal: 'SIGKILL' })
  })

  it('refuses to reap (fail-safe) when tmux list-panes fails', () => {
    script.psSnapshot = `  57158 35874 ${CLAUDE} --channels plugin:telegram@x`
    script.tmuxPanes = new Error('no server running')

    expect(reapDetachedChannelClaudes()).toEqual([])
    expect(signals).toEqual([])
    expect(loggerMock.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.anything() }),
      'channel-poller-reap: tmux list-panes failed',
    )
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'channel-poller-reap: no live panes resolved, skipping detached-claude reap (fail-safe)',
    )
  })

  it('refuses to reap when tmux returns only unusable pane pids (garbage / pid 1)', () => {
    script.psSnapshot = `  57158 35874 ${CLAUDE} --channels plugin:telegram@x`
    script.tmuxPanes = '\nnot-a-pid\n1\n'

    expect(reapDetachedChannelClaudes()).toEqual([])
    expect(signals).toEqual([])
  })

  it('does nothing (no sleep, no log) when every channel claude is attached to a live pane', () => {
    script.psSnapshot = `  76621 35874 ${CLAUDE} --channels plugin:telegram@x`
    script.tmuxPanes = '76621'

    expect(reapDetachedChannelClaudes({})).toEqual([])
    expect(execFileSyncMock).not.toHaveBeenCalled()
    expect(signals).toEqual([])
    expect(loggerMock.info).not.toHaveBeenCalled()
  })
})
