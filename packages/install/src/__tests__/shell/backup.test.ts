import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { selectFilesForMode, runBackup, writeBackupManifest, setBackupWriter, resetBackupWriter } from '../../shell/backup.js'
import type { BackupInput } from '../../shell/backup.js'

describe('selectFilesForMode', () => {
  const files: BackupInput['files'] = [
    { absolutePath: '/repo/.env', archivePath: '.env' },
    { absolutePath: '/repo/store/claudeclaw.db', archivePath: 'store/claudeclaw.db' },
    { absolutePath: '/repo/store/vault.json', archivePath: 'store/vault.json' },
    { absolutePath: '/repo/store/config-overrides.json', archivePath: 'store/config-overrides.json' },
    { absolutePath: '/repo/store/.dashboard-token', archivePath: 'store/.dashboard-token' },
    { absolutePath: '/repo/seed-scheduled-tasks/bumblebee-hygiene-scan.cron', archivePath: 'x' },
  ]

  it('returns the full list for "full" mode', () => {
    expect(selectFilesForMode({ ...base(files), mode: 'full' })).toHaveLength(files.length)
  })

  it('returns only config-shaped files for "config" mode', () => {
    const out = selectFilesForMode({ ...base(files), mode: 'config' })
    expect(out.map((f) => f.absolutePath)).toEqual([
      '/repo/store/config-overrides.json',
      '/repo/seed-scheduled-tasks/bumblebee-hygiene-scan.cron',
    ])
  })

  it('returns an empty list for "none" mode', () => {
    expect(selectFilesForMode({ ...base(files), mode: 'none' })).toEqual([])
  })
})

function base(files: BackupInput['files']): BackupInput {
  return { files, outputZip: '/tmp/out.zip', mode: 'full' }
}

describe('runBackup', () => {
  it('delegates to the configured writer and returns its result', async () => {
    const writeZip = vi.fn(async () => ({ outputZip: '/tmp/x.zip', bytesWritten: 100, filesArchived: 2 }))
    setBackupWriter({ writeZip })
    const result = await runBackup({
      files: [{ absolutePath: '/repo/.env', archivePath: '.env' }],
      outputZip: '/tmp/x.zip',
      mode: 'full',
    })
    expect(writeZip).toHaveBeenCalled()
    expect(result).toEqual({ outputZip: '/tmp/x.zip', bytesWritten: 100, filesArchived: 2 })
    resetBackupWriter()
  })

  it('returns zero counts when mode is "none" without calling the writer', async () => {
    const writeZip = vi.fn(async () => ({ outputZip: '', bytesWritten: 1, filesArchived: 1 }))
    setBackupWriter({ writeZip })
    const result = await runBackup({ files: [], outputZip: '', mode: 'none' })
    expect(writeZip).not.toHaveBeenCalled()
    expect(result).toEqual({ outputZip: '', bytesWritten: 0, filesArchived: 0 })
    resetBackupWriter()
  })
})

describe('writeBackupManifest', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'backup-manifest-'))
    mkdirSync(dir, { recursive: true })
  })

  it('lists files with sizes and writes the JSON manifest', async () => {
    const a = join(dir, 'a.env')
    const b = join(dir, 'b.json')
    writeFileSync(a, 'hello')
    writeFileSync(b, '{"x":1}')
    const manifestPath = await writeBackupManifest([
      { absolutePath: a, archivePath: '.env' },
      { absolutePath: b, archivePath: 'x.json' },
    ], dir)
    expect(existsSync(manifestPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(parsed).toEqual([
      { archivePath: '.env', absolutePath: a, size: statSync(a).size },
      { archivePath: 'x.json', absolutePath: b, size: statSync(b).size },
    ])
    rmSync(dir, { recursive: true, force: true })
  })

  it('records -1 size for missing files', async () => {
    const a = join(dir, 'missing.env')
    const manifestPath = await writeBackupManifest([
      { absolutePath: a, archivePath: '.env' },
    ], dir)
    const parsed = JSON.parse(readFileSync(manifestPath, 'utf-8'))
    expect(parsed[0].size).toBe(-1)
    rmSync(dir, { recursive: true, force: true })
  })
})

describe('archiverBackupWriter (integration)', () => {
  it('writes a real zip without a password when none is provided', async () => {
    // Skip until the user installs the `archiver` npm dependency
    // (the install command needs their explicit consent to add deps).
    if (!existsSync('/Users/eggp/marveen/packages/install/node_modules/archiver/package.json')) {
      return
    }
    const dir = mkdtempSync(join(tmpdir(), 'backup-zip-'))
    mkdirSync(dir, { recursive: true })
    const src = join(dir, 'hello.txt')
    writeFileSync(src, 'hello world')
    const out = join(dir, 'out.zip')
    const { archiverBackupWriter } = await import('../../shell/backup.js')
    const result = await archiverBackupWriter(
      { files: [{ absolutePath: src, archivePath: 'hello.txt' }], outputZip: out, mode: 'full' },
      [{ absolutePath: src, archivePath: 'hello.txt' }],
    )
    expect(result.outputZip).toBe(out)
    expect(result.filesArchived).toBe(1)
    expect(existsSync(out)).toBe(true)
    rmSync(dir, { recursive: true, force: true })
  }, 30_000)
})
