// Tests for src/config.ts B.1 — class Config + re-export shim.
//
// Each `it()` asserts ONE Config field with a CONCRETE expected value
// against a fixture .env / config-overrides.json, NOT vacuous
// "is the field defined" assertions (per CLAUDE.md §8 "vacuous test"
// rule). If `Config.fromEnv()` were swapped for `return new Config()`
// with an empty constructor, every one of these assertions would fail.
//
// Sandbox, two redirects:
//   1. `.env` -- CLAUDECLAW_ENV_DIR (src/env.ts:11) is set BEFORE the
//      dynamic import resolves, so readEnvFile() reads a tmpdir .env.
//   2. store/config-overrides.json -- node:fs mock rewrites the ONE
//      config-overrides.json read into a tmpdir store and passes every
//      other path straight through.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PathLike } from 'node:fs'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL } from '../config-registry.js'

// --- node:fs mock: redirect the config-overrides.json read --------------

let overridesRedirect: string | null = null

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  const path = await import('node:path')
  const url = await import('node:url')
  const LIVE_OVERRIDES = path.join(
    path.dirname(url.fileURLToPath(import.meta.url)),
    '..',
    '..',
    'store',
    'config-overrides.json',
  )
  const redirect = (p: PathLike): PathLike =>
    typeof p === 'string' && p === LIVE_OVERRIDES && overridesRedirect !== null
      ? path.join(overridesRedirect, 'config-overrides.json')
      : p
  return {
    ...actual,
    existsSync: (p: PathLike): boolean => actual.existsSync(redirect(p)),
    readFileSync: (
      p: PathLike,
      opts?: BufferEncoding | { encoding?: BufferEncoding | null; flag?: string } | null,
    ): string | Buffer => actual.readFileSync(redirect(p), opts),
  }
})

// --- Sandbox lifecycle --------------------------------------------------

type ConfigModule = typeof import('../config.js')
type ConfigInstance = InstanceType<ConfigModule['Config']>

const tempDirs: string[] = []

function trackTempDir(prefix: string): string {
  const dir = mkTempDir(prefix)
  tempDirs.push(dir)
  return dir
}

function writeEnv(envDir: string, env: Record<string, string>): void {
  const body = Object.entries(env)
    .map(([key, value]) => `${key}=${value}`)
    .join('\n')
  writeFileSync(join(envDir, '.env'), body)
}

interface LoadOptions {
  env?: Record<string, string>
  overrides?: Record<string, unknown>
}

async function loadConfig(
  opts: LoadOptions = {},
): Promise<{ mod: ConfigModule; envDir: string }> {
  const envDir = trackTempDir('marveen-config-class-env-')
  writeEnv(envDir, opts.env ?? {})

  const store = trackTempDir('marveen-config-class-store-')
  if (opts.overrides !== undefined) {
    writeFileSync(join(store, 'config-overrides.json'), JSON.stringify(opts.overrides))
  }

  overridesRedirect = store
  process.env.CLAUDECLAW_ENV_DIR = envDir
  vi.resetModules()
  const mod = await import('../config.js')
  return { mod, envDir }
}

function mkTempDir(prefix: string): string {
  const { mkdtempSync } = require('node:fs') as typeof import('node:fs')
  const { tmpdir } = require('node:os') as typeof import('node:os')
  return mkdtempSync(join(tmpdir(), prefix))
}

beforeEach(() => {
  vi.resetModules()
})

afterEach(() => {
  overridesRedirect = null
  delete process.env.CLAUDECLAW_ENV_DIR
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
  vi.resetModules()
})

// =========================================================================
// Class surface — every Config field gets a concrete assertion
// =========================================================================

describe('Config class — field surface', () => {
  it('STORE_DIR ends with /store', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.STORE_DIR.endsWith('/store')).toBe(true)
  })

  it('DB_FILENAME === "claudeclaw.db"', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.DB_FILENAME).toBe('claudeclaw.db')
  })

  it('PID_FILENAME === "claudeclaw.pid"', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.PID_FILENAME).toBe('claudeclaw.pid')
  })

  it('SCHEDULER_TZ_CONFIGURED === undefined when no .env', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.SCHEDULER_TZ_CONFIGURED).toBeUndefined()
  })

  it('APP_TZ === process zone when no .env', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.APP_TZ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('APP_TZ === America/New_York when set in .env', async () => {
    const { mod } = await loadConfig({ env: { SCHEDULER_TZ: 'America/New_York' } })
    expect(mod.config.APP_TZ).toBe('America/New_York')
  })

  it('SCHEDULER_TZ_CONFIGURED === "America/New_York" when set', async () => {
    const { mod } = await loadConfig({ env: { SCHEDULER_TZ: 'America/New_York' } })
    expect(mod.config.SCHEDULER_TZ_CONFIGURED).toBe('America/New_York')
  })

  it('APP_TZ falls back to system zone on invalid SCHEDULER_TZ', async () => {
    const { mod } = await loadConfig({ env: { SCHEDULER_TZ: 'Europe/Budapesst' } })
    expect(mod.config.APP_TZ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
  })

  it('APP_TZ_INVALID captures the rejected zone', async () => {
    const { mod } = await loadConfig({ env: { SCHEDULER_TZ: 'Europe/Budapesst' } })
    expect(mod.config.APP_TZ_INVALID).toBe('Europe/Budapesst')
  })

  it('APP_TZ_INVALID === undefined on the healthy path', async () => {
    const { mod } = await loadConfig({ env: { SCHEDULER_TZ: 'America/New_York' } })
    expect(mod.config.APP_TZ_INVALID).toBeUndefined()
  })

  it('DEFAULT_AGENT_MODEL === DISTRIBUTION_DEFAULT_AGENT_MODEL on empty .env', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.DEFAULT_AGENT_MODEL).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('DEFAULT_AGENT_MODEL === "claude-sonnet-4-6" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { DEFAULT_AGENT_MODEL: 'claude-sonnet-4-6' } })
    expect(mod.config.DEFAULT_AGENT_MODEL).toBe('claude-sonnet-4-6')
  })

  it('TELEGRAM_BOT_TOKEN === "tg-token" when set', async () => {
    const { mod } = await loadConfig({ env: { TELEGRAM_BOT_TOKEN: 'tg-token' } })
    expect(mod.config.TELEGRAM_BOT_TOKEN).toBe('tg-token')
  })

  it('TELEGRAM_BOT_TOKEN === "" when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.TELEGRAM_BOT_TOKEN).toBe('')
  })

  it('ALLOWED_CHAT_ID === "1268077055" when set', async () => {
    const { mod } = await loadConfig({ env: { ALLOWED_CHAT_ID: '1268077055' } })
    expect(mod.config.ALLOWED_CHAT_ID).toBe('1268077055')
  })

  it('SLACK_BOT_TOKEN === "xoxb-test" when set', async () => {
    const { mod } = await loadConfig({ env: { SLACK_BOT_TOKEN: 'xoxb-test' } })
    expect(mod.config.SLACK_BOT_TOKEN).toBe('xoxb-test')
  })

  it('SLACK_APP_TOKEN === "xapp-test" when set', async () => {
    const { mod } = await loadConfig({ env: { SLACK_APP_TOKEN: 'xapp-test' } })
    expect(mod.config.SLACK_APP_TOKEN).toBe('xapp-test')
  })

  it('SLACK_CHANNEL_ID === "C01234ABCDE" when set', async () => {
    const { mod } = await loadConfig({ env: { SLACK_CHANNEL_ID: 'C01234ABCDE' } })
    expect(mod.config.SLACK_CHANNEL_ID).toBe('C01234ABCDE')
  })

  it('OWNER_NAME_PLACEHOLDER === "Owner" (constant)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.OWNER_NAME_PLACEHOLDER).toBe('Owner')
  })

  it('OWNER_NAME === "Ada" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { OWNER_NAME: 'Ada' } })
    expect(mod.config.OWNER_NAME).toBe('Ada')
  })

  it('OWNER_NAME === "Owner" when not set (placeholder fallback)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.OWNER_NAME).toBe('Owner')
  })

  it('OWNER_DRIVE_FOLDER === "drive-folder-id" when set', async () => {
    const { mod } = await loadConfig({ env: { OWNER_DRIVE_FOLDER: 'drive-folder-id' } })
    expect(mod.config.OWNER_DRIVE_FOLDER).toBe('drive-folder-id')
  })

  it('OWNER_DRIVE_FOLDER === "" when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.OWNER_DRIVE_FOLDER).toBe('')
  })

  it('BOT_NAME === "Zed" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { BOT_NAME: 'Zed' } })
    expect(mod.config.BOT_NAME).toBe('Zed')
  })

  it('BOT_NAME === "Marveen" when not set (default)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.BOT_NAME).toBe('Marveen')
  })

  it('BRAND_NAME === "ZedBrand" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { BRAND_NAME: 'ZedBrand' } })
    expect(mod.config.BRAND_NAME).toBe('ZedBrand')
  })

  it('BRAND_NAME falls back to BOT_NAME when BRAND_NAME not set', async () => {
    const { mod } = await loadConfig({ env: { BOT_NAME: 'Zed' } })
    expect(mod.config.BRAND_NAME).toBe('Zed')
  })

  it('MAIN_AGENT_ID === "zed" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { MAIN_AGENT_ID: 'zed' } })
    expect(mod.config.MAIN_AGENT_ID).toBe('zed')
  })

  it('MAIN_AGENT_ID === "marveen" when not set (default)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.MAIN_AGENT_ID).toBe('marveen')
  })

  it('SERVICE_ID === "zedbrand" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { SERVICE_ID: 'zedbrand' } })
    expect(mod.config.SERVICE_ID).toBe('zedbrand')
  })

  it('SERVICE_ID falls back to MAIN_AGENT_ID when not set', async () => {
    const { mod } = await loadConfig({ env: { MAIN_AGENT_ID: 'zed' } })
    expect(mod.config.SERVICE_ID).toBe('zed')
  })

  it('LEGACY_SERVICE_ID === "claudeclaw" (constant)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.LEGACY_SERVICE_ID).toBe('claudeclaw')
  })

  it('LEGACY_APP_SERVICE_LABEL === "com.claudeclaw.app" (constant)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.LEGACY_APP_SERVICE_LABEL).toBe('com.claudeclaw.app')
  })

  it('WEB_PORT === 4321 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { WEB_PORT: '4321' } })
    expect(mod.config.WEB_PORT).toBe(4321)
  })

  it('WEB_PORT === 3420 when not set (default)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.WEB_PORT).toBe(3420)
  })

  it('WEB_HOST === "0.0.0.0" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { WEB_HOST: '0.0.0.0' } })
    expect(mod.config.WEB_HOST).toBe('0.0.0.0')
  })

  it('WEB_HOST === "127.0.0.1" when not set (default)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.WEB_HOST).toBe('127.0.0.1')
  })

  it('KANBAN_AGING_WARN_H === 12 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_AGING_WARN_H: '12' } })
    expect(mod.config.KANBAN_AGING_WARN_H).toBe(12)
  })

  it('KANBAN_AGING_CAUTION_H === 36 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_AGING_CAUTION_H: '36' } })
    expect(mod.config.KANBAN_AGING_CAUTION_H).toBe(36)
  })

  it('KANBAN_AGING_CRITICAL_H === 96 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_AGING_CRITICAL_H: '96' } })
    expect(mod.config.KANBAN_AGING_CRITICAL_H).toBe(96)
  })

  it('KANBAN_AGING_WARN_COLOR === "#111111" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_AGING_WARN_COLOR: '#111111' } })
    expect(mod.config.KANBAN_AGING_WARN_COLOR).toBe('#111111')
  })

  it('KANBAN_WIP_PLANNED === 1 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_WIP_PLANNED: '1' } })
    expect(mod.config.KANBAN_WIP_PLANNED).toBe(1)
  })

  it('KANBAN_WIP_IN_PROGRESS === 2 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_WIP_IN_PROGRESS: '2' } })
    expect(mod.config.KANBAN_WIP_IN_PROGRESS).toBe(2)
  })

  it('KANBAN_WIP_TESTING === 3 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_WIP_TESTING: '3' } })
    expect(mod.config.KANBAN_WIP_TESTING).toBe(3)
  })

  it('KANBAN_WIP_WAITING === 4 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_WIP_WAITING: '4' } })
    expect(mod.config.KANBAN_WIP_WAITING).toBe(4)
  })

  it('KANBAN_WIP_DONE === 5 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_WIP_DONE: '5' } })
    expect(mod.config.KANBAN_WIP_DONE).toBe(5)
  })

  it('KANBAN_WIP_WARN_PCT === 65 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_WIP_WARN_PCT: '65' } })
    expect(mod.config.KANBAN_WIP_WARN_PCT).toBe(65)
  })

  it('KANBAN_WIP_OK_COLOR === "#444444" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_WIP_OK_COLOR: '#444444' } })
    expect(mod.config.KANBAN_WIP_OK_COLOR).toBe('#444444')
  })

  it('DASHBOARD_PUBLIC_URL === "https://dash.example" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { DASHBOARD_PUBLIC_URL: 'https://dash.example' } })
    expect(mod.config.DASHBOARD_PUBLIC_URL).toBe('https://dash.example')
  })

  it('DASHBOARD_PUBLIC_URL === "" when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.DASHBOARD_PUBLIC_URL).toBe('')
  })

  it('DASHBOARD_ALLOWED_ORIGINS preserves the comma-separated list', async () => {
    const { mod } = await loadConfig({ env: { DASHBOARD_ALLOWED_ORIGINS: 'https://a.example,https://b.example' } })
    expect(mod.config.DASHBOARD_ALLOWED_ORIGINS).toBe('https://a.example,https://b.example')
  })

  it('OLLAMA_URL === "http://ollama.example:11434" when set', async () => {
    const { mod } = await loadConfig({ env: { OLLAMA_URL: 'http://ollama.example:11434' } })
    expect(mod.config.OLLAMA_URL).toBe('http://ollama.example:11434')
  })

  it('OLLAMA_URL === "http://localhost:11434" default when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.OLLAMA_URL).toBe('http://localhost:11434')
  })

  it('KANBAN_SWIMLANE_DEFAULT_GROUP === "assignee" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_SWIMLANE_DEFAULT_GROUP: 'assignee' } })
    expect(mod.config.KANBAN_SWIMLANE_DEFAULT_GROUP).toBe('assignee')
  })

  it('KANBAN_SWIMLANE_DEFAULT_GROUP === "priority" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_SWIMLANE_DEFAULT_GROUP: 'priority' } })
    expect(mod.config.KANBAN_SWIMLANE_DEFAULT_GROUP).toBe('priority')
  })

  it('KANBAN_SWIMLANE_DEFAULT_GROUP === "none" default when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.KANBAN_SWIMLANE_DEFAULT_GROUP).toBe('none')
  })

  it('KANBAN_SWIMLANE_DEFAULT_GROUP === "none" on invalid value (fallback)', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_SWIMLANE_DEFAULT_GROUP: 'invalid-group' } })
    expect(mod.config.KANBAN_SWIMLANE_DEFAULT_GROUP).toBe('none')
  })

  it('KANBAN_SWIMLANE_SEPARATOR_COLOR === "#888888" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_SWIMLANE_SEPARATOR_COLOR: '#888888' } })
    expect(mod.config.KANBAN_SWIMLANE_SEPARATOR_COLOR).toBe('#888888')
  })

  it('KANBAN_LABEL_COLORS splits + trims + drops empty entries', async () => {
    const { mod } = await loadConfig({ env: { KANBAN_LABEL_COLORS: '#aaaaaa, #bbbbbb,,#cccccc' } })
    expect(mod.config.KANBAN_LABEL_COLORS).toEqual(['#aaaaaa', '#bbbbbb', '#cccccc'])
  })

  it('KANBAN_LABEL_COLORS defaults to the 6-entry cold-tone palette', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.KANBAN_LABEL_COLORS).toEqual([
      '#3b82f6', '#0ea5e9', '#10b981', '#14b8a6', '#8b5cf6', '#64748b',
    ])
  })

  it('CHANNEL_PROVIDER defaults to "telegram" when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.CHANNEL_PROVIDER).toBe('telegram')
  })

  it('CHANNEL_PROVIDER === "slack" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { CHANNEL_PROVIDER: 'slack', SLACK_BOT_TOKEN: 'xoxb-test' } })
    expect(mod.config.CHANNEL_PROVIDER).toBe('slack')
  })

  it('CHANNEL_TOKEN === slack token when slack provider active', async () => {
    const { mod } = await loadConfig({ env: { CHANNEL_PROVIDER: 'slack', SLACK_BOT_TOKEN: 'xoxb-test' } })
    expect(mod.config.CHANNEL_TOKEN).toBe('xoxb-test')
  })

  it('CHANNEL_CHAT_ID === slack channel id when slack provider active', async () => {
    const { mod } = await loadConfig({ env: { CHANNEL_PROVIDER: 'slack', SLACK_CHANNEL_ID: 'C01234ABCDE' } })
    expect(mod.config.CHANNEL_CHAT_ID).toBe('C01234ABCDE')
  })

  it('CHANNEL_TOKEN === telegram token when telegram provider active', async () => {
    const { mod } = await loadConfig({ env: { TELEGRAM_BOT_TOKEN: 'tg-token' } })
    expect(mod.config.CHANNEL_TOKEN).toBe('tg-token')
  })

  it('RESPAWN_ENABLED === true on RESPAWN_ENABLED=1', async () => {
    const { mod } = await loadConfig({ env: { RESPAWN_ENABLED: '1' } })
    expect(mod.config.RESPAWN_ENABLED).toBe(true)
  })

  it('RESPAWN_ENABLED === false on RESPAWN_ENABLED=0', async () => {
    const { mod } = await loadConfig({ env: { RESPAWN_ENABLED: '0' } })
    expect(mod.config.RESPAWN_ENABLED).toBe(false)
  })

  it('RESPAWN_ENABLED === true on RESPAWN_ENABLED=true', async () => {
    const { mod } = await loadConfig({ env: { RESPAWN_ENABLED: 'true' } })
    expect(mod.config.RESPAWN_ENABLED).toBe(true)
  })

  it('RESPAWN_ENABLED === false on RESPAWN_ENABLED=false', async () => {
    const { mod } = await loadConfig({ env: { RESPAWN_ENABLED: 'false' } })
    expect(mod.config.RESPAWN_ENABLED).toBe(false)
  })

  it('RESPAWN_ENABLED === true on default (no RESPAWN_HOST, no RESPAWN_ENABLED)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.RESPAWN_ENABLED).toBe(true)
  })

  it('HEARTBEAT_INTERVAL_MS === 3600000 (constant)', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.HEARTBEAT_INTERVAL_MS).toBe(3600000)
  })

  it('HEARTBEAT_START_HOUR === 7 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { HEARTBEAT_START_HOUR: '7' } })
    expect(mod.config.HEARTBEAT_START_HOUR).toBe(7)
  })

  it('HEARTBEAT_START_HOUR === 9 default when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.HEARTBEAT_START_HOUR).toBe(9)
  })

  it('HEARTBEAT_AGENT_ENABLED === true on HEARTBEAT_AGENT_ENABLED=yes', async () => {
    const { mod } = await loadConfig({ env: { HEARTBEAT_AGENT_ENABLED: 'yes' } })
    expect(mod.config.HEARTBEAT_AGENT_ENABLED).toBe(true)
  })

  it('HEARTBEAT_AGENT_ENABLED === false default when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.HEARTBEAT_AGENT_ENABLED).toBe(false)
  })

  it('SUBAGENT_INBOX_TEE === true on SUBAGENT_INBOX_TEE=on', async () => {
    const { mod } = await loadConfig({ env: { SUBAGENT_INBOX_TEE: 'on' } })
    expect(mod.config.SUBAGENT_INBOX_TEE).toBe(true)
  })

  it('SUBAGENT_INBOX_TEE === false default when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.SUBAGENT_INBOX_TEE).toBe(false)
  })

  it('SUBAGENT_TELEGRAM_WAKE_ENABLED === true on ...=true', async () => {
    const { mod } = await loadConfig({ env: { SUBAGENT_TELEGRAM_WAKE_ENABLED: 'true' } })
    expect(mod.config.SUBAGENT_TELEGRAM_WAKE_ENABLED).toBe(true)
  })

  it('SUBAGENT_TELEGRAM_WAKE_ENABLED === false default when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.SUBAGENT_TELEGRAM_WAKE_ENABLED).toBe(false)
  })

  it('HEARTBEAT_CALENDAR_ACCOUNT === "ops@example.com" when set', async () => {
    const { mod } = await loadConfig({ env: { HEARTBEAT_CALENDAR_ACCOUNT: 'ops@example.com' } })
    expect(mod.config.HEARTBEAT_CALENDAR_ACCOUNT).toBe('ops@example.com')
  })

  it('HEARTBEAT_END_HOUR === 21 when set in .env', async () => {
    const { mod } = await loadConfig({ env: { HEARTBEAT_END_HOUR: '21' } })
    expect(mod.config.HEARTBEAT_END_HOUR).toBe(21)
  })

  it('HEARTBEAT_END_HOUR === 23 default when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.HEARTBEAT_END_HOUR).toBe(23)
  })

  it('HEARTBEAT_CALENDAR_ID === "primary" when set', async () => {
    const { mod } = await loadConfig({ env: { HEARTBEAT_CALENDAR_ID: 'primary' } })
    expect(mod.config.HEARTBEAT_CALENDAR_ID).toBe('primary')
  })
})

// =========================================================================
// Re-export identity contract (P0 #2 codification)
// =========================================================================

describe('re-export identity contract', () => {
  it('the singleton and the named-export re-export agree on WEB_PORT', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.WEB_PORT).toBe(mod.WEB_PORT)
  })

  it('mutating the singleton does NOT propagate into the named re-export', async () => {
    // The named re-export `export const WEB_PORT = config.WEB_PORT` is
    // FROZEN at module load; later `config.WEB_PORT = ...` does not
    // rebind `WEB_PORT`. vi.spyOn(config, 'X') would mutate the
    // singleton only -- tests today mock the whole module instead.
    const { mod } = await loadConfig()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mod.config as unknown as { WEB_PORT: number }).WEB_PORT = 9999
    expect(mod.WEB_PORT).toBe(3420)
  })

  it('mutating the singleton does NOT propagate into BRAND_NAME re-export', async () => {
    const { mod } = await loadConfig({ env: { BRAND_NAME: 'ZedBrand' } })
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    ;(mod.config as unknown as { BRAND_NAME: string }).BRAND_NAME = 'Hacked'
    expect(mod.BRAND_NAME).toBe('ZedBrand')
  })

  it('the singleton and the named-export re-export agree on RESPAWN_ENABLED', async () => {
    const { mod } = await loadConfig({ env: { RESPAWN_ENABLED: '1' } })
    expect(mod.config.RESPAWN_ENABLED).toBe(mod.RESPAWN_ENABLED)
  })
})

// =========================================================================
// Static methods (pure helpers)
// =========================================================================

describe('Config static methods', () => {
  it('Config.resolveAppTz returns { tz: systemTz } on undefined configured', async () => {
    const { mod } = await loadConfig()
    const systemTz = Intl.DateTimeFormat().resolvedOptions().timeZone
    expect(mod.Config.resolveAppTz(undefined)).toEqual({ tz: systemTz })
  })

  it('Config.resolveAppTz returns { tz, configured } on a valid zone', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.resolveAppTz('America/New_York', 'America/New_York')).toEqual({
      tz: 'America/New_York',
      configured: 'America/New_York',
    })
  })

  it('Config.resolveAppTz returns { tz: systemTz, invalid } on a rejected zone', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.resolveAppTz('Europe/Budapesst', 'America/New_York')).toEqual({
      tz: 'America/New_York',
      invalid: 'Europe/Budapesst',
    })
  })

  it('Config.resolveBrandName falls back to botName on empty/undefined', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.resolveBrandName(undefined, 'Marveen')).toBe('Marveen')
    expect(mod.Config.resolveBrandName('', 'Marveen')).toBe('Marveen')
    expect(mod.Config.resolveBrandName('   ', 'Marveen')).toBe('Marveen')
  })

  it('Config.resolveBrandName returns the trimmed env value when present', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.resolveBrandName('  ZedBrand  ', 'Marveen')).toBe('ZedBrand')
  })

  it('Config.resolveServiceId falls back to mainAgentId when slug is empty', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.resolveServiceId('', 'marveen')).toBe('marveen')
    expect(mod.Config.resolveServiceId('marveen', 'marveen')).toBe('marveen')
  })

  it('Config.resolveServiceId returns the slug when it differs from mainAgentId', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.resolveServiceId('zedbrand', 'marveen')).toBe('zedbrand')
  })

  it('Config.brandSlug derives "marveen" from empty input', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.brandSlug('')).toBe('marveen')
  })

  it('Config.brandSlug lowercases + dashes a normal brand name', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.brandSlug('Zed Brand')).toBe('zed-brand')
  })

  it('Config.appServiceLabel derives "com.<id>.app"', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.appServiceLabel('zed')).toBe('com.zed.app')
  })

  it('Config.launchdStatusPattern contains both the serviceId and the legacy', async () => {
    const { mod } = await loadConfig()
    const pat = mod.Config.launchdStatusPattern('zed')
    expect(pat).toContain('zed')
    expect(pat).toContain('claudeclaw')
    expect(pat.endsWith('$')).toBe(true)
  })

  it('Config.systemdStatusUnits returns 3 distinct entries for an unknown id', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.systemdStatusUnits('zed')).toEqual(['zed-dashboard', 'zed', 'claudeclaw'])
  })

  it('Config.systemdStatusUnits dedups when id already matches the legacy id', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.systemdStatusUnits('claudeclaw')).toEqual(['claudeclaw-dashboard', 'claudeclaw'])
  })
})

// =========================================================================
// Instance methods (per-call env re-reads)
// =========================================================================

describe('Config instance methods — per-call env re-reads', () => {
  it('currentBotName returns the boot-time BOT_NAME when env is unchanged', async () => {
    const { mod } = await loadConfig({ env: { BOT_NAME: 'Zed' } })
    expect(mod.config.currentBotName()).toBe('Zed')
  })

  it('currentBotName returns the placeholder when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.currentBotName()).toBe('Marveen')
  })

  it('currentBrandName falls back to currentBotName when no BRAND_NAME', async () => {
    const { mod } = await loadConfig({ env: { BOT_NAME: 'Zed' } })
    expect(mod.config.currentBrandName()).toBe('Zed')
  })

  it('currentOwnerName returns "Ada" when set in .env', async () => {
    const { mod } = await loadConfig({ env: { OWNER_NAME: 'Ada' } })
    expect(mod.config.currentOwnerName()).toBe('Ada')
  })

  it('currentOwnerName returns "Owner" placeholder when not set', async () => {
    const { mod } = await loadConfig()
    expect(mod.config.currentOwnerName()).toBe('Owner')
  })
})

// =========================================================================
// Singleton surface
// =========================================================================

describe('module exports', () => {
  it('exports the Config class', async () => {
    const { mod } = await loadConfig()
    expect(typeof mod.Config).toBe('function')
    expect(mod.Config.name).toBe('Config')
  })

  it('exports the singleton as `config`', async () => {
    const { mod } = await loadConfig()
    expect(mod.config).toBeInstanceOf(mod.Config)
  })

  it('Config.fromEnv() returns a Config instance', async () => {
    const { mod } = await loadConfig()
    expect(mod.Config.fromEnv()).toBeInstanceOf(mod.Config)
  })

  it('all 10 free function re-exports are present', async () => {
    const { mod } = await loadConfig()
    expect(typeof mod.resolveAppTz).toBe('function')
    expect(typeof mod.resolveBrandName).toBe('function')
    expect(typeof mod.resolveServiceId).toBe('function')
    expect(typeof mod.brandSlug).toBe('function')
    expect(typeof mod.appServiceLabel).toBe('function')
    expect(typeof mod.launchdStatusPattern).toBe('function')
    expect(typeof mod.systemdStatusUnits).toBe('function')
    expect(typeof mod.currentBotName).toBe('function')
    expect(typeof mod.currentBrandName).toBe('function')
    expect(typeof mod.currentOwnerName).toBe('function')
  })

  it('module-level re-exports delegate to the singleton (resolveAppTz)', async () => {
    const { mod } = await loadConfig({ env: { SCHEDULER_TZ: 'America/New_York' } })
    expect(mod.resolveAppTz('America/New_York')).toEqual({
      tz: 'America/New_York',
      configured: 'America/New_York',
    })
  })

  it('module-level currentBotName re-export delegates to the singleton', async () => {
    const { mod } = await loadConfig({ env: { BOT_NAME: 'Zed' } })
    expect(mod.currentBotName()).toBe('Zed')
  })
})

// =========================================================================
// cfg() override layering (parity with config.test.ts)
// =========================================================================

describe('cfg() override layering — class constructor parity', () => {
  it('falls back to .env when no config-overrides.json exists', async () => {
    const { mod } = await loadConfig({ env: { OLLAMA_URL: 'http://from-env:11434' } })
    expect(mod.config.OLLAMA_URL).toBe('http://from-env:11434')
  })

  it('lets config-overrides.json win over .env', async () => {
    const { mod } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434' },
      overrides: { OLLAMA_URL: 'http://from-override:11434' },
    })
    expect(mod.config.OLLAMA_URL).toBe('http://from-override:11434')
  })

  it('ignores a null override and falls through to .env', async () => {
    const { mod } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434' },
      overrides: { OLLAMA_URL: null },
    })
    expect(mod.config.OLLAMA_URL).toBe('http://from-env:11434')
  })

  it('ignores an empty-string override and falls through to .env', async () => {
    const { mod } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434' },
      overrides: { OLLAMA_URL: '' },
    })
    expect(mod.config.OLLAMA_URL).toBe('http://from-env:11434')
  })
})