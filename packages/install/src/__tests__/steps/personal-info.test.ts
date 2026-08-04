import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { homedir } from 'node:os'
import { homeOwner, stepPersonalInfo } from '../../steps/personal-info.js'
import { resetPromptImpls, setPromptImpls } from '../../ui/prompts.js'
import { makeCtx } from '../_helpers.js'

const osState = vi.hoisted(() => ({ throwOnUserInfo: false }))

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  return {
    ...actual,
    userInfo: (): { username: string } => {
      if (osState.throwOnUserInfo) throw new Error('no passwd entry')
      return { username: 'operator-x' }
    },
  }
})

interface Ask { message: string; default?: string; validate?: (v: string) => true | string }

function scriptInput(answers: string[]): Ask[] {
  const asked: Ask[] = []
  let i = 0
  setPromptImpls({
    input: (async (opts: Ask) => {
      asked.push(opts)
      const answer = answers[i] ?? opts.default ?? ''
      i += 1
      return answer
    }) as never,
  })
  return asked
}

beforeEach(() => { osState.throwOnUserInfo = false })
afterEach(() => { resetPromptImpls() })

describe('steps/personal-info non-interactive', () => {
  it('uses the derived defaults', async () => {
    const ctx = makeCtx({ nonInteractive: true })
    expect(await stepPersonalInfo(ctx)).toEqual({
      botName: 'Marveen', brandName: 'Marveen', ownerName: 'operator-x',
    })
    expect(ctx.botName).toBe('Marveen')
    expect(ctx.brandName).toBe('Marveen')
    expect(ctx.ownerName).toBe('operator-x')
  })

  it('keeps values that are already on the context', async () => {
    const ctx = makeCtx({ nonInteractive: true, botName: 'Bot', brandName: 'Brand', ownerName: 'Gazda' })
    expect(await stepPersonalInfo(ctx)).toEqual({ botName: 'Bot', brandName: 'Brand', ownerName: 'Gazda' })
  })

  it('falls back to "operator" when the system user is unreadable', async () => {
    osState.throwOnUserInfo = true
    const ctx = makeCtx({ nonInteractive: true })
    expect((await stepPersonalInfo(ctx)).ownerName).toBe('operator')
  })
})

describe('steps/personal-info interactive', () => {
  it('asks for the three names and stores the answers', async () => {
    const asked = scriptInput(['Marvin', 'MarvinCorp', 'Gazda'])
    const ctx = makeCtx()
    expect(await stepPersonalInfo(ctx)).toEqual({
      botName: 'Marvin', brandName: 'MarvinCorp', ownerName: 'Gazda',
    })
    expect(asked.map((a) => a.message)).toEqual(['BOT_NAME', 'BRAND_NAME', 'OWNER_NAME'])
    expect(asked.map((a) => a.default)).toEqual(['Marveen', 'Marveen', 'operator-x'])
    expect(ctx.botName).toBe('Marvin')
    expect(ctx.brandName).toBe('MarvinCorp')
    expect(ctx.ownerName).toBe('Gazda')
  })

  it('offers the context values as defaults', async () => {
    const asked = scriptInput([])
    const ctx = makeCtx({ botName: 'B', brandName: 'BR', ownerName: 'O' })
    expect(await stepPersonalInfo(ctx)).toEqual({ botName: 'B', brandName: 'BR', ownerName: 'O' })
    expect(asked.map((a) => a.default)).toEqual(['B', 'BR', 'O'])
  })

  it('each field rejects a blank answer with a Hungarian message', async () => {
    const asked = scriptInput(['a', 'b', 'c'])
    await stepPersonalInfo(makeCtx())
    expect(asked[0]!.validate!('   ')).toBe('A BOT_NAME megadása kötelező')
    expect(asked[0]!.validate!('x')).toBe(true)
    expect(asked[1]!.validate!('')).toBe('A BRAND_NAME megadása kötelező')
    expect(asked[1]!.validate!('x')).toBe(true)
    expect(asked[2]!.validate!('')).toBe('Az OWNER_NAME megadása kötelező')
    expect(asked[2]!.validate!('x')).toBe(true)
  })
})

describe('steps/personal-info helpers', () => {
  it('homeOwner returns the home directory', () => {
    expect(homeOwner()).toBe(homedir())
  })
})
