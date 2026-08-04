import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  EXIT_CODES,
  confirm,
  input,
  password,
  resetPromptImpls,
  select,
  setPromptImpls,
  validateChoice123,
  validateInteger,
  validateMinLength20,
  validatePort,
  validateRequired,
  validateUrl,
  validateYesNo,
} from '../../ui/prompts.js'
import { initLocale } from '../../locale/index.js'

class ExitSentinel extends Error {}

function spyExit(): ReturnType<typeof vi.fn> {
  const spy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
    throw new ExitSentinel(String(code))
  }) as never)
  return spy as unknown as ReturnType<typeof vi.fn>
}

beforeEach(() => { initLocale('hu') })
afterEach(() => {
  resetPromptImpls()
  vi.restoreAllMocks()
})

describe('ui/prompts wrappers', () => {
  it('select forwards the message and choices and returns the value', async () => {
    const selectImpl = vi.fn(async () => 'minimax')
    setPromptImpls({ select: selectImpl as never })
    const out = await select('Valassz', [
      { name: 'Anthropic', value: 'anthropic' },
      { name: 'MiniMax', value: 'minimax' },
    ])
    expect(out).toBe('minimax')
    expect(selectImpl).toHaveBeenCalledWith({
      message: 'Valassz',
      choices: [
        { name: 'Anthropic', value: 'anthropic' },
        { name: 'MiniMax', value: 'minimax' },
      ],
    })
  })

  it('input forwards default + validate and returns the answer', async () => {
    const inputImpl = vi.fn(async () => 'Marveen')
    setPromptImpls({ input: inputImpl as never })
    const validate = (v: string): true | string => v.length > 0 ? true : 'ures'
    const out = await input('BOT_NAME', { defaultValue: 'Marveen', validate })
    expect(out).toBe('Marveen')
    expect(inputImpl).toHaveBeenCalledWith({ message: 'BOT_NAME', default: 'Marveen', validate })
  })

  it('input adds a mask when password mode is requested', async () => {
    const inputImpl = vi.fn(async () => 'secret')
    setPromptImpls({ input: inputImpl as never })
    await input('Token', { password: true })
    expect(inputImpl).toHaveBeenCalledWith({ message: 'Token', default: undefined, validate: undefined, mask: '*' })
  })

  it('input works with no options at all', async () => {
    const inputImpl = vi.fn(async () => 'x')
    setPromptImpls({ input: inputImpl as never })
    expect(await input('Kerdes')).toBe('x')
    expect(inputImpl).toHaveBeenCalledWith({ message: 'Kerdes', default: undefined, validate: undefined })
  })

  it('password always masks and forwards the validator', async () => {
    const passwordImpl = vi.fn(async () => 'sk-ant-xxx')
    setPromptImpls({ password: passwordImpl as never })
    const validate = (): true => true
    expect(await password('API key', { validate })).toBe('sk-ant-xxx')
    expect(passwordImpl).toHaveBeenCalledWith({ message: 'API key', validate, mask: '*' })
  })

  it('password works with no options', async () => {
    const passwordImpl = vi.fn(async () => 'y')
    setPromptImpls({ password: passwordImpl as never })
    expect(await password('API key')).toBe('y')
    expect(passwordImpl).toHaveBeenCalledWith({ message: 'API key', validate: undefined, mask: '*' })
  })

  it('confirm defaults to false', async () => {
    const confirmImpl = vi.fn(async () => false)
    setPromptImpls({ confirm: confirmImpl as never })
    expect(await confirm('Biztos?')).toBe(false)
    expect(confirmImpl).toHaveBeenCalledWith({ message: 'Biztos?', default: false })
  })

  it('confirm forwards an explicit default', async () => {
    const confirmImpl = vi.fn(async () => true)
    setPromptImpls({ confirm: confirmImpl as never })
    expect(await confirm('Biztos?', true)).toBe(true)
    expect(confirmImpl).toHaveBeenCalledWith({ message: 'Biztos?', default: true })
  })

  it('setPromptImpls ignores an empty override object', async () => {
    const inputImpl = vi.fn(async () => 'a')
    setPromptImpls({ input: inputImpl as never })
    setPromptImpls({})
    expect(await input('x')).toBe('a')
  })

  it('resetPromptImpls restores the inquirer implementations', async () => {
    const inputImpl = vi.fn(async () => 'a')
    setPromptImpls({ input: inputImpl as never })
    resetPromptImpls()
    const exit = spyExit()
    setPromptImpls({ input: (async () => { throw Object.assign(new Error('x'), { name: 'ExitPromptError' }) }) as never })
    await expect(input('x')).rejects.toBeInstanceOf(ExitSentinel)
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.CANCEL)
  })
})

describe('ui/prompts cancellation', () => {
  it('exits with code 130 when the ExitPromptError name is used', async () => {
    const exit = spyExit()
    const err = new Error('User force closed')
    err.name = 'ExitPromptError'
    setPromptImpls({ select: (async () => { throw err }) as never })
    await expect(select('x', [{ name: 'a', value: 'a' }])).rejects.toBeInstanceOf(ExitSentinel)
    expect(exit).toHaveBeenCalledWith(130)
  })

  it('exits when only the message mentions ExitPrompt', async () => {
    const exit = spyExit()
    setPromptImpls({ confirm: (async () => { throw new Error('ExitPrompt raised') }) as never })
    await expect(confirm('x')).rejects.toBeInstanceOf(ExitSentinel)
    expect(exit).toHaveBeenCalledWith(EXIT_CODES.CANCEL)
  })

  it('writes the cancellation message to stderr', async () => {
    spyExit()
    const errSpy = vi.spyOn(process.stderr, 'write').mockReturnValue(true)
    setPromptImpls({ password: (async () => { throw new Error('ExitPromptError happened') }) as never })
    await expect(password('x')).rejects.toBeInstanceOf(ExitSentinel)
    expect(errSpy).toHaveBeenCalledWith('Megszakítva a felhasználó által\n')
  })

  it('rethrows a regular Error', async () => {
    setPromptImpls({ input: (async () => { throw new Error('boom') }) as never })
    await expect(input('x')).rejects.toThrow('boom')
  })

  it('rethrows a non-Error rejection', async () => {
    setPromptImpls({ confirm: (async () => { throw 'nope' }) as never })
    await expect(confirm('x')).rejects.toBe('nope')
  })

  it('EXIT_CODES carries the documented values', () => {
    expect(EXIT_CODES).toEqual({ OK: 0, CANCEL: 130, ERROR: 1 })
  })
})

describe('ui/prompts validators', () => {
  it('validateRequired', () => {
    expect(validateRequired('x')).toBe(true)
    expect(validateRequired('   ')).toBe('A mező nem lehet üres')
    expect(validateRequired('')).toBe('A mező nem lehet üres')
  })

  it('validateInteger', () => {
    expect(validateInteger('42')).toBe(true)
    expect(validateInteger('-7')).toBe(true)
    expect(validateInteger('4.2')).toBe('Egész számot adj meg')
    expect(validateInteger('abc')).toBe('Egész számot adj meg')
  })

  it('validatePort', () => {
    expect(validatePort('3420')).toBe(true)
    expect(validatePort('1')).toBe(true)
    expect(validatePort('65535')).toBe(true)
    expect(validatePort('0')).toBe('1 és 65535 közötti portot adj meg')
    expect(validatePort('65536')).toBe('1 és 65535 közötti portot adj meg')
    expect(validatePort('nem-szam')).toBe('Egész számot adj meg')
  })

  it('validateMinLength20', () => {
    expect(validateMinLength20('x'.repeat(20))).toBe(true)
    expect(validateMinLength20('x'.repeat(19))).toBe('Minimum 20 karakter hosszú legyen')
  })

  it('validateUrl', () => {
    expect(validateUrl('http://localhost:11434')).toBe(true)
    expect(validateUrl('HTTPS://example.com')).toBe(true)
    expect(validateUrl('localhost:11434')).toBe('http:// vagy https:// kezdetű URL-t adj meg')
  })

  it('validateChoice123', () => {
    expect(validateChoice123('1')).toBe(true)
    expect(validateChoice123('2')).toBe(true)
    expect(validateChoice123('3')).toBe(true)
    expect(validateChoice123('4')).toBe('1, 2 vagy 3 közül válassz')
    expect(validateChoice123('')).toBe('1, 2 vagy 3 közül válassz')
  })

  it('validateYesNo accepts both languages', () => {
    for (const v of ['igen', 'nem', 'yes', 'no', 'y', 'n', ' IGEN ']) {
      expect(validateYesNo(v), v).toBe(true)
    }
    expect(validateYesNo('talan')).toBe('igen vagy nem')
  })

  it('validators follow the active locale', () => {
    initLocale('en')
    expect(validateRequired('')).toBe('This field is required')
    expect(validateUrl('x')).toBe('Enter a URL starting with http:// or https://')
    initLocale('hu')
  })
})
