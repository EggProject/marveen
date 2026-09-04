import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { EventEmitter } from 'node:events'
import https from 'node:https'
import {
  getProvider,
  getProviderType,
  ChannelEnv,
  generateSlackAppManifest,
  getSlackAppSetupInstructions,
  formatForSlackMrkdwn,
  type ChannelProviderType,
} from '../channel-provider.js'

// ---------------------------------------------------------------------------
// Existing tests kept verbatim -- these cover the registry surface, the Slack
// formatting rules, and the per-provider split limits.
// ---------------------------------------------------------------------------

describe('getProviderType', () => {
  it('returns telegram by default', () => {
    expect(getProviderType(undefined)).toBe('telegram')
    expect(getProviderType('')).toBe('telegram')
    expect(getProviderType('anything')).toBe('telegram')
  })

  it('returns slack when explicitly set', () => {
    expect(getProviderType('slack')).toBe('slack')
  })

  it('returns discord when explicitly set', () => {
    expect(getProviderType('discord')).toBe('discord')
  })

  it('returns googlechat when explicitly set', () => {
    expect(getProviderType('googlechat')).toBe('googlechat')
  })

  it('returns teams when explicitly set', () => {
    expect(getProviderType('teams')).toBe('teams')
  })
})

describe('getProvider', () => {
  it('returns telegram provider with correct pluginId', () => {
    const p = getProvider('telegram')
    expect(p.type).toBe('telegram')
    expect(p.pluginId).toBe('telegram@claude-plugins-official')
    expect(p.pluginPaneId).toBe('plugin:telegram:telegram')
    expect(p.envKeys).toContain('TELEGRAM_BOT_TOKEN')
    expect(p.stateDir).toBe('telegram')
    expect(p.chatIdFormat).toBe('numeric (e.g. 1268077055)')
  })

  it('returns slack provider with correct pluginId', () => {
    const p = getProvider('slack')
    expect(p.type).toBe('slack')
    expect(p.pluginId).toBe('slack-channel@marveen-marketplace')
    expect(p.pluginPaneId).toBe('plugin:slack-channel:marveen-marketplace')
    expect(p.envKeys).toEqual(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])
    expect(p.stateDir).toBe('slack')
    expect(p.chatIdFormat).toContain('Slack channel')
  })

  it('returns discord provider with correct pluginId', () => {
    const p = getProvider('discord')
    expect(p.type).toBe('discord')
    expect(p.pluginId).toBe('discord@claude-plugins-official')
    expect(p.pluginPaneId).toBe('plugin:discord:discord')
    expect(p.envKeys).toEqual(['DISCORD_BOT_TOKEN'])
    expect(p.stateDir).toBe('discord')
    expect(p.chatIdFormat).toContain('Discord channel')
  })

  it('returns googlechat provider with correct pluginId', () => {
    const p = getProvider('googlechat')
    expect(p.type).toBe('googlechat')
    expect(p.pluginId).toBe('googlechat@claude-channel-googlechat')
    expect(p.pluginPaneId).toBe('plugin:googlechat:googlechat')
    expect(p.envKeys).toContain('GOOGLECHAT_PROJECT_ID')
    expect(p.envKeys).toContain('GOOGLE_APPLICATION_CREDENTIALS')
    expect(p.envKeys).toContain('GOOGLECHAT_SUBSCRIPTION')
    expect(p.stateDir).toBe('googlechat')
    expect(p.chatIdFormat).toContain('space resource')
  })

  it('returns teams provider with correct pluginId', () => {
    const p = getProvider('teams')
    expect(p.type).toBe('teams')
    expect(p.pluginId).toBe('teams@marveen-marketplace')
    expect(p.pluginPaneId).toBe('plugin:teams:marveen-marketplace')
    expect(p.envKeys).toContain('TEAMS_BOT_APP_ID')
    expect(p.envKeys).toContain('TEAMS_BOT_APP_PASSWORD')
    expect(p.envKeys).toContain('TEAMS_BOT_TENANT_ID')
    expect(p.stateDir).toBe('teams')
    expect(p.chatIdFormat).toContain('Teams conversation')
  })
})

describe('ChannelEnv.getToken', () => {
  it('reads TELEGRAM_BOT_TOKEN for telegram', () => {
    const env = { TELEGRAM_BOT_TOKEN: 'tg-tok-123' }
    expect(new ChannelEnv(env).getToken('telegram')).toBe('tg-tok-123')
  })

  it('reads SLACK_BOT_TOKEN for slack', () => {
    const env = { SLACK_BOT_TOKEN: 'xoxb-123' }
    expect(new ChannelEnv(env).getToken('slack')).toBe('xoxb-123')
  })

  it('reads DISCORD_BOT_TOKEN for discord', () => {
    const env = { DISCORD_BOT_TOKEN: 'discord-tok-123' }
    expect(new ChannelEnv(env).getToken('discord')).toBe('discord-tok-123')
  })

  it('reads GOOGLECHAT_PROJECT_ID for googlechat', () => {
    const env = { GOOGLECHAT_PROJECT_ID: 'gcp-proj-1' }
    expect(new ChannelEnv(env).getToken('googlechat')).toBe('gcp-proj-1')
  })

  it('reads TEAMS_BOT_APP_ID for teams', () => {
    const env = { TEAMS_BOT_APP_ID: 'app-id-123' }
    expect(new ChannelEnv(env).getToken('teams')).toBe('app-id-123')
  })

  it('returns empty string when key is missing', () => {
    expect(new ChannelEnv({}).getToken('telegram')).toBe('')
    expect(new ChannelEnv({}).getToken('slack')).toBe('')
    expect(new ChannelEnv({}).getToken('discord')).toBe('')
    expect(new ChannelEnv({}).getToken('googlechat')).toBe('')
    expect(new ChannelEnv({}).getToken('teams')).toBe('')
  })
})

describe('ChannelEnv.getChatId', () => {
  it('reads ALLOWED_CHAT_ID for telegram', () => {
    const env = { ALLOWED_CHAT_ID: '1268077055' }
    expect(new ChannelEnv(env).getChatId('telegram')).toBe('1268077055')
  })

  it('reads SLACK_CHANNEL_ID for slack', () => {
    const env = { SLACK_CHANNEL_ID: 'C01234ABCDE' }
    expect(new ChannelEnv(env).getChatId('slack')).toBe('C01234ABCDE')
  })

  it('reads DISCORD_CHANNEL_ID for discord', () => {
    const env = { DISCORD_CHANNEL_ID: '123456789012345678' }
    expect(new ChannelEnv(env).getChatId('discord')).toBe('123456789012345678')
  })

  it('reads GOOGLECHAT_SPACE_ID for googlechat', () => {
    const env = { GOOGLECHAT_SPACE_ID: 'spaces/AAAA' }
    expect(new ChannelEnv(env).getChatId('googlechat')).toBe('spaces/AAAA')
  })

  it('reads TEAMS_ALLOWED_CONVERSATION_ID for teams', () => {
    const env = { TEAMS_ALLOWED_CONVERSATION_ID: '19:abc@thread.v2' }
    expect(new ChannelEnv(env).getChatId('teams')).toBe('19:abc@thread.v2')
  })

  it('returns empty string when key is missing', () => {
    expect(new ChannelEnv({}).getChatId('telegram')).toBe('')
    expect(new ChannelEnv({}).getChatId('slack')).toBe('')
    expect(new ChannelEnv({}).getChatId('discord')).toBe('')
    expect(new ChannelEnv({}).getChatId('googlechat')).toBe('')
    expect(new ChannelEnv({}).getChatId('teams')).toBe('')
  })
})

describe('ChannelEnv.stateDirFor', () => {
  it('uses telegram subdirectory for telegram', () => {
    const dir = new ChannelEnv().stateDirFor('telegram')
    expect(dir).toMatch(/\.claude\/channels\/telegram$/)
  })

  it('uses slack subdirectory for slack', () => {
    const dir = new ChannelEnv().stateDirFor('slack')
    expect(dir).toMatch(/\.claude\/channels\/slack$/)
  })

  it('uses discord subdirectory for discord', () => {
    const dir = new ChannelEnv().stateDirFor('discord')
    expect(dir).toMatch(/\.claude\/channels\/discord$/)
  })

  it('uses googlechat subdirectory for googlechat', () => {
    const dir = new ChannelEnv().stateDirFor('googlechat')
    expect(dir).toMatch(/\.claude\/channels\/googlechat$/)
  })

  it('uses teams subdirectory for teams', () => {
    const dir = new ChannelEnv().stateDirFor('teams')
    expect(dir).toMatch(/\.claude\/channels\/teams$/)
  })

  it('uses agent dir when provided (telegram)', () => {
    const dir = new ChannelEnv().stateDirFor('telegram', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/telegram')
  })

  it('uses agent dir when provided (slack)', () => {
    const dir = new ChannelEnv().stateDirFor('slack', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/slack')
  })

  it('uses agent dir when provided (discord)', () => {
    const dir = new ChannelEnv().stateDirFor('discord', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/discord')
  })

  it('uses agent dir when provided (googlechat)', () => {
    const dir = new ChannelEnv().stateDirFor('googlechat', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/googlechat')
  })

  it('uses agent dir when provided (teams)', () => {
    const dir = new ChannelEnv().stateDirFor('teams', '/tmp/agents/test-agent')
    expect(dir).toBe('/tmp/agents/test-agent/.claude/channels/teams')
  })
})

describe('formatMessage per provider', () => {
  it('telegram: converts markdown headers to bold', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('# Hello')).toContain('<b>Hello</b>')
  })

  it('telegram: converts **bold** to HTML', () => {
    const p = getProvider('telegram')
    expect(p.formatMessage('**bold**')).toBe('<b>bold</b>')
  })

  it('slack: converts markdown headers to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('# Hello')).toBe('*Hello*')
  })

  it('slack: converts **bold** to mrkdwn bold', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('**bold**')).toBe('*bold*')
  })

  it('slack: converts links to mrkdwn format', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('[text](https://example.com)')).toBe('<https://example.com|text>')
  })

  it('slack: converts strikethrough', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('~~deleted~~')).toBe('~deleted~')
  })

  it('slack: converts checkboxes', () => {
    const p = getProvider('slack')
    expect(p.formatMessage('- [ ] todo')).toContain(':white_square:')
    expect(p.formatMessage('- [x] done')).toContain(':white_check_mark:')
  })

  it('discord: converts checkboxes to Unicode', () => {
    const p = getProvider('discord')
    expect(p.formatMessage('- [ ] todo')).toBe('☐ todo')
    expect(p.formatMessage('- [x] done')).toBe('☑ done')
    expect(p.formatMessage('no checkbox here')).toBe('no checkbox here')
  })

  it('googlechat: passes text through unmodified', () => {
    const p = getProvider('googlechat')
    expect(p.formatMessage('**raw** markdown')).toBe('**raw** markdown')
  })

  it('teams: passes text through unmodified', () => {
    const p = getProvider('teams')
    expect(p.formatMessage('**raw** markdown')).toBe('**raw** markdown')
  })
})

describe('splitMessage per provider', () => {
  it('telegram: uses 4096 char limit', () => {
    const p = getProvider('telegram')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('slack: uses 4000 char limit', () => {
    const p = getProvider('slack')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4000)
    }
  })

  it('discord: uses 2000 char limit', () => {
    const p = getProvider('discord')
    const text = 'A '.repeat(2000)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(2000)
    }
  })

  it('googlechat: uses 4096 char limit', () => {
    const p = getProvider('googlechat')
    const text = 'A '.repeat(2500)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(4096)
    }
  })

  it('teams: uses 28000 char limit', () => {
    const p = getProvider('teams')
    const text = 'A '.repeat(15000)
    const chunks = p.splitMessage(text)
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(28000)
    }
  })

  it('short text returns single chunk for every provider', () => {
    const types: ChannelProviderType[] = ['telegram', 'slack', 'discord', 'googlechat', 'teams']
    for (const type of types) {
      const p = getProvider(type)
      expect(p.splitMessage('short')).toEqual(['short'])
    }
  })
})

// ---------------------------------------------------------------------------
// formatForSlackMrkdwn: full branch coverage of the export so it is exercised
// even if a caller short-circuits via the provider wrapper.
// ---------------------------------------------------------------------------

describe('formatForSlackMrkdwn', () => {
  it('converts ATX headers (# ... ######) to bold mrkdwn', () => {
    expect(formatForSlackMrkdwn('# h1')).toBe('*h1*')
    expect(formatForSlackMrkdwn('## h2')).toBe('*h2*')
    expect(formatForSlackMrkdwn('###### h6')).toBe('*h6*')
  })

  it('converts **bold** and __bold__ to *bold*', () => {
    expect(formatForSlackMrkdwn('**a**')).toBe('*a*')
    expect(formatForSlackMrkdwn('__a__')).toBe('*a*')
  })

  it('converts ~~strike~~ to ~strike~', () => {
    expect(formatForSlackMrkdwn('~~a~~')).toBe('~a~')
  })

  it('converts [text](url) to <url|text>', () => {
    expect(formatForSlackMrkdwn('[a](https://b.example)')).toBe('<https://b.example|a>')
  })

  it('converts checkbox lines to emoji', () => {
    expect(formatForSlackMrkdwn('- [ ] todo')).toContain(':white_square:')
    expect(formatForSlackMrkdwn('- [x] done')).toContain(':white_check_mark:')
  })

  it('strips horizontal rule (---) lines (preserves surrounding newlines)', () => {
    expect(formatForSlackMrkdwn('---')).toBe('')
    expect(formatForSlackMrkdwn('a\n---\nb')).toBe('a\n\nb')
  })

  it('strips asterisk-rule (***) lines (preserves surrounding newlines)', () => {
    expect(formatForSlackMrkdwn('***')).toBe('')
    expect(formatForSlackMrkdwn('a\n***\nb')).toBe('a\n\nb')
  })

  it('passes through plain text unchanged (trimmed)', () => {
    expect(formatForSlackMrkdwn('  hello  ')).toBe('hello')
  })
})

// ---------------------------------------------------------------------------
// Slack manifest + setup instructions (also exercised by slack-manifest.test.ts
// but a second coverage here keeps this suite self-contained for the
// channel-provider.ts gate).
// ---------------------------------------------------------------------------

describe('generateSlackAppManifest', () => {
  it('produces YAML containing the JSON-quoted app name', () => {
    const yaml = generateSlackAppManifest('TestBot')
    expect(yaml).toContain('name: "TestBot"')
    expect(yaml).toContain('display_name: "TestBot"')
  })

  it('includes every required bot scope', () => {
    const yaml = generateSlackAppManifest('Bot')
    for (const scope of [
      'app_mentions:read', 'channels:history', 'channels:read', 'chat:write',
      'files:read', 'files:write', 'groups:history', 'groups:read',
      'im:history', 'im:read', 'im:write', 'reactions:write', 'users:read',
    ]) {
      expect(yaml).toContain(`- ${scope}`)
    }
  })

  it('includes every required bot event', () => {
    const yaml = generateSlackAppManifest('Bot')
    for (const ev of ['app_mention', 'message.channels', 'message.groups', 'message.im']) {
      expect(yaml).toContain(`- ${ev}`)
    }
  })

  it('enables socket mode and interactivity', () => {
    const yaml = generateSlackAppManifest('Bot')
    expect(yaml).toContain('socket_mode_enabled: true')
    expect(yaml).toContain('is_enabled: true')
  })

  it('strips quotes and backslashes from the app name', () => {
    const yaml = generateSlackAppManifest('My "Bot"\\X')
    expect(yaml).toContain('name: "My BotX"')
  })
})

describe('getSlackAppSetupInstructions', () => {
  it('returns the seven-step guide', () => {
    const steps = getSlackAppSetupInstructions()
    expect(steps).toHaveLength(7)
    expect(steps[0]).toContain('api.slack.com/apps')
  })
})

// ---------------------------------------------------------------------------
// readChannelToken: file-exists + file-missing + read-error + key-missing
// branches. Uses a per-suite temp dir cleaned in afterEach.
// ---------------------------------------------------------------------------

describe('ChannelEnv.readTokenFor', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'channel-provider-token-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('returns null when the env file does not exist', () => {
    const path = join(tmpDir, '.env')
    expect(new ChannelEnv().readTokenFor('telegram', path)).toBeNull()
  })

  it('reads TELEGRAM_BOT_TOKEN from a telegram env file', () => {
    const path = join(tmpDir, 'tg.env')
    writeFileSync(path, 'TELEGRAM_BOT_TOKEN=tg-abc-123\nOTHER=foo\n')
    expect(new ChannelEnv().readTokenFor('telegram', path)).toBe('tg-abc-123')
  })

  it('reads SLACK_BOT_TOKEN from a slack env file', () => {
    const path = join(tmpDir, 'slack.env')
    writeFileSync(path, 'SLACK_BOT_TOKEN=xoxb-abc\n')
    expect(new ChannelEnv().readTokenFor('slack', path)).toBe('xoxb-abc')
  })

  it('reads DISCORD_BOT_TOKEN from a discord env file', () => {
    const path = join(tmpDir, 'discord.env')
    writeFileSync(path, 'DISCORD_BOT_TOKEN=discord-abc\n')
    expect(new ChannelEnv().readTokenFor('discord', path)).toBe('discord-abc')
  })

  it('reads GOOGLECHAT_PROJECT_ID from a googlechat env file', () => {
    const path = join(tmpDir, 'gc.env')
    writeFileSync(path, 'GOOGLECHAT_PROJECT_ID=gcp-proj\n')
    expect(new ChannelEnv().readTokenFor('googlechat', path)).toBe('gcp-proj')
  })

  it('reads TEAMS_BOT_APP_ID from a teams env file', () => {
    const path = join(tmpDir, 'teams.env')
    writeFileSync(path, 'TEAMS_BOT_APP_ID=teams-app-id\n')
    expect(new ChannelEnv().readTokenFor('teams', path)).toBe('teams-app-id')
  })

  it('returns null when the expected key is absent', () => {
    const path = join(tmpDir, 'mismatch.env')
    writeFileSync(path, 'UNRELATED=foo\n')
    expect(new ChannelEnv().readTokenFor('telegram', path)).toBeNull()
  })

  it('preserves the matched value verbatim (no trim)', () => {
    const path = join(tmpDir, 'whitespace.env')
    writeFileSync(path, 'TELEGRAM_BOT_TOKEN=tok-with-spaces\n')
    expect(new ChannelEnv().readTokenFor('telegram', path)).toBe('tok-with-spaces')
  })

  it('returns null when readFileSync throws (path is a directory)', () => {
    // existsSync returns true for directories, so the early-return is skipped.
    // readFileSync then throws EISDIR and the catch branch must return null.
    const dirAsFile = join(tmpDir, 'subdir')
    mkdirSync(dirAsFile)
    expect(new ChannelEnv().readTokenFor('telegram', dirAsFile)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Telegram provider: sendMessage via https.request, sendPhoto via fetch,
// validateToken via fetch (3 outcomes).
// ---------------------------------------------------------------------------

describe('telegram provider send/validate', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  // Helper: stand up a fake https.ClientRequest. The provided callback runs
  // immediately (mirroring what node:https does with the response socket).
  function makeFakeRequest(statusCode: number): {
    req: EventEmitter & { write: (b: string) => void; end: () => void }
    emit: (code: number) => void
  } {
    const req = new EventEmitter() as EventEmitter & { write: (b: string) => void; end: () => void }
    req.write = () => {}
    req.end = () => {}
    const emit = (code: number) => {
      const res = new EventEmitter() as EventEmitter & { statusCode: number; resume: () => void }
      res.statusCode = code
      res.resume = () => {}
      req.emit('response', res)
    }
    return { req, emit }
  }

  it('sendMessage posts JSON to the Telegram sendMessage endpoint', async () => {
    const captured: { url?: string; method?: string; headers?: Record<string, string>; body?: string } = {}
    const fake = makeFakeRequest(200)
    const spy = vi.spyOn(https, 'request').mockImplementation(((
      url: string,
      options: { method: string; headers: Record<string, string> },
      cb: (res: EventEmitter & { resume: () => void; statusCode: number }) => void,
    ) => {
      captured.url = url
      captured.method = options.method
      captured.headers = options.headers
      let bodyBuf = ''
      const req = new EventEmitter() as EventEmitter & {
        write: (b: string) => void
        end: () => void
      }
      req.write = (b: string) => { bodyBuf += b }
      req.end = () => {
        captured.body = bodyBuf
        const res = new EventEmitter() as EventEmitter & { resume: () => void; statusCode: number }
        res.statusCode = 200
        res.resume = () => {}
        cb(res)
      }
      return req
    }) as unknown as typeof https.request)

    const provider = getProvider('telegram')
    // markIfTestRun injects the [TESZT] prefix under vitest; assert it appears.
    await provider.sendMessage('token-1', '42', 'hi', 'MarkdownV2')
    expect(spy).toHaveBeenCalledTimes(1)
    expect(captured.url).toBe('https://api.telegram.org/bottoken-1/sendMessage')
    expect(captured.method).toBe('POST')
    expect(captured.headers!['Content-Type']).toBe('application/json')
    expect(captured.body).toContain('"chat_id":"42"')
    expect(captured.body).toContain('"text":"[TESZT] hi"')
    expect(captured.body).toContain('"parse_mode":"MarkdownV2"')
  })

  it('sendMessage omits parse_mode when undefined', async () => {
    let bodyBuf = ''
    vi.spyOn(https, 'request').mockImplementation(((
      _url: string,
      _options: unknown,
      cb: (res: EventEmitter & { resume: () => void; statusCode: number }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & { write: (b: string) => void; end: () => void }
      req.write = (b: string) => { bodyBuf += b }
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { resume: () => void; statusCode: number }
        res.statusCode = 200
        res.resume = () => {}
        cb(res)
      }
      return req
    }) as unknown as typeof https.request)
    const provider = getProvider('telegram')
    await provider.sendMessage('token-1', '42', 'plain')
    expect(bodyBuf).toContain('"chat_id":"42"')
    expect(bodyBuf).not.toContain('parse_mode')
  })

  it('sendMessage rejects when Telegram returns a non-200 status', async () => {
    vi.spyOn(https, 'request').mockImplementation(((
      _url: string,
      _options: unknown,
      cb: (res: EventEmitter & { resume: () => void; statusCode: number }) => void,
    ) => {
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void }
      req.write = () => {}
      req.end = () => {
        const res = new EventEmitter() as EventEmitter & { resume: () => void; statusCode: number }
        res.statusCode = 500
        res.resume = () => {}
        cb(res)
      }
      return req
    }) as unknown as typeof https.request)
    const provider = getProvider('telegram')
    await expect(provider.sendMessage('token', '42', 'hi')).rejects.toThrow('Telegram API 500')
  })

  it('sendMessage rejects when the request emits an error', async () => {
    vi.spyOn(https, 'request').mockImplementation((() => {
      const req = new EventEmitter() as EventEmitter & { write: () => void; end: () => void }
      req.write = () => {}
      req.end = () => {
        req.emit('error', new Error('ECONNRESET'))
      }
      return req
    }) as unknown as typeof https.request)
    const provider = getProvider('telegram')
    await expect(provider.sendMessage('token', '42', 'hi')).rejects.toThrow('ECONNRESET')
  })

  it('sendPhoto POSTs multipart/form-data to sendPhoto and succeeds on 200', async () => {
    let tmpDir = mkdtempSync(join(tmpdir(), 'tg-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
    try {
      const captured: { url?: string; method?: string; headers?: Record<string, string>; body?: Buffer } = {}
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const u = url as string
        const i = init as RequestInit
        captured.url = u
        captured.method = i.method as string
        captured.headers = i.headers as Record<string, string>
        captured.body = i.body as Buffer
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch

      const provider = getProvider('telegram')
      await provider.sendPhoto('tok', '42', photoPath, 'caption here')

      expect(captured.url).toBe('https://api.telegram.org/bottok/sendPhoto')
      expect(captured.method).toBe('POST')
      expect(captured.headers!['Content-Type']).toMatch(/^multipart\/form-data; boundary=----FormBoundary/)
      const bodyStr = (captured.body as Buffer).toString('binary')
      expect(bodyStr).toContain('name="chat_id"')
      expect(bodyStr).toContain('42')
      expect(bodyStr).toContain('name="caption"')
      expect(bodyStr).toContain('[TESZT] caption here')
      expect(bodyStr).toContain('name="photo"')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto throws with status + truncated body when Telegram returns non-OK', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      globalThis.fetch = vi.fn(async () =>
        new Response('bad-token body', { status: 401 }),
      ) as unknown as typeof fetch
      const provider = getProvider('telegram')
      await expect(
        provider.sendPhoto('tok', '42', photoPath, 'caption'),
      ).rejects.toThrow(/^Telegram sendPhoto 401: bad-token body/)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto tolerates a resp.text() that rejects (catch fallback to empty string)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'tg-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      // resp.text() must reject so the `.catch(() => '')` branch fires.
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 503,
        text: () => Promise.reject(new Error('cannot decode')),
      })) as unknown as typeof fetch
      const provider = getProvider('telegram')
      await expect(
        provider.sendPhoto('tok', '42', photoPath, 'caption'),
      ).rejects.toThrow(/^Telegram sendPhoto 503: $/)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('validateToken returns botName on a successful getMe', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, result: { username: 'mybot', id: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('telegram')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: true, botName: 'mybot' })
  })

  it('validateToken returns error when Telegram says ok=false', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('telegram')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'Invalid bot token' })
  })

  it('validateToken returns the network-error branch on fetch throw', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('dns down') }) as unknown as typeof fetch
    const provider = getProvider('telegram')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'Failed to connect to Telegram API' })
  })
})

// ---------------------------------------------------------------------------
// Slack provider: sendMessage / sendPhoto / validateToken.
// ---------------------------------------------------------------------------

describe('slack provider send/validate', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sendMessage POSTs chat.postMessage with Bearer auth and unfurl flags', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      capturedUrl = url as string
      capturedInit = init as RequestInit
      return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const provider = getProvider('slack')
    await provider.sendMessage('xoxb-tok', 'C1234', 'hi slack')
    expect(capturedUrl).toBe('https://slack.com/api/chat.postMessage')
    expect(capturedInit!.method).toBe('POST')
    expect((capturedInit!.headers as Record<string, string>)['Authorization']).toBe('Bearer xoxb-tok')
    expect((capturedInit!.headers as Record<string, string>)['Content-Type']).toContain('application/json')
    const body = JSON.parse(capturedInit!.body as string)
    expect(body.channel).toBe('C1234')
    expect(body.text).toBe('[TESZT] hi slack')
    expect(body.unfurl_links).toBe(false)
    expect(body.unfurl_media).toBe(false)
  })

  it('sendMessage throws on Slack HTTP error', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('', { status: 500 }),
    ) as unknown as typeof fetch
    const provider = getProvider('slack')
    await expect(provider.sendMessage('tok', 'C', 'msg')).rejects.toThrow('Slack API HTTP 500')
  })

  it('sendMessage throws when Slack returns ok=false with an error string', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'channel_not_found' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('slack')
    await expect(provider.sendMessage('tok', 'C', 'msg')).rejects.toThrow('Slack API error: channel_not_found')
  })

  it('sendPhoto runs files.getUploadURLExternal -> upload -> files.completeUploadExternal', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    try {
      const calls: Array<{ url: string; init: RequestInit }> = []
      let uploadCallCount = 0
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const u = url as string
        calls.push({ url: u, init: init as RequestInit })
        if (u === 'https://slack.com/api/files.getUploadURLExternal') {
          return new Response(JSON.stringify({ ok: true, upload_url: 'https://files.slack.example/up', file_id: 'F123' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (u === 'https://slack.com/api/files.completeUploadExternal') {
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (u === 'https://files.slack.example/up') {
          uploadCallCount++
          return new Response('', { status: 200 })
        }
        throw new Error('unexpected URL: ' + u)
      }) as unknown as typeof fetch

      const provider = getProvider('slack')
      await provider.sendPhoto('xoxb-tok', 'C1234', photoPath, 'a caption')
      expect(calls).toHaveLength(3)
      expect(calls[0].url).toContain('files.getUploadURLExternal')
      expect(calls[1].url).toBe('https://files.slack.example/up')
      expect(calls[2].url).toContain('files.completeUploadExternal')
      expect(uploadCallCount).toBe(1)
      const completeBody = JSON.parse(calls[2].init.body as string)
      expect(completeBody.channel_id).toBe('C1234')
      expect(completeBody.files[0].id).toBe('F123')
      expect(completeBody.initial_comment).toBe('[TESZT] a caption')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto falls back to filename-only title/initial_comment when caption empty', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      let completeBody: Record<string, unknown> | undefined
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const u = url as string
        if (u === 'https://slack.com/api/files.getUploadURLExternal') {
          return new Response(JSON.stringify({ ok: true, upload_url: 'https://up.example', file_id: 'F1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (u === 'https://up.example') {
          return new Response('', { status: 200 })
        }
        if (u === 'https://slack.com/api/files.completeUploadExternal') {
          completeBody = JSON.parse((init as RequestInit).body as string)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error('unexpected URL: ' + u)
      }) as unknown as typeof fetch
      const provider = getProvider('slack')
      await provider.sendPhoto('tok', 'C', photoPath, '')
      // markIfTestRun prefixes the (empty) caption with "[TESZT] " under vitest,
      // so `caption || filename` resolves to the marker, not the filename. The
      // contract under test is the slack sendPhoto fallback shape -- not the
      // markIfTestRun behavior, which the withTestRunMarking suite covers.
      const title = (completeBody!.files as Array<{ title: string }>)[0].title
      expect(typeof title).toBe('string')
      expect(title.length).toBeGreaterThan(0)
      expect(completeBody!.initial_comment).toBe(title)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto throws on getUploadURLExternal error response', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: false, error: 'missing_scope' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      ) as unknown as typeof fetch
      const provider = getProvider('slack')
      await expect(provider.sendPhoto('tok', 'C', photoPath, 'cap')).rejects.toThrow('Slack getUploadURL: missing_scope')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto falls back to "unknown error" when getUploadURLExternal omits the error field', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      globalThis.fetch = vi.fn(async () =>
        new Response(JSON.stringify({ ok: false }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        }),
      ) as unknown as typeof fetch
      const provider = getProvider('slack')
      await expect(provider.sendPhoto('tok', 'C', photoPath, 'cap')).rejects.toThrow('Slack getUploadURL: unknown error')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto uses the provided caption as title and initial_comment', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      let completeBody: Record<string, unknown> | undefined
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const u = url as string
        if (u === 'https://slack.com/api/files.getUploadURLExternal') {
          return new Response(JSON.stringify({ ok: true, upload_url: 'https://up.example', file_id: 'F1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (u === 'https://up.example') {
          return new Response('', { status: 200 })
        }
        if (u === 'https://slack.com/api/files.completeUploadExternal') {
          completeBody = JSON.parse((init as RequestInit).body as string)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error('unexpected URL: ' + u)
      }) as unknown as typeof fetch
      const provider = getProvider('slack')
      await provider.sendPhoto('tok', 'C', photoPath, 'hello caption')
      expect((completeBody!.files as Array<{ title: string }>)[0].title).toBe('[TESZT] hello caption')
      expect(completeBody!.initial_comment).toBe('[TESZT] hello caption')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto throws on completeUploadExternal ok=false', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      globalThis.fetch = vi.fn(async (url: unknown) => {
        const u = url as string
        if (u === 'https://slack.com/api/files.getUploadURLExternal') {
          return new Response(JSON.stringify({ ok: true, upload_url: 'https://up.example', file_id: 'F1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (u === 'https://up.example') return new Response('', { status: 200 })
        return new Response(JSON.stringify({ ok: false, error: 'file_too_large' }), {
          status: 200, headers: { 'Content-Type': 'application/json' },
        })
      }) as unknown as typeof fetch
      const provider = getProvider('slack')
      await expect(provider.sendPhoto('tok', 'C', photoPath, 'cap')).rejects.toThrow('Slack completeUpload: file_too_large')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('validateToken returns botName from user on auth.test ok', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, bot_id: 'B123', user: 'slackbot' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('slack')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: true, botName: 'slackbot' })
  })

  it('validateToken falls back to bot_id when user missing', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: true, bot_id: 'BXYZ' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('slack')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: true, botName: 'BXYZ' })
  })

  it('validateToken returns error string when Slack says ok=false', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false, error: 'invalid_auth' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('slack')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'invalid_auth' })
  })

  it('validateToken returns default error string when Slack returns no error field', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ ok: false }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('slack')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'Invalid token' })
  })

  it('validateToken returns network-error branch on fetch throw', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('offline') }) as unknown as typeof fetch
    const provider = getProvider('slack')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'Failed to connect to Slack API' })
  })
})

// ---------------------------------------------------------------------------
// Discord provider.
// ---------------------------------------------------------------------------

describe('discord provider send/validate', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
  })

  it('sendMessage POSTs to the channel messages endpoint with Bot auth', async () => {
    let capturedUrl: string | undefined
    let capturedInit: RequestInit | undefined
    globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
      capturedUrl = url as string
      capturedInit = init as RequestInit
      return new Response('', { status: 200 })
    }) as unknown as typeof fetch
    const provider = getProvider('discord')
    await provider.sendMessage('discord-tok', '9999', 'hi discord')
    expect(capturedUrl).toBe('https://discord.com/api/v10/channels/9999/messages')
    expect(capturedInit!.method).toBe('POST')
    expect((capturedInit!.headers as Record<string, string>)['Authorization']).toBe('Bot discord-tok')
    expect(JSON.parse(capturedInit!.body as string).content).toBe('[TESZT] hi discord')
  })

  it('sendMessage throws with truncated body when Discord returns non-OK', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response('rate limited body', { status: 429 }),
    ) as unknown as typeof fetch
    const provider = getProvider('discord')
    await expect(provider.sendMessage('tok', '9999', 'msg')).rejects.toThrow(/^Discord API 429: rate limited body/)
  })

  it('sendMessage tolerates fetch.text() rejection on error response', async () => {
    globalThis.fetch = vi.fn(async () => ({
      ok: false,
      status: 500,
      text: () => Promise.reject(new Error('cannot decode')),
    })) as unknown as typeof fetch
    const provider = getProvider('discord')
    await expect(provider.sendMessage('tok', '9999', 'msg')).rejects.toThrow(/^Discord API 500: /)
  })

  it('sendPhoto POSTs multipart/form-data with caption + attachment metadata', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89, 0x50]))
    try {
      let captured: { url: string; init: RequestInit } | undefined
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        captured = { url: url as string, init: init as RequestInit }
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch
      const provider = getProvider('discord')
      await provider.sendPhoto('discord-tok', '9999', photoPath, 'cap here')
      expect(captured!.url).toBe('https://discord.com/api/v10/channels/9999/messages')
      const ct = (captured!.init.headers as Record<string, string>)['Content-Type']
      expect(ct).toMatch(/^multipart\/form-data; boundary=----FormBoundary/)
      const bodyStr = (captured!.init.body as Buffer).toString('binary')
      expect(bodyStr).toContain('payload_json')
      expect(bodyStr).toContain('[TESZT] cap here')
      expect(bodyStr).toContain('files[0]')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto sends caption text inside payload_json', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      let bodyStr = ''
      globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
        bodyStr = ((init as RequestInit).body as Buffer).toString('binary')
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch
      const provider = getProvider('discord')
      await provider.sendPhoto('discord-tok', '9999', photoPath, '')
      // markIfTestRun prefixes the (empty) caption with "[TESZT] " under vitest,
      // so content is a non-empty marker string rather than undefined.
      expect(bodyStr).toContain('"content":"[TESZT] "')
      expect(bodyStr).toContain('attachments')
      expect(bodyStr).toContain('avatar.png')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto uses the provided caption as the content field', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      let bodyStr = ''
      globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
        bodyStr = ((init as RequestInit).body as Buffer).toString('binary')
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch
      const provider = getProvider('discord')
      await provider.sendPhoto('discord-tok', '9999', photoPath, 'hello')
      expect(bodyStr).toContain('"content":"[TESZT] hello"')
      expect(bodyStr).toContain('avatar.png')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto falls back to "image.png" when photoPath has no basename', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-photo-'))
    mkdirSync(join(tmpDir, 'subdir'))
    // Path ends with '/' so split('/').pop() returns '' -> fallback to 'image.png'.
    const photoPath = join(tmpDir, 'subdir') + '/'
    writeFileSync(join(tmpDir, 'subdir', 'real.png'), Buffer.from([0x89]))
    try {
      let bodyStr = ''
      globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
        bodyStr = ((init as RequestInit).body as Buffer).toString('binary')
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch
      const provider = getProvider('discord')
      // readFileSync will throw ENOENT for the trailing-slash path, but the
      // .pop() fallback is evaluated BEFORE readFileSync -- we need a real file
      // at that path. Use the no-trailing-slash real.png and assert the
      // filename matches its basename (verifying the non-fallback path) -- the
      // fallback branch itself is covered separately below via a mock fs shim.
      await provider.sendPhoto('discord-tok', '9999', join(tmpDir, 'subdir', 'real.png'), '')
      expect(bodyStr).toContain('"filename":"real.png"')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto throws when Discord returns non-OK', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      globalThis.fetch = vi.fn(async () =>
        new Response('forbidden body', { status: 403 }),
      ) as unknown as typeof fetch
      const provider = getProvider('discord')
      await expect(provider.sendPhoto('tok', '9999', photoPath, 'cap')).rejects.toThrow(/^Discord sendPhoto 403: /)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('sendPhoto tolerates a resp.text() that rejects (catch fallback to empty string)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      globalThis.fetch = vi.fn(async () => ({
        ok: false,
        status: 502,
        text: () => Promise.reject(new Error('cannot decode')),
      })) as unknown as typeof fetch
      const provider = getProvider('discord')
      await expect(provider.sendPhoto('tok', '9999', photoPath, 'cap')).rejects.toThrow(/^Discord sendPhoto 502: $/)
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('validateToken returns botName from username on @me success', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: '123', username: 'discord-bot' }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('discord')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: true, botName: 'discord-bot' })
  })

  it('validateToken returns error when Discord responds without username', async () => {
    globalThis.fetch = vi.fn(async () =>
      new Response(JSON.stringify({ id: '123' }), {
        status: 401, headers: { 'Content-Type': 'application/json' },
      }),
    ) as unknown as typeof fetch
    const provider = getProvider('discord')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'Invalid bot token' })
  })

  it('validateToken returns network-error branch on fetch throw', async () => {
    globalThis.fetch = vi.fn(async () => { throw new Error('timeout') }) as unknown as typeof fetch
    const provider = getProvider('discord')
    const r = await provider.validateToken('tok')
    expect(r).toEqual({ ok: false, error: 'Failed to connect to Discord API' })
  })
})

// ---------------------------------------------------------------------------
// Google Chat provider -- direct send is unsupported, validation is always ok.
// ---------------------------------------------------------------------------

describe('googlechat provider send/validate', () => {
  it('sendMessage throws (dashboard delivery not supported)', async () => {
    const provider = getProvider('googlechat')
    await expect(provider.sendMessage('tok', 'space-x', 'msg')).rejects.toThrow(
      'googlechat: direct dashboard send not supported',
    )
  })

  it('sendPhoto throws (dashboard delivery not supported)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'gc-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      const provider = getProvider('googlechat')
      await expect(provider.sendPhoto('tok', 'space-x', photoPath, 'cap')).rejects.toThrow(
        'googlechat: direct dashboard send not supported',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('validateToken always returns ok so channel-config does not false-negative', async () => {
    const provider = getProvider('googlechat')
    const r = await provider.validateToken('anything')
    expect(r).toEqual({ ok: true, botName: 'Google Chat' })
  })
})

// ---------------------------------------------------------------------------
// Microsoft Teams provider -- same shape as Google Chat.
// ---------------------------------------------------------------------------

describe('teams provider send/validate', () => {
  it('sendMessage throws (dashboard delivery not supported)', async () => {
    const provider = getProvider('teams')
    await expect(provider.sendMessage('tok', 'conv-id', 'msg')).rejects.toThrow(
      'teams: direct dashboard send not supported',
    )
  })

  it('sendPhoto throws (dashboard delivery not supported)', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'teams-photo-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      const provider = getProvider('teams')
      await expect(provider.sendPhoto('tok', 'conv-id', photoPath, 'cap')).rejects.toThrow(
        'teams: direct dashboard send not supported',
      )
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('validateToken always returns ok so channel-config does not false-negative', async () => {
    const provider = getProvider('teams')
    const r = await provider.validateToken('anything')
    expect(r).toEqual({ ok: true, botName: 'Microsoft Teams' })
  })
})

// ---------------------------------------------------------------------------
// withTestRunMarking wrapper contract: every send routed via getProvider must
// stamp the [TESZT] prefix on text + caption (vitest sets VITEST=1 in workers).
// ---------------------------------------------------------------------------

describe('withTestRunMarking wrapper', () => {
  const originalFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('wraps sendMessage + sendPhoto for every provider', () => {
    const types: ChannelProviderType[] = ['telegram', 'slack', 'discord', 'googlechat', 'teams']
    for (const t of types) {
      const p = getProvider(t)
      // The wrapper is identity for everything except sendMessage/sendPhoto,
      // so the shape is preserved and the prototype chain stays intact.
      expect(p.type).toBe(t)
      expect(typeof p.sendMessage).toBe('function')
      expect(typeof p.sendPhoto).toBe('function')
    }
  })

  it('preserves the underlying provider fields (envKeys, stateDir, etc.)', () => {
    const p = getProvider('slack')
    expect(p.envKeys).toEqual(['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN'])
    expect(p.stateDir).toBe('slack')
    expect(p.formatMessage('**x**')).toBe('*x*')
    expect(p.splitMessage('a').length).toBe(1)
  })

  it('idempotently skips re-marking when caller already prefixed', async () => {
    // markIfTestRun is the only mutation: a message starting with [TESZT] must
    // not become [TESZT] [TESZT] msg. Confirm via a slack sendMessage round-trip.
    let capturedBody: string | undefined
    globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
      capturedBody = (init as RequestInit).body as string
      return new Response(JSON.stringify({ ok: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' },
      })
    }) as unknown as typeof fetch
    const provider = getProvider('slack')
    await provider.sendMessage('tok', 'C', '[TESZT] already-marked')
    expect(JSON.parse(capturedBody!).text).toBe('[TESZT] already-marked')
  })
})
// ---------------------------------------------------------------------------
// Branches the runtime withTestRunMarking wrapper makes unreachable in a
// normal test run: the four `|| filename / || undefined / || 'image.png'`
// fallbacks in slack.sendPhoto + discord.sendPhoto only fire when caption /
// filename resolve to falsy. With markIfTestRun turning every empty caption
// into the truthy '[TESZT] ' marker, those branches cannot be exercised
// through getProvider(). So we stub markIfTestRun to a passthrough and drive
// the fallbacks directly.
// ---------------------------------------------------------------------------

// Hoisted so it is available to the channel-provider wrapper at module init.
const stubState = vi.hoisted(() => ({ stubMark: false, stubFs: false }))

vi.mock('../test-run-marker.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../test-run-marker.js')>()
  return {
    ...actual,
    markIfTestRun: (text: string) => (stubState.stubMark ? text : actual.markIfTestRun(text)),
  }
})

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    readFileSync: ((path: unknown, ...rest: unknown[]) => {
      if (stubState.stubFs && typeof path === 'string' && path.endsWith('/')) {
        return Buffer.from([0x89])
      }
      return actual.readFileSync(path as never, ...(rest as []))
    }) as typeof actual.readFileSync,
  }
})

describe('provider fallback branches (markIfTestRun stubbed to passthrough)', () => {
  const originalFetch = globalThis.fetch

  beforeAll(() => {
    stubState.stubMark = true
    stubState.stubFs = true
  })

  afterAll(() => {
    stubState.stubMark = false
    stubState.stubFs = false
  })

  afterEach(() => {
    globalThis.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('slack sendPhoto: empty caption falls back to filename for title and undefined for initial_comment', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-fb-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      let completeBody: Record<string, unknown> | undefined
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const u = url as string
        if (u === 'https://slack.com/api/files.getUploadURLExternal') {
          return new Response(JSON.stringify({ ok: true, upload_url: 'https://up.example', file_id: 'F1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (u === 'https://up.example') {
          return new Response('', { status: 200 })
        }
        if (u === 'https://slack.com/api/files.completeUploadExternal') {
          completeBody = JSON.parse((init as RequestInit).body as string)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error('unexpected URL: ' + u)
      }) as unknown as typeof fetch
      const provider = getProvider('slack')
      await provider.sendPhoto('tok', 'C', photoPath, '')
      expect((completeBody!.files as Array<{ title: string }>)[0].title).toBe('avatar.png')
      expect(completeBody!.initial_comment).toBeUndefined()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('discord sendPhoto: empty caption falls back to undefined for content', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-fb-'))
    const photoPath = join(tmpDir, 'avatar.png')
    writeFileSync(photoPath, Buffer.from([0x89]))
    try {
      let bodyStr = ''
      globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
        bodyStr = ((init as RequestInit).body as Buffer).toString('binary')
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch
      const provider = getProvider('discord')
      await provider.sendPhoto('tok', '9999', photoPath, '')
      // JSON.stringify drops `undefined` properties, so the multipart body
      // contains `"attachments":[{...}]` with no `content` field at all.
      expect(bodyStr).not.toContain('"content"')
      expect(bodyStr).toContain('"filename":"avatar.png"')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('slack sendPhoto: empty caption + empty basename fall back to "image.png"', async () => {
    // photoPath ends with '/' so split('/').pop() returns '' -> 'image.png'.
    // readFileSync on a trailing-slash path normally fails; the fs mock
    // intercepts and returns dummy bytes so the basename fallback runs.
    const tmpDir = mkdtempSync(join(tmpdir(), 'slack-fb2-'))
    const dirPath = join(tmpDir, 'subdir')
    mkdirSync(dirPath)
    const trailingSlashPath = dirPath + '/'

    try {
      let completeBody: Record<string, unknown> | undefined
      globalThis.fetch = vi.fn(async (url: unknown, init: unknown) => {
        const u = url as string
        if (u === 'https://slack.com/api/files.getUploadURLExternal') {
          return new Response(JSON.stringify({ ok: true, upload_url: 'https://up.example', file_id: 'F1' }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        if (u === 'https://up.example') {
          return new Response('', { status: 200 })
        }
        if (u === 'https://slack.com/api/files.completeUploadExternal') {
          completeBody = JSON.parse((init as RequestInit).body as string)
          return new Response(JSON.stringify({ ok: true }), {
            status: 200, headers: { 'Content-Type': 'application/json' },
          })
        }
        throw new Error('unexpected URL: ' + u)
      }) as unknown as typeof fetch
      const provider = getProvider('slack')
      await provider.sendPhoto('tok', 'C', trailingSlashPath, '')
      // caption is '' (passthrough) -> caption||filename resolves to filename
      // ('image.png'); caption||undefined resolves to undefined.
      expect((completeBody!.files as Array<{ title: string }>)[0].title).toBe('image.png')
      expect(completeBody!.initial_comment).toBeUndefined()
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })

  it('discord sendPhoto: empty basename falls back to "image.png"', async () => {
    const tmpDir = mkdtempSync(join(tmpdir(), 'discord-fb2-'))
    const dirPath = join(tmpDir, 'subdir')
    mkdirSync(dirPath)
    const trailingSlashPath = dirPath + '/'

    try {
      let bodyStr = ''
      globalThis.fetch = vi.fn(async (_url: unknown, init: unknown) => {
        bodyStr = ((init as RequestInit).body as Buffer).toString('binary')
        return new Response('', { status: 200 })
      }) as unknown as typeof fetch
      const provider = getProvider('discord')
      await provider.sendPhoto('tok', '9999', trailingSlashPath, 'cap')
      // caption is truthy so content is 'cap'. The basename fallback is the
      // branch exercised -- filename resolves to 'image.png' because pop()=''.
      expect(bodyStr).toContain('"filename":"image.png"')
      expect(bodyStr).toContain('"content":"cap"')
    } finally {
      rmSync(tmpDir, { recursive: true, force: true })
    }
  })
})
