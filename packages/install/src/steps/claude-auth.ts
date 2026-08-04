// Claude authentication step.
//
// Asks the operator whether they want to use an API key (sk-ant-...)
// or the OAuth setup-token (sk-ant-oat01-...). The captured token is
// returned for vault push; it NEVER goes to .env or the RC file --
// only the operator-shell RC line is touched in a separate step.
//
// In non-interactive mode the step prefers the API key from the
// ANTHROPIC_API_KEY env var when present, otherwise fails fast.

import type { InstallerContext } from '../types.js'
import { confirm, input, select } from '../ui/prompts.js'
import { t } from '../locale/index.js'

export interface ClaudeAuthResult {
  method: 'api-key' | 'oauth' | 'skip'
  token?: string
}

const ANTHROPIC_KEY_RE = /^sk-ant-[A-Za-z0-9_-]{20,}$/
const ANTHROPIC_OAUTH_RE = /^sk-ant-oat01-[A-Za-z0-9_-]{20,}$/

export async function stepClaudeAuth(ctx: InstallerContext): Promise<ClaudeAuthResult> {
  if (ctx.nonInteractive) {
    const envToken = process.env['ANTHROPIC_API_KEY'] ?? process.env['CLAUDE_CODE_OAUTH_TOKEN']
    if (envToken && ANTHROPIC_OAUTH_RE.test(envToken)) {
      return { method: 'oauth', token: envToken }
    }
    if (envToken && ANTHROPIC_KEY_RE.test(envToken)) {
      return { method: 'api-key', token: envToken }
    }
    return { method: 'skip' }
  }

  const method = await select(t('provider.anthropic.method.prompt'), [
    { name: t('provider.anthropic.method.api-key'), value: 'api-key' },
    { name: t('provider.anthropic.method.oauth'), value: 'oauth' },
    { name: t('provider.anthropic.method.skip'), value: 'skip' },
  ])

  if (method === 'skip') return { method: 'skip' }
  if (method === 'api-key') {
    const token = await input(t('provider.anthropic.api-key.prompt'), {
      password: true,
      validate: (v) => ANTHROPIC_KEY_RE.test(v) ? true : t('prompt.min-length-20'),
    })
    return { method: 'api-key', token }
  }
  const token = await input(t('provider.anthropic.oauth.prompt'), {
    password: true,
    validate: (v) => ANTHROPIC_OAUTH_RE.test(v) ? true : t('prompt.min-length-20'),
  })
  return { method: 'oauth', token }
}

export async function confirmSkipAuth(): Promise<boolean> {
  return await confirm(t('provider.anthropic.method.prompt'), false)
}