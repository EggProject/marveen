import { describe, expect, it } from 'vitest'
import {
  CHANNEL_SECRET_ENV_KEYS,
  CLAUDE_CHANNEL_ENV,
  CLAUDE_COMMON_ENV,
  CLAUDE_PATH_ENTRIES,
  buildClaudeRuntimeEnv,
  channelStateEnvKey,
} from '../runtime-env.js'

describe('runtime-env', () => {
  it('keeps one canonical PATH list and common env map', () => {
    expect(CLAUDE_PATH_ENTRIES).toContain('$HOME/.bun/bin')
    expect(CLAUDE_COMMON_ENV.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe('false')
    expect(CLAUDE_CHANNEL_ENV.MCP_TIMEOUT).toBe('60000')
  })

  it.each([
    ['telegram', 'TELEGRAM_STATE_DIR'],
    ['slack', 'SLACK_STATE_DIR'],
    ['discord', 'DISCORD_STATE_DIR'],
    ['googlechat', 'GOOGLECHAT_STATE_DIR'],
    ['teams', 'TEAMS_STATE_DIR'],
  ] as const)('maps %s to %s', (provider, key) => {
    expect(channelStateEnvKey(provider)).toBe(key)
  })

  it('scrubs inherited channel secrets and adds common env without channel tuning', () => {
    const inherited = Object.fromEntries(CHANNEL_SECRET_ENV_KEYS.map((key) => [key, 'secret']))
    const env = buildClaudeRuntimeEnv({ ...inherited, KEEP: 'yes' }, { hasChannel: false })
    expect(env.KEEP).toBe('yes')
    expect(env.CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION).toBe('false')
    expect(env.MCP_TIMEOUT).toBeUndefined()
    for (const key of CHANNEL_SECRET_ENV_KEYS) expect(env[key]).toBeUndefined()
  })

  it('adds channel tuning, config dir and provider state without mutating input', () => {
    const inherited = { KEEP: 'yes', TELEGRAM_BOT_TOKEN: 'secret' }
    const env = buildClaudeRuntimeEnv(inherited, {
      hasChannel: true,
      configDir: '/cfg',
      state: { provider: 'slack', dir: '/state' },
    })
    expect(env).toMatchObject({
      KEEP: 'yes',
      CLAUDE_CONFIG_DIR: '/cfg',
      SLACK_STATE_DIR: '/state',
      MCP_SERVER_CONNECTION_BATCH_SIZE: '10',
    })
    expect(inherited.TELEGRAM_BOT_TOKEN).toBe('secret')
  })
})
