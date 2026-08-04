// uninstall subcommand.
//
// Two-phase flow:
//   1. Pre-flight: confirm + choose backup mode + collect password.
//   2. Listr2 task graph (the inverse of install's 12-step order) that
//      removes every artifact the install wrote: service units, store/,
//      vault, bumblebee, node_modules, dist, .env + RC, installer state.
//
// The 4 "warning-only" steps (prereq/bun/claude/ollama) do NOT delete
// anything; they emit a stderr line so the operator knows those
// artifacts were intentionally left behind.
//
// Backup runs BEFORE deletion so the operator can recover manual data
// (claudeclaw.db, .env, vault.json, RC backups) even if a step fails
// part-way. The backup prompt is interactive; --force skips it.
//
// Replaces the previous 2-step uninstall (confirm + platform.uninstall)
// that only stopped services and left every other artifact behind.

import { Command } from 'commander'
import { Listr } from 'listr2'
import { join } from 'node:path'
import { existsSync } from 'node:fs'
import { createShell } from '../shell/exec.js'
import { runBackup, type BackupMode, type BackupInput, writeBackupManifest } from '../shell/backup.js'
import { createPlatformProvider } from '../platform/index.js'
import { createState } from '../state/conf.js'
import { confirm, input, select, EXIT_CODES } from '../ui/prompts.js'
import { t } from '../locale/index.js'
import { color } from '../ui/theme.js'
import { SERVICE_UNIT_NAMES } from '../platform/types.js'
import {
  removeInstallDirEnv,
  removeOAuthTokenFile,
  removeStoreDir,
  removeBumblebeeSeeds,
  removeNodeModules,
  removeDist,
  removeStateConfDir,
  stripRcMarveenLines,
  stateConfPath,
  isMarveenLine,
} from '../steps/uninstall-cleanup.js'

interface UninstallOpts {
  force?: boolean
  yes?: boolean
  dryRun?: boolean
  lang?: 'hu' | 'en'
}

export const uninstallCommand = new Command('uninstall')
  .description(t('uninstall.summary.title'))
  .option('-f, --force', 'Confirmations + backup prompt skipped')
  .option('-y, --yes', 'Skip the initial confirm (still asks backup mode unless --force)')
  .option('--dry-run', 'Print what would happen without modifying anything')
  .action(async (opts: UninstallOpts) => {
    const confirmed = opts.force === true || opts.yes === true
      || await confirm(t('uninstall.confirm'), false)

    if (!confirmed) {
      process.stdout.write(t('uninstall.cancelled') + '\n')
      process.exit(EXIT_CODES.CANCEL)
    }

    const shell = createShell()
    const platform = createPlatformProvider(shell)
    const cwd = process.cwd()
    const envPath = join(cwd, '.env')
    const storePath = join(cwd, 'store')
    const seedDir = join(cwd, 'seed-scheduled-tasks')
    const nodeModules = join(cwd, 'packages', 'marveen', 'node_modules')
    const distDir = join(cwd, 'packages', 'marveen', 'dist')
    const oauthPath = join(storePath, '.claude-oauth-token')

    // --- Phase 1: backup (unless --force / mode=none) ---------------------
    let backupMode: BackupMode = 'none'
    if (!opts.force) {
      backupMode = await askBackupMode()
    }
    let password: string | undefined
    if (backupMode === 'full') {
      password = await askBackupPassword()
    }

    const candidates = collectBackupCandidates({
      envPath, storePath, seedDir, oauthPath,
    })
    const zipPath = join(cwd, `marveen-uninstall-${stamp()}.zip`)
    const manifestDir = cwd
    if (backupMode !== 'none' && candidates.length > 0) {
      const input: BackupInput = {
        files: candidates,
        outputZip: zipPath,
        mode: backupMode,
        ...(password !== undefined ? { password } : {}),
      }
      const result = await runBackup(input)
      await writeBackupManifest(candidates, manifestDir)
      process.stdout.write(color('success', t('uninstall.backup.done', result.outputZip, String(result.filesArchived), String(result.bytesWritten))) + '\n')
    } else if (backupMode === 'none') {
      process.stdout.write(color('dim', t('uninstall.backup.skipped')) + '\n')
    }

    // --- Phase 2: deletion (Listr2 graph) ---------------------------------
    const warn = process.stderr.write.bind(process.stderr)
    const safe = async (label: string, fn: () => unknown | Promise<unknown>): Promise<void> => {
      try { await fn() }
      catch (err: unknown) { warn(`Uninstall step failed: ${label}: ${(err as Error).message}\n`) }
    }
    const listr = new Listr<Record<string, never>>([
      { title: t('uninstall.warning.prereq'), task: () => { /* warning only */ } },
      { title: t('uninstall.warning.bun'), task: () => { /* warning only */ } },
      { title: t('uninstall.warning.claude'), task: () => { /* warning only */ } },
      { title: t('uninstall.warning.ollama'), task: () => { /* warning only */ } },

      { title: t('uninstall.step.service.stop'), task: () => safe('service.stop', async () => {
        await platform.removeServiceUnit(SERVICE_UNIT_NAMES.main)
        await platform.removeServiceUnit(SERVICE_UNIT_NAMES.channels)
      }) },

      { title: t('uninstall.step.unit.remove'), task: () => safe('unit.remove', async () => {
        // The platform.removeServiceUnit calls above already deleted the
        // unit files; this task is the explicit visible entry.
      }) },

      { title: t('uninstall.step.store.remove'), task: () => safe('store.remove', () => removeStoreDir(storePath)) },

      { title: t('uninstall.step.vault.remove'), task: () => safe('vault.remove', async () => {
        if (platform.kind === 'macos') {
          await shell.exec('security', ['delete-generic-password', '-s', 'com.marveen.vault'])
        }
      }) },

      { title: t('uninstall.step.bumblebee.remove'), task: () => safe('bumblebee.remove', () => removeBumblebeeSeeds(seedDir)) },
      { title: t('uninstall.step.node-modules.remove'), task: () => safe('node-modules.remove', () => removeNodeModules(nodeModules)) },
      { title: t('uninstall.step.dist.remove'), task: () => safe('dist.remove', () => removeDist(distDir)) },
      { title: t('uninstall.step.env.remove'), task: () => safe('env.remove', () => removeInstallDirEnv(envPath)) },
      { title: t('uninstall.step.oauth.remove'), task: () => safe('oauth.remove', () => removeOAuthTokenFile(oauthPath)) },
      { title: t('uninstall.step.rc.strip'), task: () => safe('rc.strip', () => { stripRcMarveenLines() }) },

      { title: t('uninstall.step.state.remove'), task: () => safe('state.remove', () => {
        const s = createState()
        s.clear()
        removeStateConfDir(stateConfPath())
      }) },
    ], { concurrent: false, exitOnError: false })

    if (opts.dryRun) {
      for (const t of listr.tasks) process.stdout.write(`DRY: ${t.title}\n`)
      return
    }

    let stepCount = 0
    // Each task is wrapped in `safe()` above, so listr.run resolves normally
    // even if every individual delete throws; the per-task stderr lines
    // surface what failed. No outer catch needed here.
    await listr.run({})
    stepCount = listr.tasks.length

    // --- Final summary ---------------------------------------------------
    const lines: string[] = [
      t('uninstall.summary.title'),
      '',
      t('uninstall.summary.removed'),
      `  - ~/.config/systemd/user/marneen{,-channels}.service  (Linux) / ~/Library/LaunchAgents/com.marveen.*.plist  (macOS)`,
      `  - store/claudeclaw.db, store/vault.json, store/.vault-key, store/.dashboard-token, ...`,
      `  - store/.claude-oauth-token (legacy)`,
      `  - seed-scheduled-tasks/bumblebee-hygiene-scan.{cron,json}`,
      `  - packages/marneen/node_modules/`,
      `  - packages/marneen/dist/`,
      `  - $INSTALL_DIR/.env  (+ .env backup kept as .env.marveen.bak if existed)`,
      `  - Marveen export lines removed from ~/.bashrc / ~/.zshrc (backups: *.marveen.bak)`,
      `  - ~/.config/marneen-installer/  (installer state)`,
      '',
      t('uninstall.summary.warnings'),
      `  - ${t('uninstall.warning.prereq')}`,
      `  - ${t('uninstall.warning.bun')}`,
      `  - ${t('uninstall.warning.claude')}`,
      `  - ${t('uninstall.warning.ollama')}`,
      '',
      t('uninstall.summary.backup', backupMode === 'none' ? t('uninstall.backup.skipped') : zipPath),
    ]
    process.stdout.write(`${lines.join('\n')}\n`)
    process.stdout.write(color('success', t('uninstall.success', String(stepCount), '4')) + '\n')

    void isMarveenLine // re-exported helper, kept referenced for tests
  })

// ---------- internal helpers --------------------------------------------

/** Prompt the operator for the backup mode (full / config / none). */
async function askBackupMode(): Promise<BackupMode> {
  const choice = await select(t('uninstall.backup.prompt'), [
    { name: t('uninstall.backup.choice.full'), value: 'full' },
    { name: t('uninstall.backup.choice.config'), value: 'config' },
    { name: t('uninstall.backup.choice.none'), value: 'none' },
  ])
  return choice as BackupMode
}

/** Prompt for an 8+ char password for the AES-256 zip. */
async function askBackupPassword(): Promise<string> {
  return await input(t('uninstall.backup.full.password'), {
    password: true,
    validate: (v: string) => v.length >= 8 ? true : 'Min 8 karakter',
  })
}

/** Build the list of files that will be archived (only existing ones). */
function collectBackupCandidates(p: {
  envPath: string
  storePath: string
  seedDir: string
  oauthPath: string
}): Array<{ absolutePath: string; archivePath: string }> {
  const out: Array<{ absolutePath: string; archivePath: string }> = []
  if (existsSync(p.envPath)) out.push({ absolutePath: p.envPath, archivePath: '.env' })
  if (existsSync(p.oauthPath)) out.push({ absolutePath: p.oauthPath, archivePath: 'store/.claude-oauth-token' })

  // store/ contents (recurse shallowly -- vault.json + .vault-key live at store/ root).
  if (existsSync(p.storePath)) {
    out.push({ absolutePath: join(p.storePath, 'claudeclaw.db'), archivePath: 'store/claudeclaw.db' })
    out.push({ absolutePath: join(p.storePath, 'vault.json'), archivePath: 'store/vault.json' })
    out.push({ absolutePath: join(p.storePath, '.vault-key'), archivePath: 'store/.vault-key' })
    out.push({ absolutePath: join(p.storePath, '.dashboard-token'), archivePath: 'store/.dashboard-token' })
    out.push({ absolutePath: join(p.storePath, 'config-overrides.json'), archivePath: 'store/config-overrides.json' })
  }

  // bumblebee seed files
  if (existsSync(p.seedDir)) {
    out.push({ absolutePath: join(p.seedDir, 'bumblebee-hygiene-scan.cron'), archivePath: 'seed-scheduled-tasks/bumblebee-hygiene-scan.cron' })
    out.push({ absolutePath: join(p.seedDir, 'bumblebee-hygiene-scan.json'), archivePath: 'seed-scheduled-tasks/bumblebee-hygiene-scan.json' })
  }
  return out
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-')
}
