// Backup helper: produces a .zip of the soon-to-be-deleted files so the
// operator can recover manually if uninstall removes something they did
// not intend to lose.
//
// The helper is decoupled from commands/uninstall.ts so the uninstall
// orchestrator calls it once with the list of files-to-be-deleted, and
// the helper decides what to back up based on the chosen mode:
//
//   'full'    -- all files, password-protected AES zip (credential-bearing
//                env, vault.json, .vault-key, RC backups, claudeclaw.db).
//                The user types a password interactively.
//   'config'  -- non-credential artifacts only (config-overrides.json,
//                seed-config/, seed-scheduled-tasks/bumblebee-*, RC
//                backups). Stored without a password.
//   'none'    -- no backup; the uninstall proceeds to deletion directly.
//
// zip creation uses the `archiver` npm package, which is a streaming
// pure-JS zip writer (no system deps). The factory seam lets the tests
// inject a fake zip writer so they don't pull a real .tar.gz on disk.

import { mkdir, writeFile, stat, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createWriteStream } from 'node:fs'

export type BackupMode = 'full' | 'config' | 'none'

export interface BackupInput {
  /** What to write into the archive; relative paths inside the zip. */
  files: Array<{ absolutePath: string; archivePath: string }>
  /** Absolute path of the resulting .zip file. */
  outputZip: string
  /** Password for AES-256 encryption (full mode only). */
  password?: string
  /** Mode determines whether non-credential files get filtered out. */
  mode: BackupMode
}

export interface BackupResult {
  outputZip: string
  bytesWritten: number
  filesArchived: number
}

const CREDENTIAL_PATTERNS = [
  /\.env$/i,
  /\.env\..+$/i,
  /\.vault-key$/i,
  /\.vault-key\.migrated$/i,
  /\.dashboard-token$/i,
  /\.claude-oauth-token$/i,
  /vault\.json$/i,
  /claudeclaw\.db$/i,
] as const

const CONFIG_PATTERNS = [
  /config-overrides\.json$/i,
  /seed-config\//i,
  /seed-scheduled-tasks\/bumblebee-/i,
] as const

/**
 * Filtering seam: keeps the heuristic visible to the unit tests and to
 * the operator (via `bun run marveen-install uninstall --dry-run ...`
 * when present). Pure: does not touch the filesystem.
 */
export function selectFilesForMode(input: BackupInput): BackupInput['files'] {
  if (input.mode === 'none') return []
  if (input.mode === 'config') {
    return input.files.filter((f) => CONFIG_PATTERNS.some((rx) => rx.test(f.absolutePath)))
  }
  // 'full': everything (config + credentials).
  return input.files
}

export interface BackupWriter {
  writeZip(input: BackupInput, entries: BackupInput['files']): Promise<BackupResult>
}

/** Default writer: streams through `archiver` into a real .zip. */
export async function archiverBackupWriter(input: BackupInput, entries: BackupInput['files']): Promise<BackupResult> {
  // archiver v8 is ESM-only and exposes `ZipArchive` as a named export
  // instead of the legacy `archiver.create('zip', opts)` factory. The
  // dynamic import keeps the test seam (setBackupWriter) usable in
  // vitest without depending on the real binary at module load time.
  const archiverMod = await import('archiver')
  const { ZipArchive } = archiverMod as unknown as { ZipArchive: new (opts?: Record<string, unknown>) => NodeJS.ReadWriteStream }

  await mkdir(dirname(input.outputZip), { recursive: true })
  const out = createWriteStream(input.outputZip)
  const archive = new ZipArchive(input.password ? { encryptionMethod: 'aes256', password: input.password } : {})
  archive.pipe(out)
  let bytes = 0
  let count = 0
  for (const e of entries) {
    const data = await readFile(e.absolutePath)
    archive.append(data, { name: e.archivePath })
    bytes += data.byteLength
    count += 1
  }
  await new Promise<void>((resolve, reject) => {
    out.on('close', () => resolve())
    out.on('error', reject)
    archive.on('error', reject)
    archive.finalize()
  })
  return { outputZip: input.outputZip, bytesWritten: bytes, filesArchived: count }
}

let writer: BackupWriter = { writeZip: archiverBackupWriter }

export function setBackupWriter(fn: BackupWriter): void {
  writer = fn
}

export function resetBackupWriter(): void {
  writer = { writeZip: archiverBackupWriter }
}

export async function runBackup(input: BackupInput): Promise<BackupResult> {
  const entries = selectFilesForMode(input)
  if (entries.length === 0) {
    return { outputZip: input.outputZip, bytesWritten: 0, filesArchived: 0 }
  }
  return await writer.writeZip(input, entries)
}

/**
 * Helper that the uninstall command calls BEFORE deletion: snapshots
 * the file sizes and writes a tiny manifest into the zip's directory
 * so a forensic user can verify which files were backed up even if
 * they forget the original .zip contents.
 */
export async function writeBackupManifest(files: BackupInput['files'], dir: string): Promise<string> {
  const manifest: Array<{ archivePath: string; absolutePath: string; size: number }> = []
  for (const f of files) {
    try {
      const s = await stat(f.absolutePath)
      manifest.push({ ...f, size: s.size })
    } catch {
      manifest.push({ ...f, size: -1 })
    }
  }
  const path = join(dir, 'marveen-uninstall-manifest.json')
  await writeFile(path, JSON.stringify(manifest, null, 2), 'utf-8')
  return path
}
