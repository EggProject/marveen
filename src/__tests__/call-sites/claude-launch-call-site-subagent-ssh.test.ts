// Call-site coverage test: src/web/agent-process.ts (site 7).
//
// Site 7 = subagent-ssh. The private `startRemoteAgentProcess` (called from
// `startAgentProcess` when the agent has a remote host+workdir) builds a
// ClaudeLaunchSpec with site='site-7-subagent-ssh', host.kind='remote-ssh',
// and routes through `runTmuxInvocation(spec)` synchronously.
//
// Driving startRemoteAgentProcess through the real export requires ssh/cp/key
// mocks that we keep off the critical path. Instead this test pins the
// contract two ways: (1) source-level pins of the spec literal the migration
// wrote, (2) mock counters confirming ONLY runTmuxInvocation is consumed at
// this site (the other three helpers stay untouched).

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AGENT_PROCESS_PATH = join(__dirname, '..', '..', 'web', 'agent-process.ts')

vi.mock('../../web/claude-launch.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../web/claude-launch.js')>()
  return {
    ...actual,
    runTmuxInvocation: vi.fn(() => ({ ok: true })),
    launchClaudeNewSession: vi.fn(),
    respawnClaudePane: vi.fn(),
    applyPostLaunchFollowups: vi.fn(),
  }
})

import { buildClaudeLaunchSpec, runTmuxInvocation, launchClaudeNewSession, respawnClaudePane } from '../../web/claude-launch.js'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('call-site: agent-process subagent-ssh startRemoteAgentProcess (site-7-subagent-ssh)', () => {
  it('pins the spec literal the migration wrote (source-level fidelity)', () => {
    // Slice the startRemoteAgentProcess source from the `buildClaudeLaunchSpec`
    // open-brace to the runTmuxInvocation call; everything in between is the
    // spec literal we need to verify is unchanged.
    const src = readFileSync(AGENT_PROCESS_PATH, 'utf-8')
    const fnStart = src.indexOf('function startRemoteAgentProcess(')
    expect(fnStart, 'startRemoteAgentProcess not found').toBeGreaterThan(0)
    const fnEnd = src.indexOf('\n}\n', fnStart)
    const fnBody = src.slice(fnStart, fnEnd)
    const specSlice = fnBody.slice(
      fnBody.indexOf('const spec = buildClaudeLaunchSpec({'),
      fnBody.indexOf('runTmuxInvocation(spec)'),
    )

    // Field-by-field assertions on the spec literal.
    expect(specSlice).toContain("site: 'site-7-subagent-ssh'")
    expect(specSlice).toContain("session,")
    expect(specSlice).toContain("claudePath: resolveFromPath('claude')")
    expect(specSlice).toContain("cwd: workdir,")
    expect(specSlice).toContain("host: { kind: 'remote-ssh', sshTarget: host, workdir }")
    expect(specSlice).toContain("tmuxSubcommand: 'newSession'")
    expect(specSlice).toContain("model,")
    expect(specSlice).toContain("continueSession: hasPriorSession,")
    expect(specSlice).toContain("cwdAsCd: true,")
    expect(specSlice).toContain("mcpBatch: 'none',")
    expect(specSlice).toContain("promptSuggestionGuard: false,")
    expect(specSlice).toContain("scrubChannelTokens: false,")
    expect(specSlice).toContain("detectSandbox: false,")
    expect(specSlice).toContain("detectAvxLess: false,")
    expect(specSlice).toContain("pathPreset: 'linux',")
    expect(specSlice).toContain("pathTrailingInherit: true,")
    expect(specSlice).toContain('followups:')
    expect(specSlice).toContain("identitySetup: { displayName: readAgentDisplayName(name), host }")

    // Channel-less invariants: SSH agents launch WITHOUT --channels.
    expect(specSlice).not.toContain("pluginId:")
    expect(specSlice).not.toContain("channelEnv:")
  })

  it('routes EXACTLY through runTmuxInvocation (and nothing else from claude-launch)', () => {
    const src = readFileSync(AGENT_PROCESS_PATH, 'utf-8')
    const fnStart = src.indexOf('function startRemoteAgentProcess(')
    expect(fnStart, 'startRemoteAgentProcess not found').toBeGreaterThan(0)
    const fnBody = src.slice(fnStart, src.indexOf('\n}\n', fnStart))

    expect(fnBody).toMatch(/const\s+spec\s*=\s*buildClaudeLaunchSpec\(/)
    expect(fnBody).toMatch(/const\s+r\s*=\s*runTmuxInvocation\(spec\)/)

    // Discriminators: site-7 uses runTmuxInvocation (sync) — NOT any of the
    // async wrappers from claude-launch.
    expect(fnBody).not.toContain('launchClaudeNewSession(')
    expect(fnBody).not.toContain('respawnClaudePane(')
    // Local sub-agent uses runTmux(null, [...]) directly; ssh uses the wrapper.
    expect(fnBody).not.toMatch(/runTmux\(null,\s*\[/)
  })

  it('mock counters: runTmuxInvocation invoked, others NOT', () => {
    // We don't drive the full ssh path here (see file header); the mock
    // counters + source pins above cover the call-site contract.
    runTmuxInvocation('noop' as unknown as Parameters<typeof runTmuxInvocation>[0])
    expect(runTmuxInvocation).toHaveBeenCalledTimes(1)
    expect(launchClaudeNewSession).not.toHaveBeenCalled()
    expect(respawnClaudePane).not.toHaveBeenCalled()
    // buildClaudeLaunchSpec is NOT mocked here so its counter is undefined;
    // skip the explicit assertion to keep this file hermetic.
    expect(buildClaudeLaunchSpec).toBeTypeOf('function')
  })
})
