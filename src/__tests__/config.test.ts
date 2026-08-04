// Tests for src/config.ts.
//
// config.ts is a BOOT-TIME module: almost everything it exports is a `const`
// frozen the moment the module is first imported, resolved from two layers --
// `store/config-overrides.json` (the dashboard Settings page) over `.env`.
// So the only way to exercise the resolution rules is to re-instantiate the
// module once per scenario (`vi.resetModules()` + dynamic import) with a
// different sandbox underneath it.
//
// Sandbox, two redirects:
//
//   1. `.env` -- `CLAUDECLAW_ENV_DIR` (src/env.ts:11) is set BEFORE the dynamic
//      import resolves, so `readEnvFile()` reads a tmpdir `.env` instead of the
//      checkout's. env.ts freezes that path at ITS import time, which is why
//      the hook must be set before, not after.
//
//   2. `store/config-overrides.json` -- config.ts derives `STORE_DIR` from its
//      own `import.meta.url`, so there is no env hook for it. The `node:fs`
//      mock below rewrites reads of that ONE absolute path into a tmpdir store
//      and passes every other path straight through to the real fs. Nothing in
//      the suite ever writes into the checkout's `store/` (2026-07-27 incident:
//      settings-store.test.ts rmSync'd the live config-overrides.json).
//
// Every tmpdir created here is removed in afterEach.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { PathLike } from 'node:fs'
import { writeFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { hostname } from 'node:os'
import { CronExpressionParser } from 'cron-parser'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL } from '../config-registry.js'
import { mkTempDir, mkTempStore, snapshotEnv } from './setup/temp-sandbox.js'

// --- node:fs mock: redirect the ONE config-overrides.json read -------------

/** Tmpdir `store/` the next `readConfigOverrides()` should read from. Null
 *  means "no redirect" (the real path wins), which never happens inside a
 *  test because every scenario goes through `loadConfig`. */
let overridesRedirect: string | null = null

vi.mock('node:fs', async (orig) => {
  const actual = await orig<typeof import('node:fs')>()
  const path = await import('node:path')
  const url = await import('node:url')
  // config.ts: STORE_DIR = join(dirname(config.ts), '..', 'store'). This test
  // file sits one directory deeper, hence the extra '..'.
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

// --- Sandbox lifecycle ----------------------------------------------------

type ConfigModule = typeof import('../config.js')

let envSnapshot: { restore: () => void } | null = null
const tempDirs: string[] = []

/** Fresh tmpdir that afterEach will remove. */
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
  /** `.env` contents for this instance. */
  env?: Record<string, string>
  /** Parsed object written to config-overrides.json. */
  overrides?: Record<string, unknown>
  /** Raw bytes written to config-overrides.json (for the malformed-JSON path).
   *  Wins over `overrides`. */
  overridesRaw?: string
  /** Reuse an existing env dir, so a test can rewrite `.env` between calls
   *  (the per-call `current*Name()` readers). */
  envDir?: string
}

/** Instantiate config.ts against a fresh sandbox. Returns the module plus the
 *  env dir, so a caller can rewrite `.env` underneath the loaded instance. */
async function loadConfig(
  opts: LoadOptions = {},
): Promise<{ config: ConfigModule; envDir: string }> {
  const envDir = opts.envDir ?? trackTempDir('marveen-config-env-')
  writeEnv(envDir, opts.env ?? {})

  const store = mkTempStore('marveen-config-store-')
  tempDirs.push(dirname(store))
  if (opts.overridesRaw !== undefined) {
    writeFileSync(join(store, 'config-overrides.json'), opts.overridesRaw)
  } else if (opts.overrides !== undefined) {
    writeFileSync(join(store, 'config-overrides.json'), JSON.stringify(opts.overrides))
  }

  overridesRedirect = store
  process.env.CLAUDECLAW_ENV_DIR = envDir
  vi.resetModules()
  const config = await import('../config.js')
  return { config, envDir }
}

beforeEach(() => {
  envSnapshot = snapshotEnv()
})

afterEach(() => {
  overridesRedirect = null
  envSnapshot?.restore()
  envSnapshot = null
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  tempDirs.length = 0
  vi.resetModules()
})

// --- Calling the `?? ''` guards on non-optional string params --------------
//
// `brandSlug(raw)` and `resolveServiceId(brandSlug, ...)` both open with
// `(x ?? '')` even though the parameter is typed `string`. That guard is
// reachable only from untyped JS callers, so reach it the same way: through
// the module namespace widened to `unknown`, narrowed by a typeguard. (No
// `as`, no `any` -- project rule.)

type UnknownFn = (...args: readonly unknown[]) => unknown

function isUnknownFn(value: unknown): value is UnknownFn {
  return typeof value === 'function'
}

function callLoose(config: ConfigModule, name: string, ...args: readonly unknown[]): unknown {
  const namespace: Record<string, unknown> = { ...config }
  const fn = namespace[name]
  if (!isUnknownFn(fn)) throw new Error(`config.${name} is not an exported function`)
  return fn(...args)
}

// --- Fixtures -------------------------------------------------------------

/** Every `.env`-backed key config.ts reads, set to a non-default value. Paired
 *  with the empty-`.env` scenario this pins BOTH sides of every `?? default`. */
const FULL_ENV: Record<string, string> = {
  SCHEDULER_TZ: 'America/New_York',
  DEFAULT_AGENT_MODEL: 'claude-sonnet-4-6',
  TELEGRAM_BOT_TOKEN: 'tg-token',
  ALLOWED_CHAT_ID: '1268077055',
  SLACK_BOT_TOKEN: 'xoxb-test',
  SLACK_APP_TOKEN: 'xapp-test',
  SLACK_CHANNEL_ID: 'C01234ABCDE',
  OWNER_NAME: 'Ada',
  OWNER_DRIVE_FOLDER: 'drive-folder-id',
  BOT_NAME: 'Zed',
  BRAND_NAME: 'ZedBrand',
  MAIN_AGENT_ID: 'zed',
  SERVICE_ID: 'zedbrand',
  WEB_PORT: '4321',
  WEB_HOST: '0.0.0.0',
  KANBAN_AGING_WARN_H: '12',
  KANBAN_AGING_CAUTION_H: '36',
  KANBAN_AGING_CRITICAL_H: '96',
  KANBAN_AGING_WARN_COLOR: '#111111',
  KANBAN_AGING_CAUTION_COLOR: '#222222',
  KANBAN_AGING_CRITICAL_COLOR: '#333333',
  KANBAN_WIP_PLANNED: '1',
  KANBAN_WIP_IN_PROGRESS: '2',
  KANBAN_WIP_TESTING: '3',
  KANBAN_WIP_WAITING: '4',
  KANBAN_WIP_DONE: '5',
  KANBAN_WIP_WARN_PCT: '65',
  KANBAN_WIP_OK_COLOR: '#444444',
  KANBAN_WIP_WARN_COLOR: '#555555',
  KANBAN_WIP_FULL_COLOR: '#666666',
  KANBAN_WIP_OVER_COLOR: '#777777',
  DASHBOARD_PUBLIC_URL: 'https://dash.example',
  DASHBOARD_ALLOWED_ORIGINS: 'https://a.example,https://b.example',
  OLLAMA_URL: 'http://ollama.example:11434',
  KANBAN_SWIMLANE_DEFAULT_GROUP: 'assignee',
  KANBAN_SWIMLANE_SEPARATOR_COLOR: '#888888',
  KANBAN_LABEL_COLORS: '#aaaaaa, #bbbbbb',
  CHANNEL_PROVIDER: 'slack',
  RESPAWN_ENABLED: '1',
  HEARTBEAT_START_HOUR: '7',
  HEARTBEAT_END_HOUR: '21',
  HEARTBEAT_AGENT_ENABLED: 'yes',
  SUBAGENT_INBOX_TEE: 'on',
  SUBAGENT_TELEGRAM_WAKE_ENABLED: 'true',
  HEARTBEAT_CALENDAR_ACCOUNT: 'ops@example.com',
  HEARTBEAT_CALENDAR_ID: 'primary',
}

// =========================================================================
// cfg(): config-overrides.json > .env > caller default
// =========================================================================

describe('cfg() override layering', () => {
  it('falls back to .env when no config-overrides.json exists', async () => {
    const { config } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434', DASHBOARD_PUBLIC_URL: 'https://env.example' },
    })
    expect(config.OLLAMA_URL).toBe('http://from-env:11434')
    expect(config.DASHBOARD_PUBLIC_URL).toBe('https://env.example')
  })

  it('falls back to the caller default when neither layer has the key', async () => {
    const { config } = await loadConfig()
    expect(config.OLLAMA_URL).toBe('http://localhost:11434')
    expect(config.DASHBOARD_PUBLIC_URL).toBe('')
    expect(config.DEFAULT_AGENT_MODEL).toBe(DISTRIBUTION_DEFAULT_AGENT_MODEL)
  })

  it('lets config-overrides.json win over .env', async () => {
    const { config } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434', DEFAULT_AGENT_MODEL: 'from-env-model' },
      overrides: { OLLAMA_URL: 'http://from-override:11434', DEFAULT_AGENT_MODEL: 'from-override-model' },
    })
    expect(config.OLLAMA_URL).toBe('http://from-override:11434')
    expect(config.DEFAULT_AGENT_MODEL).toBe('from-override-model')
  })

  it('applies an override even when .env has no such key', async () => {
    const { config } = await loadConfig({
      overrides: { DASHBOARD_PUBLIC_URL: 'https://override-only.example' },
    })
    expect(config.DASHBOARD_PUBLIC_URL).toBe('https://override-only.example')
  })

  it('ignores a null override and falls through to .env', async () => {
    const { config } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434' },
      overrides: { OLLAMA_URL: null },
    })
    expect(config.OLLAMA_URL).toBe('http://from-env:11434')
  })

  it('ignores an empty-string override and falls through to .env', async () => {
    const { config } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434' },
      overrides: { OLLAMA_URL: '' },
    })
    expect(config.OLLAMA_URL).toBe('http://from-env:11434')
  })

  it('ignores an undefined-valued override key and falls through to .env', async () => {
    // JSON.stringify drops an explicit `undefined`, so write the raw bytes to
    // get a key that parses to `undefined`-ish absence alongside a real key.
    const { config } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434' },
      overridesRaw: '{"UNRELATED_KEY":"x"}',
    })
    expect(config.OLLAMA_URL).toBe('http://from-env:11434')
  })

  it('stringifies a non-string override value', async () => {
    const { config } = await loadConfig({
      overrides: { DASHBOARD_PUBLIC_URL: 8080, HEARTBEAT_AGENT_ENABLED: true },
    })
    expect(config.DASHBOARD_PUBLIC_URL).toBe('8080')
    expect(config.HEARTBEAT_AGENT_ENABLED).toBe(true)
  })

  it('treats a malformed config-overrides.json as no overrides at all', async () => {
    const { config } = await loadConfig({
      env: { OLLAMA_URL: 'http://from-env:11434' },
      overridesRaw: '{ this is not json',
    })
    expect(config.OLLAMA_URL).toBe('http://from-env:11434')
  })

  it('routes every requiresRestart key through the override layer', async () => {
    // The whole point of the layer: a value saved on the Settings page must
    // reach the boot-time consts on the next restart, not just the dashboard.
    const { config } = await loadConfig({
      overrides: {
        SCHEDULER_TZ: 'Asia/Tokyo',
        DASHBOARD_PUBLIC_URL: 'https://saved.example',
        OLLAMA_URL: 'http://saved:11434',
        HEARTBEAT_AGENT_ENABLED: '1',
        SUBAGENT_INBOX_TEE: '1',
        SUBAGENT_TELEGRAM_WAKE_ENABLED: '1',
        HEARTBEAT_CALENDAR_ACCOUNT: 'saved@example.com',
        HEARTBEAT_CALENDAR_ID: 'saved-calendar',
        DEFAULT_AGENT_MODEL: 'claude-opus-4-8',
      },
    })
    expect(config.APP_TZ).toBe('Asia/Tokyo')
    expect(config.SCHEDULER_TZ_CONFIGURED).toBe('Asia/Tokyo')
    expect(config.DASHBOARD_PUBLIC_URL).toBe('https://saved.example')
    expect(config.OLLAMA_URL).toBe('http://saved:11434')
    expect(config.HEARTBEAT_AGENT_ENABLED).toBe(true)
    expect(config.SUBAGENT_INBOX_TEE).toBe(true)
    expect(config.SUBAGENT_TELEGRAM_WAKE_ENABLED).toBe(true)
    expect(config.HEARTBEAT_CALENDAR_ACCOUNT).toBe('saved@example.com')
    expect(config.HEARTBEAT_CALENDAR_ID).toBe('saved-calendar')
    expect(config.DEFAULT_AGENT_MODEL).toBe('claude-opus-4-8')
  })

  it('does NOT route the plain .env-only keys through the override layer', async () => {
    // DASHBOARD_ALLOWED_ORIGINS is deliberately a bare env read (not a
    // Settings-page key); an override must not be able to widen the CSRF
    // allowlist behind the operator's back.
    const { config } = await loadConfig({
      env: { DASHBOARD_ALLOWED_ORIGINS: 'https://env-only.example' },
      overrides: { DASHBOARD_ALLOWED_ORIGINS: 'https://evil.example' },
    })
    expect(config.DASHBOARD_ALLOWED_ORIGINS).toBe('https://env-only.example')
  })
})

// =========================================================================
// isUsableCronTz / resolveAppTz
// =========================================================================

describe('resolveAppTz', () => {
  const SYSTEM = 'Europe/Budapest'

  it('reports a valid configured zone as the winner', async () => {
    const { config } = await loadConfig()
    expect(config.resolveAppTz('America/New_York', SYSTEM)).toEqual({
      tz: 'America/New_York',
      configured: 'America/New_York',
    })
  })

  it('falls back to the system zone when unset or empty, with no configured marker', async () => {
    const { config } = await loadConfig()
    expect(config.resolveAppTz(undefined, SYSTEM)).toEqual({ tz: SYSTEM })
    expect(config.resolveAppTz('', SYSTEM)).toEqual({ tz: SYSTEM })
  })

  it('rejects an unusable zone, keeps the system zone, and hands back the rejected value', async () => {
    const { config } = await loadConfig()
    expect(config.resolveAppTz('Europe/Budapesst', SYSTEM)).toEqual({
      tz: SYSTEM,
      invalid: 'Europe/Budapesst',
    })
    // A rejected zone must never be reported as "an operator pinned this" --
    // that would mask the fallback in the startup report.
    expect(config.resolveAppTz('Europe/Budapesst', SYSTEM).configured).toBeUndefined()
  })

  it('defaults systemTz to the process zone when the second argument is omitted', async () => {
    const { config } = await loadConfig()
    expect(config.resolveAppTz(undefined).tz).toBe(
      Intl.DateTimeFormat().resolvedOptions().timeZone,
    )
  })

  it('agrees with cron-parser, the actual consumer, on every input', async () => {
    const { config } = await loadConfig()
    for (const tz of ['UTC', 'Etc/GMT-2', 'Europe/Budapesst', '+02:00', 'Not/AZone']) {
      let consumerAccepts = true
      try {
        CronExpressionParser.parse('0 0 * * *', { tz }).next()
      } catch {
        consumerAccepts = false
      }
      const resolved = config.resolveAppTz(tz, SYSTEM)
      expect(resolved).toEqual(
        consumerAccepts ? { tz, configured: tz } : { tz: SYSTEM, invalid: tz },
      )
    }
  })
})

describe('APP_TZ wiring at boot', () => {
  it('pins a valid SCHEDULER_TZ and leaves APP_TZ_INVALID unset', async () => {
    const { config } = await loadConfig({ env: { SCHEDULER_TZ: 'Asia/Tokyo' } })
    expect(config.APP_TZ).toBe('Asia/Tokyo')
    expect(config.SCHEDULER_TZ_CONFIGURED).toBe('Asia/Tokyo')
    expect(config.APP_TZ_INVALID).toBeUndefined()
  })

  it('degrades a misspelled SCHEDULER_TZ to the process zone instead of scheduling into a void', async () => {
    const { config } = await loadConfig({ env: { SCHEDULER_TZ: 'Europe/Budapesst' } })
    expect(config.APP_TZ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(config.SCHEDULER_TZ_CONFIGURED).toBeUndefined()
    expect(config.APP_TZ_INVALID).toBe('Europe/Budapesst')
  })

  it('uses the process zone when SCHEDULER_TZ is unset', async () => {
    const { config } = await loadConfig()
    expect(config.APP_TZ).toBe(Intl.DateTimeFormat().resolvedOptions().timeZone)
    expect(config.SCHEDULER_TZ_CONFIGURED).toBeUndefined()
    expect(config.APP_TZ_INVALID).toBeUndefined()
  })
})

// =========================================================================
// .env-backed exports: both sides of every `?? default`
// =========================================================================

describe('.env-backed exports', () => {
  it('uses the shipped defaults when .env is empty', async () => {
    const { config } = await loadConfig()

    expect(config.STORE_DIR).toBe(join(config.PROJECT_ROOT, 'store'))
    expect(config.DB_FILENAME).toBe('claudeclaw.db')
    expect(config.PID_FILENAME).toBe('claudeclaw.pid')

    expect(config.TELEGRAM_BOT_TOKEN).toBe('')
    expect(config.ALLOWED_CHAT_ID).toBe('')
    expect(config.SLACK_BOT_TOKEN).toBe('')
    expect(config.SLACK_APP_TOKEN).toBe('')
    expect(config.SLACK_CHANNEL_ID).toBe('')

    expect(config.OWNER_NAME).toBe(config.OWNER_NAME_PLACEHOLDER)
    expect(config.OWNER_NAME_PLACEHOLDER).toBe('Owner')
    expect(config.OWNER_DRIVE_FOLDER).toBe('')
    expect(config.BOT_NAME).toBe('Marveen')
    expect(config.BRAND_NAME).toBe('Marveen')
    expect(config.MAIN_AGENT_ID).toBe('marveen')
    expect(config.SERVICE_ID).toBe('marveen')
    expect(config.LEGACY_SERVICE_ID).toBe('claudeclaw')
    expect(config.LEGACY_APP_SERVICE_LABEL).toBe('com.claudeclaw.app')

    expect(config.WEB_PORT).toBe(3420)
    expect(config.WEB_HOST).toBe('127.0.0.1')

    expect(config.KANBAN_AGING_WARN_H).toBe(24)
    expect(config.KANBAN_AGING_CAUTION_H).toBe(72)
    expect(config.KANBAN_AGING_CRITICAL_H).toBe(168)
    expect(config.KANBAN_AGING_WARN_COLOR).toBe('#c9a000')
    expect(config.KANBAN_AGING_CAUTION_COLOR).toBe('#d46b00')
    expect(config.KANBAN_AGING_CRITICAL_COLOR).toBe('#c53030')

    expect(config.KANBAN_WIP_PLANNED).toBe(0)
    expect(config.KANBAN_WIP_IN_PROGRESS).toBe(0)
    expect(config.KANBAN_WIP_TESTING).toBe(0)
    expect(config.KANBAN_WIP_WAITING).toBe(0)
    expect(config.KANBAN_WIP_DONE).toBe(0)
    expect(config.KANBAN_WIP_WARN_PCT).toBe(80)
    expect(config.KANBAN_WIP_OK_COLOR).toBe('#6b7280')
    expect(config.KANBAN_WIP_WARN_COLOR).toBe('#c9a000')
    expect(config.KANBAN_WIP_FULL_COLOR).toBe('#d46b00')
    expect(config.KANBAN_WIP_OVER_COLOR).toBe('#c53030')

    expect(config.DASHBOARD_ALLOWED_ORIGINS).toBe('')
    expect(config.KANBAN_SWIMLANE_DEFAULT_GROUP).toBe('none')
    expect(config.KANBAN_SWIMLANE_SEPARATOR_COLOR).toBe('')
    expect(config.KANBAN_LABEL_COLORS).toEqual([
      '#3b82f6', '#0ea5e9', '#10b981', '#14b8a6', '#8b5cf6', '#64748b',
    ])

    expect(config.CHANNEL_PROVIDER).toBe('telegram')
    expect(config.CHANNEL_TOKEN).toBe('')
    expect(config.CHANNEL_CHAT_ID).toBe('')

    expect(config.HEARTBEAT_INTERVAL_MS).toBe(60 * 60 * 1000)
    expect(config.HEARTBEAT_START_HOUR).toBe(9)
    expect(config.HEARTBEAT_END_HOUR).toBe(23)
    expect(config.HEARTBEAT_AGENT_ENABLED).toBe(false)
    expect(config.SUBAGENT_INBOX_TEE).toBe(false)
    expect(config.SUBAGENT_TELEGRAM_WAKE_ENABLED).toBe(false)
    expect(config.HEARTBEAT_CALENDAR_ACCOUNT).toBe('')
    expect(config.HEARTBEAT_CALENDAR_ID).toBe('')
  })

  it('takes every value from .env when it is fully populated', async () => {
    const { config } = await loadConfig({ env: FULL_ENV })

    expect(config.TELEGRAM_BOT_TOKEN).toBe('tg-token')
    expect(config.ALLOWED_CHAT_ID).toBe('1268077055')
    expect(config.SLACK_BOT_TOKEN).toBe('xoxb-test')
    expect(config.SLACK_APP_TOKEN).toBe('xapp-test')
    expect(config.SLACK_CHANNEL_ID).toBe('C01234ABCDE')

    expect(config.OWNER_NAME).toBe('Ada')
    expect(config.OWNER_DRIVE_FOLDER).toBe('drive-folder-id')
    expect(config.BOT_NAME).toBe('Zed')
    expect(config.BRAND_NAME).toBe('ZedBrand')
    expect(config.MAIN_AGENT_ID).toBe('zed')
    expect(config.SERVICE_ID).toBe('zedbrand')

    expect(config.WEB_PORT).toBe(4321)
    expect(config.WEB_HOST).toBe('0.0.0.0')

    expect(config.KANBAN_AGING_WARN_H).toBe(12)
    expect(config.KANBAN_AGING_CAUTION_H).toBe(36)
    expect(config.KANBAN_AGING_CRITICAL_H).toBe(96)
    expect(config.KANBAN_AGING_WARN_COLOR).toBe('#111111')
    expect(config.KANBAN_AGING_CAUTION_COLOR).toBe('#222222')
    expect(config.KANBAN_AGING_CRITICAL_COLOR).toBe('#333333')

    expect(config.KANBAN_WIP_PLANNED).toBe(1)
    expect(config.KANBAN_WIP_IN_PROGRESS).toBe(2)
    expect(config.KANBAN_WIP_TESTING).toBe(3)
    expect(config.KANBAN_WIP_WAITING).toBe(4)
    expect(config.KANBAN_WIP_DONE).toBe(5)
    expect(config.KANBAN_WIP_WARN_PCT).toBe(65)
    expect(config.KANBAN_WIP_OK_COLOR).toBe('#444444')
    expect(config.KANBAN_WIP_WARN_COLOR).toBe('#555555')
    expect(config.KANBAN_WIP_FULL_COLOR).toBe('#666666')
    expect(config.KANBAN_WIP_OVER_COLOR).toBe('#777777')

    expect(config.DASHBOARD_PUBLIC_URL).toBe('https://dash.example')
    expect(config.DASHBOARD_ALLOWED_ORIGINS).toBe('https://a.example,https://b.example')
    expect(config.OLLAMA_URL).toBe('http://ollama.example:11434')
    expect(config.KANBAN_SWIMLANE_SEPARATOR_COLOR).toBe('#888888')
    expect(config.KANBAN_LABEL_COLORS).toEqual(['#aaaaaa', '#bbbbbb'])

    expect(config.CHANNEL_PROVIDER).toBe('slack')
    expect(config.CHANNEL_TOKEN).toBe('xoxb-test')
    expect(config.CHANNEL_CHAT_ID).toBe('C01234ABCDE')

    expect(config.HEARTBEAT_START_HOUR).toBe(7)
    expect(config.HEARTBEAT_END_HOUR).toBe(21)
    expect(config.HEARTBEAT_AGENT_ENABLED).toBe(true)
    expect(config.SUBAGENT_INBOX_TEE).toBe(true)
    expect(config.SUBAGENT_TELEGRAM_WAKE_ENABLED).toBe(true)
    expect(config.HEARTBEAT_CALENDAR_ACCOUNT).toBe('ops@example.com')
    expect(config.HEARTBEAT_CALENDAR_ID).toBe('primary')
  })

  it('defaults SERVICE_ID to MAIN_AGENT_ID when only MAIN_AGENT_ID is set', async () => {
    const { config } = await loadConfig({ env: { MAIN_AGENT_ID: 'zed' } })
    expect(config.SERVICE_ID).toBe('zed')
  })

  it('defaults BRAND_NAME to BOT_NAME when only BOT_NAME is set', async () => {
    const { config } = await loadConfig({ env: { BOT_NAME: 'Zed' } })
    expect(config.BRAND_NAME).toBe('Zed')
  })

  // DEFECT PIN -- docs/needs-to-be-fix/config-empty-env-blanks-identity.md
  // `?? default` only fires on an ABSENT key. An empty `BOT_NAME=` line parses
  // to '' (env.ts:37), which is not nullish, so the default is skipped and the
  // whole identity resolves blank -- contradicting config.ts:149, which states
  // "an empty .env line should not blank the brand". resolveBrandName carries
  // the guard; the constants it mirrors do not. Pinned, NOT fixed.
  it('BUG: an empty .env line blanks the identity instead of using the default', async () => {
    const { config } = await loadConfig({
      env: { BOT_NAME: '', BRAND_NAME: '', OWNER_NAME: '', WEB_HOST: '', MAIN_AGENT_ID: '' },
    })
    expect(config.BOT_NAME).toBe('')
    expect(config.BRAND_NAME).toBe('')
    expect(config.OWNER_NAME).toBe('')
    expect(config.WEB_HOST).toBe('')
    expect(config.MAIN_AGENT_ID).toBe('')
    // SERVICE_ID inherits the blank, so the launchd/systemd unit names collapse
    // to "com..app" / "-dashboard".
    expect(config.SERVICE_ID).toBe('')
    expect(config.appServiceLabel(config.SERVICE_ID)).toBe('com..app')

    // The pure helper that documents the intended rule disagrees with the
    // constant it is supposed to mirror -- that gap IS the defect.
    expect(config.resolveBrandName('', 'Marveen')).toBe('Marveen')
  })
})

describe('kanban swimlane + label palette resolution', () => {
  it('accepts the two supported grouping fields', async () => {
    for (const group of ['assignee', 'priority']) {
      const { config } = await loadConfig({ env: { KANBAN_SWIMLANE_DEFAULT_GROUP: group } })
      expect(config.KANBAN_SWIMLANE_DEFAULT_GROUP).toBe(group)
    }
  })

  it('falls back to a flat board for an unrecognised grouping field', async () => {
    const { config } = await loadConfig({ env: { KANBAN_SWIMLANE_DEFAULT_GROUP: 'sprint' } })
    expect(config.KANBAN_SWIMLANE_DEFAULT_GROUP).toBe('none')
  })

  it('trims and drops blank entries from the label palette', async () => {
    const { config } = await loadConfig({ env: { KANBAN_LABEL_COLORS: ' #aaaaaa , ,#bbbbbb ' } })
    expect(config.KANBAN_LABEL_COLORS).toEqual(['#aaaaaa', '#bbbbbb'])
  })

  it('falls back to a single swatch when the palette resolves to nothing', async () => {
    const { config } = await loadConfig({ env: { KANBAN_LABEL_COLORS: ' , , ' } })
    expect(config.KANBAN_LABEL_COLORS).toEqual(['#64748b'])
  })
})

// =========================================================================
// Respawn / keep-alive gate
// =========================================================================

describe('RESPAWN_ENABLED gate', () => {
  it('is on by default so a single-host install needs no config', async () => {
    const { config } = await loadConfig()
    expect(config.RESPAWN_ENABLED).toBe(true)
  })

  it.each(['1', 'true', 'TRUE'])('forces on with RESPAWN_ENABLED=%s', async (value) => {
    const { config } = await loadConfig({ env: { RESPAWN_ENABLED: value } })
    expect(config.RESPAWN_ENABLED).toBe(true)
  })

  it.each(['0', 'false', 'FALSE'])('forces off with RESPAWN_ENABLED=%s', async (value) => {
    const { config } = await loadConfig({ env: { RESPAWN_ENABLED: value } })
    expect(config.RESPAWN_ENABLED).toBe(false)
  })

  it('falls through to the host match when RESPAWN_ENABLED is not a recognised toggle', async () => {
    const { config } = await loadConfig({
      env: { RESPAWN_ENABLED: 'maybe', RESPAWN_HOST: 'definitely-not-this-host' },
    })
    expect(config.RESPAWN_ENABLED).toBe(false)
  })

  it('enables respawn on a host whose name contains RESPAWN_HOST', async () => {
    const { config } = await loadConfig({ env: { RESPAWN_HOST: hostname().toLowerCase() } })
    expect(config.RESPAWN_ENABLED).toBe(true)
  })

  it('disables respawn on a host whose name does not contain RESPAWN_HOST', async () => {
    const { config } = await loadConfig({ env: { RESPAWN_HOST: 'definitely-not-this-host' } })
    expect(config.RESPAWN_ENABLED).toBe(false)
  })

  it('matches RESPAWN_HOST case-insensitively', async () => {
    const { config } = await loadConfig({ env: { RESPAWN_HOST: hostname().toUpperCase() } })
    expect(config.RESPAWN_ENABLED).toBe(true)
  })
})

// =========================================================================
// Pure helpers
// =========================================================================

describe('resolveBrandName', () => {
  it('uses the brand env value when it carries content', async () => {
    const { config } = await loadConfig()
    expect(config.resolveBrandName('Acme', 'Zed')).toBe('Acme')
    expect(config.resolveBrandName('  Acme  ', 'Zed')).toBe('Acme')
  })

  it('falls back to the bot name when the brand env value is unset, empty or blank', async () => {
    const { config } = await loadConfig()
    expect(config.resolveBrandName(undefined, 'Zed')).toBe('Zed')
    expect(config.resolveBrandName('', 'Zed')).toBe('Zed')
    expect(config.resolveBrandName('   ', 'Zed')).toBe('Zed')
  })
})

describe('resolveServiceId', () => {
  it('names the service after the brand slug when it differs from the agent id', async () => {
    const { config } = await loadConfig()
    expect(config.resolveServiceId('zedbrand', 'zed')).toBe('zedbrand')
  })

  it('uses the agent id when the brand slug equals it, is blank, or is absent', async () => {
    const { config } = await loadConfig()
    expect(config.resolveServiceId('zed', 'zed')).toBe('zed')
    expect(config.resolveServiceId('', 'zed')).toBe('zed')
    expect(config.resolveServiceId('   ', 'zed')).toBe('zed')
    // The `?? ''` guard is for untyped (JS) callers.
    expect(callLoose(config, 'resolveServiceId', undefined, 'zed')).toBe('zed')
  })
})

describe('brandSlug', () => {
  it('mirrors the installers NFKD -> ASCII -> dashed-lowercase rule', async () => {
    const { config } = await loadConfig()
    expect(config.brandSlug('Marveen')).toBe('marveen')
    expect(config.brandSlug('Zed Brand')).toBe('zed-brand')
    expect(config.brandSlug('  Zed   Brand!!  ')).toBe('zed-brand')
    expect(config.brandSlug('Zed_Brand.2')).toBe('zed-brand-2')
  })

  it('strips combining marks, keeping the base letter NFKD leaves behind', async () => {
    // NFKD splits "á" into "a" + U+0301; only the mark is dropped, so accented
    // Latin survives as its ASCII base rather than disappearing.
    expect((await loadConfig()).config.brandSlug('Márvéen Őrző')).toBe('marveen-orzo')
  })

  it('falls back to "marveen" when nothing survives the slug rule', async () => {
    const { config } = await loadConfig()
    expect(config.brandSlug('')).toBe('marveen')
    expect(config.brandSlug('***')).toBe('marveen')
    expect(config.brandSlug('日本語')).toBe('marveen')
    expect(callLoose(config, 'brandSlug', undefined)).toBe('marveen')
  })
})

describe('service unit labels', () => {
  it('derives the standalone installers launchd app label from the service id', async () => {
    const { config } = await loadConfig()
    expect(config.appServiceLabel('zedbrand')).toBe('com.zedbrand.app')
    expect(config.appServiceLabel(config.LEGACY_SERVICE_ID)).toBe(config.LEGACY_APP_SERVICE_LABEL)
  })

  it('matches every install shape of the dashboard launchd unit, and nothing adjacent', async () => {
    const { config } = await loadConfig()
    const pattern = config.launchdStatusPattern('zedbrand')
    expect(pattern).toBe('(com\\.zedbrand\\.(app|dashboard)|com\\.claudeclaw\\.app)$')

    const rx = new RegExp(pattern)
    expect(rx.test('123 0 com.zedbrand.app')).toBe(true)
    expect(rx.test('123 0 com.zedbrand.dashboard')).toBe(true)
    expect(rx.test('123 0 com.claudeclaw.app')).toBe(true)
    // Anchored: an ancillary unit must not read as "the dashboard is running".
    expect(rx.test('123 0 com.zedbrand.dashboard-helper')).toBe(false)
    expect(rx.test('123 0 com.zedbrand.appliance')).toBe(false)
    expect(rx.test('123 0 com.zedbrand.channels')).toBe(false)
  })

  it('probes the systemd units newest install shape first', async () => {
    const { config } = await loadConfig()
    expect(config.systemdStatusUnits('zedbrand')).toEqual([
      'zedbrand-dashboard',
      'zedbrand',
      'claudeclaw',
    ])
  })

  it('does not probe the same systemd unit twice on a legacy-id install', async () => {
    const { config } = await loadConfig()
    expect(config.systemdStatusUnits('claudeclaw')).toEqual([
      'claudeclaw-dashboard',
      'claudeclaw',
    ])
  })
})

// =========================================================================
// Per-call display names (wizard rename without a restart)
// =========================================================================

describe('current*Name() read .env per call', () => {
  it('picks up a rename written to .env after the module was loaded', async () => {
    const { config, envDir } = await loadConfig({
      env: { BOT_NAME: 'Zed', BRAND_NAME: 'ZedBrand', OWNER_NAME: 'Ada' },
    })
    expect(config.currentBotName()).toBe('Zed')
    expect(config.currentBrandName()).toBe('ZedBrand')
    expect(config.currentOwnerName()).toBe('Ada')

    writeEnv(envDir, { BOT_NAME: 'Renamed', BRAND_NAME: 'RenamedBrand', OWNER_NAME: 'Grace' })

    expect(config.currentBotName()).toBe('Renamed')
    expect(config.currentBrandName()).toBe('RenamedBrand')
    expect(config.currentOwnerName()).toBe('Grace')
    // The boot-time constants stay frozen -- they key tmux sessions and DB rows.
    expect(config.BOT_NAME).toBe('Zed')
    expect(config.BRAND_NAME).toBe('ZedBrand')
    expect(config.OWNER_NAME).toBe('Ada')
  })

  it('falls back to the boot-time constant when the key is blanked in .env', async () => {
    const { config, envDir } = await loadConfig({
      env: { BOT_NAME: 'Zed', BRAND_NAME: 'ZedBrand', OWNER_NAME: 'Ada' },
    })
    writeEnv(envDir, { BOT_NAME: '', BRAND_NAME: '', OWNER_NAME: '' })

    expect(config.currentBotName()).toBe('Zed')
    expect(config.currentOwnerName()).toBe('Ada')
    // currentBrandName falls back to the LIVE bot name, not to the BRAND_NAME
    // constant -- mirroring `BRAND_NAME = env['BRAND_NAME'] ?? BOT_NAME`.
    expect(config.currentBrandName()).toBe('Zed')
  })

  it('falls back to the boot-time constant when the key is absent from .env', async () => {
    const { config, envDir } = await loadConfig({
      env: { BOT_NAME: 'Zed', BRAND_NAME: 'ZedBrand', OWNER_NAME: 'Ada' },
    })
    writeEnv(envDir, {})

    expect(config.currentBotName()).toBe('Zed')
    expect(config.currentOwnerName()).toBe('Ada')
    expect(config.currentBrandName()).toBe('Zed')
  })

  it('derives currentBrandName from the live bot name when only BOT_NAME is renamed', async () => {
    const { config, envDir } = await loadConfig({ env: { BOT_NAME: 'Zed' } })
    writeEnv(envDir, { BOT_NAME: 'Renamed' })
    expect(config.currentBrandName()).toBe('Renamed')
  })
})
