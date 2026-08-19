import { describe, it, expect, beforeEach, vi } from 'vitest'

// notify.ts reads CHANNEL_* as module-level const imports. ESM live bindings
// mean the getters below are evaluated at call time, so each test can flip the
// channel config without re-importing the module under test.
const state = vi.hoisted(() => ({
  provider: 'telegram' as string,
  token: 'tok' as string,
  chatId: 'chat' as string,
}))

vi.mock('../config.js', () => ({
  get CHANNEL_PROVIDER() { return state.provider },
  get CHANNEL_TOKEN() { return state.token },
  get CHANNEL_CHAT_ID() { return state.chatId },
}))

const providerMock = vi.hoisted(() => ({
  sendMessage: vi.fn<(token: string, chatId: string, text: string, parseMode?: string) => Promise<void>>(),
  formatMessage: vi.fn<(text: string) => string>(),
  splitMessage: vi.fn<(text: string) => string[]>(),
}))
const getProvider = vi.hoisted(() => vi.fn(() => providerMock))

vi.mock('../channel-provider.js', () => ({ getProvider }))

const markIfTestRun = vi.hoisted(() => vi.fn((text: string) => text))

vi.mock('../test-run-marker.js', () => ({ markIfTestRun }))

import { notifyChannel, notifyTelegram, notifySecurityEvent } from '../notify.js'
import { logger } from '../logger.js'

describe('notifyChannel', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    state.provider = 'telegram'
    state.token = 'tok'
    state.chatId = 'chat'
    getProvider.mockClear().mockReturnValue(providerMock)
    markIfTestRun.mockReset().mockImplementation((text: string) => text)
    providerMock.sendMessage.mockReset().mockResolvedValue(undefined)
    providerMock.formatMessage.mockReset().mockImplementation((text: string) => `fmt:${text}`)
    providerMock.splitMessage.mockReset().mockImplementation((text: string) => [text])
  })

  it('marks, formats, splits and sends every chunk with HTML parse mode on telegram', async () => {
    providerMock.splitMessage.mockReturnValue(['a', 'b'])
    markIfTestRun.mockImplementation((text: string) => `[TESZT] ${text}`)

    await notifyChannel('hello')

    expect(markIfTestRun).toHaveBeenCalledWith('hello')
    expect(getProvider).toHaveBeenCalledWith('telegram')
    expect(providerMock.formatMessage).toHaveBeenCalledWith('[TESZT] hello')
    expect(providerMock.splitMessage).toHaveBeenCalledWith('fmt:[TESZT] hello')
    expect(providerMock.sendMessage.mock.calls).toEqual([
      ['tok', 'chat', 'a', 'HTML'],
      ['tok', 'chat', 'b', 'HTML'],
    ])
  })

  it('omits the parse mode for non-telegram providers', async () => {
    state.provider = 'slack'

    await notifyChannel('hello')

    expect(getProvider).toHaveBeenCalledWith('slack')
    expect(providerMock.sendMessage).toHaveBeenCalledWith('tok', 'chat', 'fmt:hello', undefined)
  })

  it('skips sending and warns when the token is missing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    state.token = ''

    await notifyChannel('hello')

    expect(warn).toHaveBeenCalledWith('Channel ertesites kihagyva: token vagy chat ID hianyzik')
    expect(getProvider).not.toHaveBeenCalled()
    expect(providerMock.sendMessage).not.toHaveBeenCalled()
  })

  it('skips sending and warns when the chat ID is missing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    state.chatId = ''

    await notifyChannel('hello')

    expect(warn).toHaveBeenCalledWith('Channel ertesites kihagyva: token vagy chat ID hianyzik')
    expect(providerMock.sendMessage).not.toHaveBeenCalled()
  })

  it('falls back to an unformatted, truncated send when the formatted send fails', async () => {
    const long = 'x'.repeat(5000)
    markIfTestRun.mockReturnValue(long)
    providerMock.splitMessage.mockReturnValue(['chunk'])
    providerMock.sendMessage
      .mockRejectedValueOnce(new Error('parse error'))
      .mockResolvedValueOnce(undefined)

    await notifyChannel(long)

    expect(providerMock.sendMessage.mock.calls).toEqual([
      ['tok', 'chat', 'chunk', 'HTML'],
      ['tok', 'chat', 'chunk'],
    ])
  })

  it('swallows the error when the fallback send also fails', async () => {
    providerMock.sendMessage.mockRejectedValue(new Error('network down'))

    await expect(notifyChannel('hello')).resolves.toBeUndefined()
    expect(providerMock.sendMessage).toHaveBeenCalledTimes(2)
  })

  it('exposes notifyTelegram as an alias of notifyChannel', () => {
    expect(notifyTelegram).toBe(notifyChannel)
  })

  // Pinned defect -- notify-fallback-repeats-head
  it('re-sends the failing chunk (not the full outbound head) on each fallback attempt', async () => {
    const long = `${'x'.repeat(4096)}TAIL`
    markIfTestRun.mockReturnValue(long)
    // splitMessage is called twice: once for the 4100-char initial formatted
    // text (returns the 3 specific chunks), and once per small chunk inside
    // the catch fallback (chunks under 4096 chars come back as-is).
    providerMock.splitMessage.mockImplementation((text: string) =>
      text.length > 4096 ? ['chunk-1', 'chunk-2', 'chunk-3-TAIL'] : [text]
    )
    providerMock.sendMessage.mockImplementation(async (_t, _c, _text, parseMode) => {
      if (parseMode === 'HTML') throw new Error('parse error')
    })

    await notifyChannel(long)

    const fallbacks = providerMock.sendMessage.mock.calls.filter((call) => call[3] === undefined)
    expect(fallbacks).toHaveLength(3)
    // Minden fallback a SAJAT chunkjet kuldi, nem az outbound elso 4096 karakteret.
    expect(fallbacks.map((call) => call[2])).toEqual(['chunk-1', 'chunk-2', 'chunk-3-TAIL'])
    // Az outbound TAIL resze a chunk-3-ban utazik -- a bug eldobta.
    expect(fallbacks[2]?.[2]).toContain('TAIL')
    expect(fallbacks[0]?.[2]).not.toContain('TAIL')
  })

  // PINNING notify-fallback-hardcodes-telegram-limit
  it('uses provider splitMessage for the fallback chunk', async () => {
    state.provider = 'discord'
    const long = 'y'.repeat(3000)
    markIfTestRun.mockReturnValue(long)
    // Discord's splitMessage respects the 2000-char limit; encode that here
    // so the fallback truncation matches the provider's own bound.
    providerMock.splitMessage.mockImplementation((text: string) => [text.slice(0, 2000)])
    providerMock.sendMessage
      .mockRejectedValueOnce(new Error('rejected'))
      .mockResolvedValueOnce(undefined)

    await notifyChannel(long)

    // Discord rejects anything over 2000 chars; the fallback now uses the
    // provider's own splitMessage, which truncates to 2000.
    expect(providerMock.sendMessage.mock.calls[1]?.[2]).toHaveLength(2000)
  })
})

describe('notifySecurityEvent', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    state.provider = 'telegram'
    state.token = 'tok'
    state.chatId = 'chat'
    getProvider.mockClear().mockReturnValue(providerMock)
    markIfTestRun.mockReset().mockImplementation((text: string) => text)
    providerMock.sendMessage.mockReset().mockResolvedValue(undefined)
    providerMock.formatMessage.mockReset().mockImplementation((text: string) => `fmt:${text}`)
    providerMock.splitMessage.mockReset().mockImplementation((text: string) => [text])
  })

  it('delivers the event through notifyChannel when the channel is configured', async () => {
    await notifySecurityEvent('password reset')

    expect(providerMock.sendMessage).toHaveBeenCalledWith('tok', 'chat', 'fmt:password reset', 'HTML')
  })

  it('stays fully silent when the token is missing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    state.token = ''

    await notifySecurityEvent('password reset')

    expect(warn).not.toHaveBeenCalled()
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('stays fully silent when the chat ID is missing', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => {})
    state.chatId = ''

    await notifySecurityEvent('password reset')

    expect(warn).not.toHaveBeenCalled()
    expect(getProvider).not.toHaveBeenCalled()
  })

  it('swallows a synchronous failure raised before the send loop', async () => {
    providerMock.formatMessage.mockImplementation(() => { throw new Error('formatter blew up') })

    await expect(notifySecurityEvent('password reset')).resolves.toBeUndefined()
    expect(providerMock.sendMessage).not.toHaveBeenCalled()
  })
})
