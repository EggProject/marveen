import { watch, statSync, readdirSync, type FSWatcher } from 'node:fs'
import { basename, join } from 'node:path'
import { STORE_DIR } from './config.js'
import { logStoreFileEvent } from './db.js'
import { logger, type LoggerLike } from './logger.js'

// --- System file denylist ---
// Only files NOT on this list (and not matching SYSTEM_RE) are logged.
// Everything else = Marveen-managed state that would produce noise.
// "Agent-created" files are those that remain after filtering.
const SYSTEM_FILES = new Set([
  // SQLite database
  'claudeclaw.db', 'claudeclaw.db-wal', 'claudeclaw.db-shm',
  // Marveen runtime / scheduler state
  'schedule-last-run.json', 'external-ops-last-run',
  'kanban-audit-state.json',
  // Settings and config overrides written by dashboard routes
  'config-overrides.json', 'dashboard-settings.json',
  // Fleet and agent management
  'agents-desired.json', 'auto-restart.json', 'autonomy-config.json',
  // Auth and secrets
  '.dashboard-token', '.vault-key', 'vault.json', '.claude-oauth-token',
  // Federation config + inbound peer token (written by /api/federation/peers)
  'federation.json', '.federation-token',
  // Capability-summary cache (written by the capability-summary runner);
  // capability text, not a secret -- deliberately exposed (not denylisted).
  'capability-summaries.json',
  // Usage and keepalive
  'claude-usage.json', '.channel-keepalive', '.channel-last-respawn',
  // Known Marveen-written log files
  'channels.log', 'channels.error.log',
  'dashboard.log', 'dashboard.error.log',
  'update.log',
])

// Regex for system-generated filename patterns.
// Also covers atomic-write temp files (keep in sync with settings-store.ts).
const SYSTEM_RE = /\.pid$|\.tmp$|\.tmp\.[a-f0-9]+$|\.migrated$|\.bak$|^\.DS_Store$/

// --- Dedup window constant ---
// fs.watch fires the same (eventType, filename) multiple times for a single
// logical operation. Collapse repeats within a short window.
const DEDUP_MS = 1000

export class StoreWatcher {
  // FR2 invariant: one instance owns at most one FSWatcher handle.
  // `readonly` enforces the type-level promise; the runtime assertion in
  // `start()` enforces it at start-time.
  private readonly fsWatcher: FSWatcher | null = null
  private readonly storeDir: string
  private readonly log: LoggerLike
  // Agent attribution slot -- consumed by the next watch event.
  private currentWriteActor: string | null = null
  // Known-files set for creation detection; rescan on start() repopulates.
  private knownFiles: Set<string> = new Set()
  // Dedup map survives across stop()/start() on purpose: a 1s window
  // across the lifecycle boundary is fine and matches pre-class behaviour.
  private readonly recentEvents: Map<string, number> = new Map()

  // Arrow-property callback binds `this` lexically at construction time,
  // so the fs.watch handle ALWAYS sees the correct instance even when the
  // module is re-evaluated (FR2 root cause).
  private readonly onFsEvent = (eventType: string, filename: string | null): void => {
    if (!filename) return
    const rel = filename.replace(/\\/g, '/')

    // Consume (clear) the actor slot for ALL events, including system-file
    // events, so a slot set before a denylist-ed write cannot leak to the
    // next unrelated event.
    const agent = this.currentWriteActor
    this.currentWriteActor = null

    // Only rename events can indicate a new file. change = modification.
    if (eventType !== 'rename') return

    // Skip system and temp files -- Marveen's own runtime writes.
    if (StoreWatcher.isSystemFile(rel)) return

    // If the file no longer exists it was deleted or renamed away -- not a creation.
    let fileSize: number | null = null
    try {
      const st = statSync(`${this.storeDir}/${rel}`)
      fileSize = st.size
    } catch {
      // File gone: deletion or rename-away. Update knownFiles and skip.
      this.knownFiles.delete(rel)
      return
    }

    // Already known -> not a new creation (could be a rename-to-same or
    // replace; ignore to avoid false positives).
    if (this.knownFiles.has(rel)) return

    // Dedup: fs.watch may fire the rename event several times.
    const now = Date.now()
    const last = this.recentEvents.get(rel)
    if (last !== undefined && now - last < DEDUP_MS) return
    this.recentEvents.set(rel, now)
    if (this.recentEvents.size > 200) {
      let _dedupPruned = 0
      for (const [k, t] of this.recentEvents) {
        if (now - t >= DEDUP_MS) {
          this.recentEvents.delete(k)
          _dedupPruned += 1
        }
      }
      // Hard-cap fallback: if every entry is still fresh (within DEDUP_MS)
      // the per-entry prune above deleted 0. Without this guard, a sustained
      // burst > DEDUP_MS can grow the Map past 500 with no prune happening.
      if (_dedupPruned === 0 && this.recentEvents.size > 500) {
        this.recentEvents.clear()
      }
    }

    // New file -- record it and mark as known.
    this.knownFiles.add(rel)

    try {
      // Every entry in the historical SENSITIVE_NAMES set (now removed) was
      // also in SYSTEM_FILES, so the isSystemFile filter above already
      // prevents those names from reaching this log call. The is_sensitive
      // flag is therefore always 0 here -- hardcoded to keep the
      // "do not audit secrets" contract.
      logStoreFileEvent(rel, 'create', 0, fileSize, agent)
    } catch (err) {
      this.log.warn({ err, rel }, 'store-watcher: failed to log new file event')
    }
  }

  constructor(deps?: { storeDir?: string; log?: LoggerLike }) {
    // Production: both default to the module-level STORE_DIR + logger.
    // Tests pass overrides via the constructor so vi.mock('../config.js')
    // and vi.mock('../logger.js') still take effect (the constructor's
    // defaults evaluate AFTER vi.mock resolves).
    this.storeDir = deps?.storeDir ?? STORE_DIR
    this.log = deps?.log ?? logger
  }

  start(): void {
    // FR2 fix: strict assertion replaces `if (watcher) return`. The
    // `private readonly` field prevents accidental reassignment; the
    // runtime check catches the calling-start-twice vector and warns.
    if (this.fsWatcher !== null) {
      this.log.warn(
        { storeDir: this.storeDir },
        'store-watcher: start() called twice without stop()',
      )
      return
    }

    this.knownFiles = new Set<string>()
    StoreWatcher.scanStore(this.storeDir, this.knownFiles, '')

    try {
      const handle = watch(this.storeDir, { recursive: true }, this.onFsEvent)
      // Cast-through-unknown reassignment of a readonly field -- the
      // standard TS workaround for `private readonly` fields that the
      // owning class assigns post-construction. Do NOT remove `readonly`
      // to avoid this cast; the FR2 invariant depends on the type-level
      // promise.
      ;(this as unknown as { fsWatcher: FSWatcher }).fsWatcher = handle
      this.log.info(
        { dir: this.storeDir, knownCount: this.knownFiles.size },
        'Store file watcher started',
      )
    } catch (err) {
      this.log.warn({ err }, 'Store file watcher failed to start')
    }
  }

  stop(): void {
    if (this.fsWatcher === null) return
    try { this.fsWatcher.close() } catch { /* best-effort */ }
    ;(this as unknown as { fsWatcher: FSWatcher | null }).fsWatcher = null
  }

  setActor(actor: string): void { this.currentWriteActor = actor }
  clearActor(): void { this.currentWriteActor = null }

  // --- private static helpers ---

  private static isSystemFile(rel: string): boolean {
    const name = basename(rel)
    return SYSTEM_FILES.has(name) || SYSTEM_RE.test(name)
  }

  private static scanStore(dir: string, known: Set<string>, relBase: string): void {
    try {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const rel = relBase ? `${relBase}/${entry.name}` : entry.name
        if (entry.isDirectory() && !entry.isSymbolicLink()) {
          StoreWatcher.scanStore(join(dir, entry.name), known, rel)
        } else {
          known.add(rel)
        }
      }
    } catch { /* non-fatal; store may not exist yet */ }
  }
}

// Module-scope singleton -- per-graph invariant pin. The free functions
// below delegate LITERALLY to this instance; if a future caller constructs
// a separate instance, FR2 leaks across the boundary.
export const storeWatcher = new StoreWatcher()

// Re-export shim -- LITERALLY this shape, not `() => new StoreWatcher().start()`:
//   export function startStoreWatcher(): void { storeWatcher.start() }
// If the shim constructed a fresh instance per call, the singleton and
// the named re-export would diverge and T6 would fail.
export function startStoreWatcher(): void { storeWatcher.start() }
export function stopStoreWatcher(): void { storeWatcher.stop() }
export function setStoreWriteActor(actor: string): void { storeWatcher.setActor(actor) }
export function clearStoreWriteActor(): void { storeWatcher.clearActor() }
