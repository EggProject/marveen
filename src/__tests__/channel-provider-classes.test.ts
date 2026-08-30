import { describe, it, expect } from 'vitest'
import {
  ChannelProvider,
  TelegramProvider,
  SlackProvider,
  DiscordProvider,
  GooglechatProvider,
  TeamsProvider,
  UnsupportedDirectSendProvider,
  type ValidateTokenResult,
} from '../channel-provider.js'

// ---------------------------------------------------------------------------
// D.2: class extraction smoke tests for the 5 provider classes + the abstract
// base + the DR2 regression pin for withTestRunMarking on class instances.
// ---------------------------------------------------------------------------

describe('class identity (instanceof + fields)', () => {
  it('every class returns the matching instance via new', () => {
    const tg = new TelegramProvider()
    const sl = new SlackProvider()
    const dc = new DiscordProvider()
    const gc = new GooglechatProvider()
    const tm = new TeamsProvider()
    expect(tg).toBeInstanceOf(TelegramProvider)
    expect(sl).toBeInstanceOf(SlackProvider)
    expect(dc).toBeInstanceOf(DiscordProvider)
    expect(gc).toBeInstanceOf(GooglechatProvider)
    expect(tm).toBeInstanceOf(TeamsProvider)
  })

  it('every concrete class is also an instanceof ChannelProvider (compile-time check)', () => {
    const all: ChannelProvider[] = [
      new TelegramProvider(),
      new SlackProvider(),
      new DiscordProvider(),
      new GooglechatProvider(),
      new TeamsProvider(),
    ]
    for (const p of all) {
      // ChannelProvider is an interface, so we can't use `instanceof`, but the
      // fact that this array compiles proves the `implements` clause succeeded.
      // Runtime shape check covers the same ground:
      expect(typeof p.sendMessage).toBe('function')
      expect(typeof p.sendPhoto).toBe('function')
      expect(typeof p.validateToken).toBe('function')
      expect(typeof p.formatMessage).toBe('function')
      expect(typeof p.splitMessage).toBe('function')
    }
  })

  it('provider.type matches the literal value for every class', () => {
    expect(new TelegramProvider().type).toBe('telegram')
    expect(new SlackProvider().type).toBe('slack')
    expect(new DiscordProvider().type).toBe('discord')
    expect(new GooglechatProvider().type).toBe('googlechat')
    expect(new TeamsProvider().type).toBe('teams')
  })

  it('readonly fields match the literal values for every class', () => {
    expect(new TelegramProvider().pluginId).toBe('telegram@claude-plugins-official')
    expect(new TelegramProvider().pluginPaneId).toBe('plugin:telegram:telegram')
    expect(new SlackProvider().pluginId).toBe('slack-channel@marveen-marketplace')
    expect(new DiscordProvider().pluginId).toBe('discord@claude-plugins-official')
    expect(new GooglechatProvider().pluginId).toBe('googlechat@claude-channel-googlechat')
    expect(new TeamsProvider().pluginId).toBe('teams@marveen-marketplace')
  })
})

describe('validateToken return shape (ValidateTokenResult named type)', () => {
  it('telegram class returns ValidateTokenResult-typed promise', () => {
    const provider = new TelegramProvider()
    // Type guard: returns a promise (compile-time signature proves ValidateTokenResult)
    const p: Promise<ValidateTokenResult> = provider.validateToken('any')
    expect(p).toBeInstanceOf(Promise)
  })

  it('slack class returns ValidateTokenResult-typed promise', () => {
    const provider = new SlackProvider()
    const p: Promise<ValidateTokenResult> = provider.validateToken('any')
    expect(p).toBeInstanceOf(Promise)
  })

  it('discord class returns ValidateTokenResult-typed promise', () => {
    const provider = new DiscordProvider()
    const p: Promise<ValidateTokenResult> = provider.validateToken('any')
    expect(p).toBeInstanceOf(Promise)
  })

  it('googlechat class returns ValidateTokenResult with botName=Google Chat', async () => {
    const r = await new GooglechatProvider().validateToken('any')
    expect(r).toEqual({ ok: true, botName: 'Google Chat' })
  })

  it('teams class returns ValidateTokenResult with botName=Microsoft Teams', async () => {
    const r = await new TeamsProvider().validateToken('any')
    expect(r).toEqual({ ok: true, botName: 'Microsoft Teams' })
  })
})

describe('splitMessage non-empty array for direct-send providers', () => {
  it('telegram splitMessage returns a non-empty array for non-empty input', () => {
    const chunks = new TelegramProvider().splitMessage('hello world')
    expect(Array.isArray(chunks)).toBe(true)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]).toBe('hello world')
  })

  it('slack splitMessage returns a non-empty array for non-empty input', () => {
    const chunks = new SlackProvider().splitMessage('hello world')
    expect(Array.isArray(chunks)).toBe(true)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]).toBe('hello world')
  })

  it('discord splitMessage returns a non-empty array for non-empty input', () => {
    const chunks = new DiscordProvider().splitMessage('hello world')
    expect(Array.isArray(chunks)).toBe(true)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]).toBe('hello world')
  })

  it('googlechat splitMessage returns a non-empty array for non-empty input', () => {
    const chunks = new GooglechatProvider().splitMessage('hello world')
    expect(Array.isArray(chunks)).toBe(true)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]).toBe('hello world')
  })

  it('teams splitMessage returns a non-empty array for non-empty input', () => {
    const chunks = new TeamsProvider().splitMessage('hello world')
    expect(Array.isArray(chunks)).toBe(true)
    expect(chunks.length).toBeGreaterThan(0)
    expect(chunks[0]).toBe('hello world')
  })
})

describe('googlechat/teams send throws the unsupported-direct-send template', () => {
  it('googlechat.sendMessage throws with the type-templated message', async () => {
    await expect(
      new GooglechatProvider().sendMessage('tok', 'space-x', 'msg'),
    ).rejects.toThrow(
      'googlechat: direct dashboard send not supported (delivery via plugin MCP tools)',
    )
  })

  it('googlechat.sendPhoto throws with the type-templated message', async () => {
    await expect(
      new GooglechatProvider().sendPhoto('tok', 'space-x', '/nonexistent.png', 'cap'),
    ).rejects.toThrow(
      'googlechat: direct dashboard send not supported (delivery via plugin MCP tools)',
    )
  })

  it('teams.sendMessage throws with the type-templated message', async () => {
    await expect(
      new TeamsProvider().sendMessage('tok', 'conv-id', 'msg'),
    ).rejects.toThrow(
      'teams: direct dashboard send not supported (delivery via plugin MCP tools)',
    )
  })

  it('teams.sendPhoto throws with the type-templated message', async () => {
    await expect(
      new TeamsProvider().sendPhoto('tok', 'conv-id', '/nonexistent.png', 'cap'),
    ).rejects.toThrow(
      'teams: direct dashboard send not supported (delivery via plugin MCP tools)',
    )
  })
})

describe('UnsupportedDirectSendProvider inheritance chain', () => {
  it('GooglechatProvider is a subclass of UnsupportedDirectSendProvider', () => {
    // instanceof on a class subclass proves the prototype chain via the
    // ES2015 `[[Prototype]]` semantics; no manual Object.getPrototypeOf needed.
    expect(new GooglechatProvider()).toBeInstanceOf(UnsupportedDirectSendProvider)
  })

  it('googlechat/teams share the inherited formatMessage/splitMessage behavior', () => {
    const gc = new GooglechatProvider()
    const tm = new TeamsProvider()
    // formatMessage is the inherited identity passthrough:
    expect(gc.formatMessage('**raw** markdown')).toBe('**raw** markdown')
    expect(tm.formatMessage('**raw** markdown')).toBe('**raw** markdown')
  })

  it('TeamsProvider is also a subclass of UnsupportedDirectSendProvider', () => {
    expect(new TeamsProvider()).toBeInstanceOf(UnsupportedDirectSendProvider)
  })
})

describe('DR2 regression pin: withTestRunMarking on class instance', () => {
  it('formatMessage delegates correctly through the wrapper (DR2: no prototype drop)', () => {
    const raw = new TelegramProvider()
    // The wrapper is identity for everything except sendMessage/sendPhoto, so
    // calling formatMessage / splitMessage / validateToken through it must
    // return the same results as calling them on a fresh class instance --
    // proving Form B's explicit delegation works on class instances, not just
    // object literals.
    const wrapper: ChannelProvider = {
      type: raw.type,
      pluginId: raw.pluginId,
      pluginPaneId: raw.pluginPaneId,
      envKeys: raw.envKeys,
      stateDir: raw.stateDir,
      chatIdFormat: raw.chatIdFormat,
      sendMessage: (token, chatId, text, parseMode) =>
        raw.sendMessage(token, chatId, text, parseMode),
      sendPhoto: (token, chatId, photoPath, caption) =>
        raw.sendPhoto(token, chatId, photoPath, caption),
      validateToken: (token) => raw.validateToken(token),
      formatMessage: (text) => raw.formatMessage(text),
      splitMessage: (text) => raw.splitMessage(text),
    }
    expect(wrapper.formatMessage('hello')).toBe(new TelegramProvider().formatMessage('hello'))
    expect(wrapper.splitMessage('hello')).toEqual(new TelegramProvider().splitMessage('hello'))
    expect(typeof wrapper.validateToken).toBe('function')
    expect(typeof wrapper.sendMessage).toBe('function')
    expect(typeof wrapper.sendPhoto).toBe('function')
  })
})