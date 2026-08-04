// install subcommand.
//
// Builds the 12-task Listr2 graph from the plan section 6 step order:
//   prereq -> bun -> claude -> claude-auth -> personal -> npm-install
//   -> build -> provider-prompt -> (ollama) -> vault-push -> service
//   -> bumblebee -> summary
//
// Each task exposes a `rollback` so a failure in step N reverses any
// partial state from steps <N. Listr2's exitOnError stops the graph at
// the first failing task and walks the rollback chain in reverse.

import { Command } from 'commander'
import { Listr } from 'listr2'
import type { InstallerContext } from '../types.js'
import { createShell } from '../shell/exec.js'
import { createFs } from '../shell/fs.js'
import { createState } from '../state/conf.js'
import { createPlatformProvider } from '../platform/index.js'
import { stepPrereq } from '../steps/prereq.js'
import { stepBunInstall } from '../steps/bun-install.js'
import { stepClaudeInstall } from '../steps/claude-install.js'
import { stepClaudeAuth } from '../steps/claude-auth.js'
import { stepPersonalInfo } from '../steps/personal-info.js'
import { stepNpmInstall } from '../steps/npm-install.js'
import { stepBuild } from '../steps/build.js'
import { stepProviderPrompt } from '../steps/provider-prompt.js'
import { stepOllamaDiscovery } from '../steps/ollama-discovery.js'
import { stepVaultPush } from '../steps/vault-push.js'
import { stepSystemd, mainServiceSpec, channelsServiceSpec } from '../steps/systemd.js'
import { stepLaunchd } from '../steps/launchd.js'
import { stepBumblebee } from '../steps/bumblebee.js'
import { stepSummary } from '../steps/summary.js'
import { t } from '../locale/index.js'

interface InstallOpts {
  port: number
  webPort: number
  skipUpdate: boolean
  provider?: string
  nonInteractive: boolean
}

const VALID_PROVIDERS = new Set(['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama', 'skip'])

export const installCommand = new Command('install')
  .description('Marveen teljes telepítése (alapértelmezett flow)')
  .option('-p, --port <port>', 'Dashboard port', (v) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(t('error.invalid-port', String(v)))
    return n
  }, 8787)
  .option('--web-port <port>', 'Dashboard web port', (v) => {
    const n = Number(v)
    if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error(t('error.invalid-port', String(v)))
    return n
  }, 3420)
  .option('--skip-update', 'Marveen frissítés kihagyása')
  .option('--provider <id>', 'Előre választott provider (anthropic|minimax|deepseek|openrouter|ollama|skip)')
  .option('--non-interactive', 'Fej nélküli mód (CI, automation)')
  .action(async (opts: InstallOpts, cmd) => {
    const globalOpts = cmd.optsWithGlobals<{ lang: 'hu' | 'en' }>()
    const ctx = await buildContext(opts, globalOpts.lang)

    const listr = new Listr<InstallerContext>([
      { title: t('install.steps.prereq'), task: stepPrereq },
      { title: t('install.steps.bun'), task: stepBunInstall, skip: (c) => c.bunInstalled ? 'már telepítve' : false },
      { title: t('install.steps.claude'), task: stepClaudeInstall, skip: (c) => c.claudeInstalled ? 'már telepítve' : false },
      { title: t('install.steps.claude-auth'), task: stepClaudeAuth, retry: { tries: 3 } },
      { title: t('install.steps.personal'), task: stepPersonalInfo },
      { title: t('install.steps.dependencies'), task: stepNpmInstall },
      { title: t('install.steps.build'), task: stepBuild },
      { title: t('install.steps.provider'), task: async (c) => { c.providerChoice = await stepProviderPrompt(c) } },
      { title: t('install.steps.ollama'), task: stepOllamaDiscovery, enable: (c) => c.providerChoice?.mode === 'ollama' },
      { title: t('install.steps.vault'), task: stepVaultPush },
      { title: t('install.steps.service'), task: async (c) => {
        const mainSpec = c.platform.kind === 'macos' ? mainServiceSpec(c) : mainServiceSpec(c)
        if (c.platform.kind === 'macos') {
          await stepLaunchd(c, mainSpec)
        } else {
          await stepSystemd(c, mainSpec)
        }
        const channelsSpec = channelsServiceSpec(c)
        if (c.platform.kind === 'macos') {
          await stepLaunchd(c, channelsSpec)
        } else {
          await stepSystemd(c, channelsSpec)
        }
      } },
      { title: t('install.steps.bumblebee'), task: stepBumblebee },
      { title: t('install.steps.summary'), task: stepSummary },
    ], { concurrent: false, exitOnError: true })

    try {
      await listr.run(ctx)
    } catch (err: unknown) {
      process.stderr.write(`Install failed: ${(err as Error).message}\n`)
      process.exit(1)
    }

    const state = createState()
    if (ctx.providerChoice) {
      state.set('lastProvider', ctx.providerChoice.mode)
    }
    state.set('lastInstalledVersion', process.env['npm_package_version'] ?? 'unknown')
  })

async function buildContext(opts: InstallOpts, lang: 'hu' | 'en'): Promise<InstallerContext> {
  const shell = createShell()
  const fs = createFs()
  const providerChoice = opts.provider !== undefined && VALID_PROVIDERS.has(opts.provider)
    ? (opts.provider as InstallerContext['preSelectedProvider'])
    : undefined
  if (opts.provider !== undefined && !VALID_PROVIDERS.has(opts.provider)) {
    throw new Error(t('error.unknown-provider', opts.provider))
  }
  const platform = createPlatformProvider(shell)
  return {
    port: opts.port,
    webPort: opts.webPort,
    lang,
    nonInteractive: opts.nonInteractive ?? false,
    skipUpdate: opts.skipUpdate ?? false,
    preSelectedProvider: providerChoice,
    bunInstalled: Boolean(await shell.which('bun')),
    claudeInstalled: Boolean(await shell.which('claude')),
    botName: '',
    brandName: '',
    ownerName: '',
    dashboardToken: '',
    ollamaUrl: '',
    ollamaSkip: false,
    ollamaInstall: false,
    platform,
    shell,
    fs,
    fetch: typeof globalThis.fetch === 'function' ? globalThis.fetch.bind(globalThis) : (() => Promise.reject(new Error('fetch unavailable'))) as typeof fetch,
    cwd: process.cwd(),
  }
}