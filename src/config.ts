import { CronExpressionParser } from 'cron-parser'
import { hostname } from 'node:os'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readEnvFile } from './env.js'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL } from './config-registry.js'
import { getProviderType, ChannelEnv, type ChannelProviderType } from './channel-provider.js'
import type { LoggerLike } from './logger.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

// B.1 — class Config wraps the 58 frozen module-level consts and 10 free
// functions. Each named export below becomes a re-export of an instance
// field or a static method, so the 60 importers and 154 vi.mock sites keep
// resolving to the same value through the migration window (B.6 removal).
//
// Re-export identity contract (B.1 spec §"Re-export init sorrend csapda"
// + §"Re-export identity contract"):
// - The singleton `config.X` fields are mutable from inside the class
//   (the 3 instance methods re-read .env per-call) but readonly from
//   outside (TS `readonly` annotation, enforced at compile time).
// - The named re-exports `export const X = config.X` are FROZEN at module
//   load: a later `config.X = ...` does NOT propagate into the re-export
//   binding. vi.mock('../config.js', factory) replaces the WHOLE module
//   so re-export identity does not matter there; a vi.spyOn(config, 'X')
//   would mutate the singleton only, not the re-export -- tests today do
//   the former pattern (162 vi.mock sites, 0 vi.spyOn). If a future test
//   needs spy semantics, it should mock the module rather than spy the
//   instance.
export class Config {
  // -- 58 readonly fields, one per existing `export const` --
  readonly PROJECT_ROOT: string
  readonly STORE_DIR: string
  readonly DB_FILENAME: string
  readonly PID_FILENAME: string
  readonly SCHEDULER_TZ_CONFIGURED: string | undefined
  readonly APP_TZ: string
  readonly APP_TZ_INVALID: string | undefined
  readonly DEFAULT_AGENT_MODEL: string
  readonly TELEGRAM_BOT_TOKEN: string
  readonly ALLOWED_CHAT_ID: string
  readonly SLACK_BOT_TOKEN: string
  readonly SLACK_APP_TOKEN: string
  readonly SLACK_CHANNEL_ID: string
  readonly OWNER_NAME_PLACEHOLDER: string
  readonly OWNER_NAME: string
  readonly OWNER_DRIVE_FOLDER: string
  readonly BOT_NAME: string
  readonly BRAND_NAME: string
  readonly MAIN_AGENT_ID: string
  readonly SERVICE_ID: string
  readonly LEGACY_SERVICE_ID: string
  readonly LEGACY_APP_SERVICE_LABEL: string
  readonly WEB_PORT: number
  readonly WEB_HOST: string
  readonly KANBAN_AGING_WARN_H: number
  readonly KANBAN_AGING_CAUTION_H: number
  readonly KANBAN_AGING_CRITICAL_H: number
  readonly KANBAN_AGING_WARN_COLOR: string
  readonly KANBAN_AGING_CAUTION_COLOR: string
  readonly KANBAN_AGING_CRITICAL_COLOR: string
  readonly KANBAN_WIP_PLANNED: number
  readonly KANBAN_WIP_IN_PROGRESS: number
  readonly KANBAN_WIP_TESTING: number
  readonly KANBAN_WIP_WAITING: number
  readonly KANBAN_WIP_DONE: number
  readonly KANBAN_WIP_WARN_PCT: number
  readonly KANBAN_WIP_OK_COLOR: string
  readonly KANBAN_WIP_WARN_COLOR: string
  readonly KANBAN_WIP_FULL_COLOR: string
  readonly KANBAN_WIP_OVER_COLOR: string
  readonly DASHBOARD_PUBLIC_URL: string
  readonly DASHBOARD_ALLOWED_ORIGINS: string
  readonly OLLAMA_URL: string
  readonly KANBAN_SWIMLANE_DEFAULT_GROUP: 'none' | 'assignee' | 'priority'
  readonly KANBAN_SWIMLANE_SEPARATOR_COLOR: string
  readonly KANBAN_LABEL_COLORS: string[]
  readonly CHANNEL_PROVIDER: ChannelProviderType
  readonly CHANNEL_TOKEN: string
  readonly CHANNEL_CHAT_ID: string
  readonly RESPAWN_ENABLED: boolean
  readonly HEARTBEAT_INTERVAL_MS: number
  readonly HEARTBEAT_START_HOUR: number
  readonly HEARTBEAT_AGENT_ENABLED: boolean
  readonly SUBAGENT_INBOX_TEE: boolean
  readonly SUBAGENT_TELEGRAM_WAKE_ENABLED: boolean
  readonly HEARTBEAT_CALENDAR_ACCOUNT: string
  readonly HEARTBEAT_END_HOUR: number
  readonly HEARTBEAT_CALENDAR_ID: string

  // -- 3 instance methods: per-call env re-reads (formerly free functions,
  //    already instance-shaped -- closed over module-level `env` + `BOT_NAME`,
  //    now close over `this` + `readEnvFile()`) --
  currentBotName(): string {
    const b = (readEnvFile(['BOT_NAME'])['BOT_NAME'] ?? '').trim()
    return b || this.BOT_NAME
  }
  currentBrandName(): string {
    return Config.resolveBrandName(readEnvFile(['BRAND_NAME'])['BRAND_NAME'], this.currentBotName())
  }
  currentOwnerName(): string {
    const o = (readEnvFile(['OWNER_NAME'])['OWNER_NAME'] ?? '').trim()
    return o || this.OWNER_NAME
  }

  // -- 7 static methods: pure helpers, no this-state --
  static resolveAppTz(
    configured: string | undefined,
    systemTz: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
  ): { tz: string; configured?: string; invalid?: string } {
    if (!configured) return { tz: systemTz }
    if (!Config.isUsableCronTz(configured)) return { tz: systemTz, invalid: configured }
    return { tz: configured, configured }
  }
  static resolveBrandName(brandEnv: string | undefined, botName: string): string {
    const b = (brandEnv ?? '').trim()
    return b || botName
  }
  static resolveServiceId(brandSlug: string, mainAgentId: string): string {
    const s = (brandSlug ?? '').trim()
    return s && s !== mainAgentId ? s : mainAgentId
  }
  static brandSlug(raw: string): string {
    const ascii = (raw ?? '')
      .normalize('NFKD')
      .replace(/[̀-ͯ]/g, '')
      .replace(/[^\x00-\x7f]/g, '')
    const slug = ascii.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
    return slug || 'marveen'
  }
  static appServiceLabel(serviceId: string): string {
    return `com.${serviceId}.app`
  }
  static launchdStatusPattern(serviceId: string): string {
    return `(com\\.${serviceId}\\.(app|dashboard)|com\\.claudeclaw\\.app)$`
  }
  static systemdStatusUnits(serviceId: string): string[] {
    return [...new Set([`${serviceId}-dashboard`, serviceId, 'claudeclaw'])]
  }

  // -- factory: singleton construction site --
  //
  // Reads `.env` once via `readEnvFile()` and `config-overrides.json` once
  // via an inline read (the function `readConfigOverrides` referenced STORE_DIR,
  // which is not yet defined when this factory runs at the top of the file).
  // Returns a fully-initialized `Config`. The optional `log` argument lets
  // B.4 inject a `LoggerLike` (per the terv's "logger NEM console fallback"
  // finding); today the constructor logs nothing, the parameter is reserved
  // for the upcoming structured-pino migration.
  static fromEnv(log?: LoggerLike): Config {
    const env = readEnvFile()
    const overridesPath = join(__dirname, '..', 'store', 'config-overrides.json')
    let overrides: Record<string, unknown> = {}
    if (existsSync(overridesPath)) {
      try {
        overrides = JSON.parse(readFileSync(overridesPath, 'utf8')) as Record<string, unknown>
      } catch {
        overrides = {}
      }
    }
    return new Config(env, overrides, log)
  }

  // -- constructor: pure field assignment from the parsed env + overrides
  //    record, no I/O. The isUsableCronTz helper that used to live at
  //    module scope (config.ts:69-83 pre-B.1) is now a private static
  //    method (above). --
  constructor(env: Record<string, string>, overrides: Record<string, unknown>, log?: LoggerLike) {
    const cfg = (key: string): string | undefined => {
      const ov = overrides[key]
      if (ov !== undefined && ov !== null && String(ov).length > 0) return String(ov)
      return env[key]
    }
    const envOr = (key: string, fallback: string): string => (env[key] ?? '').trim() || fallback

    this.PROJECT_ROOT = join(__dirname, '..')
    this.STORE_DIR = join(this.PROJECT_ROOT, 'store')
    this.DB_FILENAME = 'claudeclaw.db'
    this.PID_FILENAME = 'claudeclaw.pid'

    const appTz = Config.resolveAppTz(cfg('SCHEDULER_TZ'))
    this.SCHEDULER_TZ_CONFIGURED = appTz.configured
    this.APP_TZ = appTz.tz
    this.APP_TZ_INVALID = appTz.invalid

    this.DEFAULT_AGENT_MODEL = cfg('DEFAULT_AGENT_MODEL') || DISTRIBUTION_DEFAULT_AGENT_MODEL

    this.TELEGRAM_BOT_TOKEN = env['TELEGRAM_BOT_TOKEN'] ?? ''
    this.ALLOWED_CHAT_ID = env['ALLOWED_CHAT_ID'] ?? ''

    this.SLACK_BOT_TOKEN = env['SLACK_BOT_TOKEN'] ?? ''
    this.SLACK_APP_TOKEN = env['SLACK_APP_TOKEN'] ?? ''
    this.SLACK_CHANNEL_ID = env['SLACK_CHANNEL_ID'] ?? ''

    // Distribution placeholder for an unconfigured owner name. Exported so
    // consumers that treat the owner name as PRIVATE data (federation outbound
    // scrub) can tell "a real configured name" apart from this generic English
    // word -- scrubbing the literal word "owner" false-positives on fixed template
    // text like "owner channels".
    this.OWNER_NAME_PLACEHOLDER = 'Owner'
    this.OWNER_NAME = envOr('OWNER_NAME', this.OWNER_NAME_PLACEHOLDER)
    // Shared Google Drive folder ID the fleet writes deliverables into. Empty by
    // default (distribution-safe: no owner-specific folder is baked into a fresh
    // install's generated agent CLAUDE.md); set OWNER_DRIVE_FOLDER in .env to wire
    // the default shared drive for this install.
    this.OWNER_DRIVE_FOLDER = env['OWNER_DRIVE_FOLDER'] ?? ''
    this.BOT_NAME = envOr('BOT_NAME', 'Marveen')

    // Product / system brand shown in the dashboard chrome (browser tab title,
    // mobile topbar, sidebar, updates page). Kept SEPARATE from BOT_NAME so an
    // operator can name the product one thing (BRAND_NAME) and the main agent
    // another (BOT_NAME, the agent's display name). Defaults to BOT_NAME -- which
    // itself defaults to 'Marveen' -- so an install that sets neither, or only
    // BOT_NAME, behaves exactly as before.
    this.BRAND_NAME = envOr('BRAND_NAME', this.BOT_NAME)

    // Canonical identifier for the main agent in the DB, tmux sessions, plist
    // labels, API routing, etc. The installer derives this from BOT_NAME
    // (NFKD + ASCII + lowercase dashes). Older installs without this env var
    // fall back to "marveen" so nothing breaks when upgrading in place.
    this.MAIN_AGENT_ID = envOr('MAIN_AGENT_ID', 'marveen')

    // Identifier the OS service manager uses for the main agent's units (launchd
    // label com.<id>.channels / com.<id>.dashboard, systemd <id>-channels, etc.).
    // The installer derives this from BRAND_NAME when the operator picks a brand
    // distinct from the agent id; otherwise it equals MAIN_AGENT_ID. Defaults to
    // MAIN_AGENT_ID here, so an install without SERVICE_ID in its .env (every
    // existing install) keeps byte-identical service labels and the recovery path
    // (launchctl unload/load, kickstart) still targets the right unit.
    this.SERVICE_ID = envOr('SERVICE_ID', this.MAIN_AGENT_ID)

    // Legacy service id from before the OS service units were keyed off SERVICE_ID
    // (the project originally shipped as "claudeclaw"). Retained so the standalone
    // installer can retire a stale unit on re-run and the status command still
    // recognizes a service created by an older install.
    this.LEGACY_SERVICE_ID = 'claudeclaw'
    this.LEGACY_APP_SERVICE_LABEL = `com.${this.LEGACY_SERVICE_ID}.app`

    this.WEB_PORT = parseInt(env['WEB_PORT'] ?? '3420', 10)
    this.WEB_HOST = env['WEB_HOST'] ?? '127.0.0.1'

    // Kanban card aging visual thresholds (hours since last update) and colours.
    // Override per-install via .env; defaults match the design spec (24/72/168h).
    this.KANBAN_AGING_WARN_H = parseInt(env['KANBAN_AGING_WARN_H'] ?? '24', 10)
    this.KANBAN_AGING_CAUTION_H = parseInt(env['KANBAN_AGING_CAUTION_H'] ?? '72', 10)
    this.KANBAN_AGING_CRITICAL_H = parseInt(env['KANBAN_AGING_CRITICAL_H'] ?? '168', 10)
    this.KANBAN_AGING_WARN_COLOR = env['KANBAN_AGING_WARN_COLOR'] ?? '#c9a000'
    this.KANBAN_AGING_CAUTION_COLOR = env['KANBAN_AGING_CAUTION_COLOR'] ?? '#d46b00'
    this.KANBAN_AGING_CRITICAL_COLOR = env['KANBAN_AGING_CRITICAL_COLOR'] ?? '#c53030'
    // Kanban WIP limits per column (0 = unlimited). Override via .env.
    // NOTE: these constants are frozen at process start (this module reads .env
    // once at import time). The dashboard's Settings page and the /api/marveen
    // kanbanWip payload do NOT read these directly anymore -- they resolve
    // through settings-store.ts (config-overrides.json > .env > registry
    // default) so a value saved in the UI takes effect without a restart. These
    // exports stay as the documented .env-only defaults / for any other code
    // that genuinely wants the boot-time value.
    this.KANBAN_WIP_PLANNED = parseInt(env['KANBAN_WIP_PLANNED'] ?? '0', 10)
    this.KANBAN_WIP_IN_PROGRESS = parseInt(env['KANBAN_WIP_IN_PROGRESS'] ?? '0', 10)
    this.KANBAN_WIP_TESTING = parseInt(env['KANBAN_WIP_TESTING'] ?? '0', 10)
    this.KANBAN_WIP_WAITING = parseInt(env['KANBAN_WIP_WAITING'] ?? '0', 10)
    this.KANBAN_WIP_DONE = parseInt(env['KANBAN_WIP_DONE'] ?? '0', 10)
    // Utilisation % at which the badge turns yellow (default 80)
    this.KANBAN_WIP_WARN_PCT = parseInt(env['KANBAN_WIP_WARN_PCT'] ?? '80', 10)
    // Badge colours for each utilisation tier
    this.KANBAN_WIP_OK_COLOR = env['KANBAN_WIP_OK_COLOR'] ?? '#6b7280'
    this.KANBAN_WIP_WARN_COLOR = env['KANBAN_WIP_WARN_COLOR'] ?? '#c9a000'
    this.KANBAN_WIP_FULL_COLOR = env['KANBAN_WIP_FULL_COLOR'] ?? '#d46b00'
    this.KANBAN_WIP_OVER_COLOR = env['KANBAN_WIP_OVER_COLOR'] ?? '#c53030'
    // requiresRestart registry keys: read through the override layer so a value
    // saved on the Settings page takes effect on the next restart.
    this.DASHBOARD_PUBLIC_URL = cfg('DASHBOARD_PUBLIC_URL') ?? ''
    // Extra browser origins allowed to make state-changing dashboard requests
    // (CORS + CSRF allowlist), comma-separated, e.g. for VPN/LAN addresses that
    // aren't covered by WEB_HOST or DASHBOARD_PUBLIC_URL. Empty by default so
    // existing installs keep the same allowlist as before. Not a Settings-page
    // key, so it stays a plain env read (not routed through the override layer).
    this.DASHBOARD_ALLOWED_ORIGINS = env['DASHBOARD_ALLOWED_ORIGINS'] ?? ''
    this.OLLAMA_URL = cfg('OLLAMA_URL') ?? 'http://localhost:11434'

    // Kanban swimlanes: which field the board groups by on first load. Invalid
    // values silently fall back to 'none' (flat board) rather than breaking the
    // grouping logic on the frontend.
    const rawKanbanSwimlaneDefaultGroup = env['KANBAN_SWIMLANE_DEFAULT_GROUP'] ?? 'none'
    this.KANBAN_SWIMLANE_DEFAULT_GROUP =
      rawKanbanSwimlaneDefaultGroup === 'assignee' || rawKanbanSwimlaneDefaultGroup === 'priority'
        ? rawKanbanSwimlaneDefaultGroup
        : 'none'
    this.KANBAN_SWIMLANE_SEPARATOR_COLOR = env['KANBAN_SWIMLANE_SEPARATOR_COLOR'] ?? ''

    // Kanban label colour palette (cold tones by default). The label CRUD UI
    // offers these as swatches instead of a free-text colour input, so every
    // label's colour traces back to this single configurable list rather than
    // a hardcoded per-label mapping in the frontend.
    const rawKanbanLabelColors = (env['KANBAN_LABEL_COLORS'] ?? '#3b82f6,#0ea5e9,#10b981,#14b8a6,#8b5cf6,#64748b')
      .split(',')
      .map((c) => c.trim())
      .filter(Boolean)
    this.KANBAN_LABEL_COLORS = rawKanbanLabelColors.length > 0 ? rawKanbanLabelColors : ['#64748b']

    this.CHANNEL_PROVIDER = getProviderType(env['CHANNEL_PROVIDER'])
    this.CHANNEL_TOKEN = new ChannelEnv(env).getToken(this.CHANNEL_PROVIDER)
    this.CHANNEL_CHAT_ID = new ChannelEnv(env).getChatId(this.CHANNEL_PROVIDER)

    // Respawn / keep-alive gate.
    // The in-process channel-plugin monitor (main-agent respawn + sub-agent
    // auto-restart) must run on exactly ONE machine. When the same checkout runs
    // on more than one host (e.g. a dev box alongside the production host), each
    // would independently respawn agents and the two would fight over the same bot
    // tokens / getUpdates slot. Gate it so only the intended host keeps agents alive.
    //   RESPAWN_ENABLED -- "1"/"true" forces on, "0"/"false" forces off
    //   RESPAWN_HOST    -- optional substring matched against the OS hostname; when
    //                      set, respawn is enabled only on a host whose name matches
    // Default (neither set): enabled, so a single-host install needs no config.
    const RESPAWN_HOST = (env['RESPAWN_HOST'] ?? '').toLowerCase()
    const RESPAWN_OVERRIDE = (env['RESPAWN_ENABLED'] ?? '').toLowerCase()
    this.RESPAWN_ENABLED =
      RESPAWN_OVERRIDE === '1' || RESPAWN_OVERRIDE === 'true'
        ? true
        : RESPAWN_OVERRIDE === '0' || RESPAWN_OVERRIDE === 'false'
          ? false
          : RESPAWN_HOST
            ? hostname().toLowerCase().includes(RESPAWN_HOST)
            : true

    // Heartbeat
    this.HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
    this.HEARTBEAT_START_HOUR = parseInt(env['HEARTBEAT_START_HOUR'] ?? '9', 10)

    // Dedicated channel-less `heartbeat` sub-agent (hourly summary worker).
    // OFF by default: a fresh or upgrading install must NOT silently spawn a
    // sub-agent that reads the operator's calendar and database. Opt in with
    // HEARTBEAT_AGENT_ENABLED=1 (it additionally requires the respawn gate
    // above, since the heartbeat has to run on exactly one host).
    this.HEARTBEAT_AGENT_ENABLED =
      ['1', 'true', 'yes', 'on'].includes((cfg('HEARTBEAT_AGENT_ENABLED') ?? '').trim().toLowerCase())

    // Sub-agent Telegram inbox delivery-path tee (opt-in, DEFAULT OFF).
    // When enabled, a telegram sub-agent loads the channel plugin via a per-agent
    // mcp.json wrapped in the inbound-tee (scripts/channel-inbound-tee.mjs), which
    // persists each inbound notification to <state>/inbox-pending.jsonl for the
    // channel-inbox-drain UserPromptSubmit hook to pull into the next turn. This
    // swaps the default `--channels` delivery path, so it is DEFAULT OFF: an install
    // that does not opt in keeps the exact upstream `--channels` behaviour and never
    // writes message content to disk. Enable with SUBAGENT_INBOX_TEE=1 (required for
    // SUBAGENT_TELEGRAM_WAKE_ENABLED to have an inbox to wake on).
    this.SUBAGENT_INBOX_TEE =
      ['1', 'true', 'yes', 'on'].includes((cfg('SUBAGENT_INBOX_TEE') ?? '').trim().toLowerCase())

    // Sub-agent Telegram inbox wake-nudge (opt-in, DEFAULT OFF).
    // The message-router can nudge an idle sub-agent whose derived Telegram inbox
    // (<state>/inbox-pending.jsonl) has stuck inbound messages, so its drain hook
    // fires and claims the backlog. This is the ACTIVE tail of the SUBAGENT_INBOX_TEE
    // delivery path: the tee writer and the UserPromptSubmit drain hook now ship in
    // this repo, but both are gated -- with SUBAGENT_INBOX_TEE off no inbox file is
    // produced and this watcher is a no-op even when enabled. Ships DISABLED so an
    // upstream install sees zero behaviour change and pays no per-tick cost; enable
    // with SUBAGENT_TELEGRAM_WAKE_ENABLED=1 (alongside SUBAGENT_INBOX_TEE=1).
    this.SUBAGENT_TELEGRAM_WAKE_ENABLED =
      ['1', 'true', 'yes', 'on'].includes((cfg('SUBAGENT_TELEGRAM_WAKE_ENABLED') ?? '').trim().toLowerCase())

    // Google Calendar account the heartbeat summarises (next 2h). Empty (the
    // default) means the agent uses whatever calendar its MCP server is
    // authenticated as, so no personal address is baked into the shipped
    // scaffold. Read through cfg() so a value saved from the Settings UI
    // (config-overrides.json) actually reaches these boot-time consts on the next
    // restart -- with a bare env[] read the dashboard showed the saved value while
    // the heartbeat silently never saw it.
    this.HEARTBEAT_CALENDAR_ACCOUNT = (cfg('HEARTBEAT_CALENDAR_ACCOUNT') ?? '').trim()
    this.HEARTBEAT_END_HOUR = parseInt(env['HEARTBEAT_END_HOUR'] ?? '23', 10)
    this.HEARTBEAT_CALENDAR_ID = (cfg('HEARTBEAT_CALENDAR_ID') ?? '').trim()

    // The `log` parameter is reserved for B.4 structured-pino migration
    // (terv "Konkrét belső strukt 4"). Today the constructor produces no log
    // output, so the parameter is unused -- but the import above is required
    // so a future log call does not fall back to console (T2 verifier finding).
    void log
  }

  // -- private static: the cron-tz probe used by resolveAppTz. Inlined into
  //    the class as a static so the module-level helper that lived at
  //    config.ts:69-83 pre-B.1 is encapsulated. --
  private static isUsableCronTz(tz: string): boolean {
    // Probe with the ACTUAL consumer, not with Intl. The two disagree on inputs
    // like "+02:00" -- newer ICU accepts offset strings, older rejects them --
    // so an Intl guard answers a different question than the code it protects,
    // engine-dependently. That divergence between a check and its subject is the
    // exact failure class this patch exists to remove; reproducing it inside the
    // fix would be self-defeating. Whatever cron-parser can schedule against is
    // by definition usable here.
    try {
      CronExpressionParser.parse('0 0 * * *', { tz }).next()
      return true
    } catch {
      return false
    }
  }
}

// Module-scope singleton. All re-export shims point at this instance. The
// export is named `config` (not `Config`) so destructuring like
// `const { WEB_PORT } = await import('./config.js')` still resolves to
// the module's `WEB_PORT` named export, not the singleton.
export const config = Config.fromEnv()

// =========================================================================
// 58 `export const` re-export shims (one per Config field). These survive
// until B.6 (per the B.1 spec §"Re-export identity contract"). Each line
// preserves its original position in the file so cross-file line-number
// references (commit messages, MDs) stay valid.
// =========================================================================

export const PROJECT_ROOT = config.PROJECT_ROOT
export const STORE_DIR = config.STORE_DIR
export const DB_FILENAME = config.DB_FILENAME
export const PID_FILENAME = config.PID_FILENAME

export const SCHEDULER_TZ_CONFIGURED = config.SCHEDULER_TZ_CONFIGURED
export const APP_TZ = config.APP_TZ
// The configured zone that was REJECTED, if any -- undefined on the healthy
// path. config.ts is imported too early to own a logger (logger imports config
// -> circular), so the loud reporting lives in startScheduleRunner.
export const APP_TZ_INVALID = config.APP_TZ_INVALID

export const DEFAULT_AGENT_MODEL = config.DEFAULT_AGENT_MODEL

export const TELEGRAM_BOT_TOKEN = config.TELEGRAM_BOT_TOKEN
export const ALLOWED_CHAT_ID = config.ALLOWED_CHAT_ID

export const SLACK_BOT_TOKEN = config.SLACK_BOT_TOKEN
export const SLACK_APP_TOKEN = config.SLACK_APP_TOKEN
export const SLACK_CHANNEL_ID = config.SLACK_CHANNEL_ID

export const OWNER_NAME_PLACEHOLDER = config.OWNER_NAME_PLACEHOLDER
export const OWNER_NAME = config.OWNER_NAME
export const OWNER_DRIVE_FOLDER = config.OWNER_DRIVE_FOLDER
export const BOT_NAME = config.BOT_NAME
export const BRAND_NAME = config.BRAND_NAME

export const MAIN_AGENT_ID = config.MAIN_AGENT_ID
export const SERVICE_ID = config.SERVICE_ID
export const LEGACY_SERVICE_ID = config.LEGACY_SERVICE_ID
export const LEGACY_APP_SERVICE_LABEL = config.LEGACY_APP_SERVICE_LABEL

export const WEB_PORT = config.WEB_PORT
export const WEB_HOST = config.WEB_HOST

export const KANBAN_AGING_WARN_H = config.KANBAN_AGING_WARN_H
export const KANBAN_AGING_CAUTION_H = config.KANBAN_AGING_CAUTION_H
export const KANBAN_AGING_CRITICAL_H = config.KANBAN_AGING_CRITICAL_H
export const KANBAN_AGING_WARN_COLOR = config.KANBAN_AGING_WARN_COLOR
export const KANBAN_AGING_CAUTION_COLOR = config.KANBAN_AGING_CAUTION_COLOR
export const KANBAN_AGING_CRITICAL_COLOR = config.KANBAN_AGING_CRITICAL_COLOR
export const KANBAN_WIP_PLANNED = config.KANBAN_WIP_PLANNED
export const KANBAN_WIP_IN_PROGRESS = config.KANBAN_WIP_IN_PROGRESS
export const KANBAN_WIP_TESTING = config.KANBAN_WIP_TESTING
export const KANBAN_WIP_WAITING = config.KANBAN_WIP_WAITING
export const KANBAN_WIP_DONE = config.KANBAN_WIP_DONE
export const KANBAN_WIP_WARN_PCT = config.KANBAN_WIP_WARN_PCT
export const KANBAN_WIP_OK_COLOR = config.KANBAN_WIP_OK_COLOR
export const KANBAN_WIP_WARN_COLOR = config.KANBAN_WIP_WARN_COLOR
export const KANBAN_WIP_FULL_COLOR = config.KANBAN_WIP_FULL_COLOR
export const KANBAN_WIP_OVER_COLOR = config.KANBAN_WIP_OVER_COLOR
export const DASHBOARD_PUBLIC_URL = config.DASHBOARD_PUBLIC_URL
export const DASHBOARD_ALLOWED_ORIGINS = config.DASHBOARD_ALLOWED_ORIGINS
export const OLLAMA_URL = config.OLLAMA_URL
export const KANBAN_SWIMLANE_DEFAULT_GROUP = config.KANBAN_SWIMLANE_DEFAULT_GROUP
export const KANBAN_SWIMLANE_SEPARATOR_COLOR = config.KANBAN_SWIMLANE_SEPARATOR_COLOR
export const KANBAN_LABEL_COLORS = config.KANBAN_LABEL_COLORS

export const CHANNEL_PROVIDER = config.CHANNEL_PROVIDER
export const CHANNEL_TOKEN = config.CHANNEL_TOKEN
export const CHANNEL_CHAT_ID = config.CHANNEL_CHAT_ID

export const RESPAWN_ENABLED = config.RESPAWN_ENABLED

export const HEARTBEAT_INTERVAL_MS = config.HEARTBEAT_INTERVAL_MS
export const HEARTBEAT_START_HOUR = config.HEARTBEAT_START_HOUR
export const HEARTBEAT_AGENT_ENABLED = config.HEARTBEAT_AGENT_ENABLED
export const SUBAGENT_INBOX_TEE = config.SUBAGENT_INBOX_TEE
export const SUBAGENT_TELEGRAM_WAKE_ENABLED = config.SUBAGENT_TELEGRAM_WAKE_ENABLED
export const HEARTBEAT_CALENDAR_ACCOUNT = config.HEARTBEAT_CALENDAR_ACCOUNT
export const HEARTBEAT_END_HOUR = config.HEARTBEAT_END_HOUR
export const HEARTBEAT_CALENDAR_ID = config.HEARTBEAT_CALENDAR_ID

// =========================================================================
// 10 `export function` re-export shims (7 statics + 3 instance methods).
// Static methods are bound to `Config` so `this` resolves correctly even
// when callers destructure with `.bind(...)` later; instance methods close
// over the module-scope singleton via an arrow wrapper, because the named
// export must read fresh .env values via `config.currentBotName()` (not via
// a stale this).
// =========================================================================

export const resolveAppTz = Config.resolveAppTz.bind(Config)
export const resolveBrandName = Config.resolveBrandName.bind(Config)
export const resolveServiceId = Config.resolveServiceId.bind(Config)
export const brandSlug = Config.brandSlug.bind(Config)
export const appServiceLabel = Config.appServiceLabel.bind(Config)
export const launchdStatusPattern = Config.launchdStatusPattern.bind(Config)
export const systemdStatusUnits = Config.systemdStatusUnits.bind(Config)
export const currentBotName = (): string => config.currentBotName()
export const currentBrandName = (): string => config.currentBrandName()
export const currentOwnerName = (): string => config.currentOwnerName()