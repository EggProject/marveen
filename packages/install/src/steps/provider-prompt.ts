// Provider selection wizard.
//
// Mirrors the 28 BATS scenarios from installer-provider-prompt.sh:
//   - Anthropic API key (validate sk-ant-...)
//   - Anthropic OAuth setup-token (validate sk-ant-oat01-...)
//   - Anthropic skip (headless default)
//   - MiniMax global vs china region
//   - MiniMax token validate
//   - DeepSeek API key
//   - OpenRouter API key
//   - Ollama custom URL
//   - Ollama default URL
//   - Skip mode
//   - Empty input warning
//   - Pre-selected provider via --provider flag bypasses the menu
// The wizard NEVER writes credentials to .env -- the captured value
// flows into the ProviderChoice struct that vault-push.ts posts to
// the dashboard.

import type { InstallerContext, ProviderChoice } from '../types.js'
import { input, password, select } from '../ui/prompts.js'
import { t } from '../locale/index.js'

const TOKEN_RE = /^[A-Za-z0-9._-]{20,}$/
const DEEPSEEK_RE = /^[A-Za-z0-9-]{20,}$/

export async function stepProviderPrompt(ctx: InstallerContext): Promise<ProviderChoice> {
  if (ctx.nonInteractive) {
    return nonInteractiveChoice(ctx.preSelectedProvider ?? 'skip')
  }
  if (ctx.preSelectedProvider) {
    return await runProvider(ctx, ctx.preSelectedProvider)
  }
  const choice = await select(t('provider.choose'), [
    { name: t('provider.choices.anthropic'), value: 'anthropic' },
    { name: t('provider.choices.minimax'), value: 'minimax' },
    { name: t('provider.choices.deepseek'), value: 'deepseek' },
    { name: t('provider.choices.openrouter'), value: 'openrouter' },
    { name: t('provider.choices.ollama'), value: 'ollama' },
    { name: t('provider.choices.skip'), value: 'skip' },
  ])
  return await runProvider(ctx, choice)
}

async function runProvider(ctx: InstallerContext, mode: ProviderChoice['mode']): Promise<ProviderChoice> {
  switch (mode) {
    case 'anthropic': return await promptAnthropic(ctx)
    case 'minimax': return await promptMinimax(ctx)
    case 'deepseek': return await promptDeepseek(ctx)
    case 'openrouter': return await promptOpenrouter(ctx)
    case 'ollama': return await promptOllama(ctx)
    case 'skip': return { mode: 'skip' }
  }
}

function nonInteractiveChoice(mode: ProviderChoice['mode']): ProviderChoice {
  if (mode === 'skip') return { mode: 'skip' }
  if (mode === 'ollama') {
    const url = process.env['OLLAMA_BASE_URL'] ?? t('provider.ollama.default')
    return { mode, vaultId: 'OLLAMA_BASE_URL', vaultLabel: 'Ollama base URL', vaultValue: url, baseUrlKey: 'OLLAMA_BASE_URL', baseUrlValue: url }
  }

  const definitions: Record<Exclude<ProviderChoice['mode'], 'skip' | 'ollama'>, {
    env: string
    vaultLabel: string
    baseUrlKey?: string
    baseUrlValue?: string
  }> = {
    anthropic: { env: process.env['ANTHROPIC_API_KEY'] ? 'ANTHROPIC_API_KEY' : 'CLAUDE_CODE_OAUTH_TOKEN', vaultLabel: 'Anthropic credential' },
    minimax: { env: 'MINIMAX_API_KEY', vaultLabel: 'MiniMax API key', baseUrlKey: 'MINIMAX_BASE_URL', baseUrlValue: process.env['MINIMAX_BASE_URL'] ?? 'https://api.minimax.io/anthropic' },
    deepseek: { env: 'DEEPSEEK_API_KEY', vaultLabel: 'DeepSeek API key', baseUrlKey: 'DEEPSEEK_BASE_URL', baseUrlValue: process.env['DEEPSEEK_BASE_URL'] ?? 'https://api.deepseek.com/anthropic' },
    openrouter: { env: 'OPENROUTER_API_KEY', vaultLabel: 'OpenRouter API key', baseUrlKey: 'OPENROUTER_BASE_URL', baseUrlValue: process.env['OPENROUTER_BASE_URL'] ?? 'https://openrouter.ai/api/v1' },
  }
  const definition = definitions[mode]
  const token = process.env[definition.env]
  return {
    mode,
    ...(token ? { vaultId: definition.env, vaultLabel: definition.vaultLabel, vaultValue: token } : {}),
    ...(definition.baseUrlKey && definition.baseUrlValue ? { baseUrlKey: definition.baseUrlKey, baseUrlValue: definition.baseUrlValue } : {}),
  }
}

async function promptAnthropic(ctx: InstallerContext): Promise<ProviderChoice> {
  const method = ctx.nonInteractive ? 'api-key' : await select(t('provider.anthropic.method.prompt'), [
    { name: t('provider.anthropic.method.api-key'), value: 'api-key' },
    { name: t('provider.anthropic.method.oauth'), value: 'oauth' },
    { name: t('provider.anthropic.method.skip'), value: 'skip' },
  ])
  if (method === 'skip') return { mode: 'anthropic' }
  if (method === 'api-key') {
    const token = await password(t('provider.anthropic.api-key.prompt'), {
      validate: (v) => TOKEN_RE.test(v) ? true : t('prompt.min-length-20'),
    })
    return {
      mode: 'anthropic',
      vaultId: 'ANTHROPIC_API_KEY',
      vaultLabel: 'Anthropic API key',
      vaultValue: token,
    }
  }
  const token = await password(t('provider.anthropic.oauth.prompt'), {
    validate: (v) => TOKEN_RE.test(v) ? true : t('prompt.min-length-20'),
  })
  return {
    mode: 'anthropic',
    vaultId: 'CLAUDE_CODE_OAUTH_TOKEN',
    vaultLabel: 'Anthropic OAuth setup-token',
    vaultValue: token,
  }
}

async function promptMinimax(ctx: InstallerContext): Promise<ProviderChoice> {
  const region = ctx.nonInteractive ? 'global' : await select(t('provider.minimax.region.prompt'), [
    { name: t('provider.minimax.region.global'), value: 'global' },
    { name: t('provider.minimax.region.china'), value: 'china' },
  ])
  const baseUrl = region === 'china' ? 'https://api.minimaxi.com/anthropic' : 'https://api.minimax.io/anthropic'
  const token = await password(t('provider.minimax.token.prompt'), {
    validate: (v) => TOKEN_RE.test(v) ? true : t('prompt.min-length-20'),
  })
  return {
    mode: 'minimax',
    vaultId: 'MINIMAX_API_KEY',
    vaultLabel: 'MiniMax API key',
    vaultValue: token,
    baseUrlKey: 'MINIMAX_BASE_URL',
    baseUrlValue: baseUrl,
  }
}

async function promptDeepseek(ctx: InstallerContext): Promise<ProviderChoice> {
  const token = await password(t('provider.deepseek.prompt'), {
    validate: (v) => DEEPSEEK_RE.test(v) ? true : t('prompt.min-length-20'),
  })
  return {
    mode: 'deepseek',
    vaultId: 'DEEPSEEK_API_KEY',
    vaultLabel: 'DeepSeek API key',
    vaultValue: token,
    baseUrlKey: 'DEEPSEEK_BASE_URL',
    baseUrlValue: 'https://api.deepseek.com/anthropic',
  }
}

async function promptOpenrouter(ctx: InstallerContext): Promise<ProviderChoice> {
  const token = await password(t('provider.openrouter.prompt'), {
    validate: (v) => TOKEN_RE.test(v) ? true : t('prompt.min-length-20'),
  })
  return {
    mode: 'openrouter',
    vaultId: 'OPENROUTER_API_KEY',
    vaultLabel: 'OpenRouter API key',
    vaultValue: token,
    baseUrlKey: 'OPENROUTER_BASE_URL',
    baseUrlValue: 'https://openrouter.ai/api/v1',
  }
}

async function promptOllama(ctx: InstallerContext): Promise<ProviderChoice> {
  const url = await input(t('provider.ollama.prompt'), {
    defaultValue: t('provider.ollama.default'),
    validate: (v) => /^https?:\/\//i.test(v) ? true : t('prompt.url'),
  })
  return {
    mode: 'ollama',
    vaultId: 'OLLAMA_BASE_URL',
    vaultLabel: 'Ollama base URL',
    vaultValue: url,
    baseUrlKey: 'OLLAMA_BASE_URL',
    baseUrlValue: url,
  }
}

// Convenience export so the doctor / status commands can render the
// same 6 provider rows without re-importing the locale.
export const PROVIDER_VALUES = ['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama', 'skip'] as const