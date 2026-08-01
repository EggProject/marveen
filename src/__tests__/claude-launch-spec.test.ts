import { describe, it, expect } from 'vitest'
import {
  buildClaudeLaunchSpec,
  validateSpec,
  shellSingleQuote,
  buildClaudeLaunchCmd,
  defaultFollowupPlan,
  type ClaudeLaunchSpec,
} from '../web/claude-launch.js'

const baseRequired = {
  site: 'site-1-background' as const,
  session: 'agent-test',
  claudePath: '/opt/homebrew/bin/claude',
  cwd: '/Users/eggp/marveen',
  host: { kind: 'local' as const },
  tmuxSubcommand: 'newSession' as const,
}

describe('shellSingleQuote', () => {
  it('wraps a simple string in single quotes', () => {
    expect(shellSingleQuote('hello')).toBe(`'hello'`)
  })
  it('escapes an embedded apostrophe via close-quote + escaped + open-quote', () => {
    expect(shellSingleQuote("it's")).toBe(`'it'\\''s'`)
  })
  it('escapes multiple embedded apostrophes', () => {
    expect(shellSingleQuote("'a' 'b'")).toBe(`''\\''a'\\'' '\\''b'\\'''`)
  })
  it('preserves brackets and dollar signs (single quotes are literal)', () => {
    expect(shellSingleQuote('MiniMax-M3[1m]')).toBe(`'MiniMax-M3[1m]'`)
  })
})

describe('buildClaudeLaunchSpec defaults', () => {
  it('fills every default when only required fields are supplied', () => {
    const spec = buildClaudeLaunchSpec(baseRequired)
    expect(spec.model).toBeUndefined()
    expect(spec.continueSession).toBeUndefined()
    expect(spec.pluginId).toBeUndefined()
    expect(spec.extraPluginIds).toEqual([])
    expect(spec.isolatedConfigDir).toBeUndefined()
    expect(spec.fleetOauthToken).toBeUndefined()
    expect(spec.apiKey).toBeUndefined()
    expect(spec.channelEnv).toBeUndefined()
    expect(spec.mcpBatch).toBeUndefined()
    expect(spec.promptSuggestionGuard).toBeUndefined()
    expect(spec.scrubChannelTokens).toBeUndefined()
    expect(spec.detectSandbox).toBeUndefined()
    expect(spec.detectAvxLess).toBeUndefined()
    expect(spec.pathPreset).toBe('macos')
    expect(spec.pathTrailingInherit).toBe(false)
    expect(spec.tmuxServerPrep).toBeUndefined()
    expect(spec.paneGeometry).toBeUndefined()
    expect(spec.followups).toEqual({})
  })

  it('preserves caller-supplied fields verbatim', () => {
    const spec = buildClaudeLaunchSpec({
      ...baseRequired,
      model: 'MiniMax-M3[1m]',
      continueSession: true,
      pluginId: 'telegram@claude-plugins-official',
      extraPluginIds: ['discord@claude-plugins-official'],
      isolatedConfigDir: '/tmp/iso',
      pathPreset: 'linux',
      pathTrailingInherit: true,
    })
    expect(spec.model).toBe('MiniMax-M3[1m]')
    expect(spec.continueSession).toBe(true)
    expect(spec.pluginId).toBe('telegram@claude-plugins-official')
    expect(spec.extraPluginIds).toEqual(['discord@claude-plugins-official'])
    expect(spec.isolatedConfigDir).toBe('/tmp/iso')
    expect(spec.pathPreset).toBe('linux')
    expect(spec.pathTrailingInherit).toBe(true)
  })
})

describe('validateSpec paired-guard', () => {
  it('emits warning when continueSession + pluginId + no postResumePluginGuard', () => {
    const spec = buildClaudeLaunchSpec({
      ...baseRequired,
      continueSession: true,
      pluginId: 'telegram@claude-plugins-official',
      followups: { postResumePluginGuard: false },
    })
    const v = validateSpec(spec)
    expect(v.warnings).toContain('missing-post-resume-plugin-guard')
  })

  it('emits warning when continueSession + channelEnv + no postResumePluginGuard', () => {
    const spec = buildClaudeLaunchSpec({
      ...baseRequired,
      continueSession: true,
      channelEnv: {
        provider: 'telegram',
        stateDirVar: 'TELEGRAM_STATE_DIR',
        stateDir: '/tmp/dir',
      },
      followups: { postResumePluginGuard: false },
    })
    expect(validateSpec(spec).warnings).toContain('missing-post-resume-plugin-guard')
  })

  it('does NOT emit warning when postResumePluginGuard=true', () => {
    const spec = buildClaudeLaunchSpec({
      ...baseRequired,
      continueSession: true,
      pluginId: 'telegram@claude-plugins-official',
      followups: { postResumePluginGuard: true },
    })
    expect(validateSpec(spec).warnings).not.toContain('missing-post-resume-plugin-guard')
  })

  it('does NOT emit warning when continueSession=false', () => {
    const spec = buildClaudeLaunchSpec({
      ...baseRequired,
      continueSession: false,
      pluginId: 'telegram@claude-plugins-official',
    })
    expect(validateSpec(spec).warnings).not.toContain('missing-post-resume-plugin-guard')
  })

  it('does NOT emit warning when there is no channel', () => {
    const spec = buildClaudeLaunchSpec({
      ...baseRequired,
      continueSession: true,
    })
    expect(validateSpec(spec).warnings).not.toContain('missing-post-resume-plugin-guard')
  })

  it('warning surfaces via buildClaudeLaunchCmd.warnings', () => {
    const spec = buildClaudeLaunchSpec({
      ...baseRequired,
      continueSession: true,
      pluginId: 'telegram@claude-plugins-official',
      followups: { postResumePluginGuard: false },
    })
    expect(buildClaudeLaunchCmd(spec).warnings).toContain('missing-post-resume-plugin-guard')
  })
})

describe('defaultFollowupPlan', () => {
  it('returns all-false booleans and the right discriminator strings', () => {
    const plan = defaultFollowupPlan()
    expect(plan.writeRespawnStamp).toBe(false)
    expect(plan.pluginUnlock).toBe(false)
    expect(plan.postResumePluginGuard).toBe(false)
    expect(plan.dismissResumeSummaryModal).toBe(false)
    expect(plan.reapOrphans).toBe('none')
    expect(plan.reSeedOnboarding).toBe(false)
    expect(plan.startChannelsStartupGuard).toBe(false)
    expect(plan.keepaliveTouch).toBe(false)
    expect(plan.telegramBotMenu).toBe(false)
    expect(plan.channelsFailureLog).toBe(false)
    expect(plan.logClaudeVersion).toBe(false)
    expect(plan.continueSession).toBe(false)
    expect(plan.hasChannel).toBe(false)
  })
})

describe('buildClaudeLaunchSpec preserves complex fields', () => {
  it('preserves nested types: tmuxServerPrep, channelEnv, apiKey, fleetOauthToken', () => {
    const spec: ClaudeLaunchSpec = buildClaudeLaunchSpec({
      ...baseRequired,
      fleetOauthToken: { path: '/Users/eggp/marveen/store/.claude-oauth-token', read: 'cat' },
      channelEnv: {
        provider: 'slack',
        stateDirVar: 'SLACK_STATE_DIR',
        stateDir: '/Users/eggp/marveen/.claude/channels/slack',
        auditLogPath: '/Users/eggp/marveen/.claude/channels/slack/audit.jsonl',
      },
      apiKey: { env: 'ANTHROPIC_API_KEY', value: 'sk-test' },
      tmuxServerPrep: {
        startServer: true,
        unsetGlobalEnv: ['TELEGRAM_BOT_TOKEN'],
        setGlobalEnv: { CLAUDE_CODE_OAUTH_TOKEN: 'xxx' },
      },
      paneGeometry: { cols: 200, rows: 50 },
      mcpBatch: 'always',
      promptSuggestionGuard: true,
      scrubChannelTokens: true,
      detectSandbox: true,
      detectAvxLess: true,
      followups: {
        writeRespawnStamp: true,
        pluginUnlock: true,
        postResumePluginGuard: false,
        dismissResumeSummaryModal: true,
        reapOrphans: 'channel-both',
        reSeedOnboarding: true,
        startChannelsStartupGuard: true,
        keepaliveTouch: true,
        telegramBotMenu: true,
        channelsFailureLog: true,
        logClaudeVersion: true,
        identitySetup: { displayName: 'EggProjectTeams' },
        extraFlags: '-p "$BG_PROMPT"',
        appendCmdSuffix: '; echo done',
        pluginLivenessLoop: { intervalMs: 5000, maxIterations: 12 },
        rapidExitBackoff: { initialMs: 1000, maxMs: 30000 },
        replayUnfinishedMessages: { enabled: true, cutoffSeconds: 7200 },
        alertOnSuccess: { message: 'ok' },
        respawnCounters: { stampFile: '/tmp/stamp', countFile: '/tmp/count' },
        onFailureLog: 'failure log',
      },
    })
    expect(spec.fleetOauthToken?.path).toBe('/Users/eggp/marveen/store/.claude-oauth-token')
    expect(spec.channelEnv?.auditLogPath).toBe('/Users/eggp/marveen/.claude/channels/slack/audit.jsonl')
    expect(spec.apiKey?.env).toBe('ANTHROPIC_API_KEY')
    expect(spec.tmuxServerPrep?.startServer).toBe(true)
    expect(spec.paneGeometry).toEqual({ cols: 200, rows: 50 })
    expect(spec.mcpBatch).toBe('always')
    expect(spec.followups?.identitySetup?.displayName).toBe('EggProjectTeams')
    expect(spec.followups?.extraFlags).toBe('-p "$BG_PROMPT"')
    expect(spec.followups?.appendCmdSuffix).toBe('; echo done')
  })
})