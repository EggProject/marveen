import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LoggerLike } from '../logger.js'

// logger.ts is a 3-line wrapper around pino. The contract is:
//  1. `logger` is exported.
//  2. Its level is process.env.LOG_LEVEL or 'info'.
//  3. In non-production it gets pino-pretty; in production it does not.
//
// We mock pino so the test doesn't depend on the real pino runtime.

// Negative pin: a LoggerLike fixture MUST provide all four methods. A 3-method
// mock (info/warn/error only, no debug) is structurally incomplete and the
// assignment below MUST fail under strict TS. The @ts-expect-error comment
// captures the expected compile error -- if a future refactor accidentally
// drops the `debug` requirement from LoggerLike, this line will compile cleanly
// and the @ts-expect-error will itself error, surfacing the regression.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
// @ts-expect-error -- LoggerLike requires `debug`; this 3-method mock must NOT compile
// (if it compiles, the structural requirement was lost -- re-pin).
const _incompleteLogger: LoggerLike = {
  info: () => {},
  warn: () => {},
  error: () => {},
}

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

  it('logger export is structurally assignable to LoggerLike and forwards info calls', async () => {
    // Mock pino with four vi.fn methods so we can exercise the overload pair
    // of LogFn: .info('plain') AND .info({requestId:7}, 'structured'). The
    // pinoMock call count pin guards against an accidental re-import
    // (vi.resetModules in beforeEach would double-count without the mock).
    const info = vi.fn()
    const warn = vi.fn()
    const error = vi.fn()
    const debug = vi.fn()
    const pinoMock = vi.fn(() => ({ info, warn, error, debug }))
    vi.doMock('pino', () => ({ default: pinoMock }))
    const { logger } = await import('../logger.js')
    // Type-level assertion: if this compiles, the real `logger` satisfies
    // LoggerLike. Runtime: the cast only matters for TS; the assertions
    // below exercise behaviour.
    const typed: LoggerLike = logger
    typed.info('plain')
    typed.info({ requestId: 7 }, 'structured')
    expect(pinoMock).toHaveBeenCalledTimes(1)
    expect(info).toHaveBeenNthCalledWith(1, 'plain')
    expect(info).toHaveBeenNthCalledWith(2, { requestId: 7 }, 'structured')
  })
})