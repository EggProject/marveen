// TS port of the 28 BATS scenarios from
// scripts/__tests__/installer-provider-prompt.bats. Every branch of the
// provider wizard is exercised through scripted @inquirer/prompts
// implementations -- no TTY, no network, no credential ever leaves the
// ProviderChoice struct.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { PROVIDER_VALUES, stepProviderPrompt } from '../../steps/provider-prompt.js'
import { resetPromptImpls, setPromptImpls } from '../../ui/prompts.js'
import { initLocale } from '../../locale/index.js'
import { makeCtx } from '../_helpers.js'

const TOKEN = 'abcdefghijklmnopqrstuvwx'
const SHORT = 'rovid'

interface Recorded {
  selects: Array<{ message: string; choices: Array<{ name: string; value: string }> }>
  passwords: Array<{ message: string; validate?: (v: string) => true | string }>
  inputs: Array<{ message: string; default?: string; validate?: (v: string) => true | string }>
}

function script(answers: { selects?: string[]; passwords?: string[]; inputs?: string[] }): Recorded {
  const rec: Recorded = { selects: [], passwords: [], inputs: [] }
  let s = 0
  let p = 0
  let i = 0
  setPromptImpls({
    select: (async (o: Recorded['selects'][number]) => {
      rec.selects.push(o)
      const value = answers.selects?.[s]
      s += 1
      return value ?? o.choices[o.choices.length - 1]!.value
    }) as never,
    password: (async (o: Recorded['passwords'][number]) => {
      rec.passwords.push(o)
      const value = answers.passwords?.[p]
      p += 1
      return value ?? ''
    }) as never,
    input: (async (o: Recorded['inputs'][number]) => {
      rec.inputs.push(o)
      const value = answers.inputs?.[i]
      i += 1
      return value ?? o.default ?? ''
    }) as never,
  })
  return rec
}

beforeEach(() => {
  initLocale('hu')
  delete process.env['OLLAMA_BASE_URL']
})
afterEach(() => {
  resetPromptImpls()
  delete process.env['OLLAMA_BASE_URL']
})

describe('steps/provider-prompt menu', () => {
  // 1
  it('offers the six providers in the documented order', async () => {
    const rec = script({ selects: ['skip'] })
    await stepProviderPrompt(makeCtx())
    expect(rec.selects[0]!.message).toBe('Válaszd ki a modell-szolgáltatót:')
    expect(rec.selects[0]!.choices.map((c) => c.value)).toEqual([...PROVIDER_VALUES])
    expect(rec.selects[0]!.choices.map((c) => c.name)).toEqual([
      'Anthropic Claude', 'MiniMax', 'DeepSeek', 'OpenRouter', 'Ollama (lokális)', 'Kihagyás',
    ])
  })

  // 2
  it('PROVIDER_VALUES exports the six modes', () => {
    expect(PROVIDER_VALUES).toEqual(['anthropic', 'minimax', 'deepseek', 'openrouter', 'ollama', 'skip'])
  })

  // 3: "Empty stdin defaults to skip (6)"
  it('an unanswered menu falls through to skip', async () => {
    script({})
    expect(await stepProviderPrompt(makeCtx())).toEqual({ mode: 'skip' })
  })

  // 4: "Skip branch (6): all buffers empty"
  it('skip leaves every vault field empty', async () => {
    script({ selects: ['skip'] })
    const choice = await stepProviderPrompt(makeCtx())
    expect(choice).toEqual({ mode: 'skip' })
    expect(choice.vaultId).toBeUndefined()
    expect(choice.vaultValue).toBeUndefined()
    expect(choice.baseUrlKey).toBeUndefined()
  })
})

describe('steps/provider-prompt anthropic', () => {
  // 5
  it('offers the three auth methods', async () => {
    const rec = script({ selects: ['anthropic', 'skip'] })
    await stepProviderPrompt(makeCtx())
    expect(rec.selects[1]!.message).toBe('Anthropic hitelesítés módja:')
    expect(rec.selects[1]!.choices.map((c) => c.value)).toEqual(['api-key', 'oauth', 'skip'])
  })

  // 6: "Anthropic API key: sets vault, no base URL"
  it('API key fills ANTHROPIC_API_KEY and no base URL', async () => {
    script({ selects: ['anthropic', 'api-key'], passwords: [TOKEN] })
    expect(await stepProviderPrompt(makeCtx())).toEqual({
      mode: 'anthropic',
      vaultId: 'ANTHROPIC_API_KEY',
      vaultLabel: 'Anthropic API key',
      vaultValue: TOKEN,
    })
  })

  // 7
  it('API key prompt uses the sk-ant hint and the min-length validator', async () => {
    const rec = script({ selects: ['anthropic', 'api-key'], passwords: [TOKEN] })
    await stepProviderPrompt(makeCtx())
    expect(rec.passwords[0]!.message).toBe('ANTHROPIC_API_KEY (sk-ant-...):')
    expect(rec.passwords[0]!.validate!(TOKEN)).toBe(true)
    expect(rec.passwords[0]!.validate!(SHORT)).toBe('Minimum 20 karakter hosszú legyen')
  })

  // 8: "Anthropic OAuth token: sets vault"
  it('OAuth fills CLAUDE_CODE_OAUTH_TOKEN', async () => {
    script({ selects: ['anthropic', 'oauth'], passwords: [TOKEN] })
    expect(await stepProviderPrompt(makeCtx())).toEqual({
      mode: 'anthropic',
      vaultId: 'CLAUDE_CODE_OAUTH_TOKEN',
      vaultLabel: 'Anthropic OAuth setup-token',
      vaultValue: TOKEN,
    })
  })

  // 9: "Anthropic OAuth with empty input: warn + leave buffers empty"
  it('OAuth prompt rejects an empty token through the validator', async () => {
    const rec = script({ selects: ['anthropic', 'oauth'], passwords: [TOKEN] })
    await stepProviderPrompt(makeCtx())
    expect(rec.passwords[0]!.message).toBe('OAuth setup-token (sk-ant-oat01-...):')
    expect(rec.passwords[0]!.validate!(TOKEN)).toBe(true)
    expect(rec.passwords[0]!.validate!('')).toBe('Minimum 20 karakter hosszú legyen')
  })

  // 10: "Anthropic skip branch (auth mode 3): leave buffers empty"
  it('the skip auth method returns a bare anthropic choice', async () => {
    const rec = script({ selects: ['anthropic', 'skip'] })
    expect(await stepProviderPrompt(makeCtx())).toEqual({ mode: 'anthropic' })
    expect(rec.passwords).toHaveLength(0)
  })

  // 11: "Anthropic headless default"
  it('headless mode picks the API key method without asking', async () => {
    const rec = script({ passwords: [TOKEN] })
    const choice = await stepProviderPrompt(makeCtx({ nonInteractive: true, preSelectedProvider: 'anthropic' }))
    expect(choice.vaultId).toBe('ANTHROPIC_API_KEY')
    expect(rec.selects).toHaveLength(0)
  })
})

describe('steps/provider-prompt minimax', () => {
  // 12: "MiniMax global endpoint"
  it('global region uses api.minimax.io', async () => {
    script({ selects: ['minimax', 'global'], passwords: [TOKEN] })
    expect(await stepProviderPrompt(makeCtx())).toEqual({
      mode: 'minimax',
      vaultId: 'MINIMAX_API_KEY',
      vaultLabel: 'MiniMax API key',
      vaultValue: TOKEN,
      baseUrlKey: 'MINIMAX_BASE_URL',
      baseUrlValue: 'https://api.minimax.io/anthropic',
    })
  })

  // 13: "MiniMax China endpoint is minimaxi.com"
  it('china region uses api.minimaxi.com', async () => {
    script({ selects: ['minimax', 'china'], passwords: [TOKEN] })
    const choice = await stepProviderPrompt(makeCtx())
    expect(choice.baseUrlValue).toBe('https://api.minimaxi.com/anthropic')
  })

  // 14: "MiniMax default region is global"
  it('offers global first and china second', async () => {
    const rec = script({ selects: ['minimax', 'global'], passwords: [TOKEN] })
    await stepProviderPrompt(makeCtx())
    expect(rec.selects[1]!.message).toBe('Válaszd ki a MiniMax régiót:')
    expect(rec.selects[1]!.choices.map((c) => c.value)).toEqual(['global', 'china'])
    expect(rec.selects[1]!.choices[0]!.name).toContain('api.minimax.io')
    expect(rec.selects[1]!.choices[1]!.name).toContain('api.minimaxi.com')
  })

  // 15: "MiniMax with empty API key: warn + base URL still set"
  it('rejects a short token but still returns the base URL', async () => {
    const rec = script({ selects: ['minimax', 'global'], passwords: [''] })
    const choice = await stepProviderPrompt(makeCtx())
    expect(rec.passwords[0]!.message).toBe('MiniMax API token:')
    expect(rec.passwords[0]!.validate!('')).toBe('Minimum 20 karakter hosszú legyen')
    expect(rec.passwords[0]!.validate!(TOKEN)).toBe(true)
    expect(choice.baseUrlValue).toBe('https://api.minimax.io/anthropic')
  })

  // 16
  it('headless mode defaults to the global region', async () => {
    const rec = script({ passwords: [TOKEN] })
    const choice = await stepProviderPrompt(makeCtx({ nonInteractive: true, preSelectedProvider: 'minimax' }))
    expect(choice.baseUrlValue).toBe('https://api.minimax.io/anthropic')
    expect(rec.selects).toHaveLength(0)
  })
})

describe('steps/provider-prompt deepseek + openrouter', () => {
  // 17: "DeepSeek: vault id DEEPSEEK_API_KEY"
  it('deepseek fills the key and the base URL', async () => {
    script({ selects: ['deepseek'], passwords: [TOKEN] })
    expect(await stepProviderPrompt(makeCtx())).toEqual({
      mode: 'deepseek',
      vaultId: 'DEEPSEEK_API_KEY',
      vaultLabel: 'DeepSeek API key',
      vaultValue: TOKEN,
      baseUrlKey: 'DEEPSEEK_BASE_URL',
      baseUrlValue: 'https://api.deepseek.com/anthropic',
    })
  })

  // 18: "DeepSeek with empty input: warn"
  it('deepseek rejects an empty key and keys with dots', async () => {
    const rec = script({ selects: ['deepseek'], passwords: [TOKEN] })
    await stepProviderPrompt(makeCtx())
    expect(rec.passwords[0]!.message).toBe('DeepSeek API key:')
    expect(rec.passwords[0]!.validate!('')).toBe('Minimum 20 karakter hosszú legyen')
    expect(rec.passwords[0]!.validate!('has.dots.in.it.aaaaaaaaaa')).toBe('Minimum 20 karakter hosszú legyen')
    expect(rec.passwords[0]!.validate!(TOKEN)).toBe(true)
  })

  // 19: "OpenRouter: vault id + base URL"
  it('openrouter fills the key and the base URL', async () => {
    script({ selects: ['openrouter'], passwords: [TOKEN] })
    expect(await stepProviderPrompt(makeCtx())).toEqual({
      mode: 'openrouter',
      vaultId: 'OPENROUTER_API_KEY',
      vaultLabel: 'OpenRouter API key',
      vaultValue: TOKEN,
      baseUrlKey: 'OPENROUTER_BASE_URL',
      baseUrlValue: 'https://openrouter.ai/api/v1',
    })
  })

  // 20: "OpenRouter with empty input: warn"
  it('openrouter rejects an empty key', async () => {
    const rec = script({ selects: ['openrouter'], passwords: [TOKEN] })
    await stepProviderPrompt(makeCtx())
    expect(rec.passwords[0]!.message).toBe('OpenRouter API key:')
    expect(rec.passwords[0]!.validate!('')).toBe('Minimum 20 karakter hosszú legyen')
    expect(rec.passwords[0]!.validate!(TOKEN)).toBe(true)
  })
})

describe('steps/provider-prompt ollama', () => {
  // 21: "Ollama with default URL"
  it('offers localhost:11434 as the default URL', async () => {
    const rec = script({ selects: ['ollama'] })
    expect(await stepProviderPrompt(makeCtx())).toEqual({
      mode: 'ollama',
      vaultId: 'OLLAMA_BASE_URL',
      vaultLabel: 'Ollama base URL',
      vaultValue: 'http://localhost:11434',
      baseUrlKey: 'OLLAMA_BASE_URL',
      baseUrlValue: 'http://localhost:11434',
    })
    expect(rec.inputs[0]!.message).toBe('Ollama base URL:')
    expect(rec.inputs[0]!.default).toBe('http://localhost:11434')
  })

  // 22: "Ollama with custom URL: URL is captured"
  it('captures a custom URL', async () => {
    script({ selects: ['ollama'], inputs: ['http://10.0.0.5:11434'] })
    const choice = await stepProviderPrompt(makeCtx())
    expect(choice.vaultValue).toBe('http://10.0.0.5:11434')
    expect(choice.baseUrlValue).toBe('http://10.0.0.5:11434')
  })

  // 23
  it('validates the URL scheme', async () => {
    const rec = script({ selects: ['ollama'] })
    await stepProviderPrompt(makeCtx())
    expect(rec.inputs[0]!.validate!('http://x')).toBe(true)
    expect(rec.inputs[0]!.validate!('HTTPS://x')).toBe(true)
    expect(rec.inputs[0]!.validate!('10.0.0.5:11434')).toBe('http:// vagy https:// kezdetű URL-t adj meg')
  })

  // 24: headless ollama reads OLLAMA_BASE_URL from the environment
  it('headless mode reads OLLAMA_BASE_URL from the environment', async () => {
    process.env['OLLAMA_BASE_URL'] = 'http://gpu-box:11434'
    const rec = script({})
    expect(await stepProviderPrompt(makeCtx({ nonInteractive: true, preSelectedProvider: 'ollama' }))).toEqual({
      mode: 'ollama',
      vaultId: 'OLLAMA_BASE_URL',
      vaultLabel: 'Ollama base URL',
      vaultValue: 'http://gpu-box:11434',
      baseUrlKey: 'OLLAMA_BASE_URL',
      baseUrlValue: 'http://gpu-box:11434',
    })
    expect(rec.inputs).toHaveLength(0)
  })

  // 25
  it('headless mode falls back to the default URL', async () => {
    script({})
    const choice = await stepProviderPrompt(makeCtx({ nonInteractive: true, preSelectedProvider: 'ollama' }))
    expect(choice.baseUrlValue).toBe('http://localhost:11434')
  })
})

describe('steps/provider-prompt pre-selection', () => {
  // 26: "override _installer_service_auth_present short-circuits prompt"
  it('a pre-selected provider short-circuits the menu', async () => {
    const rec = script({ passwords: [TOKEN] })
    const choice = await stepProviderPrompt(makeCtx({ preSelectedProvider: 'deepseek' }))
    expect(choice.vaultId).toBe('DEEPSEEK_API_KEY')
    expect(rec.selects).toHaveLength(0)
  })

  // 27
  it('a pre-selected interactive anthropic still asks for the auth method', async () => {
    const rec = script({ selects: ['oauth'], passwords: [TOKEN] })
    const choice = await stepProviderPrompt(makeCtx({ preSelectedProvider: 'anthropic' }))
    expect(choice.vaultId).toBe('CLAUDE_CODE_OAUTH_TOKEN')
    expect(rec.selects).toHaveLength(1)
  })

  // 28: headless skip short-circuits everything
  it('a headless pre-selected skip asks nothing at all', async () => {
    const rec = script({})
    expect(await stepProviderPrompt(makeCtx({ nonInteractive: true, preSelectedProvider: 'skip' })))
      .toEqual({ mode: 'skip' })
    expect(rec.selects).toHaveLength(0)
    expect(rec.passwords).toHaveLength(0)
    expect(rec.inputs).toHaveLength(0)
  })

  it('an interactive pre-selected skip asks nothing at all', async () => {
    const rec = script({})
    expect(await stepProviderPrompt(makeCtx({ preSelectedProvider: 'skip' }))).toEqual({ mode: 'skip' })
    expect(rec.selects).toHaveLength(0)
  })

  it('a headless pre-selected openrouter still asks for the key', async () => {
    const rec = script({ passwords: [TOKEN] })
    const choice = await stepProviderPrompt(makeCtx({ nonInteractive: true, preSelectedProvider: 'openrouter' }))
    expect(choice.vaultId).toBe('OPENROUTER_API_KEY')
    expect(rec.passwords).toHaveLength(1)
  })

  it('follows the active locale for every prompt message', async () => {
    initLocale('en')
    const rec = script({ selects: ['skip'] })
    await stepProviderPrompt(makeCtx())
    expect(rec.selects[0]!.message).toBe('Select the model provider:')
    expect(rec.selects[0]!.choices[5]!.name).toBe('Skip')
    initLocale('hu')
  })
})
