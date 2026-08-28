// 100% coverage test for src/web/schedule-mcp-precheck.ts.
//
// This file complements src/__tests__/schedule-mcp-precheck.test.ts by
// covering the lines left untested there:
//
//   lines 48-69:  resolveMcpProcessPatterns -- the per-agent config merge,
//                 including missing files, parse errors, and the agentDir
//                 throw path (unknown agent).
//   lines 145-173: checkTaskMcpRequirements -- the orchestration entry point,
//                 covering every fail-open branch (empty required, remote
//                 host, no claude pid, ps failure) and the happy path with
//                 the unknown-servers debug log.
//
// Sandbox: fs / child_process are mocked at module-load time so no real
// /bin/ps or /tmp paths are touched. PROJECT_ROOT is redirected to a tmpdir
// by the shared setupFiles layer (test-sandbox-setup.ts). agent-config.ts
// is fully mocked -- its agentDir() is exercised through resolveMcpProcessPatterns.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Hoisted mock fns.
// ---------------------------------------------------------------------------
const {
  mockExistsSync,
  mockReadFileSync,
  mockExecFileSync,
  mockAgentDir,
  mockGetClaudePidForSession,
  PROJECT_ROOT,
} = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join: pathJoin } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  return {
    mockExistsSync: vi.fn(),
    mockReadFileSync: vi.fn(),
    mockExecFileSync: vi.fn(),
    mockAgentDir: vi.fn<(name: string) => string>(),
    mockGetClaudePidForSession: vi.fn<(session: string) => number | null>(),
    PROJECT_ROOT: pathJoin(tmpdir(), `mcp-precheck-${stamp}`),
  }
})

// ---------------------------------------------------------------------------
// Mock factories. The test-sandbox-setup layer redirects PROJECT_ROOT through
// its own hoisted mock; we shadow it here so resolveMcpProcessPatterns sees
// our tmpdir (the per-file sandbox is fine, but we use a separate one for
// clarity).
// ---------------------------------------------------------------------------
vi.mock('../config.js', () => ({
  PROJECT_ROOT,
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}))

vi.mock('node:fs', () => ({
  existsSync: (...args: unknown[]) => mockExistsSync(...args),
  readFileSync: (...args: unknown[]) => mockReadFileSync(...args),
}))

vi.mock('node:child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
}))

vi.mock('../web/agent-config.js', () => ({
  agentDir: (name: string) => mockAgentDir(name),
}))

vi.mock('../channel-coordinator/liveness.js', () => ({
  getClaudePidForSession: (session: string) => mockGetClaudePidForSession(session),
}))

// ---------------------------------------------------------------------------
// Per-test reset.
// ---------------------------------------------------------------------------
beforeEach(() => {
  vi.clearAllMocks()
  // Defaults that exercise the COMMON path; individual tests override as needed.
  mockExistsSync.mockReturnValue(false)
  mockReadFileSync.mockReturnValue('{}')
  mockAgentDir.mockImplementation((name: string) => join(PROJECT_ROOT, 'agents', name))
  mockGetClaudePidForSession.mockReturnValue(null)
  mockExecFileSync.mockReturnValue('')
})

// ---------------------------------------------------------------------------
// Fresh-module helper. resolveMcpProcessPatterns and checkTaskMcpRequirements
// share a module-scope nothing-but-types footprint, but using vi.resetModules
// keeps each test's mock wiring isolated.
// ---------------------------------------------------------------------------
async function loadSUT(): Promise<typeof import('../web/schedule-mcp-precheck.js')> {
  vi.resetModules()
  return await import('../web/schedule-mcp-precheck.js')
}

// ===========================================================================
// resolveMcpProcessPatterns -- file merge, missing/parse failures, agentDir
// throw path.
// ===========================================================================
describe('resolveMcpProcessPatterns', () => {
  it('returns {} when the project-root .mcp.json does not exist', async () => {
    mockExistsSync.mockReturnValue(false)

    const { resolveMcpProcessPatterns } = await loadSUT()
    const out = resolveMcpProcessPatterns(null)
    expect(out).toEqual({})
    expect(mockReadFileSync).not.toHaveBeenCalled()
  })

  it('returns {} for an empty mcpServers map', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: {} }))

    const { resolveMcpProcessPatterns } = await loadSUT()
    expect(resolveMcpProcessPatterns(null)).toEqual({})
  })

  it('parses the project-root .mcp.json when agentName is null', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        gmail: { command: 'node', args: ['/abs/path/gmail-mcp/dist/index.js'] },
        'bare-binary': { command: 'garmin-mcp', args: [] },
      },
    }))

    const { resolveMcpProcessPatterns } = await loadSUT()
    const out = resolveMcpProcessPatterns(null)
    expect(out).toEqual({
      gmail: '/abs/path/gmail-mcp/dist/index.js',
      'bare-binary': 'garmin-mcp',
    })
    // Only the project-root .mcp.json is consulted when agentName is null.
    expect(mockReadFileSync).toHaveBeenCalledTimes(1)
    expect(mockReadFileSync).toHaveBeenCalledWith(join(PROJECT_ROOT, '.mcp.json'), 'utf-8')
  })

  it('merges agent config over the project-root config (agent wins on name collision)', async () => {
    mockExistsSync.mockReturnValue(true)
    // First call: project-root .mcp.json. Second call: agent's .mcp.json.
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        mcpServers: {
          gmail: { command: 'node', args: ['/root/gmail/index.js'] },
          shared: { command: 'shared-root' },
        },
      }))
      .mockReturnValueOnce(JSON.stringify({
        mcpServers: {
          gmail: { command: 'node', args: ['/agent/gmail/index.js'] },
          'agent-only': { command: 'agent-only' },
        },
      }))

    const { resolveMcpProcessPatterns } = await loadSUT()
    const out = resolveMcpProcessPatterns('samu')
    expect(out['gmail']).toBe('/agent/gmail/index.js')   // agent overrides root
    expect(out['shared']).toBe('shared-root')              // inherited from root
    expect(out['agent-only']).toBe('agent-only')           // only in agent config
  })

  it('skips agent config when agentDir throws (unknown agent)', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: { gmail: { command: 'gmail' } },
    }))
    mockAgentDir.mockImplementation(() => {
      throw new Error('unsafe path component')
    })

    const { resolveMcpProcessPatterns } = await loadSUT()
    const out = resolveMcpProcessPatterns('???')
    // Only the project-root config is consulted; agentDir's throw is swallowed.
    expect(out).toEqual({ gmail: 'gmail' })
    // Just the one read for the root config.
    expect(mockReadFileSync).toHaveBeenCalledTimes(1)
  })

  it('skips an unparsable project-root .mcp.json without throwing', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue('not-json{{{')

    const { resolveMcpProcessPatterns } = await loadSUT()
    expect(() => resolveMcpProcessPatterns(null)).not.toThrow()
    expect(resolveMcpProcessPatterns(null)).toEqual({})
  })

  it('skips an unparsable agent .mcp.json without throwing', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        mcpServers: { gmail: { command: 'gmail' } },
      }))
      .mockReturnValueOnce('also broken{{{')

    const { resolveMcpProcessPatterns } = await loadSUT()
    const out = resolveMcpProcessPatterns('samu')
    // Project-root config still applies; agent config is dropped.
    expect(out).toEqual({ gmail: 'gmail' })
  })

  it('ignores servers whose pattern cannot be derived (no command, no args)', async () => {
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        'with-script': { command: 'node', args: ['/abs/x.js'] },
        // completely-empty has neither command nor any args containing '/'
        // -- deriveProcessPattern returns null for it.
        'completely-empty': {},
      },
    }))

    const { resolveMcpProcessPatterns } = await loadSUT()
    const out = resolveMcpProcessPatterns(null)
    expect(out).toEqual({ 'with-script': '/abs/x.js' })
  })

  it('skips a missing agent .mcp.json (the existsSync=false branch on the agent file)', async () => {
    // Project-root .mcp.json exists; agent .mcp.json does not.
    mockExistsSync.mockImplementation((p: string) => p === join(PROJECT_ROOT, '.mcp.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: { gmail: { command: 'gmail' } },
    }))

    const { resolveMcpProcessPatterns } = await loadSUT()
    const out = resolveMcpProcessPatterns('samu')
    expect(out).toEqual({ gmail: 'gmail' })
    // Only one readFileSync -- the agent file was skipped via the inner
    // existsSync=false `continue`.
    expect(mockReadFileSync).toHaveBeenCalledTimes(1)
  })

  it('handles a top-level non-object mcpServers gracefully', async () => {
    // mcpServers missing or null -> ?? {} fallback in the loop.
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync.mockReturnValue(JSON.stringify({ mcpServers: null }))

    const { resolveMcpProcessPatterns } = await loadSUT()
    expect(resolveMcpProcessPatterns(null)).toEqual({})
  })
})

// ===========================================================================
// checkTaskMcpRequirements -- orchestration. Every fail-open branch + happy path.
// ===========================================================================
describe('checkTaskMcpRequirements', () => {
  it('returns ok with empty lists when required is undefined', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    expect(checkTaskMcpRequirements(undefined, 'samu', 'agent-samu', null)).toEqual({
      ok: true, missing: [], unknown: [],
    })
    // No collaborator probes should run.
    expect(mockGetClaudePidForSession).not.toHaveBeenCalled()
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns ok with empty lists when required is an empty array', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    expect(checkTaskMcpRequirements([], 'samu', 'agent-samu', null)).toEqual({
      ok: true, missing: [], unknown: [],
    })
    expect(mockGetClaudePidForSession).not.toHaveBeenCalled()
  })

  it('returns ok with empty lists and logs a debug line for a remote host', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    const { logger } = await import('../logger.js')
    const result = checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', 'laptop.local')
    expect(result).toEqual({ ok: true, missing: [], unknown: [] })
    expect(logger.debug).toHaveBeenCalledWith(
      { agent: 'samu', session: 'agent-samu' },
      'MCP pre-check skipped: remote session',
    )
    // Remote short-circuit: no ps probe.
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns ok with empty lists and logs when the claude pid is unresolvable', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    const { logger } = await import('../logger.js')
    mockGetClaudePidForSession.mockReturnValue(null)

    const result = checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)
    expect(result).toEqual({ ok: true, missing: [], unknown: [] })
    expect(logger.debug).toHaveBeenCalledWith(
      { agent: 'samu', session: 'agent-samu' },
      'MCP pre-check skipped: claude pid unresolved',
    )
    expect(mockExecFileSync).not.toHaveBeenCalled()
  })

  it('returns ok with empty lists and logs when /bin/ps fails', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    const { logger } = await import('../logger.js')
    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockImplementation(() => {
      throw new Error('ps: not found')
    })

    const result = checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)
    expect(result).toEqual({ ok: true, missing: [], unknown: [] })
    expect(logger.debug).toHaveBeenCalledWith(
      { agent: 'samu', session: 'agent-samu' },
      'MCP pre-check skipped: ps failed',
    )
  })

  it('happy path: all required servers are alive, returns ok=true', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockReturnValue([
      '  PID  PPID COMMAND',
      '  200   100 claude',
      '  201   200 node /abs/gmail-mcp/dist/index.js',
    ].join('\n'))
    // No .mcp.json files -> patterns map is empty. With no patterns, every
    // server is "unknown" -- that's the fail-open path. To exercise the
    // happy ok=true path we need at least one pattern matched.
    mockExistsSync.mockImplementation((p: string) => p === join(PROJECT_ROOT, '.mcp.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        gmail: { command: 'node', args: ['/abs/gmail-mcp/dist/index.js'] },
      },
    }))

    const result = checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)
    expect(result).toEqual({ ok: true, missing: [], unknown: [] })
  })

  it('happy path: missing required server -> ok=false, missing includes the name', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockReturnValue([
      '  PID  PPID COMMAND',
      '  200   100 claude',
    ].join('\n'))
    mockExistsSync.mockImplementation((p: string) => p === join(PROJECT_ROOT, '.mcp.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        gmail: { command: 'node', args: ['/abs/gmail-mcp/dist/index.js'] },
      },
    }))

    const result = checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['gmail'])
    expect(result.unknown).toEqual([])
  })

  it('logs a debug line when some required servers have no derivable pattern (fail-open with unknown names)', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    const { logger } = await import('../logger.js')

    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockReturnValue([
      '  PID  PPID COMMAND',
      '  200   100 claude',
      '  201   200 node /abs/gmail/index.js',
    ].join('\n'))
    // gmail has a pattern AND is alive in ps; mystery-server is named in
    // `required` but missing from the config -> "unknown", fail-open.
    mockExistsSync.mockImplementation((p: string) => p === join(PROJECT_ROOT, '.mcp.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        gmail: { command: 'node', args: ['/abs/gmail/index.js'] },
      },
    }))

    const result = checkTaskMcpRequirements(['gmail', 'mystery-server'], 'samu', 'agent-samu', null)
    expect(result.ok).toBe(true)
    expect(result.missing).toEqual([])
    expect(result.unknown).toEqual(['mystery-server'])

    expect(logger.debug).toHaveBeenCalledWith(
      {
        agent: 'samu',
        session: 'agent-samu',
        unknown: ['mystery-server'],
      },
      'MCP pre-check: no process pattern derivable for some required servers (fail-open)',
    )
  })

  it('does not log the unknown-servers debug line when every required server resolves', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    const { logger } = await import('../logger.js')

    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockReturnValue([
      '  PID  PPID COMMAND',
      '  200   100 claude',
      '  201   200 node /abs/gmail-mcp/dist/index.js',
    ].join('\n'))
    mockExistsSync.mockImplementation((p: string) => p === join(PROJECT_ROOT, '.mcp.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        gmail: { command: 'node', args: ['/abs/gmail-mcp/dist/index.js'] },
      },
    }))

    checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)

    const unknownLogCalls = (logger.debug as unknown as { mock: { calls: unknown[][] } }).mock.calls.filter(
      (c) => Array.isArray(c) && typeof c[1] === 'string' && c[1].toString().includes('no process pattern derivable'),
    )
    expect(unknownLogCalls).toHaveLength(0)
  })

  it('passes agentName into resolveMcpProcessPatterns (per-agent config considered)', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockReturnValue([
      '  PID  PPID COMMAND',
      '  200   100 claude',
      '  201   200 node /abs/agent-gmail/index.js',
    ].join('\n'))

    // Project-root has gmail pointing at a root path; agent overrides it.
    // The agent's process actually running matches the AGENT path, so
    // the pre-check returns ok=true (the per-agent resolution worked).
    mockExistsSync.mockReturnValue(true)
    mockReadFileSync
      .mockReturnValueOnce(JSON.stringify({
        mcpServers: {
          gmail: { command: 'node', args: ['/abs/root-gmail/index.js'] },
        },
      }))
      .mockReturnValueOnce(JSON.stringify({
        mcpServers: {
          gmail: { command: 'node', args: ['/abs/agent-gmail/index.js'] },
        },
      }))

    const result = checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)
    expect(result.ok).toBe(true)
    // Both files were consulted.
    expect(mockReadFileSync).toHaveBeenCalledTimes(2)
  })

  it('passes the session into getClaudePidForSession', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockReturnValue('  PID  PPID COMMAND\n  200   100 claude\n')

    checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)
    expect(mockGetClaudePidForSession).toHaveBeenCalledWith('agent-samu')
  })

  it('passes the timeout and encoding to execFileSync when invoking /bin/ps', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    mockGetClaudePidForSession.mockReturnValue(200)
    mockExecFileSync.mockReturnValue('  PID  PPID COMMAND\n')

    checkTaskMcpRequirements(['gmail'], 'samu', 'agent-samu', null)
    expect(mockExecFileSync).toHaveBeenCalledWith(
      '/bin/ps',
      ['-axo', 'pid,ppid,command'],
      { timeout: 3000, encoding: 'utf-8' },
    )
  })

  it('combines missing and unknown correctly when both arise in the same call', async () => {
    const { checkTaskMcpRequirements } = await loadSUT()
    mockGetClaudePidForSession.mockReturnValue(200)
    // No children at all -> every server with a pattern is missing; servers
    // without a pattern are unknown.
    mockExecFileSync.mockReturnValue('  PID  PPID COMMAND\n  200   100 claude\n')
    mockExistsSync.mockImplementation((p: string) => p === join(PROJECT_ROOT, '.mcp.json'))
    mockReadFileSync.mockReturnValue(JSON.stringify({
      mcpServers: {
        gmail: { command: 'node', args: ['/abs/gmail/index.js'] },
        // bare-binary without args also yields a pattern, so gmail is the
        // only "known" server here.
        'also-bare': { command: 'also-bare' },
      },
    }))

    const result = checkTaskMcpRequirements(['gmail', 'also-bare', 'mystery'], 'samu', 'agent-samu', null)
    expect(result.ok).toBe(false)
    expect(result.missing).toEqual(['gmail', 'also-bare'])
    expect(result.unknown).toEqual(['mystery'])
  })
})

// ===========================================================================
// collectSubtreeCmdlines -- one branch left uncovered by the existing test:
// the `seen.has(pid)` defensive branch that fires when the same pid is
// reachable from two different parents (e.g. a malformed ps snapshot with a
// back-edge). The walk must terminate without infinite-looping.
// ===========================================================================
describe('collectSubtreeCmdlines -- defensive duplicate-pid branch', () => {
  it('terminates without double-counting a pid that is reachable from two parents', async () => {
    // 200 (root) -> 201 -> 202; 200 is also declared as a child of 201.
    // childrenOf[200] = [201], childrenOf[201] = [200, 202], childrenOf[202] = [].
    // The walk: pop 200 (seen), push [201]; pop 201 (seen), push [200, 202];
    // pop 202 (seen, push []); pop 201's remaining child 200 -- already seen,
    // continue. Without the seen.has guard this would loop.
    //
    // Note: cmdOf is keyed by pid, so the second `200 ...` line overwrites
    // cmdOf[200]. The walk visits 200 exactly once and uses the overwritten
    // value. We construct the PS so the overwriting line carries the same
    // observable cmdline string -- otherwise the test would be asserting on
    // a Map overwrite, which is not the behaviour the branch is about.
    const PS = [
      '  PID  PPID COMMAND',
      '  201   200 node /abs/child.js',
      '  202   201 node /abs/grandchild.js',
      '  200   201 claude-back-edge',     // back-edge: 200 (root) is also a child of 201
      '  200   100 claude',                // last write to cmdOf[200] wins
    ].join('\n')

    const { collectSubtreeCmdlines } = await loadSUT()
    const cmds = collectSubtreeCmdlines(PS, 200)
    // Walk order (LIFO): 200, 201, 202, then 200 again -> seen.has short-circuits.
    // cmdOf[200]'s final write is "claude" (line 4 wins over line 3).
    expect(cmds).toEqual([
      'claude',
      'node /abs/child.js',
      'node /abs/grandchild.js',
    ])
  })
})
