import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// logger.ts is a 3-line wrapper around pino. The contract is:
//  1. `logger` is exported.
//  2. Its level is process.env.LOG_LEVEL or 'info'.
//  3. In non-production it gets pino-pretty; in production it does not.
//
// We mock pino so the test doesn't depend on the real pino runtime.

describe('logger', () => {
  const originalLogLevel = process.env.LOG_LEVEL
  const originalNodeEnv = process.env.NODE_ENV

  beforeEach(() => {
    vi.resetModules()
    delete process.env.LOG_LEVEL
    delete process.env.NODE_ENV
  })

  afterEach(() => {
    if (originalLogLevel === undefined) delete process.env.LOG_LEVEL
    else process.env.LOG_LEVEL = originalLogLevel
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
    vi.restoreAllMocks()
  })

  it('default level is "info" when LOG_LEVEL is unset', async () => {
    vi.doMock('pino', () => ({
      default: vi.fn((opts: unknown) => ({ level: 'info', _opts: opts })),
    }))
    const { logger } = await import('../logger.js')
    expect((logger as unknown as { level: string }).level).toBe('info')
  })

  it('honors LOG_LEVEL from env', async () => {
    process.env.LOG_LEVEL = 'debug'
    vi.doMock('pino', () => ({
      default: vi.fn((opts: unknown) => ({ level: 'debug', _opts: opts })),
    }))
    const { logger } = await import('../logger.js')
    expect((logger as unknown as { level: string }).level).toBe('debug')
  })

  it('passes pino-pretty transport in non-production', async () => {
    process.env.NODE_ENV = 'development'
    const pinoMock = vi.fn((opts: unknown) => ({ _opts: opts }))
    vi.doMock('pino', () => ({ default: pinoMock }))
    await import('../logger.js')
    expect(pinoMock).toHaveBeenCalledTimes(1)
    const opts = pinoMock.mock.calls[0]?.[0] as { transport?: unknown }
    expect(opts.transport).toEqual({
      target: 'pino-pretty',
      options: { colorize: true },
    })
  })

  it('omits transport in production', async () => {
    process.env.NODE_ENV = 'production'
    const pinoMock = vi.fn((opts: unknown) => ({ _opts: opts }))
    vi.doMock('pino', () => ({ default: pinoMock }))
    await import('../logger.js')
    expect(pinoMock).toHaveBeenCalledTimes(1)
    const opts = pinoMock.mock.calls[0]?.[0] as { transport?: unknown }
    expect(opts.transport).toBeUndefined()
  })
})