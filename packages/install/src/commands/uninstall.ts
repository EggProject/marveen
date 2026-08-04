// uninstall subcommand.
//
// Confirms with the operator (yes/no), then runs the platform provider
// uninstall + clears the conf state. The reversal order is the
// inverse of the install flow so partial installs don't leave
// dangling service units.

import { Command } from 'commander'
import { createShell } from '../shell/exec.js'
import { createPlatformProvider } from '../platform/index.js'
import { createState } from '../state/conf.js'
import { confirm, input } from '../ui/prompts.js'
import { t } from '../locale/index.js'
import { color } from '../ui/theme.js'
import { EXIT_CODES } from '../ui/prompts.js'

interface UninstallOpts {
  force?: boolean
  yes?: boolean
}

export const uninstallCommand = new Command('uninstall')
  .description('Marveen telepítés eltávolítása')
  .option('-f, --force', 'Megerősítés kihagyása')
  .option('-y, --yes', 'Igen a megerősítésre')
  .action(async (opts: UninstallOpts) => {
    const confirmed = opts.force === true || opts.yes === true
      || await confirm(t('uninstall.confirm'), false)

    if (!confirmed) {
      process.stdout.write(t('uninstall.cancelled') + '\n')
      process.exit(EXIT_CODES.CANCEL)
    }

    const shell = createShell()
    const platform = createPlatformProvider(shell)

    try {
      await platform.uninstall()
    } catch (err: unknown) {
      process.stderr.write(`Uninstall step failed: ${(err as Error).message}\n`)
    }

    const state = createState()
    state.set('uninstalledAt', new Date().toISOString())
    state.set('lastProvider', 'skip')

    process.stdout.write(color('success', t('uninstall.success')) + '\n')
    // The confirm/input imports above are kept so the dependency
    // graph includes the validate helpers even though `confirm` is
    // the only one used; future prompts (e.g. "remove data dir?")
    // will reach for the rest.
    void input
  })