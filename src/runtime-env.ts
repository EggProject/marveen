import type { ChannelProviderType } from './channel-provider.js'

export const CHANNEL_SECRET_ENV_KEYS = [
  'TELEGRAM_BOT_TOKEN',
  'SLACK_BOT_TOKEN',
  'SLACK_APP_TOKEN',
  'DISCORD_BOT_TOKEN',
] as const

export const CLAUDE_PATH_ENTRIES = [
  '/opt/homebrew/bin',
  '$HOME/.bun/bin',
  '/home/linuxbrew/.linuxbrew/bin',
  '$HOME/.local/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
] as const

export const CLAUDE_COMMON_ENV = {
  CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION: 'false',
} as const

export const CLAUDE_CHANNEL_ENV = {
  MCP_SERVER_CONNECTION_BATCH_SIZE: '10',
  MCP_CONNECTION_NONBLOCKING: '1',
  MCP_TIMEOUT: '60000',
} as const

export function channelStateEnvKey(provider: ChannelProviderType): string {
  if (provider === 'slack') return 'SLACK_STATE_DIR'
  if (provider === 'discord') return 'DISCORD_STATE_DIR'
  if (provider === 'googlechat') return 'GOOGLECHAT_STATE_DIR'
  if (provider === 'teams') return 'TEAMS_STATE_DIR'
  return 'TELEGRAM_STATE_DIR'
}

export function buildClaudeRuntimeEnv(
  inherited: NodeJS.ProcessEnv,
  options: {
    hasChannel: boolean
    configDir?: string
    state?: { provider: ChannelProviderType; dir: string }
  },
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...inherited, ...CLAUDE_COMMON_ENV }
  for (const key of CHANNEL_SECRET_ENV_KEYS) delete env[key]
  if (options.hasChannel) Object.assign(env, CLAUDE_CHANNEL_ENV)
  if (options.configDir) env.CLAUDE_CONFIG_DIR = options.configDir
  if (options.state) env[channelStateEnvKey(options.state.provider)] = options.state.dir
  return env
}
