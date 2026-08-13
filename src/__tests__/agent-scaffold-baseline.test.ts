// 100% baseline coverage tests for src/web/agent-scaffold.ts.
//
// Background: agent-scaffold-full.test.ts already exercises ~93% of branches.
// This file targets the remaining uncovered branches the primary suite
// documented but did not reach. Each test runs in its own worker (vitest file
// isolation), so module state is fresh per test file -- no test-order pollution
// between the two suites.
//
// Strategy:
//   * Same sandbox + vi.mock('../config.js') redirect to SANDBOX as the primary
//     suite. All filesystem-touching paths live under SANDBOX; nothing reaches
//     the live ./store/.
//   * vi.resetModules() + dynamic import() to get a fresh SUT with mocked deps.
//   * The structurally-dead branches (`heading.index ?? 0`,
//     `entry.hooks?.length ?? 0`, `(entry.hooks ?? [])` after a map that always
//     materialises an array) are documented in docs/needs-to-be-fix/ and not
//     asserted on here. They are unreachable from the test surface without
//     source modifications.
//
// Coverage goal: 100% statements / 100% branches / 100% functions / 100% lines
// when run via `npx vitest run src/__tests__/agent-scaffold-baseline.test.ts
// --coverage --coverage.include='src/web/agent-scaffold.ts'`.

import { describe, it, expect, vi } from 'vitest'
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync,
  rmSync,
} from 'node:fs'
import { join } from 'node:path'
import { mkNonVolatileDir } from './setup/temp-sandbox.js'

// ---------------------------------------------------------------------------
// Sandbox setup. Fresh dir per file so tests cannot leak into one another.
//
// NOT os.tmpdir(): that is /tmp on Linux, and isUnsafeHookCommand rejects every
// hook command referencing a volatile tmpfs prefix, so all the gate injectors
// would silently no-op and 10 tests here would fail on Linux only. See
// mkNonVolatileDir for the full story.
// ---------------------------------------------------------------------------
const SANDBOX = mkNonVolatileDir('scaffold-baseline-')
const HOME = join(SANDBOX, 'home')
mkdirSync(HOME, { recursive: true })

vi.mock('../config.js', () => ({
  PROJECT_ROOT: SANDBOX,
  STORE_DIR: join(SANDBOX, 'store'),
  OWNER_NAME: 'TestOwner',
  MAIN_AGENT_ID: 'main',
  BOT_NAME: 'MainBot',
  CHANNEL_PROVIDER: 'telegram',
  WEB_PORT: 3420,
  OWNER_DRIVE_FOLDER: '',
  APP_TZ: 'UTC',
  DASHBOARD_PUBLIC_URL: '',
  DEFAULT_AGENT_MODEL: 'claude-sonnet-5',
}))

vi.mock('../web/atomic-write.js', () => ({
  atomicWriteFileSync: (path: string, content: string) => {
    writeFileSync(path, content)
  },
}))

vi.mock('../agent.js', () => ({
  runAgent: vi.fn(async () => ({ text: 'LLM_OUTPUT', error: undefined })),
}))

vi.mock('../channel-provider.js', () => ({
  channelStateDir: (_provider: string, dir: string) => join(dir, '.claude', 'channels', 'telegram'),
}))

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => HOME,
    tmpdir: actual.tmpdir,
  }
})

vi.mock('../web/agent-config.js', () => {
  const { join: joinPath } = require('node:path') as typeof import('node:path')
  const listAgentNames = vi.fn(() => [])
  const readAgentCapabilities = vi.fn(() => [])
  return {
    agentDir: (name: string) => joinPath(SANDBOX, 'agents', name),
    agentConfigRoot: (name: string) => name === 'main' ? SANDBOX : joinPath(SANDBOX, 'agents', name),
    listAgentNames,
    readAgentCapabilities,
    AGENTS_BASE_DIR: joinPath(SANDBOX, 'agents'),
    DEFAULT_MODEL: 'claude-sonnet-5',
  }
})

// Import the SUT AFTER mocks are registered.
const scaffold = await import('../web/agent-scaffold.js')
const agentConfig = await import('../web/agent-config.js')

const _listAgentNames = agentConfig.listAgentNames as unknown as ReturnType<typeof vi.fn>
const _readAgentCapabilities = agentConfig.readAgentCapabilities as unknown as ReturnType<typeof vi.fn>

// Per-test reset.
function resetMocks(): void {
  _listAgentNames.mockReset()
  _listAgentNames.mockImplementation(() => [])
  _readAgentCapabilities.mockReset()
  _readAgentCapabilities.mockImplementation(() => [])
  // Wipe the sandbox subdirs we touch.
  rmSync(join(SANDBOX, 'agents'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'templates'), { recursive: true, force: true })
  rmSync(join(SANDBOX, 'scripts'), { recursive: true, force: true })
  rmSync(join(SANDBOX, '.mcp.json'), { force: true })
  mkdirSync(SANDBOX, { recursive: true })
  mkdirSync(HOME, { recursive: true })
}

// ===========================================================================
// ensureAgentHooks: HookEntry.hooks ?? [] right branches (lines 178, 183, 248, 259)
// ===========================================================================

describe('ensureAgentHooks: HookEntry.hooks ?? [] right branches', () => {
  it('handles a tplEntry without a hooks array (line 178 right branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    // PreCompact event has one tplEntry that does NOT carry a `hooks` field.
    const tpl = {
      hooks: {
        PreCompact: [{ matcher: 'auto' }], // no `hooks` key -> line 178 ?? [] fires
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    // No existing settings.json -> seed branch (line 271-281).
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    const result = scaffold.ensureAgentHooks('samu')
    expect(result).toBe(true)
    expect(existsSync(join(agentDir, '.claude', 'settings.json'))).toBe(true)
  })

  it('handles an existEntry without a hooks array (line 183 right branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    // Template has a real hook.
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py')}`
    const tpl = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [{ command: safeCmd }] }],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    // Existing settings has an entry WITHOUT `hooks` field for the same event.
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreCompact: [{ matcher: 'auto' }] }, // entry without hooks -> line 183 ?? [] fires
    }))
    const result = scaffold.ensureAgentHooks('samu')
    expect(result).toBe(true)
  })

  it('handles an existHook with empty command (line 184 if branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'safe.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'safe.py')}`
    const tpl = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [{ command: safeCmd, timeout: 5 }] }],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    // Existing has an existHook WITHOUT a command field.
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ timeout: 9 }] }] }, // no `command` -> line 184 continue
    }))
    const result = scaffold.ensureAgentHooks('samu')
    // No command -> skip via line 184 -> the existing entry is NOT rewritten.
    expect(result).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    // The existing entry kept its original (empty) command; the safe command was
    // appended as a NEW entry (line 251 push).
    const allCmds = written.hooks.PreCompact.flatMap((e: { hooks: { command?: string }[] }) => e.hooks.map((h) => h.command))
    expect(allCmds).toContain(safeCmd)
  })

  it('handles a tplEntry without hooks in the timeout-sync pass (line 256 right branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'safe.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'safe.py')}`
    // First event has a tplEntry with `hooks` (sync path) + a tplEntry WITHOUT
    // `hooks` (line 256 ?? [] fires). PreCompact triggers the sync-timeout loop.
    const tpl = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ command: safeCmd, timeout: 7 }] },
          { matcher: 'Bash' }, // tplEntry without hooks -> line 256 ?? [] fires
        ],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: safeCmd, timeout: 5 }] }] },
    }))
    const result = scaffold.ensureAgentHooks('samu')
    expect(result).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    // Timeout was synced from 5 to 7.
    expect(written.hooks.PreToolUse[0].hooks[0].timeout).toBe(7)
  })

  it('handles an existEntry without hooks in the timeout-sync inner loop (line 259 right branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'safe.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'safe.py')}`
    const tpl = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: safeCmd, timeout: 7 }] }],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    // Existing has an entry WITHOUT `hooks` array -- line 259 ?? [] fires.
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash' }, { matcher: 'WebFetch', hooks: [] }] },
    }))
    const result = scaffold.ensureAgentHooks('samu')
    expect(result).toBe(true)
  })

  it('handles an existEntry without hooks in the flatMap existingCommands (line 244 right branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'safe.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'safe.py')}`
    const tpl = {
      hooks: {
        PreToolUse: [{ matcher: 'Bash', hooks: [{ command: safeCmd }] }],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    // Existing has an entry WITHOUT `hooks` array -- line 244 ?? [] fires inside
    // the flatMap. The other entry provides the real existingCommands set.
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [
          { matcher: 'Bash' }, // no `hooks` -> line 244 ?? [] fires (no commands contributed)
          { matcher: 'WebFetch', hooks: [{ command: 'other.sh' }] },
        ],
      },
    }))
    const result = scaffold.ensureAgentHooks('samu')
    expect(result).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    // safeCmd was added as a new hook group entry (since it wasn't in existingCommands).
    // The defensive `?? []` lets this assertion stay green when one of the
    // existing entries happens to have no `hooks` array (the line 244 branch
    // we're driving).
    const allCmds = (written.hooks?.PreToolUse ?? []).flatMap(
      (e: { hooks?: { command: string }[] }) => (e.hooks ?? []).map((h) => h.command),
    )
    expect(allCmds).toContain(safeCmd)
  })

  it('handles a tplEntry without hooks in the newHooks filter (line 248 right branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'safe.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'safe.py')}`
    // First tplEntry has hooks, second has NO hooks -- line 248 ?? [] fires.
    const tpl = {
      hooks: {
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ command: safeCmd }] },
          { matcher: 'WebFetch' }, // no `hooks` -> line 248 ?? [] fires (no newHooks contributed)
        ],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ command: 'existing.sh' }] }] },
    }))
    const result = scaffold.ensureAgentHooks('samu')
    expect(result).toBe(true)
  })
})

// ===========================================================================
// ensureAgentHooks: MAIN_AGENT_ID mkdirSync-skip branch (line 284 else)
// ===========================================================================

describe('ensureAgentHooks: MAIN_AGENT_ID skips the mkdirSync (line 284)', () => {
  it('does not create agents/<main>/ for the MAIN_AGENT_ID and still writes the home settings.json', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    const tpl = {
      hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'p' }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    mkdirSync(join(HOME, '.claude'), { recursive: true })
    const res = scaffold.ensureAgentHooks('main')
    expect(typeof res).toBe('boolean')
    // agents/main must NOT be created.
    expect(existsSync(join(SANDBOX, 'agents', 'main'))).toBe(false)
    // The home settings.json WAS written.
    expect(existsSync(join(HOME, '.claude', 'settings.json'))).toBe(true)
  })
})

// ===========================================================================
// ensureAgentStalenessHook: settings.hooks not an object branch (line 316)
// ===========================================================================

describe('ensureAgentStalenessHook: settings.hooks is not an object', () => {
  it('treats a non-object hooks field as the empty object fallback', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // settings.hooks is a string (not an object) -> line 316 else {} fires.
    writeFileSync(join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: 'not-an-object' }))
    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    // The staleness hook was wired under the new hooks object.
    expect(Array.isArray(written.hooks.UserPromptSubmit)).toBe(true)
  })

  it('treats a numeric hooks field as the empty object fallback', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({ hooks: 42 }))
    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(true)
  })
})

// ===========================================================================
// ensureEmailAndPaceGates: needEmail=true but needPace=false (line 612 else)
// and needEmail=false but needPace=true (line 611 else) -- mutually exclusive
// branches are reached by PreToolUse entries that wire only one of the two.
// ===========================================================================

describe('ensureEmailAndPaceGates: only one of needEmail/needPace is true', () => {
  it('injects the email gate but skips the pace gate when pace is already wired (line 612 else)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'email-send-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'), '// stub')
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // PreToolUse already wires the self-pace-gate (using the EXACT hookCommand
    // form so hookCommandWired returns true) -> needPace=false, needEmail=true.
    const paceCmd = scaffold.hookCommand(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'))
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: paceCmd }] }] },
    }))
    const result = scaffold.ensureGovernanceGateCommands('samu')
    expect(result).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    const cmds = JSON.stringify(written.hooks.PreToolUse)
    // Email gate was added (line 611 if branch).
    expect(cmds).toContain('email-send-gate.mjs')
    // Self-pace gate is still wired (line 612 else branch was taken -- the
    // existing entry was deduped, not duplicated).
    expect(cmds).toContain('self-pace-gate.mjs')
  })

  it('injects the pace gate but skips the email gate when email is already wired (line 611 else)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'email-send-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'), '// stub')
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // PreToolUse already wires the email-send-gate -> needEmail=false, needPace=true.
    const emailCmd = scaffold.hookCommand(join(SANDBOX, 'scripts', 'email-send-gate.mjs'))
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ hooks: [{ command: emailCmd }] }] },
    }))
    const result = scaffold.ensureGovernanceGateCommands('samu')
    expect(result).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    const cmds = JSON.stringify(written.hooks.PreToolUse)
    expect(cmds).toContain('email-send-gate.mjs')
    expect(cmds).toContain('self-pace-gate.mjs')
  })

  it('treats a non-object settings.hooks field as the empty object fallback (line 604 else)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'email-send-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'), '// stub')
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // settings.hooks is a string -> line 604 else {} fires.
    writeFileSync(join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: 'not-an-object' }))
    expect(scaffold.ensureGovernanceGateCommands('samu')).toBe(true)
  })
})

// ===========================================================================
// ensureEgressGate: MAIN_AGENT_ID mkdirSync-skip branch (line 487 else)
// ===========================================================================

describe('ensureEgressGate: MAIN_AGENT_ID skips the mkdirSync (line 487)', () => {
  it('writes to ~/.claude/settings.json without creating agents/main/ when called for MAIN_AGENT_ID', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'), '// stub')
    mkdirSync(join(HOME, '.claude'), { recursive: true })
    // No existing settings.json -> fresh seed branch.
    const result = scaffold.ensureEgressGate('main')
    expect(result).toBe(true)
    // agents/main must NOT be created (line 487 else branch fires for main).
    expect(existsSync(join(SANDBOX, 'agents', 'main'))).toBe(false)
    // The home settings.json WAS written.
    expect(existsSync(join(HOME, '.claude', 'settings.json'))).toBe(true)
  })
})

// ===========================================================================
// scaffoldAgentDir: mcpJson already exists branch (line 735 else)
// ===========================================================================

describe('scaffoldAgentDir: .mcp.json already present at the agent dir', () => {
  it('does not touch the existing .mcp.json (line 735 else)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    mkdirSync(join(SANDBOX, 'templates', 'sub-agents'), { recursive: true })
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // Pre-existing .mcp.json with a marker command we can assert is preserved.
    const existingContent = JSON.stringify({ mcpServers: { preexisting: { command: 'preexisting-cmd' } } })
    writeFileSync(join(agentDir, '.mcp.json'), existingContent)
    scaffold.scaffoldAgentDir('samu')
    const after = readFileSync(join(agentDir, '.mcp.json'), 'utf-8')
    expect(after).toBe(existingContent)
  })
})

// ===========================================================================
// ensureFleetRosterSection: roster prepend + empty-roster branches (lines 810, 833)
// ===========================================================================

describe('ensureFleetRosterSection: roster prepend (line 810) + empty-roster (line 833)', () => {
  it('keeps agentNames as-is when MAIN_AGENT_ID is already in the list (line 810 true branch)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates', 'sub-agents'), { recursive: true })
    writeFileSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'),
      '## Domain restriction\n\n- `hnrss.org`\n')
    // listAgentNames() returns ['main', 'samu'] -> MAIN_AGENT_ID is already in
    // the list -> line 810 `? agentNames` branch (true) -> no prepend.
    // We use selfName='alice' so neither 'main' nor 'samu' is filtered out.
    _listAgentNames.mockImplementation(() => ['main', 'samu'])
    _readAgentCapabilities.mockImplementation(() => [])
    const agentDir = join(SANDBOX, 'agents', 'alice')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('alice')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('**main**')
    expect(out).toContain('**samu**')
  })

  it('emits the "(nincs regisztrált ágens)" placeholder when the only agent is selfName (line 833 else)', () => {
    resetMocks()
    mkdirSync(join(SANDBOX, 'templates', 'sub-agents'), { recursive: true })
    writeFileSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'),
      '## Domain restriction\n\n- `hnrss.org`\n')
    // listAgentNames() returns [] -> MAIN_AGENT_ID is prepended -> names = [main]
    // selfName='main' -> the loop's `continue` fires for every name -> lines=[]
    // -> line 833 else branch emits the placeholder.
    _listAgentNames.mockImplementation(() => [])
    _readAgentCapabilities.mockImplementation(() => [])
    const agentDir = join(SANDBOX, 'agents', 'main')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('main')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('(nincs regisztrált ágens)')
  })
})
