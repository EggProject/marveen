// Filesystem-level cleanup helpers used by `commands/uninstall.ts`.
//
// Each helper removes one concrete install artifact and exports a small
// pure function next to it (`*Exists`, `*Lines`) so the uninstall
// command and the backup helper can query state without re-implementing
// the file-locations the legacy shell installer chose.
//
// The helpers are CONSERVATIVE on purpose: they swallow ENOENT and
// EACCES (after marking them in the result so the operator can see
// what was missing) and they never touch anything that is not listed
// in the plan section 13 (legacy installer provenance audit).

import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir as osHomedir } from 'node:os'

// Test-only seam so the unit tests can swap the HOME directory without
// reaching into node:os directly (which is bound at module-load time).
let _homedir: () => string = () => osHomedir()
export function setHomedirForTests(fn: () => string): void {
  _homedir = fn
}
export function resetHomedirForTests(): void {
  _homedir = () => osHomedir()
}
function homedir(): string { return _homedir() }

export interface CleanupResult {
  /** Human-readable label of the artifact. */
  label: string
  /** Absolute path of the artifact that was acted upon. */
  path: string
  /** True if something was actually removed, false if it was missing. */
  removed: boolean
  /** Best-effort error message if the helper failed. */
  error?: string
}

/** The 4 RC export lines the legacy installer guaranteed to append. */
export const RC_MARKERS = [
  '.local/bin',
  'BUN_INSTALL',
  '.bun/bin',
  'DISABLE_AUTOUPDATER',
] as const

/**
 * Detect Marveen lines in $HOME/.bashrc and $HOME/.zshrc and rewrite
 * each file with those lines stripped. Returns the count of lines
 * removed across all RC files for logging.
 *
 * Backup semantics: the original file is moved to `<file>.marveen.bak`
 * before the rewrite so the operator can `mv .bashrc.marveen.bak .bashrc`
 * later if they discover they need one of the removed exports.
 */
export function stripRcMarveenLines(): { removedLines: number; files: CleanupResult[] } {
  const files: CleanupResult[] = []
  let removedLines = 0
  for (const name of ['.bashrc', '.zshrc'] as const) {
    const path = join(homedir(), name)
    if (!existsSync(path)) {
      files.push({ label: `${name}`, path, removed: false })
      continue
    }
    const content = readFileSync(path, 'utf-8')
    const before = content.split('\n').length
    const kept = content.split('\n').filter((line) => !isMarveenLineForStrip(line)).join('\n')
    const after = kept.split('\n').length
    removedLines += before - after
    if (kept === content) {
      files.push({ label: `${name}`, path, removed: false })
      continue
    }
    const bakPath = `${path}.marveen.bak`
    writeFileSync(bakPath, content, 'utf-8')
    writeFileSync(path, kept, 'utf-8')
    files.push({ label: `${name}`, path, removed: true })
    void existsSync(bakPath)
  }
  return { removedLines, files }
}

function isMarveenLineForStrip(line: string): boolean {
  return isMarveenLine(line)
}

/** Helper used by tests to assert which lines would be stripped. */
export function isMarveenLine(line: string): boolean {
  const trimmed = line.trim()
  if (trimmed === '' || trimmed.startsWith('#')) return false
  return RC_MARKERS.some((marker) => trimmed.includes(marker))
}

/**
 * Remove $INSTALL_DIR/.env. Mirrors the legacy installer's
 * `env_merge_key` semantics: the WHOLE file is deleted, not individual
 * keys. The user accepted this trade-off knowing that any third-party
 * keys they wrote into .env (TELEGRAM_BOT_TOKEN, OWNER_NAME override)
 * are also lost.
 */
export function removeInstallDirEnv(envPath: string): CleanupResult {
  if (!existsSync(envPath)) return { label: '.env', path: envPath, removed: false }
  try {
    rmSync(envPath, { force: true })
    return { label: '.env', path: envPath, removed: true }
  } catch (err: unknown) {
    return { label: '.env', path: envPath, removed: false, error: (err as Error).message }
  }
}

/** Remove `store/.claude-oauth-token` (legacy OAuth split-storage). */
export function removeOAuthTokenFile(tokenPath: string): CleanupResult {
  if (!existsSync(tokenPath)) return { label: '.claude-oauth-token', path: tokenPath, removed: false }
  rmSync(tokenPath, { force: true })
  return { label: '.claude-oauth-token', path: tokenPath, removed: true }
}

/** Remove the entire `store/` directory tree. */
export function removeStoreDir(storePath: string): CleanupResult {
  if (!existsSync(storePath)) return { label: 'store/', path: storePath, removed: false }
  rmSync(storePath, { recursive: true, force: true })
  return { label: 'store/', path: storePath, removed: true }
}

/** Remove `seed-scheduled-tasks/bumblebee-hygiene-scan.{cron,json}`. */
export function removeBumblebeeSeeds(seedDir: string): CleanupResult[] {
  const out: CleanupResult[] = []
  for (const name of ['bumblebee-hygiene-scan.cron', 'bumblebee-hygiene-scan.json']) {
    const path = join(seedDir, name)
    if (!existsSync(path)) {
      out.push({ label: name, path, removed: false })
      continue
    }
    rmSync(path, { force: true })
    out.push({ label: name, path, removed: true })
  }
  return out
}

/** Remove `packages/marveen/node_modules`. */
export function removeNodeModules(path: string): CleanupResult {
  if (!existsSync(path)) return { label: 'node_modules/', path, removed: false }
  rmSync(path, { recursive: true, force: true })
  return { label: 'node_modules/', path, removed: true }
}

/** Remove `packages/marveen/dist`. */
export function removeDist(path: string): CleanupResult {
  if (!existsSync(path)) return { label: 'dist/', path, removed: false }
  rmSync(path, { recursive: true, force: true })
  return { label: 'dist/', path, removed: true }
}

/** Remove the conf state directory entirely. */
export function removeStateConfDir(confPath: string): CleanupResult {
  if (!existsSync(confPath)) return { label: 'installer-state.json', path: confPath, removed: false }
  rmSync(confPath, { recursive: true, force: true })
  return { label: 'installer-state.json', path: confPath, removed: true }
}

/** Compute the canonical path of the conf state directory. */
export function stateConfPath(): string {
  return join(homedir(), '.config', 'marveen-installer')
}

/** Compute the canonical path of the conf state dir, by config library layout. */
export function confPathForProject(projectSuffix: string): string {
  return join(homedir(), '.config', `${projectSuffix}-installer`)
}
