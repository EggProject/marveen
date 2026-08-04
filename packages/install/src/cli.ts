// Marveen installer CLI entry point.
//
// commander tree: marveen-install [install|uninstall|status|doctor|
// provider|update] [options]. The root `preAction` hook resolves the
// locale (`--lang hu|en`) before any subcommand handler runs so the
// locale-parity test can drive a subcommand with either language.

import { Command } from 'commander'
import { initLocale } from './locale/index.js'
import { setColorsEnabled } from './ui/theme.js'
import { installCommand } from './commands/install.js'
import { uninstallCommand } from './commands/uninstall.js'
import { statusCommand } from './commands/status.js'
import { doctorCommand } from './commands/doctor.js'
import { providerCommand } from './commands/provider.js'
import { updateCommand } from './commands/update.js'
import { banner } from './ui/banner.js'
import { t } from './locale/index.js'

const program = new Command('marveen-install')
  .description(t('cli.title'))
  .version('1.28.1')
  .helpOption('-h, --segítség', 'Súgó megjelenítése')
  .option('--lang <hu|en>', 'Nyelv', 'hu')
  .option('--no-color', 'Színek kikapcsolása')
  .hook('preAction', async (cmd) => {
    const opts = cmd.opts<{ lang?: 'hu' | 'en'; color?: boolean }>()
    if (opts.lang === 'en' || opts.lang === 'hu') initLocale(opts.lang)
    setColorsEnabled(opts.color !== false)
    // The hook is registered on the root command, so `cmd` is always the
    // program itself -- the banner belongs to every subcommand run.
    process.stdout.write(banner({ title: t('cli.title'), subtitle: t('cli.subtitle') }) + '\n')
  })

program.addCommand(installCommand)
program.addCommand(uninstallCommand)
program.addCommand(statusCommand)
program.addCommand(doctorCommand)
program.addCommand(providerCommand)
program.addCommand(updateCommand)

await program.parseAsync(process.argv)