import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { confirmSkipAuth, stepClaudeAuth } from '../../steps/claude-auth.js'
import { resetPromptImpls, setPromptImpls } from '../../ui/prompts.js'
import { initLocale } from '../../locale/index.js'
import { makeCtx } from '../_helpers.js'

const API_KEY = `sk-ant-${'a'.repeat(24)}`
const OAUTH = `sk-ant-oat01-${'b'.repeat(24)}`

interface Ask { message: string; validate?: (v: string) => true | string; mask?: string }

function scriptPrompts(opts: { select?: string; input?: string }): { asked: Ask[]; selects: unknown[] } {
  const asked: Ask[] = []
  const selects: unknown[] = []
  setPromptImpls({
    select: (async (o: unknown) => { selects.push(o); return opts.select }) as never,
    input: (async (o: Ask) => { asked.push(o); return opts.input ?? '' }) as never,
  })
  return { asked, selects }
}

beforeEach(() => {
  initLocale('hu')
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
})
afterEach(() => {
  resetPromptImpls()
  delete process.env['ANTHROPIC_API_KEY']
  delete process.env['CLAUDE_CODE_OAUTH_TOKEN']
  vi.restoreAllMocks()
})

describe('steps/claude-auth headless', () => {
  it('uses ANTHROPIC_API_KEY when it looks like an API key', async () => {
    process.env['ANTHROPIC_API_KEY'] = API_KEY
    expect(await stepClaudeAuth(makeCtx({ nonInteractive: true }))).toEqual({ method: 'api-key', token: API_KEY })
  })

  it('falls back to CLAUDE_CODE_OAUTH_TOKEN', async () => {
    process.env['CLAUDE_CODE_OAUTH_TOKEN'] = OAUTH
    expect(await stepClaudeAuth(makeCtx({ nonInteractive: true }))).toEqual({ method: 'oauth', token: OAUTH })
  })

  it('classifies an oauth token in ANTHROPIC_API_KEY as oauth', async () => {
    process.env['ANTHROPIC_API_KEY'] = OAUTH
    expect(await stepClaudeAuth(makeCtx({ nonInteractive: true }))).toEqual({ method: 'oauth', token: OAUTH })
  })

  it('skips when the env token has the wrong shape', async () => {
    process.env['ANTHROPIC_API_KEY'] = 'nope'
    expect(await stepClaudeAuth(makeCtx({ nonInteractive: true }))).toEqual({ method: 'skip' })
  })

  it('skips when no env token is present', async () => {
    expect(await stepClaudeAuth(makeCtx({ nonInteractive: true }))).toEqual({ method: 'skip' })
  })
})

describe('steps/claude-auth interactive', () => {
  it('offers the three auth methods', async () => {
    const { selects } = scriptPrompts({ select: 'skip' })
    await stepClaudeAuth(makeCtx())
    expect(selects[0]).toEqual({
      message: 'Anthropic hitelesítés módja:',
      choices: [
        { name: 'API key (sk-ant-...)', value: 'api-key' },
        { name: 'OAuth setup-token', value: 'oauth' },
        { name: 'Kihagyás', value: 'skip' },
      ],
    })
  })

  it('returns skip without asking for a token', async () => {
    const { asked } = scriptPrompts({ select: 'skip' })
    expect(await stepClaudeAuth(makeCtx())).toEqual({ method: 'skip' })
    expect(asked).toHaveLength(0)
  })

  it('captures an API key behind a mask', async () => {
    const { asked } = scriptPrompts({ select: 'api-key', input: API_KEY })
    expect(await stepClaudeAuth(makeCtx())).toEqual({ method: 'api-key', token: API_KEY })
    expect(asked[0]!.message).toBe('ANTHROPIC_API_KEY (sk-ant-...):')
    expect(asked[0]!.mask).toBe('*')
  })

  it('validates the API key shape', async () => {
    const { asked } = scriptPrompts({ select: 'api-key', input: API_KEY })
    await stepClaudeAuth(makeCtx())
    expect(asked[0]!.validate!(API_KEY)).toBe(true)
    expect(asked[0]!.validate!('sk-ant-rovid')).toBe('Minimum 20 karakter hosszú legyen')
  })

  it('captures an OAuth setup-token', async () => {
    const { asked } = scriptPrompts({ select: 'oauth', input: OAUTH })
    expect(await stepClaudeAuth(makeCtx())).toEqual({ method: 'oauth', token: OAUTH })
    expect(asked[0]!.message).toBe('OAuth setup-token (sk-ant-oat01-...):')
  })

  it('validates the OAuth token shape', async () => {
    const { asked } = scriptPrompts({ select: 'oauth', input: OAUTH })
    await stepClaudeAuth(makeCtx())
    expect(asked[0]!.validate!(OAUTH)).toBe(true)
    expect(asked[0]!.validate!(API_KEY)).toBe('Minimum 20 karakter hosszú legyen')
  })
})

describe('steps/claude-auth confirmSkipAuth', () => {
  it('asks for confirmation with a false default', async () => {
    const confirmImpl = vi.fn(async () => true)
    setPromptImpls({ confirm: confirmImpl as never })
    expect(await confirmSkipAuth()).toBe(true)
    expect(confirmImpl).toHaveBeenCalledWith({ message: 'Anthropic hitelesítés módja:', default: false })
  })
})
