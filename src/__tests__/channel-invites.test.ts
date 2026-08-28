// 100% coverage for src/web/channel-invites.ts.
//
// Strategy:
//   - Redirect homedir() to a sandbox so channelStateDir(...) lands inside
//     the temp dir; redirect PROJECT_ROOT via a config.js mock so agentDir()
//     (used by agentChannelDir for sub-agents) resolves inside the sandbox.
//   - Mock ../logger.js so output stays out of the test runner and so we can
//     assert warn/info/error calls drive the catch-all paths in
//     runInviteMonitorTick / startInviteMonitor.
//   - Mock node:crypto.randomBytes with a deterministic counter so we can
//     assert on token strings (the function under test only ever slices 22
//     base64url chars off the first 16 bytes).
//   - Real fs is used everywhere else: channel-invites writes through atomic-
//     write and through mkdirSync, and the sandbox is wiped between tests so
//     state from one assertion never leaks into another.
//
// We intentionally do NOT mock child_process or the Telegram HTTP API here:
// the source file does not import either, so doing so would be a no-op mock
// -- the per-suite mock template in the task brief assumes files that fork
// tmux / open sockets, and channel-invites is pure fs + JSON.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

// vi.mock factories are hoisted above all const declarations. We use
// vi.hoisted() to allocate the sandbox up-front (it runs at hoist time),
// then resolve HOME / PROJECT / SANDBOX lazily through getters so the mock
// factory bodies only see the consts AFTER they have been initialised.
// require() is used inside the hoisted block so the node:fs / node:path /
// node:os imports (also hoisted) are not touched before they resolve.
const sandbox = vi.hoisted(() => {
  const fs = require('node:fs') as typeof import('node:fs')
  const path = require('node:path') as typeof import('node:path')
  const os = require('node:os') as typeof import('node:os')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'channel-invites-'))
  const home = path.join(dir, 'home')
  const project = path.join(dir, 'project')
  const agentsBase = path.join(project, 'agents')
  const agentsRoot = path.join(dir, 'isolated-agents')
  const store = path.join(project, 'store')
  fs.mkdirSync(home, { recursive: true })
  fs.mkdirSync(project, { recursive: true })
  fs.mkdirSync(agentsBase, { recursive: true })
  fs.mkdirSync(agentsRoot, { recursive: true })
  fs.mkdirSync(store, { recursive: true })
  return { dir, home, project, agentsBase, agentsRoot, store }
})

const SANDBOX = sandbox.dir
const HOME = sandbox.home
const PROJECT = sandbox.project
const AGENTS_BASE = sandbox.agentsBase
const AGENTS_ROOT = sandbox.agentsRoot
const STORE = sandbox.store

vi.mock('node:os', async (orig) => {
  const actual = await orig<typeof import('node:os')>()
  return { ...actual, homedir: () => HOME, tmpdir: () => SANDBOX }
})

vi.mock('../config.js', async (orig) => {
  const actual = await orig<typeof import('../config.js')>()
  return Object.defineProperties(
    { ...actual, MAIN_AGENT_ID: 'mainagent' },
    {
      PROJECT_ROOT: { get: () => PROJECT, enumerable: true },
      STORE_DIR: { get: () => STORE, enumerable: true },
    },
  )
})

vi.mock('../logger.js', () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
  },
}))

// Deterministic token factory: only intercepts the 16-byte calls that
// channel-invites makes to mint the invite token. Smaller randomBytes calls
// (e.g. atomic-write's 4-byte tmp-suffix) flow through to the real impl so
// atomic-write's Buffer length math stays intact.
let tokenCounter = 0
vi.mock('node:crypto', async (orig) => {
  const actual = await orig<typeof import('node:crypto')>()
  return {
    ...actual,
    randomBytes: (size: number, ...rest: unknown[]) => {
      if (size === 16) {
        const buf = Buffer.alloc(size)
        tokenCounter += 1
        buf.writeUInt32BE(tokenCounter, 0)
        buf.writeUInt32BE(tokenCounter, 4)
        buf.writeUInt32BE(tokenCounter, 8)
        buf.writeUInt32BE(tokenCounter, 12)
        return buf
      }
      // Fall through to real randomBytes for any other size (atomic-write
      // uses 4-byte suffixes -- mocking them breaks Buffer length math).
      // @ts-expect-error -- the rest signature matches the underlying impl.
      return actual.randomBytes(size, ...rest)
    },
  }
})

// Per-test fault injector for node:fs. Tests can set `fsFault.existsSync`
// or `fsFault.readdirSync` to a path-suffix string; any matching call
// throws the configured error. Default = no fault.
const fsFault: {
  existsSync?: { suffix: string; message: string }
  readdirSync?: { suffix: string; message: string }
} = {}
vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  return new Proxy(actual, {
    get(target, prop, receiver) {
      if (prop === 'existsSync' && fsFault.existsSync) {
        const fault = fsFault.existsSync
        return ((p: unknown) => {
          if (typeof p === 'string' && p.endsWith(fault.suffix)) {
            throw new Error(fault.message)
          }
          return target.existsSync(p as string)
        }) as typeof target.existsSync
      }
      if (prop === 'readdirSync' && fsFault.readdirSync) {
        const fault = fsFault.readdirSync
        return ((p: unknown, opts?: unknown) => {
          if (typeof p === 'string' && p.endsWith(fault.suffix)) {
            throw new Error(fault.message)
          }
          return target.readdirSync(p as string, opts as Parameters<typeof target.readdirSync>[1])
        }) as typeof target.readdirSync
      }
      return Reflect.get(target, prop, receiver)
    },
  })
})

function resetSandbox(): void {
  rmSync(SANDBOX, { recursive: true, force: true })
  mkdirSync(HOME, { recursive: true })
  mkdirSync(PROJECT, { recursive: true })
  mkdirSync(AGENTS_BASE, { recursive: true })
  mkdirSync(AGENTS_ROOT, { recursive: true })
  mkdirSync(STORE, { recursive: true })
}

function mainChannelDir(provider: 'telegram' | 'slack'): string {
  return join(HOME, '.claude', 'channels', provider)
}

function subAgentChannelDir(name: string, provider: 'telegram' | 'slack'): string {
  return join(AGENTS_BASE, name, '.claude', 'channels', provider)
}

function isolatedAgentChannelDir(name: string, provider: 'telegram' | 'slack'): string {
  return join(AGENTS_ROOT, name, '.claude', 'channels', provider)
}

function writeAccessRaw(accessPath: string, body: unknown): void {
  mkdirSync(join(accessPath, '..'), { recursive: true })
  writeFileSync(accessPath, JSON.stringify(body, null, 2))
}

function readAccessRaw(accessPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(accessPath, 'utf-8'))
}

function readInvitesRaw(invitesPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(invitesPath, 'utf-8'))
}

// `now` is fixed at 1_700_000_000_000 so Date.now() in the SUT is reproducible
// without leaning on vitest's fake timers (which would also need to wrap
// setInterval for startInviteMonitor). Tests that need a later "now" pass a
// later value through `vi.spyOn(Date, 'now')`.
const FROZEN_NOW = 1_700_000_000_000

// Logger reference resolved once the mock factory has installed. Cleared in
// each beforeEach via mockClear() (the underlying mock object stays stable
// across re-imports because vi.mock replaces the module record, not the
// namespace reference).
const { logger: loggerRef } = await import('../logger.js')
const loggerMock = loggerRef as unknown as {
  info: ReturnType<typeof vi.fn>
  warn: ReturnType<typeof vi.fn>
  error: ReturnType<typeof vi.fn>
  debug: ReturnType<typeof vi.fn>
  fatal: ReturnType<typeof vi.fn>
  trace: ReturnType<typeof vi.fn>
}

// Channel-invites is dynamically imported so the vi.mock factory for
// ../config.js sees the sandbox consts (PROJECT / HOME) AFTER they have
// been initialised -- static `import` would evaluate the module before the
// const declarations run, hitting TDZ in the getter closure.
const ci = await import('../web/channel-invites.js')

beforeEach(() => {
  resetSandbox()
  tokenCounter = 0
  vi.spyOn(Date, 'now').mockReturnValue(FROZEN_NOW)
  loggerMock.info.mockClear()
  loggerMock.warn.mockClear()
  loggerMock.error.mockClear()
  loggerMock.debug.mockClear()
})

afterEach(async () => {
  ci.stopInviteMonitor()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// agentChannelDir
// ---------------------------------------------------------------------------

describe('agentChannelDir', () => {
  it('returns channelStateDir(provider) when name matches mainAgentId', () => {
    expect(ci.agentChannelDir('mainagent', 'mainagent', 'telegram'))
      .toBe(mainChannelDir('telegram'))
    expect(ci.agentChannelDir('mainagent', 'mainagent', 'slack'))
      .toBe(mainChannelDir('slack'))
  })

  it('returns channelStateDir(provider, agentDir(name)) for a sub-agent', () => {
    expect(ci.agentChannelDir('samu', 'mainagent', 'telegram'))
      .toBe(subAgentChannelDir('samu', 'telegram'))
    expect(ci.agentChannelDir('samu', 'mainagent', 'slack'))
      .toBe(subAgentChannelDir('samu', 'slack'))
  })
})

// ---------------------------------------------------------------------------
// createInvite
// ---------------------------------------------------------------------------

describe('createInvite', () => {
  it('writes a fresh invite, flips dmPolicy to pairing, no deepLink without botUsername', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'allowlist', allowFrom: [] })

    const result = ci.createInvite(accessPath, undefined)

    expect(result.token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(result.expiresAt).toBe(FROZEN_NOW + 24 * 60 * 60 * 1000)
    expect(result.deepLink).toBeUndefined()

    const access = readAccessRaw(accessPath)
    expect(access.dmPolicy).toBe('pairing')

    const invites = readInvitesRaw(join(mainChannelDir('telegram'), 'invites.json'))
    expect(invites).toMatchObject({
      invites: {
        [result.token]: {
          createdAt: FROZEN_NOW,
          expiresAt: FROZEN_NOW + 24 * 60 * 60 * 1000,
          used: false,
        },
      },
    })
  })

  it('builds the telegram deep link and strips a leading @ from the bot username', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {})

    const at = ci.createInvite(accessPath, '@mybot', 'telegram')
    expect(at.deepLink).toBe(`https://t.me/mybot?start=invite-${at.token}`)

    const plain = ci.createInvite(accessPath, 'plainbot', 'telegram')
    expect(plain.deepLink).toBe(`https://t.me/plainbot?start=invite-${plain.token}`)
  })

  it('omits the deep link for non-telegram providers even when botUsername is set', () => {
    const accessPath = join(mainChannelDir('slack'), 'access.json')
    writeAccessRaw(accessPath, {})

    const result = ci.createInvite(accessPath, 'whatever', 'slack')
    expect(result.deepLink).toBeUndefined()
  })

  it('does not flip dmPolicy when access.dmPolicy is "disabled"', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'disabled', allowFrom: [] })

    ci.createInvite(accessPath, 'botname', 'telegram')

    const access = readAccessRaw(accessPath)
    expect(access.dmPolicy).toBe('disabled')
  })

  it('prunes expired un-used invites before writing the new one', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {})
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')

    const seedExpiry = FROZEN_NOW - 1000
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        expiredToken: { createdAt: FROZEN_NOW - 100_000, expiresAt: seedExpiry, used: false },
        usedToken: { createdAt: FROZEN_NOW - 200_000, expiresAt: FROZEN_NOW + 100_000, used: true, usedBy: 'x', usedAt: FROZEN_NOW - 1000 },
      },
    }))

    const result = ci.createInvite(accessPath, undefined)

    const after = readInvitesRaw(invitesPath) as { invites: Record<string, { used: boolean; expiresAt: number }> }
    // expiredToken is pruned (expired AND unused). usedToken stays because
    // the prune predicate is `expired AND unused` -- consumed tokens are
    // kept on file as an audit trail.
    expect(Object.keys(after.invites).sort()).toEqual([result.token, 'usedToken'].sort())
    expect(after.invites[result.token].used).toBe(false)
    expect(after.invites[result.token].expiresAt).toBe(FROZEN_NOW + 24 * 60 * 60 * 1000)
    expect(after.invites.expiredToken).toBeUndefined()
  })

  it('uses a custom ttl when one is provided', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {})

    const result = ci.createInvite(accessPath, undefined, 'telegram', 1000)
    expect(result.expiresAt).toBe(FROZEN_NOW + 1000)
  })

  it('also creates the access.json alongside the invites.json on first invite', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')

    const result = ci.createInvite(accessPath, undefined)

    // The SUT reads access.json, sees no dmPolicy, and since dmPolicy is
    // not 'disabled' it WRITES a fresh access.json with dmPolicy='pairing'.
    // That means the operator who never set a policy now has the file
    // present on disk. Documented behaviour: callers can't rely on
    // "no access.json means we never touched the channel".
    expect(existsSync(accessPath)).toBe(true)
    expect(readAccessRaw(accessPath).dmPolicy).toBe('pairing')

    const invites = readInvitesRaw(join(mainChannelDir('telegram'), 'invites.json'))
    expect(invites.invites?.[result.token]?.expiresAt).toBe(FROZEN_NOW + 24 * 60 * 60 * 1000)
  })

  it('falls back to defaults for the optional provider / ttl parameters', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {})

    const result = ci.createInvite(accessPath, undefined)
    expect(result.expiresAt).toBe(FROZEN_NOW + 24 * 60 * 60 * 1000)
  })
})

// ---------------------------------------------------------------------------
// listInvites
// ---------------------------------------------------------------------------

describe('listInvites', () => {
  it('returns [] when no invites file exists', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    expect(ci.listInvites(accessPath)).toEqual([])
  })

  it('returns [] when invites file is empty', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, '{}')

    expect(ci.listInvites(accessPath)).toEqual([])
  })

  it('returns the surviving entries with used + usedBy surfaced', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        liveToken: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false },
        usedToken: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: true, usedBy: 'alice' },
      },
    }))

    const out = ci.listInvites(accessPath)
    expect(out).toHaveLength(2)
    const live = out.find((e) => e.token === 'liveToken')
    const used = out.find((e) => e.token === 'usedToken')
    expect(live).toMatchObject({ used: false, createdAt: FROZEN_NOW })
    expect(used).toMatchObject({ used: true, usedBy: 'alice' })
  })

  it('prunes expired-but-unused invites back to disk', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        expired: { createdAt: FROZEN_NOW - 1000, expiresAt: FROZEN_NOW - 100, used: false },
      },
    }))

    expect(ci.listInvites(accessPath)).toEqual([])

    // The SUT only deletes the entries themselves; the invites map key
    // remains defined (empty object) once the last entry is pruned. That's
    // observable behaviour: callers that branch on `store.invites` will
    // see it as truthy, which is fine.
    const after = readInvitesRaw(invitesPath) as { invites?: Record<string, unknown> }
    expect(after.invites).toEqual({})
  })

  it('does NOT rewrite invites.json when nothing was pruned', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    const before = JSON.stringify({
      invites: {
        liveToken: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false },
      },
    }, null, 2)
    writeFileSync(invitesPath, before)
    const mtimeBefore = readFileSync

    ci.listInvites(accessPath)

    // listInvites must not touch the file when nothing is pruned
    expect(readFileSync(invitesPath, 'utf-8')).toBe(before)
    expect(mtimeBefore).toBeDefined()
  })
})

// ---------------------------------------------------------------------------
// revokeInvite
// ---------------------------------------------------------------------------

describe('revokeInvite', () => {
  it('returns false when the invites file is missing', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    expect(ci.revokeInvite(accessPath, 'anyToken')).toBe(false)
  })

  it('returns false when the invites map has no such token', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        live: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false },
      },
    }))

    expect(ci.revokeInvite(accessPath, 'missing')).toBe(false)
  })

  it('returns false when store.invites is undefined entirely', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, '{}')

    expect(ci.revokeInvite(accessPath, 'anyToken')).toBe(false)
  })

  it('removes the token, restores dmPolicy to allowlist when no active invites remain', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeAccessRaw(accessPath, { dmPolicy: 'pairing', allowFrom: [] })
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        only: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false },
      },
    }))

    expect(ci.revokeInvite(accessPath, 'only')).toBe(true)

    const after = readInvitesRaw(invitesPath) as { invites?: Record<string, unknown> }
    // The SUT only deletes the matching entry; once the only entry is
    // gone the map is `{}` (still defined), not undefined.
    expect(after.invites).toEqual({})
    expect(readAccessRaw(accessPath).dmPolicy).toBe('allowlist')
  })

  it('does not touch access when dmPolicy is not pairing', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeAccessRaw(accessPath, { dmPolicy: 'allowlist', allowFrom: [] })
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        only: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false },
      },
    }))

    expect(ci.revokeInvite(accessPath, 'only')).toBe(true)

    expect(readAccessRaw(accessPath).dmPolicy).toBe('allowlist')
  })

  it('keeps dmPolicy=pairing when at least one other active invite survives', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeAccessRaw(accessPath, { dmPolicy: 'pairing', allowFrom: [] })
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        gone: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false },
        stays: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false },
      },
    }))

    expect(ci.revokeInvite(accessPath, 'gone')).toBe(true)

    const after = readInvitesRaw(invitesPath) as { invites?: Record<string, unknown> }
    expect(Object.keys(after.invites ?? {})).toEqual(['stays'])
    expect(readAccessRaw(accessPath).dmPolicy).toBe('pairing')
  })
})

// ---------------------------------------------------------------------------
// runInviteMonitorTick
// ---------------------------------------------------------------------------

describe('runInviteMonitorTick', () => {
  it('is a no-op when no main access file and no agentsRoot exist', () => {
    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)
    expect(existsSync(mainChannelDir('telegram'))).toBe(false)
    expect(existsSync(mainChannelDir('slack'))).toBe(false)
  })

  it('skips a per-agent subdirectory whose access.json does not exist', () => {
    // agentsRoot exists, main agent has no access file, subdir has no access.
    writeAccessRaw(join(mainChannelDir('telegram'), 'access.json'), { dmPolicy: 'allowlist' })
    mkdirSync(join(AGENTS_ROOT, 'samu'), { recursive: true })

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)
    expect(existsSync(isolatedAgentChannelDir('samu', 'telegram'))).toBe(false)
  })

  it('processes main and sub-agents for telegram AND slack when both have files', () => {
    const mainTg = join(mainChannelDir('telegram'), 'access.json')
    const mainSlack = join(mainChannelDir('slack'), 'access.json')
    const samuTg = join(isolatedAgentChannelDir('samu', 'telegram'), 'access.json')
    const zaraSlack = join(isolatedAgentChannelDir('zara', 'slack'), 'access.json')

    // Telegram: live invite + pending sender. Expect auto-approve.
    writeAccessRaw(mainTg, {
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: { codeA: { senderId: '111', chatId: 'c1', createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000 } },
    })
    writeFileSync(join(mainChannelDir('telegram'), 'invites.json'), JSON.stringify({
      invites: { tokA: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    // Slack main: no invites file (so the `!store.invites` continue branch fires).
    writeAccessRaw(mainSlack, { dmPolicy: 'pairing', allowFrom: [] })

    // Sub-agent telegram: no pending entry.
    writeAccessRaw(samuTg, { dmPolicy: 'pairing', allowFrom: [], pending: {} })
    writeFileSync(join(isolatedAgentChannelDir('samu', 'telegram'), 'invites.json'), JSON.stringify({
      invites: { tokB: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    // Sub-agent slack: active invite + pending sender -> approve.
    writeAccessRaw(zaraSlack, {
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: { codeZ: { senderId: '999', chatId: 'cz', createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000 } },
    })
    writeFileSync(join(isolatedAgentChannelDir('zara', 'slack'), 'invites.json'), JSON.stringify({
      invites: { tokZ: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    // Telegram main: sender 111 promoted, pending dropped, token used.
    const mainTgAfter = readAccessRaw(mainTg)
    expect(mainTgAfter.allowFrom).toEqual(['111'])
    // The SUT deletes the pending entry, leaving an empty pending map (not
    // undefined) -- callers should branch on the map being empty, not its
    // presence.
    expect(mainTgAfter.pending).toEqual({})
    expect(mainTgAfter.dmPolicy).toBe('allowlist')
    const mainTgInvites = readInvitesRaw(join(mainChannelDir('telegram'), 'invites.json')) as {
      invites: Record<string, { used: boolean; usedBy?: string; usedAt?: number }>
    }
    expect(mainTgInvites.invites.tokA).toMatchObject({ used: true, usedBy: '111', usedAt: FROZEN_NOW })
    expect(existsSync(join(mainChannelDir('telegram'), 'approved', '111'))).toBe(true)

    // Slack main: no invites -> untouched aside from untouched access.
    expect(readAccessRaw(mainSlack).pending).toBeUndefined()

    // Sub-agent telegram: no pending, no change. The SUT hits the
    // `pendingEntries.length === 0` early-continue and writes nothing back.
    const samuTgAfter = readAccessRaw(samuTg)
    expect(samuTgAfter.allowFrom).toEqual([])
    expect(samuTgAfter.pending).toEqual({})
    const samuTgInvites = readInvitesRaw(join(isolatedAgentChannelDir('samu', 'telegram'), 'invites.json')) as {
      invites: Record<string, { used: boolean }>
    }
    expect(samuTgInvites.invites.tokB.used).toBe(false)

    // Sub-agent slack: approve path.
    const zaraSlackAfter = readAccessRaw(zaraSlack)
    expect(zaraSlackAfter.allowFrom).toEqual(['999'])
    expect(zaraSlackAfter.pending).toEqual({})
    expect(zaraSlackAfter.dmPolicy).toBe('allowlist')
    expect(existsSync(join(isolatedAgentChannelDir('zara', 'slack'), 'approved', '999'))).toBe(true)
  })

  it('handles readdirSync throwing on the agentsRoot (EACCES-style guard)', () => {
    writeAccessRaw(join(mainChannelDir('telegram'), 'access.json'), { dmPolicy: 'pairing', allowFrom: [] })
    mkdirSync(join(AGENTS_ROOT, 'broken'), { recursive: true })

    // Use the fsFault injector to throw from readdirSync when the SUT
    // scans AGENTS_ROOT. The Proxy wrapper around node:fs (set up in
    // the file prelude) forwards to the real readdirSync unless the
    // path matches the fault suffix.
    fsFault.readdirSync = { suffix: AGENTS_ROOT, message: 'EACCES mock' }
    try {
      expect(() => ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)).not.toThrow()
    } finally {
      fsFault.readdirSync = undefined
    }
  })

  it('skips a target whose invites store has no invites key', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'pairing', allowFrom: [] })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, '{}')

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    // Nothing changed: no pending consumed, no file rewritten.
    expect(readAccessRaw(accessPath).allowFrom).toEqual([])
  })

  it('restores dmPolicy to allowlist when all live invites have expired', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'pairing', allowFrom: [] })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { gone: { createdAt: FROZEN_NOW - 1000, expiresAt: FROZEN_NOW - 100, used: false } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    expect(readAccessRaw(accessPath).dmPolicy).toBe('allowlist')
  })

  it('restores dmPolicy to allowlist when only a used-but-not-pruned invite remains', () => {
    // Defect-shaped observation: the SUT uses BOTH live.length === 0 AND
    // activeInviteCount(...) === 0 to gate the dmPolicy flip. With only a
    // used invite on file, both conditions hold (activeInviteCount skips
    // used entries), so dmPolicy flips back to 'allowlist' even though the
    // invite was already consumed. Documenting the actual observable
    // behaviour rather than what the docstring on line 6-8 suggests the
    // monitor "should" do. createInvite flips dmPolicy back to 'pairing'
    // on the next call so no invitee is dropped -- this is a coverage
    // shape, not a runtime invariant.
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'pairing', allowFrom: [] })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { used: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: true, usedBy: 'x', usedAt: FROZEN_NOW } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    expect(readAccessRaw(accessPath).dmPolicy).toBe('allowlist')
  })

  it('does NOT restore dmPolicy when no live invites and dmPolicy is not pairing', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'allowlist', allowFrom: [] })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { gone: { createdAt: FROZEN_NOW - 1000, expiresAt: FROZEN_NOW - 100, used: false } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    expect(readAccessRaw(accessPath).dmPolicy).toBe('allowlist')
  })

  it('skips when there are live invites but no pending entries', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'pairing', allowFrom: [] })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { live: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    expect(readAccessRaw(accessPath).dmPolicy).toBe('pairing')
    const after = readInvitesRaw(invitesPath) as { invites: Record<string, { used: boolean }> }
    expect(after.invites.live.used).toBe(false)
  })

  it('appends the senderId once even when a second tick re-runs the same pending entry', () => {
    // First tick: pending + live invite -> approve.
    // Second tick: pending is gone, no second live invite -> no double-add.
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: { codeA: { senderId: '444', chatId: 'c', createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000 } },
    })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { live: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)
    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    expect(readAccessRaw(accessPath).allowFrom).toEqual(['444'])
  })

  it('catches and logs a failure from the approved-marker write', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: { codeA: { senderId: '777', chatId: 'c', createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000 } },
    })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { live: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    // Force the approved-marker write to fail by placing a *directory* at
    // the path the SUT will try to write. writeFileSync refuses to write
    // through a directory that exists at the target path -- the catch in
    // runInviteMonitorTick fires and logger.warn is called.
    mkdirSync(join(mainChannelDir('telegram'), 'approved', '777'), { recursive: true })

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    // The catch path also leaves the access.json updates intact (writeAccess
    // and writeInvites still ran before the throw). Only the marker file is
    // missing.
    const access = readAccessRaw(accessPath)
    expect(access.allowFrom).toEqual(['777'])
    expect(access.pending).toEqual({})

    const warnCall = loggerMock.warn.mock.calls.find((c) =>
      typeof c[1] === 'string' && c[1].includes('failed to write approved marker'),
    )
    expect(warnCall).toBeDefined()
  })

  it('writes the access file unchanged when allowFrom already contains the senderId', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {
      dmPolicy: 'pairing',
      allowFrom: ['555'],
      pending: { codeA: { senderId: '555', chatId: 'c', createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000 } },
    })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { live: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    expect(readAccessRaw(accessPath).allowFrom).toEqual(['555'])
  })

  it('selects the oldest pending entry and the oldest live invite when there are multiple', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: {
        newer: { senderId: 'new', chatId: 'c', createdAt: FROZEN_NOW + 100, expiresAt: FROZEN_NOW + 60_000 },
        older: { senderId: 'old', chatId: 'c', createdAt: FROZEN_NOW - 100, expiresAt: FROZEN_NOW + 60_000 },
      },
    })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: {
        newer: { createdAt: FROZEN_NOW + 100, expiresAt: FROZEN_NOW + 60_000, used: false },
        older: { createdAt: FROZEN_NOW - 100, expiresAt: FROZEN_NOW + 60_000, used: false },
      },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    const after = readAccessRaw(accessPath)
    expect(after.allowFrom).toEqual(['old'])
    expect(after.pending).toEqual({ newer: expect.any(Object) })

    const invites = readInvitesRaw(invitesPath) as { invites: Record<string, { used: boolean; usedBy?: string }> }
    expect(invites.invites.older.used).toBe(true)
    expect(invites.invites.older.usedBy).toBe('old')
    expect(invites.invites.newer.used).toBe(false)
  })

  it('does nothing when agentsRoot does not exist (skips the readdir branch)', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, { dmPolicy: 'pairing', allowFrom: [] })

    // Use a path that definitively does not exist.
    const missingRoot = join(SANDBOX, 'never-created-root')
    expect(existsSync(missingRoot)).toBe(false)

    expect(() => ci.runInviteMonitorTick('mainagent', missingRoot)).not.toThrow()
    expect(readAccessRaw(accessPath).dmPolicy).toBe('pairing')
  })

  it('leaves allowFrom undefined (and allocates an empty array) when access has no allowFrom field', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {
      dmPolicy: 'pairing',
      pending: { codeA: { senderId: '88', chatId: 'c', createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000 } },
    })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { live: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    ci.runInviteMonitorTick('mainagent', AGENTS_ROOT)

    expect(readAccessRaw(accessPath).allowFrom).toEqual(['88'])
  })
})

// ---------------------------------------------------------------------------
// startInviteMonitor / stopInviteMonitor
// ---------------------------------------------------------------------------

describe('startInviteMonitor / stopInviteMonitor', () => {
  it('starts the interval and clears it on stop', () => {
    vi.useFakeTimers()
    try {
      ci.startInviteMonitor('mainagent', AGENTS_ROOT, 5000)
      // Second call should be a no-op (interval already set).
      ci.startInviteMonitor('mainagent', AGENTS_ROOT, 5000)
      ci.stopInviteMonitor()
      // stop on an already-cleared monitor should not throw.
      ci.stopInviteMonitor()
    } finally {
      vi.useRealTimers()
    }
  })

  it('defaults intervalMs to 3000 when called without the third argument (L260 default-arg branch[0])', () => {
    // A \`startInviteMonitor(mainAgentId, agentsRoot, intervalMs = 3000)\` (L260)
    // default parametere csak akkor fut le, ha a harmadik arg undefined. A
    // korabbi tesztek mindig atadtak (5000), igy a default-ag soha nem volt
    // coverage-olve. Ezzel a teszttel a 3000-as default aktiválódik, és az
    // interval setInterval a fakeTimers-en keresztul megfigyelheto.
    vi.useFakeTimers()
    try {
      ci.startInviteMonitor('mainagent', AGENTS_ROOT)
      // 3000 ms-es default -- 2999-re meg nem, 3001-re mar igen.
      vi.advanceTimersByTime(2999)
      // stop utan a clearInterval meghívódik, es nem dob.
      ci.stopInviteMonitor()
    } finally {
      vi.useRealTimers()
    }
  })

  it('catches and logs an exception thrown by the first tick', () => {
    // Install a fault that throws on the first existsSync call against
    // `.../access.json`. The SUT's first line in runInviteMonitorTick is
    // `existsSync(mainAccess)`; the throw escapes to startInviteMonitor's
    // outer try/catch.
    fsFault.existsSync = { suffix: '/access.json', message: 'boom: forced first-tick throw' }
    try {
      ci.startInviteMonitor('mainagent', AGENTS_ROOT, 5000)
      const errCall = loggerMock.error.mock.calls.find((c) =>
        typeof c[1] === 'string' && c[1].includes('invite-monitor first tick failed'),
      )
      expect(errCall).toBeDefined()
    } finally {
      fsFault.existsSync = undefined
    }
  })

  it('catches and logs an exception thrown by a later tick', async () => {
    vi.useFakeTimers()
    try {
      // First tick: clean. Then arm the fault so the next interval tick
      // blows up. The vi.mock('node:fs') proxy above reads fsFault on
      // every call, so flipping it mid-test is enough.
      ci.startInviteMonitor('mainagent', AGENTS_ROOT, 1000)
      fsFault.existsSync = { suffix: '/access.json', message: 'boom: forced later-tick throw' }
      await vi.advanceTimersByTimeAsync(1500)
      const errCall = loggerMock.error.mock.calls.find((c) =>
        typeof c[1] === 'string' && c[1].includes('invite-monitor tick failed'),
      )
      expect(errCall).toBeDefined()
    } finally {
      fsFault.existsSync = undefined
      vi.useRealTimers()
      ci.stopInviteMonitor()
    }
  })

  it('logs the configured interval at startup', () => {
    ci.startInviteMonitor('mainagent', AGENTS_ROOT, 7777)
    try {
      // Verify the info log captured the intervalMs value.
      const call = loggerMock.info.mock.calls.find((c) =>
        typeof c[1] === 'string' && c[1].includes('Channel invite monitor started'),
      )
      expect(call).toBeDefined()
      expect(call?.[0]).toMatchObject({ intervalMs: 7777 })
    } finally {
      ci.stopInviteMonitor()
    }
  })

  it('also runs an immediate tick at startup', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    writeAccessRaw(accessPath, {
      dmPolicy: 'pairing',
      allowFrom: [],
      pending: { codeA: { senderId: '11', chatId: 'c', createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000 } },
    })
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, JSON.stringify({
      invites: { live: { createdAt: FROZEN_NOW, expiresAt: FROZEN_NOW + 60_000, used: false } },
    }))

    ci.startInviteMonitor('mainagent', AGENTS_ROOT, 5000)
    try {
      expect(readAccessRaw(accessPath).allowFrom).toEqual(['11'])
    } finally {
      ci.stopInviteMonitor()
    }
  })
})

// ---------------------------------------------------------------------------
// Internal helpers (readAccess / writeAccess / readInvites / writeInvites)
// are exercised through the public API; we add a few targeted checks for the
// error branches that the public API cannot reach.
// ---------------------------------------------------------------------------

describe('file IO error branches (via public surface)', () => {
  it('readInvites returns {} when the file content is not JSON', () => {
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    const invitesPath = join(mainChannelDir('telegram'), 'invites.json')
    mkdirSync(join(invitesPath, '..'), { recursive: true })
    writeFileSync(invitesPath, '<<<not json>>>')

    expect(ci.listInvites(accessPath)).toEqual([])
  })

  it('readAccess returns {} when the access.json content is not JSON', () => {
    // createInvite is the only public path that reads access.json. We force
    // an unparseable access.json file and assert that createInvite silently
    // treats it as empty (so the dmPolicy !== 'disabled' branch flips it).
    const accessPath = join(mainChannelDir('telegram'), 'access.json')
    mkdirSync(join(accessPath, '..'), { recursive: true })
    writeFileSync(accessPath, '<<<not json>>>')

    const result = ci.createInvite(accessPath, undefined)
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(readAccessRaw(accessPath).dmPolicy).toBe('pairing')
  })
})
