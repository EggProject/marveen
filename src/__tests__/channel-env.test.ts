import { describe, it, expect } from 'vitest'
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir, homedir } from 'node:os'
import { ChannelEnv } from '../channel-provider.js'

// ---------------------------------------------------------------------------
// Class-vs-functional decision: see .claude/rules/class-vs-functional-decision.md
// ChannelEnv satisfies Q4 (constructor-injected env DI) + Q5 (per-instance
// test isolation), so class form is justified. All methods are INSTANCE
// methods (no static ceremony trap).
// ---------------------------------------------------------------------------

describe('ChannelEnv constructor injection (CLAUDE.md DR4 regression gate)', () => {
  it('getToken reads from constructor-injected env, NOT process.env', () => {
    const saved = process.env.TELEGRAM_BOT_TOKEN
    delete process.env.TELEGRAM_BOT_TOKEN
    try {
      const env = new ChannelEnv({ TELEGRAM_BOT_TOKEN: 'injected' })
      expect(env.getToken('telegram')).toBe('injected')
    } finally {
      if (saved !== undefined) process.env.TELEGRAM_BOT_TOKEN = saved
    }
  })
})

describe('ChannelEnv.getToken (5-provider dispatch, env-derived)', () => {
  it('returns env.TELEGRAM_BOT_TOKEN for telegram', () => {
    expect(new ChannelEnv({ TELEGRAM_BOT_TOKEN: 'tg' }).getToken('telegram')).toBe('tg')
  })

  it('returns env.SLACK_BOT_TOKEN for slack', () => {
    expect(new ChannelEnv({ SLACK_BOT_TOKEN: 'sk' }).getToken('slack')).toBe('sk')
  })

  it('returns env.DISCORD_BOT_TOKEN for discord', () => {
    expect(new ChannelEnv({ DISCORD_BOT_TOKEN: 'dc' }).getToken('discord')).toBe('dc')
  })

  it('returns env.GOOGLECHAT_PROJECT_ID for googlechat', () => {
    expect(new ChannelEnv({ GOOGLECHAT_PROJECT_ID: 'gc' }).getToken('googlechat')).toBe('gc')
  })

  it('returns env.TEAMS_BOT_APP_ID for teams', () => {
    expect(new ChannelEnv({ TEAMS_BOT_APP_ID: 'tm' }).getToken('teams')).toBe('tm')
  })

  it('returns "" (NOT undefined) when key missing', () => {
    expect(new ChannelEnv({}).getToken('telegram')).toBe('')
  })

  it('ignores unexpected keys, only reads TABLE-defined keys', () => {
    const env = new ChannelEnv({ RANDOM_KEY: 'x', TELEGRAM_BOT_TOKEN: 'tg', ANOTHER: 'y' })
    expect(env.getToken('telegram')).toBe('tg')
  })
})

describe('ChannelEnv.getChatId (5-provider dispatch, env-derived)', () => {
  it('returns env.ALLOWED_CHAT_ID for telegram (NOT TELEGRAM_CHAT_ID - legacy quirk)', () => {
    expect(new ChannelEnv({ ALLOWED_CHAT_ID: '1268077055' }).getChatId('telegram')).toBe('1268077055')
  })

  it('returns env.SLACK_CHANNEL_ID for slack', () => {
    expect(new ChannelEnv({ SLACK_CHANNEL_ID: 'C01234' }).getChatId('slack')).toBe('C01234')
  })

  it('returns env.DISCORD_CHANNEL_ID for discord', () => {
    expect(new ChannelEnv({ DISCORD_CHANNEL_ID: '1234567890' }).getChatId('discord')).toBe('1234567890')
  })

  it('returns env.GOOGLECHAT_SPACE_ID for googlechat', () => {
    expect(new ChannelEnv({ GOOGLECHAT_SPACE_ID: 'spaces/AAAA' }).getChatId('googlechat')).toBe('spaces/AAAA')
  })

  it('returns env.TEAMS_ALLOWED_CONVERSATION_ID for teams', () => {
    expect(new ChannelEnv({ TEAMS_ALLOWED_CONVERSATION_ID: '19:abc' }).getChatId('teams')).toBe('19:abc')
  })

  it('returns "" when key missing', () => {
    expect(new ChannelEnv({}).getChatId('telegram')).toBe('')
  })
})

describe('ChannelEnv.stateDirFor (instance method, not static)', () => {
  it('returns agentDir verbatim when provided (telegram)', () => {
    expect(new ChannelEnv().stateDirFor('telegram', '/custom/dir')).toBe(join('/custom/dir', '.claude', 'channels', 'telegram'))
  })

  it('returns agentDir verbatim when provided (slack)', () => {
    expect(new ChannelEnv().stateDirFor('slack', '/var/lib/slack')).toBe(join('/var/lib/slack', '.claude', 'channels', 'slack'))
  })

  it('falls back to <homedir>/.claude/channels/<subdir> when agentDir is undefined', () => {
    const result = new ChannelEnv().stateDirFor('discord', undefined)
    expect(result).toBe(join(homedir(), '.claude', 'channels', 'discord'))
  })

  it('falls back to homedir when agentDir is empty string (truthy check, NOT !== undefined)', () => {
    const result = new ChannelEnv().stateDirFor('googlechat', '')
    expect(result).toBe(join(homedir(), '.claude', 'channels', 'googlechat'))
    expect(result).not.toBe('')
  })

  it('uses TABLE subdir for teams', () => {
    const result = new ChannelEnv().stateDirFor('teams', '/agent')
    expect(result.endsWith('/teams')).toBe(true)
  })
})

describe('ChannelEnv.readTokenFor (instance method, 3 null paths)', () => {
  it('returns null when the envFilePath does not exist', () => {
    expect(new ChannelEnv().readTokenFor('telegram', '/nonexistent/.env')).toBeNull()
  })

  it('returns the matched value when the file has TELEGRAM_BOT_TOKEN=...', () => {
    const tmp = `${tmpdir()}/channel-env-test-${Date.now()}.env`
    writeFileSync(tmp, 'TELEGRAM_BOT_TOKEN=test-token-123\n', 'utf8')
    try {
      expect(new ChannelEnv().readTokenFor('telegram', tmp)).toBe('test-token-123')
    } finally { rmSync(tmp, { force: true }) }
  })

  it('returns null when the file has no matching KEY=... line', () => {
    const tmp = `${tmpdir()}/channel-env-test-${Date.now()}-no-match.env`
    writeFileSync(tmp, 'OTHER_KEY=value\n', 'utf8')
    try {
      expect(new ChannelEnv().readTokenFor('telegram', tmp)).toBeNull()
    } finally { rmSync(tmp, { force: true }) }
  })

  it('returns null when readFileSync throws (passing a directory path)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'channel-env-test-dir-'))
    try {
      expect(new ChannelEnv().readTokenFor('telegram', dir)).toBeNull()
    } finally { rmSync(dir, { recursive: true, force: true }) }
  })
})
