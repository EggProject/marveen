import { CronExpressionParser } from 'cron-parser'
import { hostname } from 'node:os'
import { join } from 'node:path'
import { DISTRIBUTION_DEFAULT_AGENT_MODEL } from './config-registry.js'
import { readConfigOverrides, resolveConfigValue } from './config-resolution.js'
import { PROJECT_ROOT, STORE_DIR } from './paths.js'
import { getSecret } from './web/vault.js'
import { getProviderType, getChannelToken, getChannelChatId, type ChannelProviderType } from './channel-provider.js'

export { PROJECT_ROOT, STORE_DIR } from './paths.js'
export const DB_FILENAME = 'claudeclaw.db'
export const PID_FILENAME = 'claudeclaw.pid'

const overrides = readConfigOverrides()

// Canonical production settings source. `.env` is accepted only by the explicit
// migration command and never participates in runtime resolution.
function cfg(key: string): string {
  return String(resolveConfigValue(key, overrides))
}

// The single timezone for this install -- drives BOTH cron scheduling (cron.ts)
// AND every human-facing time render (heartbeat, daily-log, memory labels, etc.).
// One env var (SCHEDULER_TZ) so the whole box shares one zone; falls back to the
// process zone (the TZ env / OS) when unset. Replaces the ~15 hardcoded
// 'Europe/Budapest' literals -- change the zone in ONE place, and an update that
// re-introduces a hardcoded literal is caught by a single grep, not a full review.
// Exported separately so the scheduler's startup reporter can tell "an operator
// pinned this zone" apart from "we fell back to the host zone" -- reading
// process.env there cannot distinguish the two, because cfg() layers
// config-overrides.json over .env and neither lands in process.env. See
// resolveCronTz in web/cron.ts.
//
// A MISSPELLED zone is worse than an unset one. cron-parser throws on every
// parse with an unknown tz ("CronDate: unhandled timestamp: Invalid Date"),
// cronDueBetween's catch turns that throw into "not due", and so EVERY
// scheduled task silently never fires -- a total outage with no error, no
// warning, and a startup report that still looks healthy (it would name the
// configured-but-invalid zone as the winning source). The dashboard Settings
// path is fenced -- SCHEDULER_TZ carries a valueSet that validateSettingValue
// enforces -- but a hand-edited .env or a hand-written config-overrides.json
// reaches here unchecked, and hand-editing .env is the documented way to set
// the zone. So validate once at boot, keep scheduling on the process zone
// (degraded but alive, exactly the unset-value behaviour) and hand the
// rejected value to the startup report rather than scheduling into a void.
function isUsableCronTz(tz: string): boolean {
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

export function resolveAppTz(
  configured: string | undefined,
  systemTz: string = Intl.DateTimeFormat().resolvedOptions().timeZone,
): { tz: string; configured?: string; invalid?: string } {
  if (!configured) return { tz: systemTz }
  if (!isUsableCronTz(configured)) return { tz: systemTz, invalid: configured }
  return { tz: configured, configured }
}

const appTz = resolveAppTz(cfg('SCHEDULER_TZ'))
// Only a zone that survived validation counts as "an operator pinned this":
// reporting a rejected value here would tell the operator that the zone the
// scheduler just refused is the one in effect, and would also mask the
// UTC-fallback warning below it (source would read 'SCHEDULER_TZ', never
// 'system-default').
export const SCHEDULER_TZ_CONFIGURED = appTz.configured
export const APP_TZ = appTz.tz
// The configured zone that was REJECTED, if any -- undefined on the healthy
// path. config.ts is imported too early to own a logger (logger imports config
// -> circular), so the loud reporting lives in startScheduleRunner.
export const APP_TZ_INVALID = appTz.invalid

// The model new agents are scaffolded with, and the model the background worker
// sessions run. One key so an install that standardises on a newer model does
// not have to patch three separate literals in src/ (which an update would then
// clobber). Deliberately NOT applied to existing agents: agent-config.json keeps
// whatever model it was created with, so raising this never silently
// reconfigures a running fleet.
export const DEFAULT_AGENT_MODEL = cfg('DEFAULT_AGENT_MODEL') || DISTRIBUTION_DEFAULT_AGENT_MODEL

export const TELEGRAM_BOT_TOKEN = getSecret('TELEGRAM_BOT_TOKEN') ?? ''
export const ALLOWED_CHAT_ID = cfg('ALLOWED_CHAT_ID')

export const SLACK_BOT_TOKEN = getSecret('SLACK_BOT_TOKEN') ?? ''
export const SLACK_APP_TOKEN = getSecret('SLACK_APP_TOKEN') ?? ''
export const SLACK_CHANNEL_ID = cfg('SLACK_CHANNEL_ID')

// Distribution placeholder for an unconfigured owner name. Exported so
// consumers that treat the owner name as PRIVATE data (federation outbound
// scrub) can tell "a real configured name" apart from this generic English
// word -- scrubbing the literal word "owner" false-positives on fixed template
// text like "owner channels".
export const OWNER_NAME_PLACEHOLDER = 'Owner'
export const OWNER_NAME = cfg('OWNER_NAME') || OWNER_NAME_PLACEHOLDER
// Shared Google Drive folder ID the fleet writes deliverables into. Empty by
// default (distribution-safe: no owner-specific folder is baked into a fresh
// install's generated agent CLAUDE.md); configured through the canonical store.
export const OWNER_DRIVE_FOLDER = cfg('OWNER_DRIVE_FOLDER')
export const BOT_NAME = cfg('BOT_NAME') || 'Marveen'

// Product / system brand shown in the dashboard chrome (browser tab title,
// mobile topbar, sidebar, updates page). Kept SEPARATE from BOT_NAME so an
// operator can name the product one thing (BRAND_NAME) and the main agent
// another (BOT_NAME, the agent's display name). Defaults to BOT_NAME -- which
// itself defaults to 'Marveen' -- so an install that sets neither, or only
// BOT_NAME, behaves exactly as before.
export const BRAND_NAME = resolveBrandName(cfg('BRAND_NAME'), BOT_NAME)

// Pure resolution rule for BRAND_NAME, so the default (brandEnv unset =>
// botName) is provable without a live .env. brandEnv is the raw env value
// (undefined / empty when unset). Mirrors the `env['BRAND_NAME'] ?? BOT_NAME`
// above plus an empty-string guard (an empty .env line should not blank the
// brand).
export function resolveBrandName(brandEnv: string | undefined, botName: string): string {
  const b = (brandEnv ?? '').trim()
  return b || botName
}

// Per-call reads of the display names, so a wizard rename shows up on the
// dashboard without a process restart. Service/session identifiers remain boot-
// time constants because they key OS units, tmux sessions and DB rows.
function currentCfg(key: string): string {
  return String(resolveConfigValue(key, readConfigOverrides()))
}

export function currentBotName(): string {
  return currentCfg('BOT_NAME').trim() || BOT_NAME
}
export function currentBrandName(): string {
  return resolveBrandName(currentCfg('BRAND_NAME'), currentBotName())
}
export function currentOwnerName(): string {
  return currentCfg('OWNER_NAME').trim() || OWNER_NAME
}

// Pure derivation of the OS service id from a brand slug and the agent id:
// the brand slug names the service units when it differs from the agent id,
// otherwise the agent id is used. Mirrors the installer's SERVICE_ID choice so
// the default (brandSlug == mainAgentId) is provably label-identical.
export function resolveServiceId(brandSlug: string, mainAgentId: string): string {
  const s = (brandSlug ?? '').trim()
  return s && s !== mainAgentId ? s : mainAgentId
}

// ASCII slug used for agent/service ids, mirroring the install scripts'
// Python NFKD rule: NFKD-normalize, drop non-ASCII, collapse runs of non-
// alphanumerics to a single dash, trim dashes, lowercase, and fall back to
// 'marveen' when the result is empty. Exported so the launchd/systemd label
// derivation is provable for any brand string in one place.
export function brandSlug(raw: string): string {
  const ascii = (raw ?? '')
    .normalize('NFKD')
    // strip combining marks left by NFKD, then any remaining non-ASCII
    .replace(/[̀-ͯ]/g, '')
    .replace(/[^\x00-\x7f]/g, '')
  const slug = ascii.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '').toLowerCase()
  return slug || 'marveen'
}

// Canonical identifier for the main agent in the DB, tmux sessions, plist
// labels, API routing, etc. The installer derives this from BOT_NAME
// (NFKD + ASCII + lowercase dashes). Older installs without this env var
// fall back to "marveen" so nothing breaks when upgrading in place.
export const MAIN_AGENT_ID = cfg('MAIN_AGENT_ID') || 'marveen'

// Identifier the OS service manager uses for the main agent's units (launchd
// label com.<id>.channels / com.<id>.dashboard, systemd <id>-channels, etc.).
// The installer derives this from BRAND_NAME when the operator picks a brand
// distinct from the agent id; otherwise it equals MAIN_AGENT_ID. Defaults to
// MAIN_AGENT_ID here, so an install without SERVICE_ID in its .env (every
// existing install) keeps byte-identical service labels and the recovery path
// (launchctl unload/load, kickstart) still targets the right unit.
export const SERVICE_ID = cfg('SERVICE_ID') || MAIN_AGENT_ID

// Legacy service id from before the OS service units were keyed off SERVICE_ID
// (the project originally shipped as "claudeclaw"). Retained so the standalone
// installer can retire a stale unit on re-run and the status command still
// recognizes a service created by an older install.
export const LEGACY_SERVICE_ID = 'claudeclaw'
export const LEGACY_APP_SERVICE_LABEL = `com.${LEGACY_SERVICE_ID}.app`

// launchd Label for the standalone interactive installer's app process
// (scripts/setup.ts, `npm run setup`). Keyed off SERVICE_ID so a branded
// install names its background service after the brand, matching how
// install-macos.sh already derives its com.<id>.dashboard / .channels units.
export function appServiceLabel(serviceId: string): string {
  return `com.${serviceId}.app`
}

// grep -E alternation matching this install's dashboard/app launchd unit
// regardless of which installer created it: the SERVICE_ID-derived app service
// (com.<id>.app from the standalone installer) or dashboard service
// (com.<id>.dashboard from install-macos.sh), plus the legacy
// "com.claudeclaw.app". The status command uses it so a running dashboard is
// detected on every install shape -- the old check only matched the legacy name
// and silently reported a modern (brand-aware) install as stopped. Anchored
// with a trailing `$` (the launchd Label is the last field of a
// `launchctl list` line) so only the exact unit matches -- an ancillary unit
// whose final segment merely starts with app/dashboard (e.g.
// com.<id>.dashboard-helper, com.<id>.appliance) does NOT count as "the
// dashboard is running". The pattern is used unchanged in both `grep -E` and a
// JS RegExp, so it sticks to features common to both (`$`, groups, `\.`).
// serviceId is an ASCII slug, so no regex escaping is needed.
export function launchdStatusPattern(serviceId: string): string {
  return `(com\\.${serviceId}\\.(app|dashboard)|com\\.${LEGACY_SERVICE_ID}\\.app)$`
}

// systemd --user unit names to probe for the dashboard, newest install shape
// first: install-linux.sh's "<id>-dashboard", the standalone installer's
// "<id>", then the legacy "claudeclaw". The status command reports active if
// any is active. Deduplicated so an id that already equals the legacy id does
// not probe the same unit twice.
export function systemdStatusUnits(serviceId: string): string[] {
  return [...new Set([`${serviceId}-dashboard`, serviceId, LEGACY_SERVICE_ID])]
}

export const WEB_PORT = Number(cfg('WEB_PORT'))

export const WEB_HOST = cfg('WEB_HOST') || '127.0.0.1'

// Kanban card aging visual thresholds (hours since last update) and colours.
// Override per-install via .env; defaults match the design spec (24/72/168h).
export const KANBAN_AGING_WARN_H = Number(cfg('KANBAN_AGING_WARN_H'))
export const KANBAN_AGING_CAUTION_H = Number(cfg('KANBAN_AGING_CAUTION_H'))
export const KANBAN_AGING_CRITICAL_H = Number(cfg('KANBAN_AGING_CRITICAL_H'))
export const KANBAN_AGING_WARN_COLOR = cfg('KANBAN_AGING_WARN_COLOR')
export const KANBAN_AGING_CAUTION_COLOR = cfg('KANBAN_AGING_CAUTION_COLOR')
export const KANBAN_AGING_CRITICAL_COLOR = cfg('KANBAN_AGING_CRITICAL_COLOR')
// Kanban WIP limits per column (0 = unlimited). Override via .env.
// NOTE: these constants are frozen at process start (this module reads .env
// once at import time). The dashboard's Settings page and the /api/marveen
// kanbanWip payload do NOT read these directly anymore -- they resolve
// through settings-store.ts (config-overrides.json > .env > registry
// default) so a value saved in the UI takes effect without a restart. These
// exports stay as the documented .env-only defaults / for any other code
// that genuinely wants the boot-time value.
export const KANBAN_WIP_PLANNED = Number(cfg('KANBAN_WIP_PLANNED'))
export const KANBAN_WIP_IN_PROGRESS = Number(cfg('KANBAN_WIP_IN_PROGRESS'))
export const KANBAN_WIP_TESTING = Number(cfg('KANBAN_WIP_TESTING'))
export const KANBAN_WIP_WAITING = Number(cfg('KANBAN_WIP_WAITING'))
export const KANBAN_WIP_DONE = Number(cfg('KANBAN_WIP_DONE'))
// Utilisation % at which the badge turns yellow (default 80)
export const KANBAN_WIP_WARN_PCT = Number(cfg('KANBAN_WIP_WARN_PCT'))
// Badge colours for each utilisation tier
export const KANBAN_WIP_OK_COLOR = cfg('KANBAN_WIP_OK_COLOR')
export const KANBAN_WIP_WARN_COLOR = cfg('KANBAN_WIP_WARN_COLOR')
export const KANBAN_WIP_FULL_COLOR = cfg('KANBAN_WIP_FULL_COLOR')
export const KANBAN_WIP_OVER_COLOR = cfg('KANBAN_WIP_OVER_COLOR')
// requiresRestart registry keys: read through the override layer so a value
// saved on the Settings page takes effect on the next restart.
export const DASHBOARD_PUBLIC_URL = cfg('DASHBOARD_PUBLIC_URL') ?? ''
// Extra browser origins allowed to make state-changing dashboard requests
// (CORS + CSRF allowlist), comma-separated, e.g. for VPN/LAN addresses that
// aren't covered by WEB_HOST or DASHBOARD_PUBLIC_URL. Empty by default so
// existing installs keep the same allowlist as before. Not a Settings-page
// key, so it stays a plain env read (not routed through the override layer).
export const DASHBOARD_ALLOWED_ORIGINS = cfg('DASHBOARD_ALLOWED_ORIGINS')
export const OLLAMA_URL = cfg('OLLAMA_URL') ?? 'http://localhost:11434'

// Kanban swimlanes: which field the board groups by on first load. Invalid
// values silently fall back to 'none' (flat board) rather than breaking the
// grouping logic on the frontend.
const rawKanbanSwimlaneDefaultGroup = cfg('KANBAN_SWIMLANE_DEFAULT_GROUP')
export const KANBAN_SWIMLANE_DEFAULT_GROUP =
  rawKanbanSwimlaneDefaultGroup === 'assignee' || rawKanbanSwimlaneDefaultGroup === 'priority'
    ? rawKanbanSwimlaneDefaultGroup
    : 'none'
export const KANBAN_SWIMLANE_SEPARATOR_COLOR = cfg('KANBAN_SWIMLANE_SEPARATOR_COLOR')

// Kanban label colour palette (cold tones by default). The label CRUD UI
// offers these as swatches instead of a free-text colour input, so every
// label's colour traces back to this single configurable list rather than
// a hardcoded per-label mapping in the frontend.
const rawKanbanLabelColors = cfg('KANBAN_LABEL_COLORS')
  .split(',')
  .map((c) => c.trim())
  .filter(Boolean)
export const KANBAN_LABEL_COLORS = rawKanbanLabelColors.length > 0 ? rawKanbanLabelColors : ['#64748b']

export const CHANNEL_PROVIDER: ChannelProviderType = getProviderType(cfg('CHANNEL_PROVIDER'))
const channelConfig = {
  TELEGRAM_BOT_TOKEN,
  SLACK_BOT_TOKEN,
  SLACK_APP_TOKEN,
  SLACK_CHANNEL_ID,
  DISCORD_BOT_TOKEN: getSecret('DISCORD_BOT_TOKEN') ?? '',
  DISCORD_CHANNEL_ID: cfg('DISCORD_CHANNEL_ID'),
  GOOGLECHAT_PROJECT_ID: cfg('GOOGLECHAT_PROJECT_ID'),
  GOOGLECHAT_SPACE_ID: cfg('GOOGLECHAT_SPACE_ID'),
  TEAMS_BOT_APP_ID: cfg('TEAMS_BOT_APP_ID'),
  TEAMS_ALLOWED_CONVERSATION_ID: cfg('TEAMS_ALLOWED_CONVERSATION_ID'),
  ALLOWED_CHAT_ID,
}
export const CHANNEL_TOKEN = getChannelToken(CHANNEL_PROVIDER, channelConfig)
export const CHANNEL_CHAT_ID = getChannelChatId(CHANNEL_PROVIDER, channelConfig)

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
const RESPAWN_HOST = cfg('RESPAWN_HOST').toLowerCase()
const RESPAWN_OVERRIDE = cfg('RESPAWN_ENABLED').toLowerCase()
export const RESPAWN_ENABLED =
  RESPAWN_OVERRIDE === '1' || RESPAWN_OVERRIDE === 'true'
    ? true
    : RESPAWN_OVERRIDE === '0' || RESPAWN_OVERRIDE === 'false'
      ? false
      : RESPAWN_HOST
        ? hostname().toLowerCase().includes(RESPAWN_HOST)
        : true

// Heartbeat
export const HEARTBEAT_INTERVAL_MS = 60 * 60 * 1000 // 1 hour
export const HEARTBEAT_START_HOUR = Number(cfg('HEARTBEAT_START_HOUR'))

// Dedicated channel-less `heartbeat` sub-agent (hourly summary worker).
// OFF by default: a fresh or upgrading install must NOT silently spawn a
// sub-agent that reads the operator's calendar and database. Opt in with
// HEARTBEAT_AGENT_ENABLED=1 (it additionally requires the respawn gate
// above, since the heartbeat has to run on exactly one host).
export const HEARTBEAT_AGENT_ENABLED =
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
export const SUBAGENT_INBOX_TEE =
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
export const SUBAGENT_TELEGRAM_WAKE_ENABLED =
  ['1', 'true', 'yes', 'on'].includes((cfg('SUBAGENT_TELEGRAM_WAKE_ENABLED') ?? '').trim().toLowerCase())

// Google Calendar account the heartbeat summarises (next 2h). Empty (the
// default) means the agent uses whatever calendar its MCP server is
// authenticated as, so no personal address is baked into the shipped
// scaffold. Read through cfg() so a value saved from the Settings UI
// (config-overrides.json) actually reaches these boot-time consts on the next
// restart -- with a bare env[] read the dashboard showed the saved value while
// the heartbeat silently never saw it.
export const HEARTBEAT_CALENDAR_ACCOUNT = (cfg('HEARTBEAT_CALENDAR_ACCOUNT') ?? '').trim()
export const HEARTBEAT_END_HOUR = Number(cfg('HEARTBEAT_END_HOUR'))
export const HEARTBEAT_CALENDAR_ID = (cfg('HEARTBEAT_CALENDAR_ID') ?? '').trim()
