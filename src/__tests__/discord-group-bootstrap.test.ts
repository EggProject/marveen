// 100% coverage for src/web/discord-group-bootstrap.ts.
//
// The bootstrap function has exactly one public entry point
// (ensureDiscordChannelGroup). Branches reachable through the public API:
//
//   - early-return when CHANNEL_PROVIDER is not 'discord'
//   - early-return when CHANNEL_CHAT_ID is empty
//   - access.json missing -> create default scaffolding, then add the entry
//   - access.json present, parse OK, groups missing -> add entry
//   - access.json present, parse OK, groups present, CHANNEL_CHAT_ID NOT in
//     groups -> add entry
//   - access.json present, parse OK, groups present, CHANNEL_CHAT_ID IN
//     groups -> no-op (idempotent)
//   - access.json present, parse fails -> warn + early-return
//
// Mocking strategy:
//
//   ../config.js     CHANNEL_PROVIDER and CHANNEL_CHAT_ID are mocked so the
//                    tests don't depend on the live .env. PROJECT_ROOT is
//                    mocked because channelStateDir's resolved path needs to
//                    live in the test sandbox.
//   ../channel-provider.js  channelStateDir is mocked to return a sandbox
//                    path (it calls homedir() at runtime otherwise).
//   ../logger.js     info/warn are mocked so we can assert the warn branch
//                    fires on the corrupt-file path without polluting test
//                    output.
//   ../web/atomic-write.js  real -- it's a 7-line primitive the bootstrap
//                    composes, no value in mocking it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// vi.mock factories are hoisted above all import-time evaluation. We use
// vi.hoisted() to allocate the sandbox and the per-test channel-state dir
// up-front so the factories only see them AFTER they're initialised (mock
// factories themselves can't reference top-level consts).
const mocks = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'discord-group-bootstrap-'))
  return {
    dir,
    provider: 'telegram' as 'telegram' | 'discord',
    chatId: '',
    info: vi.fn<(obj: unknown, msg?: string) => void>(),
    warn: vi.fn<(obj: unknown, msg?: string) => void>(),
  }
})

const SANDBOX = mocks.dir
const CHANNELS_DIR = join(SANDBOX, '.claude', 'channels', 'discord')
const ACCESS_PATH = join(CHANNELS_DIR, 'access.json')

vi.mock('../config.js', () => ({
  get CHANNEL_PROVIDER() { return mocks.provider },
  get CHANNEL_CHAT_ID() { return mocks.chatId },
}))

vi.mock('../channel-provider.js', () => ({
  ChannelEnv: vi.fn(function ChannelEnvMock() {
    return {
      stateDirFor: (_provider: string) => CHANNELS_DIR,
      readTokenFor: vi.fn<() => string | null>(() => null),
      getToken: vi.fn(() => ''),
      getChatId: vi.fn(() => ''),
    }
  }),
}))

vi.mock('../logger.js', () => ({
  logger: {
    info: mocks.info,
    warn: mocks.warn,
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}))

async function importSut(): Promise<
  typeof import('../web/discord-group-bootstrap.js')
> {
  // Fresh module registry so the bootstrap's module-scope imports (config.js,
  // channel-provider.js, logger.js, web/atomic-write.js) re-bind against the
  // current mocks.provider / mocks.chatId. Without vi.resetModules(), every
  // test sees the first imported value.
  vi.resetModules()
  return import('../web/discord-group-bootstrap.js')
}

function readAccess(): {
  dmPolicy?: string
  allowFrom?: string[]
  groups?: Record<string, { requireMention?: boolean; allowFrom?: string[] }>
} {
  const raw = readFileSync(ACCESS_PATH, 'utf-8')
  return JSON.parse(raw) as ReturnType<typeof readAccess>
}

function writeAccess(body: string): void {
  mkdirSync(CHANNELS_DIR, { recursive: true })
  writeFileSync(ACCESS_PATH, body)
}

describe('ensureDiscordChannelGroup', () => {
  beforeEach(() => {
    rmSync(SANDBOX, { recursive: true, force: true })
    mkdirSync(CHANNELS_DIR, { recursive: true })
    mocks.provider = 'discord'
    mocks.chatId = '987654321098765432'
    mocks.info.mockClear()
    mocks.warn.mockClear()
  })

  afterEach(() => {
    rmSync(SANDBOX, { recursive: true, force: true })
  })

  it('returns early when CHANNEL_PROVIDER is not discord', async () => {
    mocks.provider = 'telegram'
    mocks.chatId = 'channel-id'
    const { ensureDiscordChannelGroup } = await importSut()
    ensureDiscordChannelGroup()
    expect(mocks.info).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
    // No access.json should be created on the no-op path.
    expect(() => readFileSync(ACCESS_PATH)).toThrow()
  })

  it('returns early when CHANNEL_CHAT_ID is empty', async () => {
    mocks.chatId = ''
    const { ensureDiscordChannelGroup } = await importSut()
    ensureDiscordChannelGroup()
    expect(mocks.info).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
    expect(() => readFileSync(ACCESS_PATH)).toThrow()
  })

  it('creates the default scaffolding and adds the channel when no access.json exists', async () => {
    const { ensureDiscordChannelGroup } = await importSut()
    ensureDiscordChannelGroup()

    const access = readAccess()
    expect(access.dmPolicy).toBe('pairing')
    expect(access.allowFrom).toEqual([])
    expect(access.groups).toEqual({
      '987654321098765432': { requireMention: false, allowFrom: [] },
    })
    expect(mocks.info).toHaveBeenCalledWith(
      { channelId: '987654321098765432' },
      'discord-group-bootstrap: added channel to access.groups',
    )
  })

  it('adds the channel when access.json exists but has no groups key', async () => {
    writeAccess(JSON.stringify({ dmPolicy: 'allowlist', allowFrom: ['u1'] }))
    const { ensureDiscordChannelGroup } = await importSut()
    ensureDiscordChannelGroup()

    const access = readAccess()
    // pre-existing keys preserved
    expect(access.dmPolicy).toBe('allowlist')
    expect(access.allowFrom).toEqual(['u1'])
    expect(access.groups).toEqual({
      '987654321098765432': { requireMention: false, allowFrom: [] },
    })
    expect(mocks.info).toHaveBeenCalledTimes(1)
  })

  it('adds the channel when groups exists but does not yet contain CHANNEL_CHAT_ID', async () => {
    writeAccess(
      JSON.stringify({
        dmPolicy: 'pairing',
        allowFrom: [],
        groups: { '111111111111111111': { requireMention: true, allowFrom: ['u1'] } },
      }),
    )
    const { ensureDiscordChannelGroup } = await importSut()
    ensureDiscordChannelGroup()

    const access = readAccess()
    expect(access.groups).toEqual({
      '111111111111111111': { requireMention: true, allowFrom: ['u1'] },
      '987654321098765432': { requireMention: false, allowFrom: [] },
    })
    expect(mocks.info).toHaveBeenCalledTimes(1)
  })

  it('is a no-op when the channel is already present in access.groups (idempotent)', async () => {
    writeAccess(
      JSON.stringify({
        dmPolicy: 'pairing',
        allowFrom: [],
        groups: { '987654321098765432': { requireMention: true, allowFrom: ['pre-existing'] } },
      }),
    )
    const beforeRaw = readFileSync(ACCESS_PATH, 'utf-8')
    const { ensureDiscordChannelGroup } = await importSut()
    ensureDiscordChannelGroup()

    // file must not have been rewritten
    expect(readFileSync(ACCESS_PATH, 'utf-8')).toBe(beforeRaw)
    // and no info log fires for the no-op branch
    expect(mocks.info).not.toHaveBeenCalled()
    expect(mocks.warn).not.toHaveBeenCalled()
  })

  it('warns and returns early when access.json is unparseable', async () => {
    writeAccess('{ this is not valid json')
    const { ensureDiscordChannelGroup } = await importSut()
    ensureDiscordChannelGroup()

    expect(mocks.warn).toHaveBeenCalledWith(
      { path: ACCESS_PATH },
      'discord-group-bootstrap: access.json unparseable, skipping',
    )
    // file must NOT be rewritten on the corrupt path
    expect(readFileSync(ACCESS_PATH, 'utf-8')).toBe('{ this is not valid json')
    expect(mocks.info).not.toHaveBeenCalled()
  })
})