// status subcommand.
//
// Prints a single cli-table3 with rows for OS, bun, claude, node,
// service unit, vault, dashboard. The service row reads the active
// platform provider's readServiceStatus; the dashboard row does a
// lightweight HEAD via the injected fetch.

import { Command } from 'commander'
import { release } from 'node:os'
import { createShell } from '../shell/exec.js'
import { createPlatformProvider } from '../platform/index.js'
import { createState } from '../state/conf.js'
import { renderTable, statusRow } from '../ui/table.js'
import { SERVICE_UNIT_NAMES } from '../platform/types.js'
import { t } from '../locale/index.js'

export const statusCommand = new Command('status')
  .description('Marveen szolgáltatás állapot megjelenítése')
  .action(async () => {
    const shell = createShell()
    const platform = createPlatformProvider(shell)
    const state = createState()

    const bun = Boolean(await shell.which('bun'))
    const claude = Boolean(await shell.which('claude'))
    const nodeOut = await shell.exec('node', ['--version']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
    const service = await platform.readServiceStatus(SERVICE_UNIT_NAMES.main)

    const rows: string[][] = [
      statusRow(t('doctor.checks.os'), true, `${process.platform} ${release()}`),
      statusRow(t('doctor.checks.node'), nodeOut.exitCode === 0, nodeOut.stdout.trim()),
      statusRow(t('doctor.checks.bun'), bun),
      statusRow(t('doctor.checks.claude'), claude),
      statusRow(t('doctor.checks.service'), service.state === 'active', service.state),
      statusRow(t('doctor.checks.vault'), state.get('lastProvider') !== 'skip', state.get('lastProvider')),
    ]

    process.stdout.write(renderTable({ head: ['Check', 'Status', 'Detail'], rows }) + '\n')
  })