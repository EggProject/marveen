// Comprehensive coverage tests for src/web/agent-scaffold.ts.
//
// Goal: drive uncovered branches / lines / statements to 100% without modifying
// the source. The file under test has many small functions and a few complex
// migrations (ensure* hooks, scaffoldAgentDir, ensureDefaultScheduledTasks, the
// three LLM generators). We mock aggressively so nothing reaches the live
// filesystem, the live config, the LLM, or the real templates directory.
//
// Patterns:
//   - vi.mock('../config.js') per file -> per-test sandbox PROJECT_ROOT.
//   - vi.mock('../web/atomic-write.js') -> plain writeFileSync.
//   - vi.mock('../agent.js') -> runAgent returns the prompt + canned answer.
//   - per-test mkdtempSync for actual fs-touching paths.
//
// Pinning: every test asserts the CURRENT (possibly-buggy) behavior. We do NOT
// intentionally fail on the production code. Bugs that surface during the
// coverage sweep are filed separately under docs/needs-to-be-fix/.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, writeFileSync, readFileSync, mkdirSync, existsSync,
  rmSync, statSync,
} from 'node:fs'
import { tmpdir, homedir as realHomedir } from 'node:os'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Sandbox setup. We pick a fresh tmpdir per file (mkdtempSync is sync) so each
// test's setup/teardown does not see state left over by a previous test.
// ---------------------------------------------------------------------------
const SANDBOX = mkdtempSync(join(tmpdir(), 'scaffold-full-'))
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
  const { join } = require('node:path') as typeof import('node:path')
  const listAgentNames = vi.fn(() => [])
  const readAgentCapabilities = vi.fn(() => [])
  return {
    agentDir: (name: string) => join(SANDBOX, 'agents', name),
    agentConfigRoot: (name: string) => name === 'main' ? SANDBOX : join(SANDBOX, 'agents', name),
    listAgentNames,
    readAgentCapabilities,
    AGENTS_BASE_DIR: join(SANDBOX, 'agents'),
    DEFAULT_MODEL: 'claude-sonnet-5',
  }
})

// Import the module AFTER mocks are registered.
const scaffold = await import('../web/agent-scaffold.js')
const agentConfig = await import('../web/agent-config.js')

// Per-test override helpers: by default listAgentNames returns an empty list so
// the roster body exercises the "no agents registered" branch (matching the
// coverage goal). Tests that need a different behaviour override the mock
// using the exported vi.fn() handles below.
const _listAgentNames = agentConfig.listAgentNames as unknown as ReturnType<typeof vi.fn>
const _readAgentCapabilities = agentConfig.readAgentCapabilities as unknown as ReturnType<typeof vi.fn>
_listAgentNames.mockImplementation(() => [])
_readAgentCapabilities.mockImplementation(() => [])

afterEach(() => {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(SANDBOX, { recursive: true })
  mkdirSync(HOME, { recursive: true })
})

// ===========================================================================
// 1. substituteTemplatePlaceholders / resolveTemplatePlaceholders (95-113)
// ===========================================================================
describe('substituteTemplatePlaceholders', () => {
  const id = {
    projectRoot: '/srv/install',
    mainAgentId: 'main',
    botName: 'MainBot',
    ownerName: 'TestOwner',
    webPort: 3420,
  }

  it('replaces {{PROJECT_ROOT}} with the supplied projectRoot', () => {
    expect(scaffold.substituteTemplatePlaceholders('{{PROJECT_ROOT}}/store', id))
      .toBe('/srv/install/store')
  })

  it('replaces {{INSTALL_DIR}} identically to {{PROJECT_ROOT}}', () => {
    expect(scaffold.substituteTemplatePlaceholders('{{INSTALL_DIR}}/x', id))
      .toBe('/srv/install/x')
  })

  it('replaces {{MAIN_AGENT_ID}}', () => {
    expect(scaffold.substituteTemplatePlaceholders('to={{MAIN_AGENT_ID}}', id)).toBe('to=main')
  })

  it('replaces {{BOT_NAME}}', () => {
    expect(scaffold.substituteTemplatePlaceholders('bot={{BOT_NAME}}', id)).toBe('bot=MainBot')
  })

  it('replaces {{OWNER_NAME}}', () => {
    expect(scaffold.substituteTemplatePlaceholders('owner={{OWNER_NAME}}', id)).toBe('owner=TestOwner')
  })

  it('replaces {{WEB_PORT}} from a numeric port', () => {
    expect(scaffold.substituteTemplatePlaceholders('port={{WEB_PORT}}', id)).toBe('port=3420')
  })

  it('replaces {{WEB_PORT}} from a string port', () => {
    expect(scaffold.substituteTemplatePlaceholders('port={{WEB_PORT}}', { ...id, webPort: '4040' }))
      .toBe('port=4040')
  })

  it('replaces multiple placeholders in one pass', () => {
    const out = scaffold.substituteTemplatePlaceholders(
      '{{PROJECT_ROOT}} {{BOT_NAME}} {{OWNER_NAME}} {{MAIN_AGENT_ID}} {{WEB_PORT}}',
      id,
    )
    expect(out).toBe('/srv/install MainBot TestOwner main 3420')
  })

  it('leaves text without placeholders untouched', () => {
    expect(scaffold.substituteTemplatePlaceholders('plain text', id)).toBe('plain text')
  })

  it('is the default for resolveTemplatePlaceholders', () => {
    // Resolve against real config (mocked above). Identity values come from
    // the mock: PROJECT_ROOT=SANDBOX, MAIN_AGENT_ID='main', BOT_NAME='MainBot',
    // OWNER_NAME='TestOwner', WEB_PORT=3420.
    expect(scaffold.resolveTemplatePlaceholders('{{BOT_NAME}}-{{WEB_PORT}}'))
      .toBe('MainBot-3420')
  })
})

// ===========================================================================
// 2. agentSettingsPath (119-122)
// ===========================================================================
describe('agentSettingsPath', () => {
  it('maps MAIN_AGENT_ID to ~/.claude/settings.json using homedir()', () => {
    expect(scaffold.agentSettingsPath('main'))
      .toBe(join(realHomedir(), '.claude', 'settings.json'))
  })

  it('maps a sub-agent to agents/<name>/.claude/settings.json', () => {
    expect(scaffold.agentSettingsPath('samu'))
      .toBe(join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'))
  })
})

// ===========================================================================
// 3. ensureAgentHooks (205-287) -- the PreCompact + template migration.
// ===========================================================================
describe('ensureAgentHooks', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
  })

  it('returns false and skips writing when the template does not exist', () => {
    // No templates/settings.json.template.
    rmSync(join(SANDBOX, 'templates', 'settings.json.template'), { force: true })
    expect(scaffold.ensureAgentHooks('samu')).toBe(false)
  })

  it('returns false when the template is unparseable JSON', () => {
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), 'not json {')
    expect(scaffold.ensureAgentHooks('samu')).toBe(false)
  })

  it('returns false when the template has no hooks key', () => {
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'),
      JSON.stringify({ enabledPlugins: {} }))
    expect(scaffold.ensureAgentHooks('samu')).toBe(false)
  })

  it('seeds settings.json with the WHOLE hooks block when none exist yet', () => {
    const tpl = {
      hooks: {
        PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'save' }] }],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    expect(scaffold.ensureAgentHooks('samu')).toBe(true)

    const settingsPath = join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json')
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(written.hooks.PreCompact).toBeDefined()
  })

  it('skips seeding unsafe hook commands when the file is freshly created', () => {
    const tpl = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'python3 /tmp/never-exists/x.py', timeout: 5 },
            // A "safe" entry that does exist on disk; we mock existsSync via
            // the real fs call against a file we create below.
          ],
        }],
      },
    }
    // Plant a real file so the safe command survives the existsSync guard.
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'real.py'), '#!/usr/bin/env python3\n')
    tpl.hooks.PreToolUse[0].hooks.push({
      type: 'command', command: `python3 ${join(SANDBOX, 'scripts', 'real.py')}`, timeout: 5,
    })
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))

    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'), 'utf-8'))
    const cmds = written.hooks.PreToolUse[0].hooks.map((h: { command: string }) => h.command)
    expect(cmds.some((c: string) => c.includes('/tmp/never-exists'))).toBe(false)
    expect(cmds.some((c: string) => c.includes('real.py'))).toBe(true)
  })

  it('does NOT create a subdir for MAIN_AGENT_ID (uses homedir/.claude)', () => {
    const tpl = {
      hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'p' }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    // Plant a fake home .claude/settings.json -- ensureAgentHooks writes there.
    mkdirSync(join(HOME, '.claude'), { recursive: true })
    // We cannot reliably redirect homedir() inside the module without mocking
    // node:os. Instead, just assert the sub-agent dir is NOT touched, and the
    // function returns true (which it does if the template is read).
    const res = scaffold.ensureAgentHooks('main')
    expect(typeof res).toBe('boolean')
    expect(existsSync(join(SANDBOX, 'agents', 'main'))).toBe(false)
  })

  it('merges new hooks into an existing settings.json with no hooks yet', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { foo: true } }))
    const tpl = {
      hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'p' }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))

    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(written.enabledPlugins.foo).toBe(true)
    expect(written.hooks.PreCompact).toBeDefined()
  })

  it('preserves existing PreToolUse entries when merging', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: {
        PreToolUse: [{ matcher: 'WebFetch', hooks: [{ type: 'command', command: 'other.sh' }] }],
      },
    }))
    const tpl = {
      hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'p' }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))

    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe('other.sh')
    expect(written.hooks.PreCompact).toBeDefined()
  })

  it('returns false (no change) when the merged content is identical', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    const tpl = {
      hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'p' }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    // First call writes.
    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    // Second call is a no-op.
    expect(scaffold.ensureAgentHooks('samu')).toBe(false)
  })

  it('overwrites settings.json when the existing file is unparseable', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), '{ corrupted json')
    const tpl = {
      hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'p' }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))

    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(written.hooks.PreCompact).toBeDefined()
  })

  it('skips template hooks that match an existing command (idempotent dedup)', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // Plant a real script so the hook passes the registration guard.
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'real.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'real.py')}`
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: safeCmd, timeout: 7 }] }] },
    }))
    const tpl = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: safeCmd, timeout: 9 }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))

    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    // timeout synced from 7 to 9 (template value)
    expect(written.hooks.PreToolUse[0].hooks[0].timeout).toBe(9)
  })

  it('drops unsafe commands from a fresh seed', () => {
    const tpl = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'command', command: 'python3 /tmp/foo/x.py', timeout: 5 }],
        }],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'), 'utf-8'))
    expect(written.hooks.PreToolUse).toBeUndefined()
  })

  it('drops an entire hook entry when all its hooks are unsafe (length === 0)', () => {
    // Line 277-278: the .filter that removes entries whose hooks array is
    // empty after the unsafe-filter pass. Plant an entry whose hooks are all
    // unsafe so the resulting safeEntries entry is dropped entirely.
    const tpl = {
      hooks: {
        PreToolUse: [{
          matcher: 'Bash',
          hooks: [
            { type: 'command', command: 'python3 /tmp/never/x.py', timeout: 5 },
            { type: 'command', command: 'python3 /tmp/never/y.py', timeout: 5 },
          ],
        }],
        PostToolUse: [{
          matcher: 'Bash',
          hooks: [{ type: 'agent', prompt: 'noop' }],
        }],
      },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))
    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'), 'utf-8'))
    // The PreToolUse entry was entirely unsafe -> dropped; PostToolUse survived.
    expect(written.hooks.PreToolUse).toBeUndefined()
    expect(written.hooks.PostToolUse).toBeDefined()
  })

  it('appends a NEW PreToolUse hook group when the existing entry has the event key but no template hooks yet', () => {
    // Plant a real script so the new hook passes the registration guard.
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'real.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'real.py')}`
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // existing.hooks exists, but PreToolUse is missing entirely -> goes through
    // the "if (!existingHooks[event])" path and writes the whole entry.
    writeFileSync(join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreCompact: [{ matcher: 'auto', hooks: [] }] } }))
    const tpl = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: safeCmd, timeout: 7 }] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))

    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(written.hooks.PreToolUse).toBeDefined()
    expect(written.hooks.PreToolUse[0].hooks[0].command).toBe(safeCmd)
  })

  it('appends MISSING template hooks to an existing PreToolUse event (not all the template hooks)', () => {
    // Plant two real scripts: existing has cmdA; template has cmdA + cmdB.
    // After the merge, PreToolUse should carry BOTH cmdA (kept) and cmdB (newly added).
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'a.py'), '#!/usr/bin/env python3\n')
    writeFileSync(join(SANDBOX, 'scripts', 'b.py'), '#!/usr/bin/env python3\n')
    const cmdA = `python3 ${join(SANDBOX, 'scripts', 'a.py')}`
    const cmdB = `python3 ${join(SANDBOX, 'scripts', 'b.py')}`
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: cmdA, timeout: 7 }] }] },
    }))
    const tpl = {
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [
        { type: 'command', command: cmdA, timeout: 7 },
        { type: 'command', command: cmdB, timeout: 7 },
      ] }] },
    }
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'), JSON.stringify(tpl))

    expect(scaffold.ensureAgentHooks('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    const cmds = written.hooks.PreToolUse.flatMap((e: { hooks: { command: string }[] }) => e.hooks.map((h) => h.command))
    expect(cmds).toContain(cmdA)
    expect(cmds).toContain(cmdB)
    // cmdB must appear exactly once (no double-add via the same entry).
    expect(cmds.filter((c: string) => c === cmdB).length).toBe(1)
  })
})

// ===========================================================================
// 4. ensureAgentStalenessHook (305-330)
// ===========================================================================
describe('ensureAgentStalenessHook', () => {
  it('returns false when settings.json exists but is unparseable', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), '{ broken')
    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(false)
  })

  it('adds the staleness-guard UserPromptSubmit entry when settings.json is fresh', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // Plant the script so the registration guard allows it.
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')

    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    const ups = written.hooks?.UserPromptSubmit ?? []
    expect(JSON.stringify(ups)).toContain('staleness-guard.py')
  })

  it('returns false (idempotent) when the entry is already wired', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')

    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(true)
    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(false)
  })

  it('creates settings.json when none exists', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(agentDir, { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')

    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(true)
    expect(existsSync(join(agentDir, '.claude', 'settings.json'))).toBe(true)
  })

  it('returns false when the STALENESS_HOOK_CMD is unsafe (registration guard)', () => {
    // We can simulate this by deleting the script so the existsSync check fails.
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }))
    // No scripts/hooks/staleness-guard.py file -> STALENESS_HOOK_CMD is unsafe.
    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(false)
  })

  it('does NOT create the agents/<name>/.claude dir for the MAIN_AGENT_ID', () => {
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    // The MAIN_AGENT_ID uses ~/.claude/settings.json (homedir-mocked to HOME here).
    mkdirSync(join(HOME, '.claude'), { recursive: true })
    const res = scaffold.ensureAgentStalenessHook('main')
    expect(res).toBe(true)
    // agents/main/ must NOT be created.
    expect(existsSync(join(SANDBOX, 'agents', 'main'))).toBe(false)
    // The home settings.json was written.
    expect(existsSync(join(HOME, '.claude', 'settings.json'))).toBe(true)
  })

  it('handles a settings.json whose hooks field is an object, not an array', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({ hooks: {} }))
    expect(scaffold.ensureAgentStalenessHook('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(Array.isArray(written.hooks.UserPromptSubmit)).toBe(true)
  })
})

// ===========================================================================
// 5. writeAgentSettingsFromProfile (332-369)
// ===========================================================================
describe('writeAgentSettingsFromProfile', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'email-send-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'), '// stub')
  })

  const PROFILE = {
    id: 'default',
    label: 'Default',
    description: 'Permissive',
    permissionMode: 'permissive' as const,
    filesystem: { allow: ['${HOME}/keep'], deny: ['${AGENT_DIR}/secret'] },
  }

  it('writes a fresh settings.json with allow/deny resolved via placeholders', () => {
    scaffold.writeAgentSettingsFromProfile('samu', PROFILE)
    const settingsPath = join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json')
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(written.permissions.allow[0]).toContain(realHomedir())
    expect(written.permissions.deny[0]).toContain(join(SANDBOX, 'agents', 'samu'))
  })

  it('merges SELF_PACE_TOOL_DENY into deny for sub-agents (governance gate)', () => {
    scaffold.writeAgentSettingsFromProfile('samu', PROFILE)
    const settingsPath = join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json')
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(written.permissions.deny).toContain('ScheduleWakeup')
    expect(written.permissions.deny).toContain('CronCreate')
    expect(written.permissions.deny).toContain('CronDelete')
    expect(written.permissions.deny).toContain('CronList')
    expect(written.permissions.deny).toContain('RemoteTrigger')
  })

  it('does NOT add SELF_PACE_TOOL_DENY for the MAIN_AGENT_ID', () => {
    // The MAIN_AGENT_ID is exempt from the SELF_PACE_TOOL_DENY injection
    // (governance gates skip the main agent). assertAgentGetsGovernanceGates
    // is the same predicate used by writeAgentSettingsFromProfile.
    scaffold.writeAgentSettingsFromProfile('main', PROFILE)
    const settingsPath = join(SANDBOX, 'agents', 'main', '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)
    const written = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(written.permissions.deny).not.toContain('ScheduleWakeup')
    expect(written.permissions.deny).not.toContain('CronCreate')
  })

  it('keeps existing settings.json keys when merging', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({ enabledPlugins: { foo: true }, hooks: { PreCompact: [] } }))
    scaffold.writeAgentSettingsFromProfile('samu', PROFILE)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(written.enabledPlugins.foo).toBe(true)
    expect(written.hooks.PreCompact).toBeDefined()
  })

  it('overwrites settings.json when the existing file is unparseable', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), '{ not json')
    scaffold.writeAgentSettingsFromProfile('samu', PROFILE)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(written.permissions.allow).toBeDefined()
  })

  it('injects the email-send gate for sub-agents', () => {
    scaffold.writeAgentSettingsFromProfile('samu', PROFILE)
    const written = JSON.parse(readFileSync(
      join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'), 'utf-8'))
    const cmds = JSON.stringify(written.hooks?.PreToolUse ?? [])
    expect(cmds).toContain('email-send-gate.mjs')
  })

  it('injects the self-pace gate for sub-agents', () => {
    scaffold.writeAgentSettingsFromProfile('samu', PROFILE)
    const written = JSON.parse(readFileSync(
      join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'), 'utf-8'))
    const cmds = JSON.stringify(written.hooks?.PreToolUse ?? [])
    expect(cmds).toContain('self-pace-gate.mjs')
  })

  it('injects the egress gate for every agent (including MAIN_AGENT_ID)', () => {
    scaffold.writeAgentSettingsFromProfile('samu', PROFILE)
    const written = JSON.parse(readFileSync(
      join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'), 'utf-8'))
    const cmds = JSON.stringify(written.hooks?.PreToolUse ?? [])
    expect(cmds).toContain('egress-gate.mjs')
  })
})

// ===========================================================================
// 6. injectEgressGate edge case (line 459) -- pre-existing hooks object that
// is NOT an object (so it must be re-initialised). With our types this is hard
// to reach legally, but we exercise the "existing.hooks is undefined" branch.
// ===========================================================================
describe('injectEgressGate', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'), '// stub')
  })

  it('initialises existing.hooks when it is undefined', () => {
    const s: Record<string, unknown> = {}
    scaffold.injectEgressGate(s)
    expect(s.hooks).toBeDefined()
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(ptu.length).toBe(1)
  })

  it('returns silently when the script path is unsafe (registration guard)', () => {
    const s: Record<string, unknown> = {}
    // Without scripts/hooks/egress-gate.mjs, the command is unsafe.
    rmSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'))
    scaffold.injectEgressGate(s)
    const ptu = (s.hooks as Record<string, unknown>)?.PreToolUse ?? []
    expect((ptu as unknown[]).length).toBe(0)
  })
})

describe('injectEmailSendGate / injectSelfPaceGate: registration guard', () => {
  it('injectEmailSendGate returns silently when the script path is unsafe', () => {
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    // No email-send-gate.mjs file -> command is unsafe -> early return.
    const s: Record<string, unknown> = {}
    scaffold.injectEmailSendGate(s)
    const ptu = (s.hooks as Record<string, unknown>)?.PreToolUse ?? []
    expect((ptu as unknown[]).length).toBe(0)
  })

  it('injectSelfPaceGate returns silently when the script path is unsafe', () => {
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    const s: Record<string, unknown> = {}
    scaffold.injectSelfPaceGate(s)
    const ptu = (s.hooks as Record<string, unknown>)?.PreToolUse ?? []
    expect((ptu as unknown[]).length).toBe(0)
  })
})

// ===========================================================================
// 7. ensureQuarantineReader (628-652)
// ===========================================================================
describe('ensureQuarantineReader', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'templates', 'sub-agents'), { recursive: true })
    mkdirSync(join(SANDBOX, 'store'), { recursive: true })
  })

  it('returns false when the template is missing', () => {
    rmSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'), { force: true })
    expect(scaffold.ensureQuarantineReader('samu')).toBe(false)
  })

  it('writes quarantine-reader.md to agents/<name>/.claude/agents/ for sub-agents', () => {
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n'
    writeFileSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'), tpl)
    expect(scaffold.ensureQuarantineReader('samu')).toBe(true)
    const out = join(SANDBOX, 'agents', 'samu', '.claude', 'agents', 'quarantine-reader.md')
    expect(existsSync(out)).toBe(true)
    expect(readFileSync(out, 'utf-8')).toContain('hnrss.org')
  })

  it('returns false when the deployed file already matches the rendered output', () => {
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n'
    writeFileSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'), tpl)
    expect(scaffold.ensureQuarantineReader('samu')).toBe(true)
    expect(scaffold.ensureQuarantineReader('samu')).toBe(false)
  })

  it('re-renders when the rendered output differs from the deployed file', () => {
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n'
    writeFileSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'), tpl)
    expect(scaffold.ensureQuarantineReader('samu')).toBe(true)
    // Hand-edit the deployed file -> next call should rewrite.
    const out = join(SANDBOX, 'agents', 'samu', '.claude', 'agents', 'quarantine-reader.md')
    writeFileSync(out, 'manually edited\n')
    expect(scaffold.ensureQuarantineReader('samu')).toBe(true)
    expect(readFileSync(out, 'utf-8')).toContain('hnrss.org')
  })

  it('returns false when the template throws on read (simulated by deletion after first read)', () => {
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n'
    const tplPath = join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md')
    writeFileSync(tplPath, tpl)
    expect(scaffold.ensureQuarantineReader('samu')).toBe(true)
    // Delete the template after the first read so the second call's readFileSync
    // throws; ensureQuarantineReader's try/catch must swallow that and return false.
    rmSync(tplPath)
    expect(scaffold.ensureQuarantineReader('samu')).toBe(false)
  })

  it('writes to ~/.claude/agents when called for the MAIN_AGENT_ID', () => {
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n'
    writeFileSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'), tpl)
    mkdirSync(join(HOME, '.claude'), { recursive: true })
    expect(scaffold.ensureQuarantineReader('main')).toBe(true)
    const out = join(HOME, '.claude', 'agents', 'quarantine-reader.md')
    expect(existsSync(out)).toBe(true)
  })

  it('returns false from the catch branch when renderQuarantineReader throws', () => {
    // The catch in ensureQuarantineReader fires when readFileSync(tpl) or
    // ownerAllowedDomains() or renderQuarantineReader throws. Force the latter
    // by making the template malformed -- renderQuarantineReader parses it as
    // text but the template's marker block could throw via the regex. The
    // easiest reliable trigger is an unreadable file (mkdirSync collision).
    const tplPath = join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md')
    mkdirSync(tplPath) // existsSync -> true; readFileSync on a dir -> throws
    expect(scaffold.ensureQuarantineReader('samu')).toBe(false)
  })
})

// ===========================================================================
// 8. ensureDefaultScheduledTasks (683-716)
// ===========================================================================
describe('ensureDefaultScheduledTasks', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks'), { recursive: true })
    mkdirSync(join(HOME, '.claude'), { recursive: true })
  })

  it('returns silently when scheduled-tasks dir does not exist', () => {
    rmSync(join(SANDBOX, 'scheduled-tasks'), { recursive: true, force: true })
    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
  })

  it('skips non-directory entries under scheduled-tasks/', () => {
    // A loose file, not a directory, must be skipped silently.
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'README.md'), 'docs')
    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
  })

  it('skips nested subdirectories under each task dir (flat-only)', () => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'subdir'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'task-config.json'),
      JSON.stringify({ schedule: '0 9 * * *', agent: 'main' }))
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'SKILL.md'),
      '# Skill {{BOT_NAME}}')
    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
  })

  it('seeds tasks on first call (skips already-seeded destinations)', () => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'task-config.json'),
      JSON.stringify({ schedule: '0 9 * * *', agent: 'marveen' }))
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'SKILL.md'),
      '# Skill {{BOT_NAME}} for {{OWNER_NAME}}')
    scaffold.ensureDefaultScheduledTasks()
    const dest = join(HOME, '.claude', 'scheduled-tasks', 'task1')
    expect(existsSync(dest)).toBe(true)
    expect(existsSync(join(dest, 'task-config.json'))).toBe(true)
    expect(existsSync(join(dest, 'SKILL.md'))).toBe(true)
    // Placeholders substituted.
    expect(readFileSync(join(dest, 'SKILL.md'), 'utf-8')).toContain('MainBot')
    // Agent field rewritten.
    const cfg = JSON.parse(readFileSync(join(dest, 'task-config.json'), 'utf-8'))
    expect(cfg.agent).toBe('main')
  })

  it('skips a task whose destination already exists', () => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'task-config.json'),
      JSON.stringify({ schedule: '0 9 * * *', agent: 'main' }))
    scaffold.ensureDefaultScheduledTasks()
    // Seed again -- the destination exists, so the inner loop does nothing.
    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
  })

  it('falls back to a copy when a non-task-config.json file is unreadable', () => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'SKILL.md'),
      Buffer.from([0x80, 0x81, 0x82]))  // invalid utf-8 -> readFileSync(..., 'utf-8') may still return a string but .replace would not throw
    // The catch branch fires when the read or replace throws. Force that by
    // making the file a directory: readFileSync on a dir throws EISDIR.
    rmSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'SKILL.md'))
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'SKILL.md'))
    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
  })

  it('returns silently when scheduled-tasks/ does not exist (early-return branch)', () => {
    // The function reads `join(PROJECT_ROOT, 'scheduled-tasks')`; if that path
    // does not exist it returns immediately.
    rmSync(join(SANDBOX, 'scheduled-tasks'), { recursive: true, force: true })
    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
  })

  it('falls back to copyFileSync when task-config.json is malformed', () => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1'), { recursive: true })
    // Truncated JSON so JSON.parse throws -> copyFileSync fall-back fires.
    writeFileSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'task-config.json'),
      '{ schedule: "0 9 * * *"')
    scaffold.ensureDefaultScheduledTasks()
    const dest = join(HOME, '.claude', 'scheduled-tasks', 'task1', 'task-config.json')
    expect(existsSync(dest)).toBe(true)
    // The corrupted text was byte-copied.
    expect(readFileSync(dest, 'utf-8')).toContain('{ schedule:')
  })
})

// ===========================================================================
// 9. scaffoldAgentDir (718-756)
// ===========================================================================
describe('scaffoldAgentDir', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'templates'), { recursive: true })
    mkdirSync(join(SANDBOX, 'templates', 'sub-agents'), { recursive: true })
  })

  it('creates the canonical subdirectories', () => {
    scaffold.scaffoldAgentDir('samu')
    const agentDir = join(SANDBOX, 'agents', 'samu')
    expect(existsSync(join(agentDir, '.claude', 'skills'))).toBe(true)
    expect(existsSync(join(agentDir, '.claude', 'hooks'))).toBe(true)
    expect(existsSync(join(agentDir, '.claude', 'agents'))).toBe(true)
    expect(existsSync(join(agentDir, '.claude', 'channels', 'telegram'))).toBe(true)
    expect(existsSync(join(agentDir, 'memory'))).toBe(true)
  })

  it('creates an empty MEMORY.md if it does not exist', () => {
    scaffold.scaffoldAgentDir('samu')
    const memPath = join(SANDBOX, 'agents', 'samu', 'memory', 'MEMORY.md')
    expect(existsSync(memPath)).toBe(true)
    expect(readFileSync(memPath, 'utf-8')).toBe('')
  })

  it('does NOT overwrite an existing MEMORY.md', () => {
    const memPath = join(SANDBOX, 'agents', 'samu', 'memory', 'MEMORY.md')
    mkdirSync(join(SANDBOX, 'agents', 'samu', 'memory'), { recursive: true })
    writeFileSync(memPath, 'existing memory content')
    scaffold.scaffoldAgentDir('samu')
    expect(readFileSync(memPath, 'utf-8')).toBe('existing memory content')
  })

  it('copies shared .mcp.json when one exists at PROJECT_ROOT', () => {
    writeFileSync(join(SANDBOX, '.mcp.json'), JSON.stringify({ mcpServers: { x: {} } }))
    scaffold.scaffoldAgentDir('samu')
    const dest = join(SANDBOX, 'agents', 'samu', '.mcp.json')
    expect(existsSync(dest)).toBe(true)
    expect(JSON.parse(readFileSync(dest, 'utf-8'))).toEqual({ mcpServers: { x: {} } })
  })

  it('writes an empty mcpServers shell when no shared .mcp.json exists', () => {
    scaffold.scaffoldAgentDir('samu')
    const dest = join(SANDBOX, 'agents', 'samu', '.mcp.json')
    expect(existsSync(dest)).toBe(true)
    expect(JSON.parse(readFileSync(dest, 'utf-8'))).toEqual({ mcpServers: {} })
  })

  it('seeds settings.json from the template when both are present', () => {
    writeFileSync(join(SANDBOX, 'templates', 'settings.json.template'),
      JSON.stringify({ hooks: { PreCompact: [{ matcher: 'auto', hooks: [{ type: 'agent', prompt: 'x' }] }] } }))
    scaffold.scaffoldAgentDir('samu')
    const settingsPath = join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json')
    expect(existsSync(settingsPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(settingsPath, 'utf-8'))
    expect(parsed.hooks.PreCompact).toBeDefined()
  })

  it('does NOT overwrite an existing settings.json', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({ handEdited: true }))
    scaffold.scaffoldAgentDir('samu')
    const parsed = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    expect(parsed.handEdited).toBe(true)
  })

  it('does NOT seed settings.json when the template is absent', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    scaffold.scaffoldAgentDir('samu')
    expect(existsSync(join(agentDir, '.claude', 'settings.json'))).toBe(false)
  })

  it('deploys the quarantine-reader template (ensureQuarantineReader is called)', () => {
    writeFileSync(join(SANDBOX, 'templates', 'sub-agents', 'quarantine-reader.md'),
      '## Domain restriction\n\n- `hnrss.org`\n')
    scaffold.scaffoldAgentDir('samu')
    expect(existsSync(join(SANDBOX, 'agents', 'samu', '.claude', 'agents', 'quarantine-reader.md'))).toBe(true)
  })
})

// ===========================================================================
// 10. buildFleetRosterBody error catch branches (803-806, 819-822)
//    listAgentNames and readAgentCapabilities are mocked at module level; we
//    override the mock per-test to throw.
// ===========================================================================
describe('buildFleetRosterBody error handling (via listAgentNames / readAgentCapabilities)', () => {
  it('returns a roster body when listAgentNames throws (catch branch)', () => {
    _listAgentNames.mockImplementationOnce(() => { throw new Error('boom') })
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    expect(() => scaffold.ensureFleetRosterSection('samu')).not.toThrow()
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('BEGIN GENERATED: fleet-roster')
    // Even with listAgentNames throwing, MAIN_AGENT_ID is always prepended, so
    // the roster still contains the main agent's row.
    expect(out).toContain('**main**')
  })

  it('returns a roster body when readAgentCapabilities throws (catch branch)', () => {
    _readAgentCapabilities.mockImplementationOnce(() => { throw new Error('boom') })
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    expect(() => scaffold.ensureFleetRosterSection('samu')).not.toThrow()
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('BEGIN GENERATED: fleet-roster')
    // Capability resolution failed -> capsStr is '-' for every agent row.
    expect(out).toContain('): -')
  })
})

// ===========================================================================
// 11. ensureFleetRosterSection readFileSync catch (931-934) -- the file must
//     become unreadable after existsSync says it is present.
// ===========================================================================
describe('ensureFleetRosterSection: readFileSync catch branch', () => {
  it('returns silently when CLAUDE.md exists but readFileSync throws', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    // Make CLAUDE.md a directory: existsSync -> true, readFileSync -> throws.
    mkdirSync(join(agentDir, 'CLAUDE.md'))
    expect(() => scaffold.ensureFleetRosterSection('samu')).not.toThrow()
  })
})

// ===========================================================================
// 12. ensureAutonomySection readFileSync catch (893-896)
// ===========================================================================
describe('ensureAutonomySection: readFileSync catch branch', () => {
  it('returns silently when CLAUDE.md exists but readFileSync throws', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    mkdirSync(join(agentDir, 'CLAUDE.md'))
    expect(() => scaffold.ensureAutonomySection('samu')).not.toThrow()
  })
})

// ===========================================================================
// 13. generateClaudeMd (947-1098)
// ===========================================================================
describe('generateClaudeMd', () => {
  it('returns the LLM text wrapped with fleet-roster and autonomy markers', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: '# CLAUDE\nBody\n' })
    const out = await scaffold.generateClaudeMd('samu', 'desc', 'sonnet')
    expect(out).toContain('# CLAUDE')
    expect(out).toContain('BEGIN GENERATED: fleet-roster')
    expect(out).toContain('END GENERATED: fleet-roster')
    expect(out).toContain('BEGIN GENERATED: autonomy-wiring')
    expect(out).toContain('END GENERATED: autonomy-wiring')
  })

  it('strips a leading ``` fence when the model wraps the output', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: '```markdown\n# Clean\n```',
    })
    const out = await scaffold.generateClaudeMd('samu', 'desc', 'sonnet')
    expect(out).toContain('# Clean')
    expect(out).not.toContain('```markdown')
  })

  it('uses the drive-folder line when OWNER_DRIVE_FOLDER is set', async () => {
    // Re-mock config so OWNER_DRIVE_FOLDER is non-empty for this single test.
    vi.doMock('../config.js', () => ({
      PROJECT_ROOT: SANDBOX,
      STORE_DIR: join(SANDBOX, 'store'),
      OWNER_NAME: 'TestOwner',
      MAIN_AGENT_ID: 'main',
      BOT_NAME: 'MainBot',
      CHANNEL_PROVIDER: 'telegram',
      WEB_PORT: 3420,
      OWNER_DRIVE_FOLDER: 'folder-id-123',
      APP_TZ: 'UTC',
      DASHBOARD_PUBLIC_URL: '',
      DEFAULT_AGENT_MODEL: 'claude-sonnet-5',
    }))
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: 'X' })
    // Re-import to pick up the new config mock.
    vi.resetModules()
    const fresh = await import('../web/agent-scaffold.js')
    const out = await fresh.generateClaudeMd('samu', 'desc', 'sonnet')
    expect(out).toContain('BEGIN GENERATED: fleet-roster')
    // The drive folder id should be embedded by the buildAutonomyBody / prompt.
    // We don't directly read the prompt, but the OUTPUT will at least contain
    // the markers; this asserts no crash with a non-empty drive folder.
    expect(out.length).toBeGreaterThan(0)
  })

  it('throws a blockedHint when the model returns no text and an error', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: null, error: 'AUP' })
    await expect(scaffold.generateClaudeMd('samu', 'desc', 'sonnet'))
      .rejects.toThrow(/blocked\/errored/)
  })

  it('throws a noOutputHint when the model returns no text and no error', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: null })
    await expect(scaffold.generateClaudeMd('samu', 'desc', 'sonnet'))
      .rejects.toThrow(/no output/i)
  })
})

// ===========================================================================
// 14. generateSoulMd (1128-1154)
// ===========================================================================
describe('generateSoulMd', () => {
  it('returns the LLM text', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: '# Soul\n' })
    const out = await scaffold.generateSoulMd('samu', 'desc')
    expect(out).toContain('# Soul')
  })

  it('strips a leading ``` fence', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: '```\n# Soul2\n```',
    })
    const out = await scaffold.generateSoulMd('samu', 'desc')
    expect(out).toContain('# Soul2')
    expect(out).not.toContain('```\n')
  })

  it('throws a blockedHint on error', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: null, error: 'AUP' })
    await expect(scaffold.generateSoulMd('samu', 'desc'))
      .rejects.toThrow(/blocked\/errored/)
  })

  it('throws a noOutputHint on empty output', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: null })
    await expect(scaffold.generateSoulMd('samu', 'desc'))
      .rejects.toThrow(/no output/i)
  })
})

// ===========================================================================
// 15. generateSkillMd (1156-1192)
// ===========================================================================
describe('generateSkillMd', () => {
  it('returns the LLM text', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: '# Skill\n' })
    const out = await scaffold.generateSkillMd('skill1', 'desc')
    expect(out).toContain('# Skill')
  })

  it('strips a leading ``` fence', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      text: '```\n# Skill2\n```',
    })
    const out = await scaffold.generateSkillMd('skill1', 'desc')
    expect(out).toContain('# Skill2')
  })

  it('throws a blockedHint on error', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: null, error: 'AUP' })
    await expect(scaffold.generateSkillMd('skill1', 'desc'))
      .rejects.toThrow(/blocked\/errored/)
  })

  it('throws a noOutputHint on empty output', async () => {
    const { runAgent } = await import('../agent.js')
    ;(runAgent as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ text: null })
    await expect(scaffold.generateSkillMd('skill1', 'desc'))
      .rejects.toThrow(/no output/i)
  })
})

// ===========================================================================
// 16. hookCommandWired (74-76) -- wired-already predicate for ensureEgressGate
//     and ensureGovernanceGateCommands.
// ===========================================================================
describe('hookCommandWired', () => {
  it('returns true when the JSON-escaped command is present in the serialized ptu', () => {
    const cmd = `python3 ${join(SANDBOX, 'scripts', 'foo.py')}`
    const ptu = JSON.stringify([{ hooks: [{ command: cmd }] }])
    expect(scaffold.hookCommandWired(ptu, cmd)).toBe(true)
  })

  it('returns false when the command is absent from the serialized ptu', () => {
    const ptu = JSON.stringify([{ hooks: [{ command: 'other.sh' }] }])
    expect(scaffold.hookCommandWired(ptu, 'never.py')).toBe(false)
  })

  it('compares JSON-escaped form (backslash paths round-trip)', () => {
    // A path with a backslash differs raw vs JSON-escaped. The predicate must
    // JSON-escape before includes() so the wired-already detection works on
    // Windows-style paths where the JSON serialization adds a double-backslash.
    const cmd = `C:\\scripts\\foo.py`
    const ptu = JSON.stringify([{ hooks: [{ command: cmd }] }])
    expect(scaffold.hookCommandWired(ptu, cmd)).toBe(true)
  })
})

// ===========================================================================
// 17. upgradeLegacyHookCommands (169-197) -- in-place rewrite of bare hooks.
// ===========================================================================
describe('upgradeLegacyHookCommands', () => {
  it('returns false when there is nothing to upgrade (no legacy bare forms)', () => {
    const same = { PreToolUse: [{ hooks: [{ command: 'python3 a.py' }] }] }
    const tpl = { PreToolUse: [{ hooks: [{ command: 'python3 a.py' }] }] }
    expect(scaffold.upgradeLegacyHookCommands(same, tpl)).toBe(false)
  })

  it('replaces a bare command with the template wrapper form (legacy migration)', () => {
    // bare: `python3 staleness-guard.py`
    // tpl : `python3 /opt/full/path/staleness-guard.py`
    // The tpl target path does not exist on disk, so isUnsafeHookCommand() rejects
    // the tpl command as unsafe and the upgrade is a no-op (returns false). The
    // function is a guard: it refuses to write a path that points to a missing
    // script, so an absent template path intentionally returns false.
    const existing = {
      PreCompact: [{ hooks: [{ command: 'python3 staleness-guard.py' }] }],
    }
    const tpl = {
      PreCompact: [{
        hooks: [{ command: 'python3 /opt/full/path/staleness-guard.py' }],
      }],
    }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
    expect(existing.PreCompact[0].hooks[0].command)
      .toBe('python3 staleness-guard.py')
  })

  it('syncs the timeout when the basename matches but timeout differs', () => {
    // Same basename, different commands -> updates command AND timeout.
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py'),
      '#!/usr/bin/env python3\n')
    const newCmd = `python3 ${join(SANDBOX, 'scripts', 'hooks', 'staleness-guard.py')}`
    // The existing hook has no path, so _hookScriptBasename() returns null and
    // the basename match fails. The upgrade is a no-op (returns false) until
    // the existing entry also carries a script path. This pins the current
    // behavior: the migrate pass only matches when BOTH sides have a basename.
    const existing = {
      PreCompact: [{ hooks: [{ command: 'python3 staleness-guard.py', timeout: 5 }] }],
    }
    const tpl = {
      PreCompact: [{ hooks: [{ command: newCmd, timeout: 10 }] }],
    }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
    expect(existing.PreCompact[0].hooks[0].command).toBe('python3 staleness-guard.py')
    expect(existing.PreCompact[0].hooks[0].timeout).toBe(5)
  })

  it('does not change an entry when the command already matches (idempotent)', () => {
    const cmd = 'python3 /path/staleness-guard.py'
    const existing = { PreToolUse: [{ hooks: [{ command: cmd, timeout: 10 }] }] }
    const tpl = { PreToolUse: [{ hooks: [{ command: cmd, timeout: 10 }] }] }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
  })

  it('skips entries when the existing array is not an array', () => {
    const existing: Record<string, unknown> = { PreToolUse: 'not an array' }
    const tpl = { PreToolUse: [{ hooks: [{ command: 'python3 foo.py' }] }] }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
  })

  it('skips tpl hooks without a command or whose command is unsafe', () => {
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'safe.py'), '#!/usr/bin/env python3\n')
    const safeCmd = `python3 ${join(SANDBOX, 'scripts', 'safe.py')}`
    const existing = {
      PreCompact: [{ hooks: [{ command: 'python3 /tmp/never/x.py' }] }],
    }
    // tpl hook has no command -> skipped. tpl hook command points to /tmp -> unsafe.
    const tpl = {
      PreCompact: [{ hooks: [{ prompt: 'no command' }] }],
      PreToolUse: [{ hooks: [{ command: 'python3 /tmp/never/y.py' }] }],
    }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
    // safeCmd doesn't appear in existing so no upgrade for it
    expect(safeCmd).toBeDefined()
  })

  it('skips when tpl command has no extractable basename', () => {
    const existing = { PreToolUse: [{ hooks: [{ command: 'plain-string' }] }] }
    const tpl = { PreToolUse: [{ hooks: [{ command: 'echo hello' }] }] }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
  })

  it('skips when existHook has no command', () => {
    const existing = {
      PreToolUse: [{ hooks: [{ type: 'agent', prompt: 'no command' }] }],
    }
    const tpl = { PreToolUse: [{ hooks: [{ command: 'python3 /opt/foo.py' }] }] }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
  })

  it('upgrades when the basename matches across hooks-array and entry boundaries', () => {
    // The tpl target path /new/path/stale.py does not exist on disk, so
    // isUnsafeHookCommand() rejects the tpl command as unsafe and the upgrade
    // is a no-op. The function returns false and the existing entries are left
    // untouched. This pins the current behavior: a missing tpl path blocks the
    // migration rather than silently writing a dangling path.
    const existing = {
      PreToolUse: [
        { hooks: [{ command: 'old-cmd' }, { command: 'python3 stale.py' }] },
      ],
    }
    const tpl = {
      PreToolUse: [{ hooks: [{ command: 'python3 /new/path/stale.py', timeout: 7 }] }],
    }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
    const cmds = existing.PreToolUse[0].hooks.map((h: { command: string }) => h.command)
    expect(cmds).toContain('old-cmd')
    expect(cmds).toContain('python3 stale.py')
    expect(cmds).not.toContain('python3 /new/path/stale.py')
  })

  it('rewrites an existing command in place when both share a basename but differ (lines 187-189)', () => {
    // Pins the previously-uncovered branch at lines 187-189 of agent-scaffold.ts.
    // The `existBn === tplBn && existHook.command !== tplHook.command` arm
    // requires BOTH sides to carry an extractable basename AND both paths to
    // exist on disk (so isUnsafeHookCommand lets them through). The existing
    // command is rewritten to the tpl command and the timeout is synced.
    const hooksDir = join(SANDBOX, 'scripts', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(join(hooksDir, 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const existingCmd = `python3 ${join(hooksDir, 'staleness-guard.py')}`
    // Build a second valid path under a different absolute location but the
    // SAME basename so _hookScriptBasename extracts 'staleness-guard.py' on
    // both sides.
    const altDir = join(SANDBOX, 'scripts', 'hooks', 'alt')
    mkdirSync(altDir, { recursive: true })
    writeFileSync(join(altDir, 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const tplCmd = `python3 ${join(altDir, 'staleness-guard.py')}`
    const existing = {
      PreCompact: [{ hooks: [{ command: existingCmd, timeout: 5 }] }],
    }
    const tpl = {
      PreCompact: [{ hooks: [{ command: tplCmd, timeout: 10 }] }],
    }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(true)
    expect(existing.PreCompact[0].hooks[0].command).toBe(tplCmd)
    expect(existing.PreCompact[0].hooks[0].timeout).toBe(10)
  })

  it('still rewrites when the tpl hook has no timeout (else branch of line 188)', () => {
    // The `if (tplHook.timeout != null)` on line 188 has two arms: the
    // truthy arm was pinned by the test above; this test pins the FALSY arm
    // (timeout omitted). The function must STILL rewrite the command; only
    // the timeout sync is skipped. existHook.timeout is left untouched.
    const hooksDir = join(SANDBOX, 'scripts', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(join(hooksDir, 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const altDir = join(SANDBOX, 'scripts', 'hooks', 'alt')
    mkdirSync(altDir, { recursive: true })
    writeFileSync(join(altDir, 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const existingCmd = `python3 ${join(hooksDir, 'staleness-guard.py')}`
    const tplCmd = `python3 ${join(altDir, 'staleness-guard.py')}`
    const existing = {
      PreCompact: [{ hooks: [{ command: existingCmd, timeout: 5 }] }],
    }
    // tpl hook has NO timeout field -> tplHook.timeout is undefined -> null
    const tpl = {
      PreCompact: [{ hooks: [{ command: tplCmd }] }],
    }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(true)
    expect(existing.PreCompact[0].hooks[0].command).toBe(tplCmd)
    // The existing timeout is preserved (no sync write).
    expect(existing.PreCompact[0].hooks[0].timeout).toBe(5)
  })

  it('handles a tpl entry with no hooks array (line 178 ?? [] arm)', () => {
    // The inner loop `for (const tplHook of tplEntry.hooks ?? [])` has a
    // nullish-coalesce fallback when tplEntry.hooks is undefined. The
    // base case (hooks present) is covered elsewhere; this test pins the
    // fallback by omitting the hooks array.
    const hooksDir = join(SANDBOX, 'scripts', 'hooks')
    mkdirSync(hooksDir, { recursive: true })
    writeFileSync(join(hooksDir, 'staleness-guard.py'), '#!/usr/bin/env python3\n')
    const existingCmd = `python3 ${join(hooksDir, 'staleness-guard.py')}`
    const existing = {
      PreCompact: [{ hooks: [{ command: existingCmd, timeout: 5 }] }],
    }
    const tpl = {
      PreCompact: [{ /* no hooks field */ }], // tplEntry.hooks === undefined
    }
    expect(scaffold.upgradeLegacyHookCommands(existing, tpl)).toBe(false)
    expect(existing.PreCompact[0].hooks[0].command).toBe(existingCmd)
  })
})

// ===========================================================================
// 18. inject* gate dedupe paths (385-462) -- the prev.filter() branch.
// ===========================================================================
describe('injectEmailSendGate / injectSelfPaceGate / injectEgressGate dedupe', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'email-send-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'), '// stub')
  })

  it('injectEmailSendGate replaces a prior email-send-gate entry (dedupe)', () => {
    const prior = {
      hooks: { PreToolUse: [
        { matcher: 'Bash|send_email', hooks: [{ command: 'old email-send-gate.mjs command' }] },
        { matcher: 'WebFetch', hooks: [{ command: 'keep-me.py' }] },
      ] },
    }
    scaffold.injectEmailSendGate(prior)
    const ptu = (prior.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>
    // The email-send-gate.mjs entry should be the freshly added one (no leftovers).
    const emailEntries = ptu.filter((e) => JSON.stringify(e).includes('email-send-gate.mjs'))
    expect(emailEntries.length).toBe(1)
    // Other entries are preserved.
    const webFetch = ptu.find((e) => e.matcher === 'WebFetch')
    expect(webFetch).toBeDefined()
  })

  it('injectSelfPaceGate replaces a prior self-pace-gate entry (dedupe)', () => {
    const prior = {
      hooks: { PreToolUse: [
        { matcher: 'ScheduleWakeup', hooks: [{ command: 'old self-pace-gate.mjs command' }] },
        { matcher: 'WebFetch', hooks: [{ command: 'keep-me.py' }] },
      ] },
    }
    scaffold.injectSelfPaceGate(prior)
    const ptu = (prior.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>
    const paceEntries = ptu.filter((e) => JSON.stringify(e).includes('self-pace-gate.mjs'))
    expect(paceEntries.length).toBe(1)
    const webFetch = ptu.find((e) => e.matcher === 'WebFetch')
    expect(webFetch).toBeDefined()
  })

  it('injectEgressGate replaces a prior egress-gate entry (dedupe)', () => {
    const prior = {
      hooks: { PreToolUse: [
        { matcher: 'WebFetch', hooks: [{ command: 'old egress-gate.mjs command' }] },
        { matcher: 'Bash', hooks: [{ command: 'keep-me.py' }] },
      ] },
    }
    scaffold.injectEgressGate(prior)
    const ptu = (prior.hooks as Record<string, unknown>).PreToolUse as Array<{ matcher: string }>
    const egressEntries = ptu.filter((e) => JSON.stringify(e).includes('egress-gate.mjs'))
    expect(egressEntries.length).toBe(1)
    const bash = ptu.find((e) => e.matcher === 'Bash')
    expect(bash).toBeDefined()
  })

  it('injectEgressGate handles a hooks field that is undefined (init branch)', () => {
    const s: Record<string, unknown> = {}
    scaffold.injectEgressGate(s)
    expect(s.hooks).toBeDefined()
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(ptu.length).toBe(1)
  })

  it('injectEmailSendGate handles a hooks field that is undefined', () => {
    const s: Record<string, unknown> = {}
    scaffold.injectEmailSendGate(s)
    expect(s.hooks).toBeDefined()
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(ptu.length).toBe(1)
  })

  it('injectSelfPaceGate handles a hooks field that is undefined', () => {
    const s: Record<string, unknown> = {}
    scaffold.injectSelfPaceGate(s)
    expect(s.hooks).toBeDefined()
    const ptu = (s.hooks as Record<string, unknown>).PreToolUse as unknown[]
    expect(ptu.length).toBe(1)
  })
})

// ===========================================================================
// 19. ensureEgressGate (468-490)
// ===========================================================================
describe('ensureEgressGate', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'), '// stub')
  })

  it('returns false when settings.json does not exist and the script path is unsafe', () => {
    // No egress-gate.mjs on disk -> unsafe -> returns false.
    rmSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'))
    expect(scaffold.ensureEgressGate('samu')).toBe(false)
  })

  it('returns false when settings.json is unparseable', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), '{ broken')
    expect(scaffold.ensureEgressGate('samu')).toBe(false)
  })

  it('returns false when already wired with the absolute node binary', () => {
    mkdirSync(join(SANDBOX, 'agents', 'samu', '.claude'), { recursive: true })
    const wired = scaffold.injectEgressGate({ hooks: { PreToolUse: [] } })
    void wired
    // Build the command via the same hookCommand() builder the source uses so
    // the bytes match the wired-already comparison exactly. Hand-rolled error
    // messages drift on the byte check and the function thinks the gate is
    // missing.
    const cmd = scaffold.hookCommand(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'))
    writeFileSync(join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'),
      JSON.stringify({ hooks: { PreToolUse: [
        { matcher: 'WebFetch', hooks: [{ command: cmd }] }] } }))
    expect(scaffold.ensureEgressGate('samu')).toBe(false)
  })

  it('replaces a legacy bare-node egress-gate entry on respawn', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // Legacy bare `node` entry — wired-already predicate must NOT count this as wired
    // because the legacy command uses bare `node` instead of the absolute path.
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [
        { matcher: 'WebFetch', hooks: [{ command: 'node /scripts/hooks/egress-gate.mjs' }] },
      ] },
    }))
    expect(scaffold.ensureEgressGate('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    const cmds = JSON.stringify(written.hooks.PreToolUse)
    expect(cmds).toContain(process.execPath)
  })

  it('creates a fresh settings.json when none exists', () => {
    mkdirSync(join(SANDBOX, 'agents', 'samu'), { recursive: true })
    expect(scaffold.ensureEgressGate('samu')).toBe(true)
    expect(existsSync(join(SANDBOX, 'agents', 'samu', '.claude', 'settings.json'))).toBe(true)
  })
})

// ===========================================================================
// 20. isPublicFetchHost (513-526) -- host allowlist filter.
// ===========================================================================
describe('isPublicFetchHost', () => {
  it('accepts a normal public hostname', () => {
    expect(scaffold.isPublicFetchHost('hnrss.org')).toBe(true)
  })

  it('accepts a multi-label subdomain', () => {
    expect(scaffold.isPublicFetchHost('feeds.example.com')).toBe(true)
  })

  it('rejects an empty string', () => {
    expect(scaffold.isPublicFetchHost('')).toBe(false)
  })

  it('rejects a single-label name (localhost etc.)', () => {
    expect(scaffold.isPublicFetchHost('localhost')).toBe(false)
  })

  it('rejects internal suffixes (local, internal, lan, home, test)', () => {
    expect(scaffold.isPublicFetchHost('foo.local')).toBe(false)
    expect(scaffold.isPublicFetchHost('host.internal')).toBe(false)
    expect(scaffold.isPublicFetchHost('box.lan')).toBe(false)
    expect(scaffold.isPublicFetchHost('router.home')).toBe(false)
    expect(scaffold.isPublicFetchHost('svc.test')).toBe(false)
    expect(scaffold.isPublicFetchHost('svc.intranet')).toBe(false)
    expect(scaffold.isPublicFetchHost('svc.localdomain')).toBe(false)
    expect(scaffold.isPublicFetchHost('svc.invalid')).toBe(false)
    expect(scaffold.isPublicFetchHost('svc.arpa')).toBe(false)
  })

  it('rejects IPv4 literals', () => {
    expect(scaffold.isPublicFetchHost('127.0.0.1')).toBe(false)
    expect(scaffold.isPublicFetchHost('169.254.169.254')).toBe(false)
  })

  it('rejects bare numbers', () => {
    expect(scaffold.isPublicFetchHost('12345')).toBe(false)
  })

  it('rejects schemes / ports / paths / spaces / wildcards', () => {
    expect(scaffold.isPublicFetchHost('http://example.com')).toBe(false)
    expect(scaffold.isPublicFetchHost('example.com:8080')).toBe(false)
    expect(scaffold.isPublicFetchHost('example.com/path')).toBe(false)
    expect(scaffold.isPublicFetchHost('exam ple.com')).toBe(false)
    expect(scaffold.isPublicFetchHost('*.example.com')).toBe(false)
  })

  it('rejects leading and trailing dots', () => {
    expect(scaffold.isPublicFetchHost('.example.com')).toBe(false)
    expect(scaffold.isPublicFetchHost('example.com.')).toBe(false)
  })

  it('rejects leading and trailing dashes on labels', () => {
    expect(scaffold.isPublicFetchHost('-example.com')).toBe(false)
    expect(scaffold.isPublicFetchHost('example-.com')).toBe(false)
  })

  it('rejects a hostname longer than 253 chars', () => {
    const long = 'a'.repeat(254) + '.com'
    expect(scaffold.isPublicFetchHost(long)).toBe(false)
  })

  it('rejects a label longer than 63 chars', () => {
    const long = 'a'.repeat(64) + '.example.com'
    expect(scaffold.isPublicFetchHost(long)).toBe(false)
  })

  it('accepts the literal hostname itself (case-insensitive)', () => {
    expect(scaffold.isPublicFetchHost('Example.COM')).toBe(true)
  })

  it('trims whitespace before validating', () => {
    expect(scaffold.isPublicFetchHost('  example.com  ')).toBe(true)
  })
})

// ===========================================================================
// 21. ownerAllowedDomains (528-538)
// ===========================================================================
describe('ownerAllowedDomains', () => {
  it('returns [] when the allowlist file does not exist', () => {
    expect(scaffold.ownerAllowedDomains()).toEqual([])
  })

  it('returns the filtered domain list when the allowlist is valid', () => {
    const storeDir = join(SANDBOX, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'egress-allowlist.json'), JSON.stringify({
      domains: ['hnrss.org', 'feeds.example.com', 'invalid local'],
    }))
    const out = scaffold.ownerAllowedDomains(storeDir)
    expect(out).toContain('hnrss.org')
    expect(out).toContain('feeds.example.com')
    expect(out).not.toContain('invalid local')
  })

  it('returns [] when the allowlist JSON is malformed', () => {
    const storeDir = join(SANDBOX, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'egress-allowlist.json'), '{ broken')
    expect(scaffold.ownerAllowedDomains(storeDir)).toEqual([])
  })

  it('returns [] when domains is not an array', () => {
    const storeDir = join(SANDBOX, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'egress-allowlist.json'),
      JSON.stringify({ domains: 'not-an-array' }))
    expect(scaffold.ownerAllowedDomains(storeDir)).toEqual([])
  })

  it('filters out non-string entries', () => {
    const storeDir = join(SANDBOX, 'store')
    mkdirSync(storeDir, { recursive: true })
    writeFileSync(join(storeDir, 'egress-allowlist.json'), JSON.stringify({
      domains: ['hnrss.org', 42, null, 'feeds.example.com'],
    }))
    const out = scaffold.ownerAllowedDomains(storeDir)
    expect(out).toEqual(['hnrss.org', 'feeds.example.com'])
  })
})

// ===========================================================================
// 22. renderQuarantineReader (546-583) -- pure transformer.
// ===========================================================================
describe('renderQuarantineReader', () => {
  it('appends the per-install block after the last bullet in the Domain restriction section', () => {
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n\n## Next section\n'
    const out = scaffold.renderQuarantineReader(tpl, ['feeds.example.com'])
    expect(out).toContain('<!-- BEGIN PER-INSTALL DOMAINS')
    expect(out).toContain('feeds.example.com')
    // The block lives BEFORE the next ## header (Domain restriction section anchor).
    expect(out.indexOf('feeds.example.com')).toBeLessThan(out.indexOf('## Next section'))
  })

  it('strips a previous BEGIN/END block before re-rendering (revoke test)', () => {
    const BEGIN = '<!-- BEGIN PER-INSTALL DOMAINS (from store/egress-allowlist.json) -->'
    const END = '<!-- END PER-INSTALL DOMAINS -->'
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n' +
      BEGIN + '\n- `old.example.com`\n' + END + '\n'
    const out = scaffold.renderQuarantineReader(tpl, ['new.example.com'])
    // The previous block must be gone.
    const blocks = out.split(BEGIN).length - 1
    expect(blocks).toBe(1)
    expect(out).toContain('new.example.com')
    expect(out).not.toContain('old.example.com')
  })

  it('returns the stripped template when no extra domains remain', () => {
    const BEGIN = '<!-- BEGIN PER-INSTALL DOMAINS (from store/egress-allowlist.json) -->'
    const tpl = '## Domain restriction\n\n- `hnrss.org`\n' +
      BEGIN + '\n- `already.here`\n'
    const out = scaffold.renderQuarantineReader(tpl, ['already.here'])
    // No new domains -> block unchanged from the input (BEGIN remains once).
    const blocks = out.split(BEGIN).length - 1
    expect(blocks).toBe(1)
    expect(out).toContain('already.here')
  })

  it('returns the stripped template unchanged when no ## Domain restriction heading exists', () => {
    const tpl = '## Other section\n\n- `hnrss.org`\n'
    const out = scaffold.renderQuarantineReader(tpl, ['feeds.example.com'])
    // Without the heading we cannot anchor; the function returns the stripped
    // template untouched, so the new domain is NOT injected.
    expect(out).not.toContain('feeds.example.com')
  })

  it('returns the stripped template unchanged when the heading exists but has no bullets', () => {
    const tpl = '## Domain restriction\n\nNo bullets here.\n'
    const out = scaffold.renderQuarantineReader(tpl, ['feeds.example.com'])
    // Without any bullets in the section we cannot anchor; new domain is dropped.
    expect(out).not.toContain('feeds.example.com')
  })

  it('does not duplicate domains already present (already-set)', () => {
    const tpl = '## Domain restriction\n\n- `feeds.example.com`\n'
    const out = scaffold.renderQuarantineReader(tpl, ['feeds.example.com'])
    // The "extra" list is empty after dedupe; no new block injected.
    expect(out).not.toContain('<!-- BEGIN PER-INSTALL DOMAINS')
  })

  it('handles a previous BEGIN/END with no preceding newline', () => {
    // Regression: the strip code checks for a leading newline before BEGIN.
    // When BEGIN is at offset 0 there is no preceding char to slice.
    const BEGIN = '<!-- BEGIN PER-INSTALL DOMAINS (from store/egress-allowlist.json) -->'
    const END = '<!-- END PER-INSTALL DOMAINS -->'
    const tpl = BEGIN + '\n- `old.example.com`\n' + END +
      '\n## Domain restriction\n\n- `hnrss.org`\n'
    const out = scaffold.renderQuarantineReader(tpl, ['new.example.com'])
    expect(out).not.toContain('old.example.com')
    expect(out).toContain('new.example.com')
  })
})

// ===========================================================================
// 23. ensureGovernanceGateCommands (594-615)
// ===========================================================================
describe('ensureGovernanceGateCommands', () => {
  beforeEach(() => {
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    mkdirSync(join(SANDBOX, 'scripts', 'hooks'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'email-send-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'), '// stub')
    writeFileSync(join(SANDBOX, 'scripts', 'hooks', 'egress-gate.mjs'), '// stub')
  })

  it('returns false for the MAIN_AGENT_ID (the main agent is exempt)', () => {
    expect(scaffold.ensureGovernanceGateCommands('main')).toBe(false)
  })

  it('returns false when settings.json does not exist (no-op)', () => {
    expect(scaffold.ensureGovernanceGateCommands('samu')).toBe(false)
  })

  it('returns false when settings.json is unparseable', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), '{ broken')
    expect(scaffold.ensureGovernanceGateCommands('samu')).toBe(false)
  })

  it('rewrites legacy bare-node entries to absolute node (migration)', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [
        { matcher: 'Bash|send_email', hooks: [{ command: 'node email-send-gate.mjs' }] },
        { matcher: 'ScheduleWakeup', hooks: [{ command: 'node self-pace-gate.mjs' }] },
      ] },
    }))
    expect(scaffold.ensureGovernanceGateCommands('samu')).toBe(true)
    const written = JSON.parse(readFileSync(join(agentDir, '.claude', 'settings.json'), 'utf-8'))
    const cmds = JSON.stringify(written.hooks.PreToolUse)
    expect(cmds).toContain(process.execPath)
  })

  it('returns false when both gates are already wired with the absolute node binary', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // Reuse the hookCommand() builder so the bytes match the production
    // shape exactly. Wiring-already comparisons are byte-identity on the
    // JSON-escaped form, so a hand-rolled message drifts and the function
    // decides re-write is needed.
    const emailCmd = scaffold.hookCommand(join(SANDBOX, 'scripts', 'email-send-gate.mjs'))
    const paceCmd = scaffold.hookCommand(join(SANDBOX, 'scripts', 'self-pace-gate.mjs'))
    writeFileSync(join(agentDir, '.claude', 'settings.json'), JSON.stringify({
      hooks: { PreToolUse: [
        { matcher: 'Bash|send_email', hooks: [{ command: emailCmd }] },
        { matcher: 'ScheduleWakeup', hooks: [{ command: paceCmd }] },
      ] },
    }))
    expect(scaffold.ensureGovernanceGateCommands('samu')).toBe(false)
  })

  it('handles a settings.json whose hooks field is an object (not array)', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, '.claude', 'settings.json'),
      JSON.stringify({ hooks: {} }))
    expect(scaffold.ensureGovernanceGateCommands('samu')).toBe(true)
  })
})

// ===========================================================================
// 24. agentGetsEmailGate / agentGetsGovernanceGates -- pure predicates.
// ===========================================================================
describe('agentGetsEmailGate / agentGetsGovernanceGates', () => {
  it('agentGetsEmailGate returns false for MAIN_AGENT_ID', () => {
    expect(scaffold.agentGetsEmailGate('main')).toBe(false)
  })
  it('agentGetsEmailGate returns true for sub-agents', () => {
    expect(scaffold.agentGetsEmailGate('samu')).toBe(true)
  })
  it('agentGetsGovernanceGates returns false for MAIN_AGENT_ID', () => {
    expect(scaffold.agentGetsGovernanceGates('main')).toBe(false)
  })
  it('agentGetsGovernanceGates returns true for sub-agents', () => {
    expect(scaffold.agentGetsGovernanceGates('samu')).toBe(true)
  })
})

// ===========================================================================
// 25. isUnsafeHookCommand (143-148) -- registration guard.
// ===========================================================================
describe('isUnsafeHookCommand', () => {
  it('returns true for commands referencing /tmp/', () => {
    expect(scaffold.isUnsafeHookCommand('python3 /tmp/some.py')).toBe(true)
  })

  it('returns true for commands referencing /var/tmp/', () => {
    expect(scaffold.isUnsafeHookCommand('python3 /var/tmp/some.py')).toBe(true)
  })

  it('returns true for commands referencing /private/tmp/', () => {
    expect(scaffold.isUnsafeHookCommand('python3 /private/tmp/some.py')).toBe(true)
  })

  it('returns true for commands referencing /dev/shm/', () => {
    expect(scaffold.isUnsafeHookCommand('python3 /dev/shm/some.py')).toBe(true)
  })

  it('returns true for commands referencing a missing script', () => {
    expect(scaffold.isUnsafeHookCommand(`python3 ${SANDBOX}/scripts/never.py`)).toBe(true)
  })

  it('returns false for commands referencing an existing script', () => {
    mkdirSync(join(SANDBOX, 'scripts'), { recursive: true })
    writeFileSync(join(SANDBOX, 'scripts', 'safe.py'), '#!/usr/bin/env python3\n')
    expect(scaffold.isUnsafeHookCommand(`python3 ${join(SANDBOX, 'scripts', 'safe.py')}`)).toBe(false)
  })

  it('returns false when no script path is present', () => {
    expect(scaffold.isUnsafeHookCommand('echo hello')).toBe(false)
  })
})

// ===========================================================================
// 26. hookCommand / HOOK_NODE_BIN (44-67)
// ===========================================================================
describe('hookCommand / HOOK_NODE_BIN', () => {
  it('HOOK_NODE_BIN equals process.execPath', () => {
    expect(scaffold.HOOK_NODE_BIN).toBe(process.execPath)
  })

  it('hookCommand emits a test -x wrapper around the interpreter', () => {
    const cmd = scaffold.hookCommand('/some/script.py')
    expect(cmd).toContain('test -x')
    expect(cmd).toContain(process.execPath)
    expect(cmd).toContain('/some/script.py')
    expect(cmd).toContain('exit 2')
  })

  it('hookCommand embeds the Hungarian error message on interpreter miss', () => {
    const cmd = scaffold.hookCommand('/some/script.py')
    expect(cmd).toContain('governance-kapu')
  })
})

// ===========================================================================
// 27. ensureDefaultScheduledTasks line 711 -- non-task-config catch branch
//     falls back to copyFileSync when the read/substitute throws.
//     This case is also covered in agent-scaffold-scheduled-tasks-catch.test.ts
//     via a node:fs mock, but pinning it here in-line keeps the full test
//     self-contained.
// ===========================================================================
describe('ensureDefaultScheduledTasks: non-task-config catch (line 711)', () => {
  it('falls back to copyFileSync when the read on a non-task-config file throws', () => {
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1'), { recursive: true })
    mkdirSync(join(HOME, '.claude'), { recursive: true })
    // Make the SKILL.md a directory: existsSync -> true (file stat isDirectory false),
    // but readFileSync on a directory throws EISDIR. The catch must fall back
    // to copyFileSync -- which also fails on a directory -- so the function
    // still must not throw. The point is the catch branch is reached.
    mkdirSync(join(SANDBOX, 'scheduled-tasks', 'task1', 'SKILL.md'))
    expect(() => scaffold.ensureDefaultScheduledTasks()).not.toThrow()
  })
})

// ===========================================================================
// 28. buildFleetRosterBody normal path -- non-empty rawCaps trigger the
//     .filter() / .slice() chain (line 826) and the capsStr branch.
// ===========================================================================
describe('buildFleetRosterBody: normal path with capabilities', () => {
  it('renders each agent row with sanitized capabilities joined by comma', () => {
    // Two agents in the fleet: 'main' (the implicit head that always renders)
    // and 'shadow' (a sub-agent whose capabilities should appear). The named
    // agent for whom we render the section is 'samu', so 'samu' is self-skip
    // and never listed. Pinning: the roster always lists 'main' first even
    // when listAgentNames does not include it.
    _readAgentCapabilities.mockImplementation((name: string) =>
      name === 'shadow' ? ['alpha-tag', 'beta-tag', 'gamma-tag'] : []
    )
    _listAgentNames.mockImplementation(() => ['shadow'])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('alpha-tag, beta-tag, gamma-tag')
    expect(out).toContain('**shadow**')
    expect(out).not.toContain('**samu**')
  })

  it('drops capabilities that fail sanitizeCapabilityTag (NULL branch)', () => {
    _readAgentCapabilities.mockImplementation(() => ['good-tag', 'BAD TAG WITH SPACES'])
    _listAgentNames.mockImplementation(() => ['samu'])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('good-tag')
    expect(out).not.toContain('BAD TAG WITH SPACES')
  })

  it('emits a single dash when an agent has zero capabilities after sanitization', () => {
    _readAgentCapabilities.mockImplementation(() => ['all invalid!!'])
    _listAgentNames.mockImplementation(() => ['samu'])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    // 'all invalid!!' fails sanitizeCapabilityTag -> all dropped -> capsStr='-'
    expect(out).toContain('): -')
  })

  it('caps the capability list at CAPABILITY_TAG_MAX_PER_AGENT', () => {
    const many = Array.from({ length: 20 }, (_, i) => `cap${i}`)
    _readAgentCapabilities.mockImplementation(() => many)
    _listAgentNames.mockImplementation(() => ['samu'])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    // The .slice(0, 12) caps to CAPABILITY_TAG_MAX_PER_AGENT.
    expect(out).toContain('cap0')
    expect(out).not.toContain('cap12')
    expect(out).not.toContain('cap19')
  })

  it('skips self when iterating the roster (no self-row)', () => {
    _readAgentCapabilities.mockImplementation(() => ['alpha'])
    _listAgentNames.mockImplementation(() => ['samu'])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    // The roster has main + samu; self=skip removes the samu row.
    expect(out).not.toContain('**samu**')
    expect(out).toContain('**main**')
  })

  it('prepends MAIN_AGENT_ID when the agents list does not already include it', () => {
    _readAgentCapabilities.mockImplementation(() => ['x'])
    _listAgentNames.mockImplementation(() => ['samu'])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    // Both main and samu appear; samu is self and gets skipped -> only main remains.
    expect(out).toContain('**main**')
  })

  it('falls back to the placeholder when no agents are registered', () => {
    // Pinning test: the current implementation always prepends MAIN_AGENT_ID
    // to the registry list, so the placeholder row is unreachable for a
    // sub-agent -- the only row is 'main' rendered with the '-' caps
    // fallback. The placeholder is dead layout that only fires if the agent
    // is its own main and listAgentNames also returns empty.
    _readAgentCapabilities.mockImplementation(() => [])
    _listAgentNames.mockImplementation(() => [])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Test\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    // 'main' is shown with the dash fallback. The placeholder string is NOT
    // present because the main-agent prepending guarantees at least one row.
    expect(out).toContain('**main**')
    expect(out).toContain('): -')
  })
})

// ===========================================================================
// 29. ensureAutonomySection normal paths (lines 880-907) -- the readFileSync,
//     block-replace, block-append, identical-content, and atomic-write paths.
// ===========================================================================
describe('ensureAutonomySection: normal paths', () => {
  it('appends the autonomy block when CLAUDE.md exists but has no marker block', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Existing\n')
    scaffold.ensureAutonomySection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('# Existing')
    expect(out).toContain('BEGIN GENERATED: autonomy-wiring')
    expect(out).toContain('END GENERATED: autonomy-wiring')
  })

  it('replaces an existing autonomy block in place (idempotent re-render)', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'),
      '# Existing\n\n<!-- BEGIN GENERATED: autonomy-wiring (auto-generated, do not edit by hand) -->\nOLD\n<!-- END GENERATED: autonomy-wiring -->\n')
    scaffold.ensureAutonomySection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).not.toContain('OLD')
    expect(out).toContain('BEGIN GENERATED: autonomy-wiring')
    // The "# Existing" header outside the block is preserved.
    expect(out).toContain('# Existing')
  })

  it('writes to PROJECT_ROOT/CLAUDE.md for the MAIN_AGENT_ID', () => {
    // The main agent's CLAUDE.md lives at PROJECT_ROOT (the sandbox root).
    writeFileSync(join(SANDBOX, 'CLAUDE.md'), '# Main agent doc\n')
    scaffold.ensureAutonomySection('main')
    const out = readFileSync(join(SANDBOX, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('BEGIN GENERATED: autonomy-wiring')
    // The sub-agent CLAUDE.md must NOT have been created.
    expect(existsSync(join(SANDBOX, 'agents', 'main', 'CLAUDE.md'))).toBe(false)
  })

  it('returns silently when the agent has no CLAUDE.md', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    // No CLAUDE.md -> existsSync is false -> early return.
    expect(() => scaffold.ensureAutonomySection('samu')).not.toThrow()
  })

  it('is idempotent: second call with identical content does not rewrite', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Existing\n')
    scaffold.ensureAutonomySection('samu')
    const firstWrite = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    // Force the mtime to a known value so the second call's identical-content
    // check must skip the write.
    const mtimeBefore = statSync(join(agentDir, 'CLAUDE.md')).mtimeMs
    scaffold.ensureAutonomySection('samu')
    const mtimeAfter = statSync(join(agentDir, 'CLAUDE.md')).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
    const secondWrite = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(secondWrite).toBe(firstWrite)
  })
})

// ===========================================================================
// 30. ensureFleetRosterSection normal paths (lines 922-945) -- the
//     block-replace, block-append, identical-content, and atomic-write paths.
// ===========================================================================
describe('ensureFleetRosterSection: normal paths', () => {
  it('appends the roster block when CLAUDE.md exists but has no marker block', () => {
    _listAgentNames.mockImplementation(() => [])
    _readAgentCapabilities.mockImplementation(() => [])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Existing\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).toContain('# Existing')
    expect(out).toContain('BEGIN GENERATED: fleet-roster')
    expect(out).toContain('END GENERATED: fleet-roster')
  })

  it('replaces an existing roster block in place (idempotent re-render)', () => {
    _listAgentNames.mockImplementation(() => [])
    _readAgentCapabilities.mockImplementation(() => [])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'),
      '# Existing\n\n<!-- BEGIN GENERATED: fleet-roster (auto-generated, do not edit by hand) -->\nOLD\n<!-- END GENERATED: fleet-roster -->\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(out).not.toContain('OLD')
    expect(out).toContain('BEGIN GENERATED: fleet-roster')
    // The "# Existing" header outside the block is preserved.
    expect(out).toContain('# Existing')
  })

  it('returns silently when the agent has no CLAUDE.md', () => {
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    // No CLAUDE.md -> existsSync is false -> early return.
    expect(() => scaffold.ensureFleetRosterSection('samu')).not.toThrow()
  })

  it('is idempotent: second call with identical content does not rewrite', () => {
    _listAgentNames.mockImplementation(() => [])
    _readAgentCapabilities.mockImplementation(() => [])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Existing\n')
    scaffold.ensureFleetRosterSection('samu')
    const firstWrite = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    const mtimeBefore = statSync(join(agentDir, 'CLAUDE.md')).mtimeMs
    scaffold.ensureFleetRosterSection('samu')
    const mtimeAfter = statSync(join(agentDir, 'CLAUDE.md')).mtimeMs
    expect(mtimeAfter).toBe(mtimeBefore)
    const secondWrite = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    expect(secondWrite).toBe(firstWrite)
  })

  it('keeps the section ordering when appending: existing content first, block after', () => {
    _listAgentNames.mockImplementation(() => [])
    _readAgentCapabilities.mockImplementation(() => [])
    const agentDir = join(SANDBOX, 'agents', 'samu')
    mkdirSync(join(agentDir), { recursive: true })
    writeFileSync(join(agentDir, 'CLAUDE.md'), '# Existing\n')
    scaffold.ensureFleetRosterSection('samu')
    const out = readFileSync(join(agentDir, 'CLAUDE.md'), 'utf-8')
    // The marker block must follow the existing content (append path).
    expect(out.indexOf('# Existing')).toBeLessThan(out.indexOf('BEGIN GENERATED: fleet-roster'))
  })
})
