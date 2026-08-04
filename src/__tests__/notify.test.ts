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
      ['tok', 'chat', long.slice(0, 4096)],
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

  // Pinned defect -- docs/needs-to-be-fix/notify-fallback-repeats-head.md
  it('re-sends the same first 4096 chars for every failing chunk, dropping the tail (pinned defect)', async () => {
    const long = 'x'.repeat(4096) + 'TAIL'
    markIfTestRun.mockReturnValue(long)
    providerMock.splitMessage.mockReturnValue(['chunk-1', 'chunk-2', 'chunk-3'])
    providerMock.sendMessage.mockImplementation(async (_t, _c, _text, parseMode) => {
      if (parseMode === 'HTML') throw new Error('parse error')
    })

    await notifyChannel(long)

    const fallbacks = providerMock.sendMessage.mock.calls.filter((call) => call[3] === undefined)
    expect(fallbacks).toHaveLength(3)
    expect(new Set(fallbacks.map((call) => call[2])).size).toBe(1)
    expect(fallbacks[0]?.[2]).not.toContain('TAIL')
  })

  // Pinned defect -- docs/needs-to-be-fix/notify-fallback-hardcodes-telegram-limit.md
  it('truncates the fallback at the telegram limit even on discord (pinned defect)', async () => {
    state.provider = 'discord'
    const long = 'y'.repeat(3000)
    markIfTestRun.mockReturnValue(long)
    providerMock.splitMessage.mockReturnValue(['chunk'])
    providerMock.sendMessage
      .mockRejectedValueOnce(new Error('rejected'))
      .mockResolvedValueOnce(undefined)

    await notifyChannel(long)

    // Discord rejects anything over 2000 chars; the fallback still sends 3000.
    expect(providerMock.sendMessage.mock.calls[1]?.[2]).toHaveLength(3000)
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
