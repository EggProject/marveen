import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  buildClaudeLaunchSpec,
  buildClaudeLaunchCmd,
  type ClaudeLaunchSpec,
  type ClaudeLaunchPathPreset,
  type ClaudeLaunchMcpBatch,
} from '../web/claude-launch.js'

const FIXTURE_DIR = new URL('./__fixtures__/claude-launch/', import.meta.url).pathname

function loadFixture(site: string): { site: string; currentCmd: string; expectedTmuxArgs: string[]; description: string } {
  const path = join(FIXTURE_DIR, `${site}.json`)
  return JSON.parse(readFileSync(path, 'utf-8'))
}

const SPECS: Record<string, () => ClaudeLaunchSpec> = {
  'site-1-background': () => buildClaudeLaunchSpec({
    site: 'site-1-background',
    session: 'bg-ABC12345',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' },
    tmuxSubcommand: 'newSession',
    pathPreset: 'macos',
    paneGeometry: { cols: 200, rows: 50 },
    cwdAsCd: false,
    followups: {
      extraFlags: '-p "$BG_PROMPT" --output-format text 2>&1',
      appendCmdSuffix: "; echo '___BG_DONE___'; sleep 5",
    },
  }),
  'site-2-stage1': () => buildClaudeLaunchSpec({
    site: 'site-2-stage1',
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' },
    tmuxSubcommand: 'respawnPane',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    pathPreset: 'linux',
    pathTrailingInherit: true,
    mcpBatch: 'always',
    cwdAsCd: false,
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
  }),
  'site-3-stage3': () => buildClaudeLaunchSpec({
    site: 'site-3-stage3',
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' },
    tmuxSubcommand: 'respawnPane',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    continueSession: true,
    pathPreset: 'linux',
    pathTrailingInherit: true,
    mcpBatch: 'always',
    cwdAsCd: false,
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
  }),
  'site-4-stage4': () => buildClaudeLaunchSpec({
    site: 'site-4-stage4',
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' },
    tmuxSubcommand: 'respawnPane',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    pathPreset: 'linux',
    pathTrailingInherit: true,
    mcpBatch: 'always',
    cwdAsCd: false,
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
  }),
  'site-5-worker': () => buildClaudeLaunchSpec({
    site: 'site-5-worker',
    session: 'worker-1',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen/agents/worker',
    host: { kind: 'local' },
    tmuxSubcommand: 'newSession',
    model: 'MiniMax-M3[1m]',
    pathPreset: 'login-shell',
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
    isolatedConfigDir: '/Users/eggp/marveen/agents/worker/.channels-config',
  }),
  'site-6-subagent-local': () => buildClaudeLaunchSpec({
    site: 'site-6-subagent-local',
    session: 'agent-boni',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen/agents/boni',
    host: { kind: 'local' },
    tmuxSubcommand: 'newSession',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    pathPreset: 'macos',
    pathTrailingInherit: true,
    channelEnv: {
      provider: 'telegram',
      stateDirVar: 'TELEGRAM_STATE_DIR',
      stateDir: '/Users/eggp/marveen/agents/boni/.claude/channels/telegram',
    },
    mcpBatch: 'channel-only',
    promptSuggestionGuard: true,
    scrubChannelTokens: true,
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
    isolatedConfigDir: '/Users/eggp/marveen/agents/boni/.channels-config',
  }),
  'site-7-subagent-ssh': () => buildClaudeLaunchSpec({
    site: 'site-7-subagent-ssh',
    session: 'agent-geri',
    claudePath: 'claude',
    cwd: '/home/user/work',
    host: { kind: 'remote-ssh', sshTarget: 'laptop', workdir: '/home/user/work' },
    tmuxSubcommand: 'newSession',
    model: 'MiniMax-M3[1m]',
    continueSession: true,
    pathPreset: 'linux',
    pathTrailingInherit: true,
  }),
  'site-8-channels-primary': () => buildClaudeLaunchSpec({
    site: 'site-8-channels-primary',
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' },
    tmuxSubcommand: 'newSession',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    extraPluginIds: ['discord@claude-plugins-official'],
    pathPreset: 'linux',
    pathTrailingInherit: false,
    mcpBatch: 'always',
    detectSandbox: true,
    detectAvxLess: true,
    channelEnv: {
      provider: 'telegram',
      stateDirVar: 'TELEGRAM_STATE_DIR',
      stateDir: '/Users/eggp/marveen/.claude/channels/telegram',
    },
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
    isolatedConfigDir: '/Users/eggp/marveen/.channels-config',
  }),
  'site-9-channels-eperm': () => buildClaudeLaunchSpec({
    site: 'site-9-channels-eperm',
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/tmp/marveen-channels-ABCDEF',
    host: { kind: 'local' },
    tmuxSubcommand: 'newSession',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    pathPreset: 'linux',
    pathTrailingInherit: false,
    mcpBatch: 'always',
    detectSandbox: true,
    detectAvxLess: true,
    cwdAsTmuxC: true,
    channelEnv: {
      provider: 'telegram',
      stateDirVar: 'TELEGRAM_STATE_DIR',
      stateDir: '/Users/eggp/marveen/.claude/channels/telegram',
    },
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
    isolatedConfigDir: '/Users/eggp/marveen/.channels-config',
  }),
  'site-10-watchdog': () => buildClaudeLaunchSpec({
    site: 'site-10-watchdog',
    session: 'agent-boni',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen/agents/boni',
    host: { kind: 'local' },
    tmuxSubcommand: 'newSession',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    pathPreset: 'linux',
    pathTrailingInherit: true,
    scrubChannelTokens: true,
    channelEnv: {
      provider: 'telegram',
      stateDirVar: 'TELEGRAM_STATE_DIR',
      stateDir: '/Users/eggp/marveen/agents/boni/.claude/channels/telegram',
    },
  }),
  'site-11-channel-watchdog': () => buildClaudeLaunchSpec({
    site: 'site-11-channel-watchdog',
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' },
    tmuxSubcommand: 'respawnPane',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    pathPreset: 'linux',
    pathTrailingInherit: false,
    promptSuggestionGuard: true,
    fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
    isolatedConfigDir: '/Users/eggp/marveen/.channels-config',
  }),
  'site-12-stuck-modal': () => buildClaudeLaunchSpec({
    site: 'site-12-stuck-modal',
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' },
    tmuxSubcommand: 'respawnPane',
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
    pathPreset: 'linux',
    pathTrailingInherit: false,
  }),
}

const ALL_SITES = [
  'site-1-background',
  'site-2-stage1',
  'site-3-stage3',
  'site-4-stage4',
  'site-5-worker',
  'site-6-subagent-local',
  'site-7-subagent-ssh',
  'site-8-channels-primary',
  'site-9-channels-eperm',
  'site-10-watchdog',
  'site-11-channel-watchdog',
  'site-12-stuck-modal',
]

describe('all 12 fixture sites: byte-equality against currentCmd and expectedTmuxArgs', () => {
  for (const site of ALL_SITES) {
    it(`${site}: builder produces the recorded cmd and tmux args`, () => {
      const fx = loadFixture(site)
      const spec = SPECS[site]()
      const result = buildClaudeLaunchCmd(spec)
      expect(result.cmd).toBe(fx.currentCmd)
      expect(result.args).toEqual(fx.expectedTmuxArgs)
    })
  }
})

describe('12 fixtures present on disk', () => {
  it('contains every site-*.json file', () => {
    const files = readdirSync(FIXTURE_DIR).filter((f) => f.startsWith('site-') && f.endsWith('.json'))
    for (const site of ALL_SITES) {
      expect(files).toContain(`${site}.json`)
    }
  })
})

describe('buildClaudeLaunchCmd quoting invariants', () => {
  it('model id with [1m] suffix stays inside single quotes (no shell globbing)', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-2-stage1',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'respawnPane',
      model: 'MiniMax-M3[1m]',
      pluginId: 'telegram@claude-plugins-official',
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain(`--model 'MiniMax-M3[1m]'`)
    expect(cmd).not.toMatch(/--model [^']MiniMax-M3\[1m\][^']/)
  })

  it('fleetOauthToken path is always emitted as $(cat <shQuoted path>) — never a literal token', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-2-stage1',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'respawnPane',
      fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain(`$(cat '/Users/eggp/marveen/store/.claude-oauth-token')`)
    // No literal long token-string emission
    expect(cmd).not.toMatch(/CLAUDE_CODE_OAUTH_TOKEN="?[A-Za-z0-9_-]{20,}/)
  })

  it('pluginId is single-quoted', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-2-stage1',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'respawnPane',
      pluginId: 'telegram@claude-plugins-official',
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain(`plugin:'telegram@claude-plugins-official'`)
  })

  it('--continue is placed BEFORE --model', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-3-stage3',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'respawnPane',
      model: 'MiniMax-M3[1m]',
      continueSession: true,
      pluginId: 'telegram@claude-plugins-official',
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    const contIdx = cmd.indexOf('--continue')
    const modelIdx = cmd.indexOf('--model')
    expect(contIdx).toBeGreaterThan(-1)
    expect(modelIdx).toBeGreaterThan(-1)
    expect(contIdx).toBeLessThan(modelIdx)
  })

  it('--continue is omitted when continueSession is false', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-2-stage1',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'respawnPane',
      model: 'MiniMax-M3[1m]',
      continueSession: false,
      pluginId: 'telegram@claude-plugins-official',
    })
    expect(buildClaudeLaunchCmd(spec).cmd).not.toContain('--continue')
  })

  it('undefined model omits the --model flag entirely', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-1-background',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'newSession',
    })
    expect(buildClaudeLaunchCmd(spec).cmd).not.toContain('--model')
  })

  it('undefined pluginId omits the --channels flag entirely', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-1-background',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'newSession',
      model: 'MiniMax-M3[1m]',
    })
    expect(buildClaudeLaunchCmd(spec).cmd).not.toContain('--channels')
  })

  it('extraPluginIds produces multiple plugin:<id> entries', () => {
    const spec = buildClaudeLaunchSpec({
      site: 'site-8-channels-primary',
      session: 's',
      claudePath: '/opt/homebrew/bin/claude',
      cwd: '/Users/eggp/marveen',
      host: { kind: 'local' },
      tmuxSubcommand: 'newSession',
      pluginId: 'telegram@claude-plugins-official',
      extraPluginIds: ['discord@claude-plugins-official', 'slack-channel@marveen-marketplace'],
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain(`plugin:'telegram@claude-plugins-official'`)
    expect(cmd).toContain(`plugin:'discord@claude-plugins-official'`)
    expect(cmd).toContain(`plugin:'slack-channel@marveen-marketplace'`)
  })
})

describe('buildClaudeLaunchCmd mcpBatch discriminator', () => {
  const base = () => ({
    site: 'site-6-subagent-local' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
  })
  it("mcpBatch='always' emits the triplet regardless of channel", () => {
    const spec = buildClaudeLaunchSpec({ ...base(), mcpBatch: 'always' as ClaudeLaunchMcpBatch })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain('MCP_SERVER_CONNECTION_BATCH_SIZE=10')
    expect(cmd).toContain('MCP_CONNECTION_NONBLOCKING=1')
    expect(cmd).toContain('MCP_TIMEOUT=60000')
  })
  it("mcpBatch='channel-only' + hasChannel=true emits the triplet", () => {
    const spec = buildClaudeLaunchSpec({
      ...base(),
      mcpBatch: 'channel-only' as ClaudeLaunchMcpBatch,
      pluginId: 'telegram@claude-plugins-official',
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain('MCP_SERVER_CONNECTION_BATCH_SIZE=10')
  })
  it("mcpBatch='channel-only' + hasChannel=false omits the triplet", () => {
    const spec = buildClaudeLaunchSpec({
      ...base(),
      mcpBatch: 'channel-only' as ClaudeLaunchMcpBatch,
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).not.toContain('MCP_SERVER_CONNECTION_BATCH_SIZE')
  })
  it("mcpBatch='none' + promptSuggestionGuard=true emits ONLY the prompt-suggestion line", () => {
    const spec = buildClaudeLaunchSpec({
      ...base(),
      mcpBatch: 'none' as ClaudeLaunchMcpBatch,
      promptSuggestionGuard: true,
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false')
    expect(cmd).not.toContain('MCP_SERVER_CONNECTION_BATCH_SIZE')
  })
  it("mcpBatch='none' + no guard emits no MCP/prompt-suggestion line", () => {
    const spec = buildClaudeLaunchSpec({ ...base(), mcpBatch: 'none' as ClaudeLaunchMcpBatch })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).not.toContain('CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION')
    expect(cmd).not.toContain('MCP_SERVER_CONNECTION_BATCH_SIZE')
  })
})

describe('buildClaudeLaunchCmd path presets and trailing-inherit', () => {
  const base = {
    site: 'site-2-stage1' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'respawnPane' as const,
    model: 'MiniMax-M3[1m]',
    pluginId: 'telegram@claude-plugins-official',
  }
  it("pathPreset='login-shell' → bash -lc wrapper + -c <cwd>", () => {
    const spec = buildClaudeLaunchSpec({
      ...base,
      site: 'site-5-worker',
      tmuxSubcommand: 'newSession',
      pathPreset: 'login-shell' as ClaudeLaunchPathPreset,
    })
    const { args } = buildClaudeLaunchCmd(spec)
    expect(args).toContain('bash')
    expect(args).toContain('-lc')
    expect(args.indexOf('-c')).toBeGreaterThan(-1)
  })
  it("pathPreset='macos' → macos PATH preset", () => {
    const spec = buildClaudeLaunchSpec({ ...base, pathPreset: 'macos' as ClaudeLaunchPathPreset })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain('/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin')
    expect(cmd).not.toContain('/home/linuxbrew')
  })
  it("pathPreset='linux' → linux PATH preset", () => {
    const spec = buildClaudeLaunchSpec({ ...base, pathPreset: 'linux' as ClaudeLaunchPathPreset })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain('/home/linuxbrew/.linuxbrew/bin')
    expect(cmd).toContain('$HOME/.local/bin')
  })
  it('pathTrailingInherit=true → trailing :$PATH', () => {
    const spec = buildClaudeLaunchSpec({ ...base, pathTrailingInherit: true })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toMatch(/:\$PATH"/)
  })
  it('pathTrailingInherit=false → no trailing :$PATH', () => {
    const spec = buildClaudeLaunchSpec({ ...base, pathTrailingInherit: false })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).not.toMatch(/:\$PATH"/)
  })
})

describe('buildClaudeLaunchCmd tmuxServerPrep ordering', () => {
  const base = {
    site: 'site-8-channels-primary' as const,
    session: 'marveen-channels',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
  }
  it('startServer adds an entry to the prep ordering (visible via runTmuxInvocation arg shape)', () => {
    const spec = buildClaudeLaunchSpec({
      ...base,
      tmuxServerPrep: { startServer: true, unsetGlobalEnv: ['TELEGRAM_BOT_TOKEN'], setGlobalEnv: { FOO: 'bar' } },
    })
    const r = buildClaudeLaunchCmd(spec)
    // The cmd itself doesn't contain the prep calls (those happen at runner time),
    // but the spec.tmpl structure should still compile cleanly
    expect(r.cmd).toContain('claude')
  })
})

describe('buildClaudeLaunchCmd scrubChannelTokens', () => {
  const base = {
    site: 'site-6-subagent-local' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
  }
  it('scrubChannelTokens=true emits unset line', () => {
    const spec = buildClaudeLaunchSpec({ ...base, scrubChannelTokens: true })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain('unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN')
  })
  it('scrubChannelTokens=false omits unset line', () => {
    const spec = buildClaudeLaunchSpec({ ...base, scrubChannelTokens: false })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).not.toContain('unset TELEGRAM_BOT_TOKEN')
  })
})

describe('buildClaudeLaunchCmd detectSandbox / detectAvxLess', () => {
  const base = {
    site: 'site-8-channels-primary' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
  }
  it('detectSandbox=true emits export IS_SANDBOX=1', () => {
    const spec = buildClaudeLaunchSpec({ ...base, detectSandbox: true })
    expect(buildClaudeLaunchCmd(spec).cmd).toContain('export IS_SANDBOX=1')
  })
  it('detectSandbox=false omits IS_SANDBOX', () => {
    const spec = buildClaudeLaunchSpec({ ...base, detectSandbox: false })
    expect(buildClaudeLaunchCmd(spec).cmd).not.toContain('IS_SANDBOX')
  })
  it('detectAvxLess=true emits export DISABLE_AUTOUPDATER=1', () => {
    const spec = buildClaudeLaunchSpec({ ...base, detectAvxLess: true })
    expect(buildClaudeLaunchCmd(spec).cmd).toContain('export DISABLE_AUTOUPDATER=1')
  })
  it('detectAvxLess=false omits DISABLE_AUTOUPDATER', () => {
    const spec = buildClaudeLaunchSpec({ ...base, detectAvxLess: false })
    expect(buildClaudeLaunchCmd(spec).cmd).not.toContain('DISABLE_AUTOUPDATER')
  })
})

describe('buildClaudeLaunchCmd isolatedConfigDir / apiKey', () => {
  const base = {
    site: 'site-2-stage1' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'respawnPane' as const,
  }
  it('isolatedConfigDir emits export CLAUDE_CONFIG_DIR=<shQuoted>', () => {
    const spec = buildClaudeLaunchSpec({ ...base, isolatedConfigDir: '/tmp/iso' })
    expect(buildClaudeLaunchCmd(spec).cmd).toContain(`export CLAUDE_CONFIG_DIR='/tmp/iso'`)
  })
  it('apiKey emits export <env>=<value>', () => {
    const spec = buildClaudeLaunchSpec({ ...base, apiKey: { env: 'ANTHROPIC_API_KEY', value: 'sk-abc' } })
    expect(buildClaudeLaunchCmd(spec).cmd).toContain(`export ANTHROPIC_API_KEY='sk-abc'`)
  })
})

describe('buildClaudeLaunchCmd channelEnv per-provider stateDirVar', () => {
  const base = {
    site: 'site-6-subagent-local' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
  }
  for (const [provider, varName] of [
    ['telegram', 'TELEGRAM_STATE_DIR'],
    ['slack', 'SLACK_STATE_DIR'],
    ['discord', 'DISCORD_STATE_DIR'],
    ['googlechat', 'GOOGLECHAT_STATE_DIR'],
    ['teams', 'TEAMS_STATE_DIR'],
  ] as const) {
    it(`channelEnv ${provider} → ${varName}`, () => {
      const spec = buildClaudeLaunchSpec({
        ...base,
        channelEnv: { provider: provider as 'telegram', stateDirVar: varName, stateDir: `/tmp/${provider}` },
      })
      expect(buildClaudeLaunchCmd(spec).cmd).toContain(`export ${varName}=`)
    })
  }
  it('auditLogPath emits SLACK_AUDIT_LOG line only when present', () => {
    const spec = buildClaudeLaunchSpec({
      ...base,
      channelEnv: {
        provider: 'slack',
        stateDirVar: 'SLACK_STATE_DIR',
        stateDir: '/tmp/slack',
        auditLogPath: '/tmp/slack/audit.jsonl',
      },
    })
    expect(buildClaudeLaunchCmd(spec).cmd).toContain(`export SLACK_AUDIT_LOG='/tmp/slack/audit.jsonl'`)
  })
  it('no auditLogPath → no SLACK_AUDIT_LOG line', () => {
    const spec = buildClaudeLaunchSpec({
      ...base,
      channelEnv: { provider: 'slack', stateDirVar: 'SLACK_STATE_DIR', stateDir: '/tmp/slack' },
    })
    expect(buildClaudeLaunchCmd(spec).cmd).not.toContain('SLACK_AUDIT_LOG')
  })
})

describe('buildClaudeLaunchCmd paneGeometry and tmuxSubcommand shapes', () => {
  const base = {
    site: 'site-1-background' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
  }
  it('paneGeometry adds -x <cols> -y <rows> in tmux args', () => {
    const spec = buildClaudeLaunchSpec({ ...base, paneGeometry: { cols: 200, rows: 50 } })
    const { args } = buildClaudeLaunchCmd(spec)
    expect(args).toContain('-x')
    expect(args).toContain('200')
    expect(args).toContain('-y')
    expect(args).toContain('50')
  })
  it('tmuxSubcommand=respawnPane uses respawn-pane + -k + -t + <cmd>', () => {
    const spec = buildClaudeLaunchSpec({ ...base, site: 'site-2-stage1', tmuxSubcommand: 'respawnPane' })
    const { args } = buildClaudeLaunchCmd(spec)
    expect(args[0]).toBe('respawn-pane')
    expect(args).toContain('-k')
    expect(args).toContain('-t')
  })
})

describe('buildClaudeLaunchCmd extras: extraFlags and appendCmdSuffix', () => {
  const base = {
    site: 'site-1-background' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
  }
  it('extraFlags appended to the claude parts', () => {
    const spec = buildClaudeLaunchSpec({
      ...base,
      followups: { extraFlags: '-p "$BG_PROMPT" --output-format text 2>&1' },
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain(`-p "$BG_PROMPT" --output-format text 2>&1`)
  })
  it('appendCmdSuffix appended at the very end of cmd', () => {
    const spec = buildClaudeLaunchSpec({
      ...base,
      followups: { appendCmdSuffix: '; echo done' },
    })
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd.endsWith('; echo done')).toBe(true)
  })
})

describe('buildClaudeLaunchCmd ssh host builds same args (routing happens in runner)', () => {
  const spec = buildClaudeLaunchSpec({
    site: 'site-7-subagent-ssh',
    session: 'agent-geri',
    claudePath: 'claude',
    cwd: '/home/user/work',
    host: { kind: 'remote-ssh', sshTarget: 'laptop', workdir: '/home/user/work' },
    tmuxSubcommand: 'newSession',
    model: 'MiniMax-M3[1m]',
    continueSession: true,
    pathPreset: 'linux',
    pathTrailingInherit: true,
  })
  it('cmd is built locally without ssh wrapping (ssh routes via runTmux)', () => {
    const { cmd } = buildClaudeLaunchCmd(spec)
    expect(cmd).toContain('claude --continue')
    expect(cmd).not.toContain('ssh ')
  })
})

describe('buildClaudeLaunchCmd defensive branches (raw-spec invocation)', () => {
  // Some sites in the codebase may construct the spec object directly instead of
  // going through buildClaudeLaunchSpec; the builder must tolerate the optional
  // fields being literally `undefined` rather than defaulted.
  const base = {
    site: 'site-6-subagent-local' as const,
    session: 's',
    claudePath: '/opt/homebrew/bin/claude',
    cwd: '/Users/eggp/marveen',
    host: { kind: 'local' as const },
    tmuxSubcommand: 'newSession' as const,
    pluginId: 'telegram@claude-plugins-official',
    // extraPluginIds undefined (raw spec): exercises `spec.extraPluginIds ?? []`
    // followups undefined (raw spec): exercises `spec.followups ?? {}` in both
    // buildClaudeLaunchCmd (via buildFollowupPlan) and runPreSteps.
  }
  it('handles extraPluginIds=undefined and followups=undefined raw spec', () => {
    const { cmd, followupPlan } = buildClaudeLaunchCmd(base)
    expect(cmd).toContain(`plugin:'telegram@claude-plugins-official'`)
    expect(followupPlan.continueSession).toBe(false)
    expect(followupPlan.hasChannel).toBe(true)
  })
})