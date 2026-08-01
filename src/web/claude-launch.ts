// Claude-via-tmux launch indítás konszolidáció: egyetlen TS modul ami a 12
// tmux-launch site (TS + shell) cmd-stringjeit egy helyen tartja.
//
// Minden meghívás `ClaudeLaunchSpec` → `ClaudeLaunchResult { args, cmd,
// followupPlan, warnings }` formátumban dolgozik. A `runTmuxInvocation` /
// `launchClaudeNewSession` / `respawnClaudePane` helper-ek a `runTmux` hívás
// előtt futtatják a pre-step-eket (reap, re-seed onboarding, tmux server
// prep, kill-session) és a siker után a `applyPostLaunchFollowups` poszt-
// lépéseket (respawn stamp, identity setup, plugin unlock, post-resume
// guard, modal dismiss, version log).
//
// Biztonsági invariánsok (NINCS kivétel):
//   * OAuth token mindig `$(cat <path>)` formában, SOHA literal értékként
//   * Model id (pl. `MiniMax-M3[1m]`) mindig single-quote-ban (POSIX)
//   * Plugin id single-quote-ban
//   * Workdir single-quote-ban (TILOS double-quote - $ jelen lehet)
//   * tmux set-environment -g CSAK a start-server UTÁN fut

import type { ChannelProviderType } from '../channel-provider.js'
import { reapChannelOrphans, reapDetachedChannelClaudes } from './channel-poller-reap.js'
import {
  ensureSharedClaudeOnboarded,
  runTmux,
  scheduleIdentitySetup,
  dismissResumeSummaryModalIfPresent,
} from './agent-process.js'
import { schedulePluginUnlockAfterRespawn } from './channel-plugin-unlock.js'
import { schedulePostResumePluginGuard, writeRespawnStamp } from './channel-monitor.js'
import { logWorkerClaudeVersion } from './agent-worker.js'
import { resolveFromPath } from '../platform.js'
import { logger } from '../logger.js'
import { shQuote } from './ssh-tmux.js'

// POSIX single quoting is centralized in ssh-tmux.ts. Keep the launch-specific
// name as an alias so existing callers and tests retain their public contract.
export const shellSingleQuote = shQuote

export interface ClaudeLaunchHostLocal {
  readonly kind: 'local'
}
export interface ClaudeLaunchHostSsh {
  readonly kind: 'remote-ssh'
  readonly sshTarget: string
  readonly workdir: string
}
export type ClaudeLaunchHost = ClaudeLaunchHostLocal | ClaudeLaunchHostSsh

export type ClaudeLaunchSubcommand = 'newSession' | 'respawnPane'

export type ClaudeLaunchPathPreset = 'macos' | 'linux' | 'login-shell'

export type ClaudeLaunchMcpBatch = 'none' | 'always' | 'channel-only'

export type ClaudeLaunchChannelStateDirVar =
  | 'TELEGRAM_STATE_DIR'
  | 'SLACK_STATE_DIR'
  | 'DISCORD_STATE_DIR'
  | 'GOOGLECHAT_STATE_DIR'
  | 'TEAMS_STATE_DIR'
  | 'WHATSAPP_STATE_DIR'

export interface ClaudeLaunchChannelEnv {
  readonly provider: ChannelProviderType
  readonly stateDirVar: ClaudeLaunchChannelStateDirVar
  readonly stateDir: string
  readonly auditLogPath?: string
}

export interface ClaudeLaunchFleetOauthToken {
  readonly path: string
  readonly read: 'cat'
}

// Auth credential for the launched Claude. Discriminated union covers both the
// first-party ANTHROPIC_API_KEY path AND the BYO-endpoint triplet
// (ANTHROPIC_AUTH_TOKEN + ANTHROPIC_BASE_URL + ANTHROPIC_MODEL) used by Ollama,
// DeepSeek, OpenRouter. The first-party path is the historical ANTHROPIC_API_KEY;
// the BYO path lets operators run against any Anthropic-compatible endpoint.
export type ClaudeLaunchApiKey =
  | { readonly env: 'ANTHROPIC_API_KEY'; readonly value: string }
  | {
      readonly env: 'BYO_ENDPOINT'
      readonly authTokenEnv: 'ANTHROPIC_AUTH_TOKEN'
      readonly authToken: string
      readonly baseUrl: string
      readonly model: string
    }

export interface ClaudeLaunchIdentitySetup {
  readonly displayName: string
  readonly host?: string | null
  readonly postRespawnDelayMs?: number
}

export interface ClaudeLaunchPluginLivenessLoop {
  readonly intervalMs: number
  readonly maxIterations: number
}

export interface ClaudeLaunchRapidExitBackoff {
  readonly initialMs: number
  readonly maxMs: number
}

export interface ClaudeLaunchReplayUnfinishedMessages {
  readonly enabled: boolean
  readonly cutoffSeconds: number
}

export interface ClaudeLaunchAlertOnSuccess {
  readonly message: string
}

export interface ClaudeLaunchRespawnCounters {
  readonly stampFile: string
  readonly countFile: string
}

export interface ClaudeLaunchPaneGeometry {
  readonly cols: number
  readonly rows: number
}

export interface ClaudeLaunchTmuxServerPrep {
  readonly startServer?: boolean
  readonly unsetGlobalEnv?: readonly string[]
  readonly setGlobalEnv?: Record<string, string>
}

export interface ClaudeLaunchFollowups {
  readonly writeRespawnStamp?: boolean
  readonly identitySetup?: ClaudeLaunchIdentitySetup
  readonly pluginUnlock?: boolean
  readonly postResumePluginGuard?: boolean
  readonly dismissResumeSummaryModal?: boolean
  readonly reapOrphans?: 'none' | 'channel-both'
  readonly reSeedOnboarding?: boolean
  readonly startChannelsStartupGuard?: boolean
  readonly keepaliveTouch?: boolean
  readonly telegramBotMenu?: boolean
  readonly pluginLivenessLoop?: ClaudeLaunchPluginLivenessLoop
  readonly rapidExitBackoff?: ClaudeLaunchRapidExitBackoff
  readonly replayUnfinishedMessages?: ClaudeLaunchReplayUnfinishedMessages
  readonly alertOnSuccess?: ClaudeLaunchAlertOnSuccess
  readonly respawnCounters?: ClaudeLaunchRespawnCounters
  readonly channelsFailureLog?: boolean
  readonly logClaudeVersion?: boolean
  readonly onFailureLog?: string
  readonly extraFlags?: string
  readonly appendCmdSuffix?: string
}

export interface ClaudeLaunchFollowupPlan {
  writeRespawnStamp: boolean
  identitySetup?: ClaudeLaunchIdentitySetup
  pluginUnlock: boolean
  postResumePluginGuard: boolean
  dismissResumeSummaryModal: boolean
  reapOrphans: 'none' | 'channel-both'
  reSeedOnboarding: boolean
  startChannelsStartupGuard: boolean
  keepaliveTouch: boolean
  telegramBotMenu: boolean
  pluginLivenessLoop?: ClaudeLaunchPluginLivenessLoop
  rapidExitBackoff?: ClaudeLaunchRapidExitBackoff
  replayUnfinishedMessages?: ClaudeLaunchReplayUnfinishedMessages
  alertOnSuccess?: ClaudeLaunchAlertOnSuccess
  respawnCounters?: ClaudeLaunchRespawnCounters
  channelsFailureLog: boolean
  logClaudeVersion: boolean
  onFailureLog?: string
  extraFlags?: string
  appendCmdSuffix?: string
  continueSession: boolean
  hasChannel: boolean
}

export interface ClaudeLaunchSpec {
  readonly site: 'site-1-background' | 'site-2-stage1' | 'site-3-stage3' | 'site-4-stage4' | 'site-5-worker' | 'site-6-subagent-local' | 'site-7-subagent-ssh' | 'site-8-channels-primary' | 'site-9-channels-eperm' | 'site-10-watchdog' | 'site-11-channel-watchdog' | 'site-12-stuck-modal'
  readonly session: string
  readonly claudePath: string
  readonly cwd: string
  readonly host: ClaudeLaunchHost
  readonly tmuxSubcommand: ClaudeLaunchSubcommand
  readonly model?: string
  readonly dangerouslySkipPermissions?: boolean
  readonly continueSession?: boolean
  readonly pluginId?: string
  readonly extraPluginIds?: readonly string[]
  readonly isolatedConfigDir?: string
  readonly fleetOauthToken?: ClaudeLaunchFleetOauthToken
  readonly apiKey?: ClaudeLaunchApiKey
  readonly channelEnv?: ClaudeLaunchChannelEnv
  readonly mcpBatch?: ClaudeLaunchMcpBatch
  readonly promptSuggestionGuard?: boolean
  readonly scrubChannelTokens?: boolean
  readonly detectSandbox?: boolean
  readonly detectAvxLess?: boolean
  readonly pathPreset?: ClaudeLaunchPathPreset
  readonly pathTrailingInherit?: boolean
  readonly tmuxServerPrep?: ClaudeLaunchTmuxServerPrep
  readonly paneGeometry?: ClaudeLaunchPaneGeometry
  /**
   * Emit `cd <cwd>` as a line in the cmd (default true). Set false when the
   * legacy launch site inherits the cwd from its parent shell/tmux pane (the
   * background-tasks one-shotter, main-session respawn-pane family, etc.).
   * Ignored when pathPreset='login-shell' (bash -lc handles the cd implicitly).
   */
  readonly cwdAsCd?: boolean
  /**
   * Emit `-c <cwd>` as tmux args on a new-session (default false). Used by the
   * channels.sh EPERM fallback: tmux's pane-state detector keys off the tmux
   * SERVER's recorded cwd, not the launched claude process's cwd, so a /tmp
   * fallback dir must also be the tmux-level cwd for proper attribution.
   */
  readonly cwdAsTmuxC?: boolean
  readonly followups?: Partial<ClaudeLaunchFollowups>
}

export interface ClaudeLaunchResult {
  readonly args: string[]
  readonly cmd: string
  readonly followupPlan: ClaudeLaunchFollowupPlan
  readonly warnings: readonly string[]
}

const PATH_PRESETS: Record<ClaudeLaunchPathPreset, string> = {
  macos: '/opt/homebrew/bin:$HOME/.bun/bin:/usr/local/bin:/usr/bin:/bin',
  linux: '/opt/homebrew/bin:$HOME/.bun/bin:/home/linuxbrew/.linuxbrew/bin:$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin',
  'login-shell': '$PATH',
}

export function defaultFollowupPlan(): ClaudeLaunchFollowupPlan {
  return {
    writeRespawnStamp: false,
    pluginUnlock: false,
    postResumePluginGuard: false,
    dismissResumeSummaryModal: false,
    reapOrphans: 'none',
    reSeedOnboarding: false,
    startChannelsStartupGuard: false,
    keepaliveTouch: false,
    telegramBotMenu: false,
    channelsFailureLog: false,
    logClaudeVersion: false,
    continueSession: false,
    hasChannel: false,
  }
}

export function buildClaudeLaunchSpec(input: Partial<ClaudeLaunchSpec> & {
  site: ClaudeLaunchSpec['site']
  session: string
  claudePath: string
  cwd: string
  host: ClaudeLaunchHost
  tmuxSubcommand: ClaudeLaunchSubcommand
}): ClaudeLaunchSpec {
  const spec: ClaudeLaunchSpec = {
    site: input.site,
    session: input.session,
    claudePath: input.claudePath,
    cwd: input.cwd,
    host: input.host,
    tmuxSubcommand: input.tmuxSubcommand,
    model: input.model,
    dangerouslySkipPermissions: input.dangerouslySkipPermissions ?? true,
    continueSession: input.continueSession,
    pluginId: input.pluginId,
    extraPluginIds: input.extraPluginIds ?? [],
    isolatedConfigDir: input.isolatedConfigDir,
    fleetOauthToken: input.fleetOauthToken,
    apiKey: input.apiKey,
    channelEnv: input.channelEnv,
    mcpBatch: input.mcpBatch,
    promptSuggestionGuard: input.promptSuggestionGuard,
    scrubChannelTokens: input.scrubChannelTokens,
    detectSandbox: input.detectSandbox,
    detectAvxLess: input.detectAvxLess,
    pathPreset: input.pathPreset ?? 'macos',
    pathTrailingInherit: input.pathTrailingInherit ?? false,
    tmuxServerPrep: input.tmuxServerPrep,
    paneGeometry: input.paneGeometry,
    cwdAsCd: input.cwdAsCd ?? true,
    cwdAsTmuxC: input.cwdAsTmuxC ?? false,
    followups: input.followups ?? {},
  }
  return spec
}

export interface ValidationResult {
  readonly warnings: readonly string[]
}

export function validateSpec(spec: ClaudeLaunchSpec): ValidationResult {
  const warnings: string[] = []
  const hasChannel = !!spec.channelEnv || !!spec.pluginId
  if (spec.continueSession && hasChannel) {
    const guard = spec.followups?.postResumePluginGuard === true
    if (!guard) warnings.push('missing-post-resume-plugin-guard')
  }
  return { warnings }
}

function emitPathLine(spec: ClaudeLaunchSpec): string {
  const preset = PATH_PRESETS[spec.pathPreset ?? 'macos']
  const trailing = spec.pathTrailingInherit ? ':$PATH' : ''
  return `export PATH="${preset}${trailing}"`
}

function emitMcpTriplet(): string {
  return 'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false MCP_SERVER_CONNECTION_BATCH_SIZE=10 MCP_CONNECTION_NONBLOCKING=1 MCP_TIMEOUT=60000'
}

function emitPromptSuggestionLine(): string {
  return 'export CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=false'
}

function emitScrubChannelTokensLine(): string {
  return 'unset TELEGRAM_BOT_TOKEN SLACK_BOT_TOKEN SLACK_APP_TOKEN DISCORD_BOT_TOKEN'
}

function emitChannelEnvLines(spec: ClaudeLaunchSpec): string[] {
  if (!spec.channelEnv) return []
  const out: string[] = []
  out.push(`export ${spec.channelEnv.stateDirVar}=${shellSingleQuote(spec.channelEnv.stateDir)}`)
  if (spec.channelEnv.auditLogPath) {
    out.push(`export SLACK_AUDIT_LOG=${shellSingleQuote(spec.channelEnv.auditLogPath)}`)
  }
  return out
}

function emitIsolatedConfigDirLine(spec: ClaudeLaunchSpec): string[] {
  if (!spec.isolatedConfigDir) return []
  return [`export CLAUDE_CONFIG_DIR=${shellSingleQuote(spec.isolatedConfigDir)}`]
}

function emitFleetOauthTokenLine(spec: ClaudeLaunchSpec): string[] {
  if (!spec.fleetOauthToken) return []
  return [`export CLAUDE_CODE_OAUTH_TOKEN="$(cat ${shellSingleQuote(spec.fleetOauthToken.path)})"`]
}

function emitApiKeyLine(spec: ClaudeLaunchSpec): string[] {
  if (!spec.apiKey) return []
  if (spec.apiKey.env === 'ANTHROPIC_API_KEY') {
    return [`export ANTHROPIC_API_KEY=${shellSingleQuote(spec.apiKey.value)}`]
  }
  // BYO endpoint triplet — emitted in the legacy slot (between OAuth env and
  // cd) so byte-equality with the pre-refactor splice-based order is preserved.
  const out: string[] = []
  out.push(`export ${spec.apiKey.authTokenEnv}=${shellSingleQuote(spec.apiKey.authToken)}`)
  out.push(`export ANTHROPIC_BASE_URL=${shellSingleQuote(spec.apiKey.baseUrl)}`)
  out.push(`export ANTHROPIC_MODEL=${shellSingleQuote(spec.apiKey.model)}`)
  return out
}

function resolveMcpBatch(spec: ClaudeLaunchSpec): ClaudeLaunchMcpBatch {
  return spec.mcpBatch ?? 'none'
}

function hasChannel(spec: ClaudeLaunchSpec): boolean {
  return !!spec.channelEnv || !!spec.pluginId
}

export function buildClaudeLaunchCmd(spec: ClaudeLaunchSpec): ClaudeLaunchResult {
  const warnings: string[] = []
  const validation = validateSpec(spec)
  warnings.push(...validation.warnings)
  const channel = hasChannel(spec)

  const lines: string[] = []
  lines.push(emitPathLine(spec))

  if (spec.scrubChannelTokens) {
    lines.push(emitScrubChannelTokensLine())
  }

  if (spec.detectSandbox) {
    lines.push('export IS_SANDBOX=1')
  }
  if (spec.detectAvxLess) {
    lines.push('export DISABLE_AUTOUPDATER=1')
  }

  const mcpMode = resolveMcpBatch(spec)
  if (mcpMode === 'always' || (mcpMode === 'channel-only' && channel)) {
    lines.push(emitMcpTriplet())
  } else if (spec.promptSuggestionGuard) {
    lines.push(emitPromptSuggestionLine())
  }

  for (const l of emitChannelEnvLines(spec)) lines.push(l)
  for (const l of emitIsolatedConfigDirLine(spec)) lines.push(l)
  for (const l of emitFleetOauthTokenLine(spec)) lines.push(l)
  for (const l of emitApiKeyLine(spec)) lines.push(l)

  if (spec.pathPreset !== 'login-shell' && spec.cwdAsCd !== false) {
    lines.push(`cd ${shellSingleQuote(spec.cwd)}`)
  }

  const claudeParts: string[] = [spec.claudePath]
  if (spec.continueSession) claudeParts.push('--continue')
  if (spec.dangerouslySkipPermissions !== false) {
    claudeParts.push('--dangerously-skip-permissions')
  }
  if (spec.model) claudeParts.push('--model', shellSingleQuote(spec.model))

  if (spec.pluginId) {
    const plugins = [spec.pluginId, ...(spec.extraPluginIds ?? [])].filter(Boolean)
    claudeParts.push(`--channels ${plugins.map((p) => `plugin:${shellSingleQuote(p)}`).join(' ')}`)
  }

  if (spec.followups?.extraFlags) {
    claudeParts.push(spec.followups.extraFlags)
  }

  const head = lines.filter(Boolean).join(' && ')
  let cmd = `${head} && ${claudeParts.join(' ')}`
  if (spec.followups?.appendCmdSuffix) {
    cmd = `${cmd}${spec.followups.appendCmdSuffix}`
  }

  const args: string[] = []
  if (spec.tmuxSubcommand === 'newSession') {
    args.push('new-session', '-d', '-s', spec.session)
    if (spec.paneGeometry) {
      args.push('-x', String(spec.paneGeometry.cols), '-y', String(spec.paneGeometry.rows))
    }
    if (spec.pathPreset === 'login-shell') {
      args.push('-c', spec.cwd, 'bash', '-lc', cmd)
      return { args, cmd, followupPlan: buildFollowupPlan(spec), warnings }
    }
    if (spec.cwdAsTmuxC) {
      args.push('-c', spec.cwd)
    }
    args.push(cmd)
  } else {
    args.push('respawn-pane', '-k', '-t', spec.session, cmd)
  }

  return { args, cmd, followupPlan: buildFollowupPlan(spec), warnings }
}

function buildFollowupPlan(spec: ClaudeLaunchSpec): ClaudeLaunchFollowupPlan {
  const f = spec.followups ?? {}
  return {
    writeRespawnStamp: f.writeRespawnStamp ?? false,
    identitySetup: f.identitySetup,
    pluginUnlock: f.pluginUnlock ?? false,
    postResumePluginGuard: f.postResumePluginGuard ?? false,
    dismissResumeSummaryModal: f.dismissResumeSummaryModal ?? false,
    reapOrphans: f.reapOrphans ?? 'none',
    reSeedOnboarding: f.reSeedOnboarding ?? false,
    startChannelsStartupGuard: f.startChannelsStartupGuard ?? false,
    keepaliveTouch: f.keepaliveTouch ?? false,
    telegramBotMenu: f.telegramBotMenu ?? false,
    pluginLivenessLoop: f.pluginLivenessLoop,
    rapidExitBackoff: f.rapidExitBackoff,
    replayUnfinishedMessages: f.replayUnfinishedMessages,
    alertOnSuccess: f.alertOnSuccess,
    respawnCounters: f.respawnCounters,
    channelsFailureLog: f.channelsFailureLog ?? false,
    logClaudeVersion: f.logClaudeVersion ?? false,
    onFailureLog: f.onFailureLog,
    extraFlags: f.extraFlags,
    appendCmdSuffix: f.appendCmdSuffix,
    continueSession: !!spec.continueSession,
    hasChannel: hasChannel(spec),
  }
}

function getHostArg(host: ClaudeLaunchHost): string | null {
  if (host.kind === 'remote-ssh') return host.sshTarget
  return null
}

export function runTmuxInvocation(spec: ClaudeLaunchSpec): { ok: boolean; error?: string } {
  const result = buildClaudeLaunchCmd(spec)
  const host = getHostArg(spec.host)
  const args = [...result.args]
  const timeout = host ? 8000 : 10000
  try {
    runTmux(host, args, { timeout })
    return { ok: true }
  } catch (err) {
    const e = err as { stderr?: string; message?: string }
    return { ok: false, error: e.stderr || e.message || String(err) }
  }
}

export interface LaunchContext {
  readonly provider?: ChannelProviderType
  readonly session?: string
  readonly agentDir?: string
  readonly host?: string | null
  readonly displayName?: string
}

function safeReap(provider: ChannelProviderType, agentDir: string | undefined): void {
  try {
    reapChannelOrphans(provider, agentDir ?? process.cwd())
  } catch (err) {
    logger.warn({ err }, 'reapChannelOrphans failed (continuing)')
  }
  try {
    reapDetachedChannelClaudes({ tmuxPath: resolveFromPath('tmux') })
  } catch (err) {
    logger.warn({ err }, 'reapDetachedChannelClaudes failed (continuing)')
  }
}

function resolveProvider(spec: ClaudeLaunchSpec, ctx: LaunchContext): ChannelProviderType | undefined {
  return ctx.provider ?? spec.channelEnv?.provider
}

export function applyPostLaunchFollowups(plan: ClaudeLaunchFollowupPlan, ctx: LaunchContext = {}): void {
  // Runtime guard: a --continue resume with a channel plugin but NO post-resume
  // guard is a known CC 2.1.193 regression pathway. Throw synchronously so a
  // caller cannot silently skip the paired followup.
  if (plan.continueSession && plan.hasChannel && plan.postResumePluginGuard === false) {
    throw new Error('applyPostLaunchFollowups: continueSession && hasChannel requires postResumePluginGuard=true')
  }
  // Each followup runs on its own setImmediate with its own try/catch so a
  // single helper throwing (e.g. writeRespawnStamp on a permission error) does
  // NOT silently skip the rest. The caller still gets back `ok: true` from the
  // launch path -- the followups are best-effort, but no longer coupled.
  if (plan.writeRespawnStamp) {
    setImmediate(() => {
      try { writeRespawnStamp() } catch (err) { logger.warn({ err }, 'applyPostLaunchFollowups: writeRespawnStamp threw (continuing)') }
    })
  }
  if (plan.identitySetup && ctx.session) {
    const host = plan.identitySetup.host ?? ctx.host ?? null
    const session = ctx.session
    const displayName = plan.identitySetup.displayName
    setImmediate(() => {
      try { void scheduleIdentitySetup(session, displayName, host) } catch (err) { logger.warn({ err }, 'applyPostLaunchFollowups: identitySetup threw (continuing)') }
    })
  }
  if (plan.pluginUnlock && ctx.session && ctx.provider) {
    const session = ctx.session
    const provider = ctx.provider
    setImmediate(() => {
      try { schedulePluginUnlockAfterRespawn(session, provider) } catch (err) { logger.warn({ err }, 'applyPostLaunchFollowups: pluginUnlock threw (continuing)') }
    })
  }
  if (plan.postResumePluginGuard && ctx.provider) {
    const provider = ctx.provider
    setImmediate(() => {
      try { schedulePostResumePluginGuard(provider) } catch (err) { logger.warn({ err }, 'applyPostLaunchFollowups: postResumePluginGuard threw (continuing)') }
    })
  }
  if (plan.dismissResumeSummaryModal && ctx.session && plan.continueSession) {
    const session = ctx.session
    const host = ctx.host ?? null
    setImmediate(() => {
      try { void dismissResumeSummaryModalIfPresent(session, host) } catch (err) { logger.warn({ err }, 'applyPostLaunchFollowups: dismissResumeSummaryModal threw (continuing)') }
    })
  }
  if (plan.logClaudeVersion && ctx.agentDir) {
    const fakeCtx = { home: ctx.agentDir, configDir: ctx.agentDir } as Parameters<typeof logWorkerClaudeVersion>[0]
    setImmediate(() => {
      try { logWorkerClaudeVersion(fakeCtx) } catch (err) { logger.warn({ err }, 'applyPostLaunchFollowups: logClaudeVersion threw (continuing)') }
    })
  }
}

async function runPreSteps(spec: ClaudeLaunchSpec, ctx: LaunchContext): Promise<void> {
  const plan = spec.followups ?? {}
  if (plan.reapOrphans === 'channel-both') {
    const provider = resolveProvider(spec, ctx)
    if (provider) {
      safeReap(provider, ctx.agentDir)
    }
  }
  if (plan.reSeedOnboarding === true) {
    try {
      ensureSharedClaudeOnboarded()
    } catch (err) {
      logger.warn({ err }, 'ensureSharedClaudeOnboarded failed (continuing)')
    }
  }
  if (spec.tmuxServerPrep) {
    if (spec.tmuxServerPrep.startServer) {
      try {
        runTmux(null, ['start-server'], { timeout: 3000 })
      } catch (err) {
        logger.warn({ err }, 'tmux start-server failed (continuing)')
      }
    }
    if (spec.tmuxServerPrep.unsetGlobalEnv) {
      for (const v of spec.tmuxServerPrep.unsetGlobalEnv) {
        try {
          runTmux(null, ['set-environment', '-g', '-u', v], { timeout: 3000 })
        } catch (err) {
          logger.warn({ err, var: v }, 'tmux unsetGlobalEnv failed (continuing)')
        }
      }
    }
    if (spec.tmuxServerPrep.setGlobalEnv) {
      for (const [k, v] of Object.entries(spec.tmuxServerPrep.setGlobalEnv)) {
        try {
          runTmux(null, ['set-environment', '-g', k, v], { timeout: 3000 })
        } catch (err) {
          logger.warn({ err, key: k }, 'tmux setGlobalEnv failed (continuing)')
        }
      }
    }
  }
}

export async function launchClaudeNewSession(spec: ClaudeLaunchSpec, ctx: LaunchContext = {}): Promise<{ ok: boolean; error?: string }> {
  if (spec.tmuxSubcommand !== 'newSession') {
    return { ok: false, error: 'tmuxSubcommand must be newSession' }
  }
  await runPreSteps(spec, ctx)
  // kill-session pre-step (best-effort)
  try {
    runTmux(getHostArg(spec.host), ['kill-session', '-t', spec.session], { timeout: 3000 })
  } catch {
    /* session may not exist */
  }
  const invocation = runTmuxInvocation(spec)
  if (!invocation.ok) {
    return invocation
  }
  applyPostLaunchFollowups(buildFollowupPlan(spec), ctx)
  return { ok: true }
}

export async function respawnClaudePane(spec: ClaudeLaunchSpec, ctx: LaunchContext = {}): Promise<{ ok: boolean; error?: string }> {
  if (spec.tmuxSubcommand !== 'respawnPane') {
    return { ok: false, error: 'tmuxSubcommand must be respawnPane' }
  }
  await runPreSteps(spec, ctx)
  const invocation = runTmuxInvocation(spec)
  if (!invocation.ok) {
    return invocation
  }
  applyPostLaunchFollowups(buildFollowupPlan(spec), ctx)
  return { ok: true }
}