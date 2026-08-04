// doctor subcommand.
//
// Runs the 7-check diagnostic list from plan section 11:
//   os, bun, claude, node, service, vault, dashboard
// Each check returns OK/HIBA + an optional detail line. Output uses
// the cli-table3 helper, same as status, so the two commands read
// consistently.

import { Command } from 'commander'
import { release } from 'node:os'
import { createShell } from '../shell/exec.js'
import { createPlatformProvider } from '../platform/index.js'
import { createState } from '../state/conf.js'
import { renderTable, statusRow } from '../ui/table.js'
import { SERVICE_UNIT_NAMES } from '../platform/types.js'
import { waitForDashboardReady } from '../api/dashboard.js'
import { t } from '../locale/index.js'

interface DoctorOpts {
  webPort: number
}

export const doctorCommand = new Command('doctor')
  .description('Marveen diagnosztikai ellenőrzések')
  .option('--web-port <port>', 'Dashboard port az ellenőrzéshez', (v) => Number(v), 3420)
  .action(async (opts: DoctorOpts) => {
    const shell = createShell()
    const platform = createPlatformProvider(shell)
    const state = createState()

    const checks: Array<{ name: string; ok: boolean; detail?: string }> = []

    checks.push({ name: t('doctor.checks.os'), ok: true, detail: `${process.platform} ${release()}` })

    const nodeOut = await shell.exec('node', ['--version']).catch(() => ({ exitCode: 1, stdout: '', stderr: '' }))
    checks.push({ name: t('doctor.checks.node'), ok: nodeOut.exitCode === 0, detail: nodeOut.stdout.trim() || 'missing' })

    checks.push({ name: t('doctor.checks.bun'), ok: Boolean(await shell.which('bun')) })
    checks.push({ name: t('doctor.checks.claude'), ok: Boolean(await shell.which('claude')) })

    const service = await platform.readServiceStatus(SERVICE_UNIT_NAMES.main).catch(() => ({ name: SERVICE_UNIT_NAMES.main, state: 'unknown' as const }))
    checks.push({ name: t('doctor.checks.service'), ok: service.state === 'active', detail: service.state })

    checks.push({ name: t('doctor.checks.vault'), ok: state.get('lastProvider') !== 'skip', detail: state.get('lastProvider') })

    const base = `http://127.0.0.1:${opts.webPort}`
    const token = state.get('lastProvider') !== 'skip' ? 'probe' : ''
    const dashboardReady = token ? await waitForDashboardReady({ base, token, timeoutMs: 2000 }).catch(() => false) : false
    checks.push({ name: t('doctor.checks.web'), ok: dashboardReady, detail: base })

    const rows = checks.map((c) => statusRow(c.name, c.ok, c.detail))
    process.stdout.write(renderTable({ head: ['Check', 'Status', 'Detail'], rows }) + '\n')
  })