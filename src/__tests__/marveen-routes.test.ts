// 100% coverage suite for src/web/routes/marveen.ts.
//
// The SUT is the dispatcher for:
//   GET  /api/marveen            -> identity + brand + owner + channels + ...
//   PUT  /api/marveen            -> { ok: true, readonly: true }  (intentionally)
//   POST /api/marveen/restart    -> hardRestartMarveenChannels()  (ok / err)
//   GET  /api/marveen/avatar     -> serve the first matching avatar file
//                                    (marveen-avatar.<ext> in store/, then a
//                                    built-in fallback in <webDir>/avatars/,
//                                    else 404)
//   POST /api/marveen/avatar     -> JSON body (gallery) OR multipart upload;
//                                    removes any prior marveen-avatar.<ext>
//                                    before saving the new one.
//
// All collaborators are mocked -- the route never reaches the real DB,
// logger, settings store, channel monitor, Telegram config reads or the
// underlying serveFile/readBody helpers. That lets every branch be driven
// without touching the filesystem at large (only the tmpdir-scoped sandbox
// we own).

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach } from 'vitest'
import type http from 'node:http'
import { Readable } from 'node:stream'
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync,
} from 'node:fs'
import { join, extname } from 'node:path'
import { tmpdir } from 'node:os'

// SANDBOX STORE_DIR -- redirect PROJECT_ROOT/STORE_DIR to a tmpdir so modules
// that freeze those paths at module load (channel-monitor.ts:828
// RESPAWN_STAMP_FILE, channel-coordinator/liveness.ts:30 RESPAWN_STAMP_FILE,
// store-watcher.ts:29 SENSITIVE_NAMES) don't pollute the live ./store/.
// Merged into the existing '../config.js' mock factory below.
const configSandbox = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { tmpdir } = require('node:os') as typeof import('node:os')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { join } = require('node:path') as typeof import('node:path')
  const stamp = `${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`
  const dir = join(tmpdir(), `cfg-${stamp}`)
  return { PROJECT_ROOT: dir, STORE_DIR: join(dir, 'store') }
})


// --- hoisted harness --------------------------------------------------------

const H = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const os = require('node:os') as typeof import('node:os')
  const tmp = fs.mkdtempSync(require('node:path').join(os.tmpdir(), 'marveen-routes-'))
  const projectRoot = require('node:path').join(tmp, 'project')
  const storeDir = require('node:path').join(projectRoot, 'store')
  const webDir = require('node:path').join(tmp, 'web')
  const avatarsDir = require('node:path').join(webDir, 'avatars')
  fs.mkdirSync(projectRoot, { recursive: true })
  fs.mkdirSync(storeDir, { recursive: true })
  fs.mkdirSync(webDir, { recursive: true })
  fs.mkdirSync(avatarsDir, { recursive: true })

  const mkFn = () => vi.fn()
  return {
    tmp,
    projectRoot,
    storeDir,
    webDir,
    avatarsDir,

    // config.js -- only the constants/functions the SUT reads at call time.
    PROJECT_ROOT: projectRoot,
    MAIN_AGENT_ID: 'marveen',
    CHANNEL_PROVIDER: 'telegram',
    currentBotName: vi.fn(() => 'Marveen'),
    currentBrandName: vi.fn(() => 'Marveen'),
    currentOwnerName: vi.fn(() => 'Owner'),
    KANBAN_LABEL_COLORS: ['#3b82f6', '#0ea5e9', '#10b981', '#14b8a6', '#8b5cf6', '#64748b'],

    // logger
    loggerInfo: mkFn(),
    loggerWarn: mkFn(),
    loggerError: mkFn(),
    loggerDebug: mkFn(),

    // settings-store
    getEffectiveSettingValue: vi.fn((key: string) => {
      // Sensible defaults so a brand-new test still produces a well-formed
      // payload -- individual tests override the specific key they want to
      // pin to a custom value.
      const map: Record<string, string | number> = {
        KANBAN_AGING_WARN_H: 24,
        KANBAN_AGING_CAUTION_H: 72,
        KANBAN_AGING_CRITICAL_H: 168,
        KANBAN_AGING_WARN_COLOR: '#c9a000',
        KANBAN_AGING_CAUTION_COLOR: '#d46b00',
        KANBAN_AGING_CRITICAL_COLOR: '#c53030',
        KANBAN_WIP_PLANNED: 0,
        KANBAN_WIP_IN_PROGRESS: 0,
        KANBAN_WIP_TESTING: 0,
        KANBAN_WIP_WAITING: 0,
        KANBAN_WIP_DONE: 0,
        KANBAN_WIP_WARN_PCT: 80,
        KANBAN_WIP_OK_COLOR: '#6b7280',
        KANBAN_WIP_WARN_COLOR: '#c9a000',
        KANBAN_WIP_FULL_COLOR: '#d46b00',
        KANBAN_WIP_OVER_COLOR: '#c53030',
        KANBAN_SWIMLANE_DEFAULT_GROUP: 'none',
        KANBAN_SWIMLANE_SEPARATOR_COLOR: '#222222',
      }
      return key in map ? map[key] : ''
    }),

    // web/telegram.js
    readMarveenTelegramConfig: vi.fn(() => ({ hasTelegram: false, botUsername: '' })),
    readMarveenDiscordConfig: vi.fn(() => ({ hasDiscord: false })),
    readMarveenSlackConfig: vi.fn(() => ({ hasSlack: false })),
    readMarveenGooglechatConfig: vi.fn(() => ({ hasGooglechat: false })),
    readMarveenTeamsConfig: vi.fn(() => ({ hasTeams: false })),
    sendMarveenAvatarChange: vi.fn(async () => undefined),

    // web/channel-monitor.js
    hardRestartMarveenChannels: vi.fn(() => ({ ok: true })),

    // web/agent-config.js -- only readFileOr is read by the SUT.
    readFileOr: vi.fn((_p: string, fallback: string) => fallback),

    // web/multipart.js
    parseMultipart: vi.fn(() => ({ fields: {}, file: null as null | { name: string; data: Buffer; mime: string } })),

    // web/http-helpers.js -- readBody / json / serveFile
    readBody: vi.fn(async () => Buffer.alloc(0)),
    jsonImpl: vi.fn((res: unknown, data: unknown, status = 200) => {
      const r = res as MockRes
      r.statusCode = status
      r.headers['Content-Type'] = 'application/json; charset=utf-8'
      r.body = JSON.stringify(data)
    }),
    serveFileImpl: vi.fn((_req: unknown, res: unknown, p: string, _opts: unknown) => {
      const r = res as MockRes
      r.statusCode = 200
      r.headers['X-Served'] = '1'
      r.headers['X-Path'] = p
    }),

    // web/main-agent.js
    MAIN_CHANNELS_SESSION: 'marveen-channels',

    // src/active-model.js
    readActiveModelFromProjectDir: vi.fn(() => 'claude-opus-4-8[1m]'),
    readContextTokensFromProjectDir: vi.fn(() => 12345),

    // web/auto-restart-store.js
    readAutoRestartConfig: vi.fn(() => ({ enabled: false, intervalSec: 60, maxConsecutiveRestarts: 5, debounceSec: 30 })),
  }
})

// --- vi.mock factories ------------------------------------------------------

vi.mock('../config.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config.js')>()
  return {
    ...actual,
    ...configSandbox,
    PROJECT_ROOT: H.PROJECT_ROOT,
    STORE_DIR: join(H.PROJECT_ROOT, 'store'),
    MAIN_AGENT_ID: H.MAIN_AGENT_ID,
    CHANNEL_PROVIDER: H.CHANNEL_PROVIDER,
    currentBotName: H.currentBotName,
    currentBrandName: H.currentBrandName,
    currentOwnerName: H.currentOwnerName,
    KANBAN_LABEL_COLORS: H.KANBAN_LABEL_COLORS,
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

vi.mock('../db.js', () => ({}))

vi.mock('../web/auth-gate.js', () => ({}))
vi.mock('../web/auth-sessions.js', () => ({}))

vi.mock('../settings-store.js', () => ({
  getEffectiveSettingValue: H.getEffectiveSettingValue,
}))

vi.mock('../web/telegram.js', () => ({
  readMarveenTelegramConfig: H.readMarveenTelegramConfig,
  readMarveenDiscordConfig: H.readMarveenDiscordConfig,
  readMarveenSlackConfig: H.readMarveenSlackConfig,
  readMarveenGooglechatConfig: H.readMarveenGooglechatConfig,
  readMarveenTeamsConfig: H.readMarveenTeamsConfig,
  sendMarveenAvatarChange: H.sendMarveenAvatarChange,
}))

vi.mock('../web/channel-monitor.js', () => ({
  hardRestartMarveenChannels: H.hardRestartMarveenChannels,
}))

vi.mock('../web/agent-config.js', () => ({
  readFileOr: H.readFileOr,
}))

vi.mock('../web/multipart.js', () => ({
  parseMultipart: H.parseMultipart,
}))

// http-helpers: readBody / json / serveFile are mocked; everything else is
// passed through. We deliberately swap in our own implementations so the
// fake res object can observe what the route would have written.
vi.mock('../web/http-helpers.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../web/http-helpers.js')>()
  return {
    ...actual,
    readBody: H.readBody,
    json: H.jsonImpl,
    serveFile: H.serveFileImpl,
  }
})

vi.mock('../web/main-agent.js', () => ({
  MAIN_CHANNELS_SESSION: H.MAIN_CHANNELS_SESSION,
}))

vi.mock('../web/active-model.js', () => ({
  readActiveModelFromProjectDir: H.readActiveModelFromProjectDir,
  readContextTokensFromProjectDir: H.readContextTokensFromProjectDir,
}))

vi.mock('../web/auto-restart-store.js', () => ({
  readAutoRestartConfig: H.readAutoRestartConfig,
}))

// --- imports ----------------------------------------------------------------

const { tryHandleMarveen, buildMarveenIdentityCore } = await import('../web/routes/marveen.js')

// --- helpers ----------------------------------------------------------------

interface MockRes {
  statusCode: number
  headers: Record<string, string | string[]>
  body: string
  writeHead(status: number, headers?: Record<string, string | string[]>): MockRes
  setHeader(k: string, v: string): void
  end(data?: string): void
}

function mkRes(): MockRes {
  return {
    statusCode: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      this.statusCode = status
      if (headers) Object.assign(this.headers, headers)
      return this
    },
    setHeader(k, v) { this.headers[k] = v },
    end(data) { if (data !== undefined) this.body += data },
  }
}

function mkReq(opts: { body?: Buffer; headers?: Record<string, string> }): http.IncomingMessage {
  const payload = opts.body ? [opts.body] : []
  const r = Readable.from(payload) as unknown as http.IncomingMessage & Record<string, unknown>
  r.headers = (opts.headers ?? {}) as http.IncomingHttpHeaders
  return r as http.IncomingMessage
}

async function call(
  method: string,
  path: string,
  opts: { body?: Buffer; headers?: Record<string, string> } = {},
): Promise<{ res: MockRes; handled: boolean; json: () => Record<string, unknown> }> {
  const req = mkReq({ body: opts.body, headers: opts.headers })
  const res = mkRes()
  const ctx = {
    req,
    res: res as unknown as http.ServerResponse,
    path,
    method,
    url: new URL(`http://127.0.0.1:3420${path}`),
    fedPeer: null,
  }
  const handled = await tryHandleMarveen(ctx, H.webDir)
  return { res, handled, json: () => (res.body ? JSON.parse(res.body) : {}) }
}

// --- lifecycle --------------------------------------------------------------

beforeAll(() => {
  process.env.NODE_ENV = 'test'
})

beforeEach(() => {
  // Reset every mock to its baseline so a test starts from a known shape.
  H.loggerInfo.mockReset()
  H.loggerWarn.mockReset()
  H.loggerError.mockReset()
  H.loggerDebug.mockReset()

  H.getEffectiveSettingValue.mockReset()
  H.getEffectiveSettingValue.mockImplementation((key: string) => {
    const map: Record<string, string | number> = {
      KANBAN_AGING_WARN_H: 24,
      KANBAN_AGING_CAUTION_H: 72,
      KANBAN_AGING_CRITICAL_H: 168,
      KANBAN_AGING_WARN_COLOR: '#c9a000',
      KANBAN_AGING_CAUTION_COLOR: '#d46b00',
      KANBAN_AGING_CRITICAL_COLOR: '#c53030',
      KANBAN_WIP_PLANNED: 0,
      KANBAN_WIP_IN_PROGRESS: 0,
      KANBAN_WIP_TESTING: 0,
      KANBAN_WIP_WAITING: 0,
      KANBAN_WIP_DONE: 0,
      KANBAN_WIP_WARN_PCT: 80,
      KANBAN_WIP_OK_COLOR: '#6b7280',
      KANBAN_WIP_WARN_COLOR: '#c9a000',
      KANBAN_WIP_FULL_COLOR: '#d46b00',
      KANBAN_WIP_OVER_COLOR: '#c53030',
      KANBAN_SWIMLANE_DEFAULT_GROUP: 'none',
      KANBAN_SWIMLANE_SEPARATOR_COLOR: '#222222',
    }
    return key in map ? map[key] : ''
  })

  H.readMarveenTelegramConfig.mockReset().mockReturnValue({ hasTelegram: false, botUsername: '' })
  H.readMarveenDiscordConfig.mockReset().mockReturnValue({ hasDiscord: false })
  H.readMarveenSlackConfig.mockReset().mockReturnValue({ hasSlack: false })
  H.readMarveenGooglechatConfig.mockReset().mockReturnValue({ hasGooglechat: false })
  H.readMarveenTeamsConfig.mockReset().mockReturnValue({ hasTeams: false })
  H.sendMarveenAvatarChange.mockReset().mockResolvedValue(undefined)
  H.hardRestartMarveenChannels.mockReset().mockReturnValue({ ok: true })

  // Default: every file-or-fallback returns the fallback so the route always
  // sees an empty CLAUDE.md/SOUL.md/.mcp.json unless a test overrides it.
  H.readFileOr.mockReset().mockImplementation((_p: string, fallback: string) => fallback)

  H.parseMultipart.mockReset().mockReturnValue({ fields: {}, file: null })

  H.readBody.mockReset().mockResolvedValue(Buffer.alloc(0))
  H.jsonImpl.mockReset()
  H.jsonImpl.mockImplementation((res: unknown, data: unknown, status = 200) => {
    const r = res as MockRes
    r.statusCode = status
    r.headers['Content-Type'] = 'application/json; charset=utf-8'
    r.body = JSON.stringify(data)
  })
  H.serveFileImpl.mockReset()
  H.serveFileImpl.mockImplementation((_req: unknown, res: unknown, p: string, _opts: unknown) => {
    const r = res as MockRes
    r.statusCode = 200
    r.headers['X-Served'] = '1'
    r.headers['X-Path'] = p
  })

  H.MAIN_CHANNELS_SESSION = 'marveen-channels'

  H.readActiveModelFromProjectDir.mockReset().mockReturnValue('claude-opus-4-8[1m]')
  H.readContextTokensFromProjectDir.mockReset().mockReturnValue(12345)
  H.readAutoRestartConfig.mockReset().mockReturnValue({ enabled: false, intervalSec: 60, maxConsecutiveRestarts: 5, debounceSec: 30 })

  H.currentBotName.mockReset().mockReturnValue('Marveen')
  H.currentBrandName.mockReset().mockReturnValue('Marveen')
  H.currentOwnerName.mockReset().mockReturnValue('Owner')

  // Drop any avatars left over from prior tests.
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = join(H.storeDir, `marveen-avatar${ext}`)
    if (existsSync(p)) rmSync(p)
  }
  const fallback = join(H.avatarsDir, '01_robot.png')
  if (existsSync(fallback)) rmSync(fallback)
})

afterEach(() => {
  // Clean any avatar files written during the test so the next test starts
  // from the "no avatars on disk" baseline.
  for (const ext of ['.png', '.jpg', '.jpeg', '.webp']) {
    const p = join(H.storeDir, `marveen-avatar${ext}`)
    if (existsSync(p)) rmSync(p)
  }
  const fallback = join(H.avatarsDir, '01_robot.png')
  if (existsSync(fallback)) rmSync(fallback)
})

// --- pure helper: buildMarveenIdentityCore ----------------------------------

describe('buildMarveenIdentityCore', () => {
  it('packs name, brandName, agentId, autoRestartId and role into the identity core', () => {
    const id = buildMarveenIdentityCore('MyBot', 'MyBrand', 'agent-1')
    expect(id).toEqual({
      name: 'MyBot',
      brandName: 'MyBrand',
      agentId: 'agent-1',
      autoRestartId: 'agent-1',
      role: 'main',
    })
  })

  it('treats different brand vs. agent ids correctly', () => {
    const id = buildMarveenIdentityCore('Display', 'Brand', 'agent-x')
    expect(id.name).toBe('Display')
    expect(id.brandName).toBe('Brand')
    expect(id.agentId).toBe('agent-x')
    expect(id.autoRestartId).toBe('agent-x')
  })
})

// --- dispatcher surface -----------------------------------------------------

describe('tryHandleMarveen -- dispatcher surface', () => {
  it('returns false for an unrelated path', async () => {
    const { handled } = await call('GET', '/api/other')
    expect(handled).toBe(false)
  })

  it('returns false for an unrelated method on a known path', async () => {
    const { handled } = await call('DELETE', '/api/marveen')
    expect(handled).toBe(false)
  })
})

// --- GET /api/marveen -------------------------------------------------------

describe('GET /api/marveen', () => {
  it('builds the payload with default identity, fallback description and every channel flag', async () => {
    // All readFileOr calls return the empty-string fallback (the default
    // beforeEach state): no CLAUDE.md first line, no personality section.
    H.currentBotName.mockReturnValue('Marveen')
    H.currentBrandName.mockReturnValue('Marveen')
    H.currentOwnerName.mockReturnValue('Owner')

    const { res, json } = await call('GET', '/api/marveen')

    expect(res.statusCode).toBe(200)
    const body = json()
    expect(body).toMatchObject({
      name: 'Marveen',
      brandName: 'Marveen',
      agentId: H.MAIN_AGENT_ID,
      autoRestartId: H.MAIN_AGENT_ID,
      role: 'main',
      ownerName: 'Owner',
      model: 'claude-opus-4-8[1m]',
      tmuxSession: H.MAIN_CHANNELS_SESSION,
      running: true,
      hasTelegram: false,
      hasDiscord: false,
      hasSlack: false,
      hasGooglechat: false,
      hasTeams: false,
      telegramBotUsername: '',
      readonly: true,
      channelProvider: 'telegram',
      contextTokens: 12345,
      autoRestart: { enabled: false, intervalSec: 60, maxConsecutiveRestarts: 5, debounceSec: 30 },
    })
    expect(body.claudeMd).toBe('')
    expect(body.soulMd).toBe('')
    expect(body.mcpJson).toBe('')
    expect(body.personality).toBe('')
    // No first-line + no personality section -> falls back to the owner
    // description: "Owner AI asszisztense".
    expect(body.description).toBe('Owner AI asszisztense')

    // Kanban payload is fully populated via getEffectiveSettingValue.
    expect(body.kanbanAging).toEqual({
      warnH: 24,
      cautionH: 72,
      criticalH: 168,
      warnColor: '#c9a000',
      cautionColor: '#d46b00',
      criticalColor: '#c53030',
    })
    expect(body.kanbanWip).toEqual({
      limits: { planned: 0, in_progress: 0, testing: 0, waiting: 0, done: 0 },
      warnPct: 80,
      okColor: '#6b7280',
      warnColor: '#c9a000',
      fullColor: '#d46b00',
      overColor: '#c53030',
    })
    expect(body.kanbanSwimlanes).toEqual({
      defaultGroup: 'none',
      separatorColor: '#222222',
    })
    expect(body.kanbanLabels.colors).toEqual(H.KANBAN_LABEL_COLORS)
  })

  it('uses a non-default model when readActiveModelFromProjectDir returns one', async () => {
    H.readActiveModelFromProjectDir.mockReturnValue('gpt-5')
    const { json } = await call('GET', '/api/marveen')
    expect((json() as { model: string }).model).toBe('gpt-5')
  })

  it('falls back to "unknown" when readActiveModelFromProjectDir returns null', async () => {
    H.readActiveModelFromProjectDir.mockReturnValue(null)
    const { json } = await call('GET', '/api/marveen')
    expect((json() as { model: string }).model).toBe('unknown')
  })

  it('reads the personality section from CLAUDE.md when present', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('CLAUDE.md')) {
        return [
          'Te vagy a teszt',
          '',
          '## Személyiség',
          '',
          'Ez egy teszt személyiség.',
          'Második sor.',
          '',
          '## Tobbi szekcio',
          '',
          'Nem kell.',
        ].join('\n')
      }
      return fallback
    })
    const { json } = await call('GET', '/api/marveen')
    const body = json()
    expect(body.personality).toBe('Ez egy teszt személyiség.\nMásodik sor.')
    // First line "Te vagy a teszt" wins over the personality slice.
    expect(body.description).toBe('Te vagy a teszt')
  })

  it('falls back to the personality section when CLAUDE.md has no "Te ..." first line', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('CLAUDE.md')) {
        return [
          'Just a comment without a Te-prefixed first line',
          '',
          '## Személyiség',
          '',
          'Personality slice line one.',
          'Personality slice line two.',
          '',
          '## Else',
          '',
          'foo',
        ].join('\n')
      }
      return fallback
    })
    const { json } = await call('GET', '/api/marveen')
    const body = json()
    // The slice takes the first two non-empty lines, joined with a single
    // space and capped at 200 chars.
    expect(body.description).toBe('Personality slice line one. Personality slice line two.')
  })

  it('accepts the ASCII "Szemelyiseg" heading variant', async () => {
    H.readFileOr.mockImplementation((p: string, fallback: string) => {
      if (p.endsWith('CLAUDE.md')) {
        return [
          '## Szemelyiseg',
          '',
          'ASCII personality.',
          'Second line.',
          '',
          '## Next',
          '',
          'X',
        ].join('\n')
      }
      return fallback
    })
    const { json } = await call('GET', '/api/marveen')
    const body = json()
    expect(body.personality).toBe('ASCII personality.\nSecond line.')
  })

  it('uses the owner-name fallback description when neither first-line nor personality is available', async () => {
    H.currentOwnerName.mockReturnValue('Alice')
    H.readFileOr.mockImplementation((_p: string, fallback: string) => fallback)
    const { json } = await call('GET', '/api/marveen')
    expect((json() as { description: string }).description).toBe('Alice AI asszisztense')
  })

  it('passes through every channel flag when all five are set', async () => {
    H.readMarveenTelegramConfig.mockReturnValue({ hasTelegram: true, botUsername: 'tgbot' })
    H.readMarveenDiscordConfig.mockReturnValue({ hasDiscord: true })
    H.readMarveenSlackConfig.mockReturnValue({ hasSlack: true })
    H.readMarveenGooglechatConfig.mockReturnValue({ hasGooglechat: true })
    H.readMarveenTeamsConfig.mockReturnValue({ hasTeams: true })

    const { json } = await call('GET', '/api/marveen')
    const body = json()
    expect(body.hasTelegram).toBe(true)
    expect(body.telegramBotUsername).toBe('tgbot')
    expect(body.hasDiscord).toBe(true)
    expect(body.hasSlack).toBe(true)
    expect(body.hasGooglechat).toBe(true)
    expect(body.hasTeams).toBe(true)
  })

  it('reflects the configured CHANNEL_PROVIDER', async () => {
    // The module-level CHANNEL_PROVIDER is captured at import time; this
    // suite does not exercise that path -- but we still cover the
    // default-seen-in-payload contract.
    const { json } = await call('GET', '/api/marveen')
    expect((json() as { channelProvider: string }).channelProvider).toBe('telegram')
  })

  it('serializes the kanbanSwimlanes separatorColor as null when settings-store returns ""', async () => {
    H.getEffectiveSettingValue.mockImplementation((key: string) => {
      if (key === 'KANBAN_SWIMLANE_SEPARATOR_COLOR') return ''
      return 0
    })
    const { json } = await call('GET', '/api/marveen')
    const body = json() as { kanbanSwimlanes: { separatorColor: string | null } }
    expect(body.kanbanSwimlanes.separatorColor).toBeNull()
  })

  it('respects non-default bot/brand/owner names', async () => {
    H.currentBotName.mockReturnValue('DisplayName')
    H.currentBrandName.mockReturnValue('BrandName')
    H.currentOwnerName.mockReturnValue('Operator')

    const { json } = await call('GET', '/api/marveen')
    const body = json()
    expect(body.name).toBe('DisplayName')
    expect(body.brandName).toBe('BrandName')
    expect(body.ownerName).toBe('Operator')
  })

  it('passes through a non-default autoRestart config verbatim', async () => {
    H.readAutoRestartConfig.mockReturnValue({
      enabled: true,
      intervalSec: 5,
      maxConsecutiveRestarts: 9,
      debounceSec: 17,
    })
    const { json } = await call('GET', '/api/marveen')
    expect((json() as { autoRestart: unknown }).autoRestart).toEqual({
      enabled: true,
      intervalSec: 5,
      maxConsecutiveRestarts: 9,
      debounceSec: 17,
    })
  })

  it('passes through a non-default contextTokens number', async () => {
    H.readContextTokensFromProjectDir.mockReturnValue(null)
    const { json } = await call('GET', '/api/marveen')
    expect((json() as { contextTokens: unknown }).contextTokens).toBeNull()
  })
})

// --- PUT /api/marveen -------------------------------------------------------

describe('PUT /api/marveen', () => {
  it('returns { ok: true, readonly: true } (intentionally rejects edits)', async () => {
    const { res, json } = await call('PUT', '/api/marveen')
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true, readonly: true })
  })

  it('returns the same payload for PUT regardless of body shape', async () => {
    const { json } = await call('PUT', '/api/marveen', { body: Buffer.from('whatever') })
    expect(json()).toEqual({ ok: true, readonly: true })
  })
})

// --- POST /api/marveen/restart ---------------------------------------------

describe('POST /api/marveen/restart', () => {
  it('returns { ok: true } when hardRestartMarveenChannels succeeds', async () => {
    H.hardRestartMarveenChannels.mockReturnValue({ ok: true })
    const { res, json } = await call('POST', '/api/marveen/restart')
    expect(H.hardRestartMarveenChannels).toHaveBeenCalledTimes(1)
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })

  it('returns 500 with result.error when hardRestartMarveenChannels provides one', async () => {
    H.hardRestartMarveenChannels.mockReturnValue({ ok: false, error: 'tmux exploded' })
    const { res, json } = await call('POST', '/api/marveen/restart')
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'tmux exploded' })
  })

  it('returns 500 with the generic "Restart failed" when hardRestartMarveenChannels provides no error string', async () => {
    H.hardRestartMarveenChannels.mockReturnValue({ ok: false })
    const { res, json } = await call('POST', '/api/marveen/restart')
    expect(res.statusCode).toBe(500)
    expect(json()).toEqual({ error: 'Restart failed' })
  })
})

// --- GET /api/marveen/avatar ------------------------------------------------

describe('GET /api/marveen/avatar', () => {
  it('returns 404 (writeHead+end) when neither a stored avatar nor the fallback exists', async () => {
    const { res } = await call('GET', '/api/marveen/avatar')
    expect(res.statusCode).toBe(404)
    // serveFile must NOT have been invoked.
    expect(H.serveFileImpl).not.toHaveBeenCalled()
  })

  it('serves the first stored avatar (.png) when present', async () => {
    writeFileSync(join(H.storeDir, 'marveen-avatar.png'), 'png-bytes')
    const { res } = await call('GET', '/api/marveen/avatar')
    expect(H.serveFileImpl).toHaveBeenCalledTimes(1)
    const servedPath = H.serveFileImpl.mock.calls[0][2] as string
    expect(servedPath).toBe(join(H.storeDir, 'marveen-avatar.png'))
    expect(res.headers['X-Served']).toBe('1')
  })

  it('serves a stored .jpg avatar when no .png exists', async () => {
    writeFileSync(join(H.storeDir, 'marveen-avatar.jpg'), 'jpg-bytes')
    const { res } = await call('GET', '/api/marveen/avatar')
    const servedPath = H.serveFileImpl.mock.calls[0][2] as string
    expect(servedPath).toBe(join(H.storeDir, 'marveen-avatar.jpg'))
    expect(res.headers['X-Served']).toBe('1')
  })

  it('serves a stored .jpeg avatar when no .png or .jpg exists', async () => {
    writeFileSync(join(H.storeDir, 'marveen-avatar.jpeg'), 'jpeg-bytes')
    const { res } = await call('GET', '/api/marveen/avatar')
    const servedPath = H.serveFileImpl.mock.calls[0][2] as string
    expect(servedPath).toBe(join(H.storeDir, 'marveen-avatar.jpeg'))
    expect(res.headers['X-Served']).toBe('1')
  })

  it('serves a stored .webp avatar when no .png/.jpg/.jpeg exists', async () => {
    writeFileSync(join(H.storeDir, 'marveen-avatar.webp'), 'webp-bytes')
    const { res } = await call('GET', '/api/marveen/avatar')
    const servedPath = H.serveFileImpl.mock.calls[0][2] as string
    expect(servedPath).toBe(join(H.storeDir, 'marveen-avatar.webp'))
    expect(res.headers['X-Served']).toBe('1')
  })

  it('prefers .png over the .jpg sibling when both exist', async () => {
    writeFileSync(join(H.storeDir, 'marveen-avatar.png'), 'png')
    writeFileSync(join(H.storeDir, 'marveen-avatar.jpg'), 'jpg')
    const { res } = await call('GET', '/api/marveen/avatar')
    const servedPath = H.serveFileImpl.mock.calls[0][2] as string
    expect(servedPath).toBe(join(H.storeDir, 'marveen-avatar.png'))
    expect(res.headers['X-Served']).toBe('1')
  })

  it('falls back to the built-in avatar when no stored avatar exists', async () => {
    writeFileSync(join(H.avatarsDir, '01_robot.png'), 'builtin')
    const { res } = await call('GET', '/api/marveen/avatar')
    expect(H.serveFileImpl).toHaveBeenCalledTimes(1)
    const servedPath = H.serveFileImpl.mock.calls[0][2] as string
    expect(servedPath).toBe(join(H.avatarsDir, '01_robot.png'))
    expect(res.headers['X-Served']).toBe('1')
  })

  it('passes the cacheSeconds=3600 option to serveFile for both stored and fallback avatars', async () => {
    writeFileSync(join(H.storeDir, 'marveen-avatar.png'), 'png')
    await call('GET', '/api/marveen/avatar')
    expect(H.serveFileImpl.mock.calls[0][3]).toEqual({ cacheSeconds: 3600 })
  })
})

// --- POST /api/marveen/avatar -----------------------------------------------

describe('POST /api/marveen/avatar', () => {
  it('accepts a JSON body selecting a valid gallery avatar, removes any prior avatar, and copies it', async () => {
    // Seed a stale avatar to verify the cleanup loop.
    writeFileSync(join(H.storeDir, 'marveen-avatar.png'), 'old')

    writeFileSync(join(H.avatarsDir, '02_cat.jpg'), 'cat')
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: '02_cat.jpg' })))

    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(existsSync(join(H.storeDir, 'marveen-avatar.jpg'))).toBe(true)
    expect(existsSync(join(H.storeDir, 'marveen-avatar.png'))).toBe(false) // cleaned
    expect(H.sendMarveenAvatarChange).toHaveBeenCalledTimes(1)
    expect(H.sendMarveenAvatarChange.mock.calls[0][0]).toBe(join(H.storeDir, 'marveen-avatar.jpg'))
  })

  it('returns 400 when the JSON body omits galleryAvatar', async () => {
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({})))
    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No avatar specified' })
    expect(H.sendMarveenAvatarChange).not.toHaveBeenCalled()
  })

  it('rejects a gallery avatar containing ".." (path traversal)', async () => {
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: '../etc/passwd' })))
    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid avatar name' })
  })

  it('rejects a gallery avatar containing "/"', async () => {
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: 'sub/file.png' })))
    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid avatar name' })
  })

  it('rejects a gallery avatar containing a backslash', async () => {
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: 'evil\\name.png' })))
    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'Invalid avatar name' })
  })

  it('returns 404 when the gallery avatar file does not exist', async () => {
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: 'ghost.png' })))
    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(404)
    expect(json()).toEqual({ error: 'Avatar not found' })
    expect(H.sendMarveenAvatarChange).not.toHaveBeenCalled()
  })

  it('falls back to .png when the gallery avatar filename has no extension', async () => {
    // Create a gallery avatar with no extension in webDir/avatars/. Since
    // extname('avatar') === '', the route must use the '.png' fallback when
    // computing the destination path.
    writeFileSync(join(H.avatarsDir, 'avatar'), 'no-ext')
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: 'avatar' })))

    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(existsSync(join(H.storeDir, 'marveen-avatar.png'))).toBe(true)
    expect(H.sendMarveenAvatarChange.mock.calls[0][0]).toBe(join(H.storeDir, 'marveen-avatar.png'))
  })

  it('parses the multipart body and writes the uploaded file to store/ as marveen-avatar.<ext>', async () => {
    const fileBuf = Buffer.from('uploaded-data')
    H.parseMultipart.mockReturnValue({
      fields: {},
      file: { name: 'photo.png', data: fileBuf, mime: 'image/png' },
    })
    H.readBody.mockResolvedValue(Buffer.alloc(0))

    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'multipart/form-data; boundary=---xxx' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
    expect(existsSync(join(H.storeDir, 'marveen-avatar.png'))).toBe(true)
    expect(H.sendMarveenAvatarChange).toHaveBeenCalledTimes(1)
    expect(H.sendMarveenAvatarChange.mock.calls[0][0]).toBe(join(H.storeDir, 'marveen-avatar.png'))
  })

  it('falls back to ".png" extension when the uploaded file has none', async () => {
    H.parseMultipart.mockReturnValue({
      fields: {},
      file: { name: 'noext', data: Buffer.from('x'), mime: 'application/octet-stream' },
    })
    H.readBody.mockResolvedValue(Buffer.alloc(0))

    const { res } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'multipart/form-data; boundary=---xxx' },
    })
    expect(res.statusCode).toBe(200)
    expect(existsSync(join(H.storeDir, 'marveen-avatar.png'))).toBe(true)
    expect(extname('noext')).toBe('') // sanity: the source name has no ext
  })

  it('returns 400 when the multipart body has no file', async () => {
    H.parseMultipart.mockReturnValue({ fields: {}, file: null })
    H.readBody.mockResolvedValue(Buffer.alloc(0))

    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'multipart/form-data; boundary=---xxx' },
    })
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No file uploaded' })
    expect(H.sendMarveenAvatarChange).not.toHaveBeenCalled()
  })

  it('cleans up any pre-existing avatar of every supported extension before writing the new one', async () => {
    // Drop three different extensions and confirm each is removed.
    writeFileSync(join(H.storeDir, 'marveen-avatar.png'), 'old-png')
    writeFileSync(join(H.storeDir, 'marveen-avatar.jpg'), 'old-jpg')
    writeFileSync(join(H.storeDir, 'marveen-avatar.webp'), 'old-webp')

    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: '02_cat.jpg' })))
    writeFileSync(join(H.avatarsDir, '02_cat.jpg'), 'cat')

    const { res } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    expect(res.statusCode).toBe(200)
    expect(existsSync(join(H.storeDir, 'marveen-avatar.png'))).toBe(false)
    expect(existsSync(join(H.storeDir, 'marveen-avatar.jpg'))).toBe(true) // new one
    expect(existsSync(join(H.storeDir, 'marveen-avatar.webp'))).toBe(false)
  })

  it('swallows sendMarveenAvatarChange rejections (the .catch(() => {}) is wired)', async () => {
    H.sendMarveenAvatarChange.mockRejectedValue(new Error('avatar notify boom'))
    H.readBody.mockResolvedValue(Buffer.from(JSON.stringify({ galleryAvatar: '02_cat.jpg' })))
    writeFileSync(join(H.avatarsDir, '02_cat.jpg'), 'cat')

    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'application/json' },
    })
    // The handler awaits the chain via .catch(() => {}) -- rejections must
    // not turn the upload into a 500.
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })

  it('falls through to the multipart branch when content-type is missing', async () => {
    // When req.headers['content-type'] is undefined, the route falls back to
    // '' (line 173 `|| ''`) and treats the body as multipart -- so we must
    // get a 400 "No file uploaded" rather than a JSON parse error.
    H.parseMultipart.mockReturnValue({ fields: {}, file: null })
    H.readBody.mockResolvedValue(Buffer.alloc(0))

    const { res, json } = await call('POST', '/api/marveen/avatar', {})
    expect(res.statusCode).toBe(400)
    expect(json()).toEqual({ error: 'No file uploaded' })
  })

  it('swallows sendMarveenAvatarChange rejections on the multipart path', async () => {
    H.parseMultipart.mockReturnValue({
      fields: {},
      file: { name: 'photo.png', data: Buffer.from('x'), mime: 'image/png' },
    })
    H.readBody.mockResolvedValue(Buffer.alloc(0))
    H.sendMarveenAvatarChange.mockRejectedValue(new Error('notify boom'))

    const { res, json } = await call('POST', '/api/marveen/avatar', {
      headers: { 'content-type': 'multipart/form-data; boundary=---xxx' },
    })
    expect(res.statusCode).toBe(200)
    expect(json()).toEqual({ ok: true })
  })
})