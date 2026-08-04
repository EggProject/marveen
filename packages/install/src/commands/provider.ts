// provider subcommand.
//
// Re-runs only the provider prompt + vault push, skipping the rest
// of the install graph. Useful when the operator wants to rotate a
// credential without re-installing the runtime.

import { Command } from 'commander'
import { createShell } from '../shell/exec.js'
import { createFs } from '../shell/fs.js'
import { createPlatformProvider } from '../platform/index.js'
import { createState } from '../state/conf.js'
import { stepProviderPrompt } from '../steps/provider-prompt.js'
import { stepVaultPush, describePushResult } from '../steps/vault-push.js'
import { color } from '../ui/theme.js'
import { t } from '../locale/index.js'
import type { InstallerContext } from '../types.js'

export const providerCommand = new Command('provider')
  .description('Provider konfiguráció újraválasztása és Vault push')
  .option('--provider <id>', 'Előre választott provider (anthropic|minimax|deepseek|openrouter|ollama|skip)')
  .option('--non-interactive', 'Fej nélküli mód')
  .option('--web-port <port>', 'Dashboard port', (v) => Number(v), 3420)
  .action(async (opts: { provider?: string; nonInteractive?: boolean; webPort: number }) => {
    const shell = createShell()
    const fs = createFs()
    const platform = createPlatformProvider(shell)
    const state = createState()

    const ctx: InstallerContext = {
      port: 8787,
      webPort: opts.webPort,
      lang: 'hu',
      nonInteractive: opts.nonInteractive ?? false,
      skipUpdate: false,
      preSelectedProvider: (opts.provider as InstallerContext['preSelectedProvider']) ?? undefined,
      bunInstalled: true,
      claudeInstalled: true,
      botName: '',
      brandName: '',
      ownerName: '',
      dashboardToken: state.get('lastProvider') !== 'skip' ? 'reuse' : '',
      ollamaUrl: '',
      ollamaSkip: false,
      ollamaInstall: false,
      platform,
      shell,
      fs,
      fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch unavailable'))) as typeof fetch,
      cwd: process.cwd(),
    }

    const choice = await stepProviderPrompt(ctx)
    ctx.providerChoice = choice
    const result = await stepVaultPush(ctx)
    state.set('lastProvider', choice.mode)
    const colour = result.vaultOk && result.settingsOk ? 'success' : 'warn'
    process.stdout.write(color(colour, describePushResult(result)) + '\n')
    if (result.vaultOk && result.settingsOk && !result.skipped) {
      process.stdout.write(color('success', t('provider.update.success')) + '\n')
    }
  })