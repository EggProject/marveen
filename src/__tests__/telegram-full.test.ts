// 100% coverage suite for src/web/telegram.ts.
//
// Pins the CURRENT behaviour (defensive against regressions). Branches
// covered: the per-agent / per-marveen channel-config readers (telegram,
// discord, googlechat, teams, slack), the global token-cache refresh,
// sendMessage (ok / non-ok throws / body read fails / already-marked
// messages stay un-double-marked), sendPhoto (multipart body shape and
// header), the welcome message + avatar flow (with and without avatar
// and SOUL.md first line), sendMarveenAvatarChange (token present /
// absent / send failure), sendAvatarChangeMessage (token present /
// absent / send failure), validateTelegramToken (ok=true / ok=false /
// network throw), parseTelegramToken (env missing / token missing /
// token present), sendMarveenAlert (token absent / send failure).
//
// Sandbox: PROJECT_ROOT is pinned to a tmpdir-scoped value via the mocked
// config.js so PROJECT_ROOT/.env reads/writes stay out of the live
// store. node:os.homedir is redirected to a sibling tmpdir so the
// ~/.claude/channels/<provider>/.env readers don't reach into the
// real home directory. fetch is replaced on globalThis with a vi.fn
// for every test.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const SANDBOX = mkdtempSync(join(tmpdir(), 'telegram-full-'))
const PROJECT = join(SANDBOX, 'project')
const HOME = join(SANDBOX, 'home')
mkdirSync(PROJECT, { recursive: true })
mkdirSync(join(PROJECT, 'agents'), { recursive: true })
mkdirSync(HOME, { recursive: true })
mkdirSync(join(HOME, '.claude', 'channels', 'telegram'), { recursive: true })
mkdirSync(join(HOME, '.claude', 'channels', 'discord'), { recursive: true })
mkdirSync(join(HOME, '.claude', 'channels', 'googlechat'), { recursive: true })
mkdirSync(join(HOME, '.claude', 'channels', 'teams'), { recursive: true })
mkdirSync(join(HOME, '.claude', 'channels', 'slack'), { recursive: true })

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual, ALLOWED_CHAT_ID: '12345' },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
    },
  )
})

const H = vi.hoisted(() => {
  const mkFn = () => vi.fn()
  return {
    loggerInfo: mkFn(),
    loggerWarn: mkFn(),
    loggerError: mkFn(),
    loggerDebug: mkFn(),
  }
})

vi.mock('../logger.js', () => ({
  logger: {
    info: H.loggerInfo,
    warn: H.loggerWarn,
    error: H.loggerError,
    debug: H.loggerDebug,
  },
}))

const {
  readAgentTelegramConfig, readAgentDiscordConfig, readAgentGooglechatConfig, readAgentTeamsConfig,
  readMarveenTelegramConfig, readMarveenDiscordConfig, readMarveenGooglechatConfig, readMarveenTeamsConfig, readMarveenSlackConfig,
  marveenBotUsernameCache, refreshMarveenBotUsername,
  sendTelegramMessage, sendTelegramPhoto,
  sendWelcomeMessage, sendMarveenAvatarChange, sendAvatarChangeMessage,
  validateTelegramToken, parseTelegramToken, sendMarveenAlert,
} = await import('../web/telegram.js')
const { logger } = await import('../logger.js')

const originalFetch = globalThis.fetch
let lastFetchCall: { url: string; init: RequestInit } | null = null

function setFetchImpl(impl: (url: string, init: RequestInit) => Promise<Response>): void {
  globalThis.fetch = vi.fn(async (url: string, init: RequestInit) => {
    lastFetchCall = { url, init }
    return impl(url, init)
  }) as unknown as typeof fetch
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), { status })
}

function agentEnvPath(agent: string): string {
  return join(PROJECT, 'agents', agent, '.claude', 'channels')
}

function writeAgentEnv(agent: string, channel: string, content: string): void {
  const dir = join(agentEnvPath(agent), channel)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, '.env'), content)
}

function writeHomeEnv(channel: string, content: string): void {
  writeFileSync(join(HOME, '.claude', 'channels', channel, '.env'), content)
}

function cleanAgentDir(agent: string): void {
  rmSync(join(PROJECT, 'agents', agent), { recursive: true, force: true })
}

beforeEach(() => {
  vi.clearAllMocks()
  lastFetchCall = null
  marveenBotUsernameCache.value = undefined
  marveenBotUsernameCache.fetchedAt = 0
  // default no-op fetch; tests override per-case
  setFetchImpl(async () => new Response('', { status: 200 }))
  // Clear any leftover agent directories
  for (const agent of ['alpha', 'beta']) cleanAgentDir(agent)
  // Clear any leftover project-root .env
  for (const f of ['.env']) {
    const p = join(PROJECT, f)
    if (existsSync(p)) rmSync(p)
  }
  // Clear any leftover home env files
  for (const ch of ['telegram', 'discord', 'googlechat', 'teams', 'slack']) {
    const p = join(HOME, '.claude', 'channels', ch, '.env')
    if (existsSync(p)) rmSync(p)
  }
})

afterEach(() => {
  globalThis.fetch = originalFetch
})

// ===========================================================================
// readAgentTelegramConfig
// ===========================================================================

describe('readAgentTelegramConfig', () => {
  it('returns hasTelegram=false when the agent dir does not exist', () => {
    expect(readAgentTelegramConfig('alpha')).toEqual({ hasTelegram: false })
  })

  it('returns hasTelegram=false when the .env file is absent', () => {
    mkdirSync(join(PROJECT, 'agents', 'alpha'), { recursive: true })
    mkdirSync(join(PROJECT, 'agents', 'alpha', '.claude', 'channels', 'telegram'), { recursive: true })
    expect(readAgentTelegramConfig('alpha')).toEqual({ hasTelegram: false })
  })

  it('returns hasTelegram=false when TELEGRAM_BOT_TOKEN line is missing', () => {
    writeAgentEnv('alpha', 'telegram', 'OTHER=value\n')
    expect(readAgentTelegramConfig('alpha')).toEqual({ hasTelegram: false })
  })

  it('returns hasTelegram=false when TELEGRAM_BOT_TOKEN is empty/whitespace', () => {
    writeAgentEnv('alpha', 'telegram', 'TELEGRAM_BOT_TOKEN=   \n')
    expect(readAgentTelegramConfig('alpha')).toEqual({ hasTelegram: false })
  })

  it('returns hasTelegram=true when a non-empty TELEGRAM_BOT_TOKEN is present', () => {
    writeAgentEnv('alpha', 'telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    expect(readAgentTelegramConfig('alpha')).toEqual({ hasTelegram: true })
  })
})

// ===========================================================================
// readAgentDiscordConfig
// ===========================================================================

describe('readAgentDiscordConfig', () => {
  it('returns hasDiscord=false when the agent dir does not exist', () => {
    expect(readAgentDiscordConfig('alpha')).toEqual({ hasDiscord: false })
  })

  it('returns hasDiscord=false when the .env file is absent', () => {
    mkdirSync(join(PROJECT, 'agents', 'alpha'), { recursive: true })
    mkdirSync(join(PROJECT, 'agents', 'alpha', '.claude', 'channels', 'discord'), { recursive: true })
    expect(readAgentDiscordConfig('alpha')).toEqual({ hasDiscord: false })
  })

  it('returns hasDiscord=false when DISCORD_BOT_TOKEN line is missing/empty', () => {
    writeAgentEnv('alpha', 'discord', 'OTHER=value\n')
    expect(readAgentDiscordConfig('alpha')).toEqual({ hasDiscord: false })
    writeAgentEnv('alpha', 'discord', 'DISCORD_BOT_TOKEN=   \n')
    expect(readAgentDiscordConfig('alpha')).toEqual({ hasDiscord: false })
  })

  it('returns hasDiscord=true when a non-empty DISCORD_BOT_TOKEN is present', () => {
    writeAgentEnv('alpha', 'discord', 'DISCORD_BOT_TOKEN=xyz\n')
    expect(readAgentDiscordConfig('alpha')).toEqual({ hasDiscord: true })
  })
})

// ===========================================================================
// readAgentGooglechatConfig
// ===========================================================================

describe('readAgentGooglechatConfig', () => {
  it('returns hasGooglechat=false when the agent dir does not exist', () => {
    expect(readAgentGooglechatConfig('alpha')).toEqual({ hasGooglechat: false })
  })

  it('returns hasGooglechat=false when the .env file is absent', () => {
    mkdirSync(join(PROJECT, 'agents', 'alpha'), { recursive: true })
    mkdirSync(join(PROJECT, 'agents', 'alpha', '.claude', 'channels', 'googlechat'), { recursive: true })
    expect(readAgentGooglechatConfig('alpha')).toEqual({ hasGooglechat: false })
  })

  it('returns hasGooglechat=false when GOOGLECHAT_PROJECT_ID is missing/empty', () => {
    writeAgentEnv('alpha', 'googlechat', 'OTHER=value\n')
    expect(readAgentGooglechatConfig('alpha')).toEqual({ hasGooglechat: false })
    writeAgentEnv('alpha', 'googlechat', 'GOOGLECHAT_PROJECT_ID=\n')
    expect(readAgentGooglechatConfig('alpha')).toEqual({ hasGooglechat: false })
  })

  it('returns hasGooglechat=true when GOOGLECHAT_PROJECT_ID is present', () => {
    writeAgentEnv('alpha', 'googlechat', 'GOOGLECHAT_PROJECT_ID=proj-1\n')
    expect(readAgentGooglechatConfig('alpha')).toEqual({ hasGooglechat: true })
  })
})

// ===========================================================================
// readAgentTeamsConfig
// ===========================================================================

describe('readAgentTeamsConfig', () => {
  it('returns hasTeams=false when the agent dir does not exist', () => {
    expect(readAgentTeamsConfig('alpha')).toEqual({ hasTeams: false })
  })

  it('returns hasTeams=false when the .env file is absent', () => {
    mkdirSync(join(PROJECT, 'agents', 'alpha'), { recursive: true })
    mkdirSync(join(PROJECT, 'agents', 'alpha', '.claude', 'channels', 'teams'), { recursive: true })
    expect(readAgentTeamsConfig('alpha')).toEqual({ hasTeams: false })
  })

  it('returns hasTeams=false when TEAMS_BOT_APP_ID is missing/empty', () => {
    writeAgentEnv('alpha', 'teams', 'OTHER=value\n')
    expect(readAgentTeamsConfig('alpha')).toEqual({ hasTeams: false })
    writeAgentEnv('alpha', 'teams', 'TEAMS_BOT_APP_ID=\n')
    expect(readAgentTeamsConfig('alpha')).toEqual({ hasTeams: false })
  })

  it('returns hasTeams=true when TEAMS_BOT_APP_ID is present', () => {
    writeAgentEnv('alpha', 'teams', 'TEAMS_BOT_APP_ID=app-1\n')
    expect(readAgentTeamsConfig('alpha')).toEqual({ hasTeams: true })
  })
})

// ===========================================================================
// readMarveenTelegramConfig
// ===========================================================================

describe('readMarveenTelegramConfig', () => {
  it('returns hasTelegram=false when the .env file is missing', () => {
    expect(readMarveenTelegramConfig()).toEqual({ hasTelegram: false })
  })

  it('returns hasTelegram=false when TELEGRAM_BOT_TOKEN is missing/empty', () => {
    writeHomeEnv('telegram', 'OTHER=value\n')
    expect(readMarveenTelegramConfig()).toEqual({ hasTelegram: false })
    writeHomeEnv('telegram', 'TELEGRAM_BOT_TOKEN=\n')
    expect(readMarveenTelegramConfig()).toEqual({ hasTelegram: false })
  })

  it('returns hasTelegram=true with cached botUsername when TELEGRAM_BOT_TOKEN is present', () => {
    writeHomeEnv('telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    marveenBotUsernameCache.value = '@MyBot'
    expect(readMarveenTelegramConfig()).toEqual({ hasTelegram: true, botUsername: '@MyBot' })
  })

  it('returns hasTelegram=true with undefined botUsername when cache is empty', () => {
    writeHomeEnv('telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    marveenBotUsernameCache.value = undefined
    expect(readMarveenTelegramConfig()).toEqual({ hasTelegram: true, botUsername: undefined })
  })
})

// ===========================================================================
// readMarveenDiscordConfig
// ===========================================================================

describe('readMarveenDiscordConfig', () => {
  it('returns hasDiscord=false when the .env is missing', () => {
    expect(readMarveenDiscordConfig()).toEqual({ hasDiscord: false })
  })

  it('returns hasDiscord=false when DISCORD_BOT_TOKEN is missing/empty', () => {
    writeHomeEnv('discord', 'OTHER=v\n')
    expect(readMarveenDiscordConfig()).toEqual({ hasDiscord: false })
    writeHomeEnv('discord', 'DISCORD_BOT_TOKEN=\n')
    expect(readMarveenDiscordConfig()).toEqual({ hasDiscord: false })
  })

  it('returns hasDiscord=true when DISCORD_BOT_TOKEN is present', () => {
    writeHomeEnv('discord', 'DISCORD_BOT_TOKEN=xyz\n')
    expect(readMarveenDiscordConfig()).toEqual({ hasDiscord: true })
  })
})

// ===========================================================================
// readMarveenGooglechatConfig
// ===========================================================================

describe('readMarveenGooglechatConfig', () => {
  it('returns hasGooglechat=false when the .env is missing', () => {
    expect(readMarveenGooglechatConfig()).toEqual({ hasGooglechat: false })
  })

  it('returns hasGooglechat=false when GOOGLECHAT_PROJECT_ID is missing/empty', () => {
    writeHomeEnv('googlechat', 'OTHER=v\n')
    expect(readMarveenGooglechatConfig()).toEqual({ hasGooglechat: false })
    writeHomeEnv('googlechat', 'GOOGLECHAT_PROJECT_ID=\n')
    expect(readMarveenGooglechatConfig()).toEqual({ hasGooglechat: false })
  })

  it('returns hasGooglechat=true when GOOGLECHAT_PROJECT_ID is present', () => {
    writeHomeEnv('googlechat', 'GOOGLECHAT_PROJECT_ID=p1\n')
    expect(readMarveenGooglechatConfig()).toEqual({ hasGooglechat: true })
  })
})

// ===========================================================================
// readMarveenTeamsConfig
// ===========================================================================

describe('readMarveenTeamsConfig', () => {
  it('returns hasTeams=false when the .env is missing', () => {
    expect(readMarveenTeamsConfig()).toEqual({ hasTeams: false })
  })

  it('returns hasTeams=false when TEAMS_BOT_APP_ID is missing/empty', () => {
    writeHomeEnv('teams', 'OTHER=v\n')
    expect(readMarveenTeamsConfig()).toEqual({ hasTeams: false })
    writeHomeEnv('teams', 'TEAMS_BOT_APP_ID=\n')
    expect(readMarveenTeamsConfig()).toEqual({ hasTeams: false })
  })

  it('returns hasTeams=true when TEAMS_BOT_APP_ID is present', () => {
    writeHomeEnv('teams', 'TEAMS_BOT_APP_ID=app-1\n')
    expect(readMarveenTeamsConfig()).toEqual({ hasTeams: true })
  })
})

// ===========================================================================
// readMarveenSlackConfig
// ===========================================================================

describe('readMarveenSlackConfig', () => {
  it('returns hasSlack=false when the .env is missing', () => {
    expect(readMarveenSlackConfig()).toEqual({ hasSlack: false })
  })

  it('returns hasSlack=false when SLACK_BOT_TOKEN is missing/empty', () => {
    writeHomeEnv('slack', 'OTHER=v\n')
    expect(readMarveenSlackConfig()).toEqual({ hasSlack: false })
    writeHomeEnv('slack', 'SLACK_BOT_TOKEN=\n')
    expect(readMarveenSlackConfig()).toEqual({ hasSlack: false })
  })

  it('returns hasSlack=true when SLACK_BOT_TOKEN is present', () => {
    writeHomeEnv('slack', 'SLACK_BOT_TOKEN=slack-tok\n')
    expect(readMarveenSlackConfig()).toEqual({ hasSlack: true })
  })
})

// ===========================================================================
// refreshMarveenBotUsername
// ===========================================================================

describe('refreshMarveenBotUsername', () => {
  it('does nothing when the .env file is missing', async () => {
    await refreshMarveenBotUsername()
    expect(marveenBotUsernameCache.value).toBeUndefined()
    expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('does nothing when TELEGRAM_BOT_TOKEN is missing/empty', async () => {
    writeHomeEnv('telegram', 'OTHER=v\n')
    await refreshMarveenBotUsername()
    expect(marveenBotUsernameCache.value).toBeUndefined()
    expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()

    writeHomeEnv('telegram', 'TELEGRAM_BOT_TOKEN=   \n')
    await refreshMarveenBotUsername()
    expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('caches the username on a successful getMe', async () => {
    writeHomeEnv('telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    setFetchImpl(async (url) => {
      expect(url).toBe('https://api.telegram.org/bot1234:abcd/getMe')
      return jsonResponse({ ok: true, result: { username: 'MyBot' } })
    })
    await refreshMarveenBotUsername()
    expect(marveenBotUsernameCache.value).toBe('@MyBot')
    expect(marveenBotUsernameCache.fetchedAt).toBeGreaterThan(0)
  })

  it('does not cache when ok=false or username missing', async () => {
    writeHomeEnv('telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    setFetchImpl(async () => jsonResponse({ ok: false, description: 'bad token' }))
    await refreshMarveenBotUsername()
    expect(marveenBotUsernameCache.value).toBeUndefined()

    setFetchImpl(async () => jsonResponse({ ok: true, result: {} }))
    await refreshMarveenBotUsername()
    expect(marveenBotUsernameCache.value).toBeUndefined()
  })

  it('swallows fetch errors and leaves cache untouched', async () => {
    writeHomeEnv('telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    setFetchImpl(async () => { throw new Error('network down') })
    await expect(refreshMarveenBotUsername()).resolves.toBeUndefined()
    expect(marveenBotUsernameCache.value).toBeUndefined()
  })
})

// ===========================================================================
// sendTelegramMessage
// ===========================================================================

describe('sendTelegramMessage', () => {
  it('POSTs chat_id + text and returns silently on 2xx (test runner auto-marks the text)', async () => {
    setFetchImpl(async (url, init) => {
      expect(url).toBe('https://api.telegram.org/bot1234:abcd/sendMessage')
      expect(init.method).toBe('POST')
      expect(init.headers).toEqual({ 'Content-Type': 'application/json' })
      const body = JSON.parse(init.body as string)
      // VITEST=true / NODE_ENV=test is auto-set by the runner, so markIfTestRun
      // prefixes the text -- pin CURRENT behaviour, not the production path.
      expect(body.chat_id).toBe('12345')
      expect(body.text).toContain('hello')
      return jsonResponse({ ok: true, result: { message_id: 1 } })
    })
    await expect(sendTelegramMessage('1234:abcd', '12345', 'hello')).resolves.toBeUndefined()
  })

  it('prepends the [TESZT] marker when running under vitest (test-run-marker)', async () => {
    process.env['VITEST'] = 'true'
    setFetchImpl(async (_url, init) => {
      const body = JSON.parse(init.body as string)
      expect(body.text.startsWith('[TESZT] ')).toBe(true)
      return jsonResponse({ ok: true })
    })
    await sendTelegramMessage('1234:abcd', '12345', 'hello')
    delete process.env['VITEST']
  })

  it('throws on non-2xx responses, slicing the body to 200 chars', async () => {
    setFetchImpl(async () => new Response('bad token: revoked', { status: 401 }))
    await expect(sendTelegramMessage('bad', '12345', 'hi'))
      .rejects.toThrow(/^Telegram API 401: bad token: revoked$/)
  })

  it('throws on non-2xx when the body text read itself fails (silent-failure slice)', async () => {
    setFetchImpl(async () => {
      const r = new Response('partial', { status: 500 })
      // Replace text() to simulate the body read failing
      ;(r as unknown as { text: () => Promise<string> }).text = () => Promise.reject(new Error('boom'))
      return r
    })
    await expect(sendTelegramMessage('bad', '12345', 'hi'))
      .rejects.toThrow(/^Telegram API 500: $/)
  })

  it('does not double-mark when the text already carries the [TESZT] prefix', async () => {
    process.env['VITEST'] = 'true'
    setFetchImpl(async (_url, init) => {
      const body = JSON.parse(init.body as string)
      expect(body.text).toBe('[TESZT] already-marked')
      return jsonResponse({ ok: true })
    })
    await sendTelegramMessage('1234:abcd', '12345', '[TESZT] already-marked')
    delete process.env['VITEST']
  })
})

// ===========================================================================
// sendTelegramPhoto
// ===========================================================================

describe('sendTelegramPhoto', () => {
  it('builds a multipart body and POSTs it', async () => {
    const photo = join(SANDBOX, 'avatar.png')
    writeFileSync(photo, Buffer.from([1, 2, 3, 4, 5]))
    setFetchImpl(async (url, init) => {
      expect(url).toBe('https://api.telegram.org/bot1234:abcd/sendPhoto')
      expect(init.method).toBe('POST')
      const headers = init.headers as Record<string, string>
      const ct = headers['Content-Type']
      expect(ct.startsWith('multipart/form-data; boundary=----FormBoundary')).toBe(true)
      const body = Buffer.from(init.body as ArrayBuffer)
      const text = body.toString('utf-8')
      expect(text).toContain('chat_id')
      expect(text).toContain('12345')
      expect(text).toContain('caption')
      // The test runner auto-marks the caption text with [TESZT] (markIfTestRun).
      expect(text).toContain('caption text')
      expect(text).toContain('photo')
      expect(text).toContain('avatar.png')
      expect(text).toContain('image/png')
      return jsonResponse({ ok: true })
    })
    await sendTelegramPhoto('1234:abcd', '12345', photo, 'caption text')
  })
})

// ===========================================================================
// sendWelcomeMessage
// ===========================================================================

describe('sendWelcomeMessage', () => {
  it('sends a greeting with the SOUL.md first line and an avatar when present', async () => {
    const agentDir = join(PROJECT, 'agents', 'alpha')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, 'SOUL.md'), '# Title\nIntro line here\nMore lines\n')
    writeFileSync(join(agentDir, 'avatar.png'), Buffer.from([1, 2, 3]))

    const calls: string[] = []
    setFetchImpl(async (url) => {
      calls.push(url)
      if (url.endsWith('/sendMessage')) return jsonResponse({ ok: true })
      if (url.endsWith('/sendPhoto')) return jsonResponse({ ok: true })
      throw new Error(`unexpected url ${url}`)
    })
    await sendWelcomeMessage('alpha', '1234:abcd')
    expect(calls.length).toBe(2)
    expect(calls.some((u) => u.endsWith('/sendMessage'))).toBe(true)
    expect(calls.some((u) => u.endsWith('/sendPhoto'))).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      { agentName: 'alpha' },
      expect.stringContaining('Welcome message sent'),
    )
  })

  it('uppercases the first letter of the agent name and handles missing SOUL.md', async () => {
    const agentDir = join(PROJECT, 'agents', 'beta')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    // No SOUL.md at all
    let capturedText = ''
    setFetchImpl(async (_url, init) => {
      if (!init.body) return jsonResponse({ ok: true })
      const body = JSON.parse(init.body as string)
      capturedText = body.text
      return jsonResponse({ ok: true })
    })
    await sendWelcomeMessage('beta', '1234:abcd')
    expect(capturedText).toContain('Beta')
    expect(capturedText).toContain('vagyok')
    expect(capturedText).not.toContain('undefined')
  })

  it('falls back to a single SOUL.md line when only header lines are present', async () => {
    const agentDir = join(PROJECT, 'agents', 'alpha')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    writeFileSync(join(agentDir, 'SOUL.md'), '# header 1\n# header 2\n')
    let capturedText = ''
    setFetchImpl(async (_url, init) => {
      if (!init.body) return jsonResponse({ ok: true })
      capturedText = JSON.parse(init.body as string).text
      return jsonResponse({ ok: true })
    })
    await sendWelcomeMessage('alpha', '1234:abcd')
    // The first non-comment line is "" -- the fallback `|| ''` keeps it empty.
    expect(capturedText).toContain('Alpha')
    expect(capturedText.startsWith('[TESZT] Szia! Alpha vagyok')).toBe(true)
  })

  it('does not send a photo when the agent has no avatar file', async () => {
    const agentDir = join(PROJECT, 'agents', 'alpha')
    mkdirSync(join(agentDir, '.claude'), { recursive: true })
    let calls = 0
    setFetchImpl(async (url) => {
      calls += 1
      expect(url.endsWith('/sendMessage')).toBe(true)
      return jsonResponse({ ok: true })
    })
    await sendWelcomeMessage('alpha', '1234:abcd')
    expect(calls).toBe(1)
  })

  it('logs a warning but does not throw when the API rejects the greeting', async () => {
    setFetchImpl(async () => { throw new Error('network') })
    await expect(sendWelcomeMessage('alpha', '1234:abcd')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), agentName: 'alpha' }),
      expect.stringContaining('Failed to send welcome message'),
    )
  })
})

// ===========================================================================
// sendMarveenAvatarChange
// ===========================================================================

describe('sendMarveenAvatarChange', () => {
  it('returns silently when PROJECT_ROOT/.env has no TELEGRAM_BOT_TOKEN', async () => {
    await sendMarveenAvatarChange(join(SANDBOX, 'avatar.png'))
    expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('sends a random greeting + the photo when a token is present', async () => {
    writeFileSync(join(PROJECT, '.env'), 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    const photo = join(SANDBOX, 'avatar.png')
    writeFileSync(photo, Buffer.from([1, 2, 3]))
    const urls: string[] = []
    setFetchImpl(async (url) => {
      urls.push(url)
      return jsonResponse({ ok: true })
    })
    await sendMarveenAvatarChange(photo)
    expect(urls.some((u) => u.endsWith('/sendMessage'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/sendPhoto'))).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      expect.stringContaining('Marveen avatar change message sent'),
    )
  })

  it('logs a warning but does not throw when the send fails', async () => {
    writeFileSync(join(PROJECT, '.env'), 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    setFetchImpl(async () => { throw new Error('boom') })
    await expect(sendMarveenAvatarChange(join(SANDBOX, 'avatar.png'))).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to send Marveen avatar change message'),
    )
  })
})

// ===========================================================================
// sendAvatarChangeMessage
// ===========================================================================

describe('sendAvatarChangeMessage', () => {
  it('returns silently when the agent has no telegram token', async () => {
    await sendAvatarChangeMessage('alpha', join(SANDBOX, 'avatar.png'))
    expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('sends a random greeting + the photo when the agent has a token', async () => {
    writeAgentEnv('alpha', 'telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    const photo = join(SANDBOX, 'avatar.png')
    writeFileSync(photo, Buffer.from([1, 2, 3]))
    const urls: string[] = []
    setFetchImpl(async (url) => {
      urls.push(url)
      return jsonResponse({ ok: true })
    })
    await sendAvatarChangeMessage('alpha', photo)
    expect(urls.some((u) => u.endsWith('/sendMessage'))).toBe(true)
    expect(urls.some((u) => u.endsWith('/sendPhoto'))).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(
      { agentName: 'alpha' },
      expect.stringContaining('Avatar change message sent'),
    )
  })

  it('logs a warning when the send throws', async () => {
    writeAgentEnv('alpha', 'telegram', 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    setFetchImpl(async () => { throw new Error('boom') })
    await expect(sendAvatarChangeMessage('alpha', join(SANDBOX, 'avatar.png'))).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error), agentName: 'alpha' }),
      expect.stringContaining('Failed to send avatar change message'),
    )
  })
})

// ===========================================================================
// validateTelegramToken
// ===========================================================================

describe('validateTelegramToken', () => {
  it('returns the parsed botUsername + botId on a successful getMe', async () => {
    setFetchImpl(async (url) => {
      expect(url).toBe('https://api.telegram.org/bot1234:abcd/getMe')
      return jsonResponse({ ok: true, result: { username: 'MyBot', id: 42 } })
    })
    const result = await validateTelegramToken('1234:abcd')
    expect(result).toEqual({ ok: true, botUsername: 'MyBot', botId: 42 })
  })

  it('returns ok=false + error when the response is ok=false', async () => {
    setFetchImpl(async () => jsonResponse({ ok: false, description: 'invalid token' }))
    const result = await validateTelegramToken('bad')
    expect(result).toEqual({ ok: false, error: 'Invalid bot token' })
  })

  it('returns ok=false when ok=true but result is missing', async () => {
    setFetchImpl(async () => jsonResponse({ ok: true }))
    const result = await validateTelegramToken('1234:abcd')
    expect(result).toEqual({ ok: false, error: 'Invalid bot token' })
  })

  it('returns ok=false on network error', async () => {
    setFetchImpl(async () => { throw new Error('ECONNREFUSED') })
    const result = await validateTelegramToken('1234:abcd')
    expect(result).toEqual({ ok: false, error: 'Failed to connect to Telegram API' })
  })
})

// ===========================================================================
// parseTelegramToken
// ===========================================================================

describe('parseTelegramToken', () => {
  it('returns null when the agent dir does not exist', () => {
    expect(parseTelegramToken('alpha')).toBeNull()
  })

  it('returns null when the .env file is absent', () => {
    mkdirSync(join(PROJECT, 'agents', 'alpha', '.claude', 'channels', 'telegram'), { recursive: true })
    expect(parseTelegramToken('alpha')).toBeNull()
  })

  it('returns null when TELEGRAM_BOT_TOKEN line is missing', () => {
    writeAgentEnv('alpha', 'telegram', 'OTHER=v\n')
    expect(parseTelegramToken('alpha')).toBeNull()
  })

  it('returns the trimmed token when present', () => {
    writeAgentEnv('alpha', 'telegram', 'TELEGRAM_BOT_TOKEN=  1234:abcd  \n')
    expect(parseTelegramToken('alpha')).toBe('1234:abcd')
  })
})

// ===========================================================================
// sendMarveenAlert
// ===========================================================================

describe('sendMarveenAlert', () => {
  it('returns silently when PROJECT_ROOT/.env has no TELEGRAM_BOT_TOKEN', async () => {
    await sendMarveenAlert('alert text')
    expect(globalThis.fetch as unknown as ReturnType<typeof vi.fn>).not.toHaveBeenCalled()
  })

  it('sends the alert when a token is present', async () => {
    writeFileSync(join(PROJECT, '.env'), 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    setFetchImpl(async (url, init) => {
      expect(url).toBe('https://api.telegram.org/bot1234:abcd/sendMessage')
      const body = JSON.parse(init.body as string)
      expect(body).toMatchObject({ chat_id: '12345', text: 'alert text' })
      return jsonResponse({ ok: true })
    })
    await sendMarveenAlert('alert text')
  })

  it('logs a warning but does not throw when sendTelegramMessage rejects', async () => {
    writeFileSync(join(PROJECT, '.env'), 'TELEGRAM_BOT_TOKEN=1234:abcd\n')
    setFetchImpl(async () => new Response('bad', { status: 401 }))
    await expect(sendMarveenAlert('alert')).resolves.toBeUndefined()
    expect(logger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('Failed to send marveen plugin alert'),
    )
  })
})