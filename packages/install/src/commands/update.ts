// update subcommand.
//
// Minimum viable replacement for the previous update.sh:
//   1. git pull --ff-only
//   2. bun install --frozen-lockfile (or npm ci fallback)
//   3. bunx tsc (rebuild)
//   4. systemctl --user restart marveen.service (or launchctl kickstart)
//
// Complex rollback heuristics (apt-lock retry, EPERM fallback, the
// 04:00 finalizer) live outside this command -- the runtime owns
// those flows now.

import { Command } from 'commander'
import { createShell } from '../shell/exec.js'
import { createPlatformProvider } from '../platform/index.js'
import { renderTable, statusRow } from '../ui/table.js'
import { SERVICE_UNIT_NAMES } from '../platform/types.js'
import { color } from '../ui/theme.js'
import { t } from '../locale/index.js'

export const updateCommand = new Command('update')
  .description('Marveen frissítése a legújabb verzióra')
  .option('--branch <name>', 'Git branch', 'feature-develop')
  .option('--web-port <port>', 'Dashboard port (rollback health check)', (v) => Number(v), 3420)
  .action(async (opts: { branch: string; webPort: number }) => {
    const shell = createShell()
    const platform = createPlatformProvider(shell)

    const rows: string[][] = []

    const pull = await shell.exec('git', ['pull', '--ff-only', 'origin', opts.branch])
    const pullDetail = pull.stderr.split('\n', 1).join('') || pull.stdout.split('\n', 1).join('')
    rows.push(statusRow(t('update.check'), pull.exitCode === 0, pullDetail))
    if (pull.exitCode !== 0) {
      process.stdout.write(renderTable({ head: ['Step', 'Status', 'Detail'], rows }) + '\n')
      process.stderr.write(t('update.rollback') + '\n')
      process.exit(1)
    }

    const manager = (await shell.which('bun')) ? 'bun' : 'npm'
    const install = manager === 'bun'
      ? await shell.exec('bun', ['install', '--frozen-lockfile'])
      : await shell.exec('npm', ['ci'])
    rows.push(statusRow(t('update.apply') + ' (install)', install.exitCode === 0, manager))

    const build = manager === 'bun'
      ? await shell.exec('bunx', ['tsc'], { cwd: 'packages/marveen' })
      : await shell.exec('npx', ['tsc'], { cwd: 'packages/marveen' })
    rows.push(statusRow(t('update.apply') + ' (build)', build.exitCode === 0, manager))

    if (platform.kind === 'macos') {
      await shell.exec('launchctl', ['kickstart', '-k', `gui/$(id -u)/com.marveen.${SERVICE_UNIT_NAMES.main}`]).catch(() => undefined)
    } else {
      await shell.exec('systemctl', ['--user', 'restart', `${SERVICE_UNIT_NAMES.main}.service`]).catch(() => undefined)
    }

    process.stdout.write(renderTable({ head: ['Step', 'Status', 'Detail'], rows }) + '\n')
    process.stdout.write(color('success', t('update.no-updates')) + '\n')
  })